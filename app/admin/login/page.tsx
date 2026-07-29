import Link from 'next/link'
import type { Metadata } from 'next'
import { LoginForm } from '@/components/admin/LoginForm'

export const metadata: Metadata = {
  title: '管理者ログイン',
  robots: { index: false, follow: false },
}

// F-012 ログイン画面（login.md）。admin-layout のサイドバーは使わない専用の最小シェル。
// route group (app) の外に置くため認証ガード対象外（未認証でアクセス可）。
//
// 認証は Auth.js の Credentials 資格情報エンドポイントへの **ネイティブ form POST**（LoginForm）で行う。
// 失敗時は Auth.js が本ページへ `?error=` 付きでリダイレクトするため、汎用エラー（E-012-1）を
// サーバー側で描画する。全ページ遷移のため単一の role="alert" となり、支援技術・E2E とも整合する。
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const hasError = typeof error === 'string' && error.length > 0

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-m py-xxl">
      <div className="w-full max-w-[400px] rounded-card bg-surface p-xl shadow-level2">
        <div className="mb-l text-center">
          <p className="text-caption text-text-secondary">岩滝・網野自動車教習所</p>
          <h1 className="text-h2 font-heading text-text-primary">管理画面</h1>
        </div>

        {hasError && (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-m rounded border border-danger bg-danger-bg px-3 py-2 text-body-sm text-danger"
          >
            メールアドレスまたはパスワードが正しくありません
          </div>
        )}

        <LoginForm />

        <div className="mt-l text-center">
          <Link href="/" className="text-body-sm text-primary-700 hover:underline">
            ← 公開サイトに戻る
          </Link>
        </div>
      </div>
    </div>
  )
}
