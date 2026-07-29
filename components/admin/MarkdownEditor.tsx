'use client'

import { useRef } from 'react'
import { renderMarkdown } from '@/lib/markdown/renderSafe'

/**
 * Markdownエディタ＋サニタイズ済みプレビュー（news-cms.md §3 / SEC-001）。
 * 入力は Markdown プレーンテキスト（WYSIWYG/生HTMLは不採用）。プレビューは公開サイトと同一の
 * renderMarkdown() を通した結果のみを dangerouslySetInnerHTML で描画する（唯一の描画点）。
 * textarea には name="body" を付与し、フォーム送信時に本文が formData に含まれるようにする。
 */
interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  maxLength?: number
}

const TOOLBAR: { label: string; ariaLabel: string; wrap: [string, string] }[] = [
  { label: 'B', ariaLabel: '太字にする', wrap: ['**', '**'] },
  { label: 'I', ariaLabel: '斜体にする', wrap: ['*', '*'] },
  { label: '見出し', ariaLabel: '見出しを挿入', wrap: ['\n## ', ''] },
  { label: 'リスト', ariaLabel: '箇条書きを挿入', wrap: ['\n- ', ''] },
  { label: 'リンク', ariaLabel: 'リンクを挿入', wrap: ['[', '](https://)'] },
]

export function MarkdownEditor({ value, onChange, maxLength = 20000 }: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const insert = (before: string, after: string) => {
    const el = ref.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end)
    onChange(next)
    // 挿入後にキャレットを選択テキストの直後へ
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + before.length + (end - start)
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="flex flex-col gap-s">
      <div className="flex flex-wrap gap-1">
        {TOOLBAR.map((t) => (
          <button
            key={t.ariaLabel}
            type="button"
            aria-label={t.ariaLabel}
            onClick={() => insert(t.wrap[0], t.wrap[1])}
            className="rounded border border-border px-2 py-1 text-caption font-bold text-text-secondary hover:bg-canvas"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid gap-m md:grid-cols-2">
        <textarea
          ref={ref}
          name="body"
          data-testid="admin-news-body-editor"
          value={value}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          rows={16}
          className="w-full rounded border border-border-strong p-3 font-mono text-body-sm focus:border-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-700/30"
          placeholder="Markdownで入力（## 見出し / **太字** / - 箇条書き / [リンク](https://…)）"
        />
        <div className="rounded border border-border bg-surface p-3">
          <p className="mb-2 text-caption text-text-disabled">プレビュー</p>
          <div
            data-testid="admin-news-body-preview"
            className="prose-admin text-body-sm text-text-primary [&_a]:text-primary-700 [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_h2]:mt-3 [&_h2]:text-h3 [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:font-bold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-2"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
          />
        </div>
      </div>
    </div>
  )
}
