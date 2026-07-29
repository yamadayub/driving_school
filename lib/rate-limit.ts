/**
 * 汎用レート制限基盤（SEC-009 / RV-P2-004）。
 *
 * 適用先:
 *  - P2: 管理者ログイン（`auth.ts` の authorize）を IP 軸・アカウント軸の2軸で制限する。
 *  - P3: 未認証エンドポイント（申込 / 免許証アップロード / チャット）で**同じ基盤を再利用**する
 *    （security-audit.md「P3 着手前の必須前提 A」。P3 で作り直さない）。
 *
 * 設計:
 *  - **判定ロジック（純粋・時刻注入可能）** と **永続化（`RateLimitStore`）** を分離する。
 *    旧 `lib/kv.ts` の `checkRateLimit(key, limit, windowSeconds)` は KV(Upstash) 実装と判定ロジックが
 *    1関数に密結合しており、(a) 単体テストに KV 接続が必要、(b) 時刻を注入できずウィンドウ経過の
 *    検証が実時間 sleep になる、という二重の問題があった。本モジュールを真実源とし、
 *    **P3-a で `lib/kv.ts` を `RateLimitStore` の KV 実装（`createKvRateLimitStore()`）へ書き直した**
 *    （`increment` = `INCR` + `EXPIRE` の原子操作のみを持ち、判定は本モジュールに残る）。
 *  - 既定 store はインメモリ。単一インスタンス（dev / E2E / デモ）ではそのまま機能する。
 *    本番（Vercel サーバーレス）ではインスタンスをまたぐ共有が要るため、`store` に KV 実装を
 *    注入して差し替える（tech-stack §3, REV-012）。**インターフェースは既に抽象化済みで、
 *    差し替えに本モジュールの変更は不要**。
 *  - アルゴリズムは固定ウィンドウ。ウィンドウの起点は**最初の試行時刻**。
 *
 * 時刻は必ず `now`（epoch ms）引数で注入できる。省略時は `Date.now()`。
 */

import { createHash } from 'node:crypto'

export interface RateLimitEntry {
  /** 現ウィンドウ内の消費回数。 */
  count: number
  /** ウィンドウが解放される時刻（epoch ms）。 */
  resetAt: number
  /**
   * このバケットが**上限に達している**か（SEC-041 / AC-010-12）。
   *
   * 判定に使う値ではなく、**store が退避の対象から外すためのマーク**である。store は `limit` を
   * 知らないため、上限を知っている `createRateLimiter` 側が書き込み時に立てる。
   * 上限到達済みバケットが退避されると **その キーの count が 0 に戻る**——「カウント0 = 予約枠の
   * 資格（`cleanSource`）」を使う経路では、攻撃者が他キーを大量注入して自分のバケットを追い出す
   * だけでスロットルと資格を取り戻せてしまう（SEC-041）。
   */
  saturated?: boolean
}

/**
 * カウンタの永続化先。インメモリ（既定）/ Vercel KV / Upstash Redis を差し替えるための境界。
 *
 * 実装への要求（SEC-023 / RV-P2R-002）:
 *  - **`resetAt` に対応する TTL を設定すべき**。本モジュールは読み取り時に期限切れを検出して
 *    `delete` するが、それは「二度と読まれないキー」を回収できない。TTL を持つ store
 *    （KV / Redis の `EXPIRE`）であれば、放置されたキーもストレージ側で消える。
 *  - 既定のインメモリ実装（`createMemoryRateLimitStore`）は TTL を持てないため、
 *    **件数上限（既定 10,000 件）による退避**でメモリ増殖を止める。
 *  - KV 実装では `consume` を `INCR` + `EXPIRE` の 1 往復に落とせる（本モジュールが行う
 *    キー単位の直列化はプロセス内でしか効かないため、分散環境では store 側の原子性が要る）。
 */
export interface RateLimitStore {
  get(key: string): Promise<RateLimitEntry | null>
  set(key: string, entry: RateLimitEntry): Promise<void>
  delete(key: string): Promise<void>
  /**
   * **永続化の原子操作**（AC-010-10 / SEC-033）。カウンタを1つ増やして寿命を付け、増加後の状態を返す。
   *
   * **これは判定ではない。** 「上限と比べて許可/拒否を決める」のは `createRateLimiter` の仕事であり、
   * store 側に固定ウィンドウの判定式を書き直してはならない（AC-RL-8）。ここに置くのは、
   * `get` → `set` の read-modify-write が**分散環境では失われた更新を作る**ためである
   * （本モジュールの `serialize` はプロセス内でしか効かない）。
   *
   * 実装した store（`lib/kv.ts`）を注入すると `consume` が自動的にこの経路を使う。
   */
  increment?(key: string, windowMs: number, now: number): Promise<RateLimitEntry>
}

export interface RateLimitResult {
  /** 許可なら true。上限超過で拒否なら false。 */
  success: boolean
  /** 設定上の上限回数（レスポンスヘッダ `X-RateLimit-Limit` 等に使える）。 */
  limit: number
  /** 残り許可回数。0 未満にはならない。 */
  remaining: number
  /** ウィンドウが解放される時刻（epoch ms）。 */
  resetAt: number
  /** 残り待機時間（ms）。許可時は 0。 */
  retryAfterMs: number
}

export interface RateLimiterConfig {
  /** ウィンドウあたりの許可回数。 */
  limit: number
  /** ウィンドウ長（ms）。 */
  windowMs: number
  /** 省略時はこの limiter 専用の新しいインメモリ store を作る（インスタンス間で汚染しない）。 */
  store?: RateLimitStore
}

export interface RateLimiter {
  /** カウントを1消費して判定する。上限超過時はカウントを進めずに拒否を返す。 */
  consume(key: string, now?: number): Promise<RateLimitResult>
  /** カウントを進めずに現在の状態だけを確認する（資格情報を検証する前のゲートに使う）。 */
  peek(key: string, now?: number): Promise<RateLimitResult>
  /** 指定キーのカウンタを消す（認証成功時など、正当な利用者を解放するのに使う）。 */
  reset(key: string): Promise<void>
}

/** 既定の常駐件数上限。無制限にすると long-lived プロセスで OOM に至る（SEC-023）。 */
export const DEFAULT_MEMORY_STORE_MAX_ENTRIES = 10_000

export interface MemoryRateLimitStoreOptions {
  /** 常駐件数の上限。既定 `DEFAULT_MEMORY_STORE_MAX_ENTRIES`。無制限にはできない。 */
  maxEntries?: number
  /**
   * 時刻ソース。既定 `Date.now`（SEC-035 / RV-P25-006）。
   *
   * 退避判定（`evictFor`）が `Date.now()` を直読みすると、**判定側（`consume`/`peek`）が
   * 注入時刻で動いているのに store 側だけ実時刻で動く**という不一致が生じる。注入時刻が実時刻より
   * 過去だと全エントリが「期限切れ」と判定されて store が空になり、「期限切れ優先 → 最も古い
   * `resetAt` 順」という退避方針が一度も実行されないまま assertion が通る（＝ 退行が検出できない）。
   * 本モジュールの設計原則「時刻は必ず注入できる」を store にも適用して不一致を消す。
   */
  now?: () => number
}

export interface MemoryRateLimitStore extends RateLimitStore {
  /** 現在の常駐件数（テスト・監視用）。 */
  size(): number
}

/**
 * プロセス内 Map によるストア実装（既定）。単一インスタンス前提。
 *
 * SEC-023: レート制限のキーは未認証の呼び出し側が実質的に決められる（IP ヘッダ・メール等）ため、
 * 上限を置かないと「リソース枯渇を防ぐ機構自身がリソースを無制限に消費する」状態になる。
 * 上限到達時は **期限切れエントリ → 最も古い `resetAt`** の順に退避する。
 */
export function createMemoryRateLimitStore(
  options: MemoryRateLimitStoreOptions = {},
): MemoryRateLimitStore {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MEMORY_STORE_MAX_ENTRIES))
  /** 退避判定の時刻ソース（SEC-035 / RV-P25-006）。既定は実時刻。 */
  const clock = options.now ?? Date.now
  /** 上限到達時にまとめて退避する件数。1件ずつ消すと全走査が毎回走るため 1% ずつ空ける。 */
  const evictBatch = Math.max(1, Math.ceil(maxEntries / 100))
  const entries = new Map<string, RateLimitEntry>()

  /** 新規キーの挿入で上限を超える場合だけ退避する（既存キーの更新では退避しない）。 */
  function evictFor(incomingKey: string): void {
    if (entries.has(incomingKey) || entries.size < maxEntries) return

    // 1) 期限切れを優先的に回収する（正常なウィンドウを巻き添えにしない）。
    //    時刻は注入された時刻ソースから取る（SEC-035 / RV-P25-006）。
    const now = clock()
    const survivors: Array<[string, RateLimitEntry]> = []
    for (const [key, entry] of entries) {
      if (now >= entry.resetAt) entries.delete(key)
      else survivors.push([key, entry])
    }
    if (entries.size < maxEntries) return

    // 2) それでも足りなければ退避するが、**上限に達したバケットは対象にしない**
    //    （SEC-041 / AC-010-12）。上限到達済みバケットを消すと count が 0 に戻り、攻撃者は
    //    他キーを注入して自分のバケットを追い出すだけでスロットルを解除できてしまう。
    //    未達バケットの中で最も古い `resetAt` から退避する（直近のキーを残す）。
    const evictable = survivors.filter(([, entry]) => entry.saturated !== true)
    // 挿入後も上限内に収まる最小件数は確保しつつ、走査コストを抑えるためまとめて退避する。
    const required = entries.size - maxEntries + 1
    const target = Math.min(evictable.length, Math.max(evictBatch, required))
    evictable.sort((a, b) => a[1].resetAt - b[1].resetAt)
    for (let i = 0; i < target; i++) entries.delete(evictable[i][0])

    // 3) 未達バケットだけでは空きを作れない場合（＝常駐分が全て上限到達）に限り、
    //    最も古い上限到達バケットを退避する。**保護を優先しつつメモリの有界性は必ず守る**
    //    （SEC-023: 制限機構自身がリソースを無制限に消費する状態を作らない）。
    if (entries.size < maxEntries) return
    const saturatedOldestFirst = survivors
      .filter(([, entry]) => entry.saturated === true)
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
    const stillRequired = entries.size - maxEntries + 1
    const fallback = Math.min(saturatedOldestFirst.length, Math.max(1, stillRequired))
    for (let i = 0; i < fallback; i++) entries.delete(saturatedOldestFirst[i][0])
  }

  return {
    size: () => entries.size,
    async get(key) {
      return entries.get(key) ?? null
    },
    async set(key, entry) {
      evictFor(key)
      entries.set(key, entry)
    },
    async delete(key) {
      entries.delete(key)
    },
  }
}

/**
 * レート制限キーを組み立てる（SEC-023 / SEC-032 / AC-RL-4）。
 *
 * `raw` は攻撃者が長さも内容も決められる値（IP ヘッダ・メールアドレス等）なので、
 *  - 前後空白の除去と小文字化で **大小文字違いによる制限回避**を塞ぎ、
 *  - **IPv6 は `/64` に丸め**（下記）、
 *  - 長すぎる入力は `sha256` に畳んで **キー長を有界**にする（store のメモリ増幅を断つ）。
 *
 * 出力長は `prefix.length + MAX_RAW_KEY_LENGTH` を超えない。
 */
const MAX_RAW_KEY_LENGTH = 64
const HASHED_KEY_LENGTH = 32

export function rateLimitKey(prefix: string, raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const normalized = normalizeIpForRateLimitKey(trimmed) ?? trimmed
  if (normalized.length <= MAX_RAW_KEY_LENGTH) return `${prefix}${normalized}`
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, HASHED_KEY_LENGTH)
  return `${prefix}${digest}`
}

/* ------------------------------------------------------------------------- *
 * IPv6 の `/64` 正規化（SEC-032 / AC-RL-4 / AC-010-11）
 * ------------------------------------------------------------------------- */

/**
 * IP リテラルをレート制限キー用の表現へ正規化する。IP として解釈できなければ `null`
 * （＝呼び出し側は入力をそのまま使う。メールアドレス等の既存 2 軸運用を退行させない）。
 *
 * **なぜ `/64` か**: IPv6 は**1契約者に `/64` 以上（アドレス 2^64 個以上）が払い出されるのが標準**
 * である。アドレス単位でキーを作ると、攻撃者は**同じ回線のまま**アドレスを変えるだけで per-source
 * 軸の上限に一度も触れずに叩き続けられる——SEC-022（XFF 偽装）と同じ「軸が軸として機能しない」型で、
 * 未認証・大母数の P3 では致命的になる。
 *
 * **IPv4 射影（`::ffff:a.b.c.d`）は IPv4 として扱う**。`/64` に丸めると `::ffff:0:0/96` が全 IPv4 を
 * 含むため**全 IPv4 利用者が1バケット**に落ち、攻撃者1人で締め出せる。逆に射影と素の IPv4 を別キーに
 * すると、表記を切り替えるだけで上限を2倍使える。
 */
function normalizeIpForRateLimitKey(value: string): string | null {
  if (!value.includes(':')) return null
  const groups = parseIpv6Groups(value)
  if (!groups) return null

  const isIpv4Mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  if (isIpv4Mapped) {
    const high = groups[6]
    const low = groups[7]
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }

  // 上位 64bit（4 グループ）だけを残す。最長 `ffff:ffff:ffff:ffff::/64` = 24 文字。
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}

const IPV6_MAX_LENGTH = 45
const IPV4_OCTET_PATTERN = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4_LITERAL = new RegExp(`^${IPV4_OCTET_PATTERN}(\\.${IPV4_OCTET_PATTERN}){3}$`)
const IPV6_GROUP = /^[0-9a-f]{1,4}$/

/**
 * IPv6 リテラルを 8 個の 16bit グループへ展開する。`::` の省略と末尾の IPv4 記法に対応する。
 * バックトラッキングを避けるため、正規表現は 1 グループ単位の固定長パターンにしか使わない
 * （`lib/http-guard.ts` の `isIpv6Literal` と同じ方針）。
 */
function parseIpv6Groups(value: string): number[] | null {
  if (value.length === 0 || value.length > IPV6_MAX_LENGTH) return null
  if (!/^[0-9a-f:.]+$/.test(value)) return null

  const halves = value.split('::')
  if (halves.length > 2) return null

  /** セグメントを 16bit グループ列へ展開する。不正なら null。 */
  const expand = (segment: string, allowIpv4Tail: boolean): number[] | null => {
    if (segment === '') return []
    const parts = segment.split(':')
    const groups: number[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (allowIpv4Tail && i === parts.length - 1 && part.includes('.')) {
        if (!IPV4_LITERAL.test(part)) return null
        const octets = part.split('.').map(Number)
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        continue
      }
      if (!IPV6_GROUP.test(part)) return null
      groups.push(Number.parseInt(part, 16))
    }
    return groups
  }

  if (halves.length === 1) {
    const groups = expand(halves[0], true)
    return groups && groups.length === 8 ? groups : null
  }

  const head = expand(halves[0], false)
  const tail = expand(halves[1], true)
  if (!head || !tail) return null
  // `::` は 1 グループ以上を省略した記法なので、両側の合計は 7 以下。
  if (head.length + tail.length > 7) return null
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail]
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const { limit, windowMs } = config
  const store = config.store ?? createMemoryRateLimitStore()

  /**
   * 期限切れ（または未使用）なら null を返し、新ウィンドウとして扱わせる。
   *
   * SEC-023: 期限切れを検出したら **その場で store から削除する**（読み取り時の遅延回収）。
   * 時刻比較だけで済ませると、二度と現れないキーのエントリが store に常駐し続ける。
   */
  async function currentEntry(key: string, now: number): Promise<RateLimitEntry | null> {
    const entry = await store.get(key)
    if (!entry) return null
    if (now >= entry.resetAt) {
      await store.delete(key)
      return null
    }
    return entry
  }

  /**
   * RV-P2R-007: 同一キーの操作を直列化する（`get` → `set` の間に別の呼び出しが割り込むと
   * 全員が「上限未満」を読んでから書き込み、上限を超えて通過する＝ TOCTOU）。
   * インメモリ store では `await` 境界が無いため顕在化しないが、KV へ差し替えた瞬間に本質的な
   * 競合になる。**分散環境では store 側の原子性（`INCR`+`EXPIRE`）も併せて必要**で、
   * 本キューはプロセス内の直列化のみを保証する。
   */
  const queues = new Map<string, Promise<void>>()
  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    // 完了したチェーンは回収する（キュー自体がキー空間の増殖源にならないように）。
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return result
  }

  /**
   * `used`（そのウィンドウで既に消費済みの回数）と許可判定から結果を組み立てる。
   * `remaining` は「今後まだ許される回数」なので consume / peek のどちらでも同じ式になる。
   */
  function toResult(used: number, resetAt: number, allowed: boolean, now: number): RateLimitResult {
    return {
      success: allowed,
      limit,
      remaining: Math.max(0, limit - used),
      resetAt,
      retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now),
    }
  }

  return {
    consume(key, now = Date.now()) {
      /**
       * store が原子的な `increment` を持つなら**そちらを本番経路にする**（SEC-033 / AC-010-10）。
       * `serialize` はプロセス内でしか効かないため、Vercel の N インスタンスでは `get`→`set` が
       * 競合して上限を超えて通過する。**判定（`count <= limit`）はここに残る**（AC-RL-8）。
       */
      if (store.increment) {
        return (async () => {
          const entry = await store.increment!(key, windowMs, now)
          return toResult(entry.count, entry.resetAt, entry.count <= limit, now)
        })()
      }

      return serialize(key, async () => {
        // 未使用・期限切れは「count 0 の新しいウィンドウ」として扱う。
        // **`limit` が 0 のときに最初の1回を通してしまわないよう、判定を1本にまとめてある。**
        const entry = await currentEntry(key, now)
        const current = entry ?? { count: 0, resetAt: now + windowMs }

        if (current.count >= limit) {
          // 上限到達済み。カウントをこれ以上進めない（攻撃時の書き込み増幅を避ける）。
          return toResult(current.count, current.resetAt, false, now)
        }

        const nextCount = current.count + 1
        const next: RateLimitEntry = {
          count: nextCount,
          resetAt: current.resetAt,
          // 上限に達したバケットを store の退避対象から外すためのマーク（SEC-041）。
          saturated: nextCount >= limit,
        }
        await store.set(key, next)
        return toResult(next.count, next.resetAt, true, now)
      })
    },

    peek(key, now = Date.now()) {
      // peek も期限切れ回収で store を書き換えるため、consume と同じキューに載せる。
      return serialize(key, async () => {
        const entry = await currentEntry(key, now)
        if (!entry) return toResult(0, now + windowMs, true, now)
        // 「次の consume が通るか」を、カウントを進めずに答える。
        return toResult(entry.count, entry.resetAt, entry.count < limit, now)
      })
    },

    reset(key) {
      return serialize(key, () => store.delete(key))
    },
  }
}
