/**
 * 公開ステータス（PublishStatus, 3値）の単一の型・ラベル参照元（SPEC-002 / functional-spec F-004 データモデル）。
 *
 * 注意: 現時点の Prisma schema の enum PublishStatus は DRAFT/PUBLISHED の2値のみで、
 * `UNPUBLISHED` は Impl(P2) が schema へ追加＋migrate する前提（F-014 実装申し送り）。
 * そのため @prisma/client の PublishStatus 型を使うと UNPUBLISHED が型に存在せず type-check が壊れる。
 * ここでは Prisma に依存しない**アプリ側の真実源**としてリテラル型を定義し、
 * validators / badge / news-admin / テストが本型を共有する。
 */

export type PublishStatusCode = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED'

export const PUBLISH_STATUSES: readonly PublishStatusCode[] = [
  'DRAFT',
  'PUBLISHED',
  'UNPUBLISHED',
] as const

/** DESIGN.md §4「公開ステータス」: DRAFT=下書き / PUBLISHED=公開 / UNPUBLISHED=非公開。 */
export const PUBLISH_STATUS_LABELS: Record<PublishStatusCode, string> = {
  DRAFT: '下書き',
  PUBLISHED: '公開',
  UNPUBLISHED: '非公開',
}
