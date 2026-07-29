/**
 * トップ 料金プレビュー（top-page.md §4）。通学/合宿タブ（role=tab）でコースを出し分ける。
 * 校舎・免許種別の絞り込みは行わず、詳細は比較ページに誘導する。
 */
'use client'

import { useState } from 'react'
import { CourseCard, type CourseCardProps } from '@/components/ui/CourseCard'
import { CTAButton } from '@/components/ui/CTAButton'

type FormatTab = 'TSUGAKU' | 'GASSHUKU'

interface PricePreviewProps {
  /** LICENSE コース（両形態を含む）。タブ内で format により絞り込み、最大4件表示する。 */
  courses: (CourseCardProps & { format: FormatTab | null })[]
}

export function PricePreview({ courses }: PricePreviewProps) {
  const [tab, setTab] = useState<FormatTab>('TSUGAKU')
  const visible = courses.filter((c) => c.format === tab).slice(0, 4)

  return (
    <div className="flex flex-col gap-l">
      <div role="tablist" aria-label="受講形態" className="flex gap-s">
        {(['TSUGAKU', 'GASSHUKU'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-[44px] rounded-pill border px-l text-label font-bold transition-colors ${
              tab === t
                ? 'border-primary-700 bg-primary-700 text-white'
                : 'border-border bg-surface text-text-primary hover:bg-canvas'
            }`}
          >
            {t === 'TSUGAKU' ? '通学' : '合宿'}
          </button>
        ))}
      </div>

      <div className="grid gap-m sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c) => (
          <CourseCard key={c.id} {...c} />
        ))}
      </div>

      <div className="text-center">
        <CTAButton variant="tertiary" href={`/courses?format=${tab}`}>
          料金をもっと詳しく比較する →
        </CTAButton>
      </div>
    </div>
  )
}
