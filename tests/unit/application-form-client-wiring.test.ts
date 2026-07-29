import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * =========================================================================
 * P3-b 差し戻し — RV-P3B-001 / RV-P3B-002 / RV-P3B-008 / RV-P3B-009
 * =========================================================================
 *
 * 出典: `docs/review-p3b-code-2026-07-29.md`
 *       RV-P3B-001（:56 Turnstile トークンがクライアントで一度も取得されない）/
 *       RV-P3B-002（:155 `?fs=1` が URL に残り Cookie 期限切れ後に再発行されない）/
 *       RV-P3B-008（:409 自動再送が無いのに「自動的に送信されます」と表示）/
 *       RV-P3B-009（:437 Cookie ブロック利用者が Tier B から回復できない）、
 *       `docs/p3b-fix-plan-2026-07-29.md` Must Fix 1・2 / Should Fix。
 *
 * ## なぜ「ソース走査」なのか（テスト手段の選択理由。妥協ではない）
 * RV-P3B-001 は **単体・結合・E2E・型検査・ビルドのすべてを通過した**。理由は
 * 「クライアントの結線を見ているテストが 1 本も無い」ことである。本来は
 * `ApplicationForm` をマウントして `window.onTurnstileToken('tok')` → 送信 →
 * `fetch` の body を見るのが最良だが、本リポジトリの単体テスト環境は
 * `environment: 'node'` かつ `include: tests/unit/**\/*.test.ts`（`.tsx` は対象外）で、
 * jsdom も `@testing-library/react` も**依存に無い**（`package.json:40-54`）。
 * テストのために本番依存を増やす判断は Test Agent の範囲を超えるため、
 * **本ファイルは「属性値と実体の対応」という機械的に検証可能な部分**を固定し、
 * **実ブラウザでの挙動は `tests/e2e/playwright/apply-form.spec.ts` の P3b-5 群**が担う。
 * 2 層に分けること自体が RV-P3B-005 の要求（`csp.spec.ts` だけを根拠にしない）と同じ形である。
 *
 * ⚠️ Impl / 後続レビュワーへ: jsdom を導入する判断が下りたら、本ファイルの (1)(3) は
 * **マウントして `fetch` の body を見るテストへ置き換えてよい**（そちらのほうが強い）。
 * ただし (2)（属性値とグローバル名の一致）は**タイポが型検査で捕まらない**ため残すこと。
 */

const REPO = process.cwd()
const FORM = resolve(REPO, 'components/apply/ApplicationForm.tsx')
const source = readFileSync(FORM, 'utf8')

/** `data-callback` 系属性に書かれたグローバル関数名を集める。 */
function callbackAttributeNames(): Array<{ attribute: string; name: string }> {
  const found: Array<{ attribute: string; name: string }> = []
  for (const match of source.matchAll(/data-((?:\w+-)?callback)\s*=\s*["']([^"']+)["']/g)) {
    found.push({ attribute: `data-${match[1]}`, name: match[2] })
  }
  return found
}

/**
 * `name` がグローバルへ**代入**されているか。
 * `window.onX = …` / `w.onX = …` / `w['onX'] = …` / `globalThis.onX = …` を許す。
 */
function assignsGlobal(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:window|globalThis|\\bw)\\s*(?:\\.\\s*${escaped}|\\[\\s*['"\`]${escaped}['"\`]\\s*\\])\\s*=[^=]`,
  ).test(source)
}

/* ========================================================================= *
 * RV-P3B-001: Turnstile のトークンが実際にクライアントで取得され、送信に載る
 * ========================================================================= */

describe('RV-P3B-001: Turnstile トークンの結線（本番で全送信が 403 になる欠陥）', () => {
  it('(1) data-callback で指定したグローバル関数が実際に定義されている', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される「壊れた実装」: `data-callback="onTurnstileToken"` と書いてあるのに
    // `window.onTurnstileToken` がどこにも定義されておらず、Turnstile が**呼ぶ相手を持たない**状態。
    // 結果 `captchaToken` は `''` のまま送信され、`lib/turnstile.ts:47` が必ず false を返し、
    // `app/api/applications/route.ts:286-289` が **全送信を Tier B（403）** にする。
    // 本番では `TURNSTILE_SECRET` が fail-fast 必須キー（`lib/env.ts:80-87`）なので逃げ道は無い。
    // ＝ F-008 / F-010 が**本番デプロイ時点で 1 件も受け付けられない**（機能不成立）。
    //
    // **属性値のタイポは `pnpm type-check` では絶対に捕まらない**（ただの文字列である）。
    // だからこの対応関係はテストでしか固定できない。
    const callbacks = callbackAttributeNames()
    expect(callbacks.length, 'Turnstile のコールバック属性が 1 つも無い').toBeGreaterThan(0)

    const missing = callbacks.filter((item) => !assignsGlobal(item.name))
    expect(
      missing,
      `属性値に対応するグローバル定義が無い: ${missing
        .map((item) => `${item.attribute}="${item.name}"`)
        .join(', ')}（Turnstile は呼ぶ相手を持たない）`,
    ).toEqual([])
  })

  it('(2) 期限切れ / エラーのコールバックを持ち、トークンを捨てる', () => {
    // これが green なら排除される事故: Turnstile のトークン寿命は **300 秒**である。
    // 確認画面に 5 分留まった利用者（＝ 入力内容を読み返した利用者）は
    // **期限切れトークンで Tier B に落ち、原因が画面から分からないまま離脱する**。
    // 期限切れを検知して状態を空にすれば、ウィジェットは再チャレンジを表示できる。
    const attributes = callbackAttributeNames().map((item) => item.attribute)
    expect(attributes, 'data-expired-callback が無い（期限切れトークンで送信される）').toContain(
      'data-expired-callback',
    )
    expect(attributes, 'data-error-callback が無い（失敗が状態に反映されない）').toContain(
      'data-error-callback',
    )
  })

  it('(3) 送信直前に turnstile.getResponse() のフォールバックを持つ', () => {
    // これが green なら排除される取りこぼし: コールバックの登録がウィジェット描画より後になり、
    // **1 回目の解決を受け取り損ねる**こと（スクリプトは読み込み直後にウィジェットを描画する）。
    // 状態が空でも `turnstile.getResponse()` で実トークンを拾えば送信は成立する。
    expect(
      source,
      'turnstile.getResponse() を一度も呼んでいない（コールバックの取りこぼしを回復できない）',
    ).toMatch(/getResponse\s*\(/)
  })

  it('(4) 送信ボディの captchaToken が state の素の参照ではない（解決を経ている）', () => {
    // これが green なら排除される退行: (3) の `getResponse()` を**別の場所に置いただけ**で、
    // 実際に送るのは相変わらず空の state という状態。
    // `payload` の `captchaToken` は「state ?? getResponse()」の**解決結果**でなければならない。
    expect(
      source.match(/^\s*captchaToken,\s*$/m),
      'payload に `captchaToken,`（state のショートハンド）をそのまま渡している',
    ).toBeNull()
  })

  it('(5) 死んだ受信経路（dispatch されない CustomEvent）を残さない', () => {
    // 現状の `window.addEventListener('turnstile-token', …)` は
    // **`dispatchEvent` する箇所がリポジトリに 1 つも無い**——つまり永遠に発火しない。
    // これが green なら排除される事故: 「受け口があるから結線済み」と読める死んだコードを残し、
    // 次のレビュワー・実装者が**結線を検証済みだと誤認する**こと（RV-P3B-001 が起きた原因そのもの）。
    const listened = [...source.matchAll(/addEventListener\(\s*['"]([\w-]+)['"]/g)].map((m) => m[1])
    const custom = listened.filter((name) => /^turnstile/.test(name))
    for (const name of custom) {
      expect(
        source.includes(`CustomEvent`) && new RegExp(`dispatchEvent\\([^)]*${name}`).test(source),
        `'${name}' を listen しているが dispatch する箇所が同ファイルに無い（死んだ結線）`,
      ).toBe(true)
    }
  })
})

/* ========================================================================= *
 * RV-P3B-002: `?fs=1` を URL に残さない
 * ========================================================================= */

describe('RV-P3B-002: 発行済みマーカーを URL から取り除く', () => {
  it('マウント時に ?fs を history.replaceState で消す', () => {
    // これが green なら排除される不具合（レビュー :169-179 の時系列表）:
    //   10:00 `/apply` を開く → `/apply?fs=1` に Cookie 発行、**URL バーに ?fs=1 が残る**
    //   10:45 そのタブでリロード（またはブックマーク・共有 URL を開く）→ Cookie は期限切れ（Max-Age 1,800秒）
    //         だが `?fs=1` があるので `app/(public)/apply/page.tsx:58` が**再発行しない**
    //   10:50 全項目を入力して送信 → `verifyFormSession` が false → **403 Tier B。回復手段なし**
    //
    // `?fs=1` は「Cookie をブロックしている利用者を無限リダイレクトから救う」ための分岐であって、
    // **Cookie を受け入れる普通の利用者に当ててはならない**。URL から消せば、
    // リロード・ブックマーク・共有のいずれも必ず再発行へ回る。
    expect(source, 'history.replaceState による URL の書き換えが無い').toMatch(/replaceState\s*\(/)
    expect(
      source,
      "検索パラメータ 'fs' を削除していない（マーカーが URL に残り続ける）",
    ).toMatch(/delete\(\s*(['"]fs['"]|FORM_SESSION_ISSUED_PARAM)\s*\)/)
  })

  it('URL の書き換えでページ遷移（router.replace / location.assign）を起こさない', () => {
    // これが green なら排除される事故: マーカー除去を `router.replace()` で行い、
    // **入力途中のクライアント状態を巻き込んで再マウント**させること
    //（`/apply` は `force-dynamic` の Server Component を持つため、遷移はサーバー往復になる）。
    // 目的は「アドレスバーの文字列を変える」ことだけなので `history.replaceState` で足りる。
    const marker = source.slice(Math.max(0, source.indexOf('replaceState') - 400))
    expect(
      /router\.replace\(|location\.(assign|replace|href\s*=)/.test(marker.slice(0, 800)),
      'マーカー除去の周辺でページ遷移 API を使っている',
    ).toBe(false)
  })
})

/* ========================================================================= *
 * RV-P3B-008: 表示と挙動の一致
 * ========================================================================= */

describe('RV-P3B-008: 自動再送が無いなら「自動的に送信されます」と書かない', () => {
  it('文面が自動再送を約束するなら、再送の実装が同ファイルに存在する', () => {
    // これが green なら排除される事故: `form-submission.md` §4.4 の自動再送（最大3回）は**未実装**なのに
    // Tier C / D の待機パネルが「お待ちいただくと自動的に送信されます」と表示している状態。
    // **待っても何も起きない**ため、利用者は待ち続けて離脱する（＝ 受付機会の喪失）。
    // Impl はどちらを選んでもよい:
    //   (a) `retryAfterMs` 経過後に `submit()` を最大3回呼ぶ（`idempotencyKey` 不変なので二重登録しない）
    //   (b) 文面を「しばらく時間をおいて、もう一度送信ボタンを押してください。」へ変え、再送ボタンを出す
    // **(b) を選べば本テストの前件が偽になり green になる**——嘘を消すことが最低条件である。
    const claimsAutoResend = /自動的に送信|自動的に再送/.test(source)
    const hasAutoResend = /(auto-?resend|autoResend|resendAttempt|retryAttempt|retryCount)/i.test(
      source,
    )
    expect(
      claimsAutoResend && !hasAutoResend,
      '「自動的に送信されます」と表示しているが、自動再送の実装が見当たらない（未達を隠す表示）',
    ).toBe(false)
  })
})

/* ========================================================================= *
 * RV-P3B-009: Tier B から出られない利用者に出口を作る
 * ========================================================================= */

describe('RV-P3B-009: Tier B が続く利用者へ代替導線を出す', () => {
  it('Tier B の連続回数を数え、一定回数で電話などの代替導線を表示する', () => {
    // これが green なら排除される状態（I-2 の実害）: Cookie をブロックしている利用者にとって
    // 「確認のため、チェックにご協力ください。」は**操作対象が存在しない案内**である。
    // チェックを何度解いても 403 のままで、**離脱以外の行き先が無い**。
    //
    // 契約ルール3（降格理由を区別させない）は**サーバー応答**の要件であり、
    // クライアントが自分の状態から推測して案内を足すことは禁じていない。
    // サーバー応答を一切変えずに出口だけ作れる。
    expect(
      source,
      'Tier B（challenge）の連続回数を保持していない（1 回目から代替導線を出すと通常の CAPTCHA 体験を壊す）',
    ).toMatch(/challenge[A-Za-z]*[Cc]ount|[Cc]ount[A-Za-z]*[Cc]hallenge|tierB[A-Za-z]*[Cc]ount/)

    const hasContactRoute =
      /@\/lib\/school-info/.test(source) || /0120-46-4163|0120-07-2633/.test(source)
    expect(hasContactRoute, '代替導線（電話番号 / 連絡先）がフォームから参照されていない').toBe(true)
  })
})
