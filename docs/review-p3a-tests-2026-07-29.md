# Test Agent 記録: P3-a のテスト設計（red）

## 日付: 2026-07-29
## 担当: Test Agent
## 入力
- `docs/review-p3-design-re2-2026-07-29.md` **§D（Test Agent への申し送り 20〜27）**
- `docs/spec-p3-fix3-2026-07-29.md`（AC 修正内容と §3 自己点検結果）
- `docs/functional-spec.md` **v0.3.3** §4.11（AC-RL-1〜15）/ AC-010-10〜15 / AC-PII-1・10
- `docs/tech-stack.md` **v0.3.2** §4.5 / §4.6 / §4.7
- `docs/phase-status.md`「P3-a の完了条件（分割）」(1) / (2)

## スコープ
`docs/phase-status.md` の **「(1) P3-a で満たす」項目のみ**。
**(2) 各後続単位で再検証する**（AC-RL-3 / 5 の `chat:` / 6 / 13(c) / 14 / AC-010-4 の `sid` 照合 /
AC-PII-11 / AC-RL-9 の確定値 / AC-010-15 の `/apply` 切替）は**書いていない**。
`it.skip` も置いていない——skip は「あるのに動いていない」テストとして残り、
後で「あるから確認済み」と誤読されるため（§D 27 / 前回 §D 18）。

---

# 0. 本設計の中心にある1つの判断

**「テストが green であること」ではなく「壊れた実装を green にしないこと」で評価される**という指示に対し、
本設計は次の構造で応えている。

```
tests/unit/helpers/semaphore-contract.ts       ← 契約を「関数」として書く（実装非依存）
        │
        ├─→ tests/unit/semaphore.test.ts                        本物の lib/semaphore.ts に適用 → 現在 red
        └─→ tests/unit/semaphore-contract-detects-defects.test.ts
                                意図的に壊した7種の実装に適用し、
                                **すべて赤になることを assert** → 現在 green（18件）
```

**これにより「この契約が green なら、どの壊れた実装が排除されるのか」が文章ではなく実行可能な形で残る。**
過去3回の失敗（P2 = テスト対象の取り違え / P2.5 = 契約自体の欠陥 / P3 設計 = AC を素直に読むと
壊れた実装が green になる）は、いずれも「テストの検出力を誰も検証していなかった」ことが共通の根である。

副次的な効果として、**AC-RL-11(d)（掃除を消すと (a) が落ちること）が自動テスト化された。**
仕様上 (d) は「実装差し替えで1回確認する**手順**」であり、`spec-p3-fix2-2026-07-29.md:210` が
「自動テストではない」ことを残余リスクとして記録していた。現在は CI で毎回検証される。

---

# 1. 追加したテスト一覧

| # | ファイル | 件数 | 現状 | 主な対象 AC |
|---|---------|------|------|-----------|
| 1 | `tests/unit/helpers/fake-kv.ts` | （ヘルパ）| — | AC-RL-11(e-2)(e-3) の観測手段 |
| 2 | `tests/unit/helpers/semaphore-contract.ts` | （ヘルパ）| — | AC-RL-11(a)(b)(c)(d)(e) |
| 3 | `tests/unit/helpers/seeded-random.ts` | （ヘルパ）| — | AC-RL-15(c) / AC-RL-12(c) |
| 4 | `tests/unit/semaphore-contract-detects-defects.test.ts` | **18** | ✅ **green** | 契約テスト自身の検出力 / AC-RL-11(d) の自動化 |
| 5 | `tests/unit/semaphore.test.ts` | **32** | 🔴 red（module 未作成）| AC-RL-1 / 11 / 15 / AC-010-13(a)(b) |
| 6 | `tests/unit/public-guard.test.ts` | **23** | 🔴 red（module 未作成）| AC-RL-7 / 12 / 2 / 10 / AC-010-16 |
| 7 | `tests/unit/form-session.test.ts` | **18** | 🔴 red（module 未作成）| AC-RL-13 (a)(b)(d) |
| 8 | `tests/unit/cron-auth.test.ts` | **10** | 🔴 red（module 未作成）| AC-PII-10 |
| 9 | `tests/unit/kv-store.test.ts` | **10** | 🔴 red（8件）| AC-010-10 / AC-010-12 / AC-RL-8 |
| 10 | `tests/unit/env-p3a-fail-fast.test.ts` | **8** | 🔴 red（5件）| AC-010-10 / AC-RL-13 / AC-PII-10 |
| 11 | `tests/unit/rate-limit-ipv6.test.ts` | **8** | 🔴 red（4件）| AC-RL-4 / AC-010-11 |
| 12 | `tests/unit/api-route-guard-coverage.test.ts` | **11** | 🔴 red（2件）| AC-010-14 の**構造** |
| 13 | `tests/e2e/playwright/csp.spec.ts` | **7** | 🔴 red（未実測。下記 §6）| AC-010-15 / AC-008-1 |

**追加したユニットテスト: 138件**（うち 18件は現時点で green ＝ 検出力の証明）。
**`pnpm test:unit` が現在 collect できるのは 234件**（既存 179 + 新規 55）——
import 解決に失敗する4ファイル（`semaphore` 32 / `public-guard` 23 / `form-session` 18 /
`cron-auth` 10 = 83件）は**モジュール未作成のため collect されない**。
**既存 179件は全て green のまま。退行なし。**

---

# 2. 各テストの「検証する契約」と「これが green なら排除される壊れた実装／攻撃」

## 2.1 `tests/unit/semaphore.test.ts`（AC-RL-1 / 11 / 15 / AC-010-13）

| 行 | 検証する契約 | **これが green なら排除されるもの**（1文）|
|----|------------|----------------------------------|
| `:147` | `SEMAPHORE_TTL_SEC === PUBLIC_HANDLER_MAX_DURATION_SEC * 2` | `maxDuration` を伸ばして TTL を伸ばし忘れる変更（処理中パーミットが早期回収され上限超過）|
| `:155` | `semaphoreTtlMs() === 20_000` | 秒 → ms の変換関数が2箇所に散る実装 |
| `:160` | **`acquire` に渡る実 ms 値が 20,000**（ARGV[2]）| 変換の欠落（TTL 20ms ＝ 処理中パーミットの即時回収 → 上限超過）と二重適用（5.5時間 ＝ RV-P3DR-001 が閉じた恒久枯渇への逆戻り）。**関係式テストは秒同士しか見ないためこれを検出しない** |
| `:210` | 公開 Route Handler の `maxDuration` が定数から導出される（**FS 走査型**）| `export const maxDuration = 30` のような数値直書き |
| `:230` `:234` | `SEMAPHORE_SHARDS === 4` / `semaphoreTotalLimit()` が `perShardLimit × shards` | 「全体で N」と定義し、シャードあたりが N/K になる実装（全体に空きがあるのに満杯が常態化）|
| `:242` | シャード数が注入可能 | AC-RL-11(a)② の `SEMAPHORE_SHARDS = 1` が書けない設計 |
| `:254` `:263` | キー literal `sem:{applications}:0..3`（`uploads` / `chat` も同形）| — |
| `:273` | 連番を `{}` に入れる禁止形でない | `sem:<endpoint>:{0..3}` 形（シャードが別スロットへ散り、複数キー `EVAL` が `CROSSSLOT` で失敗＝原子性が成立しない）|
| `:282` | 全シャードのハッシュタグが一致 | 同上 |
| `:297` | Lua が `ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` の順 | 掃除を持たない実装 / 判定より後に掃除する実装 |
| `:308` | **最初の `ZREMRANGEBYSCORE` より前に分岐が無い** | 「空きがありそうなときだけ掃除」「N 回に1回だけ掃除」型の間引き（§D 23）|
| `:317` | Lua 内で `TIME` を読まない | 時刻注入不能な実装（実時間 20秒待ちのテストしか書けなくなる）|
| `:323` | `KEYS[1]` `KEYS[2]` と `ARGV[1..4]` を使う | 候補を1本しか渡さない実装 |
| `:338` | **AC-RL-11(a)** 継続負荷下の回復 | 掃除なし実装 / キー単位 TTL（`INCR`+`EXPIRE`）方式 / **テスト自身の空振り** |
| `:346` | **AC-RL-11(d)** 掃除の間引き禁止（位相 0〜11 総当たり）| 「N 回に1回だけ掃除する」最適化（決定的に検出。フレーキーにしない）|
| `:353` | **AC-RL-11(e-2)** 1 acquire = ZSET 読み書き1回 | 楽観方式（`ZADD`→`ZCARD`→自分を `ZREM`）＝旧機構の欠陥2「最大2倍超過」と同型 |
| `:360` | **AC-RL-11(e-1)+(e-3)** 並行取得で成功数がちょうど上限 + 濃度最大値が上限以下 | Lua 1本だが `ZCARD` 判定が無い実装（(e-1) が落とす）/ 楽観方式の**一瞬の超過**（(e-3) が落とす）|
| `:366` | **(e-3)** TTL 境界をまたぐ系列 | 回収と追加の間で在庫を二重計上する実装 / `EXPIRE ... NX` 型（境界で在庫ごと消え上限の2倍まで積める）|
| `:372` | **AC-RL-11(b)** release のシャード局所性 | シャード番号を持ち回らず先頭シャードへ `ZREM` する実装（他人の在庫を減らす）|
| `:376` | **AC-RL-11(c)** 二重 release の冪等性 | `DECR` 型（在庫を1つ減らすだけで誰のものか区別しない）実装 |
| `:387` | 候補2シャードを1回の `EVAL` に渡す | ランダム1択の実装（偏りにより公称容量前に Tier C）|
| `:402` | 一方が満杯でも他方に空きがあれば成功（決定的）| 候補を1本しか見ない実装 |
| `:432` | 待機中に空きが出れば成功 | 上限到達を即 Tier C に落とす実装（「拒否ではなく待ち」が成立しない）|
| `:454` | 待ち上限 2秒で打ち切る | 無制限待機（Function インスタンスを占有し課金され、保護したい資源をむしろ消費する）|
| `:472` | ポーリング間隔が 100〜200ms | 過密ポーリング / 待ちが長すぎる実装 |
| `:496` | **待機中の各ポーリングで候補を選び直す**（RV-P3DR2-003 / §D 24）| 候補ペアを `acquire` の外で1回だけ計算して持ち回る実装（空きが2つあっても満杯の2つを2秒間叩き続け Tier C を返す）|
| `:545` | `permitId` は呼び出し側が渡す（§D 26）| 乱数生成をストア内部に隠す実装（`release` の局所性・冪等性を決定的に書けなくなる）|
| `:564` | 既定 `permitId` が ≥128bit・毎回異なる | 予測可能・衝突しうる `permitId`（他人のパーミットを解放できる）|
| `:594` | **AC-010-13(a)** 並行 `acquire` が KV 上で交錯する | `lib/rate-limit.ts` の `serialize` をセマフォへ流用する実装（スループットの単一障害点になる）|

> ⚠️ `:594` の結果を**「シャード化が効いた証拠」と読み替えてはならない**（RV-P3DR2-009）。
> 効いているのは `serialize` 非経由であってシャード化ではない。テスト本文にもこの注記を書いた。

## 2.2 `tests/unit/semaphore-contract-detects-defects.test.ts`（検出力の証明 / **現在 green**）

| 行 | 壊れた実装 | 落ちる契約 |
|----|-----------|-----------|
| `:335` | 掃除（`ZREMRANGEBYSCORE`）を省いた実装 | (a) |
| `:340` | **キー単位 TTL（`EXPIRE` を毎 `acquire` で発行）** | (a) |
| `:345` | 掃除を「3回に1回」へ間引いた実装 | (d) |
| `:350` | 掃除を「7回に1回」へ間引いた実装 | (d) |
| `:357` | Lua 1本だが `ZCARD` 判定が無い実装 | (e-1) |
| `:362` | 楽観方式 | (e-2) |
| `:367` | 楽観方式 | (e-3) |
| `:374` | `release` が常に先頭シャードを叩く実装 | (b) |
| `:379` | `release` が「在庫を1つ減らす」だけの DECR 型 | (c) |
| `:386` | 本物のスクリプト定数を渡さない実装 | フェイク KV が throw する |
| `:278`〜`:306` | **正しい実装は全契約を通る**（false red の否定）| — |

**false red を潰すことも同じ重みで扱った。** `:306` は `evalsha` の `NOSCRIPT` フォールバックを
(e-2) の「原子操作1回」に数えると**正しい実装が落ちる**ことへの対処で、
carve-out（「ZSET を読み書きするコマンドの発行回数」で数える）自体をテストで固定している。
false red は false green と同じ速さで無視されるため、両方向を押さえた。

## 2.3 `tests/unit/public-guard.test.ts`（AC-RL-7 / 12 / 2 / 10）

| 行 | 検証する契約 | **これが green なら排除されるもの** |
|----|------------|--------------------------------|
| `:94` `:102` | Origin 欠落・クロスオリジンは fail-closed 403、本体を呼ばない | CSRF（`SameSite` 既定値への暗黙依存）|
| `:110` | Content-Type 不一致は 415 | プリフライト無しの CORS 単純リクエストによる CSRF 経路 |
| `:118` | **レート制限は本体より前** | 攻撃者に DB 書き込み・ファイル I/O を消費させ続ける実装 |
| `:131` | 正常終了で `release` する | パーミット漏れ（TTL 回復に頼り切る実装）|
| `:139` | **本体が throw しても `release` する** | 漏れの主因（例外経路）を塞がない実装 |
| `:157` | Tier B = 403 `{challenge:"interactive"}` のみ | 降格理由を本文に載せる実装 |
| `:168` | Tier C = 202 `{retryAfterMs}`、`Retry-After` を付けない | Tier C と D の契約混同 |
| `:180` | Tier D = 429 + `Retry-After` + `{retryAfterMs}` | 同上 |
| `:190` | `200 + challengeRequired` を使わない（契約ルール1）| 成功系ステータスの多義化（クライアントがボディのフィールド有無で成功判定することになる）|
| `:209` | **共有軸の枯渇で 429 を返さない**（条件1'-1）| セマフォ枯渇を「拒否」に落とす実装（公開エンドポイントではそのままサービス停止）|
| `:226` `:232` | ジッタ N=20 で「相異なる値が2つ以上」かつ「±20% 内」| ジッタ無し実装（thundering herd）/ 規定外に散らばる実装。**「2回取って同値でない」で書いていない**（フレーキー禁止）|
| `:243` | 同一シードで同一系列（乱数注入）| 乱数源を隠した実装 |
| `:249` | 応答の `retryAfterMs` をサーバーが返す | クライアントが待ち時間を決める実装 |
| `:260` | Tier B は降格理由を区別できない（応答が完全一致）| bot に判定基準を教える実装 |
| `:281` | **`challenge` を持たない 403 に `challenge` を付けない**（ルール7）| 全 403 に `challenge` を付ける実装 → 利用者が CAPTCHA を解いて再送してもまた 403 = **抜けられないループ** |
| `:292` | Tier B の 403 は必ず `challenge` を含む | Tier B を非 Tier の失敗と区別できない実装 |
| `:307` | 連続成功でカウンタが単調増加 | `reset-on-success`（正常系が頻繁に成功する経路で攻撃者に無料枠を与える。SEC-039）|
| `:321` | `cleanSource` / 予約枠を公開経路へ持ち込まない | SEC-041 と同型の資格復活経路 |
| `:337` | 拒否・劣化ログに生 IP / `sid` を出さない | PII 漏えい（AC-PII-1。`sid` は資格情報的性質を持つ）|
| `:363` `:380` | `retryAfterMs` 固定フックが**本番で無効** | E2E 用フックが本番へ漏れ、攻撃者が待ち時間を1〜2秒に固定できる |

## 2.4 `tests/unit/form-session.test.ts`（AC-RL-13 (a)(b)(d)）

| 行 | 契約 | **排除されるもの** |
|----|------|------------------|
| `:59` `:63` | 属性 `HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/` / `Max-Age=1800` | `HttpOnly` 欠落（XSS で `sid` を盗める）/ `SameSite=None`（クロスサイトから Cookie 軸を使え、軸として機能しない）|
| `:81` | Cookie 不在は `null`（＝ Tier B） | **「Cookie が無ければ素通り」実装**（攻撃者は Cookie を送らないので、「同一 Cookie の4回目が拒否」だけのテストは攻撃者の条件とずれる = SEC-038 と同型）|
| `:90` | payload 改竄は `null` | 署名検証なしの実装 |
| `:97` | **`issuedAt` だけの差し替えも `null`** | 署名対象に `issuedAt` を含めない実装（過去に書き換えるだけで AC-RL-6 の3秒下限を回避できる）|
| `:106` | 署名部分の差し替えは `null` | 署名長・形式の検証漏れ |
| `:113` | 他鍵署名は `null` | 鍵の取り違え |
| `:118` | 境界: ちょうど 30分は有効 / +1ms で無効 | 期限判定の off-by-one |
| `:124` | 未来の `issuedAt` は `null` | 時計を進める偽装 |
| `:129` | 壊れた形式でも例外を投げず `null` | 500 を返す実装（Tier B に落ちず、劣化が「失敗」になる）|
| `:138` | `issuedAt` を epoch ms で取り出せる | AC-RL-6 の判定基準をクライアント値に頼る実装 |
| `:149` | `deriveFormSessionKey` が入力をそのまま返さない | `AUTH_SECRET` を直接 Cookie 署名鍵に使う実装（片方の漏えいが両方に波及）|
| `:169` `:173` | 署名比較が `timingSafeEqual` | タイミング攻撃による署名復元 |

## 2.5 `tests/unit/cron-auth.test.ts`（AC-PII-10）

| 行 | 契約 | **排除されるもの** |
|----|------|------------------|
| `:46` | 未認証は **404**（401 ではない）| 401 を返す実装（「このパスは存在する」＝削除バッチの所在を晒す）|
| `:55` `:65` `:77` | 誤トークン・長さ違い・別スキームも 404 | 例外で 500 になる実装 / Basic 等を受け付ける実装 |
| `:87` | 正しい Bearer なら本体が呼ばれる | — |
| `:97` | **`CRON_SECRET` 未設定なら fail-closed で 404** | 未設定時に認可を素通りさせる実装（＝ 未認証の削除エンドポイントが本番に出る）|
| `:111` | Origin 無しでも通る（public-guard 対象外）| `/api/cron/**` を `withPublicMutation` で包む実装（Origin fail-closed で**バッチが永久に動かず**、保持期間削除・orphan 回収が止まる = APPI 違反の温床）|
| `:126` `:132` | `timingSafeEqual` を使い、素の `===` で比較しない | 応答時間から1文字ずつ復元されるタイミング攻撃 |
| `:138` | AC-PII-11 は P3-a のスコープ外であることの記録（`it.skip` を置かない）| 「skip があるから確認済み」という誤読 |

## 2.6 `tests/unit/kv-store.test.ts`（AC-010-10 / AC-010-12 / AC-RL-8）

| 行 | 契約 | **排除されるもの** |
|----|------|------------------|
| `:97` | `createKvRateLimitStore` が `RateLimitStore` + `increment` を返す | — |
| `:105` | **判定 API（`consume`/`peek`/`reset`）を持たない** | `lib/kv.ts` に固定ウィンドウ判定を書き直す実装（AC-RL-8 が禁じる判定ロジックの複製）|
| `:114` | `INCR` →（**新規ウィンドウのときだけ**）`EXPIRE` | **毎回 `EXPIRE` を張り直す実装**（窓が永久に終わらず、攻撃者が叩き続ける限りカウンタがリセットされない）|
| `:136` | `get` → `set` の read-modify-write ではない | 分散環境で失われる更新（`serialize` はプロセス内でしか効かない）|
| `:147` | 件数上限退避の概念を持たない | KV store にインメモリ相当の退避を持ち込む実装（SEC-031）|
| `:156` | 他キー 500 件注入でも自分のスロットルが解除されない | SEC-031 の攻撃 |
| `:178` | **上限に達したバケットを退避しない**（SEC-041）| 「最も古い `resetAt` から退避」方針の流用（攻撃者が他キーを注入して自分のバケットを追い出し、`cleanSource` の資格を取り戻せる）|
| `:210` `:214` `:220` | `lib/kv.ts` に真実源コメント（`lib/rate-limit.ts` / `SemaphoreStore`）があり、判定式を持たない | レート制限とセマフォの抽象混同（RV-P3DR-007）|

## 2.7 `tests/unit/env-p3a-fail-fast.test.ts`（AC-010-10 / AC-RL-13 / AC-PII-10）

| 行 | 契約 | **排除されるもの** |
|----|------|------------------|
| `:40` `:45` | 本番で `KV_REST_API_URL` / `_TOKEN` 未設定なら throw | KV 未設定のまま起動し、**レート制限とセマフォが黙って無効化**される（インメモリへ落ちるとインスタンスごとに別カウンタ＝全体流量制御にならない）|
| `:50` | dev / test では throw しない | 開発体験の破壊 |
| `:59` | 本番で `FORM_SESSION_SECRET` 未設定なら throw | Cookie 署名鍵が無く AC-RL-13(b) の必須化が成立しない |
| `:64` | **`AUTH_SECRET` と同一値を流用できない** | 鍵の用途分離違反（片方の漏えいが両方に波及）|
| `:75` | 本番で `CRON_SECRET` 未設定なら throw | 未認証の削除エンドポイント |
| `:84` `:88` | Turnstile / Blob は P3-a では必須にしない | 単位を先取りして P3-a のデプロイが理由なく落ちる |

## 2.8 `tests/unit/rate-limit-ipv6.test.ts`（AC-RL-4 / AC-010-11）

| 行 | 契約 | **排除されるもの** |
|----|------|------------------|
| `:27` | 同一 `/64` は同一キー | — |
| `:31` | `/64` が違えば別キー | 正規化しすぎて全 IPv6 を1バケットにする実装 |
| `:35` | **20 個のアドレスを名乗っても通るのは上限の3回だけ** | アドレス単位でキーを作る実装。IPv6 は**1契約者に `/64` 以上が払い出される**ため、攻撃者は同じ回線のままアドレスを変えるだけで per-source 軸に一度も触れずに叩き続けられる（SEC-022 と同じ「軸が軸として機能しない」型）|
| `:51` | 表記ゆれ（省略記法 / 大文字）を畳む | 文字列一致だけで比較する実装 |
| `:59` | IPv4 は丸めない | — |
| `:64` | **IPv4 射影は IPv4 として扱う** | 射影を `/64` に丸める実装（`::ffff:0:0/96` は全 IPv4 を含むため**全 IPv4 利用者が1バケット**に落ち、攻撃者1人で締め出せる）/ 射影と素の IPv4 を別キーにする実装（表記を切り替えるだけで上限を2倍使える）|
| `:75` | IP でない値の挙動は不変 | P2 の2軸運用の退行 |
| `:81` | 正規化後もキー長は有界 | SEC-023 の増幅 |

## 2.9 `tests/unit/api-route-guard-coverage.test.ts`（AC-010-14 の**構造**）

**ルート名を一切ハードコードしていない。** `app/api/**/route.ts` を FS 走査し、
**パスの接頭辞からラッパを決める規則**を適用するだけである（`cron/` → `withCronAuth` /
`admin/` → `withAdminMutation` / それ以外 → `withPublicMutation`）。
したがって**新ルートを足すと、テストを書き換えない限り落ちる**。

| 行 | 契約 | **排除されるもの** |
|----|------|------------------|
| `:118` | 走査が0件でない | 走査パスを間違えて**何も検証しないまま green** になる状態（P2 の型）|
| `:124` | 変更系 export が規則どおりのラッパを通る | ラッパを通らない変更系ハンドラ |
| `:149` | 例外は理由付きで明示された接頭辞だけ（現在 `auth/` のみ）| 暗黙の例外の増殖 |
| `:161` `:168` | `lib/public-guard.ts` / `lib/cron-auth.ts` が存在する | — |
| `:176` | `/api/cron/**` → `withCronAuth` の割り当てが表にある | P3-c / P3-d でバッチを足したときに割り当てが決まっていない状態 |
| `:190`〜`:216` | **列挙テスト自身の検出力**（合成ソースに対する自己検証: 素の `export async function POST` / 別ラッパ / `export const { GET, POST }` 形 / GET のみ / 正しく包まれた PUT・DELETE）| 走査ロジックの穴（特に **Auth.js が実際に使っている分割代入 export を見落とす**こと）|

## 2.10 `tests/e2e/playwright/csp.spec.ts`（AC-010-15 / AC-008-1）

| 契約 | **排除されるもの** |
|------|------------------|
| CSP ヘッダが**強制モード**で存在する | Report-Only 運用（防御にならない）|
| `script-src` に `'unsafe-inline'` / `'unsafe-eval'` を含まない | nonce 方式を諦めて緩める実装（CSP の主目的が失われる）|
| `script-src` が nonce + `'self'` + Turnstile | Turnstile 導入時に CAPTCHA が壊れる順序ミス（可用性の問題でもある）|
| `frame-src` / `connect-src`（Blob）/ `img-src`（`blob:` `data:`）が**最終形**で入る | P3-b / P3-c でオリジンを足し、P3-a の監査証跡が最終ポリシーを表さなくなる状態 |
| `object-src 'none'` / `frame-ancestors 'none'` / `base-uri 'self'` / `form-action 'self'` | クリックジャッキング・base タグ注入 |
| `style-src` の `'unsafe-inline'` を**明示的に固定** | 「CSP を厳格にした」という過大報告（受容している事実を可視化する）|
| ブラウザで CSP 違反が出ない（**chromium 単一**）| 厳しすぎて自分のページを壊す CSP |

> CSP 違反のコンソール出力は文言がブラウザごとに異なるため、違反検出のみ
> `test.skip(browserName !== 'chromium')` で chromium に限定した（フレーキー回避）。
> ヘッダ内容の検証は3ブラウザで実行する。

---

# 3. §D（20〜27）への対応表

| §D | 申し送りの内容 | 担保したテスト | 状態 |
|----|--------------|--------------|------|
| **20** | AC-RL-11(a) の「上限まで埋める」は**全シャードを埋めること**。`SEMAPHORE_SHARDS = 1` を注入する。**「満杯であることを先に固定する1行を省略しない」**。「`acquire` が失敗するまで取る」で満杯判定しない | `helpers/semaphore-contract.ts:assertRecoversUnderContinuousLoad`（`shards: 1` 固定 / `totalLimit` 件をきっちり取得 / **④ の満杯 assert を必須**）← `semaphore.test.ts:311` | ✅ |
| **21** | (d) は **(a) が空振りしていないことを確認してから**行う。証跡を残す | ④ の満杯 assert を **(a) の中**に置いた（(d) 側の手順ではなく毎回実行される assert）。さらに **(d) 自体を自動テスト化**（`semaphore-contract-detects-defects.test.ts:352,357`）。証跡は §4 の実測ログ | ✅ **手順→自動テストへ格上げ** |
| **22** | 「上限を超えて `acquire` が成功しない」を必ず書く。並行 `+10` / TTL 境界 / 濃度の和 | `assertNeverExceedsTotalLimitUnderConcurrency`（(e-1)+(e-3)）/ `assertNeverExceedsTotalLimitAcrossTtlBoundary`（(e-3) TTL 境界）/ `assertSingleAtomicCommandPerAcquire`（(e-2)）← `semaphore.test.ts:327,334,341` | ✅ |
| **23** | 掃除は `acquire` の**失敗パスでも**実行される。間引き実装を落とす | `assertCleanupIsNotThinned`（位相 0〜11 の**総当たり**で決定的に検出）← `semaphore.test.ts:320` ＋ Lua ソースの構造 assert「最初の `ZREMRANGEBYSCORE` より前に分岐が無い」← `:282` | ✅ **フレーキーにせず決定的に** |
| **24** | 待機のテストに**候補シャードの選び直し**を含める | `semaphore.test.ts:472`（固定シードで「1回目は満杯のペア、2回目は空きのあるペア」＋ 発行された候補集合が2種類以上）| ✅ |
| **25** | TTL の単位を跨ぐ変換を1箇所に固定。**`acquire` に渡る実 ms 値が 20,000** | `semaphore.test.ts:153`（ARGV[2] を直接 assert）。関係式テスト（`:141`）とは**別の1本**にした | ✅ |
| **26** | `permitId` は呼び出し側が渡す。乱数生成をテスト対象の内側に隠さない | `semaphore.test.ts:517`（注入した `permitId` が ARGV と戻り値に現れる）/ `:535`（既定は ≥128bit・毎回異なる）。(b)(c) の契約はすべて固定 `permitId` で決定的に書いた | ✅ |
| **27** | `sessionIdHash` 関連は P3-a では書かない。`it.skip` を置かない。`pnpm db:generate` を実行しない | `sessionIdHash` / AC-010-4 のテストは**1本も書いていない**。`it.skip` は**0件**（`grep -c "it.skip" tests/unit` = 0）。**`pnpm db:generate` は実行していない**（Prisma に触れるテストを追加していない）| ✅ |

**前々回 §E 11項目・前回 §D 12〜19 のうち P3-a に関わるもの**:

| 項目 | 担保 |
|------|------|
| 11「空振りしているテストを green として報告しない」 | (a) の ④ assert / 列挙テストの「走査が0件でない」assert / **検出力メタテスト**の3重で担保 |
| 13「時刻は必ず注入する」 | 実時間 sleep は**1本も無い**（`setTimeout` を使うテストは0件。待機テストは仮想クロック + 注入 `sleep`）|
| 16「`CRON_SECRET` の比較が定数時間」 | `cron-auth.test.ts:127,132` |
| 18「`it.skip` を置かない」 | 上記のとおり 0件 |

---

# 4. red の実測状況（`pnpm test:unit` 実行結果 / 2026-07-29）

```
Test Files  8 failed | 16 passed (24)
     Tests  19 failed | 215 passed (234)
```

**既存テスト（unit 179）は全て green のまま。退行なし。**
（`login-guard 31 / client-ip 15 / rate-limit 30 / seed-guard 11 / env 11 / course-filter 10 /
http-guard 9 / news-validator 11 / design-tokens 5 / course-view 11 / badge 4 /
publish-status-badge 4 / sanitize 11 / format 8 / password 8` = 179 すべて pass）

## 4.1 「意図した理由で red になっている」ことの実測

| ファイル | red の種別 | 実測した失敗メッセージ（抜粋）|
|---------|-----------|---------------------------|
| `semaphore.test.ts` | module 未作成 | `Failed to resolve import "@/lib/semaphore"`（`:4:31`）|
| `public-guard.test.ts` | module 未作成 | `Failed to resolve import "@/lib/public-guard"`（`:3:31`）|
| `form-session.test.ts` | module 未作成 | `Failed to resolve import "@/lib/form-session"`（`:4:31`）|
| `cron-auth.test.ts` | module 未作成 | `Failed to resolve import "@/lib/cron-auth"`（`:4:31`）|
| `kv-store.test.ts` | **export 未実装 6件 + assertion 失敗 2件** | `TypeError: createKvRateLimitStore is not a function`（`:98`ほか）/ **`AssertionError: 上限に達したバケットは退避対象にしてはならない: expected null not to be null`**（`:198`）/ **`AssertionError: expected '/**\n * レート制限ストア抽象…' to contain 'SemaphoreStore'`**（`:217`）|
| `env-p3a-fail-fast.test.ts` | **assertion 失敗 5件** | `AssertionError: expected [Function] to throw error matching /KV_REST_API_URL/ but it didn't`（`:42`）/ 同 `KV_REST_API_TOKEN`（`:47`）/ `FORM_SESSION_SECRET`（`:61`, `:70`）/ `CRON_SECRET`（`:79`）|
| `rate-limit-ipv6.test.ts` | **assertion 失敗 4件** | `AssertionError: expected 'applications:2001:db8::1' to be 'applications:2001:db8::2'`（`:28`）/ **`AssertionError: 20 個の異なるアドレスを名乗っても、通るのは上限の 3 回だけ: expected 20 to be 3`**（`:48`）/ `expected 'applications:2001:0db8:0000:…' to be 'applications:2001:db8::1'`（`:55`）/ `expected 'applications:::ffff:198.51.100.7' to be 'applications:198.51.100.7'`（`:69`）|
| `api-route-guard-coverage.test.ts` | **assertion 失敗 2件**（走査 9件は green）| `AssertionError: lib/public-guard.ts が未作成（公開（未認証）変更系は認証非依存ラッパを必ず通る（SEC-037 / AC-RL-7））: expected false to be true`（`:165`）/ 同 `lib/cron-auth.ts`（`:173`）|

**「import 解決失敗だけで終わっていない」ことの根拠**:

1. **19件中 11件は本物の assertion 失敗**である（`env-p3a` 5 / `rate-limit-ipv6` 4 / `api-route-guard` 2）。
   さらに `kv-store` の2件も assertion 失敗であり、**合計 13件**が実装の欠落を意味のあるメッセージで示している。
2. import 解決に失敗する4ファイル（新規モジュール）については、**そこで使う契約 assertion の検出力を
   `semaphore-contract-detects-defects.test.ts` が 18件の green で実証済み**である。
   すなわち「import が通ったら green になるだけのテスト」ではないことが、実行結果として残っている。
3. `api-route-guard-coverage.test.ts` の**走査部分 9件は現在の実装に対して green** であり、
   **列挙テストが false red を出さないこと**（既存 `/api/admin/**` は正しく `withAdminMutation` を
   通っている）も同時に確認できている。

## 4.2 `pnpm type-check` について

**現時点では失敗する**（未作成モジュールの import と、`RateLimitStore.increment` の未定義）。
これは TDD の red 状態として想定どおりで、**Impl の完了条件（品質ゲート）で green に戻る**。
既存コードに型エラーは持ち込んでいない（変更したのは `tests/` 配下のみ）。

---

# 5. KV を要するテストの扱い（実 Redis / フェイク / 抽象）とその判断理由

## 5.1 採った方式: **フェイク KV クライアント**（`tests/unit/helpers/fake-kv.ts`）

**実 Redis も、`SemaphoreStore` のインメモリ代替も採らなかった。**

| 案 | 採否 | 理由 |
|----|------|------|
| **実 Redis に対する結合テスト** | ❌ 採らない（P3-a では）| **(e-3)（濃度の最大値）が原理的に観測できない**。`EVAL` が原子的なので、外から見て一瞬の超過が見えない。`spec-p3-fix3-2026-07-29.md` §6 S-3 が同じ理由を挙げている。加えて `@upstash/redis` は REST 経由なので、ローカルの `redis:7` コンテナをそのまま向けられず、`serverless-redis-http` 等のプロキシを CI に足す必要がある（P3-a の成果物に無い依存を増やす）|
| **`SemaphoreStore` のインメモリ実装に対して契約テストを回す** | ❌ 採らない | **P2 の「テスト対象の取り違え」と同型**になる。本番経路は KV 上の Lua であり、インメモリ実装を green にしても本番の性質は何も保証されない |
| **フェイク KV クライアント（採用）** | ✅ | 本番の `createKvSemaphoreStore` **そのもの**をテスト対象にしたまま、(e-2)(e-3) が要求する「呼び出しの記録」と「コマンド境界での濃度の記録」を実現できる。AC-RL-11(e-2)(e-3) の本文が「**呼び出しを記録するフェイク KV クライアント**」と明示的に指定しているのもこの方式である |

## 5.2 この方式で**検証できないこと**（残余リスク。隠さずに書く）

**Lua スクリプト本体の意味論は検証できない。** Node に Lua ランタイムが無いため、
フェイクはスクリプト文字列を解釈せず、参照実装（AC-RL-1 が定めた3ステップ）を実行する。
したがって「Lua の中で `ZCARD` の比較演算子を書き間違えた」形は**ユニットテストでは落ちない**。

**これに対して置いた歯止め（3重）**:

1. **フェイクは `expectedScript` と同一のスクリプトでなければ `eval` を throw する。**
   実装は `SEMAPHORE_ACQUIRE_LUA` を渡さない限り1本もテストを通せない
   （`semaphore-contract-detects-defects.test.ts:402` で固定）。
2. **スクリプト本文の構造をソース文字列に対して直接 assert する**
   （`semaphore.test.ts:272`〜`:296`）: `ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` の出現順 /
   **掃除より前に分岐が無い** / `TIME` を読まない / `KEYS[1]` `KEYS[2]` と `ARGV[1..4]` を使う。
   仕様が名指しした壊れ方（掃除の欠落・順序の逆転・掃除の間引き・時刻の内部取得）は
   **この構造 assert で落ちる**。
3. **AC-RL-11(d) の手順は残す。** Security 監査の実測項目（申し送り S-2）で、
   Lua から `ZREMRANGEBYSCORE` を実際に削った実装に対して (a) が落ちることを1回確認すること。

**Impl / Senior / Security への要求**: 上記2で守れるのは**構造**であって**意味論**ではない。
「ユニットテストが green だから Lua が正しい」と報告してはならない
（`security-audit.md` へ書くときも同様。P2.5 の教訓3）。
**実 Redis に対する結合テストを P3-a に足すかどうかは Impl / Senior の判断に委ねる**が、
足さない場合は「Lua 本体の意味論は構造 assert と (d) の手動確認までで担保している」ことを
`docs/security-audit.md` に受容として記録すること。

## 5.3 レート制限側（`lib/kv.ts`）の KV

同じ理由でフェイク Redis（`incr` / `pexpire` / `pttl` / `get` / `set` / `del` を記録する）を使った。
こちらは Lua を使わないため、**発行コマンド列そのものが契約**であり、
「毎回 `EXPIRE` を張り直していないか」「`get`→`set` の read-modify-write になっていないか」を
フェイクで完全に観測できる（残余リスクなし）。

---

# 6. E2E（CSP）について

`tests/e2e/playwright/csp.spec.ts` は**実行していない**。
E2E は `pnpm build` 済みのサーバー（CI モード = `pnpm start`）を前提とし、
現在は `lib/` の未作成モジュールにより `pnpm build` が通らない状態のため、
**実行しても「CSP が無い」ではなく「ビルドが失敗した」という無関係な赤しか得られない**。

**Impl への要求**: P3-a の実装完了後に `CI=1 pnpm test:e2e` を実行し、
既存 82件が green のままであること、CSP 7件（chromium で7 / firefox・webkit で6）が
green になることを実測して報告すること。

---

# 7. テストが**仕様に無いことを決めた**箇所（レビューで確認してほしい）

仕様は機構を確定しているが、テストから決定的に検証するには次の2つが必要で、
**本テスト設計が決めた**。Impl はこれに合わせること。**異論があればレビューで挙げてほしい。**

| # | 決めたこと | なぜ必要か |
|---|-----------|-----------|
| 1 | **`EVAL` の呼び出し規約**: `KEYS` = 候補シャードキー（`shards>=2` なら2本）/ `ARGV` = `[nowMs, ttlMs, perShardLimit, permitId]` / 戻り値 = `[key, permitId]` または `null` | ARGV の並びが決まらないと「`acquire` に渡る実 ms 値が 20,000」（§D 25 / AC-RL-15(a)）を assert できない |
| 2 | **シャード候補の導出式**: `rng()` を1回の抽選につき2回呼び、`a = floor(r1 * shards)` / `b = floor(r2 * (shards-1))`（`b >= a` なら `b += 1`）。`shards === 1` なら `rng` を呼ばない | 導出式が決まらないと、固定シードで「1回目は満杯のペア、2回目は空きのあるペア」を作れず、§D 24（待機中の候補再抽選）を決定的に書けない |
| 3 | **ポーリング間隔の乱数源（`acquireWithWait({ random })`）とシャード抽選の乱数源（`createSemaphore({ rng })`）を分ける** | 1つにすると、ジッタが rng を消費してシャード抽選の系列がずれ、2 の決定性が壊れる |
| 4 | **`RateLimitStore` に `increment?(key, windowMs, now)` を足す**（判定ではなく永続化の原子操作）| AC-010-10 の「`INCR`+`EXPIRE` で原子的に更新する」と AC-RL-8 の「判定ロジックを複製しない」を両立させる唯一の置き場所。判定（`count >= limit`）は `lib/rate-limit.ts` に残る |
| 5 | **`FORM_SESSION_SECRET` に `AUTH_SECRET` と同一値を設定すると env 検証が throw する** | `tech-stack.md` §4.6 の「用途分離」を**検証可能な形**にしたもの。文書だけでは運用で守られない |
| 6 | **ルート列挙の例外は `auth/`（Auth.js 内蔵ハンドラ）のみ**、理由付きで表に明記 | 例外を暗黙にしないため。Auth.js のハンドラをアプリ側ラッパで包むとフローが壊れる |

---

# 8. Impl が実装すべきモジュール一覧

| モジュール | 主な export | 対応 AC |
|-----------|-----------|--------|
| **`lib/semaphore.ts`**（新規）| `PUBLIC_HANDLER_MAX_DURATION_SEC` / `SEMAPHORE_TTL_SEC` / `SEMAPHORE_SHARDS` / `SEMAPHORE_MAX_WAIT_MS` / `SEMAPHORE_POLL_MIN_MS` / `SEMAPHORE_POLL_MAX_MS` / `semaphoreTtlMs()` / `semaphoreTotalLimit(perShardLimit, shards?)` / `semaphoreShardKeys(endpoint, shards?)` / `SEMAPHORE_ACQUIRE_LUA` / `SemaphorePermit` / `SemaphoreStore` / `createKvSemaphoreStore({client})` / `createSemaphore({store, endpoint, perShardLimit, shards?, ttlMs?, rng?, newPermitId?})` → `{ acquire, acquireWithWait, release, totalLimit, keys }` | AC-RL-1 / 11 / 15 / AC-010-13 |
| **`lib/public-guard.ts`**（新規）| `TIER_B_BODY` / `jitteredRetryAfterMs(baseMs, random?)` / `withPublicMutation(handler, options)` | AC-RL-7 / 12 / 2 / 10 / AC-010-14 / AC-010-16 |
| **`lib/form-session.ts`**（新規）| `FORM_SESSION_COOKIE_NAME` / `FORM_SESSION_MAX_AGE_SEC` / `deriveFormSessionKey(secret)` / `createFormSessionValue(payload, secret)` / `verifyFormSessionValue(value, secret, now)` / `formSessionCookieAttributes()` | AC-RL-13 (a)(b)(d) |
| **`lib/cron-auth.ts`**（新規）| `withCronAuth(handler, options?)` | AC-PII-10 |
| **`lib/kv.ts`**（書き直し）| `KvRateLimitClient` / `createKvRateLimitStore({client})` → `RateLimitStore`。**真実源コメントに `lib/rate-limit.ts` と `SemaphoreStore` を1行ずつ残す** | AC-010-10 / AC-RL-8 / AC-010-12 |
| **`lib/rate-limit.ts`**（追記）| `RateLimitStore.increment?(key, windowMs, now)` / `rateLimitKey` に **IPv6 `/64` 正規化と IPv4 射影の畳み込み** / `createMemoryRateLimitStore` の退避方針を「**上限到達バケットは退避しない**」へ | AC-RL-4 / AC-010-11 / AC-010-12（SEC-041）|
| **`lib/env.ts`**（追記）| production の `superRefine` に `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `FORM_SESSION_SECRET`（`AUTH_SECRET` と同値を禁止）/ `CRON_SECRET` | AC-010-10 / AC-RL-13 / AC-PII-10 |
| **`next.config.mjs` or `middleware.ts`** | CSP 最終形（nonce 方式。`tech-stack.md` §4.7 の表どおり）| AC-010-15 / AC-008-1 |

**着手時の最初のタスク（`phase-status.md` / RV-P3DR2-006）**: `@upstash/redis` を実際に追加し、
`eval(script, keys: string[], args)` のシグネチャを**実物で1回再確認**すること。
代替案（楽観方式）へ落ちる場合は、**AC-RL-11(e-2)(e-3) を先に書き換え、受容を
`tech-stack.md` に記録してから**実装すること（本テスト設計は楽観方式を落とす形になっている）。

---

# 9. 残余リスク・申し送り

| # | 内容 | 宛先 |
|---|------|------|
| **T-1** | **Lua スクリプト本体の意味論はユニットテストで検証できない**（§5.2）。構造 assert とフェイクのスクリプト同一性チェックまでが担保範囲。**「ユニットが green だから Lua が正しい」と報告しないこと** | Impl / Senior / Security |
| **T-2** | AC-RL-11(d) の**手動確認**（Lua から `ZREMRANGEBYSCORE` を削った実装で (a) が落ちる）は依然として必要。自動化したのは「契約 assertion がその型の欠陥を落とす」ことまでで、**本物の Lua を削った版**は試していない | Security（申し送り S-2）|
| **T-3** | `tests/e2e/playwright/csp.spec.ts` は**未実行**（`pnpm build` が red 状態のため）。実装完了後に `CI=1 pnpm test:e2e` で実測すること | Impl |
| **T-4** | `pnpm type-check` は red 状態（未作成モジュールの import / `RateLimitStore.increment` 未定義）。実装で green に戻す | Impl |
| **T-5** | §7 の 6項目は**テストが決めた規約**であり仕様には無い。Senior レビューで妥当性を確認してほしい（特に 1・2・4）| Senior |
| **T-6** | AC-010-13(c)（並行 N リクエストで応答時間が N に線形比例しない）の**実測**は Impl の担当。本テストは `maxInFlight() > 1`（直列化されていないこと）までしか見ていない。**実測結果を「シャード化が効いた証拠」と読み替えないこと**（RV-P3DR2-009）| Impl |
| **T-7** | AC-010-13(b) の**キー literal 一致**と AC-010-13(c) の**因果の書き方**は、仕様自身が「テストでは守れない」と記録している（`spec-p3-fix3-2026-07-29.md` §3.3）。本テストはキー生成関数の出力までは固定したが、**実装が本当にその関数を使っているか**はレビューで見る必要がある | Senior |
| **T-8** | `permitId` の既定長（16進 32文字以上）を assert したが、**暗号論的乱数であること自体**はテストで検証できない（`Math.random` でも通る）。ソースレビューで `crypto.randomBytes` / `crypto.getRandomValues` を使っていることを確認してほしい | Senior |
