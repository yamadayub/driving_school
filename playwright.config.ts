import { defineConfig, devices } from '@playwright/test'

// tech-stack §5: E2E は Next.js サーバー上で実行する。
// CI / ローカルとも**本番ビルド**（`next start`）に対して実行する（RV-P3A-003。詳細は webServer 参照）。
const PORT = 3000
const baseURL = process.env.BASE_URL || `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests/e2e/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // dev（pnpm dev）はルートをオンデマンドコンパイルし、認証は verifyPassword(scryptSync,同期)を
  // イベントループで直列化するため、初回アクセスが Playwright デフォルト(5s/30s)を超えることがある。
  // 天井を上げて吸収する。CI は prebuilt(pnpm start)で高速なため実害なし（timeout は上限にすぎない）。
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // 管理系スペック（admin-*）は「アプリロジック（認証/CMS CRUD）」の検証であり、クロスブラウザ
  // 描画の検証ではない。全ブラウザで同時にログイン（同期 scrypt）＋ /admin コンパイルを走らせると
  // 単一 dev サーバが過負荷になり flaky を招くため、chromium 単一で実行する（Playwright の定石）。
  // クロスブラウザ描画の担保は公開系スペック（top-page/course-*/school-access）が3ブラウザで継続。
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /admin-.*\.spec\.ts/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /admin-.*\.spec\.ts/ },
  ],
  // RV-P3A-003: 文書化された品質ゲート `pnpm test:e2e`（CI 無し）が **dev サーバーを見ない**ようにする。
  // dev は `NODE_ENV=development` になり CSP に `'unsafe-eval'` が入るため、`csp.spec.ts` が赤になる
  // ——「いつもの赤」は本物の退行を隠す。E2E は常に本番ビルドを検証する。
  webServer: {
    // 非 CI は `.next` が無い手元でも成立させるため build を前置する（`pnpm start` 単体だと
    // 「.next が無い」で落ちるだけで、文書化されたコマンドは通らないまま）。
    // CI は `next build` を別ステップで済ませているので二重ビルドしない（実測基準値を動かさない）。
    command: process.env.CI ? 'pnpm start' : 'pnpm build && pnpm start',
    url: baseURL,
    // 非 CI はビルドを含むため天井を上げる。
    timeout: process.env.CI ? 120_000 : 300_000,
    // 起動済みの `next dev` を掴むと、本番ビルドを検証したつもりで dev を見ることになる。
    reuseExistingServer: false,
    /*
     * RV-P3B-019 —「上限を緩める」のではなく「**軸を分ける**」（P3-c2 / MF-1）。
     *
     * 縮退構成（`VERCEL !== '1'` かつ `TRUST_PROXY` 未設定）では `resolveClientIp` が
     * 信頼ヘッダを**一度も見ずに** `key='unknown'` を返す。したがって全テストが
     * 単一の共有バケットを使い、無コスト枠（10 枚/10 分）を数テストで使い切って
     * 以後の Cookie に `unverified` の印が付く——**送信成功の E2E が原理的に書けなかった**
     *（P3-b 実測: 通常操作だけで窓内 23 回の `/apply` 遷移）。
     *
     * `TRUST_PROXY=1` にすると発信元軸が要求元ごとに分かれる。**閾値も窓も 1 つも変えていない。**
     * 変わるのは「軸が分かれる」ことだけで、それは**本番（Vercel）で実際に成立している状態**である
     *（縮退構成のほうが本番と乖離していた）。むしろ `trusted` では発行の硬い上限 30 が
     * **ゲートとして効き始める**（縮退では計数のみだった）ので、防御は強くなる方向に動く。
     *
     * ⚠️ **`env` を指定すると Playwright は既定の環境を置き換える。**
     * `...process.env` の展開を落とすと `CI` / `DATABASE_URL` / `FORM_SESSION_SECRET` 等が
     * 消えて webServer が起動しない（`lib/env.ts` の本番 fail-fast に掛かる）。
     *
     * ⚠️ **本設定は E2E の webServer 限定であり、本番へは漏れない**
     *（`playwright.config.ts` はデプロイ対象に含まれない）。
     * 前段が XFF を上書きしない構成で本番に `TRUST_PROXY=1` を立てると
     * クライアントが IP を名乗れる（`lib/http-guard.ts` の警告参照）。
     */
    env: { ...process.env, TRUST_PROXY: '1' },
  },
})
