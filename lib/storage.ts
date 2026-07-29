/**
 * ストレージ抽象（tech-stack §2.1「将来 S3/R2 へ移行可能な lib/storage 抽象を保つ」）。
 *
 * ------------------------------------------------------------------------
 * なぜアダプタ構成なのか（P3-c2 の設計前提）
 * ------------------------------------------------------------------------
 * P3-b までの本モジュールは Vercel Blob 直結を前提にした 38 行のスタブ（3 関数すべて `throw`）だった。
 * そのままだと**テストを書くのに外部アカウントが要る**——結果として
 * **unit / integration / E2E のどれも `uploads` の防御を一度も通らないまま P3-c2 が「完了」する。**
 * 最も機微なデータ（免許証画像）を扱う経路でそれは受け入れられない。
 *
 * KV（`memory://` 縮退 / `lib/runtime-stores.ts`）と Postgres（ローカル Docker）が
 * 既に同じ形を採っている。**ローカル実装で unit / integration / E2E が完走できること**を前提にする。
 */

import { randomBytes, createHash } from 'node:crypto'
import { mkdir, rm, stat, writeFile, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/* ------------------------------------------------------------------------- *
 * 確定値（SPEC-003 / 境界値表）
 * ------------------------------------------------------------------------- */

/** 署名付き PUT / GET URL の有効期限（秒）。SPEC-003 の確定値。 */
export const UPLOAD_URL_EXPIRES_IN_SEC = 300

/*
 * サイズ上限と許可形式の**正典は `lib/upload-validation.ts`** に置いてある。
 * クライアント（`components/apply/LicensePhotoUpload.tsx`）が同じ判定を使うため、
 * `node:fs` に依存する本ファイルへ置くとクライアントバンドルに入れられない。
 * 従来の import 位置（`@/lib/storage`）を壊さないよう、ここから再 export する。
 */
export {
  MAX_LICENSE_PHOTO_BYTES,
  ALLOWED_IMAGE_CONTENT_TYPES,
} from '@/lib/upload-validation'

/**
 * `uploads` 発行 API の Cookie 軸上限（1 Cookie / 10 分）。
 *
 * **下界**: F-009 の境界値表「1 申込あたりの最悪ケース（写真 2 枚 ×（初回 1 + 再発行 3））= 8 回」を
 * **上回る**こと。
 * **上界**: その 2 倍（16）を超えないこと（MF-2 / テスト設計 §11.5-2）。
 * 上限は無コスト枠（10 枚）と**掛け算**になるので、緩めると攻撃面がそのまま倍になる
 * ——それ以上の余裕は**攻撃者の枠を広げるだけで正規利用者を助けない**。
 *
 * ⚠️ **`tests/integration/uploads-cost.int.ts` がこの定数を import して
 * `8 < UPLOADS_FORM_SESSION_LIMIT <= 16` を固定している。** 数値を動かすと赤くなる。
 */
export const UPLOADS_FORM_SESSION_LIMIT = 12

/** `uploads` 発行 API の発信元軸上限（10 分）。縮退では計数のみ。 */
export const UPLOADS_SOURCE_LIMIT = 60

/** レート制限のウィンドウ（ms）。申込側（`RATE_WINDOW_MS`）と揃える。 */
export const UPLOADS_RATE_WINDOW_MS = 600_000

/* ------------------------------------------------------------------------- *
 * 型
 * ------------------------------------------------------------------------- */

export interface SignedUploadTarget {
  uploadUrl: string
  /** ★サーバー生成。クライアントは指定不可（AC-009-1 / REV-004）。 */
  objectKey: string
  expiresIn: number
}

export interface CreateUploadParams {
  side: 'front' | 'back'
  contentType: string
  size: number
}

export interface StorageAdapter {
  createSignedUpload(params: CreateUploadParams): Promise<SignedUploadTarget>
  createSignedReadUrl(
    objectKey: string,
    expiresInSeconds?: number,
  ): Promise<{ url: string; expiresIn: number }>
  deleteObject(objectKey: string): Promise<void>
  /**
   * 格納後の実サイズを取得する（AC-009-4(b)）。**存在しなければ `null`。例外にしない。**
   * 攻撃者は任意のキーを送れるので、「存在しない」を失敗にすると
   * 未認証の第三者が任意に 500 を起こせる（SEC-042 / SEC-060 と同型）。
   */
  head(objectKey: string): Promise<{ size: number } | null>
  /**
   * 先頭 n バイト**だけ**を読む（AC-009-3）。**全体を読まない。**
   * `enforceBodyBytes`（SEC-059）と同じ原則を格納後の検証にも適用する
   * ——マジックバイト検証のために 5MB × 2 枚をメモリへ載せない。
   */
  readPrefix(objectKey: string, bytes: number): Promise<Uint8Array | null>
  /** ローカル実装のテスト用（署名付き PUT の代わりにバイトを置く）。 */
  put?(objectKey: string, body: Uint8Array, contentType: string): Promise<void>
}

/* ------------------------------------------------------------------------- *
 * objectKey の生成（AC-009-1 / AC-009-2）
 * ------------------------------------------------------------------------- */

/** キーの接頭辞。**`public` を含めない**（非公開バケットであることを名前でも示す / AC-009-8）。 */
const OBJECT_KEY_PREFIX = 'private/lic'

/** 乱数部のバイト数。hex で 32 文字 = 128bit（AC-009-2 の下限）。 */
const OBJECT_KEY_RANDOM_BYTES = 16

/**
 * **サーバーだけが生成する**非公開キー（AC-009-1 / AC-009-2）。
 *
 * ⚠️ **引数は `side` だけである。増やしてはならない。**
 * ファイル名・氏名・メールを材料にできる形にすると、
 * **利用者の個人情報がストレージキーとログに残る**（AC-PII-1 違反）。
 * 「含めない」を**型で**担保するために、そもそも受け取らない。
 *
 * ⚠️ **時刻を含めない。** 発行時刻から推測できるキーは、非公開バケットでも列挙の足がかりになる。
 * 連番も同じ理由で禁止（1 つ手に入れば全部読める）。
 */
export function generateObjectKey(side: 'front' | 'back'): string {
  const random = randomBytes(OBJECT_KEY_RANDOM_BYTES).toString('hex')
  return `${OBJECT_KEY_PREFIX}/${side}/${random}`
}

/* ------------------------------------------------------------------------- *
 * ローカルアダプタ（ファイルシステム）
 * ------------------------------------------------------------------------- */

/** 既定の格納先。**プロセス間で共有される固定パス**（結合テストとルートが同じ実体を見る）。 */
const DEFAULT_LOCAL_ROOT = join(tmpdir(), 'driving-school-storage')

/**
 * `objectKey` をファイルパスへ写す。**パストラバーサルをここで断つ。**
 *
 * `head` / `readPrefix` / `deleteObject` のキーは**攻撃者が完全に制御する**
 *（DELETE の照合前に呼ばれうる）。`..` やドライブ指定を含む値をそのまま join すると
 * バケット外の読み書きになるので、**安全な文字だけを残して 1 つのファイル名へ畳む。**
 */
function localPathFor(root: string, objectKey: string): string {
  const safe = objectKey.replace(/[^A-Za-z0-9/_-]/g, '_').replace(/\.{2,}/g, '_')
  const flattened = safe
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('__')
  return join(root, flattened.length > 0 ? flattened : '_empty')
}

export function createLocalStorageAdapter(options: { root?: string } = {}): StorageAdapter {
  const root = options.root ?? DEFAULT_LOCAL_ROOT

  async function ensureRoot(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
  }

  return {
    async createSignedUpload(params: CreateUploadParams): Promise<SignedUploadTarget> {
      // ⚠️ **`params` の `objectKey` は読まない**（型にも無い）。
      // クライアントが混入させても、返るのは常にサーバー生成値である（AC-009-1）。
      const objectKey = generateObjectKey(params.side)
      return {
        objectKey,
        // ローカル実装の「署名付き URL」。実体は `put()` で置く（テスト・E2E 用）。
        // **キー自体を URL に載せない**（漏えい経路を増やさない）ため不透明なハンドルにする。
        uploadUrl: `local-storage:${createHash('sha256').update(objectKey).digest('hex')}`,
        expiresIn: UPLOAD_URL_EXPIRES_IN_SEC,
      }
    },

    async createSignedReadUrl(objectKey: string, expiresInSeconds = UPLOAD_URL_EXPIRES_IN_SEC) {
      return {
        url: `local-storage:${createHash('sha256').update(objectKey).digest('hex')}`,
        expiresIn: expiresInSeconds,
      }
    },

    async deleteObject(objectKey: string): Promise<void> {
      // 存在しなくてもエラーにしない（べき等）。orphan 回収の再実行で落ちないため。
      await rm(localPathFor(root, objectKey), { force: true })
    },

    async head(objectKey: string): Promise<{ size: number } | null> {
      try {
        const info = await stat(localPathFor(root, objectKey))
        return { size: info.size }
      } catch {
        return null
      }
    },

    async readPrefix(objectKey: string, bytes: number): Promise<Uint8Array | null> {
      if (!Number.isInteger(bytes) || bytes <= 0) return null
      let handle
      try {
        handle = await open(localPathFor(root, objectKey), 'r')
      } catch {
        return null
      }
      try {
        // **要求バイト数ぶんのバッファしか確保しない**（ファイル全体を読まない）。
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
        return new Uint8Array(buffer.subarray(0, bytesRead))
      } catch {
        return null
      } finally {
        await handle.close()
      }
    },

    async put(objectKey: string, body: Uint8Array, _contentType: string): Promise<void> {
      const path = localPathFor(root, objectKey)
      await ensureRoot(path)
      await writeFile(path, body)
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Vercel Blob アダプタ
 * ------------------------------------------------------------------------- */

/**
 * Vercel Blob 実装。
 *
 * ⚠️ **実 Blob に対する実測は未実施である**（P3-c2 時点で Blob Store を作成していない）。
 * 本アダプタは `@vercel/blob` の API 形状に基づいて書いてあるが、
 * **「動作を確認した」とは記録できない。** ローカルアダプタと違い、
 * unit / integration / E2E のいずれもこの経路を通っていない。
 *
 * 有効化するには `BLOB_READ_WRITE_TOKEN` を設定する（`sharedStorage()` の分岐）。
 * **本番で使う前に、少なくとも put → head → readPrefix → delete の一巡を実機で確認すること。**
 */
export function createBlobStorageAdapter(): StorageAdapter {
  const token = process.env.BLOB_READ_WRITE_TOKEN

  async function blobUrl(objectKey: string): Promise<string | null> {
    const { head } = await import('@vercel/blob')
    try {
      const info = await head(objectKey, { token })
      return info.url
    } catch {
      return null
    }
  }

  return {
    async createSignedUpload(params: CreateUploadParams): Promise<SignedUploadTarget> {
      const objectKey = generateObjectKey(params.side)
      // クライアント直 PUT はハンドシェイク（`/api/uploads/handshake`）が要るため、
      // ここでは objectKey とパスだけを返す。**公開 URL は返さない**（AC-009-8）。
      return { objectKey, uploadUrl: `blob:${objectKey}`, expiresIn: UPLOAD_URL_EXPIRES_IN_SEC }
    },

    async createSignedReadUrl(objectKey: string, expiresInSeconds = UPLOAD_URL_EXPIRES_IN_SEC) {
      const url = (await blobUrl(objectKey)) ?? ''
      return { url, expiresIn: expiresInSeconds }
    },

    async deleteObject(objectKey: string): Promise<void> {
      const { del } = await import('@vercel/blob')
      const url = await blobUrl(objectKey)
      if (url === null) return
      await del(url, { token })
    },

    async head(objectKey: string): Promise<{ size: number } | null> {
      const { head } = await import('@vercel/blob')
      try {
        const info = await head(objectKey, { token })
        return { size: info.size }
      } catch {
        return null
      }
    },

    async readPrefix(objectKey: string, bytes: number): Promise<Uint8Array | null> {
      if (!Number.isInteger(bytes) || bytes <= 0) return null
      const url = await blobUrl(objectKey)
      if (url === null) return null
      try {
        // **Range 要求で先頭だけを取る**（5MB を毎回落とさない / AC-009-3 の前提）。
        const response = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}` } })
        if (!response.ok) return null
        const buffer = new Uint8Array(await response.arrayBuffer())
        return buffer.subarray(0, bytes)
      } catch {
        return null
      }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * 供給元（`lib/runtime-stores.ts` と同じ形）
 * ------------------------------------------------------------------------- */

let storageAdapter: StorageAdapter | null = null

/**
 * 実行環境に応じたアダプタを 1 つだけ作って共有する。
 *
 * ⚠️ **同一インスタンスを返すこと**（`tests/integration/uploads-license.int.ts` が
 * `head` / `readPrefix` を差し替えてルートの呼び出しを観測する）。
 */
export function sharedStorage(): StorageAdapter {
  storageAdapter ??= process.env.BLOB_READ_WRITE_TOKEN
    ? createBlobStorageAdapter()
    : createLocalStorageAdapter()
  return storageAdapter
}
