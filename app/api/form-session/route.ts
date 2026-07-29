/**
 * `GET /api/form-session` — フォームセッション Cookie の発行（AC-RL-13(a)(c) / AC-RL-3 (3)）。
 *
 * ------------------------------------------------------------------------
 * なぜ Route Handler なのか（設計判断 / テスト設計 §7 の申し送り）
 * ------------------------------------------------------------------------
 * AC-RL-13(a) は「`GET /apply` のレスポンスで Cookie を発行する」と定めるが、
 * **Next.js の Server Component は Cookie を設定できない**（実測 / Next 15.5.22:
 * `Cookies can only be modified in a Server Action or Route Handler.`）。
 * 選択肢は次の3つだった:
 *
 *  1. **middleware（Edge）で発行** — `lib/form-session.ts` は `node:crypto`（HKDF / HMAC /
 *     `timingSafeEqual`）に依存しており Edge で動かない。Web Crypto で書き直すと
 *     **署名の実装が2つ**になり、発行側と検証側がずれた瞬間に**全利用者が Tier B に落ちる**
 *     （`form-session-axis.test.ts` の「発行と検証の整合」が守ろうとしている事故そのもの）。
 *  2. **Node.js middleware（`experimental.nodeMiddleware`）** — Next 15.5 では
 *     `next.config.mjs` の検証が `Unrecognized key` を出す実験機能であり、
 *     公開・管理の全リクエストが通る層をこの単位で実験機能に載せ替えるのは割に合わない。
 *  3. **Route Handler + リダイレクト（本実装）** — 安定 API のみ。`lib/form-session.ts` を
 *     そのまま使えるので実装は1つのまま。`issueFormSession` をそのまま呼ぶので
 *     AC-RL-13(c)（発行の流量制限）も判定ロジックを複製せずに満たせる（AC-RL-8）。
 *
 * ------------------------------------------------------------------------
 * リダイレクトループを作らない
 * ------------------------------------------------------------------------
 * Cookie をブロックしている環境（プライベートブラウジング・企業端末）では発行しても
 * Cookie は付かない。**`?fs=1` を付けて戻す**ことで `/apply` 側が「発行は試みた」と判別でき、
 * 2度目のリダイレクトを行わない。その利用者はフォームを開けるが送信は Tier B になる
 * ——`form-submission.md` §3.5 が定めた正規の縮退経路であり、CAPTCHA 1タップでは
 * 抜けられないためこの単位の残余として明示しておく（P3-c 以降で再評価する）。
 *
 * **`?fs=1` はクライアントがマウント時に `history.replaceState` で消す**
 * （`components/apply/ApplicationForm.tsx` / RV-P3B-002）。消さないと、Cookie の寿命
 * （30 分）が切れた後のリロード・ブックマーク・URL 共有で**再発行が二度と行われず**、
 * 全項目を入力した利用者が回復手段のない 403 を受ける。
 *
 * ------------------------------------------------------------------------
 * 発行制限は「ページを奪う手段」ではない（RV-P3B-007）
 * ------------------------------------------------------------------------
 * 本ルートは Origin 検証もナビゲーション判定も持たない**状態変更 GET** だった。したがって:
 *  - 攻撃者のページが `<img src=".../api/form-session">` を 31 個並べるだけで、
 *    被害者の IP に紐づく発行枠（30 回/10 分）を使い切れた。
 *  - 使い切った後は `/apply` を開くと**フォームの代わりに生 JSON の 429** が表示された
 *    ——§4.11 のどの Tier も「ページが見られない」を含んでいない。
 *
 * そこで 2 点を守る:
 *  1. **サブリソース要求（`Sec-Fetch-Dest` が `document` 以外 / `Sec-Fetch-Site: cross-site`）は
 *     枠を消費せず Cookie も発行しない。** Cookie を配らないのは、`<img>` 経由で軸を作らせると
 *     **攻撃者が `issuedAt` を制御でき**、AC-RL-6 の送信間隔下限を事前に満たしておけるためである。
 *     ヘッダを送らない古いブラウザは**ナビゲーション扱い**にする（機能を壊さないため。
 *     偽装は可能だが、偽装できる相手は最初から普通に `/apply` を開ける）。
 *  2. **上限到達時も `/apply` へ 303 する**（`Retry-After` 付き / Cookie は発行しない）。
 *     AC-RL-13(c) の目的は「Cookie 軸をタダで増やせないこと」であって、
 *     利用者にエラーページを見せることではない。**発行を止めれば足り、ページを止める必要はない。**
 */

import { NextResponse } from 'next/server'
import { getServerEnv } from '@/lib/env'
import { resolveClientIp } from '@/lib/http-guard'
import { createRateLimiter } from '@/lib/rate-limit'
import { sharedRateLimitStore } from '@/lib/runtime-stores'
import {
  FORM_SESSION_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_WINDOW_MS,
  issueFormSession,
} from '@/lib/form-session-issue'
import {
  formSessionAxisKey,
  isFormSessionRenewable,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { withPublicMutation, TIER_B_BODY } from '@/lib/public-guard'
import { sharedSemaphoreStore } from '@/lib/runtime-stores'
import { createSemaphore } from '@/lib/semaphore'
import { consoleSink, createPiiSafeLogger } from '@/lib/pii-log'
import { verifyTurnstile } from '@/lib/turnstile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 発行済みマーカー。`/apply` はこれがある間は再リダイレクトしない。 */
export const FORM_SESSION_ISSUED_PARAM = 'fs'

/** 引き継いでよいクエリ（`?type=` / `?courseId=`）。**入力値は URL に載せない**（AC-008-3）。 */
const FORWARDED_PARAMS = ['type', 'courseId'] as const

const issueLimiter = createRateLimiter({
  limit: FORM_SESSION_ISSUE_LIMIT,
  windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
  store: sharedRateLimitStore(),
})

/* ------------------------------------------------------------------------- *
 * 回復経路（POST）の軸。**発行（GET）とも申込とも別勘定にする。**
 * ------------------------------------------------------------------------- */

/** 回復要求の発信元軸。縮退では計数のみ。 */
const recoverySourceLimiter = createRateLimiter({
  limit: 30,
  windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
  store: sharedRateLimitStore(),
})

/** 回復要求の Cookie 軸。縮退で enforce される唯一の Tier D 軸。 */
const recoveryFormSessionLimiter = createRateLimiter({
  limit: 10,
  windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
  store: sharedRateLimitStore(),
})

const recoverySemaphore = createSemaphore({
  store: sharedSemaphoreStore(),
  endpoint: 'form-session',
  perShardLimit: 8,
})

const recoveryLogger = createPiiSafeLogger(consoleSink)

getServerEnv()

/**
 * ページ遷移としての要求か（RV-P3B-007）。
 *
 * `Sec-Fetch-*` を**送ってこない**要求（古いブラウザ・一部のプロキシ）はナビゲーション扱いにする。
 * ここを fail-closed にすると、ヘッダを落とす環境の利用者が**フォームを一切開けなくなる**
 * ——防御の対象は「第三者ページが被害者のブラウザに要求させる」ことであり、
 * その形は必ず `Sec-Fetch-Site: cross-site` か `Sec-Fetch-Dest: image`（等）を伴う。
 */
function isNavigationRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false
  const dest = request.headers.get('sec-fetch-dest')
  if (dest !== null && dest !== 'document') return false
  return true
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const target = new URL('/apply', url.origin)
  for (const key of FORWARDED_PARAMS) {
    const value = url.searchParams.get(key)
    // オープンリダイレクトを作らない: 遷移先は `/apply` 固定で、引き継ぐのは許可した2つの値だけ。
    if (value !== null && value.length <= 64) target.searchParams.set(key, value)
  }
  target.searchParams.set(FORM_SESSION_ISSUED_PARAM, '1')

  // サブリソース要求（`<img>` / `fetch`）: **計数せず・Cookie も発行せず**戻すだけ。
  // 攻撃者に被害者の発行枠を使わせない／`issuedAt` を選ばせない。
  if (!isNavigationRequest(request)) {
    return NextResponse.redirect(target, 303)
  }

  /*
   * SEC-067 の**自己維持の切断**（NEW-001 / 結線）。
   *
   * 印の付いた利用者は `/apply` を開くたびにここへリダイレクトして発行枠をもう 1 つ消費するため、
   * **被害者の再試行そのものがロックアウトを自己維持する**（E2E の通常操作だけで窓内 23 回に到達
   * した実測がある = 無コスト枠 10 は通常利用で日常的に超える）。既に有効な Cookie があるなら発行しない。
   *
   * ⚠️ **判定は `verifyFormSessionValue` の結果で行う。Cookie の「存在」で判定してはならない。**
   * 印の付いた Cookie / 期限切れ / 壊れた値はいずれも `null` を返す（＝ 無効）ので、
   * その保持者には**発行する**。存在で判定すると、印の付いた利用者が新しい Cookie を永久に得られず
   * **SEC-067 のロックアウトが恒久化する**——直そうとした欠陥を悪化させる。
   *
   * ⚠️ **失効間近なら再発行する**（更新窓 / NEW-003）。判定は正典モジュールに置く（AC-RL-8）
   * ——ここに式を書くと判定の複製になる。これが無いと「有効な Cookie がある限り二度と更新されない」
   * ため、初回訪問から 30 分で必ず失効して**入力途中の利用者が Tier B に落ちる**。
   */
  const secret = process.env.FORM_SESSION_SECRET ?? ''
  const now = Date.now()
  const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, now)

  const result = await issueFormSession({
    // **分解せずに渡す**（SEC-043 の型の継ぎ目）。縮退時は計数のみで、発行は止めない
    // （代わりに無コスト枠を超えた Cookie へ未検証の印が付く / SEC-057）。
    clientIp: resolveClientIp(request),
    limiter: issueLimiter,
    secret,
    hasVerifiedSession: presented !== null && !isFormSessionRenewable(presented, now),
  })

  if (!result.issued) {
    // **Cookie は発行しないが、フォームへは到達させる。**
    // 生 JSON の 429 を返すと、`/apply` を開いた利用者にフォームも電話番号も見えなくなる
    //（`/apply` は Cookie が無ければここへリダイレクトするため / RV-P3B-007）。
    const response = NextResponse.redirect(target, 303)
    // ⚠️ **`reason` で分岐する。** `already-verified` に `Retry-After` を付けない——
    // 待つ必要が無い（既に有効な Cookie を持っている）ので、付けると意味が反転し、
    // クライアント側の再試行制御が誤作動する。付けるのは AC-RL-13(c) の上限到達だけである。
    if (result.reason === 'rate-limited') {
      response.headers.set('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))))
    }
    return response
  }

  const response = NextResponse.redirect(target, 303)
  response.cookies.set(result.cookieName, result.cookieValue, result.attributes)
  return response
}

/* ------------------------------------------------------------------------- *
 * POST — SEC-067 の回復経路（P3-c1 から明示的に繰り越した Must）
 * ------------------------------------------------------------------------- *
 *
 * ## なぜこの経路が要るのか
 * 縮退構成（`trusted=false`）では、第三者が `GET /api/form-session` を
 * **10 リクエスト / 10 分**送るだけで無コスト枠が枯れ、以後その窓の新規来訪者全員に
 * `unverified` の印が付く。印の付いた Cookie は `verifyFormSessionValue` が `null` を返すので
 * 送信も**写真アップロードも** Tier B（403）になる。
 *
 * **CAPTCHA では抜けられない**——Turnstile 検証は `app/api/applications/route.ts` の
 * **ハンドラ内**にあり、`lib/public-guard.ts` の Tier B 判定より**後**なので一度も評価されない。
 * これは `lib/public-guard.ts` が 413 について自ら禁じた
 * 「CAPTCHA を解いて再送しても同じ応答が返る**抜けられないループ**」と同型である。
 *
 * P3-c1 は `hasVerifiedSession`（自己維持の切断）を結線したが、
 * **印の付いた利用者には原理的に到達しない**ことが実測で確定した。
 * **印から抜ける唯一の道がこの `challengeToken` である。**
 *
 * ## コストは「発行の時点で」払わせる
 * ラッパを通してハンドラの Turnstile で判定させる形は **SEC-057 を再び開く**
 *（`form-session-issue-cost.test.ts` / `form-session-cost.int.ts` は Turnstile を
 *  「常に通過」として測るため、到達数が Cookie 枚数に比例して戻る）。
 * したがって**チャレンジを通した要求にだけ印の無い Cookie を出す**。
 */

/** Tier B（403 + challenge）。**降格理由を区別できないよう本文を 1 つに固定する。** */
function tierB(): Response {
  return Response.json(TIER_B_BODY, { status: 403 })
}

export const POST = withPublicMutation(async (request: Request): Promise<Response> => {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    // 壊れた JSON で 500 を起こさせない（SEC-042）。回復経路も同じ扱いにする。
    return tierB()
  }

  const captchaToken = (payload as { captchaToken?: unknown } | null)?.captchaToken

  // ⚠️ **サーバー側で検証する。クライアントの自己申告を信じない**（P3-c1 §12.2-3）。
  // ボディの値を無検証で `challengeToken` へ流すと、**印が 1 行で無効化される**
  //（＝ 無コスト枠が実質無制限になる / SEC-057 の再来）。
  // `verifyTurnstile` は秘密鍵が無ければ false を返す fail-closed なので、常に呼んで結果だけを見る。
  const passed = await verifyTurnstile(captchaToken, {
    secret: process.env.TURNSTILE_SECRET ?? '',
  })
  if (!passed) return tierB()

  const secret = process.env.FORM_SESSION_SECRET ?? ''
  const now = Date.now()

  // GET と同じ判定を通す（AC-RL-8: 判定の複製を作らない）。
  // 既に有効な Cookie を持っているなら回復は不要——**チャレンジトークンを消費させない。**
  const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, now)

  const result = await issueFormSession({
    clientIp: resolveClientIp(request),
    limiter: issueLimiter,
    secret,
    hasVerifiedSession: presented !== null && !isFormSessionRenewable(presented, now),
    // ★ **検証が通ったトークンだけ**を渡す。同一トークンの 2 回目以降は
    //   `issueFormSession` 側で「未通過」として扱われる（増幅率 1 / REV-P3C1-002）。
    challengeToken: typeof captchaToken === 'string' ? captchaToken : undefined,
  })

  if (!result.issued) {
    // `already-verified`（回復不要）も `rate-limited` も、利用者から見れば
    // 「そのまま使ってよい」なので 200 を返す。**Cookie は発行しない。**
    return Response.json({ ok: true }, { status: 200 })
  }

  const response = Response.json({ ok: true }, { status: 200 })
  const attributes = result.attributes
  response.headers.append(
    'set-cookie',
    `${result.cookieName}=${result.cookieValue}; Max-Age=${attributes.maxAge}; Path=${attributes.path}; SameSite=Lax; Secure; HttpOnly`,
  )
  return response
}, {
  // ⚠️ **`applications` と分ける**（MF-3）。同じ値にすると回復要求が
  // **申込送信と同じ発信元軸・同じセマフォ**を消費する——`trusted` では発信元軸が
  // 5 回/10 分の硬いゲートなので、**「回復を試みたせいで申込そのものが 429 になる」**という
  // 直そうとした欠陥（SEC-067）と同型の経路ができる。
  endpoint: 'form-session',
  requireContentType: 'json',
  limiters: {
    // Tier D 軸を**ゼロにしない**。ここが空だと、この経路は
    // **Turnstile の siteverify（外部 API）を無制限に叩ける入口**になる
    //（当校の Turnstile クォータと Cloudflare への往復を第三者が自由に消費できる）。
    source: recoverySourceLimiter,
    formSession: recoveryFormSessionLimiter,
  },
  formSessionKey: formSessionAxisKey,
  /*
   * ⚠️ **Cookie の「存在」だけを見る。3 つの選択肢のうちこれだけが成立する。**
   *
   *  (a) 渡さない（`undefined`）
   *      → `lib/public-guard.ts` の条件1'-3 `if (!resolved.trusted && !verifyFormSession)` により
   *        **縮退構成（= SEC-067 が成立する唯一の構成）で回復経路の全リクエストが Tier B** になる。
   *        「回復経路を作ったが、回復が必要な構成では 1 度も使えない」
   *        ——**直そうとした欠陥（抜けられないループ）を回復経路自身が再現する。**
   *
   *  (b) `verifyFormSessionValue` を使う（uploads と同じ形）
   *      → **印の付いた Cookie が弾かれる。** 回復を必要としているのはまさにその人たちなので、
   *        **回復できる人が誰もいなくなる。** uploads の契約を機械的に横展開するとこうなる。
   *
   *  (c) **本実装: Cookie の存在だけを見て、印の有無は見ない。**
   *
   * ⚠️ **`() => true` にしてはならない**（CR-001 / 一度そう実装して差し戻された）。
   * `formSessionKey` は Cookie 無しで `null` を返すので **formSession 軸が作られず**、
   * 発信元軸は縮退では計数のみである。したがって `() => true` は
   * **Cookie を持たない要求に対して enforce される Tier D 軸が 1 つも無い公開変更系エンドポイント**を
   * 作る——その 1 リクエストごとに `verifyTurnstile`（Cloudflare siteverify への外部往復）が走るので、
   * **MF-3 で塞いだはずの穴（siteverify を無制限に叩かせる）がそのまま開く。**
   *
   * **Cookie を要求しても正規の回復導線は 1 つも壊れない**——
   * 印は発行時に Cookie へ焼かれるものなので、**回復を必要とする利用者は必ず Cookie を持っている。**
   * Cookie を持たない利用者は `GET /api/form-session` で新しい Cookie を得れば済み、
   * そもそも回復経路を通る理由が無い。
   */
  verifyFormSession: (req) => readFormSessionCookie(req) !== null,
  semaphore: recoverySemaphore,
  clientIp: (req) => resolveClientIp(req),
  logger: recoveryLogger,
})
