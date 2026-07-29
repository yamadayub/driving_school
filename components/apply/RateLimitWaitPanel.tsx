'use client'

/**
 * Tier C（202 / 順番待ち）・Tier D（429 / 混雑）の待機パネル（`form-submission.md` §4）。
 *
 * ------------------------------------------------------------------------
 * ⚠️ **文面はここに書かない**（RV-P3B-008）
 * ------------------------------------------------------------------------
 * 本部品は `message` を受け取るだけで、待機中の文面を自分で持たない。
 * P3-b の差し戻しは「自動再送が無いのに『お待ちいただくと自動的に送信されます』と
 * 表示していた」ことだった——**文面と挙動の一致は、両方が同じファイルから読めないと守れない。**
 * 文面は自動再送を実装している `ApplicationForm.tsx` 側に置き、
 * `tests/unit/application-form-client-wiring.test.ts` がその一致を走査で固定している。
 * ここへ文面を移すと、その走査が**素通りする**（＝ 嘘の表示が再び入りうる）。
 *
 * 待ち時間そのものも表示しない。**`retryAfterMs` を決めるのはサーバー**であり（契約ルール4）、
 * クライアントが秒数を描くと「表示した秒数」と「実際の再送時刻」を一致させる責務が増える。
 */
export function RateLimitWaitPanel({
  message,
  onResend,
}: {
  message: React.ReactNode
  /** 自動再送を使い切った場合の手動再送。渡さないときはボタンを出さない。 */
  onResend?: () => void
}) {
  return (
    <div
      role="status"
      data-testid="wait-panel"
      className="mt-4 rounded border border-info bg-info-bg p-4"
    >
      <p>{message}</p>
      {onResend && (
        <button
          type="button"
          data-testid="apply-resend"
          onClick={onResend}
          className="mt-3 rounded border border-border px-4 py-2"
        >
          もう一度送信する
        </button>
      )}
    </div>
  )
}
