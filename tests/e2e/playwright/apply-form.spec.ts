import { test, expect, type Page } from '@playwright/test'

/**
 * =========================================================================
 * P3-b E2E — F-008（ステップ式フォーム）/ F-023（/privacy）/ AC-008-1 の対象切替
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-008-1〜8（:532-539）/ AC-010-15（:798）、
 *       `docs/ui-design/application-form.md` §11「E2E / テストへの申し送り」、
 *       `docs/ui-design/form-submission.md` §10。
 *
 * ## ⚠️ 実行前に必ず読むこと（RV-P3AF-006 / `docs/phase-status.md`:181）
 * E2E は `pnpm build && pnpm start`（**本番ビルド**）に対して走る。したがって:
 *
 * 1. **`NODE_ENV=production` になるため `lib/env.ts` の fail-fast が発火する。**
 *    `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `FORM_SESSION_SECRET`（32文字以上）/
 *    `CRON_SECRET`（32文字以上）/ `TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
 *    が未設定だと**サーバーが起動しない**（テストの失敗ではなく webServer の失敗として出る）。
 * 2. **ローカルでは `VERCEL !== '1'` なので `resolveClientIp` は `trusted=false`（縮退構成）**になる。
 *    この構成では **`verifyFormSession` 未配線の公開ルートは全リクエスト 403**（意図した fail-closed）。
 *    **「/apply の送信が全部 403」を実装の壊れだと誤診しないこと。** まず (a) Cookie が
 *    `GET /apply` で発行されているか、(b) ルートに `verifyFormSession` が渡っているかを確認する。
 * 3. 送信間隔下限（AC-RL-6 / 3秒）があるため、**フォームを開いてから3秒以内に送信する E2E は
 *    必ず Tier B（CAPTCHA）に落ちる**。送信を伴うシナリオでは待つか、`CI=1` のテスト用フックを使う。
 *
 * ## セレクタ方針（`application-form.md` §11）
 * - ステップの識別は `data-testid="apply-step-<stepId>"` と `<h2>` テキストで行う。
 *   **進捗バーの幅で判定しない**（アニメーション完了を待たない設計にする）。
 */

const APPLY_PATH = '/apply'

/** 種別を選ぶ（入口）。 */
async function chooseType(page: Page, type: 'application' | 'inquiry') {
  await page.getByTestId(`apply-type-${type}`).click()
}

/* ========================================================================= *
 * AC-008-1 / AC-010-15: CSP の検証対象を /apply へ切り替える（P3b-5）
 * ========================================================================= */

test.describe('AC-008-1 / AC-010-15: /apply の CSP', () => {
  test('/apply のレスポンスに CSP が付き、script-src に unsafe-inline / unsafe-eval が無い', async ({
    request,
  }) => {
    // **AC-008-1「CSP 未投入で /apply を公開してはならない」の実応答側の検証。**
    // これが green なら排除される事故: middleware の matcher 変更などで
    // **個人情報入力フォームだけ CSP 無しで配信される**こと。
    // ⚠️ P3b-5: 本テストだけを根拠にしない。ポリシーの中身と matcher の適用範囲は
    // `tests/unit/apply-page-contract.test.ts` が独立に固定している。
    const response = await request.get(APPLY_PATH)
    expect(response.status()).toBe(200)

    const header = response.headers()['content-security-policy']
    expect(header, 'Report-Only ではなく強制モードで投入すること').toBeTruthy()

    const scriptSrc = header.split(';').find((part) => part.trim().startsWith('script-src')) ?? ''
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
    expect(scriptSrc, 'Turnstile が読み込めないと CAPTCHA が壊れる').toContain(
      'https://challenges.cloudflare.com',
    )
  })

  test('/privacy にも CSP が付いている', async ({ request }) => {
    const response = await request.get('/privacy')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-security-policy']).toBeTruthy()
  })
})

/* ========================================================================= *
 * RV-P3B-005（P3b-5 未達）: 実ブラウザの CSP 違反検証を `/apply` で行う
 * ========================================================================= *
 *
 * 出典: `docs/review-p3b-code-2026-07-29.md` RV-P3B-005（:272）、
 *       `docs/security-audit.md` P3b-5（:2131「`/apply` を実ブラウザで開いて**違反 0**と
 *       **ページが白紙でないこと**の両方を見る」）。
 *
 * ## なぜヘッダ検査では足りないのか
 * 上の `request.get(APPLY_PATH)` はブラウザを開いていないので**違反を観測できない**。
 * 一方 `tests/e2e/playwright/csp.spec.ts:114` のブラウザ検証は `TARGET_PATH = '/'` のままである。
 * **`/apply` はサイト内で唯一サードパーティスクリプト（Turnstile）を読み込むページ**
 * ＝ **CSP 違反が起こりうる唯一のページ**であり、そこを実ブラウザで見ていなかった。
 *
 * ## 確認画面（review ステップ）まで進めること
 * Turnstile スクリプトは `step === 'review'` でしか読み込まれない
 *（`components/apply/ApplicationForm.tsx:397-409`）。**入口だけ開いても検証にならない。**
 */

test.describe('RV-P3B-005 / P3b-5: /apply を実ブラウザで開いて CSP 違反 0 を確認する', () => {
  test('確認画面まで進めても CSP 違反が 0 件で、ページが白紙でない', async ({
    page,
    browserName,
  }) => {
    // CSP 違反のコンソール出力形式はブラウザごとに異なる（webkit / firefox は文言が違い、
    // 出さない場合もある）。文言依存のテストを 3 ブラウザで回すとフレーキーになるため
    // chromium 単一で行う（`csp.spec.ts:118-121` と同じ判断）。
    test.skip(browserName !== 'chromium', 'CSP 違反のコンソール出力は chromium で検証する')

    // これが green なら排除される事故:
    //  (1) Turnstile を動かすために CSP を緩める（`'unsafe-inline'` の追加）——
    //      **個人情報入力フォームで inline を許すと 1 つの XSS が入力値の窃取に直結する**。
    //  (2) 逆に厳しすぎて Turnstile が読み込めず、**CAPTCHA が壊れたまま公開される**。
    //  (3) `/apply` だけ静的化されて nonce を失い、**ページが真っ白になる**（P3b-6 と対）。
    // RV-P3B-001（Turnstile の結線欠落）も、確認画面まで進める E2E があれば検出できた。
    const violations: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      if (/Content Security Policy|Refused to (load|execute|apply)/i.test(text)) {
        violations.push(text)
      }
    })

    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillInquiryStep1(page)
    await page.getByTestId('apply-next').click()

    // **「白紙でない」の実体。** 違反 0 だけを見ると「何も描画されていない」ページも通る。
    await expect(page.getByTestId('apply-step-confirm')).toBeVisible()
    await expect(page.getByTestId('turnstile-slot')).toBeVisible()

    // `networkidle` は使えない（`csp.spec.ts:133-138` の実測。未実装リンクの RSC プリフェッチが
    // 保留のままになり永久に成立しない）。違反はリソース読込・スクリプト実行の時点で出る。
    await page.waitForTimeout(1_500)
    expect(violations, violations.join('\n')).toEqual([])
  })
})

/* ========================================================================= *
 * RV-P3B-001: Turnstile の結線が実ブラウザで成立している
 * ========================================================================= */

test.describe('RV-P3B-001: Turnstile のトークン受け口が実在する', () => {
  test('確認画面で data-callback に指定したグローバル関数が定義されている', async ({ page }) => {
    // **RV-P3B-001 の本体。** `data-callback="onTurnstileToken"` は
    // 「`window.onTurnstileToken(token)` を呼べ」という指定である。
    // これが green なら排除される欠陥: 属性値だけが存在し**呼ぶ相手がいない**状態。
    // その場合 `captchaToken` は `''` のまま送信され、`lib/turnstile.ts:47` が必ず false を返し、
    // **本番では F-008 / F-010 が 1 件も受け付けられない**（機能不成立）。
    //
    // ⚠️ 本テストはネットワークに依存しない（Turnstile スクリプトの読み込み結果を見ない）。
    //    ウィジェット生成の確認は次のテストが担い、そちらだけがネットワークに依存する。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillInquiryStep1(page)
    await page.getByTestId('apply-next').click()
    await expect(page.getByTestId('apply-step-confirm')).toBeVisible()

    const callbacks = await page.evaluate(() => {
      // `.cf-turnstile` では引かない——このクラスは**暗黙レンダリングを起こさないために
      // 意図的に外してある**（次のテストのコメント参照）。属性そのもので引く。
      const slot = document.querySelector('#turnstile-slot [data-sitekey]')
      const names = ['callback', 'expired-callback', 'error-callback'].map(
        (attribute) => slot?.getAttribute(`data-${attribute}`) ?? null,
      )
      return names.map((name) => ({
        name,
        defined:
          name === null
            ? null
            : typeof (window as unknown as Record<string, unknown>)[name] === 'function',
      }))
    })

    expect(callbacks[0].name, 'data-callback が描画されていない').toBeTruthy()
    for (const entry of callbacks) {
      if (entry.name === null) continue
      expect(entry.defined, `window.${entry.name} が関数として定義されていない`).toBe(true)
    }
  })

  test('Turnstile がトークンを実際に発行し、クライアントが受け取る', async ({ page }) => {
    // ネットワーク依存のテスト。**スクリプトが読めなかった環境では skip する**
    //（社内プロキシ・オフライン CI で赤くしても情報量が無い。フレーキーなテストは
    //  やがて誰も見なくなる）。読めた場合は「ウィジェットが本当に出る」ことを確認する。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillInquiryStep1(page)
    await page.getByTestId('apply-next').click()
    await expect(page.getByTestId('apply-step-confirm')).toBeVisible()

    const scriptLoaded = await page
      .waitForFunction(
        () => typeof (window as unknown as { turnstile?: unknown }).turnstile !== 'undefined',
        undefined,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false)
    test.skip(!scriptLoaded, 'Turnstile スクリプトを読み込めない環境（ネットワーク制限）')

    // **iframe の有無ではなくトークンの有無を見る。** RV-P3B-001 が指していた事故は
    // 「本番では全送信が Tier B(403) になる」であり、その成否を決めるのは
    // **トークンがクライアントに渡るか**だけである。iframe は Cloudflare 側の実装詳細で、
    // テスト用サイトキー `1x00000000000000000000AA` はチャレンジ UI を描画せずに
    // ダミートークンを即返す（実測）ため、iframe を数えると本番の可否と無関係に赤くなる。
    //
    // これが green なら排除される事故（実際に 2 度起きた）:
    //  - `turnstile.ready()` が async/defer 構成で throw し、描画関数が一度も呼ばれない
    //  - コンテナの `cf-turnstile` クラスで暗黙レンダリングが先に確保し、明示 render が no-op になる
    // いずれの状態でも hidden input は生成されるが **value は空のまま**なので、値まで見る。
    await expect
      .poll(
        () =>
          page
            .locator('#turnstile-slot input[name="cf-turnstile-response"]')
            .inputValue()
            .catch(() => ''),
        {
          timeout: 15_000,
          message: 'Turnstile トークンが取得できていない（本番なら全送信が Tier B(403)）',
        },
      )
      .not.toBe('')
  })
})

/* ========================================================================= *
 * RV-P3B-002: `?fs=1` を URL に残さない
 * ========================================================================= */

test.describe('RV-P3B-002: 発行済みマーカーが URL に残らない', () => {
  test('/apply を開いた後の URL に fs パラメータが無い', async ({ page }) => {
    // これが green なら排除される不具合: 発行後の `/apply?fs=1` が**アドレスバーに残り**、
    // Cookie（Max-Age 1,800 秒）が切れた後のリロード・ブックマーク・URL 共有で
    // **再発行が二度と行われなくなる**こと。利用者は全項目を入力した後に 403 を受け、
    // 回復手段が無い（レビュー :169-179 の時系列表）。
    // Cookie をブロックしている利用者を救うための分岐が、
    // **Cookie を受け入れる普通の利用者にまで当たっている**のが本件である。
    await page.goto(APPLY_PATH)
    await expect(page.getByTestId('apply-draft-clear')).toBeVisible()
    // **同期 assertion にしない（RV-P3B-018 と同じ race）。** WebKit は `http://localhost` で
    // Secure Cookie を受理しないため `hasSession` が常に false になり、サーバー側の `?fs` 除去
    // （条件は `hasSession && issued`）が発火しない。除去はクライアントの `replaceState` だけが担うので、
    // 要素の可視化とハイドレーション完了の間に隙があり、スイート全体の負荷下では判定が先行しうる。
    // **測りたい性質（マーカーが URL に残らない）は変えていない**——到達を待つだけである。
    await expect
      .poll(() => new URL(page.url()).searchParams.has('fs'), {
        message: '発行済みマーカー ?fs が URL に残り続けている（RV-P3B-002）',
      })
      .toBe(false)
  })

  test('リロード後も Cookie が無ければ必ず再発行される', async ({ page, context, browserName }) => {
    // WebKit は `http://localhost` で Secure Cookie を受理しないため `__Host-fs` が保存されない
    //（本番は https。Cookie 名を環境で出し分ける案は Security 監査 §E-1 が明確に却下している
    //  ——本番でだけ有効な属性が CI で一度も実行されなくなるため）。属性そのものは
    //  `formSessionCookieAttributes()` のユニットが、発行経路は結合テストが独立に固定している。
    test.skip(browserName === 'webkit', 'WebKit は http://localhost で Secure Cookie を受理しないため')
    // マーカーを消すことの**目的**側を固定する（URL の見た目ではなく振る舞い）。
    // Cookie を明示的に消してからリロードし、`__Host-fs` が再び発行されることを見る。
    await page.goto(APPLY_PATH)
    // **`?fs` が消えるのを待ってからリロードする（RV-P3B-018）。**
    // 縮退構成では共有 `unknown` バケットが無コスト枠(10)を早々に超えるため Cookie に
    // `unverified` の印が付き、`hasSession` が false になってサーバー側の `?fs` 除去が発火しない。
    // その状態で待たずにリロードすると `/apply?fs=1` を要求してしまい、サーバーは
    // 「発行は試み済み」と判断して再発行しない——テストが**自分でレースを踏んで**赤くなる。
    await expect.poll(() => new URL(page.url()).searchParams.has('fs')).toBe(false)
    await context.clearCookies()
    await page.reload()

    const cookies = await context.cookies()
    expect(
      cookies.find((cookie) => cookie.name === '__Host-fs'),
      'Cookie が無いのに再発行されていない（?fs=1 が URL に残っている疑い）',
    ).toBeTruthy()
  })
})

/* ========================================================================= *
 * AC-RL-13(a): フォームセッション Cookie の発行（P3-b で配線される）
 * ========================================================================= */

test.describe('AC-RL-13(a) / AC-008-4: フォームセッション Cookie の発行', () => {
  test('GET /apply が __Host-fs Cookie を Set-Cookie する', async ({ page, context, browserName }) => {
    // 上記と同じ理由（Security 監査 §E-1）。**`__Host-` 接頭辞は維持する。**
    test.skip(browserName === 'webkit', 'WebKit は http://localhost で Secure Cookie を受理しないため')
    // これが green なら排除される状態: Cookie が発行されず、**すべての送信が Tier B に落ちる**
    //（縮退構成では Cookie 軸が唯一の Tier D 軸なので、発行されないと防御も UX も両方壊れる）。
    await page.goto(APPLY_PATH)
    const cookies = await context.cookies()
    const formSession = cookies.find((cookie) => cookie.name === '__Host-fs')
    expect(formSession, '__Host-fs が発行されていない（AC-RL-13(a)）').toBeTruthy()
    expect(formSession!.httpOnly, 'HttpOnly でないと XSS で sid を読める').toBe(true)
    expect(formSession!.sameSite).toBe('Lax')
    expect(formSession!.path).toBe('/')
  })

  test('Cookie の値がフォーム状態そのものを含まない（Cookie に入力値を書かない / AC-008-3）', async ({
    page,
    context,
  }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await page.getByLabel('氏名', { exact: false }).first().fill('クッキー検出用ZZQ')

    const cookies = await context.cookies()
    const serialized = cookies.map((cookie) => cookie.value).join('|')
    expect(serialized, 'Cookie にフォーム値が書かれている（AC-008-3）').not.toContain('ZZQ')
  })
})

/* ========================================================================= *
 * AC-008-2: INQUIRY では申込専用項目を DOM に描画しない
 * ========================================================================= */

test.describe('AC-008-2: type=INQUIRY で申込専用項目が DOM に存在しない', () => {
  /** AC-008-2 が列挙するフィールド（**ステップ番号ではなくフィールドで判定する**）。 */
  const APPLICATION_ONLY_FIELDS = [
    'plans',
    'courseId',
    'school',
    'format',
    'postalCode',
    'address',
    'buildingName',
    'licenseRevoked',
    'licenseRevokedNote',
    'currentLicenses',
    'preferredStartMonth',
    'paymentMethod',
  ]

  test('列挙された入力要素が1つも存在しない（hidden でも非活性でもなく不在）', async ({ page }) => {
    // これが green なら排除される事故: `hidden` 属性や `disabled` で「隠す」実装。
    // **DOM に在れば送信されうる**（自動入力・拡張機能・改造したクライアント）。
    // 最小収集原則（APPI / business §4.3）は「見せない」ではなく「**受け取らない・持たない**」
    // ことを要求しており、その最初の層が「描画しない」である。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')

    for (const field of APPLICATION_ONLY_FIELDS) {
      await expect(
        page.locator(`[name="${field}"]`),
        `INQUIRY で ${field} が DOM に存在する`,
      ).toHaveCount(0)
    }
  })

  test('免許証写真アップローダが存在しない（P3-c の要素も INQUIRY では出さない）', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
  })

  test('type=APPLICATION では申込専用項目が現れる（逆方向の固定）', async ({ page }) => {
    // 「常に描画しない」実装で AC-008-2 を満たしたことにしない。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'application')
    await expect(page.locator('[name="school"]').first()).toBeVisible()
  })
})

/* ========================================================================= *
 * AC-008-3: 下書き保存（sessionStorage の条件付き許可）
 * ========================================================================= */

test.describe('AC-008-3: 下書き保存の条件', () => {
  test('localStorage にフォーム値が書かれない', async ({ page }) => {
    // これが green なら排除される事故: 「下書きが消えて不便」という理由で `localStorage` へ移すこと。
    // **タブを閉じても残る＝共有端末（受付端末・学校の PC・ネットカフェ）に個人情報が残留する。**
    // ⚠️ `sessionStorage` が空であることをアサートしてはならない（`application-form.md` §11-5）
    //     ——下書き保存は AC-008-3 が明示的に許可した振る舞いである。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await page.getByLabel('氏名', { exact: false }).first().fill('ローカル検出用ZZQ')
    await page.waitForTimeout(1_000) // 下書き保存のデバウンスを跨ぐ

    const local = await page.evaluate(() => JSON.stringify(window.localStorage))
    expect(local, 'localStorage にフォーム値が書かれている').not.toContain('ZZQ')
  })

  test('(b) リロード後に自動復元しない（利用者が押すまで値が入らない）', async ({ page }) => {
    // これが green なら排除される事故: 共有端末で次の利用者がページを開いた瞬間に
    // **前の人の氏名・生年月日・連絡先が画面に復元される**こと。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    const nameInput = page.getByLabel('氏名', { exact: false }).first()
    await nameInput.fill('自動復元検出用ZZQ')
    await page.waitForTimeout(1_000)

    await page.reload()
    await chooseType(page, 'inquiry')
    await expect(
      page.getByLabel('氏名', { exact: false }).first(),
      '利用者の操作なしに値が復元されている（AC-008-3 (b)）',
    ).toHaveValue('')
    await expect(page.getByTestId('apply-draft-restore')).toBeVisible()
  })

  test('(c) 「今すぐ削除する」導線が常時表示されている', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await expect(page.getByTestId('apply-draft-clear')).toBeVisible()
    await chooseType(page, 'inquiry')
    await expect(page.getByTestId('apply-draft-clear')).toBeVisible()
  })

  test('(d) 破棄操作で sessionStorage の下書きキーが消える', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await page.getByLabel('氏名', { exact: false }).first().fill('破棄検出用ZZQ')
    await page.waitForTimeout(1_000)
    expect(await page.evaluate(() => JSON.stringify(window.sessionStorage))).toContain('ZZQ')

    await page.getByTestId('apply-draft-clear').click()
    const session = await page.evaluate(() => JSON.stringify(window.sessionStorage))
    expect(session, '破棄操作で下書きが removeItem されていない（AC-008-3 (d)）').not.toContain('ZZQ')
  })
})

/* ========================================================================= *
 * AC-008-6 / AC-PII-2: エラー表示に入力値を出さない
 * ========================================================================= */

test.describe('AC-008-6 / AC-PII-2: エラーメッセージに入力値が含まれない', () => {
  test('形式不正のメールを入れてもエラー文言に入力値が現れない', async ({ page }) => {
    // `application-form.md` §11-2 が「これは P3 のセキュリティ受け入れ条件そのもの」と書いている項目。
    // これが green なら排除される事故: エラー文言に入力値を出す実装。
    // **画面のスクリーンショットは問い合わせ対応で共有され、エラーログにも残る**ため、
    // 表示するだけでも個人情報の拡散経路になる。
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await page.getByLabel('メール', { exact: false }).first().fill('echo-probe-zzq@@example.com')
    await page.getByTestId('apply-next').click()

    const alerts = page.getByRole('alert')
    await expect(alerts.first()).toBeVisible()
    expect(await alerts.allInnerTexts().then((texts) => texts.join('\n'))).not.toContain('zzq')
  })

  test('年齢下限エラーに生年月日の文字列が含まれない（SPEC-007 / §11-9）', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await page.getByLabel('生年月日', { exact: false }).first().fill('2020-03-15')
    await page.getByTestId('apply-next').click()

    const texts = await page.getByRole('alert').allInnerTexts()
    expect(texts.join('\n')).not.toContain('2020-03-15')
  })
})

/* ========================================================================= *
 * AC-008-7: 確認画面はクライアント状態のみから描画する
 * ========================================================================= */

test.describe('AC-008-7: 確認画面はサーバー往復しない', () => {
  test('確認画面へ進む間に個人情報を含む POST が発生しない', async ({ page }) => {
    // これが green なら排除される設計事故: 「確認内容をサーバーで整形する」ために
    // 確認画面の前に個人情報を POST すること。**送信を取りやめた利用者の個人情報が
    // サーバーへ渡り、ログ・APM・WAF の記録に残る**（保持期間の約束の外側で複製が生まれる）。
    const posts: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url())
    })

    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillInquiryStep1(page)
    await page.getByTestId('apply-next').click()
    await expect(page.getByTestId('apply-step-confirm')).toBeVisible()

    expect(
      posts.filter((url) => url.includes('/api/applications')),
      '確認画面到達までに /api/applications へ POST している',
    ).toEqual([])
  })
})

async function fillInquiryStep1(page: Page) {
  await page.getByLabel('氏名', { exact: false }).first().fill('山田 太郎')
  await page.getByLabel('氏名カナ', { exact: false }).first().fill('ヤマダ タロウ')
  await page.getByLabel('生年月日', { exact: false }).first().fill('2000-05-05')
  await page.getByLabel('メール', { exact: false }).first().fill('taro@example.com')
  await page.getByLabel('電話', { exact: false }).first().fill('090-1234-5678')
}

/* ========================================================================= *
 * AC-008-5 / F-023: /privacy と同意リンク
 * ========================================================================= */

test.describe('AC-008-5 / F-023: プライバシーポリシーと同意', () => {
  test('/privacy が 200 で、保持期間が明記されている', async ({ page }) => {
    // これが green なら排除される事故: 「保持期間を実装が持つ」（AC-PII-5）と
    // 「利用者に約束した保持期間」が食い違うこと。**約束が書かれていなければ APPI の説明義務を満たさない。**
    await page.goto('/privacy')
    const body = await page.locator('main').innerText()
    expect(body).toContain('3年')
    expect(body).toContain('1年')
    expect(body).toContain('30日')
    expect(body).toContain('180日')
  })

  test('同意チェックのラベルから /privacy へリンクしている', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillInquiryStep1(page)
    await page.getByTestId('apply-next').click()
    await expect(page.getByTestId('apply-step-confirm')).toBeVisible()
    await expect(page.locator('a[href="/privacy"]').first()).toBeVisible()
  })

  test('同意しなければ送信ボタンが有効化されない', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillInquiryStep1(page)
    await page.getByTestId('apply-next').click()
    await expect(page.getByTestId('apply-submit')).toBeDisabled()
  })
})

/* ========================================================================= *
 * AC-PII-9 の公開側（写真は P3-c だが、公開経路に objectKey が出ないことは今から固定する）
 * ========================================================================= */

test.describe('AC-PII-9: 公開ページのレスポンスに objectKey が現れない', () => {
  test('/apply の HTML に objectKey / 署名付き URL が現れない', async ({ request }) => {
    // 写真は P3-c だが、**「公開側から到達できない」という性質は経路が増える前に固定するほうが安い**。
    const response = await request.get(APPLY_PATH)
    const html = await response.text()
    expect(html).not.toContain('objectKey')
    expect(html).not.toContain('blob.vercel-storage.com')
  })
})
