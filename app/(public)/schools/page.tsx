/**
 * 学校案内・アクセス（F-007, school-access.md）。2校を対等に表示。
 * ページ内アンカー #iwataki / #amino / #access（別ページは作らない）。
 */
import type { Metadata } from 'next'
import { Breadcrumb } from '@/components/layout/Breadcrumb'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { SchoolProfile } from '@/components/ui/SchoolProfile'
import { AccessMap } from '@/components/ui/AccessMap'
import { CTAButton } from '@/components/ui/CTAButton'
import { SCHOOLS } from '@/lib/school-info'

export const metadata: Metadata = {
  title: '学校案内・アクセス',
  description: '岩滝校・網野校の所在地、電話、対応免許、アクセス・地図のご案内。',
}

const schools = Object.values(SCHOOLS)

export default function SchoolsPage() {
  return (
    <div className="mx-auto max-w-container px-m py-l md:px-l">
      <Breadcrumb items={[{ label: 'トップ', href: '/' }, { label: '学校案内' }]} />
      <div className="mt-m mb-l">
        <SectionHeading title="学校案内" />
      </div>

      <div className="flex flex-col gap-xxl">
        {schools.map((s) => (
          <section key={s.code} id={s.code.toLowerCase()} className="scroll-mt-24">
            <SchoolProfile
              code={s.code}
              name={s.name}
              postalCode={s.postalCode}
              address={s.address}
              phoneTollFree={s.phoneTollFree}
              phoneDirect={s.phoneDirect}
              features={s.features}
              licenseTypeLabels={s.licenseTypes}
            />
          </section>
        ))}

        <section id="access" className="scroll-mt-24">
          <SectionHeading eyebrow="ACCESS" title="アクセス・地図" />
          <div className="mt-l grid gap-l md:grid-cols-2">
            {schools.map((s) => (
              // 地図埋め込みは未設定のためフォールバック（住所＋外部リンク）を表示する。
              <AccessMap key={s.code} school={s} embedUrl={null} />
            ))}
          </div>
          <div className="mt-l flex items-center gap-m rounded-card border border-border bg-canvas p-l">
            <span className="text-2xl" aria-hidden="true">🚌</span>
            <div className="flex-1">
              <p className="text-body font-bold text-text-primary">無料送迎バスのご案内</p>
              <p className="text-body-sm text-text-secondary">主要駅・エリアを巡回しています。</p>
            </div>
            <CTAButton variant="tertiary" href="/bus">
              送迎バスの詳細を見る
            </CTAButton>
          </div>
        </section>
      </div>
    </div>
  )
}
