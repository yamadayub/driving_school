/**
 * 公開（未認証）変更系ハンドラの共通ラッパ（SEC-037 / AC-RL-7 / AC-RL-12 / AC-010-14）。
 *
 * ------------------------------------------------------------------------
 * なぜ `app/api/admin/_guard.ts` と別に置くのか
 * ------------------------------------------------------------------------
 * `withAdminMutation` は `@/auth`（Prisma + `getServerEnv()` のトップレベル副作用）に依存する。
 * 公開エンドポイントは**認証に依存してはならない**——依存すると P3 の未認証経路が管理系の認証基盤に
 * 縛られ、単体テストから読めなくなる。SEC-037 が要求しているのは「**認証非依存**のラッパ」である。
 *
 * ------------------------------------------------------------------------
 * 評価順序（AC-RL-7。この順序自体が受け入れ条件）
 * ------------------------------------------------------------------------
 *   1. Origin 検証（fail-closed / 403）
 *   2. Content-Type 検証（415）
 *   3. **content-length による事前のボディ上限判定（413）** — ヘッダだけで判る超過は無料で落とす
 *   4. Tier D: 攻撃者自身に閉じた軸（発信元・フォームセッション）の窓上限 → 429
 *      **縮退時（`trusted === false`）の発信元軸は計数のみ**（`sourceAxisFor` / SEC-043）。
 *      その代わり、縮退時に別軸（`verifyFormSession`）が無ければ Tier B へ降格する（条件1'-3）。
 *   5. **実バイト数によるボディ上限の強制（413）** — レート制限済みの相手にメモリを使わせない
 *   6. Tier B: 疑わしいシグナル（フォームセッション Cookie 不正）→ 403 { challenge }
 *   7. Tier C: 共有軸（セマフォ）の枯渇 → 202 { retryAfterMs }
 *   8. 本体
 *
 * レート制限を本体より前に置くのは、**DB 書き込みとファイル I/O を攻撃者に消費させない**ため。
 * 3 と 5 が分かれているのも同じ理由である。ヘッダで判る超過は最も安く落とせるので先に落とし、
 * ヘッダを出さない相手（`Transfer-Encoding: chunked`）に対する実測はレート制限の後に置く
 * ——先に置くと、すでに Tier D に達している攻撃者が毎回 64KB の読み取りを強制できてしまう。
 * 5 を Tier B / C より前に置くのは、**413 は Tier ではない失敗**なので `challenge` に埋もれさせず、
 * かつ上限超過のボディにセマフォのパーミットを占有させないため。
 *
 * ------------------------------------------------------------------------
 * 持ち込まないもの（条件1' / SEC-039 / SEC-041）
 * ------------------------------------------------------------------------
 *  - **共有軸の枯渇を「拒否」にしない。** セマフォ枯渇は 429 ではなく Tier C（202）である。
 *    公開エンドポイントで共有軸を硬いゲートにすると、枯渇がそのままサービス停止になる（P2.5 の教訓）。
 *  - **`reset-on-success` を持ち込まない。** 送信成功でカウンタをリセットすると、正常系が頻繁に
 *    成功する公開経路では攻撃者に無料枠を与えるのと同義になる。
 *  - **「カウント0 = 予約枠の資格」型の判定を持ち込まない**（管理者ログイン専用の機構であり、
 *    公開経路では退避による資格復活の経路になる）。
 */

import { createHash } from 'node:crypto'
import { isSameOrigin, resolveClientIp } from '@/lib/http-guard'
import type { ClientIpResolution } from '@/lib/http-guard'
import type { PerRequesterKey } from '@/lib/form-session'
import { rateLimitKey, type RateLimiter } from '@/lib/rate-limit'
import type { SemaphoreEndpoint, SemaphorePermit } from '@/lib/semaphore'

/**
 * 公開エンドポイントが受け取るリクエストボディの既定上限（P3b-8）。
 *
 * 上限が無いと、**レート制限が許す1回あたりのコスト（パースとバリデーションの CPU / メモリ）を
 * 攻撃者が自由に決められる**。各ルートで別々の値を書かせないために定数として公開する。
 */
export const MAX_PUBLIC_REQUEST_BODY_BYTES = 64 * 1024

/* ------------------------------------------------------------------------- *
 * 発信元軸（SEC-043 / RV-P3A-001）
 * ------------------------------------------------------------------------- */

/**
 * 発信元軸のゲート判断。**`ClientIpResolution` 全体からしか作れない**（`sourceAxisFor` 経由のみ）。
 *
 * `enforce` は「この軸の `success:false` を 429 の理由に使ってよいか」を表す。
 * `trusted === false`（＝全利用者が共有する単一 `unknown` バケット）のときは false になり、
 * **計数は続けるがゲートには使わない**（`lib/login-guard.ts:129-142` と同じ意味論）。
 */
export interface SourceAxis {
  readonly key: string
  readonly enforce: boolean
}

/**
 * 発信元軸を組み立てる。**縮退（`trusted === false`）の判定をここ 1 箇所に閉じる。**
 *
 * 第 2 引数は `string` ではなく `ClientIpResolution` である。これは注意書きではなく**型の継ぎ目**で、
 * `clientIp(request).key` のように `trusted` を捨てた呼び出しは `pnpm type-check` で落ちる。
 * SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度繰り返した「共有軸の枯渇を照合前の硬いゲートに
 * してしまう」欠陥は、`lib/http-guard.ts:86-94` の名指しの警告コメントでは止められなかった。
 * したがって**呼び出し側が読まなくても効く形**（型と、判定を閉じ込めた 1 つの関数）にしてある。
 */
export function sourceAxisFor(
  endpoint: SemaphoreEndpoint,
  resolution: ClientIpResolution,
): SourceAxis {
  return { key: rateLimitKey(`${endpoint}:`, resolution.key), enforce: resolution.trusted }
}

/**
 * Tier B の応答本文（AC-RL-12(a) / 契約ルール3）。
 * **降格理由（Cookie 不在 / 署名不正 / 期限切れ / 送信間隔 / ハニーポット）を区別できないようにする**
 * ——bot に判定基準を教えないため、全ての Tier B がこの1つの本文を返す。
 */
export const TIER_B_BODY = { challenge: 'interactive' } as const

/** E2E 用フックが本番へ漏れないことを固定するための上限（ms）。 */
const TEST_HOOK_MAX_RETRY_AFTER_MS = 2_000
const TEST_HOOK_MIN_RETRY_AFTER_MS = 1_000

/** ジッタの幅（±20%）。Tier 表の契約ルール4。 */
const JITTER_RATIO = 0.2

/**
 * `retryAfterMs` に ±20% のジッタを掛ける（AC-RL-12(c) / 契約ルール4）。
 * **サーバーが値を返す**（クライアントが決めない）。ジッタは thundering herd（全員が同じ秒に
 * 再送して二次的な輻輳を作る）を避けるためにある。
 *
 * **テスト用フック（契約ルール6）**: `CI=1` かつ**非本番**のときだけ 1〜2秒へ丸める
 * （E2E が実時間を待たないため）。**本番では効かない**——効いてしまうと攻撃者が待ち時間を
 * 1〜2秒に固定でき、Tier C / D の抑制効果が消える。
 */
export function jitteredRetryAfterMs(baseMs: number, random: () => number = Math.random): number {
  const jittered = Math.round(baseMs * (1 - JITTER_RATIO + random() * JITTER_RATIO * 2))
  if (!isTestRetryAfterHookEnabled()) return jittered
  const span = TEST_HOOK_MAX_RETRY_AFTER_MS - TEST_HOOK_MIN_RETRY_AFTER_MS
  // 短い基準値（テストが検証するジッタ範囲）は縮めない。長い待ちだけを E2E 用に丸める。
  return Math.min(jittered, TEST_HOOK_MIN_RETRY_AFTER_MS + Math.floor(random() * (span + 1)))
}

function isTestRetryAfterHookEnabled(): boolean {
  return process.env.CI === '1' && process.env.NODE_ENV !== 'production'
}

export type PublicGuardTier = 'B' | 'C' | 'D'

export interface PublicGuardLogger {
  warn(event: string, fields: Record<string, unknown>): void
}

/** セマフォのうち本ラッパが使う部分だけ（テストからフェイクを差し込めるように最小化する）。 */
export interface PublicGuardSemaphore {
  acquireWithWait(options: {
    now: () => number
    sleep: (ms: number) => Promise<void>
    random?: () => number
  }): Promise<{ permit: SemaphorePermit | null }>
  release(permit: SemaphorePermit): Promise<void>
}

export interface PublicGuardOptions {
  endpoint: SemaphoreEndpoint
  /** `'json'` を指定すると、プリフライト無しの CORS 単純リクエスト経路（CSRF）を塞ぐ。 */
  requireContentType?: 'json'
  /**
   * Tier D の軸（**攻撃者自身に閉じた軸**のみ）。共有軸はここに入れない。
   * `formSession` は `formSessionKey` が値を返せるときだけ評価される（配線は P3-b）。
   */
  limiters?: { source?: RateLimiter; formSession?: RateLimiter }
  /**
   * フォームセッション軸のキー。`null` を返すと当該軸は評価しない。
   *
   * **戻り値は `PerRequesterKey`（branded type）であって素の `string` ではない**（SEC-052）。
   * 監査は `?? 'anonymous'` のような固定値フォールバックを持つ配線で、`trusted=true` の通常構成
   * でも「攻撃者3回 → 無関係な利用者が 429」を実測した。素の `string` を許すとその配線が
   * 型検査を通ってしまうため、**共有キーを返せない型**にしてある。
   */
  formSessionKey?: (request: Request) => PerRequesterKey | null
  /**
   * リクエストボディのバイト数上限（P3b-8）。省略時 `MAX_PUBLIC_REQUEST_BODY_BYTES`。
   * 超過は **413**。これは Tier ではない失敗なので `challenge` を含めない（契約ルール7）
   * ——413 を Tier B として返すと、CAPTCHA を解いて再送しても同じ 413 が返る
   * **抜けられないループ**になる。
   */
  maxBodyBytes?: number
  /**
   * Tier B の判定。`false` を返すと `403 { challenge: 'interactive' }`。
   * **例外を投げても 500 にはならない**（ラッパが握って Tier B へ落とす / SEC-042）。
   */
  verifyFormSession?: (request: Request, now: number) => boolean
  /** Tier C の共有軸。 */
  semaphore?: PublicGuardSemaphore
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  logger?: PublicGuardLogger
  /**
   * 発信元の解決。**`ClientIpResolution` を分解せずに返すこと**（SEC-043）。
   * `{ key: string }` のような緩い型にすると、呼び出し側が再び `.key` だけを使えるようになる。
   */
  clientIp?: (request: Request) => ClientIpResolution
}

const FORBIDDEN = () => Response.json({ error: 'forbidden' }, { status: 403 })
const UNSUPPORTED_MEDIA_TYPE = () =>
  Response.json({ error: 'unsupported media type' }, { status: 415 })

/**
 * ボディ上限超過（413）。**`challenge` を含めず `Retry-After` も付けない**
 * ——`challenge` の有無だけが Tier B との判別材料である（契約ルール7 / AC-RL-12(e)）。
 */
const PAYLOAD_TOO_LARGE = () => Response.json({ error: 'payload too large' }, { status: 413 })

/**
 * Tier B（403 + `challenge`）。
 * **`challenge` を持たない 403（Origin 検証失敗等）を Tier B として扱ってはならない**
 * ——クライアントが CAPTCHA を出し、解いて再送してもまた同じ 403 が返る**抜けられないループ**に
 * なる（AC-RL-12(e) / 契約ルール7）。
 */
const TIER_B = () => Response.json(TIER_B_BODY, { status: 403 })

/** Tier C（202）。**`Retry-After` ヘッダは付けない**（Tier D との契約混同を防ぐ）。 */
const TIER_C = (retryAfterMs: number) => Response.json({ retryAfterMs }, { status: 202 })

/** Tier D（429 + `Retry-After`）。 */
const TIER_D = (retryAfterMs: number) =>
  Response.json(
    { retryAfterMs },
    { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
  )

/**
 * ログ用のキー相関値。**生の IP / `sid` は出さない**（AC-RL-10 / AC-PII-1）。
 * 出してよいのは軸名・キーのハッシュ先頭8文字・判定結果だけである。
 */
function keyDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('content-type')
  if (!contentType) return false
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

export function withPublicMutation<Ctx = unknown>(
  handler: (request: Request, ctx: Ctx) => Promise<Response>,
  options: PublicGuardOptions,
): (request: Request, ctx: Ctx) => Promise<Response> {
  const {
    endpoint,
    requireContentType,
    limiters,
    formSessionKey,
    verifyFormSession,
    semaphore,
    logger,
  } = options
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const clientIp = options.clientIp ?? ((request: Request) => resolveClientIp(request))
  const maxBodyBytes = options.maxBodyBytes ?? MAX_PUBLIC_REQUEST_BODY_BYTES

  /*
   * ------------------------------------------------------------------------
   * 構築時検査（P3b-1 / SEC-053）
   * ------------------------------------------------------------------------
   * **「渡し忘れ」は最も安い事故であり、振る舞いテストでは検出できない**——渡し忘れた構成は
   * `trusted=true` の環境では正常に見えるためである。縮退構成（`trusted=false`）では
   * 発信元軸が計数のみになるので、`formSession` 軸を渡し忘れると **enforce される Tier D 軸が
   * 1つも無くなり、単一の攻撃者が窓あたり無制限に DB 書き込みとメール送信を発生させられる**
   * （監査 D-1 の実測: 500 回送信 → 201 × 500）。
   *
   * `trusted` と違いオプションの有無は**構築時に分かる**ため、リクエスト毎の判定を避けた
   * 過去の判断（SEC-043 の是正）はここには当てはまらない。
   *
   * 検査は「**軸に関するオプションを1つでも渡した**のに formSession 軸が完成していない」
   * という条件で効かせる。ラッパを Origin / Content-Type 検証だけに使う経路（何も渡さない構成）は
   * 壊さない——そこを落とすと **Impl が検査そのものを外す動機**になる（過剰な検査は守られない）。
   *
   * **なぜ入口を `limiters?.source` から広げたのか（SEC-058 / P3c-2）**
   * 旧実装は `if (limiters?.source)` を入口にしていたため、**`limiters.source` 自体を
   * 書き忘れた構成が検査を丸ごと素通りしていた**。すなわち
   *   `limiters: { formSession: x }` だけ（`formSessionKey` 忘れ）＝ 下表 (c)
   *   `formSessionKey: x` だけ（`limiters` 丸ごと忘れ）＝ 下表 (d)
   * のどちらも例外も警告も無く通り、:324 が両方揃ったときにしか軸を push しない以上
   * **Tier D 軸が 1 つも無い公開変更系エンドポイント**が本番へ出る。
   * P3-c は `uploads`（免許証写真）という 2 つ目の公開変更系ルートを作るので、
   * そこで起きると SEC-057 の「無制限に DB 行」が
   * 「無制限にオブジェクトストレージへ書き込み」になる（監査 §F 理由 2）。
   *
   * | # | source | formSession | formSessionKey | 期待 |
   * |---|---|---|---|---|
   * | (0) | — | — | — | throw しない（軸を最初から持たない） |
   * | (a) | ✓ | — | — | throw |
   * | (b) | ✓ | ✓ | — | throw |
   * | (b') | ✓ | — | ✓ | throw |
   * | (c) | — | ✓ | — | throw（SEC-058 で追加） |
   * | (d) | — | — | ✓ | throw（SEC-058 で追加） |
   * | (e) | — | ✓ | ✓ | throw しない（軸として完全） |
   * | (f) | ✓ | ✓ | ✓ | throw しない |
   *
   * **原則: 軸は「完成している」か「最初から無い」かのどちらかであること。**
   * 検査が禁じるのは「半端」であって「少ない」ではない——(e) を許すのは、
   * uploads が独自の軸構成（発信元軸を持たない）を選べるようにするためである。
   */
  if (limiters?.source || limiters?.formSession || formSessionKey) {
    if (!limiters?.formSession) {
      throw new Error(
        `withPublicMutation(${endpoint}): 軸を渡す構成では limiters.formSession が必須です` +
          '（縮退構成では発信元軸が計数のみになり、Tier D に enforce される軸が消える / P3b-1 / SEC-053 / SEC-058）',
      )
    }
    if (!formSessionKey) {
      throw new Error(
        `withPublicMutation(${endpoint}): limiters.formSession を渡す構成では formSessionKey が必須です` +
          '（両方揃ったときにしか軸を作らないため、片側だけだと軸が静かに無効化される / P3b-1 / SEC-058）',
      )
    }
  }

  function deny(tier: PublicGuardTier, axis: string, key: string): void {
    logger?.warn('public-guard.denied', { tier, axis, endpoint, keyHash: keyDigest(key) })
  }

  /**
   * `content-length` ヘッダによる事前判定。**ヘッダが無い / 数値でない場合は判定しない**
   *（判定できないことを「上限内」と見なすのではなく、実バイト数の強制へ委ねる）。
   */
  function declaredBodyBytes(request: Request): number | null {
    const raw = request.headers.get('content-length')
    if (raw === null) return null
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    return parsed
  }

  return async (request, ctx) => {
    // 1) CSRF（fail-closed）。**この 403 に `challenge` を付けない。**
    if (!isSameOrigin(request)) return FORBIDDEN()

    // 2) 単純リクエスト化の封じ。
    if (requireContentType === 'json' && !isJsonContentType(request)) {
      return UNSUPPORTED_MEDIA_TYPE()
    }

    // 3) content-length による事前判定。**レート制限より前**——ヘッダだけで判る超過は
    //    ボディを1バイトも読まずに落とせる（最も安い防御を最初に置く）。
    const declared = declaredBodyBytes(request)
    if (declared !== null && declared > maxBodyBytes) {
      deny('D', 'body-size-declared', `${endpoint}:body`)
      return PAYLOAD_TOO_LARGE()
    }

    const at = now()

    // 4) Tier D: 攻撃者自身に閉じた軸。**本体より前**に評価する（DB / I/O を消費させない）。
    //
    //    軸の要素型は `enforce` を**必須**にしてある。新しい軸を足す人は「この軸の枯渇を拒否理由に
    //    してよいか」を必ず書くことになり、共有軸を無自覚に硬いゲートへ昇格させられない（SEC-043）。
    const resolved = clientIp(request)
    const axes: Array<{ axis: string; limiter: RateLimiter; key: string; enforce: boolean }> = []
    if (limiters?.source) {
      // 縮退判定は `sourceAxisFor` の中だけにある。ここに if 文を置かない。
      const source = sourceAxisFor(endpoint, resolved)
      axes.push({ axis: 'source', limiter: limiters.source, key: source.key, enforce: source.enforce })
    }
    if (limiters?.formSession && formSessionKey) {
      // 材料（Cookie）は攻撃者が完全に制御する。例外は失敗ではなく劣化にする（SEC-042）。
      let raw: string | null
      try {
        raw = formSessionKey(request)
      } catch {
        deny('B', 'formSession-error', `${endpoint}:challenge`)
        return TIER_B()
      }
      if (raw !== null) {
        axes.push({
          axis: 'formSession',
          limiter: limiters.formSession,
          // Cookie 軸は**攻撃者自身に閉じている**（共有バケットではない）のでゲートに使える。
          enforce: true,
          key: rateLimitKey(`${endpoint}:fs:`, raw),
        })
      }
    }
    for (const { axis, limiter, key, enforce } of axes) {
      // 計数は常に行う——ゲートに使わない軸でも、攻撃の観測手段（メトリクス・監査ログ）は失わない。
      const result = await limiter.consume(key, at)
      if (!result.success && enforce) {
        deny('D', axis, key)
        return TIER_D(jitteredRetryAfterMs(result.retryAfterMs, random))
      }
    }

    // 4') 条件1'-3: 縮退時（`trusted === false`）は per-source ゲートが使えないため、
    //     **代わりの軸を必ず要求する**。素通りさせない（無制限に通る）／429 にもしない
    //     （それでは「共有軸の枯渇を拒否にしない」という是正そのものを打ち消す）。
    if (!resolved.trusted && !verifyFormSession) {
      deny('B', 'degraded-no-second-axis', `${endpoint}:challenge`)
      return TIER_B()
    }

    // 5) 実バイト数によるボディ上限の強制（P3b-8）。
    //    **レート制限の後**——先に置くと、すでに Tier D に達している攻撃者が
    //    毎回 `maxBodyBytes` ぶんの読み取りを強制できる（「本体より前に落とす」が無効化される）。
    //    **Tier B / Tier C より前**——413 は Tier ではない失敗なので `challenge` に埋もれさせず、
    //    かつ上限超過のボディにセマフォのパーミットを占有させない。
    const measured = await enforceBodyBytes(request, maxBodyBytes)
    if (measured === null) {
      deny('D', 'body-size-actual', `${endpoint}:body`)
      return PAYLOAD_TOO_LARGE()
    }

    // 6) Tier B: 疑わしいシグナル。降格理由は応答からもログからも区別できない。
    //    判定関数の例外も Tier B に落とす——応答は正常な Tier B と**完全に一致**させること
    //    （例外時だけ応答が変われば、bot に「どの入力が内部エラーを起こすか」を教える / SEC-042）。
    if (verifyFormSession) {
      let verified: boolean
      try {
        verified = verifyFormSession(measured, at)
      } catch {
        deny('B', 'formSession-error', `${endpoint}:challenge`)
        return TIER_B()
      }
      if (!verified) {
        deny('B', 'formSession', `${endpoint}:challenge`)
        return TIER_B()
      }
    }

    // 7) Tier C: 共有軸。**枯渇は拒否ではなく待ち**（最大2秒）→ なお空かなければ 202。
    let permit: SemaphorePermit | null = null
    if (semaphore) {
      const waited = await semaphore.acquireWithWait({ now, sleep, random })
      permit = waited.permit
      if (permit === null) {
        deny('C', 'semaphore', `${endpoint}:semaphore`)
        return TIER_C(jitteredRetryAfterMs(1_000, random))
      }
    }

    // 8) 本体。**例外経路でも必ず release する**——漏れの主因は例外とタイムアウトであり、
    //    リースによる回復は保険であって既定経路ではない。
    try {
      return await handler(measured, ctx)
    } finally {
      if (semaphore && permit) await semaphore.release(permit)
    }
  }
}

/**
 * 実バイト数でボディ上限を強制し、**handler が読み直せる Request** を返す。上限超過は `null`。
 *
 * ------------------------------------------------------------------------
 * なぜ実測が要るのか
 * ------------------------------------------------------------------------
 * `content-length` は攻撃者が申告する値であり、`Transfer-Encoding: chunked` では**そもそも
 * 存在しない**。ヘッダだけを見る上限チェックは HTTP/1.1 でも HTTP/2 でも迂回できる。
 *
 * ------------------------------------------------------------------------
 * なぜ Request を作り直すのか
 * ------------------------------------------------------------------------
 * 計測のためにストリームを消費すると、handler の `request.json()` が
 * `Body is unusable` で失敗する——**上限を入れた副作用で全送信が壊れる**。
 * 読み取ったバイト列から等価な `Request` を組み立てて渡す（`clone()` は
 * ストリームを tee するだけで、上限超過時に読み切らずに済ませることができない）。
 *
 * **バイト数で数える**（文字数ではない）。UTF-8 では 1 文字が最大 4 バイトになるため、
 * 文字数で数えると上限の 3〜4 倍のボディを通してしまう（SEC-042 と同型のずれ）。
 *
 * ------------------------------------------------------------------------
 * なぜ「読み切ってから比べる」ではいけないのか（RV-P3B-006 / SEC-059）
 * ------------------------------------------------------------------------
 * `await request.arrayBuffer()` はストリームを**最後まで消費する**。したがって
 * `Transfer-Encoding: chunked` で 128MB を送りつけられると、**128MB をメモリに載せてから**
 * 413 を返すことになる（監査の実測）。413 が返ること自体は上限の**検出**でしかなく、
 * 上のコメントと `:20` / `:360-364` が約束している「**メモリを使わせない**」は成立しない。
 * 「検出できる」と「消費させない」は別の性質であり、実装とコメントが食い違ったまま残ると
 * 次に読む人が防御済みだと誤認する。
 *
 * そこでリーダで逐次読み、**上限を跨いだ時点で `cancel()` して残りを読まない**。
 * `cancel()` を省くと、検出後もアップストリームが読み進めるので防御にならない。
 */
async function enforceBodyBytes(request: Request, maxBodyBytes: number): Promise<Request | null> {
  if (request.body === null) return request

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > maxBodyBytes) {
      // **残りを読まずに打ち切る。** ここが「消費させない」の実体である。
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks),
  })
}
