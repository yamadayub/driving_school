import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { isSameOrigin } from '@/lib/http-guard'

/**
 * 管理系**変更ハンドラ**の共通ラッパ（SEC-011 / SEC-024）。
 *
 * SEC-011 の是正（`isSameOrigin`）は form POST 2本に**手で**適用され、同じ副作用を持つ JSON API
 * 3本（`POST /api/admin/news`, `PUT`・`DELETE /api/admin/news/[id]`）が漏れた。手動適用のままでは
 * P3 でハンドラが増えたときに再び漏れるため、**変更系は必ずガードを通る構造**にする
 * （SEC-024 修正方針3 / P3 着手前の必須前提 B）。
 *
 * 評価順序（全ハンドラで統一）:
 *   1. 認可（未認証 → JSON なら 401 / form 系は /admin/login へ 303）
 *   2. Origin 検証（クロスオリジン・Origin 欠落 → 403。fail-closed）
 *   3. Content-Type 検証（JSON API のみ。不一致 → 415）
 *   4. ハンドラ本体（存在確認 → 入力検証 → 副作用）
 *
 * 参照系（`GET`）には適用しない。副作用が無いため Origin 検証は過剰で、管理一覧の取得を壊す。
 *
 * なぜ `lib/http-guard.ts` ではなくここに置くか: このラッパは `@/auth` に依存し、`auth.ts` は
 * Prisma と `getServerEnv()` のトップレベル副作用を伴う。`lib/http-guard.ts` は
 * `resolveClientIp` / `isSameOrigin` という**純粋な判定**を単体テストから読めることが要件なので
 * （`tests/unit/client-ip.test.ts` / `tests/unit/http-guard.test.ts`）、認証依存はこちらに分ける。
 */

/** Content-Type の要求。`'json'` は `application/json` 系のみ許可する。 */
export type RequiredContentType = 'json'

export interface AdminMutationOptions {
  /**
   * 未認証時の応答。既定は 401 JSON（API 契約）。
   * ネイティブ form POST のハンドラは `/admin/login` への 303 を返すためにこれを差し替える。
   */
  onUnauthorized?: (request: Request) => Response
  /**
   * 必須の Content-Type。JSON API に `'json'` を指定すると、`text/plain` 等の
   * **CORS 単純リクエスト**として到達できる形（プリフライト無しの CSRF 経路）を塞ぐ。
   * ボディを持たない `DELETE` では指定しない。
   */
  requireContentType?: RequiredContentType
}

const FORBIDDEN = () => NextResponse.json({ error: 'forbidden' }, { status: 403 })
const UNSUPPORTED_MEDIA_TYPE = () =>
  NextResponse.json({ error: 'unsupported media type' }, { status: 415 })
const UNAUTHORIZED_JSON = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 })

/** 未認証を `/admin/login` へ 303 で返す（ネイティブ form POST 用。既存契約を変えない）。 */
export function redirectToLogin(request: Request): Response {
  return NextResponse.redirect(new URL('/admin/login', request.url), 303)
}

export function withAdminMutation<Ctx = unknown>(
  handler: (request: Request, ctx: Ctx) => Promise<Response>,
  options: AdminMutationOptions = {},
): (request: Request, ctx: Ctx) => Promise<Response> {
  const onUnauthorized = options.onUnauthorized ?? UNAUTHORIZED_JSON

  return async (request, ctx) => {
    // 1) 認可（多層防御, PT2-01）: middleware の matcher は `/api/admin/*` を含まないため、
    //    各ハンドラが自前で session を検証しなければ未認証で副作用が通る。
    const session = await auth()
    if (!session?.user) return onUnauthorized(request)

    // 2) CSRF（SEC-011 / SEC-024）: Cookie の SameSite 既定値への暗黙依存を解消する。
    if (!isSameOrigin(request)) return FORBIDDEN()

    // 3) 単純リクエスト化の封じ（SEC-024 修正方針2）。
    if (options.requireContentType === 'json' && !isJsonContentType(request)) {
      return UNSUPPORTED_MEDIA_TYPE()
    }

    return handler(request, ctx)
  }
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('content-type')
  if (!contentType) return false
  // `application/json; charset=utf-8` や `application/merge-patch+json` を許容する。
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}
