import { describe, it, expect } from 'vitest'
import { publishStatusBadge } from '@/lib/badge'
import { PUBLISH_STATUS_LABELS } from '@/lib/publish-status'

/**
 * F-014 / US-012 — 公開ステータスのバッジ解決（DESIGN §4「公開ステータス」, news-cms §1/§2）。
 * 対象モジュール（想定契約）: @/lib/badge の publishStatusBadge。
 *  DRAFT/PUBLISHED/UNPUBLISHED -> 下書き/公開/非公開、variant='publishStatus'。
 *
 * red 理由: publishStatusBadge 本体未実装（NotImplemented throw）。実装後 green を目指す。
 * PUBLISH_STATUS_LABELS（@/lib/publish-status）は実装済みのため参照可能。
 */
describe('F-014: publishStatusBadge（3値 -> ラベル/variant/tone）', () => {
  it('DRAFT は「下書き」', () => {
    expect(publishStatusBadge('DRAFT')).toEqual({
      variant: 'publishStatus',
      label: '下書き',
      tone: 'draft',
    })
  })

  it('PUBLISHED は「公開」', () => {
    expect(publishStatusBadge('PUBLISHED')).toEqual({
      variant: 'publishStatus',
      label: '公開',
      tone: 'published',
    })
  })

  it('UNPUBLISHED は「非公開」', () => {
    expect(publishStatusBadge('UNPUBLISHED')).toEqual({
      variant: 'publishStatus',
      label: '非公開',
      tone: 'unpublished',
    })
  })

  it('label は PUBLISH_STATUS_LABELS（単一ラベル源）と一致する', () => {
    for (const s of ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'] as const) {
      expect(publishStatusBadge(s).label).toBe(PUBLISH_STATUS_LABELS[s])
      expect(publishStatusBadge(s).variant).toBe('publishStatus')
    }
  })
})
