import { describe, it, expect } from 'vitest'
import { parseServerEnv, serverEnvSchema } from '@/lib/env'

// サーバー env スキーマ（tech-stack §4.5）のスモークテスト。
describe('server env schema', () => {
  it('想定キー一式を受理する', () => {
    const parsed = parseServerEnv({
      POSTGRES_URL: 'postgres://user:pass@host:5432/db',
      POSTGRES_URL_NON_POOLING: 'postgres://user:pass@host:5432/db',
      POSTGRES_PRISMA_URL: 'postgres://user:pass@host:5432/db?pgbouncer=true',
      BLOB_READ_WRITE_TOKEN: 'blob-token',
      KV_REST_API_URL: 'https://kv.example.com',
      KV_REST_API_TOKEN: 'kv-token',
      AUTH_SECRET: 'secret',
      RESEND_API_KEY: 'resend-key',
    })
    expect(parsed.POSTGRES_URL).toContain('postgres://')
    expect(parsed.AUTH_SECRET).toBe('secret')
  })

  it('import 時に throw しない（値未設定でも parse は空で成功）', () => {
    expect(() => serverEnvSchema.parse({})).not.toThrow()
  })

  it('不正な URL は拒否する', () => {
    const result = serverEnvSchema.safeParse({ POSTGRES_URL: 'not-a-url' })
    expect(result.success).toBe(false)
  })
})

/**
 * SEC-013 / RV-P2-002 — 本番 AUTH_SECRET の起動時強度検証。
 *
 * 契約: `parseServerEnv(source)` は **source 自身の `NODE_ENV`** を見て本番判定する（純関数のまま
 * 保つため。`getServerEnv()` は `process.env` を渡すので本番でも同じ判定になる）。
 *  - NODE_ENV='production' かつ AUTH_SECRET 未設定 → 検証エラー
 *  - NODE_ENV='production' かつ 32文字未満 → 検証エラー（`openssl rand -base64 32` は44文字）
 *  - NODE_ENV='production' かつ 32文字以上 → 成功
 *  - production 以外（development / 未指定）→ 従来どおり optional（開発体験を壊さない）
 *
 * red 理由: lib/env.ts:25 は `AUTH_SECRET: z.string().min(1).optional()` のままで本番判定も
 * 長さ下限も無いため、production 系の3ケースが「throw するはずが throw しない」で落ちる。
 *
 * 注: エラーメッセージに 'AUTH_SECRET' が含まれることも契約に含める（zod の issue path でも可）。
 * 運用者が原因を特定できないと fail-fast の価値が半減するため。
 */
describe('SEC-013: 本番 AUTH_SECRET の強度検証', () => {
  // 32文字ちょうど（境界値）と 31文字（境界の直下）。実運用の秘密ではないダミー。
  const SECRET_32 = 'A'.repeat(32)
  const SECRET_31 = 'A'.repeat(31)
  const SECRET_BASE64_44 = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo='
  /**
   * P3-a 以降、production では KV / フォームセッション / cron のキーも fail-fast の対象になった
   * （AC-010-10 / AC-RL-13 / AC-PII-10。`tests/unit/env-p3a-fail-fast.test.ts` が本体を検証する）。
   * **本 describe の対象は AUTH_SECRET の長さ**なので、他のキーは満たした状態を土台にして
   * 検証対象を1つに保つ。
   */
  // P3-b で Turnstile の2キーも本番必須へ昇格した（`env-p3b-fail-fast.test.ts` が本体を検証する）。
  const P3A_REQUIRED = {
    KV_REST_API_URL: 'https://example-kv.upstash.io',
    KV_REST_API_TOKEN: 'kv-token-value',
    FORM_SESSION_SECRET: 'F'.repeat(44),
    CRON_SECRET: 'C'.repeat(44),
    TURNSTILE_SECRET: 'T'.repeat(44),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAA_site_key',
  }

  it('production かつ AUTH_SECRET 未設定は検証エラー', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/)
  })

  it('production かつ 空文字は検証エラー', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production', AUTH_SECRET: '' })).toThrow(
      /AUTH_SECRET/,
    )
  })

  it('production かつ 32文字未満（境界値 31）は検証エラー', () => {
    expect(() =>
      parseServerEnv({ NODE_ENV: 'production', AUTH_SECRET: SECRET_31 }),
    ).toThrow(/AUTH_SECRET/)
  })

  it('production かつ 32文字ちょうど（境界値）は成功', () => {
    const parsed = parseServerEnv({
      ...P3A_REQUIRED,
      NODE_ENV: 'production',
      AUTH_SECRET: SECRET_32,
    })
    expect(parsed.AUTH_SECRET).toBe(SECRET_32)
  })

  it('production かつ openssl rand -base64 32 相当（44文字）は成功', () => {
    const parsed = parseServerEnv({
      ...P3A_REQUIRED,
      NODE_ENV: 'production',
      AUTH_SECRET: SECRET_BASE64_44,
      POSTGRES_URL: 'postgres://user:pass@host:5432/db',
    })
    expect(parsed.AUTH_SECRET).toBe(SECRET_BASE64_44)
  })

  it('development では AUTH_SECRET 未設定でも通る（既存の開発体験を壊さない）', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'development' })).not.toThrow()
  })

  it('development では短い AUTH_SECRET（.env のダミー値）でも通る', () => {
    const parsed = parseServerEnv({
      NODE_ENV: 'development',
      AUTH_SECRET: 'dev-only-secret-change-me',
    })
    expect(parsed.AUTH_SECRET).toBe('dev-only-secret-change-me')
  })

  it('NODE_ENV 未指定（test 実行時など）は従来どおり通る', () => {
    expect(() => parseServerEnv({ AUTH_SECRET: 'secret' })).not.toThrow()
    expect(() => parseServerEnv({})).not.toThrow()
  })
})
