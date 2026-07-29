import { describe, it, expect } from 'vitest'
import { parseServerEnv } from '@/lib/env'

/**
 * =========================================================================
 * P3-b — P3b-3（SEC-046）+ Turnstile の本番 fail-fast 昇格
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §E P3b-3（:2611）/ SEC-046 の更新（:2629）、
 *       `docs/phase-status.md` P3-b 完了条件（`NEXT_PUBLIC_TURNSTILE_SITE_KEY` /
 *       `TURNSTILE_SECRET` を本番 fail-fast 対象へ昇格 / :315）、`lib/env.ts` の既存注記（:83-84）。
 *
 * > **P3b-3**: `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限を32文字に
 * > （**縮退時に残る唯一の Tier D 軸が Cookie 軸になったため、鍵が弱いと軸そのものが偽造で無効化される**）
 *
 * `lib/env.ts` は現在 `z.string().min(1).optional()` で、本番必須は満たすが**長さ下限が無い**。
 * 1文字の `FORM_SESSION_SECRET` でも起動できる状態は、AC-RL-13 の Cookie 軸を無意味にする。
 */

const STRONG = 'a'.repeat(32)

function productionEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    AUTH_SECRET: 'auth-secret-'.padEnd(40, 'x'),
    KV_REST_API_URL: 'https://kv.example.com',
    KV_REST_API_TOKEN: 'kv-token',
    FORM_SESSION_SECRET: `form-${STRONG}`,
    CRON_SECRET: `cron-${STRONG}`,
    TURNSTILE_SECRET: `ts-${STRONG}`,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAA_site_key',
    ...overrides,
  }
}

describe('P3b-3 / SEC-046: 本番の secret 長さ下限は 32 文字', () => {
  it('正しく設定された本番 env は通る（土台）', () => {
    expect(() => parseServerEnv(productionEnv())).not.toThrow()
  })

  it.each([
    ['FORM_SESSION_SECRET', 'FORM_SESSION_SECRET'],
    ['CRON_SECRET', 'CRON_SECRET'],
  ])('%s が 31 文字なら本番で throw する', (_label, key) => {
    // これが green なら排除される攻撃:
    //  - `FORM_SESSION_SECRET` が弱いと、攻撃者は Cookie を**自分で署名して量産**できる。
    //    SEC-043 の是正により**縮退時に残る唯一の Tier D 軸が Cookie 軸**になったため、
    //    鍵の総当たりは「レート制限そのものの無効化」を意味する（監査 SEC-046 の更新理由）。
    //  - `CRON_SECRET` が弱いと、**未認証の削除エンドポイント**（保持期間バッチ）に到達される。
    expect(() => parseServerEnv(productionEnv({ [key]: 'a'.repeat(31) }))).toThrow()
  })

  it.each([['FORM_SESSION_SECRET'], ['CRON_SECRET']])(
    '%s がちょうど 32 文字なら通る（境界）',
    (key) => {
      expect(() => parseServerEnv(productionEnv({ [key]: 'a'.repeat(32) }))).not.toThrow()
    },
  )

  it('非本番では短い secret でも throw しない（開発体験を壊さない）', () => {
    // 過剰な必須化は「本番以外でも env を用意する」運用コストを生み、
    // 最終的に**テスト用の弱い値を本番へ持ち込む**動機になる。既存方針（`lib/env.ts:72`）を維持する。
    expect(() =>
      parseServerEnv({ NODE_ENV: 'development', FORM_SESSION_SECRET: 'x', CRON_SECRET: 'y' }),
    ).not.toThrow()
  })
})

describe('P3-b: Turnstile を本番 fail-fast 対象へ昇格する', () => {
  it.each([['TURNSTILE_SECRET'], ['NEXT_PUBLIC_TURNSTILE_SITE_KEY']])(
    '%s が未設定なら本番で throw する',
    (key) => {
      // 出典: `docs/phase-status.md` P3-b 完了条件。
      // これが green なら排除される事故: Turnstile 未設定のまま `/apply` を本番公開すること。
      // `verifyTurnstile` は fail-closed（秘密鍵が無ければ false）なので**全送信が Tier B になる**か、
      // 逆に「未設定なら検証をスキップ」と書かれていれば**CAPTCHA が丸ごと消える**。
      // どちらも起動時に落とすべき状態であり、「起動はするが防御が消える」形（`lib/env.ts:83`）である。
      expect(() => parseServerEnv(productionEnv({ [key]: undefined }))).toThrow()
    },
  )

  it('P3-a で必須化された 4 キー（KV 2本 / FORM_SESSION_SECRET / CRON_SECRET）は退行していない', () => {
    // 既存の本番 fail-fast を P3-b の変更で壊していないことの確認（退行防止）。
    for (const key of [
      'KV_REST_API_URL',
      'KV_REST_API_TOKEN',
      'FORM_SESSION_SECRET',
      'CRON_SECRET',
    ]) {
      expect(() => parseServerEnv(productionEnv({ [key]: undefined })), key).toThrow()
    }
  })

  it('鍵の用途分離（FORM_SESSION_SECRET === AUTH_SECRET を禁止）も退行していない', () => {
    const shared = 'shared-secret-'.padEnd(40, 'z')
    expect(() =>
      parseServerEnv(productionEnv({ AUTH_SECRET: shared, FORM_SESSION_SECRET: shared })),
    ).toThrow()
  })

  it('FORM_SESSION_SECRET と CRON_SECRET も相互に同一値を禁止する', () => {
    // これが green なら排除される事故: 1つの値をすべての用途に使い回す運用。
    // **片方の漏えいが「Cookie 偽造」と「削除バッチの起動」の両方に波及する。**
    // 既存の AUTH_SECRET との分離（`lib/env.ts:101`）と同じ原則を、増えた鍵にも適用する。
    const shared = `shared-${STRONG}`
    expect(() =>
      parseServerEnv(productionEnv({ FORM_SESSION_SECRET: shared, CRON_SECRET: shared })),
    ).toThrow()
  })
})
