import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'

/**
 * =========================================================================
 * P3-b 結合テスト — F-008 / F-010 の**本番経路**（`POST /api/applications`）
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-1〜9（:784-792）/ §4.11 AC-RL-3・6・13・14 /
 *       §4.12 AC-PII-1・2 / AC-008-8、`docs/security-audit.md` §E P3b-1・P3b-11。
 *
 * ## ⚠️ 実行前に必ず必要なこと（Impl / オーケストレーター向け）
 * 1. **`Application.statusChangedAt` と `Application.sessionIdHash` のマイグレーションを作成する**
 *    （`docs/phase-status.md` の DB ドリフト注記。**2つを1回のマイグレーションにまとめる**方針で、
 *    作成時期は「P3-b 着手前」と決まっている）。**先に `pnpm db:generate` だけを走らせてはならない**
 *    ——スキーマにあって DB に無い列を Client が知る状態になり、参照した瞬間に実行時エラーになる。
 * 2. dev DB（`scripts/dev-db.sh up` / :5433）が稼働していること。
 *
 * **本ファイルは新カラムを Prisma の型経由で直接参照しない**（`sessionIdHash` を select/where に
 * 書かない）。理由は2つ: (a) Prisma Client 未再生成の現時点でも `pnpm type-check` を緑に保つため、
 * (b) **検証すべきは列の値ではなく「別 Cookie に `receiptNumber` を返さない」という振る舞い**だから
 * （P2 の教訓: 実装の内部ではなく本番経路の観測可能な契約を検証する）。
 *
 * ## RV-P3AF-006（P3-b 着手時に必ず読むこと）
 * 本ファイルは `VERCEL` 環境変数を設定しないため、`resolveClientIp` は **`trusted=false`（縮退構成）**
 * になる。この構成では **`verifyFormSession` 未配線の公開ルートは全リクエスト 403** である
 *（意図した fail-closed）。**「全部 403」を実装の壊れだと誤診しないこと。**
 * 同時にこれは AC-RL-3 (1) が要求する「`trustProxy=false` でも Cookie 軸で上限が効く」の検証環境そのものである。
 */

/** 外部 I/O（Cloudflare / Resend）だけを差し替える。**アプリのロジックは本物を通す。** */
vi.mock('@/lib/turnstile', () => ({
  verifyTurnstile: vi.fn(async () => true),
}))
vi.mock('@/lib/mail', () => ({
  sendMail: vi.fn(async () => {}),
}))

const ORIGIN = 'http://localhost:3000'
const FS_SECRET = 'integration-form-session-secret-32chars'

type RouteModule = typeof import('@/app/api/applications/route')
let route: RouteModule
let formSession: typeof import('@/lib/form-session')
let turnstile: typeof import('@/lib/turnstile')
let mail: typeof import('@/lib/mail')

const createdIdempotencyKeys: string[] = []

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET = FS_SECRET
  formSession = await import('@/lib/form-session')
  turnstile = await import('@/lib/turnstile')
  mail = await import('@/lib/mail')
  route = await import('@/app/api/applications/route')
})

afterEach(async () => {
  vi.mocked(turnstile.verifyTurnstile).mockClear()
  vi.mocked(mail.sendMail).mockClear()
  vi.mocked(turnstile.verifyTurnstile).mockResolvedValue(true)
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

/** 3秒以上前に発行された正規の Cookie。 */
function cookieHeader(sid = randomUUID().replace(/-/g, ''), ageMs = 10_000): string {
  const value = formSession.createFormSessionValue(
    { sid, issuedAt: Date.now() - ageMs },
    FS_SECRET,
  )
  return `${formSession.FORM_SESSION_COOKIE_NAME}=${value}`
}

function inquiryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const idempotencyKey = (overrides.idempotencyKey as string) ?? randomUUID()
  createdIdempotencyKeys.push(idempotencyKey)
  return {
    type: 'INQUIRY',
    idempotencyKey,
    name: '結合 太郎',
    nameKana: 'ケツゴウ タロウ',
    birthDate: '2000-05-05',
    email: 'int-taro@example.com',
    phone: '090-1234-5678',
    firstTime: true,
    referralSources: [],
    message: 'テスト送信',
    privacyConsent: true,
    captchaToken: 'ts-token',
    hp_field: '',
    ...overrides,
  }
}

async function post(
  body: Record<string, unknown> | string,
  init: { cookie?: string; origin?: string | null; contentType?: string | null } = {},
): Promise<Response> {
  const headers = new Headers()
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN)
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  return route.POST(
    new Request(`${ORIGIN}/api/applications`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    undefined as never,
  )
}

async function countByKey(idempotencyKey: string): Promise<number> {
  return prisma.application.count({ where: { idempotencyKey } })
}

/* ========================================================================= *
 * 正常系（土台）
 * ========================================================================= */

describe('F-010 正常系: INQUIRY 経路が単独で完結する（P3-b の完了条件）', () => {
  it('201 で id と receiptNumber を返し、Application が1件できる', async () => {
    // P3-b の完了条件「**INQUIRY 経路が単独で完結して動く**（写真なしでも申込・問い合わせが成立する）」。
    const body = inquiryBody()
    const response = await post(body, { cookie: cookieHeader() })
    // ⚠️ Impl による最小修正（`docs/impl-p3b-notes-2026-07-29.md` §2）:
    //   `expect(actual, message)` の第2引数は**先に評価される**ため、元の
    //   `await response.text()` が本文を消費し、次行の `response.json()` が必ず
    //   `Body is unusable: Body has already been read` で落ちていた（実装に依らず常に失敗する）。
    //   失敗時の診断メッセージという意図は保ったまま、`clone()` で本文を残す。
    expect(response.status, await response.clone().text().catch(() => '')).toBe(201)

    const json = (await response.json()) as { id: string; receiptNumber: string }
    expect(json.id).toBeTruthy()
    expect(json.receiptNumber).toHaveLength(26)
    expect(await countByKey(body.idempotencyKey as string)).toBe(1)
  })

  it('自動返信メールが1通送られる', async () => {
    await post(inquiryBody(), { cookie: cookieHeader() })
    expect(vi.mocked(mail.sendMail)).toHaveBeenCalledTimes(1)
  })
})

/* ========================================================================= *
 * AC-010-1 / E-010-6: type 逸脱
 * ========================================================================= */

describe('AC-010-1: INQUIRY で申込専用項目を送ると 422 かつ DB 0件', () => {
  it.each([
    ['licenseRevoked', false],
    ['licensePhotos', [{ objectKey: 'k', uploadToken: 't', side: 'front' }]],
    ['address', '京都府宮津市字文珠1'],
    ['plans', ['ORDINARY_AT']],
  ])('%s を送ると 422 でレコードが作られない', async (field, value) => {
    // これが green なら排除される攻撃: INQUIRY を名乗って免許取消歴・住所・写真トークンを注入し、
    // **最小収集原則（APPI / business §4.3）を回避して機微情報を保存させる**こと。
    // **ユニット（バリデータ）が正しくても、ハンドラが結果を無視していれば DB には入る**
    //（P2 の「テスト対象の取り違え」）。ここは本番経路で件数を数える。
    const body = inquiryBody({ [field]: value })
    const response = await post(body, { cookie: cookieHeader() })
    expect(response.status).toBe(422)
    expect(await countByKey(body.idempotencyKey as string)).toBe(0)
    expect(vi.mocked(mail.sendMail), 'メールも送らない').not.toHaveBeenCalled()
  })
})

/* ========================================================================= *
 * AC-010-2: 料金スナップショット
 * ========================================================================= */

describe('AC-010-2: 料金はクライアント送信値を一切使わない', () => {
  it('クライアントが priceFrom: 1 を送っても、保存値は DB のコース料金', async () => {
    // これが green なら排除される攻撃: 送信ボディに `priceFrom: 1` を入れて
    // **「1円で申し込んだ」記録**を作ること。受信管理（F-017）の表示と請求根拠が汚染される。
    const course = await prisma.course.findFirst({ where: { published: true } })
    expect(course, 'seed 済みの公開コースが必要（scripts/dev-db.sh + pnpm db:seed）').toBeTruthy()

    const body = inquiryBody({
      type: 'APPLICATION',
      plans: ['ORDINARY_AT'],
      courseId: course!.id,
      school: 'IWATAKI',
      format: 'TSUGAKU',
      postalCode: '6260001',
      address: '京都府宮津市字文珠1',
      licenseRevoked: false,
      currentLicenses: [],
      priceFrom: 1,
      priceFromSnapshot: 1,
      courseNameSnapshot: '偽のコース名',
    })
    const response = await post(body, { cookie: cookieHeader() })
    expect(response.status).toBe(201)

    const saved = await prisma.application.findUnique({
      where: { idempotencyKey: body.idempotencyKey as string },
      select: { priceFromSnapshot: true, courseNameSnapshot: true },
    })
    expect(saved?.priceFromSnapshot).toBe(course!.priceFrom)
    expect(saved?.courseNameSnapshot).not.toBe('偽のコース名')
  })
})

/* ========================================================================= *
 * AC-010-3 / SPEC-012: ハニーポット
 * ========================================================================= */

describe('AC-010-3: ハニーポット非空は Tier B・DB 0件・メール 0通', () => {
  it('403 { challenge: "interactive" } を返し、レコードもメールも作らない', async () => {
    // これが green なら排除される攻撃: 罠に掛かった bot の送信が DB に残り、
    // **自動返信メールの送信元として当校のドメインが使われる**こと。
    // 同時に「静かに拒否」を採らないことも固定する——正常応答と区別できない応答では
    // UI が何も表示できず、誤検知された正規利用者（特に支援技術利用者）が
    // **原因不明の失敗**に遭う（AC-010-3 が明示的に却下した設計）。
    const body = inquiryBody({ hp_field: 'http://spam.example.com' })
    const response = await post(body, { cookie: cookieHeader() })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(await countByKey(body.idempotencyKey as string)).toBe(0)
    expect(vi.mocked(mail.sendMail)).not.toHaveBeenCalled()
  })

  it('ハニーポット由来であることが応答から区別できない（Cookie 不在の Tier B と同一）', async () => {
    // 契約ルール3。**bot に判定基準を教えない。**
    const honeypot = await post(inquiryBody({ hp_field: 'x' }), { cookie: cookieHeader() })
    const noCookie = await post(inquiryBody())

    expect(honeypot.status).toBe(noCookie.status)
    expect(await honeypot.json()).toEqual(await noCookie.json())
    expect(honeypot.headers.get('retry-after')).toBe(noCookie.headers.get('retry-after'))
  })
})

/* ========================================================================= *
 * AC-010-4 / SPEC-017: 冪等性と sid 照合
 * ========================================================================= */

describe('AC-010-4: 冪等再送は idempotencyKey かつ sid の一致で判定する', () => {
  it('(a) 同一 Cookie の再送は 200 + idempotent:true + receiptNumber を返し、DB は1件のまま', async () => {
    const cookie = cookieHeader()
    const body = inquiryBody()
    const first = await post(body, { cookie })
    expect(first.status).toBe(201)
    const created = (await first.json()) as { id: string; receiptNumber: string }

    const second = await post(body, { cookie })
    expect(second.status).toBe(200)
    const repeat = (await second.json()) as Record<string, unknown>
    expect(repeat.idempotent).toBe(true)
    expect(repeat.receiptNumber).toBe(created.receiptNumber)
    expect(await countByKey(body.idempotencyKey as string)).toBe(1)
  })

  it('(b) 別 Cookie から同一 idempotencyKey を提示しても receiptNumber を返さない', async () => {
    // **AC-010-4 の中心。** これが green なら排除される攻撃:
    // sessionStorage の下書き・共有端末から漏れた `idempotencyKey` を第三者が提示し、
    // **他人の受付番号と id を取得する**こと。F-017 / F-018 が将来 `receiptNumber` を
    // 鍵にした瞬間、これは IDOR の入口になる。
    const body = inquiryBody()
    await post(body, { cookie: cookieHeader('a'.repeat(32)) })

    const response = await post(body, { cookie: cookieHeader('b'.repeat(32)) })
    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.idempotent).toBe(true)
    expect(json.receiptNumber, '別 Cookie に受付番号を返している').toBeUndefined()
    expect(json.id, '別 Cookie に id を返している').toBeUndefined()
    expect(await countByKey(body.idempotencyKey as string)).toBe(1)
  })

  it('(c) Cookie を送らない再送は Tier B（403）で止まり、冪等照合に到達しない', async () => {
    // AC-RL-13(b) が先に効くこと。**順序が逆だと、Cookie 無しで冪等照合の入口に立てる。**
    const body = inquiryBody()
    await post(body, { cookie: cookieHeader() })

    const response = await post(body)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
  })

  it('(d) sessionIdHash を持たない既存行への再送では receiptNumber を返さない', async () => {
    // **AC-010-4 が名指しで禁じている状態**: 「`sessionIdHash` が `null`（＝値を持たない既存行）を
    // 『誰でも一致』にしない」。マイグレーション直後の既存行はすべて null であり、
    // ここを緩めると**移行期間中は誰でも他人の受付番号を引ける**。
    //
    // ⚠️ 本テストは `sessionIdHash` を**書かずに**行を作る（Prisma の型を通さないため、
    // Client 未再生成でも type-check が通る）。
    const idempotencyKey = randomUUID()
    createdIdempotencyKeys.push(idempotencyKey)
    await prisma.application.create({
      data: {
        receiptNumber: `TEST${Date.now()}${Math.floor(Math.random() * 1000)}`,
        idempotencyKey,
        type: 'INQUIRY',
        plans: [],
        name: 'レガシー 行',
        nameKana: 'レガシー ギョウ',
        birthDate: new Date('2000-01-01'),
        email: 'legacy@example.com',
        phone: '09011112222',
        currentLicenses: [],
        referralSources: [],
        privacyConsent: true,
      },
    })

    const response = await post(inquiryBody({ idempotencyKey }), { cookie: cookieHeader() })
    expect(response.status).toBe(200)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.receiptNumber).toBeUndefined()
    expect(json.id).toBeUndefined()
  })

  it('並行2リクエストでも二重登録せず、片方は 200 に変換される', async () => {
    // これが green なら排除される壊れた実装: 一意制約違反（P2002）を 500 にしてしまい、
    // **利用者が「送信に失敗しました」を見て再送し、さらに 500 を受ける**こと。
    const cookie = cookieHeader()
    const body = inquiryBody()
    const [a, b] = await Promise.all([post(body, { cookie }), post(body, { cookie })])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(await countByKey(body.idempotencyKey as string)).toBe(1)
  })
})

/* ========================================================================= *
 * AC-RL-3 / AC-RL-6 / AC-RL-13: 縮退構成での防御
 * ========================================================================= */

describe('AC-RL-3: trustProxy=false（縮退）でも防御が残る', () => {
  it('(1) 同一 Cookie からの 4回目の送信が Tier D（429）になる', async () => {
    // 監査 D-1 の実測（500回送信 → 201×500）が再現しないことの確認。
    // ⚠️ AC-RL-3 は「同一 Cookie の4回目が拒否される**だけ**をテストにしてはならない」と
    // 明記している。(2)(3) を必ず併せて見ること（下の2本）。
    const cookie = cookieHeader()
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await post(inquiryBody(), { cookie })).status)
    }
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201])
    expect(statuses.slice(3), '4回目以降は 429').toEqual([429, 429])
  })

  it('(1b) Tier D の応答は Retry-After ヘッダと retryAfterMs を持つ', async () => {
    const cookie = cookieHeader()
    let last: Response | null = null
    for (let i = 0; i < 4; i++) last = await post(inquiryBody(), { cookie })
    expect(last!.status).toBe(429)
    expect(last!.headers.get('retry-after')).toBeTruthy()
    expect((await last!.json()) as Record<string, unknown>).toHaveProperty('retryAfterMs')
  })

  it('(2) Cookie を送らないリクエストは素通りせず Tier B（403）で、Application が作られない', async () => {
    const body = inquiryBody()
    const response = await post(body)
    expect(response.status).toBe(403)
    expect(await countByKey(body.idempotencyKey as string)).toBe(0)
  })

  it('署名が壊れた Cookie / 期限切れ Cookie も Tier B', async () => {
    // 攻撃者は Cookie の中身を自由に決められる。**署名検証を通らない値で軸を作らせない。**
    const tampered = `${formSession.FORM_SESSION_COOKIE_NAME}=${'a'.repeat(20)}.${'b'.repeat(43)}`
    const expired = cookieHeader(randomUUID().replace(/-/g, ''), 1_900_000)
    for (const cookie of [tampered, expired]) {
      const response = await post(inquiryBody(), { cookie })
      expect(response.status, cookie.slice(0, 30)).toBe(403)
      expect(await response.json()).toEqual({ challenge: 'interactive' })
    }
  })
})

describe('AC-RL-6: 送信間隔下限はサーバーの issuedAt だけで判定する', () => {
  it('Cookie 発行から 3秒未満の送信は Tier B（403）で Application が作られない', async () => {
    const body = inquiryBody()
    const response = await post(body, { cookie: cookieHeader(undefined, 500) })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(await countByKey(body.idempotencyKey as string)).toBe(0)
  })

  it('(a) クライアントが formRenderedAt 相当を偽装しても判定が変わらない', async () => {
    // **AC-RL-6 (a) そのもの。** これが green なら排除される攻撃:
    // ボディに古い時刻を入れて送信間隔下限をすり抜けること。
    // サーバーは受け取っても無視する（Cookie 内の署名済み `issuedAt` だけを見る）。
    const body = inquiryBody({
      formRenderedAt: Date.now() - 600_000,
      mountedAt: Date.now() - 600_000,
      clientNow: Date.now() - 600_000,
    })
    const response = await post(body, { cookie: cookieHeader(undefined, 500) })
    expect(response.status, 'クライアント値で送信間隔判定が変わっている').toBe(403)
  })
})

/* ========================================================================= *
 * AC-RL-14: 自動返信メールの宛先別スロットル
 * ========================================================================= */

describe('AC-RL-14: 同一宛先への自動返信は 3通/時、受付は 4件とも成立する', () => {
  it('4件受け付けてもメールは3通まで', async () => {
    // これが green なら排除される攻撃: 「Cookie を取り直しながら被害者のメールアドレスで
    // 送信を繰り返す」ことで、当校から第三者へメールを送り続けること。
    // **同時に「受付は宛先に依存せず常に行う」ことも固定する**——受付を止めると
    // 第三者が他人の申込を妨害できる（SEC-021 と同型）ため、AC-RL-14 は
    // 「止めるのはメールだけ」と定めている。
    const email = `throttle-${Date.now()}@example.com`
    const bodies = Array.from({ length: 4 }, () => inquiryBody({ email }))
    const statuses: number[] = []
    for (const body of bodies) {
      // Cookie 軸（3回/10分）に当たらないよう毎回別 Cookie を使う。
      statuses.push((await post(body, { cookie: cookieHeader() })).status)
    }

    expect(statuses, '受付は4件とも成立する').toEqual([201, 201, 201, 201])
    expect(vi.mocked(mail.sendMail), '同一宛先への4通目は送らない').toHaveBeenCalledTimes(3)
    for (const body of bodies) {
      expect(await countByKey(body.idempotencyKey as string)).toBe(1)
    }
  })
})

/* ========================================================================= *
 * Turnstile / AC-PII-1 / AC-PII-2 / AC-008-8
 * ========================================================================= */

describe('Tier B: Turnstile 未検証は 403 { challenge }', () => {
  it('検証に失敗すると Application が作られない', async () => {
    vi.mocked(turnstile.verifyTurnstile).mockResolvedValue(false)
    const body = inquiryBody()
    const response = await post(body, { cookie: cookieHeader() })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(await countByKey(body.idempotencyKey as string)).toBe(0)
  })

  it('Turnstile 検証にトークンが渡っている（検証を呼ばずに通していない）', async () => {
    await post(inquiryBody({ captchaToken: 'probe-token' }), { cookie: cookieHeader() })
    expect(vi.mocked(turnstile.verifyTurnstile)).toHaveBeenCalled()
    expect(vi.mocked(turnstile.verifyTurnstile).mock.calls[0][0]).toBe('probe-token')
  })
})

describe('AC-PII-2 / AC-008-6: エラー応答に入力値を返さない（本番経路）', () => {
  it('不正なメールアドレスを送っても、応答本文にその文字列が現れない', async () => {
    // ユニット（バリデータ）で固定済みだが、**ハンドラが独自にメッセージを足す**経路がある。
    // これが green なら排除される事故: `NextResponse.json({ errors, received: body })` のような
    // デバッグ用の追記が本番へ残ること。
    const probe = 'pii-echo-probe-zzq@@example.com'
    const body = inquiryBody({ email: probe, name: '反射検出用ZZQ' })
    const response = await post(body, { cookie: cookieHeader() })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain('ZZQ')
    expect(text).not.toContain(probe)
  })
})

describe('AC-008-8: 年齢下限はサーバー受信日（JST）で判定する', () => {
  it('年齢下限未満は 400 / AGE_BELOW_MIN で、応答に生年月日が現れない', async () => {
    const birthDate = '2020-01-01'
    const body = inquiryBody({ birthDate })
    const response = await post(body, { cookie: cookieHeader() })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('AGE_BELOW_MIN')
    expect(text, 'エラー応答に生年月日を含めない（SPEC-007 / AC-PII-2）').not.toContain(birthDate)
    expect(await countByKey(body.idempotencyKey as string)).toBe(0)
  })

  it('クライアントが基準日を送っても判定が変わらない', async () => {
    // これが green なら排除される攻撃: `today` / `clientDate` を未来日にして年齢下限を回避すること。
    const body = inquiryBody({ birthDate: '2020-01-01', today: '2040-01-01', clientDate: '2040-01-01' })
    const response = await post(body, { cookie: cookieHeader() })
    expect(response.status).toBe(400)
  })
})

/* ========================================================================= *
 * AC-RL-7 / P3b-8: ラッパの評価順序とボディ上限（本番経路）
 * ========================================================================= */

describe('AC-RL-7 / P3b-8: ラッパが本番経路で効いている', () => {
  it('Origin 欠落は 403（challenge を含まない = Tier B ではない）', async () => {
    const response = await post(inquiryBody(), { cookie: cookieHeader(), origin: null })
    expect(response.status).toBe(403)
    const json = (await response.json()) as Record<string, unknown>
    expect(json.challenge, 'CSRF 失敗に CAPTCHA を出させない（契約ルール7）').toBeUndefined()
  })

  it('クロスオリジンの Origin は 403', async () => {
    const response = await post(inquiryBody(), {
      cookie: cookieHeader(),
      origin: 'https://evil.example',
    })
    expect(response.status).toBe(403)
  })

  it('Content-Type が JSON でなければ 415（単純リクエスト化の封じ）', async () => {
    const response = await post(inquiryBody(), {
      cookie: cookieHeader(),
      contentType: 'text/plain;charset=UTF-8',
    })
    expect(response.status).toBe(415)
  })

  it('巨大なボディは 413 で、DB に到達しない', async () => {
    // P3b-8。これが green なら排除される攻撃: 数 MB の JSON を送りつけて
    // **パースとバリデーションの CPU / メモリを未認証の攻撃者に消費させる**こと。
    const idempotencyKey = randomUUID()
    createdIdempotencyKeys.push(idempotencyKey)
    const huge = JSON.stringify({ ...inquiryBody({ idempotencyKey }), padding: 'x'.repeat(200_000) })
    const response = await post(huge, { cookie: cookieHeader() })
    expect(response.status).toBe(413)
    expect(await countByKey(idempotencyKey)).toBe(0)
  })

  it('壊れた JSON は 400 であり 500 ではない', async () => {
    // これが green なら排除される攻撃: `request.json()` の例外がそのまま 500 になり、
    // **未認証の第三者が任意にサーバーエラーを起こせる**こと（SEC-042 と同じ形）。
    const response = await post('{"type":"INQUIRY",', { cookie: cookieHeader() })
    expect(response.status).toBe(400)
  })

  it('非 UTF-8 として不正なバイト列を含むボディでも 500 にならない（重複しない別ケース）', async () => {
    // **SEC-042 の教訓（入力の選び方）を本番経路にも適用する。**
    const headers = new Headers({
      origin: ORIGIN,
      'content-type': 'application/json',
      cookie: cookieHeader(),
    })
    const invalid = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    const response = await route.POST(
      new Request(`${ORIGIN}/api/applications`, { method: 'POST', headers, body: invalid }),
      undefined as never,
    )
    expect([400, 422]).toContain(response.status)
  })
})

/* ========================================================================= *
 * AC-PII-1 / AC-010-7: 本番経路のログに個人情報が出ない
 * ========================================================================= */

describe('AC-PII-1 / AC-010-7: 送信処理のログに個人情報が現れない', () => {
  /** 実行中のすべてのコンソール出力を集める（ロガーの実装に依存しない観測点）。 */
  async function captureConsole(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = []
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        chunks.push(args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg))).join(' '))
      }),
    )
    try {
      await run()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    return chunks.join('\n')
  }

  function safeStringify(value: unknown): string {
    const seen = new WeakSet<object>()
    try {
      return JSON.stringify(
        value,
        (_key, item: unknown) => {
          if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
          if (typeof item === 'object' && item !== null) {
            if (seen.has(item)) return '[circular]'
            seen.add(item)
          }
          return item
        },
      ) ?? String(value)
    } catch {
      return String(value)
    }
  }

  const PII = {
    name: 'ログ検出用ZZQ太郎',
    nameKana: 'ログケンシュツヨウタロウ',
    email: 'log-probe-zzq@example.com',
    phone: '090-7777-8888',
    birthDate: '2000-05-05',
    address: '京都府ZZQ町9-9-9',
    postalCode: '9990001',
  }

  it('正常系・バリデーション失敗・ハニーポット・Tier B のいずれでも PII が出力されない', async () => {
    // **AC-PII-1 が要求する「ロガーをスパイし禁止項目が引数に現れないことを検証する」の本番経路版。**
    // これが green なら排除される事故:
    //  (1) `console.log(body)` / `logger.info('received', { input })` のようなデバッグ出力が本番へ残る、
    //  (2) **例外・スタックトレース経由の混入**（Prisma / zod / Resend はいずれも入力値を
    //      例外メッセージに含める）。AC-PII-1 はこれも明示的に対象としている。
    // Vercel のログは運用者以外にも見えうる場所へ流れるため、ここが漏れると
    // 「保持期間3年」の約束の外側に個人情報の複製が残る。
    const output = await captureConsole(async () => {
      const cookie = cookieHeader()
      await post(inquiryBody({ ...PII }), { cookie })                      // 正常系
      await post(inquiryBody({ ...PII, email: 'bad@@' }), { cookie })      // 400
      await post(inquiryBody({ ...PII, hp_field: 'spam' }), { cookie })    // Tier B（ハニーポット）
      await post(inquiryBody({ ...PII }))                                  // Tier B（Cookie 不在）
      await post(inquiryBody({ ...PII, plans: ['X'] }), { cookie })        // 422
    })

    for (const [field, value] of Object.entries(PII)) {
      expect(output.includes(value), `ログに ${field} が出力された`).toBe(false)
    }
    expect(output).not.toContain('ZZQ')
  })

  it('ハニーポットの充填値そのものをログに残さない（SPEC-012 / Designer I-5）', async () => {
    // 記録してよいのは「`hp_field` が非空だった」という**事実**と発信元情報のハッシュのみ。
    const filled = 'hp-probe-zzq-http://spam.example.com/buy'
    const output = await captureConsole(async () => {
      await post(inquiryBody({ hp_field: filled }), { cookie: cookieHeader() })
    })
    expect(output).not.toContain(filled)
    expect(output).not.toContain('spam.example.com')
  })

  it('sid（フォームセッション識別子）をログに残さない', async () => {
    // AC-PII-1 は `sid` と `sessionIdHash` を禁止項目に含めている（SPEC-017）。
    // `sid` は資格情報的な性質を持つため、ログから拾えると冪等再送に成りすませる。
    const sid = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const output = await captureConsole(async () => {
      await post(inquiryBody(), { cookie: cookieHeader(sid) })
      await post(inquiryBody(), { cookie: cookieHeader(sid) })
    })
    expect(output).not.toContain(sid)
  })
})
