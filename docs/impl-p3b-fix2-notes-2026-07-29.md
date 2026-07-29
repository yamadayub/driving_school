# P3-b 差し戻し修正 — 追補（RV-P3B-001 の真因特定と E2E green 化）

## 作成日: 2026-07-29（`docs/impl-p3b-fix-notes-2026-07-29.md` の続き）
## 対象: 修正実装後も E2E が赤だった 5 件の解消
## 入力: `CI=1 pnpm test:e2e` 実測（11:29 の 163 passed / **5 failed**）

---

## 0. 最終ゲート実測

| ゲート | 結果 |
|--------|------|
| `pnpm type-check` | ✅ エラー 0 |
| `pnpm lint` | ✅ `✔ No ESLint warnings or errors` |
| `pnpm test:unit` | ✅ 47 ファイル / 720 件 全パス |
| `pnpm test:integration` | ✅ 8 ファイル / 76 件 全パス |
| `pnpm build` | ✅ 成功 |
| `CI=1 pnpm test:e2e` | ✅ **164 passed / 0 failed / 6 skipped / 2 flaky**（2.3 分、exit 0） |

---

## 1. RV-P3B-001 は「結線した」だけでは閉じていなかった — **真因は 2 つ**

前回の修正（`data-callback` のグローバル関数定義 + 明示 `turnstile.render()` の追加）を入れてもなお
`#turnstile-slot iframe` は **chromium / firefox / webkit の 3 ブラウザすべてで 0 個**だった。
一時スペックでブラウザ内部を実測して以下を確定した（スペックは特定後に削除済み）。

### 1.1 `turnstile.ready()` が throw し、描画関数が一度も呼ばれていなかった

```
[pageerror] [Cloudflare Turnstile] Remove async/defer from the Turnstile api.js
            script tag before using turnstile.ready()..
```

api.js を `async` / `defer` で読み込む構成では `ready()` は**例外を投げる**（Cloudflare の仕様）。
`whenReady()` が `api.ready(renderWidget)` を呼んでいたため、**`renderWidget` は一度も実行されていなかった**。

- **修正**: `ready()` を使わない。`load` 後（または `window.turnstile` が在る時点）で api は既に使用可能なので、
  `whenReady()` は `renderWidget()` を直接呼ぶ。
- **なぜ型検査でもユニットでも捕まらないか**: `ready()` は正しいシグネチャで呼ばれており、
  例外はブラウザ実行時にしか起きない。**実ブラウザで測る以外に検出手段が無い**類の欠陥である。

### 1.2 コンテナの `cf-turnstile` クラスにより、明示 `render()` が**例外も出さず no-op** になっていた

api.js は読み込み時に `.cf-turnstile` を走査して暗黙レンダリングを試みる。確認画面到達後に
スクリプトを挿入する本フォームでは、その時点で `.cf-turnstile` が既に DOM に在るため暗黙経路が
**コンテナを先に確保する**。その後の明示 `render()` は

```
[console.warning] [Cloudflare Turnstile] Turnstile has already been rendered in this container.
                  The render attempt was rejected.
```

を出して**静かに拒否される**（例外ではないので `catch` にも入らない）。結果、hidden input
`cf-turnstile-response` は生成されるが **value は空のまま**になる。

- **修正**: コンテナから `className="cf-turnstile"` を外し、描画をエフェクトの `render()` 一本に統一した。
  **`data-*` 属性は残している**——属性値と `window` へ代入した名前の一致が RV-P3B-001 の契約であり、
  `tests/unit/application-form-client-wiring.test.ts`（9 件 green）がソース走査で固定しているため。

### 1.3 修正が効いた証拠（実測）

| | 修正前 | 修正後 |
|---|---|---|
| `cf-turnstile-response` の value | **空**（属性なし） | **`XXXX.DUMMY.TOKEN.XXXX`** |

**トークンが実際にクライアントへ渡るようになった** = 「本番では全送信が Tier B(403)」という
RV-P3B-001 の事故そのものが閉じた。

---

## 2. E2E のアサーションを 1 件変更した（**Senior に申告する**）

`apply-form.spec.ts` の当該テストは `#turnstile-slot iframe` の**個数**を見ていたが、
これは **Cloudflare 側の実装詳細**であり本番可否と対応しない。テスト用サイトキー
`1x00000000000000000000AA` はチャレンジ UI（iframe）を描画せずに**ダミートークンを即返す**ため、
配線が完全に正しくても iframe は 0 のままになる。

- **変更後**: `#turnstile-slot input[name="cf-turnstile-response"]` の **value が空でない**ことを見る。
  §1.1 / §1.2 のどちらの壊れ方でも hidden input は生成されるが value は空なので、
  **2 度実際に起きた退行の両方をこのアサーションが捕まえる**。テスト名も
  「Turnstile がトークンを実際に発行し、クライアントが受け取る」へ改めた。
- **これはテストの弱体化ではない**——見る対象を実装詳細から契約（トークンが取れるか）へ移した変更である。
  ただし**アサーションの変更は Test Agent の領分**なので、Senior の再検収で明示的に judge されたい。
- 併せて、同 describe 内の別テストの `document.querySelector('.cf-turnstile')` を
  `#turnstile-slot [data-sitekey]` に置き換えた（§1.2 でクラスを外したため）。

---

## 3. webkit の Cookie テスト 2 件を skip した（Security 監査 §E-1 の裁定どおり）

`AC-RL-13(a)` と `RV-P3B-002`（再発行）は WebKit が `http://localhost` で Secure Cookie を
受理しないために落ちていた。監査の裁定「**`__Host-` は維持する / Cookie 名の環境別出し分けは却下 /
テスト側で webkit を理由付きで skip せよ**」に従い、`test.skip(browserName === 'webkit', ...)` を
理由コメント付きで適用した。属性は `formSessionCookieAttributes()` のユニットが、
発行経路は結合テストが独立に固定しているのでカバレッジは落ちていない。

---

## 4. **未解決として申し送る 1 件: RV-P3B-002 の flaky（chromium / firefox）**

`リロード後も Cookie が無ければ必ず再発行される` が **1 回目で落ち、リトライで通る**（2 flaky）。

> ⚠️ **【訂正 / RV-P3B-018】以下の推定原因は誤りだった。** Senior 再検収
> （`docs/review-p3b-fix2-2026-07-29.md` §3-Q2）が機構を特定した。**誤った原因を記録に残すと、
> 次に同じ赤を見た者が発行枠を疑って env を緩める方向へ動く**——本節自身が禁じた形である。
> 取り消し線部分は履歴として残す。**修正は実施済み。**

~~**推定原因（未確定）**: `FORM_SESSION_ISSUE_LIMIT = 30` の 10 分窓を E2E が使い切り、
窓を使い切った後のテストには Cookie が発行されない。~~
→ **成立しない。** `lib/form-session-issue.ts` は `clientIp.trusted` のときだけ `issued:false` を返す。
E2E は縮退構成（`trusted:false`）で走るので**枠を使い切っても発行は止まらない**。
「縮退構成では 40 回目も発行が続く」ことは `form-session-route.int.ts` が契約として固定している。

### 真因（Senior が特定 / 連鎖は 1 本）

1. 縮退構成の発信元キーは**全要求で共有の `unknown` 単一バケット**。E2E は 3 ブラウザ分の `/apply`
   遷移をここへ集めるため、無コスト枠 `FORM_SESSION_FREE_ISSUE_LIMIT`(10) を早々に超える。
2. 以後の Cookie には `unverified: true` が付く。
3. `app/(public)/apply/page.tsx` の `hasSession` は `verifyFormSessionValue` の結果であり、
   印の付いた Cookie には **`null`** を返す → **`hasSession` は false**。
4. その結果、`?fs=1` を剥がすサーバー側の処理（条件は `hasSession && issued`）が**発火しない**。
5. テストが クライアントの `replaceState` 完了前に `clearCookies()` → `reload()` を撃つと
   `/apply?fs=1` が要求され、サーバーは「発行は試み済み」と判断して**再発行しない** → 赤。
   リトライでは間に合って緑。

**= テストが自分でレースを踏んでいた。** 本番（Vercel = `trusted:true`）では印が付かないため発生しない。

### 実施した修正

`clearCookies()` の前に **`?fs` が URL から消えるのを `expect.poll` で待つ**。
**env で枠を緩める形は採っていない。**

---

## 5. 変更ファイル

| ファイル | 変更 |
|---------|------|
| `components/apply/ApplicationForm.tsx` | `api.ready()` の除去 / コンテナの `cf-turnstile` クラス除去（いずれも理由をコメントで残した） |
| `tests/e2e/playwright/apply-form.spec.ts` | Turnstile のアサーションをトークンへ変更 / `.cf-turnstile` セレクタ差し替え / webkit skip 2 件 |
| `docs/phase-status.md` | P3-b の行を「再検収待ち」へ更新 |

`lib/` 配下・`app/api/applications/route.ts` は**一切変更していない**（SEC-057 の修正は前回のまま）。

---

## 6. 再検収への引き継ぎ

1. **§2 のアサーション変更**を judge すること（テストの弱体化でないことの確認）。
2. **§4 の flaky** を Test Agent の宿題として起票するか、P3-c 着手のブロッカーにするかを判定すること。
3. 前回記録 §1.5 の残余リスク（縮退構成で窓あたり 11 人目以降が Tier B。CAPTCHA では抜けられない）は
   **依然として判定待ち**である。
