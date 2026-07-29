import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter, rateLimitKey, type RateLimiter } from '@/lib/rate-limit'
import { withPublicMutation } from '@/lib/public-guard'
import {
  FORM_SESSION_COOKIE_NAME,
  createFormSessionValue,
  formSessionAxisKey,
} from '@/lib/form-session'
import type { ClientIpResolution } from '@/lib/http-guard'
import { seededRandom } from './helpers/seeded-random'

/**
 * =========================================================================
 * P3-a 差し戻し修正 — SEC-043 / RV-P3A-001（High / Must Fix）
 * 「縮退時（`trusted=false`）の共有 `unknown` バケットを硬いゲートに使わない」
 * =========================================================================
 *
 * 出典: `docs/security-audit.md`「P3-a 監査」SEC-043（実測 G-1）/
 *       `docs/review-p3a-code-2026-07-29.md` RV-P3A-001 /
 *       `docs/functional-spec.md` v0.3.3 §4.11 契約ルール2 / AC-RL-1 条件1'-1・1'-3。
 *
 * ## この欠陥の型（4 度目）
 * SEC-021 → SEC-029 → SEC-030 → **SEC-043**。いずれも「共有軸の枯渇を、攻撃者自身に閉じた軸の
 * 枯渇と同じ扱い（照合前の硬いゲート）にしてしまう」形である。今回は母数が**公開フォームの
 * 全利用者**であり、**第三者が上限回数だけ送信するだけで全員の申込を止められる**。
 *
 * ## 確定済みの意味論（P2.5-b / `lib/login-guard.ts:129-142` と同一にすること）
 * > 縮退時（`trusted === false`）の per-source バケットは全利用者が共有する単一の `unknown` で、
 * > その枯渇は「無関係な誰かが送信した」以上の意味を持たない。**計数は続けるが拒否には使わない。**
 *
 * ## red 理由（現在の実装）
 * `lib/public-guard.ts:184-190` が `clientIp(request).key` だけを取り出し `trusted` を捨てているため、
 * 縮退時も per-source 軸の `success:false` がそのまま Tier D（429）になる。
 *
 * ## 型での強制について
 * 本ファイルは**振る舞い**を固定する。「`.key` だけを使うと型エラーになる」形の要求は
 * `tests/unit/public-guard-source-axis-type.test.ts` が担当する（`pnpm type-check` で赤になる）。
 * 振る舞いだけを直して型の継ぎ目を作らないと、P3-b で `limiters.source` を配線する人が
 * 同じ誤りを再現できてしまう（`lib/http-guard.ts:86-94` の警告コメントは実際に守られなかった）。
 */

const ORIGIN = 'https://example.test'
const T0 = 1_800_000_000_000
/** SEC-052 の是正で Cookie 由来の軸キーを使うようになったため、署名鍵が要る。 */
const FS_SECRET = 'degraded-source-test-secret-32-characters'

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

function freeSemaphore() {
  return {
    acquireWithWait: async () => ({ permit: { key: 'sem:{applications}:0', permitId: 'p' } }),
    release: vi.fn(async () => {}),
  }
}

/** 信頼できるプロキシ配下（既定の経路）。 */
const TRUSTED: ClientIpResolution = {
  key: '198.51.100.5',
  trusted: true,
  source: 'x-forwarded-for',
}

/** 縮退（`VERCEL !== '1'` / IP ヘッダが妥当な IP リテラルでない）。実測 G-1 の状態。 */
const DEGRADED: ClientIpResolution = { key: 'unknown', trusted: false, source: 'unknown' }

const SOURCE_KEY = rateLimitKey('applications:', DEGRADED.key)

/** `consume` の呼び出しを記録するラッパ（「計数は続いているか」を見るため）。 */
function countingLimiter(inner: RateLimiter): { limiter: RateLimiter; keys: string[] } {
  const keys: string[] = []
  return {
    keys,
    limiter: {
      consume: async (key, now) => {
        keys.push(key)
        return inner.consume(key, now)
      },
      peek: (key, now) => inner.peek(key, now),
      reset: (key) => inner.reset(key),
    },
  }
}

/**
 * P3b-1（SEC-053）の構築時検査を満たすための別軸。
 *
 * `limiters.source` を渡す構成では `limiters.formSession` / `formSessionKey` が必須になった。
 * **本ファイルの `request()` は既定で `__Host-fs` を送らないため `formSessionAxisKey` は `null` を返し、
 * 各テストが検証している発信元軸の振る舞いは変わらない。**
 */
const formSessionAxis = () => createRateLimiter({ limit: 1_000, windowMs: 60_000 })

const baseOptions = () => ({
  endpoint: 'applications' as const,
  requireContentType: 'json' as const,
  formSessionKey: formSessionAxisKey,
  now: () => T0,
  random: seededRandom(11),
  semaphore: freeSemaphore(),
})

describe("SEC-043 / RV-P3A-001: trusted=false の共有バケットを Tier D の理由にしない（条件1'-1）", () => {
  it('縮退時は per-source 軸が上限に達しても 429 にならない（第三者が全利用者を締め出せない）', async () => {
    // これが green なら排除される攻撃: 縮退構成（`next start` 直公開 / ローカル / IP ヘッダが
    // 壊れている Vercel 上のリクエスト）で、**攻撃者 1 台が上限回数だけ送信するだけで、
    // 以降その窓の間ずっと全利用者の申込送信が 429 になる**（監査 G-1 の実測そのもの）。
    const handler = okHandler()
    const inner = createRateLimiter({ limit: 3, windowMs: 60_000 })
    const { limiter, keys } = countingLimiter(inner)
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      clientIp: () => DEGRADED,
      limiters: { source: limiter, formSession: formSessionAxis() },
      // 条件1'-3: 縮退時に per-source ゲートを外す代わりに**別軸を併用する**。
      verifyFormSession: () => true,
    })

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await guarded(request(), undefined)).status)

    expect(statuses, '共有 unknown バケットの枯渇は拒否理由にならない').toEqual([
      201, 201, 201, 201, 201,
    ])
    expect(handler).toHaveBeenCalledTimes(5)
    // 計数は続いている（観測手段を失わない / 監査ログとメトリクスの意味を保つ）。
    expect(keys, '毎回 consume している（計数は続ける）').toHaveLength(5)
    expect(keys.every((key) => key === SOURCE_KEY)).toBe(true)
    const state = await inner.peek(SOURCE_KEY, T0)
    expect(state.success, 'バケット自体は上限到達している（計数を止めていない）').toBe(false)
    expect(state.remaining).toBe(0)
  })

  it('信頼できる発信元（trusted=true）では従来どおり 429 でゲートする（退行防止）', async () => {
    // これが green なら排除される壊れた実装: SEC-043 の是正を「per-source 軸を常に外す」形で
    // 行うこと。**攻撃者自身に閉じた軸のゲートまで消すと、Tier D が機能しなくなる。**
    const handler = okHandler()
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      clientIp: () => TRUSTED,
      limiters: { source: createRateLimiter({ limit: 3, windowMs: 60_000 }), formSession: formSessionAxis() },
      verifyFormSession: () => true,
    })

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await guarded(request(), undefined)).status)

    expect(statuses).toEqual([201, 201, 201, 429, 429])
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('縮退時でも formSession 軸（攻撃者自身に閉じた軸）は硬いゲートのまま', async () => {
    // これが green なら排除される壊れた実装: 「trusted=false なら Tier D 全体を無効化する」実装。
    // `formSession` は Cookie に閉じた軸であり、共有 `unknown` バケットとは性質が違う。
    //
    // ⚠️ **P3-b / SEC-052 で修正**: 以前ここは `formSessionKey: () => 'sid-abc'`（定数キー）を
    // 与えて 429 を期待していた。監査はこれを「**共有キーで硬いゲートになる形そのものが
    // 期待値として書かれている**」と指摘した（SEC-052 / P3b-1b。`docs/security-audit.md:2421-2424`）。
    // 現在は**要求元ごとに一意なキー**（`formSessionAxisKey` = Cookie 由来）を渡す。
    // 「共有キーを返す `formSessionKey`」は `PerRequesterKey` 型により**書けなくなった**ため、
    // 監査が要求した「共有キーは 429 の理由にならない」ケースは
    // `tests/unit/form-session-axis.test.ts` の型テストと
    // `tests/unit/public-guard-p3b-wiring.test.ts`（Cookie 不在は 403）で担保している。
    const handler = okHandler()
    const cookie = `${FORM_SESSION_COOKIE_NAME}=${createFormSessionValue({ sid: 'a'.repeat(32), issuedAt: T0 - 10_000 }, FS_SECRET)}`
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      clientIp: () => DEGRADED,
      limiters: {
        source: createRateLimiter({ limit: 3, windowMs: 60_000 }),
        formSession: createRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
      formSessionKey: formSessionAxisKey,
      verifyFormSession: () => true,
    })

    expect((await guarded(request({ cookie }), undefined)).status).toBe(201)
    const second = await guarded(request({ cookie }), undefined)
    expect(second.status, 'Cookie 軸は攻撃者自身に閉じているのでゲートに使える').toBe(429)
  })

  it('別 Cookie の利用者は、他人が軸を使い切っても 429 に巻き込まれない（SEC-052）', async () => {
    // これが green なら排除される攻撃（監査 D-3 / D-4 の実測）: 全員が同じ軸キーに落ちる配線で、
    // 攻撃者1人の送信により**無関係な利用者が 429**（窓が明けるまでの硬い拒否）になること。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      clientIp: () => DEGRADED,
      limiters: {
        source: createRateLimiter({ limit: 100, windowMs: 60_000 }),
        formSession: createRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
      formSessionKey: formSessionAxisKey,
      verifyFormSession: () => true,
    })
    const attacker = `${FORM_SESSION_COOKIE_NAME}=${createFormSessionValue({ sid: 'f'.repeat(32), issuedAt: T0 - 10_000 }, FS_SECRET)}`
    const victim = `${FORM_SESSION_COOKIE_NAME}=${createFormSessionValue({ sid: '0'.repeat(32), issuedAt: T0 - 10_000 }, FS_SECRET)}`

    for (let i = 0; i < 5; i++) await guarded(request({ cookie: attacker }), undefined)
    expect((await guarded(request({ cookie: victim }), undefined)).status).toBe(201)
  })

  it('`trusted` を実際に読む（`.key` だけを取り出す実装を検出する）', async () => {
    // これが green なら排除される壊れた実装: `clientIp(request).key` のように
    // **`trusted` を参照しないまま**キーだけを取り出す呼び出し（＝ SEC-043 の直接の原因、
    // かつ `lib/http-guard.ts:86-94` が名指しで禁じている呼び方）。
    // 振る舞いの assertion だけだと「limiters.source を渡していない経路」で空振りするため、
    // プロパティ読み取り自体を getter で観測する。
    let readTrusted = 0
    const probe = (): ClientIpResolution => ({
      key: 'unknown',
      get trusted() {
        readTrusted += 1
        return false
      },
      source: 'unknown',
    })

    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      clientIp: probe,
      limiters: { source: createRateLimiter({ limit: 3, windowMs: 60_000 }), formSession: formSessionAxis() },
      verifyFormSession: () => true,
    })
    await guarded(request(), undefined)

    expect(readTrusted, 'per-source 軸を組み立てる際に trusted を必ず読むこと').toBeGreaterThan(0)
  })
})

describe("SEC-043 修正方針2 / 条件1'-3: trusted=false のときは別軸を必ず要求する", () => {
  it('縮退時に別軸（verifyFormSession）が未設定なら Tier B へ降格する（429 にはしない）', async () => {
    // これが green なら排除される壊れた実装: 「縮退時は per-source ゲートを外す」だけを行い、
    // **代わりの軸を要求しない**実装（＝ 縮退構成では変更系が無制限に素通りする）。
    // 降格先は Tier B（403 + challenge）である。Tier D（429）にすると、
    // 「共有軸の枯渇を拒否にしない」という是正そのものを打ち消す。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      clientIp: () => DEGRADED,
      limiters: { source: createRateLimiter({ limit: 3, windowMs: 60_000 }), formSession: formSessionAxis() },
      // verifyFormSession なし = 併用すべき別軸が無い
    })

    const response = await guarded(request(), undefined)
    expect(response.status, '素通りさせない／429 にもしない').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(handler, '別軸が無い縮退構成で本体を実行しない').not.toHaveBeenCalled()
  })

  it('信頼できる発信元では、別軸が無くても Tier B に落とさない（正常系を壊さない）', async () => {
    // これが green なら排除される壊れた実装: 「別軸が無ければ常に Tier B」にしてしまい、
    // 通常構成（Vercel / trusted=true）の全リクエストが challenge を要求される状態。
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      clientIp: () => TRUSTED,
      limiters: { source: createRateLimiter({ limit: 3, windowMs: 60_000 }), formSession: formSessionAxis() },
    })
    expect((await guarded(request(), undefined)).status).toBe(201)
  })
})
