/**
 * 冪等再送の照合（AC-010-4 / SPEC-017 / RV-P3DR-002）。
 *
 * ------------------------------------------------------------------------
 * なぜ `idempotencyKey` だけで照合してはならないのか
 * ------------------------------------------------------------------------
 * `idempotencyKey` はクライアント生成の UUID であり、**`sessionStorage` の下書き**
 * （AC-008-3 が保存を明示的に許可している）と共有端末という漏えい経路を持つ。
 * キーだけを提示した第三者へ `id` / `receiptNumber` を返すと、**他人の受付番号を取得できる**。
 * したがって「`idempotencyKey` かつフォームセッション Cookie の `sid` の一致」で照合する。
 *
 * ------------------------------------------------------------------------
 * なぜ生の `sid` を保存しないのか
 * ------------------------------------------------------------------------
 * `sid` は資格情報的な性質を持つ（Cookie を再構成できれば他人の冪等再送に成りすませる）。
 * 生値を保存すると DB 侵害時の被害が「識別子の漏えい」から「セッションの乗っ取り」へ跳ね上がる。
 *
 * **Cookie 署名鍵とはラベルを分けて導出する**（`tech-stack.md` §4.6）。同一鍵だと DB に保存された
 * ハッシュが「その `sid` の署名」と同値になり、DB 侵害＝有効な Cookie を作れる状態（署名オラクル）
 * に近づく。
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

/** HKDF の用途ラベル。`lib/form-session.ts` の Cookie 署名用ラベルとは**必ず別**にする。 */
const HKDF_INFO = 'driving-school/application-idempotency/v1'
const HKDF_SALT = 'driving-school/application-idempotency/salt/v1'
const DERIVED_KEY_LENGTH = 32

/** SHA-256 の hex 表現の長さ。 */
const HASH_HEX_LENGTH = 64

function deriveKey(secret: string): Uint8Array {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, DERIVED_KEY_LENGTH))
}

/**
 * `sid` から `Application.sessionIdHash` に保存する値を導く。
 * **小文字 hex 固定**（申し送り T-Q5。比較の中に `toLowerCase()` を入れないため）。
 */
export function deriveSessionIdHash(sid: string, secret: string): string {
  return createHmac('sha256', deriveKey(secret)).update(sid, 'utf8').digest('hex')
}

/**
 * 保存済みハッシュと受信 Cookie の `sid` が一致するか。**定数時間比較**。
 *
 *  - `storedHash` が `null` / `undefined` / 空文字は**必ず不一致**。マイグレーション直後の
 *    既存行はすべて `null` であり、ここを「誰でも一致」に倒すと**移行期間中は誰でも他人の
 *    受付番号を引ける**（AC-010-4 が名指しで禁じている状態）。
 *  - **長さが違うバッファを `timingSafeEqual` に渡すと `RangeError` を投げる**（SEC-042 と同型）。
 *    DB の値が壊れている場合や攻撃者が別経路で短い値を書けた場合に未認証の第三者が 500 を
 *    起こせるため、比較前にバイト長で弾く（長さは秘密ではない）。
 */
export function sessionIdMatches(
  storedHash: string | null | undefined,
  sid: string | null | undefined,
  secret: string,
): boolean {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false
  if (typeof sid !== 'string' || sid.length === 0) return false

  const stored = Buffer.from(storedHash, 'utf8')
  // 期待値は常に 64 バイトの小文字 hex。長さが違う時点で不一致（比較へ入れない）。
  if (stored.length !== HASH_HEX_LENGTH) return false

  const expected = Buffer.from(deriveSessionIdHash(sid, secret), 'utf8')
  if (stored.length !== expected.length) return false
  return timingSafeEqual(stored, expected)
}
