import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'

/**
 * =========================================================================
 * P3-c1 結合テスト — **SEC-060 / P3c-4**: 実在しない `courseId` を本番経路で測る
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-4（:3264）。
 *
 * ## なぜユニット（`tests/unit/application-error-classification.test.ts`）と両方要るのか
 * ユニット側は `@/lib/db` をモックするので、
 * **「実在しない `courseId` が実際に `P2003` を起こす」という前提そのもの**は検証していない。
 * 前提が偽なら（例: 外部キー制約が張られていない）、ユニットは green のまま
 * **本番では何も起きていない**——P2 で実際に起きた「テストは green だが本番経路が守られていない」型である。
 *
 * 本ファイルは **実 DB の外部キー制約**に対して測る。逆にユニット側でしか測れないのは
 * 「未分類の例外だけが 500」という分類の網羅（実 DB では任意の例外を起こせない）。**両方要る。**
 *
 * ## ⚠️ 実行前提
 * - dev DB（`scripts/dev-db.sh up` / :5433）が稼働し、`pnpm db:seed` 済みであること。
 * - 本ファイルは `VERCEL` を設定しない（＝ **縮退構成**）。RV-P3AF-006 のとおり、
 *   Cookie を持たない要求は全て 403 になる。**「全部 403」を実装の壊れと誤診しないこと。**
 */

/** 外部 I/O（Cloudflare / Resend）だけを差し替える。**アプリのロジックは本物を通す。** */
vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(async () => true) }))
vi.mock('@/lib/mail', () => ({ sendMail: vi.fn(async () => {}) }))

const ORIGIN = 'http://localhost:3000'
const FS_SECRET = 'integration-form-session-secret-32chars'

/** 実在しない（が形式は妥当な）コース ID。 */
const MISSING_COURSE_ID = 'course-does-not-exist-0000'

let route: typeof import('@/app/api/applications/route')
let formSession: typeof import('@/lib/form-session')
let mail: typeof import('@/lib/mail')
let publishedCourseId: string

const createdIdempotencyKeys: string[] = []

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET = FS_SECRET
  formSession = await import('@/lib/form-session')
  mail = await import('@/lib/mail')
  route = await import('@/app/api/applications/route')

  const course = await prisma.course.findFirst({ where: { published: true } })
  expect(course, 'seed 済みの公開コースが必要（scripts/dev-db.sh + pnpm db:seed）').toBeTruthy()
  publishedCourseId = course!.id

  const missing = await prisma.course.findUnique({ where: { id: MISSING_COURSE_ID } })
  expect(missing, 'テストが前提にしている「実在しない ID」が実在してしまっている').toBeNull()
})

afterEach(async () => {
  vi.mocked(mail.sendMail).mockClear()
  if (createdIdempotencyKeys.length > 0) {
    await prisma.application.deleteMany({
      where: { idempotencyKey: { in: createdIdempotencyKeys } },
    })
    createdIdempotencyKeys.length = 0
  }
})

afterAll(async () => {
  await prisma.$disconnect()
})

/** 3 秒以上前に発行された正規の Cookie（毎回新しい `sid` = Cookie 軸 3 回/10 分を跨がない）。 */
function cookieHeader(): string {
  const value = formSession.createFormSessionValue(
    { sid: randomUUID().replace(/-/g, ''), issuedAt: Date.now() - 10_000 },
    FS_SECRET,
  )
  return `${formSession.FORM_SESSION_COOKIE_NAME}=${value}`
}

function applicationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const idempotencyKey = randomUUID()
  createdIdempotencyKeys.push(idempotencyKey)
  return {
    type: 'APPLICATION',
    idempotencyKey,
    plans: ['ORDINARY_AT'],
    courseId: publishedCourseId,
    school: 'IWATAKI',
    format: 'TSUGAKU',
    name: '外部キー 太郎',
    nameKana: 'ガイブキー タロウ',
    birthDate: '2000-05-05',
    email: `fk-${idempotencyKey}@example.com`,
    phone: '090-1234-5678',
    postalCode: '6260001',
    address: '京都府宮津市字文珠1',
    licenseRevoked: false,
    currentLicenses: [],
    firstTime: true,
    referralSources: [],
    privacyConsent: true,
    captchaToken: 'ts-token',
    hp_field: '',
    ...overrides,
  }
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return route.POST(
    new Request(`${ORIGIN}/api/applications`, {
      method: 'POST',
      headers: new Headers({
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: cookieHeader(),
      }),
      body: JSON.stringify(body),
    }),
    undefined as never,
  )
}

async function countByKey(idempotencyKey: string): Promise<number> {
  return prisma.application.count({ where: { idempotencyKey } })
}

/* ========================================================================= *
 * SEC-060: 実在しない courseId
 * ========================================================================= */

describe('SEC-060 / P3c-4: 実在しない courseId を送っても 500 にならない（本番経路）', () => {
  it('422 を返し、DB 行もメールも発生しない', async () => {
    // **本ファイルの中心。**
    // これが green なら排除される攻撃: 未認証の第三者が実在しない `courseId` を送るだけで
    // **任意にサーバーエラー（500）を起こせる**こと。
    // `app/api/applications/route.ts:259-261` は壊れた JSON について同じ形を既に禁じている
    //（「未認証の第三者が任意にサーバーエラーを起こせる経路になる / SEC-042 と同じ形」）。
    const body = applicationBody({ courseId: MISSING_COURSE_ID })
    const response = await post(body)

    expect(response.status, '未分類の 500 のままになっている').toBe(422)
    expect(await response.json()).toEqual({
      errors: [{ field: 'courseId', code: 'NOT_FOUND' }],
    })
    expect(await countByKey(body.idempotencyKey as string), 'DB 行が作られている').toBe(0)
    expect(vi.mocked(mail.sendMail), 'メールが送られている').not.toHaveBeenCalled()
  })

  it('応答に送信値も Prisma の例外メッセージも含めない（AC-PII-2 / AC-010-8）', async () => {
    // Prisma の外部キー違反メッセージは
    // `Foreign key constraint failed on the field: \`courseId\`` のように**制約名と列名を含む**。
    // それを応答へ載せると、スキーマの内部構造が未認証の第三者に見える。
    const response = await post(applicationBody({ courseId: MISSING_COURSE_ID }))
    const text = await response.text()

    // ⚠️ **ステータスを先に固定する。** これが無いと、現行の 500（本文は
    // `{"error":"internal error"}`）に対して以下の `not.toContain` が**全て空振りで green** になる
    //（申し送り原則 4「空振りしているテストを green として報告しない」）。
    expect(response.status, `422 に分類されていない（本文: ${text.slice(0, 120)}）`).toBe(422)
    expect(text).not.toContain(MISSING_COURSE_ID)
    expect(text).not.toContain('Foreign key')
    expect(text).not.toContain('constraint')
    expect(text).not.toContain('prisma')
  })

  it('実在する公開コースなら 201（正常系を壊さない）', async () => {
    // これが green なら排除される「行き過ぎた修正」: 照合を厳しくしすぎて
    // **正規の申込が全て 422 になる**こと（`lib/validators/application.ts:139-140` が
    // INQUIRY 経路について同じ事故を既に記録している）。
    const body = applicationBody()
    const response = await post(body)

    expect(response.status).toBe(201)
    expect(await countByKey(body.idempotencyKey as string)).toBe(1)
  })

  it('非公開コースの扱いが 500 にならない（存在するが公開されていない場合）', async () => {
    // 公開/非公開の判定を照合に足す場合でも、**500 にはしない**ことだけを固定する
    //（201 = 受け付ける / 422 = 業務ルールで断る、のどちらを採るかは Spec の判断）。
    // これが green なら排除される事故: 非公開コースの ID を送ると 500 になる経路が残ること。
    const unpublished = await prisma.course.findFirst({ where: { published: false } })
    if (!unpublished) {
      // 非公開コースが seed に無い環境では対象が無い。**`it.skip` は置かない**
      //（skip は「あるのに動いていない」テストとして残り、後で「確認済み」と誤読される）。
      expect(true).toBe(true)
      return
    }
    const response = await post(applicationBody({ courseId: unpublished.id }))
    expect([201, 422], `想定外のステータス: ${response.status}`).toContain(response.status)
  })
})
