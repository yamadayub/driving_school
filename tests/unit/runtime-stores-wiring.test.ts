import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * =========================================================================
 * P3-b 差し戻し — RV-P3B-003（P3b-2「KV store 注入」を固定するテストが 0 本）
 * =========================================================================
 *
 * 出典: `docs/review-p3b-code-2026-07-29.md` RV-P3B-003（:207）、
 *       `docs/review-p3b-tests-2026-07-29.md` §7（「Senior / Security は『テストが無いこと』を
 *       承認しないこと」）、`docs/security-audit.md` SEC-044 / §E P3b-2。
 *
 * ## この指摘は「テストの不在」そのものである
 * 実装は正しい。`lib/runtime-stores.ts` へ注入経路を 1 本化した設計も**是**と判定されている。
 * にもかかわらず差し戻しなのは、**その設計の価値が「1 箇所を通ること」だけに依存しているのに、
 * それを固定する手段が 1 つも無い**ためである:
 *
 * > `createRateLimiter` の `store` は optional なので、次に limiter を 1 本足す人が `store:` を
 * > 書き忘れても、**型検査も lint も全テストも緑のまま**になる。
 *
 * インメモリのままの limiter は「インスタンスごとに別カウンタ」＝ **全体流量制御にならない**。
 * Vercel の複数インスタンス構成では、上限 5 回が実質 5 × インスタンス数になる。
 * SEC-044（「実装はあるのに注入されていない」）が指摘したのと同じ状態が、
 * **誰にも気付かれずに再生産される**。
 *
 * ## 走査は「文字列一致」ではなく「呼び出し単位」で行う
 * `createRateLimiter(` の出現回数と `store` の出現回数を比べるだけでは、
 * 別の目的で `store` という語を書いた行に騙される。**各呼び出しの引数（括弧の対応を取った範囲）**に
 * `store` が渡っているかを見る。
 */

const REPO = process.cwd()

/** 走査対象。`tests/` `scripts/` は本番経路ではないので除く（`node_modules` も当然除く）。 */
const SCAN_ROOTS = ['app', 'lib', 'components', 'auth.ts', 'auth.config.ts', 'middleware.ts']

/** store 注入が必須のファクトリ。 */
const FACTORIES = ['createRateLimiter', 'createSemaphore'] as const

function listSourceFiles(target: string): string[] {
  const full = resolve(REPO, target)
  let stats
  try {
    stats = statSync(full)
  } catch {
    return []
  }
  if (stats.isFile()) return /\.[cm]?[jt]sx?$/.test(full) ? [full] : []

  const found: string[] = []
  for (const entry of readdirSync(full)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    found.push(...listSourceFiles(join(target, entry)))
  }
  return found
}

/**
 * コメントを落とす。本リポジトリは**設計意図をコメントに厚く書く**流儀なので、
 * 走査対象をコメントごと見ると「説明として関数名を書いただけ」が違反として出る
 *（実測: `lib/rate-limit.ts:14` の解説文が `createKvRateLimitStore()` を含む）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * `factory(` の呼び出しごとに、対応する閉じ括弧までの引数文字列を返す。
 * 括弧の深さを数えるだけの粗い実装だが、文字列リテラル中の括弧は本リポジトリの
 * 該当箇所に存在しないため十分である（存在するようになったら検出が緩む方向ではなく、
 * **範囲が広がる＝より厳しくなる**方向に外れるので安全側）。
 */
function callArguments(source: string, factory: string): string[] {
  const calls: string[] = []
  const pattern = new RegExp(`\\b${factory}\\s*\\(`, 'g')
  for (const match of source.matchAll(pattern)) {
    // **定義側**（`export function createRateLimiter(config)`）は呼び出しではない。
    if (/(function|class)\s+$/.test(source.slice(Math.max(0, match.index - 24), match.index))) {
      continue
    }
    let depth = 0
    const start = match.index + match[0].length
    for (let i = start - 1; i < source.length; i++) {
      const char = source[i]
      if (char === '(') depth++
      else if (char === ')') {
        depth--
        if (depth === 0) {
          calls.push(source.slice(start, i))
          break
        }
      }
    }
  }
  return calls
}

/** 引数に `store` が渡っているか（`store:` / ショートハンド `store,` / `store }` を許す）。 */
function passesStore(args: string): boolean {
  return /\bstore\s*[,:}]/.test(args) || /\bstore\s*$/.test(args.trim())
}

/* ========================================================================= *
 * P3b-2 (1): 本番経路のすべての limiter / セマフォが store を受け取っている
 * ========================================================================= */

describe('RV-P3B-003 / P3b-2: レート制限とセマフォの store 注入をソースで固定する', () => {
  it('本番経路のすべての createRateLimiter / createSemaphore に store が渡っている', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される退行: 次に limiter を 1 本足す人が `store:` を書き忘れ、
    // **その limiter だけが黙ってインメモリのまま**になること。
    // インメモリ = インスタンスごとに別カウンタなので、Vercel の複数インスタンス構成では
    // 上限が実質「上限 × インスタンス数」になる。攻撃者は何もしなくても上限を回避できる。
    // 型検査も lint も既存テストも、この抜けを**1 つも検出しない**（`store` は optional）。
    const violations: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const source = stripComments(readFileSync(file, 'utf8'))
        for (const factory of FACTORIES) {
          for (const args of callArguments(source, factory)) {
            if (!passesStore(args)) {
              violations.push(`${relative(REPO, file)}: ${factory}(...) に store が渡っていない`)
            }
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('store の供給元は lib/runtime-stores.ts の 1 箇所だけである', () => {
    // SEC-044 の是正の核心は「**注入経路を 1 つにして、呼び出し側から選択肢を無くす**」ことだった。
    // これが green なら排除される退行: 各所で `createUpstashKvClient()` / `createKvRateLimitStore()` を
    // 直接呼ぶ形へ戻り、**注入し忘れた 1 箇所を発見する手段が再び失われる**こと
    //（同時に KV 接続がファンアウトして、接続数の上限にも当たる）。
    const violations: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        if (/lib[\\/]runtime-stores\.ts$/.test(file)) continue
        const source = stripComments(readFileSync(file, 'utf8'))
        for (const forbidden of ['createUpstashKvClient', 'createKvRateLimitStore', 'createKvSemaphoreStore']) {
          // 定義しているファイル（`lib/kv.ts` / `lib/semaphore.ts`）は当然対象外。
          if (new RegExp(`(function|const)\\s+${forbidden}\\b`).test(source)) continue
          if (new RegExp(`\\b${forbidden}\\s*\\(`).test(source)) {
            violations.push(
              `${relative(REPO, file)}: ${forbidden}() を直接呼んでいる（注入は lib/runtime-stores.ts 経由に限る）`,
            )
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('公開 2 ルートと auth.ts が runtime-stores から store を取得している', () => {
    // 「store は渡っているが、渡しているのが別物」を排除する（走査 (1) の補完）。
    const required: Array<[string, string[]]> = [
      ['auth.ts', ['sharedRateLimitStore']],
      ['app/api/applications/route.ts', ['sharedRateLimitStore', 'sharedSemaphoreStore']],
      ['app/api/form-session/route.ts', ['sharedRateLimitStore']],
    ]
    for (const [file, symbols] of required) {
      const source = readFileSync(resolve(REPO, file), 'utf8')
      expect(source, `${file} が @/lib/runtime-stores を import していない`).toMatch(
        /from\s+['"]@\/lib\/runtime-stores['"]/,
      )
      for (const symbol of symbols) {
        expect(source, `${file} が ${symbol}() を呼んでいない`).toMatch(
          new RegExp(`\\b${symbol}\\s*\\(`),
        )
      }
    }
  })
})

/* ========================================================================= *
 * 網そのものの自己検証（`api-route-guard-coverage-p3b.test.ts` と同じ流儀）
 * ========================================================================= */

describe('RV-P3B-003: 走査が本当に「store の渡し忘れ」を検出するか（合成ソースで確かめる）', () => {
  // **この describe が無いと本ファイルは「常に green を返すだけのテスト」と区別できない。**
  // 実装が既に正しい以上、上の走査は最初から green である。したがって
  // **「壊れた入力を与えたら赤くなる」ことを示さない限り、退行検知の証拠にならない**
  //（P2 の教訓「テストが緑であることと、守られていることは別」）。

  const withStore = `const a = createRateLimiter({ limit: 5, windowMs: 1, store })`
  const withStoreColon = `const a = createRateLimiter({ limit: 5, store: sharedRateLimitStore() })`
  const withoutStore = `const a = createRateLimiter({ limit: 5, windowMs: 1 })`
  const nestedCall = `const a = createRateLimiter({ limit: f(1, g(2)), store: h() })`
  const nestedWithout = `const a = createRateLimiter({ limit: f(1, g(2)) })`

  it.each([
    ['ショートハンド store', withStore, true],
    ['store: 明示', withStoreColon, true],
    ['store 無し', withoutStore, false],
    ['入れ子の呼び出し + store', nestedCall, true],
    ['入れ子の呼び出し / store 無し', nestedWithout, false],
  ])('%s → 合格=%s', (_label, source, expected) => {
    const args = callArguments(source, 'createRateLimiter')
    expect(args, '呼び出しを 1 つ抽出できていない').toHaveLength(1)
    expect(passesStore(args[0])).toBe(expected)
  })

  it('定義側（export function createRateLimiter(...)）を呼び出しと誤認しない', () => {
    // 誤検出は「検査そのものを外す動機」になる（`lib/public-guard.ts:259-261` と同じ判断）。
    const definition = `export function createRateLimiter(config: RateLimiterConfig): RateLimiter {`
    expect(callArguments(definition, 'createRateLimiter')).toEqual([])
  })

  it('コメント中の関数名を呼び出しと誤認しない', () => {
    const commented = `// createRateLimiter({ limit: 5 }) は store を取る\n/* createSemaphore({}) */`
    expect(callArguments(stripComments(commented), 'createRateLimiter')).toEqual([])
    expect(callArguments(stripComments(commented), 'createSemaphore')).toEqual([])
  })
})

/* ========================================================================= *
 * P3b-2 (2): isKvConfigured() の契約
 * ========================================================================= */

describe('RV-P3B-003 / P3b-2: isKvConfigured() は https:// の REST エンドポイントだけを設定済みと見なす', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  /** env を差し替えたうえで `lib/runtime-stores.ts` を読み直す（`getServerEnv()` のキャッシュを跨ぐ）。 */
  async function isKvConfiguredWith(url: string | undefined, token: string | undefined) {
    vi.resetModules()
    vi.stubEnv('KV_REST_API_URL', url as string)
    vi.stubEnv('KV_REST_API_TOKEN', token as string)
    const mod = await import('@/lib/runtime-stores')
    return mod.isKvConfigured()
  }

  it.each([
    ['https://kv.example.com', 'token', true],
    ['https://kv.example.com', undefined, false],
    ['memory://local-dev-only', 'token', false],
    ['http://kv.example.com', 'token', false],
    ['httpsx://kv.example.com', 'token', false],
    [undefined, 'token', false],
  ])('KV_REST_API_URL=%s / token=%s → %s', async (url, token, expected) => {
    // これが green なら排除される事故:
    //  (a) `memory://local-dev-only`（ローカルの明示的な宣言）が「設定済み」と見なされ、
    //      **レート制限のたびに到達不能なホストへ HTTP を投げて全リクエストが 500 になる**。
    //  (b) 逆に `https://` を「未設定」と誤判定し、**本番が黙ってインメモリへ落ちる**
    //      ——`lib/runtime-stores.ts:16-19` が「本番でこのフォールバックが効くことはない」と
    //      断言している前提そのものが崩れる。
    // 判定を **1 つの関数に閉じた**設計の価値は、その 1 つが正しいことに全面的に依存する。
    expect(await isKvConfiguredWith(url, token)).toBe(expected)
  })
})

/* ========================================================================= *
 * P3b-2 (3): store インスタンスの共有
 * ========================================================================= */

describe('RV-P3B-003 / P3b-2: sharedRateLimitStore() / sharedSemaphoreStore() はメモ化される', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('同一プロセス内で同じインスタンスを返す（KV 設定時）', async () => {
    // これが green なら排除される事故: 呼び出しのたびに `createUpstashKvClient()` を作り、
    // **limiter の本数ぶん KV 接続が増える**こと（Upstash の同時接続上限に当たると
    // レート制限が例外を投げ、防御そのものが落ちる）。
    // 「接続だけを共有し、判定ロジックは共有しない」（AC-RL-8）という設計の実体がこのメモ化である。
    vi.resetModules()
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example.com')
    vi.stubEnv('KV_REST_API_TOKEN', 'token')
    const mod = await import('@/lib/runtime-stores')
    expect(mod.sharedRateLimitStore()).toBe(mod.sharedRateLimitStore())
    expect(mod.sharedSemaphoreStore()).toBe(mod.sharedSemaphoreStore())
  })

  it('KV 未設定なら rate limit store は undefined（createRateLimiter が自前のインメモリを作る）', async () => {
    // 縮退の**明示**。`undefined` を返すことが「インメモリで動かす」の宣言である
    //（`null` や偽の store を返して黙って動かさない）。
    vi.resetModules()
    vi.stubEnv('KV_REST_API_URL', 'memory://local-dev-only')
    vi.stubEnv('KV_REST_API_TOKEN', 'token')
    const mod = await import('@/lib/runtime-stores')
    expect(mod.sharedRateLimitStore()).toBeUndefined()
    // セマフォ側は**必ず何かを返す**（`undefined` を許すと Tier C が消える）。
    expect(mod.sharedSemaphoreStore()).toBeDefined()
    expect(mod.sharedSemaphoreStore()).toBe(mod.sharedSemaphoreStore())
  })
})
