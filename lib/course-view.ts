/**
 * Course -> 表示ビューモデル変換（純関数）。F-002/F-003 の CourseCard/DetailHero 表示契約
 * （layout.md §7.2 / course-detail.md）に対応する。
 *
 * TDD スタブ: 本体は未実装。tests/unit/course-view.test.ts が期待する振る舞いを満たすよう
 * Impl Agent が実装する。
 */

/** DESIGN/ layout.md §7.1 のバッジ value。DBの subsidyTags 文字列をこの enum に正規化する。 */
export type SubsidyTag = 'GRANT' | 'SUBSIDY'

export interface CourseLike {
  licenseTypeLabel: string | null // category=LICENSE のみ（例: "普通車"）
  programLabel: string | null // category≠LICENSE のみ（例: "農業用ドローン"）
  transmission: 'AT' | 'MT' | null // ORDINARY のみ
}

/**
 * 見出し表示ロジック（layout.md §7.2）:
 *  - `licenseTypeLabel ?? programLabel` を基底名にする
 *  - `transmission` があれば "(AT)"/"(MT)" を付記
 * 例: {licenseTypeLabel:"普通車", transmission:"AT"} -> "普通車(AT)"
 *     {licenseTypeLabel:null, programLabel:"農業用ドローン"} -> "農業用ドローン"
 */
export function courseDisplayName(course: CourseLike): string {
  const base = course.licenseTypeLabel ?? course.programLabel ?? ''
  return course.transmission ? `${base}(${course.transmission})` : base
}

/** DB の subsidyTags 文字列 -> Badge value のマッピング（未知タグは無視）。 */
const SUBSIDY_TAG_MAP: Record<string, SubsidyTag> = {
  教育訓練給付金: 'GRANT',
  助成金対象: 'SUBSIDY',
}

const SUBSIDY_LABELS: Record<SubsidyTag, string> = {
  GRANT: '給付金',
  SUBSIDY: '助成金',
}

/**
 * DB の subsidyTags（例: "教育訓練給付金" / "助成金対象"）を Badge value に正規化する。
 *  - "教育訓練給付金" -> "GRANT"（給付金）
 *  - "助成金対象"     -> "SUBSIDY"（助成金）
 *  - 未知タグは無視（空配列/除外）
 */
export function toSubsidyTags(dbTags: string[]): SubsidyTag[] {
  return dbTags
    .map((t) => SUBSIDY_TAG_MAP[t])
    .filter((t): t is SubsidyTag => t !== undefined)
}

/** Badge value -> 日本語ラベル（"GRANT"->"給付金" / "SUBSIDY"->"助成金"）。 */
export function subsidyLabel(tag: SubsidyTag): string {
  return SUBSIDY_LABELS[tag]
}
