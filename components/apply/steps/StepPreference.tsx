'use client'

import { FormField } from '@/components/ui/FormField'
import { PreferenceCommonFields } from '@/components/apply/steps/PreferenceCommonFields'
import {
  PAYMENT_OPTIONS,
  TIME_SLOT_OPTIONS,
  type Values,
} from '@/components/apply/form-model'

/** ご希望・ご質問（APPLICATION 専用ステップ）。**すべて任意**。 */
export function StepPreference({
  values,
  setValue,
  toggleInList,
}: {
  values: Values
  setValue: (field: string, value: unknown) => void
  toggleInList: (field: string, option: string) => void
}) {
  return (
    <section>
      <h2 className="text-h2 font-heading text-text-primary">ご希望とご質問</h2>
      <p className="mt-1 text-text-secondary">すべて任意です。空欄のままでも進めます。</p>
      <FormField id="preferredStartMonth" label="入所希望月">
        <input
          id="preferredStartMonth"
          name="preferredStartMonth"
          type="month"
          value={(values.preferredStartMonth as string) ?? ''}
          onChange={(event) => setValue('preferredStartMonth', event.target.value || null)}
          className="w-full rounded border border-border p-2"
        />
      </FormField>
      <FormField id="preferredTimeSlot" label="希望教習時間帯">
        <select
          id="preferredTimeSlot"
          name="preferredTimeSlot"
          value={(values.preferredTimeSlot as string) ?? ''}
          onChange={(event) => setValue('preferredTimeSlot', event.target.value || null)}
          className="w-full rounded border border-border p-2"
        >
          <option value="">選択してください</option>
          {TIME_SLOT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </FormField>
      <FormField id="paymentMethod" label="お支払い方法">
        <select
          id="paymentMethod"
          name="paymentMethod"
          value={(values.paymentMethod as string) ?? ''}
          onChange={(event) => setValue('paymentMethod', event.target.value || null)}
          className="w-full rounded border border-border p-2"
        >
          <option value="">選択してください</option>
          {PAYMENT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </FormField>
      <PreferenceCommonFields values={values} setValue={setValue} toggleInList={toggleInList} />
    </section>
  )
}
