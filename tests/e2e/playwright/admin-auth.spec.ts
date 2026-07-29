import { test, expect } from '@playwright/test'
import { AdminLoginPage } from '../pages/AdminLoginPage'
import { AdminDashboardPage } from '../pages/AdminDashboardPage'
import { ADMIN_ROUTES, ADMIN_CREDENTIALS } from '../pages/admin-contract'

/**
 * F-012 管理者認証 / 認可（US-011）。login.md / admin-layout.md。
 * 実装後に green を目指す設計（Credentials Provider 未実装のため現状 red）。
 * ※ 未認証リダイレクト（E-012-2）は P1 の middleware で既に成立しうる。
 */
test.describe('F-012: 認可ガード（未認証は /admin/login へ）', () => {
  test('未認証で /admin にアクセスするとログインへリダイレクトされる（E-012-2）', async ({
    page,
  }) => {
    await page.goto(ADMIN_ROUTES.dashboard)
    await expect(page).toHaveURL(/\/admin\/login/)
  })

  test('未認証で /admin/news にアクセスするとログインへリダイレクトされる（E-012-2）', async ({
    page,
  }) => {
    await page.goto(ADMIN_ROUTES.newsList)
    await expect(page).toHaveURL(/\/admin\/login/)
  })
})

test.describe('F-012: ログイン', () => {
  test('正しい資格情報でログインするとダッシュボードが表示される', async ({ page }) => {
    const login = new AdminLoginPage(page)
    await login.goto()
    await login.login(ADMIN_CREDENTIALS.email, ADMIN_CREDENTIALS.password)

    await expect(page).toHaveURL(/\/admin$/)
    const dashboard = new AdminDashboardPage(page)
    await dashboard.expectLoaded()
  })

  test('認証失敗時は汎用エラーを表示し、詳細（どちらが誤りか）を出さない（E-012-1）', async ({
    page,
  }) => {
    const login = new AdminLoginPage(page)
    await login.goto()
    await login.login(ADMIN_CREDENTIALS.email, 'wrong_password')

    await login.expectGenericError()
    // ログイン画面に留まる（認証されない）
    await expect(page).toHaveURL(/\/admin\/login/)
  })
})
