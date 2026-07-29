/**
 * `GET /api/cron/orphan-uploads` — orphan アップロードの回収バッチ（AC-PII-8 / AC-PII-11）。
 *
 * 申込に紐付かなかったアップロード＝**誰の同意にも紐付かない免許証画像**なので、
 * 放置は APPI 上の不履行になる。対象は
 * 「**未消費（`consumed=false`）かつ 期限切れから `ORPHAN_RETENTION_HOURS` 経過**」。
 *
 * ------------------------------------------------------------------------
 * ⚠️ このルートを作らないと `lib/orphan-uploads.ts` は**到達しない受け口**になる
 * ------------------------------------------------------------------------
 * このプロジェクトが 6 回踏んだ型（受け口の悪用 → 受け口が呼ばれること →
 * 呼び出し元がその状態を作ること → **そもそも到達しない受け口**）の 4 段階目である。
 * バッチ本体の性質を単体で完璧に測っても、**呼ぶ人がいなければ画像は消えない。**
 *
 * ------------------------------------------------------------------------
 * 認可は `withCronAuth`（AC-PII-10）
 * ------------------------------------------------------------------------
 * 未認証は **401 ではなく 404**（削除バッチの所在を晒さない）。
 * `CRON_SECRET` 未設定時も fail-closed で 404。
 * `lib/public-guard.ts` では包まない——**Vercel Cron は `Origin` を送らない**ので、
 * Origin fail-closed のラッパで包むとバッチが永久に 403 で動かない。
 */

import { prisma } from '@/lib/db'
import { withCronAuth } from '@/lib/cron-auth'
import { consoleSink, createPiiSafeLogger, toErrorLogFields } from '@/lib/pii-log'
import { sharedStorage } from '@/lib/storage'
import { ORPHAN_RETENTION_HOURS, collectOrphanUploads } from '@/lib/orphan-uploads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = createPiiSafeLogger(consoleSink)

export const GET = withCronAuth(async (): Promise<Response> => {
  const now = Date.now()

  try {
    const result = await collectOrphanUploads(
      {
        /**
         * `consumed=false` かつ `expiresAt < now - 24h` を**古い順に最大 `limit` 件**。
         * ⚠️ **上限を SQL 側へ渡す**（全件取得してからメモリで切ると対象 10 万件で落ちる）。
         */
        listExpired: async (limit, at) => {
          const rows = await prisma.uploadToken.findMany({
            where: {
              consumed: false,
              expiresAt: { lt: new Date(at - ORPHAN_RETENTION_HOURS * 3_600_000) },
            },
            orderBy: { expiresAt: 'asc' },
            take: limit,
            select: { id: true, token: true, objectKey: true },
          })
          return rows
        },
        /** **Blob を先に消す**（AC-PII-6）。失敗は throw で伝える（握り潰さない）。 */
        deleteObject: (objectKey) => sharedStorage().deleteObject(objectKey),
        /** **Blob 削除に成功した対象だけ**が渡ってくる。 */
        deleteTokens: async (ids) => {
          await prisma.uploadToken.deleteMany({ where: { id: { in: ids } } })
        },
        logger,
      },
      now,
    )

    // 件数だけを返す。**`objectKey` は返さない**（AC-009-9 / AC-PII-1）。
    return Response.json(result, { status: 200 })
  } catch (error) {
    // `collectOrphanUploads` は例外を投げない契約だが、DB 接続そのものが落ちる経路は残る。
    // **cron が異常終了しても次回は走る**ので、ここでは 500 を返すに留める。
    logger.error('cron.orphan_uploads_failed', toErrorLogFields(error))
    return Response.json({ error: 'internal error' }, { status: 500 })
  }
})
