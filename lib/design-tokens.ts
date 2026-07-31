/**
 * デザイントークン（DESIGN.md の値をコードから参照可能にした単一の型付き定数群）。
 * 単一参照元は DESIGN.md。Tailwind theme（tailwind.config.ts）と本ファイルは同じ値を反映する。
 * バッジは役割(role)ごとに色相ドメインと形状を分離する（REV-008, DESIGN §2 Badge Roles）。
 */

export const colors = {
  primary: { 50: '#FFF1F2', 500: '#F43F5E', 700: '#BE123C', 800: '#9F1239' },
  accent: { 50: '#FFF7ED', 500: '#F97316', 700: '#C2410C', 800: '#9A3412' },
  line: { base: '#06C755', dark: '#05A648' },
  semantic: {
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    info: '#0284C7',
  },
  neutral: {
    textPrimary: '#111827',
    textSecondary: '#4B5563',
    textDisabled: '#9CA3AF',
    border: '#E5E7EB',
    borderStrong: '#CBD5E1',
    background: '#F8FAFC',
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

/** Elevation shadows（DESIGN §6）。 */
export const shadows = {
  level1: '0 1px 3px rgba(15, 23, 42, 0.08)',
  level2: '0 4px 12px rgba(15, 23, 42, 0.12)',
  level3: '0 12px 32px rgba(15, 23, 42, 0.18)',
  level4: '0 16px 40px rgba(15, 23, 42, 0.22)',
} as const

export const fontVars = {
  heading: '--font-heading',
  body: '--font-body',
} as const
