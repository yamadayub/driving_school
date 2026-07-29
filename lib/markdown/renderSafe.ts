/**
 * リッチテキスト本文の安全描画（SEC-001 / functional-spec §4.10）。
 *
 * `News.body` 等の Markdown ソースを、**描画のたびに**厳格ホワイトリストでサニタイズして
 * HTML 文字列に変換する共通関数。公開ページ（F-005）と管理プレビュー（F-014, news-cms.md §3）が
 * 同一のこの関数を共有し、見え方とサニタイズ結果の差異をなくす（多層防御）。
 *
 * パイプライン（固定）:
 *  remark-parse(Markdown→mdast)
 *   → remark-rehype(→hast, allowDangerousHtml=true ＝ 生HTMLを raw ノードとして持ち込む)
 *   → rehype-raw(raw ノードを実 hast 要素へパース)
 *   → forceSafeLinkAttrs(a に target/rel を強制付与する自作 transformer)
 *   → rehype-sanitize(厳格ホワイトリスト schema。パイプライン最終段の唯一の信頼境界)
 *   → rehype-stringify(HTML文字列化)
 *
 * 設計判断（当初契約の allowDangerousHtml=false/rehype-raw不使用 からの逸脱・SEC-001）:
 *  false の場合 remark-rehype は `<script>alert(1)</script>` の開閉タグのみを落とし、間の
 *  テキスト "alert(1)" を素の文字列として残す（tests/unit/sanitize.test.ts が禁止するペイロード残留）。
 *  script/style を**内容ごと**除去するには生HTMLを一度実要素へ復元し、rehype-sanitize の strip で
 *  要素+子孫を削除する必要がある。rehype-raw→rehype-sanitize は react-markdown 等でも用いる標準の
 *  安全パターンで、サニタイズが最終段に位置するため安全性は担保される（むしろ script 本文まで確実に除去）。
 *
 * 許可要素: p, h2, h3, h4, ul, ol, li, strong, em, a, blockquote, code(インライン), br, hr
 *   （h1 は本文で禁止＝ページ見出しとの重複回避。表/コードブロック(pre)/img は不許可）。
 * a 要素: href は http/https/mailto/tel のみ許可。target="_blank" と
 *   rel="nofollow noopener noreferrer" をサニタイザ前段で強制付与し、著者は target/rel を制御できない。
 */
import { unified, type Plugin } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

/** 許可要素のみを通す厳格スキーマ（defaultSchema は継承せずゼロから定義）。 */
const schema = {
  // DOCTYPE / コメントは落とす。
  allowComments: false,
  allowDoctypes: false,
  tagNames: [
    'p',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'a',
    'blockquote',
    'code',
    'br',
    'hr',
  ],
  attributes: {
    // a のみ属性を許可。target/rel は前段 transformer が安全値を固定付与済み。
    a: ['href', 'target', 'rel'],
  },
  // href に許可するスキームのみ（javascript:/data: 等はここに無いので href ごと除去される）。
  protocols: {
    href: ['http', 'https', 'mailto', 'tel'],
  },
  // script/style は要素+子孫ごと除去（アンラップしない）。
  strip: ['script', 'style'],
  clobberPrefix: 'user-content-',
  clobber: ['name', 'id'],
}

/** hast の最小ノード表現（@types/hast に依存せず自前で扱う）。 */
interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** hast 上の全 <a> に安全な target/rel を強制付与する（sanitize 前段で実行）。 */
const forceSafeLinkAttrs: Plugin<[]> = () => (tree) => {
  const visit = (node: HastNode): void => {
    if (node.type === 'element' && node.tagName === 'a') {
      node.properties = {
        ...(node.properties ?? {}),
        target: '_blank',
        rel: ['nofollow', 'noopener', 'noreferrer'],
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree as unknown as HastNode)
}

const processor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(forceSafeLinkAttrs)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify)

/**
 * Markdown ソースを厳格サニタイズ済み HTML 文字列に変換する（同期）。
 * @param source Markdown ソース文字列（DB には未サニタイズのまま保存されている想定）
 * @returns サニタイズ済み HTML 文字列（dangerouslySetInnerHTML に渡してよい唯一の出所）
 */
export function renderMarkdown(source: string): string {
  return String(processor.processSync(source))
}
