# テスト設計レビュー: P3-c2（F-009 免許証写真アップロード本体）

## レビュー日: 2026-07-29
## 対象Phase: テスト
## レビュワー: Senior Engineer Agent（`.claude/skills/senior-review.md`）
## 対象: `docs/test-design-p3c2-2026-07-29.md` + 新規 7 ファイル + E2E スペック 2

---

## 総合評価: **Request Changes**

- **Must Fix: 3 件**（MF-1 / MF-2 / MF-3）
- Should Fix: 3 件 / Nit: 2 件

**設計の質は高い。** マジックバイト検証（依頼 4）・orphan 回収（依頼 5）・`objectKey` と署名 URL（依頼 6）は
いずれも契約として十分で、指摘は無い。`uploadToken` の「理由を返さない」判定、
`beforeAll` の import をやめて `skipped` を作らなかった判断、Blob→DB の順序の根拠も適切である。

**Must Fix 3 件は、いずれも同じ 1 つの型に属する**——P3-c1 で 4 回連続して指摘され、
本設計が §5 冒頭で「最初から設計に入れる」と宣言したはずの型である:

> 受け口の悪用 → 受け口が呼ばれること → 呼び出し元がその状態を作ること → **そもそも到達しない受け口**

宣言どおり前 3 段階は設計に入っている（`uploads-route-contract.test.ts` が「呼び出し元が配線を持つ」を、
`uploads-license.int.ts` が振る舞いを、`form-session-recovery.int.ts` が回復経路の結線を測る）。
**しかし 4 段階目が 2 箇所で再発している**（MF-1 / MF-3）。MF-2 は「同じ形で適用する」と
書いた対象が**形だけ**になっている件である。

---

## 0. 自分で実測したこと

**ポート 3000 に触れるコマンドは一切実行していない。**

| ゲート | 結果 | 報告との一致 |
|--------|------|------------|
| `pnpm test:unit` 相当 | **5 ファイル red / 54 green（59）/ 28 failed / 827 passed（855）** | ✅ |
| `pnpm test:integration` 相当 | **2 ファイル red / 9 green（11）/ 20 failed / 88 passed（108）** | ✅ |

- **既存 827 unit / 87 integration は 1 件も落ちていない**（退行なし）。
- integration の `88 passed` は既存 87 + `form-session-recovery.int.ts` の 1 件目（前提の再現 / 意図的に green）。
  内訳（recovery 4 red + uploads 16 red = 20）も申告どおり。

---

## 1. 依頼事項への回答（Must Fix に該当しないもの）

### 依頼 4: マジックバイト検証 — **契約として十分**

`upload-validation.test.ts` は次を測っており、指摘は無い。

- 実体 HTML / SVG / ZIP を `image/jpeg` と申告 → 拒否（`it.each` で 3 種）
- 実体は画像だが申告と違う（PNG を jpeg と申告）→ 拒否
- **WebP は `RIFF` と `WEBP` の両方を見る**（`RIFF` は WAV / AVI のコンテナ署名でもあるため、
  片方だけでは音声・動画が通る）——この 1 件は指摘されなければ落ちやすい箇所で、質が高い
- 先頭不足・空バイトは**例外にせず false**（SEC-042 / SEC-060 と同型の 500 経路を作らない）
- `image/jpeg; charset=binary` を許容（正規利用者を弾かない）
- `isDeclaredSizeAcceptable` が**型まで検査**（`-1` / `NaN` / `Infinity` / 非整数）

依頼にあった「JPEG ヘッダを持つ実行可能ファイル」は**先頭 12 バイト検証では原理的に検出できない**
（polyglot）。これは設計の欠陥ではなく手法の限界だが、**残余として記録されていない** → SF-2。

### 依頼 5: AC-PII-11 — **3 条件すべてが測れる形**

`orphan-uploads-batch.test.ts` は (a) 200 件で打ち切り正常終了 / (b) 2 回目で残り 100 件 /
(c) **失敗した対象の DB 行を消さない**をそれぞれ独立に測る。加えて

- `listExpired` に**上限を渡す**（全件取得 → メモリ `slice` を禁じる）
- 1 件の失敗で全体が止まらない / バッチ全体が例外を投げない
- ログに `objectKey` 全体を出さない
- `ORPHAN_RETENTION_HOURS === RETENTION_PERIODS.orphanUploadHours`
- `now` を注入（`Date.now` を直接読まない）

依存注入型にした判断（「実 DB を要求すると**測らない口実になる**」）も正しい。

### 依頼 6: `objectKey` の推測不可能性 / 署名 URL の期限 — **十分**

200 回発行して 200 種 / 乱数部 ≥22 文字 / 連番でない / 時刻を含まない / `public` や `http` を含まない /
`UPLOAD_URL_EXPIRES_IN_SEC === 300`。
**`generateObjectKey` の引数を `side` だけに固定**して「ファイル名や氏名を材料にできない」ことを
型で担保した設計は良い（AC-PII-1 をコメントではなくシグネチャで守っている）。

### 依頼 1 前半: red は本物か — **本物**（ただし 44 件は未評価）

- `storage-adapter`（17）と `uploads-route-contract`（11）は**個別に red**。
- `upload-validation` / `upload-token` / `orphan-uploads` の 3 ファイルは対象モジュールが無く
  **ファイル単位 red**（44 件が一度も評価されていない）。
  §11.4 が P3-c1 の REV-P3C1-010 と同じ検算手順を申し送っており、扱いとして正しい。
  **この 44 件は「実装後に意図した理由で green か」を必ず確認すること**を再度強調する。

---

## 2. 指摘事項（Must Fix）

### [MF-1] RV-P3B-019 の中心機構（`TRUST_PROXY=1`）が **どこにも設定されていない**

- **種別**: Bug（設計の未結線）
- **重要度**: **Must Fix**
- **場所**: `playwright.config.ts:41-51`（`webServer`）/
  `tests/e2e/playwright/license-upload.spec.ts:39, 85-95` / 設計文書 §9.1
- **現状**: 設計は RV-P3B-019 を「**E2E サーバーを `TRUST_PROXY=1` で起動し、テストごとに
  異なる `X-Real-IP` を送る**」で解くと宣言している。テスト側は `beforeEach` で
  `context.setExtraHTTPHeaders({ 'x-real-ip': ... })` を実際に送る。

  **しかし `playwright.config.ts` の `webServer` に `env` の指定が無い**（`command` / `url` /
  `timeout` / `reuseExistingServer` のみ）。`TRUST_PROXY` はリポジトリのどこにも設定されていない。

  したがって E2E サーバーでは:

  ```
  resolveTrust(undefined) → VERCEL !== '1' かつ TRUST_PROXY undefined → { trusted: false }
  → resolveClientIp は ENV_TRUSTED_IP_HEADERS を**一度も見ない**（:114-117 の手前で return）
  → 送っている X-Real-IP は完全に無視される → key='unknown' の縮退構成のまま
  ```

  **軸は 1 つも分かれない。** 無コスト枠は全テストで共有される 10 枚のままなので、
  `RV-P3B-019: 申込送信が成功する経路` は**印が付いた Cookie で送信して Tier B に落ち**、
  P3-b が報告した「E2E の通常操作だけで窓内 23 回」の状況がそのまま再現する
  ——つまり **RV-P3B-019 は解けていない**。

  これは「受け口（`TRUST_PROXY`）は在るが、**呼び出し元がその状態を作らない**」という、
  本設計が §5 冒頭で「最初から設計に入れる」と宣言した型の 4 段階目そのものである。

- **改善案**:
  1. `playwright.config.ts` の `webServer` に `env: { ...process.env, TRUST_PROXY: '1' }` を足す。
     **`env` を指定すると Playwright は既定の環境を置き換えるので、`...process.env` の展開を忘れないこと**
     （`CI` / `DATABASE_URL` / `FORM_SESSION_SECRET` 等が落ちると webServer が起動しない）。
  2. **設定されていることを pin する。** 実装が入ってから静かに外れる経路を残さない。
     既存の `trust-proxy-env.test.ts` が「ルートが `trustProxy` を渡していない」ことを
     ソースで固定したのと同じ形で足せる:

     ```ts
     it('E2E の webServer に TRUST_PROXY=1 が設定されている（RV-P3B-019 の軸分離）', () => {
       const source = readFileSync(resolve(process.cwd(), 'playwright.config.ts'), 'utf8')
       const webServer = source.match(/webServer\s*:\s*\{[\s\S]*?\n\s{2}\}/)
       expect(webServer, 'webServer 定義が読み取れない').not.toBeNull()
       expect(webServer![0], 'TRUST_PROXY が無いと X-Real-IP は無視され軸が分かれない')
         .toMatch(/TRUST_PROXY\s*:\s*['"]1['"]/)
     })
     ```
  3. 併せて設計文書 §9.1 に、**この設定が本番へ漏れない根拠**（`playwright.config.ts` は
     デプロイ対象でない）と、**ヘッダを送らないスペックは従来どおり縮退のまま**であること
     （`x-real-ip` も `x-forwarded-for` も無ければ `resolveClientIp` は `unknown` を返す）を明記する。
     後者は**この設計の安全性の要**である——既存 166 件の意味を変えないことがこれで担保される。
- **理由**: 依頼事項 3 は「env で枠を緩める解法になっていないか」を厳しく見よ、というものだった。
  **解法そのものは正しい**（§3 の判定を参照）。しかし**その解法が実行されない**なら、
  RV-P3B-019 は P3-c2 でも閉じない。設計文書には「解いた」と書かれているので、
  記録としても不正確になる。

### [MF-2] P3c-1（uploads の流量防御）に**振る舞いの実測が無く**、閾値の上界も固定されていない

- **種別**: Design（テストカバレッジ / セキュリティ）
- **重要度**: **Must Fix**
- **場所**: `tests/unit/uploads-route-contract.test.ts:71-82` / `tests/integration/uploads-license.int.ts` /
  設計文書 §5・§11.5-2
- **現状**: 監査 §F の P3c-1 は「**SEC-057 の修正を、アップロード経路にも同じ形で適用する**」であり、
  着手ブロッカー C-1 と同一の項目である。ところが本設計で P3c-1 を守っているのは
  **ソース文字列の検査 3 行だけ**である:

  ```ts
  expect(source).toMatch(/limiters\s*:/)
  expect(source, 'limiters.source が無い').toMatch(/source\s*:/)
  expect(source, 'limiters.formSession が無い（P3c-1）').toMatch(/formSession\s*:/)
  ```

  3 つの問題がある。

  1. **`/source\s*:/` は `limiters` の中を見ていない。** ファイル内のどこかに `source:` という
     文字列があれば通る（コメント・別の変数宣言でも一致する）。
     最も重要な契約（設計文書自身が「本ファイルで最も重要なテスト。P3c-1 の本体」と書いている）が、
     **構造を見ないパターン一致**に乗っている。
  2. **構築時検査（SEC-058）は保険にならない。** `lib/public-guard.ts` の検査は
     `if (limiters?.source || limiters?.formSession || formSessionKey)` を入口にしており、
     **3 つとも渡さない構成（表の (0)）は意図的に throw しない。**
     したがって「`limiters` を丸ごと書き忘れた uploads ルート」は
     **構築時にも通り、上記の弱い regex も（コメント次第で）通りうる。**
  3. **振る舞いを測るテストが 1 件も無い。** `uploads-license.int.ts` の 16 件を確認したが、
     レート制限・Tier D に関する測定は無い（`403` は IDOR と単回使用の文脈のみ）。
     SEC-057 では `form-session-issue-cost.test.ts` と `form-session-cost.int.ts` が
     **「Cookie を N 枚取り直しても本体到達数に枚数非依存の上限がある」ことを実測**した。
     P3c-1 が「**同じ形で**適用する」と言っている以上、同じ**測り方**が要る。
     現状は配線の綴りだけを見ており、**形だけになっている。**

  さらに §11.5-2 は `uploads` の Tier D 閾値を「**具体値は Impl が決め、定数として pin し直すこと**」と
  Impl へ委ねているが、**上界の制約が無い。** Impl が 1000 と置いても赤くならない。
  F-009 の境界値表は「1 申込あたり最悪 8 回を上回る値」という**下界**しか与えていないので、
  上界を決めるのはテスト設計の仕事である。

- **改善案**: `tests/integration/uploads-license.int.ts`（または新規 `uploads-cost.int.ts`）に
  **SEC-057 と同じ形の実測**を 2 件足す。

  ```ts
  const UPLOADS_REACH_BOUND = FORM_SESSION_FREE_ISSUE_LIMIT * UPLOADS_FORM_SESSION_LIMIT

  it('Cookie を取り直しても、発行できる署名付き URL の総数に枚数非依存の上限がある', async () => {
    // 縮退構成では発信元軸が計数のみなので、実際に効くのは
    // 「無コストで得られる Cookie 枚数 × 1 枚あたりの発行上限」である（SEC-057 と同じ算術）。
    let issued = 0
    for (let n = 0; n < 40; n++) {
      const cookie = await freshFormSessionCookie()          // GET /api/form-session の本番経路
      for (let i = 0; i < UPLOADS_FORM_SESSION_LIMIT + 2; i++) {
        if ((await issue(validBody(), { cookie })).status === 201) issued++
      }
    }
    expect(issued).toBeLessThanOrEqual(UPLOADS_REACH_BOUND)
  })

  it('上界が実測に張り付いている（閾値が緩められたら赤くなる）', async () => { /* toBe(...) */ })
  ```

  併せて `uploads-route-contract.test.ts` の 3 行を**構造を見る形**へ締める
  （`limiters` の値部分を切り出してから `source` / `formSession` を探す。
  `applications-route-contract.test.ts` が既に同種の切り出しをしている）。
  さらに §11.5-2 の閾値に**上界の式**を与えること（例: `UPLOADS_FORM_SESSION_LIMIT <= 8 * 2` 等、
  「最悪 8 回」に対する余裕の根拠を定数で表す）。
- **理由**: uploads は**免許証画像**の受け口である。監査 §F 理由 2 が挙げた帰結
  （費用・違法画像の受け入れ・orphan 回収の破綻）は、いずれも「発行数が実際に頭打ちになる」ことでしか
  防げない。綴りの検査は「配線し忘れ」しか捕まえず、「配線したが上限が緩い」を捕まえない。

### [MF-3] 回復経路 `POST /api/form-session` の**配線契約が無い**（ラッパは通るが軸がゼロでも通る）

- **種別**: Design（セキュリティ）
- **重要度**: **Must Fix**
- **場所**: `tests/integration/form-session-recovery.int.ts:233-248` / 設計文書 §7 の契約コード
- **現状**: `POST /api/form-session` は**新しい公開変更系エンドポイント**である。
  ところが測られているのは「ラッパを通ること」（Origin 検証と `challenge` を含まない 403）だけで、
  **`limiters` / `formSessionKey` / `semaphore` を要求する pin が 1 件も無い。**

  MF-2 と同じ理由で、これは保険が効かない: 構築時検査は 3 つとも渡さない構成を throw しないので、

  ```ts
  export const POST = withPublicMutation(handler, {
    endpoint: 'applications',
    requireContentType: 'json',
    verifyFormSession: ...,        // limiters を丸ごと書かない
  })
  ```

  が**構築時にも結合テストにも捕まらない**。この形だと **Tier D 軸がゼロの公開エンドポイント**が
  できる——そこは Turnstile の siteverify（外部 API）を無制限に叩ける入口でもある
  （当校の Turnstile クォータと Cloudflare への往復を、未認証の第三者が自由に消費できる）。

  加えて設計文書 §7 の契約コードは `endpoint: 'applications'` を指定しているが、
  **その根拠が書かれていない。** これは §5 が uploads について
  「`endpoint: 'uploads'`（**applications のセマフォと混ざらない**）」と書いた原則と正面から矛盾する。
  `endpoint: 'applications'` を採ると、回復要求が**申込送信と同じ発信元軸・同じセマフォ**を消費する
  （`trusted` では発信元軸は 5 回/10 分の**硬いゲート**である）。
  意図的にそうするなら理由が要り、意図的でないなら分けるべきである。
- **改善案**:
  1. `tests/unit/` に `form-session-route-contract.test.ts` を足し、
     `uploads-route-contract.test.ts` と**同じ 7 項目**（`withPublicMutation` / `limiters` の
     source と formSession / `endpoint` / `formSessionKey` / `verifyFormSession` /
     `semaphore` / `clientIp`）を `POST` に対して固定する。
  2. `endpoint` をどちらにするかを決め、**理由を設計文書に書く**。
     私見では **`endpoint: 'form-session'` に分けるべき**である——回復は申込送信より
     はるかに軽い操作であり、同じ枠を食い合う理由が無い。分ければ
     「回復を試みたせいで申込が 429 / 202 になる」経路も消える。
  3. §7 の契約コードの `...共通ラッパ` という省略をやめ、**全項目を明示**すること
     （省略された箇所は実装されない、というのがこの単位で 4 回観測された事実である）。
- **理由**: SEC-058 で構築時検査を全構成へ広げたときの原則は
  「**軸は完成しているか、最初から無いか**」であり、(0) を許すのは
  「ラッパを Origin / Content-Type 検証だけに使う経路」を想定したためである。
  回復経路は**印の無い Cookie を発行する**エンドポイントなので、その想定に当てはまらない。

---

## 3. 指摘事項（Should Fix）

### [SF-1] E2E が `trusted` になると、**縮退経路のブラウザ級カバレッジが消える**

- **場所**: 設計文書 §9.1
- MF-1 を修正すると、`x-real-ip` を送るスペックは `trusted=true` になる。
  `lib/form-session-issue.ts:254` は `!clientIp.trusted` でガードされているので、
  **それらのスペックでは `unverified` の印が一度も付かない**——つまり
  SEC-057 の印・Tier B・SEC-067 の回復経路は**ブラウザ級では 1 件も通らなくなる**。

  現状（縮退）ではむしろ印が付きすぎて flaky だったのだから、これは改善である。
  だが「**今まで通っていた経路が今後は通らない**」ことは**記録されるべき**である。
  実際、依頼 3 の「上限を緩める形になっていないか」に対する私の判定は
  「**緩めていない**」（§4 参照）だが、それは
  「**縮退経路の検証を integration が引き受けている**」ことが前提になる。

  幸い引き受け先は存在する（`form-session-cost.int.ts` / `form-session-recovery.int.ts` /
  `form-session-degraded-recovery.test.ts`）。**その対応関係を §9.1 に表で書くこと**
  ——「E2E から落ちた検証を何が担保するか」を明示すれば、次に E2E を読む人が
  「印の経路は誰も見ていない」と誤読しない。

### [SF-2] polyglot（JPEG ヘッダ + 別ペイロード）は先頭 12 バイト検証では検出できない

- **場所**: `tests/unit/upload-validation.test.ts` / 設計文書 §3
- `FF D8 FF` で始まり後続に ZIP / 実行ファイルを連結したファイルは `detectImageType` を通る。
  **これは手法の限界であって設計の誤りではない**が、§3 の「実体が何かを確かめる」という
  記述は polyglot まで防げるように読める。残余として明記し、補償が何かを書くこと:
  (a) バケットは非公開で署名付き URL のみ、(b) 保存する `contentType` は**検出結果**に固定する、
  (c) **F-018 の閲覧経路で `X-Content-Type-Options: nosniff` と
  `Content-Disposition: attachment` を付ける**。
  (c) は P3-c2 のスコープ外だが、**持ち越し条件として書いておかないと F-018 で漏れる**
  （§3 が XSS の懸念を挙げているのは、まさにその経路である）。

### [SF-3] WebKit の skip を「完了記録」でどう扱うかが未規定

- **場所**: 設計文書 §9.2
- 「**3 ブラウザで green と書いて実際には 2 ブラウザ、という状態を作らない**」という方針は正しく、
  `test.skip` に理由をコードで残す実装も適切である。
  ただし**記録側の運用が書かれていない**。`uploads-license.int.ts:60-63` が自ら引用しているとおり、
  このプロジェクトは「**skip は『あるのに動いていない』テストとして残り、後で『あるから確認済み』と
  誤読される**」ことを戒めている。
  完了報告に **「166 passed / N skipped（うち uploads 系 M 件は WebKit 除外）」**の形で
  skip の内訳を必ず併記する、と §9.2 に 1 行足すこと。

---

## 4. 依頼 3 への判定: 「軸を分ける」は**正しい解法である**（env で緩める形ではない）

MF-1 とは独立に、解法そのものを評価した。**緩めていない。** 根拠:

| 観点 | 判定 |
|------|------|
| 閾値・窓を変えたか | **いいえ。** `FORM_SESSION_FREE_ISSUE_LIMIT` も `FORM_SESSION_ISSUE_LIMIT` も窓も不変 |
| env が防御を弱める方向に働くか | **いいえ。** `TRUST_PROXY=1` は発信元軸を**有効化**する。むしろ `trusted` では発行の硬い上限 30 が**ゲートとして効き始める**（縮退では計数のみだった） |
| 本番との乖離 | **縮まる。** 本番（Vercel）の発信元軸は実 IP 単位。全員が共有 `unknown` を使う縮退のほうが乖離していた |
| 本番へ漏れる経路 | `playwright.config.ts` はデプロイ対象でない。ただし**明記が必要**（MF-1 の改善案 3） |
| ヘッダを送らない既存スペックへの影響 | **無い。** `x-real-ip` も `x-forwarded-for` も無ければ `resolveClientIp` は `unknown` を返す（`lib/http-guard.ts:170-177`）。**既存 166 件の意味は変わらない** |
| `x-real-ip` を選んだ根拠 | 正しい。`ENV_TRUSTED_IP_HEADERS = ['x-real-ip', 'x-forwarded-for']`（`lib/http-guard.ts:114-117`）を自分で確認した |

最後の 2 行は**この設計の安全性の要**でありながら設計文書に書かれていないので、
MF-1 の改善案 3 として明記を求めている。

---

## 5. Nit

### [N-1] §11.5-1（`maxBodyBytes` を上げない判断）— **その判断で正しい**

発行 API は小さな JSON しか受けず、**バイトはラッパを通らない**（署名付き PUT はストレージ直結）。
`docs/phase-status.md` の申し送りは「上げる場合」の条件付きなので、
上げないなら `public-guard-body-stream.test.ts` を回し直す必要は無い。
ただし**この判断そのものを §11.5 に「Senior 確認済み」として確定形で残すこと**
（「確認を仰ぎたい」のまま残すと、次の単位で同じ検討が再発する）。

### [N-2] `expect(generateObjectKey.length).toBe(1)` は既定引数で崩れる

`Function.prototype.length` は**最初の既定引数より前**の個数を返すので、
`generateObjectKey(side, opts = {})` と書かれると **1 のまま通る**。
「`side` 以外を受け取れない」の実質的な担保は TypeScript のシグネチャ側にある。
コメントにその旨（この pin は補助であり、主たる担保は型）を 1 行足すと誤読が減る。

---

## 6. 良い点

- **`beforeAll` の import をやめて `expect.fail` で個別に落とした判断**（`uploads-license.int.ts:57-75`）。
  16 skipped → 16 failed へ直した理由（「skip は『あるのに動いていない』テストとして残る」）が
  自分の言葉で書かれている。**指摘される前に自分で直した**箇所である。
- **`verifyUploadTokenBinding` を `boolean` に固定**した設計（§4）。
  「呼び出し側が `reason` で分岐できると、応答が分かれるのは時間の問題」という理由付けは、
  `lib/public-guard.ts` が Tier B の本文を 1 つに固定した判断と同じ原理で一貫している。
  **列挙攻撃をシグネチャで防ぐ**のは、コメントで禁じるより強い。
- **`generateObjectKey(side)` の引数を 1 つに絞った**こと（§2）。
  AC-PII-1（`objectKey` にファイル名や氏名を含めない）を**型で**守っている。
- **Blob → DB の順序の根拠**（§6）が「逆順だと**どのオブジェクトを消すべきかの記録が失われる**」と
  結果から説明されている。順序を「決まりだから」ではなく失敗モードから導いている。
- **`upload-validation` の WebP 判定**（`RIFF` だけでは WAV / AVI を通す）。
  仕様書に書かれていない実装上の罠を先回りしている。

---

## 7. 再レビューの条件

1. **MF-1**: `playwright.config.ts` に `env: { ...process.env, TRUST_PROXY: '1' }`（+ pin 1 件、+ §9.1 の明記 2 点）。
2. **MF-2**: uploads の流量に**振る舞いの実測**を 2 件（枚数非依存の上限 / 上界への張り付き）、
   `uploads-route-contract.test.ts` の 3 行を構造を見る形へ、§11.5-2 に閾値の**上界**。
3. **MF-3**: `form-session-route-contract.test.ts`（7 項目）、`endpoint` の決定と根拠、§7 の `...共通ラッパ` の展開。
4. SF-1 / SF-2 / SF-3 は採否を判断し、**採らない場合は理由を設計文書に残すこと**。
