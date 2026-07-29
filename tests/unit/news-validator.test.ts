import { describe, it, expect } from 'vitest'
import { parseNewsInput } from '@/lib/validators/news'

/**
 * F-014 / US-012 — お知らせ入力バリデーション（functional-spec §4.5 / E-014-1/2/4, news-cms フォーム項目）。
 * 対象モジュール（想定契約）: @/lib/validators/news の
 *   parseNewsInput(input): { success:true; data } | { success:false; errors }
 *
 * red 理由: parseNewsInput 本体未実装（NotImplemented throw）。実装後 green を目指す。
 */
function base() {
  return {
    title: '夏の入校キャンペーン',
    body: '本文です。',
    category: 'IWATAKI',
    status: 'DRAFT',
    publishedAt: null,
  }
}

describe('F-014: 正常系', () => {
  it('下書き（publishedAt 未設定）は妥当', () => {
    const r = parseNewsInput(base())
    expect(r.success).toBe(true)
  })

  it('公開（status=PUBLISHED, publishedAt あり）は妥当', () => {
    const r = parseNewsInput({
      ...base(),
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-20T10:00:00+09:00'),
    })
    expect(r.success).toBe(true)
  })

  it('非公開（status=UNPUBLISHED, publishedAt=null）は妥当', () => {
    const r = parseNewsInput({ ...base(), status: 'UNPUBLISHED', publishedAt: null })
    expect(r.success).toBe(true)
  })
})

describe('F-014 異常系: 必須・enum・条件必須', () => {
  it('E-014-1: タイトル未入力は不正（title エラー）', () => {
    const r = parseNewsInput({ ...base(), title: '' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errors).toHaveProperty('title')
  })

  it('E-014-1: 本文未入力は不正（body エラー）', () => {
    const r = parseNewsInput({ ...base(), body: '' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errors).toHaveProperty('body')
  })

  it('E-014-2: PUBLISHED かつ publishedAt=null は不正（publishedAt エラー）', () => {
    const r = parseNewsInput({ ...base(), status: 'PUBLISHED', publishedAt: null })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errors).toHaveProperty('publishedAt')
  })

  it('E-014-4: status が enum 外は不正', () => {
    const r = parseNewsInput({ ...base(), status: 'ARCHIVED' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errors).toHaveProperty('status')
  })

  it('category が enum 外（廃止された ALL, REV-006）は不正', () => {
    const r = parseNewsInput({ ...base(), category: 'ALL' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errors).toHaveProperty('category')
  })
})

describe('F-014 境界値: タイトル 1〜100 / 本文 1〜20000', () => {
  it('タイトル 1文字・100文字は妥当', () => {
    expect(parseNewsInput({ ...base(), title: 'あ' }).success).toBe(true)
    expect(parseNewsInput({ ...base(), title: 'あ'.repeat(100) }).success).toBe(true)
  })

  it('タイトル 101文字は不正', () => {
    const r = parseNewsInput({ ...base(), title: 'あ'.repeat(101) })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errors).toHaveProperty('title')
  })

  it('本文 20000文字は妥当・20001文字は不正（レンダリング負荷ガード）', () => {
    expect(parseNewsInput({ ...base(), body: 'x'.repeat(20000) }).success).toBe(true)
    const over = parseNewsInput({ ...base(), body: 'x'.repeat(20001) })
    expect(over.success).toBe(false)
    if (!over.success) expect(over.errors).toHaveProperty('body')
  })
})
