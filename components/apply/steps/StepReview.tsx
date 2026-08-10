'use client'

import Link from 'next/link'
import { ReviewSummary } from '@/components/apply/ReviewSummary'

/**
 * 確認・送信ステップ（AC-008-7 / AC-008-5）。
 *
 * ------------------------------------------------------------------------
 * ⚠️ ここに置かないもの（RV-P3B-001 / RV-P3B-008 / RV-P3B-009）
 * ------------------------------------------------------------------------
 * **Turnstile ウィジェットと状態パネル（Tier B / C / D）は `ApplicationForm.tsx` が描いて渡す。**
 * どちらも「表示」と「送信の実装」が一致していることが受け入れ条件になっており、
 * その一致は**両方が同じファイルから読めるときにしか守れない**:
 *
 *  - ウィジェットの `data-callback` 属性値は、`window` へ代入するグローバル名と
 *    一字一句同じでなければならない（属性値はただの文字列で、タイポは型検査で捕まらない）。
 *  - 待機パネルの文面が「自動的に送信されます」と言うなら、自動再送の実装が同じファイルに要る。
 *
 * `tests/unit/application-form-client-wiring.test.ts` はこの一致を
 * **`ApplicationForm.tsx` のソース走査**で固定している。ここへ移すと走査が素通りする。
 */
export function StepReview({
  rows,
  privacyPath,
  consent,
  onConsentChange,
  turnstileSlot,
  statusPanels,
}: {
  rows: Array<{ label: string; value: string }>
  privacyPath: string
  consent: boolean
  onConsentChange: (checked: boolean) => void
  turnstileSlot: React.ReactNode
  statusPanels: React.ReactNode
}) {
  return (
    <section data-testid="apply-step-confirm">
      <h2 className="text-h2 font-heading text-text-primary">ご入力内容の確認</h2>
      {/* AC-008-7: 確認画面は**クライアント状態のみ**から描画する（サーバー往復しない）。 */}
      <ReviewSummary rows={rows} />

      <div id="turnstile-slot" data-testid="turnstile-slot" className="mt-4 min-h-[72px]">
        {turnstileSlot}
      </div>

      <label className="mt-4 flex items-start gap-2">
        <input
          type="checkbox"
          name="privacyConsent"
          checked={consent}
          onChange={(event) => onConsentChange(event.target.checked)}
        />
        <span>
          <Link
            href={privacyPath}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-600 underline"
          >
            プライバシーポリシー
          </Link>
          に同意します
        </span>
      </label>

      {statusPanels}
    </section>
  )
}
