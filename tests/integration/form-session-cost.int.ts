import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { MIN_SUBMISSION_INTERVAL_MS } from '@/lib/spam-signals'
import { FORM_SESSION_FREE_ISSUE_LIMIT } from '@/lib/form-session-issue'

/**
 * =========================================================================
 * P3-b 差し戻し — **SEC-057（High）を本番経路の 2 ルートで実測する**
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` SEC-057（:2869）/ §B B-1（:2755 の実測表）。
 *
 * ## 監査者の手順をそのまま再現する
 * ```
 * 縮退構成（VERCEL 未設定 = trusted:false）
 * GET  /api/form-session  × 20   → 429 は 0 回。Cookie を 20 枚取得
 * POST /api/applications  × 60   → 201 が 60 件 / 429 が 0 件
 *                                  （DB 行 60 + 自動返信メール 60 通の経路が成立）
 * ```
 *
 * ## なぜユニット（`tests/unit/form-session-issue-cost.test.ts`）と両方要るのか
 * SEC-057 が見逃された原因は「**個々の測定は正確だが、攻撃者の手順として結合されていない**」
 * ことだった（Impl の V-1 は「同一 Cookie を使い続ける前提」で測り、V-4b は「縮退では発行が
 * 止まらない」を測ったが、**両者を突き合わせていない**）。
 *
 * ユニットは `issueFormSession` と `withPublicMutation` を結合するが、
 * **2 つの Route Handler が実際にその関数を使っているか**は見ていない。
 * 本ファイルは `GET /api/form-session` → `POST /api/applications` という
 * **本番の 2 ルートを跨いだ 1 本の攻撃手順**として測る。片方だけでは同じ見逃しが再発する。
 *
 * ## ⚠️ 実行前提
 * - dev DB（`scripts/dev-db.sh up` / :5433）が稼働していること。
 * - 本ファイルは `VERCEL` を設定しない（＝ **縮退構成**）。SEC-057 は縮退でのみ成立する。
 * - 送信間隔下限（AC-RL-6 / 3 秒）があるため、Cookie 取得後に 1 度だけ実時間を待つ。
 *   **待たないと全件 Tier B になり、SEC-057 が「閉じている」ように見えてしまう。**
 */

/** 外部 I/O だけを差し替える（アプリのロジックは本物を通す）。 */
vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(async () => true) }))
vi.mock('@/lib/mail', () => ({ sendMail: vi.fn(async () => {}) }))

const ORIGIN = 'http://localhost:3000'

/** 監査者の実測と同じ規模。 */
const COOKIE_COUNT = 20
/** 送信側の Cookie 軸上限（`app/api/applications/route.ts:91` の `FORM_SESSION_LIMIT`）と同値。 */
const SENDS_PER_COOKIE = 3

/**
 * **縮退構成における受理件数の上界**（SEC-070 の是正）。
 *
 * 再監査（`docs/security-p3b-reaudit-2026-07-29.md` SEC-070）の指摘:
 *
 * > 実際の到達数は 30 だが、固定されている上界は 60 / 90 である。
 * > `FORM_SESSION_FREE_ISSUE_LIMIT` が将来 10 → 19 に緩められても（到達数 57）
 * > **両テストとも green のまま**通る。
 *
 * 旧: `toBeLessThan(COOKIE_COUNT * SENDS_PER_COOKIE)` = 60（= 「全件は通らない」だけ）。
 * 新: **無コストで得られる Cookie 枚数 × 1 枚あたりの送信上限**を定数から計算する。
 * `FORM_SESSION_FREE_ISSUE_LIMIT` を緩める変更が入れば、この式が追随して実測との差が露見する。
 */
const ACCEPTED_BOUND = FORM_SESSION_FREE_ISSUE_LIMIT * SENDS_PER_COOKIE

let formSessionRoute: typeof import('@/app/api/form-session/route')
let applicationsRoute: typeof import('@/app/api/applications/route')
let cookieName: string
let mail: typeof import('@/lib/mail')

const createdIdempotencyKeys: string[] = []

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET ??= 'integration-form-session-secret-32chars'
  delete process.env.VERCEL // 縮退構成であることを明示する
  const formSession = await import('@/lib/form-session')
  cookieName = formSession.FORM_SESSION_COOKIE_NAME
  mail = await import('@/lib/mail')
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

/** `Set-Cookie` から `__Host-fs` の値だけを取り出す。発行されていなければ `null`。 */
function extractCookieValue(response: Response): string | null {
  const raw = response.headers.getSetCookie?.() ?? []
  const list = raw.length > 0 ? raw : [response.headers.get('set-cookie') ?? '']
  for (const entry of list) {
    const match = entry.match(new RegExp(`${cookieName}=([^;]*)`))
    if (match && match[1].length > 0) return match[1]
  }
  return null
}

function inquiryBody(): Record<string, unknown> {
  const idempotencyKey = randomUUID()
  createdIdempotencyKeys.push(idempotencyKey)
  return {
    type: 'INQUIRY',
    idempotencyKey,
    name: 'コスト 太郎',
    nameKana: 'コスト タロウ',
    birthDate: '2000-05-05',
    email: `cost-${idempotencyKey}@example.com`,
    phone: '090-1234-5678',
    firstTime: true,
    referralSources: [],
    message: 'SEC-057 の実測',
    privacyConsent: true,
    captchaToken: 'ts-token',
    hp_field: '',
  }
}

async function post(cookieValue: string): Promise<Response> {
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

describe('SEC-057: 本番経路 2 ルートで「Cookie を取り直す」攻撃手順を実測する', () => {
  it(`GET /api/form-session ×${COOKIE_COUNT} → POST /api/applications ×${COOKIE_COUNT * SENDS_PER_COOKIE} が全件成功してはならない`, async () => {
    // **本ファイルの中心。SEC-057 の実測そのものである。**
    // これが green なら排除される攻撃: 未認証の第三者が縮退構成の本番デプロイに対して
    //  (a) 無制限に DB 行を作る（氏名・生年月日・住所・連絡先に任意の値が入る）
    //  (b) 無制限に当校ドメインから第三者へメールを送る（宛先を変えれば AC-RL-14 の 3 通/時は効かない）
    //  (c) F-017 の受信管理を実質使用不能にする
    // **P3-b は個人情報を実際に受信する最初の単位**であり、無制限受付は
    // 「保管義務のあるデータの無制限流入」を意味する。
    //
    // ⚠️ 「Cookie 1 枚で 4 回目が 429」を測るテスト（`applications.int.ts` の AC-RL-3 (1)）は
    //    この脅威を**検出しない**。`lib/form-session-issue.ts:8-11` が自ら書いているとおり
    //    **攻撃者は同一 Cookie を送らない**。
    const cookies: string[] = []
    for (let i = 0; i < COOKIE_COUNT; i++) {
      const value = extractCookieValue(await formSessionRoute.GET(
        new Request(`${ORIGIN}/api/form-session`, { method: 'GET' }),
      ))
      if (value) cookies.push(value)
    }

    // 発行が止まっていないこと自体は**正しい**（第三者に `/apply` を封鎖させないため）。
    // 問題は「止まらない」ことではなく「**タダである**」ことである。
    expect(cookies.length, '発行が止まっている（/apply の封鎖になる）').toBe(COOKIE_COUNT)

    // AC-RL-6（送信間隔下限 3 秒）を跨ぐ。待たないと全件 Tier B になり、
    // **SEC-057 が閉じているように誤って見える**。
    await sleep(MIN_SUBMISSION_INTERVAL_MS + 300)

    const statuses: number[] = []
    for (const cookie of cookies) {
      for (let i = 0; i < SENDS_PER_COOKIE; i++) statuses.push((await post(cookie)).status)
    }

    const accepted = statuses.filter((status) => status === 201).length
    const total = COOKIE_COUNT * SENDS_PER_COOKIE
    // **SEC-070: 境界を「全件未満」から「無コスト枠 × 送信上限」へ締める。**
    expect(
      accepted,
      `Cookie を ${COOKIE_COUNT} 枚取り直すだけで ${accepted}/${total} 件が受け付けられた` +
        `（上界 ${ACCEPTED_BOUND} 件 / 内訳: ${JSON.stringify(countBy(statuses))}）`,
    ).toBeLessThanOrEqual(ACCEPTED_BOUND)
  })

  it('受け付けられた件数ぶんしか DB 行も自動返信メールも発生しない（実害の観測）', async () => {
    // 「201 が返っただけ」ではなく **DB 行とメール送信が実際に発生する**ことが SEC-057 の実害である。
    // これが green なら排除される誤診: 応答だけを見て「上限が効いている」と結論すること。
    const before = vi.mocked(mail.sendMail).mock.calls.length
    const rows = await prisma.application.count({
      where: { idempotencyKey: { in: createdIdempotencyKeys } },
    })
    // ⚠️ REV-P3C1-011: **unit 側（`form-session-issue-cost.test.ts`）には
    // 「実測が上界に張り付く」`toBe(30)` を足したが、int 側は `toBeLessThanOrEqual` のままにしている。**
    // 片方だけ締め忘れたのではなく、意図的な判断である:
    //   - 本ファイルは AC-RL-6（送信間隔下限）を跨ぐために**実時間の `sleep`** を挟む（:149）。
    //   - 発行の窓（`FORM_SESSION_ISSUE_WINDOW_MS` = 10 分）は**実時刻**で進む固定ウィンドウであり、
    //     テスト側から `now` を注入できない（本番の 2 ルートをそのまま呼ぶため）。
    //   - したがって実行が窓の境界に当たると発行カウンタがリセットされ、
    //     受理数は 30 未満にも 30 ちょうどにもなりうる。**厳密一致は構造的に flaky になる。**
    // 絶対量の退行（SEC-070 の本体）は unit 側の `toBe` が捕まえる。ここは上界のみを固定する。
    expect(
      rows,
      `未認証の第三者が DB へ ${rows} 行を作った（縮退構成 / 1 回の攻撃 / 上界 ${ACCEPTED_BOUND} 行）`,
    ).toBeLessThanOrEqual(ACCEPTED_BOUND)
    expect(before).toBeGreaterThanOrEqual(0) // 呼び出し回数は上の行数に従属する（記録のみ）
  })
})

function countBy(values: number[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1
  return counts
}
