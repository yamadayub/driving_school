import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { FORM_SESSION_FREE_ISSUE_LIMIT } from '@/lib/form-session-issue'
import { MIN_SUBMISSION_INTERVAL_MS } from '@/lib/spam-signals'

/**
 * =========================================================================
 * P3-c2 — **SEC-067 の回復経路（`challengeToken`）の結線**
 *          （P3-c1 から明示的に繰り越した Must）
 * =========================================================================
 *
 * 出典: `docs/phase-status.md`「P3-c2 の完了条件（申し送り）」1、
 *       `docs/review-p3c1-code-re-2026-07-29.md` §5-1、
 *       `docs/test-design-p3c1-2026-07-29.md` §12.3。
 *
 * ## なぜ P3-c2 で閉じなければならないのか（原文）
 * > 自己維持は「**印付き利用者が回復できる**」ようになって初めて切れる——
 * > `hasVerifiedSession` では原理的に切れないことが実測で確定した。
 * > `uploads` は同じ Tier B 判定（`verifyFormSessionValue`）を使うため。
 *
 * P3-c1 は「有効な Cookie を持つ再訪には発行しない」を結線したが、
 * **印の付いた Cookie を持つ利用者は `verifyFormSessionValue` が `null` を返す**ので
 * `hasVerifiedSession` は false になり、再発行が続く（＝ 枠を消費し続ける）。
 * **印から抜ける唯一の道が `challengeToken` であり、それが結線されるまで
 * SEC-067 の自己維持は切れない。**
 *
 * `uploads` は最も機微なデータ（免許証画像）を扱い、
 * **申込フォームより滞在時間が長い**（再監査 §5 申し送り 1）。
 * 印に落ちた利用者が回復できないままだと、写真を選び直すたびに Tier B に当たる。
 *
 * ## red 理由
 * `POST /api/form-session`（回復経路）が存在しない。
 * `app/api/form-session/route.ts` は `GET` しか export していない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // app/api/form-session/route.ts
 * export const POST = withPublicMutation(async (request) => {
 *   const { captchaToken } = await request.json()
 *   // **サーバー側で検証する。** クライアントの自己申告を信じない（P3-c1 §12.2-3）。
 *   const passed = await verifyTurnstile(captchaToken, { secret: ... })
 *   if (!passed) return tierB()
 *   const result = await issueFormSession({
 *     ...,
 *     challengeToken: String(captchaToken),   // ★ 検証が通ったトークンだけを渡す
 *   })
 *   // 印の無い Cookie を Set-Cookie して 200
 * }, { endpoint: 'applications', requireContentType: 'json', ...共通ラッパ })
 * ```
 *
 * ## ⚠️ 実行前提
 * - dev DB（`scripts/dev-db.sh up` / :5433）が稼働していること。
 * - 本ファイルは `VERCEL` を設定しない（＝ **縮退構成**）。SEC-067 は縮退でのみ成立する。
 * - 送信間隔下限（AC-RL-6 / 3 秒）があるため実時間を 1 度だけ待つ。
 */

/** 外部 I/O だけを差し替える（アプリのロジックは本物を通す）。 */
vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(async () => true) }))
vi.mock('@/lib/mail', () => ({ sendMail: vi.fn(async () => {}) }))

const ORIGIN = 'http://localhost:3000'

let formSessionRoute: typeof import('@/app/api/form-session/route')
let applicationsRoute: typeof import('@/app/api/applications/route')
let turnstile: typeof import('@/lib/turnstile')
let cookieName: string

const createdIdempotencyKeys: string[] = []

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET ??= 'integration-form-session-secret-32chars'
  delete process.env.VERCEL // 縮退構成であることを明示する
  const formSession = await import('@/lib/form-session')
  cookieName = formSession.FORM_SESSION_COOKIE_NAME
  turnstile = await import('@/lib/turnstile')
  formSessionRoute = await import('@/app/api/form-session/route')
  applicationsRoute = await import('@/app/api/applications/route')
})

afterAll(async () => {
  if (createdIdempotencyKeys.length > 0) {
    await prisma.application.deleteMany({
      where: { idempotencyKey: { in: createdIdempotencyKeys } },
    })
  }
  await prisma.$disconnect()
})

function extractCookieValue(response: Response): string | null {
  const raw = response.headers.getSetCookie?.() ?? []
  const list = raw.length > 0 ? raw : [response.headers.get('set-cookie') ?? '']
  for (const entry of list) {
    const match = entry.match(new RegExp(`${cookieName}=([^;]*)`))
    if (match && match[1].length > 0) return match[1]
  }
  return null
}

/** 無コスト枠を使い切る（第三者の攻撃。10 リクエスト / 10 分）。 */
async function exhaustFreeQuota(): Promise<void> {
  for (let n = 0; n < FORM_SESSION_FREE_ISSUE_LIMIT + 2; n++) {
    await formSessionRoute.GET(new Request(`${ORIGIN}/api/form-session`, { method: 'GET' }))
  }
}

/** 現在の（印の付いた）Cookie を 1 枚取る。**回復要求はこれを提示する。** */
async function currentCookie(): Promise<string> {
  const value = extractCookieValue(
    await formSessionRoute.GET(new Request(`${ORIGIN}/api/form-session`, { method: 'GET' })),
  )
  expect(value, '発行そのものが止まっている').not.toBeNull()
  return value!
}

/**
 * 回復経路: チャレンジを通して印の無い Cookie を得る。
 *
 * ⚠️ **Cookie を必ず提示する（CR-001）。**
 * 承認済みの契約は `verifyFormSession: (req) => readFormSessionCookie(req) !== null`
 * ——Cookie の**存在**を見る（印の有無は見ない）。
 *
 * 初版はここで Cookie を送らずに 200 を期待していた。その結果、
 * **契約どおりに実装すると本テストが赤くなる**ため、
 * Impl は `verifyFormSession: () => true` という契約違反の実装を選ばざるを得なくなった
 *（`docs/review-p3c2-code-2026-07-29.md` CR-001）。
 * **テストが実装に契約違反を選ばせた**という、最も避けたい形である。
 *
 * 実際の回復フローでも要求元は Cookie を持っている——
 * 印が付くのは `GET /api/form-session` で Cookie を受け取った後だからである。
 */
async function recover(captchaToken: string, cookieValue: string): Promise<Response> {
  const post = (formSessionRoute as { POST?: (r: Request) => Promise<Response> }).POST
  expect(post, 'POST /api/form-session（回復経路）が未実装').toBeTypeOf('function')
  return post!(
    new Request(`${ORIGIN}/api/form-session`, {
      method: 'POST',
      headers: new Headers({
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: `${cookieName}=${cookieValue}`,
      }),
      body: JSON.stringify({ captchaToken }),
    }),
  )
}

function inquiryBody(): Record<string, unknown> {
  const idempotencyKey = randomUUID()
  createdIdempotencyKeys.push(idempotencyKey)
  return {
    type: 'INQUIRY',
    idempotencyKey,
    name: '回復 太郎',
    nameKana: 'カイフク タロウ',
    birthDate: '2000-05-05',
    email: `recover-${idempotencyKey}@example.com`,
    phone: '090-1234-5678',
    firstTime: true,
    referralSources: [],
    message: 'SEC-067 の回復経路',
    privacyConsent: true,
    captchaToken: 'ts-token',
    hp_field: '',
  }
}

async function submit(cookieValue: string): Promise<Response> {
  return applicationsRoute.POST(
    new Request(`${ORIGIN}/api/applications`, {
      method: 'POST',
      headers: new Headers({
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: `${cookieName}=${cookieValue}`,
      }),
      body: JSON.stringify(inquiryBody()),
    }),
    undefined as never,
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* ========================================================================= *
 * SEC-067: 印から抜けられること（本番 2 ルート跨ぎ）
 * ========================================================================= */

describe('SEC-067: 印に落ちた利用者がチャレンジを通して回復できる（本番経路）', () => {
  it('枠を使い切った後の新規来訪者は Tier B に落ちる（前提の再現）', async () => {
    // 前提が実際に成立していることを先に測る。
    // **これが成立しないと、この後の「回復できる」に意味が無い**
    //（P3-c1 の教訓: 前提を測らないテストは空振りする）。
    await exhaustFreeQuota()
    const marked = extractCookieValue(
      await formSessionRoute.GET(new Request(`${ORIGIN}/api/form-session`, { method: 'GET' })),
    )
    expect(marked, '発行そのものが止まっている').not.toBeNull()

    await sleep(MIN_SUBMISSION_INTERVAL_MS + 300)
    const response = await submit(marked!)
    expect(response.status, '前提が変わった（印が付いていない）').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
  })

  it('チャレンジを通すと印の無い Cookie が発行され、送信が 201 に到達する', async () => {
    // **本ファイルで最も重要なテスト。SEC-067 の回復経路そのものである。**
    // これが green なら排除される事故: 未認証の第三者が 10 リクエスト / 10 分を送るだけで、
    // 縮退構成のサイトの申込フォームと**免許証写真アップロードを恒久的に使用不能**にできること。
    // `lib/public-guard.ts:160-165` が 413 について自ら禁じた
    // 「CAPTCHA を解いて再送しても同じ応答が返る**抜けられないループ**」と同型である。
    const recovered = await recover(`ts-recover-${randomUUID()}`, await currentCookie())
    expect(recovered.status, `回復経路が失敗した（status=${recovered.status}）`).toBe(200)

    const value = extractCookieValue(recovered)
    expect(value, '回復経路が Cookie を発行していない').not.toBeNull()

    await sleep(MIN_SUBMISSION_INTERVAL_MS + 300)
    const submitted = await submit(value!)
    expect(submitted.status, '回復した Cookie でも Tier B のまま').toBe(201)
  })

  it('Turnstile 検証に失敗した要求は回復させない（Tier B のまま）', async () => {
    // 回復経路が**無条件の抜け道**になっていないこと。
    // これが green なら排除される攻撃: `POST /api/form-session` を叩くだけで
    // **無コスト枠を無限にリセットできる**こと（SEC-057 の再来）。
    vi.mocked(turnstile.verifyTurnstile).mockResolvedValueOnce(false)

    const response = await recover(`ts-invalid-${randomUUID()}`, await currentCookie())
    expect(response.status, 'チャレンジ未通過でも回復できてしまう').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(extractCookieValue(response), '未検証なのに Cookie を発行している').toBeNull()
  })

  it('同じトークンでの 2 回目は回復できない（増幅率 1 / REV-P3C1-002）', async () => {
    // P3-c1 §12.3 が結合テストの要件として明記した項目:
    // > §12.3 の結合テスト（P3-c2 で足す 1 本）の要件に
    // > 「**同じトークンで 2 度目は回復できない**」を含めること
    //
    // これが green なら排除される攻撃: 1 回 CAPTCHA を解いたトークンを使い回して
    // **印の無い Cookie を無制限に量産する**こと（回復経路のコストが割り算で消える）。
    const token = `ts-reuse-${randomUUID()}`
    const cookie = await currentCookie()

    const first = await recover(token, cookie)
    expect(first.status).toBe(200)
    expect(extractCookieValue(first)).not.toBeNull()

    const second = await recover(token, cookie)
    const secondValue = extractCookieValue(second)
    if (secondValue !== null) {
      // 発行されたとしても、それは**印の付いた**Cookie でなければならない。
      await sleep(MIN_SUBMISSION_INTERVAL_MS + 300)
      const submitted = await submit(secondValue)
      expect(submitted.status, '同じトークンの 2 回目でも回復できてしまう').toBe(403)
    } else {
      expect(second.status).not.toBe(200)
    }
  })

  it('Cookie を持たない回復要求は Tier B（契約の裏面 / CR-001）', async () => {
    // **この pin が無かったために、Impl は `verifyFormSession: () => true` を選べてしまった。**
    //
    // 承認済み契約は「Cookie の**存在**を見る」である。したがって Cookie を持たない要求は
    // Tier B へ落ちる——先に `GET /api/form-session` を通らせるためであり、
    // 縮退構成で **Tier D 軸がゼロの公開エンドポイント**（Turnstile の siteverify を
    // 無制限に叩ける入口）を作らないための条件でもある。
    //
    // ⚠️ **これは「Cookie をブロックしている利用者を切り捨てる」ことを意味しない。**
    // その利用者は `GET` でも Cookie を保持できないので、回復以前に申込自体が
    // 別の導線（RV-P3B-009 の電話番号表示）へ落ちる設計になっている。
    const post = (formSessionRoute as { POST?: (r: Request) => Promise<Response> }).POST
    expect(post).toBeTypeOf('function')

    const response = await post!(
      new Request(`${ORIGIN}/api/form-session`, {
        method: 'POST',
        headers: new Headers({ origin: ORIGIN, 'content-type': 'application/json' }),
        body: JSON.stringify({ captchaToken: `ts-nocookie-${randomUUID()}` }),
      }),
    )

    expect(response.status, 'Cookie 無しの要求が回復できている（軸ゼロの経路）').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
  })

  it('回復経路も公開変更系ラッパを通る（Origin 検証 / Content-Type）', async () => {
    // 新しい公開変更系エンドポイントを**ラッパ無しで**作らないこと（SEC-037）。
    const post = (formSessionRoute as { POST?: (r: Request) => Promise<Response> }).POST
    expect(post).toBeTypeOf('function')

    const crossOrigin = await post!(
      new Request(`${ORIGIN}/api/form-session`, {
        method: 'POST',
        headers: new Headers({ origin: 'https://evil.test', 'content-type': 'application/json' }),
        body: JSON.stringify({ captchaToken: 'ts-token' }),
      }),
    )
    expect(crossOrigin.status, 'クロスオリジンの要求を受け付けている').toBe(403)
    // **`challenge` を含まない 403**（契約ルール7: Origin 検証失敗は Tier B ではない）。
    expect(await crossOrigin.json()).not.toHaveProperty('challenge')
  })
})
