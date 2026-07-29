/**
 * DetailHero（course-detail.md）。コース/スクール詳細のヒーロー。
 * format バッジ（LICENSE）または category バッジ（非LICENSE）を出し分ける。title は <h1>。
 */
import { Badge } from './Badge'
import type { SubsidyTag } from '@/lib/course-view'
import type { SchoolCode, CourseFormatCode, ProgramCategoryCode } from '@/lib/labels'

interface DetailHeroProps {
  schools: SchoolCode[]
  format: CourseFormatCode | null
  category: ProgramCategoryCode | null
  subsidyTags: SubsidyTag[]
  title: string
}

export function DetailHero({ schools, format, category, subsidyTags, title }: DetailHeroProps) {
  return (
    <div className="flex flex-col gap-m rounded-card bg-primary-50 p-l md:p-xl">
      <div className="flex flex-wrap items-center gap-1">
        {schools.map((s) => (
          <Badge key={s} variant="school" value={s} />
        ))}
        {category ? (
          <Badge variant="category" value={category} />
        ) : (
          format && <Badge variant="format" value={format} />
        )}
        {subsidyTags.map((t) => (
          <Badge key={t} variant="subsidy" value={t} />
        ))}
      </div>
      <h1 className="text-display font-heading text-text-primary">{title}</h1>
    </div>
  )
}
