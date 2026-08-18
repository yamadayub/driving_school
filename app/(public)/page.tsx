/**
 * トップページ（F-001, top-page.md）。Hero → Feature → News最新3件 → 料金プレビュー →
 * SchoolInfo → Voice → Access。各セクションに data-testid を付与（E2E契約 contract.ts）。
 * データは Server Component で Prisma / SchoolInfo 定数から取得する。
 */
import Link from 'next/link'
import { CTAButton } from '@/components/ui/CTAButton'
import Image from 'next/image'
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
      {/*
        Hero の縦サイズは **min-height で確保する**（padding だけに任せない）。
        `py-xxxl` だけだと高さ = 余白 + テキスト量 になり、写真の見える範囲が
        コピーの行数に引きずられて決まってしまう。写真を主役として見せたいので、
        下限の高さを明示し、コピーは `items-center` で縦中央に置く。
        py-xxxl は残す —— min-height を下回る狭い高さの端末で文字が端に張り付かないため。
        値は Spacing Scale（DESIGN §5）ではなく**レイアウト寸法**なので
        max-w-container と同様に実寸で持つ（DESIGN §5 Hero）。
      */}
      <section
        data-testid="section-hero"
        className="relative isolate flex min-h-[420px] items-center overflow-hidden px-m py-xxxl text-text-primary md:min-h-[560px] md:px-l"
      >
        {/*
          教習所コースの写真（ぱくたそ / 自前配信）。**外部URLは使わない**——
          CSP が `img-src 'self' data: blob:` に制限されているため（lib/csp.ts）。
          `priority` は LCP 要素なので明示する。
        */}
        <Image
          src="/images/hero.webp"
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-20 object-cover"
        />
        {/*
          スクリム。**装飾ではなく可読性のために必要。** この写真は空も路面も明るく、
          白文字をそのまま乗せるとコントラストが確保できない。
          ブランド色を重ねることで、写真を敷いても配色の印象を保つ。

          **黄テーマでは「濃い色を敷いて白文字」ではなく「黄を敷いて濃い文字」にする。**
          サイトの主役色が黄なので、ヒーローを暗く落とすとトップの第一印象だけが
          褐色の暗い面になり、以降のセクション（淡いレモンの地）と別サイトに見える。
          黄は輝度が高いため、
            - 写真の明るい部分（空）→ 黄を重ねてもさらに明るいまま
            - 写真の暗い部分（アスファルト）→ 黄が乗って中間の明るさになる
          のどちらでもエスプレッソ色の文字（`text-text-primary`）が AA を満たす
          （最も不利な暗部 × 70% でも約4.8:1、明部では約7.8:1）。逆に白文字は
          どれだけ黄を濃くしても届かないので、ここでは使えない。

          **方向を md で切り替えている。**
          - md 以上: 見出しと CTA が左寄せで右半分が空くので、横方向。
            左を濃い黄で塗り（文字の可読性）・右を薄くして写真を見せる。
          - md 未満: 見出しが全幅に回り込み、右端が薄い側に乗って読めなくなるため、
            横方向は使えない。上下方向で全体を均一に黄へ寄せる。

          濃度を上げすぎると可読性は満たしても写真がほぼ見えなくなるので、
          文字が乗る帯だけを濃くし、写真を見せたい側は 30% まで落としている。
          ⚠️ 変更するときは**実際に描画して確かめること。** 未使用の Tailwind クラスは
          生成されないので、DevTools でクラス名を差し替えても評価にならない。
        */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-b from-primary-500/85 via-accent-500/75 to-primary-500/70 md:bg-gradient-to-r md:from-accent-500/95 md:via-primary-500/80 md:to-primary-500/30"
        />
        {/* flex アイテムになるので w-full が要る（無いと内容幅に縮んで mx-auto が効かない）。 */}
        <div className="relative mx-auto w-full max-w-container">
          <p className="text-label">通学も合宿も、あなたのペースで</p>
          <h1 className="mt-s text-display font-heading">明日からの新しい自分のために</h1>
          {/*
            黄のスクリムの上なので CTA は明暗を反転させる。
            - 主要CTA: `inverse`（エスプレッソの面 + 白文字）。通常の primary は
              アンバーの面なので、黄の地に置くとボタンの輪郭が消える。
            - 次点CTA: `secondary`（白い面 + ゴールドの文字）。黄の地から白が抜けて見え、
              主要CTA（濃色）との主従も保てる。
            どちらも className で色を上書きしない（Tailwind は同詳細度・生成順勝ちのため）。
          */}
          <div className="mt-l flex flex-wrap gap-m">
            <CTAButton variant="inverse" href="/apply?type=APPLICATION">
              資料請求はこちら
            </CTAButton>
            <CTAButton variant="secondary" href="/courses">
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
                  className="text-label text-primary-600 hover:text-primary-800 hover:underline"
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
