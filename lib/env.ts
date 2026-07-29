import { z } from 'zod'

/**
 * サーバー環境変数の zod スキーマ（tech-stack §4.5）。
 * すべてサーバー限定・クライアント非公開。DBアクセス経路はサーバーに閉じる（§1.2）。
 *
 * 検証は遅延実行（getServerEnv）とし、import 時点では throw しない。
 * これによりビルド／単体テストが env 未設定でも失敗しない（値は feature 実装／デプロイ時に必須化）。
 */
/** 本番 AUTH_SECRET の最小長。`openssl rand -base64 32` は 44 文字なので余裕を持って満たす。 */
const AUTH_SECRET_MIN_LENGTH = 32

/**
 * 本番の共有秘密の最小長（P3b-3 / SEC-046）。
 *
 * **`FORM_SESSION_SECRET` が弱いと、攻撃者は Cookie を自分で署名して量産できる。**
 * SEC-043 の是正により**縮退構成（`trusted=false`）で残る唯一の Tier D 軸が Cookie 軸**に
 * なったため、鍵の総当たりは「レート制限そのものの無効化」を意味する。
 * `CRON_SECRET` が弱いと**未認証の削除エンドポイント**（保持期間バッチ）に到達される。
 */
const SHARED_SECRET_MIN_LENGTH = 32

const serverEnvShape = z.object({
  // 実行環境。**本番判定は source 自身の NODE_ENV で行う**（parseServerEnv を純関数のまま保つため。
  // getServerEnv() は process.env をそのまま渡すので本番挙動は変わらない）。
  // zod は未定義キーを strip するため、参照するには明示的な宣言が必要。
  NODE_ENV: z.string().optional(),
  // --- Vercel Postgres ---
  POSTGRES_URL: z.string().url().optional(),
  POSTGRES_URL_NON_POOLING: z.string().url().optional(),
  POSTGRES_PRISMA_URL: z.string().url().optional(),
  // --- Vercel Blob（免許証写真・非公開）---
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  // --- Vercel KV（レート制限・Upstash Redis）---
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().min(1).optional(),
  KV_REST_API_READ_ONLY_TOKEN: z.string().min(1).optional(),
  // --- 認証（Auth.js）---
  // AUTH_SECRET: JWT セッション署名鍵。NextAuth v5 が自動参照する（F-012）。
  // スキーマ上は optional（development / test の開発体験を壊さない）。本番の必須化と長さ下限は
  // 下の superRefine が担う（SEC-013 / RV-P2-002）。
  AUTH_SECRET: z.string().min(1).optional(),
  // --- スパム対策 / メール ---
  TURNSTILE_SECRET: z.string().min(1).optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  // --- 公開フォーム（P3-a で本番 fail-fast 対象へ。tech-stack §4.6）---
  // FORM_SESSION_SECRET: フォームセッション Cookie の署名鍵（AC-RL-13）。
  // CRON_SECRET: 保持期間 / orphan 回収バッチの起動認可（AC-PII-10）。
  FORM_SESSION_SECRET: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  /*
   * --- 信頼境界（SEC-061 / SEC-069 / P3c-5）---
   * TRUST_PROXY: 前段プロキシの転送ヘッダを信頼するか。**非 Vercel 本番のための唯一の手段**。
   *
   * `lib/http-guard.ts` と `docs/tech-stack.md` §4.5 は「Vercel 以外へ配置する場合は
   * `trustProxy` を必ず有効化すること」と指示していたが、**その手段が存在しなかった**
   * （SEC-069 の本体は文書と実装の食い違い）。したがって非 Vercel 本番は永続的に
   * `trusted=false`（縮退構成）で、SEC-057 の残余と SEC-067 の両方を抱えたまま運用される。
   *
   * **受理する値を '1'|'true'|'0'|'false' に限り、それ以外は起動時に落とす。**
   * `TRUST_PROXY=yes` を黙って false に倒すと、運用者は「設定したのに直らない」状態を
   * **気付かないまま**縮退で運用し続ける——これは SEC-069 が問題にした誤認そのものである。
   * 未設定は false（fail-closed）。既定 true は、前段が XFF を上書きしない構成で
   * **クライアントが自分の IP を名乗れる**状態を作るので採らない。
   */
  TRUST_PROXY: z
    .enum(['1', 'true', '0', 'false'], {
      errorMap: () => ({
        message:
          "TRUST_PROXY は '1' / 'true' / '0' / 'false' のいずれかで指定してください" +
          '（解釈できない値を黙って false に倒すと、設定したつもりのまま縮退構成で運用され続ける / SEC-069）',
      }),
    })
    .optional()
    .transform((raw) => raw === '1' || raw === 'true'),
})

/** 本番で未設定なら起動を止めるキーと、その理由（AC-010-10 / AC-RL-13 / AC-PII-10）。 */
const PRODUCTION_REQUIRED_KEYS = [
  {
    key: 'KV_REST_API_URL',
    reason:
      'KV 未設定のまま起動するとレート制限とセマフォが黙って無効化される（インメモリへ落ちると' +
      'インスタンスごとに別カウンタになり全体流量制御にならない）',
  },
  {
    key: 'KV_REST_API_TOKEN',
    reason: '同上（SEC-033 / AC-010-10）',
  },
  {
    key: 'FORM_SESSION_SECRET',
    reason: 'Cookie 署名鍵が無いと AC-RL-13(b) の必須化が成立しない',
  },
  {
    key: 'CRON_SECRET',
    reason: '未設定のまま /api/cron/** を公開すると未認証の削除エンドポイントになる（AC-PII-10）',
  },
  /*
   * P3-b で昇格（`docs/phase-status.md` P3-b 完了条件 / `tech-stack.md` §4.6）。
   * Turnstile 未設定のまま `/apply` を本番公開すると、`verifyTurnstile` が fail-closed なので
   * **全送信が Tier B になる**か、逆に「未設定なら検証をスキップ」と書かれていれば
   * **CAPTCHA が丸ごと消える**。どちらも「起動はするが防御が消える」形である。
   */
  {
    key: 'TURNSTILE_SECRET',
    reason: '未設定だと Turnstile 検証が成立せず、全送信が Tier B に落ちるか CAPTCHA が消える',
  },
  {
    key: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    reason: 'ウィジェットを描画できず、利用者が Tier B から回復する手段を失う',
  },
] as const satisfies ReadonlyArray<{ key: keyof z.infer<typeof serverEnvShape>; reason: string }>

/**
 * SEC-013 / RV-P2-002: 本番のみ AUTH_SECRET の存在と強度を検証する。
 * 弱い/未設定の署名鍵は JWT セッションの偽造（＝管理画面の乗っ取り）に直結するため、
 * 起動時に fail-fast させる。development / test では従来どおり optional。
 */
export const serverEnvSchema = serverEnvShape.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < AUTH_SECRET_MIN_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_SECRET'],
      message: `AUTH_SECRET は本番環境では ${AUTH_SECRET_MIN_LENGTH} 文字以上が必要です（openssl rand -base64 32）`,
    })
  }

  /*
   * P3-a: いずれも「**起動はするが防御が消える**」形の失敗であり、動いてしまうことが最も危険なので
   * 起動時に落とす（AC-010-10 / SEC-033）。**Turnstile は P3-b、Blob は P3-c で昇格**させる
   * ——ここで先に必須化すると、対象機能が無い P3-a のデプロイが理由なく落ちる。
   */
  for (const { key, reason } of PRODUCTION_REQUIRED_KEYS) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} は本番環境では必須です（${reason}）`,
      })
    }
  }

  /*
   * 鍵の用途分離（tech-stack §4.6）。同一鍵を Cookie 署名とセッション JWT 署名に使うと、
   * **片方の漏えいが両方に波及する**。導出元を共有するのは可だが、その場合も導出ラベルを分ける
   * （`lib/form-session.ts` の HKDF）。文書だけでは運用で守られないため検証可能な形にする。
   */
  if (env.FORM_SESSION_SECRET && env.FORM_SESSION_SECRET === env.AUTH_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FORM_SESSION_SECRET'],
      message: 'FORM_SESSION_SECRET に AUTH_SECRET と同一の値を流用できません（鍵の用途分離）',
    })
  }

  /*
   * P3b-3 / SEC-046: 本番の共有秘密は 32 文字以上。
   * `z.string().min(1)` のままだと 1 文字の `FORM_SESSION_SECRET` でも起動でき、
   * AC-RL-13 の Cookie 軸（縮退時に残る唯一の Tier D 軸）が偽造で無効化される。
   */
  for (const key of ['FORM_SESSION_SECRET', 'CRON_SECRET'] as const) {
    const value = env[key]
    if (value && value.length < SHARED_SECRET_MIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} は本番環境では ${SHARED_SECRET_MIN_LENGTH} 文字以上が必要です（SEC-046）`,
      })
    }
  }

  /*
   * 増えた鍵にも用途分離の原則を適用する。1 つの値を使い回すと、
   * **片方の漏えいが「Cookie 偽造」と「削除バッチの起動」の両方に波及する。**
   */
  if (env.FORM_SESSION_SECRET && env.FORM_SESSION_SECRET === env.CRON_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CRON_SECRET'],
      message: 'CRON_SECRET に FORM_SESSION_SECRET と同一の値を流用できません（鍵の用途分離）',
    })
  }
  if (env.CRON_SECRET && env.CRON_SECRET === env.AUTH_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CRON_SECRET'],
      message: 'CRON_SECRET に AUTH_SECRET と同一の値を流用できません（鍵の用途分離）',
    })
  }

  /*
   * P3b-2: **実プラットフォーム上（Vercel）では KV の実接続を強制する。**
   *
   * ローカル / E2E も `next start` すなわち `NODE_ENV=production` で回るため、`KV_*` の
   * 「存在」だけを条件にすると、実在しないホストを書いたまま起動できてしまう
   * （P3-a まではそれで問題が無かった。KV を実際に叩く経路が無かったため）。
   * P3-b で公開エンドポイントが KV を叩くようになったので、`lib/runtime-stores.ts` は
   * `https://` 以外の `KV_REST_API_URL` を「インメモリで動かす」宣言として扱う。
   * **その抜け道が本物の本番へ漏れないよう、ここで塞ぐ**——`VERCEL === '1'` は
   * `resolveClientIp` の `trustProxy` と同じ「実際にプラットフォーム上か」の signal である。
   */
  if (process.env.VERCEL === '1' && env.KV_REST_API_URL && !env.KV_REST_API_URL.startsWith('https://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KV_REST_API_URL'],
      message:
        'KV_REST_API_URL は本番（Vercel）では https:// の Upstash REST エンドポイントが必要です' +
        '（https 以外はインメモリへ縮退し、インスタンスごとに別カウンタ＝全体流量制御にならない）',
    })
  }
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

/** 任意のソース（テスト用モックなど）を検証する純関数。 */
export function parseServerEnv(source: Record<string, unknown> = process.env): ServerEnv {
  return serverEnvSchema.parse(source)
}

let cached: ServerEnv | undefined

/** アプリ実行時に検証済み env を取得（1回だけ parse してキャッシュ）。 */
export function getServerEnv(): ServerEnv {
  if (!cached) {
    cached = parseServerEnv()
  }
  return cached
}
