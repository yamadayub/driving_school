import { describe, it, expect, vi } from 'vitest'

/**
 * =========================================================================
 * P3-a 差し戻し修正 — RV-P3A-003（Should Fix）
 * 「文書化された品質ゲートのコマンドが赤のまま」を解消する
 * =========================================================================
 *
 * 出典: `docs/review-p3a-code-2026-07-29.md` RV-P3A-003 / `CLAUDE.md`「品質ゲート」4番。
 *
 * ## 事象
 * 1. `playwright.config.ts:39` — `command: process.env.CI ? 'pnpm start' : 'pnpm dev'`
 * 2. `pnpm dev` = `next dev` → `NODE_ENV=development`
 * 3. `middleware.ts:36` — `allowUnsafeEval: process.env.NODE_ENV !== 'production'` → true
 * 4. `tests/e2e/playwright/csp.spec.ts:64` — `script-src` に `'unsafe-eval'` が無いことを要求 → **赤**
 *
 * CI は `CI: true` を渡すので緑になるが、**文書に書かれたコマンド `pnpm test:e2e` を
 * そのまま実行した人は原因不明の赤を踏む**。
 *
 * ## 本テストが選んだ契約（Test Agent の判断 / 理由は `docs/review-p3a-fix-tests-2026-07-29.md`）
 * レビューの改善案 **(b)「webServer を常に本番ビルドにする」** を採る。(a)（CSP の assertion を
 * `if (process.env.CI)` で条件付きにする）は、**手元では本番 CSP を一度も検証しない**状態を作り、
 * 「テストは緑だが誰も見ていない」という本プロジェクトが繰り返した型に戻るため採らない。
 *
 * 固定する契約は 4 点:
 *  1. `pnpm test:e2e`（CI 無し）が **dev サーバーを起動しない**。
 *  2. ローカルでも**ビルド済みの本番サーバー**に対して実行する（`.next` が無ければビルドする）。
 *  3. すでに :3000 で動いている dev サーバーを**流用しない**（流用すると 1. が骨抜きになる）。
 *  4. **CI 経路は変更しない**（`CI=1 pnpm test:e2e` の実測 94 passed / 4 flaky / 0 failed が基準値）。
 *
 * ## red 理由
 * `playwright.config.ts` が未修正のため、CI 無しの `webServer.command` が `pnpm dev` のままである。
 *
 * ## E2E は実行していない
 * 本タスクでは E2E を実行しない（1回 29 分）。したがってこのファイルは**設定の妥当性**だけを
 * 静的に固定する。実際の緑は Impl / 再監査時の `pnpm test:e2e` で確認すること。
 */

interface WebServerConfig {
  command: string
  timeout?: number
  reuseExistingServer?: boolean
}

/** `CI` の有無を切り替えて `playwright.config.ts` を読み込み直す。 */
async function loadWebServer(ci: string | undefined): Promise<WebServerConfig> {
  const previous = process.env.CI
  try {
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
    vi.resetModules()
    const module = (await import('@/playwright.config')) as {
      default: { webServer?: WebServerConfig }
    }
    const webServer = module.default.webServer
    if (!webServer) throw new Error('playwright.config.ts に webServer が無い')
    return webServer
  } finally {
    if (previous === undefined) delete process.env.CI
    else process.env.CI = previous
  }
}

describe('RV-P3A-003: `pnpm test:e2e`（CI 無し）が本番ビルドに対して実行される', () => {
  it('CI 無しでも dev サーバー（next dev）を起動しない', async () => {
    // これが green なら排除される壊れた状態: 文書化された品質ゲートコマンドが
    // **dev 専用の CSP（`'unsafe-eval'`）を見て赤になる**こと。
    // 赤いゲートは「いつもの赤」として無視されるようになり、本物の退行を隠す。
    const webServer = await loadWebServer(undefined)
    expect(webServer.command).not.toMatch(/\bnext dev\b|\bpnpm dev\b/)
  })

  it('CI 無しでは本番サーバーを起動し、その前にビルドする（.next が無い手元でも成立させる）', async () => {
    // これが green なら排除される壊れた状態: `pnpm start` だけに変えた結果、
    // ビルドしていない手元で `next start` が「.next が無い」と落ちる——
    // **赤の理由が変わっただけ**で、文書化されたコマンドは通らないまま。
    const webServer = await loadWebServer(undefined)
    expect(webServer.command).toMatch(/\bnext start\b|\bpnpm start\b/)
    expect(webServer.command).toMatch(/\bnext build\b|\bpnpm build\b/)
  })

  it('CI 無しでは既存サーバーを流用しない（起動済みの next dev を掴まない）', async () => {
    // これが green なら排除される壊れた状態: 手元で `pnpm dev` を開いたまま E2E を回すと、
    // Playwright がその dev サーバーを流用し、**本番ビルドを検証したつもりで dev を見る**。
    // RV-P3A-003 と同じ赤が別経路で戻ってくる（かつ原因が分かりにくい）。
    const webServer = await loadWebServer(undefined)
    expect(webServer.reuseExistingServer).toBe(false)
  })

  it('CI 無しの webServer タイムアウトはビルド時間を吸収できる（>= 300 秒）', async () => {
    const webServer = await loadWebServer(undefined)
    expect(webServer.timeout ?? 0).toBeGreaterThanOrEqual(300_000)
  })

  it('CI 経路は従来どおり `pnpm start` のまま（実測済み基準値を動かさない）', async () => {
    // これが green なら排除される退行: CI でもビルドを二重に走らせて所要時間を倍にすること
    //（CI は `next build` を別ステップで済ませている）。
    const webServer = await loadWebServer('1')
    expect(webServer.command).toBe('pnpm start')
    expect(webServer.reuseExistingServer).toBe(false)
  })
})
