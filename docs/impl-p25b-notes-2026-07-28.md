# P2.5-b 実装ノート（Impl Agent / 2026-07-28）

> 対象: `docs/p25b-fix-plan-2026-07-28.md` の #1〜#5
> 仕様の正: `docs/review-p25b-tests-2026-07-28.md`（テスト契約。T1〜T4 と T2-DECISION）
> 根拠: `docs/review-p25-code-2026-07-28.md` RV-P25-001/002/003/004/006 /
> `docs/security-audit.md`「P2.5 ハードニング監査」SEC-029 / SEC-030 / SEC-035

## 0. 結論（実測サマリー）

| 終了条件 | コマンド | 実測結果 |
|---|---|---|
| 1. 単体テスト全パス | `pnpm test:unit` | **179 passed (179) / 15 files** — 既存 163 + 追加 16 |
| 2. 結合テスト全パス | `pnpm test:integration` | **28 passed (28) / 5 files** |
| 3-a. 型チェック | `pnpm type-check` | **エラー 0**（exit 0） |
| 3-b. Lint | `pnpm lint` | **✔ No ESLint warnings or errors** |
| 4. ビルド | `pnpm build` | **成功**。`ƒ (Dynamic) server-rendered on demand` 維持（force-dynamic 方針を壊していない） |
| 5. E2E 全パス | `CI=1 pnpm test:e2e` | **82 passed (45.8s)** — chromium / firefox / webkit（最終コード変更後の再実行値） |
| 6. 退行なし | 上記の内訳 | 既存 163 unit / 28 integration / 82 e2e はすべて pass。失敗 0 |

脅威シナリオの自己検証（§6）: SEC-029 / SEC-030 が実測した攻撃は**いずれも再現しなくなった**。
ただし**残余リスクは閉じていない**（§6.2 / §7）。

---

## 1. #1 — T1 / SEC-029 / RV-P25-001（Must Fix）: グローバル軸で正規管理者を締め出さない

### 変更

`lib/login-guard.ts` の判定順序を変更した。

**旧**: `global.consume` → `ip.peek`（ゲート）→ `ip.consume` → `verify()`
**新**: `ip.consume`（判定結果そのものでゲート）→ `global.consume`（枯渇時は予約枠）→ `verify()`

あわせて予約枠を追加した（テスト契約 §T1「Impl が実装すべき変更」2. の API に準拠）:

```ts
export interface LoginGuardLimiters {
  ip: RateLimiter
  account: RateLimiter
  global?: RateLimiter
  globalReserve?: RateLimiter   // ★追加
}
export const LOGIN_GLOBAL_RESERVE_KEY = 'credentials:global-reserve'   // ★追加
```

判定の骨子:

```ts
const gate = await limiters.ip.consume(ipKey, now)
if (trusted && !gate.success) return denied(gate.retryAfterMs)

// 「失敗履歴の無い発信元」= この試行の前に IP 軸のカウントが 0 だったこと
const cleanSource = trusted ? gate.remaining === gate.limit - 1 : true

if (limiters.global) {
  const global = await limiters.global.consume(LOGIN_GLOBAL_KEY, now)
  if (!global.success) {
    if (!cleanSource || !limiters.globalReserve) return denied(global.retryAfterMs)
    const reserve = await limiters.globalReserve.consume(LOGIN_GLOBAL_RESERVE_KEY, now)
    if (!reserve.success) return denied(reserve.retryAfterMs)
  }
}
```

`auth.ts` に `LOGIN_GLOBAL_RESERVE_LIMITER = createRateLimiter({ limit: 20, windowMs: 60_000 })`
（グローバル軸 100回/分 の 20% = SEC-029 修正方針2 の指定値）を追加して `createLoginGuard` に渡した。

### 設計判断

- **予約枠の判定基準に「IP 軸のカウントが 0 だったか」を使った理由**: 攻撃者は必ず自分の IP 軸を
  消費するため、「失敗履歴が無い」ことが攻撃者と正規利用者を分ける唯一のキー付き手掛かりになる。
  IP 軸は認証成功で reset されるので、直前に正常ログインできていた利用者も予約枠の対象に残る
  （＝正規利用者を巻き込まない）。`gate.remaining === gate.limit - 1` は「この試行が
  そのウィンドウの 1 回目だった」ことと同値で、`consume` の戻り値だけから判定できる（#3 と同時に満たせる）。
- **`denied()` を返す前に IP 軸を consume 済みである点**: グローバル軸で拒否された試行も
  IP 軸のカウントは進む。これは攻撃者に有利には働かない（攻撃者の枠が減るだけ）。

### 閾値コメントの整合（テスト契約 §T1 の要求 5.）

`auth.ts` の軸コメントを実装と一致させた。順序変更により「グローバル枠の消費回数 = `verify()`（scrypt）の
実行回数」が**初めて事実になった**ため、「グローバル上限 = scrypt の CPU 予算（10秒/分）」という
閾値の根拠が成立する。P2.5 では IP ゲートで拒否される安価なリクエストがカウンタの大半を占めえたので
この換算は成立していなかった（RV-P25-001 の指摘そのもの）。実測は §6.1 シナリオA。

---

## 2. #2 — T2 / SEC-030 / RV-P25-002（Must Fix）: `trusted=false` 時のゲート意味論

### 実装（T2-DECISION に厳密に従った）

`LoginAttemptInput.trusted?: boolean`（既定 `true`）を追加し、`trusted === false` のとき:

- `ip.consume` は**呼ぶ**（計数と観測は失わない）が、その結果を**照合前ゲートに使わない**。
- 共有バケットが枯渇していても `verify()` を実行し、**成功なら `ok`**。
- 失敗した場合は、`account.consume` で計数したうえで、共有バケットが枯渇していれば
  **`rate-limited`** を返す（＝制限が緩む方向にも壊さない）。
- 予約枠の `cleanSource` は、発信元を識別できないため `true` とみなす（契約 §T2 の指定どおり。
  T2-e の「7 回」はこの前提から導かれる）。
- `trusted` 既定（`true`）の経路は**現行どおり厳格な照合前ゲート**（T2-d が固定）。

`auth.ts` は `resolveClientIp(originRequest)` の戻り値から `.key` と `.trusted` の**両方**を取り出して
`loginGuard.attempt({ email, ip, trusted })` に渡すようにした。`ClientIpResolution.trusted` が
どこからも使われていなかった状態（SEC-030 修正方針2）を解消している。

`request` が取れない経路は `trusted: false`（縮退）として扱う。`ip` が `unknown` に落ちる以上、
それを厳格なゲートに使うと同じ締め出しが起きるため、`ip` と `trusted` の扱いを一致させた。

### 事実に反する記述の訂正（Must Fix の本体・3 箇所）

| # | 箇所 | 訂正内容 |
|---|---|---|
| 1 | `lib/http-guard.ts` `resolveClientIp` の docstring | 「正規管理者は SEC-021 の是正＝『成功は常に通す』により締め出されない」を**削除**。誤りであった事実（適用されていたのはアカウント軸だけで IP 軸は照合前ゲートのままだった / 実測で 10req/10分 の締め出しが成立していた）を明記し、「**`trusted: false` は呼び出し側で必ず見ること**」「`key` だけ取り出す呼び出しはこの防御を無効化する」を要件として追加。縮退の代償と `trustProxy` 必須も記載 |
| 2 | `docs/tech-stack.md` §4.5 | 該当記述を**訂正ブロック**（実測値つき）で明示的に取り消し、訂正後の意味論（照合前ゲートに使わない / 計数のみ）に書き換え。「Vercel 以外へ移す場合の必須作業」を「怠っても安全」→「**怠ると耐性が下がる。`trustProxy` を必ず有効化する**」に書き換え。残余リスク節を新設 |
| 3 | `docs/review-p25-tests-2026-07-28.md` §T2 結論 3 | 取り消し線 + 訂正注記（実測値と訂正後の意味論、真実源が P2.5-b 契約書である旨）。**あわせて §T1 の「要求する処理順序（この順序自体が契約）」も撤回として明記**（この順序が SEC-029 の直接原因だったため、放置すると次も同じ誤りを再生産する） |

---

## 3. #3 — T3 / RV-P25-003: `consume` の判定結果を捨てない

`ip.peek`（判定）→ `ip.consume`（加算・戻り値を捨てる）の 2 相を、`ip.consume` の 1 相に畳んだ。
`lib/rate-limit.ts` の直列化は 1 回の呼び出しの内側でしか効かないため、2 相では同時到着した N 本が
すべて①を通過し、②の `success:false` が捨てられて N 本すべてが `verify()`（scrypt）に進んでいた。

逐次実行時の意味論は変わらない（`consume` は上限到達済みならカウントを進めずに拒否を返す）。
`RateLimiter.peek` は `auth.ts` のログが使うので API 自体は残した。

T1 の `cleanSource` もこの 1 相化から同時に得られる（`gate.remaining === gate.limit - 1`）。

実測: `RV-P25-003` の 2 テストが green（20 並行リクエストで `verify` 5 回 / `rate-limited` 15 件 /
カウンタ 5 で停止）。

---

## 4. #4 — T4 / RV-P25-006 / SEC-035: `evictFor` の時刻注入

```ts
export interface MemoryRateLimitStoreOptions {
  maxEntries?: number
  now?: () => number   // ★追加。既定 Date.now
}
```

`createMemoryRateLimitStore` が時刻ソースを保持し、`evictFor` は `Date.now()` ではなくこれを呼ぶ。
既定は `Date.now` なので**本番の挙動は変わらない**（T4-c が退行検出用に固定）。

あわせて `tests/unit/rate-limit.test.ts` の `T0 = 1_800_000_000_000` に、
**実時刻より未来であることが偶然ではなく意図**であるとコメントを残した（契約 §T4 の要求）。
実装コードには手を入れず、テストの意図をコメントで固定しただけである（契約が明示的に要求した唯一のテスト側変更）。

---

## 5. #5 — RV-P25-004: CI を実際に green にする

### 見つかった不具合と修正

| # | 不具合 | 影響 | 修正 |
|---|---|---|---|
| A | `pnpm/action-setup@v4` に `version: 9` を指定しているが `package.json` の `packageManager` は `pnpm@10.28.1` | **全ジョブが即失敗**（action が "Multiple versions of pnpm specified" で落ちる） | `version:` 入力を削除し、`packageManager` を唯一の真実源にした |
| B | `integration-test` ジョブに DB が無い | 結合テストは Prisma 経由で実 DB を読むため失敗 | `postgres:16` サービスコンテナ + `prisma migrate deploy` + `pnpm db:seed` を追加 |
| C | `e2e-test` ジョブに DB が無い / ランタイム env が build ステップにしか無い | `pnpm start` と E2E（公開コンテンツ件数・管理者ログイン）が失敗 | 同上のサービス + migrate + seed。env を**ワークフロー全体**へ移し、build だけでなく `pnpm start`（webServer）にも届くようにした |
| D | Playwright が chromium しか入らないのに config の projects は 3 ブラウザ | `pnpm test:e2e` を project 無指定で回すと firefox/webkit が "browser not installed" で失敗（旧設定は `--project=chromium` で回避し、82 件中 chromium 分しか検証していなかった） | `playwright install --with-deps chromium firefox webkit` にし、`pnpm test:e2e`（全 project = ローカル実測と同じ 82 件）を実行 |
| E | `lint` ジョブが存在しない | CLAUDE.md の品質ゲート（`pnpm lint`）が CI で担保されない | `lint` ジョブを新設し、`e2e-test` の `needs` に追加 |
| F | seed に必要な `ADMIN_EMAIL` / `ADMIN_PASSWORD` が無い | seed-guard（SEC-012）が throw する | ワークフロー env に追加。値は `tests/e2e/pages/admin-contract.ts` の `ADMIN_CREDENTIALS` と一致させた（ずれると管理系 E2E がログインできない） |

ジョブ構成: `type-check` / `lint` / `unit-test` / `integration-test`（並列）→ `e2e-test`。

### 何を確認し、何が未確認か（推測で「通るはず」と書かない）

**ローカルで実際に再現して確認したこと** — CI と同一の手順・同一の env 値を、
**新規に立てた `postgres:16` コンテナ**（`docker run postgres:16`, POSTGRES_USER/PASSWORD/DB を CI と同値）
に対して実行した。ワークフローの `POSTGRES_*` はポートだけ 5432→5439 に読み替えている（ローカル dev DB との衝突回避）:

```
prisma validate            → The schema at prisma/schema.prisma is valid
prisma migrate deploy      → All migrations have been successfully applied.（2 マイグレーション）
pnpm db:seed               → Course 17 / Faq 11 / News 7 / SupplementalChatRule 5 / AdminUser 1
pnpm test:integration      → 28 passed (28)
pnpm build                 → 成功
CI=true pnpm test:e2e      → 82 passed (1.3m)   ← 3 ブラウザすべて
```

`docker exec ci_sim_pg psql -c "\dt"` で 9 テーブル、`Course` 17 行を確認済み（＝ローカル dev DB ではなく
新規コンテナに適用されたことの確認）。したがって **B / C / D / F の修正内容は実測で裏付けられている**。

また YAML の構文とジョブ依存関係を `python3 -c "yaml.safe_load(...)"` で検証した
（jobs: type-check, lint, unit-test, integration-test, e2e-test / e2e の needs は 4 ジョブ）。

**未確認（ローカルでは原理的に再現できない）**:

1. **`pnpm/action-setup@v4` の実挙動**（修正 A）。GitHub Actions のランナー上でしか実行できない。
   `version:` と `packageManager` の併記が失敗要因であるという判断は、action の仕様と
   `package.json` の `packageManager: pnpm@10.28.1` / `pnpm-lock.yaml` の `lockfileVersion: '9.0'`
   （ローカルの pnpm 10.28.1 で生成・動作）という**事実**に基づくが、**失敗ログ自体は観測していない**。
   `version:` を外した構成は「packageManager を唯一の真実源にする」ため、どちらの解釈でも安全側に倒れる。
2. **`ubuntu-latest` 上での `pnpm install --frozen-lockfile`**。ローカルは macOS / node v20.19.6 で、
   OS 依存の任意依存関係（Playwright など）の解決差は再現していない。
3. **サービスコンテナのネットワーク**（`localhost:5432` での到達性）と health-check の待ち時間。
   ローカルはポート公開したコンテナで代替しており、GitHub の services とは経路が異なる。
4. **`playwright install --with-deps` の Linux 版依存パッケージ導入**。macOS では `--with-deps` の
   apt インストール経路が走らない。
5. 実際の GitHub Actions 実行ログ。**このリポジトリは git リポジトリではない**ため
   （`git status` 不可 / リモート無し）、push による実走行での確認は本作業では行えなかった。

→ **「CI が green になった」とは主張しない。** 「CI を落としていた原因を 6 件特定し、うち
DB・seed・ブラウザ・env に起因する 4 件（B/C/D/F）はローカルで完全再現して green を実測、
残る A（pnpm バージョン競合）と E（lint ジョブ新設）はランナー上での実走行が未確認」が正確な状態である。

---

## 6. 脅威シナリオの自己検証（実測）

テストが green になったことを完了根拠にしないため、**実装モジュール
（`lib/login-guard.ts` + `lib/rate-limit.ts`）へ攻撃シナリオを `tsx` で直接投入**した。
軸設定は `auth.ts` と同一（ip 10回/10分・account 5回/15分・global 100回/分・globalReserve 20回/分）。

### 6.1 閉じたことを確認した経路

```
=== シナリオA: SEC-029 実測手順の再現（単一 IP から 120 リクエスト） ===
  グローバル軸: used=10/100  予約枠: used=0/20
  scrypt 実行回数: 10
  別 IP の正規管理者（正しいパスワード）: {"outcome":"ok","retryAfterMs":0,"verified":true}
  判定: PASS（締め出し不成立）
```
→ SEC-029 が実測した手順（単一 IP 120 リクエスト → グローバル軸 100/100 → 別 IP の正規管理者が
`rate-limited`）は**再現しない**。単一 IP がグローバル軸へ寄与できる量は IP 軸の上限 10 で頭打ちになった。

```
=== シナリオB-1: 100 個の発信元でグローバル枠 100/100 を枯渇させる（予約枠は残る） ===
  グローバル軸: used=100/100 exhausted=true
  予約枠: used=0/20 exhausted=false
  scrypt 実行回数: 100
  失敗履歴の無い正規管理者（正しいパスワード）: {"outcome":"ok","retryAfterMs":0,"verified":true}
  判定: PASS（fix-plan 受け入れ条件を充足）
```
→ fix-plan 行1 の受け入れ条件「**他者がグローバル上限を使い切っても、正しい資格情報でのログインは通る**」を
literal に充足。

```
=== シナリオC: SEC-030 縮退（trusted=false・共有 unknown バケット枯渇） ===
  共有 unknown バケット: used=10/10 exhausted=true
  scrypt 実行回数: 12
  正規管理者（正しいパスワード）: {"outcome":"ok","retryAfterMs":0,"verified":true}
  判定: PASS（締め出し不成立）
  誤った資格情報: {"outcome":"invalid-credentials","retryAfterMs":0,"verified":true}
  → fail-open していない: PASS
```
→ SEC-030 が実測した経路（`trusted=false` で他者が 12 回失敗 → 正規管理者が
`{"outcome":"rate-limited","retryAfterMs":580000,"verified":false}`）は**再現しない**。

```
=== シナリオD: 縮退時の CPU DoS（IP ゲートが外れても scrypt は無制限に走らない） ===
  500 リクエスト中の scrypt 実行回数: 120（上限 = global 100 + reserve 20 = 120）
  判定: PASS

=== シナリオE: trusted=true の経路でブルートフォース耐性が維持されている ===
  同一 IP 15 連投（11回目以降は正解パスワード）:
    invalid-credentials/true ×10  rate-limited/false ×5
  scrypt 実行回数: 10（IP 軸上限 10 で頭打ち）
  判定: PASS
```
→ 縮退でゲートを外したことが CPU DoS の抜け穴になっていないこと、および
`trusted=true` の経路で「上限到達後は正解パスワードでも通らない」総当たり抑止が維持されていることを確認。

### 6.2 閉じていない経路（受容した残余リスク・実測）

```
=== シナリオB-2: 【受容した残余リスク】120 超の独立発信元で予約枠まで枯渇させる ===
  グローバル軸: used=100/100 exhausted=true
  予約枠: used=20/20 exhausted=true
  scrypt 実行回数: 120
  失敗履歴の無い正規管理者（正しいパスワード）: {"outcome":"rate-limited","retryAfterMs":59899,"verified":false}
  判定: 締め出しが成立する（＝閉じていない。docs/tech-stack.md §4.5 で受容済み）
  → 攻撃に必要な独立 IP 数: 修正前 1 → 修正後 120 超（構造的には消えていない）
```

**この結果を「PASS」とは書かない。** 予約枠は「失敗履歴の無い発信元」に開かれている以上、
1 リクエストずつ投げる多数の発信元は全員が予約枠を引ける。したがって
`global.limit + globalReserve.limit`（120）を超える独立 IP を持つ攻撃者には締め出しが成立する。
変わったのは**攻撃コストのみ**（必要 IP 数 1 → 120 超）。詳細は §7。

### 6.3 副次的に観測した挙動（指摘に至らないが記録）

縮退時（`trusted=false`）に正規管理者のログインが成功すると、`limiters.ip.reset(ipKey)` によって
**共有 `unknown` バケットが全員分クリアされる**。シナリオC の最後で、枯渇後の誤資格情報が
`rate-limited` ではなく `invalid-credentials` を返しているのはこのためである。
`verify()` は常に実行されるので fail-open ではなく、拒否も緩んでいない（誤った資格情報は通らない）。
既存の reset 挙動をそのまま踏襲したもので、テスト契約はこの点を規定していない。
**再監査で扱いを判断されたい**（縮退時は `ip.reset` を行わない選択肢もある）。

---

## 7. 残余リスクの記録（「消した」ではなく「受容した」）

テスト契約 §T1「残余リスク」の要求に従い、以下を**受容した残余リスク**として文書に記録した。
記録先: `docs/tech-stack.md` §4.5（新設節「残余リスク（受容した。閉じていない）— SEC-029 / RV-P25-001」）
および `docs/security-audit.md` 末尾（Impl 追記節。Security Agent の所見は書き換えていない）。

1. **グローバル軸の分散枯渇**: `global.limit + globalReserve.limit`（120回/分）を超える独立発信元を
   持つ攻撃者は、依然として正規管理者のログインを窓ごと止められる。**固定ウィンドウのカウンタを
   照合前ゲートに使う限り構造的に消えない。予約枠は攻撃者の必要 IP 数を増やすだけで、ゼロにはしない。**
   構造的な解は「**同時実行中の scrypt 数を上限とするセマフォ**」（SEC-022 修正方針3 の第一候補 /
   RV-P25-001 で Senior も指摘）。自動解放されるので枯渇せず、過負荷時の症状が「拒否」ではなく「待ち」になる。
   **P3 でグローバル軸をセマフォへ置き換えるかを必ず再評価する**（未認証経路は正規利用者の母数が
   桁違いに多く、共有軸の締め出しがそのままサービス停止になるため）。
2. **縮退時のグローバル軸**: `trusted=false` でもグローバル軸は硬いゲートのまま。緩和は `trustProxy` の有効化。
3. **縮退時のブルートフォース耐性の低下**: 発信元を識別できない以上「発信元あたりの推測回数を縛る」ことは
   定義上できず、耐性は IP 軸（10回/10分）ではなくグローバル軸 + 予約枠（120回/分）まで低下する。
   T2-DECISION の選択肢 (B)（緩い閾値）を選んでもこの代償は減らない（締め出しを買うだけ）。

---

## 8. 変更ファイル一覧

| ファイル | 変更 |
|---|---|
| `lib/login-guard.ts` | 判定順序の変更（#1）/ `globalReserve` と `LOGIN_GLOBAL_RESERVE_KEY` 追加（#1）/ `trusted` 追加と縮退時の意味論（#2）/ `peek`→`consume` の 1 相化（#3）/ 不変条件 5. と残余リスクの docstring |
| `lib/rate-limit.ts` | `MemoryRateLimitStoreOptions.now` 追加、`evictFor` が注入時刻を使う（#4） |
| `lib/http-guard.ts` | 事実に反するコメントの訂正、`trusted` を呼び出し側が見る要件を明記（#2） |
| `auth.ts` | `LOGIN_GLOBAL_RESERVE_LIMITER`（20回/分）追加と配線 / `resolveClientIp().trusted` を `attempt()` へ / 閾値コメントを実装と一致させた |
| `.github/workflows/ci.yml` | pnpm バージョン競合の解消 / DB サービス + migrate + seed / env のワークフロー全体化 / 3 ブラウザ / `lint` ジョブ新設（#5） |
| `docs/tech-stack.md` | §4.5 の誤記述訂正 + 残余リスク節の新設（#2 / 残余リスク記録） |
| `docs/review-p25-tests-2026-07-28.md` | §T2 結論3 の訂正注記 / §T1 処理順序の撤回明記（#2） |
| `docs/security-audit.md` | 末尾に Impl の是正報告と受容した残余リスクを追記（既存の所見は不変更） |
| `tests/unit/rate-limit.test.ts` | `T0` に「未来時刻であることは意図」のコメントを追加（契約 §T4 が明示的に要求した唯一のテスト側変更。アサーションは一切変更していない） |

**テストのアサーションは 1 件も変更していない。** 契約を実装に合わせて書き換えた箇所は無い。
