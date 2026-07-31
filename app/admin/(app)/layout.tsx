import { requireAdmin } from '@/lib/auth-guard'
import { AdminSidebar, AdminMobileNav } from '@/components/admin/AdminSidebar'
import { logout } from './auth-actions'

/**
 * 管理画面 認証済み共通シェル（admin-layout.md）。route group `(app)` のため URL には現れない。
 * ここが描画される時点で Auth.js セッションは有効（middleware ＋ requireAdmin の二重ガード, F-012）。
 * /admin/login は本グループ外に置き、このシェル（サイドバー）を使わない。
 */
export const dynamic = 'force-dynamic'

export default async function AdminAppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireAdmin()
  const adminName = session.user?.name ?? '管理者'

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="hidden w-60 shrink-0 md:block">
        <div className="sticky top-0 h-screen">
          <AdminSidebar />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-l">
          <span className="text-body-sm font-bold text-text-primary md:hidden">管理画面</span>
          <div className="ml-auto flex items-center gap-m">
            <span className="text-body-sm text-text-secondary">{adminName}</span>
            <form action={logout}>
              <button
                type="submit"
                className="rounded border border-border px-3 py-1.5 text-body-sm text-text-primary hover:bg-canvas"
              >
                ログアウト
              </button>
            </form>
          </div>
        </header>

        {/* サイドバーは md 未満で隠れるため、スマホではここが唯一の管理メニューになる。 */}
        <AdminMobileNav />

        <main id="main" className="mx-auto w-full max-w-[1280px] flex-1 px-m py-l md:px-l">
          {children}
        </main>
      </div>
    </div>
  )
}
