/**
 * 申込・問い合わせの自動返信（AC-010-6 / AC-010-9 / AC-PII-3 / AC-RL-14）。
 *
 * ------------------------------------------------------------------------
 * 本文に何を書かないか（AC-PII-3）
 * ------------------------------------------------------------------------
 * メールは**平文で第三者のメールサーバを経由し、受信箱に残り続ける**。申込内容の全文を載せると、
 * メールアカウントの侵害がそのまま個人情報漏えいになる。加えて宛先の打ち間違い1件で
 * 生年月日・住所・免許取消歴が無関係の第三者へ届く。**載せていない情報は漏れない**のが唯一の
 * 確実な対策であり、`AutoReplyInput` が氏名・受付番号・受付日時・種別しか受け取らないのは
 * 「うっかり載せる」経路を型で塞ぐためである。
 *
 * ------------------------------------------------------------------------
 * AC-RL-14 が守っている資産
 * ------------------------------------------------------------------------
 * 「Cookie を取り直しながら**被害者のメールアドレス**で送信を繰り返す」経路を塞ぐ。
 * 止めるのは「当校から第三者へメールを送る回数」だけで、**受付は宛先に依存せず常に行う**
 * ——受付を止めると第三者が他人の申込を妨害できる（SEC-021 と同型）。
 */

import { createHash } from 'node:crypto'
import { toErrorLogFields } from '@/lib/pii-log'
import type { RateLimiter } from '@/lib/rate-limit'

/** 同一宛先への自動返信の上限（1時間あたり）。 */
export const AUTO_REPLY_LIMIT_PER_HOUR = 3

/** スロットルのウィンドウ（ms）。 */
export const AUTO_REPLY_WINDOW_MS = 3_600_000

const THROTTLE_KEY_PREFIX = 'mail:auto-reply:'

/** プライバシーポリシーのパス（AC-PII-3 の記載可リスト）。 */
const PRIVACY_PATH = '/privacy'

const CONTACT_LINES = [
  'お問い合わせ窓口',
  '  岩滝校 0120-46-4163',
  '  網野校 0120-07-2633',
]

export interface AutoReplyInput {
  to: string
  applicantName: string
  receiptNumber: string
  type: 'APPLICATION' | 'INQUIRY'
  receivedAt: Date
}

export interface AutoReplyDeps {
  limiter: RateLimiter
  send: (mail: { to: string; subject: string; text: string }) => Promise<void>
  logger?: { warn(event: string, fields: Record<string, unknown>): void }
  now?: () => number
}

export type AutoReplyResult = { sent: boolean; reason?: 'throttled' | 'send_failed' }

/**
 * 制御文字・改行を落とす。**メールヘッダインジェクションの多層防御**——
 * バリデータ側でも弾いているが、描画側でも落とす（`\r\nBcc: ...` を件名へ持ち出させない）。
 */
function stripControl(value: string): string {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

/** 受付日時（JST）。`YYYY年M月D日 HH:MM`。生年月日等と紛れる形式を避ける。 */
function formatReceivedAt(receivedAt: Date): string {
  const ms = receivedAt.getTime()
  if (!Number.isFinite(ms)) return ''
  const jst = new Date(ms + 9 * 60 * 60 * 1000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${hh}:${mm}`
}

/**
 * 自動返信の件名・本文を組み立てる。
 *
 * **件名に氏名を入れない**——氏名は攻撃者が制御でき、ヘッダへ持ち出す価値が無い。
 * 件名の材料はサーバー生成の受付番号と固定文言だけにする。
 */
export function renderAutoReply(input: AutoReplyInput): { subject: string; text: string } {
  const receiptNumber = stripControl(input.receiptNumber)
  const applicantName = stripControl(input.applicantName)
  const isApplication = input.type === 'APPLICATION'

  const subject = stripControl(
    isApplication
      ? `【岩滝・網野自動車教習所】お申込みを受け付けました（受付番号 ${receiptNumber}）`
      : `【岩滝・網野自動車教習所】お問い合わせを受け付けました（受付番号 ${receiptNumber}）`,
  )

  const lead = isApplication
    ? 'このたびは入所のお申込みをいただき、ありがとうございます。以下の内容で受け付けました。'
    : 'このたびはお問い合わせをいただき、ありがとうございます。以下の内容で受け付けました。'

  const next = isApplication
    ? [
        'このあとの流れ',
        '  1. 担当者が内容を確認します（1〜2営業日）',
        '  2. お電話またはメールでご連絡します',
        '  3. 必要書類のご案内をいたします',
      ]
    : ['このあとの流れ', '  1〜2営業日以内に担当者よりご返信します。']

  const text = [
    `${applicantName} 様`,
    '',
    lead,
    '',
    `受付番号: ${receiptNumber}`,
    `受付日時: ${formatReceivedAt(input.receivedAt)}`,
    `受付種別: ${isApplication ? '入所申込' : 'お問い合わせ'}`,
    '',
    ...next,
    '',
    ...CONTACT_LINES,
    '',
    `個人情報の取り扱いについては ${PRIVACY_PATH} をご確認ください。`,
    'このメールは送信専用です。ご返信いただいてもお答えできません。',
  ].join('\n')

  return { subject, text }
}

/**
 * 宛先スロットルのキー。**正規化済みアドレスのハッシュ**（生アドレスを返さない）。
 *
 * 生アドレスをキーにすると、そのままログ・メトリクス・KV のキー名に現れ、
 * **レート制限の観測系が個人情報の保管場所になる**（AC-PII-1 / AC-RL-10）。
 * 正規化（trim + 小文字化）を欠かすと `Taro@Example.com` と `taro@example.com` を交互に送るだけで
 * 同じ受信箱へ 6 通送れてしまう。
 */
export function autoReplyThrottleKey(email: string): string {
  const normalized = String(email).trim().toLowerCase()
  return `${THROTTLE_KEY_PREFIX}${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)}`
}

/**
 * 自動返信を送る。**例外を外へ出さない**（AC-010-9: メール送信の失敗は受付を壊さない）。
 *
 * **送信に失敗した回はスロットル枠を消費しない**（申し送り T-Q4）。消費すると一時障害で
 * 3 回失敗した宛先が**その後1時間まったく自動返信を受け取れない**——「抑止」ではなく「遮断」になる。
 * そのため `peek` で判定し、送信が成功したときだけ `consume` する。
 */
export async function sendAutoReply(
  input: AutoReplyInput,
  deps: AutoReplyDeps,
): Promise<AutoReplyResult> {
  const now = deps.now ?? Date.now
  const at = now()
  const key = autoReplyThrottleKey(input.to)
  const keyHash = key.slice(-8)

  const state = await deps.limiter.peek(key, at)
  if (!state.success) {
    // 黙って捨てない——スロットルは観測できる必要がある。ただし宛先そのものは残さない。
    deps.logger?.warn('auto-reply.throttled', { keyHash, retryAfterMs: state.retryAfterMs })
    return { sent: false, reason: 'throttled' }
  }

  const mail = renderAutoReply(input)
  try {
    await deps.send({ to: input.to, subject: mail.subject, text: mail.text })
  } catch (error) {
    // **例外メッセージを載せない**（Resend は宛先をメッセージに含める / AC-PII-1）。
    deps.logger?.warn('auto-reply.send_failed', { keyHash, ...toErrorLogFields(error) })
    return { sent: false, reason: 'send_failed' }
  }

  await deps.limiter.consume(key, at)
  return { sent: true }
}
