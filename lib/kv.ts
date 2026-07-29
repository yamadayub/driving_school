/**
 * レート制限カウンタの **KV(Upstash Redis) 永続化**（AC-010-10 / SEC-033 / AC-RL-8）。
 *
 * ------------------------------------------------------------------------
 * このモジュールの境界（レビュー時にここを確認する / RV-P2R-008・RV-P3DR-007）
 * ------------------------------------------------------------------------
 * **判定ロジックの真実源は `lib/rate-limit.ts` である。** 本モジュールは
 * `RateLimitStore` の実装として**永続化だけ**を担い、固定ウィンドウの判定（上限との比較・
 * `remaining` / `retryAfterMs` の算出）を**複製しない**（AC-RL-8）。
 *
 * **セマフォは別抽象（`SemaphoreStore` / `lib/semaphore.ts`）である。** `RateLimitStore` は
 * `{ count, resetAt }` という「**減らないカウンタ**」を前提にした抽象で、パーミットの `release` を
 * 表現できない。無理に拡張するとレート制限側の意味論が壊れる。**両者が共有してよいのは KV
 * クライアントと接続設定だけ**であり、判定ロジックは共有しない（RV-P3DR-007）。
 *
 * ------------------------------------------------------------------------
 * ウィンドウの取り方（インメモリ実装との違い。意図的な差異）
 * ------------------------------------------------------------------------
 * `createMemoryRateLimitStore` のウィンドウ起点は「最初の試行時刻」だが、KV 側は
 * **`windowMs` 境界に整列した固定ウィンドウ**（`floor(now / windowMs) * windowMs`）にする。
 * 理由は、`INCR` の戻り値以外に往復を増やさずに `resetAt` を決めるため。
 * これにより「2 回目以降に `EXPIRE` を張り直す」実装（＝ 窓が永久に終わらず、攻撃者が叩き続ける
 * 限りカウンタがリセットされない）を構造的に採らずに済む。
 */

import { Redis } from '@upstash/redis'
import { getServerEnv } from '@/lib/env'
import type { RateLimitEntry, RateLimitStore } from '@/lib/rate-limit'
import type { SemaphoreKvClient } from '@/lib/semaphore'

/** セマフォと共有する接続情報から作られる、レート制限用の最小 KV インタフェース。 */
export interface KvRateLimitClient {
  incr(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<number>
  /** 残り TTL（ms）。キーが無ければ -2 / TTL 未設定なら -1。 */
  pttl(key: string): Promise<number>
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { pxAt?: number }): Promise<unknown>
  del(key: string): Promise<unknown>
}

/* ------------------------------------------------------------------------- *
 * 本番の KV クライアント（`@upstash/redis`）
 * ------------------------------------------------------------------------- */

/**
 * レート制限とセマフォが**共有する**接続。
 * 共有してよいのは**クライアントと接続設定だけ**であり、判定ロジックは共有しない（AC-RL-8）。
 *
 * `@vercel/kv` は採用しない——**Vercel KV はサービスとして提供終了**しており、実体は Upstash Redis
 * である（`tech-stack.md` §4.5「`EVAL` の実現可能性」）。`KV_*` 環境変数はそのまま Upstash の
 * 接続情報として使う。本番での未設定は `lib/env.ts` が起動時に落とす（SEC-033）。
 */
export function createUpstashKvClient(): KvRateLimitClient & SemaphoreKvClient {
  const env = getServerEnv()
  const redis = new Redis({
    url: env.KV_REST_API_URL ?? '',
    token: env.KV_REST_API_TOKEN ?? '',
  })

  // Upstash SDK は値を自動でデシリアライズするため、境界で本モジュールの契約へ揃える。
  return {
    incr: (key) => redis.incr(key),
    pexpire: (key, ms) => redis.pexpire(key, ms),
    pttl: (key) => redis.pttl(key),
    get: async (key) => {
      const value = await redis.get<unknown>(key)
      return value === null || value === undefined ? null : String(value)
    },
    set: (key, value, options) =>
      options?.pxAt === undefined
        ? redis.set(key, value)
        : redis.set(key, value, { pxat: options.pxAt }),
    del: (key) => redis.del(key),
    eval: (script, keys, args) => redis.eval(script, keys, args),
    zrem: (key, member) => redis.zrem(key, member),
  }
}

/** 整列した固定ウィンドウの終端（epoch ms）。 */
function windowEndsAt(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs + windowMs
}

/**
 * `RateLimitStore` の KV 実装。
 *
 * **件数上限による退避を持たない**（AC-010-12 / SEC-031）。KV は TTL で自然消滅するため、
 * インメモリ相当の退避をここへ持ち込む必要が無く、持ち込めば「他キーの大量注入で自分のスロットルが
 * 解除される」経路を新設することになる。
 */
export function createKvRateLimitStore(options: { client: KvRateLimitClient }): RateLimitStore {
  const { client } = options

  return {
    /**
     * カウンタを1つ増やして寿命を付ける**原子操作**（SEC-033）。
     *
     * `INCR` の戻り値が 1 のときだけ `PEXPIRE` を発行する。**毎回張り直してはならない**——
     * 固定ウィンドウの寿命がヒットのたびに延び、窓が永久に終わらなくなる。
     */
    async increment(key: string, windowMs: number, now: number): Promise<RateLimitEntry> {
      const count = await client.incr(key)
      const resetAt = windowEndsAt(now, windowMs)

      if (count === 1) {
        await client.pexpire(key, Math.max(1, resetAt - now))
        return { count, resetAt }
      }

      // TTL が失われたキー（`PEXPIRE` の失敗・手動操作）は寿命を持たず、窓が永久に終わらない
      // ＝ 正規利用者が恒久的に締め出される。既存の窓を延ばさない範囲で付け直す。
      const ttl = await client.pttl(key)
      if (ttl < 0) await client.pexpire(key, Math.max(1, resetAt - now))
      return { count, resetAt }
    },

    /**
     * 参照のみ（`peek` 経路）。`increment` を持つ store では `consume` はこちらを通らない。
     * 残り TTL から窓の終端を復元する（`increment` と違い `now` を受け取らないため）。
     */
    async get(key: string): Promise<RateLimitEntry | null> {
      const raw = await client.get(key)
      if (raw === null) return null
      const count = Number(raw)
      if (!Number.isFinite(count)) return null
      const ttl = await client.pttl(key)
      return { count, resetAt: Date.now() + Math.max(0, ttl) }
    },

    async set(key: string, entry: RateLimitEntry): Promise<void> {
      await client.set(key, String(entry.count), { pxAt: entry.resetAt })
    },

    async delete(key: string): Promise<void> {
      await client.del(key)
    },
  }
}
