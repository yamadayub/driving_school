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

/**
 * **`app/` 配下に新規ファイルを作らせない**（SEC-098）。
 *
 * `app/(public)/**\/*.tsx` は「既存ページの見た目を直す」ために許している。しかし
 * App Router では **`page.tsx` を 1 枚置くだけで新しい公開URLが生まれる**。それはサーバー
 * コンポーネントとして本番で実行されるので、`process.env` を描画すれば**未認証の第三者が
 * 秘密を読める**。再監査は実際にビルド・起動・curl まで通し、`AUTH_SECRET` の取得を実証した。
 * type-check も unit も build も、これを異常とは判定しない。
 *
 * 既存ファイルの**変更**は許し、**追加**だけを禁じる。見た目の修正に新しい経路は要らない。
 */
export function isAddAllowed(unix) {
  return typeof unix === 'string' && !/^app\//.test(unix)
}

/**
 * ソース中の「秘密を読む式」を集める。`NEXT_PUBLIC_` は定義上ブラウザへ出るので除く。
 *
 * ⚠️ **既存の参照まで禁止してはいけない。** `app/(public)/apply/page.tsx` は正当に
 * `process.env.FORM_SESSION_SECRET` を使っている。呼び出し側は**base に無かった参照が
 * 増えたときだけ**違反とすること。
 */
export function secretEnvRefs(source) {
  const refs = new Set()
  if (typeof source !== 'string') return refs
  for (const m of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!m[1].startsWith('NEXT_PUBLIC_')) refs.add(m[1])
  }
  // 動的アクセスは名前が静的に分からない。**一律で危険とみなす。**
  if (/process\.env\s*\[/.test(source)) refs.add('<動的アクセス>')
  return refs
}

/**
 * 「秘密に到達しうる書き方」の出現回数を数える（SEC-105）。
 *
 * `secretEnvRefs` は `process.env.X` という**特定の書き方**しか見ておらず、
 * 3回目の監査で 6 通り以上の迂回が示された。決定的だったのは
 * **`getServerEnv()` を呼ぶだけの部品を `components/` に新規作成し、既存ページから
 * 差し込む**形——`process.env` の文字列がどこにも現れない。
 *
 * そこで名前の列挙ではなく、**名前空間そのもの**を数える。
 * 見た目を変えるコードに `process` も `getServerEnv` も要らない。
 *
 * ⚠️ **これは主防御ではない。** 拒否リストである以上、書き方の網羅はできない。
 * 主防御は `verify` ジョブでの**実測**（起動して公開ルートの応答に秘密が出ないか）である。
 * ここは「明らかな形を早期に、分かりやすいメッセージで止める」ための層。
 */
const SECRET_REACHING = [
  'process',
  'getServerEnv',
  '@/lib/env',
  'import.meta',
  'globalThis',
  'require(',
  'eval(',
  'Function(',
]

export function secretReachingTokens(source) {
  const counts = new Map()
  if (typeof source !== 'string') return counts
  for (const token of SECRET_REACHING) {
    let n = 0
    let i = source.indexOf(token)
    while (i !== -1) {
      n += 1
      i = source.indexOf(token, i + token.length)
    }
    if (n > 0) counts.set(token, n)
  }
  return counts
}

/** before から増えたトークンだけを返す（既存の正当な利用は落とさない）。 */
export function addedSecretReaching(before, after) {
  const b = secretReachingTokens(before)
  const a = secretReachingTokens(after)
  const added = []
  for (const [token, count] of a) {
    if (count > (b.get(token) ?? 0)) added.push(token)
  }
  return added
}
