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
  isFormSessionRenewable,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'

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
