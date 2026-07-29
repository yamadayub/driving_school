'use server'

import { signOut } from '@/auth'

/** ログアウト（admin-layout.md）。セッション破棄後 /admin/login へ。 */
export async function logout() {
  await signOut({ redirectTo: '/admin/login' })
}
