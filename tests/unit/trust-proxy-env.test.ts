import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseServerEnv } from '@/lib/env'
import { resolveClientIp } from '@/lib/http-guard'

/**
 * =========================================================================
 * P3-c1 — **SEC-061 / SEC-069 / P3c-5**: `TRUST_PROXY` を導入し、
 *          本番判定を `VERCEL === '1'` から切り離す
 * =========================================================================
 *
 * 出典: `docs/security-p3b-reaudit-2026-07-29.md` §3 SEC-069（:148-162）、
 *       `docs/security-audit.md` §F P3c-5（:3265）。
 *
 * ## 監査の指摘（そのまま引く）
 * > `lib/http-guard.ts:98-99` と `docs/tech-stack.md` §4.5 は
 * > 「Vercel 以外へ配置する場合は `trustProxy` を必ず有効化すること」と指示しているが、
 * > **その手段が実装されていない。**
 *
 * 実際、`ResolveClientIpOptions.trustProxy` は存在するが、
 * `app/api/applications/route.ts:351` / `app/api/form-session/route.ts:119` の
 * どちらも渡しておらず、真にする env も配線も存在しない。
 * したがって**非 Vercel 本番は永続的に `trusted=false`（縮退構成）**であり、
 * 発信元軸の全ゲート（ログイン試行の抑制を含む）が計数のみに退化したまま運用される。
 *
 * ## なぜ P3-c1 で閉じるのか（閾値いじりより安く、効果が広い）
 * 縮退構成でしか起きない欠陥が現時点で 2 件ある:
 *  - SEC-057 の残余（未認証の第三者が 30 行/10 分 = 180 行・180 通/時を作れる）
 *  - **SEC-067**（第三者が 10 リクエスト/10 分で全新規来訪者を回復不能な Tier B に落とせる）
 *
 * 再監査 §2.2 が明示するとおり、**非 Vercel 配備を選んだ瞬間に SEC-067 は High
 * （リリースブロッカー）へ昇格する。** env 1 本で両方の適用範囲が
 * 「ローカルと E2E のみ」に縮む——`FORM_SESSION_FREE_ISSUE_LIMIT` をいじるより安全で安い
 * （閾値には 20 未満という上界があり、逃げ場が無い）。
 *
 * ## red 理由
 * `lib/env.ts` の `serverEnvShape` に `TRUST_PROXY` が無く（zod は未宣言キーを strip する）、
 * `lib/http-guard.ts:108` の既定は `process.env.VERCEL === '1'` のみを見ている。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/env.ts — serverEnvShape に追加
 * //   受理する値: '1' | 'true' → true / '0' | 'false' → false / 未設定 → false
 * //   それ以外の値は **起動時に落とす**（fail-fast）
 * TRUST_PROXY: <boolean へ変換されるスキーマ>   // parseServerEnv(...).TRUST_PROXY: boolean
 *
 * // lib/http-guard.ts — resolveClientIp の既定
 * //   1. options.trustProxy が渡されていればそれ（最優先。既存の呼び出しを壊さない）
 * //   2. TRUST_PROXY が明示されていればその値
 * //   3. どちらも無ければ process.env.VERCEL === '1'
 * //   → **既定は false（fail-closed）を維持する**
 * //
 * // ★ さらに、**信頼の出所（provenance）によって採用するヘッダを変える**（REV-P3C1-003）:
 * //   - プラットフォーム検出（VERCEL === '1'）由来の信頼:
 * //       x-vercel-forwarded-for → x-forwarded-for → x-real-ip（従来どおり）
 * //   - env（TRUST_PROXY）由来の信頼:
 * //       **x-vercel-forwarded-for は採用しない。** x-forwarded-for → x-real-ip のみ
 * //   - 明示引数（options.trustProxy === true）:
 * //       呼び出し側が構成を宣言しているものとして従来どおり（テストの継ぎ目。本番コードは渡さない）
 * ```
 *
 * ## なぜ provenance で分けるのか（REV-P3C1-003 / **本ファイル最大の指摘**）
 * `resolveClientIp` は信頼する場合 **`x-vercel-forwarded-for` を最優先**で採る。
 * この優先順位の根拠は `lib/http-guard.ts:60-65` が引く Vercel のドキュメント——
 * 「Vercel の手前に自前プロキシを置いた構成でも**上書きされない**」——であり、
 * これは **Vercel 上でのみ成立する性質**である。
 *
 * `TRUST_PROXY` の唯一の用途は**非 Vercel 本番**であり、そこでの前段
 * （nginx / ALB / Cloudflare）は `x-vercel-forwarded-for` を知らないので**剥がさない**。
 * したがって、provenance を無視して全ヘッダを信頼すると、攻撃者は
 * `X-Vercel-Forwarded-For: 203.0.113.9` を付けるだけで
 * **`trusted: true` かつ自分で選んだ key** を得る。帰結は 3 つあり、いずれも重い:
 *
 *  1. 発信元軸のバケットを無限に作れる ⇒ 発信元あたりの上限が消える（SEC-023 / SEC-032 と同型）。
 *  2. **`unverified` の印が一切付かなくなる**（`lib/form-session-issue.ts:129` は `!clientIp.trusted`
 *     でガードされている）⇒ **SEC-057 の是正が丸ごと無効化される。**
 *     `TRUST_PROXY` は SEC-057 の残余を縮めるために入れるのに、誤設定で SEC-057 が全開になる。
 *  3. `auth.ts:74` のログイン IP 軸は `trusted` のとき硬いゲートになるので、
 *     攻撃者が**被害者の IP を名乗って**管理者を締め出せる（SEC-030 の再来）。
 *
 * ## 守るべき原則（**設計文書 §3 の記述を訂正した**）
 * 当初「`TRUST_PROXY` は上限を緩めない——制限が強くなる方向にしか動かない」と書いたが、
 * **これは誤りだった**（上の 2 と 3 がその反例である）。正しくは:
 *
 * > **上限そのものは緩めないが、`TRUST_PROXY` は信頼境界を移す設定であり、
 * > 誤設定は防御を無効化しうる。** だからこそ「有効化したときに**何を**信頼するか」を
 * > 実装で固定しなければならない——fail-closed な既定値をいくら pin しても、
 * > **誰も既定のままでは使わない**ので意味が無い。
 */

const HTTP_GUARD_SOURCE = resolve(process.cwd(), 'lib/http-guard.ts')

/** `process.env` を触るテストは必ず元へ戻す（他ファイルの並行実行に影響させない）。 */
const ENV_KEYS = ['VERCEL', 'TRUST_PROXY'] as const
const saved = new Map<string, string | undefined>()

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/applications', {
    method: 'POST',
    headers: new Headers(headers),
  })
}

/* ========================================================================= *
 * SEC-069 (1): env スキーマ
 * ========================================================================= */

describe('SEC-069 / P3c-5: TRUST_PROXY が env スキーマに存在する', () => {
  it("'1' / 'true' は true に解決される", () => {
    // これが green なら排除される事故: 非 Vercel 本番の運用者が
    // `docs/tech-stack.md` §4.5 の指示どおり設定しようとしても**設定する場所が無い**状態。
    for (const raw of ['1', 'true']) {
      expect(parseServerEnv({ TRUST_PROXY: raw }).TRUST_PROXY, `TRUST_PROXY=${raw}`).toBe(true)
    }
  })

  it("'0' / 'false' は false に解決される（明示的な無効化ができる）", () => {
    for (const raw of ['0', 'false']) {
      expect(parseServerEnv({ TRUST_PROXY: raw }).TRUST_PROXY, `TRUST_PROXY=${raw}`).toBe(false)
    }
  })

  it('未設定なら false（fail-closed）', () => {
    // **既定を true にしてはならない。** 前段プロキシが XFF を上書きしない構成で
    // 既定 true にすると、**クライアントが自分の IP を名乗れる**ようになり
    // 発信元軸の上限が丸ごと回避される（`lib/http-guard.ts:82-84`）。
    expect(parseServerEnv({}).TRUST_PROXY).toBe(false)
  })

  it('解釈できない値は起動時に落とす（黙って false にしない）', () => {
    // これが green なら排除される事故: 運用者が `TRUST_PROXY=yes` と書き、
    // **黙って false のまま**縮退構成で運用され続けること
    //（SEC-069 の本体は「指示と実装が食い違ったまま残ると、次に読む人が
    //  『設定すれば直る』と誤認する」ことである。誤認したまま設定した状態も同じ害を持つ）。
    for (const raw of ['yes', 'on', 'TRUE ', '2', '']) {
      expect(
        () => parseServerEnv({ TRUST_PROXY: raw }),
        `TRUST_PROXY=${JSON.stringify(raw)} が受理されてしまった`,
      ).toThrow()
    }
  })

  it('クライアントへ公開されるキー（NEXT_PUBLIC_）ではない', () => {
    // 信頼境界の設定値がバンドルへ入る形（`NEXT_PUBLIC_TRUST_PROXY`）を作らない。
    expect(parseServerEnv({ NEXT_PUBLIC_TRUST_PROXY: '1' })).not.toHaveProperty(
      'NEXT_PUBLIC_TRUST_PROXY',
    )
  })
})

/* ========================================================================= *
 * SEC-069 (2): resolveClientIp の既定が env から決まる
 * ========================================================================= */

describe('SEC-069 / P3c-5: 非 Vercel でも TRUST_PROXY で縮退構成から抜け出せる', () => {
  it('VERCEL 未設定 + TRUST_PROXY=1 なら x-forwarded-for を採用する（trusted=true）', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される状態: 非 Vercel 本番が**永続的に縮退構成**であり、
    //  (a) SEC-057 の残余（未認証で 30 行/10 分）
    //  (b) SEC-067（10 リクエストで全新規来訪者を回復不能な Tier B に落とせる）
    // の両方が**回避不能な既定**になること。再監査 §2.2 はこの配備を選んだ時点で
    // SEC-067 が High（リリースブロッカー）へ昇格すると明記している。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' }))
    expect(resolved.trusted, '縮退構成から抜け出せていない').toBe(true)
    expect(resolved.key).toBe('198.51.100.7')
    expect(resolved.source).toBe('x-forwarded-for')
  })

  it('VERCEL 未設定 + TRUST_PROXY 未設定なら従来どおり縮退（fail-closed / 退行防止）', () => {
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', undefined)

    const resolved = resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' }))
    expect(resolved.trusted).toBe(false)
    expect(resolved.key).toBe('unknown')
  })

  it('VERCEL=1 は従来どおり信頼する（TRUST_PROXY 未設定 / 退行防止）', () => {
    setEnv('VERCEL', '1')
    setEnv('TRUST_PROXY', undefined)

    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' })).trusted).toBe(true)
  })

  it('TRUST_PROXY=0 は VERCEL=1 より優先して信頼しない（明示が既定に勝つ）', () => {
    // 明示した設定が環境検出に負けると、**運用者が構成を制御できない**。
    // 「Vercel の手前に自前プロキシを置いていて XFF を信頼したくない」構成を表現できるようにする。
    setEnv('VERCEL', '1')
    setEnv('TRUST_PROXY', '0')

    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' })).trusted).toBe(false)
  })

  it('明示引数 options.trustProxy は env より優先される（既存 224 行のテストを壊さない）', () => {
    // `tests/unit/client-ip.test.ts` は `{ trustProxy: true/false }` を直接渡して測っている。
    // env を足したことでそれらの意味が変わってはならない。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')
    expect(resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false }).trusted).toBe(
      false,
    )

    setEnv('TRUST_PROXY', '0')
    expect(resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: true }).trusted).toBe(
      true,
    )
  })

  it('TRUST_PROXY=1 でも、ヘッダが IP リテラルでなければ採用しない（既存の検証を残す）', () => {
    // 「信頼する」は「何でも受け取る」ではない。攻撃者が任意長・任意内容の文字列を
    // レート制限キーにできる経路（SEC-023 の増幅要因）を再び開けない。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(req({ 'x-forwarded-for': 'not-an-ip' }))
    expect(resolved.trusted).toBe(false)
    expect(resolved.key).toBe('unknown')
  })
})

/* ========================================================================= *
 * SEC-069 (2'): **有効化したときに何を信頼するか**（REV-P3C1-003 / Must Fix）
 * ========================================================================= */

describe('REV-P3C1-003: env 由来の信頼では x-vercel-forwarded-for を採用しない', () => {
  it('TRUST_PROXY=1（非 Vercel）では、攻撃者が名乗った x-vercel-forwarded-for を採らない', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される攻撃: 非 Vercel 本番（＝ `TRUST_PROXY` の唯一の用途）で、
    // 前段プロキシが知らない `x-vercel-forwarded-for` を攻撃者が自分で付けるだけで
    //  (a) 発信元軸のバケットを**無限に作れる**（発信元あたりの上限が消える）
    //  (b) `trusted: true` になるため `lib/form-session-issue.ts:129` の
    //      `!clientIp.trusted` ガードが外れ、**SEC-057 の是正が丸ごと無効化される**
    //  (c) `auth.ts:74` のログイン IP 軸で**被害者の IP を名乗って管理者を締め出せる**（SEC-030 の再来）
    // を全て達成できること。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(
      req({
        // 攻撃者が名乗った値（前段は `x-vercel-forwarded-for` を知らないので剥がさない）。
        'x-vercel-forwarded-for': '203.0.113.9',
        // 前段プロキシが上書きした、信頼できる値。
        'x-forwarded-for': '198.51.100.7',
      }),
    )

    expect(resolved.key, '攻撃者が名乗ったヘッダが採用された').toBe('198.51.100.7')
    expect(resolved.source).toBe('x-forwarded-for')
    expect(resolved.trusted).toBe(true)
  })

  it('x-vercel-forwarded-for しか無ければ、信頼せず unknown へ寄せる（fail-closed）', () => {
    // 「採用しない」を「他に無ければ仕方なく使う」で実装しないこと。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(req({ 'x-vercel-forwarded-for': '203.0.113.9' }))
    expect(resolved.trusted).toBe(false)
    expect(resolved.key).toBe('unknown')
  })

  it('x-vercel-forwarded-for の値を変えても、バケットは増えない（SEC-023 の増幅を断つ）', () => {
    // 「採用しない」ことの実利。攻撃者が値を変えるたびに新しいレート制限キーが
    // 作れると、上限は無限に回避でき、store のメモリ増幅（SEC-023）の経路にもなる。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const keys = new Set<string>()
    for (let n = 0; n < 20; n++) {
      keys.add(
        resolveClientIp(
          req({
            'x-vercel-forwarded-for': `203.0.113.${n}`,
            'x-forwarded-for': '198.51.100.7',
          }),
        ).key,
      )
    }
    expect(keys.size, `攻撃者が ${keys.size} 個のバケットを作れた`).toBe(1)
  })

  it('VERCEL=1 では従来どおり x-vercel-forwarded-for を最優先する（退行防止）', () => {
    // プラットフォーム検出由来の信頼では、`lib/http-guard.ts:60-65` の根拠が成立する。
    // これが green なら排除される「行き過ぎた修正」: 全構成で `x-vercel-forwarded-for` を
    // 捨ててしまい、**Vercel の手前に自前プロキシを置いた構成で XFF 汚染に負ける**こと。
    setEnv('VERCEL', '1')
    setEnv('TRUST_PROXY', undefined)

    const resolved = resolveClientIp(
      req({
        'x-forwarded-for': '203.0.113.66',
        'x-vercel-forwarded-for': '198.51.100.20',
      }),
    )
    expect(resolved.key).toBe('198.51.100.20')
    expect(resolved.source).toBe('x-vercel-forwarded-for')
  })

  it('VERCEL=1 かつ TRUST_PROXY=1 でも、プラットフォームの意味論を失わない', () => {
    // 両方立っている構成（Vercel 上で明示的に有効化した）で、
    // env 側の制限がプラットフォーム側の意味論を**上書きしない**こと。
    setEnv('VERCEL', '1')
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(
      req({
        'x-forwarded-for': '203.0.113.66',
        'x-vercel-forwarded-for': '198.51.100.20',
      }),
    )
    expect(resolved.source).toBe('x-vercel-forwarded-for')
  })

  it('解釈できない TRUST_PROXY は信頼しない（fail-closed / REV-P3C1-009）', () => {
    // `getServerEnv()` は初回 parse をキャッシュする（`lib/env.ts:197-205`）ため、
    // `resolveClientIp` は `process.env` を直読みせざるを得ない。
    // つまり**検証（zod）と使用（直読み）が別経路**になる。
    // 本番では `app/api/applications/route.ts:127` の `getServerEnv()` が起動時に落とすが、
    // それは「起動時の検証が実際に走る経路」に限った保証である。**両方を安全側に固定する。**
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', 'yes')

    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' })).trusted).toBe(false)
  })
})

/* ========================================================================= *
 * NEW-005: env 由来の信頼では `x-forwarded-for` の**左端**を信用しない
 * ========================================================================= *
 *
 * 出典: `docs/review-p3c1-tests-re-2026-07-29.md` NEW-005（Should Fix / セキュリティ）。
 *
 * ## `x-vercel-forwarded-for` を塞いだ論理は、そのまま `x-forwarded-for` にも当てはまる
 * `resolveClientIp` は**左端**を採る（`lib/http-guard.ts:120` `raw.split(',', 1)[0]`）。
 * 左端が信頼できるのは「前段が XFF を**上書き**する」構成に限る。
 * ところが nginx の最も普及したレシピは
 *
 * ```
 * proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # ← append（上書きではない）
 * ```
 *
 * であり、**クライアントが名乗った値が左端に残る**。
 * この構成で `TRUST_PROXY=1` にすると、攻撃者は `X-Forwarded-For: 203.0.113.9` を付けるだけで
 * REV-P3C1-003 で塞いだのと**まったく同じ 3 つの帰結**
 * （バケット無限生成 / `unverified` 印の無効化 / 被害者 IP を騙ったログイン締め出し）を達成できる。
 *
 * `lib/http-guard.ts:98-99` は「前段プロキシが XFF を上書きすることを確認したうえで有効化すること」と
 * 既に書いているが、(a) その前提を守らせる仕組みが無く、(b) 前節のソース pin は
 * **`TRUST_PROXY` という文字列の存在しか見ていない**。
 * **`TRUST_PROXY` を実装したことで、これまで到達不能だった危険が到達可能になった。**
 *
 * ## 採る形（レビューの改善案 1 = 最も安い）
 * **env provenance では `x-real-ip` を `x-forwarded-for` より優先する。**
 * nginx の標準レシピでは `X-Real-IP $remote_addr` が**単一値**で設定され、append されない。
 * プラットフォーム検出（Vercel）由来の信頼では従来の優先順位を維持する
 * ——Vercel は XFF を自ら上書きするので左端が信頼でき、`x-real-ip` は「最後の手段」でよい。
 */

describe('NEW-005: env 由来の信頼では x-real-ip を x-forwarded-for より優先する', () => {
  it('append 構成（左端に攻撃者の値が残る）でも、攻撃者の名乗りを採らない', () => {
    // **本 describe で最も重要なテスト。**
    // これが green なら排除される攻撃: nginx の標準レシピ
    // （`X-Forwarded-For $proxy_add_x_forwarded_for` = append）を使う非 Vercel 本番で、
    // 攻撃者が `X-Forwarded-For: 203.0.113.9` を付けるだけで
    //  (a) 発信元軸のバケットを無限に作る
    //  (b) `!clientIp.trusted` ガードを外して **SEC-057 の是正を無効化する**
    //  (c) 被害者の IP を騙って管理者を締め出す（SEC-030 の再来）
    // を達成すること。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(
      req({
        // append 構成の実際の形: `<クライアントが名乗った値>, <前段が追記した実 IP>`
        'x-forwarded-for': '203.0.113.9, 198.51.100.7',
        // nginx の標準レシピは単一値で設定する（append されない）。
        'x-real-ip': '198.51.100.7',
      }),
    )

    expect(resolved.key, '攻撃者が名乗った左端の値を採用した').toBe('198.51.100.7')
    expect(resolved.source).toBe('x-real-ip')
    expect(resolved.trusted).toBe(true)
  })

  it('x-real-ip の値を変えてもバケットが増えない構成であること（実 IP に固定される）', () => {
    // 攻撃者は `x-forwarded-for` を自由に変えられるが、`x-real-ip` は前段が上書きする。
    // 「優先する」だけでは不十分で、**`x-forwarded-for` の値がキーに影響しない**ことまで測る。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const keys = new Set<string>()
    for (let n = 0; n < 20; n++) {
      keys.add(
        resolveClientIp(
          req({
            'x-forwarded-for': `203.0.113.${n}, 198.51.100.7`,
            'x-real-ip': '198.51.100.7',
          }),
        ).key,
      )
    }
    expect(keys.size, `攻撃者が ${keys.size} 個のバケットを作れた`).toBe(1)
  })

  it('x-real-ip が無ければ x-forwarded-for を使う（前段が上書きする構成を壊さない）', () => {
    // `x-real-ip` を**必須**にすると、上書き構成（＝ 正しく設定された前段）で
    // `x-forwarded-for` しか送らない環境が**永久に縮退**する。
    // 優先順位を変えるだけで、採用可能な集合は狭めない。
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')

    const resolved = resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' }))
    expect(resolved.key).toBe('198.51.100.7')
    expect(resolved.source).toBe('x-forwarded-for')
  })

  it('VERCEL=1 では従来どおり x-forwarded-for が x-real-ip より優先される（退行防止）', () => {
    // Vercel は XFF を**自ら上書きする**ので左端が信頼でき、`x-real-ip` は最後の手段でよい
    //（`lib/http-guard.ts:60-65` の根拠）。provenance ごとに最適な順序が違う。
    setEnv('VERCEL', '1')
    setEnv('TRUST_PROXY', undefined)

    const resolved = resolveClientIp(
      req({ 'x-forwarded-for': '198.51.100.20', 'x-real-ip': '203.0.113.5' }),
    )
    expect(resolved.source).toBe('x-forwarded-for')
    expect(resolved.key).toBe('198.51.100.20')
  })
})

/* ========================================================================= *
 * SEC-069 (2''): 抜け道を作らせない（provenance を潰す配線を禁じる）
 * ========================================================================= */

describe('REV-P3C1-003: 本番ルートは trustProxy を明示的に渡さない', () => {
  it('公開ルートの resolveClientIp 呼び出しに trustProxy オプションが無い', () => {
    // `options.trustProxy === true` は「呼び出し側が構成を宣言している」扱いで
    // **全ヘッダを信頼する**（既存 `tests/unit/client-ip.test.ts` の 6 件がその意味論を固定している）。
    // したがって誰かが `resolveClientIp(req, { trustProxy: env.TRUST_PROXY })` と書いた瞬間、
    // **provenance の区別が消えて上の防御が丸ごと無効化される。**
    // 「警告コメントでは 4 度止められなかった」（SEC-043）ので、配線をソースで固定する。
    for (const route of ['app/api/applications/route.ts', 'app/api/form-session/route.ts']) {
      const source = readFileSync(resolve(process.cwd(), route), 'utf8')
      expect(source, `${route} が trustProxy を明示的に渡している`).not.toMatch(/trustProxy/)
    }
  })
})

/* ========================================================================= *
 * SEC-069 (3): 指示と実装の食い違いを残さない
 * ========================================================================= */

describe('SEC-069: 「trustProxy を有効化せよ」という指示が、実際に取れる操作を指している', () => {
  it('lib/http-guard.ts の運用指示が TRUST_PROXY を名指ししている', () => {
    // SEC-069 の本体は**文書と実装の食い違い**である。
    // これが green なら排除される事故: 次に読む人が `lib/http-guard.ts:98-99` を読んで
    // 「設定すれば直る」と誤認し、**設定する場所を探して見つからないまま縮退で運用する**こと。
    const source = readFileSync(HTTP_GUARD_SOURCE, 'utf8')
    expect(source, 'lib/http-guard.ts が TRUST_PROXY に言及していない').toContain('TRUST_PROXY')
  })

  it('append 構成の危険が実装のコメントに残っている（NEW-005 の改善案 2）', () => {
    // **文字列 `TRUST_PROXY` の存在だけを見る pin では不十分である。**
    // `TRUST_PROXY` を実装したことで append 構成（nginx の標準レシピ）の危険が
    // **到達可能になった**ので、有効化する人が読む場所にその前提を残す。
    //
    // これが green なら排除される事故: 運用者が「`TRUST_PROXY=1` にすればよい」とだけ読み、
    // `X-Forwarded-For $proxy_add_x_forwarded_for`（append）のまま有効化して
    // **SEC-057 の是正ごと無効化する**こと。
    //
    // ⚠️ **`/append|上書き/` では空振りする。** `lib/http-guard.ts:98-99` には
    // 既に「上書きすることを確認したうえで」という文言があり、実装前から green になってしまう
    //（申し送り原則 4「空振りしているテストを green として報告しない」）。
    // **append という危険側の語**を要求する。
    const source = readFileSync(HTTP_GUARD_SOURCE, 'utf8')
    expect(
      source,
      'append 構成（$proxy_add_x_forwarded_for）の危険が実装コメントに書かれていない',
    ).toMatch(/append/i)
  })
})
