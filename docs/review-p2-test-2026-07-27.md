# テスト設計レビュー: P2 お知らせCMS / 管理画面

## レビュー日: 2026-07-27
## 対象Phase: テスト設計（CLAUDE.md Phase 5）
## レビュワー: Senior Engineer Agent
## 前提: Impl(P2) 並行着手 → 「テスト契約が実装可能か（正しい実装で green になるか）」に絞った早期判定

## 総合評価: **Approve**

テスト契約は実装可能で、SEC-001（サニタイズ）と F-014（3値ステータス遷移・公開クエリ整合）のカバレッジは高品質。**正しい実装に対して誤って fail する契約欠陥は検出されなかった**ため Impl 続行を承認する。以下は非ブロッキングだが、うち PT2-01/02/03 は Impl 稼働中の今に対処するとセキュリティ・整合の実効カバレッジが上がる（いずれも低コスト）。

## 評価サマリー
- 改善必須（今すぐ直すべき契約欠陥）: **0件**
- 改善推奨（Impl中に対処推奨）: 3件（PT2-01/02/03）
- 任意: 4件（PT2-04〜07）

## 依頼された判断事項の検証
- **(a) 公開反映をトップ最新3件で代替（/news未実装）**: **妥当**。/news は P2 スコープ外。トップ `section-news` が利用可能な公開面。時刻結合（publishedAt=当日）は許容だが /news 実装後の反映検証追加を追跡（PT2-03関連）。
- **(b) サニタイズ許可要素を厳格版（表/コードブロック不許可）に確定**: **妥当・より安全**。厳格ホワイトリスト＋rehype-raw不使用は堅牢。ただし非許可ブロック（table/pre）除去の明示テストで回帰を固定推奨（PT2-04）。
- **(c) @prisma/client enum を使わず @/lib/publish-status を真実源にした回避**: **妥当な回避**。migration 前に validators/badge/news-admin/テストが型共有でき、かつ結合テスト `PUBLISHED→UNPUBLISHED` が **migration 未了なら実行時に落ちる forcing function** になっている（良い設計）。migration 後の型/enum 再整合のみ追跡（PT2-07）。

---

## 検証した事実（エビデンス）

### SEC-001 サニタイズ（最重要）— カバー済み攻撃面
`renderMarkdown`（remark→rehype→rehype-sanitize、**rehype-raw 不使用**＝生HTMLを要素として復元しない）に対し、以下を網羅:
- `<script>`除去/`alert(1)`不残存、`<iframe>`不許可、`<img onerror>`（img自体不許可）、`on*`(onclick)除去、`<style>`要素＋`style=`属性除去、`javascript:`（`.toLowerCase()`でcase考慮）、`data:text/html`除去。
- 許可: h2/h3/strong/em/li/blockquote、`h1`は本文で不許可。
- `a`要素: http/https で `target="_blank"`＋`rel`(nofollow/noopener/noreferrer トークン単位)強制、`mailto`許可。
→ ホワイトリスト方式＋raw断ちで、ブラックリスト漏れに強い正しい設計。

### 認証/認可 — カバー済み
- 未認証で `/admin`・`/admin/news` → `/admin/login` リダイレクト（E-012-2）。
- ログイン成功→ダッシュボード、失敗→**汎用エラー**（どちらが誤りか非開示＝アカウント列挙対策, E-012-1、`role="alert"` に汎用文言）。
- password: `scrypt$salt$hash`形式・salt乱数性・往復true・誤りfalse・**形式不正stored は例外投げず false**。

### CRUD / 公開整合 — 高品質
- 3値遷移を網羅: DRAFT→PUBLISHED(publishedAt非null・公開出現)、PUBLISHED→UNPUBLISHED(公開除外・管理残存)、UNPUBLISHED→PUBLISHED(再公開)。
- 公開クエリ=PUBLISHEDのみ、DRAFT/UNPUBLISHED除外、`SEED_COUNTS.news.published`(=6)を汚さない。
- 結合は `afterEach` で作成レコード確実削除＋cleanup reset（seed非汚染）。共有 `tests/fixtures/seed-counts.ts` を参照（P1 TC-02 反映済み）。

### TDD 健全性 — クリーン
未実装スタブは全て NotImplemented throw（renderSafe / validators/news / password(hash・verify) / news-admin 全6関数 / badge.publishStatusBadge）。実装済み依存（publish-status ラベル、badge.newsCategoryBadge/badgeShapeForVariant）はパス。red は実装未存在由来。加えて `badgeShapeForVariant` が `adminStatus/publishStatus→'pill'` 分岐を実装し、P1 レビューの TC-05（adminStatus 未定義リスク）も解消済み。

### トレーサビリティ — 正当
F-012/013/014、US-011/012、E-012-x/E-014-x、SEC-001、SPEC-002、REV-006('ALL'不可)を各テストに明記。バリデーションは title 1/100/101・body 20000/20001・enum外(ARCHIVED/ALL)を網羅。

---

## 指摘事項

### [PT2-01] 変更系 管理APIのサーバー認可がテストされていない（ページ遷移のみ）
- **種別**: Security / Coverage
- **重要度**: Should Fix（Impl中に追加推奨）
- **場所**: E2E `admin-auth.spec`（未認証は**ページ**リダイレクトのみ検証）、結合 `news-admin.int`（リポジトリ層を認証なしで直接呼ぶ＝正しいが、API/Server Action の認可は検証外）
- **現状**: tech-stack §4.3 は「middleware＋各ハンドラ内で session 再検証（多層防御）」を要求するが、**未認証での変更系（POST/PUT/DELETE `/api/admin/news` or Server Action）が 401/拒否されること**を確認するテストが無い。middleware がページを守る一方、ハンドラ層の再検証（belt-and-suspenders）は未カバー。認可バイパスは管理CMSの主要リスク面。
- **改善案**: (a) 未認証（Cookie無し）で変更系 admin API/Server Action を叩き 401/リダイレクトを確認する結合 or API-level E2E を1本、(b) 可能なら「認証済みだが CSRF/セッション不正」ケースも将来追加。
- **理由**: ページガードとAPI認可は別レイヤ。仕様が多層防御を謳う中核の実効検証。並行のセキュリティ監査とも突き合わせ推奨。

### [PT2-02] 予約公開（publishedAt が未来）の除外がテストされていない
- **種別**: Coverage / 仕様適合
- **重要度**: Should Fix
- **場所**: `news-admin.int`（`listPublishedNews` の contract は `status='PUBLISHED' かつ publishedAt <= now()`）
- **現状**: 公開テストは全て過去日（2026-07-20/21、now=07-27）で作成するため、**未来 publishedAt の PUBLISHED を除外する**境界が未検証。Impl が時刻ゲートを実装せず `status='PUBLISHED'` だけで返しても全テストが green を通る（F-004 の `publishedAt<=now()` が抜けても検知できない）。
- **改善案**: PUBLISHED かつ publishedAt=未来日 のレコードを作り、`listPublishedNews` に**現れないこと**を検証する結合を1本追加。
- **理由**: 予約公開はCMSの実仕様（F-004）。時刻ゲート欠落は本番で「未来の記事が即公開」される不具合に直結。

### [PT2-03] E2E が共有DBに実PUBLISHED行を作り、失敗時に整合テストを汚染しうる
- **種別**: Test Isolation / 堅牢性
- **重要度**: Should Fix
- **場所**: `admin-news.spec`（`describe.serial` で作成→公開→編集→削除。クリーンアップは**最終の削除テスト依存**）
- **現状**: 公開ステップで当日日付の実 News を DB に作る。途中で失敗すると PUBLISHED 行が残存し、共有 dev DB を使う結合テストの厳密件数（`news.published=6`）と `news.int` の「最新=年末年始」を破壊する。unique timestamp title と最終削除で happy path は掃除されるが、失敗経路は保証されない。パイプラインは integration→e2e 順のため単一CI実行では守られるが、ローカルの e2e→integration 再実行や失敗残留で脆い。
- **改善案**: `test.afterAll` で `【E2E】` 接頭辞の行をベストエフォート削除（テスト専用クリーンアップ経路 or 各CI実行前の再seed保証）。
- **理由**: 共有DB前提の suite 間汚染は間欠failの典型要因。安価に構造的解消が可能。

### [PT2-04] サニタイズの難読化スキームと非許可ブロックの明示テストを追加（厳格版の固定）
- **種別**: Security / Coverage
- **重要度**: Nice to Have
- **場所**: `tests/unit/sanitize.test.ts`
- **現状**: 現行カバレッジは強いが、(1) 難読化 `javascript:`（大小混在/前後空白/HTMLエンティティ `&#106;...`、`vbscript:`）、(2) 判断(b)の帰結である **table / fenced code(pre) など非許可ブロックが出力に現れないこと** の明示テストが無い。
- **改善案**: 難読化スキーム1〜2本と「`| a | b |` や ` ```js ``` ` が `<table>`/`<pre>` を生まない」テストを追加し、厳格ホワイトリストを回帰から守る。
- **理由**: ライブラリが処理する範囲だが、明示テストで許可集合の縮小（厳格版）を契約として固定できる。

### [PT2-05] 定数時間比較はユニット検証不能 — コードレビューで担保
- **種別**: Security（プロセス）
- **重要度**: Nice to Have
- **場所**: `lib/password.ts`（stub は `timingSafeEqual` を契約に明記）／`password.test.ts`（true/false と形式不正のみ検証）
- **現状**: タイミング安全性はユニットで確実に検証できず、テストは結果値のみ。契約（docstring）は正しく `timingSafeEqual` を要求している。
- **改善案**: 実装コードレビューで `verifyPassword` が `crypto.timingSafeEqual`（`===` でない）かつ長さ不一致を早期 false する実装であることを確認項目に含める。
- **理由**: テスト不能な性質は契約＋レビューで担保するのが正しい。

### [PT2-06] 「本文描画は単一 renderMarkdown 経路のみ」はテスト不能 — コードレビューで担保
- **種別**: Security（プロセス）
- **重要度**: Nice to Have
- **場所**: SEC-001 全体（DB は生 Markdown を保存し、描画時サニタイズ）
- **現状**: 保存時ではなく描画時サニタイズのため、正しさは**全ての本文描画経路が renderMarkdown を通す**ことに依存。テストでは全経路強制を保証できない。
- **改善案**: 実装レビューで、本文（News.body 等）を `dangerouslySetInnerHTML` に渡すのは renderMarkdown の出力のみ／生 body を直接描画する箇所が無いことを grep 確認。
- **理由**: 描画時サニタイズ方式の唯一の穴を塞ぐ運用担保。

### [PT2-07] migration 後の PublishStatus 型/enum 再整合
- **種別**: Maintainability
- **重要度**: Nice to Have
- **場所**: `lib/publish-status.ts`（アプリ側 `PublishStatusCode`）↔ Prisma enum（migration 後に UNPUBLISHED 追加, task #13）
- **現状**: migration 後は「アプリ型」と「Prisma enum」の2源になる。結合の `PUBLISHED→UNPUBLISHED` が実行時 forcing function として働くが、長期的な値ドリフト検知は無い。
- **改善案**: migration 後に、Prisma enum から型を導出するか、両者一致のコンパイル時アサーション（`satisfies`/型等価チェック）を1つ入れて単一源性を回復。
- **理由**: 現状の回避は妥当。将来のドリフトを型で締める。

---

## 結論と次アクション
- **判定: Approve**。ブロッキングな契約欠陥なし。ロジック/データ層（サニタイズ・バリデーション・password・news-admin・publishStatus）と管理E2Eの Test設計は実装可能。
- **Impl 稼働中に追加推奨**: PT2-01（変更系APIの未認証拒否テスト）、PT2-02（未来publishedAt除外テスト）、PT2-03（E2Eのafterall掃除）。いずれも低コストで実効カバレッジ/堅牢性を上げる。
- **後続 or コードレビューで**: PT2-04（サニタイズ難読化/非許可ブロック）、PT2-05（定数時間はレビュー担保）、PT2-06（単一描画経路はレビュー担保）、PT2-07（enum再整合）。
- 実装 green 化後、SEC-001 実挙動・認可・公開クエリ時刻ゲートを対象に検収レビューを行う。並行のセキュリティ監査結果と PT2-01/05/06 を突き合わせて最終確定。
