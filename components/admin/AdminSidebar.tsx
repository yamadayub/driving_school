'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * 管理画面サイドバー（admin-layout.md）。ダークな引き締まった帯（公開 Footer と同一トーン）。
 * お知らせ管理のみ有効。料金・コース/FAQ/受信管理は F-015〜017 未実装のため「準備中」（クリック不可）。
 */
const NAV = [
  { href: '/admin', label: 'ダッシュボード', exact: true },
  { href: '/admin/news', label: 'お知らせ', exact: false },
] as const

const DISABLED = ['料金・コース', 'FAQ', '受信管理'] as const

export function AdminSidebar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="管理メニュー"
      className="flex h-full w-full flex-col gap-1 bg-[#111827] px-3 py-l text-canvas"
    >
      <div className="px-2 pb-l">
        <p className="text-caption text-canvas/60">岩滝・網野自動車教習所</p>
        <p className="text-label font-heading">管理画面</p>
      </div>

      {NAV.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`relative rounded px-3 py-2 text-body-sm font-bold transition-colors ${
              active
                ? 'bg-white/[0.08] text-canvas before:absolute before:left-0 before:top-1 before:bottom-1 before:w-1 before:rounded before:bg-primary-500'
                : 'text-canvas/80 hover:bg-white/[0.05]'
            }`}
          >
            {item.label}
          </Link>
        )
      })}

      {DISABLED.map((label) => (
        <span
          key={label}
          aria-disabled="true"
          className="flex cursor-not-allowed items-center justify-between rounded px-3 py-2 text-body-sm text-canvas/50"
        >
          {label}
          <span className="text-caption text-canvas/40">準備中</span>
        </span>
      ))}

      <a
        href="/"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-auto rounded px-3 py-2 text-caption text-canvas/70 hover:text-canvas"
      >
        公開サイトを見る ↗
      </a>
    </nav>
  )
}
