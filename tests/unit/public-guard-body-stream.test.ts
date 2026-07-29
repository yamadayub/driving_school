import { describe, it, expect, vi } from 'vitest'
import {
  MAX_PUBLIC_REQUEST_BODY_BYTES,
  withPublicMutation,
  type PublicGuardOptions,
} from '@/lib/public-guard'
import { formSessionAxisKey } from '@/lib/form-session'
import { createRateLimiter } from '@/lib/rate-limit'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-b 差し戻し — RV-P3B-006 / SEC-059（P3b-8 の目的が未達）
 * =========================================================================
 *
 * 出典: `docs/review-p3b-code-2026-07-29.md` RV-P3B-006（:321）、
 *       `docs/security-audit.md` SEC-059（:2952。128MB の chunked ボディを
 *       **サーバーが全部受信・バッファしてから** 413 を返すことを実測）。
 *
 * ## 「検出できる」と「消費させない」は別の性質である
 * `lib/public-guard.ts:429-440` は `await request.arrayBuffer()` で**全量を読み切ってから**
 * 長さを比べている。したがって既存の 413 テスト（宣言値 / 実測 / chunked / 境界）は**全部通る**が、
 * `lib/public-guard.ts:20` / `:360-364` のコメントが約束している
 * 「レート制限済みの相手にメモリを使わせない」は成立していない。
 *
 * 実装とコメントが食い違ったまま残ると、次に読む人が**防御済みだと誤認する**。
 * 本ファイルは「読み取ったバイト数」という**観測できる量**でその差を固定する。
 *
 * ## 実害の見積もり（過大報告しないための明示）
 * Vercel 側にリクエストボディ 4.5MB の上限があり、かつ評価順序上 Tier D の後にあるため、
 * 実運用の露出は「発信元あたり 10 分に 5 回 × 4.5MB」程度である。
 * **それでも P3b-8 が要求した性質そのものは未達**なので固定する。
 */

const ENDPOINT = 'applications' as const
const ORIGIN = 'https://example.test'
const TRUSTED: ClientIpResolution = { key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' }

/** 16KB。実際の HTTP でも近いサイズのチャンクが届く。 */
const CHUNK_BYTES = 16 * 1024

/**
 * 生成したバイト数を数える `ReadableStream`。
 * **リーダが要求した分だけ**チャンクを作る（`pull` ベース）ので、
 * 「どこまで読み進めたか」がそのまま `produced()` に現れる。
 */
function countingStream(totalBytes: number) {
  let produced = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= totalBytes) {
        controller.close()
        return
      }
      const size = Math.min(CHUNK_BYTES, totalBytes - produced)
      produced += size
      controller.enqueue(new Uint8Array(size).fill(0x20))
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, produced: () => produced, cancelled: () => cancelled }
}

function streamingRequest(stream: ReadableStream<Uint8Array>): Request {
  // `content-length` を**付けない**（`Transfer-Encoding: chunked` 相当）。
  // 付けるとヘッダだけで落ちる経路（評価順序 3）に入ってしまい、実測強制を検証できない。
  return new Request(`${ORIGIN}/api/applications`, {
    method: 'POST',
    headers: new Headers({ origin: ORIGIN, 'content-type': 'application/json' }),
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

function wiring(overrides: Partial<PublicGuardOptions> = {}): PublicGuardOptions {
  return {
    endpoint: ENDPOINT,
    requireContentType: 'json',
    limiters: {
      // 上限には当てない（ここで検証したいのはボディ処理であってレート制限ではない）。
      source: createRateLimiter({ limit: 10_000, windowMs: 600_000 }),
      formSession: createRateLimiter({ limit: 10_000, windowMs: 600_000 }),
    },
    formSessionKey: formSessionAxisKey,
    verifyFormSession: () => true,
    clientIp: () => TRUSTED,
    ...overrides,
  }
}

describe('RV-P3B-006 / SEC-059: 上限超過のボディは読み切らずに打ち切る', () => {
  it('4MB の chunked ボディで、読み取り量が上限 + 数チャンクに収まる', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される攻撃: 未認証の第三者が `Transfer-Encoding: chunked` で
    // 任意サイズのボディを送りつけ、**サーバーに任意サイズのバッファを確保させる**こと
    //（監査 B-7 の実測: 128MB を読み切らせられた）。
    // 413 が返ることは既存テストが固定済みで、**それだけでは何も防げていない**
    // ——413 を返すまでにメモリは既に消費されている。
    const total = 4 * 1024 * 1024
    const source = countingStream(total)
    const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
    const guarded = withPublicMutation(handler, wiring())

    const response = await guarded(streamingRequest(source.stream), undefined)

    expect(response.status, '413 が返らない（既存の契約が壊れている）').toBe(413)
    expect(handler, '上限超過のボディが本体へ到達している').not.toHaveBeenCalled()

    // 上限を跨いだ時点で打ち切れば、読み取り量は「上限 + 先読み数チャンク」に収まる。
    // 余裕を 4 チャンク取るのは、ストリームの highWaterMark による先読みを誤検出しないため。
    const allowed = MAX_PUBLIC_REQUEST_BODY_BYTES + 4 * CHUNK_BYTES
    expect(
      source.produced(),
      `上限 ${MAX_PUBLIC_REQUEST_BODY_BYTES} バイトに対し ${source.produced()} バイトを読み切っている` +
        `（送信量 ${total} バイト）`,
    ).toBeLessThanOrEqual(allowed)
  })

  it('打ち切りは残りを読まずに cancel する（送信側に読み続けさせない）', async () => {
    // `reader.cancel()` を呼ばないと、上限超過を検出した後も**接続が読み進み続ける**
    //（アップストリームがバッファを持つ）。「読まない」ことが防御の実体である。
    const source = countingStream(4 * 1024 * 1024)
    const guarded = withPublicMutation(
      vi.fn(async () => Response.json({ ok: true }, { status: 201 })),
      wiring(),
    )

    await guarded(streamingRequest(source.stream), undefined)
    expect(source.cancelled(), '上限超過を検出した後もストリームを cancel していない').toBe(true)
  })

  it('上限内の chunked ボディは本体で読み直せる（副作用で全送信を壊さない）', async () => {
    // **この 1 本が無いと、上の 2 本は「ボディを読まない実装」で通ってしまう。**
    // 計測のためにストリームを消費した後、handler の `request.json()` が
    // `Body is unusable` で落ちる——**上限を入れた副作用で全送信が壊れる**という
    // `lib/public-guard.ts:418-424` が名指しで警戒している事故を排除する。
    const payload = JSON.stringify({ hello: 'world', pad: 'x'.repeat(1_000) })
    const encoded = new TextEncoder().encode(payload)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded)
        controller.close()
      },
    })

    let seen: unknown = null
    const guarded = withPublicMutation(async (req: Request) => {
      seen = await req.json()
      return Response.json({ ok: true }, { status: 201 })
    }, wiring())

    const response = await guarded(streamingRequest(stream), undefined)
    expect(response.status).toBe(201)
    expect((seen as { hello?: string })?.hello).toBe('world')
  })

  it('ちょうど上限のボディは通り、1 バイト超過は 413（境界の維持）', async () => {
    // 打ち切り実装へ書き換えるときに最も壊れやすいのが境界（`>` と `>=` の取り違え）。
    for (const [bytes, expected] of [
      [MAX_PUBLIC_REQUEST_BODY_BYTES, 201],
      [MAX_PUBLIC_REQUEST_BODY_BYTES + 1, 413],
    ] as const) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes).fill(0x20))
          controller.close()
        },
      })
      const guarded = withPublicMutation(
        async () => Response.json({ ok: true }, { status: 201 }),
        wiring(),
      )
      const response = await guarded(streamingRequest(stream), undefined)
      expect(response.status, `${bytes} バイトのボディ`).toBe(expected)
    }
  })
})
