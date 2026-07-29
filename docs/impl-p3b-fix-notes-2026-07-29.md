# P3-b 差し戻し修正 — 実装記録

## 作成日: 2026-07-29
## 担当: Impl Agent
## 入力: `docs/review-p3b-fix-tests-2026-07-29.md`（テスト契約＝実装仕様）/ `docs/p3b-fix-plan-2026-07-29.md`（スコープ）
## 対象: **Must Fix 6 件**（RV-P3B-001〜005 + SEC-057）/ **Should Fix 4 件**（RV-P3B-006〜009）/ RV-P3B-012（UI 分解）

---

## 0. 各ゲートの実測値

| ゲート | 修正前（red） | 修正後 | 実行者 |
|--------|-------------|--------|--------|
| `pnpm test:unit` | 13 failed / 707 passed (720) | **720 passed / 47 files** | Impl（実測） |
| `pnpm test:integration` | 5 failed / 71 passed (76) | **76 passed / 8 files** | Impl（実測） |
| `pnpm type-check` | 0 | **0** | Impl（実測） |
| `pnpm lint` | 0 | **0**（`✔ No ESLint warnings or errors`） | Impl（実測） |
| `pnpm build` | — | **未実行** | **オーケストレーターの実測値を待つ**（自分では未実行） |
| `pnpm test:e2e` | — | **未実行** | **オーケストレーターの実測値を待つ**（自分では未実行） |

**退行なし。** 既存 682 unit / 63 integration は 1 件も落ちていない
（720 = 682 + 新規 38、76 = 63 + 新規 13。いずれも全パス）。

> **`pnpm build` / `pnpm test:e2e` / `next start` / ポート 3000 に触れるコマンドは一切実行していない**
> （前回の衝突の再発防止として、実行主体をオーケストレーターに固定する運用に従った）。
> したがって本記録に**ビルド成否と E2E の実測値は書けない**。§7 に E2E への影響予測だけを記す。

---

## 1. SEC-057（High / 唯一の着手ブロッカー）をどう閉じたか

### 1.1 課したコストの形

> **軸として機能するために必要なのは「一意であること」ではなく「入手にコストがあること」。**

一意性は型（`PerRequesterKey`）で表せるが、入手コストは型では表せない——型に書けるのは
**値の形**であって、**値を得るために攻撃者が払う量**ではない。したがってコストは振る舞いとして実装した。

**「無コスト枠を超えて発行した Cookie に未検証の印を付ける」**（監査の修正方針 (a)）。

| ファイル | 変更 |
|---------|------|
| `lib/form-session.ts` | `FormSessionPayload` に `unverified?: true` を追加。`createFormSessionValue` は**印がある場合だけ**キーを書く。`verifyFormSessionValue` は印のある値に対して `null` を返す |
| `lib/form-session-issue.ts` | `FORM_SESSION_FREE_ISSUE_LIMIT = 10` を新設。**縮退（`trusted === false`）で**消費数が 10 を超えたら `unverified: true` で発行する |

判定は**正典関数だけ**に置いた（`app/api/applications/route.ts` の `verifyFormSession:` ラムダは 1 文字も変えていない）。
ラムダに書くと AC-RL-8 違反であり、`tests/unit/form-session-issue-cost.test.ts` を green にできない。

### 1.2 閾値 **10** の根拠（`lib/form-session-issue.ts` に同内容をコメントで残した）

- **上界**: 監査実測（Cookie 20 枚 × 3 回 = 60 件成功）を確実に閉じるため **20 未満**であること。
  `FORM_SESSION_ISSUE_LIMIT`(30) を流用すると**監査の 20 枚シナリオで 1 枚も印が付かず、何も直らない**。
- **下界**: 正規利用者は 1 回の来訪で 1 枚しか要らない（Cookie 寿命 30 分 / 発行窓 10 分）。
- **本体到達数の上界**: 印の無い Cookie 10 枚 × 送信側 Cookie 軸 3 回 = **30 回**。
  テストが基準とした上限（`FORM_SESSION_ISSUE_LIMIT × FORM_SESSION_LIMIT` = 90）を大きく下回る。

### 1.3 実測（テスト側の出力より）

| 契約 | 修正前 | 修正後 |
|------|--------|--------|
| Cookie 20 枚 × 3 回 | **60/60 が本体へ到達** | **30**（< 60） |
| 枚数に比例しない（40 枚 → 200 枚） | 120 → **600 に増加** | **30 → 30**（増えない） |
| 枚数に依存しない上限（≤ 90） | 600 | **30** |
| 結合（2 ルート跨ぎ / DB 行数） | 60 行 | **30 行**（< 60） |

### 1.4 同時に壊していないこと（ガードレール 5 本＋結合 1 本）

- 縮退でも Cookie 1 枚・3 回以内の利用者は **201**（一律 Tier B にしていない）。
- 攻撃者が枠を使い切った後の新しい利用者は **403（Tier B）で、429 ではない**
  ——共有 `unknown` バケットを硬い拒否にする形（SEC-021 → SEC-043 の 4 度の再発）を持ち込んでいない。
- 通常構成（`trusted=true`）の到達数は `SOURCE_LIMIT`(5) のまま。**印は縮退でしか付けない**
  （Vercel 上の NAT 配下の利用者を CAPTCHA 地獄に落とさないため）。
- `createFormSessionValue({ sid, issuedAt })` の値は**バイト単位で従来と同一**であり、引き続き検証を通る。
- 縮退構成で 40 回目も**発行は続く**（第三者に `/apply` を封鎖させない）。

### 1.5 **残余リスク（過大報告しないための明示）**

**縮退構成では、窓あたり 11 人目以降の新規来訪者が Tier B になる。** これは仕様どおりの
「回復可能なコスト」だが、**CAPTCHA を解いても抜けられない**——印は Cookie に焼かれているため、
その利用者が回復するのは (a) 発行窓（10 分）が明けて印の無い Cookie を得たとき、
または (b) 電話などの代替導線（RV-P3B-009 で追加）に移ったときである。
テスト側の文言（「Tier B = CAPTCHA で抜けられる」）とはこの点だけ意味がずれるので、**Senior / Security へ明示的に申告する**。

軽減策として (b) を同単位で実装済み（Tier B が 2 回続くと電話番号を表示）。
縮退構成は「Vercel 以外の本番・ローカル・E2E」であり、本デモの想定配備（Vercel）では発生しない。

---

## 2. RV-P3B-001（Must Fix / 機能不成立）— Turnstile の結線

`components/apply/ApplicationForm.tsx`:

1. **グローバルコールバックを実際に定義した**（`window.onTurnstileToken` / `onTurnstileExpired` / `onTurnstileError`）。
   属性値より**上のエフェクト**で定義する（実装スクリプトは読み込み直後にウィジェットを描画するため）。
2. ウィジェットに `data-expired-callback` / `data-error-callback` を追加（トークン寿命 300 秒。
   確認画面に 5 分留まった利用者が期限切れトークンで Tier B に落ちるのを防ぐ）。
3. 送信直前に `turnstile.getResponse()` のフォールバック（`resolveCaptchaToken()`）。ウィジェット未生成時の
   throw は握る（**送信を諦めさせない**）。
4. payload は `captchaToken: resolveCaptchaToken()`。**state の素の参照を渡していない。**
5. **死んだ受信経路（`addEventListener('turnstile-token')`）を削除した。** dispatch する箇所は
   リポジトリに 1 つも無く、「受け口があるから結線済み」と読める誤認の原因そのものだった。

---

## 3. RV-P3B-002（Must Fix）— `?fs=1` の URL 残留

マウント時に `history.replaceState` で `fs` を落とす。**ページ遷移 API は使わない**
（`router.replace()` は入力途中の状態を巻き込んで再マウントさせる。`/apply` は `force-dynamic` なので
サーバー往復になる）。改善案 2（`__Host-fsa` の短命 Cookie）は**任意**なので実装していない。

---

## 4. RV-P3B-003 / 004 / 005（Must Fix）— テストの不在そのものが指摘だった 3 件

| ID | 実装側の変更 | 根拠 |
|----|------------|------|
| RV-P3B-003（KV store 注入） | **無し**（Test Agent が `runtime-stores-wiring.test.ts` 18 本を追加済み。全 green） | テスト追加が修正本体。走査の自己検証 7 本も含めて green |
| RV-P3B-004（AC-RL-13(c) の配線） | **上限到達時の応答形を変更**（§5 参照） | `form-session-route.int.ts` 11 本が green |
| RV-P3B-005（実ブラウザ CSP） | **無し**（`apply-form.spec.ts` に追記済み） | **E2E は未実行**（オーケストレーター） |

---

## 5. RV-P3B-007（Should Fix）— 発行枠でページを奪わない

`app/api/form-session/route.ts`:

1. **サブリソース要求は枠を消費せず、Cookie も発行しない。**
   判定は `Sec-Fetch-Site: cross-site` または `Sec-Fetch-Dest` が `document` 以外。
   **ヘッダが無い要求はナビゲーション扱い**にした（fail-closed にすると、ヘッダを落とす環境の
   利用者がフォームを一切開けなくなる。防御対象である「第三者ページからの要求」は必ずどちらかを伴う）。
   この選択は `form-session-cost.int.ts`（ヘッダを送らずに 20 枚取得することを期待）とも整合する。
2. **上限到達時も `/apply?fs=1` へ 303 する**（`Retry-After` 付き / Cookie は発行しない）。
   生 JSON の 429 をやめた。**Test Agent が申告した契約の解決（429 か 303 かは契約に含めない）に従った。**

---

## 6. RV-P3B-006 / SEC-059（Should Fix）— ボディ上限の打ち切り

`lib/public-guard.ts` の `enforceBodyBytes` を、リーダによる逐次読み取り + 上限超過時の
`await reader.cancel()` に置き換えた。実測（テスト出力）: 4MB の chunked ボディに対し
**読み取り量 4,194,304 バイト → 上限 + 数チャンク以内**。境界（ちょうど上限 = 201 / +1 バイト = 413）と
「上限内なら本体で読み直せる」も green。**評価順序は変えていない。**

---

## 7. RV-P3B-008 / 009（Should Fix）— 表示と挙動の一致 / Tier B の出口

- **RV-P3B-008**: 改善案 (a)（推奨案）を採り、**自動再送を実装した**（`retryAfterMs` 経過後に最大 3 回）。
  文面を消す (b) ではなく (a) を選んだのは、`form-submission.md` §4.4 が定めた挙動そのものだからである。
  待ち時間は**サーバーが決めた `retryAfterMs`** を使い、クライアントは短縮しない（契約ルール4）。
  3 回使い切ったら「もう一度お試しください」＋手動再送ボタンへ切り替える（**そこで「自動的に送信されます」と言い続けない**）。
- **RV-P3B-009**: Tier B の連続回数（`challengeCount`）を保持し、**2 回続いたら電話番号を表示**する
  （`@/lib/school-info` から引く。ハードコードしない）。サーバー応答は一切変えていないので契約ルール3 に抵触しない。
  併せて Tier B を受けたら `captchaToken` を捨てる（期限切れトークンを掴んだまま再送しても結果が変わらないため）。

---

## 8. RV-P3B-012（UI 分解 / I-9）— `application-form.md` §6.4 の分解

Senior の確定判定「P3-c 着手前に分解すること」に従い、**本単位で実施した**。

```
components/ui/           FormField.tsx / RadioCardGroup.tsx / CheckboxGroup.tsx / ImportantNoticeBlock.tsx
components/apply/        ApplicationForm.tsx(717) / form-model.ts / FormErrorSummary.tsx /
                         ReviewSummary.tsx / RateLimitWaitPanel.tsx / FormStepper.tsx(既存)
components/apply/steps/  StepEntry / StepCourse / StepPersonal / StepLicense / StepPreference /
                         StepReview / PreferenceCommonFields
```

**振る舞いは 1 つも変えていない**（`data-testid`・`name` 属性・ラベル文言・DOM 構造を維持）。
ラジオはカード状の `<label>` になったが、**ネイティブの `<input type="radio">` は視覚的に残している**
——`sr-only` にすると `[name="school"]` の可視性を見る E2E が落ちるうえ、タップ位置とフォーカス位置がずれる。

### 8.1 §6.4 と異なる点（**Senior へ申告する 3 件**）

| 項目 | 判断 | 理由 |
|------|------|------|
| `TurnstileWidget.tsx` を**作っていない** | ウィジェットの JSX は `ApplicationForm.tsx` に残す | `data-callback` 属性値と `window` への代入名の一致は**型検査で捕まらない**ため、`application-form-client-wiring.test.ts` が**`ApplicationForm.tsx` のソース走査**で固定している。別ファイルへ移すと走査が素通りし、RV-P3B-001 が再発する。同じ理由で**待機パネルの文面**と**代替導線**もこのファイルに残した（部品には `message` / `turnstileSlot` / `statusPanels` として渡す） |
| `LicensePhotoUploader.tsx` を作っていない | P3-c のスコープ | 写真アップロードは本単位のスコープ外 |
| `ConfirmDialog` の `admin/` → `ui/` 移動 | 未実施 | §6.3 が「提案」であり、type 切替の確認ダイアログ自体が未実装。空の移動は依存関係だけ動かして価値が無い |

---

## 9. 実装が触っていないもの（明示）

- `app/api/applications/route.ts` — **1 行も変更していない**（判定を正典関数に閉じた結果）。
- `lib/rate-limit.ts` / `lib/semaphore.ts` / `lib/runtime-stores.ts` / `auth.ts` — 変更なし。
- **テストのアサーション** — 1 つも変更していない。テストファイルは 1 行も編集していない。
- `playwright.config.ts` / E2E スペック — 変更なし。

---

## 10. 申し送り（Senior / Security / 次単位へ）

1. **§1.5 の残余**（縮退構成で窓あたり 11 人目以降が Tier B。CAPTCHA では抜けられない）を判定してほしい。
   受容しない場合の選択肢は「閾値を上げる」（ただし 20 未満の制約がある）か
   「発行時にも Turnstile を課す」（監査の方針 (b)。`GET /api/form-session` が対話的になるので設計が変わる）である。
2. **E2E への影響予測（未実測）**: E2E は縮退構成で走り、テストごとに新しいコンテキスト＝新しい Cookie を得るため、
   10 分あたり 10 回の無コスト枠を**超える**。現行の E2E は**送信を 1 度も行わない**ので影響は無いはずだが、
   **P3-c で送信を伴う E2E を足すときは、この枠に当たる**。その時点で
   「E2E だけ枠を広げる env」ではなく「コンテキストを共有する／`CI=1` の既存フックに合わせる」形で解くこと
   （枠を env で緩める形は、本番でも緩められる経路を作る）。
3. **P3c-1**: SEC-057 の修正は `uploads` エンドポイントにも同じ形で要る。
   本実装は `lib/form-session.ts` / `lib/form-session-issue.ts` に閉じているので、
   `uploads` 側は「同じ `verifyFormSessionValue` を Tier B 判定に使う」だけで転用できる。
4. **RV-P3B-014**（テスト設計文書 §5.3 の評価順序を実装に合わせて更新）は**スコープ外として未実施**
   （Must Fix 6 / Should Fix 4 に含まれない文書整合）。
5. **RV-P3B-010 / 011 / 013 / 015〜017 は未着手**（本単位のスコープ外）。
6. **SEC-058（Medium）も未着手**（Test Agent が対象外と宣言した範囲）。
