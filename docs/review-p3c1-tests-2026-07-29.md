# コードレビュー: P3-c1（前提ハードニング）テスト設計

## レビュー日: 2026-07-29
## 対象Phase: テスト
## レビュワー: Senior Engineer Agent（`.claude/skills/senior-review.md`）
## 対象: `docs/test-design-p3c1-2026-07-29.md` + 新規 8 テストファイル + 改訂 2 ファイル

---

## 総合評価: **Request Changes**

- 改善必須（Must Fix）: **5 件**
- 改善推奨（Should Fix）: **5 件**
- Nit: 3 件

差し戻し先は **Test Agent（設計文書 + テスト）** であり、実装は開始してよい項目と待つべき項目が混在する。
着手順は §「差し戻しの範囲」を参照。

---

## 0. 自分で実測したこと（レビューの根拠）

**ポート 3000 に触れるコマンド（`pnpm build` / `test:e2e` / `dev` / `start`）は一切実行していない。**

| 実行 | 結果 |
|------|------|
| 新規 7 ファイル + 改訂 1 ファイル（unit / 82 件） | **38 failed / 44 passed**。設計文書 §11 の red 内訳（3+7+5+5+5+1+12 = **38**）と一致 |
| 各 red の失敗理由を個別に確認 | **38 件すべてが主張どおりの理由で落ちている**（詳細は §1） |
| `tests/integration/application-course-fk.int.ts` 単独 | **2 failed / 4**（主張どおり）。現行は実 DB で **500** を返すことを確認 |
| `pnpm test:integration` 相当（9 ファイル）を **3 回** | 2 回は **2 failed / 78**、1 回は **4 failed / 76**（§13 の flaky が再現） |
| `news.int.ts` + `news-admin.int.ts` の 2 ファイルだけを 3 回 | 3 回とも 16 passed（**負荷が低いと再現しない**） |

---

## 1. 依頼事項への回答

### 依頼 1: red は本物か（空振りしていないか）— **本物である**

38 件すべての失敗メッセージを確認した。**「テストの書き方の問題」で落ちているものは 1 件も無い。**

| ファイル | red | 失敗の実体 |
|---------|-----|-----------|
| `public-guard-construction-p3c` | 3 | `expected [Function] to throw` — `lib/public-guard.ts:263` の `if (limiters?.source)` が入口なので (c)(d) が素通りする。**実装の欠陥そのもの** |
| `trust-proxy-env` | 7 | `expected undefined to be true`（zod が未宣言キーを strip）/ `expected false to be true`（`lib/http-guard.ts:108` が `VERCEL` しか見ない）/ ソースに `TRUST_PROXY` の文字が無い |
| `form-session-degraded-recovery` | 5 | `expected null not to be null`（`challengePassed` / `hasVerifiedSession` が無視される）/ `403 to be 201` / payload に `unverified` が平文で出る |
| `cron-auth-attempt-limit` | 5 | `expected +0 to be 1`（`limiter` が呼ばれない）/ `spy to be called`（`logger` が無い） |
| `retention-client-ip` | 5 | `expected undefined to be type of 'number'` / `/privacy` に `IP アドレス` が無い |
| `kv-rate-limit-saturation` | 1 | `expected 50 to be less than or equal to 3`（無条件 `INCR` の実測） |
| `prisma-error-log` | 12 | 9 件が `TypeError: prismaErrorLogFields is not a function`、3 件が `lib/db.ts` のソース検査 |

**ただし 1 点、次の監査に申し送るべき性質がある（Should Fix SF-5）。**
`prisma-error-log` の 12 red のうち **9 件は `TypeError` で落ちており、assertion 本体が一度も評価されていない。**
「未実装だから落ちている」ことは正しいが、**その assertion が正しく書けているかは未検証**である。
設計文書 §8 は `log:` の正規表現が空振りしていたことを自分で見つけて直した（優れた姿勢）が、
同じ検証は `TypeError` 型の red には適用されていない。

### 依頼 2: SEC-070 の既存テスト改訂が契約を弱めていないか — **弱めていない。強めている**

逐条で差分を確認した。

| 場所 | 旧 | 新 | 判定 |
|------|----|----|------|
| `form-session-issue-cost.test.ts` 監査実測の再現 | `toBeLessThan(60)` | `toBeLessThanOrEqual(30)` | **厳格化** |
| 同 上限の存在 | `toBeLessThanOrEqual(90)` | `toBeLessThanOrEqual(30)` | **厳格化** |
| 同（新規） | — | `toBe(30)`（実測が上界に張り付く） | **追加** |
| 同（新規） | — | `FREE < ISSUE_LIMIT` の健全性 | **追加** |
| `form-session-cost.int.ts` 受理件数 | `toBeLessThan(60)` | `toBeLessThanOrEqual(30)` | **厳格化** |
| 同 DB 行数 | `toBeLessThan(60)` | `toBeLessThanOrEqual(30)` | **厳格化** |

**緩められた assertion は 1 件も無い。** 既存 7 件の pin（発行を止めない `toBe(20)` / 正規利用者の
`[201,201,201]` / 429 に落とさない / `trusted` 退行なし / 後方互換の手組み Cookie）は
期待値も文面も不変で、実測でも 9 件すべて green。定数から計算する形（`FREE * FORM_SESSION_LIMIT`）に
したことで数値リテラルの二重管理も無い。**この項目は文句なく Approve。**

### 依頼 3: SEC-067 の解法は SEC-057 を再び開かないか — **`challengePassed` は開かない。`hasVerifiedSession` は開く**

設計文書 §4 の主張は**半分しか成立していない**。

- **`challengePassed` について: 主張は成立する。** 「コストを発行の時点で払わせる」形は、
  SEC-057 の測定（チャレンジを通さない攻撃者）を変えない。実測でも `form-session-issue-cost.test.ts`
  9 件・`form-session-cost.int.ts` 2 件は全て green のままである。§4 の論証は正しい。
  ただし**増幅（1 チャレンジで何枚取れるか）が契約に無い**（Must Fix MF-2）。
- **`hasVerifiedSession` について: 主張は成立しない。SEC-057 が再び開く**（Must Fix MF-1）。
  詳細は MF-1 に書く。要旨は「有効な Cookie を 1 枚持っているだけで、印の付かない Cookie を
  無コストで（実装によっては無制限に）増やせる」——**SEC-057 の核心「一意性ではなく入手コスト」に
  対する反例そのもの**であり、しかも**どのテストも赤くならない**。

### 依頼 4: `TRUST_PROXY` が本番でレート制限を緩める経路にならないか — **なる**（Must Fix MF-3）

「既定 false」「不正値 fail-fast」「明示 0 が VERCEL に勝つ」は正しく pin されている。
しかし**有効化したときに何が信頼されるか**が検査されておらず、
非 Vercel 本番（＝ `TRUST_PROXY` の唯一の用途）で **`x-vercel-forwarded-for` の偽装**が通る。
設計文書 §3 の「上限を緩めない——制限が強くなる方向にしか動かない」は**誤り**である。

### 依頼 5: §13（`news.int.ts`）の扱い — **P3-c1 のスコープに入れて直す**（Must Fix MF-5）

判定理由と、§13 の診断への補正は MF-5 に書く。
「P3-b 完了記録の 76 件全パスは実行順序に依存した観測だった可能性がある」という指摘は
**当を得ている**（ただし「実行順序」ではなく「並列実行のタイミングレース」が正確）。実測で再現した。

---

## 2. 良い点（記録として残す）

- **§1 の SEC-059 打ち消し**が明示的に書かれている。監査 §F だけを読んだ実装者が
  `enforceBodyBytes` を二度書き直して `cancel()` の位置を退行させる事故は、この 1 節で確実に防げる。
  「監査票が差し戻し前の実装を見て書かれている」という**メタな理由**まで書いてあるのが良い。
- **§8 の空振り自己申告。** `/log\s*:\s*\[/` が三項演算子のせいで空振りして green だったことを
  自分で見つけ、配列リテラルを直接見る形へ直し、red を実測で確認している。
  「空振りしているテストを green として報告しない」という原則を、自分の成果物に適用できている。
- **§13 の切り分け。** 単独実行 2 回 / 新規ファイル退避 5 回 / 戻して単独実行、と手順を分けて
  「本単位の変更とは無関係」を実測で示している。自分の成果物を疑う順序として正しい。
- `application-error-classification.test.ts:93-98` の
  「`create` の既定 mock を必ず置く（red を未定義参照の TypeError にしないため）」、
  `application-course-fk.int.ts:157-160` の「`not.toContain` の前にステータスを固定する（空振り防止）」は、
  **red の質**に対する配慮として質が高い。他のファイルにも同じ配慮が欲しい（SF-5）。
- `cron-auth-attempt-limit.test.ts:72-73` が `CRON_AUTH_ATTEMPT_LIMIT` を import せず
  注入した limiter の上限で測っているのは正しい（実装の既定値にテストが追随してしまう形を避けている）。
- `kv-rate-limit-saturation.test.ts:176-183` が「この 1 件は現時点で green であり SEC-063 を検出しない」と
  **自分で明記している**。green のテストを「守っている」と誤読させない書き方として模範的。

---

## 3. 指摘事項

### [REV-P3C1-001] `hasVerifiedSession` の契約が SEC-057 を再び開く（**本レビュー最重要**）

- **種別**: Design（セキュリティ）
- **重要度**: **Must Fix**
- **場所**: `docs/test-design-p3c1-2026-07-29.md` §4 / `tests/unit/form-session-degraded-recovery.test.ts:274-306`
- **現状**:

  契約は「**既に有効（印の無い）フォームセッションを持つ再訪。この再発行は無コスト枠を消費しない**」。
  これを満たす最も安い実装は次である。

  ```ts
  // lib/form-session-issue.ts:109 付近
  if (!options.hasVerifiedSession) {
    const result = await limiter.consume(key, at)
    if (!result.success && clientIp.trusted) return { issued: false, ... }
  }
  ```

  この実装で以下が起きる。

  1. **`trusted`（Vercel 本番）でも硬い上限 30 が消える。** 同 :110 のゲートは `consume` の結果に
     依存しているので、`consume` を飛ばした要求は上限を評価されない。
     **有効な Cookie を 1 枚持つ攻撃者が、印の無い Cookie を無制限に発行できる。**
  2. **縮退でも無コスト枠が消える。** `consumedInWindow = result.limit - result.remaining`
     （同 :128）は単一の limiter から導出されるので、`consume` を飛ばした発行は
     `consumedInWindow` を進めない ⇒ 何枚出しても印が付かない。
  3. **Cookie は単回使用でも失効可能でもない。** `verifyFormSessionValue`（`lib/form-session.ts:167-222`）に
     「消費」の概念が無く、再発行時に旧 `sid` を無効化する経路も無い。したがって攻撃者は
     **1 枚の有効な Cookie を提示し続けるだけ**で、印の無い Cookie を好きなだけ積み上げられる。

  これは SEC-057 の核心（**「一意であること」ではなく「入手にコストがあること」**）に対する
  直接の反例である。しかも **既存・新規のどのテストも赤くならない**:
  - `form-session-issue-cost.test.ts` の `attackerScenario` は `hasVerifiedSession` を渡さない
    （＝ Cookie を提示しない攻撃者しか測っていない）ので、上界 30 の pin（`toBe(30)`）は素通りする。
  - 本ファイル :298-306「Cookie を持たない要求は従来どおり無コスト枠を消費する」は、
    **Cookie を持っている攻撃者**を測っていない。
  - :322-329「`trusted` の硬い上限 30」は `hasVerifiedSession` を渡さずに測っている。

  つまり「攻撃者が Cookie を提示するとどうなるか」を測る pin が**1 件も存在しない**。
  「受け口が在るから結線済みと読める」で 1 度事故を起こしたプロジェクトとして、
  ここは同じ型の見落としである（受け口の**悪用**が測られていない）。

- **改善案**（設計判断を含むので 2 案。**(A) を推す**）:

  **(A) 有効な Cookie を持つ再訪には、そもそも新しい Cookie を発行しない。**
  SEC-067 の増幅要因は「`/apply` を開くたびに再発行して枠を消費する」ことなので、
  **発行しなければ増幅も蓄積も同時に消える**。契約は
  「`hasVerifiedSession` なら `issued: false`（既存 Cookie をそのまま使わせる）/ 枠は消費しない」
  になり、印の無い Cookie の**総数が増えない**ので SEC-057 に触れない。
  併せて `app/(public)/apply/page.tsx:55-71` の「Cookie が無い扱い」の判定を見直すこと。

  **(B) 発行を続けるなら、提示された Cookie を必ずローテートする**（旧 `sid` を失効させ、
  同時に有効な印なし Cookie が 1 枚を超えないようにする）。失効の器（サーバー側状態）が要るので
  KV 前提になり、P3-c1 では重い。

  どちらを採るにせよ、**pin を 3 本足すこと**:

  ```ts
  it('hasVerifiedSession を渡しても、trusted の硬い上限（30 回/10 分）は超えられない', async () => {
    const limiter = issueLimiter()
    let issued = 0
    for (let n = 0; n < FORM_SESSION_ISSUE_LIMIT + 20; n++) {
      if ((await issue(limiter, TRUSTED, { hasVerifiedSession: true })) !== null) issued++
    }
    expect(issued).toBeLessThanOrEqual(FORM_SESSION_ISSUE_LIMIT)
  })

  it('有効な Cookie を再提示し続けても、印の無い Cookie の総数は無コスト枠を超えない', async () => {
    // 攻撃者の手順: 1 枚を正規に得る → それを提示して再発行を繰り返す
    const limiter = issueLimiter()
    let unmarked = 0
    for (let n = 0; n < 200; n++) {
      const value = await issue(limiter, DEGRADED, { hasVerifiedSession: true })
      if (verifyFormSessionValue(value, SECRET, NOW) !== null) unmarked++
    }
    expect(unmarked).toBeLessThanOrEqual(FORM_SESSION_FREE_ISSUE_LIMIT)
  })

  it('本番配線で、Cookie を提示し続ける攻撃者の到達数も上界を超えない', async () => {
    // form-session-issue-cost.test.ts の attackerScenario に
    // `hasVerifiedSession: true` を渡す版を足し、reached <= DEGRADED_REACH_BOUND を測る
  })
  ```

- **理由**: 「無コスト枠を消費しない」は**枠の免除**であり、免除に上界が無ければ枠は存在しないのと同じ。
  SEC-067（可用性 / Medium）を直すために SEC-057（High）を開くのは、正味で悪化である。
  §12.2 が「やってはいけないこと」を 3 つ挙げているが、**この 4 つ目が抜けている。**

---

### [REV-P3C1-002] `challengePassed` の増幅率（1 チャレンジ = 何枚）が契約にない

- **種別**: Design（セキュリティ）
- **重要度**: **Must Fix**
- **場所**: `docs/test-design-p3c1-2026-07-29.md` §4 / §12.2-3 / §12.3、
  `tests/unit/form-session-degraded-recovery.test.ts:205-220`
- **現状**: 契約は「チャレンジ通過を伴う発行要求には印を付けない」だけで、
  **1 回のチャレンジ通過で何枚の印なし Cookie を得られるか**が決まっていない。
  テストも 1 枚しか測っていない（:214）。
  §12.2-3 は「クライアントの自己申告を渡すな / ルート側で `verifyTurnstile` を実行しその結果を渡せ」
  までしか書いていないので、**同一トークンを N 回検証してもらう**形（Turnstile の siteverify が
  重複トークンを弾かない実装・キャッシュを挟む実装）や、**1 回の検証結果をセッションに保持して
  以後の全発行に流用する**形が契約に違反しない。
  そうなると縮退での到達数は 30（無コスト）+ 3 × チャレンジ通過ごとの枚数 になり、
  §6 で締めたばかりの上界が**測っていない経路で**破られる。
- **改善案**:
  1. 単体で「チャレンジ通過は 1 枚だけ印を落とす」を pin する（同じ `challengePassed: true` を
     連続で渡しても、印なしで出るのは無コスト枠 + 1 に収まる、等の観測可能な形にする）。
  2. §12.2 に **4 つ目の禁止事項**として「`verifyTurnstile` の結果を再利用しない。
     トークンは 1 リクエスト 1 回（siteverify の重複トークン拒否に依存する場合はその旨をコメントに残す）」を書く。
  3. §12.3 の結合テスト（P3-c2 で足す 1 本）の要件に「**同じトークンで 2 度目は回復できない**」を含める。
- **理由**: SEC-067 の回復経路は「攻撃者にとってはコストが乗る」ことが前提である。
  増幅率が 1 でなければコストは割り算で消える。**回復経路の価値はコスト比で決まる**ので、
  比そのものを契約に書かないと守れない。

---

### [REV-P3C1-003] `TRUST_PROXY=1` が非 Vercel で `x-vercel-forwarded-for` の偽装を許し、SEC-057 の是正ごと無効化する

- **種別**: Bug（セキュリティ）
- **重要度**: **Must Fix**
- **場所**: `tests/unit/trust-proxy-env.test.ts:142-208` / `docs/test-design-p3c1-2026-07-29.md` §3、
  実装側は `lib/http-guard.ts:67-71, 116-122`
- **現状**: `resolveClientIp` は信頼する場合、**`x-vercel-forwarded-for` を最優先**で採り、
  値は**左端**を採用する（:120）。この優先順位は「Vercel の手前に自前プロキシを置いても
  上書きされない」という **Vercel 上でのみ成立する性質**を根拠にしている（:60-65 のコメント）。

  `TRUST_PROXY` の唯一の用途は**非 Vercel 本番**である。そこでは前段（nginx / ALB / Cloudflare）は
  `x-vercel-forwarded-for` を知らないので**剥がさない**。したがって攻撃者は

  ```
  X-Vercel-Forwarded-For: 203.0.113.9
  ```

  を付けるだけで `trusted: true` + **自分で選んだ key** を得る。帰結は 3 つあり、いずれも重い。

  1. 発信元軸のバケットを無限に作れる ⇒ 発信元あたりの上限が消える（SEC-023 / SEC-032 と同型）。
  2. **`unverified` の印が一切付かなくなる。** `lib/form-session-issue.ts:129` は
     `!clientIp.trusted` でガードされているので、**SEC-057 の是正が丸ごと無効化される**。
     `TRUST_PROXY` は SEC-057 の残余を縮めるために入れるのに、誤設定で SEC-057 が全開になる。
  3. `auth.ts` のログイン IP 軸は `trusted` のとき硬いゲートになるので、
     攻撃者が**被害者の IP を名乗って**管理者を締め出せる（SEC-030 の再来）。

  テストは「IP リテラルでなければ採用しない」（:199-208）しか見ておらず、
  **どのヘッダを信頼するか**を 1 件も pin していない。
  設計文書 §3「上限を緩めない——制限が強くなる方向にしか動かない」は、この経路を見落としている。
- **改善案**: 契約に「**信頼の根拠がプラットフォーム検出（`VERCEL === '1'`）でない場合、
  `x-vercel-forwarded-for` は採用しない**」を足し、テストを 2 件足す。

  ```ts
  it('TRUST_PROXY=1（非 Vercel）では x-vercel-forwarded-for を採用しない', () => {
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', '1')
    const resolved = resolveClientIp(req({
      'x-vercel-forwarded-for': '203.0.113.9',   // 攻撃者が名乗った値
      'x-forwarded-for': '198.51.100.7',          // 前段プロキシが上書きした値
    }))
    expect(resolved.key, '攻撃者が名乗ったヘッダが採用された').toBe('198.51.100.7')
    expect(resolved.source).toBe('x-forwarded-for')
  })

  it('VERCEL=1 では従来どおり x-vercel-forwarded-for を最優先する（退行防止）', () => { ... })
  ```

  併せて設計文書 §3「『env で緩める形』ではないことの確認」の記述を訂正すること。
  正しくは「**上限は緩めないが、信頼境界を移す設定なので、誤設定は防御を無効化しうる**」であり、
  だからこそ「何を信頼するか」を実装で固定する必要がある。
- **理由**: `TRUST_PROXY` は**信頼境界を宣言する設定**であって、閾値の設定ではない。
  信頼境界の設定は「有効化したときに何が起きるか」を検査しなければ、
  fail-closed な既定値をいくら pin しても意味が無い（誰も既定のままでは使わないため）。

---

### [REV-P3C1-004] SEC-063 の store 契約が誤っており、そのまま実装するとレート制限が無効化される

- **種別**: Bug（契約の記述）
- **重要度**: **Must Fix**（任意項目だが、記述が誤っているまま残すほうが危険）
- **場所**: `docs/test-design-p3c1-2026-07-29.md` §10 /
  `tests/unit/kv-rate-limit-saturation.test.ts:56-59`
- **現状**: 契約は「`limit` が渡され、かつ現在値が既に `limit` 以上なら **INCR を発行しない**。
  **`count` は現在値をそのまま返す**」。

  KV 経路の判定は `lib/rate-limit.ts:369-373` の
  `toResult(entry.count, entry.resetAt, entry.count <= limit, now)` である。
  `limit = 3` で 4 回目に「現在値 3 をそのまま返す」と `3 <= 3` ⇒ **`success: true`**。
  以後の全リクエストが同じく `true` になり、**KV 経路（＝本番だけ）のレート制限が完全に消える。**
  インメモリ経路（同 :382-385）は `current.count >= limit` を**自分で判定してから**返すので
  同じ「count は limit で止まる」でも成立するが、KV 経路は判定を外に置いているため成立しない。
  **2 つの store で `count` の意味が違う**ことが見落とされている。

  さらに、テスト :135 の `incrCount() <= 3` と :151-168 の「上限到達後も拒否される」を
  **同時に満たす実装は 1 つしかない**: 「書き込みは抑制するが、返す `count` は**試行後の値**
  （`current + 1`）」。この非自明な条件が契約に書かれていないので、実装者は 2 つの red の間で往復する
  （そして「テストのほうを直す」圧力が生まれる — SEC-057 修正時に警戒されたのと同じ力学）。
- **改善案**:
  1. §10 の契約を「**INCR は発行しないが、返す `count` は `current + 1`（試行後の値）**。
     判定 `count <= limit` を成立させ続けるため」に訂正する。
  2. **費用対効果の再評価を書く。** 現行 KV 実装は 1 リクエスト = `INCR` 1 回である。
     抑制のためには先に `GET` が要るので、**飽和していない通常時は往復が 1 → 2 に増える**。
     SEC-063 が問題にした「Upstash への課金」は**むしろ悪化しうる**（減るのは書き込み増幅とキー値の膨張だけ）。
     単一のサーバー側スクリプト（Lua / pipeline）で 1 往復に畳めないなら、
     §12.1-8 の指示どおり **`docs/security-audit.md` の P3c-9 に「P3-c1 では対応しない」と明記して繰り越す**のが正しい判断だと考える。
- **理由**: 「性能・費用のための最適化」が「防御の無効化」に化ける典型で、しかも
  **ローカル / E2E はインメモリなので本番でしか現れない**（設計文書自身が §10 で指摘しているとおり）。
  契約の 1 行の誤りが本番限定の全面的なレート制限喪失になるため、記述を直さずに実装へ渡してはならない。

---

### [REV-P3C1-005] §13 の flaky は P3-c1 のスコープで直す。ただし §13 の診断は範囲が不足している

- **種別**: Maintainability（テストの独立性）
- **重要度**: **Must Fix**（テストのみの変更。実装コードには触れない）
- **場所**: `tests/integration/news.int.ts:22-23, 26-40, 56-61` /
  `tests/integration/news-admin.int.ts:113-126`
- **判定**: **P3-c1 のスコープに入れて直す。** 別途起票にしない。理由:
  1. P3-c1 の完了条件は「既存 76 件に退行が無い」である。**その判定が確率的にしか下せない状態**では、
     ゲートそのものが機能しない。実測でも 3 回中 1 回は 4 failed になり、
     「P3-c1 が壊した」と誤読される余地が残った。
  2. 修正はテストのみ・数行で、実装コードにも仕様にも触れない。P3-c1 の他の作業と競合しない。
  3. P3-c1 は integration ファイルを 8 → 9 に増やす（`application-course-fk.int.ts`）。
     並列度が上がるほどレースの発火確率は上がるので、**本単位が原因で顕在化しやすくなる**。
- **§13 の診断への補正**（重要）: §13 は「`news.int.ts` の最後の assertion（`:61`）が
  DB 全体の PUBLISHED 件数を数えており、並列の `news-admin.int.ts` に汚される」としているが、
  **実測では範囲がもっと広く、しかも汚染は相互である**。

  | 実測（`pnpm test:integration` 全 9 ファイル × 3 回） | 結果 |
  |---|---|
  | 1 回目 / 3 回目 | 2 failed（P3-c1 の SEC-060 red のみ） |
  | **2 回目** | **4 failed** — 上記に加えて **`news.int.ts:26`「最新3件を降順で取得でき、先頭は 2026-07-15 の記事」** と **`news-admin.int.ts:114`「DRAFT/UNPUBLISHED を作っても公開クエリ件数は seed の 6件のまま」** |

  - `news.int.ts:26` が落ちるのは、`news-admin.int.ts:117-119` が **`publishedAt: 2026-07-20`** の行を作るため、
    `orderBy publishedAt desc` の先頭を奪うからである。**件数ではなく順序の assertion も壊れる。**
  - `news-admin.int.ts:114` も `listPublishedNews().length === SEED_COUNTS.news.published` と
    **DB 全体を数えている**ので、`news.int.ts` が作る行に汚染される。**片方向ではなく相互汚染**である。
  - したがって §13 の修正方針（「件数の assertion を落とす」）だけでは**不足**する。
- **改善案**: 両ファイルとも「**自分が作った行 / seed の行だけ**」を対象にする。

  ```ts
  // news.int.ts: seed 行だけを対象にする（テストが作る行はタイトル接頭辞で識別できる）
  const SEED_ONLY = { status: 'PUBLISHED' as const, NOT: { title: { startsWith: '【テスト】' } } }
  expect(await prisma.news.count({ where: SEED_ONLY })).toBe(SEED_COUNTS.news.published)

  // :26 の順序テストも同じ where を通す（先頭を他ファイルの行に奪われない）
  // news-admin.int.ts:124 も listPublishedNews() の結果を自ファイルの接頭辞で絞ってから数える
  ```

  **`fileParallelism: false` で直さないこと。** レースを隠すだけで、CI が遅くなり、
  同型の欠陥（DB 全体を数えるテスト）が今後も足され続ける。
- **併せて**: 「P3-b 完了記録の integration 76 件全パスは実行順序に依存した観測だった可能性がある」
  という §13 の指摘は**当たっている**。正確には「実行順序」ではなく
  **並列ワーカー間のタイミングレース**であり、2 ファイルだけを走らせると 3 回とも green になる
  （負荷が低いと窓が開かない）ことも実測した。`docs/phase-status.md` の P3-b 完了記録に
  **「integration の全パスはこのレースの影響下で観測された（P3-c1 の REV-P3C1-005 で是正）」**と
  追記すること。過去の記録を「嘘だった」ことにせず、観測条件を残すのが正しい。

---

### [REV-P3C1-006] SEC-046 の「試行回数制限」は実際には何も絞らない（記述が実体と食い違う）

- **種別**: Design（記述の正確性）
- **重要度**: Should Fix
- **場所**: `docs/test-design-p3c1-2026-07-29.md` §7 の表 /
  `tests/unit/cron-auth-attempt-limit.test.ts` 全体
- **現状**: 契約は次の 3 つを同時に要求している。
  - 成功は常に通す（:124-137）
  - 上限到達後も正しいトークンは 200（:155-172）
  - 上限到達後の失敗も**同じ 404 / `Retry-After` 無し**（:180-212）

  この 3 つを満たす実装では、**上限に達しても攻撃者の体験は 1 ミリも変わらない**。
  正しいトークンを常に通す以上、毎回トークン比較を実行しなければならず、
  推測の試行回数も速度も一切制限されない。**上限到達時に起きるのはログ 1 行だけ**である。

  にもかかわらず §7 の表は「失敗はカウンタを消費する → **総当たりを絞る**」と書いている。
  実体は**総当たりの検知**であって抑制ではない。
- **改善案**: §7 の表と契約名を「試行の**検知**」に改め、
  「本ラッパは総当たりの速度を落とさない。抑制は `CRON_SECRET` の長さ（`lib/env.ts:21`
  の 32 文字下限）とプラットフォーム側の流量制御に依存する」と明記する。
  テストの構成は現状のままでよい（要求そのものは妥当）。
- **理由**: 監査 ID を「試行回数制限を入れた」として閉じると、次の監査が
  「`/api/cron/**` は総当たりに対して上限がある」と読む。**そこには上限が無い。**
  P3-c は `orphan-uploads`（写真の削除バッチ）を足すので、この誤読は高くつく。

---

### [REV-P3C1-007] `clientIpMinutes` の等値 pin が過剰拘束で、自分の別テストと衝突しうる

- **種別**: Maintainability
- **重要度**: Should Fix
- **場所**: `tests/unit/retention-client-ip.test.ts:90-100`（:99 の `toBe(FORM_SESSION_ISSUE_WINDOW_MS)`）
- **現状**: 設計文書 §9 の契約は「**IP を含む全カウンタの最長窓以上**であること」だが、
  テストは `clientIpMinutes * 60_000 === FORM_SESSION_ISSUE_WINDOW_MS` という**特定の 1 つの窓との等値**を要求している。
  現在は全窓が 600_000 なので偶然どちらも満たされる。
  将来 `FORM_SESSION_ISSUE_WINDOW_MS` だけが 5 分になると、この 1 件は `clientIpMinutes = 5` を強制し、
  同ファイル :102-128（他の IP 軸の窓が `clientIpMinutes` を超えない）が `RATE_WINDOW_MS = 600_000` で落ちる。
  **2 件が同時に満たせなくなる**（＝ 実装者が片方のテストを消す動機が生まれる）。
- **改善案**: 「全 IP 軸の窓の**最大値と一致**する」に直す。窓の一覧はすでに :102-128 が読み取っているので、
  最大値を計算してから 2 つの assertion（`>= 各窓` と `=== max`）に分けるだけでよい。
- **理由**: 「約束が実装より短くならない」ことが守りたい性質であって、
  特定の定数と一致することではない。契約文（§9）とテストが食い違っている状態は、
  どちらが正なのか次の読者に判断させることになる。

---

### [REV-P3C1-008] `P2003 → { field: 'courseId' }` の固定は 2 本目の外部キーで誤分類になる

- **種別**: Design
- **重要度**: Should Fix
- **場所**: `tests/unit/application-error-classification.test.ts:252-266` /
  `tests/integration/application-course-fk.int.ts:133-148`
- **現状**: `P2003` を**無条件に** `{ errors: [{ field: 'courseId', code: 'NOT_FOUND' }] }` へ落とす契約。
  ところが本項目を P3-c2 の前に閉じる理由として設計文書 §5 が挙げているのは
  「P3-c2 が `LicensePhoto` → `Application` という **2 本目の外部キー**を作るから」である。
  2 本目ができた瞬間、`applicationId` の外部キー違反が
  **「コースが存在しません」として利用者に返る**（そして 422 なので監視にも上がらない）。
  この契約は**自分が挙げた理由によって自分が壊れる**。
- **改善案**: `error.meta.field_name`（Prisma が外部キー制約名を入れる）で分岐し、
  `courseId` に紐づくものだけを 422 にする。判別できない `P2003` は
  **未分類として 500 のまま残す**（「500 は分類できなかったという信号」という本項目自身の原則に従う）。
  テストも「`courseId` 由来の P2003 は 422 / 別の外部キー由来の P2003 は 500」の 2 件に分ける。
- **理由**: 分類の網を実際の原因より広く張ると、
  「入力が悪い」と嘘をつく応答になる（同ファイル :281-290 が未分類の例外について自ら書いている懸念そのもの）。

---

### [REV-P3C1-009] `TRUST_PROXY` の検証経路が 2 本に割れる（fail-fast が効かない経路が残る）

- **種別**: Design
- **重要度**: Should Fix
- **場所**: `tests/unit/trust-proxy-env.test.ts:117-128`（`parseServerEnv` 側）と
  :142-208（`resolveClientIp` 側）
- **現状**: :159-197 は `process.env` を書き換えて `resolveClientIp` の結果が変わることを測っている。
  `getServerEnv()` は初回に parse した結果を**キャッシュする**（`lib/env.ts:197-205`）ので、
  これらのテストを通すには `resolveClientIp` が **`process.env.TRUST_PROXY` を直読み**するしかない。
  つまり検証（zod）と使用（直読み）が**別経路**になる。
  `TRUST_PROXY=yes` はルートモジュールの読み込み時に `getServerEnv()`（`app/api/applications/route.ts:127` 等）で
  落ちるので**本番では fail-fast する**（ここは確認した）が、
  `resolveClientIp` を単体で使う経路・将来の呼び出し元では不正値がそのまま解釈される。
- **改善案**: `resolveClientIp` 側でも不正値が **false（fail-closed）**になることを 1 件 pin する。

  ```ts
  it('解釈できない TRUST_PROXY は信頼しない（fail-closed / 検証経路と使用経路がずれても安全側）', () => {
    setEnv('VERCEL', undefined)
    setEnv('TRUST_PROXY', 'yes')
    expect(resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' })).trusted).toBe(false)
  })
  ```
- **理由**: 「起動時に落ちるから使用時は安全」は、**起動時の検証が実際に走る経路に限った保証**である。
  同じ値の解釈が 2 か所にある以上、両方を安全側に固定するのが安い。

---

### [REV-P3C1-010] `TypeError` で落ちている red は assertion 本体が未検証である

- **種別**: Maintainability（テストの質）
- **重要度**: Should Fix
- **場所**: `tests/unit/prisma-error-log.test.ts`（12 red のうち 9 件が
  `TypeError: prismaErrorLogFields / attachPrismaLogging is not a function`）
- **現状**: 未実装の export を呼んでいるので当然 red になるが、
  **assertion が一度も評価されていない**ため、それが正しく書けているかは分からない。
  設計文書 §8 は自分のソース検査が空振りしていたことを見つけて直した（優れている）が、
  同じ検証は `TypeError` 型の red には適用されていない。
- **改善案**: §12（申し送り）に 1 項足す。
  「**`TypeError` で落ちている red は、実装後に『意図した理由で green になったか』を必ず確認すること。**
  具体的には、実装を入れた直後に一度わざと `message` を返す実装にして当該テストが red になることを見る
  （＝ assertion が実際に効いていることの確認）」。
  他ファイルでは `application-error-classification.test.ts:93-98` が既に同じ配慮をしている。
- **理由**: このプロジェクトは「テストが green でも本番経路が守られていない」で 1 度事故を起こしている。
  red の**理由**を確認する規律は、green の理由を確認する規律と同じ重さで要る。

---

### [REV-P3C1-011]（Nit）結合側に「上界への張り付き」pin が無い

- **場所**: `tests/integration/form-session-cost.int.ts:176-180`
- unit 側には `toBe(DEGRADED_REACH_BOUND)` を足したが、int 側は `toBeLessThanOrEqual` のままである。
  実時間の `sleep` を挟む都合で厳密一致を避けたのなら妥当な判断なので、**その理由をコメントに残すこと**。
  書いていないと「片方だけ締め忘れた」と読まれる。

### [REV-P3C1-012]（Nit）直書き禁止の正規表現が red 状態で誤爆しうる

- **場所**: `tests/unit/retention-client-ip.test.ts:148-152`
- `clientIpMinutes` 未定義時は `minutes = 0` になり、`new RegExp('0\\s*分')` は
  `/privacy` 中の「30分」「180日…」等の部分文字列に当たりうる。
  `minutes` が数値でない場合は当該 assertion を skip せず **明示的に fail** させる形にするか、
  `\b` 相当の境界を入れること。

### [REV-P3C1-013]（Nit）cron の既定 limiter はモジュール大域になる

- **場所**: `tests/unit/cron-auth-attempt-limit.test.ts:265-280`
- 「`limiter` 省略時も制限が効く」を満たすには内蔵の既定カウンタが要るが、
  それはモジュール大域の状態になるので、同種のテストが増えると**実行順序に依存**する。
  既定 limiter を `reset` できる手段（または `now` の注入で窓を跨がせる手順）を契約に含めておくこと。

---

## 4. 差し戻しの範囲（実装を止める項目 / 止めない項目）

| 項目 | 実装着手 | 理由 |
|------|---------|------|
| SEC-058（構築時検査） | **着手可** | 指摘なし。設計文書 §2 の全数表は正しく、red も本物 |
| SEC-060（`courseId` 分類） | **着手可**（REV-008 を反映してから） | 分岐条件を 1 つ足すだけ |
| SEC-064（Prisma ログ） | **着手可**（REV-010 の確認手順つき） | 契約は妥当 |
| SEC-065（`/privacy` + 保持期間） | **着手可**（REV-007 を反映してから） | |
| SEC-046（cron 試行制限） | **着手可**（REV-006 は記述の訂正のみ） | テスト構成は妥当 |
| **SEC-061 / SEC-069（`TRUST_PROXY`）** | **止める** | REV-003。信頼するヘッダの契約を決めてから |
| **SEC-067 / SEC-068（回復経路）** | **止める** | REV-001 / REV-002。`hasVerifiedSession` の形そのものを決め直す必要がある |
| **SEC-063（KV 抑制）** | **止める** | REV-004。契約が誤っている。繰り越す判断も可 |
| **news の flaky** | **本単位で直す** | REV-005 |

---

## 5. 再レビューの条件

1. REV-001 / 002 / 003 / 004 / 005 が反映されていること。
2. **REV-001 については、追加した 3 本の pin が「修正前の実装で red、修正後に green」になることを実測で示すこと。**
   （`hasVerifiedSession` を素朴に実装した版で赤くなることが、この pin の価値そのものである）
3. `pnpm test:integration` を **3 回連続**で回し、失敗が P3-c1 の意図した red のみに収束すること。
