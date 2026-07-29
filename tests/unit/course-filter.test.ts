import { describe, it, expect } from 'vitest'
import {
  filterCourses,
  type FilterableCourse,
} from '@/lib/course-filter'

/**
 * F-002 — コース比較フィルタ（校舎 × 受講形態 × 免許種別）。US-001。
 * 対象モジュール（想定）: @/lib/course-filter
 * 契約元: course-comparison.md フィルタ仕様。非LICENSE は常に除外。
 * red 理由: 本体未実装（NotImplemented throw）。
 *
 * フィクスチャは seed（LICENSE=11: 通学10 + 合宿1）の対応校構成をそのまま反映した合成データ。
 * 校舎別の期待件数（岩滝通学=9 / 網野通学=7）が seed と一致するよう定義している。
 */
const FIXTURE: FilterableCourse[] = [
  { category: 'LICENSE', licenseType: 'ORDINARY', transmission: 'AT', format: 'TSUGAKU', schools: ['IWATAKI', 'AMINO'] },
  { category: 'LICENSE', licenseType: 'ORDINARY', transmission: 'MT', format: 'TSUGAKU', schools: ['IWATAKI', 'AMINO'] },
  { category: 'LICENSE', licenseType: 'SEMI_MEDIUM', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI', 'AMINO'] },
  { category: 'LICENSE', licenseType: 'MEDIUM', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI', 'AMINO'] },
  { category: 'LICENSE', licenseType: 'LARGE', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI'] },
  { category: 'LICENSE', licenseType: 'ORDINARY_2ND', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI'] },
  { category: 'LICENSE', licenseType: 'LARGE_SPECIAL', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI', 'AMINO'] },
  { category: 'LICENSE', licenseType: 'TOWING', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI', 'AMINO'] },
  { category: 'LICENSE', licenseType: 'LARGE_2ND', transmission: null, format: 'TSUGAKU', schools: ['IWATAKI'] },
  { category: 'LICENSE', licenseType: 'MOTORCYCLE', transmission: null, format: 'TSUGAKU', schools: ['AMINO'] },
  { category: 'LICENSE', licenseType: 'ORDINARY', transmission: 'AT', format: 'GASSHUKU', schools: ['IWATAKI'] },
  // 非LICENSE（比較UI対象外 — 常に除外されること）
  { category: 'DRONE', licenseType: null, transmission: null, format: null, schools: ['IWATAKI', 'AMINO'] },
]

describe('F-002: filterCourses（校舎×受講形態×免許種別）', () => {
  it('非LICENSE(DRONE)を除外する（フィルタ空でも LICENSE のみ = 11件）', () => {
    expect(filterCourses(FIXTURE, {}).length).toBe(11)
    expect(filterCourses(FIXTURE, {}).every((c) => c.category === 'LICENSE')).toBe(true)
  })

  it('受講形態=通学 で 10件（合宿1件を除外）', () => {
    expect(filterCourses(FIXTURE, { format: 'TSUGAKU' }).length).toBe(10)
  })

  it('受講形態=合宿 で 1件', () => {
    expect(filterCourses(FIXTURE, { format: 'GASSHUKU' }).length).toBe(1)
  })

  it('校舎=すべて(ALL) は絞り込まない（通学=10件）', () => {
    expect(filterCourses(FIXTURE, { format: 'TSUGAKU', school: 'ALL' }).length).toBe(10)
  })

  it('校舎=岩滝 × 通学 で 9件（普通自動二輪は網野のみ→除外）', () => {
    expect(filterCourses(FIXTURE, { format: 'TSUGAKU', school: 'IWATAKI' }).length).toBe(9)
  })

  it('校舎=網野 × 通学 で 7件（大型/普通二種/大型二種は岩滝のみ→除外）', () => {
    expect(filterCourses(FIXTURE, { format: 'TSUGAKU', school: 'AMINO' }).length).toBe(7)
  })

  it('免許種別=大型 × 通学 で 1件（岩滝のみ対応）', () => {
    const r = filterCourses(FIXTURE, { format: 'TSUGAKU', licenseTypes: ['LARGE'] })
    expect(r.length).toBe(1)
    expect(r[0].licenseType).toBe('LARGE')
  })

  it('免許種別=普通車 × 通学 で 2件（AT/MT両方）', () => {
    expect(
      filterCourses(FIXTURE, { format: 'TSUGAKU', licenseTypes: ['ORDINARY'] }).length,
    ).toBe(2)
  })

  it('普通車 × AT × 通学 で 1件（transmission 絞り込み）', () => {
    expect(
      filterCourses(FIXTURE, {
        format: 'TSUGAKU',
        licenseTypes: ['ORDINARY'],
        transmission: 'AT',
      }).length,
    ).toBe(1)
  })

  it('E-002-1: 網野 × 大型（岩滝限定）は 0件（条件一致なし）', () => {
    expect(
      filterCourses(FIXTURE, { format: 'TSUGAKU', school: 'AMINO', licenseTypes: ['LARGE'] })
        .length,
    ).toBe(0)
  })
})
