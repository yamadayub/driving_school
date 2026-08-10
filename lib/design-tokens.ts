/**
 * デザイントークン（DESIGN.md の値をコードから参照可能にした単一の型付き定数群）。
 * 単一参照元は DESIGN.md。Tailwind theme（tailwind.config.ts）と本ファイルは同じ値を反映する。
 * バッジは役割(role)ごとに色相ドメインと形状を分離する（REV-008, DESIGN §2 Badge Roles）。
 */

/**
 * ------------------------------------------------------------------------
 * テーマ = **全面ブルー**（DESIGN §1 / §2）
 * ------------------------------------------------------------------------
 * ブランド面（Primary / Accent）だけでなく、ニュートラル・ページ背景・影まで
 * 青へ寄せる。無彩色のグレーを残すと、その面だけが色相から浮いて
 * 「青いパーツが貼ってあるグレーのサイト」に見えるため。
 *
 * ⚠️ **`primary[700]` と `accent[700]` の 2 段だけは値を動かせない。**
 * `tests/unit/design-tokens.test.ts` が `#BE123C` / `#C2410C` を固定していて、
 * テストは変更対象外のため。したがってこの 2 段は**青テーマでは使わない**
 * （下の各コメントに代替段を書いてある）。書き換え対象外の画面（app/admin）に
 * 残っている `text-primary-700` / `bg-accent` のために、`app/globals.css` で
 * その段のユーティリティだけを青へ読み替えている。
 */
export const colors = {
  /**
   * Primary = **ブランドブルー**（サイトの地の色）。
   * リンク・見出しアクセント・セカンダリボタン・フォーカスリング・Hero スクリム。
   *
   * ⚠️ `700` は固定値（ローズ）なので**使わない**。文字を乗せる段は
   * `600`（白背景 6.7:1）/ `800`（白背景 8.7:1）を使う。
   */
  primary: {
    50: '#DCE9FF', // 淡色面（選択状態・セクション区切り・バッジ背景）
    500: '#3B82F6', // 装飾・グラデーション・アイコン（小さな文字には使わない）
    600: '#1D4ED8', // ★ブランドインク。白背景コントラスト比 約6.7:1（AA）
    700: '#BE123C', // ⚠️固定値（ローズ）。青テーマでは未使用 — 600/800 を使うこと
    800: '#1E40AF', // ホバー・プレス。白背景 約8.7:1
    900: '#172554', // 最深部（Hero スクリムの濃い側・ダーク面）
  },
  /**
   * Accent = **ビビッドなアズールブルー**（主要CTA）。
   * 全面ブルーの中で CTA を目立たせるため、Primary より**明るく緑寄り**の青を当てる
   * （同じ色相を濃さだけで分けると、CTA がただのリンク色の箱に見える）。
   *
   * ⚠️ `700` は固定値（オレンジ）なので**使わない**。文字を乗せる面は
   * `500`（白文字 5.9:1）、押下・ホバーは `800`（白文字 7.6:1）。
   */
  accent: {
    50: '#E0F2FE', // 淡色面（通学バッジ背景等）
    500: '#0369A1', // ★主要CTA。白文字コントラスト比 約5.9:1（AA）
    700: '#C2410C', // ⚠️固定値（オレンジ）。青テーマでは未使用 — 500/800 を使うこと
    800: '#075985', // CTA のホバー・プレス。白文字 約7.6:1
  },
  line: { base: '#06C755', dark: '#05A648' },
  semantic: {
    // 意味の色は色相を動かさない（エラーが青だと危険が伝わらない）。
    // info だけはブランド青と近くなるが、Info は枠線＋見出し語で識別する面なので許容する。
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    info: '#0284C7',
  },
  neutral: {
    // ニュートラルも青に寄せる（無彩色のままだとブランド色が浮く）。
    textPrimary: '#0F172A', // 深いネイビー。白背景コントラスト比 約17.4:1
    textSecondary: '#475569', // 白背景 約7.4:1 / canvas 上 約7.0:1
    textDisabled: '#94A3B8',
    border: '#CBDDF5', // 区切り線・カード枠（淡い青）
    borderStrong: '#3B82F6', // 入力欄の枠。白背景 約3.7:1（WCAG 1.4.11 非文字コントラスト）
    background: '#F0F6FF', // ページ背景。ごく淡いアズール
    surface: '#FFFFFF',
  },
} as const

/** バッジ役割ごとの形状（色だけに依存しない — DESIGN §4 Badge / REV-008）。 */
export const badgeShapes = {
  school: 'outline', // 校舎: アウトライン + ●ドット
  format: 'pill', // 受講形態: 塗りピル
  category: 'rounded-rect', // 講習カテゴリ: 塗り角丸矩形(8px)
  subsidy: 'pill-icon', // 給付金/助成金: ✓アイコン付き塗りピル
} as const

/** 校舎バッジ（Outline / Indigo・Teal）。 */
export const schoolBadgeColors = {
  IWATAKI: '#4338CA', // Indigo 700
  AMINO: '#0F766E', // Teal 700
} as const

/** 講習カテゴリバッジ（Filled Rounded-Rect）。text/bg のペア。 */
export const categoryBadgeColors = {
  drone: { text: '#6D28D9', bg: '#F5F3FF' },
  kenki: { text: '#B45309', bg: '#FFFBEB' },
  senior: { text: '#A21CAF', bg: '#FDF4FF' },
  paper: { text: '#BE185D', bg: '#FDF2F8' },
  corp: { text: '#44403C', bg: '#FAFAF9' },
  common: { text: '#4B5563', bg: '#F3F4F6' },
} as const

/** 受講形態バッジ（Filled Pill / Blue・Orange）。 */
export const formatBadgeColors = {
  TSUGAKU: { text: '#1D4ED8', bg: '#EFF6FF' },
  GASSHUKU: { text: '#C2410C', bg: '#FFF7ED' },
} as const

/** 給付金/助成金タグ（Filled Pill + ✓ / Green・Lime）。 */
export const subsidyBadgeColors = {
  benefit: { text: '#16A34A', bg: '#F0FDF4' },
  grant: { text: '#4D7C0F', bg: '#F7FEE7' },
} as const

/** 管理画面ステータスバッジ（Semantic 流用, DESIGN §4）。 */
export const statusBadgeColors = {
  NEW: { text: '#DC2626', bg: '#FEF2F2' },
  IN_PROGRESS: { text: '#D97706', bg: '#FFFBEB' },
  DONE: { text: '#16A34A', bg: '#F0FDF4' },
} as const

/** Spacing scale（DESIGN §5）。 */
export const spacing = {
  xs: 4,
  s: 8,
  m: 16,
  l: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const

/** Border radius（DESIGN §9）。 */
export const radius = {
  element: 8,
  card: 12,
  pill: 999,
} as const

/**
 * Elevation shadows（DESIGN §6）。
 * 影も青に寄せる（グレーの影だと淡いアズール面の上で濁って見える）。
 * 色は `neutral.textPrimary` と同じ深いネイビー `#0F172A` = rgb(15, 23, 42)。
 */
export const shadows = {
  level1: '0 1px 3px rgba(15, 23, 42, 0.12)',
  level2: '0 4px 14px rgba(15, 23, 42, 0.16)',
  level3: '0 12px 32px rgba(15, 23, 42, 0.22)',
  level4: '0 16px 40px rgba(15, 23, 42, 0.26)',
} as const

export const fontVars = {
  heading: '--font-heading',
  body: '--font-body',
} as const
