import { describe, it, expect, vi } from 'vitest'
import {
  AUTO_REPLY_LIMIT_PER_HOUR,
  autoReplyThrottleKey,
  renderAutoReply,
  sendAutoReply,
} from '@/lib/mail/auto-reply'
import { createRateLimiter } from '@/lib/rate-limit'

/**
 * =========================================================================
 * P3-b — AC-010-6 / AC-010-9 / AC-PII-3 / AC-RL-14: 自動返信メール
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-6（:789）/ AC-010-9（:792）/
 *       §4.11 AC-RL-14（:1533）/ §4.12 AC-PII-3（:1547）/ 軸の分類表の注記 RV-P3D-S05（:1490）。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/mail/auto-reply.ts
 * export const AUTO_REPLY_LIMIT_PER_HOUR = 3
 * export interface AutoReplyInput {
 *   to: string; applicantName: string; receiptNumber: string
 *   type: 'APPLICATION' | 'INQUIRY'; receivedAt: Date
 * }
 * export function renderAutoReply(input: AutoReplyInput): { subject: string; text: string }
 * /** 宛先スロットルのキー。**正規化済みアドレスのハッシュ**（生アドレスを返さない）。 *\/
 * export function autoReplyThrottleKey(email: string): string
 * export interface AutoReplyDeps {
 *   limiter: RateLimiter
 *   send: (mail: { to: string; subject: string; text: string }) => Promise<void>
 *   logger?: { warn(event: string, fields: Record<string, unknown>): void }
 *   now?: () => number
 * }
 * export async function sendAutoReply(
 *   input: AutoReplyInput, deps: AutoReplyDeps,
 * ): Promise<{ sent: boolean; reason?: 'throttled' | 'send_failed' }>
 * ```
 *
 * ## AC-RL-14 が守っている資産
 * 「Cookie を取り直しながら**被害者のメールアドレス**で送信を繰り返す」経路を塞ぐ。
 * **受付は宛先に依存せず常に行う**（申込者属性軸を受付のゲートに使わない＝ SEC-021 と同型を作らない）。
 * 止めるのは「当校から第三者へメールを送る回数」だけである。
 */

const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

function input(overrides: Partial<Parameters<typeof renderAutoReply>[0]> = {}) {
  return {
    to: 'taro@example.com',
    applicantName: '山田 太郎',
    receiptNumber: '01J9ZC8Q7K3M4N5P6R7S8T9V0W',
    type: 'APPLICATION' as const,
    receivedAt: new Date(NOW),
    ...overrides,
  }
}

function deps(overrides: Partial<Parameters<typeof sendAutoReply>[1]> = {}) {
  return {
    limiter: createRateLimiter({ limit: AUTO_REPLY_LIMIT_PER_HOUR, windowMs: 3_600_000 }),
    send: vi.fn(async () => {}),
    logger: { warn: vi.fn() },
    now: () => NOW,
    ...overrides,
  }
}

/* ========================================================================= *
 * AC-010-6 / AC-PII-3: 本文に個人情報を過剰記載しない
 * ========================================================================= */

describe('AC-010-6 / AC-PII-3: 自動返信の本文に記載してよいのは限られた項目だけ', () => {
  const FORBIDDEN: Array<[string, string]> = [
    ['生年月日', '2008-04-15'],
    ['住所', '京都府宮津市字文珠123'],
    ['郵便番号', '6260001'],
    ['電話番号', '090-1234-5678'],
    ['メールアドレスの本文中への再掲', 'taro@example.com'],
    ['免許取消歴', '取消歴あり'],
    ['現有免許', '普通自動二輪'],
    ['写真の枚数', '免許証写真 2枚'],
    ['署名付きURL', 'https://blob.example.com/x?sig=abc'],
  ]

  it.each(FORBIDDEN)('本文に %s が現れない', (_label, forbidden) => {
    // これが green なら排除される攻撃/事故:
    //  (1) メールは**平文で第三者のメールサーバを経由し、受信箱に残り続ける**。
    //      申込内容の全文を載せると、メールアカウントの侵害がそのまま個人情報漏えいになる。
    //  (2) 誤送信（アドレスの打ち間違い）1件で、生年月日・住所・免許取消歴が
    //      無関係の第三者へ届く。**載せていない情報は漏れない**のが唯一の確実な対策である。
    const mail = renderAutoReply(
      input({
        applicantName: '山田 太郎',
        // 描画関数はこれらの値を**受け取らない**設計であることを、入力型でも担保する。
      }),
    )
    const rendered = `${mail.subject}\n${mail.text}`
    expect(rendered.includes(forbidden), `本文に ${_label} が含まれている`).toBe(false)
  })

  it('宛名（氏名）・受付番号・受付日時・種別・問い合わせ窓口は記載してよい', () => {
    // 逆方向の固定。**「何も書かない」実装で AC-010-6 を満たしたことにしない。**
    // 受付番号が本文に無いと、利用者は問い合わせ時に自分の申込を特定できず、
    // 完了画面を閉じた時点で受付の証跡を失う（form-submission.md §6）。
    const mail = renderAutoReply(input())
    expect(mail.text).toContain('山田 太郎')
    expect(mail.text).toContain('01J9ZC8Q7K3M4N5P6R7S8T9V0W')
    expect(mail.subject.length).toBeGreaterThan(0)
  })

  it('種別によって文面が変わる（申込 / 問い合わせ）', () => {
    const app = renderAutoReply(input({ type: 'APPLICATION' }))
    const inq = renderAutoReply(input({ type: 'INQUIRY' }))
    expect(app.text).not.toBe(inq.text)
  })

  it('氏名に改行やメールヘッダらしき文字列が入っていても件名へ持ち出さない', () => {
    // これが green なら排除される攻撃: 氏名欄に `\r\nBcc: evil@example.net` を入れ、
    // **件名経由でヘッダインジェクション**を狙うこと（バリデータ側でも弾くが、
    // 描画側でも落とすのが多層防御）。
    const mail = renderAutoReply(input({ applicantName: '山田\r\nBcc: evil@example.net' }))
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.subject.toLowerCase()).not.toContain('bcc:')
  })

  it('プライバシーポリシー URL は記載してよい（AC-PII-3 の記載可リスト）', () => {
    const mail = renderAutoReply(input())
    expect(mail.text).toMatch(/\/privacy/)
  })
})

/* ========================================================================= *
 * AC-RL-14: 宛先別スロットル
 * ========================================================================= */

describe('AC-RL-14: 同一宛先への自動返信は 3通/時', () => {
  it('4通目は送信されない（send が呼ばれない）', async () => {
    // これが green なら排除される攻撃: 「Cookie を取り直しながら**被害者のメールアドレス**で
    // 送信を繰り返す」ことで、当校のドメインから第三者へメールを送り続けること。
    // Resend のクォータ消費と送信ドメイン評判の毀損は、デモでも実在ドメインを使う以上、現実の被害になる。
    const d = deps()
    const results = []
    for (let i = 0; i < 4; i++) results.push(await sendAutoReply(input(), d))

    expect(results.map((r) => r.sent)).toEqual([true, true, true, false])
    expect(results[3].reason).toBe('throttled')
    expect(d.send).toHaveBeenCalledTimes(3)
  })

  it('別宛先は独立して 3通まで送れる（他人の送信で巻き添えにしない）', async () => {
    // これが green なら排除される壊れた実装: グローバルなカウンタでメール送信を絞る形。
    // **共有軸を副作用の抑止に使うと、1人の攻撃で全利用者の自動返信が止まる**
    //（条件1'-1 と同じ構造の失敗をメール経路に持ち込むこと）。
    const d = deps()
    for (let i = 0; i < 4; i++) await sendAutoReply(input({ to: 'a@example.com' }), d)
    const other = await sendAutoReply(input({ to: 'b@example.com' }), d)
    expect(other.sent).toBe(true)
  })

  it('大小文字・前後空白の違いで上限を回避できない', async () => {
    // これが green なら排除される攻撃: `Taro@Example.com` と `taro@example.com` を交互に送り、
    // **同じ受信箱へ 6通**送ること（正規化を忘れるとスロットルは事実上機能しない）。
    const d = deps()
    const addresses = [
      'taro@example.com',
      'Taro@Example.com',
      ' taro@example.com ',
      'TARO@EXAMPLE.COM',
    ]
    const results = []
    for (const to of addresses) results.push(await sendAutoReply(input({ to }), d))
    expect(results.map((r) => r.sent)).toEqual([true, true, true, false])
    expect(d.send).toHaveBeenCalledTimes(3)
  })

  it('スロットルキーは生のメールアドレスを含まない（AC-PII-1 / AC-RL-10）', () => {
    // これが green なら排除される事故: キーがそのままログ・メトリクス・KV のキー名に出て、
    // **レート制限の観測系が個人情報の保管場所になる**こと。
    const key = autoReplyThrottleKey('taro@example.com')
    expect(key).not.toContain('taro@example.com')
    expect(key).not.toContain('taro')
    expect(key).not.toContain('example.com')
    expect(autoReplyThrottleKey('taro@example.com')).toBe(autoReplyThrottleKey('TARO@example.com'))
  })

  it('スロットル時のログに宛先そのものを出さない（ハッシュ先頭8文字まで）', async () => {
    const logger = { warn: vi.fn() }
    const d = deps({ logger })
    for (let i = 0; i < 4; i++) await sendAutoReply(input(), d)

    const serialized = JSON.stringify(logger.warn.mock.calls)
    expect(serialized).not.toContain('taro@example.com')
    expect(serialized).not.toContain('山田')
    expect(logger.warn, 'スロットルは観測できる必要がある（黙って捨てない）').toHaveBeenCalled()
  })

  it('窓が明ければ再び送れる（恒久停止にしない）', async () => {
    let now = NOW
    const d = deps({ now: () => now })
    for (let i = 0; i < 4; i++) await sendAutoReply(input(), d)
    now = NOW + 3_600_001
    const after = await sendAutoReply(input(), d)
    expect(after.sent, '1時間経過後も送れないのは「抑止」ではなく「遮断」である').toBe(true)
  })

  it('上限値は 3（仕様の値をコードに置く）', () => {
    expect(AUTO_REPLY_LIMIT_PER_HOUR).toBe(3)
  })
})

/* ========================================================================= *
 * AC-010-9: メール送信の失敗は受付を壊さない
 * ========================================================================= */

describe('AC-010-9: メール送信失敗は例外として外へ出さない', () => {
  it('send が throw しても sendAutoReply は throw せず { sent:false, reason:"send_failed" }', async () => {
    // これが green なら排除される壊れた実装: メール送信の失敗を申込保存のロールバックや
    // 500 応答へ波及させること。**保存成功＝受付成立**であり、
    // Resend の一時障害で利用者の申込が消えてはならない（AC-010-9）。
    const d = deps({
      send: vi.fn(async () => {
        throw new Error('resend 503: taro@example.com は配送できません')
      }),
    })
    const result = await sendAutoReply(input(), d)
    expect(result).toEqual({ sent: false, reason: 'send_failed' })
  })

  it('送信失敗のログに例外メッセージ（宛先を含みうる）を出さない', async () => {
    // **AC-PII-1 の「例外・スタックトレース経由の混入も対象」**をここで固定する。
    // これが green なら排除される事故: `logger.error('mail failed', { error })` と書き、
    // 例外メッセージ経由で宛先・氏名がログへ流れること（P3-a の教訓「警告コメントは効かない」）。
    const logger = { warn: vi.fn() }
    const d = deps({
      logger,
      send: vi.fn(async () => {
        throw new Error('resend 503: taro@example.com / 山田 太郎 の配送に失敗')
      }),
    })
    await sendAutoReply(input(), d)
    const serialized = JSON.stringify(logger.warn.mock.calls)
    expect(serialized).not.toContain('taro@example.com')
    expect(serialized).not.toContain('山田')
    expect(serialized).not.toContain('resend 503')
  })

  it('送信失敗はスロットル枠を消費しない（失敗で枠が減ると本当の通知が届かなくなる）', async () => {
    // 決定（申し送り T-Q4）: 失敗した送信は上限に数えない。
    // これが green なら排除される壊れた実装: 一時障害で3回失敗した宛先が、
    // **その後1時間まったく自動返信を受け取れない**状態。
    let failing = true
    const d = deps({
      send: vi.fn(async () => {
        if (failing) throw new Error('temporary')
      }),
    })
    for (let i = 0; i < 3; i++) await sendAutoReply(input(), d)
    failing = false
    const results = []
    for (let i = 0; i < 3; i++) results.push(await sendAutoReply(input(), d))
    expect(results.map((r) => r.sent)).toEqual([true, true, true])
  })
})
