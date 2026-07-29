import { describe, it, expect } from 'vitest'
import { newsCategoryBadge, badgeShapeForVariant } from '@/lib/badge'
import { badgeShapes } from '@/lib/design-tokens'

/**
 * F-001 / F-004 — Badge 役割解決（役割=色+形状の二重エンコード, DESIGN.md / REV-008）。US-001 / US-003。
 * 対象モジュール（想定）: @/lib/badge（design-tokens.badgeShapes は実装済み）。
 * red 理由: @/lib/badge 本体未実装（NotImplemented throw）。design-tokens 側は既存でパスする。
 */
describe('F-004: newsCategoryBadge（NewsCategory -> variant/value 出し分け）', () => {
  it('IWATAKI/AMINO は school バッジ（校舎）', () => {
    expect(newsCategoryBadge('IWATAKI')).toEqual({ variant: 'school', value: 'IWATAKI' })
    expect(newsCategoryBadge('AMINO').variant).toBe('school')
  })

  it('DRONE/KENKI/COMMON は category バッジ（役割の異なるバッジを混在させない）', () => {
    expect(newsCategoryBadge('DRONE').variant).toBe('category')
    expect(newsCategoryBadge('KENKI').variant).toBe('category')
    expect(newsCategoryBadge('COMMON').variant).toBe('category')
  })
})

describe('DESIGN: badgeShapeForVariant（色だけに依存しない=形状で役割を識別）', () => {
  it('variant ごとに design-tokens.badgeShapes と一致する形状を返す', () => {
    expect(badgeShapeForVariant('school')).toBe(badgeShapes.school) // 'outline'
    expect(badgeShapeForVariant('format')).toBe(badgeShapes.format) // 'pill'
    expect(badgeShapeForVariant('category')).toBe(badgeShapes.category) // 'rounded-rect'
    expect(badgeShapeForVariant('subsidy')).toBe(badgeShapes.subsidy) // 'pill-icon'
  })

  it('school と category は形状が異なる（色以外でも判別可能=二重エンコード）', () => {
    expect(badgeShapeForVariant('school')).not.toBe(badgeShapeForVariant('category'))
  })
})
