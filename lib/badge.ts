/**
 * Badge 役割解決（F-001/F-004, DESIGN.md Badge Roles / REV-008）。
 * 「役割 = 色 + 形状」の二重エンコード（色のみに依存しない）を担保する純関数群。
 * 形状の値は lib/design-tokens.ts の `badgeShapes` を単一の参照元とする。
 *
 * TDD スタブ: 本体は未実装。tests/unit/badge.test.ts が期待するマッピングを満たすよう
 * Impl Agent が実装する。
 */

import { badgeShapes } from '@/lib/design-tokens'
import { PUBLISH_STATUS_LABELS, type PublishStatusCode } from '@/lib/publish-status'

export type NewsCategoryCode = 'IWATAKI' | 'AMINO' | 'DRONE' | 'KENKI' | 'COMMON'
export type BadgeVariant =
  | 'school'
  | 'format'
  | 'category'
  | 'subsidy'
  | 'adminStatus'
  | 'publishStatus'
/** design-tokens.badgeShapes と一致させる形状トークン。 */
export type BadgeShape = 'outline' | 'pill' | 'rounded-rect' | 'pill-icon'

/**
 * NewsCategory から Badge の variant/value を出し分ける（layout.md §7.3）:
 *  - IWATAKI/AMINO -> variant="school"（校舎バッジ, Outline）
 *  - DRONE/KENKI/COMMON -> variant="category"（カテゴリバッジ, Filled Rounded-Rect）
 * 役割の異なるバッジを混在させないための解決関数。
 */
export function newsCategoryBadge(category: NewsCategoryCode): {
  variant: 'school' | 'category'
  value: NewsCategoryCode
} {
  const variant: 'school' | 'category' =
    category === 'IWATAKI' || category === 'AMINO' ? 'school' : 'category'
  return { variant, value: category }
}

/**
 * Badge variant -> 形状トークン（design-tokens.badgeShapes と一致すること）:
 *  school->'outline' / format->'pill' / category->'rounded-rect' / subsidy->'pill-icon'
 *  adminStatus->'pill'
 */
export function badgeShapeForVariant(variant: BadgeVariant): BadgeShape {
  // adminStatus/publishStatus は design-tokens.badgeShapes に含めない
  // （管理画面の Semantic/公開ステータス流用の Filled Pill, DESIGN §4）。
  if (variant === 'adminStatus' || variant === 'publishStatus') return 'pill'
  return badgeShapes[variant]
}

/**
 * 公開ステータス（PublishStatus 3値）-> バッジの variant/label/tone を解決する
 * （F-014 一覧・編集プレビューの状態バッジ, news-cms.md §1/§2, DESIGN §4「公開ステータス」）:
 *  - DRAFT       -> 下書き（Slate）
 *  - PUBLISHED   -> 公開（Success Green）
 *  - UNPUBLISHED -> 非公開（Cyan）
 * variant は常に 'publishStatus'（Filled Pill, 校舎/カテゴリバッジと色相・形状で衝突しない専用色）。
 *
 * TDD スタブ: 本体未実装。tests/unit/publish-status-badge.test.ts の期待を満たすよう Impl が実装する。
 */
export function publishStatusBadge(status: PublishStatusCode): {
  variant: 'publishStatus'
  label: string
  tone: 'draft' | 'published' | 'unpublished'
} {
  const TONES: Record<PublishStatusCode, 'draft' | 'published' | 'unpublished'> = {
    DRAFT: 'draft',
    PUBLISHED: 'published',
    UNPUBLISHED: 'unpublished',
  }
  return {
    variant: 'publishStatus',
    label: PUBLISH_STATUS_LABELS[status],
    tone: TONES[status],
  }
}
