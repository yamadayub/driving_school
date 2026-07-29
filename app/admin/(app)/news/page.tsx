import Link from 'next/link'
import type { Metadata } from 'next'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { Badge } from '@/components/ui/Badge'
import { PublishStatusBadge } from '@/components/admin/PublishStatusBadge'
import { DeleteNewsButton } from '@/components/admin/DeleteNewsButton'
import { requireAdmin } from '@/lib/auth-guard'
import { listAdminNews } from '@/lib/news-admin'
import { newsCategoryBadge } from '@/lib/badge'
import { formatNewsDate } from '@/lib/format'
import { PUBLISH_STATUSES, PUBLISH_STATUS_LABELS, type PublishStatusCode } from '@/lib/publish-status'

export const metadata: Metadata = {
  title: 'お知らせ管理',
  robots: { index: false, follow: false },
}

const VALID_STATUS = new Set<string>(PUBLISH_STATUSES)

/** お知らせ管理一覧（F-014, news-cms.md §1）。ステータスで絞り込み可（URL クエリ同期）。 */
export default async function AdminNewsListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  await requireAdmin()
  const sp = await searchParams
  const statusFilter =
    sp.status && VALID_STATUS.has(sp.status) ? (sp.status as PublishStatusCode) : undefined

  const rows = await listAdminNews(statusFilter ? { status: statusFilter } : undefined)

  return (
    <div className="flex flex-col gap-l">
      <Breadcrumb
        items={[{ label: 'ダッシュボード', href: '/admin' }, { label: 'お知らせ' }]}
      />

      <div className="flex flex-wrap items-center justify-between gap-m">
        <SectionHeading title="お知らせ管理" align="left" />
        <Link
          href="/admin/news/new"
          className="rounded bg-accent px-l py-2.5 text-label font-bold text-white hover:bg-accent-800"
        >
          新規作成
        </Link>
      </div>

      {/* フィルタ（ステータス。URL クエリ ?status= に同期） */}
      <form method="get" className="flex flex-wrap items-end gap-m">
        <div className="flex flex-col gap-xs">
          <label htmlFor="status-filter" className="text-caption text-text-secondary">
            ステータス
          </label>
          <select
            id="status-filter"
            name="status"
            data-testid="admin-news-status-filter"
            defaultValue={sp.status ?? ''}
            className="h-10 rounded border border-border-strong px-2 text-body-sm"
          >
            <option value="">すべて</option>
            {PUBLISH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PUBLISH_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="h-10 rounded border border-border px-4 text-body-sm text-text-primary hover:bg-canvas"
        >
          絞り込む
        </button>
      </form>

      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table data-testid="admin-news-table" className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-border text-caption text-text-secondary">
              <th scope="col" className="px-3 py-2 font-bold">タイトル</th>
              <th scope="col" className="px-3 py-2 font-bold">カテゴリ</th>
              <th scope="col" className="px-3 py-2 font-bold">公開ステータス</th>
              <th scope="col" className="px-3 py-2 font-bold">公開日</th>
              <th scope="col" className="px-3 py-2 font-bold">更新日</th>
              <th scope="col" className="px-3 py-2 font-bold">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-l text-center text-body-sm text-text-secondary">
                  お知らせがありません
                </td>
              </tr>
            ) : (
              rows.map((n) => {
                const badge = newsCategoryBadge(n.category)
                return (
                  <tr
                    key={n.id}
                    data-testid="admin-news-row"
                    data-news-id={n.id}
                    className="border-b border-border last:border-0 hover:bg-canvas"
                  >
                    <td className="max-w-[22rem] truncate px-3 py-2">
                      <Link
                        href={`/admin/news/${n.id}/edit`}
                        title={n.title}
                        className="font-bold text-primary-700 hover:underline"
                      >
                        {n.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={badge.variant} value={badge.value} />
                    </td>
                    <td className="px-3 py-2">
                      <PublishStatusBadge status={n.status} />
                    </td>
                    <td className="px-3 py-2 tabular-nums text-body-sm text-text-secondary">
                      {n.publishedAt ? formatNewsDate(n.publishedAt) : '—'}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-body-sm text-text-secondary">
                      {formatNewsDate(n.updatedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/admin/news/${n.id}/edit`}
                          className="rounded px-2 py-1 text-body-sm font-bold text-primary-700 hover:bg-primary-50"
                        >
                          編集
                        </Link>
                        <DeleteNewsButton id={n.id} title={n.title} />
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
