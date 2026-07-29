import { describe, it, expect, vi } from 'vitest'
import { createRateLimiter, type RateLimitEntry, type RateLimitStore } from '@/lib/rate-limit'
import { createLoginGuard } from '@/lib/login-guard'
import { UNKNOWN_CLIENT_IP } from '@/lib/http-guard'

/**
 * SEC-021 / RV-P2R-001 — 管理者ログインのレート制限の**意味論**を契約として固定する（P2.5）。
 *
 * 背景（なぜこのテストが要るか）:
 *   P2 の SEC-009 是正は `auth.ts:83-94` で「アカウント軸（メールをキーに 5回失敗/15分）の `peek`
 *   ゲートを**パスワード照合の前**に置き、上限超過なら一律 null」という形になった。この形は、
 *   攻撃者が管理者のメールアドレスを知ってさえいれば、誤ったパスワードで 5 回 POST するだけで
 *   **正規管理者を締め出せる**（正しいパスワードを送っても照合前に拒否される）。しかも IP 軸は
 *   10回/10分なので単一 IP で足り、15 分ごとに 5 回投げれば恒久封鎖できる。
 *   security-audit.md SEC-021 / review-p2-code-re RV-P2R-001。
 *
 * 固定する意味論（Impl はこの契約に合わせること。テストを実装に合わせない）:
 *   1. **失敗のみ計数する。** アカウント軸のカウンタは照合が失敗したときだけ進む。
 *   2. **成功は常に通す。** 他者が同一アカウントを何回失敗させていても、正しい資格情報は通る。
 *      ＝「正しい資格情報が拒否される状態」を作らない、を不変条件とする（SEC-021 修正方針 4）。
 *   3. **ブルートフォース耐性は失われない。** 誤ったパスワードでの連続試行は、発信元 IP 軸の
 *      上限に達した時点で**照合を実行せずに**拒否される（scrypt を攻撃者に消費させない）。
 *   4. 上限超過の判定に使う軸は「攻撃者自身に閉じた軸」（IP / グローバル）に限る。アカウント軸は
 *      照合前ゲートに使わない。使うと 2. が壊れる（＝ SEC-021 の再発）。
 *
 * なぜ `auth.ts` の authorize を直接テストしないか:
 *   authorize は `NextAuth({ providers: [Credentials({ authorize })] })` のオブジェクトリテラル内に
 *   インラインで書かれており、export されていない。さらに `auth.ts` の import は Prisma
 *   （`@/lib/db`）と `getServerEnv()` のトップレベル副作用を伴うため、単体テストから安全に
 *   読み込めない。したがって **判定の意味論だけを純粋な形で切り出した `lib/login-guard.ts` を
 *   新設し、authorize はそれを呼ぶだけにする**ことを Impl に要求する。
 *   （レート制限の判定ロジックと永続化を分離した `lib/rate-limit.ts` と同じ方針。）
 *
 * Impl が実装すべきシグネチャ（`lib/login-guard.ts`）:
 *   export type LoginOutcome = 'ok' | 'invalid-credentials' | 'rate-limited'
 *   export interface LoginDecision {
 *     outcome: LoginOutcome
 *     retryAfterMs: number   // 拒否時の待機時間。許可時は 0
 *     verified: boolean      // verify() を実際に呼んだか（rate-limited 時は false）
 *   }
 *   export interface LoginGuardLimiters {
 *     ip: RateLimiter        // 発信元 IP 軸（照合前ゲート・コスト保護）
 *     account: RateLimiter   // アカウント軸（**失敗の計数と観測のみ**。照合前ゲートに使わない）
 *     global?: RateLimiter   // キー非依存のグローバル上限（SEC-022 修正方針 3。省略可）
 *   }
 *   export interface LoginAttemptInput { email: string; ip: string; now?: number }
 *   export function createLoginGuard(limiters: LoginGuardLimiters): {
 *     attempt(
 *       input: LoginAttemptInput,
 *       verify: () => Promise<boolean>,
 *     ): Promise<LoginDecision>
 *   }
 *
 * 要求する処理順序（**P2.5-b で改訂**。旧契約は SEC-029 の原因だったので下記 §改訂 を参照）:
 *   ip.consume（超過なら verify を呼ばず rate-limited）
 *   → global?.consume（枯渇時は失敗履歴の無い発信元だけ globalReserve から引く）
 *   → **verify() を必ず実行** → 成功なら ip/account を reset して ok
 *   → 失敗なら account.consume して invalid-credentials（アカウント軸が超過済みなら rate-limited でも可）
 *
 * 要求するキー書式（テストが注入した limiter の状態を直接検証するため、書式も契約に含む）:
 *   IP 軸          : `credentials:ip:${ip}`
 *   アカウント軸    : `credentials:email:${email.trim().toLowerCase()}`
 *   グローバル軸    : `credentials:global`
 *   グローバル予約枠 : `credentials:global-reserve`
 *
 * 時刻は `now`（epoch ms）で注入する。実時間 sleep をしない（`tests/unit/rate-limit.test.ts` の流儀）。
 *
 * ---------------------------------------------------------------------------
 * §改訂（P2.5-b / 2026-07-28）— なぜこの契約書を書き換えたか
 *
 * 旧契約（`global?.consume → ip.peek → ip.consume`）は実装によって忠実に満たされ、
 * 本ファイルの全テストが green になった。**それでも脅威は閉じていなかった。**
 *   - `global` はキー非依存の単一バケットで、**IP ゲートより前**に消費される。
 *     したがって IP 軸で 10回/10分 に縛られているはずの単一ホストが、
 *     グローバル軸の 100回/分 を単独で使い切れる（安価な拒否もグローバル枠を食う）。
 *   - グローバル軸は成功でも解放しない設計なので、枯渇後は**正しい資格情報を持つ管理者も
 *     照合前に拒否される**。SEC-021（第三者が管理者を締め出す）と同一の被害クラスが、
 *     アカウント軸からグローバル軸へ移動しただけだった。攻撃コストはむしろ下がっている
 *     （5req/15分 + メール既知 → 100req/分 + 知識不要）。
 *   - 旧テストはグローバル上限が「効くこと」しか検証しておらず、
 *     **「正規利用者が巻き込まれないこと」を検証していなかった**。
 *     ＝ 実装ではなく**契約の側に欠陥があった**。
 *     security-audit.md SEC-029 / review-p25-code RV-P25-001。
 *
 * よって P2.5-b では「テストが green になること」ではなく
 * 「**攻撃シナリオが実測で再現しなくなること**」を契約とする。追加した軸は次の3本:
 *   T1 (SEC-029): 共有軸（グローバル）の枯渇が、正しい資格情報の拒否理由になってはならない。
 *   T2 (SEC-030): 信頼境界外（`trusted=false`）で共有 `unknown` バケットが枯渇しても同様。
 *   T3 (RV-P25-003): 照合前ゲートは `consume` の判定結果そのもので行う（並行下でも破れない）。
 *
 * Impl に要求する追加シグネチャ:
 *   export interface LoginGuardLimiters {
 *     ip: RateLimiter
 *     account: RateLimiter
 *     global?: RateLimiter
 *     globalReserve?: RateLimiter   // ★追加: グローバル枠の枯渇時に「失敗履歴の無い発信元」だけが引ける予約枠
 *   }
 *   export interface LoginAttemptInput {
 *     email: string
 *     ip: string
 *     trusted?: boolean             // ★追加: `resolveClientIp().trusted`。既定 true
 *     now?: number
 *   }
 *   export const LOGIN_GLOBAL_RESERVE_KEY = 'credentials:global-reserve'
 * ---------------------------------------------------------------------------
 */

const T0 = 1_800_000_000_000

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_IP = '198.51.100.20'
const ATTACKER_IP = '203.0.113.9'

/** 本番と同じ軸設定（auth.ts:45-46 の閾値）。 */
function createGuard() {
  return createLoginGuard({
    ip: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
    account: createRateLimiter({ limit: 5, windowMs: 15 * 60_000 }),
  })
}

/** 正しいパスワードだけを true にする検証関数（scrypt 照合の代役）。 */
function verifierFor(correctPassword: string) {
  const verify = vi.fn(async (password: string) => password === correctPassword)
  return {
    calls: verify,
    for: (password: string) => () => verify(password),
  }
}

describe('SEC-021: createLoginGuard — 正しい資格情報が拒否されない不変条件', () => {
  it('第三者が同一アカウントを 10 回失敗させた後でも、正規パスワードのログインは成功する', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    // 攻撃者（別 IP）が管理者のメールアドレスに対して誤ったパスワードで連打する。
    // アカウント軸の上限（5回/15分）を明確に超える回数を投げる。
    for (let i = 0; i < 10; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 1_000 },
        verifier.for(`wrong-${i}`),
      )
    }

    // 正規管理者が自分の IP から正しいパスワードでログインする。
    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 20_000 },
      verifier.for('correct-horse'),
    )

    expect(
      decision.outcome,
      '第三者の失敗回数によって正規管理者が締め出されてはならない（SEC-021）',
    ).toBe('ok')
    expect(decision.retryAfterMs).toBe(0)
    expect(decision.verified, '正規のログインでは資格情報の照合が実行される').toBe(true)
  })

  it('攻撃者が 15分ウィンドウをまたいで攻撃を継続しても、正規ログインは通り続ける（恒久封鎖の否定）', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    // 15分ごとに 5 回失敗させる、を 3 ウィンドウ繰り返す（SEC-021 の「恒久封鎖」再現手順）。
    for (let window = 0; window < 3; window++) {
      const base = T0 + window * 15 * 60_000
      for (let i = 0; i < 5; i++) {
        await guard.attempt(
          { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: base + i * 1_000 },
          verifier.for('wrong'),
        )
      }
      const legit = await guard.attempt(
        { email: ADMIN_EMAIL, ip: ADMIN_IP, now: base + 10_000 },
        verifier.for('correct-horse'),
      )
      expect(legit.outcome, `window=${window} で正規ログインが拒否された`).toBe('ok')
    }
  })

  it('本人が自分の IP で 4 回打ち間違えた後でも、正しいパスワードで成功する', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 4; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + i * 1_000 },
        verifier.for('typo'),
      )
    }

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 5_000 },
      verifier.for('correct-horse'),
    )
    expect(decision.outcome, 'アカウント軸の失敗計数で本人を締め出してはならない').toBe('ok')
  })

  it('成功後はカウンタが解放され、直後の再ログインも成功する', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 4; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + i * 1_000 },
        verifier.for('typo'),
      )
    }
    await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 5_000 },
      verifier.for('correct-horse'),
    )

    // 解放されていなければ IP 軸（10回/10分）の残数が尽きて rate-limited になる。
    for (let i = 0; i < 8; i++) {
      const again = await guard.attempt(
        { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 6_000 + i * 1_000 },
        verifier.for('correct-horse'),
      )
      expect(again.outcome, `成功後 ${i + 1} 回目の再ログインが拒否された`).toBe('ok')
    }
  })
})

describe('SEC-021: createLoginGuard — 失敗のみ計数する', () => {
  it('成功時はアカウント軸のカウンタを進めない（成功を何度繰り返しても上限に達しない）', async () => {
    const account = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 })
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 100, windowMs: 10 * 60_000 }),
      account,
    })
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 20; i++) {
      const decision = await guard.attempt(
        { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + i * 1_000 },
        verifier.for('correct-horse'),
      )
      expect(decision.outcome).toBe('ok')
    }

    // アカウント軸のバケットは一度も消費されていない。
    const state = await account.peek(`credentials:email:${ADMIN_EMAIL}`, T0 + 20_000)
    expect(state.remaining, '成功はアカウント軸を消費してはならない').toBe(state.limit)
  })

  it('照合前にアカウント軸を参照しない: アカウント軸を使い切った状態でも正しい資格情報は通る', async () => {
    // アカウント軸を「もう残り 0」の状態にして注入する（他 IP からの失敗で枯渇した想定）。
    const account = createRateLimiter({ limit: 1, windowMs: 15 * 60_000 })
    await account.consume(`credentials:email:${ADMIN_EMAIL}`, T0)
    expect((await account.peek(`credentials:email:${ADMIN_EMAIL}`, T0)).success).toBe(false)

    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
      account,
    })
    const verifier = verifierFor('correct-horse')

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 1_000 },
      verifier.for('correct-horse'),
    )

    expect(decision.outcome, 'アカウント軸の枯渇で正しい資格情報を拒否してはならない').toBe('ok')
    expect(decision.verified, '照合前ゲートで verify をスキップしてはならない').toBe(true)
  })

  it('メールアドレスの大文字小文字違いでアカウント軸の計数を回避できない（キー正規化）', async () => {
    const account = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 })
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 100, windowMs: 10 * 60_000 }),
      account,
    })
    const verifier = verifierFor('correct-horse')

    await guard.attempt(
      { email: '  Admin@Example.COM ', ip: ATTACKER_IP, now: T0 },
      verifier.for('wrong'),
    )

    const state = await account.peek(`credentials:email:${ADMIN_EMAIL}`, T0)
    expect(state.remaining, '正規化した同一アカウントとして計数されること').toBe(state.limit - 1)
  })
})

describe('SEC-021: createLoginGuard — ブルートフォース耐性は失われない', () => {
  it('同一 IP からの誤パスワード連打は IP 軸の上限で拒否される', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    // IP 軸 10回/10分。10 回までは照合され、いずれも失敗として拒否される。
    for (let i = 0; i < 10; i++) {
      const decision = await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 1_000 },
        verifier.for(`wrong-${i}`),
      )
      expect(decision.outcome, `${i + 1} 回目は照合されたうえで失敗するはず`).toBe(
        'invalid-credentials',
      )
    }

    // 11 回目は上限超過。**照合を実行せずに**拒否する（scrypt を攻撃者に消費させない）。
    const denied = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + 11_000 },
      verifier.for('wrong-11'),
    )
    expect(denied.outcome).toBe('rate-limited')
    expect(denied.verified, '上限超過時は資格情報の照合を実行しない').toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('上限に達した攻撃者 IP は、正しいパスワードを当てても通らない（推測成功の遮断）', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 10; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 1_000 },
        verifier.for(`wrong-${i}`),
      )
    }

    const guessed = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + 11_000 },
      verifier.for('correct-horse'),
    )
    expect(
      guessed.outcome,
      '上限到達後は照合自体を行わないため、当たっていても通らない（総当たり抑止）',
    ).toBe('rate-limited')
    expect(guessed.verified).toBe(false)
  })

  it('IP 軸のウィンドウ経過後は再び試行できる（恒久ロックにはしない）', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 11; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 1_000 },
        verifier.for('wrong'),
      )
    }

    const after = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + 10 * 60_000 + 1 },
      verifier.for('wrong'),
    )
    expect(after.outcome).toBe('invalid-credentials')
    expect(after.verified).toBe(true)
  })

  it('誤った資格情報はアカウント軸の失敗として計数される（分散攻撃の観測手段を残す）', async () => {
    const account = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 })
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
      account,
    })
    const verifier = verifierFor('correct-horse')

    // 3 つの異なる IP から 1 回ずつ失敗（IP 軸には掛からない量）。
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await guard.attempt({ email: ADMIN_EMAIL, ip, now: T0 }, verifier.for('wrong'))
    }

    const state = await account.peek(`credentials:email:${ADMIN_EMAIL}`, T0)
    expect(state.remaining, 'アカウント軸は失敗を計数し続ける（拒否には使わない）').toBe(
      state.limit - 3,
    )
  })

  it('アカウント軸が枯渇した状態の誤パスワードは通らない', async () => {
    const guard = createGuard()
    const verifier = verifierFor('correct-horse')

    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4', '203.0.113.5']) {
      await guard.attempt({ email: ADMIN_EMAIL, ip, now: T0 }, verifier.for('wrong'))
    }

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: '203.0.113.6', now: T0 + 1_000 },
      verifier.for('still-wrong'),
    )
    // 拒否されること自体が契約。理由の呼び分け（invalid-credentials / rate-limited）は問わない。
    expect(['invalid-credentials', 'rate-limited']).toContain(decision.outcome)
    expect(decision.outcome).not.toBe('ok')
  })
})

/**
 * SEC-022 修正方針3 — 「キー導出が偽装可能でも全体を守る、キー非依存のグローバル上限」。
 * IP キーの解決を強化しても（`resolveClientIp`、`tests/unit/client-ip.test.ts`）、
 * 信頼境界の外や未知のホスティングでは偽装の余地が残る。最後の防壁として、キーに依存しない
 * 認証エンドポイント全体の上限を併設する。
 */
describe('SEC-022: createLoginGuard — キー非依存のグローバル上限', () => {
  it('IP が全て異なっても、グローバル上限に達したら拒否される', async () => {
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
      account: createRateLimiter({ limit: 5, windowMs: 15 * 60_000 }),
      global: createRateLimiter({ limit: 20, windowMs: 60_000 }),
    })
    const verifier = verifierFor('correct-horse')

    // 毎回別 IP・別メール＝ IP 軸もアカウント軸も一度も上限に触れない攻撃。
    const outcomes: string[] = []
    for (let i = 0; i < 25; i++) {
      const decision = await guard.attempt(
        { email: `victim-${i}@example.com`, ip: `203.0.113.${i}`, now: T0 + i },
        verifier.for('wrong'),
      )
      outcomes.push(decision.outcome)
    }

    expect(
      outcomes.slice(20),
      'グローバル上限を超えた分は、キーを変えても拒否されなければならない',
    ).toEqual(['rate-limited', 'rate-limited', 'rate-limited', 'rate-limited', 'rate-limited'])
  })

  it('グローバル上限の拒否では資格情報を照合しない（scrypt を消費させない）', async () => {
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 100, windowMs: 10 * 60_000 }),
      account: createRateLimiter({ limit: 100, windowMs: 15 * 60_000 }),
      global: createRateLimiter({ limit: 2, windowMs: 60_000 }),
    })
    const verify = vi.fn(async () => false)

    await guard.attempt({ email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 }, verify)
    await guard.attempt({ email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 1 }, verify)
    const denied = await guard.attempt({ email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 2 }, verify)

    expect(denied.outcome).toBe('rate-limited')
    expect(denied.verified).toBe(false)
    expect(verify, 'グローバル上限の拒否では照合を実行しない').toHaveBeenCalledTimes(2)
  })

  it('global 未指定でも動作する（既存の2軸運用と後方互換）', async () => {
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
      account: createRateLimiter({ limit: 5, windowMs: 15 * 60_000 }),
    })
    const verifier = verifierFor('correct-horse')

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 },
      verifier.for('correct-horse'),
    )
    expect(decision.outcome).toBe('ok')
  })

  it('グローバル上限は成功したログインでは解放されない（全体の流量制御であるため）', async () => {
    const global = createRateLimiter({ limit: 3, windowMs: 60_000 })
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 100, windowMs: 10 * 60_000 }),
      account: createRateLimiter({ limit: 100, windowMs: 15 * 60_000 }),
      global,
    })
    const verifier = verifierFor('correct-horse')

    await guard.attempt({ email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 }, verifier.for('correct-horse'))

    const state = await global.peek('credentials:global', T0)
    expect(state.remaining, '成功でグローバル枠を巻き戻すと流量制御が無意味になる').toBe(
      state.limit - 1,
    )
  })
})

describe('SEC-021: createLoginGuard — 応答の均一性（E-012-1 アカウント列挙対策の維持）', () => {
  it('存在しないアカウントでも照合は実行される（呼び出し側でダミーハッシュを検証させる）', async () => {
    const guard = createGuard()
    const verify = vi.fn(async () => false)

    const decision = await guard.attempt(
      { email: 'nobody@example.com', ip: ADMIN_IP, now: T0 },
      verify,
    )

    expect(verify).toHaveBeenCalledTimes(1)
    expect(decision.outcome).toBe('invalid-credentials')
    expect(decision.verified).toBe(true)
  })

  it('空メールでも判定が例外にならず、拒否側に倒れる', async () => {
    const guard = createGuard()
    const decision = await guard.attempt({ email: '', ip: ADMIN_IP, now: T0 }, async () => false)
    expect(decision.outcome).not.toBe('ok')
  })
})

/* ========================================================================== *
 * T1 — SEC-029 / RV-P25-001（Must Fix）
 *
 * 不変条件: **共有軸（キー非依存のグローバル軸）の枯渇が、正しい資格情報を拒否する理由に
 * なってはならない。** SEC-021 に対して置いた「正しい資格情報が拒否される状態を作らない」を、
 * グローバル軸にも同じ形で適用する。
 *
 * 本ブロックの各テストが green になると成立しなくなる攻撃（テスト直上にも1文で記載）:
 *   - 単一ホストからの毎分 100 リクエストによる全管理者の恒久締め出し（Security 実測シナリオ）
 *   - 多数の発信元でグローバル枠を使い切ることによる、正規管理者の締め出し
 * ========================================================================== */

/** 本番の軸設定（`auth.ts:57-59`）。グローバル軸は 100回/分。 */
function createProductionGuard(overrides: {
  ip?: number
  global?: number
  globalReserve?: number
} = {}) {
  const ip = createRateLimiter({ limit: overrides.ip ?? 10, windowMs: 10 * 60_000 })
  const account = createRateLimiter({ limit: 100, windowMs: 15 * 60_000 })
  const global = createRateLimiter({ limit: overrides.global ?? 100, windowMs: 60_000 })
  const globalReserve = createRateLimiter({
    limit: overrides.globalReserve ?? 5,
    windowMs: 60_000,
  })
  const guard = createLoginGuard({ ip, account, global, globalReserve })
  return { guard, ip, account, global, globalReserve }
}

describe('SEC-029: createLoginGuard — グローバル軸の枯渇で正規管理者を締め出さない', () => {
  it('単一 IP から 120 リクエストを投げても、別 IP の正規管理者は正しいパスワードでログインできる', async () => {
    // これが green なら成立しなくなる攻撃:
    //   単一ホストが `/api/auth/callback/credentials` へ毎分 100 リクエストを投げ続けるだけで
    //   全管理者のログインを恒久封鎖する攻撃（認証不要・管理者メールの知識も不要）。
    //
    // security-audit.md SEC-029 が実測したシナリオをそのまま再現する:
    //   攻撃者: 単一 IP から 120 リクエスト
    //   → グローバル軸 used=100/100
    //   → 正規管理者（別 IP・正しいパスワード）が outcome=rate-limited verified=false
    const { guard } = createProductionGuard()
    const verifier = verifierFor('correct-horse')

    // 12 秒間に 120 リクエスト（グローバル軸の 1 分ウィンドウ・IP 軸の 10 分ウィンドウの内側）。
    for (let i = 0; i < 120; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 100 },
        verifier.for(`wrong-${i}`),
      )
    }

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 12_100 },
      verifier.for('correct-horse'),
    )

    expect(
      decision.outcome,
      '単一ホストの流量でグローバル軸を枯渇させ、正規管理者を締め出せてはならない（SEC-029）',
    ).toBe('ok')
    expect(decision.verified, '正規のログインでは資格情報の照合が実行される').toBe(true)
    expect(decision.retryAfterMs).toBe(0)
  })

  it('IP ゲートで拒否された安価なリクエストはグローバル枠を消費しない', async () => {
    // これが green なら成立しなくなる攻撃:
    //   IP 軸の上限に達した後も「scrypt を1度も実行しない安価な拒否」でグローバルカウンタを
    //   進め続け、単一 IP だけでグローバル枠を使い切る攻撃。
    //
    // 併せて `auth.ts:47-49` の閾値の根拠（「グローバル上限 = scrypt の CPU 予算」）を
    // 実装と一致させる。グローバル枠の消費回数と verify の実行回数は一致していなければならない。
    const { guard, global } = createProductionGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 120; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 100 },
        verifier.for(`wrong-${i}`),
      )
    }

    const state = await global.peek('credentials:global', T0 + 12_000)
    expect(
      state.limit - state.remaining,
      '単一 IP がグローバル枠へ寄与できる量は IP 軸の上限（10回/10分）で頭打ちになるべき',
    ).toBe(10)
    expect(
      verifier.calls,
      'グローバル枠の消費回数と scrypt の実行回数が一致すること（閾値の根拠と実装の整合）',
    ).toHaveBeenCalledTimes(10)
  })

  it('グローバル軸を移しても流量制御の意味は失われない（攻撃元 IP 自身は依然として制限される）', async () => {
    // これが green なら成立しなくなる攻撃:
    //   「締め出しを直す」名目でグローバル軸や IP ゲートを外し、
    //   誤パスワードの連打で scrypt を無制限に消費させる CPU DoS。
    const { guard } = createProductionGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 10; i++) {
      const decision = await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 100 },
        verifier.for(`wrong-${i}`),
      )
      expect(decision.outcome, `${i + 1} 回目は照合されたうえで失敗するはず`).toBe(
        'invalid-credentials',
      )
    }

    const denied = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + 1_100 },
      verifier.for('wrong-11'),
    )
    expect(denied.outcome, '攻撃元 IP は IP 軸の上限で止まり続ける').toBe('rate-limited')
    expect(denied.verified, '上限超過時は scrypt を走らせない').toBe(false)
    // 分散攻撃がグローバル軸で止まることは既存テスト（本ファイル
    // 「IP が全て異なっても、グローバル上限に達したら拒否される」）が固定している。
  })

  it('多数の発信元がグローバル枠を使い切っても、失敗履歴の無い発信元からの正しい資格情報は通る', async () => {
    // これが green なら成立しなくなる攻撃:
    //   100 以上の発信元（ボットネット / プロキシプール）でグローバル枠を使い切り、
    //   正規管理者を締め出す攻撃。SEC-029 修正方針2（予約枠）が要求する不変条件。
    //
    // 「失敗履歴の無い発信元」= その IP 軸バケットが本試行の前にカウント 0 であること
    // （IP 軸は認証成功で reset されるため、直前に正常ログインできていた利用者も該当する）。
    const { guard, global } = createProductionGuard({ global: 20, globalReserve: 5 })
    const verifier = verifierFor('correct-horse')

    // 20 個の異なる発信元が 1 回ずつ失敗する＝ IP 軸には掛からないままグローバル枠だけが枯渇する。
    for (let i = 0; i < 20; i++) {
      await guard.attempt(
        { email: `victim-${i}@example.com`, ip: `203.0.113.${i}`, now: T0 + i },
        verifier.for('wrong'),
      )
    }
    expect(
      (await global.peek('credentials:global', T0 + 20)).success,
      '前提: グローバル枠が枯渇していること',
    ).toBe(false)

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 21 },
      verifier.for('correct-horse'),
    )

    expect(
      decision.outcome,
      '他者がグローバル上限を使い切っても、正しい資格情報でのログインは通る（P2.5-b 受け入れ条件）',
    ).toBe('ok')
    expect(decision.verified).toBe(true)
  })

  it('予約枠は無制限ではない（枯渇後の新規発信元も、予約枠の分だけしか照合されない）', async () => {
    // これが green なら成立しなくなる攻撃:
    //   予約枠を「グローバル枠の抜け穴」にして、発信元 IP を毎回変えながら
    //   無制限に scrypt を実行させる CPU DoS。
    const { guard } = createProductionGuard({ global: 5, globalReserve: 3 })
    const verifier = verifierFor('correct-horse')

    // 5 個の発信元でグローバル枠 5/5 を使い切る。
    for (let i = 0; i < 5; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: `198.18.0.${i}`, now: T0 + i },
        verifier.for('wrong'),
      )
    }

    // 以降は新規発信元（失敗履歴なし）でも、予約枠 3 件までしか照合されない。
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) {
      const decision = await guard.attempt(
        { email: ADMIN_EMAIL, ip: `198.19.0.${i}`, now: T0 + 10 + i },
        verifier.for('wrong'),
      )
      outcomes.push(decision.outcome)
    }

    expect(outcomes, '予約枠 3 件を超えた分は照合前に拒否される').toEqual([
      'invalid-credentials',
      'invalid-credentials',
      'invalid-credentials',
      'rate-limited',
      'rate-limited',
    ])
    expect(verifier.calls, 'scrypt の総実行回数は global + globalReserve で頭打ちになる').toHaveBeenCalledTimes(
      8,
    )
  })

  it('失敗履歴のある発信元はグローバル枠の枯渇後に予約枠を引けない', async () => {
    // これが green なら成立しなくなる攻撃:
    //   グローバル枠を使い切った攻撃者が、そのまま予約枠まで食い潰して
    //   正規管理者用の余地を消す攻撃。
    const { guard } = createProductionGuard({ global: 5, globalReserve: 5 })
    const verifier = verifierFor('correct-horse')

    // 攻撃者 IP が 3 回失敗して「失敗履歴」を作る。
    for (let i = 0; i < 3; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i },
        verifier.for('wrong'),
      )
    }
    // 別の 2 発信元でグローバル枠を 5/5 にする。
    for (let i = 0; i < 2; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: `198.18.0.${i}`, now: T0 + 10 + i },
        verifier.for('wrong'),
      )
    }

    const attacker = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + 20 },
      verifier.for('wrong'),
    )
    expect(attacker.outcome, '失敗履歴のある発信元は予約枠の対象外').toBe('rate-limited')
    expect(attacker.verified).toBe(false)

    const admin = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ADMIN_IP, now: T0 + 21 },
      verifier.for('correct-horse'),
    )
    expect(admin.outcome, '予約枠は正規管理者のために残っていなければならない').toBe('ok')
    expect(admin.verified).toBe(true)
  })
})

/* ========================================================================== *
 * T2 — SEC-030 / RV-P25-002（Must Fix）: `trusted=false` 時のゲート意味論
 *
 * 背景: `resolveClientIp` は信頼できるプロキシ配下でない配置（`VERCEL` 未設定＝ `next start`
 * 直公開・ローカル・オンプレ）で、全リクエストを単一の `unknown` バケットへ寄せる。
 * `lib/http-guard.ts:84-85` / `docs/tech-stack.md:199-200` / 旧テスト契約 §T2 は
 * 「この縮退でも正しい資格情報は常に通るので締め出されない」と記述していたが、**これは誤り**である。
 * 「成功は常に通す」が適用されたのはアカウント軸だけで、IP 軸は照合前ゲートのままだった。
 * 実測（本ファイル執筆時に現行実装へ直接投入して確認）:
 *   trusted=false / 共有 unknown バケットへ他者が 12 回失敗
 *   → 正規管理者・正しいパスワード: outcome=rate-limited verified=false retryAfterMs=580000
 * 攻撃コスト 10リクエスト/10分。**元の SEC-021（5req/15分 + メール既知）より安い。**
 *
 * ---------------------------------------------------------------------------
 * 決定した意味論（T2-DECISION）と、その理由
 *
 *   `trusted === false` のとき、**IP 軸は計数を続けるが照合前ゲートには使わない。**
 *   共有バケットが枯渇していても `verify()` を実行し、成功なら `ok` を返す。
 *   失敗した場合は、共有バケットが枯渇していれば `rate-limited` を返す
 *   （＝制限が緩む方向にも壊さない）。コスト保護はグローバル軸と予約枠が担う。
 *   `trusted` 既定（`true`）の経路は現行どおり厳格な照合前ゲートのままとする。
 *
 * 取りうる選択肢と比較（判断基準: **P3 で未認証エンドポイントに横展開したときに
 * 正規利用者を締め出さないこと**）:
 *
 *   (A) 縮退時はゲートに使わず計数のみ                → **採用**
 *       共有バケットは「無関係な利用者の集合」なので、それで拒否することは
 *       第三者による締め出しそのものになる。P3 の申込 / チャットへ横展開すると
 *       「1 人の濫用で全訪問者が申込を送信できない」形で顕在化する。
 *   (B) 別の緩い閾値を割り当てる                       → 不採用
 *       共有ゲートであることは変わらないため、締め出しが**遅くなるだけで消えない**。
 *       閾値を上げるほどコスト保護も同時に緩むので、両立しない。
 *   (C) 成功照合は常に実行する（＝ゲートを廃止）        → 実質 (A) と同じ。
 *       (A) は「計数と観測を残す」点だけが違い、観測は分散攻撃の検知に要るので (A) を採る。
 *
 * (A) が支払う代償（**隠さずに記録する**）: 発信元を識別できない以上、
 * 「発信元あたりの推測回数を縛る」ことは定義上できない。縮退時のブルートフォース耐性は
 * グローバル軸（+予約枠）の上限まで低下する。したがって **Vercel 以外へ配置する場合は
 * `trustProxy` を必ず有効化すること**が運用上の必須要件になる（SEC-030 修正方針3）。
 * この代償は (B) を選んでも減らない（(B) は締め出しを買うだけで耐性は同様に低い）。
 * ========================================================================== */

describe('SEC-030: createLoginGuard — 信頼境界外（trusted=false）の縮退時のゲート意味論', () => {
  /** 縮退時の構成: 全員が単一 `unknown` バケットを共有する。 */
  function createDegradedGuard(accountLimit = 100) {
    const ip = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 })
    const account = createRateLimiter({ limit: accountLimit, windowMs: 15 * 60_000 })
    return { guard: createLoginGuard({ ip, account }), ip, account }
  }

  it('共有 unknown バケットが他者の失敗で枯渇しても、正しい資格情報でのログインは成功する', async () => {
    // これが green なら成立しなくなる攻撃:
    //   信頼境界外の配置で、誰か 1 人が 10 分間に 10 回失敗するだけで
    //   （＝ 10 リクエスト / 10 分・管理者メールの知識も不要で）全利用者を締め出す攻撃。
    const { guard } = createDegradedGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 12; i++) {
      await guard.attempt(
        {
          email: `stranger-${i}@example.com`,
          ip: UNKNOWN_CLIENT_IP,
          trusted: false,
          now: T0 + i * 1_000,
        },
        verifier.for('wrong'),
      )
    }

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: UNKNOWN_CLIENT_IP, trusted: false, now: T0 + 20_000 },
      verifier.for('correct-horse'),
    )

    expect(
      decision.outcome,
      '共有バケットは無関係な利用者の集合であり、その枯渇で正しい資格情報を拒否してはならない（SEC-030）',
    ).toBe('ok')
    expect(decision.verified, '縮退時も照合は実行される').toBe(true)
    expect(decision.retryAfterMs).toBe(0)
  })

  it('縮退しても制限は緩まない: 共有バケット枯渇後の誤った資格情報は通らない', async () => {
    // これが green なら成立しなくなる攻撃:
    //   「縮退時はゲートを外す」意味論を悪用し、誤った資格情報が通る（fail-open）ことを狙う攻撃。
    const { guard } = createDegradedGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 12; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: UNKNOWN_CLIENT_IP, trusted: false, now: T0 + i * 1_000 },
        verifier.for('wrong'),
      )
    }

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: UNKNOWN_CLIENT_IP, trusted: false, now: T0 + 20_000 },
      verifier.for('still-wrong'),
    )
    expect(decision.outcome, '誤った資格情報は縮退時も通らない').not.toBe('ok')
    expect(
      decision.outcome,
      '共有バケットが枯渇している状態の失敗は rate-limited として返す（緩んでいないことを呼び出し側に伝える）',
    ).toBe('rate-limited')
  })

  it('縮退時も失敗はアカウント軸に計数され続ける（分散攻撃の観測手段を失わない）', async () => {
    // これが green なら成立しなくなる攻撃:
    //   共有バケットを枯渇させてから、以降の試行を「計数されない」状態にして
    //   観測ログから姿を消す攻撃（現行実装ではゲート拒否時に account.consume に到達しない）。
    const { guard, account } = createDegradedGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 12; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: UNKNOWN_CLIENT_IP, trusted: false, now: T0 + i * 1_000 },
        verifier.for('wrong'),
      )
    }

    const state = await account.peek(`credentials:email:${ADMIN_EMAIL}`, T0 + 20_000)
    expect(state.limit - state.remaining, '12 回の失敗はすべて計数されるべき').toBe(12)
  })

  it('trusted 既定（true）では縮退の緩和が適用されない（緩和が信頼できる経路へ漏れない）', async () => {
    // これが green なら成立しなくなる攻撃:
    //   `trusted` の分岐を実装する際に緩和を全経路へ適用してしまい、
    //   本番（Vercel / trusted=true）でも IP 軸の照合前ゲートが消えて scrypt が無制限に走る状態。
    const { guard } = createDegradedGuard()
    const verifier = verifierFor('correct-horse')

    for (let i = 0; i < 10; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + i * 1_000 },
        verifier.for('wrong'),
      )
    }

    const decision = await guard.attempt(
      { email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 + 11_000 },
      verifier.for('correct-horse'),
    )
    expect(decision.outcome, 'trusted=true の経路は従来どおり照合前に拒否する').toBe('rate-limited')
    expect(decision.verified).toBe(false)
  })

  it('縮退時のコスト保護はグローバル軸が担う（照合が無制限にはならない）', async () => {
    // これが green なら成立しなくなる攻撃:
    //   縮退時に IP ゲートが外れることを利用し、単一ホストから無制限に scrypt を実行させる CPU DoS。
    const global = createRateLimiter({ limit: 5, windowMs: 60_000 })
    const globalReserve = createRateLimiter({ limit: 2, windowMs: 60_000 })
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
      account: createRateLimiter({ limit: 100, windowMs: 15 * 60_000 }),
      global,
      globalReserve,
    })
    const verify = vi.fn(async () => false)

    for (let i = 0; i < 30; i++) {
      await guard.attempt(
        { email: ADMIN_EMAIL, ip: UNKNOWN_CLIENT_IP, trusted: false, now: T0 + i * 100 },
        verify,
      )
    }

    expect(
      verify,
      '縮退時の照合回数は global + globalReserve の上限で頭打ちになる',
    ).toHaveBeenCalledTimes(7)
  })
})

/* ========================================================================== *
 * T3 — RV-P25-003: 照合前ゲートは `consume` の判定結果そのもので行う
 *
 * 現行実装は `ip.peek`（①判定）→ `ip.consume`（②加算・**戻り値を捨てる**）の 2 相で、
 * `lib/rate-limit.ts` の直列化は「1回の peek」「1回の consume」の内側でしか効かない。
 * ①と②は別々にキューへ載るため、同時到着した N 本すべてが①を通過し、
 * ②で `success:false` が返っても**その結果が捨てられているので N 本すべてが verify() に進む**。
 * ＝「上限超過時は scrypt を走らせない」というコスト保護の中核契約が並行下で破れる。
 * ========================================================================== */

describe('RV-P25-003: createLoginGuard — 並行リクエスト下でも IP 上限を超えて照合しない', () => {
  /** get/set の間に必ず割り込みが入る store（KV のネットワーク往復に相当）。 */
  function createSlowStore(): RateLimitStore {
    const map = new Map<string, RateLimitEntry>()
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    return {
      async get(key: string) {
        await tick()
        return map.get(key) ?? null
      },
      async set(key: string, entry: RateLimitEntry) {
        await tick()
        map.set(key, entry)
      },
      async delete(key: string) {
        await tick()
        map.delete(key)
      },
    }
  }

  it('同一 IP からの 20 並行リクエストのうち、照合が実行されるのは上限回数だけ', async () => {
    // これが green なら成立しなくなる攻撃:
    //   IP 軸の上限境界を狙って同時接続を束ね、上限を超える数の scrypt（各 100ms）を
    //   同時に走らせて libuv スレッドプールを圧迫する CPU DoS（増幅率は同時接続数に比例し、
    //   ウィンドウごとに繰り返せる）。
    const guard = createLoginGuard({
      ip: createRateLimiter({ limit: 5, windowMs: 10 * 60_000, store: createSlowStore() }),
      account: createRateLimiter({ limit: 100, windowMs: 15 * 60_000 }),
    })
    const verify = vi.fn(async () => false)

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () =>
        guard.attempt({ email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 }, verify),
      ),
    )

    expect(
      verify,
      '並行下でも IP 軸の上限を超えて scrypt を実行してはならない（consume の判定結果を捨てない）',
    ).toHaveBeenCalledTimes(5)
    expect(decisions.filter((d) => d.verified).length, 'verified=true は上限回数だけ').toBe(5)
    expect(
      decisions.filter((d) => d.outcome === 'rate-limited').length,
      '残りは照合せずに rate-limited',
    ).toBe(15)
  })

  it('並行拒否された分は IP 軸のカウンタも進めない（拒否での書き込み増幅を起こさない）', async () => {
    // これが green なら成立しなくなる攻撃:
    //   上限到達後も連投でカウンタ（＝ store への書き込み）を進め続け、
    //   KV 差し替え時に書き込み課金・レイテンシを増幅させる攻撃。
    const ip = createRateLimiter({ limit: 5, windowMs: 10 * 60_000, store: createSlowStore() })
    const guard = createLoginGuard({
      ip,
      account: createRateLimiter({ limit: 100, windowMs: 15 * 60_000 }),
    })

    await Promise.all(
      Array.from({ length: 20 }, () =>
        guard.attempt({ email: ADMIN_EMAIL, ip: ATTACKER_IP, now: T0 }, async () => false),
      ),
    )

    const state = await ip.peek(loginIpKeyFor(ATTACKER_IP), T0)
    expect(state.limit - state.remaining, 'カウンタは上限で止まる').toBe(5)
  })
})

/** テスト側からも同じキー書式を組み立てる（契約に含まれる書式）。 */
function loginIpKeyFor(ip: string): string {
  return `credentials:ip:${ip.trim().toLowerCase()}`
}
