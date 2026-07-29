import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { NewsForm } from '@/components/admin/NewsForm'
import { requireAdmin } from '@/lib/auth-guard'
import { getNewsById } from '@/lib/news-admin'

export const metadata: Metadata = {
  title: 'お知らせ編集',
  robots: { index: false, follow: false },
}

/** Date → datetime-local 文字列 "YYYY-MM-DDTHH:mm"（サーバーローカル基準。new Date(str) と往復整合）。 */
function toDatetimeLocal(date: Date | null): string {
  if (!date) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`
}

/** お知らせ編集（F-014, news-cms.md §2）。未存在は 404。 */
export default async function AdminNewsEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ error?: string }>
}) {
  await requireAdmin()
  const { id } = await params
  const { error } = await searchParams
  const record = await getNewsById(id)
  if (!record) notFound()

  return (
    <div className="flex flex-col gap-l">
      <Breadcrumb
        items={[
          { label: 'ダッシュボード', href: '/admin' },
          { label: 'お知らせ', href: '/admin/news' },
          { label: '編集' },
        ]}
      />
      <SectionHeading title="お知らせ編集" align="left" />
      <NewsForm
        newsId={id}
        showError={Boolean(error)}
        initial={{
          title: record.title,
          body: record.body,
          category: record.category,
          status: record.status,
          publishedAt: toDatetimeLocal(record.publishedAt),
        }}
      />
    </div>
  )
}
