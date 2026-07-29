/**
 * orphan アップロードの回収バッチ（AC-PII-8 / AC-PII-11）。
 *
 * 対象は「**未消費（`consumed=false`）かつ 期限切れから 24 時間経過**」した `UploadToken` と、
 * それにバインドされたストレージオブジェクトである。
 * 申込に紐付かなかったアップロード＝**誰の同意にも紐付かない免許証画像**なので、
 * 放置は APPI 上の不履行になる。
 *
 * ------------------------------------------------------------------------
 * なぜ件数上限が要るのか（AC-PII-11 原文）
 * ------------------------------------------------------------------------
 * > Function の最大実行時間でタイムアウトすると**中途半端な状態で終わる**ため
 *
 * 中途半端な終了は「Blob は消えたが DB 行が残る」か その逆を生み、
 * **次回以降も同じ場所で落ち続ける**（回収が永久に進まない）。
 *
 * ------------------------------------------------------------------------
 * なぜ「Blob → DB」の順序なのか（AC-PII-6）
 * ------------------------------------------------------------------------
 * 逆順（DB 先）にすると、DB 行が消えた後に Blob 削除が失敗した場合
 * **どのオブジェクトを消すべきかの記録が失われ、免許証画像が永久に残る**。
 * したがって **Blob を先に消し、成功した対象だけ DB を消す。**
 *
 * ------------------------------------------------------------------------
 * なぜ依存を注入するのか
 * ------------------------------------------------------------------------
 * `lib/rate-limit.ts` の store と同じ理由である——バッチ本体の性質
 *（上限・ページング・べき等性・順序）は**DB もストレージも無しに測れる**べきで、
 * 実 DB を要求すると**測らない口実になる**。
 */

import { createHash } from 'node:crypto'
import { RETENTION_PERIODS } from '@/lib/retention'

/** 1 回の実行で処理する上限件数（AC-PII-11 の既定値）。 */
export const ORPHAN_BATCH_MAX_PER_RUN = 200

/**
 * 期限切れからこの時間を過ぎたものが対象（AC-PII-8）。
 *
 * ⚠️ **`lib/retention.ts` と二重管理しない。** 値が食い違うと
 * 「`/privacy` で約束した期間」と「実際に削除する期間」がずれる
 *（`lib/retention.ts` が「APPI 上はこの食い違いそのものが不履行になる」と明記している）。
 */
export const ORPHAN_RETENTION_HOURS = RETENTION_PERIODS.orphanUploadHours

export interface OrphanCandidate {
  id: string
  token: string
  objectKey: string
}

export interface CollectOrphanDeps {
  /** `consumed=false` かつ `expiresAt < now - 24h` を古い順に最大 `limit` 件。 */
  listExpired(limit: number, now: number): Promise<OrphanCandidate[]>
  /** ストレージのオブジェクトを削除する。**失敗は throw で伝える**（握り潰さない）。 */
  deleteObject(objectKey: string): Promise<void>
  /** DB 行を削除する。**Blob 削除に成功した対象だけ**渡ってくる。 */
  deleteTokens(ids: string[]): Promise<void>
  logger?: { warn(event: string, fields: Record<string, unknown>): void }
}

export interface CollectOrphanResult {
  /** Blob 削除に成功し DB からも消えた件数。 */
  processed: number
  /** Blob 削除に失敗し**次回へ持ち越した**件数。 */
  failed: number
  /** 上限に達したか（＝ まだ残っている可能性がある）。 */
  reachedLimit: boolean
}

/**
 * `objectKey` をログ可能な形へ落とす（AC-009-9 / AC-PII-1）。
 *
 * > 相関が必要な場合は **`objectKey` のハッシュ先頭 8 文字のみ**
 *
 * 生の `objectKey` は**そのオブジェクトへの到達経路そのもの**なので、運用ログに残さない。
 */
function objectKeyDigest(objectKey: string): string {
  return createHash('sha256').update(objectKey).digest('hex').slice(0, 8)
}

/**
 * orphan を 1 回分回収する。**例外を投げない**（cron が異常終了すると以後の実行が止まる）。
 */
export async function collectOrphanUploads(
  deps: CollectOrphanDeps,
  now: number,
): Promise<CollectOrphanResult> {
  let candidates: OrphanCandidate[] = []
  try {
    // ⚠️ **上限を `listExpired` へ渡す。** 全件取得してからメモリで `slice` する実装は、
    // 対象が 10 万件あればその時点で落ちる。
    // ⚠️ **`now` は呼び出し側から渡す**（`Date.now()` を直読みすると境界のテストが書けない）。
    candidates = await deps.listExpired(ORPHAN_BATCH_MAX_PER_RUN, now)
  } catch (error) {
    deps.logger?.warn('orphan-uploads.list_failed', { errorName: errorNameOf(error) })
    return { processed: 0, failed: 0, reachedLimit: false }
  }

  const deletableIds: string[] = []
  let failed = 0

  for (const candidate of candidates) {
    try {
      // **Blob を先に消す**（AC-PII-6）。成功したものだけを DB 削除の対象へ積む。
      await deps.deleteObject(candidate.objectKey)
      deletableIds.push(candidate.id)
    } catch (error) {
      // ⚠️ **1 件の失敗で全体を止めない。** 壊れたオブジェクトが 1 つあるだけで
      // 回収が永久に進まなくなる。失敗した対象は DB を消さず**次回へ持ち越す**。
      failed++
      deps.logger?.warn('orphan-uploads.delete_failed', {
        objectKeyHash: objectKeyDigest(candidate.objectKey),
        errorName: errorNameOf(error),
      })
    }
  }

  if (deletableIds.length > 0) {
    try {
      await deps.deleteTokens(deletableIds)
    } catch (error) {
      // DB 削除に失敗した場合、Blob は既に消えているが行は残る。
      // **次回の実行で `deleteObject` がべき等に成功し、行が消える**ので回収は進む。
      deps.logger?.warn('orphan-uploads.delete_tokens_failed', {
        count: deletableIds.length,
        errorName: errorNameOf(error),
      })
      return { processed: 0, failed: failed + deletableIds.length, reachedLimit: false }
    }
  }

  return {
    processed: deletableIds.length,
    failed,
    // 取得件数が上限に達していれば、まだ残っている可能性がある。
    reachedLimit: candidates.length >= ORPHAN_BATCH_MAX_PER_RUN,
  }
}

/** 例外の識別子だけを取る（メッセージは値を含みうるので出さない / `lib/pii-log.ts` と同じ判断）。 */
function errorNameOf(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name
  return 'UNKNOWN'
}
