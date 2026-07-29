/**
 * コース詳細（F-003）。DetailHero + SpecTable + 申込CTA。
 * 未存在/非公開/非LICENSE は notFound()。申込CTA は courseId を引き継ぐ。
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { DetailHero } from '@/components/ui/DetailHero'
import { SpecTable } from '@/components/ui/SpecTable'
import { CTAButton } from '@/components/ui/CTAButton'
import { getPublishedCourse } from '@/lib/queries'
import { courseDisplayName } from '@/lib/course-view'
import { FORMAT_LABELS, SCHOOL_LABELS } from '@/lib/labels'
import { formatMinDays } from '@/lib/format'

type Params = Promise<{ id: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  const course = await getPublishedCourse(id)
  if (!course || course.category !== 'LICENSE') return { title: 'コース詳細' }
  const title = courseDisplayName({
    licenseTypeLabel: course.licenseTypeLabel,
    programLabel: course.programLabel,
    transmission: course.transmission,
  })
  return { title: `${title}${course.format ? ` ${FORMAT_LABELS[course.format]}` : ''}` }
}

export default async function CourseDetailPage({ params }: { params: Params }) {
  const { id } = await params
  const course = await getPublishedCourse(id)
  if (!course || course.category !== 'LICENSE') notFound()

  const baseName = courseDisplayName({
    licenseTypeLabel: course.licenseTypeLabel,
    programLabel: course.programLabel,
    transmission: course.transmission,
  })
  const formatLabel = course.format ? FORMAT_LABELS[course.format] : ''
  const title = `${baseName}${formatLabel ? ` ${formatLabel}` : ''}`

  const rows = [
    { label: '対応校', value: course.schools.map((s) => SCHOOL_LABELS[s]).join('・') },
    { label: '受講形態', value: formatLabel, hidden: !course.format },
    { label: '最短日数', value: formatMinDays(course.minDays) },
  ]

  return (
    <div className="mx-auto max-w-container px-m py-l md:px-l">
      <Breadcrumb
        items={[
          { label: 'トップ', href: '/' },
          { label: 'コース・料金', href: '/courses' },
          { label: title },
        ]}
      />

      <div className="mt-m grid gap-l md:grid-cols-2">
        <div className="flex flex-col gap-l">
          <DetailHero
            schools={course.schools}
            format={course.format}
            category={null}
            subsidyTags={course.subsidyTags}
            title={title}
          />
          <SpecTable rows={rows} priceFrom={course.priceFrom} />
        </div>

        <div className="flex flex-col gap-l">
          {course.description && (
            <p className="text-body leading-relaxed text-text-primary">{course.description}</p>
          )}
          <div className="sticky bottom-4">
            <CTAButton variant="primary" href={course.ctaHref} className="w-full">
              このコースで申込む
            </CTAButton>
          </div>
        </div>
      </div>
    </div>
  )
}
