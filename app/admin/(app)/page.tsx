import Link from 'next/link'
import type { Metadata } from 'next'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { requireAdmin } from '@/lib/auth-guard'
import { prisma } from '@/lib/db'

export const metadata: Metadata = {
  title: 'ダッシュボード',
  robots: { index: false, follow: false },
}

/**
 * 管理ダッシュボード（F-013, dashboard.md）。
 * 実機能はお知らせ管理のみ。料金・コース/FAQ/受信管理は枠のみ（準備中）。
 * 統計取得に失敗してもダッシュボード自体は表示を継続する（部分劣化）。
 */
async function loadStats() {
  try {
    const [newApplications, newsTotal, newsPublished, newsDraft] = await Promise.all([
      prisma.application.count({ where: { status: 'NEW' } }),
      prisma.news.count(),
      prisma.news.count({ where: { status: 'PUBLISHED' } }),
      prisma.news.count({ where: { status: 'DRAFT' } }),
    ])
    return { newApplications, newsTotal, newsPublished, newsDraft }
  } catch {
    return { newApplications: null, newsTotal: null, newsPublished: null, newsDraft: null }
  }
}

const DISABLED_CARDS = [
  { title: '料金・コース管理', description: 'コース・料金の編集' },
  { title: 'FAQ管理', description: 'よくある質問の編集' },
  { title: '受信管理', description: '申込・問い合わせの確認' },
] as const

export default async function AdminDashboardPage() {
  await requireAdmin()
  const stats = await loadStats()
  const newsSummary =
    stats.newsTotal === null
      ? undefined
      : `全${stats.newsTotal}件（公開${stats.newsPublished}・下書き${stats.newsDraft}）`

  return (
    <div className="flex flex-col gap-l">
      <SectionHeading title="ダッシュボード" align="left" />

      <div
        data-testid="admin-stat-new-count"
        aria-live="polite"
        className="rounded-card border border-border bg-surface p-l shadow-level1"
      >
        <p className="text-body-sm text-text-secondary">新規の問い合わせ</p>
        <p
          className={`mt-xs text-h1 font-heading tabular-nums ${
            stats.newApplications && stats.newApplications > 0
              ? 'text-danger'
              : 'text-text-primary'
          }`}
        >
          {stats.newApplications === null ? '—' : `${stats.newApplications}件`}
        </p>
        <p className="mt-xs text-caption text-text-disabled">準備中（受信管理は後続で有効化）</p>
      </div>

      <div className="grid gap-m sm:grid-cols-2 xl:grid-cols-4">
        {/* お知らせ管理（唯一の有効カード） */}
        <div
          data-testid="admin-card-news"
          className="flex flex-col gap-s rounded-card border border-border bg-surface p-l shadow-level1 transition-all hover:-translate-y-0.5 hover:shadow-level2 motion-reduce:transform-none"
        >
          <h2 className="text-h3 font-heading text-text-primary">お知らせ管理</h2>
          <p className="text-body-sm text-text-secondary">お知らせの作成・編集・公開</p>
          {newsSummary && <p className="text-caption text-text-disabled">{newsSummary}</p>}
          <Link
            href="/admin/news"
            className="mt-auto text-label font-bold text-primary-700 hover:underline"
          >
            お知らせ管理を開く →
          </Link>
        </div>

        {DISABLED_CARDS.map((card) => (
          <div
            key={card.title}
            role="button"
            aria-disabled="true"
            className="flex cursor-not-allowed flex-col gap-s rounded-card border border-border bg-surface p-l opacity-60"
          >
            <h2 className="text-h3 font-heading text-text-primary">{card.title}</h2>
            <p className="text-body-sm text-text-secondary">{card.description}</p>
            <span className="mt-auto text-caption text-text-disabled">準備中</span>
          </div>
        ))}
      </div>
    </div>
  )
}
