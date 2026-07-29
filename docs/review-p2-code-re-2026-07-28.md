# コードレビュー（再検収）: P2「お知らせCMS」差し戻し修正

## レビュー日: 2026-07-28
## 対象Phase: 実装（CLAUDE.md Phase 7 コードレビュー / 再検収）
## レビュワー: Senior Engineer Agent
## 前提
- 前回判定 `docs/review-p2-code-2026-07-28.md` = **Request Changes**（Must Fix: RV-P2-001 / RV-P2-002）
- 品質ゲートはオーケストレーターが独立実行し全 green（unit 118 / integration 28 / type-check 0 / lint 0 / build 成功 / e2e 73）。テストファイルは Test Agent 書き出し後に未変更（mtime 確認済み）。
- **本レビューはテストを実行せず、コード読解のみで判定した。**

---

## 総合評価: **Approve**

前回の再レビュー条件（RV-P2-001 / RV-P2-002 の2件のみ修正）は**両方とも実コードでクローズを確認した**。しかも形だけの塞ぎ方ではない。

RV-P2-001 は「`getLatestNews` に1行足す」でも条件を満たせたところを、`lib/news-visibility.ts` という**述語の単一の真実源**を作り、公開経路（`lib/queries.ts`）と管理経路（`lib/news-admin.ts`）の双方がそれを参照する構造に変えている。しかも**定数ではなく関数**にした判断（`new Date()` のモジュール評価時固定を避ける）は、指摘に書いていない失敗モードを実装側が独自に潰したもので、定数化していたら「長寿命プロセスで時刻ゲートが凍る」という元の欠陥より悪い状態になっていた。置き場所を推奨の `lib/news-admin.ts` から新規モジュールへ変えた判断（公開側が管理側に依存する向きを作らない）も正しく、P3 の `/news` 一覧・詳細で破綻しない。モジュール境界も壊れていない（型のみ import、`server-only` 非付与、`lib/queries.ts` の `server-only` は維持）。

RV-P2-002 も `superRefine` + `auth.ts` モジュールトップでの `getServerEnv()` 発火という、前回指摘した「検証を書いても呼ばれなければ意味がない」問題まで含めて閉じている。境界値（32文字ちょうどは通る）も development の開発体験も設計どおり。

スコープ外だった Should Fix のうち RV-P2-003（authorize のタイミング差）/ RV-P2-004（同期 scrypt）/ RV-P2-005（CSRF）も同時に解決されており、`lib/password.ts` の定数時間比較・長さ事前チェック・hex 妥当性検証は**退行なしで全て保持**されている（PT2-05 の性質は維持）。前回 Approve 相当だった良い性質（4ハンドラの `auth()` 再検証、認可を存在確認より先に、単一描画経路、判別ユニオン、force-dynamic）にも退行はない。

新規コードには**リリースを止める欠陥は無い**。ただし今回追加されたレート制限基盤には、P3 で未認証エンドポイントに再利用する前に必ず閉じるべき設計上の穴が3件ある（RV-P2R-001〜003）。いずれも P2 の完了を妨げる性質ではないが、**「P3 で作り直さない汎用基盤」と位置づけている以上、P3 着手時の最初の作業として扱うこと**を条件に Approve とする。

## 評価サマリー
- **前回 Must Fix: 2件 → 2件ともクローズ**
- **新規 Must Fix: 0件**
- **新規 Should Fix: 5件**（RV-P2R-001〜005）
- **新規 Nice to Have: 4件**（RV-P2R-006〜009）
- 前回 Should Fix のうち **3件クローズ**（RV-P2-003 / 004 / 005）、4件は据え置き

---

## 1. 前回 Must Fix のクローズ判定表

| ID | 指摘 | 判定 | 根拠（file:line） |
|----|------|------|------------------|
| **RV-P2-001** | 公開トップ `getLatestNews` に時刻ゲートが無い | **クローズ** | `lib/news-visibility.ts:22` `publishedNewsWhere(now = new Date())` → `{ status:'PUBLISHED', publishedAt:{ lte: now } }`。`lib/queries.ts:46` と `lib/news-admin.ts:119` が**同一関数**を参照。`orderBy` も `PUBLISHED_NEWS_ORDER_BY`（`news-visibility.ts:27`）で共有され、「where は共有したが order は書き起こした」再分岐も潰してある。本番経路の呼び出しは `app/(public)/page.tsx:36` → `getLatestNews(3)` で不変。 |
| ├ 述語の重複記述 | 2箇所に同じ述語を書いていないか | **解消** | リポジトリ内で `publishedAt: { lte:` を持つのは `lib/news-visibility.ts:23` のみ。`queries.ts` / `news-admin.ts` はいずれも関数呼び出し。 |
| ├ モジュール境界 | `server-only` を壊していないか | **壊れていない** | `news-visibility.ts:19` は `import type { Prisma }` の**型のみ**（コンパイル時に消える）。`server-only` を付けていないため `news-admin.ts`（Node 環境の結合テストが import）からも安全。`lib/queries.ts:10` の `import 'server-only'` は維持されており、REV-103 のクライアント誤 import 防御は本番ビルドでそのまま効く。 |
| └ P3 での破綻可能性 | `/news` 一覧・詳細追加時 | **破綻しない** | 公開側（`queries.ts`）が管理側（`news-admin.ts`）を import しない向きになっている。P3 の `/news` `/news/[id]` は `queries.ts` に関数を足して `publishedNewsWhere()` を呼ぶだけで済む。**推奨（`news-admin.ts` に定数）より実装側の判断のほうが良い**。 |
| **RV-P2-002** | 本番 `AUTH_SECRET` の起動時強度検証が未実装 | **クローズ** | `lib/env.ts:43-52` の `superRefine`。`env.NODE_ENV !== 'production'` で早期 return、production のみ `!AUTH_SECRET \|\| length < 32` を検証。`path: ['AUTH_SECRET']` によりエラー文字列に識別子が入る。 |
| ├ 境界値（32文字） | 32はOK / 31はNG か | **正しい** | `lib/env.ts:45` は `< AUTH_SECRET_MIN_LENGTH`（=`lib/env.ts:11` で 32）。32文字ちょうどは通る。テスト契約（`tests/unit/env.test.ts:65,70` の SECRET_31 / SECRET_32）と一致。 |
| ├ 発火導線 | 呼ばれなければ意味がない（前回の主要指摘） | **対応済み** | `auth.ts:33` のモジュールトップで `getServerEnv()` を1度評価。`auth.ts` は4つの管理 API ハンドラと管理ページから import されるため、Node ランタイムの実質的な入口として妥当。`middleware.ts` は `auth.config.ts` のみ import するので Edge を巻き込まない（`middleware.ts:13`）。 |
| ├ development の開発体験 | 壊れていないか | **壊れていない** | production 以外は即 return。`parseServerEnv({})` / `{ AUTH_SECRET:'secret' }` が throw しない契約が `tests/unit/env.test.ts:96-97` で固定されている。`parseServerEnv` は `source` 引数の `NODE_ENV` を見る純関数のまま（`lib/env.ts:57`）で、`process.env` 差し替えもモジュールキャッシュ리셋も不要。設計として正しい。 |
| └ `.env` / `.env.example` の変更 | 妥当か | **妥当**（下記） | — |

### `.env` を書き換えた件（Impl ノート §2）の評価

**妥当。回避策ではなく、仕様が正しく機能した結果である。** 説明の論理も正しい。

- E2E は `next start`（`NODE_ENV=production`）で回るため、新しい検証は E2E 経路で**実際に効く**。旧 `.env` の 25 文字ダミーのままではビルド／ログインが落ちる。これは「弱い署名鍵で production を起動できない」という要求どおりの挙動であり、検証が飾りでない証拠でもある。
- `.env` は `.gitignore:34` で除外済み。実運用の秘密ではない。現在値の長さは実測 44 文字で下限を満たす（ノートの「41文字」とは差異があるが、いずれにせよ 32 以上で問題なし）。
- `.env.example:19-20` に「本番は 32文字以上が必須。未設定/短い値は起動時に検証エラー（SEC-013）」を追記済み。運用者が原因を特定できる。

ただしこの変更は、**長さだけを見る検証の弱点を同時に露呈させている** → RV-P2R-004 参照。

---

## 2. 新規実装の品質評価

### 2-1. `lib/rate-limit.ts` — 汎用基盤としての評価

**総評: 抽象の切り方は正しい。P3 で作り直しにはならない。ただし運用上の穴が3件ある。**

良い点（設計として明確に評価する）:
- **判定ロジックと永続化の分離**（`RateLimitStore` が `get/set/delete` の3メソッドのみ, `rate-limit.ts:35-39`）。`lib/kv.ts` の「KV 実装と判定が1関数に密結合」した形を採らなかった判断理由がコメント（`rate-limit.ts:10-14`）に残っている。この分離により本番の Vercel KV / Upstash へは **`store` を注入するだけ**で差し替わり、`lib/rate-limit.ts` も `auth.ts` も無変更で済む。テスト（`tests/unit/rate-limit.test.ts:197-219`）が Store 差し替えを強制しているため、この性質は回帰から守られている。
- **時刻注入**（`consume(key, now?)` / `peek(key, now?)`, `rate-limit.ts:114,134`）。実時間 sleep 無しでウィンドウ境界を検証できる。
- **サーバーレス前提の明示**（`rate-limit.ts:15-18`, `auth.ts:41-43`）。「既定インメモリは単一インスタンス（dev / E2E / デモ）用、本番はインスタンス跨ぎ共有が要るので KV を注入」と明記されている。前提が暗黙になっていないことは、この種の基盤で最も重要な性質。
- **上限到達後はカウントを進めない**（`rate-limit.ts:124-127`）。攻撃時の store 書き込み増幅を避ける。KV 課金・レイテンシの両面で正しい。
- `peek` の定義が「次の `consume` が通るか」（`count < limit`, `rate-limit.ts:138`）。オフバイワンを意識した上での定義であることがコメントに残っている。

問題点 → **RV-P2R-001 / 002 / 003 / 007**（後述）。特に **キーの無限増殖に対する手当てが無い**点は、P3 で未認証エンドポイント（攻撃者がキー空間を制御できる）に再利用する前に必ず閉じること。

### 2-2. `lib/http-guard.ts` — Origin 検証

**実装は正しい。** `origin === new URL(request.url).origin`（`http-guard.ts:27`）は scheme/host/port を含む厳密比較で、サブドメイン違いも弾く（`SameSite=Lax` がサブドメインに Cookie を送る以上、これが要点）。`Origin` 欠落は fail-closed（`http-guard.ts:25`）で、クロスサイトのネイティブ form POST が必ず `Origin` を送る事実に基づく妥当な判断。`new URL` の throw も拒否側に倒している（`http-guard.ts:28-31`）。

- **正規リクエストを誤って弾かないか**: 弾かない。同一オリジンのブラウザ送信（`NewsForm.tsx` / `ConfirmDialog.tsx` のネイティブ form POST）には `Origin` が常に付く。E2E `admin-authz.spec.ts` の 4-3 / 4-5 が「同一 Origin なら従来どおり 303 かつ DB に実際に反映」を、HTTP ステータスだけでなく **Prisma で DB 実状態を確認して**固定している。「403 を返しつつ実は処理済み」を検出できるテスト設計で、これは良い。
- **`trustHost` との関係**: 直交する。`trustHost: true`（`auth.config.ts:31`）は Auth.js のホスト検証を緩めるが、`isSameOrigin` は `Origin` と `request.url` の**両方が同じホストであること**しか受理しない。攻撃者ページからの POST は `Origin: attacker` / `Host: 正規` となり一致しないため、`trustHost` が緩んでいても防御は成立する。
- ハンドラ先頭（`auth()` より前）に置いた判断（`save/route.ts:24`, `delete/route.ts:14`）も妥当。安価かつ fail-closed で、資格情報検証に入る前に弾ける。
- 唯一の未検証点は TLS 終端プロキシ配下での scheme → **RV-P2R-006**。

### 2-3. `lib/seed-guard.ts` + `prisma/seed.ts`

**正しい。** `assertSeedAllowed` は副作用の無い純関数（`seed-guard.ts:41`）で、production は `ALLOW_PROD_SEED='1'` の明示オプトイン必須（:42-47）、`ADMIN_EMAIL` / `ADMIN_PASSWORD` は**環境を問わず** fail-fast（:49-63）。`ADMIN_NAME` のみ既定値を許す粒度も適切（秘密ではない）。

呼び出し位置が `prisma/seed.ts` の `main()` 冒頭・**`$transaction([...deleteMany])` より前**（seed.ts の main 冒頭）である点が重要で、これが逆だと「ガードに引っかかる前に本番データが消える」。正しい順序になっている。

`upsert` の `update` 節から `passwordHash` を外した対応も正しい（既存管理者のパスワードを seed 再実行で `.env` の値へ黙って降格させない）。tsx で `@/` が解決されないため相対 import にした点も注記付きで一貫している。

### 2-4. `lib/password.ts` の非同期化 — 退行チェック

**退行なし。PT2-05 で解決済みと判定した性質は全て保持されている。**

| 性質 | 判定 | 根拠 |
|------|------|------|
| `timingSafeEqual` による定数時間比較 | 保持 | `lib/password.ts:56`。`===` 比較は無い。 |
| 長さ事前チェック（throw 回避） | 保持 | `lib/password.ts:51`（`expected.length !== SCRYPT_KEYLEN`）/ `:55`（`actual.length !== expected.length`） |
| hex 妥当性検証（`Buffer.from` の黙示切り詰め対策） | 保持 | `lib/password.ts:47` の正規表現 |
| 形式不正で throw せず false | 保持 | `lib/password.ts:41-59` の try/catch。`await` が try 内にあるため非同期化で漏れていない |
| 形式互換（`scrypt$<saltHex>$<hashHex>` / salt16B / keylen64B） | 保持 | `lib/password.ts:23-24,36`。`prisma/seed.ts` の `hashPassword`（scryptSync, salt16 / keylen64）と相互運用可能 |

同期版を残さなかった判断も正しい（`authorize` が誤って同期版を呼ぶ余地を消す）。seed 側が `scryptSync` のままなのは CLI スクリプトなので問題ない。

### 2-5. `auth.ts` — 2軸レート制限と RV-P2-003

- **RV-P2-003（タイミング差）はクローズ**。`auth.ts:103-104` で `stored = user?.passwordHash ?? await getDummyHash()` として**必ず** `verifyPassword` を実行し、`ok` を先に評価し切ってから `:106` で判定する。`&&` の早期脱出になっていない。ダミーハッシュの遅延生成＋キャッシュ（`auth.ts:52-56`）も、`hashPassword` 非同期化に伴う正しい対処。前回コメントと実装が食い違っていた状態（後任が「対策済み」と誤読する害）も解消されている。
- **2相運用（peek → consume）が正しく実装されている**。上限超過時は資格情報を検証せず一律 `null`（`auth.ts:87-94`）＝列挙耐性を維持しつつ scrypt も走らせない。IP 軸は試行ごと `consume`（:97）、アカウント軸は**失敗時のみ** `consume`（:107）。契約どおり。
- **ログ衛生**: `auth.ts:90-92,108-112` は IP・時刻・試行回数のみ。パスワードとメールアドレス全文を出していない（SEC-009 修正方針3 準拠）。
- **「成功でリセット」の追加**（`auth.ts:117-118`）は**是認する**。攻撃者（成功しない）には閾値がそのまま効き、正当な利用者（成功する）は上限に触れない、という非対称性を作る。閾値を緩めずに誤検知だけを消しており、E2E の連続ログインを通すための「テストに合わせた妥協」ではない。判断として正しい。
- **アカウントロックアウト DoS は成立する** → **RV-P2R-001**（Should Fix）。

---

## 3. 退行チェック（前回 Approve 相当だった性質）

| 性質 | 判定 | 根拠 |
|------|------|------|
| 4ハンドラでの `auth()` 再検証 | **維持** | `app/api/admin/news/route.ts:15` / `[id]/route.ts:12` / `save/route.ts:28` / `delete/route.ts:18` の4箇所。middleware の matcher が `/admin/:path*` のみ（`middleware.ts:17`）で `/api/admin/*` を含まない事実も不変。 |
| 認可を存在確認より先に置く | **維持** | `app/api/admin/news/[id]/route.ts:32` のコメントと処理順（認可 → `ctx.params` → 存在確認）。 |
| 単一描画経路 | **維持** | `grep -rn dangerouslySetInnerHTML app components lib tests` の実出現は `components/admin/MarkdownEditor.tsx:77` のみで、`__html` は `renderMarkdown(value)` 直結。 |
| 判別ユニオンのバリデーション | **維持** | `lib/validators/news.ts` は未変更。`save/route.ts:50` からの呼び出しも不変。 |
| force-dynamic による DB 非依存ビルド | **維持** | `app/(public)/page.tsx` / `programs/page.tsx` / `app/admin/(app)/layout.tsx` に残存。Impl ノートの build 実測でも全ルートが `ƒ (Dynamic)`。 |
| 既存 E2E 契約（未認証 401/403、未認証 save/delete の 303） | **維持** | `admin-authz.spec.ts` の PT2-01 群は不変。PT2-05 の 4-6 が「303 / 403 どちらでも可」として既存契約を壊していないことを固定。 |

**退行は検出されなかった。**

---

## 4. 新規指摘事項

### [RV-P2R-001] アカウント軸ロックアウトにより、未認証の攻撃者が単一 IP から管理者ログインを恒久的に封鎖できる

- **種別**: Security（可用性 / ロックアウト DoS）
- **重要度**: **Should Fix**（P3 着手時に対応。P2 のブロッカーとはしない）
- **場所**: `auth.ts:46`（`LOGIN_ACCOUNT_LIMITER`: 5回/15分）/ `auth.ts:84-94`（peek ゲート）/ `auth.ts:107`（失敗時 consume）
- **現状**: アカウント軸のキーは `credentials:email:<正規化メール>`（`auth.ts:80`）で、**発信元 IP を含まない**。したがって攻撃者が管理者のメールアドレスを知っていれば、誤ったパスワードで5回 POST するだけでそのアカウントを15分ロックできる。ロック中は `auth.ts:87` の peek ゲートが先に効くため、**正しいパスワードを入力しても `null` が返る**。

  問題は IP 軸がこれを抑止できないことである。IP 軸は 10回/10分（`auth.ts:45`）で、攻撃に必要なのは 15分あたり5回。**5 < 10 なので単一 IP で足りる**。攻撃者は15分ごとに5回投げるだけで、コスト実質ゼロで管理画面へのログインを無期限に封鎖できる。分散も不要。

  緩和材料は3つある: (a) 既定ストアがインメモリなのでインスタンス再起動で解除される、(b) 影響は管理ログインのみで公開サイトとデータには及ばない、(c) 攻撃には管理者メールアドレスの知識が要る（ただし `.env.example` の例示や `docs/dev-database.md` から推測されうると SEC-009 自身が指摘している）。このため P2 のリリースブロッカーとはしない。

  なお本実装は security-audit.md SEC-009 修正方針1 の「アカウントあたり5回失敗で15分ロック」に**忠実に従った結果**であり、実装側の逸脱ではない。指摘の対象は監査が指定した設計そのものである（OWASP も純粋なアカウントロックアウトはこの理由で非推奨としている）。
- **改善案**: アカウント軸を**複合キー**にし、ロックの影響範囲を攻撃元に閉じ込める。分散攻撃検知は別枠の緩い閾値で持つ。

```ts
// 攻撃者の IP でのみロックする（正当な管理者の別 IP からのログインは阻害されない）
const accountKey = `credentials:email:${normalizedEmail}:${ip}`

// 分散攻撃はアカウント全体の緩い閾値で拾う（例: 50回失敗/15分）。
// ここに達したら 15 分ロックではなく「追加検証（CAPTCHA / 通知）」に倒すのが望ましい。
const globalAccountKey = `credentials:email-global:${normalizedEmail}`
```

  複合キーにしても、単一 IP からのブルートフォースに対する防御力は変わらない（5回失敗で当該 IP は締め出される）。失うのは「複数 IP から1アカウントを狙う攻撃を1つのカウンタで捉える」能力だけで、それは上記の緩い全体閾値と IP 軸で代替できる。
- **理由**: 「ブルートフォース対策を入れた結果、認証を突破せずとも管理者を締め出せるようになった」は、防御の導入で新しい攻撃面を作った状態にあたる。修正はキー文字列の変更が主で小さく、P3 でレート制限を未認証エンドポイントへ横展開する前に意味論を確定させておくほうが安い。

### [RV-P2R-002] インメモリ store が期限切れエントリを回収せず、キーが無限に増殖する

- **種別**: Bug（リソースリーク）/ 可用性
- **重要度**: **Should Fix**（**P3 着手前に必須**）
- **場所**: `lib/rate-limit.ts:73-86`（`createMemoryRateLimitStore`）/ `lib/rate-limit.ts:93-97`（`currentEntry`）
- **現状**: `currentEntry` は期限切れを検出しても `null` を返すだけで、**`store.delete(key)` を呼ばない**。

```ts
async function currentEntry(key: string, now: number): Promise<RateLimitEntry | null> {
  const entry = await store.get(key)
  if (!entry || now >= entry.resetAt) return null   // ← 期限切れを検出しているのに削除しない
  return entry
}
```

  `createMemoryRateLimitStore` は素の `Map` で、TTL も上限件数も掃除タイマーも持たない（`rate-limit.ts:74`）。したがって**一度でも `consume` されたキーはプロセスが死ぬまで常駐する**。期限切れ後に同じキーを `consume` すれば上書きされるが、二度と現れないキー（一度きりのクローラ IP、タイポしたメールアドレス、攻撃者が投げた任意文字列）は永久に残る。

  P2 の範囲（管理ログインのみ）では増殖速度は IP 軸の 10回/10分 に律速されるため実害は小さい。しかし本モジュールは**P3 の未認証エンドポイント（申込・画像アップロード・チャット）で再利用する前提**（`rate-limit.ts:6-7`）であり、そこではキーが IP・アップロードトークン等の**攻撃者が制御できる値**になる。RV-P2R-003（IP 詐称）と組み合わさると、単一ホストから無制限にキーを生成でき、メモリ枯渇に至る。KV へ差し替えた場合は TTL を実装側が付けられるので緩和されるが、**既定実装が既定のまま P3 で使われる**のが最も起こりやすい経路である。
- **改善案**: 最小は期限切れの明示削除。加えて件数上限を設けるのが確実。

```ts
async function currentEntry(key: string, now: number): Promise<RateLimitEntry | null> {
  const entry = await store.get(key)
  if (!entry) return null
  if (now >= entry.resetAt) {
    await store.delete(key)   // 期限切れは即座に回収する
    return null
  }
  return entry
}
```

```ts
/** 上限件数を持つインメモリ store（超過時は最も古い resetAt から捨てる）。 */
export function createMemoryRateLimitStore(maxEntries = 10_000): RateLimitStore
```

  併せて `RateLimitStore` のドキュメントに「実装は `resetAt` に対応する TTL を設定してよい／すべき」と、既定インメモリ実装の**保持上限を明記**すること（現状のコメント `rate-limit.ts:33` は TTL を「してよい」と書くに留まる）。
- **理由**: レート制限はリソース枯渇を防ぐための機構であり、その機構自体がリソースを無制限に消費するのは自己矛盾である。修正は数行。P3 で未認証エンドポイントに載せた後に見つかると、本番でのメモリ枯渇という形で出る。

### [RV-P2R-003] `clientIp` が `x-forwarded-for` の左端を無条件に信頼しており、信頼境界がコード上に記録されていない

- **種別**: Security（レート制限のバイパス）
- **重要度**: **Should Fix**
- **場所**: `auth.ts:59-63`
- **現状**:

```ts
function clientIp(request: Request | undefined): string {
  const forwarded = request?.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()   // ← 左端＝最もクライアント寄り
  return request?.headers.get('x-real-ip')?.trim() || 'unknown'
}
```

  `x-forwarded-for` の左端は、**プロキシがヘッダを上書きしない限りクライアントが自由に詐称できる**値である。Vercel はプラットフォーム側で本ヘッダを設定するため本番想定では問題にならないが、その前提はコードにもコメントにも書かれていない。前提が崩れる経路は現実にある: `next start` を直接公開する／プロキシが XFF を追記する構成／ローカル・オンプレでの検証運用。

  前提が崩れたときの影響は「IP 軸のレート制限が完全に無効化される」ことで、攻撃者はリクエストごとに `X-Forwarded-For` を変えるだけで無制限に試行できる（残る防御はアカウント軸の 5回/15分のみ）。同時に RV-P2R-002 のキー増殖を無制限化する増幅器にもなる。
- **改善案**: 信頼境界を明示し、プラットフォーム固有ヘッダを優先する。

```ts
/**
 * 発信元 IP。**x-forwarded-for の左端はクライアントが詐称できる**ため、
 * 本関数は「XFF を上書きするプロキシ（Vercel）配下で動作する」ことを前提とする。
 * 前提が成立しない配置では IP 軸のレート制限は無効と見なすこと。
 */
function clientIp(request: Request | undefined): string {
  // Vercel はプラットフォーム側で設定し、クライアントからは上書きできない。
  const vercel = request?.headers.get('x-vercel-forwarded-for')
  if (vercel) return vercel.split(',')[0].trim()
  // ...（以下フォールバック）
}
```

  P3 で同じ IP 解決を申込・アップロード・チャットにも使うため、`clientIp` は `auth.ts` のプライベート関数ではなく `lib/http-guard.ts` 等の共有モジュールへ移すのが望ましい（P3 で3箇所目・4箇所目の実装が生まれる前に）。
- **理由**: 前提そのものは Vercel 配置なら妥当だが、「どの条件下でこの防御が成立するか」がコードに書かれていないと、配置変更時に静かに無効化される。SEC-009 は High 判定の指摘であり、その対策の実効性が未記録の前提に依存している状態は残すべきでない。

### [RV-P2R-004] `AUTH_SECRET` の検証が長さのみで、開発用プレースホルダがそのまま本番検証を通過する

- **種別**: Security（設定ミス検出の不足）
- **重要度**: **Should Fix**
- **場所**: `lib/env.ts:43-52`
- **現状**: 検証条件は `!env.AUTH_SECRET || env.AUTH_SECRET.length < 32` のみで、**エントロピーも既知プレースホルダも見ていない**。`'A'.repeat(32)` は通る（テスト `env.test.ts:70` がそれを正常系として固定している）。

  より具体的な問題として、今回 `.env` に設定した開発用ダミー（`dev-only-secret-change-me-…`、実測 44 文字）は**この検証を通過する**。SEC-013 が想定した事故は「`dev-only-secret-change-me` のまま本番デプロイされる」であり、値を長くしたことで**その事故シナリオがちょうど検出範囲から外れた**。前回の指摘（`docs/review-p2-code-2026-07-28.md` RV-P2-002 の「現状 `.env` の `dev-only-secret-change-me` のまま本番デプロイしても何も検出されない」）の趣旨に照らすと、長さの下限だけでは半分しか塞げていない。
- **改善案**: 明白なプレースホルダを拒否する（完全なエントロピー検証は不要。事故の大半は「サンプル値のコピー」である）。

```ts
/** 開発用ダミーが本番に紛れ込むのを検出する（長さだけでは通過してしまうため）。 */
const PLACEHOLDER_PATTERNS = [/dev-only/i, /change-?me/i, /^your[-_]/i, /example/i, /^(.)\1+$/]

// superRefine 内、長さ検証の後に
if (env.AUTH_SECRET && PLACEHOLDER_PATTERNS.some((p) => p.test(env.AUTH_SECRET!))) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['AUTH_SECRET'],
    message: 'AUTH_SECRET が開発用プレースホルダのままです（openssl rand -base64 32 で再生成してください）',
  })
}
```

  単体テストは既存の describe に2件足すだけで固定できる（プレースホルダを含む44文字が production で throw する／ランダムな44文字は通る）。
- **理由**: この検証の目的は「暗号強度の証明」ではなく「運用ミスの検出」である。実際に発生しうる運用ミスの筆頭（サンプル値のコピー、ローカル `.env` の流用）が検出できないなら、fail-fast の価値は大きく目減りする。今回ローカル値を32文字以上に伸ばしたことで、**このプロジェクト自身が最も踏みやすいパターン**になった点が重要。

### [RV-P2R-005] CI の E2E ジョブの `pnpm build` に `AUTH_SECRET` が渡っておらず、新しい検証で失敗する

- **種別**: Bug（CI / デプロイ）
- **重要度**: **Should Fix**
- **場所**: `.github/workflows/ci.yml`（`e2e-test` ジョブの `- run: pnpm build` ステップ。`env:` が付いていない）
- **現状**: `next build` は `NODE_ENV=production` で動き、ビルド時のページデータ収集で `auth.ts` が評価される（`auth.ts:33` の `getServerEnv()` が発火する）。Impl ノート §2 は `AUTH_SECRET=short pnpm build` がビルド中に `ZodError` で停止することを実測で記録しており、これは**設計どおりの挙動**である。

  その帰結として、`AUTH_SECRET` を一切与えていない CI の `pnpm build` ステップは失敗する。同ジョブは `POSTGRES_*` も与えておらず（`type-check` ジョブは `prisma validate` 用にダミー値を明示している）、`integration-test` ジョブも DB サービスを持たないため、**CI は本修正以前から通っていない可能性が高い**。したがって「動いていた CI を壊した」ではなく「動いていない CI に新しい失敗要因が1つ増えた」という位置づけで、Must Fix とはしない。
- **改善案**: ビルド時に必要な env をジョブに明示する。値は CI 専用のダミーでよい（32文字以上・プレースホルダ検出に引っかからない値）。

```yaml
      - run: pnpm build
        env:
          AUTH_SECRET: ${{ secrets.CI_AUTH_SECRET }}   # or 32文字以上の固定ダミー
          POSTGRES_URL: postgresql://user:password@localhost:5432/db?schema=public
          POSTGRES_PRISMA_URL: postgresql://user:password@localhost:5432/db?schema=public&pgbouncer=true
          POSTGRES_URL_NON_POOLING: postgresql://user:password@localhost:5432/db?schema=public
```

  併せて **`AUTH_SECRET` はランタイムだけでなくビルド時にも必要である**ことを `.env.example` かデプロイ手順に1行書くこと。Vercel は env をビルドにも供給するため通常は問題にならないが、env のスコープを Production Runtime のみに設定した場合に「デプロイが通らない」という形で出る。原因が分かる記述があるかどうかで解決時間が桁で変わる。
- **理由**: fail-fast は正しい設計であり、直すべきは検証ではなくビルド環境の側。ただし「CI とデプロイ手順が新しい前提を満たしていない」ことが未記録のまま残ると、P3 で CI を正常化しようとした人が原因の切り分けに時間を使う。

### [RV-P2R-006] `new URL(request.url).origin` の scheme が TLS 終端プロキシ配下で `http` になる可能性（初回 https デプロイ時に要検証）

- **種別**: Bug（潜在）/ 可用性
- **重要度**: Nice to Have（ただし**初回本番デプロイ時に必ず確認**）
- **場所**: `lib/http-guard.ts:27`
- **現状**: `isSameOrigin` は scheme を含めて厳密比較する（これ自体は正しい）。しかしリバースプロキシで TLS を終端する構成では、アプリが受け取るリクエストが平文 HTTP になり、`request.url` が `http://…` として解決される場合がある。一方ブラウザが送る `Origin` は `https://…` である。両者が食い違うと、**同一オリジンの正規リクエストが全て 403 になり、お知らせの保存・削除が本番でのみ一切できなくなる**。

  Next.js on Vercel は `x-forwarded-proto` を考慮して URL を解決するため、想定配置では問題にならない見込みである。しかし E2E は `http://localhost:3000` で回っており（scheme が両側とも http で一致するため常に通る）、**この分岐はテストで踏まれていない**。RV-P2-007（タイムゾーン）と同じ「ローカルで再現せず本番でのみ壊れる」型の分岐である。
- **改善案**: 初回 https デプロイ直後にお知らせの保存・削除を1回ずつ手動実行して確認する。もし 403 になる場合は `x-forwarded-proto` を考慮する:

```ts
const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')
const host = request.headers.get('host')
return origin === `${proto}://${host}`
```

  ただし `x-forwarded-proto` もプロキシ非経由なら詐称可能なので、`isSameOrigin` の比較で使うのは**プロキシ配下であることが確実な場合のみ**にすること（RV-P2R-003 と同じ信頼境界の話）。
- **理由**: 誤検知の方向に倒れる（正規ユーザーが操作不能になる）不具合で、しかも管理画面という発見の遅い場所で出る。修正ではなく**確認手順として申し送る**のが費用対効果が良い。

### [RV-P2R-007] `peek` → `consume` が非アトミックで、並行リクエスト下で上限を超えて通過しうる

- **種別**: Design（並行性）
- **重要度**: Nice to Have
- **場所**: `auth.ts:83-97`（peek → consume の2相）/ `lib/rate-limit.ts:114-132`（read-modify-write）
- **現状**: `consume` は `store.get` → 判定 → `store.set` の read-modify-write で、アトミックな加算ではない。インメモリかつ Node 単一スレッドの現状では `await` 境界での割り込みに限られるため実害は小さい（数回の超過に留まる）。しかし **KV へ差し替えた瞬間に本質的な TOCTOU になる**（ネットワーク往復の間に他インスタンスが更新する）。並行 N 本のリクエストが全て「上限未満」を読んでから書き込めば、上限を N 倍超えて通過しうる。
- **改善案**: KV 実装時に `INCR` + `EXPIRE`（Redis のアトミック操作）を使う形へ寄せる。そのためには `RateLimitStore` に `increment(key, windowMs, now): Promise<RateLimitEntry>` を追加し、判定側は「増やした後の値で判定する」形に変えるのが素直。現インターフェース（`get`/`set`/`delete`）のままだとアトミック性を実装側に落とし込めないため、**P3 で KV 実装を書く前にインターフェースを見直すこと**。
- **理由**: 現時点で壊れてはいないが、「差し替えるだけで本番対応できる」という本モジュールの売り文句が、この点だけは成立していない。P3 で KV を書く人が最初にぶつかる。

### [RV-P2R-008] `lib/kv.ts` が throw するだけのスタブのまま残り、レート制限の真実源が2つに見える

- **種別**: Maintainability
- **重要度**: Nice to Have
- **場所**: `lib/kv.ts:16-22`（`checkRateLimit` は `throw new Error('not implemented (F-010)')`）↔ `lib/rate-limit.ts`
- **現状**: スコープ外として未着手なのは判断として妥当だが、結果として `RateLimitResult` という**同名で形の違う型が2モジュールに存在**する（`lib/kv.ts:9-13` は `{ success, remaining, resetAt }`、`lib/rate-limit.ts:41-52` は `retryAfterMs` / `limit` を含む5フィールド）。P3 で「レート制限を実装する」人が `lib/kv.ts` の方を先に見つけて実装を始める経路が普通にある。
- **改善案**: `lib/kv.ts` に1行、方針を書く。実装を消す必要はない。

```ts
/** @deprecated 判定ロジックは lib/rate-limit.ts が真実源。本モジュールは
 *  `createKvRateLimitStore(): RateLimitStore` として書き直す（P3 / F-010）。 */
```

- **理由**: 「どちらを使うべきか」がコードから読めない状態は、P3 で並行実装を生む最も安いミスの温床。修正コストはコメント1行。

### [RV-P2R-009] 結合テストの `server-only` alias がテスト環境全体に適用される

- **種別**: Maintainability（テスト基盤）
- **重要度**: Nice to Have
- **場所**: `vitest.integration.config.ts:9`（alias）/ `tests/integration/stubs/server-only.ts`
- **現状**: 本番経路（`lib/queries.ts`）を結合テストから検証するための差し替えで、**判断としては正しい**（RV-P2-001 の根本原因の一つが「本番経路をテストから触れなかったこと」であり、そこを構造的に解消している）。差し替えがテスト実行時のみでビルドに影響しないことも、スタブのコメントに正しく説明されている。

  留意点は、alias が結合テスト**全体**に効くため、今後どのモジュールが `server-only` を持っていてもテストからは import できてしまうこと。「server-only を付けたつもりが、テストでは常に通るので境界違反に気づけない」状態を作りうる。
- **改善案**: 現状のままで可。将来 `server-only` 付きモジュールが増えたら、テスト側に「このモジュール群だけがスタブ対象」という明示的な許可リスト（あるいは境界違反を検出する lint ルール）を検討する。
- **理由**: 現時点で実害は無く、代替案（本番経路をテストしない）のほうが明確に悪い。記録だけ残す。

---

## 5. 前回 Should Fix（RV-P2-003〜009）の状況

| ID | 内容 | 今回の状況 | 根拠 |
|----|------|-----------|------|
| **RV-P2-003** | `authorize` のユーザー存在有無タイミング差 | **クローズ** | `auth.ts:103-104`。ダミーハッシュに対して同一コストの検証を実行し、`ok` を先に評価し切ってから `:106` で判定。コメント（`auth.ts:20-21`）と実装が一致した。 |
| **RV-P2-004** | `scryptSync` がイベントループを塞ぐ | **クローズ** | `lib/password.ts:26-30` で `promisify(scrypt)`。同期版は削除。`auth.ts:104` が `await`。 |
| **RV-P2-005** | save/delete に CSRF 対策が無い | **クローズ** | `lib/http-guard.ts` 新設、`save/route.ts:24` / `delete/route.ts:14` の先頭で検証。E2E 6件（`admin-authz.spec.ts` PT2-05）が DB 実状態まで含めて固定。併せて `auth.config.ts:34-44` で `sameSite: 'lax'` を明示し暗黙依存を解消。**`secure` を NODE_ENV ではなく配信 URL から導出した判断**（`auth.config.ts:22-26`）も正しい（`next start` を http://localhost で回す E2E で `__Secure-` 接頭辞 Cookie が拒否される問題を回避しつつ、URL ヒント不在時は production なら secure 側に倒す安全側の既定）。 |
| **RV-P2-006** | Markdown プレビューのクライアント実行・バンドル肥大 | **未対応**（スコープ外） | `components/admin/MarkdownEditor.tsx:77` は `renderMarkdown(value)` を毎レンダー同期実行のまま。P3 でサーバー描画経路ができた時に合流するのが最安（前回申し送りどおり）。 |
| **RV-P2-007** | `publishedAt` のタイムゾーン解釈 | **未対応・優先度上昇** | `save/route.ts:47` は `new Date(publishedAtRaw)` のまま（オフセット無し文字列＝実行環境ローカル解釈）。**時刻ゲートが実際に効くようになったことで、影響が「表示が1日ずれる」から「意図した時刻に公開されない」に変わった**。本番（UTC）で JST 09:00 のつもりの入力は 18:00 JST 相当として保存され、9時間出てこない。→ 下記申し送り。 |
| **RV-P2-008** | `renderSafe` 実装と functional-spec §4.10 の乖離 | **未対応**（ドキュメントのみ） | 実装は正しく、直すべきは仕様書側。P3 の仕様策定で両ファイルを触るついでが効率的。 |
| **RV-P2-009** | `UNAUTHORIZED` をモジュールスコープの `NextResponse` として共有 | **未対応** | `app/api/admin/news/route.ts:19` / `[id]/route.ts:16` に現存。`Response` のボディは一度しか読めないため Fetch API の契約違反。E2E はステータスのみ検証しており検出しない。修正コストはほぼゼロなので、P3 で `lib/api-auth.ts` を作る際に RV-P2-010 と同時に潰すこと。 |
| RV-P2-010〜015 | 重複抽出 / publish-status コメント / 入力保持 / 下書きボタン / レート制限 / ページネーション | RV-P2-014 のみ**クローズ**（レート制限実装済み）。他は未対応 | `lib/publish-status.ts:4-5` のコメントは「enum は DRAFT/PUBLISHED の2値のみ」のままで、`prisma/schema.prisma` の現状（UNPUBLISHED 追加済み）と依然食い違う（RV-P2-011 継続）。 |

---

## 6. P3（入所申込フォーム）への申し送り

### P3 着手時の最初の作業（順序を推奨する）

1. **RV-P2R-002（キー回収）と RV-P2R-001（ロックアウトのキー設計）を先に閉じる。** P3 は `lib/rate-limit.ts` を申込 / 画像アップロード / チャットの**未認証**エンドポイントへ横展開する Phase であり、そこではキー空間が攻撃者の制御下に入る。横展開してから直すと、修正が3箇所以上に散る。
2. **RV-P2-007（タイムゾーン）を実装着手前に片付ける。** 時刻ゲートが有効になった今、`datetime-local` のローカル解釈は「予約公開が9時間ずれる」という**利用者に見える不具合**として本番でのみ顕在化する。申込フォームにも生年月日・希望開始月があるため、`lib/format.ts` に `toJstDatetimeLocal` / `parseJstDatetimeLocal` を用意し、`TZ=UTC` でテストを回してから P3 の入力実装を始めること。既存の publishedAt 正規化3箇所（`save/route.ts:45-48`、`app/api/admin/news/route.ts`、`[id]/route.ts:18-29`）も同時に統合する。
3. **`clientIp` を共有モジュールへ移す**（RV-P2R-003）。P3 で3箇所目・4箇所目が生まれる前に。

### P2 から引き継ぐ設計上の真実源（**書き起こさないこと**）

- **公開お知らせの述語**: `lib/news-visibility.ts` の `publishedNewsWhere()` / `PUBLISHED_NEWS_ORDER_BY`。`/news` 一覧・`/news/[id]` 詳細は `lib/queries.ts` に関数を足してこれを呼ぶ。**述語を新しく書いた時点で RV-P2-001 の再発**である。
- **同一オリジン検証**: `lib/http-guard.ts` の `isSameOrigin`。申込・アップロード・チャットの変更系エンドポイント全てで使う。
- **レート制限**: `lib/rate-limit.ts` の `createRateLimiter`。`lib/kv.ts` は使わない（RV-P2R-008）。KV 実装は `RateLimitStore` として書き、その際アトミック加算を検討する（RV-P2R-007）。
- **ハンドラ層での `auth()` 再検証**: 受信管理（F-017）を作る際は、middleware の matcher が `/api/admin/*` を含まないことを前提に各ハンドラで検証する。
- **判別ユニオンのバリデータ**: `lib/validators/news.ts` の型（`z.discriminatedUnion` + 「例外を投げず判別可能ユニオンを返す」契約）を申込フォーム（APPLICATION / INQUIRY で必須項目が異なる）に踏襲する。

### P3 で必ず再確認すること

- **PT2-06（単一描画経路）**: `/news/[id]` は公開側で初めて `News.body` を HTML 描画する経路になる。実装後に `grep -rn dangerouslySetInnerHTML app components lib` を再実行し、`renderMarkdown` の戻り値以外が渡っていないことを確認する。SEC-001 の唯一の穴はここ。
- **RV-P2R-006（Origin の scheme）**: 初回 https デプロイ直後に、お知らせの保存・削除を各1回実行して 403 にならないことを確認する。
- **ビルド時 env**（RV-P2R-005）: `AUTH_SECRET` はランタイムだけでなく**ビルド時にも必要**。Vercel の env スコープを Production Runtime のみにすると、デプロイがビルド段階で落ちる。

### テスト設計への教訓（前回からの継続）

今回の修正で最も価値があるのは、`tests/integration/news.int.ts` の PT2-04 が**公開ページが実際に呼ぶ関数**（`getLatestNews`）を直接検証する形になったこと、そのために `server-only` のスタブ差し替えという**テスト基盤側の障害を除去した**ことである。P2 差し戻しの根本原因は「本番経路がテストから触れない構造だった」ことであり、実装だけでなく構造が直っている。P3 でも「テストが緑であること」と「本番経路が守られていること」を混同しないよう、**各テストがどの呼び出し元の経路を代表しているか**をテストのコメントに書く運用を続けること。
