/**
 * 公開サイトのデータ取得（サーバー限定）。Prisma への読み取りをここに集約する。
 * DBアクセスは Server Component からのみ呼ぶ（クライアントに公開しない, tech-stack §1.2）。
 * 本モジュールは "use client" から import しないこと（バンドルにDB資格情報を混入させない）。
 * REV-103: server-only でクライアント誤importをビルドエラー化（多層防御）。
 * 注意: lib/db.ts には付けない（integration テストが Node 環境で lib/db を import するため、
 * react-server 条件の無い Node では server-only が throw する）。db.ts は本モジュール経由でのみ
 * 公開ページから使われ、クライアントから到達できないため queries.ts の防御で十分。
 */
import 'server-only'
import { prisma } from '@/lib/db'
import { toCourseView, type CourseView } from '@/lib/course-dto'
import { PUBLISHED_NEWS_ORDER_BY, publishedNewsWhere } from '@/lib/news-visibility'

/** 公開 LICENSE コース（比較UI対象, sortOrder 昇順）。 */
export async function getLicenseCourses(): Promise<CourseView[]> {
  const courses = await prisma.course.findMany({
    where: { published: true, category: 'LICENSE' },
    orderBy: { sortOrder: 'asc' },
  })
  return courses.map(toCourseView)
}

/** 公開スクール/追加講習（非LICENSE, sortOrder 昇順）。 */
export async function getPrograms(): Promise<CourseView[]> {
  const courses = await prisma.course.findMany({
    where: { published: true, category: { in: ['DRONE', 'KENKI', 'ADDITIONAL'] } },
    orderBy: { sortOrder: 'asc' },
  })
  return courses.map(toCourseView)
}

/** 単一の公開コース（未存在/非公開は null）。 */
export async function getPublishedCourse(id: string): Promise<CourseView | null> {
  const course = await prisma.course.findFirst({ where: { id, published: true } })
  return course ? toCourseView(course) : null
}

/**
 * トップお知らせ最新 n 件（F-004）。公開条件は `lib/news-visibility` が単一の真実源。
 * SEC-010 / RV-P2-001: `publishedAt <= now()` の時刻ゲートを含む（予約公開の先出し防止。
 * publishedAt=null の PUBLISHED も NULLS FIRST で先頭を奪わないよう除外される）。
 */
export async function getLatestNews(take = 3) {
  return prisma.news.findMany({
    where: publishedNewsWhere(),
    orderBy: PUBLISHED_NEWS_ORDER_BY,
    take,
  })
}
