/**
 * コース・料金 横断比較（F-002）。Server Component で LICENSE コースを取得し、
 * クライアントのフィルタUI（CourseComparison）に渡す。初期状態は searchParams から解決する。
 */
import type { Metadata } from 'next'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { CourseComparison } from '@/components/courses/CourseComparison'
import { getLicenseCourses } from '@/lib/queries'

export const metadata: Metadata = {
  title: 'コース・料金を比較する',
  description: '普通車からプロ免許まで、校舎×受講形態×免許種別でコース・料金を横断比較できます。',
}

type SearchParams = Promise<{ format?: string; license?: string; school?: string }>

/** ?school の許可リスト検証（course-comparison.md §URL同期）。不正値は 'ALL' にフォールバック。 */
const SCHOOL_VALUES = ['ALL', 'IWATAKI', 'AMINO'] as const
function parseSchool(raw: string | undefined): (typeof SCHOOL_VALUES)[number] {
  return SCHOOL_VALUES.includes(raw as never) ? (raw as (typeof SCHOOL_VALUES)[number]) : 'ALL'
}

export default async function CoursesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  const courses = await getLicenseCourses()

  // 初期受講形態は course-comparison.md 準拠で「通学」。?format= があれば尊重。
  const initialFormat = sp.format === 'GASSHUKU' ? 'GASSHUKU' : 'TSUGAKU'
  const initialLicenseGroup =
    sp.license === 'PRO' ? 'PRO' : sp.license === 'ORDINARY' ? 'ORDINARY' : 'ALL'
  // REV-101: ?school も format/license と同様に初期状態へ復元する（URLの対称性）。
  const initialSchool = parseSchool(sp.school)

  return (
    <div className="mx-auto max-w-container px-m py-l md:px-l">
      <Breadcrumb items={[{ label: 'トップ', href: '/' }, { label: 'コース・料金' }]} />
      <div className="mt-m mb-l">
        <SectionHeading title="コース・料金を比較する" />
      </div>
      <CourseComparison
        courses={courses}
        initialFormat={initialFormat}
        initialLicenseGroup={initialLicenseGroup}
        initialSchool={initialSchool}
      />
    </div>
  )
}
