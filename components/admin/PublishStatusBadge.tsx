/**
 * 公開ステータスバッジ（F-014, DESIGN §4「公開ステータス」）。
 * variant='publishStatus' の塗りピル。tone に応じて 下書き=Slate / 公開=Success Green / 非公開=Cyan。
 * ラベル・variant・tone は lib/badge.publishStatusBadge（単一の解決関数）から取得する。
 */
import { publishStatusBadge } from '@/lib/badge'
import type { PublishStatusCode } from '@/lib/publish-status'

const TONE_CLASS: Record<'draft' | 'published' | 'unpublished', string> = {
  draft: 'bg-slate-100 text-slate-700',
  published: 'bg-green-100 text-green-800',
  unpublished: 'bg-cyan-100 text-cyan-800',
}

export function PublishStatusBadge({ status }: { status: PublishStatusCode }) {
  const badge = publishStatusBadge(status)
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-caption font-bold ${TONE_CLASS[badge.tone]}`}
    >
      {badge.label}
    </span>
  )
}
