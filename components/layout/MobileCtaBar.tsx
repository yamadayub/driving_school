/**
 * MobileCtaBar（layout.md §4）。≤767px 固定表示。資料請求 + LINE相談。
 * フォーム/管理画面/コース・スクール詳細では非表示（ページ固有CTAと重複回避）。
 */
'use client'

import { usePathname } from 'next/navigation'
import { CTAButton } from '@/components/ui/CTAButton'

/** 非表示にするルート（前方一致 / 詳細2ルート）。 */
function isHidden(pathname: string): boolean {
  if (pathname.startsWith('/apply') || pathname.startsWith('/admin')) return true
  if (/^\/courses\/[^/]+$/.test(pathname)) return true
  if (/^\/programs\/[^/]+$/.test(pathname)) return true
  return false
}

export function MobileCtaBar() {
  const pathname = usePathname() ?? '/'
  if (isHidden(pathname)) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex gap-s border-t border-border bg-surface p-s shadow-level2 [padding-bottom:env(safe-area-inset-bottom)] md:hidden">
      <CTAButton variant="primary" href="/apply?type=APPLICATION" className="flex-1">
        資料請求
      </CTAButton>
      <CTAButton variant="line" href="https://line.me/" className="flex-1">
        LINEで相談する
      </CTAButton>
    </div>
  )
}
