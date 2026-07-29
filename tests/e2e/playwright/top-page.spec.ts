import { test, expect } from '@playwright/test'
import { TopPage } from '../pages/TopPage'
import { GlobalNav } from '../pages/GlobalNav'
import { TESTID } from '../pages/contract'

/**
 * F-001 トップページ + グローバルナビ。US-001 / US-003 / US-005。
 * 実装後に green を目指す設計（現状は未実装のため red）。
 */
test.describe('F-001: トップページ主要導線', () => {
  test('主要セクション（ヒーロー/特徴/お知らせ/料金/校舎/アクセス）が表示される', async ({
    page,
  }) => {
    const top = new TopPage(page)
    await top.goto()
    await top.expectMainSectionsVisible()
  })

  test('お知らせ最新3件が表示される（US-003, 最大3件）', async ({ page }) => {
    const top = new TopPage(page)
    await top.goto()
    const count = await top.newsCards.count()
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThanOrEqual(3)
  })

  test('料金プレビューに通学/合宿タブとコースカードがある', async ({ page }) => {
    const top = new TopPage(page)
    await top.goto()
    await expect(top.priceTab('通学')).toBeVisible()
    await expect(top.priceTab('合宿')).toBeVisible()
    expect(await top.priceCourseCards.count()).toBeGreaterThan(0)
  })

  test('校舎セクションに岩滝校・網野校の2校が示される（US-005）', async ({ page }) => {
    const top = new TopPage(page)
    await top.goto()
    const schoolInfo = top.section(TESTID.sectionSchoolInfo)
    await expect(schoolInfo.getByText('岩滝校')).toBeVisible()
    await expect(schoolInfo.getByText('網野校')).toBeVisible()
  })
})

test.describe('F-001: グローバルナビ遷移', () => {
  test('全ナビ項目が正しい href で表示される', async ({ page }) => {
    await page.goto('/')
    const nav = new GlobalNav(page)
    await nav.expectAllVisible()
  })

  test('「通学」からコース比較(受講形態=通学)へ遷移する', async ({ page }) => {
    await page.goto('/')
    const nav = new GlobalNav(page)
    await nav.clickNav('通学')
    await expect(page).toHaveURL(/\/courses\?format=TSUGAKU/)
  })

  test('「学校案内」から /schools へ遷移する', async ({ page }) => {
    await page.goto('/')
    const nav = new GlobalNav(page)
    await nav.clickNav('学校案内')
    await expect(page).toHaveURL(/\/schools$/)
  })
})
