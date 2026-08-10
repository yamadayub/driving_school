/**
 * Badge（DESIGN.md §2 Badge Roles / §4, layout.md §7.1）。
 * 役割 = 色 + 形状 の二重エンコード（色だけに依存しない）。形状は lib/badge に委譲する。
 */
import { badgeShapeForVariant, type BadgeVariant } from '@/lib/badge'
import {
  SCHOOL_LABELS,
  FORMAT_LABELS,
  PROGRAM_CATEGORY_LABELS,
  SUBSIDY_LABELS,
} from '@/lib/labels'

type BadgeValue = string

interface BadgeProps {
  variant: BadgeVariant
  value: BadgeValue
}

/** value -> 表示ラベル。variant ごとの固定ラベルテーブルで解決する。 */
function resolveLabel(variant: BadgeVariant, value: string): string {
  switch (variant) {
    case 'school':
      return SCHOOL_LABELS[value as keyof typeof SCHOOL_LABELS] ?? value
    case 'format':
      return FORMAT_LABELS[value as keyof typeof FORMAT_LABELS] ?? value
    case 'category':
      return PROGRAM_CATEGORY_LABELS[value as keyof typeof PROGRAM_CATEGORY_LABELS] ?? value
    case 'subsidy':
      return SUBSIDY_LABELS[value as keyof typeof SUBSIDY_LABELS] ?? value
    default:
      return value
  }
}

/** variant/value ごとの配色ユーティリティクラス（tailwind.config のトークンに対応）。 */
function colorClass(variant: BadgeVariant, value: string): string {
  switch (variant) {
    case 'school':
      return value === 'IWATAKI'
        ? 'border-school-iwataki text-school-iwataki'
        : 'border-school-amino text-school-amino'
    case 'format':
      // 通学=紫 / 合宿=ピンク。accent-700 はオレンジ固定なので使わない（design-tokens 参照）。
      return value === 'TSUGAKU'
        ? 'bg-accent-50 text-accent-800'
        : 'bg-primary-50 text-primary-700'
    case 'category':
      switch (value) {
        case 'DRONE':
          return 'bg-category-drone-bg text-category-drone'
        case 'KENKI':
          return 'bg-category-kenki-bg text-category-kenki'
        case 'COMMON':
          return 'bg-category-common-bg text-category-common'
        default:
          return 'bg-category-common-bg text-category-common'
      }
    case 'subsidy':
      return value === 'GRANT'
        ? 'bg-subsidy-grant-bg text-subsidy-grant'
        : 'bg-subsidy-benefit-bg text-subsidy-benefit'
    default:
      return 'bg-canvas text-text-secondary'
  }
}

const SHAPE_CLASS: Record<string, string> = {
  outline: 'rounded-pill border bg-surface',
  pill: 'rounded-pill',
  'rounded-rect': 'rounded',
  'pill-icon': 'rounded-pill',
}

export function Badge({ variant, value }: BadgeProps) {
  const shape = badgeShapeForVariant(variant)
  const label = resolveLabel(variant, value)
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-caption font-bold ${SHAPE_CLASS[shape]} ${colorClass(
        variant,
        value,
      )}`}
    >
      {variant === 'school' && <span aria-hidden="true">●</span>}
      {variant === 'subsidy' && <span aria-hidden="true">✓</span>}
      {label}
    </span>
  )
}
