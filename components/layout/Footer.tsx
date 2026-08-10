/**
 * Footer（layout.md §3）。ダーク背景。サイトマップ + 2校連絡先 + プライバシーポリシー。
 * 校舎連絡先は SchoolInfo 定数から取得（静的）。校名は見出しにしない（ページ見出しと役割を分離）。
 */
import Link from 'next/link'
import { SCHOOLS } from '@/lib/school-info'
import { NAV_ITEMS } from '@/lib/nav'

export function Footer() {
  return (
    /*
      ダーク面は無彩色ではなく **Text Primary（深いプラム）** を使う。
      色は lib/design-tokens.ts の neutral.textPrimary に一本化され、
      補助テキストは白の不透明度で作る（新しい色値を増やさない）。
    */
    <footer className="mt-xxl bg-text-primary text-surface">
      {/* 上端の紫→ピンクのライン。ページの終わりをブランドの2色で締める（装飾）。 */}
      <div aria-hidden="true" className="h-1 bg-gradient-to-r from-accent-500 to-primary-500" />
      <div className="mx-auto grid max-w-container gap-xl px-m py-xxl md:grid-cols-4 md:px-l">
        <div className="md:col-span-1">
          <p className="font-heading text-body font-bold">岩滝・網野自動車教習所</p>
          <p className="mt-s text-body-sm text-white/75">明日からの新しい自分のために</p>
        </div>

        <nav aria-label="サイトマップ" className="md:col-span-1">
          <p className="mb-s text-label">サイトマップ</p>
          <ul className="flex flex-col gap-xs text-body-sm">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="hover:text-primary-500">
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/privacy" className="hover:text-primary-500">
                プライバシーポリシー
              </Link>
            </li>
          </ul>
        </nav>

        {Object.values(SCHOOLS).map((s) => (
          <div key={s.code} className="md:col-span-1">
            <p className="mb-s text-label">{s.name}</p>
            <p className="text-body-sm text-white/75">〒{s.postalCode}</p>
            <p className="text-body-sm text-white/75">{s.address}</p>
            <a
              href={`tel:${s.phoneTollFree.replace(/-/g, '')}`}
              className="mt-xs block text-body-sm hover:text-primary-500"
            >
              {s.phoneTollFree}
            </a>
            <div className="mt-s flex gap-s text-body-sm">
              {s.sns.instagram && (
                <a
                  href={`https://www.instagram.com/${s.sns.instagram}`}
                  aria-label={`${s.name} Instagram`}
                  className="hover:text-primary-500"
                >
                  Instagram
                </a>
              )}
              {s.sns.x && (
                <a
                  href={`https://x.com/${s.sns.x}`}
                  aria-label={`${s.name} X`}
                  className="hover:text-primary-500"
                >
                  X
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-white/15 py-m text-center text-caption text-white/75">
        © 2026 岩滝・網野自動車教習所
      </div>
    </footer>
  )
}
