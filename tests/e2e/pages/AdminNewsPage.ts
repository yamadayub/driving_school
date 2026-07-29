import { type Page, type Locator, expect } from '@playwright/test'
import { ADMIN_ROUTES, ADMIN_TESTID, ADMIN_A11Y, PUBLISH_STATUS_TEXT } from './admin-contract'

/**
 * お知らせ管理 CMS（F-014）の Page Object。news-cms.md の一覧/作成/編集/削除に対応。
 */
export class AdminNewsPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async gotoList() {
    await this.page.goto(ADMIN_ROUTES.newsList)
  }

  get table(): Locator {
    return this.page.getByTestId(ADMIN_TESTID.newsTable)
  }

  get rows(): Locator {
    return this.page.getByTestId(ADMIN_TESTID.newsRow)
  }

  /** タイトル文言で行を特定（DataTable の行）。 */
  rowByTitle(title: string): Locator {
    return this.rows.filter({ hasText: title })
  }

  async clickNew() {
    await this.page.getByRole('link', { name: ADMIN_A11Y.newNewsButton }).click()
  }

  // --- 作成/編集フォーム ---

  async fillTitle(value: string) {
    await this.page.getByLabel(ADMIN_A11Y.titleLabel).fill(value)
  }

  async selectCategory(label: string) {
    await this.page.getByLabel(ADMIN_A11Y.categoryLabel).selectOption({ label })
  }

  get bodyEditor(): Locator {
    return this.page.getByTestId(ADMIN_TESTID.newsBodyEditor)
  }

  get bodyPreview(): Locator {
    return this.page.getByTestId(ADMIN_TESTID.newsBodyPreview)
  }

  async fillBody(markdown: string) {
    await this.bodyEditor.fill(markdown)
  }

  /** 公開ステータス（radio 3択, fieldset legend=公開ステータス）を選ぶ。 */
  async chooseStatus(status: keyof typeof PUBLISH_STATUS_TEXT) {
    await this.page
      .getByRole('group', { name: ADMIN_A11Y.statusLegend })
      .getByRole('radio', { name: PUBLISH_STATUS_TEXT[status] })
      .check()
  }

  async setPublishedAt(value: string) {
    await this.page.getByLabel(ADMIN_A11Y.publishedAtLabel).fill(value)
  }

  async saveDraft() {
    await this.page.getByRole('button', { name: ADMIN_A11Y.saveDraftButton }).click()
  }

  async publish() {
    await this.page.getByRole('button', { name: ADMIN_A11Y.publishButton }).click()
  }

  // --- 削除（ConfirmDialog） ---

  async clickDeleteOn(title: string) {
    await this.rowByTitle(title).getByRole('button', { name: '削除' }).click()
  }

  get confirmDialog(): Locator {
    return this.page.getByRole('alertdialog')
  }

  async confirmDelete() {
    await this.confirmDialog.getByRole('button', { name: ADMIN_A11Y.confirmDeleteButton }).click()
  }

  // --- アサーション補助 ---

  async expectRowVisible(title: string) {
    await expect(this.rowByTitle(title)).toBeVisible()
  }

  async expectRowStatus(title: string, status: keyof typeof PUBLISH_STATUS_TEXT) {
    await expect(this.rowByTitle(title)).toContainText(PUBLISH_STATUS_TEXT[status])
  }
}
