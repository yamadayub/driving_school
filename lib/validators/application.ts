/**
 * 申込・問い合わせのサーバー再バリデーション（F-008 / F-010）。
 *
 * ------------------------------------------------------------------------
 * `lib/validators/news.ts` の流儀から**意図的に変えた**点
 * ------------------------------------------------------------------------
 * `parseNewsInput` は `errors: Record<string, string>`（**メッセージ文字列**）を返す。
 * 公開フォームでは AC-PII-2 が「`{ field, code }` の配列のみ」を要求しており、
 * **メッセージ文字列は入力値を含みうる**（zod の `Invalid enum value. Received: '…'` が典型）。
 * バリデーションエラーの応答そのものが個人情報の反射点になり、ログ・監視・CDN のエラー本文
 * キャッシュにも乗るため、影響は応答1回に閉じない。**本経路はメッセージを一切返さない。**
 * 表示文言はクライアントが `code` から引く（`ui-design/application-form.md` §5.2）。
 *
 * ------------------------------------------------------------------------
 * zod を使わない理由
 * ------------------------------------------------------------------------
 * zod の `issues` は `received` / `message` に入力値を含む。`.superRefine` で全部潰すより、
 * **値を持てない結果型**を最初から返す手書きのバリデータのほうが、AC-PII-2 の担保が読んで分かる。
 *
 * ------------------------------------------------------------------------
 * 文字数はコードポイントで数える（SEC-042 の教訓）
 * ------------------------------------------------------------------------
 * `String.prototype.length` は UTF-16 コードユニット数なので、`𩸽` のようなサロゲートペアを
 * 含む氏名では **50 文字制限が実質 25 文字**になる。第3水準漢字を氏名に含む人は実在するため、
 * これは**正規利用者の締め出し**である。
 */

import { isAgeEligible } from '@/lib/age-eligibility'

export type ApplicationErrorCode =
  | 'REQUIRED'
  | 'INVALID_FORMAT'
  | 'TOO_LONG'
  | 'OUT_OF_RANGE'
  | 'AGE_BELOW_MIN'
  | 'FORBIDDEN_FOR_TYPE'
  | 'CONSENT_REQUIRED'

export interface ApplicationFieldError {
  field: string
  code: ApplicationErrorCode
}

export type ApplicationType = 'APPLICATION' | 'INQUIRY'
export type ApplicationSchool = 'IWATAKI' | 'AMINO'
export type ApplicationFormat = 'TSUGAKU' | 'GASSHUKU'

export interface ApplicationInput {
  type: ApplicationType
  idempotencyKey: string
  name: string
  nameKana: string
  /** `YYYY-MM-DD`（JST の暦日として扱う）。 */
  birthDate: string
  gender: string | null
  email: string
  /** ハイフンを除去した 10〜11 桁の数字列。 */
  phone: string
  firstTime: boolean | null
  referralSources: string[]
  message: string | null
  privacyConsent: true
  captchaToken: string
  // --- APPLICATION 専用（INQUIRY では既定値） ---
  plans: string[]
  courseId: string | null
  school: ApplicationSchool | null
  format: ApplicationFormat | null
  postalCode: string | null
  address: string | null
  buildingName: string | null
  licenseRevoked: boolean | null
  licenseRevokedNote: string | null
  currentLicenses: string[]
  preferredStartMonth: string | null
  preferredTimeSlot: string | null
  paymentMethod: string | null
}

export type ApplicationParseResult =
  | { success: true; data: ApplicationInput }
  | { success: false; status: 400 | 422; errors: ApplicationFieldError[] }

/**
 * INQUIRY で送られてはならない項目（AC-010-1 の列挙。11 件）。
 *
 * **一覧を定数として公開する**のは仕様と照合できるようにするため。ハンドラ内に埋め込むと
 * 1 つ抜けても誰も気付かない。`buildingName` は AC-008-2（非レンダリング）には入るが
 * AC-010-1（422 対象）には入らない——**仕様どおりに分けてある**（申し送り T-Q9）。
 */
export const INQUIRY_FORBIDDEN_FIELDS: readonly string[] = [
  'plans',
  'courseId',
  'school',
  'format',
  'postalCode',
  'address',
  'licenseRevoked',
  'currentLicenses',
  'licensePhotos',
  'preferredStartMonth',
  'paymentMethod',
]

/* ------------------------------------------------------------------------- *
 * 判定の部品
 * ------------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 全角カタカナ + 長音符 + 中黒 + 全角/半角スペース。**全域一致**（部分一致にすると実質無検証）。 */
const KATAKANA = /^[ァ-ヶー・　 ]+$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DIGITS_ONLY = /^[0-9]+$/
const POSTAL_CODE = /^[0-9]{7}$/
const YEAR_MONTH = /^(\d{4})-(\d{2})$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const NAME_MAX = 50
const MESSAGE_MAX = 1_000
const ADDRESS_MAX = 100
const BUILDING_MAX = 100
const EMAIL_MAX = 255
const NOTE_MAX = 1_000
const CHOICE_MAX = 50
const LIST_MAX_ITEMS = 32
const LIST_ITEM_MAX = 100
const IDEMPOTENCY_KEY_MAX = 64
const CAPTCHA_TOKEN_MAX = 4_096

/** コードポイント数（サロゲートペアを1文字と数える）。 */
function codePointLength(value: string): number {
  return [...value].length
}

/**
 * 「送られた」と見なす条件（申し送り T-Q8）。
 *
 * `'plans' in body` のような**存在判定にしてはならない**。クライアントは単一のフォーム状態を
 * 送るため（`ui-design/application-form.md` §4.3）、INQUIRY でも `plans: []` / `courseId: null`
 * を常に含める。存在判定にすると**正規の問い合わせが全て 422 になり、INQUIRY 経路が単独で
 * 完結しなくなる**（P3-b の完了条件に直撃する）。
 */
function isProvided(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string' && value.length === 0) return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (value.length > LIST_MAX_ITEMS) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    if (codePointLength(item) > LIST_ITEM_MAX) return null
    out.push(item)
  }
  return out
}

class ErrorBag {
  private readonly seen = new Set<string>()
  readonly errors: ApplicationFieldError[] = []

  add(field: string, code: ApplicationErrorCode): void {
    if (this.seen.has(field)) return
    this.seen.add(field)
    this.errors.push({ field, code })
  }

  get isEmpty(): boolean {
    return this.errors.length === 0
  }
}

/** 業務ルール違反（422）に割り当てるコード。それ以外は形式エラー（400）。 */
const BUSINESS_RULE_CODES = new Set<ApplicationErrorCode>(['FORBIDDEN_FOR_TYPE', 'CONSENT_REQUIRED'])

/* ------------------------------------------------------------------------- *
 * ハニーポット（AC-010-3 / SPEC-012）
 * ------------------------------------------------------------------------- */

/**
 * ハニーポット欄が充填されているか。
 *
 *  - `Boolean(hp_field)` で判定してはならない——bot が `hp_field: false` / `0` を送れば
 *    罠を素通りできる。**「文字列であって空白のみでない」以外は全て充填**とする。
 *  - 逆に空白のみ（半角・全角）を「充填」と判定すると、IME の確定操作で全角空白が入った
 *    正規利用者を Tier B に落とす（AC-010-3 が明示的に避けている a11y 事故）。
 */
export function isHoneypotFilled(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const value = (input as Record<string, unknown>).hp_field
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.replace(/[\s　]/g, '').length > 0
  // 文字列以外（数値・真偽値・オブジェクト）が入るのは人間の操作では起こりえない。
  return true
}

/* ------------------------------------------------------------------------- *
 * 本体
 * ------------------------------------------------------------------------- */

export function parseApplicationInput(
  input: unknown,
  options: { receivedAt: Date },
): ApplicationParseResult {
  const body: Record<string, unknown> =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  const bag = new ErrorBag()
  const { receivedAt } = options

  /* --- type ------------------------------------------------------------- */
  const rawType = asString(body.type)
  const type: ApplicationType | null =
    rawType === 'APPLICATION' || rawType === 'INQUIRY' ? rawType : null
  if (type === null) {
    bag.add('type', isProvided(body.type) ? 'INVALID_FORMAT' : 'REQUIRED')
  }

  /* --- type 逸脱（AC-010-1 / E-010-6）------------------------------------ */
  // **形式エラーより先に評価する**（申し送り T-Q7）。形式エラーで早期 return すると
  // type 逸脱の検出前に 400 を返し、E-010-6 が定めた 422 の契約が観測不能になる。
  if (type === 'INQUIRY') {
    for (const field of INQUIRY_FORBIDDEN_FIELDS) {
      if (isProvided(body[field])) bag.add(field, 'FORBIDDEN_FOR_TYPE')
    }
  }

  /* --- idempotencyKey ---------------------------------------------------- */
  const idempotencyKey = asString(body.idempotencyKey) ?? ''
  if (!isProvided(body.idempotencyKey)) {
    bag.add('idempotencyKey', 'REQUIRED')
  } else if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX || !UUID.test(idempotencyKey)) {
    // 任意長の文字列を許すと、**一意インデックスのキー空間と DB 行サイズを攻撃者が決められる**。
    bag.add('idempotencyKey', 'INVALID_FORMAT')
  }

  /* --- 氏名 -------------------------------------------------------------- */
  const name = (asString(body.name) ?? '').trim()
  if (!isProvided(body.name) || name.length === 0) {
    bag.add('name', 'REQUIRED')
  } else if (codePointLength(name) > NAME_MAX) {
    bag.add('name', 'TOO_LONG')
  }

  const nameKana = (asString(body.nameKana) ?? '').trim()
  if (!isProvided(body.nameKana) || nameKana.length === 0) {
    bag.add('nameKana', 'REQUIRED')
  } else if (codePointLength(nameKana) > NAME_MAX) {
    bag.add('nameKana', 'TOO_LONG')
  } else if (!KATAKANA.test(nameKana)) {
    bag.add('nameKana', 'INVALID_FORMAT')
  }

  /* --- 生年月日（AC-008-8）----------------------------------------------- */
  const birthDate = asString(body.birthDate) ?? ''
  if (!isProvided(body.birthDate)) {
    bag.add('birthDate', 'REQUIRED')
  } else if (!ISO_DATE.test(birthDate)) {
    bag.add('birthDate', 'INVALID_FORMAT')
  } else if (!isAgeEligible({ birthDate, receivedAt })) {
    // **判定は `options.receivedAt` を使う**（システム時刻を直読みしない）。
    // 内部で `new Date()` を読むと境界値テストが実時間依存になり、特定の日付にだけ CI が落ちる。
    // 実在しない日付・未来日もここに落ちる（`isAgeEligible` は fail-closed）。
    bag.add('birthDate', 'AGE_BELOW_MIN')
  }

  /* --- 連絡先 ------------------------------------------------------------ */
  const email = asString(body.email) ?? ''
  if (!isProvided(body.email)) {
    bag.add('email', 'REQUIRED')
  } else if (email.length > EMAIL_MAX || !EMAIL.test(email)) {
    // `\s` を除外しているので **CR / LF もここで落ちる**——自動返信の `Bcc` を増やす
    // メールヘッダインジェクションの入口を塞ぐ（AC-RL-14 が守る資産と同じもの）。
    bag.add('email', 'INVALID_FORMAT')
  }

  const rawPhone = asString(body.phone) ?? ''
  const phone = rawPhone.replace(/-/g, '')
  if (body.phone === undefined || body.phone === null) {
    bag.add('phone', 'REQUIRED')
  } else if (!DIGITS_ONLY.test(phone) || phone.length < 10 || phone.length > 11) {
    // `DIGITS_ONLY` は ASCII 限定。全角数字・アラビア数字（インド系）を通すと
    // **DB に発信不能な電話番号が入り、受信管理（F-017）の運用が壊れる**。
    // 除去するのは ASCII ハイフンのみ——U+2013 等のダッシュ様文字は正規化せず弾く。
    bag.add('phone', 'INVALID_FORMAT')
  }

  const gender = optionalShortText(body.gender, 'gender', bag, CHOICE_MAX)

  /* --- 共通の任意項目 ----------------------------------------------------- */
  const firstTime = typeof body.firstTime === 'boolean' ? body.firstTime : null
  if (isProvided(body.firstTime) && firstTime === null) bag.add('firstTime', 'INVALID_FORMAT')

  const referralSources = optionalList(body.referralSources, 'referralSources', bag)

  let message: string | null = null
  if (isProvided(body.message)) {
    const raw = asString(body.message)
    if (raw === null) bag.add('message', 'INVALID_FORMAT')
    else if (codePointLength(raw) > MESSAGE_MAX) bag.add('message', 'TOO_LONG')
    else message = raw
  }

  /* --- 同意（AC-010-5）---------------------------------------------------- */
  // `=== true` 以外を通してはならない。`'false'` も truthy であり、truthy 判定にすると
  // **同意なしで送られた申込が「同意あり」として記録される**（APPI 上の不履行）。
  if (body.privacyConsent !== true) bag.add('privacyConsent', 'CONSENT_REQUIRED')

  const captchaToken = asString(body.captchaToken) ?? ''
  if (captchaToken.length > CAPTCHA_TOKEN_MAX) bag.add('captchaToken', 'TOO_LONG')

  /* --- APPLICATION 専用 --------------------------------------------------- */
  let plans: string[] = []
  let courseId: string | null = null
  let school: ApplicationSchool | null = null
  let format: ApplicationFormat | null = null
  let postalCode: string | null = null
  let address: string | null = null
  let licenseRevoked: boolean | null = null
  let licenseRevokedNote: string | null = null
  let currentLicenses: string[] = []
  let preferredStartMonth: string | null = null
  let preferredTimeSlot: string | null = null
  let paymentMethod: string | null = null

  // `buildingName` は INQUIRY でも 422 にしない（T-Q9）が、長さ検証は共通で行う。
  let buildingName: string | null = null
  if (isProvided(body.buildingName)) {
    const raw = asString(body.buildingName)
    if (raw === null) bag.add('buildingName', 'INVALID_FORMAT')
    else if (codePointLength(raw) > BUILDING_MAX) bag.add('buildingName', 'TOO_LONG')
    else buildingName = raw
  }

  if (type === 'APPLICATION') {
    const parsedPlans = asStringArray(body.plans)
    if (!isProvided(body.plans)) bag.add('plans', 'REQUIRED')
    else if (parsedPlans === null) bag.add('plans', 'INVALID_FORMAT')
    else plans = parsedPlans

    courseId = requiredShortText(body.courseId, 'courseId', bag, 64)

    const rawSchool = asString(body.school)
    if (!isProvided(body.school)) bag.add('school', 'REQUIRED')
    else if (rawSchool !== 'IWATAKI' && rawSchool !== 'AMINO') bag.add('school', 'INVALID_FORMAT')
    else school = rawSchool

    const rawFormat = asString(body.format)
    if (!isProvided(body.format)) bag.add('format', 'REQUIRED')
    else if (rawFormat !== 'TSUGAKU' && rawFormat !== 'GASSHUKU') bag.add('format', 'INVALID_FORMAT')
    else format = rawFormat

    const rawPostal = asString(body.postalCode) ?? ''
    if (!isProvided(body.postalCode)) bag.add('postalCode', 'REQUIRED')
    else if (!POSTAL_CODE.test(rawPostal)) bag.add('postalCode', 'INVALID_FORMAT')
    else postalCode = rawPostal

    const rawAddress = asString(body.address) ?? ''
    if (!isProvided(body.address)) bag.add('address', 'REQUIRED')
    else if (codePointLength(rawAddress) > ADDRESS_MAX) bag.add('address', 'TOO_LONG')
    else address = rawAddress

    if (!isProvided(body.licenseRevoked)) bag.add('licenseRevoked', 'REQUIRED')
    else if (typeof body.licenseRevoked !== 'boolean') bag.add('licenseRevoked', 'INVALID_FORMAT')
    else licenseRevoked = body.licenseRevoked

    if (isProvided(body.licenseRevokedNote)) {
      const raw = asString(body.licenseRevokedNote)
      if (raw === null) bag.add('licenseRevokedNote', 'INVALID_FORMAT')
      else if (codePointLength(raw) > NOTE_MAX) bag.add('licenseRevokedNote', 'TOO_LONG')
      else licenseRevokedNote = raw
    }

    currentLicenses = optionalList(body.currentLicenses, 'currentLicenses', bag)

    if (isProvided(body.preferredStartMonth)) {
      const raw = asString(body.preferredStartMonth) ?? ''
      const match = YEAR_MONTH.exec(raw)
      const month = match ? Number(match[2]) : 0
      if (!match || month < 1 || month > 12) {
        bag.add('preferredStartMonth', 'INVALID_FORMAT')
      } else if (raw < receivedYearMonth(receivedAt)) {
        bag.add('preferredStartMonth', 'OUT_OF_RANGE')
      } else {
        preferredStartMonth = raw
      }
    }

    preferredTimeSlot = optionalShortText(body.preferredTimeSlot, 'preferredTimeSlot', bag, CHOICE_MAX)
    paymentMethod = optionalShortText(body.paymentMethod, 'paymentMethod', bag, CHOICE_MAX)
  }

  if (!bag.isEmpty || type === null) {
    const status = bag.errors.some((error) => BUSINESS_RULE_CODES.has(error.code)) ? 422 : 400
    return { success: false, status, errors: bag.errors }
  }

  return {
    success: true,
    data: {
      type,
      idempotencyKey,
      name,
      nameKana,
      birthDate,
      gender,
      email,
      phone,
      firstTime,
      referralSources,
      message,
      privacyConsent: true,
      captchaToken,
      plans,
      courseId,
      school,
      format,
      postalCode,
      address,
      buildingName,
      licenseRevoked,
      licenseRevokedNote,
      currentLicenses,
      preferredStartMonth,
      preferredTimeSlot,
      paymentMethod,
    },
  }
}

/** 受信日（JST）の `YYYY-MM`。入所希望月の下限判定に使う（クライアントの基準日は使わない）。 */
function receivedYearMonth(receivedAt: Date): string {
  const ms = receivedAt.getTime()
  if (!Number.isFinite(ms)) return '9999-12'
  const jst = new Date(ms + 9 * 60 * 60 * 1000)
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`
}

function optionalShortText(
  value: unknown,
  field: string,
  bag: ErrorBag,
  max: number,
): string | null {
  if (!isProvided(value)) return null
  const raw = asString(value)
  if (raw === null) {
    bag.add(field, 'INVALID_FORMAT')
    return null
  }
  if (codePointLength(raw) > max) {
    bag.add(field, 'TOO_LONG')
    return null
  }
  return raw
}

function requiredShortText(
  value: unknown,
  field: string,
  bag: ErrorBag,
  max: number,
): string | null {
  if (!isProvided(value)) {
    bag.add(field, 'REQUIRED')
    return null
  }
  return optionalShortText(value, field, bag, max)
}

function optionalList(value: unknown, field: string, bag: ErrorBag): string[] {
  if (!isProvided(value)) return []
  const parsed = asStringArray(value)
  if (parsed === null) {
    bag.add(field, 'INVALID_FORMAT')
    return []
  }
  return parsed
}
