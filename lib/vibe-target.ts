/**
 * Vibe Coding — 「反映後の画面を確認する」の遷移先を決める。
 *
 * -----------------------------------------------------------------------------
 * なぜコミットの変更ファイルから導くのか
 * -----------------------------------------------------------------------------
 * 完了後のボタンは 2 つある。片方は `/admin/vibe` のリロード（次の修正へ）、
 * もう片方は**変更が反映された公開ページ**を見に行くためのものである。
 * 後者をトップ固定にすると、コース一覧を直したのにトップへ飛ばされ
 * 「変わっていない」と誤認させる——確認用のボタンが確認を妨げることになる。
 *
 * 判断材料は push されたコミットの `files[]` で、これは SHA を取りに行く
 * `GET /repos/{owner}/{repo}/commits/master` の応答に**最初から含まれている**。
 * つまり遷移先の精度を上げるために GitHub API の呼び出しは増えていない。
 *
 * -----------------------------------------------------------------------------
 * 動的セグメントを導出しない理由
 * -----------------------------------------------------------------------------
 * `app/(public)/courses/[id]/page.tsx` から作れるのは `/courses/[id]` という
 * **実在しない URL** である。`[id]` を埋めるにはコミット情報に無い DB の中身が要る。
 * 適当な id を推測して 404 を見せるより、導出不能としてトップへ落とす方が誠実。
 *
 * -----------------------------------------------------------------------------
 * 戻り値は必ず `/` 始まりの内部パスであること
 * -----------------------------------------------------------------------------
 * この値はそのまま `href` に入る。入力は GitHub API の応答という**外から来る文字列**なので、
 * `//evil.example` のような protocol-relative URL を組み立てないよう、
 * 導出できたものだけを既知のセグメントから組み立て、それ以外は `/` に落とす。
 */

/** Vibe が書き込めるページの置き場所。`scripts/vibe-policy.mjs` の許可リストと対応する。 */
const PUBLIC_PAGE = /^app\/\(public\)\/(.*\/)?page\.tsx$/

/** 動的セグメント（`[id]` / `[...slug]`）。実在する URL を作れない。 */
const DYNAMIC_SEGMENT = /\[.+\]/

/**
 * 公開ページのソースパス 1 本から公開 URL のパスを導く。導出できなければ `null`。
 *
 * @param unix リポジトリ相対の unix パス（例: `app/(public)/courses/page.tsx`）
 */
export function publicPathFromSource(unix: string): string | null {
  if (typeof unix !== 'string') return null

  const matched = PUBLIC_PAGE.exec(unix)
  if (matched === null) return null

  // `app/(public)/page.tsx` はキャプチャが undefined になる = トップページ。
  const segments = matched[1]
  if (segments === undefined) return '/'

  if (DYNAMIC_SEGMENT.test(segments)) return null

  // 末尾のスラッシュを落として `/courses` の形にする。
  return `/${segments.replace(/\/$/, '')}`
}

/**
 * コミットが触ったファイル群から、確認先として最も妥当な 1 ページを選ぶ。
 *
 * 優先順位:
 *  1. トップページが含まれていればトップ（サイトの顔で、変更が最も見て分かる）
 *  2. 導出できた公開ページのうち**辞書順で最初の 1 枚**
 *     （順序を固定するのは「押すたびに違うページへ飛ぶ」のを防ぐため）
 *  3. どれも導出できなければトップ
 *     （`components/` や `lib/design-tokens.ts` は全ページに効くので代表としてトップ）
 */
export function deriveTargetPath(paths: readonly string[]): string {
  if (!Array.isArray(paths)) return '/'

  const pages = [...new Set(paths.map(publicPathFromSource).filter(isPath))].sort()

  if (pages.length === 0 || pages.includes('/')) return '/'
  return pages[0]
}

function isPath(value: string | null): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}
