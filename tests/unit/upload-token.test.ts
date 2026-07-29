import { describe, it, expect } from 'vitest'
import {
  UPLOAD_TOKEN_EXPIRES_IN_SEC,
  createUploadToken,
  verifyUploadTokenBinding,
} from '@/lib/upload-token'

/**
 * =========================================================================
 * P3-c2 — **AC-009-6 / AC-009-7 / AC-009-10 / E-009-4**: `uploadToken` の
 *          バインド・単回使用・期限・**理由を区別しない失敗**
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` F-009 AC-009-6（:665）/ AC-009-7（:666）/ AC-009-10（:670）、
 *       E-009-4（:575）、SPEC-011（:619-625）、SPEC-003（境界値表 :585）。
 *
 * ## `uploadToken` が背負っている役割
 * SPEC-011 の原文:
 *
 * > `uploadToken` は発行時に `objectKey` へバインドされた予測不能な単回使用トークンであり、
 * > **それを提示できること自体が「そのオブジェクトを発行させた本人である」ことの証明**になる。
 *
 * つまり `uploadToken` は**未認証フローにおける唯一の認可材料**である。
 * 認証が無い以上、これが破れると **IDOR**（他人の免許証画像を自分の申込に紐付ける /
 * 他人のオブジェクトを削除する）が直ちに成立する。
 *
 * ## サーバーは受け取った `objectKey` を信頼しない（AC-009-10）
 * > サーバーは受け取った `objectKey` を信頼せず、**`uploadToken` から DB を引いて
 * > バインド済みの `objectKey` に対してのみ**削除を実行する。
 * > クライアント指定の `objectKey` は**照合にのみ**使い、不一致なら 403。
 *
 * ## red 理由
 * `lib/upload-token.ts` が存在しない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/upload-token.ts
 * export const UPLOAD_TOKEN_EXPIRES_IN_SEC = 600      // SPEC-003（確定）
 *
 * export interface UploadTokenRecord {
 *   token: string
 *   objectKey: string
 *   contentType: string
 *   maxSize: number
 *   consumed: boolean
 *   expiresAt: Date
 * }
 *
 * /** 予測不能なトークンと、DB へ保存する行の材料を作る。 *\/
 * export function createUploadToken(params: {
 *   objectKey: string; contentType: string; maxSize: number; now?: number
 * }): { token: string; expiresAt: Date }
 *
 * /**
 *  * 提示された (token, objectKey) が使える組み合わせかを判定する**純関数**。
 *  * **理由を返さない**（`true` / `false` のみ）——呼び出し側が理由で分岐できると
 *  * 応答が分かれ、列挙攻撃の材料になる（AC-009-7）。
 *  *\/
 * export function verifyUploadTokenBinding(
 *   record: UploadTokenRecord | null,
 *   presented: { token: string; objectKey: string },
 *   now: number,
 * ): boolean
 * ```
 *
 * **`verifyUploadTokenBinding` が理由を返さない設計は意図的である。**
 * `lib/public-guard.ts:91-93`（Tier B の本文を 1 つに固定した理由）と同じ判断——
 * **降格理由を区別できないようにする**ことでボットに判定基準を教えない。
 */

const OBJECT_KEY = 'private/lic/0123456789abcdef0123456789abcdef'
const OTHER_KEY = 'private/lic/fedcba9876543210fedcba9876543210'
const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

function record(overrides: Partial<Parameters<typeof verifyUploadTokenBinding>[0]> = {}) {
  return {
    token: 'ut_valid_token_value',
    objectKey: OBJECT_KEY,
    contentType: 'image/jpeg',
    maxSize: 5_242_880,
    consumed: false,
    expiresAt: new Date(NOW + UPLOAD_TOKEN_EXPIRES_IN_SEC * 1000),
    ...overrides,
  }
}

/* ========================================================================= *
 * SPEC-003: 期限
 * ========================================================================= */

describe('SPEC-003 / AC-009-7: uploadToken の有効期限は 600 秒', () => {
  it('確定値は 600 秒（署名付き URL の 300 秒とは別物）', () => {
    // SPEC-003 は v0.2.x の矛盾（単一の `expiresIn: 300` と「暫定10分」）を訂正し、
    // **署名付き PUT URL（300 秒）と uploadToken（600 秒）は別物**として確定させた。
    // token のほうが長いのは、**署名 URL 失効後も申込を送れるようにする**ためである。
    expect(UPLOAD_TOKEN_EXPIRES_IN_SEC).toBe(600)
  })

  it('createUploadToken の expiresAt が now + 600 秒になる', () => {
    const created = createUploadToken({
      objectKey: OBJECT_KEY,
      contentType: 'image/jpeg',
      maxSize: 5_242_880,
      now: NOW,
    })
    expect(created.expiresAt.getTime()).toBe(NOW + UPLOAD_TOKEN_EXPIRES_IN_SEC * 1000)
  })

  it('トークンは予測不能（同一入力から 2 回作っても一致しない / ≥128bit）', () => {
    // これが green なら排除される攻撃: トークンを推測して
    // **他人のオブジェクトを自分の申込へ紐付ける / 他人のオブジェクトを削除する**こと。
    // 未認証フローなので、**トークンの予測不能性そのものが認可**である。
    const params = { objectKey: OBJECT_KEY, contentType: 'image/jpeg', maxSize: 5_242_880, now: NOW }
    const tokens = new Set<string>()
    for (let n = 0; n < 200; n++) tokens.add(createUploadToken(params).token)
    expect(tokens.size).toBe(200)
    expect([...tokens][0].length).toBeGreaterThanOrEqual(22)
  })

  it('トークンに objectKey がそのまま埋め込まれていない', () => {
    // これが green なら排除される実装: `token = objectKey + 署名` のように
    // **トークンから objectKey が読める**こと。ログにトークンが出た時点で
    // `objectKey` も漏れる（AC-PII-1 は両方を禁止項目にしている）。
    const created = createUploadToken({
      objectKey: OBJECT_KEY,
      contentType: 'image/jpeg',
      maxSize: 5_242_880,
      now: NOW,
    })
    expect(created.token).not.toContain(OBJECT_KEY)
    expect(created.token).not.toContain(OBJECT_KEY.split('/').pop() ?? '')
  })
})

/* ========================================================================= *
 * AC-009-6 / AC-009-7: 使える組み合わせだけを通す
 * ========================================================================= */

describe('AC-009-6 / AC-009-7: バインド・単回使用・期限', () => {
  it('正常系: 未消費・期限内・objectKey 一致なら true', () => {
    const rec = record()
    expect(verifyUploadTokenBinding(rec, { token: rec.token, objectKey: OBJECT_KEY }, NOW)).toBe(true)
  })

  it('objectKey が一致しなければ false（他人のキーを組み合わせられない）', () => {
    // **本ファイルで最も重要なテスト。IDOR そのものである。**
    // これが green なら排除される攻撃: 自分の `uploadToken` に
    // **他人の `objectKey`** を組み合わせて、他人の免許証画像を
    //  (a) 自分の申込に紐付ける（F-018 で閲覧できるようになる）
    //  (b) 削除する（AC-009-10 (b)）
    // サーバーは受け取った `objectKey` を**信頼しない**——照合にのみ使う。
    const rec = record()
    expect(verifyUploadTokenBinding(rec, { token: rec.token, objectKey: OTHER_KEY }, NOW)).toBe(false)
  })

  it('消費済みなら false（単回使用の強制）', () => {
    // AC-009-6。同一トークンでの 2 回目の紐付けを許すと、
    // **1 枚のアップロードで複数の申込に同じ画像を紐付けられる**。
    const rec = record({ consumed: true })
    expect(verifyUploadTokenBinding(rec, { token: rec.token, objectKey: OBJECT_KEY }, NOW)).toBe(false)
  })

  it('期限切れなら false（境界: ちょうど期限は有効、+1ms で無効）', () => {
    // 境界を明示する。`>=` と `>` の取り違えは 1 文字で起きる。
    const rec = record()
    const exact = rec.expiresAt.getTime()
    expect(
      verifyUploadTokenBinding(rec, { token: rec.token, objectKey: OBJECT_KEY }, exact),
      'ちょうど期限の瞬間は有効であるべき',
    ).toBe(true)
    expect(
      verifyUploadTokenBinding(rec, { token: rec.token, objectKey: OBJECT_KEY }, exact + 1),
      '期限を 1ms 超えたら無効であるべき',
    ).toBe(false)
  })

  it('レコードが存在しなければ false（未知のトークン）', () => {
    expect(verifyUploadTokenBinding(null, { token: 'ut_unknown', objectKey: OBJECT_KEY }, NOW)).toBe(
      false,
    )
  })

  it('提示トークンとレコードの token が食い違えば false', () => {
    // DB の引き方を間違えて「objectKey で引いた行」を渡す実装を防ぐ。
    const rec = record()
    expect(verifyUploadTokenBinding(rec, { token: 'ut_other', objectKey: OBJECT_KEY }, NOW)).toBe(false)
  })
})

/* ========================================================================= *
 * AC-009-7: **理由を区別できない**（列挙攻撃の防止）
 * ========================================================================= */

describe('AC-009-7 / E-009-4: 失敗の理由を呼び出し側が区別できない', () => {
  it('判定関数は boolean だけを返す（理由コードを返さない）', () => {
    // AC-009-7 の原文:
    // > **エラーメッセージは汎用文言**で、どの条件で失敗したか
    // > （未存在 / 期限切れ / 消費済み / 不一致）を区別できない（列挙攻撃の防止）
    //
    // 呼び出し側が理由で分岐できると、**応答が分かれてしまう**のは時間の問題である。
    // `lib/public-guard.ts:91-93` が Tier B の本文を 1 つに固定したのと同じ判断:
    // **判定基準をボットに教えない。**
    //
    // これが green なら排除される実装: `{ ok: false, reason: 'expired' }` を返し、
    // ルートが `reason` ごとに違うメッセージ・違うステータスを出すこと
    // → 攻撃者は `objectKey` の**存在有無を列挙**できる。
    const rec = record()
    for (const [presented, at] of [
      [{ token: rec.token, objectKey: OTHER_KEY }, NOW],
      [{ token: rec.token, objectKey: OBJECT_KEY }, rec.expiresAt.getTime() + 1],
      [{ token: 'ut_unknown', objectKey: OBJECT_KEY }, NOW],
    ] as const) {
      const result = verifyUploadTokenBinding(rec, presented, at)
      expect(typeof result, '判定が boolean 以外を返している（理由が漏れる）').toBe('boolean')
      expect(result).toBe(false)
    }
  })

  it('消費済みトークンでも「未存在」と同じ false（削除の可否も区別されない）', () => {
    // AC-009-10 (c): 消費済み（申込に紐付いた）トークンでは削除できない。
    // かつ、その失敗は**未存在と区別できない**こと。
    const consumed = record({ consumed: true })
    const missing = null
    expect(
      verifyUploadTokenBinding(consumed, { token: consumed.token, objectKey: OBJECT_KEY }, NOW),
    ).toBe(verifyUploadTokenBinding(missing, { token: consumed.token, objectKey: OBJECT_KEY }, NOW))
  })

  it('例外を投げない（壊れた入力でも劣化にとどめる）', () => {
    // 材料はすべて攻撃者が制御する。**例外は失敗ではなく劣化にする**（SEC-042）。
    const rec = record()
    for (const presented of [
      { token: '', objectKey: '' },
      { token: 'ut_' + 'x'.repeat(10_000), objectKey: 'x'.repeat(10_000) },
      { token: '../../etc/passwd', objectKey: '../../etc/passwd' },
    ]) {
      expect(() => verifyUploadTokenBinding(rec, presented, NOW)).not.toThrow()
      expect(verifyUploadTokenBinding(rec, presented, NOW)).toBe(false)
    }
  })
})
