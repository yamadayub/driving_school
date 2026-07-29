/**
 * 受付番号の発番（AC-010-5 / SPEC-013 / RV-P3D-N01）。**ULID を採る。**
 *
 * ------------------------------------------------------------------------
 * なぜ日次連番（`YYYYMMDD-NNNN`）を採らないのか
 * ------------------------------------------------------------------------
 * 受付番号は完了画面に表示され、利用者の手元に残り、問い合わせ時に読み上げられる。
 * 日次連番だと **1枚の受付番号からその日の受付件数（＝教習所の受注状況）が第三者に分かる**。
 * さらに連番は他人の受付番号を推測可能にするため、F-017 / F-018 が将来 `receiptNumber` を
 * 参照キーにした瞬間 IDOR へ直結する。
 *
 * ------------------------------------------------------------------------
 * monotonic モードを実装しない理由
 * ------------------------------------------------------------------------
 * ULID 仕様の monotonic モードは同一ミリ秒内でランダム部を +1 する。これは
 * 「同一ミリ秒の発番列が必ず昇順に並ぶ」ことを意味し、**連番から件数を推測できる性質が戻る**。
 * ミリ秒粒度の時刻順ソート（受信管理の並び）は monotonic 無しでも成立するため採らない。
 */

import { randomBytes } from 'node:crypto'

/** ULID の文字数（タイムスタンプ 10 + ランダム 16）。 */
export const RECEIPT_NUMBER_LENGTH = 26

/** タイムスタンプ部の文字数（48bit / 5bit = 10 文字）。 */
const TIME_LENGTH = 10

/** ランダム部のバイト数（80bit）と文字数（80bit / 5bit = 16 文字）。 */
const RANDOM_BYTES = 10
const RANDOM_LENGTH = 16

/** Crockford Base32（ULID 仕様）。`I` `L` `O` `U` を含まない（誤読・卑語の回避）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface GenerateReceiptNumberOptions {
  /** epoch ms。省略時は `Date.now()`。 */
  now?: number
  /** 乱数源。省略時は `node:crypto` の CSPRNG。テストは決定的な実装を注入する。 */
  randomBytes?: (size: number) => Uint8Array
}

function encodeTime(now: number): string {
  let remaining = Math.max(0, Math.floor(now))
  let out = ''
  for (let index = 0; index < TIME_LENGTH; index++) {
    out = CROCKFORD[remaining % 32] + out
    remaining = Math.floor(remaining / 32)
  }
  return out
}

/** 10 バイト（80bit）をちょうど 16 文字へ詰める（端数が出ない組み合わせ）。 */
function encodeRandom(bytes: Uint8Array): string {
  let buffer = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(buffer >>> bits) & 31]
    }
  }
  return out
}

/**
 * ULID を1つ発番する。
 *
 * 先頭 10 文字はミリ秒精度のタイムスタンプ（辞書順＝時刻順）、残り 16 文字は 80bit の乱数。
 * **日付を人間可読な形で埋め込まない**（`createdAt` が受付日を持つ。RV-P3D-N03）。
 */
export function generateReceiptNumber(options: GenerateReceiptNumberOptions = {}): string {
  const now = options.now ?? Date.now()
  const source = options.randomBytes ?? ((size: number) => new Uint8Array(randomBytes(size)))
  const random = source(RANDOM_BYTES)
  const encoded = `${encodeTime(now)}${encodeRandom(random).slice(0, RANDOM_LENGTH)}`
  return encoded
}
