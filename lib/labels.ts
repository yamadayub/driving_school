/**
 * Badge/表示の固定日本語ラベル（layout.md §7.1）。value を受け取りラベルを解決する。
 * 色・形状は DESIGN.md / lib/design-tokens.ts、value 正規化は lib/course-view.ts を参照元とする。
 */
import type { SubsidyTag } from '@/lib/course-view'

export type SchoolCode = 'IWATAKI' | 'AMINO'
export type CourseFormatCode = 'TSUGAKU' | 'GASSHUKU'
export type NewsCategoryCode = 'IWATAKI' | 'AMINO' | 'DRONE' | 'KENKI' | 'COMMON'
/** Course.category（DRONE/KENKI/ADDITIONAL）。UI 上の講習カテゴリ表示に使う。 */
export type ProgramCategoryCode = 'DRONE' | 'KENKI' | 'ADDITIONAL'

export const SCHOOL_LABELS: Record<SchoolCode, string> = {
  IWATAKI: '岩滝校',
  AMINO: '網野校',
}

export const FORMAT_LABELS: Record<CourseFormatCode, string> = {
  TSUGAKU: '通学',
  GASSHUKU: '合宿',
}

export const NEWS_CATEGORY_LABELS: Record<NewsCategoryCode, string> = {
  IWATAKI: '岩滝校',
  AMINO: '網野校',
  DRONE: 'ドローン',
  KENKI: '建機',
  COMMON: '共通',
}

/** 講習カテゴリ（非LICENSE）の表示ラベル。 */
export const PROGRAM_CATEGORY_LABELS: Record<ProgramCategoryCode, string> = {
  DRONE: 'ドローン',
  KENKI: '建機',
  ADDITIONAL: '追加講習',
}

export const SUBSIDY_LABELS: Record<SubsidyTag, string> = {
  GRANT: '給付金',
  SUBSIDY: '助成金',
}
