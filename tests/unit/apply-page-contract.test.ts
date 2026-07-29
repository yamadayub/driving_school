import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildContentSecurityPolicy, createCspNonce } from '@/lib/csp'
import { RETENTION_PERIODS } from '@/lib/retention'

/**
 * =========================================================================
 * P3-b — P3b-5（CSP の検証対象切替）/ P3b-6（force-dynamic の歯止め）/
 *         AC-008-1 / AC-008-5 / AC-010-15 / F-023 `/privacy`
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §E P3b-5（:2613）/ P3b-6（:2614）、
 *       `docs/functional-spec.md` AC-008-1（:532）/ AC-008-5（:536）/ AC-010-15（:798）、
 *       `docs/phase-status.md`「P3-b で `/apply` に切替」（:357）、`business-spec.md` §2.3。
 *
 * ## P3b-5 が求めていること
 * > CSP の検証対象を `/apply` へ切り替える際、**`csp.spec.ts` だけを根拠にしない**
 *
 * E2E は「そのとき動いたビルド」しか見ない。ポリシーの**中身**と、
 * **`/apply` が middleware の対象に入っていること**は、E2E とは独立に固定できる。
 * 本ファイルがその独立側であり、E2E（`tests/e2e/playwright/csp.spec.ts`）が実応答側である。
 */

const REPO = process.cwd()
/**
 * ページの置き場所は `app/(public)/…`（P1 の流儀）を既定とするが、
 * ルートグループの有無だけでテストを落とすのは過検出なので両方を許す。
 */
function pageFile(route: string): string | null {
  for (const candidate of [
    resolve(REPO, `app/(public)/${route}/page.tsx`),
    resolve(REPO, `app/${route}/page.tsx`),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
const ROOT_LAYOUT = resolve(REPO, 'app/layout.tsx')
const MIDDLEWARE = resolve(REPO, 'middleware.ts')

/* ========================================================================= *
 * P3b-5 / AC-008-1 / AC-010-15: CSP
 * ========================================================================= */

describe('AC-008-1 / AC-010-15: CSP ポリシーの中身（E2E とは独立に固定する）', () => {
  const policy = buildContentSecurityPolicy(createCspNonce())

  it("script-src に 'unsafe-inline' / 'unsafe-eval' を含まない（本番）", () => {
    // これが green なら排除される退行: Turnstile を動かすために `'unsafe-inline'` を足すこと。
    // Turnstile は外部スクリプトのオリジン許可（`challenges.cloudflare.com`）で足り、
    // inline 許可は不要である。**個人情報入力フォームで inline を許すと、
    // 1つの XSS が入力値の窃取（フォームジャッキング）へ直結する。**
    const scriptSrc = policy.split(';').find((part) => part.trim().startsWith('script-src'))!
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it('Turnstile のオリジンが script-src と frame-src に含まれる（/apply が動く条件）', () => {
    // 可用性側の固定。**CSP と Turnstile の順序を誤ると、フォーム公開と同時に CAPTCHA が壊れる**
    //（`lib/csp.ts` の冒頭コメントが挙げている失敗）。
    expect(policy).toMatch(/script-src[^;]*https:\/\/challenges\.cloudflare\.com/)
    expect(policy).toMatch(/frame-src[^;]*https:\/\/challenges\.cloudflare\.com/)
  })

  it('form-action / frame-ancestors / object-src が締まっている', () => {
    // `form-action 'self'`: XSS で `<form action="https://evil">` を注入されても外部へ POST させない。
    // `frame-ancestors 'none'`: クリックジャッキングで同意チェックを踏ませない。
    expect(policy).toContain("form-action 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
  })

  it("style-src の 'unsafe-inline' は受容済み（過大報告を防ぐための明示）", () => {
    // `lib/csp.ts` の注記どおり、Next.js のクリティカル CSS のため外せない。
    // **「CSP を厳格にした」と丸めて報告しない**ことを、テストとして残す（P2.5 の教訓3）。
    expect(policy).toMatch(/style-src[^;]*'unsafe-inline'/)
  })

  it('nonce はリクエストごとに変わる', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createCspNonce()))
    expect(nonces.size).toBe(50)
  })
})

describe('P3b-5: /apply と /privacy が middleware（CSP 投入）の対象に入っている', () => {
  it('middleware の matcher が /apply と /privacy にマッチする', () => {
    // **`csp.spec.ts` だけを根拠にしないための独立検証。**
    // これが green なら排除される事故: 除外パターンに新しい語を足したときに
    // `/apply` が巻き込まれ、**個人情報入力フォームだけ CSP 無しで公開される**こと
    //（AC-008-1 は「CSP 未投入で /apply を公開してはならない」と定めている）。
    const source = readFileSync(MIDDLEWARE, 'utf8')
    const matcher = source.match(/matcher:\s*\[\s*'([^']+)'/)?.[1]
    expect(matcher, 'middleware.ts の matcher を読み取れない').toBeTruthy()

    const pattern = new RegExp(`^${matcher}$`)
    for (const path of ['/apply', '/privacy', '/']) {
      expect(pattern.test(path), `${path} が matcher にマッチしない`).toBe(true)
    }
    for (const path of ['/api/applications', '/_next/static/chunk.js']) {
      expect(pattern.test(path), `${path} は matcher の対象外であるべき`).toBe(false)
    }
  })
})

/* ========================================================================= *
 * P3b-6: force-dynamic の構造的な歯止め
 * ========================================================================= */

describe('P3b-6: app/layout.tsx の force-dynamic に歯止めを置く', () => {
  it("ルートレイアウトが export const dynamic = 'force-dynamic' を持つ", () => {
    // これが green なら排除される事故（`app/layout.tsx:29-38` が実測を記録している）:
    // 静的プリレンダリングされたページは**ビルド時の HTML を配るため nonce を持てず**、
    // inline script が CSP で全て弾かれて `self.__next_f` が未定義になり、
    // **ページが真っ白になる**。しかも**ビルドも型検査も通る**ため、誰も気付かない。
    // 監査は I-9 として「構造的な歯止め」を要求した。文字列検査はその最小形である。
    const source = readFileSync(ROOT_LAYOUT, 'utf8')
    expect(source).toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/)
  })

  it("app/ 配下のどこにも force-static / revalidate による静的化が無い", () => {
    // ルートレイアウトの `force-dynamic` は**子ルートの `force-static` で上書きされる**。
    // これが green なら排除される事故: 個別ページで静的化を指定し、そのページだけ
    // CSP nonce を失って無言で壊れること。
    const violations: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(full, 'utf8')
          if (/export\s+const\s+dynamic\s*=\s*['"]force-static['"]/.test(source)) {
            violations.push(`${full}: force-static`)
          }
        }
      }
    }
    walk(resolve(REPO, 'app'))
    expect(violations, violations.join('\n')).toEqual([])
  })
})

/* ========================================================================= *
 * F-023 /privacy と AC-008-5
 * ========================================================================= */

describe('AC-008-5 / F-023: /privacy が存在し保持期間を持つ', () => {
  it('privacy ページが存在する', () => {
    expect(pageFile('privacy'), '/privacy が未作成（P3-b の成果物 / AC-008-5）').not.toBeNull()
  })

  it('保持期間が定数として1箇所に定義されている（business-spec §2.3 の値）', () => {
    // これが green なら排除される事故: 保持期間が `/privacy` の JSX に**文字列として直書き**され、
    // P3-c / P3-d の削除バッチ（AC-PII-5）が別の値を持つこと。
    // **利用者に約束した期間と、実装が実際に削除する期間が食い違う**のは APPI 上の不履行になる。
    expect(RETENTION_PERIODS.applicationYears).toBe(3)
    expect(RETENTION_PERIODS.inquiryYears).toBe(1)
    expect(RETENTION_PERIODS.photoDaysAfterDone).toBe(30)
    expect(RETENTION_PERIODS.photoMaxDaysFromReceipt).toBe(180)
    expect(RETENTION_PERIODS.orphanUploadHours).toBe(24)
    expect(RETENTION_PERIODS.deletionRequestDays).toBe(14)
  })

  it('/privacy は保持期間の定数を import して描画する（直書きしない）', () => {
    const file = pageFile('privacy')
    expect(file).not.toBeNull()
    const source = readFileSync(file!, 'utf8')
    expect(source).toMatch(/from\s+['"](@\/lib\/retention|\.\.?\/[^'"]*retention)['"]/)
  })
})

describe('AC-008-4 / AC-008-5: /apply ページの成果物', () => {
  it('apply ページが存在する', () => {
    expect(pageFile('apply'), '/apply が未作成（P3-b の成果物）').not.toBeNull()
  })

  it('/apply は同意ラベルから /privacy へリンクする', () => {
    // AC-008-5。**リンクが無いと同意が「何に対する同意か」を示せない**（APPI の説明義務）。
    const file = pageFile('apply')
    expect(file).not.toBeNull()
    expect(readFileSync(file!, 'utf8')).toContain('/privacy')
  })

  it('/apply のセッション判定が更新窓（isFormSessionRenewable）を通る（NEW-003 / CR-001）', () => {
    // これが green なら排除される事故: `hasSession` を
    // `verifyFormSessionValue(...) !== null` だけで決めること。
    // `/api/form-session` の**唯一の呼び出し元**はこのページの `if (!hasSession && !issued)` であり、
    // 更新窓を見ないと「**有効だが失効間近**」の利用者はリダイレクトされない
    // ⇒ ルート側の `isFormSessionRenewable` にその状態の要求が**一度も届かない**
    // ⇒ `FORM_SESSION_RENEW_BEFORE_MS` は本番で一度も true にならない**不活性なコード**になる。
    //
    // P3-c1 の実装直後が実際にその状態だった（CR-001）。結合テスト
    // `form-session-route.int.ts` はルートへ直接 Cookie を渡すので green のままであり、
    // **呼び出し元が要求を作らないことは、ルート側のテストでは捕捉できない**
    //（NEW-001「受け口が呼ばれることを測っていない」の一段手前の版）。
    //
    // 更新窓が効かないと、入力途中の利用者が予告なく 30 分で Tier B に落ちる。
    // P3-c2（写真アップロード）は滞在時間が長く Cookie 寿命との競合が起きやすいと
    // 再監査 §5 が名指ししている領域なので、**存在しない防御を前提に設計されること**を防ぐ。
    const file = pageFile('apply')
    expect(file).not.toBeNull()
    const source = readFileSync(file!, 'utf8')

    expect(source, '正典関数を import していない').toMatch(
      /import\s*\{[^}]*isFormSessionRenewable[^}]*\}\s*from\s*['"]@\/lib\/form-session['"]/s,
    )
    // `hasSession` に**代入される式そのもの**が更新窓を通ること。
    //
    // ⚠️ import の存在だけを見る検査にしないこと。`isFormSessionRenewable` を import したまま
    // `hasSession` の式からは外す、という形が素通りする（実測で確認した空振り）。
    // 同じ理由で「次の `const` まで」のような広い窓も使わない——間に別の行が入るだけで
    // 検査が当たってしまう。**代入式だけ**を切り出す（継続行はインデント 4 以上）。
    const hasSessionExpression = source.match(/const\s+hasSession\s*=((?:[^\n]|\n\s{4,})*)/)
    expect(hasSessionExpression, 'hasSession の宣言が見つからない（実装の形が変わった）').not.toBeNull()
    expect(
      hasSessionExpression![1],
      'hasSession の式が isFormSessionRenewable を通っていない（更新窓が不活性になる）',
    ).toContain('isFormSessionRenewable')
  })
})
