import { describe, it, expect, vi } from 'vitest'
import { MIN_SUBMISSION_INTERVAL_MS, isSubmissionIntervalSatisfied } from '@/lib/spam-signals'
import { verifyTurnstile } from '@/lib/turnstile'

/**
 * =========================================================================
 * P3-b — AC-RL-6（送信間隔下限）/ E-010-1・Tier B（Turnstile）
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 §4.11 AC-RL-6（:1525）/ AC-RL-13(d)（:1532）/
 *       Tier 表 B 行（:1499）/ §4.5 送信間隔（:1414）、
 *       `docs/ui-design/form-submission.md` §3.2 / §3.4。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/spam-signals.ts
 * export const MIN_SUBMISSION_INTERVAL_MS = 3_000
 * /** **Cookie 内の署名済み `issuedAt`** とサーバー受信時刻だけで判定する。 *\/
 * export function isSubmissionIntervalSatisfied(input: { issuedAt: number; receivedAt: number }): boolean
 *
 * // lib/turnstile.ts
 * export async function verifyTurnstile(
 *   token: unknown,
 *   options: { secret: string; remoteIp?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number },
 * ): Promise<boolean>
 * ```
 */

const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

/* ========================================================================= *
 * AC-RL-6: 送信間隔下限
 * ========================================================================= */

describe('AC-RL-6: 送信間隔下限（3秒）はサーバーが持つ値だけで判定する', () => {
  it('下限値が定数として存在する', () => {
    expect(MIN_SUBMISSION_INTERVAL_MS).toBe(3_000)
  })

  it('2,999ms は不成立 / 3,000ms ちょうどは成立（境界）', () => {
    // これが green なら排除される壊れた実装: 比較の向き違いで、
    // ちょうど3秒で送った利用者（現実に起こる）を Tier B に落とす／
    // 逆に 0ms で送る bot を通す形。
    expect(isSubmissionIntervalSatisfied({ issuedAt: NOW - 2_999, receivedAt: NOW })).toBe(false)
    expect(isSubmissionIntervalSatisfied({ issuedAt: NOW - 3_000, receivedAt: NOW })).toBe(true)
  })

  it('issuedAt が未来（時計の巻き戻し・偽装）は不成立', () => {
    // これが green なら排除される攻撃: 鍵が漏えいした場合や、サーバー間クロックスキューで
    // `issuedAt` が未来になったときに **負の経過時間が「3秒以上」と誤判定される**こと
    //（`receivedAt - issuedAt >= 3000` を絶対値で書くとこうなる）。
    expect(isSubmissionIntervalSatisfied({ issuedAt: NOW + 10_000, receivedAt: NOW })).toBe(false)
  })

  it('NaN / Infinity は不成立（fail-closed）', () => {
    for (const issuedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isSubmissionIntervalSatisfied({ issuedAt, receivedAt: NOW })).toBe(false)
    }
  })

  it('十分に経過していれば成立（上限は設けない）', () => {
    // 上限（古すぎる Cookie）は `verifyFormSessionValue` の Max-Age が見る。
    // ここに二重の期限判定を置くと、片方だけ変えたときに挙動が食い違う。
    expect(isSubmissionIntervalSatisfied({ issuedAt: NOW - 1_700_000, receivedAt: NOW })).toBe(true)
  })

  it('引数はサーバー由来の2値のみ（クライアント値を受ける口が無い）', () => {
    // **AC-RL-6 (a) の「クライアントが `formRenderedAt` 相当を偽装しても判定が変わらない」を
    // 型の形で担保する。** 関数がリクエストもボディも受け取らないため、
    // クライアント値を渡す経路が構造的に存在しない。
    // これが green なら排除される壊れた実装: `isSubmissionIntervalSatisfied(request, body)` のように
    // 攻撃者制御の値を受け取れるシグネチャ（受け取れる形にした時点で、いつか誰かが使う）。
    expect(isSubmissionIntervalSatisfied.length).toBe(1)
  })
})

/* ========================================================================= *
 * Turnstile（Tier B の材料）
 * ========================================================================= */

describe('Turnstile 検証: 失敗・障害はすべて false（fail-closed）', () => {
  const SECRET = 'turnstile-test-secret'

  function jsonFetch(body: unknown, status = 200): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  }

  it('success:true なら true', async () => {
    await expect(
      verifyTurnstile('token', { secret: SECRET, fetchImpl: jsonFetch({ success: true }) }),
    ).resolves.toBe(true)
  })

  it('success:false なら false', async () => {
    await expect(
      verifyTurnstile('token', {
        secret: SECRET,
        fetchImpl: jsonFetch({ success: false, 'error-codes': ['invalid-input-response'] }),
      }),
    ).resolves.toBe(false)
  })

  it.each([
    ['HTTP 500', jsonFetch({ success: true }, 500)],
    ['壊れた JSON', vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch],
    ['ネットワーク例外', vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch],
  ])('%s は false（例外を外へ出さない）', async (_label, fetchImpl) => {
    // これが green なら排除される攻撃/事故: Cloudflare 側の障害や細工したレスポンスで
    // **検証関数が throw して 500 になる**、あるいは **例外を握って true に倒れる**こと。
    // 前者は Tier B へ落ちるべきリクエストを失敗にし、後者は CAPTCHA を実質無効化する。
    await expect(
      verifyTurnstile('token', { secret: SECRET, fetchImpl }),
    ).resolves.toBe(false)
  })

  it('トークンが空 / 非文字列なら fetch を呼ばずに false', async () => {
    // これが green なら排除される攻撃: 空トークンを大量に送り、
    // **当校のサーバーから Cloudflare へのリクエストを増幅させる**こと（外部 API の踏み台化）。
    const fetchImpl = jsonFetch({ success: true })
    for (const token of ['', null, undefined, 123, {}, []]) {
      await expect(verifyTurnstile(token, { secret: SECRET, fetchImpl })).resolves.toBe(false)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('極端に長いトークンは fetch を呼ばずに false', async () => {
    // Turnstile のトークンは 2,048 文字程度が上限。無制限に転送すると外部 API への増幅になる。
    const fetchImpl = jsonFetch({ success: true })
    await expect(
      verifyTurnstile('a'.repeat(100_000), { secret: SECRET, fetchImpl }),
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('secret は URL クエリではなく POST ボディで送る', async () => {
    // これが green なら排除される事故: `?secret=...` にすると、
    // **秘密鍵がアクセスログ・プロキシログ・Referer に残る**。
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch

    await verifyTurnstile('token', { secret: SECRET, fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).not.toContain(SECRET)
    expect(calls[0].init?.method).toBe('POST')
  })

  it('タイムアウトすると false（公開経路を外部 API の応答時間に縛らない）', async () => {
    // これが green なら排除される攻撃: Cloudflare が応答しない状況で
    // **公開ハンドラが `maxDuration`(10秒) まで占有され、セマフォのパーミットが漏れる**こと
    //（漏れたパーミットは AC-RL-11 のリース回復に頼ることになり、その間 Tier C が増える）。
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    ) as unknown as typeof fetch

    await expect(
      verifyTurnstile('token', { secret: SECRET, fetchImpl, timeoutMs: 10 }),
    ).resolves.toBe(false)
  })
})
