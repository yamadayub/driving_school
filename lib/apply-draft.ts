/**
 * 下書き保存のスナップショット（AC-008-3 / RV-P3D-005）。
 *
 * ------------------------------------------------------------------------
 * 許可条件（1つでも欠けると AC-008-3 違反）
 * ------------------------------------------------------------------------
 *  (a) タブを閉じると失われる  → `sessionStorage` のみ（`localStorage` / Cookie は禁止）
 *  (b) 自動復元しない          → UI 側（`components/apply/ApplicationForm.tsx`）
 *  (c) 常時「今すぐ削除する」導線 → UI 側
 *  (d) 送信成功・完了画面到達・破棄操作で `removeItem` → UI 側
 *  (e) **写真に関わる値を保存しない** → **本モジュール**
 *
 * **(e) は絶対に緩めない。** `uploadToken` は「このオブジェクトを自分の申込に紐付ける」
 * 資格情報であり、共有端末（受付端末・学校の PC・ネットカフェ）に残ると
 * **後続の利用者が他人の免許証画像を自分の申込に紐付けられる**。
 *
 * 写真は P3-c で入るが、**網は今のうちに張る**——P3-c で写真を足す人が下書き保存の存在に
 * 気付かなければ (e) は破れる（単位をまたぐ事故）。
 */

/** `sessionStorage` のキー。**1つに定める**（散らばると「破棄」で全部消えない）。 */
export const APPLY_DRAFT_STORAGE_KEY = 'apply-draft/v1'

/**
 * 保存してはならないキー（AC-008-3 (e) の4種 + 短命な資格情報）。
 * **`idempotencyKey` は含めない**——PII ではなく、リロード後の二重登録防止に必要（明示的な例外）。
 */
export const DRAFT_FORBIDDEN_KEYS: readonly string[] = [
  'objectKey',
  'uploadToken',
  'previewUrl',
  'licensePhotos',
  'captchaToken',
]

const FORBIDDEN_SET = new Set(DRAFT_FORBIDDEN_KEYS.map((key) => key.toLowerCase()))

/** 値の形でも落とす（キー名を変えられても捕まえる二重の網）。 */
const FORBIDDEN_VALUE_PREFIX = ['blob:', 'data:']

const MAX_DEPTH = 8

export type DraftStorageKind = 'session' | 'local' | 'cookie'

/**
 * 保存先の可否。**`localStorage` / Cookie はタブを閉じても残る**＝共有端末に個人情報が残留する。
 * 離脱防止の効果はタブ内復元（`sessionStorage`）でほぼ得られるため、選ぶ合理性がない。
 */
export function isDraftStorageAllowed(storage: DraftStorageKind): boolean {
  return storage === 'session'
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isForbiddenValue(value: string): boolean {
  const lowered = value.trimStart().toLowerCase()
  return FORBIDDEN_VALUE_PREFIX.some((prefix) => lowered.startsWith(prefix))
}

/** 保存できない値（`File` / `Blob` / 関数 / クラスインスタンス）は「落とす」。 */
const DROP = Symbol('drop')

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string') {
    return isForbiddenValue(value as string) ? DROP : value
  }
  if (type === 'number' || type === 'boolean') return value
  if (type === 'undefined') return DROP
  // 関数・Symbol・BigInt は JSON にできない。`JSON.stringify` は黙って落とす／throw するため
  // 「保存されている」と誤認したまま復元で壊れる。**明示的に落とす。**
  if (type !== 'object') return DROP

  if (depth >= MAX_DEPTH) return DROP
  const object = value as object
  if (seen.has(object)) return DROP
  seen.add(object)

  if (Array.isArray(object)) {
    const items = object.map((item) => sanitize(item, seen, depth + 1)).filter((item) => item !== DROP)
    return items
  }

  // File / Blob / Date / クラスインスタンスはそのままでは保存できない。
  if (!isPlainObject(object)) return DROP

  return sanitizeRecord(object as Record<string, unknown>, seen, depth + 1)
}

function sanitizeRecord(
  record: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (FORBIDDEN_SET.has(key.toLowerCase())) continue
    const sanitized = sanitize(value, seen, depth)
    if (sanitized === DROP) continue
    out[key] = sanitized
  }
  return out
}

/**
 * 保存してよい形へ落とす。**禁止値は再帰的に除去する**（`licensePhotos: [{ objectKey, uploadToken }]`
 * という P3-c の実際の形を、トップレベルだけ見る実装では捕まえられない）。
 *
 * 下書き保存は入力のたびに走るため、**ここで throw するとフォーム全体が固まる**。
 * 循環参照・巨大入力・型違いのいずれでも必ず値を返す。
 */
export function toDraftSnapshot(state: unknown): Record<string, unknown> {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return {}
  try {
    return sanitizeRecord(state as Record<string, unknown>, new WeakSet<object>(), 0)
  } catch {
    return {}
  }
}
