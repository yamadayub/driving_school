import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { prisma } from '@/lib/db'
import { getLatestNews } from '@/lib/queries'
import { SEED_COUNTS } from '../fixtures/seed-counts'
import { SEED_PUBLISHED_NEWS, TEST_ROW_PREFIX } from '../fixtures/test-rows'

/**
 * F-001 / F-004 / F-005 — お知らせ読み取り（dev DB, seed 済み）。US-003。
 * seed 件数（docs/dev-database.md §4）: News=6（全 PUBLISHED, IWATAKI/AMINO/DRONE/KENKI/COMMON×2）。
 * publishedAt 降順の最新は COMMON「年末年始の休業日のお知らせ」(2026-07-15)。
 */
/**
 * ------------------------------------------------------------------------
 * REV-P3C1-005: **DB 全体を数えない**（テスト間の相互汚染を断つ）
 * ------------------------------------------------------------------------
 * 本ファイルと `news-admin.int.ts` は**並列ワーカーで同時に走り、同じ dev DB を共有する**。
 * どちらも「`status: 'PUBLISHED'` の**全行**」を数えて `SEED_COUNTS` と突き合わせていたため、
 * 相手が作った行が入ると落ちた（**相互汚染**であって片方向ではない）:
 *
 *  - 本ファイル :112-118 は `publishedAt: now - 1分` の **PUBLISHED 行**を作る
 *    → `news-admin.int.ts:114`（`listPublishedNews().length === 6`）を汚す。
 *  - `news-admin.int.ts:117-119` は `publishedAt: 2026-07-20` の行を作る
 *    → 本ファイル :26 の**順序**の assertion（先頭は 2026-07-15）を汚す。
 *    **件数だけでなく順序も壊れる。**
 *
 * 実測: 全 9 ファイルを並列で 3 回回すと 1 回だけ 4 failed になり、
 * 2 ファイルだけを 3 回回すと 3 回とも green（**負荷が低いとレースの窓が開かない**）。
 *
 * したがって「seed 行だけ」を対象にする。接頭辞は `tests/fixtures/test-rows.ts` に置いた
 * （NEW-007: 片方だけリテラルを変えると静かにレースが戻るため）。テストが作る行は**必ず `【テスト` で始まる**
 * ——本ファイル（`【テスト】` / `【テスト-GATE】`）と `news-admin.int.ts`（`【テスト】`）の
 * 両方がその規約に従っている。
 *
 * ⚠️ **閉じ括弧まで含めた `'【テスト】'` を接頭辞にしないこと。**
 * 本ファイル :124 の `【テスト-GATE】` が**すり抜ける**——そしてその describe が作る
 * `publishedAt: now - 1分` の PUBLISHED 行こそが `news-admin.int.ts` を汚す張本人である。
 *
 * ⚠️ **`fileParallelism: false` で直さないこと。** レースを隠すだけで CI が遅くなり、
 * 同型の欠陥（DB 全体を数えるテスト）が今後も足され続ける。
 */
const SEED_PUBLISHED = SEED_PUBLISHED_NEWS

const cleanup: string[] = []

afterAll(async () => {
  if (cleanup.length) {
    await prisma.news.deleteMany({ where: { id: { in: cleanup } } })
  }
  await prisma.$disconnect()
})

describe('F-001: トップ お知らせ最新3件（PUBLISHED, publishedAt desc, take 3）', () => {
  it('公開お知らせは 6件', async () => {
    // REV-P3C1-005: seed 行だけを数える（並列の `news-admin.int.ts` が作る行を含めない）。
    const count = await prisma.news.count({ where: SEED_PUBLISHED })
    expect(count).toBe(SEED_COUNTS.news.published)
  })

  it('最新3件を降順で取得でき、先頭は 2026-07-15 の記事', async () => {
    // REV-P3C1-005: **順序の assertion も汚染される。**
    // `news-admin.int.ts:117-119` が `publishedAt: 2026-07-20` の行を作るため、
    // 絞らないと降順の先頭を奪われる（件数だけを直しても再発する）。
    const latest = await prisma.news.findMany({
      where: SEED_PUBLISHED,
      orderBy: { publishedAt: 'desc' },
      take: SEED_COUNTS.news.latestTake,
    })
    expect(latest.length).toBe(SEED_COUNTS.news.latestTake)
    expect(latest[0].title).toContain('年末年始')
    // 降順であること（publishedAt が単調非増加）
    for (let i = 1; i < latest.length; i++) {
      const prev = latest[i - 1].publishedAt!.getTime()
      const cur = latest[i].publishedAt!.getTime()
      expect(prev).toBeGreaterThanOrEqual(cur)
    }
  })
})

describe('F-004 境界: 下書き(DRAFT)は公開一覧に含まれない（US-003）', () => {
  it('status=DRAFT のお知らせは PUBLISHED クエリに現れない', async () => {
    const draft = await prisma.news.create({
      data: {
        title: '【テスト】下書きニュース',
        body: 'draft body',
        category: 'COMMON',
        status: 'DRAFT',
        publishedAt: null,
      },
    })
    cleanup.push(draft.id)

    // **自分が作った行が現れないこと**が本質の assertion（他ファイルの影響を受けない）。
    const allPublished = await prisma.news.findMany({
      where: { status: 'PUBLISHED' },
      select: { id: true },
    })
    expect(allPublished.map((n) => n.id)).not.toContain(draft.id)

    // 件数は seed 行だけで数える（REV-P3C1-005）。
    expect(await prisma.news.count({ where: SEED_PUBLISHED })).toBe(SEED_COUNTS.news.published)
  })
})

/**
 * PT2-04（SEC-010 / RV-P2-001）— **公開トップが実際に呼ぶ関数**の時刻ゲート。
 *
 * 本テストの存在理由: PT2-02（news-admin.int.ts）は `listPublishedNews` に対して未来日除外を
 * 検証していたが、`app/(public)/page.tsx` が呼ぶのは `lib/queries.ts` の `getLatestNews` であり、
 * そちらには時刻ゲートが無かった（テスト対象の取り違え）。テストが green でも公開経路が守られて
 * いない、という P2 差し戻しの根本原因。したがって **本番経路 `getLatestNews` を直接検証する**。
 *
 * 検証する契約（F-004 / functional-spec §F-004）:
 *   getLatestNews(take) は `status='PUBLISHED'` かつ `publishedAt <= now()` の行のみを
 *   publishedAt 降順で最大 take 件返す。`publishedAt = null` の PUBLISHED は返さない。
 *
 * null を明示的に検証する理由: PostgreSQL の `ORDER BY publishedAt DESC` は既定で **NULLS FIRST**
 * のため、publishedAt が null のまま PUBLISHED になった行は take=3 の**先頭を占有**し、正規の
 * 最新記事を1件押し出す。単なる「含まれない」以上に表示破壊の実害がある。
 *
 * データ規律: seed（published=6）に依存せず、本 describe 内で作成した3行を接頭辞と id で識別し
 * afterAll で必ず削除する。他 describe の厳密件数アサーション（=6）を壊さないよう、作成は
 * ファイル末尾のこの describe の beforeAll 以降に限定している。
 */
describe('PT2-04: 公開トップ getLatestNews の時刻ゲート（SEC-010 / RV-P2-001, 本番経路）', () => {
  // 接頭辞は `tests/fixtures/test-rows.ts` から導く（NEW-007: リテラルの二重管理を作らない）。
  // fixture 自身が「**DB に行を作るテストは必ずこの接頭辞で始めること**」と規約を書いており、
  // ここで直書きすると規約と実際の文字列が静かにずれてレースが戻る。
  const GATE_PREFIX = `${TEST_ROW_PREFIX}-GATE】`
  const gateIds: string[] = []
  let futureId = ''
  let nullId = ''
  let pastId = ''

  beforeAll(async () => {
    const now = Date.now()
    const future = await prisma.news.create({
      data: {
        title: `${GATE_PREFIX}未来日の予約公開`,
        body: '公開予定日より前にトップへ出てはいけない',
        category: 'COMMON',
        status: 'PUBLISHED',
        publishedAt: new Date(now + 7 * 24 * 60 * 60 * 1000), // now + 7日
      },
    })
    const nullPublishedAt = await prisma.news.create({
      data: {
        title: `${GATE_PREFIX}publishedAt が null の公開`,
        body: 'NULLS FIRST で先頭を占有してはいけない',
        category: 'COMMON',
        status: 'PUBLISHED',
        publishedAt: null,
      },
    })
    const past = await prisma.news.create({
      data: {
        title: `${GATE_PREFIX}直近の公開済み`,
        body: 'これは公開されるべき（seed の最新より新しい）',
        category: 'COMMON',
        status: 'PUBLISHED',
        publishedAt: new Date(now - 60 * 1000), // now - 1分
      },
    })
    futureId = future.id
    nullId = nullPublishedAt.id
    pastId = past.id
    gateIds.push(futureId, nullId, pastId)
  })

  afterAll(async () => {
    if (gateIds.length) {
      await prisma.news.deleteMany({ where: { id: { in: gateIds } } })
      gateIds.length = 0
    }
  })

  it('未来日 publishedAt の PUBLISHED は結果に含まれない（予約公開の先出しを防ぐ）', async () => {
    const latest = await getLatestNews(50)
    expect(latest.map((n) => n.id)).not.toContain(futureId)
  })

  it('publishedAt = null の PUBLISHED は結果に含まれない（NULLS FIRST で先頭を奪わない）', async () => {
    const latest = await getLatestNews(50)
    expect(latest.map((n) => n.id)).not.toContain(nullId)
  })

  it('過去日 PUBLISHED は含まれ、既定の take=3 では先頭（最新）に来る', async () => {
    const latest = await getLatestNews()
    expect(latest.length).toBe(SEED_COUNTS.news.latestTake)
    expect(latest.map((n) => n.id)).toContain(pastId)
    // now-1分 は seed の最新（2026-07-15）より新しいため先頭
    expect(latest[0].id).toBe(pastId)
  })

  it('既定の take=3 に未来日・null は一切混入しない', async () => {
    const latest = await getLatestNews()
    const ids = latest.map((n) => n.id)
    expect(ids).not.toContain(futureId)
    expect(ids).not.toContain(nullId)
  })

  it('返却行はすべて publishedAt 非null かつ publishedAt <= now、publishedAt 降順', async () => {
    const latest = await getLatestNews(50)
    const now = Date.now()
    for (const row of latest) {
      expect(row.status).toBe('PUBLISHED')
      expect(row.publishedAt).not.toBeNull()
      expect(row.publishedAt!.getTime()).toBeLessThanOrEqual(now)
    }
    for (let i = 1; i < latest.length; i++) {
      expect(latest[i - 1].publishedAt!.getTime()).toBeGreaterThanOrEqual(
        latest[i].publishedAt!.getTime(),
      )
    }
  })
})
