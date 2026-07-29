/**
 * メール送信の抽象（tech-stack §3）。デモ実装は Resend。
 *
 * ------------------------------------------------------------------------
 * 境界を最小に保つ
 * ------------------------------------------------------------------------
 * 本モジュールが持つのは「**宛先・件名・本文を送る**」だけである。文面の組み立て・宛先別の
 * スロットル・PII の記載制限は `lib/mail/auto-reply.ts` が担う。分けているのは、
 * 結合テストが**外部 I/O だけ**を差し替えてアプリのロジックを本物のまま通せるようにするため
 * （P2 の「テスト対象の取り違え」＝ テスト用の簡略経路を作らない）。
 *
 * ------------------------------------------------------------------------
 * SDK を足さずに fetch で叩く理由
 * ------------------------------------------------------------------------
 * Resend の送信 API は単一の POST であり、SDK を入れると依存とビルドサイズが増えるだけで
 * 検証可能性は上がらない。`fetchImpl` を注入できる形にしてあるのでテストからも差し替えられる。
 *
 * **`RESEND_API_KEY` 未設定時は送信せずに戻る**（開発・デモ環境）。ここで throw すると
 * 開発環境の全送信が「自動返信の失敗」として記録され、本物の障害と区別できなくなる。
 * 本番で未設定なら送られないままになるため、**運用開始時に必ず設定すること**
 * （`.env.example` に記載。P3-b では fail-fast 対象に含めない——含めると自動返信が
 * 未設定のデプロイを起動不能にし、申込受付そのものを止めてしまう）。
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/** 送信元。デモのため固定値。実運用では独自ドメインの検証済みアドレスに差し替える。 */
const FROM_ADDRESS = '岩滝・網野自動車教習所 <noreply@iwataki-driving-school.demo>'

/** 外部 API の応答時間に公開ハンドラを縛らない（`maxDuration` 10秒）。 */
const DEFAULT_TIMEOUT_MS = 5_000

export interface OutgoingMail {
  to: string
  subject: string
  text: string
}

export interface SendMailOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  apiKey?: string
}

/**
 * メールを1通送る。**失敗は例外で伝える**（呼び出し側の `sendAutoReply` が握って
 * `{ sent: false, reason: 'send_failed' }` に落とす。AC-010-9）。
 *
 * **例外メッセージに宛先・本文を入れない**——上位でそのままログへ流れる経路があるため
 * （AC-PII-1 は例外・スタックトレース経由の混入も対象としている）。
 */
export async function sendMail(mail: OutgoingMail, options: SendMailOptions = {}): Promise<void> {
  const apiKey = options.apiKey ?? process.env.RESEND_API_KEY
  if (!apiKey) return

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      // ステータスだけを載せる。応答本文には宛先が含まれうる。
      const error = new Error('mail send failed')
      Object.assign(error, { code: `MAIL_HTTP_${response.status}` })
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
}
