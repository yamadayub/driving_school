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
  /**
   * P3-c2 / MF-1: RV-P3B-019 の「軸を分ける」機構（`TRUST_PROXY=1`）。
   * **ここに無いと送っている `X-Real-IP` が 1 バイトも読まれない**（設計文書 §9.1）。
   */
  env?: Record<string, string | undefined>
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

/* ========================================================================= *
 * P3-c2 / **MF-1**: RV-P3B-019 の「軸を分ける」機構が実際に結線されている
 * ========================================================================= *
 *
 * 出典: `docs/review-p3c2-tests-2026-07-29.md` MF-1、
 *       `docs/phase-status.md`「P3-c2 の完了条件（申し送り）」3。
 *
 * ## なぜ pin が要るのか
 * P3-c2 の設計は RV-P3B-019 を「E2E サーバーを `TRUST_PROXY=1` で起動し、
 * テストごとに異なる `X-Real-IP` を送る」で解くと宣言し、スペック側は実際にヘッダを送っている。
 * **しかし `webServer` に `env` が無ければ、送ったヘッダは 1 バイトも読まれない**——
 * `resolveClientIp` は縮退時に信頼ヘッダを**一度も見ずに** `key='unknown'` を返すためである。
 *
 * これは「**受け口は在るが、呼び出し元がその状態を作らない**」という、
 * このプロジェクトが P3-c1 で 4 回連続して踏んだ型の 4 段階目そのものである。
 * したがって**設定されていること自体**を固定する。
 */

describe('RV-P3B-019 / MF-1: E2E の webServer が TRUST_PROXY=1 で起動する', () => {
  it('webServer.env に TRUST_PROXY=1 が設定されている', async () => {
    // **本 describe で最も重要なテスト。**
    // これが green なら排除される状態: スペックが `X-Real-IP` を送っているのに
    // サーバー側が縮退構成のままで、**軸が 1 つも分かれない**こと。
    // その状態では無コスト枠（10 枚/10 分）を全テストが共有し、
    // 送信成功の E2E は**印の付いた Cookie で Tier B に落ちる**
    //（＝ RV-P3B-019 は「解いた」と記録されるが解けていない）。
    const webServer = await loadWebServer(undefined)
    expect(
      webServer.env?.TRUST_PROXY,
      'TRUST_PROXY が無いと X-Real-IP は無視され、軸が分かれない（RV-P3B-019 未解決）',
    ).toBe('1')
  })

  it('既定の環境変数を置き換えず引き継いでいる（...process.env の展開）', async () => {
    // **Playwright は `env` を指定すると既定の環境を置き換える。**
    // `...process.env` の展開を落とすと `DATABASE_URL` / `FORM_SESSION_SECRET` /
    // `TURNSTILE_SECRET` 等が消え、`lib/env.ts` の本番 fail-fast で**サーバーが起動しない**
    //（テストの失敗ではなく webServer の失敗として出るので原因が分かりにくい）。
    //
    // ソースの正規表現ではなく**実際に読み込んだ設定オブジェクト**で測る——
    // `...process.env` と書いてあっても別の行で潰される可能性があるため。
    const sentinel = `__E2E_ENV_SENTINEL_${Date.now()}__`
    process.env[sentinel] = 'kept'
    try {
      const webServer = await loadWebServer(undefined)
      expect(
        webServer.env?.[sentinel],
        '既定の環境が引き継がれていない（webServer が起動しなくなる）',
      ).toBe('kept')
    } finally {
      delete process.env[sentinel]
    }
  })

  it('CI 経路でも TRUST_PROXY=1 が設定される（CI と手元で軸の分かれ方を変えない）', async () => {
    // これが green なら排除される事故: 手元だけ green で CI が赤（あるいはその逆）になり、
    // **どちらの結果を信じるべきか分からなくなる**こと。
    const webServer = await loadWebServer('1')
    expect(webServer.env?.TRUST_PROXY).toBe('1')
  })

  it('TRUST_PROXY はアプリのソースには書かれていない（本番へ漏れない）', async () => {
    // `playwright.config.ts` は**デプロイ対象に含まれない**ので E2E 限定の設定である。
    // これが green なら排除される事故: 誰かが `.env.production` / `next.config.mjs` /
    // `vercel.json` 等へ `TRUST_PROXY=1` を移し、**前段が XFF を上書きしない本番**で
    // クライアントに IP を名乗らせること（P3-c1 §3 / NEW-005）。
    const { existsSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const file of ['next.config.mjs', 'next.config.js', 'vercel.json', '.env.production']) {
      const path = resolve(process.cwd(), file)
      if (!existsSync(path)) continue
      expect(readFileSync(path, 'utf8'), `${file} に TRUST_PROXY が書かれている`).not.toContain(
        'TRUST_PROXY',
      )
    }
  })
})
