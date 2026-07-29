/**
 * P3-a セマフォの**自己検証**（テスト green を完了根拠にしないための実測スクリプト）。
 *
 * 実行: `pnpm tsx scripts/verify-semaphore-p3a.ts`
 *
 * ユニットテストとは独立に、`lib/semaphore.ts` の**本物の実装**へ直接シナリオを投入し、
 * 旧機構（`INCR` + キー単位 `EXPIRE`）の2つの欠陥が再現しないことを実測する。
 *
 *  - 欠陥1（恒久枯渇）: `release` されないパーミットが、**`acquire` が継続的に到着している状況でも**
 *    リース期限後に回復すること。
 *  - 欠陥2（最大2倍超過）: 同時実行上限（`perShardLimit × K`）を**超えて成功しない**こと。
 *  - `release` の冪等性: 二重 `release` が他のパーミットを解放しないこと。
 *
 * ⚠️ ここで使う KV は**インメモリのフェイク**である（実 Redis ではない）。したがって
 * **Lua スクリプト本体の意味論は検証していない**（Node に Lua ランタイムが無い）。
 * 検証しているのは `lib/semaphore.ts` の TypeScript 側のロジックと、`acquire` の呼び出し規約
 * （掃除 → 判定 → 追加を単一の原子操作として1回だけ発行すること）である。
 */

import assert from 'node:assert/strict'
import {
  SEMAPHORE_ACQUIRE_LUA,
  createKvSemaphoreStore,
  createSemaphore,
  semaphoreShardKeys,
  semaphoreTtlMs,
  type SemaphoreKvClient,
  type SemaphorePermit,
} from '../lib/semaphore'

/** ZSET 1本ぶんの最小フェイク。`SEMAPHORE_ACQUIRE_LUA` の参照実装を実行する。 */
function createFakeKv(): SemaphoreKvClient & {
  cardinality(keys: string[]): number
  peakCardinality: () => number
  evalCount: () => number
  watch(keys: string[]): void
} {
  const zsets = new Map<string, Map<string, number>>()
  let watched: string[] = []
  let peak = 0
  let evals = 0

  const members = (key: string) => {
    let zset = zsets.get(key)
    if (!zset) {
      zset = new Map()
      zsets.set(key, zset)
    }
    return zset
  }
  const total = () => watched.reduce((sum, key) => sum + (zsets.get(key)?.size ?? 0), 0)
  const sample = () => {
    peak = Math.max(peak, total())
  }

  return {
    watch(keys) {
      watched = [...keys]
    },
    cardinality: (keys) => keys.reduce((sum, key) => sum + (zsets.get(key)?.size ?? 0), 0),
    peakCardinality: () => Math.max(peak, total()),
    evalCount: () => evals,

    async eval(script, keys, args) {
      assert.equal(script, SEMAPHORE_ACQUIRE_LUA, 'eval には本物のスクリプト定数が渡ること')
      evals += 1
      sample()
      // await 境界を作り、並行 acquire が実際に交錯するようにする。
      await Promise.resolve()

      const now = Number(args[0])
      const ttlMs = Number(args[1])
      const perShardLimit = Number(args[2])
      const permitId = String(args[3])

      for (const key of keys) {
        for (const [member, score] of members(key)) {
          if (score <= now) members(key).delete(member)
        }
      }
      let chosen = keys[0]
      for (const key of keys.slice(1)) {
        if (members(key).size < members(chosen).size) chosen = key
      }
      if (members(chosen).size >= perShardLimit) {
        sample()
        return null
      }
      members(chosen).set(permitId, now + ttlMs)
      sample()
      return [chosen, permitId]
    },

    async zrem(key, member) {
      sample()
      const removed = members(key).delete(member) ? 1 : 0
      sample()
      return removed
    },
  }
}

function build(shards: number, perShardLimit: number, ttlMs: number) {
  const keys = semaphoreShardKeys('applications', shards)
  const client = createFakeKv()
  client.watch(keys)
  const semaphore = createSemaphore({
    store: createKvSemaphoreStore({ client }),
    endpoint: 'applications',
    shards,
    perShardLimit,
    ttlMs,
  })
  return { client, semaphore, keys }
}

const T0 = 1_800_000_000_000
const TTL = semaphoreTtlMs()
const results: string[] = []

function report(label: string, detail: string) {
  results.push(`  ${label}: ${detail}`)
  console.log(`  ${label}: ${detail}`)
}

/* ------------------------------------------------------------------------ *
 * S-1: 継続負荷下での回復（旧機構の欠陥1 = 恒久枯渇が再現しないこと）
 * ------------------------------------------------------------------------ */
async function scenarioRecovery(): Promise<void> {
  console.log('\n[S-1] 継続負荷下でのリース回復（release を一度も呼ばない）')
  // シャード数 1 で全体を満杯にする（「全体が満杯」を決定的にするため）。
  const { client, semaphore, keys } = build(1, 3, TTL)

  for (let i = 0; i < 3; i++) {
    assert.notEqual(await semaphore.acquire({ now: T0 }), null, `${i + 1}件目は成功する`)
  }
  assert.equal(client.cardinality(keys), 3, '容量ちょうどが在庫にある')
  assert.equal(await semaphore.acquire({ now: T0 }), null, '満杯なので失敗する')
  report('満杯の固定', '容量3を取得後の追加 acquire = null（＝以降の成功は回復が原因と言える）')

  // TTL 経過まで 200ms 刻みで acquire を**継続的に**投げ続ける（無負荷で放置しない）。
  let attemptsBeforeExpiry = 0
  for (let t = T0 + 200; t < T0 + TTL; t += 200) {
    const permit = await semaphore.acquire({ now: t })
    assert.equal(permit, null, `期限前（+${t - T0}ms）は失敗し続ける`)
    attemptsBeforeExpiry += 1
  }
  report(
    '期限前の継続負荷',
    `${attemptsBeforeExpiry} 回の acquire がすべて null（TTL=${TTL}ms / 200ms 間隔）`,
  )

  const recovered = await semaphore.acquire({ now: T0 + TTL + 1 })
  assert.notEqual(recovered, null, '期限経過後は release 無しでも回復する')
  report('期限経過後', `acquire が成功（key=${recovered?.key}）＝ 恒久枯渇は再現しない`)

  // 掃除が実際に効いていること（在庫が入れ替わっただけで増えていない）。
  assert.equal(client.cardinality(keys), 1, '期限切れ3件が回収され、新規1件だけが残る')
  report('掃除の実測', `期限経過後の在庫 = ${client.cardinality(keys)}（期限切れ3件が回収された）`)
}

/* ------------------------------------------------------------------------ *
 * S-2: 同時実行上限を超えない（旧機構の欠陥2 = 最大2倍超過が再現しないこと）
 * ------------------------------------------------------------------------ */
async function scenarioNeverExceeds(): Promise<void> {
  console.log('\n[S-2] 同時実行上限（perShardLimit × K）を超えて acquire が成功しない')

  for (const shards of [1, 4]) {
    const perShardLimit = 3
    const { client, semaphore, keys } = build(shards, perShardLimit, TTL)
    const totalLimit = semaphore.totalLimit()
    const attempts = totalLimit + 20

    const settled = await Promise.all(
      Array.from({ length: attempts }, () => semaphore.acquire({ now: T0 })),
    )
    const succeeded = settled.filter((permit): permit is SemaphorePermit => permit !== null)
    const uniqueIds = new Set(succeeded.map((permit) => permit.permitId)).size

    assert.ok(
      succeeded.length <= totalLimit,
      `成功数 ${succeeded.length} が上限 ${totalLimit} を超えた`,
    )
    assert.ok(
      client.peakCardinality() <= totalLimit,
      `コマンド境界の濃度最大 ${client.peakCardinality()} が上限 ${totalLimit} を超えた`,
    )
    assert.equal(uniqueIds, succeeded.length, 'permitId が重複していない')
    assert.equal(client.evalCount(), attempts, '1 acquire = 原子操作1回')

    report(
      `K=${shards} / perShardLimit=${perShardLimit}`,
      `並行 ${attempts} 件 → 成功 ${succeeded.length} / 上限 ${totalLimit}` +
        ` / 濃度の観測最大 ${client.peakCardinality()}` +
        ` / 確定在庫 ${client.cardinality(keys)} / eval 発行 ${client.evalCount()} 回`,
    )
  }

  // TTL 境界をまたぐ系列でも一瞬の超過が出ないこと。
  const { client, semaphore } = build(1, 3, TTL)
  const totalLimit = semaphore.totalLimit()
  for (let i = 0; i < totalLimit; i++) await semaphore.acquire({ now: T0 })
  for (const offset of [TTL - 2, TTL - 1, TTL, TTL + 1, TTL + 2]) {
    await Promise.all(
      Array.from({ length: totalLimit + 5 }, () => semaphore.acquire({ now: T0 + offset })),
    )
  }
  assert.ok(
    client.peakCardinality() <= totalLimit,
    `TTL 境界で濃度最大 ${client.peakCardinality()} が上限を超えた`,
  )
  report('TTL 境界をまたぐ系列', `濃度の観測最大 ${client.peakCardinality()} / 上限 ${totalLimit}`)
}

/* ------------------------------------------------------------------------ *
 * S-3: 二重 release が他のパーミットを解放しない
 * ------------------------------------------------------------------------ */
async function scenarioDoubleRelease(): Promise<void> {
  console.log('\n[S-3] 二重 release の冪等性 / release のシャード局所性')

  const { client, semaphore, keys } = build(1, 3, TTL)
  const first = await semaphore.acquire({ now: T0 })
  await semaphore.acquire({ now: T0 })
  await semaphore.acquire({ now: T0 })
  assert.ok(first)
  assert.equal(client.cardinality(keys), 3)

  await semaphore.release(first)
  await semaphore.release(first)
  await semaphore.release(first)
  assert.equal(client.cardinality(keys), 2, '二重 release で他のパーミットが消えてはならない')
  report('二重 release', `3件取得 → 同一 permitId を3回 release → 在庫 ${client.cardinality(keys)}（期待 2）`)

  // シャード局所性: 2シャード×上限1で別シャードに入れ、先頭以外を release する。
  const two = build(2, 1, TTL)
  const a = await two.semaphore.acquire({ now: T0 })
  const b = await two.semaphore.acquire({ now: T0 })
  assert.ok(a && b && a.key !== b.key, '2シャード×上限1 なので別シャードに入る')
  const target = [a, b].find((permit) => permit.key !== two.keys[0]) as SemaphorePermit
  const other = [a, b].find((permit) => permit !== target) as SemaphorePermit
  await two.semaphore.release(target)
  assert.equal(two.client.cardinality([target.key]), 0, 'release したシャードは空になる')
  assert.equal(two.client.cardinality([other.key]), 1, '他シャードのパーミットは残る')
  report(
    'release の局所性',
    `${target.key} を release → 当該シャード 0 / 他シャード ${two.client.cardinality([other.key])}`,
  )
}

async function main(): Promise<void> {
  console.log('P3-a セマフォ 自己検証（本物の lib/semaphore.ts に対する実測）')
  console.log(`TTL = ${TTL}ms / 基準時刻 T0 = ${T0}`)
  await scenarioRecovery()
  await scenarioNeverExceeds()
  await scenarioDoubleRelease()
  console.log('\n=== 全シナリオ PASS ===')
}

main().catch((error) => {
  console.error('\n=== 自己検証 FAILED ===')
  console.error(error)
  process.exitCode = 1
})
