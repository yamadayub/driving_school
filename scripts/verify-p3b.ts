/**
 * P3-b 自己検証スクリプト（`pnpm exec tsx scripts/verify-p3b.ts`）。
 *
 * ------------------------------------------------------------------------
 * なぜテストと別に置くのか
 * ------------------------------------------------------------------------
 * P3-a では **ユニット 317 件が全 green の状態で、Security 監査の実測により High 2 件が再現した**。
 * 「テストが green になった」は完了根拠にならない。本スクリプトは
 * **実装モジュールへ直接シナリオを投入して脅威が再現しないことを測る**もので、
 * テストの assertion とは独立に、攻撃者の手順をそのまま踏む。
 *
 * 測るもの:
 *   V-1  縮退構成（`trusted=false`）で、第三者が上限まで送信しても
 *        **正規利用者の申込送信が止まらない**（SEC-043 の再発が公開経路で起きていないか）
 *   V-2  形式不正の Cookie を大量に送っても **新しいバケットが無制限に作られない**
 *        （P3b-11 / SEC-055。監査 D-6 の実測手順）
 *   V-3  ハニーポット / 送信間隔違反で **DB 0 件・メール 0 通**
 *   V-4  Cookie を取り直しての連投が **発行側の流量制限**に到達する（AC-RL-13(c) / AC-RL-3 (3)）
 *
 * 外部 I/O（Cloudflare / Resend）だけを `fetch` の差し替えで止め、**アプリのロジックは本物を通す**。
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

/* --- .env の読み込み（tests/integration/setup.ts と同じ最小ローダ）--- */
function loadDotenv(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
loadDotenv(resolve(process.cwd(), '.env'))

// 自動返信の送信経路を「設定済み」にして、送信が起きたかを fetch で観測できるようにする。
process.env.RESEND_API_KEY = 'verify-p3b-dummy-key'

/* --- 外部 I/O の遮断と観測 --- */
const outbound = { turnstile: 0, resend: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.includes('challenges.cloudflare.com')) {
    outbound.turnstile += 1
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
  if (url.includes('api.resend.com')) {
    outbound.resend += 1
    return new Response(JSON.stringify({ id: 'mail_1' }), { status: 200 })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const ORIGIN = 'http://localhost:3000'
const failures: string[] = []

function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label} — ${detail}`)
  if (!ok) failures.push(label)
}

async function main(): Promise<void> {
  const { prisma } = await import('@/lib/db')
  const formSession = await import('@/lib/form-session')
  const route = await import('@/app/api/applications/route')
  const secret = process.env.FORM_SESSION_SECRET ?? ''

  const createdKeys: string[] = []

  function cookieFor(sid: string, ageMs = 10_000): string {
    const value = formSession.createFormSessionValue({ sid, issuedAt: Date.now() - ageMs }, secret)
    return `${formSession.FORM_SESSION_COOKIE_NAME}=${value}`
  }

  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const idempotencyKey = (overrides.idempotencyKey as string) ?? randomUUID()
    createdKeys.push(idempotencyKey)
    return {
      type: 'INQUIRY',
      idempotencyKey,
      name: '検証 太郎',
      nameKana: 'ケンショウ タロウ',
      birthDate: '2000-05-05',
      email: `verify-${idempotencyKey.slice(0, 8)}@example.com`,
      phone: '090-1234-5678',
      firstTime: true,
      referralSources: [],
      message: '自己検証',
      privacyConsent: true,
      captchaToken: 'verify-token',
      hp_field: '',
      ...overrides,
    }
  }

  async function post(payload: Record<string, unknown>, cookie?: string): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN, 'content-type': 'application/json' })
    if (cookie) headers.set('cookie', cookie)
    return route.POST(
      new Request(`${ORIGIN}/api/applications`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }),
      undefined as never,
    )
  }

  /* ================================================================= *
   * V-1: 縮退構成で第三者が上限まで送信しても正規利用者が止まらない
   * ================================================================= */
  // このプロセスは `VERCEL !== '1'` なので `resolveClientIp` は `trusted=false`（縮退）。
  // SEC-043 が再発していれば、共有 `unknown` バケットの枯渇で正規利用者も 429 になる。
  const attackerCookie = cookieFor('a'.repeat(32))
  const attackerStatuses: number[] = []
  for (let i = 0; i < 12; i++) {
    attackerStatuses.push((await post(body(), attackerCookie)).status)
  }
  const victim = await post(body(), cookieFor('b'.repeat(32)))
  check(
    'V-1 縮退構成で第三者の上限到達が正規利用者を巻き込まない（SEC-043）',
    victim.status === 201 && attackerStatuses.slice(3).every((status) => status === 429),
    `攻撃者=${attackerStatuses.join(',')} / 正規利用者=${victim.status}`,
  )

  /* ================================================================= *
   * V-2: 形式不正 Cookie でバケットが増殖しない（P3b-11 / SEC-055）
   * ================================================================= */
  const { createMemoryRateLimitStore, createRateLimiter } = await import('@/lib/rate-limit')
  const { withPublicMutation } = await import('@/lib/public-guard')
  const probeStore = createMemoryRateLimitStore()
  const probeGuard = withPublicMutation(async () => Response.json({ ok: true }, { status: 201 }), {
    endpoint: 'applications',
    requireContentType: 'json',
    limiters: {
      source: createRateLimiter({ limit: 1_000_000, windowMs: 600_000, store: probeStore }),
      formSession: createRateLimiter({ limit: 3, windowMs: 600_000, store: probeStore }),
    },
    formSessionKey: formSession.formSessionAxisKey,
    verifyFormSession: (request, now) =>
      formSession.verifyFormSessionValue(formSession.readFormSessionCookie(request), secret, now) !==
      null,
  })

  const baseline = probeStore.size()
  for (let i = 0; i < 2_000; i++) {
    // 署名部が 43 文字でない = 形式不正。1 リクエストにつき 1 つ新しい値。
    const malformed = `${String(i).padStart(24, '0')}.short`
    await probeGuard(
      new Request(`${ORIGIN}/api/applications`, {
        method: 'POST',
        headers: new Headers({
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: `${formSession.FORM_SESSION_COOKIE_NAME}=${malformed}`,
        }),
        body: '{}',
      }),
      undefined,
    )
  }
  const afterMalformed = probeStore.size()
  check(
    'V-2 形式不正 Cookie 2,000 種でフォームセッション軸のバケットが増えない（SEC-055）',
    afterMalformed - baseline <= 1,
    `store 件数 ${baseline} → ${afterMalformed}（増分は発信元軸の 1 件のみが期待値）`,
  )

  // 残余リスクの定量化（過大報告を防ぐ）: 形式を満たす値は攻撃者にも作れる。
  const wellFormedKeys = new Set(
    Array.from({ length: 2_000 }, (_unused, i) =>
      formSession.formSessionAxisKeyFromValue(`${String(i).padStart(24, '0')}.${'b'.repeat(43)}`),
    ),
  )
  console.log(
    `[INFO] 残余リスク: 形式を満たす値 2,000 種からは ${wellFormedKeys.size} 個の軸キーが作れる` +
      '（閉じ切るのは P3b-2 = KV の TTL ベース。SEC-055 は「完全に閉じた」と報告しない）',
  )

  /* ================================================================= *
   * V-3: ハニーポット / 送信間隔違反で DB 0 件・メール 0 通
   * ================================================================= */
  const mailBefore = outbound.resend

  const honeypotBody = body({ hp_field: 'http://spam.example.com/buy' })
  const honeypot = await post(honeypotBody, cookieFor('c'.repeat(32)))
  const honeypotRows = await prisma.application.count({
    where: { idempotencyKey: honeypotBody.idempotencyKey as string },
  })

  const fastBody = body()
  // Cookie 発行から 500ms しか経っていない送信（AC-RL-6 の下限 3 秒未満）。
  const fast = await post(fastBody, cookieFor('d'.repeat(32), 500))
  const fastRows = await prisma.application.count({
    where: { idempotencyKey: fastBody.idempotencyKey as string },
  })

  check(
    'V-3a ハニーポット非空は Tier B・DB 0 件（AC-010-3）',
    honeypot.status === 403 && honeypotRows === 0,
    `status=${honeypot.status} rows=${honeypotRows}`,
  )
  check(
    'V-3b 送信間隔 3 秒未満は Tier B・DB 0 件（AC-RL-6）',
    fast.status === 403 && fastRows === 0,
    `status=${fast.status} rows=${fastRows}`,
  )
  check(
    'V-3c 上記 2 経路でメールを 1 通も送っていない',
    outbound.resend === mailBefore,
    `Resend 呼び出し ${mailBefore} → ${outbound.resend}`,
  )

  const honeypotJson = (await honeypot.json()) as Record<string, unknown>
  const fastJson = (await fast.json()) as Record<string, unknown>
  check(
    'V-3d 2 経路の応答が完全に一致する（降格理由を区別させない / 契約ルール3）',
    JSON.stringify(honeypotJson) === JSON.stringify(fastJson) &&
      honeypot.headers.get('retry-after') === fast.headers.get('retry-after'),
    `${JSON.stringify(honeypotJson)} / ${JSON.stringify(fastJson)}`,
  )

  /* ================================================================= *
   * V-4: Cookie 取り直しの連投は発行側の流量制限に到達する（AC-RL-13(c)）
   * ================================================================= */
  const { issueFormSession, FORM_SESSION_ISSUE_LIMIT } = await import('@/lib/form-session-issue')
  const issueLimiter = createRateLimiter({ limit: FORM_SESSION_ISSUE_LIMIT, windowMs: 600_000 })
  const trusted = { key: '198.51.100.9', trusted: true, source: 'x-forwarded-for' as const }
  const issued: boolean[] = []
  for (let i = 0; i < FORM_SESSION_ISSUE_LIMIT + 1; i++) {
    issued.push((await issueFormSession({ clientIp: trusted, limiter: issueLimiter, secret })).issued)
  }
  check(
    `V-4 信頼できる発信元からの ${FORM_SESSION_ISSUE_LIMIT + 1} 回目の Cookie 発行が Tier D になる`,
    issued.slice(0, FORM_SESSION_ISSUE_LIMIT).every(Boolean) && issued[FORM_SESSION_ISSUE_LIMIT] === false,
    `発行成功 ${issued.filter(Boolean).length} / ${issued.length}`,
  )

  const degraded = { key: 'unknown', trusted: false, source: 'unknown' as const }
  const degradedLimiter = createRateLimiter({ limit: FORM_SESSION_ISSUE_LIMIT, windowMs: 600_000 })
  const degradedIssued: boolean[] = []
  for (let i = 0; i < 40; i++) {
    degradedIssued.push(
      (await issueFormSession({ clientIp: degraded, limiter: degradedLimiter, secret })).issued,
    )
  }
  check(
    'V-4b 縮退時は共有 unknown バケットで発行を止めない（第三者が /apply を封鎖できない）',
    degradedIssued.every(Boolean),
    `発行成功 ${degradedIssued.filter(Boolean).length} / ${degradedIssued.length}`,
  )

  /* --- 後始末 --- */
  await prisma.application.deleteMany({ where: { idempotencyKey: { in: createdKeys } } })
  await prisma.$disconnect()

  console.log(`\n外部 I/O: Turnstile ${outbound.turnstile} 回 / Resend ${outbound.resend} 回`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} 件の検証が失敗した: ${failures.join(' / ')}`)
    process.exitCode = 1
  } else {
    console.log('\nすべての自己検証を満たした。')
  }
}

void main()
