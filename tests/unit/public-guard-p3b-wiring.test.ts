import { describe, it, expect, vi } from 'vitest'
import {
  MAX_PUBLIC_REQUEST_BODY_BYTES,
  withPublicMutation,
  type PublicGuardOptions,
} from '@/lib/public-guard'
import {
  FORM_SESSION_COOKIE_NAME,
  createFormSessionValue,
  formSessionAxisKey,
  newFormSessionPayload,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { createRateLimiter, type RateLimiter } from '@/lib/rate-limit'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-b — P3b-1（SEC-053）/ P3b-1b（SEC-052）/ P3b-8（ボディサイズ上限）
 * =========================================================================
 *
 * 出典: `docs/security-audit.md`「P3-a 再監査」§B D-1〜D-6（:2382-2385）/ §C SEC-052・SEC-053・SEC-055、
 *       §E P3b-1 / P3b-1b / P3b-8（:2608-2616）、`docs/phase-status.md` P3-b 完了条件、
 *       `docs/functional-spec.md` §4.11 AC-RL-3 / AC-RL-7 / AC-RL-12。
 *
 * ## Impl が実装すべき追加（`lib/public-guard.ts`）
 * ```ts
 * export const MAX_PUBLIC_REQUEST_BODY_BYTES = 64 * 1024
 *
 * export interface PublicGuardOptions {
 *   …
 *   /** 要求元ごとに一意なキーだけを受ける（素の string は渡せない / SEC-052）。 *\/
 *   formSessionKey?: (request: Request) => PerRequesterKey | null
 *   /** 省略時 `MAX_PUBLIC_REQUEST_BODY_BYTES`。超過は 413（Tier ではない失敗＝`challenge` を含まない）。 *\/
 *   maxBodyBytes?: number
 * }
 * ```
 * **構築時検査（SEC-053 の修正方針 2）**: `limiters.source` を渡しているのに
 * `limiters.formSession` / `formSessionKey` が無い構成は `withPublicMutation` の**構築時に throw** する。
 * `trusted` と違いオプションの有無は構築時に分かるため、リクエスト毎判定を避けた過去の判断は当てはまらない。
 */

const ENDPOINT = 'applications' as const
const ORIGIN = 'https://example.test'
const SECRET = 'p3b-test-form-session-secret-32-characters'
const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

const TRUSTED: ClientIpResolution = { key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' }
const DEGRADED: ClientIpResolution = { key: 'unknown', trusted: false, source: 'unknown' }

function cookieFor(sid: string, issuedAt = NOW - 10_000): string {
  return `${FORM_SESSION_COOKIE_NAME}=${createFormSessionValue({ sid, issuedAt }, SECRET)}`
}

function request(options: { cookie?: string; body?: string; ip?: string } = {}): Request {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
  if (options.cookie) headers.set('cookie', options.cookie)
  if (options.ip) headers.set('x-test-ip', options.ip)
  return new Request(`${ORIGIN}/api/applications`, {
    method: 'POST',
    headers,
    body: options.body ?? '{}',
  })
}

/** content-length を持たない（chunked 相当の）リクエスト。 */
function streamingRequest(payload: string, declaredContentLength?: string): Request {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
  if (declaredContentLength !== undefined) headers.set('content-length', declaredContentLength)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
  return new Request(`${ORIGIN}/api/applications`, {
    method: 'POST',
    headers,
    body: stream,
    // Node の undici はストリーム body に `duplex: 'half'` を要求する（TS の型には未定義）。
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

function okHandler() {
  return vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
}

/** 本番と同じ結線。**テスト専用の簡略配線を作らない**（P2 の「テスト対象の取り違え」を避ける）。 */
function productionWiring(overrides: Partial<PublicGuardOptions> = {}): PublicGuardOptions {
  return {
    endpoint: ENDPOINT,
    requireContentType: 'json',
    limiters: {
      source: createRateLimiter({ limit: 5, windowMs: 600_000 }),
      formSession: createRateLimiter({ limit: 3, windowMs: 600_000 }),
    },
    formSessionKey: formSessionAxisKey,
    verifyFormSession: (req, now) => verifyFormSessionValue(readFormSessionCookie(req), SECRET, now) !== null,
    // 発信元は `x-test-ip` があればそれを使う（`ClientIpResolution` を**分解せずに**返す / SEC-043）。
    clientIp: (req) => {
      const ip = req.headers.get('x-test-ip')
      return ip ? { key: ip, trusted: true, source: 'x-forwarded-for' } : TRUSTED
    },
    now: () => NOW,
    ...overrides,
  }
}

/** `consume` されたキーを記録する limiter（軸が本当に評価されたかを観測する）。 */
function recordingLimiter(inner: RateLimiter, log: string[]): RateLimiter {
  return {
    consume: (key, now) => {
      log.push(key)
      return inner.consume(key, now)
    },
    peek: (key, now) => inner.peek(key, now),
    reset: (key) => inner.reset(key),
  }
}

/* ========================================================================= *
 * P3b-1 / SEC-053: 「渡し忘れ」を構築時に落とす
 * ========================================================================= */

describe('P3b-1 / SEC-053: 別軸を渡し忘れた構成は構築時に throw する', () => {
  it('limiters.source だけ渡した構成は throw（縮退時に流量上限が消える）', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される攻撃（監査 D-1 の実測）: 縮退構成（`trusted=false`）で
    // `formSession` 軸を渡し忘れると、`enforce` される Tier D 軸が1つも無くなり
    // **単一の攻撃者が窓あたり無制限に DB 書き込みとメール送信を発生させられる**
    //（実測: 500回送信 → 201 × 500）。SEC-043 の是正が新たに開いた経路であり、
    // 「渡し忘れ」は**最も安い事故**（監査の優先順位1位）である。
    // 振る舞いテストでは検出できない——渡し忘れた構成は `trusted=true` の環境では正常に見えるため。
    expect(() =>
      withPublicMutation(okHandler(), {
        endpoint: ENDPOINT,
        limiters: { source: createRateLimiter({ limit: 3, windowMs: 60_000 }) },
        verifyFormSession: () => true,
      }),
    ).toThrow(/formSession/i)
  })

  it('formSessionKey だけ渡して limiters.formSession が無い構成も throw（片側だけの配線）', () => {
    // これが green なら排除される壊れた実装: キー関数だけ渡して limiter を忘れ、
    // **軸が存在しないのに「渡した」と本人は思っている**状態（`lib/public-guard.ts:235` は
    // 両方揃ったときにしか軸を作らないため、静かに無効化される）。
    expect(() =>
      withPublicMutation(okHandler(), {
        endpoint: ENDPOINT,
        limiters: { source: createRateLimiter({ limit: 3, windowMs: 60_000 }) },
        formSessionKey: formSessionAxisKey,
        verifyFormSession: () => true,
      }),
    ).toThrow(/formSession/i)
  })

  it('limiters.formSession だけ渡して formSessionKey が無い構成も throw', () => {
    expect(() =>
      withPublicMutation(okHandler(), {
        endpoint: ENDPOINT,
        limiters: {
          source: createRateLimiter({ limit: 3, windowMs: 60_000 }),
          formSession: createRateLimiter({ limit: 3, windowMs: 60_000 }),
        },
        verifyFormSession: () => true,
      }),
    ).toThrow(/formSessionKey/i)
  })

  it('両方渡した構成は throw しない（正しい配線を妨げない）', () => {
    expect(() => withPublicMutation(okHandler(), productionWiring())).not.toThrow()
  })

  it('軸を1つも渡さない構成（レート制限を持たないラッパ利用）は従来どおり許す', () => {
    // ラッパは Origin / Content-Type 検証だけに使う経路も持つ。**構築時検査が
    // 「source を渡したのに別軸が無い」という限定条件でのみ効く**ことを固定する
    //（過剰な検査で既存の使い方を壊すと、Impl が検査そのものを外す動機になる）。
    expect(() =>
      withPublicMutation(okHandler(), { endpoint: ENDPOINT, verifyFormSession: () => true }),
    ).not.toThrow()
  })
})

/* ========================================================================= *
 * P3b-1 / SEC-053: 縮退構成でも実効的な流量上限が残る（D-1 / D-2 の再現）
 * ========================================================================= */

describe('AC-RL-3 (1) / SEC-053: 縮退（trusted=false）でも Cookie 軸で上限が効く', () => {
  it('同一 Cookie の4回目が Tier D（429）になり、handler は3回しか呼ばれない', async () => {
    // これが green なら排除される攻撃（監査 D-1 の 500回 → 201×500）: 縮退構成で
    // 発信元軸が計数のみになった結果、**Tier D に enforce される軸が1つも残らない**状態。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, productionWiring({ clientIp: () => DEGRADED }))
    const cookie = cookieFor('a'.repeat(32))

    const statuses: number[] = []
    for (let i = 0; i < 20; i++) statuses.push((await guarded(request({ cookie }), undefined)).status)

    expect(statuses.slice(0, 3)).toEqual([201, 201, 201])
    expect(new Set(statuses.slice(3)), '4回目以降はすべて 429').toEqual(new Set([429]))
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('Cookie を取り直せば別バケットになる（D-2: Cookie 10枚 → 30回）', async () => {
    // 上限が Cookie ごとであることの確認。**これは弱点ではなく設計どおり**であり、
    // 「Cookie を無限に取り直す」経路は AC-RL-13(c)（発行の流量制限 30回/10分）で閉じる。
    // ここで固定しておかないと、後続で「Cookie 軸だけで十分」という誤った要約が生まれる。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, productionWiring({ clientIp: () => DEGRADED }))
    for (let n = 0; n < 10; n++) {
      const cookie = cookieFor(String(n).padStart(32, '0'))
      for (let i = 0; i < 4; i++) await guarded(request({ cookie }), undefined)
    }
    expect(handler).toHaveBeenCalledTimes(30)
  })

  it('Cookie 不在は Tier B（403 + challenge）であって Tier D ではない', async () => {
    // AC-RL-3 (2)。素通りさせないこと **と** 429 にしないことの両方を1本で固定する。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, productionWiring({ clientIp: () => DEGRADED }))
    const response = await guarded(request(), undefined)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(handler).not.toHaveBeenCalled()
  })
})

/* ========================================================================= *
 * P3b-1b / SEC-052: 共有バケットによる巻き添え 429 が起きない（D-3 / D-4 の再現）
 * ========================================================================= */

describe('P3b-1b / SEC-052: 第三者の送信で Cookie 無し利用者が 429 にならない', () => {
  it('攻撃者が Cookie 軸を使い切っても、Cookie を持たない利用者は 403（challenge）で回復できる', async () => {
    // **監査 D-3 / D-4 の実測を、そのままテストにしたもの。**
    // 監査は `formSessionKey` が Cookie 不在時に固定値（`'anonymous'`）へフォールバックする配線で、
    // `trusted=true` の**通常構成**でも「攻撃者3回 → 無関係な利用者が 429」を実測した。
    // これが green なら排除される攻撃: 単一の攻撃者が、Cookie をブロックしている
    // 正当な利用者・初回訪問者から**回復可能な経路（403 + challenge）を奪い、
    // 窓が明けるまでの硬い拒否（429）に落とす**こと。
    const guarded = withPublicMutation(okHandler(), productionWiring())
    const attacker = cookieFor('f'.repeat(32))

    for (let i = 0; i < 5; i++) {
      await guarded(request({ cookie: attacker, ip: '198.51.100.1' }), undefined)
    }

    // 攻撃者とは**別の発信元**（＝発信元軸では巻き添えにならない）。
    const victim = await guarded(request({ ip: '203.0.113.42' }), undefined)
    expect(victim.status, 'Cookie 不在の利用者が 429 に巻き込まれている（SEC-052 の再現）').toBe(403)
    expect(await victim.json()).toEqual({ challenge: 'interactive' })
  })

  it('攻撃者が Cookie 軸を使い切っても、別 Cookie の利用者は 201 のまま', async () => {
    const guarded = withPublicMutation(okHandler(), productionWiring())
    const attacker = cookieFor('f'.repeat(32))
    for (let i = 0; i < 5; i++) {
      await guarded(request({ cookie: attacker, ip: '198.51.100.1' }), undefined)
    }

    const other = await guarded(
      request({ cookie: cookieFor('0'.repeat(32)), ip: '203.0.113.42' }),
      undefined,
    )
    expect(other.status).toBe(201)
  })
})

/* ========================================================================= *
 * P3b-11 / SEC-055: 形式不正 Cookie でバケットを増やさせない（D-6 の再現）
 * ========================================================================= */

describe('P3b-11 / SEC-055: 形式不正な Cookie は formSession 軸を消費しない', () => {
  it('形式不正な Cookie を 200種送っても formSession 軸の consume が 0 回', async () => {
    // これが green なら排除される攻撃（監査 D-6: store 件数が maxEntries に張り付いた）:
    // 未認証の第三者が 1リクエストにつき1つ新しいバケットを作り、
    // **正当な利用者の進行中カウンタを退避で消す**こと。
    const consumed: string[] = []
    const formSession = recordingLimiter(
      createRateLimiter({ limit: 3, windowMs: 600_000 }),
      consumed,
    )
    const guarded = withPublicMutation(
      okHandler(),
      productionWiring({
        limiters: { source: createRateLimiter({ limit: 10_000, windowMs: 600_000 }), formSession },
      }),
    )

    const statuses = new Set<number>()
    for (let i = 0; i < 200; i++) {
      // 形式不正（署名部が 43文字でない）だが、リクエストごとに異なる値。
      const value = `${String(i).padStart(20, '0')}.short`
      const response = await guarded(
        request({ cookie: `${FORM_SESSION_COOKIE_NAME}=${value}` }),
        undefined,
      )
      statuses.add(response.status)
    }

    expect(consumed, `形式不正な値でバケットが作られた: ${consumed.slice(0, 3).join(', ')}`).toEqual(
      [],
    )
    expect(statuses, '形式不正な Cookie はすべて Tier B へ落ちる').toEqual(new Set([403]))
  })

  it('形式が正しい（署名は不正な）Cookie では軸を消費する（偽造試行そのものは絞る）', async () => {
    const consumed: string[] = []
    const formSession = recordingLimiter(
      createRateLimiter({ limit: 3, windowMs: 600_000 }),
      consumed,
    )
    const guarded = withPublicMutation(
      okHandler(),
      productionWiring({
        limiters: { source: createRateLimiter({ limit: 10_000, windowMs: 600_000 }), formSession },
      }),
    )
    const forged = `${'a'.repeat(20)}.${'b'.repeat(43)}`
    const response = await guarded(
      request({ cookie: `${FORM_SESSION_COOKIE_NAME}=${forged}` }),
      undefined,
    )
    expect(consumed.length, '検証前の計数という意図した挙動が消えている').toBe(1)
    expect(response.status, '署名不正は Tier B').toBe(403)
  })
})

/* ========================================================================= *
 * P3b-8: リクエストボディのサイズ上限
 * ========================================================================= */

describe('P3b-8: 公開エンドポイントのリクエストボディサイズ上限', () => {
  const wiring = () => productionWiring({ maxBodyBytes: 1_024 })
  const cookie = cookieFor('c'.repeat(32))

  it('既定値が定数として公開されている（各ルートで別々の値を書かせない）', () => {
    expect(MAX_PUBLIC_REQUEST_BODY_BYTES).toBe(64 * 1024)
  })

  it('content-length が上限超過なら 413 で、handler を呼ばない', async () => {
    // これが green なら排除される攻撃: 巨大な JSON を送りつけて、
    // **パース（`request.json()`）とバリデーションの CPU / メモリを未認証の攻撃者が消費させる**こと。
    // 上限が無いと、レート制限が許す1回あたりのコストを攻撃者が自由に決められる。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, wiring())
    const response = await guarded(request({ cookie, body: 'x'.repeat(2_000) }), undefined)
    expect(response.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('413 の本文は `challenge` を含まない（Tier B と区別できる / 契約ルール7）', async () => {
    // これが green なら排除される壊れた実装: 413 を Tier B として返し、
    // クライアントが CAPTCHA を出す形。解いて再送しても同じ 413 が返る
    // **抜けられないループ**になる（AC-RL-12(e) が名指しで禁じている状態）。
    const guarded = withPublicMutation(okHandler(), wiring())
    const response = await guarded(request({ cookie, body: 'x'.repeat(2_000) }), undefined)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.challenge).toBeUndefined()
    expect(response.headers.get('retry-after')).toBeNull()
  })

  it('content-length が無くても実バイト数で上限を強制する', async () => {
    // これが green なら排除される攻撃: `Transfer-Encoding: chunked` で content-length を出さず、
    // **ヘッダだけを見る上限チェックを完全に迂回**すること（HTTP/1.1 でも HTTP/2 でも成立する）。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, wiring())
    const response = await guarded(streamingRequest('y'.repeat(2_000)), undefined)
    expect(response.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('content-length が過少申告でも実バイト数で落とす', async () => {
    // これが green なら排除される攻撃: `content-length: 10` と申告して 2,000 バイト送ること。
    // ヘッダを信じる実装はここで落ちる。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, wiring())
    const response = await guarded(streamingRequest('z'.repeat(2_000), '10'), undefined)
    expect(response.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('上限内のボディは handler に届き、handler 側で読み直せる', async () => {
    // **ラッパがボディを読んで計測した後、handler が `request.json()` を呼べること。**
    // これが green なら排除される壊れた実装: 計測のためにストリームを消費し、
    // handler 側が「body already used」で 500 になる形（**上限を入れた副作用で全送信が壊れる**）。
    const seen: unknown[] = []
    const handler = vi.fn(async (req: Request) => {
      seen.push(await req.json())
      return Response.json({ ok: true }, { status: 201 })
    })
    const guarded = withPublicMutation(handler, wiring())
    const response = await guarded(request({ cookie, body: JSON.stringify({ hello: 'world' }) }), undefined)
    expect(response.status).toBe(201)
    expect(seen).toEqual([{ hello: 'world' }])
  })

  it('ちょうど上限は通り、1バイト超過は 413（境界）', async () => {
    const guarded = withPublicMutation(okHandler(), productionWiring({ maxBodyBytes: 16 }))
    const exact = await guarded(request({ cookie, body: 'a'.repeat(16) }), undefined)
    const over = await guarded(request({ cookie, body: 'a'.repeat(17) }), undefined)
    expect(exact.status).toBe(201)
    expect(over.status).toBe(413)
  })

  it('マルチバイト文字は「文字数」ではなく「バイト数」で数える', () => {
    // 契約の宣言（実行は上のケースで担保）。SEC-042 と同じ「JS 文字列長とバイト長のずれ」であり、
    // 文字数で数えると **UTF-8 で最大3〜4倍**のボディを通してしまう。
    expect(new TextEncoder().encode('あ').length, '前提: あ は UTF-8 で 3 バイト').toBe(3)
  })

  it('マルチバイトのボディが上限をバイト単位で超えたら 413', async () => {
    const handler = okHandler()
    const guarded = withPublicMutation(handler, productionWiring({ maxBodyBytes: 30 }))
    // 'あ' × 11 = 33 バイト（文字数では 11 なので、文字数で数える実装は通してしまう）。
    const response = await guarded(request({ cookie, body: 'あ'.repeat(11) }), undefined)
    expect(response.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('P3b-8: 評価順序（ボディを読む前にレート制限を通す / AC-RL-7）', () => {
  const cookie = cookieFor('d'.repeat(32))

  it('content-length による事前判定はレート制限より前（無料で落とせるものは先に落とす）', async () => {
    // ⚠️ **Impl による入力の修正（アサーションは未変更 / `docs/impl-p3b-notes-2026-07-29.md` §2）**
    //   当初この行は `request({ cookie, body: 'x'.repeat(2_000) })` だったが、
    //   **WHATWG の `Request` コンストラクタは `Content-Length` を付けない**
    //   （付けるのは fetch の送信段階であり、仕様の Request 構築手順にその工程が無い。
    //    Node v20 / undici で実測: `new Request(url, { body: 'x'.repeat(2000) }).headers` は
    //    `content-type` と `origin` のみ）。したがって元の入力は
    //    「content-length を持たないボディ」であり、同 describe の次のテストが 429 を要求する
    //    `streamingRequest(...)` と**公開 API 上まったく区別できない**——この2本は同時に満たせなかった。
    //   本テストの名前・意図（「ヘッダだけで判る超過」）どおり **content-length を明示した入力**へ
    //   差し替えることで、固定したかった評価順序（3: 宣言値 → 4: レート制限）をそのまま検証する。
    //   Next.js の実ランタイムでは受信リクエストが content-length を持つため、本番の意味は変わらない。
    const guarded = withPublicMutation(okHandler(), productionWiring({ maxBodyBytes: 1_024 }))
    // 先に Cookie 軸を使い切る。
    for (let i = 0; i < 5; i++) await guarded(request({ cookie }), undefined)
    const response = await guarded(streamingRequest('x'.repeat(2_000), '2000'), undefined)
    expect(response.status, 'ヘッダだけで判る超過は 429 より先に 413 にする').toBe(413)
  })

  it('実バイト数の計測はレート制限の後（レート制限済みの攻撃者にメモリを使わせない）', async () => {
    // これが green なら排除される攻撃: すでに Tier D に達している攻撃者が、
    // content-length を出さないリクエストを送り続けて **毎回 64KB ぶんの読み取りを強制**すること
    //（レート制限の目的である「本体より前に落とす」が、上限チェックの位置取りで無効化される）。
    const guarded = withPublicMutation(okHandler(), productionWiring({ maxBodyBytes: 1_024 }))
    for (let i = 0; i < 5; i++) await guarded(request({ cookie }), undefined)
    const response = await guarded(streamingRequest('y'.repeat(2_000)), undefined)
    expect(response.status, 'レート制限済みなら本体もボディ読み取りも行わない').toBe(429)
  })
})

describe('P3b-4 / SEC-048・SEC-049: リクエスト由来の値を now / permitId に使わない', () => {
  it('リクエストヘッダで時刻を偽装しても Cookie の期限判定が変わらない', async () => {
    // 出典: P3b-4（`now` にリクエスト由来の値を渡さない）。
    // これが green なら排除される攻撃: `Date` ヘッダや body の `clientNow` を `now` に流し込み、
    // **期限切れ Cookie を有効に見せる / 送信間隔下限を回避する**こと。
    const expired = createFormSessionValue(
      { sid: 'e'.repeat(32), issuedAt: NOW - 3_600_000 },
      SECRET,
    )
    const guarded = withPublicMutation(okHandler(), productionWiring())
    const headers = new Headers({
      origin: ORIGIN,
      'content-type': 'application/json',
      cookie: `${FORM_SESSION_COOKIE_NAME}=${expired}`,
      date: new Date(NOW - 3_600_000).toUTCString(),
      'x-client-now': String(NOW - 3_600_000),
    })
    const response = await guarded(
      new Request(`${ORIGIN}/api/applications`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientNow: NOW - 3_600_000 }),
      }),
      undefined,
    )
    expect(response.status, '期限切れ Cookie は Tier B のまま').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
  })

  it('newFormSessionPayload の issuedAt にリクエスト値を渡す余地が無い（発行側）', () => {
    // 発行 API は `now` を**オプションで**受けるだけで、Request を受け取らない。
    // 型の形そのものが「リクエスト由来の値が入り込む経路」を狭めている。
    const payload = newFormSessionPayload({ now: NOW })
    expect(payload.issuedAt).toBe(NOW)
  })
})
