import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { withCronAuth } from '@/lib/cron-auth'

/**
 * =========================================================================
 * P3-a — AC-PII-10（**のみ**。RV-P3DR-003）: cron エンドポイントの認可
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-PII-10、
 *       `docs/phase-status.md`「P3-a の完了条件 (1)」AC-PII-10 の行。
 *
 * ## スコープ（ここを広げないこと）
 * P3-a で検証するのは **`withCronAuth` の存在と挙動**だけである。
 * **AC-PII-11（バッチ本体の件数上限200・ページング・べき等性）は P3-a に対象が存在しない**
 * （`/api/cron/orphan-uploads` は P3-c、`/api/cron/retention` は P3-d の成果物）。
 * 「達成できない完了条件は『達成したことにする』運用に化ける」ため、ここでは書かない
 * （`it.skip` も置かない。申し送り §D 27）。
 *
 * ## red 理由
 * `lib/cron-auth.ts` が存在しないため import 解決に失敗する。
 *
 * ## Impl が実装すべき契約
 * ```ts
 * export function withCronAuth<Ctx>(
 *   handler: (request: Request, ctx: Ctx) => Promise<Response>,
 *   options?: { secret?: string },   // 既定 process.env.CRON_SECRET
 * ): (request: Request, ctx: Ctx) => Promise<Response>
 * ```
 */

const SECRET = 'c'.repeat(44)

function cronRequest(authorization?: string, extraHeaders: Record<string, string> = {}) {
  const headers = new Headers(extraHeaders)
  if (authorization !== undefined) headers.set('authorization', authorization)
  return new Request('https://example.test/api/cron/retention', { method: 'GET', headers })
}

function okHandler() {
  return vi.fn(async () => Response.json({ processed: 0 }))
}

describe('AC-PII-10: 未認証の cron 呼び出しは 404（401 で経路の存在を教えない）', () => {
  it('Authorization ヘッダが無ければ 404 で、本体を呼ばない', async () => {
    // これが green なら排除される: 401 を返す実装。
    // 401 は「このパスは存在するが鍵が違う」ことを教える＝**削除バッチの所在を晒す**。
    const handler = okHandler()
    const response = await withCronAuth(handler, { secret: SECRET })(cronRequest(), undefined)
    expect(response.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it('誤った Bearer トークンは 404', async () => {
    const handler = okHandler()
    const response = await withCronAuth(handler, { secret: SECRET })(
      cronRequest(`Bearer ${'d'.repeat(44)}`),
      undefined,
    )
    expect(response.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it('長さの違う誤トークンでも例外にならず 404 になる（定数時間比較の前提）', async () => {
    const handler = okHandler()
    for (const token of ['', 'x', 'Bearer', `Bearer ${'e'.repeat(200)}`]) {
      const response = await withCronAuth(handler, { secret: SECRET })(
        cronRequest(token),
        undefined,
      )
      expect(response.status, `token=${token.slice(0, 10)}`).toBe(404)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('スキームが Bearer でなければ 404（Basic 等を受け付けない）', async () => {
    const handler = okHandler()
    const response = await withCronAuth(handler, { secret: SECRET })(
      cronRequest(`Basic ${SECRET}`),
      undefined,
    )
    expect(response.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it('正しい Bearer トークンなら本体が呼ばれる', async () => {
    const handler = okHandler()
    const response = await withCronAuth(handler, { secret: SECRET })(
      cronRequest(`Bearer ${SECRET}`),
      undefined,
    )
    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('CRON_SECRET が未設定なら、正しい形の要求でも 404（fail-closed）', async () => {
    // これが green なら排除される: シークレット未設定時に認可を素通りさせる実装
    //（＝ 未認証の削除エンドポイントが本番に出る）。
    const handler = okHandler()
    const response = await withCronAuth(handler, { secret: undefined })(
      cronRequest('Bearer anything'),
      undefined,
    )
    expect(response.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('AC-PII-10: cron は public-guard の対象外（Origin を持たない）', () => {
  it('Origin ヘッダが無くても、正しい Bearer なら通る', async () => {
    // これが green なら排除される: `/api/cron/**` を `withPublicMutation` で包む実装。
    // Vercel Cron は `Origin` を送らないため、Origin fail-closed で**必ず 403 になり
    // バッチが永久に動かない**（保持期間削除・orphan 回収が止まる ＝ APPI 違反の温床）。
    const handler = okHandler()
    const request = cronRequest(`Bearer ${SECRET}`)
    expect(request.headers.get('origin')).toBeNull()
    const response = await withCronAuth(handler, { secret: SECRET })(request, undefined)
    expect(response.status).toBe(200)
  })
})

describe('AC-PII-10: CRON_SECRET の比較は定数時間（Test 申し送り16）', () => {
  const source = readFileSync(resolve(process.cwd(), 'lib/cron-auth.ts'), 'utf8')

  it('timingSafeEqual を使う', () => {
    // 素の `===` は先頭一致長で早期 return するため、応答時間から1文字ずつ復元できる。
    // `lib/password.ts` が同じ理由で `timingSafeEqual` を使っている（P2 の既存方針と揃える）。
    expect(source).toContain('timingSafeEqual')
  })

  it('シークレットを直接 === / !== で比較していない', () => {
    expect(source).not.toMatch(/secret\s*(===|!==)\s*/)
  })
})

describe('AC-PII-11 は P3-a のスコープ外（対象バッチが存在しない）', () => {
  it('件数上限・ページング・べき等性は P3-c / P3-d で検証する（ここでは書かない）', () => {
    // 記録としてのみ置く。**`it.skip` は置かない**——skip は「あるのに動いていない」テストとして
    // 残り、後で「あるから確認済み」と誤読される（申し送り §D 27 / 前回 §D 18）。
    expect(true).toBe(true)
  })
})
