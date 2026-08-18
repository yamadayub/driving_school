/**
 * NavDrawer（layout.md §2 モバイル）。右からスライドインする全画面ドロワー。
 * フォーカストラップ・Esc クローズ・背面スクロール抑止を持つ。
 * aria-label はデスクトップの本ナビ（グローバルナビゲーション）と重複させない。
 */
'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { NAV_ITEMS } from '@/lib/nav'
import { SCHOOLS } from '@/lib/school-info'

interface NavDrawerProps {
  isOpen: boolean
  onClose: () => void
  currentPath: string
}

export function NavDrawer({ isOpen, onClose, currentPath }: NavDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // 開いたら閉じるボタンへフォーカス、body スクロール停止、Esc で閉じる。
  useEffect(() => {
    if (!isOpen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeBtnRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        // 簡易フォーカストラップ。
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[60] lg:hidden">
      {/* 背景オーバーレイ */}
      <div
        /* オーバーレイも Text Primary（エスプレッソ）系にする。青みグレーだと黄の面の上で濁る。 */
        className="absolute inset-0 bg-[rgba(43,32,4,0.45)]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="モバイルナビゲーション"
        className="absolute right-0 top-0 flex h-full w-[80%] max-w-sm flex-col gap-xs bg-surface p-l shadow-level3"
      >
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          className="self-end rounded px-m py-s text-body font-bold text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-800"
        >
          ✕ 閉じる
        </button>
        <nav aria-label="モバイルナビゲーション" className="flex flex-col">
          {NAV_ITEMS.map((item) => {
            const current = item.href === currentPath
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={current ? 'page' : undefined}
                className="flex min-h-[48px] items-center border-b border-border text-body text-text-primary aria-[current=page]:font-bold aria-[current=page]:text-primary-600"
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="mt-m flex flex-col gap-s text-body-sm">
          {Object.values(SCHOOLS).map((s) => (
            <a key={s.code} href={`tel:${s.phoneTollFree.replace(/-/g, '')}`} className="text-primary-600">
              📞 {s.name} {s.phoneTollFree}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
