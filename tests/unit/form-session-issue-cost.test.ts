import { describe, it, expect, vi } from 'vitest'
import {
  FORM_SESSION_FREE_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_LIMIT,
  FORM_SESSION_ISSUE_WINDOW_MS,
  issueFormSession,
} from '@/lib/form-session-issue'
import {
  FORM_SESSION_COOKIE_NAME,
  createFormSessionValue,
  formSessionAxisKey,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { withPublicMutation, type PublicGuardOptions } from '@/lib/public-guard'
import { createRateLimiter } from '@/lib/rate-limit'
import type { ClientIpResolution } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-b 差し戻し — **SEC-057（High / P3-c 着手の唯一のブロッカー）**
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` SEC-057（:2869）/ §B B-1（:2747）、
 *       `docs/p3b-fix-plan-2026-07-29.md`「核心（P3-c にも適用する原則）」。
 *
 * ## 監査者の実測（縮退構成 / `VERCEL` 未設定 = `trusted:false`）
 * ```
 * GET  /api/form-session  × 20  → 429 は 0 回。Cookie を 20 枚取得
 * POST /api/applications  × 60  → 201 が 60 件 / 429 が 0 件
 *                                 （DB 行 60 + 自動返信メール 60 通の経路が成立）
 * ```
 *
 * ## 契約化した原則（**このファイルの存在理由**）
 * > P3b-1b は「Cookie 軸は要求元ごとに一意」を型（`PerRequesterKey`）で保証した。
 * > しかし **軸として機能するために必要なのは「一意であること」ではなく
 * > 「入手にコストがあること」である。**
 *
 * 「一意性」は型で表現できるが、「入手コスト」は型では表現できない——
 * **観測できるのは振る舞いだけ**である。したがって本ファイルは次の 1 文を契約にする:
 *
 * > **縮退構成において、単一の攻撃者が本体（DB 書き込み・メール送信）へ到達させられる回数は、
 * > 取り直した Cookie の枚数に比例してはならない（＝ 枚数に依存しない上限を持つ）。**
 *
 * これは実装方法を指定しない。監査が挙げた (a)（発行時の未検証フラグ）でも
 * (b)（発行時にも Turnstile）でも、あるいは別案でも、この性質を満たせば green になる。
 *
 * ## 同時に壊してはならない 2 つの性質（**片方だけ守ると別の欠陥になる**）
 * 1. **発行そのものを止めない**（`lib/form-session-issue.ts:16-18` / SEC-043 / SEC-021）。
 *    止めると第三者が 30 回叩くだけで**全利用者が `/apply` を開けなくなる**。
 * 2. **正規利用者を硬い拒否（429）に落とさない。** 共有 `unknown` バケットを根拠にした 429 は
 *    SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度再発した欠陥そのものである。
 *    課してよいコストは**回復可能なもの**（Tier B / CAPTCHA）に限る。
 *
 * ## 併記: RV-P3B-002（`?fs=1` の発行導線）と同じコードに触れる
 * 発行経路を変えるので、`tests/unit/application-form-client-wiring.test.ts` と
 * `tests/integration/form-session-route.int.ts` を同時に見ること。
 */

const ENDPOINT = 'applications' as const
const ORIGIN = 'https://example.test'
const SECRET = 'sec057-form-session-secret-32-characters'

/** Cookie の発行時刻と、送信時刻（送信間隔下限 3 秒を跨ぐ）。 */
const ISSUED_AT = Date.UTC(2026, 6, 29, 6, 0, 0)
const NOW = ISSUED_AT + 10_000

/** 送信側の Cookie 軸上限（`app/api/applications/route.ts:91`）。 */
const FORM_SESSION_LIMIT = 3
/** 送信側の発信元軸上限（同 :89）。縮退では計数のみ。 */
const SOURCE_LIMIT = 5

/**
 * **縮退構成における本体到達数の上界**（SEC-070 / P3c-6 の是正）。
 *
 * ------------------------------------------------------------------------
 * なぜ `FORM_SESSION_ISSUE_LIMIT`(30) ではなく無コスト枠を基準にするのか
 * ------------------------------------------------------------------------
 * 再監査（`docs/security-p3b-reaudit-2026-07-29.md` SEC-070）の指摘:
 *
 * > 実際の到達数は 30 だが、固定されている上界は 60 / 90 である。
 * > `FORM_SESSION_FREE_ISSUE_LIMIT` が将来 10 → 19 に緩められても（到達数 57）
 * > **両テストとも green のまま**通る。非比例性テストは有効だが、
 * > **絶対量の退行**は捕まえられない。
 *
 * 縮退では発行側の 30 が**ゲートにならない**（共有 `unknown` バケット）ので、
 * 到達数を実際に決めているのは「**無コストで得られる Cookie 枚数** × 1 枚あたりの送信上限」である。
 * したがって上界は `FORM_SESSION_FREE_ISSUE_LIMIT × FORM_SESSION_LIMIT`。
 *
 * **数値リテラルの二重管理にしない**（定数から計算する）。閾値を緩める変更が入った瞬間に、
 * この式が自動的に追随して**新しい実測値との差**だけが露見する。
 */
const DEGRADED_REACH_BOUND = FORM_SESSION_FREE_ISSUE_LIMIT * FORM_SESSION_LIMIT

const DEGRADED: ClientIpResolution = { key: 'unknown', trusted: false, source: 'unknown' }
const TRUSTED: ClientIpResolution = { key: '198.51.100.5', trusted: true, source: 'x-forwarded-for' }

function request(cookieValue: string | null): Request {
  const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
  if (cookieValue !== null) headers.set('cookie', `${FORM_SESSION_COOKIE_NAME}=${cookieValue}`)
  return new Request(`${ORIGIN}/api/applications`, { method: 'POST', headers, body: '{}' })
}

/**
 * **本番と同じ結線**（`app/api/applications/route.ts:337-353` の写し）。
 * テスト専用の簡略配線を作らない（P2 の「テスト対象の取り違え」）。
 *
 * ⚠️ Impl へ: 縮退時の判定を**ルートのラムダに書かない**こと。判定の複製は AC-RL-8 違反であり、
 * ここ（正典関数）を通らない実装は本ファイルを green にできない。
 * 正典側（`lib/form-session.ts` / `lib/form-session-issue.ts`）に閉じること。
 */
function productionWiring(overrides: Partial<PublicGuardOptions> = {}): PublicGuardOptions {
  return {
    endpoint: ENDPOINT,
    requireContentType: 'json',
    limiters: {
      source: createRateLimiter({ limit: SOURCE_LIMIT, windowMs: 600_000 }),
      formSession: createRateLimiter({ limit: FORM_SESSION_LIMIT, windowMs: 600_000 }),
    },
    formSessionKey: formSessionAxisKey,
    verifyFormSession: (req, at) =>
      verifyFormSessionValue(readFormSessionCookie(req), SECRET, at) !== null,
    clientIp: () => DEGRADED,
    now: () => NOW,
    ...overrides,
  }
}

interface ScenarioResult {
  /** 発行に成功した Cookie の枚数。 */
  issued: number
  /** 本体（handler）へ到達した回数 = DB 行 + 自動返信メールが発生する回数。 */
  reached: number
  statuses: number[]
}

/**
 * **監査者の手順そのもの**: Cookie を `cookies` 枚取り直し、各 Cookie で `perCookie` 回送信する。
 * limiter は毎回作り直す（シナリオ間で状態を持ち越さない）。
 */
async function attackerScenario(options: {
  cookies: number
  perCookie: number
  clientIp?: ClientIpResolution
}): Promise<ScenarioResult> {
  const clientIp = options.clientIp ?? DEGRADED
  const issueLimiter = createRateLimiter({
    limit: FORM_SESSION_ISSUE_LIMIT,
    windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
  })
  const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
  const guarded = withPublicMutation(handler, productionWiring({ clientIp: () => clientIp }))

  const statuses: number[] = []
  let issued = 0

  for (let n = 0; n < options.cookies; n++) {
    const result = await issueFormSession({
      clientIp,
      limiter: issueLimiter,
      secret: SECRET,
      now: () => ISSUED_AT,
    })
    if (!result.issued) continue
    issued++
    for (let i = 0; i < options.perCookie; i++) {
      statuses.push((await guarded(request(result.cookieValue), undefined)).status)
    }
  }

  return { issued, reached: handler.mock.calls.length, statuses }
}

/* ========================================================================= *
 * SEC-057 (1): 監査者の実測をそのまま閉じる
 * ========================================================================= */

describe('SEC-057: 縮退構成で Cookie を取り直しても流量上限が消えない', () => {
  it('監査実測の再現 — Cookie 20 枚 × 3 回 = 60 送信が全て通ってはならない', async () => {
    // **本ファイルで最も重要なテスト。SEC-057 の実測そのものである。**
    // これが green なら排除される攻撃: 未認証の第三者が縮退構成の本番デプロイに対して
    //  (a) **無制限に DB 行を作る**（氏名・生年月日・住所・連絡先に任意の値が入る）、
    //  (b) **無制限に当校ドメインから第三者へメールを送る**（宛先を変えれば AC-RL-14 の
    //      3通/時は効かない。監査の実行中に Resend 呼び出しが 68 回発生した）、
    //  (c) F-017 の受信管理を実質使用不能にする。
    // P3-b は**個人情報を実際に受信する最初の単位**であり、無制限受付は
    // 「保管義務のあるデータの無制限流入」を意味する。
    const result = await attackerScenario({ cookies: 20, perCookie: 3 })

    expect(result.issued, '発行そのものは止めない（第三者に /apply を封鎖させない）').toBe(20)
    // **SEC-070: 境界は `60` ではなく無コスト枠から計算した値で締める。**
    // `toBeLessThan(60)` のままだと `FORM_SESSION_FREE_ISSUE_LIMIT` が 10 → 19 に
    // 緩められても（到達数 57）green で通ってしまい、**絶対量の退行を検出できない**。
    expect(
      result.reached,
      `Cookie を取り直すだけで ${result.reached} 回が本体へ到達した（上界 ${DEGRADED_REACH_BOUND} 回 / SEC-057 の再現）`,
    ).toBeLessThanOrEqual(DEGRADED_REACH_BOUND)
  })

  it('本体到達数は Cookie 枚数に比例しない（＝ 入手にコストがある）', async () => {
    // **「入手コスト」を契約に落とした本体。**
    // 一意性（`PerRequesterKey`）は型で表せるが、入手コストは**スケールを変えて測る**しかない。
    // これが green なら排除される壊れた修正: 「1 枚あたりの上限」だけを厳しくして
    // **枚数を増やせば総量が増える**構造を残すこと（＝ 何も直っていない）。
    const small = await attackerScenario({ cookies: 40, perCookie: 3 })
    const large = await attackerScenario({ cookies: 200, perCookie: 3 })

    expect(
      large.reached,
      `Cookie を 5 倍（40→200 枚）にしたら本体到達が ${small.reached} → ${large.reached} に増えた`,
    ).toBeLessThanOrEqual(small.reached)
  })

  it('縮退構成での本体到達数に、Cookie 枚数に依存しない上限が存在する', async () => {
    // 上限値そのものは Impl の設計判断だが、**存在しなければならない**。
    //
    // **SEC-070 で基準を締めた。** 旧基準は `FORM_SESSION_ISSUE_LIMIT`(30) × `FORM_SESSION_LIMIT`(3)
    // = 90 だったが、縮退では発行側の 30 が**ゲートにならない**（共有 `unknown` バケット）ので、
    // 到達数を実際に決めているのは**無コスト枠**である。基準を
    // `FORM_SESSION_FREE_ISSUE_LIMIT × FORM_SESSION_LIMIT` に置き換える。
    const result = await attackerScenario({ cookies: 200, perCookie: 3 })
    expect(
      result.reached,
      `縮退構成で ${result.reached} 回が本体へ到達した（上界 ${DEGRADED_REACH_BOUND} 回）`,
    ).toBeLessThanOrEqual(DEGRADED_REACH_BOUND)
  })

  it('到達数の上界が「たまたま緩い」のではなく、実測が上界に張り付いていることを確認する', async () => {
    // **SEC-070 の本体。**
    // 上界だけを固定すると、実測が上界から大きく離れているとき（例: 実測 30 / 上界 90）に
    // **上界と実装のどちらが動いても気付けない**。実測が上界に一致していることまで測ると、
    // 「閾値が緩められた」と「防御が壊れた」の**両方**が同じ 1 件で赤くなる。
    //
    // これが green なら排除される退行: `FORM_SESSION_FREE_ISSUE_LIMIT` を 10 → 19 に
    // 緩める変更が、**どのテストも赤くせずに**通ること（監査 SEC-070 の指摘そのもの）。
    const result = await attackerScenario({ cookies: 200, perCookie: 3 })
    expect(
      result.reached,
      `実測 ${result.reached} 回が上界 ${DEGRADED_REACH_BOUND} 回から離れている` +
        '（上界の式か実装のどちらかが実態とずれている）',
    ).toBe(DEGRADED_REACH_BOUND)
  })

  it('上界の式が発行側の硬い上限（30）より小さい（縮退では無コスト枠が支配的である）', () => {
    // 式そのものの健全性。`FORM_SESSION_FREE_ISSUE_LIMIT` が
    // `FORM_SESSION_ISSUE_LIMIT` を超えると、無コスト枠が意味を失う（印が一度も付かない）。
    expect(FORM_SESSION_FREE_ISSUE_LIMIT).toBeLessThan(FORM_SESSION_ISSUE_LIMIT)
    expect(DEGRADED_REACH_BOUND).toBeLessThan(FORM_SESSION_ISSUE_LIMIT * FORM_SESSION_LIMIT)
  })
})

/* ========================================================================= *
 * SEC-057 (2): コストを課しても壊してはならないもの
 * ========================================================================= */

describe('SEC-057: コストの課し方が新たな欠陥にならない（SEC-043 の 5 度目を作らない）', () => {
  it('縮退構成でも、通常の利用者（Cookie 1 枚・3 回以内）は本体へ到達する', async () => {
    // これが green なら排除される「行き過ぎた修正」: 縮退構成の送信を一律 Tier B にして
    // SEC-057 を「閉じた」ことにすること。**それはローカル・E2E・Vercel 以外の本番で
    // フォームが 1 件も受け付けられない状態**（RV-P3B-001 と同じ「機能不成立」）を意味する。
    const result = await attackerScenario({ cookies: 1, perCookie: 3 })
    expect(result.reached, '正規利用者の 3 回が通らない').toBe(3)
    expect(result.statuses).toEqual([201, 201, 201])
  })

  it('攻撃者が枠を使い切った後も、新しい利用者は 429（硬い拒否）に落ちない', async () => {
    // **SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度再発した欠陥の再発防止。**
    // 共有 `unknown` バケットの枯渇を根拠に 429 を返すと、第三者が枠を使い切るだけで
    // **全利用者が窓（10 分）明けまで送信不能**になる。
    // 課してよいコストは**回復可能なもの**（Tier B = 403 + challenge → CAPTCHA で抜けられる）に限る。
    // これが green なら排除される修正: 「共有バケットで 429」という最も安直な塞ぎ方。
    const issueLimiter = createRateLimiter({
      limit: FORM_SESSION_ISSUE_LIMIT,
      windowMs: FORM_SESSION_ISSUE_WINDOW_MS,
    })
    const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
    const guarded = withPublicMutation(handler, productionWiring())

    for (let n = 0; n < 200; n++) {
      const attacker = await issueFormSession({
        clientIp: DEGRADED,
        limiter: issueLimiter,
        secret: SECRET,
        now: () => ISSUED_AT,
      })
      if (attacker.issued) {
        for (let i = 0; i < 3; i++) await guarded(request(attacker.cookieValue), undefined)
      }
    }

    const victim = await issueFormSession({
      clientIp: DEGRADED,
      limiter: issueLimiter,
      secret: SECRET,
      now: () => ISSUED_AT,
    })
    expect(victim.issued, '第三者の消費で発行が止まっている（/apply の封鎖）').toBe(true)
    if (!victim.issued) return

    const response = await guarded(request(victim.cookieValue), undefined)
    expect(
      response.status,
      '新しい利用者が 429（窓明けまで回復不能）に落ちている',
    ).not.toBe(429)
    expect([201, 403], `想定外のステータス: ${response.status}`).toContain(response.status)
  })

  it('通常構成（trusted=true）の振る舞いは変わらない（退行なし）', async () => {
    // SEC-057 は**縮退構成でのみ成立する**（監査の明示）。修正が通常構成の
    // 「発信元軸 5 回/10 分」を壊していないことを固定する。
    // これが green なら排除される退行: 縮退対策を全構成へ適用し、Vercel 上の
    // 正規利用者まで CAPTCHA 地獄に落とすこと。
    const result = await attackerScenario({ cookies: 20, perCookie: 3, clientIp: TRUSTED })
    expect(result.reached, '通常構成では発信元軸（5 回/10 分）が支配的である').toBe(SOURCE_LIMIT)
  })

  it('既存の createFormSessionValue({ sid, issuedAt }) で作った値は引き続き検証を通る', async () => {
    // **後方互換の固定。** 発行側にフラグ等を足す修正が、
    // `tests/integration/applications.int.ts` の手組み Cookie（63 本の結合テストが依存）を
    // 一括で無効化しないこと。**既定は「検証済み」**であり、コストの印は opt-in で付けること。
    // これが green なら排除される事故: 修正と同時に既存 63 integration が全部赤くなり、
    // 「テストのほうを直す」圧力が生まれること。
    const handler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))
    const guarded = withPublicMutation(handler, productionWiring())
    const legacy = createFormSessionValue({ sid: 'a'.repeat(32), issuedAt: ISSUED_AT }, SECRET)

    const response = await guarded(request(legacy), undefined)
    expect(response.status, '既存形式の Cookie が Tier B に落ちている').toBe(201)
  })
})
