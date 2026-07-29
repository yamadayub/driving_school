/**
 * seed 実行ガード（SEC-012）。
 *
 * `prisma/seed.ts` は冪等化のため Course/News/Faq/SupplementalChatRule を `deleteMany()` で
 * 全削除してから再投入する。本番 DB に向けて実行すると公開コンテンツが全損するため、
 * 実行可否の判定と管理者資格情報の解決を**副作用の無い純関数**として切り出す（seed 本体は
 * DB 接続を伴い直接テストできない）。
 *
 * 契約:
 *  - `NODE_ENV='production'` は既定で拒否。明示オプトイン `ALLOW_PROD_SEED='1'` のときのみ許可。
 *  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` が未設定（空文字含む）なら throw。
 *    **環境を問わず**適用する。リポジトリ内の既知値へ静かにフォールバックする旧実装は、
 *    `.env` を読み損ねたローカル/デモ環境を既知パスワードのまま公開してしまうため廃止した。
 *  - `ADMIN_NAME` は秘密ではないため既定値を許す。
 *
 * `prisma/seed.ts` は tsx 実行で `@/` エイリアスを解決しないため、seed からは相対パス
 * （`../lib/seed-guard`）で import する。
 */

export interface SeedEnvSource {
  NODE_ENV?: string
  ADMIN_EMAIL?: string
  ADMIN_NAME?: string
  ADMIN_PASSWORD?: string
  ALLOW_PROD_SEED?: string
}

export interface SeedCredentials {
  email: string
  name: string
  password: string
}

/** ADMIN_NAME 未設定時の表示名（秘密情報ではないため既定値で通す）。 */
export const DEFAULT_ADMIN_NAME = '管理者'

/**
 * seed 実行の可否を判定し、管理者資格情報を返す。実行不可なら throw（fail-fast）。
 * 呼び出しは `deleteMany()` より**前**に行うこと。
 */
export function assertSeedAllowed(env: SeedEnvSource): SeedCredentials {
  if (env.NODE_ENV === 'production' && env.ALLOW_PROD_SEED !== '1') {
    throw new Error(
      'seed-guard: NODE_ENV=production では seed を実行できません（本番データの全削除を防ぐため）。' +
        '意図的に実行する場合のみ ALLOW_PROD_SEED=1 を明示してください。',
    )
  }

  const email = env.ADMIN_EMAIL?.trim()
  if (!email) {
    throw new Error(
      'seed-guard: ADMIN_EMAIL が未設定です。.env に管理者ログインIDを設定してください' +
        '（既定値へのフォールバックは廃止しました）。',
    )
  }

  const password = env.ADMIN_PASSWORD
  if (!password) {
    throw new Error(
      'seed-guard: ADMIN_PASSWORD が未設定です。.env に推測困難なパスワードを設定してください' +
        '（既知のデモ値へのフォールバックは廃止しました）。',
    )
  }

  return {
    email,
    name: env.ADMIN_NAME?.trim() || DEFAULT_ADMIN_NAME,
    password,
  }
}
