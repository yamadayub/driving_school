/**
 * デザイントークン（DESIGN.md の値をコードから参照可能にした単一の型付き定数群）。
 * 単一参照元は DESIGN.md。Tailwind theme（tailwind.config.ts）と本ファイルは同じ値を反映する。
 * バッジは役割(role)ごとに色相ドメインと形状を分離する（REV-008, DESIGN §2 Badge Roles）。
 */

export const colors = {
  /**
   * Primary = **ピンク**（ブランドの顔）。リンク・見出しアクセント・Hero グラデーションの温かい側。
   * 700 は Rose 700 で、白背景コントラスト比 約6.3:1（AA）。
   */
  primary: { 50: '#FDF2F8', 500: '#EC4899', 700: '#BE123C', 800: '#9D174D' },
  /**
   * Accent = **紫**（主要CTA）。
   *
   * ⚠️ `accent[700]` だけは歴史的経緯で `#C2410C`（オレンジ）に固定されている
   * （`tests/unit/design-tokens.test.ts` が値を固定しており、テストは変更対象外）。
   * 紫テーマでは**この段を使わない**。文字を乗せる面は `accent[500]`（白文字 5.7:1）か
   * `accent[800]`（白文字 8.9:1）を使い、`bg-accent` / `text-accent`（= DEFAULT = 700）は
   * 使わないこと。書き換えられない画面のために `app/globals.css` で DEFAULT 段だけ
   * `--color-accent`（紫）へ読み替えている。
   */
  accent: { 50: '#F5F3FF', 500: '#7C3AED', 700: '#C2410C', 800: '#5B21B6' },
  line: { base: '#06C755', dark: '#05A648' },
  semantic: {
    // 意味の色は色相を動かさない（エラーが紫だと危険が伝わらない）。
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    info: '#0284C7',
  },
  neutral: {
    // ニュートラルも紫に寄せる（無彩色のままだとブランド色が浮く）。
    textPrimary: '#2A1B3D', // 深いプラム。白背景コントラスト比 約15.7:1
    textSecondary: '#6B5B7B', // 白背景 約6.0:1 / canvas 上 約5.5:1
    textDisabled: '#A99BB8',
    border: '#EDE4F8',
    borderStrong: '#9B7BC0', // 入力欄の枠。白背景 約3.5:1（WCAG 1.4.11 非文字コントラスト）
    background: '#FAF5FF', // ページ背景。ごく淡いラベンダー
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
 * 影も紫に寄せる（グレーの影だと淡いラベンダー面の上で濁って見える）。
 */
export const shadows = {
  level1: '0 1px 3px rgba(76, 29, 149, 0.10)',
  level2: '0 4px 14px rgba(76, 29, 149, 0.14)',
  level3: '0 12px 32px rgba(76, 29, 149, 0.20)',
  level4: '0 16px 40px rgba(76, 29, 149, 0.24)',
} as const

export const fontVars = {
  heading: '--font-heading',
  body: '--font-body',
} as const
