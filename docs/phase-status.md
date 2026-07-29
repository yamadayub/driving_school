# Phase 進捗ステータス

> 岩滝・網野自動車教習所 Webサイトリニューアルデモ / 最終更新: 2026-07-29

## 確定方針
- 技術: Next.js(App Router, TS) + Prisma + PostgreSQL、DBアクセスはサーバー限定（公開DBキー非保持）。
- ホスティング: **Vercel集約**（Vercel + Vercel Postgres + Vercel Blob + Vercel KV/Upstash + Resend + Auth.js）。
- ChatBot: ルールベース（公開Faqを単一ナレッジ源にサーバー照合）。
- 開発フロー: CLAUDE.md の Multi-Agent TDD 9フェーズ。dev DBは `scripts/dev-db.sh up`（Docker postgres:16, :5433）。

## Phase 一覧

| Phase | 内容 | 状態 |
|-------|------|------|
| P0 | 基盤整備（仕様/DESIGN/技術選定） | ✅ 完了（Senior差分再レビューApprove） |
| P1 | 公開サイト骨格 | ✅ 完了（下記ゲート通過） |
| P2 | お知らせCMS（管理画面 + News CRUD + 認証） | ✅ **完了**（差し戻し1回 → 再検収 Approve / Critical0・High0） |
| P2.5 | レート制限基盤ハードニング（P3 前提） | ✅ **完了**（差し戻し1回 → 再検収 Approve / Critical0・High0 / **P3着手可**） |
| P3 | 入所申込・問い合わせフォーム | 🚧 進行中（**P3-a ✅ 完了** / P3-b 着手可。spec v0.3.3。設計レビュー3回 → Approve） |
| ├ P3-a | レート制限基盤の本番化 + 公開変更系ラッパ + CSP | ✅ **完了**（差し戻し1回 → 再検収 **Senior Approve / Security Critical0・High0**） |
| ├ P3-b | F-008 ステップ式フォーム + F-010 送信・スパム対策・自動返信 | ✅ **完了**（差し戻し1回 → 再検収 **Senior Approve / Security SEC-057 クローズ・新規 Critical0・High0**） |
| ├ P3-c | F-009 免許証写真アップロード + orphan 回収 | 🚧 進行中（**P3-c1 ✅ 完了** / P3-c2 着手可） |
| │ ├ P3-c1 | 前提ハードニング（監査が「公開エンドポイントを作る前に塞げ」と指定した項目群） | ✅ **完了**（差し戻し: テスト設計2回 + コード1回 → **Senior Approve / Security 新規 Critical0・High0**） |
| │ └ P3-c2 | F-009 本体（署名付きURL・マジックバイト検証・orphan 回収・UI）+ SEC-067 の回復経路結線 | 🚧 **着手可** |
| └ P3-d | F-017 受信管理 + F-018 署名付きURL閲覧 + 保持期間バッチ | 未 |
| P4 | AI ChatBot（ルールベース） | 未 |
| P5 | SEO対応 + 総合仕上げ | 未 |

## P0 成果物
- docs/product-concept.md / current-site-analysis.md / business-spec.md(v0.2.1) / functional-spec.md(v0.2.1) / tech-stack.md(v0.2.0) / DESIGN.md
- docs/review-p0-spec-2026-07-19.md（Approve）

## P1 成果物と品質ゲート（全通過）
- 実装: app/（page/courses/courses[id]/programs/programs[id]/schools）、components/（ui・layout・courses・top）、lib/（format/course-view/course-filter/badge/labels/course-dto/nav/queries/school-info/db/env）
- UI設計: docs/ui-design/（layout/top-page/course-comparison/course-detail/school-access）
- テスト: unit41 / integration15 / e2e54(×3ブラウザ) / build（**DB停止でも成功**=force-dynamic採用）
- レビュー: docs/review-p1-test-2026-07-27.md（Approve）/ docs/review-p1-code-2026-07-27.md（Approve, MustFix0）
- セキュリティ: docs/security-audit.md（Critical0/High0）
- Should Fix対応済: REV-101(?school復元) / REV-102(build DB非依存) / REV-103(server-only)

## P2 成果物と品質ゲート（全通過 = P2 完了）

### 成果物
- 実装: `app/admin/**`（login / dashboard / news CRUD）、`app/api/admin/news/**`（4ハンドラ）、`app/api/auth/[...nextauth]`、`auth.ts` / `auth.config.ts` / `middleware.ts`、`components/admin/**`
- lib: `news-admin.ts` / `news-visibility.ts` / `password.ts` / `rate-limit.ts` / `http-guard.ts` / `seed-guard.ts` / `env.ts` / `validators/news.ts` / `markdown/renderSafe.ts` / `publish-status.ts`
- レビュー: `docs/review-p2-test-2026-07-27.md`(Approve) / `docs/review-p2-code-2026-07-28.md`(**Request Changes**) / `docs/review-p2-code-re-2026-07-28.md`(**Approve**)
- セキュリティ: `docs/security-audit.md` Phase 2 監査(High 1) → Phase 2 再監査(**Critical 0 / High 0 = リリース可能**)
- 修正記録: `docs/p2-fix-plan-2026-07-28.md` / `docs/review-p2-fix-tests-2026-07-28.md` / `docs/impl-p2fix-notes-2026-07-28.md`

### 品質ゲート実測（2026-07-28、修正後）

| ゲート | 結果 |
|--------|------|
| `pnpm type-check` | ✅ エラー0 |
| `pnpm lint` | ✅ warning/error 0 |
| `pnpm test:unit` | ✅ 13ファイル / **118件** 全パス（修正前72 → +46） |
| `pnpm test:integration` | ✅ 5ファイル / **28件** 全パス（修正前23 → +5, dev DB :5433） |
| `pnpm build` | ✅ 成功（DB非依存・force-dynamic 維持） |
| `CI=1 pnpm test:e2e` | ✅ **73件 全パス（59.5s, prebuilt/workers:1/retries:2）**（修正前67 → +6） |
| Senior Review | ✅ Approve（再検収。前回 Must Fix 2件クローズ、新規 Must Fix 0） |
| Security Audit | ✅ Critical 0 / High 0 |

### P2 で発生した差し戻し（記録）
Phase 7 で **Request Changes + High 1** となり Phase 6 に差し戻し。修正内容:

| ID | 内容 | 対応 |
|----|------|------|
| RV-P2-001 / SEC-010 | 公開トップ `getLatestNews` に `publishedAt <= now()` の時刻ゲートが無く予約公開が即時露出（F-004違反）。**結合テストは本番未使用の `listPublishedNews` を検証しており、テスト対象を取り違えていた** | `lib/news-visibility.ts` に述語の単一真実源を新設し、公開/管理の両経路が参照。テストを本番経路 `getLatestNews` に付け直し |
| RV-P2-002 / SEC-013 | 本番 `AUTH_SECRET` の起動時強度検証が未実装 | `lib/env.ts` に production 限定 32文字下限の `superRefine`。`auth.ts` モジュールトップで発火 |
| SEC-009 (High) | ログイン試行回数制御なし + 同期 scrypt の CPU DoS 増幅 | `lib/rate-limit.ts`（汎用基盤）+ `auth.ts` 2軸制限、`lib/password.ts` を `promisify(scrypt)` 化（`timingSafeEqual` 等は退行なし） |
| SEC-011 / RV-P2-005 | 変更系フォームに CSRF 対策なし | `lib/http-guard.ts` で Origin 検証、save/delete に適用 |
| SEC-012 | seed のハードコードパスワード + 本番ガードなし | `lib/seed-guard.ts` で fail-fast |

**教訓（P3以降に適用）**: 「テストが green でも本番経路が守られていない」型の不具合が実際に発生した。テストを書く際は**公開ページ／APIが実際に呼ぶ関数**を対象にすること。

---

## P2.5 ハードニング（P3 着手前に必須）

P2 の是正が新たな Medium を持ち込んだため、**レート制限基盤を P3 の未認証エンドポイント（申込 / 画像アップロード / チャット）へ横展開する前に**以下を塞ぐ。欠陥ごと複製されるのを防ぐのが目的。

| ID | 深刻度 | 内容 |
|----|--------|------|
| SEC-021 / RV-P2R-001 | Medium | **アカウント軸ロックアウトで未認証の第三者が管理者ログインを恒久封鎖できる**（IP軸10回/10分 > アカウント軸5回/15分のため単一IPで成立）。照合前の一律拒否ではなく「失敗のみ計数し成功は常に通す」形へ。※前回監査の修正方針自体の設計欠陥 |
| SEC-022 / RV-P2R-003 | Medium | IPキーが偽装可能な `x-forwarded-for` **先頭値**由来。制御自体が偽装で無効化できる。**P3では致命的** |
| SEC-023 / RV-P2R-002 | Medium | インメモリ store に期限切れ掃除も件数上限もなく、攻撃者制御キーで無限増殖 |
| SEC-024 | Medium | Origin 検証が JSON 管理API 3ハンドラに未適用。**手動適用をやめ「変更系は必ずガードを通る」共通ラッパ構造にする** |
| RV-P2R-005 | Should Fix | CI `e2e-test` ジョブの `pnpm build` に `AUTH_SECRET` 等が未指定で失敗する（`.github/workflows/ci.yml`） |

### P2.5 完了時の品質ゲート実測（2026-07-29）

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` | ✅ 15ファイル / **179件** 全パス（P2完了時118 → +61） |
| `pnpm test:integration` | ✅ 28件 全パス |
| `pnpm type-check` / `pnpm lint` | ✅ エラー0 / warning0 |
| `pnpm build` | ✅ 成功（force-dynamic 維持） |
| `CI=1 pnpm test:e2e` | ✅ **82件 全パス**（P2完了時73 → +9） |
| Senior Review | ✅ Approve（`docs/review-p25b-code-2026-07-29.md` / Must Fix 0） |
| Security Audit | ✅ Critical 0 / High 0・**P3 着手可**（`docs/security-audit.md` P2.5-b 再監査） |

### P2.5 の経緯（2回の差し戻し。記録として残す）
1. **P2.5 初回** → Request Changes。SEC-021 の脅威クラスが**閉じておらず、攻撃ベクタがアカウント軸→グローバル軸へ移動しただけ**だった（攻撃コストはむしろ低下: 5req/15分+メール既知 → 100req/分+知識不要）。**テストは全て green だった。**
2. **P2.5-b** → Approve。グローバル軸 consume を IP ゲート通過後へ移動＋予約枠を新設。`trusted=false` 時は IP 軸を計数のみに使いゲートにしない意味論へ変更。監査者自身の実測で脅威の消滅を確認。

**教訓（P3 以降に必ず適用）**
- P2: 「**テストが green でも本番経路が守られていない**」（テスト対象の取り違え）
- P2.5: 「**red だったテストが全部 green になっても、脅威が閉じていない**」（契約自体の欠陥）
- → セキュリティ是正の完了条件は「テストが green か」ではなく「**脅威シナリオが実測で再現しなくなったか**」とする。実装・監査の双方が独立に攻撃を再現して確認する。
- P2.5/P2.5-b では「**文書に事実と異なる記述が入り、それが次フェーズの設計判断の入力になる**」欠陥が2回発生した（SEC-030・SEC-038）。**受容した残余リスクは必ず実測値で定量化する。**

### 受容した残余リスク（閉じていない。SEC-029 残余）
グローバル軸は固定ウィンドウのカウンタを照合前ゲートに使うため、**独立発信元 30**（`global.limit/ip.limit + reserve.limit`）を持つ攻撃者は管理者ログインを窓ごと止められる。`trusted=false` の縮退時は **単一ホスト 121req/分**で成立する（本番 Vercel は `trusted=true` のため実害なし）。
構造的な解は「**同時実行 scrypt 数を上限とするセマフォ**」（**パーミット単位のリースとして設計し、期限切れを `acquire` が回収する場合に限り**枯渇せず、症状が拒否ではなく待ちになる。**成立条件は `docs/tech-stack.md` §4.5「セマフォの実体（確定）」に書いた条件を満たすことであり、無条件には成立しない**。RV-P3DR-008 / RV-P3DR2-007）。
> **⚠️ P4 で管理者ログインのセマフォ化を再評価する人へ**: この行を「セマフォなら枯渇しない」の根拠に使ってはならない。
> **「処理完了で自動解放されるので枯渇しない」という命題はサーバーレスでは偽である**（タイムアウト・クラッシュ・
> デプロイ中断では `release` が実行されず、漏れたパーミットが累積して恒久枯渇する）。枯渇しないのは
> `docs/tech-stack.md` §4.5 の成立条件（パーミット単位のリース + `acquire` 第1ステップでの期限切れ回収 +
> クロックスキューが TTL に対して十分小さいこと）を満たす実装だけである。

---

## P3-a 完了記録（2026-07-29）

### 成果物
`lib/semaphore.ts`（ZSET リース + Lua）/ `lib/kv.ts`（`createKvRateLimitStore`）/ `lib/public-guard.ts`（認証非依存ラッパ）/ `lib/form-session.ts` / `lib/cron-auth.ts` / `lib/csp.ts` + `middleware.ts` + `app/layout.tsx` / `lib/env.ts`（本番 fail-fast）/ `lib/rate-limit.ts`（IPv6 `/64`）/ `scripts/verify-semaphore-p3a.ts`

### 品質ゲート実測（修正後）
| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` | ✅ 28ファイル / **359件** 全パス（P2.5完了時179 → +180） |
| `pnpm test:integration` | ✅ 28件 全パス |
| `pnpm type-check` / `pnpm lint` | ✅ エラー0 / warning0 |
| `pnpm build` | ✅ 成功（全17ルート `ƒ (Dynamic)`） |
| `CI=1 pnpm test:e2e` | ✅ **101 passed / 2 skipped / 0 failed（103件）** |
| Senior Review | ✅ Approve（`docs/review-p3a-fix-code-2026-07-29.md` / Must Fix 0 / **P3-b 着手可（無条件）**） |
| Security Audit | ✅ **Critical 0 / High 0**（`docs/security-audit.md`「P3-a 再監査」/ **P3-b 着手可**） |

### P3-a の差し戻し（記録）
**ユニットテスト317件が全 green の状態で、Security 監査の実測により High 2件が再現した。**

| ID | 内容 | 対応 |
|----|------|------|
| **SEC-043 / RV-P3A-001**（High） | `withPublicMutation` が `resolveClientIp().trusted` を捨て、縮退時に共有 `unknown` バケットが 429 の硬いゲートになる。**第三者が全利用者を締め出せる**（SEC-021 → SEC-029 → SEC-030 に続く**4度目の同型**） | **型で強制**: `sourceAxisFor(endpoint, resolution: ClientIpResolution)` が `string` を受け取らない（`.key` だけだと TS2345）/ `PublicGuardOptions.clientIp` の戻り値型を固定（型が緩むこと自体を禁じる）/ Tier D 軸に `enforce: boolean` を必須化。縮退判定を1箇所に閉じる |
| **SEC-042**（High） | Cookie 署名比較が **JS 文字列長**のため、細工した Cookie で `RangeError` → 500（Tier B に落ちない） | バイト長比較 + ラッパ側の例外封じ込め。設計入力32件 + latin1全域128件 + ファズ20,000件で例外0を監査が実測 |
| SEC-047 | ルート列挙テストが識別子名の一致だけで import 元を検証せず、**no-op の同名関数を定義したルートが 11/11 green で通過** | `usesGenuineWrapper` 判定を追加。監査実測で「前回通過した形が今回は 1 failed で落ちる」ことを確認 |
| RV-P3A-003 | 文書化された品質ゲート `pnpm test:e2e`（CI無し）が `next dev` 起動で赤 | `playwright.config.ts` の webServer を `pnpm build && pnpm start` へ |

**教訓（P2・P2.5 の教訓に追加）**
- **「警告をコメントに書く」ことは、呼び出し側が読まなければ機能しない。** `lib/http-guard.ts` は「`trusted` を捨てる呼び出しはこの防御を無効化する」と**名指しで警告していた**のに、新しいラッパがまさにその書き方をした。**型で強制するか、テストで固定する以外に、この型の再発を止める手段は無い。**
- **契約が正しくても、その契約を検証する入力の選び方が脅威モデルと一致していなければ意味がない**（SEC-042。テストは「壊れた形式でも例外を投げず null」という正しい契約を書いていたが、与えた5入力がすべて ASCII だったため Buffer 長の不一致に到達しなかった）。
- **オーケストレーター側も同じ欠陥を犯した**: 作業中のエージェントを「応答停止」と断定して「§4〜§8 は書かれないまま」と記録したが、実際は作業中だった（`docs/impl-p3a-notes-2026-07-29.md` §4.1 で訂正済み）。**「応答しない」と「まだ作業中」は外から区別できない。**

### 監査方法の到達点（記録に値する）
Security 監査は **本物の Redis 7.4.10 を立て、`SEMAPHORE_ACQUIRE_LUA` を Redis の Lua VM で実行**して検証した。これにより Impl が「検証できていない」と申告した I-1（Lua 本体の意味論）/ I-3 を監査側で閉じている。
> `SemaphoreKvClient` が `eval` / `zrem` の2メソッドしか要求しない設計だったため、RESP クライアントを1つ書くだけで実現できた。**インタフェースを最小に保つことが、そのまま検証可能性になっている。**

### E2E の運用知見
- **E2E は同時実行できない**（複数エージェントの `pkill -9 -f ms-playwright` が互いの実行を潰す）。**実行は1エージェントに限定**すること。
- 失敗時は実装を疑う前に **(a) dev DB 稼働 (b) port 3000 の残留サーバー (c) 他プロセスの同時実行**を確認する。掃除は `lsof -ti:3000 | xargs kill -9` まで含める（`pkill -f 'next start'` では `next-server` が残る）。
- テストヘルパが**呼び出しごとに `new PrismaClient()` を生成**していたのが高負荷時の不安定要因だった（修正済み。29.0m → 4.9m）。

---

## P3-b の完了条件（Security 監査が課した P3b-1〜11）

| # | 要件 | 出所 |
|---|------|------|
| **P3b-1** | `/api/applications` の配線で **`limiters.formSession` と `formSessionKey` を必ず渡す**。IP 軸だけで Tier D を構成しない（渡し忘れると縮退構成で流量上限が消える） | 条件1'-3 / SEC-043 / SEC-053 |
| **P3b-1b** | **`formSessionKey` は要求元ごとに一意な値を返すこと**を型または構築時検査で強制。`enforce: true` をリテラルで書ける状態を残さない | SEC-052 |
| **P3b-2** | `auth.ts` と公開エンドポイントの limiter に **KV store を注入**。注入後 `.env.example` / `lib/env.ts` の文言と実態を一致させる | SEC-033 / SEC-044 / SEC-055 |
| **P3b-3** | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限を32文字に（**縮退時に残る唯一の Tier D 軸が Cookie 軸になったため、鍵が弱いと軸そのものが偽造で無効化される**） | SEC-046 |
| **P3b-4** | `now` にリクエスト由来の値を渡さない。`newPermitId` に決定的な値を渡さない | SEC-048 / SEC-049 |
| **P3b-5** | CSP の検証対象を `/apply` へ切り替える際、`csp.spec.ts` だけを根拠にしない | I-8 |
| **P3b-6** | `app/layout.tsx` の `force-dynamic` に構造的な歯止め | I-9 |
| **P3b-7** | ルート列挙テストに**再 export 形の検出 / `route.js` 走査 / エイリアス import の厳格化**を追加 | SEC-054 |
| **P3b-8** | 公開エンドポイントにリクエストボディのサイズ上限 | — |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` を変更したら実 Redis で再実測 | I-1 / I-2 |
| **P3b-10** | `withCronAuth` に粗い試行回数制限（P3-c までに） | SEC-046 |
| **P3b-11** | `formSessionKey` の段階で Cookie の**形式検証**（`<base64url>.<base64url>` / 最大長）。形式不正の値に新しいバケットを作らせない | SEC-055 |

### P3-b 着手時に必ず読むこと
**RV-P3AF-006**: 縮退構成では `verifyFormSession` 未配線の公開ルートが**全リクエスト 403** になる。これは欠陥ではなく意図した fail-closed 動作だが、**`/apply` の E2E を書く前に知らないと「全部 403 で落ちる」原因が分からない**。

---

## P3 の設計制約（Security 監査が課した条件。必ず満たすこと）

### 条件1' — レート制限基盤を「そのまま複製してはならない」箇所
未認証・大母数という P3 の条件下では、P2 で妥当だった前提が崩れる。

| # | 持ち込んではいけない性質 | 要求 |
|---|------------------------|------|
| 1 | 共有軸（グローバル）を照合前の硬いゲートに使う | 公開エンドポイントでは共有軸の枯渇を**拒否ではなく待ち / 段階的劣化 / CAPTCHA フォールバック**に。**セマフォ案は決着済み**（v0.3.2 / RV-P3D-001 → RV-P3DR-001。実体は `tech-stack.md` §4.5「セマフォの実体（確定）」＝**KV ZSET によるパーミット単位のリース**。応答契約は `functional-spec.md` §4.11 Tier 表） |
| 2 | `reset-on-success` と「カウント0 = 予約枠の資格」 | 正常系が頻繁に成功する経路（申込送信・チャット）へ持ち込まない（SEC-039） |
| 3 | `trusted=false` で per-source ゲートを完全に外す | 公開フォームでは **別軸を必ず併用**（Turnstile / セッションCookie / 送信間隔下限）（SEC-038 / SEC-032） |

### 条件2 — P3 のレート制限実装と同一作業単位で満たす（未達なら F-010 を完了と見なさない）
| ID | 受け入れ条件 |
|----|------------|
| SEC-033 | `lib/kv.ts` の `createKvRateLimitStore()`（`INCR`+`EXPIRE` の原子性）+ 本番での KV 未設定 fail-fast + 全エンドポイントへの注入 |
| SEC-032 | レート制限キーの IPv6 `/64` 正規化 + IP 単独軸への非依存 |
| SEC-031 | 件数上限による退避が本番経路で発生しない。「他キーを何件注入しても自分のスロットルは解除されない」「**退避で予約枠の資格が復活しない**」をテストで固定（SEC-041） |
| SEC-034 | KV 導入後、直列化がスループットの単一障害点にならない |
| SEC-037 | Origin / Content-Type 検証を**認証非依存のラッパ**へ切り出し、P3 の変更系ハンドラが全てそれを通る |
| SEC-002 | **個人情報入力フォームの公開と同時に CSP を投入**（P5 から前倒し） |

### P3 のセキュリティ要件（個人情報・免許証写真を扱うため P2 と情報資産の質が異なる）
- `objectKey` は**必ずサーバー生成**。マジックバイトで実体検証。サイズ上限をサーバー強制
- 署名付き URL は短期失効（5分目安）+ `UploadToken.consumed` による単回使用を**実際に強制**
- バケットは**非公開**。免許証写真の公開 URL を DB にもレスポンスにも載せない
- 管理側閲覧（F-018）は **IDOR に最も注意**。`auth()` に加え「その管理者が閲覧してよい対象か」を毎回サーバー判定
- **ログに PII を出さない**。エラーレスポンスに入力値をエコーバックしない
- APPI 対応: 削除要求時に DB レコードと Blob オブジェクトの**両方**を消す経路を設計に含める
- 保持期間を業務仕様として確定させる（Spec Agent に反映依頼）→ ✅ **完了**（`business-spec.md` §2.3 / v0.3.0）

### 仕様への反映状況（Spec Agent / 2026-07-29 / spec v0.3.0）

上記の設計制約は**すべて検証可能な受け入れ条件として仕様に落とし込み済み**。実装・テストはこれを参照すること。

| 反映先 | 内容 |
|--------|------|
| `functional-spec.md` **§4.11**（新設）| 公開（未認証）エンドポイントのレート制限・スパム対策共通仕様。軸の分類表（ゲートに使ってよい軸／使ってはならない軸）＋ AC-RL-1〜10。条件1' の3点と SEC-032/037/038/039 を受け入れ条件化 |
| `functional-spec.md` **§4.12**（新設）| PII 取扱い共通仕様。AC-PII-1〜9（非ログ・非エコーバック・メール記載制限・保持期間・APPI 削除経路・自動削除バッチ・orphan 回収） |
| `functional-spec.md` F-008 | AC-008-1〜7（CSP 同時投入 / INQUIRY 時の非レンダリング / ストレージへ PII 非保存 / フォームセッション Cookie / 同意リンク / エラー非エコー） |
| `functional-spec.md` F-009 | AC-009-1〜9（サーバー生成 objectKey / マジックバイト検証 / サイズのサーバー強制 / 単回使用の実強制 / 非公開バケット / 非ログ）。**SPEC-003**: 署名付きPUT URL(300秒) と uploadToken(600秒) の混同を解消 |
| `functional-spec.md` F-010 | AC-010-1〜16。うち **AC-010-10〜15 が条件2**（SEC-033/032/031+041/034/037/002）で、**未達なら F-010 を完了と見なさない**。**SPEC-004**: 「同一IPからの送信 N回/時」を多軸表へ訂正 |
| `functional-spec.md` F-017 | AC-017-1〜6 ＋ **APPI 削除 API（`DELETE`）を新設**（Blob 削除成功 → DB 削除の順序を仕様として固定） |
| `functional-spec.md` F-018 | AC-018-1〜6。**SPEC-005**: 生の `objectKey` を受け取る IDOR 構造を廃し、`/api/admin/applications/[applicationId]/photos/[photoId]/sign` へ変更 |
| `business-spec.md` **§2.3**（新設）| 個人情報の保持期間を確定（下表）。§2.2.4 に開示・訂正・削除請求の受付フロー、US-018 を新設 |
| `tech-stack.md` §4.5 / §6 | グローバル軸の**セマフォ化を公開エンドポイントについて決着**（管理者ログインは対象外で残余リスク受容を維持）。§6 の #3/#4/#8 を確定値へ更新（#2 の閾値のみ P3-a で確定） |

**確定した保持期間**: 申込 3年 / 問い合わせ 1年 / 免許証写真は対応完了後30日・受信から最長180日 / 未紐付けアップロードはトークン失効後24時間 / 削除要求は受付から14日以内。

### 設計レビュー差し戻しの反映（Spec Agent / 2026-07-29 / spec v0.3.1）

`docs/review-p3-design-2026-07-29.md`（**Request Changes** / Must Fix 10・Should Fix 13・Nice to Have 5）に対する仕様側の対応。詳細と下した決定は **`docs/spec-p3-fix-2026-07-29.md`** を参照。

| 指摘 | 反映先 | 決定の要旨 |
|------|--------|-----------|
| **RV-P3D-001**（P3-a ブロッカー）| `functional-spec.md` AC-RL-1 / **AC-RL-11 新設** / `tech-stack.md` §4.5 | セマフォ＝KV 上のリース（~~`INCR`+`EXPIRE`~~ **→ 再レビュー RV-P3DR-001 で ZSET によるパーミット単位リースへ差し替え。下表参照**）/ TTL=20秒 / `maxDuration`=10秒 / エンドポイント別 + 固定シャード K=4 / `serialize` 非経由 / 待ち 2秒1回 → Tier C。**期限切れパーミットの自然回復を AC 化**し、「枯渇しない」を**成立条件付きの検証可能な主張**にした（~~TTL による自然回復~~ **→ RV-P3DR-001 で「`acquire` 第1ステップでの回収」へ差し替え。キー単位 TTL では成立しない**） |
| **RV-P3D-002**（P3-a ブロッカー）| `functional-spec.md` §4.11 **Tier 表新設** / **AC-RL-12 新設** / F-010・F-009 API 仕様（SPEC-010） | `form-submission.md` §4.2 の Tier 表を正とし一本化。B=403 `{challenge}` / C=202 `{retryAfterMs}` / D=429 `Retry-After`。**`200+challengeRequired` は廃止**。429 禁止は「**共有軸の枯渇のみを理由に**」と明記 |
| **RV-P3D-003**（P3-a ブロッカー）| 本書「P3-a の完了条件（分割）」 | 「P3-a で満たす」／「後続単位で再検証する」に分割（**再レビュー RV-P3DR-003 で AC-PII-11 を後者へ移動し、AC-RL-15 / AC-010-4 の `sid` 照合を追加。件数は下表を正とする**）。**ルート列挙テストは `app/api/**/route.ts` 走査型**と AC-010-14 で指定 |
| RV-P3D-004 | AC-RL-3 / **AC-RL-13 新設** / AC-008-4 / F-010 境界値 | Cookie を**必須化**（不在・不正は Tier B。素通りさせない）＋**発行を発信元軸 30回/10分で制限**＋送信間隔は Cookie 内の署名済み `issuedAt` で判定。テスト3本を必須化 |
| RV-P3D-005 | AC-008-3（改訂） | `localStorage`/Cookie は禁止のまま、**`sessionStorage` を条件付き許可**（非自動復元・削除導線・送信成功で削除・**写真関連値は保存禁止**）。Designer 側の下書き保存を潰さない |
| RV-P3D-006 | AC-010-3 / E-010-2 / AC-PII-1（SPEC-012） | ハニーポットを「静かに拒否」から **Tier B 降格**へ。DB0件・メール0件を検証。充填値をログに残さない |
| RV-P3D-007 | **AC-PII-10 / 11 新設** / `tech-stack.md` §4.6 | `GET /api/cron/*` + `Bearer ${CRON_SECRET}` 必須・**未認証は 404**・public-guard 対象外で `withCronAuth`・件数上限200とページング・本番 fail-fast |
| RV-P3D-008 | `Application.statusChangedAt` 新設（SPEC-014。functional-spec / `prisma/schema.prisma` / §4.8 / business §2.3.1）| AC-PII-5 を**判定純関数 + 境界値6本**へ。`(status, statusChangedAt)` インデックス追加 |
| RV-P3D-009 | **Designer 担当**（✅ 再レビューでクローズ確認）| `license-upload.md` / `form-submission.md` の SPEC-003 訂正前の失効値。申し送り済み |
| RV-P3D-010 | `tech-stack.md` **§4.7 新設** / AC-008-1 / AC-010-15 | **CSP を P3-a で最終形投入**（Turnstile / Blob を先行許可）。検証対象は P3-a=`/`、P3-b 以降=`/apply`。`style-src 'unsafe-inline'` の受容を明記 |

> ⚠️ **未処理の DB ドリフト（2026-07-29 更新 / RV-P3DR-002・RV-P3DR-011）**: `prisma/schema.prisma` に
> **2つの未マイグレーションのフィールド**がある（いずれも nullable。仕様確定のためのスキーマ更新のみで、Spec Agent の判断で意図的に保留）:
> 1. `Application.statusChangedAt` + `@@index([status, statusChangedAt])`（RV-P3D-008 / SPEC-014。参照するのは **P3-d**）
> 2. `Application.sessionIdHash`（RV-P3DR-002 / SPEC-017。参照するのは **P3-b** の冪等照合 = AC-010-4）
>
> **この2つは1回のマイグレーションにまとめる。作成時期は「P3-b 着手前」**（早い方に合わせる）。
> **`sessionIdHash` を (A) スキーマ追加案にしたのは、この「まとめられる」ことが理由の1つ**である（`docs/functional-spec.md` SPEC-017）。
> 現状は Prisma Client を再生成していないため既存ゲートに影響はない（unit 179 / integration 28 / type-check 全て green で確認済み）。
> **`pnpm db:generate` を実行してこれらのフィールドを参照するコードを書く前に、必ずマイグレーションを作成すること。**
> それより前に `pnpm db:generate` が走ると、スキーマにあって DB に無い列を Client が知っている状態になり、参照した瞬間に実行時エラーになる。
> **P3-a はどちらのフィールドも参照しない**ため、P3-a の着手・完了を妨げない。
> 同じ警告を `prisma/schema.prisma` の各フィールドのコメントにも置いた（スキーマを開いた人が最初に見る場所。RV-P3DR-011）。

### 設計**再**レビュー差し戻しの反映（Spec Agent / 2026-07-29 / spec v0.3.2）

`docs/review-p3-design-re-2026-07-29.md`（**Request Changes** / 前回28件中25件クローズ・新規 Must Fix 3・Should Fix 6・Nice to Have 2）に対する仕様側の対応。詳細と下した決定は **`docs/spec-p3-fix2-2026-07-29.md`** を参照。

| 指摘 | 反映先 | 決定の要旨 |
|------|--------|-----------|
| **RV-P3DR-001**（P3-a ブロッカー）| `functional-spec.md` AC-RL-1 / AC-RL-11（書き換え）/ **AC-RL-15 新設** / `tech-stack.md` §4.5 + 変更履歴 | セマフォを **`INCR`+`EXPIRE` → ZSET によるパーミット単位のリース**へ差し替え。`acquire` = `ZREMRANGEBYSCORE`（期限切れ掃除）→`ZCARD`判定→`ZADD` を **Lua 1本で原子的に** / `release` = `ZREM permitId`（**冪等**。0クランプ不要）。**回復の責任をキーの TTL ではなく各パーミットの score に持たせた**ため、トラフィックが継続していても回復が成立する。**AC-RL-11(a) を「acquire を継続的に到着させながら TTL 経過後の回復を見る」形へ書き換え**（無負荷で放置するテストは壊れた実装を green にするため禁止） |
| **RV-P3DR-002**（P3-b ブロッカー）| **SPEC-017 新設**（`functional-spec.md` AC-010-4 / `Application` 型 / §4.8 / §4.9 / `prisma/schema.prisma` / `business-spec.md` §2.3.1 #7）| 冪等照合用の `sid` 保持場所を **案(A) `Application.sessionIdHash String?`**（HMAC ハッシュ・定数時間比較・`null` は不一致）に確定。**案(B) KV 短期ウィンドウは却下**（TTL 切れという第3の状態が増え UI 記述にも波及する / マイグレーションは `statusChangedAt` と1回にまとめられる） |
| **RV-P3DR-003** | 本書 P3-a 完了条件 (1)(2) の表 | **AC-PII-11 を (1) から (2) へ移動**（対象バッチは P3-c / P3-d にしか存在しない）。(1) に残るのは `AC-PII-10` のみで、検証対象を `withCronAuth` の存在と挙動に限定 |
| RV-P3DR-004 | `functional-spec.md` §4.11 **契約ルール7 新設** / AC-RL-12(e) / F-010・F-009 の 403 行 | **Tier 判別に使うのはステータスと `challenge` の有無だけ**と明文化。`403`+`challenge` = Tier B / `403` without `challenge` = **Tier ではない失敗**（CAPTCHA を出すと抜けられないループになる）。**428 案は却下**（RV-P3D-002 で一致させた5箇所を再度動かすコストに見合わない）。**Designer への申し送りあり** |
| RV-P3DR-005 | **AC-RL-15(a)** / `tech-stack.md` §4.5 | TTL と `maxDuration` を単一定数 `PUBLIC_HANDLER_MAX_DURATION_SEC` から導出し、**片方だけ変えたら落ちるユニットテスト**で固定。文書は「届く場所」の代用にならない |
| RV-P3DR-006 | **AC-RL-15(b)(c)** / `tech-stack.md` §4.5 | 上限は **`perShardLimit`（シャードあたり）**と定義し、全体上限 = `perShardLimit × K`。**power of two choices を採用**（偏りによる不要な Tier C を減らす） |
| RV-P3DR-007 | **AC-RL-8**（明確化）/ `tech-stack.md` §4.5 | セマフォは **`SemaphoreStore` という別抽象**を持つ。`RateLimitStore`（`{count, resetAt}`）は「減らないカウンタ」の抽象で `release` を表現できない。共有するのは KV クライアントと接続設定のみ |
| RV-P3DR-008 | `tech-stack.md` §4.5 残余リスク節 | 無条件の「処理完了で自動解放されるので枯渇せず」を**成立条件付き**へ訂正し、**「P4 でこの行を根拠に使ってはならない」**と明記 |
| RV-P3DR-009 | **AC-RL-12(c)** | ジッタ検証を「2回取って同値でない」から **N=20 サンプルで (c-1) 相異なる値が2つ以上 + (c-2) 全サンプルが基準の ±20% 内** へ。乱数源を注入し固定シードでの決定的検証も併用 |
| RV-P3DR-010 | **AC-RL-13(a)** | 「発行の配線は P3-b / P3-a は Cookie 値の生成・署名・検証まで」を **AC 本文にも**書いた（読み替えが phase-status にしか無い状態を解消） |
| RV-P3DR-011 | `prisma/schema.prisma` の各フィールドコメント / 上記 DB ドリフト注記 | マイグレーション未作成の警告を**スキーマ側にも**置いた。`statusChangedAt` と `sessionIdHash` を**1回のマイグレーションにまとめる**方針を確定 |

### 設計**再々**レビュー（Approve / P3-a 着手可）の反映（Spec Agent / 2026-07-29 / spec v0.3.3）

`docs/review-p3-design-re2-2026-07-29.md`（**Approve / P3-a 着手可** / 前回11件中クローズ9・部分クローズ2・未クローズ0 / 新規 Must Fix 2・Should Fix 5・Nice to Have 2）に対する仕様側の対応。
詳細と下した決定・**AC 修正後の自己点検結果**は **`docs/spec-p3-fix3-2026-07-29.md`** を参照。

| 指摘 | 反映先 | 決定の要旨 |
|------|--------|-----------|
| **RV-P3DR2-001**（Must Fix）| `functional-spec.md` **AC-RL-11(a)(d)** / 本書 P3-a 完了条件 (1) | 「上限まで取り切る」＝**セマフォ全体を満杯にすること**と定義し、手順を①〜⑤で確定。**既定は `SEMAPHORE_SHARDS = 1` の注入**（複数シャードなら固定シードの注入乱数）。**「`acquire` が失敗するまで取る」を禁止**（power of two choices では 4中3満杯でも 50% で失敗＝フレーキー）。**時刻を進める前に「期限前の追加 `acquire` が失敗する」assert を必須化**（テストが空振りしていないことの証明）。(d) は (a) のこの assert が通っている証跡を先に残してから行う |
| **RV-P3DR2-002**（Must Fix）| `functional-spec.md` **AC-RL-11(e) 新設** / 本書 P3-a 完了条件 (1) | 「同時に有効なパーミットが上限を超えない」を新設。**(e-1) 振る舞い + (e-2) 単一原子操作 + (e-3) 濃度の最大値の3点をすべて要求**。(e-1) だけでは楽観方式（`ZADD`→`ZCARD`→超過なら自分を `ZREM`）が **成功数はちょうど上限になるため green になる**ので、構造と濃度で押さえる |
| RV-P3DR2-003 | `functional-spec.md` AC-RL-1・AC-RL-15 / `tech-stack.md` §4.5 | **待機中の各ポーリングでシャード候補を選び直す**（同一ペア再利用を禁止）。抽選は `acquire` の内側で毎回行う |
| RV-P3DR2-004 | `functional-spec.md` AC-RL-1・**AC-RL-15(a)** / `tech-stack.md` §4.5 | **秒 → ms の変換を `semaphoreTtlMs()` 1箇所に固定**し、`SemaphoreStore` の境界から先はすべて ms。AC-RL-1 の擬似コードを `<now + ttlMs>` へ訂正。**`acquire` に渡る実 ms 値が 20,000 であることを別テストで固定** |
| RV-P3DR2-005 | `tech-stack.md` §4.5 | `now` を呼び出し側が渡す設計の**成立条件（インスタンス間クロックスキューが TTL に対して十分小さいこと）を明記**。前提であって性質ではないと書いた |
| RV-P3DR2-006 | `functional-spec.md` AC-RL-1・AC-010-13(b) / `tech-stack.md` §4.5（**「`EVAL` の実現可能性」新設**）/ 本書 P3-a 行 | キー literal を **`sem:{applications}:0`〜`:3`**（エンドポイント名をハッシュタグに）に確定。**`@upstash/redis` の `eval(script, keys: string[], args)` で複数キー `EVAL` が成立することを確認済み**。**`@vercel/kv` はサービス提供終了のため採用しない**（Upstash Redis へ確定） |
| **RV-P3DR2-007** | 本書 §「受容した残余リスク」 | 無条件の「枯渇せず」を**成立条件付き**へ書き換え、「P4 の再評価者がこの行を根拠に使ってはならない」を併記。**全文検索で残存箇所を確認**（`docs/security-audit.md` の同一命題は Security Agent 担当として申し送り） |
| RV-P3DR2-008 | **Designer 担当**（Spec は編集しない）| `ui-design/form-submission.md` §11 I-6 の「§5『保存失敗』相当の再送導線に留め」を「**§3.2 の Tier B UI として扱い**」へ1行訂正（申し送り D-5 を「確認のみ」から訂正内容付きへ差し替え） |
| RV-P3DR2-009 | `functional-spec.md` AC-010-13(b) / `tech-stack.md` §4.5（**「シャード化の効果の成立条件」新設**）| シャード化の効果は**キー単位ロック/スロット単位ルーティングを持つ構成でのみ成立**すると範囲を限定。**AC-010-13(c) の実測を「シャード化が効いた証拠」と読み替えることを禁止**（効いているのは `serialize` 非経由） |

---

## P3 のフェーズ分割（Spec Agent 決定 / 2026-07-29）

P3 は公開フォーム（F-008/009/010）・管理側受信管理（F-017/018）・レート制限基盤の本番化（条件2）を含み、
P2（お知らせCMS）1本ぶんを明らかに超える。**1つの作業単位にすると、P2/P2.5 で2度起きた
「テストは green だが脅威が閉じていない」型の失敗を検知できる粒度を失う**ため、4単位に分割する。

**分割の判断理由**:
- **依存の向き**が一方向で切れる（基盤 → 送信経路 → 写真 → 管理閲覧）。後段は前段の完了を前提にでき、差し戻しが前段へ波及しない。
- **セキュリティ検証の性質が単位ごとに異なる**（P3-a=可用性/流量、P3-b=入力検証・スパム・PII、P3-c=ファイル実体・トークン、P3-d=IDOR・削除の完全性）。監査を単位ごとに分けたほうが、監査者が1回に負う脅威モデルが小さくなり見落としが減る。
- **条件2 は F-010 の完了条件**だが、実体はレート制限基盤の本番化であり、フォームUIとは独立に実装・実測できる。先に片付けることで、UI 実装中に基盤設計をやり直す差し戻しを避ける。
- **CSP（SEC-002）を P3-a に置く**。「/apply の公開と同時に投入」が要求なので、フォームが出来てから足すのでは順序が逆になる。

| 単位 | スコープ | 主な成果物 | 完了条件 |
|------|---------|-----------|---------|
| **P3-a** | レート制限基盤の本番化 + 公開変更系ラッパ + フォームセッション Cookie 基盤 + CSP（**条件2 の実体**）。**着手時の最初のタスク**: 採用する KV クライアントが `eval` / `evalsha` を提供し複数キーを渡せることの確認（RV-P3DR2-006。**Spec 側で確認済み → `@upstash/redis` の `eval(script, keys: string[], args)` で成立。`tech-stack.md` §4.5「`EVAL` の実現可能性」を参照**。依存追加時に実物で再確認すること） | `lib/kv.ts`（`createKvRateLimitStore`）/ `lib/semaphore.ts`（**KV ZSET によるパーミット単位のリース**。RV-P3DR-001）/ `lib/env.ts`（本番 fail-fast）/ `lib/public-guard.ts`（認証非依存ラッパ）/ `lib/cron-auth.ts`（`withCronAuth`）/ `lib/form-session.ts`（Cookie 署名・検証）/ `next.config.mjs` or middleware（CSP 最終形）/ IPv6 `/64` 正規化 | **下記「P3-a の完了条件（分割 / RV-P3D-003）」を参照**。品質ゲート全通過（type-check / lint / unit / integration / build / e2e）＋ Senior Approve ＋ Security Critical0/High0。**監査者自身が条件1' の3脅威を再現できないことを実測で確認**すること（テスト green は完了条件ではない） |
| **P3-b** | 公開フォーム本体：F-008（ステップ式UI・確認画面）+ F-010（送信・スパム対策・冪等性・自動返信）。**写真は含まない** | `app/apply/**` / `app/api/applications/route.ts` / `lib/validators/application.ts` / Turnstile 検証 / Resend 自動返信 / `/privacy`（F-023、保持期間を記載） | 品質ゲート全通過 ＋ **AC-008-1〜8 / AC-010-1〜9・16 / AC-PII-1〜3** ＋ **上表 (2) のうち AC-RL-3 / 6 / 13(c) / 14 と AC-010-14 のカバレッジ・CSP の `/apply` 切替** ＋ Senior Approve ＋ Security Critical0/High0。**INQUIRY 経路が単独で完結して動く**（写真なしでも申込・問い合わせが成立する）こと。**`NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` を本番 fail-fast 対象へ昇格**させること（`tech-stack.md` §4.6） |
| **P3-c** | F-009 免許証写真アップロード（発行API・**削除API**・実体検証・トークン単回使用・orphan 回収バッチ） | `app/api/uploads/license/route.ts`（POST / **DELETE**）/ `lib/blob.ts` / マジックバイト検証 / `UploadToken` 消費の条件付き更新 / `app/api/cron/orphan-uploads/route.ts` | 品質ゲート全通過 ＋ **AC-009-1〜11 / AC-PII-4・8・9・10・11** ＋ Senior Approve ＋ Security Critical0/High0。**「申込に紐付かなかった写真が実際に消える」ことを結合テストで実証**すること。**AC-RL-9 の閾値を写真フロー込みで再測**し、`tech-stack.md` §6 #2 を更新すること（SPEC-009） |
| **P3-d** | 管理側：F-017 受信管理（一覧/詳細/ステータス/**APPI 削除**）+ F-018 署名付きURL閲覧 + 保持期間の自動削除バッチ | `app/admin/applications/**` / `app/api/admin/applications/**`（GET/PATCH/DELETE/sign）/ `app/api/cron/retention/route.ts` | 品質ゲート全通過 ＋ **AC-017-1〜8 / AC-018-1〜6 / AC-PII-5〜7・10・11** ＋ Senior Approve ＋ Security Critical0/High0。**IDOR を監査者が実際に試行して失敗すること**、および**削除で DB と Blob の両方が消えること**を実測で確認。**`statusChangedAt` を使う保持期間の判定純関数の境界値テストが揃っていること**（SPEC-014 / AC-PII-5） |

**実行順序**: P3-a → P3-b → P3-c → P3-d（順次）。P3-b 内の Designer（UIデザイン）は P3-a と並列で先行してよい（レート制限基盤に依存しないため）。

### P3-a の完了条件（分割 / RV-P3D-003 / 2026-07-29）

> **なぜ分割するか**: v0.3.0 の P3-a 完了条件は「AC-RL-1〜10 / AC-010-10〜15」だったが、**このうち5条件は P3-a の時点で検証対象そのものが存在しない**（フォームセッション Cookie の発行元 `/apply` は P3-b、`POST /api/chat` は P4、変更系ハンドラは 0〜1個しか無い）。**P3-a は定義上、自分の完了条件を満たせない状態だった。**
> 「達成できない完了条件」は必ず「**達成したことにする**」運用に化ける——P2.5 で 2 回、文書と実態の乖離が次フェーズの設計判断を誤らせた。**分割の利点（監査単位が小さくなる）は維持し、完了条件の書き方だけを直す。**

#### (1) P3-a で満たす（この単位で完全に検証できるもの）

| 条件 | P3-a における検証対象 |
|------|---------------------|
| AC-RL-1 の**基盤側の性質** | セマフォが **KV 上の ZSET によるパーミット単位のリース**で実装され（`acquire` が期限切れ掃除 → 判定 → 追加を Lua 1本で原子的に行うこと）、上限到達時に 429 ではなく Tier C（202）になること。上限中でも待機後に成功すること |
| **AC-RL-11** | **(a)** **セマフォ全体を満杯にして**（`perShardLimit` 件ではない。**このテストに限り `SEMAPHORE_SHARDS = 1` を注入するのが既定**。RV-P3DR2-001）`release` せず、**期限前の追加 `acquire` が失敗することを先に固定したうえで**、`acquire` を継続的に到着させたままリース期限を経過させるとパーミットが回復すること（**無負荷で放置する形のテストは不可**／**「`acquire` が失敗するまで取る」で満杯を判定するのも不可**）/ **(b)** `acquire` が返した key への release が他シャードに影響しないこと / **(c)** 同一 `permitId` の二重 release が他のパーミットを解放しないこと / **(d)** 掃除を消すと (a) が落ちること（**(a) の「期限前 `acquire` が失敗する」assert が通っている証跡を先に残す**）＋ 失敗した `acquire` の直後にも期限切れが消えていること（間引き実装の禁止）/ **(e)（RV-P3DR2-002 / 新設）同時に有効なパーミットが `semaphoreTotalLimit()` を超えないこと**——(e-1) 満杯時の追加 `acquire` が全失敗し並行 `+10` 件でも成功数がちょうど上限 / (e-2) **1回の `acquire` が KV クライアントへ発行するのは単一の原子操作 1回のみ** / (e-3) **フェイク KV クライアントが記録する全シャード濃度の最大値が上限を超えない**（TTL 境界をまたぐ系列を含む） |
| **AC-RL-15** | `SEMAPHORE_TTL_SEC` と各公開ハンドラの `maxDuration` が単一定数から導出され、**片方だけ変えると落ちる**こと / **秒 → ms の変換が `semaphoreTtlMs()` 1箇所に閉じ、`acquire` に渡る実 ms 値が 20,000 であること**（RV-P3DR2-004。関係式テストは秒同士しか見ないため変換ミスを検出しない）/ 上限が `perShardLimit` として定義され全体上限を返す関数があること / シャード選択が power of two choices であること（乱数注入・固定シードで決定的に検証）/ **待機中の各ポーリングで候補ペアが選び直されること**（RV-P3DR2-003。同一ペアを保持する実装が落ちること） |
| **AC-RL-12** | Tier B/C/D のステータス・本文形状・**ジッタ（N=20 サンプルで「相異なる値が2つ以上」かつ「基準の ±20% 内」。RV-P3DR-009）**・Tier B が降格理由を区別できないこと・**`challenge` を持たない 403 を Tier B として扱わないこと（(e) / RV-P3DR-004）**（**ラッパ単体に対して**検証する。実ルートは後続で増える） |
| AC-RL-2 / AC-010-16 | 連続成功でカウンタが単調増加すること・`cleanSource` 概念を持ち込まないこと |
| AC-RL-4（SEC-032） | IPv6 `/64` 正規化 |
| AC-RL-8 | `createRateLimiter` の再利用・判定ロジックを `lib/kv.ts` に複製しないこと |
| AC-RL-10 | 拒否・劣化ログに PII を出さないこと |
| **AC-RL-13 の (a)(b)(d)** | フォームセッション Cookie の**署名・検証・必須化ロジック**（`lib/form-session.ts` 単体）。改竄・期限切れ・他鍵署名が Tier B になること、`issuedAt` が送信間隔判定に使えること |
| AC-010-10（SEC-033） | KV store + 本番 fail-fast（`KV_*` / `FORM_SESSION_SECRET` / `CRON_SECRET`） |
| AC-010-12（SEC-031 / 041） | 退避しない / 予約枠の資格が復活しないこと |
| AC-010-13（SEC-034） | 直列化しないこと。**セマフォが `serialize` を経由せずシャード化されていること**（キーは `sem:{<endpoint>}:0..3`。`{}` はハッシュタグ）を含む。**⚠️ (c) の並行測定結果を「シャード化が効いた証拠」と書かないこと**——単一ノード KV ではシャード化はスループットを変えない。効いているのは (a)（`serialize` 非経由）である（RV-P3DR2-009 / `tech-stack.md` §4.5「シャード化の効果の成立条件」） |
| AC-010-14 の**構造** | ラッパ（`public-guard` / `withCronAuth`）が存在し、**ルート列挙テストが「`app/api/**/route.ts` を走査する」形で存在する**こと。この時点で対象が少なくても、**テストを書き換えずに新ルートが対象に入る**構造であること |
| AC-010-15 / AC-008-1 の**CSP 投入** | **最終形の CSP**（Turnstile / Blob を含む。`tech-stack.md` §4.7）が投入され、`script-src` に `'unsafe-inline'` が無いこと。**検証対象ページは `/`**（`/apply` は未存在） |
| AC-PII-10（**のみ**。RV-P3DR-003） | **`withCronAuth` の存在と挙動**: 未認証は 404（401 で経路の存在を教えない）/ `Origin` を持たないため public-guard 対象外 / **AC-010-14 のルート列挙テストで `/api/cron/**` → `withCronAuth` の割り当てが固定されている**こと / `CRON_SECRET` の本番 fail-fast。**`CRON_SECRET` の比較が定数時間であること**も含める（Test 申し送り16）。**AC-PII-11（バッチ本体の件数上限・ページング・べき等性）はここに含めない**——対象バッチ（`/api/cron/retention` は P3-d、`/api/cron/orphan-uploads` は P3-c）が P3-a に存在せず、**達成できない条件**になるため下表 (2) へ移した |
| AC-RL-9 の**暫定確定** | 閾値と実測手順を `tech-stack.md` §6 #2 に記録。**(a) 総リクエスト数は写真フローを含めた想定値で置く** |

#### (2) 各後続単位で再検証する（P3-a の完了条件に「再検証する約束」として明記する）

| 条件 | 再検証する単位 | 理由（P3-a に対象が無い） |
|------|--------------|------------------------|
| **AC-RL-3**（3本すべて） | **P3-b** | フォームセッション Cookie の発行元 `/apply` と送信経路 `POST /api/applications` が必要 |
| **AC-RL-6** | **P3-b** | 同上（`issuedAt` を持つ実リクエストが必要） |
| **AC-RL-13 の (c)** | **P3-b** | `GET /apply` の発行流量制限は `/apply` が必要 |
| **AC-RL-5** の `chat:` | **P4** | `POST /api/chat` が必要 |
| **AC-RL-14** | **P3-b** | 自動返信メール送信経路が必要 |
| **AC-010-14 のカバレッジ** | **P3-b / P3-c / P4 の各単位** | 「新しい変更系ルートが増えるたびに列挙テストが再実行され、**ラッパを通らないルートが増えたら落ちる**」ことを各単位で確認する |
| **AC-010-15 / AC-008-1 の対象ページ** | **P3-b で `/apply` に切替**、P3-b / P3-c 完了時に CSP を再検証 | `/apply` が P3-b 成果物のため（RV-P3D-010） |
| **AC-RL-9 の確定値** | **P3-c で再測** | 写真の発行・自動再発行を含む総リクエスト数が P3-c で初めて実測できる（SPEC-009 / RV-P3D-S04） |
| **AC-PII-11**（件数上限200・ページング・べき等性）| **P3-c（orphan 回収）/ P3-d（保持期間）** | **P3-a に対象バッチが存在しない**（`/api/cron/orphan-uploads` は P3-c、`/api/cron/retention` は P3-d の成果物）。AC-PII-11 が規定するのは**バッチ本体の性質**（上限で打ち切って正常終了 / 2回目で残りが処理される / Blob 削除に失敗した対象は DB を消さず次回へ持ち越す）であり、ラッパの存在では検証できない（RV-P3DR-003） |
| **AC-010-4 の `sid` 照合**（SPEC-017）| **P3-b** | `POST /api/applications` と Cookie を持つ実リクエストが必要。**P3-b 着手前に `sessionIdHash` のマイグレーションを `statusChangedAt` と1回にまとめて作成する**（下記 DB ドリフト注記） |

> **P3-a の Security 監査・Senior レビューでの扱い**: 上表 (2) の条件について、**P3-a で「達成」と報告してはならない**。報告してよいのは「**そのテストが存在し、対象が増えたら自動的に対象へ含まれる構造になっている**」ことまでである。**空振りしているテストを green として報告しない**（Test Agent 申し送り 11）。

**単位をまたぐ約束**:
- **F-010 を「完了」と宣言できるのは P3-a と P3-b の両方が通ってから**（条件2 は F-010 の完了条件であるため）。P3-b 単独では F-010 完了とみなさない。
- 各単位で `docs/review-p3X-*.md` / `docs/security-audit.md` へ追記し、次単位の入力にする。
- **P2/P2.5 の教訓を各単位の Security 監査で明示的に確認する**: (1) テスト対象が本番経路か、(2) テストが green でも脅威シナリオが実測で再現しないか、(3) 文書に事実と異なる数値が入っていないか。
- **P3-a の完了報告では、上表 (2) の条件を「達成」と書かない**（構造の存在までを報告する）。

### プロセス改善（設計レビュー D-1 / 2026-07-29 追加）

P3 設計レビューの Must Fix 10件のうち **4件（RV-P3D-002 / 005 / 006 / 009）は、Spec と Designer が同日に並行して成果物を書き、相互参照が閉じないまま完了したことに起因**していた（Designer の申し送り S-1〜S-6 のうち spec v0.3.0 が回答していたのは S-7 のみ）。

**今後 Spec と Designer を並列で走らせる場合、「Designer の申し送り表に Spec が1行ずつ回答を書き戻す」ことを Phase 3（設計レビュー）の完了条件に含める。** この往復が1回あれば、上記4件は設計レビュー前に消えていた。

### P3 の Nice to Have（記録 / 完了条件ではない）

- **RV-P3D-N04（P3-d）**: 削除請求の「受付から14日以内」（§2.2.4）は運用ルールでバッチ対象外という整理は妥当だが、**期限が管理画面に出ないと守れない**。F-017 の一覧に「削除請求として受け付けた問い合わせ」の残日数バッジを出す案を **P3-d の Nice to Have** として残す（デモの見栄えにも効く）。実装しない場合も完了を妨げない。
- N01（`receiptNumber` の ULID 化）/ N02（`style-src` の明記）/ N03（同意日時は `createdAt` で代替）/ N05（AC-RL-9 の実測書式）は **v0.3.1 でクローズ済み**。

### P2.5 スコープ外（P3 と同時 or 後続）
- SEC-025/026/027（Low）、SEC-014〜020（繰越）、RV-P2R-004/006〜009、RV-P25B-001〜005

### E2E 実行方針の確定（P2で変更）
- **CIモード（prebuilt = `pnpm start`）を正とする**。dev のオンデマンドコンパイル＋同期 scrypt が重なると3ブラウザ同時ログインでサーバ過負荷になり flaky 化するため。
- `playwright.config.ts`: `timeout: 60_000` / `expect.timeout: 15_000`。
- **admin-* スペックは chromium 単一実行**（firefox/webkit に `testIgnore: /admin-.*\.spec\.ts/`）。管理系は認証/CMSのアプリロジック検証でクロスブラウザ描画検証ではないため。公開系（top-page/course-*/school-access）は3ブラウザ継続。
- `admin-news.spec.ts` はタイトル一意化キーにプロジェクト名＋stampを含め、共有DBでの同名行衝突を回避。`afterAll` で `【E2E` 接頭辞行を掃除。

### P1 セキュリティ申し送り（後続で対応）
- SEC-001(Med): News.body をHTML描画する場合はサニタイズ必須（→P2 News CMSで対応）。
- SEC-002(Med): CSP未設定（→**P5厳格化から P3-a へ前倒し**。/apply の公開と同時に投入。functional-spec AC-008-1 / AC-010-15）。
- SEC-004(Low): 本番AUTH_SECRET強度の起動時検証（→P2 F-012認証実装で対応）。

### P1 既知の未実装（後続Phaseで実装、現状リンクは404 or 準備中）
- /news /faq /apply /bus /privacy、地図の実embed、構造化データ、合宿/スクール系の実料金。

## 運用メモ
- E2E後は orphan playwright ブラウザが port3000 を掴み残すことがある → `pkill -9 -f ms-playwright` で掃除。
- `pnpm add` 時 prisma postinstall がスキップされることがある → `pnpm db:generate`（恒久対応は `pnpm approve-builds`）。

---

## P3-b 完了記録（2026-07-29 / 差し戻し1回 → 再検収通過）

### 品質ゲート実測

| ゲート | 結果 |
|--------|------|
| `pnpm type-check` | ✅ エラー 0 |
| `pnpm lint` | ✅ warning/error 0 |
| `pnpm test:unit` | ✅ 47ファイル / **720件** 全パス |
| `pnpm test:integration` | ✅ 8ファイル / **76件** 全パス |
| `pnpm build` | ✅ 成功 |
| `CI=1 pnpm test:e2e` | ✅ **166 passed / 0 failed / 6 skipped / flaky 0**（1.5分。skip は webkit の Secure Cookie 制約2件 + ネットワーク依存。RV-P3B-018 修正後に flaky 2 件も解消） |
| Senior Review | ✅ **Approve**（`docs/review-p3b-fix2-2026-07-29.md`）。Must Fix 6 / Should Fix 4 / RV-P3B-012 すべてクローズ |
| Security Audit | ✅ **SEC-057 クローズ / 新規 Critical 0・High 0**（`docs/security-p3b-reaudit-2026-07-29.md`） |

### P3-b で発生した差し戻しの記録（教訓）

| ID | 内容 | 教訓 |
|----|------|------|
| RV-P3B-001 | Turnstile の結線が**単体・結合・E2E・型検査・ビルドのすべてを通過したまま**成立していなかった。真因は2つ: (1) `turnstile.ready()` が async/defer 構成で throw し描画関数が一度も呼ばれない (2) コンテナの `cf-turnstile` クラスで暗黙レンダリングが先に確保し、明示 `render()` が**例外も出さず拒否**される | **外部スクリプトとの結線は「属性と受け口が在る」ことでは検証にならない。実ブラウザで最終成果物（トークンの値）まで見ること。** iframe 等の相手側実装詳細をアサーションにすると、配線が正しくても赤くなる |
| SEC-057 | 縮退構成で Cookie を取り直すだけで流量上限が消える（60/60 到達 → 30 に抑制） | **軸として機能するのに必要なのは「一意であること」ではなく「入手にコストがあること」** |
| RV-P3B-018 | flaky の原因を「発行枠を使い切った」と誤って記録していた（実際は `?fs=1` 除去のレースをテスト側が踏んでいた） | **誤った原因を記録に残すと、次に同じ赤を見た者が env を緩める方向へ動く。** 原因の推定は必ず機構まで辿って裏を取る |

---

## P3-c への繰越（着手時の完了条件に含める）

### Senior 由来

| ID | 重要度 | 内容 |
|----|--------|------|
| **RV-P3B-019** | **Must Fix（P3-c 内で解消。Approve の条件として明記）** | **送信が成功する経路を通す E2E が 1 本も無い**（`/api/applications` へ POST するテストが 0 本）。さらに SEC-057 の修正で、E2E の縮退構成では窓あたり11枚目以降の Cookie に印が付くため**今の構成のままでは送信成功の E2E は原理的に書けない**。解法は「上限を緩める」ではなく「軸を分ける」形で設計すること（env で枠を緩める形は採らない） |
| RV-P3B-021 | Should Fix | （`docs/review-p3b-fix2-2026-07-29.md` 参照） |

### Security 由来（新規 SEC-067〜070。**いずれも Critical/High ではない**）

| ID | 重大度 | 内容 |
|----|--------|------|
| **SEC-067** | **Medium**（**非 Vercel 本番へ配備する場合は High = リリースブロッカーへ昇格**） | 縮退構成で、第三者が **10 リクエスト / 10 分**送るだけで以後の全新規来訪者が**回復不能な Tier B** に落ちる（印は Turnstile 検証より前に評価されるため CAPTCHA を解いても抜けられない）。SEC-057 の攻撃コスト（20 リクエスト）より安い |
| SEC-068 | — | 未検証の印がクライアントから可読で、共有カウンタの状態オラクルになる |
| SEC-069 | — | `trustProxy` を有効化する手段がコードに存在せず、**非 Vercel 本番が縮退構成から抜け出せない** |
| SEC-070 | — | SEC-057 の到達数を固定するテストの数値境界が緩く、大幅な退行を検出できない |

### 既存の繰越（P3-b 監査時点で確定済み）
P3c-1〜13（SEC-058〜065 / SEC-046 の `withCronAuth` 試行回数制限 / `pnpm audit` の CI 組み込み ほか）。
詳細は `docs/security-audit.md` §F「P3-c で守るべき要件」。

### 運用前提として明文化が必要（Security 監査 §E-1）
`__Host-` + `Secure` を採用しているため、**本番は必ず https**。http でホストされた瞬間に
全利用者の Cookie が発行されず全送信が Tier B になる（fail-closed で正しい挙動だが、前提として明示すること）。

---

## P3-c1 完了記録（2026-07-29 / 差し戻し3回 → 再検収通過）

### 品質ゲート実測

| ゲート | 結果 |
|--------|------|
| `pnpm type-check` / `pnpm lint` | ✅ エラー・warning 0 |
| `pnpm test:unit` | ✅ 54ファイル / **827件** 全パス |
| `pnpm test:integration` | ✅ 9ファイル / **87件** 全パス |
| `pnpm build` | ✅ 成功 |
| `CI=1 pnpm test:e2e` | ✅ **166 passed / 0 failed / 6 skipped / flaky 0** |
| Senior Review | ✅ **Approve**（`docs/review-p3c1-code-re-2026-07-29.md`）。未クローズ 0 件 |
| Security Audit | ✅ **新規 Critical 0 / High 0**（`docs/security-p3c1-audit-2026-07-29.md`）。P3-c2 着手可 |

### クローズした ID

| ID | 内容 |
|----|------|
| SEC-058 | `withPublicMutation` の構築時検査を半端な軸構成へ拡大 |
| SEC-060 | 実在しない `courseId` を 422 に。`P2003` を単語境界で分類し、未分類だけ 500 |
| SEC-061 / SEC-069 | `TRUST_PROXY` を導入し本番判定を `VERCEL` から分離。**非 Vercel 本番が縮退構成から抜け出せる**ようになった |
| SEC-068 | 未検証の印を payload から **HKDF ラベル**へ移動（payload はバイト単位で不変）。状態オラクルを解消 |
| SEC-046 | `withCronAuth` の試行回数制限（**抑制ではなく検知**。総当たりの速度は落ちない旨を明記） |
| SEC-064 | Prisma エラーログを `lib/pii-log.ts` の1点へ合流。`message` を返さない |
| SEC-065 | `/privacy` に発信元 IP の保持を明記し `RETENTION_PERIODS` へ |
| SEC-070 | SEC-057 の上界を定数から導出する形へ。実測が上界に張り付くことまで固定 |
| SEC-059 | **対象外**（P3-b の RV-P3B-006 でクローズ済みと確認） |
| SEC-063 | **明示的に繰越**（理由と訂正後の契約を記録。`security-audit.md` P3c-9 行に明記） |

### P3-c1 の教訓 — **「測っていない継ぎ目」が4段階で見つかった**

差し戻しのたびに一段深い継ぎ目が露出した。**すべて「テストは green・型検査も通る・しかし本番では効かない」型**であり、P3-b の RV-P3B-001（Turnstile が全ゲート通過のまま機能不成立）と同型である。

| 段階 | 指摘 | 内容 |
|------|------|------|
| 1 | REV-P3C1-001 | **受け口の悪用** — `hasVerifiedSession` の契約が SEC-057 を再び開く |
| 2 | NEW-001 | **受け口が呼ばれることを測っていない** — 正典関数は完璧でも結線が無く、本番では常に `undefined` |
| 3 | CR-001 | **呼び出し元がその状態を作らない** — 結線しても `/apply` が更新窓を見ないので要求が到達しない |
| 4 | Security §1.5 | **そもそも到達しない受け口** — 印付き Cookie には `verifyFormSessionValue` が必ず `null` を返すため、`hasVerifiedSession` は原理的に到達しない |

段階4は実装側と監査側が独立に発見し、**どちらも「達成した」と言わずに訂正した**。

**もう1つの教訓（自動化された網では守れない性質）**: 達成不能なテスト1件について、Impl Agent はテストを変更せずエスカレーションし、通すための抜け道（`CHALLENGE_TOKEN_TTL_MS` を 9 秒に下げる）を **REV-P3C1-002 の「増幅率1」契約を壊す**という理由で却下した。テスト自身はこの抜け道を捕捉できない。閾値を動かして直ったことにしない判断が要る。

### SEC-067 の正確な状態（**過大報告しないための記録**）

| 項目 | 状態 |
|------|------|
| **自己維持の切断** | **未是正**。印付き Cookie には `verifyFormSessionValue` が必ず `null` を返す（SEC-068 の設計上そうあるべき）ため `hasVerifiedSession` は原理的に到達しない。そこを true にすると「ロックアウトの恒久化」になるので、この挙動自体は正しい |
| 有効 Cookie を使った無コスト枠の収穫（REV-P3C1-001） | **是正済み・結線済み**（監査プローブ実測: 有効 Cookie を200回提示 → 追加取得 **0枚**） |
| 更新窓（NEW-003 / CR-001） | **是正済み・結線済み** |

**残る攻撃可能性**: (A) 縮退構成で第三者が `GET /api/form-session` を **10回/10分**送るだけで、その窓の新規来訪者全員が Tier B（**CAPTCHA では抜けられない**——Turnstile 検証は Tier B 判定より後で一度も評価されない）。(B) 攻撃者が手を引いた後も被害者の再試行だけで締め出しが継続（監査実測: 15人中5人が締め出されたまま）。
**重大度 Medium 据え置き**（想定配備の Vercel は `trusted=true` で印が付かない）。**非 Vercel 配備を選んだ時点で High = リリースブロッカーへ昇格。**

---

## P3-c2 の完了条件（申し送り）

1. **SEC-067 の回復経路（`challengeToken`）の結線を P3-c2 のスコープに明示的に入れること。** 自己維持は「印付き利用者が回復できる」ようになって初めて切れる（`hasVerifiedSession` では原理的に切れないことが実測で確定）。`uploads` は同じ Tier B 判定を使うため。
2. **⚠️ E2E は WebKit でフォームセッション Cookie の経路を一度も通っていない。** WebKit は `http://localhost` で `__Host-`（Secure）Cookie を受理しないため、**WebKit の E2E は常に「Cookie 無し」経路**を走っている。`uploads` は Cookie 軸に依存するので、**uploads の E2E を書く前に「E2E を HTTPS で回す」か「WebKit を明示的に対象外にする」かを決めること。** 黙って「3ブラウザで green」と記録すると、実際には2ブラウザでしか測っていない防御を「測った」ことにしてしまう。
3. **RV-P3B-019（Must Fix / P3-b 由来）**: 送信が成功する経路を通す E2E が 1 本も無い。現構成のままでは原理的に書けないため、「上限を緩める」ではなく「軸を分ける」形で設計すること。
4. `maxBodyBytes` を上げる際は、上げた値で `tests/unit/public-guard-body-stream.test.ts` を回すこと（既定値でしか測っていない）。
5. 既存の P3c-11（署名付きURLの有効期限・`objectKey` の推測不可能性・MIME/マジックバイト検証・orphan 回収）ほか、`docs/security-audit.md` §F の残項目。
