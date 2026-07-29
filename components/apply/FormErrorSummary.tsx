'use client'

import { forwardRef } from 'react'
import { ERROR_MESSAGE, FIELD_LABEL } from '@/components/apply/form-model'
import type { ApplicationFieldError } from '@/lib/validators/application'

/**
 * 入力エラーの一覧（`application-form.md` §5.3 / RV-P3B-012）。
 *
 * ------------------------------------------------------------------------
 * **表示するのは「項目名」と「コードから引いた文言」だけ**（AC-008-6 / AC-PII-2）
 * ------------------------------------------------------------------------
 * 入力値をここへ出してはならない。画面のスクリーンショットは問い合わせ対応で共有され、
 * エラーログにも残るため、**表示するだけでも個人情報の拡散経路になる**。
 * サーバーが返すのも `{ field, code }` だけであり、この部品はその形以上を受け取らない。
 *
 * `ref` を受け取るのは、エラー発生時に**このサマリへフォーカスを移す**ため
 *（`role="alert"` だけでは、読み上げ後にフォーカスが元の位置に残る）。
 */
export const FormErrorSummary = forwardRef<HTMLDivElement, { errors: ApplicationFieldError[] }>(
  function FormErrorSummary({ errors }, ref) {
    if (errors.length === 0) return null
    return (
      <div
        role="alert"
        tabIndex={-1}
        ref={ref}
        className="mb-6 rounded border-2 border-danger bg-danger-bg p-4"
      >
        <p className="font-bold text-text-primary">入力内容をご確認ください（{errors.length}件）</p>
        <ul className="mt-2 list-disc pl-5">
          {errors.map((error) => (
            <li key={`${error.field}-${error.code}`}>
              {FIELD_LABEL[error.field] ?? error.field}:{' '}
              {ERROR_MESSAGE[error.code] ?? '入力をご確認ください'}
            </li>
          ))}
        </ul>
      </div>
    )
  },
)
