import { describe, it, expect } from 'vitest'
import { createRateLimiter, rateLimitKey } from '@/lib/rate-limit'

/**
 * =========================================================================
 * P3-a — AC-RL-4 / AC-010-11（SEC-032）: レート制限キーの IPv6 `/64` 正規化
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-RL-4:1523 / AC-010-11:794。
 *
 * ## red 理由
 * `lib/rate-limit.ts` の `rateLimitKey` は「trim + 小文字化 + 長すぎる入力のハッシュ化」しか
 * 行わず、IPv6 の正規化を持たない。`2001:db8::1` と `2001:db8::2` が別キーになるため、
 * 本ファイルの assertion が**実際に失敗する**（import エラーではない）。
 *
 * ## なぜ `/64` なのか（この正規化が無いと何が起きるか）
 * IPv6 では**1契約者に `/64` 以上（アドレス 2^64 個以上）が払い出されるのが標準**である。
 * アドレス単位でキーを作ると、攻撃者は**同じ回線のまま**アドレスを変えるだけで
 * per-source 軸の上限に一度も触れずに叩き続けられる——**制御そのものが実質無効化される**。
 * これは SEC-022（`X-Forwarded-For` 偽装）と同じ「軸が軸として機能しない」型の欠陥で、
 * 未認証・大母数の P3 では致命的になる（アカウント軸に相当する第2の軸が無いため）。
 */

const PREFIX = 'applications:'

describe('AC-RL-4 / SEC-032: IPv6 は /64 に丸めてキーにする', () => {
  it('同一 /64 内の別アドレスは同一キーになる', () => {
    expect(rateLimitKey(PREFIX, '2001:db8::1')).toBe(rateLimitKey(PREFIX, '2001:db8::2'))
  })

  it('/64 が異なれば別キーになる（正規化しすぎて全 IPv6 を1バケットにしない）', () => {
    expect(rateLimitKey(PREFIX, '2001:db8:0:1::1')).not.toBe(rateLimitKey(PREFIX, '2001:db8::1'))
  })

  it('同一 /64 内で下位 64bit を総当たりしても、上限は 1 バケットぶんしか消費できない', async () => {
    // これが green なら排除される: アドレス単位でキーを作る実装。
    // 攻撃者は同一回線のまま 2^64 個のアドレスを名乗れるため、per-source 軸が無効化される。
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 })
    const now = 1_800_000_000_000

    let allowed = 0
    for (let i = 0; i < 20; i++) {
      const address = `2001:db8::${(i + 1).toString(16)}`
      const result = await limiter.consume(rateLimitKey(PREFIX, address), now)
      if (result.success) allowed += 1
    }

    expect(allowed, '20 個の異なるアドレスを名乗っても、通るのは上限の 3 回だけ').toBe(3)
  })

  it('IPv6 の表記ゆれ（省略記法 / 大文字）が同じキーに畳まれる', () => {
    // これが green なら排除される: 文字列一致だけで比較する実装
    //（`2001:0db8:0000:0000:0000:0000:0000:0001` と `2001:db8::1` を別キーにしてしまう）。
    const canonical = rateLimitKey(PREFIX, '2001:db8::1')
    expect(rateLimitKey(PREFIX, '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(canonical)
    expect(rateLimitKey(PREFIX, '2001:DB8::1')).toBe(canonical)
  })

  it('IPv4 は完全一致のまま（丸めない）', () => {
    expect(rateLimitKey(PREFIX, '198.51.100.7')).not.toBe(rateLimitKey(PREFIX, '198.51.100.8'))
    expect(rateLimitKey(PREFIX, '198.51.100.7')).toContain('198.51.100.7')
  })

  it('IPv4 射影アドレス（::ffff:a.b.c.d）は IPv4 として扱う', () => {
    // これが green なら排除される: 射影表記を IPv6 として `/64` に丸める実装。
    // `::ffff:0:0/96` は全 IPv4 を含むため、**全 IPv4 利用者が1バケットに落ちる**
    //（攻撃者1人で世界中の IPv4 利用者を締め出せる）。逆に射影と素の IPv4 を別キーにすると、
    // 攻撃者は表記を切り替えるだけで上限を2倍使える。
    expect(rateLimitKey(PREFIX, '::ffff:198.51.100.7')).toBe(rateLimitKey(PREFIX, '198.51.100.7'))
    expect(rateLimitKey(PREFIX, '::ffff:198.51.100.7')).not.toBe(
      rateLimitKey(PREFIX, '::ffff:198.51.100.8'),
    )
  })

  it('IP でない値（メールアドレス等）の挙動は変えない（P2 の 2 軸運用を退行させない）', () => {
    expect(rateLimitKey('credentials:', ' Admin@Example.com ')).toBe(
      'credentials:admin@example.com',
    )
  })

  it('正規化後もキー長は有界（SEC-023 の増幅を断つ）', () => {
    for (const raw of ['2001:db8::1', '::ffff:198.51.100.7', 'x'.repeat(500)]) {
      expect(rateLimitKey(PREFIX, raw).length).toBeLessThanOrEqual(PREFIX.length + 64)
    }
  })
})
