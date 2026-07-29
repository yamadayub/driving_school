import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter } from '@/lib/rate-limit'
import { withPublicMutation } from '@/lib/public-guard'
import {
  FORM_SESSION_COOKIE_NAME,
  createFormSessionValue,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { seededRandom } from './helpers/seeded-random'

/**
 * =========================================================================
 * P3-a 差し戻し修正 — SEC-042（High）のラッパ側
 * 「Tier B の判定材料が壊れていても 500 にしない」
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` SEC-042 修正方針
 * > 併せて、**`withPublicMutation` が `verifyFormSession` / `formSessionKey` の例外を握って
 * > Tier B に落とす**こと（供給者が例外を投げない前提に寄りかからない）。
 *
 * ## なぜラッパ側にも必要か
 * `lib/form-session.ts` を直せば今回の `RangeError` は消える。しかし
 * **「Tier B の判定関数が例外を投げたら 500 になる」という構造自体**は残る。
 * この判定材料（Cookie）は攻撃者が完全に制御でき、P3-b 以降で判定は複雑化する
 * （Turnstile 検証・送信間隔・ハニーポット）。**壊れた入力が失敗ではなく劣化になる**ことは
 * ラッパの契約であり、供給者ごとに担保する形にはしない。
 *
 * ## red 理由
 * `lib/public-guard.ts:210` は `verifyFormSession` を try/catch しておらず、例外がラッパの外へ抜ける
 * （Next.js の Route Handler では 500）。
 */

const ORIGIN = 'https://example.test'
const T0 = 1_800_000_000_000
const SECRET = 'b'.repeat(44)

function request(cookie?: string) {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
  if (cookie) headers.set('cookie', cookie)
  return new Request(`${ORIGIN}/api/applications`, { method: 'POST', headers, body: '{}' })
}

function okHandler() {
  return vi.fn(async () => new Response(JSON.stringify({ id: 'app_1' }), { status: 201 }))
}

const baseOptions = () => ({
  endpoint: 'applications' as const,
  requireContentType: 'json' as const,
  now: () => T0,
  random: seededRandom(11),
  clientIp: () => ({ key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' as const }),
})

describe('SEC-042: Tier B の判定が例外を投げても 500 にせず Tier B に落とす', () => {
  it('verifyFormSession が throw したら 403 { challenge } を返す（例外を外へ出さない）', async () => {
    // これが green なら排除される攻撃: 攻撃者が Cookie を細工して Tier B の判定関数を
    // 例外にし、**未認証で任意に 500 を発生させる**こと（エラーレート汚染・監視の誤報）。
    const handler = okHandler()
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      verifyFormSession: () => {
        throw new RangeError('Input buffers must have the same byte length')
      },
    })

    const response = await guarded(request(`${FORM_SESSION_COOKIE_NAME}=broken`), undefined)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(handler, '判定不能なリクエストで本体を実行しない').not.toHaveBeenCalled()
  })

  it('formSessionKey が throw しても 500 にしない（Tier D 軸の材料も攻撃者が制御する）', async () => {
    const guarded = withPublicMutation(okHandler(), {
      ...baseOptions(),
      limiters: { formSession: createRateLimiter({ limit: 5, windowMs: 60_000 }) },
      formSessionKey: () => {
        throw new TypeError('cookie parse failed')
      },
    })

    const response = await guarded(request(`${FORM_SESSION_COOKIE_NAME}=broken`), undefined)
    expect(response.status, '例外は Tier B へ落とす（500 にしない）').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
  })

  it('例外由来の Tier B は正常な Tier B と応答が完全に一致する（降格理由を漏らさない）', async () => {
    // これが green なら排除される壊れた実装: 例外時だけ本文やヘッダを変える実装。
    // bot に「どの入力が内部エラーを起こすか」を教えることになる（AC-RL-12(d)）。
    const responses: Array<{ status: number; body: string; headers: string[][] }> = []
    for (const verifyFormSession of [
      () => false,
      () => {
        throw new Error('boom')
      },
    ]) {
      const response = await withPublicMutation(okHandler(), {
        ...baseOptions(),
        verifyFormSession,
      })(request(`${FORM_SESSION_COOKIE_NAME}=x`), undefined)
      responses.push({
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()].filter(([name]) => name !== 'date').sort(),
      })
    }
    expect(responses[1]).toEqual(responses[0])
  })

  it('実物の verifyFormSessionValue に細工した Cookie を通しても 403（結合の形で固定する）', async () => {
    // 監査 G-5b の再現。lib/form-session.ts と lib/public-guard.ts のどちらを直しても
    // 片方だけでは足りない、という関係をこの1本で固定する。
    const valid = createFormSessionValue({ sid: 'sid-0123456789abcdef', issuedAt: T0 }, SECRET)
    const [payloadPart, signature] = valid.split('.')
    const crafted = `${payloadPart}.é${signature.slice(1)}`

    const handler = okHandler()
    const guarded = withPublicMutation(handler, {
      ...baseOptions(),
      verifyFormSession: (req, now) => {
        const cookie = req.headers.get('cookie') ?? ''
        const value = cookie.split('; ').find((item) => item.startsWith(`${FORM_SESSION_COOKIE_NAME}=`))
        return verifyFormSessionValue(value?.split('=')[1] ?? null, SECRET, now) !== null
      },
    })

    const response = await guarded(request(`${FORM_SESSION_COOKIE_NAME}=${crafted}`), undefined)
    expect(response.status, '1文字のマルチバイト置換で 500 にならないこと').toBe(403)
    expect(await response.json()).toEqual({ challenge: 'interactive' })
    expect(handler).not.toHaveBeenCalled()
  })
})
