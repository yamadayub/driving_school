/**
 * 複数選択のチェックボックス群（`<fieldset>` + `<legend>`）。
 *
 * `RadioCardGroup` と対になる部品。教習プラン / 現在お持ちの免許 / 当校を知ったきっかけ の
 * 3 箇所が**同じ markup を持っていた**ため、分割にあわせて 1 つにまとめる
 *（3 ファイルへ散ったまま複製すると、`name` 属性の綴りだけが片方で変わる事故が起きる
 *  ——`name` は AC-008-2 の E2E が「描画されていないこと」を判定する鍵である）。
 */

export function CheckboxGroup({
  legend,
  name,
  options,
  selected,
  onToggle,
}: {
  legend: string
  name: string
  options: string[]
  selected: string[]
  onToggle: (option: string) => void
}) {
  return (
    <fieldset className="mt-4">
      <legend className="font-bold">{legend}</legend>
      {options.map((option) => (
        <label key={option} className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            name={name}
            value={option}
            checked={selected.includes(option)}
            onChange={() => onToggle(option)}
          />
          {option}
        </label>
      ))}
    </fieldset>
  )
}
