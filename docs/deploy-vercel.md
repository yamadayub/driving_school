# Vercel デプロイ手順

> 公開URLで動かすための手順。**環境変数が揃っていないと本番は起動時に落ちる**（`lib/env.ts` の
> `superRefine`）。これは意図した設計で、レート制限や Cookie 署名が黙って無効化された状態で
> 動き続けるより落とすほうが安全だという判断（SEC-033 / AC-010-10）。

---

## 0. 全体の流れ

```
[あなた] vercel login
[あなた] リソースを用意（Postgres / Upstash / Turnstile）
[私]     vercel env add で環境変数を投入
[私]     vercel --prod でデプロイ
[私]     prisma migrate deploy + seed（管理者作成）
[私]     公開URLで疎通確認
```

---

## 1. あなたの操作: ログイン

対話式なので自動化できない。ターミナルで:

```bash
vercel login
```

---

## 2. あなたの操作: リソースの用意

### 必須（無いと本番が起動しない）

| リソース | 取得先 | 得られる値 |
|---------|--------|-----------|
| **Postgres** | Vercel ダッシュボード → Storage → Create Database → Postgres | `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` / `POSTGRES_PRISMA_URL` |
| **Upstash Redis** | Vercel Marketplace → Upstash（または upstash.com 直接） | `KV_REST_API_URL` / `KV_REST_API_TOKEN` |
| **Cloudflare Turnstile** | dash.cloudflare.com → Turnstile → サイトを追加 | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` |

> **Turnstile は本番キーが必要。** 開発で使っている `1x00000000000000000000AA` は
> 「常に成功する」テストキーで、本番に置くとスパム対策が実質無効になる。

### 任意（無くても起動するが該当機能が動かない）

| リソース | 無い場合 |
|---------|---------|
| **Vercel Blob** | 免許証写真のアップロードが「この環境では写真のアップロードをご利用いただけません。」表示になる（F-009） |
| **Resend** | 申込・問い合わせの自動返信メールが飛ばない（F-010。`lib/mail.ts` は未設定なら送らずに戻る） |

拒否は `components/apply/LicensePhotoUpload.tsx:227` が行う。**`http(s)://` でない `uploadUrl` は
「成功したことにしない」**——バイトが 1 つも格納されていないのに「添付しました」と表示すると、
送信時の実体検証（`head()` が null）で必ず落ちるためである。**無言のデータ欠損は起きない。**

### F-009（免許証写真アップロード）は**デモの範囲外**（2026-07-31 決定）

利用者の判断により、本デモでは免許証写真のアップロードを提供しない。したがって
**Blob ストアは接続していない**（`BLOB_READ_WRITE_TOKEN` は未設定）。UI は上記のとおり
「この環境では写真のアップロードをご利用いただけません。」と明示するので、
**利用者が気づかないまま失敗する経路にはならない。**

ストア `driving-school-uploads`（`store_CO9vzkeFSVrNm8me` / チーム `style-elements`）は
空のまま残してある。提供する判断に変わったら、下記の未実装分と併せて着手すること。

### ⚠️ 提供する場合、トークンを入れるだけでは動かない

`createBlobStorageAdapter().createSignedUpload()`（`lib/storage.ts:247-252`）が返す `uploadUrl` は
`blob:<objectKey>` という**プレースホルダで、実在する PUT 先ではない**。上記の `http(s)://` 判定に
かかるので、ローカルアダプタと同じ拒否表示になる。

Vercel Blob へ実際にバイトを置くには、`@vercel/blob/client` の `upload()` と、サーバー側の
`handleUpload()` を受けるルートが要る。**どちらも未実装である**（`/api/uploads/handshake` も存在しない）。
`lib/storage.ts:225-231` の「実 Blob に対する実測は未実施」はこの意味であり、
**トークンを設定するだけでは F-009 は動かない。**

さらに、作成した Blob ストアは `access: "public"` である。public ストアは **URL を知っていれば
誰でも取得できる**。免許証画像の保存先として採用する前に、private の可否を確認すること。

CLI の `vercel blob store add` はストアを作れるが、**プロジェクトへの接続手順が対話式**で、
トークンも CLI からは取得できない。ダッシュボード（`https://vercel.com/style-elements/~/stores`）
か Vercel API の `POST /v1/storage/stores/<storeId>/connections` を使う。
Postgres と Upstash を Vercel 経由で作った場合、環境変数は**自動で注入される**ので手動投入は不要。

---

## 3. 環境変数（私が投入する）

`AUTH_SECRET` / `FORM_SESSION_SECRET` / `CRON_SECRET` は生成済み。**3つとも異なる値**である必要があり、
それも起動時に検証される（鍵の用途分離。片方の漏えいが両方に波及するのを防ぐため / tech-stack §4.6）。

```bash
# 秘密鍵（生成済みの値を投入）
vercel env add AUTH_SECRET production
vercel env add FORM_SESSION_SECRET production
vercel env add CRON_SECRET production

# Turnstile（あなたが取得した値）
vercel env add NEXT_PUBLIC_TURNSTILE_SITE_KEY production
vercel env add TURNSTILE_SECRET production

# 公開URL（デプロイ後に確定するので2回目のデプロイ前に設定）
vercel env add NEXT_PUBLIC_SITE_URL production

# seed 用（管理者アカウント）
vercel env add ADMIN_EMAIL production
vercel env add ADMIN_NAME production
vercel env add ADMIN_PASSWORD production
```

### 本番必須キーの一覧（`lib/env.ts` の `PRODUCTION_REQUIRED_KEYS`）

| キー | 無いと落ちる理由 |
|------|-----------------|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | KV 未設定のまま起動するとレート制限とセマフォが黙ってインメモリに落ち、インスタンスごとに別カウンタになって全体流量制御にならない |
| `FORM_SESSION_SECRET` | Cookie 署名鍵が無いと AC-RL-13(b) の必須化が成立しない |
| `CRON_SECRET` | バッチの認証が成立しない |
| `TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | CAPTCHA 検証が成立しない |
| `AUTH_SECRET` | 32文字以上必須（セッション JWT 署名） |

---

## 4. デプロイとマイグレーション

```bash
vercel --prod
```

**マイグレーションはデプロイ時に自動で走る。** `package.json` の `vercel-build` が
`prisma migrate deploy` を含んでおり、Vercel は `build` より `vercel-build` を優先する。

### なぜ手元から流さないのか

**Vercel は Marketplace 統合（Supabase / Upstash）が注入した秘密を CLI に一切渡さない。**
`vercel env pull` も `vercel env run` も、統合由来の変数は**空文字**で返す（手で `vercel env add`
したものだけ値が取れる）。実測で確認済み。したがって手元から
`prisma migrate deploy` を流すには Supabase の接続文字列を別途入手する必要があり、
Marketplace 経由だと Supabase 側のアカウントに直接ログインできないことがある。

Vercel のビルド環境には統合の変数が正しく注入されるので、そこで流すのが確実。

### ローカルビルドの DB 非依存性は壊していない

`build` は `prisma generate && next build` のままで、**`vercel-build` は Vercel だけが使う**。
「DB が停止していてもビルドが成功する」という性質（REV-102）はローカル・CI とも維持される。

> `migrate deploy` は適用済みのマイグレーションを飛ばすので、デプロイのたびに走っても問題ない。

### 管理者アカウントの作成（seed）

`lib/seed-guard.ts` が本番の seed を**既定で拒否**する（ハードコードされた資格情報が
本番に入る事故を防ぐため / SEC-012）。意図的に実行するときだけ明示オプトインする:

```bash
NODE_ENV=production ALLOW_PROD_SEED=1 \
  POSTGRES_URL=<本番の値> \
  ADMIN_EMAIL=<管理者メール> ADMIN_PASSWORD=<十分に強いパスワード> ADMIN_NAME=管理者 \
  pnpm db:seed
```

> ⚠️ **`admin_dev_pw` を本番に持ち込まないこと。** 開発用の値であり、
> `docs/dev-database.md` に平文で書かれている（＝GitHub で公開されている）。

---

## 5. デプロイ後の確認

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<公開URL>/
```

| 確認項目 | 期待 |
|---------|------|
| `/` `/courses` `/programs` `/schools` `/privacy` | 200 |
| `/apply` | 200（フォームセッション Cookie が発行される） |
| `/admin/login` | 200 |
| **`/admin/vibe`** | **302 → `/admin/login`**（未認証時）／認証済みなら 200 |
| `/api/admin/vibe` | 未認証は 302 または 403 |

**⚠️ 本番 404 ガードは撤去済み。** 以前この表は「404 でなければ設定を疑え」としていたが、
Vibe Coding を公開URLから使う判断（利用者の明示的な合意）により `NODE_ENV=production`
ガードを外した。**404 を期待して読むと、正常な状態を異常と誤判定する。**

この画面はコードを書き換えられる。到達可能である以上、**管理者セッション = デプロイ権限**である。
代わりに次の多層で守っている:

1. `GITHUB_DISPATCH_TOKEN` は `Actions: write` のみ——コードもワークフローも書き換えられない
2. ワークフローに `workflows: write` を与えない——エージェントが自分の規則を書き換えられない
3. `scripts/check-protected-paths.mjs` + type-check + unit + build を通らないと push されない
   （`tests/` を保護対象に含めるのが要——さもなくば「テストを弱める」のが最短経路になる）
4. Actions のログとコミット履歴が消せない監査証跡になる

---

## 6. 本番で必ず確認する運用前提

- **https であること。** Cookie は `__Host-` + `Secure` なので、http でホストされた瞬間に
  全利用者の Cookie が発行されず、全送信が Tier B になる（fail-closed で正しい挙動だが、
  「本番は必ず https」は明示的な前提 / Security 監査 §E-1）。
- **`TRUST_PROXY` を本番に設定しないこと。** Vercel では `VERCEL=1` により発信元軸が
  正しく解決される。前段が XFF を上書きしない構成で `TRUST_PROXY=1` を立てると
  クライアントが自分の IP を名乗れる（SEC-061 / SEC-069）。
- **orphan 回収の cron は登録済み**（`vercel.json` の `crons`、毎日 03:00 UTC = 12:00 JST）。
  orphan の保持は 24 時間（`RETENTION_PERIODS.orphanUploadHours`）なので、日次で足りる
  （最長でも 48 時間で回収される）。
  `/api/cron/orphan-uploads` は `withCronAuth` で守られ、未認証は 401 ではなく **404** を返す
  （削除バッチの所在を晒さない）。`CRON_SECRET` 未設定時も fail-closed で 404 になるため、
  **`CRON_SECRET` を本番に設定していないとバッチは永久に動かない。**
- **⚠️ 保持期間バッチ（写真 30日/180日・申込 3年・問い合わせ 1年）は未実装**（P3-d）。
  `/privacy` はこれらの期間を**利用者に約束して表示している**が、実際に削除するコードは
  まだ無い。`lib/retention.ts` は値の一元管理であって、削除の実行者ではない。
  **約束と実装の食い違いそのものが APPI 上の不履行になる**ので、P3-d で必ず塞ぐこと。
