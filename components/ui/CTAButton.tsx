/**
 * CTAButton（DESIGN.md Buttons のラッパー, layout.md §7.5）。
 * href 指定時は Link、省略時は button として描画する。
 */
import Link from 'next/link'
import type { ReactNode, MouseEventHandler } from 'react'

type CTAVariant = 'primary' | 'secondary' | 'tertiary' | 'line' | 'danger' | 'inverse'

interface CTAButtonProps {
  variant: CTAVariant
  href?: string
  size?: 'default' | 'compact'
  icon?: ReactNode
  children: ReactNode
  className?: string
  type?: 'button' | 'submit'
  onClick?: MouseEventHandler<HTMLButtonElement>
  'aria-label'?: string
}

/**
 * primary は**ビビッドなアンバーの面 + エスプレッソの文字**（Accent 500 → hover で Accent 600）。
 * 黄・アンバーは輝度が高く**白文字が AA に届かない**（`#F59E0B` に白は約2.2:1）ので、
 * 面が明るいときは文字を濃色にする（`text-primary` で約8.1:1 / hover の `#D97706` でも約5.5:1）。
 * secondary/tertiary は黄を煮詰めた濃いゴールドのインク（Primary 600 → hover 800）。
 * ⚠️ `bg-accent`（= DEFAULT = accent-700）と `primary-700` は使わない。その段だけ
 * オレンジ/ローズで固定されている（理由は lib/design-tokens.ts の各コメント）。
 */
const VARIANT_CLASS: Record<CTAVariant, string> = {
  primary: 'bg-accent-500 text-text-primary shadow-level1 hover:bg-accent-600 hover:shadow-level2',
  secondary: 'border border-primary-600 text-primary-600 bg-surface hover:bg-primary-50',
  tertiary: 'text-primary-600 hover:text-primary-800 hover:underline underline-offset-4',
  line: 'bg-line text-white hover:bg-line-dark',
  danger: 'bg-danger text-white',
  /*
    inverse = **明るい黄の面に置く主要CTA**（Hero など）。
    通常の primary（アンバーの面）を黄色いスクリムの上に置くと、面と地が同じ色相・
    同じ明るさになってボタンの輪郭が消える。そこで黄の上では明暗を反転させ、
    最深部の Primary 900（エスプレッソ）+ 白文字にする（約14.6:1）。
    className で `bg-*` を上書きする方法は取らない —— Tailwind のユーティリティは
    詳細度が同じで**生成順**で勝敗が決まるため、class 属性の並び順では制御できない。
  */
  inverse: 'bg-primary-900 text-white shadow-level2 hover:bg-primary-800 hover:shadow-level3',
}

export function CTAButton({
  variant,
  href,
  size = 'default',
  icon,
  children,
  className = '',
  type = 'button',
  onClick,
  ...rest
}: CTAButtonProps) {
  const base =
    // フォーカスリングは Primary 800（濃いゴールド）。白面でも黄面（Hero）でも輪郭が残る濃さにする。
    'inline-flex items-center justify-center gap-2 rounded-card font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-800'
  const sizing =
    size === 'compact'
      ? 'h-10 px-4 text-body-sm'
      : 'min-h-[48px] px-l text-label'
  const cls = `${base} ${sizing} ${VARIANT_CLASS[variant]} ${className}`

  if (href) {
    return (
      <Link href={href} className={cls} {...rest}>
        {icon}
        {children}
      </Link>
    )
  }
  return (
    <button type={type} className={cls} onClick={onClick} {...rest}>
      {icon}
      {children}
    </button>
  )
}
