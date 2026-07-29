# P3-a 差し戻し修正 — 追加テスト（red）記録

> 作成: 2026-07-29 / 担当: Test Agent
> 根拠: `docs/p3a-fix-plan-2026-07-29.md` / `docs/security-audit.md`「P3-a 監査」SEC-042・SEC-043・SEC-047 /
> `docs/review-p3a-code-2026-07-29.md` RV-P3A-001・RV-P3A-003
> 制約: **実装コード（`lib/` / `app/` / `middleware.ts`）は変更していない。** 変更したのはテストのみ
> （`playwright.config.ts` も**意図的に未変更**。理由は §T4）。E2E は実行していない。

## 実測サマリー

| 項目 | 実測値 |
|------|--------|
| `pnpm test:unit` | **19 failed / 340 passed（359件・28ファイル）** |
| 追加したテスト | **+42 件**（基準値 317 → 359） |
| 既存テストの退行 | **0**（既存 317 件は全て pass。`public-guard.test.ts` 23 件も pass） |
| `pnpm type-check` | **5 errors**（すべて T1 の型契約。意図した red） |
| `pnpm lint` | **0**（警告・エラーなし） |
| `pnpm test:integration` | 28 件 pass（退行なし） |
| `pnpm test:e2e` | **未実行**（1回29分のため禁止。T4 は設定の妥当性で判断） |

追加テストの内訳（合計 42 件）:

| | 内訳 | 件数 | うち red |
|---|------|------|---------|
| **T1**（SEC-043）| 振る舞い 6 + 型契約 6 | **12** | 6（振る舞い3 / 型契約3）+ type-check 5 errors |
| **T2**（SEC-042）| `form-session` 13（入力11 + 正常系1 + 構造1）+ ラッパ 4 | **17** | 9（入力4 / 構造1 / ラッパ4）|
| **T3**（SEC-047）| 列挙 1 + 自己検証 7 | **8** | 0（検出力の強化。実装変更は不要）|
| **T4**（RV-P3A-003）| 設定契約 5 | **5** | 4 |

既存 `form-session.test.ts:129`（ASCII 5 件）は削除せず、**なぜ足りなかったか**の注記を付けて維持している。

---

## T1. SEC-043 / RV-P3A-001（High / Must Fix）— `trusted` を捨てさせない

### 追加したテスト

| ファイル:行 | 検証する契約 |
|------------|------------|
| `tests/unit/public-guard-degraded-source.test.ts:96` | 縮退時（`trusted=false`）は per-source 軸が上限に達しても **429 にならない**。ただし `consume` は毎回呼ばれ、バケットは上限到達する（**計数は続けるがゲートには使わない**） |
| `tests/unit/public-guard-degraded-source.test.ts:126` | `trusted=true` では従来どおり 429（退行防止） |
| `tests/unit/public-guard-degraded-source.test.ts:144` | 縮退時でも `formSession` 軸（攻撃者自身に閉じた軸）は硬いゲートのまま 429 |
| `tests/unit/public-guard-degraded-source.test.ts:164` | **`trusted` プロパティが実際に読まれる**（getter で観測） |
| `tests/unit/public-guard-degraded-source.test.ts:193` | 縮退時に別軸（`verifyFormSession`）が無ければ **Tier B（403 + challenge）へ降格**。素通りも 429 もしない（条件1'-3） |
| `tests/unit/public-guard-degraded-source.test.ts:212` | `trusted=true` なら別軸が無くても Tier B に落とさない（正常系を壊さない） |
| `tests/unit/public-guard-source-axis-type.test.ts:51` | `sourceAxisFor(endpoint, resolution)` は `trusted=true` → `enforce=true` |
| `tests/unit/public-guard-source-axis-type.test.ts:61` | `trusted=false` → `enforce=false`（キー自体は作る＝計数は続ける） |
| `tests/unit/public-guard-source-axis-type.test.ts:71` | endpoint ごとにキー空間が分かれる |
| `tests/unit/public-guard-source-axis-type.test.ts:87 / :96 / :102`（型）| **`.key`（string）だけでは `sourceAxisFor` を呼べない** / `SourceAxis` は `enforce` を持つ / `PublicGuardOptions['clientIp']` の戻り値は `ClientIpResolution` |

### これが green なら排除される攻撃／壊れた実装

- **排除される攻撃**: 縮退構成（`next start` 直公開・ローカル・デモ、および Vercel 上でも IP ヘッダが妥当な IP リテラルでないリクエスト）で、**攻撃者 1 台が上限回数だけ送信するだけで、その窓の間ずっと全利用者の申込送信が 429 になる**（監査 G-1 の実測: 攻撃者 3 回で 200×3 → 無関係な発信元の 1 回目が 429）。SEC-021 → SEC-029 → SEC-030 に続く **4 度目の同型**。
- **排除される壊れた実装**: (a) `clientIp(request).key` のように `trusted` を捨てる呼び出し、(b) 是正を「per-source 軸を常に外す」形で行い Tier D を無効化する実装、(c) 縮退時にゲートだけ外して**別軸を要求しない**実装（縮退構成で変更系が無制限に素通りする）、(d) 縮退の判定を呼び出し側の if 文に散らし、次の呼び出し元が書き忘れられる形。

### red である理由（実測した失敗メッセージ）

```
FAIL tests/unit/public-guard-degraded-source.test.ts > 縮退時は per-source 軸が上限に達しても 429 にならない
  AssertionError: 共有 unknown バケットの枯渇は拒否理由にならない:
    expected [ 201, 201, 201, 429, 429 ] to deeply equal [ 201, 201, 201, 201, 201 ]

FAIL tests/unit/public-guard-degraded-source.test.ts > `trusted` を実際に読む
  AssertionError: per-source 軸を組み立てる際に trusted を必ず読むこと: expected 0 to be greater than 0

FAIL tests/unit/public-guard-degraded-source.test.ts > 縮退時に別軸が未設定なら Tier B へ降格する
  AssertionError: 素通りさせない／429 にもしない: expected 201 to be 403

FAIL tests/unit/public-guard-source-axis-type.test.ts（3件）
  TypeError: sourceAxisFor is not a function

pnpm type-check:
  tests/unit/public-guard-source-axis-type.test.ts(3,10): error TS2305: Module '"@/lib/public-guard"' has no exported member 'sourceAxisFor'.
  tests/unit/public-guard-source-axis-type.test.ts(3,55): error TS2305: Module '"@/lib/public-guard"' has no exported member 'SourceAxis'.
  tests/unit/public-guard-source-axis-type.test.ts(90,5): error TS2578: Unused '@ts-expect-error' directive.
  tests/unit/public-guard-source-axis-type.test.ts(92,5): error TS2578: Unused '@ts-expect-error' directive.
  tests/unit/public-guard-source-axis-type.test.ts(106,52): error TS2344: … 'ClientIpResolution' does not satisfy …
```

> **TS2578（Unused '@ts-expect-error'）が red の本体である。** 現在の `sourceAxisFor` は存在しないため
> 型エラーになるが、Impl が「string も受け取れる緩い関数」として実装すると、この 2 行は
> **「エラーが起きなかった」ことで再び type-check が落ちる**。`.key` だけを渡せる実装は通らない。

### Impl が実装すべき変更（**型設計の要求**）

両レビュワーが「**コメントで警告するだけでは再発を止められない**」と明言している
（`lib/http-guard.ts:86-94` は名指しで警告していたのに、新しいラッパが `.key` だけを取り出した）。
したがって次の 3 点は**型の要求**であり、振る舞いだけ直すのは不可。

```ts
// lib/public-guard.ts
import type { ClientIpResolution } from '@/lib/http-guard'

/** 発信元軸のゲート判断。`ClientIpResolution` **全体**からしか作れない。 */
export interface SourceAxis {
  readonly key: string
  /** この軸の `success:false` を 429 の理由に使ってよいか（`trusted === false` なら false）。 */
  readonly enforce: boolean
}

/** 縮退の判定を**1箇所に閉じる**。呼び出し側の if 文に散らさない。 */
export function sourceAxisFor(
  endpoint: SemaphoreEndpoint,
  resolution: ClientIpResolution,      // ← string を受け取らない = `.key` だけでは呼べない
): SourceAxis {
  return { key: rateLimitKey(`${endpoint}:`, resolution.key), enforce: resolution.trusted }
}

export interface PublicGuardOptions {
  // …
  /** 分解せずに渡す（`{ key, trusted }` へ緩めないこと。緩めると再び `.key` だけを使える）。 */
  clientIp?: (request: Request) => ClientIpResolution
}
```

Tier D のループ側:

```ts
const resolved = clientIp(request)
const axes: Array<{ axis: string; limiter: RateLimiter; key: string; enforce: boolean }> = []
if (limiters?.source) {
  const source = sourceAxisFor(endpoint, resolved)
  axes.push({ axis: 'source', limiter: limiters.source, key: source.key, enforce: source.enforce })
}
// formSession 軸は攻撃者自身に閉じているので enforce: true
…
for (const { axis, limiter, key, enforce } of axes) {
  const result = await limiter.consume(key, at)          // 計数は必ず行う
  if (!result.success && enforce) {                       // ゲートに使うのは enforce のときだけ
    deny('D', axis, key)
    return TIER_D(jitteredRetryAfterMs(result.retryAfterMs, random))
  }
}

// 条件1'-3: 縮退時は別軸を必ず要求する
if (!resolved.trusted && !verifyFormSession) {
  deny('B', 'degraded-no-second-axis', `${endpoint}:challenge`)
  return TIER_B()
}
```

**設計判断（Test Agent）**: 監査 SEC-043 修正方針2 は「**構築時に throw** するか **Tier B へ降格**」の二択を示している。
**構築時 throw は採らない**——`trusted` はリクエストごとに決まる値で構築時には分からず、
既存の `public-guard.test.ts`（`limiters.source` のみを渡す 4 箇所）が全て壊れる（退行）。
**リクエスト時に Tier B へ降格**する形なら、`trusted=true` の通常構成には一切影響しない。

---

## T2. SEC-042（High）— Cookie 署名比較の長さ判定

### 追加したテスト

| ファイル:行 | 検証する契約 |
|------------|------------|
| `tests/unit/form-session.test.ts:167-235`（11ケース）| 署名部分が**非 ASCII / 不正 UTF-8 / 長さ境界**でも `verifyFormSessionValue` は例外を投げず `null` |
| `tests/unit/form-session.test.ts:244` | 正規の Cookie は引き続き通る（バイト長比較へ直しても正常系を壊さない） |
| `tests/unit/form-session.test.ts:248` | 長さ判定に `providedSignature.length` を使わない（構造で固定） |
| `tests/unit/form-session.test.ts:129`（既存を改訂）| ASCII の壊れた形式 5 件は維持しつつ、**なぜこれだけでは足りなかったか**をコメントに明記 |
| `tests/unit/public-guard-fault-containment.test.ts:56` | `verifyFormSession` が throw → **403 { challenge }**（例外を外へ出さない） |
| `tests/unit/public-guard-fault-containment.test.ts:73` | `formSessionKey` が throw → 403（Tier D 軸の材料も攻撃者が制御する） |
| `tests/unit/public-guard-fault-containment.test.ts:87` | 例外由来の Tier B と正常な Tier B の応答が**完全一致**（降格理由を漏らさない） |
| `tests/unit/public-guard-fault-containment.test.ts:110` | **実物の `verifyFormSessionValue`** に細工 Cookie を通しても 403（監査 G-5b の再現） |

### 入力の選び方が脅威モデルを覆っているかの点検（**本節が指摘の核心**）

監査の指摘はこうだった:

> `form-session.test.ts:129` は「壊れた形式でも例外を投げず null」という**正しい契約**を書いているのに、
> 与えた 5 つの入力がすべて ASCII だったために `Buffer` 長の不一致に到達しなかった。
> **契約が正しくても、その契約を検証する入力の選び方が脅威モデルと一致していなければ意味がない。**

**脅威モデル**: 攻撃者は Cookie 値を**任意のバイト列**にできる。欠陥の実体は
「`String.prototype.length`（UTF-16 コードユニット数）と `Buffer.byteLength`（UTF-8 バイト数）のずれ」なので、
**そのずれを作れる入力の分類が網羅されているか**が点検軸である。

| # | 分類 | 例 | JS 長 | UTF-8 バイト長 | 旧入力集合 | 新入力集合 |
|---|------|----|-------|----------------|-----------|-----------|
| 1 | 2 バイト文字 | `é` (U+00E9) | 1 | 2 | ❌ 無し | ✅ **red** |
| 2 | 3 バイト文字 | `あ` (U+3042) | 1 | 3 | ❌ 無し | ✅ **red** |
| 3 | サロゲートペア | `😀` (U+1F600) | 2 | 4 | ❌ 無し | ✅ **red** |
| 4 | 不正 UTF-8（孤立サロゲート）| `\uD800` | 1 | 3（U+FFFD 置換）| ❌ 無し | ✅ **red** |
| 5 | 逆方向の境界（バイト長一致・JS 長不一致）| `é` で ASCII 2 文字を置換 | -1 | ±0 | ❌ 無し | ✅ green |
| 6 | 長さ境界（±1文字 / ASCII）| 署名を1文字増減 | ±1 | ±1 | ❌ 無し | ✅ green |
| 7 | 極端な長さ | 署名 10,000 文字 | +9957 | +9957 | ❌ 無し | ✅ green |
| 8 | base64url 外の ASCII | `NUL` / 改行 / 空白 | ±0 | ±0 | 部分的（`%%%`）| ✅ green |
| 9 | payload 側の非 ASCII | `日本語` + payload | — | — | ❌ 無し | ✅ green |
| 10 | 完全に壊れた形式（ASCII）| `not-a-token` 等 5 件 | — | — | ✅ 有り | ✅ 維持 |

**点検結果**: 旧集合が覆っていたのは分類 10（と 8 の一部）だけで、**欠陥に到達できる分類 1〜4 が 1 件も無かった**。
新集合は 1〜4 を全て含み、そのうち 4 件が実際に red になっている（＝**入力集合が脅威モデルに追いついたことを実測で確認した**）。
分類 5〜7 は「バイト長比較へ直した実装が**逆方向の例外**を作らない」ことを固定するための境界であり、現状は green
（＝修正で壊れていないかの回帰網）。

**残る限界（正直に記載）**: 本テストは `verifyFormSessionValue` の**引数**に文字列を渡す形であり、
実際の Cookie ヘッダのパース（分割・`=` の扱い・percent-encoding）は P3-b の `/apply` 配線時にしか検証できない。
分類 8 の入力は「パーサが渡しうる値」の想定であって、パーサ自体の検証ではない。

### これが green なら排除される攻撃／壊れた実装

- **排除される攻撃**: 未認証の攻撃者が **Cookie の 1 文字をマルチバイト文字に置き換えるだけ**で
  `RangeError: Input buffers must have the same byte length` を起こし、**任意に 500 を発生させる**こと
  （エラーレート汚染・監視の誤報・ログ増幅、かつ Tier B に落ちない＝降格させるべきリクエストがエラーになる）。
- **排除される壊れた実装**: (a) `try { … } catch { return null }` で `RangeError` を握り潰すだけの修正
  （比較が実行されない入力と「署名不一致」を区別できなくなる。構造テストで排除）、
  (b) `lib/form-session.ts` だけ直してラッパ側の例外経路を放置する実装
  （Tier B の判定は P3-b 以降で Turnstile・送信間隔・ハニーポットへ複雑化する。**壊れた入力が失敗ではなく劣化になる**のはラッパの契約）。

### red である理由（実測した失敗メッセージ）

```
FAIL tests/unit/form-session.test.ts > 2バイト文字（é / U+00E9）を署名の1文字目に置く
  AssertionError: expected [Function] to not throw an error but
    'RangeError: Input buffers must have the same byte length' was thrown
  （3バイト文字 / サロゲートペア / 孤立サロゲート の 3 件も同一メッセージ）

FAIL tests/unit/form-session.test.ts > 長さ判定はバイト長で行う
  AssertionError: 署名文字列の `.length` で長さ判定をしない（先に Buffer 化してバイト長で弾く）:
    expected '…' not to match /providedSignature\.length\s*!==/

FAIL tests/unit/public-guard-fault-containment.test.ts（4件）
  RangeError: Input buffers must have the same byte length   ← ラッパの外へ抜けている
  TypeError: cookie parse failed
  Error: boom
```

### Impl が実装すべき変更

1. `lib/form-session.ts:121-122` を `lib/cron-auth.ts:39-43` と同じ形にする:

```ts
const provided = Buffer.from(providedSignature, 'utf8')
const expectedBuf = Buffer.from(expected, 'utf8')
if (provided.length !== expectedBuf.length) return null
if (!timingSafeEqual(provided, expectedBuf)) return null
```

2. `lib/public-guard.ts` で `formSessionKey` / `verifyFormSession` の呼び出しを `try/catch` し、
   **例外は Tier B（`TIER_B()`）へ落とす**。本文・ヘッダは正常な Tier B と完全一致させること
   （例外時だけ応答が変わると、bot に「どの入力が内部エラーを起こすか」を教える）。
   **本体（handler）の例外は従来どおり外へ抜ける**（`public-guard.test.ts:139` の既存契約を壊さないこと）。

---

## T3. SEC-047 — ルート列挙テストの検出力

### 追加したテスト

| ファイル:行 | 検証する契約 |
|------------|------------|
| `tests/unit/api-route-guard-coverage.test.ts:223` | 全変更系ルートのラッパが**本物のモジュール由来**（`@/lib/public-guard` / `@/app/api/admin/_guard` / `@/lib/cron-auth`）であること |
| 同 `:310` | ローカル定義の no-op 同名ラッパを「本物ではない」と判定（**監査実測②の形**） |
| 同 `:322` | 本物の import は通す |
| 同 `:333` | 相対パス import も解決先が同じなら通す（偽陽性を作らない） |
| 同 `:341` | 別モジュールの同名関数は通さない |
| 同 `:352` | `import type` だけでは「通っている」と見なさない |
| 同 `:360` | import 済みでも**同名のローカル宣言で覆っていれば**通さない |
| 同 `:369` | 管理系は `app/api/admin/_guard.ts` 由来であることを要求 |

判定ロジックは同ファイル内の `importsIdentifierFrom` / `declaresLocally` / `usesGenuineWrapper`
（`api-route-guard-coverage.test.ts:142-183`）。**ルート名はハードコードしない**方針（AC-010-14 の本質）は維持している。

### これが green なら排除される攻撃／壊れた実装

- **排除される壊れた実装**: 防御を消したまま列挙テストを通過するルート。監査は
  `app/api/_sec_audit_probe/route.ts` に `const withPublicMutation = <T,>(h: T) => h` を置いて
  **11/11 green のまま通過する**ことを実測している。故意の回避より、
  **リファクタで別モジュールの同名関数へ差し替わる事故**のほうが現実的な経路である。

### red である理由

**本項は red にならない（green で入る）。** 現在の実ルート（`app/api/admin/**` の 4 ファイル）は
すべて `import { withAdminMutation } from '@/app/api/admin/_guard'` の形であり、新しい assert を満たす。
red になるのは**偽装ケースを合成ソースで再現した自己検証**の側で、そこは検出ロジックと同時に入るため
最初から green である（実装コードの変更は不要）。

> **正直な限界**: したがって T3 は「Impl が直す red」ではなく**検出力の強化**である。
> 監査が「対象が 0 件の今は空振りする」と書いたとおり、この網が本当に効くのは
> **P3-b で最初の公開ルートが入るとき**である。自己検証 7 件は、その時点で網が機能することを
> 今のうちに固定するためにある（合成ソースなので対象 0 件でも空振りしない）。

### Impl が実装すべき変更

なし（テストのみ）。**P3-b で公開ルートを追加する担当者への申し送り**:
`export const POST = withPublicMutation(...)` と書くだけでなく、
`import { withPublicMutation } from '@/lib/public-guard'` を**値として** import すること
（`import type` やローカル定義は落ちる）。

---

## T4. RV-P3A-003 — 文書化された品質ゲートコマンドが赤

### 下した判断

レビューの改善案 **(b)「`webServer` を常に本番ビルドにする」** を採る。加えて 2 点を足す。

| 決定 | 内容 | 理由 |
|------|------|------|
| **(b) を採用** | 非 CI の `webServer.command` を `pnpm build && pnpm start` にする | (a)（CSP の assertion を `if (process.env.CI)` で条件付きにする）は、**手元では本番 CSP を一度も検証しない**状態を作る。「テストは緑だが誰も見ていない」は本プロジェクトが繰り返した型そのもの。(b) なら `/schools` 白紙化のような**本番でしか出ない欠陥を dev 実行で見逃す**経路も同時に塞げる |
| **`pnpm start` 単体にしない** | `pnpm build &&` を前置する | ビルドしていない手元では `next start` が「`.next` が無い」で落ちる。**赤の理由が変わるだけ**で、文書化されたコマンドは通らないまま |
| **`reuseExistingServer: false`（非 CI）** | 起動済みサーバーを流用しない | 手元で `pnpm dev` を開いたままだと Playwright がそれを掴み、**本番ビルドを検証したつもりで dev を見る**。RV-P3A-003 と同じ赤が別経路で戻る（かつ原因が分かりにくい）。代償は「ポート 3000 を空けておく必要がある」ことだが、Playwright は明示的なエラーを出すので診断可能 |
| **CI 経路は不変** | `CI=1` では `pnpm start` / `reuseExistingServer: false` のまま | 実測済み基準値（`CI=1 pnpm test:e2e` = 94 passed / 4 flaky / 2 skipped / 0 failed、29.0m）を動かさないため。CI は `next build` を別ステップで済ませており、二重ビルドは所要時間を倍にする |
| **`csp.spec.ts` は変更しない** | `'unsafe-eval'` の assertion は無条件のまま | 設定側で「E2E は常に本番ビルドを見る」を保証したので、テスト側に環境分岐を持ち込まない（分岐は「どの環境で何を検証したか」を分かりにくくする） |

### 追加したテスト

| ファイル:行 | 検証する契約 |
|------------|------------|
| `tests/unit/e2e-gate-config.test.ts:65` | CI 無しでも dev サーバー（`next dev` / `pnpm dev`）を起動しない |
| 同 `:73` | CI 無しでは本番サーバーを起動し、**その前にビルドする** |
| 同 `:82` | CI 無しでは既存サーバーを流用しない（`reuseExistingServer === false`） |
| 同 `:90` | CI 無しの `webServer.timeout` が **300 秒以上**（ビルド時間を吸収） |
| 同 `:95` | **CI 経路は `pnpm start` のまま**（基準値を動かさない） |

### これが green なら排除される攻撃／壊れた実装

- **排除される壊れた状態**: 文書化された品質ゲート `pnpm test:e2e` が **dev 専用の CSP（`'unsafe-eval'`）を見て赤になる**こと。
  赤いゲートは「いつもの赤」として無視されるようになり、**本物の退行を隠す**。
  加えて、手元の E2E が dev サーバーを見ることで**本番ビルドでしか出ない欠陥を見逃す**経路。

### red である理由（実測した失敗メッセージ）

```
FAIL tests/unit/e2e-gate-config.test.ts > CI 無しでも dev サーバーを起動しない
  AssertionError: expected 'pnpm dev' not to match /\bnext dev\b|\bpnpm dev\b/
FAIL … > CI 無しでは本番サーバーを起動し、その前にビルドする
  AssertionError: expected 'pnpm dev' to match /\bnext start\b|\bpnpm start\b/
FAIL … > CI 無しでは既存サーバーを流用しない
  AssertionError: expected true to be false
FAIL … > CI 無しの webServer タイムアウトはビルド時間を吸収できる（>= 300 秒）
  AssertionError: expected 120000 to be greater than or equal to 300000
```

### Impl が実装すべき変更

`playwright.config.ts` は**意図的に未変更のまま残した**（Test Agent が直すと red が消え、
「設定が契約を満たしている」ことを誰も検証しない状態になるため）。適用すべき差分:

```ts
  webServer: {
    // 文書化された品質ゲート `pnpm test:e2e`（CI 無し）が dev サーバーを見ないようにする
    // （RV-P3A-003）。E2E は常に本番ビルドを検証する。CI は build を別ステップで済ませている。
    command: process.env.CI ? 'pnpm start' : 'pnpm build && pnpm start',
    url: baseURL,
    // 非 CI はビルドを含むため天井を上げる。
    timeout: process.env.CI ? 120_000 : 300_000,
    // 起動済みの `next dev` を掴むと、本番ビルドを検証したつもりで dev を見ることになる。
    reuseExistingServer: false,
  },
```

**E2E は実行して確認していない**（1回29分・他作業と競合するため禁止）。上記は設定と条件の妥当性による判断であり、
実際の緑は Impl または再監査時の `pnpm test:e2e` で確認すること。

---

## 各テストの1文サマリー（「これが green なら何が排除されるか」）

| # | テスト | green なら排除されるもの |
|---|--------|------------------------|
| T1-1 | 縮退時に 429 にならない | 第三者 1 台が上限回数送るだけで**全利用者の申込を止める**攻撃（SEC-043 / 監査 G-1） |
| T1-2 | 計数は続く（バケットは上限到達） | 「ゲートを外す」を「計数もやめる」と実装し、**攻撃の観測手段を失う**こと |
| T1-3 | `trusted=true` は 429 のまま | per-source 軸のゲートごと消して **Tier D を無効化**する実装 |
| T1-4 | `formSession` 軸は縮退時も硬いゲート | 「`trusted=false` なら Tier D 全体を無効化」する実装 |
| T1-5 | `trusted` の読み取りを getter で観測 | `clientIp(request).key` のように **`trusted` を捨てる呼び出し**（SEC-043 の直接の原因） |
| T1-6 | 縮退＋別軸なし → Tier B | 縮退構成で変更系が**無制限に素通り**する実装（条件1'-3） |
| T1-7〜10 | `sourceAxisFor` の型契約 | `.key` だけで軸を組み立てられる API 設計（＝**5 度目の同型**の再発経路） |
| T2-1〜4 | 非 ASCII / 不正 UTF-8 の署名 | Cookie 1 文字の細工で**任意に 500 を起こす**攻撃（SEC-042 / 監査 G-5） |
| T2-5〜11 | 長さ境界・極端な長さ・payload 側 | バイト長比較へ直した実装が**逆方向の例外**を作ること |
| T2-12 | 構造（`.length` で判定しない） | `try/catch` で `RangeError` を握り潰すだけの修正 |
| T2-13〜16 | ラッパの例外封じ込め | Tier B の判定材料が壊れたときに**失敗（500）になる**構造（P3-b で判定が複雑化しても効く） |
| T3-1〜8 | import 元の検証 | 同名のローカル no-op / 別モジュールの同名関数で防御を消したルートが**列挙テストを通過**すること |
| T4-1〜5 | E2E ゲートの設定 | 文書化されたコマンドが赤のまま放置され、**赤が常態化して本物の退行を隠す**こと |

---

## Impl への申し送り

1. **順序**: T1（型設計）→ T2（`form-session` 2 行 + ラッパの try/catch）→ T4（`playwright.config.ts`）。T3 は変更不要。
2. **`lib/http-guard.ts` は変更しない**（監査は無変更を確認済み。`resolveClientIp` の契約は正しい）。
3. **退行の基準値**: unit 317（既存分）/ integration 28 / `CI=1 pnpm test:e2e` 94 passed・4 flaky・2 skipped・**0 failed**。
   flaky 4 件は `admin-news` / `course-comparison` 系。**「0 flaky」と報告しないこと**。
4. `pnpm type-check` は **T1 の型を直すまで赤のまま**である（TS2578 を含む 5 件）。これは意図した red。
5. 本タスクで**実装コードは 1 行も変更していない**。テスト側の変更は次の 6 ファイル:
   - 新規 `tests/unit/public-guard-degraded-source.test.ts`
   - 新規 `tests/unit/public-guard-source-axis-type.test.ts`
   - 新規 `tests/unit/public-guard-fault-containment.test.ts`
   - 新規 `tests/unit/e2e-gate-config.test.ts`
   - 改訂 `tests/unit/form-session.test.ts`（SEC-042 の入力集合）
   - 改訂 `tests/unit/api-route-guard-coverage.test.ts`（SEC-047 の import 元検証）
   - 改訂 `tests/unit/public-guard.test.ts`（`clientIp` の注入を `ClientIpResolution` の形に揃えただけ。assertion は不変）
