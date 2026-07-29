import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { FORM_SESSION_FREE_ISSUE_LIMIT } from '@/lib/form-session-issue'
import { prisma } from '@/lib/db'

/**
 * =========================================================================
 * P3-c2 結合テスト — **P3c-1**: SEC-057 の修正を `uploads` 経路へ
 *                     「**同じ形で**」適用したことを**実測**する
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-1（:3260。**着手ブロッカー C-1 と同一項目**）、
 *       `docs/review-p3c2-tests-2026-07-29.md` MF-2。
 *
 * ## なぜ配線の綴り検査だけでは足りないのか（MF-2 の指摘）
 * 初版の P3c-1 対応は `uploads-route-contract.test.ts` の**ソース文字列検査 3 行だけ**だった。
 * それは「配線し忘れ」しか捕まえず、**「配線したが上限が緩い」を捕まえない**。
 *
 * 監査 §F 理由 2 が挙げた帰結——**費用・違法画像の受け入れ・orphan 回収の破綻**——は
 * いずれも「**発行数が実際に頭打ちになる**」ことでしか防げない。
 *
 * SEC-057 のときは `form-session-issue-cost.test.ts` と `form-session-cost.int.ts` が
 * 「**Cookie を N 枚取り直しても本体到達数に枚数非依存の上限がある**」ことを実測した。
 * P3c-1 が「**同じ形で**適用する」と言っている以上、**同じ測り方**が要る。
 *
 * ## 縮退構成での算術（SEC-057 と同一）
 * 縮退（`trusted=false`）では発信元軸が `enforce=false`（計数のみ）なので支配しない。
 * 実際に効くのは:
 *
 * > **無コストで得られる Cookie 枚数（`FORM_SESSION_FREE_ISSUE_LIMIT` = 10）
 * >  × 1 枚あたりの発行上限（`UPLOADS_FORM_SESSION_LIMIT`）**
 *
 * ## red 理由
 * `app/api/uploads/license/route.ts` と `UPLOADS_FORM_SESSION_LIMIT` が存在しない。
 *
 * ## ⚠️ 実行前提
 * dev DB 稼働。`VERCEL` は設定しない（縮退構成）。ストレージはローカルアダプタ。
 */

vi.mock('@/lib/turnstile', () => ({ verifyTurnstile: vi.fn(async () => true) }))
vi.mock('@/lib/mail', () => ({ sendMail: vi.fn(async () => {}) }))

const ORIGIN = 'http://localhost:3000'

type UploadsRoute = {
  POST: (request: Request, ctx: never) => Promise<Response>
}

let formSessionRoute: typeof import('@/app/api/form-session/route')
let cookieName: string

beforeAll(async () => {
  process.env.FORM_SESSION_SECRET ??= 'integration-form-session-secret-32chars'
  delete process.env.VERCEL
  const formSession = await import('@/lib/form-session')
  cookieName = formSession.FORM_SESSION_COOKIE_NAME
  formSessionRoute = await import('@/app/api/form-session/route')
})

/**
 * **各テストを新しい無コスト枠で始める（テスト間の状態を共有しない）。**
 *
 * `freshFormSessionCookie()` は本番の `GET /api/form-session` を叩く（設計の意図どおり）。
 * そのルートの `issueLimiter` は**モジュール大域**で、縮退構成の
 * `apply:fs-issue:unknown` は**全要求で 1 個の共有カウンタ**である。
 * ファイル全体は約 1 秒で走り窓（600 秒）は開かないので、**先行するテストが
 * 後続のテストの無コスト枠（`FORM_SESSION_FREE_ISSUE_LIMIT` = 10）を使い切る**——
 * 実測: 単独実行では全件 green、ファイル実行では後半 2 件が達成不能（発行 0 件）。
 *
 * 各テストは**独立した攻撃者シナリオ**なので、枠を持ち越さないほうが測りたいものに忠実である。
 * P3-c1 で直した `news.int.ts` ↔ `news-admin.int.ts` の相互汚染と同型の問題。
 * **アサーションは 1 つも変えていない。**
 */
beforeEach(async () => {
  vi.resetModules()
  formSessionRoute = await import('@/app/api/form-session/route')
})

afterAll(async () => {
  await prisma.$disconnect()
})

/** 未実装なら**各テストが個別に fail** する（`beforeAll` で import して `skipped` を作らない）。 */
async function uploadsRouteModule(): Promise<UploadsRoute> {
  try {
    return (await import('@/app/api/uploads/license/route')) as unknown as UploadsRoute
  } catch (error) {
    expect.fail(
      `app/api/uploads/license/route.ts が未作成（F-009 の成果物）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/** 発行 API の Cookie 軸上限。**実装の定数を import する**（テストに数値を書き写さない）。 */
async function uploadsFormSessionLimit(): Promise<number> {
  const module = (await import('@/lib/storage')) as unknown as {
    UPLOADS_FORM_SESSION_LIMIT?: number
  }
  expect(
    module.UPLOADS_FORM_SESSION_LIMIT,
    'UPLOADS_FORM_SESSION_LIMIT が公開されていない（テストに数値を書き写させない / 設計文書 §11.5-2）',
  ).toBeTypeOf('number')
  return module.UPLOADS_FORM_SESSION_LIMIT!
}

/** **本番経路**で Cookie を 1 枚取る（手組みしない＝ SEC-057 の C-1 と同じ形）。 */
async function freshFormSessionCookie(): Promise<string | null> {
  const response = await formSessionRoute.GET(
    new Request(`${ORIGIN}/api/form-session`, { method: 'GET' }),
  )
  const raw = response.headers.getSetCookie?.() ?? []
  const list = raw.length > 0 ? raw : [response.headers.get('set-cookie') ?? '']
  for (const entry of list) {
    const match = entry.match(new RegExp(`${cookieName}=([^;]*)`))
    if (match && match[1].length > 0) return match[1]
  }
  return null
}

async function issue(cookieValue: string): Promise<Response> {
  const uploadsRoute = await uploadsRouteModule()
  return uploadsRoute.POST(
    new Request(`${ORIGIN}/api/uploads/license`, {
      method: 'POST',
      headers: new Headers({
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: `${cookieName}=${cookieValue}`,
      }),
      body: JSON.stringify({ side: 'front', contentType: 'image/jpeg', size: 1024 }),
    }),
    undefined as never,
  )
}

/** Cookie を `cookies` 枚取り直し、各 Cookie で `perCookie` 回発行を試みる。 */
async function attackerScenario(options: { cookies: number; perCookie: number }) {
  let issued = 0
  const statuses: number[] = []

  for (let n = 0; n < options.cookies; n++) {
    const cookie = await freshFormSessionCookie()
    if (cookie === null) continue
    for (let i = 0; i < options.perCookie; i++) {
      const status = (await issue(cookie)).status
      statuses.push(status)
      if (status === 200) issued++
    }
  }
  return { issued, statuses }
}

/* ========================================================================= *
 * P3c-1: 発行数に**枚数非依存の上限**がある
 * ========================================================================= */

describe('P3c-1 / SEC-057: Cookie を取り直しても署名付き URL の発行総数に上限がある', () => {
  it('Cookie を 40 枚取り直しても、発行できる総数は無コスト枠 × 1 枚あたり上限に収まる', async () => {
    // **本ファイルで最も重要なテスト。P3c-1 の本体（＝ 着手ブロッカー C-1 と同一項目）である。**
    //
    // これが green なら排除される攻撃: 未認証の第三者が縮退構成の本番デプロイに対して
    // **署名付き PUT URL を無制限に発行させる**こと。帰結は監査 §F 理由 2 のとおり:
    //  (a) オブジェクトストレージの**費用**を攻撃者が決められる
    //  (b) **違法画像の受け入れ**（当校のストレージが任意コンテンツの置き場になる）
    //  (c) **orphan 回収バッチの破綻**（1 回 200 件の上限を超える速度で orphan が増える）
    //
    // ⚠️ **「Cookie 1 枚で N+1 回目が 429」を測るテストは根拠にならない**（監査 C-1 の原文）。
    // **攻撃者は同一 Cookie を送らない。** 枚数を変えて測る。
    const limit = await uploadsFormSessionLimit()
    const bound = FORM_SESSION_FREE_ISSUE_LIMIT * limit

    const result = await attackerScenario({ cookies: 40, perCookie: limit + 2 })

    expect(
      result.issued,
      `Cookie を 40 枚取り直すだけで ${result.issued} 件の署名付き URL を発行できた（上界 ${bound} 件）`,
    ).toBeLessThanOrEqual(bound)
  })

  it('発行総数が Cookie 枚数に比例しない（＝ 入手にコストがある）', async () => {
    // SEC-057 の「非比例性」テストと同じ形。
    // これが green なら排除される壊れた修正: 「1 枚あたりの上限」だけを厳しくして
    // **枚数を増やせば総量が増える**構造を残すこと（＝ 何も直っていない）。
    const limit = await uploadsFormSessionLimit()
    const small = await attackerScenario({ cookies: 20, perCookie: limit + 2 })
    const large = await attackerScenario({ cookies: 100, perCookie: limit + 2 })

    expect(
      large.issued,
      `Cookie を 5 倍（20→100 枚）にしたら発行数が ${small.issued} → ${large.issued} に増えた`,
    ).toBeLessThanOrEqual(small.issued)
  })

  it('上界が実測に張り付いている（閾値が緩められたら赤くなる）', async () => {
    // **SEC-070 で SEC-057 側に足したのと同じ pin。**
    // 上界だけを固定すると、実測が上界から離れているとき
    // **上界と実装のどちらが動いても気付けない**。
    // 一致まで測ると「閾値が緩められた」と「防御が壊れた」の両方が同じ 1 件で赤くなる。
    const limit = await uploadsFormSessionLimit()
    const bound = FORM_SESSION_FREE_ISSUE_LIMIT * limit

    const result = await attackerScenario({ cookies: 100, perCookie: limit + 2 })

    expect(
      result.issued,
      `実測 ${result.issued} 件が上界 ${bound} 件から離れている（上界の式か実装が実態とずれている）`,
    ).toBe(bound)
  })

  it('正規利用者（Cookie 1 枚・上限以内）は発行できる（機能不成立を作らない）', async () => {
    // SEC-057 の修正時と同じ配慮。**行き過ぎた修正**——
    // 縮退構成の発行を一律 Tier B にして「閉じた」ことにする——を排除する。
    // それは**ローカル・E2E・非 Vercel 本番で写真を 1 枚も添付できない**状態を意味する。
    const limit = await uploadsFormSessionLimit()
    const result = await attackerScenario({ cookies: 1, perCookie: limit })

    expect(result.issued, '正規利用者が 1 枚も発行できない').toBe(limit)
    expect(result.statuses.every((status) => status === 200)).toBe(true)
  })
})

/* ========================================================================= *
 * 閾値そのものの健全性（MF-2: 上界の制約が無かった）
 * ========================================================================= */

describe('P3c-1: uploads の Tier D 閾値に上界がある', () => {
  it('1 申込あたりの最悪ケース（8 回）を上回り、かつ その 2 倍を超えない', async () => {
    // F-009 の境界値表は**下界しか与えていない**:
    // > 1 申込あたりの最悪ケース（写真 2 枚 ×（初回 1 + 再発行 3））＝ **8 回を上回る値**にすること
    //
    // 上界を決めるのは**テスト設計の仕事**である（MF-2）。
    // 上界が無いと Impl が 1000 と置いても赤くならず、
    // **配線はされているが上限が実質無い**状態が通ってしまう。
    //
    // 2 倍（16）を上界に採る根拠: 正規利用者の最悪ケースに 100% の余裕を持たせれば
    // 「自動再発行 3 回」を使い切った利用者がもう一度やり直しても届かない。
    // それ以上の余裕は**攻撃者の枠を広げるだけで正規利用者を助けない**
    //（無コスト枠 10 枚と掛け算になるので、上限を 2 倍にすると攻撃面も 2 倍になる）。
    const WORST_CASE_PER_APPLICATION = 2 * (1 + 3) // 写真 2 枚 ×（初回 1 + 再発行 3）
    const limit = await uploadsFormSessionLimit()

    expect(limit, '正規利用者の最悪ケース（8 回）を下回っている').toBeGreaterThan(
      WORST_CASE_PER_APPLICATION,
    )
    expect(
      limit,
      `上限 ${limit} は最悪ケースの 2 倍（${WORST_CASE_PER_APPLICATION * 2}）を超えている` +
        '（無コスト枠 10 枚と掛け算になるので攻撃面が広がる）',
    ).toBeLessThanOrEqual(WORST_CASE_PER_APPLICATION * 2)
  })
})
