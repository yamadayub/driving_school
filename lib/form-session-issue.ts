/**
 * フォームセッション Cookie の**発行**（AC-RL-13(a)(c) / AC-RL-3 (3)）。
 *
 * ------------------------------------------------------------------------
 * なぜ発行側にも上限が要るのか
 * ------------------------------------------------------------------------
 * AC-RL-3 は「同一 Cookie の4回目が拒否される**だけ**をテストにしてはならない」と明記している
 * ——**攻撃者は同一 Cookie を送らない**。Cookie を取り直せば Tier D の Cookie 軸は毎回
 * リセットされるため、**発行側に上限が無ければ Cookie 軸は防御として成立しない**
 * （`public-guard-p3b-wiring.test.ts` の「Cookie 10枚 → handler 30回」がその実測）。
 *
 * ------------------------------------------------------------------------
 * 縮退（`trusted === false`）での意味論
 * ------------------------------------------------------------------------
 * **共有 `unknown` バケットを硬いゲートにしない**（`lib/public-guard.ts` の `sourceAxisFor` と
 * 同じ意味論 / SEC-043 / SEC-021）。縮退時にゲートへ使うと、第三者が 30 回フォームを開くだけで
 * **全利用者が `/apply` を開けなくなる**。計数は続ける——ゲートに使わないことと数えないことは別である。
 *
 * ただし「止めない」ことは「タダである」ことを意味しない（**SEC-057**）。縮退で
 * `FORM_SESSION_FREE_ISSUE_LIMIT` を超えて発行した Cookie には**未検証の印**を付け、
 * その Cookie での送信を Tier B（回復可能な降格）にする。**発行は続き、ページも開ける。**
 *
 * ------------------------------------------------------------------------
 * ページ側に判定ロジックを書かないこと（AC-RL-8）
 * ------------------------------------------------------------------------
 * `GET /apply` は本関数を呼び、`issued: true` なら `Set-Cookie`、`false` なら Tier D
 * （429 + `Retry-After`）を返すだけにする。判定の複製を作らない。
 */

import type { ClientIpResolution } from '@/lib/http-guard'
import { rateLimitKey, type RateLimiter } from '@/lib/rate-limit'
import {
  FORM_SESSION_COOKIE_NAME,
  createFormSessionValue,
  formSessionCookieAttributes,
  newFormSessionPayload,
  type FormSessionCookieAttributes,
} from '@/lib/form-session'

/** 発行の上限（発信元あたり / 10分）。目的は「タダで無限に増やせない」ことなので緩くてよい。 */
export const FORM_SESSION_ISSUE_LIMIT = 30

/** 発行制限のウィンドウ（ms）。 */
export const FORM_SESSION_ISSUE_WINDOW_MS = 600_000

/**
 * **無コストで発行できる枚数**（発信元あたり / 同一ウィンドウ / SEC-057）。
 *
 * ------------------------------------------------------------------------
 * なぜ `FORM_SESSION_ISSUE_LIMIT`(30) を流用しないのか
 * ------------------------------------------------------------------------
 * 縮退構成では上の 30 が**ゲートにならない**（共有 `unknown` バケットを硬い拒否にすると、
 * 第三者が 30 回開くだけで全利用者が `/apply` を開けなくなる）。したがって縮退では
 * 「30 を超えたら印を付ける」では**監査が実測した 20 枚のシナリオで 1 枚も印が付かず、
 * 何も直らない**。閾値は監査実測（20 枚 × 3 回 = 60 件成功）より**下**に置く必要がある。
 *
 * ------------------------------------------------------------------------
 * 10 という値の根拠
 * ------------------------------------------------------------------------
 *  - **上界**: 監査実測の 20 枚を確実に閉じるため 20 未満であること。
 *  - **下界**: 正規利用者は 1 回の来訪で 1 枚しか要らない（Cookie の寿命は 30 分、
 *    発行の窓は 10 分）。縮退構成は「Vercel 以外の本番・ローカル・E2E」であり、
 *    10 分あたり 10 回の来訪までは**誰も追加コストを払わない**。
 *  - **本体到達数の上界**: 印の無い Cookie は 10 枚 ×（送信側 Cookie 軸 3 回/10 分）= **30 回**。
 *    AC-RL-13(c) が「Cookie 軸をタダで増やせない」と宣言したときに暗黙に約束していた
 *    上限（30 × 3 = 90）を下回る。
 *
 * 11 枚目以降は**発行はされるが未検証の印が付く**（`lib/form-session.ts` の `unverified`）。
 * 送信は Tier B（403 + `challenge`）になり、**ページの閲覧も発行も止まらない**。
 */
export const FORM_SESSION_FREE_ISSUE_LIMIT = 10

/** レート制限キーの接頭辞（送信側の軸と混ざらないように分ける）。 */
const ISSUE_KEY_PREFIX = 'apply:fs-issue:'

/**
 * **再訪（`already-verified`）の計数キー**（NEW-002）。**無コスト枠とは別勘定**。
 *
 * `lib/public-guard.ts` と本モジュールは「**計数は常に行う（観測手段を失わない）。
 * ゲートに使うのは `trusted` のときだけ**」という invariant を宣言しており、
 * これは SEC-021 → SEC-043 の 4 度の再発から得た教訓として明文化されたものである。
 *
 * ところが SEC-067 の自己維持を切るには**無コスト枠のカウンタを進めてはならない**。
 * `consume` を丸ごと飛ばすと**この経路だけ観測手段が消える**——攻撃者は 1 枚の有効な Cookie で
 * `GET /api/form-session` を無制限に叩けて、発行も DB もメールも起きないので実害は小さいが、
 * **「見えない」ことは別の問題である。** そこで invariant は**別キーで維持する。**
 */
const REVISIT_KEY_PREFIX = 'apply:fs-revisit:'

/**
 * 使用済みチャレンジトークンの記録の TTL（ms）。
 *
 * 基準は**チャレンジトークンの有効期間**（Cloudflare Turnstile の siteverify は 300 秒）。
 * それを過ぎたトークンは siteverify 自体が拒否するので、記録し続ける意味が無い
 *（記録が単調増加するだけになる）。
 */
export const CHALLENGE_TOKEN_TTL_MS = 300_000

/**
 * 使用済みトークン記録の件数上限（NEW-004）。
 *
 * TTL だけでは**有効期間内に大量投入する**攻撃を防げない。トークンは Turnstile を通過するたびに
 * 1 件挿入されるので、攻撃者は **CAPTCHA を解いた分だけサーバーのメモリにエントリを積める**。
 * `lib/rate-limit.ts` の `DEFAULT_MEMORY_STORE_MAX_ENTRIES` と同じ形で上界を持たせる
 *（SEC-023 / SEC-031 / SEC-041 で 3 度扱った同型の欠陥）。
 */
export const CHALLENGE_TOKEN_MAX_ENTRIES = 10_000

/** 使用済みチャレンジトークンの記録。**KV 化の差し替え口**。 */
export interface UsedChallengeTokenStore {
  /** 初回 `true` / 2 回目以降 `false`。 */
  consume(token: string, at: number): Promise<boolean>
}

/**
 * 内蔵（メモリ）の使用済みトークン記録。
 *
 * ⚠️ **本番は複数インスタンスなので、これだけでは「インスタンスを跨いだ流用」を防げない。**
 * `usedChallengeTokens` オプションが KV 化の差し替え口である
 *（「差し替え口を用意した」ことは既定実装の品質を保証しない——**既定で使われるのは内蔵のほう**
 *  であり、SEC-053 と同じ構図なので TTL と件数上限を持たせてある）。
 */
function createUsedChallengeTokenStore(): UsedChallengeTokenStore {
  /** token → 失効時刻（epoch ms）。挿入順を保つので、退避は最古から行える。 */
  const entries = new Map<string, number>()

  return {
    async consume(token: string, at: number): Promise<boolean> {
      const expiresAt = entries.get(token)
      if (expiresAt !== undefined) {
        // **有効期間内の再提示は「未通過」扱い**——これが増幅率を 1 に固定する実体である。
        if (expiresAt > at) return false
        entries.delete(token)
      }

      if (entries.size >= CHALLENGE_TOKEN_MAX_ENTRIES) {
        // 期限切れを優先して落とし、それでも空かなければ最古から落とす（`lib/rate-limit.ts` と同じ形）。
        //
        // ⚠️ **最古の退避は「未失効のトークン」も落としうる**（＝ 落とされたトークンは
        // TTL 内でも次回「初回」として扱われ、増幅率が 1 を超える / CR-003）。
        // **評価: 実質的に悪用不能**。成立させるには 300 秒以内に
        // `CHALLENGE_TOKEN_MAX_ENTRIES`（10,000）件の**有効な**トークンを投入する必要があり、
        // **CAPTCHA を 1 万回解いて印なし Cookie を 1 枚余分に得る**より
        // **素直に 1 回解くほうが安い**。`lib/rate-limit.ts` の退避と同じトレードオフである。
        // （この評価を残すのは、次の監査が同じ検討を最初からやり直さずに済むようにするため。）
        for (const [key, exp] of entries) {
          if (exp <= at) entries.delete(key)
        }
        while (entries.size >= CHALLENGE_TOKEN_MAX_ENTRIES) {
          const oldest = entries.keys().next()
          if (oldest.done) break
          entries.delete(oldest.value)
        }
      }

      entries.set(token, at + CHALLENGE_TOKEN_TTL_MS)
      return true
    },
  }
}

/** 既定の記録。**プロセス大域**（インスタンス内での流用だけを防ぐ）。 */
const defaultUsedChallengeTokens = createUsedChallengeTokenStore()

export type FormSessionIssueResult =
  | {
      issued: true
      cookieName: string
      cookieValue: string
      attributes: FormSessionCookieAttributes
    }
  | { issued: false; reason: 'rate-limited'; retryAfterMs: number }
  /** 有効な Cookie を既に持っている再訪。**待つ必要が無いので `retryAfterMs` を持たない。** */
  | { issued: false; reason: 'already-verified' }

export interface IssueFormSessionOptions {
  /**
   * **分解せずに渡す**（SEC-043 の型の継ぎ目と同じ）。`.key` だけを受け取る形にすると、
   * 呼び出し側が `trusted` を捨てられるようになる。
   */
  clientIp: ClientIpResolution
  limiter: RateLimiter
  secret: string
  /**
   * 有効（印の無い）Cookie を提示している再訪か（SEC-067 修正方針 3 / REV-P3C1-001）。
   * **発行そのものを行わない**（`issued: false, reason: 'already-verified'`）。
   *
   * ⚠️ **「枠を消費しないが発行はする」にしてはならない。**
   * 枠の免除に上界が無ければ枠は存在しないのと同じであり、Cookie には「消費」の概念が無い以上、
   * 攻撃者は 1 枚の有効な Cookie を提示し続けるだけで印の無い Cookie を積み上げられる
   *（素朴な実装では本番配線での到達数が **600 回（上界 30 の 20 倍）**に達することを Test Agent が実測済み）。
   *
   * ⚠️ 判定は「Cookie を持っているか」ではなく「**有効な Cookie を持っているか**」である。
   * 印の付いた Cookie は `verifyFormSessionValue` が `null` を返すので、
   * ここを `true` にしてはならない——するとロックアウトが**恒久化**する。
   */
  hasVerifiedSession?: boolean
  /**
   * このリクエストで **サーバー側が検証した** チャレンジトークン（値またはそのハッシュ）。
   * 渡された場合、無コスト枠を超えていても印を付けない。
   * **同一トークンの 2 回目以降は「未通過」として扱う**（増幅率を 1 に固定 / REV-P3C1-002）。
   *
   * ⚠️ **クライアントの自己申告を渡してはならない。** 必ず `verifyTurnstile` の結果として得ること。
   * ボディの値を無検証で流すと、印が 1 行で無効化される。
   */
  challengeToken?: string
  /** 使用済みチャレンジトークンの記録。省略時は内蔵（メモリ）。**KV 化の差し替え口**。 */
  usedChallengeTokens?: UsedChallengeTokenStore
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
}

export async function issueFormSession(
  options: IssueFormSessionOptions,
): Promise<FormSessionIssueResult> {
  const { clientIp, limiter, secret } = options
  const now = options.now ?? Date.now
  const at = now()

  /*
   * SEC-067 の**自己維持を切る**（監査の修正方針 3 / REV-P3C1-001）。
   *
   * 印の付いた利用者は `/apply` を開くたびに `/api/form-session` へリダイレクトして
   * 発行枠をもう 1 つ消費するため、**被害者の再試行そのものがロックアウトを自己維持する**
   *（E2E の通常操作だけで窓内 23 回に到達した実測がある = 無コスト枠 10 は通常利用で日常的に超える）。
   *
   * **発行しなければ増幅も蓄積も同時に消える。** 印の無い Cookie の総数が増えないので
   * SEC-057 にも触れない。利用者から見た導線は変わらない
   *（`app/api/form-session/route.ts` はこの場合も `/apply` へ 303 する）。
   */
  if (options.hasVerifiedSession === true) {
    // **別キーで計数する**（NEW-002）。無コスト枠は消費しないが、観測手段は失わない。
    //
    // ⚠️ limiter インスタンスは発行用と**同じ**だが、**上限値（30）も窓（10 分）も使っていない**
    // ——`consume` の結果を一切見ないためである（CR-004）。同じ limiter を通すのは
    // **キー空間を分けるためだけ**であって、発行の上限設定を再訪へ適用する意図は無い。
    // したがって発行側の上限を変える人が、再訪カウンタへの影響を検討する必要は無い。
    await limiter.consume(rateLimitKey(REVISIT_KEY_PREFIX, clientIp.key), at)
    return { issued: false, reason: 'already-verified' }
  }

  // `rateLimitKey` を通すことで IPv6 の `/64` 正規化が発行経路でも効く（AC-RL-4 / SEC-032）。
  // 生ヘッダを直接キーにすると、同一 `/64` 内でアドレスを変えるだけで上限を無限に回避できる。
  const key = rateLimitKey(ISSUE_KEY_PREFIX, clientIp.key)

  // 計数は常に行う（観測手段を失わない）。ゲートに使うのは `trusted` のときだけ。
  const result = await limiter.consume(key, at)
  if (!result.success && clientIp.trusted) {
    return { issued: false, reason: 'rate-limited', retryAfterMs: Math.max(1, result.retryAfterMs) }
  }

  /*
   * SEC-057: 縮退（`trusted === false`）では上の枠がゲートにならない——つまり
   * **Cookie は何枚でもタダで手に入る**。P3b-1b が型で保証した「軸は要求元ごとに一意」は、
   * 軸をタダで作り直せる限り防御にならない。
   *
   * そこで**無コスト枠を超えて発行した Cookie に未検証の印を付ける**。
   *  - 発行そのものは止めない（止めると第三者が枠を叩くだけで `/apply` を封鎖できる）。
   *  - 印の付いた Cookie での送信は Tier B（403 + `challenge`）になる——**回復可能なコスト**であり、
   *    共有バケットの枯渇を 429 にする形（SEC-043 まで 4 度再発）ではない。
   *  - **通常構成（`trusted`）には適用しない。** そちらは上の 30 回が硬いゲートとして効いており、
   *    印を付けると Vercel 上の正規利用者（NAT 配下）まで CAPTCHA 地獄に落ちる。
   *
   * `limit - remaining` は「このウィンドウで消費済みの回数」である（`toResult` の定義）。
   */
  const consumedInWindow = result.limit - result.remaining
  let unverified = !clientIp.trusted && consumedInWindow > FORM_SESSION_FREE_ISSUE_LIMIT

  /*
   * **回復経路**（監査の修正方針 2 / SEC-067）。印を「Tier B 確定」から「**チャレンジ必須**」へ降格する。
   *
   * 現状の印は終端である——Turnstile 検証は `app/api/applications/route.ts` の**ハンドラ内**にあり、
   * `lib/public-guard.ts` の Tier B 判定より後なので**一度も評価されない**。
   * すなわち「CAPTCHA を解いて再送しても同じ応答が返る**抜けられないループ**」
   *（`lib/public-guard.ts` が 413 について自ら禁じた形）が Tier B 側に持ち込まれている。
   *
   * ⚠️ **コストは「発行の時点で」払わせる。** ラッパを通してハンドラの Turnstile で判定させる形は
   * **SEC-057 を再び開く**——`tests/unit/form-session-issue-cost.test.ts` と
   * `tests/integration/form-session-cost.int.ts` は Turnstile を「常に通過」として測るため、
   * 印の判定をハンドラ内へ移すと**到達数が Cookie 枚数に比例して戻る**。
   *
   * ⚠️ **増幅率は 1 でなければならない**（REV-P3C1-002）。
   * 「1 回の検証結果を N 回の発行に流用する」を許すと縮退での到達数は
   * 「30（無コスト）+ 3 × 流用枚数」になり、**測っていない経路で上界が破られる**。
   * **回復経路の価値はコスト比で決まる。増幅率が 1 でなければコストは割り算で消える。**
   *
   * 記録の消費は**印が付く場合だけ**に限る（印が付かない要求で消費しても意味が無く、
   * 記録を無駄に埋めるだけになる）。
   */
  if (unverified && options.challengeToken !== undefined) {
    const usedTokens = options.usedChallengeTokens ?? defaultUsedChallengeTokens
    if (await usedTokens.consume(options.challengeToken, at)) unverified = false
  }

  const payload = newFormSessionPayload({
    now: at,
    randomBytes: options.randomBytes,
    unverified,
  })
  return {
    issued: true,
    cookieName: FORM_SESSION_COOKIE_NAME,
    cookieValue: createFormSessionValue(payload, secret),
    attributes: formSessionCookieAttributes(),
  }
}
