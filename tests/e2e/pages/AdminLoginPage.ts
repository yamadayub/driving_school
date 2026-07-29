import { type Page, type Locator, expect } from '@playwright/test'
import { ADMIN_ROUTES, ADMIN_A11Y } from './admin-contract'

/**
 * 管理者ログイン（F-012）の Page Object。login.md のフォーム仕様に対応。
 */
export class AdminLoginPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto() {
    await this.page.goto(ADMIN_ROUTES.login)
  }

  get emailInput(): Locator {
    return this.page.getByLabel(ADMIN_A11Y.loginEmailLabel)
  }

  get passwordInput(): Locator {
    // 「パスワードを表示」トグルの aria-label と衝突しないよう exact 指定
    return this.page.getByLabel(ADMIN_A11Y.loginPasswordLabel, { exact: true })
  }

  get submitButton(): Locator {
    return this.page.getByRole('button', { name: ADMIN_A11Y.loginSubmit })
  }

  get errorAlert(): Locator {
    return this.page.getByRole('alert')
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email)
    await this.passwordInput.fill(password)
    await this.submitButton.click()
  }

  async expectGenericError() {
    // E-012-1: どちらのフィールドが誤りかは開示せず、汎用メッセージのみ（アカウント列挙対策）
    await expect(this.errorAlert).toContainText(ADMIN_A11Y.loginErrorText)
  }
}
