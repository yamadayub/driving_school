/**
 * SectionHeading（layout.md §7.4）。ページ内セクション見出しの統一コンポーネント。
 * as で見出しレベルを切り替え（トップの各セクションは h2、Hero のみ別途 h1）。
 */
interface SectionHeadingProps {
  eyebrow?: string
  title: string
  description?: string
  align?: 'left' | 'center'
  as?: 'h1' | 'h2' | 'h3'
  id?: string
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = 'left',
  as: Tag = 'h2',
  id,
}: SectionHeadingProps) {
  return (
    <div className={align === 'center' ? 'text-center' : 'text-left'}>
      {eyebrow && (
        <p className="mb-xs text-caption font-bold uppercase tracking-widest text-accent-800">
          {eyebrow}
        </p>
      )}
      <Tag id={id} className="text-h1 font-heading text-text-primary">
        {title}
      </Tag>
      {/*
        見出し直下の短いルール。紫→ピンクのグラデーションでブランドの2色を明示する。
        装飾なので aria-hidden（読み上げ・E2E の対象にしない）。
      */}
      <span
        aria-hidden="true"
        className={`mt-s block h-1 w-12 rounded-pill bg-gradient-to-r from-accent-500 to-primary-500 ${
          align === 'center' ? 'mx-auto' : ''
        }`}
      />
      {description && (
        <p className="mt-s text-body text-text-secondary">{description}</p>
      )}
    </div>
  )
}
