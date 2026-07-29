import { rateLimitKey, type RateLimiter } from '@/lib/rate-limit'

/**
 * 管理者ログインの試行制御（SEC-021 / RV-P2R-001）。
 *
 * P2 の SEC-009 是正は「アカウント軸（メールをキーに 5回/15分）の上限を**パスワード照合の前**に
 * 見て、超過なら一律 null」という形になっていた。この形は、攻撃者が管理者のメールアドレスを
 * 知ってさえいれば、誤ったパスワードを 5 回送るだけで**正規管理者を締め出せる**（正しい
 * パスワードを送っても照合前に拒否される）。15 分ごとに 5 回投げれば恒久封鎖できる。
 *
 * そこで意味論を「照合前の一律拒否」から次へ変える:
 *  1. **失敗のみ計数する。** アカウント軸のカウンタは照合が失敗したときだけ進む。
 *  2. **成功は常に通す。** 他者が同一アカウントを何回失敗させていても正しい資格情報は通る。
 *  3. **ブルートフォース耐性は失わない。** 誤ったパスワードの連打は、**攻撃者自身に閉じた軸**
 *     （発信元 IP / キー非依存のグローバル）の上限で、**照合を実行せずに**拒否する
 *     （scrypt を攻撃者に消費させないので CPU DoS も緩和する）。
 *  4. 照合前ゲートにアカウント軸を使わない。使うと 2. が壊れる（＝ SEC-021 の再発）。
 *
 * ---------------------------------------------------------------------------
 * P2.5-b 改訂（SEC-029 / SEC-030 / RV-P25-001..003）— 「共有軸で正規利用者を締め出さない」
 *
 * P2.5 の実装は上の 1.〜4. を満たしていたが、**アカウント軸で塞いだ締め出しがグローバル軸へ
 * 移動しただけ**だった。グローバル軸（キー非依存の単一バケット）を IP ゲートより前で消費し、
 * かつ成功でも解放しないため、単一ホストが毎分 100 リクエストを投げるだけで全管理者を
 * 恒久封鎖できた（SEC-029 が実測で再現）。したがって不変条件を軸に依存しない形へ一般化する:
 *
 *  5. **共有軸（キー非依存のグローバル軸 / 縮退時の `unknown` バケット）の枯渇は、
 *     正しい資格情報を拒否する理由になってはならない。**
 *
 * 具体的な形:
 *  - グローバル軸の消費を **IP ゲート通過後**へ移す。これでカウンタの意味が「`verify()`（scrypt）の
 *    実行回数」と一致し、単一 IP が寄与できる量は IP 軸の上限に縛られる（SEC-029 / RV-P25-001）。
 *  - グローバル枠が枯渇しても、**失敗履歴の無い発信元**だけは予約枠（`globalReserve`）から引ける。
 *    攻撃者は自身の IP 軸を消費しているので予約枠を引けない（SEC-029 修正方針2）。
 *  - 発信元を識別できない縮退時（`trusted === false`）は、共有バケットを**計数には使うが
 *    照合前ゲートには使わない**（SEC-030 / T2-DECISION）。コスト保護はグローバル軸と予約枠が担う。
 *  - 照合前ゲートは `peek` → `consume` の 2 相ではなく **`consume` の判定結果そのもの**で行う。
 *    2 相だと直列化区間が分かれ、並行到着した N 本すべてが `verify()` に進む（RV-P25-003）。
 *
 * **残余リスク（消していない。受容している）**: 固定ウィンドウのカウンタを照合前ゲートに使う限り、
 * `global.limit + globalReserve.limit` を超える数の独立した発信元を持つ攻撃者は依然として
 * ログインを窓ごと止められる。予約枠は攻撃者に必要な IP 数を増やすだけで、ゼロにはしない。
 * 構造的に閉じる形は「同時実行中の scrypt 数を上限とするセマフォ」（自動解放されるので枯渇せず、
 * 枯渇時の症状が「拒否」ではなく「待ち」になる）で、P3 で再評価する。
 * 詳細は `docs/tech-stack.md` §4.5 / `docs/security-audit.md` SEC-029。
 * ---------------------------------------------------------------------------
 *
 * `auth.ts` の `authorize` は `NextAuth({...})` のオブジェクトリテラル内にインラインで書かれ、
 * Prisma と `getServerEnv()` のトップレベル副作用を伴うため単体テストから読み込めない。
 * したがって**判定の意味論だけをここに純粋な形で切り出し**、`authorize` はこれを呼ぶだけにする
 * （判定と永続化を分離した `lib/rate-limit.ts` と同じ方針）。
 *
 * P3 の未認証エンドポイントでも、この「攻撃者に閉じた軸だけで照合前ゲートを組む」形を再利用する。
 */

export type LoginOutcome = 'ok' | 'invalid-credentials' | 'rate-limited'

export interface LoginDecision {
  outcome: LoginOutcome
  /** 拒否時の待機時間（ms）。許可時は 0。 */
  retryAfterMs: number
  /** verify() を実際に呼んだか。rate-limited 時は false（scrypt を走らせない）。 */
  verified: boolean
}

export interface LoginGuardLimiters {
  /** 発信元 IP 軸。**照合前ゲート**（コスト保護）に使う軸。 */
  ip: RateLimiter
  /** アカウント軸。**失敗の計数と観測のみ**。照合前ゲートに使わない（SEC-021）。 */
  account: RateLimiter
  /** キー非依存のグローバル上限（SEC-022 修正方針3）。省略可。 */
  global?: RateLimiter
  /**
   * グローバル枠の枯渇時に「失敗履歴の無い発信元」だけが引ける予約枠（SEC-029 修正方針2）。省略可。
   *
   * 同一 IP から失敗を重ねた攻撃者は自分の IP 軸を消費しているので予約枠の対象外になり、
   * 正規管理者の分が残る。予約枠自体にも上限があるので、発信元を変え続ける CPU DoS の
   * 抜け穴にはならない。
   *
   * **ただし判定基準は「その発信元の1回目の試行か」であって「正規利用者か」ではない**（SEC-038）。
   * 攻撃者の新品 IP は常にこの条件を満たすため、予約枠は 1 IP あたり 1 リクエストで引き切れる。
   * 締め出しに必要な独立発信元数は 30（= global.limit/ip.limit + reserve.limit）であり、
   * `trusted=false` の縮退時（cleanSource が常に true）は **1 のまま**である。受容済み残余リスク。
   */
  globalReserve?: RateLimiter
}

export interface LoginAttemptInput {
  email: string
  ip: string
  /**
   * `ip` がプラットフォーム由来で偽装できない値か（`resolveClientIp().trusted`）。既定 `true`。
   *
   * `false` のとき `ip` は全利用者が共有する単一の `unknown` バケットであり、
   * その枯渇は「無関係な誰かが失敗した」以上の意味を持たない。したがって**計数はするが
   * 照合前ゲートには使わない**（SEC-030 / T2-DECISION）。
   */
  trusted?: boolean
  now?: number
}

export interface LoginGuard {
  attempt(input: LoginAttemptInput, verify: () => Promise<boolean>): Promise<LoginDecision>
}

const IP_KEY_PREFIX = 'credentials:ip:'
const EMAIL_KEY_PREFIX = 'credentials:email:'

/** キー非依存のグローバル上限のキー（バケットは 1 つだけ）。 */
export const LOGIN_GLOBAL_KEY = 'credentials:global'

/** グローバル予約枠のキー（バケットは 1 つだけ）。SEC-029 修正方針2。 */
export const LOGIN_GLOBAL_RESERVE_KEY = 'credentials:global-reserve'

/** IP 軸のキー。`rateLimitKey` が正規化と長さの有界性を担保する。 */
export function loginIpKey(ip: string): string {
  return rateLimitKey(IP_KEY_PREFIX, ip)
}

/** アカウント軸のキー。大小文字・前後空白の違いで計数を回避させない。 */
export function loginAccountKey(email: string): string {
  return rateLimitKey(EMAIL_KEY_PREFIX, email)
}

export function createLoginGuard(limiters: LoginGuardLimiters): LoginGuard {
  return {
    async attempt(input, verify) {
      const now = input.now ?? Date.now()
      const trusted = input.trusted ?? true
      const ipKey = loginIpKey(input.ip)
      const accountKey = loginAccountKey(input.email)

      // 1) IP 軸。**`consume` の判定結果そのもの**でゲートする（RV-P25-003）。
      //    `peek`（判定）→ `consume`（加算・戻り値を捨てる）の 2 相にすると、`lib/rate-limit.ts` の
      //    直列化が各呼び出しの内側でしか効かないため、同時到着した N 本すべてが判定を通過し、
      //    `consume` の `success:false` が捨てられて N 本すべてが verify()（scrypt）へ進む。
      const gate = await limiters.ip.consume(ipKey, now)

      // 縮退時（`trusted === false`）の `ipKey` は全利用者が共有する単一の `unknown` バケットで、
      // その枯渇は「無関係な誰かが失敗した」以上の意味を持たない。計数は続けるが拒否には使わない
      // （SEC-030 / T2-DECISION）。既定（`trusted === true`）の経路は従来どおり硬いゲートのまま。
      if (trusted && !gate.success) return denied(gate.retryAfterMs)

      // 「失敗履歴の無い発信元」＝ この試行の前に IP 軸のカウントが 0 だったこと。
      // IP 軸は認証成功で reset されるため、直前に正常ログインできていた利用者も該当する。
      // 縮退時は発信元を識別できないので、この判定は成立しない（＝常に true とみなす）。
      const cleanSource = trusted ? gate.remaining === gate.limit - 1 : true

      // 2) キー非依存のグローバル上限。キー導出を偽装されても効く最後の防壁。
      //    **IP ゲートを通過した試行＝ verify() に到達する試行だけを数える**ので、カウンタの意味が
      //    「scrypt の実行回数」と一致し、単一 IP が寄与できる量は IP 軸の上限で頭打ちになる
      //    （SEC-029 / RV-P25-001）。成功では解放しない（全体の流量制御としての意味を保つため）。
      if (limiters.global) {
        const global = await limiters.global.consume(LOGIN_GLOBAL_KEY, now)
        if (!global.success) {
          // 枯渇しても、失敗履歴の無い発信元は予約枠から引ける（SEC-029 修正方針2）。
          // これが無いと「多数の発信元でグローバル枠を使い切る」だけで正規管理者を締め出せる。
          if (!cleanSource || !limiters.globalReserve) return denied(global.retryAfterMs)
          const reserve = await limiters.globalReserve.consume(LOGIN_GLOBAL_RESERVE_KEY, now)
          if (!reserve.success) return denied(reserve.retryAfterMs)
        }
      }

      // 3) 照合は**必ず実行する**。ここをアカウント軸や共有軸で飛ばすと SEC-021 / SEC-029 が再発する。
      const ok = await verify()

      if (ok) {
        // 4) 正当な利用者を巻き込まないよう、成功したら両軸のカウンタを解放する。
        await limiters.ip.reset(ipKey)
        await limiters.account.reset(accountKey)
        return { outcome: 'ok', retryAfterMs: 0, verified: true }
      }

      // 5) アカウント軸は失敗だけを計数する（分散攻撃の観測手段として残すが、拒否には使わない）。
      //    縮退時にゲートを外しても、ここへ到達するので計数と観測は失われない。
      await limiters.account.consume(accountKey, now)

      // 6) 縮退時にゲートを外したことで**制限が緩む方向へ壊れない**ようにする（SEC-030）:
      //    共有バケットが枯渇している状態で照合が失敗したなら、拒否として返す。
      //    「正しい資格情報だけが通る」＝ 5. の不変条件を保ったまま、緩和を成功時に限定する。
      if (!gate.success) {
        return { outcome: 'rate-limited', retryAfterMs: gate.retryAfterMs, verified: true }
      }

      return { outcome: 'invalid-credentials', retryAfterMs: 0, verified: true }
    },
  }
}

function denied(retryAfterMs: number): LoginDecision {
  return { outcome: 'rate-limited', retryAfterMs, verified: false }
}
