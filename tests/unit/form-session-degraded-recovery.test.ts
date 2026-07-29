import { describe, it, expect, vi } from 'vitest'
import {
  CHALLENGE_TOKEN_MAX_ENTRIES,
  CHALLENGE_TOKEN_TTL_MS,
  FORM_SESSION_FREE_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_WINDOW_MS,
  issueFormSession,
} from '@/lib/form-session-issue'
import {
  FORM_SESSION_COOKIE_NAME,
  FORM_SESSION_MAX_AGE_SEC,
  FORM_SESSION_RENEW_BEFORE_MS,
  createFormSessionValue,
  formSessionAxisKey,
  isFormSessionRenewable,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { withPublicMutation, type PublicGuardOptions } from '@/lib/public-guard'
import { createRateLimiter, type RateLimiter } from '@/lib/rate-limit'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-c1 — **SEC-067**（縮退構成の回復不能な Tier B）+ **SEC-068**（印の可読性）
 * =========================================================================
 *
 * 出典: `docs/security-p3b-reaudit-2026-07-29.md` §3 SEC-067（:104-133）/ SEC-068（:135-146）。
 *
 * ## SEC-067 が何なのか（SEC-057 の是正が生んだ「脅威の移動」）
 * 縮退構成（`trusted=false`）の発行カウンタのキーは `rateLimitKey('apply:fs-issue:', 'unknown')`
 * であり、**全利用者で 1 個の共有カウンタ**である（`lib/http-guard.ts:109-114`）。
 * 窓内 11 枚目以降の Cookie には一律に `unverified` が焼かれ、
 * `verifyFormSessionValue`（`lib/form-session.ts:216`）が `null` を返し、
 * `lib/public-guard.ts:374-385` が**ハンドラより前**に Tier B を確定させる。
 *
 * > **CAPTCHA では抜けられない。** Turnstile 検証は `app/api/applications/route.ts:283` の
 * > **ハンドラ内**にあり、ラッパの step 6 で落ちる以上**一度も評価されない**。
 *
 * すなわち `lib/public-guard.ts:160-165` が 413 について自ら書いている
 * 「CAPTCHA を解いて再送しても同じ応答が返る**抜けられないループ**」と**同型の欠陥**が
 * Tier B 側に持ち込まれている。攻撃コストは **10 リクエスト / 10 分**（SEC-057 の 20 より安い）。
 *
 * ### 増幅要因（監査が自分で追跡したもの）
 * 印の付いた利用者は `app/(public)/apply/page.tsx:55-71` で `hasSession=false` と判定され、
 * **ページを開くたびに `/api/form-session` へリダイレクトして発行枠をもう 1 つ消費する**。
 * **被害者の再試行そのものが無コスト枠を食い潰し、ロックアウトが自己維持する。**
 * 実測の傍証: `docs/impl-p3b-fix2-notes-2026-07-29.md` §4 が、E2E の通常操作だけで
 * `/apply` への遷移が窓内 23 回に達したことを報告している（無コスト枠 10 は**通常利用で日常的に超える**）。
 *
 * ## この設計が採る修正（監査の修正方針 2 と 3 を、SEC-057 を開かない形で組む）
 *
 * | 監査の方針 | 本テストが契約にした形 |
 * |---|---|
 * | 1. SEC-069 を解消して縮退の適用範囲を限定する | `tests/unit/trust-proxy-env.test.ts`（別ファイル） |
 * | 2. 印を「Tier B 確定」ではなく「**チャレンジ必須**」の意味に降格する | **検証済みチャレンジトークンを伴う発行要求には印を付けない**（`challengeToken`）。**同一トークンの 2 回目以降は未通過扱い**（増幅率 1）。ラッパの評価順序は変えない |
 * | 3. 既に有効な Cookie を持つ再訪者の再発行を無コスト枠から除外する | **`hasVerifiedSession` なら発行そのものを行わない**（`issued: false, reason: 'already-verified'`）。自己維持を切る |
 *
 * ## ⚠️ REV-P3C1-001 による作り直し（**Senior レビューの最重要指摘**）
 *
 * 当初の契約は「`hasVerifiedSession` なら**無コスト枠を消費しない**」だった。
 * これは **SEC-057 を再び開く**とレビューで指摘され、**その指摘は正しい**。
 * 最も安い実装（`if (!hasVerifiedSession) { await limiter.consume(...) }`）で次が起きる:
 *
 *  1. `trusted`（Vercel 本番）でも硬い上限 30 が消える——`lib/form-session-issue.ts:110` の
 *     ゲートは `consume` の結果に依存するので、飛ばした要求は上限を評価されない。
 *  2. 縮退でも無コスト枠が消える——`consumedInWindow = result.limit - result.remaining`（同 :128）が
 *     進まないので、何枚出しても印が付かない。
 *  3. Cookie に「消費」の概念が無く（`lib/form-session.ts:167-222`）、再発行時に旧 `sid` を
 *     無効化する経路も無いので、攻撃者は **1 枚の有効な Cookie を提示し続けるだけ**で
 *     印の無い Cookie を好きなだけ積み上げられる。
 *
 * > **「無コスト枠を消費しない」は枠の免除であり、免除に上界が無ければ枠は存在しないのと同じ。**
 *
 * したがって契約を**「消費しない」から「発行しない」へ**作り直した（レビューの改善案 (A)）。
 * SEC-067 の増幅要因は「`/apply` を開くたびに再発行して枠を消費する」ことなので、
 * **発行しなければ増幅も蓄積も同時に消える**。印の無い Cookie の**総数が増えない**ので
 * SEC-057 に触れない。
 *
 * ## ⚠️ REV-P3C1-002 による作り直し（増幅率を契約に入れる）
 *
 * 当初は `challengePassed?: boolean` だった。これでは
 * **1 回のチャレンジ通過で何枚の印なし Cookie を得られるか**が決まらず、
 * 「1 回の検証結果を N 回の発行に流用する」実装が契約に違反しない。
 * そうなると縮退での到達数は「30（無コスト）+ 3 × 流用枚数」になり、
 * **SEC-070 で締めたばかりの上界が、測っていない経路で破られる。**
 *
 * > **回復経路の価値はコスト比で決まる。増幅率が 1 でなければコストは割り算で消える。**
 *
 * そこで boolean をやめ、**検証済みトークンの識別子**（`challengeToken`）を要求する形にした。
 * 同一トークンの 2 回目以降は「未通過」として扱う——これで増幅率が構造的に 1 に固定される。
 * boolean を残すと「渡すだけ」で通せるため、**boolean フラグは契約に含めない。**
 *
 * ### なぜ「ラッパを通してハンドラの Turnstile で判定させる」形にしないのか
 * それは **SEC-057 を再び開く**。`tests/unit/form-session-issue-cost.test.ts` と
 * `tests/integration/form-session-cost.int.ts` はどちらも Turnstile を「常に通過」として測るため、
 * 印の判定をハンドラ内へ移すと**到達数が Cookie 枚数に比例して戻り**、両ファイルが red になる。
 * したがって**コストは「発行の時点で」払わせる**——チャレンジを通した要求にだけ印の無い Cookie を出す。
 * これなら SEC-057 の測定（チャレンジを通さない攻撃者）は 30 回のまま変わらず、
 * 被害者には**回復経路が存在する**。
 *
 * ## red 理由
 * `IssueFormSessionOptions`（`lib/form-session-issue.ts:85-95`）に
 * `challengePassed` も `hasVerifiedSession` も存在せず、渡しても黙って無視される。
 * SEC-068 側は `lib/form-session.ts:155-156` が `unverified` を **payload の平文キー**として書く。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/form-session-issue.ts
 * export type FormSessionIssueResult =
 *   | { issued: true; cookieName: string; cookieValue: string; attributes: FormSessionCookieAttributes }
 *   | { issued: false; reason: 'rate-limited'; retryAfterMs: number }
 *   | { issued: false; reason: 'already-verified' }      // ← 新設（REV-P3C1-001）
 *
 * export interface IssueFormSessionOptions {
 *   clientIp: ClientIpResolution
 *   limiter: RateLimiter
 *   secret: string
 *   // SEC-067 修正方針3 / REV-P3C1-001:
 *   //   有効（印の無い）Cookie を提示している再訪。**発行そのものを行わない**
 *   //   （`issued: false, reason: 'already-verified'`）。既存 Cookie をそのまま使わせる。
 *   //   ⚠️ 「消費しないが発行はする」にしてはならない（枠の免除に上界が無くなる）。
 *   hasVerifiedSession?: boolean
 *   // SEC-067 修正方針2 / REV-P3C1-002:
 *   //   このリクエストで **サーバー側が検証した** チャレンジトークン（値またはそのハッシュ）。
 *   //   渡された場合、無コスト枠を超えていても印を付けない。
 *   //   **同一トークンの 2 回目以降は「未通過」として扱う**（増幅率を 1 に固定する）。
 *   //   ⚠️ **クライアントの自己申告を渡してはならない。** 必ず `verifyTurnstile` の結果として得ること。
 *   challengeToken?: string
 *   // 使用済みチャレンジトークンの記録。省略時は内蔵（メモリ）。KV 化の差し替え口。
 *   //   `consume` は初回 true / 2 回目以降 false を返す。
 *   usedChallengeTokens?: { consume(token: string, at: number): Promise<boolean> }
 *   now?: () => number
 *   randomBytes?: (size: number) => Uint8Array
 * }
 *
 * // lib/form-session.ts（SEC-068）
 * //   印は Cookie の payload に**平文で書かない**。
 * //   印あり / 印なしの値は、クライアントから見て payload もバイト長も同一であること。
 * //   （安い実装例: 印の有無で HMAC の HKDF ラベルを変え、検証側が両方を試す。
 * //     payload の形は変わらず、後方互換も保たれる。実装方法は指定しない。）
 * ```
 *
 * ## `hasVerifiedSession` を「発行しない」にしても失われないもの
 * `app/api/form-session/route.ts` は上限到達時も `/apply` へ 303 する（同 :124-134）。
 * `reason: 'already-verified'` でも**同じく 303 で `/apply` へ戻す**（Cookie を再発行しないだけ）。
 * 利用者から見た導線は一切変わらない。**`Retry-After` は付けない**
 * ——待つ必要が無い（既に有効な Cookie を持っている）ので、付けると意味が反転する。
 */

const ENDPOINT = 'applications' as const
const ORIGIN = 'https://example.test'
const SECRET = 'sec067-form-session-secret-32-characters'

const ISSUED_AT = Date.UTC(2026, 6, 29, 6, 0, 0)
const NOW = ISSUED_AT + 10_000

/** 送信側の Cookie 軸上限（`app/api/applications/route.ts:91`）。 */
const FORM_SESSION_LIMIT = 3
/** 送信側の発信元軸上限（同 :89）。縮退では計数のみ。 */
const SOURCE_LIMIT = 5

const DEGRADED: ClientIpResolution = { key: 'unknown', trusted: false, source: 'unknown' }
const TRUSTED: ClientIpResolution = { key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' }

function request(cookieValue: string | null): Request {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
  if (cookieValue !== null) headers.set('cookie', `${FORM_SESSION_COOKIE_NAME}=${cookieValue}`)
  return new Request(`${ORIGIN}/api/applications`, { method: 'POST', headers, body: '{}' })
}

/**
 * **本番と同じ結線**（`app/api/applications/route.ts:337-353` の写し）。
 * テスト専用の簡略配線を作らない（P2 の「テスト対象の取り違え」）。
 */
function productionWiring(overrides: Partial<PublicGuardOptions> = {}): PublicGuardOptions {
  return {
    endpoint: ENDPOINT,
    requireContentType: 'json',
    limiters: {
      source: createRateLimiter({ limit: SOURCE_LIMIT, windowMs: 600_000 }),
      formSession: createRateLimiter({ limit: FORM_SESSION_LIMIT, windowMs: 600_000 }),
    },
    formSessionKey: formSessionAxisKey,
    verifyFormSession: (req, at) =>
      verifyFormSessionValue(readFormSessionCookie(req), SECRET, at) !== null,
    clientIp: () => DEGRADED,
    now: () => NOW,
    ...overrides,
  }
}

function issueLimiter(): RateLimiter {
  return createRateLimiter({
    limit: FORM_SESSION_ISSUE_LIMIT,
    windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
  })
}

type IssueExtras = { challengeToken?: string; hasVerifiedSession?: boolean }

/** 1 枚発行して Cookie 値を返す（発行されなかったら null）。 */
async function issue(
  limiter: RateLimiter,
  clientIp: ClientIpResolution = DEGRADED,
  extras: IssueExtras = {},
): Promise<string | null> {
  const result = await issueFormSession({
    clientIp,
    limiter,
    secret: SECRET,
    now: () => ISSUED_AT,
    ...extras,
  })
  return result.issued ? result.cookieValue : null
}

/** 発行結果そのもの（`reason` の判別が要るテスト用）。 */
async function issueResult(
  limiter: RateLimiter,
  clientIp: ClientIpResolution = DEGRADED,
  extras: IssueExtras = {},
) {
  return issueFormSession({
    clientIp,
    limiter,
    secret: SECRET,
    now: () => ISSUED_AT,
    ...extras,
  })
}

/** 値が「印なし（＝検証を通る）」か。 */
function isUnmarked(value: string | null): boolean {
  return value !== null && verifyFormSessionValue(value, SECRET, NOW) !== null
}

/** 毎回異なるチャレンジトークン（＝ 毎回コストを払っている攻撃者/利用者）。 */
function freshToken(n: number): string {
  return `ts-token-${n}-${'0'.repeat(20)}`
}

/** 第三者が無コスト枠を使い切る（10 リクエスト / 10 分 = SEC-067 の攻撃コスト）。 */
async function exhaustFreeQuota(limiter: RateLimiter): Promise<void> {
  for (let n = 0; n < FORM_SESSION_FREE_ISSUE_LIMIT; n++) await issue(limiter)
}

/* ========================================================================= *
 * SEC-067 (1): 欠陥そのものの再現（現状の記録 / 修正後も真であり続ける残余）
 * ========================================================================= */

describe('SEC-067: 縮退構成では、第三者が無コスト枠を使い切ると新規来訪者に印が付く', () => {
  it(`第三者が ${FORM_SESSION_FREE_ISSUE_LIMIT} 回発行した直後の新規来訪者は Tier B に落ちる（残余の記録）`, async () => {
    // **これは red ではない。** 攻撃コストの安さ（10 リクエスト / 10 分）を数値として固定し、
    // 「印が付くこと」自体は残余として受容する記録である。
    // 本 describe が固定するのは**入口**であり、次の describe が固定するのは**出口（回復経路）**。
    // 出口が無い限り、この入口は `lib/public-guard.ts:160-165` が禁じた
    // 「**抜けられないループ**」そのものである。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    const victim = await issue(limiter)
    expect(victim, '発行そのものが止まっている（第三者に /apply を封鎖させない原則の違反）').not.toBeNull()

    const guarded = withPublicMutation(
      vi.fn(async () => Response.json({ ok: true }, { status: 201 })),
      productionWiring(),
    )
    const response = await guarded(request(victim), undefined)
    expect(response.status, '新規来訪者が Tier B に落ちていない（前提が変わった）').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
  })

  it('攻撃コストは SEC-057（20 リクエスト）より安い — 上界を定数から固定する', () => {
    // 監査の「SEC-057 の攻撃コストより安い」を数値の二重管理なしに固定する。
    // これが green なら排除される退行: 閾値を動かして「直った」ことにする対症療法
    //（監査は明示的に**推奨しない**と書いている。20 未満という上界があり逃げ場が無い）。
    expect(FORM_SESSION_FREE_ISSUE_LIMIT).toBeLessThan(20)
  })
})

/* ========================================================================= *
 * SEC-067 (2): **回復経路**（本ファイルの中心）
 * ========================================================================= */

describe('SEC-067: 印は終端ではない — チャレンジを通せば回復できる', () => {
  it('検証済みトークンを伴う発行要求は、無コスト枠を超えていても印の付かない Cookie を返す', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される事故: 未認証の第三者が 10 リクエスト / 10 分を送り続けるだけで、
    // 縮退構成のサイトの申込フォームを**恒久的に使用不能**にできること（CWE-645 /
    // Overly Restrictive Account Lockout）。**CAPTCHA を解いても抜けられない**現状は、
    // `lib/public-guard.ts:160-165` が 413 について自ら禁じた「抜けられないループ」と同型である。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    const recovered = await issue(limiter, DEGRADED, { challengeToken: freshToken(1) })
    expect(recovered, '発行そのものが止まっている').not.toBeNull()
    expect(isUnmarked(recovered), 'チャレンジを通したのに印が付いたまま（回復できない）').toBe(true)
  })

  it('回復した Cookie は本番配線の送信で本体へ到達する（403 の閉ループから抜けられる）', async () => {
    // 「印が付かない」だけでは足りない。**本番のラッパを通って 201 に到達する**ことまで測る
    //（P2 の教訓: テスト対象は本番経路であること）。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
    const guarded = withPublicMutation(handler, productionWiring())

    const recovered = await issue(limiter, DEGRADED, { challengeToken: freshToken(2) })
    const response = await guarded(request(recovered), undefined)

    expect(response.status, '回復経路を通っても Tier B のまま').toBe(201)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('チャレンジを通さない攻撃者には従来どおり印が付く（コストは残る / SEC-057 維持）', async () => {
    // 回復経路が**無条件の抜け道**になっていないこと。
    // これが green なら排除される壊れた修正: 印そのものを止めて SEC-057 を開き直すこと。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    expect(isUnmarked(await issue(limiter))).toBe(false)
  })

  it('回復経路の発行も計数される（観測手段を失わない）', async () => {
    // 「ゲートに使わない」ことと「数えない」ことは別である
    //（`lib/form-session-issue.ts:16-18` / `lib/public-guard.ts:66-67` と同じ意味論）。
    // これが green なら排除される実装: チャレンジ通過を理由に `consume` を丸ごと飛ばし、
    // **チャレンジ通過後の発行がメトリクスからも監査ログからも消える**こと。
    const calls: string[] = []
    const inner = issueLimiter()
    const recording: RateLimiter = {
      consume: (key, at) => {
        calls.push(key)
        return inner.consume(key, at)
      },
      peek: (key, at) => inner.peek(key, at),
      reset: (key) => inner.reset(key),
    }

    await issue(recording, DEGRADED, { challengeToken: freshToken(3) })
    expect(calls.length, 'チャレンジ通過の発行が 1 度も計数されていない').toBeGreaterThan(0)
  })
})

/* ========================================================================= *
 * SEC-067 (2'): **増幅率は 1**（REV-P3C1-002 / Must Fix）
 * ========================================================================= */

describe('REV-P3C1-002: 1 回のチャレンジ通過で得られる印なし Cookie は 1 枚だけ', () => {
  it('同じトークンを 200 回渡しても、印の付かない Cookie は 1 枚しか出ない', async () => {
    // **回復経路の価値はコスト比で決まる。増幅率が 1 でなければコストは割り算で消える。**
    //
    // これが green なら排除される実装:
    //  (a) Turnstile の siteverify が重複トークンを弾かない / キャッシュを挟む構成で、
    //      **同一トークンを N 回検証してもらう**
    //  (b) 1 回の検証結果をセッションに保持し、**以後の全発行に流用する**
    // どちらも「ルート側で verifyTurnstile を実行しその結果を渡す」という指示に**違反しない**ため、
    // 増幅率そのものを契約に書かなければ守れない。
    //
    // 増幅を許すと縮退での到達数は「30（無コスト）+ 3 × 流用枚数」になり、
    // **SEC-070 で締めたばかりの上界が、測っていない経路で破られる。**
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    const sameToken = freshToken(42)
    let unmarked = 0
    for (let n = 0; n < 200; n++) {
      if (isUnmarked(await issue(limiter, DEGRADED, { challengeToken: sameToken }))) unmarked++
    }

    expect(unmarked, `同一トークンで印なし Cookie を ${unmarked} 枚得られた（増幅率 ${unmarked}）`).toBe(1)
  })

  it('異なるトークンなら枚数ぶんのコストが払われている（1 チャレンジ = 1 枚）', async () => {
    // 増幅率 1 の逆向きの確認。**「同一トークンを弾く」を「2 枚目以降を一律に弾く」で
    // 実装してはならない**——それでは正規利用者が 2 回目の来訪で回復できなくなる
    //（SEC-067 を直すために別の締め出しを作ることになる）。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    let unmarked = 0
    for (let n = 0; n < 5; n++) {
      if (isUnmarked(await issue(limiter, DEGRADED, { challengeToken: freshToken(100 + n) }))) unmarked++
    }
    expect(unmarked, '毎回コストを払っている利用者が回復できない').toBe(5)
  })

  it('使用済みトークンの記録は有効期間で失効する（NEW-004 / メモリ増幅を作らない）', async () => {
    // **NEW-004**: 「省略時は内蔵（メモリ）」だけでは、エントリの寿命も上界も規定が無い。
    // トークンは Turnstile を通過するたびに 1 件挿入されるので、
    // 攻撃者は **CAPTCHA を解いた分だけサーバーのメモリにエントリを積める**。
    //
    // このプロジェクトは同型の欠陥を既に 3 度扱っている
    //（SEC-023 のメモリ増幅 / SEC-031 の退避 / SEC-041 の saturated マーク）。
    // `lib/rate-limit.ts` が件数上限と退避を持つのに、**新設のキー空間だけ持たない**のは一貫しない。
    // 「差し替え口を用意した」ことは既定実装の品質を保証しない——
    // **既定で使われるのは内蔵実装のほう**である（SEC-053 の教訓と同じ構図）。
    //
    // 失効の基準は**チャレンジトークンの有効期間**（Turnstile の siteverify は 300 秒）。
    // それを過ぎたトークンは siteverify 自体が拒否するので、記録し続ける意味が無い。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    const token = freshToken(9)
    const first = await issueResult(limiter, DEGRADED, { challengeToken: token })
    expect(isUnmarked(first.issued ? first.cookieValue : null)).toBe(true)

    // 有効期間を跨いだ後は、記録が残っていない（＝ 同じトークンでも「初回」として扱われる）。
    // **ここで green になるのは「記録が失効した」場合だけ**であり、
    // 失効を実装しなければ印が付いたままになる。
    const afterExpiry = await issueFormSession({
      clientIp: DEGRADED,
      limiter,
      secret: SECRET,
      now: () => ISSUED_AT + CHALLENGE_TOKEN_TTL_MS + 1_000,
      challengeToken: token,
    })
    // **`isUnmarked` を使わない。** あれは固定の `NOW` で検証するため、
    // 発行時刻が `NOW` より未来になる本ケースでは `lib/form-session.ts:284`
    // （`issuedAt > now` は時計偽装として `null`）に必ず捕まり、
    // **印の有無に関わらず false になる**——記録の失効が完璧に実装されていても red のままだった。
    // 測りたいのは「TTL を跨いだら同じトークンでも初回として扱われる（＝印が付かない）」ことなので、
    // **発行時刻と同じ時刻で検証する**。Cookie 寿命の判定と混ぜない。
    const expiredAt = ISSUED_AT + CHALLENGE_TOKEN_TTL_MS + 1_000
    expect(
      verifyFormSessionValue(
        afterExpiry.issued ? afterExpiry.cookieValue : '',
        SECRET,
        expiredAt,
      ),
      '使用済み記録が有効期間を過ぎても残り続けている（メモリが単調増加する）',
    ).not.toBeNull()
  })

  it('使用済みトークンの記録に件数上限がある（無制限に積ませない）', async () => {
    // 失効（TTL）だけでは、**有効期間内に大量投入する**攻撃を防げない。
    // `lib/rate-limit.ts:105` の `DEFAULT_MEMORY_STORE_MAX_ENTRIES` と同じ形で上界を持つこと。
    expect(CHALLENGE_TOKEN_MAX_ENTRIES).toBeTypeOf('number')
    expect(CHALLENGE_TOKEN_MAX_ENTRIES).toBeGreaterThan(0)
    expect(
      CHALLENGE_TOKEN_TTL_MS,
      'TTL が Turnstile のトークン有効期間（300 秒）より長い（記録し続ける意味が無い）',
    ).toBeLessThanOrEqual(300_000)
  })

  it('使用済みトークンの記録は差し替えられる（KV 化の継ぎ目 / 単一プロセス前提にしない）', async () => {
    // 本番は複数インスタンスなので、内蔵のメモリ記録では**インスタンスを跨いだ流用**を防げない。
    // 差し替え口を契約に含めておかないと、P3b-2（KV 化）の時点で
    // 「実装を書き直す」か「単一プロセス前提のまま出す」の二択になる。
    const seen = new Set<string>()
    const store = {
      consume: async (token: string) => {
        if (seen.has(token)) return false
        seen.add(token)
        return true
      },
    }
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    const token = freshToken(7)
    const first = await issueFormSession({
      clientIp: DEGRADED,
      limiter,
      secret: SECRET,
      now: () => ISSUED_AT,
      challengeToken: token,
      usedChallengeTokens: store,
    })
    const second = await issueFormSession({
      clientIp: DEGRADED,
      limiter,
      secret: SECRET,
      now: () => ISSUED_AT,
      challengeToken: token,
      usedChallengeTokens: store,
    })

    expect(isUnmarked(first.issued ? first.cookieValue : null)).toBe(true)
    expect(
      isUnmarked(second.issued ? second.cookieValue : null),
      '差し替えた記録が使われていない（内蔵の記録だけを見ている）',
    ).toBe(false)
  })
})

/* ========================================================================= *
 * SEC-067 (3): ロックアウトの**自己維持**を切る（増幅要因）
 * ========================================================================= */

describe('SEC-067: 既に有効な Cookie を持つ再訪者は、新しい Cookie を受け取らない', () => {
  it('hasVerifiedSession の要求には発行せず、reason: "already-verified" を返す', async () => {
    // **REV-P3C1-001 による作り直しの中心。**
    // 当初の契約「枠を消費しないが発行はする」は SEC-057 を開く（ヘッダ §REV-P3C1-001 参照）。
    // **発行しなければ増幅も蓄積も同時に消える。**
    //
    // 利用者から見た導線は変わらない: `app/api/form-session/route.ts` は
    // この場合も `/apply` へ 303 する（Cookie を再発行しないだけ）。
    const result = await issueResult(issueLimiter(), DEGRADED, { hasVerifiedSession: true })

    expect(result.issued, '有効な Cookie を持つ再訪に新しい Cookie を発行している').toBe(false)
    if (result.issued) return
    expect(result.reason).toBe('already-verified')
    expect(
      result as Record<string, unknown>,
      'already-verified に Retry-After の材料を付けている（待つ必要が無いので意味が反転する）',
    ).not.toHaveProperty('retryAfterMs')
  })

  it('再訪の要求を 20 回繰り返しても、その後の新規来訪者に印が付かない', async () => {
    // **監査が自分で追跡した増幅要因**への対応。
    // 印の付いた（あるいは Cookie を持つ）利用者は `/apply` を開くたびに
    // `/api/form-session` へリダイレクトして枠を消費するため、
    // **被害者の再試行そのものがロックアウトを自己維持する**。
    // 実測の傍証: `docs/impl-p3b-fix2-notes-2026-07-29.md` §4 が、E2E の通常操作だけで
    // `/apply` への遷移が窓内 23 回に達したことを報告している
    //（＝ **無コスト枠 10 は通常利用で日常的に超える**）。
    //
    // これが green なら排除される事故: 攻撃者が 1 人も居なくても、
    // **正常な利用者の往復だけで全員が Tier B に落ちる**こと。
    const limiter = issueLimiter()

    // 有効な Cookie を持つ再訪者が 20 回リロードする（枠 10 の 2 倍）。
    for (let n = 0; n < 20; n++) await issue(limiter, DEGRADED, { hasVerifiedSession: true })

    expect(
      isUnmarked(await issue(limiter)),
      '再訪者のリロードだけで無コスト枠が枯れ、新規来訪者が締め出された',
    ).toBe(true)
  })

  it('Cookie を持たない要求は従来どおり無コスト枠を消費する（枠が意味を失わない）', async () => {
    // これが green なら排除される壊れた修正: `hasVerifiedSession` を常に true で渡し、
    // **無コスト枠を実質無効化**して SEC-057 を開き直すこと。
    const limiter = issueLimiter()
    await exhaustFreeQuota(limiter)

    expect(isUnmarked(await issue(limiter))).toBe(false)
  })

  it('already-verified の要求も計数される（観測手段を失わない / 無コスト枠とは別勘定）', async () => {
    // **NEW-002**: `lib/form-session-issue.ts:108` は
    // 「**計数は常に行う（観測手段を失わない）**。ゲートに使うのは `trusted` のときだけ」と
    // 宣言している。同じ意味論は `lib/public-guard.ts:66-67` にもあり、
    // **SEC-021 → SEC-043 の 4 度の再発から得た教訓**として明文化されたものである。
    //
    // ところが「再訪の要求を 20 回繰り返しても新規来訪者に印が付かない」を満たすには
    // **無コスト枠のカウンタ（`apply:fs-issue:`）を進めてはならない**。
    // そのまま `consume` を丸ごと飛ばすと、**この経路だけ観測手段が消える**——
    // 攻撃者は 1 枚の有効な Cookie で `GET /api/form-session` を無制限に叩けるが、
    // 発行も DB もメールも起きないので実害は小さい。**しかし「見えない」ことは別の問題である。**
    //
    // したがって invariant は**別キーで維持する**（別勘定なので上の :「20 回」pin と両立する）。
    // これが green なら排除される事故: 「テストを満たすための副作用」として
    // 明文化された invariant が黙って消えること。
    const calls: string[] = []
    const inner = issueLimiter()
    const recording: RateLimiter = {
      consume: (key, at) => {
        calls.push(key)
        return inner.consume(key, at)
      },
      peek: (key, at) => inner.peek(key, at),
      reset: (key) => inner.reset(key),
    }

    await issueResult(recording, DEGRADED, { hasVerifiedSession: true })

    expect(calls.length, 'already-verified の要求が 1 度も計数されていない').toBeGreaterThan(0)
    expect(
      calls.every((key) => !key.includes('fs-issue')),
      `無コスト枠のキーを消費している: ${JSON.stringify(calls)}`,
    ).toBe(true)
  })
})

/* ========================================================================= *
 * SEC-067 (3''): **更新窓**（NEW-003 / Should Fix）
 * ========================================================================= *
 *
 * 「有効な Cookie があれば発行しない」は、Cookie を**更新しない**ことを意味する。
 * 従来は `/apply` を開くたびに新しい Cookie が出るので**実質的に更新されていた**が、
 * 新契約では**有効な Cookie がある限り二度と発行されない** ⇒
 * 「初回訪問から 30 分」（`FORM_SESSION_MAX_AGE_SEC = 1_800`）で必ず失効し、
 * **入力途中の利用者が Tier B に落ちる。**
 *
 * これは再監査 §5 申し送り 1 が **P3-c2 について名指しした懸念**そのものである:
 *
 * > 写真アップロードは申込フォームより**滞在時間が長く、Cookie 寿命（30 分）との競合が起きやすい**。
 *
 * つまり SEC-067（可用性）の修正が、P3-c2 で顕在化する既知の弱点を**強める方向に働く**。
 * SEC-067 は可用性の指摘なので、**その修正が別の可用性劣化を生むなら正味で改善かを判断する材料が要る。**
 *
 * ## 採る形: `hasVerifiedSession` の意味を「**有効かつ失効間近でない**」に限定する
 *
 * ```ts
 * // lib/form-session.ts
 * /** 残りがこの時間を切ったら再発行する（更新窓）。 *\/
 * export const FORM_SESSION_RENEW_BEFORE_MS: number    // 例: 10 分
 *
 * /** 有効だが失効間近か（＝ 再発行すべきか）。 *\/
 * export function isFormSessionRenewable(payload: FormSessionPayload, now: number): boolean
 * ```
 * ルートは `hasVerifiedSession: presented !== null && !isFormSessionRenewable(presented, now)` とする。
 * **判定は正典モジュールに置く**（AC-RL-8。ルートに式を書くと判定の複製になる）。
 *
 * 再発行が起きるのは 1 枚あたり高々数回なので、**蓄積の上界（pin ②）は壊れない**
 * ——それも下で測る。
 */

describe('NEW-003: 失効間近の Cookie は再発行する（30 分で必ず切れる状態を作らない）', () => {
  it('発行から間もない Cookie は「更新不要」と判定される', async () => {
    const payload = { sid: 'a'.repeat(32), issuedAt: ISSUED_AT }
    expect(isFormSessionRenewable(payload, ISSUED_AT + 60_000)).toBe(false)
  })

  it('残りが更新窓を切った Cookie は「更新すべき」と判定される', async () => {
    // これが green なら排除される事故: 入力途中の利用者が**予告なく 30 分で Tier B に落ちる**こと。
    // 回復経路があれば恒久ロックアウトではないが、
    // **「何もしていない正規利用者が 30 分で 1 回必ず CAPTCHA を踏む」**のは劣化である。
    const payload = { sid: 'a'.repeat(32), issuedAt: ISSUED_AT }
    const maxAgeMs = FORM_SESSION_MAX_AGE_SEC * 1000
    const nearExpiry = ISSUED_AT + maxAgeMs - FORM_SESSION_RENEW_BEFORE_MS + 1_000

    expect(isFormSessionRenewable(payload, nearExpiry)).toBe(true)
  })

  it('更新窓は Cookie 寿命より短い（常に再発行＝発行しない契約が無意味になる形を防ぐ）', () => {
    // これが green なら排除される壊れた設定: 更新窓を寿命以上にして
    // **毎回再発行**にすること（＝ 自己維持の切断が消え、SEC-067 が元に戻る）。
    expect(FORM_SESSION_RENEW_BEFORE_MS).toBeGreaterThan(0)
    expect(FORM_SESSION_RENEW_BEFORE_MS).toBeLessThan(FORM_SESSION_MAX_AGE_SEC * 1000)
  })

  it('更新のための再発行を繰り返しても、印なし Cookie の蓄積上界は壊れない', async () => {
    // NEW-003 の修正が REV-P3C1-001 の pin ② を壊さないことの確認。
    // 更新は 1 利用者あたり高々「寿命 ÷ 更新窓」回しか起きないが、
    // **攻撃者は失効間近の Cookie を提示し続けることで再発行を誘発できる**ので、
    // その経路でも無コスト枠が効くことを測る。
    const limiter = issueLimiter()
    let unmarked = 0
    for (let n = 0; n < 200; n++) {
      // 「有効だが失効間近」＝ ルートは `hasVerifiedSession: false` を渡す（＝ 通常の発行経路）。
      if (isUnmarked(await issue(limiter, DEGRADED, { hasVerifiedSession: false }))) unmarked++
    }
    expect(
      unmarked,
      `更新経由で印なし Cookie を ${unmarked} 枚積み上げられた（無コスト枠 ${FORM_SESSION_FREE_ISSUE_LIMIT}）`,
    ).toBeLessThanOrEqual(FORM_SESSION_FREE_ISSUE_LIMIT)
  })
})

/* ========================================================================= *
 * SEC-067 (3'): **受け口の悪用**を測る 3 本の pin（REV-P3C1-001 / Must Fix）
 * ========================================================================= *
 *
 * レビューの指摘:
 * > 「攻撃者が Cookie を提示するとどうなるか」を測る pin が**1 件も存在しない**。
 * > 「受け口が在るから結線済みと読める」で 1 度事故を起こしたプロジェクトとして、
 * > ここは同じ型の見落としである（受け口の**悪用**が測られていない）。
 *
 * 以下の 3 本は **現行実装（`hasVerifiedSession` を無視する）では green** であり、
 * **素朴な実装（`consume` を飛ばす）を入れた瞬間に red になる。**
 * それがこの pin の価値そのものである（再レビュー条件 2）。
 * 実測結果は `docs/test-design-p3c1-2026-07-29.md` §4.1 に記載した。
 */

describe('REV-P3C1-001: hasVerifiedSession を悪用しても上限を超えられない', () => {
  it('pin①: hasVerifiedSession を渡しても、trusted の硬い上限（30 回/10 分）は超えられない', async () => {
    // 素朴な実装（`if (!hasVerifiedSession) consume()`）では
    // `lib/form-session-issue.ts:110` のゲートが `consume` の結果に依存しているため、
    // **有効な Cookie を 1 枚持つ攻撃者が印の無い Cookie を無制限に発行できる。**
    const limiter = issueLimiter()
    let issued = 0
    for (let n = 0; n < FORM_SESSION_ISSUE_LIMIT + 20; n++) {
      if ((await issue(limiter, TRUSTED, { hasVerifiedSession: true })) !== null) issued++
    }
    expect(
      issued,
      `Cookie を提示するだけで ${issued} 枚発行できた（硬い上限 ${FORM_SESSION_ISSUE_LIMIT} を超えた）`,
    ).toBeLessThanOrEqual(FORM_SESSION_ISSUE_LIMIT)
  })

  it('pin②: 有効な Cookie を再提示し続けても、印の無い Cookie の総数は無コスト枠を超えない', async () => {
    // **SEC-057 の核心（「一意性ではなく入手コスト」）に対する直接の反例を塞ぐ。**
    // Cookie には「消費」の概念が無く（`lib/form-session.ts:167-222`）、
    // 再発行時に旧 `sid` を無効化する経路も無いので、
    // 攻撃者は 1 枚を提示し続けるだけで積み上げられてしまう。
    const limiter = issueLimiter()
    let unmarked = 0
    for (let n = 0; n < 200; n++) {
      if (isUnmarked(await issue(limiter, DEGRADED, { hasVerifiedSession: true }))) unmarked++
    }
    expect(
      unmarked,
      `Cookie を提示し続けるだけで印なし Cookie を ${unmarked} 枚積み上げられた` +
        `（無コスト枠 ${FORM_SESSION_FREE_ISSUE_LIMIT}）`,
    ).toBeLessThanOrEqual(FORM_SESSION_FREE_ISSUE_LIMIT)
  })

  it('pin③: 本番配線で、Cookie を提示し続ける攻撃者の到達数も上界を超えない', async () => {
    // pin② の「枚数」を**本番経路の到達数**まで通して測る。
    // `tests/unit/form-session-issue-cost.test.ts` の `attackerScenario` は
    // `hasVerifiedSession` を渡さない（＝ Cookie を提示しない攻撃者しか測っていない）ため、
    // 上界 30 の pin（`toBe(30)`）はこの経路を**素通りする**。
    const limiter = issueLimiter()
    const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
    const guarded = withPublicMutation(handler, productionWiring())

    for (let n = 0; n < 200; n++) {
      const value = await issue(limiter, DEGRADED, { hasVerifiedSession: true })
      if (value === null) continue
      for (let i = 0; i < FORM_SESSION_LIMIT; i++) {
        await guarded(request(value), undefined)
      }
    }

    const reached = handler.mock.calls.length
    expect(
      reached,
      `Cookie を提示し続ける攻撃者が ${reached} 回本体へ到達した` +
        `（上界 ${FORM_SESSION_FREE_ISSUE_LIMIT * FORM_SESSION_LIMIT} 回）`,
    ).toBeLessThanOrEqual(FORM_SESSION_FREE_ISSUE_LIMIT * FORM_SESSION_LIMIT)
  })
})

/* ========================================================================= *
 * SEC-067 (4): 通常構成（trusted=true）への波及が無いこと
 * ========================================================================= */

describe('SEC-067: 通常構成の振る舞いは変わらない（退行防止）', () => {
  it('trusted=true では、枠を超えても印は付かない（Vercel 上の NAT 配下利用者を守る）', async () => {
    const limiter = issueLimiter()
    for (let n = 0; n < FORM_SESSION_FREE_ISSUE_LIMIT + 5; n++) await issue(limiter, TRUSTED)

    const value = await issue(limiter, TRUSTED)
    expect(verifyFormSessionValue(value, SECRET, NOW)).not.toBeNull()
  })

  it('trusted=true では発行の硬い上限（30 回/10 分）が従来どおり効く', async () => {
    const limiter = issueLimiter()
    let issued = 0
    for (let n = 0; n < FORM_SESSION_ISSUE_LIMIT + 10; n++) {
      if ((await issue(limiter, TRUSTED)) !== null) issued++
    }
    expect(issued).toBe(FORM_SESSION_ISSUE_LIMIT)
  })
})

/* ========================================================================= *
 * SEC-068: 印がクライアントから読めないこと（状態オラクルを消す）
 * ========================================================================= */

describe('SEC-068: 未検証の印が Cookie から可読であってはならない', () => {
  const SID = 'a'.repeat(32)
  const decodePayload = (value: string): string =>
    Buffer.from(value.split('.')[0], 'base64url').toString('utf8')

  it('payload をデコードしても印の有無が現れない', () => {
    // これが green なら排除される情報露出:
    //  (a) 非ブラウザのクライアント（curl / スクリプト）が自分の `Set-Cookie` をデコードして
    //      「無コスト枠を使い切ったか」を確実に判定でき、**SEC-067 の DoS を最小コストで維持**できる。
    //  (b) 窓内に何枚目で印が付くかを二分探索すれば、**当該 10 分窓の `/apply` 来訪者数を推定**できる
    //      （弱いトラフィック量の側路）。
    // Cookie は HttpOnly なのでブラウザ JS からは読めないが、**HttpOnly は非ブラウザには効かない**。
    const marked = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT, unverified: true }, SECRET)
    expect(decodePayload(marked)).not.toMatch(/unverified/i)
  })

  it('印の有無だけが違う 2 つの値は、payload が完全に同一である', () => {
    // 「フィールド名を変える / 短くする」といった難読化では不十分であることを固定する。
    // **クライアントに渡る payload は、印の有無で 1 バイトも変わってはならない。**
    const marked = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT, unverified: true }, SECRET)
    const plain = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT }, SECRET)

    expect(decodePayload(marked)).toBe(decodePayload(plain))
    expect(marked.length, '値の長さで印の有無が判別できる').toBe(plain.length)
  })

  it('それでもサーバーは印を検出できる（機能は維持される）', () => {
    // 露出だけを消して**検証を弱めない**こと。
    // これが green なら排除される壊れた修正: 印を「読めなくする」ために印そのものを消し、
    // SEC-057 を開き直すこと。
    const marked = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT, unverified: true }, SECRET)
    const plain = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT }, SECRET)

    expect(marked, '印あり / 印なしが同一の値になっている（印が消えている）').not.toBe(plain)
    expect(verifyFormSessionValue(marked, SECRET, NOW)).toBeNull()
    expect(verifyFormSessionValue(plain, SECRET, NOW)).not.toBeNull()
  })

  it('署名は依然として payload 全体を覆う（印の剥離・偽造ができない）', () => {
    // 再監査 §4「印の偽造・剥離: **不可**」の維持。
    // 印を隠す実装が、うっかり署名の対象範囲を狭めていないことを固定する。
    const plain = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT }, SECRET)
    const [payloadPart, signaturePart] = plain.split('.')
    const tampered = `${Buffer.from(
      JSON.stringify({ sid: SID, issuedAt: ISSUED_AT + 1 }),
      'utf8',
    ).toString('base64url')}.${signaturePart}`

    expect(payloadPart.length).toBeGreaterThan(0)
    expect(verifyFormSessionValue(tampered, SECRET, NOW)).toBeNull()
  })

  it('既存形式（印なし）の値は引き続き検証を通る（後方互換 / 76 integration を守る）', () => {
    // `tests/integration/applications.int.ts` の手組み Cookie が一括で無効化されると
    // 「テストのほうを直す」圧力が生まれる（SEC-057 の修正時と同じ配慮）。
    const legacy = createFormSessionValue({ sid: SID, issuedAt: ISSUED_AT }, SECRET)
    expect(verifyFormSessionValue(legacy, SECRET, NOW)).not.toBeNull()
  })
})
