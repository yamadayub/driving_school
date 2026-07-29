/**
 * お知らせ管理（CMS CRUD）のサーバーロジック層（F-014 / US-012）。
 *
 * Route Handler / Server Action から呼ぶリポジトリ層。Prisma への書き込み・遷移・
 * 公開クエリをここに集約する。
 *
 * 重要な設計制約:
 *  - **'server-only' を import しない**。結合テスト（Node 環境）が本モジュールを import するため
 *    （lib/queries.ts のコメント参照。db.ts と同じ扱い）。クライアント誤importの防御は、本モジュールを
 *    "use client" から import しない運用と、呼び出し元（管理 Server Action）が認証必須である点で担保する。
 *  - 公開クエリ（listPublishedNews）は status='PUBLISHED' かつ publishedAt <= now() のみ返す
 *    （F-004 公開サイト整合。DRAFT/UNPUBLISHED は自動除外, SPEC-002）。
 *  - status='PUBLISHED' への遷移時 publishedAt は非null（E-014-2。呼び出し前に parseNewsInput 済み想定）。
 *
 * 型: PublishStatusCode / NewsCategoryCode はアプリ側の真実源を使う。migrate 済みの Prisma enum
 * （DRAFT/PUBLISHED/UNPUBLISHED）と文字列リテラルが一致するため相互代入可能。
 */
import { prisma } from '@/lib/db'
import { PUBLISHED_NEWS_ORDER_BY, publishedNewsWhere } from '@/lib/news-visibility'
import type { News, Prisma } from '@prisma/client'
import type { NewsCategoryCode } from '@/lib/labels'
import type { PublishStatusCode } from '@/lib/publish-status'

export interface NewsAdminInput {
  title: string
  body: string
  category: NewsCategoryCode
  status: PublishStatusCode
  publishedAt?: Date | null
}

/** 管理・公開の双方で使う News レコード表現（Prisma News に対応）。 */
export interface NewsRecord {
  id: string
  title: string
  body: string
  category: NewsCategoryCode
  status: PublishStatusCode
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Prisma News → アプリの NewsRecord（enum の文字列表現は一致するため素直に写像）。 */
function toRecord(news: News): NewsRecord {
  return {
    id: news.id,
    title: news.title,
    body: news.body,
    category: news.category as NewsCategoryCode,
    status: news.status as PublishStatusCode,
    publishedAt: news.publishedAt,
    createdAt: news.createdAt,
    updatedAt: news.updatedAt,
  }
}

/** 作成（F-014 新規作成 Server Action）。 */
export async function createNews(input: NewsAdminInput): Promise<NewsRecord> {
  const created = await prisma.news.create({
    data: {
      title: input.title,
      body: input.body,
      category: input.category,
      status: input.status,
      publishedAt: input.publishedAt ?? null,
    },
  })
  return toRecord(created)
}

/** 単一取得（管理。未存在は null）。 */
export async function getNewsById(id: string): Promise<NewsRecord | null> {
  const news = await prisma.news.findUnique({ where: { id } })
  return news ? toRecord(news) : null
}

/** 管理一覧（DRAFT/UNPUBLISHED 含む。status で絞り込み可）。更新日降順。 */
export async function listAdminNews(filter?: {
  status?: PublishStatusCode
}): Promise<NewsRecord[]> {
  const where: Prisma.NewsWhereInput = {}
  if (filter?.status) where.status = filter.status
  const rows = await prisma.news.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
  })
  return rows.map(toRecord)
}

/** 更新（status 遷移含む）。未指定フィールドは変更しない。 */
export async function updateNews(
  id: string,
  input: Partial<NewsAdminInput>,
): Promise<NewsRecord> {
  const data: Prisma.NewsUpdateInput = {}
  if (input.title !== undefined) data.title = input.title
  if (input.body !== undefined) data.body = input.body
  if (input.category !== undefined) data.category = input.category
  if (input.status !== undefined) data.status = input.status
  if (input.publishedAt !== undefined) data.publishedAt = input.publishedAt
  const updated = await prisma.news.update({ where: { id }, data })
  return toRecord(updated)
}

/** 削除。 */
export async function deleteNews(id: string): Promise<void> {
  await prisma.news.delete({ where: { id } })
}

/**
 * 公開サイト用クエリ（F-004/F-005）: status='PUBLISHED' かつ publishedAt <= now() のみ、
 * publishedAt 降順。DRAFT/UNPUBLISHED を返さないこと（SPEC-002）。
 * 述語は `lib/news-visibility` に集約している（`lib/queries.ts` の getLatestNews と共有。
 * 二重実装が RV-P2-001 の差し戻し原因だったため、P3 でも書き起こさないこと）。
 */
export async function listPublishedNews(): Promise<NewsRecord[]> {
  const rows = await prisma.news.findMany({
    where: publishedNewsWhere(),
    orderBy: PUBLISHED_NEWS_ORDER_BY,
  })
  return rows.map(toRecord)
}
