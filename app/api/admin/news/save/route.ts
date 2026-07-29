import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { redirectToLogin, withAdminMutation } from '@/app/api/admin/_guard'
import { parseNewsInput } from '@/lib/validators/news'
import { createNews, updateNews } from '@/lib/news-admin'
import type { PublishStatusCode } from '@/lib/publish-status'

/**
 * お知らせ 作成/更新の保存エンドポイント（F-014, 認証必須・サーバー限定）。
 *
 * 管理フォームは **ネイティブ form POST**（application/x-www-form-urlencoded）でここへ送る。
 * クライアント側 fetch な Server Action と異なり、送信はクリック時に同期的に発火し、以降の
 * クライアント遷移で中断されても**サーバー側でコミットが完了する**（CMS 一巡 E2E の
 * 「保存→即一覧遷移」パターンで作成が消えないための設計判断）。
 *
 * 認可と Origin 検証は `withAdminMutation` が担う（SEC-011 / SEC-024。多層防御, PT2-01）。
 * 未認証は従来どおり /admin/login へ 303、クロスオリジン（Origin 欠落を含む）は 403。
 * status は押下ボタン intent を優先（publish→PUBLISHED / draft→ラジオが UNPUBLISHED なら維持, 他は DRAFT）。
 */
export const POST = withAdminMutation(async (request: Request) => {
  const form = await request.formData()
  const id = typeof form.get('id') === 'string' ? String(form.get('id')) : ''
  const intent = form.get('intent')
  const radio = String(form.get('status') ?? 'DRAFT') as PublishStatusCode
  const status: PublishStatusCode =
    intent === 'publish'
      ? 'PUBLISHED'
      : radio === 'UNPUBLISHED'
        ? 'UNPUBLISHED'
        : 'DRAFT'

  const publishedAtRaw = form.get('publishedAt')
  const publishedAt =
    typeof publishedAtRaw === 'string' && publishedAtRaw.trim() !== ''
      ? new Date(publishedAtRaw)
      : null

  const result = parseNewsInput({
    title: String(form.get('title') ?? ''),
    body: String(form.get('body') ?? ''),
    category: String(form.get('category') ?? ''),
    status,
    publishedAt,
  })

  if (!result.success) {
    const back = id ? `/admin/news/${id}/edit` : '/admin/news/new'
    return NextResponse.redirect(new URL(`${back}?error=1`, request.url), 303)
  }

  if (id) {
    await updateNews(id, result.data)
  } else {
    await createNews(result.data)
  }

  // 公開側（トップの最新3件）を再検証。
  revalidatePath('/')
  return NextResponse.redirect(new URL('/admin/news', request.url), 303)
}, { onUnauthorized: redirectToLogin })
