# P2.5-b テスト契約書（差し戻し修正）

> 作成: 2026-07-28 / 作成者: Test Agent
> 根拠: `docs/p25b-fix-plan-2026-07-28.md`（スコープの正）, `docs/review-p25-code-2026-07-28.md` RV-P25-001/002/003/006,
> `docs/security-audit.md`「P2.5 ハードニング監査」SEC-029 / SEC-030 / SEC-035

## この文書の前提 — 前回、契約の側が間違っていた

P2.5 で Test Agent（私）が書いた契約は実装によって完全に満たされ、全テストが green になった。
**それでも脅威は閉じていなかった。** 攻撃ベクタがアカウント軸からグローバル軸へ移動しただけで、
攻撃コストはむしろ下がっていた（5req/15分 + 管理者メール既知 → 100req/分 + 知識不要）。
旧契約 `docs/review-p25-tests-2026-07-28.md` §T1 は **処理順序 `global.consume → ip.peek` を契約として
明記しており、実装はそれに忠実だった**。問題は実装ではなく契約の側にあった。

したがって本契約では、完了条件を「テストが green になること」ではなく
**「Security が実測した攻撃シナリオが再現しなくなること」** に置く。
各テストには「**これが green なら成立しなくなる攻撃**」を1文で併記し、
説明できないテストは書かない。

---

## T1. SEC-029 / RV-P25-001（Must Fix）— グローバル軸で正規管理者が締め出されない

### 検証する不変条件

> **共有軸（キー非依存のグローバル軸）の枯渇が、正しい資格情報を拒否する理由になってはならない。**

SEC-021 に対して置いた「正しい資格情報が拒否される状態を作らない」を、グローバル軸にも同形で適用する。

### 追加したテスト

ファイル: `tests/unit/login-guard.test.ts`
describe: `SEC-029: createLoginGuard — グローバル軸の枯渇で正規管理者を締め出さない`（L520）
ヘルパ: `createProductionGuard()`（L504。本番の軸設定 `auth.ts:57-59` に対応）

| # | テスト（行） | 検証する契約 | これが green なら成立しなくなる攻撃 |
|---|---|---|---|
| T1-a | `単一 IP から 120 リクエストを投げても、別 IP の正規管理者は正しいパスワードでログインできる`（L521） | 単一 IP の流量ではグローバル軸が枯渇せず、別 IP の正規ログインが `outcome=ok` / `verified=true` | **単一ホストが毎分 100 リクエストを投げるだけで全管理者のログインを恒久封鎖する攻撃**（認証不要・管理者メールの知識も不要）。SEC-029 が実測した手順そのもの |
| T1-b | `IP ゲートで拒否された安価なリクエストはグローバル枠を消費しない`（L554） | グローバル枠の消費回数 == `verify()` の実行回数 == IP 軸の上限（10） | **scrypt を1度も実行しない安価な拒否でグローバルカウンタを進め、単一 IP だけでグローバル枠を使い切る攻撃**。併せて `auth.ts:47-49` の「グローバル上限 = scrypt の CPU 予算」という閾値の根拠を実装と一致させる |
| T1-c | `グローバル軸を移しても流量制御の意味は失われない（攻撃元 IP 自身は依然として制限される）`（L582） | 攻撃元 IP は 11 回目で `rate-limited` / `verified=false` | 「締め出しを直す」名目でゲートを外した場合の **誤パスワード連打による CPU DoS**。※分散攻撃がグローバル軸で止まることは既存テスト `IP が全て異なっても、グローバル上限に達したら拒否される`（L396）が固定 |
| T1-d | `多数の発信元がグローバル枠を使い切っても、失敗履歴の無い発信元からの正しい資格情報は通る`（L609） | グローバル枠 20/20 枯渇状態でも、失敗履歴の無い発信元からの正規ログインが `ok` | **100 以上の発信元（ボットネット / プロキシプール）でグローバル枠を使い切り、正規管理者を締め出す攻撃**。fix-plan 行1 の受け入れ条件「他者がグローバル上限を使い切っても、正しい資格情報でのログインは通る」の literal な充足 |
| T1-e | `予約枠は無制限ではない（枯渇後の新規発信元も、予約枠の分だけしか照合されない）`（L643） | scrypt 総実行回数 == `global.limit + globalReserve.limit` で頭打ち | **予約枠を抜け穴にして、発信元 IP を毎回変えながら無制限に scrypt を実行させる CPU DoS** |
| T1-f | `失敗履歴のある発信元はグローバル枠の枯渇後に予約枠を引けない`（L680） | 失敗履歴のある IP は予約枠の対象外。予約枠は正規管理者に残る | **グローバル枠を使い切った攻撃者が、そのまま予約枠まで食い潰して正規管理者用の余地を消す攻撃** |

### red である理由（実測）

`pnpm vitest run tests/unit/login-guard.test.ts -t 'SEC-029'` → **5 failed / 1 passed**（T1-c のみ green）

```
T1-a  AssertionError: 単一ホストの流量でグローバル軸を枯渇させ、正規管理者を締め出せてはならない（SEC-029）:
      expected 'rate-limited' to be 'ok'
T1-b  AssertionError: 単一 IP がグローバル枠へ寄与できる量は IP 軸の上限（10回/10分）で頭打ちになるべき:
      - Expected 10 / + Received 100
T1-d  AssertionError: 他者がグローバル上限を使い切っても、正しい資格情報でのログインは通る（P2.5-b 受け入れ条件）:
      expected 'rate-limited' to be 'ok'
T1-e  AssertionError: 予約枠 3 件を超えた分は照合前に拒否される:
      - Expected ['invalid-credentials' x3, 'rate-limited' x2]
      + Received ['rate-limited' x5]
T1-f  AssertionError: 予約枠は正規管理者のために残っていなければならない:
      expected 'rate-limited' to be 'ok'
```

T1-a / T1-b の原因は `lib/login-guard.ts:81-84` のグローバル軸 consume が IP ゲート（`:87`）より前にあること。
T1-d / T1-e / T1-f の原因は予約枠（`globalReserve`）が未実装であること。

### Impl が実装すべき変更

1. **`lib/login-guard.ts`: グローバル軸の consume を IP ゲート通過後へ移す**（SEC-029 修正方針1 / RV-P25-001）。
2. **予約枠を追加する**（SEC-029 修正方針2）。API:

```ts
export interface LoginGuardLimiters {
  ip: RateLimiter
  account: RateLimiter
  global?: RateLimiter
  /** グローバル枠の枯渇時に「失敗履歴の無い発信元」だけが引ける予約枠（SEC-029 修正方針2）。 */
  globalReserve?: RateLimiter
}
export const LOGIN_GLOBAL_RESERVE_KEY = 'credentials:global-reserve'
```

3. 判定の骨子（T3 の単相化と同時に満たせる形）:

```ts
// 1) IP 軸の照合前ゲート。consume の判定結果そのものでゲートする（RV-P25-003）。
const gate = await limiters.ip.consume(ipKey, now)
if (!gate.success) return denied(gate.retryAfterMs)

// 「失敗履歴の無い発信元」= この試行の前に IP 軸のカウントが 0 だったこと。
// IP 軸は認証成功で reset されるため、直前に正常ログインできていた利用者も該当する。
const cleanSource = gate.remaining === gate.limit - 1

// 2) キー非依存のグローバル上限は、verify() に到達する試行だけを数える。
if (limiters.global) {
  const global = await limiters.global.consume(LOGIN_GLOBAL_KEY, now)
  if (!global.success) {
    if (!cleanSource || !limiters.globalReserve) return denied(global.retryAfterMs)
    const reserve = await limiters.globalReserve.consume(LOGIN_GLOBAL_RESERVE_KEY, now)
    if (!reserve.success) return denied(reserve.retryAfterMs)
  }
}

// 3) 照合は必ず実行する（以降は現行どおり）。
```

4. **`auth.ts`**: `LOGIN_GLOBAL_RESERVE_LIMITER` を追加して `createLoginGuard` に渡す。
   閾値の目安は本番グローバル軸 100回/分 に対し 20%（= 20回/分）＝ SEC-029 修正方針2 の「グローバル上限の 20%」。
5. **`auth.ts:44-50` の閾値コメント**を実装と一致させる（T1-b が green になると「グローバル枠の消費 = scrypt 実行回数」が
   事実になるので、初めてこのコメントが正しくなる）。

### 残余リスク（**閉じていないので明記する**）

T1-a〜T1-f がすべて green になっても、次は成立し続ける:

> **`global.limit + globalReserve.limit` を超える数の「その分だけ独立した発信元」を持つ攻撃者は、
> 依然として正規管理者のログインを窓ごと止められる。**

固定ウィンドウのカウンタを照合前ゲートに使う限り、この性質は構造的に消えない。
予約枠は攻撃者の必要 IP 数を増やすだけで、ゼロにはしない。
**構造的に閉じる唯一の形は、SEC-022 修正方針3 が第一候補として挙げていた
「同時実行中の scrypt 数を上限とするセマフォ」**である（自動解放されるので枯渇せず、
枯渇時の症状が「拒否」ではなく「待ち」になる）。Senior も RV-P25-001 で同じ指摘をしている。

P2.5-b のスコープ（fix-plan 行1 = 順序の移動）を超えるため本契約には含めないが、
**「消した」ではなく「残余リスクとして受容した」** と `security-audit.md` / `docs/tech-stack.md` に
記録すること（RV-P25-001 の要求）。P3 で未認証エンドポイントへ横展開する際は、
グローバル軸をセマフォへ置き換えるかを必ず再評価すること。

---

## T2. SEC-030 / RV-P25-002（Must Fix）— `trusted=false` 時のゲート意味論

### まず事実確認（現行実装へ直接投入して実測）

旧記述（`lib/http-guard.ts:84-85` / `docs/tech-stack.md:199-200` / 旧テスト契約 §T2）は
「信頼境界外で全員が単一 `unknown` バケットを共有しても、正しい資格情報は常に通る」と述べていた。
**これは事実に反する。** 現行実装へ直接投入して確認した:

```
trusted=false / 共有 unknown バケットへ他者が 12 回失敗
→ 正規管理者・正しいパスワード: {"outcome":"rate-limited","retryAfterMs":580000,"verified":false}
→ アカウント軸の計数: ゲート拒否された 2 件は計上されない（10/12 しか記録されない）
```

「成功は常に通す」が適用されたのはアカウント軸だけで、IP 軸は照合前ゲートのままだった。
攻撃コストは 10リクエスト/10分 で、**元の SEC-021（5req/15分 + 管理者メール既知）より安い。**

### 決定した意味論（T2-DECISION）

> **`trusted === false` のとき、IP 軸は計数を続けるが照合前ゲートには使わない。**
> 共有バケットが枯渇していても `verify()` を実行し、成功なら `ok` を返す。
> 失敗した場合は、共有バケットが枯渇していれば `rate-limited` を返す（＝制限が緩む方向にも壊さない）。
> コスト保護はグローバル軸と予約枠が担う。
> `trusted` 既定（`true`）の経路は現行どおり厳格な照合前ゲートのままとする。

### 選択理由（判断基準: **P3 で未認証エンドポイントに横展開したときに正規利用者を締め出さないこと**）

| 選択肢 | 判定 | 理由 |
|---|---|---|
| **(A) 縮退時はゲートに使わず計数のみ** | **採用** | 共有バケットは「無関係な利用者の集合」であり、それを根拠に拒否することは第三者による締め出しそのもの。P3 の申込 / チャットへ横展開すると「1 人の濫用で全訪問者が申込を送信できない」形で顕在化する。判断基準を直接満たす唯一の選択肢 |
| (B) 別の緩い閾値を割り当てる | 不採用 | 共有ゲートであることは変わらないので、**締め出しが遅くなるだけで消えない**。閾値を上げるほどコスト保護も同時に緩むため、可用性と耐性のどちらも改善しない |
| (C) 成功照合は常に実行（ゲート廃止） | 実質 (A) | (A) は「計数と観測を残す」点だけが違う。観測は分散攻撃の検知に要るので (A) を採る |

### (A) が支払う代償（隠さずに記録する）

発信元を識別できない以上、「発信元あたりの推測回数を縛る」ことは**定義上できない**。
したがって縮退時のブルートフォース耐性は、IP 軸（10回/10分）ではなく
グローバル軸（+ 予約枠）の上限まで低下する。この代償は (B) を選んでも減らない
（(B) は締め出しを買うだけで、耐性は同程度に低い）。

**運用上の必須要件**: Vercel 以外へ配置する場合は、前段プロキシが XFF を上書きすることを
確認したうえで **`trustProxy` を必ず有効化すること**（SEC-030 修正方針3）。
`docs/tech-stack.md:198-210` の「Vercel 以外へ移す場合の必須作業」を、この趣旨に書き換えること。

### 追加したテスト

ファイル: `tests/unit/login-guard.test.ts`
describe: `SEC-030: createLoginGuard — 信頼境界外（trusted=false）の縮退時のゲート意味論`（L760）

| # | テスト（行） | 検証する契約 | これが green なら成立しなくなる攻撃 |
|---|---|---|---|
| T2-a | `共有 unknown バケットが他者の失敗で枯渇しても、正しい資格情報でのログインは成功する`（L768） | `trusted=false` + 共有バケット枯渇でも `outcome=ok` / `verified=true` | **信頼境界外の配置で、誰か 1 人が 10 分間に 10 回失敗するだけで全利用者を締め出す攻撃**（10req/10分・管理者メールの知識も不要） |
| T2-b | `縮退しても制限は緩まない: 共有バケット枯渇後の誤った資格情報は通らない`（L800） | 枯渇後の失敗は `rate-limited`（`ok` にならない） | 「縮退時はゲートを外す」意味論を悪用した **fail-open**（誤った資格情報が通る）狙いの攻撃 |
| T2-c | `縮退時も失敗はアカウント軸に計数され続ける（分散攻撃の観測手段を失わない）`（L824） | 12 回の失敗がすべてアカウント軸に計上される | **共有バケットを枯渇させてから、以降の試行を「計数されない」状態にして観測ログから姿を消す攻撃**（現行はゲート拒否時に `account.consume` へ到達しない） |
| T2-d | `trusted 既定（true）では縮退の緩和が適用されない`（L842） | `trusted` 省略時は従来どおり照合前に拒否 | `trusted` 分岐の実装ミスで緩和が全経路へ適用され、**本番（Vercel）でも IP ゲートが消えて scrypt が無制限に走る**状態 |
| T2-e | `縮退時のコスト保護はグローバル軸が担う（照合が無制限にはならない）`（L864） | 縮退時の `verify()` 実行回数は `global.limit + globalReserve.limit` で頭打ち | **縮退時に IP ゲートが外れることを利用した、単一ホストからの無制限 scrypt 実行（CPU DoS）** |

### red である理由（実測）

`pnpm vitest run tests/unit/login-guard.test.ts -t 'SEC-030'` → **3 failed / 2 passed**（T2-b / T2-d は現行でも green）

```
T2-a  AssertionError: 共有バケットは無関係な利用者の集合であり、その枯渇で正しい資格情報を拒否してはならない（SEC-030）:
      expected 'rate-limited' to be 'ok'
T2-c  AssertionError: 12 回の失敗はすべて計数されるべき: expected 10 to be 12
T2-e  AssertionError: 縮退時の照合回数は global + globalReserve の上限で頭打ちになる:
      expected "spy" to be called 7 times, but got 5 times
```

### Impl が実装すべき変更

1. **`lib/login-guard.ts`**: `LoginAttemptInput` に `trusted?: boolean`（既定 `true`）を追加。
   `trusted === false` のとき、`ip.consume` の結果を**ゲートに使わない**（計数のみ）。
   共有バケットが枯渇している状態で `verify()` が false を返したら `rate-limited` を返す。
   予約枠の判定（`cleanSource`）は、発信元を識別できないため `trusted === false` では **true とみなす**
   （＝ T2-e の 7 回はこの前提で導かれる）。
2. **`auth.ts:91`**: `resolveClientIp(originRequest)` の戻り値から `.key` だけでなく `.trusted` も取り出し、
   `loginGuard.attempt({ email, ip, trusted })` に渡す。
   現在 `ClientIpResolution.trusted` は**どこからも使われていない**（SEC-030 修正方針2）。
3. **誤った記述の訂正（Must Fix の本体）**: 次の 3 箇所から「正しい資格情報は常に通るので締め出されない」を削除し、
   訂正後の意味論と運用要件（`trustProxy` 必須）に書き換える。
   - `lib/http-guard.ts:83-85`（コメント）
   - `docs/tech-stack.md:198-210`
   - `docs/review-p25-tests-2026-07-28.md` §T2「導かれる契約」3（原典は `docs/security-audit.md` SEC-021 付随節）

### 残余リスク

縮退時も **グローバル軸は硬いゲートのまま**である（T2-e が固定）。したがって
`trusted=false` の配置では、グローバル枠 + 予約枠を使い切れる攻撃者は依然として全利用者を止められる。
本契約はこれを閉じない。閉じるのは「共有 `unknown` バケット由来の締め出し」（＝ SEC-030 が実測した経路）までである。

---

## T3. RV-P25-003 — `consume` の判定結果を捨てない

### 検証する契約

照合前ゲートは `peek`（判定）→ `consume`（加算・戻り値を捨てる）の 2 相ではなく、
**`consume` の判定結果そのもの**で行う。`lib/rate-limit.ts` の直列化は「1回の `peek`」
「1回の `consume`」の内側でしか効かないため、2 相のままでは同時到着した N 本すべてが
①を通過し、②の `success:false` が捨てられて N 本すべてが `verify()` に進む。

### 追加したテスト

ファイル: `tests/unit/login-guard.test.ts`
describe: `RV-P25-003: createLoginGuard — 並行リクエスト下でも IP 上限を超えて照合しない`（L901）
ヘルパ: `createSlowStore()`（L903。`get`/`set` の間に必ず割り込みが入る＝ KV のネットワーク往復相当）

| # | テスト（行） | 検証する契約 | これが green なら成立しなくなる攻撃 |
|---|---|---|---|
| T3-a | `同一 IP からの 20 並行リクエストのうち、照合が実行されるのは上限回数だけ`（L922） | `verify` 呼び出しが 5 回（= IP 軸の上限）、`rate-limited` が 15 件 | **IP 軸の上限境界を狙って同時接続を束ね、上限を超える数の scrypt（各 100ms）を同時に走らせて libuv スレッドプールを圧迫する CPU DoS**（増幅率は同時接続数に比例し、ウィンドウごとに繰り返せる） |
| T3-b | `並行拒否された分は IP 軸のカウンタも進めない`（L950） | 並行 20 本の後もカウンタは 5 で止まる | **上限到達後も連投でカウンタ（= store への書き込み）を進め、KV 差し替え時に書き込み課金・レイテンシを増幅させる攻撃**。現行でも green（退行検出用） |

### red である理由（実測）

```
T3-a  AssertionError: 並行下でも IP 軸の上限を超えて scrypt を実行してはならない（consume の判定結果を捨てない）:
      expected "spy" to be called 5 times, but got 20 times
```

20 本すべてが `verify()` に到達している＝コスト保護が並行下で完全に無効になっている。

### Impl が実装すべき変更

`lib/login-guard.ts:87-91` の 2 相を 1 相に畳む。`consume` は「上限到達済みならカウントを進めない」
（`lib/rate-limit.ts:234-237`）ので、逐次実行時の意味論は変わらない。

```ts
// peek → consume の2相をやめ、consume の判定でゲートする（単一の直列化区間に収まる）。
const gate = await limiters.ip.consume(ipKey, now)
if (!gate.success) return denied(gate.retryAfterMs)
```

`RateLimiter.peek` は `auth.ts:111-112` のログが使うので API 自体は残す。
T1 の `cleanSource`（`gate.remaining === gate.limit - 1`）も、この 1 相化と同時に得られる。

---

## T4. RV-P25-006 / SEC-035 — `evictFor` の時刻注入

### 検証する契約

`lib/rate-limit.ts` は「時刻は必ず `now` 引数で注入できる」を設計原則（`:21`）としているが、
`evictFor`（`:115`）だけが `Date.now()` を読む。注入時刻が実時刻より過去だと
**全エントリが「期限切れ」と判定されて store が空になり、退避方針が一度も実行されないまま
assertion が通る**（SEC-035 実測: 過去時刻で 12 キー投入 / maxEntries=10 → storeSize=2）。

既存テストの `T0 = 1_800_000_000_000` が実時刻より未来であることによって、この不一致は
**偶然に隠されている**。本契約は、`T0` の値の選び方に依存せず退避方針が検証できる状態を固定する。

### 追加したテスト

ファイル: `tests/unit/rate-limit.test.ts`
describe: `SEC-035 / RV-P25-006: 退避処理が注入された時刻を使う`（L468）
定数: `T_PAST = 1_000_000`（**実時刻より過去**。`Date.now()` との取り違えを検出するために過去を選ぶ）

| # | テスト（行） | 検証する契約 | これが green なら成立しなくなる（見落とし） |
|---|---|---|---|
| T4-a | `注入時刻では期限切れでないエントリを、実時刻を根拠に消してはならない`（L469） | 期限切れが無い状態では常駐件数が上限（3）のまま保たれる | **SEC-023（件数上限による退避）のテストが「上限を守っているように見えて実は store 全消去だった」という空振りで通る**状態。退避方針の退行が検出されなくなる |
| T4-b | `注入時刻で期限切れになったエントリが優先的に退避され、生存エントリは巻き添えにならない`（L489） | 期限切れの `old-*` が退避され、生存中の `fresh` は残る | 同上。加えて **SEC-031（退避の悪用）を P3 で評価する際の土台が、検証されていない挙動の上に乗る**状態 |
| T4-c | `時刻ソース未指定なら実時刻で動作する（既定の挙動は変えない）`（L509） | `now` 省略時は `Date.now()` で従来どおり | 時刻ソース注入の追加で**本番の既定挙動が変わる**退行。現行でも green（退行検出用） |

### red である理由（実測）

```
T4-a  AssertionError: 期限切れが無いので resetAt 昇順で 1 件だけ退避され、常駐件数は上限のまま保たれる:
      - Expected 3 / + Received 1     ← 退避ではなく全消去が起きている
T4-b  AssertionError: 期限切れ優先の退避で、生存中のウィンドウを巻き添えにしてはならない:
      expected true to be false        ← 生存中の fresh が消えたため新ウィンドウとして通過した
```

### Impl が実装すべき変更

```ts
export interface MemoryRateLimitStoreOptions {
  maxEntries?: number
  /** 時刻ソース。既定 `Date.now`（SEC-035 / RV-P25-006）。 */
  now?: () => number
}
```

`createMemoryRateLimitStore` はこの時刻ソースを保持し、`evictFor`（`lib/rate-limit.ts:115`）は
`Date.now()` の代わりにこれを呼ぶ。あわせて既存テストの `T0` に
「実時刻より未来であることは偶然ではなく意図」であるとコメントを残すこと。

---

## 実測サマリー（テスト実行結果）

| 項目 | 値 |
|---|---|
| 追加テスト | **16 件**（T1: 6 / T2: 5 / T3: 2 / T4: 3） |
| `pnpm test:unit` | **11 failed / 168 passed（179）** |
| 既存テストの退行 | **なし**（既存 163 件はすべて pass。失敗 11 件はすべて今回追加分） |
| green の 5 件 | T1-c / T2-b / T2-d / T3-b / T4-c（いずれも**退行検出用**。現行実装でも成立する性質を固定） |
| `pnpm type-check` | **10 errors**（すべて未実装の API 追加分。下記） |

`type-check` のエラーは Impl への要求そのものである（他のエラーは無い）:

```
login-guard.test.ts(516,57) 'globalReserve' does not exist in type 'LoginGuardLimiters'
login-guard.test.ts(780,11) 'trusted' does not exist in type 'LoginAttemptInput'   （他 5 箇所）
login-guard.test.ts(873,7)  'globalReserve' does not exist in type 'LoginGuardLimiters'
rate-limit.test.ts(471,63)  'now' does not exist in type 'MemoryRateLimitStoreOptions' （他 1 箇所）
```

integration（28）/ e2e（82）は本変更の対象外（テストファイルを触っていない）。

## Impl への要求まとめ

| # | ファイル | 変更 |
|---|---|---|
| 1 | `lib/login-guard.ts` | グローバル軸 consume を IP ゲート通過後へ移す（T1-a/b） |
| 2 | `lib/login-guard.ts` | `globalReserve?: RateLimiter` と `LOGIN_GLOBAL_RESERVE_KEY` を追加し、グローバル枠枯渇時は失敗履歴の無い発信元だけが引けるようにする（T1-d/e/f） |
| 3 | `lib/login-guard.ts` | `LoginAttemptInput.trusted?: boolean`（既定 true）を追加し、`false` のとき IP 軸をゲートに使わない（T2-a/c/e） |
| 4 | `lib/login-guard.ts` | `ip.peek` → `ip.consume` の 1 相化（T3-a）。`cleanSource` はこの結果から導く |
| 5 | `lib/rate-limit.ts` | `MemoryRateLimitStoreOptions.now?: () => number` を追加し、`evictFor` がそれを使う（T4-a/b） |
| 6 | `auth.ts` | `LOGIN_GLOBAL_RESERVE_LIMITER`（20回/分 = グローバル軸の 20%）を追加して `createLoginGuard` に渡す |
| 7 | `auth.ts:91` | `resolveClientIp()` の `.trusted` を `attempt()` に渡す |
| 8 | `auth.ts:44-50` | 閾値コメントを実装と一致させる（T1-b が green になって初めて「グローバル枠の消費 = scrypt 実行回数」が事実になる） |
| 9 | `lib/http-guard.ts:83-85` / `docs/tech-stack.md:198-210` / `docs/review-p25-tests-2026-07-28.md` §T2 | 「正しい資格情報は常に通るので締め出されない」という**誤った記述を訂正**（RV-P25-002 の Must Fix 本体） |
| 10 | `docs/security-audit.md` / `docs/tech-stack.md` | 下記の残余リスク 2 件を「消した」ではなく「**受容した**」として明記 |

## 残余リスク一覧（本契約が閉じないもの）

1. **グローバル軸の分散枯渇**: `global.limit + globalReserve.limit` を超える数の独立した発信元を持つ攻撃者は、
   依然として正規管理者のログインを窓ごと止められる。固定ウィンドウのカウンタを照合前ゲートに使う限り
   構造的に消えない。**構造的な解は「同時実行中の scrypt 数を上限とするセマフォ」**
   （SEC-022 修正方針3 の第一候補 / RV-P25-001 でも Senior が指摘）。P3 で未認証エンドポイントへ
   横展開する際に必ず再評価すること。
2. **縮退時のグローバル軸**: `trusted=false` でもグローバル軸は硬いゲートのままなので、
   グローバル枠 + 予約枠を使い切れる攻撃者は全利用者を止められる。緩和は `trustProxy` の有効化。

## Senior / Security への申し送り

- **スコープの逸脱について**: fix-plan 行1 の指定は「グローバル軸 consume を IP ゲート通過後へ移す」（3 行の移動）だが、
  その受け入れ条件「他者がグローバル上限を使い切っても、正しい資格情報でのログインは通る」を
  **literal に満たすには順序変更だけでは足りない**（多数 IP による枯渇が残る）。
  そこで SEC-029 修正方針2（予約枠）も契約に含めた（T1-d/e/f）。Impl の作業量は 3 行から
  「`globalReserve` 追加 + `auth.ts` 配線」に増える。**スコープを順序変更のみに戻す判断もありうるが、
  その場合は T1-d/e/f を削除するのではなく、残余リスク 1 として明示的に受容する決定を記録すること。**
- **検証方法について**: 本契約が green になったことを完了根拠にしないこと。fix-plan の申し送りどおり、
  Security は SEC-029 / SEC-030 の攻撃シナリオを実装モジュールへ直接投入し、**実測で再現しないこと**を確認すること。
</content>
</invoke>
