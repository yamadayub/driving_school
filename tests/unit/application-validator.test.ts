import { describe, it, expect } from 'vitest'
import {
  INQUIRY_FORBIDDEN_FIELDS,
  isHoneypotFilled,
  parseApplicationInput,
} from '@/lib/validators/application'

/**
 * =========================================================================
 * P3-b — F-008 / F-010 サーバー再バリデーション（AC-008-6 / AC-010-1 / 5 / 8 / AC-PII-2）
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3
 *   - F-008 画面仕様（:433-472）/ 境界値表（:490-499）/ AC-008-6（:537）/ AC-008-8（:539）
 *   - F-010 API 仕様（:720-772）/ AC-010-1（:784）/ AC-010-5（:788）/ AC-010-8（:791）
 *   - §4.5 バリデーション共通ルール（:1401-1415）/ §4.12 AC-PII-2（:1546）
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/validators/application.ts
 * export type ApplicationErrorCode =
 *   | 'REQUIRED' | 'INVALID_FORMAT' | 'TOO_LONG' | 'OUT_OF_RANGE'
 *   | 'AGE_BELOW_MIN' | 'FORBIDDEN_FOR_TYPE' | 'CONSENT_REQUIRED'
 * export interface ApplicationFieldError { field: string; code: ApplicationErrorCode }
 * export type ApplicationParseResult =
 *   | { success: true; data: ApplicationInput }
 *   | { success: false; status: 400 | 422; errors: ApplicationFieldError[] }
 * export function parseApplicationInput(input: unknown, options: { receivedAt: Date }): ApplicationParseResult
 * export const INQUIRY_FORBIDDEN_FIELDS: readonly string[]
 * export function isHoneypotFilled(input: unknown): boolean
 * ```
 *
 * ## 本ファイルが `lib/validators/news.ts` の流儀から**意図的に変えた**点
 * `parseNewsInput` は `errors: Record<string, string>`（**メッセージ文字列**）を返す。
 * 公開フォームでは AC-PII-2 が「`{ field, code }` の配列のみ」を要求しており、
 * **メッセージ文字列は zod 由来の `received` を含みうる**（`Invalid enum value. Received: '…'`）。
 * したがって本経路は**メッセージを一切返さない**形にする。表示文言はクライアントが code から引く。
 */

/** 受信時刻。年齢判定の基準（JST 2026-07-29）。 */
const RECEIVED_AT = new Date('2026-07-29T00:00:00+09:00')

const VALID_UUID = '3f8b1c2e-5a4d-4e7f-9b0a-1c2d3e4f5a6b'

function inquiry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'INQUIRY',
    idempotencyKey: VALID_UUID,
    name: '山田 太郎',
    nameKana: 'ヤマダ タロウ',
    birthDate: '2000-05-05',
    gender: null,
    email: 'taro@example.com',
    phone: '090-1234-5678',
    firstTime: true,
    referralSources: [],
    message: 'コースについて教えてください',
    privacyConsent: true,
    captchaToken: 'dummy-turnstile-token',
    hp_field: '',
    ...overrides,
  }
}

function application(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...inquiry(),
    type: 'APPLICATION',
    plans: ['ORDINARY_AT'],
    courseId: 'course-ordinary-at',
    school: 'IWATAKI',
    format: 'TSUGAKU',
    postalCode: '6260001',
    address: '京都府宮津市字文珠',
    buildingName: null,
    licenseRevoked: false,
    licenseRevokedNote: null,
    currentLicenses: [],
    preferredStartMonth: '2026-09',
    preferredTimeSlot: null,
    paymentMethod: null,
    ...overrides,
  }
}

/** 失敗結果からフィールドのエラーコードを引く（順序に依存しない検証のため）。 */
function codeOf(result: ReturnType<typeof parseApplicationInput>, field: string): string | undefined {
  if (result.success) return undefined
  const errors = result.errors as Array<{ field: string; code: string }>
  return errors.find((error) => error.field === field)?.code
}

/* ========================================================================= *
 * 正常系（この土台が崩れると以降の異常系テストが「たまたま落ちている」状態になる）
 * ========================================================================= */

describe('F-010: 正常系（土台）', () => {
  it('INQUIRY の最小構成が通る', () => {
    const result = parseApplicationInput(inquiry(), { receivedAt: RECEIVED_AT })
    expect(result.success, JSON.stringify(result)).toBe(true)
  })

  it('APPLICATION の完全構成が通る', () => {
    const result = parseApplicationInput(application(), { receivedAt: RECEIVED_AT })
    expect(result.success, JSON.stringify(result)).toBe(true)
  })

  it('入力全体が文字列・配列・null 以外（数値 / 真偽値 / 未定義）でも例外を投げない', () => {
    // 攻撃者は JSON の型を自由に選べる。**型違いで例外 → 500** は Tier 契約の外側の失敗になる。
    for (const input of [null, undefined, 42, 'string', [], true]) {
      expect(() => parseApplicationInput(input, { receivedAt: RECEIVED_AT })).not.toThrow()
      const result = parseApplicationInput(input, { receivedAt: RECEIVED_AT })
      expect(result.success).toBe(false)
    }
  })
})

/* ========================================================================= *
 * AC-010-1 / E-010-6: type 依存の条件必須検証
 * ========================================================================= */

describe('AC-010-1: INQUIRY に申込専用項目が送られたら 422（レコードを作らせない）', () => {
  it('AC-010-1 が列挙する 11 フィールドが定数として公開されている', () => {
    // これが green なら排除される壊れた実装: 禁止フィールドの一覧がハンドラ内に埋め込まれ、
    // **仕様の一覧と照合できない**状態（列が1つ抜けても誰も気付かない）。
    expect([...INQUIRY_FORBIDDEN_FIELDS].sort()).toEqual(
      [
        'address',
        'courseId',
        'currentLicenses',
        'format',
        'licensePhotos',
        'licenseRevoked',
        'paymentMethod',
        'plans',
        'postalCode',
        'preferredStartMonth',
        'school',
      ].sort(),
    )
  })

  it.each([
    ['plans', ['ORDINARY_AT']],
    ['courseId', 'course-ordinary-at'],
    ['school', 'IWATAKI'],
    ['format', 'TSUGAKU'],
    ['postalCode', '6260001'],
    ['address', '京都府宮津市字文珠'],
    ['licenseRevoked', false],
    ['currentLicenses', ['ORDINARY']],
    ['licensePhotos', [{ objectKey: 'k', uploadToken: 't', side: 'front' }]],
    ['preferredStartMonth', '2026-09'],
    ['paymentMethod', 'CASH'],
  ])('INQUIRY + %s は 422 / FORBIDDEN_FOR_TYPE', (field, value) => {
    // これが green なら排除される攻撃/壊れた実装:
    // INQUIRY を名乗って申込専用項目（免許取消歴・住所・写真トークン等）を注入し、
    // **最小収集原則（business §4.3 / APPI）を回避して機微情報を保存させる**経路。
    const result = parseApplicationInput(inquiry({ [field]: value }), { receivedAt: RECEIVED_AT })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.status, 'E-010-6 は 422（400 ではない）').toBe(422)
    expect(codeOf(result, field)).toBe('FORBIDDEN_FOR_TYPE')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空配列', []],
    ['空文字', ''],
  ])('INQUIRY で申込専用項目が %s なら「送っていない」と見なす', (_label, value) => {
    // これが green なら排除される壊れた実装: `'plans' in body` で存在判定する実装。
    // クライアントは1つのフォーム状態オブジェクトを送るため、**INQUIRY でも `plans: []` /
    // `courseId: null` を常に含める**（UI 設計 §4.3 の type 切替）。存在判定にすると
    // **正規の問い合わせが全て 422 になり、INQUIRY 経路が単独で完結しなくなる**
    //（P3-b の完了条件「INQUIRY 経路が単独で完結して動く」に直撃する）。
    const result = parseApplicationInput(
      inquiry({ plans: value, courseId: value, currentLicenses: value }),
      { receivedAt: RECEIVED_AT },
    )
    expect(result.success, JSON.stringify(result)).toBe(true)
  })

  it('APPLICATION では申込専用項目の未入力が REQUIRED になる（逆方向の取り違えを防ぐ）', () => {
    // これが green なら排除される壊れた実装: 「INQUIRY で禁止」を「常に禁止」と書き違え、
    // 申込で必須項目が検証されなくなる形。
    const result = parseApplicationInput(
      application({ plans: [], courseId: null, school: null, format: null, licenseRevoked: null }),
      { receivedAt: RECEIVED_AT },
    )
    expect(result.success).toBe(false)
    if (result.success) return
    for (const field of ['plans', 'courseId', 'school', 'format', 'licenseRevoked']) {
      expect(codeOf(result, field), field).toBe('REQUIRED')
    }
  })

  it('422（業務ルール違反）は 400（形式エラー）より優先される', () => {
    // これが green なら排除される壊れた実装: 形式エラーで早期 return し、
    // **type 逸脱の検出前に 400 を返す**実装。E-010-6 が 422 と定めた契約が観測不能になり、
    // クライアントは「入力の直し方」を案内できない。
    const result = parseApplicationInput(inquiry({ plans: ['x'], email: 'not-an-email' }), {
      receivedAt: RECEIVED_AT,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.status).toBe(422)
  })
})

/* ========================================================================= *
 * AC-010-5: 同意
 * ========================================================================= */

describe('AC-010-5: privacyConsent !== true は 422', () => {
  it.each([
    ['false', false],
    ['null', null],
    ['未送信', undefined],
    ['文字列 "true"', 'true'],
    ['数値 1', 1],
    ['文字列 "on"', 'on'],
  ])('privacyConsent が %s なら 422 / CONSENT_REQUIRED', (_label, value) => {
    // これが green なら排除される攻撃: `privacyConsent` に truthy な非 boolean（`"false"` も
    // truthy である）を送り、**同意なしで個人情報を送信させる**こと。APPI 上の同意取得が
    // 記録上は「あり」になってしまうため、`=== true` 以外を通してはならない。
    const result = parseApplicationInput(inquiry({ privacyConsent: value }), {
      receivedAt: RECEIVED_AT,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.status).toBe(422)
    expect(codeOf(result, 'privacyConsent')).toBe('CONSENT_REQUIRED')
  })
})

/* ========================================================================= *
 * F-008 境界値（§4.5 / 境界値表）
 * ========================================================================= */

describe('F-008 境界値: 文字数はコードポイントで数える', () => {
  it('氏名 1文字は可 / 0文字は REQUIRED / 50文字は可 / 51文字は TOO_LONG', () => {
    const ok1 = parseApplicationInput(inquiry({ name: '有' }), { receivedAt: RECEIVED_AT })
    expect(ok1.success).toBe(true)
    const ok50 = parseApplicationInput(inquiry({ name: 'あ'.repeat(50) }), {
      receivedAt: RECEIVED_AT,
    })
    expect(ok50.success).toBe(true)
    expect(
      codeOf(parseApplicationInput(inquiry({ name: '' }), { receivedAt: RECEIVED_AT }), 'name'),
    ).toBe('REQUIRED')
    expect(
      codeOf(
        parseApplicationInput(inquiry({ name: 'あ'.repeat(51) }), { receivedAt: RECEIVED_AT }),
        'name',
      ),
    ).toBe('TOO_LONG')
  })

  it('サロゲートペア（絵文字・第3水準漢字）50文字は可、51文字は TOO_LONG', () => {
    // **SEC-042 の教訓を長さ検証に適用したテスト。**
    // これが green なら排除される壊れた実装: `String.prototype.length`（UTF-16 コードユニット数）で
    // 数える実装。𩸽・😀 のような**サロゲートペアは 1文字で length 2** になるため、
    // 「25文字しか入らない」という**正規利用者の締め出し**が起きる（氏名に第3水準漢字を含む人は実在する）。
    // 逆に「51文字で通ってしまう」方向の退行もここで落ちる。
    const surrogate = '𩸽'
    expect(surrogate.length, '前提: このテストの入力は UTF-16 で 2 ユニットである').toBe(2)
    expect(
      parseApplicationInput(inquiry({ name: surrogate.repeat(50) }), { receivedAt: RECEIVED_AT })
        .success,
    ).toBe(true)
    expect(
      codeOf(
        parseApplicationInput(inquiry({ name: surrogate.repeat(51) }), { receivedAt: RECEIVED_AT }),
        'name',
      ),
    ).toBe('TOO_LONG')
  })

  it('質問・要望は 0文字可 / 1000文字可 / 1001文字は TOO_LONG', () => {
    expect(
      parseApplicationInput(inquiry({ message: '' }), { receivedAt: RECEIVED_AT }).success,
    ).toBe(true)
    expect(
      parseApplicationInput(inquiry({ message: 'あ'.repeat(1000) }), { receivedAt: RECEIVED_AT })
        .success,
    ).toBe(true)
    expect(
      codeOf(
        parseApplicationInput(inquiry({ message: 'あ'.repeat(1001) }), { receivedAt: RECEIVED_AT }),
        'message',
      ),
    ).toBe('TOO_LONG')
  })

  it('住所 100文字可 / 101文字 TOO_LONG、建物名 0〜100文字', () => {
    expect(
      parseApplicationInput(application({ address: 'あ'.repeat(100), buildingName: '' }), {
        receivedAt: RECEIVED_AT,
      }).success,
    ).toBe(true)
    expect(
      codeOf(
        parseApplicationInput(application({ address: 'あ'.repeat(101) }), {
          receivedAt: RECEIVED_AT,
        }),
        'address',
      ),
    ).toBe('TOO_LONG')
    expect(
      codeOf(
        parseApplicationInput(application({ buildingName: 'あ'.repeat(101) }), {
          receivedAt: RECEIVED_AT,
        }),
        'buildingName',
      ),
    ).toBe('TOO_LONG')
  })
})

describe('F-008 境界値: 電話番号（ハイフン除去後 10〜11桁）', () => {
  it.each([
    ['固定 10桁', '0772-46-1234', true],
    ['携帯 11桁', '090-1234-5678', true],
    ['ハイフン無し 10桁', '0772461234', true],
    ['9桁', '077246123', false],
    ['12桁', '090123456789', false],
    ['全角数字', '０９０-１２３４-５６７８', false],
    ['国番号付き', '+81-90-1234-5678', false],
    ['アラビア数字（インド系）', '٠٩٠١٢٣٤٥٦٧٨', false],
    ['ハイフン様のダッシュ', '090–1234–5678', false],
    ['空文字', '', false],
    ['数字以外混入', '090-1234-567a', false],
  ])('%s（%s）→ %s', (_label, phone, ok) => {
    // これが green なら排除される壊れた実装: `replace(/-/g,'')` の後に `Number.isNaN` や
    // `/\d/`（Unicode 数字を含む）で判定する実装。**全角数字・アラビア数字を通すと
    // DB に発信不能な電話番号が入り、受信管理（F-017）の運用が壊れる**。
    // 「ハイフン様のダッシュ（U+2013）」は日本語入力で実際に混入する。
    const result = parseApplicationInput(inquiry({ phone }), { receivedAt: RECEIVED_AT })
    expect(result.success, `${phone}`).toBe(ok)
    if (!ok) expect(codeOf(result, 'phone')).toBe('INVALID_FORMAT')
  })
})

describe('F-008 境界値: 郵便番号（7桁数字）', () => {
  it.each([
    ['7桁', '6260001', true],
    ['ハイフン付き', '626-0001', false],
    ['6桁', '626000', false],
    ['8桁', '62600011', false],
    ['全角', '６２６０００１', false],
  ])('%s（%s）→ %s', (_label, postalCode, ok) => {
    // 決定（申し送り T-Q3）: **正規化はクライアントの責務**とし、サーバーは 7桁 ASCII 数字のみ受ける。
    // これが green なら排除される壊れた実装: 任意文字列をそのまま保存し、
    // AC-PII-1 の「キャッシュキー・ログに載せない」前提（F-008 API 仕様の郵便番号解決の注記）が崩れる形。
    const result = parseApplicationInput(application({ postalCode }), { receivedAt: RECEIVED_AT })
    expect(result.success, postalCode).toBe(ok)
  })
})

describe('F-008 境界値: 氏名カナ（全角カタカナ）', () => {
  it.each([
    ['全角カタカナ', 'ヤマダタロウ', true],
    ['全角スペース区切り', 'ヤマダ　タロウ', true],
    ['半角スペース区切り', 'ヤマダ タロウ', true],
    ['中黒', 'ヤマダ・タロウ', true],
    ['長音符', 'コーダイ', true],
    ['半角カナ', 'ﾔﾏﾀﾞﾀﾛｳ', false],
    ['ひらがな', 'やまだたろう', false],
    ['漢字', '山田太郎', false],
    ['ラテン文字混じり', 'ヤマダtaro', false],
    ['空文字', '', false],
  ])('%s（%s）→ %s', (_label, nameKana, ok) => {
    // これが green なら排除される壊れた実装: `/[ァ-ヶ]/` のような**部分一致**で判定する実装
    //（1文字でもカナがあれば通る＝実質無検証）。全域一致であることをここで固定する。
    const result = parseApplicationInput(inquiry({ nameKana }), { receivedAt: RECEIVED_AT })
    expect(result.success, nameKana).toBe(ok)
  })
})

describe('F-008 境界値: メール / idempotencyKey', () => {
  it.each([
    ['正常', 'taro@example.com', true],
    ['アット無し', 'taro.example.com', false],
    ['ローカル部無し', '@example.com', false],
    ['ドメイン無し', 'taro@', false],
    ['空白混入', 'ta ro@example.com', false],
    ['改行混入（ヘッダインジェクション）', 'taro@example.com\nBcc: evil@example.net', false],
    ['CR 混入', 'taro@example.com\r\nBcc: evil@example.net', false],
    ['255文字超', `${'a'.repeat(250)}@example.com`, false],
  ])('メール %s → %s', (_label, email, ok) => {
    // **改行混入は自動返信メール（Resend）のヘッダインジェクションに直結する。**
    // これが green なら排除される攻撃: メールアドレス欄に CRLF を仕込んで自動返信の
    // `Bcc` を増やし、当校のドメインから第三者へメールを送らせること（AC-RL-14 が守ろうとした資産と同じ）。
    const result = parseApplicationInput(inquiry({ email }), { receivedAt: RECEIVED_AT })
    expect(result.success, email).toBe(ok)
  })

  it.each([
    ['UUID v4', VALID_UUID, true],
    ['大文字 UUID', VALID_UUID.toUpperCase(), true],
    ['非 UUID', 'my-own-key', false],
    ['空文字', '', false],
    ['巨大な文字列（10KB）', 'a'.repeat(10_000), false],
    ['配列', ['a'], false],
    ['オブジェクト', { a: 1 }, false],
  ])('idempotencyKey %s → %s', (_label, idempotencyKey, ok) => {
    // これが green なら排除される攻撃: `idempotencyKey` に任意長の文字列を送り、
    // **一意インデックスのキー空間と DB 行サイズを攻撃者が決められる**状態（§4.5「必須・UUID・一意」）。
    const result = parseApplicationInput(inquiry({ idempotencyKey }), { receivedAt: RECEIVED_AT })
    expect(result.success).toBe(ok)
  })
})

describe('F-008 境界値: 生年月日と入所希望月', () => {
  it('年齢下限未満は AGE_BELOW_MIN（400）', () => {
    // 境界そのものは age-eligibility.test.ts が固定する。ここは**バリデータへの結線**を見る。
    // これが green なら排除される壊れた実装: 純関数は正しいのに**呼ばれていない**状態
    //（P2 の「テスト対象の取り違え」と同型。純関数のテストだけでは検出できない）。
    const result = parseApplicationInput(inquiry({ birthDate: '2020-01-01' }), {
      receivedAt: RECEIVED_AT,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(codeOf(result, 'birthDate')).toBe('AGE_BELOW_MIN')
  })

  it('年齢判定は options.receivedAt を使う（システム時刻を直読みしない）', () => {
    // これが green なら排除される壊れた実装: バリデータ内部で `new Date()` を読む実装。
    // 時刻が注入できないと境界値テストが実時間依存になり、**特定の日付にだけ CI が落ちる**。
    const birthDate = '2008-04-15' // 境界日 = 2026-03-15
    const before = parseApplicationInput(inquiry({ birthDate }), {
      receivedAt: new Date('2026-03-14T00:00:00+09:00'),
    })
    const after = parseApplicationInput(inquiry({ birthDate }), {
      receivedAt: new Date('2026-03-15T00:00:00+09:00'),
    })
    expect(before.success).toBe(false)
    expect(after.success).toBe(true)
  })

  it('入所希望月は YYYY-MM かつ過去でない', () => {
    expect(
      parseApplicationInput(application({ preferredStartMonth: '2026-07' }), {
        receivedAt: RECEIVED_AT,
      }).success,
      '受信月と同月は可',
    ).toBe(true)
    expect(
      codeOf(
        parseApplicationInput(application({ preferredStartMonth: '2026-06' }), {
          receivedAt: RECEIVED_AT,
        }),
        'preferredStartMonth',
      ),
    ).toBe('OUT_OF_RANGE')
    expect(
      codeOf(
        parseApplicationInput(application({ preferredStartMonth: '2026-13' }), {
          receivedAt: RECEIVED_AT,
        }),
        'preferredStartMonth',
      ),
    ).toBe('INVALID_FORMAT')
  })
})

/* ========================================================================= *
 * AC-008-6 / AC-010-8 / AC-PII-2: エラー応答に入力値をエコーバックしない
 * ========================================================================= */

describe('AC-PII-2 / AC-008-6: エラーレスポンスに送信値が現れない', () => {
  const SECRETS = {
    name: 'エコーバック検出用氏名ZZQ',
    nameKana: 'エコーバックケンシュツヨウZZQ',
    email: 'echo-probe-zzq@example.com',
    phone: '090-0000-9999',
    birthDate: '1999-12-31',
    address: '京都府ZZQ町1-2-3',
    postalCode: '9998887',
    message: 'メッセージ本文ZZQ',
    buildingName: 'ZZQビル',
  }

  it('全フィールドを不正値にしても、応答 JSON にどの入力値も現れない', () => {
    // これが green なら排除される壊れた実装: zod の `error.issues` をそのまま返す実装。
    // zod のメッセージは `Invalid enum value. Received: '…'` のように**入力値を含む**ため、
    // **バリデーションエラーの応答そのものが個人情報の反射点**になる（AC-PII-2）。
    // ログ・監視・CDN のエラー本文キャッシュにも乗るため、影響は応答1回に閉じない。
    const result = parseApplicationInput(
      inquiry({
        ...SECRETS,
        email: `${SECRETS.email} `, // 形式不正にして必ずエラーを起こす
        nameKana: SECRETS.nameKana, // ラテン文字混じり = 形式不正
        phone: `${SECRETS.phone}x`,
        type: 'BOGUS',
      }),
      { receivedAt: RECEIVED_AT },
    )
    expect(result.success).toBe(false)
    if (result.success) return

    const serialized = JSON.stringify(result)
    for (const [field, value] of Object.entries(SECRETS)) {
      expect(serialized.includes(value), `${field} の値が応答に現れた: ${serialized}`).toBe(false)
    }
  })

  it('errors は { field, code } の2キーのみで、received / input / message を持たない', () => {
    // これが green なら排除される壊れた実装: `{ field, code, message }` を返し、
    // **メッセージ経由で入力値が漏れる**形（`message` は将来 zod のメッセージに差し替えられやすい）。
    const result = parseApplicationInput(inquiry({ email: 'bad' }), { receivedAt: RECEIVED_AT })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errors.length).toBeGreaterThan(0)
    for (const error of result.errors) {
      expect(Object.keys(error).sort()).toEqual(['code', 'field'])
      expect(typeof error.field).toBe('string')
      expect(typeof error.code).toBe('string')
    }
  })

  it('非 ASCII / 制御文字 / 巨大文字列を送っても応答に反射しない', () => {
    // **SEC-042 の教訓（入力の選び方が脅威モデルと一致しているか）をエコーバック検証に適用する。**
    // ASCII だけで検証すると、「非 ASCII のときだけ別経路（例: 正規化前の生値）を返す」実装を見逃す。
    const probes = [
      '𩸽🍣ZZQ',
      'ZZQ\u0000\u001b[31m',
      'ZZQ‮​',
      'ZZQ'.repeat(5_000),
      '<script>alert("ZZQ")</script>',
      "'; DROP TABLE \"Application\"; -- ZZQ",
    ]
    for (const probe of probes) {
      const result = parseApplicationInput(inquiry({ name: probe, email: 'bad' }), {
        receivedAt: RECEIVED_AT,
      })
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(JSON.stringify(result).includes('ZZQ'), `反射した入力: ${probe.slice(0, 40)}`).toBe(
        false,
      )
    }
  })
})

/* ========================================================================= *
 * AC-010-3: ハニーポットの判定（応答は public-guard 側 = Tier B）
 * ========================================================================= */

describe('AC-010-3 / SPEC-012: ハニーポットの判定', () => {
  it.each([
    ['空文字', '', false],
    ['未送信', undefined, false],
    ['null', null, false],
    ['空白のみ', '   ', false],
    ['全角空白のみ', '　', false],
    ['値あり', 'http://spam.example.com', true],
    ['1文字', 'a', true],
    ['数値', 1, true],
    ['真偽値 false', false, true],
  ])('hp_field が %s → 検出 %s', (_label, hp_field, detected) => {
    // これが green なら排除される壊れた実装:
    //  (1) `Boolean(hp_field)` で判定し、**`false` / `0` を「未充填」と誤判定**する形
    //      （bot が `hp_field: false` を送れば罠を素通りできる）。
    //  (2) 逆に空白のみを「充填」と判定し、**IME の確定操作で全角空白が入った
    //      正規利用者を Tier B に落とす**形（a11y 事故。AC-010-3 が明示的に避けている）。
    expect(isHoneypotFilled({ ...inquiry(), hp_field })).toBe(detected)
  })
})
