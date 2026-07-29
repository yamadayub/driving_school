import { test, expect, type Page } from '@playwright/test'

/**
 * =========================================================================
 * P3-c2 E2E — F-009（免許証写真アップロード）/ **RV-P3B-019**（送信成功の経路）/
 *             AC-008-3(e)（`uploadToken` を下書きに保存しない）/ AC-009-11
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` F-009 AC-009-11 / AC-008-3(e)、
 *       `docs/phase-status.md`「P3-c2 の完了条件（申し送り）」2・3、
 *       `docs/review-p3c1-code-re-2026-07-29.md` §5-2、
 *       `docs/ui-design/license-upload.md`。
 *
 * =========================================================================
 * ⚠️ セレクタは「既存 UI」と「新規 UI」を分けて持つ（**初版の不具合の再発防止**）
 * =========================================================================
 * 初版は `getByLabel(/お名前/)` `getByLabel(/フリガナ/)` など**実在しないラベル**を使っており、
 * さらに**単一ページのフォームだと誤認**していた（実際は `course → personal → license →
 * preference → review` のステップ式 / `components/apply/form-model.ts:38`）。
 * その結果、写真と無関係な RV-P3B-019（送信成功の通し）まで入力段階でタイムアウトし、
 * **14 件失敗 / 44.7 分**（通常 1.5 分）を消費した。
 *
 * 原因は「**テスト設計者もレビュワーも E2E を実行できない**（ポート 3000 の制約）ため、
 * セレクタの実在性を誰も検証していなかった」ことである。
 * ユニット / 結合は型検査が守るが、**E2E のセレクタは文字列なので何も守らない**——
 * このプロジェクトが繰り返してきた「測っていない継ぎ目」がテスト側に出た形である。
 *
 * 以後、**既存 UI を指すセレクタは `EXISTING` / `EXISTING_LABEL` に集約**し、
 * 実在性を `tests/unit/e2e-selector-contract.test.ts` がソース走査で固定する。
 * **`NEW` は Impl がこれから実装して満たす契約なので、実装に合わせて変えてはならない。**
 *
 * =========================================================================
 * ⚠️ WebKit は対象外（**黙って除外しない**）
 * =========================================================================
 * **WebKit は `http://localhost` で `__Host-` 接頭辞（= `Secure` 必須）の Cookie を受理しない。**
 * したがって WebKit の E2E は**常に「Cookie 無し」経路**を走っており、
 * フォームセッション Cookie 軸（= uploads の Tier B / Tier D 判定の土台）を
 * **一度も通っていない**（`docs/review-p3c1-code-re-2026-07-29.md` §5-2 の実測）。
 * uploads は Cookie 軸に依存するので、WebKit で走らせても
 * **検証したい防御を 1 つも検証しないまま green になる**。
 *
 * **中期課題**: E2E を HTTPS で回せば WebKit でも Cookie 経路を通せる（設計文書 §9.2）。
 *
 * =========================================================================
 * RV-P3B-019 — 「軸を分ける」形で送信成功の経路を通す
 * =========================================================================
 * E2E サーバーは `TRUST_PROXY=1` で起動する（`playwright.config.ts` の `webServer.env`）。
 * **閾値も窓も 1 つも緩めていない。** 変えたのは「発信元軸が要求元ごとに分かれる」ことだけで、
 * それは本番（Vercel）で実際に成立している状態である（設計文書 §9.1）。
 *
 * ⚠️ 実行前提: E2E は `pnpm build && pnpm start`（本番ビルド）に対して走る。
 * 送信間隔下限（AC-RL-6 / 3 秒）があるため、送信を伴うシナリオでは待つこと。
 * Turnstile は Cloudflare の**常に成功するテストキー**（`.env` の `1x0000…`）を使う。
 */

const APPLY_PATH = '/apply'

/**
 * **既存 UI**（P3-b で Senior 承認済みの契約）。
 * ここは**実装に合わせる**——フォーム側を変えない。
 * 実在性は `tests/unit/e2e-selector-contract.test.ts` が固定する。
 */
const EXISTING = {
  /** 種別選択（`components/apply/steps/StepEntry.tsx`）。 */
  typeApplication: 'apply-type-application',
  typeInquiry: 'apply-type-inquiry',
  /** ステップ送り / 送信（`components/apply/ApplicationForm.tsx`）。 */
  next: 'apply-next',
  submit: 'apply-submit',
  /** 確認ステップ（`components/apply/steps/StepReview.tsx`）。 */
  stepConfirm: 'apply-step-confirm',
  /** 完了画面の受付番号（`ApplicationForm.tsx`）。**`apply-receipt-number` ではない。** */
  completeReceipt: 'complete-receipt',
  /** 下書きの `sessionStorage` キー（`lib/apply-draft.ts` の `APPLY_DRAFT_STORAGE_KEY`）。 */
  draftStorageKey: 'apply-draft/v1',
} as const

/**
 * **既存 UI のラベル**（`getByLabel(..., { exact: false })` で使う）。
 * `apply-form.spec.ts:471-477` が同じ表現で通っているものだけを採る。
 */
const EXISTING_LABEL = {
  name: '氏名',
  nameKana: '氏名カナ',
  birthDate: '生年月日',
  email: 'メール',
  phone: '電話',
  /** 自由記述（`PreferenceCommonFields.tsx` の `id="message"`）。**「お問い合わせ内容」ではない。** */
  message: 'ご質問・ご要望',
  /** コース選択（`StepCourse.tsx` の `id="courseId"`）。 */
  course: 'コース',
  /** **APPLICATION の個人情報ステップでは必須**（`STEP_FIELDS.personal` / `StepPersonal.tsx:97,108`）。 */
  postalCode: '郵便番号',
  address: '住所',
} as const

/**
 * **既存 UI の選択肢**（`form-model.ts:124-138`）。
 * `CheckboxGroup` / `RadioCardGroup` はいずれも `<label>` の中に
 * ネイティブの `<input>` を置くので、可視テキストで指せる。
 */
const EXISTING_OPTION = {
  plan: '通常プラン',
  school: '岩滝校',
  format: '通学',
} as const

/**
 * **新規 UI**（F-009 で Impl がこれから実装する契約）。
 * **実装に合わせて変えてはならない。** これらは「実装がこの testid を出す」という要求である。
 */
const NEW = {
  photoFrontInput: 'license-photo-front',
  photoFrontPreview: 'license-photo-front-preview',
  photoFrontError: 'license-photo-front-error',
} as const

/**
 * **クライアント検証のメッセージ**（`components/apply/LicensePhotoUpload.tsx:76-100`）。
 *
 * ⚠️ **「エラーが出ていること」だけを見てはならない。**
 * E2E はローカルストレージアダプタで動くが、そのアダプタは
 * `local-storage:<hash>` という **HTTP で PUT できない URL** を返すため、
 * 実装は正しく「この環境では写真のアップロードをご利用いただけません。」で失敗する
 *（同 :168-180。**成功したことにしない**という正しい判断）。
 *
 * つまり**どんなファイルを選んでもエラー要素は必ず出る**ので、
 * `toBeVisible()` だけの検査は**クライアント検証を丸ごと削除しても green のまま**になる。
 * したがって**メッセージ本文まで検査する**（申し送り原則: 空振りを green と報告しない）。
 */
const CLIENT_ERROR = {
  tooLarge: 'ファイルサイズが大きすぎます',
  notImage: 'JPEG・PNG・WebP の画像を選んでください',
  /** 環境要因。**検証の成否とは無関係**なので、これが出ていたら検証は測れていない。 */
  unavailable: 'この環境では写真のアップロードをご利用いただけません',
} as const

/** テストごとに一意な発信元（軸を分ける / RV-P3B-019）。 */
function uniqueClientIp(): string {
  const n = Math.floor(Math.random() * 250) + 1
  const m = Math.floor(Math.random() * 250) + 1
  return `198.51.${n}.${m}`
}

/** 1x1 の最小 JPEG（マジックバイト `FF D8 FF` を持つ実体）。 */
const JPEG_FIXTURE = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])

/** 実体は HTML だがファイル名と MIME は JPEG を騙る攻撃入力。 */
const FAKE_JPEG = Buffer.from('<html><script>alert(1)</script></html>', 'utf8')

async function chooseType(page: Page, type: 'application' | 'inquiry') {
  await page
    .getByTestId(type === 'application' ? EXISTING.typeApplication : EXISTING.typeInquiry)
    .click()
}

/**
 * 個人情報ステップを埋める（`apply-form.spec.ts:471-477` と同じ表現）。
 *
 * ⚠️ **APPLICATION では `postalCode` / `address` も必須**である
 * （`form-model.ts:45-55` の `STEP_FIELDS.personal` と
 *  `lib/validators/application.ts` の APPLICATION 分岐）。
 * 埋めないと `apply-next` が検証で止まり、**次のステップへ進めない**
 * ——これが F-009 の 4 件が「氏名が見つからない」で 60 秒待ち続けた原因の一部である。
 */
async function fillPersonalStep(
  page: Page,
  options: { email?: string; withAddress?: boolean } = {},
) {
  await page.getByLabel(EXISTING_LABEL.name, { exact: false }).first().fill('写真 太郎')
  await page.getByLabel(EXISTING_LABEL.nameKana, { exact: false }).first().fill('シャシン タロウ')
  await page.getByLabel(EXISTING_LABEL.birthDate, { exact: false }).first().fill('2000-05-05')
  await page
    .getByLabel(EXISTING_LABEL.email, { exact: false })
    .first()
    .fill(options.email ?? 'e2e-photo@example.com')
  await page.getByLabel(EXISTING_LABEL.phone, { exact: false }).first().fill('090-1234-5678')

  if (options.withAddress) {
    await page.getByLabel(EXISTING_LABEL.postalCode, { exact: false }).first().fill('6260001')
    await page.getByLabel(EXISTING_LABEL.address, { exact: false }).first().fill('京都府宮津市字文珠1')
  }
}

/**
 * APPLICATION の**免許ステップ**まで進む。
 *
 * ステップ順は `components/apply/form-model.ts:38`:
 * `['course', 'personal', 'license', 'preference', 'review']`
 * ——**単一ページのフォームではない。** 初版はこれを見落として全項目を 1 画面で埋めようとしていた。
 */
async function gotoLicenseStep(page: Page) {
  await page.goto(APPLY_PATH)
  await chooseType(page, 'application')

  /*
   * 1) コースステップ。
   *
   * ⚠️ **必須は `courseId` だけではない。** `STEP_FIELDS.course`（`form-model.ts:44`）は
   * `['plans', 'courseId', 'school', 'format']` であり、APPLICATION では 4 つとも必須である。
   * 初版は `courseId` しか選ばず、`apply-next` が検証で止まって**個人情報ステップへ進めなかった**
   * ——「`getByLabel('氏名')` が見つからない」という失敗の正体はこれである
   *（氏名は次のステップにあり、そもそも描画されていなかった）。
   */
  await page.getByLabel(EXISTING_OPTION.plan, { exact: false }).first().check()

  const course = page.getByLabel(EXISTING_LABEL.course, { exact: false }).first()
  await expect(course).toBeVisible()
  // **`nth(1)` を決め打ちしない**（seed のコース数に依存する / Impl の事前申告）。
  // 値が空でない最初の option を選ぶ。
  const courseValue = await course
    .locator('option')
    .filter({ hasNotText: '選択してください' })
    .first()
    .getAttribute('value')
  expect(courseValue, '公開コースが 1 件も無い（seed を確認すること）').toBeTruthy()
  await course.selectOption(courseValue!)

  await page.getByLabel(EXISTING_OPTION.school, { exact: false }).first().check()
  await page.getByLabel(EXISTING_OPTION.format, { exact: false }).first().check()
  await page.getByTestId(EXISTING.next).click()

  // 2) 個人情報ステップ（APPLICATION は郵便番号・住所も必須）。
  await expect(page.getByLabel(EXISTING_LABEL.name, { exact: false }).first()).toBeVisible()
  await fillPersonalStep(page, { withAddress: true })
  await page.getByTestId(EXISTING.next).click()

  // 3) 免許ステップ（写真 UI はここに入る / `components/apply/steps/StepLicense.tsx`）。
  await expect(page.getByTestId(NEW.photoFrontInput)).toBeVisible()
}

/**
 * **Turnstile が実際にトークンを発行するまで待つ。**
 *
 * ⚠️ 固定待ち（`waitForTimeout(3_500)`）では**足りない**。
 * それが満たすのは AC-RL-6（送信間隔下限 3 秒）だけで、
 * **ウィジェットのコールバックが返ったことは何も保証しない。**
 *
 * 実測（`test-results/…-chromium-retry1/trace.zip` の送信ボディ）:
 * ```json
 * { …, "captchaToken": "", "hp_field": "" }   → 403 {"challenge":"interactive"}
 * ```
 * Cookie は正規（`unverified` の印なし）、`x-real-ip` も送られていた。
 * **Tier B の原因は空の `captchaToken` ただ 1 つ**である。
 * chromium だけが落ちて firefox が通ったのは、**待ち時間と描画完了の競争に負けたかどうか**
 * の違いにすぎない（＝ 固定待ちに依存した設計そのものが誤り）。
 *
 * `ApplicationForm.resolveCaptchaToken()` は state か `window.turnstile.getResponse()` を使うので、
 * **`getResponse()` が非空になったこと**が送信可能の正しい前提である。
 */
async function waitForCaptchaToken(page: Page) {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { turnstile?: { getResponse?: () => string | undefined } })
        .turnstile
      return typeof api?.getResponse === 'function' && Boolean(api.getResponse())
    },
    undefined,
    { timeout: 30_000 },
  )
}

test.describe('F-009: 免許証写真アップロード', () => {
  // **WebKit を明示的に対象外にする（理由はファイル冒頭）。**
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'WebKit は http://localhost で __Host- (Secure) Cookie を受理せず、常に「Cookie 無し」経路を走る。' +
      ' uploads は Cookie 軸に依存するため、WebKit では検証したい防御を 1 つも通らない。' +
      ' HTTPS 化は中期課題（設計文書 §9.2）。',
  )

  test.beforeEach(async ({ context }) => {
    // RV-P3B-019: 軸を分ける。**上限は緩めていない。**
    await context.setExtraHTTPHeaders({ 'x-real-ip': uniqueClientIp() })
  })

  test('実体が HTML のファイルを .jpg として選んでも受け付けない', async ({ page }) => {
    // これが green なら排除される攻撃: 実体 HTML を格納し、
    // F-018 の閲覧経路で `text/html` 解釈されて**管理者のセッションに対する XSS** になること。
    // クライアント側の拡張子検査だけでは防げない（申告値は攻撃者が決める）ので、
    // **サーバーがマジックバイトで実体を見る**ことまでを通しで確認する。
    await gotoLicenseStep(page)

    await page.getByTestId(NEW.photoFrontInput).setInputFiles({
      name: 'license.jpg',
      mimeType: 'image/jpeg',
      buffer: FAKE_JPEG,
    })

    const error = page.getByTestId(NEW.photoFrontError)
    await expect(error, '実体が画像でないファイルがエラーにならない').toBeVisible()
    // **メッセージまで見る。** 環境要因のエラー（アップロード不可）で green になると、
    // クライアント検証を削除しても気付けない。
    await expect(
      error,
      `環境要因のエラーで green になっている（マジックバイト検証を測れていない）`,
    ).toContainText(CLIENT_ERROR.notImage)
  })

  test('5MB を超えるファイルは選択時に拒否される（E-009-2）', async ({ page }) => {
    await gotoLicenseStep(page)

    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1)
    JPEG_FIXTURE.copy(oversized, 0)
    await page.getByTestId(NEW.photoFrontInput).setInputFiles({
      name: 'big.jpg',
      mimeType: 'image/jpeg',
      buffer: oversized,
    })

    const error = page.getByTestId(NEW.photoFrontError)
    await expect(error).toBeVisible()
    await expect(
      error,
      '環境要因のエラーで green になっている（サイズ検証を測れていない）',
    ).toContainText(CLIENT_ERROR.tooLarge)
  })

  test('写真を選んでも sessionStorage の下書きに objectKey / uploadToken が保存されない', async ({
    page,
  }) => {
    // **P3c-11 が名指しで E2E へ引き取った項目である。**
    // `lib/apply-draft.ts` は P3-b の時点で `DRAFT_FORBIDDEN_KEYS` に
    // `objectKey` / `uploadToken` / `previewUrl` / `licensePhotos` を列挙して**網を先に張った**。
    // 本テストはその網が**実際に効く**ことを、写真が存在する状態で初めて確認する。
    //
    // これが green なら排除される事故: 共有端末（受付端末・学校の PC・ネットカフェ）に
    // `uploadToken` が残り、**後続の利用者が他人の免許証画像を自分の申込に紐付けられる**こと。
    //
    // ------------------------------------------------------------------
    // ⚠️ 順序と待ちが本質である（初版はここで前提が崩れて落ちた / §15）
    // ------------------------------------------------------------------
    // 1. **写真を先に添付する。** 後に書かれた下書きでないと、
    //    「写真がある状態のスナップショット」を検査したことにならない。
    // 2. **写真の添付だけでは下書きは書かれない。**
    //    `ApplicationForm.tsx:167-173` は写真を `useRef`（`photosRef`）に置き、
    //    `setPhoto` は `setState` を呼ばない——`values` が変わらないので
    //    下書き書き込みの `useEffect`（deps `[values, type, submission.kind]`）は再実行されない。
    //    **これは意図的な設計**（`values` に入れると下書き経路に乗る / AC-008-3(e)）なので、
    //    テスト側が**別の値変更**で書き込みを発火させる。
    // 3. **書かれるまで待つ。** 同エフェクトは **400ms のデバウンス**を持つ。
    //    初版は最後の入力から **107ms** で読み出しており（trace 実測）、
    //    タイマーが発火する前に `null` を読んでいた。**固定待ちではなく条件待ちにする。**
    await gotoLicenseStep(page)

    // 1) 先に写真を添付する。
    await page.getByTestId(NEW.photoFrontInput).setInputFiles({
      name: 'license.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG_FIXTURE,
    })
    await expect(page.getByTestId(NEW.photoFrontPreview)).toBeVisible()

    // 2) 写真がある状態で `values` を変え、下書き書き込みを発火させる
    //    （免許取消歴は同じステップ上にあり、`setValue` を通る）。
    await page.getByLabel('ありません', { exact: false }).first().check()

    // 3) デバウンス（400ms）を条件待ちで越える。
    await expect
      .poll(
        async () =>
          page.evaluate((key) => window.sessionStorage.getItem(key), EXISTING.draftStorageKey),
        {
          message: '下書きが保存されていない（前提が崩れている）',
          timeout: 10_000,
        },
      )
      .not.toBeNull()

    const draft = await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      EXISTING.draftStorageKey,
    )

    for (const forbidden of ['objectKey', 'uploadToken', 'previewUrl', 'licensePhotos', 'blob:']) {
      expect(draft, `下書きに ${forbidden} が保存されている（AC-008-3(e) 違反）`).not.toContain(
        forbidden,
      )
    }
  })

  test('localStorage には下書きを保存しない（AC-008-3(a)）', async ({ page }) => {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await page.getByLabel(EXISTING_LABEL.name, { exact: false }).first().fill('保存先確認 太郎')

    const local = await page.evaluate(() => JSON.stringify(window.localStorage))
    expect(local).not.toContain('apply-draft')
  })

  /*
   * ⚠️ **AC-009-11(b)（非表示中は再発行しない）の E2E は削除した（CR-003）。**
   *
   * 削除前のテストは「3 秒待って `POST /api/uploads/license` が 0 件」を見ていたが、
   * `components/apply/LicensePhotoUpload.tsx` の再発行は
   *   `REISSUE_TICK_MS = 30_000` / `REISSUE_BEFORE_MS = 120_000`
   * であり、**最初に再発行が起きうるのは発行から約 180 秒後**である。
   * さらにローカルアダプタでは状態が `failed` になるため**タイマーがそもそも張られない**。
   * つまり**実装を丸ごと削除しても green** になる——二重の意味で何も測っていなかった。
   *
   * 本プロジェクトの申し送り原則 4「**空振りしているテストを green として報告しない**」に従い、
   * 残さずに削除する。**空振りテストを残すのが最悪である**（後で「あるから確認済み」と誤読される）。
   *
   * **代替の担保**: `tests/unit/license-photo-reissue.test.ts` が判定を純関数として測る
   *（30 秒待たずに `hidden` / 期限 / 上限回数の全分岐を網羅できる）。
   * E2E で測れるのは「タイマーが張られること」までであり、
   * それは実アップロードが成立する環境（Vercel Blob）でなければ到達できない（§15.5）。
   */
})

/* ========================================================================= *
 * RV-P3B-019: **送信が成功する経路**を通す（P3-b からの Must Fix）
 * ========================================================================= */

test.describe('RV-P3B-019: 申込送信が成功する経路', () => {
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'WebKit は __Host- Cookie を受理しないため送信は必ず Tier B になる（ファイル冒頭の注記）。',
  )

  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders({ 'x-real-ip': uniqueClientIp() })
  })

  /** 問い合わせを確認ステップまで進める（INQUIRY のステップは `['personal', 'review']`）。 */
  async function gotoInquiryConfirm(page: Page, email: string) {
    await page.goto(APPLY_PATH)
    await chooseType(page, 'inquiry')
    await fillPersonalStep(page, { email })
    await page.getByTestId(EXISTING.next).click()
    await expect(page.getByTestId(EXISTING.stepConfirm)).toBeVisible()
  }

  /** 同意チェック（`StepReview.tsx` の `name="privacyConsent"`）。 */
  async function agree(page: Page) {
    await page.locator('input[name="privacyConsent"]').check()
  }

  test('問い合わせを送信して完了画面に到達する', async ({ page }) => {
    // **P3-b から繰り越した Must Fix。**
    // 「送信が成功する経路を通す E2E が 1 本も無い」状態では、
    // **フォーム全体が壊れていても E2E は green のまま**である
    //（RV-P3B-001 で実際に起きた「単体・結合・型検査・ビルドをすべて通過したまま
    //  Turnstile の結線が成立していなかった」と同じ型）。
    await gotoInquiryConfirm(page, 'e2e-submit@example.com')
    await agree(page)

    // **2 つの前提を両方満たしてから送る。**
    //  (1) AC-RL-6: 送信間隔下限 3 秒（Cookie の `issuedAt` からの経過）
    //  (2) Turnstile が実際にトークンを発行していること ← **固定待ちでは保証されない**
    // 初版は (1) だけを満たして送り、`captchaToken: ""` で Tier B になっていた（実測 / §14）。
    await page.waitForTimeout(3_500)
    await waitForCaptchaToken(page)
    await page.getByTestId(EXISTING.submit).click()

    await expect(
      page.getByTestId(EXISTING.completeReceipt),
      '送信が成功しない（Tier B に落ちている可能性: 発信元軸が分かれているか確認）',
    ).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(EXISTING.completeReceipt)).toContainText(/\w/)
  })

  test('完了画面に到達したら下書きが消えている（AC-008-3(d)）', async ({ page }) => {
    await gotoInquiryConfirm(page, 'e2e-draft@example.com')
    await agree(page)

    await page.waitForTimeout(3_500)
    await waitForCaptchaToken(page)
    await page.getByTestId(EXISTING.submit).click()
    await expect(page.getByTestId(EXISTING.completeReceipt)).toBeVisible({ timeout: 15_000 })

    const draft = await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      EXISTING.draftStorageKey,
    )
    expect(draft, '送信成功後も下書きが残っている（共有端末に個人情報が残留する）').toBeNull()
  })
})
