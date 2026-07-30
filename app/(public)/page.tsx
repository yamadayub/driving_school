/**
 * トップページ（F-001, top-page.md）。Hero → Feature → News最新3件 → 料金プレビュー →
 * SchoolInfo → Voice → Access。各セクションに data-testid を付与（E2E契約 contract.ts）。
 * データは Server Component で Prisma / SchoolInfo 定数から取得する。
 */
import Link from 'next/link'
import { CTAButton } from '@/components/ui/CTAButton'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { NewsCard } from '@/components/ui/NewsCard'
import { EmptyState } from '@/components/ui/States'
import { TestimonialCard } from '@/components/ui/TestimonialCard'
import { PricePreview } from '@/components/top/PricePreview'
import { getLatestNews, getLicenseCourses } from '@/lib/queries'
import { SCHOOLS } from '@/lib/school-info'
import type { NewsCategoryCode } from '@/lib/badge'

// REV-102: お知らせ・料金プレビューを Prisma から取得するためリクエスト毎の動的レンダにし、
// `next build` をDB非依存にする（ISR/revalidate はビルド時プリレンダで結局DBを要するため不採用）。
export const dynamic = 'force-dynamic'

const FEATURES = [
  { icon: '👍', label: '指名制', desc: '相性の良い教官を指名できます' },
  { icon: '🌸', label: '女性教習指導員', desc: '女性の指導員が在籍しています' },
  { icon: '📱', label: 'スマホ予約', desc: '24時間いつでも予約・変更が可能' },
  { icon: '🗓️', label: '柔軟スケジュール', desc: '夜間教習で仕事帰りにも通えます' },
  { icon: '▶️', label: 'YouTube予復習', desc: '動画で予習・復習ができます' },
]

const TESTIMONIALS = [
  { name: 'K.Sさん', courseLabel: '普通車(AT) 通学', comment: '夜間教習のおかげで仕事と両立しながら最短で卒業できました。' },
  { name: 'M.Tさん', courseLabel: '普通車(MT) 通学', comment: '指名した教官が毎回丁寧で、苦手だった縦列駐車も克服できました。' },
  { name: 'Y.Nさん', courseLabel: '準中型 通学', comment: '送迎バスが便利で通いやすかったです。スタッフの対応も親切でした。' },
]

export default async function HomePage() {
  const [news, courses] = await Promise.all([getLatestNews(3), getLicenseCourses()])

  // 料金プレビュー用に CourseCard の props 形状へ変換（LICENSE は category バッジを出さない）。
  const priceCourses = courses.map((c) => ({
    id: c.id,
    schools: c.schools,
    format: c.format,
    licenseTypeLabel: c.licenseTypeLabel,
    programLabel: c.programLabel,
    transmission: c.transmission,
    minDays: c.minDays,
    priceFrom: c.priceFrom,
    subsidyTags: c.subsidyTags,
    href: c.href,
    ctaHref: c.ctaHref,
  }))

  return (
    <div className="flex flex-col">
      {/* 1. Hero */}
      <section
        data-testid="section-hero"
        className="relative bg-gradient-to-b from-primary-800 to-primary-700 px-m py-xxxl text-white md:px-l"
      >
        <div className="mx-auto max-w-container">
          <p className="text-label">通学も合宿も、あなたのペースで</p>
          <h1 className="mt-s text-display font-heading">明日からの新しい自分のために</h1>
          <div className="mt-l flex flex-wrap gap-m">
            <CTAButton variant="primary" href="/apply?type=APPLICATION">
              資料請求はこちら
            </CTAButton>
            <CTAButton
              variant="secondary"
              href="/courses"
              className="border-white bg-transparent text-white hover:bg-white/10"
            >
              料金をくらべる
            </CTAButton>
          </div>
        </div>
      </section>

      {/* 2. Feature */}
      <section data-testid="section-feature" className="bg-surface px-m py-xxl md:px-l">
        <div className="mx-auto max-w-container">
          <SectionHeading eyebrow="FEATURE" title="選ばれる5つの理由" align="center" />
          <ul className="mt-l grid grid-cols-2 gap-l md:grid-cols-5">
            {FEATURES.map((f) => (
              <li key={f.label} className="flex flex-col items-center gap-xs text-center">
                <span className="text-3xl" aria-hidden="true">{f.icon}</span>
                <span className="text-h3 font-heading text-text-primary">{f.label}</span>
                <span className="text-body-sm text-text-secondary">{f.desc}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 3. News（最新3件） */}
      <section data-testid="section-news" className="bg-canvas px-m py-xxl md:px-l">
        <div className="mx-auto max-w-container">
          <SectionHeading eyebrow="NEWS" title="お知らせ" align="center" />
          {news.length === 0 ? (
            <div className="mt-xl">
              <EmptyState message="お知らせはありません" />
            </div>
          ) : (
            <div className="mt-xl grid gap-m md:grid-cols-3">
              {news.map((n) => (
                <NewsCard
                  key={n.id}
                  id={n.id}
                  title={n.title}
                  category={n.category as NewsCategoryCode}
                  publishedAt={n.publishedAt ?? n.createdAt}
                  href={`/news/${n.id}`}
                />
              ))}
            </div>
          )}
          <div className="mt-l text-center">
            <CTAButton variant="tertiary" href="/news">
              お知らせをすべて見る
            </CTAButton>
          </div>
        </div>
      </section>

      {/* 4. Price Preview */}
      <section data-testid="section-price-preview" className="bg-surface px-m py-xxl md:px-l">
        <div className="mx-auto max-w-container">
          <SectionHeading eyebrow="PRICE" title="コース・料金" align="center" />
          <div className="mt-l">
            <PricePreview courses={priceCourses} />
          </div>
        </div>
      </section>

      {/* 5. School Info */}
      <section data-testid="section-school-info" className="bg-canvas px-m py-xxl md:px-l">
        <div className="mx-auto max-w-container">
          <SectionHeading eyebrow="SCHOOL" title="2つの校舎から選べます" align="center" />
          <div className="mt-l grid gap-l md:grid-cols-2">
            {Object.values(SCHOOLS).map((s) => (
              <div key={s.code} className="flex flex-col gap-s rounded-card bg-surface p-l shadow-level1">
                <h3 className="text-h2 font-heading text-text-primary">{s.name}</h3>
                <p className="text-body-sm text-text-secondary">{s.access}</p>
                <Link
                  href={`/schools#${s.code.toLowerCase()}`}
                  className="text-label text-primary-700 hover:underline"
                >
                  詳しく見る →
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6. Voice */}
      <section className="bg-primary-50 px-m py-xxl md:px-l">
        <div className="mx-auto max-w-container">
          <SectionHeading eyebrow="VOICE" title="卒業生の声" align="center" />
          <div className="mt-l grid gap-m md:grid-cols-3">
            {TESTIMONIALS.map((t) => (
              <TestimonialCard key={t.name} {...t} />
            ))}
          </div>
        </div>
      </section>

      {/* 7. Access */}
      <section data-testid="section-access" className="bg-surface px-m py-xxl md:px-l">
        <div className="mx-auto max-w-container">
          <SectionHeading eyebrow="ACCESS" title="アクセス" align="center" />
          <div className="mt-l grid gap-l md:grid-cols-2">
            {Object.values(SCHOOLS).map((s) => (
              <div key={s.code} className="flex flex-col gap-xs rounded-card border border-border p-l">
                <h3 className="text-h3 font-heading text-text-primary">{s.name}</h3>
                <p className="text-body-sm text-text-secondary">{s.address}</p>
                <p className="text-body-sm text-text-secondary">{s.access}</p>
              </div>
            ))}
          </div>
          <div className="mt-l text-center">
            <CTAButton variant="secondary" href="/schools#access">
              詳しいアクセス・地図を見る
            </CTAButton>
          </div>
        </div>
      </section>
    </div>
  )
}
