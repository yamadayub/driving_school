import { describe, it, expect } from 'vitest'
import {
  createFakeKvClient,
  type AcquireScriptRunner,
  type FakeKvClient,
} from './helpers/fake-kv'
import {
  assertCleanupIsNotThinned,
  assertDoubleReleaseIsIdempotent,
  assertNeverExceedsTotalLimitAcrossTtlBoundary,
  assertNeverExceedsTotalLimitUnderConcurrency,
  assertRecoversUnderContinuousLoad,
  assertReleaseIsShardLocal,
  assertSingleAtomicCommandPerAcquire,
  type HarnessConfig,
  type HarnessFactory,
  type PermitLike,
  type SemaphoreHarness,
} from './helpers/semaphore-contract'
import { seededRandom } from './helpers/seeded-random'

/**
 * =========================================================================
 * P3-a / AC-RL-11 — **契約テスト自身の検出力**を検証するメタテスト
 * =========================================================================
 *
 * ## なぜこのファイルがあるか
 *
 * 本プロジェクトでは「テストは green だが守れていない」型の失敗が3回連続で起きている
 * （P2 = テスト対象の取り違え / P2.5 = 契約自体の欠陥 / P3 設計 = AC を素直に読むと
 * 壊れた実装が green になる、が2回）。
 *
 * `tests/unit/helpers/semaphore-contract.ts` の assertion 群は
 * `tests/unit/semaphore.test.ts` から**本物の `lib/semaphore.ts`** に対して実行されるが、
 * それだけでは「その assertion に検出力があるか」を誰も確かめていない。
 * 本ファイルは**意図的に壊した実装**を並べ、各契約が**確かに赤になる**ことを assert する。
 *
 * ここで検証している壊れた実装は、いずれも仕様が名指しで「これは欠陥である」と書いたものである:
 *  - 掃除（`ZREMRANGEBYSCORE`）の欠落        … RV-P3DR-001 が閉じた欠陥の再発
 *  - キー単位 TTL（`INCR`+`EXPIRE`）        … `tech-stack.md:288-297` の破れ方 (1)
 *  - 掃除の間引き                            … レビュー §A-1(4) / §D 23
 *  - Lua 1本だが `ZCARD` 判定なし            … AC-RL-11(e-1) が落とす対象
 *  - 楽観方式（`ZADD`→`ZCARD`→自分を `ZREM`）… AC-RL-11(e-2)(e-3) が落とす対象 /
 *                                              旧機構の欠陥2「最大2倍超過」と同型
 *  - `release` の宛先がシャード非依存        … AC-RL-11(b)
 *  - `release` が任意の member を消す（DECR 型）… AC-RL-11(c)
 *
 * ## AC-RL-11(d) との関係
 *
 * (d) は仕様上「実装差し替えで1回確認する**手順**」であり自動テストではなかった
 * （`spec-p3-fix2-2026-07-29.md:210` が残余リスクとして記録している）。
 * **本ファイルはその手順を自動化したものである。** 「掃除を消すと (a) が落ちる」ことが
 * CI で毎回検証されるため、(a) が将来空振りに退行した場合はここが赤になる。
 * ただし **Lua スクリプト本体の意味論は検証できない**（`helpers/fake-kv.ts` の冒頭を参照）。
 * (d) の手順そのものは Security 監査の実測項目として残る（申し送り S-2）。
 *
 * ## このファイルは現時点で green である（他と違い red ではない）
 *
 * `@/lib/semaphore` を一切 import せず、テスト内に閉じた実装だけを相手にするため。
 * **`lib/semaphore.ts` が実装されても、このファイルは変更してはならない。**
 */

/** フェイク KV が `eval` に要求するスクリプト（本ファイル内の実装が渡す値）。 */
const SCRIPT = '-- test double acquire script'

interface Variant {
  /** `eval` の中身を差し替える（Lua 1本だが中身が壊れている実装を作るため）。 */
  acquireRunner?: AcquireScriptRunner
  /** `eval` を使わない実装（楽観方式）を作るため、ストアの acquire ごと差し替える。 */
  storeAcquire?: (
    client: FakeKvClient,
    keys: string[],
    perShardLimit: number,
    ttlMs: number,
    now: number,
    permitId: string,
  ) => Promise<PermitLike | null>
  /** `release` の宛先の壊し方。 */
  release?: 'shard-local' | 'always-first-shard' | 'any-member'
}

function shardKeys(shards: number): string[] {
  return Array.from({ length: shards }, (_, index) => `sem:{applications}:${index}`)
}

/**
 * テスト用のセマフォ実装を組み立てる。
 * **これは `lib/semaphore.ts` の下書きではない**——契約 assertion の検出力を測るための道具であり、
 * Impl はこの実装を参照せず、AC-RL-1 / AC-RL-11 / AC-RL-15 と `tech-stack.md` §4.5 に従うこと。
 */
function makeHarnessFactory(variant: Variant = {}): HarnessFactory {
  return (config: HarnessConfig): SemaphoreHarness => {
    const keys = shardKeys(config.shards)
    const client = createFakeKvClient({
      expectedScript: SCRIPT,
      acquireRunner: variant.acquireRunner,
      // await 境界を作り、並行 acquire が実際に交錯するようにする
      // （交錯が起きないと (e-3) の「一瞬の超過」を観測できない）。
      latencyTicks: 1,
    })
    client.watchKeys(keys)

    const random = seededRandom(20260729)
    let permitCounter = 0

    /** power of two choices（シャード数1なら候補も1本）。 */
    function pickCandidates(): string[] {
      if (keys.length === 1) return [keys[0]]
      const first = Math.floor(random() * keys.length) % keys.length
      let second = Math.floor(random() * (keys.length - 1)) % (keys.length - 1)
      if (second >= first) second += 1
      return [keys[first], keys[second]]
    }

    const storeAcquire =
      variant.storeAcquire ??
      (async (kv, candidates, perShardLimit, ttlMs, now, permitId) => {
        const result = (await kv.eval(SCRIPT, candidates, [now, ttlMs, perShardLimit, permitId])) as
          | [string, string]
          | null
        return result === null ? null : { key: result[0], permitId: result[1] }
      })

    return {
      shards: config.shards,
      perShardLimit: config.perShardLimit,
      ttlMs: config.ttlMs,
      totalLimit: config.perShardLimit * config.shards,
      keys,
      totalCardinality: () => client.totalCardinality(),
      cardinalityOf: (key) => client.dump(key).size,
      maxObservedCardinality: () => client.maxObservedCardinality(),
      zsetCommandCount: () => client.zsetCommandCount(),
      resetCounters: () => client.resetCounters(),
      semaphore: {
        async acquire({ now }) {
          permitCounter += 1
          const permitId = `permit-${permitCounter}`
          return storeAcquire(
            client,
            pickCandidates(),
            config.perShardLimit,
            config.ttlMs,
            now,
            permitId,
          )
        },
        async release(permit) {
          if (variant.release === 'always-first-shard') {
            await client.zrem(keys[0], permit.permitId)
            return
          }
          if (variant.release === 'any-member') {
            // `DECR` 型の実装が持つ性質を再現する: 「誰の」パーミットかを持たないため、
            // 在庫を1つ減らすことしかできない。
            const members = [...client.dump(permit.key).keys()]
            if (members.length > 0) await client.zrem(permit.key, members[0])
            return
          }
          await client.zrem(permit.key, permit.permitId)
        },
      },
    }
  }
}

/* ------------------------------------------------------------------------ *
 * 壊れた `eval` の中身（Lua 1本だが中身が違う実装）
 * ------------------------------------------------------------------------ */

/** 掃除（`ZREMRANGEBYSCORE`）を持たない。RV-P3DR-001 が閉じた欠陥の再発形。 */
const runnerWithoutCleanup: AcquireScriptRunner = (ctx, keys, args) => {
  const now = Number(args[0])
  const ttlMs = Number(args[1])
  const perShardLimit = Number(args[2])
  const permitId = String(args[3])
  let chosen = keys[0]
  for (const key of keys.slice(1)) {
    if (ctx.members(key).size < ctx.members(chosen).size) chosen = key
  }
  if (ctx.members(chosen).size >= perShardLimit) return null
  ctx.members(chosen).set(permitId, now + ttlMs)
  return [chosen, permitId]
}

/** `ZCARD` による上限判定を持たない（Lua 1本＝原子的ではあるが、上限を守らない）。 */
const runnerWithoutLimitCheck: AcquireScriptRunner = (ctx, keys, args) => {
  const now = Number(args[0])
  const ttlMs = Number(args[1])
  const permitId = String(args[3])
  for (const key of keys) {
    for (const [member, score] of ctx.members(key)) {
      if (score <= now) ctx.members(key).delete(member)
    }
  }
  ctx.members(keys[0]).set(permitId, now + ttlMs)
  return [keys[0], permitId]
}

/** キー単位 TTL（`INCR` + `EXPIRE` を毎 `acquire` で発行）を再現する。 */
function makeKeyTtlRunner(): AcquireScriptRunner {
  const keyExpiry = new Map<string, number>()
  return (ctx, keys, args) => {
    const now = Number(args[0])
    const ttlMs = Number(args[1])
    const perShardLimit = Number(args[2])
    const permitId = String(args[3])
    for (const key of keys) {
      const expiry = keyExpiry.get(key)
      // キーごと期限切れになったときだけ在庫が消える（＝パーミット単位の回復を持たない）。
      if (expiry !== undefined && now >= expiry) ctx.members(key).clear()
      // **`EXPIRE` を毎 acquire で発行する**ため、負荷が続く限り期限が来ない。
      keyExpiry.set(key, now + ttlMs)
    }
    let chosen = keys[0]
    for (const key of keys.slice(1)) {
      if (ctx.members(key).size < ctx.members(chosen).size) chosen = key
    }
    if (ctx.members(chosen).size >= perShardLimit) return null
    ctx.members(chosen).set(permitId, now + ttlMs)
    return [chosen, permitId]
  }
}

/** 掃除を「N 回に1回」へ間引く（コスト最適化のつもりで入りがちな実装）。 */
function makeThinnedCleanupRunner(period: number): AcquireScriptRunner {
  let calls = 0
  return (ctx, keys, args) => {
    const now = Number(args[0])
    const ttlMs = Number(args[1])
    const perShardLimit = Number(args[2])
    const permitId = String(args[3])
    calls += 1
    if (calls % period === 0) {
      for (const key of keys) {
        for (const [member, score] of ctx.members(key)) {
          if (score <= now) ctx.members(key).delete(member)
        }
      }
    }
    let chosen = keys[0]
    for (const key of keys.slice(1)) {
      if (ctx.members(key).size < ctx.members(chosen).size) chosen = key
    }
    if (ctx.members(chosen).size >= perShardLimit) return null
    ctx.members(chosen).set(permitId, now + ttlMs)
    return [chosen, permitId]
  }
}

/** 楽観方式: 掃除・追加・判定・取り消しを**別々のコマンド**で発行する。 */
const optimisticStoreAcquire: NonNullable<Variant['storeAcquire']> = async (
  client,
  keys,
  perShardLimit,
  ttlMs,
  now,
  permitId,
) => {
  const target = keys[0]
  await client.zremrangebyscore(target, '-inf', now)
  await client.zadd(target, now + ttlMs, permitId)
  const size = await client.zcard(target)
  if (size > perShardLimit) {
    await client.zrem(target, permitId)
    return null
  }
  return { key: target, permitId }
}

/* ------------------------------------------------------------------------ *
 * 1. 正しい実装は全ての契約を通る（false red が無いこと）
 * ------------------------------------------------------------------------ */

describe('AC-RL-11: 契約テストは正しい実装を落とさない（false red の否定）', () => {
  const correct = makeHarnessFactory()

  it('(a) 継続負荷下の回復', async () => {
    await expect(assertRecoversUnderContinuousLoad(correct)).resolves.toBeUndefined()
  })

  it('(d) 掃除の間引き禁止', async () => {
    await expect(assertCleanupIsNotThinned(correct)).resolves.toBeUndefined()
  })

  it('(e-2) 1 acquire = 原子操作1回', async () => {
    await expect(assertSingleAtomicCommandPerAcquire(correct)).resolves.toBeUndefined()
  })

  it('(e-1)(e-3) 並行取得で上限を超えない', async () => {
    await expect(assertNeverExceedsTotalLimitUnderConcurrency(correct)).resolves.toBeUndefined()
  })

  it('(e-3) TTL 境界をまたいでも上限を超えない', async () => {
    await expect(assertNeverExceedsTotalLimitAcrossTtlBoundary(correct)).resolves.toBeUndefined()
  })

  it('(b) release の局所性', async () => {
    await expect(assertReleaseIsShardLocal(correct)).resolves.toBeUndefined()
  })

  it('(c) release の冪等性', async () => {
    await expect(assertDoubleReleaseIsIdempotent(correct)).resolves.toBeUndefined()
  })

  it('正しい `evalsha` 実装が `NOSCRIPT` フォールバックしても (e-2) は落ちない（carve-out）', async () => {
    // AC-RL-11(e-2) の carve-out: `SCRIPT LOAD` と NOSCRIPT の空振りは原子単位に数えない。
    // これを数えると**正しい実装が false red になる**——false red は false green と同じ速さで
    // 無視されるようになるため、carve-out 自体をテストで固定する。
    const factory: HarnessFactory = (config) => {
      const base = makeHarnessFactory({
        storeAcquire: async (client, keys, perShardLimit, ttlMs, now, permitId) => {
          const argv = [now, ttlMs, perShardLimit, permitId]
          try {
            const hit = (await client.evalsha('sha:unknown', keys, argv)) as [string, string] | null
            return hit === null ? null : { key: hit[0], permitId: hit[1] }
          } catch {
            const sha = await client.scriptLoad(SCRIPT)
            const result = (await client.evalsha(sha, keys, argv)) as [string, string] | null
            return result === null ? null : { key: result[0], permitId: result[1] }
          }
        },
      })(config)
      return base
    }
    await expect(assertSingleAtomicCommandPerAcquire(factory)).resolves.toBeUndefined()
  })
})

/* ------------------------------------------------------------------------ *
 * 2. 壊れた実装は必ず落ちる（検出力の証明 / AC-RL-11(d) の自動化）
 * ------------------------------------------------------------------------ */

describe('AC-RL-11(a)(d): 掃除を持たない / 間引く実装を検出する', () => {
  it('掃除（ZREMRANGEBYSCORE）を省いた実装は (a) で落ちる — RV-P3DR-001 の再発検知', async () => {
    const broken = makeHarnessFactory({ acquireRunner: runnerWithoutCleanup })
    await expect(assertRecoversUnderContinuousLoad(broken)).rejects.toThrow()
  })

  it('キー単位 TTL（EXPIRE を毎 acquire で発行）型の実装は (a) で落ちる — tech-stack の破れ方(1)', async () => {
    const broken = makeHarnessFactory({ acquireRunner: makeKeyTtlRunner() })
    await expect(assertRecoversUnderContinuousLoad(broken)).rejects.toThrow()
  })

  it('掃除を「3回に1回」へ間引いた実装は (d) で落ちる（フレーキーではなく決定的に）', async () => {
    const broken = makeHarnessFactory({ acquireRunner: makeThinnedCleanupRunner(3) })
    await expect(assertCleanupIsNotThinned(broken)).rejects.toThrow()
  })

  it('掃除を「7回に1回」へ間引いた実装も (d) で落ちる（周期を変えても検出する）', async () => {
    const broken = makeHarnessFactory({ acquireRunner: makeThinnedCleanupRunner(7) })
    await expect(assertCleanupIsNotThinned(broken)).rejects.toThrow()
  })
})

describe('AC-RL-11(e): 同時実行上限を守らない実装を検出する', () => {
  it('Lua 1本だが ZCARD 判定が無い実装は (e-1) で落ちる', async () => {
    const broken = makeHarnessFactory({ acquireRunner: runnerWithoutLimitCheck })
    await expect(assertNeverExceedsTotalLimitUnderConcurrency(broken)).rejects.toThrow()
  })

  it('楽観方式は (e-2)（原子操作1回）で落ちる', async () => {
    const broken = makeHarnessFactory({ storeAcquire: optimisticStoreAcquire })
    await expect(assertSingleAtomicCommandPerAcquire(broken)).rejects.toThrow()
  })

  it('楽観方式は (e-3)（コマンド境界の濃度最大値）でも落ちる — 一瞬の超過は成功数からは見えない', async () => {
    const broken = makeHarnessFactory({ storeAcquire: optimisticStoreAcquire })
    await expect(assertNeverExceedsTotalLimitUnderConcurrency(broken)).rejects.toThrow()
  })
})

describe('AC-RL-11(b)(c): release の宛先が壊れている実装を検出する', () => {
  it('release が常に先頭シャードを叩く実装は (b) で落ちる', async () => {
    const broken = makeHarnessFactory({ release: 'always-first-shard' })
    await expect(assertReleaseIsShardLocal(broken)).rejects.toThrow()
  })

  it('release が「在庫を1つ減らす」だけの DECR 型実装は (c) で落ちる', async () => {
    const broken = makeHarnessFactory({ release: 'any-member' })
    await expect(assertDoubleReleaseIsIdempotent(broken)).rejects.toThrow()
  })
})

describe('フェイク KV は本物のスクリプト定数を渡さない実装を通さない', () => {
  it('eval に別のスクリプトを渡すと throw する（Lua 本文の差し替えを黙って通さない）', async () => {
    const client = createFakeKvClient({ expectedScript: SCRIPT })
    await expect(client.eval('-- 別のスクリプト', ['sem:{applications}:0'], [0, 1, 1, 'p'])).rejects.toThrow(
      /SEMAPHORE_ACQUIRE_LUA/,
    )
  })
})
