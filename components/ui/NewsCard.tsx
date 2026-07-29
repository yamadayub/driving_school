/**
 * NewsCard（layout.md §7.3）。カテゴリに応じて school/category バッジを出し分ける（lib/badge）。
 * 日付は formatNewsDate（"2026.07.19"）で整形する。
 */
import Link from 'next/link'
import { Badge } from './Badge'
import { newsCategoryBadge, type NewsCategoryCode } from '@/lib/badge'
import { formatNewsDate } from '@/lib/format'

interface NewsCardProps {
  id: string
  title: string
  category: NewsCategoryCode
  publishedAt: string | Date
  href: string
}

export function NewsCard({ title, category, publishedAt, href }: NewsCardProps) {
  const badge = newsCategoryBadge(category)
  return (
    <article
      data-testid="news-card"
      className="flex flex-col gap-s rounded-card border border-border bg-surface p-l shadow-level1 transition-all hover:-translate-y-0.5 hover:shadow-level2 motion-reduce:transform-none motion-reduce:transition-none"
    >
      <div className="flex items-center gap-s">
        <time className="tabular-nums text-caption text-text-secondary">
          {formatNewsDate(publishedAt)}
        </time>
        <Badge variant={badge.variant} value={badge.value} />
      </div>
      <h3 className="text-body font-bold text-text-primary">
        <Link href={href} className="hover:underline">
          {title}
        </Link>
      </h3>
    </article>
  )
}
