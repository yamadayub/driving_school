'use client'

import { useEffect, useRef } from 'react'

/**
 * 確認ダイアログ（news-cms.md §1）。破壊的操作（削除）の直前確認。
 * role="alertdialog" + aria-modal、開いた瞬間キャンセルにフォーカス、Esc でキャンセル。
 * 閉じているときは DOM に描画しない（E2E は開いたときのみ可視を期待）。
 *
 * 確認アクションは **ネイティブ form POST**（confirmAction + hiddenFields）。クライアント遷移で
 * 中断されずサーバーが確実にコミットするため（削除→即一覧遷移の E2E 対策）。
 */
interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  description: string
  confirmLabel: string
  confirmAction: string
  hiddenFields?: Record<string, string>
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel,
  confirmAction,
  hiddenFields,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-m"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
        data-testid="admin-confirm-dialog"
        className="w-full max-w-md rounded-card bg-surface p-l shadow-level3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-h3 font-heading text-text-primary">
          {title}
        </h2>
        <p id="confirm-desc" className="mt-s text-body-sm text-text-secondary">
          {description}
        </p>
        <div className="mt-l flex justify-end gap-m">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-4 py-2 text-body-sm text-text-primary hover:bg-canvas"
          >
            キャンセル
          </button>
          <form method="post" action={confirmAction}>
            {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <button
              type="submit"
              className="rounded bg-danger px-4 py-2 text-body-sm font-bold text-white hover:opacity-90"
            >
              {confirmLabel}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
