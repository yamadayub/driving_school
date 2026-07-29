import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FORM_SESSION_COOKIE_NAME,
  FORM_SESSION_MAX_AGE_SEC,
  createFormSessionValue,
  deriveFormSessionKey,
  formSessionCookieAttributes,
  verifyFormSessionValue,
} from '@/lib/form-session'

/**
 * =========================================================================
 * P3-a — AC-RL-13 の (a)(b)(d): フォームセッション Cookie の署名・検証
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-RL-13:1532、
 *       `docs/tech-stack.md` v0.3.2 §4.6（`FORM_SESSION_SECRET` の用途分離）。
 *
 * ## 単位の割り当て（RV-P3DR-010。ここを広げないこと）
 * > **発行の配線（`GET /apply` への `Set-Cookie`）は `/apply` が存在する P3-b で満たす。
 * > P3-a で満たすのは Cookie 値の生成・署名・検証ロジック（`lib/form-session.ts` 単体）である。**
 *
 * したがって本ファイルは **`/apply` を叩かない**。(c) 発行の流量制限（30回/10分）も P3-b。
 *
 * ## red 理由
 * `lib/form-session.ts` が存在しないため import 解決に失敗する。
 *
 * ## Impl が実装すべき契約
 * ```ts
 * export const FORM_SESSION_COOKIE_NAME: string        // 例 '__Host-fs'
 * export const FORM_SESSION_MAX_AGE_SEC: number        // 1800（30分）
 * export interface FormSessionPayload { sid: string; issuedAt: number }  // issuedAt は epoch ms
 * export function deriveFormSessionKey(secret: string): Buffer          // HKDF で用途別に導出
 * export function createFormSessionValue(payload: FormSessionPayload, secret: string): string
 * export function verifyFormSessionValue(
 *   value: string | null | undefined, secret: string, now: number,
 * ): FormSessionPayload | null                          // 不正・期限切れは null（例外にしない）
 * export function formSessionCookieAttributes(): {
 *   httpOnly: true; secure: true; sameSite: 'lax'; path: '/'; maxAge: number
 * }
 * ```
 */

const SECRET = 'b'.repeat(44)
const OTHER_SECRET = 'z'.repeat(44)
const T0 = 1_800_000_000_000
const MAX_AGE_MS = 1_800 * 1000

const payload = { sid: 'sid-0123456789abcdef', issuedAt: T0 }

describe('AC-RL-13(a): Cookie 値の生成と署名', () => {
  it('生成した値は検証を通り、payload がそのまま復元できる', () => {
    const value = createFormSessionValue(payload, SECRET)
    expect(verifyFormSessionValue(value, SECRET, T0 + 1_000)).toEqual(payload)
  })

  it('Max-Age は 30分（1800秒）', () => {
    expect(FORM_SESSION_MAX_AGE_SEC).toBe(1_800)
  })

  it('Cookie 属性は HttpOnly / Secure / SameSite=Lax / Path=/', () => {
    // これが green なら排除される: `HttpOnly` を落とす実装（XSS で sid を盗める）、
    // `SameSite=None` にする実装（クロスサイトから Cookie 軸を使える＝軸として機能しない）。
    const attributes = formSessionCookieAttributes()
    expect(attributes.httpOnly).toBe(true)
    expect(attributes.secure).toBe(true)
    expect(attributes.sameSite).toBe('lax')
    expect(attributes.path).toBe('/')
    expect(attributes.maxAge).toBe(FORM_SESSION_MAX_AGE_SEC)
  })

  it('Cookie 名が定数として1箇所にある（発行側と検証側で食い違わない）', () => {
    expect(typeof FORM_SESSION_COOKIE_NAME).toBe('string')
    expect(FORM_SESSION_COOKIE_NAME.length).toBeGreaterThan(0)
  })
})

describe('AC-RL-13(b): 改竄・他鍵署名・期限切れはすべて不合格（Tier B へ降格させるための null）', () => {
  it('Cookie が無い（null / undefined / 空文字）は null', () => {
    // これが green なら排除される: 「Cookie が無ければ素通り」にする実装。
    // 素通りは AC-RL-3(2) が名指しで禁じている（攻撃者は Cookie を送らないため、
    // 「同一 Cookie の4回目が拒否される」だけのテストは攻撃者の条件とずれる = SEC-038 と同型）。
    expect(verifyFormSessionValue(null, SECRET, T0)).toBeNull()
    expect(verifyFormSessionValue(undefined, SECRET, T0)).toBeNull()
    expect(verifyFormSessionValue('', SECRET, T0)).toBeNull()
  })

  it('payload を改竄した値は null（署名が sid と issuedAt の両方を覆う）', () => {
    const value = createFormSessionValue(payload, SECRET)
    const tampered = value.replace(/^[^.]+/, (head) => `${head.slice(0, -1)}X`)
    expect(tampered).not.toBe(value)
    expect(verifyFormSessionValue(tampered, SECRET, T0)).toBeNull()
  })

  it('issuedAt だけを差し替えた値は null（送信間隔下限の回避を塞ぐ）', () => {
    // これが green なら排除される: 署名対象に `issuedAt` を含めない実装。
    // `issuedAt` を過去に書き換えるだけで AC-RL-6（3秒下限）を回避できてしまう。
    const original = createFormSessionValue(payload, SECRET)
    const shifted = createFormSessionValue({ ...payload, issuedAt: T0 - 60_000 }, SECRET)
    const spliced = `${shifted.split('.')[0]}.${original.split('.').slice(1).join('.')}`
    expect(verifyFormSessionValue(spliced, SECRET, T0)).toBeNull()
  })

  it('署名部分を差し替えた値は null', () => {
    const value = createFormSessionValue(payload, SECRET)
    const parts = value.split('.')
    const forged = `${parts[0]}.${'a'.repeat(parts[1]?.length ?? 43)}`
    expect(verifyFormSessionValue(forged, SECRET, T0)).toBeNull()
  })

  it('他の鍵で署名された値は null', () => {
    const value = createFormSessionValue(payload, OTHER_SECRET)
    expect(verifyFormSessionValue(value, SECRET, T0)).toBeNull()
  })

  it('Max-Age を過ぎた値は null（境界: ちょうど 30分は有効、+1ms で無効）', () => {
    const value = createFormSessionValue(payload, SECRET)
    expect(verifyFormSessionValue(value, SECRET, T0 + MAX_AGE_MS)).toEqual(payload)
    expect(verifyFormSessionValue(value, SECRET, T0 + MAX_AGE_MS + 1)).toBeNull()
  })

  it('未来の issuedAt を持つ値は null（時計を進める偽装を通さない）', () => {
    const future = createFormSessionValue({ ...payload, issuedAt: T0 + 60_000 }, SECRET)
    expect(verifyFormSessionValue(future, SECRET, T0)).toBeNull()
  })

  it('壊れた形式でも例外を投げず null を返す（500 にせず Tier B に落とすため）', () => {
    // SEC-042: この入力集合は **5 つとも ASCII だった**ため、JS 文字列長とバイト長が一致し、
    // `timingSafeEqual` の byte length 不一致分岐に到達しなかった（契約は正しかったが、
    // 入力の選び方が脅威モデルと一致していなかった）。非 ASCII 側は下の describe が担当する。
    for (const broken of ['not-a-token', 'a.b.c.d', '.', '..', '%%%']) {
      expect(() => verifyFormSessionValue(broken, SECRET, T0)).not.toThrow()
      expect(verifyFormSessionValue(broken, SECRET, T0)).toBeNull()
    }
  })
})

/* ========================================================================= *
 * P3-a 差し戻し修正 — SEC-042（High）
 * 署名比較の長さ判定は「JS 文字列長」ではなく「バイト長」で行う
 * ========================================================================= */

/**
 * ## この指摘の型（新しい型の失敗）
 * `lib/form-session.ts:102-105` のコメントと上の「壊れた形式」テストは、
 * **「壊れた形式でも例外を投げず null」という正しい契約**を書いていた。それでも欠陥は通った。
 * 与えた 5 つの入力がすべて ASCII で、`String.prototype.length`（UTF-16 コードユニット数）と
 * `Buffer.byteLength`（UTF-8 バイト数）が一致していたためである。
 * **契約が正しくても、その契約を検証する入力の選び方が脅威モデルと一致していなければ意味がない。**
 *
 * ## 入力の選び方が脅威モデルを覆っているかの点検（`docs/review-p3a-fix-tests-2026-07-29.md` に記録）
 * 攻撃者は Cookie 値を**任意のバイト列**にできる。`length`（UTF-16）と `byteLength`（UTF-8）が
 * ずれる入力の分類は次の 4 つで、既存の集合は 1 つも覆っていなかった。
 *
 * | # | 分類 | 例 | JS 長 | UTF-8 バイト長 |
 * |---|------|----|-------|----------------|
 * | 1 | 2 バイト文字 | `é` (U+00E9) | 1 | 2 |
 * | 2 | 3 バイト文字 | `あ` (U+3042) | 1 | 3 |
 * | 3 | サロゲートペア | `😀` (U+1F600) | 2 | 4 |
 * | 4 | 不正 UTF-8（孤立サロゲート） | `\uD800` | 1 | 3（U+FFFD へ置換） |
 *
 * さらに「長さ境界」として **(5) バイト長は一致するが JS 長が違う**入力を入れる
 * （バイト長比較へ直した実装が、今度は別方向の例外を作っていないことを固定するため）。
 */
describe('SEC-042: 署名部分が非 ASCII / 不正 UTF-8 でも例外を投げず null（Tier B に落とす）', () => {
  const valid = createFormSessionValue(payload, SECRET)
  const [validPayloadPart, validSignature] = valid.split('.')

  /** 署名の先頭 n 文字を置換した Cookie 値を作る（payload 部分は正規のまま）。 */
  function withSignature(replacement: string, replacedChars: number): string {
    return `${validPayloadPart}.${replacement}${validSignature.slice(replacedChars)}`
  }

  const cases: ReadonlyArray<{ name: string; value: string; note: string }> = [
    {
      name: '2バイト文字（é / U+00E9）を署名の1文字目に置く',
      value: withSignature('é', 1),
      note: 'JS 長は一致、UTF-8 バイト長は +1 → 現行実装は RangeError を投げる（監査 G-5 の再現）',
    },
    {
      name: '3バイト文字（あ / U+3042）を署名の1文字目に置く',
      value: withSignature('あ', 1),
      note: 'JS 長は一致、UTF-8 バイト長は +2',
    },
    {
      name: 'サロゲートペア（😀 / U+1F600）を署名の先頭2文字に置く',
      value: withSignature('😀', 2),
      note: 'JS 長は一致（サロゲート2個）、UTF-8 バイト長は +2',
    },
    {
      name: '孤立サロゲート（不正 UTF-8 / \\uD800）を署名の1文字目に置く',
      value: withSignature('\uD800', 1),
      note: 'Buffer 変換で U+FFFD（3バイト）に置換され、JS 長は一致・バイト長は +2',
    },
    {
      name: 'base64url 外の文字（NUL / 改行 / 空白）を署名に混ぜる',
      value: withSignature(' \n ', 3),
      note: 'ASCII だが base64url 外。長さ判定より前で弾かれても弾かれなくても例外は不可',
    },
    {
      name: 'バイト長は一致するが JS 長が違う（é 1文字で ASCII 2文字を置換）',
      value: withSignature('é', 2),
      note: '長さ境界の逆方向。バイト長比較へ直した実装が新たな例外経路を作らないことを固定する',
    },
    {
      name: '署名が1文字短い（ASCII / 長さ境界）',
      value: `${validPayloadPart}.${validSignature.slice(0, -1)}`,
      note: '長さ不一致は null（例外にしない）',
    },
    {
      name: '署名が1文字長い（ASCII / 長さ境界）',
      value: `${validPayloadPart}.${validSignature}A`,
      note: '長さ不一致は null（例外にしない）',
    },
    {
      name: '極端に長い署名（10,000 文字）',
      value: `${validPayloadPart}.${'A'.repeat(10_000)}`,
      note: '長さで先に弾き、比較にもメモリにも大きな入力を持ち込まない',
    },
    {
      name: 'payload 部分が非 ASCII（署名は正規）',
      value: `日本語${validPayloadPart}.${validSignature}`,
      note: '署名検証で落ちる経路。base64url デコード前に例外を出してはならない',
    },
    {
      name: 'payload・署名の両方が非 ASCII のゴミ',
      value: 'ｐａｙｌｏａｄ.しょめい',
      note: '完全に壊れた Cookie（プロキシ・拡張・文字化けなど攻撃以外でも起こる）',
    },
  ]

  for (const { name, value, note } of cases) {
    it(`${name} → 例外を投げない（${note}）`, () => {
      // これが green なら排除される攻撃: 未認証の攻撃者が Cookie を 1 文字書き換えるだけで
      // `RangeError: Input buffers must have the same byte length` を起こし、
      // **任意に 500 を発生させる**こと（エラーレート汚染 / 監視の誤報 / Tier B に落ちない）。
      expect(() => verifyFormSessionValue(value, SECRET, T0)).not.toThrow()
      expect(verifyFormSessionValue(value, SECRET, T0)).toBeNull()
    })
  }

  it('正規の Cookie は引き続き検証を通る（バイト長比較へ直しても正常系を壊さない）', () => {
    expect(verifyFormSessionValue(valid, SECRET, T0 + 1_000)).toEqual(payload)
  })

  it('長さ判定はバイト長で行う（`lib/cron-auth.ts` と同じ形）', () => {
    // これが green なら排除される壊れた実装: `try { … } catch { return null }` で
    // `RangeError` を握り潰すだけの修正。**例外を隠すと、比較が実行されない入力が
    // 「署名不一致」と区別できなくなる**（将来の鍵ローテーション事故の診断手段を失う）。
    // 直し方は「先に Buffer 化してバイト長で弾く」であることを構造として固定する。
    const source = readFileSync(resolve(process.cwd(), 'lib/form-session.ts'), 'utf8')
    expect(
      source,
      '署名文字列の `.length` で長さ判定をしない（先に Buffer 化してバイト長で弾く）',
    ).not.toMatch(/providedSignature\.length\s*!==/)
  })
})

describe('AC-RL-13(d): issuedAt が送信間隔判定の基準として使える', () => {
  it('検証結果から issuedAt を epoch ms で取り出せる', () => {
    // AC-RL-6（3秒下限）は**サーバーが持つ値のみ**で判定する。
    // クライアントが送る `formRenderedAt` 相当を使わないための唯一の基準がこの `issuedAt`。
    const value = createFormSessionValue(payload, SECRET)
    const verified = verifyFormSessionValue(value, SECRET, T0 + 5_000)
    expect(verified?.issuedAt).toBe(T0)
    expect((T0 + 5_000) - (verified?.issuedAt ?? 0)).toBe(5_000)
  })
})

describe('鍵の用途分離（tech-stack §4.6）', () => {
  it('deriveFormSessionKey は入力シークレットそのものを返さない（HKDF 等で導出する）', () => {
    // これが green なら排除される: `AUTH_SECRET` をそのまま Cookie 署名鍵に使う実装。
    // 片方の漏えいが両方（セッション JWT と フォーム Cookie）に波及する。
    const derived = deriveFormSessionKey(SECRET)
    expect(Buffer.isBuffer(derived) || derived instanceof Uint8Array).toBe(true)
    expect(Buffer.from(derived).toString('utf8')).not.toBe(SECRET)
    expect(Buffer.from(derived).length).toBeGreaterThanOrEqual(32)
  })

  it('同じ入力からは同じ鍵、違う入力からは違う鍵が出る', () => {
    expect(Buffer.from(deriveFormSessionKey(SECRET))).toEqual(Buffer.from(deriveFormSessionKey(SECRET)))
    expect(Buffer.from(deriveFormSessionKey(SECRET))).not.toEqual(
      Buffer.from(deriveFormSessionKey(OTHER_SECRET)),
    )
  })
})

describe('署名の比較は定数時間', () => {
  const source = readFileSync(resolve(process.cwd(), 'lib/form-session.ts'), 'utf8')

  it('timingSafeEqual を使う', () => {
    expect(source).toContain('timingSafeEqual')
  })

  it('HMAC の比較を素の === で行っていない', () => {
    expect(source).not.toMatch(/signature\s*(===|!==)/)
  })
})

describe('AC-PII-1: sid をログに出さない前提（値の取り扱い）', () => {
  it('verifyFormSessionValue は例外メッセージに sid を含めない', () => {
    // 例外・スタックトレース経由の混入も AC-PII-1 の対象である。
    // `sid` は資格情報的な性質を持つため、相関にはハッシュ先頭8文字のみを使う。
    const value = createFormSessionValue(payload, SECRET)
    try {
      verifyFormSessionValue(`${value}!!broken`, SECRET, T0)
    } catch (error) {
      expect(String(error)).not.toContain(payload.sid)
    }
  })
})
