/**
 * E2E セレクタ契約（Impl Agent が実装時に必ず満たすべき DOM 契約の単一参照元）。
 *
 * 方針: セレクタは role / aria / data-testid ベースで安定化する（見た目のテキストに過度依存しない）。
 * 下記の testid / aria 名は Impl が公開サイトの各コンポーネントに付与する前提。
 * 契約元: docs/ui-design/layout.md, top-page.md, course-comparison.md, course-detail.md, school-access.md。
 */
import { SEED_COUNTS } from '../../fixtures/seed-counts'

/** グローバルナビ（layout.md §2）。accessible name（リンクテキスト）と href。 */
export const NAV_ITEMS = [
  { label: 'お知らせ', href: '/news' },
  { label: '通学', href: '/courses?format=TSUGAKU' },
  { label: '合宿', href: '/courses?format=GASSHUKU' },
  { label: 'プロ免許', href: '/courses?license=PRO' },
  { label: 'スクール', href: '/programs' },
  { label: '学校案内', href: '/schools' },
  { label: 'FAQ', href: '/faq' },
  { label: 'アクセス', href: '/schools#access' },
] as const

/** `<nav aria-label>`（layout.md §8 ランドマーク）。 */
export const NAV_ARIA_LABEL = 'グローバルナビゲーション'

/** data-testid 契約（Impl が付与する）。 */
export const TESTID = {
  // トップページ セクション（top-page.md レイアウト順）
  sectionHero: 'section-hero',
  sectionFeature: 'section-feature',
  sectionNews: 'section-news',
  sectionPricePreview: 'section-price-preview',
  sectionSchoolInfo: 'section-school-info',
  sectionAccess: 'section-access',
  // 汎用カード
  newsCard: 'news-card',
  courseCard: 'course-card',
  // 比較ページ
  resultCount: 'result-count', // aria-live="polite" を持つ結果件数表示
} as const

/** トップページ ヒーローの見出し文言（top-page.md §1, h1）。 */
export const HERO_HEADING = '明日からの新しい自分のために'

/**
 * seed 由来の期待件数。単一の真実源 tests/fixtures/seed-counts.ts から導出（TC-02）。
 * E2E の件数アサーションで参照。比較ページ初期状態は 受講形態=通学（course-comparison.md 初期値）。
 */
export const SEED = {
  licenseTsugaku: SEED_COUNTS.course.license.tsugaku, // 通学 LICENSE
  licenseGasshuku: SEED_COUNTS.course.license.gasshuku, // 合宿 LICENSE
  iwatakiTsugaku: SEED_COUNTS.course.licenseBySchool.iwatakiTsugaku, // 岩滝 × 通学
  aminoTsugaku: SEED_COUNTS.course.licenseBySchool.aminoTsugaku, // 網野 × 通学
} as const

/** 比較ページ フィルタチップの accessible name（course-comparison.md §フィルタ仕様）。 */
export const FILTER_CHIP = {
  schoolAll: 'すべて',
  schoolIwataki: '岩滝',
  schoolAmino: '網野',
  formatTsugaku: '通学',
  formatGasshuku: '合宿',
} as const
