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
| **Vercel Blob** | 免許証写真のアップロードが「この環境では利用できません」表示になる（F-009） |
| **Resend** | 申込・問い合わせの自動返信メールが飛ばない（F-010） |

Blob は Vercel ダッシュボード → Storage → Create → Blob で `BLOB_READ_WRITE_TOKEN` が得られる。
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
vercel --prod                                   # デプロイ
POSTGRES_URL_NON_POOLING=<本番の値> pnpm exec prisma migrate deploy
```

マイグレーションは**接続プーラを経由しない URL**（`POSTGRES_URL_NON_POOLING`）で流す。
プーラ経由だと DDL が失敗することがある。

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
| **`/admin/vibe`** | **404** ← 本番では経路ごと消える（`NODE_ENV=production` ガード） |
| `/api/admin/vibe` | **404** ← 同上 |

**`/admin/vibe` が 404 でなければ設定を疑うこと。** この画面はコードを書き換える機能であり、
公開URLから到達できる状態は監査が「設計上の RCE」と評価したものそのものである。

---

## 6. 本番で必ず確認する運用前提

- **https であること。** Cookie は `__Host-` + `Secure` なので、http でホストされた瞬間に
  全利用者の Cookie が発行されず、全送信が Tier B になる（fail-closed で正しい挙動だが、
  「本番は必ず https」は明示的な前提 / Security 監査 §E-1）。
- **`TRUST_PROXY` を本番に設定しないこと。** Vercel では `VERCEL=1` により発信元軸が
  正しく解決される。前段が XFF を上書きしない構成で `TRUST_PROXY=1` を立てると
  クライアントが自分の IP を名乗れる（SEC-061 / SEC-069）。
- **cron の登録が未実装**（SF-2）。保持期間バッチと orphan 回収は P3-d で
  `vercel.json` の `crons` に登録する。現状は**本番で一度も走らない**。
