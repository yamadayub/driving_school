/**
 * Cloudflare Turnstile のサーバー検証（Tier B の材料 / E-010-1）。
 *
 * ------------------------------------------------------------------------
 * fail-closed の徹底
 * ------------------------------------------------------------------------
 * **どんな失敗も `false` に落とし、例外を外へ出さない。**
 *  - 例外が外へ抜けると、Tier B（403 + challenge）へ降格すべきリクエストが 500 になる
 *    ——未認証の第三者が任意にサーバーエラーを起こせる経路になる（SEC-042 と同型）。
 *  - 逆に例外を握って `true` に倒すと CAPTCHA が実質無効化される。
 *
 * ------------------------------------------------------------------------
 * 外部 API の踏み台化を防ぐ
 * ------------------------------------------------------------------------
 * トークンが空・非文字列・極端に長い場合は**`fetch` を呼ばずに** `false` を返す。
 * 呼んでしまうと、攻撃者は当校のサーバーを踏み台に Cloudflare へのリクエストを増幅できる。
 *
 * ------------------------------------------------------------------------
 * タイムアウト
 * ------------------------------------------------------------------------
 * 公開ハンドラの `maxDuration`（10秒）を外部 API の応答時間に縛らない。占有が長引くと
 * セマフォのパーミットが漏れ、その間 Tier C（202）が増える。
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Turnstile のトークン長は 2,048 文字程度が上限。余裕を見た受理上限。 */
const MAX_TOKEN_LENGTH = 4_096

/** 既定タイムアウト（ms）。`maxDuration` 10 秒に対して十分短く取る。 */
const DEFAULT_TIMEOUT_MS = 3_000

export interface VerifyTurnstileOptions {
  secret: string
  /** 発信元 IP（任意）。Cloudflare 側の判定材料。**信頼できない値は渡さない。** */
  remoteIp?: string | null
  /** テストから差し替えるための注入点。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function verifyTurnstile(
  token: unknown,
  options: VerifyTurnstileOptions,
): Promise<boolean> {
  if (typeof token !== 'string') return false
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false
  if (typeof options.secret !== 'string' || options.secret.length === 0) return false

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const body = new URLSearchParams()
    // **secret は URL クエリではなく POST ボディで送る**——クエリに載せると
    // アクセスログ・プロキシログ・Referer に秘密鍵が残る。
    body.set('secret', options.secret)
    body.set('response', token)
    if (options.remoteIp) body.set('remoteip', options.remoteIp)

    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    })

    if (!response.ok) return false
    const parsed: unknown = await response.json()
    if (typeof parsed !== 'object' || parsed === null) return false
    return (parsed as { success?: unknown }).success === true
  } catch {
    // ネットワーク例外・タイムアウト・壊れた JSON。理由に関わらず「検証できなかった」＝ false。
    return false
  } finally {
    clearTimeout(timer)
  }
}
