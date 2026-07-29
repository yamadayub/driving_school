'use client'

import { CheckboxGroup } from '@/components/ui/CheckboxGroup'
import { FormField } from '@/components/ui/FormField'
import { RadioCardGroup } from '@/components/ui/RadioCardGroup'
import { FIRST_TIME_OPTIONS, REFERRAL_OPTIONS, type Values } from '@/components/apply/form-model'

/**
 * 「当校のご利用 / 知ったきっかけ / ご質問」の 3 項目。
 *
 * **INQUIRY では 1 ステップ目に、APPLICATION では希望ステップに現れる**（§1）。
 * 2 箇所で同じ項目を描くので、複製ではなく 1 つの部品にする——複製すると
 * `name` 属性や文字数カウンタの上限だけが片方でずれる。
 */
export function PreferenceCommonFields({
  values,
  setValue,
  toggleInList,
}: {
  values: Values
  setValue: (field: string, value: unknown) => void
  toggleInList: (field: string, option: string) => void
}) {
  const message = (values.message as string) ?? ''
  return (
    <>
      <RadioCardGroup
        legend="当校のご利用"
        name="firstTime"
        options={FIRST_TIME_OPTIONS}
        value={values.firstTime === null || values.firstTime === undefined ? null : String(values.firstTime)}
        onChange={(value) => setValue('firstTime', value === 'true')}
      />
      <CheckboxGroup
        legend="当校を知ったきっかけ（複数可）"
        name="referralSources"
        options={REFERRAL_OPTIONS}
        selected={values.referralSources as string[]}
        onToggle={(option) => toggleInList('referralSources', option)}
      />
      <FormField id="message" label="ご質問・ご要望">
        <textarea
          id="message"
          name="message"
          rows={4}
          value={message}
          onChange={(event) => setValue('message', event.target.value)}
          className="w-full rounded border border-border p-2"
        />
        <p className="mt-1 text-right text-caption text-text-secondary">
          {[...message].length} / 1000
        </p>
      </FormField>
    </>
  )
}
