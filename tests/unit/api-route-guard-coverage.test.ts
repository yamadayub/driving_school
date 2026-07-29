import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * =========================================================================
 * P3-a — AC-010-14（SEC-037）/ AC-PII-10: 変更系ルートのラッパ網羅
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-14:797 / AC-PII-10、
 *       `docs/phase-status.md`「P3-a の完了条件 (1)」AC-010-14 の**構造**。
 *
 * ## AC-010-14 の本質（ここを間違えると P2 の再発になる）
 *
 * > **ルート列挙テストの実装形態を指定する（この指定が本条件の本質）**:
 * > `app/api/**\/route.ts` を**ファイルシステム上で走査**し、`POST` / `PATCH` / `PUT` / `DELETE`
 * > を export するモジュールが全て所定のラッパを経由していることを検証する形にすること。
 * > **「既知ルートのハードコード一覧との比較」にしてはならない**——ハードコード一覧だと後続単位で
 * > 新ルートを足しても**テストは green のまま守られない**（P2 の「テスト対象の取り違え」そのもの）。
 * > **新しいルートを追加したときに、テストを書き換えなければ落ちるのが正しい設計**である。
 *
 * したがって本ファイルは**ルート名を一切ハードコードしない**。走査結果に対して
 * 「パスからラッパを決める規則」を適用するだけである。
 *
 * ## red 理由
 * 走査自体は現在の実装に対して green になる（既存の `/api/admin/**` は `withAdminMutation` を
 * 通っている）。**red になるのは「P3-a のラッパが存在すること」を確かめる assertion** で、
 * `lib/public-guard.ts` / `lib/cron-auth.ts` が未作成のため失敗する
 * （import エラーではなく「ファイルが存在しない」という assertion 失敗として出る）。
 */

const API_ROOT = resolve(process.cwd(), 'app/api')
const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * パスからラッパを決める規則（AC-010-14 が固定する割り当て）。
 * **ルート名ではなくパスの接頭辞で決める**ので、新ルートが増えても表を書き換えなくてよい。
 */
const WRAPPER_RULES: ReadonlyArray<{
  prefix: string
  wrapper: string
  module: string
  reason: string
}> = [
  {
    prefix: 'cron/',
    wrapper: 'withCronAuth',
    module: 'lib/cron-auth.ts',
    reason: 'Vercel Cron は Origin を持たないため public-guard の対象外（AC-PII-10）',
  },
  {
    prefix: 'admin/',
    wrapper: 'withAdminMutation',
    module: 'app/api/admin/_guard.ts',
    reason: '認証必須の管理系変更ハンドラ（SEC-011 / SEC-024）',
  },
]

const DEFAULT_RULE = {
  wrapper: 'withPublicMutation',
  module: 'lib/public-guard.ts',
  reason: '公開（未認証）変更系は認証非依存ラッパを必ず通る（SEC-037 / AC-RL-7）',
}

/**
 * ラッパを通らないことが**明示的に許されている**ルート。
 * 追加するには理由が必要で、レビューで見えるようここに残す（暗黙の例外を作らない）。
 */
const DOCUMENTED_EXCEPTIONS: ReadonlyArray<{ prefix: string; reason: string }> = [
  {
    prefix: 'auth/',
    reason:
      'Auth.js（NextAuth）の内蔵ハンドラ。CSRF トークンとコールバック検証をライブラリ自身が持つため、' +
      'アプリ側のラッパで包むとフローが壊れる。認可の多層防御は middleware と各ハンドラの auth() が担う',
  },
]

function listRouteFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...listRouteFiles(full))
    else if (entry === 'route.ts' || entry === 'route.tsx') found.push(full)
  }
  return found
}

/** ルートモジュールのソースから、export されている変更系メソッドを抽出する。 */
export function extractMutationExports(source: string): string[] {
  const found = new Set<string>()
  for (const method of MUTATION_METHODS) {
    // `export const POST = ...` / `export async function POST(` / `export function POST(`
    if (new RegExp(`export\\s+(const|async\\s+function|function)\\s+${method}\\b`).test(source)) {
      found.add(method)
    }
    // `export const { GET, POST } = handlers` のような分割代入 export
    const destructured = source.match(/export\s+const\s*\{([^}]*)\}\s*=/g) ?? []
    for (const match of destructured) {
      if (new RegExp(`\\b${method}\\b`).test(match)) found.add(method)
    }
  }
  return [...found]
}

/** そのメソッドが指定のラッパで包まれているか。 */
export function isWrappedBy(source: string, method: string, wrapper: string): boolean {
  return new RegExp(`export\\s+const\\s+${method}\\s*=\\s*${wrapper}\\s*[<(]`).test(source)
}

/* ------------------------------------------------------------------------- *
 * SEC-047: 「識別子名が一致する」ではなく「**本物のラッパ**を通る」ことを検証する
 * ------------------------------------------------------------------------- *
 *
 * 監査実測（`docs/security-audit.md` SEC-047）:
 * ```
 * ① export async function POST() {…}                 → 1 failed / 10 passed（正しく検出）
 * ② const withPublicMutation = <T,>(h: T) => h        → 11 passed（**検出できない**）
 *    export const POST = withPublicMutation(async () => …)
 * ```
 * `isWrappedBy` はソース文字列の**形**しか見ていないため、同名のローカル no-op 関数で
 * 防御を無効化したルートが green のまま通過した。故意の回避より、リファクタで別モジュールの
 * 同名関数に差し替わる事故のほうが現実的である。
 */

/** import 指定子を絶対パス（拡張子なし）へ解決する。bare specifier は null。 */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return resolve(process.cwd(), specifier.slice(2))
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier)
  return null
}

/** モジュールファイル（`lib/public-guard.ts`）を拡張子なしの絶対パスへ。 */
function moduleToPath(module: string): string {
  return resolve(process.cwd(), module).replace(/\.tsx?$/, '')
}

/**
 * `identifier` が `module` から**値として** import されているか。
 * `import type` と型専用指定子は数えない（型だけ借りて実体はローカル、を通さないため）。
 */
export function importsIdentifierFrom(
  source: string,
  identifier: string,
  module: string,
  fromFile: string,
): boolean {
  const target = moduleToPath(module)
  const importPattern = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(importPattern)) {
    const [, typeOnly, specifiers, from] = match
    if (typeOnly) continue
    if (resolveSpecifier(from, fromFile) !== target) continue
    const bound = specifiers.split(',').map((item) => {
      const trimmed = item.trim().replace(/^type\s+/, '')
      const parts = trimmed.split(/\s+as\s+/)
      return (parts[1] ?? parts[0]).trim()
    })
    if (bound.includes(identifier)) return true
  }
  return false
}

/** 同名のローカル宣言（`const withPublicMutation = …`）が無いか。 */
export function declaresLocally(source: string, identifier: string): boolean {
  return new RegExp(
    `(^|\\n)\\s*(export\\s+)?(const|let|var|function|async\\s+function|class)\\s+${identifier}\\b`,
  ).test(source)
}

/**
 * そのラッパが**本物のモジュール由来**か。
 * これが false なら、名前だけ一致した別物（ローカル no-op / 別モジュールの同名関数）である。
 */
export function usesGenuineWrapper(
  source: string,
  wrapper: string,
  module: string,
  fromFile: string,
): boolean {
  if (declaresLocally(source, wrapper)) return false
  return importsIdentifierFrom(source, wrapper, module, fromFile)
}

function routeIdOf(file: string): string {
  return relative(API_ROOT, file).split(sep).slice(0, -1).join('/') + '/'
}

describe('AC-010-14: 変更系ルートは必ず所定のラッパを通る（FS 走査型）', () => {
  const routeFiles = listRouteFiles(API_ROOT)

  it('app/api 配下の route.ts を実際に走査できている（走査が空振りしていない）', () => {
    // これが green なら排除される: 走査パスを間違えて0件になり、以降の assertion が
    // **何も検証しないまま green になる**状態（P2 の「テスト対象の取り違え」の一種）。
    expect(routeFiles.length, 'app/api 配下に route.ts が1つ以上ある').toBeGreaterThan(0)
  })

  it('変更系メソッドを export する全ルートが、パス規則どおりのラッパを経由している', () => {
    const violations: string[] = []

    for (const file of routeFiles) {
      const routeId = routeIdOf(file)
      const source = readFileSync(file, 'utf8')
      const methods = extractMutationExports(source)
      if (methods.length === 0) continue

      const exception = DOCUMENTED_EXCEPTIONS.find((item) => routeId.startsWith(item.prefix))
      if (exception) continue

      const rule = WRAPPER_RULES.find((item) => routeId.startsWith(item.prefix)) ?? DEFAULT_RULE
      for (const method of methods) {
        if (!isWrappedBy(source, method, rule.wrapper)) {
          violations.push(
            `${relative(process.cwd(), file)}: ${method} が ${rule.wrapper} を経由していない（${rule.reason}）`,
          )
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('ラッパは本物のモジュールから import されている（同名のローカル定義では通らない / SEC-047）', () => {
    // これが green なら排除される壊れた実装: ローカルに no-op の同名関数
    // （`const withPublicMutation = <T,>(h: T) => h`）を置いて防御を消したルート。
    // 監査は実測でこれが **11/11 green のまま通過する**ことを確認している。
    // リファクタで別モジュールの同名関数へ差し替わる事故も同じ形で入る。
    const violations: string[] = []

    for (const file of routeFiles) {
      const routeId = routeIdOf(file)
      const source = readFileSync(file, 'utf8')
      if (extractMutationExports(source).length === 0) continue
      if (DOCUMENTED_EXCEPTIONS.some((item) => routeId.startsWith(item.prefix))) continue

      const rule = WRAPPER_RULES.find((item) => routeId.startsWith(item.prefix)) ?? DEFAULT_RULE
      if (!usesGenuineWrapper(source, rule.wrapper, rule.module, file)) {
        violations.push(
          `${relative(process.cwd(), file)}: ${rule.wrapper} が ${rule.module} 由来でない` +
            `（ローカル定義または別モジュールの同名関数）`,
        )
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('ラッパを通さない例外は、理由付きで明示された接頭辞だけである', () => {
    // 暗黙の例外（「このルートだけ特別」）が増えるのを防ぐ。
    for (const exception of DOCUMENTED_EXCEPTIONS) {
      expect(exception.reason.length, `${exception.prefix} の例外理由が書かれている`).toBeGreaterThan(
        20,
      )
    }
    expect(DOCUMENTED_EXCEPTIONS.map((item) => item.prefix)).toEqual(['auth/'])
  })
})

describe('AC-010-14 / AC-PII-10: ラッパの実体が存在する（P3-a の成果物）', () => {
  it('lib/public-guard.ts が存在する（公開変更系ラッパ）', () => {
    expect(
      existsSync(resolve(process.cwd(), DEFAULT_RULE.module)),
      `${DEFAULT_RULE.module} が未作成（${DEFAULT_RULE.reason}）`,
    ).toBe(true)
  })

  it('lib/cron-auth.ts が存在する（withCronAuth）', () => {
    const rule = WRAPPER_RULES.find((item) => item.wrapper === 'withCronAuth')!
    expect(
      existsSync(resolve(process.cwd(), rule.module)),
      `${rule.module} が未作成（${rule.reason}）`,
    ).toBe(true)
  })

  it('/api/cron/** の割り当てが withCronAuth に固定されている（AC-PII-10）', () => {
    const rule = WRAPPER_RULES.find((item) => item.prefix === 'cron/')
    expect(rule?.wrapper).toBe('withCronAuth')
    // P3-a の時点で `/api/cron/**` の実ルートはまだ無い（P3-c / P3-d の成果物）。
    // **それでもこの割り当てが表にあること**が P3-a の完了条件である
    //（対象が増えたら自動的に対象へ含まれる構造 / `phase-status.md` (1) AC-010-14）。
  })
})

/* ========================================================================= *
 * 列挙テスト自身の検出力（この網が本当に穴を検出するか）
 * ========================================================================= */

describe('AC-010-14: 列挙テストの検出力（合成ソースに対する自己検証）', () => {
  it('ラッパを通らない POST を検出する', () => {
    const source = `export async function POST(request: Request) { return new Response('ok') }`
    expect(extractMutationExports(source)).toEqual(['POST'])
    expect(isWrappedBy(source, 'POST', 'withPublicMutation')).toBe(false)
  })

  it('別のラッパで包まれた POST を「所定のラッパを通っていない」と判定する', () => {
    // これが green なら排除される: `/api/applications` を `withAdminMutation` で包むような
    // 取り違え（認証必須になり公開フォームが動かない／逆は認可が消える）。
    const source = `export const POST = withAdminMutation(async () => new Response())`
    expect(isWrappedBy(source, 'POST', 'withPublicMutation')).toBe(false)
    expect(isWrappedBy(source, 'POST', 'withAdminMutation')).toBe(true)
  })

  it('分割代入 export（export const { GET, POST } = handlers）も変更系として検出する', () => {
    // これが green なら排除される: `export const { POST } = ...` 形でラッパを迂回する書き方を
    // 走査が見落とすこと（Auth.js のルートが実際にこの形をしている）。
    const source = `export const { GET, POST } = handlers`
    expect(extractMutationExports(source)).toContain('POST')
  })

  it('GET だけのルートは対象外（参照系に Origin 検証は過剰）', () => {
    const source = `export async function GET() { return Response.json([]) }`
    expect(extractMutationExports(source)).toEqual([])
  })

  /* --------------------------------------------------------------------- *
   * SEC-047: 偽装ケース（監査が実測で通過させた形）を検出できるか
   * --------------------------------------------------------------------- */

  const ROUTE_FILE = resolve(process.cwd(), 'app/api/applications/route.ts')
  const PUBLIC_GUARD = 'lib/public-guard.ts'

  it('ローカル定義の no-op 同名ラッパを「本物ではない」と判定する（監査実測②）', () => {
    // これが green なら排除される壊れた実装: 防御を消したまま列挙テストを通過するルート。
    // 監査は `app/api/_sec_audit_probe/route.ts` にこの形を置いて **11/11 green** を実測した。
    const source = [
      `const withPublicMutation = <T,>(handler: T) => handler`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(isWrappedBy(source, 'POST', 'withPublicMutation'), '名前の一致だけなら通る').toBe(true)
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })

  it('本物の import（@/lib/public-guard）は通す', () => {
    const source = [
      `import { withPublicMutation } from '@/lib/public-guard'`,
      `export const POST = withPublicMutation(async () => new Response(), { endpoint: 'applications' })`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(true)
  })

  it('相対パス import（../../../lib/public-guard）も同一モジュールとして通す', () => {
    // 解決先が同じファイルなら形式は問わない。ここを specifier の文字列一致にすると、
    // 「本物を import しているのに落ちる」偽陽性でテストが無効化される方向へ壊れる。
    // （`app/api/applications/route.ts` から見たリポジトリルートは `../../../`）
    const source = [
      `import { withPublicMutation } from '../../../lib/public-guard'`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(true)
  })

  it('別モジュールの同名関数は「本物ではない」と判定する', () => {
    const source = [
      `import { withPublicMutation } from '@/lib/legacy-guard'`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })

  it('型だけの import（import type）は「通っている」と見なさない', () => {
    // 型を借りて実体はローカル、という形を通さない。
    const source = [
      `import type { withPublicMutation } from '@/lib/public-guard'`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })

  it('import 済みでも同名のローカル宣言で覆っていれば「本物ではない」と判定する', () => {
    // これが green なら排除される回避: 本物を import して形式を整えつつ、
    // 同名のローカル宣言で実体を差し替える書き方。
    const source = [
      `import { withPublicMutation } from '@/lib/public-guard'`,
      `function withPublicMutation2() {}`,
      `const withPublicMutation = <T,>(handler: T) => handler`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })

  it('管理系は app/api/admin/_guard.ts 由来であることを要求する', () => {
    const adminRoute = resolve(process.cwd(), 'app/api/admin/news/route.ts')
    const source = `import { withAdminMutation } from '@/app/api/admin/_guard'\nexport const POST = withAdminMutation(async () => new Response())`
    expect(
      usesGenuineWrapper(source, 'withAdminMutation', 'app/api/admin/_guard.ts', adminRoute),
    ).toBe(true)
  })

  it('正しく包まれた PUT / DELETE は違反にならない', () => {
    const source = [
      `export const PUT = withAdminMutation<Ctx>(async () => new Response())`,
      `export const DELETE = withAdminMutation<Ctx>(async () => new Response())`,
    ].join('\n')
    expect(extractMutationExports(source).sort()).toEqual(['DELETE', 'PUT'])
    expect(isWrappedBy(source, 'PUT', 'withAdminMutation')).toBe(true)
    expect(isWrappedBy(source, 'DELETE', 'withAdminMutation')).toBe(true)
  })
})
