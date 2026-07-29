/**
 * ルート列挙テストのスキャナ（P3b-7 / SEC-054 で強化した版）。
 *
 * ------------------------------------------------------------------------
 * なぜ `tests/unit/api-route-guard-coverage.test.ts` から切り出したのか
 * ------------------------------------------------------------------------
 * P3-a のスキャナはテストファイル本体に埋まっており、強化のたびに**テスト本体を書き換える**
 * ことになる。SEC-054 が要求する3点（再 export の検出 / `route.js` の走査 / エイリアス import の
 * 厳格化）は「スキャナの能力」であって「テストケース」ではないため、モジュールへ分離して
 * **合成ソースに対する自己検証**（この網が本当に穴を検出するか）をテスト側に置く。
 *
 * ------------------------------------------------------------------------
 * SEC-054 の実測（監査が 19/19 green のまま通過させた3形）
 * ------------------------------------------------------------------------
 * | # | 細工 | P3-a のスキャナ | 本モジュール |
 * |---|------|----------------|-------------|
 * | ② | `handler.ts` に無防備な POST、`route.ts` は `export { POST } from './handler'` | 通過 | **違反** |
 * | ③ | `import { TIER_B_BODY as withPublicMutation } from '@/lib/public-guard'` | 通過 | **違反** |
 * | ④ | `route.js` に無防備な POST | 走査対象外 | **走査する** |
 *
 * ② を**無条件に違反**とするのは監査の修正方針そのものである——再 export は
 * 「その場でラッパ経由か判定できない」ため、「`route.ts` 内で `withPublicMutation` を適用する」
 * という**1つの書き方に固定する**のが最も安く、かつ検証可能である。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Next.js App Router が Route Handler として認識するファイル名（`allowJs: true` のため .js も対象）。 */
const ROUTE_FILENAMES = new Set([
  'route.ts',
  'route.tsx',
  'route.js',
  'route.jsx',
  'route.mjs',
  'route.cjs',
])

export interface WrapperRule {
  prefix: string
  wrapper: string
  module: string
  reason: string
}

export const WRAPPER_RULES: ReadonlyArray<WrapperRule> = [
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

export const DEFAULT_RULE: Omit<WrapperRule, 'prefix'> = {
  wrapper: 'withPublicMutation',
  module: 'lib/public-guard.ts',
  reason: '公開（未認証）変更系は認証非依存ラッパを必ず通る（SEC-037 / AC-RL-7）',
}

export const DOCUMENTED_EXCEPTIONS: ReadonlyArray<{ prefix: string; reason: string }> = [
  {
    prefix: 'auth/',
    reason:
      'Auth.js（NextAuth）の内蔵ハンドラ。CSRF トークンとコールバック検証をライブラリ自身が持つため、' +
      'アプリ側のラッパで包むとフローが壊れる。認可の多層防御は middleware と各ハンドラの auth() が担う',
  },
]

export function listRouteFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...listRouteFiles(full))
    else if (ROUTE_FILENAMES.has(entry)) found.push(full)
  }
  return found
}

/** ルート ID（`app/api` からの相対ディレクトリ + `/`）。 */
export function routeIdOf(file: string, apiRoot: string): string {
  return relative(apiRoot, file).split(sep).slice(0, -1).join('/') + '/'
}

/**
 * 変更系メソッドの **再 export**（`export { POST } from './x'` / `export * from './x'`）。
 *
 * SEC-054 ② の検出。再 export は**その場でラッパ経由か判定できない**ため無条件に違反とする。
 * `export * from` は名前が見えないので、変更系を再 export している可能性を排除できず同様に違反。
 */
export function findReExportedMutations(source: string): string[] {
  const found = new Set<string>()

  for (const match of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const specifier of match[1].split(',')) {
      const parts = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
      const exported = (parts[1] ?? parts[0]).trim()
      if ((MUTATION_METHODS as readonly string[]).includes(exported)) found.add(exported)
    }
  }

  if (/export\s*\*\s*(as\s+\w+\s*)?from\s*['"][^'"]+['"]/.test(source)) {
    found.add('*')
  }

  return [...found]
}

/** ルートモジュールのソースから、export されている変更系メソッドを抽出する。 */
export function extractMutationExports(source: string): string[] {
  const found = new Set<string>()
  for (const method of MUTATION_METHODS) {
    if (new RegExp(`export\\s+(const|async\\s+function|function)\\s+${method}\\b`).test(source)) {
      found.add(method)
    }
    const destructured = source.match(/export\s+const\s*\{([^}]*)\}\s*=/g) ?? []
    for (const match of destructured) {
      if (new RegExp(`\\b${method}\\b`).test(match)) found.add(method)
    }
  }
  for (const method of findReExportedMutations(source)) {
    if (method !== '*') found.add(method)
  }
  return [...found]
}

export function isWrappedBy(source: string, method: string, wrapper: string): boolean {
  return new RegExp(`export\\s+const\\s+${method}\\s*=\\s*${wrapper}\\s*[<(]`).test(source)
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return resolve(process.cwd(), specifier.slice(2))
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier)
  return null
}

function moduleToPath(module: string): string {
  return resolve(process.cwd(), module).replace(/\.[cm]?[jt]sx?$/, '')
}

/**
 * `identifier` が `module` から**値として**、**元の名前のまま** import されているか。
 *
 * SEC-054 ③ の是正: `{ A as B }` は `A === identifier` を要求する。
 * P3-a 版は `as` の右辺（束縛名）だけを見ていたため、
 * `import { TIER_B_BODY as withPublicMutation }` が「本物を import している」と判定された。
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
    for (const item of specifiers.split(',')) {
      const trimmed = item.trim()
      if (trimmed.length === 0) continue
      if (/^type\s+/.test(trimmed)) continue
      const parts = trimmed.split(/\s+as\s+/)
      const original = parts[0].trim()
      const bound = (parts[1] ?? parts[0]).trim()
      // 束縛名が `identifier` であっても、**元の名前が違えば別物**（SEC-054 ③）。
      if (bound === identifier && original === identifier) return true
    }
  }
  return false
}

export function declaresLocally(source: string, identifier: string): boolean {
  return new RegExp(
    `(^|\\n)\\s*(export\\s+)?(const|let|var|function|async\\s+function|class)\\s+${identifier}\\b`,
  ).test(source)
}

export function usesGenuineWrapper(
  source: string,
  wrapper: string,
  module: string,
  fromFile: string,
): boolean {
  if (declaresLocally(source, wrapper)) return false
  return importsIdentifierFrom(source, wrapper, module, fromFile)
}

export function ruleFor(routeId: string): Omit<WrapperRule, 'prefix'> {
  return WRAPPER_RULES.find((item) => routeId.startsWith(item.prefix)) ?? DEFAULT_RULE
}

/** `app/api` 配下を走査し、違反の説明文字列を返す（空配列 = 違反なし）。 */
export function scanRouteViolations(apiRoot: string): string[] {
  const violations: string[] = []
  for (const file of listRouteFiles(apiRoot)) {
    const routeId = routeIdOf(file, apiRoot)
    if (DOCUMENTED_EXCEPTIONS.some((item) => routeId.startsWith(item.prefix))) continue
    const source = readFileSync(file, 'utf8')
    const shown = relative(process.cwd(), file)

    const reExported = findReExportedMutations(source)
    if (reExported.length > 0) {
      violations.push(
        `${shown}: 変更系の再 export（${reExported.join(', ')}）はラッパ経由か判定できないため禁止（SEC-054 ②）`,
      )
      continue
    }

    const methods = extractMutationExports(source)
    if (methods.length === 0) continue

    const rule = ruleFor(routeId)
    for (const method of methods) {
      if (!isWrappedBy(source, method, rule.wrapper)) {
        violations.push(`${shown}: ${method} が ${rule.wrapper} を経由していない（${rule.reason}）`)
      }
    }
    if (!usesGenuineWrapper(source, rule.wrapper, rule.module, file)) {
      violations.push(
        `${shown}: ${rule.wrapper} が ${rule.module} 由来でない（ローカル定義 / 別モジュール / エイリアス）`,
      )
    }
  }
  return violations
}
