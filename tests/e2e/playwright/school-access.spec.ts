import { test, expect } from '@playwright/test'
import { SchoolAccessPage } from '../pages/SchoolAccessPage'
import { GlobalNav } from '../pages/GlobalNav'

/**
 * F-007 学校案内・アクセス。US-005。
 * 2校の情報表示と、ページ内アンカー #iwataki / #amino / #access（別ページを作らない）を検証。
 * 実装後に green を目指す設計（現状は未実装のため red）。
 */
test.describe('F-007: 学校案内・アクセス', () => {
  test('岩滝校・網野校の2校が表示される', async ({ page }) => {
    const schools = new SchoolAccessPage(page)
    await schools.goto()
    await schools.expectBothSchools()
  })

  test('ページ内アンカー #iwataki / #amino / #access が存在する', async ({ page }) => {
    const schools = new SchoolAccessPage(page)
    await schools.goto()
    await schools.expectAnchorsExist()
  })

  test('ナビ「アクセス」は同一ページ内 #access へ遷移する（別ページを新設しない）', async ({
    page,
  }) => {
    await page.goto('/')
    const nav = new GlobalNav(page)
    await nav.clickNav('アクセス')
    await expect(page).toHaveURL(/\/schools#access$/)
    const schools = new SchoolAccessPage(page)
    await schools.expectAnchorsExist()
  })
})
