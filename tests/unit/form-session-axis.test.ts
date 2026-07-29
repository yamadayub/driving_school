import { describe, it, expect } from 'vitest'
import {
  FORM_SESSION_COOKIE_NAME,
  FORM_SESSION_SIGNATURE_LENGTH,
  FORM_SESSION_VALUE_MAX_LENGTH,
  createFormSessionValue,
  formSessionAxisKey,
  formSessionAxisKeyFromValue,
  newFormSessionPayload,
  verifyFormSessionValue,
} from '@/lib/form-session'

/**
 * =========================================================================
 * P3-b — P3b-1b（SEC-052）/ P3b-11（SEC-055）/ SEC-056
 * =========================================================================
 *
 * 出典: `docs/security-audit.md`「P3-a 再監査」§C SEC-052（:2394）/ SEC-055（:2515）/ SEC-056（:2540）、
 *       §E P3b-1b（:2609）/ P3b-11（:2619）、`docs/phase-status.md` P3-b 完了条件。
 *
 * ## Impl が実装すべき追加 API（`lib/form-session.ts`）
 * ```ts
 * declare const perRequesterKeyBrand: unique symbol
 * /** **要求元ごとに一意**であることを型で表す。素の string を代入できない（SEC-052）。 *\/
 * export type PerRequesterKey = string & { readonly [perRequesterKeyBrand]: true }
 *
 * export const FORM_SESSION_SIGNATURE_LENGTH = 43   // base64url(HMAC-SHA256 32B)
 * export const FORM_SESSION_VALUE_MAX_LENGTH = 512
 *
 * /** `{ sid: 32桁小文字hex, issuedAt }` を作る（sid の乱数源は注入可能）。 *\/
 * export function newFormSessionPayload(options?: {
 *   now?: number
 *   randomBytes?: (size: number) => Uint8Array
 * }): FormSessionPayload
 *
 * /**
 *  * Tier D のフォームセッション軸キー。**署名は検証せず形式だけを見る**（検証前の計数は意図的）。
 *  * 形式不正・長すぎる値は `null`（＝軸を作らない＝新しいバケットを作らせない / SEC-055）。
 *  *\/
 * export function formSessionAxisKeyFromValue(value: string | null | undefined): PerRequesterKey | null
 * export function formSessionAxisKey(request: Request): PerRequesterKey | null   // ↑を Cookie から呼ぶだけ
 * ```
 *
 * ## なぜ「型」が要るのか（SEC-052 の核心）
 * 監査は `formSessionKey: (request) => request.cookies.get(name)?.value ?? 'anonymous'` という
 * **現実に書かれうる配線**で、`trusted=true` の通常構成でも「攻撃者が3回送ると無関係な利用者が 429」
 * になることを実測した。`formSessionKey` の戻り値が素の `string` である限り、この配線は
 * 型検査も既存テストも通る。SEC-021 → 029 → 030 → 043 と**4度**コメントで止められなかった以上、
 * **「共有キーを返せない型」以外に手段が無い**（監査の言葉で「5度目の同型」）。
 */

const SECRET = 'test-form-session-secret-32-characters-min'
const NOW = Date.UTC(2026, 6, 29, 0, 0, 0)

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers({ origin: 'https://example.test', 'content-type': 'application/json' })
  if (cookie !== null) headers.set('cookie', cookie)
  return new Request('https://example.test/api/applications', { method: 'POST', headers })
}

function validCookieValue(sid = 'a'.repeat(32), issuedAt = NOW): string {
  return createFormSessionValue({ sid, issuedAt }, SECRET)
}

/* ========================================================================= *
 * SEC-052 / P3b-1b: 型と「要求元ごとに一意」の担保
 * ========================================================================= */

describe('P3b-1b / SEC-052: formSessionAxisKey は要求元ごとに異なるキーを返す', () => {
  it('異なる Cookie は異なる軸キーになる', () => {
    // これが green なら排除される攻撃（監査 D-3 / D-4 の実測そのもの）:
    // 全員が同じ軸キーに落ちる配線にして、攻撃者1人の送信で**無関係な利用者が 429** になること。
    const a = formSessionAxisKey(
      requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${validCookieValue('a'.repeat(32))}`),
    )
    const b = formSessionAxisKey(
      requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${validCookieValue('b'.repeat(32))}`),
    )
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('同一 Cookie は同一の軸キーになる（軸として計数できる）', () => {
    const cookie = `${FORM_SESSION_COOKIE_NAME}=${validCookieValue()}`
    expect(formSessionAxisKey(requestWithCookie(cookie))).toBe(
      formSessionAxisKey(requestWithCookie(cookie)),
    )
  })

  it('Cookie が無いリクエストは軸キーを作らない（共有バケットへ寄せない）', () => {
    // **SEC-052 の是正の本体。**
    // これが green なら排除される壊れた実装: `?? 'anonymous'` のような**固定値フォールバック**。
    // Cookie を持たない利用者（プライベートブラウジング・Cookie ブロック拡張・企業端末）は
    // 本来 Tier B（403 + challenge、1タップで回復可能）で扱うべき相手であり、
    // 共有バケットの枯渇による 429（窓が明けるまでの硬い拒否）に落としてはならない。
    expect(formSessionAxisKey(requestWithCookie(null))).toBeNull()
    expect(formSessionAxisKey(requestWithCookie('other=1'))).toBeNull()
    expect(formSessionAxisKey(requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=`))).toBeNull()
  })

  it('型: 素の string を PerRequesterKey として返す実装は type-check で落ちる', () => {
    // `pnpm type-check` がこのファイルを検査する（tsconfig の include が `**/*.ts`）。
    // `@ts-expect-error` は**エラーが出なくなった時点で逆にエラーになる**ので、
    // Impl が戻り値型を素の `string | null` へ緩めたら type-check が赤くなる。
    const key: ReturnType<typeof formSessionAxisKey> = formSessionAxisKey(requestWithCookie(null))
    // @ts-expect-error 定数文字列は PerRequesterKey ではない（SEC-052: enforce:true をリテラルで書ける状態を残さない）
    const shared: ReturnType<typeof formSessionAxisKey> = 'sid-abc'
    expect(key).toBeNull()
    expect(shared).toBe('sid-abc')
  })
})

/* ========================================================================= *
 * SEC-055 / P3b-11: 形式検証（新しいバケットを作らせない）
 * ========================================================================= */

describe('P3b-11 / SEC-055: 形式不正な Cookie 値には軸キーを作らない', () => {
  const MALFORMED: Array<[string, string]> = [
    ['ドット無し', 'abcdef'],
    ['ドット2つ', `${'a'.repeat(20)}.${'b'.repeat(43)}.${'c'.repeat(4)}`],
    ['payload 部が空', `.${'b'.repeat(43)}`],
    ['signature 部が空', `${'a'.repeat(20)}.`],
    ['base64url 外の文字（+ /）', `ab+cd/ef.${'b'.repeat(43)}`],
    ['base64url 外の文字（=）', `abcd==.${'b'.repeat(43)}`],
    ['署名長が違う（42文字）', `${'a'.repeat(20)}.${'b'.repeat(42)}`],
    ['署名長が違う（44文字）', `${'a'.repeat(20)}.${'b'.repeat(44)}`],
    ['全体が長すぎる', `${'a'.repeat(FORM_SESSION_VALUE_MAX_LENGTH)}.${'b'.repeat(43)}`],
    ['非 ASCII（日本語）', `あいうえお.${'b'.repeat(43)}`],
    ['非 ASCII（絵文字）', `😀😀.${'b'.repeat(43)}`],
    ['孤立サロゲート', `\ud800${'a'.repeat(19)}.${'b'.repeat(43)}`],
    ['制御文字', `\u0000${'a'.repeat(19)}.${'b'.repeat(43)}`],
    ['空白混入', `${'a'.repeat(10)} ${'a'.repeat(9)}.${'b'.repeat(43)}`],
  ]

  it.each(MALFORMED)('%s は null（バケットを作らない）', (_label, value) => {
    // これが green なら排除される攻撃（監査 D-6 の実測）:
    // 署名が常に不正な Cookie を 2,000 種送りつけ、インメモリ store のキー空間を占有して
    // **正当な利用者の進行中カウンタを追い出す**こと（未認証の第三者が任意個のバケットを作れる経路）。
    //
    // ⚠️ ここで `Request` ヘッダ経由ではなく **値を直接渡す関数**を検証しているのは意図的である。
    // `new Headers()` は非 ASCII / NUL を含むヘッダ値を**構築時に拒否する**ため、Request 経由では
    // これらの入力が関数まで到達せず、「テストが通る条件」と「関数が守るべき条件」がずれる
    //（SEC-042 と同型の空振り）。実際には Cookie 値の percent-decode やプロキシ経由の
    // 復元でこれらの値が関数へ渡りうるため、**関数自身の契約として**固定する。
    expect(formSessionAxisKeyFromValue(value)).toBeNull()
  })

  it.each(MALFORMED)('%s でも例外を投げない（500 を作らせない）', (_label, value) => {
    expect(() => formSessionAxisKeyFromValue(value)).not.toThrow()
  })

  it('null / undefined / 空文字も例外を投げず null', () => {
    for (const value of [null, undefined, '']) {
      expect(() => formSessionAxisKeyFromValue(value)).not.toThrow()
      expect(formSessionAxisKeyFromValue(value)).toBeNull()
    }
  })

  it('Request 経由でも形式不正（ASCII 範囲）は null になる（配線の確認）', () => {
    // 純関数だけが正しくても、ラッパが渡すのは Request である。**結線を別に固定する**
    //（P2 の「テスト対象の取り違え」＝純関数は正しいが本番経路が呼んでいない、を防ぐ）。
    for (const value of ['abcdef', `${'a'.repeat(20)}.${'b'.repeat(42)}`]) {
      expect(
        formSessionAxisKey(requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${value}`)),
        value,
      ).toBeNull()
    }
  })

  it('形式は正しいが署名が不正な値には軸キーを作る（検証前の計数は意図的に残す）', () => {
    // SEC-055 が指摘したのは「**キーが検証されていない値そのもの**である」ことであって、
    // 「検証前に計数すること」ではない（監査の「順序が正しいかの評価」節）。
    // これが green なら排除される壊れた実装: 形式検証のつもりで**署名検証まで**行い、
    // **偽造 Cookie の試行そのものを絞る**という Tier D 軸の目的を失わせること。
    const forged = `${'a'.repeat(20)}.${'b'.repeat(FORM_SESSION_SIGNATURE_LENGTH)}`
    expect(FORM_SESSION_SIGNATURE_LENGTH).toBe(43)
    expect(formSessionAxisKey(requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${forged}`))).not.toBeNull()
    expect(
      verifyFormSessionValue(forged, SECRET, NOW),
      '形式は通るが署名検証は通らない（＝この後 Tier B へ落ちる）',
    ).toBeNull()
  })

  it('形式検証で閉じるのは「形式不正な値でもバケットが作れる」経路だけである（過大報告の防止）', () => {
    // ⚠️ 明示的な非目標: 形式検証は「バケットを1個も作らせない」ものではない。
    // 形式を満たす値は攻撃者にも作れるため、**残余リスクは残る**。閉じ切るのは P3b-2
    //（KV store = TTL ベースで退避の概念が無い）である。
    // このテストは、後続の監査・完了報告で「SEC-055 が完全に閉じた」と過大報告されるのを防ぐために置く
    //（P2.5 の教訓3: 文書に事実と異なる記述が入り、次フェーズの設計判断の入力になる）。
    const wellFormed = Array.from(
      { length: 1_000 },
      (_, i) => `${String(i).padStart(20, '0')}.${'b'.repeat(FORM_SESSION_SIGNATURE_LENGTH)}`,
    )
    const keys = new Set(wellFormed.map((value) => formSessionAxisKeyFromValue(value)))
    expect(keys.size, '形式を満たす値からは依然として別々の軸キーが作れる（残余リスク）').toBe(1_000)
  })

  it('Cookie ヘッダに複数の Cookie があっても __Host-fs だけを見る', () => {
    // これが green なら排除される壊れた実装: Cookie ヘッダ全体や先頭 Cookie をキー材料にする実装
    //（第三者が別名 Cookie を足すだけで軸キーを変えられる = 上限を無限に回避できる）。
    const value = validCookieValue()
    const a = formSessionAxisKey(
      requestWithCookie(`other=1; ${FORM_SESSION_COOKIE_NAME}=${value}; another=2`),
    )
    const b = formSessionAxisKey(requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${value}`))
    expect(a).toBe(b)
  })

  it('同名 Cookie が2つある場合も軸キーは1つに定まる（Cookie shadowing で軸を割らせない）', () => {
    // これが green なら排除される攻撃: `__Host-fs` を2つ送り、実装ごとに「最初」「最後」の
    // どちらを採るかがずれることを利用して、**検証に使う値と計数に使う値を食い違わせる**こと。
    const first = validCookieValue('a'.repeat(32))
    const second = validCookieValue('b'.repeat(32))
    const key = formSessionAxisKey(
      requestWithCookie(
        `${FORM_SESSION_COOKIE_NAME}=${first}; ${FORM_SESSION_COOKIE_NAME}=${second}`,
      ),
    )
    expect(key).toBe(formSessionAxisKey(requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${first}`)))
  })
})

/* ========================================================================= *
 * SEC-056: sid は小文字 hex（rateLimitKey の toLowerCase で衝突空間を縮めない）
 * ========================================================================= */

describe('SEC-056: 発行する sid は小文字 hex で、大小文字の畳み込みで衝突しない', () => {
  it('newFormSessionPayload の sid は 32桁の小文字 hex', () => {
    // `lib/rate-limit.ts:210` の `raw.trim().toLowerCase()` は IPv6 の表記ゆれを畳むための
    // 正規化だが、base64url（大小文字を区別する）を材料にすると**キー空間が縮む**（SEC-056）。
    // 監査は「P3-b で `sid` を小文字 hex で発行して衝突の余地自体を無くす（後者が安い）」を推奨した。
    // これが green なら排除される壊れた実装: `randomBytes(16).toString('base64url')` で sid を作り、
    // 軸キーの実効エントロピーを 1文字あたり log2(64) → log2(38) に落とす形。
    const payload = newFormSessionPayload({ now: NOW })
    expect(payload.sid).toMatch(/^[0-9a-f]{32}$/)
    expect(payload.issuedAt).toBe(NOW)
  })

  it('sid は呼び出しごとに変わる（固定値・カウンタではない）', () => {
    const sids = new Set(Array.from({ length: 200 }, () => newFormSessionPayload().sid))
    expect(sids.size).toBe(200)
  })

  it('乱数源を注入すると決定的になる（テストが実乱数に依存しない）', () => {
    const fixed = (size: number) => new Uint8Array(size).fill(0xab)
    const payload = newFormSessionPayload({ now: NOW, randomBytes: fixed })
    expect(payload.sid).toBe('ab'.repeat(16))
  })

  it('発行した Cookie 値は formSessionAxisKey の形式検証を通り、署名検証も通る（発行と検証の整合）', () => {
    // **発行側と軸側の契約がずれていないこと**を1本で固定する。
    // これが green なら排除される事故: 発行フォーマットを変えた（例: 署名を hex にした）ときに、
    // **正規利用者の Cookie が全て形式不正扱いになり、全員 Tier B に落ちる**状態。
    // 発行は P3-b（`GET /apply`）で配線されるため、この整合が崩れるのはまさに今の単位である。
    const payload = newFormSessionPayload({ now: NOW })
    const value = createFormSessionValue(payload, SECRET)
    expect(value.length).toBeLessThanOrEqual(FORM_SESSION_VALUE_MAX_LENGTH)
    expect(
      formSessionAxisKey(requestWithCookie(`${FORM_SESSION_COOKIE_NAME}=${value}`)),
      '発行した値が形式検証で落ちている（全利用者が Tier B になる）',
    ).not.toBeNull()
    expect(verifyFormSessionValue(value, SECRET, NOW)).toEqual(payload)
  })
})
