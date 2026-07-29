/**
 * CourseCard（layout.md §7.2）。料金プレビュー・比較結果・関連導線で共有する。
 * 見出しは courseDisplayName（licenseTypeLabel ?? programLabel + transmission）で解決する。
 * category バッジ（非LICENSE）／format バッジ（LICENSE）を出し分ける。
 */
import Link from 'next/link'
import { Badge } from './Badge'
import { CTAButton } from './CTAButton'
import { courseDisplayName, type SubsidyTag } from '@/lib/course-view'
import { formatPriceFrom, formatMinDays } from '@/lib/format'
import type { SchoolCode, CourseFormatCode, ProgramCategoryCode } from '@/lib/labels'

export interface CourseCardProps {
  id: string
  schools: SchoolCode[]
  format: CourseFormatCode | null
  /** 非LICENSE カード時に category バッジを表示する。 */
  category?: ProgramCategoryCode | null
  licenseTypeLabel: string | null
  programLabel: string | null
  transmission: 'AT' | 'MT' | null
  minDays: number
  priceFrom: number
  subsidyTags: SubsidyTag[]
  href: string
  /** 「このコースで申込む」→ /apply?courseId=...。省略時は申込CTAを描画しない。 */
  ctaHref?: string
}

export function CourseCard(props: CourseCardProps) {
  const title = courseDisplayName({
    licenseTypeLabel: props.licenseTypeLabel,
    programLabel: props.programLabel,
    transmission: props.transmission,
  })
  const detailLabel = `${title}の詳細を見る`

  return (
    <article
      data-testid="course-card"
      className="flex flex-col gap-m rounded-card border border-border bg-surface p-l shadow-level1 transition-all hover:-translate-y-0.5 hover:shadow-level2 motion-reduce:transform-none motion-reduce:transition-none"
    >
      {/* バッジ順序: 校舎 → 受講形態/カテゴリ → 給付金/助成金（layout.md §7.1）。 */}
      <div className="flex flex-wrap items-center gap-1">
        {props.schools.map((s) => (
          <Badge key={s} variant="school" value={s} />
        ))}
        {props.category ? (
          <Badge variant="category" value={props.category} />
        ) : (
          props.format && <Badge variant="format" value={props.format} />
        )}
        {props.subsidyTags.map((t) => (
          <Badge key={t} variant="subsidy" value={t} />
        ))}
      </div>

      <h3 className="text-h3 font-heading text-text-primary">
        <Link href={props.href} className="hover:underline">
          {title}
        </Link>
      </h3>

      <dl className="flex items-end justify-between gap-s">
        <div>
          <dt className="text-caption text-text-secondary">料金</dt>
          <dd className="tabular-nums text-h2 font-bold text-text-primary">
            {formatPriceFrom(props.priceFrom)}
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-caption text-text-secondary">最短</dt>
          <dd className="tabular-nums text-body font-bold text-text-primary">
            {formatMinDays(props.minDays)}
          </dd>
        </div>
      </dl>

      <div className="mt-auto flex flex-wrap gap-s">
        <CTAButton variant="secondary" size="compact" href={props.href} aria-label={detailLabel}>
          詳細を見る
        </CTAButton>
        {props.ctaHref && (
          <CTAButton variant="primary" size="compact" href={props.ctaHref}>
            このコースで申込む
          </CTAButton>
        )}
      </div>
    </article>
  )
}
