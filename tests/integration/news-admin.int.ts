import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { SEED_COUNTS } from '../fixtures/seed-counts'
import { TEST_ROW_PREFIX } from '../fixtures/test-rows'
import {
  createNews,
  getNewsById,
  listAdminNews,
  updateNews,
  deleteNews,
  listPublishedNews,
} from '@/lib/news-admin'

/**
 * F-014 / US-012 — お知らせ管理（CMS CRUD）のサーバーロジック（dev DB, seed 済み）。
 * 対象: @/lib/news-admin（Route Handler/Server Action が呼ぶリポジトリ層）。
 *
 * red 理由: news-admin 各関数が未実装（NotImplemented throw）。実装後 green を目指す。
 * 併せて Impl は Prisma enum PublishStatus に UNPUBLISHED を追加＋migrate すること（F-014 実装申し送り）。
 *
 * データ規律: 作成レコードは afterEach で必ず削除し、seed 件数（news.published=6）を汚さない。
 * 全書き込みは news-admin 経由（prisma.news.create を UNPUBLISHED で直接呼ぶと現行 enum 型で
 * type-check が壊れるため。UNPUBLISHED はアプリ側の真実源 @/lib/publish-status で表現）。
 */
const cleanup: string[] = []

async function newDraft(overrides?: Partial<Parameters<typeof createNews>[0]>) {
  const rec = await createNews({
    title: '【テスト】お知らせCRUD',
    body: 'テスト本文',
    category: 'COMMON',
    status: 'DRAFT',
    publishedAt: null,
    ...overrides,
  })
  cleanup.push(rec.id)
  return rec
}

afterEach(async () => {
  if (cleanup.length) {
    await prisma.news.deleteMany({ where: { id: { in: cleanup } } })
    cleanup.length = 0
  }
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('F-014: 作成→取得', () => {
  it('DRAFT を作成し、id で取得できる', async () => {
    const created = await newDraft()
    expect(created.id).toBeTruthy()
    expect(created.status).toBe('DRAFT')

    const fetched = await getNewsById(created.id)
    expect(fetched?.id).toBe(created.id)
    expect(fetched?.title).toBe('【テスト】お知らせCRUD')
  })

  it('管理一覧は DRAFT を含み、status フィルタで絞り込める', async () => {
    const created = await newDraft()
    const all = await listAdminNews()
    expect(all.map((n) => n.id)).toContain(created.id)

    const drafts = await listAdminNews({ status: 'DRAFT' })
    expect(drafts.map((n) => n.id)).toContain(created.id)
    expect(drafts.every((n) => n.status === 'DRAFT')).toBe(true)
  })
})

describe('F-014: ステータス遷移と公開クエリ整合（SPEC-002）', () => {
  it('DRAFT→PUBLISHED で publishedAt 非null・公開クエリに出現する', async () => {
    const created = await newDraft()
    const published = await updateNews(created.id, {
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-20T10:00:00+09:00'),
    })
    expect(published.status).toBe('PUBLISHED')
    expect(published.publishedAt).not.toBeNull()

    const publicList = await listPublishedNews()
    expect(publicList.map((n) => n.id)).toContain(created.id)
  })

  it('PUBLISHED→UNPUBLISHED は公開クエリから除外、管理一覧には残る', async () => {
    const created = await newDraft()
    await updateNews(created.id, {
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-20T10:00:00+09:00'),
    })
    await updateNews(created.id, { status: 'UNPUBLISHED' })

    const publicIds = (await listPublishedNews()).map((n) => n.id)
    expect(publicIds).not.toContain(created.id)

    const unpub = await listAdminNews({ status: 'UNPUBLISHED' })
    expect(unpub.map((n) => n.id)).toContain(created.id)
  })

  it('UNPUBLISHED→PUBLISHED（再公開）で再び公開クエリに出現する', async () => {
    const created = await newDraft()
    await updateNews(created.id, { status: 'UNPUBLISHED' })
    await updateNews(created.id, {
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-21T10:00:00+09:00'),
    })
    const publicIds = (await listPublishedNews()).map((n) => n.id)
    expect(publicIds).toContain(created.id)
  })
})

describe('F-014: 公開クエリは PUBLISHED のみ（DRAFT/UNPUBLISHED 除外, seed=6 を汚さない）', () => {
  it('DRAFT/UNPUBLISHED を作っても公開クエリ件数は seed の 6件のまま', async () => {
    await newDraft() // DRAFT
    const created2 = await newDraft()
    await updateNews(created2.id, {
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-20T10:00:00+09:00'),
    })
    await updateNews(created2.id, { status: 'UNPUBLISHED' }) // 非公開

    const publicList = await listPublishedNews()

    // REV-P3C1-005: **DB 全体を数えない。**
    // `listPublishedNews()` は where 句を受け取らないので、結果を接頭辞で絞ってから数える。
    // 並列で走る `news.int.ts:112-118` は `publishedAt: now - 1分` の **PUBLISHED 行**を作るため、
    // 絞らないと本 assertion が確率的に落ちる（相互汚染。実測で再現済み）。
    // 接頭辞は `【テスト】` ではなく **`【テスト`**。`news.int.ts` の `【テスト-GATE】` が
    // すり抜けると、その describe が作る `publishedAt: now - 1分` の PUBLISHED 行に汚される。
    //
    // NEW-007: **リテラルを二重管理しない。** `news.int.ts` の定義を import して使う
    //（片方だけ接頭辞を変えると、静かにレースが戻り、しかも確率的にしか落ちない）。
    const seedOnly = publicList.filter((n) => !n.title.startsWith(TEST_ROW_PREFIX))
    expect(seedOnly.length).toBe(SEED_COUNTS.news.published)
    expect(publicList.every((n) => n.status === 'PUBLISHED')).toBe(true)
  })
})

describe('PT2-02: 予約公開の時刻ゲート（publishedAt <= now）', () => {
  it('未来日 publishedAt の PUBLISHED 記事は公開クエリに現れない（予約公開）', async () => {
    const created = await newDraft({ title: '【テスト】予約公開（未来日）' })
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // now + 7日
    const scheduled = await updateNews(created.id, {
      status: 'PUBLISHED',
      publishedAt: future,
    })
    expect(scheduled.status).toBe('PUBLISHED')
    expect(scheduled.publishedAt).not.toBeNull()

    // 公開サイトには未来日公開はまだ出さない（F-004: publishedAt <= now() のみ）
    const publicIds = (await listPublishedNews()).map((n) => n.id)
    expect(publicIds).not.toContain(created.id)

    // 管理側では「予約公開」として見える（一覧に残る）
    const adminIds = (await listAdminNews({ status: 'PUBLISHED' })).map((n) => n.id)
    expect(adminIds).toContain(created.id)

    // 公開件数は seed の 6件のまま（未来日は加算されない）
    // REV-P3C1-005 / NEW-007: **ここも DB 全体を数えていた**（レビュー未指摘の同型欠陥）。
    // :124 と同じく seed 行だけに絞る——絞らないと `news.int.ts` の
    // `【テスト-GATE】直近の公開済み`（PUBLISHED / `publishedAt: now - 1分`）に汚される。
    const seedPublished = (await listPublishedNews()).filter(
      (n) => !n.title.startsWith(TEST_ROW_PREFIX),
    )
    expect(seedPublished.length).toBe(SEED_COUNTS.news.published)
  })
})

describe('F-014: 削除', () => {
  it('deleteNews 後は getNewsById が null', async () => {
    const created = await createNews({
      title: '【テスト】削除対象',
      body: '本文',
      category: 'COMMON',
      status: 'DRAFT',
      publishedAt: null,
    })
    await deleteNews(created.id)
    expect(await getNewsById(created.id)).toBeNull()
  })
})
