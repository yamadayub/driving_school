/**
 * 公開エンドポイントの同時実行セマフォ（AC-RL-1 / AC-RL-11 / AC-RL-15 / AC-010-13）。
 *
 * ------------------------------------------------------------------------
 * 機構: KV(Upstash Redis) 上の ZSET による**パーミット単位のリース**
 * ------------------------------------------------------------------------
 * `member` = リクエストごとの暗号論的乱数 `permitId` / `score` = リース期限（epoch ms）。
 *
 *   acquire = (1) ZREMRANGEBYSCORE（期限切れパーミットの掃除）
 *           → (2) ZCARD < perShardLimit の判定
 *           → (3) ZADD                                    … **Lua 1本で原子的に**
 *   release = ZREM <key> <permitId>                        … permitId を持つので自然に冪等
 *
 * **回復の責任をキーの TTL ではなく各パーミットの score に持たせている**のが要点である
 * （`docs/tech-stack.md` §4.5 / RV-P3DR-001）。`INCR` + キー単位 `EXPIRE` 方式は
 *  - `EXPIRE` を毎 `acquire` で発行すると、トラフィックが TTL 未満の間隔で続く限りキーが
 *    永久に期限切れにならず、漏れたパーミットが累積して**恒久枯渇**する
 *  - `EXPIRE ... NX` にすると境界でキーが在庫ごと消え、**同時実行上限を最大2倍超過**する
 * のいずれかにしかならないため採らない。
 *
 * **成立条件（無条件の性質ではない / RV-P3DR2-005）**: `now` は各インスタンスが自分の
 * `Date.now()` から渡すため、期限判定は「書いた側の時計」と「掃除する側の時計」の比較になる。
 * したがって上記の性質は「**インスタンス間のクロックスキューが TTL(20秒) に対して十分小さい**」
 * ことを前提とする。スキューが無視できない環境へ移す場合は前提を再評価すること。
 *
 * **`RateLimitStore` を拡張しない**（AC-RL-8 / RV-P3DR-007）。`{ count, resetAt }` は
 * 「減らないカウンタ」を前提にした抽象で `release` を表現できない。共有するのは KV クライアントと
 * 接続設定だけであり、判定ロジックは共有しない。
 */

import { randomBytes } from 'node:crypto'

/* ========================================================================= *
 * 数値定義（AC-RL-15）
 *   「変更する人に届く場所」に置く。`maxDuration` を編集する人が読むのは route.ts であって
 *   `tech-stack.md` ではないため、依存関係をコードの導出として表現する。
 * ========================================================================= */

/**
 * 公開 Route Handler の `maxDuration`（秒）。
 * **各公開 Route Handler は `export const maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC` と書く**
 * （数値を直書きしない。AC-RL-15(a)）。
 */
export const PUBLIC_HANDLER_MAX_DURATION_SEC = 10

/**
 * リース TTL（秒）。`maxDuration` の 2 倍。
 * 片方だけを変えると `tests/unit/semaphore.test.ts` が落ちる（それが目的である）。
 */
export const SEMAPHORE_TTL_SEC = PUBLIC_HANDLER_MAX_DURATION_SEC * 2

/** 固定シャード数 K（AC-RL-15(b)）。 */
export const SEMAPHORE_SHARDS = 4

/** 上限到達時に待つ上限（ms）。待機中も Function インスタンスを占有し課金される。 */
export const SEMAPHORE_MAX_WAIT_MS = 2_000

/** ポーリング間隔（ms）の下限・上限。ジッタで thundering herd を避ける。 */
export const SEMAPHORE_POLL_MIN_MS = 100
export const SEMAPHORE_POLL_MAX_MS = 200

/**
 * 秒 → ms の変換は**この関数1つだけ**に閉じ込める（RV-P3DR2-004）。
 * `SemaphoreStore` の境界から先はすべてミリ秒（`ttlMs` / `now` / ZSET の score）である。
 *
 * 変換を落とすと TTL 20ms（処理中パーミットの即時回収 → 上限超過）、
 * 二重に掛けると 5.5時間（漏れたパーミットが実質回復せず恒久枯渇へ逆戻り）になる。
 * **AC-RL-15(a) の関係式テストは秒同士しか見ないため、この事故を検出しない。**
 */
export function semaphoreTtlMs(): number {
  return SEMAPHORE_TTL_SEC * 1000
}

/**
 * エンドポイント全体の同時実行上限。
 * **上限 `perShardLimit` は「シャードあたり」の値**であり、全体は `perShardLimit × K`（RV-P3DR-006）。
 * 「全体で N」と定義するとシャードあたりが N/K になり、全体に空きがあるのに満杯という事象が常態化する。
 */
export function semaphoreTotalLimit(perShardLimit: number, shards: number = SEMAPHORE_SHARDS): number {
  return perShardLimit * shards
}

/**
 * セマフォ（および Tier D の発信元軸キー）を持つ公開エンドポイント。
 *
 * ⚠️ **経路ごとに分ける。** 同じ値を使い回すと発信元軸とセマフォを**共有**することになり、
 * 「片方を叩いたせいでもう片方が 429 / 202 になる」経路ができる。
 * `'form-session'`（SEC-067 の回復経路）を `'applications'` にしなかったのはこの理由である
 * ——`trusted` では発信元軸が 5 回/10 分の硬いゲートなので、
 * **回復を試みたせいで申込そのものが 429 になる**（直そうとした欠陥と同型）。
 */
export type SemaphoreEndpoint = 'applications' | 'uploads' | 'chat' | 'form-session'

/**
 * シャードキー（AC-RL-1 / AC-010-13(b) / RV-P3DR2-006）。
 *
 * `sem:{applications}:0` 〜 `:3`。**`{}` は Redis Cluster のハッシュタグそのもの**で、
 * エンドポイント名を入れることで K 個のシャードが必ず同一スロットに載る。
 * これが power of two choices（1回の `EVAL` に `KEYS[1] KEYS[2]` を渡す）の成立条件である。
 * **`sem:<endpoint>:{0..3}` のように連番を `{}` に入れてはならない**（`CROSSSLOT` で失敗する）。
 */
export function semaphoreShardKeys(
  endpoint: SemaphoreEndpoint,
  shards: number = SEMAPHORE_SHARDS,
): string[] {
  return Array.from({ length: shards }, (_unused, index) => `sem:{${endpoint}}:${index}`)
}

/* ========================================================================= *
 * acquire スクリプト
 * ========================================================================= */

/**
 * `acquire` の Lua スクリプト（`EVAL`）。
 *
 *   KEYS = 候補シャードキー（power of two choices なら2本 / `shards === 1` なら1本）
 *   ARGV = { nowMs, ttlMs, perShardLimit, permitId }
 *   戻り値 = 成功時 { key, permitId } / 空きが無ければ nil
 *
 * **掃除・判定・追加を1本の `EVAL` に閉じる**ことが原子性の根拠である。分けて発行する楽観方式は
 * 競合時に一瞬だけ同時実行上限を超える（AC-RL-11(e-2)(e-3) が落とす対象）。
 *
 * **時刻は ARGV で受け取り、スクリプト内で `TIME` を読まない**——読むとテストから時刻を注入できず、
 * 実時間 20 秒待ちのテストしか書けなくなる（AC-RL-11 が禁じている）。
 */
export const SEMAPHORE_ACQUIRE_LUA = `local now = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local perShardLimit = tonumber(ARGV[3])
local permitId = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local bestKey = KEYS[1]
local bestCount = redis.call('ZCARD', KEYS[1])
local otherKey = KEYS[2]
if otherKey then
  redis.call('ZREMRANGEBYSCORE', otherKey, '-inf', now)
  local otherCount = redis.call('ZCARD', otherKey)
  if otherCount < bestCount then
    bestKey = otherKey
    bestCount = otherCount
  end
end
if bestCount >= perShardLimit then
  return nil
end
redis.call('ZADD', bestKey, now + ttlMs, permitId)
return { bestKey, permitId }`

/* ========================================================================= *
 * SemaphoreStore（永続化の境界）
 * ========================================================================= */

export interface SemaphorePermit {
  /** パーミットが載っているシャードキー。`release` はこの key に対して行う（AC-RL-11(b)）。 */
  key: string
  /** このパーミットの識別子。`release` の冪等性はこれが担保する（AC-RL-11(c)）。 */
  permitId: string
}

export interface SemaphoreStore {
  /**
   * 候補シャードのいずれかにパーミットを1件確保する。空きが無ければ `null`。
   * **`now` / `ttlMs` はミリ秒**（`semaphoreTtlMs()` を通した値）。
   */
  acquire(
    keys: string[],
    perShardLimit: number,
    ttlMs: number,
    now: number,
    permitId: string,
  ): Promise<SemaphorePermit | null>
  release(key: string, permitId: string): Promise<void>
}

/** セマフォが使う KV コマンドだけを要求する最小インタフェース（`@upstash/redis` が満たす）。 */
export interface SemaphoreKvClient {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
  zrem(key: string, member: string): Promise<number>
}

/**
 * KV(ZSET) 上の `SemaphoreStore`。
 *
 * **`lib/rate-limit.ts` の `serialize`（キー単位の直列化キュー）を経由しない**（AC-010-13(a)）。
 * セマフォがスループットの単一障害点になっては本末転倒である。
 */
export function createKvSemaphoreStore(options: { client: SemaphoreKvClient }): SemaphoreStore {
  const { client } = options

  return {
    async acquire(keys, perShardLimit, ttlMs, now, permitId) {
      const result = await client.eval(SEMAPHORE_ACQUIRE_LUA, keys, [
        now,
        ttlMs,
        perShardLimit,
        permitId,
      ])
      if (!Array.isArray(result) || result.length < 2) return null
      return { key: String(result[0]), permitId: String(result[1]) }
    },

    async release(key, permitId) {
      await client.zrem(key, permitId)
    },
  }
}

/**
 * プロセス内メモリの `SemaphoreStore`（**KV 未設定の開発 / E2E / デモ専用**）。
 *
 * **本番では使ってはならない。** インスタンスごとに別の在庫を持つため「全体の同時実行上限」に
 * ならない。本番で KV が未設定なら `lib/env.ts` が起動時に落とす（SEC-033 / AC-010-10）ので、
 * この実装に落ちるのは非本番だけである。
 *
 * KV 版と**同じ意味論**（期限切れの掃除 → 判定 → 追加を1操作として扱う / `release` は冪等）を
 * 保つ。ここだけ意味論がずれると、開発で通ったものが本番で落ちる。
 */
export function createMemorySemaphoreStore(): SemaphoreStore {
  const shards = new Map<string, Map<string, number>>()

  function shardOf(key: string): Map<string, number> {
    let shard = shards.get(key)
    if (!shard) {
      shard = new Map<string, number>()
      shards.set(key, shard)
    }
    return shard
  }

  return {
    async acquire(keys, perShardLimit, ttlMs, now, permitId) {
      let bestKey: string | null = null
      let bestCount = Number.POSITIVE_INFINITY
      for (const key of keys) {
        const shard = shardOf(key)
        // 期限切れパーミットの回収。**判定の前に必ず行う**（AC-RL-11(a)(d)）。
        for (const [member, expiresAt] of shard) {
          if (expiresAt <= now) shard.delete(member)
        }
        if (shard.size < bestCount) {
          bestCount = shard.size
          bestKey = key
        }
      }
      if (bestKey === null || bestCount >= perShardLimit) return null
      shardOf(bestKey).set(permitId, now + ttlMs)
      return { key: bestKey, permitId }
    },

    async release(key, permitId) {
      shards.get(key)?.delete(permitId)
    },
  }
}

/* ========================================================================= *
 * Semaphore（シャード抽選・待機）
 * ========================================================================= */

export interface AcquireWithWaitOptions {
  /** 現在時刻（epoch ms）を返す。ポーリングのたびに読み直す。 */
  now: () => number
  /** 待機。テストは仮想クロックを進めるだけの実装を渡す（実時間を待たない）。 */
  sleep: (ms: number) => Promise<void>
  /** ポーリング間隔のジッタに使う乱数源。**シャード抽選の `rng` とは別**（下記参照）。 */
  random?: () => number
}

export interface SemaphoreWaitResult {
  permit: SemaphorePermit | null
  /** `acquire` を試行した回数（初回を含む）。 */
  attempts: number
  /** 実際に待った時間（ms）。`SEMAPHORE_MAX_WAIT_MS` を超えない。 */
  waitedMs: number
}

export interface Semaphore {
  acquire(options: { now: number }): Promise<SemaphorePermit | null>
  acquireWithWait(options: AcquireWithWaitOptions): Promise<SemaphoreWaitResult>
  release(permit: SemaphorePermit): Promise<void>
  totalLimit(): number
  keys(): string[]
}

export interface CreateSemaphoreOptions {
  store: SemaphoreStore
  endpoint: SemaphoreEndpoint
  /** **シャードあたり**の同時実行上限。 */
  perShardLimit: number
  /** 既定 `SEMAPHORE_SHARDS`。AC-RL-11(a)② がテストから 1 を注入するため可変にしてある。 */
  shards?: number
  /** 既定 `semaphoreTtlMs()`。ミリ秒。 */
  ttlMs?: number
  /**
   * シャード候補の抽選に使う乱数源（AC-RL-15(c)）。
   * **ポーリング間隔のジッタとは乱数源を分ける**——1つにするとジッタが系列を消費して
   * シャード抽選の決定性が壊れ、待機経路の再抽選テストが書けなくなる。
   */
  rng?: () => number
  /**
   * `permitId` の生成（§D 26）。**呼び出し側が渡す**設計にしてあるのは、乱数生成をストアの内側に
   * 隠すと `release` の局所性・冪等性を決定的にテストできなくなるため。
   */
  newPermitId?: () => string
}

/** 既定の `permitId`: 128bit の暗号論的乱数（16進 32 文字）。 */
function defaultPermitId(): string {
  return randomBytes(16).toString('hex')
}

export function createSemaphore(options: CreateSemaphoreOptions): Semaphore {
  const {
    store,
    endpoint,
    perShardLimit,
    shards = SEMAPHORE_SHARDS,
    ttlMs = semaphoreTtlMs(),
    rng = Math.random,
    newPermitId = defaultPermitId,
  } = options

  const shardKeys = semaphoreShardKeys(endpoint, shards)

  /**
   * power of two choices の候補導出（AC-RL-15(c)）。
   *
   * `shards === 1` では `rng` を呼ばない（呼ぶと注入系列がずれる）。
   * そうでなければ 1回の抽選につき `rng()` を 2回呼び、
   * `a = floor(r1 * shards)` / `b = floor(r2 * (shards - 1))`（`b >= a` なら `b += 1`）。
   *
   * **抽選は `acquire` の内側で毎回行う**（RV-P3DR2-003）。外で1回だけ計算して持ち回ると、
   * 全体に空きがあっても満杯の2シャードを待ち上限まで叩き続けて Tier C を返すことになる。
   */
  function pickCandidates(): string[] {
    if (shardKeys.length <= 1) return [shardKeys[0]]
    const first = Math.min(shardKeys.length - 1, Math.floor(rng() * shardKeys.length))
    let second = Math.min(shardKeys.length - 2, Math.floor(rng() * (shardKeys.length - 1)))
    if (second >= first) second += 1
    return [shardKeys[first], shardKeys[second]]
  }

  /** ポーリング間隔（100〜200ms）。 */
  function pollDelayMs(random: () => number): number {
    const span = SEMAPHORE_POLL_MAX_MS - SEMAPHORE_POLL_MIN_MS
    return SEMAPHORE_POLL_MIN_MS + Math.floor(random() * (span + 1))
  }

  async function acquire({ now }: { now: number }): Promise<SemaphorePermit | null> {
    return store.acquire(pickCandidates(), perShardLimit, ttlMs, now, newPermitId())
  }

  return {
    acquire,

    /**
     * 上限到達時は**最大2秒だけ待つ**（AC-RL-1）。空かなければ `permit: null` を返し、
     * **Tier C（202）に落とすかどうかの判断は呼び出し側**（`lib/public-guard.ts`）が行う。
     */
    async acquireWithWait({ now, sleep, random = Math.random }) {
      const startedAt = now()
      let attempts = 0

      let permit = await acquire({ now: now() })
      attempts += 1

      while (permit === null) {
        const elapsed = now() - startedAt
        const remaining = SEMAPHORE_MAX_WAIT_MS - elapsed
        // 残りがポーリング間隔の下限に満たないなら打ち切る。
        // こうしないと最後の1回で待ち上限を超える（待機中も課金される資源を守る）。
        if (remaining < SEMAPHORE_POLL_MIN_MS) break
        await sleep(Math.min(pollDelayMs(random), remaining))
        permit = await acquire({ now: now() })
        attempts += 1
      }

      return { permit, attempts, waitedMs: now() - startedAt }
    },

    async release(permit) {
      await store.release(permit.key, permit.permitId)
    },

    totalLimit: () => semaphoreTotalLimit(perShardLimit, shards),
    keys: () => [...shardKeys],
  }
}
