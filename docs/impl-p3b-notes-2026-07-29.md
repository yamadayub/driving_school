# P3-b 実装記録（F-008 / F-010 / F-023 `/privacy`）

> Impl Agent / 2026-07-29 / 対象: `docs/review-p3b-tests-2026-07-29.md` のテスト契約
> 前提: P3-a 完了（Senior Approve / Security Critical 0・High 0）。**写真（F-009）は P3-c のためスコープ外。**

## 0. この文書の読み方

**「テストが green になった」を完了根拠にしていない。** §5 に、テストとは独立に
実装モジュールへ直接シナリオを投入した実測（`scripts/verify-p3b.ts`）を置いた。
§8 に**報告できないこと・検証できていないこと**を明示する。

---

## 1. マイグレーション（順序厳守の指示への対応）

指示どおり **`pnpm db:migrate` → `pnpm db:generate` → 実装**の順で行った。

```
Applying migration `20260728224332_application_status_changed_at_and_session_id_hash`
prisma/migrations/20260728224332_application_status_changed_at_and_session_id_hash/migration.sql
✔ Generated Prisma Client (v6.19.3)
```

- `Application.statusChangedAt` と `Application.sessionIdHash` を **1 回のマイグレーションにまとめた**
  （`docs/phase-status.md` の DB ドリフト注記の方針どおり）。
- `pnpm db:generate` を先に走らせていない（`prisma migrate dev` が生成まで行った）。
- `statusChangedAt` は P3-b では参照していない（対象は P3-d）。

---

## 2. テストに加えた修正（3 件）と、その理由

**アサーションを実装に合わせて変えていない。** 以下は「**その入力・期待値のままでは、いかなる実装でも
満たせない**」ことを実測で確認したものだけであり、いずれも契約の意図はそのまま保っている。

### (a) `tests/unit/public-guard-p3b-wiring.test.ts` — 評価順序テストの**入力**

| 項目 | 内容 |
|------|------|
| 変更 | `request({ cookie, body: 'x'.repeat(2_000) })` → `streamingRequest('x'.repeat(2_000), '2000')` |
| アサーション | **未変更**（`expect(response.status).toBe(413)`） |
| 理由 | **WHATWG の `Request` コンストラクタは `Content-Length` を付けない**（付けるのは fetch の送信段階）。Node v20.19.6 / undici で実測: `new Request(url, { body: 'x'.repeat(2000) }).headers` は `content-type` と `origin` のみ。したがって元の入力は「content-length を持たないボディ」であり、**同 describe の次のテストが 429 を要求する `streamingRequest(...)` と公開 API 上まったく区別できない**（`Symbol(state)` の内部を覗く以外に手段が無い）。2 本は同時に満たせなかった |
| 影響 | 固定したかった評価順序（3: 宣言値による事前判定 → 4: レート制限）はそのまま検証される。Next.js の実ランタイムでは受信リクエストが `content-length` を持つため本番の意味は変わらない |

### (b) `tests/unit/applications-route-contract.test.ts` — `maxDuration` の実現方法

| 項目 | 内容 |
|------|------|
| 変更 | 期待値を「識別子で書く」から「**リテラル + 型アサーションで定数と結ぶ**」へ |
| 理由 | **Next.js のセグメント設定は静的解析されるため識別子を書けない。** 実測（Next 15.5.22）:<br>`⨯ Next.js can't recognize the exported 'config' field in route "/api/applications/route": Unknown identifier "PUBLIC_HANDLER_MAX_DURATION_SEC" at "maxDuration".`<br>`⨯ Invalid segment configuration export detected.` → **`pnpm build` が失敗する**。同一ファイル内のローカル const に置いても `Unknown identifier "LOCAL_MAX_DURATION"` で同じく落ちる |
| 代替 | `export const maxDuration = 10` の直下に `const assertMaxDurationMatchesSemaphore: typeof maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC` を置いた。**片方だけ変えると `pnpm type-check` が落ちる**という AC-RL-15(a) の性質は保たれる（テストはこの結線の存在をソースで固定する） |

### (c) `tests/integration/applications.int.ts` — 診断メッセージが本文を消費していた

| 項目 | 内容 |
|------|------|
| 変更 | `expect(response.status, await response.text().catch(() => ''))` → `await response.clone().text()` |
| 理由 | `expect(actual, message)` の**第2引数は先に評価される**ため、元のコードは必ず本文を読み切り、次行の `response.json()` が `Body is unusable: Body has already been read` で落ちていた。**実装に依らず常に失敗するテスト**だった |

### 既存テストへの追随（P3-b の契約変更が要求したもの / アサーション未変更）

| ファイル | 変更 | 理由 |
|---------|------|------|
| `tests/unit/public-guard.test.ts`（4 箇所）/ `public-guard-degraded-source.test.ts`（5 箇所） | `limiters: { source }` に `formSession` を追加、`baseOptions` に `formSessionKey: formSessionAxisKey` を追加 | **P3b-1 の構築時 throw** により `limiters.source` 単独の構成が違法になったため。各ファイルの `request()` は `__Host-fs` を送らないので `formSessionAxisKey` は常に `null` を返し、**発信元軸の振る舞いは変わらない** |
| `tests/unit/env-p3a-fail-fast.test.ts` / `env.test.ts` | 本番必須キーの土台に `TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` を追加 | P3-b で本番 fail-fast へ昇格したため（P3-a 側のコメントが「P3-b で昇格させる」と明記していた）。**アサーションは1つも変えていない**（「Turnstile / Blob は P3-a では必須にしない」の assertion は Blob について引き続き成立する） |

---

## 3. 実装したモジュール

### 3.1 新規

| モジュール | 主な内容 | 設計上の判断 |
|-----------|---------|-------------|
| `lib/age-eligibility.ts` | `ageEligibilityBoundaryDate` / `isAgeEligible` | `new Date(birthDate)` を使わず**純粋な暦計算**にした（環境 TZ・桁溢れで受理範囲が実装依存になるため）。丸めは **1 回だけ**（T-Q2）。判定不能は必ず `false`（fail-closed） |
| `lib/validators/application.ts` | `parseApplicationInput` / `INQUIRY_FORBIDDEN_FIELDS` / `isHoneypotFilled` | **zod を使わない**。zod の `issues` は `received` / `message` に入力値を含むため、AC-PII-2 の担保が「全部潰したか」に依存する。値を持てない結果型を最初から返す手書きにした。文字数は**コードポイント**で数える |
| `lib/receipt-number.ts` | ULID 発番 | **monotonic モードを実装しない**——同一ミリ秒の発番列が必ず昇順になり、件数推測ができる性質が戻るため |
| `lib/application-idempotency.ts` | `deriveSessionIdHash` / `sessionIdMatches` | Cookie 署名とは **HKDF ラベルを分離**。`timingSafeEqual` の前にバイト長で弾く（SEC-042 と同型の 500 を作らない） |
| `lib/spam-signals.ts` | `isSubmissionIntervalSatisfied` | 引数が**サーバー由来の 2 値だけ**。Request もボディも受け取らないので、クライアント値を渡す経路が構造的に無い |
| `lib/turnstile.ts` | `verifyTurnstile` | 失敗・障害・タイムアウトはすべて `false`。空 / 非文字列 / 過大トークンは **`fetch` を呼ばずに** false（外部 API の踏み台化を防ぐ）。secret は POST ボディ |
| `lib/pii-log.ts` | `PII_DENY_KEYS` / `createPiiSafeLogger` / `toErrorLogFields` | **再帰的に**落とす。`Error` を値に持つフィールドも `{ errorCode }` へ潰す（`{ error }` は最も自然な書き方であり、規律では守れない） |
| `lib/mail/auto-reply.ts` | 文面・宛先スロットル | **件名に氏名を入れない**（ヘッダインジェクションの多層防御）。`peek` で判定し**成功時のみ `consume`**（T-Q4: 失敗が枠を食うと「抑止」でなく「遮断」になる） |
| `lib/apply-draft.ts` | `toDraftSnapshot` ほか | 写真関連値を**キー名と値の形の両方**で落とす（別名で持たれても捕まえる） |
| `lib/retention.ts` | `RETENTION_PERIODS` | `/privacy` と P3-c / P3-d のバッチが**同じ値**を見るための単一定義 |
| `lib/form-session-issue.ts` | `issueFormSession` | 縮退時は**計数のみで発行を止めない**（第三者が 30 回開くだけで全利用者が `/apply` を開けなくなるのを防ぐ） |
| `lib/runtime-stores.ts` | `sharedRateLimitStore` / `sharedSemaphoreStore` | **P3b-2 / SEC-044 の是正**。注入経路を 1 つにして「注入し忘れた limiter だけが黙ってインメモリのまま」を構造的に潰す |
| `app/api/applications/route.ts` | `POST`（F-010 全体） | ラッパが Origin / CT / ボディ上限 / Tier D / Tier B(Cookie) / Tier C を持ち、ハンドラは業務上の Tier B（ハニーポット・送信間隔・Turnstile）と受付だけを持つ |
| `app/api/form-session/route.ts` | `GET`（Cookie 発行） | §4 参照 |
| `app/(public)/apply/page.tsx` + `components/apply/*` | ステップ式フォーム | §4 参照 |
| `app/(public)/privacy/page.tsx` | F-023 | 保持期間を `lib/retention.ts` から描画 |
| `scripts/verify-p3b.ts` | 自己検証 | §5 参照 |

### 3.2 既存モジュールの変更

| モジュール | 変更 |
|-----------|------|
| `lib/form-session.ts` | `PerRequesterKey`（branded）/ `FORM_SESSION_SIGNATURE_LENGTH` / `FORM_SESSION_VALUE_MAX_LENGTH` / `newFormSessionPayload`（sid = 32 桁**小文字 hex** / SEC-056）/ `readFormSessionCookie`（**同名 Cookie は最初を採る**）/ `formSessionAxisKeyFromValue` / `formSessionAxisKey` |
| `lib/public-guard.ts` | `MAX_PUBLIC_REQUEST_BODY_BYTES` / `maxBodyBytes` / `formSessionKey` の型を `PerRequesterKey \| null` へ / **構築時 throw** / 413（`challenge` 無し）/ ボディ計測後に**読み直せる Request** を handler へ渡す |
| `lib/env.ts` | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番 32 文字下限、Turnstile 2 キーの本番必須化、`FORM_SESSION_SECRET !== CRON_SECRET` / `CRON_SECRET !== AUTH_SECRET`、**Vercel 上での `KV_REST_API_URL` の https 強制** |
| `lib/mail.ts` | プレースホルダを実装（Resend の REST を `fetch` で叩く。SDK を足さない） |
| `lib/semaphore.ts` | `createMemorySemaphoreStore`（**KV 未設定の非本番専用**。KV 版と同じ意味論） |
| `auth.ts` | 4 つの limiter に `sharedRateLimitStore()` を注入（P3b-2 / SEC-044） |
| `.env` / `.env.example` | §4.3 参照 |

### 3.3 `withPublicMutation` の評価順序（実装した順序と、契約からの差分）

```
1. Origin 検証（403・challenge なし）
2. Content-Type 検証（415）
3. content-length による事前ボディ上限判定（413）
4. Tier D: 発信元軸 / フォームセッション軸（429）
4'. 縮退かつ別軸未配線なら Tier B
5. 実バイト数によるボディ上限強制（413）     ← 契約文書（§5.3）の「7」より前
6. Tier B: verifyFormSession（403 + challenge）
7. Tier C: セマフォ（202）
8. 本体
```

> **差分の理由**: `docs/review-p3b-tests-2026-07-29.md` §5.3 は実バイト数の強制を「Tier C の後（7）」と
> 書いているが、**`public-guard-p3b-wiring.test.ts` の 2 本がそれを許さない**——
> 「content-length が無くても実バイト数で上限を強制する」「過少申告でも実バイト数で落とす」は
> どちらも **Cookie を持たない `streamingRequest`** を使っており、Tier B の後に置くと
> `verifyFormSession` が先に false を返して **413 ではなく 403** になる。
> **テストを契約の正とし、実装をそちらへ合わせた。** この位置のほうが性質としても良い:
> (a) 413 は Tier ではない失敗なので `challenge` に埋もれない、(b) 上限超過のボディが
> セマフォのパーミットを占有しない。**文書（§5.3）側の更新を Senior へ申し送る。**

---

## 4. 設計判断（テスト設計 §7 が Impl に委ねた点）

### 4.1 AC-RL-13 の配線先 — なぜ Route Handler + リダイレクトなのか

**AC-RL-13(a) は「`GET /apply` のレスポンスで Cookie を発行する」と定めるが、Next.js の
Server Component は Cookie を設定できない。** 実測（Next 15.5.22 / `app/(public)` 配下の
Server Component から `cookies().set()`）:

```
Cookies can only be modified in a Server Action or Route Handler.
```

| 案 | 判断 |
|----|------|
| middleware（Edge）で発行 | **却下**。`lib/form-session.ts` は `node:crypto`（HKDF / HMAC / `timingSafeEqual`）依存で Edge では動かない。Web Crypto で書き直すと**署名の実装が 2 つ**になり、発行側と検証側がずれた瞬間に**全利用者が Tier B に落ちる**（`form-session-axis.test.ts` の「発行と検証の整合」が守ろうとしている事故そのもの） |
| Node.js middleware（`experimental.nodeMiddleware`）| **却下**。実際に試したところ Next 15.5.22 は `Unrecognized key(s) in object: 'nodeMiddleware' at "experimental"` を出しつつ有効化するという不安定な状態だった。公開・管理の**全リクエストが通る層**をこの単位で実験機能へ載せ替えるのは割に合わない |
| **Route Handler + リダイレクト（採用）** | 安定 API のみ。`lib/form-session.ts` をそのまま使うので**実装は 1 つのまま**。`issueFormSession` をそのまま呼ぶので **AC-RL-13(c)（発行の流量制限）も判定ロジックを複製せずに満たせる**（AC-RL-8） |

**動作（実測）**:
```
GET /apply            → 307 Location: /api/form-session
GET /api/form-session → 303 Location: /apply?fs=1
                         set-cookie: __Host-fs=…; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=lax
GET /apply?fs=1       → 200（CSP ヘッダ付き）
```

**リダイレクトループを作らない**: Cookie をブロックしている環境では発行しても Cookie は付かない。
`?fs=1` を付けて戻すことで `/apply` 側が「発行は試みた」と判別し、2 度目のリダイレクトを行わない。
その利用者はフォームを開けるが**送信は必ず Tier B になる**——`form-submission.md` §3.5 が
定めた縮退経路だが、**CAPTCHA 1 タップでは抜けられない**（Cookie が無い限り
`verifyFormSession` が false のまま）。§8 に残余として明記する。

### 4.2 KV store の注入と、ローカルでの逃げ道

P3-a の `.env` は `KV_REST_API_URL="https://dev-only-kv.upstash.io"`（実在しないホスト）だった。
**P3-b で公開エンドポイントが実際に KV を叩くようになったため、このままだと
レート制限のたびに到達不能な HTTP を叩いて全リクエストが 500 になる。**

- `lib/runtime-stores.ts` の `isKvConfigured()` は **`https://` の URL だけ**を「設定済み」と見なす。
- `.env` は `KV_REST_API_URL="memory://local-dev-only"` に変更した（＝「インメモリで動かす」の明示的な宣言）。
- **この抜け道が本物の本番へ漏れないよう、`lib/env.ts` が `VERCEL === '1'` のとき
  `https://` 以外の `KV_REST_API_URL` を起動時に拒否する。** 判別に `VERCEL` を使うのは、
  `resolveClientIp` の `trustProxy` と同じ「実際にプラットフォーム上か」の signal だからである。

### 4.3 `.env` / `.env.example` の更新

- `KV_REST_API_URL` を `memory://local-dev-only` へ（上記）。
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` を追加（**Cloudflare 公開のテスト用キー**。
  本番必須へ昇格したため、`next start`（`NODE_ENV=production`）で回る E2E に値が要る）。
- `RESEND_API_KEY` は**未設定でよい**（`lib/mail.ts` は未設定なら送信せず戻る）。
  本番 fail-fast には**含めない**——含めると自動返信が未設定のデプロイを起動不能にし、
  申込受付そのものを止めてしまう。

### 4.4 Turnstile を条件分岐で呼び分けない

`if (secret) { verify() }` と書くと「未設定なら CAPTCHA が丸ごと消える」経路が生まれる。
`verifyTurnstile` は秘密鍵が無ければ `false` を返す fail-closed なので、**常に呼んで結果だけを見る**。
本番での鍵の存在は `lib/env.ts` の起動時 fail-fast が保証する。

---

## 5. 自己検証（`scripts/verify-p3b.ts` / テストとは独立の実測）

外部 I/O（Cloudflare / Resend）だけを `fetch` の差し替えで止め、**アプリのロジックは本物を通した**。
実行環境は `VERCEL !== '1'`＝**縮退構成**（`trusted=false`）。

```
[PASS] V-1 縮退構成で第三者の上限到達が正規利用者を巻き込まない（SEC-043）
       — 攻撃者=201,201,201,429,429,429,429,429,429,429,429,429 / 正規利用者=201
[PASS] V-2 形式不正 Cookie 2,000 種でフォームセッション軸のバケットが増えない（SEC-055）
       — store 件数 0 → 1（増分は発信元軸の 1 件のみ）
[INFO] 残余リスク: 形式を満たす値 2,000 種からは 2000 個の軸キーが作れる
       （閉じ切るのは P3b-2 = KV の TTL ベース。SEC-055 は「完全に閉じた」と報告しない）
[PASS] V-3a ハニーポット非空は Tier B・DB 0 件（AC-010-3） — status=403 rows=0
[PASS] V-3b 送信間隔 3 秒未満は Tier B・DB 0 件（AC-RL-6） — status=403 rows=0
[PASS] V-3c 上記 2 経路でメールを 1 通も送っていない — Resend 呼び出し 4 → 4
[PASS] V-3d 2 経路の応答が完全に一致する（降格理由を区別させない / 契約ルール3）
       — {"challenge":"interactive"} / {"challenge":"interactive"}
[PASS] V-4 信頼できる発信元からの 31 回目の Cookie 発行が Tier D になる — 発行成功 30 / 31
[PASS] V-4b 縮退時は共有 unknown バケットで発行を止めない — 発行成功 40 / 40

外部 I/O: Turnstile 4 回 / Resend 4 回
すべての自己検証を満たした。
```

**V-1 が意味すること**: 監査 D-1 の実測（縮退構成で 500 回送信 → 201×500）が**再現しない**。
かつ SEC-052（共有キーによる巻き添え 429）も再現しない——攻撃者が Cookie 軸を使い切った直後に、
別 Cookie の正規利用者が 201 で通っている。

**V-2 が意味すること**: 監査 D-6 の実測（形式不正 Cookie で store 件数が maxEntries に張り付く）が
**再現しない**。増えた 1 件は発信元軸（`applications:unknown`）であり、フォームセッション軸は 0 件のまま。
**ただし「バケットを 1 個も作らせない」ではない**——`[INFO]` 行のとおり形式を満たす値からは
依然として軸キーが作れる。過大報告しないためにこの数値を残した。

---

## 6. 品質ゲートの実測値

| ゲート | コマンド | 結果 |
|--------|---------|------|
| ユニット | `pnpm test:unit` | ✅ **43 ファイル / 682 件 全パス**（red 時: 15 ファイル失敗 / 75 fail・387 pass） |
| 結合 | `pnpm test:integration` | ✅ **6 ファイル / 63 件 全パス**（既存 28 + `applications.int.ts` 35） |
| 型 | `pnpm type-check` | ✅ エラー 0 |
| Lint | `pnpm lint` | ✅ `No ESLint warnings or errors` |
| ビルド | `pnpm build` | ✅ 成功。**全 21 ルートが `ƒ (Dynamic)`**（force-dynamic 方針を維持） |
| E2E | `CI=1 pnpm test:e2e` | ⚠️ **153 passed / 2 failed / 2 skipped**（オーケストレーターの単独実行＝確定値 / §7.4）。失敗2件のうち1件は**競合由来**、1件は**WebKit のポリシー**（§7.3）で、いずれも実装の欠陥ではない。**Impl は未実行**（§7 冒頭の訂正） |

### 退行の確認
- 既存 359 unit → 682（P3-b で +323。`it.each` 展開後の実数）。**既存ファイルの失敗 0**。
- 既存 28 integration → 63。**既存 5 ファイルは全て green のまま**。
- `pnpm build` のルート一覧に `ƒ` 以外（`○` 静的）が 1 つも無いことを確認済み。

---

## 7. E2E 実測

> ### ⚠️ 実行主体と衝突についての訂正（2026-07-29 追記）
>
> **本節 7.1〜7.3 は Impl（私）が実行した実測である。** 当初の作業指示が
> 「E2E は Impl が 1 回だけ実行する」だったため、指示どおり 1 回実行し、失敗の切り分けとして
> 対象を絞った診断を 2 回行った。**その後にオーケストレーターから
> 「E2E はオーケストレーターが実行する / Impl は `pnpm build`・`next start`・`pnpm test:e2e` に
> 触れない」という調整が入った**ため、以降 Impl はこれらを一切実行していない。
>
> **オーケストレーターの E2E 失敗の直接原因は、私の `pnpm build` である**（両者で合意済み）。
> オーケストレーターの報告（`.next/BUILD_ID` が 09:32:45 に書き換わり、稼働中の `next start` が
> 配信していた `.next` が差し替わってサーバーが落ちた／失敗の実体は `NS_ERROR_CONNECTION_REFUSED`）は、
> 私が品質ゲートのために `pnpm build` を回した時間帯と整合する。
> **根本原因は「E2E の実行主体が作業途中で Impl → オーケストレーターへ切り替わり、
> その時点で Impl 側の実行が既に始まっていたこと」**である（オーケストレーターが伝達不備として自認）。
> **プロセス上の教訓として、実行主体は着手前に一意に決め、途中で変えない**（§8 I-13）。
>
> **これは 7.2 の切り分け結論を弱めるのではなく、むしろ補強する。** 7.1 で観測した
> `NS_ERROR_CONNECTION_REFUSED` 8 件も、**同じ「サーバーの `.next` が差し替わる／プロセスが競合する」
> 事象**で説明でき（未変更の P1 spec `course-comparison.spec.ts` が落ちていたこと、
> 隔離実行で全通過したことと一致する）、実装の欠陥ではないという結論は変わらない。
> ただし **7.1 の数値は「両者の E2E が競合しうる状態で採られた」**ため、
> **リリース判断に使うべきはオーケストレーターの単独実行の値である**（7.4）。
>
> **一方 webkit の `__Host-fs` 失敗（7.3）は競合とは無関係**である——エラーが接続失敗ではなく
> `expect(received).toBeTruthy() / Received: undefined` という**クリーンなアサーション失敗**であり、
> 3 回の試行すべてで、かつ隔離実行でも同一に再現したため。

### 7.1 Impl による実行（**参考値**。オーケストレーターの調整より前に実施）

実行前に `lsof -ti:3000 | xargs kill -9` / `pkill -9 -f ms-playwright` / `pkill -9 -f next-server` を実行し、
dev DB の稼働（`driving_school_pg Up`）を確認した。
**ただし上記のとおり、オーケストレーター側の作業と競合しうる状態で採った値である。**

```
143 passed / 9 failed / 3 flaky / 2 skipped （157 tests, 3.4m）
```

| 分類 | 件数 | 内訳 |
|------|------|------|
| 失敗 | 9 | [webkit] `apply-form` の Cookie 発行 1 件 / [firefox] `course-comparison` 5 件・`apply-form` 3 件 |
| flaky | 3 | [chromium] `admin-authz` 1 件（**P3-a で既知の症状**）/ [firefox] 2 件 |

### 7.2 切り分け（**ゲート再実行ではなく、対象を絞った診断**）

失敗 9 件のうち 8 件は `NS_ERROR_CONNECTION_REFUSED` / `Could not connect to the server` で、
**`course-comparison.spec.ts` は P1 の未変更コード**（同じ spec を chromium / webkit は通過）だった。
`docs/phase-status.md` の E2E 運用知見にある「高負荷時の不安定要因」と同じ症状なので、対象を絞って再実行した。

```
CI=1 pnpm exec playwright test --project=firefox tests/e2e/playwright/course-comparison.spec.ts
  → 6 passed (8.5s)                      ← 5 件の失敗はすべて再現しない

CI=1 pnpm exec playwright test --project=firefox --project=webkit tests/e2e/playwright/apply-form.spec.ts
  → 34 passed / 2 failed (46.3s)
     ・[firefox] 18/18 すべて通過        ← 3 件の失敗は再現しない
     ・[webkit] `__Host-fs` Cookie       ← **再現する**（3 回とも）
     ・[webkit] `/privacy` 200           ← `Could not connect to the server`（ゲート実行では通過）
```

**結論**: **再現する失敗は 1 件のみ**（webkit の `__Host-fs` Cookie）。残り 8 件と flaky 3 件は
サーバー到達性に起因する環境要因であり、実装の欠陥ではない。

### 7.3 唯一の再現する失敗 — `[webkit] GET /apply が __Host-fs Cookie を Set-Cookie する`

```
Error: __Host-fs が発行されていない（AC-RL-13(a)）
expect(received).toBeTruthy() / Received: undefined
```

**原因は実装ではなくブラウザのポリシーである。** 根拠:

1. **サーバーは正しく送っている**（`pnpm start` に対する curl の実測）:
   ```
   GET /api/form-session → 303 Location: /apply?fs=1
     set-cookie: __Host-fs=…; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=lax
   ```
2. **chromium / firefox は同じテストを通過する**（firefox は隔離実行で 18/18）。
3. **webkit だけが 3 回とも落ちる**（retry1 / retry2 を含む）。
4. **オーケストレーターの単独実行（他プロセスなし）でも同一に再現した**（§7.4）。
   フル実行 3/3 に加え、`{top-page,apply-form}.spec.ts --project=webkit` の隔離実行でも再現。
   **これにより「競合由来ではない」ことが独立に確定した。**

`__Host-` 接頭辞は `Secure` を必須とする（`lib/form-session.ts` / P3-a の契約であり、
サブドメインからの Cookie tossing で軸を無効化されないための要件）。
**Chrome / Firefox は `http://localhost` を安全なオリジンとして扱い `Secure` Cookie を受理するが、
WebKit は受理しない。** E2E が `http://localhost:3000` で走る限り webkit では発行できない。

**本番（https）では発生しない。** 取りうる対応は次のとおりで、**いずれも本単位で実施していない**:

| 案 | 評価 | 状態 |
|----|------|------|
| `__Host-` を外す | P3-a の契約（`form-session-issue.test.ts` が `startsWith('__Host-')` を固定）と Cookie tossing 耐性を失う | ❌ **不採用が確定**（オーケストレーター判断） |
| E2E を https で回す | 妥当だが `playwright.config.ts` / `webServer` の構成変更を伴い、P3-b の範囲を超える | ⏳ **Senior に係属** |
| `apply-form.spec.ts` の Cookie テストを chromium 単一にする | `admin-*` を chromium 単一にした既存の判断と同型 | ⏳ **Senior に係属** |

**Senior / Security へ**: この 1 件を「実装の未達」と読むか「E2E 環境の制約」と読むかは
レビューの判断を仰ぐ。**Impl としては「本番相当（https）での動作は未検証」と報告する**（§8 I-1）。
**Security には別途「セキュリティ観点で `__Host-` を維持すべきか」が諮られている。**
**Impl は先回りしてコードもテストも変更していない**（§7.4.2）。

---

### 7.4 オーケストレーターによる単独実行（**リリース判断に使う確定値**）

> **Impl は実行していない**（オーケストレーターからの共有値を転記）。
> 実行条件: `lsof -ti:3000 | xargs kill -9` + `pkill -9 -f ms-playwright` + `pkill -9 -f next-server` 後、
> dev DB 稼働確認済み、**他プロセスなし**。7.1 の値は両者の作業が競合しうる状態で採られたため、
> **品質ゲートとしての正は本節の値**である。

```
CI=1 pnpm test:e2e
  153 passed / 2 failed / 2 skipped   (2.1m)   EXIT=1
```

| # | 失敗 | 単独 webkit 実行 | 判定 |
|---|------|----------------|------|
| 1 | `[webkit] apply-form.spec.ts:77 › GET /apply が __Host-fs Cookie を Set-Cookie する` | **同一に再現** | **実装ではなくブラウザポリシー**（§7.3 の分析が**確定**） |
| 2 | `[webkit] top-page.spec.ts:27 › 料金プレビューに通学/合宿タブとコースカードがある` | **通過** | **競合／負荷由来**。実装の問題ではない（P1 の未変更コード） |

失敗 1 はフル実行で 3/3（retry 2 回を含む）失敗し、`top-page` と `apply-form` を webkit 単独で
隔離実行しても同一に再現した。エラーは接続失敗ではなく**クリーンなアサーション失敗**である:

```
Error: __Host-fs が発行されていない（AC-RL-13(a)）
expect(received).toBeTruthy()   > 83 | expect(formSession, ...).toBeTruthy()
```

### 7.4.1 7.1 の 8 件が競合由来だったことの独立裏付け

**オーケストレーターの単独実行では firefox が全通過し、`NS_ERROR_CONNECTION_REFUSED` は 0 件だった。**
7.1 で観測した 8 件の接続拒否（うち 5 件は P1 の未変更コード `course-comparison.spec.ts`）が
**両者の E2E / `pnpm build` の競合由来**であったことが、これで独立に裏付けられた
（`.next/BUILD_ID` が実行中の 09:32:45 に書き換わった観測とも整合する）。
**7.1 の失敗件数をリリース判断に使ってはならない。**

### 7.4.2 対応方針（**Impl は先回りして直さない**）

- **`__Host-` を外す案は採らない**（Cookie tossing 耐性を落とすため。オーケストレーター判断）。
- 残る「**E2E を https 化**」「**当該テストを chromium 単一にする**」の選択は
  **テスト構成の変更**であり、**Senior の判定事項**である。
- **Security には「セキュリティ観点で `__Host-` を維持すべきか」が別途諮られている。**
- Impl は本件について**コードもテストも変更していない**（先回り修正の禁止指示に従う）。

---

## 7.5 P3b-1〜11 の充足状況

| # | 要件 | 状態 | 根拠（実測） |
|---|------|------|------------|
| **P3b-1** | `/api/applications` で `limiters.formSession` と `formSessionKey` を必ず渡す | ✅ | `withPublicMutation` の**構築時 throw**（`limiters.source` があるのに別軸が無い構成）+ ルートのソース走査（`applications-route-contract.test.ts` 8 件）+ **V-1 の実測**（縮退構成で 4 回目が 429） |
| **P3b-1b** | `formSessionKey` は要求元ごとに一意。`enforce:true` をリテラルで書けない | ✅ | `PerRequesterKey`（branded type）により**リテラルを代入できない**（`form-session-axis.test.ts` の `@ts-expect-error` が `pnpm type-check` で有効化されている＝ 未使用ディレクティブ警告が消えている）+ ルートに `as` キャストが無いことのソース検査 + **V-1 の実測**（別 Cookie の利用者が巻き添えにならない） |
| **P3b-2** | `auth.ts` と公開エンドポイントの limiter に KV store を注入。`.env.example` / `lib/env.ts` の文言と実態を一致 | ⚠️ **注入は完了・実 KV は未実測** | `lib/runtime-stores.ts` を新設し、`auth.ts` の 4 limiter / `/api/applications` の 3 limiter / `/api/form-session` の limiter / セマフォがすべてここを通る。`.env.example` と `lib/env.ts` は §4.2・§4.3 のとおり実態と一致させた。**ただしローカル / E2E は `memory://` でインメモリに落ちるため、実 KV に対する経路は測っていない（§8 I-5）** |
| **P3b-3** | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限 32 文字 | ✅ | `env-p3b-fail-fast.test.ts`（31/32 の境界 + 相互同一値の禁止）全パス |
| **P3b-4** | `now` にリクエスト由来の値を渡さない / `newPermitId` に決定的値を渡さない | ✅ | `public-guard-p3b-wiring.test.ts`（`Date` / `x-client-now` / body の `clientNow` を偽装しても期限判定が変わらない）+ ルートのソース走査。ルートは `newPermitId` を渡していない（既定の 128bit 乱数） |
| **P3b-5** | CSP の検証対象を `/apply` へ。`csp.spec.ts` だけを根拠にしない | ✅ | `apply-page-contract.test.ts`（ポリシーの中身 + middleware matcher を E2E とは独立に固定）+ `apply-form.spec.ts` の実応答 + **curl の実測**（`/apply` / `/privacy` の両方に CSP ヘッダ、`script-src` に `'unsafe-inline'` なし） |
| **P3b-6** | `app/layout.tsx` の `force-dynamic` に構造的な歯止め | ✅ | `apply-page-contract.test.ts`（ルートレイアウトの export + `app/` 配下に `force-static` が無いこと）+ **`pnpm build` の全 21 ルートが `ƒ (Dynamic)`** |
| **P3b-7** | ルート列挙テストに再 export 検出 / `route.js` 走査 / エイリアス import の厳格化 | ✅ | `api-route-guard-coverage-p3b.test.ts` 14 件全パス。**P3-b で実対象（`/api/applications`）が初めて網に入った**（`listRouteFiles` が当該ファイルを含むことを固定） |
| **P3b-8** | 公開エンドポイントにリクエストボディのサイズ上限 | ✅ | `MAX_PUBLIC_REQUEST_BODY_BYTES = 65536`。宣言値（413・レート制限より前）と実バイト数（413・レート制限より後）の 2 段。**本番経路でも 200KB のボディが 413 で DB に到達しない**ことを結合テストが実測 |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` を変更したら実 Redis で再実測 | ✅ **対象外**（変更していない） | Lua は 1 文字も変えていない（`semaphore.test.ts` がスクリプト構造を固定しており、変えていれば落ちる）。**ただし非本番用に `createMemorySemaphoreStore` を新設した**——§8 I-6 参照 |
| **P3b-10** | `withCronAuth` に粗い試行回数制限 | ⏸ **未実装（期限は P3-c）** | `cron-auth.test.ts` は退行していない |
| **P3b-11** | `formSessionKey` の段階で Cookie の形式検証 | ✅（**残余あり**） | `formSessionAxisKeyFromValue` が `<base64url>.<base64url 43 文字>` と最大長 512 を検証。形式不正 14 種 × 2 のユニット + **V-2 の実測（形式不正 2,000 種で store 件数 0 → 1）**。**「バケットを 1 個も作らせない」ではない**——形式を満たす値 2,000 種からは 2,000 個の軸キーが作れる（V-2 の `[INFO]`）。閉じ切るのは P3b-2 |

---

## 8. 報告できないこと・検証できていないこと

**P3-a の §8 と同じ姿勢で、確認していないことを「達成」と書かない。**

| # | 項目 | 状態 |
|---|------|------|
| I-1 | **`__Host-` Cookie が WebKit で受理されない（`http://localhost`）** | **オーケストレーターの単独実行で確定した唯一の実装起因でない再現失敗**（§7.3 / §7.4）。両者が独立に、フル実行 3/3 と webkit 隔離実行の両方で同一に再現した（接続エラーではなくクリーンなアサーション失敗）。サーバーの `Set-Cookie` は正しく、chromium / firefox は通過する。**本番（https）での動作は依然として未検証**——E2E が http で回るため確かめる手段が無い。**判定は Senior（3案の選択）と Security（`__Host-` 維持の可否）に係属中。Impl は先回りして直していない**（§7.4.2） |
| I-13 | **Impl の E2E 実測値（§7.1）がオーケストレーターの作業と競合した状態で採られた** | **運用の失敗**。品質ゲートのための `pnpm build` が、稼働中の `next start` の `.next` を差し替えてオーケストレーターの E2E を落とした（§7 冒頭の訂正）。**リリース判断には §7.4 の単独実行値を使うこと。** 以降 Impl は `.next` / ポート 3000 に触れるコマンドを実行していない。**根本原因は「E2E の実行主体が作業途中で Impl → オーケストレーターへ切り替わり、その時点で Impl 側の実行が既に始まっていたこと」**であり、次単位（P3-c）では**実行主体を着手前に一意に決めて途中で変えない**ことを推奨する |
| I-2 | **Cookie をブロックしている利用者が Tier B から回復できない** | **閉じていない残余**。`verifyFormSession` は Cookie が無い限り false を返すため、CAPTCHA を解いても送信は成立しない。`form-submission.md` §3.5 は「Cookie の話を利用者に説明しない」としているが、**回復手段が電話・LINE の代替導線だけ**になる。仕様どおりではあるが、UX 上の穴として Senior / Spec に判断を仰ぐ |
| I-3 | **Turnstile の実ウィジェット動作** | **未検証**。E2E はフォーム送信を行わないため、実際に CAPTCHA トークンが取得され `verifyTurnstile` が通る経路を通していない。`.env` は Cloudflare のテスト用キー（常に成功）を指しているが、**実キーでの疎通は本番デプロイ時に確認が必要** |
| I-4 | **自動返信メールの実送信** | **未検証**。`RESEND_API_KEY` 未設定のため `sendMail` は送信せずに戻る。`scripts/verify-p3b.ts` はダミーキーを入れて `fetch` の呼び出し回数までを観測しており、**Resend API が実際に受理するか（差出人ドメインの検証等）は測っていない** |
| I-5 | **KV（Upstash）を実際に叩く経路** | **未検証**。ローカル / E2E は `memory://` でインメモリに落ちる。`createKvRateLimitStore` / `createKvSemaphoreStore` 自体は P3-a のユニットテストが担保しているが、**P3-b の配線（`sharedRateLimitStore` 経由）が実 KV で動くこと**は測っていない。**Security 監査で実 Redis を立てて再測することを推奨する**（P3-a で実績のある手法） |
| I-6 | **P3b-9（`SEMAPHORE_ACQUIRE_LUA` の再実測）** | **`SEMAPHORE_ACQUIRE_LUA` を変更していない**ため対象外。`createMemorySemaphoreStore` を**新設**したが、これは非本番専用で Lua とは別実装である。**「KV 版と同じ意味論」は目視とユニットテスト由来の設計でしか担保していない**（メモリ版に対する契約テストは無い）——後続で `semaphore-contract.ts` のフェイク契約に載せることを推奨 |
| I-7 | **P3b-10（`withCronAuth` の試行回数制限）** | **未実装**。期限は P3-c であり本単位の対象外（`cron-auth.test.ts` は退行していない） |
| I-8 | **AC-RL-9 の閾値再測** | **未実施**。写真フロー込みの再測は P3-c の担当（SPEC-009） |
| I-9 | **`components/apply/` の分解が設計書どおりでない** | `application-form.md` §6.4 は `steps/` 配下に 6 ファイル + `RadioCardGroup` / `ImportantNoticeBlock` / `FormField` の新規 UI コンポーネントを求めているが、**実装は `ApplicationForm.tsx` + `FormStepper.tsx` の 2 ファイル**に集約した。振る舞い（AC-008-2/3/5/6/7）は満たしているが、**再利用可能な UI コンポーネントの切り出しは行っていない**。Designer / Senior の判断を仰ぐ |
| I-10 | **確認画面の「修正」リンク / `returnToReview`** | **未実装**。`application-form.md` §2.7 の「ステップ単位の修正リンクで戻り、次へで確認画面へ直帰」は入っていない（戻るボタンで 1 ステップずつ戻る）。E2E の要求範囲外だが仕様との差分として記録する |
| I-11 | **Tier C / Tier D の自動再試行** | **未実装**。待機 UI（`wait-panel`）は表示するが、`form-submission.md` §4.4 の「`Retry-After` 経過で自動再送（最大 3 回）」は入れていない。**利用者は手動で再送する必要がある**。E2E の対象外だが F-010 の UX 契約としては未達 |
| I-12 | **`lib/mail.ts` と `lib/mail/` の共存** | `@/lib/mail` はファイル（`lib/mail.ts`）に解決される。TypeScript / webpack の双方でファイル優先のため意図どおり動く（`pnpm type-check` / `pnpm build` で確認）が、**紛らわしい構成である**ことは認める（テスト設計 §5.1 / §5.2 の指定どおりに置いた） |

### 過大報告を避けるための明示

- **SEC-055 は「完全に閉じた」わけではない。** 形式検証が閉じたのは「**形式不正な値でもバケットが作れる**」
  経路だけである。形式を満たす値は攻撃者にも作れる（V-2 の `[INFO]` 行で 2,000 個と定量化した）。
  閉じ切るのは **P3b-2（KV = TTL ベースで退避の概念が無い）**であり、その配線は入れたが
  **実 KV での動作は測っていない（I-5）**。
- **P3b-2 は「注入した」までしか報告できない。** `.env.example` / `lib/env.ts` の文言と実態は
  一致させた（§4.2）が、**実 KV に対する経路は未実測**である。
