# P2.5 ハードニング — テスト設計（red）レポート

- **日付**: 2026-07-28
- **担当**: Test Agent
- **フェーズ**: P2.5（P3 着手前の必須ハードニング）
- **対象**: SEC-021 / SEC-022 / SEC-023 / SEC-024（＋ RV-P2R-001/002/003/007）
- **参照**: `docs/phase-status.md`「P2.5 ハードニング」/ `docs/security-audit.md`「Phase 2 再監査（2026-07-28）」§C・§E「テストへの申し送り」/ `docs/review-p2-code-re-2026-07-28.md`

> **本書は Impl Agent の実装仕様である。** 追加したテストは全て red であり、
> テストを実装に合わせて緩めることは禁止（契約がコードより優先する）。
> 実装コードは一切変更していない（テストファイルと本書のみ）。

---

## T1. SEC-021 / RV-P2R-001 — 正しい資格情報が拒否されない不変条件

### テストファイル

`tests/unit/login-guard.test.ts`（新規・全 14 ケース）

| 行 | ケース | 検証する契約 |
|----|--------|------------|
| L92 | 第三者が同一アカウントを 10 回失敗させた後でも、正規パスワードのログインは成功する | **SEC-021 の中核不変条件**。他者の失敗回数で正規管理者を締め出さない |
| L119 | 15分ウィンドウをまたいで攻撃を継続しても正規ログインは通り続ける | 「15分ロックを15分ごとに更新する恒久封鎖」の否定 |
| L140 | 本人が自分の IP で 4 回打ち間違えた後でも、正しいパスワードで成功する | アカウント軸の失敗計数を本人の拒否に使わない |
| L158 | 成功後はカウンタが解放され、直後の再ログインも成功する | 成功時の両軸 reset（既存 `auth.ts:117-118` の挙動を保持） |
| L185 | 成功時はアカウント軸のカウンタを進めない（20 回成功しても remaining=limit） | **「失敗のみ計数」** |
| L206 | アカウント軸を使い切った状態でも正しい資格情報は通る（`verified=true`） | **照合前ゲートにアカウント軸を使わない** |
| L227 | メールの大文字小文字・前後空白の違いで計数を回避できない | キー正規化（既存 `auth.ts:80` を維持） |
| L246 | 同一 IP からの誤パスワード連打は IP 軸の上限で拒否される（11 回目 `rate-limited`・`verified=false`） | **ブルートフォース耐性の維持**＋ scrypt を攻撃者に消費させない |
| L271 | 上限に達した攻撃者 IP は、正しいパスワードを当てても通らない | 推測成功の遮断（照合自体を行わない） |
| L293 | IP 軸のウィンドウ経過後は再び試行できる | 恒久ロックにしない |
| L312 | 誤った資格情報はアカウント軸の失敗として計数される（分散攻撃の観測手段） | アカウント軸は「観測用」として残す |
| L331 | アカウント軸が枯渇した状態の誤パスワードは通らない | 拒否理由の呼び分けは問わない（過剰仕様を避ける） |
| L430 | 存在しないアカウントでも照合は実行される | E-012-1 アカウント列挙対策（応答時間均一化）の維持 |
| L444 | 空メールでも例外にならず拒否側に倒れる | 境界値 |

### red である理由（実測）

```
FAIL  tests/unit/login-guard.test.ts [ tests/unit/login-guard.test.ts ]
Error: Cannot find module '@/lib/login-guard' imported from
  '/Users/yosuke/dev/driving_school/tests/unit/login-guard.test.ts'.
 ❯ tests/unit/login-guard.test.ts:3:31
```

`lib/login-guard.ts` が未実装のため import 解決に失敗する（`tests/unit/rate-limit.test.ts` を追加したときと同じ red の形）。
**既存 118 テストは全てパスしたまま**（`Test Files 1 failed | 13 passed (14) / Tests 118 passed`）。

### なぜ `auth.ts` の `authorize` を直接テストしないか

`authorize` は `NextAuth({ providers: [Credentials({ authorize })] })` のオブジェクトリテラル内に
インラインで書かれており export されていない。加えて `auth.ts` の import は `@/lib/db`（Prisma）と
`getServerEnv()` のトップレベル副作用を伴い、単体テストから安全に読み込めない。
したがって **判定の意味論だけを純関数モジュールに切り出す**ことを Impl に要求する
（`lib/rate-limit.ts` が「判定と永続化を分離した」のと同じ方針）。

### Impl が実装すべきシグネチャ（`lib/login-guard.ts` 新規）

```ts
import type { RateLimiter } from '@/lib/rate-limit'

export type LoginOutcome = 'ok' | 'invalid-credentials' | 'rate-limited'

export interface LoginDecision {
  outcome: LoginOutcome
  /** 拒否時の待機時間（ms）。許可時は 0。 */
  retryAfterMs: number
  /** verify() を実際に呼んだか。rate-limited 時は false（scrypt を走らせない）。 */
  verified: boolean
}

export interface LoginGuardLimiters {
  /** 発信元 IP 軸。**照合前ゲート**（コスト保護）に使う唯一の軸。 */
  ip: RateLimiter
  /** アカウント軸。**失敗の計数と観測のみ**。照合前ゲートに使わない（SEC-021）。 */
  account: RateLimiter
  /** キー非依存のグローバル上限（SEC-022 修正方針3）。省略可。 */
  global?: RateLimiter
}

export interface LoginAttemptInput {
  email: string
  ip: string
  now?: number
}

export interface LoginGuard {
  attempt(input: LoginAttemptInput, verify: () => Promise<boolean>): Promise<LoginDecision>
}

export function createLoginGuard(limiters: LoginGuardLimiters): LoginGuard
```

### 要求する処理順序（この順序自体が契約）— **P2.5-b で撤回・改訂済み**

> **撤回（P2.5-b / 2026-07-28, SEC-029 / RV-P25-001）**
> 下記の順序（`global.consume` を `ip` ゲートより前に置く）は**この契約の欠陥**であり、
> SEC-029（単一ホストが全管理者を恒久封鎖できる）の直接原因だった。実装は本契約に忠実だった。
> 併せて 2.→3. の `peek` / `consume` の 2 相も、並行下でゲートが破れる原因だった（RV-P25-003）。
> **現行の契約は `docs/review-p25b-tests-2026-07-28.md` §T1 / §T3 が正**:
> `ip.consume`（判定結果そのものでゲート）→ `global.consume`（枯渇時は失敗履歴の無い発信元だけが
> `globalReserve` から引く）→ `verify()`。以下は履歴として残す。

```
1. global?.consume('credentials:global', now)      → 超過なら rate-limited / verified=false  ← 撤回
2. ip.peek(`credentials:ip:${ip}`, now)            → 超過なら rate-limited / verified=false  ← 撤回
3. ip.consume(`credentials:ip:${ip}`, now)
4. const ok = await verify()                       ← **必ず実行する**（アカウント軸で飛ばさない）
5. ok    → ip.reset / account.reset して outcome='ok', retryAfterMs=0, verified=true
6. !ok   → account.consume(`credentials:email:${normalizedEmail}`, now)
           → outcome='invalid-credentials'（アカウント軸が枯渇済みなら 'rate-limited' でも可）
```

キー書式も契約に含む（テストが limiter の状態を直接検証するため）:

| 軸 | キー |
|----|------|
| IP | `credentials:ip:${ip}` |
| アカウント | `credentials:email:${email.trim().toLowerCase()}` |
| グローバル | `credentials:global` |

### `auth.ts` に要求する変更

- `authorize` から**アカウント軸の照合前 peek ゲートを削除**し（現行 `auth.ts:84-94`）、
  `createLoginGuard` の `attempt` に置き換える。`verify` には既存のダミーハッシュ均一化
  （`auth.ts:101-104`）をそのまま包んで渡す（応答時間均一化は維持すること）。
- 失敗ログの内容（IP・時刻・試行回数のみ）は現行を維持する。

---

## T2. SEC-022 / RV-P2R-003 — キー偽装でレート制限が緩まない

### Vercel で信頼できる IP の出所（調査結果と根拠）

本プロジェクトのホスティングは **Vercel 集約で確定**（`docs/tech-stack.md` §2.1 / 更新履歴 0.2.0、
2026-07-26 ユーザー承認）。Vercel 公式 Request headers リファレンス
（<https://vercel.com/docs/headers/request-headers>, last_updated 2025-12-13）の原文:

| ヘッダ | 公式の記述（要点） | 信頼できるか |
|--------|-------------------|-------------|
| `x-forwarded-for` | "The public IP address of the client that made the request. **If you are trying to use Vercel behind a proxy, we currently overwrite the X-Forwarded-For header and do not forward external IPs. This restriction is in place to prevent IP spoofing.**" | **Vercel 経由なら信頼できる**（プラットフォームが上書きする）。クライアント指定の XFF を通せるのは Enterprise の "Trusted Proxy" 権限を購入した場合のみ |
| `x-vercel-forwarded-for` | "identical to the `x-forwarded-for` header. **However, `x-forwarded-for` could be overwritten if you're using a proxy on top of Vercel.**" | **最も信頼できる**（Vercel の手前に自前プロキシを置いた構成でも汚染されない） |
| `x-real-ip` | "identical to the `x-forwarded-for` header." | Vercel 経由なら信頼できる |

**結論（契約に反映した内容）**

1. 優先順は `x-vercel-forwarded-for` → `x-forwarded-for` → `x-real-ip`。Vercel は単一のクライアント IP を入れるため、複数値なら先頭を採ってよい。
2. これらを信頼してよいのは**信頼できるプロキシ配下で動いていると分かっているときだけ**。判定の既定の根拠は Vercel がシステム環境変数として注入する `VERCEL`（値 `"1"`）。
3. 信頼境界の外（`next start` 直公開・ローカル・オンプレ）では**クライアント申告値を IP として扱わない**。ただし「IP 不明だから無制限」にはせず単一 `unknown` バケットへ寄せ、**制限を緩めない**（SEC-022 修正方針2）。~~この縮退で全員が同一バケットを共有しても、T1 の「成功は常に通す」により正規管理者は締め出されない（SEC-021 付随の指摘が解消される）。~~ **← 誤り。下記の訂正を参照。**

> **訂正（P2.5-b / 2026-07-28, SEC-030 / RV-P25-002）— 上記 3. の取り消し線部分は事実に反していた**
>
> 「成功は常に通す」が適用されていたのは**アカウント軸だけ**で、IP 軸（＝ この `unknown` バケット）は
> 照合前ゲートのままだった。したがって縮退時は、他者が 10 分間に 10 回失敗させるだけで
> 正しいパスワードを持つ管理者が `outcome=rate-limited` / `verified=false` になる。
> 現行実装へ直接投入した実測値: `{"outcome":"rate-limited","retryAfterMs":580000,"verified":false}`。
> 攻撃コストは 10req/10分・管理者メールの知識も不要で、**元の SEC-021（5req/15分 + メール既知）より安い**。
>
> **訂正後の意味論（P2.5-b で実装。真実源は `docs/review-p25b-tests-2026-07-28.md` §T2 の T2-DECISION）**:
> `trusted === false` のとき、IP 軸は**計数を続けるが照合前ゲートには使わない**。
> 共有バケットが枯渇していても `verify()` を実行し、成功なら `ok` を返す。失敗した場合は、
> 枯渇していれば `rate-limited` を返す（緩む方向にも壊さない）。コスト保護はグローバル軸と予約枠が担う。
> `trusted` 既定（`true`）の経路は従来どおり厳格な照合前ゲートのまま。
> 代償として縮退時のブルートフォース耐性はグローバル軸の上限まで低下するため、
> **Vercel 以外へ配置する場合は `trustProxy` の有効化が必須**（`docs/tech-stack.md` §4.5）。
4. 解決結果は**必ず有界**（IP リテラルとして妥当でない値は不採用）。攻撃者が任意長・任意内容の文字列をレート制限キーにする経路を断つ＝ SEC-023 の増幅要因を消す。
5. 「どのヘッダを信頼するか」を `docs/tech-stack.md` に明記すること（SEC-022 修正方針4 / SEC-016 と同根）。**Impl の作業に含める。**

### テストファイル

`tests/unit/client-ip.test.ts`（新規・全 13 ケース）

| 行 | ケース | 検証する契約 |
|----|--------|------------|
| L60 | `trustProxy=false` のとき `x-forwarded-for` を IP として使わない | 信頼境界の外では申告値を採用しない |
| L68 | `trustProxy=false` のとき値を変えても同じキーに寄る | **制限を緩めない**（偽装しても同一バケット） |
| L77 | ヘッダが無くても空文字を返さない | キーが空になるとバケットが壊れる |
| L85 | `x-vercel-forwarded-for` が最優先 | Vercel 手前のプロキシ／攻撃者による XFF 汚染に勝つ |
| L102 | 無ければ `x-forwarded-for` | 優先順位 |
| L111 | 最後に `x-real-ip` | 優先順位 |
| L117 | 複数値なら先頭1件のみ | Vercel は単一 IP を入れる |
| L125 | IPv6 も採用できる | 妥当性検証が IPv6 を落とさない |
| L135 | IP リテラルでない値は不採用 | **出力の有界性** |
| L145 | 超長文字列をキーにできない（≤45 文字） | SEC-023 の増幅を断つ |
| L151 | 空・空白・カンマのみ・巨大値でもキー長が有界 | 境界値 |
| L161 | `VERCEL` 未設定なら既定で信頼しない | **fail-closed** |
| L173 | `VERCEL=1` なら既定で信頼する | Vercel 配下の既定挙動 |
| L188 | XFF を毎回変えても IP 軸の上限に到達する（50回中40回拒否） | **SEC-022 の中核不変条件** |
| L205 | Vercel 配下でも XFF 書き換えで上限を回避できない | `x-vercel-forwarded-for` を真実源にする効果 |

`tests/unit/login-guard.test.ts`（T1 と同ファイル・キー非依存のグローバル上限＝ SEC-022 修正方針3）

| 行 | ケース | 検証する契約 |
|----|--------|------------|
| L356 | IP もメールも毎回変えても、グローバル上限に達したら拒否される | **キー偽装で回避できない最後の防壁** |
| L380 | グローバル上限の拒否では照合を実行しない | scrypt を攻撃者に消費させない |
| L397 | `global` 未指定でも動作する | 既存2軸運用との後方互換 |
| L411 | グローバル上限は成功で解放しない | 全体の流量制御としての意味を保つ |

### red である理由（実測）

```
FAIL  tests/unit/client-ip.test.ts > ... > trustProxy=false のとき x-forwarded-for の値を IP として使わない
TypeError: resolveClientIp is not a function
 ❯ tests/unit/client-ip.test.ts:61:22
```

`lib/http-guard.ts` に `resolveClientIp` が存在しないため、named import が `undefined` になる。
（`login-guard.test.ts` 側のグローバル上限テストは T1 と同じくモジュール未実装で red。）

実測サマリ: `Test Files 2 failed | 13 passed (15) / Tests 15 failed | 118 passed (133)`。
**既存 118 テストは全てパスしたまま。**

### Impl が実装すべきシグネチャ（`lib/http-guard.ts` に追加）

```ts
export type ClientIpSource =
  | 'x-vercel-forwarded-for'
  | 'x-forwarded-for'
  | 'x-real-ip'
  | 'unknown'

export interface ClientIpResolution {
  /** レート制限キーに使う値。信頼できない場合も必ず非空・有界な値を返す（緩めない）。 */
  key: string
  /** 値がプラットフォーム由来か（＝クライアントが偽装できないか）。 */
  trusted: boolean
  source: ClientIpSource
}

export interface ResolveClientIpOptions {
  /** 既定は `process.env.VERCEL === '1'`（未設定なら false＝fail-closed）。 */
  trustProxy?: boolean
}

export function resolveClientIp(
  request: Request,
  options?: ResolveClientIpOptions,
): ClientIpResolution
```

判定規則:

1. `trustProxy` が false → `{ key: 'unknown', trusted: false, source: 'unknown' }` を返す（ヘッダを一切読まない）。
2. true → 上表の優先順でヘッダを読み、先頭のカンマ区切り要素を trim。
3. 値が IPv4 / IPv6 リテラルとして妥当でなければ次の候補へ、全滅なら `unknown`。
4. `key` は常に長さ 1〜45（IPv6 の最大長）に収まること。

### `auth.ts` に要求する変更

- プライベート関数 `clientIp`（`auth.ts:59-63`）を削除し、`resolveClientIp` を使う
  （P3 の申込 / アップロード / チャットで再利用するため、共有モジュールに置く。RV-P2R-003）。
- `LOGIN_GLOBAL_LIMITER` を追加して `createLoginGuard` の `global` に渡す。
  閾値は「正規利用者が到達しない／攻撃の増幅を抑える」水準で Impl が決めてよい（例: 100回/分）。
  決めた値と根拠を実装ノートに残すこと。

### `docs/tech-stack.md` に要求する追記（SEC-022 修正方針4）

- どのヘッダを信頼するか、信頼が成立する前提（Vercel 配下であること）、
  前提が崩れた配置（`next start` 直公開）では IP 軸が `unknown` に縮退することを明記する。

---

## T3. SEC-023 / RV-P2R-002 / RV-P2R-007 — 期限切れの回収・件数上限・並行性

### テストファイル

`tests/unit/rate-limit.test.ts`（既存ファイルへ**追記**・12 ケース追加。既存 15 ケースは無改変）

| 行 | ケース | 検証する契約 | 現状 |
|----|--------|------------|------|
| L278 | ウィンドウ経過後に読み取ると期限切れエントリが store から削除される | **読み取り時の遅延回収** | **red** |
| L294 | 100 キーをウィンドウ経過後に走査すると常駐件数が 0 に戻る | 二度と現れないキーが積み上がらない | **red** |
| L312 | 期限切れでないエントリは削除しない | 回収が正常系を壊さない | green（回帰ガード） |
| L325 | `maxEntries: 5` を指定すると常駐件数が 5 を超えない | **攻撃者制御キーでの無制限増殖の否定** | **red** |
| L336 | 退避しても最新のキーは残る | 直近の攻撃元を取り逃がさない | green（回帰ガード） |
| L348 | `maxEntries` 省略時も有限の既定上限（≤10,000）を持つ | 既定のまま P3 で使われる経路を塞ぐ | **red** |
| L361 | 期限切れエントリが退避の優先対象になる | 退避方針（最も古い `resetAt` から） | green（回帰ガード） |
| L375 | `rateLimitKey` は trim + 小文字化する | 大小文字違いで制限を回避させない | **red** |
| L381 | `rateLimitKey` の出力長は入力によらず有界（≤96） | **キー長の攻撃者制御を断つ** | **red** |
| L388 | 長い入力でも決定的、異なる入力は異なるキー | 衝突で無関係な利用者を巻き添えにしない | **red** |
| L417 | 同一キーへの 20 並行 `consume` の成功は limit 回だけ | **RV-P2R-007（TOCTOU）** | **red** |
| L428 | 並行 `consume` 後のカウンタが limit を超えない | 同上 | **red** |

> green の 3 件は「修正後も壊れてはならない」回帰ガードとして意図的に置いた（退避方針の副作用で
> 直近キーが消える／期限内エントリが消える、という壊し方を検出する）。

### RV-P2R-007（`peek` → `consume` の非アトミック性）の扱い

**テスト可能と判断し、契約化した**（L396-436）。`RateLimitStore` の `get`/`set` に人為的な
`await` 境界（`setTimeout(0)`）を挟んだ store を注入すると、現行の read-modify-write では
20 本の並行 `consume` が全て「上限未満」を読んでから書き込むため**全部通過する**。
実測 `expected 20 to be 5`。KV へ差し替えた瞬間に本質的な TOCTOU になる、というレビューの指摘が
そのまま再現できている。

なお `auth.ts` 側の「`peek` してから `consume` する2相」自体は、T1 の `createLoginGuard` が
IP 軸の `peek`→`consume` を1つの関数に閉じ込めるため、契約としては
「**`RateLimiter` 単体が並行下で上限を守る**」に集約した。呼び出し側の2相を各所でロックする
設計にはしない（P3 で横展開したときに守れないため）。

### red である理由（実測）

```
→ 期限切れを検出したら削除する（読み取り時の遅延回収）: expected [] to include 'credentials:ip:1.2.3.4'
→ 期限切れエントリが常駐し続けてはならない: expected 100 to be +0
→ store.size is not a function
→ rateLimitKey is not a function
→ 並行でも上限を超えて通過してはならない（KV 差し替え時の TOCTOU）: expected 20 to be 5
```

いずれも**構文エラーではなく、契約が満たされていないことによる失敗**である。

### Impl が実装すべき変更（`lib/rate-limit.ts`）

```ts
/** 上限件数付きインメモリ store。超過時は「期限切れ → 最も古い resetAt」の順に退避する。 */
export function createMemoryRateLimitStore(options?: {
  /** 既定 10_000。無制限にはしない。 */
  maxEntries?: number
}): RateLimitStore & {
  /** 現在の常駐件数（テスト・監視用）。 */
  size(): number
}

/**
 * レート制限キーを組み立てる。`raw` は攻撃者が長さも内容も決められる値なので、
 * trim + 小文字化したうえで長すぎる場合は `sha256(raw).slice(0, 32)` に畳む。
 * 出力長は `prefix.length + 64` を超えない。
 */
export function rateLimitKey(prefix: string, raw: string): string
```

加えて `createRateLimiter` 内部で:

1. `currentEntry` が期限切れを検出したら `await store.delete(key)` してから `null` を返す。
2. **同一キーの `consume` を直列化する**（キーごとの Promise チェーン、または
   `RateLimitStore` に任意メソッド `increment?(key, windowMs, now): Promise<RateLimitEntry>` を
   追加し、あれば使う）。KV 実装では `INCR` + `EXPIRE` に落とせる形にしておくこと。
3. `RateLimitStore` の doc に「実装は `resetAt` に対応する TTL を設定**すべき**」と、
   既定インメモリ実装の保持上限を明記する。

### 呼び出し側に要求する変更

- `lib/login-guard.ts` はキー組み立てに `rateLimitKey` を使う
  （`rateLimitKey('credentials:email:', email)` / `rateLimitKey('credentials:ip:', ip)`）。
  T1 のキー書式テストは短い入力なので、畳み込みが起きず従来どおりの文字列になる。
- `lib/kv.ts` に「判定ロジックの真実源は `lib/rate-limit.ts`」の注記を入れる（RV-P2R-008・任意）。

---

## T4. SEC-024 — JSON 管理 API のクロスオリジン拒否（E2E）

### テストファイル

`tests/e2e/playwright/admin-authz.spec.ts`（既存ファイルへ**追記**・`PT2-06` describe を新設、9 ケース追加）

| 行 | ケース | 検証する契約 |
|----|--------|------------|
| L341 | 認証済み × 不正 Origin の `POST /api/admin/news` → 403（DB に作成されない） | SEC-024 の中核 |
| L354 | 認証済み × Origin 欠落の `POST` → 403 | **fail-closed**（`isSameOrigin` の既存方針と同じ） |
| L364 | 認証済み × 同一 Origin の `POST` → **201 で作成される** | **正規経路の非退行** |
| L383 | 認証済み × 不正 Origin の `PUT /api/admin/news/[id]` → 403（title / status が変わらない） | 更新の防御。DB を直接見て確認 |
| L404 | 認証済み × 同一 Origin の `PUT` → **200 で更新される** | **正規経路の非退行** |
| L422 | 認証済み × 不正 Origin の `DELETE /api/admin/news/[id]` → 403（行が残る） | 削除の防御 |
| L437 | 認証済み × 同一 Origin の `DELETE` → **200 で削除される** | **正規経路の非退行** |
| L452 | 同一 Origin でも `Content-Type: text/plain` の `POST` は拒否（400 or 415） | 単純リクエスト化の封じ（SEC-024 修正方針2） |
| L471 | `GET /api/admin/news` はクロスオリジンでも 200 | **参照系まで壊さない**（過剰適用の検出） |

既存の form POST 2本（save / delete）の Origin 検証テスト（`PT2-05`, L140-285）と同じ流儀:
`page.request` でブラウザセッションの Cookie を共有し、`withPrisma` で**実際に副作用が起きたか**を
DB で確認する（HTTP ステータスだけを信用しない）。データ衛生も同じ `CSRF_TITLE_PREFIX` +
ファイル冒頭の `afterAll` に相乗りしている。

### 実測（E2E は実行せず、件数と構文のみ確認）

```
$ pnpm exec playwright test --list
Total: 82 tests in 7 files      # 追加前 73 → +9（PT2-06 の 9 ケース）
```

構文エラー・型エラーなし（`pnpm type-check` で `tests/e2e` からのエラーは 0）。
red の期待: 現在 3ハンドラは `isSameOrigin` を呼んでいないため、クロスオリジンでも 201/200 が返り
副作用が起きる（403 期待が fail する）。`Content-Type` 検証も無いため text/plain の POST が通る。

### Impl が実装すべき変更

1. **共通ラッパを作る**（SEC-024 修正方針3 / P3 前提 B）。手動適用をやめ、変更系は必ずガードを通す。

```ts
// lib/http-guard.ts（または app/api/admin/_guard.ts）
export function withAdminMutation<Ctx>(
  handler: (request: Request, ctx: Ctx) => Promise<Response>,
): (request: Request, ctx: Ctx) => Promise<Response>
// 順序: 認可（未認証 → 401 / form 系は 303）→ Origin 検証（→ 403）→ Content-Type 検証（→ 415）
//       → handler（存在確認 → 検証 → 副作用）
```

2. 適用先は **5 ハンドラすべて**:
   `app/api/admin/news/route.ts` の `POST` /
   `app/api/admin/news/[id]/route.ts` の `PUT`・`DELETE`（`_request` を使うよう引数名を変更）/
   既存の `save`・`delete`（form POST。応答は 303/403 のまま）。
3. `GET`（参照系）にはラッパを適用しない（L471 が過剰適用を検出する）。
4. 既存の PT2-01（未認証 → `[401, 403]`）は認可・Origin のどちらを先に評価しても通る。

---

## まとめ

### 追加したテスト

| ファイル | 種別 | 追加ケース数 | 状態 |
|---------|------|------------|------|
| `tests/unit/login-guard.test.ts`（新規） | unit | 18 | red（モジュール未実装） |
| `tests/unit/client-ip.test.ts`（新規） | unit | 15 | red（`resolveClientIp` 未実装） |
| `tests/unit/rate-limit.test.ts`（追記） | unit | 12 | 9 red / 3 green（回帰ガード） |
| `tests/e2e/playwright/admin-authz.spec.ts`（追記） | e2e | 9 | 未実行（実装後に red の想定） |
| **合計** | | **54** | |

### 品質ゲート実測（2026-07-28）

| コマンド | 結果 |
|---------|------|
| `pnpm test:unit` | `Test Files 3 failed \| 12 passed (15) / Tests 24 failed \| 121 passed (145)` — **既存 118 は全てパスのまま**（新規 green 3 件を含め 121）。`login-guard.test.ts` は import 解決失敗のため 18 ケースが収集されず 145 に含まれない |
| `pnpm test:integration` | `Test Files 5 passed (5) / Tests 28 passed (28)` — **退行なし** |
| `pnpm exec playwright test --list` | `Total: 82 tests in 7 files`（73 → +9）。構文エラーなし |
| `pnpm lint` | `✔ No ESLint warnings or errors` |
| `pnpm type-check` | **8 エラー（すべて意図した red）**。下記はそのまま実装 TODO として使える |

```
tests/unit/client-ip.test.ts(3,10): error TS2305: Module '"@/lib/http-guard"' has no exported member 'resolveClientIp'.
tests/unit/login-guard.test.ts(3,34): error TS2307: Cannot find module '@/lib/login-guard' or its corresponding type declarations.
tests/unit/rate-limit.test.ts(5,3): error TS2724: '"@/lib/rate-limit"' has no exported member named 'rateLimitKey'.
tests/unit/rate-limit.test.ts(326,46): error TS2554: Expected 0 arguments, but got 1.      # createMemoryRateLimitStore({ maxEntries })
tests/unit/rate-limit.test.ts(333,18): error TS2339: Property 'size' does not exist on type 'RateLimitStore'.
tests/unit/rate-limit.test.ts(337,46): error TS2554: Expected 0 arguments, but got 1.
tests/unit/rate-limit.test.ts(356,18): error TS2339: Property 'size' does not exist on type 'RateLimitStore'.
tests/unit/rate-limit.test.ts(362,46): error TS2554: Expected 0 arguments, but got 1.
```

### Impl が作る/変えるもの（一覧）

| 対象 | 変更 |
|------|------|
| `lib/login-guard.ts` | **新規**。`createLoginGuard` / `LoginDecision` / `LoginGuardLimiters`（T1） |
| `lib/http-guard.ts` | `resolveClientIp` / `ClientIpResolution` を追加（T2）、`withAdminMutation` を追加（T4） |
| `lib/rate-limit.ts` | 期限切れの明示削除 / `createMemoryRateLimitStore({maxEntries}) & {size()}` / `rateLimitKey` / 同一キー consume の直列化（T3） |
| `auth.ts` | アカウント軸の照合前 peek ゲートを削除し `createLoginGuard` に置換、`clientIp` を削除して `resolveClientIp` を使用、`LOGIN_GLOBAL_LIMITER` 追加（T1/T2） |
| `app/api/admin/news/route.ts` | `POST` を `withAdminMutation` 経由に（`GET` は対象外）（T4） |
| `app/api/admin/news/[id]/route.ts` | `PUT`・`DELETE` を `withAdminMutation` 経由に（T4） |
| `docs/tech-stack.md` | 信頼するヘッダと信頼境界を明記（T2 / SEC-022 修正方針4） |

### スコープ外（本テストで扱っていないもの）

- **RV-P2R-005**（CI `e2e-test` ジョブの `pnpm build` に `AUTH_SECRET` 未指定）— CI 設定の問題で
  テストで固定する対象ではない。Impl が `.github/workflows/ci.yml` を直す。
- **SEC-023 修正方針3**（本番で store 未注入なら起動時 fail-fast）— 本 Phase では KV 実装が無く、
  fail-fast を入れると現行のデモ運用（インメモリ）が起動しなくなる。**P3 で `lib/kv.ts` を
  `createKvRateLimitStore()` として実装する時点で必須化**すること。`tests/unit/env.test.ts` に
  同型のテストがあるので、そのときはそこに追加する。
- SEC-002（CSP）/ SEC-025〜028 / SEC-014〜020 — P2.5 スコープ外（`docs/phase-status.md`）。
