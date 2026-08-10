/**
 * ChatbotFab（layout.md §5）。右下フローティング起動ボタン。
 * P1 では配置・z-index のみ規定（会話パネル F-011 は P4）。
 */
'use client'

import { useState } from 'react'

export function ChatbotFab() {
  const [open, setOpen] = useState(false)

  return (
    <button
      type="button"
      aria-label="チャットで相談する"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="fixed right-4 bottom-6 z-[55] flex h-14 w-14 items-center justify-center rounded-full bg-primary-600 text-2xl text-white shadow-level4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 md:bottom-6"
      style={{ bottom: 'calc(var(--mobile-cta-bar-height, 0px) + 16px)' }}
    >
      <span aria-hidden="true">💬</span>
    </button>
  )
}
