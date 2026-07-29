/**
 * `uploadToken` の生成と照合（AC-009-6 / AC-009-7 / AC-009-10）。
 *
 * ------------------------------------------------------------------------
 * `uploadToken` は「未認証フローにおける唯一の認可材料」である
 * ------------------------------------------------------------------------
 * SPEC-011 の原文:
 *
 * > `uploadToken` は発行時に `objectKey` へバインドされた予測不能な単回使用トークンであり、
 * > **それを提示できること自体が「そのオブジェクトを発行させた本人である」ことの証明**になる。
 *
 * 認証が無い以上、これが破れると **IDOR** が直ちに成立する
 *（他人の免許証画像を自分の申込へ紐付ける / 他人のオブジェクトを削除する）。
 *
 * ------------------------------------------------------------------------
 * サーバーは受け取った `objectKey` を信頼しない（AC-009-10）
 * ------------------------------------------------------------------------
 * > サーバーは受け取った `objectKey` を信頼せず、**`uploadToken` から DB を引いて
 * > バインド済みの `objectKey` に対してのみ**削除を実行する。
 * > クライアント指定の `objectKey` は**照合にのみ**使い、不一致なら 403。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * `uploadToken` の有効期限（秒）。SPEC-003 の確定値。
 *
 * **署名付き PUT URL（300 秒）とは別物である。** token のほうが長いのは、
 * **署名 URL が失効した後も申込を送れるようにする**ためである。
 */
export const UPLOAD_TOKEN_EXPIRES_IN_SEC = 600

/** トークンの乱数バイト数。hex で 48 文字 = 192bit（≥128bit の要求を満たす）。 */
const TOKEN_RANDOM_BYTES = 24

/** 目視で用途が分かる接頭辞（値そのものは乱数部だけが担う）。 */
const TOKEN_PREFIX = 'ut_'

export interface UploadTokenRecord {
  token: string
  objectKey: string
  contentType: string
  maxSize: number
  consumed: boolean
  expiresAt: Date
}

export interface CreateUploadTokenParams {
  objectKey: string
  contentType: string
  maxSize: number
  now?: number
}

/**
 * 予測不能なトークンと有効期限を作る。
 *
 * ⚠️ **`objectKey` をトークンに埋め込まない。**
 * `token = objectKey + 署名` のような形にすると、**トークンから `objectKey` が読める**——
 * ログにトークンが出た時点で `objectKey` も漏れる（AC-PII-1 は両方を禁止項目にしている）。
 * バインドは**DB 行**（`UploadToken.objectKey`）で保持し、トークン自体は純粋な乱数にする。
 */
export function createUploadToken(params: CreateUploadTokenParams): {
  token: string
  expiresAt: Date
} {
  const now = params.now ?? Date.now()
  return {
    token: `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('hex')}`,
    expiresAt: new Date(now + UPLOAD_TOKEN_EXPIRES_IN_SEC * 1000),
  }
}

/**
 * 文字列の定数時間比較。長さが違う場合は比較が成立しないので先に弾く（長さは秘密ではない）。
 *
 * **バイト長で判定する**（`String.prototype.length` は UTF-16 コードユニット数で、
 * `timingSafeEqual` が見る UTF-8 バイト数とずれる）。ずれたまま比較へ入ると `RangeError` になり、
 * **未認証の攻撃者が任意に 500 を起こせる**（SEC-042 / `lib/form-session.ts` と同じ形）。
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 提示された `(token, objectKey)` が使える組み合わせかを判定する**純関数**。
 *
 * ⚠️ **`boolean` しか返さない。理由を返さない。**
 * AC-009-7 の原文:
 *
 * > **エラーメッセージは汎用文言**で、どの条件で失敗したか
 * > （未存在 / 期限切れ / 消費済み / 不一致）を区別できない（列挙攻撃の防止）
 *
 * 呼び出し側が `reason` で分岐できると、**応答が分かれるのは時間の問題**である。
 * `lib/public-guard.ts` が Tier B の本文を 1 つに固定したのと同じ判断——
 * **判定基準をボットに教えない。** したがってシグネチャ自体を `boolean` に固定する。
 *
 * ⚠️ **例外を投げない。** 材料はすべて攻撃者が制御する（SEC-042）。
 */
export function verifyUploadTokenBinding(
  record: UploadTokenRecord | null,
  presented: { token: string; objectKey: string },
  now: number,
): boolean {
  try {
    if (record === null || typeof record !== 'object') return false
    if (typeof presented !== 'object' || presented === null) return false

    // 提示トークンとレコードの token が一致すること
    //（「`objectKey` で引いた行」を渡す実装を弾く）。
    if (!constantTimeEquals(record.token, presented.token)) return false

    // **バインドの照合そのもの（IDOR 本体）。**
    // 自分のトークンに他人の `objectKey` を組み合わせる攻撃をここで落とす。
    if (!constantTimeEquals(record.objectKey, presented.objectKey)) return false

    // 単回使用（AC-009-6）。消費済みなら「未存在」と同じ false。
    if (record.consumed === true) return false

    // 期限（境界: **ちょうど期限は有効**、1ms 超えたら無効）。
    const expiresAt = record.expiresAt instanceof Date ? record.expiresAt.getTime() : Number.NaN
    if (!Number.isFinite(expiresAt)) return false
    if (typeof now !== 'number' || !Number.isFinite(now)) return false
    if (now > expiresAt) return false

    return true
  } catch {
    // 判定に到達できなかった場合も**失敗ではなく劣化**として false を返す。
    return false
  }
}
