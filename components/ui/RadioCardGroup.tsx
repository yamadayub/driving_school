/**
 * 2〜3 択のラジオをカード状の `<label>` で並べる（`application-form.md` §6.2-3）。
 *
 * ------------------------------------------------------------------------
 * ネイティブの radio をそのまま使う（`role="radio"` を自作しない）
 * ------------------------------------------------------------------------
 * 独自 `role` を書くと、矢印キーでの移動・フォーカスリング・フォーム送信・自動テストの
 * すべてを自前で再実装することになり、必ずどこかが欠ける。カード化するのは `<label>` の
 * 見た目だけで、**操作の実体はネイティブの `<input type="radio">` に残す**。
 *
 * **入力そのものを視覚的に隠さない**（`sr-only` にしない）。隠すとタップ位置と
 * フォーカス位置がずれるうえ、可視性を見る E2E（`[name="school"]` が visible）も落ちる。
 */

export interface RadioCardOption {
  value: string
  label: string
  description?: string
}

export function RadioCardGroup({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string
  name: string
  options: RadioCardOption[]
  value: string | null
  onChange: (value: string) => void
}) {
  return (
    <fieldset className="mt-4">
      <legend className="font-bold">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="mt-2 flex min-h-[44px] items-center gap-2 rounded border border-border p-2"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>
            {option.label}
            {option.description && (
              <span className="mt-1 block text-caption text-text-secondary">
                {option.description}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  )
}
