import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'

/**
 * =========================================================================
 * P3-c2 結合テスト — **F-009 の本番経路**
 *   `POST /api/uploads/license` → 署名付き PUT → `POST /api/applications` → 紐付け
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` F-009 AC-009-1〜10、
 *       AC-009-3/4 の実行位置（**RV-P3D-S10**: トランザクション境界）、
 *       `docs/security-audit.md` §F P3c-11。
 *
 * ## なぜユニットと両方要るのか
 * ユニット（`upload-validation` / `upload-token` / `storage-adapter`）は**判定と生成**を測るが、
 * **ルートがそれらを実際に呼んでいるか**は見ていない。
 * P3-c1 で 4 回連続で指摘された型（「測っていない継ぎ目」）そのものなので、
 * **本番の 2 ルートを跨いだ 1 本の手順**として測る。
 *
 * ## ⚠️ 実行前提
 * - dev DB（`scripts/dev-db.sh up` / :5433）が稼働していること。
 * - ストレージは**ローカルアダプタ**で動く（外部アカウント不要）。
 *   これが P3-c2 の設計前提であり、Blob 直結だと本ファイルは 1 件も書けない。
 * - `VERCEL` は設定しない（縮退構成）。RV-P3AF-006 のとおり Cookie 経路を通る。
 */

vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(async () => true) }))
vi.mock('@/lib/mail', () => ({ sendMail: vi.fn(async () => {}) }))

const ORIGIN = 'http://localhost:3000'
const FS_SECRET = 'integration-form-session-secret-32chars'

/** JPEG のマジックバイト（`FF D8 FF`）。 */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
/** 実体は HTML だが `image/jpeg` を申告する攻撃入力。 */
const HTML_BYTES = new TextEncoder().encode('<html><script>alert(1)</script></html>')

type UploadsRoute = {
  POST: (request: Request, ctx: never) => Promise<Response>
  DELETE: (request: Request, ctx: never) => Promise<Response>
}
let applicationsRoute: typeof import('@/app/api/applications/route')
let formSession: typeof import('@/lib/form-session')
let storage: typeof import('@/lib/storage')

const createdIdempotencyKeys: string[] = []

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET = FS_SECRET
  delete process.env.VERCEL
  formSession = await import('@/lib/form-session')
  storage = await import('@/lib/storage')
  applicationsRoute = await import('@/app/api/applications/route')
})

/**
 * uploads ルートを**テストの中で**読み込む。
 *
 * ⚠️ `beforeAll` で import すると、未実装のとき vitest は 16 件を **`skipped`** として集計する。
 * このプロジェクトは「**skip は『あるのに動いていない』テストとして残り、後で
 * 『あるから確認済み』と誤読される**」ことを繰り返し戒めてきた（申し送り §D 27）。
 * したがって**各テストが個別に fail する**形にする。
 */
async function uploadsRouteModule(): Promise<UploadsRoute> {
  try {
    return (await import('@/app/api/uploads/license/route')) as unknown as UploadsRoute
  } catch (error) {
    expect.fail(
      `app/api/uploads/license/route.ts が未作成（F-009 の成果物）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

afterAll(async () => {
  if (createdIdempotencyKeys.length > 0) {
    await prisma.application.deleteMany({
      where: { idempotencyKey: { in: createdIdempotencyKeys } },
    })
  }
  await prisma.$disconnect()
})

/** 3 秒以上前に発行された正規の Cookie（毎回新しい `sid`）。 */
function cookieHeader(): string {
  const value = formSession.createFormSessionValue(
    { sid: randomUUID().replace(/-/g, ''), issuedAt: Date.now() - 10_000 },
    FS_SECRET,
  )
  return `${formSession.FORM_SESSION_COOKIE_NAME}=${value}`
}

/** 発行 API を叩く。`extra` は攻撃入力の混入に使う。 */
async function issue(
  body: Record<string, unknown>,
  init: { cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers()
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN)
  headers.set('content-type', 'application/json')
  headers.set('cookie', init.cookie ?? cookieHeader())
  const uploadsRoute = await uploadsRouteModule()
  return uploadsRoute.POST(
    new Request(`${ORIGIN}/api/uploads/license`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    undefined as never,
  )
}

function applicationBody(
  photos: Array<{ objectKey: string; uploadToken: string; side: 'front' | 'back' }>,
  courseId: string,
): Record<string, unknown> {
  const idempotencyKey = randomUUID()
  createdIdempotencyKeys.push(idempotencyKey)
  return {
    type: 'APPLICATION',
    idempotencyKey,
    plans: ['ORDINARY_AT'],
    courseId,
    school: 'IWATAKI',
    format: 'TSUGAKU',
    name: '写真 太郎',
    nameKana: 'シャシン タロウ',
    birthDate: '2000-05-05',
    email: `photo-${idempotencyKey}@example.com`,
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
    licensePhotos: photos,
  }
}

async function submit(body: Record<string, unknown>): Promise<Response> {
  return applicationsRoute.POST(
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

async function publishedCourseId(): Promise<string> {
  const course = await prisma.course.findFirst({ where: { published: true } })
  expect(course, 'seed 済みの公開コースが必要').toBeTruthy()
  return course!.id
}

/** 発行 → 実バイトを格納、までを行う。 */
async function issueAndPut(bytes: Uint8Array, contentType = 'image/jpeg') {
  const response = await issue({ side: 'front', contentType, size: bytes.byteLength })
  expect(response.status, `発行が失敗した（status=${response.status}）`).toBe(200)
  const issued = (await response.json()) as { objectKey: string; uploadToken: string }
  await storage.sharedStorage().put?.(issued.objectKey, bytes, contentType)
  return issued
}

/* ========================================================================= *
 * AC-009-1 / AC-009-2: objectKey はサーバー生成
 * ========================================================================= */

describe('AC-009-1: 発行 API はクライアント指定の objectKey を無視する', () => {
  it('リクエストに objectKey を入れても、返る値はサーバー生成値である', async () => {
    // これが green なら排除される攻撃: クライアント指定キーで
    // **他人のオブジェクトを上書き**する / `../` でバケット外へ書き込む / 既知キーを後から読む。
    const attacker = '../../etc/passwd'
    const response = await issue({
      side: 'front',
      contentType: 'image/jpeg',
      size: 1024,
      objectKey: attacker,
    })
    expect(response.status).toBe(200)

    const body = (await response.json()) as { objectKey: string; uploadUrl: string }
    expect(body.objectKey).not.toContain('..')
    expect(body.objectKey).not.toBe(attacker)
    expect(body.uploadUrl).not.toContain(attacker)
  })

  it('同じ入力で 2 回発行しても objectKey が一致しない', async () => {
    const params = { side: 'front' as const, contentType: 'image/jpeg', size: 1024 }
    const a = (await (await issue(params)).json()) as { objectKey: string }
    const b = (await (await issue(params)).json()) as { objectKey: string }
    expect(a.objectKey).not.toBe(b.objectKey)
  })

  it('レスポンスに公開 URL が含まれない（AC-009-8）', async () => {
    // バケットは非公開。`objectKey` から導かれる公開 URL が
    // **API レスポンスにも DB にも HTML にもログにも現れない**こと。
    const response = await issue({ side: 'front', contentType: 'image/jpeg', size: 1024 })
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, unknown>

    // `uploadUrl` は署名付きで期限付きなので例外。それ以外に http(s) が現れないこと。
    for (const [key, value] of Object.entries(body)) {
      if (key === 'uploadUrl') continue
      expect(String(value), `${key} に URL が含まれている`).not.toMatch(/^https?:\/\//)
    }
  })
})

/* ========================================================================= *
 * E-009-1 / E-009-2: 発行時の検証
 * ========================================================================= */

describe('E-009-1 / E-009-2: 発行時に形式とサイズを検証する', () => {
  it.each([
    ['image/svg+xml', 'SVG は XSS の材料になる'],
    ['text/html', 'HTML は論外'],
    ['application/pdf', '許可リストに無い'],
  ])('許可外の contentType（%s）は 400 で発行しない', async (contentType) => {
    const response = await issue({ side: 'front', contentType, size: 1024 })
    expect(response.status).toBe(400)
  })

  it('サイズ上限超過は 400 で発行しない（境界: 上限は通り +1 は通らない）', async () => {
    const max = storage.MAX_LICENSE_PHOTO_BYTES
    expect((await issue({ side: 'front', contentType: 'image/jpeg', size: max })).status).toBe(200)
    expect((await issue({ side: 'front', contentType: 'image/jpeg', size: max + 1 })).status).toBe(400)
  })

  it('side が front / back 以外なら 400', async () => {
    expect((await issue({ side: 'middle', contentType: 'image/jpeg', size: 1024 })).status).toBe(400)
  })
})

/* ========================================================================= *
 * AC-009-3 / AC-009-4(b) / E-009-5: 格納後の実体検証
 * ========================================================================= */

describe('AC-009-3 / E-009-5: 申込送信時に実体を検証し、偽装は紐付けず削除する', () => {
  it('実体が HTML なら紐付けを拒否し、当該オブジェクトを削除する', async () => {
    // **本ファイルで最も重要なテスト。AC-009-3 が名指しで要求した検証である。**
    // 署名付き PUT はストレージへ直接行われるので、
    // **サーバーはバイト列を一度も見ないまま格納が完了する**。
    // したがって「何が入ったか」は格納後に読んで確かめる以外に知る方法がない。
    // これが green なら排除される攻撃: 実体 HTML を格納し、
    // F-018 の閲覧経路で `text/html` 解釈されて**管理者のセッションに対する XSS** になること。
    const issued = await issueAndPut(HTML_BYTES, 'image/jpeg')

    const response = await submit(
      applicationBody(
        [{ objectKey: issued.objectKey, uploadToken: issued.uploadToken, side: 'front' }],
        await publishedCourseId(),
      ),
    )

    expect(response.status, '実体 HTML が受け入れられている').not.toBe(201)
    expect(
      await storage.sharedStorage().head(issued.objectKey),
      '拒否したのにオブジェクトが残っている（E-009-5 は削除まで要求している）',
    ).toBeNull()
  })

  it('実サイズが上限を超えていれば紐付けを拒否する（申告 1MB・実体 6MB）', async () => {
    // AC-009-4 の原文: 「**申告値のみの検証では不可**」。
    // 発行時の申告は 1MB でも、実際に置かれたのが 6MB なら拒否する。
    const oversized = new Uint8Array(6 * 1024 * 1024)
    oversized.set(JPEG_BYTES, 0)

    const response = await issue({ side: 'front', contentType: 'image/jpeg', size: 1_048_576 })
    expect(response.status).toBe(200)
    const issued = (await response.json()) as { objectKey: string; uploadToken: string }
    await storage.sharedStorage().put?.(issued.objectKey, oversized, 'image/jpeg')

    const submitted = await submit(
      applicationBody(
        [{ objectKey: issued.objectKey, uploadToken: issued.uploadToken, side: 'front' }],
        await publishedCourseId(),
      ),
    )
    expect(submitted.status, '実サイズの再検証が行われていない').not.toBe(201)
  })

  it('保存される contentType は申告値ではなく検出結果である（SF-2 の補償 (b)）', async () => {
    // **polyglot（`FF D8 FF` で始まり後続に別ペイロードを連結）は先頭 12 バイト検証では
    // 原理的に検出できない**（手法の限界 / 設計文書 §3 の残余）。
    // その残余を埋める補償の 1 つが「**保存する `contentType` を検出結果に固定する**」ことである。
    //
    // これが green なら排除される事故: 申告値をそのまま `LicensePhoto.contentType` に保存し、
    // **F-018 の配信でその値が使われて実体と食い違う**こと
    //（ブラウザの content sniffing 次第で解釈が変わり、XSS の余地が生まれる）。
    //
    // ⚠️ 補償 (c)（F-018 で `X-Content-Type-Options: nosniff` と
    //    `Content-Disposition: attachment` を付ける）は**本単位のスコープ外**。
    //    設計文書 §3 に持ち越し条件として記録した。
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

    // 申告は image/png、実体も PNG（正当な組み合わせ）。
    const response = await issue({ side: 'front', contentType: 'image/png', size: png.byteLength })
    expect(response.status).toBe(200)
    const issued = (await response.json()) as { objectKey: string; uploadToken: string }
    await storage.sharedStorage().put?.(issued.objectKey, png, 'image/png')

    const body = applicationBody(
      [{ objectKey: issued.objectKey, uploadToken: issued.uploadToken, side: 'front' }],
      await publishedCourseId(),
    )
    expect((await submit(body)).status).toBe(201)

    const application = await prisma.application.findUnique({
      where: { idempotencyKey: body.idempotencyKey as string },
      select: { id: true },
    })
    const photo = await prisma.licensePhoto.findFirst({
      where: { applicationId: application!.id },
      select: { contentType: true },
    })
    expect(
      photo?.contentType,
      '保存された contentType が検出結果に固定されていない',
    ).toBe('image/png')
  })

  it('正しい JPEG なら 201 になり、LicensePhoto が 1 件作られる', async () => {
    // **正常系を壊さないこと。** 検証を厳しくしすぎて
    // 正規の申込が通らなくなる形（RV-P3B-001 と同じ「機能不成立」）を防ぐ。
    const issued = await issueAndPut(JPEG_BYTES, 'image/jpeg')
    const body = applicationBody(
      [{ objectKey: issued.objectKey, uploadToken: issued.uploadToken, side: 'front' }],
      await publishedCourseId(),
    )

    const response = await submit(body)
    expect(response.status, `正常系が通らない（status=${response.status}）`).toBe(201)

    const application = await prisma.application.findUnique({
      where: { idempotencyKey: body.idempotencyKey as string },
      select: { id: true },
    })
    expect(await prisma.licensePhoto.count({ where: { applicationId: application!.id } })).toBe(1)
  })
})

/* ========================================================================= *
 * AC-009-6 / AC-009-7: 単回使用とバインド
 * ========================================================================= */

describe('AC-009-6 / AC-009-7: uploadToken の単回使用とバインド（DB 件数まで測る）', () => {
  it('同一 uploadToken を使う 2 回目の送信は 2 件目の LicensePhoto を作らない', async () => {
    // AC-009-6 の原文: 「同一 `uploadToken` を使う 2 回目の申込送信は 403 になり、
    // **2 件目の `LicensePhoto` が作られない**。**結合テストで DB 件数まで検証する**」。
    const issued = await issueAndPut(JPEG_BYTES)
    const courseId = await publishedCourseId()
    const photos = [
      { objectKey: issued.objectKey, uploadToken: issued.uploadToken, side: 'front' as const },
    ]

    const first = await submit(applicationBody(photos, courseId))
    expect(first.status).toBe(201)

    const second = await submit(applicationBody(photos, courseId))
    expect(second.status, '消費済みトークンで 2 件目が通っている').not.toBe(201)

    expect(
      await prisma.licensePhoto.count({ where: { objectKey: issued.objectKey } }),
      '同じ objectKey の LicensePhoto が 2 件作られた',
    ).toBe(1)
  })

  it('他人の objectKey を組み合わせても紐付かない（IDOR）', async () => {
    // AC-009-7 / AC-009-10(b)。**未認証フローなので `uploadToken` が唯一の認可材料**である。
    const mine = await issueAndPut(JPEG_BYTES)
    const others = await issueAndPut(JPEG_BYTES)

    const response = await submit(
      applicationBody(
        // 自分のトークン + 他人の objectKey
        [{ objectKey: others.objectKey, uploadToken: mine.uploadToken, side: 'front' }],
        await publishedCourseId(),
      ),
    )
    expect(response.status, '他人の objectKey が紐付いた（IDOR）').not.toBe(201)
    expect(await prisma.licensePhoto.count({ where: { objectKey: others.objectKey } })).toBe(0)
  })
})

/* ========================================================================= *
 * AC-009-10 / SPEC-011: DELETE
 * ========================================================================= */

describe('AC-009-10 / SPEC-011: DELETE は uploadToken から引いたキーだけを消す', () => {
  it('正常系で Blob オブジェクトと UploadToken 行の両方が消える', async () => {
    const issued = await issueAndPut(JPEG_BYTES)

    const uploadsRoute = await uploadsRouteModule()
    const response = await uploadsRoute.DELETE(
      new Request(`${ORIGIN}/api/uploads/license`, {
        method: 'DELETE',
        headers: new Headers({
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: cookieHeader(),
        }),
        body: JSON.stringify({ objectKey: issued.objectKey, uploadToken: issued.uploadToken }),
      }),
      undefined as never,
    )

    expect(response.status).toBe(204)
    expect(await storage.sharedStorage().head(issued.objectKey), 'Blob が残っている').toBeNull()
    expect(
      await prisma.uploadToken.count({ where: { objectKey: issued.objectKey } }),
      'UploadToken 行が残っている',
    ).toBe(0)
  })

  it('他人の uploadToken に自分の objectKey を組み合わせても何も消えない', async () => {
    // AC-009-10(b)。**サーバーは受け取った `objectKey` を信頼しない**——
    // `uploadToken` から DB を引いたキーに対してのみ削除する。
    const mine = await issueAndPut(JPEG_BYTES)
    const victim = await issueAndPut(JPEG_BYTES)

    const uploadsRoute = await uploadsRouteModule()
    const response = await uploadsRoute.DELETE(
      new Request(`${ORIGIN}/api/uploads/license`, {
        method: 'DELETE',
        headers: new Headers({
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: cookieHeader(),
        }),
        body: JSON.stringify({ objectKey: victim.objectKey, uploadToken: mine.uploadToken }),
      }),
      undefined as never,
    )

    expect(response.status).toBe(403)
    expect(
      await storage.sharedStorage().head(victim.objectKey),
      '他人のオブジェクトが消された（IDOR）',
    ).not.toBeNull()
    expect(
      await storage.sharedStorage().head(mine.objectKey),
      '照合失敗なのに自分のオブジェクトが消えた',
    ).not.toBeNull()
  })
})

/* ========================================================================= *
 * RV-P3D-S10: トランザクション境界
 * ========================================================================= */

describe('RV-P3D-S10: 実体検証はトランザクション開始前に完了している', () => {
  it('トランザクション境界内にストレージ呼び出しが無い', async () => {
    // AC-009-3/4 の実行位置（原文）:
    // > **実体検証はトランザクション開始前に完了させる。**
    // > トランザクション内で行うのは `UploadToken` の条件付き更新と作成のみとし、
    // > **ストレージへのネットワーク I/O をトランザクション内に含めない**
    // > （写真 2 枚で往復 4 回、モバイル起因の遅延を含むと長時間トランザクションになり
    // >  **DB コネクション枯渇**の原因になる）。
    //
    // TOCTOU（検証と消費の間）は、**`objectKey` が予測不能かつ `uploadToken` が単回使用**
    // であるため実務上問題にならない——これが「先に検証してよい」根拠である。
    const adapter = storage.sharedStorage()
    const original = { head: adapter.head, readPrefix: adapter.readPrefix }

    // **呼び出しの「順序」で判定する**（`$transaction` をモックすると Prisma の
    // オーバーロード（配列版 / コールバック版）を型安全に再現できず、
    // テスト側のバグがそのまま red になって原因が分からなくなる）。
    //
    // 記録するのは「トランザクション開始/終了」と「ストレージ呼び出し」のタイムラインだけ。
    // 開始と終了の**間に**ストレージ呼び出しがあれば違反である。
    const timeline: string[] = []
    const realTransaction = prisma.$transaction.bind(prisma)
    const txSpy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementation((async (...args: Parameters<typeof realTransaction>) => {
        timeline.push('tx:start')
        try {
          return await (realTransaction as (...a: unknown[]) => Promise<unknown>)(...args)
        } finally {
          timeline.push('tx:end')
        }
      }) as typeof prisma.$transaction)

    adapter.head = async (key: string) => {
      timeline.push('storage:head')
      return original.head.call(adapter, key)
    }
    adapter.readPrefix = async (key: string, bytes: number) => {
      timeline.push('storage:readPrefix')
      return original.readPrefix.call(adapter, key, bytes)
    }

    try {
      const issued = await issueAndPut(JPEG_BYTES)
      timeline.length = 0 // 発行フェーズの記録は捨て、送信フェーズだけを見る
      await submit(
        applicationBody(
          [{ objectKey: issued.objectKey, uploadToken: issued.uploadToken, side: 'front' }],
          await publishedCourseId(),
        ),
      )

      // `tx:start` と `tx:end` の間に `storage:*` が挟まっていないこと。
      let depth = 0
      const violations: string[] = []
      for (const event of timeline) {
        if (event === 'tx:start') depth++
        else if (event === 'tx:end') depth--
        else if (depth > 0) violations.push(event)
      }

      expect(
        violations,
        `トランザクション内でストレージを呼んでいる: ${violations.join(', ')}` +
          `（タイムライン: ${timeline.join(' → ')}）`,
      ).toEqual([])
      expect(timeline, 'トランザクションが 1 度も開始されていない（前提が崩れている）').toContain(
        'tx:start',
      )
    } finally {
      adapter.head = original.head
      adapter.readPrefix = original.readPrefix
      txSpy.mockRestore()
    }
  })
})
