import { describe, it, expect } from 'vitest'
import { SCHOOLS } from '@/lib/school-info'

// スキャフォールドの結合テストスモーク。実データ連携の結合テストは feature 実装時に追加する。
describe('integration smoke', () => {
  it('校舎定数(F-007)が2校を提供する', () => {
    expect(Object.keys(SCHOOLS)).toEqual(['IWATAKI', 'AMINO'])
    expect(SCHOOLS.IWATAKI.address).toContain('与謝野町')
    expect(SCHOOLS.AMINO.address).toContain('網野町')
  })
})
