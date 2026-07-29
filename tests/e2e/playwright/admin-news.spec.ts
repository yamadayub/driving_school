import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { AdminLoginPage } from '../pages/AdminLoginPage'
import { AdminNewsPage } from '../pages/AdminNewsPage'
import { TopPage } from '../pages/TopPage'
import { ADMIN_CREDENTIALS, E2E_TITLE_PREFIX } from '../pages/admin-contract'
import { TESTID } from '../pages/contract'

/**
 * PT2-03（データ衛生）: E2E は共有 dev DB に PUBLISHED 行を作るため、途中失敗で行が残ると
 * 結合テストの厳密件数（news.published=6）と「最新記事」を破壊する。
 * 全作成行に E2E 接頭辞（admin-contract.E2E_TITLE_PREFIX）を付け、afterAll で接頭辞一致行を
 * ベストエフォート削除する。dev DB 未起動時は握りつぶす（E2E 実行自体が dev DB 前提）。
 * Playwright は .env を自動読込しないため、integration/setup.ts と同じ最小ローダで注入する。
 */
function loadDotenv() {
  let raw: string
  try {
    raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

test.afterAll(async () => {
  loadDotenv()
  const prisma = new PrismaClient()
  try {
    // 接頭辞は '【E2E'（'【E2E】' と authz の '【E2E-AUTHZ】' 双方を回収）
    await prisma.news.deleteMany({ where: { title: { startsWith: '【E2E' } } })
  } catch {
    // best-effort（dev DB 未起動などは無視）
  } finally {
    await prisma.$disconnect()
  }
})

/**
 * F-014 お知らせ管理 CRUD 一巡（US-012）＋公開サイト反映（F-004/F-001）。news-cms.md。
 * 実装後に green を目指す設計（管理画面・認証未実装のため現状 red）。
 *
 * 公開反映の検証範囲（判断・要明記）:
 *   公開お知らせ一覧 `/news`（F-004）は P2 スコープ外で未実装のため、公開反映は
 *   **トップページの「お知らせ最新3件」（F-001, section-news）**で検証する。公開日時を直近に
 *   設定し最新3件に入るようにする。/news 実装後はそちらでの反映検証を後続で追加する。
 *
 * 直列実行（作成→公開→編集→削除の状態を引き継ぐため）。タイトルは実行ごとに一意化し
 * seed や過去実行と衝突しないようにする（テスト後に削除して汚さない）。
 *
 * 一意化キーには **プロジェクト名（ブラウザ）** を含める。playwright.config は fullyParallel かつ
 * 3ブラウザ project を共有 dev DB に対して並列実行するため、`Date.now()` だけだと 3 worker が
 * 同一ミリ秒で初期化した際に同一タイトル行を作り、`hasText` 部分一致の行特定が多重マッチして
 * strict mode で fail する（例: 削除後 count=0 期待に他ブラウザの同名行が残り count=1）。
 * project 名は project 間で必ず異なるため、これを織り込めば行タイトルが project ごとに一意になる。
 */
// 管理系スペックは playwright.config の projects で chromium 単一実行に限定（firefox/webkit は testIgnore）。
// 3ブラウザ同時ログイン（同期 scrypt）＋ /admin コンパイルによる dev サーバ過負荷 flaky を根絶するため。
test.describe.serial('F-014: お知らせ CRUD 一巡', () => {
  const stamp = Date.now()
  let title: string
  let editedTitle: string

  test.beforeAll(async ({}, testInfo) => {
    const key = `${testInfo.project.name}-${stamp}`
    title = `${E2E_TITLE_PREFIX}新規お知らせ ${key}`
    editedTitle = `${E2E_TITLE_PREFIX}編集後お知らせ ${key}`
  })

  test.beforeEach(async ({ page }) => {
    const login = new AdminLoginPage(page)
    await login.goto()
    await login.login(ADMIN_CREDENTIALS.email, ADMIN_CREDENTIALS.password)
    // 成功時は Auth.js のネイティブ form POST → /admin へフルナビゲーション。
    // dev の初回コンパイル遅延の吸収は playwright.config の expect.timeout(15s) に集約。
    await expect(page).toHaveURL(/\/admin$/)
  })

  test('新規作成（下書き）→ 一覧に下書きとして表示される', async ({ page }) => {
    const news = new AdminNewsPage(page)
    await news.gotoList()
    await news.clickNew()

    await news.fillTitle(title)
    await news.selectCategory('共通')
    await news.chooseStatus('DRAFT')
    await news.fillBody('## 見出し\n\n本文です。[リンク](https://example.com)')
    await news.saveDraft()

    await news.gotoList()
    await news.expectRowVisible(title)
    await news.expectRowStatus(title, 'DRAFT')
  })

  test('公開に変更 → トップの最新3件に反映される（F-001 section-news）', async ({ page }) => {
    const news = new AdminNewsPage(page)
    await news.gotoList()
    await news.rowByTitle(title).getByRole('link', { name: title }).click()

    await news.chooseStatus('PUBLISHED')
    await news.setPublishedAt('2026-07-27T09:00')
    await news.publish()

    await news.gotoList()
    await news.expectRowStatus(title, 'PUBLISHED')

    // 公開サイト（トップ）に反映
    const top = new TopPage(page)
    await top.goto()
    const newsSection = top.section(TESTID.sectionNews)
    await expect(newsSection.getByText(title)).toBeVisible()
  })

  test('編集（タイトル変更）→ 一覧に反映される', async ({ page }) => {
    const news = new AdminNewsPage(page)
    await news.gotoList()
    await news.rowByTitle(title).getByRole('link', { name: title }).click()

    await news.fillTitle(editedTitle)
    await news.publish()

    await news.gotoList()
    await news.expectRowVisible(editedTitle)
  })

  test('削除（ConfirmDialog 経由）→ 一覧から消える', async ({ page }) => {
    const news = new AdminNewsPage(page)
    await news.gotoList()
    await news.clickDeleteOn(editedTitle)

    await expect(news.confirmDialog).toBeVisible()
    await news.confirmDelete()

    await news.gotoList()
    await expect(news.rowByTitle(editedTitle)).toHaveCount(0)
  })
})
