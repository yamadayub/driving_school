import { describe, it, expect } from 'vitest'
import { parseServerEnv } from '@/lib/env'

/**
 * =========================================================================
 * P3-a — AC-010-10（SEC-033）/ AC-PII-10: 本番の環境変数 fail-fast
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 AC-010-10:793 / AC-PII-10、
 *       `docs/tech-stack.md` v0.3.2 §4.6「本番 fail-fast の対象」。
 *
 * ## red 理由
 * `lib/env.ts` の `superRefine` は現在 `AUTH_SECRET` しか見ていない。
 * `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `FORM_SESSION_SECRET` / `CRON_SECRET` が
 * 未設定でも `parseServerEnv({ NODE_ENV: 'production', ... })` が成功するため、
 * 本ファイルの assertion が**実際に失敗する**（import エラーではない）。
 *
 * ## なぜ「起動時に落とす」ことが受け入れ条件なのか
 *  - KV 未設定のまま本番が起動すると、レート制限とセマフォが**黙って無効化**される
 *    （インメモリへフォールバックすれば、インスタンスごとに別カウンタ＝全体流量制御にならない）。
 *  - `CRON_SECRET` 未設定のまま `/api/cron/**` を公開すると、**未認証の削除エンドポイント**になる。
 *  - `FORM_SESSION_SECRET` 未設定だと Cookie 署名鍵が無く、AC-RL-13(b) の必須化が成立しない。
 *
 * いずれも「起動はするが防御が消える」形の失敗であり、**動いてしまうことが最も危険**である。
 */

const STRONG_SECRET = 'a'.repeat(44)

/**
 * 本番で必須になるキー一式（すべて満たした状態）。
 *
 * **P3-b で `TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` が必須へ昇格した**
 * （`docs/phase-status.md` P3-b 完了条件 / `tests/unit/env-p3b-fail-fast.test.ts` が本体を検証する）。
 * 本ファイルの検証対象は P3-a のキーなので、昇格したキーは土台側に足して検証対象を1つに保つ。
 * `BLOB_READ_WRITE_TOKEN` は P3-c で昇格するため、ここには入れない。
 */
const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  AUTH_SECRET: STRONG_SECRET,
  KV_REST_API_URL: 'https://example-kv.upstash.io',
  KV_REST_API_TOKEN: 'kv-token-value',
  FORM_SESSION_SECRET: 'b'.repeat(44),
  CRON_SECRET: 'c'.repeat(44),
  TURNSTILE_SECRET: 'd'.repeat(44),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAA_site_key',
} as const

describe('AC-010-10: 本番で KV 未設定なら起動時に落ちる（SEC-033）', () => {
  it('KV_REST_API_URL が無いと production では throw する', () => {
    const { KV_REST_API_URL: _omitted, ...source } = PRODUCTION_BASE
    expect(() => parseServerEnv(source)).toThrow(/KV_REST_API_URL/)
  })

  it('KV_REST_API_TOKEN が無いと production では throw する', () => {
    const { KV_REST_API_TOKEN: _omitted, ...source } = PRODUCTION_BASE
    expect(() => parseServerEnv(source)).toThrow(/KV_REST_API_TOKEN/)
  })

  it('development / test では KV 未設定でも throw しない（開発体験を壊さない）', () => {
    expect(() =>
      parseServerEnv({ NODE_ENV: 'development', AUTH_SECRET: 'dev-secret' }),
    ).not.toThrow()
    expect(() => parseServerEnv({ NODE_ENV: 'test' })).not.toThrow()
  })
})

describe('AC-RL-13: 本番で FORM_SESSION_SECRET 未設定なら起動時に落ちる', () => {
  it('FORM_SESSION_SECRET が無いと production では throw する', () => {
    const { FORM_SESSION_SECRET: _omitted, ...source } = PRODUCTION_BASE
    expect(() => parseServerEnv(source)).toThrow(/FORM_SESSION_SECRET/)
  })

  it('AUTH_SECRET と同一の値を FORM_SESSION_SECRET に流用できない（鍵の用途分離）', () => {
    // これが green なら排除される: `FORM_SESSION_SECRET = AUTH_SECRET` と設定する運用。
    // 同一鍵を Cookie 署名とセッション署名に使うと、片方の漏えいが両方に波及する
    //（`tech-stack.md` §4.6。導出元にするのは可だが、その場合も導出ラベルを分ける）。
    expect(() =>
      parseServerEnv({ ...PRODUCTION_BASE, FORM_SESSION_SECRET: STRONG_SECRET }),
    ).toThrow(/FORM_SESSION_SECRET/)
  })
})

describe('AC-PII-10: 本番で CRON_SECRET 未設定なら起動時に落ちる', () => {
  it('CRON_SECRET が無いと production では throw する', () => {
    // これが green なら排除される: `CRON_SECRET` 未設定のまま `/api/cron/**` を公開する構成
    //（＝ 未認証の削除エンドポイント）。
    const { CRON_SECRET: _omitted, ...source } = PRODUCTION_BASE
    expect(() => parseServerEnv(source)).toThrow(/CRON_SECRET/)
  })
})

describe('P3-a 時点で必須にしないキー（単位ごとの昇格）', () => {
  it('すべての P3-a 必須キーが揃っていれば production でも通る', () => {
    expect(() => parseServerEnv({ ...PRODUCTION_BASE })).not.toThrow()
  })

  it('Turnstile / Blob は P3-a では必須にしない（対象機能がまだ無い）', () => {
    // `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` は P3-b（/apply 公開時）、
    // `BLOB_READ_WRITE_TOKEN` は P3-c で必須へ昇格させる（`tech-stack.md` §4.6）。
    // ここで先に必須化すると、P3-a のデプロイが理由なく落ちる。
    expect(() => parseServerEnv({ ...PRODUCTION_BASE })).not.toThrow()
  })
})
