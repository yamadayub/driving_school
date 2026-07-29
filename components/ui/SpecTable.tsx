/**
 * SpecTable（course-detail.md）。<dl> でマークアップ（dt=ラベル/dd=値）。
 * hidden=true の行は描画しない。料金〜 行は tabular-nums + 強調（Heading3相当）。
 */
import { formatPriceFrom } from '@/lib/format'

interface SpecRow {
  label: string
  value: string
  hidden?: boolean
}

interface SpecTableProps {
  rows: SpecRow[]
  priceFrom: number
}

export function SpecTable({ rows, priceFrom }: SpecTableProps) {
  return (
    <dl className="divide-y divide-border rounded-card border border-border bg-surface">
      {rows
        .filter((r) => !r.hidden)
        .map((r) => (
          <div key={r.label} className="flex items-baseline gap-m px-l py-m">
            <dt className="w-24 shrink-0 text-body-sm text-text-secondary">{r.label}</dt>
            <dd className="text-body text-text-primary">{r.value}</dd>
          </div>
        ))}
      <div className="flex items-baseline gap-m px-l py-m">
        <dt className="w-24 shrink-0 text-body-sm text-text-secondary">料金〜</dt>
        <dd className="tabular-nums text-h3 font-bold text-text-primary">
          {formatPriceFrom(priceFrom)}
        </dd>
      </div>
    </dl>
  )
}
