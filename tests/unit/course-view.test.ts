import { describe, it, expect } from 'vitest'
import {
  courseDisplayName,
  toSubsidyTags,
  subsidyLabel,
} from '@/lib/course-view'

/**
 * F-002 / F-003 — Course 表示ビューモデル変換。US-001 / US-002。
 * 対象モジュール（想定）: @/lib/course-view
 * 契約元: layout.md §7.2（見出し = licenseTypeLabel ?? programLabel + transmission）,
 *         §7.1（subsidy value = GRANT/SUBSIDY）。
 * red 理由: 本体未実装（NotImplemented throw）。
 *
 * 注意: 入力は seed 依存を避けた合成フィクスチャ（licenseTypeLabel は基底名 "普通車" とし、
 * transmission は別属性として渡す — Props 契約どおり）。
 */
describe('F-002/F-003: courseDisplayName（見出し解決）', () => {
  it('LICENSE + AT: "普通車" + AT -> "普通車(AT)"', () => {
    expect(
      courseDisplayName({
        licenseTypeLabel: '普通車',
        programLabel: null,
        transmission: 'AT',
      }),
    ).toBe('普通車(AT)')
  })

  it('LICENSE + MT: "普通車" + MT -> "普通車(MT)"', () => {
    expect(
      courseDisplayName({
        licenseTypeLabel: '普通車',
        programLabel: null,
        transmission: 'MT',
      }),
    ).toBe('普通車(MT)')
  })

  it('LICENSE + transmission=null: "大型" -> "大型"（括弧を付けない）', () => {
    expect(
      courseDisplayName({
        licenseTypeLabel: '大型',
        programLabel: null,
        transmission: null,
      }),
    ).toBe('大型')
  })

  it('非LICENSE: programLabel を見出しに使う（licenseTypeLabel=null）', () => {
    expect(
      courseDisplayName({
        licenseTypeLabel: null,
        programLabel: '農業用ドローン',
        transmission: null,
      }),
    ).toBe('農業用ドローン')
  })
})

describe('F-002/F-003: subsidyTags 正規化（DB文字列 -> Badge value）', () => {
  it('"教育訓練給付金" -> ["GRANT"]', () => {
    expect(toSubsidyTags(['教育訓練給付金'])).toEqual(['GRANT'])
  })
  it('"助成金対象" -> ["SUBSIDY"]', () => {
    expect(toSubsidyTags(['助成金対象'])).toEqual(['SUBSIDY'])
  })
  it('複数タグを順序保持で正規化する', () => {
    expect(toSubsidyTags(['教育訓練給付金', '助成金対象'])).toEqual([
      'GRANT',
      'SUBSIDY',
    ])
  })
  it('境界: 空配列 -> 空配列', () => {
    expect(toSubsidyTags([])).toEqual([])
  })
  it('異常系: 未知タグは無視する', () => {
    expect(toSubsidyTags(['不明タグ'])).toEqual([])
  })
})

describe('F-002/F-003: subsidyLabel（Badge value -> 日本語）', () => {
  it('GRANT -> "給付金"', () => {
    expect(subsidyLabel('GRANT')).toBe('給付金')
  })
  it('SUBSIDY -> "助成金"', () => {
    expect(subsidyLabel('SUBSIDY')).toBe('助成金')
  })
})
