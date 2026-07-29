/**
 * 表示整形ヘルパ（純関数）。F-002/F-003/F-001 の料金・日数・日付表示に使用する。
 *
 * TDD スタブ: 本体は未実装（`NotImplemented` を throw）。tests/unit/format.test.ts が
 * 期待する振る舞い（¥・カンマ区切り・「〜」サフィックス・最短N日・YYYY.MM.DD）を満たすよう
 * Impl Agent が実装する。表示上の tabular-nums は CSS 側の責務（本ロジック対象外）。
 */

/** 225500 -> "¥225,500"（3桁カンマ区切り・円記号）。 */
export function formatPrice(value: number): string {
  return `¥${Math.round(value).toLocaleString('en-US')}`
}

/** 225500 -> "¥225,500〜"（料金〜表示。全角チルダ「〜」）。 */
export function formatPriceFrom(value: number): string {
  return `${formatPrice(value)}〜`
}

/** 15 -> "最短15日"。 */
export function formatMinDays(days: number): string {
  return `最短${days}日`
}

/**
 * ISO 日付/Date -> "2026.07.19"（NewsCard 表示形式, layout.md §7.3）。
 * 暦日は Asia/Tokyo 基準・月日はゼロ埋め。
 */
export function formatNewsDate(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input)
  // Asia/Tokyo 基準で年月日を取り出す（YYYY-MM-DD 文字列/UTC の双方を安定して整形）。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  // en-CA は "2026-07-19" 形式で返す。区切りをドットに変換する。
  return parts.replace(/-/g, '.')
}
