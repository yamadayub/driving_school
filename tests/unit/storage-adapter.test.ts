import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  MAX_LICENSE_PHOTO_BYTES,
  UPLOAD_URL_EXPIRES_IN_SEC,
  createLocalStorageAdapter,
  generateObjectKey,
} from '@/lib/storage'

/**
 * =========================================================================
 * P3-c2 — **AC-009-1 / AC-009-2 / AC-009-8 / P3c-11**:
 *          `lib/storage.ts` のアダプタ化と `objectKey` の推測不可能性
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` F-009 AC-009-1（:660）/ AC-009-2（:661）/ AC-009-8（:669）、
 *       境界値表（:583-590）、`docs/security-audit.md` §F P3c-11（:3277）。
 *
 * ## red 理由
 * `lib/storage.ts` は **38 行のスタブ**であり、3 つの関数がいずれも `throw` する。
 * 定数（`UPLOAD_URL_EXPIRES_IN_SEC` 等）もアダプタも `generateObjectKey` も存在しない。
 *
 * ## なぜアダプタ構成にするのか（**オーケストレーターの設計決定**）
 * 現状のスタブは「Vercel Blob 実装」を前提に書かれているため、
 * **テストを書くには外部アカウントが要る**——それでは
 * unit / integration / E2E のいずれも `uploads` の防御を一度も通らないまま P3-c2 が終わる。
 *
 * KV（`memory://` で縮退 / `lib/runtime-stores.ts`）と Postgres（ローカル Docker）が
 * 既に同じ形を採っている。ストレージだけ例外にする理由はない:
 *
 * > **ローカル実装（ファイルシステム）と Vercel Blob 実装を同一インターフェースの裏に置き、
 * > unit / integration / E2E はローカル実装で完走できること。**
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/storage.ts
 * export const UPLOAD_URL_EXPIRES_IN_SEC = 300        // SPEC-003（確定）
 * export const UPLOAD_TOKEN_EXPIRES_IN_SEC = 600      // SPEC-003（確定）
 * export const MAX_LICENSE_PHOTO_BYTES = 5_242_880    // 境界値表（確定）
 * export const ALLOWED_IMAGE_CONTENT_TYPES: readonly string[]   // jpeg / png / webp
 *
 * export interface StorageAdapter {
 *   createSignedUpload(params: CreateUploadParams): Promise<SignedUploadTarget>
 *   createSignedReadUrl(objectKey: string, expiresInSeconds?: number): Promise<{ url: string; expiresIn: number }>
 *   deleteObject(objectKey: string): Promise<void>
 *   /** 格納後の実体検証に使う（AC-009-3 / AC-009-4(b)）。存在しなければ null。 *\/
 *   head(objectKey: string): Promise<{ size: number } | null>
 *   /** 先頭 n バイトだけを読む。**全体を読まない**（5MB をメモリに載せない）。 *\/
 *   readPrefix(objectKey: string, bytes: number): Promise<Uint8Array | null>
 * }
 *
 * export function createLocalStorageAdapter(options?: { root?: string }): StorageAdapter
 * export function createBlobStorageAdapter(): StorageAdapter
 * export function sharedStorage(): StorageAdapter    // `lib/runtime-stores.ts` と同じ形で選ぶ
 *
 * /** **サーバーだけが生成する** 非公開キー（AC-009-1 / AC-009-2）。 *\/
 * export function generateObjectKey(side: 'front' | 'back'): string
 * ```
 */

const STORAGE_SOURCE = resolve(process.cwd(), 'lib/storage.ts')

/* ========================================================================= *
 * AC-009-2: `objectKey` の推測不可能性
 * ========================================================================= */

describe('AC-009-2: objectKey は暗号論的乱数を含み、推測できない', () => {
  it('同一入力から 2 回発行しても一致しない', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される攻撃: `objectKey` を推測して
    // **他人の免許証画像に到達する / 他人のキーへ上書きする**こと。
    // `objectKey` は非公開バケットの唯一の識別子であり（AC-009-8: 公開 URL は存在しない）、
    // **推測不能性そのものがアクセス制御**である。
    const keys = new Set<string>()
    for (let n = 0; n < 200; n++) keys.add(generateObjectKey('front'))
    expect(keys.size, `200 回発行して ${keys.size} 種類しか出ていない`).toBe(200)
  })

  it('乱数部が 128bit 以上ある', async () => {
    // AC-009-2 の「≥128bit」。hex なら 32 文字、base64url なら 22 文字以上。
    // これが green なら排除される実装: 8 文字程度の短いランダムで
    // **総当たりが現実的になる**こと（非公開バケットでも列挙で到達される）。
    const key = generateObjectKey('front')
    const randomPart = key.split('/').pop() ?? ''
    expect(
      randomPart.length,
      `乱数部が短すぎる（${randomPart.length} 文字）。hex なら 32 文字以上が要る`,
    ).toBeGreaterThanOrEqual(22)
  })

  it('連番でない（発行順に単調増加しない）', async () => {
    // これが green なら排除される実装: `lic-1` / `lic-2` のような連番。
    // 1 つ手に入れば全部読める。
    const first = generateObjectKey('front')
    const second = generateObjectKey('front')
    const third = generateObjectKey('front')
    const sorted = [first, second, third].slice().sort()
    expect(
      sorted.join('|') === [first, second, third].join('|') &&
        sorted.join('|') === [third, second, first].join('|'),
      '発行順に単調な並びになっている（連番の疑い）',
    ).toBe(false)
  })

  it('時刻を含まない（発行時刻から推測できない）', async () => {
    // AC-009-2 は「時刻を含まない」を明示している。
    // 年・epoch 秒・epoch ミリ秒のいずれもキーに現れないこと。
    const now = Date.now()
    const key = generateObjectKey('front')
    for (const probe of [
      String(now).slice(0, 10), // epoch 秒
      String(now), // epoch ミリ秒
      String(new Date(now).getFullYear()), // 年
    ]) {
      expect(key, `時刻由来の値 ${probe} がキーに現れている`).not.toContain(probe)
    }
  })

  it('side 以外のユーザー入力を受け取れない（型で塞ぐ）', () => {
    // AC-009-2 の「ファイル名 / 氏名 / メールを含まない」は、
    // **そもそも入力として受け取らない**ことで満たすのが最も確実である。
    // これが green なら排除される実装: `generateObjectKey({ fileName })` のように
    // 入力を材料にでき、**利用者の氏名がストレージキーとログに残る**こと（AC-PII-1 違反）。
    //
    // ⚠️ **この pin は補助である（N-2）。主たる担保は TypeScript のシグネチャ側にある。**
    // `Function.prototype.length` は**最初の既定引数より前**の個数を返すので、
    // `generateObjectKey(side, opts = {})` と書かれても **1 のまま通る**。
    // 「引数が増えていない」ことの厳密な担保は型（`(side: 'front' | 'back') => string`）で行い、
    // 本 pin は「引数を 2 つ必須で増やした」という粗い退行だけを捕まえる。
    expect(generateObjectKey.length, 'generateObjectKey が side 以外の引数を取っている').toBe(1)
  })

  it('public / http を含まない（公開 URL ではない / AC-009-8）', () => {
    const key = generateObjectKey('back')
    expect(key).not.toMatch(/^https?:/)
    expect(key.toLowerCase()).not.toContain('public')
  })
})

/* ========================================================================= *
 * AC-009-1: クライアント指定の `objectKey` は一切効かない
 * ========================================================================= */

describe('AC-009-1: objectKey は必ずサーバーが生成する', () => {
  it('リクエストに objectKey を含めても、返る値はサーバー生成値である', async () => {
    // これが green なら排除される攻撃: クライアントが `objectKey` を指定して
    //  (a) **他人のオブジェクトを上書きする**、
    //  (b) `../` を含むキーで**バケット外へ書き込む**（パストラバーサル）、
    //  (c) 既知のキーを指定して**後から読み出す**。
    const adapter = createLocalStorageAdapter({ root: undefined })
    const target = await adapter.createSignedUpload({
      side: 'front',
      contentType: 'image/jpeg',
      size: 1024,
      // 型には無いが、実行時に混入しうる形をそのまま渡す。
      ...({ objectKey: '../../etc/passwd' } as Record<string, unknown>),
    } as Parameters<typeof adapter.createSignedUpload>[0])

    expect(target.objectKey).not.toContain('..')
    expect(target.objectKey).not.toContain('etc/passwd')
  })

  it('返り値の objectKey は generateObjectKey と同じ形式である', async () => {
    const adapter = createLocalStorageAdapter()
    const target = await adapter.createSignedUpload({
      side: 'front',
      contentType: 'image/jpeg',
      size: 1024,
    })
    const sample = generateObjectKey('front')
    // 接頭辞（`private/lic/` 等）が一致していること＝同じ生成器を通っている。
    expect(target.objectKey.split('/').slice(0, -1).join('/')).toBe(
      sample.split('/').slice(0, -1).join('/'),
    )
  })
})

/* ========================================================================= *
 * SPEC-003: 署名付き URL の有効期限
 * ========================================================================= */

describe('SPEC-003 / P3c-11: 署名付き URL の有効期限', () => {
  it('PUT URL の有効期限は 300 秒（確定値）', () => {
    // これが green なら排除される事故: 期限を長くして
    // **URL が漏れた場合の窓が広がる**こと。300 秒は SPEC-003 の確定値である。
    expect(UPLOAD_URL_EXPIRES_IN_SEC).toBe(300)
  })

  it('createSignedUpload の返り値が expiresIn を伝える（クライアントが再発行時期を決められる）', async () => {
    const adapter = createLocalStorageAdapter()
    const target = await adapter.createSignedUpload({
      side: 'front',
      contentType: 'image/jpeg',
      size: 1024,
    })
    expect(target.expiresIn).toBe(UPLOAD_URL_EXPIRES_IN_SEC)
    expect(target.uploadUrl.length).toBeGreaterThan(0)
  })

  it('読み取り URL の既定期限も 300 秒（F-018 の前倒し確認）', async () => {
    const adapter = createLocalStorageAdapter()
    const signed = await adapter.createSignedReadUrl(generateObjectKey('front'))
    expect(signed.expiresIn).toBe(UPLOAD_URL_EXPIRES_IN_SEC)
  })
})

/* ========================================================================= *
 * アダプタ構成: ローカル実装だけでテストが完走できること
 * ========================================================================= */

describe('P3-c2 前提: ローカルアダプタで完走できる（外部アカウント不要）', () => {
  it('put → head → readPrefix → delete が一巡する', async () => {
    // **この 1 件が「テストが書ける」ことの根拠である。**
    // これが green なら排除される状態: ストレージが Vercel Blob 直結のため
    // **unit / integration / E2E のどれも uploads の防御を一度も通らない**まま
    // P3-c2 が「完了」すること（＝ 最も機微なデータを扱う経路が未検証で本番へ出る）。
    const adapter = createLocalStorageAdapter()
    const target = await adapter.createSignedUpload({
      side: 'front',
      contentType: 'image/jpeg',
      size: 4,
    })

    // 署名付き PUT URL へ実際に格納できること（ローカル実装は fetch 可能な URL を返す）。
    const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    await adapter.put?.(target.objectKey, body, 'image/jpeg')

    const head = await adapter.head(target.objectKey)
    expect(head?.size, '格納後に実サイズを取得できない（AC-009-4(b) が実装できない）').toBe(4)

    const prefix = await adapter.readPrefix(target.objectKey, 3)
    expect(Array.from(prefix ?? []), '先頭バイトを読めない（AC-009-3 が実装できない）').toEqual([
      0xff, 0xd8, 0xff,
    ])

    await adapter.deleteObject(target.objectKey)
    expect(await adapter.head(target.objectKey), '削除後も残っている').toBeNull()
  })

  it('存在しないキーの head / readPrefix は例外ではなく null', async () => {
    // 攻撃者は任意のキーを送れる。**存在しないことは失敗ではない**——
    // 例外にすると未認証の第三者が 500 を起こせる（SEC-042 / SEC-060 と同型）。
    const adapter = createLocalStorageAdapter()
    expect(await adapter.head('private/lic/does-not-exist')).toBeNull()
    expect(await adapter.readPrefix('private/lic/does-not-exist', 8)).toBeNull()
  })

  it('readPrefix は要求したバイト数までしか読まない（5MB をメモリに載せない）', async () => {
    // `enforceBodyBytes`（SEC-059）と同じ原則を格納後の検証にも適用する。
    // これが green なら排除される実装: マジックバイト検証のために
    // **オブジェクト全体（最大 5MB × 2 枚）を毎回メモリへ読み込む**こと。
    const adapter = createLocalStorageAdapter()
    const key = generateObjectKey('front')
    await adapter.put?.(key, new Uint8Array(1_000_000), 'image/jpeg')

    const prefix = await adapter.readPrefix(key, 12)
    expect(prefix?.byteLength).toBe(12)
    await adapter.deleteObject(key)
  })
})

/* ========================================================================= *
 * 定数の単一真実源
 * ========================================================================= */

describe('P3c-11: 上限と許可形式は定数として公開される（各所で書き直させない）', () => {
  it('サイズ上限は 5,242,880 B（確定値）', () => {
    expect(MAX_LICENSE_PHOTO_BYTES).toBe(5_242_880)
  })

  it('許可形式は JPEG / PNG / WebP の 3 つだけ', () => {
    // これが green なら排除される事故: SVG を許可すること。
    // **SVG は `<script>` を含めるため、閲覧側（F-018）で XSS になる。**
    expect([...ALLOWED_IMAGE_CONTENT_TYPES].sort()).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
    expect(ALLOWED_IMAGE_CONTENT_TYPES).not.toContain('image/svg+xml')
  })

  it('lib/storage.ts がスタブ（throw するだけ）ではなくなっている', () => {
    // P3-b までの `lib/storage.ts` は 3 関数すべてが `not implemented` を throw する
    // プレースホルダだった。**実装の有無をソースでも固定する**
    //（import が解決できても中身が throw なら、振る舞いテストは全部落ちる＝原因が分かりにくい）。
    const source = readFileSync(STORAGE_SOURCE, 'utf8')
    expect(source, 'まだ not implemented のスタブが残っている').not.toContain('not implemented')
  })
})
