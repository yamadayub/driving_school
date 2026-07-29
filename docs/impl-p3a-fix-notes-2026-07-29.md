# P3-a 差し戻し修正 — 実装記録

> 作成: 2026-07-29 / 担当: Impl Agent
> 契約: `docs/review-p3a-fix-tests-2026-07-29.md`（テスト契約の正）
> スコープ: `docs/p3a-fix-plan-2026-07-29.md`
> 根拠: `docs/security-audit.md`「P3-a 監査」SEC-042 / SEC-043 / SEC-047、
> `docs/review-p3a-code-2026-07-29.md` RV-P3A-001 / RV-P3A-003

## 0. 実測サマリー（すべて本タスク内で実行した結果。推測は含まない）

| 終了条件 | コマンド | 実測値 |
|---------|---------|--------|
| 1. 単体テスト | `pnpm test:unit` | **28ファイル / 359件 全パス**（修正前: 5ファイル失敗 / 19 fail・340 pass）|
| 2. 結合テスト | `pnpm test:integration` | **5ファイル / 28件 全パス** |
| 3. 型チェック | `pnpm type-check` | **エラー 0**（修正前: 5 errors）|
| 3. Lint | `pnpm lint` | **No ESLint warnings or errors** |
| 4. ビルド | `pnpm build` | **成功 / 全17ルート `ƒ (Dynamic)`**（`ƒ Middleware 87.4 kB`）|
| 5. E2E | `CI=1 pnpm test:e2e` | **101 passed / 0 flaky / 2 skipped / 0 failed（103件・4.9m）** — 但し書きは §6 |
| 追加検証 | `pnpm exec playwright test csp.spec.ts --project=chromium`（**CI 無し**）| **7 passed (1.5m)** |

退行の基準値（`p3a-fix-plan` §実測済みの基準値）との対比:
既存 unit 317 件・integration 28 件はいずれも**退行 0**（359 = 317 + Test Agent 追加分 42）。

## 1. T1 / SEC-043 / RV-P3A-001（High / Must Fix）— 型で強制した

### 何が壊れていたか
`lib/public-guard.ts` の Tier D が `clientIp(request).key` だけを取り出し、`trusted` を捨てていた。
その結果、縮退時（`trusted === false`＝全利用者が共有する単一 `unknown` バケット）の枯渇が
そのまま 429 になり、**第三者が上限回数だけ送信するだけで全利用者の申込送信を止められた**。
SEC-021 → SEC-029 → SEC-030 に続く 4 度目の同型。

### 型でどう強制したか（**本タスクの中心。振る舞いだけ直していない**）

両レビュワーが「コメントで警告するだけでは再発を止められない」と明言している。実際
`lib/http-guard.ts:86-94` は「`key` だけを取り出して `trusted` を捨てる呼び出しはこの防御を
無効化する」と**名指しで警告していた**のに、新しいラッパがまさにその書き方をした。
したがって同じ警告を書き足す対応は採らず、次の 3 つの**継ぎ目**を入れた。

| # | 継ぎ目 | 場所 | 効果 |
|---|--------|------|------|
| (a) | `sourceAxisFor(endpoint, resolution: ClientIpResolution)` が **`string` を受け取らない** | `lib/public-guard.ts:53-56` | `.key` だけでは呼べない。`resolveClientIp(r).key` を渡すと `pnpm type-check` が **TS2345** で落ちる |
| (b) | `PublicGuardOptions.clientIp?: (request: Request) => ClientIpResolution` | `lib/public-guard.ts:141` | 戻り値型を `{ key, trusted }` へ緩められない。緩めた瞬間に呼び出し側が再び `.key` だけを使えるため、**型が緩むこと自体を禁じる**のが要点。`source` を欠いた部分オブジェクトも **TS2322** で落ちる |
| (c) | Tier D の軸要素型が `enforce: boolean` を**必須**にしている | `lib/public-guard.ts:229` | 新しい軸を足す人は「この軸の枯渇を拒否理由にしてよいか」を必ず書くことになる。共有軸を無自覚に硬いゲートへ昇格させる書き方がコンパイルできない |

加えて **縮退の判定を `sourceAxisFor` の中だけに閉じた**（呼び出し側に `if (trusted)` を置かない）。
`lib/public-guard.ts:231-233` にその旨をコメントで固定してある。判定が 1 箇所にあるので、
新しい呼び出し元が「書き忘れる」経路が構造的に存在しない。

### 型の継ぎ目が実際に効くことの独立検証（実測）

契約テストの `@ts-expect-error`（TS2578 になれば落ちる形）が green であることに加えて、
**再発経路そのものを書いた一時ファイルを作って `pnpm type-check` を実行**し、
落ちることを確認した（確認後にファイルは削除済み。リポジトリには残していない）:

```ts
export const a = (r: Request) => sourceAxisFor('applications', resolveClientIp(r).key)
export const b: PublicGuardOptions['clientIp'] = (r: Request) => ({ key: 'unknown', trusted: false })
```

```
__typeseam_probe.ts(5,64): error TS2345: Argument of type 'string' is not assignable to
  parameter of type 'ClientIpResolution'.
__typeseam_probe.ts(7,14): error TS2322: Type '(r: Request) => { key: string; trusted: false; }'
  is not assignable to type '(request: Request) => ClientIpResolution'.
  Property 'source' is missing in type '{ key: string; trusted: false; }' but required in
  type 'ClientIpResolution'.
```

削除後に `pnpm type-check` を再実行し、エラー 0 に戻ることも確認した。

### 振る舞い（`lib/public-guard.ts:254-269`）

- 縮退時も `consume` は**毎回呼ぶ**（計数を止めない＝攻撃の観測手段を失わない）。
  ゲートに使うのは `enforce === true` のときだけ。
- `formSession` 軸は攻撃者自身に閉じているので `enforce: true` 固定（縮退時も硬いゲートのまま）。
- **条件1'-3**: `!resolved.trusted && !verifyFormSession` なら Tier B（403 + challenge）へ降格。
  素通り（無制限）にも 429 にもしない。Test Agent の設計判断どおり「構築時 throw」は採っていない
  （`trusted` はリクエストごとに決まる値で構築時には分からず、既存 `public-guard.test.ts` が壊れる）。

## 2. T2 / SEC-042（High）— Cookie 署名比較をバイト長で

### `lib/form-session.ts:119-131`
`providedSignature.length !== expected.length`（UTF-16 コードユニット数）を、
`lib/cron-auth.ts:39-43` と同じ**バイト長比較**へ置き換えた:

```ts
const provided = Buffer.from(providedSignature, 'utf8')
const expectedBytes = Buffer.from(expected, 'utf8')
if (provided.length !== expectedBytes.length) return null
if (!timingSafeEqual(provided, expectedBytes)) return null
```

`try/catch` で `RangeError` を握り潰す形は採っていない（比較に到達しなかった入力と
「署名不一致」を区別できなくなり、鍵ローテーション事故の診断手段を失うため）。
構造テスト `form-session.test.ts:248` が `providedSignature.length !==` の再出現を禁じている。

### `lib/public-guard.ts` のラッパ側
`formSessionKey`（`:235-253`）と `verifyFormSession`（`:271-287`）の呼び出しを try/catch し、
例外を **Tier B** へ落とす。応答は正常な Tier B と同じ `TIER_B()` を返すため、
本文・ヘッダは完全に一致する（例外時だけ応答が変わると、bot に「どの入力が内部エラーを
起こすか」を教えることになる）。**本体（handler）の例外は従来どおり外へ抜ける**
（`public-guard.test.ts:145` の既存契約は green のまま）。

ログ側は例外由来を `axis: 'formSession-error'` として区別できるようにした
（**応答は同一、サーバー側の観測だけ区別**）。AC-RL-10 の「軸名・キーのハッシュ先頭8文字・
判定結果だけ」という制約は維持している（生の Cookie も例外メッセージも出さない）。

### 入力の選び方が脅威モデルを覆っているか（契約書 T2 の点検軸）
Test Agent の分類 1〜4（2バイト文字 / 3バイト文字 / サロゲートペア / 孤立サロゲート）が
修正前に実際に `RangeError` を投げていたこと、修正後に 11 ケースすべてが「例外を投げず null」に
なることを `pnpm test:unit` で実測した。分類 5〜7（逆方向の境界・長さ ±1・10,000 文字）も
green で、**バイト長比較へ直した実装が逆方向の例外を作っていない**ことを確認している。

## 3. T3 / SEC-047 — 実装変更なし

契約書どおり、実装コードの変更は不要だった（`api-route-guard-coverage.test.ts` 19 件 green）。
現行の管理系 4 ルートはすべて `import { withAdminMutation } from '@/app/api/admin/_guard'` の形で、
新しい `usesGenuineWrapper` の assert を満たす。

**P3-b の担当者への申し送り（契約書からの再掲）**: 公開ルートを追加するときは
`export const POST = withPublicMutation(...)` と書くだけでなく、
`import { withPublicMutation } from '@/lib/public-guard'` を**値として** import すること。
`import type` とローカル定義は列挙テストで落ちる。

## 4. T4 / RV-P3A-003 — E2E ゲートを本番ビルドに固定

`playwright.config.ts` の `webServer` を契約書 T4 の「下した判断」どおりに変更した:

```ts
command: process.env.CI ? 'pnpm start' : 'pnpm build && pnpm start',
timeout: process.env.CI ? 120_000 : 300_000,
reuseExistingServer: false,
```

CI 経路（`pnpm start` / `reuseExistingServer: false`）は実質的に不変で、実測済み基準値を動かさない
（従来の `reuseExistingServer: !process.env.CI` は CI では false だったため）。
併せて 3 行目の「ローカルは `pnpm dev`」という**もう事実でなくなったコメント**を直した。

### 実測（**CI 無しの経路を実際に走らせて確認した**）
`csp.spec.ts` は RV-P3A-003 で赤になっていた当のスペックである。CI 無しで実行した:

```
$ pnpm exec playwright test csp.spec.ts --project=chromium
Running 7 tests using 5 workers
  7 passed (1.5m)
```

`webServer` がビルドを実行してから本番サーバーを起動し、本番 CSP（`'unsafe-eval'` 無し）に対して
green になることを確認した。これは全 E2E ではなく**1 スペックだけの追加実行**である
（全実行は §6 の 1 回のみ。理由は下記）。

## 5. テスト側の変更

**アサーションは 1 つも変更していない。** 変更したのは E2E のテスト基盤 1 箇所のみ:

`tests/e2e/playwright/admin-authz.spec.ts:116-150` — `withPrisma` が呼び出しごとに
`new PrismaClient()` + `$disconnect()` していたのを、**ワーカーあたり 1 つの共有クライアント**に
変更し、ファイル直下の `afterAll` で切断するようにした（呼び出しは 17 箇所ある）。
オーケストレーターから「`admin-authz.spec.ts:160` の既知 flaky の原因と推定される。
アサーションを変えない限り修正してよい」と明示的に許可されたもの。
`withPrisma` のシグネチャと全呼び出し側は無変更。

> **正直な限界**: これは「接続の確立/切断を 17 回繰り返す構造をなくした」ことの確認であって、
> **flaky が消えたことの証明ではない**。flaky は定義上 1 回の実行では再現も反証もできない。
> §6 の実行で当該テストがどうだったかは実測値として記載するが、
> 「この変更で flaky が解消した」とは**主張しない**。

## 6. E2E 実測値（`CI=1 pnpm test:e2e` を **1 回だけ**実行）

事前処理（指示どおり実施）: ポート 3000 の解放、`ms-playwright` / `next-server` の停止、
dev DB の稼働確認（`driving_school_pg  Up 2 hours`）。
実行時に `lsof -nP -iTCP:3000 -sTCP:LISTEN` が空であることを確認済み。

```
Running 103 tests using 1 worker
  ...
  2 skipped
  101 passed (4.9m)
EXIT=0
```

| 項目 | 実測値 | 基準値（`p3a-fix-plan` §実測済みの基準値）|
|------|--------|------------------------------------------|
| passed | **101** | 94 |
| flaky | **0**（reporter が flaky 行を出力しなかった）| 4 |
| skipped | **2** | 2 |
| **failed** | **0** | 0 |
| 合計テスト数 | **103** | 100（94 + 4 + 2）|
| 所要時間 | **4.9m** | 29.0m |

`Running 103 tests using 1 worker` の行で `CI=1` が効いている（`workers: 1` / `retries: 2`）ことを
確認している。`failed` は 0 で、退行は無い。

### この数字について、断定できないこと（**重要**）

1. **合計テスト数が基準値より 3 件多い（103 vs 100）。これは本タスクの変更によるものではない。**
   本タスクで E2E テストは 1 件も追加していない。`pnpm exec playwright test --list` は
   `Total: 103 tests in 8 files` を返す。スペックの更新時刻を見ると `csp.spec.ts` が
   **2026-07-29 04:21**（本セッション開始の 06:13 より前）で、本タスクの変更ではない。
   `admin-authz.spec.ts` の 06:19 だけが本タスクの変更（§5 の `withPrisma`）。
   **誰がいつ 3 件を足したのかは特定できていない**ので、断定せず事実だけ記す。
   再監査時は基準値の側を 103 件へ更新するか、差分の出所を確認することを推奨する。

2. **「flaky 0」を成果として報告しない。**
   基準値は 4 flaky で、本実行では reporter が flaky 行を出さなかった。しかし
   **所要時間が 29.0m → 4.9m と約 6 倍速い**ことから、本実行は基準値測定時より
   **マシン負荷が大幅に低い状態**だったと考えられる。既知の flaky は
   「高負荷下で `admin-authz.spec.ts:160` が落ちる」ものであり、
   **負荷が低い実行で緑だったことは、flaky が解消した証拠にならない。**
   §5 の `withPrisma` 変更が効いた可能性はあるが、**1 回の実行では区別できない**。

3. **E2E は指示どおり全実行を 1 回のみ行った。** 加えて T4 の検証として
   `csp.spec.ts` 1 スペックだけを CI 無しで実行している（§4。全実行ではない）。

## 7. スコープ遵守

- 触っていない: `lib/http-guard.ts`（監査が無変更を確認済み。`resolveClientIp` の契約は正しい）
- 着手していない（P3-b の完了条件）: SEC-044 / SEC-045 / SEC-046 / SEC-048〜051 /
  RV-P3A-002・004〜012
- マイグレーション作成なし。`pnpm db:generate` 実行なし。

## 8. 報告できないこと・検証できていないこと

1. **`sourceAxisFor` の型の継ぎ目は「TypeScript を通す限り」有効である。**
   `as any` / `@ts-ignore` / `.js` からの呼び出しでは迂回できる。型は「うっかり」を止める仕掛けで
   あって、意図的な迂回を止めるものではない。意図的な迂回まで塞ぐには CI での型チェック必須化
   （既に品質ゲートに入っている）と、`public-guard-degraded-source.test.ts` の振る舞いテストが
   必要で、本タスクでは**両方**を green にしてある。
2. **`verifyFormSessionValue` の引数より手前（Cookie ヘッダのパース）は本タスクでは検証できていない。**
   契約書 §T2 の「残る限界」と同じで、分割・`=` の扱い・percent-encoding は P3-b で `/apply` に
   配線されるまで検証対象が存在しない。今回の修正はパーサが**どんな文字列を渡してきても**
   例外にしないことを保証するが、パーサ自体は未検証である。
3. **縮退時の Tier B 降格（条件1'-3）は、まだ実ルートで一度も通っていない。**
   P3-a には公開ルートが 1 本も無いため、確認はすべてラッパ単体テストによる。
   実配線時（P3-b）に「`verifyFormSession` を渡し忘れると縮退構成で全リクエストが 403 になる」
   という形で顕在化するので、`/apply` の配線担当者はこれを想定しておくこと。
4. **`admin-authz.spec.ts` の flaky が解消したとは主張しない**（§5 の但し書き）。
5. **T4 の非 CI 経路は `csp.spec.ts` 1 本でしか実行確認していない。** 非 CI の全実行
   （`retries: 0` / 並列ワーカー）は行っていないため、**非 CI での全 E2E が緑になるかは未確認**である。
   非 CI は `retries: 0` なので、既知の flaky 4 件がそのまま failed になる可能性が高い。
   E2E の基準値は従来どおり `CI=1 pnpm test:e2e` で取ること。
6. **Redis / KV 実体に対する検証は行っていない**（SEC-044 / RV-P3A-006 は P3-b の完了条件で、
   P3-a には注入経路が 1 本も無い）。
