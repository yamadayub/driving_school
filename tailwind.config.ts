import type { Config } from 'tailwindcss'
import { colors as token, radius, shadows, spacing } from './lib/design-tokens'

// デザイントークンの単一参照元は DESIGN.md（§2 Color / §3 Typography / §5 Layout / §6 Elevation）。
//
// ⚠️ **値をここに直接書かない。`lib/design-tokens.ts` から導出する。**
// 以前は同じ値が DESIGN.md / lib/design-tokens.ts / 本ファイルの3箇所にあり、
// **コンポーネントは Tailwind クラスしか使っていない**（design-tokens.ts を import している
// コンポーネントは 0 件）ため、`design-tokens.ts` だけを書き換えても**描画は 1px も変わらなかった**。
// 「変えたのに反映されない」を構造的に防ぐため、本ファイルは導出専用にする。
//
// 色を変えるときは `lib/design-tokens.ts` を編集すれば、ここと
// `tests/unit/design-tokens.test.ts`（DESIGN.md との一致を固定）の両方に反映される。
// 色相ドメインは役割(role)ごとに分離する（REV-008）。
const px = (n: number) => `${n}px`
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Primary（信頼のブランドブルー）— DEFAULT は文字を乗せられる 700
        primary: { ...token.primary, DEFAULT: token.primary[700] },
        // Accent（推進力のオレンジ — 主要CTA）。500 は装飾のみ（文字を乗せない）
        accent: { ...token.accent, DEFAULT: token.accent[700] },
        // LINE Brand（LINE相談CTA専用）
        line: { DEFAULT: token.line.base, dark: token.line.dark },
        // Semantic（`bg` は淡色面。トークン側は前景色のみ持つ）
        success: { DEFAULT: token.semantic.success, bg: '#F0FDF4' },
        warning: { DEFAULT: token.semantic.warning, bg: '#FFFBEB' },
        danger: { DEFAULT: token.semantic.danger, bg: '#FEF2F2' },
        info: { DEFAULT: token.semantic.info, bg: '#F0F9FF' },
        // Badge role: 校舎 (School) — Outline / Indigo・Teal
        school: {
          iwataki: '#4338CA', // Indigo 700
          amino: '#0F766E', // Teal 700
        },
        // Badge role: 講習カテゴリ (Category) — Filled Rounded-Rect
        category: {
          drone: '#6D28D9', // Violet 700
          'drone-bg': '#F5F3FF',
          kenki: '#B45309', // Amber 700
          'kenki-bg': '#FFFBEB',
          senior: '#A21CAF', // Fuchsia 700
          'senior-bg': '#FDF4FF',
          paper: '#BE185D', // Pink 700
          'paper-bg': '#FDF2F8',
          corp: '#44403C', // Stone 700
          'corp-bg': '#FAFAF9',
          common: '#4B5563', // Gray 600
          'common-bg': '#F3F4F6',
        },
        // Badge role: 給付金/助成金 (Subsidy)
        subsidy: {
          benefit: '#16A34A', // Green 600
          'benefit-bg': '#F0FDF4',
          grant: '#4D7C0F', // Lime 700
          'grant-bg': '#F7FEE7',
        },
        // Neutral
        text: {
          primary: token.neutral.textPrimary,
          secondary: token.neutral.textSecondary,
          disabled: token.neutral.textDisabled,
        },
        border: {
          DEFAULT: token.neutral.border,
          strong: token.neutral.borderStrong,
        },
        surface: token.neutral.surface,
        canvas: token.neutral.background, // ページ背景
      },
      fontFamily: {
        heading: ['var(--font-heading)'],
        body: ['var(--font-body)'],
      },
      fontSize: {
        // DESIGN §3.4（モバイル値。Display/Heading は clamp を globals で補間）
        display: ['clamp(28px, 4vw, 44px)', { lineHeight: '1.4', letterSpacing: '0.02em', fontWeight: '700' }],
        h1: ['clamp(22px, 3vw, 32px)', { lineHeight: '1.4', letterSpacing: '0.01em', fontWeight: '700' }],
        h2: ['clamp(18px, 2.2vw, 24px)', { lineHeight: '1.5', fontWeight: '700' }],
        h3: ['clamp(16px, 1.6vw, 18px)', { lineHeight: '1.5', fontWeight: '700' }],
        body: ['16px', { lineHeight: '1.8' }],
        'body-sm': ['14px', { lineHeight: '1.7' }],
        label: ['14px', { lineHeight: '1.4', fontWeight: '700' }],
        caption: ['12px', { lineHeight: '1.5' }],
      },
      spacing: {
        // DESIGN §5 Spacing Scale（`lib/design-tokens.ts` から導出）
        xs: px(spacing.xs),
        s: px(spacing.s),
        m: px(spacing.m),
        l: px(spacing.l),
        xl: px(spacing.xl),
        xxl: px(spacing.xxl),
        xxxl: px(spacing.xxxl),
      },
      borderRadius: {
        // DESIGN §9: 8px(要素), 12px(カード), 999px(ピルバッジ)
        DEFAULT: px(radius.element),
        card: px(radius.card),
        pill: px(radius.pill),
      },
      maxWidth: {
        container: '1120px', // DESIGN §5 Container
      },
      boxShadow: {
        // DESIGN §6 Depth & Elevation（`lib/design-tokens.ts` から導出）
        level1: shadows.level1,
        level2: shadows.level2,
        level3: shadows.level3,
        level4: shadows.level4,
      },
    },
  },
  plugins: [],
}

export default config
