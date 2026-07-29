'use client'

import { useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * お知らせ削除ボタン（news-cms.md §1）。行内の「削除」で ConfirmDialog を開き、
 * 確認は ConfirmDialog 内のネイティブ form POST（/api/admin/news/delete）で行う（サーバー限定・認可済み）。
 */
export function DeleteNewsButton({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded px-2 py-1 text-body-sm font-bold text-danger hover:bg-danger-bg"
      >
        削除
      </button>
      <ConfirmDialog
        isOpen={open}
        title={`「${title}」を削除しますか？`}
        description="この操作は取り消せません。"
        confirmLabel="削除する"
        confirmAction="/api/admin/news/delete"
        hiddenFields={{ id }}
        onCancel={() => setOpen(false)}
      />
    </>
  )
}
