import { type Page, type Locator, expect } from '@playwright/test'
import { NAV_ARIA_LABEL, NAV_ITEMS } from './contract'

/**
 * グローバルナビ（layout.md §2）の Page Object。全公開ページで共有される Header ナビを操作する。
 */
export class GlobalNav {
  readonly page: Page
  readonly nav: Locator

  constructor(page: Page) {
    this.page = page
    this.nav = page.getByRole('navigation', { name: NAV_ARIA_LABEL })
  }

  link(label: string): Locator {
    return this.nav.getByRole('link', { name: label, exact: true })
  }

  /** 全ナビ項目が表示され、期待 href を指していることを検証。 */
  async expectAllVisible() {
    for (const item of NAV_ITEMS) {
      const link = this.link(item.label)
      await expect(link).toBeVisible()
      await expect(link).toHaveAttribute('href', item.href)
    }
  }

  async clickNav(label: string) {
    await this.link(label).click()
  }
}
