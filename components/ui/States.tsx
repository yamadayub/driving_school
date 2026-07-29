/**
 * EmptyState / ErrorState（layout.md §7.6）。一覧・比較系ページで共通利用。
 * スクリーンリーダーへ role=status（Error は role=alert）で通知する。
 */
'use client'

import { CTAButton } from './CTAButton'

interface EmptyStateProps {
  message: string
  actionLabel?: string
  onAction?: () => void
}

export function EmptyState({ message, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-m rounded-card border border-border bg-surface p-xl text-center"
    >
      <p className="text-body text-text-secondary">{message}</p>
      {actionLabel && onAction && (
        <CTAButton variant="secondary" onClick={onAction}>
          {actionLabel}
        </CTAButton>
      )}
    </div>
  )
}

interface ErrorStateProps {
  message: string
  onRetry?: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-m rounded-card border border-danger bg-danger-bg p-xl text-center"
    >
      <p className="text-body text-text-primary">{message}</p>
      {onRetry && (
        <CTAButton variant="secondary" onClick={onRetry}>
          再読み込み
        </CTAButton>
      )}
    </div>
  )
}
