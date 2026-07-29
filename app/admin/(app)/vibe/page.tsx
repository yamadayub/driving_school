import { notFound } from 'next/navigation'
import { VibeConsole } from '@/components/admin/VibeConsole'

/**
 * Vibe Coding 画面（開発環境限定）。
 *
 * `app/api/admin/vibe/route.ts` と**同じ本番ガード**を持つ。ページだけ残して API を塞ぐと
 * 「押せるが必ず失敗するボタン」になり、逆に API だけ塞いでページを残すと
 * 本番に存在しない機能の入口が見えてしまう。両方で 404 にして経路ごと消す。
 *
 * 判定を `VERCEL` ではなく `NODE_ENV` で行う理由はルート側のコメントを参照。
 */
export const dynamic = 'force-dynamic'

export default function VibePage() {
  if (process.env.NODE_ENV === 'production') notFound()

  return (
    <div className="mx-auto max-w-container px-m py-l">
      <h1 className="text-h1 text-text-primary">サイトの見た目を変更する</h1>
      <p className="mt-s text-body text-text-secondary">
        変更したい内容を日本語で書くと、サイトの見た目を調整します。
      </p>
      <div className="mt-l">
        <VibeConsole />
      </div>
    </div>
  )
}
