/**
 * 「必ずご回答ください」型の注意喚起ブロック（`application-form.md` §6.2-4 / DESIGN.md §4）。
 *
 * 見出しは `<h3>` で、`aria-labelledby` によりブロック全体に名前が付く
 * ——支援技術の利用者が「ここが注意書きである」ことを、色（左のボーダー）以外の手段で得られる。
 */

export function ImportantNoticeBlock({
  id,
  title,
  tone = 'warning',
  children,
}: {
  id: string
  title: string
  tone?: 'warning' | 'info'
  children: React.ReactNode
}) {
  const palette =
    tone === 'info' ? 'border-info bg-info-bg' : 'border-warning bg-warning-bg'
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={`mt-4 rounded-lg border-l-4 p-4 ${palette}`}
    >
      <h3 id={`${id}-heading`} className="font-bold text-text-primary">
        {title}
      </h3>
      {children}
    </section>
  )
}
