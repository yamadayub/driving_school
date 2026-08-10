/**
 * コース比較（F-002, course-comparison.md）。クライアント側フィルタ + URL 同期。
 * 校舎/受講形態は role=radio、免許種別は aria-pressed トグル。結果件数は aria-live="polite"。
 * 結果は Desktop=CourseTable / Mobile=CourseCard を matchMedia で一方のみマウントする
 * （data-testid="course-card" を二重にカウントさせないため）。
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { filterCourses, type LicenseTypeCode, type SchoolCode } from '@/lib/course-filter'
import type { CourseView } from '@/lib/course-dto'
import { CourseCard, type CourseCardProps } from '@/components/ui/CourseCard'
import { CourseTable } from '@/components/ui/CourseTable'
import { EmptyState } from '@/components/ui/States'

type SchoolFilter = SchoolCode | 'ALL'
type FormatFilter = 'TSUGAKU' | 'GASSHUKU'
type LicenseGroup = 'ALL' | 'ORDINARY' | 'PRO'

/** 非ORDINARY（プロ免許グループ）の免許種別と表示ラベル（course-comparison.md）。 */
const PRO_TYPE_LABELS: { code: LicenseTypeCode; label: string }[] = [
  { code: 'SEMI_MEDIUM', label: '準中型' },
  { code: 'MEDIUM', label: '中型' },
  { code: 'LARGE', label: '大型' },
  { code: 'ORDINARY_2ND', label: '普通二種' },
  { code: 'LARGE_2ND', label: '大型二種' },
  { code: 'TOWING', label: 'けん引' },
  { code: 'LARGE_SPECIAL', label: '大型特殊' },
  { code: 'MOTORCYCLE', label: '普通自動二輪' },
]
const PRO_TYPES: LicenseTypeCode[] = PRO_TYPE_LABELS.map((t) => t.code)

function toCardProps(c: CourseView): CourseCardProps {
  return {
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
  }
}

interface CourseComparisonProps {
  courses: CourseView[]
  initialFormat: FormatFilter
  initialLicenseGroup: LicenseGroup
  /** REV-101: ?school の復元値（検証済み。省略時は 'ALL'）。 */
  initialSchool?: SchoolFilter
}

export function CourseComparison({
  courses,
  initialFormat,
  initialLicenseGroup,
  initialSchool = 'ALL',
}: CourseComparisonProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [school, setSchool] = useState<SchoolFilter>(initialSchool)
  const [format, setFormat] = useState<FormatFilter>(initialFormat)
  const [licenseGroup, setLicenseGroup] = useState<LicenseGroup>(initialLicenseGroup)
  const [transmission, setTransmission] = useState<'AT' | 'MT' | undefined>(undefined)
  const [proTypes, setProTypes] = useState<LicenseTypeCode[]>([])

  // Desktop=Table / Mobile=Card を一方のみマウント（testid 二重カウント回避）。
  // 既定を true（Table）にすることで SSR/デスクトップ初期描画は Table で確定し、
  // デスクトップでは swap が発生しない（一覧→詳細クリックが要素差し替えと競合しない）。
  const [isDesktop, setIsDesktop] = useState(true)
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])

  // フィルタ状態を URL に同期（共有・戻るで再現可能に）。
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('format', format)
    if (school === 'ALL') params.delete('school')
    else params.set('school', school)
    if (licenseGroup === 'ALL') params.delete('license')
    else params.set('license', licenseGroup === 'PRO' ? 'PRO' : 'ORDINARY')
    router.replace(`/courses?${params.toString()}`, { scroll: false })
    // router / searchParams は安定参照ではないため依存は状態のみに絞る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school, format, licenseGroup])

  const licenseTypes: LicenseTypeCode[] | undefined = useMemo(() => {
    if (licenseGroup === 'ORDINARY') return ['ORDINARY']
    if (licenseGroup === 'PRO') return proTypes.length > 0 ? proTypes : PRO_TYPES
    return undefined
  }, [licenseGroup, proTypes])

  const filtered = useMemo(
    () =>
      filterCourses(courses, {
        school,
        format,
        licenseTypes,
        transmission: licenseGroup === 'ORDINARY' ? transmission : undefined,
      }),
    [courses, school, format, licenseTypes, transmission, licenseGroup],
  )

  const cards = filtered.map(toCardProps)

  function resetFilters() {
    setSchool('ALL')
    setFormat('TSUGAKU')
    setLicenseGroup('ALL')
    setTransmission(undefined)
    setProTypes([])
  }

  function toggleProType(t: LicenseTypeCode) {
    setProTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }

  return (
    <div className="flex flex-col gap-l">
      {/* フィルタ */}
      <div className="sticky top-16 z-30 flex flex-col gap-m rounded-card border border-border bg-surface/95 p-m backdrop-blur">
        <ChipGroup label="校舎">
          <Radio name="school" label="すべて" checked={school === 'ALL'} onSelect={() => setSchool('ALL')} />
          <Radio name="school" label="岩滝" checked={school === 'IWATAKI'} onSelect={() => setSchool('IWATAKI')} />
          <Radio name="school" label="網野" checked={school === 'AMINO'} onSelect={() => setSchool('AMINO')} />
        </ChipGroup>

        <ChipGroup label="受講形態">
          <Radio name="format" label="通学" checked={format === 'TSUGAKU'} onSelect={() => setFormat('TSUGAKU')} />
          <Radio name="format" label="合宿" checked={format === 'GASSHUKU'} onSelect={() => setFormat('GASSHUKU')} />
        </ChipGroup>

        <ChipGroup label="免許種別">
          <Toggle label="すべて" pressed={licenseGroup === 'ALL'} onToggle={() => setLicenseGroup('ALL')} />
          <Toggle label="普通車" pressed={licenseGroup === 'ORDINARY'} onToggle={() => setLicenseGroup('ORDINARY')} />
          <Toggle label="プロ免許" pressed={licenseGroup === 'PRO'} onToggle={() => setLicenseGroup('PRO')} />
        </ChipGroup>

        {licenseGroup === 'ORDINARY' && (
          <ChipGroup label="ミッション">
            <Toggle label="指定なし" pressed={transmission === undefined} onToggle={() => setTransmission(undefined)} />
            <Toggle label="AT" pressed={transmission === 'AT'} onToggle={() => setTransmission('AT')} />
            <Toggle label="MT" pressed={transmission === 'MT'} onToggle={() => setTransmission('MT')} />
          </ChipGroup>
        )}

        {licenseGroup === 'PRO' && (
          <ChipGroup label="プロ免許の種別">
            {PRO_TYPE_LABELS.map((t) => (
              <Toggle
                key={t.code}
                label={t.label}
                pressed={proTypes.includes(t.code)}
                onToggle={() => toggleProType(t.code)}
              />
            ))}
          </ChipGroup>
        )}
      </div>

      {/* 結果件数（aria-live） */}
      <p data-testid="result-count" aria-live="polite" className="text-body font-bold text-text-primary">
        {cards.length}件のコースが見つかりました
      </p>

      {/* 結果 */}
      {cards.length === 0 ? (
        <EmptyState
          message="条件に合うコースがありません"
          actionLabel="フィルタをリセット"
          onAction={resetFilters}
        />
      ) : isDesktop ? (
        <CourseTable courses={cards} />
      ) : (
        <div className="grid gap-m sm:grid-cols-2">
          {cards.map((c) => (
            <CourseCard key={c.id} {...c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-s">
      <span className="text-body-sm font-bold text-text-secondary">{label}</span>
      {children}
    </div>
  )
}

function Radio({
  name,
  label,
  checked,
  onSelect,
}: {
  name: string
  label: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      data-name={name}
      onClick={onSelect}
      className={`min-h-[44px] rounded-pill border px-m text-body-sm font-bold transition-colors ${
        checked
          ? 'border-primary-600 bg-primary-600 text-white'
          : 'border-border bg-surface text-text-primary hover:bg-canvas'
      }`}
    >
      {label}
    </button>
  )
}

function Toggle({
  label,
  pressed,
  onToggle,
}: {
  label: string
  pressed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`min-h-[44px] rounded-pill border px-m text-body-sm font-bold transition-colors ${
        pressed
          ? 'border-primary-600 bg-primary-50 text-primary-600'
          : 'border-border bg-surface text-text-primary hover:bg-canvas'
      }`}
    >
      {label}
    </button>
  )
}
