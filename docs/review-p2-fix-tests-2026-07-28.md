# P2 差し戻し修正 — 失敗テスト（red）追加レポート

> 作成: 2026-07-28 / Test Agent
> 根拠: `docs/p2-fix-plan-2026-07-28.md`（#1〜#5）, `docs/review-p2-code-2026-07-28.md`, `docs/security-audit.md` Phase 2 監査
> **本書は Impl Agent への実装仕様である。** 各項の「実装すべきシグネチャ」を満たせば red → green になる。

---

## 0. サマリー

| 区分 | 修正前 | 修正後 | 差分 |
|------|--------|--------|------|
| unit | 72 pass | 79 pass / **4 fail** ＋ **3 ファイルが収集不能**（未作成モジュールの import 解決失敗, 計 35 ケース） | +46 |
| integration | 23 pass | 23 pass / **5 fail** | +5 |
| e2e | 67 | 73（`--list` で確認。実行はしていない） | +6 |

新規テスト 57 件の内訳: env +8 / password +3 / rate-limit 15 / http-guard 9 / seed-guard 11 /
news.int +5 / admin-authz.spec +6。
**実測で red を確認したのは 44 件**（fail 9 件 ＋ 収集不能 35 件）。
e2e 6 件は未実行だが、うち 3 件（4-1 / 4-2 / 4-4）は現行実装が `Origin` を見ないため red になる見込み。
残りは「実装後も維持すべき既存の正しい挙動」を固定する回帰防止ケース（例: development で
AUTH_SECRET 未設定でも通る、同一オリジンの save/delete は従来どおり 303、production で 32 文字なら成功）。

- **既存テストの破壊はゼロ**（unit 72・integration 23・e2e 67 はすべて維持）。
- 意図的な既存更新は `tests/unit/password.test.ts` のみ（#3 の非同期化に伴う `await` 追加。既存 5 件の検証内容は保持）。
- `pnpm type-check` のエラーは**未作成モジュール 3 件の TS2307 のみ**（下表）。それ以外の型エラーは無い。

```
tests/unit/http-guard.test.ts(2,30): error TS2307: Cannot find module '@/lib/http-guard'
tests/unit/rate-limit.test.ts(6,8):  error TS2307: Cannot find module '@/lib/rate-limit'
tests/unit/seed-guard.test.ts(2,35): error TS2307: Cannot find module '@/lib/seed-guard'
```

### Impl Agent が新規作成するモジュール

| モジュール | 目的 | 対応項目 |
|-----------|------|---------|
| `lib/rate-limit.ts` | 汎用レート制限基盤（P3 で再利用） | #3 |
| `lib/http-guard.ts` | 同一オリジン検証（CSRF, P3 で再利用） | #4 |
| `lib/seed-guard.ts` | seed の本番ガード + 資格情報 fail-fast | #5 |

### Impl Agent が変更する既存モジュール

`lib/queries.ts`(#1) / `lib/env.ts`(#2) / `lib/password.ts`(#3) / `auth.ts`(#3) /
`app/api/admin/news/save/route.ts`(#4) / `app/api/admin/news/delete/route.ts`(#4) / `prisma/seed.ts`(#5)

---

## 1. RV-P2-001 / SEC-010 — 公開クエリの時刻ゲート（本番経路）

| 項目 | 内容 |
|------|------|
| テストファイル:行 | `tests/integration/news.int.ts:65-171`（describe `PT2-04`） |
| テスト対象 | **`lib/queries.ts` の `getLatestNews`**（`app/(public)/page.tsx:36` が呼ぶ本番経路） |
| 検証する契約 | `getLatestNews(take = 3)` は `status='PUBLISHED'` **かつ `publishedAt <= now()`** の行のみを `publishedAt` 降順で最大 take 件返す。`publishedAt = null` の PUBLISHED は返さない |
| red である理由 | `lib/queries.ts:40-44` の where 句が `{ status: 'PUBLISHED' }` のみで時刻ゲートが無い。5 件すべてが「除外されるはずの行が返る」で fail |

### 個別ケースと期待するエラー

| # | テスト | 現在の失敗内容（実測） |
|---|--------|----------------------|
| 1-1 | 未来日 `publishedAt` は含まれない | `expected [...] to not include '<futureId>'` |
| 1-2 | `publishedAt = null` は含まれない | `expected [...] to not include '<nullId>'` |
| 1-3 | 過去日は含まれ take=3 の先頭に来る | `expected '<nullId>' to be '<pastId>'` — **null 行が実際に先頭を占有していることが実測で確認できた** |
| 1-4 | take=3 に未来日・null が混入しない | `expected [...] to not include '<futureId>'` |
| 1-5 | 全行 publishedAt 非null かつ `<= now`、降順 | `expected null not to be null` |

### 実装すべき内容

```ts
// lib/queries.ts
export async function getLatestNews(take = 3) {
  return prisma.news.findMany({
    where: { status: 'PUBLISHED', publishedAt: { lte: new Date() } },
    orderBy: { publishedAt: 'desc' },
    take,
  })
}
```

**推奨（SEC-010 修正方針1 / RV-P2-001 再発防止）**: 述語 `status='PUBLISHED' AND publishedAt <= now()` を
`lib/news-admin.ts` に定数（例 `PUBLISHED_NEWS_WHERE`）として切り出し、`getLatestNews` と
`listPublishedNews` の**両方がそれを共有**する。二重実装が今回の差し戻しの原因であり、P3 の
`/news` 一覧・`/news/[id]` 詳細（F-004/F-005）でも同じ述語を書き起こさないこと。

### テスト基盤の変更（レビュー時に確認されたい）

`lib/queries.ts` は `import 'server-only'` を持ち、`server-only` は `react-server` 条件でのみ
空モジュールに解決される。vitest の node 環境では import 時に throw するため、結合テストから
本番経路を検証できなかった（これも「テスト対象取り違え」が起きた構造的要因である）。

- 追加: `tests/integration/stubs/server-only.ts`（空モジュール）
- 変更: `vitest.integration.config.ts` に `'server-only'` の alias を追加

差し替えは**結合テスト実行時のみ**。Next.js のビルドは `react-server` 条件で解決するため、
「クライアント誤 import をビルドエラー化する」防御（REV-103）は本番経路で維持される。

### データ規律

3 行（未来日 / null / 直近）を describe の `beforeAll` で作成し `afterAll` で削除。
`SEED_COUNTS.news.published = 6` を前提とする既存アサーションを壊さないよう、
**describe をファイル末尾に配置**して作成タイミングを既存テストより後にしている。
実行後に dev DB を確認済み（残存行 0 / published=6 / total=7）。

---

## 2. RV-P2-002 / SEC-013 — AUTH_SECRET の本番強度検証

| 項目 | 内容 |
|------|------|
| テストファイル:行 | `tests/unit/env.test.ts:31-108`（describe `SEC-013`） |
| テスト対象 | `lib/env.ts` の `parseServerEnv(source)` |
| red である理由 | `lib/env.ts:25` が `AUTH_SECRET: z.string().min(1).optional()` のままで、本番判定も長さ下限も無い。「throw するはずが throw しない」で 2 件 fail |

### 個別ケース

| # | 入力 | 期待 | 現状 |
|---|------|------|------|
| 2-1 | `{ NODE_ENV: 'production' }` | throw `/AUTH_SECRET/` | **red**: `expected [Function] to throw an error` |
| 2-2 | `{ NODE_ENV: 'production', AUTH_SECRET: '' }` | throw `/AUTH_SECRET/` | green（`.min(1)` が既に効く。契約として維持） |
| 2-3 | `{ NODE_ENV: 'production', AUTH_SECRET: 'A'.repeat(31) }` | throw `/AUTH_SECRET/` | **red**: `expected [Function] to throw an error` |
| 2-4 | `{ NODE_ENV: 'production', AUTH_SECRET: 'A'.repeat(32) }` | 成功（境界値） | green |
| 2-5 | production + base64 44文字 | 成功 | green |
| 2-6 | `{ NODE_ENV: 'development' }` | throw しない | green（維持すべき） |
| 2-7 | development + 短い値 | throw しない | green（維持すべき） |
| 2-8 | `NODE_ENV` 未指定 / `{}` | throw しない | green（維持すべき） |

### 実装すべき内容

**重要な設計制約**: 本番判定は **`source` 引数の `NODE_ENV`** を見ること（`process.env.NODE_ENV` を
モジュールトップで直接読まない）。理由は 2 つ。

1. `parseServerEnv` を純関数のまま保つ（`process.env` の差し替え・モジュールキャッシュのリセットが不要）。
2. `getServerEnv()` は `process.env` をそのまま渡すため、本番挙動は変わらない。

```ts
// lib/env.ts
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),   // ← 追加（zod は未定義キーを strip するため明示が必要）
    // ... 既存キー。AUTH_SECRET は z.string().min(1).optional() のまま
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return
    if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SECRET'],
        message: 'AUTH_SECRET は本番環境では 32 文字以上が必要です（openssl rand -base64 32）',
      })
    }
  })
```

- エラーメッセージに文字列 `AUTH_SECRET` を含めること（テストが `toThrow(/AUTH_SECRET/)` で照合。
  `path: ['AUTH_SECRET']` を設定すれば zod のエラー文字列に含まれる）。
- `.superRefine` を付けると型が `ZodEffects` になる。既存テスト `serverEnvSchema.parse({})` /
  `serverEnvSchema.safeParse({ POSTGRES_URL: 'not-a-url' })` は `ZodEffects` でもそのまま動くため影響なし。
- **SEC-013 修正方針2 も必須**: 現状 `getServerEnv()` は呼び出し元が無く、スキーマを厳しくしても
  発火しない。`auth.ts`（Node ランタイムの入口）の import 時に 1 度評価すること。
  `middleware.ts` は Edge のため対象外。

---

## 3. SEC-009 / RV-P2-004 — レート制限基盤 + scrypt 非同期化

### 3-a. `lib/rate-limit.ts`（新規・汎用基盤）

| 項目 | 内容 |
|------|------|
| テストファイル:行 | `tests/unit/rate-limit.test.ts`（全 15 ケース） |
| red である理由 | モジュール未作成。`Cannot find module '@/lib/rate-limit'` でスイート全体が収集失敗 |

#### `lib/kv.ts` ではなく新規モジュールにした判断理由

`lib/kv.ts` の `checkRateLimit(key, limit, windowSeconds)` は throw するだけのプレースホルダで、
**KV(Upstash) 実装とカウント判定ロジックが 1 関数に密結合**した形をしている。この形だと
(a) 単体テストに KV 接続が必要になり、(b) 時刻を注入できないためウィンドウ経過の検証が
実時間 sleep になる（タスク指示「実時間 sleep をしないこと」に反する）。

そこで **判定ロジック（純粋・時刻注入可能）** と **永続化（`RateLimitStore`）** を分離した
`lib/rate-limit.ts` を真実源とし、`lib/kv.ts` は将来 `RateLimitStore` の KV 実装
（`createKvRateLimitStore()`）として書き直す方針とする。既定 store はインメモリで、
単一インスタンス（dev / E2E / デモ）ではそのまま機能する。
Store 差し替えテスト（`tests/unit/rate-limit.test.ts` の describe「Store 差し替え」）が
この分離を強制している。

#### 実装すべきシグネチャ

```ts
// lib/rate-limit.ts
export interface RateLimitEntry {
  count: number
  resetAt: number          // epoch ms
}

export interface RateLimitStore {
  get(key: string): Promise<RateLimitEntry | null>
  set(key: string, entry: RateLimitEntry): Promise<void>
  delete(key: string): Promise<void>
}

export interface RateLimitResult {
  success: boolean
  limit: number
  remaining: number        // 残り許可回数。0 未満にはしない
  resetAt: number          // epoch ms。ウィンドウが解放される時刻
  retryAfterMs: number     // resetAt - now。success 時は 0
}

export interface RateLimiterConfig {
  limit: number
  windowMs: number
  store?: RateLimitStore   // 省略時はインスタンスごとに新しいインメモリ store
}

export interface RateLimiter {
  consume(key: string, now?: number): Promise<RateLimitResult>  // カウント +1 して判定
  peek(key: string, now?: number): Promise<RateLimitResult>     // カウントを増やさず確認
  reset(key: string): Promise<void>
}

export function createRateLimiter(config: RateLimiterConfig): RateLimiter
```

#### 契約の詳細（テストが固定している挙動）

| 契約 | 詳細 |
|------|------|
| 上限判定 | `limit` 回目までは `success=true`、`limit+1` 回目から `false` |
| `remaining` | `limit` から 1 ずつ減り、0 未満にならない |
| ウィンドウ起点 | **最初の試行時刻**。`resetAt = 最初の試行 + windowMs`（固定ウィンドウ） |
| ウィンドウ境界 | `now = resetAt - 1` はまだ拒否、`now = resetAt` で新ウィンドウ開始。新ウィンドウの `resetAt` は `旧resetAt + windowMs` |
| 拒否時 | `retryAfterMs = resetAt - now`（> 0）。許可時は `retryAfterMs = 0` |
| キー独立性 | 異なる key は完全に独立してカウント |
| インスタンス独立性 | `store` 未指定の `createRateLimiter` は**毎回新しいインメモリ store** を持つ（テスト間汚染を防ぐ）。アプリ側はモジュールスコープで 1 インスタンスを共有すること |
| `peek` | カウントを増やさない。未使用キーは `success=true, remaining=limit` |
| `now` 省略時 | `Date.now()` を使う |

#### `auth.ts` での適用（SEC-009 修正方針1）

`peek` と `consume` を分けている理由は、ログインが 2 相の運用を要求するため:

1. `authorize` 冒頭で IP 軸・アカウント軸を **`peek`** し、いずれかが上限超過なら
   **資格情報を検証せず一律 `null`**（列挙耐性を維持。scrypt も走らせないので DoS 緩和にもなる）。
2. 認証**失敗**時にアカウント軸を `consume`（「5 回**失敗**で 15 分ロック」を満たす）。
   IP 軸は試行のたびに `consume` する。

目安の閾値（security-audit.md SEC-009）: IP あたり 10 回/10 分、アカウントあたり 5 回失敗/15 分。
失敗ログは IP・時刻・試行回数のみ（**パスワードとメールアドレス全文は記録しない**）。

### 3-b. `lib/password.ts` の非同期化

| 項目 | 内容 |
|------|------|
| テストファイル:行 | `tests/unit/password.test.ts:32-44`（新規 describe `SEC-009: 非同期契約`）＋ 既存 5 件を `await` 形式に更新 |
| red である理由 | 現在は同期関数。`expected 'scrypt$…' to be an instance of Promise` / `expected true to be an instance of Promise` で 2 件 fail |

```ts
// lib/password.ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, k: number) => Promise<Buffer>

export async function hashPassword(plain: string): Promise<string>
export async function verifyPassword(plain: string, stored: string): Promise<boolean>
```

- 形式は `scrypt$<saltHex>$<hashHex>` のまま（salt 16 バイト / keylen 64 バイト）。seed 互換を維持。
- **`timingSafeEqual` による定数時間比較を維持**すること。
- **形式不正・パース不能・長さ不一致は throw せず `false`** を維持（E-012-1 の汎用失敗）。
- 呼び出し元 `auth.ts:36` を `if (!(await verifyPassword(...))) return null` に更新。
- 同期版（`verifyPasswordSync` 等）は**残さなくてよい**。テストは非同期契約のみを固定しており、
  同期版を残すと `authorize` が誤って同期版を呼ぶ余地が残る。
- RV-P2-003（authorize のタイミング差）を同時に直す場合は、`ok` を先に評価し切ってから
  短絡させる構造にすること（`&&` の早期脱出では意味が無い。review 文書 :175 参照）。

---

## 4. SEC-011 / RV-P2-005 — CSRF（Origin 検証）

### 4-a. `lib/http-guard.ts`（新規・ユニット）

| 項目 | 内容 |
|------|------|
| テストファイル:行 | `tests/unit/http-guard.test.ts`（全 9 ケース） |
| red である理由 | モジュール未作成。`Cannot find module '@/lib/http-guard'` |

```ts
// lib/http-guard.ts
/** 変更系ハンドラの CSRF 防御: 同一オリジンからの送信のみ受理する（Cookie の SameSite に依存しない）。 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false // クロスサイトのネイティブ form POST は Origin を必ず送る（fail-closed）
  return origin === new URL(request.url).origin
}
```

固定している挙動: 同一オリジン → true / 別ホスト・**サブドメイン違い**・スキーム違い・ポート違い →
false / `Origin` 欠落 → false / `Origin: 'null'`（sandbox iframe）→ false。
サブドメイン違いを false にするのが要点で、`SameSite=Lax` は同一サイト扱いで Cookie を送るため、
サブドメインに XSS や任意コンテンツが置かれた場合の経路を塞ぐ。

**このヘルパは P3 の変更系エンドポイント（申込・アップロード・チャット）でも再利用する**
（security-audit.md「P3 着手前の必須前提 B」）。

### 4-b. エンドポイントの応答契約（E2E）

| 項目 | 内容 |
|------|------|
| テストファイル | `tests/e2e/playwright/admin-authz.spec.ts`（describe `PT2-05`, 6 ケース追加） |
| 契約元追加 | `tests/e2e/pages/admin-contract.ts` に `ADMIN_API.newsSave` / `ADMIN_API.newsDelete` |
| red である理由 | 両ハンドラが `Origin` を一切見ないため、クロスオリジンでも 303 が返り**処理が実行される**。`expected 403 … got 303` で fail する見込み |

| # | ケース | 期待 |
|---|--------|------|
| 4-1 | 認証済み × 不正 Origin × `save` | **403**、かつ記事が作成されていない（Prisma で確認） |
| 4-2 | 認証済み × Origin 欠落 × `save` | **403**（fail-closed） |
| 4-3 | 認証済み × 同一 Origin × `save` | 303 + `Location: /admin/news`、記事が作成される |
| 4-4 | 認証済み × 不正 Origin × `delete` | **403**、かつ記事が削除されていない |
| 4-5 | 認証済み × 同一 Origin × `delete` | 303、記事が削除される |
| 4-6 | 未認証 × `save` / `delete` | 303 または 403（既存契約を変えないことの確認。どちらでも可） |

```ts
// save/route.ts, delete/route.ts の冒頭（auth() チェックの前後どちらでも可）
if (!isSameOrigin(request)) {
  return NextResponse.json({ error: 'forbidden' }, { status: 403 })
}
```

**既存 E2E を壊さない根拠**: 同一オリジンのブラウザ送信では `Origin` が常に付与されるため、
管理UI のネイティブ form POST（`NewsForm.tsx` / `ConfirmDialog.tsx`）は影響を受けない。
`pnpm exec playwright test --list` で **67 → 73 件**（既存 67 件は名前・件数とも不変）を確認済み。

**併せて実施（SEC-011 修正方針3）**: `auth.config.ts` で
`cookies.sessionToken.options.sameSite = 'lax'` を**明示指定**し、ライブラリ既定値への暗黙依存を
コード上の意思決定に変える。

#### テスト実装上の注意（レビュー時の確認点）

- `page.request` はブラウザコンテキストの Cookie を共有するため、UI ログイン後にそのまま
  認証済みリクエストを送れる。
- `maxRedirects: 0` を指定して 303 を追跡しない（追跡すると最終的な 200 に化けて判定できない）。
- `APIRequestContext` は `Origin` を自動付与しないため、同一オリジン側も明示的に付けている。
- HTTP ステータスだけを信用せず、**Prisma で DB の実状態を確認**している
  （403 を返しつつ実は処理済み、という実装ミスを検出するため）。
- データ衛生: 全タイトルに `【E2E-CSRF】` 接頭辞を付け、file-level `afterAll` で削除。
  既存 `admin-news.spec.ts` の `【E2E` 接頭辞回収とも整合する。

**E2E は未実行**（タスク指示どおり）。構文・型・テスト収集のみ確認済み。

---

## 5. SEC-012 — seed の本番ガード

| 項目 | 内容 |
|------|------|
| テストファイル:行 | `tests/unit/seed-guard.test.ts`（全 11 ケース） |
| red である理由 | モジュール未作成。`Cannot find module '@/lib/seed-guard'` |

```ts
// lib/seed-guard.ts
export interface SeedEnvSource {
  NODE_ENV?: string
  ADMIN_EMAIL?: string
  ADMIN_NAME?: string
  ADMIN_PASSWORD?: string
  ALLOW_PROD_SEED?: string
}

export interface SeedCredentials {
  email: string
  name: string
  password: string
}

/** seed 実行の可否を判定し、管理者資格情報を返す。不可なら throw（fail-fast）。 */
export function assertSeedAllowed(env: SeedEnvSource): SeedCredentials
```

### 契約

| 条件 | 期待 | エラーメッセージに含める語 |
|------|------|--------------------------|
| `NODE_ENV='production'` かつ `ALLOW_PROD_SEED` 未設定 | throw | `production` または `本番` |
| `NODE_ENV='production'` かつ `ALLOW_PROD_SEED` が `'1'` 以外 | throw | 同上 |
| `NODE_ENV='production'` + `ALLOW_PROD_SEED='1'` + `ADMIN_PASSWORD` 未設定 | throw | `ADMIN_PASSWORD` |
| `NODE_ENV='production'` + `ALLOW_PROD_SEED='1'` + 資格情報あり | `{ email, name, password }` を返す | — |
| `ADMIN_EMAIL` 未設定（環境問わず） | throw | `ADMIN_EMAIL` |
| `ADMIN_PASSWORD` 未設定 / 空文字（環境問わず） | throw | `ADMIN_PASSWORD` |
| development / `NODE_ENV` 未指定 + 資格情報あり | 資格情報を返す | — |
| `ADMIN_NAME` のみ未設定 | 既定の表示名で通る（秘密ではないため） | — |

### 「development では通る」の解釈（要確認・判断理由）

タスク指示の「development では通る」は **production ガードに引っかからない**という意味に解した。
SEC-012 修正方針1（ハードコードフォールバック廃止・未設定なら throw）は**環境を問わず**適用しないと
欠陥が残る（`.env` を読み損ねたローカルやデモ環境がそのまま既知パスワードで seed される）ため、
development でも資格情報未設定なら throw する契約とした。

ローカルの `.env` は `ADMIN_EMAIL` / `ADMIN_PASSWORD` を設定済みのため、`pnpm db:seed` は
従来どおり動作する（開発体験を壊さない）。

回帰防止として「未設定時に既知のデモ資格情報を返さない」ことを直接検証するケースを入れてある。

### `prisma/seed.ts` 側の実装

1. `const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@iwataki-driving-school.demo'` 等
   **3 行のフォールバックを削除**（`prisma/seed.ts:507-509`）。
2. `main()` の冒頭 —— `deleteMany()` の**前** —— で `const creds = assertSeedAllowed(process.env)` を呼ぶ。
3. `prisma.adminUser.upsert` の **`update` 節から `passwordHash` を外す**（SEC-012 修正方針3）。
   既存管理者のパスワードを黙って上書きしないため。ローテーションは別コマンドに分離する。
4. `.env.example:25` の `ADMIN_PASSWORD` 行に「本番不可・推測困難な値を必須」を追記（修正方針4）。

> `lib/seed-guard.ts` は `prisma/seed.ts`（tsx 実行・`@/` エイリアス無し）から import される点に注意。
> seed からは相対パス（`../lib/seed-guard`）で読むこと。テスト側は `@/lib/seed-guard` で解決する。

---

## 6. 追加/変更したファイル一覧

| ファイル | 種別 |
|---------|------|
| `tests/integration/news.int.ts` | 変更（`PT2-04` describe 追加, +5） |
| `tests/integration/stubs/server-only.ts` | 新規（テスト基盤） |
| `vitest.integration.config.ts` | 変更（`server-only` alias 追加） |
| `tests/unit/env.test.ts` | 変更（`SEC-013` describe 追加, +8） |
| `tests/unit/rate-limit.test.ts` | 新規（15 ケース） |
| `tests/unit/password.test.ts` | 変更（非同期契約 +3 / 既存 5 件を await 形式へ） |
| `tests/unit/http-guard.test.ts` | 新規（9 ケース） |
| `tests/unit/seed-guard.test.ts` | 新規（11 ケース） |
| `tests/e2e/playwright/admin-authz.spec.ts` | 変更（`PT2-05` describe 追加, +6） |
| `tests/e2e/pages/admin-contract.ts` | 変更（`ADMIN_API.newsSave` / `newsDelete` 追加） |

**実装コード（`app/`, `lib/`, `auth.ts`, `prisma/seed.ts`）は一切変更していない。**

## 7. green 判定の基準

```bash
pnpm type-check        # TS2307 3件が解消し、エラー 0
pnpm test:unit         # 全 pass（既存 72 + 新規）
pnpm test:integration  # 全 pass（既存 23 + 新規 5 = 28）
CI=1 pnpm test:e2e     # 全 pass（73 件）
```

実行後は dev DB の不変条件を確認すること（`News.status='PUBLISHED'` の件数 = 6 / 総数 = 7、
`【テスト` `【E2E` 接頭辞の残存行 0）。本レポート作成時点では確認済み。
