import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  PUBLIC_HANDLER_MAX_DURATION_SEC,
  SEMAPHORE_ACQUIRE_LUA,
  SEMAPHORE_MAX_WAIT_MS,
  SEMAPHORE_POLL_MAX_MS,
  SEMAPHORE_POLL_MIN_MS,
  SEMAPHORE_SHARDS,
  SEMAPHORE_TTL_SEC,
  createKvSemaphoreStore,
  createSemaphore,
  semaphoreShardKeys,
  semaphoreTotalLimit,
  semaphoreTtlMs,
} from '@/lib/semaphore'
import { createFakeKvClient } from './helpers/fake-kv'
import {
  T0,
  TEST_TTL_MS,
  assertCleanupIsNotThinned,
  assertDoubleReleaseIsIdempotent,
  assertNeverExceedsTotalLimitAcrossTtlBoundary,
  assertNeverExceedsTotalLimitUnderConcurrency,
  assertRecoversUnderContinuousLoad,
  assertReleaseIsShardLocal,
  assertSingleAtomicCommandPerAcquire,
  type HarnessFactory,
} from './helpers/semaphore-contract'
import { scriptedRandom, seededRandom } from './helpers/seeded-random'

/**
 * =========================================================================
 * P3-a — `lib/semaphore.ts`（KV ZSET によるパーミット単位のリース）
 * AC-RL-1 / AC-RL-11 / AC-RL-15 / AC-010-13
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 §4.11（AC-RL-1:1520 / AC-RL-11:1530 / AC-RL-15:1534）、
 *       `docs/tech-stack.md` v0.3.2 §4.5「セマフォの実体（確定）」、
 *       `docs/review-p3-design-re2-2026-07-29.md` §D 20〜27。
 *
 * ## red 理由（実装前）
 * `lib/semaphore.ts` が存在しないため import 解決に失敗する。
 * **ただし「import が通れば green」ではない**——本ファイルが使う契約 assertion
 * （`helpers/semaphore-contract.ts`）は、`semaphore-contract-detects-defects.test.ts` によって
 * **壊れた実装を確かに落とすことが実行可能な形で証明されている**（そちらは現時点で green）。
 *
 * ## Impl が実装すべき公開 API（本ファイルが固定する契約）
 *
 * ```ts
 * export const PUBLIC_HANDLER_MAX_DURATION_SEC: number   // 10
 * export const SEMAPHORE_TTL_SEC: number                 // PUBLIC_HANDLER_MAX_DURATION_SEC * 2
 * export const SEMAPHORE_SHARDS: number                  // 4
 * export const SEMAPHORE_MAX_WAIT_MS: number             // 2000
 * export const SEMAPHORE_POLL_MIN_MS / _MAX_MS: number   // 100 / 200
 * export function semaphoreTtlMs(): number               // 秒→ms 変換はこの1関数だけ
 * export function semaphoreTotalLimit(perShardLimit: number, shards?: number): number
 *
 * export type SemaphoreEndpoint = 'applications' | 'uploads' | 'chat'
 * export function semaphoreShardKeys(endpoint: SemaphoreEndpoint, shards?: number): string[]
 * export const SEMAPHORE_ACQUIRE_LUA: string
 *
 * export interface SemaphorePermit { key: string; permitId: string }
 * export interface SemaphoreStore {
 *   acquire(keys: string[], perShardLimit: number, ttlMs: number, now: number, permitId: string):
 *     Promise<SemaphorePermit | null>
 *   release(key: string, permitId: string): Promise<void>
 * }
 * export function createKvSemaphoreStore(options: { client: SemaphoreKvClient }): SemaphoreStore
 *
 * export function createSemaphore(options: {
 *   store: SemaphoreStore
 *   endpoint: SemaphoreEndpoint
 *   perShardLimit: number
 *   shards?: number            // 既定 SEMAPHORE_SHARDS。AC-RL-11(a)② のため注入可能であること
 *   ttlMs?: number             // 既定 semaphoreTtlMs()
 *   rng?: () => number         // シャード候補の抽選（AC-RL-15(c)）
 *   newPermitId?: () => string // permitId は呼び出し側が渡す（§D 26）
 * }): Semaphore
 * ```
 *
 * ## 本ファイルが固定する2つの「呼び出し規約」（仕様に無いのでテストが決める）
 *
 * 仕様は機構（ZSET リース / Lua 1本 / power of two choices）を確定しているが、
 * **ARGV の並び**と**シャード候補の導出式**までは決めていない。テストから決定的に検証するには
 * 両方が必要なので、ここで固定する（Impl はこれに合わせること。異論があればレビューで挙げること）:
 *
 *  1. `EVAL` の呼び出し規約
 *     - `KEYS` = 候補シャードキー（`shards >= 2` なら**2本**、`shards === 1` なら1本）
 *     - `ARGV` = `[nowMs, ttlMs, perShardLimit, permitId]`
 *     - 戻り値 = 成功時 `[key, permitId]` / 空きが無ければ `null`
 *  2. シャード候補の導出（`rng()` は `[0,1)` を返す）
 *     - `shards === 1` なら `rng` を呼ばず `keys[0]` のみ
 *     - そうでなければ 1回の抽選につき `rng()` を**2回**呼び、
 *       `a = floor(r1 * shards)`、`b = floor(r2 * (shards - 1))`（`b >= a` なら `b += 1`）
 *     - **抽選は `acquire` の内側で毎回行う**（RV-P3DR2-003。待機の外で1回だけ計算しない）
 */

const ENDPOINT = 'applications' as const

/** 本物の `lib/semaphore.ts` を、フェイク KV クライアントの上で組み立てる。 */
function buildHarness(config: { shards: number; perShardLimit: number; ttlMs: number }) {
  const keys = semaphoreShardKeys(ENDPOINT, config.shards)
  const client = createFakeKvClient({
    // フェイクは Lua を解釈しない。**本物のスクリプト定数を渡さない実装は1本も通せない。**
    expectedScript: SEMAPHORE_ACQUIRE_LUA,
    latencyTicks: 1,
  })
  client.watchKeys(keys)
  const store = createKvSemaphoreStore({ client })
  let counter = 0
  const semaphore = createSemaphore({
    store,
    endpoint: ENDPOINT,
    shards: config.shards,
    perShardLimit: config.perShardLimit,
    ttlMs: config.ttlMs,
    rng: seededRandom(20260729),
    newPermitId: () => `permit-${(counter += 1)}`,
  })
  return { client, store, semaphore, keys }
}

const makeHarness: HarnessFactory = (config) => {
  const { client, semaphore, keys } = buildHarness(config)
  return {
    semaphore,
    keys,
    shards: config.shards,
    perShardLimit: config.perShardLimit,
    ttlMs: config.ttlMs,
    totalLimit: config.perShardLimit * config.shards,
    totalCardinality: () => client.totalCardinality(),
    cardinalityOf: (key) => client.dump(key).size,
    maxObservedCardinality: () => client.maxObservedCardinality(),
    zsetCommandCount: () => client.zsetCommandCount(),
    resetCounters: () => client.resetCounters(),
  }
}

/* ========================================================================= *
 * AC-RL-15(a) — TTL と maxDuration の導出 / 秒→ms の境界
 * ========================================================================= */

describe('AC-RL-15(a): TTL と maxDuration を単一定数から導出する', () => {
  it('SEMAPHORE_TTL_SEC は PUBLIC_HANDLER_MAX_DURATION_SEC の 2 倍である（片方だけ変えたら落ちる）', () => {
    // これが green なら排除される: `maxDuration` を伸ばして TTL を伸ばし忘れた変更
    //（処理中のパーミットが早期回収され、同時実行上限を超過する）。
    expect(PUBLIC_HANDLER_MAX_DURATION_SEC).toBe(10)
    expect(SEMAPHORE_TTL_SEC).toBe(PUBLIC_HANDLER_MAX_DURATION_SEC * 2)
    expect(SEMAPHORE_TTL_SEC).toBe(20)
  })

  it('semaphoreTtlMs() は秒定数から導出した 20,000 を返す（変換関数は1つだけ）', () => {
    expect(semaphoreTtlMs()).toBe(SEMAPHORE_TTL_SEC * 1000)
    expect(semaphoreTtlMs()).toBe(20_000)
  })

  it('acquire に実際に渡る ttlMs が 20,000 である（RV-P3DR2-004）', async () => {
    // これが green なら排除される: 秒→ms 変換の欠落（TTL 20ms = 処理中パーミットの即時回収 →
    // 上限超過）と二重適用（TTL 5.5時間 = 漏れたパーミットが実質回復しない ＝ RV-P3DR-001 が
    // 閉じようとした恒久枯渇へ逆戻り）。**AC-RL-15(a) の関係式テストは秒の定数同士しか見ないため
    // この事故を一切検出しない**ので、実 ms 値を独立に固定する。
    const keys = semaphoreShardKeys(ENDPOINT)
    const client = createFakeKvClient({ expectedScript: SEMAPHORE_ACQUIRE_LUA })
    client.watchKeys(keys)
    const semaphore = createSemaphore({
      store: createKvSemaphoreStore({ client }),
      endpoint: ENDPOINT,
      perShardLimit: 2,
      // ttlMs を渡さない＝既定（semaphoreTtlMs()）が使われる経路を検証する。
      rng: seededRandom(1),
    })

    await semaphore.acquire({ now: T0 })

    const evalCall = client.calls.find((call) => call.cmd === 'eval' || call.cmd === 'evalsha')
    expect(evalCall, 'acquire は EVAL を1回発行する').toBeDefined()
    expect(Number(evalCall?.args[0]), 'ARGV[1] = nowMs').toBe(T0)
    expect(Number(evalCall?.args[1]), 'ARGV[2] = ttlMs は 20,000 でなければならない').toBe(20_000)
  })
})

describe('AC-RL-15(a): 公開 Route Handler の maxDuration は定数から導出する', () => {
  /**
   * **FS 走査型にする理由**（AC-010-14 と同じ）: `maxDuration` を変更する人が編集するのは
   * `app/api/**\/route.ts` であって `tech-stack.md` ではない。既知ルートのハードコード一覧だと、
   * 後続単位（P3-b / P3-c / P4）で公開ハンドラが増えても**テストを書き換えない限り守られない**。
   * P3-a の時点では対象が 0 件でよいが、**増えたら自動的に対象へ入る構造**であることが完了条件。
   */
  const PUBLIC_ROUTE_PREFIXES = ['applications', 'uploads', 'chat']

  function listPublicRouteFiles(dir: string): string[] {
    if (!existsSync(dir)) return []
    const found: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) found.push(...listPublicRouteFiles(full))
      else if (entry === 'route.ts') found.push(full)
    }
    return found
  }

  const apiRoot = resolve(process.cwd(), 'app/api')
  const publicRoutes = listPublicRouteFiles(apiRoot).filter((file) =>
    PUBLIC_ROUTE_PREFIXES.some((prefix) => relative(apiRoot, file).startsWith(prefix)),
  )

  it('公開ハンドラは maxDuration を PUBLIC_HANDLER_MAX_DURATION_SEC から export する', () => {
    // これが green なら排除される: `export const maxDuration = 30` のように数値を直書きする実装。
    // TTL（= maxDuration × 2）との依存が切れ、処理中のパーミットが早期回収されて上限を超過する。
    const violations = publicRoutes.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return !/export\s+const\s+maxDuration\s*=\s*PUBLIC_HANDLER_MAX_DURATION_SEC\b/.test(source)
    })
    expect(violations.map((file) => relative(process.cwd(), file))).toEqual([])
  })

  it('定数の値は 10 秒（TTL 20秒の半分）', () => {
    expect(PUBLIC_HANDLER_MAX_DURATION_SEC).toBe(10)
  })
})

/* ========================================================================= *
 * AC-RL-15(b) — 上限はシャードあたりの値。全体上限を返す関数がある
 * ========================================================================= */

describe('AC-RL-15(b): 上限の定義（perShardLimit と semaphoreTotalLimit）', () => {
  it('固定シャード数 K = 4', () => {
    expect(SEMAPHORE_SHARDS).toBe(4)
  })

  it('semaphoreTotalLimit() は perShardLimit × シャード数を返す', () => {
    // これが green なら排除される: 「全体で N」と定義してしまい、シャードあたりが N/K になる実装
    //（全体に空きがあるのに選んだシャードが満杯、が常態化する）。
    expect(semaphoreTotalLimit(5)).toBe(5 * SEMAPHORE_SHARDS)
    expect(semaphoreTotalLimit(5, 1)).toBe(5)
    expect(semaphoreTotalLimit(3, 2)).toBe(6)
  })

  it('シャード数はテストから注入できる（AC-RL-11(a)② が SEMAPHORE_SHARDS=1 を要求するため）', () => {
    const { semaphore, keys } = buildHarness({ shards: 1, perShardLimit: 3, ttlMs: TEST_TTL_MS })
    expect(keys).toHaveLength(1)
    expect(semaphore.totalLimit()).toBe(3)
  })
})

/* ========================================================================= *
 * AC-RL-1 / AC-010-13(b) — キーの literal 形式
 * ========================================================================= */

describe('AC-RL-1 / AC-010-13(b): シャードキーの literal 形式（RV-P3DR2-006）', () => {
  it('sem:{applications}:0 〜 :3（ハッシュタグはエンドポイント名）', () => {
    expect(semaphoreShardKeys('applications')).toEqual([
      'sem:{applications}:0',
      'sem:{applications}:1',
      'sem:{applications}:2',
      'sem:{applications}:3',
    ])
  })

  it('uploads / chat も同形', () => {
    expect(semaphoreShardKeys('uploads')).toEqual([
      'sem:{uploads}:0',
      'sem:{uploads}:1',
      'sem:{uploads}:2',
      'sem:{uploads}:3',
    ])
    expect(semaphoreShardKeys('chat', 2)).toEqual(['sem:{chat}:0', 'sem:{chat}:1'])
  })

  it('連番をハッシュタグに入れる禁止形（sem:applications:{0}）になっていない', () => {
    // これが green なら排除される: `sem:<endpoint>:{0..3}` 形。シャードごとに別スロットへ散り、
    // power of two choices の複数キー EVAL が Redis Cluster で `CROSSSLOT` エラーになる。
    for (const key of semaphoreShardKeys('applications')) {
      expect(key).toMatch(/^sem:\{applications\}:\d+$/)
      expect(key, '連番が {} の中に入ってはならない').not.toMatch(/\{\d+\}/)
    }
  })

  it('同一エンドポイントの全シャードのハッシュタグが一致する（同一スロットの成立条件）', () => {
    const tags = semaphoreShardKeys('applications').map((key) => key.match(/\{([^}]*)\}/)?.[1])
    expect(new Set(tags).size).toBe(1)
    expect(tags[0]).toBe('applications')
  })
})

/* ========================================================================= *
 * SEMAPHORE_ACQUIRE_LUA の構造
 *   フェイク KV は Lua を解釈しないため、スクリプト本体はソース文字列に対して検査する。
 * ========================================================================= */

describe('AC-RL-1: acquire スクリプトの構造（掃除 → 判定 → 追加を1本で）', () => {
  const script = () => SEMAPHORE_ACQUIRE_LUA.toUpperCase()

  it('ZREMRANGEBYSCORE → ZCARD → ZADD の順に現れる', () => {
    // これが green なら排除される: 掃除を持たない実装 / 判定より後に掃除する実装。
    const source = script()
    const cleanup = source.indexOf('ZREMRANGEBYSCORE')
    const card = source.indexOf('ZCARD')
    const add = source.indexOf('ZADD')
    expect(cleanup, 'ZREMRANGEBYSCORE を含む').toBeGreaterThanOrEqual(0)
    expect(card, 'ZCARD を含む').toBeGreaterThan(cleanup)
    expect(add, 'ZADD を含む').toBeGreaterThan(card)
  })

  it('掃除は無条件である（最初の ZREMRANGEBYSCORE より前に分岐が無い）', () => {
    // これが green なら排除される: 「空きがありそうなときだけ掃除する」「N 回に1回だけ掃除する」
    // 型の間引き実装（回復の唯一の経路が第1ステップの掃除であるため、間引くと AC-RL-11 が破れる）。
    const source = script()
    const cleanup = source.indexOf('ZREMRANGEBYSCORE')
    const head = source.slice(0, cleanup)
    expect(head, '掃除より前に if 分岐を置かない').not.toMatch(/\bIF\b/)
  })

  it('Lua 内で TIME を読まない（時刻は呼び出し側が ARGV で渡す）', () => {
    // これが green なら排除される: Lua 内で `redis.call('TIME')` を読む実装。
    // 時刻を注入できなくなり、AC-RL-11 が禁じる「実時間 20秒待ちのテスト」しか書けなくなる。
    expect(script()).not.toMatch(/['"]TIME['"]/)
  })

  it('KEYS[1] / KEYS[2] と ARGV[1..4] を使う（複数キー EVAL の形）', () => {
    const source = SEMAPHORE_ACQUIRE_LUA
    expect(source).toContain('KEYS[1]')
    expect(source).toContain('KEYS[2]')
    for (const index of [1, 2, 3, 4]) {
      expect(source, `ARGV[${index}] を使う`).toContain(`ARGV[${index}]`)
    }
  })
})

/* ========================================================================= *
 * AC-RL-11 — 契約 assertion（検出力は semaphore-contract-detects-defects.test.ts が保証）
 * ========================================================================= */

describe('AC-RL-11(a): 期限切れパーミットが継続負荷下で回収される', () => {
  it('全体を満杯にし、満杯であることを固定してから、負荷を継続したまま期限を跨ぐと回復する', async () => {
    // これが green なら排除される: 掃除を持たない実装 / キー単位 TTL（INCR+EXPIRE）方式。
    // ①〜⑤ の手順は helpers/semaphore-contract.ts に実装されている。
    await assertRecoversUnderContinuousLoad(makeHarness)
  })
})

describe('AC-RL-11(d): 掃除を間引く実装の禁止（レビュー §D 23）', () => {
  it('掃除周期の位相を 0〜11 で総当たりしても、期限経過後の最初の acquire が必ず回復する', async () => {
    // これが green なら排除される: 「コストが気になるので N 回に1回だけ掃除する」型の最適化。
    await assertCleanupIsNotThinned(makeHarness)
  })
})

describe('AC-RL-11(e-2): 1回の acquire が発行する原子操作は1回だけ', () => {
  it('成功パス・失敗パスとも ZSET を読み書きするコマンドは1回', async () => {
    // これが green なら排除される: 楽観方式（ZADD → ZCARD → 超過なら自分を ZREM）。
    await assertSingleAtomicCommandPerAcquire(makeHarness)
  })
})

describe('AC-RL-11(e-1)(e-3): 同時に有効なパーミットが上限を超えない', () => {
  it('semaphoreTotalLimit() + 10 件の同時 acquire で、成功数がちょうど上限になる', async () => {
    // これが green なら排除される: Lua 1本だが ZCARD 判定が無い実装（成功数が上限を超える）。
    // 併せて「コマンド境界での濃度合計の最大値」も見るため、楽観方式の一瞬の超過も落とす。
    await assertNeverExceedsTotalLimitUnderConcurrency(makeHarness)
  })

  it('TTL 境界をまたぐ系列でも、濃度合計の最大値が上限を超えない', async () => {
    await assertNeverExceedsTotalLimitAcrossTtlBoundary(makeHarness)
  })
})

describe('AC-RL-11(b)(c): release の局所性と冪等性', () => {
  it('release は acquire が返した key に対して行われ、他シャードに影響しない', async () => {
    await assertReleaseIsShardLocal(makeHarness)
  })

  it('同一 permitId の二重 release が他のパーミットを解放しない', async () => {
    // これが green なら排除される: DECR 型（「在庫を1つ減らす」だけで誰のものか区別しない）実装。
    await assertDoubleReleaseIsIdempotent(makeHarness)
  })
})

/* ========================================================================= *
 * AC-RL-15(c) — power of two choices
 * ========================================================================= */

describe('AC-RL-15(c): シャード選択は power of two choices（乱数注入・固定シード）', () => {
  it('1回の acquire で候補2シャードを 1回の EVAL に渡す', async () => {
    // これが green なら排除される: 「ランダムに1シャードだけ選ぶ」実装
    //（偏りにより公称容量に達する前に Tier C が出る）。
    const { client, semaphore } = buildHarness({
      shards: 4,
      perShardLimit: 1,
      ttlMs: TEST_TTL_MS,
    })
    await semaphore.acquire({ now: T0 })

    const evalCall = client.calls.find((call) => call.cmd === 'eval' || call.cmd === 'evalsha')
    expect(evalCall?.keys, '候補は2本').toHaveLength(2)
    expect(new Set(evalCall?.keys).size, '候補2本は相異なるシャード').toBe(2)
  })

  it('候補の一方が満杯でも、もう一方に空きがあれば成功する（決定的）', async () => {
    // これが green なら排除される: 候補を1本しか見ない実装（この配置では 50% で失敗する）。
    const keys = semaphoreShardKeys(ENDPOINT, 4)
    const client = createFakeKvClient({ expectedScript: SEMAPHORE_ACQUIRE_LUA })
    client.watchKeys(keys)
    // shard0 を満杯にしておく（perShardLimit = 1）。
    await client.zadd(keys[0], T0 + TEST_TTL_MS, 'seed-0')

    const semaphore = createSemaphore({
      store: createKvSemaphoreStore({ client }),
      endpoint: ENDPOINT,
      shards: 4,
      perShardLimit: 1,
      ttlMs: TEST_TTL_MS,
      // 候補導出の規約（ファイル冒頭 2.）により [shard0, shard1] を引く系列。
      rng: scriptedRandom([0, 0]),
      newPermitId: () => 'permit-a',
    })

    const permit = await semaphore.acquire({ now: T0 })
    expect(permit, '満杯でない側（shard1）へ入るので成功する').not.toBeNull()
    expect(permit?.key).toBe(keys[1])
  })
})

/* ========================================================================= *
 * AC-RL-1 / RV-P3DR2-003 — 上限到達時の待機
 * ========================================================================= */

describe('AC-RL-1: 上限到達時の待機（最大2秒・100〜200ms ジッタ付きポーリング）', () => {
  it('待機中に空きが出れば成功する（上限到達中でも正規リクエストが通る）', async () => {
    const { semaphore } = buildHarness({ shards: 1, perShardLimit: 1, ttlMs: TEST_TTL_MS })
    const held = await semaphore.acquire({ now: T0 })
    expect(held).not.toBeNull()

    const clock = { t: T0 }
    let slept = 0
    const result = await semaphore.acquireWithWait({
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms
        slept += 1
        // 1回目のポーリング待ちの間に、先行リクエストが処理を終えて release する。
        if (slept === 1) await semaphore.release(held!)
      },
      random: seededRandom(3),
    })

    expect(result.permit, '待機後に取得できなければならない').not.toBeNull()
    expect(result.attempts, '初回 + 待機後の少なくとも2回試行する').toBeGreaterThanOrEqual(2)
  })

  it('空かないまま待ち上限（2秒）に達したら null を返す（429 ではなく Tier C 判断は呼び出し側）', async () => {
    const { semaphore } = buildHarness({ shards: 1, perShardLimit: 1, ttlMs: TEST_TTL_MS })
    expect(await semaphore.acquire({ now: T0 })).not.toBeNull()

    const clock = { t: T0 }
    const result = await semaphore.acquireWithWait({
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms
      },
      random: seededRandom(4),
    })

    expect(result.permit).toBeNull()
    expect(SEMAPHORE_MAX_WAIT_MS).toBe(2000)
    expect(result.waitedMs, '待機時間は上限を超えない').toBeLessThanOrEqual(SEMAPHORE_MAX_WAIT_MS)
  })

  it('ポーリング間隔が 100〜200ms に収まる（待機中も Function を占有するため上限を持つ）', async () => {
    const { semaphore } = buildHarness({ shards: 1, perShardLimit: 1, ttlMs: TEST_TTL_MS })
    await semaphore.acquire({ now: T0 })

    const clock = { t: T0 }
    const intervals: number[] = []
    await semaphore.acquireWithWait({
      now: () => clock.t,
      sleep: async (ms) => {
        intervals.push(ms)
        clock.t += ms
      },
      random: seededRandom(5),
    })

    expect(SEMAPHORE_POLL_MIN_MS).toBe(100)
    expect(SEMAPHORE_POLL_MAX_MS).toBe(200)
    expect(intervals.length, 'ポーリングが発生する').toBeGreaterThan(0)
    for (const interval of intervals) {
      expect(interval).toBeGreaterThanOrEqual(SEMAPHORE_POLL_MIN_MS)
      expect(interval).toBeLessThanOrEqual(SEMAPHORE_POLL_MAX_MS)
    }
  })

  it('待機中の各ポーリングでシャード候補を選び直す（RV-P3DR2-003 / §D 24）', async () => {
    // これが green なら排除される: 候補ペアを `acquire` の外で1回だけ計算して持ち回る実装。
    // その実装は「全体に空きがあるのに満杯の2シャードを2秒間叩き続けて Tier C を返す」ため、
    // power of two choices の採用理由（偏りによる不要な Tier C を防ぐ）が待機経路で無効化される。
    const keys = semaphoreShardKeys(ENDPOINT, 4)
    const client = createFakeKvClient({ expectedScript: SEMAPHORE_ACQUIRE_LUA })
    client.watchKeys(keys)
    // shard0 / shard1 は満杯、shard2 / shard3 は空き（perShardLimit = 1）。
    await client.zadd(keys[0], T0 + TEST_TTL_MS, 'seed-0')
    await client.zadd(keys[1], T0 + TEST_TTL_MS, 'seed-1')

    const semaphore = createSemaphore({
      store: createKvSemaphoreStore({ client }),
      endpoint: ENDPOINT,
      shards: 4,
      perShardLimit: 1,
      ttlMs: TEST_TTL_MS,
      // 1回目の抽選 → [shard0, shard1]（両方満杯）、2回目の抽選 → [shard2, shard3]（空きあり）。
      rng: scriptedRandom([0, 0, 0.5, 0.7]),
      newPermitId: () => 'permit-retry',
    })

    const clock = { t: T0 }
    const result = await semaphore.acquireWithWait({
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms
      },
      random: seededRandom(6),
    })

    expect(
      result.permit,
      '候補を選び直せば空きシャードに入れる。同一ペアを保持する実装はここで null になる',
    ).not.toBeNull()
    expect([keys[2], keys[3]]).toContain(result.permit?.key)

    const candidateSets = client.calls
      .filter((call) => call.cmd === 'eval' || call.cmd === 'evalsha')
      .map((call) => [...call.keys].sort().join(','))
    expect(new Set(candidateSets).size, '試行ごとに候補ペアが変わる').toBeGreaterThan(1)
  })
})

/* ========================================================================= *
 * §D 26 — permitId は呼び出し側が渡す
 * ========================================================================= */

describe('§D 26: permitId は呼び出し側が渡す（乱数生成をテスト対象の内側に隠さない）', () => {
  it('注入した permitId が ARGV と戻り値の両方に現れる', async () => {
    const keys = semaphoreShardKeys(ENDPOINT, 1)
    const client = createFakeKvClient({ expectedScript: SEMAPHORE_ACQUIRE_LUA })
    client.watchKeys(keys)
    const semaphore = createSemaphore({
      store: createKvSemaphoreStore({ client }),
      endpoint: ENDPOINT,
      shards: 1,
      perShardLimit: 1,
      ttlMs: TEST_TTL_MS,
      newPermitId: () => 'fixed-permit-id',
    })

    const permit = await semaphore.acquire({ now: T0 })
    expect(permit?.permitId).toBe('fixed-permit-id')
    const evalCall = client.calls.find((call) => call.cmd === 'eval' || call.cmd === 'evalsha')
    expect(String(evalCall?.args[3])).toBe('fixed-permit-id')
  })

  it('既定の permitId は 128bit 以上の暗号論的乱数（16進なら 32 文字以上）で、毎回異なる', async () => {
    const keys = semaphoreShardKeys(ENDPOINT, 1)
    const client = createFakeKvClient({ expectedScript: SEMAPHORE_ACQUIRE_LUA })
    client.watchKeys(keys)
    const semaphore = createSemaphore({
      store: createKvSemaphoreStore({ client }),
      endpoint: ENDPOINT,
      shards: 1,
      perShardLimit: 8,
      ttlMs: TEST_TTL_MS,
    })

    const ids = new Set<string>()
    for (let i = 0; i < 8; i++) {
      const permit = await semaphore.acquire({ now: T0 })
      expect(permit).not.toBeNull()
      ids.add(permit!.permitId)
    }
    expect(ids.size, 'permitId は毎回異なる').toBe(8)
    for (const id of ids) {
      expect(id.length, '≥128bit（16進で 32 文字以上）').toBeGreaterThanOrEqual(32)
    }
  })
})

/* ========================================================================= *
 * AC-010-13(a) — serialize（直列化）を経由しない
 * ========================================================================= */

describe('AC-010-13(a): セマフォ操作は serialize を経由しない', () => {
  it('同一シャードへの並行 acquire が KV 上で交錯する（直列化されない）', async () => {
    // これが green なら排除される: `lib/rate-limit.ts` の `serialize`（キー単位の直列化キュー）を
    // セマフォへ流用する実装。セマフォがスループットの単一障害点になっては本末転倒である。
    // ⚠️ この結果を「シャード化が効いた証拠」と読み替えないこと（RV-P3DR2-009）。
    //    ここで効いているのは `serialize` 非経由であって、シャード化ではない。
    const { client, semaphore } = buildHarness({
      shards: 1,
      perShardLimit: 8,
      ttlMs: TEST_TTL_MS,
    })

    await Promise.all(Array.from({ length: 6 }, () => semaphore.acquire({ now: T0 })))

    expect(
      client.maxInFlight(),
      '並行 acquire は KV へ同時に到達しなければならない（直列化キューがあると 1 のままになる）',
    ).toBeGreaterThan(1)
  })
})
