'use client'

import { CheckboxGroup } from '@/components/ui/CheckboxGroup'
import { FormField } from '@/components/ui/FormField'
import { ImportantNoticeBlock } from '@/components/ui/ImportantNoticeBlock'
import { RadioCardGroup } from '@/components/ui/RadioCardGroup'
import { LICENSE_OPTIONS, YES_NO_OPTIONS, type Values } from '@/components/apply/form-model'

/**
 * 免許について（APPLICATION 専用ステップ / US-007）。
 *
 * 取消歴は**注意喚起ブロックの中**に置く。取消歴の有無で必要な手続きが変わるため、
 * 「他の任意項目と同じ見え方」にすると読み飛ばされる。
 */
export function StepLicense({
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
      <h2 className="text-h2 font-heading text-text-primary">お持ちの免許について</h2>
      <ImportantNoticeBlock id="license-revoked" title="必ずご回答ください">
        <RadioCardGroup
          legend="免許取消歴の有無"
          name="licenseRevoked"
          options={YES_NO_OPTIONS}
          value={
            values.licenseRevoked === null || values.licenseRevoked === undefined
              ? null
              : String(values.licenseRevoked)
          }
          onChange={(value) => setValue('licenseRevoked', value === 'true')}
        />
        <p className="mt-2 text-caption text-text-primary">
          取消歴がある場合、必要な手続きが異なります。正確なご申告をお願いします。
        </p>
        {values.licenseRevoked === true && (
          <FormField id="licenseRevokedNote" label="取消歴の補足">
            <textarea
              id="licenseRevokedNote"
              name="licenseRevokedNote"
              rows={3}
              value={(values.licenseRevokedNote as string) ?? ''}
              onChange={(event) => setValue('licenseRevokedNote', event.target.value || null)}
              className="w-full rounded border border-border p-2"
            />
          </FormField>
        )}
      </ImportantNoticeBlock>
      <CheckboxGroup
        legend="現在お持ちの免許（任意・複数選択可）"
        name="currentLicenses"
        options={LICENSE_OPTIONS}
        selected={values.currentLicenses as string[]}
        onToggle={(option) => toggleInList('currentLicenses', option)}
      />
      <p className="mt-4 text-caption text-text-secondary">
        免許証の写真の添付は今後のアップデートで対応します。
      </p>
    </section>
  )
}
