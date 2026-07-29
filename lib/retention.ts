/**
 * 個人情報の保持期間（`business-spec.md` §2.3 / AC-008-5 / AC-PII-5 / F-023）。
 *
 * **`/privacy` の本文も、P3-c / P3-d の削除バッチも、必ずここを参照する。**
 * 保持期間を画面に直書きすると「利用者に約束した期間」と「実装が実際に削除する期間」が
 * 食い違いうる。APPI 上はこの食い違いそのものが不履行になるため、値を1箇所に閉じる。
 */
export const RETENTION_PERIODS = {
  /** 申込（APPLICATION）レコードの保持年数。 */
  applicationYears: 3,
  /** 問い合わせ（INQUIRY）レコードの保持年数。 */
  inquiryYears: 1,
  /** 免許証写真: 対応完了（status=DONE）からの保持日数。 */
  photoDaysAfterDone: 30,
  /** 免許証写真: 受信からの最長保持日数。 */
  photoMaxDaysFromReceipt: 180,
  /** 申込に紐付かなかったアップロード（orphan）の保持時間。 */
  orphanUploadHours: 24,
  /** 開示・訂正・削除請求への対応期限（日）。 */
  deletionRequestDays: 14,
  /**
   * 発信元 IP（レート制限カウンタのキー）の保持分数（SEC-065 / P3c-10）。
   *
   * 実装は IP を**レート制限のカウンタキーとして**保持している——
   * `rateLimitKey('applications:', <IP>)` / `rateLimitKey('apply:fs-issue:', <IP>)` /
   * `auth.ts` の `LOGIN_IP_LIMITER`。**ウィンドウの長さだけ**インメモリまたは KV に残り、
   * **生の IP をデータベースには保存しない**（`prisma/schema.prisma` に IP 列は無い）。
   *
   * ⚠️ **IP を材料にする全カウンタの最長窓と一致させること。**
   * 短く書くと「10 分で消します」と約束しながら実際は長く持つ不履行になる。
   * 現在の窓はいずれも 600_000ms（10 分）:
   * `FORM_SESSION_ISSUE_WINDOW_MS` / `RATE_WINDOW_MS` / `LOGIN_IP_LIMITER.windowMs`。
   * `tests/unit/retention-client-ip.test.ts` が実装からこれらを読み取って一致を検査するので、
   * **どれかの窓を伸ばすと赤くなる**（＝ `/privacy` の記載を直す必要があることが分かる）。
   */
  clientIpMinutes: 10,
} as const

export type RetentionPeriods = typeof RETENTION_PERIODS
