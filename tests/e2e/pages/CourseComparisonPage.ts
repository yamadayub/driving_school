import { type Page, type Locator, expect } from '@playwright/test'
import { TESTID } from './contract'

/**
 * コース・料金 横断比較（F-002）の Page Object。course-comparison.md に対応。
 * フィルタチップ（校舎/受講形態/免許種別）と結果件数(aria-live)・結果カードを操作する。
 */
export class CourseComparisonPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto(query = '') {
    await this.page.goto(`/courses${query}`)
  }

  /** 結果件数表示（aria-live="polite"）。 */
  get resultCount(): Locator {
    return this.page.getByTestId(TESTID.resultCount)
  }

  get courseCards(): Locator {
    return this.page.getByTestId(TESTID.courseCard)
  }

  /** フィルタチップ（role=radio または aria-pressed ボタン）を accessible name で取得。 */
  chip(name: string): Locator {
    return this.page.getByRole('radio', { name, exact: true })
  }

  async selectChip(name: string) {
    await this.chip(name).click()
  }

  /** 結果件数が n 件になるまで待ち、カード数と一致することを検証。 */
  async expectCourseCount(n: number) {
    await expect(this.courseCards).toHaveCount(n)
  }

  /** 結果件数表示が aria-live を持つこと（course-comparison.md アクセシビリティ）。 */
  async expectResultCountIsLive() {
    await expect(this.resultCount).toHaveAttribute('aria-live', 'polite')
  }

  /** 先頭カードの「詳細」リンクへ遷移し、そのコース詳細URLを返す。 */
  async openFirstDetail(): Promise<string> {
    const first = this.courseCards.first()
    const detailLink = first.getByRole('link', { name: /詳細/ })
    await detailLink.click()
    await this.page.waitForURL(/\/courses\/[^/?#]+/)
    return this.page.url()
  }
}
