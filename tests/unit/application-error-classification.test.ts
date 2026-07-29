import { describe, it, expect, vi, beforeAll, beforeEach, type Mock } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

/**
 * =========================================================================
 * P3-c1 — **SEC-060 / P3c-4**: 実在しない `courseId` を 422 で落とし、
 *          `P2003` を明示的に分類する（**未分類の例外だけが 500**）
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-4（:3264）
 *       「実在しない `courseId` を 422 で落とす。`P2003` を明示的に分類し、
 *         未分類の例外だけが 500 になるようにする」
 *
 * ## なぜこれがセキュリティ項目なのか（「ただの 500」ではない）
 * `app/api/applications/route.ts:304-315` は `P2002`（一意制約違反）だけを分類し、
 * **それ以外の Prisma 例外を一律 500 にしている。** 実在しない `courseId` を送ると
 * `courseSnapshot`（同 :156-167）は `null` を返して素通りし、`prisma.application.create` が
 * 外部キー違反 **`P2003`** を投げ、**未認証の第三者が任意にサーバーエラーを起こせる**。
 *
 * 同じ形の欠陥は既に 2 度是正されている:
 *  - 同 :259-261「壊れた JSON / 不正な UTF-8 で 500 を起こさせない——**未認証の第三者が
 *    任意にサーバーエラーを起こせる経路になる**（SEC-042 と同じ形）」
 *  - `lib/form-session.ts:182-187`（マルチバイト署名で `RangeError` を起こさせない）
 *
 * **500 は「分類できなかった」という意味を持つ信号**である。分類可能な入力起因の失敗を
 * 500 に混ぜると、本当の内部障害がノイズに埋もれ、監視が機能しなくなる。
 *
 * ## P3-c2（免許証写真）の前に閉じる理由
 * P3-c2 は `LicensePhoto` を `Application` へ紐付ける **2 本目の外部キー**を作る。
 * `P2003` の分類が無いまま外部キーが増えると、
 * **「アップロード直後に申込が消えた」「トークンが失効した」といった正常な競合まで 500 になる。**
 *
 * ## red 理由
 * 現行実装は `P2003` を分類していない（`error.code === 'P2002'` のみ）。
 * また事前照合も無いので、実在しない `courseId` は **create まで到達してから** 500 になる。
 *
 * ## Impl が実装すべき契約
 * ```
 * 1. 事前照合: type=APPLICATION で `courseId` が実在しなければ
 *      **create を呼ぶ前に** 422 `{ errors: [{ field: 'courseId', code: 'NOT_FOUND' }] }`
 *      （`courseSnapshot` は既に findUnique しているので追加の往復は要らない）
 * 2. 競合の分類: 照合の直後にコースが消された場合の `P2003` も **422 の同じ本文**へ落とす。
 *      **ただし `error.meta.field_name` が `courseId` に紐づくものだけ**（REV-P3C1-008）
 * 3. 未分類の例外だけが 500（`P2002` の冪等再送は従来どおり 200）。
 *      **判別できない `P2003` は未分類**として 500 に残す
 * 4. **エラー応答に送信値を含めない**（AC-PII-2 / AC-010-8）。返すのは `{ field, code }` のみ
 * ```
 *
 * ## ⚠️ `P2003` を無条件に `courseId` へ落とさない（REV-P3C1-008）
 * **本項目を P3-c2 の前に閉じる理由が、そのまま契約を壊す条件になっている。**
 * P3-c2 は `LicensePhoto` → `Application` という**2 本目の外部キー**を作る。
 * `P2003` を無条件に `{ field: 'courseId' }` へ落とすと、その瞬間から
 * `applicationId` の外部キー違反が**「コースが存在しません」として利用者に返る**
 * （しかも 422 なので監視にも上がらない）。**この契約は自分が挙げた理由によって自分が壊れる。**
 *
 * 分類の網を実際の原因より広く張ると「入力が悪い」と**嘘をつく応答**になる——
 * 未分類の例外を 500 に残す理由（§「500 は分類できなかったという信号」）と同じ原則である。
 *
 * ## テスト方針（本番経路を通す）
 * 差し替えるのは **`@/lib/db`（外部 I/O）だけ**で、
 * ラッパ（`withPublicMutation`）・バリデータ・分類ロジックは**本番の実物を通す**。
 * DB を実際に触る側は `tests/integration/application-course-fk.int.ts` が受け持つ。
 * **両方要る**——本ファイルは「未分類の例外だけが 500」という**分類の網羅**を、
 * 結合側は「実在しない `courseId` が実際に P2003 を起こす」という**前提の実在**を測る。
 */

/** 外部 I/O だけを差し替える（アプリのロジックは本物を通す）。 */
vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(async () => true) }))
vi.mock('@/lib/mail', () => ({ sendMail: vi.fn(async () => {}) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    course: { findUnique: vi.fn() },
    application: { findUnique: vi.fn(), create: vi.fn() },
  },
}))

const ORIGIN = 'http://localhost:3000'
const FS_SECRET = 'unit-form-session-secret-32-characters!!'

const COURSE = {
  id: 'course-ordinary-at',
  licenseTypeLabel: '普通車 AT',
  programLabel: '通学',
  priceFrom: 300_000,
}

let route: typeof import('@/app/api/applications/route')
let formSession: typeof import('@/lib/form-session')

/**
 * ⚠️ **`typeof import('@/lib/db')` として宣言しないこと。**
 *
 * それだと `mockResolvedValue` が Prisma の生成型（全列）を要求するため、
 * `select` を伴うクエリの戻り値（`{ id, receiptNumber }` 等の部分オブジェクト）を渡せず
 * `pnpm type-check` が落ちる（Prisma の生成型は `select` を静的に解決しないため）。
 * **上の `vi.mock` が置き換えているのはこの 3 つの関数だけ**なので、その形で宣言する。
 * 型検査の都合であって、契約でもテストの意図でもない。
 */
let db: {
  prisma: {
    course: { findUnique: Mock }
    application: { findUnique: Mock; create: Mock }
  }
}

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET = FS_SECRET
  formSession = await import('@/lib/form-session')
  db = (await import('@/lib/db')) as unknown as typeof db
  route = await import('@/app/api/applications/route')
})

beforeEach(() => {
  vi.mocked(db.prisma.course.findUnique).mockReset()
  vi.mocked(db.prisma.application.findUnique).mockReset()
  vi.mocked(db.prisma.application.create).mockReset()
  // 既定: 冪等キーの既存行は無い。
  vi.mocked(db.prisma.application.findUnique).mockResolvedValue(null)
  // 既定: 書き込みは成功する。**red を「未定義参照の TypeError」にしないため**に必ず置く
  //（分類が無い現状でも、失敗はステータスの assertion として観測されなければならない）。
  vi.mocked(db.prisma.application.create).mockResolvedValue({
    id: 'app_default',
    receiptNumber: 'A-20260729-0000',
  })
})

/**
 * **毎回新しい `sid`** を使う（Cookie 軸は 3 回/10 分なので、使い回すと 4 件目から 429 になる）。
 * 発行から 10 秒経過させて送信間隔下限（AC-RL-6 / 3 秒）を満たす。
 */
function cookieHeader(): string {
  const value = formSession.createFormSessionValue(
    { sid: randomUUID().replace(/-/g, ''), issuedAt: Date.now() - 10_000 },
    FS_SECRET,
  )
  return `${formSession.FORM_SESSION_COOKIE_NAME}=${value}`
}

function applicationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'APPLICATION',
    idempotencyKey: randomUUID(),
    plans: ['ORDINARY_AT'],
    courseId: COURSE.id,
    school: 'IWATAKI',
    format: 'TSUGAKU',
    name: '分類 太郎',
    nameKana: 'ブンルイ タロウ',
    birthDate: '2000-05-05',
    email: 'classify@example.com',
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

/**
 * Prisma の既知エラーを組み立てる（本物のクラスを使う。形だけのフェイクにしない）。
 *
 * `meta.field_name` は Prisma が**どの外部キー制約か**を入れるフィールドである。
 * REV-P3C1-008 により、`P2003` の分類はこの値で分岐しなければならない。
 */
function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Foreign key constraint failed on the field: `Application_courseId_fkey (index)`',
    { code, clientVersion: 'test', meta },
  )
}

/* ========================================================================= *
 * SEC-060 (1): 実在しない courseId は 422（DB 書き込みへ到達させない）
 * ========================================================================= */

describe('SEC-060 / P3c-4: 実在しない courseId は 422 で落ちる', () => {
  it('コースが存在しなければ 422 を返し、create を呼ばない', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される攻撃: 未認証の第三者が実在しない `courseId` を送るだけで
    // **任意に 500 を起こせる**こと（`app/api/applications/route.ts:259-261` が
    // 壊れた JSON について既に禁じた形と同型）。
    // 併せて、**分類できる失敗のために DB 書き込みを試みない**ことを固定する
    //（レート制限を本体より前に置いた理由と同じ: 攻撃者に I/O を消費させない）。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(null)

    const response = await post(applicationBody({ courseId: 'course-does-not-exist' }))

    expect(response.status, '未分類の 500 のままになっている').toBe(422)
    expect(await response.json()).toEqual({
      errors: [{ field: 'courseId', code: 'NOT_FOUND' }],
    })
    expect(
      vi.mocked(db.prisma.application.create),
      '存在しないコースなのに DB 書き込みを試みている',
    ).not.toHaveBeenCalled()
  })

  it('422 の本文に送信値を含めない（AC-PII-2 / AC-010-8）', async () => {
    // これが green なら排除される漏えい: Prisma の例外メッセージ
    //（`Foreign key constraint failed on the field: ...`）や送信された `courseId` を
    // そのまま応答に載せること。返してよいのは `{ field, code }` だけである。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(null)

    const response = await post(applicationBody({ courseId: 'probe-value-12345' }))
    const text = await response.text()

    expect(response.status, `422 に分類されていない（本文: ${text.slice(0, 120)}）`).toBe(422)
    expect(text).not.toContain('probe-value-12345')
    expect(text).not.toContain('Foreign key')
    expect(text).not.toContain('constraint')
  })

  it('実在するコースなら従来どおり 201（正常系を壊さない）', async () => {
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockResolvedValue({
      id: 'app_1',
      receiptNumber: 'A-20260729-0001',
    })

    const response = await post(applicationBody())
    expect(response.status).toBe(201)
  })

  it('type=INQUIRY は courseId を持たないので照合の対象外（INQUIRY 経路を壊さない）', async () => {
    // `app/api/applications/route.ts:207` は INQUIRY の `courseId` を null にする。
    // 照合を type で分けずに書くと、**正規の問い合わせが全て 422 になる**
    //（`lib/validators/application.ts:139-140` が同じ事故を既に記録している）。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(null)
    vi.mocked(db.prisma.application.create).mockResolvedValue({
      id: 'app_2',
      receiptNumber: 'A-20260729-0002',
    })

    const response = await post({
      type: 'INQUIRY',
      idempotencyKey: randomUUID(),
      plans: [],
      courseId: null,
      name: '問合 太郎',
      nameKana: 'トイアワセ タロウ',
      birthDate: '2000-05-05',
      email: 'inquiry@example.com',
      phone: '090-1234-5678',
      firstTime: true,
      referralSources: [],
      currentLicenses: [],
      message: 'テスト',
      privacyConsent: true,
      captchaToken: 'ts-token',
      hp_field: '',
    })

    expect(response.status).toBe(201)
  })
})

/* ========================================================================= *
 * SEC-060 (2): 例外の分類（**未分類だけが 500**）
 * ========================================================================= */

describe('SEC-060 / P3c-4: Prisma 例外の分類 — 未分類の例外だけが 500 になる', () => {
  it('courseId 由来の P2003 は 422（照合とコース削除のレース）', async () => {
    // 事前照合を通った直後に管理者がコースを削除した場合、`create` は P2003 を投げる。
    // これは**入力起因の分類可能な失敗**であり、内部障害ではない。
    // これが green なら排除される事故: 正常な競合が 500 として監視に上がり続け、
    // **本当の内部障害がノイズに埋もれる**こと。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(
      prismaError('P2003', { field_name: 'Application_courseId_fkey (index)' }),
    )

    const response = await post(applicationBody())

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      errors: [{ field: 'courseId', code: 'NOT_FOUND' }],
    })
  })

  it('courseId 以外の外部キー由来の P2003 は 500（REV-P3C1-008）', async () => {
    // **本項目を P3-c2 の前に閉じる理由が、そのまま契約を壊す条件になっている。**
    // P3-c2 は `LicensePhoto` → `Application` という**2 本目の外部キー**を作る。
    // `P2003` を**無条件に** `{ field: 'courseId' }` へ落とすと、その瞬間から
    // `applicationId` の外部キー違反が**「コースが存在しません」として利用者に返る**
    //（しかも 422 なので監視にも上がらない）。
    //
    // 分類の網を実際の原因より広く張ると、「入力が悪い」と**嘘をつく応答**になる。
    // 判別できない `P2003` は**未分類として 500 のまま残す**
    //（「500 は分類できなかったという信号」という本項目自身の原則に従う）。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(
      prismaError('P2003', { field_name: 'LicensePhoto_applicationId_fkey (index)' }),
    )

    const response = await post(applicationBody())
    expect(
      response.status,
      '別の外部キー由来の P2003 が「コースが存在しません」として 422 で返っている',
    ).toBe(500)
  })

  it('field_name が読み取れない P2003 も 500（判別できないものを推測しない）', async () => {
    // Prisma のバージョンや DB によって `meta` の形は変わりうる。
    // **読み取れないときに `courseId` だと決め打たない**こと。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(prismaError('P2003'))

    const response = await post(applicationBody())
    expect(response.status).toBe(500)
  })

  it('P2002（一意制約違反）は従来どおり冪等再送として 200（退行防止）', async () => {
    // `app/api/applications/route.ts:307-312` の既存分類を壊さないことを固定する。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(prismaError('P2002'))
    vi.mocked(db.prisma.application.findUnique)
      .mockResolvedValueOnce(null) // 事前照合では見つからない
      .mockResolvedValueOnce({ id: 'app_9', receiptNumber: 'A-1', sessionIdHash: null }) // レース後

    const response = await post(applicationBody())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ idempotent: true })
  })

  it('未分類の例外は 500 のまま（500 が「分類できなかった」信号であり続ける）', async () => {
    // これが green なら排除される壊れた修正: **全ての例外を 422 に丸める**こと。
    // それは「入力が悪い」と嘘をつくことであり、内部障害が観測できなくなる。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(new Error('connection reset'))

    const response = await post(applicationBody())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'internal error' })
  })

  it('未知の Prisma エラーコードも 500（分類の網を勝手に広げない）', async () => {
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(prismaError('P2025'))

    const response = await post(applicationBody())
    expect(response.status).toBe(500)
  })

  it('500 の本文にも例外メッセージを含めない', async () => {
    // Prisma の例外メッセージは**送信値を含む**（`lib/pii-log.ts:80-84` の指摘）。
    vi.mocked(db.prisma.course.findUnique).mockResolvedValue(COURSE)
    vi.mocked(db.prisma.application.create).mockRejectedValue(
      new Error('insert failed for email=leak@example.com'),
    )

    const response = await post(applicationBody())
    const text = await response.text()
    expect(text).not.toContain('leak@example.com')
    expect(text).not.toContain('insert failed')
  })
})
