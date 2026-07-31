'use client'

import { useImeSafeValue } from '@/components/ui/ime'

/**
 * 日本語入力で壊れないテキスト入力。**氏名・カナ・住所・自由記述など変換を使う欄に用いる。**
 *
 * 仕組みと背景は `components/ui/ime.ts` を参照。要点だけ書くと、
 * **変換中は親の state を更新しない**ことで、React が DOM の値を書き戻して
 * 変換セッションを打ち切るのを防いでいる。
 *
 * ⚠️ `id` / `name` / `data-testid` / ラベル文言は E2E と `getByLabel` が参照するので変更しないこと。
 * この部品は入力の受け取り方だけを差し替え、**属性はそのまま透過する**。
 */

type Common = {
  value: string
  onValueChange: (next: string) => void
}

export function ImeInput({
  value,
  onValueChange,
  ...rest
}: Common & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const ime = useImeSafeValue<HTMLInputElement>(value, onValueChange)
  return <input {...rest} {...ime} />
}

export function ImeTextArea({
  value,
  onValueChange,
  ...rest
}: Common & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ime = useImeSafeValue<HTMLTextAreaElement>(value, onValueChange)
  return <textarea {...rest} {...ime} />
}
