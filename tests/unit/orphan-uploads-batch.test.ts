import { describe, it, expect, vi } from 'vitest'
import {
  ORPHAN_BATCH_MAX_PER_RUN,
  ORPHAN_RETENTION_HOURS,
  collectOrphanUploads,
} from '@/lib/orphan-uploads'

/**
 * =========================================================================
 * P3-c2 — **AC-PII-8 / AC-PII-11**: orphan アップロード回収バッチ
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` §4.12 AC-PII-8（:1552）/ AC-PII-11（:1555）、
 *       F-009「orphan回収」（:631）、`lib/retention.ts`（`orphanUploadHours: 24`）。
 *
 * ## AC-PII-11 が要求する 3 点（原文）
 * > (a) 対象が上限を超えるとき **200 件だけ処理して正常終了**する
 * > (b) 同じバッチを **2 回連続実行しても例外が出ず、2 回目で残りが処理される**
 * > (c) 途中で **Blob 削除に失敗した対象は DB を消さずに次回へ持ち越される**（AC-PII-6 の順序を維持）
 *
 * ## なぜ件数上限が要るのか（原文）
 * > Function の最大実行時間でタイムアウトすると**中途半端な状態で終わる**ため
 *
 * ## なぜ「Blob → DB」の順序なのか（AC-PII-6）
 * 逆順（DB 先）にすると、DB 行が消えた後に Blob 削除が失敗した場合
 * **どのオブジェクトを消すべきかの記録が失われ、免許証画像が永久に残る**
 * （＝ 保持期間の約束を守れない / APPI 上の不履行）。
 * したがって **Blob を先に消し、成功した対象だけ DB を消す**。
 *
 * ## red 理由
 * `lib/orphan-uploads.ts` が存在しない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/orphan-uploads.ts
 * export const ORPHAN_BATCH_MAX_PER_RUN = 200          // AC-PII-11（既定 200 件）
 * export const ORPHAN_RETENTION_HOURS = 24             // RETENTION_PERIODS.orphanUploadHours
 *
 * export interface OrphanCandidate { id: string; token: string; objectKey: string }
 *
 * export interface CollectOrphanDeps {
 *   /** `consumed=false` かつ `expiresAt < now - 24h` を古い順に最大 limit 件。 *\/
 *   listExpired(limit: number, now: number): Promise<OrphanCandidate[]>
 *   /** Blob を削除する。**失敗は throw で伝える**（握り潰さない）。 *\/
 *   deleteObject(objectKey: string): Promise<void>
 *   /** DB 行を削除する。**Blob 削除に成功した対象だけ**渡ってくる。 *\/
 *   deleteTokens(ids: string[]): Promise<void>
 *   logger?: { warn(event: string, fields: Record<string, unknown>): void }
 * }
 *
 * export interface CollectOrphanResult {
 *   processed: number     // Blob 削除に成功し DB からも消えた件数
 *   failed: number        // Blob 削除に失敗し**次回へ持ち越した**件数
 *   reachedLimit: boolean // 上限に達したか（＝ まだ残っている可能性がある）
 * }
 *
 * export function collectOrphanUploads(deps: CollectOrphanDeps, now: number): Promise<CollectOrphanResult>
 * ```
 *
 * **依存を注入する形にするのは、`lib/rate-limit.ts` の store と同じ理由**である
 * ——バッチ本体の性質（上限・ページング・べき等性・順序）は
 * **DB もストレージも無しに測れる**べきで、実 DB を要求すると測らない口実になる。
 * 実 DB を通した検証は `tests/integration/orphan-uploads.int.ts` が別に持つ。
 */

const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

function candidates(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tok_${offset + i}`,
    token: `ut_${offset + i}`,
    objectKey: `private/lic/${String(offset + i).padStart(32, '0')}`,
  }))
}

/** 与えた候補リストを「古い順に limit 件ずつ」返すフェイク。削除された分は消える。 */
function fakeDeps(initial: ReturnType<typeof candidates>, options: { failOn?: Set<string> } = {}) {
  let remaining = [...initial]
  const deletedObjects: string[] = []
  const deletedTokenIds: string[] = []
  const listCalls: number[] = []

  return {
    deletedObjects,
    deletedTokenIds,
    listCalls,
    get remainingCount() {
      return remaining.length
    },
    listExpired: vi.fn(async (limit: number) => {
      listCalls.push(limit)
      return remaining.slice(0, limit)
    }),
    deleteObject: vi.fn(async (objectKey: string) => {
      if (options.failOn?.has(objectKey)) throw new Error('blob delete failed')
      deletedObjects.push(objectKey)
    }),
    deleteTokens: vi.fn(async (ids: string[]) => {
      deletedTokenIds.push(...ids)
      remaining = remaining.filter((row) => !ids.includes(row.id))
    }),
  }
}

/* ========================================================================= *
 * AC-PII-11 (a): 件数上限
 * ========================================================================= */

describe('AC-PII-11(a): 1 回の実行で処理する件数に上限がある', () => {
  it('既定の上限は 200 件', () => {
    expect(ORPHAN_BATCH_MAX_PER_RUN).toBe(200)
  })

  it('対象が上限を超えても 200 件だけ処理して正常終了する', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される事故: 対象が数千件あるときに
    // **Function の最大実行時間でタイムアウトし、中途半端な状態で終わる**こと。
    // 中途半端な終了は「Blob は消えたが DB 行が残る」or その逆を生み、
    // **次回以降も同じ場所で落ち続ける**（回収が永久に進まない）。
    const deps = fakeDeps(candidates(500))
    const result = await collectOrphanUploads(deps, NOW)

    expect(result.processed).toBe(ORPHAN_BATCH_MAX_PER_RUN)
    expect(result.reachedLimit, '上限到達が呼び出し側へ伝わっていない').toBe(true)
    expect(deps.deletedObjects.length).toBe(ORPHAN_BATCH_MAX_PER_RUN)
  })

  it('listExpired へ上限を渡す（全件取得してからメモリで切らない）', async () => {
    // これが green なら排除される実装: `listExpired()` で**全件**取ってから
    // `slice(0, 200)` すること。対象が 10 万件あればその時点で落ちる。
    const deps = fakeDeps(candidates(500))
    await collectOrphanUploads(deps, NOW)
    expect(deps.listCalls.every((limit) => limit <= ORPHAN_BATCH_MAX_PER_RUN)).toBe(true)
  })

  it('対象が上限未満なら reachedLimit は false', async () => {
    const deps = fakeDeps(candidates(10))
    const result = await collectOrphanUploads(deps, NOW)
    expect(result.processed).toBe(10)
    expect(result.reachedLimit).toBe(false)
  })

  it('対象が 0 件でも例外を投げず正常終了する', async () => {
    // cron は毎日走る。**通常時（対象 0 件）が最も多い経路**である。
    const deps = fakeDeps([])
    const result = await collectOrphanUploads(deps, NOW)
    expect(result).toMatchObject({ processed: 0, failed: 0, reachedLimit: false })
  })
})

/* ========================================================================= *
 * AC-PII-11 (b): べき等性とページング
 * ========================================================================= */

describe('AC-PII-11(b): 2 回連続実行で残りが処理される（べき等・ページング）', () => {
  it('1 回目で 200 件、2 回目で残り 100 件が処理される', async () => {
    // AC-PII-11 の原文: 「同じバッチを 2 回連続実行しても例外が出ず、**2 回目で残りが処理される**」。
    // これが green なら排除される事故: 上限で打ち切った後、
    // **次回も同じ 200 件を対象にしてしまい残りが永久に処理されない**こと
    //（`deleteTokens` を呼び忘れる / オフセットで進めようとしてズレる、など）。
    const deps = fakeDeps(candidates(300))

    const first = await collectOrphanUploads(deps, NOW)
    expect(first.processed).toBe(200)
    expect(first.reachedLimit).toBe(true)

    const second = await collectOrphanUploads(deps, NOW)
    expect(second.processed, '2 回目で残りが処理されていない').toBe(100)
    expect(second.reachedLimit).toBe(false)
    expect(deps.remainingCount, '対象が残っている').toBe(0)
  })

  it('同じ対象を 2 回消そうとしない（重複削除を発行しない）', async () => {
    const deps = fakeDeps(candidates(300))
    await collectOrphanUploads(deps, NOW)
    await collectOrphanUploads(deps, NOW)
    expect(new Set(deps.deletedObjects).size).toBe(300)
    expect(deps.deletedObjects.length, '同じ objectKey を 2 回削除している').toBe(300)
  })

  it('対象が無くなった後に再実行しても例外にならない', async () => {
    const deps = fakeDeps(candidates(5))
    await collectOrphanUploads(deps, NOW)
    await expect(collectOrphanUploads(deps, NOW)).resolves.toMatchObject({ processed: 0 })
  })
})

/* ========================================================================= *
 * AC-PII-11 (c) / AC-PII-6: Blob → DB の順序と、失敗時の持ち越し
 * ========================================================================= */

describe('AC-PII-11(c) / AC-PII-6: Blob 削除に失敗した対象は DB を消さない', () => {
  it('失敗した対象の DB 行は残り、次回へ持ち越される', async () => {
    // **AC-PII-6 の順序が守られていることの実測。**
    // これが green なら排除される事故: DB を先に（あるいは一括で）消す実装。
    // Blob 削除が失敗した後に DB 行が消えると、
    // **どのオブジェクトを消すべきかの記録が失われ、免許証画像が永久に残る**
    //（＝ 利用者に約束した保持期間を守れない / APPI 上の不履行）。
    const rows = candidates(5)
    const failing = rows[2].objectKey
    const deps = fakeDeps(rows, { failOn: new Set([failing]) })

    const result = await collectOrphanUploads(deps, NOW)

    expect(result.processed).toBe(4)
    expect(result.failed, '失敗件数が伝わっていない').toBe(1)
    expect(
      deps.deletedTokenIds,
      'Blob 削除に失敗した対象の DB 行を消している（記録が失われる）',
    ).not.toContain(rows[2].id)
    expect(deps.remainingCount, '失敗分が次回へ持ち越されていない').toBe(1)
  })

  it('1 件の失敗で処理全体が止まらない（残りは処理される）', async () => {
    // これが green なら排除される実装: 最初の失敗で throw して抜けること。
    // 1 つの壊れたオブジェクトのせいで**回収が永久に進まなくなる**。
    const rows = candidates(10)
    const deps = fakeDeps(rows, { failOn: new Set([rows[0].objectKey]) })
    const result = await collectOrphanUploads(deps, NOW)
    expect(result.processed).toBe(9)
    expect(result.failed).toBe(1)
  })

  it('バッチ全体は例外を投げない（cron が異常終了しない）', async () => {
    const rows = candidates(3)
    const deps = fakeDeps(rows, { failOn: new Set(rows.map((r) => r.objectKey)) })
    await expect(collectOrphanUploads(deps, NOW)).resolves.toMatchObject({
      processed: 0,
      failed: 3,
    })
  })

  it('失敗をログに出すが objectKey 全体は出さない（AC-009-9 / AC-PII-1）', async () => {
    // AC-009-9: 「相関が必要な場合は **`objectKey` のハッシュ先頭 8 文字のみ**」。
    const rows = candidates(1)
    const logger = { warn: vi.fn() }
    const deps = { ...fakeDeps(rows, { failOn: new Set([rows[0].objectKey]) }), logger }

    await collectOrphanUploads(deps, NOW)

    expect(logger.warn, '削除失敗が観測できない').toHaveBeenCalled()
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(rows[0].objectKey)
  })
})

/* ========================================================================= *
 * AC-PII-8: 対象の定義（保持時間）
 * ========================================================================= */

describe('AC-PII-8: 対象は「未消費 かつ 期限切れから 24 時間経過」', () => {
  it('保持時間は RETENTION_PERIODS と同じ 24 時間', async () => {
    // `lib/retention.ts` の `orphanUploadHours: 24` と**二重管理しない**。
    // 値が食い違うと「/privacy で約束した期間」と「実際に削除する期間」がずれる
    //（`lib/retention.ts:4-7` が APPI 上の不履行になると明記している）。
    const { RETENTION_PERIODS } = await import('@/lib/retention')
    expect(ORPHAN_RETENTION_HOURS).toBe(RETENTION_PERIODS.orphanUploadHours)
  })

  it('listExpired へ渡す now が呼び出し側の now である（Date.now を直接読まない）', async () => {
    // 時刻を注入できないと**境界のテストが書けない**（P3-d の保持期間バッチも同じ形）。
    const deps = fakeDeps(candidates(1))
    await collectOrphanUploads(deps, NOW)
    expect(deps.listExpired).toHaveBeenCalledWith(ORPHAN_BATCH_MAX_PER_RUN, NOW)
  })
})
