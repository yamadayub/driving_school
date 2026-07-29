import type { NextAuthConfig } from 'next-auth'

/**
 * Auth.js（NextAuth v5）の **Edge 安全なベース設定**（F-012 / tech-stack §4.2-4.3）。
 *
 * middleware（Edge ランタイム）と Node ランタイム（auth.ts）の双方が共有する。ここには
 * Prisma / node:crypto など Edge で動かないモジュールを**一切 import しない**。
 * Credentials Provider（Prisma で AdminUser を照合）は auth.ts 側でのみ追加する。
 *
 * `authorized` コールバックが middleware の認可判定を担う（/admin/** はセッション必須、
 * /admin/login のみ未認証で許可）。E-012-2: 未認証で保護領域→ signIn ページ（/admin/login）へ。
 */
/**
 * SEC-011 修正方針3: セッション Cookie の属性をコード上の意思決定として明示する。
 * `sameSite: 'lax'` はライブラリ既定と同値だが、CSRF 防御の一枚がここに依存している事実を
 * 暗黙依存のままにしない（実効的な防御は各ハンドラの `isSameOrigin` 検証, lib/http-guard.ts）。
 *
 * `secure` / Cookie 名は **Auth.js 本来の判定（配信 URL が https か）を踏襲**する。NODE_ENV だけで
 * 決めると、`next start`（NODE_ENV=production）を http://localhost で動かす E2E / ローカル検証で
 * `__Secure-` 接頭辞の Cookie がブラウザに拒否され、ログインが一切通らなくなる。
 */
const authUrl =
  process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL
const useSecureCookies = authUrl
  ? authUrl.startsWith('https://')
  : process.env.NODE_ENV === 'production'

export const authConfig: NextAuthConfig = {
  // 本番（next start）でも自ホストを信頼する（リバースプロキシ配下のデモ運用前提）。
  // 未設定だと next-auth v5 は本番でホスト検証に失敗し認証が通らない（dev は既定で trust）。
  trustHost: true,
  session: { strategy: 'jwt' },
  pages: { signIn: '/admin/login' },
  cookies: {
    sessionToken: {
      name: `${useSecureCookies ? '__Secure-' : ''}authjs.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
      },
    },
  },
  // providers はここでは空（Edge 安全）。実プロバイダは auth.ts で注入する。
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl
      const isLoginPage = pathname === '/admin/login'
      const isProtected = pathname.startsWith('/admin') && !isLoginPage
      if (isProtected) return Boolean(auth?.user)
      return true
    },
  },
}
