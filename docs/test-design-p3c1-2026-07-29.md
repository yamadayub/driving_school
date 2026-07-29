# P3-c1（前提ハードニング）テスト設計

## 作成日: 2026-07-29
## 担当: Test Agent（`.claude/skills/test.md`）
## 入力: `docs/security-p3b-reaudit-2026-07-29.md`（SEC-067〜070）/ `docs/security-audit.md` §F（P3c-1〜13）/ `docs/phase-status.md`「P3-c への繰越」
## スコープ: **P3-c2（F-009 免許証写真アップロード本体）の前提となるハードニングのみ**

---

## 0. スコープの確定

### 含むもの

| ID | 内容 | 追加したテスト |
|----|------|--------------|
| SEC-058 / P3c-2 | `withPublicMutation` の構築時検査を全構成へ広げる | `tests/unit/public-guard-construction-p3c.test.ts` |
| SEC-060 / P3c-4 | 実在しない `courseId` を 422。`P2003` を明示分類し、未分類だけ 500 | `tests/unit/application-error-classification.test.ts` / `tests/integration/application-course-fk.int.ts` |
| SEC-061 / SEC-069 / P3c-5 | `TRUST_PROXY` を導入し、本番判定を `VERCEL` から切り離す | `tests/unit/trust-proxy-env.test.ts` |
| SEC-067 | 縮退構成の回復不能な Tier B ロックアウト | `tests/unit/form-session-degraded-recovery.test.ts`（結合は §12.3 の申し送り） |
| SEC-068 | 未検証の印がクライアントから可読（状態オラクル） | `tests/unit/form-session-degraded-recovery.test.ts` |
| SEC-070 | SEC-057 の到達数テストの境界が緩い | 既存 2 ファイルの境界を締める（下記 §6） |
| SEC-046 / P3c-7 | `withCronAuth` の試行回数制限 | `tests/unit/cron-auth-attempt-limit.test.ts` |
| SEC-064 / P3c-8 | `PrismaClient` のエラーログを `lib/pii-log.ts` へ合流 | `tests/unit/prisma-error-log.test.ts` |
| SEC-065 / P3c-10 | `/privacy` に発信元 IP の保持を追記し `RETENTION_PERIODS` へ | `tests/unit/retention-client-ip.test.ts` |
| ~~SEC-063 / P3c-9~~ | KV 版 store が上限到達後に `INCR` しない | **P3-c1 では対応しない（繰越）**。理由と訂正済みの契約は §10 |

### 含まないもの（P3-c2 のスコープ）

- F-009 本体（署名付き URL の有効期限・`objectKey` の推測不可能性・マジックバイト検証・orphan 回収バッチ・アップロード UI）= **P3c-11**
- `semaphore-contract.ts` へのメモリ版セマフォ搭載（P3c-12 / 推奨）
- CI への `pnpm audit --audit-level=high` 組み込み（P3c-13 / CI 設定であってテスト設計ではない）
- RV-P3B-019（送信成功の E2E が 1 本も無い）— **E2E の設計判断であり、P3-c2 の UI と同時に設計するのが安い**（§12.5 に申し送り）
- SEC-067 の回復経路の**ルート結線**（`POST /api/form-session` 等）— 正典関数の契約までを本単位で固定し、結線と結合テストは §12.3 に申し送る

---

## 1. **SEC-059 / P3c-3 の扱い: クローズ済みとして本単位の対象から外す**

**結論: 対象外とする。P3-b の RV-P3B-006 で既に閉じている。**

根拠（自分で確認した）:

| 確認項目 | 実体 |
|---------|------|
| 実装 | `lib/public-guard.ts:442-467` `enforceBodyBytes` が `request.body.getReader()` で逐次読みし、`total > maxBodyBytes` の時点で **`await reader.cancel()`** して `null` を返す。`await request.arrayBuffer()` は使っていない |
| 意図の記録 | 同 :429-441 に「なぜ『読み切ってから比べる』ではいけないのか（RV-P3B-006 / SEC-059）」として、128MB を載せてから 413 を返す旧実装の欠陥が明記されている |
| テスト | `tests/unit/public-guard-body-stream.test.ts`（180 行）が存在する |
| 実測記録 | `docs/impl-p3b-fix-notes-2026-07-29.md` §6: 「4MB の chunked ボディに対し**読み取り量 4,194,304 バイト → 上限 + 数チャンク以内**。境界（ちょうど上限 = 201 / +1 バイト = 413）と『上限内なら本体で読み直せる』も green」 |

**したがって P3-c1 で重複実装させない。** 監査 §F の P3c-3 行は「新規」と書かれているが、
これは §F が **P3-b 差し戻し前**の実装を見て書かれたためである。
P3-c の実装者が §F だけを読むと `enforceBodyBytes` を二度目に書き直す（そして `cancel()` の
位置をずらして退行させる）危険があるため、**本節を明示的な打ち消しとして残す。**

> ⚠️ ただし P3-c2 で**写真アップロードの本体上限**（64KB では足りない）を決める際は、
> `maxBodyBytes` を上げるだけで済ませず、**上げた値で同じストリーム打ち切りテストを回すこと**。
> `tests/unit/public-guard-body-stream.test.ts` は既定値（64KB）でしか測っていない。

---

## 2. SEC-058 / P3c-2 — 構築時検査を全構成へ広げる

**ファイル**: `tests/unit/public-guard-construction-p3c.test.ts`（9 件）

### なぜ P3-c の「前」なのか

現行の構築時検査（`lib/public-guard.ts:263-276`）は **`if (limiters?.source)` を入口**にしている。
したがって **`limiters.source` 自体を書き忘れた構成は検査を丸ごと素通りする。**
P3-c は `uploads` という 2 つ目の公開変更系エンドポイントを作るので、

```ts
withPublicMutation(handler, {
  endpoint: 'uploads',
  limiters: { formSession: uploadLimiter },   // source を書き忘れた
  verifyFormSession: ...,                     // formSessionKey も無い
})
```

と書かれると **`lib/public-guard.ts:324` は両方揃ったときにしか軸を push しないため
Tier D 軸が 1 つも無いアップロード口**が、例外も警告も無く本番へ出る。

### 構成の全数表（Impl はこの表を実装すること）

| # | `limiters.source` | `limiters.formSession` | `formSessionKey` | 期待 | 現状 |
|---|---|---|---|---|---|
| (0) | — | — | — | throw しない | ✅ |
| (a) | ✓ | — | — | throw | ✅ |
| (b) | ✓ | ✓ | — | throw | ✅ |
| (b') | ✓ | — | ✓ | throw | ✅ |
| **(c)** | — | ✓ | — | **throw** | ❌ **red** |
| **(d)** | — | — | ✓ | **throw** | ❌ **red** |
| (e) | — | ✓ | ✓ | throw しない | ✅ |
| (f) | ✓ | ✓ | ✓ | throw しない | ✅ |

**原則**: 軸は「完成している」か「最初から無い」かのどちらかであること。
**半分だけ渡した構成**が静かに無効化されるのを構築時に落とす。

**同時に守ること**: (0) と (e) を throw させてはならない。
`lib/public-guard.ts:259-262` が自ら書いているとおり、**過剰な検査は「Impl が検査そのものを外す」動機**になる。
検査が禁じるのは「半端」であって「少ない」ではない。

### これが green なら排除される事故

- `uploads` の実装者が `limiters` か `formSessionKey` の片方だけを書き、
  **Tier D 軸が 1 つも無い免許証写真の受け口**を本番へ出すこと。
  SEC-057 の「無制限に DB 行」がそのまま「**無制限にオブジェクトストレージへ書き込み**」になる
  （監査 §F 理由 2: 費用・違法画像の受け入れ・orphan 回収バッチの破綻）。
- ビルドが落ちたときに、どのルートの構成が原因か分からず「とりあえず検査を外す」修正が入ること
  （例外メッセージに `endpoint` を含めることを 1 件で固定した）。

---

## 3. SEC-061 / SEC-069 / P3c-5 — `TRUST_PROXY` で縮退構成の適用範囲を実際に限定する

**ファイル**: `tests/unit/trust-proxy-env.test.ts`（12 件）

### 監査の指摘（そのまま）

> `lib/http-guard.ts:98-99` と `docs/tech-stack.md` §4.5 は「Vercel 以外へ配置する場合は
> `trustProxy` を必ず有効化すること」と指示しているが、**その手段が実装されていない。**

`ResolveClientIpOptions.trustProxy` は存在するが、`app/api/applications/route.ts:351` /
`app/api/form-session/route.ts:119` のどちらも渡しておらず、真にする env も配線も無い。
**非 Vercel 本番は永続的に `trusted=false`（縮退構成）**である。

### Impl が実装すべき契約

```ts
// lib/env.ts — serverEnvShape に追加
//   '1' | 'true' → true / '0' | 'false' → false / 未設定 → false
//   それ以外の値は **起動時に落とす**（fail-fast）
TRUST_PROXY: <boolean へ変換されるスキーマ>    // parseServerEnv(...).TRUST_PROXY: boolean

// lib/http-guard.ts — resolveClientIp の既定の決定順
//   1. options.trustProxy（明示引数が最優先。既存 client-ip.test.ts 224 行を壊さない）
//   2. TRUST_PROXY が明示されていればその値
//   3. どちらも無ければ process.env.VERCEL === '1'
```

さらに `lib/http-guard.ts` の運用指示コメントが `TRUST_PROXY` を**名指し**すること
（SEC-069 の本体は文書と実装の食い違いなので、ソースで 1 件固定した）。

### ⚠️ 「env で緩める形ではない」という当初の記述は**誤りだった**（REV-P3C1-003 で訂正）

当初ここには「`TRUST_PROXY` は上限を緩めない——**制限が強くなる方向にしか動かない**」と書いた。
**これは誤りである。** Senior レビューの指摘が正しい。正しくは:

> **上限そのものは緩めないが、`TRUST_PROXY` は信頼境界を移す設定であり、誤設定は防御を無効化しうる。**

`resolveClientIp` は信頼する場合 **`x-vercel-forwarded-for` を最優先**で採る（`lib/http-guard.ts:67-71, 116-122`）。
その根拠は「Vercel の手前に自前プロキシを置いても上書きされない」という **Vercel 上でのみ成立する性質**である。
`TRUST_PROXY` の唯一の用途は**非 Vercel 本番**であり、そこでの前段（nginx / ALB / Cloudflare）は
`x-vercel-forwarded-for` を知らないので**剥がさない**。したがって攻撃者は
`X-Vercel-Forwarded-For: 203.0.113.9` を付けるだけで **`trusted: true` かつ自分で選んだ key** を得る:

1. 発信元軸のバケットを無限に作れる ⇒ 発信元あたりの上限が消える（SEC-023 / SEC-032 と同型）。
2. **`unverified` の印が一切付かなくなる**（`lib/form-session-issue.ts:129` は `!clientIp.trusted` でガード）
   ⇒ **SEC-057 の是正が丸ごと無効化される。**
   `TRUST_PROXY` は SEC-057 の残余を縮めるために入れるのに、誤設定で SEC-057 が全開になる。
3. `auth.ts:74` のログイン IP 軸は `trusted` のとき硬いゲートなので、
   攻撃者が**被害者の IP を名乗って**管理者を締め出せる（SEC-030 の再来）。

### 追加した契約: **信頼の出所（provenance）で採用ヘッダを変える**

| 信頼の出所 | 採用するヘッダ |
|---|---|
| プラットフォーム検出（`VERCEL === '1'`） | `x-vercel-forwarded-for` → `x-forwarded-for` → `x-real-ip`（従来どおり） |
| **env（`TRUST_PROXY`）** | **`x-vercel-forwarded-for` は採用しない。** `x-forwarded-for` → `x-real-ip` のみ |
| 明示引数（`options.trustProxy === true`） | 呼び出し側が構成を宣言しているものとして従来どおり |

明示引数を従来どおりにしたのは、`tests/unit/client-ip.test.ts` の 6 件が
`{ trustProxy: true }` で Vercel の優先順位を固定しており、**それが正しい意味論だから**である。
ただしこれは抜け道にもなる（`resolveClientIp(req, { trustProxy: env.TRUST_PROXY })` と書かれると
provenance の区別が消える）ので、**本番ルートが `trustProxy` を渡していないことをソースで pin した**
——「警告コメントでは 4 度止められなかった」（SEC-043）ため。

**既定 false（fail-closed）**と**不正値の fail-fast** は引き続き固定している。
加えて REV-P3C1-009 に従い、`resolveClientIp` 側でも**不正値が false になる**ことを 1 件 pin した
（`getServerEnv()` はキャッシュするため検証と使用が別経路になる。両方を安全側に倒す）。

### これが green なら排除される事故

- 非 Vercel 本番が**回避不能な既定**として縮退構成で動き、
  (a) SEC-057 の残余（未認証で 30 行/10 分 = 180 行・180 通/時）と
  (b) SEC-067（10 リクエストで全新規来訪者を回復不能な Tier B に落とせる）
  の両方を抱えたまま運用されること。再監査 §2.2 は**この配備を選んだ時点で SEC-067 が
  High（リリースブロッカー）へ昇格する**と明記している。
- 運用者が `TRUST_PROXY=yes` と書き、**黙って false のまま**縮退で運用され続けること。

---

## 4. SEC-067 / SEC-068 — 縮退構成の回復不能な Tier B と、印の可読性

**ファイル**: `tests/unit/form-session-degraded-recovery.test.ts`（**29 件 / red 15 件**）
**結線**: `tests/integration/form-session-route.int.ts`（NEW-001 で **6 件追加 / red 2 件**）

### SEC-067 は「SEC-057 の是正が生んだ脅威の移動」である

縮退構成の発行カウンタは `rateLimitKey('apply:fs-issue:', 'unknown')` — **全利用者で 1 個**。
窓内 11 枚目以降の Cookie に `unverified` が焼かれ、`verifyFormSessionValue`
（`lib/form-session.ts:216`）が `null` を返し、`lib/public-guard.ts:374-385` が
**ハンドラより前**に Tier B を確定させる。

> **CAPTCHA では抜けられない。** Turnstile 検証は `app/api/applications/route.ts:283` の
> **ハンドラ内**にあり、ラッパの step 6 で落ちる以上**一度も評価されない**。

これは `lib/public-guard.ts:160-165` が 413 について自ら禁じた
「CAPTCHA を解いて再送しても同じ応答が返る**抜けられないループ**」と**同型**である。
攻撃コストは **10 リクエスト / 10 分**（SEC-057 の 20 より安い）。

### 縮退構成そのものの可用性の評価（監査の依頼事項）

| 観点 | 評価 |
|------|------|
| 攻撃コスト | 10 リクエスト / 10 分（≒ 1 分に 1 回）。**SEC-057 より安い** |
| 被害範囲 | 縮退構成の**全新規来訪者**（共有 `unknown` バケット 1 個） |
| 回復手段 | **無い**（現状）。最大 10 分の固定窓が明けるまで待つのみ |
| 自己維持 | **する**。印の付いた利用者は `/apply` を開くたび `/api/form-session` へ再リダイレクトし、枠をさらに消費する（`docs/impl-p3b-fix2-notes-2026-07-29.md` §4: E2E の通常操作だけで窓内 23 回に到達＝**無コスト枠 10 は通常利用で日常的に超える**） |
| 結論 | **SEC-069 を閉じても不十分**。SEC-069 は被害集合を「ローカルと E2E の開発者」に縮めるが、**E2E は縮退構成でしか回らない**ので、自己維持する枠の枯渇は CI の flaky として残り続ける（RV-P3B-018 の再発源）。~~したがって **自己維持の切断は本単位で結線まで閉じる**（NEW-001 / §4.2）~~ ⚠️ **この結論は誤りだった（実装後の Security 監査 §1.5 で訂正 / 2026-07-29）。下記参照。** **回復経路の結線は P3-c2**（UI 導線と一体のため / §12.3） |

> ## ⚠️ 訂正: **`hasVerifiedSession` では自己維持を切れない**（実装後に判明 / Security 監査 §1.5）
>
> 上の表と §4.2 / §12.3 は「`hasVerifiedSession` を本番ルートへ結線すれば自己維持が切れる」と
> 設計したが、**それは成立しない。実装・結線・結合テストがすべて通ったうえで機能しなかった。**
>
> **理由（構造的）**: `hasVerifiedSession` は `verifyFormSessionValue(...) !== null` から作るが、
> **印の付いた Cookie に対して同関数は必ず `null` を返す**（SEC-068 の設計上そうでなければならない）。
> 自己維持ループの被害者は**まさに印の付いた利用者**なので、
> **この受け口には原理的に到達しない。**
> ここを `true` にする実装は、`form-session-route.int.ts:345` と Senior 申し送り 2 が禁じた
> 「ロックアウトの恒久化」になるため、**採ってはならない。**
>
> **実測**（Security 監査プローブ / Impl も独立に再現）:
> ```
> 被害者の再訪 10 回: 発行された=10 / already-verified で発行が省かれた=0
> ```
>
> **`hasVerifiedSession` が実際に閉じたもの**: REV-P3C1-001 が指摘した
> 「攻撃者が 1 枚の有効な Cookie を提示し続けて印の無い Cookie を積み上げる」経路
> （実測: 有効 Cookie 200 回提示 → 追加取得 0 枚）。**SEC-057 の追加ハードニングとしては本物**である。
>
> **SEC-067 本体（印による締め出しと、その自己維持）の是正は P3-c2 のスコープ**であり、
> **本単位では閉じていない。** §4.2 / §12.3 の「自己維持の切断は P3-c1」という区分は、
> 「`hasVerifiedSession` の結線は P3-c1」と読み替えること。
> **「閉じる」と書いて閉じていない記録を残さない**——NEW-001 / CR-001 と同じ原則である。

### 採った修正（監査の方針 2 と 3 を、SEC-057 を開かない形で組む）

> ⚠️ **本節の契約は Senior レビュー（REV-P3C1-001 / 002）を受けて作り直した。**
> 当初の `hasVerifiedSession`（「枠を消費しない」）と `challengePassed`（boolean）は
> **どちらも SEC-057 を開く**。差分と実測は **§4.1** に記録した。以下は作り直し後の内容である。

| 監査の方針 | 契約にした形 |
|---|---|
| 1. SEC-069 を解消 | §3（別ファイル） |
| 2. 印を「Tier B 確定」から「**チャレンジ必須**」へ降格 | **検証済みチャレンジトークンを伴う発行要求には印を付けない**（`challengeToken`）。**同一トークンの 2 回目以降は未通過扱い**＝増幅率 1。ラッパの評価順序は変えない |
| 3. 有効な Cookie を持つ再訪者を無コスト枠から除外 | **`hasVerifiedSession` なら発行そのものを行わない**（`issued: false, reason: 'already-verified'`）。ロックアウトの自己維持を切る。**失効間近なら再発行する**（更新窓 / NEW-003） |

#### なぜ「ラッパを通してハンドラの Turnstile で判定させる」形にしなかったか（重要）

**それは SEC-057 を再び開く。** `tests/unit/form-session-issue-cost.test.ts` と
`tests/integration/form-session-cost.int.ts` はどちらも Turnstile を「常に通過」として測るため、
印の判定をハンドラ内へ移すと**到達数が Cookie 枚数に比例して戻り**、両ファイルが red になる。
したがってコストは **発行の時点で** 払わせる——チャレンジを通した要求にだけ印の無い Cookie を出す。
SEC-057 の測定（チャレンジを通さない攻撃者）は **30 回のまま変わらない**。

### Impl が実装すべき契約

```ts
// lib/form-session-issue.ts
export type FormSessionIssueResult =
  | { issued: true; cookieName: string; cookieValue: string; attributes: FormSessionCookieAttributes }
  | { issued: false; reason: 'rate-limited'; retryAfterMs: number }
  | { issued: false; reason: 'already-verified' }      // ← 新設（REV-P3C1-001）

export interface IssueFormSessionOptions {
  clientIp: ClientIpResolution
  limiter: RateLimiter
  secret: string
  /** 有効（印の無い）Cookie を提示している再訪。**発行そのものを行わない。**
   *  ⚠️「消費しないが発行はする」にしてはならない（枠の免除に上界が無くなる / REV-P3C1-001）。 */
  hasVerifiedSession?: boolean
  /** このリクエストで **サーバー側が検証した** チャレンジトークン（値またはハッシュ）。
   *  渡された場合は無コスト枠を超えても印を付けない。
   *  **同一トークンの 2 回目以降は「未通過」として扱う**（増幅率を 1 に固定 / REV-P3C1-002）。
   *  ⚠️ **クライアントの自己申告を渡してはならない。** 必ず `verifyTurnstile` の結果として得ること。 */
  challengeToken?: string
  /** 使用済みチャレンジトークンの記録。省略時は内蔵（メモリ）。**KV 化の差し替え口**。
   *  `consume` は初回 true / 2 回目以降 false。 */
  usedChallengeTokens?: { consume(token: string, at: number): Promise<boolean> }
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
}

// lib/form-session.ts（SEC-068）
//   印は Cookie の payload に**平文で書かない**。
//   印あり / 印なしの値は、クライアントから見て payload もバイト長も同一であること。
//   （安い実装例: 印の有無で HMAC の HKDF ラベルを変え、検証側が両方を試す。
//     payload の形は変わらず後方互換も保たれる。実装方法は指定しない。）
```

### red の内訳（unit 15 件 / integration 2 件）

| テスト | 現状 |
|--------|------|
| 検証済みトークンの発行に印が付かない | `challengeToken` が存在せず無視される |
| 回復した Cookie が本番配線で 201 に到達する | 同上（403 のまま） |
| 同一トークン 200 回でも印なしは 1 枚だけ（増幅率 1） | 同上 |
| 異なるトークンなら枚数ぶん回復できる | 同上 |
| 使用済み記録が有効期間で失効する（NEW-004） | `CHALLENGE_TOKEN_TTL_MS` が無い |
| 使用済み記録に件数上限がある（NEW-004） | `CHALLENGE_TOKEN_MAX_ENTRIES` が無い |
| 使用済み記録を差し替えられる | `usedChallengeTokens` が無い |
| `already-verified` を返す | `hasVerifiedSession` が存在せず発行してしまう |
| 再訪 20 回の後も新規来訪者に印が付かない | 同上（枠を消費する） |
| `already-verified` も計数される（別勘定 / NEW-002） | 同上（`fs-issue` を消費する） |
| 更新窓の判定（NEW-003 / 3 件） | `isFormSessionRenewable` / `FORM_SESSION_RENEW_BEFORE_MS` が無い |
| payload をデコードしても印が現れない | `lib/form-session.ts:156` が `unverified` を平文キーで書く |
| 印あり/なしで payload が完全に同一 | 同上 |
| **[integration]** 有効な Cookie の再訪に `Set-Cookie` しない | ルートが `hasVerifiedSession` を渡していない |
| **[integration]** 通常構成でも同じ | 同上 |

### green にしてはならない（同時に守る 10 件の pin）

- 印の付く**入口**は残す（チャレンジを通さない攻撃者には従来どおり印が付く）
- `FORM_SESSION_FREE_ISSUE_LIMIT < 20`（**閾値を動かす対症療法を禁じる**。監査が明示的に非推奨）
- 回復経路の発行も**計数される**（ゲートに使わないことと数えないことは別）
- `trusted=true` の振る舞いは不変（Vercel 上の NAT 配下利用者に印を付けない / 硬い上限 30 は維持）
- 署名は payload 全体を覆い続ける（印の剥離・偽造は不可 = 再監査 §4 の維持）
- 既存形式（印なし）の Cookie は検証を通り続ける（**76 integration の手組み Cookie を守る**）

---

## 4.1 REV-P3C1-001 / 002 — 何が間違っていて、どう直したか（**実測つき**）

### 間違い①: `hasVerifiedSession` = 「枠を消費しない」（REV-P3C1-001 / 本レビュー最重要）

最も安い実装は `if (!hasVerifiedSession) { await limiter.consume(key, at) }` である。これで:

1. **`trusted`（Vercel 本番）でも硬い上限 30 が消える** — `lib/form-session-issue.ts:110` の
   ゲートは `consume` の結果に依存するので、飛ばした要求は上限を評価されない。
2. **縮退でも無コスト枠が消える** — `consumedInWindow = result.limit - result.remaining`（同 :128）が
   進まないので、何枚出しても印が付かない。
3. **Cookie は単回使用でも失効可能でもない** — `verifyFormSessionValue`（`lib/form-session.ts:167-222`）に
   「消費」の概念が無く、再発行時に旧 `sid` を無効化する経路も無い。
   攻撃者は **1 枚の有効な Cookie を提示し続けるだけ**で印の無い Cookie を積み上げられる。

> **「無コスト枠を消費しない」は枠の免除であり、免除に上界が無ければ枠は存在しないのと同じ。**
> SEC-067（可用性 / Medium）を直すために SEC-057（High）を開くのは、正味で悪化である。

しかも当時の**どのテストも赤くならなかった**——
「攻撃者が Cookie を提示するとどうなるか」を測る pin が 1 件も無かったためである
（`attackerScenario` も、既存の `trusted` 上限テストも、`hasVerifiedSession` を渡していない）。
**受け口の「悪用」が測られていない**という、このプロジェクトが 1 度事故を起こしたのと同じ型。

**直し方**: 契約を「**消費しない**」から「**発行しない**」へ変えた（レビューの改善案 (A)）。
SEC-067 の増幅要因は「`/apply` を開くたびに再発行して枠を消費する」ことなので、
**発行しなければ増幅も蓄積も同時に消える**。印の無い Cookie の**総数が増えない**ので SEC-057 に触れない。
利用者から見た導線も変わらない（`app/api/form-session/route.ts` は `/apply` へ 303 するだけ。
`Retry-After` は付けない——待つ必要が無いので意味が反転する）。

### 追加した 3 本の pin と、その**実測**（再レビュー条件 2）

レビューは「追加した pin が**修正前の実装で red、修正後に green**になることを実測で示せ」と要求した。
`lib/form-session-issue.ts` に**素朴な実装を一時的に当てて**測り、**元に戻した**（実装は残していない）。

| pin | 素朴な実装（`consume` を飛ばす） | 現行実装（`hasVerifiedSession` を無視） |
|-----|------------------------------|--------------------------------|
| ① `trusted` の硬い上限 30 を超えない | ❌ **50 枚発行できた**（上限 30） | ✅ green |
| ② 印なし Cookie の総数が無コスト枠を超えない | ❌ **200 枚積み上げられた**（枠 10） | ✅ green |
| ③ 本番配線での到達数が上界を超えない | ❌ **600 回到達**（上界 30 = **20 倍**） | ✅ green |

**pin は素朴な実装を確実に捕捉する。** 特に ③ の 600 回は、SEC-057 が測った 60 回の 10 倍であり、
「SEC-067 を直したつもりで SEC-057 を 10 倍悪化させる」経路が実在したことを意味する。

### 間違い②: `challengePassed: boolean`（REV-P3C1-002）

boolean では **1 回のチャレンジ通過で何枚の印なし Cookie を得られるか**が決まらない。
「ルート側で `verifyTurnstile` を実行しその結果を渡せ」という指示だけでは、
(a) 同一トークンを N 回検証してもらう / (b) 1 回の検証結果を以後の全発行に流用する、
のどちらも**契約に違反しない**。そうなると縮退での到達数は
「30（無コスト）+ 3 × 流用枚数」になり、**§6 で締めたばかりの上界が測っていない経路で破られる。**

> **回復経路の価値はコスト比で決まる。増幅率が 1 でなければコストは割り算で消える。**

**直し方**: boolean をやめ、**検証済みトークンの識別子**（`challengeToken: string`）を要求する形にした。
同一トークンの 2 回目以降は「未通過」として扱う——増幅率が**構造的に 1 に固定される**。
boolean を残すと「渡すだけ」で通せるため、**boolean フラグは契約から外した。**
併せて `usedChallengeTokens`（差し替え口）を契約に含めた——本番は複数インスタンスなので、
内蔵のメモリ記録では**インスタンスを跨いだ流用**を防げない。

---

## 4.2 NEW-001 — 自己維持の切断を**本番ルートで**閉じる（結線をスコープに入れた）

**ファイル**: `tests/integration/form-session-route.int.ts`（6 件追加 / **red 2 件**）

### 何が問題だったか

前版では `hasVerifiedSession` / `challengeToken` / `already-verified` を参照しているのが
**`tests/unit/form-session-degraded-recovery.test.ts` 1 ファイルだけ**で、
**結線を測るテストが 1 件も無かった。** そのため P3-c1 が完了しても
`app/api/form-session/route.ts` は `hasVerifiedSession` を渡さず、本番では常に `undefined`
＝ **自己維持の切断は 1 ミリも効かない。**

にもかかわらず §4 の結論は「回復経路と自己維持の切断も本単位で閉じる」と書いていた。
**これは「受け口が在るから結線済みと読める」で 1 度事故を起こした形（RV-P3B-001）と同じ**であり、
P3-c1 は「監査が指定した前提項目群を閉じる単位」なので**記録の正確さそのものが成果物**である。

### 採った対応（オーケストレーターの決定 = レビューの改善案 (A)）

**`hasVerifiedSession` の結線を P3-c1 のスコープに入れた。**
`challengeToken`（回復経路）の結線は §12.3 のとおり P3-c2 に置く——
自己維持の切断は UI に依存しないが、回復経路は UI 導線と一体だからである。

> ⚠️ **NEW-001 は「結線を測っていない」という指摘としては正しく、対応も正しかったが、
> 上の「自己維持の切断は UI に依存しない」という前提は誤りだった**（§4 冒頭の訂正を参照）。
> 結線は完了したが、**印の付いた利用者にはこの受け口が原理的に到達しない**ため、
> 自己維持は切れていない（実装後の Security 監査 §1.5 で実測）。
>
> **NEW-001 が想定した欠陥（受け口が呼ばれない）と、実際に残った欠陥（受け口に到達する
> 利用者集合が、直したい利用者集合と交わらない）は別物である。**
> 結合テストは前者を捕捉できるが、**後者は捕捉できない**——
> `form-session-route.int.ts` はルートへ直接 Cookie を渡すので green になる。
> 「受け口が呼ばれること」を測っても「**正しい相手に対して呼ばれること**」は測れない、
> というのが本件から得られた新しい型である。

### 追加した 6 件

| # | 内容 | 現状 |
|---|------|------|
| 1 | 有効な Cookie を提示 → `Set-Cookie` を持たず、それでも `/apply` へ 303 | ❌ **red** |
| 2 | Cookie 無し → 従来どおり `Set-Cookie`（初回訪問を壊さない） | ✅ green |
| 3 | `already-verified` に `Retry-After` を付けない（待つ必要が無い） | ✅ green |
| 4 | **印の付いた Cookie の保持者には発行する**（回復の妨げにしない） | ✅ green |
| 5 | 期限切れ・壊れた Cookie にも発行する（fail-open で発行側へ） | ✅ green |
| 6 | 通常構成（`trusted=true`）でも同じ | ❌ **red** |

**#4 が重要**である。`hasVerifiedSession` は「Cookie を持っているか」ではなく
「**有効な Cookie を持っているか**」でなければならない。印の付いた Cookie は
`verifyFormSessionValue` が `null` を返す（＝ 無効）ので、発行を止めてはならない——
止めると印の付いた利用者が**新しい Cookie を永久に得られず、SEC-067 のロックアウトが恒久化する**
（直そうとした欠陥を悪化させる）。

### Impl が実装すべきこと

```ts
// app/api/form-session/route.ts
const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, now)
const result = await issueFormSession({
  ...,
  // NEW-003: 失効間近なら再発行する（更新窓）。判定は正典モジュールに置く（AC-RL-8）。
  hasVerifiedSession: presented !== null && !isFormSessionRenewable(presented, now),
})
if (!result.issued) {
  const response = NextResponse.redirect(target, 303)
  // ⚠️ `reason` で分岐する。`already-verified` に Retry-After を付けない。
  if (result.reason === 'rate-limited') response.headers.set('retry-after', ...)
  return response
}
```

---

## 5. SEC-060 / P3c-4 — 実在しない `courseId` を 422 にし、`P2003` を分類する

**ファイル**:
- `tests/unit/application-error-classification.test.ts`（9 件 / red 3 件）— 分類の**網羅**
- `tests/integration/application-course-fk.int.ts`（4 件）— 前提の**実在**（実 DB の外部キー制約）

### なぜセキュリティ項目なのか

`app/api/applications/route.ts:304-315` は `P2002` だけを分類し、**それ以外を一律 500** にしている。
実在しない `courseId` を送ると `courseSnapshot`（同 :156-167）は `null` を返して素通りし、
`prisma.application.create` が **`P2003`** を投げ、**未認証の第三者が任意に 500 を起こせる**。

同型の欠陥は既に 2 度是正されている:
- 同 :259-261（壊れた JSON / 不正な UTF-8 で 500 を起こさせない — SEC-042 と同じ形）
- `lib/form-session.ts:182-187`（マルチバイト署名で `RangeError` を起こさせない）

**500 は「分類できなかった」という信号**である。分類可能な入力起因の失敗を混ぜると、
本当の内部障害がノイズに埋もれる。

### P3-c2 の前に閉じる理由

P3-c2 は `LicensePhoto` → `Application` という **2 本目の外部キー**を作る。
`P2003` の分類が無いまま外部キーが増えると、
**「アップロード直後に申込が消えた」「トークンが失効した」といった正常な競合まで 500 になる。**

### Impl が実装すべき契約

1. **事前照合**: `type=APPLICATION` で `courseId` が実在しなければ **create を呼ぶ前に**
   `422 { errors: [{ field: 'courseId', code: 'NOT_FOUND' }] }`
   （`courseSnapshot` が既に `findUnique` しているので追加の往復は不要）
2. **競合の分類**: 照合直後にコースが消された場合の `P2003` も**同じ 422 の本文**へ
3. **未分類の例外だけが 500**（`P2002` の冪等再送は従来どおり 200）
4. **応答に送信値も例外メッセージも含めない**（AC-PII-2 / AC-010-8）

### なぜユニットと結合の両方が要るのか

ユニットは `@/lib/db` をモックするので、
**「実在しない `courseId` が実際に `P2003` を起こす」という前提そのもの**を検証していない。
前提が偽なら（外部キー制約が張られていない等）ユニットは green のまま**本番では何も起きていない**
——P2 で実際に起きた「テストは green だが本番経路が守られていない」型である。
逆に「未分類の例外だけが 500」は実 DB では任意の例外を起こせないのでユニットでしか測れない。

---

## 6. SEC-070 — SEC-057 の到達数を固定するテストの境界を締める

**変更したファイル**（新規ファイルではない。**指摘対象が既存テストそのもの**であるため）:
- `tests/unit/form-session-issue-cost.test.ts`（7 件 → **9 件**。全て green）
- `tests/integration/form-session-cost.int.ts`（2 件。全て green）

### 監査の指摘

> 実際の到達数は 30 だが、固定されている上界は 60 / 90 である。
> `FORM_SESSION_FREE_ISSUE_LIMIT` が将来 10 → 19 に緩められても（到達数 57）
> **両テストとも green のまま**通る。非比例性テストは有効だが、**絶対量の退行**は捕まえられない。

### 直し方（数値リテラルの二重管理にしない）

| 場所 | 旧 | 新 |
|------|----|----|
| `form-session-issue-cost.test.ts` 監査実測の再現 | `toBeLessThan(60)` | `toBeLessThanOrEqual(DEGRADED_REACH_BOUND)` |
| 同 上限の存在 | `toBeLessThanOrEqual(FORM_SESSION_ISSUE_LIMIT * FORM_SESSION_LIMIT)` = 90 | 同上（= **30**） |
| `form-session-cost.int.ts` 受理件数 | `toBeLessThan(COOKIE_COUNT * SENDS_PER_COOKIE)` = 60 | `toBeLessThanOrEqual(ACCEPTED_BOUND)` |
| 同 DB 行数 | `toBeLessThan(60)` | `toBeLessThanOrEqual(ACCEPTED_BOUND)` |

```ts
const DEGRADED_REACH_BOUND = FORM_SESSION_FREE_ISSUE_LIMIT * FORM_SESSION_LIMIT   // = 30
const ACCEPTED_BOUND       = FORM_SESSION_FREE_ISSUE_LIMIT * SENDS_PER_COOKIE     // = 30
```

**なぜ `FORM_SESSION_ISSUE_LIMIT`(30) ではなく無コスト枠を基準にするのか**:
縮退では発行側の 30 が**ゲートにならない**（共有 `unknown` バケット）ので、
到達数を実際に決めているのは「**無コストで得られる Cookie 枚数** × 1 枚あたりの送信上限」である。

### 追加した 2 件（**SEC-070 の本体**）

1. **実測が上界に張り付いていること**を測る（`toBe(DEGRADED_REACH_BOUND)`）。
   上界だけを固定すると、実測が上界から離れているとき（実測 30 / 上界 90）に
   **上界と実装のどちらが動いても気付けない**。一致まで測ると
   「閾値が緩められた」と「防御が壊れた」の**両方**が同じ 1 件で赤くなる。
2. **式そのものの健全性**: `FORM_SESSION_FREE_ISSUE_LIMIT < FORM_SESSION_ISSUE_LIMIT`。
   逆転すると無コスト枠が意味を失う（印が一度も付かない）。

### これが green なら排除される退行

- `FORM_SESSION_FREE_ISSUE_LIMIT` を 10 → 19 に緩める変更が、**どのテストも赤くせずに**通ること。
  監査が明示的に「**閾値を 10 から動かす対症療法は推奨しない**（20 未満という上界があり逃げ場が無い）」
  と書いた項目であり、緩める方向の変更は必ず可視化されなければならない。

---

## 7. SEC-046 / P3c-7 — `withCronAuth` の粗い試行回数制限（**本単位が期限**）

**ファイル**: `tests/unit/cron-auth-attempt-limit.test.ts`（11 件 / **red 5 件**）

### 期限が到来した理由

`/api/cron/**` は**個人情報の削除バッチ**の起動口であり、認可は共有シークレット 1 本
（`CRON_SECRET`）だけ。`lib/cron-auth.ts:39-43` の定数時間比較は
「応答時間から 1 文字ずつ復元される」ことは防ぐが、**総当たりそのものは防がない**。
P3-a では対象バッチが無かったため繰越されたが、**P3-c は `orphan-uploads` を作る**。

### 設計上の制約（間違えると APPI 違反になる）

`lib/cron-auth.ts:14-17` の自己申告:

> 保持期間削除と orphan 回収が止まり、**APPI 違反の温床**になる（可用性が機密性に直結する例）。

Vercel Cron は安定した発信元 IP を持たないので軸は**単一のグローバルカウンタ**にならざるを得ない。
共有バケットを硬いゲートにする形は **SEC-021 → SEC-029 → SEC-030 → SEC-043 と 4 度再発**しており、
ここで 5 度目を作ってはならない。

### 採る形（`lib/login-guard.ts:129-142` と同じ意味論）

> **失敗だけを数える。成功は常に通す。**

| 性質 | 理由 |
|------|------|
| 失敗はカウンタを消費する | 総当たりを**検知**する（⚠️ **絞らない**。REV-P3C1-006 / §7.1） |
| **成功は消費しない** | 毎時走る正規バッチが自分で自分を締め出さない |
| **上限到達後も正しいトークンは 200** | 第三者が枠を叩くだけでバッチを止められない |
| 上限到達後の失敗も**同じ 404**（`Retry-After` 無し） | 404 と 429 の境目から `CRON_SECRET` の存在・窓長が判る |
| 上限到達は**ログに出る** | 出さないと制限を入れた意味が半減する（総当たりに気付けない） |
| キーは要求内容から作らない | ヘッダ/トークンを材料にすると値を変えるだけで上限を回避できる（SEC-055 と同型） |

### Impl が実装すべき契約

```ts
export const CRON_AUTH_ATTEMPT_LIMIT: number   // 粗くてよい（10 程度）
export const CRON_AUTH_WINDOW_MS: number       // 10 分程度

export interface CronAuthOptions {
  secret?: string
  /** **省略時は内蔵の既定 limiter を使う**（渡し忘れで制限が消える形を作らない / SEC-053 の教訓）。 */
  limiter?: RateLimiter
  now?: () => number
  logger?: { warn(event: string, fields: Record<string, unknown>): void }
}
```

> ⚠️ テストは `CRON_AUTH_ATTEMPT_LIMIT` を **import していない**（実装の既定値に依存しない）。
> 振る舞いテストは注入した limiter の上限で測り、「既定で有効」だけを別の 1 件で測る。

### red 5 件 / green 6 件（green は「壊してはならない」pin）

| red | 内容 |
|-----|------|
| 誤ったトークンがカウンタを消費する | `limiter` オプションが存在しない |
| 欠落・スキーマ違いも計数する | 同上 |
| キーが常に同一 | 同上 |
| 上限到達がログに出る | `logger` オプションが存在しない |
| `limiter` 省略時も制限が効く | 既定 limiter が存在しない |

green の 6 件は「成功はカウンタを消費しない」「上限到達後も正規 cron は 200」
「応答は常に 404 / `Retry-After` 無し」「未設定は fail-closed」「Origin 無しでも通る」——
**試行制限を足したあとも成立し続けなければならない性質**である。

---

### 7.1 ⚠️ これは「抑制」ではなく「**検知**」である（REV-P3C1-006 / 記述の訂正）

上の 3 つ（成功は常に通す / 上限後も正しいトークンは 200 / 応答は常に同じ 404）を
**同時に満たす実装では、上限に達しても攻撃者の体験は 1 ミリも変わらない。**
正しいトークンを常に通す以上、毎回トークン比較を実行しなければならず、
**推測の試行回数も速度も一切制限されない。上限到達時に起きるのはログ 1 行だけ**である。

当初この項目を「総当たりを**絞る**」と記述したが、**それは誤りだった。**
監査 ID をそのまま「試行回数制限を入れた」として閉じると、次の監査が
「`/api/cron/**` は総当たりに対して上限がある」と読む——**そこには上限が無い。**
P3-c は `orphan-uploads`（写真の削除バッチ）を足すので、この誤読は高くつく。

> **本ラッパは総当たりの速度を落とさない。** 抑制は `CRON_SECRET` の長さ
> （`lib/env.ts:21` の 32 文字下限）とプラットフォーム側の流量制御に依存する。
> 本ラッパが足すのは**観測**（いつ・どれだけ叩かれたかが分かること）である。

それでも入れる価値がある理由: 総当たりは**気付けなければ止められない**。
現状は `CRON_SECRET` に対する試行が**どこにも記録されない**ので、
攻撃が成功するまで（＝ 個人情報が削除されるまで）誰も知り得ない。

**テストの構成は変えていない**（要求そのものは妥当というレビューの判定に同意する）。
変えたのは**記述と、その記述が生む誤読**である。

---

## 8. SEC-064 / P3c-8 — `PrismaClient` のエラーログを `lib/pii-log.ts` の 1 点へ合流

**ファイル**: `tests/unit/prisma-error-log.test.ts`（13 件 / **red 12 件**）

### 何が漏れているのか

`lib/db.ts:13-15` は `new PrismaClient({ log: ['error'] })`。
この形の `log` は **Prisma が自分で stdout/stderr へ書く**指定であり、**アプリのロガーを一切通らない**。
そして Prisma の例外メッセージは**値を含む** —— `lib/pii-log.ts:80-84` の自己申告:

> Prisma の一意制約違反は `Unique constraint failed on the fields: (...)` のように**値を含む**
> メッセージを返す。それを `logger.error('db', { error })` でそのまま出すのが**最も起きやすい漏えい**である。

`lib/pii-log.ts` は「**通る場所を 1 つにして落とす**」ために作られたが、
**Prisma の直接出力はその 1 点を迂回している。**
`app/api/applications/route.ts:313` が `toErrorLogFields(error)` で丁寧に落としている隣で、
同じ例外の生メッセージが Prisma 自身によって既にログへ出ている。

### なぜ P3-c2 の「前」なのか

P3-c2 は `LicensePhoto`（`objectKey` / `uploadToken`）を DB に持つ。
`objectKey` は `PII_DENY_KEYS` に列挙済み（`lib/pii-log.ts:52`）だが、
**Prisma の直接出力はその列挙を参照しない。**
署名付き URL の材料が運用ログに残ることは AC-PII-1 違反であると同時に、
**写真そのものへの到達経路**になる。

### Impl が実装すべき契約

```ts
// lib/db.ts
export interface PrismaLogEvent { message?: string; target?: string; timestamp?: Date }

/** イベントを**ログ可能なフィールドだけ**に落とす。**`message` を返してはならない。** */
export function prismaErrorLogFields(event: PrismaLogEvent): { errorCode: string; target?: string }

/** `$on('error' | 'warn')` を張る。テストからフェイクを差し込めるよう関数として分離する。 */
export function attachPrismaLogging(
  client: { $on(level: 'error' | 'warn', callback: (event: PrismaLogEvent) => void): void },
  logger: AppLogger,
): void

// PrismaClient は **イベント方式**で構築する:  log: [{ emit: 'event', level: 'error' }, ...]
```

**`message` を「サニタイズして残す」形にしないこと。** どの値がメッセージのどこに現れるかは
Prisma のバージョンとエラー種別に依存し、列挙で追随できない。
`lib/pii-log.ts:85-96` の `toErrorLogFields` が既に採った判断（「**`message` も `stack` も返さない**」）と揃える。

### 落とすもの / 残すもの

| | 扱い |
|---|---|
| `message` | **返さない**（値を含む） |
| `errorCode`（`P2002` 等をメッセージから抽出） | 残す。読み取れなければ `UNKNOWN` |
| `target`（`prisma.application.create`） | 残す。ただし**形式検査を通す**（識別子とドットのみ） |

**過剰な秘匿は運用不能を招く**（`lib/pii-log.ts:22-23`）ので「何も出さない」は正解ではない。

### ⚠️ 空振りしていた assertion を締めた記録

ソース検査を最初 `/log\s*:\s*\[\s*['"](error|warn)['"]/` で書いたところ **green になった**。
現行の `lib/db.ts:14` は
`log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']`
という**三項演算子**なので、`log:` の直後が `[` ではなくパターンが一致しなかったためである。
**配列リテラルそのものを見る形**（`/\[\s*(['"](error|warn|query|info)['"]\s*,?\s*)+\]/`）に直し、
red であることを実測で確認した。**空振りしているテストを green として報告しない**（申し送り原則 4）。

---

## 9. SEC-065 / P3c-10 — `/privacy` に発信元 IP の保持を追記し `RETENTION_PERIODS` へ載せる

**ファイル**: `tests/unit/retention-client-ip.test.ts`（7 件 / **red 5 件**）

### 何が抜けているのか

`/privacy` §1「取得する個人情報」はフォームの入力項目しか挙げていないが、
実装は**発信元 IP を実際に保持している**——レート制限のカウンタキー
（`rateLimitKey('applications:', <IP>)` / `rateLimitKey('apply:fs-issue:', <IP>)` /
`auth.ts:74` のログイン IP 軸）として、**ウィンドウの長さだけ**インメモリまたは KV に残る。

### `lib/retention.ts` に載せる理由（同ファイル :4-7 の自己申告）

> **`/privacy` の本文も、P3-c / P3-d の削除バッチも、必ずここを参照する。**
> 保持期間を画面に直書きすると「利用者に約束した期間」と「実装が実際に削除する期間」が
> 食い違いうる。**APPI 上はこの食い違いそのものが不履行になる。**

IP だけを画面に直書きすると、**レート制限の窓を変えた瞬間に約束が嘘になる。**

### Impl が実装すべき契約

```ts
// lib/retention.ts
/** 発信元 IP（レート制限カウンタのキー）の保持分数。**IP を含む全カウンタの最長窓以上**であること。 */
clientIpMinutes: 10,
```
`/privacy` は `RETENTION_PERIODS.clientIpMinutes` を**描画**し、
「IP アドレスを不正送信対策のために一時的に保持する / 生の IP を DB には保存しない」ことを述べる。

### 「載せた」で終わらせないための 3 件

1. **値が実装の窓と一致する**（`clientIpMinutes * 60_000 === FORM_SESSION_ISSUE_WINDOW_MS`）。
   載せた値が実装より短ければ、「10 分で消します」と書きながら実際は長く持つ不履行になる。
2. **IP をキーにする他のカウンタの窓が `clientIpMinutes` を超えない**
   （`app/api/applications/route.ts` の `RATE_WINDOW_MS` / `auth.ts` の `LOGIN_IP_LIMITER` をソースから読む）。
   誰かが `windowMs: 60 * 60_000` の IP 軸を足したら赤くなる。
3. **スキーマに IP 列が無い**（`prisma/schema.prisma` を走査）。
   「一時的にしか持たない」という記述が嘘になる変更を検出する。

---

## 10. SEC-063 / P3c-9 — **P3-c1 では対応しない（繰越）**。ただし契約の誤りは訂正する

**当初 `tests/unit/kv-rate-limit-saturation.test.ts`（6 件 / red 1 件）を置いたが、削除した。**

### 繰り越す判断の理由

Senior レビュー（REV-P3C1-004）が**契約の誤り**を指摘し、繰り越しを推奨した。**その指摘は正しい。**

#### (1) 当初の契約はレート制限を無効化する

当初「`limit` 以上なら INCR を発行しない。**`count` は現在値をそのまま返す**」と書いた。
KV 経路の判定は `lib/rate-limit.ts:369-373` の
`toResult(entry.count, entry.resetAt, entry.count <= limit, now)` である。
`limit = 3` で 4 回目に「現在値 3 をそのまま返す」と **`3 <= 3` ⇒ `success: true`**。
以後の全リクエストが同じく `true` になり、**KV 経路（＝ 本番だけ）のレート制限が完全に消える。**

インメモリ経路（同 :382-385）は `current.count >= limit` を**自分で判定してから**返すので
同じ「count は limit で止まる」でも成立するが、KV 経路は判定を外に置いているため成立しない。
**2 つの store で `count` の意味が違う**ことを見落としていた。

> **訂正後の正しい契約**: INCR は発行しないが、返す `count` は **`current + 1`（試行後の値）**。
> 判定 `count <= limit` を成立させ続けるため。

#### (2) 素朴な実装では費用がむしろ悪化する

現行の KV 実装は 1 リクエスト = `INCR` 1 回である。抑制のためには先に `GET` が要るので、
**飽和していない通常時は往復が 1 → 2 に増える。**
SEC-063 が問題にした「Upstash への課金」は**むしろ悪化しうる**
（減るのは書き込み増幅とキー値の膨張だけ）。

Lua（`EVAL`）で 1 往復に畳めば費用の問題は消える（`KvRateLimitClient` に `eval` を足せばよい。
`createUpstashKvClient` は既に `eval` を返しており、`lib/semaphore.ts` が使っている）。
しかしそうすると**テスト側のフェイク Redis が Lua を解釈できない**ため、
`incr` の呼び出し回数という観測手段が使えなくなり、
**実装非依存の観測点を別途設計する必要がある**（例: フェイクに保持されたカウンタ値の上界）。

これは「任意・優先度低」の項目に対する投資として**割に合わない**。

### 繰り越しの条件（**黙って落とさないこと**）

`docs/security-audit.md` の **P3c-9 の行に「P3-c1 では対応しない」と明記**すること。
黙って落とすと、次の監査で**同じ指摘が新規として再起票される**（P3c-13 が
「P1 から 4 単位連続で未対応」になっているのと同じ経路）。

繰越先で実装する際は、上の**訂正後の契約**（`count` は `current + 1`）から始めること。
訂正前の記述をそのまま実装すると、**本番限定で全面的なレート制限喪失**になる。

---

## 11. まとめ — ID ↔ テスト対応表と red の実測

### 実測（`pnpm test:unit` / `pnpm test:integration`。**ポート 3000 に触れるコマンドは未実行**）

| ゲート | P3-b 完了時 | 本単位（再検収レビュー反映後） |
|--------|--------|--------|
| `pnpm test:unit` | 47 ファイル / **720 件** 全パス | 54 ファイル / **826 件**（**54 failed** / 772 passed） |
| `pnpm test:integration` | 8 ファイル / **76 件** | 9 ファイル / **86 件**（**4 failed** / 82 passed）。**3 回連続で同一結果** |
| `pnpm build` / `pnpm test:e2e` | — | **未実行**（オーケストレーターの担当） |

**既存 720 unit / 76 integration は 1 件も落ちていない**（既存 47 unit ファイルは全パス）。
red は**すべて新規に追加した契約**である。

### ID ↔ テストファイル ↔ red 件数

| ID | テストファイル | 件数 | red | 主要な contract |
|----|--------------|------|-----|----------------|
| **SEC-058** / P3c-2 | `tests/unit/public-guard-construction-p3c.test.ts` | 9 | **3** | 半端な軸構成 5 通りを構築時 throw。(0)/(e)/(f) は throw しない |
| **SEC-060** / P3c-4 | `tests/unit/application-error-classification.test.ts` | 11 | **3** | `courseId` 不在 → 422 / **`courseId` 由来の** `P2003` → 422 / それ以外は 500 |
| **SEC-060** / P3c-4 | `tests/integration/application-course-fk.int.ts` | 4 | **2** | 実 DB の外部キー制約に対する本番経路の実測 |
| **SEC-061 / SEC-069** / P3c-5 | `tests/unit/trust-proxy-env.test.ts` | 24 | **11** | `TRUST_PROXY` + **provenance によるヘッダ信頼の限定**（`x-vercel-forwarded-for` / **左端 XFF** の両方） |
| **SEC-067 / SEC-068** | `tests/unit/form-session-degraded-recovery.test.ts` | 29 | **15** | `challengeToken`（増幅率 1 / TTL / 上界）/ `hasVerifiedSession` は**発行しない** / **更新窓** / 印の不可読化 |
| **SEC-067（結線）** | `tests/integration/form-session-route.int.ts`（既存に 6 件追加） | 17 | **2** | **本番ルートが `hasVerifiedSession` を渡す**（NEW-001） |
| **SEC-070** | `tests/unit/form-session-issue-cost.test.ts`（既存を改訂 +2 件） | 9 | 0 | 上界を定数から計算し、実測が上界に張り付くことまで測る |
| **SEC-070** | `tests/integration/form-session-cost.int.ts`（既存を改訂） | 2 | 0 | 同上。厳密一致を避けた理由をコメントに明記 |
| **SEC-046** / P3c-7 | `tests/unit/cron-auth-attempt-limit.test.ts` | 11 | **5** | 失敗だけ数える / 成功は常に通す / 応答は常に 404。**抑制ではなく検知** |
| **SEC-064** / P3c-8 | `tests/unit/prisma-error-log.test.ts` | 13 | **12** | Prisma のログを `lib/pii-log.ts` へ合流。`message` を返さない |
| **SEC-065** / P3c-10 | `tests/unit/retention-client-ip.test.ts` | 7 | **5** | `clientIpMinutes` を定数へ。**IP 軸の最長窓と一致**することまで測る |
| **SEC-063** / P3c-9 | — | — | — | **繰越**（§10）。契約の誤りは訂正済み |
| **REV-P3C1-005 / NEW-007** | `news.int.ts` / `news-admin.int.ts` / `tests/fixtures/test-rows.ts` | 16 | 0 | **相互汚染の解消**（§13）。接頭辞は共有 fixture へ |
| **SEC-059** / P3c-3 | — | — | — | **対象外**（P3-b の RV-P3B-006 でクローズ済み。§1） |

合計: **新規 7 ファイル + 新規 fixture 1 + 既存 5 ファイル改訂 / 追加 106 unit + 10 integration / red 54 + 4**。

---

## 12. 実装者への申し送り

### 12.1 着手順（依存関係と「安さ」の順）

1. **SEC-058**（`lib/public-guard.ts` の構築時検査）— 他に影響しない。**最初にやる**。
   P3-c2 で `uploads` を書き始める前でなければ意味が薄れる。
2. **SEC-061 / SEC-069**（`TRUST_PROXY`）— **SEC-067 の被害範囲を先に縮める**ので早いほどよい。
   `lib/env.ts` + `lib/http-guard.ts` + `lib/http-guard.ts` のコメント + `docs/tech-stack.md` §4.5。
3. **SEC-064**（Prisma ログ）— `lib/db.ts` に閉じる。**P3-c2 で `objectKey` を扱う前に**。
4. **SEC-060**（`courseId` 分類）— `app/api/applications/route.ts` に閉じる。
5. **SEC-046**（cron 試行制限）— `lib/cron-auth.ts` に閉じる。**本単位が期限**。
6. **SEC-065**（`/privacy` + `RETENTION_PERIODS`）— 文言変更が主。
7. **SEC-067 / SEC-068**（回復経路 + 印の不可読化）— **最も設計判断が要る。§12.2 を必ず読むこと**。
8. **SEC-063 — 本単位では実装しない（繰越済み）。** 契約の誤り（`count` は `current + 1`）は
   §10 に訂正して残してある。`docs/security-audit.md` の P3c-9 行への明記は**対応済み**
   （オーケストレーターが実施）。**着手しないこと**——中途半端に実装すると
   §10 (1) の経路で**本番限定のレート制限喪失**になる。

### 12.2 SEC-067 の実装で**やってはいけない**こと（3 つ）

1. **閾値（`FORM_SESSION_FREE_ISSUE_LIMIT = 10`）を動かして「直った」ことにしない。**
   監査が明示的に非推奨としている。20 未満という上界があり逃げ場が無い。
   `tests/unit/form-session-degraded-recovery.test.ts` の
   「攻撃コストは SEC-057 より安い」pin と、§6 で締めた上界の両方が同時に赤くなる。
2. **印の判定をハンドラ内（Turnstile の後）へ移さない。** それは **SEC-057 を再び開く**——
   `form-session-issue-cost.test.ts` / `form-session-cost.int.ts` は Turnstile を「常に通過」として
   測るため、到達数が Cookie 枚数に比例して戻る。**コストは発行の時点で払わせること。**
3. **`challengeToken` にクライアントの自己申告を「検証済み」として渡さない。**
   ルート側で `verifyTurnstile` を実行し、**成功したときだけ**そのトークンを渡すこと。
   ボディの値を無検証で流すと、印が 1 行で無効化される。
   併せて **`verifyTurnstile` の結果を再利用しない**（トークンは 1 リクエスト 1 回。
   siteverify の重複トークン拒否に依存する場合はその旨をコメントに残すこと / REV-P3C1-002）。
4. **`hasVerifiedSession` を「枠を消費しないが発行はする」形で実装しない**（REV-P3C1-001 / §4.1）。
   **枠の免除に上界が無ければ、枠は存在しないのと同じ。** 素朴な実装では
   本番配線での到達数が **600 回（上界 30 の 20 倍）**に達することを実測済みである。
   `tests/unit/form-session-degraded-recovery.test.ts` の pin ①②③ がこれを捕捉する。

### 12.3 結線のスコープ — **`hasVerifiedSession` は P3-c1 / 回復経路は P3-c2**

> ⚠️ **節名を「自己維持の切断は P3-c1」から変えた**（Security 監査 §1.5 / 2026-07-29）。
> `hasVerifiedSession` の結線は P3-c1 で完了したが、**それでは自己維持は切れない**（§4 冒頭の訂正）。
> **SEC-067 本体（印による締め出しとその自己維持）の是正は P3-c2 のスコープである。**

**NEW-001 を受けて書き分けた。** 当初はどちらの結線も P3-c2 へ送っていたが、
それでは「P3-c1 完了時点で SEC-067 は 1 ミリも閉じない」のに §4 が「閉じる」と書いている
という**記録の不正確さ**が残る。

| 結線 | 単位 | 理由 |
|------|------|------|
| **`hasVerifiedSession`** | **P3-c1**（本単位 / 完了） | **UI に依存しない。** `app/api/form-session/route.ts` が受信 Cookie を検証して渡すだけ。結合 pin は `tests/integration/form-session-route.int.ts`（§4.2）。**閉じたのは REV-P3C1-001 の収穫経路であり、自己維持ではない** |
| `challengeToken`（回復経路） | **P3-c2** | UI の導線（Turnstile ウィジェットの表示・再送のタイミング / RV-P3B-009 の「Tier B が 2 回続くと電話番号を表示」との整合）と一体で決まる |

ユニット契約は「`issueFormSession` に `challengeToken` を渡せば印の無い Cookie が出る」までを固定した。
**どのルートがそれを呼ぶか**（`POST /api/form-session` を足す / 既存 GET に検証済みトークンの受け口を足す 等）は
UI 側の回復導線（RV-P3B-009 の「Tier B が 2 回続くと電話番号を表示」との整合）と一体で決まるため、
**P3-c2 の UI 設計と同時に確定するのが安い**。結線が決まった時点で、
`tests/integration/` に「攻撃者が枠を使い切る → 被害者がチャレンジを通して 201」を
**本番 2 ルート跨ぎ**で測る結合テストを 1 本足すこと
（`tests/integration/form-session-cost.int.ts` が SEC-057 に対して行った形と同じ）。
**ユニットだけで完了としないこと**——SEC-057 が見逃された原因は
「個々の測定は正確だが、攻撃者の手順として結合されていない」ことだった。

### 12.4 型検査について

`pnpm type-check` は**実装が入るまで red** である（テストが未実装の API を参照しているため）。
不足している export / オプションは以下がすべて:

| モジュール | 不足しているもの |
|-----------|----------------|
| `lib/env.ts` | `TRUST_PROXY`（スキーマ） |
| `lib/form-session-issue.ts` | `IssueFormSessionOptions.hasVerifiedSession` / `.challengeToken` / `.usedChallengeTokens`、`FormSessionIssueResult` の `reason` 判別子 |
| `lib/cron-auth.ts` | `CronAuthOptions.limiter` / `.now` / `.logger`、`CRON_AUTH_ATTEMPT_LIMIT` / `CRON_AUTH_WINDOW_MS` |
| `lib/db.ts` | `prismaErrorLogFields` / `attachPrismaLogging` / `PrismaLogEvent` |
| `lib/retention.ts` | `RETENTION_PERIODS.clientIpMinutes` |
| `lib/form-session.ts` | `FORM_SESSION_RENEW_BEFORE_MS` / `isFormSessionRenewable`（NEW-003） |
| `lib/form-session-issue.ts`（定数） | `CHALLENGE_TOKEN_TTL_MS` / `CHALLENGE_TOKEN_MAX_ENTRIES`（NEW-004） |
| **`app/api/form-session/route.ts`** | **`hasVerifiedSession` の受け渡し**と `reason` による分岐（NEW-001）。現行 :124-133 は `!result.issued` で `result.retryAfterMs` を**無条件に読む**ため、判別可能 union の導入で `pnpm type-check` が落ちる（silent には壊れない） |
| `lib/public-guard.ts` | （export の追加なし。検査条件の拡張のみ） |

### 12.5 P3-c2 へ持ち越す（本単位では**やらない**）

- **F-009 本体**（P3c-11）: 署名付き URL の有効期限 / `objectKey` の推測不可能性 /
  マジックバイト検証 / orphan 回収バッチ / アップロード UI。
- **`maxBodyBytes` の引き上げ**: 写真アップロードは 64KB では足りない。
  引き上げる際は**上げた値で `tests/unit/public-guard-body-stream.test.ts` を回すこと**
  （現在は既定値でしか測っていない / §1 の注記）。
- **RV-P3B-019**（送信成功の E2E が 1 本も無い）: 再監査 §5 申し送り 2 が
  「**枠を env で緩める形で解いてはならない**」と明記している。
  SEC-067 の回復経路（§12.3）が入れば、E2E は「チャレンジを通して送信成功」の形で書ける。
  **E2E の設計は P3-c2 の UI と同時に行う。**
- **P3c-12**（`semaphore-contract.ts` にメモリ版セマフォ）/ **P3c-13**（CI へ `pnpm audit`）。

### 12.6 uploads を書くときに**そのまま効く**もの

再監査 §5 の申し送り 1 に同意する:

> **`uploads` エンドポイントは `verifyFormSessionValue` を Tier B 判定にそのまま使うこと。**
> 独自の Cookie 判定を書かないこと。

SEC-067 の修正（回復経路）を正典関数に閉じてあるので、**uploads にも自動的に波及する。**
裏返しに、**印による Tier B も uploads へそのまま波及する**——
写真アップロードは申込フォームより滞在時間が長く、Cookie 寿命（30 分）との競合が起きやすい。
`tests/unit/public-guard-construction-p3c.test.ts` の構成表 (e) を許してあるのは、
uploads が独自の軸構成を選べるようにするためである（ただし**半端な構成は許さない**）。

---

## 13. REV-P3C1-005 — `news` の相互汚染（**本単位で直した**）

### 判定の変更

当初は「本単位のスコープ外 / 記録として残す」としたが、Senior レビューの判定に従い
**P3-c1 のスコープで直した。** 理由（レビューより）:

1. P3-c1 の完了条件は「既存 76 件に退行が無い」である。
   **その判定が確率的にしか下せない状態では、ゲートそのものが機能しない。**
2. 修正はテストのみ・数行で、実装コードにも仕様にも触れない。
3. P3-c1 は integration ファイルを 8 → 9 に増やす。
   **並列度が上がるほどレースの発火確率は上がる**ので、本単位が原因で顕在化しやすくなる。

### ⚠️ 当初の診断は**範囲が不足していた**（レビューの補正が正しい）

当初「`news.int.ts:61` が DB 全体の PUBLISHED 件数を数えており、`news-admin.int.ts` に汚される」
と書いたが、**実際は範囲が広く、しかも汚染は相互である。**

| 汚染の向き | 実体 |
|---|---|
| `news.int.ts` → `news-admin.int.ts` | `news.int.ts:150-158`（`【テスト-GATE】直近の公開済み`）が **`publishedAt: now - 1分` の PUBLISHED 行**を作る → `news-admin.int.ts:114`（`listPublishedNews().length === 6`）を汚す |
| `news-admin.int.ts` → `news.int.ts` | `news-admin.int.ts:117-119` が `publishedAt: 2026-07-20` の行を作る → `news.int.ts:26` の**順序**の assertion（先頭は 2026-07-15）を汚す。**件数だけでなく順序も壊れる** |

### 修正（両側とも「seed 行だけ」を対象にする）

```ts
// news.int.ts
export const TEST_ROW_PREFIX = '【テスト'
const SEED_PUBLISHED = { status: 'PUBLISHED', NOT: { title: { startsWith: TEST_ROW_PREFIX } } }
// → 件数・順序の両方をこの where 経由にする

// news-admin.int.ts（listPublishedNews は where を受け取らないので結果を絞る）
const seedOnly = publicList.filter((n) => !n.title.startsWith('【テスト'))
```

> ⚠️ **接頭辞は `'【テスト】'` ではなく `'【テスト'`。**
> 閉じ括弧まで含めると `news.int.ts:124` の **`【テスト-GATE】` がすり抜ける**——
> そしてその describe が作る PUBLISHED 行こそが `news-admin.int.ts` を汚す張本人である。
> レビューの改善案（`startsWith: '【テスト】'`）をそのまま採ると**直りきらない**。
> 実装時にソースを読んで気付いた差分であり、ここに記録しておく。

**`fileParallelism: false` では直していない**（レビューの指示どおり）。
レースを隠すだけで CI が遅くなり、同型の欠陥が今後も足され続ける。

### 実測

`pnpm test:integration` を **3 回連続**で実行し、**3 回とも `2 failed / 78 passed`**
（＝ P3-c1 の意図した SEC-060 の red のみ）に収束した。修正前は 3 回中 1 回が 4 failed だった。

### `docs/phase-status.md` への追記（**オーケストレーターへの依頼**）

P3-b 完了記録の「integration 8 ファイル / 76 件 全パス」に、次を追記すること:

> **この全パスは並列ワーカー間のタイミングレースの影響下で観測されたものである
> （P3-c1 の REV-P3C1-005 で是正）。** 2 ファイルだけを走らせると 3 回とも green になるため、
> 負荷が低い環境では窓が開かない。

過去の記録を「嘘だった」ことにせず、**観測条件を残す**のが正しい
（当初「実行順序に依存した観測だった可能性」と書いたが、正確には**実行順序ではなく
並列ワーカー間のタイミングレース**である。これもレビューの補正が正しい）。

---

## 14. Senior レビュー（`docs/review-p3c1-tests-2026-07-29.md`）への対応

### Must Fix（5 件）

| ID | 内容 | 対応 | 反映先 |
|----|------|------|--------|
| **REV-P3C1-001** | `hasVerifiedSession` が SEC-057 を再び開く | **契約を「消費しない」→「発行しない」へ作り直し**、pin を 3 本追加。素朴な実装で red になることを**実測**（到達数 600 = 上界の 20 倍） | §4 / §4.1 / `form-session-degraded-recovery.test.ts` |
| **REV-P3C1-002** | `challengePassed` の増幅率が契約に無い | boolean を廃止し **`challengeToken`（同一トークンの再利用を弾く）**へ。`usedChallengeTokens` 差し替え口も契約に追加 | §4 / §4.1 / 同上（3 件追加） |
| **REV-P3C1-003** | `TRUST_PROXY=1` が `x-vercel-forwarded-for` の偽装を許す | **provenance によるヘッダ信頼の限定**を契約に追加（6 件）。ルートが `trustProxy` を渡さないことも pin。**§3 の誤った記述を訂正** | §3 / `trust-proxy-env.test.ts` |
| **REV-P3C1-004** | SEC-063 の store 契約が誤り | **繰越に変更**（テストファイルを削除）。**契約の誤りは §10 に訂正して残した**（`count` は `current + 1`） | §10 |
| **REV-P3C1-005** | `news` の flaky は本単位で直す | **両ファイルを修正。3 回連続で 2 failed / 78 passed に収束**。接頭辞はレビュー案の `'【テスト】'` ではなく **`'【テスト'`** でなければ直りきらない（理由は §13） | §13 / `news.int.ts` / `news-admin.int.ts` |

### Should Fix（5 件）

| ID | 内容 | 対応 |
|----|------|------|
| REV-P3C1-006 | cron の「試行回数制限」は抑制ではなく検知 | §7.1 として記述を訂正。テスト構成は据え置き（レビューの判定に同意） |
| REV-P3C1-007 | `clientIpMinutes` の等値 pin が過剰拘束 | 「**IP 軸の最長窓と一致**」へ変更。窓は実装から読み取って比較（`ipKeyedWindowsMs()`） |
| REV-P3C1-008 | `P2003 → courseId` 固定は 2 本目の外部キーで誤分類 | `meta.field_name` で分岐する契約へ。**「別の外部キー由来は 500」「判別不能も 500」の 2 件を追加** |
| REV-P3C1-009 | `TRUST_PROXY` の検証経路が 2 本に割れる | `resolveClientIp` 側でも不正値が false になることを 1 件 pin |
| REV-P3C1-010 | `TypeError` で落ちる red は assertion 未検証 | §12 に申し送りを追加（下記） |

### Nit（3 件）

| ID | 対応 |
|----|------|
| REV-P3C1-011 | int 側に厳密一致 pin を置かない理由をコメントに明記（実時刻の固定ウィンドウを注入できないため構造的に flaky になる） |
| REV-P3C1-012 | `minutes` が数値でない場合は**明示的に fail**させ、正規表現に `(?<![0-9])` を追加（`180日` の `0` への誤爆を防ぐ） |
| REV-P3C1-013 | 既定 limiter がモジュール大域である旨を契約に明記し、テストは `now` の注入で**専用の窓へ退避**するよう変更 |

### REV-P3C1-010 の申し送り（§12 への追加項）

> **`TypeError` で落ちている red は、実装後に「意図した理由で green になったか」を必ず確認すること。**
> 具体的には、実装を入れた直後に**一度わざと壊した実装**（例: `prismaErrorLogFields` が `message` を返す版）
> にして当該テストが red になることを見る——**assertion が実際に効いていることの確認**である。
>
> 対象は `tests/unit/prisma-error-log.test.ts` の 9 件（`... is not a function` で落ちているもの）。
> 未実装だから落ちていることは正しいが、**その assertion が正しく書けているかは未検証**である。
> 同じ配慮は `application-error-classification.test.ts:93-98`（`create` の既定 mock）と
> `application-course-fk.int.ts`（`not.toContain` の前にステータスを固定）で既に実施している。
>
> 本単位では **REV-P3C1-001 の 3 本の pin についてこの確認を実際に行った**（§4.1 の実測表）。
> 同じ手順を実装フェーズで残りにも適用すること。

### レビューに反論する点

**無い。5 件の Must Fix・5 件の Should Fix・3 件の Nit すべてについて指摘が正しいと判断した。**

特に REV-P3C1-001 と REV-P3C1-003 は、**こちらが「SEC-057 を開かない」「制限が強くなる方向にしか
動かない」と明示的に主張した箇所が、いずれも成立していなかった**ものである。
どちらも「受け口を足したが、その受け口の**悪用**を測っていない」という同じ型の見落としだった。

1 点だけ**補正**がある（反論ではない）: REV-P3C1-005 の改善案にある
`startsWith: '【テスト】'` は、`news.int.ts:124` の `【テスト-GATE】` を**捕まえられない**。
そして汚染の主犯はまさにその describe が作る PUBLISHED 行なので、
案のまま実装すると**直りきらない**。接頭辞を `'【テスト'` にして修正・実測した（§13）。

### 再レビュー条件の充足状況

| 条件 | 状況 |
|------|------|
| 1. REV-001/002/003/004/005 が反映されている | ✅ 上表のとおり |
| 2. REV-001 の 3 本の pin が「修正前 red / 修正後 green」であることを実測 | ✅ §4.1 の表（50 枚 / 200 枚 / 600 回）。**実験用パッチは revert 済み**（`lib/form-session-issue.ts` に変更は残っていない） |
| 3. `pnpm test:integration` を 3 回連続、失敗が意図した red のみに収束 | ✅ **3 回とも 2 failed / 78 passed**（SEC-060 の 2 件のみ） |

---

## 15. 再検収レビュー（`docs/review-p3c1-tests-re-2026-07-29.md`）への対応

### Must Fix（1 件）

| ID | 内容 | 対応 |
|----|------|------|
| **NEW-001** | `hasVerifiedSession` の結線が無く、P3-c1 完了時点で SEC-067 が閉じない | **改善案 (A) を採用**（オーケストレーターの決定）。`tests/integration/form-session-route.int.ts` に 6 件追加（red 2 件）。§4.2 / §12.3 / §12.4 を実態に合わせて書き直した |

### Should Fix（5 件）

| ID | 内容 | 対応 |
|----|------|------|
| NEW-002 | `already-verified` が「計数は常に行う」invariant を破る | **別キーで計数する**契約を追加し pin を 1 件（`fs-issue` を消費しないことまで測る） |
| NEW-003 | 有効 Cookie があると更新しないので 30 分で失効 | **更新窓**（`FORM_SESSION_RENEW_BEFORE_MS` / `isFormSessionRenewable`）を契約に追加し pin を 4 件。判定は正典モジュールに置く（AC-RL-8） |
| NEW-004 | `usedChallengeTokens` に上界・TTL の契約が無い | `CHALLENGE_TOKEN_TTL_MS`（≤ 300 秒 = Turnstile のトークン有効期間）/ `CHALLENGE_TOKEN_MAX_ENTRIES` を契約に追加し pin を 2 件 |
| **NEW-005** | `x-forwarded-for` の**左端採用**で append 構成では偽装が通る | **env provenance では `x-real-ip` を優先**する契約を追加し pin を 4 件。ソース pin も「append への言及」まで強めた |
| NEW-006 | §4 に却下された契約が残っている | §4 の表・件数・red 内訳・§12.1-8・§12.3・§12.4 を新契約へ更新（§4.1 は履歴として保持） |

### Nit（1 件）

| ID | 対応 |
|----|------|
| NEW-007 | 接頭辞を `tests/fixtures/test-rows.ts` へ切り出し、両ファイルから import（**リテラルの二重管理を解消**） |

### MF-004 の残作業

`docs/security-audit.md` P3c-9 への明記は**オーケストレーターが実施済み**。
本単位では §12.1-8 の旧記述（「余力があれば」）を「**着手しないこと**」へ訂正した。

---

### レビューに反論する点

**無い。Must Fix 1 件・Should Fix 5 件・Nit 1 件すべて指摘が正しいと判断した。**

NEW-001 は特に重い。前版は「正典関数の契約を固定した」ことをもって
**§4 の結論に「閉じる」と書いてしまった**が、結線が無い以上それは達成されない。
「受け口の悪用を測っていない」（REV-P3C1-001）を直した直後に、
今度は「**受け口が呼ばれることを測っていない**」で同じ型を踏んでいた。

### 補正・追加が 2 件（反論ではない）

1. **NEW-005 のソース pin は `/append|上書き/` では空振りする。**
   `lib/http-guard.ts:98-99` には既に「上書きすることを確認したうえで」という文言があり、
   実装前から green になってしまう。**`append` という危険側の語**を要求する形に締め、
   red であることを実測で確認した（申し送り原則 4）。
2. **NEW-007 の対象は 1 箇所ではなく 2 箇所だった。**
   レビューが挙げた `news-admin.int.ts:131` に加え、**同ファイル :161**
   （`expect((await listPublishedNews()).length).toBe(SEED_COUNTS.news.published)`）も
   **DB 全体を数えていた**（レビュー未指摘）。同型の欠陥なので併せて修正した。
   これを残すと `news.int.ts` の `【テスト-GATE】` 行に汚染され、レースが戻る。

### REV-P3C1-005 の「観測の妥当性」への同意

レビューの指摘（**反復回数は証拠として弱い**）に同意する。
差し戻し前の発火率は約 1/3 だったので、3 回連続 green は偶然でも約 30% で起きる。
**判定を支えているのは機構のほうである**——
「両側の assertion が他ファイルの行を読まなくなった」ことをソースで確認できる。
本節でも 3 回連続の実測を報告しているが、**根拠として提示すべきは機構であり、
反復回数は補助的な確認にすぎない**と明記しておく。

### 再々レビュー条件の充足状況

| 条件 | 状況 |
|------|------|
| 1. NEW-001 が (A) で解決 | ✅ 結線 pin 6 件（red 2 件）+ §4.2 / §12.3 / §12.4 の書き直し |
| 2. NEW-006 の記述整合 | ✅ §4 の表・件数・red 内訳・§12.1-8・§12.3・§12.4 |
| 3. MF-004 の残作業 | ✅ オーケストレーターが `security-audit.md` へ実施済み。§12.1-8 も訂正 |
| 4. NEW-002〜005 は Should Fix（採らない場合は理由を残す） | ✅ **4 件すべて採用**したので「採らない理由」は不要 |
