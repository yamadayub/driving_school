import NextAuth from 'next-auth'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { authConfig } from '@/auth.config'
import { buildContentSecurityPolicy, createCspNonce } from '@/lib/csp'

/**
 * middleware は2つの役割を持つ。
 *
 * 1. **CSP の投入**（AC-010-15 / AC-008-1 / SEC-002）。`script-src` を nonce 方式にするため、
 *    **リクエストごと**に nonce を生成する必要がある。Next.js は**リクエストヘッダの
 *    `content-security-policy` から nonce を読み取り、自身が描画する `<script>` に付与する**ので、
 *    `NextResponse.next({ request: { headers } })` で下流へ渡す。
 *
 * 2. **`/admin` 配下の認可**（F-012 E-012-2）。Edge ランタイムで動くため、Prisma を含む `auth.ts` では
 *    なく Edge 安全な `authConfig` のみから NextAuth を生成する。判定は
 *    `authConfig.callbacks.authorized` が担う。
 *
 * **セッション照会を /admin に限定している理由**: matcher を全ページへ広げたのは CSP のためであり、
 * 公開ページで毎回セッションを引く必要は無い。`auth()` を無条件に通すと全ページに
 * セッション照会のコストが乗る。
 *
 * 多層防御: middleware に依存せず、各 Server Action / ページでも session を再検証する（requireAdmin）。
 */
const { auth } = NextAuth(authConfig)

/** NextAuth の middleware は `(request, event) => Promise<Response>` として呼べる（inline 形式）。 */
type AuthMiddleware = (request: NextRequest, event: NextFetchEvent) => Promise<Response>

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<Response> {
  const nonce = createCspNonce()
  const csp = buildContentSecurityPolicy(nonce, {
    // 開発サーバー（React Refresh）だけ eval を許す。`next start` / 本番では常に false。
    allowUnsafeEval: process.env.NODE_ENV !== 'production',
  })

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)

  if (request.nextUrl.pathname.startsWith('/admin')) {
    const authResponse = await (auth as unknown as AuthMiddleware)(request, event)
    // 認可が独自の応答（未認証時の /admin/login へのリダイレクト等）を返したらそれを尊重する。
    // 素通り（`NextResponse.next()` 相当）の場合だけ、nonce 付きのリクエストヘッダを載せ直す
    // ——載せ直さないと管理画面のスクリプトに nonce が付かず、CSP で全て弾かれる。
    if (!authResponse.headers.has('x-middleware-next')) {
      authResponse.headers.set('content-security-policy', csp)
      return authResponse
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    for (const cookie of authResponse.headers.getSetCookie()) {
      response.headers.append('set-cookie', cookie)
    }
    response.headers.set('content-security-policy', csp)
    return response
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', csp)
  return response
}

export const config = {
  /**
   * CSP は全ページに必要なので、**静的アセットと API 以外の全パス**を対象にする。
   * API は JSON 応答で CSP の対象にならず、除外することで無駄な middleware 実行を避ける。
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
}
