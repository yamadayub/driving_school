import { describe, it, expect, vi } from 'vitest'
import { withPublicMutation, type PublicGuardOptions } from '@/lib/public-guard'
import { formSessionAxisKey } from '@/lib/form-session'
import { createRateLimiter, type RateLimiter } from '@/lib/rate-limit'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-c1 — **SEC-058 / P3c-2**: `withPublicMutation` の構築時検査を全構成へ広げる
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-2（:3262）
 *       「`limiters` / `formSessionKey` の**どちらか一方だけを渡した全構成**へ広げる。
 *         4 通りの構築時 throw をテストで固定」
 *       — **P3-c が新しい公開エンドポイント（写真アップロード）を作る前に**。
 *
 * ## なぜ P3-c の前でなければならないのか
 * P3-c は `uploads` という **2 つ目の公開変更系エンドポイント**を作る。
 * 現行の構築時検査は `if (limiters?.source)` を入口にしているため
 * （`lib/public-guard.ts:263`）、**`limiters.source` を書き忘れた構成は検査を丸ごと素通りする**。
 * すなわち「渡し忘れを構築時に落とす」という P3b-1 / SEC-053 の網は、
 * **最も渡し忘れやすい構成（source 自体の忘れ）に対して効いていない**。
 *
 * uploads の実装者が
 * ```ts
 * withPublicMutation(handler, {
 *   endpoint: 'uploads',
 *   limiters: { formSession: uploadLimiter },   // source を書き忘れた
 *   verifyFormSession: ...,
 * })
 * ```
 * と書くと、**`formSessionKey` が無いので formSession 軸は 1 度も作られず
 * （`lib/public-guard.ts:324` は両方揃ったときにしか軸を作らない）、
 * Tier D 軸が 1 つも存在しない公開アップロード口が、例外も警告も無く本番へ出る。**
 * 免許証写真の受け口でそれが起きると、SEC-057 の「無制限に DB 行」がそのまま
 * 「無制限にオブジェクトストレージへ書き込み」になる（監査 §F 理由 2）。
 *
 * ## red 理由（実装の現状）
 * `lib/public-guard.ts:263-276` の検査は `limiters?.source` が真のときにしか走らない。
 * 下表の **(c) / (d)** は現在 **throw しない**（＝ 2 件が red）。
 *
 * ## Impl が実装すべき契約（構成の全数表）
 *
 * | # | `limiters.source` | `limiters.formSession` | `formSessionKey` | 期待 |
 * |---|---|---|---|---|
 * | (0) | — | — | — | **throw しない**（Origin / Content-Type 検証だけに使う経路） |
 * | (a) | ✓ | — | — | throw（既存 / P3b-1） |
 * | (b) | ✓ | ✓ | — | throw（既存 / P3b-1） |
 * | (b') | ✓ | — | ✓ | throw（既存 / P3b-1） |
 * | **(c)** | — | ✓ | — | **throw（新規 / SEC-058）** |
 * | **(d)** | — | — | ✓ | **throw（新規 / SEC-058）** |
 * | (e) | — | ✓ | ✓ | throw しない（formSession 軸として完全。source を持たない口を禁じない） |
 * | (f) | ✓ | ✓ | ✓ | throw しない（本番の正しい配線） |
 *
 * **原則**: 「**軸は完成しているか、最初から無いか**のどちらかでなければならない。
 * 半分だけ渡した構成は静かに無効化されるので、構築時に落とす。」
 *
 * **同時に守ること**: (0) と (e) を throw させてはならない。
 * `lib/public-guard.ts:259-262` が自ら書いているとおり、**過剰な検査は
 * 「Impl が検査そのものを外す」動機**になる。検査は「半端な構成」だけを落とす。
 */

const ENDPOINT = 'applications' as const
const TRUSTED: ClientIpResolution = { key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' }

function okHandler() {
  return vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
}

const limiter = (): RateLimiter => createRateLimiter({ limit: 3, windowMs: 60_000 })

/** 検査対象の 3 つ以外は常に本番と同じ形で埋める（検査の入口を取り違えないため）。 */
function options(partial: Partial<PublicGuardOptions>): PublicGuardOptions {
  return {
    endpoint: ENDPOINT,
    requireContentType: 'json',
    verifyFormSession: () => true,
    clientIp: () => TRUSTED,
    ...partial,
  }
}

/* ========================================================================= *
 * SEC-058 (1): 新規に落とすべき 2 構成
 * ========================================================================= */

describe('SEC-058 / P3c-2: limiters か formSessionKey の片方だけを渡した構成は構築時に throw する', () => {
  it('(c) limiters.formSession だけ（source も formSessionKey も無い）は throw', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される事故: `uploads` の実装者が
    //   `limiters: { formSession: uploadLimiter }` とだけ書き、
    // `formSessionKey` を渡し忘れる。**軸は 1 つも作られない**（`lib/public-guard.ts:324` は
    // 両方揃ったときにしか push しない）ため、
    // **Tier D の無い公開アップロード口**が例外も警告も無く本番へ出る。
    // 現行の検査は `if (limiters?.source)` が入口なので、この構成を素通りさせる。
    expect(() =>
      withPublicMutation(okHandler(), options({ limiters: { formSession: limiter() } })),
    ).toThrow(/formSessionKey/i)
  })

  it('(d) formSessionKey だけ（limiters を丸ごと渡していない）は throw', () => {
    // これが green なら排除される事故: キー関数だけ渡して limiters を丸ごと忘れる
    //（「軸を渡した」と本人は思っているが、**軸は存在しない**）。
    // (c) と対称の穴であり、どちらも「半分だけの配線」である。
    expect(() =>
      withPublicMutation(okHandler(), options({ formSessionKey: formSessionAxisKey })),
    ).toThrow(/limiters/i)
  })
})

/* ========================================================================= *
 * SEC-058 (2): 既存の 3 構成が落ち続けること（P3b-1 の退行防止）
 * ========================================================================= */

describe('SEC-058 / P3b-1: 既に落ちている構成は落ち続ける（退行防止）', () => {
  it('(a) limiters.source だけ渡した構成は throw', () => {
    expect(() => withPublicMutation(okHandler(), options({ limiters: { source: limiter() } }))).toThrow(
      /formSession/i,
    )
  })

  it('(b) limiters.source + limiters.formSession（formSessionKey 無し）は throw', () => {
    expect(() =>
      withPublicMutation(
        okHandler(),
        options({ limiters: { source: limiter(), formSession: limiter() } }),
      ),
    ).toThrow(/formSessionKey/i)
  })

  it("(b') limiters.source + formSessionKey（limiters.formSession 無し）は throw", () => {
    expect(() =>
      withPublicMutation(
        okHandler(),
        options({ limiters: { source: limiter() }, formSessionKey: formSessionAxisKey }),
      ),
    ).toThrow(/formSession/i)
  })
})

/* ========================================================================= *
 * SEC-058 (3): **落としてはならない**構成（過剰な検査を作らない）
 * ========================================================================= */

describe('SEC-058: 正しい構成・軸を持たない構成は throw しない（検査を外す動機を作らない）', () => {
  it('(0) limiters も formSessionKey も渡さない構成は許す', () => {
    // ラッパを Origin / Content-Type 検証だけに使う経路。
    // ここを落とすと `lib/public-guard.ts:259-262` の警告どおり、
    // **Impl が検査そのものを削除する**方向へ動く。
    expect(() => withPublicMutation(okHandler(), options({}))).not.toThrow()
  })

  it('(e) limiters.formSession + formSessionKey（source 無し）は許す — 軸として完全である', () => {
    // 発信元軸を持たない公開エンドポイント（縮退構成では計数にしかならない軸なので、
    // 設計上あえて持たせない選択はありうる）を禁止しない。
    // **検査が禁じるのは「半端」であって「少ない」ではない。**
    expect(() =>
      withPublicMutation(
        okHandler(),
        options({ limiters: { formSession: limiter() }, formSessionKey: formSessionAxisKey }),
      ),
    ).not.toThrow()
  })

  it('(f) 本番と同じ完全な構成は許す', () => {
    expect(() =>
      withPublicMutation(
        okHandler(),
        options({
          limiters: { source: limiter(), formSession: limiter() },
          formSessionKey: formSessionAxisKey,
        }),
      ),
    ).not.toThrow()
  })
})

/* ========================================================================= *
 * SEC-058 (4): 例外メッセージが「どの構成が半端か」を指すこと
 * ========================================================================= */

describe('SEC-058: 例外メッセージは endpoint と欠けている項目を含む（次に読む人が直せる）', () => {
  it('endpoint 名を含む（複数の公開ルートができた後に、どれが壊れているか分かる）', () => {
    // P3-c で `uploads` が増えるので、**メッセージだけでどのルートか分かる**ことが要る。
    // これが green なら排除される事故: ビルドが落ちたが、どのルートの構成が原因か分からず
    // 「とりあえず検査を外す」修正が入ること。
    let message = ''
    try {
      withPublicMutation(okHandler(), options({ limiters: { formSession: limiter() } }))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message, '例外が投げられていない').not.toBe('')
    expect(message).toContain(ENDPOINT)
  })
})
