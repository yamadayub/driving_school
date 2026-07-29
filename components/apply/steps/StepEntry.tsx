'use client'

import type { ApplicationType } from '@/components/apply/form-model'

/**
 * 入口（AC-008-1）。**ここで選んだ種別が、以降どのステップ・どの項目を描画するかを決める**
 * ——INQUIRY で申込専用項目を「隠す」のではなく「描画しない」ための起点である（AC-008-2）。
 */
export function StepEntry({ onChoose }: { onChoose: (type: ApplicationType) => void }) {
  return (
    <section>
      <h2 className="text-h2 font-heading text-text-primary">ご希望の内容をお選びください</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          data-testid="apply-type-application"
          onClick={() => onChoose('APPLICATION')}
          className="rounded-lg border-2 border-border p-4 text-left hover:border-primary-700"
        >
          <span className="block font-bold text-text-primary">入所を申し込む</span>
          <span className="mt-1 block text-caption text-text-secondary">
            教習コースを決めて手続きに進みます（所要 3〜5分）
          </span>
        </button>
        <button
          type="button"
          data-testid="apply-type-inquiry"
          onClick={() => onChoose('INQUIRY')}
          className="rounded-lg border-2 border-border p-4 text-left hover:border-primary-700"
        >
          <span className="block font-bold text-text-primary">質問・相談する</span>
          <span className="mt-1 block text-caption text-text-secondary">
            費用や日程を相談だけしたい方（所要 1〜2分）
          </span>
        </button>
      </div>
    </section>
  )
}
