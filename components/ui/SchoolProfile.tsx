/**
 * SchoolProfile（school-access.md）。校名は <h2>。電話は tel: リンク（44px）。
 * 対応免許は識別ではなく一覧のため軽量 Chip（強い色を割り当てない）。
 */
import { Badge } from './Badge'
import { CTAButton } from './CTAButton'
import type { SchoolCode } from '@/lib/labels'

interface SchoolProfileProps {
  code: SchoolCode
  name: string
  postalCode: string
  address: string
  phoneTollFree: string
  phoneDirect: string
  features: string[]
  licenseTypeLabels: string[]
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/-/g, '')}`
}

export function SchoolProfile(props: SchoolProfileProps) {
  return (
    <div className="flex flex-col gap-m rounded-card border border-border bg-surface p-l md:p-xl">
      <div className="flex items-center gap-s">
        <Badge variant="school" value={props.code} />
        <h2 className="text-h2 font-heading text-text-primary">{props.name}</h2>
      </div>

      <p className="text-body text-text-secondary">
        〒{props.postalCode} {props.address}
      </p>

      <div className="flex flex-wrap gap-s">
        <a
          href={telHref(props.phoneTollFree)}
          aria-label={`${props.name}フリーダイヤル ${props.phoneTollFree}`}
          className="inline-flex min-h-[44px] items-center gap-1 rounded border border-border px-m font-bold text-primary-700 hover:bg-primary-50"
        >
          📞 {props.phoneTollFree}（フリーダイヤル）
        </a>
        <a
          href={telHref(props.phoneDirect)}
          aria-label={`${props.name}直通 ${props.phoneDirect}`}
          className="inline-flex min-h-[44px] items-center gap-1 rounded border border-border px-m text-text-secondary hover:bg-canvas"
        >
          📞 {props.phoneDirect}（直通）
        </a>
      </div>

      {props.features.length > 0 && (
        <div>
          <p className="mb-xs text-body-sm font-bold text-text-primary">特徴</p>
          <ul className="flex flex-wrap gap-x-l gap-y-xs text-body-sm text-text-secondary">
            {props.features.map((f) => (
              <li key={f}>・{f}</li>
            ))}
          </ul>
        </div>
      )}

      {props.licenseTypeLabels.length > 0 && (
        <div>
          <p className="mb-xs text-body-sm font-bold text-text-primary">対応免許</p>
          <ul className="flex flex-wrap gap-1">
            {props.licenseTypeLabels.map((l) => (
              <li
                key={l}
                className="rounded-pill border border-border bg-surface px-2 py-0.5 text-caption text-text-secondary"
              >
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-s">
        <CTAButton variant="secondary" href="/apply?type=APPLICATION">
          資料請求
        </CTAButton>
        <CTAButton variant="primary" href={`/apply?type=APPLICATION&school=${props.code}`}>
          この校舎で申込む
        </CTAButton>
      </div>
    </div>
  )
}
