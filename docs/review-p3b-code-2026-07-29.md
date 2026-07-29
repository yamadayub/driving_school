# コードレビュー: P3-b 実装（F-008 / F-010 / F-023 `/privacy`）

## レビュー日: 2026-07-29
## 対象Phase: 実装（CLAUDE.md Phase 7 / Senior Engineer）
## レビュワー: Senior Engineer Agent
## 対象コミット相当: `docs/impl-p3b-notes-2026-07-29.md` 時点の作業ツリー

---

## 総合評価: **Request Changes**

品質ゲート（unit 682 / integration 63 / type-check 0 / lint 0 / build 成功）は
オーケストレーターが独立実測済みであり、本レビューでは再実行していない。
**それらが全て green である状態で、本番経路が成立しない欠陥を 1 件検出した**
（RV-P3B-001）。P2 / P2.5 / P3-a と同型の失敗——「テストは緑だが本番経路が守られていない」
——が本単位でも再現している。

### 評価サマリー

- **改善必須（Must Fix）: 5 件**（うち機能不成立 1 / 実利用者に到達する不具合 1 / 完了条件の未達 3）
- **改善推奨（Should Fix）: 9 件**
- **Nice to Have: 3 件**
- Impl 申し送り §8 の 12 件: **受容 8 / 条件付き受容 3 / 却下 1**（I-3 は「未検証」ではなく「実装が壊れている」）

### 良い点（先に記録する）

本単位のコードは、**防御の意図を型と構造に落とす**という P3-a で確立した規律を
ほぼ全域で維持できている。以下は今後も壊さないこと。

1. **`withPublicMutation` の構築時 throw**（`lib/public-guard.ts:263-276`）。
   「`limiters.source` を渡した構成でのみ検査する」という限定の付け方が正しい。
   ラッパを Origin / CT 検証だけに使う経路を壊していないため、**Impl が検査自体を外す動機を作っていない**。
   過剰な検査は守られない、という教訓が実装に反映されている。
2. **`PerRequesterKey` の branded type**（`lib/form-session.ts:31-51`）と、
   ルートが**正典の関数をそのまま渡している**こと（`app/api/applications/route.ts:347`）。
   `?? 'anonymous'` 型の配線が型検査を通らない状態が実際に成立している。
3. **`lib/validators/application.ts` が zod を使わない判断。** 「値を持てない結果型を最初から返す」
   という選択は AC-PII-2 の担保を*読んで確認できる*形にしている。`.superRefine` で潰す案より正しい。
4. **`lib/pii-log.ts` の再帰サニタイズ + `Error` を必ず `{ errorCode }` へ潰す網**
   （`lib/pii-log.ts:119-121`）。「`toErrorLogFields` を使う」という規律が破られた場合の
   最後の網を置いた判断は、SEC-043 が 4 度再発した経緯を正しく一般化している。
5. **`lib/age-eligibility.ts` が `new Date(birthDate)` を使わない純粋暦計算**であること、
   丸めを 1 回に固定したこと（T-Q2）。境界仕様が実装依存にならない。
6. **`lib/spam-signals.ts` が Request もボディも受け取らない**シグネチャ。
   「受け取れる形にした時点で、いつか誰かが使う」という判断は正しい。
7. **`lib/runtime-stores.ts` への注入経路の一本化**（P3b-2 の設計として妥当。§A-2 で詳述）。
8. `verify-p3b.ts` による**テストとは独立した実測**と、`[INFO]` 行での**残余リスクの定量化**。
   「SEC-055 は完全には閉じていない」と自分から書いている点は、過大報告の防止として機能している。

---

# 指摘事項

## Must Fix

### [RV-P3B-001] Turnstile のトークンがクライアントで一度も取得されない — **本番では全送信が Tier B（403）になる**

- **種別**: Bug（機能不成立 / 可用性）
- **重要度**: **Must Fix（最優先）**
- **場所**: `components/apply/ApplicationForm.tsx:411-418`（受信側）/ `:917-924`（ウィジェット）
- **現状**:

```tsx
// :917-924 — ウィジェットは data-callback にグローバル関数名を指定している
<div className="cf-turnstile" data-sitekey={turnstileSiteKey} data-callback="onTurnstileToken" />

// :411-418 — 受信側は window の CustomEvent を待っている
window.addEventListener('turnstile-token', handler)
```

`data-callback="onTurnstileToken"` は **`window.onTurnstileToken(token)` を呼べ**という指定である。
リポジトリ全体を走査した結果、**`onTurnstileToken` は上記の属性値の文字列としてしか存在しない**:

```
$ grep -rn "onTurnstileToken" app components lib tests
components/apply/ApplicationForm.tsx:922:                data-callback="onTurnstileToken"
```

したがって:
- `window.onTurnstileToken` は未定義であり、Turnstile は呼ぶ相手がいない。
- `turnstile-token` という CustomEvent を **`dispatchEvent` する箇所が 1 つも無い**。
- `turnstile.getResponse()` も呼んでいない。
- Turnstile がウィジェット内に挿入する `<input name="cf-turnstile-response">` も読んでいない
  （送信は `FormData` ではなく `JSON.stringify(payload)`。`:442-446`）。

**結果として `captchaToken` は `''` のまま送信される。** サーバー側は
`lib/turnstile.ts:47` の `if (token.length === 0 ... ) return false` で必ず false を返し、
`app/api/applications/route.ts:286-289` が **Tier B（403 `{ challenge:'interactive' }`）** を返す。

**本番（`NODE_ENV=production`）では `TURNSTILE_SECRET` が fail-fast の必須キーへ昇格している**
（`lib/env.ts:80-87`）ため、「鍵が無いから検証を飛ばす」という逃げ道も無い。
**すなわち F-008 / F-010 は本番デプロイ時点で 1 件も受け付けられない。**

これが単体・結合・E2E のすべてを通過した理由も明確である:
- 結合テスト（`applications.int.ts`）は `@/lib/turnstile` を `vi.mock` しており、**クライアントを通らない**。
- E2E（`apply-form.spec.ts`）は**送信を行わない**（テスト設計 §7 が「Tier C の本番経路 E2E は不安定」
  として除外した範囲に、送信経路そのものが落ちている）。
- `scripts/verify-p3b.ts` は `fetch` を差し替えてサーバー側モジュールへ直接投入しており、
  やはりクライアントの結線を通らない。

**Impl の §8 I-3 は本件を「実ウィジェット動作は未検証」と記述しているが、判定は「未検証」ではない。
コードを読めば結線が存在しないことが確定するので、これは既知の欠陥である。**

- **改善案**: グローバルコールバックを実際に定義し、かつ取りこぼしに備えて明示取得も行う。
  期限切れ・エラー時にトークンを捨てることも必須である（Turnstile のトークン寿命は 300 秒で、
  確認画面に 5 分留まった利用者は**期限切れトークンで Tier B に落ちる**）。

```tsx
// スクリプト読込より前に定義すること（実装スクリプトは即座にウィジェットを描画する）
useEffect(() => {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  w.onTurnstileToken = (token: string) => setCaptchaToken(typeof token === 'string' ? token : '')
  w.onTurnstileExpired = () => setCaptchaToken('')
  w.onTurnstileError = () => setCaptchaToken('')
  return () => {
    delete w.onTurnstileToken
    delete w.onTurnstileExpired
    delete w.onTurnstileError
  }
}, [])
```

```tsx
<div
  className="cf-turnstile"
  data-sitekey={turnstileSiteKey}
  data-callback="onTurnstileToken"
  data-expired-callback="onTurnstileExpired"
  data-error-callback="onTurnstileError"
/>
```

さらに送信直前のフォールバックとして、状態が空なら明示取得する:

```ts
const token =
  captchaToken ||
  ((window as { turnstile?: { getResponse(): string | undefined } }).turnstile?.getResponse() ?? '')
```

- **これを検証するテストを必ず同時に足すこと**（今回すり抜けた原因はテストの不在である）:
  1. **ユニット**: `ApplicationForm` をマウントし、`window.onTurnstileToken('tok')` を呼んでから
     送信させ、`fetch` に渡された body の `captchaToken` が `'tok'` であることを固定する。
     **`data-callback` の属性値と、実際に定義されるグローバル名が同一であること**も
     ソース走査で固定する（属性値のタイポは型検査で捕まらない）。
  2. **E2E（chromium 単一）**: `/apply` を確認画面まで進め、`window.onTurnstileToken` が
     `typeof 'function'` であることと、Turnstile の iframe が生成されることを確認する。
- **理由**: これは「品質が低い」ではなく「**機能が存在しない**」。テストの緑・型検査の緑・
  ビルドの成功のいずれもクライアントの結線を見ていなかったという、本プロジェクトが
  P2 / P2.5 / P3-a で繰り返してきた失敗の 4 度目である。

---

### [RV-P3B-002] `/apply?fs=1` が共有・ブックマーク・リロード可能な URL として残るため、Cookie 期限切れ後に**発行が二度と行われない**

- **種別**: Bug（可用性 / UX）
- **重要度**: **Must Fix**
- **場所**: `app/(public)/apply/page.tsx:58-65`、`app/api/form-session/route.ts:69`
- **現状**: 発行後のリダイレクト先が `/apply?fs=1` であり、**利用者のアドレスバーにその URL が残る**。
  ページ側のループ回避は `?fs=1` の有無だけを見る:

```ts
if (!hasSession && first(params[FORM_SESSION_ISSUED_PARAM]) !== '1') {
  redirect(`/api/form-session…`)
}
```

Cookie の `Max-Age` は 1,800 秒（30 分）である。したがって次が起きる:

| 時刻 | 操作 | 結果 |
|------|------|------|
| 10:00 | `/apply` を開く | 307 → 303 → `/apply?fs=1`（Cookie 発行）。**URL バーは `?fs=1`** |
| 10:45 | そのタブでリロード（または前日のブックマークを開く） | Cookie は期限切れ。`?fs=1` があるので**再発行しない** |
| 10:50 | 全ステップを入力して送信 | `verifyFormSession` が false → **403 Tier B**。回復手段なし |

**Cookie をブロックしている利用者（I-2）を救うために入れた分岐が、Cookie を受け入れる
普通の利用者にまで当たっている。** しかも到達経路がリロード・ブックマーク・URL 共有という
きわめて日常的な操作であり、被害は「フォームを全部入力した後に送信できない」という最悪の位置で出る。

- **改善案**: 2 段構えで塞ぐ。どちらか一方では不十分。
  1. **URL からマーカーを消す**（主対策）。`ApplicationForm` のマウント時に:

```ts
useEffect(() => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has('fs')) return
  url.searchParams.delete('fs')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}, [])
```

  これでリロード・ブックマーク・共有のいずれも `?fs=1` を持たない URL になり、
  Cookie が切れていれば**必ず再発行へ回る**。
  2. **サーバー側のループ回避を「発行を試みた事実」に寄せる**（残余対策）。
     `/api/form-session` が `__Host-fs` と同時に短命（60 秒程度）の
     `__Host-fsa`（attempted）を発行し、`/apply` は**そちらを**ループ回避の根拠にする。
     Cookie をブロックしている環境では `__Host-fsa` も付かないため `?fs=1` の判定を残す必要はあるが、
     Cookie を受け入れる環境では 60 秒を超えた再訪が必ず再発行されるようになる。
     （実装コストを避けるなら 1. だけでも実害はほぼ消えるので、1. を必須・2. を任意とする。）
- **理由**: `form-submission.md` §3.5 の縮退経路は「Cookie をブロックしている利用者」を
  対象にしたものであり、**Cookie を受け入れている利用者がその経路に落ちるのは仕様外**である。

---

### [RV-P3B-003] P3b-2（KV store 注入）を固定するテストが 1 本も無い — テスト設計 §7 が明示的に禁じた承認になる

- **種別**: Design（完了条件の未達）
- **重要度**: **Must Fix**
- **場所**: `tests/` 全体（該当ファイルが存在しない）/ 対象は `lib/runtime-stores.ts`・`auth.ts`・
  `app/api/applications/route.ts`・`app/api/form-session/route.ts`
- **現状**: 実装側は正しい。`auth.ts:73-84` は 4 つの limiter すべてに `sharedRateLimitStore()` を、
  公開 2 ルートも `sharedRateLimitStore()` / `sharedSemaphoreStore()` を注入している。
  **しかしそれを固定するテストが存在しない**:

```
$ grep -rln "runtime-stores\|sharedRateLimitStore\|sharedSemaphoreStore" tests/
（0 件）
```

`docs/review-p3b-tests-2026-07-29.md` §7 は本件について
**「これは P3-b の完了条件なので、Senior / Security は『テストが無いこと』を承認しないこと」**
と名指しで書いている。Impl は §8 で「P3b-2 は『注入した』までしか報告できない」と述べているが、
**「注入した」ことすら退行検知の手段が無い**——次に limiter を 1 本足す人が `store:` を
書き忘れても、型検査も lint も全テストも緑のままである（`createRateLimiter` の `store` は optional）。
これは SEC-044 が指摘した状況そのものの再生産である。

- **改善案**: `tests/unit/runtime-stores-wiring.test.ts` を新設し、以下 3 点を固定する。
  1. **ソース走査**: `auth.ts` / `app/api/applications/route.ts` / `app/api/form-session/route.ts` の
     各ファイルで、`createRateLimiter(` の出現回数と `store:` の出現回数が一致すること、
     および `createSemaphore(` に `store:` が渡っていること。
     （`api-route-guard-coverage-p3b.test.ts` の走査ヘルパを流用できる。）
  2. **`isKvConfigured()` の契約**: `https://` 以外（`memory://` / `http://` / 空）は false、
     `https://` + token のときだけ true。
  3. **`sharedRateLimitStore()` が同一インスタンスを返す**（接続の共有 / `sharedKvClient` の
     メモ化が壊れていないこと）。
- **理由**: 完了条件の充足を実装記録の記述だけで承認すると、次単位でこの条件は無かったことになる。

---

### [RV-P3B-004] AC-RL-13(c) の**配線**を検証するテストが無い（テスト設計 §7 が Impl に明示的に課した宿題）

- **種別**: Design（完了条件の未達）
- **重要度**: **Must Fix**
- **場所**: `app/api/form-session/route.ts`（対応するテストが存在しない）
- **現状**: `docs/review-p3b-tests-2026-07-29.md` §7 は
  **「Impl は配線後に『`/apply` を 31 回開くと 429』を E2E か結合で 1 本足すこと」**
  と書いている。走査結果:

```
$ grep -rn "form-session/route\|FORM_SESSION_ISSUED_PARAM" tests/
（0 件。ヒットするのは lib/form-session-issue.ts の純関数テストのみ）
```

`form-session-issue.test.ts` が担保しているのは**判定ロジック**であって、
Route Handler がそれを呼んでいること・`issueLimiter` が正しい limit/window で構成されていること・
429 応答が `Retry-After` を持つこと・`/apply` からのリダイレクト連鎖が成立することは
**どれも固定されていない**。`scripts/verify-p3b.ts` の V-4 / V-4b は貴重な実測だが、
**CI で回らないので退行検知にならない**。

- **改善案**: 結合テストで `GET /api/form-session` の `GET` を直接 31 回呼び、
  (a) 30 回目まで `303` + `set-cookie` に `__Host-fs`、(b) 31 回目が `429` + `retry-after`、
  (c) 縮退構成（`trusted=false`）では 40 回目も発行が続くこと、を固定する。
  併せて `/apply` の**リダイレクト連鎖**（Cookie 無し → 307、`?fs=1` 付き → 200）も
  1 本置くこと（RV-P3B-002 の修正後の振る舞いを固定する意味でも必要）。
- **理由**: AC-RL-13(c) は「Cookie 軸をタダで無限に増やせない」という**Tier D 設計全体の前提**である。
  ここが黙って無効化されると、縮退構成で残る唯一の enforce 軸（Cookie 軸）が意味を失う。

---

### [RV-P3B-005] P3b-5 が未達 — 実ブラウザの CSP 違反検証は依然 `/` のみを対象にしている

- **種別**: Design（完了条件の未達）
- **重要度**: **Must Fix**（作業量は小さい）
- **場所**: `tests/e2e/playwright/csp.spec.ts:26`（`const TARGET_PATH = '/'`）/
  `tests/e2e/playwright/apply-form.spec.ts:44-70`
- **現状**: `security-audit.md:2131` の P3b-5 は
  **「`/apply` を実ブラウザで開いて**違反 0**と**ページが白紙でないこと**の両方を見る」**
  と書いている。実装されたのは:
  - `apply-form.spec.ts` の CSP テストは `request.get(APPLY_PATH)` による**ヘッダ検査のみ**
    （ブラウザを開いていないので違反は観測できない）。
  - ブラウザで違反 0 を見るテスト（`csp.spec.ts:114-142`）は **`TARGET_PATH = '/'` のまま**。

  **`/apply` はサイト内で唯一サードパーティスクリプト（Turnstile）を読み込むページ**であり、
  すなわち**CSP 違反が起こりうる唯一のページ**である。そこを実ブラウザで見ていないため、
  P3b-5 が防ごうとした事故（`/schools` の静的化を `csp.spec.ts` が捕まえられなかった件と同型）が
  そのまま残っている。実際、RV-P3B-001 の Turnstile 結線の欠落も、
  確認画面まで進めてウィジェットの生成を見る E2E があれば検出できた可能性が高い。

- **改善案**: `apply-form.spec.ts` に chromium 単一のテストを 1 本足す。
  **確認画面（`review` ステップ）まで到達させること**——Turnstile スクリプトは
  `step === 'review'` でしか読み込まれない（`ApplicationForm.tsx:398`）ので、
  入口だけ開いても検証にならない。

```ts
test('/apply を確認画面まで開いて CSP 違反が 0 件（P3b-5）', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CSP 違反のコンソール出力は chromium で検証する')
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(m.text())) {
      violations.push(m.text())
    }
  })
  await page.goto('/apply')
  await chooseType(page, 'inquiry')
  // …必須項目を埋めて review まで進める…
  await expect(page.getByTestId('apply-step-confirm')).toBeVisible()  // 「白紙でない」
  await page.waitForTimeout(1_000)
  expect(violations, violations.join('\n')).toEqual([])
})
```

- **理由**: P3b-5 は「`csp.spec.ts` だけを根拠にしない」という条件だった。
  現状は逆に「`csp.spec.ts` が `/` を見ているだけ」であり、条件の文言も意図も満たしていない。

---

## Should Fix

### [RV-P3B-006] `enforceBodyBytes` がボディを**全量バッファしてから**上限判定するため、P3b-8 が掲げた性質（メモリを使わせない）を実現していない

- **種別**: Performance / Security（DoS 耐性）
- **重要度**: Should Fix
- **場所**: `lib/public-guard.ts:429-440`
- **現状**:

```ts
const buffer = await request.arrayBuffer()   // ← ここで全部読み切る
if (buffer.byteLength > maxBodyBytes) return null
```

`arrayBuffer()` はストリームを最後まで消費する。したがって `Transfer-Encoding: chunked` で
100MB を送りつけられた場合、**100MB をメモリに載せてから 413 を返す**。
`lib/public-guard.ts:20` / `:360-364` のコメントは
「レート制限済みの相手にメモリを使わせない」「実測が要る理由はヘッダだけの検査が迂回できるから」
と書いているが、**実装は迂回を検出できるだけで、メモリ消費は防いでいない**。

実害は限定的である（過大評価しない）:
- Vercel のプラットフォーム側にリクエストボディ 4.5MB の上限があること、
- 評価順序上 **Tier D の後**にあるため、上限到達済みの発信元は 429 で先に落ちること、

この 2 点により、実運用の露出は「発信元あたり 10 分に 5 回 × 4.5MB」程度に抑えられている。
それでも **P3b-8 が要求した性質そのものは満たしていない**ので、記録して塞ぐべきである。

- **改善案**: リーダで逐次読み、上限を超えた時点で打ち切る。

```ts
async function enforceBodyBytes(request: Request, maxBodyBytes: number): Promise<Request | null> {
  if (request.body === null) return request
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBodyBytes) {
      await reader.cancel()          // 残りを読まずに打ち切る
      return null
    }
    chunks.push(value)
  }
  const body = Buffer.concat(chunks)
  return new Request(request.url, { method: request.method, headers: request.headers, body })
}
```

  既存の振る舞いテスト（413 / バイト境界 / chunked）はそのまま通る。
- **理由**: 「検出できる」と「消費させない」は別の性質であり、コメントは後者を約束している。
  実装とコメントが食い違ったまま残ると、次に読む人が防御済みと誤認する。

---

### [RV-P3B-007] `GET /api/form-session` が**サブリソース経由でも発行枠を消費する**ため、第三者ページ／共有 NAT が利用者の `/apply` 閲覧を止められる

- **種別**: Security（可用性）/ Design
- **重要度**: Should Fix
- **場所**: `app/api/form-session/route.ts:61-91`、`app/(public)/apply/page.tsx:58-65`
- **現状**: 本ルートは Origin 検証もナビゲーション判定も持たない状態変更 GET である。
  攻撃者のページが `<img src="https://…/api/form-session">` を 31 個並べるだけで、
  **被害者の IP に紐づく発行枠（30 回 / 10 分）を使い切れる**。以後 10 分間、
  被害者が `/apply` を開くと `/api/form-session` へリダイレクトされ、
  **フォームの代わりに生の JSON `{"retryAfterMs":…}`（429）が表示される**。

  攻撃者がいなくても同じことが起きる。本番（Vercel / `trusted=true`）では発行枠は実 IP 単位なので、
  **企業 NAT・学校・携帯キャリアの CGNAT 配下**では正規利用者だけで 30 回 / 10 分に届く。
  対象が教習所（若年層・モバイル比率が高い）であることを踏まえると、無視できる想定ではない。

  問題の本質は**失敗の見え方**にある。§4.11 のどの Tier も「ページが見られない」を含んでいない。
  送信の Tier D（429）は「待てば送れる」だが、**発行の Tier D は「フォームに到達できない」**に化けている。

- **改善案**: 2 点。
  1. **ナビゲーション以外では枠を消費しない。** `Sec-Fetch-Dest: document` でない、
     あるいは `Sec-Fetch-Site` が `cross-site` のリクエストは、計数せずに `/apply?fs=1` へ
     303 するだけにする（Cookie も発行しない）。これで `<img>` / `fetch` 経由の枠消費が消える。
  2. **429 でもフォームを見せる。** 上限到達時は JSON 429 ではなく `/apply?fs=1` へ 303 し、
     `/apply` 側は Cookie 無しの縮退表示（＝ Tier B 経路 + 電話・LINE の代替導線）を出す。
     「送信はできないかもしれないが、ページと連絡先は必ず見える」という状態にする。
     AC-RL-13(c) の目的は「Cookie 軸をタダで増やせないこと」なので、**発行を止めれば足り、
     ページを止める必要はない**。
- **理由**: 発行制限は防御であって、正規利用者からページを奪う手段ではない。
  `lib/form-session-issue.ts` の冒頭コメントが「第三者が 30 回開くだけで全利用者が `/apply` を
  開けなくなる」ことを縮退時の懸念として正しく認識しているにもかかわらず、
  **`trusted=true` の本番ではその状態が実際に成立してしまう**。

---

### [RV-P3B-008] Tier C / D の自動再送が無いまま、UI が「お待ちいただくと自動的に送信されます」と表示している（I-11）

- **種別**: Bug（UI と実装の不一致）
- **重要度**: Should Fix
- **場所**: `components/apply/ApplicationForm.tsx:948-955`
- **現状**:

```tsx
{submission.kind === 'queued'
  ? '順番にお送りしています。このままお待ちください。'
  : 'ただいま大変混み合っています。お待ちいただくと自動的に送信されます。'}
```

`form-submission.md` §4.4 の「`Retry-After` 経過で自動再送（最大 3 回）」は未実装であり、
待っても何も起きない。**文面が事実と異なる**ため、利用者は待ち続けて離脱する。
自動再送の実装を P3-c 以降へ送ること自体は受容できる（機能追加）が、
**嘘の文面を出したまま公開することは受容できない**（コスト 1 行）。

- **改善案**: どちらかを本単位で行う。
  - (推奨) `retryAfterMs` 経過後に `submit()` を最大 3 回呼ぶ `useEffect` を足す
    （`idempotencyKey` は不変なので二重登録は起きない。冪等経路が既に成立している）。
  - (最低限) 文面を「しばらく時間をおいて、もう一度送信ボタンを押してください。」へ変更し、
    再送ボタンを出す。
- **理由**: I-11 で Impl 自身が「F-010 の UX 契約としては未達」と書いている。未達を隠す表示は
  未達そのものより悪い。

---

### [RV-P3B-009] Tier B の案内が「Cookie が無い」利用者にとって行動不能である（I-2 の実害部分）

- **種別**: Design（UX）
- **重要度**: Should Fix
- **場所**: `components/apply/ApplicationForm.tsx:942-946`
- **現状**: Tier B の表示は「確認のため、チェックにご協力ください。」の 1 文だけである。
  ハニーポット・送信間隔・CAPTCHA 失敗であれば正しい案内だが、
  **Cookie をブロックしている利用者（I-2）にとっては操作対象が存在しない**。
  チェックを何度解いても 403 のままで、離脱以外の行き先が無い。

  「降格理由を利用者に区別させない」（契約ルール3）は**サーバー応答**の要件であって、
  **クライアントが自分の状態から推測して案内を足すことを禁じていない**。
  クライアントは「自分が Cookie を受け取れたか」を推測する材料を持てる。

- **改善案**: Tier B を **2 回連続で受けたら**代替導線を出す。
  サーバーの応答は一切変えないので契約ルール3 に抵触しない。

```tsx
{challengeCount >= 2 && (
  <p>
    お使いのブラウザの設定により、送信が完了できない場合があります。
    お手数ですが、お電話（岩滝校 0120-46-4163 / 網野校 0120-07-2633）でも承ります。
  </p>
)}
```

- **理由**: 「仕様どおりの縮退」と「利用者が詰む」は両立してしまう。詰ませない出口が要る。

---

### [RV-P3B-010] セマフォのパーミットを Turnstile 検証（最大 3 秒）と自動返信送信（最大 5 秒）の間も保持している

- **種別**: Performance
- **重要度**: Should Fix
- **場所**: `app/api/applications/route.ts:283-289`（Turnstile）/ `:318-327`（自動返信）、
  `lib/public-guard.ts:401-405`（`finally` で release）
- **現状**: ハンドラ本体が終わるまでパーミットは解放されない。本体には
  外部 API 呼び出しが 2 つ含まれる（Turnstile 3 秒 / Resend 5 秒）。
  最悪ケースで **1 リクエストが約 8 秒パーミットを占有**する（`maxDuration` は 10 秒）。
  セマフォは `perShardLimit = 8` なので、外部 API が遅い局面では
  **DB がまったく逼迫していないのに Tier C（202）が多発する**。
  セマフォの目的（`AC-RL-1` / DB 同時実行の保護）と占有理由がずれている。
- **改善案**: 影響の大きい順に 2 つ。
  1. **自動返信をパーミットの外へ出す。** AC-010-9 が「メール送信の失敗は受付を壊さない」と
     定めている以上、201 の返却をメール送信に待たせる理由が無い。
     Vercel なら `waitUntil()`、無ければ `void sendAutoReply(...).catch(() => {})` とし、
     `application.created` のログは `autoReplySent` を別イベントへ分離する。
  2. **Turnstile 検証をラッパの Tier B 段（＝セマフォ取得前）へ移す**ことも検討に値するが、
     現在の「ハンドラが業務上の Tier B を持つ」という責務分担を崩すため、本単位では見送ってよい。
- **理由**: Tier C は「共有軸の逼迫」を表すべきで、外部 API のレイテンシを表すべきではない。

---

### [RV-P3B-011] 自動返信のスロットルが `peek` → 送信 → `consume` の非原子操作であり、AC-RL-14 の上限を並行送信で超えられる

- **種別**: Bug（軽微）
- **重要度**: Should Fix
- **場所**: `lib/mail/auto-reply.ts:156-172`
- **現状**: `peek` と `consume` の間に送信（外部 API 呼び出し）が挟まる。
  同一宛先への並行 N リクエストは全て `peek` を通過し、**N 通送られうる**。
  AC-RL-14 の「1 時間 3 通」は逐次実行でしか保証されない。
  T-Q4（失敗が枠を食わない）を優先した設計判断そのものは正しい。
- **改善案**: 先に `consume` して枠を確保し、送信失敗時に `reset` ではなく
  「失敗を記録して次回の判定で 1 枠戻す」形にするのは複雑すぎる。
  現実的には**先に `consume` し、失敗時のみ枠を返す**（`RateLimiter` に `refund` が無ければ
  本単位では受容し、`docs/` に残す）で十分である。**受容する場合は、
  この非原子性を `application-auto-reply.test.ts` のコメントとして明記すること**
  （「逐次でのみ 3 通」であることが読んで分かるように）。
- **理由**: 守っている資産（送信ドメインの評判）に対して被害は小さいが、
  「上限 3」と書いてある挙動が条件付きであることは記録に残す必要がある。

---

### [RV-P3B-012] `components/apply/` が設計書 §6.4 の分解と異なる（I-9）— 本単位は受容、**P3-c 着手前に分解すること**

- **種別**: Maintainability
- **重要度**: Should Fix（P3-c のブロッカーとして扱う）
- **場所**: `components/apply/ApplicationForm.tsx`（**1,146 行**）/ `FormStepper.tsx`
- **現状**: `ui-design/application-form.md` §6.4 は `steps/` 配下 6 ファイル +
  `RadioCardGroup` / `ImportantNoticeBlock` / `FormField` を求めているが、実装は 2 ファイル。
  **振る舞い（AC-008-2/3/5/6/7）は満たしている**ことをコードで確認した。
- **判定**: **本単位は受容する。** 理由は 2 つ。(a) 受け入れ条件は振る舞いで書かれており、
  ファイル分割は手段である。(b) 分解を今やらせると RV-P3B-001 / 002 の修正と衝突する。

  ただし **P3-c（F-009 写真）の着手前には分解を必須とする。** 写真ステップは
  ファイル選択・プレビュー・アップロード進捗・失敗再試行・`objectKey` 管理を持ち込み、
  1,146 行のファイルに載せると確実に破綻する。加えて `toDraftSnapshot` の (e) が
  守ろうとしている「写真関連値を保存しない」は、状態がこのファイルに集中しているほど
  破りやすくなる（`lib/apply-draft.ts` の冒頭コメントが警戒しているのはまさにこの事故である）。
- **理由**: 分解は「今やる価値」より「P3-c でやらないと壊れる」の側にある。

---

### [RV-P3B-013] 確認画面からの「修正」リンク / `returnToReview` 未実装（I-10）

- **種別**: Design（UX）
- **重要度**: Should Fix（P3-b では受容）
- **場所**: `components/apply/ApplicationForm.tsx`（該当機能なし）
- **現状**: `application-form.md` §2.7 の「ステップ単位の修正リンクで戻り、次へで確認画面へ直帰」が無く、
  戻るボタンで 1 ステップずつ戻る。APPLICATION は 5 ステップあるため、
  確認画面でコース選択の誤りに気付いた利用者は **4 回「戻る」を押す**ことになる。
  E2E の要求範囲外であり、離脱には効くが機能は成立している。
- **改善案**: `currentSummary` の各行に「修正」リンクを置き、
  `setStep(targetStep)` + `returnToReview = true` を持たせ、`goNext` が
  `returnToReview` のときは `review` へ直帰する。差分は 20 行程度。
- **理由**: 受容可能だが、実装コストが小さく効果が明確なので P3-c と同時に入れること。

---

### [RV-P3B-014] テスト設計文書 §5.3 の評価順序を実装に合わせて更新すること（Impl の申し送りへの回答）

- **種別**: Style（文書整合）
- **重要度**: Should Fix
- **場所**: `docs/review-p3b-tests-2026-07-29.md` §5.3
- **現状**: 契約文書は実バイト数の強制を「7（Tier C の後）」と書いているが、実装は「5（Tier D の直後）」。
  §D で述べるとおり**実装側を正とする**判定なので、文書を更新する。
- **改善案**: §5.3 の順序表を実装順（`lib/public-guard.ts:14-30` のコメントと同一）へ書き換え、
  「本順序は `public-guard-p3b-wiring.test.ts` の評価順序 2 本が固定する」と注記する。

---

## Nice to Have

### [RV-P3B-015] `lib/mail.ts` と `lib/mail/` の共存（I-12）
`@/lib/mail` がファイルへ解決されることは型検査・ビルドで確認済みだが、
`lib/mail/auto-reply.ts` の隣に `lib/mail.ts` がある構成は読み手を必ず一度止める。
`lib/mail/send.ts` へ改名し `@/lib/mail/send` を import する形にすること（機械的変更）。

### [RV-P3B-016] `phone` の空文字が `REQUIRED` ではなく `INVALID_FORMAT` になる
`lib/validators/application.ts:289-296` だけ `isProvided` ではなく
`body.phone === undefined || body.phone === null` で必須判定している。
`phone: ''` は他フィールドの流儀なら `REQUIRED` だが `INVALID_FORMAT` になる。
利用者に出る文言が「必須項目です」ではなく「入力の形式をご確認ください」になるだけで
実害は小さいが、他フィールドと揃えること。

### [RV-P3B-017] KV の抜け道判定が `VERCEL === '1'` に依存している
`lib/env.ts:179` は Vercel 上でのみ `https://` を強制する。
本デモは Vercel 前提なので現状は正しいが、**Vercel 以外の本番（自前 Node / コンテナ）へ
移した瞬間に `memory://` のまま起動できる**。`lib/runtime-stores.ts` の冒頭コメントが
「本番でこのフォールバックが効くことはない」と断言しているので、
その断言が Vercel 限定であることを 1 行足しておくこと。

---

# A. P3b-1〜11 の充足判定

| # | 要件 | 判定 | 根拠 / 残件 |
|---|------|------|------------|
| **P3b-1** | `limiters.formSession` + `formSessionKey` の配線 | ✅ **充足** | `app/api/applications/route.ts:341-347` が両方を渡す。**IP 軸だけで Tier D を構成していない**。加えて `lib/public-guard.ts:263-276` の**構築時 throw** により、`limiters.source` だけの構成は**モジュール評価時に例外**となり起動できない。検査の限定（`limiters.source` がある場合のみ）も適切 |
| **P3b-1b** | `formSessionKey` の一意性を型／構築時検査で強制 | ✅ **充足** | `PerRequesterKey`（`lib/form-session.ts:31-51`）は `unique symbol` ブランドで、`'anonymous'` 等のリテラルは代入不能。`formSessionAxisKeyFromValue` は SHA-256 hex を返す唯一の生成元。**ルートは正典関数をそのまま渡しており `as` キャストが無い**（`applications-route-contract.test.ts` がソースで固定）。`enforce: true` は `lib/public-guard.ts:336` にリテラルで書かれているが、これは **Cookie 軸の内部**であり「攻撃者自身に閉じた軸」であることが型（`PerRequesterKey`）で保証された後の記述なので、SEC-052 が禁じた形ではない。**発信元軸側は `sourceAxisFor` 経由でしか `enforce` を得られない**ままである（退行なし） |
| **P3b-2** | limiter への KV store 注入 + 文言と実態の一致 | ⚠️ **実装は充足 / テストが無い（Must Fix）** | `auth.ts:73-84` の 4 limiter、公開 2 ルート、セマフォすべてに注入済み。`.env.example` / `lib/env.ts` の文言も一致（`VERCEL === '1'` で `https://` 強制）。**`lib/runtime-stores.ts` へ集約した設計は是（下記 A-2）。** ただし固定するテストが 0 本 → **RV-P3B-003**。実 KV 未実測は I-5 として受容し Security へ引き継ぐ |
| **P3b-3** | 本番の共有秘密 32 文字下限 | ✅ **充足** | `lib/env.ts:138-147`。`FORM_SESSION_SECRET` / `CRON_SECRET` の両方 + 相互の同一値禁止 + `AUTH_SECRET` との同一値禁止。`env-p3b-fail-fast.test.ts` が 31/32 の境界を固定 |
| **P3b-4** | `now` / `newPermitId` にリクエスト由来の値を渡さない | ✅ **充足** | ルートは `now` / `random` / `newPermitId` を一切渡していない（既定の `Date.now` / `Math.random`）。`newFormSessionPayload` が Request を受け取らない設計（`lib/form-session.ts:198`）も型の継ぎ目として有効。`public-guard-p3b-wiring.test.ts:456-483` が偽装ヘッダで振る舞いが変わらないことを固定 |
| **P3b-5** | CSP の検証対象を `/apply` へ（`csp.spec.ts` だけを根拠にしない） | ❌ **未充足（Must Fix）** | ヘッダ検査は `/apply` へ移ったが、**実ブラウザでの違反 0 検証は `/` のまま**（`csp.spec.ts:26`）。→ **RV-P3B-005** |
| **P3b-6** | `force-dynamic` の構造的な歯止め | ✅ **充足** | `apply-page-contract.test.ts:106-140` がルートレイアウトの export と `app/` 配下に `force-static` が無いことを固定。ビルド出力も全 21 ルート `ƒ`（オーケストレーター実測） |
| **P3b-7** | ルート列挙テストの強化（再 export / `route.js` / エイリアス） | ✅ **充足** | `helpers/route-guard-scan.ts` + `api-route-guard-coverage-p3b.test.ts`。**合成ソースによる自己検証 13 本が green**＝網そのものが機能することが証明されている。実ルート（`app/api/applications/route.ts`）が対象に入ることも `:164-170` が固定 |
| **P3b-8** | 公開エンドポイントのボディサイズ上限 | ⚠️ **条件付き充足（Should Fix）** | 413 は正しく返る（宣言値・実測・chunked・境界・`challenge` 非包含のすべてを固定）。**ただし実装は全量バッファしてから判定するため「メモリを使わせない」性質は未達** → **RV-P3B-006** |
| **P3b-9** | `SEMAPHORE_ACQUIRE_LUA` 変更時の実 Redis 再実測 | ✅ **対象外（正しく対象外）** | Lua は未変更。`createMemorySemaphoreStore` の新設は非本番専用であり Lua とは別実装。ただし I-6 のとおり**メモリ版に契約テストが無い** → Should Fix として `semaphore-contract.ts` へ載せること |
| **P3b-10** | `withCronAuth` の試行回数制限 | ✅ **対象外（期限は P3-c）** | 未実装。`cron-auth.test.ts` は退行していない。**P3-c の完了条件として明示的に引き継ぐ** |
| **P3b-11** | `formSessionKey` 段階での Cookie 形式検証 | ✅ **充足（残余は正しく申告されている）** | `formSessionAxisKeyFromValue`（`lib/form-session.ts:262-280`）が長さ上限 512 / 2 セグメント / 署名部 43 文字 / base64url 全域一致を検査し、不正は `null`。例外を投げない。`verify-p3b.ts` V-2 が形式不正 2,000 種で軸バケット増分 0 を実測。**「形式を満たす値からは軸キーが作れる」残余を `[INFO]` で定量化して過大報告を避けている点を評価する** |

### A-2. `lib/runtime-stores.ts` に集約した設計の是非 — **是**

SEC-044 が指摘したのは「実装はあるが注入されていない」という状態だった。
各所で `createUpstashKvClient()` を呼ぶ形にすると、**注入し忘れた limiter だけが黙って
インメモリのまま**になり、その 1 箇所を発見する手段が無い。**注入経路を 1 つにして
呼び出し側から選択肢を無くす**という判断は、SEC-021 → SEC-043 で 4 度失敗した
「呼び出し側の規律に頼る」形からの正しい離脱である。

副次的な良さ:
- `sharedKvClient()` が**接続だけ**を共有し判定ロジックを共有しない（AC-RL-8 を壊していない）。
- `isKvConfigured()` が `https://` のみを設定済みと見なすことで、
  ローカルの `memory://` が「明示的な宣言」になっている（黙って縮退しない）。

**ただし、この設計の価値は「1 箇所を通ること」に依存しており、それを固定するテストが無い**
（RV-P3B-003）。設計は承認、テストの不在は差し戻し、という判定である。

---

# B. 仕様との差分（Impl が判断を仰いだ 4 件）の判定

| ID | 内容 | **判定** | 理由 |
|----|------|---------|------|
| **I-9** | `components/apply/` の分解が §6.4 と異なる（2 ファイル / 1,146 行） | **本単位は受容。P3-c 着手前の分解を必須条件とする** | 受け入れ条件は振る舞いで書かれており充足済み。ただし写真ステップを 1,146 行へ載せると `toDraftSnapshot` の (e) が守る境界ごと壊れる。→ RV-P3B-012 |
| **I-10** | 確認画面の「修正」リンク / `returnToReview` 未実装 | **受容（Should Fix / P3-c と同時に実装）** | 機能は成立し E2E も要求外。APPLICATION 5 ステップで「戻る」4 回は離脱要因だが、公開を止める性質ではない。→ RV-P3B-013 |
| **I-11** | Tier C / D の自動再試行が未実装 | **部分的に却下。** 自動再送の先送りは受容するが、**「自動的に送信されます」という UI 文面をそのまま公開することは受容しない** | 未達を隠す表示は未達より悪い。1 行の文面修正か 20 行の自動再送か、いずれかを本単位で行うこと。→ RV-P3B-008 |
| **I-2** | Cookie ブロック利用者が Tier B から回復できない | **サーバー側の挙動は受容（仕様どおり）。ただしクライアント側に出口を足すこと** | 契約ルール3 は**サーバー応答**の要件であり、クライアントが自状態から代替導線を出すことは禁じていない。→ RV-P3B-009。**なお I-2 の実害の大部分は RV-P3B-002（Cookie を受け入れる利用者まで同じ経路に落ちる）であり、そちらが本体である** |

---

# C. テストに加えた修正 3 件（Impl 記録 §2）の妥当性判定

**結論: 3 件とも妥当。いずれも「アサーションを実装に合わせて緩めた」ものではない。**
Impl の主張（「その入力・期待値のままではいかなる実装でも満たせない」）を個別に検証した。

### (a) `public-guard-p3b-wiring.test.ts` の評価順序テストの**入力** — **妥当**

- **主張の検証**: WHATWG Fetch 仕様の Request 構築手順は、body から抽出するのが
  `Content-Type` のみであり、`Content-Length` は HTTP 送信段階で付与される。
  したがって `new Request(url, { body: 'x'.repeat(2000) })` に `content-length` は無い。
  **主張は正しい。**
- **修正後もテストが判別力を失っていないか**（ここが最重要）:
  `productionWiring()` は `source: createRateLimiter({ limit: 5 })` を `trusted: true` で構成する
  （`tests/unit/public-guard-p3b-wiring.test.ts:91-109`）。両テストとも**事前に 5 回**リクエストを
  流して**発信元軸を使い切っている**。したがって:
  - 413 テスト: 6 回目が `content-length: 2000` を持つ → **もし宣言値判定がレート制限より後なら 429 になる**。
    413 が返ることが順序を証明する。**判別力は保たれている。**
  - 429 テスト: 6 回目が `content-length` 無し → **もし実測がレート制限より前なら 413 になる**。
    429 が返ることが順序を証明する。**判別力は保たれている。**
- **アサーション**: `toBe(413)` / `toBe(429)` とも未変更。
- **判定**: **妥当。** 修正はテストの意図（テスト名「ヘッダだけで判る超過」）に忠実であり、
  むしろ元の入力より意図に合っている。修正理由がテスト本文のコメントに実測付きで
  残されている点も、後続レビュワーの再検証を可能にしていて良い。

### (b) `applications-route-contract.test.ts` の `maxDuration` の実現方法 — **妥当**

- **主張の検証**: Next.js のセグメント設定は静的解析されるため識別子を書けない。
  実測ログ（`Unknown identifier "PUBLIC_HANDLER_MAX_DURATION_SEC" at "maxDuration"` → build 失敗）が
  記録されており、これは Next.js の既知の制約と一致する。**主張は正しい。**
- **代替手段が AC-RL-15(a) の性質を保っているか**:

```ts
export const maxDuration = 10
const assertMaxDurationMatchesSemaphore: typeof maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC
```

  `export const maxDuration = 10` の型は**リテラル型 `10`**、
  `lib/semaphore.ts:44` の `export const PUBLIC_HANDLER_MAX_DURATION_SEC = 10` も**リテラル型 `10`**
  （`: number` 注釈が無いことを確認済み）。したがって:
  - セマフォ側を 15 にすると `15` を `10` へ代入 → **型エラー**
  - ルート側を 15 にすると `10` を `15` へ代入 → **型エラー**

  **双方向で `pnpm type-check` が落ちる**ため、AC-RL-15(a) の「片方だけ変えたら落ちる」性質は
  完全に保たれている。
- **判定**: **妥当。** 期待値の書き方を変えただけで、担保している性質は同一。
  むしろ「型で結ぶ」形は元案より強い（テストを消しても型検査で落ちる）。
  なお `PUBLIC_HANDLER_MAX_DURATION_SEC` に将来 `: number` 注釈が付くとこの結線は無力化するので、
  `lib/semaphore.ts:44` にその旨の 1 行コメントを足しておくとなお良い（Nice to Have）。

### (c) `applications.int.ts` の診断メッセージがボディを消費していた — **妥当**

- **主張の検証**: `expect(actual, message)` の第 2 引数は**呼び出し前に評価される**（JS の評価順序）。
  したがって `expect(res.status, await res.text())` は必ず本文を読み切り、
  直後の `res.json()` が `Body is unusable` で失敗する。**実装に依らず常に失敗する。**
  `res.clone().text()` への変更は正しい修正である。
- **判定**: **妥当。** 純粋なテストのバグ修正であり、契約には一切触れていない。

### 既存テストへの追随 2 件 — **妥当**

- `public-guard.test.ts` / `public-guard-degraded-source.test.ts` への `formSession` 追加は、
  **P3b-1 の構築時 throw が `limiters.source` 単独構成を違法化したことの直接の帰結**である。
  各ファイルの `request()` は `__Host-fs` を送らないため `formSessionAxisKey` は常に `null` を返し、
  **発信元軸の振る舞いを検証している既存アサーションは 1 つも変わっていない**。妥当。
- `env-p3a-fail-fast.test.ts` / `env.test.ts` の土台への Turnstile 2 キー追加は、
  P3-b で本番必須へ昇格した以上必要な追随。「Turnstile / Blob は P3-a では必須にしない」という
  元のアサーションは **Blob について引き続き成立**しており、意味を失っていない。妥当。

---

# D. 評価順序の差分（Impl 記録 §3.3）— **安全側と判定する。実装を正とし、文書を更新すること**

## 差分

| 段 | 契約（テスト設計 §5.3） | 実装（`lib/public-guard.ts`） |
|----|----------------------|------------------------------|
| 5 | Tier B（`verifyFormSession`） | **実バイト数によるボディ上限（413）** |
| 6 | Tier C（セマフォ） | Tier B（`verifyFormSession`） |
| 7 | **実バイト数によるボディ上限（413）** | Tier C（セマフォ） |

## 判定: **安全側。実装を正とする。**

### 1. テスト側の要求として、実装順以外に選択肢が無い（Impl の説明は正しい）

`public-guard-p3b-wiring.test.ts:426-453` の 2 本は**どちらも Cookie を持たない
`streamingRequest`** を使う。実測強制を Tier B の後に置くと `verifyFormSession` が先に false を返し、
**413 ではなく 403** になる。テストを契約の正とする限り、実装順以外は成立しない。
「テストを契約の正とし、実装をそちらへ合わせた」という Impl の判断は正しい優先順位である。

### 2. 性質としても実装順のほうが良い（Impl の 2 つの理由を追認する）

- **(a) 413 が `challenge` に埋もれない。** 契約ルール7 は「Tier の判別はステータスと
  `challenge` の有無のみ」と定める。契約順だと、Cookie を持たない利用者が 64KB 超のボディを
  送ったとき **413 ではなく 403 `{challenge}`** が返る。クライアントは CAPTCHA を出し、
  解いて再送してもまた同じ 403 になる——`lib/public-guard.ts:194-199` が名指しで
  禁じている「**抜けられないループ**」そのものである。実装順はこれを構造的に防いでいる。
- **(b) 上限超過のボディがセマフォのパーミットを占有しない。** Tier C の前に落ちるので、
  巨大ボディが同時実行枠を食わない。これは AC-RL-1 の資産保護に直接効く。

### 3. 差分が「危険側」に振れる唯一の点と、その評価

実装順では、**Cookie を持たないリクエストのボディが Tier B より前に読まれる**。
契約順なら 403 を返して 1 バイトも読まずに済んだ。すなわち
「Cookie 無しの第三者にボディ読み取りを行わせる」経路が新設されている。

これを危険と見なさない理由:
- **Tier D（レート制限）は依然としてボディ読み取りより前にある**（実装 4 → 5）。
  つまり「レート制限済みの攻撃者にメモリを使わせない」という P3b-8 の核心的性質は保たれている。
  露出は発信元あたり窓内の上限回数（本番 5 回 / 10 分）に限定される。
- 読み取り量は `maxBodyBytes`（64KB）で頭打ちである。
- **ただし RV-P3B-006（全量バッファ）が未修正の間は、この「頭打ち」が成立しない。**
  したがって **D の受容は RV-P3B-006 の修正を前提とする。**
  2 つを合わせて初めて「安全側」と言える。

### 4. 要求事項

- `docs/review-p3b-tests-2026-07-29.md` §5.3 を実装順へ更新する（→ RV-P3B-014）。
- `lib/public-guard.ts:12-30` のコメントは既に実装順と一致しており、
  かつ**なぜその位置なのかの理由まで書かれている**。良い。そのまま維持すること。

---

# E. 退行チェック（P2 / P2.5 / P3-a で Approve した性質）

| 性質 | 判定 | 確認内容 |
|------|------|---------|
| `sourceAxisFor` による縮退判定の型強制（SEC-043） | ✅ 維持 | `lib/public-guard.ts:83-88` は不変。第 2 引数は `ClientIpResolution` のまま。`withPublicMutation` 内で `resolved.key` を単独で使う経路は無く、縮退判定の `if` は `sourceAxisFor` の中だけ（`:321`）。`axes` の要素型は `enforce` を**必須**にしたままで、新軸を足す人に判断を強制する形が保たれている |
| 変更系は必ずラッパ経由（AC-010-14 / SEC-054） | ✅ 維持・**強化** | `api-route-guard-coverage-p3b.test.ts` + `helpers/route-guard-scan.ts` が再 export / `route.js` / エイリアス import を検出。合成ソース 13 本の自己検証が green。新設の `POST /api/applications` が走査対象に入ることも固定済み。**`GET /api/form-session` は GET のみで変更系ではないため対象外で正しい** |
| CSP（SEC-002 / AC-008-1） | ⚠️ ポリシーは維持・**検証対象の移行が未完** | `lib/csp.ts` は P3-a から未変更。`script-src` に `'unsafe-inline'` / `'unsafe-eval'` 無し、Turnstile / Blob のオリジンは事前許可済み。**`script-src` にホスト源と nonce が併存する構成は CSP3 で「いずれかに一致すれば許可」なので、`createElement` による Turnstile スクリプト読込は正しく許可される**（`'strict-dynamic'` は無いのでホスト源は無効化されない）。ただし実ブラウザ検証の対象が `/` のまま → RV-P3B-005 |
| `force-dynamic`（P3b-6 / nonce 方式の前提） | ✅ 維持 | `apply-page-contract.test.ts` がソース側を固定。ビルド出力 21 ルート全て `ƒ` |
| `news-visibility` の述語単一化（P2.5） | ✅ 維持 | 本単位は `lib/queries.ts` の可視性述語に触れていない。`/apply` は `getLicenseCourses()` のみ使用 |
| PII をログに出さない（AC-PII-1） | ✅ 維持・**拡張** | `lib/pii-log.ts` を新設し、ルートの全ログ出力点がラッパ経由（`app/api/applications/route.ts:115`）。`public-guard` の `deny()` もキーの SHA-256 先頭 8 文字のみ（`lib/public-guard.ts:216-218`） |
| 鍵の用途分離（tech-stack §4.6） | ✅ 維持・**拡張** | Cookie 署名（`driving-school/form-session/v1`）と冪等ハッシュ（`driving-school/application-idempotency/v1`）で HKDF ラベルが分離済み。`lib/env.ts` が `FORM_SESSION_SECRET` ≠ `CRON_SECRET` ≠ `AUTH_SECRET` を起動時に強制 |
| `timingSafeEqual` の長さ事前チェック（SEC-042） | ✅ 維持・**新モジュールにも適用** | `lib/application-idempotency.ts:60-69` が `HASH_HEX_LENGTH` で先に弾いてから比較。`lib/form-session.ts:159-162` も同様。**SEC-042 と同型の 500 を新規モジュールで再生産していない** |
| 既存テストの退行 | ✅ 無し | 既存 359 unit / 28 integration が全て green のまま（オーケストレーター実測）。既存ファイルのアサーション変更は 0 件（§C で確認） |

**退行は検出されなかった。** P3-a で確立した型・構造による強制は、新規モジュールへ正しく伝播している。

---

# F. Impl 申し送り §8（12 件）への判定表

| # | 項目 | **判定** | 根拠 / 引き取り先 |
|---|------|---------|------------------|
| **I-1** | `__Host-` Cookie が WebKit（`http://localhost`）で受理されない | **受容（実装の欠陥ではない）。ただし対応方針は下記 §G のとおり (a) を採る** | サーバーの `Set-Cookie` は正しく、chromium / firefox は通過。ブラウザのポリシー制約。**ただし「本番では大丈夫」で終わらせず、初回 HTTPS デプロイ後の実機確認を P3-c の必須項目に格上げする**（対象利用者層の iOS Safari 比率を考えると、`__Host-` が実機で機能しない場合の影響は「全 iOS 利用者が申込不能」であり、未確認のまま公開できるリスクではない） |
| **I-2** | Cookie ブロック利用者が Tier B から回復できない | **条件付き受容** | サーバー挙動は仕様どおり。ただしクライアント側に代替導線を出すこと → RV-P3B-009。**実害の本体は I-2 ではなく RV-P3B-002 である** |
| **I-3** | Turnstile の実ウィジェット動作が未検証 | **却下。「未検証」ではなく「実装が存在しない」** | `onTurnstileToken` はリポジトリ全体で `data-callback` の属性値としてしか存在しない。トークンは常に空で、**本番では全送信が Tier B** → **RV-P3B-001（Must Fix 最優先）** |
| **I-4** | 自動返信メールの実送信が未検証 | **受容** | `RESEND_API_KEY` 未設定では送信せず戻る設計（`lib/mail.ts:53-54`）は正しい。差出人ドメイン検証は**デプロイ時チェックリスト**へ。`FROM_ADDRESS` が `.demo` の固定値である点も同時に差し替えること |
| **I-5** | 実 KV（Upstash）経路が未検証 | **受容（Security へ引き継ぐ）** | P3-a で実 Redis を立てた実績のある手法（`SemaphoreKvClient` に RESP クライアントを差す）で再測することを Security 監査へ依頼する。**RV-P3B-003 のテストが入れば「注入されている」ことは CI で守られる**ので、残るのは「実 KV が期待どおり応答するか」だけになる |
| **I-6** | `createMemorySemaphoreStore` に契約テストが無い | **条件付き受容（Should Fix）** | 非本番専用なので本単位のブロッカーではない。ただし「KV 版と同じ意味論」が目視でしか担保されていないのは、ローカル E2E の結果を信じる根拠を弱める。**`semaphore-contract.ts` のフェイク契約に載せること**を P3-c の作業に含める |
| **I-7** | P3b-10（`withCronAuth` の試行回数制限）未実装 | **受容（期限内 / 対象外）** | 期限は P3-c。`cron-auth.test.ts` は退行していない。**P3-c の完了条件として明示的に引き継ぐ** |
| **I-8** | AC-RL-9 の閾値再測が未実施 | **受容（対象外）** | 写真フロー込みの再測は P3-c（SPEC-009）。**ただし RV-P3B-007 で発行制限の閾値（30 回 / 10 分）が共有 NAT で現実的に到達しうることを指摘したので、AC-RL-9 の再測項目に「共有 IP 環境での発行枠」を追加すること** |
| **I-9** | `components/apply/` の分解が §6.4 と異なる | **本単位は受容 / P3-c 着手前の分解を必須** | → RV-P3B-012 |
| **I-10** | 確認画面の「修正」リンク / `returnToReview` 未実装 | **受容（Should Fix）** | → RV-P3B-013 |
| **I-11** | Tier C / D の自動再試行が未実装 | **部分的に却下** | 機能の先送りは受容。**「自動的に送信されます」という文面をそのまま公開することは受容しない** → RV-P3B-008 |
| **I-12** | `lib/mail.ts` と `lib/mail/` の共存 | **受容（Nice to Have）** | 動作は確認済み。`lib/mail/send.ts` へ改名すること → RV-P3B-015 |

**申し送りの姿勢について**: §8 に 12 件を書き、`verify-p3b.ts` の `[INFO]` 行で残余を定量化し、
「SEC-055 は完全に閉じていない」「P3b-2 は注入したまでしか報告できない」と自分から書いている点は、
**このプロジェクトが繰り返してきた過大報告を確かに抑制している**。I-3 の判定は覆したが、
それは「未検証と書いたこと」ではなく「未検証で済ませたこと」への指摘である
（結線の欠落はコードを読めば確定するので、報告する前に読むべきだった）。

---

# G. `__Host-` Cookie / WebKit 問題への判定

## 判定: **(a) `__Host-` を維持し、テスト側で制約を明示的に扱う**

`(b) 環境で Cookie 名を出し分ける` / `(c) ローカル E2E を HTTPS 化` は採らない。

### (b) を却下する理由

**最も危険な選択肢である。** Cookie 名は Tier D の Cookie 軸・Tier B の検証・冪等照合の
`sid` 取得という**P3-b の防御の全経路が通る値**であり、ここに環境分岐を入れると:

- 本番でしか実行されない経路が生まれる。`__Host-` の実際の挙動（`Secure` 要求・
  サブドメインからの上書き不可）は**開発でも E2E でも一度も検証されなくなる**。
- 名前が環境で変わる以上、`readFormSessionCookie` / `formSessionAxisKeyFromValue` /
  発行側の 3 箇所が同じ分岐を共有する必要がある。**発行側と検証側がずれた瞬間に
  全利用者が Tier B に落ちる**——`app/api/form-session/route.ts:12-16` が
  middleware 案を却下した理由とまったく同じ事故を、別の形で招き入れることになる。

「本番と開発で経路が分かれるリスク」は、この防御の中心においては受け入れられない。

### (c) を却下する理由

方向としては正しいが、費用対効果が合わない。

- `next start` には `--experimental-https` が無いため、TLS 終端プロキシか自己署名証明書 +
  `playwright.config.ts` の `webServer` / `use.baseURL` / `ignoreHTTPSErrors` の全面改修が要る。
- 既存 9 spec すべてが影響を受け、**P3-b の範囲を大きく超える**（Impl の判断に同意）。
- 得られるのは「webkit で 1 本のテストが通る」ことだけで、
  **`__Host-` が本番 HTTPS で機能するかという本当に確かめたい事実は、
  自己署名証明書の localhost では厳密には確かめられない**（WebKit の
  `Secure` 判定は通るが、実ドメイン・実証明書での挙動とは別物）。

**P3-c 以降でローカル E2E の HTTPS 化を検討課題として残すことには賛成する**が、
本単位の解決策としては過剰である。

### (a) の実施要領 — **「黙って skip しない」ための具体的条件**

「E2E が赤いのが常態」を避けるのが目的なので、以下 3 点を**すべて**満たすこと。
1 点でも欠けたら (a) の採用は認めない。

**1. webkit でも「サーバーが正しい `Set-Cookie` を返すこと」は検証し続ける。**
ブラウザの Cookie ジャーに入らないだけで、**レスポンスヘッダは webkit でも読める**。
`request` フィクスチャ（ブラウザの Cookie ポリシーを経由しない）で全ブラウザ共通に検証する:

```ts
test('GET /api/form-session が __Host-fs を Set-Cookie する（全ブラウザ / サーバー側の契約）', async ({
  request,
}) => {
  const response = await request.get('/api/form-session', { maxRedirects: 0 })
  expect(response.status()).toBe(303)
  const setCookie = response.headers()['set-cookie'] ?? ''
  expect(setCookie).toContain('__Host-fs=')
  expect(setCookie).toContain('Secure')
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Lax')
  expect(setCookie).toContain('Path=/')
})
```

**2. ブラウザの Cookie ジャーを見るテストだけを、理由を名指しして webkit から外す。**
`test.skip` の第 2 引数（理由文字列）に**制約の内容と、本番では成立することの根拠**を書く。
`browserName !== 'chromium'` のような雑な絞り方はしない（firefox は通るので外す理由が無い）。

```ts
test('GET /apply がブラウザの Cookie ジャーへ __Host-fs を格納する', async ({
  page, context, browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'WebKit は http://localhost を安全なオリジンとして扱わないため、Secure を必須とする ' +
      '__Host- 接頭辞 Cookie を受理しない（Chrome / Firefox は受理する）。' +
      'サーバーが正しい Set-Cookie を返すことは上の全ブラウザ共通テストが検証しており、' +
      '本番は HTTPS のため本テストの対象事象は発生しない。' +
      '初回 HTTPS デプロイ後の iOS Safari 実機確認を P3-c の完了条件とする（I-1）。',
  )
  // …既存のアサーション…
})
```

**3. 未確認事項を消さない。** I-1 を**クローズせず**、`docs/phase-status.md` の
P3-c 完了条件へ次を追加すること:

> **P3c-x**: 初回 HTTPS デプロイ後、**iOS Safari の実機**で `/apply` を開き
> `__Host-fs` が発行され、送信が 201 になることを確認する。
> **失敗した場合は `__Host-` の是非を再判断する**（本判定は「本番 HTTPS なら
> 全ブラウザで機能する」という*前提*に依存しており、実測ではない）。

### 補足: `top-page.spec.ts:27`（webkit）について

オーケストレーターが単独実行でパスすることを確認済みであり、
`docs/phase-status.md` の E2E 運用知見にある「高負荷時のサーバー到達性」と同一症状。
**実装の欠陥ではないと判定する。** ただし flaky の常態化は「赤が普通」への入口なので、
P3-c で spec 数が増える前に `playwright.config.ts` の `workers` 見直しを検討課題として残す。

---

# H. P3-c 着手可否

## 判定: **着手不可。下記を満たした上での再レビューを必須とする。**

### 理由

1. **RV-P3B-001 により、F-008 / F-010 は本番で 1 件も受け付けられない。**
   P3-c（F-009 免許証写真）は、この申込フローの中にステップを追加する作業である。
   送信が成立しないフォームの上に写真アップロードを積むと、
   **P3-c の E2E も「送信できない」ことを前提に書かれる**——テストが壊れた前提を
   固定してしまい、後から直す費用が跳ね上がる。
2. **RV-P3B-002 も同じ理由でブロッカーである。** Cookie 発行の信頼性は
   写真アップロードの `uploadToken` 発行にも波及する設計（`lib/apply-draft.ts` の (e) が
   守ろうとしている経路）であり、先に確定させる必要がある。
3. **RV-P3B-003 / 004 は「P3-b の完了条件」そのものの未達**であり、
   `docs/review-p3b-tests-2026-07-29.md` §7 が
   「Senior / Security は『テストが無いこと』を承認しないこと」と明示している。
   ここで承認すると、その条件は次単位以降存在しなかったことになる。

### 再レビューの通過条件

| # | 条件 |
|---|------|
| 1 | **RV-P3B-001** — Turnstile のコールバック結線 + 期限切れ/エラー処理 + ユニット 1 本 + `/apply` の E2E 1 本 |
| 2 | **RV-P3B-002** — `?fs=1` の `history.replaceState` による除去（+ 可能なら attempted Cookie） |
| 3 | **RV-P3B-003** — `runtime-stores` 注入を固定するテスト |
| 4 | **RV-P3B-004** — `GET /api/form-session` の 31 回目 429 を固定するテスト |
| 5 | **RV-P3B-005** — `/apply` を確認画面まで開いた実ブラウザ CSP 違反 0 のテスト |
| 6 | **RV-P3B-008** — 自動再送の実装、または文面の修正（どちらでもよい） |
| 7 | 上記修正後に `pnpm test:unit` / `test:integration` / `type-check` / `lint` / `build` / `CI=1 pnpm test:e2e` を再実測し、**webkit の `__Host-fs` 1 件が §G の (a) により明示的に扱われた状態で E2E が緑**であること |

Should Fix のうち **RV-P3B-006 / 007 / 009 / 010** は、上記と同じ差し戻しで直せるなら
同時に処理することを強く推奨する（いずれも局所的で、後回しにすると P3-c の変更と絡む）。
**RV-P3B-012（コンポーネント分解）は P3-c 着手時の最初の作業**として計画に入れること。

### P3-c へ引き継ぐ条件（本単位では対象外だが忘れないこと）

- **P3b-10**: `withCronAuth` の試行回数制限（期限は P3-c）
- **I-5**: 実 KV に対する `sharedRateLimitStore` 経由の疎通確認（Security 監査）
- **I-6**: `createMemorySemaphoreStore` を `semaphore-contract.ts` のフェイク契約へ載せる
- **I-8 + RV-P3B-007**: AC-RL-9 の再測に「共有 IP 環境での Cookie 発行枠」を追加する
- **I-1**: 初回 HTTPS デプロイ後の iOS Safari 実機確認（§G の 3.）
- **I-4**: Resend の差出人ドメイン検証と `FROM_ADDRESS` の実アドレス化

---

## 付記: 本レビューで実行しなかったこと

- **品質ゲートの再実行は行っていない**（オーケストレーターが独立実測済みのため。指示どおり）。
- **E2E は実行していない**（指示どおり）。E2E に関する判断は、
  オーケストレーターの実測値と `docs/impl-p3b-notes-2026-07-29.md` §7 の切り分けに依拠している。
- **実装コード・テストコードは 1 行も変更していない**（指示どおり）。
- RV-P3B-001 は**静的な走査（`grep -rn "onTurnstileToken" app components lib tests`）と
  コードリーディングによる判定**であり、実ブラウザでの再現は行っていない。
  ただし「トークンを受け取る経路が存在しない」ことはソース上で確定するため、
  再現実測を待たずに Must Fix と判定した。修正時に §RV-P3B-001 の E2E を足すことで、
  この判定自体が以後 CI で検証される状態になる。
