'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * 管理画面サイドバー（admin-layout.md）。ダークな引き締まった帯（公開 Footer と同一トーン）。
 * お知らせ管理と Vibe Coding（サイトの見た目を変更）が有効。
 * 料金・コース/FAQ/受信管理は F-015〜017 未実装のため「準備中」（クリック不可）。
 */
const NAV = [
  { href: '/admin', label: 'ダッシュボード', exact: true },
  { href: '/admin/news', label: 'お知らせ', exact: false },
  { href: '/admin/vibe', label: 'サイトの見た目を変更', exact: false },
] as const

const DISABLED = ['料金・コース', 'FAQ', '受信管理'] as const

/**
 * スマートフォン用の横並びナビ（`md` 未満で表示）。
 *
 * サイドバーは `md:block` で、それ未満では**管理メニューが一切表示されない**状態だった。
 * 「サイトの見た目を変更」がスマホから辿れないという指摘で判明したが、
 * 実際にはダッシュボードもお知らせも同様に到達不能だった。
 *
 * **項目は `NAV` を共有する。** 別配列にすると、片方にだけ追加されて
 * 「PC では見えるがスマホでは見えない」が再発する。
 * 準備中の項目（`DISABLED`）は幅を食うだけなのでモバイルには出さない。
 */
export function AdminMobileNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="管理メニュー"
      className="flex gap-2 overflow-x-auto border-b border-border bg-[#111827] px-m py-2 md:hidden"
    >
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`whitespace-nowrap rounded-pill px-3 py-1.5 text-body-sm ${
              active ? 'bg-canvas text-text-primary' : 'text-canvas/80'
            }`}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

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
