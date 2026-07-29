import { type Page, type Locator, expect } from '@playwright/test'

/**
 * 学校案内・アクセス（F-007）の Page Object。school-access.md に対応。
 * ページ内アンカー #iwataki / #amino / #access（別ページを作らない）を検証する。
 */
export class SchoolAccessPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto(hash = '') {
    await this.page.goto(`/schools${hash}`)
  }

  schoolHeading(name: string): Locator {
    return this.page.getByRole('heading', { name, exact: true })
  }

  anchor(id: string): Locator {
    return this.page.locator(`#${id}`)
  }

  async expectBothSchools() {
    await expect(this.schoolHeading('岩滝校')).toBeVisible()
    await expect(this.schoolHeading('網野校')).toBeVisible()
  }

  async expectAnchorsExist() {
    await expect(this.anchor('iwataki')).toBeAttached()
    await expect(this.anchor('amino')).toBeAttached()
    await expect(this.anchor('access')).toBeAttached()
  }
}
