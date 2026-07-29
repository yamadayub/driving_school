import type { Metadata } from 'next'
import Link from 'next/link'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { RETENTION_PERIODS } from '@/lib/retention'

/**
 * F-023 プライバシーポリシー（AC-008-5 / AC-PII-3 / `business-spec.md` §2.3）。
 *
 * **保持期間は `lib/retention.ts` から描画する。** JSX に直書きすると、P3-c / P3-d の
 * 削除バッチ（AC-PII-5）が別の値を持ったときに**利用者へ約束した期間と実装が実際に削除する
 * 期間が食い違う**——APPI 上はその食い違い自体が不履行になる。
 */

export const metadata: Metadata = {
  title: 'プライバシーポリシー',
  description:
    '岩滝・網野自動車教習所における個人情報の利用目的・保持期間・開示等の請求方法についてご説明します。',
}

const CONTACT = [
  { school: '岩滝校', tel: '0120-46-4163' },
  { school: '網野校', tel: '0120-07-2633' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold text-text-primary">{title}</h2>
      <div className="mt-3 space-y-3 text-text-secondary leading-relaxed">{children}</div>
    </section>
  )
}

export default function PrivacyPage() {
  const {
    applicationYears,
    inquiryYears,
    photoDaysAfterDone,
    photoMaxDaysFromReceipt,
    orphanUploadHours,
    deletionRequestDays,
    clientIpMinutes,
  } = RETENTION_PERIODS

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-12">
      <SectionHeading eyebrow="PRIVACY" title="プライバシーポリシー" as="h1" />

      <Section title="1. 取得する個人情報">
        <p>
          入所申込・お問い合わせフォームでは、お名前・フリガナ・生年月日・性別・メールアドレス・
          電話番号を取得します。入所申込の場合はこれに加えて、ご住所・希望コース・免許取消歴の有無・
          現在お持ちの免許・免許証の写真を取得します。
        </p>
        <p>
          お問い合わせの場合は<strong>入所申込専用の項目を取得しません</strong>
          （必要最小限の取得。個人情報保護法の利用目的の特定に基づきます）。
        </p>
        <p>
          このほか、フォームの不正送信・大量送信を防ぐ目的で、送信元の
          <strong>IPアドレス</strong>を一時的に取得します。
          <strong>生のIPアドレスをデータベースには保存しません</strong>
          （送信回数を数えるための一時的な記録としてのみ保持し、
          <strong>{clientIpMinutes}分</strong>を経過した時点で自動的に失われます）。
        </p>
      </Section>

      <Section title="2. 利用目的">
        <p>
          お申込み内容の確認・ご連絡、入所手続きのご案内、お問い合わせへの回答、
          および法令に基づく記録の作成のために利用します。<strong>目的外の利用は行いません。</strong>
        </p>
      </Section>

      <Section title="3. 保持期間">
        <p>取得した個人情報は、以下の期間を経過した後に削除します。</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            入所申込の内容: <strong>{applicationYears}年</strong>
          </li>
          <li>
            お問い合わせの内容: <strong>{inquiryYears}年</strong>
          </li>
          <li>
            免許証の写真: 対応完了から<strong>{photoDaysAfterDone}日</strong>、
            受信から最長<strong>{photoMaxDaysFromReceipt}日</strong>
          </li>
          <li>
            お申込みに紐付かなかったアップロード: 有効期限切れから
            <strong>{orphanUploadHours}時間</strong>
          </li>
          <li>
            不正送信対策のための送信元IPアドレス: <strong>{clientIpMinutes}分</strong>
            （データベースには保存しません）
          </li>
        </ul>
      </Section>

      <Section title="4. 第三者提供">
        <p>
          ご本人の同意がある場合、または法令に基づく場合を除き、第三者へ提供しません。
          フォームの送信・メール配信・データ保管については、当校が委託した事業者の設備を利用します。
        </p>
      </Section>

      <Section title="5. 開示・訂正・削除のご請求">
        <p>
          ご本人からのご請求により、保有する個人情報の開示・訂正・削除に対応します。
          受付から<strong>{deletionRequestDays}日以内</strong>に対応します。
          お電話または<Link href="/apply?type=INQUIRY" className="text-primary-700 underline">お問い合わせフォーム</Link>
          からご連絡ください。
        </p>
        <ul className="list-none space-y-1">
          {CONTACT.map((item) => (
            <li key={item.school}>
              {item.school}{' '}
              <a href={`tel:${item.tel.replace(/-/g, '')}`} className="text-primary-700 underline">
                {item.tel}
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="6. Cookie の利用">
        <p>
          お申込みフォームでは、連続送信の防止と不正送信対策のために、
          <strong>入力内容を含まない</strong>技術的な Cookie を発行します。
          広告目的の追跡は行いません。
        </p>
      </Section>
    </div>
  )
}
