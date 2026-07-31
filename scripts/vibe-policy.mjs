/**
 * Vibe Coding のパス方針 — **エージェントとゲートが共有する唯一の情報源**。
 *
 * -----------------------------------------------------------------------------
 * なぜ許可リストなのか（SEC-087 / SEC-088 / SEC-089）
 * -----------------------------------------------------------------------------
 * 以前は「危険なパスを列挙して拒否する」形だった。**拒否リストは知っている危険しか止められない。**
 * 実際に次の3つを取りこぼした:
 *
 *  - `.git`（`/^\.git\//` は末尾スラッシュを要求するので `.git` 自身に一致しない / SEC-086）
 *  - `path: '.'` を起点にした `Glob` / `Grep`（起点しか見ておらず走査範囲を縛っていない / SEC-087）
 *  - **新規に作られる** `app/api/**\/route.ts`（列挙されていないので素通り / SEC-089）
 *
 * 許可リストならどれも既定で拒否になる。**この機能の目的は「見た目を変えること」**なので、
 * 許可すべき範囲は元々狭い。広げるときは、その1行が何を実行可能にするかを考えること。
 *
 * -----------------------------------------------------------------------------
 * このモジュールが唯一の情報源である理由（SEC-091）
 * -----------------------------------------------------------------------------
 * 以前は `vibe-agent.mjs` と `check-protected-paths.mjs` が**同じリストを別々に持っていた**。
 * 「同じ内容を保つこと」とコメントするしかなく、ずれても誰も気づけない。
 * 両方がここを import する。`tests/unit/vibe-policy.test.ts` が中身を固定する。
 */

/** どの層でも無条件に拒否する。許可リストの内側であっても通さない（多層防御）。 */
const ALWAYS_DENIED = [
  /(^|\/)\.env/, // .env / .env.local / .env.production ...
  /(^|\/)\.git($|\/)/, // ⚠️ `.git` 自身に一致すること（SEC-086）
  /(^|\/)node_modules($|\/)/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)route\.ts$/, // 新規 API ルートを作らせない（SEC-089）
  /(^|\/)middleware\.ts$/,
]

/**
 * 書き込みを許可するパス。**見た目を変えるのに要る範囲だけ。**
 *
 * `app/admin/(app)/layout.tsx` は `requireAdmin()` を呼ぶ認可の要なので**含めない**
 * （`app/admin/` 配下を許可していないので既定で拒否される）。
 */
const WRITE_ALLOWED = [
  /^components\/.+\.(tsx|ts|css)$/,
  /^app\/\(public\)\/.+\.tsx$/,
  /^app\/globals\.css$/,
  /^lib\/design-tokens\.ts$/,
  /^DESIGN\.md$/,
]

/**
 * 読み取りを許可する起点。**リポジトリルート（`''` / `.`）は含めない。**
 * ルートを許すと `glob:` で `.env` にも `.git` にも届く（SEC-087 の実測）。
 */
const READ_ALLOWED = [
  /^app(\/|$)/,
  /^components(\/|$)/,
  /^lib(\/|$)/,
  /^docs(\/|$)/,
  /^tests(\/|$)/,
  /^public(\/|$)/,
  /^prisma(\/|$)/,
  /^DESIGN\.md$/,
  /^CLAUDE\.md$/,
]

/** リポジトリ相対の unix パスが書き込み可能か。 */
export function isWritablePath(unix) {
  if (typeof unix !== 'string' || unix.length === 0) return false
  if (ALWAYS_DENIED.some((re) => re.test(unix))) return false
  return WRITE_ALLOWED.some((re) => re.test(unix))
}

/** リポジトリ相対の unix パスが読み取りの起点として許されるか。 */
export function isReadablePath(unix) {
  if (typeof unix !== 'string' || unix.length === 0) return false // '' = リポジトリルート
  if (ALWAYS_DENIED.some((re) => re.test(unix))) return false
  return READ_ALLOWED.some((re) => re.test(unix))
}

/**
 * `Glob` / `Grep` の `glob` パラメータが安全か。
 * 起点を縛っても、パターン側で上に抜けられては意味がない。
 */
export function isSafeGlobPattern(pattern) {
  if (pattern === undefined || pattern === null) return true
  if (typeof pattern !== 'string') return false
  if (pattern.includes('..')) return false
  return !ALWAYS_DENIED.some((re) => re.test(pattern.replace(/^\*+\//, '')))
}

/** 人間向けの説明（エージェントへの拒否メッセージとプロンプトで使う）。 */
export const WRITE_ALLOWED_DESCRIPTION = [
  'components/ 配下の .tsx / .ts / .css',
  'app/(public)/ 配下の .tsx',
  'app/globals.css',
  'lib/design-tokens.ts',
  'DESIGN.md',
].join(' / ')
