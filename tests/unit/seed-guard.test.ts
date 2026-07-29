import { describe, it, expect } from 'vitest'
import { assertSeedAllowed } from '@/lib/seed-guard'

/**
 * SEC-012 — seed の本番ガードと管理者資格情報の fail-fast。
 *
 * 現状の欠陥（prisma/seed.ts:507-509, 516-522）:
 *  1. `ADMIN_PASSWORD` 等が未設定だと**警告もエラーも出さず**リポジトリ内の既知値
 *     （`admin_dev_pw`）へフォールバックする。`upsert` の update 節は既存管理者のパスワードも
 *     上書きするため、正しく運用されていたアカウントを既知パスワードへ降格させうる。
 *  2. `main()` 冒頭が Course/News/Faq/SupplementalChatRule を `deleteMany()` で全削除するにも
 *     かかわらず、`NODE_ENV` や接続先 DB のガードが無い。本番へ向けて実行すると公開コンテンツ全損。
 *
 * seed スクリプト自体は副作用（DB 接続・全削除）を伴い直接テストできないため、**ガード判定を
 * 純関数として切り出す**前提で契約を規定する。Impl Agent が `lib/seed-guard.ts` を作り、
 * `prisma/seed.ts` は冒頭で `assertSeedAllowed(process.env)` を呼んで戻り値の資格情報を使う
 * （＝ seed.ts 内のハードコードフォールバックは削除する）。
 *
 * 契約:
 *   export interface SeedEnvSource {
 *     NODE_ENV?: string; ADMIN_EMAIL?: string; ADMIN_NAME?: string;
 *     ADMIN_PASSWORD?: string; ALLOW_PROD_SEED?: string;
 *   }
 *   export interface SeedCredentials { email: string; name: string; password: string }
 *   export function assertSeedAllowed(env: SeedEnvSource): SeedCredentials
 *
 *   - NODE_ENV='production' かつ ALLOW_PROD_SEED が未設定/'1' 以外 → throw（本番実行そのものを拒否）
 *   - ADMIN_EMAIL / ADMIN_PASSWORD のいずれかが未設定（空文字含む）→ throw（フォールバック廃止）
 *   - 上記を満たせば資格情報を返す。ADMIN_NAME のみ既定値可（秘密ではないため）。
 *
 * 「development では通る」の解釈（要明記）: タスク指示の「development では通る」は
 * **production ガードに引っかからない**という意味に解する。SEC-012 修正方針1（フォールバック廃止・
 * 未設定なら throw）は環境を問わず適用しなければ欠陥が残るため、development でも資格情報が
 * 未設定なら throw する契約とした。ローカルの `.env` は ADMIN_EMAIL/ADMIN_PASSWORD を設定済みの
 * ため `pnpm db:seed` は従来どおり動作する（開発体験を壊さない）。
 *
 * red 理由: `lib/seed-guard.ts` が存在しないため import 解決に失敗する（Failed to resolve import）。
 */
const VALID_DEV = {
  NODE_ENV: 'development',
  ADMIN_EMAIL: 'admin@iwataki-driving-school.demo',
  ADMIN_NAME: 'デモ管理者',
  ADMIN_PASSWORD: 'admin_dev_pw',
}

describe('SEC-012: assertSeedAllowed — 本番実行ガード', () => {
  it('production かつ ALLOW_PROD_SEED 未設定は throw（deleteMany の破壊性を遮断）', () => {
    expect(() =>
      assertSeedAllowed({
        NODE_ENV: 'production',
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'a-strong-unique-password',
      }),
    ).toThrow(/production|本番/i)
  })

  it('production かつ ALLOW_PROD_SEED が "1" 以外なら throw', () => {
    expect(() =>
      assertSeedAllowed({
        NODE_ENV: 'production',
        ALLOW_PROD_SEED: '0',
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'a-strong-unique-password',
      }),
    ).toThrow(/production|本番/i)
  })

  it('production かつ ALLOW_PROD_SEED=1 でも ADMIN_PASSWORD 未設定なら throw', () => {
    expect(() =>
      assertSeedAllowed({
        NODE_ENV: 'production',
        ALLOW_PROD_SEED: '1',
        ADMIN_EMAIL: 'admin@example.com',
      }),
    ).toThrow(/ADMIN_PASSWORD/)
  })

  it('production かつ ALLOW_PROD_SEED=1 で資格情報が揃っていれば通る（明示オプトイン）', () => {
    const creds = assertSeedAllowed({
      NODE_ENV: 'production',
      ALLOW_PROD_SEED: '1',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_NAME: '管理者',
      ADMIN_PASSWORD: 'a-strong-unique-password',
    })
    expect(creds).toEqual({
      email: 'admin@example.com',
      name: '管理者',
      password: 'a-strong-unique-password',
    })
  })
})

describe('SEC-012: assertSeedAllowed — 資格情報の fail-fast（ハードコードフォールバック廃止）', () => {
  it('development で資格情報が揃っていれば通り、env の値をそのまま返す', () => {
    const creds = assertSeedAllowed(VALID_DEV)
    expect(creds.email).toBe(VALID_DEV.ADMIN_EMAIL)
    expect(creds.password).toBe(VALID_DEV.ADMIN_PASSWORD)
  })

  it('NODE_ENV 未指定（ローカル tsx 実行の既定）でも資格情報が揃っていれば通る', () => {
    expect(() =>
      assertSeedAllowed({
        ADMIN_EMAIL: VALID_DEV.ADMIN_EMAIL,
        ADMIN_PASSWORD: VALID_DEV.ADMIN_PASSWORD,
      }),
    ).not.toThrow()
  })

  it('ADMIN_PASSWORD 未設定は throw（既知値へ静かにフォールバックしない）', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'development', ADMIN_EMAIL: VALID_DEV.ADMIN_EMAIL }),
    ).toThrow(/ADMIN_PASSWORD/)
  })

  it('ADMIN_PASSWORD が空文字も throw', () => {
    expect(() =>
      assertSeedAllowed({ ...VALID_DEV, ADMIN_PASSWORD: '' }),
    ).toThrow(/ADMIN_PASSWORD/)
  })

  it('ADMIN_EMAIL 未設定は throw', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'development', ADMIN_PASSWORD: VALID_DEV.ADMIN_PASSWORD }),
    ).toThrow(/ADMIN_EMAIL/)
  })

  it('未設定時に既知のデモ資格情報を返さない（回帰防止: SEC-012 の本体）', () => {
    let returned: unknown
    try {
      returned = assertSeedAllowed({ NODE_ENV: 'development' })
    } catch {
      returned = undefined
    }
    expect(returned).toBeUndefined()
  })

  it('ADMIN_NAME のみ未設定なら既定の表示名で通る（秘密ではないため）', () => {
    const creds = assertSeedAllowed({
      NODE_ENV: 'development',
      ADMIN_EMAIL: VALID_DEV.ADMIN_EMAIL,
      ADMIN_PASSWORD: VALID_DEV.ADMIN_PASSWORD,
    })
    expect(creds.name).toBeTruthy()
  })
})
