/**
 * スクール・追加講習 一覧（F-022, course-detail.md バリエーションB）。
 * 非LICENSE コースを category 別グルーピングで表示する。カードは category バッジを持つ。
 */
import type { Metadata } from 'next'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { CourseCard } from '@/components/ui/CourseCard'
import { EmptyState } from '@/components/ui/States'
import { getPrograms } from '@/lib/queries'
import { PROGRAM_CATEGORY_LABELS, type ProgramCategoryCode } from '@/lib/labels'

export const metadata: Metadata = {
  title: 'スクール・追加講習',
  description: 'ドローン・建設機械スクール、高齢者講習やペーパードライバー講習などの追加講習のご案内。',
}

// REV-102: DB を参照するためリクエスト毎の動的レンダにし、`next build` をDB非依存にする
// （デモではコンテンツ鮮度も優先。ISR/revalidate はビルド時プリレンダで結局DBを要するため不採用）。
export const dynamic = 'force-dynamic'

const GROUP_ORDER: ProgramCategoryCode[] = ['DRONE', 'KENKI', 'ADDITIONAL']

export default async function ProgramsPage() {
  const programs = await getPrograms()

  return (
    <div className="mx-auto max-w-container px-m py-l md:px-l">
      <Breadcrumb items={[{ label: 'トップ', href: '/' }, { label: 'スクール' }]} />
      <div className="mt-m mb-l">
        <SectionHeading title="スクール・追加講習" />
      </div>

      <div className="flex flex-col gap-xxl">
        {GROUP_ORDER.map((cat) => {
          const items = programs.filter((p) => p.category === cat)
          return (
            <section key={cat}>
              <h2 className="mb-m text-h2 font-heading text-text-primary">
                {PROGRAM_CATEGORY_LABELS[cat]}
              </h2>
              {items.length === 0 ? (
                <EmptyState message="準備中です" />
              ) : (
                <div className="grid gap-m sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((p) => (
                    <CourseCard
                      key={p.id}
                      id={p.id}
                      schools={p.schools}
                      format={null}
                      category={cat}
                      licenseTypeLabel={null}
                      programLabel={p.programLabel}
                      transmission={null}
                      minDays={p.minDays}
                      priceFrom={p.priceFrom}
                      subsidyTags={p.subsidyTags}
                      href={p.href}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
