/**
 * スパム判定のシグナル（AC-RL-6 / §4.5 送信間隔）。
 *
 * ------------------------------------------------------------------------
 * 送信間隔の下限
 * ------------------------------------------------------------------------
 * **判定に使ってよいのはサーバーが持つ2値だけ**である:
 *  - フォームセッション Cookie 内の**署名済み** `issuedAt`（`lib/form-session.ts`）
 *  - サーバーの受信時刻
 *
 * クライアントが送る `formRenderedAt` 相当の値は使わない（AC-RL-6 (a)）。
 * **本関数がリクエストもボディも受け取らないのは意図的**で、クライアント値を渡す経路を
 * 構造的に存在させないためである（受け取れる形にした時点で、いつか誰かが使う）。
 *
 * 下限未満は**拒否ではなく Tier B（403 + challenge）へ降格**する。下書き復元で一気に
 * 確認画面へ飛ぶ経路など、想定外の正当な短時間到達を潰さないため。
 */

/** 送信間隔の下限（ms）。人間が入口→全ステップ→確認画面を3秒で通ることは物理的にない。 */
export const MIN_SUBMISSION_INTERVAL_MS = 3_000

/**
 * 送信間隔の下限を満たすか。
 *
 * `receivedAt - issuedAt >= 3000` を**絶対値で書かない**——時計の巻き戻しや鍵漏えいで
 * `issuedAt` が未来になったとき、負の経過時間が「3秒以上」と誤判定される。
 * 非有限値（`NaN` / `Infinity`）も fail-closed で不成立にする。
 */
export function isSubmissionIntervalSatisfied(input: {
  issuedAt: number
  receivedAt: number
}): boolean {
  const { issuedAt, receivedAt } = input
  if (!Number.isFinite(issuedAt) || !Number.isFinite(receivedAt)) return false
  const elapsed = receivedAt - issuedAt
  if (elapsed < 0) return false
  return elapsed >= MIN_SUBMISSION_INTERVAL_MS
}
