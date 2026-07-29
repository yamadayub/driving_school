# コードレビュー: P3-a 差し戻し修正（再検収）

## レビュー日: 2026-07-29
## 対象Phase: 実装（CLAUDE.md Phase 7 / Senior Engineer 再レビュー）
## レビュワー: Senior Engineer Agent
## 位置づけ
`docs/review-p3a-code-2026-07-29.md`（**Request Changes** / Must Fix 1件）に対する修正の再検収。

## 入力
- `docs/review-p3a-code-2026-07-29.md`（前回指摘 RV-P3A-001〜012）
- `docs/p3a-fix-plan-2026-07-29.md`（修正スコープ）
- `docs/review-p3a-fix-tests-2026-07-29.md`（テスト契約。特に §T1 の型設計要求）
- `docs/impl-p3a-fix-notes-2026-07-29.md`（**§6「断定できないこと」/ §8「検証できていないこと」を含めて全文**）
- `docs/security-audit.md`「P3-a 監査」SEC-042 / SEC-043 / SEC-044〜047
- `docs/impl-p3a-notes-2026-07-29.md`（基準値の出所確認のため）
- 実装: `lib/public-guard.ts` / `lib/http-guard.ts` / `lib/form-session.ts` / `lib/login-guard.ts` /
  `playwright.config.ts` / `tests/unit/*`（6ファイル）/ `tests/e2e/playwright/admin-authz.spec.ts` / `csp.spec.ts`

## 本レビューが実行したこと / **していないこと**
- **実行した**: 対象実装 3 ファイルと追加テスト 6 ファイルの精読、型の継ぎ目のソース上の追跡
  （`sourceAxisFor` の全呼び出し元 / `rateLimitKey` の全呼び出し元 / 型の抜け穴 grep）、
  `usesGenuineWrapper` の判定ロジックの手による展開、`lib/login-guard.ts:129-142` との意味論の突き合わせ、
  **`pnpm exec playwright test --list` の実行**（テストを走らせない列挙のみ。E2E 合計件数の独立確認）、
  基準値の出所の文書追跡。
- **していない**: `pnpm test:e2e` の実行（**指示により禁止**）。unit / integration / type-check / lint / build の
  再実行（オーケストレーターが独立実測済み）。**したがって E2E とゲート結果に関する記述はすべて他者の実測の引用であり、
  本レビューの独立検証ではない**（`--list` の 103 件だけが本レビューの独立実測である）。
- **できなかった**: 本リポジトリは **git 管理下にない**ため、`admin-authz.spec.ts` の**バイト単位の差分検証はできない**。
  アサーション不変の確認は「現ファイルの assertion が PT2-01 / PT2-05 / PT2-06 の文書化された契約と 1 対 1 で対応すること」
  「`withPrisma` の呼び出し側 17 箇所の形が変わっていないこと」という間接的な確認に留まる（§C-3 に明記する）。

---

# 総合評価: **Approve**

| 区分 | 件数 |
|------|------|
| **Must Fix** | **0** |
| Should Fix | 3（RV-P3AF-001 / 002 / 003）|
| Nice to Have / 記録 | 3（RV-P3AF-004 / 005 / 006）|

## P3-b 着手可否: **可（無条件）**

前回の着手条件（RV-P3A-001 / RV-P3A-003）は**いずれも閉じた**。Security の High 2件（SEC-042 / SEC-043）と
SEC-047 も閉じている。新規指摘 3件はいずれも **Should Fix 以下で、P3-b と並行して処理できる**。

ただし **P3-b の着手担当者は RV-P3AF-006（縮退構成では `verifyFormSession` 未配線の公開ルートが全リクエスト 403 になる）を
着手時点で読むこと。** これは欠陥ではなく本修正が意図して入れた fail-closed 動作だが、
**`/apply` の E2E を書く前に知らないと「全部 403 で落ちる」原因が分からない**。

---

# 1. クローズ判定表

| ID | 出典 | 判定 | 根拠（file:line）|
|----|------|------|-----------------|
| **RV-P3A-001** | 前回 Must Fix | **クローズ** | `lib/public-guard.ts:67-72`（`sourceAxisFor` が `ClientIpResolution` を要求）/ `:232-233`（唯一の呼び出し元）/ `:257`（`!result.success && enforce`）/ `:266-269`（条件1'-3）。§2 に型の抜け穴の検証を記す |
| **SEC-043** | 監査 High | **クローズ** | 同上。意味論が `lib/login-guard.ts:129-142` と一致することを行単位で突き合わせた（§2.3）|
| **SEC-042** | 監査 High | **クローズ** | `lib/form-session.ts:128-131`（バイト長比較）/ `lib/public-guard.ts:238-243`・`:274-286`（ラッパ側の例外封じ込め）。構造テスト `tests/unit/form-session.test.ts:248` が `providedSignature.length !==` の再出現を禁止 |
| **SEC-047** | 監査 Low | **クローズ** | `tests/unit/api-route-guard-coverage.test.ts:175-183`（`usesGenuineWrapper`）/ `:223-246`（**実ルート走査ループに適用されている**）/ `:322-331`（監査実測②の形を `false` と判定）。§3.2 に判定ロジックの展開を記す |
| **RV-P3A-003** | 前回 Should Fix（着手条件）| **クローズ（残件は RV-P3AF-003 として分離）** | `playwright.config.ts:45`（`process.env.CI ? 'pnpm start' : 'pnpm build && pnpm start'`）/ `:48` / `:50`。**赤の原因（`pnpm dev` → `'unsafe-eval'`）は消え、当の `csp.spec.ts` を CI 無しで実行して 7 passed を実測している**（Impl §4）。ただし非 CI のフル実行は未実施 → RV-P3AF-003 |

## 前回 Should Fix / Nice to Have の状態（参考。着手条件ではない）

| ID | 状態 |
|----|------|
| RV-P3A-002（`PTTL` の往復増）| 未着手。**スコープ外として正しい**（`p3a-fix-plan` §スコープ外）。P3-b と並行で可 |
| RV-P3A-004（`font-src`）/ 005（force-dynamic の assert）/ 007〜012 | 未着手。スコープ外として正しい |
| **RV-P3A-006（Lua の実行検証）** | **実質クローズ**。`p3a-fix-plan:8` によれば **Security 監査が本物の Redis 7.4.10 を立てて `SEMAPHORE_ACQUIRE_LUA` を Lua VM で実行**している。**`docs/phase-status.md` の P3-b 完了条件から降ろすか、「監査で閉じた」と明記すること**（開いたまま残すと、P3-b の担当者が同じ検証を再実施する）→ RV-P3AF-004 に含めて記録 |

---

# 2. 観点A — RV-P3A-001 / SEC-043 が「型で」塞がれたか

## 2.1 3つの継ぎ目は実在し、いずれも効いている

### (a) `sourceAxisFor(endpoint, resolution: ClientIpResolution)` — `lib/public-guard.ts:67-72`

```ts
export function sourceAxisFor(
  endpoint: SemaphoreEndpoint,
  resolution: ClientIpResolution,
): SourceAxis {
  return { key: rateLimitKey(`${endpoint}:`, resolution.key), enforce: resolution.trusted }
}
```

`resolveClientIp(r).key` は `string` なので `TS2345` で落ちる。**これは Impl の自己申告だけでなく、
契約テストが `@ts-expect-error` で固定している**（`tests/unit/public-guard-source-axis-type.test.ts:90` / `:92`）。
`pnpm type-check` が 0 エラーであるという実測は、**この 2 行の `@ts-expect-error` が「使われている」＝
実際に型エラーが起きていること**を意味する（使われなければ TS2578 で落ちる）。**赤にならないことが証明になる形**
になっており、これは正しいテスト設計である。

### (b) `PublicGuardOptions.clientIp?: (request: Request) => ClientIpResolution` — `:151`

戻り値型を `{ key, trusted }` へ緩めると `tests/unit/public-guard-source-axis-type.test.ts:106` の
`expectTypeOf<ClientIp>().returns.toEqualTypeOf<ClientIpResolution>()` が型レベルで落ちる。
**「型が緩むこと自体を禁じる」という着眼は正しい。** (a) だけでは、オプションの型を緩めてから
`.key` を渡す 2 手で迂回できる。

### (c) Tier D の軸要素型が `enforce: boolean` を必須にする — `:229`

```ts
const axes: Array<{ axis: string; limiter: RateLimiter; key: string; enforce: boolean }> = []
```

新しい軸を足す人は `enforce` を書かざるを得ない。**「共有軸を無自覚に硬いゲートへ昇格させる書き方が
コンパイルできない」という主張は、この型の範囲では正しい。**

## 2.2 縮退判定が 1 箇所に閉じているか — **閉じている（実測）**

`grep -rn "sourceAxisFor" lib/ app/` の一致は `lib/public-guard.ts:232`（呼び出し）とコメント・定義のみ。
`grep -rn "rateLimitKey(" lib/` の一致は `public-guard.ts:71`（`sourceAxisFor` 内）/ `:250`（`formSession` 軸）/
`rate-limit.ts:209`（定義）/ `login-guard.ts:117,122` のみ。
**発信元軸を組み立てる経路は `sourceAxisFor` 1 本しか存在しない。** 呼び出し側に `if (trusted)` は無い
（`resolved.trusted` を直接読むのは条件1'-3 の `:266` のみで、これは per-source ゲートではなく
「別軸を要求する」判定である）。**要求どおり。**

## 2.3 意味論が `lib/login-guard.ts` と一致しているか — **一致**

| | login-guard | public-guard |
|---|---|---|
| 計数 | `limiters.ip.consume(ipKey, now)` を**常に**呼ぶ（`:129`）| `limiter.consume(key, at)` を**常に**呼ぶ（`:256`）|
| ゲート | `if (trusted && !gate.success) return denied(...)`（`:135`）| `if (!result.success && enforce)`（`:257`）|
| 縮退時の代替 | グローバル軸 + 予約枠 | 別軸（`verifyFormSession`）を必須化（`:266-269`）|

**`cleanSource` / 予約枠は持ち込まれていない**（`grep` 一致 0 件）。SEC-041 の線引きは守られている。

## 2.4 型の抜け穴 — **重大な穴は無い。残る穴は 2 種で、いずれも振る舞いテストが二重に塞いでいる**

`grep -rn "as any|@ts-ignore|@ts-expect-error| as unknown as |: any" lib/ app/ middleware.ts` の一致は
`lib/db.ts:7` / `middleware.ts:44` / `lib/markdown/renderSafe.ts:92` の 3 件のみで、**いずれもガード経路とは無関係**。
`lib/public-guard.ts` にキャストは 1 つも無い。

残る穴（**記録。差し戻し理由にはしない**）:

1. **構造的部分型**: `sourceAxisFor(ep, { key: 'unknown', trusted: true, source: 'unknown' })` は
   コンパイルを通る。つまり「`trusted` を**捨てる**」ことは塞がれたが、「`trusted: true` を**手で書く**」ことは
   塞がれていない。ただし前者は**うっかり**（実際に起きた）、後者は**意図的な改ざん**であり、
   型が止めるべき対象は前者である。**Impl §8-1 が「型は『うっかり』を止める仕掛けであって、
   意図的な迂回を止めるものではない」と正しく限定している。**
2. **`axes.push` を `sourceAxisFor` を経由せずに書ける**: 型は `enforce` の**記述**を強制するが
   `enforce: true` の**内容**までは強制しない。これは `tests/unit/public-guard-degraded-source.test.ts:96`
   （縮退時に 429 にならない）が振る舞い側で塞いでいる。**型 + 振る舞いの二重網は妥当な落とし所である。**

→ **RV-P3AF-005 として記録のみ。追加作業は求めない。**

## 2.5 条件1'-3 の実装 — 契約どおり。ただし副作用が大きい

`:266-269` は `limiters.source` の有無に関係なく無条件に評価される。したがって
**`trusted === false` の環境では、`verifyFormSession` を渡さない公開ルートは全リクエストが 403 になる。**

これは Test 契約 §T1 が明示した形そのもの（契約書 `:136-139`）であり、契約違反ではない。
**Impl も §8-3 で「実配線時に『`verifyFormSession` を渡し忘れると縮退構成で全リクエストが 403 になる』
という形で顕在化する」と記録している。** 正しく記録された事項なので差し戻さない。
→ **RV-P3AF-006 として P3-b 着手時の申し送りに格上げする**（理由は §4.6）。

---

# 3. 観点B — Security High 2件 / SEC-047

## 3.1 SEC-042（Cookie 署名比較）— **クローズ**

`lib/form-session.ts:128-131`:

```ts
const provided = Buffer.from(providedSignature, 'utf8')
const expectedBytes = Buffer.from(expected, 'utf8')
if (provided.length !== expectedBytes.length) return null
if (!timingSafeEqual(provided, expectedBytes)) return null
```

`lib/cron-auth.ts:39-43` と同じ形。**`try/catch` で握り潰していない**点が正しい
（比較に到達しなかった入力と「署名不一致」を区別できなくなる、という理由も適切）。

**関数全体を通しで追い、他に例外を投げうる箇所が無いことを確認した**:

| 行 | 処理 | 攻撃者制御下の入力で throw しうるか |
|----|------|-----------------------------------|
| `:114` | `value.split('.')` | しない |
| `:117` | `providedSignature.length === 0` | しない（**`!==` ではなく `=== 0` なので構造テストの禁止パターンに抵触しない。かつ長さ 0 判定は正しい**）|
| `:119` | `sign(payloadPart, secret)` | `payloadPart` は `update()` に渡すだけ。`hkdfSync` の入力は env 由来 |
| `:128-131` | バイト長比較 → `timingSafeEqual` | **修正済み**。孤立サロゲートも `Buffer.from(...,'utf8')` が U+FFFD へ置換するため決定的 |
| `:135` | `Buffer.from(payloadPart,'base64url')` | 不正 base64url でも throw しない |
| `:135` | `JSON.parse` | **`try/catch` 済み**（`:134-139`）|
| `:141-148` | 型・時刻検証 | しない |

**長さ判定がタイミング情報を漏らすか**: `expected` は常に base64url 43 文字（HMAC-SHA256 32 バイト）の固定長で、
秘密を含まない。**問題なし。**

ラッパ側（`lib/public-guard.ts:238-243` / `:274-286`）も契約どおり。応答の完全一致は
`tests/unit/public-guard-fault-containment.test.ts:87-108` が `status` / `body` / `headers`（`date` 除く）を
比較して固定している。**ログ側だけ `formSession-error` で区別する判断は正しい**（AC-RL-10 の
「軸名・ハッシュ先頭8文字・判定結果だけ」を維持しつつ、サーバー側の診断能力を残している）。

**ただし `formSessionKey` の例外経路には計数上の非対称が残る → RV-P3AF-001。**

## 3.2 SEC-047（ルート列挙テストの import 元検証）— **クローズ**

`usesGenuineWrapper`（`:175-183`）= `!declaresLocally(...) && importsIdentifierFrom(...)`。
**判定ロジックを手で展開し、監査実測②の形が落ちることを確認した**:

```
const withPublicMutation = <T,>(handler: T) => handler
export const POST = withPublicMutation(async () => new Response())
```
→ `declaresLocally` の `(^|\n)\s*(export\s+)?(const|let|var|function|async\s+function|class)\s+withPublicMutation\b`
が `const withPublicMutation` に一致 → **`false`**（＝本物ではない）。✅

**この網が実ルートに適用されているか**（自己検証だけで空振りしていないか）を確認した:
`:230-243` のループは `listRouteFiles(API_ROOT)` の結果に対して `usesGenuineWrapper(source, rule.wrapper, rule.module, file)`
を呼んでいる。実測で対象は空ではない:

```
app/api/admin/news/route.ts        : import { withAdminMutation } from '@/app/api/admin/_guard' / export const POST
app/api/admin/news/delete/route.ts : 同上 / export const POST
app/api/admin/news/[id]/route.ts   : 同上 / export const PUT, DELETE
app/api/admin/news/save/route.ts   : 同上 / export const POST
```
→ **4 ルート・5 メソッドが実際にこの assert を通っている。** ✅

判定ロジックの境界も手で確認した:

| ケース | 判定 | 妥当性 |
|--------|------|--------|
| `function withPublicMutation2() {}` が同居 | `\b` により誤検出しない | ✅ 偽陽性を作らない（テスト `:369` が固定）|
| 複数行 import | `[^}]*` は改行を含む | ✅ 動く |
| `import { X as withPublicMutation }`（別 export の別名）| **通ってしまう** | ⚠️ 極めて作為的。型検査・実行時に落ちる。実害なし |
| `import * as g from ...; export const POST = g.withPublicMutation(...)` | `isWrappedBy` が false → 別の assert で落ちる | ✅ 保守側に倒れている |

**「ルート名をハードコードしない」という AC-010-14 の本質は維持されている。** ✅

---

# 4. 観点C — 新たに持ち込まれた問題

## [RV-P3AF-001] `formSessionKey` の例外が Tier D の計数をまるごと飛ばし、正常な Tier B との**サーバー側状態**の差になる

- **種別**: Design / Security（副次経路）
- **重要度**: **Should Fix**（**P3-b で `/apply` に配線するときに同時に閉じること**。P3-a のブロッカーにはしない）
- **場所**: `lib/public-guard.ts:235-253`（`return TIER_B()` の位置）

### 現状

```ts
if (limiters?.formSession && formSessionKey) {
  let raw: string | null
  try { raw = formSessionKey(request) }
  catch {
    deny('B', 'formSession-error', `${endpoint}:challenge`)
    return TIER_B()            // ← ここで返るので、下の consume ループに一度も入らない
  }
  ...
}
for (const { axis, limiter, key, enforce } of axes) {
  const result = await limiter.consume(key, at)   // ← source 軸の計数もここ
  ...
}
```

### なぜ問題か

1. **計数が止まる。** このファイル自身が `:255` で「計数は常に行う——ゲートに使わない軸でも、
   攻撃の観測手段（メトリクス・監査ログ）は失わない」と書いている。**`formSessionKey` が例外を投げる入力を送り続ける
   攻撃者だけが、per-source バケットを 1 も進めずに無制限の 403 を得られる。**
   これは SEC-042 が挙げた影響「ログ増幅」を、500 ではなく 403 の形で部分的に残す。
2. **応答は同一でも、サーバー側の状態が違う。** 正常な Tier B（Cookie が不正 → `verifyFormSession` が `false`）は
   per-source 軸を **consume する**。例外由来の Tier B は **consume しない**。
   攻撃者は「毒 Cookie を N 回送った後に正規リクエストを送り、429 までの残り回数が減っていないこと」を観測すれば、
   **どの入力が内部例外を起こすかを区別できる。** `tests/unit/public-guard-fault-containment.test.ts:87` は
   **応答だけ**を比較しているため、この差を検出しない。設計コメント（`:272-273`）が守ろうとした
   「bot に判定基準を教えない」という性質は、応答レベルでは達成、状態レベルでは未達である。

### なぜ Must Fix にしないか

**`formSessionKey` を渡す呼び出し元が現時点で 0 件である**（公開ルートが 1 本も無い）。RV-P3A-006 を
「P3-a には Lua を実行する経路が無いので P3-b の完了条件」とした判断と同じ位置づけである。
かつ本体（handler）は実行されず DB / I/O は消費されないため、**500 だった修正前より厳密に良い**。

### 改善案（4行）

例外を「軸を評価しない」に落として、Tier D ループを通してから Tier B を返す:

```ts
let deferredTierB = false
if (limiters?.formSession && formSessionKey) {
  let raw: string | null = null
  try { raw = formSessionKey(request) }
  catch {
    // 応答も**サーバー側の計数も**正常な Tier B と揃える（どの入力が例外かを観測させない）。
    deny('B', 'formSession-error', `${endpoint}:challenge`)
    deferredTierB = true
  }
  if (raw !== null) axes.push({ ... })
}
for (...) { /* consume */ }
if (deferredTierB) return TIER_B()
```

**併せて、`fault-containment` のテストを「応答の一致」から「応答 + per-source バケットの状態の一致」へ広げること。**
そうしないと同じ形が P3-b の Turnstile / 送信間隔 / ハニーポットで再発する（判定材料が増えるほど例外経路も増える）。

---

## [RV-P3AF-002] E2E の基準値「100件」は誤り。**合計は P3-a の時点から 103 件である**（観点D の回答）

- **種別**: Documentation / 監査証跡の正確性
- **重要度**: **Should Fix**
- **場所**: `docs/p3a-fix-plan-2026-07-29.md:49`

### Impl §6-1 の留保への判定: **留保の姿勢は正しい。ただし差分の出所は特定できる。**

Impl は「103 vs 100 の 3 件差は本タスクの変更ではない」「誰がいつ足したかは特定できていない」として
断定を避けた。**「本タスクの変更ではない」は正しい**（本タスクで E2E は 1 件も追加していない）。
**その上で、出所はリポジトリ内の文書だけで特定できる。**

### 特定の根拠

1. **本レビューの独立実測**（`pnpm exec playwright test --list`。テストは実行していない）:
   ```
   Total: 103 tests in 8 files
   chromium 53 / firefox 25 / webkit 25
   ```
   内訳: admin 系 28（chromium 単独）+ 公開系 25 × 3 ブラウザ = 103。
2. **`docs/impl-p3a-notes-2026-07-29.md:389-390`（P3-a 実装時の Impl 自身の記録）**:
   > **合計 103 = 97 passed + 4 flaky + 2 skipped / failed 0。**
   > 内訳は **既存 82 件（78 passed + 4 flaky）+ CSP 新規 21 件（19 passed + 2 skipped）**。

   82 + 21 = 103。`csp.spec.ts` 7 テスト × 3 ブラウザ = 21、うち 2 skipped は
   `csp.spec.ts:121` の `test.skip(browserName !== 'chromium')` に一致する。**完全に整合する。**
3. **同 `:503-504`**:
   | 出典 | 報告値 | 合計 |
   |------|--------|------|
   | オーケストレーター独立実測 | 94 passed / 4 flaky / 2 skipped / 0 failed | **100** |
   | Impl 確定版 | 91 passed / 1 failed / 4 flaky / 2 skipped / **5 did not run** | **103** |

### 結論

**3 件は「後から誰かが足した」のではなく、オーケストレーターの実測（94 passed）の内訳が
スイート全体（103）を説明できていないことによる。** 3 件が passed / flaky / skipped / failed の
どれにも計上されていない（Impl の別実行では `5 did not run` が現れており、中断された実行では
この列が生じる）。そして `p3a-fix-plan:49` は、**合計の異なる 2 つの報告（94 と 97）を「一致」と記録した。**
これが「基準値 100」の出所である。

**本プロジェクトが繰り返している「文書と実態の乖離」の一例であり、Impl が断定を避けたことは正しいが、
基準値の側を直さなければ次の再監査でも同じ照合に時間を取られる。**

### 改善案

1. `docs/p3a-fix-plan-2026-07-29.md:49` と `docs/phase-status.md` の E2E 基準値を
   **「合計 103 件（8ファイル）。うち 2 skipped は `csp.spec.ts` の非 chromium 分」** へ更新する。
2. 同行の「Impl 報告 97 passed … と一致」を削除する（**一致していない**）。
3. 今後の E2E 報告には **`Running N tests` の行を必ず添える**（合計が合わない実行を「全パス」と読まないため）。

---

## [RV-P3AF-003] 文書化されたゲート `pnpm test:e2e`（CI 無し）は**フル実行が一度も行われていない**

- **種別**: Test / 開発フロー
- **重要度**: **Should Fix**（P3-b と並行で可。**着手のブロッカーにはしない**）
- **場所**: `playwright.config.ts:12`（`retries: process.env.CI ? 2 : 0`）/ `:13`（`workers`）

RV-P3A-003 が指摘した**赤の原因**（`pnpm dev` → `'unsafe-eval'` → `csp.spec.ts:64`）は消えており、
**当の `csp.spec.ts` を CI 無しで実行して 7 passed を実測している**（Impl §4）。**この点は閉じた。**

残るのは別の事実である。Impl §8-5 が正直に書いているとおり:

- 非 CI は `retries: 0` / 並列ワーカーであり、**既知 flaky 4件がそのまま failed になる可能性が高い**。
- 非 CI のフル実行は**一度も行われていない**。

つまり「`pnpm test:e2e` が緑になる」は**依然として誰も確認していない**。
CI 経路（`CI=1`）とは `retries` と `workers` が違うため、**2つは同じゲートではない。**

### 改善案（どちらか。**判断してから P3-b を進めること**）

- **(a) 推奨**: `CLAUDE.md`「品質ゲート」4番と `docs/phase-status.md` のゲートコマンドを
  **`CI=1 pnpm test:e2e` に統一する**（実測基準値がこちらで取られている以上、こちらが正である）。
  非 CI は「手元での部分実行用」と位置づけを明記する。
- **(b)** P3-b の最初の CI 実行と同時に、非 CI のフル実行を 1 回だけ行って結果を記録する。

**どちらでもよいが、「文書化されたコマンドは緑である」と書かないこと。** 現時点で根拠が無い。

---

## [RV-P3AF-004] `playwright.config.ts:14-16` のコメントが dev サーバー前提のまま

- **種別**: Documentation
- **重要度**: Nice to Have
- **場所**: `playwright.config.ts:14-16`

```ts
// dev（pnpm dev）はルートをオンデマンドコンパイルし、認証は verifyPassword(scryptSync,同期)を
// イベントループで直列化するため、初回アクセスが Playwright デフォルト(5s/30s)を超えることがある。
// 天井を上げて吸収する。CI は prebuilt(pnpm start)で高速なため実害なし（timeout は上限にすぎない）。
```

本修正で **E2E は CI / 非 CI ともに `pnpm start`（本番ビルド）になった**ため、この理由づけはもう成立しない。
Impl は 3 行目のコメントは直したが（`:4`）、ここは残っている。`timeout: 60_000` 自体は
flaky 対策として残す価値があるので、**理由を書き換えるだけでよい**。

**併せて**: `docs/phase-status.md` の P3-b 完了条件から **RV-P3A-006（Lua の実行検証）を降ろす**か
「Security 監査が実 Redis で実施済み」と明記すること（`p3a-fix-plan:8`）。開いたまま残すと重複作業になる。

---

## [RV-P3AF-005] 型の継ぎ目は構造的部分型を塞がない（**記録のみ。追加作業を求めない**）

§2.4 のとおり。`sourceAxisFor(ep, { key, trusted: true, source })` を手で書けば `enforce: true` を作れる。
`axes.push` を `sourceAxisFor` を経由せずに書くこともできる。**いずれも振る舞いテスト
（`public-guard-degraded-source.test.ts:96` / `:126` / `:164`）が二重に塞いでいる。**
Impl §8-1 がこの限界を正しく限定して記録しているので、**指摘ではなく記録である。**

---

## [RV-P3AF-006] 縮退構成では `verifyFormSession` 未配線の公開ルートが**全リクエスト 403** になる（P3-b 着手時の申し送り）

- **種別**: Design（意図された fail-closed）/ 申し送り
- **重要度**: Should Fix の申し送り（**実装は正しい。差し戻し理由ではない**）
- **場所**: `lib/public-guard.ts:266-269`

条件1'-3 は `limiters` の有無に関係なく無条件に評価される。**`VERCEL !== '1'` の環境
（ローカル / `next start` 直公開 / デモ / **そして E2E 実行環境**）では `resolveClientIp` が必ず
`trusted: false` を返す**ため、`verifyFormSession` を渡さない `withPublicMutation` は
**全リクエストが 403 { challenge } になる。**

これは契約書 §T1 が指定した形であり（`:136-139`）、素通りさせないための正しい選択である。
**Impl も §8-3 で明記している。** したがって差し戻さない。

**P3-b の担当者への申し送り**（`docs/phase-status.md` の P3-b 行へ追記を推奨）:

1. `POST /api/applications` を配線するとき、**`verifyFormSession` と `formSessionKey` を最初から渡すこと。**
   後回しにすると E2E が「全部 403」になり、原因の切り分けに時間を取られる。
2. **`GET /apply` の Cookie 発行（`Set-Cookie`）を、送信経路より先に動く状態にすること。**
   縮退環境では Cookie が唯一の軸になるため、発行が動いていないと E2E で正常系が 1 本も通らない。
3. これは監査 SEC-043 の「修正方針2: 別軸を必ず要求する」の帰結であり、**弱めてはならない。**

---

# 5. 観点C-3 — `admin-authz.spec.ts` の `withPrisma` 変更

## 判定: **妥当。テストの独立性・後始末を壊していない**

### 変更内容（`:116-153`）
呼び出しごとの `new PrismaClient()` + `$disconnect()` を、**ワーカーあたり 1 つの共有クライアント**
（`sharedPrisma`）へ変更し、ファイル直下の `test.afterAll` で切断する。

### 確認したこと

| 観点 | 判定 | 根拠 |
|------|------|------|
| **アサーションの不変** | ✅（ただし §レビュー範囲の限界あり）| 現ファイルの `expect` は PT2-01（`[401,403]` × 4）/ PT2-05（403 / 303 + `location` / DB 実体確認）/ PT2-06（403 / 201 / 200 / `[400,415]` / GET 200）と、各 describe の JSDoc が宣言する契約に**1対1で対応している**。`withPrisma` の**シグネチャと 17 箇所の呼び出し側は無変更**（すべて `withPrisma((prisma) => prisma.news.…)` の形）。**git 管理外のためバイト単位の差分検証はできない**（§レビュー範囲）|
| **フック順序** | ✅ | Playwright は内側スコープの `afterAll` を先に実行する。PT2-06 の describe 内 `afterAll`（`:493`）が `withPrisma` を使い、その後にファイル直下の `afterAll`（`:141`）が切断する。**コメント（`:139-140`）の記述は正しい** |
| **後始末の網羅** | ✅ | `deleteMany({ title: { startsWith: CSRF_TITLE_PREFIX } })` は変更前と同じ。切断は `sharedPrisma !== null` のときだけ行い、`null` に戻す |
| **並列実行時** | ✅ | `sharedPrisma` はモジュールスコープ＝**ワーカープロセスごと**。非 CI の並列でもワーカーごとに 1 つ作られ、ワーカーごとに切断される。`deleteMany` は冪等 |
| **リトライ時** | ✅ | Playwright は失敗したワーカーを破棄して新プロセスで再試行するため、`sharedPrisma` は再生成される |
| **テスト間の状態共有** | ✅ | Prisma クライアントは接続プールだけを保持し、テスト固有の状態を持たない。DB はもともと共有である |
| **未使用ワーカー** | 影響なし | `withPrisma` を一度も呼ばないワーカーでも `afterAll` がクライアントを 1 つ作る。**変更前も同じ**（後退なし）|

### 変更が「正しい場所」を狙っているか — **狙っている**

`docs/impl-p3a-notes-2026-07-29.md:624` は既知の failed を
「`admin-authz.spec.ts:160`。**契約（403）自体は通っており**、dev DB へ問い合わせる検証行が
`PrismaClientInitializationError` で落ちている」と記録している。
現ファイルで当該テストは `:175-196` にあり、**落ちていた検証行は `:192-195` の `withPrisma(...findFirst)` である**
（行番号のずれは今回の挿入分と整合する）。**接続確立の失敗を疑って接続回数を減らすのは、
症状ではなく仮説に対する介入であり、正しい方向である。**

### flaky の扱い — **Impl の留保は妥当。本レビューも「解消した」とは判定しない**

Impl は「**flaky 0 を成果として報告しない**」「1回の実行では区別できない」と明記した。**支持する。**

**E2E が 29.0m → 4.9m へ短縮した理由の評価**:

- Impl の仮説（マシン負荷が低かった）は**妥当**である。約 6 倍という差は、`retries: 2` による
  リトライ分（flaky 4件 × 最大 2 回 × 60秒天井 ≒ 数分）でも、`withPrisma` の接続 17 回分（1〜2分程度）でも
  **説明できない**。24 分の差を作れるのは実行環境側の要因（他エージェントのビルド / テストとの競合）だけである。
  実際 `impl-p3a-notes` §4.4 は「(a) dev DB / (b) port 3000 残留 / (c) 同時実行」を要因として挙げている。
- **本レビューはさらに一歩進めて次を指摘する: 29.0m / 4 flaky という基準値そのものが、
  競合下で取られた値であり、スイートの性質を表していない可能性が高い。**
  したがって「4 → 0 になった」も「29.0m → 4.9m になった」も、**どちらも比較として成立しない。**
- **結論**: `withPrisma` 変更の効果は**未検証のまま**である。基準値は I-7 / S-A9 の予定どおり
  **CI（GitHub Actions / 専有ランナー / workers:1）で取り直すこと。** 本レビューは追加作業を求めない
  （P3-b の最初の CI 実行で確認する、という既定の計画で足りる）。

---

# 6. 観点E — 退行チェック

| P2 / P2.5 / P3-a で Approve した性質 | 確認方法 | 判定 |
|---|---|---|
| `resolveClientIp` の fail-closed と有界性 | `lib/http-guard.ts` **無変更**（全文を読み、`trusted:false` の既定・IP リテラル検証・長さ上限 45 が現存）| ✅ **かつ、呼び出し側が `trusted` を捨てる欠陥が解消された**（前回の唯一の ⚠️ が解消）|
| `timingSafeEqual` の長さ先弾き | `lib/cron-auth.ts:39-43` 無変更 / `lib/form-session.ts:128-131` が**同じ形へ揃った** | ✅ **強化された** |
| login-guard の意味論（SEC-030 の是正）| `lib/login-guard.ts` 無変更（`:129-142` を読み、`trusted && !gate.success` が現存）| ✅ |
| Tier 表の応答（B=403+challenge / C=202 / D=429+Retry-After）| `lib/public-guard.ts:164` / `:167` / `:170-174` 無変更 | ✅ |
| `reset-on-success` / `cleanSource` / 予約枠を公開経路に持ち込まない | `grep` 一致 0 件（コメントのみ）| ✅ |
| 本体 throw 時の `release` | `:301-305` の `finally` 無変更。`public-guard.test.ts` の既存契約は green | ✅ |
| ログに生 IP / `sid` を出さない | `deny` は `keyHash`（sha256 先頭8文字）のみ（`:209-211`）。例外経路も軸名を足しただけで生値は出さない | ✅ |
| 変更系ハンドラがラッパ経由 | `api-route-guard-coverage.test.ts` が**強化**され、admin 4ルート 5メソッドが新 assert を通過 | ✅ **強化された** |
| `@/auth` に依存しない公開ラッパ（SEC-037）| `lib/public-guard.ts` の import は `node:crypto` / `http-guard` / `rate-limit` / `semaphore` のみ | ✅ |
| CSP / `force-dynamic` / `lib/csp.ts` / `middleware.ts` / `app/layout.tsx` | **無変更**（本修正の対象外）| ✅ |
| unit 317（既存分）/ integration 28 | オーケストレーター実測 359（= 317 + 42）/ 28 全パス | ✅ 退行 0 |
| E2E | オーケストレーター/Impl 実測 **0 failed** | ✅（**本レビューの独立検証ではない**）|

**退行は検出されなかった。** 前回 ⚠️ を付けた 1 件（`resolveClientIp` の呼び出し側）は解消している。

---

# 7. スコープ遵守

| 確認項目 | 実測 | 判定 |
|---|---|---|
| `lib/http-guard.ts` 無変更 | 全文を読み、監査が確認した内容と一致 | ✅ |
| スコープ外（SEC-044 / 045 / 046 / 048〜051 / RV-P3A-002・004〜012）に着手していない | `lib/kv.ts` / `lib/env.ts` / `auth.ts` / `lib/rate-limit.ts` / `lib/csp.ts` に本修正由来の変更なし | ✅ |
| マイグレーション作成なし | `prisma/migrations` に追加なし | ✅ |
| `it.skip` の追加 | 0 件 | ✅ |
| 実装コードの変更範囲 | `lib/public-guard.ts` / `lib/form-session.ts` / `playwright.config.ts` の 3 ファイルのみ | ✅ 最小 |

**スコープ逸脱は無い。**

---

# 8. 良い点（記録に残す）

1. **型の継ぎ目を「実際に落ちること」で検証した**（Impl §1「型の継ぎ目が実際に効くことの独立検証」）。
   再発経路そのものを書いた一時ファイルを作って `pnpm type-check` を走らせ、TS2345 / TS2322 を実測し、
   削除後に 0 へ戻ることまで確認している。**「型を書いた」ではなく「型が落とすことを見た」**という
   差は大きく、本プロジェクトが繰り返してきた「green を根拠にした過大報告」の逆をいっている。
2. **`@ts-expect-error` を「赤にならないことが証明になる」形で使った**（Test Agent の設計）。
   緩い実装を書くと TS2578 で落ちる。**型検査を forcing function にする手法**として、
   本リポジトリの資産にする価値がある。
3. **`try/catch` で `RangeError` を握り潰す安易な修正を明示的に却下し、理由を書いた**
   （`lib/form-session.ts:127`）。構造テストで再発を禁止したのも正しい。
4. **例外由来の Tier B とログの扱いを分離した**（応答は完全一致、サーバー側の観測だけ `formSession-error` で区別）。
   秘匿と診断可能性のトレードオフを、正しい側に倒している。
5. **`admin-authz.spec.ts` の変更で「flaky が消えた」と主張しなかった**（§5 の但し書き / §6-2）。
   6倍の高速化を成果として持ち出さず、負荷条件の違いを自分から挙げている。
   **前回レビューが最も評価した性質（I-7）が維持されている。**
6. **`sourceAxisFor` の外側に `if (trusted)` を 1 つも置かなかった。** 判定が構造的に 1 箇所にある。
7. **`playwright.config.ts` を Test Agent が意図的に未変更で残した**判断（設定が契約を満たすことを
   誰かが検証する状態を作る）は正しい TDD の適用である。

---

# 9. Security 再監査への申し送り

> **前提**: 本レビューは E2E を実行していない。unit / integration / build も再実行していない。
> **「Senior が Approve したから検証済み」と読み替えないこと。**

| # | 監査者が**自分の実測で**確認すべきこと | 理由 |
|---|---|---|
| **S-B1** | **SEC-043 の再現が起きないこと**。`clientIp: () => ({key:'unknown', trusted:false, source:'unknown'})` で上限超過しても 429 が返らないこと。**併せて、`trusted:true` では従来どおり 429 になること**（ゲートごと消していないこと）| High の是正確認。前回 G-1 と同じ手順で |
| **S-B2** | **RV-P3AF-001**: 毒 Cookie（`formSessionKey` が throw する入力）を N 回送った後、per-source バケットの `remaining` が**減っていない**ことを確認する。減っていなければ本指摘は再現している | 応答は同一でもサーバー側状態が違う。監査は状態まで見ること |
| **S-B3** | **SEC-042 の再現が起きないこと**。`é` / `あ` / 絵文字 / 孤立サロゲートを署名に混ぜた Cookie を `withPublicMutation` 経由で送り、**403 であって 500 でない**こと（G-5 / G-5b の再実行）| High の是正確認 |
| **S-B4** | **SEC-047**: `app/api/` に no-op ローカル定義のプローブルートを一時的に置き、`api-route-guard-coverage.test.ts` が**落ちる**ことを実測（前回は 11/11 green で通過した）。**実行後に必ず削除すること** | 前回は合成ソースの自己検証しか無かった。監査は実ファイルで |
| **S-B5** | `withPublicMutation` のログに生 Cookie / `sid` / 例外メッセージが出ないことを、**logger をスパイして**確認（例外経路 `formSession-error` を含む）| 例外経路が新設された。AC-RL-10 / AC-PII-1 |
| **S-B6** | **縮退構成での fail-closed（条件1'-3）**: `verifyFormSession` 未設定 + `trusted:false` で 403 になること、および `trusted:true` では 403 にならないこと | RV-P3AF-006。正常系を壊していないことの確認を含む |
| **S-B7** | **E2E 合計件数**: 報告に `Running N tests` を必ず添え、**103 であること**を確認する。合計が合わない実行を「全パス」と読まない | RV-P3AF-002 |

---

# 10. 判定のまとめ

## **Approve** / Must Fix **0件** / **P3-b 着手可（無条件）**

前回の差し戻し理由 **RV-P3A-001（Must Fix）は閉じた。** しかも「振る舞いを直す」に留まらず、
**`.key` だけを渡す呼び出しが `pnpm type-check` で落ちる継ぎ目**を 3 箇所に入れ、
それが実際に落ちることを一時ファイルで実測している。SEC-021 → SEC-029 → SEC-030 → SEC-043 と
4 度繰り返した同型の欠陥に対して、**「もう一度警告コメントを書く」以外の手を打った**のは本修正の中心的な成果である。
縮退判定が `sourceAxisFor` 1 箇所に閉じており、呼び出し側に `if (trusted)` が散っていないことも実測で確認した。

**SEC-042 / SEC-047 / RV-P3A-003 も閉じている。** SEC-042 は関数全体を通しで追い、
攻撃者制御下の入力で例外を投げうる箇所が他に無いことを確認した。SEC-047 は判定ロジックを手で展開し、
監査が実測で通過させた形（ローカル no-op 同名関数）が `false` と判定されること、
かつ**その網が合成ソースだけでなく実ルート 4 本に適用されている**ことを確認した。

**正しく記録・留保された事項を理由に差し戻してはいない。** Impl が §6 / §8 で断定を避けた 6 項目
（flaky の解消・非 CI フル実行の未確認・Cookie パーサの未検証・縮退時 Tier B の実経路未通過・
Redis 実体の未検証・E2E 件数差）は、**いずれも判断として妥当**である。特に「6 倍速い実行で緑だったことは
flaky が解消した証拠にならない」という留保は厳密に正しく、本レビューはさらに
**基準値（29.0m / 4 flaky）の側が競合下の測定値であり比較として成立しない**と判定する。

新規指摘 3 件（Should Fix）はいずれも P3-b と並行して処理できる。**RV-P3AF-001**（例外経路で計数が飛ぶ）は
`formSessionKey` を渡す呼び出し元が 0 件のため潜在リスクであり、**P3-b の配線と同時に閉じること**。
**RV-P3AF-002**（E2E 基準値 100 は誤りで、実際は P3-a の時点から 103）は文書の訂正で足りる。
**RV-P3AF-003**（非 CI のフル実行が未実施）は、ゲートコマンドを `CI=1 pnpm test:e2e` に一本化する
のが最も安い解決である。

## 品質ゲートの状態（本レビュー時点。**出典を明記する**）

| ゲート | 状態 | 出典 |
|--------|------|------|
| `pnpm type-check` | ✅ 0 | オーケストレーター独立実測 |
| `pnpm lint` | ✅ 0 | 同上 |
| `pnpm test:unit` | ✅ 28ファイル / **359件** | 同上 |
| `pnpm test:integration` | ✅ 28件 | 同上 |
| `pnpm build` | ✅ 成功（Impl 報告: 全17ルート `ƒ (Dynamic)`）| Impl 報告 |
| `CI=1 pnpm test:e2e` | **101 passed / 0 flaky / 2 skipped / 0 failed（103件）** — **「flaky 0」を成果として読まないこと** | Impl 1回実測 |
| **`pnpm test:e2e`（CI 無し）** | **未実施**（`csp.spec.ts` 単独で 7 passed のみ）| RV-P3AF-003 |
| E2E 合計件数 | **103**（8ファイル）| **本レビュー独立実測（`--list`）** |
| Senior Review | ✅ **Approve**（Must Fix 0）| 本文書 |
| Security 再監査 | 未実施（§9 の S-B1〜B7 を入力とすること）| — |

## P3-b 着手時に必ず読むもの

1. **RV-P3AF-006** — 縮退構成では `verifyFormSession` 未配線の公開ルートが全リクエスト 403 になる。
   **`/apply` の Cookie 発行と `POST /api/applications` の検証を同時に配線すること。**
2. **RV-P3AF-001** — `formSessionKey` の例外経路で計数が飛ぶ。配線と同時に閉じる（4行）。
3. **RV-P3A-008** — `rateLimitKey` は `toLowerCase()` する。`sid` はハッシュ済みで渡すこと。
4. **SEC-048** — `withPublicMutation` の `now` にリクエスト由来の値を渡さないこと。
5. **SEC-044 / 045 / 046** — P3-b の完了条件（`p3a-fix-plan` §スコープ外）。
6. **RV-P3A-006** は Security 監査が実 Redis で閉じた可能性が高い（`p3a-fix-plan:8`）。
   **`docs/phase-status.md` を更新してから着手すること**（重複作業を避ける）。
