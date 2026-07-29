/**
 * 公開お知らせの可視性述語（SEC-010 / RV-P2-001 再発防止）。
 *
 * 「公開サイトに出てよいお知らせ」の定義を **単一の真実源** に置く。
 * F-004/F-005: `status='PUBLISHED'` **かつ** `publishedAt <= now()`。
 * `publishedAt = null` の PUBLISHED は `lte` 比較で除外される（PostgreSQL の
 * `ORDER BY publishedAt DESC` は既定 NULLS FIRST のため、除外しないと先頭を占有する）。
 *
 * P2 差し戻しの根本原因は、この述語が `lib/news-admin.ts` の `listPublishedNews` と
 * `lib/queries.ts` の `getLatestNews` に**二重実装**され、片方（本番経路）が時刻ゲートを
 * 欠いていたこと。P3 の `/news` 一覧・`/news/[id]` 詳細でも書き起こさず本モジュールを使う。
 *
 * 設計上の注意:
 *  - **`import 'server-only'` を付けない**。`lib/news-admin.ts`（結合テストが Node 環境で import）と
 *    `lib/queries.ts`（server-only 付き）の双方から読まれるため、モジュール境界を壊さない側に置く。
 *  - **定数ではなく関数**にしている。定数だと `new Date()` がモジュール評価時に1度だけ固定され、
 *    長寿命プロセスで時刻ゲートが凍りつく（予約公開が永久に出ない/古い時刻で漏れる）。
 */
import type { Prisma } from '@prisma/client'

/** 公開サイトに出してよい News の where 条件（呼び出しごとに現在時刻で評価する）。 */
export function publishedNewsWhere(now: Date = new Date()): Prisma.NewsWhereInput {
  return { status: 'PUBLISHED', publishedAt: { lte: now } }
}

/** 公開お知らせの並び順（新しい順）。一覧・トップで共通。 */
export const PUBLISHED_NEWS_ORDER_BY = { publishedAt: 'desc' } as const satisfies Prisma.NewsOrderByWithRelationInput
