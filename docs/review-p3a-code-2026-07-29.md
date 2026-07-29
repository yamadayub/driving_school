# コードレビュー: P3-a（レート制限基盤の本番化 + 公開変更系ラッパ + CSP）

## レビュー日: 2026-07-29
## 対象Phase: 実装（CLAUDE.md Phase 7 / Senior Engineer）
## レビュワー: Senior Engineer Agent
## 入力
- `docs/impl-p3a-notes-2026-07-29.md`（§8 申し送り9件 / 【オーケストレーター追記】4）
- `docs/review-p3a-tests-2026-07-29.md`（テスト契約。特に §5.2 / §7 / §9）
- `docs/phase-status.md`「P3-a の完了条件（分割）」(1)(2)
- `docs/functional-spec.md` v0.3.3 §4.11（Tier 表 / AC-RL-1〜15）/ AC-010-13〜16 / AC-PII-1・10
- `docs/tech-stack.md` v0.3.2 §4.5 / §4.6 / §4.7
- `docs/review-p3-design-re2-2026-07-29.md` §D

## レビューで実行したこと / **していないこと**
- **実行した**: 対象コード全 13 ファイルの精読、Lua スクリプト本文とフェイク KV の参照実装との**手による意味論の突き合わせ**、テスト契約行の現存確認、仕様（§4.11 Tier 表 / AC 本文 / §4.7 オリジン表）との一致確認、スコープ逸脱の実測（`prisma/migrations` / `app/api` / Turnstile・Blob 参照の grep）。
- **していない**: `pnpm test:e2e` の実行（オーケストレーターが実行中のため指示どおり禁止）。ユニット / 結合 / type-check / lint / build の再実行（オーケストレーターが独立実測済み）。**したがって E2E に関する記述はすべて他者の実測の引用であり、本レビューの独立検証ではない。**

---

# 総合評価: **Request Changes**

| 区分 | 件数 |
|------|------|
| **Must Fix** | **1**（RV-P3A-001）|
| Should Fix | 5（RV-P3A-002 〜 006）|
| Nice to Have | 6（RV-P3A-007 〜 012）|

## P3-b 着手可否: **条件付きで可**

- **RV-P3A-001（Must Fix）と RV-P3A-003（Should Fix / 文書化された品質ゲートコマンドが赤）を閉じてから P3-b に着手すること。** どちらも修正は小さく、`lib/public-guard.ts` と `tests/e2e/playwright/csp.spec.ts` に閉じる。
- **RV-P3A-006（Lua 実体の実行検証）は P3-b の「完了」条件**とする（着手のブロッカーにはしない）。P3-a には Lua を実行する経路が1本も無く（I-5 / I-6）、リスクは**潜在**である。実際に走り始めるのは P3-b であるため、そこで閉じるのが正しい位置である。
- 上記以外の Should Fix / Nice to Have は P3-b と並行で構わない。

---

# 0. 評価サマリー

## 良い点（記録に残す）

1. **`lib/rate-limit.ts` の既存の穴を実装中に発見し塞いだ**（`consume` が `limit: 0` の limiter で最初の1回を通していた）。指示された範囲の外にある欠陥を、既存 30 件のテストを1行も変えずに閉じている。判定を1本に統合した形（`entry ?? { count: 0 }` → `current.count >= limit`）は素直で、`limit >= 1` の挙動が同一であることがコードから読める。
2. **`finally` による `release`**（`lib/public-guard.ts:230`）。漏れの主因が例外経路であることを理解した配置になっている。
3. **共有軸の枯渇を 202 にし、`challenge` を Tier B の 403 だけに付けている**（`:122` / `:220-223`）。条件1'-1 と契約ルール7（抜けられないループの禁止）の両方が、コード上の分岐として読める形で守られている。
4. **`lib/kv.ts` が判定を一切持たない。** `consume` / `peek` / `reset` を export せず、`increment` は永続化の原子操作に閉じている（AC-RL-8 / RV-P3DR-007）。`INCR` → **`count === 1` のときだけ** `PEXPIRE` になっており、「毎回張り直す＝窓が永久に終わらない」壊れ方を構造的に避けている。
5. **`permitId` = `randomBytes(16)`**（`lib/semaphore.ts:250-252`）。Test 申し送り **T-8**（「暗号論的乱数であることはテストで検証できないのでソースレビューで見よ」）に対する回答として**確認済み**。`Math.random` ではない。
6. **シャード抽選の `rng` とポーリングジッタの `random` を分離**（`:207-209` / `:241`）。テスト §7-3 の規約を、理由付きのコメントで残している。
7. **秒 → ms の変換が `semaphoreTtlMs()` 1関数に閉じている**（RV-P3DR2-004）。しかも「関係式テストは秒同士しか見ないためこの事故を検出しない」という**テストの限界そのもの**がコメントに書かれている（`:68`）。
8. **E2E でしか捕まらない欠陥（`/schools` の静的プリレンダリングによる白紙化）を実測で特定し、原因（nonce を持てない静的 HTML → `self.__next_f` 未定義 → React が DOM を空にする）まで詰めて直している。** ユニット 317 件・type-check・lint・build がすべて green の状態で壊れていた事例であり、この記録自体が資産である。
9. **flaky 4件を「環境のせい」と確定していない**（§6.6 / I-7）。単独再実行が green であることを「単独なら通ることしか示していない」と正しく限定し、「0 と報告してはならない」と明記した。**この誠実さは本レビューが最も高く評価する点である**（本プロジェクトの過去3回の失敗はいずれも「green を根拠にした過大報告」だった）。
10. **Lua スクリプト本体を、レビュワーが手で参照実装と突き合わせられる形に保っている。** 実際に突き合わせた結果は §1.1 に記す。

## 総評

**実装の水準は高い。** 契約テストが要求した機構（ZSET リース / Lua 1本の原子性 / power of two choices / 待機中の候補再抽選 / `permitId` 呼び出し側生成 / 時刻注入）は**すべて設計どおりに入っており、代替の抜け道を取っていない**。旧機構の欠陥1（継続負荷下で回復しない）・欠陥2（上限の2倍超過）の再発も、コード上の構造として再現しない形になっている（§1.1）。

差し戻しの理由は**1点のみ**である。`lib/public-guard.ts` が `resolveClientIp()` の `trusted` を捨てており、これが `lib/http-guard.ts:93-94` に**そのファイル自身のコメントとして明記された禁止事項**に正面から抵触する。P2.5 で一度実測して直した SEC-030 と同型の欠陥が、母数が桁違いに大きい公開経路に入っている。

---

# 1. 実装の正しさ（観点 A）

## 1.1 `lib/semaphore.ts` — 設計どおり。Lua も参照実装と意味論が一致する

### Lua の突き合わせ（本レビューが手で行った独立確認）

`lib/semaphore.ts:117-137` の `SEMAPHORE_ACQUIRE_LUA` と、`tests/unit/helpers/fake-kv.ts:196-218` の `referenceRunner` を1手順ずつ突き合わせた。

| 手順 | Lua | 参照実装 | 一致 |
|------|-----|---------|------|
| 期限切れ掃除 | `ZREMRANGEBYSCORE KEYS[1] '-inf' now`（`KEYS[2]` があれば同じく）| 各 key について `score <= now` を削除 | ✅ **`-inf`〜`now` は閉区間＝ `score <= now`** で境界の扱いも一致 |
| 候補選択 | `bestCount = ZCARD KEYS[1]` → `otherCount < bestCount` のときだけ乗り換え | `size < chosen.size` のときだけ乗り換え | ✅ **同数なら `KEYS[1]`** が両者で一致（`<` であって `<=` でない）|
| 上限判定 | `if bestCount >= perShardLimit then return nil` | `if size >= perShardLimit return null` | ✅ 比較演算子・向きとも一致 |
| 追加 | `ZADD bestKey (now + ttlMs) permitId` | `set(permitId, now + ttlMs)` | ✅ |
| 戻り値 | `{ bestKey, permitId }` | `[chosen, permitId]` | ✅ |
| `KEYS[2]` 不在 | `if otherKey then` で分岐（`shards === 1` は KEYS 1本）| `keys.slice(1)` が空 | ✅ |
| 時刻 | `TIME` を読まず `ARGV[1]` | 同 | ✅ AC-RL-11 |

**掃除より前に分岐が無い**（1行目の `ZREMRANGEBYSCORE` の前に `if` が存在しない）ことも確認した。`KEYS[2]` 側の掃除が `if otherKey then` の内側にあるのは「間引き」ではなく「候補が1本か2本か」の分岐であり、Impl の §2.1 の説明は正しい。

**旧機構の欠陥の再発を、コードの構造として確認した**:
- **欠陥1（継続負荷下で恒久枯渇）**: 回復の責任がキーの TTL ではなく各 member の `score` にあり、`ZREMRANGEBYSCORE` が**すべての `acquire`（失敗パスを含む）で無条件に**走る。キー単位の `EXPIRE` はソースに1つも存在しない（`grep -n 'expire' lib/semaphore.ts` の一致はコメントのみ）。**構造上、再発しない。**
- **欠陥2（上限の2倍超過）**: 掃除・判定・追加が1本の `EVAL` に閉じており、`createKvSemaphoreStore.acquire` は `client.eval` を1回呼ぶだけで `ZADD` → `ZCARD` → 自分を `ZREM` する楽観方式の痕跡が無い。`EXPIRE ... NX` も無い。**構造上、再発しない。**

> **⚠️ この突き合わせが担保するもの／しないもの**: 本レビューが行ったのは**人間（エージェント）による静的な意味論の照合**であり、**Lua を実行した検証ではない**。「Lua のパーサが期待どおりにこの文字列を解釈すること」「`redis.call` に渡す数値の文字列化が想定どおりであること」は確認していない。**「Senior が読んだから Lua は正しい」と報告してはならない**（I-1 の警告はそのまま有効である）。**実行による検証は RV-P3A-006 として要求する。**

### その他の確認

- `permitId`: `randomBytes(16).toString('hex')` = 128bit。**T-8 をクローズ**。
- TTL の導出: `SEMAPHORE_TTL_SEC = PUBLIC_HANDLER_MAX_DURATION_SEC * 2`（`:50`）。片方だけ変えると落ちる関係が**コードの式**として存在する（文書の記述ではない）。AC-RL-15(a) を満たす。
- シャード: `sem:{applications}:0..3`（`:97`）。ハッシュタグにエンドポイント名。`sem:<endpoint>:{0..3}` の禁止形ではない。AC-010-13(b) / RV-P3DR2-006 と一致。
- power of two choices（`:277-283`）: `first = min(len-1, floor(r1*len))` / `second = min(len-2, floor(r2*(len-1)))` / `second >= first → +1`。`shards=2` を手で展開して重複が出ないことを確認した。`rng()===1` の境界も `Math.min` で潰してある。**抽選が `acquire` の内側で毎回行われている**（`:292`）ため RV-P3DR2-003 を満たす。
- `now` の注入: `acquire({ now })` / `acquireWithWait({ now: () => number })` の両方で呼び出し側が渡す。Lua も `ARGV[1]`。✅
- `acquireWithWait` の打ち切り（`:311-315`）: `remaining < SEMAPHORE_POLL_MIN_MS` で break し、`sleep` も `Math.min(poll, remaining)` で頭打ち。`elapsed=1900` のとき `sleep(100)` → ちょうど 2000 で、`waitedMs <= 2000` が破れない。境界を手で追って確認した。

## 1.2 `lib/public-guard.ts` — **`trusted` の取りこぼしが1件（Must Fix）**。それ以外は契約どおり

評価順序（`:171-232`）は `Origin → Content-Type → Tier D → Tier B → Tier C → 本体` で、AC-RL-7 の `Origin → Content-Type → レート制限 → 本体` と、Tier 表・契約ルールの要求をすべて満たす。

| 契約 | 実装 | 判定 |
|------|------|------|
| Tier B = `403 { challenge: "interactive" }` のみ | `:44` `:122` | ✅ |
| Tier C = `202 { retryAfterMs }`、`Retry-After` を付けない | `:125` | ✅ |
| Tier D = `429 { retryAfterMs }` + `Retry-After` | `:128-132` | ✅ |
| Origin 失敗の 403 に `challenge` を付けない（ルール7）| `:112` `:173` | ✅ |
| 共有軸の枯渇で 429 を返さない（条件1'-1 / ルール2）| `:220-223` が 202 を返す | ✅ **セマフォ由来については** |
| 本体が throw しても `release` | `:228-232` | ✅ |
| `reset-on-success` を持ち込まない | `consume` のみ。`reset` の呼び出し 0 件 | ✅ AC-RL-2 / AC-010-16 |
| `cleanSource` / 予約枠を持ち込まない | 語がソースに存在しない | ✅ SEC-041 |
| ログに生 IP / `sid` を出さない | `:138-140` `:168`（`keyHash` = sha256 先頭8文字）| ✅ AC-RL-10 / AC-PII-1 |
| `@/auth` に依存しない | import に無い | ✅ SEC-037 |
| ジッタ ±20% / テスト用フックが本番で無効 | `:62-72` | ✅（下記の注記あり）|

`jitteredRetryAfterMs` の実装が `Math.min(jittered, 1000 + floor(random()*1001))` の形（固定値への置換ではない）になっているのは正しい判断である。単純に固定値へ置き換えると、基準値 1,000ms に対する ±20%（AC-RL-12(c)）が CI 環境で破れる。

**唯一の欠陥は RV-P3A-001（下記）である。**

## 1.3 `lib/kv.ts` — 契約どおり。ただし往復コストの判断を1つ確認したい

- `INCR` → `count === 1` のときだけ `PEXPIRE`（`:103-109`）。**毎回張り直していない。** ✅
- 判定ロジックを持たない（`consume` / `peek` / `reset` を export しない）。✅ AC-RL-8
- 件数上限退避を持たない。✅ AC-010-12 / SEC-031
- 真実源コメントに `lib/rate-limit.ts` と `SemaphoreStore` を明記（`:7` `:11`）。✅

**「KV 側のウィンドウ起点を `windowMs` 境界に整列した固定ウィンドウにした」という意図的差異（Impl §2.2）は妥当である。** `PTTL` から `resetAt` を復元する方式は、Impl が書いているとおり「2回目以降も `PEXPIRE` を張り直す」誘惑を生む。整列固定ウィンドウなら `now` だけから `resetAt` が決まり、往復を増やさずに済む。**受容してよい差異**であり、理由がファイル冒頭に書かれている点も適切である。

**ただし `:113` の `PTTL` は毎リクエスト（2回目以降）走る**。これは Impl のノートに記載が無い。→ RV-P3A-002。

## 1.4 CSP（`lib/csp.ts` / `middleware.ts` / `app/layout.tsx`）

`tech-stack.md` §4.7 のオリジン表との突き合わせ:

| ディレクティブ | §4.7 | 実装（`lib/csp.ts`）| 判定 |
|--------------|------|-------------------|------|
| `default-src` | `'self'` | `'self'` | ✅ |
| `script-src` | `'self'` + nonce + Turnstile | 同（+ dev のみ `'unsafe-eval'`）| ✅（下記 RV-P3A-003）|
| `frame-src` | `'self'` + Turnstile | 同 | ✅ |
| `connect-src` | `'self'` + Blob | 同 | ✅ |
| `img-src` | `'self'` `data:` `blob:` | 同 | ✅ |
| `style-src` | `'self'` `'unsafe-inline'` | 同 | ✅（受容がコメントに明記されている）|
| `object-src` / `base-uri` / `frame-ancestors` / `form-action` | `'none'` / `'self'` / `'none'` / `'self'` | 同 | ✅ |
| **`font-src`** | **表に無い** | **`'self'` `data:`** | ⚠️ **表に無い追加** → RV-P3A-004 |

### `force-dynamic` をルートレイアウトに置いた判断について — **是**

**この判断は支持する。** 根拠:

1. **必要性が実測で示されている。** `/schools` が静的のまま残っており、nonce を持てず inline script が全滅して白紙化した。`tech-stack.md` §4.7 の「P1 で既に force-dynamic 採用済みなので追加の代償は無い」が**文書と実態の乖離**だったことを実測で暴いた点は、むしろ本プロジェクトが最も必要としている種類の作業である。
2. **代替案は劣る。** ページごとに `force-dynamic` を撒く案は、新規ページを足した人が忘れた瞬間に**無言で白紙化する**（ビルド・型検査・lint すべて通る）。`'strict-dynamic'` + ハッシュ方式は Next.js の RSC フライトデータには適用しにくい。**集約は正しい。**
3. **副作用は本プロジェクトでは実質ゼロ。** 全ページが DB 依存で `force-dynamic` 前提の設計であり、CDN キャッシュ戦略も未導入。増えるのは `/_not-found` の動的レンダリング1件で、無視できる。

**ただし I-9 のとおり構造的な歯止めが無い。** → RV-P3A-005（安価な追加を要求する）。

### `middleware.ts` のセッション照会を `/admin` 限定にした判断 — **是**

matcher を全ページへ広げつつ `auth()` を `/admin` に限定したのは正しい。公開ページ全リクエストに NextAuth のセッション照会（JWT 復号）を乗せる理由が無い。`x-middleware-next` の有無で「素通り」を判別し、素通りのときだけ nonce 付きリクエストヘッダを載せ直す実装（`:48-57`）も、載せ直さないと管理画面のスクリプトが全滅するという理由が正しい。→ 派生の軽微な指摘は RV-P3A-007。

---

# 2. 指摘事項

## [RV-P3A-001] `withPublicMutation` が `resolveClientIp()` の `trusted` を捨てている

- **種別**: Bug / Security
- **重要度**: **Must Fix**
- **場所**: `lib/public-guard.ts:186-192`（`clientIp` の既定値は `:165`、型は `:109`）
- **関連**: `lib/http-guard.ts:86-94` / §4.11「軸の分類と用途」/ Tier 表 契約ルール2 / AC-RL-1 条件1'-1 / SEC-030

### 現状

```ts
// lib/public-guard.ts:109
clientIp?: (request: Request) => { key: string; trusted: boolean }
...
// lib/public-guard.ts:186-192
if (limiters?.source) {
  axes.push({
    axis: 'source',
    limiter: limiters.source,
    key: rateLimitKey(`${endpoint}:`, clientIp(request).key),   // ← trusted を読んでいない
  })
}
for (const { axis, limiter, key } of axes) {
  const result = await limiter.consume(key, at)
  if (!result.success) {
    deny('D', axis, key)
    return TIER_D(...)                                          // ← 硬いゲート（429）
  }
}
```

`clientIp` の戻り値の型は `{ key, trusted }` を**持っている**のに、`.key` だけを取り出して `trusted` を捨てている。

### なぜ問題か

`resolveClientIp()` は `VERCEL !== '1'`（`next start` の直公開・ローカル・オンプレ・**そして P3-a の E2E 環境**）で **必ず `{ key: 'unknown', trusted: false }`** を返す（`lib/http-guard.ts:108-114`）。このとき:

- `rateLimitKey('applications:', 'unknown')` = `applications:unknown` という**全利用者が共有する単一バケット**になる。
- そのバケットが上限に達すると、**上記の分岐が全員に 429 を返す**。

すなわち **`trusted=false` のとき、発信元軸は「攻撃者自身に閉じた軸」ではなく共有軸である**。共有軸の枯渇を理由に 429 を返すことは、`functional-spec.md` §4.11 が名指しで禁じている:

- **軸の分類表**: 発信元軸の性質は「攻撃者自身に閉じる**（`trusted=true` 時）**」。この括弧が条件である。
- **契約ルール2**: 「共有軸の枯渇のみを理由に `429` を返してはならない」。
- **AC-RL-1 条件1'-1**: 「共有軸の枯渇による拒否がそのままサービス停止になる」ことを避けるのが本条件の目的。

そして `lib/http-guard.ts:93-94` は、**そのファイル自身のコメントで**次のように書いている:

> したがって `key` だけを取り出して `trusted` を捨てる呼び出しは、この防御を無効化する。

これは P2.5-b で **SEC-030 として実測された欠陥**（他者が 10 分で 10 回失敗させるだけで正規管理者が締め出された）への是正としてそこに書かれた文である。同じ形の欠陥が、**母数が管理者1名から公開フォーム利用者全員に変わった経路**に入っている。被害は「管理者1名が10分ログインできない」ではなく「**全利用者が申込できない**」である。

### なぜ「P3-b で見ればよい」ではないか

- `phase-status.md` (2) が P3-b へ送っているのは **AC-RL-3 の3本の結合テスト**（Cookie + Turnstile + 送信間隔の**併用**を実リクエストで確認する）であって、「発信元軸をゲートに使ってよいか」という**ラッパの構造的判断**ではない。後者は `withPublicMutation` の中にあり、**`withPublicMutation` は P3-a の成果物である**。
- 現在のラッパには **`trusted` を反映する継ぎ目が存在しない**。P3-b で `limiters.source` を注入する人が、この分岐を書き換えない限り欠陥はそのまま本番へ出る。
- **テストも `trusted: true` しか流していない**（`tests/unit/public-guard.test.ts:86` / `:343` がともに `trusted: true` を固定注入）。したがって「テストが green だから閉じている」は成立しない。**契約側の穴でもある**（Test Agent 申し送りに無かった）。

### 改善案

`lib/login-guard.ts:139-142` が管理者ログインで採った形（**縮退時は計数のみに使い、照合前ゲートには使わない**）を公開経路にも適用する。

```ts
// lib/public-guard.ts
const resolved = clientIp(request)
if (limiters?.source) {
  axes.push({
    axis: 'source',
    limiter: limiters.source,
    key: rateLimitKey(`${endpoint}:`, resolved.key),
    // SEC-030 / §4.11 軸の分類: `trusted=false` の `unknown` バケットは
    // 「攻撃者自身に閉じた軸」ではなく共有軸である。共有軸の枯渇を 429 の根拠に
    // してはならない（契約ルール2 / 条件1'-1）。カウントは進めるが Tier D に落とさない。
    gate: resolved.trusted,
  })
}
for (const { axis, limiter, key, gate } of axes) {
  const result = await limiter.consume(key, at)
  if (!result.success && gate) {
    deny('D', axis, key)
    return TIER_D(jitteredRetryAfterMs(result.retryAfterMs, random))
  }
}
```

`formSession` 軸は `gate: true`（Cookie は攻撃者自身に閉じる）。

**併せてテストを1本足すこと**: `clientIp: () => ({ key: 'unknown', trusted: false })` で上限を超えても **429 にならない**こと。これが無いと同じ欠陥が再び入る。

> **⚠️ 縮退時に発信元軸のゲートが消えることは、防御が弱くなることを意味する。** それは AC-RL-3 が「だから Cookie 軸 + Turnstile + 送信間隔下限の3つを必ず併用する」と定めている理由であり、**その併用は P3-b の担当**である。P3-a で正しいのは「共有軸を硬いゲートにしない」ことまでで、**縮退時の防御を per-source 429 で埋め合わせてはならない**（それが SEC-030 そのものである）。

---

## [RV-P3A-002] `increment` が2回目以降に毎回 `PTTL` を発行している（KV 往復が2倍）

- **種別**: Performance / Design
- **重要度**: Should Fix
- **場所**: `lib/kv.ts:111-115`

### 現状

```ts
if (count === 1) { await client.pexpire(...); return { count, resetAt } }
const ttl = await client.pttl(key)          // ← 2回目以降、毎リクエスト発行される
if (ttl < 0) await client.pexpire(key, ...)
```

### なぜ問題か

- **守っている失敗モード自体は実在する**（`INCR` 成功後・`PEXPIRE` 前に Function インスタンスが落ちると、キーが TTL を持たず窓が永久に終わらない＝正規利用者の恒久締め出し）。**着眼は正しい。**
- しかし対価が「**レート制限を通る全リクエストで KV 往復が 1 → 2 に倍増**」である。`tech-stack.md` §4.5 / AC-010-13 の注記が明記しているとおり、この系で**支配的なコストは HTTP RTT** である。攻撃時には KV コマンド消費（Upstash は従量課金）も倍になる。
- Impl ノート §2.2 に**この往復増の記載が無い**。「`INCR` の戻り値以外に往復を増やさずに `resetAt` を決めるため」に整列固定ウィンドウを選んだと書いてあるのに、実装は別の理由で往復を増やしている。**判断は残してよいが、記録が食い違っている。**

### 改善案

`PEXPIRE key ms NX`（Redis 7 / Upstash 対応）を**無条件に**発行する形にすると、同じ失敗モードを**常に2コマンド**で閉じられる。

```ts
async increment(key, windowMs, now) {
  const count = await client.incr(key)
  const resetAt = windowEndsAt(now, windowMs)
  // `NX` = TTL 未設定のときだけ付ける。**既存の窓を延ばさない**（毎回張り直す壊れ方に落ちない）
  // かつ、INCR 直後に落ちて TTL が欠けたキーも次のヒットで回復する。
  await client.pexpire(key, Math.max(1, resetAt - now), { nx: true })
  return { count, resetAt }
}
```

`resetAt` は `now` から決まる整列境界なので、どのリクエストが張っても同じ値になる（`NX` で誰が勝っても正しい）。`KvRateLimitClient.pttl` は `get` 経路が使うので残す。

**採らない場合でも、往復が2倍になっていることと、その対価として閉じている失敗モードを `lib/kv.ts` のコメントに1行残すこと。**

---

## [RV-P3A-003] `pnpm test:e2e`（`CI` 無し）は `next dev` を起動するため CSP テストが落ちる

- **種別**: Bug（テスト / 開発フロー）
- **重要度**: Should Fix（**ただし P3-b 着手前に閉じること**）
- **場所**: `playwright.config.ts:39` / `middleware.ts:36` / `tests/e2e/playwright/csp.spec.ts:64`

### 現状（コードからの導出。**実行して確認したものではない**——E2E 実行が禁止されているため）

1. `playwright.config.ts:39`: `command: process.env.CI ? 'pnpm start' : 'pnpm dev'`
2. `pnpm dev` = `next dev` → `NODE_ENV=development`
3. `middleware.ts:36`: `allowUnsafeEval: process.env.NODE_ENV !== 'production'` → **true**
4. `lib/csp.ts:53`: `script-src` に `'unsafe-eval'` が入る
5. `csp.spec.ts:64`: `expect(policy['script-src']).not.toContain("'unsafe-eval'")` → **失敗**

### なぜ問題か

`CLAUDE.md`「品質ゲート」4番と `phase-status.md` の完了条件が挙げているコマンドは **`pnpm test:e2e`** である。Impl / オーケストレーターが実行したのは **`CI=1 pnpm test:e2e`** であり、**文書化されたコマンドそのものは誰も通していない**。GitHub Actions は `CI: true` を渡すので CI では緑になるが、**手元で品質ゲートを回した人は原因不明の赤を踏む**。本プロジェクトが繰り返し踏んでいる「文書と実態の乖離」の小型版である。

`'unsafe-eval'` を dev で許すこと自体は妥当（React Refresh に必要／本番では常に無効であることをユニットテストが固定している）。問題はテスト側が dev 環境を想定していないことである。

### 改善案（どちらか）

- **(a)** `csp.spec.ts` の当該 assertion を dev で条件付きにする（理由コメント必須）:
  ```ts
  expect(policy['script-src']).not.toContain("'unsafe-inline'")
  // `'unsafe-eval'` は `next dev`（React Refresh）でのみ許可される。webServer が
  // `pnpm start`（= 本番ビルド）で動くときだけ検証する。本番で無効であることは
  // `tests/unit/...` が別に固定している。
  if (process.env.CI) expect(policy['script-src']).not.toContain("'unsafe-eval'")
  ```
  → ただし「CI でしか本当の検証をしない」ことになるため、**(b) のほうを推す**。
- **(b)** `playwright.config.ts` の `webServer.command` を常に `pnpm start` にする（`reuseExistingServer` はそのまま）。E2E が常に本番ビルドを見ることになり、`/schools` 白紙化のような**本番でしか出ない欠陥を dev 実行で見逃す**経路も同時に塞げる。

---

## [RV-P3A-004] `font-src 'self' data:` が `tech-stack.md` §4.7 のオリジン表に無い

- **種別**: Design / Documentation
- **重要度**: Should Fix
- **場所**: `lib/csp.ts:64`

### 現状

`font-src 'self' data:` を追加しているが、§4.7 の表に `font-src` の行が無い。表に無ければ `default-src 'self'` にフォールバックするのが仕様上の「最終形」である。

`app/globals.css` に `@font-face` も `url(data:` も**存在しない**（grep 一致 0 件）。フォントは OS 標準ゴシックへのフォールバックで、`next/font` は無効化されている（`app/layout.tsx:20-22`）。**`data:` を許可する根拠になる実体が現時点で無い。**

### なぜ問題か

§4.7 が「最終形」と宣言され、`csp.spec.ts` が「後続単位で必要になるオリジンが最終形で入っている」ことを固定している構成の狙いは、**P3-a の監査証跡＝実際に配信されているポリシー**という関係を保つことである。表に無いディレクティブが増えると、その関係が崩れる。

### 改善案

- `data:` を落として `font-src` の行自体を削る（`default-src 'self'` で足りる）。**推奨。**
- または `next/font` を有効化する将来を見越して残すなら、§4.7 の表に `font-src | 'self' data: | P3-a | 理由` の行を足す。**どちらでもよいが、コードと表を一致させること。**

---

## [RV-P3A-005] `force-dynamic` に構造的な歯止めが無い（I-9）

- **種別**: Maintainability / Test
- **重要度**: Should Fix
- **場所**: `app/layout.tsx:37`

### 現状

`export const dynamic = 'force-dynamic'` を外す／ルートレイアウトを差し替えると、静的化されたページだけが**無言で白紙化する**。ビルドも型検査も lint も通る。Impl はコメントで警告しているが（`:24-36`）、テストは無い。

### なぜ問題か

**この欠陥は実際に一度起きており、検出したのは `school-access.spec.ts` 1本だけである**（`csp.spec.ts` は `/` しか開かない = I-8）。コメントは読まれなければ効かない。本プロジェクトは既に「ソース文字列に対する assert」を検出網として使う手法を確立している（`kv-store.test.ts:207-225` の真実源コメント検査、`semaphore.test.ts:272-296` の Lua 構造検査）。同じ手法が 5 行で使える。

### 改善案

```ts
// tests/unit/csp-force-dynamic.test.ts
it('ルートレイアウトが force-dynamic を宣言している（nonce 方式の成立条件）', () => {
  // これが green なら排除される: `force-dynamic` を外す変更。静的プリレンダリングされた
  // ページはリクエストごとの nonce を持てず inline script が全滅し、`self.__next_f` が
  // 未定義のままハイドレーションが失敗して**ページが白紙になる**（実測: /schools）。
  // ビルド・型検査・lint はすべて通るため、この assert が唯一の歯止めである。
  const source = readFileSync(resolve(process.cwd(), 'app/layout.tsx'), 'utf8')
  expect(source).toMatch(/export\s+const\s+dynamic\s*=\s*'force-dynamic'/)
})
```

（より強い形は「ビルド出力に `○` が1件も無い」ことの検査だが、ユニットテストからビルド出力を読むのは重い。上記で費用対効果は十分である。）

---

## [RV-P3A-006] Lua スクリプト本体を**実行して**検証する経路が無い（I-1 / I-3 の実質的な閉じ方）

- **種別**: Test / Design
- **重要度**: Should Fix（**P3-b の完了条件**とする）
- **場所**: `lib/semaphore.ts:117-137`

### 判断の前提

Test 契約 §5.2 は「実 Redis 結合テストを P3-a に足すかは Impl / Senior の判断に委ねる。足さない場合は受容を `docs/security-audit.md` に記録すること」としている。**本レビューはこの受容そのものは支持する**（理由は I-1 の判定表を参照）。**その上で、Test 契約が挙げた却下理由 (a) は、より安価な代替に対しては成立しない**ことを指摘する。

### Test 契約の却下理由の再検討

| 却下理由 | 再検討 |
|---------|--------|
| **(a)** `@upstash/redis` は REST 経由なのでローカルの `redis:7` を直接向けられず `serverless-redis-http` 等のプロキシを CI に足す必要がある | **検証したいのは「クライアント」ではなく「スクリプト文字列」である。** `createKvSemaphoreStore` は `client.eval(script, keys, args)` を素通しするだけなので（`lib/semaphore.ts:182-187`）、`ioredis` / `node-redis` で `redis:7` に直接 `EVAL` を投げれば **同じ文字列の意味論を検証できる**。プロキシは要らない。本リポジトリは既に dev DB を Docker で回している（`scripts/dev-db.sh`）ので、追加コストは devDependency 1つと ~50 行のスクリプトである |
| **(b)** AC-RL-11(e-3)（濃度の最大値）は実 Redis では原理的に観測できない | **正しい。この点は変わらない。** (e-3) はフェイク KV でしか観測できず、その担保は現状のままでよい |

### 検証すべき項目（(b) で観測できないもの以外は全部取れる）

1. `ZCARD` の比較演算子（`>=` / `>` の書き間違い）— **I-1 が名指しした形**。上限ちょうどで `acquire` が失敗すること。
2. 継続負荷下の回収（AC-RL-11(a)）— 満杯固定 → 期限前の `acquire` が全失敗 → 期限経過後に成功。
3. `ZREMRANGEBYSCORE` を削った版で 2. が落ちること — **AC-RL-11(d) / I-3 の「本物の Lua を削った版」**。**これは実 Redis 上でしか行えない**（フェイクは `expectedScript` の同一性で先に throw するため、削った版は「掃除が無いから」ではなく「スクリプトが違うから」落ちる＝**意味のある確認にならない**）。
4. `redis.call` に渡す数値の文字列化（`now + ttlMs` ≈ 1.8e12 が指数表記にならず ZADD の score として正しく解釈されること）。**これはコードレビューでは確認できない**性質である。
5. `KEYS[2]` 不在（`shards=1`）で `if otherKey then` が正しく偽になること。

### 位置づけ

**P3-a のブロッカーにはしない。** P3-a には Lua を実行する経路が1本も存在せず（I-5 / I-6）、`withPublicMutation` へ KV セマフォを注入する配線は P3-b の作業である。**Lua が初めて走るのは P3-b であり、そこで閉じるのが正しい位置である。**

**P3-b の完了条件に加えること**（`phase-status.md` へ追記を推奨）。

---

## [RV-P3A-007] middleware が NextAuth 応答のヘッダを `set-cookie` 以外落としている

- **種別**: Maintainability
- **重要度**: Nice to Have
- **場所**: `middleware.ts:52-57`

素通り時に `NextResponse.next()` を作り直し、`authResponse.headers.getSetCookie()` だけを引き継いでいる。現在 NextAuth がこの経路で設定するのは Cookie だけなので**実害は無い**が、将来 NextAuth がヘッダを足すと**無言で落ちる**。`x-middleware-*` 以外を全部コピーするか、「Cookie 以外は設定されない」という前提をコメントに1行残すこと。

## [RV-P3A-008] `formSession` 軸のキーが `rateLimitKey` で小文字化される

- **種別**: Design
- **重要度**: Nice to Have
- **場所**: `lib/public-guard.ts:196`（`rateLimitKey` の実体は `lib/rate-limit.ts:209-211`）

`rateLimitKey` は `raw.trim().toLowerCase()` を行う。これは IP / メールアドレスの表記ゆれを畳むための正規化であり、**base64url の `sid` のような不透明な資格情報には意味論が合わない**（大文字小文字だけ異なる 2 つの `sid` が同一バケットに落ちる）。実害は無視できる（衝突確率が天文学的に小さく、かつ**緩む方向ではなく厳しくなる方向**）が、P3-b で配線するときは**ハッシュ済みの `sid` を渡す**（もしくは畳まない変種を用意する）のが正しい。I-6 のとおりこの経路は現在1度も実行されていないので、配線時に判断すること。

## [RV-P3A-009] Tier C の基準待ち時間 1,000ms がリテラル直書き

- **種別**: Style / Maintainability
- **重要度**: Nice to Have
- **場所**: `lib/public-guard.ts:222`

`TIER_C(jitteredRetryAfterMs(1_000, random))`。このファイルの他の数値はすべて名前付き定数 + 理由コメントを持っている（`TEST_HOOK_*` / `JITTER_RATIO`）。`SEMAPHORE_MAX_WAIT_MS`（2秒）との関係（「2秒待って駄目だったので、その半分の時間を置いて再送してほしい」なのか別の根拠なのか）が読めない。`TIER_C_BASE_RETRY_AFTER_MS` として理由付きで括り出すこと。

## [RV-P3A-010] ストリーミング応答では本体完了前に `release` される

- **種別**: Design
- **重要度**: Nice to Have
- **場所**: `lib/public-guard.ts:228-232`

`handler` が `Response` を返した時点で `finally` が走る。`Response.json` はボディがバッファ済みなので現状は問題ないが、P3-b 以降でストリーミング応答を返すハンドラを包むと、**ボディが流れ切る前にパーミットが解放される**（＝同時実行数が実態より小さく数えられる）。現時点で到達不能なのでコメント1行で足りる。

## [RV-P3A-011] middleware が `/public` 配下の静的アセットでも起動する

- **種別**: Performance
- **重要度**: Nice to Have
- **場所**: `middleware.ts:70`

matcher は `api` / `_next/static` / `_next/image` / `favicon.ico` / `robots.txt` / `sitemap.xml` を除外しているが、`public/` に置いた画像等（`/og-image.png` 等）には middleware が走り、不要な nonce 生成と CSP 付与が発生する。拡張子ベースの除外（`(?!.*\\.(?:png|jpg|svg|ico|webp|woff2?)$)`）を足せば消える。

## [RV-P3A-012] シャード ZSET キーに保険の `EXPIRE` が無い

- **種別**: Design
- **重要度**: Nice to Have（記録のみ）
- **場所**: `lib/semaphore.ts:117-137`

AC-RL-1 は「キー自体に保険の `EXPIRE` を付けてよいが、パーミット回復の責任を負わせない」としており、**付けないことは仕様違反ではない**。実際、付けないほうが RV-P3DR-001 の壊れ方（キー単位 TTL への逆戻り）を構造的に不可能にするので、**この選択を支持する**。残るのは「トラフィックが完全に止まった後、期限切れ member を抱えた ZSET が最大 3 エンドポイント × 4 シャード = 12 キー残る」ことだけで、無視できる。**指摘ではなく記録である。**

---

# 3. Impl 申し送り 9件への判定（観点 B）

| # | 内容 | 判定 | 根拠と条件 |
|---|------|------|-----------|
| **I-1** | Lua 本体の意味論が未検証。フェイクは参照実装を実行しているだけ | **受容（条件付き）** | **この状態で P3-a を完了としてよい。** 理由: (1) **P3-a には Lua を実行する経路が1本も存在しない**（I-5 / I-6 のとおり配線は P3-b）ので、リスクは潜在であって現実化していない。(2) 3重の歯止め（スクリプト同一性 / 構造 assert / 検出力メタテスト）は「仕様が名指しした壊れ方」（掃除の欠落・順序逆転・間引き・`TIME` の内部取得）を実際に落とす。(3) **本レビューが Lua と参照実装を手で1手順ずつ突き合わせ、意味論が一致することを確認した**（§1.1 の表）。**条件**: ① `docs/security-audit.md` に受容として記録すること（Test 契約 §5.2 の明示条件）。② **RV-P3A-006 を P3-b の完了条件に加えること**。③ **「ユニットが green だから Lua が正しい」と書かないこと**という Impl の警告は**完全に妥当**であり、そのまま維持する。**本レビューの静的突き合わせも「Lua が正しい」の根拠にしてはならない**（実行していないため）|
| **I-2** | 実 Redis 結合テストを足していない。理由 (a) REST プロキシが要る / (b) (e-3) が原理的に観測できない | **部分受容** | **(b) は正しく、変わらない。(a) は成立しない** ——検証対象はクライアントではなくスクリプト文字列であり、`ioredis` で `redis:7` に直接 `EVAL` すれば足りる（RV-P3A-006）。**P3-a では受容してよい**（実行経路が無いため）が、**「REST プロキシが要るから不可能」という理由づけは security-audit.md にそのまま転記しないこと**——事実と異なる制約が文書に残る（P2.5 の教訓3 と同型）。正しくは「**P3-a には実行経路が無いため P3-b へ送った**」である |
| **I-3** | AC-RL-11(d) の手動確認（本物の Lua から `ZREMRANGEBYSCORE` を削った版で (a) が落ちること）は未実施 | **受容。ただし手順の再定義が必要** | **現状の手段では実施しても意味が無い。** フェイク KV は `expectedScript` の同一性で先に throw する（`fake-kv.ts:256-261`）ため、Lua を削った版は「掃除が無いから (a) が落ちた」のではなく「スクリプトが違うから eval が throw した」だけになる。**したがって (d) を「未実施」と記録するのは正しく、Security 監査へそのまま送るのも正しいが、「フェイク KV でやれ」と送ってはならない**——監査者が同じ空振りを踏む。**RV-P3A-006 の実 Redis スクリプト上で行うこと**として再定義し、P3-b の完了条件へ移すこと |
| **I-4** | AC-010-13(c) の実測は未実施（対象ルート不在）。**(a) の結果を「シャード化が効いた証拠」と読み替えないこと** | **受容（完全に妥当）** | 測る対象が無いのは事実であり、`phase-status.md` (1) の AC-010-13 も (a)（`serialize` 非経由）までを P3-a の検証対象としている。**因果の取り違えを自分から警告している点は RV-P3DR2-009 への正しい応答である。** 追加作業不要。**P3-b の完了報告でこの警告を落とさないこと** |
| **I-5** | `createUpstashKvClient` は実接続で動作確認していない | **受容** | 本番 KV インスタンスが無く、P3-a に KV を叩く実経路も無い。`lib/env.ts` の fail-fast が保証するのは「未設定なら起動しない」までであり、「設定値で疎通する」ことではない、という切り分けも正確。**P3-b の作業として引き継ぐ。** 補足: `createUpstashKvClient` は `env.KV_REST_API_URL ?? ''` で空文字を渡しうる（`lib/kv.ts:57-58`）ので、P3-b で配線するときは「本番以外で未設定なら明示的に落とす／インメモリへ落とす」のどちらかを**選んで書く**こと（今は「作れてしまうが呼ぶと壊れる」状態）|
| **I-6** | `limiters.formSession` 軸は実行されるコードパスを持たない | **受容** | 型と分岐は用意したが呼び出し元が無い、という自己申告は正確。**「動く」と報告していない**点が正しい。RV-P3A-008 と併せて P3-b で配線時に判断すること |
| **I-7** | E2E flaky 4件を「環境のせい」と確定できていない | **受容。この扱いが正しい** | **本レビューが最も評価する申し送りである。** ③（単独実行 green）が示すのは「単独なら通る」ことだけ、という限定は厳密に正しい。**flaky の扱い**: (1) **P3-a のブロッカーにはしない**——4件はいずれも P3-a が触っていない既存スペック（トップページ表示 / お知らせ CRUD）で、失敗は全てタイムアウトであり assertion 不一致ではない。決定的な退行を示す証拠が無い。(2) **「0 failed」と報告してよいが「flaky 0」と報告してはならない**——Impl の指示どおり **97 passed / 4 flaky / 2 skipped / 0 failed** の形で記録すること。(3) **CI（GitHub Actions / workers:1）でフルスイートを1回流し、flaky が出ないことを確認する**のが次の検証である、という Impl の提案を採用し、**P3-b 着手時の最初の CI 実行で確認する**（P3-a のブロッカーにはしない）。(4) `admin-news:108` の失敗モードが3回とも異なる（60秒タイムアウト → 2.9秒でページ閉塞 → 12.3秒で成功）ことは、**負荷依存の脆い経路が実在する可能性**を否定しない。**P3-b で E2E が増えたときに再発したら、そこで実装を疑うこと** |
| **I-8** | CSP のブラウザ検証は `/` のみ。`/schools` 白紙化を捕まえたのは `school-access.spec.ts` | **受容。ただし RV-P3A-005 で一部を構造化する** | 指摘は正確で、`phase-status.md` (2) の「P3-b で `/apply` に切替」とも整合する。**「CSP は csp.spec.ts で担保されている」と読み替えるな**という警告は妥当。**追加作業**: 白紙化の根本原因（静的化）については RV-P3A-005 のソース assert で歯止めを作れるので、そちらで塞ぐ。ページ横断の CSP 違反検証は P3-b で `/apply` を足すときに**対象を配列にして回す**形へ広げること |
| **I-9** | `force-dynamic` を外すと静的化されたページだけが無言で壊れる。構造的な歯止めが無い | **追加作業が必要（RV-P3A-005 / Should Fix）** | 自己申告は正確。**コメントは読まれなければ効かない**し、この欠陥は既に一度起きている。本プロジェクトが確立済みの「ソース文字列に対する assert」で 5 行で塞げる。**費用対効果が明白なので受容せず追加を求める** |

---

# 4. テスト側の修正の妥当性（観点 C）

**4件すべて妥当と判定する。** assertion（契約）の変更は無い。

| ファイル | 変更 | 判定 | 根拠 |
|---------|------|------|------|
| `tests/unit/public-guard.test.ts:369,384` | `Object.defineProperty(process.env,'NODE_ENV')` → `vi.stubEnv` / `vi.unstubAllEnvs` | **妥当** | Node 20 の `process.env` は `configurable/writable/enumerable` なデータ記述子しか受け付けず、`Object.defineProperty` は**値によらず常に throw** する。したがって「当該2件は assertion に到達すらしていなかった」という Impl の説明は Node の仕様と整合する。`vi.stubEnv('NODE_ENV', …)` は `process.env.NODE_ENV` を実際に書き換えるので、`isTestRetryAfterHookEnabled()`（`lib/public-guard.ts:71` が `process.env.NODE_ENV` を読む）に**効く**。assertion（`toBeLessThanOrEqual(2_000)` / `toBeGreaterThan(2_000)`）は無変更で現存。**これは「落ちるテストを通した」のではなく「一度も実行されていなかったテストを実行できるようにした」変更である。** ⚠️ **むしろ重要なのは、この2件が P3-a 以前から空振りしていた可能性**である（同じ書き方が既存テストに無いか、P3-b で1度確認することを推奨）|
| `tests/e2e/playwright/csp.spec.ts:140-141` | `networkidle` → `load` + 1秒 | **妥当** | **対照実験の設計が正しい。** middleware の matcher を P3-a 以前の `['/admin/:path*']` に戻して**保留リクエストの一覧・件数・タイムアウトが完全に同一に再現した**ことは、非因果性の確立として十分である（変数を1つだけ戻して結果が変わらないことを見る、正しい切り分け）。`networkidle` は Playwright 公式が非推奨としており、未実装リンク（`/news` `/faq` `/apply` `/news/[id]`）への RSC プリフェッチが保留し続けるのも Next.js `<Link>` の既知の性質と整合する。assertion（`violations` が空）は無変更。**検出力は落ちていないが上限も上がっていない**という Impl の限定（I-8）も正確 |
| `tests/unit/kv-store.test.ts:108,149` | `as Record<...>` → `as unknown as Record<...>` | **妥当** | 純粋に型レベルの回避（TS2352）。`createKvRateLimitStore` が具体型を返すようになった結果であり、**実行時の挙動は1ビットも変わらない**。assertion（`consume`/`peek`/`reset`/`size`/`maxEntries` が `undefined`）は無変更で現存 |
| `tests/unit/env.test.ts` | 本番成功ケース2件に `P3A_REQUIRED` を追加 | **妥当** | AC-010-10 が「本番で KV 等が未設定なら throw」を要求した以上、「production + AUTH_SECRET だけで成功する」という旧前提は**仕様変更によって偽になった**。当該 describe の検証対象は SEC-013（AUTH_SECRET の長さ境界）であり、他キーを満たした土台の上で境界値を見る形にするのは**検証対象を1つに保つ正しい変更**である。**throw を期待する3ケースが未変更**であることはオーケストレーターが独立に確認済み（§4.2）|

## テスト変更の**開示**について

オーケストレーター §4.2 の指摘（「3件とも契約を緩めていないが、開示が無かったことは問題」）に**同意する**。ただし Impl ノート §5 には**4件すべてが理由付きの表で記載されている**（`public-guard` / `kv-store` / `csp.spec` / `env`）。§4.2 が「開示が無かった」と書いているのは、§4〜§8 が書かれる前の時点で検証したためと思われる。**現在のノートは開示要件を満たしている。** 記録の整合のため、`docs/impl-p3a-notes-2026-07-29.md` の §4.2 に「その後 §5 に記載された」旨を1行足すことを推奨する（文書内で矛盾したまま残さない）。

---

# 5. 退行チェック（観点 D）

| P2 / P2.5 で Approve した性質 | 確認方法 | 判定 |
|---------------------------|---------|------|
| 変更系ハンドラがラッパ経由（`withAdminMutation`）| `tests/unit/api-route-guard-coverage.test.ts` が FS 走査で全 5 ルートを検査し green（オーケストレーター実測 317/317）。`app/api/admin/**` の 4 ルートは無変更 | ✅ |
| `resolveClientIp` の fail-closed と有界性 | `lib/http-guard.ts` **無変更**（変更ファイル一覧に無い）。`client-ip` 15件 / `http-guard` 9件が green | ✅ **ただし呼び出し側で `trusted` が捨てられている → RV-P3A-001** |
| `news-visibility` の述語単一化 | 変更ファイルに含まれず、integration 28/28 green | ✅ |
| `timingSafeEqual` | `lib/cron-auth.ts:39-44` / `lib/form-session.ts:122` の**両方**で使用。長さ差を先に弾く形（`timingSafeEqual` は長さ違いで throw する）も正しい。`lib/password.ts` 8件 green | ✅ |
| login-guard の意味論（SEC-030 の是正） | `lib/login-guard.ts` / `auth.ts` **無変更**。`login-guard` 31件 green | ✅ |
| force-dynamic ビルド | 全 17 ルートが `ƒ (Dynamic)`（`/_not-found` `/schools` を含む）＝ **むしろ強化された** | ✅ |
| `createMemoryRateLimitStore` のメモリ有界性（SEC-023）| `evictFor` に「未達バケットで空きが作れない場合に限り上限到達バケットを退避」する第3段（`lib/rate-limit.ts:172-178`）が追加されており、**SEC-041 の保護を優先しつつ有界性は必ず守る**形になっている。手で追って、`entries.size < maxEntries` に必ず収束することを確認した | ✅ **良い実装** |
| `rate-limit` の既存 30 件 | 無変更で green（`consume` の判定統合が `limit >= 1` で挙動同一であることの実証）| ✅ |
| **CSP 導入で管理画面・公開ページの挙動が変わっていないか** | **本レビューは E2E を実行していない**（禁止）。Impl 報告と オーケストレーター独立実測（97 passed / 0 failed）に依拠する。`admin-auth` / `admin-authz` / `admin-news` / `school-access` / `top-page` が対象に含まれており、`/schools` 白紙化は**この網が捕まえて修正された**。**独立検証はしていないことを明記する** | ⚠️ **他者の実測に依拠** |

**退行は検出されなかった。** ただし CSP のブラウザ挙動については本レビューは独立検証していない。

---

# 6. スコープ（観点 E）

| 確認項目 | 実測 | 判定 |
|---------|------|------|
| マイグレーション未作成 | `prisma/migrations` は `20260726131256_init` / `20260727104928_news_publish_status` の2件のみ（P3-a 以前から存在）| ✅ 守られている |
| `statusChangedAt` / `sessionIdHash` を参照するコード | grep 一致は `prisma/schema.prisma` のみ（P3 仕様策定時の追加。ドリフトは注記済み）。`lib/` `app/` に一致 0 件 | ✅ |
| `/apply` / `POST /api/applications` / `/api/uploads/**` / `/api/cron/**` | `find app/api -name route.ts` = `auth/` 1 + `admin/news/**` 4 のみ。**公開変更系ルート 0 本** | ✅ |
| Turnstile（P3-b）/ Blob（P3-c）の先取り | コード上の一致は `lib/csp.ts`（**§4.7 が P3-a で最終形投入を要求**）と `lib/env.ts`（**必須化していないことを示すコメント**）のみ。実装コードは無い | ✅ 正しい線引き |
| `it.skip` | 追加 0 件 | ✅ |
| (2)「後続単位で再検証する」条件を「達成」と書いていないか | Impl ノート §9 が構造の存在までを報告している | ✅ |

**スコープ逸脱は無い。** `app/layout.tsx` への `force-dynamic` は全ルートに影響する変更だが、**nonce 方式 CSP（P3-a のスコープ）の成立条件**であり、実測された欠陥への対処である。逸脱ではない。

---

# 7. Security 監査への申し送り（監査者が**自分の実測で**確認すべき項目）

> **前提**: 本レビューは E2E を実行していない。ユニット/結合/build も再実行していない（オーケストレーター実測に依拠）。**「Senior が Approve したから検証済み」と読み替えないこと。**

| # | 監査者が実測すべきこと | 理由 |
|---|---------------------|------|
| **S-A1** | **RV-P3A-001 の修正後**、`clientIp` が `trusted: false` を返す状態で `limiters.source` の上限を超えても **429 が返らない**こと。**修正前に、上限超過で 429 が返ることを1度再現してから**確認すること（修正が効いたことの証明のため） | 本レビューの唯一の Must Fix。SEC-030 と同型で、母数が公開利用者全員 |
| **S-A2** | セマフォの3脅威を**監査者自身のコードで**再現できないこと（`phase-status.md` P3-a 行の要求）: (1) 継続負荷下でのリース回復、(2) `perShardLimit × K` を超えて `acquire` が成功しない、(3) 二重 `release` が他のパーミットを解放しない。**`scripts/verify-semaphore-p3a.ts` を実行するのではなく、監査者が独自に書くこと**（同じ道具で同じ結論に至っても独立検証にならない）| Impl の §7 自己検証は**インメモリのフェイク KV** に対するものであり、オーケストレーター §4.1 が「裏付け文書が無い」と一度記録した経緯もある |
| **S-A3** | **I-1 / I-2 / I-3 の受容を `docs/security-audit.md` に記録する。** 記録する文言は「Lua 本体の意味論は構造 assert と静的レビューまでで担保しており、**実行による検証は P3-b の完了条件（RV-P3A-006）へ送った**」。**「REST プロキシが要るから実 Redis 検証は不可能」と書かないこと**（RV-P3A-006 のとおり事実と異なる）| Test 契約 §5.2 の明示条件。かつ P2.5 教訓3（文書に事実と異なる記述を入れない）|
| **S-A4** | `docs/security-audit.md` に「**ユニットが green だから Lua が正しい**」と読める記述が無いこと。**本レビューの静的突き合わせ（§1.1）も「Lua が正しい」の根拠に使わないこと** | Test 申し送り T-1 / Impl I-1 |
| **S-A5** | `withPublicMutation` のログ出力に生 IP / `sid` / Cookie 値が現れないことを、**監査者自身が logger をスパイして**確認 | AC-PII-1 / AC-RL-10。テストは `keyHash` の形しか見ていない |
| **S-A6** | `CRON_SECRET` 未設定時に `withCronAuth` が **404**（401 でも 500 でもなく）を返すこと、および誤トークンとの応答が**完全に同一**であること | AC-PII-10(c)。削除バッチの所在を晒さない |
| **S-A7** | **本番相当ビルド（`pnpm build && pnpm start`）** で `script-src` に `'unsafe-eval'` が含まれないこと。**`next dev` では含まれる**（意図どおり。RV-P3A-003）ので、監査は必ず `pnpm start` で行うこと | 環境を取り違えると「本番に `unsafe-eval` がある」と誤報告するか、逆に「dev の赤」を欠陥と誤認する |
| **S-A8** | `lib/env.ts` の本番 fail-fast 4キー + `FORM_SESSION_SECRET === AUTH_SECRET` の拒否を、**`parseServerEnv` に直接ソースを渡して**確認（`getServerEnv()` はキャッシュするため、テスト間の汚染に注意）| AC-010-10 / AC-RL-13 / AC-PII-10 |
| **S-A9** | **E2E flaky 4件について**: CI（GitHub Actions / workers:1）でフルスイートを1回流し、flaky が出ないことを確認する。**「4 flaky を 0 と報告しない」**（I-7）| Impl が明示的に次の検証として挙げた項目 |

---

# 8. 判定のまとめ

## **Request Changes**

**差し戻す理由は RV-P3A-001（Must Fix）1点のみである。** `lib/public-guard.ts` が `resolveClientIp()` の `trusted` を捨てており、`trusted=false` の環境で**共有バケットを硬いゲート（429）として使っている**。これは `lib/http-guard.ts:93-94` がそのファイル自身のコメントで禁じている呼び出し方であり、§4.11 の軸分類・契約ルール2・AC-RL-1 条件1'-1 に抵触する。P2.5 で実測して直した SEC-030 と同型の欠陥が、母数が桁違いに大きい公開経路に入っている。テストも `trusted: true` しか流していないため、契約側にも同じ穴がある。

**それ以外の実装は契約どおりであり、水準は高い。** セマフォの機構（ZSET リース / Lua 1本の原子性 / power of two choices / 候補の毎回再抽選 / 128bit `permitId` / 時刻注入）は設計どおりに入っており、旧機構の欠陥1・欠陥2はコードの構造として再現しない。Tier 表の応答は完全に一致し、`reset-on-success` / `cleanSource` は公開経路に持ち込まれていない。`limit: 0` の既存の穴を発見して塞いだこと、E2E でしか出ない `/schools` 白紙化を実測で特定して直したこと、flaky を「環境のせい」と確定しなかったことは、**いずれも本プロジェクトが繰り返してきた失敗の型に対する正しい振る舞い**である。

**正しく記録・受容されたスコープ判断（I-1 / I-2 / I-4 / I-5 / I-6 / I-8）を理由に差し戻してはいない。** 追加作業を求めたのは I-9（RV-P3A-005 / 5行で塞げる）と I-3 の手順の再定義（現状の手段では実施しても意味が無いため）だけである。

## P3-b 着手可否: **条件付きで可**

**着手前に閉じること**:
- **RV-P3A-001**（Must Fix）— `trusted` を反映し、テストを1本足す
- **RV-P3A-003**（Should Fix）— 文書化された品質ゲートコマンド `pnpm test:e2e` が現在赤になる

**P3-b の完了条件へ加えること**:
- **RV-P3A-006** — Lua 本体を実 Redis 上で実行して検証（I-1 / I-3 の実質的な閉じ方）
- **RV-P3A-005** — `force-dynamic` のソース assert（P3-a 中に入れてもよい。5行）

**P3-b と並行で可**: RV-P3A-002 / 004 / 007〜012

## 品質ゲートの状態（本レビュー時点）

| ゲート | 状態 | 出典 |
|--------|------|------|
| `pnpm type-check` | ✅ 0 | オーケストレーター独立実測 |
| `pnpm lint` | ✅ 0 | 同上 |
| `pnpm test:unit` | ✅ 24ファイル / 317件 | 同上 |
| `pnpm test:integration` | ✅ 28件 | 同上 |
| `pnpm build` | ✅ 全17ルート `ƒ (Dynamic)` | 同上 |
| `CI=1 pnpm test:e2e` | 97 passed / **4 flaky** / 2 skipped / **0 failed** | Impl 報告 + オーケストレーター再実測中 |
| **`pnpm test:e2e`（CI 無し）** | ❌ **CSP テストが落ちる** | **RV-P3A-003（コードからの導出。未実行）** |
| Senior Review | ❌ **Request Changes**（Must Fix 1件）| 本文書 |
| Security Audit | 未実施（§7 の申し送りを入力とすること）| — |
