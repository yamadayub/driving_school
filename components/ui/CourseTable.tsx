/**
 * CourseTable（course-comparison.md, Desktop ≥1024px）。正規の <table> マークアップ。
 * 各行は CourseCardProps と同一データ形状を受け取る。横スクロールにフォールバックする。
 */
import { Badge } from './Badge'
import { CTAButton } from './CTAButton'
import { courseDisplayName } from '@/lib/course-view'
import { formatPriceFrom, formatMinDays } from '@/lib/format'
import type { CourseCardProps } from './CourseCard'

interface CourseTableProps {
  courses: CourseCardProps[]
}

export function CourseTable({ courses }: CourseTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-border-strong text-left text-text-secondary">
            <th scope="col" className="px-s py-s">校舎</th>
            <th scope="col" className="px-s py-s">免許種別</th>
            <th scope="col" className="px-s py-s">受講形態</th>
            <th scope="col" className="px-s py-s text-right">最短日数</th>
            <th scope="col" className="px-s py-s text-right">料金〜</th>
            <th scope="col" className="px-s py-s">給付金/助成金</th>
            <th scope="col" className="px-s py-s"></th>
          </tr>
        </thead>
        <tbody>
          {courses.map((c) => (
            <tr
              key={c.id}
              data-testid="course-card"
              className="border-b border-border hover:bg-canvas"
            >
              <td className="px-s py-s">
                <div className="flex flex-wrap gap-1">
                  {c.schools.map((s) => (
                    <Badge key={s} variant="school" value={s} />
                  ))}
                </div>
              </td>
              <td className="px-s py-s font-bold text-text-primary">
                {courseDisplayName({
                  licenseTypeLabel: c.licenseTypeLabel,
                  programLabel: c.programLabel,
                  transmission: c.transmission,
                })}
              </td>
              <td className="px-s py-s">
                {c.format && <Badge variant="format" value={c.format} />}
              </td>
              <td className="px-s py-s text-right tabular-nums">{formatMinDays(c.minDays)}</td>
              <td className="px-s py-s text-right tabular-nums font-bold text-text-primary">
                {formatPriceFrom(c.priceFrom)}
              </td>
              <td className="px-s py-s">
                <div className="flex flex-wrap gap-1">
                  {c.subsidyTags.map((t) => (
                    <Badge key={t} variant="subsidy" value={t} />
                  ))}
                </div>
              </td>
              <td className="px-s py-s">
                <div className="flex gap-s">
                  <CTAButton variant="secondary" size="compact" href={c.href}>
                    詳細
                  </CTAButton>
                  {c.ctaHref && (
                    <CTAButton variant="primary" size="compact" href={c.ctaHref}>
                      申込
                    </CTAButton>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
