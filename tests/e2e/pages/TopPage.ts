import { type Page, type Locator, expect } from '@playwright/test'
import { HERO_HEADING, TESTID } from './contract'

/**
 * トップページ（F-001）の Page Object。top-page.md のセクション構成に対応。
 */
export class TopPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto() {
    await this.page.goto('/')
  }

  get heroHeading(): Locator {
    return this.page.getByRole('heading', { level: 1, name: HERO_HEADING })
  }

  section(testId: string): Locator {
    return this.page.getByTestId(testId)
  }

  get newsCards(): Locator {
    return this.section(TESTID.sectionNews).getByTestId(TESTID.newsCard)
  }

  get priceCourseCards(): Locator {
    return this.section(TESTID.sectionPricePreview).getByTestId(TESTID.courseCard)
  }

  /** 料金プレビューの受講形態タブ（通学/合宿）。 */
  priceTab(name: string): Locator {
    return this.section(TESTID.sectionPricePreview).getByRole('tab', { name, exact: true })
  }

  /** F-001 の主要セクションがすべて存在することを検証。 */
  async expectMainSectionsVisible() {
    await expect(this.heroHeading).toBeVisible()
    for (const id of [
      TESTID.sectionFeature,
      TESTID.sectionNews,
      TESTID.sectionPricePreview,
      TESTID.sectionSchoolInfo,
      TESTID.sectionAccess,
    ]) {
      await expect(this.section(id)).toBeVisible()
    }
  }
}
