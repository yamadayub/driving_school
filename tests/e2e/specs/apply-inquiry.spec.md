# E2E シナリオ: F-008 / F-010 問い合わせ送信（INQUIRY 単独完結）

> P3-b。**写真（F-009）は含まない**（P3-c）。agent-browser での探索・デバッグ用。
> 自動実行版は `tests/e2e/playwright/apply-form.spec.ts`。

## シナリオ名: 問い合わせを最後まで送信できる

### 前提条件
- 本番ビルド（`pnpm build && pnpm start`）が起動している
- 環境変数が揃っている（**揃っていないと起動時に fail-fast する**）:
  `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `FORM_SESSION_SECRET`(32文字以上) /
  `CRON_SECRET`(32文字以上) / `TURNSTILE_SECRET` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
- dev DB（:5433）が稼働し seed 済み
- **`VERCEL !== '1'` のため縮退構成（`trusted=false`）である**（RV-P3AF-006）

### テストステップ
1. `/apply` を開く
2. 入口で「問い合わせ」を選ぶ
3. 氏名 / 氏名カナ / 生年月日 / メール / 電話 を入力する
4. 「次へ」を押す（確認画面へ）
5. **3秒以上経過してから**「プライバシーポリシーに同意する」をチェックする（AC-RL-6）
6. CAPTCHA を通す
7. 「送信する」を押す

### 期待結果
- `__Host-fs` Cookie が step 1 で発行されている（`HttpOnly` / `SameSite=Lax` / `Path=/`）
- step 2 の後、DOM に `plans` / `courseId` / `school` / `format` / `postalCode` / `address` /
  `buildingName` / `licenseRevoked` / `licenseRevokedNote` / `currentLicenses` /
  `preferredStartMonth` / `paymentMethod` / `input[type=file]` が**1つも存在しない**（AC-008-2）
- step 4 までに `/api/applications` への POST が発生していない（AC-008-7）
- step 7 で `201` が返り、完了画面に **26文字の受付番号（ULID）** が表示される
- `localStorage` と Cookie に入力値が書かれていない（AC-008-3）

---

## シナリオ名: 送信間隔が短いと CAPTCHA を求められる（Tier B）

### 前提条件
- 上記と同じ

### テストステップ
1. `/apply` を開く
2. 入口で「問い合わせ」を選ぶ
3. **3秒以内に**全項目を入力し（下書き復元を使うと現実的に到達しうる）送信する

### 期待結果
- `403 { "challenge": "interactive" }` が返る
- UI は**可視 CAPTCHA**（「確認のため、チェックにご協力ください」）を出す
- **降格理由（送信間隔）を表示しない**（Tier B 契約ルール3 / `form-submission.md` §4.2 注記4）
- **入力は保持される**（フォーム状態を破棄しない）
- CAPTCHA を通して再送すると `201` になる

---

## シナリオ名: Cookie をブロックしている利用者でも送信できる（Tier B → 通過）

### 前提条件
- ブラウザで当該サイトの Cookie をブロックする設定にする

### テストステップ
1. `/apply` を開き、問い合わせを入力して送信する
2. 表示された CAPTCHA を通す
3. 再送する

### 期待結果
- 1回目は `403 { "challenge": "interactive" }`（**素通りでも 429 でもない**）
- **「Cookie を有効にしてください」を表示しない**（`form-submission.md` §3.5）
- 2〜3 で送信が成立する（**拒否のまま終わる状態は存在しない**）

---

## シナリオ名: 同一 Cookie から短時間に繰り返すと待たされる（Tier D）

### 前提条件
- 上記と同じ

### テストステップ
1. 同一ブラウザから問い合わせを 4 回連続で送信する

### 期待結果
- 4回目が `429` + `Retry-After` ヘッダ + `{ retryAfterMs }`
- UI は**待機 UI + カウントダウン + 代替導線（電話 / LINE）**を出す（拒否画面にしない）
- カウントダウン 0 で自動再試行する
- **`retryAfterMs` は毎回わずかに違う**（サーバー側 ±20% ジッタ。異常として扱わない）
