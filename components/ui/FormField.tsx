/**
 * ラベル + 必須/任意 + 補助テキストを持つ入力フィールドの枠（`application-form.md` §6.2-1）。
 *
 * **`htmlFor` / `id` の対応をここ 1 箇所に閉じる。** 各ステップで label を手書きすると、
 * 1 つでも対応を落とした瞬間にその項目が支援技術から名前を失い、E2E の `getByLabel` も外れる。
 */

export function FormField({
  id,
  label,
  required,
  help,
  children,
}: {
  id: string
  label: string
  required?: boolean
  help?: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block font-bold text-text-primary">
        {label}
        <span className="ml-2 text-caption font-normal text-text-secondary">
          {required ? '必須' : '任意'}
        </span>
      </label>
      {help && (
        <p id={`${id}-help`} className="mt-1 text-caption text-text-secondary">
          {help}
        </p>
      )}
      <div className="mt-1">{children}</div>
    </div>
  )
}
