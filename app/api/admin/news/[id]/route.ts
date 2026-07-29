import { NextResponse } from 'next/server'
import { withAdminMutation } from '@/app/api/admin/_guard'
import { parseNewsInput } from '@/lib/validators/news'
import { getNewsById, updateNews, deleteNews } from '@/lib/news-admin'

/**
 * 管理お知らせ 個別 API（F-014, 認証必須）。
 * PT2-01: 認可（401）は存在チェック（404）より**先**に行う（未認証に存在有無を漏らさない）。
 * SEC-024: 認可・Origin 検証は `withAdminMutation` に集約する（順序をハンドラ間で統一する）。
 */

type NewsRouteContext = { params: Promise<{ id: string }> }

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

/** 更新（認可 → Origin → Content-Type → 存在確認 → 検証 → 更新）。 */
export const PUT = withAdminMutation<NewsRouteContext>(
  async (request, ctx) => {
    const { id } = await ctx.params

    const existing = await getNewsById(id)
    if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

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
    const updated = await updateNews(id, result.data)
    return NextResponse.json({ data: updated })
  },
  { requireContentType: 'json' },
)

/** 削除（認可 → Origin → 存在確認 → 削除）。ボディを持たないため Content-Type は要求しない。 */
export const DELETE = withAdminMutation<NewsRouteContext>(async (_request, ctx) => {
  const { id } = await ctx.params

  const existing = await getNewsById(id)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await deleteNews(id)
  return NextResponse.json({ ok: true })
})
