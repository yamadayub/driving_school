# Impl Agent 記録: P3-a（レート制限基盤の本番化 + 公開変更系ラッパ + CSP）

## 日付: 2026-07-29
## 担当: Impl Agent
## 入力
- `docs/review-p3a-tests-2026-07-29.md`（**テスト契約の実装仕様**。§8 のモジュール一覧・§7 の「テストが決めた規約」）
- `docs/phase-status.md`「P3-a の完了条件（分割）」**(1) のみ**
- `docs/tech-stack.md` v0.3.2 §4.5 / §4.6 / §4.7
- `docs/functional-spec.md` v0.3.3 §4.11（AC-RL-1〜15）/ AC-010-10〜16 / AC-PII-10
- `docs/review-p3-design-re2-2026-07-29.md` §D

---

# 0. 結論（実測値のみ。推測を書かない）

| 終了条件 | 実測結果 |
|---------|---------|
| `pnpm test:unit` | ✅ **24 ファイル / 317 件 全パス**（着手前: 8ファイル失敗 / 19件 fail・215件 pass）|
| `pnpm test:integration` | ✅ **5 ファイル / 28 件 全パス**（退行なし）|
| `pnpm type-check` | ✅ エラー 0 |
| `pnpm lint` | ✅ `✔ No ESLint warnings or errors` |
| `pnpm build` | ✅ 成功。**全ルートが `ƒ (Dynamic)`**（DB 非依存の force-dynamic 方針を維持・強化）|
| `CI=1 pnpm test:e2e` | ⚠️ **確定版（DB 稼働・競合なしを確認して実行）: 91 passed / 1 failed / 4 flaky / 2 skipped / 5 did not run（29.8m）・`EXIT=1`**。**「全パス」ではない。** 唯一の failed は `admin-authz.spec.ts:160` で、**守っている契約（403）は通っており、落ちているのは dev DB へ問い合わせる検証行**。単独・`--retries=0` では **20/20 pass（40.6秒 / EXIT=0）**。切り分けの実測は §6.5.0 |
| 自己検証（`scripts/verify-semaphore-p3a.ts`）| ✅ 全シナリオ PASS（§7 に実測ログ）|

> **⚠️ 「テストが green になった」を完了根拠にしていない。** §7 の自己検証は本物の
> `lib/semaphore.ts` に直接シナリオを投入した独立の実測であり、§8 に**この作業で検証できていないこと**を
> 隠さずに列挙した。特に **Lua スクリプト本体の意味論はユニットテストでも自己検証でも検証していない**
> （Node に Lua ランタイムが無いため。Test 申し送り T-1 をそのまま引き継ぐ）。

---

# 1. 着手時の確認（RV-P3DR2-006 / `phase-status.md` P3-a 行）

**`@upstash/redis` を実際に追加し、`eval` のシグネチャを実物で再確認した。**

| 確認項目 | 実測 |
|---------|------|
| 追加したバージョン | `@upstash/redis@1.38.0`（`dependencies`）|
| `eval` のシグネチャ | `node_modules/@upstash/redis/error-8y4qG0W2.d.ts:4241`<br>`eval: <TArgs extends unknown[], TData = unknown>(...args: [script: string, keys: string[], args: TArgs]) => Promise<TData>` |
| 複数キーを渡せるか | **渡せる**（`keys: string[]`）。設計どおり power of two choices の候補2本を1回の `EVAL` に渡せる |

**したがって代替案（楽観方式）への分岐には入っていない。** AC-RL-11(e-2)(e-3) の書き換えも
`tech-stack.md` への受容記録も不要である。

`pnpm add` は `--ignore-scripts` 相当の挙動（pnpm の `Ignored build scripts` 警告）となり、
**`prisma generate` は走っていない**。マイグレーションも作成していない（指示どおり）。
なお `pnpm build` は `package.json` の build スクリプトが元から `prisma generate && next build` であり、
これは P3-a 以前からの既存挙動である（`statusChangedAt` / `sessionIdHash` を**参照するコードは書いていない**）。

---

# 2. 実装したモジュール

## 2.1 `lib/semaphore.ts`（新規）

**ZSET によるパーミット単位のリース。** `acquire` は Lua 1本で
`ZREMRANGEBYSCORE` →（KEYS[2] があれば同じく掃除）→ `ZCARD` 判定 → `ZADD` を原子的に行う。

| 決定 | 内容 | 根拠 |
|------|------|------|
| 秒 → ms の変換 | **`semaphoreTtlMs()` の1関数だけ**。`SemaphoreStore` の境界から先はすべて ms | RV-P3DR2-004。関係式テストは秒同士しか見ないため、実 ms 値（20,000）を別に固定 |
| 定数の導出 | `SEMAPHORE_TTL_SEC = PUBLIC_HANDLER_MAX_DURATION_SEC * 2` | AC-RL-15(a)。片方だけ変えると落ちる |
| キー | `sem:{applications}:0..3`（ハッシュタグ = エンドポイント名）| RV-P3DR2-006。同一スロット＝複数キー `EVAL` の成立条件 |
| 上限 | `perShardLimit`（シャードあたり）+ `semaphoreTotalLimit()` | RV-P3DR-006 |
| シャード抽選 | `acquire` の**内側で毎回**行う。`rng()` を2回呼び `a=floor(r1*K)` / `b=floor(r2*(K-1))`（`b>=a` なら `+1`）| RV-P3DR2-003 / テスト §7-2 の規約 |
| 乱数源 | **シャード抽選（`rng`）とポーリングのジッタ（`random`）を分離** | テスト §7-3。1つにするとジッタが系列を消費し抽選の決定性が壊れる |
| `permitId` | **呼び出し側が渡す**。既定は `randomBytes(16).toString('hex')`（128bit / 16進32文字）| §D 26 / T-8 |
| `now` | **呼び出し側が渡す**。Lua 内で `TIME` を読まない | AC-RL-11（時刻注入）|
| 待機 | 最大 2秒。**残りが `SEMAPHORE_POLL_MIN_MS` に満たなければ打ち切る** | 打ち切らないと最後の1回で待ち上限を超える（`waitedMs <= 2000` の契約が破れる）|

**Lua の構造上の判断**: `KEYS[2]` の掃除は `if otherKey then` の内側にあるが、
**最初の `ZREMRANGEBYSCORE`（`KEYS[1]`）より前に分岐は無い**。`shards === 1` では `KEYS[2]` が
そもそも存在しないため、この分岐は「間引き」ではなく「候補が1本か2本か」の分岐である。

## 2.2 `lib/kv.ts`（書き直し）

`checkRateLimit`（throw するだけのプレースホルダ）を廃し、`RateLimitStore` の KV 実装にした。

- **`increment(key, windowMs, now)` = `INCR` →（`count === 1` のときだけ）`PEXPIRE`。**
  毎回張り直すと窓が永久に終わらず、攻撃者が叩き続ける限りカウンタがリセットされない。
- **判定ロジックを持たない**（`consume` / `peek` / `reset` を export しない）。判定の真実源は
  `lib/rate-limit.ts` のまま（AC-RL-8）。真実源コメントに `lib/rate-limit.ts` と `SemaphoreStore` を明記した。
- `createUpstashKvClient()` を追加。**レート制限とセマフォが共有するのは接続だけ**で、判定は共有しない。

### 意図的にインメモリ実装と変えた点（レビューで見てほしい）

**KV 側のウィンドウ起点を「`windowMs` 境界に整列した固定ウィンドウ」にした**
（インメモリ側は従来どおり「最初の試行時刻」起点）。理由は、`INCR` の戻り値以外に往復を増やさずに
`resetAt` を決めるため。`PTTL` から復元する方式にすると「2回目以降も `PEXPIRE` を張り直す」誘惑が
生まれ、まさにテストが落とそうとしている壊れ方に近づく。**2つの store でウィンドウ起点が違うことは
受容した差異**であり、`lib/kv.ts` の冒頭コメントに理由を書いた。

## 2.3 `lib/rate-limit.ts`（追記・修正）

| 変更 | 内容 |
|------|------|
| `RateLimitStore.increment?` | **永続化の原子操作**として追加（判定ではない）|
| `consume` | **store が `increment` を持つならそちらを本番経路にする**。判定（`count <= limit`）は本モジュールに残す |
| `consume` の判定統合 | 「未使用・期限切れ = count 0 の新ウィンドウ」に統合。**`limit = 0` のときに最初の1回を通してしまう既存の穴を塞いだ**（下記）|
| `RateLimitEntry.saturated` | 上限到達バケットのマーク。**store が退避対象から外す**ために使う（SEC-041）|
| `createMemoryRateLimitStore` | 退避対象から `saturated` を除外。**未達バケットだけで空きが作れない場合に限り**上限到達バケットを退避（メモリの有界性は必ず守る / SEC-023）|
| `rateLimitKey` | **IPv6 `/64` 正規化**と**IPv4 射影の畳み込み**を追加 |

### `consume` の既存の穴（P3-a で発見・修正）

旧実装は「エントリが無ければ無条件に `count: 1` で成功を返す」形だったため、
**`limit: 0` の limiter が最初の1回を通していた**。P2 の用途（limit ≥ 1）では顕在化しないが、
`limit` を 0 にして経路を封じる設定が黙って無効になる。判定を1本にまとめて解消した
（`limit >= 1` の挙動は完全に同じ。既存 30 件の `rate-limit.test.ts` は無変更で green）。

## 2.4 `lib/public-guard.ts`（新規）

評価順序 `Origin → Content-Type → Tier D → Tier B → Tier C → 本体`。

- **`@/auth` に依存しない**（SEC-037 が要求する「認証非依存」）。`withAdminMutation` とは別モジュール。
- **`finally` で必ず `release`**。本体が throw しても解放する（漏れの主因は例外経路）。
- **共有軸（セマフォ）の枯渇は 429 にせず 202**（条件1'-1）。
- **`challenge` を付けるのは Tier B の 403 だけ**。Origin 失敗の 403 には付けない（RV-P3DR-004）。
- ログは `{ tier, axis, endpoint, keyHash }` のみ。**生 IP / `sid` を出さない**（AC-RL-10 / AC-PII-1）。
- `cleanSource` / `globalReserve` の語をソースに一切持ち込んでいない（AC-010-16）。

### `jitteredRetryAfterMs` のテスト用フック（契約ルール6）

`CI === '1'` かつ `NODE_ENV !== 'production'` のときだけ 1〜2秒へ丸める。
**`Math.min(jittered, 1000..2000)` の形にした**——単純に固定値へ置き換えると、
基準値 1,000ms に対する ±20% の契約（AC-RL-12(c)）が CI 環境で破れる。
本番では丸めが一切効かない（実測: §5 の該当テスト）。

## 2.5 `lib/form-session.ts` / `lib/cron-auth.ts`（新規）

- `form-session`: `HKDF` で用途別に鍵を導出（`AUTH_SECRET` 直接流用の禁止を実体化）。
  署名対象は `sid` と `issuedAt` の**両方**（`issuedAt` を署名対象から外すと AC-RL-6 の3秒下限を
  書き換えだけで回避できる）。不正・期限切れは**例外でなく `null`**（500 にすると Tier B に落ちない）。
  Cookie 名は `__Host-fs`（`__Host-` 接頭辞でサブドメインからの上書きを塞ぐ）。
- `cron-auth`: 未認証は **404**（401 は削除バッチの所在を晒す）。`CRON_SECRET` 未設定は fail-closed で 404。
  比較は `timingSafeEqual`。**`Origin` を見ない**（Vercel Cron は送らないためバッチが永久に動かなくなる）。

## 2.6 `lib/env.ts`（追記）

production で `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `FORM_SESSION_SECRET` / `CRON_SECRET` を必須化。
**`FORM_SESSION_SECRET === AUTH_SECRET` を拒否**（鍵の用途分離を検証可能な形にした / テスト §7-5）。
**Turnstile（P3-b）/ Blob（P3-c）は必須にしていない**（先取りすると P3-a のデプロイが理由なく落ちる）。

## 2.7 CSP（`lib/csp.ts` + `middleware.ts`）

`tech-stack.md` §4.7 のオリジン表どおりの**最終形**。`script-src` は `'self'` + リクエストごとの nonce +
Turnstile。`'unsafe-inline'` を含まない。`style-src 'unsafe-inline'` は**受容済みとして明示**した。

**middleware の構造**（ここは設計判断が要った）:
- matcher を `/admin/:path*` から**静的アセットと `api` 以外の全パス**へ広げた（CSP は全ページに要る）。
- **セッション照会は `/admin` のときだけ**行う。`auth()` を全ページに通すと公開ページにも
  毎回セッション照会のコストが乗るため。
- `/admin` では NextAuth の応答が「素通り」（`x-middleware-next`）のときだけ、
  **nonce 付きリクエストヘッダを載せ直した `NextResponse.next()` に差し替える**（`set-cookie` は引き継ぐ）。
  載せ直さないと管理画面のスクリプトに nonce が付かず、CSP で全て弾かれる。
- 開発サーバーのみ `'unsafe-eval'` を許可（React Refresh）。`next start` / 本番では常に無効。

---

# 3. E2E で発見した実装の欠陥（テストが green でも壊れていた例）

**1回目の `CI=1 pnpm test:e2e` で `school-access` が chromium / firefox とも 3回リトライして全滅した。**
ユニット 317件・integration 28件・type-check・lint・build はすべて green の状態でである。

## 原因（実測で特定）

`/schools` は**静的プリレンダリング（`○`）されていた**。静的ページはビルド時の HTML を配るため
**リクエストごとの nonce を持てない**。実測:

```
/        （ƒ Dynamic）: inline <script> nonce 無し 0 本 / nonce 有り 18 本
/schools （○ Static ）: inline <script> nonce 無し 16 本 / nonce 有り 0 本   ← 全部ブロックされる
```

Next.js の App Router は RSC のフライトデータを inline `<script>self.__next_f.push(...)</script>` で
配る。これが CSP で弾かれると `self.__next_f` が未定義のままハイドレーションが失敗し、
**React が DOM を空にする＝ページが真っ白になる**（失敗時スクリーンショットが完全な白紙だった）。

## 修正

`app/layout.tsx`（ルートレイアウト）に `export const dynamic = 'force-dynamic'` を置き、
**全ルートを動的レンダリングに固定**した。`tech-stack.md` §4.7 が
「本プロジェクトは P1 で既に `force-dynamic` を採用済みなので追加の代償は無い」と書いていたが、
**実際には `/schools` と `/_not-found` が静的のまま残っていた**（文書と実態の乖離）。

修正後のビルド出力は**全ルートが `ƒ (Dynamic)`**（`/_not-found` を含む）。
nonce の実測も全ページで「nonce 無しの inline script = 0 本」になった（`/admin/login` を含む）。

> **この欠陥は、ユニットテストでも type-check でも lint でも build でも検出できなかった。**
> 検出したのは E2E（実ブラウザ）だけである。**CSP の検証はヘッダ文字列の assert では不十分**で、
> 「ブラウザで開いて違反が出ないこと」（`csp.spec.ts` の最後の1本）が実質的な網になっている。

---

# 4. E2E で発見したテスト側の欠陥（`networkidle`）— 実測で切り分けた

`csp.spec.ts:114` の「ブラウザで開いたときに CSP 違反が発生しない」が
**`page.waitForLoadState('networkidle')` で必ず 60秒タイムアウトする**（1回目・2回目の実行とも）。

## 切り分けの実測

本物のブラウザで `/` を開き、コンソールと保留リクエストを直接観測した:

```
CSP violations: []            ← **CSP 違反は 0 件**。ポリシー自体は正しい
networkidle: TIMEOUT
still pending:
  http://localhost:3000/news?_rsc=...
  http://localhost:3000/faq?_rsc=...
  http://localhost:3000/apply?type=APPLICATION&_rsc=...
  http://localhost:3000/news/<id>?_rsc=...   ×3
```

保留の正体は **Next.js `<Link>` の RSC プリフェッチ**で、宛先は
`phase-status.md`「P1 既知の未実装（現状リンクは404 or 準備中）」に挙がっている
`/news` `/faq` `/apply` `/news/[id]` である。サーバー側は正常で、**curl では 404 を 26ms で返す**
（`GET /news?_rsc=abc` with `RSC: 1` → `404 time=0.026`）。ブラウザ側でプリフェッチが保留のまま残る。

**これが CSP / middleware に起因しないことを対照実験で確認した**:
`middleware.ts` の matcher を **P3-a 以前の `['/admin/:path*']` に戻してビルドし直しても、
保留リクエストの一覧・件数・`networkidle: TIMEOUT` が完全に同一**に再現した。
すなわち**未実装リンクへのプリフェッチという既存の性質**であり、P3-a の変更とは無関係である。

## 対応（テストの最小修正。理由をここに記録する）

`waitForLoadState('networkidle')` → `waitForLoadState('load')` + `waitForTimeout(1000)` に変更した。
**assertion（`violations` が空であること）は変更していない。** Playwright 公式も `networkidle` を
「テストに使わないこと」として非推奨にしている。検出したい CSP 違反はスクリプト実行・スタイル適用・
リソース読込の時点で出るため、`load` 到達後に遅れて届くコンソールメッセージを短く待てば足りる。

> **⚠️ この修正で検出力は落ちていないが、上限も上がっていない。** このテストが見ているのは
> **`/` を開いたときの違反だけ**である。§3 の `/schools` 空白化を捕まえたのは
> `school-access.spec.ts` であって本テストではない。**P3-b で対象ページを `/apply` に切り替える際、
> 「CSP の検証は csp.spec.ts だけで足りる」と読み替えてはならない。**

---

# 5. 契約テストに対して行った最小修正（**4ファイル**。すべて理由を記録する）

> **開示について（オーケストレーター §4.2 への対応）**: 変更したのは
> `tests/unit/public-guard.test.ts` / `tests/unit/kv-store.test.ts` / `tests/unit/env.test.ts` /
> `tests/e2e/playwright/csp.spec.ts` の **4件**である（追記の表は unit の3件のみを対象にしている）。
> **アサーション（契約）は1件も変更していない。** 変更したのは「そのままでは実行できない機構」
> （Node 20 で throw する env 操作 / TS の型エラー / この app では成立し得ない待機条件）だけである。

**assertion（契約）は1つも変更していない。** 変更したのは「そのままでは実行できない機構」だけである。

| ファイル | 変更 | 理由（実測） |
|---------|------|------------|
| `tests/unit/public-guard.test.ts` | `Object.defineProperty(process.env, 'NODE_ENV', {...})` → `vi.stubEnv` / `vi.unstubAllEnvs` | **Node 20 の `process.env` は `defineProperty` を受け付けない**（`'process.env' only accepts a configurable, writable, and enumerable data descriptor`）。値によらず**常に throw する**ことを probe で確認した。結果として**当該2件は assertion に到達すらしていなかった**（`finally` の復元で throw し、そこがエラー位置として報告されていた）。`@types/node` 上 `NODE_ENV` は readonly なので素の代入も型エラーになるため、vitest の env スタブに寄せた |
| `tests/unit/kv-store.test.ts` | `as Record<string, unknown>` → `as unknown as Record<string, unknown>`（2箇所）| `createKvRateLimitStore` が具体型（`RateLimitStore`）を返すようになった結果、TS2352（index signature が無い）で `pnpm type-check` が通らない。**assertion（`consume`/`peek`/`reset`/`size`/`maxEntries` が undefined）は無変更** |
| `tests/e2e/playwright/csp.spec.ts` | `networkidle` → `load` + 1秒 | §4 のとおり |
| `tests/unit/env.test.ts` | 本番成功ケース2件に P3-a の必須キーを追加 | AC-010-10 が「本番で KV 等が未設定なら throw」を要求するため、**「production + AUTH_SECRET だけで成功する」という旧前提と正面から衝突する**。当該 describe の検証対象は AUTH_SECRET の長さなので、他キーを満たした土台の上で境界値を見る形にした（`P3A_REQUIRED` 定数）|

`lib/form-session.ts` の `deriveFormSessionKey` は**戻り型を `Buffer` から `Uint8Array` に広げた**。
テストの `Buffer.isBuffer(derived) || derived instanceof Uint8Array` が、戻り型 `Buffer` だと
右辺で `never` に絞られて TS2358 になるため。テスト側は無変更で、実体は今も `Buffer` を返す。

---

# 6. 終了条件の実測ログ

## 6.1 `pnpm test:unit`

```
Test Files  24 passed (24)
     Tests  317 passed (317)
```

着手前の red 実測（Test Agent 記録 §4）は「8ファイル失敗 / 19件 fail・215件 pass」。
**既存 179件は全て green のまま**（`login-guard 31 / client-ip 15 / rate-limit 30 / seed-guard 11 /
env 11 / course-filter 10 / http-guard 9 / news-validator 11 / design-tokens 5 / course-view 11 /
badge 4 / publish-status-badge 4 / sanitize 11 / format 8 / password 8`）。

> **件数について**: Test Agent の記録は「234件」としていたが、実測の総数は **317件**である
> （記録のファイル別件数が概算だったため）。**red 時点の実測も 215 pass + 19 fail = 234 ではなく、
> 同じ 317 件中の内訳**である。数字の食い違いを丸めずに残す。

## 6.2 `pnpm test:integration`

```
Test Files  5 passed (5)
     Tests  28 passed (28)
```

> **観測（申し送り）**: E2E を**中断（`pkill -9`）した直後**に流すと、同じコードで
> **4件が落ちる**ことがある。`admin-news.spec.ts` は `afterAll` で `【E2E` 接頭辞の行を掃除するが、
> 強制終了するとそれが走らず、**結合テストが件数を assert している共有 dev DB に残骸が残る**ため。
> E2E を正常終了させた後は 28/28 に戻る（実測）。**結合テストと E2E が同一 DB を共有している構造**に
> 起因するもので、P3-a の変更とは無関係だが、CI で E2E → integration の順に並べると
> 同じ形で落ちうる（現在の `ci.yml` は別ジョブなので影響しない）。

## 6.3 `pnpm type-check` / `pnpm lint`

```
> tsc --noEmit          （出力なし = エラー 0）
> next lint             ✔ No ESLint warnings or errors
```

## 6.4 `pnpm build`

成功。**全 17 ルートが `ƒ (Dynamic)`**（`/_not-found` を含む。§3 の修正後）。
`ƒ Middleware  87.4 kB`。DB 非依存の force-dynamic 方針は**維持どころか全ルートへ拡大**した。

## 6.5 `CI=1 pnpm test:e2e`

### 6.5.0 【確定版】dev DB 稼働・競合なしを確認したうえでの単独実行（2026-07-29 追記）

オーケストレーターの指摘（dev DB 停止 / E2E の同時実行競合 / port 3000 残留）を受け、
**前提を1つずつ実測で確認してから1回だけ実行した**。これを本記録の**確定値**とする。

**実行前の確認**:
- dev DB: `docker ps` で `driving_school_pg Up 53 minutes`、`nc -z localhost 5433` 成功
- port 3000 リスナー: **0**、`playwright test` プロセス: **0**（`lsof -ti:3000 | xargs -r kill -9` まで実施）

**結果**:

```
  1 failed
    [chromium] admin-authz.spec.ts:160 認証済み × 不正 Origin の POST /api/admin/news/save は
                                        403（記事は作成されない）
  4 flaky
    [chromium] admin-authz.spec.ts:341 / :452
    [chromium] admin-news.spec.ts:92
    [chromium] school-access.spec.ts:23
  2 skipped
  5 did not run
  91 passed (29.8m)
```

**終了コード: `EXIT=1`。「0 failed」ではない。** 前回実行（§6.5.1）は 0 failed だったが、
**確定版はこちらであり、`failed 0` と報告してはならない。**

**CSP は 21 件すべて想定どおり**: chromium 7 件（`:114` の実ブラウザ違反検証も **9.9秒で pass**）/
firefox 6 件 / webkit 6 件 ＋ skipped 2 件（`:114` は設計どおり chromium 単一）。
**DB が上がっていれば `csp.spec.ts:114` は通る**——オーケストレーター §4.4 の 1. と一致する。

#### 唯一の failed（`admin-authz.spec.ts:160`）の切り分け

**3回の試行すべてで失敗**したので flaky 扱いにはできない。ただし**落ちている場所は
検証対象の外側**である:

```
  175 expect(res.status(), `expected 403 for cross-origin POST, got ${res.status()}`).toBe(403)
  177 const created = await withPrisma((prisma) =>
→ 178   prisma.news.findFirst(...)
PrismaClientInitializationError: Can't reach database server at `localhost:5433`
```

**この単体テストが守っている契約（クロスオリジン POST が 403 になること）は 175 行目で
通っている。** 落ちているのは「本当に作成されていないか」を dev DB へ問い合わせる 178 行目である。

**環境側の実測**（この主張を「たぶん環境」で終わらせないため）:

| 観測 | 実測値 |
|------|-------|
| DB コンテナの稼働 | `Up About an hour` / **`RestartCount = 0`** / `FinishedAt = 0001-01-01`（**一度も落ちていない**）|
| 実行中の接続数（5秒間隔でサンプリング）| **ピーク 12 / `max_connections` 100**。サンプラー側のエラー **0 件** |
| `admin-authz.spec.ts` を**単独・`--retries=0`** で再実行 | **20/20 pass・40.6秒・`EXIT=0`**（`:160` を含む）|
| フルスイート中の同テストの所要 | 2.2m → 1.3m → 2.0m（3試行とも 60秒タイムアウト超過）|

**原因の推定と、その限界**: `withPrisma` は**呼び出しごとに `new PrismaClient()` を生成して
`$disconnect()` する**（`admin-authz.spec.ts:117`）。1スペックで10回以上呼ばれるため、
クエリエンジンの起動と TCP 接続確立が高頻度で繰り返される。3ブラウザ・29.8分の高負荷下で
この確立が 60秒以内に完了しなかった、という説明が観測と整合する
（DB 自体は無傷・接続数も余裕・単独実行なら 40.6秒で全通過）。

> **⚠️ ただし「環境要因と確定した」とまでは書かない。** 実測が示しているのは
> **(a) DB は落ちていない (b) 接続数は枯渇していない (c) 単独なら通る**の3点であり、
> **「高負荷時に Prisma の接続確立が失敗する条件」を特定したわけではない**。
> **CI（GitHub Actions / workers:1 / 専有ランナー）で1回流して確認することが次の検証である。**
> P3-a の変更は `/api/admin/**` に一切触れていない（middleware の matcher は `api` を除外しており、
> 変更前の `/admin/:path*` でも API ルートは対象外だった）ことは根拠として添えられるが、
> **それだけで「無罪」と結論してはならない。**

### 6.5.1 参考: 先行実行（同一コード・DB 稼働状況を確認していなかった回）

```
  4 flaky
    [chromium] admin-news.spec.ts:108 公開に変更 → トップの最新3件に反映される
    [firefox]  top-page.spec.ts:27   料金プレビューに通学/合宿タブとコースカードがある
    [webkit]   top-page.spec.ts:35   校舎セクションに岩滝校・網野校の2校が示される
    [webkit]   top-page.spec.ts:45   全ナビ項目が正しい href で表示される
  2 skipped
  97 passed (25.0m)
```

**合計 103 = 97 passed + 4 flaky + 2 skipped / failed 0。**
内訳は **既存 82 件（78 passed + 4 flaky）+ CSP 新規 21 件（19 passed + 2 skipped）**。
`csp.spec.ts` は 7 テスト × 3 ブラウザ = 21 で、うち「ブラウザで CSP 違反が出ない」は
**設計どおり chromium 単一**（firefox / webkit で `test.skip`）＝ skipped 2 件。

### flaky について（隠さずに書く）

4件はいずれも**リトライで green**（例: `admin-news:108` は初回 60秒タイムアウト → retry#1 は **5.5秒**）。
いずれも P3-a が触っていない既存スペック（トップページ表示・お知らせ CRUD）で、
**失敗はすべて「タイムアウト」であり assertion の不一致ではない**。
本実行は 25.0 分かかっている（P2.5 完了時の実測は 82件で 59.5 秒）。
**同一マシン上で繰り返しビルド・サーバー起動・3ブラウザ実行を行った後の測定であり、
実行環境の負荷が支配的**と考えられる。§6.6 に切り分けの再実行結果を記す。


---

# 【Impl Agent 注記】以下のオーケストレーター追記との関係（2026-07-29 / 事実の突き合わせ）

**下の「【オーケストレーター追記】4.」は消していない。** ただし、その §4.1 と §4.5 は
**本記録がまだ書き終わっていなかった時点の状態**に対して書かれており、現在の文書とは食い違うため、
どちらが最新かを読み手が判断できるようにここで突き合わせる
（このプロジェクトが繰り返している「**文書に事実と異なる記述が入り、それが次工程の設計判断の入力になる**」
型の失敗を、この文書自身で起こさないため）。

| 追記の記述 | 現在の事実 |
|-----------|-----------|
| §4.1「§4〜§8 は書かれないまま」「ファイルは §3 で終わっている」 | **§4〜§9 は本ファイルに存在する**（`grep -n "^#"` で確認可能）。追記が挿入された位置が §6.5 の直後だったため、**§6.6 以降が追記の下に続く**構成になっている |
| §4.1「自己検証は…裏付け文書が存在しない」「**未実施として扱い**」/ §4.5「セマフォの自己検証は未実施」 | **実施済み**。手段は `scripts/verify-semaphore-p3a.ts`（本ファイルと同時にコミットされている実行可能なスクリプト）で、**実測ログは §7 にある**。追記を受けて**再実行して同一結果を再現し、終了コード 0 を確認した**（§7 の追記を参照）。**Security 監査への引き継ぎとしては §4.5 の3項目をそのまま維持する**——自己検証は Impl 自身による実測であり、**監査者自身の独立実測を代替しない**（P2.5 の教訓） |
| §4.2「Impl Agent は開示していない」 | 開示は **§5「契約テストに対して行った最小修正（3ファイル。すべて理由を記録する）」**にあり、追記が挿入された位置より**上**に既に存在していた。追記の §4.2 は独立にソースを検証して「**契約の弱体化なし**」という同じ結論に達しており、**§5 の記載を裏付けている**（行番号一致の検証は §5 より強い証拠なので、§4.2 は残す価値がある）。なお `tests/e2e/playwright/csp.spec.ts` も変更しており、これは §4 と §5 の表に記載がある（変更したテストは**4件**であって3件ではない） |
| §4.4「E2E は環境要因で3回失敗」 | **その通りで、独立に同じ結論に達している**。Impl 側の切り分けは §4（`networkidle` が成立しない理由の対照実験）と §6.6（flaky の単独再実行）にある。**追記の (a) dev DB / (b) port 3000 残留 / (c) 同時実行 の3点は、Impl 側が把握していなかった要因を含むため重要**である |

**この注記を受けて Impl が追加で行ったこと**: dev DB の稼働を確認したうえで、
**自己検証の再実行**と**E2E の再実行（1回のみ・競合なし）**を行い、§7 と §6.5 に実測を追記した。

---

# 【オーケストレーター追記】4. 本記録の未完了と、独立検証の結果（2026-07-29）

## 4.1 【訂正済み】本節の当初の記述は誤りだった

> **⚠️ 訂正（2026-07-29）**: 本節は当初「**§4〜§8 は書かれないまま Impl Agent が応答を停止した**」と
> 記していたが、**これは誤りである**。オーケストレーターが確認した時点（追記の直前）でファイルが §3 で
> 終わっていたのは事実だが、それは **Impl Agent がまだ作業中だった**ためであり、「停止した」という判断が
> 誤っていた。その後 Impl は §4〜§9 を完成させ、依頼にも応答した。
> **§7（セマフォ自己検証）は実施済み**であり、`scripts/verify-semaphore-p3a.ts` として
> **リポジトリにコミットされた実行可能スクリプト**で再現できる（再実行して同一出力・EXIT=0 を確認済みと報告）。
> したがって本節の「自己検証は未実施として扱う」という指示は**撤回する**。
>
> ただし **§4.5 の Security への引き継ぎ3項目は有効なまま維持する** — Impl 自身の実測は
> 監査者の独立実測を代替しないためである（実際、Security 監査は実 Redis 上で独立に再現し、
> 旧欠陥1・2 のいずれも再現しないことを確認した）。
>
> **教訓**: 「エージェントが応答しない」と「まだ作業中」は外から区別できない。
> 作業中の成果物を「未完了」と断定して記録すると、それ自体が事実と異なる記録になる
> （このプロジェクトが繰り返し潰してきた欠陥と同じ型を、オーケストレーター側で作ってしまった）。

以下は**オーケストレーターが独立に実測した結果**である（Impl の報告とは独立の観測として価値を持つ）。

## 4.2 テストファイル3件の変更（Impl Agent は開示していない）

Impl の実装期間中に以下が変更されていた。**指示では「明白な誤りのみ、理由をノートに記録した上で
最小限修正」を許容していたが、記録が無かった**ため、オーケストレーターが内容を検証した。

| ファイル | 変更時刻 | 検証結果 |
|---------|---------|---------|
| `tests/unit/env.test.ts` | 03:24 | **正当**。SEC-013（AUTH_SECRET 長さ）の describe に `P3A_REQUIRED` 土台を追加したのみ。**throw を期待する3ケースは未変更**で、`P3A_REQUIRED` は成功系ケースにだけ適用されている（検証対象を「AUTH_SECRET の長さ」1つに保つため）。ファイル内コメントに意図が明記されている。P3-a で KV / `FORM_SESSION_SECRET` / `CRON_SECRET` が本番必須になった以上、この土台無しでは成功系が落ちるので**必要な追随**である |
| `tests/unit/public-guard.test.ts` | 03:28 | **契約の弱体化なし**。`docs/review-p3a-tests-2026-07-29.md` §2.3 が列挙する契約行（94/102/110/118/131/139/157/168/180/190/209/226/232/243/249/260/281/292/307/321/337）が**すべて行番号まで一致**して現存 |
| `tests/unit/kv-store.test.ts` | 03:28 | **契約の弱体化なし**。同 §2.6 の契約行（97/105/114/136/147/156/178/210/214/220）が**すべて行番号まで一致**して現存 |

**結論: 3件とも契約を実装に合わせて緩めた変更ではない（改竄なし）。**

> **⚠️ 訂正（2026-07-29）**: (a) **変更は3件ではなく4件**である（上記 unit 3件に加え `tests/e2e/playwright/csp.spec.ts`）。
> 完全な開示は Impl の **§5** にある（§4 と併せて理由が記録されている）。
> (b) 「開示が無かった」という当初の記述も**時点の問題**であり、Impl は §5 で4件すべてを開示した。
> オーケストレーターが検証した時点で §5 が未完成だっただけである。
> **アサーションは1件も変更されていない**という Impl の申告は、上記の行番号照合と整合する。

## 4.3 オーケストレーターによる品質ゲート実測

| ゲート | 実測結果 |
|--------|---------|
| `pnpm test:unit` | ✅ **24 ファイル / 317 件 全パス** |
| `pnpm test:integration` | ✅ 5 ファイル / 28 件 全パス |
| `pnpm type-check` | ✅ エラー 0 |
| `pnpm lint` | ✅ warning / error 0 |
| `pnpm build` | ✅ 成功。**全ルートが `ƒ (Dynamic)`**（`/_not-found` `/schools` を含む＝ §3 の修正が反映されている） |
| `CI=1 pnpm test:e2e` | （§4.4 参照） |

## 4.4 E2E の実測で判明した環境要因（実装の欠陥ではない）

E2E は当初3回連続で失敗したが、**いずれも実装の欠陥ではなく環境要因**だった。切り分けの記録:

1. **1回目（exit 137）**: dev DB（Docker `driving_school_pg` / :5433）が停止しており、公開ページが
   `PrismaClientInitializationError: Can't reach database server at localhost:5433` で落ちていた。
   その結果 `csp.spec.ts:114`（**実ブラウザで CSP 違反が出ないこと**）が失敗した。
   → `scripts/dev-db.sh up` → `prisma migrate deploy`（差分なし）→ `pnpm db:seed` で復旧（データは維持）。
2. **2回目**: Impl Agent が**同時に E2E を実行しており競合**、CSP テストが不正に全滅した。
   プロセス（`playwright` / `next start` / `chrome-headless-shell`）を実測して特定。
3. **3回目**: 中断した実行の `next start` が **port 3000 を掴んだまま残留**しており、
   `admin-auth` / `admin-authz` がタイムアウトした。`admin-authz.spec.ts` を**単独で再実行したところ 20 件全パス**。

> **運用上の教訓**: E2E は「失敗したら実装を疑う」前に、**(a) dev DB が上がっているか、(b) port 3000 に
> 残留サーバーが無いか、(c) 他プロセスが同時に E2E を回していないか**を確認すること。
> 3回とも実装は無罪だった。掃除は `lsof -ti:3000 | xargs kill -9` まで含めること
> （`pkill -f 'next start'` だけでは `next-server` が残る）。

## 4.6 E2E の確定値 — オーケストレーターと Impl で結果が食い違っている（両方を記録する）

同一コードに対する2回のフル実行で、**結果が一致しなかった**。どちらかが誤りなのではなく、
**この E2E スイートが実行条件に敏感である**という事実の観測である。隠さず両方を残す。

| 実行者 | 結果 | 所要 |
|--------|------|------|
| オーケストレーター（独立実測） | **94 passed / 4 flaky / 2 skipped / 0 failed** | 29.0m |
| Impl（DB稼働・競合なしを確認後の確定版） | **91 passed / 1 failed / 4 flaky / 2 skipped / 5 did not run** | 29.8m |

**Impl は先の「0 failed」報告を自ら撤回し、1 failed を確定版とした。** この訂正は正しい姿勢である。

### 唯一の failed の位置（実装の契約は通っている）
`admin-authz.spec.ts:160` — **検証対象そのものは通っている**:
- `:175` `expect(res.status()).toBe(403)` ＝ **クロスオリジン POST が 403 という契約は満たされている**
- `:178` `prisma.news.findFirst(...)` ＝ **テスト側の事後確認ヘルパ**が `PrismaClientInitializationError`

### Impl の環境調査（「たぶん環境」で終わらせていない点を評価する）
| 観測 | 実測 |
|------|------|
| DB コンテナ | `RestartCount = 0` / FinishedAt = 0001-01-01（**一度も落ちていない**）|
| 実行中の接続数 | ピーク **12 / max_connections 100**（枯渇していない）|
| 当該スペック単独・`--retries=0` | **20/20 pass・40.6秒・EXIT=0** |
| フル実行時の同テスト | 2.2m → 1.3m → 2.0m（**3試行とも 60秒超過** ＝ flaky 扱い不可）|

**Impl の推定**: `withPrisma` が**呼び出しごとに `new PrismaClient()` を生成**（`admin-authz.spec.ts:117`）し、
1スペックで10回以上走るため、高負荷下でエンジン起動＋TCP 確立が 60秒に収まらなかった。

**Impl は「環境要因と確定した」とは書いていない**（示せたのは「DB は落ちていない」「接続は枯渇していない」
「単独なら通る」の3点のみで、高負荷時に接続確立が失敗する条件は未特定）。この線引きは正しい。

### 扱い
- **P3-a 完了宣言の前に閉じること**（Impl 申し送り I-7 を「flaky 4件」から「**1 failed を含む**」へ格上げ済み）。
- 次の検証は **CI（専有ランナー / workers:1）で1回流す**こと。
- 併せて**テストヘルパが呼び出しごとに `PrismaClient` を新規生成している点**は、実装ではなくテスト基盤の
  改善対象として扱う（1つの `PrismaClient` を使い回す形にすれば、この不安定性は構造的に消える）。

## 4.5 引き継ぎ（次工程で必ず扱うこと）

- **セマフォの自己検証は未実施**（§4.1）。Security 監査が**監査者自身の実測**で以下を確認すること:
  - 上限まで埋めた状態で、`acquire` が継続的に到着している状況でも期限切れパーミットが回復する（旧機構の欠陥1）
  - 同時実行上限（`perShardLimit × K`）を超えて `acquire` が成功しない（旧機構の欠陥2＝最大2倍超過）
  - 二重 `release` が他のパーミットを解放しない
- **Lua スクリプト本体の意味論は未検証**（§0 で Impl 自身が申告。Node に Lua ランタイムが無いため）。
  フェイク KV は Lua を解釈しないので、**ユニットテストは Lua の中身を一切検証していない**。
  実 Upstash に対する検証をどう担保するかを Security 監査・レビューで判断すること。
## 6.6 flaky の切り分け（追加実行。**「リトライで通ったから良し」で終わらせない**）

| 実行 | 条件 | 結果 |
|------|------|------|
| ① フルスイート | `CI=1 pnpm test:e2e`（retries=2）| 97 passed / **4 flaky** / 2 skipped / **0 failed**（25.0m）|
| ② flaky 対象のみ再実行 | `top-page.spec.ts` + `admin-news.spec.ts` / **`--retries=0`** | top-page の 3件（firefox / webkit）は **全て pass**。`admin-news:108` は **2.9秒で `Target page, context or browser has been closed`**（assertion 不一致ではなく**ページ/コンテキストの突然の閉塞**）|
| ③ `admin-news.spec.ts` を単独で再実行 | **`--retries=0`** | **4件すべて pass（EXIT=0 / 1.3m）**。`:108` は 12.3秒 |

**結論**: 決定的な退行ではない。3回の実行で `admin-news:108` の失敗モードが
「60秒タイムアウト」→「2.9秒でページ閉塞」→「12.3秒で成功」と**毎回異なり**、
単独実行では安定して green になる。同一マシン上でビルド・`next start`・3ブラウザを繰り返した後の
測定であることと整合する（`phase-status.md` 運用メモの orphan playwright / SIGKILL(137) と同じ型）。

> **⚠️ Senior / Security への申し送り**: ただし**「環境のせい」で確定したとまでは言えない**。
> ③ が green であることは「単独なら通る」ことしか示しておらず、**負荷が高いときに壊れやすい経路が
> あるかどうかは切り分けていない**。CI（GitHub Actions / workers:1）で①を1回流し、
> flaky が出ないことを確認するのが次の検証である。**「4 flaky を 0 と報告してはならない。」**

---

# 7. 自己検証（テスト green を完了根拠にしない / `scripts/verify-semaphore-p3a.ts`）

本物の `lib/semaphore.ts` に**直接シナリオを投入**した実測（ユニットテストとは独立の経路）。

> **再現性の確認（オーケストレーター追記 §4.1「未実施」への回答 / 2026-07-29 追記）**:
> **再実行して同一の出力を再現し、終了コード 0 を確認した**（`SELFVERIFY_EXIT=0`）。
> 検証手段はこの文書の外の記述ではなく、**リポジトリにコミットされた実行可能スクリプト
> `scripts/verify-semaphore-p3a.ts`**（レビュワーが `pnpm tsx scripts/verify-semaphore-p3a.ts` で
> そのまま再現できる）。**ただし §8 I-1 のとおり、これは TypeScript 側のロジックの実測であって
> Lua 本体の意味論の検証ではない。また Impl 自身による実測なので、Security 監査者自身の
> 独立実測を代替しない**（オーケストレーター §4.5 の3項目はそのまま有効な引き継ぎである）。

`pnpm tsx scripts/verify-semaphore-p3a.ts` の出力そのまま:

```
P3-a セマフォ 自己検証（本物の lib/semaphore.ts に対する実測）
TTL = 20000ms / 基準時刻 T0 = 1800000000000

[S-1] 継続負荷下でのリース回復（release を一度も呼ばない）
  満杯の固定: 容量3を取得後の追加 acquire = null（＝以降の成功は回復が原因と言える）
  期限前の継続負荷: 99 回の acquire がすべて null（TTL=20000ms / 200ms 間隔）
  期限経過後: acquire が成功（key=sem:{applications}:0）＝ 恒久枯渇は再現しない
  掃除の実測: 期限経過後の在庫 = 1（期限切れ3件が回収された）

[S-2] 同時実行上限（perShardLimit × K）を超えて acquire が成功しない
  K=1 / perShardLimit=3: 並行 23 件 → 成功 3 / 上限 3 / 濃度の観測最大 3 / 確定在庫 3 / eval 発行 23 回
  K=4 / perShardLimit=3: 並行 32 件 → 成功 12 / 上限 12 / 濃度の観測最大 12 / 確定在庫 12 / eval 発行 32 回
  TTL 境界をまたぐ系列: 濃度の観測最大 3 / 上限 3

[S-3] 二重 release の冪等性 / release のシャード局所性
  二重 release: 3件取得 → 同一 permitId を3回 release → 在庫 2（期待 2）
  release の局所性: sem:{applications}:1 を release → 当該シャード 0 / 他シャード 1

=== 全シナリオ PASS ===
```

## 何が実証され、何が実証されていないか

| 指示された確認項目 | 実測 | 判定 |
|------------------|------|------|
| 上限まで埋めた状態で `release` されないパーミットの期限が過ぎた後、**`acquire` が継続的に到着している状況でも**パーミットが回復する（旧機構の欠陥1）| 満杯を固定 → **期限前に 99 回の `acquire` を投げ続けて全て null** → 期限経過後の `acquire` が成功。在庫は 3 → 1（期限切れ3件が回収され新規1件が入った）| ✅ **欠陥1は再現しない** |
| **同時実行上限（`perShardLimit × K`）を超えて `acquire` が成功しない**（旧機構の欠陥2＝最大2倍超過）| K=1: 23並行 → 成功ちょうど 3。K=4: 32並行 → 成功ちょうど 12。**コマンド境界で観測した濃度の最大値も上限と一致**（3 / 12）。TTL 境界を跨ぐ系列でも最大 3 | ✅ **欠陥2は再現しない**（一瞬の超過も観測されない）|
| **二重 `release`** が他のパーミットを解放しない | 同一 `permitId` を3回 `release` → 在庫 3 → **2**（減ったのは自分の1件だけ）| ✅ |
| （追加）`release` のシャード局所性 | 先頭以外のシャードのパーミットを `release` → 当該 0 / 他シャード 1 | ✅ |
| （追加）1 `acquire` = 原子操作1回 | `eval` 発行回数が `acquire` 回数と厳密に一致（23/23・32/32）| ✅ |

**この自己検証で使った KV は インメモリのフェイクである（実 Redis ではない）。**
したがって**検証したのは `lib/semaphore.ts` の TypeScript 側のロジックと呼び出し規約**であって、
**Lua スクリプト本体の意味論ではない**。§8 に残余リスクとして明記する。

---

# 8. 残余リスク（この作業で**検証できていないこと**。隠さない）

| # | 内容 | 引き継ぎ先 |
|---|------|----------|
| **I-1** | **Lua スクリプト本体の意味論は未検証。** Node に Lua ランタイムが無いため、ユニットテストのフェイクも §7 の自己検証も**参照実装を実行しているだけ**で、`SEMAPHORE_ACQUIRE_LUA` の文字列は「同一であること」と「構造（出現順・掃除より前に分岐が無い・`TIME` を読まない・`KEYS`/`ARGV` の使用）」しか見ていない。**「ユニットが green だから Lua が正しい」と報告してはならない**（Test 申し送り T-1 をそのまま維持）。`ZCARD` の比較演算子の書き間違いのような形は検出できない | Senior / Security |
| **I-2** | **実 Redis に対する結合テストを P3-a に足していない。** 理由: (a) `@upstash/redis` は REST 経由でローカルの `redis:7` を直接向けられず `serverless-redis-http` 等のプロキシを CI に追加する必要がある、(b) AC-RL-11(e-3)（濃度の最大値）は `EVAL` が原子的な実 Redis では**原理的に観測できない**（`spec-p3-fix3` §6 S-3 と同じ理由）。**この受容を `docs/security-audit.md` に記録すること**が Test 申し送りの条件である | Security |
| **I-3** | **AC-RL-11(d) の手動確認（本物の Lua から `ZREMRANGEBYSCORE` を削った版で (a) が落ちること）は行っていない。** 自動化されているのは「契約 assertion がその型の欠陥を落とす」ことまで（`semaphore-contract-detects-defects.test.ts`）で、**本物のスクリプトを削った版**は試していない | Security（申し送り S-2）|
| **I-4** | **AC-010-13(c)（並行 N リクエストで応答時間が N に線形比例しない）の実測をしていない。** P3-a には公開エンドポイントの実ルートが1本も存在せず、測る対象がない（測れるのは P3-b 以降）。**(a)（`serialize` 非経由）は `semaphore.test.ts:594` と §7 の `eval` 発行回数で確認済み**。⚠️ **この結果を「シャード化が効いた証拠」と読み替えてはならない**（RV-P3DR2-009）——効いているのは `serialize` 非経由であって、単一ノード KV ではシャード化はスループットを変えない | Senior / P3-b |
| **I-5** | **KV クライアント（`createUpstashKvClient`）は実接続で動作確認していない。** 本番 KV インスタンスが無く、P3-a には KV を叩く実経路もないため。**配線（`withPublicMutation` への注入）は P3-b の作業**である。`lib/env.ts` の fail-fast は「未設定なら起動しない」ことまでを保証し、「設定された値で実際に疎通する」ことは保証しない | P3-b |
| **I-6** | **`limiters.formSession` 軸は実行されるコードパスを持たない。** 型と分岐は用意したが、キー解決（`formSessionKey`）を渡す呼び出し元が P3-a に存在しないためユニットテストも通っていない。**P3-b で配線するときに初めて実行される**（＝ 現時点では「動く」と報告できない） | P3-b |
| **I-7** | **E2E は「全パス」になっていない。** 確定版は **1 failed / 4 flaky / 5 did not run・`EXIT=1`**（§6.5.0）。failed の `admin-authz.spec.ts:160` は**契約（403）自体は通っており**、dev DB へ問い合わせる検証行が `PrismaClientInitializationError` で落ちている。DB は無傷（RestartCount 0 / 接続ピーク 12・上限 100）、単独実行なら 20/20 pass（40.6秒）だが、**「環境要因と確定した」とは書けない**（高負荷時に Prisma の接続確立が失敗する条件を特定していない）。**CI（専有ランナー / workers:1）で1回流すことが次の検証。P3-a の完了を宣言する前にここを閉じること** | Senior / Security |
| **I-8** | **CSP のブラウザ検証は `/` のみ**。`csp.spec.ts` は `/` しか開かない。§3 の `/schools` 空白化を捕まえたのは `school-access.spec.ts` である。**P3-b で対象を `/apply` に切り替える際、「CSP は csp.spec.ts で担保されている」と読み替えると、他ページの静的化のような欠陥を見落とす** | P3-b / Senior |
| **I-9** | **`app/layout.tsx` の `force-dynamic` を外すと、静的化されたページだけが無言で壊れる**（ビルドも型検査も lint も通る）。この依存関係はコード上のコメントに書いたが、**構造的な歯止め（テスト）は無い** | Senior |

---

# 9. スコープ管理（P3-a の外に着手していないことの確認）

| 項目 | 状態 |
|------|------|
| マイグレーション作成 | **していない**。`prisma/migrations` に追加なし |
| `pnpm db:generate` の明示実行 | **していない**（`pnpm add` でも `prisma generate` はスキップされた。`pnpm build` の `prisma generate` は P3-a 以前からの既存挙動）|
| `statusChangedAt` / `sessionIdHash` を参照するコード | **書いていない** |
| `/apply` / `POST /api/applications` / `/api/uploads/**` / `/api/cron/**` の実ルート | **作っていない**（P3-b / P3-c / P3-d）|
| `it.skip` の追加 | **0件**（`grep -c "it.skip" tests/unit` = 0 のまま）|
| 後続単位で再検証する条件（`phase-status.md` (2)）| **「達成」と書いていない**。構造の存在（ルート列挙テストが FS 走査型であること・`/api/cron/**` → `withCronAuth` の割り当てが表にあること）までを報告する |

## 変更したファイル

**新規**: `lib/semaphore.ts` / `lib/public-guard.ts` / `lib/form-session.ts` / `lib/cron-auth.ts` /
`lib/csp.ts` / `scripts/verify-semaphore-p3a.ts` / 本ファイル

**変更**: `lib/kv.ts`（書き直し）/ `lib/rate-limit.ts` / `lib/env.ts` / `middleware.ts` /
`app/layout.tsx`（`force-dynamic`）/ `package.json`（`@upstash/redis`）/ `.env` / `.env.example` /
`.github/workflows/ci.yml`（本番 fail-fast 対象キーの CI ダミー値）

**テスト（最小修正のみ。assertion は無変更）**: `tests/unit/public-guard.test.ts` /
`tests/unit/kv-store.test.ts` / `tests/unit/env.test.ts` / `tests/e2e/playwright/csp.spec.ts`（§5）
