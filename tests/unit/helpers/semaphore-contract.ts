/**
 * セマフォの契約（AC-RL-11）を **実装非依存** に検証する assertion 群。
 *
 * ------------------------------------------------------------------------
 * なぜ assertion をヘルパへ切り出すのか
 * ------------------------------------------------------------------------
 * P2 / P2.5 / P3 設計レビューで3回続けて起きた失敗は、いずれも
 * 「**テストは green だが、壊れた実装を落とせない**」という同じ型だった。
 * 対策として本ファイルは契約を**関数**として書き、
 *
 *   1. `semaphore.test.ts` — 本物の `lib/semaphore.ts` に対して実行する（現在は red）
 *   2. `semaphore-contract-detects-defects.test.ts` — **意図的に壊した実装**に対して実行し、
 *      **落ちること**を assert する（現在 green）
 *
 * の2方向から使う。2 があることで「この契約が green なら、どの壊れた実装が排除されるのか」が
 * 文章ではなく**実行可能な形**で残る。AC-RL-11(d)（掃除を消すと (a) が落ちること）は
 * 仕様上「実装差し替えで1回確認する手順」だったが、この構造により**自動テスト化**される。
 *
 * 本ファイルは `@/lib/semaphore` を import しない（未実装でも 2 が実行できるようにするため）。
 */

import { expect } from 'vitest'

export interface PermitLike {
  key: string
  permitId: string
}

export interface SemaphoreLike {
  acquire(options: { now: number }): Promise<PermitLike | null>
  release(permit: PermitLike): Promise<void>
}

export interface SemaphoreHarness {
  semaphore: SemaphoreLike
  /** シャード数。 */
  shards: number
  /** シャードあたりの上限。 */
  perShardLimit: number
  /** リース TTL（ms）。 */
  ttlMs: number
  /** エンドポイント全体の同時実行上限（= perShardLimit × shards）。 */
  totalLimit: number
  /** 監視対象シャードキー。 */
  keys: string[]
  /** 全シャードの ZSET 濃度の合計（現在値）。 */
  totalCardinality(): number
  /** 指定シャードの濃度。 */
  cardinalityOf(key: string): number
  /** コマンド境界で記録された濃度合計の最大値（AC-RL-11(e-3)）。 */
  maxObservedCardinality(): number
  /** ZSET を読み書きしたコマンドの発行回数（AC-RL-11(e-2)）。 */
  zsetCommandCount(): number
  resetCounters(): void
}

export interface HarnessConfig {
  shards: number
  perShardLimit: number
  ttlMs: number
}

export type HarnessFactory = (config: HarnessConfig) => SemaphoreHarness | Promise<SemaphoreHarness>

/** 固定の基準時刻（epoch ms）。実時間に依存しない。 */
export const T0 = 1_800_000_000_000
/** 既定のテスト用 TTL（ms）。本番値（20,000）と桁を揃えつつ、時系列を短く保つ。 */
export const TEST_TTL_MS = 20_000

/* ========================================================================= *
 * AC-RL-11(a) — 期限切れパーミットが「継続負荷下で」回収される
 * ========================================================================= */

/**
 * **AC-RL-11(a) ①〜⑤**（`docs/functional-spec.md:1530`）。
 *
 * これが green なら排除される壊れた実装:
 *  - **掃除（`ZREMRANGEBYSCORE`）を持たない実装**（期限が来ても濃度が下がらない）
 *  - **キー単位 TTL（`INCR`+`EXPIRE`）方式**（RV-P3DR-001 の (1)。継続的な `acquire` が
 *    毎回 TTL をリセットするため、注入時刻をいくら進めてもキーが期限切れにならない）
 *  - **テスト自身の空振り**（④ の assert により、容量が余ったまま「回復した」と誤読することが無い）
 *
 * ② シャード数は 1 を既定とする（全体を満杯にするのが決定的になる。RV-P3DR2-001）。
 * ③ 「`acquire` が失敗するまで取る」で満杯を判定しない（本関数は `perShardLimit` × `shards`
 *    件をきっちり取得し、成功したことを1件ずつ assert する）。
 */
export async function assertRecoversUnderContinuousLoad(
  makeHarness: HarnessFactory,
  { perShardLimit = 3, ttlMs = TEST_TTL_MS }: { perShardLimit?: number; ttlMs?: number } = {},
): Promise<void> {
  // ② シャード数 1。回収の性質はシャード数に依存しないため、単一シャードが最も決定的。
  const h = await makeHarness({ shards: 1, perShardLimit, ttlMs })

  // ①③ 全体容量ちょうどを取得する（「失敗するまで取る」ではない）。
  const permits: PermitLike[] = []
  for (let i = 0; i < h.totalLimit; i++) {
    const permit = await h.semaphore.acquire({ now: T0 })
    expect(permit, `${i + 1}件目の acquire は成功しなければならない（容量 ${h.totalLimit}）`).not.toBeNull()
    permits.push(permit as PermitLike)
  }
  expect(permits).toHaveLength(h.totalLimit)

  // ④ 満杯であることを先に固定する。**この assert を省略してはならない**——
  //    省略すると最後の acquire が「回収されたから成功した」のか「もともと空きがあったから
  //    成功した」のか区別できず、テストが空振りしていても green になる（RV-P3DR2-001）。
  expect(
    await h.semaphore.acquire({ now: T0 }),
    '容量ちょうどを取得した直後の acquire は失敗しなければならない（満杯であることの証明）',
  ).toBeNull()

  // ⑤ release を一切呼ばずに、TTL 経過まで acquire を継続的に発生させ続ける。
  //    **無負荷で放置してはならない**——キー単位 TTL の壊れた実装はその書き方に対して green になる。
  const pollStep = 200
  for (let t = T0 + pollStep; t < T0 + ttlMs; t += pollStep) {
    expect(
      await h.semaphore.acquire({ now: t }),
      `リース期限前（now=${t - T0}ms 経過）の acquire は失敗し続けなければならない`,
    ).toBeNull()
  }

  // 期限経過後は、`release` が1度も呼ばれていなくても回復する。
  const recovered = await h.semaphore.acquire({ now: T0 + ttlMs + 1 })
  expect(
    recovered,
    'リース期限経過後の acquire は成功しなければならない（release 無しでの回復 = AC-RL-11 の中核）',
  ).not.toBeNull()
}

/* ========================================================================= *
 * AC-RL-11(d) 後段 — 掃除を「N 回に1回」へ間引く実装の禁止
 * ========================================================================= */

/**
 * **AC-RL-11(d) 後段 / レビュー §D 23**。
 *
 * これが green なら排除される壊れた実装:
 *  - **掃除を間引く実装**（「コストが気になるので N 回に1回だけ `ZREMRANGEBYSCORE` する」）。
 *    回復の唯一の経路が `acquire` 第1ステップの掃除である以上、間引きは AC-RL-11(a) を
 *    **確率的に**破る。確率的な破れはフレーキーとして現れ、原因が特定されにくい。
 *
 * **フレーキーにしない書き方**: 「境界の `acquire` が掃除周期の何番目に当たるか」を
 * `pre`（境界前に投げる失敗 `acquire` の本数）で 0〜11 まで**総当たり**する。
 * 周期 p ≤ 12 のどの間引き実装でも、いずれかの `pre` で境界呼び出しが掃除されない回に当たる。
 * 乱数を使わないため**決定的**である。
 */
export async function assertCleanupIsNotThinned(
  makeHarness: HarnessFactory,
  { ttlMs = TEST_TTL_MS, maxThinningPeriod = 12 }: { ttlMs?: number; maxThinningPeriod?: number } = {},
): Promise<void> {
  for (let pre = 0; pre < maxThinningPeriod; pre++) {
    const h = await makeHarness({ shards: 1, perShardLimit: 2, ttlMs })

    for (let i = 0; i < h.totalLimit; i++) {
      expect(await h.semaphore.acquire({ now: T0 }), `pre=${pre}: 初期取得は成功する`).not.toBeNull()
    }
    // 満杯であることを先に固定する（(a) と同じ理由）。
    expect(await h.semaphore.acquire({ now: T0 }), `pre=${pre}: 満杯であること`).toBeNull()

    // 境界呼び出しの「掃除周期上の位相」をずらすための空振り acquire。
    for (let i = 0; i < pre; i++) {
      expect(await h.semaphore.acquire({ now: T0 + 1 }), `pre=${pre}: 期限前は失敗し続ける`).toBeNull()
    }

    expect(
      await h.semaphore.acquire({ now: T0 + ttlMs + 1 }),
      `pre=${pre}: 期限経過後の最初の acquire で必ず回収されなければならない（掃除の間引きは不可）`,
    ).not.toBeNull()
  }
}

/* ========================================================================= *
 * AC-RL-11(e-2) — 1回の acquire が発行する原子操作は1回だけ
 * ========================================================================= */

/**
 * **AC-RL-11(e-2)**。
 *
 * これが green なら排除される壊れた実装:
 *  - **楽観方式**（`ZADD` → `ZCARD` → 超過なら自分を `ZREM`）。掃除・判定・追加を別コマンドで
 *    発行するため、競合時に**一瞬だけ同時実行上限を超過**する（＝ `tech-stack.md` の訂正注記が
 *    旧機構の欠陥として名指しした「最大2倍超過」と同型）。
 *
 * 成功パスと**失敗パス（満杯）**の両方で数える。失敗パスで別コマンドに分岐する実装を逃さない。
 */
export async function assertSingleAtomicCommandPerAcquire(
  makeHarness: HarnessFactory,
  { ttlMs = TEST_TTL_MS }: { ttlMs?: number } = {},
): Promise<void> {
  const h = await makeHarness({ shards: 2, perShardLimit: 1, ttlMs })

  h.resetCounters()
  expect(await h.semaphore.acquire({ now: T0 }), '成功パスの acquire').not.toBeNull()
  expect(
    h.zsetCommandCount(),
    '成功する acquire が KV へ発行する「ZSET を読み書きするコマンド」は1回だけでなければならない',
  ).toBe(1)

  // 残り容量を埋めてから、満杯（失敗パス）でも1回であることを確認する。
  await h.semaphore.acquire({ now: T0 })
  h.resetCounters()
  expect(await h.semaphore.acquire({ now: T0 }), '満杯なので失敗する').toBeNull()
  expect(
    h.zsetCommandCount(),
    '失敗する acquire でも「ZSET を読み書きするコマンド」は1回だけでなければならない',
  ).toBe(1)
}

/* ========================================================================= *
 * AC-RL-11(e-1)(e-3) — 同時に有効なパーミットが上限を超えない
 * ========================================================================= */

/**
 * **AC-RL-11(e-1) + (e-3)**（並行取得）。
 *
 * これが green なら排除される壊れた実装:
 *  - **Lua 1本だが `ZCARD` 判定を忘れている実装**（(e-1): 成功数が上限を超える）
 *  - **楽観方式**（(e-3): 成功数はちょうど上限になるが、コマンド境界で観測される
 *    濃度の最大値が上限を超える）
 *
 * シャード数は 1 にする——power of two choices（K≥2）では「候補2つが両方満杯」で
 * 全体に空きがあっても失敗しうるため、「成功数がちょうど上限」が成立しない（AC-RL-11(a)③ と同じ理由）。
 */
export async function assertNeverExceedsTotalLimitUnderConcurrency(
  makeHarness: HarnessFactory,
  { perShardLimit = 4, ttlMs = TEST_TTL_MS }: { perShardLimit?: number; ttlMs?: number } = {},
): Promise<void> {
  const h = await makeHarness({ shards: 1, perShardLimit, ttlMs })
  const attempts = h.totalLimit + 10

  const results = await Promise.all(
    Array.from({ length: attempts }, () => h.semaphore.acquire({ now: T0 })),
  )
  const succeeded = results.filter((permit) => permit !== null)

  expect(
    succeeded.length,
    `${attempts} 件を同時に acquire したとき、成功数はちょうど semaphoreTotalLimit()=${h.totalLimit} でなければならない`,
  ).toBe(h.totalLimit)
  expect(
    new Set(succeeded.map((permit) => (permit as PermitLike).permitId)).size,
    '成功した permitId は互いに異なる（同一 permitId の重複発行は上限計算を壊す）',
  ).toBe(succeeded.length)
  expect(h.totalCardinality(), '確定状態の濃度合計が上限を超えない').toBe(h.totalLimit)
  expect(
    h.maxObservedCardinality(),
    'コマンド境界で観測される濃度合計の最大値が上限を超えてはならない（一瞬の超過も不可）',
  ).toBeLessThanOrEqual(h.totalLimit)
}

/**
 * **AC-RL-11(e-3)（TTL 境界をまたぐ系列）**。
 *
 * これが green なら排除される壊れた実装:
 *  - 期限切れの回収と新規追加の間で在庫を一時的に二重計上する実装
 *    （境界前後で濃度が上限を超える瞬間が出る）
 *  - キーごと消す `EXPIRE ... NX` 型（境界で在庫が丸ごと消え、直後に上限の2倍まで積める）
 */
export async function assertNeverExceedsTotalLimitAcrossTtlBoundary(
  makeHarness: HarnessFactory,
  { perShardLimit = 3, ttlMs = TEST_TTL_MS }: { perShardLimit?: number; ttlMs?: number } = {},
): Promise<void> {
  const h = await makeHarness({ shards: 1, perShardLimit, ttlMs })

  for (let i = 0; i < h.totalLimit; i++) {
    expect(await h.semaphore.acquire({ now: T0 }), '初期取得').not.toBeNull()
  }
  expect(await h.semaphore.acquire({ now: T0 }), '満杯であること').toBeNull()

  // TTL 境界を細かく跨ぎながら acquire を投げ続ける（release は一切しない）。
  for (const offset of [ttlMs - 2, ttlMs - 1, ttlMs, ttlMs + 1, ttlMs + 2]) {
    await Promise.all(
      Array.from({ length: h.totalLimit + 5 }, () => h.semaphore.acquire({ now: T0 + offset })),
    )
    expect(
      h.totalCardinality(),
      `now=T0+${offset} の系列後、確定状態の濃度合計が上限を超えない`,
    ).toBeLessThanOrEqual(h.totalLimit)
    expect(
      h.maxObservedCardinality(),
      `now=T0+${offset} の系列で、コマンド境界の濃度合計の最大値が上限を超えない`,
    ).toBeLessThanOrEqual(h.totalLimit)
  }
}

/* ========================================================================= *
 * AC-RL-11(b)(c) — release の局所性と冪等性
 * ========================================================================= */

/**
 * **AC-RL-11(b)**: `release` は `acquire` が返した `key`（シャード）に対して行われ、
 * 他シャードのパーミットを解放しない。
 *
 * これが green なら排除される壊れた実装:
 *  - シャード番号を持ち回らず「先頭シャード」や「再抽選したシャード」へ `ZREM` する実装
 *    （他人のシャードの在庫を減らし、同時実行上限を実質的に超過させる）
 */
export async function assertReleaseIsShardLocal(
  makeHarness: HarnessFactory,
  { ttlMs = TEST_TTL_MS }: { ttlMs?: number } = {},
): Promise<void> {
  const h = await makeHarness({ shards: 2, perShardLimit: 1, ttlMs })

  const first = await h.semaphore.acquire({ now: T0 })
  const second = await h.semaphore.acquire({ now: T0 })
  expect(first, '1件目').not.toBeNull()
  expect(second, '2件目').not.toBeNull()
  expect((first as PermitLike).key, '2シャード×上限1なので別シャードに入る').not.toBe(
    (second as PermitLike).key,
  )
  expect(h.totalCardinality()).toBe(2)

  // **先頭シャード以外**に入ったパーミットを release する。
  // 「常に先頭シャードへ `ZREM` する」型の実装は、たまたま先頭に入ったパーミットを
  // release すると正しく振る舞ってしまうため、先頭以外を選ばないと検出できない。
  const permits = [first as PermitLike, second as PermitLike]
  const target = permits.find((permit) => permit.key !== h.keys[0]) as PermitLike
  const other = permits.find((permit) => permit !== target) as PermitLike
  expect(target, '2シャードのうち片方は先頭シャード以外である').toBeDefined()

  await h.semaphore.release(target)

  expect(h.totalCardinality(), 'release 1件で在庫は1件だけ減る').toBe(1)
  expect(h.cardinalityOf(target.key), 'release したシャードは空になる').toBe(0)
  expect(
    h.cardinalityOf(other.key),
    '他シャードのパーミットは残っていなければならない（release の宛先はシャード局所である）',
  ).toBe(1)
}

/**
 * **AC-RL-11(c)**: 同一 `permitId` に対する `release` の二重呼び出しが、他のパーミットを解放しない。
 *
 * これが green なら排除される壊れた実装:
 *  - `DECR` 型のカウンタ実装（2回目の release が在庫を1つ余計に減らす。0 クランプを入れても
 *    「他人のパーミットを消した」事実は消えない）
 */
export async function assertDoubleReleaseIsIdempotent(
  makeHarness: HarnessFactory,
  { ttlMs = TEST_TTL_MS }: { ttlMs?: number } = {},
): Promise<void> {
  const h = await makeHarness({ shards: 1, perShardLimit: 3, ttlMs })

  const first = await h.semaphore.acquire({ now: T0 })
  const second = await h.semaphore.acquire({ now: T0 })
  const third = await h.semaphore.acquire({ now: T0 })
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(third).not.toBeNull()
  expect(h.totalCardinality()).toBe(3)

  await h.semaphore.release(first as PermitLike)
  await h.semaphore.release(first as PermitLike)
  await h.semaphore.release(first as PermitLike)

  expect(
    h.totalCardinality(),
    '同一 permitId の release を何度呼んでも、減るのは自分の1件だけでなければならない',
  ).toBe(2)
}
