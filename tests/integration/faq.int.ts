import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { SEED_COUNTS } from '../fixtures/seed-counts'

/**
 * F-006 — FAQ 読み取り（dev DB, seed 済み）。US-004（P1では読み取り契約のみ検証）。
 * seed 件数（docs/dev-database.md §4）: Faq=11（SCHOOL=4, COURSE=2, PAYMENT=1, OTHER=4, 全 published）。
 */
afterAll(async () => {
  await prisma.$disconnect()
})

describe('F-006: 公開FAQ一覧', () => {
  it('published なFAQは 11件', async () => {
    const count = await prisma.faq.count({ where: { published: true } })
    expect(count).toBe(SEED_COUNTS.faq.published)
  })

  it('4カテゴリ（SCHOOL/COURSE/PAYMENT/OTHER）が揃っている', async () => {
    const rows = await prisma.faq.findMany({
      where: { published: true },
      select: { category: true },
    })
    const categories = new Set(rows.map((r) => r.category))
    expect(categories).toEqual(new Set(['SCHOOL', 'COURSE', 'PAYMENT', 'OTHER']))
  })

  it('sortOrder 昇順で取得できる（表示順の安定性）', async () => {
    const rows = await prisma.faq.findMany({
      where: { published: true },
      orderBy: { sortOrder: 'asc' },
      select: { sortOrder: true },
    })
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].sortOrder).toBeGreaterThanOrEqual(rows[i - 1].sortOrder)
    }
  })
})

describe('F-006: キーワード部分一致検索（question/answer ILIKE）', () => {
  it('"送迎" で送迎バスFAQがヒットする', async () => {
    const rows = await prisma.faq.findMany({
      where: {
        published: true,
        OR: [
          { question: { contains: '送迎', mode: 'insensitive' } },
          { answer: { contains: '送迎', mode: 'insensitive' } },
        ],
      },
    })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.question.includes('送迎バス'))).toBe(true)
  })

  it('E-006-1: 一致しない語では 0件（空状態の根拠）', async () => {
    const rows = await prisma.faq.findMany({
      where: {
        published: true,
        OR: [
          { question: { contains: 'ZZZ該当なしZZZ', mode: 'insensitive' } },
          { answer: { contains: 'ZZZ該当なしZZZ', mode: 'insensitive' } },
        ],
      },
    })
    expect(rows.length).toBe(0)
  })
})
