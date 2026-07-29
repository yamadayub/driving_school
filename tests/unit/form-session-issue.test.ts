import { describe, it, expect, vi } from 'vitest'
import {
  FORM_SESSION_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_WINDOW_MS,
  issueFormSession,
} from '@/lib/form-session-issue'
import { FORM_SESSION_COOKIE_NAME, verifyFormSessionValue } from '@/lib/form-session'
import { createRateLimiter } from '@/lib/rate-limit'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-b — AC-RL-13(a)(c) / AC-RL-3 (3): フォームセッション Cookie の**発行**
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 §4.11 AC-RL-13(a)(c)（:1532）/ AC-RL-3 (3)（:1522）/
 *       F-010 境界値表「フォームセッション Cookie の**発行**（`GET /apply`）: 発信元あたり 30回/10分」（:713）、
 *       `docs/phase-status.md` (2)「AC-RL-13 の (c) は P3-b で再検証」（:353）。
 *
 * > **(c) 発行の流量制限**: 発行経路そのものを**発信元軸で 30回/10分**に制限する（超過は Tier D）。
 * > 目的は Cookie 軸を「**タダで無限に増やせない**」状態にすることであり、上限は緩くてよい。
 *
 * ## なぜこの単位で必要か
 * AC-RL-3 は「同一 Cookie の4回目が拒否される」**だけ**をテストにしてはならないと明記している
 * ——**攻撃者は同一 Cookie を送らない**。Cookie を取り直せば Tier D 軸は毎回リセットされるため、
 * **発行側に上限が無ければ Cookie 軸は防御として成立しない**（`public-guard-p3b-wiring.test.ts` の
 * 「Cookie 10枚 → handler 30回」が示すとおり）。AC-RL-3 の3本目はここで閉じる。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/form-session-issue.ts
 * export const FORM_SESSION_ISSUE_LIMIT = 30
 * export const FORM_SESSION_ISSUE_WINDOW_MS = 600_000   // 10分
 *
 * export type FormSessionIssueResult =
 *   | { issued: true; cookieName: string; cookieValue: string; attributes: FormSessionCookieAttributes }
 *   | { issued: false; retryAfterMs: number }
 *
 * export async function issueFormSession(options: {
 *   clientIp: ClientIpResolution          // ← **分解せずに渡す**（SEC-043 の型の継ぎ目と同じ）
 *   limiter: RateLimiter
 *   secret: string
 *   now?: () => number
 *   randomBytes?: (size: number) => Uint8Array
 * }): Promise<FormSessionIssueResult>
 * ```
 *
 * `GET /apply` はこれを呼び、`issued: true` なら `Set-Cookie`、`false` なら **Tier D**
 *（`429` + `Retry-After`）を返す。**ページ側に判定ロジックを書かない**（AC-RL-8: 判定の複製禁止）。
 */

const SECRET = 'issue-test-form-session-secret-32chars'
const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

const TRUSTED: ClientIpResolution = { key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' }
const OTHER: ClientIpResolution = { key: '203.0.113.42', trusted: true, source: 'x-forwarded-for' }
const DEGRADED: ClientIpResolution = { key: 'unknown', trusted: false, source: 'unknown' }

function deps(overrides: Partial<Parameters<typeof issueFormSession>[0]> = {}) {
  return {
    clientIp: TRUSTED,
    limiter: createRateLimiter({
      limit: FORM_SESSION_ISSUE_LIMIT,
      windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
    }),
    secret: SECRET,
    now: () => NOW,
    ...overrides,
  }
}

describe('AC-RL-13(a): 発行される Cookie の形と属性', () => {
  it('上限値が仕様どおり（30回 / 10分）', () => {
    expect(FORM_SESSION_ISSUE_LIMIT).toBe(30)
    expect(FORM_SESSION_ISSUE_WINDOW_MS).toBe(600_000)
  })

  it('署名済みの値と正しい属性を返す', async () => {
    // これが green なら排除される事故: 属性を1つ落とすこと。
    //  - `HttpOnly` 無し → XSS で `sid` を読まれ、Cookie 軸そのものが攻撃者の手に渡る
    //  - `SameSite=None` → クロスサイトから被害者の Cookie を使って送信できる（軸が機能しない）
    //  - `__Host-` 接頭辞なし → サブドメインからの上書き（Cookie tossing）で軸を無効化できる
    const result = await issueFormSession(deps())
    expect(result.issued).toBe(true)
    if (!result.issued) return
    expect(result.cookieName).toBe(FORM_SESSION_COOKIE_NAME)
    expect(result.cookieName.startsWith('__Host-')).toBe(true)
    expect(result.attributes).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 1_800,
    })
  })

  it('発行された値は verifyFormSessionValue を通り、issuedAt がサーバー時刻である', async () => {
    // **発行と検証の整合。** これが green なら排除される事故: 発行フォーマットを変えた瞬間に
    // **正規利用者の Cookie が全て検証に落ち、全員が Tier B になる**こと。
    const result = await issueFormSession(deps())
    expect(result.issued).toBe(true)
    if (!result.issued) return
    const payload = verifyFormSessionValue(result.cookieValue, SECRET, NOW)
    expect(payload, '発行した値が自分の検証を通らない').not.toBeNull()
    expect(payload!.issuedAt, 'issuedAt はサーバー時刻（AC-RL-6 の基準を兼ねる）').toBe(NOW)
    expect(payload!.sid).toMatch(/^[0-9a-f]{32}$/)
  })

  it('発行のたびに sid が変わる（軸が要求元ごとに分かれる前提）', async () => {
    const d = deps()
    const sids = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const result = await issueFormSession(d)
      if (result.issued) sids.add(verifyFormSessionValue(result.cookieValue, SECRET, NOW)!.sid)
    }
    expect(sids.size).toBe(10)
  })
})

describe('AC-RL-13(c) / AC-RL-3 (3): 発行そのものを発信元軸で 30回/10分に制限する', () => {
  it('31回目の発行が Tier D（issued:false + retryAfterMs）になる', async () => {
    // **AC-RL-3 の3本目「毎回 Cookie を取り直す発信元が、Cookie 発行の流量制限に到達する」。**
    // これが green なら排除される攻撃: **Cookie を取り直しながら送信を繰り返す**こと。
    // Tier D 軸（Cookie 軸 3回/10分）は Cookie を新しくすれば毎回リセットされるため、
    // 発行側に上限が無ければ**単一の発信元が窓あたり無制限に送信できる**
    //（`public-guard-p3b-wiring.test.ts` の「Cookie 10枚 → handler 30回」がその実測）。
    // AC-RL-14（宛先別メールスロットル）が塞ごうとしている経路の**前段**でもある。
    const d = deps()
    const results = []
    for (let i = 0; i < 31; i++) results.push(await issueFormSession(d))

    expect(results.slice(0, 30).every((r) => r.issued)).toBe(true)
    const last = results[30]
    expect(last.issued).toBe(false)
    if (last.issued) return
    // P3-c1 / SEC-067: `FormSessionIssueResult` が判別可能 union になり、
    // `retryAfterMs` を持つのは `rate-limited` だけになった（`already-verified` は待つ必要が無い）。
    // **型の絞り込みであって assertion の変更ではない**——下の期待値は元のまま。
    expect(last.reason).toBe('rate-limited')
    if (last.reason !== 'rate-limited') return
    expect(last.retryAfterMs).toBeGreaterThan(0)
  })

  it('別の発信元は独立して発行できる（巻き添えにしない）', async () => {
    // これが green なら排除される壊れた実装: 発行制限を**共有軸**（全体カウンタ）で行うこと。
    // 共有軸を硬いゲートにすると、1人が 30回取るだけで**全利用者がフォームを開けなくなる**
    //（条件1'-1 が禁じている形を、発行経路に持ち込むこと）。
    const d = deps()
    for (let i = 0; i < 31; i++) await issueFormSession(d)
    const other = await issueFormSession({ ...d, clientIp: OTHER })
    expect(other.issued).toBe(true)
  })

  it('窓が明ければ再び発行できる（恒久停止にしない）', async () => {
    let now = NOW
    const d = deps({ now: () => now })
    for (let i = 0; i < 31; i++) await issueFormSession(d)
    now = NOW + FORM_SESSION_ISSUE_WINDOW_MS + 1
    expect((await issueFormSession(d)).issued).toBe(true)
  })

  it('縮退（trusted=false）では発行を止めない（共有 unknown バケットを硬いゲートにしない）', async () => {
    // **SEC-043 / SEC-021 と同型の欠陥を発行経路に持ち込まないための条件。**
    // これが green なら排除される攻撃: 縮退構成で、第三者が 30回フォームを開くだけで
    // **全利用者が `/apply` を開けなくなる**こと（共有 `unknown` バケットの枯渇が拒否になる）。
    // 縮退時の防御は Cookie 軸そのもの（送信側 3回/10分）と Turnstile が担い、
    // 発行側は**計数のみ**にする——`sourceAxisFor` の `enforce` と同じ意味論である。
    const d = deps({ clientIp: DEGRADED })
    const results = []
    for (let i = 0; i < 40; i++) results.push(await issueFormSession(d))
    expect(results.every((r) => r.issued), '縮退時の共有バケットが硬いゲートになっている').toBe(true)
  })

  it('縮退時も計数は続ける（観測手段を失わない）', async () => {
    // `lib/public-guard.ts:254-261` と同じ方針。ゲートに使わないことと、数えないことは別である。
    const consumed: string[] = []
    const inner = createRateLimiter({ limit: FORM_SESSION_ISSUE_LIMIT, windowMs: FORM_SESSION_ISSUE_WINDOW_MS })
    const limiter = {
      consume: vi.fn((key: string, now?: number) => {
        consumed.push(key)
        return inner.consume(key, now)
      }),
      peek: inner.peek,
      reset: inner.reset,
    }
    await issueFormSession(deps({ clientIp: DEGRADED, limiter }))
    expect(consumed.length).toBe(1)
  })

  it('レート制限キーは resolveClientIp → rateLimitKey を通す（生ヘッダを直接キーにしない）', async () => {
    // AC-RL-4 / SEC-032。IPv6 の `/64` 正規化を発行経路でも効かせる。
    // これが green なら排除される攻撃: IPv6 のアドレスを1つずつ変えて（同一 `/64` 内で 2^64 通り）
    // 発行制限を無限に回避すること。
    const consumed: string[] = []
    const inner = createRateLimiter({ limit: FORM_SESSION_ISSUE_LIMIT, windowMs: FORM_SESSION_ISSUE_WINDOW_MS })
    const limiter = {
      consume: (key: string, now?: number) => {
        consumed.push(key)
        return inner.consume(key, now)
      },
      peek: inner.peek,
      reset: inner.reset,
    }
    await issueFormSession(
      deps({ clientIp: { key: '2001:db8::1', trusted: true, source: 'x-forwarded-for' }, limiter }),
    )
    await issueFormSession(
      deps({ clientIp: { key: '2001:db8::2', trusted: true, source: 'x-forwarded-for' }, limiter }),
    )
    expect(new Set(consumed).size, '同一 /64 が別キーになっている（SEC-032）').toBe(1)
  })
})
