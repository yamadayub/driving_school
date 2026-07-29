import { describe, it, expect } from 'vitest'
import { RECEIPT_NUMBER_LENGTH, generateReceiptNumber } from '@/lib/receipt-number'

/**
 * =========================================================================
 * P3-b — AC-010-5 / SPEC-013 / RV-P3D-N01: `receiptNumber` は ULID
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-5（:788）/ `Application.receiptNumber`（:808）、
 *       `docs/ui-design/form-submission.md` §6（完了画面は ULID 26文字前提）。
 *
 * > **`receiptNumber` は ULID を既定とする**（日次連番 `'YYYYMMDD-NNNN'` は採らない）。
 * > ユニットテストで「連続して発番した2つの `receiptNumber` から当日の受付件数を推測できない
 * > （単調増加する連番部分を持たない）」ことを検証する。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/receipt-number.ts
 * export const RECEIPT_NUMBER_LENGTH = 26
 * /** ULID。乱数源は注入可能（決定的テストのため）。 *\/
 * export function generateReceiptNumber(options?: {
 *   now?: number
 *   randomBytes?: (size: number) => Uint8Array
 * }): string
 * ```
 *
 * ## なぜ「連番でない」ことが受け入れ条件なのか
 * 受付番号は**完了画面に表示され、利用者の手元に残り、問い合わせ時に読み上げられる**。
 * 日次連番だと 1枚の受付番号から「その日に何件申し込みがあったか」＝**教習所の受注状況**が
 * 第三者に分かる。加えて連番は**他人の受付番号を推測可能**にするため、F-017 / F-018 の
 * 参照経路が将来 `receiptNumber` を鍵にした瞬間に IDOR へ直結する。
 */

/** Crockford Base32（ULID 仕様）。`I` `L` `O` `U` を含まない。 */
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 決定的な乱数源（全バイト同値）。ランダム部が本当に乱数由来かを見るために使う。 */
function constantBytes(value: number): (size: number) => Uint8Array {
  return (size) => new Uint8Array(size).fill(value)
}

describe('AC-010-5 / SPEC-013: 形式が ULID である', () => {
  it('26文字の Crockford Base32 である', () => {
    // これが green なら排除される壊れた実装: `'YYYYMMDD-NNNN'`（SPEC-013 が明示的に却下した形）や
    // UUID（36文字・ハイフン入り）で発番する実装。UI（form-submission.md §6）は 26文字前提で
    // レイアウトしているため、形式が違うと完了画面の表示も崩れる。
    const value = generateReceiptNumber()
    expect(value).toHaveLength(RECEIPT_NUMBER_LENGTH)
    expect(RECEIPT_NUMBER_LENGTH).toBe(26)
    expect(value, `${value} が Crockford Base32 26文字でない`).toMatch(CROCKFORD)
  })

  it('日付文字列（YYYYMMDD / YYYY-MM-DD）を含まない', () => {
    // これが green なら排除される壊れた実装: 「ULID にしたうえで先頭に日付を足す」折衷案。
    // 受付日は `createdAt` が持つ（RV-P3D-N03）。番号に載せると当日の件数推測に戻る。
    const now = Date.UTC(2026, 6, 29, 3, 0, 0)
    const value = generateReceiptNumber({ now })
    expect(value).not.toMatch(/20260729|2026-07-29/)
  })

  it('タイムスタンプ部（先頭10文字）は同一ミリ秒なら同一になる（ULID の定義）', () => {
    // ULID であることの積極的な確認。ここが揺れる実装は ULID ではなく単なるランダム文字列で、
    // **時刻順ソートという ULID を選んだ理由（受信管理の並び）が失われている**。
    const now = Date.UTC(2026, 6, 29, 3, 0, 0)
    const a = generateReceiptNumber({ now, randomBytes: constantBytes(1) })
    const b = generateReceiptNumber({ now, randomBytes: constantBytes(2) })
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a.slice(10), 'ランダム部は乱数源が違えば変わる').not.toBe(b.slice(10))
  })
})

describe('AC-010-5: 連続発番した2つから当日の受付件数を推測できない', () => {
  it('同一ミリ秒で 200件発番しても、辞書順に単調増加しない', () => {
    // **本ファイルの中心テスト。**
    // これが green なら排除される攻撃: 受付番号を1つ手に入れた第三者が、
    // 連番部分の差分から**その日の受付件数（＝教習所の受注状況）を読み取る**こと。
    // 単調増加する連番実装（日次連番・カウンタ付き ULID の monotonic モード）は、
    // 同一ミリ秒で発番すると**必ず昇順に並ぶ**ためここで落ちる。
    // 乱数由来なら 200件が偶然昇順に並ぶ確率は事実上ゼロ（1/200! 相当）。
    const now = Date.UTC(2026, 6, 29, 3, 0, 0)
    const values = Array.from({ length: 200 }, () => generateReceiptNumber({ now }))
    const sorted = [...values].sort()
    expect(values, '同一ミリ秒の発番列が昇順に並んでいる = 単調増加する連番部分を持つ').not.toEqual(
      sorted,
    )
  })

  it('同一ミリ秒で 200件発番しても重複しない（一意制約違反で受付が落ちない）', () => {
    // これが green なら排除される壊れた実装: ランダム部のエントロピーが不足し、
    // **同日大量送信で `receiptNumber` の一意制約に衝突して受付が 500 になる**形（AC-010-5）。
    const now = Date.UTC(2026, 6, 29, 3, 0, 0)
    const values = new Set(Array.from({ length: 200 }, () => generateReceiptNumber({ now })))
    expect(values.size).toBe(200)
  })

  it('ランダム部は 80bit ぶんの桁（16文字）を占め、固定値になっていない', () => {
    // これが green なら排除される壊れた実装: ランダム部を実装せず 0 埋めし、
    // 実質「時刻だけ」の番号にすること（同一ミリ秒で必ず衝突し、かつ推測可能になる）。
    const now = Date.UTC(2026, 6, 29, 3, 0, 0)
    const randoms = new Set(
      Array.from({ length: 100 }, () => generateReceiptNumber({ now }).slice(10)),
    )
    expect(randoms.size, 'ランダム部が固定値になっている').toBeGreaterThan(90)
    for (const random of randoms) expect(random).toHaveLength(16)
  })

  it('10,000件でも衝突しない（実運用の規模で一意制約が破れない）', () => {
    const values = new Set(Array.from({ length: 10_000 }, () => generateReceiptNumber()))
    expect(values.size).toBe(10_000)
  })
})

describe('AC-010-5: 時刻を注入できる（テストが実時間に依存しない）', () => {
  it('now を渡さなければ現在時刻を使う（形式は変わらない）', () => {
    expect(generateReceiptNumber()).toMatch(CROCKFORD)
  })

  it('異なる時刻ではタイムスタンプ部が単調増加する（受信管理の時刻順ソート）', () => {
    const base = Date.UTC(2026, 6, 29, 3, 0, 0)
    const earlier = generateReceiptNumber({ now: base, randomBytes: constantBytes(0) })
    const later = generateReceiptNumber({ now: base + 1000, randomBytes: constantBytes(0) })
    expect(later > earlier, '時刻が進めば辞書順も進む（ULID の性質）').toBe(true)
  })
})
