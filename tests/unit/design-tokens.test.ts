import { describe, it, expect } from 'vitest'
import {
  colors,
  schoolBadgeColors,
  formatBadgeColors,
  categoryBadgeColors,
  subsidyBadgeColors,
  badgeShapes,
  spacing,
  radius,
} from '@/lib/design-tokens'

// スキャフォールドのサンプル単体テスト: デザイントークンが DESIGN.md の値と一致することを検証。
// バッジ役割ごとの色相・形状分離（REV-008）が壊れていないことをスモークで担保する。
describe('design tokens', () => {
  it('primary/accent のブランドカラーが DESIGN §2 と一致する', () => {
    expect(colors.primary[700]).toBe('#BE123C')
    expect(colors.accent[700]).toBe('#C2410C')
    expect(colors.line.base).toBe('#06C755')
  })

  it('校舎バッジ(岩滝/網野)が Indigo/Teal で分離されている', () => {
    expect(schoolBadgeColors.IWATAKI).toBe('#4338CA')
    expect(schoolBadgeColors.AMINO).toBe('#0F766E')
    expect(schoolBadgeColors.IWATAKI).not.toBe(schoolBadgeColors.AMINO)
  })

  it('役割ごとにバッジ形状が異なる（色だけに依存しない, REV-008）', () => {
    const shapes = Object.values(badgeShapes)
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  it('受講形態/カテゴリ/給付金バッジが text/bg ペアを持つ', () => {
    expect(formatBadgeColors.TSUGAKU).toEqual({ text: '#1D4ED8', bg: '#EFF6FF' })
    expect(formatBadgeColors.GASSHUKU).toEqual({ text: '#C2410C', bg: '#FFF7ED' })
    expect(categoryBadgeColors.drone.text).toBe('#6D28D9')
    expect(subsidyBadgeColors.grant.text).toBe('#4D7C0F')
  })

  it('spacing/radius スケールが DESIGN §5/§9 と一致する', () => {
    expect(spacing.m).toBe(16)
    expect(spacing.xxxl).toBe(64)
    expect(radius.card).toBe(12)
    expect(radius.pill).toBe(999)
  })
})
