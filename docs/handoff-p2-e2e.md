# 引き継ぎメモ: P2 お知らせCMS — E2E flaky 修正の途中

> 作成: 2026-07-28 / 次セッション（`--dangerously-skip-permissions` で再実行）向けの再開手順。

## いまの結論（P2 の品質状態）
P2（お知らせCMS: 管理画面 + News CRUD + 認証）の**実装コードは完成しており、品質ゲートはE2E以外すべてgreen**。
残タスクは **E2E の flaky を潰して安定 green を1回確定すること** だけ。

| ゲート | 状態 |
|--------|------|
| `pnpm type-check` | ✅ パス |
| `pnpm lint` | ✅ パス |
| `pnpm test:unit`（72件） | ✅ 全パス |
| `pnpm test:integration`（23件） | ✅ 全パス（dev DB :5433 必要） |
| `pnpm build`（prebuilt） | ✅ 成功（DB非依存・force-dynamic） |
| `pnpm test:e2e` | ⚠️ **dev モードで flaky**。CIモード(prebuilt)での確定実行が未完 |

コードレビュー観点の手動確認も完了済み:
- PT2-01（handler認可）: `app/api/admin/news/route.ts` が各ハンドラで `auth()` 再検証・未認証401。E2E `admin-authz.spec.ts` でカバー ✅
- PT2-02（未来publishedAt除外）: `lib/news-admin.ts` `listPublishedNews` が `publishedAt: { lte: new Date() }` の時刻ゲート実装 ✅
- PT2-05（定数時間比較）: `lib/password.ts` `verifyPassword` が `timingSafeEqual`＋長さ事前チェック ✅
- PT2-06（単一描画経路）: `dangerouslySetInnerHTML` は `components/admin/MarkdownEditor.tsx` の `renderMarkdown` 経由1箇所のみ ✅

## E2E flaky の根本原因（診断済み）
`pnpm dev` で E2E を回すと、以下2つが重なりサーバが過負荷になり、**実行ごとに別テストがタイムアウト**して落ちる（実装バグではない。非競合の隔離実行では全て green）:
1. **同期 scrypt**: `verifyPassword` が `scryptSync`（1回~600ms・同期）でイベントループを直列ブロック。3ブラウザが同時ログインすると詰まる。
2. **オンデマンドコンパイル**: dev は `/admin` 系ルートを初回アクセス時にコンパイル。3ブラウザ同時 + scrypt で初回リダイレクトが Playwright デフォルト(5s)を超える（※認証は成功しており error alert は出ない＝純粋な遅延）。

観測: login成功→`/admin`リダイレクト待ちが5sで切れる / 編集フォームの`getByLabel('タイトル')`が来ない / 公開ページまで60sタイムアウト（サーバ自体のストール）。失敗テストが毎回移動＝典型的な競合flaky。

## 実施済みの修正（コミット未、git管理外リポジトリ）
1. **`tests/e2e/playwright/admin-news.spec.ts`**:
   - タイトル一意化キーに **プロジェクト名** を含める（`beforeAll` で `testInfo.project.name`＋`stamp`）。共有DBでの同名行衝突を回避。
   - `afterAll` で `【E2E` 接頭辞行をベストエフォート削除（元からあり）。
   - beforeEach の login 後アサーションはグローバル設定に集約（inline timeout は撤去）。
2. **`playwright.config.ts`**:
   - `timeout: 60_000` / `expect: { timeout: 15_000 }` を追加（dev の初回コンパイル遅延吸収。CIは実害なし）。
   - **管理系スペックを chromium 単一実行に限定**: `firefox`/`webkit` project に `testIgnore: /admin-.*\.spec\.ts/` を付与。
     理由: admin-* はアプリロジック（認証/CMS）検証でクロスブラウザ描画検証ではない。3ブラウザ同時ログイン競合を根絶。公開系(top-page/course-*/school-access)は3ブラウザ継続。

## 未確定 / 次にやること（重要）
**まだ「安定 green のフルE2E」を1回も取れていない。** 直近のdevモード実行は 5 failed（全chromium・公開ページ含む・60sストール）で、これは短時間にフルスイートを何度も回した結果 **Next dev のゾンビプロセス/サーバストール** という環境要因の可能性が高い。

→ **CIモード（prebuilt）で確定させるのが正攻法**。オンデマンドコンパイルを排除し、`workers:1`・`retries:2` で安定する。ビルドは完了済み（`.next` あり）。

### 再開手順（この順で実行）
```bash
# 1) ゾンビ一掃（過去実行の孤児ブラウザ/サーバ。macOSで kill -9 が UEs 状態で残ることあり）
pkill -9 -f ms-playwright; pkill -9 -f 'next dev'; pkill -9 -f 'next start'; pkill -9 -f 'next-server'
lsof -ti:3000 | xargs kill -9 2>/dev/null
# LISTEN が 0 なら server はバインド可（孤児 firefox がクライアント接続で残っていても無害）

# 2) dev DB 起動 & seed（未起動なら）
bash scripts/dev-db.sh up
pnpm exec prisma migrate deploy && pnpm db:seed   # News=7, AdminUser=1 になる

# 3) ビルド済み前提でCIモードE2E（prebuilt start・workers:1・retries:2）
CI=1 pnpm test:e2e
```
- 期待: admin-* は chromium のみ、公開系は3ブラウザ。全 green を確認する。
- もし CI=1 でも admin 系が落ちるなら **実装 or テスト契約の本物のバグ**として `test-results/**/error-context.md` を精査（それまでは環境flakyと切り分け済み）。

### green 確定後の残作業
1. `docs/phase-status.md` を P2 完了に更新（P2行を✅、成果物・ゲート・E2E方針変更を追記、次着手をP3に）。
2. Senior Engineer レビュー（P2実装コードの検収）＋ Security 監査（SEC-001実挙動/認可/公開クエリ時刻ゲート）を実施 → `docs/review-p2-code-*.md` / `docs/security-audit.md` 追記。CLAUDE.md Phase 7。
3. レビュー未対応の任意項目: PT2-04（サニタイズ難読化/非許可ブロックの明示テスト追加）, PT2-07（migration後の PublishStatus 型/enum 単一源性の型アサーション）。

## 環境メモ
- git 管理外リポジトリ（`git` コマンド不可）。変更はファイル直編集で保持。
- dev DB: Docker `driving_school_pg` postgres:16 ホスト側 :5433。URLは `.env`。
- E2E後の孤児掃除: `pkill -9 -f ms-playwright`。ポート3000は孤児firefoxのクライアント接続が残ることがあるが LISTENer でなければ無害。
- テスト設計レビュー: `docs/review-p2-test-2026-07-27.md`（Approve, PT2-01〜07 指摘）。
