'use client'

import { useEffect, useState } from 'react'

/**
 * ログインフォーム（login.md）。メール+パスワード。
 *
 * 認証は Auth.js（NextAuth v5）の Credentials エンドポイント（/api/auth/callback/credentials）への
 * **ネイティブ form POST**。クライアント fetch 版 signIn（beta）はテスト環境で pending が解けない事象が
 * あるため採用しない。ネイティブ送信は決定的なページ遷移となり、成功時は callbackUrl(/admin) へ、
 * 失敗時は Auth.js が /admin/login?error=... へリダイレクトする（エラーはページ側で SSR 表示, E-012-1）。
 *
 * CSRF: Auth.js は double-submit cookie 方式。マウント時に /api/auth/csrf からトークンを取得し hidden で送る。
 * 取得完了までログインボタンを disabled にする（Playwright の click は活性化を待つため決定的）。
 */
export function LoginForm() {
  const [csrfToken, setCsrfToken] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    // CSRF トークン取得（Auth.js double-submit cookie）。取得までログインボタンは disabled。
    // ルート通知要素との alert 二重化は globals.css（body:has([data-admin-login])）で対処する。
    let active = true
    fetch('/api/auth/csrf', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { csrfToken?: string }) => {
        if (active && d?.csrfToken) setCsrfToken(d.csrfToken)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  return (
    <form method="post" action="/api/auth/callback/credentials" className="flex flex-col gap-m">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="callbackUrl" value="/admin" />

      <div className="flex flex-col gap-xs">
        <label htmlFor="login-email" className="text-label text-text-primary">
          メールアドレス
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          required
          autoComplete="username"
          className="h-12 rounded border border-border-strong px-3 text-body focus:border-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-700/30"
        />
      </div>

      <div className="flex flex-col gap-xs">
        <label htmlFor="login-password" className="text-label text-text-primary">
          パスワード
        </label>
        <div className="relative">
          <input
            id="login-password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            className="h-12 w-full rounded border border-border-strong px-3 pr-12 text-body focus:border-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-700/30"
          />
          <button
            type="button"
            aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-caption text-text-secondary hover:bg-canvas"
          >
            {showPassword ? '隠す' : '表示'}
          </button>
        </div>
      </div>

      <button
        type="submit"
        disabled={!csrfToken}
        className="mt-s h-12 rounded bg-accent text-label font-bold text-white hover:bg-accent-800 disabled:opacity-60"
      >
        ログイン
      </button>
    </form>
  )
}
