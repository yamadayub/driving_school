/**
 * Header / グローバルナビ（layout.md §2）。sticky top。
 * デスクトップ: ロゴ + 8項目ナビ + 資料請求CTA。モバイル: ハンバーガー + ロゴ。
 * デスクトップ本ナビのみ aria-label="グローバルナビゲーション"（ランドマークは1つ）。
 */
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_ITEMS, NAV_ARIA_LABEL } from '@/lib/nav'
import { CTAButton } from '@/components/ui/CTAButton'
import { NavDrawer } from './NavDrawer'

export function Header() {
  const pathname = usePathname() ?? '/'
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    /*
      ヘッダーの地は白ではなく **Primary 50（淡いレモン）**。
      黄テーマではページ地（canvas）自体が淡い黄なので、白いバーのままだと
      スクロール中にヘッダーだけが白く浮いて残る。下端の罫線は border（淡いゴールド）で締める。
    */
    <header className="sticky top-0 z-40 border-b border-border bg-primary-50/95 backdrop-blur">
      <div className="mx-auto flex max-w-container items-center justify-between gap-m px-m py-s md:px-l">
        {/* モバイル: ハンバーガー */}
        <button
          type="button"
          aria-label="メニューを開く"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="rounded p-2 text-h3 text-text-primary lg:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-600"
        >
          ☰
        </button>

        <Link
          href="/"
          aria-label="岩滝・網野自動車教習所 トップページへ"
          className="text-body font-heading font-bold text-primary-600"
        >
          岩滝・網野自動車教習所
        </Link>

        {/* デスクトップ: グローバルナビ */}
        <nav aria-label={NAV_ARIA_LABEL} className="hidden items-center gap-m lg:flex">
          {NAV_ITEMS.map((item) => {
            const current = item.href === pathname
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className="text-label text-text-primary hover:text-primary-600 aria-[current=page]:text-primary-600 aria-[current=page]:underline aria-[current=page]:underline-offset-4"
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="hidden lg:block">
          <CTAButton variant="primary" size="compact" href="/apply?type=APPLICATION">
            資料請求
          </CTAButton>
        </div>
      </div>

      <NavDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentPath={pathname}
      />
    </header>
  )
}
