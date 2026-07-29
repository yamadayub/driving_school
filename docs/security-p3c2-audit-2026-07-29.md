# セキュリティ監査 — P3-c2（F-009）+ Vibe Coding

## 監査日: 2026-07-29
## 対象 A: P3-c2（免許証写真アップロード）/ 対象 B: **Vibe Coding（未レビュー機能）**
## 判定者: Security Agent（`.claude/skills/security.md`）
## 方法: コード読解 + 独立検証。**ポート 3000 に触れるコマンド・ランナー起動は一切行っていない**

> **採番について**: `docs/security-p3c1-audit-2026-07-29.md` で **SEC-071〜074 を既に使用済み**である。
> ID の衝突は監査証跡を壊すため、本ファイルは **SEC-075 から**採番する。

---

## サマリー

| 区分 | Critical | High | Medium | Low |
|------|---------|------|--------|-----|
| **A: P3-c2（F-009）** | **0** | **0** | 1（SEC-079） | 1（SEC-080） |
| **B: Vibe Coding** | **1（SEC-075）** | **2（SEC-076 / 077）** | 1（SEC-078） | 1（SEC-081） |

| 判定項目 | 結論 |
|---------|------|
| P3c-11（署名URL / objectKey / マジックバイト / サイズ / orphan） | **すべてクローズ** |
| P3c-1（uploads の Tier D 軸） | **クローズ** |
| **SEC-067 の回復経路** | **サーバー側は完成。しかし到達する導線が無い**（§A-3）。**クローズしない** |
| AC-PII-5（下書きへの非保存） | **クローズ**（二重の網が両方とも実際に効いている） |
| **P3-d 着手** | **可**（A に起因するブロッカーは無い） |
| **Vibe Coding の是非** | **現状のままでの使用は推奨しない。** ただし**本番リリースはブロックしない**（§B-6） |

---
---

# 対象 A: P3-c2（F-009 免許証写真アップロード）

## A-1. P3c-11 — **すべてクローズ**

| 要件 | 実装 | 判定 |
|------|------|------|
| 署名付き URL の有効期限 | `UPLOAD_URL_EXPIRES_IN_SEC = 300` / `UPLOAD_TOKEN_EXPIRES_IN_SEC = 600`。**token のほうが長い**のは「署名 URL 失効後も申込を送れるようにする」ため（`lib/upload-token.ts` に理由記載） | ✅ |
| `objectKey` の推測不可能性 | `private/lic/{side}/{128bit hex}`。**時刻も連番も PII も含まない。** `generateObjectKey(side)` は**引数が `side` だけ**で、ファイル名や氏名を材料にできない形が**型で**担保されている | ✅ |
| マジックバイト検証 | `detectImageType` が JPEG / PNG / WebP を先頭 12B で判定。**`RIFF` だけで WebP と判定せず 8B 目の `WEBP` も見る**（WAV / AVI を弾く）。`matchesDeclaredContentType` が**申告と実体の一致**を要求し、SVG は許可リストに無い | ✅ |
| サイズ上限のサーバー強制 | 発行時 `isDeclaredSizeAcceptable`（**`typeof`・整数・1 以上**まで見るので `size: -1` が通らない）+ 格納後 `head()` の**実サイズ**再検証 | ✅ |
| orphan 回収 | `ORPHAN_BATCH_MAX_PER_RUN = 200` を **SQL の `take` へ渡す**（全件取得後に切らない）。`expiresAt asc` で古い順。**Blob → DB の順序**。1 件の失敗で全体を止めず `failed` として**次回へ持ち越す**。例外を投げない。`reachedLimit` で残存を通知 | ✅ |
| orphan の**到達性** | `app/api/cron/orphan-uploads/route.ts` が `withCronAuth` で結線済み。**「到達しない受け口」になっていない** | ✅ |

**特に評価する点**: 「署名付き PUT はストレージへ直接行われるため、**サーバーはバイト列を一度も見ないまま格納が完了する**」という構造を正しく認識し、実体検証を**申込送信時**（格納後）に置いている。検証に失敗したオブジェクトはその場で `deleteObject` される。

**残余（実装者が自己申告済み。監査として追認する）**:
- **polyglot は先頭 12B 検証では検出できない。** 補償 (a)(b) は実装済みだが、**(c)（F-018 の閲覧経路に `X-Content-Type-Options: nosniff` と `Content-Disposition: attachment`）は F-018 へ持ち越し**である。**F-018 着手時の必須条件として本監査でも再掲する。**
- **Vercel Blob アダプタは実機未検証**（`createBlobStorageAdapter`）。unit / integration / E2E のいずれもこの経路を通っていない。→ SEC-079。

## A-2. P3c-1（uploads の Tier D 軸）— **クローズ**

`app/api/uploads/license/route.ts` の **POST / DELETE の両方**が
`limiters: { source, formSession }` + `formSessionKey` + `verifyFormSession` を渡している。
縮退構成で enforce される軸（Cookie 軸）が残る。`UPLOADS_FORM_SESSION_LIMIT = 12` は
境界値表の最悪ケース 8 を上回り、上界 16 を超えない。

**加えて SEC-058（構築時検査）が背後で効いている**——仮に `formSession` を渡し忘れれば
`withPublicMutation` が**構築時に throw** する。P3-c1 で入口条件を全構成へ広げた判断が、
ここで実際に機能する形になっている。

**IDOR 防御も正しい**: DELETE は `objectKey` を受け取るが**照合にしか使わず**、削除は
`record.objectKey`（DB から引いた値）に対してのみ行う。`verifyUploadTokenBinding` は
未存在 / 期限切れ / 消費済み / 不一致を**すべて同じ `false`** にし、シグネチャが `boolean` に
固定されているので呼び出し側が理由で分岐できない。単回使用は申込送信時に
`updateMany({ where: { id, consumed: false } })` の**条件付き更新 + `count !== 1` で例外**という
形で原子的に行われており、二重消費のレースが閉じている。

## A-3. SEC-067 の回復経路 — **サーバー側は完成。到達する導線が無い**

### 完成している部分（過小報告にしないための明示）

`POST /api/form-session` が新設され、私が P3-c1 監査で**唯一最大のリスク**として挙げた
「`challengeToken` を無検証で結線すると SEC-057 が 1 行で再開する」は**回避されている**:

```ts
const passed = await verifyTurnstile(captchaToken, { secret: ... })
if (!passed) return tierB()          // ← 検証が先
...
challengeToken: typeof captchaToken === 'string' ? captchaToken : undefined
```

**サーバー側で検証してから渡している。** 増幅率 1（同一トークンの再利用は「未通過」扱い）も維持。
`endpoint` を `applications` と分けた判断（回復の試行が申込送信の発信元軸を食わないように）と、
`verifyFormSession: () => true` を選んだ理由（(a) 渡さないと縮退で全 Tier B ＝ 直そうとした
ループの再現 / (b) `verifyFormSessionValue` を使うと**回復が必要な人だけが弾かれる**）は
**いずれも正しい**。3 択を明示的に比較した記録も適切である。

### 完成していない部分（過大報告にしないための明示）

**この受け口を呼ぶクライアントコードが 1 行も存在しない。**

```
$ grep -rn "api/form-session" components/ app/ --include=*.tsx --include=*.ts
  → GET へのリダイレクト（app/(public)/apply/page.tsx）のみ。POST の呼び出しはゼロ
```

印の付いた利用者が送信すると Tier B（403 + `challenge`）が返るが、クライアントは
RV-P3B-008 の自動再送を 3 回試して失敗し、RV-P3B-009 で電話番号を表示するだけである。
**`POST /api/form-session` に Turnstile トークンを送る導線はどこにも無い。**

これは実装記録自身が着手前に書いた
**「このプロジェクトが 6 回踏んだ型」の 4 段階目（そもそも到達しない受け口）そのもの**である。
`lib/orphan-uploads.ts` については同じ型を正しく回避（cron ルートを作った）しているのに、
回復経路では踏んでいる。

### 判定

> **SEC-067 はクローズしない。** サーバー側の契約は完成し、私が指摘した最大のリスクも
> 回避されたが、**利用者が印から抜ける道は依然として存在しない。**
> 重大度は **Medium 据え置き**（縮退構成限定・可用性のみ・10 分の固定窓・電話導線あり）。
> **残っているのはクライアント結線 1 点のみ**であり、P3-d のスコープで拾えば足りる。

## A-4. AC-PII-5（`uploadToken` / `objectKey` を下書きに保存しない）— **クローズ**

**二重の網が両方とも実際に効いていることを確認した**（「列挙はあるが呼ばれない」ではない）:

1. **構造的な網**: `objectKey` / `uploadToken` は `LicensePhotoUpload.tsx` の
   コンポーネント状態にのみ置かれ、`ApplicationForm.tsx` の `values` に入らない
   （`:161` / `:539` に「`sessionStorage` へ出る経路をそもそも作らない」と明記）。
2. **サニタイザの網**: `ApplicationForm.tsx:220-225` が
   **`toDraftSnapshot(...)` を通してから** `sessionStorage.setItem` している。
   `DRAFT_FORBIDDEN_KEYS`（`objectKey` / `uploadToken` / `previewUrl` / `licensePhotos` /
   `captchaToken`）に加え、**値の形**（`blob:` / `data:` 接頭辞）でも落とす二重構造。
   `isDraftStorageAllowed` は `session` 以外を拒否する。

> **`toDraftSnapshot` が書き込み経路で実際に呼ばれていることをソースで確認した。**
> ここが呼ばれていなければ `DRAFT_FORBIDDEN_KEYS` は死んだ列挙であり、
> 「二重の網」という記述が事実に反することになる。**呼ばれている。**

※ 実装記録は「`useRef` に置く」と書いているが実際は `useState` である。
セキュリティ上の性質（永続化しない）は同一なので**指摘ではなく記録の差異**として記す。

## A-5. 新規指摘（A）

### [SEC-079] Vercel Blob アダプタが一度も実行されていない（Medium）

- **場所**: `lib/storage.ts` `createBlobStorageAdapter`
- **説明**: 実装者が正直に自己申告しているとおり、**実 Blob に対する実測が無い**。
  unit / integration / E2E はすべてローカルアダプタを通る（`sharedStorage()` は
  `BLOB_READ_WRITE_TOKEN` の有無で分岐）。
- **なぜセキュリティ指摘なのか**: このアダプタが動かなければ
  `deleteObject` が失敗する ⇒ **orphan 回収が永久に進まない**（＝ 同意に紐付かない
  免許証画像がストレージに残り続ける / APPI 上の不履行）。`readPrefix` の Range 要求が
  期待どおり動かなければ **マジックバイト検証が `null` を返して全画像が拒否される**か、
  最悪の場合検証を素通りする。**可用性ではなく機密性・法令遵守に直結する。**
- **修正方針**: 本番で使う前に `put → head → readPrefix → delete` の一巡を実機で確認すること
  （実装者自身が同じ結論をコメントに書いている）。**Blob を有効化する変更と同じ単位で行うこと。**

### [SEC-080] ローカルアダプタのキー平坦化が衝突しうる（Low / 開発環境限定）

- **場所**: `lib/storage.ts` `localPathFor`
- **説明**: `objectKey` の `/` を `__` へ畳むため、`a/b` と `a__b` が**同じファイル**に写る。
  現状 `deleteObject` / `head` / `readPrefix` へ渡るキーは
  `verifyUploadTokenBinding` 通過後の **DB 由来の値**に限られるので**到達不能**だが、
  将来キーを直接受け取る経路（F-018 の閲覧など）を足すと、
  攻撃者が平坦化後に一致する文字列を送って**他人のオブジェクトを削除・読取**できる。
- **修正方針**: 平坦化ではなくセグメントごとの検証 + `path.relative` による封じ込めにする。
  **本番（Blob）には影響しない**ので優先度は低い。

---
---

# 対象 B: Vibe Coding（**未レビュー機能**）

## B-0. 前提の確認

主張されている 4 層のうち、**3 層は実際に機能している**:

| 層 | 検証結果 |
|----|---------|
| 1. `withAdminMutation`（管理者セッション + Origin 検証） | ✅ 機能する |
| 2. **本番 404**（`NODE_ENV === 'production'` / ページと API の両方） | ✅ **機能する。** Next.js は `process.env.NODE_ENV` を**ビルド時にインライン展開**し、`next build` は NODE_ENV を production に固定するため、本番バンドルでは当該分岐が**定数畳み込みされて到達不能コードになる**。`VERCEL` ではなく `NODE_ENV` を選んだ判断は正しく、SEC-069 の教訓が正しく適用されている |
| 3. 共有シークレット `x-vibe-secret` | ✅ 機能する。**CSRF 防御として実際に load-bearing である**——悪意あるページが `127.0.0.1:4319` へ `text/plain` の単純リクエストを投げても、カスタムヘッダはプリフライトを誘発し、ランナーは `OPTIONS` に 404 を返すのでブロックされる |
| 4. 127.0.0.1 bind + 書き込み先の限定 | **bind は ✅。書き込み先の限定は ❌**（§B-1〜B-3） |

`isAllowedWrite` の**パス解決そのものは堅牢**である。独立に検討した結果:
`path.resolve` が先に正規化するので `..` は無害化され、`rest` に `..` が混入する経路も無い
（`path.basename` は正規化済み絶対パスから `..` を返さない）。実在する最も近い祖先まで
遡って `realpath` する形はシンボリックリンク脱出も塞ぐ。**Windows パス・トラバーサル・
リンク脱出のいずれでも破れなかった。** ここは正しく書かれている。

**問題は「パスの解決」ではなく「許可リストの範囲」と「許可した先で何が起きるか」である。**

## B-1. [SEC-075] **Critical** — 品質ゲート自身がエージェントの書いたコードを実行する

- **重大度**: **Critical**（「Bash を一切許可しない」という中核の防御が**完全に無効化される**）
- **場所**: `runner/server.mjs` `WRITABLE_FILES` / `runGate('pnpm', ['test:unit'])`
- **攻撃経路**（**すべてリポジトリ内の事実で裏付けた**）:

  1. `WRITABLE_FILES` に **`lib/design-tokens.ts`** が含まれる。
     プロンプトは**明示的に**「色・余白・角丸・影を変える場合は `lib/design-tokens.ts` を編集してください」と
     エージェントに指示している ⇒ **正常系で必ず書き換わるファイルである。**
  2. `tests/unit/design-tokens.test.ts:2-11` は
     `import { colors, ... } from '@/lib/design-tokens'` と**実 import** している
     （`tests/unit/badge.test.ts:3` も同様）。
  3. ランナーは変更後に**自分で** `pnpm test:unit` を実行する。
     `vitest.config.ts` の `include` は `tests/unit/**/*.test.ts` なので上記 2 ファイルが必ず走る。
  4. ⇒ **エージェントが `lib/design-tokens.ts` のトップレベルに書いた任意のコードが、
     ランナー自身の品質ゲートによって Node の完全な権限で実行される。**
     `child_process` / ネットワーク / `~/.ssh` / `.env` に無制限に到達できる。

- **なぜ致命的か**: この機能の設計コメントは
  > 「**Bash は一切許可しない。** 品質ゲートはランナー自身が実行する。」

  と書いているが、**その品質ゲートが実行媒体になっている。** 人間の操作を 1 つも必要とせず、
  1 リクエストの中で完結する。`canUseTool` による deny-by-default も、Bash の禁止も、
  **書き込みが許された時点で意味を失う**——書かれたものが実行されるからである。
- **副次経路**: `tailwind.config.ts`（同じく `WRITABLE_FILES`）は
  `pnpm dev` / `pnpm build` 時に**設定として評価される**。ゲートでは実行されないが、
  **開発者が見た目の変更を確認するために `pnpm dev` を叩いた瞬間**に実行される。
  「見た目を変えたので確認する」はこの機能の**唯一の正常な使い方**であり、回避されない。
- **修正方針**（いずれか。1 が最も確実）:
  1. **ゲートを別プロセス・別権限で走らせない限り、`lib/design-tokens.ts` を書き込み可から外す。**
     色を変えたいなら「トークンの値だけを JSON で受け取り、ランナーが検証して書く」形にする
     （エージェントに**コードを**書かせない）。
  2. ゲートをネットワーク遮断・読み取り専用 FS のサンドボックス（コンテナ）で実行する。
  3. 書き込み後に**構文木を検査**し、import / require / トップレベル副作用を含む差分を拒否する
     （回避されやすいので単独では不十分）。
- **参考**: CWE-94（Code Injection）/ CWE-829（Inclusion of Functionality from Untrusted Control Sphere）。

## B-2. [SEC-076] **High** — `app/` を書き込み可にしたことで認証・認可コードが書き換え対象に入る

- **場所**: `runner/server.mjs` `WRITABLE_DIRS = ['components', 'app']` / `DENIED_PATTERNS`
- **説明**: `DENIED_PATTERNS` が除外するのは `^app/api/` と `route.ts$` と `middleware.ts$` の 3 つだけである。
  **`page.tsx` / `layout.tsx` / Server Action ファイルは除外されていない。**
  リポジトリの実際の内容を確認した結果、以下が**すべて書き込み可**である:

  | ファイル | 中身 | 書き換えられると |
  |---------|------|----------------|
  | `app/admin/(app)/layout.tsx` | **`await requireAdmin()`**（管理画面全体の認証ガード） | **管理画面の認証が消える**（コメントが謳う「middleware ＋ requireAdmin の二重ガード」の片方） |
  | `app/admin/(app)/auth-actions.ts` | **`'use server'`** — Server Action | **クライアントから呼べる任意のサーバーコードを書ける**（Next.js の Server Action は公開エンドポイントと等価） |
  | `app/(public)/apply/page.tsx` | フォームセッション検証と `/api/form-session` への誘導 | P3-a〜P3-c1 で積み上げた Tier B / 軸の入口が消える |
  | `app/admin/(app)/vibe/page.tsx` | **この機能自身の本番ガード** | エージェントが自分のガードを外せる |

- **したがって「見た目だけを変更する」という前提は成立していない。**
  プロンプトで「ロジック・認証・レート制限に触れないでください」と指示しているが、
  **これは指示であって強制ではない。** このプロジェクトは
  「名指しの警告コメントでは 4 度止められなかった」（SEC-043 / `lib/form-session.ts:44`）と
  自ら結論し、**型による強制**へ移行した経緯がある。同じ基準をここへ適用すべきである。
- **修正方針**: 許可リストを**ホワイトリスト方向で狭める**:
  - `app/` をディレクトリごと許可しない。どうしても必要なら
    `DENIED_PATTERNS` に `/layout\.tsx$/` `/page\.tsx$/`（または `'use server'` を含むファイル）を足すのではなく、
    **`components/` のみを許可**し、ページの見た目はコンポーネント経由で変える設計にする。
  - 併せて、書き込み対象に `'use server'` ディレクティブが含まれる場合は**無条件で拒否**する。

## B-3. [SEC-077] **High** — 読み取りツールに一切のパス制限が無い（秘密の持ち出し）

- **場所**: `runner/server.mjs` `canUseTool` の `if (READ_TOOLS.has(name)) return true`
- **説明**: `isAllowedWrite` は**書き込みツールにしか適用されない。**
  `Read` / `Glob` / `Grep` は**パスを一切検査せず無条件に許可**される。
  `cwd` は `REPO` だが、これらのツールは絶対パスを受け取れるため
  **ローカルファイルシステム全域が読める**:
  - `.env` — `AUTH_SECRET` / `FORM_SESSION_SECRET` / `CRON_SECRET` / `DATABASE_URL` /
    `RESEND_API_KEY` / `BLOB_READ_WRITE_TOKEN` / `VIBE_RUNNER_SECRET` そのもの
  - `~/.ssh/id_*` / `~/.aws/credentials` / ブラウザプロファイル
- **持ち出し経路が揃っている**: 読んだ値を `components/**`（書き込み可）へ書き、
  ランナーが `git add -A` + `git commit` で**自動コミットする**。
  以後そのブランチを push すれば外部へ出る。**読み・書き・永続化が 1 リクエストで完結する。**
- **修正方針**: `isAllowedWrite` と同じ実パス解決を**読み取りにも適用**し、
  最低でも「`REPO` の内側」に制限する。`.env` / `.git` / `node_modules` は明示的に除外する。
  現状のコメントは「書き込み先を軽量レーンに限定する」としか書いておらず、
  **読み取りが無制限であることがどこにも記されていない**のも問題である。

## B-4. [SEC-078] **Medium** — 多層防御の主張が実態と食い違う / ランナーにテストが 1 件も無い

- **場所**: `app/api/admin/vibe/route.ts:25` / `runner/server.mjs:12-24`
- **説明**: ルートのコメントは
  > 「いずれか 1 つが破られても**即座に任意コード実行にはならない**形にしてある。」

  と主張するが、**層 1（管理者セッション）だけが破られれば SEC-075 により
  即座に任意コード実行が成立する**（層 2 は開発環境では無効、層 3・4 は
  正規の管理画面経由の要求には最初から通る）。
  多層防御は「独立な層」であって初めて成立するが、**層 2〜4 は層 1 の後段に直列**であり、
  層 1 を通った要求に対して追加の制約を課していない。
- **併せて**: `tests/unit/` に **Vibe 関連のテストが 1 件も無い**（`ls tests/unit | grep -i vibe` → 0 件）。
  オーケストレーターが手元で確認したという `isAllowedWrite` の 20 ケースは
  **リポジトリに回帰テストとして残っていない。** このプロジェクトの他の全機能が
  「契約をテストで固定する」規律を守っているなかで、**最も危険な機能だけが無防備**である。
- **修正方針**: 主張を実態に合わせて書き直すこと（誤った安心の記録を残さない）。
  `isAllowedWrite` の 20 ケースを `tests/unit/vibe-runner-allowlist.test.ts` として残すこと
  （`runner/server.mjs` は `import.meta` ガードで listen しない作りになっており、import 可能である。
  ただし**モジュール評価時に `SECRET` 未設定で `process.exit(1)` する**ので、
  テスト側で環境変数を立てるか、この副作用を関数内へ移す必要がある）。

## B-5. [SEC-081] **Low** — 共有シークレットの扱い

- **定数時間比較でない点（`!==`）**: **この文脈では実害が小さい。** 攻撃には
  ループバックへの到達が既に必要で、その時点で `.env` を読むほうが速い。
  **指摘としては Low に留める。**
- **より実際的な問題**: `VIBE_RUNNER_SECRET` は `.env.example` で**空**であり、
  **生成方法の案内も最低長の検証も無い。** 比較すると `FORM_SESSION_SECRET` /
  `CRON_SECRET` は `lib/env.ts` が本番 32 文字以上を強制している。
  ランナーは「未設定なら起動しない」だけで、**`secret` のような弱い値でも起動する。**
- **修正方針**: `.env.example` に生成コマンド（`openssl rand -hex 32`）を併記し、
  ランナー起動時に最低長を検査する。定数時間比較への変更は**やって損は無い**が優先度は低い。

## B-6. **この機能を入れること自体の是非**

### 判定: **本番リリースはブロックしない。ただし現状のままでの使用は推奨しない。**

**リリースをブロックしない理由**（過大報告を避ける）:
- 本番バンドルでは `NODE_ENV === 'production'` が**ビルド時に畳み込まれ**、
  API・ページとも到達不能になる。この判定を `VERCEL` ではなく `NODE_ENV` で行った選択は
  **SEC-069 の教訓の正しい適用**であり、監査として明確に評価する。
- ランナーは**デプロイ対象に含まれない**別プロセスであり、ループバック bind + 共有シークレットで
  外部から到達できない。
- したがって **P3-d / 本番リリースの判定に対して、この機能は影響しない。**

**使用を推奨しない理由**（過小報告を避ける）:
- SEC-075 により、**この機能を 1 回使うたびに、エージェントが書いたコードが
  開発者のマシンで無条件に実行される。** これは「AI がコードを書く」ことのリスクではなく、
  **「書かれたコードを検査前に実行する」という設計のリスク**である。
- 開発者のマシンには本番の `DATABASE_URL` / `AUTH_SECRET` / `BLOB_READ_WRITE_TOKEN` が
  `.env` に存在しうる。SEC-077 と組み合わさると**本番資格情報の持ち出しが 1 リクエストで成立する。**

**使用を再開してよい条件**（最小限）:
1. **SEC-075**: `lib/design-tokens.ts` を書き込み可から外す、**または**ゲートをサンドボックスで実行する。
2. **SEC-077**: 読み取りを `REPO` 内へ制限し、`.env` / `.git` を除外する。
3. **SEC-076**: `app/` を許可リストから外す（`components/` のみにする）。
4. **SEC-078**: `isAllowedWrite` の回帰テストをリポジトリに置く。

1〜3 はいずれも `runner/server.mjs` の**定数 2 つと分岐 1 つ**の変更で足りる。
**この機能の設計思想（`canUseTool` で自前判定・実パス解決・Bash 不許可・ブランチ分離・
本番で経路ごと削除）は正しい。** 欠けているのは「許可した範囲の内側で何が実行されるか」の
評価だけである。

---

## P3-d 着手可否

### **着手可。** 対象 A に起因する Critical / High は 0 件。

- P3c-11 / P3c-1 / AC-PII-5 はすべてクローズ。orphan 回収は cron ルートまで結線済みで、
  「到達しない受け口」になっていない。
- **SEC-067 はクローズしないが、P3-d のブロッカーにはしない。**
  残っているのは**クライアント結線 1 点**（Tier B を受けたときに Turnstile を提示して
  `POST /api/form-session` を呼ぶ）であり、サーバー側の契約は完成している。
  **P3-d のスコープで拾うこと**を条件として申し送る。
- **SEC-079（Blob 未検証）は、Blob を有効化する単位のブロッカーとする。**
  ローカルアダプタでしか動作確認できていない状態で本番の免許証画像を扱ってはならない。

### P3-d への申し送り

1. **SEC-067 のクライアント結線**（上記）。これを入れて初めて SEC-067 をクローズできる。
2. **F-018 着手時に polyglot の補償 (c)**（`nosniff` + `Content-Disposition: attachment`）を必ず入れること。
   `lib/upload-validation.ts` の冒頭コメントが持ち越し条件として明記している。
3. **Blob の実機一巡確認**（SEC-079）。
4. **Vibe Coding は SEC-075 / 076 / 077 を直すまで使用しないこと。** リリースはブロックしないが、
   使うたびに開発者のマシンで未検査のコードが実行される。

---

## 付記: 記録の正確性

実装記録 `docs/impl-p3c2-notes-2026-07-29.md` の「未解決 1 件（`uploads-cost.int.ts`）」と
「未実装 1 件（UI と E2E）」は、**現在の実測（integration 114 件 / e2e 180 passed /
`components/apply/LicensePhotoUpload.tsx` の存在）と食い違う**——いずれも記録作成後に解消されている。
P3-c1 のときと同じ「記録が実態に追いつかない」パターンなので、
完了報告へ転記する際は現状に合わせること。

実装記録の**自己申告の質そのものは高い**（Blob 未検証の明示、変異による検算、
`objectKey` の乱数部に年号が現れる確率まで記録）。本監査が A について短時間で
判定できたのはその記録の具体性による。
