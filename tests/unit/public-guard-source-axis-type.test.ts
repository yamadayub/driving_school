import { describe, it, expect, expectTypeOf } from 'vitest'
import { rateLimitKey } from '@/lib/rate-limit'
import { sourceAxisFor, type PublicGuardOptions, type SourceAxis } from '@/lib/public-guard'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-a 差し戻し修正 — SEC-043 / RV-P3A-001 の「型で強制する」側
 * =========================================================================
 *
 * ## なぜ振る舞いのテストだけでは足りないのか（両レビュワーが明示した要求）
 * > 「警告をコメントに書く」ことは、呼び出し側が読まなければ機能しない。**型で強制する**
 * > （`ClientIpResolution` を分解せずに渡す API にする、`trusted` を必須引数にする）か、
 * > **テストで固定する**以外に、この型の再発を止める手段は無い。 — Security 監査 SEC-043
 *
 * `lib/http-guard.ts:86-94` は「`key` だけを取り出して `trusted` を捨てる呼び出しは、この防御を
 * 無効化する」と**名指しで警告していた**。それでも新しいラッパが `clientIp(request).key` を書いた。
 * したがって**同じ警告を書き足すのは対策にならない**。必要なのは「`.key` だけを使うと
 * `pnpm type-check` が落ちる」継ぎ目である。
 *
 * ## Impl が実装すべき型設計（この 3 点が本ファイルの契約）
 * ```ts
 * // lib/public-guard.ts
 * import type { ClientIpResolution } from '@/lib/http-guard'
 *
 * /** 発信元軸のゲート判断。`ClientIpResolution` **全体**からしか作れない。 *\/
 * export interface SourceAxis {
 *   readonly key: string
 *   /** この軸の `success:false` を 429 の理由に使ってよいか（`trusted === false` なら false）。 *\/
 *   readonly enforce: boolean
 * }
 * export function sourceAxisFor(
 *   endpoint: SemaphoreEndpoint,
 *   resolution: ClientIpResolution,   // ← string を受け取らない = `.key` だけでは呼べない
 * ): SourceAxis
 *
 * // オプションの戻り値型も `ClientIpResolution` そのものにする（分解して渡させない）
 * clientIp?: (request: Request) => ClientIpResolution
 * ```
 * Tier D のループは `SourceAxis` を経由してのみ per-source 軸を組み立てること
 * （`rateLimitKey(...)` を直接呼んで `enforce` を持たない軸を作れる形にしない）。
 *
 * ## red 理由
 * `sourceAxisFor` / `SourceAxis` が存在しないため import 解決に失敗する（実行時）。
 * さらに `pnpm type-check` でも未解決 export として落ちる。
 */

const ENDPOINT = 'applications' as const

describe('SEC-043: per-source 軸は ClientIpResolution 全体からしか作れない（型で強制する）', () => {
  it('trusted=true の解決結果からは enforce=true の軸ができる', () => {
    const axis = sourceAxisFor(ENDPOINT, {
      key: '198.51.100.5',
      trusted: true,
      source: 'x-forwarded-for',
    })
    expect(axis.key).toBe(rateLimitKey('applications:', '198.51.100.5'))
    expect(axis.enforce, '信頼できる発信元は攻撃者自身に閉じた軸＝ゲートに使える').toBe(true)
  })

  it('trusted=false の解決結果からは enforce=false の軸ができる', () => {
    // これが green なら排除される壊れた実装: 縮退の判定を呼び出し側の if 文に散らし、
    // 新しい呼び出し元が書き忘れる形（＝ SEC-043 の再発経路）。判定は 1 箇所に閉じる。
    const axis = sourceAxisFor(ENDPOINT, { key: 'unknown', trusted: false, source: 'unknown' })
    expect(axis.key, 'キー自体は作る（計数は続けるため）').toBe(
      rateLimitKey('applications:', 'unknown'),
    )
    expect(axis.enforce, '共有 unknown バケットは 429 の理由に使わない').toBe(false)
  })

  it('endpoint ごとにキー空間が分かれる（軸の混線を防ぐ）', () => {
    const applications = sourceAxisFor('applications', {
      key: '198.51.100.5',
      trusted: true,
      source: 'x-forwarded-for',
    })
    const uploads = sourceAxisFor('uploads', {
      key: '198.51.100.5',
      trusted: true,
      source: 'x-forwarded-for',
    })
    expect(applications.key).not.toBe(uploads.key)
  })
})

describe('SEC-043: 型の継ぎ目（これらが型エラーにならない実装は再発を止められない）', () => {
  it('`.key` だけ（string）では sourceAxisFor を呼べない', () => {
    // `pnpm type-check` 側の assertion。ここが「未使用の @ts-expect-error」になる実装
    // （＝ string を受け付けてしまう実装）は型チェックで落ちる。
    // @ts-expect-error — `trusted` を捨てた呼び出しは型エラーでなければならない
    expect(() => sourceAxisFor(ENDPOINT, 'unknown')).toBeTruthy()
    // @ts-expect-error — `trusted` を欠いた部分オブジェクトも受け付けてはならない
    expect(() => sourceAxisFor(ENDPOINT, { key: 'unknown' })).toBeTruthy()
  })

  it('SourceAxis は key と enforce を必ず持つ', () => {
    expectTypeOf<SourceAxis>().toHaveProperty('key')
    expectTypeOf<SourceAxis>().toHaveProperty('enforce')
    expectTypeOf<SourceAxis['enforce']>().toEqualTypeOf<boolean>()
  })

  it('PublicGuardOptions.clientIp は ClientIpResolution を返す（分解した形を許さない）', () => {
    // これが green なら排除される壊れた実装: `clientIp?: (r) => { key: string }` のように
    // `trusted` を落とした型へ緩めること（型が緩むと呼び出し側は再び `.key` だけを使える）。
    type ClientIp = NonNullable<PublicGuardOptions['clientIp']>
    expectTypeOf<ClientIp>().returns.toEqualTypeOf<ClientIpResolution>()
  })
})
