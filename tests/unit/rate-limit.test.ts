import { describe, it, expect } from 'vitest'
import {
  createMemoryRateLimitStore,
  createRateLimiter,
  rateLimitKey,
  type RateLimitEntry,
  type RateLimitStore,
} from '@/lib/rate-limit'

/**
 * SEC-009 / RV-P2-004 — 汎用レート制限基盤（`lib/rate-limit.ts`）。
 *
 * 適用先:
 *  - P2: 管理者ログイン（`auth.ts` の authorize）を `credentials:<ip>` / `credentials:<email>` の
 *    2軸で制限する（SEC-009 修正方針1）。
 *  - P3: 未認証エンドポイント（申込 / 免許証アップロード / チャット）で**同じ基盤を再利用**する。
 *    security-audit.md「P3 着手前の必須前提」より、P3 で作り直さないこと。
 *
 * なぜ `lib/kv.ts` ではなく新規モジュールか（判断理由）:
 *   `lib/kv.ts` の `checkRateLimit` は「throw するだけのプレースホルダ」で、KV(Upstash) 実装と
 *   カウント判定ロジックが1関数に密結合した形をしている。この形だと (a) 単体テストに KV が必要になり、
 *   (b) 時刻を注入できないためウィンドウ経過の検証が実時間 sleep になる。
 *   そこで**判定ロジック（純粋・時刻注入可能）** と **永続化（Store）** を分離した
 *   `lib/rate-limit.ts` を真実源とし、`lib/kv.ts` は将来 `RateLimitStore` の KV 実装
 *   （`createKvRateLimitStore()`）として書き直す方針とする。既定の store はインメモリで、
 *   単一インスタンス（dev / E2E）ではそのまま機能する。
 *
 * 契約（Impl が実装するシグネチャ）:
 *   createRateLimiter({ limit, windowMs, store? }): RateLimiter
 *   RateLimiter.consume(key, now?): Promise<RateLimitResult>  // カウント +1 して判定
 *   RateLimiter.peek(key, now?):    Promise<RateLimitResult>  // カウントを増やさず現在値を確認
 *   RateLimiter.reset(key):         Promise<void>
 *   RateLimitResult = { success, limit, remaining, resetAt, retryAfterMs }
 *
 * 時刻は必ず `now`（epoch ms）引数で注入する。**テストで実時間 sleep をしない**ための必須要件。
 * `now` 省略時は `Date.now()`。
 *
 * consume / peek を分ける理由: ログインは「上限超過なら資格情報を検証せず一律失敗（peek）」かつ
 * 「失敗したときだけアカウント軸のカウントを進める（consume）」という2相の運用が要るため
 * （SEC-009 修正方針1: アカウントあたり5回**失敗**で15分ロック）。
 *
 * red 理由: `lib/rate-limit.ts` が存在しないため import 解決に失敗する（Failed to resolve import）。
 */

// 固定の基準時刻（epoch ms）。実時間に依存しない。
// 2027年1月＝**実時刻より未来**であることは偶然ではなく意図（SEC-035 / RV-P25-006）:
// 時刻ソースを注入しない store（＝ `evictFor` が `Date.now()` を使う既定の挙動）に対して
// 過去の基準時刻を使うと、全エントリが実時刻基準で「期限切れ」と判定されて store が空になり、
// SEC-023（件数上限による退避）の assertion が「退避が働いた」ではなく「全消去された」状態で
// 通ってしまう。未来時刻を選ぶことで、既定 store でも退避方針そのものが検証対象になる。
// 時刻ソースを注入した場合にこの前提が不要であることは、末尾の `T_PAST` のブロックが固定する。
const T0 = 1_800_000_000_000

/** 既定 store の代わりに注入するテスト用 store（KV 実装差し替え可能性の検証も兼ねる）。 */
function createMemoryStore(): RateLimitStore & { calls: string[] } {
  const map = new Map<string, RateLimitEntry>()
  const calls: string[] = []
  return {
    calls,
    async get(key: string) {
      calls.push(`get:${key}`)
      return map.get(key) ?? null
    },
    async set(key: string, entry: RateLimitEntry) {
      calls.push(`set:${key}`)
      map.set(key, entry)
    },
    async delete(key: string) {
      calls.push(`delete:${key}`)
      map.delete(key)
    },
  }
}

describe('SEC-009: createRateLimiter — 上限判定', () => {
  it('上限回数までは success=true、上限を超えると success=false', async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 })

    expect((await limiter.consume('ip:1.2.3.4', T0)).success).toBe(true)
    expect((await limiter.consume('ip:1.2.3.4', T0 + 1)).success).toBe(true)
    expect((await limiter.consume('ip:1.2.3.4', T0 + 2)).success).toBe(true)
    // 4回目は上限超過
    expect((await limiter.consume('ip:1.2.3.4', T0 + 3)).success).toBe(false)
  })

  it('remaining は limit から 1 ずつ減り、0 未満にはならない', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 })

    expect(await limiter.consume('k', T0)).toMatchObject({ success: true, remaining: 1 })
    expect(await limiter.consume('k', T0)).toMatchObject({ success: true, remaining: 0 })
    expect(await limiter.consume('k', T0)).toMatchObject({ success: false, remaining: 0 })
    expect(await limiter.consume('k', T0)).toMatchObject({ success: false, remaining: 0 })
  })

  it('limit と現在の制限値が結果に含まれる（レスポンスヘッダ生成に使える）', async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 })
    const result = await limiter.consume('k', T0)
    expect(result.limit).toBe(5)
  })
})

describe('SEC-009: createRateLimiter — 拒否時の待機情報', () => {
  it('拒否時に resetAt（リセット時刻）と retryAfterMs（残り待機時間）を返す', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 15 * 60_000 })

    await limiter.consume('login:admin@example.com', T0)
    const denied = await limiter.consume('login:admin@example.com', T0 + 1_000)

    expect(denied.success).toBe(false)
    // ウィンドウは最初の試行から開始する
    expect(denied.resetAt).toBe(T0 + 15 * 60_000)
    expect(denied.retryAfterMs).toBe(denied.resetAt - (T0 + 1_000))
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('許可時の retryAfterMs は 0', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 })
    const ok = await limiter.consume('k', T0)
    expect(ok.success).toBe(true)
    expect(ok.retryAfterMs).toBe(0)
  })
})

describe('SEC-009: createRateLimiter — ウィンドウ経過でリセット', () => {
  it('ウィンドウ経過後はカウンタがリセットされ、再び許可される（実時間 sleep しない）', async () => {
    const windowMs = 10 * 60_000
    const limiter = createRateLimiter({ limit: 2, windowMs })

    await limiter.consume('ip:1.2.3.4', T0)
    await limiter.consume('ip:1.2.3.4', T0)
    expect((await limiter.consume('ip:1.2.3.4', T0)).success).toBe(false)

    // ウィンドウ境界の直前はまだ拒否
    expect((await limiter.consume('ip:1.2.3.4', T0 + windowMs - 1)).success).toBe(false)

    // ウィンドウ経過後は新しいウィンドウとして許可
    const afterWindow = await limiter.consume('ip:1.2.3.4', T0 + windowMs)
    expect(afterWindow.success).toBe(true)
    expect(afterWindow.remaining).toBe(1)
    expect(afterWindow.resetAt).toBe(T0 + windowMs * 2)
  })
})

describe('SEC-009: createRateLimiter — キーの独立性', () => {
  it('キーが異なれば独立してカウントされる（IP 軸とアカウント軸の2軸運用の前提）', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 })

    expect((await limiter.consume('credentials:ip:1.1.1.1', T0)).success).toBe(true)
    expect((await limiter.consume('credentials:ip:1.1.1.1', T0)).success).toBe(false)

    // 別 IP は影響を受けない
    expect((await limiter.consume('credentials:ip:2.2.2.2', T0)).success).toBe(true)
    // 別軸（email）も独立
    expect((await limiter.consume('credentials:email:a@example.com', T0)).success).toBe(true)
  })

  it('reset(key) は指定キーのみクリアする', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 })
    await limiter.consume('a', T0)
    await limiter.consume('b', T0)

    await limiter.reset('a')

    expect((await limiter.consume('a', T0)).success).toBe(true)
    expect((await limiter.consume('b', T0)).success).toBe(false)
  })

  it('limiter インスタンスごとに状態が独立する（テスト間の汚染を防ぐ）', async () => {
    const first = createRateLimiter({ limit: 1, windowMs: 60_000 })
    await first.consume('shared-key', T0)

    const second = createRateLimiter({ limit: 1, windowMs: 60_000 })
    expect((await second.consume('shared-key', T0)).success).toBe(true)
  })
})

describe('SEC-009: createRateLimiter — peek（カウントを進めない判定）', () => {
  it('peek はカウントを増やさない', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 })

    expect(await limiter.peek('k', T0)).toMatchObject({ success: true, remaining: 2 })
    expect(await limiter.peek('k', T0)).toMatchObject({ success: true, remaining: 2 })

    await limiter.consume('k', T0)
    expect(await limiter.peek('k', T0)).toMatchObject({ success: true, remaining: 1 })
  })

  it('上限到達後の peek は success=false と retryAfterMs を返す（資格情報を検証せず一律失敗に使う）', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 })
    await limiter.consume('k', T0)

    const gate = await limiter.peek('k', T0 + 5_000)
    expect(gate.success).toBe(false)
    expect(gate.retryAfterMs).toBe(55_000)
  })

  it('未使用キーの peek は success=true・remaining=limit', async () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 })
    expect(await limiter.peek('never-seen', T0)).toMatchObject({
      success: true,
      remaining: 10,
    })
  })
})

describe('SEC-009: createRateLimiter — Store 差し替え（P3 の KV 再利用の前提）', () => {
  it('注入した store を経由して読み書きする', async () => {
    const store = createMemoryStore()
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, store })

    await limiter.consume('ip:9.9.9.9', T0)

    expect(store.calls).toContain('get:ip:9.9.9.9')
    expect(store.calls).toContain('set:ip:9.9.9.9')
  })

  it('注入 store に状態が保持され、判定に反映される', async () => {
    const store = createMemoryStore()
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, store })

    expect((await limiter.consume('k', T0)).success).toBe(true)
    expect((await limiter.consume('k', T0)).success).toBe(false)

    // 同じ store を共有する別 limiter からも同じ状態が見える（サーバーレス複数インスタンス相当）
    const other = createRateLimiter({ limit: 1, windowMs: 60_000, store })
    expect((await other.peek('k', T0)).success).toBe(false)
  })
})

describe('SEC-009: createRateLimiter — 既定の now', () => {
  it('now 省略時は Date.now() を使う（呼び出し側で毎回渡さなくてよい）', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 })
    const before = Date.now()
    const result = await limiter.consume('k')
    expect(result.success).toBe(true)
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60_000)
    expect((await limiter.consume('k')).success).toBe(false)
  })
})

/**
 * ---------------------------------------------------------------------------
 * P2.5 ハードニング（SEC-023 / RV-P2R-002 / RV-P2R-007）— 以下は red として追加。
 * ---------------------------------------------------------------------------
 *
 * SEC-023: 期限切れ判定は `now >= entry.resetAt` の**時刻比較のみ**で行われ、`Map` から
 * エントリが消えるのは `reset()`（＝認証成功時）だけである。認証は未認証で叩けるため、
 * `credentials:ip:<攻撃者が指定した文字列>` というエントリが**リクエストごとに1件、上限も
 * TTL も無く積み上がる**。レート制限はリソース枯渇を防ぐ機構なのに、機構自体が
 * リソースを無制限に消費するのは自己矛盾である（RV-P2R-002）。
 *
 * P3 の未認証エンドポイント（申込 / 画像アップロード / チャット）へ横展開すると、
 * キー空間が完全に攻撃者の制御下に入るため、ここを閉じてからでないと欠陥ごと複製される。
 *
 * 固定する契約:
 *   1. **期限切れは読み取り時に回収する**（`store.delete(key)` を呼ぶ）。
 *   2. **既定のインメモリ store は件数上限を持つ**（超過時は最も古い `resetAt` から退避）。
 *   3. **キーは正規化・長さ制限する**（攻撃者制御の可変長文字列をそのままキーにしない）。
 *   4. **並行 consume が上限を超えて通過しない**（RV-P2R-007。KV 差し替え時に本質的な TOCTOU になる）。
 *
 * 時刻は既存テストと同じく `now` 注入のみで進める（実時間 sleep をしない）。
 */

/** store の中身を観測できるテスト用ラッパ（`size` で常駐件数を数える）。 */
function createObservableStore(): RateLimitStore & { size: () => number; deletes: string[] } {
  const map = new Map<string, RateLimitEntry>()
  const deletes: string[] = []
  return {
    size: () => map.size,
    deletes,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, entry: RateLimitEntry) {
      map.set(key, entry)
    },
    async delete(key: string) {
      deletes.push(key)
      map.delete(key)
    },
  }
}

describe('SEC-023: 期限切れエントリの回収', () => {
  it('ウィンドウ経過後に読み取ると、期限切れエントリは store から削除される', async () => {
    const store = createObservableStore()
    const windowMs = 60_000
    const limiter = createRateLimiter({ limit: 5, windowMs, store })

    await limiter.consume('credentials:ip:1.2.3.4', T0)
    expect(store.size()).toBe(1)

    // ウィンドウ経過後に別キーを読む → 古いキーは論理的に期限切れ。
    await limiter.peek('credentials:ip:1.2.3.4', T0 + windowMs)

    expect(store.deletes, '期限切れを検出したら削除する（読み取り時の遅延回収）').toContain(
      'credentials:ip:1.2.3.4',
    )
  })

  it('二度と現れないキーが積み上がらない: ウィンドウ経過後に走査すれば常駐件数が戻る', async () => {
    const store = createObservableStore()
    const windowMs = 60_000
    const limiter = createRateLimiter({ limit: 5, windowMs, store })

    for (let i = 0; i < 100; i++) {
      await limiter.consume(`credentials:ip:203.0.113.${i}`, T0)
    }
    expect(store.size()).toBe(100)

    // 全キーをウィンドウ経過後に一度だけ触る（＝実運用では次の試行 or スイープ）。
    for (let i = 0; i < 100; i++) {
      await limiter.peek(`credentials:ip:203.0.113.${i}`, T0 + windowMs + 1)
    }

    expect(store.size(), '期限切れエントリが常駐し続けてはならない').toBe(0)
  })

  it('期限切れでないエントリは削除しない', async () => {
    const store = createObservableStore()
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, store })

    await limiter.consume('k', T0)
    await limiter.peek('k', T0 + 1_000)

    expect(store.deletes).not.toContain('k')
    expect(store.size()).toBe(1)
  })
})

describe('SEC-023: 既定インメモリ store の件数上限', () => {
  it('maxEntries を指定すると常駐件数がそれを超えない', async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 5 })
    const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, store })

    for (let i = 0; i < 100; i++) {
      await limiter.consume(`attacker-controlled-key-${i}`, T0)
    }

    expect(store.size(), '攻撃者制御キーで無制限に増殖してはならない').toBeLessThanOrEqual(5)
  })

  it('退避しても最新のキーは残る（直近の攻撃元を取り逃がさない）', async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 3 })
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, store })

    for (let i = 0; i < 10; i++) {
      await limiter.consume(`k-${i}`, T0 + i)
    }

    // 直前に消費したキーは残っているので、2回目は拒否される。
    expect((await limiter.consume('k-9', T0 + 10)).success).toBe(false)
  })

  it('maxEntries 省略時も有限の既定上限を持つ（無制限にしない）', async () => {
    const store = createMemoryRateLimitStore()
    const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, store })

    for (let i = 0; i < 12_000; i++) {
      await limiter.consume(`k-${i}`, T0)
    }

    expect(store.size(), '既定でも上限が要る（本番の long-lived プロセスで OOM に至るため）').toBeLessThanOrEqual(
      10_000,
    )
  })

  it('期限切れのエントリが退避の優先対象になる', async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 3 })
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, store })

    await limiter.consume('old-1', T0)
    await limiter.consume('old-2', T0)
    // 十分に時間を進めてから新しいキーを入れる（old-* は期限切れ）。
    await limiter.consume('fresh', T0 + 120_000)

    expect((await limiter.consume('fresh', T0 + 120_001)).success, 'fresh は保持される').toBe(false)
  })
})

describe('SEC-023: キーの正規化と長さ制限', () => {
  it('rateLimitKey は前後空白を除き小文字化する（大小文字違いで制限を回避させない）', () => {
    expect(rateLimitKey('credentials:email:', '  Admin@Example.COM ')).toBe(
      'credentials:email:admin@example.com',
    )
  })

  it('rateLimitKey の出力長は入力によらず有界', () => {
    const huge = 'a'.repeat(100_000)
    const key = rateLimitKey('credentials:email:', huge)
    expect(key.length).toBeLessThanOrEqual(96)
    expect(key.startsWith('credentials:email:')).toBe(true)
  })

  it('長い入力でも決定的で、異なる入力は異なるキーになる（衝突で巻き添えにしない）', () => {
    const a = 'a'.repeat(1_000)
    const b = `${'a'.repeat(999)}b`
    expect(rateLimitKey('p:', a)).toBe(rateLimitKey('p:', a))
    expect(rateLimitKey('p:', a)).not.toBe(rateLimitKey('p:', b))
  })
})

describe('RV-P2R-007: 並行 consume が上限を超えて通過しない', () => {
  /** get/set の間に必ず割り込みが入る store（KV のネットワーク往復に相当）。 */
  function createSlowStore(): RateLimitStore {
    const map = new Map<string, RateLimitEntry>()
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    return {
      async get(key: string) {
        await tick()
        return map.get(key) ?? null
      },
      async set(key: string, entry: RateLimitEntry) {
        await tick()
        map.set(key, entry)
      },
      async delete(key: string) {
        await tick()
        map.delete(key)
      },
    }
  }

  it('同一キーへの 20 並行 consume のうち、成功は limit 回だけ', async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, store: createSlowStore() })

    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('credentials:ip:1.2.3.4', T0)),
    )

    const allowed = results.filter((r) => r.success).length
    expect(allowed, '並行でも上限を超えて通過してはならない（KV 差し替え時の TOCTOU）').toBe(5)
  })

  it('並行 consume 後のカウンタが limit を超えない', async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, store: createSlowStore() })

    await Promise.all(Array.from({ length: 10 }, () => limiter.consume('k', T0)))

    const state = await limiter.peek('k', T0)
    expect(state.success).toBe(false)
    expect(state.remaining).toBe(0)
  })
})

/* ========================================================================== *
 * T4 — RV-P25-006 / SEC-035: `evictFor` の時刻注入
 *
 * `lib/rate-limit.ts` は「時刻は必ず `now` 引数で注入できる」を設計原則にしているが、
 * store の退避判定（`evictFor`）だけが `Date.now()` を読む。本番では実時刻で一貫するため
 * 機能上の問題は無いが、**テストでは退避方針そのものが検証できない**:
 * 注入時刻が実時刻より過去だと全エントリが「期限切れ」と判定されて store が空になり、
 * 「期限切れ優先 → 最も古い resetAt 順」という方針が一度も実行されないまま assertion が通る。
 *
 * 上の `const T0 = 1_800_000_000_000`（2027年1月＝**実時刻より未来**）は、この不一致を
 * 偶然に隠している。T0 を過去の値へ変えた瞬間に SEC-023 の件数上限テストは空振りする
 * （security-audit.md SEC-035 が実測: 過去時刻で 12 キー投入 / maxEntries=10 → storeSize=2）。
 *
 * 以下は **注入時刻が実時刻より過去でも退避方針が成立する**ことを契約として固定する。
 * これが green なら、`T0` の値の選び方に依存せずに SEC-023（件数上限による退避）の
 * 検証が有効であり続ける＝「上限を守っているように見えて実は全消去していた」という
 * 見落としが起こらなくなる。
 *
 * Impl が実装すべき変更（SEC-035 修正方針）:
 *   export interface MemoryRateLimitStoreOptions {
 *     maxEntries?: number
 *     now?: () => number   // ★追加: 時刻ソース。既定 `Date.now`
 *   }
 *   `evictFor` は `Date.now()` ではなくこの時刻ソースを使う。
 * ========================================================================== */

/** 実時刻より**過去**の基準時刻。`Date.now()` との取り違えを検出するために過去を選ぶ。 */
const T_PAST = 1_000_000

describe('SEC-035 / RV-P25-006: 退避処理が注入された時刻を使う', () => {
  it('注入時刻では期限切れでないエントリを、実時刻を根拠に消してはならない', async () => {
    let clock = T_PAST
    const store = createMemoryRateLimitStore({ maxEntries: 3, now: () => clock })
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, store })

    // 3 件とも resetAt = T_PAST + 60_000。注入時刻の基準ではまだ有効。
    await limiter.consume('a', T_PAST)
    await limiter.consume('b', T_PAST)
    await limiter.consume('c', T_PAST)
    expect(store.size(), '前提: 3 件が常駐している').toBe(3)

    clock = T_PAST + 10
    await limiter.consume('d', T_PAST + 10)

    expect(
      store.size(),
      '期限切れが無いので resetAt 昇順で 1 件だけ退避され、常駐件数は上限のまま保たれる',
    ).toBe(3)
  })

  it('注入時刻で期限切れになったエントリが優先的に退避され、生存エントリは巻き添えにならない', async () => {
    let clock = T_PAST
    const store = createMemoryRateLimitStore({ maxEntries: 3, now: () => clock })
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, store })

    await limiter.consume('old-1', T_PAST) // resetAt = T_PAST + 60_000
    await limiter.consume('old-2', T_PAST)
    await limiter.consume('fresh', T_PAST + 30_000) // resetAt = T_PAST + 90_000

    // old-* だけが期限切れになる時刻へ進める。
    clock = T_PAST + 70_000
    await limiter.consume('new', T_PAST + 70_000)

    // fresh は期限切れではないので残っている＝ 2 回目の consume は上限で拒否される。
    expect(
      (await limiter.consume('fresh', T_PAST + 70_001)).success,
      '期限切れ優先の退避で、生存中のウィンドウを巻き添えにしてはならない',
    ).toBe(false)
  })

  it('時刻ソース未指定なら実時刻で動作する（既定の挙動は変えない）', async () => {
    const store = createMemoryRateLimitStore({ maxEntries: 5 })
    const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, store })

    for (let i = 0; i < 100; i++) {
      await limiter.consume(`k-${i}`, Date.now())
    }

    expect(store.size()).toBeLessThanOrEqual(5)
  })
})
