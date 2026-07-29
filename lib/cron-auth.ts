/**
 * cron（バッチ）エンドポイントの認可ラッパ（AC-PII-10）。
 *
 * 対象は `/api/cron/**`（`retention` は P3-d、`orphan-uploads` は P3-c の成果物）。
 * **P3-a で満たすのは本ラッパの存在と挙動まで**であり、バッチ本体の性質（件数上限200・ページング・
 * べき等性 = AC-PII-11）は対象が存在しないため後続単位で検証する。
 *
 * ------------------------------------------------------------------------
 * 2つの設計判断
 * ------------------------------------------------------------------------
 * 1. **未認証は 401 ではなく 404**。401 は「このパスは存在するが鍵が違う」ことを教える。
 *    対象は個人情報の**削除バッチ**であり、所在を晒すこと自体が攻撃の足がかりになる。
 *    シークレット未設定時も **fail-closed で 404**（素通りさせると未認証の削除エンドポイントになる）。
 *
 * 2. **`lib/public-guard.ts` の対象外**。Vercel Cron は `Origin` を送らないため、
 *    Origin fail-closed のラッパで包むと**バッチが永久に 403 で動かない**
 *    ——保持期間削除と orphan 回収が止まり、APPI 違反の温床になる（可用性が機密性に直結する例）。
 */

import { timingSafeEqual } from 'node:crypto'
import { createRateLimiter, type RateLimiter } from '@/lib/rate-limit'
import { sharedRateLimitStore } from '@/lib/runtime-stores'
import { consoleSink, createPiiSafeLogger } from '@/lib/pii-log'

const BEARER_PREFIX = 'Bearer '

/* ------------------------------------------------------------------------- *
 * SEC-046 / P3c-7 — 認可失敗の試行回数制限
 * ------------------------------------------------------------------------- *
 *
 * ⚠️ **これは「抑制」ではなく「検知」である**（REV-P3C1-006）。
 *
 * 下の 3 つ——(a) 成功は常に通す / (b) 上限到達後も正しいトークンは 200 /
 * (c) 応答は常に同じ 404——を**同時に満たす実装では、上限に達しても攻撃者の体験は
 * 1 ミリも変わらない**。正しいトークンを常に通す以上、毎回トークン比較を実行しなければならず、
 * **推測の試行回数も速度も一切制限されない。上限到達時に起きるのはログ 1 行だけ**である。
 *
 * > **本ラッパは総当たりの速度を落とさない。** 抑制は `CRON_SECRET` の長さ
 * > （`lib/env.ts` の 32 文字下限）とプラットフォーム側の流量制御に依存する。
 * > 本ラッパが足すのは**観測**（いつ・どれだけ叩かれたかが分かること）である。
 *
 * 「試行回数制限を入れた」とだけ記録すると、次の監査が「`/api/cron/**` は総当たりに対して
 * 上限がある」と読む——**そこには上限が無い。** この誤読を防ぐために本注記を残す。
 *
 * それでも入れる価値がある理由: 総当たりは**気付けなければ止められない**。
 * これが無いと `CRON_SECRET` に対する試行はどこにも記録されず、
 * 攻撃が成功するまで（＝ 個人情報が削除されるまで）誰も知り得ない。
 *
 * **なぜ硬いゲートにしないのか**: Vercel Cron は安定した発信元 IP を持たないので、
 * 軸は**単一のグローバルカウンタ**にならざるを得ない。共有バケットを硬いゲートにする形は
 * SEC-021 → SEC-029 → SEC-030 → SEC-043 と **4 度再発**しており、ここで 5 度目を作ると
 * 第三者が枠を叩くだけで保持期間削除バッチを止められる（:14-17 の「可用性が機密性に直結する例」）。
 * `lib/login-guard.ts` と同じ意味論——**失敗だけを数える。成功は常に通す。**
 */

/** 粗くてよい（抑制ではなく検知なので、正確な閾値に意味は無い）。 */
export const CRON_AUTH_ATTEMPT_LIMIT = 10
export const CRON_AUTH_WINDOW_MS = 10 * 60_000

/**
 * カウンタのキー。**要求内容から作らない。**
 * `authorization` ヘッダやトークンを材料にすると、攻撃者は値を変えるだけで新しいバケットを作れて
 * 上限を無限に回避でき、同時に store のメモリ増幅（SEC-023）の経路にもなる
 *（`lib/form-session.ts` の SEC-055 と同型の失敗）。定数にすることでこの経路を閉じる。
 */
const CRON_AUTH_ATTEMPT_KEY = 'cron:auth-failure'

/**
 * 既定の limiter / logger は**モジュール大域**である。
 *
 * `limiter` / `logger` を必須にせず既定を持たせるのは **SEC-053 の教訓**——「渡し忘れ」は
 * 最も安い事故であり、必須にすると P3-c / P3-d の cron ルートが渡し忘れたときに
 * **試行制限が存在しないまま削除バッチが公開される**。引数は差し替え（テスト・KV 化）のためにある。
 *
 * 大域状態なので、テストは `now` を注入して `CRON_AUTH_WINDOW_MS` を跨がせ、
 * **専用の窓へ退避してから**測ること（`reset` 用の export を足すより副作用が小さい / REV-P3C1-013）。
 */
const defaultAttemptLimiter = createRateLimiter({
  limit: CRON_AUTH_ATTEMPT_LIMIT,
  windowMs: CRON_AUTH_WINDOW_MS,
  // **store を渡さないとインスタンスごとに別カウンタになる**（RV-P3B-003 / P3b-2 / SEC-044）。
  // 本項目の成果物は「総当たりが観測できること」なので、インスタンスごとに分断されると
  // 上限到達が `上限 × インスタンス数` まで先送りされ、観測点としての意味が薄れる。
  store: sharedRateLimitStore(),
})
const defaultLogger = createPiiSafeLogger(consoleSink)

export interface CronAuthOptions {
  /** 既定は `process.env.CRON_SECRET`。未設定なら常に 404（fail-closed）。 */
  secret?: string
  /** **省略時は内蔵の既定 limiter**（渡し忘れで制限が消える形を作らない / SEC-053）。 */
  limiter?: RateLimiter
  now?: () => number
  logger?: { warn(event: string, fields: Record<string, unknown>): void }
}

/** 経路の存在を教えない応答。認可失敗と「そんなパスは無い」を区別できないようにする。 */
function notFound(): Response {
  return Response.json({ error: 'not found' }, { status: 404 })
}

/**
 * 定数時間比較。**素の `===` は先頭一致長で早期 return する**ため、応答時間から1文字ずつ
 * 復元できる（`lib/password.ts` が同じ理由で `timingSafeEqual` を使っている）。
 * 長さが違う場合は比較自体が成立しないので先に弾く（長さは秘密ではない）。
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function withCronAuth<Ctx = unknown>(
  handler: (request: Request, ctx: Ctx) => Promise<Response>,
  options: CronAuthOptions = {},
): (request: Request, ctx: Ctx) => Promise<Response> {
  const limiter = options.limiter ?? defaultAttemptLimiter
  const logger = options.logger ?? defaultLogger
  const now = options.now ?? Date.now

  /**
   * 認可失敗を 1 件計数する。**判定には使わない**（返り値を応答に反映しない）。
   * 上限到達を `warn` に出すのが本ラッパの成果物である。
   */
  async function recordFailure(): Promise<void> {
    const result = await limiter.consume(CRON_AUTH_ATTEMPT_KEY, now())
    if (result.success) return
    // **ログに試行値もシークレットも載せない**（AC-PII-1 / `lib/pii-log.ts`）。
    // 出すのは「上限に達した」という事実と窓の情報だけ。
    logger.warn('cron-auth.attempt_limit', {
      limit: result.limit,
      windowMs: CRON_AUTH_WINDOW_MS,
      resetAt: result.resetAt,
    })
  }

  return async (request, ctx) => {
    const expected = 'secret' in options ? options.secret : process.env.CRON_SECRET
    // シークレット未設定は**構成の失敗**であって推測の試行ではない。計数しても総当たりの
    // 観測にならず、fail-closed で全要求が 404 になるので上限が即座に埋まり
    // 「上限到達」ログが実際の攻撃と区別できなくなる。計数せずに落とす。
    if (!expected) return notFound()

    const authorization = request.headers.get('authorization')
    const token =
      authorization && authorization.startsWith(BEARER_PREFIX)
        ? authorization.slice(BEARER_PREFIX.length)
        : null

    // **成功は常に通す・カウンタを消費しない。**
    // 消費すると、毎時走る正規バッチ自身が枠を食い潰して**自分で自分を締め出す**
    //（保持期間削除が止まる = APPI 違反の温床）。
    // また上限到達後もこの比較へ到達するので、**正しいトークンは常に 200** になる。
    if (token !== null && constantTimeEquals(token, expected)) {
      return handler(request, ctx)
    }

    // 欠落・スキーマ違い・誤ったトークンをすべて同じ 1 件として数える（安い失敗を数え漏らさない）。
    await recordFailure()
    // **応答は常に同じ 404。`Retry-After` も付けない。**
    // 上限到達だけ 429 を返すと、攻撃者は 429 から「鍵は総当たりで到達しうる」「窓は N 分」を学び、
    // さらに **404 と 429 の境目から `CRON_SECRET` の存在自体**を判別できる。
    return notFound()
  }
}
