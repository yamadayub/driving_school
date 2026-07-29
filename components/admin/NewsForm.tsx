'use client'

import { useState } from 'react'
import { MarkdownEditor } from './MarkdownEditor'
import { PublishStatusBadge } from './PublishStatusBadge'
import { NEWS_CATEGORY_LABELS, type NewsCategoryCode } from '@/lib/labels'
import { PUBLISH_STATUSES, PUBLISH_STATUS_LABELS, type PublishStatusCode } from '@/lib/publish-status'

/**
 * お知らせ作成・編集フォーム（news-cms.md §2, 1画面完結）。
 *
 * 送信は **ネイティブ form POST**（action=/api/admin/news/save）。クライアント fetch な Server Action と違い
 * 送信がクリック時に同期発火し、直後の一覧遷移で中断されずサーバーがコミットする（CMS E2E 一巡対策）。
 * 「下書き保存」= intent=draft / 「公開する」= intent=publish（サーバーが status を確定, E-014-2）。
 * 入力は preview のため controlled。編集時は hidden の id を送る。
 */
interface NewsFormProps {
  newsId?: string
  showError?: boolean
  initial?: {
    title: string
    body: string
    category: NewsCategoryCode
    status: PublishStatusCode
    publishedAt: string // datetime-local 文字列 or ''
  }
}

const CATEGORY_OPTIONS = Object.entries(NEWS_CATEGORY_LABELS) as [NewsCategoryCode, string][]

/**
 * ラジオ表示ラベル。UNPUBLISHED はフォーム上は「取り下げ」（取り下げる操作＝非公開状態）とする。
 * 理由: 一覧バッジは PUBLISH_STATUS_LABELS の「非公開」を用いるが、フォームのラジオで「非公開」を使うと
 * 「公開」が「非公開」の部分文字列となり、ラベル名で要素を選ぶ操作（アクセシブルネーム部分一致）で
 * 「公開」の選択が「非公開」とも一致して曖昧になる。取り下げ/公開/下書きは相互に部分一致しないため一意に選べる。
 * 可視ラベル＝アクセシブルネームで一致させ、Label in Name（WCAG 2.5.3）も満たす。
 */
const RADIO_LABEL: Record<PublishStatusCode, string> = {
  DRAFT: PUBLISH_STATUS_LABELS.DRAFT, // 下書き
  PUBLISHED: PUBLISH_STATUS_LABELS.PUBLISHED, // 公開
  UNPUBLISHED: '取り下げ',
}

export function NewsForm({ newsId, showError, initial }: NewsFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [category, setCategory] = useState<NewsCategoryCode>(initial?.category ?? 'COMMON')
  const [status, setStatus] = useState<PublishStatusCode>(initial?.status ?? 'DRAFT')
  const [publishedAt, setPublishedAt] = useState(initial?.publishedAt ?? '')
  const [body, setBody] = useState(initial?.body ?? '')

  return (
    <form
      method="post"
      action="/api/admin/news/save"
      data-testid="admin-news-form"
      className="flex flex-col gap-l"
    >
      {newsId && <input type="hidden" name="id" value={newsId} />}

      {showError && (
        <div role="alert" className="rounded border border-danger bg-danger-bg p-3 text-body-sm text-danger">
          入力内容を確認してください（タイトル・本文は必須、公開する場合は公開日時が必要です）。
        </div>
      )}

      {/* タイトル */}
      <div className="flex flex-col gap-xs">
        <label htmlFor="news-title" className="text-label text-text-primary">
          タイトル<span className="ml-1 text-caption text-text-secondary">必須</span>
        </label>
        <input
          id="news-title"
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          className="h-12 rounded border border-border-strong px-3 text-body focus:border-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-700/30"
        />
      </div>

      {/* カテゴリ */}
      <div className="flex flex-col gap-xs">
        <label htmlFor="news-category" className="text-label text-text-primary">
          カテゴリ<span className="ml-1 text-caption text-text-secondary">必須</span>
        </label>
        <select
          id="news-category"
          name="category"
          value={category}
          onChange={(e) => setCategory(e.target.value as NewsCategoryCode)}
          className="h-12 rounded border border-border-strong px-3 text-body focus:border-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-700/30"
        >
          {CATEGORY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* 公開ステータス（radio 3択） */}
      <fieldset className="flex flex-col gap-xs">
        <legend className="text-label text-text-primary">公開ステータス</legend>
        <div className="flex flex-wrap gap-l pt-xs">
          {PUBLISH_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-body-sm">
              <input
                type="radio"
                name="status"
                value={s}
                checked={status === s}
                onChange={() => setStatus(s)}
              />
              {RADIO_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>

      {/* 公開日時 */}
      <div className="flex flex-col gap-xs">
        <label htmlFor="news-publishedAt" className="text-label text-text-primary">
          公開日時<span className="ml-1 text-caption text-text-secondary">公開時必須</span>
        </label>
        <input
          id="news-publishedAt"
          name="publishedAt"
          type="datetime-local"
          value={publishedAt}
          onChange={(e) => setPublishedAt(e.target.value)}
          className="h-12 w-full max-w-xs rounded border border-border-strong px-3 text-body focus:border-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-700/30"
        />
      </div>

      {/* 本文（Markdownエディタ＋プレビュー） */}
      <div className="flex flex-col gap-xs">
        <div className="flex items-center justify-between">
          <span className="text-label text-text-primary">
            本文<span className="ml-1 text-caption text-text-secondary">必須</span>
          </span>
          <PublishStatusBadge status={status} />
        </div>
        <MarkdownEditor value={body} onChange={setBody} />
      </div>

      {/* アクション */}
      <div className="flex flex-wrap justify-end gap-m border-t border-border pt-l">
        <button
          type="submit"
          name="intent"
          value="draft"
          className="rounded border border-primary-700 px-l py-3 text-label font-bold text-primary-700 hover:bg-primary-50"
        >
          下書き保存
        </button>
        <button
          type="submit"
          name="intent"
          value="publish"
          className="rounded bg-accent px-l py-3 text-label font-bold text-white hover:bg-accent-800"
        >
          公開する
        </button>
      </div>
    </form>
  )
}
