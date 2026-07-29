/**
 * TestimonialCard（top-page.md §6, DESIGN.md Cards > Testimonial Card）。卒業生の声。
 */
interface TestimonialCardProps {
  name: string
  courseLabel: string
  comment: string
  avatarUrl?: string
}

export function TestimonialCard({ name, courseLabel, comment }: TestimonialCardProps) {
  return (
    <figure className="flex flex-col gap-s rounded-card border border-border bg-surface p-l shadow-level1">
      <blockquote className="text-body text-text-primary">{comment}</blockquote>
      <figcaption className="text-body-sm text-text-secondary">
        <span className="font-bold text-text-primary">{name}</span> ／ {courseLabel}
      </figcaption>
    </figure>
  )
}
