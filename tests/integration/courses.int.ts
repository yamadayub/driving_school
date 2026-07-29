import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { SEED_COUNTS } from '../fixtures/seed-counts'

/**
 * F-002 / F-003 / F-022 — 公開コースの読み取り（dev DB, seed 済み）。US-001 / US-002 / US-017。
 * seed 件数（docs/dev-database.md §4）: Course=17（LICENSE=11[通学10+合宿1], DRONE=2, KENKI=1, ADDITIONAL=3）。
 *
 * これらは seed 済みデータに対する読み取り検証のため green を想定。
 * 公開/非公開の境界（US-003準拠のCourse版）は一時レコードを作成→削除して検証する。
 */
const cleanup: string[] = []

afterAll(async () => {
  if (cleanup.length) {
    await prisma.course.deleteMany({ where: { id: { in: cleanup } } })
  }
  await prisma.$disconnect()
})

describe('F-002: 公開 LICENSE コース一覧（比較UI対象）', () => {
  it('published かつ category=LICENSE は 11件', async () => {
    const count = await prisma.course.count({
      where: { published: true, category: 'LICENSE' },
    })
    expect(count).toBe(SEED_COUNTS.course.license.total)
  })

  it('通学(TSUGAKU) LICENSE は 10件 / 合宿(GASSHUKU)は 1件', async () => {
    const [tsugaku, gasshuku] = await Promise.all([
      prisma.course.count({
        where: { published: true, category: 'LICENSE', format: 'TSUGAKU' },
      }),
      prisma.course.count({
        where: { published: true, category: 'LICENSE', format: 'GASSHUKU' },
      }),
    ])
    expect(tsugaku).toBe(SEED_COUNTS.course.license.tsugaku)
    expect(gasshuku).toBe(SEED_COUNTS.course.license.gasshuku)
  })

  it('校舎=岩滝 × 通学 は 9件 / 網野 × 通学 は 7件（対応校フィルタ）', async () => {
    const [iwataki, amino] = await Promise.all([
      prisma.course.count({
        where: {
          published: true,
          category: 'LICENSE',
          format: 'TSUGAKU',
          schools: { has: 'IWATAKI' },
        },
      }),
      prisma.course.count({
        where: {
          published: true,
          category: 'LICENSE',
          format: 'TSUGAKU',
          schools: { has: 'AMINO' },
        },
      }),
    ])
    expect(iwataki).toBe(SEED_COUNTS.course.licenseBySchool.iwatakiTsugaku)
    expect(amino).toBe(SEED_COUNTS.course.licenseBySchool.aminoTsugaku)
  })

  it('LICENSE コースは licenseType/licenseTypeLabel を持つ（RE-03: 非nullを保証）', async () => {
    const courses = await prisma.course.findMany({
      where: { published: true, category: 'LICENSE' },
      select: { licenseType: true, licenseTypeLabel: true },
    })
    expect(courses.every((c) => c.licenseType !== null && c.licenseTypeLabel !== null)).toBe(
      true,
    )
  })
})

describe('F-022: スクール・追加講習（比較UIとは別導線）', () => {
  it('published かつ category ∈ {DRONE,KENKI,ADDITIONAL} は 6件、programLabel を持つ', async () => {
    const programs = await prisma.course.findMany({
      where: {
        published: true,
        category: { in: ['DRONE', 'KENKI', 'ADDITIONAL'] },
      },
      orderBy: { sortOrder: 'asc' },
      select: { category: true, programLabel: true, licenseType: true },
    })
    expect(programs.length).toBe(SEED_COUNTS.course.programs)
    // 非LICENSE は licenseType=null、programLabel は非null（RE-03）
    expect(programs.every((p) => p.licenseType === null && p.programLabel !== null)).toBe(true)
  })
})

describe('F-002 境界: 公開/非公開のフィルタ', () => {
  it('published=false のコースは公開一覧クエリに含まれない', async () => {
    const created = await prisma.course.create({
      data: {
        category: 'LICENSE',
        licenseType: 'ORDINARY',
        licenseTypeLabel: '【テスト】非公開コース',
        transmission: 'AT',
        format: 'TSUGAKU',
        minDays: 14,
        priceFrom: 999999,
        schools: ['IWATAKI'],
        subsidyTags: [],
        published: false,
        sortOrder: 9999,
      },
    })
    cleanup.push(created.id)

    const publishedIds = (
      await prisma.course.findMany({
        where: { published: true, category: 'LICENSE' },
        select: { id: true },
      })
    ).map((c) => c.id)

    expect(publishedIds).not.toContain(created.id)
    // 公開LICENSE件数は非公開を足しても 11 のまま
    expect(publishedIds.length).toBe(SEED_COUNTS.course.license.total)
  })
})
