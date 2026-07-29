import type { Config } from 'tailwindcss'

// デザイントークンの単一参照元は DESIGN.md（§2 Color / §3 Typography / §5 Layout / §6 Elevation）。
// ここでは Tailwind の theme トークンとして反映する。色相ドメインは役割(role)ごとに分離する（REV-008）。
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
        // Primary（信頼のブランドブルー）
        primary: {
          50: '#EFF6FF',
          500: '#3B82F6',
          700: '#1D4ED8',
          800: '#1E40AF',
          DEFAULT: '#1D4ED8',
        },
        // Accent（推進力のオレンジ — 主要CTA）
        accent: {
          50: '#FFF7ED',
          500: '#F97316', // 装飾のみ（文字を乗せない）
          700: '#C2410C',
          800: '#9A3412',
          DEFAULT: '#C2410C',
        },
        // LINE Brand（LINE相談CTA専用）
        line: {
          DEFAULT: '#06C755',
          dark: '#05A648',
        },
        // Semantic
        success: { DEFAULT: '#16A34A', bg: '#F0FDF4' },
        warning: { DEFAULT: '#D97706', bg: '#FFFBEB' },
        danger: { DEFAULT: '#DC2626', bg: '#FEF2F2' },
        info: { DEFAULT: '#0284C7', bg: '#F0F9FF' },
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
          primary: '#111827',
          secondary: '#4B5563',
          disabled: '#9CA3AF',
        },
        border: {
          DEFAULT: '#E5E7EB',
          strong: '#CBD5E1',
        },
        surface: '#FFFFFF',
        canvas: '#F8FAFC', // ページ背景
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
        // DESIGN §5 Spacing Scale
        xs: '4px',
        s: '8px',
        m: '16px',
        l: '24px',
        xl: '32px',
        xxl: '48px',
        xxxl: '64px',
      },
      borderRadius: {
        // DESIGN §9: 8px(要素), 12px(カード), 999px(ピルバッジ)
        DEFAULT: '8px',
        card: '12px',
        pill: '999px',
      },
      maxWidth: {
        container: '1120px', // DESIGN §5 Container
      },
      boxShadow: {
        // DESIGN §6 Depth & Elevation
        level1: '0 1px 3px rgba(15, 23, 42, 0.08)',
        level2: '0 4px 12px rgba(15, 23, 42, 0.12)',
        level3: '0 12px 32px rgba(15, 23, 42, 0.18)',
        level4: '0 16px 40px rgba(15, 23, 42, 0.22)',
      },
    },
  },
  plugins: [],
}

export default config
