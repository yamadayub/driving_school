import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { redirectToLogin, withAdminMutation } from '@/app/api/admin/_guard'
import { deleteNews } from '@/lib/news-admin'

/**
 * お知らせ削除エンドポイント（F-014, 認証必須・サーバー限定）。
 * ConfirmDialog 内のネイティブ form POST から呼ぶ（保存と同じ理由でサーバー側コミットを保証）。
 * 認可と Origin 検証は `withAdminMutation` が担う（SEC-011 / SEC-024。多層防御, PT2-01）。
 * 未認証は従来どおり /admin/login へ 303、クロスオリジンは 403。
 */
export const POST = withAdminMutation(
  async (request: Request) => {
    const form = await request.formData()
    const id = typeof form.get('id') === 'string' ? String(form.get('id')) : ''
    if (id) {
      await deleteNews(id)
      revalidatePath('/')
    }
    return NextResponse.redirect(new URL('/admin/news', request.url), 303)
  },
  { onUnauthorized: redirectToLogin },
)
