# P2 差し戻し修正 — 実装ノート（red → green）

> 作成: 2026-07-28 / Impl Agent
> 入力: `docs/p2-fix-plan-2026-07-28.md`（#1〜#5）, `docs/review-p2-fix-tests-2026-07-28.md`（テスト契約＝実装仕様）,
> `docs/review-p2-code-2026-07-28.md`（RV-P2-001/002/003/004/005）, `docs/security-audit.md`（SEC-009〜013）

---

## 0. 終了条件の実測結果

すべて実際にコマンドを実行して得た値。推測値は含まない。

| # | コマンド | 結果 | 備考 |
|---|---------|------|------|
| 1 | `pnpm test:unit` | **118 passed / 0 failed**（13 files） | 修正前 72。新規 46 件が green 化 |
| 2 | `pnpm test:integration` | **28 passed / 0 failed**（5 files） | 修正前 23。PT2-04 の 5 件が green 化 |
| 3 | `pnpm type-check` | **エラー 0**（出力なし） | TS2307 3件（未作成モジュール）が解消 |
| 4 | `pnpm lint` | **✔ No ESLint warnings or errors** | — |
| 5 | `pnpm build` | **exit 0** | 全ルートが `ƒ (Dynamic)` のまま。force-dynamic 方針は不変 |
| 6 | `CI=1 pnpm test:e2e` | **73 passed / 0 failed（1.0m）** | prebuilt(`next start`)。**リトライ 0・flaky 0** |

既存テストの退行なし（72 → 118、23 → 28 はいずれも純増）。
実行後の dev DB 不変条件も確認済み: `total=7 / published=6 / leftover=0`（`【E2E` `【テスト` 接頭辞の残存行なし）。

E2E は実行前に `pkill -9 -f ms-playwright; pkill -9 -f 'next start'; pkill -9 -f 'next-server'` と
`pnpm build` を先行させ、`CI=1`（prebuilt）で**一度だけ**実行した。終了後も同じ pkill で掃除済み。

---

## 1. RV-P2-001 / SEC-010 — 公開クエリの時刻ゲート（本番経路）

### 実装

新規 `lib/news-visibility.ts` を**述語の単一の真実源**とし、`lib/queries.ts` の `getLatestNews` と
`lib/news-admin.ts` の `listPublishedNews` の両方がそれを使う。

```ts
export function publishedNewsWhere(now: Date = new Date()): Prisma.NewsWhereInput {
  return { status: 'PUBLISHED', publishedAt: { lte: now } }
}
export const PUBLISHED_NEWS_ORDER_BY = { publishedAt: 'desc' } as const satisfies Prisma.NewsOrderByWithRelationInput
```

### 設計判断と理由

- **`lib/news-admin.ts` から export せず、新規モジュールに切り出した。**
  テストレポートの推奨は「`lib/news-admin.ts` に定数として置く」だったが、それだと**公開経路
  （`lib/queries.ts`）が管理モジュールに依存する**向きの依存が生まれる。P3 で `/news` 一覧・詳細を
  作るときに公開側が管理側を import し続ける形は避けたい。タスク指示が明示的に許容していた
  「共通モジュールに置く」を採った。`lib/news-visibility.ts` は Prisma の**型のみ**を import する
  軽量モジュールで、`server-only` を持たないため `lib/queries.ts`（server-only 付き）からも
  `lib/news-admin.ts`（結合テストが Node 環境で import）からも安全に読める。**モジュール境界は壊れない。**
- **定数ではなく関数にした。** `const PUBLISHED_NEWS_WHERE = { ..., publishedAt: { lte: new Date() } }`
  と定数化すると `new Date()` がモジュール評価時に一度だけ固定され、長寿命プロセス（`next start`）で
  時刻ゲートが凍りつく。予約公開が永久に出ない／古い基準時刻で漏れる、というより悪い欠陥に化ける。
  呼び出しごとに現在時刻で評価されることを型で強制するため関数にしている。
- `orderBy` も共有した。P3 で「where は共有したが order は書き起こした」形の再分岐を防ぐため。

### 効果
PT2-04 の 5 件（未来日除外 / null 除外 / 過去日が先頭 / take=3 に混入なし / 全行 `publishedAt <= now` 降順）が green。

---

## 2. RV-P2-002 / SEC-013 — 本番 AUTH_SECRET の強度検証

### 実装
`lib/env.ts` に `NODE_ENV` を明示宣言（zod は未定義キーを strip するため必須）し、`superRefine` で
**source 引数の `NODE_ENV`** を見て本番のみ 32 文字下限を課す。`parseServerEnv` は純関数のまま。

さらに **SEC-013 修正方針2**（スキーマを厳しくしても呼ばれなければ意味がない）に対応し、
`auth.ts`（Node ランタイムの入口）のモジュールトップで `getServerEnv()` を 1 度だけ評価する。
`middleware.ts` は Edge のため対象外。

### 実証（推測ではなく実測）
`AUTH_SECRET=short pnpm build` を実行し、ビルド中に以下が発火することを確認した。

```
Error [ZodError]: [ "AUTH_SECRET" ...
  "message": "AUTH_SECRET は本番環境では 32 文字以上が必要です（openssl rand -base64 32）"
```

つまり fail-fast は「スキーマ上そうなっている」だけでなく、**アプリの起動経路で実際に発火する**。

### 副作用として必要だった `.env` の更新（要レビュー確認点）

ローカル `.env` の `AUTH_SECRET` は `"dev-only-secret-change-me"`（25文字）だった。
**E2E は `next start`（NODE_ENV=production）で回る**ため、この値のままでは新しい検証に引っかかり
ビルドもログインも全滅する。したがって `.env` のダミー値を 41 文字に伸ばした
（`dev-only-secret-change-me-0123456789abcdef`。開発用ダミーであることが読めば分かる値のまま）。

- `.env` は `.gitignore` 済み（コミットされない）。実運用の秘密ではない。
- `.env.example` にも「本番は 32文字以上が必須。未設定/短い値は起動時に検証エラー（SEC-013）」を追記。
- **これは仕様が正しく機能した結果であって回避策ではない**（弱い署名鍵で production を起動できない、
  という要求どおりの挙動）。ただしローカル環境ファイルへの変更なので明示的に申し送る。

---

## 3. SEC-009 / RV-P2-004（＋ RV-P2-003）— レート制限基盤と scrypt 非同期化

### 3-a. `lib/rate-limit.ts`（新規・汎用基盤）

契約どおり `createRateLimiter({ limit, windowMs, store? })` → `consume` / `peek` / `reset`。
固定ウィンドウ、起点は最初の試行時刻、時刻は `now` 引数で注入可能（既定 `Date.now()`）。

**P3 での再利用を壊さないための設計:**

- **判定ロジック（純粋）と永続化（`RateLimitStore`）を分離**した。`RateLimitStore` は
  `get/set/delete` の 3 メソッドだけの最小インターフェース。既定はインメモリ
  （`createMemoryRateLimitStore()`）で、単一インスタンス（dev / E2E / デモ）ではそのまま機能する。
- 本番（Vercel KV / Upstash, `docs/tech-stack.md`）へは **`store` に KV 実装を注入するだけ**で
  差し替わる。`lib/rate-limit.ts` も呼び出し側（`auth.ts`）も変更不要。
  → P3 の申込 / 画像アップロード / チャットは `createRateLimiter` をそのまま使える。**作り直しにならない。**
- `lib/kv.ts` の `checkRateLimit` は**手を付けていない**（スコープ外）。将来は
  `createKvRateLimitStore(): RateLimitStore` として書き直す方針。判定ロジックと KV 実装が
  1 関数に密結合した現状の形は、単体テストに KV 接続を要求し時刻注入もできないため採用しなかった。

**細部の判断:**
- 上限到達後の `consume` は**カウントを進めない**（攻撃時の store 書き込み増幅を避ける）。
  `remaining` は 0 で頭打ちなので契約上の差は無い。
- `peek` は「次の `consume` が通るか」を答える（`count < limit`）。`remaining` は
  `limit - count` で consume と同じ式。この定義でないと「上限ちょうどのとき peek が true を返す」
  というオフバイワンが入り、ゲートとして機能しなくなる。

### 3-b. `lib/password.ts` の非同期化

`scryptSync` → `promisify(scrypt)`。同期版は**残していない**（`authorize` が誤って同期版を呼ぶ
余地を消すため。テストも非同期契約のみを固定している）。

**退行させていないこと（PT2-05 で解決済みと判定された性質を全て保持）:**
- `timingSafeEqual` による定数時間比較 — 保持
- 長さ事前チェック（`expected.length !== SCRYPT_KEYLEN` / `actual.length !== expected.length`）— 保持
- hex 妥当性検証（`Buffer.from` の黙示切り詰め対策の正規表現）— 保持
- 形式不正・パース不能で throw せず `false` — 保持（`await` を try 内に置いている）
- 形式 `scrypt$<saltHex>$<hashHex>`、salt 16B / keylen 64B — 保持（seed 互換）

### 3-c. `auth.ts` の 2 軸レート制限

```
IP 軸      : 10 回 / 10 分（試行のたびに consume、認証成功で reset）
アカウント軸: 5 回失敗 / 15 分（失敗時のみ consume、認証成功で reset）
```

**「成功でリセット」を入れた理由（重要な設計判断）。** security-audit.md SEC-009 の目安は
「IP あたり 10回/10分」だが、これを素直に「全試行を数え、成功しても解放しない」と実装すると
**E2E が確実に壊れる**（`admin-authz.spec.ts` の beforeEach だけで 5 回、`admin-news.spec.ts` /
`admin-auth.spec.ts` を合わせると 10 分あたり 10 回を超える正当なログインが同一 IP から走る）。
成功時リセットは、

- 攻撃者（＝成功しない）にとっては閾値がそのまま 10回/10分 で効く
- 正当な利用者（＝成功する）は一度も上限に触れない

という非対称性を作るので、**閾値を緩めずに誤検知だけを消せる**。実測でも E2E 73 件がリトライ 0 で通り、
失敗ログ（`ipAttempts=1 accountFailures=1`）が意図どおり 1 回だけ記録された。

**2 相運用（peek → consume）:**
1. `authorize` 冒頭で IP 軸・アカウント軸を `peek`。いずれかが上限超過なら**資格情報を検証せず一律 `null`**。
   列挙耐性を維持し、同時に scrypt を走らせないので CPU DoS の緩和にもなる。
2. IP 軸は試行のたびに `consume`。アカウント軸は**認証失敗時のみ** `consume`（「5回失敗で15分ロック」）。

**ログ**: IP・時刻・試行回数のみ。**パスワードとメールアドレス全文は記録しない**（SEC-009 修正方針3）。
アカウント軸のキーは `email.trim().toLowerCase()` で正規化（大文字小文字違いでの制限回避を防ぐ）。

### 3-d. RV-P2-003（authorize のタイミング差）— ついでに対応

タスク指示の許可範囲内で同時対応した。ユーザー不在／`passwordHash` 無しでもダミーハッシュに対して
同一コストの検証を実行し、`ok` を**先に評価し切ってから**判定する（`&&` の早期脱出では意味が無い）。

```ts
const stored = user?.passwordHash ?? (await getDummyHash())
const ok = await verifyPassword(password, stored)
if (!user?.passwordHash || !ok) { ... return null }
```

`hashPassword` が非同期になったためダミーハッシュはモジュールトップで同期生成できない。
Promise を遅延生成してキャッシュする形にした（生成は 1 回のみ）。

---

## 4. SEC-011 / RV-P2-005 — CSRF（Origin 検証）

### 実装
`lib/http-guard.ts` の `isSameOrigin(request)` を新規作成し、`save` / `delete` 両ハンドラの
**先頭**（`auth()` より前）に置いた。安価かつ fail-closed で、未認証×クロスオリジンでも
資格情報検証に入る前に弾ける。E2E 4-6 は「303 / 403 のどちらでも可」なので既存契約も壊さない。

`Origin` 欠落・`Origin: 'null'`・サブドメイン違い・スキーム違い・ポート違いはすべて `false`。
`new URL(request.url)` が万一 throw する場合も拒否側に倒している。

**P3 での再利用**: 申込・アップロード・チャットの変更系エンドポイントで同じヘルパを使う
（security-audit.md「P3 着手前の必須前提 B」）。

### 併せて実施（SEC-011 修正方針3）と、そこで避けた地雷

`auth.config.ts` に `cookies.sessionToken` を明示し `sameSite: 'lax'` をコード上の意思決定にした。

**`secure` と Cookie 名を `NODE_ENV` で決めなかった理由（要レビュー確認点）。**
素直に `NODE_ENV === 'production'` で `__Secure-authjs.session-token` + `secure: true` にすると、
**`next start`（NODE_ENV=production）を `http://localhost:3000` で回す E2E / ローカル検証で
ブラウザが `__Secure-` 接頭辞の Cookie を拒否し、ログインが一切通らなくなる。**
そこで Auth.js 本来の判定（配信 URL が https か）を踏襲する形にした。

```ts
const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL
const useSecureCookies = authUrl ? authUrl.startsWith('https://') : process.env.NODE_ENV === 'production'
```

URL ヒントが全く無い場合は production なら secure 側に倒す（安全側の既定）。
E2E 73 件が通っていることで、この判定がログイン経路を壊していないことを実測で確認済み。

---

## 5. SEC-012 — seed の本番ガード

### 実装
`lib/seed-guard.ts` の `assertSeedAllowed(env)` を新規作成。`prisma/seed.ts` は
`main()` 冒頭 —— `deleteMany()` の**前** —— でこれを呼び、戻り値の資格情報を使う。

1. `process.env.ADMIN_* ?? '既知の値'` の**フォールバック 3 行を削除**（旧 `prisma/seed.ts:507-509`）。
2. `upsert` の **`update` 節から `passwordHash` を外した**（修正方針3）。既存管理者のパスワードを
   seed の再実行で黙って `.env` の値へ降格させないため。ローテーションは別コマンドに分離する。
3. `.env.example` の `ADMIN_PASSWORD` 行に必須・推測困難・本番不可の注記を追記（修正方針4）。
4. seed は tsx 実行で `@/` を解決しないため相対パス `../lib/seed-guard` で import。

### 実証（実測）

| 実行 | 結果 |
|------|------|
| `NODE_ENV=production pnpm db:seed` | `Error: seed-guard: NODE_ENV=production では seed を実行できません…` で停止（deleteMany に到達しない） |
| `ADMIN_PASSWORD= pnpm db:seed` | `Error: seed-guard: ADMIN_PASSWORD が未設定です…` で停止 |
| `pnpm db:seed`（通常） | 成功（Course 17 / Faq 11 / News 7 / ChatRule 5 / AdminUser 1） |

「development では通る」の解釈はテストレポートの判断（＝ production ガードに引っかからない、の意。
資格情報 fail-fast は環境を問わず適用）をそのまま採用した。ローカル `.env` は設定済みのため
`pnpm db:seed` は従来どおり動く。

---

## 6. テストファイルへの変更

**変更していない。** テストが表現する契約を実装側で満たした。
テスト側の明白な誤り（構文・契約の自己矛盾）も発見しなかったため、最小限修正の発動もなし。

---

## 7. 変更ファイル一覧

| ファイル | 種別 | 対応 |
|---------|------|------|
| `lib/news-visibility.ts` | 新規 | #1 |
| `lib/rate-limit.ts` | 新規 | #3 |
| `lib/http-guard.ts` | 新規 | #4 |
| `lib/seed-guard.ts` | 新規 | #5 |
| `lib/queries.ts` | 変更 | #1（述語を共有） |
| `lib/news-admin.ts` | 変更 | #1（述語を共有） |
| `lib/env.ts` | 変更 | #2 |
| `lib/password.ts` | 変更 | #3（非同期化。定数時間比較等は保持） |
| `auth.ts` | 変更 | #2（getServerEnv fail-fast）/ #3（2軸レート制限・非同期照合）/ RV-P2-003 |
| `auth.config.ts` | 変更 | #4（sessionToken Cookie 明示） |
| `app/api/admin/news/save/route.ts` | 変更 | #4 |
| `app/api/admin/news/delete/route.ts` | 変更 | #4 |
| `prisma/seed.ts` | 変更 | #5 |
| `.env.example` | 変更 | #2 / #5（注記追記） |
| `.env` | 変更（ローカル・gitignore 済） | #2（ダミー AUTH_SECRET を 32文字以上へ） |

スコープ外（RV-P2-003 を除く Should Fix、SEC-002/014〜020）には着手していない。

---

## 8. 再レビューへの申し送り

1. **`.env` の `AUTH_SECRET` を伸ばした**（§2）。ローカル環境ファイルへの変更であり、
   仕様が機能した結果だが明示的に確認されたい。
2. **述語の置き場所をレビュー推奨（`lib/news-admin.ts`）から `lib/news-visibility.ts` に変えた**（§1）。
   依存の向きと `new Date()` の評価タイミングが理由。
3. **レート制限に「成功でリセット」を加えた**（§3-c）。監査の閾値そのものは変えていないが、
   ロックアウト設計の意味論に関わるため判断を確認されたい。
4. **Cookie の `secure` 判定を NODE_ENV ではなく配信 URL から導出した**（§4）。
5. `lib/kv.ts` は未着手（スコープ外）。P3 で `RateLimitStore` の KV 実装として書き直す前提。
