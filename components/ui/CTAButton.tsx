/**
 * CTAButton（DESIGN.md Buttons のラッパー, layout.md §7.5）。
 * href 指定時は Link、省略時は button として描画する。
 */
import Link from 'next/link'
import type { ReactNode, MouseEventHandler } from 'react'

type CTAVariant = 'primary' | 'secondary' | 'tertiary' | 'line' | 'danger'

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

const VARIANT_CLASS: Record<CTAVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-800',
  secondary: 'border border-primary-700 text-primary-700 bg-surface hover:bg-primary-50',
  tertiary: 'text-primary-700 hover:underline underline-offset-4',
  line: 'bg-line text-white hover:bg-line-dark',
  danger: 'bg-danger text-white',
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
    'inline-flex items-center justify-center gap-2 rounded-card font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-700'
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
