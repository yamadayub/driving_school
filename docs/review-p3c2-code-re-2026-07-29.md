# コードレビュー（再検収 / 最終）: P3-c2（F-009 免許証写真アップロード本体）

## レビュー日: 2026-07-29
## 対象Phase: 実装（Phase 7 再検収）
## レビュワー: Senior Engineer Agent（`.claude/skills/senior-review.md`）
## 経緯: `docs/review-p3c2-code-2026-07-29.md`（Must Fix 3 / Should Fix 4 / Nit 1）→ 本ファイル

---

## 総合評価: **Approve**

## **P3-c2 を完了として P3-d へ進んでよい。**

| 指摘 | 判定 |
|------|------|
| **CR-001**（回復経路の `verifyFormSession: () => true`） | **クローズ** |
| **CR-002**（その pin が空振り） | **クローズ** |
| **CR-003**（AC-009-11(b) が何も測っていない） | **クローズ**（削除 **＋ unit pin**。推奨より良い形） |
| SF-1（本番のアップロード経路が未実行） | **繰り越し**（リリースゲート。P3-c2 の完了はブロックしない） |
| SF-2（orphan 回収の cron 登録が無い） | **P3-d へ繰り越し**（同じ形の登録が P3-d で 2 つ必要になる） |
| SF-3 / SF-4 / N-1 | **クローズ**（起票・記録） |

- **未クローズ: 0 件**
- 新規 Must Fix: **0 件** / 新規 Should Fix: **0 件** / 新規 Nit: **2 件**
- 退行: **無し**

---

## 0. 自分で実測したこと

**ポート 3000 に触れるコマンドは一切実行していない。**

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` 相当 | **62 ファイル / 957 件 全パス** |
| `pnpm test:integration` 相当 | **12 ファイル / 115 件 全パス** |
| `npx tsc --noEmit` | **エラー 0** |

`build` / `e2e`（178 passed / 0 failed / 12 skipped）は報告を受け入れる。
E2E の総数 193 → 190 の減少は CR-003 の削除と整合する
（1 テスト × chromium/firefox = passed −2、webkit = skipped −1）。

---

## 1. CR-001 — **クローズ**

`app/api/form-session/route.ts:324` が承認済み契約に戻っている。

```ts
verifyFormSession: (req) => readFormSessionCookie(req) !== null,
```

加えて `:300-323` に **(a) 渡さない / (b) `verifyFormSessionValue` / (c) 本実装** の 3 案比較と、
**`() => true` にしてはならない理由**（`formSessionKey` が Cookie 無しで `null` を返すため
formSession 軸が作られず、縮退では発信元軸が計数のみ ⇒ Tier D 軸ゼロ ⇒
1 リクエストごとに siteverify への外部往復）が残されている。
**一度踏んだ穴を、次に読む人が同じ判断で踏み直せない形**になった。

`tests/integration/form-session-recovery.int.ts` も `recover(captchaToken, cookieValue)` へ変わり、
`:213 / :230 / :246 / :250` がいずれも `currentCookie()`（枠を使い切った後に取得した
**印の付いた Cookie**）を渡している。**シナリオが現実に合った。**

### 依頼 4 の判定: **印の付いた利用者は回復できる。SEC-067 の契約は壊れていない**

これは P3-c1 の Security 監査が「`hasVerifiedSession` は印付き利用者に原理的に到達しない」と
実測した箇所と隣接するので、機構を追って確認した。

| 段階 | 印付き Cookie を持つ利用者の挙動 |
|------|------------------------------|
| ラッパの Tier B 判定 | `readFormSessionCookie` は**ヘッダを解析して値を返すだけ**で、署名も印も見ない ⇒ **非 null ⇒ 通過** |
| Tier D（formSession 軸） | Cookie があるので**軸は作られる**（`formSessionAxisKey` は形式検査のみ） |
| ハンドラ内 `hasVerifiedSession` | `verifyFormSessionValue` は印付きに `null` を返す ⇒ **false** ⇒ 発行へ進む |
| 発行 | `challengeToken`（siteverify 通過済み）を渡す ⇒ **印の無い Cookie** |

**(b) を選んでいたら弾かれていた**のは `verifyFormSessionValue` が印を見るためで、
`readFormSessionCookie` は見ない——**この差がまさに契約の要点**である。
実証としても `form-session-recovery.int.ts` 5 件が green（自分で実行して確認）。

---

## 2. CR-002 — **クローズ**（依頼 2: 空振りは残っていない）

`tests/unit/form-session-route-contract.test.ts` が
**`extractOptionExpression(postSection(), 'verifyFormSession')`** で
**オプションの値そのもの**を切り出してから検査する形になった。

助数の確認もした:

- **`expect(section...)` 形式（セクション全文への `toMatch`）は同ファイルに 1 件も残っていない**（grep 済み）。
- `tests/unit/helpers/route-source.ts` の `extractOptionExpression` は正規表現ではなく
  **小さなパーサ**である——括弧の深さ / クォート（`'` `"` `` ` `` とエスケープ）/ 行コメントを追い、
  **トップレベルのカンマ**か**呼び出し全体の閉じ括弧**で止まる。
  実ソースの `verifyFormSession: (req) => readFormSessionCookie(req) !== null,` に対して
  `(req) => readFormSessionCookie(req) !== null` だけを返す。
  **`:257` の `hasVerifiedSession` 計算に一致する余地は構造上無い。**
- テスト内に CR-002 の経緯（初版が何に一致していたか）が記録されており、
  同型の再発時に原因追跡ができる。

**空振りは解消している。**

---

## 3. CR-003 — **クローズ**（依頼 3: 削除は妥当。しかも推奨より良い）

私の改善案は **(A) 純関数へ切り出して unit で pin** を推し、
(B) 未検証として記録するのを次善としていた。実装は **(A) と (B) の両方**を行っている。

### (A): 判定が純関数として抽出され、**実際に呼ばれている**

- `components/apply/LicensePhotoUpload.tsx` に `reissueDecision`（3 値: `wait` / `degrade` / `reissue`）と
  その boolean 版 `shouldReissue` を export。
- **`setInterval` のコールバックが `reissueDecision` を実際に呼んでいる**ことを確認した——
  「受け口はあるが呼ばれない」形（本プロジェクトが 6 回踏んだ型の 4 段階目）になっていない。
  コールバック内に条件が書き足されておらず、
  「ここに条件を書き足さないこと（書き足した瞬間、unit で測れる判定と実際に走る判定が分岐する）」
  というコメントまで置かれている。
- `tests/unit/license-photo-reissue.test.ts` が `hidden` / 期限までの余裕 / 上限（`MAX_REISSUE_PER_SLOT`
  の直前と到達）を **30 秒待たずに**網羅する。

### (B): 削除の判断は妥当である

削除された E2E は**二重の意味で何も測っていなかった**:
1. `REISSUE_TICK_MS = 30_000` / `REISSUE_BEFORE_MS = 120_000` ⇒ 最初の再発行は約 180 秒後。E2E は 3 秒待ち。
2. ローカルアダプタでは `failed` になるので **`state.kind === 'uploaded'` に到達せず、タイマーがそもそも張られない。**

②があるため、**この E2E は環境上そもそも測れない**——「測れる形に直す」選択肢が E2E 側には無い。
したがって「削除して unit へ移す」は消去法ではなく**唯一の正解**である。
削除跡（`license-upload.spec.ts:395`）に理由・数値・原則（申し送り原則 4）が残されており、
「昔あったテストが消えた」ではなく「**なぜ消したか**」が追跡できる。

> **空振りテストを残すのが最悪である**（後で「あるから確認済み」と誤読される）

という記述に同意する。**削除は正しかった。**

---

## 4. SF-1 / SF-2 の扱い（依頼 5）

### SF-1（本番のアップロード経路が一度も実行されていない）— **P3-c2 の完了はブロックしない。リリースゲートとする**

- 未検証なのは**「ブラウザ → ストレージ」の 1 区間だけ**である。
  発行・検証・紐付け・削除・回収はローカルアダプタ経由で `uploads-license.int.ts` 17 件が通している。
- 検証には Vercel Blob のアカウントが要る。**手元に無いものを待って単位を止めるのは正味で損**であり、
  P3-d（保持期間バッチ）は写真の PUT 区間に依存しない。
- **したがって繰り越す。ただし次の形で記録すること**:
  > **F-009 は本番構成（Vercel Blob）で一度も動作確認されていない。**
  > `BLOB_READ_WRITE_TOKEN` を設定した環境で
  > (1) 署名付き PUT の成功 (2) `head()` が実サイズを返す (3) `readPrefix(12)` がマジックバイトを返す
  > (4) `deleteObject` が消す——の 4 点を確認するまで**リリースしない**。
  > `docs/phase-status.md` の P3-c2 完了記録は「**実装完了・本番構成未検証**」と書く。

### SF-2（orphan 回収の cron 登録が無い）— **P3-d へ繰り越す**

- P3-d は保持期間削除バッチを作る単位であり、**同じ `vercel.json` の cron 登録が 2 つ必要**になる。
  まとめてやるのが安く、登録漏れも 1 度の確認で済む。
- **P3-d の必須項目として起票すること**（2 点セット）:
  1. `vercel.json` への cron 登録（`orphan-uploads` と保持期間バッチ）。
  2. **ルートとバッチ本体の結線を測る結合テスト**（現状は `withCronAuth` と `collectOrphanUploads` が
     別々に測られているだけで、両者の結線は未検証 = Impl の自己申告）。
- AC-PII-8 / AC-PII-11 は APPI 由来なので、**P3-d の完了条件から外さないこと。**
  「実装したが動いていない」は「実装していない」と同じ結果になる。

---

## 5. 新規 Nit

### [N-2] `degrade` 分岐は unit で区別されていない

- **場所**: `tests/unit/license-photo-reissue.test.ts` / `LicensePhotoUpload.tsx` の `reissueDecision`
- unit は boolean 版 `shouldReissue` を測っているので、**`wait` と `degrade` がどちらも `false`** に潰れる。
  「上限到達で `degraded` へ遷移する」（SPEC-009 / ui-design §2 の UI 状態）は測られていない。
  security 上の要点（`hidden` なら再発行しない）は覆えているので優先度は低いが、
  `reissueDecision` を直接測る 1 件を足せば 3 値すべてが固定できる。

### [N-3] `extractOptionExpression` はブロックコメントを扱わない

- **場所**: `tests/unit/helpers/route-source.ts`
- 行コメント（`//`）は追うが `/* */` は追わない。オプション値の中にブロックコメントを書き、
  その中に `readFormSessionCookie` 等の綴りがあると一致しうる。
  実害は薄い（値の内側なので誤検出の範囲は狭い）が、
  **このヘルパは今後の contract pin の土台**なので、既知の限界として 1 行残しておくとよい。

---

## 6. 良い点（P3-c2 全体の総括）

- **3 件の Must Fix がいずれも「green だが何も守っていない」型で、すべて是正された。**
  うち 2 件は Impl の自己申告が起点である。**申告が防御として機能した**——
  CR-001 / CR-002 は申告が無ければ全ゲート green のまま通過していた。
- **CR-003 が推奨（A or B）を上回る形で解決された。** 純関数の抽出と削除跡の記録を両方行い、
  かつ**抽出した関数が実際に呼ばれていること**まで実装側で担保している
  （コールバックに条件を書き足すなという警告つき）。
- **`extractOptionExpression` が「綴りがあれば通る」形を構造的に排除した。**
  P3-c1 から続く「ソース検査の弱さ」という課題に対し、
  1 箇所の修正ではなく**再利用できるパーサ**で答えている。
- **一度踏んだ誤りを、次の人が踏めない形で残している。** `route.ts:300-323` の 3 案比較、
  削除跡の理由、テスト内の CR-002 の経緯——いずれも「正解」だけでなく
  「**なぜ他の案が誤りか**」が書かれている。

---

## 7. P3-d への申し送り

1. **SF-2 を必須項目として起票**（cron 登録 + 結線の結合テスト）。
2. **SF-1 をリリースゲートとして記録**（`docs/phase-status.md` の P3-c2 は「本番構成未検証」）。
3. **SF-3**（`AC-RL-15(a)` の pin がコメントに一致して green）を別票で起票し、
   `extractOptionExpression` 相当の形へ締めること。同型の空振りが本単位で実際に破られている。
4. **SF-4**（E2E ヘルパの必須入力ドリフト）は既知の限界として設計文書に記録済み。
   バリデーションに必須項目を増やす変更では `gotoLicenseStep` / `gotoInquiryConfirm` を必ず併せて見ること。
5. 完了報告では **WebKit skip の内訳**を併記すること（`178 passed / 12 skipped（うち uploads 系は WebKit 除外）`）。
