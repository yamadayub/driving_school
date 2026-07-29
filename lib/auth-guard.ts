import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import type { Session } from 'next-auth'

/**
 * 管理領域のサーバー側認可（F-012 多層防御）。
 *
 * middleware（Edge）に依存せず、各 Server Component / Server Action の入口でも session を再検証する。
 * 未認証なら /admin/login へリダイレクトする。認証済みなら Session を返す。
 * 'server-only' は付けない（news-admin.ts と同様、Node 実行のみで到達し、クライアントからは import しない）。
 */
export async function requireAdmin(): Promise<Session> {
  const session = await auth()
  if (!session?.user) {
    redirect('/admin/login')
  }
  return session
}
