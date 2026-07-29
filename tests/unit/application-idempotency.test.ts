import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { deriveSessionIdHash, sessionIdMatches } from '@/lib/application-idempotency'
import { deriveFormSessionKey } from '@/lib/form-session'

/**
 * =========================================================================
 * P3-b — AC-010-4 / SPEC-017（RV-P3DR-002）: 冪等照合の `sid` ハッシュ
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-4（:787）/ SPEC-017（:852-856）/
 *       `prisma/schema.prisma` `Application.sessionIdHash`。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/application-idempotency.ts
 * /** `HMAC-SHA256(sid, HKDF(FORM_SESSION_SECRET, 照合専用ラベル))` の hex。 *\/
 * export function deriveSessionIdHash(sid: string, secret: string): string
 * /** **定数時間比較**。`storedHash` が null / undefined は必ず false（「誰でも一致」にしない）。 *\/
 * export function sessionIdMatches(
 *   storedHash: string | null | undefined,
 *   sid: string | null | undefined,
 *   secret: string,
 * ): boolean
 * ```
 *
 * ## なぜ `idempotencyKey` だけで照合してはならないのか（AC-010-4 の理由）
 * `idempotencyKey` は **sessionStorage の下書き**（AC-008-3 が保存を明示的に許可している）と
 * 共有端末という漏えい経路を持つ。キーだけを提示した第三者へ `id` / `receiptNumber` を返すと、
 * **他人の受付番号を取得できる**——F-017 / F-018 が将来 `receiptNumber` を鍵にした瞬間に IDOR になる。
 */

const SECRET = 'p3b-form-session-secret-32-characters-min'
const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OTHER_SID = 'ffffffffffffffffffffffffffffffff'

describe('SPEC-017: sessionIdHash の導出', () => {
  it('生の sid を返さない（保存されるのはハッシュだけ）', () => {
    // これが green なら排除される事故: `sessionIdHash` 列に生の `sid` が入ること。
    // `sid` は**資格情報的な性質**を持つ（Cookie を再構成できれば他人の冪等再送に成りすませる）ため、
    // DB 侵害時の被害が「識別子の漏えい」から「セッションの乗っ取り」へ跳ね上がる（SPEC-017 の PII 上の扱い）。
    const hash = deriveSessionIdHash(SID, SECRET)
    expect(hash).not.toContain(SID)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同じ sid + 同じ鍵なら決定的（2回目の POST が別インスタンスでも照合できる）', () => {
    expect(deriveSessionIdHash(SID, SECRET)).toBe(deriveSessionIdHash(SID, SECRET))
  })

  it('sid が違えばハッシュも違う', () => {
    expect(deriveSessionIdHash(SID, SECRET)).not.toBe(deriveSessionIdHash(OTHER_SID, SECRET))
  })

  it('鍵が違えばハッシュも違う（鍵ローテーション時に誤って一致しない）', () => {
    expect(deriveSessionIdHash(SID, SECRET)).not.toBe(deriveSessionIdHash(SID, `${SECRET}-v2`))
  })

  it('Cookie 署名鍵とは別ラベルの鍵を使う（用途分離 / tech-stack §4.6）', () => {
    // これが green なら排除される壊れた実装: Cookie 署名と同じ導出鍵で照合ハッシュを作ること。
    // 同一鍵だと **DB に保存されたハッシュが「その sid の署名」と同値**になり、
    // DB 侵害＝有効な Cookie を作れる状態（署名オラクル）に近づく。
    // SPEC-017 は「Cookie 署名の鍵とラベルを分ける」と明記している。
    const sameKeyAsCookie = createHmac('sha256', deriveFormSessionKey(SECRET))
      .update(SID)
      .digest('hex')
    expect(deriveSessionIdHash(SID, SECRET)).not.toBe(sameKeyAsCookie)
  })

  it('非 ASCII / 長大な sid でも例外を投げない', () => {
    // `sid` は署名検証を通った値だが、鍵が漏えいした場合は攻撃者が中身を決められる。
    // **500 を作らせない**（例外は Tier 契約の外側の失敗になる）。
    for (const sid of ['😀'.repeat(100), 'あ'.repeat(1_000), '', 'a'.repeat(100_000)]) {
      expect(() => deriveSessionIdHash(sid, SECRET)).not.toThrow()
    }
  })
})

describe('AC-010-4: sessionIdMatches の判定', () => {
  const STORED = deriveSessionIdHash(SID, SECRET)

  it('(a) 同一 Cookie の再送は一致する', () => {
    expect(sessionIdMatches(STORED, SID, SECRET)).toBe(true)
  })

  it('(b) 別 Cookie は一致しない', () => {
    // これが green なら排除される攻撃: 漏えいした `idempotencyKey` を別ブラウザから提示して
    // **他人の `id` / `receiptNumber` を受け取る**こと。AC-010-4 はこの場合
    // `{ idempotent: true }` のみを返し、`id` / `receiptNumber` を返さないと定めている。
    expect(sessionIdMatches(STORED, OTHER_SID, SECRET)).toBe(false)
  })

  it('(d) storedHash が null / undefined / 空文字は必ず不一致', () => {
    // **AC-010-4 が名指しで禁じている状態**: 「`sessionIdHash` が `null`（＝値を持たない既存行）を
    // 『誰でも一致』にしない」。マイグレーション直後の既存行はすべて null であり、
    // ここを truthy 判定（`stored === hash` を `!stored || stored === hash` と書く等）にすると、
    // **移行期間中は誰でも他人の受付番号を引ける**状態になる。
    for (const stored of [null, undefined, '']) {
      expect(sessionIdMatches(stored, SID, SECRET), String(stored)).toBe(false)
    }
  })

  it('sid 側が null / undefined / 空文字でも不一致（例外を投げない）', () => {
    for (const sid of [null, undefined, '']) {
      expect(() => sessionIdMatches(STORED, sid, SECRET)).not.toThrow()
      expect(sessionIdMatches(STORED, sid, SECRET)).toBe(false)
    }
  })

  it('両方 null でも一致にしない（null === null を「一致」と読まない）', () => {
    expect(sessionIdMatches(null, null, SECRET)).toBe(false)
  })

  it('長さの異なる storedHash でも例外を投げず false（定数時間比較の前段）', () => {
    // これが green なら排除される攻撃: DB の値が壊れている / 攻撃者が別経路で短い値を書けた場合に
    // `timingSafeEqual` が `RangeError` を投げて **未認証の第三者が 500 を起こせる**こと
    //（SEC-042 とまったく同じ形。同じ欠陥を新しいモジュールで繰り返さない）。
    for (const stored of ['00', 'f'.repeat(63), 'f'.repeat(65), '😀'.repeat(32), 'あ'.repeat(64)]) {
      expect(() => sessionIdMatches(stored, SID, SECRET)).not.toThrow()
      expect(sessionIdMatches(stored, SID, SECRET)).toBe(false)
    }
  })

  it('大小文字違いの hex は一致しない（比較を正規化で緩めない）', () => {
    // 決定（申し送り T-Q5）: 保存も比較も**小文字 hex**で固定する。
    // `toLowerCase()` を比較の中に入れると、定数時間比較の前に入力依存の処理が入る。
    expect(sessionIdMatches(STORED.toUpperCase(), SID, SECRET)).toBe(false)
  })
})
