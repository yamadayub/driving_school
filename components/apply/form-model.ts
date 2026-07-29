/**
 * `/apply` フォームの**型・定数・純粋関数**（`ui-design/application-form.md` §6.4 / RV-P3B-012）。
 *
 * ------------------------------------------------------------------------
 * なぜ分けるのか
 * ------------------------------------------------------------------------
 * ステップ部品（`components/apply/steps/`）とコンテナ（`ApplicationForm.tsx`）の双方が
 * 同じ定義を必要とする。コンテナ側に置いたまま部品から import すると循環参照になり、
 * 部品を 1 つ足すたびにコンテナが太る（P3-b の 1,146 行はそうやってできた）。
 *
 * **ここには JSX と状態を置かない。** 置いた瞬間に「小さな部品の置き場」になり、
 * 分割した意味が失われる。
 */

import type { ApplicationErrorCode } from '@/lib/validators/application'

export type ApplicationType = 'APPLICATION' | 'INQUIRY'
export type StepId = 'course' | 'personal' | 'license' | 'preference' | 'review'

export interface CourseOption {
  id: string
  label: string
  school: string | null
  format: string | null
}

export type Values = Record<string, unknown>

export const STEP_LABEL: Record<StepId, string> = {
  course: 'コース・校舎',
  personal: 'お客様情報',
  license: '免許について',
  preference: 'ご希望・ご質問',
  review: '内容確認・送信',
}

export const STEPS: Record<ApplicationType, StepId[]> = {
  APPLICATION: ['course', 'personal', 'license', 'preference', 'review'],
  INQUIRY: ['personal', 'review'],
}

/** どのステップでどのフィールドを検証するか（サーバー由来エラーの写像にも使う）。 */
export const STEP_FIELDS: Record<StepId, string[]> = {
  course: ['plans', 'courseId', 'school', 'format'],
  personal: [
    'name',
    'nameKana',
    'birthDate',
    'gender',
    'email',
    'phone',
    'postalCode',
    'address',
    'buildingName',
  ],
  license: ['licenseRevoked', 'licenseRevokedNote', 'currentLicenses'],
  preference: [
    'preferredStartMonth',
    'preferredTimeSlot',
    'paymentMethod',
    'firstTime',
    'referralSources',
    'message',
  ],
  review: ['privacyConsent'],
}

/** INQUIRY の1ステップ目は「お客様情報 + ご相談内容」を1つにまとめる（§1）。 */
export const INQUIRY_PERSONAL_FIELDS = [
  'name',
  'nameKana',
  'birthDate',
  'gender',
  'email',
  'phone',
  'firstTime',
  'referralSources',
  'message',
]

/** **入力値を一切含まない**文言テーブル（AC-PII-2 / `application-form.md` §5.2）。 */
/**
 * `Record<ApplicationErrorCode, …>` のままにしてある——**サーバー側にコードを 1 つ足すと
 * ここが型エラーになる**。文言の抜けを型検査で捕まえる唯一の手段なので、`Record<string, …>` へ
 * 緩めないこと（緩めると新しいコードが「入力をご確認ください」の既定文言に黙って落ちる）。
 */
export const ERROR_MESSAGE: Record<ApplicationErrorCode, string> = {
  REQUIRED: '必須項目です',
  INVALID_FORMAT: '入力の形式をご確認ください',
  TOO_LONG: '文字数が上限を超えています',
  OUT_OF_RANGE: '選択できる範囲外です',
  AGE_BELOW_MIN: 'お申込みいただける年齢に達していません。お電話でご相談ください',
  FORBIDDEN_FOR_TYPE: 'お手数ですが、最初からやり直してください',
  CONSENT_REQUIRED: 'プライバシーポリシーへの同意が必要です',
}

export const FIELD_LABEL: Record<string, string> = {
  plans: '教習プラン',
  courseId: 'コース',
  school: '校舎',
  format: '受講形態',
  name: '氏名',
  nameKana: '氏名カナ',
  birthDate: '生年月日',
  gender: '性別',
  email: 'メールアドレス',
  phone: '電話番号',
  postalCode: '郵便番号',
  address: '住所',
  buildingName: '建物名・部屋番号',
  licenseRevoked: '免許取消歴の有無',
  licenseRevokedNote: '取消歴の補足',
  currentLicenses: '現在お持ちの免許',
  preferredStartMonth: '入所希望月',
  preferredTimeSlot: '希望教習時間帯',
  paymentMethod: 'お支払い方法',
  firstTime: '当校のご利用',
  referralSources: '当校を知ったきっかけ',
  message: 'ご質問・ご要望',
  privacyConsent: 'プライバシーポリシーへの同意',
  body: '送信内容',
}

export const PLAN_OPTIONS = ['通常プラン', '短期プラン', '夜間プラン']
export const LICENSE_OPTIONS = ['普通自動車', '普通自動二輪', '大型自動二輪', '原付']
export const REFERRAL_OPTIONS = ['Web検索', 'SNS', 'ご家族・ご友人', '学校・職場', 'その他']
export const TIME_SLOT_OPTIONS = ['午前', '午後', '夜間', '指定なし']
export const PAYMENT_OPTIONS = ['現金', '銀行振込', 'ローン', 'クレジットカード']

export const SCHOOL_OPTIONS = [
  { value: 'IWATAKI', label: '岩滝校' },
  { value: 'AMINO', label: '網野校' },
]

export const FORMAT_OPTIONS = [
  { value: 'TSUGAKU', label: '通学' },
  { value: 'GASSHUKU', label: '合宿' },
]

export const YES_NO_OPTIONS = [
  { value: 'false', label: 'ありません' },
  { value: 'true', label: 'あります' },
]

export const FIRST_TIME_OPTIONS = [
  { value: 'true', label: '初めて' },
  { value: 'false', label: '2回目以降' },
]

export function emptyValues(): Values {
  return {
    plans: [],
    courseId: null,
    school: null,
    format: null,
    name: '',
    nameKana: '',
    birthDate: '',
    gender: null,
    email: '',
    phone: '',
    postalCode: null,
    address: null,
    buildingName: null,
    licenseRevoked: null,
    licenseRevokedNote: null,
    currentLicenses: [],
    preferredStartMonth: null,
    preferredTimeSlot: null,
    paymentMethod: null,
    firstTime: null,
    referralSources: [],
    message: '',
  }
}

/** APPLICATION 専用項目を捨てる（E-010-6 をクライアント側で構造的に起こさない / §1）。 */
export function stripApplicationOnly(values: Values): Values {
  const next = { ...values }
  for (const key of [
    'plans',
    'courseId',
    'school',
    'format',
    'postalCode',
    'address',
    'buildingName',
    'licenseRevoked',
    'licenseRevokedNote',
    'currentLicenses',
    'preferredStartMonth',
    'preferredTimeSlot',
    'paymentMethod',
  ]) {
    next[key] = Array.isArray(next[key]) ? [] : null
  }
  return next
}

/** 確認画面の表示行。**免許証写真のサムネイルは再表示しない**（P3-c 以降も同様）。 */
export function currentSummary(
  type: ApplicationType | null,
  values: Values,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  const show = (field: string) => {
    const raw = values[field]
    if (raw === null || raw === undefined || raw === '') return
    if (Array.isArray(raw) && raw.length === 0) return
    const text = Array.isArray(raw)
      ? raw.join('、')
      : typeof raw === 'boolean'
        ? raw
          ? 'はい'
          : 'いいえ'
        : String(raw)
    rows.push({ label: FIELD_LABEL[field] ?? field, value: text })
  }

  if (type === 'APPLICATION') {
    for (const field of ['plans', 'courseId', 'school', 'format']) show(field)
  }
  for (const field of ['name', 'nameKana', 'birthDate', 'gender', 'email', 'phone']) show(field)
  if (type === 'APPLICATION') {
    for (const field of [
      'postalCode',
      'address',
      'buildingName',
      'licenseRevoked',
      'licenseRevokedNote',
      'currentLicenses',
      'preferredStartMonth',
      'preferredTimeSlot',
      'paymentMethod',
    ]) {
      show(field)
    }
  }
  for (const field of ['firstTime', 'referralSources', 'message']) show(field)
  return rows
}
