import { randomBytes } from 'node:crypto'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { authConfig } from '@/auth.config'
import { prisma } from '@/lib/db'
import { getServerEnv } from '@/lib/env'
import { hashPassword, verifyPassword } from '@/lib/password'
import { createRateLimiter } from '@/lib/rate-limit'
import { sharedRateLimitStore } from '@/lib/runtime-stores'
import { resolveClientIp, UNKNOWN_CLIENT_IP } from '@/lib/http-guard'
import { createLoginGuard, loginAccountKey, loginIpKey } from '@/lib/login-guard'

/**
 * F-012 管理者認証（Auth.js / NextAuth v5, Credentials 方式）。login.md 準拠。
 *
 * Node ランタイム専用の**完全な**設定（Edge 安全な authConfig を拡張し Credentials Provider を注入）。
 * middleware は auth.config.ts のみを使い、本ファイル（Prisma/node:crypto 依存）は import しない。
 *
 * セキュリティ:
 *  - authorize は AdminUser を email で検索し、`verifyPassword`（scrypt 定数時間比較）で照合。
 *  - 失敗（メール不在 / ハッシュ無し / パスワード不一致）は理由を区別せず一律 null を返す
 *    → クライアントには汎用エラーのみ（E-012-1 アカウント列挙対策）。
 *  - **応答時間も均一化**する（RV-P2-003）: ユーザー不在時もダミーハッシュに対して同一コストの
 *    検証を行い、`ok` を先に評価し切ってから判定する（`&&` の早期脱出では意味が無い）。
 *  - **試行回数制御**（SEC-009 / SEC-021 / SEC-022）: 判定の意味論は `lib/login-guard.ts` に切り出し、
 *    ここは「IP の解決」「照合関数の用意」「ログ」だけを担う。照合前ゲートに使うのは**攻撃者自身に
 *    閉じた軸**（IP / グローバル）のみで、アカウント軸は失敗の計数に限る（第三者の失敗回数で正規
 *    管理者を締め出さない）。ゲート超過時は scrypt を走らせないので CPU DoS も緩和する。
 *  - 認証成否・資格情報はログに出力しない（失敗ログは IP・時刻・試行回数のみ）。
 *  - セッションは JWT（strategy=jwt, authConfig）。
 */

/**
 * SEC-013 / RV-P2-002: Node ランタイムの入口で env を1度だけ検証する（fail-fast）。
 * 本番で AUTH_SECRET が未設定/32文字未満なら、認証が"動いてしまう"前に起動を失敗させる。
 * middleware.ts は Edge のため対象外（そちらは Auth.js 自身の検証に委ねる）。
 */
getServerEnv()

/**
 * SEC-009 / SEC-021 / SEC-022 レート制限の軸。
 *  - IP 軸: 10回/10分。**照合前ゲート**として使う唯一のキー付き軸。試行のたびに消費し、
 *    **認証成功でリセット**する。正当な利用者（および E2E の連続ログイン）を巻き込まず、
 *    突破できない攻撃者だけが上限に達する。
 *  - アカウント軸: 15分あたり5回。**失敗の計数と観測のみ**で、拒否の判断には使わない（SEC-021）。
 *  - グローバル軸: 100回/分。**キー非依存**の最後の防壁（SEC-022 修正方針3）。IP の解決が
 *    偽装されうる配置（信頼できるプロキシ配下でない場合など）でも、認証エンドポイント全体の
 *    流量、すなわち scrypt の総消費量を上限で抑える。
 *    **消費するのは IP ゲートを通過した試行だけ**なので（`lib/login-guard.ts` / SEC-029）、
 *    このカウンタは「scrypt の実行回数」と一致する。閾値の根拠: 正規の管理者ログインは
 *    1日数回の規模で 100回/分には到達しない一方、scrypt 1回 ≒ 100ms なのでこの上限は
 *    1インスタンスあたり最大 10秒/分の CPU に相当する（それ以上は攻撃と見なして落とす）。
 *    IP ゲートで拒否される安価なリクエストはここを進めないため、この換算は実装と一致する
 *    （P2.5 では一致していなかった＝ RV-P25-001）。成功では解放しない（解放すると流量制御に
 *    ならないため）。単一 IP が寄与できる量は IP 軸の上限（10回/10分）で頭打ちになる。
 *  - グローバル予約枠: 20回/分（グローバル軸の 20%）。グローバル枠が枯渇したときに
 *    **失敗履歴の無い発信元だけ**が引ける枠（SEC-029 修正方針2）。同一 IP から失敗を重ねた攻撃者は
 *    IP 軸を消費しているので引けず、正規管理者の分が残る。予約枠にも上限があるので、発信元を
 *    変え続けて無制限に scrypt を実行させる抜け穴にはならない（照合の総量は 120回/分で頭打ち）。
 *    **ただし判定基準は「その発信元の1回目の試行か」であって「正規利用者か」ではない**ため、
 *    **攻撃者の新品 IP は常に予約枠を引ける**（SEC-038）。
 *    **残余リスク**: 独立した発信元 30（= global.limit/ip.limit + reserve.limit）を持つ攻撃者は
 *    依然としてログインを窓ごと止められる。`trusted=false` の縮退時は cleanSource が常に true に
 *    なるため**単一ホスト 121req/分**で成立する。固定ウィンドウのカウンタを照合前ゲートに使う限り
 *    構造的に消えない。受容済み（`docs/tech-stack.md` §4.5）。
 *
 * **store は `sharedRateLimitStore()` から注入する（P3b-2 / SEC-044）。** KV が設定されていれば
 * `lib/kv.ts` の `INCR`+`EXPIRE` 実装、未設定（非本番のみ。本番は `lib/env.ts` が起動時に落とす）
 * ならプロセス内メモリになる。**注入し忘れた limiter だけが黙ってインメモリのまま残る**
 * ——インスタンスごとに別カウンタになり全体流量制御にならない——という失敗を、
 * 注入経路を1つにすることで構造的に防ぐ。
 */
const loginStore = sharedRateLimitStore()
const LOGIN_IP_LIMITER = createRateLimiter({ limit: 10, windowMs: 10 * 60_000, store: loginStore })
const LOGIN_ACCOUNT_LIMITER = createRateLimiter({
  limit: 5,
  windowMs: 15 * 60_000,
  store: loginStore,
})
const LOGIN_GLOBAL_LIMITER = createRateLimiter({ limit: 100, windowMs: 60_000, store: loginStore })
const LOGIN_GLOBAL_RESERVE_LIMITER = createRateLimiter({
  limit: 20,
  windowMs: 60_000,
  store: loginStore,
})

const loginGuard = createLoginGuard({
  ip: LOGIN_IP_LIMITER,
  account: LOGIN_ACCOUNT_LIMITER,
  global: LOGIN_GLOBAL_LIMITER,
  globalReserve: LOGIN_GLOBAL_RESERVE_LIMITER,
})

/**
 * 実在ユーザーと同形式のダミーハッシュ（初回利用時に1度だけ生成してキャッシュ）。
 * hashPassword が非同期になったためモジュールトップでは同期生成できず、Promise を保持する。
 */
let dummyHash: Promise<string> | undefined
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'))
  return dummyHash
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'メールアドレス', type: 'email' },
        password: { label: 'パスワード', type: 'password' },
      },
      authorize: async (credentials, request) => {
        const email = typeof credentials?.email === 'string' ? credentials.email : ''
        const password = typeof credentials?.password === 'string' ? credentials.password : ''

        // SEC-022: 信頼できるプロキシ配下（Vercel）でのみヘッダを採用し、そうでなければ
        // 単一 `unknown` バケットへ寄せる。偽装で上限を回避される経路を断つ。
        //
        // SEC-030: `trusted` も併せて渡す。`false`（＝ 全員が同じ `unknown` バケットを共有する縮退）
        // では、そのバケットの枯渇を照合前ゲートに使わない。共有バケットの枯渇は「無関係な誰かが
        // 失敗した」以上の意味を持たず、それで拒否すると第三者が全利用者を締め出せてしまう。
        // request が取れない経路（テスト等）も同じ縮退として扱う。
        const originRequest = request as Request | undefined
        const resolved = originRequest ? resolveClientIp(originRequest) : null
        const ip = resolved?.key ?? UNKNOWN_CLIENT_IP
        const trusted = resolved?.trusted ?? false

        // 照合済みユーザーを閉包の外へ運ぶ（`verify` の戻り値は boolean だけのため）。
        const found: { user: { id: string; email: string; name: string | null } | null } = {
          user: null,
        }

        const decision = await loginGuard.attempt({ email, ip, trusted }, async () => {
          if (!email || !password) return false
          const user = await prisma.adminUser.findUnique({ where: { email } })
          // 不在/ハッシュ無しでもダミーに対して同じコストの検証を行い、応答時間を均一化する（E-012-1）。
          const stored = user?.passwordHash ?? (await getDummyHash())
          const ok = await verifyPassword(password, stored)
          if (!user?.passwordHash || !ok) return false
          found.user = { id: user.id, email: user.email, name: user.name }
          return true
        })

        if (decision.outcome !== 'ok' || !found.user) {
          // ログに残すのは IP・時刻・試行回数のみ（パスワードとメールアドレス全文は記録しない）。
          const ipState = await LOGIN_IP_LIMITER.peek(loginIpKey(ip))
          const accountState = await LOGIN_ACCOUNT_LIMITER.peek(loginAccountKey(email))
          console.warn(
            `[auth] login ${decision.outcome}: ip=${ip} at=${new Date().toISOString()} ` +
              `ipAttempts=${ipState.limit - ipState.remaining} ` +
              `accountFailures=${accountState.limit - accountState.remaining} ` +
              `retryAfterMs=${decision.retryAfterMs}`,
          )
          return null
        }

        return found.user
      },
    }),
  ],
})
