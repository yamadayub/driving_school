'use client'

/**
 * 進捗表示（`ui-design/application-form.md` §3）。
 *
 * **色と丸印だけで状態を伝えない**——完了 / 現在 / 未着手をテキストでも持たせる
 * （`layout.md` §8）。視覚的な進捗バーは `aria-hidden` にし、`<ol>` のセマンティクスと
 * `aria-current="step"` に読み上げを委ねる（`role="progressbar"` を重ねると二重読み上げになる）。
 */

export interface StepperItem {
  id: string
  label: string
  state: 'done' | 'current' | 'todo'
  hasError?: boolean
}

const STATE_TEXT: Record<StepperItem['state'], string> = {
  done: '完了',
  current: '現在',
  todo: '未着手',
}

export function FormStepper({ steps }: { steps: StepperItem[] }) {
  const currentIndex = Math.max(0, steps.findIndex((step) => step.state === 'current'))
  const ratio = steps.length === 0 ? 0 : ((currentIndex + 1) / steps.length) * 100

  return (
    <nav aria-label="申込フォームの進捗" className="mb-6">
      <p className="mb-2 text-sm font-bold text-text-secondary">
        ステップ {currentIndex + 1} / {steps.length}・{steps[currentIndex]?.label ?? ''}
      </p>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {steps.map((step) => (
          <li
            key={step.id}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className={
              step.state === 'current'
                ? 'font-bold text-primary-700'
                : step.state === 'done'
                  ? 'text-text-secondary'
                  : 'text-text-disabled'
            }
          >
            {step.label}
            <span className="sr-only">（{STATE_TEXT[step.state]}）</span>
            {step.hasError && <span className="sr-only">入力エラーあり</span>}
          </li>
        ))}
      </ol>
      <div aria-hidden="true" className="mt-2 h-1.5 w-full rounded bg-border">
        <div
          className="h-1.5 rounded bg-gradient-to-r from-accent-500 to-primary-500 transition-[width] duration-200"
          style={{ width: `${ratio}%` }}
        />
      </div>
    </nav>
  )
}
