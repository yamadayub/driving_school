import { describe, it, expect, vi } from 'vitest'
import { withCronAuth } from '@/lib/cron-auth'
import { createRateLimiter, type RateLimiter } from '@/lib/rate-limit'

/**
 * =========================================================================
 * P3-c1 — **SEC-046 / P3c-7**: `withCronAuth` に粗い試行回数制限（**本単位が期限**）
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-7（:3267）
 *       「`withCronAuth` に粗い試行回数制限（**本単位が期限**）」— SEC-046 / P3b-10 からの繰越。
 *
 * ## 何を守るのか
 * `/api/cron/**` は **個人情報の削除バッチ**（P3-d `retention` / P3-c `orphan-uploads`）の起動口である。
 * 認可はスタティックな共有シークレット 1 本（`CRON_SECRET`）で、
 * **アカウントロックも試行制限も無い**。`lib/cron-auth.ts:39-43` の定数時間比較は
 * 「応答時間から 1 文字ずつ復元される」ことは防ぐが、**総当たりそのものは防がない**。
 *
 * P3-a の時点では対象バッチが存在しなかったため繰越されたが、
 * **P3-c は `orphan-uploads` を作る**（免許証写真を削除するバッチ）。期限が到来している。
 *
 * ## 設計上の制約（**ここを間違えると APPI 違反になる**）
 * `lib/cron-auth.ts:14-17` が自ら書いているとおり:
 *
 * > 保持期間削除と orphan 回収が止まり、**APPI 違反の温床**になる（可用性が機密性に直結する例）。
 *
 * したがって**試行制限で正規の cron を締め出してはならない**。
 * Vercel Cron は安定した発信元 IP を持たないため、per-IP 軸は作れず、
 * 軸は**単一のグローバルカウンタ**にならざるを得ない。
 * 共有バケットを硬いゲートにする形は **SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度再発した欠陥**
 * であり、ここで 5 度目を作ってはならない。
 *
 * ## 採る形（`lib/login-guard.ts:129-142` と同じ意味論）
 *
 * > **失敗だけを数える。成功は常に通す。**
 *
 * - 認可**失敗**はカウンタを消費する。
 * - 認可**成功**はカウンタを消費しない（正規バッチの毎時実行が枠を食わない）。
 * - 上限到達後も**正しいトークンは通る**（＝ 第三者が枠を叩くだけでバッチを止められない）。
 * - 上限到達後の失敗は**同じ 404**（`Retry-After` も付けない）。
 *   上限に達したことを応答で判別できると、攻撃者に「鍵の総当たりが観測されている」ことを教える。
 * - 上限到達は**ログに出す**（運用が総当たりに気付ける。出さないと制限を入れた意味が半減する）。
 *
 * ## ⚠️ これは「抑制」ではなく「**検知**」である（REV-P3C1-006 / 記述の訂正）
 *
 * 上の 3 つ（成功は常に通す / 上限後も正しいトークンは 200 / 応答は常に同じ 404）を
 * **同時に満たす実装では、上限に達しても攻撃者の体験は 1 ミリも変わらない。**
 * 正しいトークンを常に通す以上、毎回トークン比較を実行しなければならず、
 * **推測の試行回数も速度も一切制限されない。上限到達時に起きるのはログ 1 行だけ**である。
 *
 * 当初この項目を「総当たりを**絞る**」と記述したが、**それは誤りだった。**
 * 監査 ID をそのまま「試行回数制限を入れた」として閉じると、次の監査が
 * 「`/api/cron/**` は総当たりに対して上限がある」と読む——**そこには上限が無い。**
 * P3-c は `orphan-uploads`（写真の削除バッチ）を足すので、この誤読は高くつく。
 *
 * > **本ラッパは総当たりの速度を落とさない。** 抑制は `CRON_SECRET` の長さ
 * > （`lib/env.ts:21` の 32 文字下限）とプラットフォーム側の流量制御に依存する。
 * > 本ラッパが足すのは**観測**（いつ・どれだけ叩かれたかが分かること）である。
 *
 * それでも入れる価値がある理由: 総当たりは**気付けなければ止められない**。
 * 現状は `CRON_SECRET` に対する試行が**どこにも記録されない**ので、
 * 攻撃が成功するまで（＝ 個人情報が削除されるまで）誰も知り得ない。
 *
 * ## red 理由
 * `CronAuthOptions`（`lib/cron-auth.ts:24-27`）は `secret` しか持たず、
 * カウンタもロガーも存在しない。渡しても黙って無視される。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/cron-auth.ts
 * export const CRON_AUTH_ATTEMPT_LIMIT: number   // 粗くてよい（10 程度）
 * export const CRON_AUTH_WINDOW_MS: number       // 10 分程度
 *
 * export interface CronAuthOptions {
 *   secret?: string
 *   // **省略時は内蔵の既定 limiter を使う**（渡し忘れで制限が消える形を作らない / SEC-053 の教訓）。
 *   // 引数は差し替え（テスト・将来の KV 化）のためにある。
 *   limiter?: RateLimiter
 *   now?: () => number
 *   logger?: { warn(event: string, fields: Record<string, unknown>): void }
 * }
 *
 * // REV-P3C1-013: 内蔵の既定 limiter は**モジュール大域の状態**になる。
 * //   テストが増えると実行順序に依存するので、**窓を跨がせる手段**を必ず用意すること。
 * //   `now` の注入で足りる（`CRON_AUTH_WINDOW_MS` を跨げば固定ウィンドウは自然にリセットされる）。
 * //   `reset` 用の export を足すより副作用が小さい。
 * ```
 *
 * **カウンタのキーは要求内容から作らないこと。** ヘッダやトークンを材料にすると、
 * 攻撃者は値を変えるだけで新しいバケットを作り、上限を無限に回避できる
 *（`lib/form-session.ts:280-297` / SEC-055 と同型の失敗）。
 */

const SECRET = 'c'.repeat(44)

/** テスト内で使う上限（**実装の既定値に依存しない**）。 */
const TEST_LIMIT = 5
const WINDOW_MS = 600_000

function cronRequest(authorization?: string, extraHeaders: Record<string, string> = {}): Request {
  const headers = new Headers(extraHeaders)
  if (authorization !== undefined) headers.set('authorization', authorization)
  return new Request('https://example.test/api/cron/retention', { method: 'GET', headers })
}

function okHandler() {
  return vi.fn(async () => Response.json({ processed: 0 }))
}

/** `consume` されたキーを記録する limiter（軸が本当に評価されたか / キーが増えていないかを観測する）。 */
function recordingLimiter(limit = TEST_LIMIT): RateLimiter & { keys: string[] } {
  const inner = createRateLimiter({ limit, windowMs: WINDOW_MS })
  const keys: string[] = []
  return {
    keys,
    consume: (key, now) => {
      keys.push(key)
      return inner.consume(key, now)
    },
    peek: (key, now) => inner.peek(key, now),
    reset: (key) => inner.reset(key),
  }
}

function recordingLogger() {
  return { warn: vi.fn<(event: string, fields: Record<string, unknown>) => void>() }
}

/* ========================================================================= *
 * SEC-046 (1): 失敗だけを数える
 * ========================================================================= */

describe('SEC-046 / P3c-7: 認可失敗は試行回数として数えられる', () => {
  it('誤ったトークンはカウンタを消費する', async () => {
    // これが green なら排除される状態: `CRON_SECRET` への総当たりが
    // **どこにも記録されない**こと（＝ 攻撃が成功するまで誰も知り得ない）。
    // 対象は**個人情報の削除バッチ**であり、到達されると
    // 保持期間前のレコードと免許証写真を任意に削除できる（AC-PII-10）。
    // ⚠️ 本ラッパは総当たりの**速度を落とさない**（REV-P3C1-006 / ヘッダ参照）。足すのは観測である。
    const limiter = recordingLimiter()
    const handler = okHandler()
    const guarded = withCronAuth(handler, { secret: SECRET, limiter })

    await guarded(cronRequest(`Bearer ${'d'.repeat(44)}`), undefined)

    expect(limiter.keys.length, '失敗が 1 度も計数されていない').toBe(1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('正しいトークン（成功）はカウンタを消費しない', async () => {
    // **「成功は常に通す」の前提。**
    // 成功でカウンタを消費すると、毎時走る正規バッチ自身が枠を食い潰し、
    // **正規の cron が自分で自分を締め出す**（保持期間削除が止まる = APPI 違反の温床）。
    const limiter = recordingLimiter()
    const guarded = withCronAuth(okHandler(), { secret: SECRET, limiter })

    for (let n = 0; n < TEST_LIMIT + 3; n++) {
      const response = await guarded(cronRequest(`Bearer ${SECRET}`), undefined)
      expect(response.status, `${n + 1} 回目の正規実行が拒否された`).toBe(200)
    }

    expect(limiter.keys.length, '成功がカウンタを消費している').toBe(0)
  })

  it('Authorization 欠落・スキーマ違いも計数する（安い失敗を数え漏らさない）', async () => {
    const limiter = recordingLimiter()
    const guarded = withCronAuth(okHandler(), { secret: SECRET, limiter })

    await guarded(cronRequest(), undefined)
    await guarded(cronRequest(`Basic ${SECRET}`), undefined)

    expect(limiter.keys.length).toBe(2)
  })
})

/* ========================================================================= *
 * SEC-046 (2): **正規バッチを締め出さない**（5 度目の SEC-043 を作らない）
 * ========================================================================= */

describe('SEC-046 / P3c-7: 上限到達後も正しいトークンは通る', () => {
  it('第三者が上限まで失敗させた後でも、正規の cron は 200 で本体に到達する', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される「行き過ぎた修正」: 共有カウンタの枯渇を硬いゲートにして
    // **第三者が数回失敗させるだけで保持期間削除バッチを止められる**状態
    //（`lib/cron-auth.ts:14-17`「可用性が機密性に直結する例」/ APPI 違反の温床）。
    // SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度再発した欠陥の 5 度目を作らないこと。
    const limiter = recordingLimiter()
    const handler = okHandler()
    const guarded = withCronAuth(handler, { secret: SECRET, limiter })

    for (let n = 0; n < TEST_LIMIT + 20; n++) {
      await guarded(cronRequest(`Bearer ${'d'.repeat(44)}`), undefined)
    }

    const response = await guarded(cronRequest(`Bearer ${SECRET}`), undefined)
    expect(response.status, '正規の cron が締め出されている（バッチが止まる）').toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

/* ========================================================================= *
 * SEC-046 (3): 上限到達を応答から判別できない
 * ========================================================================= */

describe('SEC-046 / P3c-7: 上限到達後の失敗も、応答は 404 のまま', () => {
  it('ステータスも本文も変わらない', async () => {
    // `lib/cron-auth.ts:29` の設計判断（「経路の存在を教えない応答」）を、
    // 試行制限を足したあとも維持する。
    // これが green なら排除される情報露出: 上限到達だけ 429 を返す実装
    //  → 攻撃者は 429 を見て「鍵は総当たりで到達しうる」「制限窓は N 分」を学習でき、
    //    さらに **404 と 429 の境目から `CRON_SECRET` の存在自体**が判る。
    const limiter = recordingLimiter()
    const guarded = withCronAuth(okHandler(), { secret: SECRET, limiter })

    const statuses: number[] = []
    const bodies: string[] = []
    for (let n = 0; n < TEST_LIMIT + 5; n++) {
      const response = await guarded(cronRequest(`Bearer ${'d'.repeat(44)}`), undefined)
      statuses.push(response.status)
      bodies.push(await response.text())
    }

    expect(new Set(statuses), `応答が途中で変わった: ${JSON.stringify(statuses)}`).toEqual(
      new Set([404]),
    )
    expect(new Set(bodies).size, '本文が途中で変わった（上限到達が判別できる）').toBe(1)
  })

  it('Retry-After を付けない（Tier D との契約混同・窓長の露出を作らない）', async () => {
    const limiter = recordingLimiter()
    const guarded = withCronAuth(okHandler(), { secret: SECRET, limiter })

    let last: Response | null = null
    for (let n = 0; n < TEST_LIMIT + 5; n++) {
      last = await guarded(cronRequest(`Bearer ${'d'.repeat(44)}`), undefined)
    }
    expect(last?.headers.get('retry-after')).toBeNull()
  })
})

/* ========================================================================= *
 * SEC-046 (4): 攻撃者がキーを増やして上限を回避できない
 * ========================================================================= */

describe('SEC-046 / P3c-7: カウンタのキーを要求内容から作らない', () => {
  it('トークンやヘッダを変えても、消費されるキーは常に同一', async () => {
    // これが green なら排除される壊れた実装: `authorization` ヘッダや任意ヘッダを
    // キーの材料にすること。**値を変えるだけで新しいバケットが作れる**ため、
    // 上限は無限に回避でき、同時に store のメモリ増幅（SEC-023）の経路にもなる。
    // `lib/form-session.ts:280-297`（SEC-055）が同型の失敗を既に記録している。
    const limiter = recordingLimiter(1_000)
    const guarded = withCronAuth(okHandler(), { secret: SECRET, limiter })

    for (let n = 0; n < 50; n++) {
      await guarded(
        cronRequest(`Bearer ${String(n).padStart(44, '0')}`, { 'x-probe': `probe-${n}` }),
        undefined,
      )
    }

    expect(limiter.keys.length).toBe(50)
    expect(
      new Set(limiter.keys).size,
      `攻撃者が ${new Set(limiter.keys).size} 個のバケットを作れた（上限を回避できる）`,
    ).toBe(1)
  })
})

/* ========================================================================= *
 * SEC-046 (5): 観測できること / 既定で有効であること
 * ========================================================================= */

describe('SEC-046 / P3c-7: 上限到達は観測できる', () => {
  it('上限に達したらログに出る（総当たりに運用が気付ける）', async () => {
    // 制限を入れても**誰も気付かない**なら、総当たりは静かに続く。
    // ログの中身に `CRON_SECRET` や試行値を含めないこと（AC-PII-1 / `lib/pii-log.ts`）。
    const limiter = recordingLimiter()
    const logger = recordingLogger()
    const guarded = withCronAuth(okHandler(), { secret: SECRET, limiter, logger })

    for (let n = 0; n < TEST_LIMIT + 3; n++) {
      await guarded(cronRequest(`Bearer ${'d'.repeat(44)}`), undefined)
    }

    expect(logger.warn, '上限到達が 1 度もログに出ていない').toHaveBeenCalled()
    const logged = JSON.stringify(logger.warn.mock.calls)
    expect(logged, 'シークレットがログに出ている').not.toContain(SECRET)
    expect(logged, '試行値がログに出ている').not.toContain('d'.repeat(44))
  })

  it('limiter を渡さなくても制限が効く（既定で有効 / 渡し忘れで消えない）', async () => {
    // **SEC-053 の教訓**: 「渡し忘れ」は最も安い事故である。
    // `limiter` を必須にせず、**省略時は内蔵の既定カウンタ**を使うこと
    //（引数は差し替えのためにある）。
    // これが green なら排除される事故: P3-c / P3-d の cron ルートが `limiter` を渡し忘れ、
    // **試行制限が存在しないまま削除バッチが公開される**こと。
    //
    // ⚠️ REV-P3C1-013: 内蔵の既定 limiter は**モジュール大域の状態**なので、
    // 他のテストの消費が残っていると結果が実行順序に依存する。
    // **専用の窓へ退避してから測る**（`now` を注入して固定ウィンドウを跨がせる）。
    // これが「既定 limiter を差し替えずに、状態だけを分離する」最も副作用の小さい手段である。
    const isolatedWindowStart = Date.UTC(2030, 0, 1)
    const logger = recordingLogger()
    const guarded = withCronAuth(okHandler(), {
      secret: SECRET,
      logger,
      now: () => isolatedWindowStart,
    })

    for (let n = 0; n < 60; n++) {
      const response = await guarded(cronRequest(`Bearer ${'e'.repeat(44)}`), undefined)
      expect(response.status).toBe(404)
    }

    expect(logger.warn, '既定の試行回数制限が存在しない').toHaveBeenCalled()
  })
})

/* ========================================================================= *
 * SEC-046 (6): 既存の挙動を壊さない（`tests/unit/cron-auth.test.ts` 10 件）
 * ========================================================================= */

describe('SEC-046 / P3c-7: 既存の AC-PII-10 の契約は不変（退行防止）', () => {
  it('CRON_SECRET 未設定は、試行制限とは無関係に常に 404（fail-closed）', async () => {
    const handler = okHandler()
    const response = await withCronAuth(handler, { secret: undefined, limiter: recordingLimiter() })(
      cronRequest('Bearer anything'),
      undefined,
    )
    expect(response.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it('Origin を持たない要求でも正しい Bearer なら通る（Vercel Cron は Origin を送らない）', async () => {
    const request = cronRequest(`Bearer ${SECRET}`)
    expect(request.headers.get('origin')).toBeNull()
    const response = await withCronAuth(okHandler(), {
      secret: SECRET,
      limiter: recordingLimiter(),
    })(request, undefined)
    expect(response.status).toBe(200)
  })
})
