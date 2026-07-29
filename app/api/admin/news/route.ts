import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { withAdminMutation } from '@/app/api/admin/_guard'
import { parseNewsInput } from '@/lib/validators/news'
import { createNews, listAdminNews } from '@/lib/news-admin'

/**
 * 管理お知らせ API（F-014 API仕様, 認証必須）。
 *
 * 重要（PT2-01 / tech-stack §4.3 多層防御）: middleware の matcher は `/admin/:path*` のみで
 * `/api/admin/*` を**含まない**。したがって各ハンドラが自前で session を検証する。未認証は 401。
 * 管理UI 自体は Server Action を使うが、本 API は handler レベル認可の実効境界を提供する。
 *
 * SEC-024: **変更系は `withAdminMutation` を必ず通す**（認可 → Origin 検証 → Content-Type 検証）。
 * 参照系の `GET` は副作用が無いためラッパの対象外（認可のみ）。
 */

async function ensureAdmin() {
  const session = await auth()
  return Boolean(session?.user)
}

const UNAUTHORIZED = NextResponse.json({ error: 'unauthorized' }, { status: 401 })

/** 管理一覧（DRAFT/UNPUBLISHED 含む）。 */
export async function GET() {
  if (!(await ensureAdmin())) return UNAUTHORIZED
  const rows = await listAdminNews()
  return NextResponse.json({ data: rows })
}

/** 作成。 */
export const POST = withAdminMutation(async (request: Request) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const result = parseNewsInput(normalizePublishedAt(body))
  if (!result.success) {
    return NextResponse.json({ error: 'validation', fields: result.errors }, { status: 422 })
  }
  const created = await createNews(result.data)
  return NextResponse.json({ data: created }, { status: 201 })
}, { requireContentType: 'json' })

/** JSON の publishedAt（ISO文字列 or null）を Date | null に正規化して検証に渡す。 */
function normalizePublishedAt(body: unknown): unknown {
  if (body && typeof body === 'object' && 'publishedAt' in body) {
    const v = (body as Record<string, unknown>).publishedAt
    if (typeof v === 'string' && v.trim() !== '') {
      return { ...(body as Record<string, unknown>), publishedAt: new Date(v) }
    }
    if (v === null || v === undefined || v === '') {
      return { ...(body as Record<string, unknown>), publishedAt: null }
    }
  }
  return body
}
