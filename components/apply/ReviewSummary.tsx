'use client'

/**
 * 確認画面の内容一覧（`application-form.md` §6.2-6）。
 *
 * **描画の材料はクライアント状態から作った行だけ**（AC-008-7）。この部品はサーバーへ問い合わせず、
 * 受け取った `rows` 以上のものを知らない——「確認内容をサーバーで整形する」設計にすると、
 * **送信を取りやめた利用者の個人情報がログ・APM・WAF に残る**（保持期間の約束の外側で複製が生まれる）。
 *
 * 免許証写真のサムネイルはここへ**渡さない**（P3-c 以降も同様 / AC-PII-9）。
 */
export function ReviewSummary({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="mt-4 divide-y divide-border rounded border border-border">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-3 gap-2 p-3">
          <dt className="col-span-1 text-caption text-text-secondary">{row.label}</dt>
          <dd className="col-span-2 break-words text-text-primary">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
