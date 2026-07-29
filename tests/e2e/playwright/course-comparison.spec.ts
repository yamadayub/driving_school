import { test, expect } from '@playwright/test'
import { CourseComparisonPage } from '../pages/CourseComparisonPage'
import { FILTER_CHIP, SEED } from '../pages/contract'

/**
 * F-002 コース・料金 横断比較。US-001。
 * フィルタ操作（校舎×受講形態）で結果件数が変化し、aria-live で通知されることを検証する。
 * 件数は seed（docs/dev-database.md §4）に基づく。初期 受講形態=通学。
 * 実装後に green を目指す設計（現状は未実装のため red）。
 */
test.describe('F-002: コース比較のフィルタ', () => {
  test('初期表示は通学コース（LICENSE 10件）', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await cmp.expectResultCountIsLive()
    await cmp.expectCourseCount(SEED.licenseTsugaku)
  })

  test('受講形態=合宿 に切替えると 1件に絞られる', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await cmp.selectChip(FILTER_CHIP.formatGasshuku)
    await cmp.expectCourseCount(SEED.licenseGasshuku)
  })

  test('校舎=岩滝 × 通学 で 9件（対応校フィルタ）', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await cmp.selectChip(FILTER_CHIP.schoolIwataki)
    await cmp.expectCourseCount(SEED.iwatakiTsugaku)
  })

  test('校舎=網野 × 通学 で 7件', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await cmp.selectChip(FILTER_CHIP.schoolAmino)
    await cmp.expectCourseCount(SEED.aminoTsugaku)
  })

  test('URL同期: ?format=GASSHUKU で初期状態が合宿になる', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto('?format=GASSHUKU')
    await cmp.expectCourseCount(SEED.licenseGasshuku)
  })

  test('結果件数の表示に件数（数字）が含まれる', async ({ page }) => {
    const cmp = new CourseComparisonPage(page)
    await cmp.goto()
    await expect(cmp.resultCount).toContainText(/\d+/)
  })
})
