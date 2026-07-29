import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * =========================================================================
 * P3-c2 — **E2E セレクタの実在性**をユニットで固定する（再発防止）
 * =========================================================================
 *
 * ## なぜ必要になったのか（実際に起きた事故）
 * `tests/e2e/playwright/license-upload.spec.ts` の初版は
 * `getByLabel(/お名前/)` `getByLabel(/フリガナ/)` という**実在しないラベル**を使っていた
 *（実際は `氏名` / `氏名カナ`）。さらに**単一ページのフォームだと誤認**していた
 *（実際は `course → personal → license → preference → review` のステップ式）。
 *
 * その結果、写真と無関係な RV-P3B-019（送信成功の通し）まで入力段階でタイムアウトし、
 * **14 件失敗 / 44.7 分**（通常 1.5 分）を消費した。
 *
 * ## 原因は「測っていない継ぎ目」がテスト側に出たこと
 * **テスト設計者もレビュワーも E2E を実行できない**（ポート 3000 の制約）ため、
 * **セレクタの実在性を誰も検証していなかった。**
 * ユニット / 結合は型検査が守るが、**E2E のセレクタは文字列なので何も守らない**——
 * このプロジェクトが P3-c1 で 4 回繰り返した型が、今度はテスト自身に出た形である。
 *
 * ## 採った形
 * E2E スペックは既存 UI を指すセレクタを `EXISTING` / `EXISTING_LABEL` に**集約**した。
 * 本ファイルは、その文字列が**実際にコンポーネントに存在すること**をソース走査で固定する
 *（`tests/unit/application-form-client-wiring.test.ts` が結線をソースで固定したのと同じ手法）。
 *
 * ## この検査で捕まるもの / 捕まらないもの
 * - **捕まる**: 「E2E が参照しているラベル / testid が実装に存在しない」
 *   ——初版の事故はこれ。**44 分ではなく 1 秒で分かる。**
 * - **捕まらない**: セレクタは存在するがステップ順や可視条件が違う（初版のもう 1 つの誤り）。
 *   そこは E2E を実際に回すしかない。**本検査は「安い網」であって代替ではない。**
 *
 * ## 新規 UI は対象外
 * `license-photo-*` は **F-009 で Impl がこれから実装する契約**なので、
 * 「存在しないこと」が現時点で正しい。**本検査に含めない**
 *（含めると「実装に合わせてテストを変える」圧力が生まれる）。
 */

const REPO = process.cwd()
const SPEC_FILE = resolve(REPO, 'tests/e2e/playwright/license-upload.spec.ts')

function specSource(): string {
  return readFileSync(SPEC_FILE, 'utf8')
}

function read(relative: string): string {
  return readFileSync(resolve(REPO, relative), 'utf8')
}

/** 既存 UI の `data-testid` と、それを定義しているファイル。 */
const EXISTING_TESTIDS: ReadonlyArray<{ id: string; file: string }> = [
  { id: 'apply-type-application', file: 'components/apply/steps/StepEntry.tsx' },
  { id: 'apply-type-inquiry', file: 'components/apply/steps/StepEntry.tsx' },
  { id: 'apply-next', file: 'components/apply/ApplicationForm.tsx' },
  { id: 'apply-submit', file: 'components/apply/ApplicationForm.tsx' },
  { id: 'apply-step-confirm', file: 'components/apply/steps/StepReview.tsx' },
  { id: 'complete-receipt', file: 'components/apply/ApplicationForm.tsx' },
]

/** 既存 UI のラベルと、それを定義しているファイル。 */
const EXISTING_LABELS: ReadonlyArray<{ label: string; file: string }> = [
  { label: '氏名', file: 'components/apply/steps/StepPersonal.tsx' },
  { label: '氏名カナ', file: 'components/apply/steps/StepPersonal.tsx' },
  { label: '生年月日', file: 'components/apply/steps/StepPersonal.tsx' },
  { label: 'メールアドレス', file: 'components/apply/steps/StepPersonal.tsx' },
  { label: '電話番号', file: 'components/apply/steps/StepPersonal.tsx' },
  { label: 'ご質問・ご要望', file: 'components/apply/steps/PreferenceCommonFields.tsx' },
  { label: 'コース', file: 'components/apply/steps/StepCourse.tsx' },
  { label: '郵便番号', file: 'components/apply/steps/StepPersonal.tsx' },
  { label: '住所', file: 'components/apply/steps/StepPersonal.tsx' },
]

/* ========================================================================= *
 * 実在性
 * ========================================================================= */

describe('E2E セレクタの実在性: 既存 UI の data-testid', () => {
  it.each(EXISTING_TESTIDS)('$id が $file に存在する', ({ id, file }) => {
    // これが green なら排除される事故: E2E が実在しない testid を待ち続け、
    // **タイムアウト × リトライ × ブラウザ数**で実行時間が跳ね上がること（初版は 44.7 分）。
    expect(read(file), `${file} に data-testid="${id}" が無い`).toContain(`data-testid="${id}"`)
  })

  it('E2E スペックが参照する testid はすべて上の一覧に含まれる（集約の実効性）', () => {
    // **集約が形だけにならないようにする。**
    // スペックが一覧に無い既存 testid を直接書き始めたら、この検査を素通りしてしまう。
    // 新規 UI（`license-photo-*`）だけは実装前なので除外する。
    const referenced = [...specSource().matchAll(/getByTestId\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
      (match) => match[1],
    )
    const known = new Set(EXISTING_TESTIDS.map((entry) => entry.id))
    const unknown = referenced.filter((id) => !known.has(id) && !id.startsWith('license-photo-'))

    expect(
      unknown,
      `一覧に無い testid を直接参照している: ${unknown.join(', ')}` +
        '（EXISTING に集約し、本ファイルの一覧へ追加すること）',
    ).toEqual([])
  })
})

describe('E2E セレクタの実在性: 既存 UI のラベル', () => {
  it.each(EXISTING_LABELS)('label="$label" が $file に存在する', ({ label, file }) => {
    // 初版の事故そのもの: `お名前` / `フリガナ` は**どこにも存在しなかった**
    //（実際は `氏名` / `氏名カナ`）。
    expect(read(file), `${file} に label="${label}" が無い`).toContain(`label="${label}"`)
  })

  it('スペックのラベル定数が実装のラベルの部分文字列になっている', () => {
    // E2E は `getByLabel(x, { exact: false })` で部分一致させる。
    // したがって「スペックが持つ文字列」が「実装のラベル」の**部分文字列**であればよい。
    // 例: スペックの `メール` は実装の `メールアドレス` に一致する。
    //
    // これが green なら排除される事故: スペック側だけを直して
    // **実装に無い語（`お名前`）を部分一致のつもりで書く**こと。
    const spec = specSource()
    const literals = [
      ...(spec.match(/const EXISTING_LABEL = \{[\s\S]*?\} as const/)?.[0] ?? '').matchAll(
        /:\s*'([^']+)'/g,
      ),
    ].map((match) => match[1])

    expect(literals.length, 'EXISTING_LABEL が読み取れない（定数の形が変わった）').toBeGreaterThan(0)

    const allLabels = EXISTING_LABELS.map((entry) => entry.label)
    for (const literal of literals) {
      expect(
        allLabels.some((label) => label.includes(literal)),
        `スペックのラベル '${literal}' に一致する実装のラベルが無い（実在するのは: ${allLabels.join(' / ')}）`,
      ).toBe(true)
    }
  })
})

/* ========================================================================= *
 * ステップ構成（初版のもう 1 つの誤り）
 * ========================================================================= */

describe('E2E スペックがフォームのステップ構成と整合している', () => {
  it('APPLICATION は course → personal → license → preference → review の 5 ステップである', () => {
    // 初版は**単一ページのフォームだと誤認**し、全項目を 1 画面で埋めようとしていた。
    // ステップ構成が変わったら E2E のヘルパー（`gotoLicenseStep`）も直す必要がある、
    // ということを**この 1 件で気付けるようにする**。
    const model = read('components/apply/form-model.ts')
    expect(model).toMatch(
      /APPLICATION\s*:\s*\[\s*'course'\s*,\s*'personal'\s*,\s*'license'\s*,\s*'preference'\s*,\s*'review'\s*\]/,
    )
  })

  it('INQUIRY は personal → review の 2 ステップである', () => {
    const model = read('components/apply/form-model.ts')
    expect(model).toMatch(/INQUIRY\s*:\s*\[\s*'personal'\s*,\s*'review'\s*\]/)
  })

  it('同意チェックの name が privacyConsent である（E2E が locator で指している）', () => {
    // E2E は `input[name="privacyConsent"]` で指す（testid が無いため）。
    expect(read('components/apply/steps/StepReview.tsx')).toContain('name="privacyConsent"')
  })

  it('下書きの sessionStorage キーが E2E の参照値と一致する', () => {
    // `lib/apply-draft.ts` の `APPLY_DRAFT_STORAGE_KEY` を E2E が直書きしているので、
    // **値がずれたら気付けるようにする**（E2E からは import できない）。
    expect(read('lib/apply-draft.ts')).toContain("APPLY_DRAFT_STORAGE_KEY = 'apply-draft/v1'")
    expect(specSource()).toContain("draftStorageKey: 'apply-draft/v1'")
  })
})

/* ========================================================================= *
 * ステップを進めるために**必須の入力**（E2E が 60 秒待ち続けた原因）
 * ========================================================================= *
 *
 * F-009 の 4 件は「`getByLabel('氏名')` が見つからない」で失敗したが、
 * **氏名は次のステップにあり、そもそも描画されていなかった**——
 * コースステップの必須 4 項目のうち `courseId` しか埋めていなかったため
 * `apply-next` が検証で止まっていた。
 *
 * 「セレクタは実在するが、そこへ到達できない」は §13.4 で
 * 「本検査では捕まらない」と書いた区分そのものだった。**捕まえられる部分だけ捕まえる。**
 */

describe('E2E ヘルパーがステップの必須入力を満たしている', () => {
  it('コースステップの必須は plans / courseId / school / format の 4 つである', () => {
    // 実装側の定義を固定する。増減したら E2E のヘルパーも直す必要がある、と気付けるようにする。
    const model = read('components/apply/form-model.ts')
    expect(model).toMatch(
      /course\s*:\s*\[\s*'plans'\s*,\s*'courseId'\s*,\s*'school'\s*,\s*'format'\s*\]/,
    )
  })

  it('スペックがコースステップの 4 項目すべてに触れている', () => {
    // `courseId` だけを選んで次へ進もうとする初版の誤りを検出する。
    const spec = specSource()
    expect(spec, 'plans（教習プラン）を選んでいない').toContain('EXISTING_OPTION.plan')
    expect(spec, 'courseId を選んでいない').toContain('EXISTING_LABEL.course')
    expect(spec, 'school（校舎）を選んでいない').toContain('EXISTING_OPTION.school')
    expect(spec, 'format（受講形態）を選んでいない').toContain('EXISTING_OPTION.format')
  })

  it('スペックが参照する選択肢のラベルが実装に存在する', () => {
    const model = read('components/apply/form-model.ts')
    for (const option of ['通常プラン', '岩滝校', '通学']) {
      expect(model, `選択肢 '${option}' が form-model.ts に無い`).toContain(option)
    }
  })

  it('APPLICATION の個人情報ステップでは郵便番号・住所も埋める', () => {
    // `STEP_FIELDS.personal` に含まれ、APPLICATION では必須。
    // 埋めないと免許ステップ（写真 UI）へ到達できない。
    const spec = specSource()
    expect(spec).toContain('EXISTING_LABEL.postalCode')
    expect(spec).toContain('EXISTING_LABEL.address')
  })
})

/* ========================================================================= *
 * 送信の前提: **固定待ちで Turnstile を待たない**
 * ========================================================================= */

describe('E2E の送信フローが Turnstile のトークンを待つ', () => {
  it('waitForTimeout だけで送信していない（トークン発行を待つ関数がある）', () => {
    // **実測で確定した (B) の真因。**
    // `test-results/…-chromium-retry1/trace.zip` の送信ボディは
    // `{"captchaToken":"","hp_field":""}` → 403 `{"challenge":"interactive"}` だった。
    // Cookie は正規（印なし）、`x-real-ip` も送られていた。
    // **Tier B の原因は空の `captchaToken` ただ 1 つ**であり、
    // chromium だけが落ちたのは待ち時間と描画完了の競争に負けたからにすぎない。
    const spec = specSource()
    expect(spec, 'Turnstile のトークン発行を待つ関数が無い').toContain('waitForCaptchaToken')
    expect(spec, 'getResponse() でトークンの実在を確認していない').toContain('getResponse')
  })

  it('送信の直前に必ずトークン待ちを挟んでいる', () => {
    // `apply-submit` をクリックする箇所は、直前に `waitForCaptchaToken` を通ること。
    const spec = specSource()
    const clicks = [...spec.matchAll(/getByTestId\(EXISTING\.submit\)\.click\(\)/g)]
    expect(clicks.length, '送信クリックが見つからない').toBeGreaterThan(0)

    for (const click of clicks) {
      const before = spec.slice(Math.max(0, click.index! - 400), click.index!)
      expect(
        before,
        '送信の直前に waitForCaptchaToken が無い（固定待ちだけで送ると Tier B になる）',
      ).toContain('waitForCaptchaToken')
    }
  })
})

/* ========================================================================= *
 * 下書き（sessionStorage）の読み出しは**条件待ち**であること
 * ========================================================================= *
 *
 * 下書き書き込みの `useEffect`（`ApplicationForm.tsx:215-231`）は
 * **400ms のデバウンス**を持ち、deps は `[values, type, submission.kind]` である。
 * 写真は `photosRef`（`useRef`）に置かれ `setState` を通らないので、
 * **写真の添付だけでは下書きは書かれない**（AC-008-3(e) を守るための意図的な設計）。
 *
 * 初版はこれを知らずに、最後の入力から **107ms**（trace 実測）で
 * `sessionStorage` を 1 回だけ読み、`null` を受けて落ちていた。
 */

describe('E2E の下書き検査が書き込みを待っている', () => {
  it('sessionStorage の読み出し前に条件待ち（expect.poll）がある', () => {
    // これが green なら排除される再発: デバウンスが発火する前に読んで
    // **「前提が崩れている」で落ちる**こと（実装は正しいのにテストが落ちる）。
    const spec = specSource()
    expect(spec, 'sessionStorage を読む前の条件待ちが無い').toMatch(/expect\s*\.\s*poll\s*\(/)
  })

  it('写真を添付した後に values を変えてから下書きを読む', () => {
    // **順序が本質。** 写真より前に書かれた下書きを検査しても
    // 「写真がある状態のスナップショット」を見たことにならない。
    const spec = specSource()
    const draftTest = spec.slice(
      spec.indexOf("test('写真を選んでも sessionStorage"),
      spec.indexOf("test('localStorage には下書きを保存しない"),
    )
    expect(draftTest.length, '下書きテストが読み取れない').toBeGreaterThan(0)

    const photoAt = draftTest.indexOf('setInputFiles')
    const valueChangeAt = draftTest.indexOf("getByLabel('ありません'")
    const readAt = draftTest.indexOf('sessionStorage.getItem')

    expect(photoAt, '写真の添付が無い').toBeGreaterThan(-1)
    expect(valueChangeAt, '下書き書き込みを発火させる値変更が無い').toBeGreaterThan(photoAt)
    expect(readAt, '下書きの読み出しが値変更より前にある').toBeGreaterThan(valueChangeAt)
  })
})

/* ========================================================================= *
 * 環境要因のエラーで green にならないこと
 * ========================================================================= *
 *
 * E2E はローカルストレージアダプタで動き、そのアダプタは HTTP で PUT できない URL を返すため、
 * `LicensePhotoUpload` は**どんなファイルでも**「この環境では写真のアップロードを
 * ご利用いただけません。」で失敗する（実装として正しい / 成功したことにしない）。
 *
 * したがって「エラー要素が見えること」だけを見る検査は、
 * **クライアント検証を丸ごと削除しても green のまま**になる。
 */

describe('E2E の写真検証が環境要因のエラーで空振りしない', () => {
  it('メッセージ本文まで検査している', () => {
    const spec = specSource()
    expect(spec, 'サイズ超過のメッセージを検査していない').toContain('CLIENT_ERROR.tooLarge')
    expect(spec, '非画像のメッセージを検査していない').toContain('CLIENT_ERROR.notImage')
  })

  it('検査しているメッセージが実装に存在する', () => {
    const source = read('components/apply/LicensePhotoUpload.tsx')
    for (const message of [
      'ファイルサイズが大きすぎます',
      'JPEG・PNG・WebP の画像を選んでください',
      'この環境では写真のアップロードをご利用いただけません',
    ]) {
      expect(source, `メッセージ '${message}' が実装に無い`).toContain(message)
    }
  })
})

