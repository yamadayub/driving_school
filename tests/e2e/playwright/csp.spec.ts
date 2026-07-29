import { test, expect } from '@playwright/test'

/**
 * =========================================================================
 * P3-a — AC-010-15 / AC-008-1（SEC-002）: CSP を最終形で投入する
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-15:798 / AC-008-1、
 *       `docs/tech-stack.md` v0.3.2 §4.7（ディレクティブ表）。
 *
 * ## 検証対象ページは `/`（`/apply` は P3-a の時点で存在しない）
 * `phase-status.md`「P3-a の完了条件 (1)」AC-010-15 の行のとおり。
 * **P3-b で `/apply` に切り替え、P3-b / P3-c の完了時に再検証する**
 *（P3-a の証跡が最終ポリシーを表さない状態を作らないため）。
 *
 * ## なぜ P3-a で「最終形」を入れるのか
 * 後から緩めると監査をやり直すことになり、「監査済み」の範囲が単位間の隙間に落ちる。
 * かつ **CSP 投入と Turnstile 導入の順序を誤るとフォーム公開と同時に CAPTCHA が壊れる**
 *（可用性の問題でもある。Designer 申し送り I-3）。
 *
 * ## red 理由
 * CSP ヘッダが未投入のため `content-security-policy` が `null` になる。
 */

/**
 * 検証対象ページ。
 *
 * ⚠️ **P3b-5 の「`/apply` を実ブラウザで開いて違反 0 を見る」は本ファイルでは行わない**
 *（RV-P3B-005 / `docs/review-p3b-code-2026-07-29.md`:272）。
 * `/apply` の違反検証は**確認画面（review ステップ）まで進めないと意味が無い**
 *——Turnstile スクリプトは `step === 'review'` でしか読み込まれず、
 * サイト内で CSP 違反が起こりうる唯一の箇所がそこだからである。
 * 入力手順を持つのは `tests/e2e/playwright/apply-form.spec.ts` 側なので、
 * **`/apply` の実ブラウザ検証はそちらに置く**（本ファイルはトップページの被覆を維持する）。
 * P3b-5 の「`csp.spec.ts` だけを根拠にしない」という条件は、
 * 本ファイル + `apply-form.spec.ts` + `tests/unit/apply-page-contract.test.ts` の 3 層で満たす。
 */
const TARGET_PATH = '/'

/** ディレクティブ文字列を `{ name: [values] }` に分解する。 */
function parseCsp(header: string): Record<string, string[]> {
  const policy: Record<string, string[]> = {}
  for (const directive of header.split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    policy[parts[0].toLowerCase()] = parts.slice(1)
  }
  return policy
}

async function getCspHeader(request: import('@playwright/test').APIRequestContext, path: string) {
  const response = await request.get(path)
  expect(response.status(), `${path} が 200 を返す`).toBe(200)
  const header =
    response.headers()['content-security-policy'] ??
    response.headers()['content-security-policy-report-only']
  return { header, headers: response.headers() }
}

test.describe('AC-010-15 / SEC-002: Content-Security-Policy', () => {
  test('公開ページに CSP ヘッダが付いている', async ({ request }) => {
    const { headers } = await getCspHeader(request, TARGET_PATH)
    expect(
      headers['content-security-policy'],
      'Report-Only ではなく強制モードで投入すること（Report-Only は防御にならない）',
    ).toBeTruthy()
  })

  test('script-src に unsafe-inline を含まない（AC-008-1 の検証対象）', async ({ request }) => {
    // これが green なら排除される: nonce 方式を諦めて `'unsafe-inline'` を足す実装。
    // XSS 対策の主要な効果は `script-src` 側にあり、ここを緩めると CSP の主目的が失われる。
    const { headers } = await getCspHeader(request, TARGET_PATH)
    const policy = parseCsp(headers['content-security-policy'] ?? '')
    expect(policy['script-src'], 'script-src が定義されている').toBeDefined()
    expect(policy['script-src']).not.toContain("'unsafe-inline'")
    expect(policy['script-src']).not.toContain("'unsafe-eval'")
  })

  test('script-src が nonce を持ち、self と Turnstile を許可する（最終形）', async ({ request }) => {
    const { headers } = await getCspHeader(request, TARGET_PATH)
    const policy = parseCsp(headers['content-security-policy'] ?? '')
    const scriptSrc = (policy['script-src'] ?? []).join(' ')
    expect(scriptSrc).toContain("'self'")
    expect(scriptSrc, 'リクエストごとの nonce').toMatch(/'nonce-[A-Za-z0-9+/=_-]+'/)
    expect(scriptSrc, 'Turnstile を先行許可（P3-b で使う）').toContain(
      'https://challenges.cloudflare.com',
    )
  })

  test('後続単位で必要になるオリジンが最終形で入っている（frame-src / connect-src / img-src）', async ({
    request,
  }) => {
    // 「まだ使っていないオリジンを先に許可する」ことは意図した設計判断である
    //（後から緩める＝監査をやり直すよりリスクが小さい。`tech-stack.md` §4.7）。
    const { headers } = await getCspHeader(request, TARGET_PATH)
    const policy = parseCsp(headers['content-security-policy'] ?? '')
    expect((policy['frame-src'] ?? []).join(' ')).toContain('https://challenges.cloudflare.com')
    expect((policy['connect-src'] ?? []).join(' '), 'Vercel Blob への署名付き PUT').toMatch(
      /blob\.vercel-storage\.com/,
    )
    const imgSrc = (policy['img-src'] ?? []).join(' ')
    expect(imgSrc, '免許証プレビューは createObjectURL（blob:）').toContain('blob:')
    expect(imgSrc).toContain('data:')
  })

  test('クリックジャッキング・base タグ注入を塞ぐ', async ({ request }) => {
    const { headers } = await getCspHeader(request, TARGET_PATH)
    const policy = parseCsp(headers['content-security-policy'] ?? '')
    expect((policy['object-src'] ?? []).join(' ')).toContain("'none'")
    expect((policy['frame-ancestors'] ?? []).join(' ')).toContain("'none'")
    expect((policy['base-uri'] ?? []).join(' ')).toContain("'self'")
    expect((policy['form-action'] ?? []).join(' ')).toContain("'self'")
    expect((policy['default-src'] ?? []).join(' ')).toContain("'self'")
  })

  test('style-src の unsafe-inline は受容済み（過大報告しないための固定）', async ({ request }) => {
    // Next.js はクリティカル CSS を inline `<style>` で注入するため、ここを外すと描画が壊れる。
    // **AC-008-1 は `script-src` のみを対象としているので仕様違反ではない**が、
    // 「CSP を厳格にした」と過大に報告しないよう、受容している事実をテストで可視化しておく
    //（`tech-stack.md` §4.7 の注記 / RV-P3D-N02）。
    const { headers } = await getCspHeader(request, TARGET_PATH)
    const policy = parseCsp(headers['content-security-policy'] ?? '')
    expect((policy['style-src'] ?? []).join(' ')).toContain("'unsafe-inline'")
  })

  test('ブラウザで開いたときに CSP 違反が発生しない（ポリシーが実ページと整合する）', async ({
    page,
    browserName,
  }) => {
    // CSP 違反のコンソール出力形式はブラウザごとに異なる（webkit / firefox は文言が違い、
    // 出さない場合もある）。**文言依存のテストを3ブラウザで回すとフレーキーになる**ため、
    // 違反検出は chromium 単一で行う。ヘッダ内容の検証は上記のとおり全ブラウザで行っている。
    test.skip(browserName !== 'chromium', 'CSP 違反のコンソール出力は chromium で検証する')

    // これが green なら排除される: 厳しすぎて自分のページを壊す CSP
    //（＝ 投入したが実際には Report-Only 相当でしか運用できない状態）。
    const violations: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      if (/Content Security Policy|Refused to (load|execute|apply)/i.test(text)) {
        violations.push(text)
      }
    })
    await page.goto(TARGET_PATH)
    // **`networkidle` は使えない**（Impl の実測 / `docs/impl-p3a-notes-2026-07-29.md` §4）。
    // Next.js の `<Link>` は viewport 内のリンクを RSC プリフェッチするが、本サイトには
    // **P1 時点で未実装のリンク（`/news` `/faq` `/apply` `/news/[id]`）**が残っている。
    // それらへのプリフェッチがブラウザ側で保留のままになり、`networkidle` は永久に成立しない
    // （middleware を `/admin` 限定へ戻した状態でも同一に再現したため、CSP とは無関係な既存性質）。
    // 検出したい CSP 違反はスクリプトの実行・スタイル適用・リソース読込の時点で出るため、
    // `load` 到達後に遅れて届くコンソールメッセージを短く待てば十分である。
    await page.waitForLoadState('load')
    await page.waitForTimeout(1_000)
    expect(violations, violations.join('\n')).toEqual([])
  })
})
