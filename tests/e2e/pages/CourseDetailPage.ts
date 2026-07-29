import { type Page, type Locator, expect } from '@playwright/test'

/**
 * コース詳細（F-003）の Page Object。course-detail.md DetailHero + SpecTable に対応。
 */
export class CourseDetailPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { level: 1 })
  }

  /** SpecTable は <dl> でマークアップ（course-detail.md アクセシビリティ）。 */
  get specList(): Locator {
    return this.page.locator('dl').first()
  }

  /** 「このコースで申込む」CTA（/apply?courseId=... へ）。 */
  get applyCta(): Locator {
    return this.page.getByRole('link', { name: /申込/ })
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible()
    await expect(this.specList).toBeVisible()
    // 料金（¥ 表記）が詳細に含まれる
    await expect(this.page.getByText(/¥[\d,]+/).first()).toBeVisible()
  }

  async expectApplyCtaCarriesCourseId() {
    const href = await this.applyCta.getAttribute('href')
    expect(href).toBeTruthy()
    expect(href).toContain('courseId=')
  }
}
