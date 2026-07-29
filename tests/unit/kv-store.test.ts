import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createKvRateLimitStore } from '@/lib/kv'
import { createMemoryRateLimitStore, createRateLimiter } from '@/lib/rate-limit'

/**
 * =========================================================================
 * P3-a — AC-010-10（SEC-033）/ AC-RL-8 / AC-010-12（SEC-031 / SEC-041）
 * `lib/kv.ts` を「判定を持たない永続化」として本番化する
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-10:793 / AC-010-12:795 / AC-RL-8:1527。
 *
 * ## red 理由
 *  - `lib/kv.ts` は現在 `checkRateLimit`（throw するだけのプレースホルダ）しか持たず、
 *    `createKvRateLimitStore` を export していない → import 解決に失敗する。
 *  - AC-010-12 のインメモリ側（「上限に達したバケットは退避しない」）は**既存実装に対して
 *    実際に assertion が失敗する**（`createMemoryRateLimitStore` は `resetAt` の古い順に退避し、
 *    上限到達済みバケットを保護しない）。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/kv.ts
 * export interface KvRateLimitClient {
 *   incr(key: string): Promise<number>
 *   pexpire(key: string, ms: number): Promise<number>
 *   pttl(key: string): Promise<number>       // 残り TTL（ms）。キー無し = -2 / TTL 無し = -1
 *   get(key: string): Promise<string | null>
 *   set(key: string, value: string, options?: { pxAt?: number }): Promise<unknown>
 *   del(key: string): Promise<unknown>
 * }
 * export function createKvRateLimitStore(options: { client: KvRateLimitClient }): RateLimitStore
 *
 * // lib/rate-limit.ts に追加（**永続化の原子操作**であって判定ではない）
 * export interface RateLimitStore {
 *   get / set / delete                       // 既存
 *   increment?(key: string, windowMs: number, now: number): Promise<RateLimitEntry>
 * }
 * ```
 *
 * **なぜ `increment` を `RateLimitStore` 側に置くのか（AC-RL-8 との整合）**:
 * `INCR` + `EXPIRE` は「カウンタを1つ増やして寿命を付ける」という**永続化の原子操作**であり、
 * 「上限と比べて許可/拒否を決める」判定ではない。判定（`count >= limit` / `remaining` /
 * `retryAfterMs`）は `lib/rate-limit.ts` に残る。**`lib/kv.ts` に固定ウィンドウの判定を
 * 書き直してはならない**（AC-RL-8）。本ファイルはその境界をテストで固定する。
 */

/** `@upstash/redis` 相当の最小 KV クライアント（呼び出し順を記録する）。 */
function createFakeRedis() {
  const values = new Map<string, string>()
  const expiries = new Map<string, number>()
  const calls: string[] = []
  return {
    calls,
    values,
    expiries,
    async incr(key: string) {
      calls.push(`incr ${key}`)
      const next = Number(values.get(key) ?? '0') + 1
      values.set(key, String(next))
      return next
    },
    async pexpire(key: string, ms: number) {
      calls.push(`pexpire ${key} ${ms}`)
      expiries.set(key, ms)
      return 1
    },
    async pttl(key: string) {
      calls.push(`pttl ${key}`)
      if (!values.has(key)) return -2
      return expiries.get(key) ?? -1
    },
    async get(key: string) {
      calls.push(`get ${key}`)
      return values.get(key) ?? null
    },
    async set(key: string, value: string) {
      calls.push(`set ${key}`)
      values.set(key, value)
      return 'OK'
    },
    async del(key: string) {
      calls.push(`del ${key}`)
      values.delete(key)
      expiries.delete(key)
      return 1
    },
  }
}

const T0 = 1_800_000_000_000
const WINDOW_MS = 60_000

describe('AC-010-10 / SEC-033: createKvRateLimitStore は RateLimitStore を満たす', () => {
  it('get / set / delete と原子的な increment を提供する', () => {
    const store = createKvRateLimitStore({ client: createFakeRedis() })
    expect(typeof store.get).toBe('function')
    expect(typeof store.set).toBe('function')
    expect(typeof store.delete).toBe('function')
    expect(typeof store.increment).toBe('function')
  })

  it('判定ロジックを持たない（consume / peek / limit を export しない）— AC-RL-8', () => {
    // これが green なら排除される: `lib/kv.ts` に固定ウィンドウの判定（count >= limit）を
    // 書き直した実装。**判定の真実源は `lib/rate-limit.ts` 1箇所**でなければならない。
    const store = createKvRateLimitStore({ client: createFakeRedis() }) as unknown as Record<string, unknown>
    expect(store.consume, 'KV store は判定 API を持たない').toBeUndefined()
    expect(store.peek).toBeUndefined()
    expect(store.reset).toBeUndefined()
  })

  it('increment は INCR →（新規ウィンドウのときだけ）EXPIRE を発行する', async () => {
    // これが green なら排除される: **毎回 EXPIRE を張り直す実装**。
    // 固定ウィンドウの寿命がヒットのたびに延び、窓が永久に終わらなくなる
    //（＝ 攻撃者が叩き続ける限りカウンタがリセットされず、正規利用者が締め出される）。
    const client = createFakeRedis()
    const store = createKvRateLimitStore({ client })

    const first = await store.increment!('applications:1.2.3.4', WINDOW_MS, T0)
    expect(first.count).toBe(1)
    expect(first.resetAt).toBe(T0 + WINDOW_MS)
    expect(client.calls.filter((call) => call.startsWith('pexpire'))).toHaveLength(1)

    client.calls.length = 0
    const second = await store.increment!('applications:1.2.3.4', WINDOW_MS, T0 + 1_000)
    expect(second.count).toBe(2)
    expect(second.resetAt, 'ウィンドウの終端は最初のヒットから動かない').toBe(T0 + WINDOW_MS)
    expect(
      client.calls.filter((call) => call.startsWith('pexpire')),
      '2回目以降は EXPIRE を張り直さない',
    ).toHaveLength(0)
  })

  it('increment は読んでから書く形（get → set）ではない — 分散環境で失われる更新を作らない', async () => {
    // これが green なら排除される: `get` の結果を JS 側で +1 して `set` する実装。
    // `lib/rate-limit.ts` の `serialize` はプロセス内でしか効かないため、
    // 複数インスタンスでは上限を超えて通過する（SEC-033 が原子性を要求する理由）。
    const client = createFakeRedis()
    const store = createKvRateLimitStore({ client })
    await store.increment!('applications:1.2.3.4', WINDOW_MS, T0)
    expect(client.calls.some((call) => call.startsWith('set ')), 'set を使わない').toBe(false)
    expect(client.calls.some((call) => call.startsWith('incr ')), 'incr を使う').toBe(true)
  })

  it('件数上限による退避を持たない（TTL による自然消滅）— AC-010-12 / SEC-031', async () => {
    // これが green なら排除される: KV store にインメモリ相当の件数上限退避を持ち込む実装。
    const store = createKvRateLimitStore({ client: createFakeRedis() }) as unknown as Record<string, unknown>
    expect(store.size, '常駐件数の概念を持たない').toBeUndefined()
    expect(store.maxEntries).toBeUndefined()
  })
})

describe('AC-010-12 / SEC-031: 他キーの大量注入で自分のスロットルが解除されない（本番経路）', () => {
  it('KV store を注入した limiter は、他キーを何件書いても既存キーの制限を失わない', async () => {
    const store = createKvRateLimitStore({ client: createFakeRedis() })
    const limiter = createRateLimiter({ limit: 3, windowMs: WINDOW_MS, store })
    const victim = 'applications:198.51.100.7'

    for (let i = 0; i < 3; i++) {
      expect((await limiter.consume(victim, T0)).success).toBe(true)
    }
    expect((await limiter.consume(victim, T0)).success, '上限到達').toBe(false)

    for (let i = 0; i < 500; i++) {
      await limiter.consume(`applications:10.0.${Math.floor(i / 256)}.${i % 256}`, T0)
    }

    expect(
      (await limiter.consume(victim, T0)).success,
      '他キーを 500 件注入しても、自分のスロットルは解除されない',
    ).toBe(false)
  })
})

describe('AC-010-12 / SEC-041: 退避で「予約枠の資格」が復活しない', () => {
  it('インメモリ store は上限に達したバケットを退避しない', async () => {
    // これが green なら排除される: 「最も古い resetAt から退避する」現行方針のまま P3 の公開
    // エンドポイントへ流用する実装。**上限到達済みのバケットが消えると、そのキーの count が 0 に
    // 戻る**——`cleanSource`（カウント0 = 予約枠の資格）を使う経路では、攻撃者が他キーを注入して
    // 自分のバケットを追い出すだけで予約枠の資格を取り戻せる（SEC-041）。
    const maxEntries = 20
    const store = createMemoryRateLimitStore({ maxEntries, now: () => T0 })
    const limiter = createRateLimiter({ limit: 2, windowMs: WINDOW_MS, store })
    const victim = 'applications:203.0.113.9'

    await limiter.consume(victim, T0)
    await limiter.consume(victim, T0)
    expect((await limiter.consume(victim, T0)).success, '上限到達').toBe(false)

    // 攻撃者が別キーを大量に注入して、victim のバケットを追い出そうとする。
    for (let i = 0; i < maxEntries * 5; i++) {
      await limiter.consume(`applications:192.0.2.${i % 256}#${i}`, T0 + 1)
    }

    const after = await store.get(victim)
    expect(after, '上限に達したバケットは退避対象にしてはならない').not.toBeNull()
    expect(after?.count, 'カウントが 0 に戻っていない').toBeGreaterThanOrEqual(2)
    expect(
      (await limiter.consume(victim, T0 + 2)).success,
      '退避を狙った注入の後も、スロットルは解除されない',
    ).toBe(false)
  })
})

describe('AC-RL-8: lib/kv.ts の真実源コメント（レビュー時に境界を確認できること）', () => {
  const source = readFileSync(resolve(process.cwd(), 'lib/kv.ts'), 'utf8')

  it('判定の真実源が lib/rate-limit.ts であることを明記している', () => {
    expect(source).toContain('lib/rate-limit.ts')
  })

  it('セマフォが別抽象（SemaphoreStore）であることを1行残している — RV-P3DR-007', () => {
    // AC-RL-8 が明示的に要求している記録。レート制限とセマフォが同じ KV 上に同居する以上、
    // 実装者が「同じ store で足りるのでは」と混同する経路を、混同しうる当のファイルで塞ぐ。
    expect(source).toContain('SemaphoreStore')
  })

  it('固定ウィンドウの判定式を持ち込んでいない', () => {
    // 判定ロジックの複製を、ソース上でも粗く検出する（レビューの補助）。
    expect(source, '`count >= limit` 型の判定を lib/kv.ts に書かない').not.toMatch(
      /count\s*>=?\s*limit/,
    )
  })
})
