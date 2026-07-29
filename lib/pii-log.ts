/**
 * PII を出さないログ（AC-PII-1 / AC-010-7 / AC-RL-10）。
 *
 * ------------------------------------------------------------------------
 * なぜ「書く側の注意」ではなくラッパなのか
 * ------------------------------------------------------------------------
 * P3-a の教訓そのもの: **「警告をコメントに書く」ことは、呼び出し側が読まなければ機能しない**
 * （SEC-043 は名指しの警告コメントがあったのに 4 度再発した）。
 * `logger.warn('x', { error })` は最も自然な書き方であり、そのたびに例外メッセージ経由で
 * PII が流れる（Prisma / zod / Resend はいずれも入力値を例外メッセージに含める）。
 * ログ出力点は今後も増え続けるため、**通る場所を1つにして落とす**以外に手段がない。
 *
 * ------------------------------------------------------------------------
 * 落とすもの / 残すもの
 * ------------------------------------------------------------------------
 * 落とす: 氏名 / 氏名カナ / 生年月日 / 住所 / 郵便番号 / 電話 / メール / 免許取消歴 /
 *         現有免許 / ファイル名 / `objectKey` / 署名付き URL / **`sid` と `sessionIdHash`** /
 *         **ハニーポットの充填値**。
 * 残す:   `receiptNumber` / `applicationId` / `type` / `status` / エラーコード / 所要時間 /
 *         キーのハッシュ先頭 8 文字。
 *
 * **過剰な秘匿は運用不能を招く**ため、区別できることと漏らさないことを両立させる
 * （`toErrorLogFields` がすべてを `unknown` に潰さないのはこのため）。
 */

/**
 * ログへ出してはならないフィールド名（AC-PII-1 の列挙 + SPEC-012 / SPEC-017 の追加）。
 *
 * 一覧を定数として公開するのは、**仕様の列挙と突き合わせられるようにする**ためである。
 * 各ログ出力点に散らばっていると、1つ抜けても誰も気付かない。
 */
export const PII_DENY_KEYS: readonly string[] = [
  // 本人特定情報
  'name',
  'nameKana',
  'birthDate',
  'gender',
  'address',
  'buildingName',
  'postalCode',
  'phone',
  'email',
  'to',
  // 免許関連（機微情報）
  'licenseRevoked',
  'licenseRevokedNote',
  'currentLicenses',
  'licensePhotos',
  // ファイル / ストレージ
  'fileName',
  'filename',
  'objectKey',
  'signedUrl',
  'previewUrl',
  'uploadToken',
  // 資格情報的な値（SPEC-017）
  'sid',
  'sessionIdHash',
  'captchaToken',
  'cookie',
  'authorization',
  // ハニーポットの充填値（SPEC-012 / Designer I-5）
  'hp_field',
  // 自由記述（本文に個人情報が書かれうる）
  'message',
]

const DENY_SET = new Set(PII_DENY_KEYS.map((key) => key.toLowerCase()))

export interface AppLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** エラーコードとして出してよい形（値そのものを載せないための制限）。 */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * 例外をログ可能なフィールドへ落とす。**`message` も `stack` も返さない。**
 *
 * Prisma の一意制約違反は `Unique constraint failed on the fields: (...)` のように**値を含む**
 * メッセージを返す。それを `logger.error('db', { error })` でそのまま出すのが最も起きやすい漏えいである。
 */
export function toErrorLogFields(error: unknown): { errorCode: string } {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && ERROR_CODE_PATTERN.test(code)) {
      return { errorCode: code }
    }
    if (error instanceof Error && ERROR_CODE_PATTERN.test(error.name) && error.name !== 'Error') {
      return { errorCode: error.name }
    }
  }
  return { errorCode: 'UNKNOWN' }
}

/** 再帰の深さ上限。攻撃者が深い構造を送っても RangeError を起こさせない。 */
const MAX_DEPTH = 8

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
    return value
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint') return '[unloggable]'
  if (depth >= MAX_DEPTH) return '[depth]'

  const object = value as object
  if (seen.has(object)) return '[circular]'
  seen.add(object)

  // 例外オブジェクトはメッセージ・スタックを持つため、**必ずコードへ落とす**。
  // 「`toErrorLogFields` を使う」という規律が守られなかった場合の最後の網である。
  if (object instanceof Error) return toErrorLogFields(object)

  if (Array.isArray(object)) {
    return object.map((item) => sanitizeValue(item, seen, depth + 1))
  }

  if (!isPlainObject(object)) {
    // Date / Buffer / クラスインスタンス等。中身に何が入るか統制できないので載せない。
    return '[object]'
  }

  return sanitizeFields(object as Record<string, unknown>, seen, depth + 1)
}

function sanitizeFields(
  fields: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (DENY_SET.has(key.toLowerCase())) continue
    out[key] = sanitizeValue(value, seen, depth)
  }
  return out
}

/**
 * 禁止キーを**再帰的に**落として下流へ渡すラッパ。
 *
 * 実際のログ出力はほぼ必ず入れ子になる（`logger.info('x', { input })` と 1 段包むだけで
 * 全フィールドが素通りする）ため、トップレベルだけを見る実装では守れない。
 *
 * **ここで例外を投げてはならない**——ログは失敗経路で呼ばれるため、
 * 投げると「エラー処理中にエラー」になる。循環参照も含めて必ず値を返す。
 */
export function createPiiSafeLogger(sink: AppLogger): AppLogger {
  function scrub(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (fields === undefined || fields === null) return undefined
    try {
      return sanitizeFields(fields, new WeakSet<object>(), 0)
    } catch {
      return { errorCode: 'LOG_SANITIZE_FAILED' }
    }
  }

  return {
    info: (event, fields) => sink.info(event, scrub(fields)),
    warn: (event, fields) => sink.warn(event, scrub(fields)),
    error: (event, fields) => sink.error(event, scrub(fields)),
  }
}

/** `console` を sink にした既定ロガー（本番経路はこれを PII セーフラッパで包んで使う）。 */
export const consoleSink: AppLogger = {
  info: (event, fields) => console.info(event, fields ?? {}),
  warn: (event, fields) => console.warn(event, fields ?? {}),
  error: (event, fields) => console.error(event, fields ?? {}),
}
