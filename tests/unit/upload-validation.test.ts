import { describe, it, expect } from 'vitest'
import {
  MAX_LICENSE_PHOTO_BYTES,
  detectImageType,
  isDeclaredSizeAcceptable,
  matchesDeclaredContentType,
} from '@/lib/upload-validation'

/**
 * =========================================================================
 * P3-c2 — **AC-009-3 / AC-009-4 / E-009-1 / E-009-2 / E-009-5**:
 *          マジックバイトによる実体検証と、サイズ上限のサーバー強制
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` F-009 AC-009-3（:662）/ AC-009-4（:663）、
 *       異常系表 E-009-1・E-009-2・E-009-5（:571-577）、境界値表（:581-583）。
 *
 * ## AC-009-3 が禁じていること（原文）
 * > **拡張子・申告 Content-Type のみの判定は不可**。
 * > 「Content-Type: image/jpeg を申告した実体 HTML/SVG/ZIP が拒否され削除される」ことを検証
 *
 * ## なぜ実体検証が要るのか
 * 署名付き PUT はストレージへ**直接**行われるため、
 * **サーバーはバイト列を一度も見ないまま格納が完了する**（AC-009-5 が
 * 「発行数の制限が唯一の帯域防御」と書いているのはこの構造のため）。
 * したがって「何が入ったか」は**格納後に読んで確かめる以外に知る方法がない**。
 *
 * 申告 `contentType` は攻撃者が自由に決められる。実体が
 *  - **HTML** なら、F-018 の閲覧経路で `text/html` として解釈されると **XSS**
 *  - **SVG** なら `<script>` を含められる（`ALLOWED_IMAGE_CONTENT_TYPES` から除外済みだが、
 *    **`image/jpeg` を申告した SVG** は形式検査を素通りする）
 *  - **ZIP / 実行ファイル**なら、当校のストレージが**任意ファイルの配布置き場**になる
 *
 * ## red 理由
 * `lib/upload-validation.ts` が存在しない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/upload-validation.ts
 * export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | null
 *
 * /** 先頭バイト列から**実体**を判定する。判定できなければ null。 *\/
 * export function detectImageType(prefix: Uint8Array): DetectedImageType
 *
 * /** 申告 contentType と実体が一致するか（実体が判定できなければ false）。 *\/
 * export function matchesDeclaredContentType(declared: string, prefix: Uint8Array): boolean
 *
 * /** 発行時の申告サイズ検査（AC-009-4(a)）。1B 以上・上限以下のみ true。 *\/
 * export function isDeclaredSizeAcceptable(size: unknown): boolean
 * ```
 *
 * **判定に必要な先頭バイト数は 12**（WebP の `RIFF....WEBP` が最長）。
 * `readPrefix(objectKey, 12)` で足りることを前提にしている。
 */

/** JPEG: `FF D8 FF` */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
/** PNG: `89 50 4E 47 0D 0A 1A 0A` */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
/** WebP: `RIFF` + 4 バイトのサイズ + `WEBP` */
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 実体は HTML だが `image/jpeg` を申告する、という典型的な攻撃入力。 */
const HTML = bytesOf('<html><script>alert(1)</script>')
const SVG = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script/>')
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00])
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00])

/* ========================================================================= *
 * AC-009-3 (1): 正しい実体を通す
 * ========================================================================= */

describe('AC-009-3: マジックバイトで JPEG / PNG / WebP を判定する', () => {
  it('JPEG / PNG / WebP をそれぞれ正しく判定する', () => {
    expect(detectImageType(JPEG)).toBe('image/jpeg')
    expect(detectImageType(PNG)).toBe('image/png')
    expect(detectImageType(WEBP)).toBe('image/webp')
  })

  it('WebP は RIFF と WEBP の両方を見る（RIFF だけでは通さない）', () => {
    // `RIFF` は WAV / AVI でも使われるコンテナ署名である。
    // これが green なら排除される実装: `RIFF` だけを見て**音声・動画ファイルを通す**こと。
    const riffWave = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, // "WAVE"
    ])
    expect(detectImageType(riffWave)).toBeNull()
  })

  it('申告 contentType と実体が一致すれば true', () => {
    expect(matchesDeclaredContentType('image/jpeg', JPEG)).toBe(true)
    expect(matchesDeclaredContentType('image/png', PNG)).toBe(true)
    expect(matchesDeclaredContentType('image/webp', WEBP)).toBe(true)
  })
})

/* ========================================================================= *
 * AC-009-3 (2): **偽装された実体を落とす**（本ファイルの中心）
 * ========================================================================= */

describe('AC-009-3 / E-009-5: 申告 image/jpeg の実体が画像でなければ拒否する', () => {
  it.each([
    ['HTML', HTML],
    ['SVG', SVG],
    ['ZIP', ZIP],
    ['ELF（実行ファイル）', ELF],
  ])('実体が %s なら image/jpeg を申告しても拒否する', (_label, prefix) => {
    // **本ファイルで最も重要なテスト。AC-009-3 が名指しで要求した検証である。**
    // これが green なら排除される攻撃:
    //  (a) 実体 HTML を格納し、F-018 の閲覧で `text/html` 解釈されて **XSS**（管理者のセッションが対象）
    //  (b) 実体 SVG を `image/jpeg` と申告して形式検査を素通りさせる（SVG は `<script>` を含められる）
    //  (c) 当校のストレージを**任意ファイルの配布置き場**にする
    // 署名付き PUT はストレージへ直接行われ、**サーバーはバイト列を一度も見ないまま格納が完了する**。
    // したがって申告値の検査だけでは何も防げない。
    expect(detectImageType(prefix)).toBeNull()
    expect(matchesDeclaredContentType('image/jpeg', prefix)).toBe(false)
  })

  it('実体は画像だが申告と違う形式なら拒否する（PNG を jpeg と申告）', () => {
    // 実体が画像でも申告と食い違えば拒否する。
    // 食い違いを許すと、**保存された `contentType` が実体と異なる**まま F-018 が配信し、
    // ブラウザの content sniffing 次第で解釈が変わる。
    expect(matchesDeclaredContentType('image/jpeg', PNG)).toBe(false)
    expect(matchesDeclaredContentType('image/png', JPEG)).toBe(false)
  })

  it('先頭が足りない / 空でも例外にならず false', () => {
    // 攻撃者は 0 バイトのオブジェクトを置ける。**例外は失敗ではなく劣化にする**
    //（未認証の第三者が任意に 500 を起こせる経路を作らない / SEC-042 と同型）。
    for (const prefix of [new Uint8Array(0), new Uint8Array([0xff]), new Uint8Array([0xff, 0xd8])]) {
      expect(() => detectImageType(prefix)).not.toThrow()
      expect(detectImageType(prefix)).toBeNull()
      expect(matchesDeclaredContentType('image/jpeg', prefix)).toBe(false)
    }
  })

  it('許可外の申告（image/svg+xml / text/html）は実体が何であれ false', () => {
    // 二重の網: 形式リストと実体判定の**両方**を通ること。
    expect(matchesDeclaredContentType('image/svg+xml', SVG)).toBe(false)
    expect(matchesDeclaredContentType('text/html', HTML)).toBe(false)
    // 実体が正しい JPEG でも、申告が許可外なら通さない。
    expect(matchesDeclaredContentType('application/octet-stream', JPEG)).toBe(false)
  })

  it('パラメータ付き Content-Type（charset 等）でも判定が壊れない', () => {
    // `image/jpeg; charset=binary` のような値は実在する。
    expect(matchesDeclaredContentType('image/jpeg; charset=binary', JPEG)).toBe(true)
    // 大文字・空白のゆれも吸収する。
    expect(matchesDeclaredContentType('  IMAGE/JPEG  ', JPEG)).toBe(true)
  })
})

/* ========================================================================= *
 * AC-009-4 (a): 発行時の申告サイズ検査
 * ========================================================================= */

describe('AC-009-4(a) / E-009-2: 発行時に申告サイズを検証する', () => {
  it('境界: 1B は通り、0B は通らない', () => {
    expect(isDeclaredSizeAcceptable(1)).toBe(true)
    expect(isDeclaredSizeAcceptable(0)).toBe(false)
  })

  it('境界: ちょうど 5,242,880 B は通り、+1B は通らない', () => {
    // 境界値表の確定値。**リテラルの二重管理をしない**ため定数から式を組む。
    expect(isDeclaredSizeAcceptable(MAX_LICENSE_PHOTO_BYTES)).toBe(true)
    expect(isDeclaredSizeAcceptable(MAX_LICENSE_PHOTO_BYTES + 1)).toBe(false)
  })

  it('数値でない / 負 / 非整数 / Infinity / NaN はすべて false', () => {
    // 申告値は攻撃者が完全に制御する。**判定できないものを「上限内」と見なさない。**
    // これが green なら排除される実装: `size <= MAX` だけを見て
    // `size: "abc"`（NaN 比較で false になるので偶然通らない）や
    // `size: -1`（通ってしまう）を素通りさせること。
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1024', null, undefined, {}]) {
      expect(isDeclaredSizeAcceptable(value), `size=${JSON.stringify(value)}`).toBe(false)
    }
  })
})

/* ========================================================================= *
 * AC-009-4 (b): 「申告だけでは足りない」ことの明示
 * ========================================================================= */

describe('AC-009-4(b): 申告サイズの検査は格納後の再検証を代替しない', () => {
  it('申告 1MB でも実サイズ 6MB なら受け入れてはならない（判定の材料が別であることの固定）', () => {
    // AC-009-4 の原文: 「**申告値のみの検証では不可**。
    // 『申告 1MB・実体 6MB』が拒否・削除されることを検証」。
    //
    // 本ファイルは純関数しか持たないので、ここでは
    // **「申告が通ること」と「実体が通ること」が別の判定である**ことだけを固定する。
    // 実サイズの再取得と削除までを通した検証は
    // `tests/integration/uploads-license.int.ts`（本番経路）が受け持つ。
    const declared = 1_048_576
    const actual = 6_291_456

    expect(isDeclaredSizeAcceptable(declared), '申告値は上限内である').toBe(true)
    expect(
      isDeclaredSizeAcceptable(actual),
      '実サイズは上限外である（＝ 申告値の検査だけでは通ってしまう）',
    ).toBe(false)
  })
})
