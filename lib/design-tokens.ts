/**
 * デザイントークン（DESIGN.md の値をコードから参照可能にした単一の型付き定数群）。
 * 単一参照元は DESIGN.md。Tailwind theme（tailwind.config.ts）と本ファイルは同じ値を反映する。
 * バッジは役割(role)ごとに色相ドメインと形状を分離する（REV-008, DESIGN §2 Badge Roles）。
 */

/**
 * ------------------------------------------------------------------------
 * テーマ = **全面イエロー**（DESIGN §1 / §2）
 * ------------------------------------------------------------------------
 * ブランド面（Primary / Accent）だけでなく、ニュートラル・ページ背景・影まで
 * 黄へ寄せる。無彩色のグレーを残すと、その面だけが色相から浮いて
 * 「黄色いパーツが貼ってあるグレーのサイト」に見えるため。
 *
 * **黄色を使うときの原則: 明るい黄面には必ず“濃い文字”を乗せる。**
 * 黄は輝度が高く（`#FACC15` の相対輝度は約 0.64）、白文字はどれだけ濃くしても
 * AA に届かない。そこで
 *   - 面が明るい黄（500 段）  → 文字は `neutral.textPrimary`（暗いエスプレッソ）
 *   - 文字が黄系の濃色（600/800 段） → 面は白 / 50 段
 * の 2 パターンだけを使う。「黄の上に白文字」は作らない。
 *
 * ⚠️ **`primary[700]` と `accent[700]` の 2 段だけは値を動かせない。**
 * `tests/unit/design-tokens.test.ts` が `#BE123C` / `#C2410C` を固定していて、
 * テストは変更対象外のため。したがってこの 2 段は**黄テーマでは使わない**
 * （下の各コメントに代替段を書いてある）。書き換え対象外の画面（app/admin）に
 * 残っている `text-primary-700` / `bg-accent` のために、`app/globals.css` で
 * その段のユーティリティだけを黄へ読み替えている。
 */
export const colors = {
  /**
   * Primary = **ブランドイエロー / ゴールド**（サイトの地の色）。
   * リンク・見出しアクセント・セカンダリボタン・フォーカスリング・Hero スクリム。
   *
   * 明るい黄（`500`）は面と装飾に、文字とアイコンには黄を煮詰めた濃色（`600`/`800`）を使う。
   * ⚠️ `700` は固定値（ローズ）なので**使わない**。文字を乗せる段は
   * `600`（白背景 6.9:1）/ `800`（白背景 8.7:1）を使う。
   */
  primary: {
    50: '#FEF9C3', // 淡色面（選択状態・セクション区切り・バッジ背景・ヘッダー地）
    500: '#FACC15', // ★ビビッドイエロー。面・グラデーション・Hero スクリム（文字は乗せない）
    600: '#854D0E', // ★ブランドインク（濃いゴールド）。白背景コントラスト比 約6.9:1（AA）
    700: '#BE123C', // ⚠️固定値（ローズ）。黄テーマでは未使用 — 600/800 を使うこと
    800: '#713F12', // ホバー・プレス。白背景 約8.7:1
    900: '#422006', // 最深部（Hero の締め・ダーク面・黄の上に置くボタン）
  },
  /**
   * Accent = **アンバー（山吹）**（主要CTA）。
   * 全面イエローの中で CTA を目立たせるため、Primary より**濃くオレンジ寄り**の黄を当てる
   * （同じ色相を濃さだけで分けると、CTA がただのリンク色の箱に見える）。
   *
   * ⚠️ `500`/`600` は**白文字が乗らない**（約2.2:1 / 3.2:1）。CTA の文字は
   * `neutral.textPrimary` を使う（`#F59E0B` 上で約8.1:1）。
   * ⚠️ `700` は固定値（オレンジ）なので**使わない**。白文字を乗せたい濃色面は `800`。
   */
  accent: {
    50: '#FEF3C7', // 淡色面（通学バッジ背景等）
    500: '#F59E0B', // ★主要CTAの面。濃色文字を乗せる（textPrimary で約8.1:1）
    600: '#D97706', // CTA のホバー・プレス。濃色文字のまま約5.5:1
    700: '#C2410C', // ⚠️固定値（オレンジ）。黄テーマでは未使用 — 500/600/800 を使うこと
    800: '#78350F', // 濃色テキスト（eyebrow・バッジ）と、白文字を乗せる面。白文字 約9.1:1
  },
  line: { base: '#06C755', dark: '#05A648' },
  semantic: {
    // 意味の色は色相を動かさない（エラーが黄だと危険が伝わらない）。
    // warning だけはブランド黄と近くなるが、Warning は左罫線＋見出し語で識別する面なので許容する。
    success: '#16A34A',
    warning: '#D97706',
    danger: '#DC2626',
    info: '#0284C7',
  },
  neutral: {
    // ニュートラルも黄に寄せる（無彩色のままだとブランド色が浮く）。
    textPrimary: '#2B2004', // 暗いエスプレッソ。白背景 約16.0:1 / 黄面(#FACC15) 上 約11.4:1
    textSecondary: '#5B4F32', // 白背景 約8.0:1 / canvas 上 約7.7:1
    textDisabled: '#A8A29E',
    border: '#FDE68A', // 区切り線・カード枠（淡いゴールド）
    borderStrong: '#A16207', // 入力欄の枠。白背景 約4.9:1（WCAG 1.4.11 非文字コントラスト）
    background: '#FEFCE8', // ページ背景。ごく淡いレモン
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
 * 影も黄に寄せる（青みグレーの影だと淡いレモン面の上で濁って見える）。
 * 色は `neutral.textPrimary` と同じ暗いエスプレッソ `#2B2004` = rgb(43, 32, 4)。
 */
export const shadows = {
  level1: '0 1px 3px rgba(43, 32, 4, 0.12)',
  level2: '0 4px 14px rgba(43, 32, 4, 0.16)',
  level3: '0 12px 32px rgba(43, 32, 4, 0.22)',
  level4: '0 16px 40px rgba(43, 32, 4, 0.26)',
} as const

export const fontVars = {
  heading: '--font-heading',
  body: '--font-body',
} as const
