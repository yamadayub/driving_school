/**
 * アップロードされた実体の検証（AC-009-3 / AC-009-4）。
 *
 * ------------------------------------------------------------------------
 * なぜ「実体」を見なければならないのか（構造上の理由）
 * ------------------------------------------------------------------------
 * 署名付き PUT はストレージへ**直接**行われるため、
 * **サーバーはバイト列を一度も見ないまま格納が完了する**
 *（AC-009-5 が「発行数の制限が唯一の帯域防御」と書いているのはこの構造のため）。
 * したがって「何が入ったか」は**格納後に読んで確かめる以外に知る方法がない。**
 *
 * AC-009-3 の原文は手段まで名指しで禁じている:
 *
 * > **拡張子・申告 Content-Type のみの判定は不可**。
 *
 * 申告 `contentType` は攻撃者が自由に決められる。実体が
 *  - **HTML** なら F-018 の閲覧経路で `text/html` 解釈されて **XSS**（対象は管理者のセッション）
 *  - **SVG** なら `<script>` を含められる（`image/jpeg` を申告した SVG は形式検査を素通りする）
 *  - **ZIP / 実行ファイル**なら当校のストレージが**任意ファイルの配布置き場**になる
 *
 * ------------------------------------------------------------------------
 * ⚠️ 残余: polyglot は先頭 12 バイト検証では検出できない
 * ------------------------------------------------------------------------
 * `FF D8 FF` で始まり後続に ZIP / 実行ファイルを連結したファイルは本検証を**通る**。
 * **これは手法の限界であって設計の誤りではない。** 補償は 3 つ:
 *  (a) バケットは非公開で、到達は署名付き URL 経由のみ（`objectKey` は推測不能）
 *  (b) **保存する `contentType` は申告値ではなく検出結果に固定する**（呼び出し側の責務）
 *  (c) **F-018 の閲覧経路で `X-Content-Type-Options: nosniff` と
 *      `Content-Disposition: attachment` を付ける** — **F-018 への持ち越し条件**
 *
 * > ⚠️ **(c) は P3-c2 のスコープ外である。F-018 の着手時に本コメントを読むこと。**
 */

/*
 * ⚠️ **このモジュールは Node 専用 API に依存してはならない（クライアントからも import される）。**
 *
 * `components/apply/LicensePhotoUpload.tsx` が**同じ判定関数**を使ってローカル検証を行う
 *（AC-RL-8: 判定ロジックを複製しない）。以前は定数を `@/lib/storage` から import していたが、
 * そちらは `node:fs/promises` を読むため**クライアントバンドルに入れられない**。
 * したがって**定数の正典はこのファイル**に置き、`lib/storage.ts` が逆に再 export する。
 */

/** 免許証写真のサイズ上限（バイト）。境界値表の確定値。 */
export const MAX_LICENSE_PHOTO_BYTES = 5_242_880

/**
 * 許可する申告 Content-Type。**`image/svg+xml` を絶対に含めないこと。**
 * SVG は `<script>` を含められるため、閲覧側（F-018）で XSS になる。
 */
export const ALLOWED_IMAGE_CONTENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
]

export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | null

/**
 * 判定に必要な先頭バイト数。**WebP の `RIFF....WEBP` が最長**なので 12 で足りる。
 * `readPrefix(objectKey, MAGIC_BYTES_NEEDED)` で 5MB を読まずに済む。
 */
export const MAGIC_BYTES_NEEDED = 12

/** JPEG: `FF D8 FF` */
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
/** PNG: `89 50 4E 47 0D 0A 1A 0A` */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** WebP: `RIFF` (0-3) + サイズ (4-7) + `WEBP` (8-11) */
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]

function startsWith(prefix: Uint8Array, magic: number[], offset = 0): boolean {
  if (prefix.length < offset + magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (prefix[offset + i] !== magic[i]) return false
  }
  return true
}

/**
 * 先頭バイト列から**実体**を判定する。判定できなければ `null`。
 *
 * **例外を投げない。** 攻撃者は 0 バイトのオブジェクトを置けるので、
 * 先頭不足を失敗にすると未認証の第三者が任意に 500 を起こせる（SEC-042 と同型）。
 */
export function detectImageType(prefix: Uint8Array): DetectedImageType {
  if (!(prefix instanceof Uint8Array) || prefix.length === 0) return null

  if (startsWith(prefix, JPEG_MAGIC)) return 'image/jpeg'
  if (startsWith(prefix, PNG_MAGIC)) return 'image/png'
  // ⚠️ **`RIFF` だけで判定しない。** `RIFF` は WAV / AVI のコンテナ署名でもあるため、
  // 先頭 4 バイトだけを見ると**音声・動画ファイルを通す**。8 バイト目からの `WEBP` も見る。
  if (startsWith(prefix, RIFF_MAGIC) && startsWith(prefix, WEBP_MAGIC, 8)) return 'image/webp'

  return null
}

/**
 * 申告 `contentType` から媒体型だけを取り出す（`image/jpeg; charset=binary` → `image/jpeg`）。
 * パラメータ付きの値は実在するので、ここで落とすと**正規利用者が弾かれる**。
 */
function normalizeContentType(declared: string): string {
  if (typeof declared !== 'string') return ''
  return declared.split(';')[0].trim().toLowerCase()
}

/**
 * 申告 `contentType` と実体が一致するか。**実体が判定できなければ false。**
 *
 * 二重の網である:
 *  1. 申告が許可リストに載っていること（SVG / HTML / PDF をここで落とす）
 *  2. 実体の検出結果が申告と一致すること
 *
 * **実体が画像でも申告と食い違えば拒否する。** 食い違いを許すと、保存された `contentType` が
 * 実体と異なるまま F-018 が配信し、ブラウザの content sniffing 次第で解釈が変わる。
 */
export function matchesDeclaredContentType(declared: string, prefix: Uint8Array): boolean {
  const normalized = normalizeContentType(declared)
  if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(normalized)) return false
  const detected = detectImageType(prefix)
  return detected !== null && detected === normalized
}

/**
 * 発行時の申告サイズ検査（AC-009-4(a)）。**1B 以上・上限以下の整数のみ true。**
 *
 * ⚠️ **型も検査する。** 申告値は攻撃者が完全に制御するので、`size <= MAX` だけを見ると
 * `size: -1` が通る。**判定できないものを「上限内」と見なさない。**
 *
 * ⚠️ 本検査は**格納後の再検証を代替しない**（AC-009-4 の原文: 「申告値のみの検証では不可」）。
 * 「申告 1MB・実体 6MB」は `head()` で実サイズを取り直して初めて弾ける。
 */
export function isDeclaredSizeAcceptable(size: unknown): boolean {
  if (typeof size !== 'number') return false
  if (!Number.isInteger(size)) return false
  if (size < 1) return false
  return size <= MAX_LICENSE_PHOTO_BYTES
}
