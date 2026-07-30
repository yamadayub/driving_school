import { VibeConsole } from '@/components/admin/VibeConsole'

/**
 * Vibe Coding 画面。
 *
 * **本番でも動作する。** 以前は `NODE_ENV=production` で 404 にしていたが、
 * 公開URLの管理画面から修正・デプロイしたいという要件を受けて外した。
 * 被害範囲をどう構造的に縛っているかは `app/api/admin/vibe/route.ts` の冒頭を参照。
 */
export const dynamic = 'force-dynamic'

export default function VibePage() {
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
