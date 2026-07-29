/**
 * 入校可能年齢の判定（AC-008-8 / SPEC-007）。
 *
 * ------------------------------------------------------------------------
 * 定義（SPEC-007 の定義式を真実源とする / 申し送り T-Q1）
 * ------------------------------------------------------------------------
 *   `birthDate + 18年 - 1ヶ月 <= 受信日（JST の暦日）` なら申込可。
 *
 * SPEC-007 は境界値ラベル（「17歳11ヶ月0日は不可」）と定義式・注記（「18歳の誕生日の
 * ちょうど1ヶ月前」）が1日ずれているが、**定義式と注記（2対1）を採る**。
 * 詳細は `docs/review-p3b-tests-2026-07-29.md` §4 T-Q1。
 *
 * ------------------------------------------------------------------------
 * なぜ `birthDate` を文字列で受けるのか
 * ------------------------------------------------------------------------
 * `Date` で受けると「どのタイムゾーンの 0 時か」が呼び出し側に漏れ、**サーバーの TZ 設定で
 * 判定が変わる**（AC-008-8 が禁じている状態）。本モジュールは `YYYY-MM-DD` の暦日だけを
 * 扱う純粋な暦計算として実装し、`Date` は「受信インスタント → JST 暦日」の変換にのみ使う。
 *
 * ------------------------------------------------------------------------
 * fail-closed
 * ------------------------------------------------------------------------
 * 生年月日は攻撃者が完全に制御する入力である。**判定不能を「可」に倒すと年齢下限が消える**ため、
 * パース不能・実在しない日付・未来日はすべて `false` を返す（例外は投げない——例外は Tier 契約の
 * 外側の失敗＝ 500 になり、未認証の第三者がサーバーエラーを起こせる経路になる）。
 */

/** 満年齢の下限（歳）。 */
const MIN_AGE_YEARS = 18

/** 下限に対する前倒し（月）。「18歳の誕生日の1ヶ月前から申込可」。 */
const EARLY_MONTHS = 1

/** JST は UTC+9（日本は夏時間を持たないため固定オフセットでよい）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** `YYYY-MM-DD`（ASCII 数字のみ）。`\d` は ASCII 限定なので全角数字は通らない。 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

interface CalendarDate {
  year: number
  month: number // 1-12
  day: number // 1-31
}

/** その年月の日数（1-12 の month を受ける）。 */
function daysInMonth(year: number, month: number): number {
  // Date.UTC(year, month, 0) は「month（0-based では month-1 の翌月）の 0 日目」＝ 前月末日。
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * `YYYY-MM-DD` を暦日へパースする。形式不正・実在しない日付は `null`。
 *
 * **`new Date(value)` を使わない**。`new Date('2008-02-30')` は環境によって繰り上がり、
 * `new Date('2008-4-5')` はローカル TZ で解釈されるなど、入力の受理範囲が実装依存になる。
 */
function parseCalendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') return null
  const match = ISO_DATE.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function formatCalendarDate({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * 受信インスタントを **JST の暦日**へ落とす。
 *
 * `toISOString().slice(0,10)`（UTC 日付）や `getFullYear()/getMonth()/getDate()`（実行環境の
 * ローカル日付）を使うと、**日本時間の 0:00〜9:00 に申し込んだ利用者だけ判定が1日ぶん厳しくなる**。
 */
function toJstCalendarDate(instant: Date): CalendarDate | null {
  const ms = instant.getTime()
  if (!Number.isFinite(ms)) return null
  const shifted = new Date(ms + JST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * `birthDate + 18年 - 1ヶ月` の暦日（`YYYY-MM-DD`）。形式不正・実在しない日付は空文字。
 *
 * **丸めは1回だけ行う**（申し送り T-Q2）。「+18年してから丸め、さらに -1ヶ月」のように丸めが
 * 2回入ると「丸めの順序」という第2の暗黙仕様が生まれ、閏日生まれの判定が実装ごとに1日ぶれる。
 * したがって `(年+18, 月-1, 日)` を組み立ててから、その月に存在しない日だけを月末へ丸める。
 */
export function ageEligibilityBoundaryDate(birthDate: string): string {
  const birth = parseCalendarDate(birthDate)
  if (!birth) return ''

  // 月は 1-12 で扱う。1月 - 1ヶ月 = 前年12月。
  const totalMonths = (birth.year + MIN_AGE_YEARS) * 12 + (birth.month - 1) - EARLY_MONTHS
  const year = Math.floor(totalMonths / 12)
  const month = (totalMonths % 12) + 1
  const day = Math.min(birth.day, daysInMonth(year, month))

  return formatCalendarDate({ year, month, day })
}

/**
 * 申込可能な年齢に達しているか。**基準日は `receivedAt` を JST の暦日に落とした値**であり、
 * クライアントが送る日付は一切使わない（AC-008-8）。
 */
export function isAgeEligible(input: { birthDate: string; receivedAt: Date }): boolean {
  const birth = parseCalendarDate(input.birthDate)
  if (!birth) return false

  const today = toJstCalendarDate(input.receivedAt)
  if (!today) return false

  const todayKey = formatCalendarDate(today)
  const birthKey = formatCalendarDate(birth)
  // 未来生まれは「判定不能」ではなく明確な不正入力。可に倒さない。
  if (birthKey > todayKey) return false

  const boundary = ageEligibilityBoundaryDate(input.birthDate)
  if (boundary === '') return false

  // `YYYY-MM-DD` はゼロ埋め固定長なので辞書順比較がそのまま暦順比較になる。
  return boundary <= todayKey
}
