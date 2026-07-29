# 開発用データベース（ローカル Postgres）

岩滝・網野自動車教習所デモの開発用DBのセットアップ手順・接続情報・投入データの記録。

> 対象は **開発専用**。ここに書かれた資格情報はダミー（開発用）で本番では使用しない。
> `.env` は `.gitignore` 済みでコミットしない。

## 1. 構成

| 項目 | 値 |
|------|----|
| 方式 | Docker コンテナ `postgres:16` |
| コンテナ名 | `driving_school_pg` |
| ホスト側ポート | `5433`（→ コンテナ `5432`） |
| DB名 | `driving_school` |
| ユーザー | `driving` |
| パスワード | `driving_dev_pw`（開発用ダミー） |
| データ永続化 | Docker volume `driving_school_pgdata` |

> ローカルは `libpq`（クライアントのみ）で `postgres` サーバーバイナリが無いため Homebrew ローカル起動は不可。Docker を使用。
> 単一 Postgres（pgbouncer なし）のため、Prisma の 3 キーはすべて同一の直結 URL を指す。

### 接続URL（`.env` に設定済み）

```
POSTGRES_URL="postgresql://driving:driving_dev_pw@localhost:5433/driving_school?schema=public"
POSTGRES_URL_NON_POOLING="postgresql://driving:driving_dev_pw@localhost:5433/driving_school?schema=public"
POSTGRES_PRISMA_URL="postgresql://driving:driving_dev_pw@localhost:5433/driving_school?schema=public"
```

- `schema.prisma` は `POSTGRES_PRISMA_URL`（url）と `POSTGRES_URL_NON_POOLING`（directUrl）を参照する。

## 2. 起動・停止

前提: Docker Desktop 起動済み（`open -a Docker`）。ヘルパスクリプト `scripts/dev-db.sh` を用意。

```bash
scripts/dev-db.sh up       # コンテナ起動（イメージpull含む・冪等）
scripts/dev-db.sh status   # 稼働確認
scripts/dev-db.sh psql     # psql シェルに入る
scripts/dev-db.sh down     # 停止（データ volume は保持）
scripts/dev-db.sh reset    # コンテナ+volume削除（データ全消去）
```

手動で起動する場合:

```bash
docker run -d --name driving_school_pg \
  -e POSTGRES_USER=driving -e POSTGRES_PASSWORD=driving_dev_pw -e POSTGRES_DB=driving_school \
  -p 5433:5432 -v driving_school_pgdata:/var/lib/postgresql/data postgres:16
```

## 3. マイグレーション・シード

```bash
pnpm db:migrate   # prisma migrate dev（初回 init 済み）
pnpm db:generate  # prisma generate（build に内包）
pnpm db:seed      # 実データ投入（冪等）
```

- 初期マイグレーション: `prisma/migrations/20260726131256_init/`
- `pnpm db:seed` は再実行しても重複しない（マスタは deleteMany→create、AdminUser は email upsert）。
- クリーン再構築: `scripts/dev-db.sh reset && scripts/dev-db.sh up && pnpm db:migrate && pnpm db:seed`

## 4. 投入データ（seed の内容）

データ源: `docs/current-site-analysis.md`。件数は最新 seed 実行時点。

| エンティティ | 件数 | 内訳 |
|------------|------|------|
| Course | 17 | LICENSE=11（通学10 + 合宿1）, DRONE=2, KENKI=1, ADDITIONAL=3 |
| Faq | 11 | SCHOOL=4, COURSE=2, PAYMENT=1, OTHER=4 |
| News | 6 | IWATAKI=1, AMINO=1, DRONE=1, KENKI=1, COMMON=2（全 PUBLISHED） |
| SupplementalChatRule | 5 | COURSE=2, ACCESS=3 |
| AdminUser | 1 | デモ管理者 |

- **通学9種**（普通車 AT/MT の2レコード + 準中型/中型/大型/普通二種/大型特殊/けん引/大型二種/普通自動二輪）。料金・最短日数は現行サイト表記に準拠。
- **給付金/助成金タグ**: プロ免許系に `教育訓練給付金`、ドローン/建機に `助成金対象`。
- **合宿（REV-009）** とスクール系/追加講習の料金・日数は現行調査に出典が無いため `【デモ用参考値】` ラベルを `description` に明記したダミー値（合計7コース）。
- **SchoolInfo は DB モデルではない**: 校舎情報は `lib/school-info.ts` に定数として保持（tech-stack のDB一覧に SchoolInfo 無し・functional §4.8 方針）。seed 対象外。アクセス補助は `SupplementalChatRule`（sourceType=ACCESS）で提供。

## 5. デモ用管理者資格情報

`.env` の以下の値を seed が読み込み、`AdminUser` に投入する（パスワードは scrypt でハッシュ化して保存: 形式 `scrypt$<saltHex>$<hashHex>`）。

| キー | 値（開発用ダミー） |
|------|-------------------|
| `ADMIN_EMAIL` | `admin@iwataki-driving-school.demo` |
| `ADMIN_NAME` | `デモ管理者` |
| `ADMIN_PASSWORD` | `admin_dev_pw` |

> F-012 認証は未実装（`auth.ts` は providers 空）。ハッシュ方式は F-012 実装時に確定する（現状は scrypt）。

## 6. 検証結果（2026-07-26）

- `prisma migrate dev --name init`: 成功（`20260726131256_init` 適用）。
- `pnpm db:seed`: 成功。再実行で件数不変（冪等性確認済み）。
- `pnpm type-check`: パス。
- `pnpm build`: パス（`prisma generate` + `next build`）。

## 7. 残課題 / 注意

- 合宿・スクール系・追加講習の実料金/日数は未確定（`【デモ用参考値】`）。現行 `/camp/` `/drone/` `/construction/` 等の調査で後日更新。
- 校舎情報（住所・電話・SNS 等）は `lib/school-info.ts` に未入力の項目あり（postalCode/phone/geo 等）。DB ではなく定数側の拡充が必要。
- F-012 認証方式確定後、`passwordHash` のハッシュ方式（scrypt/bcrypt/argon2）を再確認。
