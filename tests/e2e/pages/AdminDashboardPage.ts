import { type Page, type Locator, expect } from '@playwright/test'
import { ADMIN_ROUTES, ADMIN_TESTID } from './admin-contract'

/**
 * 管理ダッシュボード（F-013）の Page Object。dashboard.md のレイアウトに対応。
 */
export class AdminDashboardPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto() {
    await this.page.goto(ADMIN_ROUTES.dashboard)
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'ダッシュボード' })
  }

  /** 「お知らせ管理」への遷移カード（有効・唯一の実機能, dashboard.md）。 */
  get newsCard(): Locator {
    return this.page.getByTestId(ADMIN_TESTID.dashboardCardNews)
  }

  async expectLoaded() {
    await expect(this.heading).toBeVisible()
    await expect(this.newsCard).toBeVisible()
  }

  async gotoNewsAdmin() {
    await this.newsCard.getByRole('link', { name: /お知らせ/ }).click()
  }
}
