# P3-b 差し戻し修正 — テスト設計（red の追加）

## 作成日: 2026-07-29
## 担当: Test Agent
## 対象: `docs/p3b-fix-plan-2026-07-29.md` の **Must Fix 6 件 + Should Fix 4 件**
## 前提: `docs/review-p3b-code-2026-07-29.md` RV-P3B-001〜009 / `docs/security-audit.md` SEC-057

---

## 0. 実測サマリー

| 種別 | 追加ファイル | 追加テスト | **red** | green |
|------|------------|-----------|--------|-------|
| 単体 | 4 | **38** | **13** | 25 |
| 結合 | 2 | **13** | **5** | 8 |
| E2E | 0（既存 2 ファイルへ追記） | **5**（× 3 ブラウザ = 15 エントリ） | 未実行 | 未実行 |
| **計** | 6 新規 + 2 追記 | **56** | **18** | 33 |

```
pnpm test:unit         → Test Files 3 failed | 44 passed (47)
                         Tests 13 failed | 707 passed (720)
pnpm test:integration  → Test Files 2 failed | 6 passed (8)
                         Tests 5 failed | 71 passed (76)
pnpm type-check        → 0 エラー
npx playwright test --list → Total: 172 tests in 9 files（+15 エントリ / 実行はしていない）
```

**退行なし。** 既存 682 unit は 707 − 25（新規の green）= **682 が全て pass**。
既存 63 integration は 71 − 8（新規の green）= **63 が全て pass**。
**red はすべて新規ファイル内**である（既存ファイルは 1 行も変更していない。
変更したのは `tests/e2e/playwright/csp.spec.ts` の**コメントのみ**と `apply-form.spec.ts` への**追記のみ**）。

### 実装コードの変更: 0 件
`lib/` `app/` `components/` `auth.ts` は一切変更していない。E2E の設定
（`playwright.config.ts`）も変更していない——**追記したテストは既存の webServer / projects でそのまま動く**ため。

---

## 1. 追加したファイル

| # | ファイル | 対象 | テスト数 / red |
|---|---------|------|--------------|
| 1 | `tests/unit/form-session-issue-cost.test.ts` | **SEC-057（High）** | 7 / **3** |
| 2 | `tests/integration/form-session-cost.int.ts` | **SEC-057（本番 2 ルート跨ぎの実測）** | 2 / **2** |
| 3 | `tests/unit/application-form-client-wiring.test.ts` | RV-P3B-001 / 002 / 008 / 009 | 9 / **8** |
| 4 | `tests/unit/runtime-stores-wiring.test.ts` | RV-P3B-003 | 18 / 0（**テスト追加が修正本体**） |
| 5 | `tests/integration/form-session-route.int.ts` | RV-P3B-004 / RV-P3B-007 | 11 / **3** |
| 6 | `tests/unit/public-guard-body-stream.test.ts` | RV-P3B-006 / SEC-059 | 4 / **2** |
| 7 | `tests/e2e/playwright/apply-form.spec.ts`（追記） | RV-P3B-005 / 001 / 002 | 5 / 未実行 |
| 8 | `tests/e2e/playwright/csp.spec.ts`（コメントのみ） | RV-P3B-005 の所在明示 | 0 |

---

## 2. **SEC-057 — 「入手コスト」をどう契約化したか**（最重要 / 指示の核心）

### 2.1 何が契約になっていなかったのか

P3b-1b は「Cookie 軸は要求元ごとに一意」を **型**（`PerRequesterKey`）で保証した。
しかし監査が指摘したとおり:

> **軸として機能するために必要なのは「一意であること」ではなく「入手にコストがあること」である。**

**一意性は型で表現できるが、入手コストは型では表現できない。**
型に書けるのは「値の形」であって「値を得るために攻撃者が払う量」ではない。
したがって観測できるのは**振る舞いだけ**であり、契約は振る舞いで書くしかない。

### 2.2 契約化した 1 文

> **縮退構成において、単一の攻撃者が本体（DB 書き込み・自動返信メール）へ到達させられる回数は、
> 取り直した Cookie の枚数に比例してはならない——すなわち「枚数に依存しない上限」が存在すること。**

これを **3 本の red** に分解した（`tests/unit/form-session-issue-cost.test.ts`）。

| テスト | 契約 | red の実測 |
|--------|------|-----------|
| 監査実測の再現 | Cookie 20 枚 × 3 回 = 60 送信が**全件通ってはならない** | `expected 60 to be less than 60`（**60/60 が本体へ到達**） |
| **比例しない** | Cookie を 40 → 200 枚（5 倍）にしても本体到達数が**増えない** | `expected 600 to be less than or equal to 120`（120 → **600 に増加**） |
| **上限が存在する** | 本体到達数 ≤ `FORM_SESSION_ISSUE_LIMIT`(30) × `FORM_SESSION_LIMIT`(3) = **90** | `expected 600 to be less than or equal to 90` |

**「比例しない」がこの契約の中核**である。単発の閾値テスト（「N 回目が 429」）は
**1 枚あたりの上限しか測れず、枚数を増やす攻撃を構造的に検出できない**。
スケールを 2 点で測ることでのみ「入手にコストがあるか」が観測できる。

上限値 **90** の根拠は「窓あたり無コストで得られる Cookie 枚数 × 1 枚あたりの送信上限」であり、
**AC-RL-13(c) が『Cookie 軸をタダで増やせない』と宣言したときに暗黙に約束していた値**である。
実装はこの約束を守っていなかった。

### 2.3 **同時に壊してはならないもの**（4 本の green = ガードレール）

コストの課し方を誤ると、SEC-057 を閉じた瞬間に**別の欠陥**が開く。以下は最初から green で、
**修正がこれらを赤くしたら、その修正は採用してはならない**。

| ガードレール | なぜ必要か |
|-------------|----------|
| 縮退でも Cookie 1 枚・3 回以内の利用者は 201 | 一律 Tier B は「機能不成立」（RV-P3B-001 と同型）。ローカル・E2E・Vercel 以外の本番でフォームが 1 件も受け付けられなくなる |
| 攻撃者が枠を使い切った後も、新しい利用者は **429 に落ちない** | **SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度再発した欠陥**。共有 `unknown` バケットの枯渇を硬いゲートにすると、第三者が枠を使い切るだけで全利用者が窓明けまで送信不能になる。**課してよいコストは回復可能なもの（Tier B / CAPTCHA）に限る** |
| 通常構成（`trusted=true`）の到達数は `SOURCE_LIMIT`(5) のまま | SEC-057 は縮退でのみ成立する。縮退対策を全構成へ適用して Vercel 上の正規利用者を CAPTCHA 地獄に落とさない |
| `createFormSessionValue({ sid, issuedAt })` の値が引き続き検証を通る | **後方互換**。既存 63 integration の手組み Cookie を一括で無効化すると「テストのほうを直す」圧力が生まれる。**既定は「検証済み」で、コストの印は opt-in** |
| 縮退構成で 40 回目も発行が続く（結合側） | 発行を止めると**第三者が 30 回叩くだけで `/apply` を封鎖できる**（`lib/form-session-issue.ts:16-18` が正しく警戒している形） |

### 2.4 なぜ単体と結合の**両方**が要るのか

SEC-057 が見逃された原因は「**個々の測定は正確だが、攻撃者の手順として結合されていない**」ことだった
（Impl の V-1 は「同一 Cookie を使い続ける前提」、V-4b は「縮退では発行が止まらない」を測ったが、
両者を突き合わせていない）。

- **単体**（`form-session-issue-cost.test.ts`）: `issueFormSession` × `withPublicMutation` を結合し、
  スケールを変えて測る。**決定的・高速**で、退行検知の本体。
- **結合**（`form-session-cost.int.ts`）: `GET /api/form-session` → `POST /api/applications` という
  **本番の 2 ルートを跨いだ 1 本の攻撃手順**として測り、**DB 行数**まで数える。
  単体は「2 つの Route Handler が実際にその関数を使っているか」を見ていないので、片方だけでは同じ見逃しが再発する。

結合側の red 実測:
```
Cookie を 20 枚取り直すだけで 60/60 件が受け付けられた（内訳: {"201":60}）
未認証の第三者が DB へ 60 行を作った（縮退構成 / 1 回の攻撃）
```
（監査実測と完全一致。テスト終了時に `afterAll` が 60 行を削除することを実測確認済み — 残存 0 行。）

---

## 3. Impl への要求（SEC-057）

1. **判定を正典関数に閉じること。** 縮退時の Cookie 判定を
   `app/api/applications/route.ts` の `verifyFormSession:` ラムダに書かないこと。
   判定の複製は **AC-RL-8 違反**であり、ラムダに書いた実装は
   `tests/unit/form-session-issue-cost.test.ts` を green にできない
   （同テストは `lib/form-session.ts` の正典関数で本番結線を再現している）。
   **`lib/form-session.ts` / `lib/form-session-issue.ts` に閉じること。**
2. **発行は止めないこと。** 縮退で `issued: false` を返す修正は
   `form-session-route.int.ts` の「40 回目も発行が続く」と
   `form-session-issue.test.ts`（既存）を赤くする。
3. **コストは回復可能な形で課すこと。** 429 ではなく Tier B（403 + `challenge`）。
   監査の修正方針 (a)（発行時の未検証フラグ）でも (b)（発行時にも Turnstile）でも、
   §2.2 の 3 本と §2.3 の 5 本を同時に満たせばよい。**実装方法は指定していない。**
4. **無コストで得られる Cookie 枚数の閾値は 20 未満に置くこと。**
   監査実測（20 枚 × 3 回 = 60 件成功）を閉じる条件である。
   現行の `FORM_SESSION_ISSUE_LIMIT = 30` をそのまま「フラグを立てる閾値」に流用すると、
   **監査が実測した 20 枚のシナリオでは 1 枚もフラグが立たず、何も直らない**。
   ここは Impl が明示的に決めて `lib/` にコメントで根拠を残すこと。
5. **既定は「検証済み」**。既存形式の Cookie（フラグ無し）は通ること（§2.3 の後方互換）。

---

## 4. 各指摘の契約と red の実測理由

### RV-P3B-001（Must Fix / 機能不成立）— Turnstile の結線

**テスト手段の選択理由（妥協ではない。レビュワーは必ず読むこと）**
本来は `ApplicationForm` をマウントし `window.onTurnstileToken('tok')` → 送信 → `fetch` の body を見るのが最良である。
しかし本リポジトリの単体環境は `environment: 'node'`、`include: tests/unit/**/*.test.ts`（`.tsx` は対象外）で、
**jsdom も `@testing-library/react` も依存に無い**（`package.json:40-54`）。
テストのために本番依存を増やす判断は Test Agent の範囲を超えるため、**2 層に分けた**:

- **単体（ソース走査）**: 属性値と実体の対応という**機械的に検証可能な部分**。
  `data-callback` の**属性値のタイポは型検査で絶対に捕まらない**ので、ここは jsdom を入れても残すべき層である。
- **E2E（実ブラウザ）**: 確認画面まで進めて `window.onTurnstileToken` が関数であることを実測。

| テスト | red の実測理由 |
|--------|--------------|
| (1) `data-callback` のグローバル定義が実在する | `属性値に対応するグローバル定義が無い: data-callback="onTurnstileToken"` |
| (2) `data-expired-callback` / `data-error-callback` を持つ | `expected [ 'data-callback' ] to include 'data-expired-callback'`（トークン寿命 300 秒。確認画面に 5 分留まると期限切れで Tier B） |
| (3) `turnstile.getResponse()` のフォールバック | `to match /getResponse\s*\(/` — 一度も呼んでいない |
| (4) payload の `captchaToken` が state の素の参照でない | `payload に \`captchaToken,\` をそのまま渡している` |
| (5) 死んだ受信経路を残さない | `'turnstile-token' を listen しているが dispatch する箇所が同ファイルに無い` |

**Impl への要求**: (5) が重要である。**現状の `addEventListener('turnstile-token')` は永遠に発火しない死んだコード**であり、
これを残したまま (1) だけ直すと、次のレビュワーが再び「結線済み」と誤認する。**消すこと。**

### RV-P3B-002（Must Fix）— `?fs=1` の URL 残留

| テスト | red の実測理由 |
|--------|--------------|
| マウント時に `?fs` を `history.replaceState` で消す | `to match /replaceState\s*\(/` — 書き換えが無い |
| URL 書き換えでページ遷移を起こさない | （green / ガードレール。`router.replace()` を使うと入力途中の状態を巻き込んで再マウントする） |
| E2E: `/apply` を開いた後の URL に `fs` が無い | 未実行 |
| E2E: Cookie を消してリロードすると必ず再発行される | 未実行（**目的側**の固定。URL の見た目ではなく振る舞い） |

**Impl への要求**: レビューの改善案 1（URL からマーカーを消す）を**必須**とする。
改善案 2（`__Host-fsa` の短命 Cookie）は任意——テストは要求していない。

### RV-P3B-003（Must Fix）— KV store 注入（**テスト追加が修正本体**）

実装は正しいので **18 本すべて最初から green** である。これは想定どおりだが、
**「常に green を返すだけのテスト」と区別できなければ退行検知の証拠にならない**（P2 の教訓）。
そこで **走査器の自己検証 7 本**（合成ソースに対して「store 無し」を検出できることの実証）を同梱した。

固定した内容:
1. `app/` `lib/` `components/` `auth.ts` 配下の**すべての** `createRateLimiter(` / `createSemaphore(` 呼び出しに `store` が渡っている
   （**出現回数の比較ではなく、括弧の対応を取った引数単位**で判定。コメント・定義側は除外する）
2. `createUpstashKvClient` / `createKvRateLimitStore` / `createKvSemaphoreStore` を
   **`lib/runtime-stores.ts` 以外から呼んでいない**（注入経路の一本化そのもの）
3. `isKvConfigured()` の契約 6 ケース（`https://` + token のときだけ true。`memory://` / `http://` / `httpsx://` / token 欠落は false）
4. `sharedRateLimitStore()` / `sharedSemaphoreStore()` のメモ化（接続の共有）と、
   KV 未設定時に rate limit store が `undefined`・セマフォ store は必ず値を返すこと

**Impl への要求**: 無し（修正不要）。**Senior / Security は本ファイルの存在をもって P3b-2 の完了条件を判定できる。**

### RV-P3B-004（Must Fix）— AC-RL-13(c) の配線（**テスト追加が修正本体**）

`form-session-route.int.ts` の 8 本が **Route Handler 経由**で固定する（既存の純関数テストは判定ロジックしか見ていない）:
303 → `/apply?fs=1` / `Set-Cookie: __Host-fs` / Cookie 属性 4 種 / オープンリダイレクト不成立（`?next=` `?name=` を引き継がない）/
30 回目まで発行・31 回目は発行しない / `Retry-After` を持つ / 別発信元は巻き添えにならない / 縮退では 40 回目も発行が続く。
**8 本とも green**（配線は正しい）。

> #### ⚠️ 契約の解決（Test Agent の判断。**Senior / Security へ明示的に申告する**）
> RV-P3B-004 は「31 回目が **429** + `retry-after`」と書き、
> RV-P3B-007 は「上限到達時に**生 JSON の 429 を見せず** `/apply` へ 303 し、ページと連絡先は必ず見せる」と書いている。
> **この 2 つは同じ応答について矛盾する。**
>
> 本テストは後者を採り、AC-RL-13(c) の**目的**で契約を書き直した:
> **(1) Cookie を発行しない・(2) `Retry-After` で待ち時間を伝える・(3) 利用者は `/apply` に到達できる**。
> **ステータスが 429 か 303 かは契約に含めない。**
> 根拠: AC-RL-13(c) が守るのは「Cookie 軸をタダで増やせないこと」であって
> 「利用者にエラーページを見せること」ではない。§4.11 のどの Tier も「ページが見られない」を含んでいない。
>
> したがって「31 回目は発行しない」「`Retry-After` を持つ」の 2 本は**現状の 429 実装のまま green**であり、
> 「フォームへ到達できる」の 1 本だけが red になっている。

### RV-P3B-005（Must Fix）— 実ブラウザの CSP 違反検証を `/apply` へ

`apply-form.spec.ts` に chromium 単一のテストを 1 本追加した。
**確認画面（review ステップ）まで進める**——Turnstile スクリプトは `step === 'review'` でしか読み込まれず、
サイト内で CSP 違反が起こりうる唯一の箇所がそこだからである。
違反 0 に加えて **`apply-step-confirm` と `turnstile-slot` が visible**（＝「白紙でない」）も見る
——違反 0 だけを見ると「何も描画されていないページ」も通る。

`csp.spec.ts` は `TARGET_PATH = '/'` のまま残した（**トップページの被覆を失わないため**）。
同ファイルのコメントに「`/apply` の実ブラウザ検証は `apply-form.spec.ts` にある」ことを明記した。
P3b-5 の「`csp.spec.ts` だけを根拠にしない」は
**`csp.spec.ts` + `apply-form.spec.ts` + `tests/unit/apply-page-contract.test.ts` の 3 層**で満たす。

**E2E は実行していない**（実行主体はオーケストレーター）。`--list` で 15 エントリの登録のみ確認した。

### RV-P3B-006 / SEC-059（Should Fix）— ボディ上限の打ち切り

| テスト | red の実測理由 |
|--------|--------------|
| 4MB の chunked ボディで読み取り量が上限 + 数チャンクに収まる | `上限 65536 バイトに対し 4194304 バイトを読み切っている` |
| 上限超過時にストリームを `cancel` する | `expected false to be true` |
| 上限内の chunked ボディは本体で読み直せる | （green / ガードレール。**この 1 本が無いと上の 2 本は「ボディを読まない実装」で通る**） |
| ちょうど上限は 201 / 1 バイト超過は 413 | （green / 境界。`>` と `>=` の取り違えを防ぐ） |

「読み取ったバイト数」という**観測できる量**で「検出できる」と「消費させない」の差を固定した。
`pull` ベースの `ReadableStream` で生成量を数えているので、リーダが要求した分だけが `produced()` に現れる。

**Impl への要求**: リーダで逐次読み、上限超過時に `await reader.cancel()` してから `null` を返すこと。
先読みの余裕は 4 チャンク（64KB）まで許容している。

### RV-P3B-007（Should Fix）— 発行枠の消費でページを奪わない

| テスト | red の実測理由 |
|--------|--------------|
| 上限到達時も利用者は `/apply` に到達できる | `status=429 / location=null`（**フォームの代わりに生 JSON が表示される**） |
| `Sec-Fetch-Dest: image` の要求は発行枠を消費しない | `第三者ページのサブリソース要求で、正規利用者の発行枠が使い切られている` |
| クロスサイトのサブリソース要求には Cookie を発行しない | `サブリソース要求に Cookie を発行している` |

3 本目の理由を補足する（レビューには無い観点）: `<img>` 経由で `__Host-fs` を配ると、
**攻撃者が被害者のブラウザに任意のタイミングで軸を作らせられる**——発行時刻（`issuedAt`）が
攻撃者の制御下に入り、**AC-RL-6 の送信間隔下限を事前に満たしておける**。
枠を消費しないことと Cookie を渡さないことは別の性質であり、両方要る。

**Impl への要求**: `Sec-Fetch-Dest: document` でない、または `Sec-Fetch-Site` が `cross-site` の要求は
**計数せず・Cookie も発行せず** `/apply?fs=1` へ 303 するだけにすること。
上限到達時も 303（`Retry-After` 付き）で `/apply` へ戻すこと。

### RV-P3B-008（Should Fix）— 表示と挙動の一致

**契約は「文面が自動再送を約束するなら、再送の実装が同ファイルに存在する」という含意**である。
red の実測: `「自動的に送信されます」と表示しているが、自動再送の実装が見当たらない`。

**Impl はどちらを選んでもよい**:
- (a) `retryAfterMs` 経過後に `submit()` を最大 3 回呼ぶ（識別子に `autoResend` / `retryAttempt` / `retryCount` 等を含めること。走査がこれを見る）
- (b) 文面を「しばらく時間をおいて、もう一度送信ボタンを押してください。」へ変え、再送ボタンを出す
  → **前件が偽になり green になる。嘘を消すことが最低条件である。**

### RV-P3B-009（Should Fix）— Tier B から出られない利用者の出口

red の実測: `代替導線（電話番号 / 連絡先）がフォームから参照されていない`。
固定した 2 点: **Tier B の連続回数を保持していること**（1 回目から代替導線を出すと通常の CAPTCHA 体験を壊す）と、
**代替導線の材料**（`@/lib/school-info` の import、または `0120-46-4163` / `0120-07-2633`）を持つこと。

サーバー応答は一切変えないので**契約ルール3 に抵触しない**（契約ルール3 はサーバー応答の要件であり、
クライアントが自状態から推測して案内を足すことを禁じていない）。

---

## 5. 「これが green なら排除されるもの」一覧（各テストの 1 文）

すべてのテストに**コード中のコメント**として記載済み。要約:

| 対象 | 排除されるもの |
|------|--------------|
| SEC-057 単体 ×3 | 縮退構成で Cookie を取り直しながら **DB 行とメールを無制限に生成する攻撃** |
| SEC-057 ガードレール ×4 | 「一律 Tier B」「共有バケットで 429」「全構成へ適用」「既存 Cookie の一括無効化」という**行き過ぎた修正** |
| SEC-057 結合 ×2 | 上記が**本番 2 ルートを跨いだ手順**として成立すること（単体だけでは Route が正典関数を使っているか見えない） |
| RV-P3B-001 ×5 + E2E ×2 | **本番で F-008 / F-010 が 1 件も受け付けられない**状態（機能不成立）／期限切れトークンでの Tier B ／死んだ結線による誤認 |
| RV-P3B-002 ×2 + E2E ×2 | 全項目入力後に 403 を受け**回復手段が無い**状態（リロード・ブックマーク・URL 共有で到達する） |
| RV-P3B-003 ×18 | 次に limiter を 1 本足す人の `store:` 書き忘れが**型検査も lint も全テストも緑のまま**通ること |
| RV-P3B-004 ×8 | ルートが `issueFormSession` を呼ばない／limiter を取り違える＝**発行が無制限になる**こと |
| RV-P3B-005 ×1 | CSP を緩めての Turnstile 対応（XSS → 入力値窃取）／CAPTCHA が壊れたままの公開／`/apply` の白紙化 |
| RV-P3B-006 ×4 | 未認証の第三者に**任意サイズのバッファを確保させる**こと／上限導入の副作用で全送信が壊れること |
| RV-P3B-007 ×3 | 第三者ページの `<img>` 31 個で**被害者から `/apply` を 10 分間奪う**こと／攻撃者が `issuedAt` を制御すること |
| RV-P3B-008 ×1 | 待っても何も起きないのに「自動的に送信されます」と表示し、利用者を待たせて離脱させること |
| RV-P3B-009 ×1 | Cookie ブロック利用者が**離脱以外の行き先を持たない**こと |

---

## 6. 申し送り

1. **jsdom を導入する判断が下りたら**、`application-form-client-wiring.test.ts` の (1)(3)(4) は
   「マウントして `fetch` の body を見る」テストへ置き換えてよい（そちらのほうが強い）。
   **ただし (2)（属性値とグローバル名の一致）は残すこと**——属性値のタイポは型検査で捕まらない。
2. **RV-P3B-004 と RV-P3B-007 の契約矛盾**（§4）は Test Agent が解決した。
   Senior が別の判断をする場合は `form-session-route.int.ts` の
   「上限到達時も利用者は `/apply` に到達できる」を差し替えること。
3. `form-session-cost.int.ts` は **AC-RL-6（3 秒）を跨ぐため実時間で 1 度だけ待つ**（実行時間 約 4 秒）。
   **待たないと全件 Tier B になり、SEC-057 が閉じているように誤って見える。**この待機を消さないこと。
4. **P3c-1 への引き継ぎ**: SEC-057 の修正は `uploads` エンドポイントにも同じ形で適用が要る
   （`docs/p3b-fix-plan-2026-07-29.md` P3c-1）。§2.2 の 3 本は
   **`endpoint` を差し替えるだけで `uploads` に転用できる形**に書いてある。
5. **SEC-058（Medium）は本単位のテスト対象外**とした（着手をブロックしない Medium であり、
   修正方針が「構築時検査を `limiters?.source` の外へ出す」という**実装の形の指定**を含むため、
   Should Fix 4 件の範囲外である）。P3-c で新しい公開エンドポイントを足す前に閉じること。
