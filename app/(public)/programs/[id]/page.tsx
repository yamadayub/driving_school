/**
 * スクール・追加講習 詳細（F-022, course-detail.md バリエーションB）。
 * 非LICENSE のみ。DetailHero（category バッジ）+ SpecTable（受講形態行は非表示）+ 問い合わせCTA。
 */
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { DetailHero } from '@/components/ui/DetailHero'
import { SpecTable } from '@/components/ui/SpecTable'
import { CTAButton } from '@/components/ui/CTAButton'
import { getPublishedCourse } from '@/lib/queries'
import { SCHOOL_LABELS, type ProgramCategoryCode } from '@/lib/labels'
import { formatMinDays } from '@/lib/format'

type Params = Promise<{ id: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  const course = await getPublishedCourse(id)
  if (!course || course.category === 'LICENSE') return { title: 'スクール・追加講習' }
  return { title: course.programLabel ?? 'スクール・追加講習' }
}

export default async function ProgramDetailPage({ params }: { params: Params }) {
  const { id } = await params
  const course = await getPublishedCourse(id)
  if (!course || course.category === 'LICENSE') notFound()

  const title = course.programLabel ?? ''
  const rows = [
    { label: '対応校', value: course.schools.map((s) => SCHOOL_LABELS[s]).join('・') },
    // 受講形態は非LICENSEでは無意味なため非表示（course-detail.md）。
    { label: '受講形態', value: '', hidden: true },
    { label: '最短日数', value: formatMinDays(course.minDays) },
  ]

  return (
    <div className="mx-auto max-w-container px-m py-l md:px-l">
      <Breadcrumb
        items={[
          { label: 'トップ', href: '/' },
          { label: 'スクール', href: '/programs' },
          { label: title },
        ]}
      />

      <div className="mt-m grid gap-l md:grid-cols-2">
        <div className="flex flex-col gap-l">
          <DetailHero
            schools={course.schools}
            format={null}
            category={course.category as ProgramCategoryCode}
            subsidyTags={course.subsidyTags}
            title={title}
          />
          <SpecTable rows={rows} priceFrom={course.priceFrom} />
        </div>

        <div className="flex flex-col gap-l">
          {course.description && (
            <p className="text-body leading-relaxed text-text-primary">{course.description}</p>
          )}
          <div className="sticky bottom-4 flex flex-col gap-s">
            <CTAButton variant="primary" href={course.ctaHref} className="w-full">
              問い合わせる
            </CTAButton>
            <CTAButton
              variant="secondary"
              href={`/apply?courseId=${course.id}&type=APPLICATION`}
              className="w-full"
            >
              このコースで申込む
            </CTAButton>
          </div>
        </div>
      </div>
    </div>
  )
}
