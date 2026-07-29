/**
 * コース比較フィルタ（純関数, F-002）。校舎 × 受講形態 × 免許種別で LICENSE コースを絞り込む。
 * course-comparison.md のフィルタ仕様・URL同期（?school=&format=&license=）に 1:1 対応する。
 *
 * TDD スタブ: 本体は未実装。tests/unit/course-filter.test.ts が期待する件数を満たすよう
 * Impl Agent が実装する。本フィルタは category='LICENSE' のみを対象とし、非LICENSEは除外する。
 */

export type SchoolCode = 'IWATAKI' | 'AMINO'
export type CourseFormat = 'TSUGAKU' | 'GASSHUKU'
export type Transmission = 'AT' | 'MT'
export type CourseCategory = 'LICENSE' | 'DRONE' | 'KENKI' | 'ADDITIONAL'
export type LicenseTypeCode =
  | 'ORDINARY'
  | 'SEMI_MEDIUM'
  | 'MEDIUM'
  | 'LARGE'
  | 'ORDINARY_2ND'
  | 'LARGE_2ND'
  | 'TOWING'
  | 'LARGE_SPECIAL'
  | 'MOTORCYCLE'

export interface FilterableCourse {
  category: CourseCategory
  licenseType: LicenseTypeCode | null
  transmission: Transmission | null
  format: CourseFormat | null
  schools: SchoolCode[]
}

export interface CourseFilter {
  /** 'ALL' または未指定は両校対象。 */
  school?: SchoolCode | 'ALL'
  /** 受講形態。未指定は全形態。 */
  format?: CourseFormat
  /** 免許種別（複数可）。未指定/空は全種別。 */
  licenseTypes?: LicenseTypeCode[]
  /** 普通車(ORDINARY)の AT/MT 絞り込み。未指定は区別しない。 */
  transmission?: Transmission
}

/**
 * LICENSE コースをフィルタ条件で絞り込む。非LICENSE(DRONE/KENKI/ADDITIONAL)は常に除外。
 * - school: course.schools に含まれる（'ALL'/未指定は素通し）
 * - format: 一致（未指定は素通し）
 * - licenseTypes: いずれかに一致（未指定/空は素通し）
 * - transmission: 一致（未指定は素通し）
 */
export function filterCourses<T extends FilterableCourse>(
  courses: T[],
  filter: CourseFilter,
): T[] {
  const { school, format, licenseTypes, transmission } = filter
  const byLicenseType = licenseTypes && licenseTypes.length > 0 ? new Set(licenseTypes) : null

  return courses.filter((course) => {
    // 非LICENSE は常に除外。
    if (course.category !== 'LICENSE') return false
    // 校舎: 'ALL'/未指定は素通し。
    if (school && school !== 'ALL' && !course.schools.includes(school)) return false
    // 受講形態: 未指定は素通し。
    if (format && course.format !== format) return false
    // 免許種別: 未指定/空は素通し。
    if (byLicenseType && (course.licenseType === null || !byLicenseType.has(course.licenseType)))
      return false
    // AT/MT: 未指定は区別しない。
    if (transmission && course.transmission !== transmission) return false
    return true
  })
}
