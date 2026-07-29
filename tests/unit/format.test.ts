import { describe, it, expect } from 'vitest'
import {
  formatPrice,
  formatPriceFrom,
  formatMinDays,
  formatNewsDate,
} from '@/lib/format'

/**
 * F-002 / F-003 / F-001 — 表示整形（料金・日数・日付）。US-001 / US-002 / US-003。
 * 対象モジュール（想定）: @/lib/format
 * red 理由: 本体未実装（NotImplemented throw）。期待する整形結果を仕様化する。
 */
describe('F-002/F-003: 料金・日数の表示整形（@/lib/format）', () => {
  describe('formatPrice — 円記号 + 3桁カンマ', () => {
    it('正常系: 225500 -> "¥225,500"', () => {
      expect(formatPrice(225500)).toBe('¥225,500')
    })
    it('境界: 百万円台もカンマ区切りされる 1000000 -> "¥1,000,000"', () => {
      expect(formatPrice(1000000)).toBe('¥1,000,000')
    })
    it('境界: 4桁未満はカンマなし 6450 -> "¥6,450"', () => {
      expect(formatPrice(6450)).toBe('¥6,450')
    })
  })

  describe('formatPriceFrom — 「〜」サフィックス（料金〜表示）', () => {
    it('正常系: 225500 -> "¥225,500〜"', () => {
      expect(formatPriceFrom(225500)).toBe('¥225,500〜')
    })
  })

  describe('formatMinDays — 最短日数表示', () => {
    it('正常系: 15 -> "最短15日"', () => {
      expect(formatMinDays(15)).toBe('最短15日')
    })
    it('境界: 最小値 1 -> "最短1日"', () => {
      expect(formatMinDays(1)).toBe('最短1日')
    })
  })
})

describe('F-001: お知らせ日付整形（@/lib/format.formatNewsDate）', () => {
  it('正常系: ISO日付 -> "2026.07.19"', () => {
    expect(formatNewsDate('2026-07-19')).toBe('2026.07.19')
  })
  it('境界: 月日はゼロ埋め "2026-01-05" -> "2026.01.05"', () => {
    expect(formatNewsDate('2026-01-05')).toBe('2026.01.05')
  })
})
