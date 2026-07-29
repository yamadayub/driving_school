/**
 * ルートのソースから**オプションの値部分だけ**を切り出すヘルパー（P3-c2 / MF-2）。
 *
 * ------------------------------------------------------------------------
 * なぜ素の正規表現ではいけないのか
 * ------------------------------------------------------------------------
 * `/source\s*:/` のようなパターンは、**ファイル内のどこか**（コメント・別の変数宣言・
 * 別のオプション）に同じ綴りがあれば通ってしまう。
 * `docs/review-p3c2-tests-2026-07-29.md` MF-2 の指摘:
 *
 * > 最も重要な契約（設計文書自身が「本ファイルで最も重要なテスト」と書いている）が、
 * > **構造を見ないパターン一致**に乗っている。
 *
 * ------------------------------------------------------------------------
 * なぜテストファイルではなく helpers に置くのか
 * ------------------------------------------------------------------------
 * 当初 `uploads-route-contract.test.ts` から export して別のテストが import したところ、
 * **その import で相手ファイルの `describe` も実行され、同じテストが 2 回走った**
 *（`tests/integration/news.int.ts` で同型の事故を避けたのと同じ理由）。
 * **テストファイルは他のテストから import しない。**
 */

/**
 * `name: { ... }` の値部分（波括弧を含む）を返す。見つからなければ `null`。
 *
 * 波括弧の対応を数えて閉じ位置を求める（正規表現ではネストを扱えない）。
 */
export function extractOptionValue(source: string, name: string): string | null {
  const opener = new RegExp(`\\b${name}\\s*:\\s*\\{`)
  const match = opener.exec(source)
  if (!match) return null

  let depth = 0
  const start = match.index + match[0].length - 1
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/** 行コメント・ブロックコメントを除去する（「コメントに書かれた綴り」で通らないように）。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/**
 * `name: <式>,` の**式そのもの**を切り出す（P3-c2 / CR-002）。
 *
 * ------------------------------------------------------------------------
 * なぜ `extractOptionValue` では足りないのか
 * ------------------------------------------------------------------------
 * `extractOptionValue` は `name: { … }` というオブジェクト値しか扱えない。
 * ところが実際に空振りしたのは **`verifyFormSession: (req) => …`** という
 * **アロー関数の値**だった。セクション全文へ `toMatch(/readFormSessionCookie/)` を掛けていたため、
 * **同じ識別子が別用途で出現する箇所**（`hasVerifiedSession` を計算する行）に一致し、
 * `verifyFormSession: () => true` という契約違反の実装に対しても通っていた
 * （`docs/review-p3c2-code-2026-07-29.md` CR-002）。
 *
 * ------------------------------------------------------------------------
 * 切り出しの規則
 * ------------------------------------------------------------------------
 * `name:` の直後から、**深さ 0 のカンマ**（または閉じ波括弧）までを値とみなす。
 * 括弧 `()` `{}` `[]` の対応と、文字列・テンプレートリテラル・行コメントを考慮する
 * ——考慮しないと `', '` や `// a, b` のカンマで切れてしまう。
 */
export function extractOptionExpression(source: string, name: string): string | null {
  const opener = new RegExp(`\\b${name}\\s*:`)
  const match = opener.exec(source)
  if (match === null) return null

  let depth = 0
  let quote: string | null = null
  let lineComment = false
  const start = match.index + match[0].length

  for (let i = start; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (quote !== null) {
      if (char === '\\') i++
      else if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '{' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (char === '}') {
      // 呼び出し全体の閉じ括弧に到達した（＝ 最後のオプション）。
      if (depth === 0) return source.slice(start, i).trim()
      depth--
    } else if (char === ',' && depth === 0) {
      return source.slice(start, i).trim()
    }
  }
  return source.slice(start).trim()
}
