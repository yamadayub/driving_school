# P3-b テスト設計記録（F-008 / F-010 / F-023 `/privacy`）

> Test Agent / 2026-07-29 / 対象 spec: `docs/functional-spec.md` v0.3.3
> 前提: P3-a 完了（Senior Approve / Security Critical 0・High 0）。**写真（F-009）は P3-c のためスコープ外。**

## 0. この文書の読み方と設計方針

本テスト設計の評価基準は、オーケストレーター指示のとおり
**「red になること」ではなく「壊れた実装を green にしないこと」**である。
P3-a では **unit 317件が全 green の状態で Security 監査の実測により High 2件が再現**した。
その2件の教訓を、本設計は次の形で構造に落とした。

| P3-a の教訓 | 本設計での対応 |
|------------|--------------|
| **SEC-043**: 名指しの警告コメントでも4度再発した。**型で強制する以外に止まらない** | 型レベルのテスト（`@ts-expect-error` / branded type）と**構築時 throw**を、振る舞いテストとは**別ファイル・別レイヤ**に置いた（§2 P3b-1 / P3b-1b） |
| **SEC-042**: 契約は正しかったが、**与えた入力が全て ASCII だったため脅威に到達しなかった** | **入力選定の点検表**（§3）を作り、攻撃者が値を決められる全関数に非 ASCII / 孤立サロゲート / 制御文字 / 長さ境界 / 巨大ボディを入れた |
| **P2**: テストは green だが**本番経路**が守られていなかった | 結合テストは **`app/api/applications/route.ts` の `POST` を直接呼ぶ**。バリデータ等のユニットが正しくても、ハンドラが結果を無視していれば落ちる |
| **P2.5**: red が全部 green になっても**脅威が閉じていなかった** | 監査が実測した攻撃シナリオ（D-1 / D-3 / D-4 / D-6）を、**実測値ごとテストに写した**（§2） |

各テストのファイル冒頭に「## 契約（Impl が実装すべきシグネチャ）」を置いてある。
**Impl はテストを読まずにシグネチャだけを見て実装できる**ようにしてある。

---

## 1. 追加したテスト一覧

### 1.1 ユニット（`tests/unit/`）

| # | ファイル | 宣言数 | 検証する契約 | red の実測 |
|---|---------|-------|------------|-----------|
| U1 | `age-eligibility.test.ts` | 14 | AC-008-8 / SPEC-007。境界日の暦月計算・月末丸め・**JST 基準** | `Cannot find module '@/lib/age-eligibility'` |
| U2 | `application-validator.test.ts` | 16 | AC-010-1 / 5 / 8、AC-008-6、F-008 境界値、AC-PII-2 | `Cannot find module '@/lib/validators/application'` |
| U3 | `receipt-number.test.ts` | 9 | AC-010-5 / SPEC-013（ULID・件数推測不可） | `Cannot find module '@/lib/receipt-number'` |
| U4 | `form-session-axis.test.ts` | 16（**実行時 42**） | **P3b-1b（SEC-052）/ P3b-11（SEC-055）/ SEC-056** | `TypeError: formSessionAxisKeyFromValue is not a function` ほか 42 failed |
| U5 | `public-guard-p3b-wiring.test.ts` | 25 | **P3b-1（SEC-053）/ P3b-1b / P3b-8 / P3b-4** | 17 failed（`expected [Function] to throw` / `expected 201 to be 413` ほか） |
| U6 | `api-route-guard-coverage-p3b.test.ts` | 14 | **P3b-7（SEC-054 ②③④）** + AC-010-14 のカバレッジ再検証 | 1 failed（`app/api/applications/route.ts が未作成`）。**強化スキャナの自己検証13本は green**＝網そのものは今日から機能する |
| U7 | `application-auto-reply.test.ts` | 15 | AC-010-6 / AC-010-9 / AC-PII-3 / **AC-RL-14** | `Cannot find module '@/lib/mail/auto-reply'` |
| U8 | `application-idempotency.test.ts` | 13 | **AC-010-4 / SPEC-017**（`sessionIdHash` の導出と定数時間比較） | `Cannot find module '@/lib/application-idempotency'` |
| U9 | `application-pii-log.test.ts` | 11 | **AC-PII-1 / AC-010-7 / AC-RL-10**（例外・スタックトレース経由を含む） | `Cannot find module '@/lib/pii-log'` |
| U10 | `application-spam-signals.test.ts` | 12 | **AC-RL-6**（送信間隔）+ Turnstile 検証の fail-closed | `Cannot find module '@/lib/spam-signals'` |
| U11 | `apply-draft-storage.test.ts` | 10 | **AC-008-3 (e)**（写真関連値を保存しない）+ 保存先の制約 | `Cannot find module '@/lib/apply-draft'` |
| U12 | `apply-page-contract.test.ts` | 13 | **P3b-5**（CSP の中身と matcher）/ **P3b-6**（force-dynamic）/ AC-008-5 / F-023 | `Cannot find module '@/lib/retention'` |
| U13 | `applications-route-contract.test.ts` | 10 | **P3b-1 のソース側固定** / AC-RL-15(a) / **P3b-4** | 9 failed（`app/api/applications/route.ts が未作成`） |
| U14 | `env-p3b-fail-fast.test.ts` | 7（**実行時 11**） | **P3b-3**（32文字下限）+ Turnstile の本番 fail-fast 昇格 | 5 failed（`expected [Function] to throw an error`） |
| U15 | `form-session-issue.test.ts` | 10 | **AC-RL-13(a)(c) / AC-RL-3 (3)**（Cookie 発行と発行の流量制限 30回/10分） | `Cannot find module '@/lib/form-session-issue'` |
| U16 | `helpers/route-guard-scan.ts` | —（ヘルパ） | P3b-7 の強化スキャナ本体 | — |

### 1.2 既存テストの修正（P3b-1b の明示要求）

| ファイル:行 | 変更 | 理由 |
|-----------|------|------|
| `tests/unit/public-guard-degraded-source.test.ts:170-215` | `formSessionKey: () => 'sid-abc'`（**定数キー**）を `formSessionAxisKey`（Cookie 由来）へ差し替え、「別 Cookie の利用者が巻き添え 429 にならない」ケースを1本追加 | **P3b-1b の明示要求**（`security-audit.md:2609`「`public-guard-degraded-source.test.ts:144` の定数キーを直す」）。監査は「**共有キーで硬いゲートになる形そのものが期待値として書かれている**」と指摘した |

> 監査の修正方針2「**共有キーを返す `formSessionKey` は 429 の理由にならない**ケースを1本足す」については、
> **branded type（`PerRequesterKey`）により共有キーを返す関数が書けなくなる**ため、
> 振る舞いテストではなく **(a) 型テスト**（U4 の `@ts-expect-error`）と
> **(b) Cookie 不在は 403 であって 429 ではない**（U5）の2本で置き換えた。理由は §4 T-Q6 に記す。

### 1.3 結合（`tests/integration/applications.int.ts`）— 31 宣言

**本番経路 `app/api/applications/route.ts` の `POST` を直接呼ぶ。** 外部 I/O（Cloudflare / Resend）だけ `vi.mock`。

| 群 | 検証する契約 |
|----|------------|
| 正常系 | INQUIRY 経路が単独で完結する（P3-b の完了条件）/ 自動返信1通 |
| AC-010-1 | INQUIRY + 申込専用項目 4種 → 422 かつ **DB 0件・メール0通** |
| AC-010-2 | クライアントの `priceFrom: 1` を無視し DB のコース料金を保存 |
| AC-010-3 | ハニーポット → Tier B・DB0件・メール0通・**Cookie 不在の Tier B と応答が完全一致** |
| AC-010-4 | (a) 同一 Cookie で `receiptNumber` /(b) 別 Cookie では `{idempotent:true}` のみ /(c) Cookie 無しは先に 403 /(d) `sessionIdHash` が null の既存行 /並行2リクエスト |
| AC-RL-3 | (1) 縮退構成で同一 Cookie の4回目が 429 /(1b) `Retry-After` /(2) Cookie 無しは Tier B かつ DB0件 / 改竄・期限切れ Cookie |
| AC-RL-6 | 3秒未満は Tier B / **クライアントが `formRenderedAt` を偽装しても変わらない** |
| AC-RL-14 | 同一宛先へ4件受付・**メールは3通** |
| Turnstile | 検証失敗は Tier B / トークンが実際に渡っている |
| AC-PII-2 | 本番経路の応答に入力値が反射しない |
| AC-008-8 | 年齢下限 400 / 応答に生年月日なし / **クライアントの基準日を無視** |
| AC-RL-7 / P3b-8 | Origin 欠落・クロスオリジン 403（`challenge` 無し）/ 415 / **413** / 壊れた JSON は 400 / 不正 UTF-8 でも 500 にしない |
| **AC-PII-1** | **正常系・400・Tier B（HP）・Tier B（Cookie 無）・422 の5経路で `console.*` を全捕捉し、PII が1つも出ないことを確認** + HP 充填値 + `sid` |

red の実測: `Cannot find module '@/app/api/applications/route'`（既存 integration 28件は全 green のまま）。

### 1.4 E2E

| ファイル | 件数 | 内容 |
|---------|------|------|
| `tests/e2e/playwright/apply-form.spec.ts` | 18 × 3ブラウザ = **54** | AC-008-1（**CSP の検証対象を `/apply` へ**）/ AC-RL-13(a) Cookie 発行 / AC-008-2 非レンダリング / AC-008-3 (b)(c)(d) / AC-008-6 / AC-008-7 / AC-008-5 / F-023 / AC-PII-9 |
| `tests/e2e/specs/apply-inquiry.spec.md` | 4シナリオ | agent-browser 用の探索シナリオ（Tier B / Tier D の UX を含む） |

**E2E は指示どおり実行していない。** `pnpm exec playwright test --list` で構文と件数を確認: **103 → 157 件（+54）**。

---

## 2. P3b-1〜11 の担保対応表

| # | 要件 | 担保するテスト | 種別 |
|---|------|--------------|------|
| **P3b-1** | `/api/applications` で `limiters.formSession` と `formSessionKey` を必ず渡す | `public-guard-p3b-wiring.test.ts:129-190`（**構築時 throw** 5本）/ `applications-route-contract.test.ts:33-58`（ソース走査）/ `applications.int.ts` AC-RL-3(1)（縮退で4回目 429 = 監査 D-1 の再現） | 構築時検査 + 構造 + 振る舞い |
| **P3b-1b** | `formSessionKey` は要求元ごとに一意。`enforce:true` をリテラルで書けない | `form-session-axis.test.ts:67-109`（**型テスト `@ts-expect-error`** 含む）/ `public-guard-p3b-wiring.test.ts:263-291`（**監査 D-3/D-4 の再現**）/ `public-guard-degraded-source.test.ts` の定数キー是正 | 型 + 振る舞い |
| **P3b-2** | limiter に KV store を注入。`.env.example` / `lib/env.ts` と実態を一致 | **⚠️ 本設計では未カバー（§5 の申し送り）**。`kv-store.test.ts`（既存）が store 実装を、`env-p3b-fail-fast.test.ts` が本番必須化を見るが、**「注入されていること」を固定するテストは書いていない** | — |
| **P3b-3** | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限 32文字 | `env-p3b-fail-fast.test.ts:36-70`（31/32 の境界 + 非本番は据え置き + 相互同一値の禁止） | 振る舞い |
| **P3b-4** | `now` にリクエスト由来の値を渡さない。`newPermitId` に決定的値を渡さない | `public-guard-p3b-wiring.test.ts:452-483`（`Date` / `x-client-now` / body の `clientNow` を偽装しても期限判定が変わらない）/ `applications-route-contract.test.ts:100-112`（ソース走査で `now: () => …request` / `newPermitId:` を禁止） | 振る舞い + 構造 |
| **P3b-5** | CSP の検証対象を `/apply` へ。**`csp.spec.ts` だけを根拠にしない** | `apply-page-contract.test.ts:37-100`（**ポリシーの中身**と **middleware matcher の適用範囲**を E2E とは独立に固定）/ `apply-form.spec.ts:47-79`（実応答） | ユニット + E2E |
| **P3b-6** | `app/layout.tsx` の `force-dynamic` に構造的な歯止め | `apply-page-contract.test.ts:106-140`（ルートレイアウトの export + **`app/` 配下に `force-static` が無いこと**） | 構造 |
| **P3b-7** | 列挙テストに再 export 検出 / `route.js` 走査 / エイリアス import の厳格化 | `helpers/route-guard-scan.ts`（実装）+ `api-route-guard-coverage-p3b.test.ts:38-120`（**合成ソースの自己検証**＝監査が通過させた3形を検出できることの証明） | 構造 |
| **P3b-8** | 公開エンドポイントにリクエストボディのサイズ上限 | `public-guard-p3b-wiring.test.ts:322-449`（content-length / 過少申告 / chunked / バイト境界 / **413 に `challenge` を含まない** / **評価順序2本**）/ `applications.int.ts`（本番経路で 413 かつ DB 未到達） | 振る舞い |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` を変更したら実 Redis で再実測 | **テストでは担保しない**（プロセス要件）。既存 `semaphore.test.ts` がスクリプト構造を固定しており、**変更すれば落ちる**ため変更の検知はできる。実 Redis の再実測は Security 監査の作業 | プロセス |
| **P3b-10** | `withCronAuth` に粗い試行回数制限（**P3-c までに**） | **本単位では未実装**（期限は P3-c）。既存 `cron-auth.test.ts` は退行していない | 対象外（期限内） |
| **P3b-11** | `formSessionKey` の段階で Cookie の形式検証 | `form-session-axis.test.ts:116-190`（形式不正 14種 × 2〈null / 例外なし〉+ 署名不正は軸を作る + **過大報告を防ぐ「残余リスクは残る」テスト**）/ `public-guard-p3b-wiring.test.ts:295-320`（**監査 D-6 の再現**: 形式不正 200種で `consume` 0回） | 振る舞い |

### 2.1 phase-status「(2) 各後続単位で再検証する」のカバー状況

| 条件 | 再検証単位 | 本設計での担保 |
|------|-----------|--------------|
| AC-RL-3（3本すべて） | P3-b | （1）（2）= `applications.int.ts` ✅ /（3）= `form-session-issue.test.ts:110-129` ✅ |
| AC-RL-6 | P3-b | `applications.int.ts` + `application-spam-signals.test.ts` ✅ |
| AC-RL-13(c)（`GET /apply` 発行 30回/10分） | P3-b | `form-session-issue.test.ts` ✅（**縮退時は共有 unknown バケットを硬いゲートにしない**ことも併せて固定） |
| AC-RL-14 | P3-b | `application-auto-reply.test.ts` + `applications.int.ts` ✅ |
| AC-010-14 のカバレッジ | P3-b | `api-route-guard-coverage-p3b.test.ts`（実ルートが対象に入ることを固定）✅ |
| AC-010-15 / AC-008-1 の対象ページ | P3-b で `/apply` へ | `apply-form.spec.ts` + `apply-page-contract.test.ts` ✅ |
| AC-010-4 の `sid` 照合 | P3-b | `application-idempotency.test.ts` + `applications.int.ts`（a〜d）✅ |

---

## 3. 入力の選び方が脅威モデルを覆っているかの点検（SEC-042 の教訓）

SEC-042 は「**契約は正しかったが、与えた5入力がすべて ASCII だったため Buffer 長の不一致に到達しなかった**」という失敗だった。
そこで「**攻撃者が値を完全に制御できる関数**」を洗い出し、各々に脅威クラスの入力が入っているかを点検した。

| 関数 / 経路 | 攻撃者の制御度 | 非 ASCII | 不正 UTF-8 / 孤立サロゲート | 制御文字 / NUL | 長さ境界 | 巨大入力 | 型違い |
|------------|--------------|:-------:|:------------------------:|:-------------:|:-------:|:-------:|:-----:|
| `isAgeEligible` / `ageEligibilityBoundaryDate`（birthDate） | 全 | ✅ 全角数字・和暦 | ✅ `\ud800` | ✅ NUL・RLO | ✅ 閏日/月末 | ✅ 6桁年 | ✅ Invalid Date |
| `parseApplicationInput`（全フィールド） | 全 | ✅ 𩸽・😀・全角/アラビア数字・半角カナ | ✅（エコーバック検証で `\ud800` 系） | ✅ NUL・ESC・RLO・CRLF | ✅ 1/50/51・0/1000/1001・10/11/12桁 | ✅ 10KB key・15KB name | ✅ null/配列/数値/真偽値 |
| `formSessionAxisKeyFromValue`（生 Cookie） | 全 | ✅ 日本語・絵文字 | ✅ 孤立サロゲート | ✅ NUL・空白 | ✅ 42/43/44・最大長 | ✅ 512超 | ✅ null/undefined |
| `verifyFormSessionValue`（既存 P3-a） | 全 | 既存 `form-session.test.ts` が担保（ファズ 20,000件） | — | — | — | — | — |
| `deriveSessionIdHash` / `sessionIdMatches` | 部分（鍵漏えい時は全） | ✅ 絵文字・日本語の sid | ✅ | — | ✅ 63/64/65文字の storedHash | ✅ 100KB | ✅ null/undefined |
| `verifyTurnstile`（token） | 全 | — | — | — | ✅ 空・100KB | ✅ | ✅ null/数値/配列/オブジェクト |
| `toDraftSnapshot`（クライアント状態） | 全（XSS 時） | — | — | — | ✅ 200KB | ✅ | ✅ 循環参照・File・関数 |
| `toErrorLogFields` / `createPiiSafeLogger` | 全（例外メッセージ経由） | ✅ 日本語氏名 | — | — | — | — | ✅ 循環参照・非 Error |
| `POST /api/applications`（ボディ） | 全 | ✅ | ✅ **不正バイト列 `0xff 0xfe`** | — | ✅ 413 境界 | ✅ 200KB | ✅ 壊れた JSON |
| `renderAutoReply`（applicantName） | 全 | ✅ | — | ✅ **CRLF（ヘッダインジェクション）** | — | — | — |

### 点検で見つかった「ASCII だけでは到達しない」テスト（明示的に足したもの）

1. **氏名の長さをコードポイントで数える**（`application-validator.test.ts`）——`String.prototype.length` で数える実装は、`𩸽` のようなサロゲートペアを含む氏名で **25文字しか入らない**。ASCII だけで検証すると絶対に見つからない、**正規利用者の締め出し**。
2. **ボディ上限をバイト数で数える**（`public-guard-p3b-wiring.test.ts`）——文字数で数えると UTF-8 で最大 3〜4倍のボディを通す。`'あ'.repeat(11)` = 33 バイトを 30 バイト上限に投げて固定した。
3. **`sessionIdMatches` の長さ不一致**（`application-idempotency.test.ts`）——`timingSafeEqual` に長さの違うバッファを渡すと `RangeError` になる。**SEC-042 とまったく同じ形**を新モジュールで繰り返さないための先回り。
4. **メールアドレスの CRLF**（`application-validator.test.ts` / `application-auto-reply.test.ts`）——自動返信の `Bcc` を増やす経路。AC-RL-14 が守ろうとした資産（送信ドメイン評判）と同じものが対象。
5. **`new Headers()` の制約を回避した設計**（`form-session-axis.test.ts`）——非 ASCII / NUL は `Headers` が構築時に拒否するため、**Request 経由では脅威入力が関数まで到達しない**。値を直接受ける `formSessionAxisKeyFromValue` を契約に含め、そちらへ脅威入力を当てた。**これを見落とすと「テストは通るが関数は守られていない」という SEC-042 と同型の空振りになる。**

### 覆っていない脅威（残余）

- **Lua スクリプト本体**（P3b-9）: 変更検知はできるが意味論は unit で検証できない。実 Redis の再実測は Security 監査に依存する。
- **`formSessionAxisKey` の形式検証を通る値でのバケット増殖**: 形式を満たす値は攻撃者にも作れる。閉じ切るのは **P3b-2（KV store = TTL ベース）**。`form-session-axis.test.ts` に**「1,000種の well-formed 値からは 1,000個の軸キーが作れる」ことを明示的に固定するテスト**を置き、後続の完了報告で「SEC-055 が完全に閉じた」と過大報告されるのを防いだ（P2.5 の教訓3）。

---

## 4. 仕様の矛盾・未確定に対して本テストが下した決定（Senior / Spec への申し送り）

**red が「意図した理由で」出ていることを保証するには、期待値が一意でなければならない。**
以下は仕様が一意に定めていなかった点で、**テスト側で確定値を置いた**ものである。異論があれば差し戻されたい。

| ID | 論点 | 仕様の状態 | 本設計の決定と理由 |
|----|------|-----------|------------------|
| **T-Q1** | 年齢下限の境界 | **SPEC-007 の内部で1日ずれている**。(1) 定義式「`birthDate + 18年 - 1ヶ月 <= 受信日`」/(2) 境界値ラベル「17歳11ヶ月**0日**は不可・**1日**は可」/(3) 注記「(b) ＝ 18歳の誕生日のちょうど1ヶ月前」。生年月日 2008-04-15 では「誕生日の1ヶ月前」= 2026-03-15 = **17歳11ヶ月0日**であり、(2) だけが (1)(3) と食い違う | **(1) の定義式を採用**（「定義」と明記され、(3) および §4.5・現行 FAQ「誕生日の1ヶ月前から入校可」と一致。2対1）。テスト名は満年齢ラベルを使わず**境界日そのもの**で書いた |
| **T-Q2** | 閏日生まれ（2008-02-29）の境界日 | SPEC-007 は (d)「うるう日生まれの判定」を必須テストに挙げるが**期待値を書いていない** | **`(年+18, 月-1, 日)` を1回だけ丸める** → 2026-01-29。「+18年してから丸め、さらに -1ヶ月」（→ 2026-01-28）を採らないのは、丸めが2回入ると**丸めの順序という第2の暗黙仕様**が生まれ実装ごとに1日ぶれるため |
| **T-Q3** | 郵便番号のハイフン | §4.5「7桁数字」のみ | **サーバーは 7桁 ASCII 数字だけを受ける**（`626-0001` は 400）。正規化はクライアントの責務。F-008 API 仕様の「7桁数字以外は 400」と整合 |
| **T-Q4** | 自動返信の送信失敗はスロットル枠を消費するか | AC-RL-14 に規定なし | **消費しない**。消費すると一時障害で3回失敗した宛先が**その後1時間まったく自動返信を受け取れない** |
| **T-Q5** | `sessionIdHash` の大小文字 | SPEC-017 は「hex」とだけ | **小文字 hex で保存・比較し、比較内で `toLowerCase()` しない**（定数時間比較の前に入力依存の処理を入れない） |
| **T-Q6** | 「共有キーを返す `formSessionKey` は 429 の理由にならない」ケース（監査の修正方針2） | 監査は**振る舞いテストを1本足せ**と指示 | **branded type にすると共有キーを返す関数が書けない**ため、振る舞いでは表現できない（キャストが要り、それはテストとして「キャストすれば壊せる」ことしか示さない）。代わりに **(a) 型テスト + (b) Cookie 不在は 403 であって 429 ではない + (c) ルートにキャストが無いことのソース検査**の3本で置き換えた |
| **T-Q7** | 422 と 400 の優先順位 | F-010 は両方を規定するが順序なし | **422 を優先**。形式エラーで早期 return すると E-010-6（type 逸脱）が観測不能になる |
| **T-Q8** | INQUIRY で「送られた」と見なす条件 | AC-010-1 は「1つでも送られた場合」 | **`undefined` / `null` / `''` / `[]` は「送っていない」**。存在判定（`'plans' in body`）にすると、UI 設計 §4.3 のとおり単一のフォーム状態を送るクライアントで**正規の問い合わせが全て 422 になる**（P3-b の完了条件「INQUIRY 経路が単独で完結する」に直撃） |
| **T-Q9** | `buildingName` の扱い | AC-008-2 の**非レンダリング**リストには入るが、AC-010-1 の **422 対象リスト**には入らない | **仕様どおりに分けた**（E2E は不在を検証、サーバーは 422 にしない）。意図的な差か確認されたい |

---

## 5. Impl に要求するモジュール一覧（新規 / 変更）

### 5.1 新規モジュール

| モジュール | 主な export | 担保する AC |
|-----------|-----------|-----------|
| `lib/age-eligibility.ts` | `ageEligibilityBoundaryDate(birthDate: string): string` / `isAgeEligible({ birthDate, receivedAt }): boolean` | AC-008-8 / SPEC-007 |
| `lib/validators/application.ts` | `parseApplicationInput(input, { receivedAt })` / `INQUIRY_FORBIDDEN_FIELDS` / `isHoneypotFilled` | AC-010-1/5/8, AC-008-6, AC-PII-2 |
| `lib/receipt-number.ts` | `RECEIPT_NUMBER_LENGTH` / `generateReceiptNumber({ now?, randomBytes? })` | AC-010-5 / SPEC-013 |
| `lib/application-idempotency.ts` | `deriveSessionIdHash(sid, secret)` / `sessionIdMatches(storedHash, sid, secret)` | AC-010-4 / SPEC-017 |
| `lib/spam-signals.ts` | `MIN_SUBMISSION_INTERVAL_MS` / `isSubmissionIntervalSatisfied({ issuedAt, receivedAt })` | AC-RL-6 |
| `lib/turnstile.ts` | `verifyTurnstile(token, { secret, remoteIp?, fetchImpl?, timeoutMs? })` | Tier B / E-010-1 |
| `lib/pii-log.ts` | `PII_DENY_KEYS` / `createPiiSafeLogger(sink)` / `toErrorLogFields(error)` | AC-PII-1 / AC-010-7 / AC-RL-10 |
| `lib/mail/auto-reply.ts` | `AUTO_REPLY_LIMIT_PER_HOUR` / `renderAutoReply` / `autoReplyThrottleKey` / `sendAutoReply(input, deps)` | AC-010-6/9, AC-PII-3, AC-RL-14 |
| `lib/apply-draft.ts` | `APPLY_DRAFT_STORAGE_KEY` / `DRAFT_FORBIDDEN_KEYS` / `toDraftSnapshot` / `isDraftStorageAllowed` | AC-008-3 |
| `lib/retention.ts` | `RETENTION_PERIODS`（3年/1年/30日/180日/24時間/14日） | AC-008-5 / F-023 |
| `lib/form-session-issue.ts` | `FORM_SESSION_ISSUE_LIMIT = 30` / `FORM_SESSION_ISSUE_WINDOW_MS = 600_000` / `issueFormSession({ clientIp, limiter, secret, now?, randomBytes? })` | AC-RL-13(a)(c) / AC-RL-3 (3) |
| `app/api/applications/route.ts` | `export const POST = withPublicMutation(…)` / `export const maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC` | F-010 全体 |
| `app/(public)/apply/page.tsx` | `GET /apply` で `Set-Cookie`（AC-RL-13(a)）+ ステップ式フォーム | F-008 |
| `app/(public)/privacy/page.tsx` | 保持期間を `lib/retention.ts` から描画 | F-023 / AC-008-5 |

### 5.2 既存モジュールへの追加

| モジュール | 追加する export / 変更 |
|-----------|---------------------|
| `lib/form-session.ts` | `PerRequesterKey`（branded）/ `FORM_SESSION_SIGNATURE_LENGTH = 43` / `FORM_SESSION_VALUE_MAX_LENGTH = 512` / `newFormSessionPayload({ now?, randomBytes? })`（**sid は 32桁小文字 hex** / SEC-056）/ `readFormSessionCookie(request)` / `formSessionAxisKeyFromValue(value)` / `formSessionAxisKey(request)` |
| `lib/public-guard.ts` | `MAX_PUBLIC_REQUEST_BODY_BYTES = 65536` / `PublicGuardOptions.maxBodyBytes` / **`formSessionKey` の戻り値型を `PerRequesterKey \| null` へ** / **構築時 throw**（`limiters.source` があるのに `limiters.formSession` か `formSessionKey` が欠けている構成）/ 413 応答（`challenge` を含まない）/ ボディ計測後に handler へ**読み直せる Request** を渡す |
| `lib/env.ts` | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番 32文字下限、`TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` を本番必須へ昇格、`FORM_SESSION_SECRET !== CRON_SECRET` |
| `lib/mail.ts` | `sendMail({ to, subject, text }): Promise<void>`（Resend 実装。`sendApplicationReceipt` のプレースホルダは `lib/mail/auto-reply.ts` へ移す） |
| `middleware.ts` | 変更不要の見込み（matcher は既に `/apply` を含む）。**変えるなら `apply-page-contract.test.ts` が落ちる** |

### 5.3 評価順序の契約（`withPublicMutation`）

```
1. Origin 検証（fail-closed / 403・challenge なし）
2. Content-Type 検証（415）
3. content-length による**事前**ボディ上限判定（413）   ← ヘッダだけで判る超過は無料で落とす
4. Tier D: 発信元軸 / フォームセッション軸（429）
5. Tier B: verifyFormSession（403 + challenge）
6. Tier C: セマフォ（202）
7. 実バイト数によるボディ上限強制（413）              ← レート制限済みの相手にメモリを使わせない
8. 本体
```
（3 と 7 の位置は `public-guard-p3b-wiring.test.ts` の「評価順序」2本が固定する）

---

## 6. マイグレーション（`Application.statusChangedAt` / `sessionIdHash`）の扱い

`docs/phase-status.md` の DB ドリフト注記のとおり、**2つのフィールドは未マイグレーション**であり、
**「P3-b 着手前に1回のマイグレーションにまとめる」**ことが確定している。本テスト設計での扱いは次のとおり。

1. **テストからは新カラムを Prisma の型経由で参照しない。**
   `applications.int.ts` は `sessionIdHash` を `select` にも `where` にも書かない。
   - 理由 (a): **Prisma Client 未再生成の現時点でも `pnpm type-check` を緑に保つ**ため
     （書くと `tsc` が全員に対して赤くなり、他の red の意味が読めなくなる）。
   - 理由 (b): **検証すべきは列の値ではなく「別 Cookie に `receiptNumber` を返さない」という
     観測可能な契約**だから（P2 の教訓: 実装の内部ではなく本番経路の契約を検証する）。
2. **AC-010-4 (d)（`sessionIdHash` が `null` の既存行）は、列を書かずに行を作って検証する。**
   `prisma.application.create` に `sessionIdHash` を渡さなければ既定で null になるため、
   マイグレーション後もテストを変更せずに成立する。
3. **Impl への手順（この順序を守ること）**:
   `prisma/schema.prisma` は既に2フィールドを持つ → **`pnpm db:migrate` でマイグレーションを作成** →
   `pnpm db:generate` → 実装。**`pnpm db:generate` を先に走らせてはならない**
   （スキーマにあって DB に無い列を Client が知る状態になり、参照した瞬間に実行時エラーになる。
   `phase-status.md` の注記および `prisma/schema.prisma` のフィールドコメントを参照）。
4. **`statusChangedAt` は P3-b では参照しない**（対象は P3-d）。同じマイグレーションに含めるだけである。

---

## 7. 本設計が担保**していない**もの（過大報告を防ぐための明示）

| 項目 | 理由 / 引き取り先 |
|------|-----------------|
| **P3b-2**（KV store の注入） | 「注入されていること」を固定するテストを書いていない。`auth.ts` と公開ルートの両方が対象で、**注入経路の設計（モジュール構成）が未定**のため。Impl の実装形態が決まった時点でテストを追加する必要がある。**これは P3-b の完了条件なので、Senior / Security は「テストが無いこと」を承認しないこと** |
| **AC-RL-13(c) の配線先** | 判定ロジックは `form-session-issue.test.ts` が固定したが、**`GET /apply`（Server Component）からどう呼ぶか**（middleware / `headers()` 経由 / Route Handler 化）は設計判断であり、テストは形態に依存しないよう純関数側に置いた。**Impl は配線後に「`/apply` を 31回開くと 429」を E2E か結合で1本足すこと** |
| **P3b-9**（実 Redis 再実測） | プロセス要件。unit ではスクリプトの**変更検知**までしかできない |
| **P3b-10**（`withCronAuth` の試行回数制限） | 期限は P3-c。本単位では対象外 |
| **AC-RL-12(c)** のジッタ再検証 | P3-a の `public-guard.test.ts` が担保済み。P3-b で退行させていないことは既存テストが見る |
| **AC-008-3 (e) の E2E**（写真を添付した状態で下書き保存が走った直後） | **写真は P3-c**。ユニット（`apply-draft-storage.test.ts`）で「写真関連値を含む状態を渡しても保存されない」ことを先に固定してある。**P3-c で E2E を足すこと** |
| Tier C（202）の本番経路 E2E | セマフォを実際に枯渇させる E2E は不安定。ユニット（P3-a）+ 結合の Tier D で代替 |

---

## 8. 実測サマリ（2026-07-29 時点）

| ゲート | 結果 |
|--------|------|
| 追加テスト規模 | ユニット **15ファイル / 195 宣言**（`it.each` 展開後はさらに多い）+ ヘルパ1 / 結合 **1ファイル・31 宣言** / E2E **1ファイル・18 × 3ブラウザ = 54** + Markdown シナリオ4本。既存 `public-guard-degraded-source.test.ts` を P3b-1b の要求どおり修正（+1件） |
| `pnpm test:unit` | **75 failed / 387 passed（462）** — 既存 359件は全て green のまま（退行 0）。9ファイルは対象モジュール未作成で collect 不可（`0 test` 表示） |
| `pnpm test:integration` | **1 failed（suite）/ 28 passed** — 既存 28件は全て green。`applications.int.ts` は `Cannot find module '@/app/api/applications/route'` |
| `pnpm type-check` | **red**（全て `TS2307/TS2305/TS2724 = 未作成モジュール・未 export` と、`form-session-axis.test.ts:107` の `Unused '@ts-expect-error'`）。**意図した red のみで、書き間違いによる型エラーは 0** |
| `pnpm exec playwright test --list` | **157 tests in 9 files**（103 → +54）。**E2E は指示どおり実行していない** |

> `form-session-axis.test.ts:107` の `Unused '@ts-expect-error' directive` は
> **branded type が未実装であることの証拠**である（`PerRequesterKey` が入れば
> `'sid-abc'` の代入がエラーになり、ディレクティブが「使われる」）。**Impl 完了後に自動で消える red。**
