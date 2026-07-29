# コードレビュー: P3-c2（F-009 免許証写真アップロード本体）実装

## レビュー日: 2026-07-29
## 対象Phase: 実装（Phase 7）
## レビュワー: Senior Engineer Agent（`.claude/skills/senior-review.md`）
## 正典: `docs/test-design-p3c2-2026-07-29.md` / `docs/review-p3c2-tests-re-2026-07-29.md`

---

## 総合評価: **Request Changes**

- **Must Fix: 3 件**（CR-001 / CR-002 / CR-003）
- Should Fix: 4 件 / Nit: 1 件

**実装の質は高い。** サーバー側（ストレージ / 検証 / トークン / 回収バッチ / ルート結線）は
契約どおりに実装され、`uploads-license.int.ts` 17 件・`uploads-cost.int.ts` 5 件・
`form-session-recovery.int.ts` 5 件がいずれも本番経路で green になっている。
**SEC-067 の回復経路が本番 2 ルート跨ぎで初めて成立した**のは P3-b から 3 単位越しの成果である。

Must Fix 3 件は**すべて「green だが何も守っていない」型**である。
うち 2 件（CR-001 / CR-003）は **Impl 自身が正直に自己申告した**ものであり、
1 件（CR-002）は**その申告があったからこそ私が発見できた** pin の空振りである。
申告の質が高かったことを先に記録しておく。

---

## 0. 自分で実測したこと

**ポート 3000 に触れるコマンド（build / e2e / dev / start）は一切実行していない。**

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` 相当 | **61 ファイル / 944 件 全パス** |
| `pnpm test:integration` 相当 | **12 ファイル / 114 件 全パス** |
| `npx tsc --noEmit` | **エラー 0** |

`build` / `e2e`（180 passed / 13 skipped）は報告を受け入れる。

---

## 1. 依頼事項への回答

### 依頼 1: ローカルアダプタが `Failed` を出す判断 — **正しい。支持する**

`components/apply/LicensePhotoUpload.tsx:173` の
`if (!/^https?:\/\//.test(issued.uploadUrl))` → `Failed` は妥当である。

`uploaded` にすれば、**バイトが 1 つも格納されていないのに「添付しました」と表示**し、
送信時にサーバー側の実体検証（`head()` が `null`）で必ず落ちる。
利用者から見れば「添付できたのに送信できない」という**原因の分からない失敗**になり、
しかも失敗するのは全項目を入力し終えた**最後**である。
Impl が挙げた「嘘の UI」という表現は正確で、この判断は UI 設計の原則としても正しい。

**ローカル PUT 受け口を独断で足さなかった判断も支持する。**
それは新しい公開書き込みエンドポイントであり、P3c-1 と同じ Tier D の全処遇（軸・上限・
セマフォ・Origin 検証・実体検証）を要する。テスト設計にも監査にも無いものを実装フェーズで
足すのは、本プロジェクトが繰り返し戒めてきた「スコープの静かな拡大」である。

ただし**帰結は記録されなければならない** → SF-1。

### 依頼 2: `useRef` にした設計 — **妥当。二重の網として正しい**

`components/apply/ApplicationForm.tsx:167-175` を確認した。
`photosRef` は `useRef` で保持され、`:220` の `toDraftSnapshot({ ... })` に渡る `values` とは
**別の器**にある。送信時のみ `:543` で `licensePhotos` として合流し、INQUIRY では送らない。

二重の網の評価:

| 網 | 効き方 |
|----|-------|
| ① `values` に入れない（`photosRef`） | **経路そのものを作らない。** 下書き保存は `values` を材料にするので、器が違えば載りようがない |
| ② `DRAFT_FORBIDDEN_KEYS`（P3-b が先に張った） | ①が将来崩れた（誰かが `values` に移した）ときの保険 |

**①だけでも②だけでも足りない**ので二重にするのは正しい。
①は「今の実装が正しい」ことしか保証せず、②は「キー名が一致する限り」しか保証しない
（`photos` のような別名で入れられると②はすり抜ける）。両方あって初めて塞がる。

`previewUrl`（`blob:`）を親へ渡していないのも同じ理由で正しい。

### 依頼 3: §15.6 の再発防止 pin — **3 クラス中 2 クラスは塞がった。1 クラスは残る** → SF-4

E2E で 3 回続いた失敗の内訳と、pin の対応:

| 失敗クラス | §15.6 の pin | 判定 |
|-----------|-------------|------|
| セレクタの不一致 | `EXISTING_TESTIDS` / `EXISTING_LABEL` へ集約 + `e2e-selector-contract.test.ts` | **塞がった。** 実際、Impl が `apply-complete` を足しかけて**この pin を読んで気付いた**と記録している（:398-401）——pin が意図どおり機能した実例 |
| 固定待ち / デバウンス | 「`sessionStorage` 読み出し前に `expect.poll` がある」「順序である」「メッセージ本文を検査している」「文言が実装に存在する」 | **塞がった** |
| **ステップの必須入力** | **無い** | **残る** → SF-4 |

3 つ目は「E2E ヘルパ（`gotoLicenseStep`）が通過するステップに必須入力が追加されると、
E2E を実行するまで壊れたことが分からない」というクラスである。
静的 pin は原理的に難しい（バリデーションの真実源とヘルパの入力を突き合わせる必要がある）ので、
**既知の限界として記録する**のが現実的な落としどころだと判断する。

### 依頼 4: 非表示時の再発行抑止テストが何も測っていない — **Must Fix**（CR-003）

自己申告は正しい。裏取りした:
`REISSUE_TICK_MS = 30_000`（:67）かつ `REISSUE_BEFORE_MS = 120_000`（:64）。
署名 URL の寿命は 300 秒なので、**最初に再発行が起きうるのは発行から約 180 秒後**である。
E2E は 3 秒しか待たない。**実装を丸ごと削除しても green になる。**

### 依頼 5: 新しく持ち込まれた欠陥・退行 — **退行は無し。欠陥は CR-001**

- 既存 54 unit ファイル / 9 integration ファイルは全 green（自分で実行して確認）。
- **既存 testid 契約の変更は 0 件**（`e2e-selector-contract.test.ts` が green）。
- `lib/upload-validation.ts` をクライアント安全にした改修（定数の正典を移し、
  `lib/storage.ts` が再 export）は、両方のテストが通ることで担保されている。
  `node:fs/promises` をクライアントバンドルへ持ち込まないための正しい対処である。

---

## 2. 指摘事項（Must Fix）

### [CR-001] 回復経路の `verifyFormSession: () => true` が、承認済み契約から外れて**軸ゼロの経路**を作っている

- **種別**: Bug（セキュリティ）
- **重要度**: **Must Fix**
- **場所**: `app/api/form-session/route.ts:319` / 実装記録 §6「要確認事項」
- **現状**: 設計文書 §7 と `review-p3c2-tests-2026-07-29.md` MF-3 が確定させた契約は
  **`verifyFormSession: (req) => readFormSessionCookie(req) !== null`（Cookie の存在を見る）**である。
  実装は **`() => true`** を採った。Impl は理由を自己申告している——
  `tests/integration/form-session-recovery.int.ts` の `recover()` が **Cookie を送らずに 200 を期待する**ため、
  契約どおりに実装すると当該テストが赤くなる。

  帰結（Impl 自身が :230 で申告しているとおり）:

  > **Cookie を持たない縮退の要求では enforce される Tier D 軸が無い。**

  順に追うと:
  - `verifyFormSession` が常に `true` → ラッパの Tier B 判定は発火しない。
  - `formSessionKey: formSessionAxisKey` は Cookie 無しで `null` を返す → **formSession 軸は作られない**。
  - 発信元軸は `sourceAxisFor` が `enforce: resolution.trusted` を返す → **縮退では計数のみ**。

  すなわち縮退構成（ローカル / E2E / 非 Vercel 本番）では、
  **Cookie を持たない要求に対して enforce される Tier D 軸が 1 つも無い公開変更系エンドポイント**が
  でき、その 1 リクエストごとに **`verifyTurnstile`（Cloudflare siteverify への外部往復）**が走る。
  これは MF-3 で塞いだはずの穴（「Turnstile の siteverify を無制限に叩かせる」）そのものである。

- **どちらが正しいか（私の判定）**: **契約（Cookie の存在を見る）が正しく、テストの `recover()` が誤っている。**

  回復を必要とする利用者は**必ず印の付いた Cookie を持っている**——
  印は発行時に Cookie へ焼かれるものであり、Cookie を持たない利用者は
  `GET /api/form-session` で新しい Cookie を得るだけで済む（回復経路を通る理由が無い）。
  したがって「Cookie を持つこと」を要求しても正規の回復導線は 1 つも壊れず、
  Tier D 軸（Cookie 軸）が保たれる。`recover()` が Cookie を送っていないのは
  **実際の回復シナリオを再現していない**からであり、テスト側の欠陥である。

- **改善案**:
  1. `app/api/form-session/route.ts` を契約どおり
     `verifyFormSession: (req) => readFormSessionCookie(req) !== null` に戻す。
  2. `tests/integration/form-session-recovery.int.ts` の `recover()` に
     **印の付いた Cookie を渡す**（`exhaustFreeQuota()` の後に取得した `marked` をそのまま使う）。
     これはテストを弱めるのではなく、**シナリオを現実に合わせる**変更である。
  3. CR-002 の pin 修正を同時に入れる（さもなければ同じ差し替えが再び素通りする）。
- **理由**: 「テストが赤いから実装を合わせる」判断そのものは、
  実装を歪めるのではなく**エスカレーションした**という点で正しかった（Impl は勝手にテストを直していない）。
  しかし判断の結果として**承認済みの契約より弱い実装**が入り、
  それが誰の目にも触れずに全ゲート green になっている。

### [CR-002] その `verifyFormSession` を守るはずの pin が**空振り**している

- **種別**: Bug（テストの空振り）
- **重要度**: **Must Fix**
- **場所**: `tests/unit/form-session-route-contract.test.ts:136-161`
- **現状**: 当該テストは 3 つの assertion を持つ。

  ```ts
  expect(section).toMatch(/verifyFormSession\s*:/)                                   // ①
  expect(section).not.toMatch(/verifyFormSession\s*:[^,\n]*verifyFormSessionValue/)  // ②
  expect(section).toMatch(/readFormSessionCookie/)                                   // ③
  ```

  `verifyFormSession: () => true` に対して:
  - ① 通る（キーは存在する）
  - ② 通る（値に `verifyFormSessionValue` は無い）
  - ③ **通る。しかし理由が違う。** `postSection()` は `export const POST` 以降の**全文**であり、
    その中には `:257` の
    `const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, now)`
    がある（**`hasVerifiedSession` を計算する別の箇所**）。
    ③ はこの無関係な出現に一致している。

  つまり「`verifyFormSession` が Cookie の存在を見ていること」は**1 つも測られていない**。
  前回のレビューで私はこのテストを「設計側が自力で見つけた穴」として高く評価したが、
  **意図は正しく実装が空振りしていた**。指摘として不十分だったことを記録する。

- **改善案**: 既に同ファイルが使っている `extractOptionValue` で**オプションの値だけ**を切り出す。

  ```ts
  const value = extractOptionValue(postSection(), 'verifyFormSession')
  expect(value, 'verifyFormSession が渡されていない').not.toBeNull()
  expect(value!, 'Cookie の存在を見ていない（() => true 等で素通りしている）')
    .toMatch(/readFormSessionCookie/)
  expect(value!, 'verifyFormSessionValue を使っている（印付き Cookie が弾かれる）')
    .not.toMatch(/verifyFormSessionValue/)
  ```

  **修正後、`() => true` に戻すと赤くなることを実測で確認すること**（P3-c1 §14 の変異手順）。
- **理由**: MF-2 の再検収で `extractOptionValue` を導入した目的は、まさに
  「ファイル内のどこかに綴りがあれば通る」形を排除することだった。
  同じファイルの中で 1 箇所だけ旧来の広い検査が残り、**そこが実際に破られた**。

### [CR-003] `AC-009-11(b)`（非表示中は再発行しない）を測るテストが**何も測っていない**

- **種別**: Bug（テストの空振り）
- **重要度**: **Must Fix**（修正は安い）
- **場所**: `tests/e2e/playwright/license-upload.spec.ts`（非表示テスト）/
  `components/apply/LicensePhotoUpload.tsx:64,67,268-289`
- **現状**: 依頼 4 への回答のとおり、`REISSUE_TICK_MS = 30_000` /
  `REISSUE_BEFORE_MS = 120_000` に対して E2E は 3 秒しか待たない。
  **実装が壊れていても（あるいは丸ごと無くても）green になる。**
  加えて、ローカルアダプタでは `Failed` になるためタイマー自体が張られない（Impl の :493 の申告）。
  **二重の意味で測っていない。**
- **改善案**（安い順。**(A) を推す**）:

  **(A) 判定を純関数へ切り出して unit で pin する。**

  ```ts
  // components/apply/LicensePhotoUpload.tsx（または lib/ へ）
  export function shouldReissue(input: {
    visibilityState: string; now: number; expiresAt: number; reissueCount: number
  }): boolean
  ```

  `hidden` なら false / 期限まで 120 秒超なら false / 上限 3 回で false / それ以外 true——
  4 件で網羅でき、**30 秒待たずに実測できる**。E2E は「タイマーが張られること」だけを見る。

  **(B) 測っていないことを明記する。** E2E のコメントに
  「本テストは POST が 0 件であることを確認するが、tick は 30 秒間隔なので
  **実装の欠陥を検出しない**。AC-009-11(b) の実質的な担保は（A）の unit にある」と書き、
  設計文書と完了記録の AC 対応表で **AC-009-11(b) を「未検証」**として扱う。
- **理由**: このプロジェクトは「**空振りしているテストを green として報告しない**」を
  申し送り原則 4 として明文化しており、P3-c1 では同じ形（`log:` の正規表現・
  `TypeError` で落ちる red）を 2 度自力で是正している。
  Impl が自己申告した以上、**green のまま残す選択肢は無い**。

---

## 3. 指摘事項（Should Fix）

### [SF-1] **本番のアップロード経路（ブラウザ → Blob への PUT）は一度も実行されていない**

- **場所**: `lib/storage.ts`（`createBlobStorageAdapter`）/ 実装記録 §1「Vercel Blob 実装は未検証」
- ローカルアダプタは PUT できないハンドルを返し、UI は `Failed` にする（依頼 1 のとおり正しい）。
  したがって **unit / integration / E2E のいずれも、実際にバイトがストレージへ渡る経路を通っていない。**
  サーバー側の受け入れ（発行 → 検証 → 紐付け → 削除）は `uploads-license.int.ts` が
  ローカルアダプタの `put()` 経由で通しているので、**未検証なのは「ブラウザ → ストレージ」の 1 区間**である。
- **記録として残し、リリース前ゲートにすること**:
  > F-009 は**本番構成（Vercel Blob）で一度も動作確認されていない**。
  > `BLOB_READ_WRITE_TOKEN` を設定した環境で、
  > (1) 署名付き PUT が成功する (2) `head()` が実サイズを返す (3) `readPrefix(12)` が
  > マジックバイトを返す (4) `deleteObject` が消す、の 4 点を手動で確認するまで
  > **F-009 を「完了」と記録しない。**
- これは実装の欠陥ではなく**検証手段の不在**なので Should Fix に留めるが、
  P3-c2 の完了条件としては明示が要る。

### [SF-2] orphan 回収バッチが**本番で一度も走らない**（cron 登録が無い / 結線が未検証）

- **場所**: `app/api/cron/orphan-uploads/route.ts` / 実装記録 §8
- Impl が自己申告している 2 点:
  - 「**このルートを直接測るテストは存在しない**」（`withCronAuth` と `collectOrphanUploads` は
    別々に測られているが、**両者の結線は未検証**）
  - 「`vercel.json` への cron 登録も行っていない（スコープ外）」
- ルートを作ったこと自体は正しい（作らなければ `lib/orphan-uploads.ts` が
  「そもそも到達しない受け口」になる）。しかし**登録が無ければ結局走らない。**
  AC-PII-8 / AC-PII-11 は APPI 由来の保持期間要件なので、
  「実装したが動いていない」は「実装していない」と同じ結果になる。
- **P3-d の必須項目として起票すること**（`vercel.json` の cron 登録 + 結線の結合テスト 1 本）。
  P3-d は保持期間削除バッチを作る単位なので、**同じ形の登録が 2 つ必要**になる。

### [SF-3] `AC-RL-15(a)` の既存 pin がコメントに一致して green（Impl の自己申告）

- **場所**: `tests/unit/semaphore.test.ts` の
  `/export\s+const\s+maxDuration\s*=\s*PUBLIC_HANDLER_MAX_DURATION_SEC\b/`
- `\s` が改行に一致するため構造を見ておらず、**解説コメント内の同じ綴り**で通っている。
  Impl は「本単位では既存 green を触らない」と判断して申し送った——**その判断は正しい**
  （実装フェーズで既存テストの意味を変えるのは、差し戻しの余地が無い形で契約を動かすことになる）。
- **別途起票し、次の単位で `extractOptionValue` 相当の形へ締めること。**
  同型の空振りが本単位で実際に破られた（CR-002）ばかりなので、優先度は低くない。

### [SF-4] 「ステップの必須入力」クラスに静的 pin が無い（依頼 3 の残り）

- §15.6 の 4 pin はセレクタとデバウンス／文言のクラスを塞いだが、
  「E2E ヘルパが通過するステップに必須入力が増える」クラスは**実行するまで分からない**。
- 静的に突き合わせるのは高くつくので、**既知の限界として設計文書に 1 行残す**のが妥当:
  > `gotoLicenseStep` / `gotoInquiryConfirm` は各ステップの必須入力を手で埋めている。
  > **バリデーションに必須項目が増えるとここが壊れる**（静的 pin は無い / 検出は E2E の実行時）。
  > 必須項目を増やす変更では、この 2 つのヘルパを必ず併せて見ること。

---

## 4. Nit

### [N-1] `uploads-cost.int.ts` への `vi.resetModules()` 追加（オーケストレーター判断）は**弱体化ではない**

- **場所**: `tests/integration/uploads-cost.int.ts:73-74`
- Impl が「実装は正しいがテスト間で `issueLimiter`（モジュール大域）の無コスト枠が共有され、
  実行順序に依存して達成不能」と報告し、`beforeEach` で `vi.resetModules()` して
  ルートを読み直す案を提示 → 適用されている。
- **アサーションは 1 つも変わっていない。** 変わったのは
  「各テストが**自分の窓**で始まる」ことだけであり、これはテストの独立性として**正しい形**である
  （P3-c1 の REV-P3C1-005 で `news` の相互汚染を直したのと同じ原則）。
  各テスト**内部**では従来どおり共有カウンタの振る舞いを測っている。
- **弱体化ではないと判定する。** ただし**テストの変更であることは完了記録に残すこと**
  （Test Agent 以外が触った差分は、後から見ると出所が分からなくなる）。

---

## 5. 良い点

- **`verifyFormSession` の差分を自己申告した**（実装記録 §6 / :214-231）。
  テストと契約が両立しないときに**テストを黙って直さず、実装の選択と帰結を表にして申告**している。
  CR-001 / CR-002 はこの申告が無ければ全ゲート green のまま通過していた。
  **正直な申告が防御として機能した実例**である。
- **非表示テストが何も測っていないことを自分から書いた**（:506-510）。
  「私の実装は正しく hidden をガードしているが、**それが理由で green になるわけではない**」という
  区別ができている。green の理由を問う規律が実装側にも定着している。
- **`apply-complete` を足しかけて pin で気付いた**（:398-401）。
  Test Agent が新設した `e2e-selector-contract.test.ts` が意図どおり機能した実例で、
  「前回の報告を前提に実装していたら不要な testid を足していた」と経緯まで残している。
- **`lib/upload-validation.ts` をクライアント安全にした**改修。
  `node:fs/promises` を読む `lib/storage.ts` からの import を断ち切り、
  定数の正典を移して逆方向に再 export することで、
  **既存の import 位置を 1 つも壊さずに**バンドルの穴を塞いでいる。
- **`useRef` による二重の網**（依頼 2）と、**`previewUrl` を親へ渡さない**判断。
  「保存対象の器に入れない」と「キー名で落とす」を**別種の防御**として重ねている。
- **トランザクション境界**（RV-P3D-S10）を守り、写真が無い経路は
  従来どおり `create` のままにして既存テストのモック前提を壊していない。

---

## 6. 差し戻しの範囲

| 項目 | 状態 |
|------|------|
| `lib/storage.ts` / `upload-validation` / `upload-token` / `orphan-uploads` / uploads ルート / 紐付け / UI | **Approve 相当。手を入れる必要は無い** |
| `app/api/form-session/route.ts` の `verifyFormSession` | CR-001（1 行）+ `recover()` の Cookie 送出（数行） |
| `form-session-route-contract.test.ts` の pin | CR-002（`extractOptionValue` へ）+ 変異確認 |
| 非表示時の再発行抑止 | CR-003（(A) 純関数 + unit 4 件、または (B) 未検証として記録） |

**CR-001 / 002 / 003 を解決すれば Approve。** 再レビューは差分のみでよい。

## 7. 完了記録への申し送り

1. **RV-P3B-019 は「解けた」と記録してよい**——E2E の送信成功スペックが green になったので、
   前回申し送り 3 の条件（config の pin ではなく E2E の green で示す）を満たしている。
2. **WebKit skip の内訳を §9.2 の形式で併記すること**（`180 passed / 13 skipped（うち uploads 系 M 件は WebKit 除外）`）。
3. **F-009 は「本番構成で未検証」として記録すること**（SF-1）。
4. orphan 回収の cron 登録（SF-2）と `AC-RL-15(a)` の pin（SF-3）を**別票として起票**すること。
