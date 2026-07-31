import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { AdminLoginPage } from '../pages/AdminLoginPage'
import { ADMIN_API, ADMIN_CREDENTIALS, ADMIN_ROUTES } from '../pages/admin-contract'

/**
 * PT2-01（多層防御・最重要）— 管理系変更エンドポイントの handler レベル認可（F-012 §4.2 / tech-stack §4.3）。
 * US-011 / F-014。
 *
 * 背景: middleware の matcher は `/admin/:path*` のみで `/api/admin/*` を含まない。
 * したがって管理APIは middleware に守られず、各 Route Handler が自前で session を検証しなければ
 * 未認証でも作成/更新/削除が通ってしまう。本テストは「未認証では変更が行われない」ことを
 * middleware に依存せず直接検証する（`request` fixture でブラウザセッション無しに叩く）。
 *
 * red の期待: エンドポイント未実装なら 404、認可を落とした実装なら 2xx となり fail。
 * 正しい実装（未認証 401/403）で green。＝Impl が認可を落とすと red になる forcing function。
 *
 * 注意: Impl が REST（/api/admin/news）ではなく Server Action を採用した場合は、
 *   下記のブラウザ経路（未認証で作成フォーム/一覧に到達できない = login へリダイレクト）が
 *   実効的なガードとなる。両経路をアサートしておく。
 */
test.describe('PT2-01: 未認証の管理API変更は拒否される（handler 認可）', () => {
  const draftPayload = {
    title: '【E2E-AUTHZ】未認証で作られてはいけない',
    body: '本文',
    category: 'COMMON',
    status: 'DRAFT',
    publishedAt: null,
  }

  test('未認証 POST /api/admin/news は 401/403（作成されない）', async ({ request }) => {
    const res = await request.post(ADMIN_API.news, { data: draftPayload })
    expect(res.ok(), `expected unauthorized, got ${res.status()}`).toBeFalsy()
    expect([401, 403]).toContain(res.status())
  })

  test('未認証 GET /api/admin/news（管理一覧）は 401/403', async ({ request }) => {
    const res = await request.get(ADMIN_API.news)
    expect([401, 403]).toContain(res.status())
  })

  test('未認証 PUT /api/admin/news/[id] は 401/403（更新されない。認可は 404 より先）', async ({
    request,
  }) => {
    const res = await request.put(ADMIN_API.newsById('nonexistent-id'), {
      data: { ...draftPayload, status: 'PUBLISHED', publishedAt: '2026-07-20T01:00:00.000Z' },
    })
    expect([401, 403]).toContain(res.status())
  })

  test('未認証 DELETE /api/admin/news/[id] は 401/403（削除されない）', async ({ request }) => {
    const res = await request.delete(ADMIN_API.newsById('nonexistent-id'))
    expect([401, 403]).toContain(res.status())
  })
})

test.describe('PT2-01: 未認証は管理変更画面に到達できない（middleware ガード補完）', () => {
  test('未認証で作成フォーム /admin/news/new はログインへリダイレクト（E-012-2）', async ({
    page,
  }) => {
    await page.goto(ADMIN_ROUTES.newsNew)
    await expect(page).toHaveURL(/\/admin\/login/)
  })
})

/**
 * PT2-05（SEC-011 / RV-P2-005）— 変更系フォームエンドポイントの CSRF 防御（同一オリジン検証）。
 *
 * 背景: `save` / `delete` は Server Action ではなく**ネイティブ form POST** を受ける設計で
 * （保存直後の遷移で中断されないため。判断自体は妥当）、その代償として Next.js の Server Action が
 * 標準で行う Origin 検証を持たない。検証しているのはセッションの有無のみで、CSRF の防御は
 * Auth.js セッション Cookie の `sameSite: 'lax'` という**ライブラリ既定値**に暗黙依存している。
 * `sameSite` を将来 'none' に変えた瞬間、あるいは同一サイト（サブドメイン）に任意コンテンツが
 * 置かれた瞬間に、お知らせの改ざん・削除・不正公開が成立する。
 *
 * 検証する契約（RV-P2-005 の応答契約）:
 *   - 未認証 → 303（/admin/login）   ← 既存の実装どおり。本 describe では変更しない
 *   - 認証済み × クロスオリジン → **403**
 *   - 認証済み × 同一オリジン → 従来どおり 303（/admin/news）で処理される
 *
 * red の期待: 現在は Origin を一切見ないため、クロスオリジンでも 303 が返って処理が実行される
 * （save は記事を作成し、delete は記事を削除してしまう）。403 期待が fail する。
 *
 * 実装の注意: `page.request` は**ブラウザコンテキストの Cookie を共有**するため、UIログイン後に
 * そのまま認証済みリクエストを送れる。`maxRedirects: 0` を指定して 303 を追跡せず素の
 * ステータスを見る（追跡すると最終的な 200 に化けて判定できない）。
 * `APIRequestContext` は Origin ヘッダを自動付与しないため、同一オリジン側も明示的に付ける。
 *
 * データ衛生（PT2-03）: 本 describe は共有 dev DB に PUBLISHED 行を作るため、全タイトルに
 * E2E 接頭辞を付け、afterAll で接頭辞一致行をベストエフォート削除する（結合テストの厳密件数
 * news.published=6 と「最新記事」を壊さないため）。admin-news.spec.ts と同じ方式。
 */
function loadDotenv() {
  let raw: string
  try {
    raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

/**
 * 本スペックが使う Prisma クライアント（ワーカープロセスあたり 1 つ）。
 *
 * 以前は `withPrisma` が呼び出しごとに `new PrismaClient()` して `$disconnect()` していた。
 * 本スペックは 17 箇所から呼ぶため、E2E 1 回の実行で**接続の確立と切断を 17 回**繰り返し、
 * dev サーバー側の Prisma 接続と合わせて dev DB の接続枠を奪い合う。これが高負荷時に
 * `admin-authz.spec.ts` が単発で落ちる（既知の flaky）原因と推定されている。
 * 1 つを使い回せばこの競合は構造的に消える。**アサーションは変更していない。**
 */
let sharedPrisma: PrismaClient | null = null

/** dev DB を直接見て「実際に作成/削除されたか」を確認する（HTTP ステータスだけを信用しない）。 */
async function withPrisma<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  if (sharedPrisma === null) {
    loadDotenv()
    sharedPrisma = new PrismaClient()
  }
  return fn(sharedPrisma)
}

const CSRF_TITLE_PREFIX = '【E2E-CSRF】'
const CROSS_ORIGIN = 'https://attacker.example.net'

/**
 * 後片付けの範囲を「このワーカーが作った行」に限定するためのタグ。
 *
 * ⚠️ **接頭辞一致だけで消してはいけない。** `fullyParallel` では同一ファイル内の
 * 2 つの describe.serial が**別ワーカーに割り当てられる**（実際にそうなっている）。
 * ファイル直下の afterAll はワーカーごとに走るので、先に終わった側が接頭辞一致で
 * deleteMany すると、まだ実行中のもう一方が使っている行まで消える。
 * その結果 PT2-06 の DELETE が 404 になって落ちる——原因が別ワーカーにあるため、
 * 単体で再実行すると通ってしまい「たまに落ちる」ようにしか見えない。
 */
const workerTag = (workerIndex: number) => `[w${workerIndex}]`

// ファイル直下の afterAll は、describe 内の afterAll より**後**に実行される（内側 → 外側）。
// したがってここで切断すれば、後片付けが未接続の client を掴むことはない。
test.afterAll(async ({}, testInfo) => {
  await withPrisma(async (prisma) => {
    try {
      await prisma.news.deleteMany({
        where: {
          title: { startsWith: CSRF_TITLE_PREFIX, contains: workerTag(testInfo.workerIndex) },
        },
      })
    } catch {
      // best-effort（dev DB 未起動などは無視）
    }
  })
  if (sharedPrisma !== null) {
    await sharedPrisma.$disconnect()
    sharedPrisma = null
  }
})

test.describe.serial('PT2-05: 認証済みでもクロスオリジンの変更リクエストは拒否される（CSRF）', () => {
  const stamp = Date.now()
  let csrfTitle: string
  let savedTitle: string
  let origin: string

  test.beforeAll(async ({}, testInfo) => {
    const key = `${workerTag(testInfo.workerIndex)}${testInfo.project.name}-${stamp}`
    csrfTitle = `${CSRF_TITLE_PREFIX}CSRFで作られてはいけない ${key}`
    savedTitle = `${CSRF_TITLE_PREFIX}正規フローで作成 ${key}`
  })

  test.beforeEach(async ({ page }) => {
    const login = new AdminLoginPage(page)
    await login.goto()
    await login.login(ADMIN_CREDENTIALS.email, ADMIN_CREDENTIALS.password)
    await expect(page).toHaveURL(/\/admin$/)
    origin = new URL(page.url()).origin
  })

  test('認証済み × 不正 Origin の POST /api/admin/news/save は 403（記事は作成されない）', async ({
    page,
  }) => {
    const res = await page.request.post(ADMIN_API.newsSave, {
      headers: { origin: CROSS_ORIGIN },
      form: {
        title: csrfTitle,
        body: 'CSRF 経由の本文',
        category: 'COMMON',
        status: 'DRAFT',
        intent: 'draft',
      },
      maxRedirects: 0,
    })

    expect(res.status(), `expected 403 for cross-origin POST, got ${res.status()}`).toBe(403)

    const created = await withPrisma((prisma) =>
      prisma.news.findFirst({ where: { title: csrfTitle } }),
    )
    expect(created, 'クロスオリジンの save で記事が作成されてはならない').toBeNull()
  })

  test('認証済み × Origin ヘッダ欠落の POST /api/admin/news/save も 403（fail-closed）', async ({
    page,
  }) => {
    const res = await page.request.post(ADMIN_API.newsSave, {
      form: {
        title: `${csrfTitle}-no-origin`,
        body: 'Origin なしの本文',
        category: 'COMMON',
        status: 'DRAFT',
        intent: 'draft',
      },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(403)
  })

  test('認証済み × 同一 Origin の POST /api/admin/news/save は従来どおり 303 で作成される', async ({
    page,
  }) => {
    const res = await page.request.post(ADMIN_API.newsSave, {
      headers: { origin },
      form: {
        title: savedTitle,
        body: '正規フローの本文',
        category: 'COMMON',
        status: 'DRAFT',
        intent: 'draft',
      },
      maxRedirects: 0,
    })

    expect(res.status()).toBe(303)
    expect(res.headers()['location']).toContain(ADMIN_ROUTES.newsList)

    const created = await withPrisma((prisma) =>
      prisma.news.findFirst({ where: { title: savedTitle } }),
    )
    expect(created, '同一オリジンの save は従来どおり成功しなければならない').not.toBeNull()
  })

  test('認証済み × 不正 Origin の POST /api/admin/news/delete は 403（記事は削除されない）', async ({
    page,
  }) => {
    const target = await withPrisma((prisma) =>
      prisma.news.findFirst({ where: { title: savedTitle } }),
    )
    expect(target, '前テストで作成された記事が必要').not.toBeNull()

    const res = await page.request.post(ADMIN_API.newsDelete, {
      headers: { origin: CROSS_ORIGIN },
      form: { id: target!.id },
      maxRedirects: 0,
    })

    expect(res.status(), `expected 403 for cross-origin POST, got ${res.status()}`).toBe(403)

    const stillThere = await withPrisma((prisma) =>
      prisma.news.findUnique({ where: { id: target!.id } }),
    )
    expect(stillThere, 'クロスオリジンの delete で記事が削除されてはならない').not.toBeNull()
  })

  test('認証済み × 同一 Origin の POST /api/admin/news/delete は従来どおり 303 で削除される', async ({
    page,
  }) => {
    const target = await withPrisma((prisma) =>
      prisma.news.findFirst({ where: { title: savedTitle } }),
    )
    expect(target).not.toBeNull()

    const res = await page.request.post(ADMIN_API.newsDelete, {
      headers: { origin },
      form: { id: target!.id },
      maxRedirects: 0,
    })

    expect(res.status()).toBe(303)

    const deleted = await withPrisma((prisma) =>
      prisma.news.findUnique({ where: { id: target!.id } }),
    )
    expect(deleted, '同一オリジンの delete は従来どおり成功しなければならない').toBeNull()
  })

  test('未認証の save/delete は従来どおり 303 で /admin/login へ（既存契約を変えない）', async ({
    request,
  }) => {
    const save = await request.post(ADMIN_API.newsSave, {
      headers: { origin: CROSS_ORIGIN },
      form: { title: `${csrfTitle}-anon`, body: 'x', category: 'COMMON', intent: 'draft' },
      maxRedirects: 0,
    })
    // 認証チェックが先行するため 303。403 でも防御としては妥当なので双方許容する。
    expect([303, 403]).toContain(save.status())

    const del = await request.post(ADMIN_API.newsDelete, {
      headers: { origin: CROSS_ORIGIN },
      form: { id: 'nonexistent-id' },
      maxRedirects: 0,
    })
    expect([303, 403]).toContain(del.status())
  })
})

/**
 * PT2-06（SEC-024）— **JSON 管理 API 3ハンドラ**の CSRF 防御（同一オリジン検証）。
 *
 * 背景: SEC-011 の是正（`lib/http-guard.ts` の `isSameOrigin`）は `save` / `delete` の
 * form POST 2本にしか適用されず、**同じ副作用を持つ JSON API 3本**
 * （`POST /api/admin/news`, `PUT`・`DELETE /api/admin/news/[id]`）は検証していない。
 * SEC-011 が問題視した「防御が Cookie の `sameSite` 既定値のみに依存する」状態が、これらの
 * ハンドラでは丸ごと残っている（`app/api/admin/news/route.ts:29` / `[id]/route.ts:32,55`）。
 *
 * とくに `POST /api/admin/news` は `request.json()` が Content-Type を検証しないため、
 * `Content-Type: text/plain`（CORS セーフリスト値・プリフライト無し）の単純リクエストとして
 * クロスサイトから到達できる形をしている。
 *
 * 検証する契約:
 *   - 認証済み × クロスオリジン → **403**（作成/更新/削除は行われない）
 *   - 認証済み × Origin 欠落 → **403**（fail-closed）
 *   - 認証済み × 同一オリジン → **従来どおり成功**（POST=201 / PUT=200 / DELETE=200）
 *   - 認証済み × 同一オリジン × 非 JSON Content-Type → 拒否（単純リクエスト化の余地を塞ぐ）
 *
 * red の期待: 現在は Origin を一切見ないため、クロスオリジンでも 201/200 が返り副作用が起きる。
 *
 * 実装の注意（SEC-024 修正方針3）: 5 ハンドラ（form 2 + JSON 3）で認可・Origin 検証・存在確認の
 * 順序を統一し、共通ラッパ（例 `withAdminMutation(handler)`）に括り出すこと。手動適用のままでは
 * P3 でハンドラが増えたときに再び漏れる。なお既存の PT2-01（未認証 → 401/403）は認可・Origin の
 * どちらを先に評価しても通る（`[401, 403]` を許容している）。
 *
 * データ衛生: タイトルは `CSRF_TITLE_PREFIX` を付け、ファイル冒頭の afterAll で掃除される。
 */
test.describe.serial('PT2-06: JSON 管理 API のクロスオリジン変更は拒否される（SEC-024）', () => {
  const stamp = Date.now()
  let jsonTitle: string
  let origin: string
  let createdId: string | null = null

  test.beforeAll(async ({}, testInfo) => {
    jsonTitle = `${CSRF_TITLE_PREFIX}JSON-API ${workerTag(testInfo.workerIndex)}${testInfo.project.name}-${stamp}`
  })

  test.beforeEach(async ({ page }) => {
    const login = new AdminLoginPage(page)
    await login.goto()
    await login.login(ADMIN_CREDENTIALS.email, ADMIN_CREDENTIALS.password)
    await expect(page).toHaveURL(/\/admin$/)
    origin = new URL(page.url()).origin
  })

  const payload = (title: string) => ({
    title,
    body: '本文',
    category: 'COMMON',
    status: 'DRAFT',
    publishedAt: null,
  })

  test('認証済み × 不正 Origin の POST /api/admin/news は 403（作成されない）', async ({ page }) => {
    const title = `${jsonTitle}-cross-post`
    const res = await page.request.post(ADMIN_API.news, {
      headers: { origin: CROSS_ORIGIN },
      data: payload(title),
    })

    expect(res.status(), `expected 403 for cross-origin POST, got ${res.status()}`).toBe(403)

    const created = await withPrisma((prisma) => prisma.news.findFirst({ where: { title } }))
    expect(created, 'クロスオリジンの POST で記事が作成されてはならない').toBeNull()
  })

  test('認証済み × Origin 欠落の POST /api/admin/news も 403（fail-closed）', async ({ page }) => {
    const title = `${jsonTitle}-no-origin`
    const res = await page.request.post(ADMIN_API.news, { data: payload(title) })

    expect(res.status()).toBe(403)

    const created = await withPrisma((prisma) => prisma.news.findFirst({ where: { title } }))
    expect(created).toBeNull()
  })

  test('認証済み × 同一 Origin の POST /api/admin/news は従来どおり 201 で作成される', async ({
    page,
  }) => {
    const res = await page.request.post(ADMIN_API.news, {
      headers: { origin },
      data: payload(jsonTitle),
    })

    expect(res.status(), `expected 201 for same-origin POST, got ${res.status()}`).toBe(201)
    const json = (await res.json()) as { data: { id: string } }
    createdId = json.data.id
    expect(createdId).toBeTruthy()

    const created = await withPrisma((prisma) =>
      prisma.news.findFirst({ where: { title: jsonTitle } }),
    )
    expect(created, '同一オリジンの POST は従来どおり成功しなければならない').not.toBeNull()
  })

  test('認証済み × 不正 Origin の PUT /api/admin/news/[id] は 403（更新されない）', async ({
    page,
  }) => {
    expect(createdId, '前テストで作成された記事が必要').toBeTruthy()

    const res = await page.request.put(ADMIN_API.newsById(createdId!), {
      headers: { origin: CROSS_ORIGIN },
      data: {
        ...payload(`${jsonTitle}-tampered`),
        status: 'PUBLISHED',
        publishedAt: '2026-07-20T01:00:00.000Z',
      },
    })

    expect(res.status(), `expected 403 for cross-origin PUT, got ${res.status()}`).toBe(403)

    const row = await withPrisma((prisma) => prisma.news.findUnique({ where: { id: createdId! } }))
    expect(row?.title, 'クロスオリジンの PUT で内容が書き換わってはならない').toBe(jsonTitle)
    expect(row?.status, 'クロスオリジンの PUT で公開状態が変わってはならない').toBe('DRAFT')
  })

  test('認証済み × 同一 Origin の PUT /api/admin/news/[id] は従来どおり 200 で更新される', async ({
    page,
  }) => {
    expect(createdId).toBeTruthy()

    const res = await page.request.put(ADMIN_API.newsById(createdId!), {
      headers: { origin },
      data: payload(`${jsonTitle}-updated`),
    })

    expect(res.status(), `expected 200 for same-origin PUT, got ${res.status()}`).toBe(200)

    const row = await withPrisma((prisma) => prisma.news.findUnique({ where: { id: createdId! } }))
    expect(row?.title, '同一オリジンの PUT は従来どおり成功しなければならない').toBe(
      `${jsonTitle}-updated`,
    )
  })

  test('認証済み × 不正 Origin の DELETE /api/admin/news/[id] は 403（削除されない）', async ({
    page,
  }) => {
    expect(createdId).toBeTruthy()

    const res = await page.request.delete(ADMIN_API.newsById(createdId!), {
      headers: { origin: CROSS_ORIGIN },
    })

    expect(res.status(), `expected 403 for cross-origin DELETE, got ${res.status()}`).toBe(403)

    const row = await withPrisma((prisma) => prisma.news.findUnique({ where: { id: createdId! } }))
    expect(row, 'クロスオリジンの DELETE で記事が削除されてはならない').not.toBeNull()
  })

  test('認証済み × 同一 Origin の DELETE /api/admin/news/[id] は従来どおり 200 で削除される', async ({
    page,
  }) => {
    expect(createdId).toBeTruthy()

    const res = await page.request.delete(ADMIN_API.newsById(createdId!), {
      headers: { origin },
    })

    expect(res.status(), `expected 200 for same-origin DELETE, got ${res.status()}`).toBe(200)

    const row = await withPrisma((prisma) => prisma.news.findUnique({ where: { id: createdId! } }))
    expect(row, '同一オリジンの DELETE は従来どおり成功しなければならない').toBeNull()
  })

  test('同一 Origin でも Content-Type が JSON でない POST は拒否される（単純リクエスト化の封じ）', async ({
    page,
  }) => {
    const title = `${jsonTitle}-text-plain`
    const res = await page.request.post(ADMIN_API.news, {
      headers: { origin, 'content-type': 'text/plain' },
      data: JSON.stringify(payload(title)),
    })

    // 400（invalid json 扱い）でも 415（Unsupported Media Type）でも防御としては妥当。
    expect(
      [400, 415],
      `expected non-JSON content-type to be rejected, got ${res.status()}`,
    ).toContain(res.status())

    const created = await withPrisma((prisma) => prisma.news.findFirst({ where: { title } }))
    expect(created, 'text/plain の単純リクエストで記事が作成されてはならない').toBeNull()
  })

  test('GET /api/admin/news はクロスオリジンでも従来どおり動く（参照系は Origin 検証の対象外）', async ({
    page,
  }) => {
    const res = await page.request.get(ADMIN_API.news, { headers: { origin: CROSS_ORIGIN } })
    expect(res.status(), '副作用の無い GET まで壊さないこと').toBe(200)
  })

  test.afterAll(async () => {
    if (!createdId) return
    await withPrisma(async (prisma) => {
      try {
        await prisma.news.deleteMany({ where: { id: createdId! } })
      } catch {
        // best-effort
      }
    })
  })
})
