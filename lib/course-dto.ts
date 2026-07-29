/**
 * Prisma Course -> UI ビュー DTO 変換（サーバー限定で呼ぶ）。
 * 表示整形は lib/course-view / lib/format、フィルタは lib/course-filter を単一参照元とする。
 */
import type { Course } from '@prisma/client'
import { toSubsidyTags, type SubsidyTag } from '@/lib/course-view'
import type { LicenseTypeCode } from '@/lib/course-filter'

export type SchoolCode = 'IWATAKI' | 'AMINO'
export type CourseFormatCode = 'TSUGAKU' | 'GASSHUKU'
export type ProgramCategoryCode = 'DRONE' | 'KENKI' | 'ADDITIONAL'

/** CourseCard / CourseTable / DetailHero が共有するプレーンなビュー DTO。 */
export interface CourseView {
  id: string
  category: Course['category']
  licenseType: LicenseTypeCode | null
  schools: SchoolCode[]
  format: CourseFormatCode | null
  licenseTypeLabel: string | null
  programLabel: string | null
  transmission: 'AT' | 'MT' | null
  minDays: number
  priceFrom: number
  subsidyTags: SubsidyTag[]
  description: string | null
  /** 詳細ページ href（LICENSE=/courses/[id], 非LICENSE=/programs/[id]）。 */
  href: string
  /** 申込 CTA href（/apply?courseId=...）。 */
  ctaHref: string
}

/** LICENSE/非LICENSE を問わず Course を CourseView に変換する。 */
export function toCourseView(course: Course): CourseView {
  const isLicense = course.category === 'LICENSE'
  return {
    id: course.id,
    category: course.category,
    licenseType: (course.licenseType as LicenseTypeCode | null) ?? null,
    schools: course.schools as SchoolCode[],
    format: (course.format as CourseFormatCode | null) ?? null,
    licenseTypeLabel: course.licenseTypeLabel,
    programLabel: course.programLabel,
    transmission: (course.transmission as 'AT' | 'MT' | null) ?? null,
    minDays: course.minDays,
    priceFrom: course.priceFrom,
    subsidyTags: toSubsidyTags(course.subsidyTags),
    description: course.description,
    href: isLicense ? `/courses/${course.id}` : `/programs/${course.id}`,
    ctaHref: `/apply?courseId=${course.id}&type=${isLicense ? 'APPLICATION' : 'INQUIRY'}`,
  }
}
