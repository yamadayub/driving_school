import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  FORM_SESSION_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_WINDOW_MS,
} from '@/lib/form-session-issue'

/**
 * =========================================================================
 * P3-b 差し戻し — RV-P3B-004（AC-RL-13(c) の**配線**を検証するテストが無い）
 *                 + RV-P3B-007（発行枠の消費でページを奪わない）
 * =========================================================================
 *
 * 出典: `docs/review-p3b-code-2026-07-29.md` RV-P3B-004（:242）/ RV-P3B-007（:375）、
 *       `docs/review-p3b-tests-2026-07-29.md` §7（「Impl は配線後に『`/apply` を 31 回開くと 429』を
 *       E2E か結合で 1 本足すこと」= Impl への宿題）、`docs/functional-spec.md` §4.11 AC-RL-13(c)。
 *
 * ## この指摘は「テストの不在」そのものである
 * `tests/unit/form-session-issue.test.ts` が担保しているのは**判定ロジック**だけである。
 * 次の 4 点は**どれも固定されていなかった**:
 *  - Route Handler が `issueFormSession` を実際に呼んでいること
 *  - `issueLimiter` が正しい limit / window で構成されていること
 *  - 上限到達時の応答が待ち時間を伝えること
 *  - `/apply` からのリダイレクト連鎖が成立すること
 *
 * `scripts/verify-p3b.ts` の V-4 / V-4b は貴重な実測だが **CI で回らないので退行検知にならない**。
 *
 * ## ⚠️ 契約の解決（Test Agent の判断。Senior / Security へ明示的に申告する）
 * RV-P3B-004 は「31 回目が **429** + `retry-after`」と書き、
 * RV-P3B-007 は「上限到達時に**生 JSON の 429 を見せず** `/apply` へ 303 し、
 * ページと連絡先は必ず見せる」と書いている。**この 2 つは同じ応答について矛盾する。**
 *
 * 本ファイルは後者（RV-P3B-007）を採り、AC-RL-13(c) の**目的**で契約を書き直す:
 *
 * > AC-RL-13(c) が守るのは「**Cookie 軸をタダで増やせないこと**」であって
 * > 「利用者にエラーページを見せること」ではない。したがって上限到達の契約は
 * > **(1) Cookie を発行しない・(2) 待ち時間を `Retry-After` で伝える・(3) 利用者は `/apply` に到達できる**
 * > の 3 点であり、ステータスが 429 か 303 かは契約ではない。
 *
 * 発行の Tier D が「フォームに到達できない」に化けているのが RV-P3B-007 の指摘であり、
 * §4.11 のどの Tier も「ページが見られない」を含んでいない。
 *
 * ## 実行前提
 * dev DB は不要（本ファイルは DB を触らない）。`.env` は `tests/integration/setup.ts` が読み込む。
 */

const ORIGIN = 'http://localhost:3000'

type RouteModule = typeof import('@/app/api/form-session/route')
let route: RouteModule
let cookieName: string
let formSession: typeof import('@/lib/form-session')

const savedVercel = process.env.VERCEL

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET ??= 'integration-form-session-secret-32chars'
  formSession = await import('@/lib/form-session')
  cookieName = formSession.FORM_SESSION_COOKIE_NAME
  route = await import('@/app/api/form-session/route')
})

/** 署名済みの Cookie 値を作る（`unverified` の印は opt-in）。 */
function signedCookieValue(options: { ageMs?: number; unverified?: true } = {}): string {
  return formSession.createFormSessionValue(
    {
      sid: randomUUID().replace(/-/g, ''),
      issuedAt: Date.now() - (options.ageMs ?? 10_000),
      ...(options.unverified ? { unverified: true as const } : {}),
    },
    process.env.FORM_SESSION_SECRET ?? '',
  )
}

afterAll(() => {
  if (savedVercel === undefined) delete process.env.VERCEL
  else process.env.VERCEL = savedVercel
})

/**
 * `GET /api/form-session` を叩く。
 * `ip` を渡すと**通常構成**（`VERCEL=1` + `x-forwarded-for` = `trusted:true`）で、
 * 渡さないと**縮退構成**（`trusted:false`）で評価される。
 */
async function get(
  options: { ip?: string; query?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  if (options.ip) process.env.VERCEL = '1'
  else delete process.env.VERCEL

  const headers = new Headers(options.headers ?? {})
  if (options.ip) headers.set('x-forwarded-for', options.ip)
  return route.GET(
    new Request(`${ORIGIN}/api/form-session${options.query ?? ''}`, { method: 'GET', headers }),
  )
}

/** `Set-Cookie` に `__Host-fs` が含まれるか。 */
function issuesCookie(response: Response): boolean {
  const raw = response.headers.getSetCookie?.() ?? []
  const joined = raw.length > 0 ? raw.join('\n') : (response.headers.get('set-cookie') ?? '')
  return joined.includes(`${cookieName}=`) && !joined.includes(`${cookieName}=;`)
}

/** 利用者がフォームへ到達できる応答か（303 → `/apply`）。 */
function reachesApplyPage(response: Response): boolean {
  if (response.status !== 303 && response.status !== 307 && response.status !== 302) return false
  const location = response.headers.get('location')
  return location !== null && new URL(location, ORIGIN).pathname === '/apply'
}

/* ========================================================================= *
 * AC-RL-13(a): 発行の配線そのもの
 * ========================================================================= */

describe('RV-P3B-004 / AC-RL-13(a): GET /api/form-session が Cookie を発行して /apply へ戻す', () => {
  it('303 で /apply?fs=1 へ戻し、__Host-fs を Set-Cookie する', async () => {
    // これが green なら排除される状態: Route Handler が `issueFormSession` を呼んでいない、
    // あるいは `Set-Cookie` を落としていること。**Cookie が発行されなければ、
    // 縮退構成で唯一 enforce される Tier D 軸（Cookie 軸）が存在しなくなり、
    // 同時に全利用者の送信が Tier B になる**（防御と UX が同時に壊れる）。
    // ユニット（`form-session-issue.test.ts`）は判定ロジックしか見ていないので、
    // 「純関数は正しいがルートが呼んでいない」を検出できない。
    const response = await get({ ip: '198.51.100.11' })
    expect(reachesApplyPage(response), `location=${response.headers.get('location')}`).toBe(true)
    expect(issuesCookie(response), '__Host-fs が Set-Cookie されていない').toBe(true)
  })

  it('Cookie 属性が HttpOnly / Secure / SameSite=Lax / Path=/ を持つ', async () => {
    // AC-RL-13(a)。属性を 1 つ落とすと軸そのものが攻撃者の手に渡る
    //（HttpOnly 無し → XSS で `sid` 窃取 / SameSite=None → クロスサイトから軸を利用）。
    const response = await get({ ip: '198.51.100.12' })
    const header = (response.headers.getSetCookie?.() ?? []).join('\n')
    expect(header).toMatch(/HttpOnly/i)
    expect(header).toMatch(/Secure/i)
    expect(header).toMatch(/SameSite=Lax/i)
    expect(header).toMatch(/Path=\//i)
  })

  it('遷移先は /apply 固定で、引き継ぐのは type / courseId だけ（オープンリダイレクトを作らない）', async () => {
    // これが green なら排除される攻撃: `?next=https://evil.example` のような値を足して
    // **当校ドメインを踏み台にしたフィッシング誘導**を作ること。
    // 併せて AC-008-3（入力値を URL に載せない）も守る。
    const response = await get({
      ip: '198.51.100.13',
      query: '?type=APPLICATION&courseId=abc&next=https://evil.example&name=%E5%B1%B1%E7%94%B0',
    })
    const location = new URL(response.headers.get('location') ?? '', ORIGIN)
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname).toBe('/apply')
    expect(location.searchParams.get('type')).toBe('APPLICATION')
    expect(location.searchParams.get('courseId')).toBe('abc')
    expect(location.searchParams.get('next'), 'オープンリダイレクトの材料を引き継いでいる').toBeNull()
    expect(location.searchParams.get('name'), '入力値を URL に載せている').toBeNull()
  })
})

/* ========================================================================= *
 * AC-RL-13(c): 発行の流量制限が**ルート経由で**効く
 * ========================================================================= */

describe('RV-P3B-004 / AC-RL-13(c): 発行そのものを発信元軸で 30 回/10 分に制限する', () => {
  it('上限値の定数がルートの構成に使われている（limit / window の取り違えを防ぐ）', () => {
    expect(FORM_SESSION_ISSUE_LIMIT).toBe(30)
    expect(FORM_SESSION_ISSUE_WINDOW_MS).toBe(600_000)
  })

  it('30 回目までは発行し、31 回目は発行しない', async () => {
    // **AC-RL-13(c) は Tier D 設計全体の前提**である——「Cookie 軸をタダで無限に増やせない」。
    // ここが黙って無効化されると、縮退構成で残る唯一の enforce 軸（Cookie 軸）が意味を失う
    //（それが現に起きたのが SEC-057 である）。
    // これが green なら排除される退行: `issueLimiter` の store / limit / window を取り違え、
    // **ルートの発行が無制限になる**こと。純関数テストでは絶対に検出できない。
    const ip = '198.51.100.21'
    const issued: boolean[] = []
    for (let i = 0; i < FORM_SESSION_ISSUE_LIMIT + 1; i++) {
      issued.push(issuesCookie(await get({ ip })))
    }
    expect(issued.slice(0, FORM_SESSION_ISSUE_LIMIT).every(Boolean), '30 回目までに発行が止まった').toBe(
      true,
    )
    expect(issued[FORM_SESSION_ISSUE_LIMIT], '31 回目も Cookie を発行している').toBe(false)
  })

  it('上限到達の応答が Retry-After を持つ（待ち時間をサーバーが決める）', async () => {
    const ip = '198.51.100.22'
    let last: Response | null = null
    for (let i = 0; i < FORM_SESSION_ISSUE_LIMIT + 1; i++) last = await get({ ip })
    expect(issuesCookie(last!)).toBe(false)
    expect(last!.headers.get('retry-after'), 'Retry-After が無い（待ち時間が伝わらない）').toBeTruthy()
  })

  it('別の発信元は巻き添えにならない', async () => {
    const exhausted = '198.51.100.23'
    for (let i = 0; i < FORM_SESSION_ISSUE_LIMIT + 1; i++) await get({ ip: exhausted })
    expect(issuesCookie(await get({ ip: '203.0.113.77' }))).toBe(true)
  })

  it('縮退構成（trusted=false）では 40 回目も発行が続く', async () => {
    // **SEC-043 / SEC-021 と同型の欠陥を発行経路に持ち込まない。**
    // これが green なら排除される攻撃: 縮退構成で、第三者が 30 回フォームを開くだけで
    // **全利用者が `/apply` を開けなくなる**こと（共有 `unknown` バケットの枯渇が拒否になる）。
    // ⚠️ SEC-057 の修正でここを「発行を止める」に変えてはならない。
    //    課すべきコストは**回復可能なもの**であって、ページの封鎖ではない。
    const results: boolean[] = []
    for (let i = 0; i < 40; i++) results.push(issuesCookie(await get()))
    expect(results.every(Boolean), '縮退時の共有バケットが硬いゲートになっている').toBe(true)
  })
})

/* ========================================================================= *
 * RV-P3B-007: 発行制限が「ページを奪う」手段になっていない
 * ========================================================================= */

describe('RV-P3B-007: 発行枠の消費で利用者から /apply を奪わない', () => {
  it('上限到達時も利用者は /apply に到達できる（生 JSON を見せない）', async () => {
    // これが green なら排除される事故: 上限到達後の 10 分間、`/apply` を開いた利用者に
    // **フォームの代わりに `{"retryAfterMs":…}` という生 JSON が表示される**こと。
    // `/apply` は Cookie が無ければ `/api/form-session` へリダイレクトするので、
    // ここが JSON を返すと**フォームにも電話番号にも到達できない**。
    // 攻撃者がいなくても起きる: 本番（`trusted=true`）の発行枠は実 IP 単位なので、
    // **企業 NAT・学校・携帯キャリアの CGNAT 配下**では正規利用者だけで 30 回/10 分に届く
    //（対象が教習所＝若年層・モバイル比率が高いことを踏まえると無視できない）。
    // §4.11 のどの Tier も「ページが見られない」を含んでいない。
    const ip = '198.51.100.31'
    let last: Response | null = null
    for (let i = 0; i < FORM_SESSION_ISSUE_LIMIT + 1; i++) last = await get({ ip })

    expect(issuesCookie(last!), '上限到達後も Cookie を発行している（AC-RL-13(c) 未達）').toBe(false)
    expect(
      reachesApplyPage(last!),
      `上限到達時にフォームへ到達できない（status=${last!.status} / location=${last!.headers.get('location')}）`,
    ).toBe(true)
  })

  it('サブリソース経由（Sec-Fetch-Dest: image）の要求は発行枠を消費しない', async () => {
    // **これが green なら排除される攻撃**: 攻撃者のページが
    // `<img src="https://…/api/form-session">` を 31 個並べるだけで、
    // **被害者の IP に紐づく発行枠（30 回/10 分）を使い切れる**。
    // 本ルートは Origin 検証もナビゲーション判定も持たない**状態変更 GET** である。
    // 以後 10 分間、被害者は `/apply` を開いてもフォームに到達できない。
    const ip = '198.51.100.32'
    for (let i = 0; i < FORM_SESSION_ISSUE_LIMIT + 5; i++) {
      await get({ ip, headers: { 'sec-fetch-dest': 'image', 'sec-fetch-site': 'cross-site' } })
    }
    const navigation = await get({
      ip,
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' },
    })
    expect(
      issuesCookie(navigation),
      '第三者ページのサブリソース要求で、正規利用者の発行枠が使い切られている',
    ).toBe(true)
  })

  it('クロスサイトのサブリソース要求には Cookie を発行しない', async () => {
    // 枠を消費しないことと、Cookie を渡さないことの両方が要る。
    // `<img>` 経由で `__Host-fs` を配ると、**攻撃者が被害者のブラウザに任意のタイミングで
    // 軸を作らせられる**（発行時刻 = `issuedAt` が攻撃者の制御下に入り、AC-RL-6 の
    // 送信間隔下限を事前に満たしておける）。
    const response = await get({
      ip: '198.51.100.33',
      headers: { 'sec-fetch-dest': 'image', 'sec-fetch-site': 'cross-site' },
    })
    expect(issuesCookie(response), 'サブリソース要求に Cookie を発行している').toBe(false)
  })
})

/* ========================================================================= *
 * P3-c1 / **NEW-001**: SEC-067 の「自己維持の切断」を**本番ルートで**測る
 * ========================================================================= *
 *
 * 出典: `docs/review-p3c1-tests-re-2026-07-29.md` NEW-001（Must Fix）。
 *
 * ## なぜルートまで測るのか（**本単位の判断**）
 * `tests/unit/form-session-degraded-recovery.test.ts` は
 * `issueFormSession` の契約（`hasVerifiedSession` なら発行しない）を固定したが、
 * **ルートがそれを渡さなければ本番では常に `undefined`** ＝ 自己維持の切断は 1 ミリも効かない。
 * 再監査の指摘そのもの:
 *
 * > `hasVerifiedSession` を参照しているのは 1 ファイルだけで、**結線を測るテストが 1 件も無い。**
 * > これは「受け口が在るから結線済みと読める」で 1 度事故を起こした形（RV-P3B-001）と同じである。
 *
 * SEC-067 の増幅要因（`/apply` を開くたびに再発行して枠を消費する）は
 * **`app/(public)/apply/page.tsx` → `GET /api/form-session` という本番の遷移でしか起きない**。
 * したがって正典関数の契約だけでは「閉じた」と言えない。
 *
 * ## スコープの線引き（回復経路はここに含めない）
 * **`challengeToken`（回復経路）の結線は P3-c2** に置く（設計文書 §12.3）。
 * 自己維持の切断は UI に依存しないが、回復経路は UI の導線（Turnstile ウィジェットの表示・
 * 再送のタイミング）と一体で決まるためである。
 *
 * ## Impl が実装すべきこと（`app/api/form-session/route.ts`）
 * ```ts
 * const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, Date.now())
 * const result = await issueFormSession({ ..., hasVerifiedSession: presented !== null })
 * if (!result.issued) {
 *   const response = NextResponse.redirect(target, 303)
 *   // ⚠️ `reason` で分岐する。`already-verified` に Retry-After を付けない（待つ必要が無い）。
 *   if (result.reason === 'rate-limited') response.headers.set('retry-after', ...)
 *   return response
 * }
 * ```
 * **現行の :124-133 は `!result.issued` で `result.retryAfterMs` を無条件に読む**ため、
 * 判別可能 union の導入で `pnpm type-check` が落ちる（silent には壊れない）。
 */

describe('NEW-001 / SEC-067: 有効な Cookie を持つ再訪には新しい Cookie を発行しない（結線）', () => {
  it('有効な Cookie を提示した要求は Set-Cookie を持たず、それでも /apply へ到達する', async () => {
    // **本 describe で最も重要なテスト。**
    // これが green なら排除される事故: 利用者が `/apply` を開くたびに新しい Cookie が発行され、
    // **被害者自身の再試行が無コスト枠（10 枚/10 分）を食い潰してロックアウトを自己維持する**こと。
    // 実測の傍証: `docs/impl-p3b-fix2-notes-2026-07-29.md` §4 が、E2E の通常操作だけで
    // `/apply` への遷移が窓内 23 回に達したと報告している（**通常利用で日常的に枠を超える**）。
    //
    // ⚠️ 発行しないことと、ページに到達させないことは**別**である。
    // `Set-Cookie` が無くても 303 で `/apply` へ戻すこと（利用者の導線は一切変わらない）。
    const response = await get({ headers: { cookie: `${cookieName}=${signedCookieValue()}` } })

    expect(
      issuesCookie(response),
      '有効な Cookie を持つ再訪に新しい Cookie を発行している（自己維持が切れていない）',
    ).toBe(false)
    expect(
      reachesApplyPage(response),
      `フォームへ到達できない（status=${response.status} / location=${response.headers.get('location')}）`,
    ).toBe(true)
  })

  it('Cookie を持たない要求には従来どおり Set-Cookie する（初回訪問を壊さない）', async () => {
    // これが green なら排除される「行き過ぎた修正」: 発行を止めすぎて
    // **初回訪問者が Cookie を得られず、全送信が Tier B になる**こと
    //（RV-P3B-001 と同じ「機能不成立」）。
    expect(issuesCookie(await get()), '初回訪問者に Cookie が発行されない').toBe(true)
  })

  it('already-verified の応答に Retry-After を付けない（待つ必要が無い）', async () => {
    // `Retry-After` は「待てば回復する」ことを意味する。既に有効な Cookie を持つ利用者に
    // 付けると意味が反転し、クライアント側の再試行制御が誤作動する。
    // 上限到達（`rate-limited`）とは**別の理由**であることを応答の形でも保つ。
    const response = await get({ headers: { cookie: `${cookieName}=${signedCookieValue()}` } })
    expect(response.headers.get('retry-after')).toBeNull()
  })

  it('印の付いた（unverified）Cookie を持つ要求には発行する（回復の妨げにしない）', async () => {
    // **`hasVerifiedSession` は「Cookie を持っているか」ではなく「有効な Cookie を持っているか」である。**
    // 印の付いた Cookie は `verifyFormSessionValue` が `null` を返す（＝ 無効）ので、
    // 発行を止めてはならない。止めると印の付いた利用者が**新しい Cookie を永久に得られず**、
    // SEC-067 のロックアウトが**恒久化**する（直そうとした欠陥を悪化させる）。
    const marked = signedCookieValue({ unverified: true })
    expect(
      issuesCookie(await get({ headers: { cookie: `${cookieName}=${marked}` } })),
      '印の付いた Cookie の保持者に発行していない（ロックアウトが恒久化する）',
    ).toBe(true)
  })

  it('期限切れ・壊れた Cookie を持つ要求にも発行する（fail-open で発行側へ倒す）', async () => {
    // Cookie が壊れる経路は攻撃だけではない（鍵ローテーション・途中切断・古い端末）。
    // 判定に迷ったら**発行する**側へ倒す——発行しない側へ倒すと、
    // 壊れた Cookie を持つ利用者が回復不能になる。
    const expired = signedCookieValue({ ageMs: (formSession.FORM_SESSION_MAX_AGE_SEC + 60) * 1000 })
    expect(issuesCookie(await get({ headers: { cookie: `${cookieName}=${expired}` } }))).toBe(true)
    expect(issuesCookie(await get({ headers: { cookie: `${cookieName}=not-a-valid-value` } }))).toBe(
      true,
    )
  })

  it('失効間近の Cookie を提示した要求には再発行する（更新窓 / NEW-003 / RE2-001）', async () => {
    // **RE2-001**（`docs/review-p3c1-tests-re2-2026-07-29.md` §6 / Senior 申し送り 1）。
    // NEW-003 は `isFormSessionRenewable` という**正典関数の契約**を単体で 4 件固定したが、
    // **ルートがそれを呼ぶことを測るテストが無かった。**
    // 上の 6 件は「有効（更新不要）」「印付き」「期限切れ」「壊れた値」「無し」を覆っているが、
    // **「有効だが失効間近」という 5 つ目の状態だけが抜けている**ため、ルートが
    // `hasVerifiedSession: presented !== null`（更新窓を見ない）と実装しても全て green のまま通る。
    // NEW-001 で指摘された「受け口が呼ばれることを測っていない」と**同じ型**である。
    //
    // ⚠️ この 1 件は**現時点で green** になる（ルートは正しく更新窓を見ている）。red にはならないが、
    // 「更新窓を見ない実装」を将来にわたって捕捉する pin としては有効である
    //（対になる :309「更新不要な Cookie → 発行しない」と併せて 2 件で挟む形になっている）。
    const nearExpiry = signedCookieValue({
      ageMs:
        formSession.FORM_SESSION_MAX_AGE_SEC * 1000 -
        formSession.FORM_SESSION_RENEW_BEFORE_MS +
        60_000,
    })
    expect(
      issuesCookie(await get({ headers: { cookie: `${cookieName}=${nearExpiry}` } })),
      '失効間近の Cookie が更新されない（30 分で入力途中の利用者が Tier B に落ちる）',
    ).toBe(true)
  })

  it('通常構成（trusted=true）でも同じ（発行枠の節約は縮退限定の最適化ではない）', async () => {
    // 自己維持の切断は縮退構成の SEC-067 が動機だが、**通常構成でも枠は有限**である
    //（`RV-P3B-007`: 企業 NAT・CGNAT 配下では正規利用者だけで 30 回/10 分に届く）。
    // 構成で分岐させると、分岐そのものが次の欠陥の温床になる。
    const response = await get({
      ip: '198.51.100.41',
      headers: { cookie: `${cookieName}=${signedCookieValue()}` },
    })
    expect(issuesCookie(response)).toBe(false)
    expect(reachesApplyPage(response)).toBe(true)
  })
})
