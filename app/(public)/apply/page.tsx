import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ApplicationForm } from '@/components/apply/ApplicationForm'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { getLicenseCourses } from '@/lib/queries'
import {
  FORM_SESSION_COOKIE_NAME,
  isFormSessionRenewable,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { FORM_SESSION_ISSUED_PARAM } from '@/app/api/form-session/route'

/**
 * F-008 ステップ式 申込・問い合わせフォーム（`ui-design/application-form.md`）。
 *
 * ------------------------------------------------------------------------
 * フォームセッション Cookie（AC-RL-13(a) / AC-008-4）
 * ------------------------------------------------------------------------
 * **Server Component は Cookie を設定できない**（Next 15.5 実測:
 * `Cookies can only be modified in a Server Action or Route Handler.`）。
 * そこで Cookie が無い／期限切れのときだけ `GET /api/form-session` へ寄り道して発行し、
 * `?fs=1` を付けて戻ってくる。**`?fs=1` があるときは再リダイレクトしない**——
 * Cookie をブロックしている環境で無限ループにしないため（詳細は Route Handler 側のコメント）。
 *
 * ------------------------------------------------------------------------
 * Server / Client の分界（`application-form.md` §4.1）
 * ------------------------------------------------------------------------
 * ページはシェルとコース選択肢の取得だけを担い、フォーム本体のみ `"use client"` にする。
 * **DB アクセスをクライアントへ持ち込まない**（`lib/queries.ts` は `server-only`）。
 */

export const metadata: Metadata = {
  title: 'お申込み・お問い合わせ',
  description:
    '岩滝・網野自動車教習所の入所申込とお問い合わせ。1〜2分で完了するステップ式フォームです。',
}

/** 同意ラベルからリンクするプライバシーポリシー（AC-008-5）。 */
const PRIVACY_PATH = '/privacy'

interface ApplyPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function ApplyPage({ searchParams }: ApplyPageProps) {
  const params = await searchParams

  const cookieStore = await cookies()
  const raw = cookieStore.get(FORM_SESSION_COOKIE_NAME)?.value ?? null

  /*
   * **失効間近も「セッション無し」として扱う**（更新窓 / NEW-003 / CR-001）。
   *
   * ⚠️ ここを `verifyFormSessionValue(...) !== null` だけにすると、**更新窓が本番で一度も
   * 効かない**。:69 は `hasSession` が false のときしか `/api/form-session` へ寄り道しないので、
   * 「有効だが失効間近」の利用者は**リダイレクトされず、ルート側の `isFormSessionRenewable` に
   * その状態の要求が届かない**——受け口だけが結線された不活性なコードになる。
   * 実際 P3-c1 の実装直後はこの状態だった（CR-001）。
   *
   * **判定は正典関数を呼ぶだけ**にする（AC-RL-8）。ここに「残り時間 < 10 分」のような式を
   * 書くと、`app/api/form-session/route.ts` と判定が二重管理になり、更新窓を変えたときに
   * 片方だけが残る。
   *
   * **無限リダイレクトにならない理由**（自分で追跡した）:
   *  - 失効間近 → リダイレクト → ルートが**更新不要の新しい Cookie**を発行（`issuedAt = now`
   *    なので `isFormSessionRenewable` は false）→ 戻った先で `hasSession = true`。
   *    更新窓が Cookie 寿命より短いことは
   *    `form-session-degraded-recovery.test.ts`「更新窓は Cookie 寿命より短い」が固定している。
   *  - 発行が拒否された場合（上限到達 / 縮退で印が付く）も `?fs=1` が付くので、
   *    :69 の `!issued` が 2 度目を止める。
   */
  const now = Date.now()
  const presented = verifyFormSessionValue(raw, process.env.FORM_SESSION_SECRET ?? '', now)
  const hasSession = presented !== null && !isFormSessionRenewable(presented, now)
  const issued = first(params[FORM_SESSION_ISSUED_PARAM]) === '1'

  /** 引き継いでよいクエリだけを組み直す（入力値は URL に載せない / AC-008-3）。 */
  const forwarded = () => {
    const query = new URLSearchParams()
    for (const key of ['type', 'courseId'] as const) {
      const value = first(params[key])
      if (value) query.set(key, value)
    }
    return query
  }

  if (!hasSession && !issued) {
    const issue = forwarded()
    redirect(`/api/form-session${issue.size > 0 ? `?${issue.toString()}` : ''}`)
  }

  /*
   * ------------------------------------------------------------------------
   * 発行済みマーカーを**サーバー側で**落とす（RV-P3B-002 / 実ブラウザで観測した欠陥）
   * ------------------------------------------------------------------------
   * クライアント側の `history.replaceState`（`ApplicationForm.tsx`）だけでは足りない。
   * あれは**ハイドレーション後の `useEffect`** で走るので、`load` 直後にリロード・ブックマーク・
   * URL コピーが起きると **`?fs=1` が付いたままの URL が残る**——実測（E2E / 3 ブラウザとも）:
   * Cookie を消して即リロードすると `?fs=1` が付いたまま要求され、
   * サーバーは「発行は試み済み」と判断して**再発行しない**（＝ 回復手段のない Tier B に戻る）。
   *
   * Cookie が有効に届いている場合に限り、マーカー無しの URL へ 307 で戻す。
   * **`hasSession` のときだけ**なので、Cookie をブロックしている環境（`hasSession` が常に false）は
   * この分岐に入らず、無限リダイレクトにならない——`?fs=1` はそのために残してある判定である。
   */
  if (hasSession && issued) {
    const clean = forwarded()
    redirect(`/apply${clean.size > 0 ? `?${clean.toString()}` : ''}`)
  }

  // コース一覧の取得に失敗してもフォーム全体は落とさない（`application-form.md` §2.3）。
  let courses: Array<{ id: string; label: string; school: string | null; format: string | null }> = []
  try {
    courses = (await getLicenseCourses()).map((course) => ({
      id: course.id,
      label: course.licenseTypeLabel ?? course.programLabel ?? 'コース',
      school: course.schools[0] ?? null,
      format: course.format,
    }))
  } catch {
    courses = []
  }

  const initialType = first(params.type)
  const initialCourseId = first(params.courseId)

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 py-10">
      <SectionHeading
        eyebrow="APPLY"
        title="お申込み・お問い合わせ"
        description="1〜2分で完了します。ご入力内容は送信するまで当校へ送られません。"
        as="h1"
      />
      <ApplicationForm
        courses={courses}
        privacyPath={PRIVACY_PATH}
        initialType={initialType === 'APPLICATION' || initialType === 'INQUIRY' ? initialType : null}
        initialCourseId={initialCourseId}
        turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
      />
    </div>
  )
}
