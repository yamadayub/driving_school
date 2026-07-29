import { describe, it, expect } from 'vitest'
import { createRateLimiter } from '@/lib/rate-limit'
import { resolveClientIp } from '@/lib/http-guard'

/**
 * SEC-022 / RV-P2R-003 — レート制限キーの元になる発信元 IP の解決（P2.5）。
 *
 * 現状の欠陥（`auth.ts:59-63`）:
 *   ```ts
 *   function clientIp(request) {
 *     const forwarded = request?.headers.get('x-forwarded-for')
 *     if (forwarded) return forwarded.split(',')[0].trim()   // ← 左端＝クライアント申告値
 *     return request?.headers.get('x-real-ip')?.trim() || 'unknown'
 *   }
 *   ```
 *   `X-Forwarded-For` は各プロキシが**右に追記**するヘッダで、左端はクライアントが自由に名乗れる。
 *   攻撃者は毎リクエストで `X-Forwarded-For: <ランダム>` を送るだけで IP 軸の上限に一度も触れずに
 *   叩き続けられる（＝制御そのものが偽装で無効化される）。P3 の未認証エンドポイントでは
 *   アカウント軸に相当する第2の軸が無いため、これは濫用対策の全面失効を意味する。
 *
 * ---------------------------------------------------------------------------
 * Vercel 環境で信頼できる IP の出所（調査結果・2026-07-28）
 * ---------------------------------------------------------------------------
 * 本プロジェクトのホスティングは **Vercel 集約で確定**している（`docs/tech-stack.md` §2.1,
 * 2026-07-26 ユーザー承認）。Vercel 公式の Request headers リファレンス
 * （https://vercel.com/docs/headers/request-headers, last_updated 2025-12-13）の記述:
 *
 *   - `x-forwarded-for`: "The public IP address of the client that made the request.
 *     **If you are trying to use Vercel behind a proxy, we currently overwrite the
 *     X-Forwarded-For header and do not forward external IPs. This restriction is in place
 *     to prevent IP spoofing.**"
 *     → Vercel を経由する限り、この値は**プラットフォームが上書き**する（クライアント申告値は残らない）。
 *     クライアント指定の XFF を通せるのは Enterprise の "Trusted Proxy" 権限を購入した場合のみ。
 *   - `x-vercel-forwarded-for`: "identical to the `x-forwarded-for` header. **However,
 *     `x-forwarded-for` could be overwritten if you're using a proxy on top of Vercel.**"
 *     → Vercel の**手前に**自前プロキシを置いた構成では XFF が汚染されうるが、こちらは汚染されない。
 *   - `x-real-ip`: "identical to the `x-forwarded-for` header."
 *
 * 導かれる契約:
 *   1. **信頼できる出所の優先順は `x-vercel-forwarded-for` → `x-forwarded-for` → `x-real-ip`。**
 *      いずれも Vercel が単一のクライアント IP を入れるため、複数値なら先頭を採ってよい。
 *   2. **これらを信頼してよいのは「信頼できるプロキシ配下で動いている」と分かっているときだけ。**
 *      判定は環境変数 `VERCEL`（Vercel がシステム環境変数として `"1"` を注入する）を既定の根拠にする。
 *   3. **信頼境界の外（`next start` 直公開・ローカル・オンプレ）では、クライアント申告値を IP として
 *      扱わない。** ただし「IP 不明なので無制限」にはせず、単一の `unknown` バケットへ寄せて
 *      **制限を緩めない**（SEC-022 修正方針2 / SEC-021 付随の縮退を、SEC-021 の是正と併せて許容する）。
 *   4. 解決結果は**必ず有界**にする。IP リテラルとして妥当でない文字列は採用しない
 *      （攻撃者が任意長・任意内容の文字列をレート制限キーにするのを防ぐ＝ SEC-023 の増幅を断つ）。
 *   5. `docs/tech-stack.md` に「どのヘッダを信頼するか」を明記する（SEC-022 修正方針4）。
 *
 * red 理由: `lib/http-guard.ts` に `resolveClientIp` が存在しない（named export の解決に失敗）。
 */

/** テスト用の Request（URL は resolveClientIp の判定に影響しない）。 */
function req(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/auth/callback/credentials', { headers })
}

describe('SEC-022: resolveClientIp — 信頼境界の外ではクライアント申告値を採用しない', () => {
  it('trustProxy=false のとき x-forwarded-for の値を IP として使わない', () => {
    const resolved = resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false })

    expect(resolved.trusted).toBe(false)
    expect(resolved.source).toBe('unknown')
    expect(resolved.key).not.toContain('1.2.3.4')
  })

  it('trustProxy=false のとき、値を変えても同じキーに寄る（制限を緩めない）', () => {
    const a = resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false })
    const b = resolveClientIp(req({ 'x-forwarded-for': '5.6.7.8' }), { trustProxy: false })
    const c = resolveClientIp(req({ 'x-real-ip': '9.9.9.9' }), { trustProxy: false })

    expect(a.key).toBe(b.key)
    expect(b.key).toBe(c.key)
  })

  it('ヘッダが一切無い場合も空文字を返さない（キーが空になるとバケットが壊れる）', () => {
    const resolved = resolveClientIp(req({}), { trustProxy: false })
    expect(resolved.key.length).toBeGreaterThan(0)
    expect(resolved.trusted).toBe(false)
  })
})

describe('SEC-022: resolveClientIp — Vercel 配下（trustProxy=true）の優先順位', () => {
  it('x-vercel-forwarded-for が最優先（Vercel 手前のプロキシによる XFF 汚染に勝つ）', () => {
    const resolved = resolveClientIp(
      req({
        // Vercel の手前に置かれた自前プロキシ（または攻撃者）が入れた値。
        'x-forwarded-for': '203.0.113.66',
        // Vercel が入れる、上書きされない値。
        'x-vercel-forwarded-for': '198.51.100.20',
      }),
      { trustProxy: true },
    )

    expect(resolved.key).toContain('198.51.100.20')
    expect(resolved.key).not.toContain('203.0.113.66')
    expect(resolved.source).toBe('x-vercel-forwarded-for')
    expect(resolved.trusted).toBe(true)
  })

  it('x-vercel-forwarded-for が無ければ x-forwarded-for（Vercel が上書きする値）を使う', () => {
    const resolved = resolveClientIp(req({ 'x-forwarded-for': '198.51.100.20' }), {
      trustProxy: true,
    })
    expect(resolved.key).toContain('198.51.100.20')
    expect(resolved.source).toBe('x-forwarded-for')
    expect(resolved.trusted).toBe(true)
  })

  it('x-real-ip は最後の手段として使う', () => {
    const resolved = resolveClientIp(req({ 'x-real-ip': '198.51.100.20' }), { trustProxy: true })
    expect(resolved.key).toContain('198.51.100.20')
    expect(resolved.source).toBe('x-real-ip')
  })

  it('複数値が入っていても先頭の1件だけを採る（Vercel は単一 IP を入れる）', () => {
    const resolved = resolveClientIp(req({ 'x-forwarded-for': '198.51.100.20, 10.0.0.1' }), {
      trustProxy: true,
    })
    expect(resolved.key).toContain('198.51.100.20')
    expect(resolved.key).not.toContain('10.0.0.1')
  })

  it('IPv6 も採用できる', () => {
    const resolved = resolveClientIp(req({ 'x-vercel-forwarded-for': '2001:db8::1' }), {
      trustProxy: true,
    })
    expect(resolved.key).toContain('2001:db8::1')
    expect(resolved.trusted).toBe(true)
  })
})

describe('SEC-022: resolveClientIp — 出力は必ず有界（SEC-023 の増幅を断つ）', () => {
  it('IP リテラルとして妥当でない値は採用しない', () => {
    const resolved = resolveClientIp(
      req({ 'x-vercel-forwarded-for': 'not-an-ip; DROP TABLE news' }),
      { trustProxy: true },
    )
    expect(resolved.trusted).toBe(false)
    expect(resolved.source).toBe('unknown')
    expect(resolved.key).not.toContain('DROP TABLE')
  })

  it('超長文字列をキーにできない（IPv6 の最大長 45 文字を超えない）', () => {
    const huge = 'a'.repeat(10_000)
    const resolved = resolveClientIp(req({ 'x-forwarded-for': huge }), { trustProxy: true })
    expect(resolved.key.length).toBeLessThanOrEqual(45)
  })

  it('どの入力でもキー長が有界であること（ランダムな長い値でも）', () => {
    for (const raw of ['', '   ', ',,,', '1.2.3.4'.repeat(500), '::'.repeat(500)]) {
      const resolved = resolveClientIp(req({ 'x-forwarded-for': raw }), { trustProxy: true })
      expect(resolved.key.length).toBeGreaterThan(0)
      expect(resolved.key.length).toBeLessThanOrEqual(45)
    }
  })
})

describe('SEC-022: resolveClientIp — 既定の trustProxy は環境から決める', () => {
  it('VERCEL 環境変数が無ければ既定で信頼しない（fail-closed）', () => {
    const previous = process.env.VERCEL
    delete process.env.VERCEL
    try {
      const resolved = resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }))
      expect(resolved.trusted, 'ローカル/直公開ではクライアント申告値を信頼しない').toBe(false)
    } finally {
      if (previous === undefined) delete process.env.VERCEL
      else process.env.VERCEL = previous
    }
  })

  it('VERCEL=1 なら既定で信頼する（Vercel がヘッダを上書きするため）', () => {
    const previous = process.env.VERCEL
    process.env.VERCEL = '1'
    try {
      const resolved = resolveClientIp(req({ 'x-forwarded-for': '198.51.100.20' }))
      expect(resolved.trusted).toBe(true)
      expect(resolved.key).toContain('198.51.100.20')
    } finally {
      if (previous === undefined) delete process.env.VERCEL
      else process.env.VERCEL = previous
    }
  })
})

describe('SEC-022: キー偽装でレート制限が緩まない（結合的な不変条件）', () => {
  it('x-forwarded-for を毎回変えても、信頼境界の外では IP 軸の上限に到達する', async () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 })
    const now = 1_800_000_000_000

    let denied = 0
    for (let i = 0; i < 50; i++) {
      // 攻撃者はリクエストごとに別の IP を名乗る。
      const resolved = resolveClientIp(req({ 'x-forwarded-for': `203.0.113.${i % 256}` }), {
        trustProxy: false,
      })
      const result = await limiter.consume(`credentials:ip:${resolved.key}`, now + i)
      if (!result.success) denied++
    }

    expect(denied, '偽装で上限を回避できてはならない（50回中40回は拒否）').toBe(40)
  })

  it('Vercel 配下でも、手前のプロキシを騙る XFF の書き換えで上限を回避できない', async () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 })
    const now = 1_800_000_000_000

    let denied = 0
    for (let i = 0; i < 50; i++) {
      const resolved = resolveClientIp(
        req({
          'x-forwarded-for': `203.0.113.${i % 256}`, // 攻撃者/中間プロキシ由来
          'x-vercel-forwarded-for': '198.51.100.77', // Vercel が入れる真の発信元
        }),
        { trustProxy: true },
      )
      const result = await limiter.consume(`credentials:ip:${resolved.key}`, now + i)
      if (!result.success) denied++
    }

    expect(denied, 'x-vercel-forwarded-for を真実源にすれば同一バケットに落ちる').toBe(40)
  })
})
