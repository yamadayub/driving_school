# コードレビュー: P2「お知らせCMS（管理画面 + News CRUD + 認証）」実装検収

## レビュー日: 2026-07-28
## 対象Phase: 実装（CLAUDE.md Phase 7 コードレビュー）
## レビュワー: Senior Engineer Agent
## 前提: 品質ゲートは全て green（type-check / lint / unit 72 / integration 23 / build / e2e 67）。本レビューはテスト実行せず**コード読解のみ**で判定する。

---

## 総合評価: **Request Changes**

品質ゲートは全通過しており、認証の多層防御・サニタイズ設計・バリデーション設計はいずれも P1 レビュー時より明確に成熟している。PT2-01（ハンドラ層認可）/ PT2-03（E2E掃除）/ PT2-05（定数時間比較）/ PT2-06（単一描画経路）は**実コードで解決を確認**した。

しかし **RV-P2-001** は「テストが通っているのに仕様が満たされていない」典型で、Approve できない。PT2-02（予約公開の時刻ゲート）は `lib/news-admin.listPublishedNews` に正しく実装され結合テストも追加されたが、**公開トップページが実際に呼んでいるのは `lib/queries.getLatestNews` であり、そちらに時刻ゲートが無い**。すなわち検証されている関数が本番経路ではない。予約公開した記事がトップに即時露出する F-004 違反が現存する。修正は1行だが、影響は仕様不適合として明確なので差し戻しとする。

加えて **RV-P2-002**（SEC-004: AUTH_SECRET 起動時強度検証）は docs/phase-status.md が「P2 F-012 認証実装で対応」と明記した P2 のスコープ項目でありながら、`lib/env.ts` は P1 当時のまま `.min(1).optional()` で未着手である。監査上の重大度は Low だが、Phase の約束が果たされていないため Must Fix に含める。

いずれも小さな変更で、Should Fix を待たずに RV-P2-001/002 のみ修正 → 再レビューで Approve 可能な状態である。

## 評価サマリー
- **改善必須（Must Fix）: 2件** — RV-P2-001, RV-P2-002
- **改善推奨（Should Fix）: 7件** — RV-P2-003〜009
- **任意（Nice to Have）: 6件** — RV-P2-010〜015

### 良い点（積極的に評価する）
- **ハンドラ層認可の徹底**（PT2-01 の完全な実装）: `route.ts` / `[id]/route.ts` / `save/route.ts` / `delete/route.ts` の**4ハンドラすべて**が `await auth()` を独自に実行しており、middleware の matcher が `/admin/:path*` のみ（`/api/admin/*` を含まない）であることをコメントで正しく明示している。middleware だけに依存していたら `/api/admin/news` は完全な穴だった。危険を正しく認識した上での設計。
- **認可を存在確認より先に置く**（`app/api/admin/news/[id]/route.ts:33,55`）: 未認証者に ID の存在有無を漏らさない。細かいが正しい順序で、コメントにも意図が残っている。
- **サニタイズの信頼境界が最終段にある**（`lib/markdown/renderSafe.ts:95-101`）: `rehype-sanitize` をパイプライン最終段に置き、`defaultSchema` を継承せずゼロからホワイトリストを定義。`protocols.href` で `javascript:`/`data:` を排除し、`strip: ['script','style']` で子孫ごと除去、`forceSafeLinkAttrs` で著者から target/rel の制御を奪う。ブラックリスト方式の漏れに強い正しい構造。
- **描画点が本当に1箇所**（PT2-06）: リポジトリ全体で `dangerouslySetInnerHTML` は `components/admin/MarkdownEditor.tsx:77` のみ。しかもその `__html` は `renderMarkdown(value)` の直接の戻り値で、生 `body` を描画する経路は存在しない。
- **判別ユニオンによるバリデーション**（`lib/validators/news.ts:70-74`）: status ごとに `publishedAt` の必須性を型と実行時の両方で切り替える。`if (status === 'PUBLISHED' && !publishedAt)` 的な後付け検証より堅い。`invalid_union_discriminator` を `status` フィールドエラーへ写像する処理（:97-106）も丁寧。
- **ダッシュボードの部分劣化**（`app/admin/(app)/page.tsx:17-29`）: 統計取得の失敗でページ全体を落とさず `null` を返して「—」表示にフォールバック。運用上正しい判断。
- **管理画面全ページの `robots: { index: false }`** と、`(app)` route group による「認証シェル内／外」の物理的分離。ログイン画面がガード対象外であることが URL 構造ではなくディレクトリ構造で表現されている。
- **PT2-01/02/03 のテスト追加が実際に行われている**: `tests/e2e/playwright/admin-authz.spec.ts`（未認証 GET/POST/PUT/DELETE の 401/403）、`tests/integration/news-admin.int.ts:130`（未来日 publishedAt 除外）、`admin-news.spec.ts:39`（`afterAll` の接頭辞掃除）。前回レビューの指摘が形骸化せず反映されている。

---

## PT2-01〜07 解決状況の判定表

| ID | 指摘概要 | 判定 | 根拠 |
|----|---------|------|------|
| **PT2-01** | 変更系管理APIのサーバー認可が未テスト | **解決済み** | 実装: 4ハンドラすべてで `await auth()` 再検証（`app/api/admin/news/route.ts:14-17,23,30`、`[id]/route.ts:11-14,33,55`、`save/route.ts:20-23`、`delete/route.ts:12-15`）。middleware 非依存。テスト: `tests/e2e/playwright/admin-authz.spec.ts:29-51` が未認証 GET/POST/PUT/DELETE の 401/403 を検証。付随して RV-P2-005（CSRF）/ RV-P2-009（Response 再利用）を新規指摘。 |
| **PT2-02** | 予約公開（未来 publishedAt）の除外が未検証 | **未解決（部分）** | `lib/news-admin.ts:116` の `listPublishedNews` は `publishedAt: { lte: new Date() }` を持ち、結合テスト（`news-admin.int.ts:130-149`）も追加済み。**しかし公開トップが呼ぶのは `lib/queries.ts:39-45` の `getLatestNews` で、こちらに時刻ゲートが無い**。テスト対象が本番経路でない。→ **RV-P2-001（Must Fix）** |
| **PT2-03** | E2E が共有DBに実 PUBLISHED 行を残しうる | **解決済み** | `tests/e2e/playwright/admin-news.spec.ts:14,39` で `E2E_TITLE_PREFIX` 付与＋`test.afterAll` の接頭辞一致掃除を実装。加えて phase-status に「タイトル一意化キーにプロジェクト名＋stamp」も記録され、共有DB衝突対策が二重化されている。 |
| **PT2-04** | 難読化 `javascript:` / 非許可ブロック（table・pre）の明示テスト | **未解決（任意）** | `tests/unit/sanitize.test.ts` は前回レビュー時のケース（script/iframe/img/on*/style/`javascript:`/`data:`）のままで、大小混在・HTMLエンティティ難読化や「`\| a \| b \|` が `<table>` を生まない」「fenced code が `<pre>` を生まない」テストは未追加。ホワイトリスト方式のため実害リスクは低いが、厳格版の縮小許可集合が回帰から守られていない。→ **RV-P2-008** に含めて追跡。 |
| **PT2-05** | `verifyPassword` の定数時間比較をコードレビューで担保 | **解決済み** | `lib/password.ts:26-46`。`timingSafeEqual(actual, expected)` を使用し `===` 比較は無い。長さ差による throw を避けるため `expected.length !== SCRYPT_KEYLEN`（:37）と `actual.length !== expected.length`（:41）で事前 false。hex 妥当性を正規表現で先に検証し `Buffer.from` の暗黙切り詰めを塞いでいる（:33）点も良い。**ただし呼び出し元 `auth.ts` の分岐にタイミング差がある** → RV-P2-003（Should Fix）。 |
| **PT2-06** | 本文HTML描画が単一 `renderMarkdown` 経路のみか grep 確認 | **解決済み（条件付き）** | `dangerouslySetInnerHTML` の全出現は `components/admin/MarkdownEditor.tsx:77` の1箇所のみ（`grep -rn dangerouslySetInnerHTML app components lib src tests` で確認）。`__html` は `renderMarkdown(value)` 直結。条件: 公開側の本文描画（F-005 `/news/[id]`）は**まだ存在しない**ため、単一経路性は P3 以降で再確認が必要（→ 申し送り）。 |
| **PT2-07** | migration 後の PublishStatus 型/enum 再整合 | **未解決（任意）** | `prisma/schema.prisma:67-71` に `UNPUBLISHED` は追加済み。しかし `lib/publish-status.ts:3-8` のコメントは「現時点の Prisma schema の enum は DRAFT/PUBLISHED の2値のみ」と**事実と異なる状態のまま**残り、両者一致のコンパイル時アサーションも未導入。→ **RV-P2-011** |
| **SEC-001** | News.body の HTML サニタイズ必須 | **解決済み（実装）／要ドキュメント更新** | `lib/markdown/renderSafe.ts` で実装。ただしパイプラインが `rehype-raw` 使用へ変更されており、functional-spec §4.10 の記述と乖離 → RV-P2-008。 |
| **SEC-004** | AUTH_SECRET 起動時強度検証 | **未解決** | `lib/env.ts:25` は `AUTH_SECRET: z.string().min(1).optional()` のままで、production 判定も長さ検証も無い。コメントに「本番は32byte以上を必須とする（SEC-004 申し送り）」と書かれているが実装が伴っていない。→ **RV-P2-002（Must Fix）** |

---

## 指摘事項

### [RV-P2-001] 公開トップの `getLatestNews` に `publishedAt <= now()` の時刻ゲートが無い（予約公開が即時露出）

- **種別**: Bug / 仕様不適合（F-004）
- **重要度**: **Must Fix**
- **場所**: `lib/queries.ts:39-45`（公開経路） / `lib/news-admin.ts:114-120`（検証済みだが未使用の経路） / 呼び出し元 `app/(public)/page.tsx:36`
- **現状**:

```ts
// lib/queries.ts:39
export async function getLatestNews(take = 3) {
  return prisma.news.findMany({
    where: { status: 'PUBLISHED' },   // ← publishedAt の条件が無い
    orderBy: { publishedAt: 'desc' },
    take,
  })
}
```

  一方で `listPublishedNews` は正しい:

```ts
// lib/news-admin.ts:116
where: { status: 'PUBLISHED', publishedAt: { lte: new Date() } },
```

  `grep -rn listPublishedNews app components lib` の結果、`listPublishedNews` を呼ぶ**アプリコードは存在せず、参照は結合テストのみ**（`tests/integration/news-admin.int.ts` の7箇所）。トップページ（唯一の公開お知らせ面）は `getLatestNews` を使う。したがって PT2-02 で追加された「未来日 publishedAt は公開クエリに現れない」結合テスト（`news-admin.int.ts:130-149`）は green だが、**本番の公開経路は一切カバーしていない**。管理画面で `publishedAt = 2026-12-01` を設定して「公開する」を押すと、トップの NEWS セクションに即座に表示される。

  副次的に、`status='PUBLISHED'` かつ `publishedAt = null` のレコード（seed や直接 SQL で作られうる）は PostgreSQL の `ORDER BY publishedAt DESC` で **NULLS FIRST** となり、トップの先頭を占有する。時刻ゲートを入れれば `lte` により NULL 行も自動的に除外される。

- **改善案**: 公開クエリの真実源を1つにする。最小修正:

```ts
/** トップお知らせ最新 n 件（PUBLISHED かつ publishedAt <= now、publishedAt 降順）。 */
export async function getLatestNews(take = 3) {
  return prisma.news.findMany({
    where: { status: 'PUBLISHED', publishedAt: { lte: new Date() } },
    orderBy: { publishedAt: 'desc' },
    take,
  })
}
```

  望ましくは `getLatestNews` を `listPublishedNews(...).slice(0, take)` 相当に委譲するか、`where` 条件を `lib/news-admin.ts` から `export const PUBLISHED_NEWS_WHERE` として共有し、2箇所に同じ述語を書かない構造にする（次に `/news` 一覧・詳細を実装する P3 で3箇所目・4箇所目が生まれるため、今が分岐を潰す最後のタイミング）。

  併せて**回帰テストを本番経路に付け直す**こと: 現状の `news-admin.int.ts:130` の未来日テストを `getLatestNews` に対しても1本追加する。テストが本番経路を指していなかったことが本件の根本原因である。

- **理由**: F-014 の画面仕様が「公開日 datetime, PUBLISHED時必須」を定め、functional-spec §4.9 のインデックス戦略も `(status, publishedAt DESC)` を公開一覧クエリ用として定義している以上、予約公開は仕様として存在する。時刻ゲートの欠落は「未来の記事が即時公開される」という利用者から見て明白な不具合であり、CMS の中核機能の破綻にあたる。前回レビュー PT2-02 が予見した障害がそのまま残っている。

### [RV-P2-002] SEC-004（本番 AUTH_SECRET の起動時強度検証）が P2 スコープでありながら未実装

- **種別**: Security / スコープ未達
- **重要度**: **Must Fix**
- **場所**: `lib/env.ts:22-25`
- **現状**:

```ts
// AUTH_SECRET: JWT セッション署名鍵。NextAuth v5 が自動参照する（F-012）。
// import 時 throw を避けるため optional のままだが、本番は 32byte 以上の乱数を必須とする（SEC-004 申し送り）。
AUTH_SECRET: z.string().min(1).optional(),
```

  コメントは要件を正しく述べているが、**それを強制するコードが無い**。`docs/security-audit.md:73` の修正方針は「F-012 実装時に、本番環境で `AUTH_SECRET` が十分な長さ（32byte以上）で設定されていることを起動時検証（`getServerEnv` で production 時必須化）」と具体的に指定しており、`docs/phase-status.md` も「SEC-004(Low): 本番AUTH_SECRET強度の起動時検証（→P2 F-012認証実装で対応）」と P2 に割り当てている。F-012 は本 Phase で実装されたため、対応期限は本 Phase である。現状 `.env` の `dev-only-secret-change-me` のまま本番デプロイしても何も検出されない。

- **改善案**: `serverEnvSchema` に production 条件付きの refine を追加する。

```ts
export const serverEnvSchema = z
  .object({
    // ... 既存定義
    AUTH_SECRET: z.string().min(1).optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  })
  .superRefine((env, ctx) => {
    // SEC-004: 本番のみ AUTH_SECRET を必須化し、32byte 相当（base64 43文字以上）を要求する。
    if (env.NODE_ENV !== 'production') return
    if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SECRET'],
        message:
          'AUTH_SECRET は本番環境で必須、かつ32文字以上にしてください（openssl rand -base64 32）',
      })
    }
  })
```

  検証が `getServerEnv()` 遅延実行である以上、**アプリのどこかが実際に `getServerEnv()` を呼ばないと発火しない**点に注意。現状 `grep` した限り `getServerEnv` の呼び出し元が無いため、`auth.ts` のモジュール初期化時か `instrumentation.ts` で1回呼ぶ導線を併せて用意すること。既存の「import 時に throw しない（ビルド／単体テストを壊さない）」方針は `NODE_ENV !== 'production'` ガードで維持される。`parseServerEnv` は純関数なので単体テストも容易（production かつ短い値で失敗、production かつ十分な長さで成功、development で未設定でも成功）。

- **理由**: JWT セッション戦略（`auth.config.ts:17`）では署名鍵の強度がセッション偽造耐性そのものである。弱い鍵は「管理者としてログインできるトークンを誰でも生成できる」に直結し、本 Phase で構築した認可（middleware + 4ハンドラの `auth()` 再検証）を一括で無効化する。監査上の重大度が Low だったのは P1 時点で認証が未稼働（`providers: []`）だったためであり、F-012 が稼働した今その前提は消えている。

### [RV-P2-003] `authorize` にユーザー存在有無のタイミング差があり、コメントの記述とも矛盾する

- **種別**: Security（アカウント列挙 / E-012-1）
- **重要度**: Should Fix
- **場所**: `auth.ts:33-36`
- **現状**:

```ts
const user = await prisma.adminUser.findUnique({ where: { email } })
// ユーザー不在でもパスワード検証相当の分岐を経て一律 null（詳細を返さない）。
if (!user?.passwordHash) return null
if (!verifyPassword(password, user.passwordHash)) return null
```

  コメントは「ユーザー不在でもパスワード検証相当の分岐を経て」と書いているが、コードは**不在なら `verifyPassword` を一切呼ばずに即 return する**。`verifyPassword` は `scryptSync`（既定 N=16384）を実行するため数十〜百ms かかり、不在ケース（DB 参照のみ、数ms）との差は外部から容易に測定できる。E-012-1 が要求するアカウント列挙対策は、レスポンス本文の汎用化（実装済み・正しい）だけでなく応答時間の均一化まで含めて初めて成立する。実装と説明が食い違っているコメントは、後任が「対策済み」と誤読する分だけ単なる未対策より有害である。

- **改善案**: ダミーハッシュに対する検証を実行して時間を均す。

```ts
// 実在ユーザーと同形式のダミー（モジュール初期化時に1回だけ生成）。
const DUMMY_HASH = hashPassword(randomBytes(32).toString('hex'))

// ...
const user = await prisma.adminUser.findUnique({ where: { email } })
// 不在/ハッシュ無しでもダミーに対して同じコストの検証を行い、応答時間を均一化する（E-012-1）。
const stored = user?.passwordHash ?? DUMMY_HASH
const ok = verifyPassword(password, stored)
if (!user?.passwordHash || !ok) return null
```

  `ok` を先に評価し切ってから短絡させる点が重要（`&&` で早期脱出すると意味が無い）。RV-P2-004 と併せて非同期 `scrypt` へ移す場合も同じ構造で書ける。

- **理由**: 管理画面の管理者メールアドレスは実質的な認証情報の半分であり、列挙されるとブルートフォース・パスワードスプレーの標的が確定する。修正は数行で、既存テスト（`password.test.ts` は `verifyPassword` を直接検証）に影響しない。

### [RV-P2-004] `scryptSync` が同期実行でイベントループを塞ぐ（E2E の flaky 化として既に観測済み）

- **種別**: Performance / 可用性
- **重要度**: Should Fix
- **場所**: `lib/password.ts:21,39`（`scryptSync`）← 呼び出し元 `auth.ts:36`
- **現状**: `verifyPassword` は同期関数として設計され（テスト契約もそうなっている）、内部で `scryptSync` を呼ぶ。Node は単一スレッドのため、ログイン1件が数十〜百ms の**あいだサーバー全体（公開ページ含む）の応答を停止させる**。これは机上の懸念ではなく、`docs/phase-status.md`「E2E 実行方針の確定（P2で変更）」に「dev のオンデマンドコンパイル＋**同期 scrypt** が重なると3ブラウザ同時ログインでサーバ過負荷になり flaky 化する」と実測として記録されている。現在は「admin 系を chromium 単一実行にする」というテスト側の回避で塞いでいるが、原因は実装側にある。ログイン試行を並べるだけで安価な DoS になる点も含めて、本番前に解消しておきたい。
- **改善案**: 非同期版を追加し、`authorize` からはそちらを使う（スレッドプールで実行され、イベントループを塞がない）。同期版は既存の単体テスト契約のため残してよい。

```ts
import { scrypt } from 'node:crypto'
import { promisify } from 'node:util'
const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, k: number) => Promise<Buffer>

/** verifyPassword の非同期版（イベントループを塞がない。認証ハンドラからはこちらを使う）。 */
export async function verifyPasswordAsync(plain: string, stored: string): Promise<boolean> {
  // ... 同じパース/検証、scryptSync → await scryptAsync
}
```

  併せて `UV_THREADPOOL_SIZE`（既定4）を超える同時ログインでは待ち行列ができる点、および RV-P2-014（ログインのレート制限）が本件の緩和にもなる点を留意。

- **理由**: 認証は未認証の第三者が任意に発火できる唯一の重い処理であり、そこに同期 CPU バウンド処理を置くと可用性が攻撃面になる。既にテスト戦略を歪めている（クロスブラウザ検証を管理系で放棄した）実害が出ている。

### [RV-P2-005] `save` / `delete` エンドポイントに CSRF 対策が無く、Cookie の SameSite 既定値に暗黙依存している

- **種別**: Security（CSRF）
- **重要度**: Should Fix
- **場所**: `app/api/admin/news/save/route.ts:19` / `app/api/admin/news/delete/route.ts:11` / 送信元 `components/admin/NewsForm.tsx:52-54`, `components/admin/ConfirmDialog.tsx:75`
- **現状**: 両エンドポイントは `method="post"` のネイティブ form 送信（`application/x-www-form-urlencoded`）を受け、認証はセッション Cookie のみで判定する。**CSRF トークンも Origin/Referer/Sec-Fetch-Site 検証も無い**。ログインフォーム（`LoginForm.tsx:24,37`）が Auth.js の double-submit cookie トークンを正しく取得・送信しているのと対照的で、CMS 側だけ保護が抜けている。

  現時点で実際に悪用可能かというと、Auth.js v5 のセッション Cookie 既定が `sameSite: 'lax'` であり、クロスサイトの **POST では Cookie が送出されない**ため攻撃は成立しない。つまり安全性が「ライブラリの Cookie 既定値」という、このコードのどこにも書かれていない一点に依存している。加えて本設計は「Server Action ではなくネイティブ form POST」を意図的に選んだもの（保存直後の遷移で中断されないため。判断自体は妥当）だが、その副作用として **Next.js の Server Action が標準で行う Origin 検証を手放している**ことがコメントに記録されていない。

- **改善案**: 変更系ハンドラ共通の軽量な同一オリジン検証を入れ、依存関係を明示する。

```ts
// lib/http-guard.ts
/** 変更系ハンドラの CSRF 防御: 同一オリジンからの送信のみ受理する（Cookie の SameSite に依存しない）。 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false // ネイティブ form の cross-site POST は Origin を必ず送る
  return origin === new URL(request.url).origin
}
```

```ts
// save/route.ts, delete/route.ts の冒頭
if (!isSameOrigin(request)) {
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}
```

  同一オリジンの通常送信では `Origin` が常に付与されるため既存 E2E は影響を受けない。判定を導入したら「未認証は 303 リダイレクト、クロスオリジンは 403」という応答契約を E2E に1本足しておくとよい。

- **理由**: CSRF が成立すれば認証済み管理者にお知らせの削除・改ざんを実行させられる（本 Phase で作った認可が全て迂回される）。現状は偶然守られているだけで、Cookie 設定を将来 `sameSite: 'none'`（外部埋め込み・別ドメイン管理画面など）に変えた瞬間に無防備になる。防御は数行で、明示しておく価値がコストを大きく上回る。

### [RV-P2-006] Markdown プレビューがクライアント側で毎キーストローク実行され、サニタイズ一式がクライアントバンドルに載る

- **種別**: Performance / Security（境界）
- **重要度**: Should Fix
- **場所**: `components/admin/MarkdownEditor.tsx:1,4,77`
- **現状**: `MarkdownEditor` は `'use client'` でありながら `renderMarkdown` を静的 import している。結果:
  1. **バンドル**: `unified` / `remark-parse` / `remark-rehype` / `rehype-raw`（内部で `parse5` を含む HTML パーサ一式）/ `rehype-sanitize` / `rehype-stringify` が管理画面のクライアントバンドルに丸ごと入る。とくに `rehype-raw` の依存は数百KB規模になる。
  2. **入力レイテンシ**: `NewsForm` は controlled（`NewsForm.tsx:49,143`）で、`body` の1文字ごとに再レンダーが走り、そのたびに `renderMarkdown(value)` が `processSync` で**同期的に**Markdown 全文をパースする。`maxLength` は 20,000 文字（`MarkdownEditor.tsx:26`）。長文を編集するほど1打鍵ごとの遅延が伸びる。`useMemo` も debounce も無い。
  3. **境界**: この構成のため `lib/markdown/renderSafe.ts` に `server-only` を付けられない。SEC-001 の描画パイプラインがクライアント実行可能になっていることは、`lib/queries.ts:10` がわざわざ `server-only` で誤 import をビルドエラー化している方針とも不揃いである。
- **改善案**: 段階的に、コストの低い順で:

```ts
// (a) 最小: 描画を遅延値＋メモ化する（打鍵ごとの再パースを止める）
const deferred = useDeferredValue(value)
const html = useMemo(() => renderMarkdown(deferred), [deferred])
// ...
<div dangerouslySetInnerHTML={{ __html: html }} />
```

  (b) 併せて `next/dynamic` でプレビュー部分のみ遅延ロードし、初期バンドルから外す。(c) 恒久策としては、プレビューをサーバー側（Route Handler もしくは Server Component）で生成して `renderSafe` を `server-only` に戻すのが最も筋が良い。P3 で公開側 `/news/[id]` を実装する際、どのみち**サーバー描画経路が必要**になるため、そのタイミングで (c) に寄せると重複が生まれない。

- **理由**: 管理画面のためユーザー数は少ないが、20,000文字の本文で1打鍵ごとに同期パースが走る編集体験は実用に耐えない。(a) だけなら3行で、リスクもほぼ無い。

### [RV-P2-007] `publishedAt` の解釈がサーバーのタイムゾーン依存で、一覧表示（Asia/Tokyo 固定）と食い違う

- **種別**: Bug / 仕様適合
- **重要度**: Should Fix
- **場所**: `app/admin/(app)/news/[id]/edit/page.tsx:15-19`（`toDatetimeLocal`） / `app/api/admin/news/save/route.ts:36-40`（`new Date(publishedAtRaw)`） / `lib/format.ts:28-39`（`formatNewsDate`）
- **現状**: フォームは `<input type="datetime-local">` で `"2026-07-28T09:00"`（オフセット無し）を送る。サーバーは `new Date("2026-07-28T09:00")` で受けるが、ES 仕様上オフセット無しの日時文字列は**実行環境のローカルタイム**として解釈される。Vercel の実行環境は UTC のため、管理者が JST のつもりで入力した 09:00 は 09:00 UTC（= 18:00 JST）として保存される。

  一方 `formatNewsDate` は `timeZone: 'Asia/Tokyo'` を明示して整形する（`format.ts:32`）。したがって**入力・往復（`toDatetimeLocal` はサーバーローカル基準）は UTC、表示は JST** という二重基準になる。JST 00:00〜09:00 に相当する時刻を設定すると、管理一覧の「公開日」が入力した日付と1日ずれて表示される。さらに RV-P2-001 を修正して `publishedAt <= now()` ゲートを入れると、この 9 時間のずれがそのまま「意図した時刻に公開されない」に変わる。

  ローカル開発機（JST）では両者が一致するため、この不具合は**本番環境でのみ顕在化する**。E2E も当日日付で通るため検出されない。

- **改善案**: 入出力の両方向で Asia/Tokyo に固定し、`formatNewsDate` と基準を揃える。

```ts
// 保存側（save/route.ts）: datetime-local を JST として解釈する
const JST_OFFSET = '+09:00'
const publishedAt =
  typeof publishedAtRaw === 'string' && publishedAtRaw.trim() !== ''
    ? new Date(`${publishedAtRaw}:00${JST_OFFSET}`) // "YYYY-MM-DDTHH:mm" → JST 固定
    : null
```

```ts
// 表示側（toDatetimeLocal）: Intl で Asia/Tokyo の各パートを取り出して組み立てる
// （getFullYear 等のサーバーローカル getter を使わない）
```

  時刻を扱うヘルパが `lib/format.ts` / edit page / save route の3箇所に散っているので、`lib/format.ts` に `toJstDatetimeLocal(date)` / `parseJstDatetimeLocal(str)` の対で集約し、単体テストで往復（JST 00:30 → 保存 → 再表示で 00:30）を固定するのが確実。`TZ=UTC` を明示したテストにすれば本番相当の条件を再現できる。

- **理由**: 日本国内の教習所サイトであり、公開日時は JST 以外に解釈の余地が無い。ローカルで再現せず本番でのみ壊れる種類の不具合は発見が遅れ、しかも「予約公開が9時間ずれる」という利用者に見える形で出る。

### [RV-P2-008] `renderSafe` の実装が functional-spec §4.10 の記述から乖離している（ドキュメント側の更新が必要）

- **種別**: Maintainability / ドキュメント整合
- **重要度**: Should Fix
- **場所**: `lib/markdown/renderSafe.ts:16-26,95-101` ↔ `docs/functional-spec.md` §4.10 / `docs/review-p2-test-2026-07-27.md:27`
- **現状**: 実装は当初契約から2点ずれている。**いずれも実装側の判断が正しく、直すべきはドキュメントの側**である。
  1. **`rehype-raw` を使用**（:31,98）。テスト設計レビューは「rehype-raw **不使用**＝生HTMLを要素として復元しない」ことを安全性の根拠として承認していた（`review-p2-test-2026-07-27.md:27`）。実装のコメント（:16-22）は変更理由を丁寧に説明しており、その内容に同意する。`allowDangerousHtml: false` では `<script>alert(1)</script>` のタグだけが落ちて中身の `alert(1)` がテキストとして残り、`sanitize.test.ts` の「ペイロード不残存」契約を満たせない。生 HTML を一度実要素に戻してから `strip` で子孫ごと消すのが正しい。サニタイズがパイプライン最終段にある限り安全性は保たれる。ただし**承認の根拠だった前提が変わった**以上、記録は更新すべきである。
  2. **表（table）を不許可**（:40-55 の `tagNames` に `table`/`pre` 無し）。functional-spec §4.10 は許可要素として「見出し・段落・強調・リスト・引用・コード・**表**・リンク等」と書いており、実装の方が厳格。これはテスト設計レビュー判断(b)で「厳格版に確定」と合意済みだが、**仕様書本文がその合意を反映していない**ため、仕様書だけを読むと実装がバグに見える。
- **改善案**:
  - `docs/functional-spec.md` §4.10 を更新: 許可要素から「表」を外し、パイプラインを `remark → rehype(allowDangerousHtml) → rehype-raw → rehype-sanitize` と明記し、`rehype-raw` を挟む理由（script 本文の確実な除去）を1行添える。
  - `docs/security-audit.md` の SEC-001 も同様に、実装済みかつパイプライン変更あり、として更新。
  - PT2-04 の追加テストをこの機に入れる: 「`| a | b |` が `<table>` を生まない」「fenced code が `<pre>` を生まない」「`JaVaScRiPt:` / `&#106;avascript:` / 前後空白付きが `href` に残らない」。厳格化した許可集合が将来の変更で静かに緩むことを防げる。
  - あわせて `strip: ['script', 'style']` の対象拡張を検討（`title` / `textarea` / `noscript` / `iframe` は現在アンラップされ、中身がテキストとして表示に残る。安全性の問題ではないが表示上のノイズになる）。
- **理由**: 実装がドキュメントより厳しい方向にずれているのは害が小さいが、**レビューが承認した根拠と実装が違う**状態を残すと、次に安全性を検証する人が誤った前提から出発する。SEC-001 は本プロジェクトで最も重要なセキュリティ資産であり、その記録の正確さは実装の正確さと同等に重要である。

### [RV-P2-009] `UNAUTHORIZED` をモジュールスコープの `NextResponse` インスタンスとして共有している

- **種別**: Bug（潜在） / 堅牢性
- **重要度**: Should Fix
- **場所**: `app/api/admin/news/route.ts:19` / `app/api/admin/news/[id]/route.ts:16`
- **現状**:

```ts
const UNAUTHORIZED = NextResponse.json({ error: 'unauthorized' }, { status: 401 })
// ... 各ハンドラで
if (!(await ensureAdmin())) return UNAUTHORIZED
```

  `Response` のボディは**一度しか読めない `ReadableStream`** であり、同一インスタンスを複数のリクエストに返すのは Fetch API の契約に反する。2回目以降のレスポンスでボディが空になる、あるいはランタイムによっては `Body is unusable` で 500 になる可能性がある。プロセス存続中ずっと共有される（モジュールは一度しか評価されない）ため、サーバーレスの1インスタンスが複数の未認証リクエストを捌けば必ず踏む。

  現行 E2E（`admin-authz.spec.ts`）は**ステータスコードのみ**を検証しボディを読まないため、この問題を検出しない。67件 green はこの点の証拠にならない。

- **改善案**: 毎回新しいレスポンスを生成する。

```ts
const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 })
// ...
if (!(await ensureAdmin())) return unauthorized()
```

  `ensureAdmin` と `unauthorized` は2ファイルに重複しているので、`lib/api-auth.ts` に `requireApiAdmin(): Promise<NextResponse | null>` としてまとめると RV-P2-010 と同時に解消できる。あわせて E2E に `expect(await res.json()).toEqual({ error: 'unauthorized' })` を1行足せば回帰を固定できる。

- **理由**: 「テストは通るが仕様上不正」な実装で、負荷や環境が変わったときに未認証パスだけが壊れるという再現困難な形で出る。修正コストはほぼゼロ。

### [RV-P2-010] `normalizePublishedAt` と `ensureAdmin` が2ファイルに完全重複

- **種別**: Maintainability
- **重要度**: Nice to Have
- **場所**: `app/api/admin/news/route.ts:14-17,48-59` と `app/api/admin/news/[id]/route.ts:11-14,18-29`
- **現状**: 12行の `normalizePublishedAt` と 4行の `ensureAdmin` が一字一句同じ形で両ファイルに存在する。`save/route.ts` にも同等の publishedAt 正規化ロジックが別実装（`:36-40`）で3つ目として存在する。RV-P2-007 の TZ 修正は**この3箇所すべてに同じ修正を入れる**必要があり、1箇所でも漏らすと不整合が残る。
- **改善案**: `lib/api-auth.ts`（認可）と `lib/format.ts` もしくは `lib/validators/news.ts`（日時正規化）へ抽出する。日時正規化はバリデーション前処理なので `parseNewsInput` の入口に取り込んでしまう案（`z.preprocess`）もあり、その場合3箇所とも消える。
- **理由**: 重複そのものより、「これから入る修正が3箇所に散る」ことが問題。RV-P2-007 の修正前に潰しておくと安全。

### [RV-P2-011] `lib/publish-status.ts` のコメントが migration 後の事実と異なる（PT2-07）

- **種別**: Maintainability
- **重要度**: Nice to Have
- **場所**: `lib/publish-status.ts:3-8` ↔ `prisma/schema.prisma:67-71`
- **現状**: schema には `UNPUBLISHED` が追加済み（`schema.prisma:70`）だが、コメントは「**現時点の Prisma schema の enum PublishStatus は DRAFT/PUBLISHED の2値のみで、`UNPUBLISHED` は Impl(P2) が schema へ追加＋migrate する前提**」のまま。回避策の理由として書かれた文章が、回避が不要になった後も残っている。加えて `news-admin.ts:49-51` の `as NewsCategoryCode` / `as PublishStatusCode` キャストは、Prisma enum とアプリ型が一致している前提に依存するが、それを保証する仕組みが無い。
- **改善案**: コメントを現状（migration 済み・アプリ型を真実源として維持する理由）に書き換え、PT2-07 が求めたコンパイル時アサーションを1つ入れる。

```ts
import type { PublishStatus } from '@prisma/client'
// Prisma enum とアプリ型の値ドリフトを型で検出する（片方だけ変更されたら type-check が落ちる）。
const _assertPublishStatusParity: PublishStatus = 'UNPUBLISHED' satisfies PublishStatusCode
type _AssertSame = PublishStatusCode extends PublishStatus
  ? PublishStatus extends PublishStatusCode ? true : never
  : never
```

- **理由**: 嘘のコメントは無いコメントより悪い。型アサーションを入れれば `toRecord` のキャストも根拠を持つ。

### [RV-P2-012] 保存失敗時にフィールド別エラーと入力内容が失われる（E-014-1 / E-014-2 の粒度）

- **種別**: Design / UX
- **重要度**: Nice to Have
- **場所**: `app/api/admin/news/save/route.ts:50-53` / `components/admin/NewsForm.tsx:60-64`
- **現状**: `parseNewsInput` はフィールド名→メッセージの `errors` を正しく返しているのに、save ハンドラはそれを**捨てて** `?error=1` にリダイレクトする。フォームは固定文言（「タイトル・本文は必須、公開する場合は公開日時が必要です」）を1つ出すだけで、どの項目が問題かは示されない。さらにリダイレクトで**入力中の本文が全て消える**（20,000文字書いた直後に公開日時未設定で全消失しうる）。functional-spec の E-014-1「必須項目です」/ E-014-2「公開日を設定してください」はフィールド単位のメッセージを想定している。
- **改善案**: 短期的には `?error=` にフィールドキー（`?error=publishedAt` 等）を載せて該当項目の近くに表示する。恒久的には、Server Action + `useActionState` で入力値とエラーを保持する形に戻すのが素直（ネイティブ form POST を選んだ理由は E2E の遷移中断対策なので、P3 の申込フォーム実装時に「重い入力フォームをどう保持するか」と併せて方針を決めるのがよい）。
- **理由**: 入力消失は管理者にとって最も痛い失敗で、CMS の実用性に直結する。ただし現状でもクライアント側の `maxLength` と `required` で大半は防げるため優先度は下げる。

### [RV-P2-013] 「下書き保存」ボタンがラジオの選択（公開）を黙って上書きする

- **種別**: Design / UX
- **重要度**: Nice to Have
- **場所**: `app/api/admin/news/save/route.ts:28-34` / `components/admin/NewsForm.tsx:102-118,148-163`
- **現状**: status は `intent === 'publish' ? 'PUBLISHED' : radio === 'UNPUBLISHED' ? 'UNPUBLISHED' : 'DRAFT'` で決まる。つまりラジオで「公開」を選んで「下書き保存」を押すと、**警告なく DRAFT に落ちる**（公開中の記事を編集して下書き保存すると非公開化される）。ラジオは実質「取り下げかどうか」しか意味を持たず、3択 UI が実態と合っていない。F-014 の画面仕様は「公開状態 select（DRAFT/PUBLISHED/UNPUBLISHED）」＋「保存ボタン」という構成である。
- **改善案**: (a) ボタンを「保存」1つにしてラジオを真実源にする（仕様に忠実）、または (b) ボタン主導を維持するならラジオを表示専用のバッジに変え、「下書きとして保存」「公開する」「公開を取り下げる」の3ボタンにする。どちらでも一貫するが、現状の「両方が status に影響し片方が勝つ」は避けたい。
- **理由**: 公開中記事の意図しない非公開化は、利用者から見て「消えた」に等しい。E2E は現在の挙動を前提に書かれているため、変更時はテストの更新も必要（＝仕様確定を伴う変更なので Nice to Have に留める）。

### [RV-P2-014] ログイン試行のレート制限が無い

- **種別**: Security（ブルートフォース）
- **重要度**: Nice to Have（P3 で対応）
- **場所**: `auth.ts:28-39` / `lib/kv.ts`（`checkRateLimit` は `throw new Error('not implemented (F-010)')` のスタブ）
- **現状**: `/api/auth/callback/credentials` への試行回数に制限が無い。`lib/kv.ts` にレート制限の抽象は用意されているが未実装で、F-010（申込フォーム）実装時に確定する計画になっている。管理者アカウントは単一で、メールアドレスが RV-P2-003 の経路で列挙可能なため、実装されればスプレー攻撃の的になる。
- **改善案**: F-010 で `checkRateLimit` を実装する際、認証エンドポイントも対象に含める（`auth:<ip>` と `auth:<email>` の二軸、例: 5回/15分）。RV-P2-004（同期 scrypt）の緩和にもなる。
- **理由**: P2 単独のブロッカーではないが、KV 実装が P3 で入るため「そのとき一緒に入れる」と決めておくと漏れない。

### [RV-P2-015] 管理一覧にページネーションが無い

- **種別**: Performance
- **重要度**: Nice to Have
- **場所**: `lib/news-admin.ts:78-88`（`listAdminNews` に `take`/`skip` 無し） / `app/admin/(app)/news/page.tsx:32`
- **現状**: 全 News を無制限に取得して1テーブルに描画する。デモ規模（seed 数件）では問題ないが、運用でお知らせが数百件になると管理画面の初期表示が重くなる。`orderBy: { updatedAt: 'desc' }` に対応する複合インデックスも無い（既存は `(status, publishedAt)` / `(category, status, publishedAt)`）。N+1 は無く、クエリ自体は1本で健全。
- **改善案**: `listAdminNews(filter?, { take = 50, skip = 0 })` を用意し、一覧に「もっと見る」または `?page=` を追加する。`@@index([updatedAt])` の追加も検討。
- **理由**: 現時点で実害は無く、F-015/F-016/F-017 の管理一覧を作る際に共通のページネーション方針を決めるほうが効率的。

---

## 再レビューの条件

**RV-P2-001 と RV-P2-002 の2件のみ**を修正すれば Approve とする（Should Fix は P3 と並行で可）。修正時に確認すること:

1. `getLatestNews` に時刻ゲートが入り、**`getLatestNews` を対象とした**未来日除外の結合テストが1本追加されていること（`listPublishedNews` のテストは既存のまま残してよい）。
2. `parseServerEnv` に production 条件の AUTH_SECRET 検証が入り、それを発火させる呼び出し導線（`instrumentation.ts` か `auth.ts` のモジュール初期化）が存在すること。単体テストで production/development の分岐が固定されていること。
3. 上記2件の修正後に `pnpm type-check` / `pnpm test:unit` / `pnpm test:integration` / `CI=1 pnpm test:e2e` を再実行し green であること。

---

## P3（入所申込フォーム）への申し送り

### P2 から引き継ぐ未解決事項
- **RV-P2-001 の再発防止**: P3 で `/news` 一覧・`/news/[id]` 詳細（F-004/F-005）を実装する際、公開クエリの述語（`status='PUBLISHED' AND publishedAt <= now()`）を**新たに書き起こさないこと**。`lib/news-admin.ts` に定数として切り出したものを共有する。現在トップの `NewsCard` は `href={/news/${n.id}}`（`app/(public)/page.tsx:111`）を出力しており **P2 時点では 404** なので、P3 で必ず解消する。
- **PT2-06 の再確認**: `/news/[id]` は本 Phase で唯一「公開側で `News.body` を HTML 描画する」経路になる。実装後に `grep -rn dangerouslySetInnerHTML app components lib` を再実行し、**`renderMarkdown` の戻り値以外が渡っていないこと**を確認すること。SEC-001 の唯一の穴はここ。
- **RV-P2-006(c) との合流点**: 公開側詳細ページはサーバーで `renderMarkdown` を呼ぶ。このサーバー描画経路ができた時点で、管理プレビューもそちらに寄せれば `lib/markdown/renderSafe.ts` に `server-only` を付けられ、クライアントバンドルからサニタイズ一式を追い出せる。P3 で一度に片付けるのが最も安い。
- **RV-P2-014（レート制限）**: P3 は `checkRateLimit` の実装 Phase（F-010）。認証エンドポイントも対象に含めること。
- **RV-P2-008（ドキュメント更新）**: functional-spec §4.10 と security-audit SEC-001 を実装の現状（rehype-raw 使用・表は不許可）に合わせる。P3 の仕様策定でどのみち両ファイルを触るので、そのついでが効率的。

### P3 で踏襲すべき P2 の良い型
- **ハンドラ層での `auth()` 再検証**（PT2-01）: 申込 API は未認証エンドポイントだが、受信管理（F-017）を作る際は P2 と同じ「middleware に依存せず各ハンドラで検証」を必ず踏襲する。`middleware.ts` の matcher が `/admin/:path*` のみで `/api/admin/*` を含まないことを忘れないこと（`lib/api-auth.ts` に抽出済みであればそれを使う）。
- **判別ユニオンのバリデータ**（`lib/validators/news.ts`）: 申込フォームは「APPLICATION / INQUIRY で必須項目が異なる」（functional-spec REV-002）という、まさに判別ユニオンが効く構造をしている。`z.discriminatedUnion('type', [...])` で `licenseRevoked` / 住所 / 写真の必須性を切り替える形が素直で、P2 と同じ `NewsInputParseResult` 相当の「例外を投げず判別可能ユニオンを返す」契約を踏襲するとハンドラ側が揃う。

### P3 特有の注意（P2 の経験から）
- **フォームの入力保持**: RV-P2-012 の通り、P2 のネイティブ form POST + リダイレクトはエラー時に入力を失う。申込フォームは**ステップ式・写真アップロード付き**で入力コストが桁違いに高く、同じ設計は採れない。Server Action + `useActionState`、あるいはクライアント側の下書き保持を前提に設計すること。ネイティブ form POST を選んだ理由（E2E で保存直後の遷移に中断されない）は、P3 では `useActionState` の pending 状態を待つ E2E の書き方で解決できる。
- **タイムゾーン**（RV-P2-007）: 申込フォームにも生年月日・希望開始月といった日時入力がある。P2 で顕在化した「datetime-local はサーバーローカル解釈」の罠を最初から避け、日時の解釈基準を Asia/Tokyo に固定するヘルパを `lib/format.ts` に用意してから実装を始めること。本番（UTC）でのみ壊れるため、テストは `TZ=UTC` で回すこと。
- **CSRF**（RV-P2-005）: 申込フォームは未認証だが、`idempotencyKey` と Turnstile による保護が前提（REV-011 / F-010）。P2 で入れる同一オリジン検証ヘルパ（`isSameOrigin`）は P3 の変更系エンドポイントでも再利用できる。
- **重い同期処理をリクエストパスに置かない**（RV-P2-004）: P2 の同期 scrypt はテスト戦略を歪めた（管理系のクロスブラウザ検証を放棄）。P3 は画像アップロード・メール送信という重い処理を扱うので、同期 API（`readFileSync` 等）を使わないこと。
