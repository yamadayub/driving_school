/**
 * グローバルナビ定義（layout.md §2 / tests/e2e/pages/contract.ts NAV_ITEMS と一致させる）。
 * label は accessible name、href は遷移先。順序も contract に合わせる。
 */
export interface NavItem {
  label: string
  href: string
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'お知らせ', href: '/news' },
  { label: '通学', href: '/courses?format=TSUGAKU' },
  { label: '合宿', href: '/courses?format=GASSHUKU' },
  { label: 'プロ免許', href: '/courses?license=PRO' },
  { label: 'スクール', href: '/programs' },
  { label: '学校案内', href: '/schools' },
  { label: 'FAQ', href: '/faq' },
  { label: 'アクセス', href: '/schools#access' },
]

export const NAV_ARIA_LABEL = 'グローバルナビゲーション'
