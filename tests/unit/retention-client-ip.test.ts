import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RETENTION_PERIODS } from '@/lib/retention'
import { FORM_SESSION_ISSUE_WINDOW_MS } from '@/lib/form-session-issue'

/**
 * =========================================================================
 * P3-c1 — **SEC-065 / P3c-10**: `/privacy` に発信元 IP の保持を追記し、
 *          `RETENTION_PERIODS` へ載せる
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-10（:3270）
 *       「`/privacy` に発信元 IP の保持を追記し `RETENTION_PERIODS` へ載せる」
 *
 * ## 何が抜けているのか
 * 現行の `/privacy`（`app/(public)/privacy/page.tsx`）§1「取得する個人情報」は
 * フォームの入力項目しか挙げていない。しかし実装は**発信元 IP を実際に保持している**——
 * レート制限のカウンタキー（`rateLimitKey('applications:', <IP>)` /
 * `rateLimitKey('apply:fs-issue:', <IP>)` / `auth.ts` のログイン IP 軸）として、
 * **ウィンドウの長さだけ**インメモリまたは KV に残る。
 *
 * IP アドレスは日本の個人情報保護法上、単独では個人情報に当たらない場合が多いが、
 * **申込レコードと同一時刻・同一セッションで突合できる**以上、取得の事実と保持期間は
 * 開示しておくのが妥当である（`business-spec.md` §2.3 の方針＝「取得する情報と保持期間を明示する」）。
 *
 * ## `lib/retention.ts` に載せる理由（`lib/retention.ts:4-7` の自己申告）
 *
 * > **`/privacy` の本文も、P3-c / P3-d の削除バッチも、必ずここを参照する。**
 * > 保持期間を画面に直書きすると「利用者に約束した期間」と「実装が実際に削除する期間」が
 * > 食い違いうる。**APPI 上はこの食い違いそのものが不履行になる**ため、値を 1 箇所に閉じる。
 *
 * IP だけを画面に直書きすると、**レート制限の窓を変えた瞬間に約束が嘘になる。**
 * 本ファイルは「定数に載っていること」ではなく
 * **「定数の値が実装の窓と一致していること」**まで測る（それが SEC-065 の実質である）。
 *
 * ## red 理由
 * `RETENTION_PERIODS`（`lib/retention.ts:8-21`）に IP の項目が無く、
 * `/privacy` は IP に一切言及していない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/retention.ts
 * export const RETENTION_PERIODS = {
 *   ...,
 *   /** 発信元 IP（レート制限カウンタのキー）の保持分数。**IP を含む全カウンタの最長窓以上**であること。 *\/
 *   clientIpMinutes: 10,
 * }
 * ```
 * `/privacy` は §1 か §6 で **`RETENTION_PERIODS.clientIpMinutes` を描画**し、
 * 「IP アドレスを不正送信対策のために一時的に保持する / 生の IP をデータベースには保存しない」ことを述べる。
 */

const REPO = process.cwd()

function pageFile(route: string): string | null {
  for (const candidate of [
    resolve(REPO, `app/(public)/${route}/page.tsx`),
    resolve(REPO, `app/${route}/page.tsx`),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function privacySource(): string {
  const file = pageFile('privacy')
  expect(file, '/privacy が見つからない').not.toBeNull()
  return readFileSync(file!, 'utf8')
}

/** `RETENTION_PERIODS` に IP の項目があるか（無ければ型上も存在しないので any 経由で読む）。 */
function clientIpMinutes(): number | undefined {
  return (RETENTION_PERIODS as Record<string, unknown>).clientIpMinutes as number | undefined
}

/**
 * **発信元 IP をキーの材料にする**カウンタの窓（ms）を実装から読み取る。
 *
 * 定数として export されていないものはソースから読む。`RETENTION_PERIODS` が
 * 「実装より短い期間を約束していない」ことを検査するには、**実装側の値が要る**からである
 *（テストに数値を書き写すと、それこそが二重管理になる）。
 */
function ipKeyedWindowsMs(): Record<string, number> {
  const windows: Record<string, number> = {
    // 発行側の軸（`lib/form-session-issue.ts` / export されている）。
    'apply:fs-issue': FORM_SESSION_ISSUE_WINDOW_MS,
  }

  // 送信側の発信元軸（`app/api/applications/route.ts:87`）。
  const routeSource = readFileSync(resolve(REPO, 'app/api/applications/route.ts'), 'utf8')
  const routeWindow = routeSource.match(/RATE_WINDOW_MS\s*=\s*([0-9_]+)/)
  expect(routeWindow, 'RATE_WINDOW_MS が読み取れない（実装の形が変わった）').not.toBeNull()
  windows['applications:source'] = Number(routeWindow![1].replace(/_/g, ''))

  // 管理者ログインの IP 軸（`auth.ts:74`）。
  const authSource = readFileSync(resolve(REPO, 'auth.ts'), 'utf8')
  const loginWindow = authSource.match(
    /LOGIN_IP_LIMITER\s*=\s*createRateLimiter\(\{[^}]*windowMs:\s*([0-9_]+)\s*\*\s*([0-9_]+)/,
  )
  expect(loginWindow, 'LOGIN_IP_LIMITER の窓が読み取れない（実装の形が変わった）').not.toBeNull()
  windows['login:ip'] =
    Number(loginWindow![1].replace(/_/g, '')) * Number(loginWindow![2].replace(/_/g, ''))

  return windows
}

/* ========================================================================= *
 * SEC-065 (1): 定数に載っていること
 * ========================================================================= */

describe('SEC-065 / P3c-10: 発信元 IP の保持期間が RETENTION_PERIODS にある', () => {
  it('clientIpMinutes が定義されている', () => {
    // これが green なら排除される事故: 保持期間が `/privacy` の JSX に**文字列として直書き**され、
    // レート制限の窓を変えたときに**利用者への約束だけが古いまま残る**こと。
    // `lib/retention.ts:4-7` は「APPI 上はこの食い違いそのものが不履行になる」と書いている。
    expect(clientIpMinutes(), 'RETENTION_PERIODS.clientIpMinutes が無い').toBeTypeOf('number')
  })

  it('値が「IP を材料にする全カウンタの最長窓」と一致する（約束と実装がずれない）', () => {
    // **本ファイルで最も重要なテスト。**
    // 「定数に載せた」だけでは SEC-065 は閉じない。載せた値が**実装より短い**と、
    // 「10 分で消します」と書きながら実際は 60 分持っている、という不履行になる。
    //
    // ⚠️ REV-P3C1-007 で**特定の定数との等値をやめた**。
    // 旧: `clientIpMinutes * 60_000 === FORM_SESSION_ISSUE_WINDOW_MS`
    // これは過剰拘束で、将来 `FORM_SESSION_ISSUE_WINDOW_MS` だけが 5 分になると
    // `clientIpMinutes = 5` を強制し、下の「他の窓を超えない」テスト（`RATE_WINDOW_MS = 600_000`）と
    // **同時に満たせなくなる**（＝ 実装者が片方のテストを消す動機が生まれる）。
    // 守りたい性質は「**約束が実装より短くならない**」であって、特定の定数との一致ではない。
    const minutes = clientIpMinutes()
    expect(minutes, 'RETENTION_PERIODS.clientIpMinutes が無い').toBeTypeOf('number')

    const windows = ipKeyedWindowsMs()
    expect(
      (minutes ?? 0) * 60_000,
      `clientIpMinutes が IP 軸の最長窓と一致していない（窓の実測: ${JSON.stringify(windows)}）`,
    ).toBe(Math.max(...Object.values(windows)))
  })

  it('IP をキーにする各カウンタの窓が clientIpMinutes を超えない', () => {
    // `RETENTION_PERIODS` は**単一の真実源**なので、IP を材料にする窓が他に増えたら
    // ここが赤くなること。これが green なら排除される事故:
    // 誰かが `windowMs: 60 * 60_000` の IP 軸を足し、`/privacy` の記載が嘘になること。
    const boundMs = (clientIpMinutes() ?? 0) * 60_000

    for (const [name, windowMs] of Object.entries(ipKeyedWindowsMs())) {
      expect(windowMs, `${name} の窓が clientIpMinutes を超えている`).toBeLessThanOrEqual(boundMs)
    }
  })
})

/* ========================================================================= *
 * SEC-065 (2): 画面に書かれていること
 * ========================================================================= */

describe('SEC-065 / P3c-10: /privacy が発信元 IP の取得と保持を述べている', () => {
  it('IP アドレスに言及している', () => {
    // これが green なら排除される状態: **取得しているのに開示していない**情報が残ること。
    // AC-008-5 / `business-spec.md` §2.3 は「取得する情報と保持期間を明示する」と定めている。
    expect(privacySource(), '/privacy が IP アドレスに言及していない').toMatch(/IP\s*アドレス/)
  })

  it('保持期間を RETENTION_PERIODS から描画している（直書きしない）', () => {
    // `tests/unit/apply-page-contract.test.ts` の既存契約（保持期間は定数から描画する）を
    // IP の行にも適用する。
    const source = privacySource()
    expect(source).toContain('clientIpMinutes')

    // 数値の直書きを禁じる: `10分` のようなリテラルで書かれていないこと。
    //
    // ⚠️ REV-P3C1-012: `clientIpMinutes` が未定義のとき `minutes = 0` になり、
    // `new RegExp('0\\s*分')` が `/privacy` 中の「30日」等の部分文字列に**誤爆**する
    //（未実装なのに「直書きされている」という嘘のメッセージで落ちる）。
    // したがって**数値でない場合は明示的に fail させる**（skip しない）。
    const minutes = clientIpMinutes()
    expect(
      minutes,
      'clientIpMinutes が未定義のため、直書き検査を実行できない（先に定数を足すこと）',
    ).toBeTypeOf('number')

    // 直前の桁に食い込まないよう、数字の境界を明示する（`180日` の `0` に当てない）。
    expect(
      source,
      `保持期間が「${minutes}分」として直書きされている（定数から描画すること）`,
    ).not.toMatch(new RegExp(`(?<![0-9])${minutes}\\s*分`))
  })

  it('生の IP をデータベースに保存していないという記載と、スキーマが一致する', () => {
    // 記載の裏付け。**スキーマに IP 列が足された瞬間に赤くなる**ことで、
    // 「一時的にしか持たない」という記述が嘘になる変更を検出する。
    const schema = readFileSync(resolve(REPO, 'prisma/schema.prisma'), 'utf8')
    const ipColumns = schema
      .split('\n')
      .filter((line) => /^\s*(ip|ipAddress|clientIp|remoteAddr|sourceIp)\s+/i.test(line))
    expect(
      ipColumns,
      `スキーマに IP 列がある: ${ipColumns.join(' / ')}（/privacy の記載と保持期間を見直すこと）`,
    ).toEqual([])
  })
})

/* ========================================================================= *
 * SEC-065 (3): 既存の保持期間を壊さない
 * ========================================================================= */

describe('SEC-065: 既存の RETENTION_PERIODS は不変（退行防止）', () => {
  it('申込 3 年 / 問い合わせ 1 年 / 写真 30 日・180 日 / orphan 24 時間 / 削除請求 14 日', () => {
    expect(RETENTION_PERIODS).toMatchObject({
      applicationYears: 3,
      inquiryYears: 1,
      photoDaysAfterDone: 30,
      photoMaxDaysFromReceipt: 180,
      orphanUploadHours: 24,
      deletionRequestDays: 14,
    })
  })
})
