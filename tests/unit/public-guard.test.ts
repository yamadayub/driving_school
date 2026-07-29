import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter } from '@/lib/rate-limit'
import { withPublicMutation, jitteredRetryAfterMs, TIER_B_BODY } from '@/lib/public-guard'
import { formSessionAxisKey } from '@/lib/form-session'
import type { ClientIpResolution } from '@/lib/http-guard'
import { seededRandom } from './helpers/seeded-random'

/**
 * =========================================================================
 * P3-a — AC-RL-7 / AC-RL-12 / AC-RL-2 / AC-RL-10 / AC-010-14（ラッパ単体）
 * `lib/public-guard.ts`（認証非依存の公開変更系ラッパ）
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 §4.11 Tier 表:1496-1514 / AC-RL-7:1526 /
 *       AC-RL-12:1531 / AC-RL-2:1521 / AC-RL-10:1529 / AC-010-14:797。
 *
 * ## red 理由
 * `lib/public-guard.ts` が存在しないため import 解決に失敗する。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * export const TIER_B_BODY: { challenge: 'interactive' }   // Tier B の本文はこれ「だけ」
 * export function jitteredRetryAfterMs(baseMs: number, random?: () => number): number
 *
 * export interface PublicGuardOptions {
 *   endpoint: 'applications' | 'uploads' | 'chat'
 *   requireContentType?: 'json'
 *   // Tier D（攻撃者自身に閉じた軸）
 *   limiters?: { source?: RateLimiter; formSession?: RateLimiter }
 *   // Tier B（疑わしいシグナル）。false を返したら 403 { challenge }
 *   verifyFormSession?: (request: Request, now: number) => boolean
 *   // Tier C（共有軸 = セマフォ）
 *   semaphore?: { acquireWithWait(o): Promise<{ permit: P | null }>; release(p: P): Promise<void> }
 *   now?: () => number
 *   random?: () => number
 *   sleep?: (ms: number) => Promise<void>
 *   logger?: { warn(event: string, fields: Record<string, unknown>): void }
 *   clientIp?: (request: Request) => ClientIpResolution   // SEC-043 で型を絞った（分解させない）
 * }
 * export function withPublicMutation<Ctx>(
 *   handler: (request: Request, ctx: Ctx) => Promise<Response>,
 *   options: PublicGuardOptions,
 * ): (request: Request, ctx: Ctx) => Promise<Response>
 * ```
 *
 * **評価順序（AC-RL-7）**: `Origin 検証(fail-closed) → Content-Type 検証 → レート制限 → 本体`。
 * レート制限を本体より前に置くのは、DB アクセスとファイル I/O を攻撃者に消費させないため。
 */

const ORIGIN = 'https://example.test'
const T0 = 1_800_000_000_000

function request(init: { origin?: string | null; contentType?: string | null; cookie?: string } = {}) {
  const headers = new Headers()
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN)
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  return new Request(`${ORIGIN}/api/applications`, { method: 'POST', headers, body: '{}' })
}

function okHandler() {
  return vi.fn(async () => new Response(JSON.stringify({ id: 'app_1' }), { status: 201 }))
}

/** 常に空きがあるセマフォ（Tier C を出さない）。 */
function freeSemaphore() {
  return {
    acquireWithWait: async () => ({ permit: { key: 'sem:{applications}:0', permitId: 'p' } }),
    release: vi.fn(async () => {}),
  }
}

/** 常に満杯のセマフォ（Tier C を出す）。 */
function fullSemaphore() {
  return {
    acquireWithWait: async () => ({ permit: null, waitedMs: 2000, attempts: 12 }),
    release: vi.fn(async () => {}),
  }
}

/**
 * P3b-1（SEC-053）の構築時検査を満たすための別軸。
 *
 * `withPublicMutation` は `limiters.source` を渡した構成で `limiters.formSession` /
 * `formSessionKey` が欠けていると**構築時に throw** するようになった（縮退構成で
 * enforce される Tier D 軸が消えるのを防ぐため）。**本ファイルの `request()` は
 * `__Host-fs` Cookie を送らないため `formSessionAxisKey` は常に `null` を返し、
 * 各テストが検証している発信元軸の振る舞いは変わらない。**
 */
const formSessionAxis = () => createRateLimiter({ limit: 1_000, windowMs: 60_000 })

const baseOptions = () => ({
  endpoint: 'applications' as const,
  requireContentType: 'json' as const,
  formSessionKey: formSessionAxisKey,
  // SEC-058（P3-c1）: 構築時検査の入口が `limiters?.source` から
  // 「軸に関するオプションを 1 つでも渡したか」へ広がったため、`formSessionKey` **だけ**の
  // 構成（旧 baseOptions）は半端な軸として構築時 throw になる。
  // ここは fixture であって assertion ではない——**本ファイルの request() は
  // `__Host-fs` Cookie を送らない**（送っているのは `fs=`）ので `formSessionAxisKey` は
  // 常に null を返し、formSession 軸は 1 度も push されない。よって各テストが検証している
  // 発信元軸・Tier・評価順序の振る舞いは 1 ミリも変わらない。
  limiters: { formSession: formSessionAxis() },
  now: () => T0,
  random: seededRandom(11),
  semaphore: freeSemaphore(),
  // SEC-043: `clientIp` は `ClientIpResolution` を**分解せずに**返す（`trusted` を捨てさせない）。
  clientIp: (): ClientIpResolution => ({
    key: '198.51.100.5',
    trusted: true,
    source: 'x-forwarded-for',
  }),
})

/* ========================================================================= *
 * AC-RL-7 — 評価順序
 * ========================================================================= */

describe('AC-RL-7 / SEC-037: 評価順序は Origin → Content-Type → レート制限 → 本体', () => {
  it('Origin 欠落は fail-closed で 403（本体を呼ばない）', async () => {
    const handler = okHandler()
    const guarded = withPublicMutation(handler, baseOptions())
    const response = await guarded(request({ origin: null }), undefined)
    expect(response.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('クロスオリジンは 403（本体を呼ばない）', async () => {
    const handler = okHandler()
    const guarded = withPublicMutation(handler, baseOptions())
    const response = await guarded(request({ origin: 'https://evil.test' }), undefined)
    expect(response.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('Content-Type 不一致は 415（単純リクエスト化の封じ）', async () => {
    const handler = okHandler()
    const guarded = withPublicMutation(handler, baseOptions())
    const response = await guarded(request({ contentType: 'text/plain' }), undefined)
    expect(response.status).toBe(415)
    expect(handler).not.toHaveBeenCalled()
  })

  it('レート制限は本体より前に評価される（DB / I/O を攻撃者に消費させない）', async () => {
    // これが green なら排除される: 本体でレコードを作ってからレート制限を判定する実装
    //（攻撃者に DB 書き込みを消費させ続けられる）。
    const handler = okHandler()
    const source = createRateLimiter({ limit: 1, windowMs: 60_000 })
    const guarded = withPublicMutation(handler, { ...baseOptions(), limiters: { source, formSession: formSessionAxis() } })

    expect((await guarded(request(), undefined)).status).toBe(201)
    const second = await guarded(request(), undefined)
    expect(second.status).toBe(429)
    expect(handler, '拒否されたリクエストで本体が呼ばれてはならない').toHaveBeenCalledTimes(1)
  })

  it('正常系は本体の応答をそのまま返し、セマフォのパーミットを解放する', async () => {
    const semaphore = freeSemaphore()
    const guarded = withPublicMutation(okHandler(), { ...baseOptions(), semaphore })
    const response = await guarded(request(), undefined)
    expect(response.status).toBe(201)
    expect(semaphore.release, '処理完了時に release する（リースは保険であって既定経路ではない）').toHaveBeenCalledTimes(1)
  })

  it('本体が throw してもパーミットを解放する（漏れの主因を潰す）', async () => {
    const semaphore = freeSemaphore()
    const guarded = withPublicMutation(
      async () => {
        throw new Error('boom')
      },
      { ...baseOptions(), semaphore },
    )
    await expect(guarded(request(), undefined)).rejects.toThrow()
    expect(semaphore.release).toHaveBeenCalledTimes(1)
  })
})

/* ========================================================================= *
 * AC-RL-12 — Tier のワイヤ契約
 * ========================================================================= */

describe('AC-RL-12(a): Tier B / C / D のステータスと本文形状（Tier 表が唯一の真実源）', () => {
  it('Tier B は 403 で本文が { challenge: "interactive" } のみ', async () => {
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      verifyFormSession: () => false,
    })
    const response = await guarded(request(), undefined)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(TIER_B_BODY).toEqual({ challenge: 'interactive' })
  })

  it('Tier C は 202 で本文が { retryAfterMs }（Retry-After ヘッダは付けない）', async () => {
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      semaphore: fullSemaphore(),
    })
    const response = await guarded(request(), undefined)
    expect(response.status).toBe(202)
    const body = (await response.json()) as Record<string, unknown>
    expect(typeof body.retryAfterMs).toBe('number')
    expect(body.challenge, 'Tier C は challenge を含まない').toBeUndefined()
  })

  it('Tier D は 429 + Retry-After ヘッダ + { retryAfterMs }', async () => {
    const source = createRateLimiter({ limit: 0, windowMs: 60_000 })
    const guarded = withPublicMutation(okHandler(), { ...baseOptions(), limiters: { source, formSession: formSessionAxis() } })
    const response = await guarded(request(), undefined)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after'), 'Tier D だけが Retry-After を持つ').not.toBeNull()
    const body = (await response.json()) as Record<string, unknown>
    expect(typeof body.retryAfterMs).toBe('number')
  })

  it('`200 + challengeRequired` を使わない（契約ルール1）', async () => {
    // これが green なら排除される: 成功系ステータスに「作成されなかった」意味を重ねる実装。
    // クライアントがボディのフィールド有無で成功判定することになり、
    // 「利用者の入力を絶対に失わせない」経路の成功判定を最も壊れやすい形にしてしまう。
    for (const options of [
      { ...baseOptions(), verifyFormSession: () => false },
      { ...baseOptions(), semaphore: fullSemaphore() },
    ]) {
      const response = await withPublicMutation(okHandler(), options)(request(), undefined)
      if (response.status === 200) {
        expect.unreachable('劣化応答に 200 を使ってはならない')
      }
      const body = (await response.json()) as Record<string, unknown>
      expect(body.challengeRequired).toBeUndefined()
    }
  })
})

describe("AC-RL-12(b): 共有軸の枯渇だけを理由に 429 を返さない（条件1'-1）", () => {
  it('セマフォ枯渇時の応答は 429 ではなく 202', async () => {
    // これが green なら排除される: 共有軸（グローバル／セマフォ）の枯渇を「拒否」に落とす実装。
    // 公開エンドポイントでは共有軸の拒否が**そのままサービス停止**になる（P2.5 の教訓）。
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      semaphore: fullSemaphore(),
    })
    const response = await guarded(request(), undefined)
    expect(response.status).not.toBe(429)
    expect(response.status).toBe(202)
    expect(response.headers.get('retry-after')).toBeNull()
  })
})

describe('AC-RL-12(c): retryAfterMs のジッタ（RV-P3DR-009）', () => {
  const BASE = 1_000

  it('N=20 サンプルで、相異なる値が2つ以上ある（ジッタが存在する）', () => {
    const random = seededRandom(123)
    const samples = Array.from({ length: 20 }, () => jitteredRetryAfterMs(BASE, random))
    expect(new Set(samples).size, 'ジッタが効いている').toBeGreaterThanOrEqual(2)
  })

  it('N=20 サンプルが全て基準値の ±20% に収まる（効きすぎていない）', () => {
    // 「連続2回取って同値でないこと」で書いてはならない——整数 ms でも衝突確率はゼロではなく、
    // 粗い粒度で実装すると頻繁に落ちる。**たまに落ちるテストは無視されるようになる。**
    const random = seededRandom(456)
    const samples = Array.from({ length: 20 }, () => jitteredRetryAfterMs(BASE, random))
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(BASE * 0.8)
      expect(sample).toBeLessThanOrEqual(BASE * 1.2)
    }
  })

  it('同一シードでは同一系列になる（乱数源が注入されている）', () => {
    const first = Array.from({ length: 20 }, ((r) => () => jitteredRetryAfterMs(BASE, r))(seededRandom(789)))
    const second = Array.from({ length: 20 }, ((r) => () => jitteredRetryAfterMs(BASE, r))(seededRandom(789)))
    expect(first).toEqual(second)
  })

  it('サーバーが値を返す（クライアントが決めない）: 応答の retryAfterMs もジッタ範囲内', async () => {
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      semaphore: fullSemaphore(),
    })
    const body = (await (await guarded(request(), undefined)).json()) as { retryAfterMs: number }
    expect(body.retryAfterMs).toBeGreaterThan(0)
  })
})

describe('AC-RL-12(d): Tier B は降格理由を区別できない（bot に判定基準を教えない）', () => {
  it('Cookie 不在 / 署名不正 / 期限切れ で応答が完全に一致する', async () => {
    const reasons = ['missing', 'tampered', 'expired']
    const responses = []
    for (const reason of reasons) {
      const guarded = withPublicMutation(okHandler(), {
        ...baseOptions(),
        verifyFormSession: () => false,
      })
      const response = await guarded(request({ cookie: `fs=${reason}` }), undefined)
      responses.push({
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()].filter(([name]) => name !== 'date').sort(),
      })
    }
    expect(responses[1]).toEqual(responses[0])
    expect(responses[2]).toEqual(responses[0])
  })
})

describe('AC-RL-12(e) / 契約ルール7: challenge を持たない 403 を Tier B として扱わない', () => {
  it('Origin 検証失敗の 403 は challenge を含まない', async () => {
    // これが green なら排除される: すべての 403 に `challenge` を付ける実装。
    // クライアントは CAPTCHA を出し、解いて再送してもまた同じ 403 を受ける
    // ——**抜けられないループ**になる（RV-P3DR-004）。
    const guarded = withPublicMutation(okHandler(), baseOptions())
    const response = await guarded(request({ origin: 'https://evil.test' }), undefined)
    expect(response.status).toBe(403)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.challenge, '非 Tier の 403 に challenge を付けてはならない').toBeUndefined()
  })

  it('Tier B の 403 は必ず challenge を含む', async () => {
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      verifyFormSession: () => false,
    })
    const body = (await (await guarded(request(), undefined)).json()) as Record<string, unknown>
    expect(body.challenge).toBe('interactive')
  })
})

/* ========================================================================= *
 * AC-RL-2 / AC-010-16 — reset-on-success と cleanSource を持ち込まない
 * ========================================================================= */

describe("AC-RL-2 / AC-010-16（条件1'-2 / SEC-039）", () => {
  it('連続成功送信でカウンタが単調増加する（reset-on-success を持ち込まない）', async () => {
    // これが green なら排除される: 送信成功時にカウンタをリセットする実装。
    // 正常系が頻繁に成功する公開経路では、**攻撃者に無料枠を与える**ことと同義になる
    //（P2.5-b の実測 S8）。
    const source = createRateLimiter({ limit: 3, windowMs: 60_000 })
    const guarded = withPublicMutation(okHandler(), { ...baseOptions(), limiters: { source, formSession: formSessionAxis() } })

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await guarded(request(), undefined)).status)
    }
    expect(statuses, '3回成功したら4回目以降は Tier D').toEqual([201, 201, 201, 429, 429])
  })

  it('`cleanSource`（カウント0 = 予約枠の資格）の概念を公開経路へ持ち込まない', async () => {
    const module = (await import('@/lib/public-guard')) as Record<string, unknown>
    expect(module.cleanSource).toBeUndefined()
    expect(module.createReserveLimiter).toBeUndefined()
    const source = (await import('node:fs')).readFileSync('lib/public-guard.ts', 'utf8')
    expect(source, '予約枠 / cleanSource を公開エンドポイントに持ち込まない').not.toMatch(
      /cleanSource|globalReserve/,
    )
  })
})

/* ========================================================================= *
 * AC-RL-10 / AC-PII-1 — 拒否・劣化ログに PII を出さない
 * ========================================================================= */

describe('AC-RL-10 / AC-PII-1: 拒否・劣化のログに個人情報を出さない', () => {
  it('ログに出るのは軸名・キーのハッシュ先頭8文字・判定結果だけ', async () => {
    const logger = { warn: vi.fn() }
    const source = createRateLimiter({ limit: 0, windowMs: 60_000 })
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      limiters: { source, formSession: formSessionAxis() },
      // SEC-043: `clientIp` は `ClientIpResolution` を**分解せずに**返す（`trusted` を捨てさせない）。
  clientIp: (): ClientIpResolution => ({
    key: '198.51.100.5',
    trusted: true,
    source: 'x-forwarded-for',
  }),
      logger,
    })

    await guarded(request({ cookie: 'fs=sid-value-must-not-be-logged' }), undefined)

    expect(logger.warn).toHaveBeenCalled()
    const logged = JSON.stringify(logger.warn.mock.calls)
    expect(logged, '生の IP を出さない').not.toContain('198.51.100.5')
    expect(logged, 'Cookie の sid を出さない').not.toContain('sid-value-must-not-be-logged')
    // 出してよい情報は含まれていること（観測手段を失わない）。
    expect(logged).toMatch(/source|formSession|semaphore/)
  })
})

/* ========================================================================= *
 * 契約ルール6 — テスト用フックは本番で無効
 * ========================================================================= */

describe('契約ルール6: retryAfterMs 固定フックは本番で無効', () => {
  it('CI=1 かつ非本番のときだけ固定値を使える', () => {
    const previousCi = process.env.CI
    try {
      process.env.CI = '1'
      // `NODE_ENV` は `@types/node` 上 readonly かつ Node 20 の `process.env` は
      // `Object.defineProperty` を受け付けないため、vitest の env スタブを使う。
      vi.stubEnv('NODE_ENV', 'test')
      expect(jitteredRetryAfterMs(60_000, seededRandom(1))).toBeLessThanOrEqual(2_000)
    } finally {
      if (previousCi === undefined) delete process.env.CI
      else process.env.CI = previousCi
      vi.unstubAllEnvs()
    }
  })

  it('本番では CI=1 でも固定値にならない', () => {
    // これが green なら排除される: E2E 用のフックが本番へ漏れる実装
    //（攻撃者が待ち時間を1〜2秒に固定でき、Tier C の抑制効果が消える）。
    const previousCi = process.env.CI
    try {
      process.env.CI = '1'
      vi.stubEnv('NODE_ENV', 'production')
      expect(jitteredRetryAfterMs(60_000, seededRandom(1))).toBeGreaterThan(2_000)
    } finally {
      if (previousCi === undefined) delete process.env.CI
      else process.env.CI = previousCi
      vi.unstubAllEnvs()
    }
  })
})
