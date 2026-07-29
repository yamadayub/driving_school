# P3-c2（F-009 免許証写真アップロード本体）テスト設計

## 作成日: 2026-07-29
## 担当: Test Agent（`.claude/skills/test.md`）
## 状態: **作成中**（1 項目ごとに追記する。まとめ書きはしない）

## 入力
- `docs/functional-spec.md` F-009（行 546-673）/ §4.11 / §4.12（範囲読み）
- `docs/security-audit.md` §F（行 3237-3282。**範囲読み**）
- `docs/ui-design/license-upload.md`
- `docs/phase-status.md` 末尾「P3-c2 の完了条件（申し送り）」
- `docs/review-p3c1-code-re-2026-07-29.md` §5（P3-c2 への申し送り）
- `docs/test-design-p3c1-2026-07-29.md`（前単位。§12.3 / §12.5 が本単位へ繰り越した項目）

## ベースライン（退行させない）
**unit 827 件 / integration 87 件 / e2e 166 件 が全パス。**

---

## 0. スコープ

| # | 内容 | 状態 |
|---|------|------|
| P3c-11 | F-009 本体（署名付き URL の期限 / `objectKey` の推測不可能性 / マジックバイト検証 / サイズ上限のサーバー強制 / orphan 回収） | 着手 |
| P3c-1 | SEC-057 の修正を `uploads` 経路へ同じ形で適用 | 着手 |
| SEC-067 回復経路 | `challengeToken` の**結線**（P3-c1 から明示的に繰越した Must） | 着手 |
| RV-P3B-019 | 送信成功を通す E2E が 1 本も無い。**「上限を緩める」ではなく「軸を分ける」形で解く** | 着手 |
| AC-PII-11 | orphan 回収バッチの件数上限 200 / ページング / べき等性 | 着手 |
| AC-PII-5 / F-018 準備 | `uploadToken` を下書きに保存しない網が実際に効くことを E2E で固定 | 着手 |

## オーケストレーターが確定させた前提（設計の所与）

1. **`lib/storage.ts` はアダプタ構成にする。** ローカル実装（ファイルシステム）と Vercel Blob 実装を
   同一インターフェースの裏に置き、**unit / integration / E2E はローカル実装で完走できること**を前提にする
   （外部アカウント不要。KV の `memory://` 縮退・Postgres のローカル Docker と同じ形）。
2. **E2E の WebKit は `uploads` 系スペックの対象外。** WebKit は `http://localhost` で
   `__Host-`(Secure) Cookie を受理せず**常に「Cookie 無し」経路**を走るため、
   Cookie 軸に依存する uploads の防御を検証できない。`test.skip(browserName === 'webkit', ...)` に
   **理由をコード内に残す**。HTTPS 化は中期課題として本書に記録する。
   **「3 ブラウザで green」と書いて実は 2 ブラウザ、という状態を作らない。**

---

## 1. 調査メモ（読み込み結果は以下の節に追記していく）

### 1.1 仕様側の確定値（`docs/functional-spec.md` F-009 / §4.12 より）

| 項目 | 確定値 | 出所 |
|------|--------|------|
| 署名付き PUT URL の有効期限 | **300 秒** | SPEC-003 / 境界値表 |
| `uploadToken` の有効期限 | **600 秒** | SPEC-003 |
| ファイルサイズ上限 | **5,242,880 B**（1B 〜） | 境界値表 / AC-009-4 |
| 許可形式 | JPEG / PNG / WebP | E-009-1 |
| マジックバイト | JPEG `FF D8 FF` / PNG `89 50 4E 47 0D 0A 1A 0A` / WebP `RIFF....WEBP` | AC-009-3 |
| 枚数 | 0〜2（表・裏各 1） | 境界値表 |
| 自動再発行 | **3 回 / スロット**、`visibilityState==='hidden'` 中は再発行しない | SPEC-009 / AC-009-11 |
| orphan 回収 | `consumed=false` かつ `expiresAt < now-24h`。**1 回 200 件上限** | AC-PII-8 / AC-PII-11 |

### 1.2 実装の現状

- `lib/storage.ts` は **38 行のスタブ**（3 関数がすべて `throw`）。アダプタ構成ではない。
- `prisma/schema.prisma` に `LicensePhoto`（:240）/ `UploadToken`（:255）は**既に定義済み**。
  `UploadToken` は `token @unique` / `objectKey` / `contentType` / `maxSize` / `consumed` / `expiresAt`。
- `lib/apply-draft.ts` は `DRAFT_FORBIDDEN_KEYS` に
  `objectKey` / `uploadToken` / `previewUrl` / `licensePhotos` / `captchaToken` を**既に列挙済み**
  （P3-b が「網を先に張った」もの）。**P3-c2 はその網が実際に効くことを E2E で固定する側**である。
- E2E の Playwright projects は chromium / firefox / webkit の 3 つ。

---

## 2. AC-009-1 / AC-009-2 / AC-009-8 — `lib/storage.ts` のアダプタ化と `objectKey`

**ファイル**: `tests/unit/storage-adapter.test.ts`（**17 件 / red 17 件**）

### なぜアダプタ構成が「テストの前提」なのか

現状の `lib/storage.ts` は Vercel Blob 直結を前提にしたスタブ（3 関数すべて `throw`）である。
このままだと**テストを書くのに外部アカウントが要る**——結果として
**unit / integration / E2E のどれも `uploads` の防御を一度も通らないまま P3-c2 が「完了」する。**
最も機微なデータ（免許証画像）を扱う経路でそれは受け入れられない。

KV（`memory://` 縮退）と Postgres（ローカル Docker）は既に同じ形を採っている。

### Impl が実装すべき契約

```ts
export const UPLOAD_URL_EXPIRES_IN_SEC = 300        // SPEC-003（確定）
export const UPLOAD_TOKEN_EXPIRES_IN_SEC = 600      // SPEC-003（確定）
export const MAX_LICENSE_PHOTO_BYTES = 5_242_880    // 境界値表（確定）
export const ALLOWED_IMAGE_CONTENT_TYPES: readonly string[]  // jpeg / png / webp のみ

export interface StorageAdapter {
  createSignedUpload(params): Promise<SignedUploadTarget>
  createSignedReadUrl(objectKey, expiresInSeconds?): Promise<{ url; expiresIn }>
  deleteObject(objectKey): Promise<void>
  head(objectKey): Promise<{ size: number } | null>          // AC-009-4(b)
  readPrefix(objectKey, bytes): Promise<Uint8Array | null>   // AC-009-3
  put?(objectKey, body, contentType): Promise<void>          // ローカル実装のテスト用
}
export function createLocalStorageAdapter(options?): StorageAdapter
export function createBlobStorageAdapter(): StorageAdapter
export function sharedStorage(): StorageAdapter
export function generateObjectKey(side: 'front' | 'back'): string
```

### 契約にした要点

| 契約 | これが green なら排除される事故 |
|------|-----------------------------|
| 200 回発行して 200 種類 | `objectKey` の推測で**他人の免許証画像へ到達**（非公開バケットでは推測不能性そのものがアクセス制御） |
| 乱数部 ≥ 22 文字（128bit 相当） | 短い乱数で総当たりが現実的になる |
| 連番でない / 時刻を含まない | 1 つ手に入れば全部読める / 発行時刻から推測できる |
| **`generateObjectKey` の引数は `side` だけ** | ファイル名・氏名を材料にでき、**キーとログに PII が残る**（AC-PII-1 違反）。「含めない」を**型で**担保する |
| クライアント指定 `objectKey` が効かない | 他人のオブジェクトの上書き / `../` によるバケット外書き込み / 既知キーの読み出し |
| `readPrefix` が要求バイト数までしか読まない | 検証のたびに **5MB×2 枚をメモリへ載せる**（SEC-059 と同じ原則を格納後の検証にも適用） |
| `head` / `readPrefix` が存在しないキーで **null**（例外にしない） | 未認証の第三者が任意に 500 を起こせる（SEC-042 / SEC-060 と同型） |
| 許可形式に `image/svg+xml` を含めない | **SVG は `<script>` を含めるため、閲覧側（F-018）で XSS になる** |

---

## 3. AC-009-3 / AC-009-4 — マジックバイトによる実体検証とサイズのサーバー強制

**ファイル**: `tests/unit/upload-validation.test.ts`（16 件）

> ⚠️ **red の形が他ファイルと違う。** `lib/upload-validation.ts` が**存在しない**ため
> import 解決に失敗し、**ファイル単位で red**（vitest の集計上は `no tests`）になる。
> `storage-adapter.test.ts` は対象モジュールが存在する（スタブ）ので named import が
> `undefined` に解決され、**16 件が個別に red** になるのと対照的である。
> 実装が入った時点で 16 件が個別に評価される——**その時に「意図した理由で green になったか」を
> 必ず確認すること**（P3-c1 §14 の REV-P3C1-010 と同じ手順）。

### なぜ実体検証が要るのか（構造上の理由）

署名付き PUT はストレージへ**直接**行われるため、
**サーバーはバイト列を一度も見ないまま格納が完了する。**
（AC-009-5 が「発行数の制限が唯一の帯域防御」と書いているのはこの構造のため。）
したがって「何が入ったか」は**格納後に読んで確かめる以外に知る方法がない**。

申告 `contentType` は攻撃者が自由に決められる。実体が

| 実体 | 帰結 |
|------|------|
| **HTML** | F-018 の閲覧経路で `text/html` 解釈されると **XSS**（対象は管理者のセッション） |
| **SVG** | `<script>` を含められる。`ALLOWED_IMAGE_CONTENT_TYPES` から除外済みだが、**`image/jpeg` を申告した SVG** は形式検査を素通りする |
| **ZIP / 実行ファイル** | 当校のストレージが**任意ファイルの配布置き場**になる |

### Impl が実装すべき契約

```ts
// lib/upload-validation.ts
export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | null
export function detectImageType(prefix: Uint8Array): DetectedImageType
export function matchesDeclaredContentType(declared: string, prefix: Uint8Array): boolean
export function isDeclaredSizeAcceptable(size: unknown): boolean
```

**判定に必要な先頭バイト数は 12**（WebP の `RIFF....WEBP` が最長）。
`readPrefix(objectKey, 12)` で足りることを前提にしている（5MB を読まない）。

### ⚠️ 残余: polyglot は先頭 12 バイト検証では検出できない（SF-2）

`FF D8 FF` で始まり、後続に ZIP / 実行ファイルを連結したファイル（polyglot）は
`detectImageType` を**通る**。**これは手法の限界であって設計の誤りではない**が、
「実体が何かを確かめる」という記述は polyglot まで防げるように読めるので、残余として明記する。

**補償（何がこの残余を埋めるか）**:

| # | 補償 | 単位 |
|---|------|------|
| (a) | バケットは**非公開**で、到達は署名付き URL 経由のみ（`objectKey` は推測不能） | P3-c2（本単位） |
| (b) | 保存する `contentType` は**申告値ではなく検出結果**に固定する | P3-c2（本単位 / 下記） |
| (c) | **F-018 の閲覧経路で `X-Content-Type-Options: nosniff` と `Content-Disposition: attachment` を付ける** | **F-018（持ち越し）** |

> ⚠️ **(c) は P3-c2 のスコープ外だが、持ち越し条件として書いておかないと F-018 で漏れる。**
> §3 が挙げている XSS の懸念は、まさにその経路（閲覧時の解釈）で顕在化する。
> **F-018 の着手時に本節を読むこと。**

### 設計上の判断（迷った点と根拠）

| 判断 | 根拠 |
|------|------|
| **WebP は `RIFF` と `WEBP` の両方を見る** | `RIFF` は WAV / AVI のコンテナ署名でもある。`RIFF` だけでは**音声・動画を通す** |
| **実体が画像でも申告と食い違えば拒否** | 保存された `contentType` が実体と異なると、F-018 の配信でブラウザの content sniffing 次第で解釈が変わる |
| **先頭不足・空バイトは例外にせず `null` / `false`** | 攻撃者は 0 バイトのオブジェクトを置ける。例外にすると未認証の第三者が 500 を起こせる（SEC-042 / SEC-060 と同型） |
| **`isDeclaredSizeAcceptable` は型も検査する** | 申告値は攻撃者が完全に制御する。`size <= MAX` だけだと `size: -1` が通る。**判定できないものを「上限内」と見なさない** |
| パラメータ付き `image/jpeg; charset=binary` を許容 | 実在する値。ここで落とすと**正規利用者が弾かれる** |

---

## 4. AC-009-6 / AC-009-7 / AC-009-10 — `uploadToken` のバインド・単回使用・期限

**ファイル**: `tests/unit/upload-token.test.ts`（14 件 / **ファイル単位で red**＝`lib/upload-token.ts` 未作成）

### `uploadToken` は「未認証フローにおける唯一の認可材料」である

SPEC-011 の原文:

> `uploadToken` は発行時に `objectKey` へバインドされた予測不能な単回使用トークンであり、
> **それを提示できること自体が「そのオブジェクトを発行させた本人である」ことの証明**になる。

認証が無い以上、これが破れると **IDOR** が直ちに成立する
（他人の免許証画像を自分の申込へ紐付ける / 他人のオブジェクトを削除する）。

### Impl が実装すべき契約

```ts
// lib/upload-token.ts
export const UPLOAD_TOKEN_EXPIRES_IN_SEC = 600      // SPEC-003（確定）
export function createUploadToken(params): { token: string; expiresAt: Date }
export function verifyUploadTokenBinding(
  record: UploadTokenRecord | null,
  presented: { token: string; objectKey: string },
  now: number,
): boolean                                          // ★ boolean のみ。理由を返さない
```

### 設計上の判断: **判定関数は理由を返さない**

AC-009-7 は「どの条件で失敗したか（未存在 / 期限切れ / 消費済み / 不一致）を区別できない」と定める。
呼び出し側が `reason` で分岐できると、**応答が分かれるのは時間の問題**である。
`lib/public-guard.ts:91-93` が Tier B の本文を 1 つに固定したのと同じ判断——
**判定基準をボットに教えない。** したがって純関数のシグネチャ自体を `boolean` に固定した。

### 契約にした要点

| 契約 | これが green なら排除される攻撃 |
|------|-----------------------------|
| `objectKey` 不一致で false | **IDOR 本体**。自分のトークンに他人の `objectKey` を組み合わせ、(a) 他人の画像を自分の申込に紐付ける（F-018 で閲覧可能になる）(b) 他人の画像を削除する |
| 消費済みで false | 1 枚のアップロードを**複数の申込に紐付ける** |
| 期限の境界（ちょうど有効 / +1ms で無効） | `>=` と `>` の取り違え（1 文字で起きる） |
| トークンが予測不能（200 回で 200 種 / ≥128bit） | トークン推測による IDOR |
| **トークンに `objectKey` が埋め込まれていない** | ログにトークンが出た時点で `objectKey` も漏れる（AC-PII-1 は両方を禁止項目にしている） |
| 壊れた入力でも例外を投げない | 未認証の第三者が任意に 500 を起こせる（SEC-042） |

---

## 5. P3c-1 / AC-009-5 — `uploads` ルートの**結線**を固定する

**ファイル**: `tests/unit/uploads-route-contract.test.ts`（**11 件 / red 11 件**）

### P3-c1 で 4 段階すべてを踏んだ型を、最初から設計に入れる

P3-c1 のレビュー指摘は毎回「**測っていない継ぎ目**」に収束した:

> 受け口の悪用 → 受け口が呼ばれること → 呼び出し元がその状態を作ること → そもそも到達しない受け口

したがって本単位は**最初から「呼び出し元＝ルートが実際にその配線を持つ」ことを測る**。
構築時 throw（SEC-058 で全構成へ広げた）とは**別の網**である
——throw は実行されて初めて効くが、「新しい `endpoint` を足すときに、そのルートだけ
throw を回避する形で書かれる」ことは防げない。

### 契約にした要点

| 契約 | 出所 / これが green なら排除される事故 |
|------|-----------------------------------|
| `limiters` に **source と formSession の両方** | **P3c-1 の本体。** 縮退構成で enforce される Tier D 軸が 1 つも無い受け口ができると、監査 §F 理由 2 のとおり「**無制限に免許証画像をアップロードさせられる**」（費用・違法画像・orphan 回収の破綻） |
| `formSessionKey` は正典の `formSessionAxisKey` | SEC-052。`?? 'anonymous'` 型の固定値フォールバックを封じる |
| Tier B 判定は正典の `verifyFormSessionValue` | 再監査 §5 申し送り 1。**SEC-067 を将来どう直しても修正が 1 箇所で uploads にも波及する** |
| `endpoint: 'uploads'` | applications のセマフォと混ざらない |
| `clientIp` は `ClientIpResolution` のまま | SEC-043。`.key` だけを取る配線は縮退の防御を無効化 |
| **DELETE も同じラッパを通る** | SPEC-011。削除だけ Origin 検証もレート制限も無い変更系エンドポイントになるのを防ぐ |
| 発行側がボディの `objectKey` を読まない | AC-009-1。**DELETE は照合のため受け取る**ので、pin は POST 側だけに効かせる（ファイル全体に掛けると過検出） |
| AC-009-5 の前提がソースに書かれている | 「アップロードもラッパを通っているから流量は守られている」という**誤解**を防ぐ。実際にはバイトは一切ラッパを通らない |

---

## 6. AC-PII-8 / AC-PII-11 — orphan アップロード回収バッチ

**ファイル**: `tests/unit/orphan-uploads-batch.test.ts`（14 件 / **ファイル単位で red**＝`lib/orphan-uploads.ts` 未作成）

### AC-PII-11 が要求する 3 点（原文）

> (a) 対象が上限を超えるとき **200 件だけ処理して正常終了**する
> (b) 同じバッチを **2 回連続実行しても例外が出ず、2 回目で残りが処理される**
> (c) 途中で **Blob 削除に失敗した対象は DB を消さずに次回へ持ち越される**（AC-PII-6 の順序を維持）

### なぜ「Blob → DB」の順序なのか（設計上の要点）

逆順（DB 先）にすると、DB 行が消えた後に Blob 削除が失敗した場合
**どのオブジェクトを消すべきかの記録が失われ、免許証画像が永久に残る**
（＝ 利用者に約束した保持期間を守れない / APPI 上の不履行）。
したがって **Blob を先に消し、成功した対象だけ DB を消す。**

### Impl が実装すべき契約

```ts
// lib/orphan-uploads.ts
export const ORPHAN_BATCH_MAX_PER_RUN = 200
export const ORPHAN_RETENTION_HOURS = 24            // RETENTION_PERIODS.orphanUploadHours と一致

export function collectOrphanUploads(
  deps: { listExpired; deleteObject; deleteTokens; logger? },
  now: number,
): Promise<{ processed: number; failed: number; reachedLimit: boolean }>
```

**依存を注入する形にしたのは `lib/rate-limit.ts` の store と同じ理由**である——
バッチ本体の性質（上限・ページング・べき等性・順序）は**DB もストレージも無しに測れる**べきで、
実 DB を要求すると**測らない口実になる**。実 DB を通した検証は結合テストが別に持つ。

### 契約にした要点

| 契約 | これが green なら排除される事故 |
|------|-----------------------------|
| 200 件で打ち切って**正常終了** | Function の最大実行時間でタイムアウトし**中途半端な状態で終わる**（次回も同じ場所で落ち続け、回収が永久に進まない） |
| `listExpired` に**上限を渡す** | 全件取得してからメモリで `slice` する実装（対象 10 万件で落ちる） |
| 2 回目で残りが処理される | 上限で打ち切った後、**次回も同じ 200 件を対象にする**（残りが永久に処理されない） |
| **失敗した対象の DB 行を消さない** | 記録が失われ免許証画像が**永久に残る**（AC-PII-6 の順序違反） |
| 1 件の失敗で全体が止まらない | 壊れたオブジェクト 1 つで**回収が永久に進まない** |
| バッチ全体が例外を投げない | cron が異常終了し、以後の実行が止まる |
| ログに `objectKey` 全体を出さない | AC-009-9 / AC-PII-1（ハッシュ先頭 8 文字のみ） |
| `ORPHAN_RETENTION_HOURS === RETENTION_PERIODS.orphanUploadHours` | `/privacy` で約束した期間と実際の削除期間がずれる（APPI 上の不履行） |
| `now` を注入する | 境界のテストが書けなくなる（P3-d の保持期間バッチも同じ形） |

---

## 7. SEC-067 の回復経路（`challengeToken`）の**結線** — P3-c1 からの繰越 Must

**ファイル**: `tests/integration/form-session-recovery.int.ts`（5 件 / **red 4 件**）

### なぜ P3-c2 で閉じるのか（`docs/phase-status.md` の申し送り原文）

> 自己維持は「**印付き利用者が回復できる**」ようになって初めて切れる——
> `hasVerifiedSession` では原理的に切れないことが実測で確定した。

P3-c1 は「有効な Cookie を持つ再訪には発行しない」を結線したが、
**印の付いた Cookie は `verifyFormSessionValue` が `null` を返す**ので `hasVerifiedSession` は false になり、
再発行が続く（＝ 枠を消費し続ける）。**印から抜ける唯一の道が `challengeToken`** である。

`uploads` は最も機微なデータを扱い、**申込フォームより滞在時間が長い**（再監査 §5 申し送り 1）。
印に落ちた利用者が回復できないと、写真を選び直すたびに Tier B に当たる。

### Impl が実装すべき契約

```ts
// app/api/form-session/route.ts
export const POST = withPublicMutation(async (request) => {
  const { captchaToken } = await request.json()
  const passed = await verifyTurnstile(captchaToken, { secret: turnstileSecret() })  // ★ サーバー側で検証
  if (!passed) return tierB()
  const result = await issueFormSession({
    clientIp: resolveClientIp(request),
    limiter: issueLimiter,
    secret: formSessionSecret(),
    challengeToken: String(captchaToken),      // ★ 検証が通ったトークンだけを渡す
  })
  // 印の無い Cookie を Set-Cookie して 200
}, {
  // ⚠️ **`...共通ラッパ` と省略しない（MF-3）。省略された箇所は実装されない**
  //    ——この単位で 4 回観測された事実である。全項目を明示する。
  endpoint: 'form-session',                    // ★ applications と分ける（下記の根拠）
  requireContentType: 'json',
  limiters: { source: recoverySourceLimiter, formSession: recoveryFormSessionLimiter },
  formSessionKey: formSessionAxisKey,
  // ⚠️ **`undefined` にしてはならない**（下記の「危うく踏むところだった穴」）。
  //    Cookie の**存在**だけを見る（印の有無は見ない）。
  verifyFormSession: (req) => readFormSessionCookie(req) !== null,
  semaphore: formSessionSemaphore,
  clientIp: (req) => resolveClientIp(req),
  logger,
})
```

#### `endpoint` を **`'form-session'` に分ける**（MF-3 / 根拠）

初版は `endpoint: 'applications'` と書いていたが**根拠が無かった**。
これは §5 が uploads について「`endpoint: 'uploads'`（**applications のセマフォと混ざらない**）」
と書いた原則と正面から矛盾する。

`'applications'` を採ると、回復要求が**申込送信と同じ発信元軸・同じセマフォ**を消費する。
`trusted` では発信元軸は **5 回/10 分の硬いゲート**なので、
**「回復を試みたせいで申込そのものが 429 になる」**——直そうとした欠陥（SEC-067）と同型の経路ができる。
回復は申込送信よりはるかに軽い操作であり、同じ枠を食い合う理由が無い。

#### ⚠️ 危うく踏むところだった穴（**自己申告として記録する**）

MF-3 への対応として最初 `verifyFormSession: undefined` と書いた。**これは誤りである。**
`lib/public-guard.ts` の条件1'-3 は

```ts
if (!resolved.trusted && !verifyFormSession) return TIER_B()   // 縮退では別軸を必ず要求する
```

であり、**縮退構成（＝ SEC-067 が成立する唯一の構成）で回復経路の全リクエストが Tier B になる**。
つまり「回復経路を作ったが、回復が必要な構成では 1 度も使えない」という、
**直そうとした欠陥（抜けられないループ）を回復経路自身が再現する**形だった。

正しい契約は **Cookie の「存在」だけを見て、「印の有無」は見ない**:

```ts
verifyFormSession: (req) => readFormSessionCookie(req) !== null
```

| 満たすもの | 理由 |
|---|---|
| 縮退でも別軸が存在する | 条件1'-3 を満たす（全 Tier B にならない） |
| **印の付いた Cookie を弾かない** | 回復経路の目的そのもの。`verifyFormSessionValue` を使うと印付きが弾かれ、**回復できる人が誰もいなくなる** |
| Cookie 軸（Tier D）が enforce される | `formSessionKey` が非 null を返すため |
| Cookie 無しの要求は Tier B | 先に `GET /api/form-session` を通らせる（回復は「印付き Cookie の持ち主」の操作である） |

**この誤りは `uploads` の契約（`verifyFormSessionValue` をそのまま使う）を回復経路へ
機械的に横展開しかけたことで生じた。** 経路ごとに「何を Tier B と呼ぶか」は異なる。

### 1 件目は **green**（前提の再現）— 意図的

「枠を使い切った後の新規来訪者が 403 になる」は**現状で成立している**。
前提が実際に成立していることを先に測らないと、その後の「回復できる」に意味が無い
（P3-c1 の教訓: 前提を測らないテストは空振りする）。

### 契約にした要点

| 契約 | これが green なら排除される事故 |
|------|-----------------------------|
| チャレンジ通過で 201 に到達する | 10 リクエスト/10 分で申込と**写真アップロードを恒久的に使用不能**にできる（「抜けられないループ」） |
| Turnstile 未通過は回復させない | `POST /api/form-session` を叩くだけで**無コスト枠を無限にリセット**（SEC-057 の再来） |
| **同じトークンの 2 回目は回復できない** | P3-c1 §12.3 が結合要件として明記。**回復経路のコストが割り算で消える** |
| 回復経路も共通ラッパを通る | ラッパ無しの公開変更系エンドポイントを作らない（SEC-037）。Origin 検証失敗は `challenge` を含まない 403（契約ルール7） |

---

## 8. F-009 の本番経路（結合） — AC-009-1〜10 / RV-P3D-S10

**ファイル**: `tests/integration/uploads-license.int.ts`（**16 件 / red 16 件**）

### ⚠️ `beforeAll` で route を import しない（`skipped` を作らない）

最初 `beforeAll` で `app/api/uploads/license/route` を import したところ、
未実装のため vitest が 16 件を **`skipped`** として集計した。
このプロジェクトは「**skip は『あるのに動いていない』テストとして残り、後で
『あるから確認済み』と誤読される**」ことを繰り返し戒めている（申し送り §D 27）。
**各テストの中で import し、`expect.fail` で個別に落とす形**に直した（16 skipped → 16 failed）。

### 測っている継ぎ目

| # | 契約 | 出所 |
|---|------|------|
| 1 | クライアント指定 `objectKey`（`../../etc/passwd`）が**レスポンスにも uploadUrl にも現れない** | AC-009-1 |
| 2 | 同じ入力で 2 回発行しても `objectKey` が違う | AC-009-2 |
| 3 | レスポンスに公開 URL が無い（`uploadUrl` を除く） | AC-009-8 |
| 4 | 許可外 contentType（SVG / HTML / PDF）は 400 | E-009-1 |
| 5 | サイズ境界（上限は通り +1 は 400） | E-009-2 |
| 6 | **実体 HTML は紐付けを拒否し、オブジェクトを削除する** | **AC-009-3 / E-009-5** |
| 7 | 申告 1MB・実体 6MB は拒否 | AC-009-4(b) |
| 8 | 正しい JPEG は 201 で `LicensePhoto` が 1 件 | 正常系（機能不成立を防ぐ） |
| 9 | 同一トークンの 2 回目は **`LicensePhoto` を 2 件作らない**（DB 件数まで） | AC-009-6 |
| 10 | 他人の `objectKey` を組み合わせても紐付かない | AC-009-7（IDOR） |
| 11 | DELETE 正常系で **Blob と `UploadToken` 行の両方**が消える | AC-009-10(a) |
| 12 | 他人のトークン + 自分のキーで**何も消えない** | AC-009-10(b) |
| 13 | **トランザクション内にストレージ呼び出しが無い** | **RV-P3D-S10** |

### RV-P3D-S10（トランザクション境界）の根拠

> 実体検証は**トランザクション開始前**に完了させる。ストレージへのネットワーク I/O を
> トランザクション内に含めない（写真 2 枚で往復 4 回 → 長時間トランザクション →
> **DB コネクション枯渇**）。

TOCTOU（検証と消費の間）は **`objectKey` が予測不能かつ `uploadToken` が単回使用**であるため
実務上問題にならない——これが「先に検証してよい」根拠であり、テストコメントにも残した。

---

## 9. E2E — RV-P3B-019 / AC-008-3(e) / AC-009-11 と、WebKit の扱い

**ファイル**:
- `tests/e2e/playwright/license-upload.spec.ts`（7 件。**実行はしていない**＝オーケストレーターの担当）
- `tests/e2e/specs/license-upload.spec.md`（Markdown シナリオ）

### 9.1 RV-P3B-019 —「上限を緩める」のではなく「**軸を分ける**」

P3-b からの Must Fix:

> 送信が成功する経路を通す E2E が 1 本も無い。現構成のままでは原理的に書けない
> （縮退構成で窓あたり 11 枚目以降に印が付くため）。
> **「上限を緩める」ではなく「軸を分ける」形で設計すること。**

**採った形**: E2E サーバーを **`TRUST_PROXY=1`** で起動し、**テストごとに異なる `X-Real-IP`** を送る。

| 観点 | 評価 |
|------|------|
| 上限を緩めたか | **いいえ。** 閾値も窓も本番と同じ。1 つも変更していない |
| 何を変えたか | **発信元軸が要求元ごとに分かれること**だけ |
| それは本番と乖離するか | **むしろ逆。** 本番（Vercel）では発信元軸は実 IP 単位で分かれている。**縮退構成（全員が共有 `unknown`）のほうが本番と乖離していた** |
| 使う env の出所 | `TRUST_PROXY` は P3-c1（SEC-069）で「**非 Vercel 本番が縮退から抜け出す手段**」として導入した。**E2E はその非 Vercel 環境そのもの** |
| なぜ `x-real-ip` か | env 由来の信頼では **`x-real-ip` が `x-forwarded-for` より優先**される（P3-c1 / NEW-005 の provenance 契約） |

> ⚠️ **`TRUST_PROXY=1` は E2E の webServer 環境にのみ設定すること。**
> 本番の設定に混ぜてはならない（前段が XFF を上書きしない構成ではクライアントが IP を名乗れる / P3-c1 §3）。

#### ⚠️ MF-1: 当初この機構は**どこにも結線されていなかった**

初版はスペック側で `X-Real-IP` を送るだけで、**`playwright.config.ts` の `webServer` に
`env` の指定が無かった**。縮退構成では `resolveClientIp` が信頼ヘッダを**一度も見ずに**
`key='unknown'` を返すため、**送ったヘッダは 1 バイトも読まれず、軸は 1 つも分かれない**
——RV-P3B-019 は「解いた」と記録されるだけで解けていなかった。

これは P3-c1 で 4 回連続して踏み、本設計が §5 冒頭で「最初から入れる」と宣言した型の
**4 段階目（そもそも到達しない受け口）** そのものである。宣言した本人が同じ穴に落ちた。

**是正**:
```ts
// playwright.config.ts の webServer
env: { ...process.env, TRUST_PROXY: '1' },
```
`...process.env` の展開が要るのは、**Playwright が `env` 指定時に既定の環境を置き換える**ためである
（落とすと `DATABASE_URL` / `FORM_SESSION_SECRET` / `TURNSTILE_SECRET` が消え、
`lib/env.ts` の本番 fail-fast で **webServer が起動しない**）。

**pin**: `tests/unit/e2e-gate-config.test.ts` に 4 件追加（既存と同じく**設定オブジェクトを実際に読み込んで**測る。
ソースの正規表現では `...process.env` が別の行で潰される形を検出できない）。
**両方の失敗形を実測で確認した**:

| 壊し方 | 結果 |
|--------|------|
| `env` を丸ごと削除 | **3 件 red** |
| `...process.env` の展開だけを落とす | **1 件 red**（「既定の環境変数を置き換えず引き継いでいる」） |
| 正しい状態 | 9 件 green |

#### この設計が安全である 2 つの根拠（**MF-1 で明記を求められた箇所**）

1. **本番へ漏れない。** `playwright.config.ts` は**デプロイ対象に含まれない**。
   加えて `next.config.mjs` / `vercel.json` / `.env.production` に `TRUST_PROXY` が
   **書かれていないこと**を pin した（誰かが移した瞬間に赤くなる）。
2. **ヘッダを送らないスペックは従来どおり縮退のまま。**
   `x-real-ip` も `x-forwarded-for` も無ければ `resolveClientIp` は `unknown` を返すので、
   **既存 166 件の意味は 1 つも変わらない。**
   軸が分かれるのは `setExtraHTTPHeaders` を呼んだスペック（本単位で追加した 7 件）だけである。
   **これがこの設計の安全性の要**である。

### 9.1.1 SF-1 — E2E が `trusted` になると**縮退経路のブラウザ級カバレッジが消える**

MF-1 の修正で、`x-real-ip` を送るスペックは `trusted=true` になる。
`lib/form-session-issue.ts` の印は `!clientIp.trusted` でガードされているので、
**それらのスペックでは `unverified` の印が一度も付かない**——
SEC-057 の印・Tier B・SEC-067 の回復経路は**ブラウザ級では 1 件も通らなくなる**。

現状（縮退）ではむしろ印が付きすぎて flaky だったのでこれは改善だが、
**「今まで通っていた経路が今後は通らない」ことは記録されるべき**である。
「軸を分ける解法は上限を緩めていない」という判定は、
**縮退経路の検証を integration が引き受けている**ことが前提になる。

| E2E から落ちる検証 | 引き受け先 |
|---|---|
| 縮退構成で無コスト枠を超えると印が付く | `tests/unit/form-session-issue-cost.test.ts` / `tests/integration/form-session-cost.int.ts` |
| 印の付いた Cookie で送信すると Tier B | `tests/integration/form-session-recovery.int.ts`（1 件目・前提の再現） |
| 印から回復できる（`challengeToken`） | `tests/integration/form-session-recovery.int.ts`（2〜5 件目） |
| 縮退での自己維持の切断（`hasVerifiedSession`） | `tests/integration/form-session-route.int.ts`（P3-c1 / NEW-001 の 6 件） |
| 縮退での uploads 発行数の上限 | `tests/integration/uploads-cost.int.ts`（本単位 / MF-2） |
| 印の不可読化（SEC-068） | `tests/unit/form-session-degraded-recovery.test.ts` |

**ヘッダを送らない既存 166 件は従来どおり縮退のまま**（§9.1 の根拠 2）なので、
「縮退経路をブラウザで一度も通らない」わけではない——
**Cookie 軸を使う uploads 系スペックだけが `trusted` になる。**

### 9.2 WebKit を**明示的に**対象外にする

`docs/review-p3c1-code-re-2026-07-29.md` §5-2 の実測:

> WebKit は `http://localhost` で `__Host-`（Secure）Cookie を受理しないため、
> **WebKit の E2E は常に「Cookie 無し」経路**を走っている。

uploads は Cookie 軸（Tier B / Tier D の土台）に依存するので、WebKit で走らせても
**検証したい防御を 1 つも検証しないまま green になる**。
`test.skip(browserName === 'webkit', ...)` に**理由をコード内に残した**。

> **「3 ブラウザで green」と記録して実際には 2 ブラウザでしか測っていない状態を作らない。**

**中期課題（本単位ではスコープ外）**: E2E を HTTPS で回せば WebKit でも Cookie 経路を通せる。
`playwright.config.ts` の `webServer` を HTTPS 化し、自己署名証明書を
`ignoreHTTPSErrors` で受け入れる形が最も安い。P3-d 以降で判断すること。

#### SF-3: 完了記録での skip の扱い（**運用を規定する**）

`test.skip` に理由をコードで残すだけでは足りない。`uploads-license.int.ts` が自ら引用しているとおり、
このプロジェクトは「**skip は『あるのに動いていない』テストとして残り、
後で『あるから確認済み』と誤読される**」ことを戒めている。

> **完了報告には必ず skip の内訳を併記すること。**
> 形式: `166 passed / N skipped（うち uploads 系 M 件は WebKit 除外）`
>
> 「166 passed / N skipped」とだけ書くと、**WebKit で uploads の防御を測っていない事実が消える。**

### 9.3 AC-008-3(e) — 「網が実際に効く」ことを写真がある状態で初めて確認する

`lib/apply-draft.ts` は P3-b の時点で `DRAFT_FORBIDDEN_KEYS` に
`objectKey` / `uploadToken` / `previewUrl` / `licensePhotos` / `captchaToken` を列挙し、
**写真が実装される前に網を張った**（同ファイル :16-20 が「単位をまたぐ事故」を防ぐためと明記）。

P3-c2 は**その網が実際に効くことを確認する側**である。
これが green なら排除される事故: 共有端末（受付端末・学校の PC・ネットカフェ）に `uploadToken` が残り、
**後続の利用者が他人の免許証画像を自分の申込に紐付けられる**こと。

---

## 10. まとめ — ID ↔ テスト対応表と red の実測

### 実測（`pnpm test:unit` / `pnpm test:integration` / `pnpm type-check`。**ポート 3000 に触れるコマンドは未実行**）

| ゲート | ベースライン（P3-c1 完了時） | 本単位（Senior レビュー反映後） |
|--------|--------------------------|--------------------------|
| `pnpm test:unit` | 54 ファイル / **827 件** 全パス | 60 ファイル / **871 件**（**39 failed** / 832 passed） |
| `pnpm test:integration` | 9 ファイル / **87 件** 全パス | 12 ファイル / **114 件**（**26 failed** / 88 passed） |
| `pnpm type-check` | 0 | **実装待ちの未解決 export / モジュールのみ**（テスト側のバグは 0。§10.1） |
| `pnpm test:e2e` | 166 件 | **未実行**（7 件追加） |

**既存 827 unit / 87 integration は 1 件も落ちていない。**
`832 passed` の内訳は 827（既存）+ 4（`e2e-gate-config` の MF-1 pin）+ 1（`form-session-route-contract` の GET 退行 pin）。
`88 passed` は 87（既存）+ 1（`form-session-recovery` の前提の再現）。

### 10.1 型検査について（**テスト側のバグを 2 件見つけて直した**）

`pnpm type-check` の残りは**すべて実装待ち**（`Cannot find module` / `has no exported member`）である。
ただし初版には**実装が入っても消えない、テスト自身の型エラーが 2 件**あった:

| 箇所 | 誤り | 是正 |
|------|------|------|
| `e2e-gate-config.test.ts` | ローカルの `WebServerConfig` 型に `env` を宣言していなかった | 型に `env` を追加（**MF-1 の pin が型エラーのまま残るところだった**） |
| `uploads-license.int.ts` | `prisma.$transaction` のモックが Prisma のオーバーロード（配列版 / コールバック版）を再現できていなかった | **呼び出しの「順序」で判定する**形へ書き直し（`tx:start` / `tx:end` / `storage:*` のタイムラインを見る） |

後者は**測り方そのものの改善**でもある——モックの型崩れは
「テスト側のバグがそのまま red になり、原因が分からなくなる」ため、
**Prisma の内部形状に依存しない観測点**（タイムライン）へ移した。

### ID ↔ テストファイル ↔ red

| ID | ファイル | 件数 | red | 内容 |
|----|---------|------|-----|------|
| AC-009-1/2/8 | `tests/unit/storage-adapter.test.ts` | 17 | **17** | アダプタ化 / `objectKey` の推測不可能性 / 署名 URL 300 秒 |
| AC-009-3/4 | `tests/unit/upload-validation.test.ts` | 16 | ファイル単位 | マジックバイト / サイズのサーバー強制 |
| AC-009-6/7/10 | `tests/unit/upload-token.test.ts` | 14 | ファイル単位 | バインド / 単回使用 / 期限 600 秒 / 理由を返さない |
| P3c-1 / AC-009-5 | `tests/unit/uploads-route-contract.test.ts` | 12 | **12** | ルートの結線（**構造を見る形へ MF-2 で是正**） |
| **P3c-1（振る舞い）** | `tests/integration/uploads-cost.int.ts` | 5 | **5** | **MF-2**: 発行総数の枚数非依存の上限 / 上界への張り付き / 閾値の上界 |
| **MF-3** | `tests/unit/form-session-route-contract.test.ts` | 11 | **10** | 回復経路の配線 7 項目 + `verifyFormSession` の意味 |
| AC-PII-8/11 | `tests/unit/orphan-uploads-batch.test.ts` | 14 | ファイル単位 | 200 件上限 / ページング / べき等性 / Blob→DB の順序 |
| SEC-067 結線 | `tests/integration/form-session-recovery.int.ts` | 5 | **4** | `challengeToken` の回復経路 |
| AC-009-1〜10 / RV-P3D-S10 / SF-2 | `tests/integration/uploads-license.int.ts` | 17 | **17** | 本番 2 ルート跨ぎ / トランザクション境界 / `contentType` を検出結果に固定 |
| **MF-1** | `tests/unit/e2e-gate-config.test.ts`（既存に 4 件追加） | 9 | 0 | **`webServer.env.TRUST_PROXY`（軸を分ける機構の結線）** |
| RV-P3B-019 ほか | `tests/e2e/playwright/license-upload.spec.ts` | 7 | 未実行 | 送信成功経路 / 下書きの網 / 自動再発行 |
| — | `tests/e2e/specs/license-upload.spec.md` / `tests/unit/helpers/route-source.ts` | — | — | シナリオ / 共有ヘルパー |

---

## 11. 実装者への申し送り

### 11.1 着手順（依存関係）

1. **`lib/storage.ts` のアダプタ化**（`createLocalStorageAdapter` / `sharedStorage` / `generateObjectKey`）。
   **これが無いと他のテストが 1 件も書けない/通らない。最初にやる。**
2. `lib/upload-validation.ts`（マジックバイト / サイズ）— 依存なし。
3. `lib/upload-token.ts`（バインド / 単回使用 / 期限）— 依存なし。
4. `app/api/uploads/license/route.ts`（POST / DELETE）— 1〜3 に依存。
5. `app/api/applications/route.ts` へ写真の紐付けを追加（**トランザクション境界に注意 / RV-P3D-S10**）。
6. `POST /api/form-session`（SEC-067 の回復経路）— P3-c1 の `challengeToken` 契約に依存。
7. `lib/orphan-uploads.ts` + `app/api/cron/orphan-uploads/route.ts`（`withCronAuth` で包む）。
8. UI（`docs/ui-design/license-upload.md`）+ E2E。

### 11.2 やってはいけないこと

1. **`objectKey` をクライアントから受け取らない**（AC-009-1）。発行側で `body.objectKey` を読んだ時点で
   パストラバーサルと上書きの経路ができる。**DELETE は照合のためだけに受け取る。**
2. **申告 `contentType` / 拡張子だけで判定しない**（AC-009-3 が名指しで禁じている）。
   署名付き PUT は**サーバーがバイト列を一度も見ないまま**完了する。
3. **`verifyUploadTokenBinding` に理由を返させない**（AC-009-7）。
   呼び出し側が理由で分岐できると応答が分かれ、**列挙攻撃**の材料になる。
4. **ストレージ I/O をトランザクション内に入れない**（RV-P3D-S10 / DB コネクション枯渇）。
5. **orphan 回収で DB を先に消さない**（AC-PII-6）。Blob 削除失敗時に
   **どのオブジェクトを消すべきかの記録が失われ、免許証画像が永久に残る**。
6. **uploads に独自の Cookie 判定を書かない**（再監査 §5 申し送り 1）。
   正典の `verifyFormSessionValue` を使えば、SEC-067 をどう直しても修正が uploads へ波及する。
7. **E2E の `TRUST_PROXY=1` を本番設定に混ぜない**（§9.1）。

### 11.3 型検査について

`pnpm type-check` は**実装が入るまで red**。不足しているモジュール / export:

| モジュール | 不足しているもの |
|-----------|----------------|
| `lib/storage.ts` | `UPLOAD_URL_EXPIRES_IN_SEC` / `MAX_LICENSE_PHOTO_BYTES` / `ALLOWED_IMAGE_CONTENT_TYPES` / `StorageAdapter`（`head` / `readPrefix` / `put`）/ `createLocalStorageAdapter` / `createBlobStorageAdapter` / `sharedStorage` / `generateObjectKey` |
| `lib/upload-validation.ts` | **モジュールごと**（`detectImageType` / `matchesDeclaredContentType` / `isDeclaredSizeAcceptable`） |
| `lib/upload-token.ts` | **モジュールごと**（`UPLOAD_TOKEN_EXPIRES_IN_SEC` / `createUploadToken` / `verifyUploadTokenBinding`） |
| `lib/orphan-uploads.ts` | **モジュールごと**（`ORPHAN_BATCH_MAX_PER_RUN` / `ORPHAN_RETENTION_HOURS` / `collectOrphanUploads`） |
| `app/api/uploads/license/route.ts` | **ファイルごと**（`POST` / `DELETE`） |
| `app/api/form-session/route.ts` | **`POST`**（SEC-067 の回復経路） |

### 11.4 `TypeError` / モジュール未解決で落ちている red の扱い

P3-c1 §14（REV-P3C1-010）と同じ手順を適用すること:

> **実装後に「意図した理由で green になったか」を必ず確認する。**
> 具体的には、実装を入れた直後に**一度わざと壊した実装**にして当該テストが red になることを見る
> （＝ assertion が実際に効いていることの確認）。

本単位では `upload-validation` / `upload-token` / `orphan-uploads` の **44 件**が
一度も評価されていない状態にある。**実装時にこの確認を省かないこと。**

### 11.5 P3-c2 で判断が要る点（設計として決めきれなかったもの）

1. **`maxBodyBytes` を上げない — Senior 確認済み（確定）**（N-1）。
   発行 API（`POST /api/uploads/license`）は小さな JSON しか受けず、
   **バイトはラッパを通らない**（署名付き PUT はストレージ直結 / AC-009-5）。
   `docs/phase-status.md` の申し送り 4 は「**上げる場合**」の条件付きなので、
   上げない本設計では `tests/unit/public-guard-body-stream.test.ts` を回し直す必要は**無い**。
   **この判断は確定であり、次の単位で再検討しないこと。**
2. **`uploads` の Tier D 閾値には上界がある（MF-2 で追加）。**
   F-009 の境界値表は「1 申込あたり最悪 8 回（写真 2 枚 ×（初回 1 + 再発行 3））を上回る値」という
   **下界しか与えていない**。上界を決めるのは**テスト設計の仕事**である
   ——上界が無いと Impl が 1000 と置いても赤くならず、
   **配線はされているが上限が実質無い**状態が通る。

   ```
   8 < UPLOADS_FORM_SESSION_LIMIT <= 16      // 最悪ケース < 上限 <= 最悪ケース × 2
   ```

   **2 倍を上界に採る根拠**: 正規利用者の最悪ケースに 100% の余裕を持たせれば、
   自動再発行 3 回を使い切った利用者がもう一度やり直しても届く。
   それ以上の余裕は**攻撃者の枠を広げるだけで正規利用者を助けない**
   ——無コスト枠 10 枚と**掛け算**になるので、上限を 2 倍にすると攻撃面も 2 倍になる。
   `tests/integration/uploads-cost.int.ts` が `UPLOADS_FORM_SESSION_LIMIT` を
   **実装から import して**この不等式を固定する（テストに数値を書き写さない）。
3. **WebKit の HTTPS 化**（§9.2）— 中期課題。P3-d 以降で判断。

---

## 12. Senior レビュー（`docs/review-p3c2-tests-2026-07-29.md`）への対応

### Must Fix（3 件）

| ID | 内容 | 対応 |
|----|------|------|
| **MF-1** | RV-P3B-019 の中心機構 `TRUST_PROXY=1` がどこにも設定されていない | `playwright.config.ts` の `webServer` に `env: { ...process.env, TRUST_PROXY: '1' }`。**pin を 4 件追加**し、`env` 削除 → 3 red / `...process.env` 落とし → 1 red を**実測で確認**。§9.1 に本番へ漏れない根拠と「ヘッダを送らないスペックは縮退のまま」を明記 |
| **MF-2** | P3c-1 に振る舞いの実測が無く、閾値の上界も無い | `tests/integration/uploads-cost.int.ts`（5 件 / 全 red）を新規追加。SEC-057 と**同じ測り方**（枚数非依存の上限 / 非比例性 / 上界への張り付き / 正規利用者）。`uploads-route-contract` の 3 行を**構造を見る形**（`extractOptionValue`）へ。§11.5-2 に上界 `8 < limit <= 16` と根拠 |
| **MF-3** | 回復経路の配線契約が無い | `tests/unit/form-session-route-contract.test.ts`（11 件 / 10 red）を新規追加。`endpoint: 'form-session'` に分けて根拠を §7 に明記。§7 の `...共通ラッパ` を全項目へ展開 |

### Should Fix / Nit（5 件すべて採用）

| ID | 対応 |
|----|------|
| SF-1 | §9.1.1 に「E2E から落ちる検証 ↔ 引き受け先」の表を追加（6 行） |
| SF-2 | §3 に polyglot の残余と補償 (a)(b)(c) を明記。**補償 (b)（`contentType` を検出結果に固定）を結合テストで pin**。(c) は F-018 への持ち越し条件として記録 |
| SF-3 | §9.2 に「完了報告は `166 passed / N skipped（うち uploads 系 M 件は WebKit 除外）` の形で内訳を併記する」を規定 |
| N-1 | §11.5-1 を「**Senior 確認済み（確定）**。次の単位で再検討しないこと」へ |
| N-2 | `generateObjectKey.length` の pin に「これは補助であり主たる担保は型」を明記 |

### 反論する点

**無い。Must Fix 3 件・Should Fix 3 件・Nit 2 件すべて指摘が正しいと判断した。**

MF-1 は特に重い。**§5 冒頭で「4 段階目を最初から設計に入れる」と宣言した本人が、
その 4 段階目（そもそも到達しない受け口）を同じ文書の中で踏んでいた。**
スペックはヘッダを送り、設計文書は「解いた」と書き、**サーバーはそれを一度も読まない**——
「受け口は在るが呼び出し元がその状態を作らない」の教科書的な例である。

### 対応中に自分で見つけた追加の誤り（2 件）

1. **`verifyFormSession: undefined` は回復経路を壊す。**
   MF-3 への対応として最初そう書いたが、`lib/public-guard.ts` の条件1'-3 により
   **縮退構成（＝ SEC-067 が成立する唯一の構成）で回復経路の全リクエストが Tier B になる**。
   「回復経路を作ったが、回復が必要な構成では 1 度も使えない」——
   **直そうとした欠陥を回復経路自身が再現する**形だった。
   正しい契約は「Cookie の**存在**だけを見て、**印の有無は見ない**」（§7）。pin も追加した。
   **原因は uploads の契約（`verifyFormSessionValue` をそのまま使う）を機械的に横展開しかけたこと。**
   経路ごとに「何を Tier B と呼ぶか」は異なる。
2. **テストファイルを他のテストから import してはならない。**
   `extractOptionValue` を `uploads-route-contract.test.ts` から export して
   `form-session-route-contract.test.ts` が import したところ、
   **その import で相手ファイルの `describe` も実行され、同じテストが 2 回走った**
   （`tests/integration/news.int.ts` で同型の事故を避けたのと同じ理由）。
   `tests/unit/helpers/route-source.ts` へ切り出した。

### 申し送り（本単位のスコープ外）

`tests/unit/applications-route-contract.test.ts:42-44` は **MF-2 で指摘されたのと同じ弱い正規表現**
（`/source\s*:/`）のままである。`extractOptionValue` を使う形へ揃えるのが望ましいが、
**既存の green を触る変更**なので本単位では手を付けていない。P3-d 以降で判断すること。

---

## 13. E2E セレクタの不具合と再発防止（オーケストレーター実測 → 是正）

### 13.1 何が起きたか

E2E を実行したところ **14 件失敗（7 テスト × chromium / firefox）/ 44.7 分**（通常 1.5 分）。
原因は `tests/e2e/playwright/license-upload.spec.ts` 初版の**セレクタとフォーム構造の誤り**である。

| 初版の記述 | 実際 |
|---|---|
| `getByLabel(/お名前/)` | **`label="氏名"`**（`StepPersonal.tsx:28`） |
| `getByLabel(/フリガナ/)` | **`label="氏名カナ"`**（同 :38） |
| `getByLabel(/お問い合わせ内容\|メッセージ/)` | **`label="ご質問・ご要望"`**（`PreferenceCommonFields.tsx:41`） |
| `getByTestId('privacy-consent')` | **`input[name="privacyConsent"]`**（`StepReview.tsx:51`。testid は無い） |
| `getByTestId('apply-complete')` | **存在しない**（完了節は `data-submission-state="done"`） |
| `getByTestId('apply-receipt-number')` | **`complete-receipt`**（`ApplicationForm.tsx:620`） |
| 全項目を 1 画面で入力して送信 | **ステップ式**。`APPLICATION` は `course → personal → license → preference → review`、`INQUIRY` は `personal → review`（`form-model.ts:38-39`）。`apply-next` で送る |

**写真と無関係な RV-P3B-019（送信成功の通し）まで入力段階でタイムアウトした**ため、
60 秒 × 3 試行 × 2 ブラウザ × 7 テストで 44 分を消費した。

### 13.2 なぜ通ってしまったか（**再発防止の対象はここ**）

> **テスト設計者もレビュワーも E2E を実行できない**（ポート 3000 の制約）ため、
> **セレクタの実在性を誰も検証していなかった。**

ユニット / 結合は**型検査が守る**が、**E2E のセレクタは文字列なので何も守らない**。
P3-c1 で 4 回連続して指摘された「測っていない継ぎ目」が、今度は**テスト自身**に出た形である。
しかも本設計文書は §5 冒頭でその型を「最初から設計に入れる」と宣言していた。

### 13.3 是正: 既存 UI / 新規 UI の区分と、実在性のユニット固定

**既存 UI を指すセレクタは `EXISTING` / `EXISTING_LABEL` に集約**し、
`tests/unit/e2e-selector-contract.test.ts`（**19 件 / 全 green**）がソース走査で実在性を固定する。
手法は `tests/unit/application-form-client-wiring.test.ts`（結線をソースで固定）と同じである。

| 区分 | 対象 | 扱い |
|------|------|------|
| **既存 UI**（P3-b で Senior 承認済み） | `apply-type-*` / `apply-next` / `apply-submit` / `apply-step-confirm` / `complete-receipt` / 氏名・氏名カナ・生年月日・メールアドレス・電話番号・ご質問ご要望・コース / `input[name="privacyConsent"]` / `apply-draft/v1` | **スペック側を実装に合わせた。** フォームは変えない |
| **新規 UI**（F-009 の契約） | `license-photo-front` / `-preview` / `-error` | **変えない。** Impl が満たす要求である（実装済みを確認: `components/apply/LicensePhotoUpload.tsx:333,344,356`） |

### 13.4 この検査で捕まるもの / 捕まらないもの

- **捕まる**: 「E2E が参照するラベル / testid が実装に存在しない」——初版の主因。**44 分ではなく 1 秒で分かる。**
  加えて「一覧に無い testid を直接書き始める」ことも検出する（集約が形だけにならないようにする）。
- **捕まらない**: セレクタは存在するが**ステップ順や可視条件が違う**（初版のもう 1 つの誤り）。
  これは E2E を実際に回すしかない。**本検査は「安い網」であって代替ではない。**
  ただしステップ構成そのもの（`STEPS` の中身）は 2 件で固定したので、
  構成が変わったら E2E のヘルパーも直す必要があることには気付ける。

### 13.5 追加の提案（**実装はしていない / 判断はオーケストレーターに委ねる**）

1. **E2E の実行を「1 スペックだけ」に絞れるゲートを用意する。**
   今回のように 1 ファイルが壊れていると全体が 44 分になる。
   `pnpm test:e2e --grep` 相当を `package.json` に足しておけば、
   新規スペックを**単体で**回して確認できる（オーケストレーターの実行コストが下がる）。
2. **`retries` を新規スペックだけ 0 にする。** 失敗が確定しているスペックで 3 回試すのは
   時間の純損失である（44.7 分の大半はリトライ）。
3. **既存 UI 側に「E2E が依存している」ことを示すコメントを置く。**
   `EXISTING` の各 testid の定義元に 1 行入れておくと、UI を触る人が気付ける。
   ——ただし「コメントでは 4 度止められなかった」（SEC-043）ので、
   **本命は 13.3 のユニット固定**であり、これは補助である。

---

## 14. E2E 残り 10 件の真因（**実測で特定**）と是正

UI 実装後の実測: **170 passed / 10 failed / 13 skipped**（実装前は 166 passed / 14 failed）。
残り 10 件は**すべてテスト側の問題**であり、実装の欠陥ではない。
**推測で直さず、`test-results/` の成果物（`error-context.md` / `trace.zip`）から機構を特定した。**

### 14.1 (A) F-009 の 4 件 — **ステップの必須入力を満たしていなかった**

失敗は `getByLabel('氏名')` のタイムアウトだが、**氏名は次のステップにあり、そもそも描画されていなかった。**

`components/apply/form-model.ts:44`:

```ts
STEP_FIELDS.course = ['plans', 'courseId', 'school', 'format']
```

**APPLICATION ではこの 4 つとも必須**である。初版のヘルパーは `courseId` しか選ばず、
`apply-next` が検証で止まって**個人情報ステップへ進めなかった**。
さらに `STEP_FIELDS.personal` の `postalCode` / `address` も APPLICATION では必須で、
仮にコースを抜けても**免許ステップ（写真 UI）へは到達できなかった**。

| 段 | 初版 | 是正 |
|---|---|---|
| コース | `courseId` のみ | **`plans`（通常プラン）/ `courseId` / `school`（岩滝校）/ `format`（通学）の 4 つ** |
| 個人情報 | 氏名・カナ・生年月日・メール・電話 | **+ 郵便番号 / 住所**（`withAddress: true`） |

併せて Impl の事前申告（「`nth(1)` は seed に公開コースが 2 件以上あることが前提」）に対応し、
**`nth(1)` の決め打ちをやめて**「値が空でない最初の option」を選ぶ形にした。
公開コースが 0 件なら**その旨のメッセージで落ちる**ようにしてある。

### 14.2 (B) RV-P3B-019 の 2 件 — **`captchaToken` が空のまま送信していた**

chromium だけ失敗し firefox が通った非対称の正体を、**trace の実ネットワークで確定させた**
（`test-results/…-chromium-retry1/trace.zip`）。

送信ボディ（`resources/fdd5fa59….json`）:

```json
{ …, "privacyConsent": true, "captchaToken": "", "hp_field": "" }
```

応答: `403 {"challenge":"interactive"}`

同時に確認できた事実:

| 観測 | 値 | 意味 |
|------|----|----|
| リクエストヘッダ | **`x-real-ip: 198.51.138.214`** | **「軸を分ける」機構は正しく効いている**（`TRUST_PROXY` も含めて疑う必要は無い） |
| Cookie `__Host-fs` の payload | `{"sid":"…","issuedAt":…}` | **`unverified` の印なし** ＝ 正規の Cookie。Cookie 起因の Tier B ではない |
| `hp_field` | `""` | ハニーポット起因でもない |
| `captchaToken` | **`""`** | **これだけが原因** |
| Turnstile の script | `200`（`challenges.cloudflare.com` へ到達） | 読み込みは成功。**間に合っていなかっただけ** |

> **真因: 固定待ち（`waitForTimeout(3_500)`）は AC-RL-6（送信間隔下限 3 秒）しか満たしておらず、
> Turnstile のコールバックが返ったことを何も保証していなかった。**
> chromium だけが落ちたのは「待ち時間と描画完了の競争に負けたかどうか」の違いにすぎず、
> **ブラウザ固有の欠陥でも実装の欠陥でもない。固定待ちに依存した設計そのものが誤り**である。

**是正**: 送信の直前に `waitForCaptchaToken(page)` を挟む。
`ApplicationForm.resolveCaptchaToken()` は state か `window.turnstile.getResponse()` を使うので、
**`getResponse()` が非空になったこと**が送信可能の正しい前提である。

```ts
await page.waitForTimeout(3_500)   // (1) AC-RL-6: 送信間隔下限
await waitForCaptchaToken(page)    // (2) Turnstile がトークンを発行したこと
await page.getByTestId(EXISTING.submit).click()
```

**両方が要る。** (1) だけでは Tier B、(2) だけでは送信間隔で Tier B になる。

### 14.3 再発防止の拡張（`tests/unit/e2e-selector-contract.test.ts` を 19 → **27 件**へ）

§13.4 で「**セレクタは存在するがステップ順や可視条件が違う**ケースは本検査では捕まらない」と
書いたが、(A) はまさにその区分だった。**捕まえられる部分だけ捕まえる**形で 8 件足した。

| 追加した pin | 捕まえるもの |
|---|---|
| `STEP_FIELDS.course` が 4 項目である | 実装側で必須が増減したら気付く |
| スペックが 4 項目すべてに触れている | 「`courseId` だけ選んで次へ」の再発 |
| 選択肢ラベル（通常プラン / 岩滝校 / 通学）が実装に存在する | 選択肢名の変更 |
| スペックが郵便番号・住所を埋めている | 免許ステップへ到達できない再発 |
| `waitForCaptchaToken` が存在し `getResponse` を見ている | 固定待ちだけで送る再発 |
| **送信クリックの直前 400 文字以内に `waitForCaptchaToken` がある** | 関数はあるが呼び忘れる形 |

### 14.4 実装側に原因があると考える点 — **無い**

10 件すべてテスト側の誤りである。特に (B) は「Tier B に落ちている」という
**スペック自身のエラーメッセージが実装を疑う方向へ誘導していた**が、
trace を見れば `x-real-ip` も Cookie も正常で、空の `captchaToken` だけが原因だった。

> P3-c1 で学んだ「**誤った原因を記録に残すと、次に同じ赤を見た者が env を緩める方向へ動く**」
> （RV-P3B-018）に照らすと、ここで「`TRUST_PROXY` が効いていないのでは」と推測して
> 枠や閾値に手を入れるのが最悪の対応だった。**実測が防いだ。**

なお、失敗時のメッセージが誤誘導しないよう
「Tier B に落ちている可能性: 発信元軸が分かれているか確認」という文言は残しつつ、
**トークン待ちを前提として明示的に分離**したので、次に赤が出たときは
`waitForCaptchaToken` のタイムアウトとして**別の場所で**落ちる。

---

## 15. E2E 残り 1 件の真因（**trace のタイムラインで確定**）

実測: **179 passed / 1 failed / 13 skipped**（28.7 分 → 2.4 分）。
残り 1 件は `写真を選んでも sessionStorage の下書きに objectKey / uploadToken が保存されない`（chromium のみ）で、
**アサーション本体ではなく前提**（`下書きが保存されていない`）が崩れていた。

### 15.1 真因: **400ms のデバウンスが発火する前に読んでいた**（テスト側）

オーケストレーターの仮説（写真が `useRef` なので下書き書き込みが発火しない）は
**機構としては正しい**が、**`null` の直接の原因ではなかった**。
`test-results/…-chromium-retry1/trace.zip` のアクションタイムラインで確定させた:

| 時刻（ms） | 操作 |
|---|---|
| 44582.378 | `fill 住所` ← **最後の `values` 変更** |
| 44590.140 | `click apply-next`（+7.8ms） |
| 44673.636 | `setInputFiles`（写真） |
| 44683.446 | プレビュー可視 |
| **44689.754** | **`sessionStorage.getItem`** |

**最後の `values` 変更から読み出しまで 107.4ms。**
下書き書き込みの `useEffect`（`ApplicationForm.tsx:215-231`）は
**400ms のデバウンス**を持ち、`values` が変わるたびにタイマーを張り直す。
**つまりタイマーはまだ発火しておらず、`null` は正しい状態だった。**

chromium だけ落ちたのは、(B) と同じく**待ちと実際の条件の競争に負けたかどうか**の違いである。
firefox は偶然 400ms 以上かかっていた。**固定の順序に依存した設計そのものが誤り。**

### 15.2 実装側の欠陥ではない（根拠）

| 確認 | 結果 |
|---|---|
| `clearDraft` の呼び出し元 | `discardDraft`（利用者操作）と送信成功後のみ。本フローでは呼ばれない |
| 下書き書き込みの deps | `[values, type, submission.kind]`。**写真は `photosRef`（`useRef`）で `setState` を通らない**（`ApplicationForm.tsx:167-173`）——`values` に入れると下書き経路に乗るため**意図的**（AC-008-3(e)） |
| デバウンス 400ms | 同 :228。`// 入力のたびに走るのでデバウンスする` と明記済み |
| コンソール | React のエラーなし（CSP による `blob:` connect 拒否のみ。写真プレビューとは別経路） |

**実装は設計どおりに動いている。** 直すべきはテストである。

### 15.3 是正: 順序と条件待ち

```
1. 写真を先に添付する          ← 後に書かれた下書きでないと「写真がある状態」を検査したことにならない
2. 同じステップで values を変える ← 写真だけでは書き込みが発火しない（意図的な設計）
3. expect.poll で書き込みを待つ  ← 固定待ちではなく条件待ち
4. 禁止キーが含まれないことを検査
```

### 15.4 ⚠️ 併せて見つけた**空振りしていた 2 件**（自己申告）

E2E はローカルストレージアダプタで動く。そのアダプタは `local-storage:<hash>` という
**HTTP で PUT できない URL** を返すため、`LicensePhotoUpload.tsx:168-180` は
**どんなファイルを選んでも**「この環境では写真のアップロードをご利用いただけません。」で失敗する
（**成功したことにしない**という実装の判断は正しい）。

したがって、初版の

```ts
await expect(page.getByTestId(NEW.photoFrontError)).toBeVisible()
```

は **クライアント検証を丸ごと削除しても green のまま**になる。
`実体が HTML …` と `5MB を超える…` の 2 件は**空振りしうる状態で green だった**。

**是正**: メッセージ本文まで検査する（`ファイルサイズが大きすぎます` / `JPEG・PNG・WebP の画像を選んでください`）。
環境要因のエラーで通っていたら赤くなる。

> **これは指摘されて直したのではなく、真因調査の途中で自分で見つけた。**
> 「空振りしているテストを green として報告しない」は自分の成果物にも適用する。

### 15.5 残る限界（**記録として残す**）

E2E は**ローカル環境では実アップロードが成立しない**ため、
「アップロード成功後に `objectKey` / `uploadToken` が下書きへ出ない」ことは**ブラウザ級では測れない**。
到達できるのは「選択したがアップロード不可」の状態までである。

| 何を | どこが担保するか |
|---|---|
| `toDraftSnapshot` が禁止キーを落とす | `tests/unit/apply-draft-storage.test.ts`（純関数） |
| 写真が `values` に入らない構造 | `ApplicationForm.tsx` の `photosRef` + 本 E2E（値変更後の下書きに写真関連値が無い） |
| サーバー側の実体検証・単回使用・IDOR | `tests/integration/uploads-license.int.ts`（17 件） |

**Vercel Blob を有効にした環境でのみ、E2E で「成功後」まで到達できる。**
その構成での実行はオーケストレーターの判断に委ねる（本単位ではスコープ外）。

### 15.6 再発防止（`e2e-selector-contract.test.ts` を 27 → **31 件**）

| 追加した pin | 捕まえるもの |
|---|---|
| `sessionStorage` 読み出し前に `expect.poll` がある | デバウンス前に読む再発 |
| 写真添付 → 値変更 → 読み出しの**順序**である | 「写真より前の下書き」を検査してしまう形 |
| メッセージ本文（`CLIENT_ERROR.*`）を検査している | 環境要因のエラーで空振りする形 |
| 検査対象のメッセージが実装に存在する | 文言変更で検査が無効化される形 |

---

## 16. コードレビュー（`docs/review-p3c2-code-2026-07-29.md`）— テスト側の是正

E2E は **180 passed / 0 failed** に到達したが、Must Fix 3 件のうち **2 件がテスト側の「空振り」**だった。
どちらも「**green だが何も守っていない**」型である。

### 16.1 CR-002 — 空振りしていた pin を、値そのものを見る形へ

**場所**: `tests/unit/form-session-route-contract.test.ts`

初版はセクション全文へ `toMatch(/readFormSessionCookie/)` を掛けていた。
`postSection()` は `export const POST` 以降の**全文**であり、その中には
`hasVerifiedSession` を計算する**無関係な行**

```ts
const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, now)
```

がある。**pin はこの出現に一致していた**ため、`verifyFormSession: () => true` という
契約違反の実装に対して **3 つの assertion すべてが通っていた**。

**是正**: `extractOptionExpression(postSection(), 'verifyFormSession')` で
**オプションの値そのもの**を切り出してから検査する。
`extractOptionValue` は `name: { … }` しか扱えず、実際に破られたのは
**アロー関数の値**だったので、ヘルパーに非オブジェクト値用の切り出しを追加した
（括弧の対応・文字列・行コメントを考慮する。考慮しないと `', '` のカンマで切れる）。

**変異による実測（レビューの要求）**:

| 実装 | 結果 |
|------|------|
| `verifyFormSession: () => true` | ❌ **red**（`実際の値: () => true` と表示） |
| `verifyFormSession: (req) => readFormSessionCookie(req) !== null` | ✅ green |

> MF-2 で `extractOptionValue` を導入した目的は、まさに
> 「ファイル内のどこかに綴りがあれば通る」形の排除だった。
> **同じファイルの 1 箇所だけ旧来の広い検査が残り、そこが実際に破られた。**

### 16.2 CR-001 に伴うテスト側の是正 — **テストが実装に契約違反を選ばせていた**

`tests/integration/form-session-recovery.int.ts` の `recover()` は
**Cookie を送らずに 200 を期待**していた。承認済み契約
`verifyFormSession: (req) => readFormSessionCookie(req) !== null` を実装すると
このテストが赤くなるため、**Impl は `() => true` を選ばざるを得なかった**。

**これは最も避けたい形である**——テストが実装の品質を上げるどころか、**契約違反を強制した**。

**是正**:
1. `recover(captchaToken, cookieValue)` に変更し、**必ず Cookie を提示する**。
   実際の回復フローでも要求元は Cookie を持っている（印が付くのは `GET` で受け取った後だから）。
2. **契約の裏面を pin として追加**:
   「**Cookie を持たない回復要求は Tier B**」（`403 { challenge }`）。
   **この pin が無かったことが、そもそも `() => true` を選べた理由**である。

### 16.3 CR-003 — 何も測っていない E2E を削除し、判定を unit で測る

`AC-009-11(b)`（非表示中は再発行しない）の E2E は 3 秒しか待たないが、実装は
`REISSUE_TICK_MS = 30_000` / `REISSUE_BEFORE_MS = 120_000` で、
**最初に再発行が起きうるのは発行から約 180 秒後**。
さらにローカルアダプタでは状態が `failed` になり**タイマーがそもそも張られない**。
**実装を丸ごと削除しても green** ——二重の意味で何も測っていなかった。

**是正**（レビューの改善案 (A)）:
- **E2E を削除**（残さない。「あるから確認済み」と誤読されるのが最悪 / 申し送り原則 4）。
  削除した箇所には**理由と代替の担保**をコメントで残した。
- **`tests/unit/license-photo-reissue.test.ts`（13 件）を新設**し、
  判定を純関数 `shouldReissue` として**30 秒待たずに全分岐を網羅**する。

| 測っている分岐 | 根拠 |
|---|---|
| `hidden` なら再発行しない | AC-009-11(b)。SPEC-009 の「8 分ごとに発行 + PUT が永久に繰り返される」を防ぐ |
| `visible` なら再発行する | 抑止しすぎて**期限切れの写真が黙って失効する**形を排除 |
| `prerender` は止めない | `!== 'visible'` で書くと一瞬の `prerender` で止まる。仕様が禁じたのは **hidden の間** |
| 上限 3 回で停止（境界 2 / 3 / 3+5） | AC-009-11(a) |
| 期限まで余裕があれば再発行しない | tick ごとに無条件発行すると**帯域防御を自ら食い潰す** |
| 期限切れでも上限内なら再発行する | 期限切れ＝手遅れではない（取り直せば添付は救済できる） |
| 更新窓 < `uploadToken` 寿命 | 窓が寿命以上だと常に再発行になり抑止が消える |

**変異による実測**: `if (input.visibilityState === 'hidden') return 'wait'` を削除すると
**当該 1 件が red**、戻すと 13 件 green。**pin は非空振りである。**

### 16.4 実測

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` | **62 ファイル / 957 件 全パス** |
| `pnpm test:integration` | **12 ファイル / 115 件 全パス**（回復経路に Cookie 無しの pin を 1 件追加） |
| E2E | 未実行（1 件削除したので **179 + 13 skipped** になる見込み。実測はオーケストレーター） |

### 16.5 AC-009-11(b) の担保の所在（**記録**）

| 何を | どこが担保するか |
|---|---|
| 判定ロジック（hidden / 期限 / 上限） | `tests/unit/license-photo-reissue.test.ts`（13 件） |
| タイマーが実際に張られること | **未検証**。実アップロードが成立する環境（Vercel Blob）でなければ到達できない（§15.5 / SF-1 と同根） |

**「判定は測った / 結線は未検証」を分けて記録する。** 一括で「AC-009-11 は検証済み」と書かない。
