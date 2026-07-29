import { describe, it, expect } from 'vitest'
import {
  APPLY_DRAFT_STORAGE_KEY,
  DRAFT_FORBIDDEN_KEYS,
  isDraftStorageAllowed,
  toDraftSnapshot,
} from '@/lib/apply-draft'

/**
 * =========================================================================
 * P3-b — AC-008-3（RV-P3D-005）: 下書き保存の条件付き許可
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-008-3（:534）、
 *       `docs/ui-design/application-form.md` §4.2 / §11 の 4〜8。
 *
 * > 入力値を **`localStorage` および Cookie に書き込まない**。**`sessionStorage` への一時保存は、
 * > 以下を全て満たす場合に限り許可する**: (a) タブを閉じると失われる /(b) 自動復元しない /
 * > (c) 常時「今すぐ削除する」導線 /(d) 送信成功・完了画面到達・破棄操作で `removeItem` /
 * > **(e) 免許証写真に関わる値（`objectKey` / `uploadToken` / プレビュー URL / `File`）を保存しない**。
 * > **(e) は絶対に緩めない**——`uploadToken` は「このオブジェクトを自分の申込に紐付ける」資格情報であり、
 * > 共有端末に残ると後続利用者が**他人の免許証画像を自分の申込に紐付けられる**。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/apply-draft.ts
 * export const APPLY_DRAFT_STORAGE_KEY = 'apply-draft/v1'
 * export const DRAFT_FORBIDDEN_KEYS: readonly string[]
 * /** 保存してよい形へ落とす（禁止値は**再帰的に**除去する）。 *\/
 * export function toDraftSnapshot(state: unknown): Record<string, unknown>
 * export function isDraftStorageAllowed(storage: 'session' | 'local' | 'cookie'): boolean
 * ```
 *
 * ## なぜ「UI が書かない」だけでは足りないのか
 * (b)(d) は E2E（`tests/e2e/playwright/apply-form.spec.ts`）でしか見られないが、**(e) は
 * 「保存する直前の値」を作る関数の性質**であり、ユニットで固定するのが最も確実である。
 * 写真は P3-c で入るため、**P3-b の時点で (e) の網を張っておかないと、
 * P3-c で写真を足した人が下書き保存の存在に気付かず (e) を破る**（単位をまたぐ事故）。
 */

describe('AC-008-3: 保存先の制約', () => {
  it('sessionStorage は許可 / localStorage と Cookie は禁止', () => {
    // これが green なら排除される事故: 「下書きが消えて不便」という声に応えて
    // `localStorage` へ移すこと。**タブを閉じても残る＝共有端末に個人情報が残留する。**
    expect(isDraftStorageAllowed('session')).toBe(true)
    expect(isDraftStorageAllowed('local')).toBe(false)
    expect(isDraftStorageAllowed('cookie')).toBe(false)
  })

  it('保存キーが定数として1つに定まっている（削除導線が消し漏らさない）', () => {
    // (d) の前提。**キーが散らばると「破棄」で全部消えない。**
    expect(APPLY_DRAFT_STORAGE_KEY).toBe('apply-draft/v1')
  })
})

describe('AC-008-3 (e): 写真に関わる値を保存しない', () => {
  it('禁止キーの一覧が仕様の4種を含む', () => {
    for (const key of ['objectKey', 'uploadToken', 'previewUrl', 'licensePhotos']) {
      expect(DRAFT_FORBIDDEN_KEYS, `${key} が禁止キーに無い`).toContain(key)
    }
  })

  it('トップレベルの写真関連値を落とす', () => {
    // これが green なら排除される攻撃: 共有端末（教習所の受付端末・ネットカフェ・学校の PC）で
    // 前の利用者の `uploadToken` が残り、**後続利用者が他人の免許証画像を自分の申込へ紐付ける**こと。
    const snapshot = toDraftSnapshot({
      name: '山田 太郎',
      objectKey: 'applications/tmp/front.jpg',
      uploadToken: 'ut_secret_token',
      previewUrl: 'blob:https://example.test/9f0e',
      idempotencyKey: '3f8b1c2e-5a4d-4e7f-9b0a-1c2d3e4f5a6b',
    })
    expect(snapshot.name).toBe('山田 太郎')
    expect(snapshot.objectKey).toBeUndefined()
    expect(snapshot.uploadToken).toBeUndefined()
    expect(snapshot.previewUrl).toBeUndefined()
  })

  it('ネストした写真関連値も落とす（licensePhotos 配列の中身）', () => {
    // **P3-c の実際の形はこれである**（`licensePhotos: [{ objectKey, uploadToken, side }]`）。
    // これが green なら排除される事故: トップレベルだけ見て「対応済み」と report し、
    // P3-c で写真を足した瞬間に (e) が破れること。
    const snapshot = toDraftSnapshot({
      licensePhotos: [
        { objectKey: 'a/front.jpg', uploadToken: 'ut_1', side: 'front' },
        { objectKey: 'a/back.jpg', uploadToken: 'ut_2', side: 'back' },
      ],
      nested: { deep: { uploadToken: 'ut_3' } },
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('ut_1')
    expect(serialized).not.toContain('ut_2')
    expect(serialized).not.toContain('ut_3')
    expect(serialized).not.toContain('front.jpg')
  })

  it('blob: / data: の URL は、キー名に関わらず落とす', () => {
    // これが green なら排除される事故: プレビュー URL を別名（`photoSrc` / `thumb`）で持ったとき、
    // キー名の一覧では捕まえられないこと。**値の形でも落とす**二重の網にする。
    const snapshot = toDraftSnapshot({
      photoSrc: 'blob:https://example.test/9f0e',
      thumb: 'data:image/jpeg;base64,/9j/4AAQ',
      website: 'https://example.test/ok',
    })
    expect(snapshot.photoSrc).toBeUndefined()
    expect(snapshot.thumb).toBeUndefined()
    expect(snapshot.website, '通常の URL まで落としてはいけない').toBe('https://example.test/ok')
  })

  it('シリアライズできない値（File / Blob / 関数）を落とす', () => {
    // これが green なら排除される事故: `JSON.stringify(state)` が `File` を `{}` にしてしまい、
    // 「保存されている」と誤認したまま復元で壊れること。**明示的に落とす。**
    const file = new File([new Uint8Array([1, 2, 3])], 'license.jpg', { type: 'image/jpeg' })
    const snapshot = toDraftSnapshot({
      name: '山田 太郎',
      frontFile: file,
      onChange: () => {},
    })
    expect(snapshot.frontFile).toBeUndefined()
    expect(snapshot.onChange).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('license.jpg')
  })

  it('idempotencyKey は保存してよい（AC-008-3 の明示的な例外）', () => {
    // これが green なら排除される退行: 「安全側に倒す」つもりで `idempotencyKey` まで落とし、
    // **リロード後の二重登録防止（form-submission.md §2.1）が壊れる**こと。
    // AC-008-3 は「`idempotencyKey` は PII ではないため保存してよい」と明記している。
    const snapshot = toDraftSnapshot({ idempotencyKey: '3f8b1c2e-5a4d-4e7f-9b0a-1c2d3e4f5a6b' })
    expect(snapshot.idempotencyKey).toBe('3f8b1c2e-5a4d-4e7f-9b0a-1c2d3e4f5a6b')
  })

  it('captchaToken は保存しない（再利用できない資格情報を残さない）', () => {
    // Turnstile トークンは単回・短期だが、共有端末に残す理由が無い。
    expect(toDraftSnapshot({ captchaToken: 'ts_token' }).captchaToken).toBeUndefined()
  })

  it('循環参照・巨大な入力でも例外を投げない', () => {
    // 下書き保存は入力のたびに走る。**ここで throw するとフォーム全体が固まる。**
    const circular: Record<string, unknown> = { name: '山田' }
    circular.self = circular
    expect(() => toDraftSnapshot(circular)).not.toThrow()
    expect(() => toDraftSnapshot({ message: 'あ'.repeat(200_000) })).not.toThrow()
    for (const input of [null, undefined, 'string', 42, []]) {
      expect(() => toDraftSnapshot(input)).not.toThrow()
    }
  })
})
