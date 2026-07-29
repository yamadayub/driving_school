/**
 * レート制限 / セマフォの**永続化先の注入点**（P3b-2 / SEC-033 / SEC-044 / AC-010-10）。
 *
 * ------------------------------------------------------------------------
 * なぜ 1 箇所に集めるのか
 * ------------------------------------------------------------------------
 * SEC-044 は「`lib/kv.ts` に KV store の実装はあるのに、**どの limiter にも注入されていない**」
 * という指摘だった。実装があることと、本番経路がそれを使っていることは別である。
 * 各所で `createUpstashKvClient()` を呼ぶ形にすると、**注入し忘れた limiter だけが黙って
 * インメモリのまま**になり（＝ インスタンスごとに別カウンタ＝全体流量制御にならない）、
 * その1箇所を見つける手段が無い。**注入経路を1つにして、呼び出し側から選択肢を無くす。**
 *
 * ------------------------------------------------------------------------
 * 未設定時のふるまい
 * ------------------------------------------------------------------------
 * `KV_REST_API_URL` / `KV_REST_API_TOKEN` が無ければ**インメモリ**へ落ちる。
 * これが許されるのは非本番だけである——**本番で未設定なら `lib/env.ts` が起動時に落とす**
 * （`getServerEnv()` の `superRefine`）。したがってこのフォールバックが本番で効くことはない。
 * `.env.example` の記述もこの前提で書かれている。
 */

import { getServerEnv } from '@/lib/env'
import { createKvRateLimitStore, createUpstashKvClient } from '@/lib/kv'
import type { RateLimitStore } from '@/lib/rate-limit'
import {
  createKvSemaphoreStore,
  createMemorySemaphoreStore,
  type SemaphoreStore,
} from '@/lib/semaphore'

/**
 * KV が実際に到達可能な設定になっているか。
 *
 * **`https://` の REST エンドポイントだけを「設定済み」と見なす。**
 * ローカル / E2E は `next start`（`NODE_ENV=production`）で回るため `lib/env.ts` の fail-fast が
 * `KV_*` の存在を要求するが、そこに実在しないホストを書くと**レート制限のたびに到達不能な
 * HTTP を叩いて全リクエストが 500 になる**。そこで `.env` には `memory://local-dev-only` を
 * 置き、それを「インメモリで動かす」の明示的な宣言として扱う。
 *
 * **この抜け道が本物の本番へ漏れないよう、`lib/env.ts` が `VERCEL === '1'` のときは
 * `https://` 以外の `KV_REST_API_URL` を起動時に拒否する。** 判別に `VERCEL` を使うのは、
 * `resolveClientIp` の `trustProxy` と同じ「実際にプラットフォーム上か」の signal だからである。
 */
export function isKvConfigured(): boolean {
  const env = getServerEnv()
  return Boolean(env.KV_REST_API_URL?.startsWith('https://') && env.KV_REST_API_TOKEN)
}

let kvClient: ReturnType<typeof createUpstashKvClient> | undefined
function sharedKvClient(): ReturnType<typeof createUpstashKvClient> {
  // レート制限とセマフォで**接続だけ**を共有する（判定ロジックは共有しない / AC-RL-8）。
  kvClient ??= createUpstashKvClient()
  return kvClient
}

let rateLimitStore: RateLimitStore | undefined | null = null

/**
 * 全 limiter が注入すべき `RateLimitStore`。
 * `undefined` を返した場合、`createRateLimiter` は自前のインメモリ store を作る（非本番のみ）。
 */
export function sharedRateLimitStore(): RateLimitStore | undefined {
  if (rateLimitStore === null) {
    rateLimitStore = isKvConfigured()
      ? createKvRateLimitStore({ client: sharedKvClient() })
      : undefined
  }
  return rateLimitStore
}

let semaphoreStore: SemaphoreStore | undefined

/** 公開エンドポイントのセマフォが使う store。 */
export function sharedSemaphoreStore(): SemaphoreStore {
  semaphoreStore ??= isKvConfigured()
    ? createKvSemaphoreStore({ client: sharedKvClient() })
    : createMemorySemaphoreStore()
  return semaphoreStore
}
