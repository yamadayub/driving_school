/**
 * Breadcrumb（layout.md §6）。トップ以外の全ページ上部に表示。
 * 最後の要素（href 省略）は現在ページ扱いで aria-current="page"。
 */
import Link from 'next/link'

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="パンくずリスト" className="overflow-x-auto whitespace-nowrap py-s text-body-sm">
      <ol className="flex items-center gap-s text-text-secondary">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-s">
              {i > 0 && <span aria-hidden="true">＞</span>}
              {item.href && !isLast ? (
                <Link href={item.href} className="hover:text-primary-600">
                  {item.label}
                </Link>
              ) : (
                <span aria-current="page" className="text-text-primary">
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
