import type { Metadata } from 'next'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { NewsForm } from '@/components/admin/NewsForm'
import { requireAdmin } from '@/lib/auth-guard'

export const metadata: Metadata = {
  title: 'お知らせ新規作成',
  robots: { index: false, follow: false },
}

/** お知らせ新規作成（F-014, news-cms.md §2）。 */
export default async function AdminNewsNewPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  await requireAdmin()
  const { error } = await searchParams
  return (
    <div className="flex flex-col gap-l">
      <Breadcrumb
        items={[
          { label: 'ダッシュボード', href: '/admin' },
          { label: 'お知らせ', href: '/admin/news' },
          { label: '新規作成' },
        ]}
      />
      <SectionHeading title="お知らせ新規作成" align="left" />
      <NewsForm showError={Boolean(error)} />
    </div>
  )
}
