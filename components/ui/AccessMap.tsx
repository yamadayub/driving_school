/**
 * AccessMap（school-access.md）。地図 iframe とフォールバック（住所テキスト＋外部リンク）。
 * embedUrl が null のときは地図を描画せず住所フォールバックのみ表示する（F-007異常系）。
 */
import { CTAButton } from './CTAButton'
import type { SchoolInfo } from '@/lib/school-info'

interface AccessMapProps {
  school: SchoolInfo
  embedUrl: string | null
}

/** 住所から Google マップ検索の外部 URL を生成する。 */
function mapsSearchUrl(school: SchoolInfo): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(school.address)}`
}

export function AccessMap({ school, embedUrl }: AccessMapProps) {
  return (
    <div className="flex flex-col gap-s">
      <h3
        id={`access-${school.code.toLowerCase()}`}
        tabIndex={-1}
        className="text-h3 font-heading text-text-primary"
      >
        {school.name}へのアクセス
      </h3>

      {embedUrl ? (
        <iframe
          title={`${school.name}の地図`}
          src={embedUrl}
          loading="lazy"
          className="aspect-video w-full rounded border border-border"
        />
      ) : (
        // フォールバック: 地図が無い/失敗時は住所テキスト＋外部リンク。
        <div className="rounded border border-border bg-canvas p-m text-body-sm text-text-secondary">
          〒{school.postalCode} {school.address}
        </div>
      )}

      <p className="text-body-sm text-text-secondary">{school.access}</p>

      <CTAButton variant="secondary" href={mapsSearchUrl(school)} className="self-start">
        Googleマップで経路を調べる
      </CTAButton>
    </div>
  )
}
