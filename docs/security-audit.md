# セキュリティ監査レポート

## 監査日: 2026-07-27
## 対象: P1（公開サイト骨格） — `lib/` `components/` `app/` `middleware.ts` `auth.ts` `next.config.mjs` `prisma/schema.prisma` `prisma/seed.ts` / 設定ファイル群

> P1 は **読み取り系の公開サイト**。フォーム／申込／ファイルアップロード（F-008〜F-010, F-017〜F-018）と管理者認証の実装（F-012）は後続 Phase（P2/P3）で監査する。本レポートは P1 実装範囲に限定する。

---

## サマリー

| レベル | 件数 |
|--------|------|
| **Critical** | 0 |
| **High** | 0 |
| **Medium** | 2（いずれも後続Phaseで顕在化する先読み指摘。現時点で悪用経路なし）|
| **Low** | 3 |
| **Info** | 3 |

**総合評価: P1 リリースブロッカーなし（Critical/High = 0）。** DBアクセス境界・シークレット管理・XSS/インジェクション耐性・認可骨格は tech-stack の方針（§1.2 サーバー限定DBアクセス等）に沿って正しく実装されている。以下は防御的強化と後続Phaseへの申し送り。

---

## 確認できた良好な実装（Positive findings）

- **DBアクセス境界（tech-stack §1.2）**: DB資格情報・Prisma クライアントは一切クライアントに露出していない。
  - `lib/db.ts` / `lib/queries.ts` はサーバー専用。`lib/queries.ts` に `'use client'` **ディレクティブは無い**（grep が反応するのは「`use client` から import しないこと」という注意コメント文字列のみ）。
  - ビルド成果物 `.next/static/**` を `driving_dev_pw` / `POSTGRES_URL` / `AUTH_SECRET` / `passwordHash` / `admin_dev_pw` で全文検索 → **ヒット0件**。接続情報のバンドル混入なし。
  - `env.ts` の env スキーマは全キー **サーバー限定**（`NEXT_PUBLIC_` 接頭辞は機微情報に付いていない）。検証は遅延実行でビルド/テストを壊さない設計。
- **シークレットのハードコードなし**: `lib/`・`components/`・`app/` に接続文字列・APIキー・パスワードの直書きは無い。
- **インジェクション耐性**: 全 DB アクセスは Prisma のパラメータ化クエリ（`findMany`/`findFirst` の `where`）。生 SQL（`$queryRawUnsafe` 等）の使用なし。`[id]` パラメータは `prisma.findFirst({ where: { id } })` に渡るのみで SQL インジェクション不可。
- **XSS 耐性**: `dangerouslySetInnerHTML` / `eval` / 生 `innerHTML` の使用なし。DB 由来文字列（コース説明・お知らせタイトル等）はすべて JSX 経由で自動エスケープ。
- **URL パラメータ検証**: `app/courses/page.tsx` の `?format` / `?license` は許可リスト方式（`=== 'GASSHUKU'` 等）で正規化され、未知値は安全な既定にフォールバック。`CourseComparison` の URL 同期も許可値のみを書き込む。
- **認可骨格の正しさ**: `middleware.ts` は `matcher: ['/admin/:path*']` で **公開ルートに一切干渉しない**。`/admin/login` を除外して未認証を保護。リダイレクト先は `req.nextUrl.origin` + 固定パス `'/admin/login'` で **オープンリダイレクトなし**。
- **パスワード保存**: `prisma/seed.ts` の管理者は平文保存せず scrypt（salt付き, `scrypt$<salt>$<hash>`）でハッシュ化。
- **セキュリティヘッダ基盤**: `next.config.mjs` に `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / `Permissions-Policy`、`poweredByHeader: false`。
- **`.gitignore`**: `.env` / `.env.local` / `.env.*.local` を除外済み。`.env.example` は空値のキー名のみでコミット安全。

---

## 発見事項

### [SEC-001] News.body（リッチテキスト）の HTML レンダリングは未実装だが将来の XSS 面
- **重大度**: Medium（現時点で悪用経路なし・先読み）
- **カテゴリ**: インジェクション（XSS）
- **場所**: `prisma/schema.prisma:147`（`News.body String // 本文（Markdown/リッチテキスト）`）、消費側 `components/ui/NewsCard.tsx`
- **説明**: スキーマ上 `News.body` は Markdown/リッチテキスト想定。P1 では `NewsCard` が `title` をテキストとしてのみ描画し、`body` は **どこにも HTML として描画していない**（確認済み）。将来お知らせ詳細ページで `body` を Markdown→HTML 変換して表示する際、サニタイズ無しの `dangerouslySetInnerHTML` を使うと、管理画面（F-005/F-014）から投入された本文が保存型 XSS になり得る。
- **影響**: （将来）管理者アカウント奪取時、または管理入力の検証不備時に、閲覧者ブラウザで任意スクリプト実行。
- **修正方針**: お知らせ詳細実装時に、Markdown レンダラの HTML 無効化 or DOMPurify 相当でのサニタイズを必須とする。CSP（SEC-002）と多層防御を組む。**後続Phase（お知らせ詳細/管理CMS）で監査**。

### [SEC-002] Content-Security-Policy（CSP）未設定
- **重大度**: Medium（P5で厳格化予定と明記済み）
- **カテゴリ**: データ保護 / XSS 緩和
- **場所**: `next.config.mjs:4-9`（`securityHeaders` に CSP なし。コメントに「CSP は feature 実装時に厳格化する」）
- **説明**: 現状 CSP ヘッダが無く、万一 XSS が混入した場合の多層防御が効かない。地図 iframe（`components/ui/AccessMap.tsx`、現状 `embedUrl={null}` で未描画）を有効化する際は `frame-src` の許可ドメイン設計も必要。
- **影響**: XSS 緩和層の欠如。単体では脆弱性ではないが、他の入力面（P3フォーム）と組み合わさるとリスク増。
- **修正方針**: P5 で `Content-Security-Policy`（`default-src 'self'`、必要な `frame-src`/`img-src`/`connect-src` を最小許可）と、可能なら `Strict-Transport-Security` を追加。Next.js の inline script 対応に nonce 方式を検討。**予定どおり P5 で対応**。

### [SEC-003] `.env` にローカル開発用の資格情報が平文で存在
- **重大度**: Low
- **カテゴリ**: シークレット管理
- **場所**: `.env`（`driving_dev_pw` / `admin_dev_pw` / `AUTH_SECRET="dev-only-secret-change-me"`）
- **説明**: 実ファイル `.env` にダミーの開発用資格情報が平文で存在。ただし **`.gitignore` 済み**で、当リポジトリは現状 git 管理下ではない（コミット対象外）。`docs/dev-database.md` も全値を「開発用ダミー・本番不可」と明記。悪用価値のある本番シークレットではない。
- **影響**: 限定的（ローカルのみ有効な既知ダミー値。ローカル Postgres は `localhost:5433` バインド）。
- **修正方針**: 現状のまま許容可。git 初期化時は `.env` がステージされないことを再確認。デモを外部公開する場合は Postgres をローカルバインド維持し、`ADMIN_PASSWORD` を推測困難値へ。

### [SEC-004] 本番 `AUTH_SECRET` の強度要件が未強制
- **重大度**: Low
- **カテゴリ**: 認証（セッション署名）
- **場所**: `auth.ts`（NextAuth `session.strategy: 'jwt'`）、`.env`（開発値 `dev-only-secret-change-me`）
- **説明**: JWT セッション署名鍵。開発値は弱いプレースホルダ（許容）。`env.ts` では `AUTH_SECRET` が `.optional()` のため、本番で未設定/弱い値でもアプリ層で弾かれない。P1 は認証未実装（`providers: []`）のため実害なし。
- **影響**: （将来 F-012 で認証稼働後）弱い/漏洩した署名鍵はセッション偽造につながる。
- **修正方針**: F-012 実装時に、本番環境で `AUTH_SECRET` が十分な長さ（32byte以上）で設定されていることを起動時検証（`getServerEnv` で production 時必須化）。`openssl rand -base64 32` で生成。**後続Phase（F-012）で対応**。

### [SEC-005] 地図 iframe 有効化時の src 検証（先読み）
- **重大度**: Low
- **カテゴリ**: インジェクション / データ保護
- **場所**: `components/ui/AccessMap.tsx:30-34`（`<iframe src={embedUrl}>`）
- **説明**: 現状 `app/schools/page.tsx:49` で `embedUrl={null}` 固定のため iframe は描画されず、住所フォールバックのみ。将来 `embedUrl` を動的化する場合、値の出所が信頼できるドメイン（Google Maps 埋め込み）に限定されることを保証する必要がある。
- **影響**: （将来）検証なしで外部/ユーザー由来 URL を iframe src にすると、フィッシング iframe 埋め込み等のリスク。
- **修正方針**: `embedUrl` を許可ドメインの許可リストで検証、または school-info の定数からのみ供給。CSP `frame-src` と併用。**後続Phaseで監査**。

### [SEC-006] 依存パッケージの脆弱性スキャンを CI に組み込む
- **重大度**: Info
- **カテゴリ**: 依存関係
- **場所**: `package.json`（`next-auth@5.0.0-beta.25`、`next@^15.1.4`、`@prisma/client@^6.2.1` 他）
- **説明**: `next-auth` は beta 版を使用（F-012 で本採用予定）。本監査ではレジストリアクセスを伴う `pnpm audit` は未実行。既知脆弱性の継続監視が未整備。
- **影響**: 既知 CVE の見落としリスク。
- **修正方針**: CI（`.github/workflows/ci.yml`）に `pnpm audit --audit-level=high` を追加。`next-auth` は F-012 着手時に安定版へ更新を再評価。

### [SEC-007] Prisma ログに機微情報を出さない設定の維持
- **重大度**: Info
- **カテゴリ**: データ保護（ログ）
- **場所**: `lib/db.ts:14`
- **説明**: 現状 `log` は dev で `['warn','error']`、prod で `['error']`。`query` ログ（パラメータ含む）は本番で無効で適切。良好。
- **修正方針**: 現状維持。将来 `query` ログを足す場合も本番では無効に。

### [SEC-008] 外部リンクの rel 属性（防御的強化）
- **重大度**: Info
- **カテゴリ**: フロントエンド
- **場所**: `components/ui/AccessMap.tsx:45`（Google マップ検索 URL を `CTAButton`→`next/link` で描画）
- **説明**: 外部 URL への遷移だが `target="_blank"` を使っていないため `rel="noopener"` の必須性はない（reverse tabnabbing なし）。将来 `target="_blank"` を付ける場合は `rel="noopener noreferrer"` を併記すること。`mapsSearchUrl` は `encodeURIComponent` で組み立てておりインジェクションなし。
- **修正方針**: 任意。将来別タブ化する際の注意のみ。

---

## 後続Phaseへの申し送り（今回対象外＝後続Phaseで監査）

- **P3 フォーム（F-008/F-010/F-017）**: サーバーサイド入力検証（zod）、CSRF、Turnstile/hCaptcha 検証、レート制限（`lib/kv.ts` は現状 `throw` のプレースホルダ）、個人情報（氏名/生年月日/連絡先）の取り扱い・ログ非出力、`idempotencyKey` による重複送信排除。
- **P3 ファイルアップロード（F-009/F-018）**: `lib/storage.ts` プレースホルダ実装時に、contentType/サイズ検証、objectKey のサーバー生成（クライアント指定不可, REV-004）、署名URLの短期失効、非公開バケット、免許証写真（機微個人情報）の閲覧認可・IDOR 対策。
- **P2/F-012 認証**: Credentials/OAuth 方式確定後、認証バイパス・セッション有効期限/ローテーション・ブルートフォース対策・`/admin` 配下 Route Handler/Server Action での session 再検証（多層防御。middleware 単独に依存しない）。
- **P5**: CSP/HSTS 厳格化（SEC-002）、構造化データ、地図 iframe（SEC-005）。

---
---

# Phase 2 監査（2026-07-28）

## 監査日: 2026-07-28
## 対象: P2「お知らせCMS（管理画面 + News CRUD + 認証）」実装後の全コードベース

対象ファイル: `auth.ts` / `auth.config.ts` / `middleware.ts` / `lib/auth-guard.ts` / `lib/password.ts` / `lib/env.ts` / `app/admin/**` / `app/api/admin/news/**` / `app/api/auth/[...nextauth]/route.ts` / `lib/validators/news.ts` / `lib/markdown/renderSafe.ts` / `lib/publish-status.ts` / `lib/news-admin.ts` / `lib/queries.ts` / `lib/db.ts` / `components/admin/**` / `prisma/schema.prisma` / `prisma/seed.ts` / `next.config.mjs` / `.env.example` / 依存関係（`pnpm audit`）

参照: `docs/functional-spec.md`（F-012 / F-014 / §4.10）、`docs/review-p2-test-2026-07-27.md`（PT2-01/05/06）、本レポート P1 セクション（SEC-001/002/004）

---

## サマリー

| レベル | 件数 | 該当ID |
|--------|------|--------|
| **Critical** | 0 | — |
| **High** | 1 | SEC-009 |
| **Medium** | 4 | SEC-010 / SEC-011 / SEC-012 / SEC-013 |
| **Low** | 4 | SEC-014 / SEC-015 / SEC-016 / SEC-017 |
| **Info** | 3 | SEC-018 / SEC-019 / SEC-020 |

（上記に加え、P1 からの繰越として **SEC-002（CSP未設定, Medium）が未解決**。下表参照）

**総合評価: Critical 0 / High 1。** 認可の多層防御（middleware ＋ 全ハンドラでの `auth()` 再検証）、パスワードの scrypt + `timingSafeEqual`、アカウント列挙対策、Markdown サニタイズは **仕様どおり正しく実装されている**（実挙動を34ペイロードで検証、後述）。一方、**認証エンドポイントの試行回数制御が全く無い**点が唯一の High であり、リリースブロッカーとして扱う。

---

## P1 申し送り事項の現状判定（実コードで再判定）

| ID | 内容 | P1判定 | **現状判定（2026-07-28）** | 根拠 |
|----|------|--------|--------------------------|------|
| **SEC-001** | `News.body` を HTML描画する場合サニタイズ必須 | Medium / P2対応予定 | **解決済み** | `lib/markdown/renderSafe.ts:95-110` に共通パイプラインを実装。厳格ホワイトリスト（`:36-68`）＋ `a` への `target/rel` 強制付与（`:79-93`）。描画点は `components/admin/MarkdownEditor.tsx:77` の1箇所のみで、`dangerouslySetInnerHTML` の全出現を grep 済（生 `body` の直接描画は**無し** → PT2-06 充足）。実挙動を独立ペイロードで検証しバイパス無しを確認（下記「サニタイザ実挙動検証」）。**ただし公開側の本文描画経路は未実装**のため、P3以降で公開ページを作る際に同関数を通すことを申し送る（SEC-020）。 |
| **SEC-002** | CSP 未設定 | Medium / P5対応予定 | **未解決（P5継続）** | `next.config.mjs:5-10` に `X-Content-Type-Options` / `X-Frame-Options: DENY` / `Referrer-Policy` / `Permissions-Policy` はあるが `Content-Security-Policy` / `Strict-Transport-Security` は無い。P2 で XSS 面（管理プレビューの `dangerouslySetInnerHTML`）が**実際に稼働した**ため、多層防御としての優先度は上がった。サニタイズが厳格に機能しているため単独では悪用経路なし。P5 のまま据え置くが、公開側の本文描画（P3以降）より前に入れることを推奨。 |
| **SEC-004** | 本番 `AUTH_SECRET` の強度を起動時検証 | Low / P2対応予定 | **未解決（P2で未実装）** | `lib/env.ts:25` は `AUTH_SECRET: z.string().min(1).optional()` のまま。本番判定も長さ下限も無い。P1 時点では「認証未実装のため実害なし」だったが、**P2 で JWT セッションが本番稼働可能になった**ため実害が生じうる状態に変わった。深刻度を **Low → Medium に引き上げ、SEC-013 として再掲**する。 |

---

## 確認できた良好な実装（Positive findings）

- **変更系 API の認可がハンドラ内で毎回検証されている（PT2-01 充足）**: `middleware.ts:19` の matcher は `/admin/:path*` のみで `/api/admin/*` を含まないが、`app/api/admin/news/route.ts:22,30` / `[id]/route.ts:33,56` / `save/route.ts:20-23` / `delete/route.ts:12-15` の**全ハンドラ**が個別に `auth()` を実行している。網羅性を grep で確認済み（管理APIで `auth()` 未実行のハンドラは無し）。
- **認可が存在確認より先に走る**: `app/api/admin/news/[id]/route.ts:33-37, 56-60` は 401 判定 → 404 判定の順。未認証者にリソースの存在有無を漏らさない。
- **パスワード照合が定数時間（PT2-05 充足）**: `lib/password.ts:42` は `crypto.timingSafeEqual` を使用（`===` ではない）。`:37,41` で長さ不一致を先に `false` にして `timingSafeEqual` の throw を回避、`:33` で hex 妥当性を事前検証（`Buffer.from` の黙示切り詰め対策）、`:43-45` で例外を握り潰し一律 `false`。実装は契約どおり。
- **ユーザー列挙耐性**: `auth.ts:31-36` はメール不在 / `passwordHash` 無し / 不一致を区別せず一律 `null`。UI 側も `app/admin/login/page.tsx:38` で汎用文言のみ（E-012-1 充足）。
- **SQLインジェクション面なし**: `$queryRaw` / `$executeRaw` / `*Unsafe` の使用は**リポジトリ全体でゼロ**。全て Prisma のパラメータ化クエリ。
- **入力バリデーションがサーバー側で再実行**: `lib/validators/news.ts` の zod 判別ユニオンを JSON API（`route.ts:39`, `[id]/route.ts:46`）とフォーム POST（`save/route.ts:42`）の**双方**が通す。`status` は enum 外を弾き（E-014-4）、`PUBLISHED` は `publishedAt` 必須（E-014-2）。`title` 100文字 / `body` 20000文字の上限もサーバー側で強制。
- **公開ステータスの信頼境界がサーバー側**: `save/route.ts:29-34` は押下ボタンの `intent` からサーバーが `status` を確定する。クライアントのラジオ値を無条件採用しない。
- **管理画面のインデックス抑止**: `app/admin/login/page.tsx:7` ほか全管理ページで `robots: { index: false, follow: false }`。
- **管理レイアウトの二重ガード**: `app/admin/(app)/layout.tsx:15` の `requireAdmin()` と `middleware.ts` の両方。`export const dynamic = 'force-dynamic'`（`layout.tsx:10`）でキャッシュ混線も回避。
- **セッションCookie属性**: Auth.js v5 既定で `httpOnly: true` / `sameSite: 'lax'` / `path: '/'`、`secure` は URL スキーム由来（`@auth/core/lib/utils/cookie.js:51-54`）。上書きしていないため既定の安全側。
- **ログイン CSRF**: `components/admin/LoginForm.tsx:24-32,37` が `/api/auth/csrf` の double-submit トークンを送出。認証エンドポイント自体は保護されている。
- **機密のログ出力なし**: `app/` `components/` `lib/` `auth*.ts` `middleware.ts` に `console.*` はゼロ。Prisma ログは本番 `['error']` のみ（`lib/db.ts:14`、SEC-007 の状態を維持）。
- **秘密のハードコードなし（アプリコード）**: `.env` は `.gitignore` 済み。`.env.example` は値を持たずキー名とコメントのみで妥当。

---

## サニタイザ実挙動検証（SEC-001 の検収）

`lib/markdown/renderSafe.ts` と同一構成のパイプラインに対し、ユニットテストに含まれない難読化系を含む **34ペイロード**を独立に投入し出力を確認した（監査用の使い捨てスクリプト。リポジトリには残していない）。

| 分類 | ペイロード例 | 結果 |
|------|------------|------|
| スクリプト実行 | `<script>` / `<SCRIPT>` / `<scr<script>ipt>` / `<template><script>` / `<math><annotation-xml>` 経由 | 全て**内容ごと除去**（`strip` が効いている） |
| イベントハンドラ | `<img onerror>` / `<svg onload>` / 許可要素上の `<p onclick>` | 属性・要素とも除去 |
| 危険スキーム | `javascript:` / `JaVaScRiPt:` / `java\tscript:` / `&#106;avascript:` / `data:text/html;base64,` / `vbscript:` | **href ごと除去**（`<a>` は残るがリンクしない） |
| 埋め込み | `<iframe>` / `<iframe srcdoc>` / `<object>` / `<embed>` / `<form>` / `<meta http-equiv=refresh>` / `<base>` | 全て除去 |
| スタイル | `<style>` タグ / `style` 属性 | 除去 |
| 属性上書き | `<a target="_self" rel="opener">` | `target="_blank" rel="nofollow noopener noreferrer"` に**強制上書き** |
| クロバリング | `<p id="x">` / `<a name="y">` | `id` / `name` とも除去 |
| 非許可ブロック | `<img>` / Markdown 表 / フェンスドコードブロック（PT2-04 関連） | `img`・表は非描画、コードブロックは `pre` なしの `code` へ縮退 |
| コメント | 条件付きコメント `<!--[if IE]>` | 除去 |

**バイパスは検出されなかった。** 設計上の逸脱（当初契約の rehype-raw 不使用 → 実装は `remark-rehype(allowDangerousHtml) → rehype-raw → rehype-sanitize`）については、**サニタイズがパイプライン最終段の唯一の信頼境界**として位置しており、むしろ `<script>` の本文テキスト残留を防げるため、監査上**妥当な判断として承認**する（`renderSafe.ts:16-22` の設計判断コメントも正確）。

---

## 発見事項

### [SEC-009] 管理者ログインに試行回数制御が無く、同期 scrypt により CPU DoS が増幅する
- **重大度**: **High**
- **カテゴリ**: 認証（ブルートフォース）/ 可用性
- **場所**: `auth.ts:28-39`（`authorize`）、`lib/password.ts:39`（`scryptSync`）、`lib/kv.ts:16-22`（レート制限は未実装のプレースホルダ）
- **説明**: `POST /api/auth/callback/credentials` は**未認証で無制限に叩ける**。レート制限・アカウントロックアウト・遅延・CAPTCHA のいずれも存在しない（`checkRateLimit` はリポジトリ内で**一度も呼ばれていない**）。管理者アカウントは実質1件（`prisma/seed.ts:507`）で、メールアドレスも `.env.example` の例示から推測されうるため、探索対象はパスワード1次元に縮退している。
  さらに `verifyPassword` は **同期 API の `scryptSync`** を使う。Node の scrypt 既定パラメータ（N=16384, r=8）は1回あたり概ね数十ms の CPU を消費し、**同期版は Node のイベントループを丸ごとブロックする**。したがって同一エンドポイントへの並行リクエストは、認証突破を狙わずとも**公開サイト全体の応答不能（DoS）**を引き起こす。
- **影響**: (1) 弱いパスワードならオフライン相当の速度で総当たりされ、CMS の全権（お知らせの改ざん・公開）を奪われる。(2) 認証を突破しなくても、少数の並行 POST でサイト全体を停止させられる。
- **攻撃シナリオ**:
  1. 攻撃者は `/admin/login` から `csrfToken` を取得（公開エンドポイント `/api/auth/csrf`）。
  2. `POST /api/auth/callback/credentials` に `email=admin@…&password=<候補>&csrfToken=…` を繰り返し送る。応答は成否で明確に分岐（成功=`/admin` へ 302 / 失敗=`/admin/login?error=` へ 302）し、**回数制限もロックアウトも発生しない**。
  3. 並行して数十本の同リクエストを維持するだけで、`scryptSync` がイベントループを占有し、公開トップ（`/`）を含む全リクエストがタイムアウトする。
- **修正方針**:
  1. **試行回数制御を必須化**。`lib/kv.ts` の `checkRateLimit` を実装し（Vercel KV / Upstash）、`authorize` の先頭で `credentials:<ip>` と `credentials:<email>` の2軸で評価する。目安: IP あたり 10回/10分、アカウントあたり 5回失敗で 15分ロック。閾値超過は資格情報の正誤を問わず一律失敗（列挙耐性を維持）。
  2. **`scryptSync` → 非同期 `scrypt` へ置換**（`node:crypto` の callback 版を `promisify`）。`verifyPassword` を `Promise<boolean>` にし、`authorize` は既に async なので呼び出し側の変更は最小。イベントループのブロックを解消する。あわせて `maxmem` を明示し、パラメータを定数化する。
  3. 失敗ログ（IP・時刻・試行回数のみ。**パスワードとメールアドレス全文は記録しない**）を残し、異常検知の足がかりを作る。
- **参考**: OWASP A07:2021 Identification and Authentication Failures / CWE-307（Improper Restriction of Excessive Authentication Attempts）/ CWE-400（Uncontrolled Resource Consumption）
- **関連**: PT2-01（テスト側は「未認証の 401」までは追跡しているが、試行回数は対象外）

---

### [SEC-010] 公開トップの最新お知らせが `publishedAt` の時刻ゲートを欠き、予約公開の記事が先出しで漏洩する
- **重大度**: Medium
- **カテゴリ**: 認可 / 情報漏洩（アクセス制御の不備）
- **場所**: `lib/queries.ts:39-45`（`getLatestNews`）、呼び出し元 `app/(public)/page.tsx:36`
- **説明**: 公開トップが実際に使うクエリは以下で、**`status: 'PUBLISHED'` のみを条件にしており `publishedAt <= now()` の時刻ゲートが無い**。

  ```ts
  // lib/queries.ts:39-45
  export async function getLatestNews(take = 3) {
    return prisma.news.findMany({
      where: { status: 'PUBLISHED' },      // ← publishedAt の時刻条件が無い
      orderBy: { publishedAt: 'desc' },
      take,
    })
  }
  ```

  一方、正しく時刻ゲートを持つ実装 `listPublishedNews`（`lib/news-admin.ts:114-120`, `where: { status: 'PUBLISHED', publishedAt: { lte: new Date() } }`）は**公開ページから一度も呼ばれていない**（呼び出し元は結合テストのみ）。
  結果として、`docs/functional-spec.md` §F-004 と本レポートの前提である「公開サイトは `publishedAt <= now()` のみ」は**公開経路で成立していない**。
- **影響**: 管理者が未来日時を設定して「公開」保存した予約記事（キャンペーン告知・休業案内など、公表日が決まっている情報）が、**予定日より前にトップページへ露出する**。`publishedAt` が `null` のまま `PUBLISHED` になったレコードも同様に露出しうる（`orderBy` で null が先頭に来る可能性もある）。
- **攻撃シナリオ**: 攻撃者操作ではなく**運用上の情報漏洩**。管理者が「7/1公開」で予約投稿 → 6/20 に公開トップを見た第三者が未公表のキャンペーン内容を取得できる。競合・報道等への事前流出、および「予約公開」機能への信頼喪失につながる。
- **なぜテストで検出できなかったか**: `tests/integration/news-admin.int.ts:127-149`（PT2-02）は未来日除外を検証しているが、**検証対象が `listPublishedNews` であり、公開ページが使う `getLatestNews` ではない**。テストがグリーンでも公開経路は守られていない、典型的な「テスト対象取り違え」。
- **修正方針**:
  1. `getLatestNews` に `publishedAt: { lte: new Date() }` を追加する。または `lib/queries.ts` の実装を `listPublishedNews` へ委譲し、**公開側 News クエリの真実源を1つに統合**する（推奨。二重実装が今回の原因）。
  2. 結合テストを**公開ページが実際に呼ぶ関数**に対して追加する（`getLatestNews` の未来日除外・`publishedAt: null` 除外）。
  3. `publishedAt` が `null` の `PUBLISHED` レコードを構造的に排除できないか検討する（アプリ層検証は `validators/news.ts` にあるが、DB 制約は無い）。
- **参考**: OWASP A01:2021 Broken Access Control / CWE-200（Exposure of Sensitive Information to an Unauthorized Actor）

---

### [SEC-011] 変更系フォームエンドポイントに CSRF トークン / Origin 検証が無く、Cookie の SameSite 既定にのみ依存している
- **重大度**: Medium
- **カテゴリ**: CSRF
- **場所**: `app/api/admin/news/save/route.ts:19-25`、`app/api/admin/news/delete/route.ts:11-18`、送信側 `components/admin/NewsForm.tsx:52-57`、`components/admin/ConfirmDialog.tsx:75`
- **説明**: 管理UI は Server Action ではなく**ネイティブ form POST** を採用している（E2E の確実なコミットのための設計判断で、それ自体は妥当）。しかし Server Action が自動で持つ CSRF 保護（Next.js による Origin/Host 照合）を捨てた代償として、これらのエンドポイントは以下を**一切検証していない**。
  - CSRF トークン（ログインフォームは `LoginForm.tsx:37` で送っているが、save/delete のフォームには hidden トークンが無い）
  - `Origin` / `Sec-Fetch-Site` ヘッダ
  - `Referer`

  検証しているのはセッションの有無のみ（`save/route.ts:20-23`）。現状の防御は **Auth.js セッション Cookie の `sameSite: 'lax'`（`@auth/core/lib/utils/cookie.js:52`）というライブラリ既定**だけであり、クロスサイトの form POST では Cookie が送られないため**現時点では実害に至らない**。
- **影響**: 防御が「気付かれていない暗黙の前提」の上に立っている。以下のいずれかで即座に破れる。
  - 将来 `cookies.sessionToken.options.sameSite` を `'none'` に変更した場合（別ドメイン埋め込み・プレビュー環境対応などで起こりうる）
  - 同一サイト（サブドメイン）に XSS や任意コンテンツ配置が発生した場合（`SameSite=Lax` は同一サイト扱いのため Cookie が送られる）
  - 攻撃者がユーザーをトップレベル GET ナビゲーションで誘導できる経路が生まれた場合
  成立時の影響は、管理者がログイン済みの状態で罠ページを開くと**お知らせの改ざん・削除・不正公開**が実行される。
- **攻撃シナリオ**（`sameSite` を緩めた場合、または同一サイト起点）:
  ```html
  <form method="post" action="https://example.com/api/admin/news/delete">
    <input type="hidden" name="id" value="<記事ID>">
  </form>
  <script>document.forms[0].submit()</script>
  ```
  記事IDは管理一覧の DOM（`app/admin/(app)/news/page.tsx:105` の `data-news-id`）や編集URLから既知になりうる。
- **修正方針**:
  1. `save` / `delete` の各ハンドラ先頭で **Origin 検証**を行う。`request.headers.get('origin')` が自ホスト（`new URL(request.url).origin`）と一致しない POST は 403 で拒否する。同一オリジンのネイティブ form POST では `Origin` が必ず付くため、正規フローを壊さない。低コストで最も効果が高い。
  2. あわせて `Sec-Fetch-Site: same-origin` の確認、または `csrfToken` hidden フィールドの double-submit を追加する（多層防御）。
  3. セッション Cookie の `sameSite` を**明示的に `'lax'` として `auth.config.ts` に固定**し、既定値への暗黙依存をコード上の意思決定に変える。
- **参考**: OWASP A01:2021 / CWE-352（Cross-Site Request Forgery）
- **関連**: PT2-01 の改善案(b)「認証済みだが CSRF/セッション不正のケース」に対応する実装側の指摘

---

### [SEC-012] seed の管理者パスワードにハードコードのフォールバックがあり、本番実行ガードも無い
- **重大度**: Medium
- **カテゴリ**: シークレット管理 / 認証
- **場所**: `prisma/seed.ts:507-509`、`prisma/seed.ts:516-546`
- **説明**: 管理者資格情報が環境変数未設定時に**リポジトリ内の既知値へ静かにフォールバック**する。

  ```ts
  // prisma/seed.ts:507-509
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@iwataki-driving-school.demo'
  const ADMIN_NAME  = process.env.ADMIN_NAME ?? 'デモ管理者'
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin_dev_pw'
  ```

  `.env` が読めない・キーを設定し忘れた状態で `pnpm db:seed` を実行すると、**警告もエラーも出さずに**既知のメールアドレスと既知のパスワードを持つ ADMIN が `upsert` される。`upsert` の `update` 節（`:539`）は**既存管理者のパスワードも上書きする**ため、正しく運用されていた管理者アカウントを既知パスワードへ降格させうる。
  加えて `main()` 冒頭（`:516-522`）は `Course` / `News` / `Faq` / `SupplementalChatRule` を `deleteMany()` で全削除する。`NODE_ENV` や接続先 DB のガードは無く、本番 DB へ向いた環境で実行すると**公開コンテンツを全消去**する。
- **影響**: 運用ミス1回で「既知資格情報による管理画面フル権限の奪取」と「公開コンテンツの全損」が同時に成立する。SEC-009（試行回数制御なし）と組み合わさると、既知パスワードの存在は致命度が上がる。
- **攻撃シナリオ**: 直接の攻撃者操作ではなく**運用事故起点**。デモ環境を外部公開し、環境変数を設定せずに seed した時点で、リポジトリを読める者は誰でも管理画面にログインできる。
- **修正方針**:
  1. **フォールバックを廃止**し、`ADMIN_EMAIL` / `ADMIN_PASSWORD` 未設定なら明示的に `throw` して seed を中断する（fail-fast）。
  2. `process.env.NODE_ENV === 'production'` では、明示的なオプトイン環境変数（例 `ALLOW_PROD_SEED=1`）が無い限り**実行を拒否**する。`deleteMany()` の破壊性を考えると必須。
  3. 既存管理者のパスワードを黙って上書きしないよう、`upsert` の `update` 節から `passwordHash` を外す（初回 `create` のみ設定。ローテーションは別コマンドに分離）。
  4. `.env.example` の `ADMIN_PASSWORD` 行に「本番不可・推測困難な値を必須」の注記を追加する（現状はコメントに「開発専用・本番不可」とあり方向性は正しいので補強のみ）。
- **参考**: OWASP A07:2021 / CWE-798（Use of Hard-coded Credentials）/ CWE-1188（Insecure Default Initialization）
- **関連**: P1 の SEC-003（`.env` 平文資格情報, Low）。P2 で認証が稼働したため、同じ既知値のリスクが上がっている。

---

### [SEC-013] 本番 `AUTH_SECRET` の強度検証が未実装のまま（SEC-004 の未解決分）
- **重大度**: Medium（P1 では Low。認証稼働により引き上げ）
- **カテゴリ**: 認証（セッション署名）
- **場所**: `lib/env.ts:25`、`auth.config.ts:17`（`session: { strategy: 'jwt' }`）
- **説明**: SEC-004 は「F-012 実装時（＝P2）に本番で 32byte 以上を起動時検証する」としていたが、**P2 完了時点で未実装**。`lib/env.ts:25` は依然として以下のとおり。

  ```ts
  AUTH_SECRET: z.string().min(1).optional(),
  ```

  本番/開発の区別も長さ下限も無く、`getServerEnv()` はアプリの起動経路（`auth.ts` / `middleware.ts`）から**そもそも呼ばれていない**。P1 では `providers: []` で認証が動いていなかったため実害なしと判定できたが、P2 で JWT セッションが実稼働に入ったため前提が変わった。
- **影響**: 弱い / 短い / 開発用プレースホルダのままの署名鍵で本番デプロイされると、**セッション JWT を攻撃者が偽造でき、認証を完全にバイパスして CMS の全権を得る**。ログイン試行すら不要になるため、SEC-009 より影響は大きい（実現条件が運用ミス依存のため深刻度は Medium に留める）。
- **攻撃シナリオ**: `AUTH_SECRET` が推測可能（辞書的なプレースホルダ、短い文字列）な状態で公開デプロイ → 攻撃者が同じ鍵で `authjs.session-token` を自作 → `/admin/**` へ認証済みとしてアクセス。`middleware.ts` も `auth.ts` も署名検証のみで、追加の照合は無い。
- **修正方針**:
  1. `serverEnvSchema` を本番で厳格化する。例:
     ```ts
     AUTH_SECRET: process.env.NODE_ENV === 'production'
       ? z.string().min(32, 'AUTH_SECRET は 32 文字以上が必要です')
       : z.string().min(1).optional(),
     ```
     （デモ/ローカルは現状維持で開発を止めない）
  2. **アプリ起動経路から実際に検証を走らせる**。現状 `getServerEnv()` は呼び出し元が無いため、スキーマを厳しくしても発火しない。`auth.ts` の import 時など Node ランタイムの入口で1度評価する（`middleware.ts` は Edge のため対象外にする）。
  3. `.env.example:23` は `openssl rand -base64 32` を案内済みで妥当。ドキュメント側の追加対応は不要。
- **参考**: OWASP A02:2021 Cryptographic Failures / A07:2021 / CWE-1188 / CWE-330（Use of Insufficiently Random Values）

---

### [SEC-014] 存在しない ID への保存 / 削除が未捕捉の Prisma 例外となり 500 を返す
- **重大度**: Low
- **カテゴリ**: エラーハンドリング / 情報漏洩
- **場所**: `app/api/admin/news/save/route.ts:55-59`、`app/api/admin/news/delete/route.ts:19-22`、`lib/news-admin.ts:101, 107`
- **説明**: JSON API 側（`[id]/route.ts:36-37, 59-60`）は `getNewsById` で存在確認して 404 を返すが、**フォーム POST 側の `save` / `delete` は存在確認をしない**。`prisma.news.update` / `delete` は対象が無いと `P2025` を throw し、ハンドラに try/catch が無いため未捕捉のまま 500 になる。`delete/route.ts:19` の `if (id)` は空文字を弾くだけで、存在確認ではない。
- **影響**: 実行者は認証済み管理者に限られるため機密漏洩の直接経路ではない。ただし (1) 同一記事を2タブで開いて片方から削除した後にもう片方で保存する、といった正常運用で 500 が発生する（可用性・UX）、(2) 開発モードでは Prisma のエラー詳細（モデル名・操作）がレスポンスに露出しうる。本番では Next.js がメッセージをマスクするため情報漏洩は限定的。
- **修正方針**: `save` / `delete` でも先に `getNewsById(id)` で存在確認し、無ければ `/admin/news?error=notfound` へ 303 リダイレクト（フォーム UI に合わせた挙動）とする。あわせて `try/catch` で Prisma 例外を捕捉し、汎用エラーへ写像する。JSON API 側と同じ「認可 → 存在確認 → 検証 → 実行」の順序に揃えると一貫する。
- **参考**: CWE-209（Generation of Error Message Containing Sensitive Information）/ CWE-755（Improper Handling of Exceptional Conditions）

---

### [SEC-015] 管理セッションの有効期限が Auth.js 既定（30日）のままで、明示設定もローテーションも無い
- **重大度**: Low
- **カテゴリ**: セッション管理
- **場所**: `auth.config.ts:17`（`session: { strategy: 'jwt' }`）
- **説明**: `session.maxAge` / `updateAge` を指定していないため、Auth.js 既定の **30日アイドル有効**（`@auth/core/lib/init.js:38`）が適用される。CMS 管理者セッションとしては長い。また `jwt` ストラテジのため**サーバー側にセッションストアが無く、ログアウトや侵害検知時に既発行トークンを即時失効させる手段が無い**（`signOut` は Cookie を消すのみで、コピーされたトークンは満了まで有効）。`docs/functional-spec.md` の E-012-3「セッション切れ」も具体的な期限を定めていない。
- **影響**: 共用端末や Cookie 窃取時に、攻撃者が最大30日間 CMS の全権を保持できる。
- **修正方針**:
  1. `auth.config.ts` に管理用途相応の期限を明示する。例: `session: { strategy: 'jwt', maxAge: 60 * 60 * 8, updateAge: 60 * 15 }`（8時間・15分ごとに更新）。
  2. あわせて `sameSite` / `secure` も明示指定し、既定値への暗黙依存をなくす（SEC-011 の修正方針3と共通）。
  3. 即時失効が要件になる場合は `strategy: 'database'` かトークン版数（`AdminUser` に `tokenVersion`）による無効化を検討する。デモ範囲では 1. のみで十分。
  4. 仕様側（F-012 E-012-3）に採用値を明記し、Spec Agent へ反映を依頼する。
- **参考**: OWASP A07:2021 / CWE-613（Insufficient Session Expiration）

---

### [SEC-016] `trustHost: true` により Host ヘッダを無条件に信頼している
- **重大度**: Low
- **カテゴリ**: 設定 / データ保護
- **場所**: `auth.config.ts:16`
- **説明**: `trustHost: true` により、Auth.js は**リクエストの `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` からオリジンを算出**する。これは2つの派生を持つ。
  1. **Cookie の `secure` 属性がスキーム判定由来**（`@auth/core/lib/init.js:69` → `url.protocol === 'https:'`）。TLS 終端プロキシが `X-Forwarded-Proto: https` を付けずに転送する構成だと `secure: false` となり、セッション Cookie が平文経路にも載りうる。
  2. リダイレクト基点（`callbackUrl` の解決）が Host 由来になるため、`Host: evil.example` を通すプロキシ構成では認証後に攻撃者オリジンへ誘導されうる（トークンは自ドメイン Cookie に留まるため漏洩はしないが、フィッシング動線になる）。

  Vercel など Host を正規化するプラットフォームでは問題にならず、`auth.config.ts:14-15` のコメントどおり `next start` 運用では `trustHost` 自体は必要な設定である（未設定だと本番で認証が通らない）。したがって**設定の誤りではなく、デプロイ側の前提が文書化されていない**ことが指摘点。
- **影響**: 前提を満たさないリバースプロキシ構成でデプロイした場合に限り、セッション Cookie の平文送信またはフィッシング誘導。
- **修正方針**:
  1. 本番は `AUTH_URL`（または `NEXTAUTH_URL`）に正規のオリジンを明示設定し、Host 由来の推定に頼らない。
  2. リバースプロキシ側で `Host` を自ドメインに固定し、`X-Forwarded-Proto: https` を必ず付与する。この2点をデプロイ手順書（`docs/tech-stack.md` §4）に明記する。
  3. `useSecureCookies: process.env.NODE_ENV === 'production'` を明示指定すれば、スキーム誤判定時も `secure` が落ちない（推奨）。
- **参考**: CWE-644（Improper Neutralization of HTTP Headers）/ OWASP A05:2021 Security Misconfiguration

---

### [SEC-017] 依存関係に既知脆弱性（Critical 1 / High 5 / Moderate 4）— いずれもビルド・開発ツールチェーン
- **重大度**: Low（本番実行時の悪用経路は現時点で無し）
- **カテゴリ**: 依存関係
- **場所**: `package.json` / `pnpm-lock.yaml`（`pnpm audit` 実行結果, 2026-07-28）
- **説明**:

  | 深刻度 | パッケージ | 経路 | 内容 | 修正版 |
  |--------|-----------|------|------|--------|
  | critical | vitest `<3.2.6` | `.>vitest` | Vitest UI サーバー起動時に任意ファイル読み取り・実行 | `>=3.2.6` |
  | high | vite `<=6.4.2` | `.>vitest>vite` | Windows 代替パスでの `server.fs.deny` バイパス | `>=6.4.3` |
  | high | postcss `<=8.5.11` | `.>next>postcss` | 任意ファイル読み取り・情報漏洩 | `>=8.5.12` |
  | high | postcss `<=8.5.17` | `.>next>postcss` | sourceMappingURL 自動読込のパストラバーサル | `>=8.5.18` |
  | high | sharp `<0.35.0` | `.>next>sharp` | libvips 由来の脆弱性（CVE-2026-33327 ほか） | `>=0.35.0` |
  | high | brace-expansion `<=5.0.7` | `.>eslint>minimatch>…` | 展開長無制限による OOM (DoS) | `>=5.0.8` |
  | moderate | esbuild / vite / postcss ほか 4件 | dev 依存 | 開発サーバー系 | — |

  **critical / high の全件が dev・ビルド時依存**（vitest / vite / esbuild / eslint 系）か、Next.js の推移依存（postcss = ビルド時 CSS 処理、sharp = 画像最適化）である。本アプリは `next/image` を使用しておらず、`postcss` はビルド時のみ動作するため、**実行時に攻撃者入力が到達する経路は現時点で存在しない**。ただし CI が信頼できない入力（外部PRのブランチ等）でテストを走らせる構成になると、vitest の critical は実害になりうる。
- **修正方針**:
  1. `pnpm update vitest@^3.2.6` を適用（メジャー跨ぎのため `vitest.config.ts` / `vitest.integration.config.ts` の互換確認とテスト全実行をセットで）。
  2. `pnpm.overrides` で `postcss` / `brace-expansion` / `sharp` を修正版に固定する（Next.js 本体の更新を待たずに解消できる）。
  3. **`pnpm audit` を CI に組み込む**（P1 の SEC-006 が同趣旨で未対応のまま）。`--audit-level=high` で失敗させ、dev 依存の既知脆弱性が放置されない状態にする。`.github/workflows/ci.yml` への追加を推奨。
- **参考**: OWASP A06:2021 Vulnerable and Outdated Components
- **関連**: P1 SEC-006（CI への脆弱性スキャン組み込み）が**未対応のまま**であることを再掲する。

---

### [SEC-018] サニタイザが相対 / プロトコル相対 URL の `href` を通過させる
- **重大度**: Info
- **カテゴリ**: XSS / フロントエンド
- **場所**: `lib/markdown/renderSafe.ts:61-63`（`protocols.href`）
- **説明**: `protocols` によるスキーム制限は**スキームが存在する URL にのみ適用**される。実挙動検証の結果、`<a href="/admin">` と `<a href="//evil.example">`（プロトコル相対）は `href` を保ったまま出力された。前者は自サイト内リンクで無害だが、後者は**外部サイトへのリンクが `http:`/`https:` を書かずに作れる**ことを意味する。
- **影響**: 本文を書けるのは認証済み管理者のみであり、そもそも `https://evil.example` と直接書けるため、**新たな権限昇格や XSS には当たらない**。`target="_blank" rel="nofollow noopener noreferrer"` は強制付与されており reverse tabnabbing も無い。ホワイトリストの意図（許可スキームのみ）と実挙動の差分として記録する。
- **修正方針**: 任意。厳密に閉じるなら、`forceSafeLinkAttrs` と同じ前段 transformer で `href` が `/`（単一スラッシュ、`//` は除く）・`#`・許可スキームのいずれでもない場合に `href` を落とす。将来 News 本文を**管理者以外**が編集できるようにする場合は必須化すること。
- **参考**: CWE-601（URL Redirection to Untrusted Site）

---

### [SEC-019] 管理API の実装が仕様（F-014 API仕様）から乖離している
- **重大度**: Info
- **カテゴリ**: 仕様整合（攻撃面の把握）
- **場所**: `app/api/admin/news/[id]/route.ts`、`app/api/admin/news/route.ts:22-26`、`docs/functional-spec.md` F-014「API仕様」
- **説明**: 仕様は `GET /api/admin/news/[id]`（取得）と `GET /api/admin/news?status=`（絞り込み）を定義するが、実装では前者が存在せず（`PUT` / `DELETE` のみ）、後者はクエリを読まず `listAdminNews()` を引数なしで呼ぶ（`route.ts:24`）。あわせて、仕様に無い `POST /api/admin/news/save` と `POST /api/admin/news/delete`（フォーム用）が追加されている。
- **影響**: セキュリティ上の直接の欠陥ではない。ただし**仕様書の API 一覧が攻撃面の一覧として使えない**状態であり、今後の監査・ペネトレーションテストのスコープ定義を誤らせる。フォーム用2本は認証・CSRF の扱いが JSON API と異なる（SEC-011）ため、仕様に載っていないことのリスクは実質的。
- **修正方針**: Spec Agent に依頼し、F-014 の API 仕様へ `save` / `delete` を追記（認証・CSRF 要件を含む）、実装しない `GET /[id]` と未対応の `?status=` は仕様から削除または「未実装」と明記する。実装と仕様のどちらへ寄せるかは Senior Engineer の判断に委ねる。

---

### [SEC-020] サニタイズがクライアントバンドル側でのみ実行されており、公開側のサーバー描画経路が未整備
- **重大度**: Info（申し送り）
- **カテゴリ**: XSS（設計）
- **場所**: `components/admin/MarkdownEditor.tsx:1,4,77`（`'use client'` から `renderSafe` を import）
- **説明**: 現時点で `renderMarkdown` を呼ぶ唯一の箇所が **client component** であるため、サニタイズパイプライン（unified / remark / rehype 一式）は**クライアントバンドルに含まれ、ブラウザ上で実行される**。管理者自身のプレビュー用途としては機能しており、記述者＝閲覧者のため実害は無い。
- **影響**: 現状なし。ただし P3 以降で公開側のお知らせ詳細ページ（F-005）を実装する際に、**同じ関数を Server Component から呼ぶ**ことを徹底しないと、サニタイズ前の本文が一瞬でも DOM に載る／クライアント実行に依存した描画になる余地が残る。SEC-002（CSP 未設定）と重なると、万一のサニタイズ漏れに対する二段目の防御が無い状態になる。
- **修正方針**（P3以降の実装時に必須）:
  1. 公開側の本文描画は **Server Component で `renderMarkdown` を呼び**、サニタイズ済み文字列のみを `dangerouslySetInnerHTML` に渡す。生 `body` を client component の props へ渡さない。
  2. 公開描画経路を追加した時点で、`dangerouslySetInnerHTML` の全出現に対する grep 確認（PT2-06 の運用担保）を再実施する。
  3. あわせて SEC-002（CSP）を投入し、`script-src` を絞る。
  4. 副次的に、プレビューをサーバー側（Server Action / Route Handler）へ寄せればクライアントバンドルからも markdown 一式を外せる（性能面の改善。セキュリティ要件ではない）。

---

## 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **1**（SEC-009） |
| Medium | 4（SEC-010 / SEC-011 / SEC-012 / SEC-013）＋ 繰越 SEC-002 |
| Low | 4（SEC-014 / SEC-015 / SEC-016 / SEC-017） |
| Info | 3（SEC-018 / SEC-019 / SEC-020） |

**判定: リリースブロッカー 1件（SEC-009）。** 監査スキルの基準（Critical/High が1件でもあればリリースをブロック）に従い、**SEC-009 の解消を P2 完了条件とする**ことを推奨する。

設計・実装の骨格は良好である。特に「middleware に依存せず全ハンドラで `auth()` を再検証」（PT2-01 の懸念に対する正しい実装）、`timingSafeEqual` による定数時間比較（PT2-05）、単一描画経路の徹底（PT2-06）は、テスト側レビューが挙げた3つのセキュリティ懸念すべてに実装が応えている。サニタイザは 34 ペイロードの実挙動検証でバイパスを検出せず、SEC-001 は解決済みと判定した。

一方、**未解決の申し送りが P2 で回収されなかった点は追跡が必要**である。SEC-004（→ SEC-013）は「P2 で対応」とされながら `lib/env.ts` に変更が入っておらず、SEC-006（CI への `pnpm audit` 組み込み）も未対応のまま SEC-017 として再浮上した。申し送り事項の消化を Phase の完了条件に含める運用を推奨する。

また SEC-010 は、**テストがグリーンでも公開経路が守られていない**類型（テスト対象の取り違え）であり、単体・結合テストの通過を安全性の根拠にできない実例として重要である。修正時は必ず「公開ページが実際に呼ぶ関数」に対するテストを追加すること。

### 是正の優先順位

1. **SEC-009**（High / リリースブロッカー）— レート制限の実装＋`scryptSync` の非同期化
2. **SEC-010**（Medium）— 公開クエリの時刻ゲート統合。修正コストは数行で、情報漏洩の実害があるため実質最優先
3. **SEC-011 / SEC-013**（Medium）— Origin 検証の追加、`AUTH_SECRET` の本番検証。いずれも小規模
4. **SEC-012**（Medium）— seed の fail-fast 化と本番ガード
5. **SEC-014 〜 SEC-017**（Low）— 計画的に対応。SEC-017 の CI 組み込みは P3 前に入れると以後の回帰を防げる

---

## P3（入所申込フォーム F-008/F-009/F-010）への事前セキュリティ要件申し送り

P3 は**個人情報（氏名・生年月日・住所・連絡先）と免許証写真（機微個人情報）**を扱う。P2 までとは情報資産の質が変わるため、以下を**実装着手前の設計要件**として確定させること。P1 の申し送りを引き継ぎつつ、P2 の監査結果を踏まえて具体化した。

### A. 認証不要エンドポイントの保護（SEC-009 と共通基盤）
- `POST /api/applications` / `POST /api/uploads/license` / `POST /api/chat` はいずれも**未認証で叩ける**。`lib/kv.ts` の `checkRateLimit` を SEC-009 の対応として実装し、**P3 でも同じ基盤を再利用**する。P3 で初めて実装するのではなく、SEC-009 の修正時に汎用化しておくこと。
- Turnstile / hCaptcha のサーバー側検証（`TURNSTILE_SECRET`）を必須化する。クライアント側トークンの存在確認だけで通さない。ハニーポットフィールドを併用する。
- `idempotencyKey`（`prisma/schema.prisma:179` で unique 済み）による重複送信排除を、**サーバー生成ではなくクライアント提供値**にする場合は、値の予測可能性が他者の申込を妨害しないことを確認する。

### B. CSRF（SEC-011 の教訓）
- P3 のフォームも同じネイティブ form POST パターンを採る場合、**SEC-011 の Origin 検証を最初から入れる**こと。P2 のように「SameSite の既定に暗黙依存」の状態で個人情報の受信口を作らない。
- Server Action を使う場合は Next.js 標準の CSRF 保護が効くため、どちらの方式を採るかを設計時に明示的に決定し、理由を記録する。

### C. ファイルアップロード（F-009 / F-018）
- `objectKey` は**必ずサーバー生成**（REV-004）。クライアント指定値をキーに使わない（パストラバーサル・他者オブジェクト上書き）。
- `contentType` は許可リスト（`image/jpeg` / `image/png` / `image/heic` 等）で検証し、**拡張子と宣言 Content-Type を信用せず、マジックバイトで実体を確認**する。サイズ上限をサーバー側で強制（`UploadToken.maxSize` を実際に検証すること）。
- 署名付き URL は**短期失効**（発行 5分以内目安）かつ `UploadToken.consumed` による**単回使用**を実際に強制する。スキーマに列があるだけでは不十分。
- バケットは**非公開**。免許証写真の公開 URL を DB にもレスポンスにも一切載せない（`LicensePhoto` は `objectKey` のみ保持する設計を維持）。
- 管理側閲覧（F-018）は **IDOR に最も注意すべき箇所**。`applicationId` / `photoId` を URL で受け取る全経路で、`auth()` による認証に加え「その管理者が閲覧してよい対象か」を毎回サーバーで判定する。P2 の News は単一ロール・全件共有だったため IDOR 面が実質存在しなかったが、**P3 は他人の身分証明書が対象**であり性質が根本的に異なる。
- アップロード直後〜申込紐付け前の orphan オブジェクトを回収するバッチを設計する（放置された身分証画像を残さない）。

### D. 個人情報の取り扱い
- **ログに PII を出さない**。氏名・生年月日・住所・電話・メール・`objectKey` を `console.*` / エラーログ / Prisma クエリログに載せない。P2 時点でアプリコードの `console.*` はゼロ（良好）なので、この状態を維持する。
- 自動返信メール（`lib/mail.ts`）の本文に個人情報を過剰記載しない。受付番号と最小限の情報に留める（`ApplicationReceiptMail` の型がすでにその設計）。
- エラーレスポンスに入力値をエコーバックしない（バリデーションエラーは**フィールド名とメッセージのみ**。`lib/validators/news.ts:94-108` の方式は良い前例なので踏襲する）。
- APPI 対応として、削除要求時に **DB レコードと Blob オブジェクトの両方**を消す経路を設計に含める。
- 保持期間（申込データ・写真をいつまで保持するか）を業務仕様として確定させ、Spec Agent に反映を依頼する。

### E. 前提として先に片付けるべき P2 の残件
- **SEC-009**（レート制限基盤）— P3 の A. が依存する。**P3 着手前に必須**。
- **SEC-013**（`AUTH_SECRET` 検証）— 管理画面が個人情報にアクセスするようになるため、セッション偽造の影響が「お知らせ改ざん」から「個人情報の閲覧」に跳ね上がる。**P3 着手前に必須**。
- **SEC-002**（CSP）— 個人情報を入力するフォームページで XSS が成立した場合の被害が大きい。P5 予定を**P3 と同時**へ前倒しすることを強く推奨する。
- **SEC-011**（Origin 検証）/ **SEC-012**（seed のガード）— P3 のフォーム実装と同じパターンを使うため、先に型を作っておくと横展開できる。

---
---

# Phase 2 再監査（2026-07-28）

## 監査日: 2026-07-28
## 対象: P2 差し戻し修正（SEC-009 / SEC-010 / SEC-011 / SEC-012 / SEC-013 の是正）の検収

対象ファイル（実コードを読んで検証。実装ノートの記述は根拠として採用しない）:
`lib/rate-limit.ts`（新規）/ `lib/http-guard.ts`（新規）/ `lib/news-visibility.ts`（新規）/ `lib/seed-guard.ts`（新規）/
`auth.ts` / `auth.config.ts` / `lib/password.ts` / `lib/env.ts` / `lib/queries.ts` / `lib/news-admin.ts` /
`app/api/admin/news/save/route.ts` / `delete/route.ts` / `route.ts` / `[id]/route.ts` / `prisma/seed.ts` /
`.env` / `.env.example` / `next.config.mjs` / `middleware.ts` / `node_modules/@auth/core`（authorize 呼び出し規約の確認）

参照: `docs/p2-fix-plan-2026-07-28.md` / `docs/impl-p2fix-notes-2026-07-28.md` / `docs/review-p2-code-2026-07-28.md`（RV-P2-001/002/004/005）/ 本レポート Phase 2 監査セクション

品質ゲート実測値はオーケストレーターが独立実行済み（unit 118 / integration 28 / e2e 73 全パス、type-check・lint クリーン、build 成功、テストファイルの改竄なし）。本監査では再実行せず、**テストの網羅範囲そのもの**を評価対象にした。

---

## サマリー

| レベル | 件数 | 該当ID |
|--------|------|--------|
| **Critical** | **0** | — |
| **High** | **0** | —（SEC-009 のブロッカー要件は解消） |
| Medium | 4（新規）| SEC-021 / SEC-022 / SEC-023 / SEC-024 ＋ 繰越 SEC-002 |
| Low | 3（新規）| SEC-025 / SEC-026 / SEC-027 ＋ 繰越 SEC-014〜SEC-017 |
| Info | 1（新規）| SEC-028 ＋ 繰越 SEC-018〜SEC-020 |

**総合判定: P2 はリリース可能（Critical 0 / High 0）。** ただし後述のとおり **SEC-009 は「部分解決」**であり、
**是正そのものが新たな可用性欠陥（SEC-021）と制御バイパス（SEC-022）を持ち込んでいる**。
P3 着手前の必須要件は**未達のまま**（§F 参照）。

---

## A. 是正のクローズ判定

| ID | 深刻度 | 判定 | 根拠（file:line） | 検証方法 |
|----|--------|------|------------------|---------|
| **SEC-009** | High | **部分解決** | `lib/password.ts:26-30,53`（`promisify(scrypt)`。同期版は残存せず、`scryptSync` の残りは `prisma/seed.ts:52` の CLI のみ＝イベントループ非関与）/ `auth.ts:83-97,107`（2軸レート制限が authorize 内で実際に発火）| grep で `scryptSync` の全出現を列挙。`@auth/core` の authorize 呼び出し規約を実コードで確認（後述 A-1）。バイパス経路を探索（A-2）|
| **SEC-010** | Medium | **解決済み** | `lib/news-visibility.ts:22-27`（述語の単一真実源）/ `lib/queries.ts:44-50` / `lib/news-admin.ts:117-123` | 公開経路の全 News クエリを grep で列挙し、`getLatestNews` が唯一の公開消費点であることを確認（A-3）|
| **SEC-011** | Medium | **部分解決** | `lib/http-guard.ts:23-32` / `save/route.ts:24-26` / `delete/route.ts:14-16`（form POST 2本は解決）↔ `app/api/admin/news/route.ts:29` / `[id]/route.ts:32,55`（**JSON API 3ハンドラは未適用**）| Origin 検証の実挙動を 9 ケースで独立検証（A-4）。E2E `admin-authz.spec.ts:159-195` が 403/403/303 を実測 |
| **SEC-012** | Medium | **解決済み** | `lib/seed-guard.ts:41-70` / `prisma/seed.ts:512`（`deleteMany` = `:516-521` より前）/ `:539-547`（`update` 節から `passwordHash` を除去）| `assertSeedAllowed` に 6 パターンを投入して実挙動を確認（A-5）|
| **SEC-013** | Medium | **解決済み** | `lib/env.ts:43-52`（本番のみ 32文字下限）/ `auth.ts:33`（Node ランタイム入口で実際に評価）| `parseServerEnv` に本番相当の env を直接投入して発火を確認（A-6）|

### A-1. レート制限は本当に認証経路に効いているか（バイパス経路の探索）

- `auth.ts:73` の `authorize` は Credentials Provider の**唯一の入口**である。`@auth/core@0.41.3` の
  `lib/actions/callback/index.js:227-233` は `provider.type === 'credentials' && method === 'POST'` のときのみ
  `provider.authorize(credentials, new Request(url, { headers, method, body }))` を呼ぶ。
  **元リクエストのヘッダがそのまま渡る**ことをソースで確認した（＝ `clientIp` が機能する前提は成立）。
- 認証を発火させうる他の経路を探索した結果、`signIn(` の呼び出しはアプリコードに**存在しない**
  （`components/admin/LoginForm.tsx` は `/api/auth/callback/credentials` へネイティブ POST）。
  `verifyPassword` の呼び出しも `auth.ts:104` の1箇所のみ。**Server Action 経由・別エンドポイント経由の
  バイパスは無い。**
- ゲートは**資格情報の検証より前**（`auth.ts:83-94`）にあり、超過時は scrypt も DB 参照も走らせずに
  `null` を返す。列挙耐性（一律 null）も維持されている。

### A-2. 判定の内訳 — なぜ「解決済み」ではなく「部分解決」か

SEC-009 は2つの脅威を含んでいた。切り分けると次のとおり。

| 脅威 | 判定 | 理由 |
|------|------|------|
| (1) 管理者パスワードの総当たり | **解決** | アカウント軸（5回失敗/15分, `auth.ts:46`）は**メールアドレスをキーにするため IP 偽装では回避できない**。既知の管理者メールに対する推測は 480回/日 に制限され、実用的な総当たりは成立しない |
| (2) 同期 scrypt によるイベントループ全停止 | **解決** | `promisify(scrypt)` で libuv スレッドプールへ移動。公開ページの応答がログイン処理でブロックされる構造は消えた |
| (3) 認証エンドポイントの試行回数制御（＝ CPU 資源の消費上限） | **未解決** | IP 軸のキーが**クライアント偽装可能なヘッダ由来**（SEC-022）。`x-forwarded-for` を毎回変え、メールアドレスも毎回変えれば、**両軸とも常に新規ウィンドウとなり上限に一度も触れずに scrypt を無制限に発火できる**。スレッドプール（既定4）の飽和による性能劣化と、SEC-023 のメモリ増加が残る |

(1)(2) の解消により **High（リリースブロッカー）の要件は満たされた**と判定する。残る (3) は
Medium 相当の資源枯渇であり、SEC-022 / SEC-023 として個別に起票する。

### A-3. 時刻ゲートの共有構造（将来の追加経路で漏れないか）

`prisma.news` への全アクセスを列挙した結果、公開経路の消費点は `app/(public)/page.tsx:36` →
`lib/queries.ts:44` の1つのみ。管理経路（`app/admin/(app)/page.tsx:21-23` の件数集計、`lib/news-admin.ts` の CRUD）は
公開描画に使われていない。述語は `lib/news-visibility.ts` に集約され、公開クエリ2本が**両方ともそれを import**している。

- **関数にした判断（`publishedNewsWhere(now = new Date())`）は正しい。** 定数にすると `new Date()` が
  モジュール評価時に固定され、`next start` の長寿命プロセスで時刻ゲートが凍りつく（予約公開が永久に出ない／
  古い基準時刻で漏れる）。実装ノート §1 の理由付けは監査上も妥当。
- **P3 の `/news` 一覧・詳細でも漏れない構造か** → 構造的な強制力は「同じモジュールを import すること」という
  規約のみで、型による強制は無い。ただし公開経路が1本に統合され、公開向けクエリを書く場所が
  `lib/queries.ts` に集約されている現状では、二重実装が再発する余地は P2 時点より明確に小さい。
  P3 で `/news/[id]` 詳細を追加する際は **`publishedNewsWhere()` を `findFirst` の where に必ず含める**こと
  （`findUnique({ where: { id } })` を使うと `where` に述語を足せず、時刻ゲートを落としやすい。
  `lib/news-admin.ts:74` の `getNewsById` を公開側に転用しないこと）。
- `publishedAt = null` の PUBLISHED が `lte` 比較で除外される点は、`tests/integration/news.int.ts:85-165` が
  **本番経路 `getLatestNews` に対して**直接検証している。P2 差し戻しの根本原因（テスト対象の取り違え）は
  テスト側でも正しく解消されている。

### A-4. Origin 検証の実挙動（ユニットテスト範囲外のケースを独立検証）

`isSameOrigin` に、ユニットテスト（`tests/unit/http-guard.test.ts`）が扱っていない 9 ケースを投入した。

| ケース | 結果 | 評価 |
|--------|------|------|
| `Origin: https://EXAMPLE.com`（ホスト大文字）| false | 拒否側。`URL.origin` は小文字化されるが Origin ヘッダは生文字列比較のため不一致。ブラウザは小文字で送るため正規フローに影響なし |
| `Origin: HTTPS://example.com`（スキーム大文字）| false | 同上 |
| `Origin: https://example.com/`（末尾スラッシュ）| false | 同上（ブラウザは付けない）|
| `Origin: https://example.com:443`（既定ポート明示）| false | 同上 |
| リクエスト URL 側が `:443` 明示 | **true** | `URL.origin` が既定ポートを正規化するため正しく一致 |
| `Origin: https://evil@example.com`（userinfo 付き）| false | 拒否 |
| `Origin: ''`（空文字）| false | 拒否 |
| `Origin: ' https://example.com'`（先頭空白）| **true** | Fetch 仕様に従い `Headers.get` が前後空白を除去した結果の**正しい一致**。バイパスではない |
| Host 偽装（`request.url` が攻撃者ホストになる想定）| **true** | → SEC-027 として起票（下記）|

**正規の同一オリジンリクエストを弾いていないこと**は E2E で実測済み（`admin-authz.spec.ts:196-` の
「同一 Origin の save は 303 で作成される」がパス）。クロスオリジン 403・Origin 欠落 403 も同ファイルで実測。
**Origin 検証自体のバイパスは検出されなかった。**

ただし**適用範囲が不完全**である。`isSameOrigin` の呼び出し元を grep で列挙した結果、
`save/route.ts` と `delete/route.ts` の2本のみで、**JSON 管理 API 3ハンドラには適用されていない** → SEC-024。

### A-5. seed ガードの実挙動

`assertSeedAllowed` に 6 パターンを投入した結果:

| 入力 | 結果 |
|------|------|
| `NODE_ENV=production` | **BLOCKED**（`deleteMany` に到達しない）|
| `NODE_ENV=production` + `ALLOW_PROD_SEED=1` | ALLOWED（仕様どおりの明示オプトイン）|
| `ADMIN_PASSWORD` 空 | **BLOCKED** |
| `NODE_ENV` 未設定 + 本番 DB URL | **ALLOWED** → SEC-025 |
| `NODE_ENV=development` + 本番 DB URL | **ALLOWED** → SEC-025 |
| `ADMIN_PASSWORD='a'`（1文字）| ALLOWED → SEC-025 の付随事項 |

`prisma/seed.ts:512` が `$transaction([...deleteMany])`（`:515-521`）より**前**にガードを評価していることを
ソースで確認。ハードコードフォールバック 3 行は削除済み。`upsert` の `update` 節（`:540`）に
`passwordHash` が無いことも確認した。**指定された契約は満たしている。**

### A-6. AUTH_SECRET 検証 — `.env` の 41→42 文字化は回避策か、仕様どおりの結果か

**結論: 仕様どおりの結果であり、回避策ではない。** ただし検証の設計自体に残課題がある（SEC-026）。

- `lib/env.ts:43-52` の `superRefine` に本番相当の env を直接投入し、`AUTH_SECRET='short'` が
  ZodError で拒否されることを確認した。`auth.ts:33` でモジュールトップから `getServerEnv()` を呼ぶため、
  **スキーマを厳しくしても発火しない**という SEC-013 修正方針2 の懸念は解消されている。
- `.env` の値は `"dev-only-secret-change-me-0123456789abcdef"`（**実測 42 文字**。実装ノートの「41文字」は
  誤記だが実害なし）。E2E は `next start`（`NODE_ENV=production`）で回るため、この延長は
  **「弱い署名鍵では production を起動できない」という要求どおりの帰結**である。`.env` は `.gitignore` 済みで、
  `.env.example:19-20` は空値＋「本番は 32文字以上が必須」の注記のみ（**延長後の実値は公開されていない**）。
- **骨抜きではない**が、検証が長さのみである以上、`'changeme'.repeat(4)`（32文字）や `'a'.repeat(35)` も通過する
  ことを実測した。これは SEC-013 の要件（32文字以上）を満たした上での残課題であり、SEC-026 として起票する。

---

## B. 新規実装が持ち込んだ攻撃面

### [SEC-021] アカウント軸ロックアウトにより、未認証の第三者が管理者ログインを継続的に封鎖できる
- **重大度**: Medium
- **カテゴリ**: 可用性（DoS）/ 認証
- **場所**: `auth.ts:46`（`LOGIN_ACCOUNT_LIMITER`）、`auth.ts:84-94`（**資格情報の検証より前**にアカウント軸ゲートで一律 null）、`auth.ts:107`
- **説明**: アカウント軸（メールアドレスをキーに 5回失敗/15分）のゲートが `peek` として**パスワード照合の前**に置かれているため、上限に達した後は**正しいパスワードを送っても認証されない**。攻撃者は管理者のメールアドレスさえ知っていれば（`.env.example:24` の例示、`docs/` の記述、ログイン画面の運用から推測可能）、誤ったパスワードで 5 回 POST するだけで正規管理者を 15 分間締め出せる。
  実測（レート制限モジュールに攻撃シナリオを直接投入）:
  ```
  攻撃者: 単一IP から 5 回失敗 → account gate success=false retryAfterMs=900000
  正規管理者: 別IP・正しいパスワード → ip gate success=true / account gate success=false
  → 正しい資格情報でも REJECTED
  攻撃コスト: 15分あたり 5 リクエスト（IP 軸の 10回/10分 に収まる＝単一IPで無限に継続可能）
  ```
- **影響**: 管理者が CMS に**恒久的にログインできなくなる**（15分ロックを 15分ごとに更新できるため）。復旧手段はプロセス再起動（インメモリのため）だけだが、再起動直後に再ロックできるので実効的な復旧経路が無い。公開サイトの閲覧は影響を受けないため、影響範囲は管理機能の可用性に限定される。
- **重大度の判断**: CVSS 相当で `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L` ≒ 5.3。公開サイトが継続稼働し機密性・完全性への影響が無いため **Medium** とした。管理者の常時アクセスが業務要件である場合は High として扱ってよい。**是正が新たに持ち込んだ欠陥**である点は明記する。
- **なぜこうなったか**: 本レポート Phase 2 監査の SEC-009 修正方針1 が「アカウントあたり 5回失敗で 15分ロック」と指示しており、実装はそれに忠実である。**指示側（＝前回の本監査）の設計が、OWASP が繰り返し警告するアカウントロックアウトの DoS 面を考慮していなかった**。実装の逸脱ではない。
- **修正方針**:
  1. **アカウント軸のゲートを「照合前の一律拒否」から外す。** 資格情報を照合し、**成功なら常に通す**（成功時に両軸をリセットする現行の設計と整合する）。失敗時のみアカウント軸を `consume` し、失敗が上限を超えたときだけ拒否する。攻撃者は正しいパスワードを持たないので総当たり耐性は変わらず、正規利用者は一度も締め出されない。
  2. 1. だけでは照合コスト（scrypt）が攻撃者に無制限に消費されるため、**IP 軸／グローバル同時実行数の上限**を別途課す（SEC-022 と併せて設計する）。
  3. あるいはキーを `(アカウント, IP)` のタプルにし、単一の攻撃元が全体を締め出せないようにする。ロックの代わりに**指数バックオフや CAPTCHA 要求**へ段階的に切り替える方式も可。
  4. どの方式を採るにせよ、**「正しい資格情報が拒否される状態」を作らない**ことを不変条件としてテストに固定する（現行のユニットテスト・E2E はこのケースを一切検証していない）。
- **参考**: OWASP A07:2021 / CWE-645（Overly Restrictive Account Lockout Mechanism）/ CWE-400
- **関連**: SEC-009（本指摘の発生源）、SEC-022

#### 付随: `clientIp` が `'unknown'` に縮退する構成では全ユーザーが単一バケットを共有する
`auth.ts:59-63` はプロキシヘッダが無い場合 `'unknown'` を返す。リバースプロキシを挟まない
`next start` 直公開（`auth.config.ts:29-30` が想定しているデモ運用）では**全アクセスが
`credentials:ip:unknown` を共有する**ため、誰か1人が 10 回失敗すると 10 分間**全員がログインできなくなる**。
SEC-021 の修正方針1（成功は常に通す）を適用すれば、この縮退も同時に無害化される。

### [SEC-022] レート制限の IP キーがクライアント偽装可能な `x-forwarded-for` の**先頭値**から導出されている
- **重大度**: Medium
- **カテゴリ**: 認証（レート制限のバイパス）/ 可用性
- **場所**: `auth.ts:59-63`（`clientIp`）、`auth.ts:78`（`credentials:ip:${ip}`）
- **説明**:
  ```ts
  // auth.ts:59-63
  function clientIp(request: Request | undefined): string {
    const forwarded = request?.headers.get('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()   // ← 左端＝最も外側＝クライアント申告値
    return request?.headers.get('x-real-ip')?.trim() || 'unknown'
  }
  ```
  `X-Forwarded-For` は**各プロキシが右に追記していく**ヘッダであり、**左端の値はクライアントが自由に名乗れる**。信頼できるのは「自分が信頼するプロキシが追記した位置」＝右側から数えた既知ホップ数分の値であって、左端ではない。`@auth/core` が元リクエストのヘッダをそのまま `authorize` に渡すことは A-1 で確認済みのため、攻撃者は毎リクエストで `X-Forwarded-For: <ランダム>` を送るだけで **IP 軸の上限に一度も触れずに**認証エンドポイントを叩ける。
  Vercel 環境では改竄不可の `x-vercel-forwarded-for` が別途提供されるが、本実装は**それを参照していない**。またリバースプロキシを挟まない `next start` 直公開では `x-forwarded-for` を送るのはクライアントだけであり、**この経路は無条件に攻撃者の制御下**にある。
- **影響**: IP 軸のレート制限が実質無効化される。アカウント軸（メールキー）はメールアドレスを毎回変えれば同様に回避できるため、**両軸をすり抜けて scrypt を無制限に発火させられる**（SEC-009 の脅威(3)が未解決である理由）。非同期化により**イベントループの全停止は起きなくなった**が、libuv スレッドプール（既定 4）の飽和により、スレッドプールを共有する処理（`fs` 等）の遅延と CPU 飽和が生じる。総当たりについては、アカウント軸が**メールをキーにしている**ため IP 偽装では緩まない（＝資格情報の推測は依然として抑止されている）。
- **P3 での深刻度**: 本モジュールは「P3 の未認証エンドポイント（申込 / 免許証アップロード / チャット）で**再利用する前提**」と明記されている（`lib/rate-limit.ts:5-7`, `auth.ts:41-43`）。P3 ではアカウント軸に相当する第2の軸が無いため、**IP キーが偽装可能であることは即座にスパム・濫用対策の全面失効を意味する**。P3 着手前の是正が必須。
- **修正方針**:
  1. **信頼するプロキシのホップ数を明示する。** `X-Forwarded-For` を分解し、**右から `trustedProxyCount` 番目**の値を採る。Vercel では `x-vercel-forwarded-for`（クライアントが上書きできない）を第一候補にする。プラットフォームが不明な構成では、クライアント申告値を IP として扱わない。
  2. IP が確定できない場合（`'unknown'`）に**制限を緩めない**設計にする。現状は全員が同一バケットを共有する（SEC-021 付随）。
  3. **キー非依存のグローバル上限**（同時実行中の scrypt 数、または認証エンドポイント全体の秒間上限）を併設する。キー偽装で回避できない最後の防壁になる。
  4. デプロイ前提（どのヘッダを信頼するか）を `docs/tech-stack.md` に明記する。SEC-016（`trustHost: true` の前提未文書化）と同じ根の問題である。
- **参考**: OWASP A07:2021 / CWE-290（Authentication Bypass by Spoofing）/ CWE-348（Use of Less Trusted Source）/ CWE-807

### [SEC-023] インメモリ store に期限切れの掃除も件数上限も無く、攻撃者が制御するキーで無制限に増加する
- **重大度**: Medium
- **カテゴリ**: 可用性（資源枯渇）
- **場所**: `lib/rate-limit.ts:73-86`（`createMemoryRateLimitStore`）、`lib/rate-limit.ts:93-97`（`currentEntry` は期限切れを**読み飛ばすだけで削除しない**）、`auth.ts:97`（毎試行 `consume` → `set`）
- **説明**: 期限切れ判定は `now >= entry.resetAt` の**時刻比較のみ**で行われ、`Map` からエントリが消えるのは `reset()`（＝認証成功時）だけである。認証は未認証で叩けるため、`credentials:ip:<攻撃者が指定した文字列>` というエントリが**リクエストごとに1件、上限も TTL も無く積み上がる**。キーの中身も長さも攻撃者が決められる（`x-forwarded-for` の値、および `credentials:email:` のメールアドレスは長さ検証を受けていない — `auth.ts:74` は型チェックのみ）。SEC-022 のキー偽装がそのまま増幅要因になる。
  実測: ウィンドウ経過後のエントリは論理的には期限切れ扱い（`peek` が success=true を返す）だが、**`Map` からは削除されない**ことをコードで確認した。
- **影響**: `next start` のような長寿命プロセスで、認証エンドポイントへの継続的なリクエストによりヒープが単調増加し、最終的に OOM に至る。サーバーレスではインスタンスが短命なため影響は小さいが、**そもそもサーバーレスではインメモリ store がインスタンスをまたがず、レート制限自体が機能しない**（下記）。
- **インスタンス分散の前提が明示されているか**: `lib/rate-limit.ts:15-18` と `auth.ts:41-43` に「単一インスタンス前提／本番は KV 実装を注入して差し替える」と**コメントで明記されており、`store` という差し替え口も存在する**（`RateLimiterConfig.store`, `lib/rate-limit.ts:60`）。設計としては妥当。ただし**実行時の担保が無い**: 本番で KV を設定し忘れても警告もエラーも出ず、レート制限が静かに骨抜きになる。SEC-012 が是正した「静かなフォールバック」と同型の問題である。
- **修正方針**:
  1. `currentEntry` が期限切れを検出した時点で `store.delete(key)` する（読み取り時の遅延削除）。あわせて**件数上限付き LRU** または定期スイープを入れる。
  2. **キーを正規化・長さ制限する**（例: `sha256(raw).slice(0,32)`）。攻撃者制御の可変長文字列をそのままキーにしない。
  3. `NODE_ENV=production` かつ store 未注入のときに**起動時に fail-fast させる**か、少なくとも1度だけ警告を出す（SEC-013 と同じ「本番で静かに弱くならない」原則）。P3 で `lib/kv.ts` を `createKvRateLimitStore(): RateLimitStore` として実装する方針は妥当なので、その時点で 3. を必須にする。
- **参考**: CWE-400（Uncontrolled Resource Consumption）/ CWE-770（Allocation Without Limits）

### [SEC-024] SEC-011 の Origin 検証が JSON 管理 API 3ハンドラに適用されていない
- **重大度**: Medium
- **カテゴリ**: CSRF
- **場所**: `app/api/admin/news/route.ts:29`（`POST`）、`app/api/admin/news/[id]/route.ts:32`（`PUT`）・`:55`（`DELETE`）— いずれも `isSameOrigin` を呼んでいない
- **説明**: SEC-011 の是正は `save` / `delete` の form POST 2本にのみ適用された（`isSameOrigin` の呼び出し元を grep で列挙して確認）。**同じ副作用（お知らせの作成・更新・削除）を持つ JSON API 3本は検証していない**ため、SEC-011 が問題視した「防御が Cookie の `SameSite` 既定値のみに依存する」状態が、これらのハンドラでは**そのまま残っている**。
  特に `POST /api/admin/news` は、`request.json()`（`route.ts:34`）が Content-Type を検証しないため、**`Content-Type: text/plain` の本文で JSON を送れる**。text/plain は CORS のセーフリスト値でありプリフライトが発生しないため、クロスサイトからの単純リクエストとして到達可能な形をしている（現時点で Cookie が送られないのは `sameSite: 'lax'` のおかげ）。
- **影響**: `auth.config.ts:39` の `sameSite` を将来 `'none'` に変えた場合、またはサブドメインに任意コンテンツが置かれた場合、管理者がログイン済みの状態で罠ページを開くと**お知らせの作成・改ざん・削除**が実行される。SEC-011 の是正目的（SameSite への暗黙依存の解消）が半分しか達成されていない。
- **修正方針**:
  1. 3ハンドラの先頭にも `isSameOrigin(request)` を置く（`DELETE` は現在 `_request` を無視しているので引数を使うよう変更する）。
  2. あわせて JSON API では Content-Type が `application/json` であることを検証する（単純リクエスト化の余地を塞ぐ）。
  3. 認可・Origin 検証・存在確認の順序を 5 ハンドラで統一し、共通ラッパ（例 `withAdminMutation(handler)`）に括り出すと適用漏れが構造的に起きなくなる。P3 でハンドラが増える前に導入することを推奨する。
- **参考**: OWASP A01:2021 / CWE-352
- **関連**: SEC-011（部分解決の残件）、SEC-019（仕様と実装の乖離により API 一覧が攻撃面の一覧として使えていない問題は未解決のまま）

### [SEC-025] seed の本番ガードが「接続先 DB」ではなく `NODE_ENV` を基準にしている
- **重大度**: Low
- **カテゴリ**: 設定 / 運用
- **場所**: `lib/seed-guard.ts:42`
- **説明**: ガードは `NODE_ENV === 'production'` のときだけ実行を拒否する。しかし `pnpm db:seed` は開発者のローカル端末から実行され、そこでの `NODE_ENV` は通常 `undefined` か `development` である。**接続先だけを本番 DB に向けた実行（`POSTGRES_URL=<本番> pnpm db:seed`）はガードを素通りする**ことを実測で確認した。SEC-012 が防ごうとした事故（`deleteMany()` による公開コンテンツの全損）の最も現実的な発生経路が、まさにこの形である。
  なお `ADMIN_PASSWORD` は空文字のみ拒否で、1文字でも通過する（強度検証は無い）。
- **影響**: 運用事故 1 回で本番コンテンツが全損しうる状態が残っている。SEC-012 の指定要件（`NODE_ENV` ベース）は満たしているため是正の不履行ではないが、防御としては目的を達していない。
- **修正方針**:
  1. **接続先を判定軸に加える**。`POSTGRES_URL` のホストが `localhost` / `127.0.0.1` 以外なら、`ALLOW_PROD_SEED=1` が無い限り拒否する。
  2. あわせて対象 DB のホスト名を実行前に標準出力へ表示し、破壊操作の直前に確認を促す。
  3. `ADMIN_PASSWORD` に最小長（例 12 文字）を課す。
- **参考**: CWE-1188 / OWASP A05:2021

### [SEC-026] `AUTH_SECRET` の検証が長さのみで、既知のプレースホルダ値を通過させる
- **重大度**: Low
- **カテゴリ**: 認証（セッション署名）
- **場所**: `lib/env.ts:11`（`AUTH_SECRET_MIN_LENGTH = 32`）、`lib/env.ts:43-52`
- **説明**: 本番検証は文字数下限のみで、エントロピーは見ていない。実測で `'changeme'.repeat(4)`（32文字）、`'a'.repeat(35)` がいずれも**通過する**ことを確認した。ローカル `.env:10` の値 `"dev-only-secret-change-me-0123456789abcdef"`（42文字）も当然通過する。この値自体は `.gitignore` 済みで `.env.example` にも載っていないため直ちに危険ではないが、**「検証を通すために開発用プレースホルダを長くする」という運用が実際に発生した**（`docs/impl-p2fix-notes-2026-07-28.md` §2）事実は、長さのみの検証が意図した性質（推測困難性）を代理できていないことを示している。
- **影響**: 弱いが長い署名鍵で本番デプロイされた場合、SEC-013 の検証は素通りする。成立時の影響は SEC-013 と同じ（JWT 偽造による管理画面の完全な乗っ取り）。
- **修正方針**:
  1. 既知プレースホルダの拒否リストを追加する（`dev-only` / `change-me` / `changeme` / `secret` / `example` を含む値を本番で拒否）。
  2. 文字種の多様性、または base64/hex としてデコードしたバイト長 32 以上を要求する。
  3. E2E をローカルの production ビルドで回す都合と両立させるため、**開発用の値は `.env` に留め、本番は Vercel の環境変数で別途設定する**運用を `docs/tech-stack.md` に明記する。
- **参考**: OWASP A02:2021 / CWE-330 / CWE-1391（Use of Weak Credential）
- **関連**: SEC-013（本体は解決済み。本項はその残課題）

### [SEC-027] Origin 検証の基準がリクエスト由来のホストであり、設定された正規オリジンではない
- **重大度**: Low
- **カテゴリ**: CSRF / 設定
- **場所**: `lib/http-guard.ts:27`（`origin === new URL(request.url).origin`）
- **説明**: 比較対象の `request.url` は `Host` / `X-Forwarded-Host` から組み立てられる。`auth.config.ts:31` が `trustHost: true` であることと合わせると、**Host ヘッダを正規化しないプロキシ構成では、攻撃者が `Host: evil.example` と `Origin: https://evil.example` を同時に送ることで検証を一致させられる**（実測で `request.url` と `Origin` が同じ攻撃者ホストなら true になることを確認）。ただしその状態でもクロスサイトのため `SameSite=Lax` により Cookie は送られず、単独では成立しない。
  逆方向のリスクもある。TLS 終端プロキシが `X-Forwarded-Proto: https` を付け忘れると `request.url` が `http://` になり、ブラウザが送る `Origin: https://…` と**スキーム不一致で正規リクエストが 403 になる**（可用性）。
- **影響**: 多層防御としての強度が、SEC-016 で指摘済みのデプロイ前提に依存している。単独の悪用経路は無い。
- **修正方針**: 設定済みの正規オリジン（`AUTH_URL` / `NEXT_PUBLIC_SITE_URL`）を第一の比較対象にし、未設定時のみ `request.url` にフォールバックする。あわせて `Sec-Fetch-Site: same-origin` の確認を併用すると、ヘッダ偽装だけでは通らなくなる（`Sec-Fetch-*` は Forbidden header name でスクリプトから設定できない）。
- **参考**: CWE-644 / CWE-346（Origin Validation Error）
- **関連**: SEC-016（`trustHost: true` の前提未文書化）

### [SEC-028] 認証失敗ログが攻撃者制御の文字列を含み、出力量に上限が無い
- **重大度**: Info
- **カテゴリ**: ログ / 可用性
- **場所**: `auth.ts:90-92`、`auth.ts:108-112`
- **説明**: SEC-009 修正方針3 に従い失敗ログが追加された。**パスワードとメールアドレスは記録されておらず、指示は正しく守られている**（`ip` / ISO 時刻 / 試行回数のみ）。一方で `ip` の値は `x-forwarded-for` 由来＝**攻撃者が内容も長さも決められる文字列**であり、それがそのままログ行に埋め込まれる。またレート制限を回避できる（SEC-022）以上、ログ行数にも実質的な上限が無い。
  なお、これにより Phase 2 監査の Positive finding「アプリコードの `console.*` はゼロ」は成立しなくなった。意図的な変更であり指摘ではないが、P3 の PII 非出力方針（Phase 2 §D）と両立させるため、ログの出力先と保持方針を決めておくこと。
- **修正方針**: 出力前に IP を長さ制限・文字種正規化する（SEC-023 のキー正規化と共通化できる）。ログは構造化（JSON 1行）にし、同一キーの連続失敗は集約して出力量を抑える。P3 で PII を扱う前に、ログの保持期間と閲覧権限を決めること。
- **参考**: CWE-117（Improper Output Neutralization for Logs）/ CWE-779（Logging of Excessive Data）

---

## C. パスワード照合の定数時間性（退行していないか）

`lib/password.ts` の非同期化で `timingSafeEqual` の性質が失われていないことをコードで確認した。

| 性質 | 状態 | 根拠 |
|------|------|------|
| `timingSafeEqual` による定数時間比較 | **保持** | `lib/password.ts:56` |
| 比較前の長さ一致保証（throw 回避）| **保持** | `:51`（`expected.length !== SCRYPT_KEYLEN`）、`:55`（`actual.length !== expected.length`）|
| hex 妥当性の事前検証（`Buffer.from` の黙示切り詰め対策）| **保持** | `:47` |
| 形式不正で throw せず `false` | **保持** | `await` が `try` の内側（`:41-59`）|
| seed との形式互換（`scrypt$<salt>$<hash>`, salt 16B / keylen 64B）| **保持** | `:23-24, 36` ↔ `prisma/seed.ts:50-53` |

**非同期化による定数時間性の劣化は無い。** `scryptAsync` は libuv スレッドプールで実行されるため、
スレッドプールの混雑によって実行時間に**入力非依存の**ゆらぎが乗るが、これは秘密値と相関しないため
タイミング攻撃の情報源にはならない（むしろノイズとして働く）。

`auth.ts:103-106` の応答時間均一化（RV-P2-003）も正しい: ユーザー不在時もダミーハッシュに対して
同一コストの `verifyPassword` を実行し、`ok` を**先に評価し切ってから**判定している（`&&` の早期脱出を避けている）。
`getDummyHash()` は初回のみ生成しキャッシュするため（`auth.ts:52-56`）、2回目以降の経路長も一致する。
ただし初回リクエストのみダミーハッシュ生成分（scrypt 1回）が上乗せされる — 実用上の情報漏洩には当たらない。

**残る差**: `auth.ts:99` の `if (!email || !password) return null` は DB 参照・scrypt の前に返るため、
空入力は明確に速い。ただし秘密の有無と相関しないため列挙には使えない。

---

## D. 繰越・未解決事項の現状（実コードで再確認）

| ID | 深刻度 | 現状 | 根拠 |
|----|--------|------|------|
| **SEC-002**（CSP 未設定）| Medium | **未解決** | `next.config.mjs:4-9` に `Content-Security-Policy` / `Strict-Transport-Security` は依然として無い。P2 修正でも触れられていない（スコープ外と明示） |
| **SEC-014**（save/delete の存在確認欠落 → 500）| Low | **未解決** | `save/route.ts:63-67` / `delete/route.ts:25-28` に存在確認も try/catch も無い。Prisma `P2025` は未捕捉のまま |
| **SEC-015**（セッション有効期限 30日）| Low | **未解決** | `auth.config.ts:32` は `session: { strategy: 'jwt' }` のままで `maxAge` / `updateAge` の指定なし |
| **SEC-016**（`trustHost: true` の前提）| Low | **一部改善** | `trustHost: true`（`auth.config.ts:31`）は据え置きだが、修正方針3 の `useSecureCookies` 明示は実装された（`auth.config.ts:24-26, 41`）。Cookie の `secure` が**リクエストのスキーム推定ではなく `AUTH_URL` 由来**になった点は改善。デプロイ手順書への記載（修正方針1・2）は未対応 |
| **SEC-017**（依存関係の既知脆弱性）| Low | **未解決** | `package.json` / `pnpm-lock.yaml` に変更なし。CI への `pnpm audit` 組み込み（P1 SEC-006 から継続）も未対応 |
| **SEC-018**（相対/プロトコル相対 href）| Info | 未解決（任意対応）| `lib/markdown/renderSafe.ts` に変更なし |
| **SEC-019**（仕様と実装 API の乖離）| Info | **未解決** | `docs/functional-spec.md` F-014 は未更新。SEC-024 の適用漏れは、API 一覧が攻撃面の一覧として機能していないことの実例になった |
| **SEC-020**（公開側サーバー描画経路の未整備）| Info | 未解決（P3 申し送り）| 公開ページに本文描画経路はまだ無い（`app/(public)/` に News 詳細ルートなし） |
| **SEC-001**（本文サニタイズ）| — | **解決済み（維持）** | `lib/markdown/renderSafe.ts` に変更なし。P2 監査の 34 ペイロード検証の結論は有効 |

---

## E. 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **0** |
| Medium | 4 新規（SEC-021 / SEC-022 / SEC-023 / SEC-024）＋ 繰越 SEC-002 |
| Low | 3 新規（SEC-025 / SEC-026 / SEC-027）＋ 繰越 SEC-014〜SEC-017 |
| Info | 1 新規（SEC-028）＋ 繰越 SEC-018〜SEC-020 |

### 判定: **P2 はリリース可能**（Critical 0 / High 0。監査スキルのリリースブロック基準を満たす）

**リリースブロッカーだった SEC-009 の High 要件は解消された。** 総当たり耐性はアカウント軸
（メールキーのため IP 偽装で回避できない）により確保され、同期 scrypt によるイベントループの全停止は
非同期化で構造的に消えている。SEC-010 は公開経路の単一化により完全に解決し、テストも本番経路を
直接検証する形に是正された。SEC-012 / SEC-013 は指定された契約を満たし、いずれも実挙動で発火を確認した。
SEC-011 は form POST 2本について E2E で実効性が実測されている。

一方で、**是正が新たな Medium を 4 件持ち込んだ**点は正直に記録する。とりわけ:

1. **SEC-021 は、前回の本監査が出した修正方針（「アカウントあたり5回失敗で15分ロック」）自体の設計欠陥**である。実装は指示に忠実であり、責は監査側にある。アカウントロックアウトは OWASP が DoS 面を繰り返し警告している方式で、**照合前の一律拒否ではなく「失敗のみ計数し、成功は常に通す」形に直す**必要がある。
2. **SEC-022 は、レート制限という制御そのものが偽装ヘッダで無効化できる**という点で、SEC-009 の3つ目の脅威（試行回数制御）が実質未解決であることを意味する。P2 の被害は限定的だが、**同じ基盤を未認証エンドポイントで再利用する P3 では致命的**になる。
3. 「単一インスタンス前提」「本番は KV に差し替え」は**コメントと `store` 引数として明示されており設計は妥当**だが、差し替え忘れが静かに通る（SEC-023）。SEC-012 で潰した「静かなフォールバック」と同じ型の問題が別の場所に残っている。

### 是正の優先順位

1. **SEC-021**（Medium / 可用性）— 管理者を締め出せる状態を放置しない。修正は `auth.ts` の数行
2. **SEC-022**（Medium）— IP キーの導出を信頼できる出所に変える + キー非依存のグローバル上限。**P3 の前提**
3. **SEC-024**（Medium）— JSON API 3本への Origin 検証適用。共通ラッパ化を併せて
4. **SEC-023**（Medium）— 期限切れ削除・件数上限・キー正規化、本番 store 未注入時の fail-fast
5. **SEC-002**（Medium / 繰越）— CSP。P3 のフォーム実装と同時に
6. SEC-025 / SEC-026 / SEC-027（Low）— いずれも小規模
7. SEC-014〜SEC-017（Low / 繰越）— SEC-017 の CI 組み込みは P3 前に入れると以後の回帰を防げる

### テストへの申し送り（Test Agent）

現行のテストは**是正が「動くこと」は検証しているが、「悪用できないこと」を検証していない**。
以下を追加し、SEC-021 / SEC-022 の再発を契約として固定すること。

- **正しい資格情報が拒否されない不変条件**: 他者が同一アカウントで N 回失敗した後でも、正規パスワードでのログインが成功する（SEC-021）
- **キー偽装でレート制限が緩まない**: `x-forwarded-for` を毎回変えても IP 軸の上限に到達する（SEC-022）
- **期限切れエントリが store から消える**: ウィンドウ経過後に store のサイズが増え続けない（SEC-023）
- **JSON API のクロスオリジン拒否**: `POST /api/admin/news` / `PUT`・`DELETE /api/admin/news/[id]` に対する E2E（SEC-024）

---

## F. P3 着手前の必須要件 — 前回 §E の更新

| 前回 §E の要件 | 状態 | 補足 |
|---------------|------|------|
| **SEC-009**（レート制限基盤の汎用化）| **未達** | 基盤（`lib/rate-limit.ts`）は作られ、store 差し替えによる P3 再利用の道筋も付いた。**しかしキー導出（SEC-022）・ロックアウト設計（SEC-021）・エントリ管理（SEC-023）に欠陥があり、この状態で P3 の未認証エンドポイントへ横展開すると欠陥ごと複製される。** P3 着手前に 3 件とも是正すること |
| **SEC-013**（`AUTH_SECRET` の本番検証）| **達成** | `lib/env.ts:43-52` + `auth.ts:33` で起動経路から実際に発火。残課題は SEC-026（Low）のみ |
| **SEC-002**（CSP の P3 前倒し）| **未達** | 変更なし。個人情報を入力するフォームページを作る前に投入することを引き続き強く推奨 |
| **SEC-011**（Origin 検証の型作り）| **部分達成** | `lib/http-guard.ts` という再利用可能な形にはなった（P3 の申込・アップロード・チャットでそのまま使える）。ただし P2 内でも適用漏れがある（SEC-024）ため、**「変更系ハンドラは必ずガードを通る」構造（共通ラッパ）を P3 前に作る**こと。手動適用のままでは P3 でハンドラが増えたときに再び漏れる |
| **SEC-012**（seed のガード）| **達成** | 判定軸に接続先 DB を加える改善余地あり（SEC-025 / Low）|

**結論: P3 着手前の必須要件のうち、SEC-009 系（SEC-021 / SEC-022 / SEC-023）と SEC-024 が未達である。**
P2 自体のリリースは可能だが、**P3 の設計・実装に入る前にこの 4 件を先に片付けること**を強く推奨する。
理由は単純で、これらはすべて **P3 で再利用することが明示された共通基盤**（レート制限・Origin 検証）の欠陥であり、
P3 で作られる未認証エンドポイント（申込・免許証アップロード・チャット）すべてに複製されるためである。

---

# P2.5 ハードニング監査（2026-07-28）

## 監査日: 2026-07-28
## 対象: P2.5 ハードニング（SEC-021 / SEC-022 / SEC-023 / SEC-024 の是正）の検収と、P3 横展開可否の判定

### 監査の方法

`docs/impl-p25-notes-2026-07-28.md` / `docs/review-p25-tests-2026-07-28.md` の**記述は根拠として採用せず**、
実コードを読み、さらに**実装モジュールに攻撃シナリオを直接投入して挙動を実測**した
（`lib/rate-limit.ts` / `lib/login-guard.ts` / `lib/http-guard.ts` を `tsx` から直接呼び出し）。
以下の判定に付した「実測」はすべてその結果である。品質ゲート（unit 163 / integration 28 / e2e 82 全パス、
type-check・lint クリーン、build 成功、テスト改竄なし）はオーケストレーターの独立実行値を前提とし、再実行していない。

---

## A. SEC-021〜024 のクローズ判定表

| ID | 判定 | 根拠（file:line） | 検証方法 |
|----|------|------------------|---------|
| **SEC-021**（アカウント軸ロックアウトで第三者が管理者を締め出す）| **部分クローズ** | 是正部分: `lib/login-guard.ts:94`（照合を必ず実行）/ `:104`（失敗時のみアカウント軸 consume）/ `auth.ts:98-107`。**残存部分**: `lib/login-guard.ts:81-84`（グローバル軸を**照合前・IP ゲートより前**に consume。成功でも解放しない）→ **SEC-029** | 攻撃シナリオ実測。アカウント軸を 5/5 まで枯渇させた状態で正規パスワードのログインが `outcome=ok verified=true` になることを確認（＝指示された不変条件は成立）。一方、単一 IP から 120 リクエストでグローバル軸が 100/100 に達し、**別 IP の正規管理者が正しいパスワードで `outcome=rate-limited verified=false`** になることを確認 |
| **SEC-022**（IP キーが偽装可能な XFF 先頭値由来）| **クローズ（残課題あり）** | `lib/http-guard.ts:94`（`trustProxy` 既定 = `process.env.VERCEL === '1'`、未設定は false ＝ fail-closed）/ `:100`（信頼境界外はヘッダを一切読まない）/ `:102-109`（信頼順 `x-vercel-forwarded-for` → `x-forwarded-for` → `x-real-ip`、IP リテラル検証を通った値のみ採用）/ `:113-116`（長さ 45 で足切り）/ `lib/rate-limit.ts:158-163`（キー長の有界化）。残課題: **IPv6 をアドレス単位でキー化** → **SEC-032**、信頼境界外の縮退の意味論 → **SEC-030** | `VERCEL` を根拠にする方式自体はクライアント制御外であり偽装不可であることをコードで確認（`process.env` のみ参照、リクエスト由来の値を判定に混ぜていない）。信頼境界外では XFF を変えても `key='unknown'` に寄ることを実測。出力は常に 1〜45 文字 |
| **SEC-023**（インメモリ store に回収も上限も無い）| **部分クローズ** | 是正部分: `lib/rate-limit.ts:175-183`（読み取り時の期限切れ回収）/ `:102-144`（件数上限 10,000 + 退避）/ `:158-163`（正規化・長さ制限）。**残存部分**: 退避方針が**レート制限の解除に悪用できる**（`:124-128`）→ **SEC-031**、本番 store 未注入時の fail-fast が未実装（`lib/env.ts` に該当なし。`lib/kv.ts:12` に「P3 で入れる」と注記のみ）→ **SEC-033** | `maxEntries=1000` の store で、上限に達した自分のバケットが 1200 件の新規キー注入により **`used=3 success=false` → `used=0 success=true`** に戻ることを実測（実時刻ベース） |
| **SEC-024**（Origin 検証が JSON API 3 本に未適用）| **クローズ** | `app/api/admin/_guard.ts:54-76`（共通ラッパ）/ 適用: `app/api/admin/news/route.ts:33`（POST）、`[id]/route.ts:28`（PUT）・`:53`（DELETE）、`save/route.ts:20`、`delete/route.ts:12`。`GET` は `route.ts:26-30` で自前の `auth()` 検証あり（認可の穴は無い） | `grep` で変更系ハンドラの export を全列挙し、**`GET` 以外の 5 本すべてがラッパ経由**であることを網羅確認。`isSameOrigin` の実挙動を 8 パターンで実測（下表） |

### SEC-024 の Origin 検証 — 実測（`lib/http-guard.ts:23-32`）

| ケース | 結果 | 評価 |
|--------|------|------|
| 同一オリジン | `true` | 正規経路を壊さない |
| `Origin` 欠落 | `false` | fail-closed（正） |
| `Origin: null`（sandbox iframe 等）| `false` | 正 |
| サブドメイン（`https://evil.good.example`）| `false` | `SameSite=Lax` の同一サイト扱いを塞ぐ（正） |
| ポート違い | `false` | 正 |
| スキーム違い（`http:` vs `https:`）| `false` | 正 |
| ホスト名の大文字（`https://GOOD.EXAMPLE`）| `false` | `URL` の正規化により Origin 側も小文字化されるため一致する想定だったが `false`。**過剰拒否**だがブラウザは常に小文字で送るため実害なし |
| `Host` も `Origin` も攻撃者ホスト | `true` | **SEC-027（Low, 未解決）のとおり**。ただしブラウザ由来の CSRF では `Host` を攻撃者が決められないため単独では成立しない |

Content-Type 検証（`app/api/admin/_guard.ts:70-72, 78-84`）は `application/json` と `*/*+json` のみ許可し、
`text/plain`（CORS セーフリスト値＝プリフライト無しで到達できる形）を 415 で塞ぐ。E2E
`tests/e2e/playwright/admin-authz.spec.ts` の PT2-06 が、クロスオリジン / Origin 欠落 / 同一オリジン正常系 /
非 JSON Content-Type / `GET` の非対象化まで**副作用の有無を DB で直接確認**しており、検収として十分である。
`GET` にラッパを適用しない判断は、`GET /api/admin/news` が `auth()` で認可を行っており（`route.ts:27-28`）
未認証に情報を返さないため、情報漏洩を生まない。

---

## B. 新規指摘（SEC-029 以降）

### [SEC-029] グローバル上限が IP ゲートより前に消費されるため、単一の攻撃者が全管理者のログインを封鎖できる
- **重大度**: Medium
- **カテゴリ**: 可用性（DoS）/ 認証
- **場所**: `lib/login-guard.ts:81-84`（`global.consume` が最初）、`:87-88`（IP ゲートはその後）、`auth.ts:58`（`LOGIN_GLOBAL_LIMITER` 100回/分）
- **説明**: 処理順序が「1. グローバル consume → 2. IP ゲート peek → 3. IP consume → 4. 照合」である。
  **IP ゲートで拒否されるリクエストも、その前にグローバル軸を 1 消費している。** したがって IP 軸で
  10回/10分に制限されているはずの単一 IP が、グローバル軸の 100回/分を単独で使い切れる。
  グローバル軸は**成功でも解放しない**設計（`lib/login-guard.ts:81` のコメント、`login-guard.test.ts` L411 が契約化）
  のため、枯渇後はウィンドウが明けるまで**正しい資格情報を持つ管理者も照合前に拒否される**。
  実測:
  ```
  攻撃者: 単一 IP から 120 リクエスト → rate-limited 110 / verify 実行 10
          （うち 90 件は IP ゲートで拒否されたが、グローバル軸は消費済み）
  グローバル軸: used=100/100 success=false
  正規管理者: 別 IP・正しいパスワード → outcome=rate-limited verified=false retryAfterMs=59700
  攻撃コスト: 100 リクエスト/分（単一ホストで十分。認証不要）
  ```
- **影響**: SEC-021 が問題にした「未認証の第三者が正規管理者を締め出せる」という被害クラスが、
  **アカウント軸からグローバル軸へ移っただけで残っている**。しかも攻撃者は管理者のメールアドレスを
  知る必要すらなくなった（SEC-021 の前提条件が不要になった分、成立は容易になっている）。
  ロックは 1 分ウィンドウなので恒久ではないが、毎分 100 リクエストを送り続ければ実質恒久である。
  公開サイトは影響を受けず、機密性・完全性への影響も無いため SEC-021 と同じ **Medium** とする。
- **なぜ検出されなかったか**: `docs/review-p25-tests-2026-07-28.md` の T1「要求する処理順序」が
  `1. global.consume → 2. ip.peek` を**契約として明記**しており、実装はそれに忠実である。
  テスト（`login-guard.test.ts` L356-411）はグローバル上限が「効くこと」だけを検証し、
  **「正規利用者が巻き込まれないこと」を検証していない**。SEC-021 で学んだはずの
  「正しい資格情報が拒否される状態を作らない」という不変条件が、グローバル軸には適用されていない。
- **修正方針**:
  1. **グローバル軸の consume を IP ゲート通過後（＝実際に `verify()` を走らせるリクエストだけ）に移す。**
     これだけで単一 IP がグローバル軸へ与えられる負荷は 10回/10分に落ち、枯渇には 100 以上の
     独立した発信元が必要になる。実装は `lib/login-guard.ts` の 3 行の移動である。
  2. さらに、グローバル軸に達した場合でも**失敗履歴の無い発信元には予約枠を残す**
     （例: グローバル上限の 20% を「IP 軸のカウントが 0 のリクエスト」専用にする）。
     「攻撃者が全体枠を食い尽くしても正規利用者は入れる」を成立させるのが目的である。
  3. 閾値の根拠を「scrypt の CPU 予算」ではなく「インスタンスの処理能力に対する余裕」に置き直す。
     100回/分は正規利用に対しては十分だが、**攻撃者が到達するのが容易すぎる**水準でもある。
  4. **不変条件をテストに固定する**: 「他者がグローバル上限を使い切った直後でも、正しい資格情報の
     ログインは成功する」。SEC-021 に対して L92 が置かれたのと同じ形のテストを、グローバル軸にも置く。
- **参考**: CWE-645 / CWE-400 / OWASP A07:2021
- **関連**: SEC-021（同一の被害クラス）、SEC-030

### [SEC-030] 信頼境界外の `unknown` 縮退は「制限を緩めない」代わりに全利用者を締め出す。文書・コメント・テスト契約の記述が事実と異なる
- **重大度**: Medium
- **カテゴリ**: 可用性（DoS）/ 文書の正確性
- **場所**: `lib/http-guard.ts:83-85`（コメント）、`docs/tech-stack.md:199-200`、`docs/review-p25-tests-2026-07-28.md` T2 項目3、`lib/login-guard.ts:87-88`（IP ゲート）
- **説明**: 信頼できるプロキシ配下でない配置（`VERCEL` が無い＝`next start` 直公開・ローカル・オンプレ）では
  `resolveClientIp` が全リクエストを `unknown` に寄せる。この縮退について、コード・技術文書・テスト契約が
  そろって次のように述べている:
  > この縮退で全利用者が同一バケットを共有しても、**正しい資格情報は常に通る**ため（SEC-021 の是正）、正規管理者が締め出されることはない。 — `docs/tech-stack.md:199-200`

  **この記述は誤りである。** 「成功は常に通す」が適用されるのは**アカウント軸だけ**であり、
  IP 軸は依然として**照合前ゲート**（`lib/login-guard.ts:87-88`）である。`unknown` は IP 軸のキーなので、
  誰か 1 人が 10 回失敗すると全員が 10 分間ゲートで止まる。
  実測:
  ```
  trustProxy=false: XFF を変えても key='unknown' trusted=false
  攻撃者が 10 回失敗（すべて unknown バケット）
  → 正規管理者・正しいパスワード: outcome=rate-limited verified=false retryAfterMs=599980
  ```
  逆方向の副作用も実測した: 共有バケットでは**正規ログインの成功が攻撃者の消費分まで解放する**
  （9 回失敗の後に 1 回成功すると `used=0` に戻る）。つまり縮退構成では、制限が締まりすぎる方向と
  緩みすぎる方向の両方に壊れる。
- **影響**: 本番ホスティングは Vercel 集約で確定しており（`docs/phase-status.md`）、`VERCEL=1` が
  自動注入されるため**本番の実害は無い**。実害があるのは (a) `next start` 直公開のデモ運用
  （`auth.config.ts:24-30` が明示的に想定している構成）、(b) ローカル/オンプレ検証、
  (c) 将来 Vercel 以外へ移設したとき。より重大なのは**誤った理解が文書とコメントに固定されている**ことで、
  P3 で未認証エンドポイント（申込・アップロード・チャット）へ同じ縮退を持ち込むと、
  「1 人の濫用で全訪問者が申込フォームを送信できなくなる」という形で顕在化する。
- **修正方針**:
  1. `lib/http-guard.ts:83-85` / `docs/tech-stack.md:199-200` / テスト契約の当該記述を**事実に合わせて訂正する**
     （「アカウント軸は締め出さないが、IP 軸は共有バケットのため全員が止まる」）。
  2. 縮退時は**ゲートの意味論を変える**: `trusted=false` のときは照合前ゲートを適用せず、
     グローバル軸（および CAPTCHA 等の別手段）だけで守る。`ClientIpResolution.trusted` は既に
     返っているが**現状どこからも使われていない**（`auth.ts:91` は `.key` のみ参照）。この値を
     ポリシー分岐に使うのが最小の修正である。
  3. P3 では、`trusted=false` の環境で未認証エンドポイントを公開しない（起動時に警告する）か、
     IP 以外の軸（セッション Cookie・Turnstile トークン）を併用する。
- **参考**: CWE-645 / CWE-1188
- **関連**: SEC-021、SEC-022、SEC-029

### [SEC-031] 件数上限の退避方針が「最も古い `resetAt` から」であるため、攻撃者が自分のスロットルを解除できる
- **重大度**: Medium
- **カテゴリ**: 可用性 / レート制限のバイパス
- **場所**: `lib/rate-limit.ts:111-129`（`evictFor`）、特に `:124-128`（`resetAt` 昇順でソートして先頭から退避）
- **説明**: 上限到達時、まず期限切れを回収し、それでも足りなければ **`resetAt` が最も古いエントリから退避する**。
  同一 limiter（＝同一ウィンドウ長）の中では「`resetAt` が最も古い」＝「最初に作られた」であり、
  **上限に達して待たされているバケットこそが最初に退避される**。攻撃者は `maxEntries` 個の新規キーを
  注入するだけで、自分のカウンタを消せる。
  実測（`maxEntries=1000`, `limit=3`, `windowMs=10分`, 実時刻ベース）:
  ```
  攻撃者バケット: used=3 success=false（これ以上通らない）
  → 別キー 1200 件を注入
  攻撃者バケット: used=0 success=true  storeSize=991
  ```
  既定 `maxEntries=10_000` では 10,001 個の異なるキーが必要になる。
  なお異なるウィンドウ長の limiter が **1 つの store を共有**する場合、ウィンドウの短い軸からの
  大量注入では長いウィンドウの軸を退避できないことも実測で確認した（`resetAt` が遠いため生き残る）。
  したがって危険なのは**同一ウィンドウ長の軸に対する同軸注入**である。
- **影響**: 現状の `auth.ts` では 3 つの limiter が**それぞれ独立した store** を持ち（`lib/rate-limit.ts:167`）、
  IP 軸のキー空間 = 実 IP 空間なので「10,000 個の異なるキーを作れる攻撃者」は既に 10,000 倍の
  試行枠を持っている。よって **P2 の管理者ログインにおける実利は小さい**。
  問題は P3 である。未認証エンドポイントではキーが IP 以外（メールアドレス・電話番号・申込 ID・
  セッション ID）になりうるため、**キーの生成コストが実質ゼロになる**。その場合、10,001 件の
  ダミーキーを注入して自分のスロットルを解除する攻撃が現実的なコストで成立する。
- **修正方針**:
  1. **本番では件数上限による退避に依存しない。** `resetAt` に対応する TTL を持つ store
     （Vercel KV / Upstash の `EXPIRE`）を注入し、退避を「起きない状態」にする（SEC-033 と同じ作業）。
  2. インメモリ実装を残す場合、退避方針を「最も古い `resetAt`」から
     **「上限に達していないエントリのうち最も古いもの」**へ変える（＝**スロットル中のバケットは退避しない**）。
     退避先が無ければ**新規キーの受け入れを拒否**して fail-closed に倒す。
  3. あるいは退避を捨て、**キー空間を固定数のバケットへ畳む**（`sha256(key) % N`）。メモリは設計上有界になり、
     退避そのものが不要になる。衝突は「無関係な利用者を巻き込む」方向に効くため、SEC-029 修正方針2 の
     予約枠と組み合わせて使う。
  4. **不変条件をテストに固定する**: 「上限に達したバケットは、他のキーを何件注入しても解除されない」。
     現行の退避テスト（`rate-limit.test.ts` L325-372）は件数と直近キーの残存しか見ておらず、
     **この悪用経路を一切検証していない**。
- **参考**: CWE-400 / CWE-841（Improper Enforcement of Behavioral Workflow）
- **関連**: SEC-023（本指摘の残件）、SEC-033

### [SEC-032] レート制限の IP キーがアドレス単位のため、IPv6 の `/64` ローテーションで完全に回避できる
- **重大度**: Medium
- **カテゴリ**: レート制限のバイパス
- **場所**: `lib/http-guard.ts:107`（採用値をそのまま `key` にする）、`lib/login-guard.ts:63-65`（`loginIpKey`）
- **説明**: IPv6 では 1 契約に `/64`（2^64 アドレス）以上が割り当てられるのが通常で、送信元アドレスの
  変更にコストがかからない。キーがアドレス全体である限り、攻撃者は 1 リクエストごとに別バケットを使える。
  実測（`trustProxy=true`、`x-vercel-forwarded-for` に毎回別の `2001:db8:1:1::N` を設定）:
  ```
  200 試行（毎回別アドレス）→ rate-limited 0 件 / verify（scrypt）実行 200 回
  ```
  SEC-022 の是正はヘッダ**偽装**を塞いだが、**正規の送信元アドレスを合法的に変える**経路は塞いでいない。
  残る防壁はグローバル軸だけで、そのグローバル軸は SEC-029 のとおり管理者締め出しの手段でもある。
- **影響**: P2（管理者ログイン）では、アカウント軸が失敗を計数し続けるため総当たりの観測は残り、
  照合コストの上限もグローバル軸で 100回/分に抑えられる。よって P2 の実害は中程度。
  **P3 では致命的**である。申込フォーム・画像アップロード・チャットは IP 軸が唯一の識別軸になる想定で、
  そこが `/64` ローテーションで無効化されるなら、スパム対策・濫用対策は実質存在しないことになる。
- **修正方針**:
  1. **IPv6 は `/64`（可能なら `/56`）にプレフィックス正規化してキーにする。** IPv4 は `/32` のまま。
     `lib/http-guard.ts` に `rateLimitScopeKey(resolution)` を追加し、`resolveClientIp` の生の値と
     レート制限キーを分離するのが素直である（ログには生の値、制限にはプレフィックス）。
  2. P3 では **IP 単独軸に依存しない**。Turnstile（`TURNSTILE_SECRET` は `lib/env.ts:34` に既に定義済み）
     によるチャレンジ、ハニーポット、送信間隔の下限を併用する（`docs/tech-stack.md` §4.4 のスパム欄と整合）。
  3. **不変条件をテストに固定する**: 「同一 `/64` 内でアドレスを変えても IP 軸の上限に到達する」。
     現行の `client-ip.test.ts` L188 は XFF を変えても上限に達することを検証しているが、
     **`trustProxy=false` の縮退（全部 `unknown`）に依存して成立している**ため、
     Vercel 配下（`trusted=true`）でのローテーション耐性は検証されていない。
- **参考**: CWE-291（Reliance on IP Address for Authentication）/ CWE-770 / OWASP A04:2021
- **関連**: SEC-022（本指摘の残件）

### [SEC-033] 本番でレート制限 store が未注入でも警告も fail-fast も無く、Vercel サーバーレスではレート制限が実質機能しない
- **重大度**: Medium
- **カテゴリ**: 設定 / 可用性 / 認証
- **場所**: `auth.ts:56-58`（3 つの limiter がいずれも `store` 未指定＝プロセス内 Map）、`lib/env.ts`（該当する検証なし）、`lib/kv.ts:12`（「P3 で入れる」との注記のみ）、`lib/kv.ts:22-28`（`checkRateLimit` は `throw` するプレースホルダのまま）
- **説明**: SEC-023 修正方針3（本番で store 未注入なら起動時 fail-fast）は**実装されていない**。
  実装ノートおよびテスト契約は「P3 で `createKvRateLimitStore()` を実装する時点で必須化する」と
  明示的に先送りしている。判断としては理解できるが、**現時点の本番デプロイでは**
  Vercel のサーバーレス関数がインスタンスごとに独立したメモリを持つため、
  - レート制限のカウンタはインスタンス数だけ複製され、実効上限は `limit × インスタンス数`
  - コールドスタートのたびにカウンタが 0 に戻る

  という状態になる。つまり **SEC-009 の「試行回数制御」は本番では名目上しか存在しない**。
  同時に、SEC-029 のグローバル軸による締め出しもインスタンス単位に留まるため、そちらの被害は薄まる。
  防御と欠陥が同じ理由で同時に効かなくなっているだけで、設計として意図された状態ではない。
- **影響**: P2 の管理者ログインについては、scrypt による照合コストと強いパスワードが依然として効くため
  即座の侵害には至らない。**P3 では受け入れられない**。申込フォームやアップロードの濫用対策が
  「インスタンスごと・コールドスタートごとにリセットされるカウンタ」では、意味のある上限にならない。
- **修正方針**:
  1. `lib/kv.ts` を `createKvRateLimitStore(): RateLimitStore` として実装する（判定は複製せず永続化のみ）。
     `consume` に相当する更新は `INCR` + `EXPIRE` の 1 往復にし、**store 側で原子性を確保する**
     （`lib/rate-limit.ts:192-206` のプロセス内直列化は分散環境では効かない。この点は `lib/rate-limit.ts:38-43`,
     `:186-191` に正しく明記されている）。
  2. `lib/env.ts` に「`NODE_ENV=production` かつ `KV_REST_API_URL` / `KV_REST_API_TOKEN` 未設定なら起動失敗」を追加する
     （SEC-013 と同じ `superRefine` の形。`tests/unit/env.test.ts` に同型のテストがある）。
  3. `auth.ts` の 3 つの limiter に KV store を注入する。**軸ごとに異なるキープレフィックスを使い、
     1 つの store を共有しても軸が混ざらないようにする**（現状はプレフィックスで分離済み）。
- **参考**: CWE-1188（Insecure Default Initialization）/ CWE-770
- **関連**: SEC-023 修正方針3（未履行）、SEC-031

### [SEC-034] 同一キー操作の直列化が、遅い store と組み合わさるとホットキーでスループットを崩壊させる
- **重大度**: Low
- **カテゴリ**: 可用性（DoS）
- **場所**: `lib/rate-limit.ts:192-206`（`serialize`）、`lib/login-guard.ts:82`（グローバル軸は常に同一キー `credentials:global`）
- **説明**: RV-P2R-007（TOCTOU）の是正としてキー単位の Promise チェーンが入った。判定の正しさとしては妥当だが、
  **グローバル軸のキーは 1 つしかない**ため、認証エンドポイントへの全リクエストがこの 1 本のチェーンに乗る。
  インメモリ store は `await` 境界で実質同期的に返るので現状は問題にならないが、SEC-033 の是正で
  KV store（ネットワーク往復）を注入した瞬間、**グローバル軸の処理が RTT の直列和**になる。
  実測（1 操作あたり 20ms の store を注入し、同一キーへ 50 並行 `consume`）:
  ```
  50 並行 consume の所要時間: 2103ms（＝完全に直列。並行なら約 40ms）
  ```
  キューには深さの上限が無く、待機中のリクエストは継続クロージャとしてメモリに滞留する。
  `unknown` へ縮退した構成（SEC-030）でも IP 軸が単一キーになるため同じ形になる。
- **影響**: 単独で悪用しても「認証エンドポイントが遅くなる」に留まり、他の経路（公開ページ）は
  別のキーなので影響を受けない。ただし SEC-033 の是正と同時に顕在化するため、**KV 導入と同じ作業単位で
  対処しないと、レート制限の強化がそのまま性能上の単一障害点になる**。
- **修正方針**:
  1. KV 実装では `INCR` + `EXPIRE` の原子操作に落とし、**そのキーについては `serialize` を経由しない**
     （store が原子性を提供する場合はプロセス内直列化が不要であることを `RateLimitStore` の契約に加える）。
  2. グローバル軸はシャード化する（`credentials:global:${instanceId % N}` のような固定数のバケットに分割し、
     上限も N 分割する）。ホットキーが消え、直列化の影響が N 分の 1 になる。
  3. キューの深さに上限を設け、超過分は待たせずに拒否する（fail-closed）。
- **参考**: CWE-400 / CWE-1050
- **関連**: SEC-033

### [SEC-035] 退避処理だけが注入時刻ではなく `Date.now()` を使うため、時刻を注入するテストで退避方針が検証されない
- **重大度**: Info
- **カテゴリ**: テスト品質 / 保守性
- **場所**: `lib/rate-limit.ts:115`（`const now = Date.now()`）— 同モジュールの他の判定はすべて `now` 引数を注入できる
- **説明**: `evictFor` の期限切れ回収だけが実時刻を参照する。本番では実時刻で一貫するため**機能上の問題は無い**。
  問題はテストで、**注入時刻が実時刻より過去だと全エントリが「期限切れ」と判定されて store が空になり**、
  退避方針（最も古い `resetAt` から）が一度も実行されないまま assertion が通る。
  現行テストは `T0 = 1_800_000_000_000`（2027年1月＝実時刻より未来）を使っているため**今は正しく検証できている**が、
  この一致は偶然であり、`T0` を過去の値に変えた瞬間に SEC-023 の件数上限テスト
  （`rate-limit.test.ts` L325-372）は空振りする。実測で確認した:
  ```
  注入時刻 1_000_000（過去）で 12 キー投入, maxEntries=10 → storeSize=2（退避ではなく全消去）
  実時刻で 12 キー投入,          maxEntries=10 → storeSize=10（退避が正しく動作）
  ```
- **修正方針**: `MemoryRateLimitStore.set(key, entry)` に `now` を渡せるようにするか、
  store 生成時に時刻ソース（`() => number`）を注入できるようにする。あわせて `T0` を未来値にしている
  理由をテストにコメントとして残す（現状は「実時間に依存しない」とだけ書かれており、
  未来値であることが契約の一部だと分からない）。
- **参考**: CWE-1099（Inconsistent Naming/Behavior）

### [SEC-036] 失敗ログの内容は有界化されたが、行数の上限は依然として無い
- **重大度**: Info
- **カテゴリ**: ログ / 可用性
- **場所**: `auth.ts:109-120`
- **説明**: SEC-028 が指摘した「攻撃者制御の文字列がそのままログに乗る」問題は**解消している**。
  `ip` は `resolveClientIp` を通り、IP リテラルとして検証済みの 45 文字以下の値か `'unknown'` のいずれかで、
  メールアドレスとパスワードは記録されていない（試行回数のみ）。CWE-117 の観点では是正済みと判定する。
  一方、ログは `decision.outcome !== 'ok'` のたびに出力されるため、**レート制限で拒否されたリクエストも 1 行ずつ記録する**。
  つまりログ行数はレート制限では抑制されず、リクエスト数に比例する。
- **影響**: Vercel のログ取り込み量に直結する（コストと保持枠）。攻撃の可視性を上げる効果もあるため、
  一律に悪いわけではない。SEC-028 と同じ Info とする。
- **修正方針**: `rate-limited` の連続出力は同一キーで集約する（例: ウィンドウごとに 1 行 + 件数）。
  構造化ログ（JSON 1 行）にして保持期間と閲覧権限を決めるのは、P3 で PII を扱う前に必要。
- **関連**: SEC-028（内容面はクローズ、量的側面が残存）

### [SEC-037] `withAdminMutation` は認証依存のため、P3 の未認証変更系エンドポイントには構造的保証が及ばない
- **重大度**: Info
- **カテゴリ**: 設計 / CSRF
- **場所**: `app/api/admin/_guard.ts:63-64`（`auth()` を最初に呼ぶ）
- **説明**: SEC-024 の是正は「変更系は必ずガードを通る」構造を作ったが、そのラッパは `@/auth` に依存し、
  未認証セッションを一律に弾く。P3 の申込 POST・画像アップロード・チャットは**未認証で叩けることが仕様**なので、
  このラッパをそのまま使えない。結果として、P3 のハンドラは再び「`isSameOrigin` を手で呼ぶ」形に戻りうる
  — SEC-024 が構造で潰したはずの失敗モードである。
- **修正方針**: Origin 検証 + Content-Type 検証の部分を認証非依存のラッパ
  （例 `withMutationGuard(handler, { requireContentType, rateLimit })`）として切り出し、
  `withAdminMutation` はそれに `auth()` を足したものとして定義し直す。P3 のハンドラは
  レート制限も含めて**必ずこのラッパを通す**。「ラッパを通していない変更系ハンドラが無いこと」を
  レビューの 1 チェック項目に固定する。
- **関連**: SEC-024

### 副次的に確認したが指摘に至らなかった点

- **タイミング差**: `rate-limited` の応答は `verify()`（scrypt 約 100ms）を実行しないため明確に速い
  （`lib/login-guard.ts:83, 88`）。ただしこれが漏らすのは「レート制限が作動しているか」だけで、
  アカウントの存在・パスワードの正否とは相関しない。E-012-1（アカウント列挙対策）の性質は保たれている。
- **`rateLimitKey` の衝突**: 64 文字超の入力を sha256 先頭 32 hex（128bit）に畳む（`lib/rate-limit.ts:158-163`）。
  IP は 45 文字以下で畳まれず、メールは畳まれても衝突確率が無視できる。生値と畳み値の取り違えも、
  IP がリテラル検証済み・メールが `@` を含むため実質起こらない。
- **`redirectToLogin` / `save` の `NextResponse.redirect(new URL(..., request.url))`**: `trustHost: true` と
  組み合わせると `Host` 偽装で自分自身を任意ホストへ誘導できるが、攻撃者が自分のリクエストを
  リダイレクトさせるだけで第三者に影響しない。全ルートが `force-dynamic` でキャッシュされないため
  キャッシュ汚染にも至らない。SEC-016 / SEC-027（Low, 未解決）の範囲に留まる。
- **`isJsonContentType`**（`app/api/admin/_guard.ts:78-84`）: `;` で分割し小文字化して比較しており、
  `application/json; charset=utf-8` や `+json` サフィックスを正しく扱う。パラメータ注入による回避は見当たらない。

---

## C. P3 着手可否の判定 — 前回 §F の更新

| 前回 §F の必須要件 | 状態 | 根拠 |
|-------------------|------|------|
| **SEC-021**（ロックアウト設計）| **部分達成** | アカウント軸の締め出しは消え、不変条件がテストで固定された。ただし**同じ被害がグローバル軸に残る（SEC-029）** |
| **SEC-022**（キー導出の信頼性）| **達成（残課題 2 件）** | 偽装は塞がれ、出力は有界。残るのは IPv6 粒度（SEC-032）と縮退の意味論（SEC-030） |
| **SEC-023**（エントリ管理）| **部分達成** | 回収・上限・キー正規化は実装済み。**退避が制限解除に悪用でき（SEC-031）、本番の fail-fast は未実装（SEC-033）** |
| **SEC-024**（変更系の構造的ガード）| **達成** | 変更系 5 ハンドラすべてがラッパ経由。E2E が副作用の有無まで検証。ただし**未認証系への拡張は未整備（SEC-037）** |
| **SEC-002**（CSP の P3 前倒し）| **未達** | `next.config.mjs` に変更なし。個人情報入力フォームの前に投入することを引き続き強く推奨 |
| **RV-P2R-005**（CI の build env）| **達成** | `.github/workflows/ci.yml` の `e2e-test` に `AUTH_SECRET` / `POSTGRES_*` を注入済み |

### 判定: **P3 着手可（条件付き）**

**レート制限基盤を「そのまま」未認証エンドポイントへ横展開してよい状態ではない。**
P2.5 は「偽装で制御が無効化される」「キー空間が無制限に増える」「ガードの適用漏れ」という
**構造的な欠陥は解消した**。残っているのは、**未認証・IP 単独軸という P3 固有の条件下でだけ致命的になる欠陥**である。
したがって P3 全体をブロックするのではなく、次の 2 段階の条件を課す。

#### 条件1（P3 の実装着手前に片付ける。いずれも小規模）

| ID | 作業 | 規模 |
|----|------|------|
| **SEC-029** | `lib/login-guard.ts` のグローバル軸 consume を IP ゲート通過後へ移す + 「他者がグローバル上限を使い切っても正しい資格情報は通る」テストを追加 | 数行 + テスト 1 件 |
| **SEC-030** | `lib/http-guard.ts:83-85` / `docs/tech-stack.md:199-200` / テスト契約の**誤った記述を訂正**し、`trusted=false` 時のポリシーを決める | 文書 + 分岐 1 箇所 |

この 2 件を先に済ませる理由は、**どちらも「正規利用者が締め出される」という P2 で既に一度踏んだ轍**であり、
かつ P3 の設計判断（未認証エンドポイントでどの軸をゲートに使うか）の前提になるためである。

#### 条件2（P3 のレート制限実装と同一の作業単位で満たす。これらが未達なら F-010 は完了と見なさない）

| ID | 受け入れ条件 |
|----|------------|
| **SEC-033** | `lib/kv.ts` が `createKvRateLimitStore(): RateLimitStore` を実装し、`INCR` + `EXPIRE` で原子的に更新する。`lib/env.ts` が本番での KV 未設定を fail-fast する。`auth.ts` と P3 の全エンドポイントが KV store を注入して使う |
| **SEC-032** | レート制限キーが IPv6 を `/64` に正規化する。かつ IP 単独軸に依存せず、Turnstile / ハニーポット / 送信間隔下限を併用する |
| **SEC-031** | 本番経路で件数上限による退避が発生しない（TTL による自然消滅）。インメモリ実装を残す場合は「上限に達したバケットは退避しない」へ方針変更。「他キーを何件注入しても自分のスロットルは解除されない」をテストで固定 |
| **SEC-034** | KV 導入後、グローバル軸（およびホットキー）で直列化がスループットの単一障害点にならないこと（原子操作を使う場合は `serialize` を経由しない、またはシャード化） |
| **SEC-037** | Origin / Content-Type 検証を認証非依存のラッパへ切り出し、P3 の変更系ハンドラが**全て**それを通る |
| **SEC-002** | 個人情報を入力するフォームページの公開と同時に CSP を投入する（P5 からの前倒し。前回から変更なし） |

### P3 の未認証エンドポイント実装時に守るべき具体的要件

**レート制限基盤の使い方（`lib/rate-limit.ts` / `lib/login-guard.ts` の設計から導かれる規約）**

1. **判定ロジックを複製しない。** `createRateLimiter` を使い、永続化は `RateLimitStore` の注入で切り替える。
   `lib/kv.ts` に判定を書き直さない（`lib/rate-limit.ts:12-14` の方針を維持する）。
2. **照合前ゲートに使ってよいのは「攻撃者自身に閉じた軸」だけ**（`lib/login-guard.ts:14-17` の原則）。
   P3 では「申込者のメールアドレス」「電話番号」を**ゲートに使わない**。使うと SEC-021 と同型の
   「第三者が特定の人の申込をブロックできる」欠陥になる。これらの軸は**失敗・重複の計数と観測**に限る。
3. **キー導出は必ず `resolveClientIp` → `rateLimitKey` を通す。** 生のヘッダ値・ユーザー入力を直接キーにしない。
   `ClientIpResolution.trusted` を**必ず参照し**、`false` のときはゲートの意味論を変える（SEC-030）。
4. **グローバル軸は「全体の流量制御」であり「利用者を止める手段」ではない。** 到達時に正規利用者が
   巻き込まれる設計にしない（予約枠 / 段階的な劣化 / CAPTCHA へのフォールバック）。
5. **軸ごとにキープレフィックスを分ける**（`applications:ip:` / `uploads:ip:` / `chat:ip:` 等）。
   1 つの KV を共有してもよいが、**同一ウィンドウ長の軸に大量キーを注入されて他バケットが
   退避されないこと**を TTL で担保する（SEC-031）。
6. **閾値と根拠を必ず文書化する**（`docs/tech-stack.md` §6 で F-010 実装時に確定と既に宣言されている）。
   「正規利用者が到達しないこと」を実測で示すこと（P2.5 でグローバル軸 100回/分について行われた形式が良い前例）。

**変更系ハンドラの規約**

7. 未認証を含むすべての変更系ハンドラは**共通ラッパ経由**にする（SEC-037）。ラッパは
   `Origin 検証（fail-closed）→ Content-Type 検証 → レート制限 → 本体` の順で評価する。
   レート制限を本体より前に置くのは、DB アクセスとファイル I/O を攻撃者に消費させないためである。
8. `GET` にラッパを適用しないという現行の判断（`app/api/admin/_guard.ts:19`）は P3 でも維持してよいが、
   **副作用を持つ `GET` を作らない**ことが前提になる。

**ファイルアップロード（F-009 / F-018）— 前回 §C の再掲と補強**

9. サイズ上限・MIME 検証・拡張子とマジックバイトの整合をサーバー側で行う。
   レート制限は**バイトを受け取る前**に評価する（受信してから拒否では帯域と一時領域を守れない）。
10. 免許証画像は非公開 Blob に置き、署名 URL の有効期限を短くする。ログにファイル名・PII を出さない（SEC-036）。

---

## D. 繰越事項の現状

| ID | 深刻度 | 現状 | 根拠 |
|----|--------|------|------|
| **SEC-002**（CSP / HSTS 未設定）| Medium | **未解決** | `next.config.mjs` に変更なし。**P3 と同時投入を強く推奨**（個人情報入力フォームで XSS が成立したときの被害が大きい） |
| **SEC-025**（seed ガードが `NODE_ENV` 基準）| Low | **未解決** | `lib/seed-guard.ts` に変更なし。P2.5 スコープ外と明示 |
| **SEC-026**（`AUTH_SECRET` が長さのみの検証）| Low | **未解決** | `lib/env.ts:43-52` は長さ下限のみ。プレースホルダ拒否・エントロピー検証は未実装 |
| **SEC-027**（Origin 検証の基準がリクエスト由来）| Low | **未解決** | `lib/http-guard.ts:26` は `new URL(request.url).origin` のまま。§A の実測で `Host` と `Origin` が揃えば `true` になることを再確認。ブラウザ経由の CSRF では成立しないため据え置き。`AUTH_URL` / `NEXT_PUBLIC_SITE_URL` を第一基準にする修正は P3 の公開フォームと同時が効率的 |
| **SEC-028**（ログの攻撃者制御文字列と出力量）| Info | **内容面は解決 / 量的側面は未解決** | `auth.ts:114` の `ip` は検証済み IP リテラルまたは `unknown` で有界。行数上限は無い（→ SEC-036） |
| **SEC-014**（存在しない ID の保存/削除が 500）| Low | **未解決** | `save/route.ts` / `delete/route.ts` に存在確認も try/catch も無い（`[id]/route.ts` の PUT/DELETE には存在確認あり） |
| **SEC-015**（セッション有効期限 30日）| Low | **未解決** | `auth.config.ts:32` は `session: { strategy: 'jwt' }` のみ。`maxAge` / `updateAge` 指定なし |
| **SEC-016**（`trustHost: true` の前提）| Low | **一部改善のまま** | `auth.config.ts:31` 据え置き。ただし `docs/tech-stack.md` §4.5 が新設され、**信頼するヘッダと前提の文書化という修正方針4 は達成された**。デプロイ手順書への記載は未対応 |
| **SEC-017**（依存関係の既知脆弱性 / CI の `pnpm audit`）| Low | **未解決** | `package.json` / `pnpm-lock.yaml` に変更なし。`.github/workflows/ci.yml` に `pnpm audit` ジョブ無し。**P3 前に入れると以後の回帰を防げる**（P1 SEC-006 から継続） |
| **SEC-018**（相対 / プロトコル相対 `href`）| Info | 未解決（任意対応）| `lib/markdown/renderSafe.ts` に変更なし |
| **SEC-019**（仕様と実装 API の乖離）| Info | **未解決** | `docs/functional-spec.md` F-014 は未更新。SEC-024 は共通ラッパで構造的に解決したため、乖離が適用漏れを招くリスクは下がったが、攻撃面の一覧としては依然使えない |
| **SEC-020**（公開側サーバー描画経路）| Info | 未解決（P3 申し送り）| 変更なし |
| **SEC-001**（本文サニタイズ）| — | **解決済み（維持）** | `lib/markdown/renderSafe.ts` に変更なし |

**参考（スコープ外の観察）**: `.github/workflows/ci.yml` の `integration-test` ジョブには PostgreSQL サービスが
定義されておらず、`pnpm test:integration`（dev DB :5433 前提）は CI では通らない構成に見える。
セキュリティ指摘ではないが、**品質ゲートが CI で実際に回っていない可能性**があるため記録する。

---

## E. 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **0** |
| Medium | 5 新規（SEC-029 / SEC-030 / SEC-031 / SEC-032 / SEC-033）＋ 繰越 SEC-002 |
| Low | 1 新規（SEC-034）＋ 繰越 SEC-014〜SEC-017 / SEC-025 / SEC-026 / SEC-027 |
| Info | 3 新規（SEC-035 / SEC-036 / SEC-037）＋ 繰越 SEC-018〜SEC-020 / SEC-028（量的側面）|

### リリース判定: **リリース可能**（Critical 0 / High 0。監査スキルのブロック基準を満たす）

### P3 着手判定: **条件付きで着手可**（§C の条件1 を先行、条件2 を P3 の完了条件とする）

### 正直な評価

P2.5 は**やるべきことをやっている**。SEC-024 は共通ラッパで構造的にクローズし、E2E が副作用の有無まで
実測している。SEC-022 のヘッダ偽装は塞がれ、キー長は有界になった。SEC-023 の回収・上限・正規化も入った。
SEC-021 の中核不変条件（「他者の失敗で正規管理者が締め出されない」）は実測で成立を確認した。
**「テストが green でも本番経路が守られていない」型の失敗は、今回は起きていない。**

一方で、前回と同じ構図が 1 つ繰り返された。**SEC-021 の是正が、被害クラスをアカウント軸から
グローバル軸へ移しただけで消し切れていない（SEC-029）** という点である。これは実装の逸脱ではなく、
テスト契約（`docs/review-p25-tests-2026-07-28.md` T1「要求する処理順序」）が
`global.consume` を最初に置くと明記し、実装がそれに忠実だった結果である。
**SEC-021 で学んだ「正しい資格情報が拒否される状態を作らない」という不変条件を、
新しく追加した軸へ適用し直す作業が抜けていた。** 新しい防御を足すときは、
その防御自身に対して既存の不変条件を再適用すること — これが今回の教訓である。

もう 1 つ記録すべきは、**文書とコードコメントに事実と異なる記述が入った**こと（SEC-030）である。
「`unknown` 縮退でも正規管理者は締め出されない」という記述は、`docs/tech-stack.md`・
`lib/http-guard.ts` のコメント・テスト契約の 3 箇所に同じ形で書かれており、実測では成立しない。
文書は P3 の設計判断の入力になるため、この種の誤りは実装の欠陥より広く伝播する。

### 是正の優先順位

1. **SEC-029**（Medium / 可用性）— 数行の順序変更 + テスト 1 件。**P3 着手前**
2. **SEC-030**（Medium / 可用性・文書）— 誤記述の訂正 + `trusted` フラグの活用。**P3 着手前**
3. **SEC-033**（Medium / 設定）— KV store 実装 + 本番 fail-fast。**P3 のレート制限と同時。これが無いと P3 の濫用対策は成立しない**
4. **SEC-032**（Medium / バイパス）— IPv6 `/64` 正規化 + 多軸化。**P3 と同時**
5. **SEC-031**（Medium / バイパス）— 退避方針の変更または TTL 依存への移行。**P3 と同時**
6. **SEC-002**（Medium / 繰越）— CSP。**P3 の公開フォームと同時**
7. SEC-034 / SEC-037（Low / Info）— P3 の実装単位に含める
8. SEC-035 / SEC-036、SEC-025〜027、SEC-014〜017（Low / Info / 繰越）— 計画的に。**SEC-017 の CI 組み込みは P3 前が費用対効果が高い**

### テストへの申し送り（Test Agent）

今回の欠陥はいずれも「防御が動くこと」は検証されているが「防御が悪用されないこと」が
検証されていない箇所から出た。P3 のテスト設計では以下を契約として固定すること。

- **グローバル軸の巻き込み**: 他者がグローバル上限を使い切った直後でも、正しい資格情報のログインは成功する（SEC-029）
- **縮退時の意味論**: `trusted=false` の環境で、他者の失敗が正規利用者のリクエストを止めない（SEC-030）
- **退避の悪用**: 上限に達したバケットは、他キーを `maxEntries` 件注入しても解除されない（SEC-031）
- **IPv6 ローテーション**: `trusted=true` の環境で、同一 `/64` 内のアドレスを変えても IP 軸の上限に到達する（SEC-032）
- **本番設定の fail-fast**: `NODE_ENV=production` かつ KV 未設定なら起動に失敗する（SEC-033）
- **未認証変更系のガード**: P3 の変更系ハンドラすべてに対する Origin 欠落 / クロスオリジン / 非対応 Content-Type の拒否（SEC-037）

---

# P2.5-b 是正の申し送り（Impl Agent 記録 / 2026-07-28）

> この節は **Impl Agent が追記した是正報告**である。上記 §B の各指摘（Security Agent の所見）は
> 一切書き換えていない。再監査の判定は Security Agent が別途行うこと。
> 実装内容と実測値の詳細は `docs/impl-p25b-notes-2026-07-28.md`。

## 受容した残余リスク（「消した」のではない）

P2.5-b では SEC-029 / SEC-030 が実測した攻撃経路を閉じたが、**共有軸による締め出しという
脅威クラス自体は構造的に残っている**。以下は「解消済み」ではなく「**受容した残余リスク**」として記録する
（RV-P25-001 の要求 / `docs/review-p25b-tests-2026-07-28.md` §T1 残余リスク）。

### 残余リスク1: グローバル軸の分散枯渇（SEC-029 の残余）

**独立した発信元 30**（`global.limit / ip.limit + globalReserve.limit` = 100/10 + 20）を持つ攻撃者は、
依然として正規管理者のログインを窓ごと止められる（総リクエスト 120回/分）。

> **【2026-07-29 訂正 / SEC-038】** 本節は当初「必要な独立 IP 数が **1 → 120 超**になった」と記していたが、
> **これは誤りである。120 は総リクエスト数であって発信元数ではない。**
> 予約枠の判定基準は `cleanSource`（＝その発信元の1回目の試行か）であって「正規利用者か」ではないため、
> **攻撃者の新品 IP は常に予約枠を引ける**（1 IP あたり 1 リクエストで引き切れる）。
> 監査者の再実測（S2/S10）では **10 IP × 10req でグローバル軸を枯渇 + 新規 20 IP × 1req で予約枠を枯渇 = 独立 IP 30**。
> したがってコスト上昇は 120 倍ではなく **4 倍（1 → 30）** である。
> さらに **`trusted=false` の縮退時は `cleanSource` が常に true になるため、単一ホスト 121req/分で成立する
> （必要発信元数は 1 のまま＝コストは上がっていない）**（S3/E5）。本番は Vercel 集約（`trusted=true`）のため実害なし。
> 受容判断自体は P2 のスコープでは維持するが、**根拠の数値はこの訂正後の実測値を使うこと。**

- Impl による実測（`lib/login-guard.ts` へ直接投入）:
  - 150 個の独立発信元が 1 回ずつ失敗 → グローバル軸 100/100・予約枠 20/20 が枯渇
    → 失敗履歴の無い正規管理者・正しいパスワードで `{"outcome":"rate-limited","verified":false}`
  - （※ 150 は「120 超が必要」という誤った前提で選ばれた数であり、実際の閾値は 30。上記訂正を参照）
- SEC-029 が実測した「単一 IP からの封鎖」は成立しなくなった（同シナリオの実測は `ok` / `verified=true`）。
- **固定ウィンドウのカウンタを照合前ゲートに使う限り、この性質は消えない。**
  予約枠は攻撃者に必要な発信元数を増やすだけである。
- 構造的な解は SEC-022 修正方針3 の第一候補「**同時実行中の scrypt 数を上限とするセマフォ**」
  （処理完了で自動解放されるため枯渇せず、過負荷時の症状が「拒否」ではなく「待ち」になる）。
- **P3 で未認証エンドポイントへ横展開する際に、グローバル軸をセマフォへ置き換えるかを必ず再評価する。**
  未認証経路では正規利用者の母数が管理者より桁違いに多く、共有軸の締め出しがそのままサービス停止になる。

### 残余リスク2: 縮退時のグローバル軸（SEC-030 の残余）

`trusted === false` でも**グローバル軸は硬い照合前ゲートのまま**である。したがって縮退した配置では、
グローバル枠 + 予約枠を使い切れる攻撃者は全利用者を止められる。P2.5-b が閉じたのは
「共有 `unknown` バケット由来の締め出し」（SEC-030 が実測した経路。10req/10分で成立していた）までである。

- 緩和策は運用側: **Vercel 以外へ配置する場合は `trustProxy` を必ず有効化すること**
  （`docs/tech-stack.md` §4.5 / SEC-030 修正方針3）。
- 縮退時は「発信元あたりの推測回数を縛る」ことが定義上できないため、ブルートフォース耐性は
  IP 軸（10回/10分）ではなくグローバル軸 + 予約枠（120回/分）の上限まで低下する。この代償も受容済み。

## 事実に反する記述の訂正（SEC-030 / RV-P25-002 の Must Fix 本体）

「信頼境界外でも正しい資格情報は常に通るので締め出されない」という**誤った記述**を 3 箇所で訂正した。

| 箇所 | 対応 |
|---|---|
| `lib/http-guard.ts`（`resolveClientIp` の docstring） | 誤りであった旨を明記し、`trusted` を呼び出し側が必ず見る要件と縮退の代償に書き換え |
| `docs/tech-stack.md` §4.5 | 取り消し + 訂正ブロックを追加し、訂正後の意味論・代償・残余リスクを記載 |
| `docs/review-p25-tests-2026-07-28.md` §T2 結論3 / §T1 処理順序 | 該当記述に取り消し線と訂正注記。旧契約の処理順序（SEC-029 の原因）も撤回として明示 |

## スコープ外（P3 と同一作業単位で対応）

SEC-031 / SEC-032 / SEC-033 / SEC-034 / SEC-037 / SEC-002 には**着手していない**（fix-plan のスコープ外指定に従った）。

---

# P2.5-b 再監査（2026-07-29）

## 監査日: 2026-07-29
## 対象: P2.5 ハードニング監査 §C 条件1（SEC-029 / SEC-030 の是正）の検収と、P3 横展開可否の最終判定

### 監査の方法（前回と同じ原則）

前回 P2.5 では「**red だったテストが全部 green になっても脅威が閉じていない**」が起きた。したがって今回も
**テストの green を完了根拠として採用していない**。`docs/impl-p25b-notes-2026-07-28.md` §6 の Impl 自己検証も
根拠として採用せず、`lib/login-guard.ts` / `lib/rate-limit.ts` へ **監査者自身が `tsx` で攻撃シナリオを直接投入**し、
すべての判定を実測で行った。軸設定は `auth.ts:66-69` と同一（ip 10回/10分・account 5回/15分・
global 100回/分・globalReserve 20回/分）。以下の実測値（S1〜S10 / E1〜E5）はすべて本監査で取得したものである。

品質ゲート（unit 179 / integration 28 / e2e 82 全パス、type-check・lint クリーン、build 成功、
テスト改竄なし）はオーケストレーターが独立実行済みのため再実行していない。
`tests/unit/login-guard.test.ts` の SEC-029 / SEC-030 系アサーション（L548-551 / L639-640 / L713 /
L794-797 / L817 / L860-861）は目視で確認し、契約を弱める書き換えは無い。

---

## A. SEC-029 / SEC-030 のクローズ判定表

| ID | 判定 | 根拠（file:line） | 監査者自身の実測 |
|----|------|------------------|-----------------|
| **SEC-029** | **クローズ**（`trusted=true` の配置＝本番想定の Vercel）| `lib/login-guard.ts:131`（IP ゲートが `consume` の判定結果そのもの）/ `:147-156`（グローバル軸の consume が **IP ゲート通過後**へ移動。枯渇時は `:153` の予約枠）/ `auth.ts:69`（`LOGIN_GLOBAL_RESERVE_LIMITER` 20回/分）/ `tests/unit/login-guard.test.ts:520-717` | **S1**: 前回監査の実測手順（単一 IP から 120 リクエスト）を再実行 → `global used=10/100  reserve used=0/20  scrypt=10`、別 IP の正規管理者は `{"outcome":"ok","retryAfterMs":0,"verified":true}`。**再現しない**。単一 IP がグローバル軸へ寄与できる量が IP 軸の上限 10 で頭打ちになったことを確認 |
| **SEC-030** | **クローズ** | `lib/login-guard.ts:136`（`trusted && !gate.success` のときだけ拒否）/ `:141`（縮退時の `cleanSource`）/ `:175-177`（縮退時に緩む方向へも壊さない）/ `auth.ts:107-110`（`resolveClientIp().trusted` を `attempt()` へ）/ `lib/http-guard.ts:86-99`（誤記述の訂正）/ `docs/tech-stack.md:204-220`（訂正ブロック）| **S4**: 前回の実測手順（`trusted=false` で他者が 12 回失敗 → 共有バケット `used=10/10`）→ 正規管理者は `{"outcome":"ok","verified":true}`。**再現しない**。**S5**: 枯渇後の誤資格情報は `rate-limited`（`verified=true`）、成功ログイン後も `invalid-credentials` で **fail-open なし**。**S6**: 縮退時に 500 リクエストを投入しても `verify()` の実行は **120 回で頭打ち**（= global 100 + reserve 20）＝ **CPU DoS の抜け穴になっていない** |
| **SEC-035** | **クローズ** | `lib/rate-limit.ts:88-98`（`MemoryRateLimitStoreOptions.now`）/ `:117`（`clock`）/ `:128`（`evictFor` が `clock()` を使用）| **E1**: 注入した時刻ソースが `evictFor` から **3 回呼ばれた**（未修正なら 0）。注入時刻を未来にすると期限切れ優先の回収が実際に動き `storeSize=1` になることを確認 — すなわち **SEC-031 の検証が可能な状態になった** |

### SEC-029 の受け入れ条件（fix-plan 行1）の literal な充足

> 「他者がグローバル上限を使い切っても、正しい資格情報でのログインは通る」

**充足する。ただし成立範囲は「失敗履歴の無い発信元」に限られる**（`lib/login-guard.ts:141,152`）。
実測 **S9**: 正規管理者が**1 回タイプミスした後**に、他者がグローバル枠を枯渇させた状態で正しい
パスワードを送ると `{"outcome":"rate-limited","retryAfterMs":60000,"verified":false}` になる。
予約枠は `cleanSource`（IP 軸のカウントが 0）にしか開かれていないためである。
仕様どおりの挙動であり Must Fix には当たらないが、**不変条件が無条件には成立していない**ことは
記録しておく（→ SEC-038 修正方針3）。

---

## B. 新規指摘（SEC-038 以降）

### [SEC-038] 受容した残余リスクの攻撃コスト記述が実測と一致せず、縮退構成では SEC-029 の脅威がほぼそのまま残る
- **重大度**: Medium
- **カテゴリ**: 可用性（DoS）/ 文書の正確性
- **場所**: `docs/tech-stack.md:237-241`, `:251-253`、`docs/security-audit.md:1369-1378`（Impl 追記節）、
  `docs/impl-p25b-notes-2026-07-28.md` §6.2、`lib/login-guard.ts:141`（縮退時 `cleanSource = true`）、
  `auth.ts:59-60`（閾値コメント）
- **説明**: 文書は受容した残余リスクを次のように定量化している。
  > 予約枠は攻撃者に必要な IP 数を増やす（**1 → 120 超**）だけで、ゼロにはしない。 — `docs/tech-stack.md:241`

  **この数値は両方の構成で実測と一致しない。**

  **(a) `trusted=true`（Vercel 想定）— 必要なのは 120 超ではなく 30 の独立発信元**
  ```
  [S2/S10] 10 IP × 10req  → グローバル軸 100/100 枯渇（1 IP あたりの寄与は IP 軸上限の 10）
           + 新規 20 IP × 1req → 予約枠 20/20 枯渇（新規 IP は必ず cleanSource なので予約枠を引ける）
           合計 独立 IP 30 / 総リクエスト 120 / scrypt 120
           失敗履歴の無い正規管理者・正しいパスワード:
             {"outcome":"rate-limited","retryAfterMs":60000,"verified":false}
  ```
  予約枠の判定基準は「**その発信元の 1 回目の試行か**」であって「正規利用者か」ではない。攻撃者の
  **新品の IP は常にこの条件を満たす**ため、予約枠は 1 IP あたり 1 リクエストで引き切れる。
  必要な独立 IP 数は `global.limit / ip.limit + globalReserve.limit` = 10 + 20 = **30** であり、
  文書の 120 は**総リクエスト数であって発信元数ではない**（実測一致: 総リクエスト 120 / IP 30）。

  **(b) `trusted=false`（`VERCEL` 未設定＝ `next start` 直公開 / ローカル / オンプレ）— 必要な発信元は 1**
  ```
  [S3/E5] 単一 IP から 121 リクエスト（trusted=false）
          → global 100/100・reserve 20/20 枯渇・scrypt 120
          正規管理者・正しいパスワード:
            {"outcome":"rate-limited","retryAfterMs":60000,"verified":false}
  ```
  縮退時は `cleanSource` が常に `true`（`lib/login-guard.ts:141`）なので、**攻撃者自身が予約枠を引ける**。
  予約枠の設計前提（「攻撃者は自分の IP 軸を消費しているので予約枠を引けない」— `lib/login-guard.ts:76-78`）は、
  IP 軸が存在しない縮退時には成立しない。結果として、**SEC-029 が実測した脅威（単一ホスト・認証不要・
  管理者メールの知識不要で全管理者を封鎖）は、縮退構成では攻撃コストが 100req/分 → 121req/分 に
  変わっただけでそのまま残っている**。
- **影響**: 本番は Vercel 集約が確定しており（`docs/phase-status.md:7`）`VERCEL=1` で `trusted=true` になるため、
  **本番の実害は無い**。実害があるのは (b) が該当する `next start` 直公開のデモ運用・ローカル・オンプレ検証で、
  これは SEC-030 が実害範囲として挙げた構成と同一である。
  より重要なのは**受容判断の根拠が誤った数値に依存している**ことである。「必要 IP 数 1 → 120 超」という
  120 倍のコスト上昇を前提に受容が行われているが、実測は `trusted=true` で 4 倍（1 → 30）、
  `trusted=false` では **1 倍（1 → 1）** である。P2.5 の SEC-030 と同型の欠陥（文書に事実でない記述が
  固定され、それが次フェーズの設計判断の入力になる）が、**その指摘に応えて新設された残余リスク節で再発している**。
- **修正方針**:
  1. `docs/tech-stack.md:237-241` / `docs/security-audit.md:1369-1378` の数値を実測値へ訂正する。
     必要独立 IP 数は `global.limit / ip.limit + globalReserve.limit`（現行 **30**）である。
  2. `trusted=false` の残余リスク（`docs/tech-stack.md:251-253`）に**攻撃コストを明記する**:
     「**単一ホストから 121リクエスト/分で成立する**」。現在の記述（「グローバル枠 + 予約枠を使い切れる
     攻撃者は全利用者を止められる」）は正しいが、読み手は (a) の「120 超の独立発信元」を前提に読むため
     コストを 2 桁見誤る。
  3. 「正しい資格情報は通る」の成立範囲（**失敗履歴の無い発信元に限る**。S9）を不変条件の記述に併記する。
  4. 受容判断そのものは **P2 のスコープでは維持してよい**（§D の評価を参照）。訂正すべきは根拠の数値である。
- **参考**: CWE-645 / CWE-1053 / OWASP A04:2021
- **関連**: SEC-029、SEC-030（同型の「文書が事実と異なる」欠陥）、SEC-039

### [SEC-039] 成功時の `ip.reset()` により、単一の発信元が IP 軸の上限を超えてグローバル枠を消費できる
- **重大度**: Low（P2）/ **P3 では設計上の前提が崩れる**
- **カテゴリ**: レート制限のバイパス / 可用性
- **場所**: `lib/login-guard.ts:163`（`await limiters.ip.reset(ipKey)`）、`auth.ts:54`（閾値コメント）
- **説明**: `auth.ts:54` は「**単一 IP が寄与できる量は IP 軸の上限（10回/10分）で頭打ちになる**」と述べ、
  SEC-029 のクローズもこの性質に依存している。しかし IP 軸は**認証成功で reset される**ため、
  有効な資格情報を 1 つ持つ発信元はこの上限を何度でも解除できる。
  ```
  [S8] trusted=true / 単一 IP（有効な資格情報を 1 つ保持）
       「9 回失敗 → 1 回成功」を繰り返す
       → 102 リクエストで scrypt 102 回・グローバル軸 100/100 を単独で枯渇
  ```
  この状態から新規 IP 20 個で予約枠を引き切れば、**独立 IP 21 個で全管理者を締め出せる**
  （S10 の 30 個よりさらに安い）。
- **影響**: P2 では有効な管理者資格情報が必要で、本デモの管理者アカウントは 1 つのため**実利は小さい**（Low）。
  **問題は P3 である。** 未認証エンドポイント（申込 / アップロード / チャット）では「成功」が
  **正常な利用結果**であり、`reset-on-success` + 「カウント 0 = 予約枠の資格」を素直に横展開すると、
  「1 回正常送信するたびに自分の枠が全消去され、かつ予約枠の対象に戻る」ことになり、
  **発信元あたりの上限という概念が実質的に消える**。SEC-029 の修正が依拠するコストモデル
  （「攻撃者は必ず自分の軸を消費する」）が、そこでは成立しない。
- **修正方針**:
  1. `auth.ts:54` のコメントを「**認証に成功しない限り** 10回/10分で頭打ち」に訂正する（P2 の対応はこれで足りる）。
  2. P3 では `reset-on-success` をそのまま持ち込まない。正常系が頻繁に成功する経路では、
     成功時にカウンタを全消去せず「失敗分のみ減算」または「成功にも別枠の上限を課す」形にする。
  3. 予約枠の資格を「カウントが 0」ではなく「**過去に成功実績があり、かつ現ウィンドウで失敗していない**」など、
     攻撃者の新品発信元が自動的には満たさない条件へ変える（SEC-038 と同根）。
- **参考**: CWE-837
- **関連**: SEC-029、SEC-038

### [SEC-040] 縮退時の成功ログインが共有 `unknown` バケットを全員分クリアする
- **重大度**: Info
- **カテゴリ**: 可用性 / 観測性
- **場所**: `lib/login-guard.ts:163`（`trusted === false` でも `ip.reset(ipKey)` が走る）
- **説明**: Impl が §6.3 で自己申告し「再監査で扱いを判断されたい」とした挙動を、**攻撃に使えるかという
  観点で独立に検証した**。
  ```
  [S5] 縮退時 共有バケット used: 成功ログイン前 10 → 成功ログイン後 0
  [S7] 「10 回失敗 → 1 回成功」を 5 サイクル反復
       共有バケットは毎回 10 → 0 にリセットされる
       しかし global used=55/100 / reserve used=0/20 は**リセットされない**（上限は維持）
  ```
- **影響**: **攻撃には使えない。** 縮退時の共有バケットは照合前ゲートに使われていない（SEC-030 の是正）ため、
  クリアされてもコスト保護は緩まない。コスト保護を担うグローバル軸・予約枠は reset の対象外であり、
  実測でも上限は維持された。fail-open も発生しない（S5）。したがって「攻撃者が正しい資格情報を 1 つ持つ場合」も
  「正規利用者のログインを誘発できる場合」も、**レート制限を繰り返しリセットすることはできない**。
  唯一の実害は**契約 T2-b の観測可能性**で、共有バケット枯渇後の失敗は `rate-limited` を返す約束
  （`lib/login-guard.ts:175-177`）が、**誰か 1 人が成功ログインすると `invalid-credentials` に戻る**。
  攻撃検知のシグナルとしては当てにならない。
- **修正方針**: `trusted === false` のときは `ip.reset` を**行わない**（共有バケットは他人のカウンタでもあり、
  1 利用者の成功で全員分を消す理由が無い）。1 行の分岐で足りる。P3 で共有バケットを持つ設計を採る場合は必須。
- **関連**: SEC-030、SEC-039

### [SEC-041] SEC-031（退避の悪用）に「予約枠の資格が復活する」という帰結が追加された
- **重大度**: Low（状況は**わずかに悪化**。ただし P2 で悪用可能ではない）
- **カテゴリ**: レート制限のバイパス
- **場所**: `lib/rate-limit.ts:137-141`（`resetAt` 昇順の退避。未修正）、`lib/login-guard.ts:141`（`cleanSource`）
- **説明**: 依頼事項「SEC-031 自体は P3 スコープだが状況が悪化していないか」を実測で確認した。
  ```
  [E2] SEC-031 は未修正のまま再現する:
       攻撃者バケット used=3 success=false → 別キー 1200 件を注入 → used=0 success=true（storeSize=991）
  [E3] 加えて新しい帰結: ゲート拒否された攻撃者 IP が自分のエントリを退避させると
       IP 軸カウンタが 0 に戻り、cleanSource が復活する
       退避前 {"outcome":"rate-limited","verified":false}
       退避後 {"outcome":"invalid-credentials","verified":true}（照合が再開され、予約枠も引ける）
  ```
  P2.5-b が予約枠を導入したことで、退避の悪用は「自分のスロットルを解除する」だけでなく
  「**正規利用者用に確保したはずの予約枠を引く資格を取り戻す**」意味も持つようになった。
- **影響**: `trusted=true` の配置ではキーが検証済み IP リテラルに限られ（`lib/http-guard.ts:121`）、
  退避には既定 `maxEntries=10,000` を超える異なる IP が要る。Vercel 配下では XFF を偽装できないため
  **P2 で悪用可能な経路ではない**（SEC-031 の当初評価と同じ）。記録の目的は、SEC-031 を P3 で修正する際に
  **予約枠との相互作用も同時に潰す**必要を明示するためである。
- **修正方針**: SEC-031 の既存の修正方針（TTL 依存 /「上限に達したバケットは退避しない」/ キー空間の固定畳み込み）
  をそのまま適用すれば本件も消える。受け入れ条件に「**退避によって予約枠の資格が復活しないこと**」を追加する。
- **関連**: SEC-031、SEC-029、SEC-038

### 副次的に確認したが指摘に至らなかった点

| 観点 | 実測 | 判定 |
|------|------|------|
| 縮退時の fail-open（誤った資格情報が通らないか）| S5: 枯渇後の誤資格情報は `rate-limited`（成功ログイン前）/ `invalid-credentials`（成功ログイン後）。いずれも `outcome !== 'ok'` | **問題なし**。`auth.ts:128` はどちらも `null` を返すため、クライアントから見た差も無い |
| 縮退時の CPU DoS | S6: 500 リクエストでも `verify()` は 120 回で頭打ち | **問題なし**（コスト保護はグローバル軸 + 予約枠が担うという T2-DECISION どおり） |
| `trusted=true` のブルートフォース耐性 | S1: 同一 IP は 11 回目以降 `rate-limited` / `verified=false`、scrypt は 10 で停止 | **維持されている** |
| グローバル軸・予約枠のキー空間 | E4: `credentials:global` / `credentials:global-reserve` の単一キー | **問題なし**（メモリ増殖の経路にならない） |
| 予約枠だけを先に枯渇させる経路 | `lib/login-guard.ts:149-155`。`global.success === false` のときしか `globalReserve.consume` に到達しない | **存在しない** |
| グローバル軸で拒否された試行がアカウント軸に計上されない | `lib/login-guard.ts:152,154` の `denied()` は `account.consume` に到達しない | 設計どおり（`verify()` が走っていないので失敗計数の対象外）。**指摘に至らず** |
| 実装が `trusted` を必ず受け取るか | `auth.ts:110` `const trusted = resolved?.trusted ?? false`。`request` 取得不能時も縮退側へ倒れる | **fail-closed 側**。問題なし |

---

## C. P3 着手可否の最終判定

### 条件1（前回 §C）の充足判定

| ID | 前回課した作業 | 判定 | 根拠 |
|----|--------------|------|------|
| **SEC-029** | グローバル軸 consume を IP ゲート通過後へ移す + 「他者がグローバル上限を使い切っても正しい資格情報は通る」テストを追加 | **達成** | `lib/login-guard.ts:147-156` で順序を移動。実測 S1 で前回の攻撃手順が再現しないことを確認。テストは `tests/unit/login-guard.test.ts:520-717`（T1-a〜T1-f） |
| **SEC-030** | 誤記述の訂正（3 箇所）+ `trusted=false` 時のポリシー決定 | **達成** | `lib/http-guard.ts:86-99` / `docs/tech-stack.md:204-220` / `docs/review-p25-tests-2026-07-28.md` を訂正。`auth.ts:107-110` が `trusted` を実際に使用。実測 S4/S5/S6 で締め出し・fail-open・CPU DoS のいずれも成立しないことを確認 |

### 判定: **条件1 は満たされた。P3 着手可**

**レート制限基盤の P3 未認証エンドポイント（申込 / 画像アップロード / チャット）への横展開を許可する。**
ただし「そのままコピーする」ことは許可しない。実測から、以下の 3 つの性質は
**未認証・大母数という P3 の条件下では前提が崩れる**。

#### 条件1'（横展開時に基盤をそのまま複製してはならない箇所。P3 の設計時点で満たすこと）

| # | 持ち込んではいけない性質 | 根拠（本監査の実測） | 要求 |
|---|------------------------|---------------------|------|
| 1 | **共有軸（グローバル）を照合前の硬いゲートに使う** | S2/S10: 30 の独立発信元で正規利用者が `rate-limited`。予約枠は攻撃者の新品 IP に開かれており防げない | 公開エンドポイントでは共有軸の枯渇を**拒否ではなく待ち / 段階的劣化 / CAPTCHA フォールバック**にする。P2.5 から繰り返し挙がっている**セマフォ案**をここで決着させる（`docs/tech-stack.md:243-250`） |
| 2 | **`reset-on-success` と「カウント 0 = 予約枠の資格」** | S8: 有効な資格情報を持つ単一 IP が 102 リクエスト・scrypt 102 回でグローバル枠を単独枯渇 | 正常系が頻繁に成功する経路（申込送信・チャット）へ持ち込まない（SEC-039） |
| 3 | **`trusted=false` で per-source ゲートを完全に外す** | S3/E5: 縮退時は単一ホスト 121req/分で全利用者を締め出せ、per-source の推測回数制限も消える | 公開フォームでは `trusted=false` の環境で**別軸を必ず併用**する（Turnstile / セッション Cookie / 送信間隔下限）。SEC-032 の「IP 単独軸に依存しない」要求と同じ（SEC-038） |

#### 条件2（更新。P3 のレート制限実装と同一の作業単位で満たす。未達なら F-010 を完了と見なさない）

| ID | 状態 | 受け入れ条件（前回からの変更点） |
|----|------|------------------------------|
| **SEC-033** | 未着手（宣言どおり） | 変更なし。`lib/kv.ts` の `createKvRateLimitStore()` + 本番 fail-fast + 全エンドポイントへの注入 |
| **SEC-032** | 未着手（宣言どおり） | 変更なし。IPv6 `/64` 正規化 + IP 単独軸への非依存 |
| **SEC-031** | 未着手（宣言どおり）。**検証可能にはなった**（SEC-035 クローズ）| **追加**: 「退避によって予約枠の資格（`cleanSource`）が復活しないこと」もテストで固定する（SEC-041） |
| **SEC-034** | 未着手（宣言どおり） | 変更なし |
| **SEC-037** | 未着手（宣言どおり） | 変更なし |
| **SEC-002** | 未着手（宣言どおり） | 変更なし。個人情報入力フォームの公開と同時に CSP を投入 |
| **SEC-038**（新規）| — | 残余リスクの攻撃コスト記述を実測値へ訂正する。**文書のみで完了でき、P3 着手をブロックしないが、P3 の設計判断を始める前に済ませること** |
| **SEC-039**（新規）| — | `auth.ts:54` のコメント訂正（P2 内で可）+ P3 で `reset-on-success` を公開エンドポイントへ複製しない |
| **SEC-040**（新規）| — | 任意。`trusted === false` のとき `ip.reset` を行わない |

---

## D. 受容した残余リスクの妥当性評価

依頼のとおり、「残余リスクが記録されている」こと自体を理由に未解決とはしない。**受容が妥当かを評価する。**

| 残余リスク | 受容の妥当性 | 理由 |
|-----------|------------|------|
| **1. グローバル軸の分散枯渇（`trusted=true`）**<br>実測コスト: 独立 IP **30** / 120req/分（文書記載は「120 超の IP」）| **受容可（ただし数値の訂正は必須）** | 影響は管理者ログインの一時的な不可用のみで、公開サイト・機密性・完全性には及ばない。ウィンドウは 1 分。攻撃には 30 の独立 IP と継続的な送信が必要で、**P2（管理者 1 名のデモ）の文脈では割に合わない**。構造的な解（セマフォ）は P2.5-b のスコープ（順序の移動）を明確に超えており、P3 で決着させる旨が `docs/tech-stack.md:243-250` に記録されている。**記録先・代替案・再評価時期がすべて明示されている点は正しい運用**である。訂正が必要なのは数値のみ（→ SEC-038） |
| **2. 縮退時のグローバル軸（`trusted=false`）**<br>実測コスト: **単一ホスト** 121req/分 | **条件付きで受容可**（本番が Vercel である限り） | 本番は Vercel 集約が確定しており（`docs/phase-status.md:7`）`VERCEL=1` で該当しない。該当するのは `next start` 直公開のデモ・ローカルのみで、いずれも攻撃者が想定されない環境である。`docs/tech-stack.md:222-230` に「`trustProxy` を必ず有効化する」という運用要件が明記され、緩和手段も示されている。**ただし現在の文書は攻撃コストを 2 桁見誤らせる書き方**であり、この状態のまま P3 の公開エンドポイント（母数が桁違いに多い）へ判断を持ち越すのは危険。**SEC-038 修正方針2 の明記を受容の条件とする** |
| **3. 縮退時のブルートフォース耐性の低下**（per-source 10回/10分 → 全体 120回/分）| **受容可** | T2-DECISION の選択肢比較（(A)/(B)/(C)）が文書化され、(B) を選んでも代償が減らないことまで検討されている。実測 S6 でも `verify()` は 120 回で頭打ちになり、**scrypt の総量は制御されている**。単一アカウント・強いパスワードという P2 の前提では 120回/分の推測はブルートフォースとして成立しない |
| **4. 「正しい資格情報は通る」が失敗履歴の無い発信元に限られる**（S9）| **受容可（要記載）** | グローバル枠が枯渇している間だけの制約で、通常運用では発生しない。ただし**どの文書にも書かれていない**ため、不変条件の記述に成立範囲を併記すること（SEC-038 修正方針3） |

**総評**: P2.5-b は「消した」と「受容した」を取り違えていない。Impl ノート §6.2 が自己検証の結果を
「PASS とは書かない」と明記し、`docs/tech-stack.md` に記録先を持ち、構造的な解と再評価時期まで
示している点は、前回 P2.5 で問題になった「文書が事実と異なる」状態とは質的に異なる。
**受容の姿勢は妥当である。** 欠けているのは**受容判断の根拠となった数値の正確さ**だけで、
これは SEC-038 として文書修正で閉じられる。

---

## E. 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **0** |
| Medium | **1 新規（SEC-038）** ＋ 繰越 SEC-002 / SEC-031 / SEC-032 / SEC-033 |
| Low | **2 新規（SEC-039 / SEC-041）** ＋ 繰越 SEC-034 / SEC-014〜SEC-017 / SEC-025〜SEC-027 |
| Info | **1 新規（SEC-040）** ＋ 繰越 SEC-036 / SEC-037 / SEC-018〜SEC-020 / SEC-028（量的側面）|

**クローズ**: SEC-029 / SEC-030 / SEC-035（いずれも監査者自身の実測で確認）。

### リリース判定: **リリース可能**（Critical 0 / High 0。監査スキルのブロック基準を満たす）

### P3 着手判定: **着手可**

- **条件1（SEC-029 / SEC-030）は満たされた。** 前回の実測手順はいずれも再現しない。
- レート制限基盤の P3 横展開を**許可する**。ただし §C 条件1' の 3 点（共有軸を硬いゲートにしない /
  `reset-on-success` を複製しない / `trusted=false` で per-source を失わない）を設計制約として課す。
- 条件2 は SEC-031 の受け入れ条件に 1 行追加（SEC-041）したうえで**据え置き**。
  SEC-038 の文書訂正は P3 着手をブロックしないが、**P3 の設計判断を始める前に済ませること**
  （誤った攻撃コストが設計の入力になるのを防ぐため）。

### 評価

今回、**前回のような「テストが green でも脅威が閉じていない」型の失敗は起きていない**。
SEC-029 の順序移動は実測で脅威を消しており、SEC-030 の縮退意味論も締め出し・fail-open・CPU DoS の
3 方向すべてで健全だった。SEC-035 が閉じたことで SEC-031 の検証手段も揃った。
Impl が §6.3 で自ら報告した挙動（縮退時の共有バケットクリア）は、独立に検証した結果
**攻撃に使えない**（グローバル軸・予約枠はリセットされない）。自己申告の判断は妥当だった。

一方で、P2.5 で指摘した「**文書に事実と異なる記述が入る**」という欠陥が、**今回は残余リスク節で再発した**
（SEC-038）。皮肉なことに、それは前回の指摘に応えて新設された節である。
「必要 IP 数 1 → 120 超」という 120 倍のコスト上昇は、実測では `trusted=true` で 4 倍、
`trusted=false` では**まったく上がっていない**。予約枠が「失敗履歴の無い発信元」に開かれている以上、
**攻撃者の新品の IP は常にその条件を満たす** — 防御の設計意図（「攻撃者は自分の軸を消費しているはずだ」）と
実際の判定式（「カウントが 0 か」）のずれが、そのままコスト見積もりのずれになっている。

教訓として記録する: **防御の効果を数値で主張するときは、その数値自体を攻撃者視点で実測すること。**
「攻撃者は〜のはずだ」という前提を判定式に翻訳した時点で、前提が判定式から抜け落ちることがある。
SEC-021 → SEC-029 → SEC-038 は、いずれもこの同じ型（前提と判定式のずれ）から生まれている。

---

# P3-a 監査（2026-07-29）

## 監査日: 2026-07-29
## 対象: P3-a（レート制限基盤の本番化 + 公開変更系ラッパ + フォームセッション Cookie 基盤 + CSP）
## 入力: `docs/impl-p3a-notes-2026-07-29.md` / `docs/review-p3a-tests-2026-07-29.md` / `docs/functional-spec.md` v0.3.3 §4.11 / `docs/tech-stack.md` v0.3.2 §4.5–4.7 / `docs/phase-status.md`「P3-a の完了条件（分割）」

### 監査の方法（前回・前々回と同じ原則 + 今回の強化）

**「テストが green」を完了根拠として一切採用していない。** 品質ゲート（unit 317 / integration 28 /
type-check 0 / lint 0 / build 成功）はオーケストレーターの独立実行値を前提とし、**再実行していない**。
E2E も指示どおり実行していない。

代わりに、**実装モジュールに監査者自身が攻撃シナリオを直接投入して実測**した。今回は前回までと違い、
**本物の Redis 7.4.10（`docker run redis:7-alpine` / port 6399）を立て、`createKvSemaphoreStore` に接続して
`SEMAPHORE_ACQUIRE_LUA` そのものを Redis の Lua VM で実行させた**。

| 実測環境 | 内容 |
|---------|------|
| セマフォ（§C） | 実 Redis 7.4.10 + `lib/semaphore.ts` の**本物のエクスポート**（`createKvSemaphoreStore` / `createSemaphore` / `SEMAPHORE_ACQUIRE_LUA`）。RESP2 を直書きした最小クライアントで接続（リポジトリの依存は増やしていない） |
| ラッパ・レート制限・Cookie（§A / §B / §G） | `lib/public-guard.ts` / `lib/rate-limit.ts` / `lib/kv.ts`（実 Redis 接続）/ `lib/form-session.ts` / `lib/http-guard.ts` の**本物のエクスポート**に直接 `Request` を投入 |
| ルート列挙テストの検出力（SEC-047） | `app/api/` に細工したルートを一時的に置き、`api-route-guard-coverage.test.ts` を実行して**落ちるか**を実測（実行後に削除済み。`app/api` が `admin` / `auth` のみに復旧したことを確認） |

**この方法により、Impl が「検証できていない」と申告した I-1（Lua 本体の意味論）と I-3（AC-RL-11(d) の
手動確認）は本監査で閉じた**（§D）。同時に、**ユニットテスト 317 件がすべて green の状態で
High 2 件が実測で再現した**（SEC-042 / SEC-043）。

---

## A. 条件2（P2.5-b 再監査 §C で課した受け入れ条件）の充足判定

| ID | 受け入れ条件 | 判定 | 根拠（file:line + **監査者自身の実測**）|
|----|------------|------|--------------------------------|
| **SEC-033** | `createKvRateLimitStore()` + 本番 fail-fast + **全エンドポイントへの注入** | **部分達成（未クローズ）** | store: `lib/kv.ts:92-139`。実 Redis で `INCR` →（**`count===1` のときだけ**）`PEXPIRE`、以降は `PTTL` 確認のみを実測（G-9: 発行列 `INCR / PEXPIRE 59000 / INCR / PTTL / …`、5 連続 = `ok(2),ok(1),ok(0),NG,NG`、`PTTL=58549ms`）。TTL を失ったキーは窓を延ばさずに復旧（G-9b: `PTTL=29998ms`）。fail-fast: `lib/env.ts:45-94`（`auth.ts:37` のトップレベル `getServerEnv()` 経由で build / 起動時に評価される）。**注入は 0 箇所**——`createKvRateLimitStore` / `createUpstashKvClient` / `createKvSemaphoreStore` に `scripts/` 以外の呼び出し元が無く、`auth.ts:70-73` のログイン limiter は**既定のインメモリ store のまま**（grep 実測）。→ **SEC-044** |
| **SEC-032** | IPv6 `/64` 正規化 + **IP 単独軸への非依存** | **達成（正規化）／未達（非依存）** | 正規化: `lib/rate-limit.ts:209-254`。実測 G-10 — 20 個の `2001:db8::N` を名乗って通ったのは **3 回だけ**（上限どおり）。`2001:0DB8:0000:0000:1:2:3:4` → `2001:db8:0:0::/64`（表記ゆれの畳み込み）、`::ffff:198.51.100.7` / `::ffff:c633:6407` / `198.51.100.7` → **すべて `198.51.100.7`**（射影の畳み込み）。**「IP 単独軸への非依存」は未達**——`lib/public-guard.ts:184-190` は `trusted` を捨てて IP 軸を唯一の Tier D 軸として使い、`formSession` 軸は P3-b まで実行経路を持たない（Impl 申し送り I-6）。→ **SEC-043** |
| **SEC-031 + SEC-041** | 退避しない / **予約枠の資格が復活しない** | **達成（KV 側）／未達（インメモリ側の残余）** | KV: `lib/kv.ts:86-92` に退避の概念が無い。インメモリ: `lib/rate-limit.ts:162-167` が `saturated` を退避対象から外す。実測 G-4 — **未達バケットを 150 件注入しても上限到達バケットは残存した**（テストが固定している経路は健全）。しかし**上限到達バケットを 50 件注入すると `lib/rate-limit.ts:172-178` のフォールバックが働き、攻撃者自身のバケットが退避され、直後の `consume` が成功に戻った**（＝スロットル解除）。なお公開経路は `cleanSource` / 予約枠を持たない（G-3 で確認）ため、**復活するのはスロットルのみで予約枠の資格ではない**。→ **SEC-045** |
| **SEC-034** | 直列化が単一障害点にならない | **達成（クローズ）** | `lib/rate-limit.ts:369-374` — store が `increment` を持つ場合、`consume` は `serialize` を**通らずに** return する。`lib/semaphore.ts` は `serialize` を一切参照しない（grep 実測）。実 Redis での並行 32 件の `acquire` で `EVAL` 発行が**厳密に 32 回**（S-2）＝ 1 acquire = 原子操作 1 回で、キュー待ちが発生していない |
| **SEC-037** | 認証非依存ラッパを変更系が必ず通る | **構造は達成／保証の範囲は限定的** | `lib/public-guard.ts` は `@/auth` に依存しない（import 実測: `http-guard` / `rate-limit` / `semaphore` / `node:crypto` のみ）。列挙テストの検出力を実測 — **素の `export async function POST` を置くと 1 failed / 10 passed で落ちた**（メッセージも正確）。ただし**ローカルに no-op の同名関数 `withPublicMutation` を定義したルートは 11/11 green のまま通過した**（import 元を検証していない）→ **SEC-047**。なお**現時点で `withPublicMutation` / `withCronAuth` の呼び出し元は 0 件**（P3-b/c/d の成果物待ち。仕様どおり） |
| **SEC-002** | CSP（個人情報入力フォームの公開と同時に投入） | **達成（P3-a の範囲で）** | `lib/csp.ts:46-76` — `script-src` は `'self'` + リクエストごとの nonce（`crypto.getRandomValues` 16 byte = 128bit / `lib/csp.ts:33-37`）+ Turnstile。`'unsafe-inline'` を**含まない**。`object-src 'none'` / `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'none'` あり。**Report-Only ではなく強制モード**（`middleware.ts:41,49,56,61` はいずれも `content-security-policy`）。`'unsafe-eval'` は `NODE_ENV !== 'production'` のときだけ（`middleware.ts:36`）。`style-src 'unsafe-inline'` の受容が `lib/csp.ts:13-19` に明記されており、**過大報告になっていない**。`app/layout.tsx:37` の `force-dynamic` により全ルートが動的＝ nonce を持てる |

### 条件2 の総括

**6 項目中、完全達成は SEC-034 / SEC-002 の 2 項目。** SEC-033 / SEC-032 / SEC-031+041 / SEC-037 は
**部分達成**であり、いずれも「基盤は正しく作られたが、脅威を閉じる最後の一歩が残っている」形である。
**このうち SEC-032 の未達部分（SEC-043）は P3-b で自動的に閉じるものではなく、
`lib/public-guard.ts` の設計そのものを直す必要がある。**

---

## B. 条件1'（P3 固有の設計制約）の充足判定 — **監査者自身の実測**

| # | 制約 | 判定 | 実測 |
|---|------|------|------|
| **1** | 共有軸を照合前の硬いゲートにしない（枯渇が「拒否」ではなく「待ち / 劣化」になる）| **セマフォ軸は達成／IP 軸は未達** | **セマフォ**（G-2）: `acquireWithWait` が `permit: null` を返す状況で応答は **`202` + `{"retryAfterMs":1113}`、`Retry-After` ヘッダ無し**（`lib/public-guard.ts:215-224`）＝ Tier C。**待機**は実 Redis で `attempts=13 / waitedMs=1906`（上限 2000 内）で打ち切り（S-10）。**IP 軸**: `trusted=false` の縮退時、全利用者が単一の `unknown` バケットを共有するのに **Tier D = 429 の硬いゲート**として使われる → **未達（SEC-043）** |
| **2** | `reset-on-success` / `cleanSource` を公開経路へ持ち込まない | **達成** | G-3: 同一発信元の 5 連続**成功**送信で `200,200,200,429,429`、store の entry は `{count:3, saturated:true}`（成功でカウンタが減っていない）。`lib/public-guard.ts` に `reset` / `peek` / `cleanSource` / `globalReserve` の呼び出しも語も無い（grep 実測）。`limiter.reset` を呼ぶ経路が存在しない |
| **3** | `trusted=false` で per-source ゲートを完全に外さない（別軸の併用）| **未達** | G-1: `VERCEL` 未設定（`trustProxy=false`）で `resolveClientIp` は `{key:"unknown", trusted:false}` を返す。攻撃者が **3 回**送信して上限に達した直後、**無関係な発信元からの正当なリクエストが 429** になった（handler 実行回数は 3 のまま）。併用すべき別軸（`formSession`）は `formSessionKey` が渡されない限り評価されず、P3-a には渡す呼び出し元が無い（Impl 申し送り I-6） → **SEC-043** |

> **条件1'-3 は「P3 の設計時点で満たすこと」と課した制約である。** P3-a はラッパを作る単位であり、
> ここで満たされなければ P3-b が実ルートを配線した瞬間に脅威が本番へ出る。
> **`lib/http-guard.ts:86-94` は「`key` だけを取り出して `trusted` を捨てる呼び出しは、この防御を無効化する」と
> 名指しで警告しており、`lib/public-guard.ts:188` はまさにその形になっている。**

---

## C. セマフォの脅威シナリオ再現（**実 Redis 7.4.10 上での監査者自身の実測**）

Impl の自己検証（`scripts/verify-semaphore-p3a.ts`）は**フェイク KV = Lua を解釈しない参照実装**での
測定であり、指示どおり**その結果を根拠として採用していない**。以下はすべて本監査の独立再現である。

| シナリオ | 結果 | 実測値 |
|---------|------|-------|
| **S-0** 実 Redis で Lua が動くか / score の精度 | **PASS** | `ZSCORE = 1800000020000`（= `now + ttlMs`）。**Lua の数値→文字列変換で精度が落ちていない**。`now = 2_000_000_000_000`（2033 年）でも `2000000020000`（S-8） |
| **S-1 旧欠陥1**: 満杯かつ `acquire` が継続到着している状況での回復 | **PASS（再現しない）** | `shards=1 / perShardLimit=3` で 3 件取得（release せず）→ **追加 `acquire` が `null`（満杯の固定）** → 期限前に **99 回** `acquire` を投げて**成功 0** → `T0+TTL+1` で成功。在庫 3 → 1（期限切れ 3 件が回収された） |
| **S-2 旧欠陥2**: 同時実行上限の非超過 | **PASS（一瞬の超過も無い）** | K=1 / perShard=3: 並行 23 件 → 成功**ちょうど 3**、確定在庫 3、`EVAL` 発行 23 回。K=4 / perShard=3: 並行 32 件 → 成功**ちょうど 12**、在庫 12、`EVAL` 32 回。**実 Redis では `EVAL` が原子的なので、これは「参照実装が正しい」ではなく「本物の Lua が正しい」ことの実証である** |
| **S-2b** TTL 境界跨ぎ | **PASS** | `T0 / T0+TTL-1 / T0+TTL / T0+TTL+1` を跨ぐ 8 回の系列で、コマンド境界で観測した `ZCARD` の**最大値 3**（上限 3） |
| **S-3** 二重 `release` の冪等性 / シャード局所性 | **PASS** | 同一 `permitId` を 3 回 `release` → shard1 の在庫 2→1（減ったのは自分の 1 件だけ）、shard2 は 1 のまま |
| **S-4** **AC-RL-11(d)**: 本物の Lua から `ZREMRANGEBYSCORE` を削った版で (a) が落ちるか | **PASS** | 掃除を削除した `SEMAPHORE_ACQUIRE_LUA` を実 Redis に投入して S-1 を再実行 → **期限経過後の `acquire` が `null`、在庫 3 のまま**（回復しない）。**Impl 申し送り I-3 はこれで閉じた** |
| **S-7** `permitId` 経由の Lua インジェクション | **PASS** | `x' ) redis.call('FLUSHALL') --\n" ]] {"` を `permitId` に渡しても、**ZSET の member としてそのまま格納されただけ**（在庫 1 / `ZSCORE` 正常 / 他キーは無傷）。`ARGV` はデータとして扱われており、スクリプトへの文字列結合は無い（`lib/semaphore.ts:182-187`） |
| **S-9** シャード抽選の偏り | **PASS** | 20,000 回の抽選で **同一シャードのペアが 0 件**、シャード別出現は 9,913〜10,060（差 1.5%）。`rng()≈1` の上端でも候補は `[:3, :2]` で重複しない（`lib/semaphore.ts:279-282` の `Math.min` クランプが効いている） |
| **S-10** 待機の上限 | **PASS** | 満杯状態で `attempts=13 / waitedMs=1906`（`SEMAPHORE_MAX_WAIT_MS=2000` 内）。`lib/semaphore.ts:314` の打ち切りが効いている |
| **S-5** 進んだ `now` の悪用 | **INFO → SEC-048** | `now` を +1 時間にした `acquire` 1 回で、**処理中の 3 件が掃除で消えて在庫 1 になった**（＝そのシャードの同時実行上限が一括解放された） |
| **S-6** 同一 `permitId` の二重 `acquire` | **INFO → SEC-049** | 2 回とも「成功」を返すが在庫は **1**（`ZADD` が score を更新するだけ）。枠を 1 つしか消費せず、先に `release` した側が両方を解放する |
| **S-3b** 他者の `permitId` を知る者による `release` | **INFO** | `permitId` を知っていれば他者のパーミットを解放できる。既定は `randomBytes(16)`（`lib/semaphore.ts:250-252`）＝ **暗号論的乱数 128bit** であり、Test 申し送り T-8 が求めたソースレビューはここで確認した |

### 新たな悪用経路の探索結果

- **`permitId` の予測可能性**: 既定は `crypto.randomBytes(16).toString('hex')`（`lib/semaphore.ts:31, 250-252`）。`Math.random` ではない。**問題なし**。ただし `newPermitId` は注入可能で、決定的な値を渡すと S-6 の性質が悪用可能になる（SEC-049）。
- **シャード選択の偏りの悪用**: 実測 S-9 で偏り無し。攻撃者はシャードを選べない（`rng` はサーバー内部）。**問題なし**。
- **`now` を呼び出し側が渡す設計**: S-5 で在庫の一括消去を再現。ソース冒頭（`lib/semaphore.ts:21-24`）に成立条件として記載済みだが、**前提の検証手段が無い**（SEC-048）。
- **Lua 引数のインジェクション**: S-7 で不成立を確認。**問題なし**。
- **ZSET キーの TTL**: `ZADD` はキー単位の期限を設定しないため、トラフィックが止まったシャードのキーは残る。ただし**キー数はエンドポイント 3 × シャード 4 = 12 で有界**であり、実害なし（**記録のみ**）。

---

## D. Impl が「検証できていない」と申告した事項への判定

| # | 申告内容 | **判定** | 理由 |
|---|---------|---------|------|
| **I-1** | Lua スクリプト本体の意味論は未検証（フェイク KV は Lua を解釈しない）| **本監査で閉じた。受容不要。** | **実 Redis 7.4.10 に `SEMAPHORE_ACQUIRE_LUA` をそのまま投入して S-0〜S-9 を実測した。**「`ZCARD` の比較演算子の書き間違い」型は S-2（成功数がちょうど上限）と S-1（満杯の固定）で落ちる。数値変換の精度も S-0 / S-8 で確認した。**「ユニットが green だから Lua が正しい」とは書いていない——実 Redis で実行した結果として正しい。** |
| **I-2** | 実 Redis に対する結合テストを P3-a に足していない（受容の記録が Test 申し送りの条件）| **受容する（ただし条件付き）。** | (a) `@upstash/redis` は REST 経由でローカル Redis を直接向けられない、(b) AC-RL-11(e-3)（濃度の最大値）は原子的な実 Redis では原理的に観測できない、という理由は**正しい**。**したがって P3-a の完了条件に「実 Redis 結合テスト」を追加しない。** ただし本監査の実測は `SemaphoreKvClient`（`eval` / `zrem` の 2 メソッド）に RESP クライアントを差すだけで成立した——**`Lua` を変更するときは同じ方法で再実測すること**を P3-b 以降の要件に追加する（§F P3b-9） |
| **I-3** | AC-RL-11(d) の手動確認（本物の Lua から `ZREMRANGEBYSCORE` を削った版で (a) が落ちること）は未実施 | **本監査で閉じた（S-4）。** | 削除版では期限経過後も `acquire` が `null` ／在庫 3 のまま。**(a) が空振りしていないことの証跡が実測として残った** |
| **I-4** | AC-010-13(c)（応答時間が N に線形比例しない）の実測をしていない | **受容する。** | P3-a に公開エンドポイントの実ルートが 1 本も無い（`app/api` は `admin` / `auth` のみ。実測）ため測る対象が存在しない。(a)（`serialize` 非経由）は §A SEC-034 で確認済み。**「シャード化が効いた証拠」と読み替えていないことも確認した**（Impl ノートの注記どおり） |
| **I-5** | KV クライアントを実接続で動作確認していない | **一部受容しない。** | 「疎通確認をしていない」こと自体は受容してよい。**問題は疎通ではなく、注入経路が 1 本も無いこと**（SEC-044）。本監査は `lib/kv.ts` の `createKvRateLimitStore` を実 Redis に接続して動作を確認した（G-9 / G-9b）ので、**store の実装そのものは正しい** |
| **I-6** | `limiters.formSession` 軸は実行されるコードパスを持たない | **受容しない。** | これ単体なら P3-b への繰り越しでよいが、**条件1'-3 が要求する「`trusted=false` で併用する別軸」がこれである**。別軸が動かないまま IP 軸だけが硬いゲートになっている状態は、繰り越しではなく**設計制約の未達**である（SEC-043） |
| **I-7** | E2E flaky 4 件を「環境のせい」と確定できていない | **受容する（Security 観点では）。** | 4 件はいずれも P3-a が触っていない既存スペック（トップページ表示・お知らせ CRUD）で、失敗はすべてタイムアウトであり assertion 不一致ではない。**セキュリティ上の含意は無い。** 「4 flaky を 0 と報告しない」という Impl の姿勢は正しく、CI での確認は Senior の判断に委ねる |
| **I-8** | CSP のブラウザ検証は `/` のみ | **受容する（ただし P3-b の要件に格上げする）。** | Impl 自身が「`/schools` の静的化を捕まえたのは `school-access.spec.ts` であって `csp.spec.ts` ではない」と実測付きで記録している。**この自己申告は正確**。§F P3b-5 に明記した |
| **I-9** | `app/layout.tsx` の `force-dynamic` を外すと静的化ページだけが無言で壊れる。構造的な歯止め（テスト）が無い | **受容しない（Should Fix）。** | ビルドも型検査も lint も通り、E2E だけが捕まえる欠陥である。**`.next/` のビルド出力に静的ルート（`○`）が 1 つも無いことを検査するテスト**、または `app/layout.tsx` に `dynamic` export が存在することを検査するソース assert のどちらかを P3-b で入れること。**CSP の nonce 方式が全ページの動的レンダリングに依存している以上、これは可用性ではなくセキュリティの依存関係である**（§F P3b-6） |

---

## E. 新規指摘（SEC-042 以降）

### [SEC-042] フォームセッション Cookie の署名比較が「JS 文字列長」で行われており、細工した Cookie で `RangeError` が投げられて 500 になる（Tier B に落ちない）

- **重大度**: **High**
- **カテゴリ**: 認証・認可 / 入力バリデーション / 可用性（CWE-248: Uncaught Exception / CWE-703）
- **場所**: `lib/form-session.ts:121-122`
- **説明**: 署名の比較は
  ```ts
  if (providedSignature.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expected))) return null
  ```
  だが、`String.prototype.length` は **UTF-16 コードユニット数**であり `Buffer.byteLength` ではない。
  攻撃者が署名部分の 1 文字をマルチバイト文字（例 `é`）に置き換えると、**文字列長は一致するが
  Buffer のバイト長が一致しない**ため、`timingSafeEqual` が
  `RangeError: Input buffers must have the same byte length` を **throw する**。
- **実測（G-5 / G-5b）**:
  ```
  入力 = <正しい payload>.<署名の1文字目を 'é' に置換>
  verifyFormSessionValue(...)              → RangeError: Input buffers must have the same byte length
  同じ値を withPublicMutation 経由で送る   → 例外: RangeError（期待: 403 Tier B）
  ```
  `lib/public-guard.ts:210` は `verifyFormSession` を **try/catch していない**ため、例外はラッパの外へ
  抜ける（G-7 で本体の例外も同様に抜けることを確認済み）。Next.js の Route Handler では **500** になる。
- **影響**:
  1. **AC-RL-13 / テスト契約 `tests/unit/form-session.test.ts:129`（「壊れた形式でも例外を投げず `null`」）に
     正面から違反する。** `lib/form-session.ts:102-105` のコメントが
     「500 にしてしまうと劣化（Tier B）ではなく失敗になる」と書いている**まさにその状態**が、
     1 文字の細工で作れる。
  2. 未認証の攻撃者が任意に 500 を発生させられる（エラーレート汚染 / 監視の誤報 / ログ増幅）。
  3. Tier B（403 + `challenge`）に落ちないため、**降格させるべきリクエストがエラー扱いになる**。
- **なぜユニットテスト 317 件が緑のまま通ったか**: `form-session.test.ts:129` の「壊れた形式」ケースは
  `['not-a-token', 'a.b.c.d', '.', '..', '%%%']` の **5 つとも ASCII**（文字列長＝バイト長）であり、
  この分岐に到達しない。**契約は正しく書かれていたが、与えた入力の選び方が脅威モデルと一致していなかった。**
- **修正方針**: `lib/cron-auth.ts:39-43` が**すでに正しい形**（先に `Buffer` へ変換してから `a.length !== b.length`）
  になっている。`lib/form-session.ts` を同じ形に揃える:
  ```ts
  const provided = Buffer.from(providedSignature, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return null
  if (!timingSafeEqual(provided, expectedBuf)) return null
  ```
  併せて、**`withPublicMutation` が `verifyFormSession` / `formSessionKey` の例外を握って Tier B に落とす**こと
  （供給者が例外を投げない前提に寄りかからない）。テストは ASCII 以外の境界（マルチバイト・
  サロゲートペア・base64url 外の文字）を「壊れた形式」の集合に追加すること。
- **参考**: CWE-248 / OWASP A04:2021 Insecure Design

---

### [SEC-043] `withPublicMutation` が `resolveClientIp().trusted` を捨てるため、縮退時に共有 `unknown` バケットが「照合前の硬いゲート（429）」になる（条件1'-1 / 1'-3 の違反）

- **重大度**: **High**
- **カテゴリ**: 認可・可用性（CWE-770 の裏返し / DoS）
- **場所**: `lib/public-guard.ts:184-190`（`clientIp(request).key` のみを使い `trusted` を参照しない）
- **説明**: `resolveClientIp` は信頼できるプロキシ配下でない場合（`VERCEL !== '1'`、あるいは Vercel 上でも
  IP ヘッダが IP リテラルとして妥当でない場合）、**全利用者を単一の `unknown` バケット**に寄せて
  `trusted:false` を返す。`lib/http-guard.ts:86-94` は
  「**`key` だけを取り出して `trusted` を捨てる呼び出しは、この防御を無効化する**」と明示的に警告しており、
  `lib/login-guard.ts` は `trusted===false` のとき共有バケットを**計数のみに使い照合前ゲートには使わない**
  ことで SEC-030 を閉じている。**`lib/public-guard.ts` はこの是正を引き継いでいない。**
- **実測（G-1）**:
  ```
  resolveClientIp → {"key":"unknown","trusted":false,"source":"unknown"}（発信元ヘッダが何であれ同一）
  攻撃者 3 回（limit=3）      → 200, 200, 200
  無関係な正規利用者の 1 回目 → 429      ← 共有バケットの枯渇が「拒否」になっている
  handler 実行回数 = 3
  ```
- **影響**: 縮退構成では、**単一のホストが上限回数だけ送信するだけで、以降その窓の間ずっと
  全利用者の申込フォーム送信が 429 で拒否される**。P2.5 で SEC-029 / SEC-030 として閉じた
  「共有軸の枯渇が正規利用者の拒否理由になる」形が、**未認証・大母数の公開経路に、より安いコストで再現した**
  （管理者ログインでは 121req/分が必要だったが、公開フォームの per-source 上限は 1 桁の想定である）。
  さらに条件1'-3 が要求する「併用すべき別軸」（`limiters.formSession`）は、`formSessionKey` を渡す
  呼び出し元が存在しないため**動かない**（Impl 申し送り I-6）。
- **本番（Vercel）で直ちに悪用可能か**: 本番は Vercel 集約が確定しており（`docs/phase-status.md:7`）、
  通常は `trusted=true` になるため**直ちには悪用できない**。**しかし**:
  (a) 条件1'-3 は「P3 の**設計時点**で満たすこと」と課した制約であり、ラッパを作る単位である P3-a が
  その適用点である。(b) `withPublicMutation` は P3-b で実ルートに配線される。
  (c) `resolveClientIp` は Vercel 上でも IP ヘッダが妥当な IP リテラルでなければ `unknown` に落ちる。
  (d) デモ・ローカル（`next start` 直公開）は該当する。
- **修正方針**（P3-b 着手前に閉じること）:
  1. `PublicGuardOptions` の `clientIp` の戻り値から `trusted` を**必ず読む**。`trusted === false` のとき、
     per-source 軸は **`consume` して計数はするが、その `success:false` を 429 の理由に使わない**
     （`lib/login-guard.ts` と同じ形）。
  2. 代わりに、`trusted === false` のときは**必ず別軸を要求する**——`verifyFormSession` が未設定なら
     ラッパの構築時に throw する（＝配線ミスを起動時に落とす）か、Tier B へ降格させる。
  3. `trusted === false` を Tier D の拒否理由にしないことを、**`trusted:false` を注入したユニットテスト**で固定する。
     現在 `tests/unit/public-guard.test.ts` は `clientIp: () => ({ …, trusted: true })` しか注入しておらず、
     **縮退経路のテストが 1 本も無い**（grep 実測）。
- **参考**: 本監査 §B 条件1'-1 / 1'-3、SEC-029 / SEC-030 / SEC-038

---

### [SEC-044] KV レート制限が「本番で必須」になったのに注入経路が 1 本も無く、`.env.example` / `lib/env.ts` の記述が実態と食い違っている

- **重大度**: **Medium**
- **カテゴリ**: 設定不備 / 監査証跡の正確性（OWASP A05:2021 Security Misconfiguration）
- **場所**: `lib/env.ts:45-64` / `.env.example`（KV 節）/ `auth.ts:70-73` / `lib/kv.ts:54`
- **説明**: `lib/env.ts` は本番で `KV_REST_API_URL` / `KV_REST_API_TOKEN` を必須化し、その理由を
  「**KV 未設定のまま起動するとレート制限とセマフォが黙って無効化される**」と書いている。
  `.env.example` にも同じ文言がある。**しかし `createUpstashKvClient` / `createKvRateLimitStore` /
  `createKvSemaphoreStore` の呼び出し元は `scripts/verify-semaphore-p3a.ts` 以外に存在せず**（grep 実測）、
  `auth.ts:70-73` の 4 本のログイン limiter は依然として `createRateLimiter({limit, windowMs})`
  ＝ **既定のインメモリ store** である。つまり**現時点では、KV を設定してもしなくても挙動は変わらない**。
- **影響**:
  1. **`auth.ts` の管理者ログイン制限は本番（Vercel の N インスタンス）で依然としてインスタンスごとに独立**
     である。実効上限は `limit × インスタンス数`（SEC-033 が最初に指摘した状態がそのまま残っている）。
  2. より悪いのは**誤った保証**である。env の fail-fast と `.env.example` の文言により、
     運用者は「KV を設定したのでレート制限は分散で効いている」と読む。**P2 / P2.5 で繰り返した
     「文書が事実と異なる」型の失敗**が、今回は fail-fast というより強い形で入っている。
  3. **担当フェーズが決まっていない**: `docs/phase-status.md` の P3-b/c/d はいずれも公開エンドポイント側の
     成果物であり、**`auth.ts`（管理者ログイン）への store 注入を担当する単位が存在しない**。
- **完了条件の食い違い**: `phase-status.md`「(1) P3-a で満たす」の AC-010-10 は
  「**KV store + 本番 fail-fast**」であり注入を含まない。一方、本書 P2.5-b 再監査 §C 条件2 の SEC-033 は
  「**+ 全エンドポイントへの注入**」を要求している。**両者が食い違っている。**
  本監査は後者を正とする——条件2 は「未達なら F-010 を完了と見なさない」と定義されているためである。
- **修正方針**:
  1. `auth.ts` のログイン limiter に、本番のみ `createKvRateLimitStore({ client: createUpstashKvClient() })` を
     注入する（`config.store`）。**`lib/rate-limit.ts` の変更は不要**（`increment` 経路は実装済み）。
  2. `docs/phase-status.md` の P3-a 完了条件 (1) AC-010-10 に注入の担当単位を明記し、条件2 との食い違いを解消する。
  3. 注入されるまでの間、`.env.example` / `lib/env.ts` の理由文言に
     「**現時点では fail-fast のみ。注入は未実施**」を追記する（誤った保証を残さない）。
- **参考**: SEC-033（未クローズ）

---

### [SEC-045] 上限到達バケットも「全常駐が上限到達」なら退避されるため、SEC-041 の資格復活経路がコストの上昇のみで残っている

- **重大度**: **Medium**
- **カテゴリ**: 可用性 / レート制限のバイパス（CWE-841）
- **場所**: `lib/rate-limit.ts:169-178`（`evictFor` のステップ 3）
- **説明**: SEC-041 の是正として `saturated` なバケットは退避対象から外されたが、
  「未達バケットだけでは空きを作れない場合に限り、**最も古い上限到達バケットを退避する**」
  フォールバックが残っている（メモリの有界性を守るための意図的な判断で、コメントにも明記されている）。
  **攻撃者は自分のバケットを最も古い `resetAt` にしたうえで、`maxEntries` 件の上限到達バケットを作れば
  このフォールバックを踏ませられる。**
- **実測（G-4 / `maxEntries=50` / `limit=3`）**:
  ```
  攻撃者のバケットを上限到達にする   → {count:3, resetAt:60000, saturated:true} / 追加 consume = false
  未達バケット 150 件を注入          → 攻撃者のバケットは残存（テストが固定している経路は健全）
  上限到達バケット 50 件を注入       → 攻撃者のバケットが退避された
  退避後に再 consume                 → success = true   ← スロットルが解除された
  ```
- **影響**: 既定 `maxEntries = 10,000` なので攻撃コストは `10,000 × limit` リクエスト。
  **IPv6 の `/64` を多数保持する攻撃者（1 契約者に `/48` が払い出されれば 65,536 個の `/64`）には
  到達可能な範囲**であり、「不可能」ではなく「高い」に留まる。
  ただし公開経路は `cleanSource`（予約枠の資格）を使っていないため（G-3 で確認）、
  **復活するのはスロットルのみで、予約枠の資格ではない**。SEC-041 の帰結のうち後半は閉じている。
- **なぜテストが通ったか**: `kv-store.test.ts:178` などは**未達バケットを注入する経路**しか見ていない。
  ステップ 3 のフォールバックを踏ませる条件（常駐が全て `saturated`）を作るテストが無い。
- **修正方針**:
  1. **推奨**: SEC-044 の注入を行い、本番のレート制限を TTL ベースの KV store（退避の概念なし）にする。
     インメモリ store は dev / 単一インスタンスのみの経路になる。
  2. インメモリ store を本番で使い続けるなら、フォールバックで退避する際に **`count` を 0 に戻さない**形
     （`resetAt` まで残す tombstone、または `maxEntries` 超過時に**新規キーの受け入れを拒否**）へ変える。
     **「メモリの有界性」と「スロットルの保持」はトレードオフであり、どちらを取るかを明示的に決めること**
     （現在は無言で前者を取っている）。
  3. いずれにせよ、**ステップ 3 を踏ませるテスト**を追加して挙動を固定すること。
- **参考**: SEC-031 / SEC-041

---

### [SEC-046] `FORM_SESSION_SECRET` / `CRON_SECRET` に強度要件が無く、`/api/cron/**` には試行回数制限も無い

- **重大度**: **Medium**
- **カテゴリ**: 暗号・認証（CWE-521 / CWE-307）
- **場所**: `lib/env.ts:40-41`（`z.string().min(1).optional()`）/ `lib/cron-auth.ts:46-62`
- **説明**: `AUTH_SECRET` は本番で 32 文字以上が必須（`lib/env.ts:11, 73-79`）だが、
  **`FORM_SESSION_SECRET` と `CRON_SECRET` は `min(1)`** であり、本番でも **1 文字で検証を通る**。
  - `FORM_SESSION_SECRET` は HKDF の入力材料であり、**HKDF は入力エントロピーを増やさない**。
    弱い値なら Cookie 署名が偽造でき、AC-RL-13 の軸（Tier B 降格）と AC-RL-6 の送信間隔下限が
    まとめて回避される。
  - `CRON_SECRET` は**個人情報の削除バッチ**（P3-d の保持期間削除 / P3-c の orphan 回収）の唯一の認可材料である。
    `withCronAuth` には**試行回数制限が無く**、設計上 `Origin` も見ないため、
    **外部から無制限にトークンを総当たりできる**。比較自体は `timingSafeEqual`
    （`lib/cron-auth.ts:39-43`。**先に Buffer 長で弾いており SEC-042 の欠陥は無い**）なので
    タイミング攻撃は成立しないが、短いトークンなら総当たりが成立しうる。
- **影響**: 弱い `CRON_SECRET` が設定された場合、**未認証の第三者が削除バッチを起動できる**（可用性・完全性）。
  弱い `FORM_SESSION_SECRET` の場合、Tier B の降格軸が無効化される。
- **修正方針**:
  1. `lib/env.ts` の production `superRefine` で、`FORM_SESSION_SECRET` / `CRON_SECRET` にも
     **32 文字以上**（`AUTH_SECRET_MIN_LENGTH` と同じ）を要求する。既存の「`AUTH_SECRET` と同一値の禁止」は維持する。
  2. `.env.example` に生成方法（`openssl rand -base64 32`）を明記する。
  3. `withCronAuth` に**発信元非依存の粗い試行回数制限**を入れる（例: 失敗 10 回/分でその窓は 404 を返し続ける）。
     Vercel Cron は正しいトークンで来るため正常系に影響しない。**P3-c で実ルートを作るときに必須**とする。
  4. `ci.yml` のダミー値（`ci-dummy-cron-secret-0123456789abcdefghij` = 40 文字 /
     `ci-dummy-form-session-secret-0123456789abcdef` = 44 文字）は**新しい下限を満たすため変更不要**。
     ダミー値をコミットする判断自体も**妥当**（実 KV へ接続しない・`.env` は `.gitignore:34-36` 済みを実測確認）。
- **参考**: CWE-521 / CWE-307

---

### [SEC-047] ルート列挙テスト（AC-010-14）は識別子名の文字列一致だけで、import 元を検証しない

- **重大度**: **Low**
- **カテゴリ**: 検証の網羅性（防御の保証範囲）
- **場所**: `tests/unit/api-route-guard-coverage.test.ts:107`（`isWrappedBy` の正規表現）
- **説明**: `isWrappedBy` は `export const POST = withPublicMutation<…>(…)` という**ソース文字列の形**だけを
  見ており、その `withPublicMutation` が `@/lib/public-guard` から import されたものかを確認しない。
- **実測**: `app/api/_sec_audit_probe/route.ts` に細工したルートを一時的に置いて検証した（実行後に削除済み）。
  ```
  ① export async function POST() {…}                        → 1 failed / 10 passed（正しく検出）
  ② const withPublicMutation = <T,>(h: T) => h               → 11 passed（検出できない）
     export const POST = withPublicMutation(async () => …)
  ```
- **影響**: 「ラッパを通っている**ように見える**」ルートが列挙テストを通過する。故意の回避は想定しにくいが、
  リファクタで別モジュールの同名関数に差し替わる事故は起こりうる。**SEC-037 の構造的保証は
  「識別子名が一致する」までであり、「認証非依存ラッパを実際に通る」ことまでは保証しない。**
- **修正方針**: 同ファイルに、ルートソースが `import { withPublicMutation } from '@/lib/public-guard'`
  （`withCronAuth` は `@/lib/cron-auth`）を持つことの assert を追加する。**P3-b で最初の実ルートを作るときに
  同時に入れること**（対象が 0 件の今は空振りする）。

---

### [SEC-048] `now` を呼び出し側が渡す設計により、進んだ時計を持つ 1 回の `acquire` がシャードの在庫を一括消去する

- **重大度**: **Low**（現状）/ **P3-b の設計制約としては必須**
- **カテゴリ**: 設計（時刻依存）
- **場所**: `lib/semaphore.ts:117-137`（`ZREMRANGEBYSCORE … now`）/ `lib/semaphore.ts:21-24`（成立条件の記載）
- **実測（S-5）**:
  ```
  満杯（在庫 3）→ 通常の acquire = null（正しい）
  now を +1 時間にした acquire     = 成功 → 直後の在庫 = 1
  （処理中だった 3 件が掃除で消え、同時実行上限が一括解放された）
  ```
- **説明**: 掃除の基準は ARGV の `now` であり、Lua 内で `TIME` を読まない（テスト容易性のための正しい判断で、
  AC-RL-11 が要求している）。その代償として、**進んだ `now` を 1 回渡すだけでそのシャードの
  処理中パーミットが全消去される**。ソース冒頭（`lib/semaphore.ts:21-24`）に
  「インスタンス間のクロックスキューが TTL(20秒) に対して十分小さいこと」が**前提として明記されている**
  点は正しい運用である（P2.5 で問題になった「無条件の性質として書く」形ではない）。
- **影響**: 現状 `now` は `Date.now()` 由来のサーバー内部値であり（`lib/public-guard.ts:162`）、
  攻撃者は制御できない。**したがって現時点で悪用経路は無い。** リスクは将来の変更である。
- **修正方針（P3-b の要件）**: **`now` にリクエスト由来の値（ヘッダ・ボディ・Cookie の `issuedAt` 等）を
  渡さないこと**を要件として固定する。`withPublicMutation` の `now` オプションはテスト用であり、
  本番配線で上書きしない。前提（クロックスキュー）を検証する手段が無いことは
  `tech-stack.md` §4.5 に「前提であって性質ではない」と既に併記済みで、この記述は正確なので変更不要。

---

### [SEC-049] 同一 `permitId` での二重 `acquire` は枠を 1 つしか消費せず、先に `release` した側が両方を解放する

- **重大度**: **Low**（現状）/ **P3-b の設計制約**
- **場所**: `lib/semaphore.ts:136`（`ZADD` に `NX` が無い）/ `lib/semaphore.ts:246, 250-252`（`newPermitId` が注入可能）
- **実測（S-6）**: 同一 `permitId` で 2 回 `acquire` → **2 回とも成功を返すが在庫は 1**。
- **説明**: `ZADD` は同一 member の score を更新するだけなので、`permitId` が衝突すると
  (a) 同時実行上限を実質的に超える（2 つの処理が 1 枠で走る）、
  (b) 先に終わった側の `release` が後続の枠も解放する、という 2 つの帰結が生じる。
  既定の `permitId` は `crypto.randomBytes(16)`（128bit）なので**衝突は現実的でない**。
- **影響**: **`newPermitId` が注入可能**であるため、P3-b が「冪等性のために `sid` を `permitId` に使う」
  といった決定的な値を渡すと、同一セッションの並行送信で上限が破れる。
- **修正方針**: (a) `newPermitId` の JSDoc に「**決定的な値を渡してはならない**」を明記する、
  または (b) `ZADD` に `NX` を付けて既存 member への上書きを拒む。**(a) で足りる**
  （P3-b レビューの確認項目にすること）。

---

### [SEC-050] middleware の matcher が `/api` で始まる**任意のパス**を除外するため、将来そのようなページに CSP が付かない

- **重大度**: **Low**
- **場所**: `middleware.ts:70` — `'/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'`
- **説明**: 否定先読み `(?!api|…)` はパス先頭の**部分一致**なので、`/api` だけでなく `/apiary` や
  `/apiabc` のようなパスも除外される。現在そのようなルートは存在しない（`app/` 実測）ため実害は無い。
- **影響**: 将来 `/api` で始まる名前のページを追加すると、**CSP が付かないまま無言で公開される**
  （ビルドも型検査も lint も通る。§D I-9 と同じ「無言で壊れる」型）。
- **修正方針**: `'/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$).*)'` のように
  区切りまたは終端を含める。

---

### [SEC-051] IPv6 正規化で `::1` と廃止された IPv4 互換記法 `::a.b.c.d` が同一の `0:0:0:0::/64` バケットに落ちる

- **重大度**: **Info**
- **場所**: `lib/rate-limit.ts:239-253`
- **実測（G-10）**: `::1` → `a:0:0:0:0::/64` / `::198.51.100.7` → `a:0:0:0:0::/64`（同一キー）。
  現行の IPv4 射影 `::ffff:` 形は正しく IPv4 へ畳まれている。
- **説明**: IPv4 互換アドレス（`::a.b.c.d`）は RFC 4291 で廃止済みであり、実運用のクライアントは使わない。
  ループバック `::1` は信頼できるプロキシ配下では現れない。**実害はほぼ無い**が、
  `trustProxy=true` の非 Vercel 構成で前段が `::1` を渡すと全員が 1 バケットに落ちる。
- **修正方針**: 任意。`::a.b.c.d`（`groups[0..5]` が全て 0）も IPv4 として畳むか、正規化できない旨を明記する。

---

## F. P3-b 着手可否の判定

### 判定: **P3-b 着手不可（条件付き）** — SEC-042 / SEC-043 を閉じてから着手すること

**理由**:

1. **`docs/phase-status.md` の P3-a 完了条件は「Security Critical 0 / High 0」である。** 本監査で
   **High 2 件**（SEC-042 / SEC-043）が実測で再現した。この時点で P3-a は完了していない。
2. **2 件とも「P3-b が配線した瞬間に本番へ出る」性質のもの**である。P3-a には公開ルートが 1 本も無いため
   **今日の本番は無事**だが、P3-b の最初のコミットでそれが変わる。**先送りに合理性が無い。**
3. **2 件とも修正は小さく局所的**である。SEC-042 は `lib/form-session.ts` の 2 行
   （`lib/cron-auth.ts` に正しい実装が既にある）、SEC-043 は `lib/public-guard.ts` の Tier D 判定に
   `trusted` の分岐を 1 つ足す変更である。**P3-b の作業量に比べて無視できる。**

### 着手の条件（この 2 件のみをブロッカーとする）

| # | 条件 | 検証方法 |
|---|------|---------|
| **B-1** | **SEC-042** を修正し、`verifyFormSessionValue` がマルチバイト文字を含む署名でも例外を投げず `null` を返すこと。併せて `withPublicMutation` が `verifyFormSession` / `formSessionKey` の例外を Tier B へ落とすこと | 「壊れた形式」テストに **ASCII 以外の境界**（`é` を含む署名 / サロゲートペア / base64url 外の文字）を追加。ラッパ経由で **403** になることを 1 本 |
| **B-2** | **SEC-043** を修正し、`trusted === false` のとき per-source 軸を**計数のみ**に使い 429 の理由にしないこと。かつ `trusted === false` で別軸（`verifyFormSession`）が未設定なら**構築時に落とす**こと | `clientIp: () => ({key:'unknown', trusted:false})` を注入したテストを追加し、**攻撃者が上限まで叩いた後も無関係な発信元が 429 にならない**ことを固定 |

> **SEC-044 / SEC-045 / SEC-046 は P3-b 着手をブロックしない**が、**P3-b の完了条件に含める**（下表）。

### P3-b で守るべき要件（更新）

| # | 要件 | 出所 |
|---|------|------|
| **P3b-1** | `withPublicMutation` を実ルート（`POST /api/applications`）に配線する際、**`limiters.formSession` と `formSessionKey` を必ず渡す**。IP 軸だけで Tier D を構成しない | 条件1'-3 / SEC-043 |
| **P3b-2** | **`auth.ts` と公開エンドポイントの limiter に KV store を注入する**（SEC-033 の未達部分）。注入後、`.env.example` / `lib/env.ts` の文言と実態を一致させる | 条件2 SEC-033 / SEC-044 |
| **P3b-3** | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限を 32 文字にする | SEC-046 |
| **P3b-4** | **`now` にリクエスト由来の値を渡さない。** `newPermitId` に決定的な値（`sid` 等）を渡さない | SEC-048 / SEC-049 |
| **P3b-5** | CSP の検証対象を `/apply` へ切り替える際、**`csp.spec.ts` だけを根拠にしない**。`/apply` を実ブラウザで開いて**違反 0** と**ページが白紙でないこと**の両方を見る（`/schools` の静的化を捕まえたのは `school-access.spec.ts` である） | Impl 申し送り I-8 |
| **P3b-6** | `app/layout.tsx` の `force-dynamic` に**構造的な歯止め**（ソース assert またはビルド出力に静的ルートが無いことの検査）を入れる。**CSP の nonce 方式がこれに依存している** | Impl 申し送り I-9 |
| **P3b-7** | ルート列挙テストに **import 元の検証**を追加する（最初の実ルートと同時に） | SEC-047 |
| **P3b-8** | 公開エンドポイントに**リクエストボディのサイズ上限**を設ける（`withPublicMutation` は現在サイズを見ていない） | 本監査で新規に確認 |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` を変更したら、**実 Redis に対して §C のシナリオを再実測する**。`SemaphoreKvClient` は `eval` / `zrem` の 2 メソッドなので、RESP クライアントを差すだけで成立する（本監査の方法） | I-1 / I-2 の受容条件 |
| **P3b-10** | `withCronAuth` に粗い試行回数制限を入れる（P3-c までに） | SEC-046 |

---

## G. 副次的に確認したが指摘に至らなかった点

| 確認項目 | 結果 |
|---------|------|
| **AC-PII-1**（拒否・劣化ログに PII を出さない）| **達成**。実測 G-6 — ログは `{"tier":"D","axis":"source","endpoint":"applications","keyHash":"c01adef6"}` のみ。生 IP（`203.0.113.42`）も `sid` も含まれない。`keyDigest` は sha256 先頭 8 文字（`lib/public-guard.ts:138-140`）で、逆引きの実用性が無い一方、相関には十分 |
| **retryAfterMs のテスト用フックが本番へ漏れないこと** | **達成**。実測 G-8（子プロセスで env を切り替え）— `CI=1` + `NODE_ENV=production` → **600000ms（丸め無し）** / `CI=1` + `NODE_ENV=test` → 1500ms / `CI` 無し + production → 600000ms。`lib/public-guard.ts:70-72` の条件が正しく効いている |
| **例外経路での `release`** | **達成**。実測 G-7 — 本体が throw しても `release` が 1 回呼ばれる（`lib/public-guard.ts:230-232` の `finally`）。ただし**例外はラッパの外へ抜ける**（SEC-042 の増幅要因） |
| **Tier C に `Retry-After` を付けない / Tier D に付ける** | **達成**。G-2 で Tier C の `retry-after` ヘッダが `null`。`lib/public-guard.ts:125, 128-132` |
| **`limit: 0` の limiter が最初の 1 回を通さない** | **達成**（Impl が P3-a で発見・修正した既存の穴）。実測 G-9 — KV store 経路でも `limit=0` の 1 回目が `success:false` |
| **KV store が判定ロジックを持たないこと（AC-RL-8）** | **達成**。`lib/kv.ts` は `increment` / `get` / `set` / `delete` のみを export し、`consume` / `peek` / `reset` を持たない。判定は `lib/rate-limit.ts:352-360, 369-374` に閉じている |
| **`withCronAuth` の未認証応答** | **達成**。404 固定（`lib/cron-auth.ts:30-32`）/ `CRON_SECRET` 未設定で fail-closed（`:51-52`）/ `timingSafeEqual` を Buffer 長で先に弾いてから使用（`:39-43`。**SEC-042 の欠陥は無い**）/ `Origin` を見ない（設計どおり） |
| **鍵の用途分離** | **達成**。`lib/form-session.ts:78-80` が HKDF（用途ラベル `driving-school/form-session/v1`）で導出し、`lib/env.ts:101-107` が `FORM_SESSION_SECRET === AUTH_SECRET` を拒否する |
| **Cookie 属性** | **達成**。`__Host-fs` + `HttpOnly` + `Secure` + `SameSite=Lax` + `Path=/`（`lib/form-session.ts:29, 64-72`） |
| **`.env` の秘密がコミットされていないか** | **問題なし**。`.gitignore:34-36` に `.env` / `.env.local` / `.env.*.local`。`.env.example` に実値は無い |
| **`ci.yml` のダミー値** | **問題なし**。すべて CI 専用のダミーで、実 KV へは接続しない。`FORM_SESSION_SECRET` は `AUTH_SECRET` と別値（`lib/env.ts` の用途分離検証を通る） |
| **セキュリティヘッダ（CSP 以外）** | **問題なし**。`next.config.mjs:4-9` — `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / `Permissions-Policy`。CSP の `frame-ancestors 'none'` と整合 |
| **ZSET キーの TTL** | **記録のみ**。キー単位 TTL は設計上正しく持たない。キー数は 3 エンドポイント × 4 シャード = **12 で有界** |
| **`permitId` が暗号論的乱数か（Test 申し送り T-8）** | **達成**。`lib/semaphore.ts:31, 250-252` が `crypto.randomBytes(16)`。`Math.random` ではない |
| **`app/api` にラッパ未経由の変更系ルートが無いか** | **問題なし**。存在するのは `admin/**`（`withAdminMutation` 経由）と `auth/[...nextauth]`（明示された例外）のみ |
| **`isSameOrigin` の fail-closed** | **達成（退行なし）**。`lib/http-guard.ts:23-32` は P2.5 から未変更。G-1 / G-2 の全シナリオで `Origin` 付きのみ通過 |

---

## H. 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **2 新規（SEC-042 / SEC-043）** |
| Medium | **3 新規（SEC-044 / SEC-045 / SEC-046）** ＋ 繰越 SEC-031 / SEC-032（部分）/ SEC-033（部分）/ SEC-038 |
| Low | **4 新規（SEC-047 / SEC-048 / SEC-049 / SEC-050）** ＋ 繰越 SEC-014〜017 / SEC-025〜027 / SEC-039 / SEC-041（部分） |
| Info | **1 新規（SEC-051）** ＋ 繰越 SEC-036 / SEC-037（部分）/ SEC-018〜020 / SEC-040 |

**クローズ**: **SEC-034**（直列化の単一障害点 — `increment` 経路が `serialize` を通らないことをコードと
実 Redis の `EVAL` 発行回数で確認）。**SEC-002**（P3-a の範囲で。`/apply` 公開時に再検証）。

**部分クローズ（未クローズとして扱う）**: SEC-031 / SEC-032 / SEC-033 / SEC-037 / SEC-041。

### リリース判定: **リリースをブロックする**（High 2 件。監査スキルのブロック基準）

ただし**現時点の本番に露出している脆弱性ではない**——`lib/public-guard.ts` / `lib/cron-auth.ts` /
`lib/form-session.ts` はいずれも**呼び出し元が 0 件**であり、公開ルートは P3-b の成果物である。
**ブロックしているのは「P3-a の完了宣言」と「P3-b の着手」であって、既存の P1 / P2 のデプロイではない。**

### P3-b 着手判定: **不可（条件付き）**。SEC-042 / SEC-043 の 2 件を閉じれば着手可

### 是正の優先順位

1. **SEC-042**（High / `lib/form-session.ts` 2 行 + テスト境界の追加）
2. **SEC-043**（High / `lib/public-guard.ts` に `trusted` の分岐 + 縮退経路のテスト追加）
3. **SEC-044**（Medium / `auth.ts` への store 注入 + 文書の整合。担当フェーズを決めること）
4. **SEC-046**（Medium / `lib/env.ts` の下限。1 箇所の変更）
5. **SEC-045**（Medium / SEC-044 と同時に閉じるのが自然）
6. SEC-047〜051（Low / Info。P3-b の作業に混ぜてよい）

### 評価 — 何がうまくいき、何が繰り返されたか

**うまくいったこと**:

- **セマフォは、旧機構の欠陥 1・2 のいずれも実 Redis 上で再現しなかった。** これは
  「テストが green」ではなく「本物の Lua を本物の Redis で走らせた」結果である。
  ZSET によるパーミット単位のリースという設計判断（RV-P3DR-001）は正しかった。
- **Test Agent の「契約の検出力をテストで実証する」構造**（`semaphore-contract-detects-defects.test.ts`）は、
  過去 3 回の失敗の根（テストの検出力を誰も検証していなかった）に正面から効いている。
  本監査が実 Redis で確認した性質は、いずれもこの契約が守ろうとしていた性質と一致していた。
- **Impl の申し送り §8 は正確だった。** I-1 / I-3 / I-8 は「検証していない」と正しく申告されており、
  本監査はその申告を信じて（＝再測定して）2 件を閉じることができた。
  **「PASS と書かない」姿勢は P2.5-b から一貫している。**
- オーケストレーターが Impl の未開示のテストファイル変更 3 件を独立に検証し、
  **契約行の行番号まで照合して改竄が無いことを確認している**（Impl ノート §4.2）。この運用は正しい。

**繰り返されたこと**:

- **SEC-042 は「契約は正しく書かれていたが、境界の選び方が欠陥をすり抜けた」型である。**
  `form-session.test.ts:129` は「壊れた形式でも例外を投げず null」という**正しい契約**を書いているのに、
  与えた 5 つの入力がすべて ASCII だったために `Buffer` 長の不一致に到達しなかった。
  P2.5 の教訓（契約自体の欠陥）とは違う、**新しい型の失敗**である:
  **契約が正しくても、その契約を検証する入力の選び方が脅威モデルと一致していなければ意味がない。**
- **SEC-043 は「前提と判定式のずれ」（SEC-021 → SEC-029 → SEC-038 と同じ型）の 4 度目である。**
  `lib/http-guard.ts:86-94` は **「`trusted` を捨てる呼び出しはこの防御を無効化する」と名指しで警告していた**。
  それでも新しいラッパは `clientIp(request).key` だけを取り出した。
  **「警告をコメントに書く」ことは、呼び出し側が読まなければ機能しない。**
  型で強制する（`ClientIpResolution` を分解せずに渡す API にする、`trusted` を必須引数にする）か、
  テストで固定する以外に、この型の再発を止める手段は無い。
- **SEC-044 は「文書が事実と異なる」型の 3 度目である。** 今回は文書だけでなく
  **本番の fail-fast というより強い形**で「KV が必要である（＝使われている）」という主張が入った。
  fail-fast は正しい方向の変更だが、**注入が伴わないと「守られている」という誤った確信を強化する装置になる。**

**方法論についての記録**: 本監査は、`SemaphoreKvClient` が `eval` / `zrem` の 2 メソッドしか要求しない
設計だったおかげで、**RESP クライアントを 1 つ書くだけで本物の Lua を本物の Redis に載せて検証できた**。
Impl / Test が「実 Redis は P3-a に足さない」と判断した理由（REST プロキシが要る・(e-3) が観測できない）は
**正しかった**が、**監査者が 1 回だけ実測する**にはこの抽象で十分だった。
**インタフェースを最小に保つことが、そのまま検証可能性になっている**——この設計判断は記録に値する。

---

# P3-a 再監査（2026-07-29）

## 監査日: 2026-07-29
## 対象: P3-a 差し戻し修正（SEC-042 / SEC-043 / SEC-047 + RV-P3A-001 / RV-P3A-003）の検収と、P3-b 着手可否の最終判定
## 入力: `docs/p3a-fix-plan-2026-07-29.md` / `docs/review-p3a-fix-tests-2026-07-29.md` / `docs/impl-p3a-fix-notes-2026-07-29.md` / 本書「P3-a 監査」§E・§F

### 監査の方法（前回と同じ水準を維持した）

**「テストが green」も「Impl の記述」も完了根拠として一切採用していない。** 品質ゲート
（unit 359 / integration 28 / type-check 0 / lint 0 / build 成功 / E2E 101 passed・2 skipped・0 failed）は
オーケストレーターの独立実行値を前提とし、**再実行していない**。E2E は指示どおり実行していない。

代わりに、**実装モジュールの本物のエクスポートに監査者自身が攻撃を直接投入して実測**した。

| 実測環境 | 内容 |
|---------|------|
| ラッパ・軸・縮退（§A-1 / §B）| `lib/public-guard.ts` / `lib/rate-limit.ts` / `lib/http-guard.ts` の本物のエクスポートに `Request` を直接投入（`tsx` 実行。プローブは実行後に削除済み）|
| Cookie 署名（§A-2）| `lib/form-session.ts` の本物の `createFormSessionValue` / `verifyFormSessionValue`。**HTTP ヘッダが実際に運べる値**（latin1 デコード後の文字列）で 0x80–0xFF の全域 128 件 + 設計入力 32 件 + ランダムファズ 20,000 件 |
| 型の継ぎ目（§A-1 型）| 再発経路と抜け穴を書いたプローブに対する `tsc --noEmit` の実測 |
| ルート列挙テストの検出力（§A-3）| `app/api/_sec_reaudit_probe/` に細工したルートを一時的に置き、`api-route-guard-coverage.test.ts` を実行して**落ちるか**を実測。**実行後に削除し、`app/api` が `admin/**` + `auth/[...nextauth]` の 6 ファイルのみに復旧したこと、`tsc --noEmit` がエラー 0 に戻ったことを確認済み** |

**今回、Impl の実装記録 §6「断定できないこと」は本監査の判定に一切使っていない**
（E2E の 103 vs 100 件差・flaky の扱いはセキュリティ上の含意が無く、§D で扱う）。

---

## A. クローズ判定表（SEC-042 / SEC-043 / SEC-047）

| ID | 深刻度 | 判定 | 根拠（file:line + **監査者自身の実測**）|
|----|-------|------|-----------------------------------|
| **SEC-043 / RV-P3A-001** | High | **クローズ** | §A-1 |
| **SEC-042** | High | **クローズ** | §A-2 |
| **SEC-047** | Low | **クローズ**（残る検出漏れは SEC-054 として新規計上）| §A-3 |

### A-1. SEC-043 — 前回の攻撃（G-1）を再実行して再現しないことを確認した

**修正の場所**: `lib/public-guard.ts:53-72`（`SourceAxis` / `sourceAxisFor`）、`:228-261`（Tier D ループ）、
`:263-269`（条件1'-3 の Tier B 降格）、`:151`（`PublicGuardOptions.clientIp` の型）。

| # | シナリオ | 前回（P3-a 監査）| **今回の実測** | 判定 |
|---|---------|----------------|--------------|------|
| **R-0** | 縮退の前提確認（`VERCEL` 未設定）| `{"key":"unknown","trusted":false,"source":"unknown"}` | **同一**（`x-forwarded-for: 203.0.113.9` を付けても不変）| 前提は不変 |
| **G-1 再実行** | `limiters.source` のみ / 攻撃者が上限（3回）まで叩いた直後に無関係な発信元が送信 | `200,200,200` → **victim 429**（handler 3回）| **`403,403,403,403,403`**（本文 `{"challenge":"interactive"}` / **handler 実行 0 回**）| **再現しない。** 共有 `unknown` バケットの枯渇が拒否理由になる経路が消えた。全リクエストが Tier B なのは「別軸の無い縮退構成」を fail-closed にした結果で、**第三者の送信で状態が変わらない**（＝攻撃者が引き起こす締め出しではない）|
| **G-1b** | 上に `verifyFormSession` を足した P3-b 想定構成 | （前回は該当構成なし）| 攻撃者 3 回 → `201,201,201`、**無関係な発信元 2 者とも `201`**（handler 5 回）| **第三者が全利用者を締め出せない。** SEC-043 の本体が閉じている |
| **M-3** | 縮退時に計数が止まっていないか | — | store entry = `{"count":3,"resetAt":…,"saturated":true}` / size=1（6 回送信後）| **ゲートに使わないだけで計数は継続**。攻撃の観測手段を失っていない |
| **M-4** | `trusted=true`（Vercel 相当）の退行確認 | — | 攻撃者 `201,201,201,429,429` / **別 IP の正規利用者 `201`** | per-source ゲートは通常構成で健在。是正が「ゲートごと削除」になっていない |
| **M-5** | Vercel 上でも IP ヘッダが不正な場合（SEC-043 の悪用条件 (c)）| — | 不正 XFF の攻撃者 5 回 `201×5` / 別の不正 XFF 利用者 `201` / 正常 XFF 利用者 `201` | **縮退経路でも巻き添えが起きない** |
| **M-6** | `sourceAxisFor` の直接検証 | — | `trusted:true` → `{"key":"applications:203.0.113.9","enforce":true}` / `trusted:false` → `{"key":"applications:unknown","enforce":false}` | 縮退判定が 1 箇所（`lib/public-guard.ts:71`）に閉じている |

#### 型による強制が実際に効いているか（**監査者自身が `tsc --noEmit` で実測**）

再発経路と抜け穴を並べたプローブを置いて型検査した結果:

```
__sec_reaudit/typeprobe.ts(7,65): error TS2345: Argument of type 'string' is not assignable to
  parameter of type 'ClientIpResolution'.                       ← sourceAxisFor(endpoint, resolveClientIp(r).key)
__sec_reaudit/typeprobe.ts(10,14): error TS2322: Type '() => { key: string; trusted: false; }' is not
  assignable to type '(request: Request) => ClientIpResolution' ← clientIp の戻り値型を緩める
```

**`.key` だけを渡す実装は実際にコンパイルできない。** Impl の申告（実装記録 §1）は、監査者自身の再実測と一致した。

**残る抜け穴（実測でコンパイルが通ったもの）** — いずれも「うっかり」ではなく意図的な迂回である:

| 抜け穴 | 実測 | 評価 |
|-------|------|------|
| `resolveClientIp(r).key as unknown as ClientIpResolution` | **通る** | `as` は型の主張を上書きする。TypeScript の性質であり本設計の欠陥ではない |
| `clientIp: () => ({ key:'unknown', trusted:true, source:'x-forwarded-for' })`（`trusted` を偽る）| **通る** | 型は「嘘」を止めない。振る舞いテスト（`public-guard-degraded-source.test.ts:164` の getter 観測）が補っている |
| `SourceAxis` を直接リテラルで組み立てて `enforce:true` にする | **通る** | Tier D の `axes` 配列は `sourceAxisFor` を経由せずに `push` できる。**`enforce` の値そのものは型で縛られていない** → **SEC-052** |

`lib/` 配下に `as any` / `@ts-ignore` / `@ts-expect-error` による迂回は無い（grep 実測）。

### A-2. SEC-042 — 細工 Cookie が 500 にならず Tier B に落ちることを実測した

**修正の場所**: `lib/form-session.ts:128-131`（バイト長比較）、`lib/public-guard.ts:235-253`（`formSessionKey` の
try/catch）、`:271-286`（`verifyFormSession` の try/catch）。

#### 入力の選び方が脅威モデルを覆っているか（**前回穴だった点。監査者自身が独立に設計した**）

契約書 `docs/review-p3a-fix-tests-2026-07-29.md` §T2 の分類表を**そのまま採用していない**。
点検の結果、**分類表には脅威モデル上の不正確さがある**:

> `あ`（U+3042）/ `😀`（U+1F600）/ 孤立サロゲート（U+D800）は、**HTTP ヘッダ値としてサーバーに到達できない**。
> ヘッダ値は ByteString（各コードユニット ≤ 255）であり、Node の HTTP パーサは生バイト列を latin1 として
> 文字列化する。攻撃者が UTF-8 の `é`（`0xC3 0xA9`）を Cookie に入れたとき、アプリが受け取るのは
> `"Ã©"`（**JS 長 2 / UTF-8 バイト長 4**）である。実測でも、`あ` / `😀` / `\uD800` を Cookie に入れた
> `Request` は**構築時点で undici に弾かれた**（`Cannot convert argument to a ByteString …`）。

したがって、契約書のテストは**欠陥クラスには到達しているが、到達理由が実際の攻撃経路と違う**。
本監査は**実際にワイヤを通る形**（latin1 デコード済み文字列）で独立に検証した:

| # | 監査者が設計した入力 | 件数 | **実測結果** |
|---|--------------------|------|------------|
| **C-1** | 署名先頭バイトを **0x80〜0xFF の全域**に置換（latin1 経路の全数）| **128** | **例外 0 / 誤って検証通過 0** |
| **B-1** | 設計入力: 2/3 バイト境界（U+0080 / U+07FF / U+0800）・U+FFFD・サロゲートペア・孤立 high/low/逆順サロゲート・**バイト長一致で JS 長のみずれる逆方向**（é で ASCII2文字置換等）・長さ ±1 / 0 / 1 / 10,000 / 100,000 文字・NUL / 改行 / 空白・payload 側の非 ASCII / 孤立サロゲート / 200,000 文字・ドット数異常 | **32** | **例外 0 / 誤って検証通過 0** |
| **B-3** | ランダムファズ（0x0000–0x10FFF のコードユニットを 1–90 個、1/3 ずつ payload 側 / 署名側 / 両側）| **20,000** | **例外 0 / 誤って通過 0** |
| **C-2** | **ラッパ経由**（実物の `verifyFormSessionValue` を `formSessionKey` / `verifyFormSession` に配線）: UTF-8 `é`(2byte) / `あ`(3byte) / `😀`(4byte) の生バイト・不正 UTF-8（`0xC3` 単独 / `0xED 0xA0 0x80` = 孤立サロゲート）・`0xFF` 連打・署名長 0・署名 8KB | **8** | **全件 `403 {"challenge":"interactive"}`。例外がラッパの外へ抜けたものは 0 件** |
| **C-4** | 供給関数そのものが throw（`formSessionKey` が `TypeError` / `verifyFormSession` が `Error`）| 2 | **両方 `403 {"challenge":"interactive"}`** |
| **C-6** | 例外由来 Tier B と正常 Tier B（署名不一致）の応答一致 | — | **status / body / ヘッダが完全一致**（`403` / `{"challenge":"interactive"}` / `content-type: application/json` のみ）。**どの入力が内部エラーを起こすかを bot に教えていない** |
| **C-3 / B-2** | 正常系の退行 | — | 正規 Cookie → `201`（handler 実行 1 回）/ `verifyFormSessionValue` → `{"sid":"sid-1","issuedAt":…}`。期限切れ・未来の `issuedAt` は `null` |

**判定: SEC-042 はクローズ。** `lib/form-session.ts:128-131` は `lib/cron-auth.ts:39-43` と同形（先に `Buffer`
へ変換してからバイト長で弾く）であり、`try/catch` による握り潰し（比較未到達と署名不一致を区別できなくする形）は
採られていない。構造テスト `form-session.test.ts:248` が `providedSignature.length !==` の再出現を禁じている。

**計算コスト（長さ上限が無いことの影響。実測）**: payload 1,000 → 0.09ms / 100,000 → 0.29ms /
1,000,000 → 2.5ms / 8,000,000 → 24.7ms。`sign()` は**長さ検査の前に** payload 全体の HMAC を計算するが、
Node の HTTP ヘッダ上限（既定 16KB）で実質的に有界であり、増幅率も線形にとどまる。**指摘に至らない**（記録のみ）。

### A-3. SEC-047 — ローカル no-op の同名ラッパを置いたルートで列挙テストが落ちることを実測した

前回の監査は `app/api/_sec_audit_probe/route.ts` に下記を置いて **11/11 green のまま通過**した。同じ形を再投入した:

```ts
// app/api/_sec_reaudit_probe/route.ts（一時）
const withPublicMutation = <T,>(handler: T) => handler
export const POST = withPublicMutation(async () => new Response('ok'))
```

```
FAIL tests/unit/api-route-guard-coverage.test.ts >
  ラッパは本物のモジュールから import されている（同名のローカル定義では通らない / SEC-047）
AssertionError: app/api/_sec_reaudit_probe/route.ts: withPublicMutation が lib/public-guard.ts 由来でない
  （ローカル定義または別モジュールの同名関数）
Test Files  1 failed (1) / Tests  1 failed | 18 passed (19)
```

**前回 11/11 green で通過した形が、今回は 1 failed で落ちた。SEC-047 はクローズ。**
判定ロジックは `tests/unit/api-route-guard-coverage.test.ts:142-183`（`importsIdentifierFrom` /
`declaresLocally` / `usesGenuineWrapper`）で、`import type`・別モジュール・ローカル宣言による被覆をすべて弾く。

**ただし、同じ手法で 3 つの検出漏れが 19/19 green のまま通過した** → **SEC-054**（§C）。

**復旧確認**: プローブ削除後に `app/api` が 6 ファイル（`admin/_guard.ts` / `admin/news/**` 4 本 /
`auth/[...nextauth]/route.ts`）へ戻り、`api-route-guard-coverage.test.ts` が **19/19 green**、
`tsc --noEmit` が**エラー 0** に復帰したことを実測済み。

---

## B. 脅威が別の場所へ移動していないかの能動的探索

**このプロジェクトでは SEC-021 → SEC-029 → SEC-030 → SEC-043 と同型が 4 回移動している。**
「縮退時に per-source ゲートを外した」結果、締め出しが別の軸・別の経路で成立しないかを実測で探した。

| # | 探索した経路 | **実測** | 結論 |
|---|------------|---------|------|
| **D-1** | 縮退 + 別軸あり構成で、per-source ゲートを外した結果**実効的な流量上限が残っているか** | `limiters.source` の `limit=3` に対し **500 回送信して 500 回とも `201`（handler 500 回実行）** | **縮退時、`limiters.formSession` + `formSessionKey` を渡さない構成には流量上限が一切無い** → **SEC-053** |
| **D-2** | 上に `formSession` 軸を足した場合の実効上限 | Cookie 1 枚 → handler **3 回** / Cookie 10 枚 → **30 回**（各軸 `limit=3`）| 別軸を渡せば上限は復活する。**P3b-1 が「推奨」ではなく成立条件である**ことの実測 |
| **D-3 / D-4** | `formSession` 軸の `enforce: true` 固定が、共有キーを返す配線で硬いゲートに戻るか | `formSessionKey` が Cookie 不在時に固定値（`'anonymous'`）へフォールバックする配線で、**`trusted=true`（通常の Vercel 構成）でも**、単一 IP の攻撃者が 3 回送信した直後に**別 IP の利用者が 429** | **脅威は移動している。** 型でも `tsc` でも既存テストでも検出されない → **SEC-052** |
| **D-6** | 署名検証**前**に `formSession` 軸を `consume` している帰結 | 署名不正の Cookie を 2,000 種送信 → store 件数が **maxEntries(500) に張り付いた** | 未認証の第三者がインメモリ store のキー空間を占有できる → **SEC-055** |
| **D-5** | `rateLimitKey` の `toLowerCase()` が Cookie 軸のキー空間に与える影響 | `rateLimitKey('applications:fs:','AbC') === rateLimitKey('applications:fs:','aBc')` → **true** | base64url は大小文字を区別するため、Cookie 軸のキー空間が縮む → **SEC-056**（Info）|
| **D-7** | 縮退時にセマフォ（共有軸）が硬いゲートへ昇格していないか | 枯渇時 **`202 {"retryAfterMs":1005}` / `Retry-After` ヘッダ無し** | **条件1'-1 は維持**。共有軸は依然として Tier C |
| **M-2** | 「別軸なし縮退構成」が素通りしていないか | `limiters` すら無い最小構成で **`403 {"challenge":"interactive"}` / handler 実行 0 回** | 条件1'-3 は成立。素通りも 429 もしない |

---

## C. 新規指摘（SEC-052 以降）

### [SEC-052] `formSession` 軸の `enforce: true` はコメントによる前提の上に直書きされており、SEC-043 の是正が施された継ぎ目が「P3-b が実際に配線する軸」だけ素通りしている

- **重大度**: **Medium**（現状は呼び出し元 0 件のため悪用不可 / **P3-b の着手時点で顕在化する**）
- **カテゴリ**: 設計（前提と判定式のずれ）/ 可用性（CWE-770 の裏返し）
- **場所**: `lib/public-guard.ts:245-252`（`enforce: true` のリテラル）/ `lib/public-guard.ts:135`
  （`formSessionKey?: (request: Request) => string | null`）/ `tests/unit/public-guard-degraded-source.test.ts:144-161`
- **説明**: SEC-043 の是正は、発信元軸について
  「`ClientIpResolution` 全体からしか軸を作れない」型の継ぎ目（`sourceAxisFor`）を入れ、
  縮退判定を 1 箇所に閉じた。**これは正しい。** しかし `formSession` 軸には対応する継ぎ目が無く、
  `enforce: true` が**リテラルで直書き**されている。その正当化は隣接コメント
  「Cookie 軸は**攻撃者自身に閉じている**（共有バケットではない）のでゲートに使える」だけである。

  この「攻撃者自身に閉じている」は**実装の性質ではなく、P3-b の呼び出し側が渡す `formSessionKey` に
  対する前提**である。`formSessionKey` の戻り値型は素の `string | null` で、
  「攻撃者自身に閉じた値」と「利用者間で共有される値」を型が区別しない。
  **`lib/http-guard.ts:86-94` が名指しの警告コメントで再発を止められなかったのと、構造がまったく同じである。**
- **実測（D-3 / D-4）**: `formSessionKey` が Cookie 不在時に固定値へフォールバックする配線
  （`request.cookies.get(name)?.value ?? 'anonymous'` は現実に書かれうる形）で:
  ```
  trusted=true（通常の Vercel 構成）/ source limit=100 / formSession limit=3
  攻撃者（198.51.100.1）3 回        → 201, 201, 201
  無関係な利用者（203.0.113.42）1 回 → 429      ← 共有バケットの枯渇が「拒否」になっている
  ```
  縮退構成に限らず、**通常構成でも成立する**点が SEC-043 より広い。
- **既存の防御が検出しないことの実測**:
  1. `pnpm type-check` — `formSessionKey` の戻り値は `string` なので**通る**。
  2. `SourceAxis` を経由しない直接の `axes.push({ …, enforce: true })` も**通る**（§A-1 の抜け穴表）。
  3. **テストがこの形を「正しい」として固定してしまっている**: `public-guard-degraded-source.test.ts:144`
     「縮退時でも formSession 軸は硬いゲートのまま」は `formSessionKey: () => 'sid-abc'` という
     **定数キー**を与えて 429 を期待している。**共有キーで硬いゲートになる形そのものが、
     期待値として書かれている。** 契約のどこにも「`formSessionKey` は攻撃者自身に閉じた値を返すこと」は無い。
- **影響**: 影響を受けるのは「Cookie を持たない送信者」（＝ Tier B で challenge を出すべき相手）である。
  本来 **403 + `challenge`（解いて再送できる回復可能な経路）** で扱うべきリクエストが、
  単一の攻撃者の送信によって **429 + `Retry-After`（窓が明けるまでの硬い拒否）** に変わる。
  Cookie がブロックされている正当な利用者・初回訪問者が、第三者の行為で回復経路を失う。
- **修正方針（P3-b 着手前に閉じる必要は無いが、P3-b の配線と同時に必須）**:
  1. **`formSessionKey` の戻り値を素の `string` にしない。** 発信元軸と対称に
     `formSessionAxisFor(endpoint, …)` を置き、`enforce` を**呼び出し側が明示する**か、
     「この値は要求元ごとに一意である」ことを表す branded type（例 `type PerRequesterKey = string & { readonly __perRequester: unique symbol }`）
     を要求する。**`enforce: true` をリテラルで書ける状態を残さない。**
  2. `public-guard-degraded-source.test.ts:144` の `formSessionKey: () => 'sid-abc'` を
     **要求元ごとに異なる値**（リクエストから導く）へ変え、加えて
     「**共有キーを返す `formSessionKey` は 429 の理由にならない**」ケースを 1 本足す。
     現状の定数キーのままでは、この欠陥を固定する側のテストになっている。
  3. `lib/public-guard.ts` のヘッダコメントに、`limiters.formSession` の前提
     （「キーは要求元ごとに一意でなければならない」）を**契約として**書く。ただし
     **コメントだけでは 5 度目の再発を止められないことは本件が示している**ので、1. と併せて行うこと。
- **参考**: SEC-021 → SEC-029 → SEC-030 → SEC-043 と同型（**5 度目**）。CWE-770 / OWASP A04:2021

---

### [SEC-053] 縮退構成では、`limiters.formSession` を渡さない限り公開変更系に流量上限が一切無くなった（SEC-043 是正の代償）

- **重大度**: **Medium**（P3-a には公開ルートが 0 件のため現状は潜在。**P3-b 着手と同時に顕在化する**）
- **カテゴリ**: 可用性 / リソース枯渇（CWE-770）
- **場所**: `lib/public-guard.ts:254-261`（`enforce === false` の軸はゲートに使わない）/ `:288-297`（Tier C は 202）
- **説明**: SEC-043 の是正は正しいが、その結果**縮退時（`trusted === false`）に残る Tier D の軸は
  `formSession` だけ**になった。`formSession` 軸は `limiters.formSession` と `formSessionKey` の
  **両方**が渡されたときにしか存在しない。渡されない構成では、Tier D に enforce される軸が 1 つも無い。
  セマフォ（Tier C）は**同時実行数**を抑えるだけで、応答は 202 であり**総量を抑えない**（D-7 で確認）。
- **実測（D-1 / D-2）**:
  ```
  縮退 / limiters.source(limit=3, window=10分) のみ + verifyFormSession あり
    500 回送信 → 201 × 500（handler 実行 500 回）        ← 上限が機能していない
  縮退 / source + formSession(各 limit=3) + formSessionKey あり
    Cookie 1 枚 → handler 3 回 / Cookie 10 枚 → handler 30 回   ← 上限が機能する
  ```
- **影響**: 縮退構成（`next start` の直公開・ローカル・デモ、および Vercel 上でも IP ヘッダが妥当な
  IP リテラルでないリクエスト）で `/api/applications` を配線し、`formSession` 軸を渡し忘れると、
  **単一の攻撃者が窓あたり無制限に DB 書き込みとメール送信を発生させられる**。
  修正前は（有害な形とはいえ）共有バケットが上限として機能していたため、**この経路は今回の是正で新たに開いた**。
  是正の方向自体は正しく、**閉じ方は「per-source ゲートを戻す」ではなく「別軸を必ず配線する」**である。
- **修正方針**: **P3b-1 を「推奨」から「P3-b の受け入れ条件」へ格上げする。**
  1. `/api/applications` の配線で `limiters.formSession` と `formSessionKey` を必ず渡す。
  2. ラッパ側に構造的な歯止めを置く: `limiters.source` を渡しているのに `limiters.formSession` /
     `formSessionKey` が無い構成を**構築時に throw** する（`trusted` と違い、この 2 つは**構築時に分かる**——
     Test Agent が「構築時 throw を採らない」と判断した理由は `trusted` がリクエスト毎に決まる点にあり、
     **オプションの有無には当てはまらない**）。
  3. 2. を入れない場合は、少なくとも「別軸が無い公開ルートが存在しないこと」を列挙テストで固定すること。
- **参考**: 本監査 §B D-1 / D-2、SEC-043 の是正、条件1'-3

---

### [SEC-054] ルート列挙テストは強化されたが、再 export / `route.js` / エイリアス import の 3 形が依然 19/19 green のまま通過する

- **重大度**: **Low**
- **カテゴリ**: 検証の網羅性（防御の保証範囲）
- **場所**: `tests/unit/api-route-guard-coverage.test.ts:84`（`route.ts` / `route.tsx` のみ走査）/
  `:90-104`（`extractMutationExports` の正規表現）/ `:154-158`（import 指定子のエイリアス解決）
- **実測**: `app/api/_sec_reaudit_probe/` に順に置いて実行（いずれも実行後に削除済み）:

  | # | 細工 | 結果 |
  |---|------|------|
  | ① | `const withPublicMutation = <T,>(h:T)=>h` + `export const POST = withPublicMutation(...)` | **1 failed / 18 passed**（SEC-047 の是正が効いている）|
  | ② | `handler.ts` に無防備な `export async function POST()` を置き、`route.ts` は **`export { POST } from './handler'`** | **19 passed（検出できない）** |
  | ③ | `import { TIER_B_BODY as withPublicMutation } from '@/lib/public-guard'` で名前だけ整える | **19 passed（検出できない）** |
  | ④ | `route.js`（Next.js App Router は `.js` も受け付ける。`tsconfig` も `allowJs: true`）に無防備な `POST` | **19 passed（走査対象外）** |

- **説明**: ② が最も現実的である。「ハンドラ本体を別ファイルへ切り出し、`route.ts` は再 export だけにする」
  のは**普通のリファクタ**であり、故意の回避ではない。`extractMutationExports` は
  `export const|function|async function <METHOD>` と分割代入 export しか見ないため、
  `export { POST } from './x'` / `export { handler as POST }` を**変更系メソッドとして認識しない**——
  認識されなければ「ラッパを通っているか」の検査自体が走らない。
  ③ は本物のモジュールから**別のエクスポート**をエイリアスしただけで `importsIdentifierFrom` を通る
  （`:154-158` は `as` の右辺だけを見る）。実行時には壊れるので現実性は低い。
  ④ は本リポジトリが TypeScript 一本であるため当面の実害は無い。
- **影響**: SEC-037 の構造的保証は「`route.ts` 内で直接 export され、名前が一致し、本物のモジュールから
  import されている」までである。**②の形で書かれた公開変更系ルートは、ガードを 1 つも通らないまま
  列挙テストを通過する。**
- **修正方針**（**P3-b で最初の実ルートを作るときに同時に**）:
  1. `extractMutationExports` に再 export 形（`export\s*\{[^}]*\}\s*from`）を認識させる。
     再 export は**その場でラッパ経由か判定できない**ので、**無条件に違反**として扱う
     （「route.ts 内で `withPublicMutation` を適用する」という 1 つの書き方に固定するのが最も安い）。
  2. 走査対象に `route.js` / `route.jsx` / `route.mjs` を加える。
  3. `importsIdentifierFrom` を、**元の名前が `identifier` と一致する**場合だけ通すよう直す
     （`{ A as B }` は `A === identifier` を要求する）。
  4. **この 3 件を検出できることを、合成ソースに対する自己検証（既存の `:288-398` の形）で固定すること。**
- **参考**: SEC-047（クローズ済み）/ SEC-037

---

### [SEC-055] `formSession` 軸は署名検証**前**に `consume` するため、未認証の第三者がインメモリ store のキー空間を占有できる

- **重大度**: **Low**
- **カテゴリ**: リソース枯渇 / レート制限のバイパス（CWE-770 / CWE-841）
- **場所**: `lib/public-guard.ts:235-261`（Tier D の軸ループ）が `:274-286`（`verifyFormSession`）**より前**
- **説明**: `formSessionKey` は**署名を検証していない生の Cookie 値**からキーを作る。
  攻撃者は Cookie 値を自由に変えられるので、**1 リクエストにつき 1 つ新しいバケット**を作れる。
- **実測（D-6）**: `maxEntries=500` のインメモリ store に対し、署名が常に不正な Cookie を 2,000 種送信 →
  **store 件数が 500（上限）に張り付いた**。攻撃者のキーが常駐分を置き換えている。
- **影響**: (a) SEC-023 の件数上限は守られているので OOM には至らない。
  (b) 追い出されるのは未達バケット優先（`lib/rate-limit.ts:162-167`）なので、上限到達済みの
  スロットルは残る（SEC-041 の是正が効いている）。
  (c) ただし**正当な利用者の進行中カウンタが第三者に消される**ため、per-Cookie の計数が薄まる。
  (d) SEC-045（全常駐が上限到達なら上限到達バケットも退避される）と組み合わせると、攻撃コストが下がる。
- **順序が正しいかの評価**: 「検証前に計数する」こと自体は**意図的で妥当**である
  （偽造 Cookie の試行そのものを絞れる）。問題は**キーが検証されていない値そのもの**である点で、
  発信元軸が `isIpLiteral` でキーを検証している（`lib/http-guard.ts:101-102, 127-129`）のと非対称である。
- **修正方針**: (a) **推奨** — SEC-044 の KV store 注入を行い、本番のレート制限を TTL ベース（退避の概念なし）にする。
  (b) `formSessionKey` の段階で**形式検証**（`<base64url>.<base64url>` の形・最大長）を通らない値は
  `null` を返し、軸を作らずに Tier B へ落とす。形式不正の Cookie に新しいバケットを作らせない。
  (c) いずれにせよ、この経路を踏ませるテストを追加して挙動を固定すること。
- **参考**: SEC-023 / SEC-041 / SEC-045

---

### [SEC-056] `rateLimitKey` の `toLowerCase()` により、base64url の Cookie 軸キーが大小文字を区別せず衝突する

- **重大度**: **Info**
- **場所**: `lib/rate-limit.ts:209-215`（`raw.trim().toLowerCase()`）/ `lib/public-guard.ts:250`
- **実測（D-5）**: `rateLimitKey('applications:fs:', 'AbC') === rateLimitKey('applications:fs:', 'aBc')` → **true**
- **説明**: `toLowerCase()` は IPv6 の表記ゆれを畳むための正規化であり、IP 軸には正しい。
  一方 `formSession` 軸のキー材料（base64url = **大小文字を区別する** 64 文字集合）に適用すると、
  キー空間が 1 文字あたり `log2(64) → log2(38)` に縮む。
- **影響**: **実害はほぼ無い。** 他人のバケットに衝突させるには相手の `sid` を知る必要があり、
  Cookie は `__Host-` + `HttpOnly` である。異なる 2 名が偶然衝突する確率も、
  `sid` に十分なエントロピーがあれば無視できる。
- **修正方針**: 任意。`rateLimitKey` に「正規化を IP 軸に限定する」オプションを足すか、
  P3-b で `sid` を**小文字 hex** で発行して衝突の余地自体を無くす（後者が安い）。

---

## D. 修正が新たな攻撃面を持ち込んでいないか（指摘に至らなかった確認）

| 確認項目 | 結果 |
|---------|------|
| **例外由来 Tier B が正常 Tier B と応答上区別できないか** | **問題なし**。C-6 で status / body / ヘッダの完全一致を実測。ログ側だけ `axis: 'formSession-error'` で区別（`lib/public-guard.ts:241, 279`）。AC-RL-10 の制約（軸名・キーのハッシュ先頭8文字・判定結果のみ）を維持しており、生 Cookie も例外メッセージも出していない |
| **本体（handler）の例外が握り潰されていないか** | **問題なし**。try/catch は `formSessionKey` / `verifyFormSession` の呼び出しだけを包み、handler は `:301-305` の `try/finally`（`release` のみ）である。既存契約（`public-guard.test.ts:145`）は維持 |
| **try/catch の範囲が狭すぎないか** | **記録のみ**。`rateLimitKey(\`${endpoint}:fs:\`, raw)`（`:250`）は try の**外**にある。ただし `raw` は型上 `string` で、`rateLimitKey` は任意の文字列に対して throw しない（`trim`/`toLowerCase`/`createHash` のみ）。型違反（`as` で非文字列を返す）を作ったときだけ例外が外へ抜けることを実測したが、**型を守る限り到達不能**であり指摘に至らない |
| **`form-session.ts` のバイト長比較が逆方向の例外を作っていないか** | **問題なし**。B-1 の「バイト長一致・JS 長のみずれる」3 ケース、長さ ±1 / 0 / 1 / 10,000 / 100,000 / 200,000 文字、B-3 のファズ 20,000 件で例外 0。`timingSafeEqual` へ渡る前に必ずバイト長で弾かれている |
| **`timingSafeEqual` の定数時間性が失われていないか** | **問題なし**。長さ不一致で早期 return するのは**長さが秘密ではない**ため妥当（`lib/cron-auth.ts:39-43` と同じ判断）。署名本体の比較は従来どおり `timingSafeEqual` |
| **`sourceAxisFor` のキー空間がエンドポイント間で混ざらないか** | **問題なし**。M-6 で `applications:` 接頭辞を確認。`lib/public-guard.ts:71` |
| **`enforce:false` の軸で `consume` を止めていないか（観測手段の喪失）** | **問題なし**。M-3 で縮退時も `{count:3, saturated:true}` まで計数が進むことを実測（`lib/public-guard.ts:254-261` のコメントどおり）|
| **条件1'-1（共有軸の枯渇を拒否にしない）の維持** | **問題なし**。D-7 でセマフォ枯渇時に `202 {"retryAfterMs":…}` / `Retry-After` ヘッダ無しを実測 |
| **`admin-authz.spec.ts` の `withPrisma` 変更**（`tests/e2e/playwright/admin-authz.spec.ts:116-152`）| **セキュリティ上の含意なし**。ワーカーあたり 1 つの `PrismaClient` を共有し、ファイル直下の `afterAll` で切断する形。シグネチャと 17 箇所の呼び出し側は不変で、**アサーションの変更なし**（実コード確認）。E2E テスト専用コードであり本番バンドルに入らない |
| **`playwright.config.ts` の変更** | **セキュリティ上は改善**。非 CI が `pnpm build && pnpm start` になり、E2E が**本番 CSP**（`'unsafe-eval'` 無し）を必ず検証する。`reuseExistingServer: false` により起動中の `next dev` を掴む経路も塞がれた。CI 経路（`pnpm start` / `reuseExistingServer: false`）は実質不変で、実測基準値を動かさない |
| **スコープ外ファイルの変更有無** | **問題なし**。`lib/` の更新時刻を実測 — 本修正セッション（06:0x 以降）で変わったのは `lib/public-guard.ts`（06:14:44）と `lib/form-session.ts`（06:14:56）のみ。`lib/http-guard.ts`（07-28 23:44）/ `lib/rate-limit.ts`（07-29 03:18）/ `lib/semaphore.ts` / `lib/kv.ts` / `lib/env.ts` は**未変更**で、Impl の申告（実装記録 §7）と一致する |
| **`lib/` の型迂回** | **問題なし**。`as any` / `@ts-ignore` / `@ts-expect-error` の使用は `lib/` に無い（grep 実測）|
| **`app/api` の復旧** | **確認済み**。プローブ削除後に 6 ファイル（`admin/**` 5 / `auth/[...nextauth]` 1）へ復帰、`tsc --noEmit` エラー 0、列挙テスト 19/19 green |

**E2E の 103 vs 100 件差 / flaky の扱い（Impl 実装記録 §6）について**: セキュリティ上の含意は無い。
`failed` が 0 であること、および `csp.spec.ts` が本番ビルドに対して green であることのみが本監査の関心事で、
両方ともオーケストレーターと Impl の独立実測で満たされている。**「flaky が解消した」と主張しない Impl の姿勢は
今回も正確**であり、件数差の出所特定は Senior の判断に委ねる。

---

## E. P3-b 着手可否の最終判定

### 判定: **P3-b 着手可**

**理由**:

1. **`docs/phase-status.md` の P3-a 完了条件「Security Critical 0 / High 0」を満たした。**
   本監査の実測で **High 2 件（SEC-042 / SEC-043）はいずれも再現しなかった**。
   前回の受け入れ条件 B-1 / B-2 は下表のとおり充足している。
2. 新規指摘 **SEC-052 / SEC-053 は Medium** であり、**いずれも「呼び出し元が 0 件だから現状は悪用不可」ではなく、
   「P3-b が配線するときに満たすべき条件」として表現できる**。P3-a の成果物（ラッパ）自体は、
   正しく配線されれば安全である。前回 High とした 2 件が「ラッパ単体で既に壊れていた」のとは性質が違う。
3. ただし **SEC-052 / SEC-053 は P3-b の受け入れ条件（着手ではなく完了のブロッカー）とする。**
   特に **SEC-053 は、SEC-043 の是正によって新たに開いた経路**であり、
   `/api/applications` の配線で `limiters.formSession` + `formSessionKey` を渡し忘れた瞬間に本番へ出る。

### 前回の着手条件（§F B-1 / B-2）の充足判定

| # | 条件 | 判定 | 実測 |
|---|------|------|------|
| **B-1** | SEC-042 を修正し、`verifyFormSessionValue` がマルチバイト文字を含む署名でも例外を投げず `null`。併せてラッパが `verifyFormSession` / `formSessionKey` の例外を Tier B へ落とす | **充足** | 設計入力 32 件 + latin1 全域 128 件 + ファズ 20,000 件で**例外 0**。ラッパ経由の細工 Cookie 8 件・供給関数の throw 2 件が**すべて 403**（§A-2）|
| **B-2** | SEC-043 を修正し、`trusted === false` のとき per-source 軸を計数のみに使う。かつ別軸が未設定なら降格させる | **充足** | G-1 再実行で締め出しが再現せず（§A-1）。M-3 で計数継続、M-2 で Tier B 降格、M-4 で通常構成の退行なしを実測。**型でも強制されている**（TS2345 / TS2322 を実測）|

### P3-b で守るべき要件（前回 §F の更新）

| # | 要件 | 出所 | 変更 |
|---|------|------|------|
| **P3b-1** | `/api/applications` の配線で **`limiters.formSession` と `formSessionKey` を必ず渡す**。IP 軸だけで Tier D を構成しない | 条件1'-3 / SEC-043 / **SEC-053** | **「推奨」→「受け入れ条件」へ格上げ。** 渡し忘れると縮退構成で流量上限が消える（D-1 実測）|
| **P3b-1b** | **`formSessionKey` は要求元ごとに一意な値を返すこと**を型または構築時検査で強制する。`enforce: true` をリテラルで書ける状態を残さない。`public-guard-degraded-source.test.ts:144` の定数キーを直す | **SEC-052（新規）** | **新規** |
| **P3b-2** | `auth.ts` と公開エンドポイントの limiter に KV store を注入する。注入後、`.env.example` / `lib/env.ts` の文言と実態を一致させる | 条件2 SEC-033 / SEC-044 | 継続（**SEC-055 の推奨策も兼ねる**）|
| **P3b-3** | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限を 32 文字にする | SEC-046 | 継続 |
| **P3b-4** | `now` にリクエスト由来の値を渡さない。`newPermitId` に決定的な値を渡さない | SEC-048 / SEC-049 | 継続 |
| **P3b-5** | CSP の検証対象を `/apply` へ切り替える際、`csp.spec.ts` だけを根拠にしない | I-8 | 継続 |
| **P3b-6** | `app/layout.tsx` の `force-dynamic` に構造的な歯止めを入れる | I-9 | 継続 |
| **P3b-7** | ルート列挙テストに **再 export 形の検出 / `route.js` の走査 / エイリアス import の厳格化**を追加し、合成ソースの自己検証で固定する | **SEC-054（新規。SEC-047 は クローズ）** | **更新** |
| **P3b-8** | 公開エンドポイントにリクエストボディのサイズ上限を設ける | 前回新規 | 継続 |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` を変更したら、実 Redis に対して前回 §C のシナリオを再実測する | I-1 / I-2 | 継続 |
| **P3b-10** | `withCronAuth` に粗い試行回数制限を入れる（P3-c までに）| SEC-046 | 継続 |
| **P3b-11** | `formSessionKey` の段階で Cookie の**形式検証**（`<base64url>.<base64url>` / 最大長）を行い、形式不正の値に新しいバケットを作らせない | **SEC-055（新規）** | **新規** |

### SEC-044 / SEC-045 / SEC-046 の扱い（更新）

**いずれも P3-b 着手をブロックしない。P3-b の完了条件に含める**（前回判断を維持）。今回の追加事情:

| ID | 更新内容 |
|----|---------|
| **SEC-044**（Medium / KV 注入経路が 0 本）| **維持。** `lib/kv.ts` / `auth.ts` は本修正で未変更（更新時刻で実測）であり、状況は変わっていない。**SEC-055 の推奨修正策（本番の store を TTL ベースへ）と同一作業**になるため、P3b-2 として優先度を上げる |
| **SEC-045**（Medium / 全常駐が上限到達なら退避される）| **維持。** `lib/rate-limit.ts` は未変更。**SEC-055 により攻撃コストがさらに下がった**（未認証の第三者が任意個のバケットを作れる経路が `formSession` 軸に存在するため）。SEC-044 と同時に閉じるのが自然という前回の判断は変わらない |
| **SEC-046**（Medium / secret の強度要件・cron の試行回数制限）| **維持。** `lib/env.ts` / `lib/cron-auth.ts` とも未変更。**`FORM_SESSION_SECRET` の重要度は今回上がった**——SEC-043 の是正により、縮退時に残る唯一の Tier D 軸が Cookie 軸になったため、Cookie 署名鍵が弱いと**軸そのものが偽造で無効化される**（P3b-3 の優先度を SEC-044 と同等へ）|
| **SEC-048〜051** | **維持**（P3b-4 / P3b-5 / P3b-6 / 任意）。本修正は `lib/semaphore.ts` / `middleware.ts` / `lib/rate-limit.ts` に触れていない |

---

## F. 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **0**（前回 2 件 → **SEC-042 / SEC-043 とも本監査の実測でクローズ**）|
| Medium | **2 新規（SEC-052 / SEC-053）** ＋ 繰越 SEC-044 / SEC-045 / SEC-046 / SEC-031 / SEC-032（部分）/ SEC-033（部分）/ SEC-038 |
| Low | **2 新規（SEC-054 / SEC-055）** ＋ 繰越 SEC-048 / SEC-049 / SEC-050 / SEC-014〜017 / SEC-025〜027 / SEC-039 / SEC-041（部分）|
| Info | **1 新規（SEC-056）** ＋ 繰越 SEC-051 / SEC-036 / SEC-037（部分）/ SEC-018〜020 / SEC-040 |

**クローズ**: **SEC-042**（Cookie 署名比較のバイト長化 + ラッパの例外封じ込め）/
**SEC-043・RV-P3A-001**（縮退時の per-source 軸を計数のみに + 条件1'-3 の Tier B 降格 + **型の継ぎ目**）/
**SEC-047**（列挙テストの import 元検証）。**3 件とも監査者自身の実測でクローズした。**

### リリース判定: **ブロックしない**（Critical 0 / High 0）

前回は High 2 件でブロックしていた。**「P3-a の完了宣言」と「P3-b の着手」のブロックは解除する。**
なお `lib/public-guard.ts` / `lib/form-session.ts` / `lib/cron-auth.ts` の呼び出し元は依然 **0 件**であり、
本監査の Medium 2 件も現時点の本番には露出していない。

### P3-b 着手判定: **可**

### 是正の優先順位（P3-b の作業内）

1. **SEC-053**（Medium / `/api/applications` の配線で `formSession` 軸を必ず渡す。**渡し忘れが最も安い事故**）
2. **SEC-052**（Medium / `formSessionKey` の型設計。**5 度目の同型を構造で止める最後の機会**）
3. **SEC-044 + SEC-055**（Medium + Low / KV store の注入。2 件同時に閉じる）
4. **SEC-046**（Medium / secret 下限。SEC-043 是正により `FORM_SESSION_SECRET` の重要度が上がった）
5. **SEC-045**（Medium / SEC-044 と同時）
6. SEC-054（Low / 最初の公開ルートと同時）
7. SEC-048〜051 / SEC-056（Low / Info）

### 評価 — 何が直り、何がまだ同じ形をしているか

**直ったこと**:

- **SEC-043 は「振る舞いを直した」だけでなく、`.key` だけを渡す実装が実際にコンパイルできない状態になった。**
  監査者自身が再発経路を書いて `tsc --noEmit` が **TS2345 / TS2322** で落ちることを実測している。
  4 度繰り返した型を、**呼び出し側が読まなくても効く形**で止めた初めてのケースである。
- **SEC-042 は、契約書の分類表が脅威モデル上やや不正確（`あ` / `😀` / 孤立サロゲートは HTTP ヘッダを
  通過できない）だったにもかかわらず、実装は正しく直っていた。** 監査者が独立に設計した
  「実際にワイヤを通る入力」（latin1 デコード後の 0x80–0xFF 全域）でも例外 0 である。
  **たまたま正しかったのではなく、`Buffer` 長比較という修正が欠陥クラス全体を閉じている。**
- **SEC-047 は、前回 11/11 green で通過した細工が今回 1 failed で落ちた。** 検出力の強化が実測で確認できた。

**まだ同じ形をしていること**:

- **SEC-052 は SEC-043 と構造的に同一である。** 発信元軸には型の継ぎ目を入れたが、
  **`formSession` 軸は `enforce: true` をリテラルで直書きし、その正当化を隣接コメントに置いた。**
  `lib/http-guard.ts:86-94` の名指しの警告が SEC-043 を止められなかったのと、まったく同じ構造である。
  しかも**P3-b が実際に配線するのはこちらの軸**であり、テスト（`public-guard-degraded-source.test.ts:144`）は
  **定数キーで硬いゲートになる形を「正しい」として固定してしまっている**。
  **是正が施された軸ではなく、是正が施されなかった軸へ脅威が移った**——これがこのプロジェクトで
  5 度目の同型になるかどうかは、P3-b の配線で決まる。
- **SEC-053 は「是正が新しい穴を開けた」型である。** per-source ゲートを外す判断は正しいが、
  **代わりの軸が構成上オプションのまま**なので、渡し忘れが無防備な公開エンドポイントを生む。
  条件1'-3 の Tier B 降格は `verifyFormSession` の**有無**しか見ておらず、
  `limiters.formSession` / `formSessionKey` の有無は見ていない。**構築時に分かる情報を使っていない。**

**方法論についての記録**: 本監査は、契約書の入力分類表を**そのまま採用しなかった**ことで、
「`あ` / `😀` / 孤立サロゲートは HTTP ヘッダ値として到達できない」という脅威モデルの不正確さを検出した。
結論（SEC-042 クローズ）は変わらなかったが、**テストが通る理由と攻撃が防がれる理由が一致しているかは、
別に確かめる必要がある**。前回の SEC-042 が「正しい契約 + 脅威モデルとずれた入力」で生まれたのと、
これは表裏の関係にある。

---

# セキュリティ監査レポート

## 監査日: 2026-07-29
## 対象: P3-b（申込・問い合わせフォーム / F-008 · F-010 · F-023 `/privacy`）— **個人情報を実際に受信する最初の単位**
## 入力: `docs/impl-p3b-notes-2026-07-29.md` / `docs/review-p3b-tests-2026-07-29.md` / 本書「P3-a 再監査」§E（P3b-1〜11 / SEC-044〜046 / SEC-052〜056）/ `docs/phase-status.md`「P3-b の完了条件」

### 監査の方法（前回までと同じ原則を維持し、今回さらに強化した）

1. **「テストが green」を完了根拠にしない。** unit 682 / integration 63 が全 green であることは前提として受け取り、
   **監査者自身が実装モジュールへ攻撃シナリオを直接投入して実測**した（Impl の `scripts/verify-p3b.ts` とは
   独立に、監査者が自分で設計した 5 本のスクリプト A〜E）。
2. **実 Redis 7.4.10 を立て、`@upstash/redis` が話す Upstash REST プロトコルを実 Redis へ転送するシムを
   監査者が実装し、`VERCEL=1` の本番相当構成で `POST /api/applications` を通した。**
   これは Impl が「検証できていない」と申告した **I-5**（KV を実際に叩く経路）に対する直接の回答である。
   前回（P3-a）の「実 Redis で Lua を実行する」水準を維持したうえで、今回は**アプリの本番経路ごと**通した。
3. **Impl / Test の申告を裏取りする。** 「閉じた」「再現しない」という記述は、そのまま採用せず**同じ手順を
   監査者が再実行**した。加えて **Impl が主張していない手順（攻撃者にとって自明なコスト増）を 1 手だけ足して**
   同じ脅威に到達できないかを能動的に探索した——**これが今回の High 1 件の出所である。**
4. **E2E は指示どおり実行していない**（品質ゲートは独立実測済みとして受け取り、失敗 2 件は判定のみ行う）。

**監査環境**: Node v20.19.6 / Next 15.5.22 / Prisma 6.19.3 / Redis **7.4.10**（`docker run redis:7.4-alpine`、
`redis_version:7.4.10` を実測）/ dev Postgres 16（`driving_school_pg`）。

---

## A. P3b-1〜11 の充足判定表（**すべて監査者自身の実測に基づく**）

| # | 要件 | 判定 | 根拠（file:line + 監査者の実測） |
|---|------|------|--------------------------------|
| **P3b-1** | `/api/applications` で `limiters.formSession` + `formSessionKey` を必ず渡す | ⚠️ **文言は充足 / 目的は未達** | 配線は正しい（`app/api/applications/route.ts:341-347`）。**実 Redis + `VERCEL=1`** で発信元軸 5回/10分・Cookie 軸 3回/10分がいずれも enforce されることを実測（B-1: `201×5 → 429×3`、Cookie を毎回変えても迂回不可 / B-2: `201,201,201,429,429`）。**しかし縮退構成では、Cookie を取り直すだけで上限が消える**（A-2: 送信 60 回中 **201 が 60 件**）→ **SEC-057** |
| **P3b-1b** | `formSessionKey` は要求元ごとに一意。`enforce:true` をリテラルで書けない | ✅ **充足** | `PerRequesterKey`（`lib/form-session.ts:51`）。`as PerRequesterKey` のキャストは**正典の生成元 1 箇所のみ**（`lib/form-session.ts:279`。`lib/` / `app/` / `components/` 全体を grep して他に 0 件、`as any` / `@ts-ignore` も 0 件）。振る舞い実測: 攻撃者が Cookie 軸を使い切っても**別 Cookie の正規利用者は 201**（A-1: 攻撃者 `201,201,201,429×5` / 正規利用者 `201`）。SEC-052 の巻き添え 429 は再現しない |
| **P3b-2** | `auth.ts` と公開経路の limiter に KV store を注入。文言と実態の一致 | ⚠️ **部分充足**（注入は完了・**監査者が実 KV で検証しクローズ**。ただし SEC-055 は閉じない） | `lib/runtime-stores.ts:62-79` が単一の注入点。`auth.ts:73-84` の 4 limiter / `app/api/applications/route.ts:95-113` の 3 limiter + セマフォ / `app/api/form-session/route.ts:53-57` がすべてここを通る。**実 Redis 上で本番経路のキーが実際に作られることを実測**（B-1b: `applications:198.51.100.7 = 8 (pttl=24961)` / `applications:fs:<64hex>` / `sem:{applications}:0..3` / `mail:auto-reply:<32hex>`）→ **I-5 をクローズ**。一方 **SEC-055 は KV では閉じない**（B-5 / SEC-062） |
| **P3b-3** | `FORM_SESSION_SECRET` / `CRON_SECRET` の本番下限 32 文字 | ✅ **充足** | `lib/env.ts:138-166`。監査者の境界実測（D-4）で **8 通り全て期待どおり**: 31 文字=起動不可 / 32 文字=起動可 / `CRON_SECRET` 31 文字=起動不可 / `FORM_SESSION_SECRET === CRON_SECRET`=起動不可 / `CRON_SECRET === AUTH_SECRET`=起動不可 / `TURNSTILE_SECRET` 未設定=起動不可 / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` 未設定=起動不可 / `RESEND_API_KEY` 未設定=起動可 |
| **P3b-4** | `now` にリクエスト由来の値を渡さない / `newPermitId` を渡さない | ✅ **充足** | `app/api/applications/route.ts` の `now:` は 2 箇所のみで、いずれも**サーバー生成の `receivedAt`**（`:203` / `:326`）。`newPermitId` の受け渡しは `app/api/` 配下に 0 件（grep 実測）＝既定の 128bit CSPRNG（`lib/semaphore.ts:298-300`） |
| **P3b-5** | CSP の検証対象を `/apply` へ。`csp.spec.ts` だけを根拠にしない | ✅ **充足** | `lib/csp.ts:50-55`（`script-src` は `'self'` + nonce + Turnstile のみ。`'unsafe-inline'` は**含まれない**、`'unsafe-eval'` は `NODE_ENV !== 'production'` のときだけ）。`middleware.ts:70` の matcher は `/api` 等の除外のみで `/apply` `/privacy` を含む。E2E とは独立にユニット（`apply-page-contract.test.ts`）が固定している。**`style-src` の `'unsafe-inline'` は受容済み残余**（`lib/csp.ts:13-18` に明記されており、丸めた報告になっていない） |
| **P3b-6** | `app/layout.tsx` の `force-dynamic` に構造的な歯止め | ✅ **充足** | `app/layout.tsx:37` の export を実測、`app/` 配下に `force-static` は 0 件（grep）。ビルドの全 21 ルート `ƒ` は品質ゲートの独立実測を採用 |
| **P3b-7** | 列挙テストの強化（再 export / `route.js` / エイリアス import） | ✅ **充足** | 監査者が `listRouteFiles('app/api')` を直接実行（D-5）: **7 件**を列挙し、**`applications/route.ts` と `form-session/route.ts` の両方が対象に入っている**ことを確認。P3-b で初めて実対象が網に入った |
| **P3b-8** | 公開エンドポイントにボディサイズ上限 | ⚠️ **部分充足** | 413 は正しく返る（A-7a: `content-length` 申告超過 → 413・`challenge` 無し / A-7b: chunked でも実バイト数で 413）。**しかし上限判定は「全量を読み切ってから」行われる**——128MB の chunked ボディを投げると**サーバーが 128MB 全部を受信・バッファしてから** 413 を返すことを実測（B-7）→ **SEC-059** |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` を変更したら実 Redis で再実測 | ✅ **対象外だが監査者が実 Redis で再実測しクローズ** | Lua は未変更（sha1[0:12]=`68b509738078`）。**実 Redis 7.4.10 上で**: `perShardLimit=2` に対し `acquire` が `ok,ok,null`（B-4）/ `release` 後に 1 枠だけ戻り二重 `release` では戻らない（C-1c〜C-1f: ZSET が `permit-B` → `permit-B,permit-D`）/ TTL 経過分が `ZREMRANGEBYSCORE` で回収される（B-4c）。**B-4b の初回 FAIL は監査者のスクリプト側の誤り**（解放済み permit を再利用していた）で、C-1 の切り分けにより**実装の欠陥ではないと確定した** |
| **P3b-10** | `withCronAuth` に粗い試行回数制限（期限 P3-c） | ⏸ **未実装（期限内）** | `lib/cron-auth.ts` に `limit` / `rate` / `attempt` のいずれも無いことを grep で確認。**P3-c の完了条件として継続**（SEC-046） |
| **P3b-11** | `formSessionKey` の段階で Cookie の形式検証 | ✅ **充足（残余は明示どおり）** | `lib/form-session.ts:262-280`。監査者の実測（D-2）: **形式不正 700 種（7 形 × 100: 署名部長さ違い / セパレータ欠落 / 44 文字 / 空セグメント / base64url 外の文字 / 最大長超過 / 非 ASCII）で store 件数 0 → 1**（増分は発信元軸のみ）。**残余は Impl の申告どおり実在する**（D-3: 形式を満たす 700 種 → **701 件**）。ただし**残余の「閉じ方」の説明は誤り** → SEC-062 |

---

## B. 脅威シナリオの実測（**最重要**）

### B-1. **4 度移動した脅威は、5 度目として `/api/applications` に到達した**

P3-a 再監査は「SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度、共有軸の枯渇を照合前の硬いゲートに
してしまう欠陥が移動した」と記録し、「**5 度目の同型になるかどうかは P3-b の配線で決まる**」と書いた。

**配線そのものは正しい。** SEC-052 / SEC-053 が心配した形（定数キー・渡し忘れ）は再現しない（A-1 / B-1 / B-2）。
**しかし脅威は「軸の作り方」ではなく「軸の入手コスト」へ移った。**

| 監査者の実測（A-2 / 縮退構成 `trusted=false`） | 結果 |
|---|---|
| `GET /api/form-session`（本番経路の Route Handler）を 20 回叩いて Cookie を取得 | **429 は 0 回。20 枚すべて発行された** |
| 取得した 20 枚の Cookie で `POST /api/applications` を各 3 回、計 60 回送信 | **201 が 60 件（429 は 0 件）** |

これは **P3-a 監査の D-1（「縮退構成で 500 回送信 → 201 × 500」）が、Cookie を取り直すという
1 手を足すだけでそのまま再現する**ことを意味する。Impl は §5 V-1 で「D-1 が再現しない」と報告しているが、
**V-1 は攻撃者が同一 Cookie を使い続ける前提**であり、`lib/form-session-issue.ts:8-11` 自身が
「**攻撃者は同一 Cookie を送らない**」と明記している。V-4b（縮退時は発行を止めない = 40/40）と
V-1 を並べれば結論は導けたが、両者は突き合わされていない。→ **SEC-057（High）**

**通常構成（Vercel / `trusted=true`）では成立しない**ことも実測した（B-1: Cookie を毎回変えても
発信元軸が 6 回目で 429）。したがって成立条件は**縮退構成のみ**である——が、その縮退構成こそ
SEC-043 の是正が想定した舞台であり、かつ **Vercel 以外へ配置する経路が塞がれていない**（SEC-061）。

### B-2. 縮退構成で正規利用者が巻き添えにならないか（SEC-043 の再発防止）

**再発していない。** 監査者の独立実測（A-1）:

```
縮退構成（trusted=false）
攻撃者（Cookie sid=111…）8 回 → 201,201,201,429,429,429,429,429
正規利用者（Cookie sid=222…）1 回 → 201        ← 巻き添えになっていない
```

さらに `withPublicMutation` に対する直接投入（C-3a / 通常構成 / source 5・fs 3）でも
**200 回送信 → 201 が 5 件・429 が 195 件**であり、共有バケットが硬いゲートになる形は消えている。

### B-3. ハニーポット・送信間隔・Turnstile（DB 0 件・メール 0 通）

| シナリオ | 実測 |
|---|---|
| ハニーポット非空 | **403 / DB 0 件 / メール 0 通**（A-3a） |
| 送信間隔 3 秒未満 | **403 / DB 0 件 / メール 0 通**（A-3b） |
| Turnstile `success:false` | **403 / DB 0 件**（E-1） |
| Turnstile ネットワーク例外 | **403 / DB 0 件**（E-1。500 にならない） |
| Turnstile HTTP 500 | **403 / DB 0 件**（E-1） |
| Cookie 無し / 署名不正 / 期限切れ | **403**（E-4） |

**5 種の降格理由が応答から一切区別できない**ことを実測（E-4: status / 本文 / `Retry-After` の
3 点すべてが `403 | {"challenge":"interactive"} | ra=null` で完全一致）。契約ルール3 は満たされている。
トークンが実際に Cloudflare へ渡っていることも確認（E-1b: `response=tok-70c3d6` 等）。

### B-4. Cookie shadowing（同名 Cookie 2 個）

**検証と計数が同じ値を見ている。** `readFormSessionCookie` の「最初を採る」規則により、
`__Host-fs=<正しい>; __Host-fs=<不正>` → 201、順序を入れ替えると → 403 で、軸キーも別々になる（E-2）。
検証は通るが計数は別バケット、という割り方はできない。

### B-5. 冪等性（AC-010-4）— 別 Cookie への `receiptNumber` 漏えい

| シナリオ | 実測 |
|---|---|
| 同一 Cookie の再送 | `{"id":…,"receiptNumber":"01KYNNE8V1…","idempotent":true}`（A-4a） |
| **別 Cookie が同一 `idempotencyKey` を提示** | **`200 {"idempotent":true}` のみ。`id` / `receiptNumber` とも返らない**（A-4b） |
| `sessionIdHash` が **null** の既存行（移行期間） | **`{"idempotent":true}` のみ**（E-3。監査者が実際に null 行を DB へ挿入して実測） |

**漏えいしない。** なお「既存キーは 200 / 新規キーは 201」という差は残るため、
`idempotencyKey`（クライアント生成 UUID v4）の**存在有無は列挙できる**が、
122bit の推測が必要で実害はない（Info として記録）。

### B-6. PII（ログ・エラー応答・自動返信メール・例外経路）

**7 経路**（201 / 400 / 422 / ハニーポット / Cookie 無し / 壊れた JSON / **DB 例外**）で
`console.*` を全捕捉し、氏名・メール・電話・住所・生年月日・`sid` の 6 種を突き合わせた（A-5）。

- **ログへの流出: 0 件。** 捕捉した 8 行はすべて
  `application.rejected {"status":422,"fields":["address"]}` / `public-guard.denied {"tier":"D","axis":"formSession","keyHash":"b62414d2"}` の形で、
  **フィールド名とハッシュ先頭 8 文字しか出ていない。**
- **エラー応答への反射: 0 件。** 返るのは `{"errors":[{"field":"phone","code":"INVALID_FORMAT"}]}` のみ。
- **自動返信メール本文: 0 件**（68 通を検査。電話・住所・生年月日を含まない / A-6b）。
- **ただし `prisma:error` が PII セーフロガーを迂回して stderr へ直接出力していた** → **SEC-064（Low）**。

### B-7. 自動返信の悪用（AC-RL-14）

第三者のアドレス宛に 6 回受付させたところ、**受付 6 件に対しメールは 3 通**（A-6）。
`peek` → 成功時のみ `consume`（`lib/mail/auto-reply.ts:156-172`）も設計どおりで、
送信失敗が枠を食わない。**宛先単位の爆撃は塞がれている。**

**ただし SEC-057 と組み合わせると、宛先を変えれば送信回数は上限を持たない**——A の実行中に
Resend への呼び出しは **68 回**発生した。AC-RL-14 が守ろうとした資産（送信ドメインの評判）は
「同一宛先への連打」からは守られているが、「縮退構成での総量」からは守られていない。

### B-8. `receiptNumber` の推測可能性（SPEC-013）

同一ミリ秒に 200 個発番して実測（A-9）: **200 個すべて一意、辞書順に並んでいない**（monotonic モードを
実装していないことの実証）。**連続発番から受付件数は漏れない。**
タイムスタンプ部 10 文字からミリ秒精度の受付時刻は復元できるが、受付番号の所持者は受付時刻を既に知っており実害はない（Info）。

### B-9. 脅威が別の軸へ移動していないかの能動的探索（指摘に至ったもの / 至らなかったもの）

| 探索した経路 | 結果 |
|---|---|
| **Cookie の取り直しで Tier D を空にできるか** | **成立（縮退のみ）→ SEC-057** |
| **`limiters.formSession` だけを渡す構成を作れるか** | **構築時 throw が効かず、Tier D 0 のまま構築できる → SEC-058** |
| **上限超のボディでメモリを消費させられるか** | **128MB を読み切らせられる → SEC-059** |
| **未認証で確定的に 500 を起こせるか** | **実在しない `courseId` で成立 → SEC-060** |
| セマフォの `release` が実 Redis で漏れないか | **漏れない**（C-1。枠は 1 つだけ戻り、二重 release は無効） |
| メモリ版セマフォと KV 版の意味論がずれていないか | **ずれていない**（C-2 / C-2b。3 本目 null・release 後 ok・二重 release 後 null が一致。`now == score` ちょうどの回収も両者「回収する」で一致）→ **I-6 をクローズ** |
| `formSessionAxisKey` と `verifyFormSession` が別の Cookie を見ないか | **同じ値を見る**（E-2） |
| 例外由来 Tier B と正常 Tier B が応答上区別できるか | **区別できない**（E-4） |
| ハニーポットが Turnstile より前か（外部 API の踏み台化） | **前**（`route.ts:266` < `:283`）。bot の充填で Cloudflare を叩かせられない |
| `parseApplicationInput` に zod を使っていないこと（値の反射） | **手書き。結果型が値を持てない**（`lib/validators/application.ts:80-82`）。実測でも反射 0（A-5b） |
| `courseId` から DB を引いて料金を再取得しているか（AC-010-2） | **クライアント値を読んでいない**（`route.ts:156-167`） |
| `privacyConsent !== true` の厳密判定 | **`=== true` 以外は 422**（`lib/validators/application.ts:317`） |
| メールヘッダインジェクション（`email` の CRLF） | **`EMAIL` 正規表現が `\s` を除外**（`:112`）＋ `stripControl`（`auto-reply.ts:63-65`）の二重。件名に氏名を入れない設計も維持 |
| `/api/form-session` のオープンリダイレクト | **無い**。遷移先は `/apply` 固定、引き継ぐのは `type` / `courseId` の 2 つだけで長さ 64 制限（`route.ts:62-69`） |
| 下書き（`sessionStorage`）に写真関連値が入らないか | **キー名・値の両方で再帰的に落としている**（`lib/apply-draft.ts:100-107` / `:58-61`）。P3-c の網は先に張られている |
| `dangerouslySetInnerHTML` の新規追加 | **公開側に 0 件**（管理側の `MarkdownEditor.tsx` のみ。既存・`renderMarkdown` 経由） |

---

## C. 新規指摘（SEC-057 以降）

### [SEC-057] 縮退構成では、Cookie を取り直すだけで `/api/applications` の流量上限が完全に消える（**P3-a 監査 D-1 の再現**）

- **重大度**: **High**
- **カテゴリ**: レート制限のバイパス / リソース枯渇 / スパム中継（CWE-770 / CWE-799）
- **場所**: `lib/form-session-issue.ts:79-82`（縮退時は `issued: true` を返し続ける）/
  `lib/public-guard.ts:319-350`（縮退時の発信元軸は `enforce:false`）/
  `app/api/applications/route.ts:341-347`（enforce される Tier D 軸が Cookie 軸だけになる）
- **説明**: SEC-043 の是正により、縮退構成（`resolveClientIp().trusted === false`）で
  **enforce される Tier D 軸は Cookie 軸ただ 1 つ**になった。P3b-1b は「Cookie 軸は要求元ごとに一意である」
  ことを型（`PerRequesterKey`）で保証したが、**軸として機能するために必要なのは「一意であること」ではなく
  「入手にコストがあること」である。** 縮退構成では Cookie の発行に上限が無い
  （`lib/form-session-issue.ts:80` — `!result.success && clientIp.trusted` なので `trusted=false` では
  発行を止めない）ため、攻撃者は**タダで軸を作り直せる**。
- **監査者の実測（A-2 / 本番経路の Route Handler をそのまま呼ぶ）**:
  ```
  縮退構成（VERCEL 未設定 = trusted:false）
  GET  /api/form-session  × 20      → 429 は 0 回。Cookie を 20 枚取得
  POST /api/applications  × 60      → **201 が 60 件 / 429 が 0 件**
                                       （DB 行 60 / 自動返信メール 60 通ぶんの経路が成立）
  ```
  同じ形は `withPublicMutation` への直接投入でも再現する（C-3b: 縮退で 200 回送信 → **201 が 200 件**、
  KV 上に `chat:fs:*` が 200 キー）。**通常構成（`VERCEL=1`）では再現しない**（B-1 / C-3a: 5 件で 429）。
- **影響**: 未認証の第三者が、縮退構成の本番デプロイに対して
  (a) **無制限に DB 行を作れる**（氏名・生年月日・住所・連絡先の欄に任意の値が入る）、
  (b) **無制限に当校ドメインから第三者へメールを送れる**（宛先を変えれば AC-RL-14 の 3 通/時は効かない。
      A の実行中に Resend 呼び出しが 68 回発生した）、
  (c) F-017 の受信管理が実質使用不能になる。
  **P3-b は「個人情報を実際に受信する最初の単位」であり、ここでの無制限受付は保管義務のある
  データの無制限流入を意味する。**
- **成立条件（過大報告しないための明示）**: **Vercel 上（`VERCEL=1`）では成立しない。**
  成立するのは `resolveClientIp` が `trusted:false` を返す環境＝ローカル / E2E / **Vercel 以外への本番配置**である。
  後者が現実的に起こりうることは SEC-061 が示す。
- **Impl の報告との関係**: 実装記録 §5 の V-1 は「監査 D-1 が再現しない」と結論しているが、
  **V-1 は攻撃者が同一 Cookie を使い続ける前提**で測っている。`lib/form-session-issue.ts:8-11` は
  「**攻撃者は同一 Cookie を送らない**」と自ら明記しており、V-4b は「縮退時は発行を止めない（40/40）」を
  実測している。**2 つの実測を突き合わせれば結論は出ていた。** 個々の測定は正確だが、
  **攻撃者の手順として結合されていない**（P2.5 の教訓「red が全部 green になっても脅威が閉じていない」と同型）。
- **修正方針**（いずれか。**(a) を推奨**）:
  - **(a) 縮退時こそ Cookie の入手にコストを課す。** `issueFormSession` は縮退時も発行を止めるべきではない
    （止めると第三者が `/apply` を封鎖できる — この判断は正しい）。代わりに、**発行された Cookie に
    「未検証」フラグを持たせ、共有 `unknown` バケットの計数が上限を超えている間に発行された Cookie は
    Tier B（403 + challenge）から始める**。CAPTCHA を解けば通れるので正規利用者は締め出されず、
    bot にとっては 1 送信ごとに CAPTCHA のコストが乗る。
  - (b) 縮退構成では Turnstile の検証を**送信時だけでなく Cookie 発行時にも**要求する。
  - (c) 縮退構成を**本番で成立させない**（SEC-061 を閉じる）。これは (a)(b) の代替ではなく前提条件である。
  - **いずれの案でも、「縮退構成で Cookie を N 枚取り直して送信する」シナリオをテストとして固定すること。**
    Cookie 1 枚での 429 を測るテストはこの脅威を検出しない。
- **参考**: 本書 SEC-021 / SEC-029 / SEC-030 / SEC-043 / SEC-052 / SEC-053（同型の 5 度目）/ CWE-770

---

### [SEC-058] `withPublicMutation` の構築時検査は `limiters.source` がある構成しか見ないため、「Tier D が 1 つも無い公開エンドポイント」を無言で構築できる

- **重大度**: **Medium**（現状の 2 ルートは正しく配線されている。**P3-c で新しい公開エンドポイントを足した瞬間に顕在化する**）
- **カテゴリ**: 設計（検査の網羅性）/ レート制限のバイパス（CWE-770）
- **場所**: `lib/public-guard.ts:263-276`（`if (limiters?.source) { … }` が検査全体を覆っている）/
  `lib/public-guard.ts:324`（`if (limiters?.formSession && formSessionKey)` — 片側だけなら軸を作らない）
- **説明**: P3b-1 の構築時 throw は「`limiters.source` を渡したのに別軸が無い」場合にのみ発火する。
  そのため次の 2 構成は**素通りする**:
  1. `limiters: { formSession }` のみ（`formSessionKey` なし）
  2. `formSessionKey` のみ（`limiters` なし）
  どちらも `lib/public-guard.ts:324` の条件が偽になるため **Tier D の軸が 1 つも作られない。**
  実装コメント（`:272-273`）自身が「片側だけだと軸が静かに無効化される」と書いているのに、
  **検査はその場合を見ていない。**
- **監査者の実測（D-1 / D-1b）**:
  ```
  構築時検査:  source のみ=throw / source+formSession(key 無し)=throw
              **formSession のみ(key 無し)=通る** / **formSessionKey のみ(limiter 無し)=通る**

  「formSession のみ」で構築した公開エンドポイント（縮退構成 / verifyFormSession あり）へ 50 回送信
    → **201 が 50 件 / store 件数 0**（レート制限のキーが 1 つも作られていない）
  ```
- **影響**: P3-c（免許証アップロード）/ P3-d（チャット）は `SemaphoreEndpoint` に `'uploads'` / `'chat'` が
  既に予約されており、**次に公開エンドポイントを書く人がこの構成を選ぶ余地がある。**
  SEC-053 が「渡し忘れが最も安い事故」と指摘したのと同じ事故が、別の入口に残っている。
- **修正方針**: 検査を `limiters?.source` の内側から外へ出し、**「`limiters` か `formSessionKey` の
  いずれかが渡された時点で、`limiters.formSession` と `formSessionKey` は必ず対で存在する」**を
  無条件に検査する。ラッパを Origin / Content-Type 検証だけに使う経路（`limiters` も `formSessionKey` も
  渡さない構成）は現状どおり許可してよい。**合成構成に対する構築時 throw のテストを 4 通りすべてで固定すること。**
- **参考**: SEC-053 / CWE-1188

---

### [SEC-059] ボディサイズ上限の実バイト数判定が「全量を読み切ってから」行われるため、未認証の第三者に任意サイズのバッファを確保させられる

- **重大度**: **Medium**
- **カテゴリ**: リソース枯渇（CWE-770 / CWE-400）
- **場所**: `lib/public-guard.ts:429-440`（`enforceBodyBytes`）
  ```ts
  const buffer = await request.arrayBuffer()      // ← 上限に関係なく全部読む
  if (buffer.byteLength > maxBodyBytes) return null
  ```
- **説明**: 同ファイル `:412-427` のコメントは「`content-length` は攻撃者の申告値であり
  `chunked` では存在しない」ので実測が要る、と正しく述べている。**しかし実測の方法が
  「全部読んでから長さを見る」**であるため、上限（64KB）は**応答**を制御するだけで
  **メモリ消費**を制御していない。`:361-364` の「レート制限済みの相手にメモリを使わせない」という
  設計意図と、実装が一致していない。
- **監査者の実測（B-7 / `VERCEL=1` の本番相当構成 + 実 KV + 有効な Cookie）**:
  ```
  128MB の chunked ボディ（content-length 無し）を POST /api/applications へ
    → 応答は 413（正しい）
    → **サーバーはボディ 128MB を全量受信・バッファしてから** 413 を返した（177ms）
  ```
  上限 64KB に対し **2,048 倍**を読み込んでいる。
- **影響**: Tier D を通過できるリクエスト（通常構成で発信元あたり 5 回/10 分、**縮退構成では
  SEC-057 により無制限**）ごとに、任意サイズのメモリを確保させられる。
  **Vercel 上では Function のリクエストボディがプラットフォーム側で 4.5MB に制限される**ため
  実害は 4.5MB × 同時実行数に留まる（過大報告しないために明記する）。
  一方 **Vercel 以外への配置（SEC-061）ではプラットフォーム側の上限も無い。**
- **修正方針**: `request.body`（`ReadableStream`）を**自前で読み進め、累積が `maxBodyBytes` を
  超えた時点で `reader.cancel()` して打ち切る**。読み取ったチャンクを結合して `Request` を作り直す
  現在の方式はそのまま維持できる（上限以下なので有界）。
  **テストは「応答が 413 であること」ではなく「読み取ったバイト数が上限 + 1 チャンク以下であること」を
  固定すること**——現在の `public-guard-p3b-wiring.test.ts` は前者しか見ておらず、この欠陥を検出しない。
- **参考**: CWE-400 / OWASP API4:2023

---

### [SEC-060] 実在しない `courseId` を送るだけで、未認証の第三者が確定的に 500 を起こせる

- **重大度**: **Medium**
- **カテゴリ**: 入力バリデーションの欠落 / 可用性（CWE-20 / CWE-703）
- **場所**: `app/api/applications/route.ts:156-167`（`courseSnapshot` は見つからなければ `null` を返すだけ）/
  `:207`（`courseId: isApplication ? data.courseId : null` — **存在確認せずに外部キーへ渡す**）/
  `lib/validators/application.ts:351`（`courseId` は**長さ 64 の検査だけ**）
- **説明**: `courseSnapshot()` は `prisma.course.findUnique` を実行しており、**コースが存在しないことを
  既に知っている**。にもかかわらず `courseId` をそのまま `create` に渡すため、Postgres の
  外部キー制約違反（Prisma `P2003`）になる。`P2002` は冪等再送として処理されているが `P2003` は
  そのまま `catch` の最後へ落ち、`500 {"error":"internal error"}` が返る。
- **監査者の実測（B-6 / `VERCEL=1` + 実 KV の本番相当構成）**:
  ```
  type=APPLICATION, courseId="no-such-course-<uuid>" ほかは全て妥当な値
    → **status=500** {"error":"internal error"} / DB 行 0 件
    → stderr: Foreign key constraint violated on the constraint: `Application_courseId_fkey`
              application.create_failed { errorCode: 'P2003' }
  ```
- **影響**: (a) 未認証の第三者が任意に 500 を起こせる——`lib/form-session.ts:157` /
  `app/api/applications/route.ts:259-260` / `lib/turnstile.ts:8-9` が繰り返し禁じている性質そのものである
  （SEC-042 と同じクラス）。(b) 正規利用者から見ると「コースが削除された直後の申込」が
  **原因不明のサーバーエラー**になり、入力内容を失う（`courseId` は `/apply?courseId=` から来る）。
  (c) エラーログの増幅とセマフォ枠の消費。
- **修正方針**: `courseSnapshot` が `null` を返した場合、`type === 'APPLICATION'` なら
  **`422 { field: 'courseId', code: 'OUT_OF_RANGE' }`（または `INVALID_FORMAT`）**を返す。
  併せて `P2003` を `P2002` と同じく明示的に分類し、未分類の例外だけが 500 になるようにすること。
  **テストは「実在しない `courseId` で 500 にならない」を本番経路（結合）で固定すること。**
- **参考**: SEC-042 / CWE-20

---

### [SEC-061] Vercel 以外の本番へ配置すると「縮退構成 + インメモリ KV」の二重縮退で起動でき、しかも縮退を解除する設定手段が存在しない

- **重大度**: **Medium**（SEC-057 / SEC-059 の成立条件を作る）
- **カテゴリ**: 設定 / 設計（fail-safe の抜け道）
- **場所**: `lib/http-guard.ts:108`（`options.trustProxy ?? process.env.VERCEL === '1'`）/
  `lib/env.ts:179`（KV の https 強制が `process.env.VERCEL === '1'` 条件）/
  `app/api/applications/route.ts:351` と `app/api/form-session/route.ts:73`（いずれも `resolveClientIp(req)` を
  **オプション無し**で呼ぶ）
- **説明**: `lib/http-guard.ts:97-99` は「**Vercel 以外へ配置する場合は前段プロキシが XFF を上書きすることを
  確認したうえで `trustProxy` を必ず有効化すること**」と運用者に指示している。
  **しかしその指示に従う手段が無い**——`trustProxy` は関数の第 2 引数にしか存在せず、
  本番の呼び出し側 2 箇所はどちらも渡していない。環境変数も無い（`grep -rn trustProxy` で
  `lib/` / `app/` / `auth.ts` を確認）。`docs/tech-stack.md:229-230` も「判定を**更新し**」と書いており、
  実質的にソース変更を要求している。
- **監査者の実測（D-4b）**:
  ```
  NODE_ENV=production / VERCEL 未設定 / KV_REST_API_URL="memory://local-dev-only"
    → **起動時 fail-fast を通過してしまう**
       （= レート制限がインスタンスローカルのインメモリへ縮退し、
          同時に resolveClientIp も trusted:false へ縮退する）
  ```
  この状態は **SEC-057 が成立する構成そのもの**である。
- **影響**: 「Vercel 前提」という設計判断が**コードの既定値としてしか表現されていない**ため、
  デモの自前ホスティング・Docker 配置・別 PaaS への移行のいずれでも、
  **警告も起動時エラーも無しに公開フォームの流量制御が消える。**
- **修正方針**:
  1. `TRUST_PROXY`（または `RUNTIME_PLATFORM`）を**明示的な環境変数**として導入し、
     `resolveClientIp` の既定を `process.env.TRUST_PROXY === '1' || process.env.VERCEL === '1'` にする。
  2. `lib/env.ts` の本番検証を **`VERCEL === '1'` ではなく「本番であること」**を基準に組み替える:
     `NODE_ENV=production` かつ `TRUST_PROXY` も `VERCEL` も未設定なら**起動を止める**か、
     少なくとも `KV_REST_API_URL` の https 強制は `NODE_ENV=production` 全体へ広げる。
     現状「`next start` = `NODE_ENV=production` を E2E が使う」ことが判定を歪めているので、
     **E2E 用の逃げ道は `VERCEL` ではなく専用の `ALLOW_MEMORY_KV=1` 等で明示すること**
     （逃げ道を本番判定の裏側に隠さない）。
  3. `lib/http-guard.ts:97-99` の文言を、実際に取れる操作（環境変数名）に更新する。
- **参考**: SEC-030 / SEC-033 / SEC-044 / CWE-1188

---

### [SEC-062] SEC-055 の残余は KV 注入では閉じない——実装記録・テスト設計の「閉じ切るのは P3b-2」は事実に反する

- **重大度**: **Low**（通常構成では発信元軸が上限を与えるため実害は小さい）
- **カテゴリ**: リソース枯渇 / **文書と実態の不一致**
- **場所**: `lib/form-session.ts:246-251`（「閉じ切るのは P3b-2（KV store = TTL ベース）」）/
  `docs/impl-p3b-notes-2026-07-29.md` §7.5 P3b-11・§8「過大報告を避けるための明示」/
  `docs/review-p3b-tests-2026-07-29.md` §3「覆っていない脅威（残余）」
- **説明**: 3 つの文書がいずれも「形式を満たす値からバケットが作れる残余は **P3b-2（KV）が閉じる**」と
  書いている。**KV は退避（eviction）の概念を持たないだけで、キーが作られること自体は止めない。**
  インメモリ store の「件数上限による退避」問題が、KV では「**キー空間が TTL の間だけ線形に増える**」
  問題に**置き換わる**（コストの所在が RSS から Upstash の課金・ストレージへ移る）。
- **監査者の実測**:
  ```
  B-5（実 Redis / 形式を満たす Cookie 500 種）→ DBSIZE 21 → 522 / chat:fs:* = **500 件**（PTTL は最大 600s）
  D-3（インメモリ / 形式を満たす Cookie 700 種）→ store 件数 **701**
  ```
- **影響の正確な範囲**（過大報告を避けるための明示）: **通常構成では発信元軸が先に 429 を返すため、
  1 IP あたり作れるバケットは窓あたり 5 個に留まる**（C-3a: 200 回送信 → `chat:fs:*` は **5 件**）。
  **縮退構成では上限が無い**（C-3b: 200 回送信 → **200 件**）。つまり SEC-062 の実害は
  **SEC-057 の従属変数**であり、SEC-057 を閉じれば実質的に消える。
- **修正方針**: (a) **文書の訂正が本体である**——`lib/form-session.ts:246-251` と実装記録 §7.5 / §8 の
  「閉じ切るのは P3b-2」を「**閉じ切らない。上限を与えるのは発信元軸であり、縮退構成では上限が無い**」へ改める。
  (b) 恒久策は SEC-057 の修正（Cookie の入手にコストを課す）と同一である。
- **参考**: SEC-023 / SEC-055 / CWE-770

---

### [SEC-063] KV 版レート制限 store は上限到達後もカウンタを進め続ける（インメモリ版との意味論の差 + 書き込み増幅）

- **重大度**: **Low**
- **カテゴリ**: リソース消費 / 実装間の意味論差
- **場所**: `lib/kv.ts:102-116`（`increment` は無条件に `INCR`）/
  `lib/rate-limit.ts:382-385`（インメモリ経路は「上限到達済み。カウントをこれ以上進めない
  （**攻撃時の書き込み増幅を避ける**）」として `set` を行わない）
- **監査者の実測（C-4 / C-4b）**:
  ```
  limit=3 / 同一キーへ 50 回 consume
    KV      → 実カウンタ = **50**（拒否した 47 回も INCR している）
    memory  → {"count":3,"resetAt":…,"saturated":true}
  ```
- **説明・影響**: 拒否されるリクエスト 1 件ごとに Upstash への書き込みが 1 回発生する
  （Upstash はコマンド課金）。**上限到達後こそ攻撃トラフィックが集中する**ため、
  「レート制限が攻撃コストを下げる」形になっている。窓の延長は起きない（`PEXPIRE` は `count===1` か
  TTL 消失時のみ / `lib/kv.ts:106-114`）ので、**流量制御そのものは正しく動く**。
- **修正方針**: `INCR` の戻り値が `limit` を超えている場合に何もしない、あるいは `EVAL` 1 本で
  「上限未満のときだけ `INCR`」にする（セマフォと同じ手法）。判定は `lib/rate-limit.ts` に残すという
  AC-RL-8 の原則を崩さないよう、**上限値を `increment` の引数として渡す**形にするのが素直である。
- **参考**: SEC-033 / AC-RL-8

---

### [SEC-064] Prisma 自身のエラーログが PII セーフロガーを迂回して stderr へ直接出力される

- **重大度**: **Low**（現時点で到達可能な経路では値が出ていないことを実測）
- **カテゴリ**: ログへの機密情報出力（CWE-532）
- **場所**: `lib/db.ts:13-15`（`new PrismaClient({ log: [...'error'] })`）
- **説明**: `lib/pii-log.ts` は「**ログ出力点は今後も増え続けるため、通る場所を 1 つにして落とす以外に
  手段がない**」という正しい設計判断で作られている。しかし **Prisma のクライアントログはその 1 点を通らない。**
- **監査者の実測（A-5 の DB 例外経路）**: `console.*` を全捕捉したところ、アプリのログ（`application.create_failed
  {"errorCode":"P2003"}`）とは別に、**Prisma が直接出力した以下が混入していた**:
  ```
  prisma:error
  Invalid `prisma.application.create()` invocation in
  /Users/yosuke/dev/driving_school/app/api/applications/route.ts:201:44
    → 201 const created = await prisma.application.create(
  Foreign key constraint violated on the constraint: `Application_courseId_fkey`
  ```
  **今回出たのはソース行と制約名だけで、入力値は含まれていない**（`Application` モデルに長さ制約が無く
  `P2000` が到達不能、`P2002` はフィールド名のみ、という schema の実測に基づく）。
- **影響**: 現時点では PII は出ていない。ただし AC-PII-1 の担保が「**通る場所を 1 つにする**」という
  構造ではなく「**Prisma のエラー文言がたまたま値を含まない**」という偶然に依存している。
  P3-c で `LicensePhoto`（`objectKey`）を扱うとエラー文言に含まれうる値が増える。
- **修正方針**: `PrismaClient` を `log: [{ emit: 'event', level: 'error' }]` にし、
  `prisma.$on('error', e => logger.error('prisma', toErrorLogFields(e)))` で
  **`lib/pii-log.ts` の 1 点へ合流させる**。
- **参考**: AC-PII-1 / AC-010-7 / CWE-532

---

### [SEC-065] レート制限キーに発信元 IP が平文で載るが、`/privacy`（F-023）に開示が無い

- **重大度**: **Low**
- **カテゴリ**: データ保護 / 開示（APPI 第21条の趣旨）
- **場所**: `lib/public-guard.ts:87`（`rateLimitKey` に `resolution.key` をそのまま渡す）/
  `lib/form-session-issue.ts:76` / `app/(public)/privacy/page.tsx`・`lib/retention.ts`
- **監査者の実測（B-3b / 実 Redis のキー一覧）**: `applications:198.51.100.7` / `applications:198.51.100.8` が
  **平文で存在**（TTL は窓の残り。最大 600 秒）。氏名・メールはキーに現れない（B-3。
  `mail:auto-reply:<32hex>` はハッシュ済み、`applications:fs:<64hex>` も `sid` の生値ではない）。
- **説明**: `lib/public-guard.ts:213` は「**生の IP / `sid` は出さない**（AC-RL-10 / AC-PII-1）」として
  ログには `keyDigest` を使っており、これは正しい。**しかし KV のキー名は同じ制約の対象外になっている。**
  IP アドレスは個人関連情報であり、`lib/retention.ts` が「`/privacy` の本文も削除バッチも必ずここを参照する」
  として保持期間を一元化した趣旨（＝「利用者に約束した期間」と「実装が実際に保持する期間」を一致させる）
  からすると、**10 分間の IP 保持が `/privacy` のどこにも書かれていない**のは同じ種類のずれである。
- **修正方針**: (a) `/privacy` に「不正利用防止のため発信元 IP を最大 10 分間保持する」旨を追記し、
  `RETENTION_PERIODS` に `rateLimitMinutes: 10` を足して単一定義に載せる、または
  (b) `rateLimitKey` で IP をハッシュしてキーに載せる（IPv6 `/64` 正規化の後にハッシュすれば
  AC-RL-4 の性質は保たれる）。**(a) のほうが安く、運用上の追跡可能性も失わない。**
- **参考**: AC-PII-1 / AC-RL-10 / F-023

---

### [SEC-066] KV 版の整列固定ウィンドウにより、窓の境界をまたぐと短時間に上限の 2 倍が通る

- **重大度**: **Info**
- **場所**: `lib/kv.ts:81-83`（`windowEndsAt` = `floor(now/windowMs)*windowMs + windowMs`）
- **説明**: 固定ウィンドウ方式に本質的な性質で、窓の終端直前に上限ぶん + 直後に上限ぶんを送ると
  短時間に 2 倍が通る。**インメモリ版（起点 = 最初の試行時刻）との差でもある。**
  実測でも TTL は到着位相に依存した（B-5: 作成直後の `chat:fs:*` の `PTTL = 19,055ms`。
  窓 600 秒に対し境界まで 19 秒だった）。
- **影響**: 発信元軸で 10 件/短時間、Cookie 軸で 6 件/短時間。**SEC-057 に比べれば無視できる。**
  `lib/kv.ts:16-23` は整列窓を選んだ理由（`EXPIRE` 張り直しによる「窓が終わらない」問題の回避）を
  正しく書いているので、**設計判断としては妥当**である。記録のみ。
- **修正方針**: 任意。閾値を決めるときに「実効上限は瞬間的に 2 倍になりうる」ことを前提にすること。

---

### 副次的に確認したが指摘に至らなかった点

| 確認項目 | 結果 |
|---|---|
| セマフォ `release` が実 Redis で漏れる／冪等でない | **問題なし**（C-1。B-4b の初回 FAIL は監査者のスクリプト誤り） |
| メモリ版セマフォと KV 版の意味論差（Impl の I-6） | **差は検出されず**（C-2 / C-2b）→ I-6 クローズ |
| `formSessionAxisKey` の戻り値 64 文字が `rateLimitKey` で二重ハッシュされる | **されない**（`MAX_RAW_KEY_LENGTH=64` にちょうど収まる。B-1b のキーが 64 hex であることを実測） |
| SEC-056（`toLowerCase()` による base64url の衝突） | **クローズ**。`sid` が 32 桁小文字 hex になり（`lib/form-session.ts:203`）、軸キーも SHA-256 hex なので情報が落ちない |
| 冪等再送の存在有無が列挙できる（200 vs 201） | **記録のみ**。`idempotencyKey` は UUID v4（122bit）で、`lib/validators/application.ts:242` が形式も強制している |
| `hp_field` の充填値がログに残る | **残らない**（`PII_DENY_KEYS` に `hp_field`。A-5 で実測 0 件） |
| 下書き（`sessionStorage`）に氏名・住所が入る | **設計どおり**（AC-008-3 が明示的に許可。タブを閉じれば消える / `localStorage` は `isDraftStorageAllowed` が拒否） |
| `/api/form-session` からのオープンリダイレクト | **無い**（遷移先 `/apply` 固定 + 引き継ぎ 2 パラメータ・長さ 64 制限） |
| CSP の `style-src 'unsafe-inline'` | **受容済み残余**として `lib/csp.ts:13-18` に明記されており、報告が丸められていない |
| 依存関係（`pnpm audit --prod`） | **SEC-017 の状況に変化なし**（high 3 = postcss × 2 / sharp、moderate 1 = postcss。**すべて `next` の推移依存でビルド時のみ**、`next/image` は未使用）。**CI への `pnpm audit` 組み込みは P1 SEC-006 から 4 単位連続で未対応** |

---

## D. Impl が「検証できていない」と申告した事項（§8）への判定

| # | 申告 | 監査の判定 |
|---|------|-----------|
| **I-5** | KV を実際に叩く経路が未検証。「Security 監査で実 Redis を立てて再測することを推奨」 | ✅ **クローズ**。監査者が Upstash REST 互換シム + 実 Redis 7.4.10 を立て、`VERCEL=1` の本番相当構成で `POST /api/applications` を通した。発信元軸（B-1）/ Cookie 軸（B-2）/ セマフォ（B-4）/ 自動返信スロットル（B-1b のキー一覧）**すべてが実 KV 上で機能している**ことを実測した。**Impl の推奨は正しく、そのとおり実施した** |
| **I-6** | メモリ版セマフォに契約テストが無い（KV 版と同じ意味論は目視でしか担保していない） | ✅ **クローズ**。C-2 / C-2b で両実装に同一シナリオ（上限・release・二重 release・`now == score` ちょうどの回収）を投入し、**4 点すべてで挙動が一致**。ただし**契約テストが無いという申告自体は正しい**ので、`semaphore-contract.ts` へ載せる提案は P3-c の推奨事項として残す |
| **I-3** | Turnstile の実ウィジェット動作が未検証 | ⏸ **残る（監査でも検証不可）**。ただし**サーバー側の fail-closed は 3 形態すべてで実測した**（E-1: 検証失敗 / ネットワーク例外 / HTTP 500 のいずれも 403・DB 0 件）。トークンが実際に POST ボディで送られていることも確認（E-1b）。**本番デプロイ時の運用確認事項として残す** |
| **I-4** | 自動返信メールの実送信が未検証 | ⏸ **残る**。文面・宛先スロットル・PII 非記載は実測済み（A-6 / A-6b）。Resend の受理（送信元ドメイン検証）は**運用確認事項**。なお `RESEND_API_KEY` を本番 fail-fast に含めない判断は妥当（含めると自動返信の未設定が申込受付自体を止める）だが、**未設定のまま本番稼働すると「受付は成立しているのに利用者に何も届かない」状態が無言で続く**ため、起動時の `console.warn` 程度は入れることを推奨する |
| I-1 | `__Host-` Cookie が WebKit で受理されない | §E-1 で判定 |
| I-2 | Cookie ブロック環境が Tier B から回復できない | **セキュリティ上は正しい設計**（Cookie 軸が唯一の enforce 軸である以上、Cookie 無しで通す経路を作ってはならない）。UX の穴であることは同意するので **Spec / Designer の判断事項**。ただし **SEC-057 の修正案 (a) を採ると、この利用者も CAPTCHA 経由で回復できるようになる**（1 つの修正で 2 つが解ける） |
| I-7〜I-12 | P3b-10 / AC-RL-9 / UI 構成 / 自動再試行ほか | **セキュリティ上の含意なし**（I-7 = P3b-10 は期限 P3-c で継続）。I-9 / I-10 / I-11 は Senior / Designer の判断事項 |

---

## E. E2E 失敗 2 件の扱い（判定のみ。**再実行していない**）

### E-1. `apply-form.spec.ts:77`（webkit・3/3 失敗）— **`__Host-` は維持すべき。Cookie 名の出し分けは採ってはならない**

- **判定**: **`__Host-` を維持する。開発と本番で Cookie 名を出し分ける案は却下する。**
- **理由**:
  1. `__Host-` 接頭辞が防いでいるのは **Cookie tossing（サブドメインからの上書き）** である。
     SEC-043 の是正により**縮退構成で enforce される Tier D 軸は Cookie 軸ただ 1 つ**になったので、
     軸を第三者に上書きされる経路は「レート制限そのものの無効化」に直結する（`lib/env.ts:16-19` が
     `FORM_SESSION_SECRET` を 32 文字にした理由とまったく同じ論理）。
  2. **環境で Cookie 名（＝ブラウザに強制させる属性の集合）を切り替えると、本番でだけ有効な
     セキュリティ属性が CI で一度も実行されない。** 本プロジェクトが 4 度繰り返した
     「テストが通る構成と本番の構成が違う」型そのものであり、**P2 の教訓に真正面から反する。**
  3. Impl の「却下すべき」という判断（実装記録 §7.3）は**正しい。**
- **推奨する対応**（優先順）:
  1. **`apply-form.spec.ts` の Cookie 発行アサーションを chromium / firefox に限定する**（`admin-*` を
     chromium 単独にした既存判断と同型）。`test.skip(browserName === 'webkit', 'WebKit は http://localhost で
     Secure Cookie を受理しないため。本番は https')` のように**理由をコード内に残すこと**。
     属性そのものは `formSessionCookieAttributes()` のユニットが既に固定している。
  2. 中期的に **E2E を https で回す**（自己署名 + `ignoreHTTPSErrors`）。そうすれば webkit も含めて
     本番相当の Cookie 経路を検証できる。
- **併せて記録すべき運用上の前提**: `secure: true` である以上、**http でホストされた瞬間に全利用者の
  Cookie が発行されず、全送信が Tier B になる**。これは fail-closed で正しい挙動だが、
  **「本番は必ず https」は明示的な運用前提**である。SEC-061 の対応と同じ場所（デプロイ前提の明文化）に書くこと。

### E-2. `top-page.spec.ts:27` — **セキュリティ上の含意なし**

単独実行でパスし、症状（サーバー到達性）は `docs/phase-status.md` の既知の高負荷時不安定要因と一致する。
**実装の欠陥ではないという Impl の切り分けを支持する。** ただし P1 から続く flaky の恒常化は
「本当の退行を隠す」ため、Senior の管轄で件数の推移を追うことを推奨する。

---

## F. P3-c 着手可否の判定

### 判定: **P3-c 着手不可（条件付き）** — **SEC-057 を閉じてから着手すること**

**理由**:

1. **`docs/phase-status.md` の完了条件「Security Critical 0 / High 0」を満たしていない**（High 1 件）。
   監査スキルのブロック基準（`.claude/skills/security.md`「Critical/High が 1 件でもあればリリースをブロックする」）に該当する。
2. **P3-c は免許証写真という最も機微なデータを扱う。** SEC-057 は「未認証の第三者が縮退構成で
   無制限に受付を成立させられる」欠陥であり、**そのままでは「無制限に免許証画像をアップロードさせられる」
   欠陥になる**（オブジェクトストレージの費用・違法画像の受け入れ・orphan 回収バッチの破綻へ直結する）。
   P3-b の段階で閉じるべきである。
3. 一方 **SEC-058 / SEC-059 / SEC-060 / SEC-061 は着手をブロックしない**（Medium）。
   ただし **SEC-061 は SEC-057 の成立条件**なので、SEC-057 の修正案として (c) を採るなら同時に閉じること。

### 着手の条件（**この 1 件のみをブロッカーとする**）

| # | 条件 | 検収方法（**この形で測れなければ受け入れない**） |
|---|------|--------------------------------|
| **C-1** | SEC-057 を閉じる。**縮退構成で Cookie を N 枚取り直しても、単一の攻撃者が受付を無制限に成立させられないこと** | **Cookie 1 枚での 429 を測るテストは根拠にならない。** 「`GET /api/form-session` を 20 回叩いて Cookie を 20 枚取得 → 各 3 回送信（計 60 回）」を本番経路（結合テストまたは検証スクリプト）で実行し、**201 の件数が上限相当に収まる**ことを固定すること。かつ**同じシナリオで正規利用者 1 名が締め出されない**ことを併せて測ること（片方だけを直すと SEC-021 型へ戻る） |

### P3-c で守るべき要件（P3b-1〜11 の更新版）

| # | 要件 | 出所 | 状態 |
|---|------|------|------|
| **P3c-1** | **SEC-057 の修正を、アップロード経路にも同じ形で適用する。** `uploads` エンドポイントの Tier D 軸が Cookie 軸だけにならないこと | SEC-057 | **新規（着手ブロッカー C-1 と同一）** |
| **P3c-2** | `withPublicMutation` の構築時検査を、`limiters` / `formSessionKey` のどちらか一方だけを渡した全構成へ広げる。4 通りの構築時 throw をテストで固定 | **SEC-058（新規）** | **新規。P3-c が新しい公開エンドポイントを作る前に** |
| **P3c-3** | `enforceBodyBytes` をストリーム読み進め + 上限超過で `cancel()` に改める。**テストは「読み取ったバイト数」を固定する**（応答コードだけでは検出できない） | **SEC-059（新規）** | **新規。写真アップロードは本質的に大きなボディを扱うため P3-c の前提** |
| **P3c-4** | 実在しない `courseId` を 422 で落とす。`P2003` を明示的に分類し、未分類の例外だけが 500 になるようにする | **SEC-060（新規）** | **新規** |
| **P3c-5** | `TRUST_PROXY` 等の明示的な環境変数を導入し、本番判定を `VERCEL` から切り離す。`lib/http-guard.ts:97-99` / `tech-stack.md` §4.5 の文言を実際に取れる操作へ更新 | **SEC-061（新規）** | **新規** |
| **P3c-6** | `lib/form-session.ts:246-251` / 実装記録 §7.5・§8 の「閉じ切るのは P3b-2」を訂正する | **SEC-062（新規）** | **新規（文書の訂正が本体）** |
| **P3c-7** | `withCronAuth` に粗い試行回数制限（**本単位が期限**） | SEC-046 / P3b-10 | **繰越・期限到来** |
| **P3c-8** | `PrismaClient` のエラーログを `lib/pii-log.ts` の 1 点へ合流させる。**`LicensePhoto` の `objectKey` を扱う前に** | **SEC-064（新規）** | **新規** |
| **P3c-9** | KV 版レート制限 store が上限到達後に `INCR` しないようにする | **SEC-063（新規）** | 新規（任意）／**P3-c1 では対応しない（明示的に繰越）**。理由と訂正後の契約（`count` は `current + 1`）は `docs/test-design-p3c1-2026-07-29.md` §10 に記録。Lua で 1 往復に畳めばよいが、そうするとフェイク Redis が解釈できず観測点を失うため、費用対効果で繰り越した。**黙って落としたのではない**（Senior 再検収 REV-P3C1-004 の繰越条件） |
| **P3c-10** | `/privacy` に発信元 IP の保持を追記し `RETENTION_PERIODS` へ載せる | **SEC-065（新規）** | 新規 |
| **P3c-11** | 免許証写真: **署名付き URL の有効期限・`objectKey` の推測不可能性・アップロード前の MIME/マジックナンバー検証・orphan 回収**。`uploadToken` を下書きに保存しない網（`lib/apply-draft.ts`）が実際に効くことを E2E で固定（テスト設計 §7 が P3-c へ引き取った項目） | AC-008-3(e) / AC-PII-5 | **新規（P3-c 本体）** |
| **P3c-12** | `semaphore-contract.ts` のフェイク契約にメモリ版セマフォを載せる | I-6 | 推奨（意味論の一致は監査者が実測済み） |
| **P3c-13** | CI へ `pnpm audit --audit-level=high` を組み込む | SEC-006 → SEC-017 | **P1 から 4 単位連続で未対応** |

---

## G. 総括

| レベル | 件数 |
|--------|------|
| **Critical** | **0** |
| **High** | **1**（**SEC-057**） |
| Medium | **4 新規**（SEC-058 / SEC-059 / SEC-060 / SEC-061）＋ 繰越 SEC-045 / SEC-038 / SEC-031 / SEC-032（部分）/ SEC-033（部分） |
| Low | **4 新規**（SEC-062 / SEC-063 / SEC-064 / SEC-065）＋ 繰越 SEC-048〜050 / SEC-014〜017 / SEC-025〜027 / SEC-039 / SEC-041（部分） |
| Info | **1 新規**（SEC-066）＋ 繰越 SEC-051 / SEC-036 / SEC-018〜020 / SEC-040 |

**クローズ**: **SEC-044**（KV 注入。**監査者が実 Redis で本番経路ごと通して確認**）/
**SEC-046**（secret の本番下限 32 文字。D-4 で 8 通り実測。ただし `withCronAuth` の試行回数制限は P3-c へ）/
**SEC-052**（`formSessionKey` の型による強制。キャストは正典 1 箇所のみ、巻き添え 429 は再現せず）/
**SEC-053**（`/api/applications` の配線。実 KV で両軸が enforce されることを実測）/
**SEC-054**（列挙テストの強化。実ルート 2 件が網に入った）/
**SEC-056**（`sid` の小文字 hex 化）。
**部分クローズ**: SEC-055（形式不正は閉じた。形式を満たす値の残余は SEC-062 として再定義）。

### リリース判定: **リリースをブロックする**（High 1 件）

### P3-c 着手判定: **不可（条件付き）**。**SEC-057 の 1 件のみをブロッカーとする**

### 是正の優先順位

1. **SEC-057**（High / 縮退構成での Cookie 取り直し。**着手ブロッカー**）
2. **SEC-061**（Medium / SEC-057 の成立条件。1 と同時に閉じるのが自然）
3. **SEC-059**（Medium / ボディの読み切り。**P3-c が写真を扱う前に**）
4. **SEC-058**（Medium / 構築時検査の穴。**P3-c が新しい公開エンドポイントを作る前に**）
5. **SEC-060**（Medium / `courseId` の 500）
6. **SEC-064**（Low / Prisma ログの合流。**`objectKey` を扱う前に**）
7. SEC-062（Low / **文書の訂正**）/ SEC-063 / SEC-065 / SEC-066 / SEC-017

### 評価 — 何が直り、何がまだ同じ形をしているか

**直ったこと**:

- **P3b-1b（SEC-052）は、型による強制が実際に機能したケースの 2 例目である。**
  `PerRequesterKey` の `as` キャストは正典の生成元 1 箇所しか存在せず、
  監査者が探した「共有キーを返す配線」は**書けない**。SEC-043 の `sourceAxisFor` と同じ手法が、
  今度は事前に（脅威が顕在化する前に）適用された。
- **P3b-11（SEC-055 の形式検証）は、監査者が独自に設計した 7 形 × 100 の形式不正入力に対しても
  バケットを 1 つも増やさなかった。** Impl の V-2（1 形 × 2,000）より入力の種類を広げても結果が変わらない
  ——**契約が正しいだけでなく、欠陥クラス全体が閉じている。**
- **PII の扱いは、監査者が 7 経路 × 6 種の突き合わせを行って流出 0 件だった。**
  「規律ではなくラッパで落とす」という `lib/pii-log.ts` の設計判断は、実測で報われている。
- **Impl の「報告できないこと」12 件は、監査者が検証した 2 件（I-5 / I-6）とも申告どおり
  「未検証だが実装は正しい」だった。** 過大報告も過小報告も無い。**この姿勢は P3-a から一貫している。**

**まだ同じ形をしていること**:

- **脅威は 5 度目の移動をした。** SEC-021 → SEC-029 → SEC-030 → SEC-043 → **SEC-057**。
  今回の移動は「共有軸を硬いゲートにする」型ではなく、その**是正の裏側**——
  「攻撃者自身に閉じた軸なら硬いゲートにしてよい」という前提が、
  **軸の入手コストを問うていなかった**という形で現れた。
  P3b-1b は「一意であること」を型で保証したが、**「希少であること」は誰も保証していない。**
- **Impl は必要な測定をすべて行っていた（V-1 と V-4b）。欠けていたのは、2 つを攻撃者の 1 つの手順として
  結合することだけである。** これは P2.5 の教訓（「red が全部 green になっても脅威が閉じていない」）と
  同じ構造で、**個々の検証を積み上げても、シナリオを組み立てる作業を別に置かないと届かない。**
  次単位では「**各検証項目を 1 つの攻撃者の手順書として通しで書く**」ことを推奨する。
- **「P3b-2 が SEC-055 を閉じる」という記述が 3 つの文書（実装コメント・実装記録・テスト設計）に
  同じ形で書かれ、誰も測っていなかった。** 監査者が実 KV で測ると閉じていない。
  **P2.5 の「事実に反する記述の訂正」と同型が再発している**——引き継ぎ文書に書かれた「閉じる予定」は、
  次の単位で「閉じた」に変わりやすい。

**方法論についての記録**: 本監査の High 1 件は、**新しい脆弱性を見つけたのではなく、
Impl が既に測っていた 2 つの数字（V-1 と V-4b）を結合しただけ**で出た。
「何を測ったか」ではなく「**攻撃者の手順として何が通るか**」を問う形に検証を組み替えることが、
このプロジェクトで最も費用対効果の高い改善である。
