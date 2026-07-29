import { test } from '@playwright/test'
import { CourseComparisonPage } from '../pages/CourseComparisonPage'
import { CourseDetailPage } from '../pages/CourseDetailPage'

/**
 * F-003 コース詳細。US-002。
 * 比較ページの先頭カード「詳細」から遷移し、詳細表示と申込CTAのコース引き継ぎを検証する。
 * （コースIDは cuid でランダムなためハードコードせず、一覧からの遷移で取得する。）
 * 実装後に green を目指す設計（現状は未実装のため red）。
 */
test.describe('F-003: コース詳細', () => {
  test('一覧から詳細へ遷移し、料金・仕様・申込CTAが表示される', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await cmp.openFirstDetail()

    const detail = new CourseDetailPage(page)
    await detail.expectLoaded()
  })

  test('申込CTAが courseId を引き継いでフォームへ向かう（US-002）', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await cmp.openFirstDetail()

    const detail = new CourseDetailPage(page)
    await detail.expectApplyCtaCarriesCourseId()
  })
})
