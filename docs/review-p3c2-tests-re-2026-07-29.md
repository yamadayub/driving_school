# テスト設計レビュー（再検収）: P3-c2（F-009 免許証写真アップロード本体）

## レビュー日: 2026-07-29
## 対象Phase: テスト（再検収）
## レビュワー: Senior Engineer Agent（`.claude/skills/senior-review.md`）
## 経緯: `docs/review-p3c2-tests-2026-07-29.md`（Must Fix 3 / Should Fix 3 / Nit 2）→ 本ファイル

---

## 総合評価: **Approve**

## **Phase 6（実装）へ進んでよい。**

| 指摘 | 判定 |
|------|------|
| **MF-1**（`TRUST_PROXY=1` が未設定で RV-P3B-019 が未結線） | **クローズ** |
| **MF-2**（uploads の流量防御に実測が無く閾値の上界も未固定） | **クローズ** |
| **MF-3**（回復経路の配線契約が無い / 軸ゼロでも通る） | **クローズ** |
| SF-1 / SF-2 / SF-3 | **クローズ**（SF-2 は文書化を超えて pin まで足している） |
| N-1 / N-2 | **クローズ** |

- **未クローズ: 0 件**
- 新規 Must Fix: **0 件** / 新規 Should Fix: **0 件** / 新規 Nit: **2 件**
- 退行: **無し**（既存 54 unit ファイル / 9 integration ファイルは全 green）

---

## 0. 自分で実測したこと

**ポート 3000 に触れるコマンドは一切実行していない。**

| ゲート | 結果 | 報告との一致 |
|--------|------|------------|
| `pnpm test:unit` 相当 | **6 ファイル red / 54 green（60）/ 39 failed / 832 passed（871）** | ✅ |
| `pnpm test:integration` 相当 | **3 ファイル red / 9 green（12）/ 26 failed / 88 passed（114）** | ✅ |

既存 54 unit ファイル・9 integration ファイルはいずれも green のままで、退行は無い。

---

## 1. MF-1 — **クローズ**

### 1.1 結線

`playwright.config.ts:74` に `env: { ...process.env, TRUST_PROXY: '1' }`。展開も入っている。

### 1.2 (a)〜(d) の主張の検証（依頼事項 / 特に (c)）

**4 つとも実コードで成立する。** ただし (c) の**述べ方**には不足がある（N-1）。

| 主張 | 検証 |
|------|------|
| **(a)** 閾値も窓も 1 つも変えていない | ✅ `FORM_SESSION_FREE_ISSUE_LIMIT=10` / `FORM_SESSION_ISSUE_LIMIT=30` / `SOURCE_LIMIT=5` / `FORM_SESSION_LIMIT=3` / 窓 600_000 — いずれも未変更 |
| **(b)** 本番（Vercel）で成立している状態 | ✅ Vercel は `x-vercel-forwarded-for` を自ら上書きするので発信元軸は実 IP 単位。縮退（全員が共有 `unknown`）のほうが本番と乖離していた |
| **(c)** 防御は**強くなる方向** | ✅ **成立する。ただし決定項は「発行の硬い上限 30」ではない**（下記） |
| **(d)** 本番へ漏れない | ✅ `playwright.config.ts` はデプロイ対象外。加えて `e2e-gate-config.test.ts:170-184` が `next.config.mjs` / `vercel.json` / `.env.production` に `TRUST_PROXY` が書かれていないことまで pin している |

**(c) の検証を数値で行った**（`lib/public-guard.ts` の `sourceAxisFor` は
`enforce: resolution.trusted` を返す、を確認したうえで）:

| | 縮退（変更前） | `trusted`（変更後 / IP ごと） |
|---|---|---|
| 発行の硬い上限 30 | **計数のみ**（ゲートにならない）＝ Cookie は何枚でも取れる | **ゲートとして効く**（30 枚/10 分） |
| 無コスト枠の印（`unverified`） | 11 枚目以降に付く ⇒ **使える Cookie は 10 枚**（全利用者で共有） | **付かない**（`!clientIp.trusted` でガード）⇒ 使える Cookie は 30 枚 |
| 送信側の発信元軸（`SOURCE_LIMIT=5`） | **計数のみ** | **硬いゲート**（5 回/10 分） |
| **本体到達数（1 要求元あたり）** | **30 回**（10 枚 × 3 回） | **5 回** |

**結論: 要求元あたりの到達数は 30 → 5 になり、防御は確かに強くなる。**
ただし決定項は `SOURCE_LIMIT=5` が**硬いゲートに変わる**ことであって、
コメントが挙げている「発行の硬い上限 30」ではない。
30 だけを見ると「使える Cookie が 10 → 30 に増える」ので**逆に読めてしまう** → N-1。

### 1.3 pin は本物か（依頼事項: green が誤読を生まないか）

**誤読を生む形にはなっていない。** `tests/unit/e2e-gate-config.test.ts` の 4 件が green なのは
**config が実際に修正されたから**であり、オーケストレーターの理解は正しい。空振りもしていない:

- `loadWebServer()` は**実際に `playwright.config.ts` を import して設定オブジェクトを読む**。
  ソースの正規表現ではないので、「`TRUST_PROXY` と書いてあるが別の行で潰される」形は通らない。
- `...process.env` の展開検査（:142-161）が特に良い。**`process.env` に sentinel キーを注入してから
  config を読み込み、それが `webServer.env` に現れることを測る**——
  「`...process.env` という文字列があること」ではなく「**実際に展開されていること**」を測っている。
  私の改善案は「展開を忘れると webServer が起動しない」と**注意書き**で済ませたが、
  それを**観測可能な形**に変えている。
- `CI` 有無の両方で `TRUST_PROXY=1` を測る（:163-168）ので、
  「手元だけ green で CI が赤」も防いでいる。

---

## 2. MF-2 — **クローズ**

`tests/integration/uploads-cost.int.ts`（6 件 / 全 red）が **SEC-057 と同じ形の実測**を持ち込んだ。

| 測定 | SEC-057 での対応物 |
|------|------------------|
| Cookie 40 枚取り直しても発行総数が上界に収まる | `form-session-cost.int.ts` の受理件数 |
| 発行総数が Cookie 枚数に比例しない | 「本体到達数は Cookie 枚数に比例しない」 |
| **上界に実測が張り付く**（`toBe(bound)`） | SEC-070 で追加した「実測が上界に張り付く」 |
| 正規利用者（1 枚・上限以内）は発行できる | 「縮退構成でも通常の利用者は本体へ到達する」 |
| **閾値の上界**（最悪ケース 8 回を上回り、その 2 倍を超えない） | （SEC-057 には無かった。**本単位の追加**） |

最後の 1 件が私の指摘した「上界の制約が無い」への回答である。
F-009 の境界値表が下界（最悪 8 回）しか与えていないところに、
`WORST_CASE_PER_APPLICATION * 2` という上界を与えたので、
Impl が 1000 と置けば赤くなる。**閾値の決定が無制約でなくなった。**

併せて `uploads-route-contract.test.ts` の弱い正規表現も締められている:
`extractOptionValue(routeSource(), 'limiters')` で**値部分を構造的に切り出してから**
`source` / `formSession` を探し、さらに「**中身がコメントではなく実際の値である**」ことを
`stripComments` で別途測る（:93-98）。私が指摘した「ファイル内のどこかに `source:` があれば通る」は解消した。

---

## 3. MF-3 — **クローズ**（かつ、設計側が新しい穴を自分で見つけている）

`tests/unit/form-session-route-contract.test.ts` が uploads と**同じ 7 項目**を `POST` に対して固定する。
`postSection()` で `export const POST` 以降だけを切り出しており、`GET` の配線と混同しない。

- **軸ゼロでも通る状態は塞がれた**（項目 2 / 3）。`limiters` が渡されていなければ
  `extractOptionValue` が `null` を返して赤くなる。
- **`endpoint` は `'form-session'` に分けられた**（項目 4）。私が求めた「決めて理由を書く」に対し、
  「回復を試みたせいで申込が 429 / 202 になる」経路を作らない、という理由まで書かれている。
  §5 の原則（applications と混ざらない）との矛盾も解消した。
- `verifyTurnstile` をルート内で呼ぶこと / `challengeToken` を渡すことも pin された。

### ⚠️ 設計側が自力で見つけた穴（評価に値する）

`:136-149` の「**`verifyFormSession` は Cookie の「存在」だけを見る**」は、
私の指摘には無かった項目である。根拠を自分で確認した——`lib/public-guard.ts:381`:

```ts
if (!resolved.trusted && !verifyFormSession) { /* → TIER_B */ }
```

したがって回復経路に `verifyFormSession` を渡さないと、
**縮退構成（＝ SEC-067 が成立する唯一の構成）で回復経路の全リクエストが Tier B** になる。
逆に uploads の契約を機械的に横展開して `verifyFormSessionValue` を使うと、
**印の付いた Cookie が弾かれ、回復できる人が誰もいなくなる。**
どちらも「回復経路を作ったが回復できない」＝ 直そうとした欠陥の再現である。

**契約を横展開するときに意味まで確認した**ことの成果であり、
この 1 件は指摘されずに実装へ進んでいたら確実に踏んでいた。

---

## 4. Should Fix / Nit の判定

| ID | 判定 | 確認したこと |
|----|------|------------|
| SF-1（E2E が trusted 化して縮退経路のカバレッジが消える） | **クローズ** | §9.1.1 に「E2E から落ちる検証 ↔ 引き受け先」の表（6 行）。落ちた分を integration が引き受ける対応関係が明示された |
| SF-2（polyglot） | **クローズ（+α）** | §3 に残余と補償 (a)(b)(c) を明記。さらに**補償 (b)（保存する `contentType` を検出結果に固定）を結合テストで pin**（`uploads-license.int.ts` が 16 → 17 件）。文書化だけで済ませていない。(c) は F-018 への持ち越し条件として記録 |
| SF-3（WebKit skip の記録運用） | **クローズ** | §9.2 に完了報告の形式を規定（`166 passed / N skipped（うち uploads 系 M 件は WebKit 除外）`）。「skip の内訳が消える」ことを防ぐ運用になった |
| N-1（`maxBodyBytes` を上げない判断） | **クローズ** | 「Senior 確認済み」の確定形へ |
| N-2（`generateObjectKey.length`） | **クローズ** | 補助 pin であり主たる担保は型、というコメントが入った |

---

## 5. 新規指摘（Nit のみ / 実装をブロックしない）

### [N-3] `playwright.config.ts` のコメント (c) が、**決定項でない数値**を根拠に挙げている

- **場所**: `playwright.config.ts:61-63`
- 「`trusted` では発行の硬い上限 30 が**ゲートとして効き始める**ので、防御は強くなる方向に動く」
  ——結論は正しいが、**30 は決定項ではない**。§1.2 の表のとおり、
  `trusted` では `unverified` の印が**付かなくなる**ので、使える Cookie は 10 枚 → 30 枚に**増える**。
  防御が強くなる決定項は、**送信側の発信元軸（`SOURCE_LIMIT = 5`）が硬いゲートに変わり、
  要求元あたりの本体到達数が 30 回 → 5 回になる**ことである。
- 30 だけを読んだ人は「使える Cookie が 3 倍になるのに強いのか？」と迷う。
  コメントに `SOURCE_LIMIT` を決定項として 1 行足すと、次に読む人が同じ検算をせずに済む。

### [N-4] config の pin は「設定されていること」を守るが「効いていること」は守らない

- **場所**: `tests/unit/e2e-gate-config.test.ts` の MF-1 describe
- 鎖は 3 本ある: ① config が `TRUST_PROXY=1` を渡す【pin 済み】→
  ② `resolveClientIp` が env + `x-real-ip` を信頼する【`trust-proxy-env.test.ts` で pin 済み】→
  ③ スペックが `x-real-ip` を送る【コードにはあるが pin 無し】。
  ③ は E2E を実行して初めて確かめられるので、**完了報告で
  「config の pin が green だから RV-P3B-019 は解けた」と書かないこと。**
  解けた証拠は `CI=1 pnpm test:e2e` で「送信成功」スペックが green になることである。
- 現状の設計文書は E2E の実行をオーケストレーターの担当としているので運用上は問題ない。
  **記録の書き方**に対する注意である。

---

## 6. 良い点

- **`...process.env` の展開を sentinel 変数で測った**（`e2e-gate-config.test.ts:142-161`）。
  私が注意書きで済ませた箇所を、**観測可能な契約**に変えている。
  「文字列が書いてあること」と「実際に効いていること」を分ける規律が、
  P3-c1 で 4 回踏んだ型への対策として定着している。
- **`verifyFormSession` の意味を横展開せずに検算した**（§3 参照）。
  契約のコピーが「回復経路が回復できない」を生むことを、実装前に自分で見つけている。
- **`extractOptionValue` / `stripComments` をヘルパへ切り出した**（`tests/unit/helpers/route-source.ts`）。
  ソース検査の弱さは P3-c1 でも繰り返し問題になった箇所で、
  対策が 1 ファイルの修正ではなく**再利用できる形**になっている。
- **SF-2 を文書化で終わらせず pin まで足した**（`contentType` を検出結果に固定）。
  「残余として記録する」という指摘に対し、**記録できる部分と固定できる部分を分けて**、
  固定できるほうを固定している。

---

## 7. Phase 6 への申し送り

1. **`upload-validation` / `upload-token` / `orphan-uploads` の 44 件は一度も評価されていない**
   （モジュール未作成によるファイル単位 red）。§11.4 のとおり、実装後に
   **一度わざと壊した実装にして当該テストが red になることを確認**すること。
2. **`uploads` の Tier D 閾値**は `uploads-cost.int.ts` の上界（最悪 8 回の 2 倍以内）に収めること。
3. 完了報告では **N-4** に従い、RV-P3B-019 の根拠を「config の pin」ではなく
   **E2E の送信成功スペックの green** で示すこと。
4. WebKit の skip は §9.2 の形式（`N skipped（うち uploads 系 M 件は WebKit 除外）`）で内訳を併記すること。
