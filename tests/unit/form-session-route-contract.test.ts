import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractOptionExpression, extractOptionValue } from './helpers/route-source'

/**
 * =========================================================================
 * P3-c2 — **MF-3**: 回復経路 `POST /api/form-session` の**配線契約**
 * =========================================================================
 *
 * 出典: `docs/review-p3c2-tests-2026-07-29.md` MF-3、
 *       `docs/security-audit.md` SEC-053 / SEC-058（構築時検査の原則）。
 *
 * ## なぜ「ラッパを通る」だけでは足りないのか
 * `POST /api/form-session` は**新しい公開変更系エンドポイント**である。
 * 初版は `form-session-recovery.int.ts` で「ラッパを通ること」（Origin 検証と
 * `challenge` を含まない 403）しか測っておらず、
 * **`limiters` / `formSessionKey` / `semaphore` を要求する pin が 1 件も無かった。**
 *
 * **構築時検査（SEC-058）は保険にならない。** `lib/public-guard.ts` の検査は
 * 「軸を 1 つも渡さない構成」（構成表の (0)）を**意図的に throw しない**——
 * ラッパを Origin / Content-Type 検証だけに使う経路を想定しているためである。
 * したがって
 *
 * ```ts
 * export const POST = withPublicMutation(handler, {
 *   endpoint: 'form-session',
 *   requireContentType: 'json',
 *   verifyFormSession: ...,        // limiters を丸ごと書かない
 * })
 * ```
 *
 * は**構築時にも結合テストにも捕まらない**。この形だと **Tier D 軸がゼロの公開エンドポイント**が
 * できる——そこは **Turnstile の siteverify（外部 API）を無制限に叩ける入口**でもあり、
 * 当校の Turnstile クォータと Cloudflare への往復を未認証の第三者が自由に消費できる。
 *
 * SEC-058 で構築時検査を全構成へ広げたときの原則は「**軸は完成しているか、最初から無いか**」であり、
 * (0) を許したのは Origin / Content-Type 検証だけに使う経路のためだった。
 * **回復経路は「印の無い Cookie を発行する」エンドポイント**なので、その想定に当てはまらない。
 *
 * ## `endpoint` の決定: **`'form-session'` に分ける**（理由は設計文書 §7）
 * 初版の契約コードは `endpoint: 'applications'` を指定していたが**根拠が書かれていなかった**。
 * これは §5 が uploads について「`endpoint: 'uploads'`（**applications のセマフォと混ざらない**）」
 * と書いた原則と正面から矛盾する。`'applications'` を採ると、回復要求が
 * **申込送信と同じ発信元軸・同じセマフォ**を消費する——
 * `trusted` では発信元軸は 5 回/10 分の**硬いゲート**なので、
 * **「回復を試みたせいで申込そのものが 429 になる」**という、直そうとした欠陥と同型の経路ができる。
 *
 * ## red 理由
 * `app/api/form-session/route.ts` に `POST` が存在しない。
 */

const ROUTE_FILE = resolve(process.cwd(), 'app/api/form-session/route.ts')

function routeSource(): string {
  return readFileSync(ROUTE_FILE, 'utf8')
}

/** `POST` の定義以降だけを切り出す（`GET` の配線と混同しない）。 */
function postSection(): string {
  const source = routeSource()
  const index = source.search(/export\s+const\s+POST\s*=/)
  expect(index, 'POST /api/form-session（SEC-067 の回復経路）が未実装').toBeGreaterThanOrEqual(0)
  return source.slice(index)
}

/* ========================================================================= *
 * MF-3: uploads と**同じ 7 項目**を POST に対して固定する
 * ========================================================================= */

describe('MF-3 / SEC-067: POST /api/form-session の配線（uploads と同じ 7 項目）', () => {
  it('1. POST が withPublicMutation を通る', () => {
    expect(routeSource()).toMatch(/export\s+const\s+POST\s*=\s*withPublicMutation\s*[<(]/)
  })

  it('2. limiters に source を渡している', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される攻撃: Tier D 軸がゼロの公開エンドポイントを作り、
    // **Turnstile の siteverify を無制限に叩かせる**こと
    //（当校の Turnstile クォータと Cloudflare への往復を第三者が自由に消費できる）。
    const limiters = extractOptionValue(postSection(), 'limiters')
    expect(limiters, 'limiters が渡されていない（Tier D 軸がゼロになる）').not.toBeNull()
    expect(limiters!).toMatch(/\bsource\s*:/)
  })

  it('3. limiters に formSession を渡している', () => {
    // 縮退構成では発信元軸が計数のみになるため、**enforce される軸は Cookie 軸だけ**である。
    // ここを落とすと縮退で Tier D が消える（SEC-053 / P3b-1 と同じ形）。
    const limiters = extractOptionValue(postSection(), 'limiters')
    expect(limiters, 'limiters が渡されていない').not.toBeNull()
    expect(limiters!, 'limiters.formSession が無い').toMatch(/\bformSession\s*:/)
  })

  it('4. endpoint を form-session に分けている（applications の枠を食わない）', () => {
    // これが green なら排除される事故: 回復要求が**申込送信と同じ発信元軸・同じセマフォ**を消費し、
    // **「回復を試みたせいで申込が 429 / 202 になる」**こと。
    // 回復は申込送信よりはるかに軽い操作であり、同じ枠を食い合う理由が無い。
    expect(postSection()).toMatch(/endpoint\s*:\s*['"]form-session['"]/)
  })

  it('5. formSessionKey に正典の formSessionAxisKey を渡している', () => {
    // SEC-052。`?? 'anonymous'` 型の固定値フォールバックを封じる。
    expect(postSection()).toMatch(/formSessionKey\s*:\s*formSessionAxisKey\b/)
  })

  it('6. semaphore（Tier C）を渡している', () => {
    // 回復経路は Turnstile の siteverify（外部 API への往復）を伴う。
    // 共有軸の枯渇は 429 ではなく 202（AC-RL-12）。
    expect(postSection()).toMatch(/semaphore\s*:/)
  })

  it('7. clientIp を ClientIpResolution のまま渡している（trusted を捨てない）', () => {
    // SEC-043。`.key` だけを取り出す配線は縮退構成の防御を無効化する。
    expect(postSection()).toMatch(/clientIp\s*:\s*\(?\s*\w*\s*\)?\s*=>\s*resolveClientIp\(/)
  })
})

/* ========================================================================= *
 * SEC-067: 回復経路そのものの契約（ソースで固定できる部分）
 * ========================================================================= */

describe('SEC-067: 回復経路がサーバー側で検証したトークンだけを渡す', () => {
  it('verifyTurnstile をルート内で呼んでいる', () => {
    // P3-c1 §12.2-3 の禁止事項:
    // > **`challengeToken` にクライアントの自己申告を「検証済み」として渡さない。**
    // > ルート側で `verifyTurnstile` を実行し、**成功したときだけ**そのトークンを渡すこと。
    // これが green なら排除される事故: ボディの値を無検証で `challengeToken` へ流し、
    // **印が 1 行で無効化される**こと（＝ 無コスト枠が実質無制限になる / SEC-057 の再来）。
    expect(postSection()).toMatch(/\bverifyTurnstile\b/)
  })

  it('challengeToken を issueFormSession へ渡している', () => {
    expect(postSection()).toMatch(/challengeToken\s*:/)
  })

  it('verifyFormSession は Cookie の「存在」だけを見る（印の有無で弾かない）', () => {
    // **本ファイルで 2 番目に重要なテスト。設計時に危うく踏むところだった穴である。**
    //
    // `verifyFormSession` を渡さないと、`lib/public-guard.ts` の条件1'-3
    //   `if (!resolved.trusted && !verifyFormSession) return TIER_B()`
    // により **縮退構成（＝ SEC-067 が成立する唯一の構成）で回復経路の全リクエストが Tier B** になる。
    // 逆に `verifyFormSessionValue` を使うと**印の付いた Cookie が弾かれ**、
    // 回復できる人が誰もいなくなる（uploads の契約を機械的に横展開するとこうなる）。
    // 正しいのは「Cookie の**存在**だけを見る」。
    //
    // ------------------------------------------------------------------
    // ⚠️ CR-002: **この検査は初版で空振りしていた**
    // ------------------------------------------------------------------
    // 初版はセクション全文へ `toMatch(/readFormSessionCookie/)` を掛けており、
    // **`hasVerifiedSession` を計算する無関係な行**
    //   `const presented = verifyFormSessionValue(readFormSessionCookie(request), …)`
    // に一致していた。そのため `verifyFormSession: () => true` という
    // **契約違反の実装に対しても 3 つの assertion すべてが通っていた**。
    //
    // **オプションの値そのものを切り出して検査する。**
    // MF-2 で `extractOptionValue` を入れた目的（「ファイル内のどこかに綴りがあれば通る」形の排除）が、
    // 同じファイルの 1 箇所だけ適用されずに残り、**そこが実際に破られた**。
    const value = extractOptionExpression(postSection(), 'verifyFormSession')

    expect(value, 'verifyFormSession が渡されていない（縮退で全 Tier B になる）').not.toBeNull()
    expect(
      value!,
      `Cookie の存在を見ていない（() => true 等で素通りしている / 実際の値: ${value}）`,
    ).toMatch(/readFormSessionCookie/)
    expect(
      value!,
      'verifyFormSessionValue を使っている（印の付いた Cookie が弾かれ、回復できる人が誰もいなくなる）',
    ).not.toMatch(/verifyFormSessionValue/)
  })

  it('GET 側の配線を壊していない（既存の発行経路は不変）', () => {
    // 回復経路の追加が `GET`（AC-RL-13(a) の発行）を壊していないこと。
    // `tests/integration/form-session-route.int.ts` の 17 件が振る舞いを測るが、
    // **配線の消失はソースでも固定する**（P3-c1 NEW-001 と同じ二重の網）。
    const source = routeSource()
    expect(source).toMatch(/export\s+async\s+function\s+GET|export\s+const\s+GET\s*=/)
    expect(source, 'GET が hasVerifiedSession を渡していない（P3-c1 NEW-001 の退行）').toMatch(
      /hasVerifiedSession\s*:/,
    )
  })
})
