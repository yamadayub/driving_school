'use client'

import { FormField } from '@/components/ui/FormField'
import { PreferenceCommonFields } from '@/components/apply/steps/PreferenceCommonFields'
import type { ApplicationType, Values } from '@/components/apply/form-model'

/**
 * お客様情報。**APPLICATION 専用項目（住所系）は `type` で分岐して描画しない**（AC-008-2）。
 * `hidden` / `disabled` で隠すのは不可——DOM に在れば自動入力・拡張機能・改造クライアントから
 * 送信されうる。最小収集原則は「見せない」ではなく「**受け取らない・持たない**」を要求する。
 */
export function StepPersonal({
  type,
  values,
  setValue,
  toggleInList,
}: {
  type: ApplicationType | null
  values: Values
  setValue: (field: string, value: unknown) => void
  toggleInList: (field: string, option: string) => void
}) {
  return (
    <section>
      <h2 className="text-h2 font-heading text-text-primary">
        {type === 'INQUIRY' ? 'お客様情報・ご相談内容' : 'お客様情報をご入力ください'}
      </h2>
      <FormField id="name" label="氏名" required>
        <input
          id="name"
          name="name"
          autoComplete="name"
          value={values.name as string}
          onChange={(event) => setValue('name', event.target.value)}
          className="w-full rounded border border-border p-2"
        />
      </FormField>
      <FormField id="nameKana" label="氏名カナ" required help="全角カタカナでご入力ください">
        <input
          id="nameKana"
          name="nameKana"
          value={values.nameKana as string}
          onChange={(event) => setValue('nameKana', event.target.value)}
          className="w-full rounded border border-border p-2"
        />
      </FormField>
      <FormField id="birthDate" label="生年月日" required>
        <input
          id="birthDate"
          name="birthDate"
          type="date"
          autoComplete="bday"
          value={values.birthDate as string}
          onChange={(event) => setValue('birthDate', event.target.value)}
          className="w-full rounded border border-border p-2"
        />
      </FormField>
      <FormField id="gender" label="性別">
        <select
          id="gender"
          name="gender"
          value={(values.gender as string) ?? ''}
          onChange={(event) => setValue('gender', event.target.value || null)}
          className="w-full rounded border border-border p-2"
        >
          <option value="">回答しない</option>
          <option value="MALE">男性</option>
          <option value="FEMALE">女性</option>
        </select>
      </FormField>
      <FormField id="email" label="メールアドレス" required help="受付番号の控えをお送りします">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={values.email as string}
          onChange={(event) => setValue('email', event.target.value)}
          className="w-full rounded border border-border p-2"
        />
      </FormField>
      <FormField id="phone" label="電話番号" required help="ハイフンあり・なしどちらでも構いません">
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          value={values.phone as string}
          onChange={(event) => setValue('phone', event.target.value)}
          className="w-full rounded border border-border p-2"
        />
      </FormField>

      {type === 'APPLICATION' && (
        <>
          <FormField id="postalCode" label="郵便番号" required help="ハイフンなしの7桁">
            <input
              id="postalCode"
              name="postalCode"
              inputMode="numeric"
              autoComplete="postal-code"
              value={(values.postalCode as string) ?? ''}
              onChange={(event) => setValue('postalCode', event.target.value || null)}
              className="w-full rounded border border-border p-2"
            />
          </FormField>
          <FormField id="address" label="住所" required>
            <input
              id="address"
              name="address"
              autoComplete="street-address"
              value={(values.address as string) ?? ''}
              onChange={(event) => setValue('address', event.target.value || null)}
              className="w-full rounded border border-border p-2"
            />
          </FormField>
          <FormField id="buildingName" label="建物名・部屋番号">
            <input
              id="buildingName"
              name="buildingName"
              value={(values.buildingName as string) ?? ''}
              onChange={(event) => setValue('buildingName', event.target.value || null)}
              className="w-full rounded border border-border p-2"
            />
          </FormField>
        </>
      )}

      {type === 'INQUIRY' && (
        <PreferenceCommonFields values={values} setValue={setValue} toggleInList={toggleInList} />
      )}
    </section>
  )
}
