/**
 * セマフォ用フェイク KV クライアント（テスト専用ヘルパ）。
 *
 * ------------------------------------------------------------------------
 * なぜフェイクなのか / 何を検証できて何を検証できないのか（必ず読むこと）
 * ------------------------------------------------------------------------
 * AC-RL-11 (e-2)(e-3) は「**呼び出しを記録するフェイク KV クライアント**」「**各コマンド境界で
 * 全シャードの ZSET 濃度の合計を記録**」を明示的に要求している（`docs/functional-spec.md:1530`）。
 * `docs/spec-p3-fix3-2026-07-29.md` §6 S-3 も「(e-3) はユニットテスト（フェイク KV）でしか
 * 観測できない。実 Redis では `EVAL` が原子的なので超過が観測されない」と書いている。
 * したがってフェイクは「テストを楽にするための手抜き」ではなく、**(e-3) の唯一の観測手段**である。
 *
 * **検証できること**:
 *  - `acquire` 1回あたりに KV へ発行される **ZSET を読み書きするコマンドが1回だけ**か（(e-2)）。
 *    掃除・判定・追加を別コマンドで出す楽観方式はここで落ちる。
 *  - **コマンド境界での濃度合計の最大値**が全体上限を超えないか（(e-3)）。
 *    楽観方式が競合時に作る「一瞬の超過」はここでしか見えない。
 *  - シャード選択・待機時の候補再抽選・`permitId` の扱い・秒→ms 変換・`release` の宛先といった、
 *    **`lib/semaphore.ts` の TypeScript 側のロジック全部**。
 *
 * **検証できないこと（残余リスク。報告書に明記する）**:
 *  - **Lua スクリプト本体の意味論**。Node に Lua ランタイムが無いため、フェイクは
 *    スクリプトを解釈しない。代わりに次の2重の歯止めを置く:
 *      1. `eval` / `evalsha` は **`expectedScript` と同一のスクリプトでなければ throw する**。
 *         つまり実装は「本物のスクリプト定数」を渡さない限り1本もテストを通せない。
 *      2. スクリプト本文の**構造**（`ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` の順序、掃除が
 *         無条件であること、`TIME` を読まないこと）は `semaphore.test.ts` がソース文字列に対して
 *         直接 assert する。
 *    それでも「Lua の中で `ZCARD` 判定を書き間違えた」形は unit では検出できない。
 *    これは AC-RL-11(d) の手順（実装差し替え）と Security 監査の実測項目で押さえる。
 *
 * ------------------------------------------------------------------------
 * `acquire` スクリプトの呼び出し規約（Impl はこれに合わせること）
 * ------------------------------------------------------------------------
 *   KEYS = 候補シャードキー（power of two choices なら2本。`SEMAPHORE_SHARDS = 1` なら1本）
 *   ARGV = [ nowMs, ttlMs, perShardLimit, permitId ]
 *   戻り値 = 成功時 `[key, permitId]` / 空きが無ければ `null`
 *
 * スクリプトが行うこと（フェイクはこの手順を参照実装として実行する）:
 *   1. **各 KEY に対して無条件に** `ZREMRANGEBYSCORE key -inf nowMs`
 *   2. 掃除後の `ZCARD` が小さい方の KEY を選ぶ（同数なら KEYS[1]）
 *   3. 選んだ KEY の `ZCARD < perShardLimit` なら `ZADD key (nowMs + ttlMs) permitId` して
 *      `[key, permitId]` を返す。そうでなければ `null` を返す
 */

/** `eval` の内部から ZSET を触るための最小コンテキスト（記録は行わない）。 */
export interface ScriptContext {
  /** 指定キーの ZSET 実体（member → score）。破壊的に操作してよい。 */
  members(key: string): Map<string, number>
}

/**
 * `eval` が実行する参照実装。既定は「掃除 → 濃度の小さい方 → 上限判定 → 追加」。
 *
 * **テストから差し替えられるようにしてある理由**: `semaphore-contract-detects-defects.test.ts` が
 * 「Lua 1本だが中身が壊れている」実装（掃除が無い / `ZCARD` 判定が無い / キー単位 TTL）に対して
 * 契約 assertion が**赤になること**を確かめるため。本番テストでは既定のまま使う。
 */
export type AcquireScriptRunner = (
  ctx: ScriptContext,
  keys: string[],
  args: (string | number)[],
) => [string, string] | null

export interface FakeKvOptions {
  /**
   * `eval` / `evalsha` に渡されることを要求するスクリプト。
   * 実装が本物の `SEMAPHORE_ACQUIRE_LUA` を渡していないと必ず throw する。
   */
  expectedScript?: string
  /** `eval` の中身。既定は仕様どおりの参照実装（上記 `AcquireScriptRunner` を参照）。 */
  acquireRunner?: AcquireScriptRunner
  /**
   * `evalsha` の初回だけ `NOSCRIPT` を投げる（AC-RL-11(e-2) の carve-out 検証用）。
   * 正しい `evalsha` 実装は `scriptLoad` → 再試行で回復する。
   */
  noScriptOnce?: boolean
  /** 各コマンドの前後に挿入する await 境界（並行性の検証用）。既定 0。 */
  latencyTicks?: number
}

export interface RecordedCall {
  cmd: string
  keys: string[]
  /** `eval` / `evalsha` の ARGV（`[nowMs, ttlMs, perShardLimit, permitId]`）。 */
  args: (string | number)[]
  /** ZSET を実際に読み書きしたか（AC-RL-11(e-2) の数え方）。 */
  touchedZset: boolean
}

export interface FakeKvClient {
  // --- セマフォ実装が使ってよい KV コマンド ---
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
  evalsha(sha: string, keys: string[], args: (string | number)[]): Promise<unknown>
  scriptLoad(script: string): Promise<string>
  zadd(key: string, score: number, member: string): Promise<number>
  zcard(key: string): Promise<number>
  zrem(key: string, member: string): Promise<number>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>
  expire(key: string, seconds: number): Promise<number>

  // --- 観測用（テストからのみ使う） ---
  calls: RecordedCall[]
  /** ZSET を読み書きしたコマンドの発行回数（`scriptLoad` / NOSCRIPT の空振りは数えない）。 */
  zsetCommandCount(): number
  /** 監視対象キー群の濃度合計（現在値）。 */
  totalCardinality(): number
  /** 各コマンド境界で記録した濃度合計の最大値（AC-RL-11(e-3)）。 */
  maxObservedCardinality(): number
  /** 濃度合計の記録系列（デバッグ・証跡用）。 */
  cardinalitySamples: number[]
  /** 濃度合計を数える対象キーを登録する。 */
  watchKeys(keys: readonly string[]): void
  /** 現在の ZSET 内容（member → score）を覗く。 */
  dump(key: string): Map<string, number>
  /**
   * 同時に KV へ入っていたコマンド数の最大値（AC-010-13(a)）。
   * `lib/rate-limit.ts` の `serialize`（キー単位の直列化）を経由する実装は 1 のままになる。
   */
  maxInFlight(): number
  resetCounters(): void
}

class NoScriptError extends Error {
  constructor() {
    super('NOSCRIPT No matching script. Please use EVAL.')
    this.name = 'NoScriptError'
  }
}

export function createFakeKvClient(options: FakeKvOptions = {}): FakeKvClient {
  const zsets = new Map<string, Map<string, number>>()
  const watched = new Set<string>()
  const loadedScripts = new Map<string, string>()
  const calls: RecordedCall[] = []
  const cardinalitySamples: number[] = []
  let noScriptRemaining = options.noScriptOnce ? 1 : 0
  let inFlight = 0
  let maxInFlightSeen = 0

  function zsetOf(key: string): Map<string, number> {
    let zset = zsets.get(key)
    if (!zset) {
      zset = new Map()
      zsets.set(key, zset)
    }
    return zset
  }

  function totalCardinality(): number {
    let total = 0
    for (const key of watched) total += zsets.get(key)?.size ?? 0
    return total
  }

  /**
   * コマンド境界で濃度合計を記録する（AC-RL-11(e-3)）。
   * **コマンドの前後の両方**で取る——楽観方式の「`ZADD` してから `ZREM` で戻す」は
   * 2コマンドの**間**に超過が出るため、後だけ / 前だけでは観測できない。
   */
  function sample(): void {
    cardinalitySamples.push(totalCardinality())
  }

  async function boundary(): Promise<void> {
    sample()
    for (let i = 0; i < (options.latencyTicks ?? 0); i++) await Promise.resolve()
  }

  function record(
    cmd: string,
    keys: string[],
    touchedZset: boolean,
    args: (string | number)[] = [],
  ): void {
    calls.push({ cmd, keys, args, touchedZset })
  }

  /** コマンド1本の実行（前後で濃度をサンプルし、同時実行数を観測する）。 */
  async function command<T>(body: () => T): Promise<T> {
    inFlight += 1
    maxInFlightSeen = Math.max(maxInFlightSeen, inFlight)
    try {
      await boundary()
      const result = body()
      await boundary()
      return result
    } finally {
      inFlight -= 1
    }
  }

  const scriptContext: ScriptContext = { members: zsetOf }

  /** `acquire` スクリプトの参照実装（上記の呼び出し規約どおり）。 */
  const referenceRunner: AcquireScriptRunner = (ctx, keys, args) => {
    const now = Number(args[0])
    const ttlMs = Number(args[1])
    const perShardLimit = Number(args[2])
    const permitId = String(args[3])

    // 1) 各 KEY に対して無条件に期限切れを掃除する（回復の唯一の経路）。
    for (const key of keys) {
      const zset = ctx.members(key)
      for (const [member, score] of zset) {
        if (score <= now) zset.delete(member)
      }
    }
    // 2) 掃除後の濃度が小さい方を選ぶ（同数なら KEYS[1]）。
    let chosen = keys[0]
    for (const key of keys.slice(1)) {
      if (ctx.members(key).size < ctx.members(chosen).size) chosen = key
    }
    // 3) 空きがあれば追加する。
    if (ctx.members(chosen).size >= perShardLimit) return null
    ctx.members(chosen).set(permitId, now + ttlMs)
    return [chosen, permitId]
  }

  const runAcquireScript = (keys: string[], args: (string | number)[]) =>
    (options.acquireRunner ?? referenceRunner)(scriptContext, keys, args)

  return {
    calls,
    cardinalitySamples,

    watchKeys(keys) {
      for (const key of keys) watched.add(key)
    },

    dump(key) {
      return new Map(zsetOf(key))
    },

    zsetCommandCount() {
      return calls.filter((call) => call.touchedZset).length
    },

    totalCardinality,

    maxObservedCardinality() {
      return cardinalitySamples.reduce((max, value) => Math.max(max, value), totalCardinality())
    },

    maxInFlight() {
      return maxInFlightSeen
    },

    resetCounters() {
      calls.length = 0
      cardinalitySamples.length = 0
      maxInFlightSeen = 0
    },

    async eval(script, keys, args) {
      if (options.expectedScript !== undefined && script !== options.expectedScript) {
        throw new Error(
          'fake-kv: eval に渡されたスクリプトが lib/semaphore.ts の SEMAPHORE_ACQUIRE_LUA と一致しない。' +
            ' フェイクは Lua を解釈しないため、本物のスクリプト定数を渡す実装以外は検証できない。',
        )
      }
      return command(() => {
        const result = runAcquireScript(keys, args)
        record('eval', keys, true, args)
        return result
      })
    },

    async evalsha(sha, keys, args) {
      const script = loadedScripts.get(sha)
      if (script === undefined || noScriptRemaining > 0) {
        noScriptRemaining = Math.max(0, noScriptRemaining - 1)
        // ZSET に触れていないので (e-2) の回数には数えない（carve-out）。
        record('evalsha:NOSCRIPT', keys, false, args)
        throw new NoScriptError()
      }
      if (options.expectedScript !== undefined && script !== options.expectedScript) {
        throw new Error('fake-kv: evalsha のスクリプトが SEMAPHORE_ACQUIRE_LUA と一致しない')
      }
      return command(() => {
        const result = runAcquireScript(keys, args)
        record('evalsha', keys, true, args)
        return result
      })
    },

    async scriptLoad(script) {
      // スクリプトのロードは原子単位の回数に数えない（AC-RL-11(e-2) の carve-out）。
      const sha = `sha:${script.length}:${hash(script)}`
      loadedScripts.set(sha, script)
      record('scriptLoad', [], false)
      return sha
    },

    async zadd(key, score, member) {
      return command(() => {
        const zset = zsetOf(key)
        const existed = zset.has(member)
        zset.set(member, score)
        record('zadd', [key], true)
        return existed ? 0 : 1
      })
    },

    async zcard(key) {
      return command(() => {
        record('zcard', [key], true)
        return zsetOf(key).size
      })
    },

    async zrem(key, member) {
      return command(() => {
        const removed = zsetOf(key).delete(member) ? 1 : 0
        record('zrem', [key], true)
        return removed
      })
    },

    async zremrangebyscore(key, _min, max) {
      return command(() => {
        const limit = Number(max)
        const zset = zsetOf(key)
        let removed = 0
        for (const [member, score] of zset) {
          if (score <= limit) {
            zset.delete(member)
            removed += 1
          }
        }
        record('zremrangebyscore', [key], true)
        return removed
      })
    },

    async expire(key, _seconds) {
      record('expire', [key], false)
      return 1
    },
  }
}

function hash(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0
  return h >>> 0
}
