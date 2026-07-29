# P3-c1（前提ハードニング）実装記録

## 作成日: 2026-07-29
## 担当: Impl Agent（`.claude/skills/impl.md`）
## 正典: `docs/test-design-p3c1-2026-07-29.md`（テスト契約＝実装仕様）
## Senior 申し送り: `docs/review-p3c1-tests-re2-2026-07-29.md` §8

---

## 着手前の実測（オーケストレーターからの引き継ぎ値）

| ゲート | 値 |
|--------|-----|
| `pnpm test:unit` | 54 ファイル / 826 件（**54 failed** / 772 passed） |
| `pnpm test:integration` | 9 ファイル / 86 件（**4 failed** / 82 passed） |
| `pnpm type-check` | red（テストが未実装の API を参照） |

## 着手順（§12.1 に従う）

1. SEC-058（`lib/public-guard.ts` 構築時検査）
2. SEC-061 / SEC-069（`TRUST_PROXY`）
3. SEC-064（Prisma ログ）
4. SEC-060（`courseId` 分類）
5. SEC-046（cron 試行制限）
6. SEC-065（`/privacy` + `RETENTION_PERIODS`）
7. SEC-067 / SEC-068（回復経路 + 印の不可読化 + 結線 + RE2-001）
8. SEC-063 — **着手しない**（繰越）

---

## SEC-058 / P3c-2 — `withPublicMutation` の構築時検査を全構成へ広げる ✅

### 何をどう変えたか

`lib/public-guard.ts` の構築時検査の**入口条件だけ**を変えた。

```diff
- if (limiters?.source) {
-   if (!limiters.formSession) { throw ... }
+ if (limiters?.source || limiters?.formSession || formSessionKey) {
+   if (!limiters?.formSession) { throw ... }
    if (!formSessionKey) { throw ... }
  }
```

判定の本体（「formSession 軸が完成しているか」）は変えていない。
検査の**トリガ**を「`limiters.source` を渡したか」から
「**軸に関するオプションを 1 つでも渡したか**」へ広げただけである。

例外メッセージの 1 本目を「`limiters.source` を渡す構成では〜」から
「**軸を渡す構成では〜**」へ書き換えた。旧文言は (c)/(d)（source が無い構成）で
事実に反する説明になるため。`endpoint` と `limiters` / `formSession` の語は保持しており、
テストの `/formSession/i` `/limiters/i` `toContain(ENDPOINT)` は全て満たす。

### なぜその形にしたか

構成の全数表（正典 §2）に対して、この 1 行の入口条件が過不足なく一致する:

| # | source | formSession | key | 期待 | 到達する分岐 |
|---|---|---|---|---|---|
| (0) | — | — | — | 通す | 入口 false |
| (a) | ✓ | — | — | throw | 1 本目（`formSession` を含む） |
| (b) | ✓ | ✓ | — | throw | 2 本目（`formSessionKey` を含む） |
| (b') | ✓ | — | ✓ | throw | 1 本目 |
| (c) | — | ✓ | — | throw | 2 本目 |
| (d) | — | — | ✓ | throw | 1 本目（`limiters` を含む） |
| (e) | — | ✓ | ✓ | 通す | 両分岐を抜ける |
| (f) | ✓ | ✓ | ✓ | 通す | 同上 |

「軸を持たない構成 (0) は許し、半端な構成だけ落とす」という原則
（`lib/public-guard.ts:259-262` の自己申告）を壊していない。

### ⚠️ Senior / オーケストレーターへの申告: **テストファイルを 1 箇所触った（fixture のみ / assertion は不変）**

実装だけを入れた時点で **`tests/unit/public-guard.test.ts` が 13 件 red になった**
（既存 47 ファイルの退行）。原因は同ファイルの `baseOptions()` が

```ts
formSessionKey: formSessionAxisKey,   // limiters は渡していない
```

であり、これは新契約の **(d) そのもの**だからである。
**新テスト (d) と既存 `public-guard.test.ts` は、実装からは区別不能な同一構成**であり、
実装側だけで両立させる方法は無い（両者のオプションは完全に同一）。

採った対応: `baseOptions()` に `limiters: { formSession: formSessionAxis() }` を足し、
構成 **(e)**（軸として完全）にした。**assertion は 1 文字も変えていない。**

これが振る舞いを変えないことの根拠（ソースで検算した）:

- `formSessionAxis()` は同ファイル :91 に**既に存在する** fixture であり、
  同ファイル :83-90 のコメントが「構築時検査を満たすために置いた / 振る舞いは変わらない」と
  既に明言している。:142 / :201 / :331 / :361 の 4 箇所は同じ目的で個別に渡していた。
  今回の変更は**その個別対応を既定へ寄せただけ**である。
- formSession 軸が push されるのは `formSessionKey(request) !== null` のときだけ
  （`lib/public-guard.ts:324`）。`formSessionAxisKey` → `readFormSessionCookie` は
  Cookie 名 `__Host-fs` だけを読む（`lib/form-session.ts:263-274`）が、
  **本ファイルの `request()` が送る Cookie は `fs=...`**（:287 / :371）である。
  したがって `formSessionAxisKey` は全テストで `null` を返し、**軸は 1 度も作られない。**
- 実測: 変更後 `public-guard.test.ts` 23 件全 green（変更前の baseline と同一）。

判断はオーケストレーターに委ねる。**テストが間違っていたとは考えていない**——
新旧 2 つのテストファイルの間の衝突であり、片方の fixture を新契約に適合させる以外に
解が無い、という性質の問題である。

### 実測

- `tests/unit/public-guard-construction-p3c.test.ts`: **9/9 green**（red 3 → 0）
- `tests/unit/public-guard.test.ts`: **23/23 green**（退行なし）
- unit 全体: 826 件中 **51 failed**（着手前 54 → SEC-058 の 3 件が解消）

### 検証できていないこと

- `pnpm build` / `pnpm test:e2e` は未実行（オーケストレーターの担当）。
  本番の唯一の呼び出し元は `app/api/applications/route.ts:244` で構成 (f) なので、
  構築時 throw は起きないはずだが、ビルドでの実測はしていない。

---

## SEC-061 / SEC-069 / P3c-5 — `TRUST_PROXY` ✅

### 何をどう変えたか

**1. `lib/env.ts`**: `serverEnvShape` に `TRUST_PROXY` を追加。

```ts
TRUST_PROXY: z.enum(['1', 'true', '0', 'false'], { errorMap: ... })
  .optional()
  .transform((raw) => raw === '1' || raw === 'true'),
```

`z.enum` にしたのは「未設定 → false / 受理外 → 起動時に落とす」を 1 つの宣言で満たすため。
`z.coerce.boolean()` や `z.string().optional()` + 手書き変換だと `'yes'` が黙って
true / false のどちらかに倒れる（SEC-069 が問題にした誤認そのもの）。
`''`（空文字）も enum を外れるので throw する（テストが要求）。

**2. `lib/http-guard.ts`**: 信頼の**出所**（provenance）という概念を導入した。

- `TRUSTED_IP_HEADERS` を **2 本に分割**:
  - `PLATFORM_IP_HEADERS` = `x-vercel-forwarded-for` → `x-forwarded-for` → `x-real-ip`（従来）
  - `ENV_TRUSTED_IP_HEADERS` = **`x-real-ip` → `x-forwarded-for`**（`x-vercel-forwarded-for` を含まない）
- `resolveTrust(explicit)` を private 関数として切り出し、
  `{ trusted, provenance }` を返す。決定順は
  `options.trustProxy` → `process.env.TRUST_PROXY` → `process.env.VERCEL === '1'`。
- `resolveClientIp` は `provenance === 'env'` のときだけ `ENV_TRUSTED_IP_HEADERS` を使う。

**3. コメント**: `resolveClientIp` の運用指示を「`trustProxy` を有効化すること」から
「**環境変数 `TRUST_PROXY=1` を設定すること**」へ書き換え、
**append 構成（`$proxy_add_x_forwarded_for`）の危険**を明記した。
`ResolveClientIpOptions.trustProxy` の docstring に「本番ルートは渡すな」を追記。

**4. `docs/tech-stack.md` §4.5**: 「`trustProxy` を有効化せよ（手段は無い）」という
食い違いを訂正ブロックとして記録し、`TRUST_PROXY` の値表・provenance 別のヘッダ表・
append 構成の警告を追記した。SEC-069 の本体は**文書と実装の食い違い**なので、
実装だけ直して文書を放置すると ID が閉じない。

### なぜその形にしたか

- **provenance を「trusted の真偽」と分離した。** `VERCEL=1` かつ `TRUST_PROXY=1` の構成で
  `provenance='env'` にしてしまうと、Vercel 上で `x-vercel-forwarded-for` を捨てることになり
  「Vercel の手前に自前プロキシを置いた構成で XFF 汚染に負ける」（テスト :301 / :318 が禁じている）。
  そこで **provenance は「プラットフォームを検出しているか」だけで決め**、
  trusted の真偽は決定順（明示 → env → プラットフォーム）で決めるという 2 軸にした。
- **`process.env` を直読みしている。** `getServerEnv()` は初回 parse をキャッシュするため
  （`lib/env.ts`）、`resolveClientIp` から呼ぶと afterEach で env を戻すテストが噛み合わない。
  検証（zod / 起動時 fail-fast）と使用（直読み）が別経路になることは正典 §3 が認識しており、
  REV-P3C1-009 の要求どおり**使用側でも不正値を false に倒す**（`raw === '1' || raw === 'true'`
  という allow-list なので、`'yes'` は自動的に false）。
- **`x-real-ip` を必須にしなかった。** 必須にすると上書き構成（正しく設定された前段）で
  XFF しか送らない環境が永久に縮退する。順序を変えるだけで採用可能な集合は狭めていない。

### 実測

- `tests/unit/trust-proxy-env.test.ts`: **24/24 green**（red 11 → 0）
- 退行なし: `client-ip.test.ts` 15 / `env.test.ts` 11 / `env-p3a-fail-fast.test.ts` 8 /
  `env-p3b-fail-fast.test.ts` 11 / `http-guard.test.ts` 9 — **全 green**

### 検証できていないこと

- **実際の非 Vercel 配備での動作は未検証**（env を立てた実 HTTP は E2E の範囲外でもある）。
  測っているのは `resolveClientIp` の単体の振る舞いと、本番ルートが `trustProxy` を
  渡していないことのソース検査だけである。
- `TRUST_PROXY` を本番必須キー（`PRODUCTION_REQUIRED_KEYS`）には**入れていない**。
  Vercel 配備では不要であり、必須化すると理由なくデプロイが落ちる。
  「非 Vercel 本番で未設定なら落とす」という判定は**実装から非 Vercel 本番を検出できない**
  （それが SEC-061 の出発点）ので書けない。テストも要求していない。

---

## SEC-064 / P3c-8 — Prisma のエラーログを `lib/pii-log.ts` へ合流 ✅

### 何をどう変えたか

`lib/db.ts` を書き換えた（新規 export 3 つ + 構築方法の変更）。

**1. 構築を文字列レベル配列からイベント方式へ**

```ts
// 旧: Prisma が自分で stdout/stderr へ書く（アプリのロガーを一切通らない）
// 新:
const logDefinitions =
  process.env.NODE_ENV === 'development'
    ? ([{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }] as const)
    : ([{ emit: 'event', level: 'error' }] as const)
new PrismaClient({ log: [...logDefinitions] })
```

`warn` を開発時のみ購読するのは**旧挙動との等価性を保つため**（旧 `lib/db.ts:14` も
development のときだけ warn を出していた）。

**2. `prismaErrorLogFields(event)` — `message` を返さない**

- `errorCode`: メッセージ本文から `/\bP\d{4}\b/` で抽出。読めなければ `'UNKNOWN'`。
- `target`: `/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/` + 128 文字上限を
  通ったものだけ残す。外れたらキーごと**省略**する（空文字を入れると
  「検査した結果 falsy になった」のか「無かった」のか区別できない）。
- `message` は**返さない**。「サニタイズして残す」形にしなかった理由は正典 §8 のとおり
  ——どの値がメッセージのどこに現れるかは Prisma のバージョンとエラー種別に依存し、
  列挙で追随できない。`toErrorLogFields` の既存判断と揃えた。

**3. `attachPrismaLogging(client, logger)`**

`$on('error')` と `$on('warn')` を張り、`logger[level]('prisma', prismaErrorLogFields(event))`
へ流す。**`try/catch` で握り潰す**——ログは失敗経路で呼ばれるので、
投げると「エラー処理中にエラー」になる（`lib/pii-log.ts` の `createPiiSafeLogger` と同じ配慮）。

**4. `PrismaLogEmitter` インタフェース（契約に無かったが追加した）**

正典 §8 の契約は `attachPrismaLogging` の第 1 引数をインライン構造型で書いていた。
同じ構造を named interface として export しただけで、**構造的には完全に一致する**
（テストは `client as never` で渡すので影響しない）。本番側で
`client as unknown as PrismaLogEmitter` と書く必要があったため名前を付けた。

### なぜ本番側でキャストしているか（正直な記録）

`PrismaClient` の `$on` の型は `log` 設定の**リテラル型**から導出されるが、
本設定は `process.env.NODE_ENV` で分岐するためリテラル型を保てない。
そこで `client as unknown as PrismaLogEmitter` でキャストしている。

**これは型の穴である。** ただし穴の範囲は「`$on` の level 文字列と
コールバック引数の形」に限られ、`PrismaLogEmitter` で構造的に固定してある。
`emit: 'event'` を書き忘れて Prisma が直接書く形に戻る退行は、
`prisma-error-log.test.ts` のソース検査 4 件が捕捉する（キャストでは隠れない）。

### ⚠️ §14 / REV-P3C1-010 の確認（`TypeError` で落ちていた red の検算）— **実施した**

「実装後に意図した理由で green になったか」を、**実装をわざと壊して red になるか**で確認した。
5 通りの変異をそれぞれ**独立に**当て、毎回元に戻して測った。

| 変異 | red になったテスト | 件数 |
|------|-----------------|------|
| A: `prismaErrorLogFields` が `message` を返す | 「message を返さない」/「objectKey・uploadToken も返さない」/「$on("error") が張られ〜」 | **3** |
| B: `errorCode` を常に `'UNKNOWN'` にする | 「Prisma のエラーコードは残す」 | **1** |
| C: `target` の形式検査を外す（素通し） | 「target に値が混ざっていても素通しにしない」 | **1** |
| D: `$on` を張らない | 「$on("error") が張られ〜」/「PII セーフラッパ〜」/「ロガーが throw しても〜」 | **3** |
| E: `forward` の `try/catch` を外す | 「ロガーが throw してもアプリを落とさない」 | **1** |
| 復元後 | — | **13/13 green** |

**assertion は空振りしていない。** 特に A は「値が実際にログへ出る」という
SEC-064 の本体そのものを 3 件が同時に捕捉している。

**ただし 1 件だけ弱い**（正直に記録する）: 「PII セーフラッパを通した場合、禁止キーが落ちる」
（:200）は **D（`$on` を張らない）でしか red にならなかった**。
`prismaErrorLogFields` が `objectKey` を最初から返さないため、
`createPiiSafeLogger` の `PII_DENY_KEYS` フィルタは**この経路では一度も仕事をしていない**。
このテストが実際に測れているのは「合流していること」であって
「列挙が Prisma 経路に効くこと」ではない。テストは変更していない
（意図した性質を測れていないだけで、誤りではない）。
**P3-c2 で `prismaErrorLogFields` の返却フィールドを増やす場合は、この 1 件が
その増えたフィールドを守らない**ことに注意すること。

### 実測

- `tests/unit/prisma-error-log.test.ts`: **13/13 green**（red 12 → 0）

### 検証できていないこと

- **実 `PrismaClient` に対して `$on('error')` が実際に発火するかは未検証。**
  ユニットはフェイククライアントで測っており、本番構築経路（`createPrismaClient`）が
  正しくイベントを受けるかは integration / 実運用でしか観測できない。
  ソース検査（`emit: 'event'` の存在 / 文字列レベル配列が無いこと）が代替になっているが、
  **「イベントが実際に届く」ことは測れていない。**
- `pnpm build` 未実行のため、`as unknown as PrismaLogEmitter` のキャストが
  Prisma の生成型と噛み合っているかはビルドでは未確認（`pnpm type-check` では確認する）。

---

## SEC-060 / P3c-4 — 実在しない `courseId` を 422 にし、`P2003` を分類する ✅

### 何をどう変えたか（すべて `app/api/applications/route.ts`）

**1. `courseSnapshot` → `lookupCourse` へ置き換え（判別可能 union）**

```ts
type CourseLookup = { found: true; snapshot: CourseSnapshot } | { found: false }
```

旧 `courseSnapshot` は「見つからなければ null のスナップショットで**素通し**」していたため、
実在しない `courseId` は `create` の外部キー違反（`P2003`）まで到達して**未分類の 500**
になっていた。「見つからなかった」を**型で区別**することで、呼び出し側が 422 に落とせる。
`courseId` が null（INQUIRY 経路）なら `{ found: true, snapshot: 空 }` を返す
——照合を type で分けずに書くと**正規の問い合わせが全て 422 になる**。

**2. ハンドラに事前照合を追加**

```ts
const course = await lookupCourse(data.type === 'APPLICATION' ? data.courseId : null)
if (!course.found) return invalid(422, [{ field: 'courseId', code: 'NOT_FOUND' }])
```

**配置は「冪等照合の後・`create` の前」。** 前に置くと、既に受け付けた申込の再送が
「その後コースが削除された」だけで 200（冪等）から 422 へ変わってしまう。
`create` の前に置くのは、分類できる失敗のために DB 書き込みを試みないため
（レート制限を本体より前に置いたのと同じ理由）。
**追加の DB 往復は発生していない**——`courseSnapshot` が元から `findUnique` していたものを
呼び出し位置ごと移しただけで、`createApplication` は結果を引数で受け取る。

**3. `isCourseForeignKeyViolation(error)` を追加し、`catch` を書き換え**

```ts
const COURSE_FK_FIELD_PATTERN = /(^|[^A-Za-z])courseId([^A-Za-z]|$)/
```

`error.meta.field_name` が `courseId` を**単語として**含むときだけ 422 に落とす。
`P2002` の冪等再送分岐と同じ `instanceof Prisma.PrismaClientKnownRequestError` の中に入れた。

### なぜその形にしたか

- **`P2003` を無条件に `courseId` へ落とさなかった**（REV-P3C1-008）。
  P3-c2 が `LicensePhoto` → `Application` という 2 本目の外部キーを作った瞬間、
  無条件分類は `applicationId` の違反を「コースが存在しません」として返す
  ——しかも 422 なので**監視にも上がらない**。
  **本項目を P3-c2 の前に閉じる理由が、そのまま契約を壊す条件になっている。**
- **単語境界を見る正規表現にした。** `field_name.includes('courseId')` でも
  現在のテストは通るが、`applicationId` のような別列に将来誤爆しうる形を選ばない。
  `(^|[^A-Za-z])courseId([^A-Za-z]|$)` は `Application_courseId_fkey (index)` に一致し、
  `LicensePhoto_applicationId_fkey (index)` には一致しない。
- **`field_name` が読めない `P2003` は 500 のまま残した。** 推測して 422 にすると
  「入力が悪い」と嘘をつくことになる（500 は「分類できなかった」という信号である、
  という本項目自身の原則）。

### 実測

- `tests/unit/application-error-classification.test.ts`: **11/11 green**（red 3 → 0）
- `tests/integration/application-course-fk.int.ts`: **4/4 green**（red 2 → 0）
  ——実 DB の外部キー制約に対する本番経路の実測
- 退行なし: `applications-route-contract` 10 / `application-idempotency` 13 /
  `application-pii-log` 11 / `applications.int.ts` 35 — **全 green**

### 検証できていないこと

- **「照合の直後にコースが削除される」レースそのものは再現していない。**
  ユニットは `create` に `P2003` を投げさせて分類だけを測っており、
  結合は実在しない ID を事前照合で落とすところまでしか測っていない
  （実 DB で照合と create の間にコースを消す仕掛けは置いていない。テストも要求していない）。
- 非公開コースの扱い（`application-course-fk.int.ts` :178）は、seed に非公開コースが
  無ければ**実質的に何も測らない**（テスト側がそう書いている）。本実装では
  `published` を照合条件に**入れていない**ので、非公開コースは 201 になる。

---

## SEC-046 / P3c-7 — `withCronAuth` の試行回数制限 ✅（**検知であって抑制ではない**）

### 何をどう変えたか（`lib/cron-auth.ts`）

**新規 export**: `CRON_AUTH_ATTEMPT_LIMIT = 10` / `CRON_AUTH_WINDOW_MS = 10 * 60_000`
**`CronAuthOptions` に追加**: `limiter?` / `now?` / `logger?`

**判定順を組み替えた**（`lib/login-guard.ts` と同じ意味論 = 失敗だけを数える）:

```ts
if (!expected) return notFound()                      // ← 計数しない（後述）
const token = /* Bearer なら中身、そうでなければ null */
if (token !== null && constantTimeEquals(token, expected)) {
  return handler(request, ctx)                        // 成功は常に通す・消費しない
}
await recordFailure()                                 // 欠落・スキーマ違い・誤りを 1 件として計数
return notFound()                                     // 常に同じ 404 / Retry-After 無し
```

旧実装は失敗ごとに別々の `return notFound()` を持っていたので、
**計数点を 1 箇所に集める**ためにトークン抽出を分岐の外へ出した。

**キーは定数** `'cron:auth-failure'`。要求内容を材料にすると値を変えるだけで
新しいバケットが作れて上限を無限に回避でき、store のメモリ増幅（SEC-023）の経路にもなる
（`lib/form-session.ts` の SEC-055 と同型）。

### なぜその形にしたか

- **`limiter` を必須にせず既定を持たせた**（SEC-053 の教訓）。必須にすると
  P3-c / P3-d の cron ルートが渡し忘れたときに**試行制限が存在しないまま**削除バッチが公開される。
- **`logger` も既定を持たせた**（`createPiiSafeLogger(consoleSink)`）。
  契約は `logger?` としか書いていないが、既定を無しにすると
  「渡し忘れると観測が消える」——本項目の成果物は**観測そのもの**なので、
  limiter と同じ理由で既定を置くのが一貫する。テストは常に自前の logger を渡すので影響しない。
- **`CRON_SECRET` 未設定は計数していない。** 構成の失敗であって推測の試行ではなく、
  fail-closed で全要求が 404 になる以上、計数すると上限が即座に埋まって
  「上限到達」ログが**実際の攻撃と区別できなくなる**。
  テストは計数の有無を要求していない（:325 はステータスだけを見る）。

### ⚠️ 記録: **本ラッパは総当たりの速度を落とさない**（REV-P3C1-006）

「成功は常に通す」「上限後も正しいトークンは 200」「応答は常に同じ 404」を同時に満たすため、
**上限に達しても攻撃者の体験は 1 ミリも変わらない**（毎回トークン比較を実行する）。
起きるのは `warn` ログ 1 行だけである。この注記は `lib/cron-auth.ts` のソースにも書いた
——「試行回数制限を入れた」とだけ記録すると、次の監査が
「`/api/cron/**` は総当たりに対して上限がある」と読むため。**そこには上限が無い。**

**SEC-046 は「観測が無い」ことに対する是正としてクローズできるが、
「総当たりが抑制されている」という意味でクローズしてはならない。**

### 実測

- `tests/unit/cron-auth-attempt-limit.test.ts`: **11/11 green**（red 5 → 0）
- 退行なし: `tests/unit/cron-auth.test.ts` **10/10 green**

### 検証できていないこと

- **既定 limiter が本番の複数インスタンス構成で意味を持つかは未検証。**
  `createRateLimiter` の既定 store はインメモリなので、
  インスタンスごとに別カウンタになる（＝ 上限到達ログはインスタンス単位）。
  KV 化の差し替え口は `limiter` オプションとして開いているが、
  **cron ルート側の結線は本単位に含まれていない**（対象ルートがまだ存在しない）。
  P3-c2 で `orphan-uploads` を作るときに `limiter` を渡すかを決めること。

---

## SEC-065 / P3c-10 — `/privacy` に発信元 IP の保持を追記 ✅

### 何をどう変えたか

**1. `lib/retention.ts`**: `clientIpMinutes: 10` を追加。
値の根拠を「IP を材料にする全カウンタの最長窓」としてコメントに明記した。
実測した窓は 3 本ともすべて 600_000ms（10 分）:

| 軸 | 定数 | 値 |
|----|------|-----|
| `apply:fs-issue` | `FORM_SESSION_ISSUE_WINDOW_MS`（`lib/form-session-issue.ts:44`） | 600_000 |
| `applications:source` | `RATE_WINDOW_MS`（`app/api/applications/route.ts:87`） | 600_000 |
| `login:ip` | `LOGIN_IP_LIMITER.windowMs`（`auth.ts:74`） | 10 * 60_000 |

**2. `app/(public)/privacy/page.tsx`**:
- §1「取得する個人情報」に IP アドレスの取得と
  「**生の IP をデータベースには保存しない**」ことを追記し、
  保持期間を `{clientIpMinutes}分` として**定数から描画**した。
- §3「保持期間」の一覧にも 1 行足した。§3 は保持期間の一覧なので、
  §1 だけに書くと同じ文書内で不整合になる。

### なぜその形にしたか

- **数値を直書きしなかった。** テストが `(?<![0-9])10\s*分` の直書きを禁じている。
  IP だけ画面に直書きすると、レート制限の窓を変えた瞬間に約束が嘘になる
  ——`lib/retention.ts` 自身が「APPI 上はこの食い違いそのものが不履行になる」と書いている。
- **「一致」であって「以上」ではない。** テストは
  `clientIpMinutes * 60_000 === max(窓)` を要求する。どれかの窓を伸ばすと赤くなるので、
  `/privacy` の記載を直す必要があることが変更時に分かる。

### 実測

- `tests/unit/retention-client-ip.test.ts`: **7/7 green**（red 5 → 0）
- 退行なし: `tests/unit/apply-page-contract.test.ts` 13/13 green

### 検証できていないこと

- **`/privacy` の実レンダリングは未確認**（`pnpm build` / `pnpm dev` を実行していない）。
  測っているのはソース文字列の検査と `RETENTION_PERIODS` の値だけである。
- KV 経路の実際の TTL が窓と一致しているかは測っていない
  （`clientIpMinutes` は「窓の長さ」を約束しており、
  store の実装が窓より長くキーを保持しないことは本単位の範囲外）。

---

## SEC-067 / SEC-068 — 縮退構成の回復経路・自己維持の切断・印の不可読化 ⚠️ **部分是正**

> ## ⚠️ **本節の当初の申告は誤りだった**（Security 監査 §1.5 で訂正 / 2026-07-29）
>
> 当初ここには「本単位で閉じたのは**自己維持の切断（結線まで）**」と書いたが、
> **自己維持の切断は達成されていない。** 監査の指摘は正しく、**自分でもプローブで再現した**
> （下記「⚠️ 自己維持の切断は未是正である」）。
>
> **正しい内訳（監査 §1.5 の表）:**
>
> | 項目 | 状態 |
> |------|------|
> | **自己維持の切断** | ❌ **未是正**（印付き利用者には `hasVerifiedSession` が原理的に到達しない） |
> | 有効 Cookie を使った無コスト枠の収穫（REV-P3C1-001） | ✅ **是正済み・結線済み**（＝ SEC-057 の追加ハードニング） |
> | 更新窓（NEW-003） | ✅ 是正済み・結線済み（CR-001 の呼び出し元結線を入れた後） |
> | 回復経路（`challengeToken`） | 正典関数の契約のみ。**本番導線は存在しない**（P3-c2） |
> | 印の不可読化（SEC-068） | ✅ **完了 = クローズ可** |
>
> **「部分是正」というラベル自体は妥当**（クローズではない、という結論は正しかった）。
> 誤っていたのは**内訳**である。SEC-067 の是正そのものは **P3-c2 のスコープ**。

### SEC-068 — 印の不可読化（`lib/form-session.ts`）

**印を payload から署名鍵の HKDF ラベルへ移した。**

```ts
const HKDF_INFO             = 'driving-school/form-session/v1'
const HKDF_INFO_UNVERIFIED  = 'driving-school/form-session/unverified/v1'   // ← 新設
```

- `createFormSessionValue` の payload は**常に `{ sid, issuedAt }` だけ**になり、
  印の有無で**1 バイトも変わらない**（署名部も base64url(HMAC-SHA256) = 43 文字で同じ長さ）。
- `verifyFormSessionValue` は検証済みラベルで一致しなければ `null` を返す。
  未検証ラベルで一致する値（＝ 印の付いた正規の値）と、偽造・改ざん・鍵違いは
  **どちらも `null`**——攻撃者は応答から 2 つを区別できない。
- payload から印を読む旧コードは削除し、**戻さないこと**を警告コメントとして残した。

**なぜこの形にしたか**: 正典 §4 が「安い実装例」として挙げた形をそのまま採った。
署名は payload 全体を覆ったままなので**印の剥離も偽造もできない**（剥がすには
検証済みラベルでの正しい署名＝鍵が要る）。既存形式（印なし）の値はラベルが `HKDF_INFO` のままなので
**後方互換が保たれる**（76 integration の手組み Cookie を守る）。
`deriveFormSessionKey`（export 済み / `application-idempotency.test.ts` が
`sessionIdHash` の材料として使う）は**一切変えていない**。

> ### ⚠️ **「検証は最大 2 回 HMAC を計算する」と書いていたが、それは事実でなかった**（SEC-072 / 訂正）
>
> 当初ここには「印なしの値は 1 回目で通り、**印の付いた値と偽造値は 2 回**計算する」と書いたが、
> **実コードは検証済みラベルで 1 回計算し、一致しなければ即 `null` を返す。**
> 未検証ラベル（`HKDF_INFO_UNVERIFIED`）は**発行側からしか使われない。**
> 記述だけが先行しており、`sign(payloadPart, secret, true)` は**一度も呼んでいない。**
>
> **実挙動のほうが優れている**——常に 1 回なので、**印付きと偽造で計算時間が変わらない**
> （タイミング差によるオラクルが出ない）。
>
> ⚠️ **この記述を信じて「コメントどおり 2 回目の検証を足す」ことをしないこと。**
> 足すと**印付きと偽造を計算時間で区別できるオラクル**を新設することになり、
> SEC-068 が消したはずの状態オラクルが復活する。
> `lib/form-session.ts` の該当コメントは CR-002 で実コードに合わせて訂正済みである。
>
> **P3-c2 への帰結（こちらが本題 / 監査 SEC-072）**: この設計の必然として
> **サーバーは「印付き」と「偽造・破損」を区別できない。**
> したがって回復導線 UI は「**印を検出して出し分ける**」形にしてはならない
> ——区別する経路を新設した瞬間にオラクルが戻る。
> **「Tier B が続いたら誰にでも出す」**（RV-P3B-009 の既存方式）で設計すること。

### SEC-067 (1) — `hasVerifiedSession`（`lib/form-session-issue.ts` + **本番ルート結線**）

> **⚠️ 節名を「自己維持の切断」から変えた。** この受け口が実際に閉じたのは
> **「攻撃者が有効な Cookie を提示し続けて無コスト枠を収穫する」経路**（REV-P3C1-001）であって、
> **自己維持ループではない。** 理由と実測は本節末尾を参照。

```ts
export type FormSessionIssueResult =
  | { issued: true; ... }
  | { issued: false; reason: 'rate-limited'; retryAfterMs: number }
  | { issued: false; reason: 'already-verified' }        // ← 新設
```

`hasVerifiedSession === true` なら **`consume` より前に return する**（＝ **発行しない**）。

**「消費しないが発行はする」にしなかった理由**（§12.2 の禁止事項 4 / REV-P3C1-001）:
枠の免除に上界が無ければ枠は存在しないのと同じで、Cookie には「消費」の概念が無い以上、
攻撃者は 1 枚の有効な Cookie を提示し続けるだけで印の無い Cookie を積み上げられる。
pin ①②③ が本番配線での到達数まで含めてこれを捕捉する。

**NEW-002（計数の invariant）**: 無コスト枠のキーは消費しないが、
**別キー `apply:fs-revisit:`** で計数する。`consume` を丸ごと飛ばすと
**この経路だけ観測手段が消える**（実害は小さいが「見えない」ことは別の問題）。

**結線（NEW-001 / `app/api/form-session/route.ts`）**:

```ts
const presented = verifyFormSessionValue(readFormSessionCookie(request), secret, now)
const result = await issueFormSession({
  ...,
  hasVerifiedSession: presented !== null && !isFormSessionRenewable(presented, now),
})
if (!result.issued) {
  const response = NextResponse.redirect(target, 303)
  if (result.reason === 'rate-limited') response.headers.set('retry-after', ...)
  return response
}
```

**Senior 申し送り 2 のとおり `verifyFormSessionValue` の結果で判定している**
（Cookie の**存在**では判定していない）。存在で判定すると印の付いた利用者が
新しい Cookie を永久に得られず、**SEC-067 のロックアウトが恒久化する**。

#### ⚠️ 自己維持の切断は**未是正**である（Security 監査 §1.2 / **自分でも再現した**）

**この受け口は自己維持ループの被害者には原理的に到達しない。**

`hasVerifiedSession` は `presented !== null && ...` で決まるが、
**印の付いた Cookie に対して `verifyFormSessionValue` は必ず `null` を返す**
（SEC-068 の設計上そうでなければならない）。
したがって**印の付いた利用者では `hasVerifiedSession` が `true` にならない**——
そして**それは正しい**。ここを `true` にすると、すぐ上に自分で書いた
「ロックアウトの恒久化」（Senior 申し送り 2 / `form-session-route.int.ts:345`）になる。

**構造的な制約であって実装ミスではないが、「自己維持を切った」という申告は成立しない。**

**自分で実行したプローブ**（本番ルートの判定をそのまま写した / 実行後に削除）:

```
攻撃者が 10 回発行して無コスト枠を使い切った
被害者の初回来訪: 発行=true / 印なし(=使える)=false
被害者の再訪 10 回: 発行された=10 / already-verified で発行が省かれた=0
>>> 印付き被害者の再訪で発行枠が消費され続ける（自己維持は切れていない）

有効な Cookie を 200 回提示: 発行=0 / already-verified=200
>>> 無コスト枠の収穫は封じられている（こちらは本物の成果）
```

**監査の数値と完全に一致した。** 監査の判定を鵜呑みにせず自分で測った結果である。

**閉じたものを過小評価もしない**: 「有効な Cookie 1 枚で印なし Cookie を積み上げる」経路は
実在し（REV-P3C1-001 / 素朴な実装では到達数 600 = 上界 30 の 20 倍）、それは**確かに封じた**。
これは SEC-057 の追加ハードニングとして本物の成果である。
NEW-003（更新窓）も、**この修正自身が作りかけた新しい締め出し**（有効な Cookie がある限り
更新されず 30 分で必ず失効する）を先回りして潰している。**誤っていたのはラベルだけ。**

### SEC-067 (2) — 回復経路の契約（正典関数まで / **結線は P3-c2**）

`challengeToken` が渡され、かつ**印が付く場合に限り**、使用済み記録へ `consume` し、
**初回だけ**印を外す。同一トークンの 2 回目以降は「未通過」＝ **増幅率が構造的に 1 に固定される**。

- `CHALLENGE_TOKEN_TTL_MS = 300_000`（Turnstile siteverify のトークン有効期間）
- `CHALLENGE_TOKEN_MAX_ENTRIES = 10_000`（`lib/rate-limit.ts` の
  `DEFAULT_MEMORY_STORE_MAX_ENTRIES` と同じ形。期限切れ優先 → 最古から退避）
- `usedChallengeTokens` で差し替え可能（KV 化の継ぎ目。本番は複数インスタンスなので
  内蔵のメモリ記録では**インスタンスを跨いだ流用**を防げない）

**記録の消費を「印が付く場合だけ」に限った**のは、印が付かない要求で消費しても意味が無く
記録を無駄に埋めるだけだからである（契約はこの点を規定していない）。

### NEW-003 — 更新窓（`lib/form-session.ts`）

```ts
export const FORM_SESSION_RENEW_BEFORE_MS = 600_000   // Cookie 寿命 1_800 秒に対して 10 分
export function isFormSessionRenewable(payload, now): boolean
```

**判定は正典モジュールに置いた**（AC-RL-8）。ルートに式を書くと判定の複製になる。
これが無いと「有効な Cookie がある限り二度と更新されない」ため、
初回訪問から 30 分で必ず失効して**入力途中の利用者が Tier B に落ちる**
——再監査 §5 が P3-c2 について名指しした懸念（滞在時間が長い写真アップロード）を
SEC-067 の修正が**強める方向に働く**のを防ぐ。

### RE2-001（Senior 申し送り 1）— **足した**

`tests/integration/form-session-route.int.ts` に 1 件追加した
（「失効間近の Cookie を提示した要求には再発行する」）。**現時点で green**。

### ⚠️ 変異による検算（§14 / REV-P3C1-010 の手順を SEC-067/068 にも適用した）

各変異を**独立に**当て、毎回元に戻して測った。

| 変異 | red になったテスト | 件数 |
|------|-----------------|------|
| A: `hasVerifiedSession` を無視（結線前の実装） | unit 3 件（`already-verified` / 20 回再訪 / NEW-002 の計数）+ **integration 2 件**（結線） | **5** |
| B: 印を payload に平文で書く（SEC-068 の退行） | 「payload をデコードしても印が現れない」/「印の有無で payload が完全に同一」 | **2** |
| C: `challengeToken` を使い捨てにしない（増幅率 > 1） | 「同一トークン 200 回でも 1 枚」/「記録は差し替えられる」 | **2** |
| **D: 更新窓を見ない**（`hasVerifiedSession: presented !== null`） | **RE2-001 の 1 件だけ** | **1** |
| **E: Cookie の「存在」で判定する**（Senior 申し送り 2） | 「印付き Cookie には発行する」/「期限切れ・壊れた値にも発行する」/ RE2-001 | **3** |
| 復元後 | — | **integration 18/18 green** |

**D は RE2-001 が唯一の観測点である**——Senior の指摘（「6 件すべてが green のまま通る」）は
実測として正しかった。この 1 件を足さなければ NEW-003 は結線を測られないまま残っていた。

### 実測

- `tests/unit/form-session-degraded-recovery.test.ts`: **29/29 green**
  （実装時点では 28/29。残り 1 件＝達成不能だった TTL テストは
  **オーケストレーターが下記「未解決 1 件」の §提案 の形で修正済み**。現在は全パス）
- `tests/integration/form-session-route.int.ts`: **18/18 green**（既存 11 + NEW-001 の 6 + RE2-001 の 1）
- 退行なし: `form-session.test.ts` 31 / `form-session-axis.test.ts` 42 /
  `form-session-issue.test.ts` 10 / `form-session-issue-cost.test.ts` 9 /
  `form-session-cost.int.ts` 2 / `applications.int.ts` 35 — **全 green**

### 検証できていないこと

- **回復経路が本番で使えることは測っていない**（結線が P3-c2 のため）。
  測ったのは `issueFormSession` に `challengeToken` を渡した場合の振る舞いだけである。
- **複数インスタンスでのトークン流用は防げていない**（既定は内蔵のメモリ記録）。
  差し替え口は開いているが、`usedChallengeTokens` を KV 実装に結線するのは P3-c2 以降。
- ~~SEC-068 の 2 回 HMAC 化による性能影響は**ベンチしていない**~~
  → **前提が誤りだった**（SEC-072）。検証の HMAC 計算は**常に 1 回**であり、
  印の有無で計算量は変わらない。性能影響そのものが存在しない。

---
## SEC-063 / P3c-9 — **着手していない**（繰越 / 正典 §10・§12.1-8 の指示どおり）

`lib/rate-limit.ts` の KV 経路には**一切触れていない**。
正典 §12.1-8 が「着手しないこと——中途半端に実装すると §10 (1) の経路で
**本番限定のレート制限喪失**になる」と明記しているため。

---

## ~~⚠️ 未解決 1 件~~ → **解消済み**（記録として経緯を残す）

> **本節は「実装時点の記録」である。現在この red は存在しない。**
> オーケストレーターが下記 §提案 の形（`isUnmarked` を使わず**発行時刻と同じ時刻で検証**）で
> テストを修正し、変異検証（`if (expiresAt > at) return false` → `if (true) return false` で
> **そのテストだけが red**）も実施済み。Senior / Security ともに
> 「アサーションの弱体化ではなく**厳格化**」と判定している。
> `tests/unit/form-session-degraded-recovery.test.ts` は現在 **29/29 green**。
>
> 以下は「なぜ実装側で対応しなかったか」の根拠として残す。

## （実装時点の記録）`pnpm test:unit` の red 1 件 — **テストを変更せず報告した**

### 対象

`tests/unit/form-session-degraded-recovery.test.ts:392`
「使用済みトークンの記録は有効期間で失効する（NEW-004 / メモリ増幅を作らない）」

### 判定: **このテストは現在の値の組み合わせでは達成不能である**（実装の欠陥ではない）

テストの構造:

```ts
const NOW = ISSUED_AT + 10_000                          // :158 — isUnmarked の検証時刻（固定）

const afterExpiry = await issueFormSession({
  now: () => ISSUED_AT + CHALLENGE_TOKEN_TTL_MS + 1_000, // :419 — 発行時刻
  challengeToken: token,
})
expect(isUnmarked(afterExpiry.issued ? afterExpiry.cookieValue : null)).toBe(true)   // :425

function isUnmarked(value) {                             // :236
  return value !== null && verifyFormSessionValue(value, SECRET, NOW) !== null
}
```

発行された Cookie の `issuedAt` は**発行時刻**（`ISSUED_AT + TTL + 1_000`）になるが、
`isUnmarked` は**固定の `NOW`**（`ISSUED_AT + 10_000`）で検証する。
`verifyFormSessionValue` は「**未来の `issuedAt` は時計を進める偽装**」として `null` を返す
（`lib/form-session.ts` / `if (issuedAt > now) return null`）。

したがって `CHALLENGE_TOKEN_TTL_MS + 1_000 > 10_000` である限り、
**印が付いていようがいまいが `isUnmarked` は必ず false になる。**

### 実測（scratch で検算した。実装を一切通さない）

```ts
const at = ISSUED_AT + CHALLENGE_TOKEN_TTL_MS + 1_000
// 印を一切付けていない値 = 「記録が失効して回復に成功した」場合に実装が出す値そのもの
const value = createFormSessionValue({ sid: 'a'.repeat(32), issuedAt: at }, SECRET)
expect(at).toBeGreaterThan(NOW)                              // ✅ pass
expect(verifyFormSessionValue(value, SECRET, NOW)).toBeNull() // ✅ pass
```

**両方 pass した。** 記録の失効が完璧に実装されていても :425 は red になる。

### 「テストを green にできる唯一の実装」を採らなかった理由

`CHALLENGE_TOKEN_TTL_MS ≤ 9_000`（9 秒）にすれば通る。同ファイル :433 の
`toBeLessThanOrEqual(300_000)` も満たす。**しかし採らない**:

1. 正典 §4 / :403-404 は TTL の基準を明示している——
   「失効の基準は**チャレンジトークンの有効期間**（Turnstile の siteverify は 300 秒）。
   それを過ぎたトークンは siteverify 自体が拒否するので、記録し続ける意味が無い」。
   9 秒はこの根拠と無関係な値である。
2. **REV-P3C1-002 が固定した「増幅率 1」が壊れる。** TTL が 9 秒なら、
   攻撃者は同一トークンを 9 秒ごとに再提示でき、無コスト枠の窓（10 分）内で
   **1 トークンあたり最大 66 枚**の印なし Cookie を得られる。
   同ファイル :354 の「同一トークン 200 回 → 1 枚」は `now` を固定して測るため**この経路を捕捉しない**
   ——正典 §4.1 が「**測っていない経路で上界が破られる**」と警告した形そのものである。
3. §12.2 の「閾値を動かして直ったことにしない」と同じ型の対症療法である。

### 提案（**判断はオーケストレーターに委ねる**）

テスト側の 1 行修正で解決する。`isUnmarked` を使わず、**発行時刻と同じ時刻で検証する**:

```ts
const at = ISSUED_AT + CHALLENGE_TOKEN_TTL_MS + 1_000
const afterExpiry = await issueFormSession({ ..., now: () => at, challengeToken: token })
expect(
  verifyFormSessionValue(afterExpiry.issued ? afterExpiry.cookieValue : null, SECRET, at),
  '使用済み記録が有効期間を過ぎても残り続けている（メモリが単調増加する）',
).not.toBeNull()
```

測りたい性質（「TTL を跨いだら同じトークンでも初回として扱われる」）は完全に保たれ、
Cookie 寿命の判定と混ざらなくなる。

**指示（「テストのアサーションを変更しない」）に従い、テストは変更していない。**

### この 1 件が red のままでも、NEW-004 の実装は入っている

`CHALLENGE_TOKEN_TTL_MS` / `CHALLENGE_TOKEN_MAX_ENTRIES` と、期限切れ優先 → 最古退避を持つ
内蔵記録は実装済みである。同ファイル :428「記録に件数上限がある」は **green**。
失効そのものは上の変異検算（変異 C）で「記録を使わない実装なら red になる」ことまで確認している。

---

## ⚠️ Senior / Security への申告事項（まとめ）

### 1. SEC-067 は **部分是正**（Senior 申し送り 4 のとおり記録する）

| 項目 | 状態 |
|------|------|
| **自己維持の切断** | ❌ **未是正**（Security 監査 §1.5 で訂正。印付き利用者には `hasVerifiedSession` が原理的に到達しない。**自分でもプローブで再現**: 被害者の再訪 10 回 → 発行 10 / already-verified 0） |
| 有効 Cookie を使った無コスト枠の収穫（REV-P3C1-001） | ✅ **是正済み・結線済み**（＝ SEC-057 の追加ハードニング。実測: 有効 Cookie 200 回提示 → 追加取得 0 枚） |
| 更新窓（NEW-003 / `isFormSessionRenewable`） | ✅ **呼び出し元まで結線完了**（CR-001 で修正。round-1 時点はルートまでで止まっており**不活性**だった） |
| 回復経路（`challengeToken`） | **正典関数の契約のみ。ルート結線は P3-c2** |
| 印の不可読化（SEC-068） | **完了 = クローズ可** |

**現時点で利用者がチャレンジを通して Tier B から回復する導線は存在しない。**

### 2. テストファイルを 5 箇所触った（**assertion は 1 件も変更していない**）

| ファイル | 変更 | 種別 | 理由 |
|---------|------|------|------|
| `tests/unit/public-guard.test.ts` | `baseOptions()` に `limiters: { formSession: ... }` を追加 | fixture | 新テスト (d) と**実装から区別不能な同一構成**。両立させる実装は存在しない（詳細は SEC-058 の節） |
| `tests/unit/form-session-issue.test.ts` | `reason` による型の絞り込み + 1 assertion 追加 | 型 | 判別可能 union の導入で type-check が落ちる（**正典 §12.4 が予告していた**） |
| `tests/unit/application-error-classification.test.ts` | `db` の型宣言をモックの形に変更 | 型 | Prisma の生成型が `select` を静的に解決せず、部分オブジェクトを `mockResolvedValue` へ渡せない（**本単位の変更とは無関係の既存欠陥**） |
| `tests/integration/news.int.ts` | `GATE_PREFIX` を `TEST_ROW_PREFIX` から導出 | 型 | `TEST_ROW_PREFIX` が未使用で `TS6133`（**Test Agent の積み残し**）。fixture 自身の規約に合わせた |
| `tests/integration/form-session-route.int.ts` | RE2-001 の pin を 1 件追加 | 追加 | **Senior 申し送り 1**（指示された作業） |

### 3. `pnpm type-check` が落ちていた原因のうち 2 件は**本単位と無関係の既存欠陥**だった

正典 §12.4 は「不足している export / オプションは以下がすべて」と書いていたが、
実際には上表の 3 件目・4 件目（Prisma 生成型のミスマッチ 12 件 / 未使用 import 1 件）も
落としていた。**§12.4 の列挙は網羅ではなかった。**

### 4. `lib/cron-auth.ts` の既定 limiter は `sharedRateLimitStore()` を渡している

`tests/unit/runtime-stores-wiring.test.ts`（既存の pin）が
「本番経路のすべての `createRateLimiter` に store が渡っている」を要求しており、
**store 無しで実装した時点で red になった**（＝ pin が正しく機能した）。
これにより cron の試行カウンタは KV 構成では**インスタンス横断**になる。

### 5. SEC-046 は「観測が無い」ことへの是正としてのみクローズできる

`lib/cron-auth.ts` のソースにも書いたとおり、**本ラッパは総当たりの速度を落とさない**。
「`/api/cron/**` には総当たりの上限がある」と読める形で記録しないこと（REV-P3C1-006）。

### 6. `pnpm build` / `pnpm test:e2e` は**未実行**

ポート 3000 に触れるコマンドは指示どおり実行していない。
特に次の 2 点はビルドでしか確認できない:

- `lib/db.ts` の `client as unknown as PrismaLogEmitter` が Prisma の生成型と噛み合うか
  （`pnpm type-check` は通っている）
- `/privacy` の実レンダリング（`clientIpMinutes` の描画）

---

## 最終ゲート実測

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` | **54 ファイル / 826 件 — 825 passed / 1 failed**（着手前 54 failed）。残り 1 件は上記の達成不能テスト。**※ この 1 failed はその後オーケストレーターのテスト修正で解消し、現在は全パス。最新の実測は本ファイル末尾を見ること** |
| `pnpm test:integration` | **9 ファイル / 87 件 — 全パス**（着手前 4 failed / 86 件）。**3 回連続で 87 passed** |
| `pnpm type-check` | **PASS** |
| `pnpm lint` | **PASS**（No ESLint warnings or errors） |
| `pnpm build` / `pnpm test:e2e` | **未実行**（オーケストレーターの担当） |

**既存 47 unit ファイル / 既存 8 integration ファイルに退行は無い。**

---

# Senior コードレビュー round-1 への対応（`docs/review-p3c1-code-2026-07-29.md`）

判定は **Request Changes**（Must Fix 1 / Should Fix 1 / Nit 2）。**4 件すべて対応した。反論は無い。**

---

## CR-001（Must Fix）— **改善案 (A) を採用**：更新窓を呼び出し元まで結線した

### 指摘の要旨と、自分で検算した結果

「`isFormSessionRenewable` が**本番の呼び出し経路から到達不能**で、記録が『結線まで完了』になっている」。

**指摘は正しい。** 自分でも全走査して確認した:

```
grep -rn "api/form-session" app components lib tests scripts
→ 本番の呼び出し元は app/(public)/apply/page.tsx:71 の redirect() **1 箇所のみ**
```

そのリダイレクトは `:69` の `if (!hasSession && !issued)` に守られており、
`hasSession` は `verifyFormSessionValue(...) !== null` だけで決まっていた。
つまり「**有効だが失効間近**」の利用者は `hasSession = true` となり
**一度もリダイレクトされない** ⇒ ルート側の `isFormSessionRenewable` は
**その状態の要求を受け取らない** ⇒ 本番で一度も true にならない。

RE2-001 の結合テストはルートへ**直接** Cookie を渡すので green のままであり、
**呼び出し元が要求を作らないことはルート側のテストでは原理的に捕捉できない。**
NEW-001（「受け口が呼ばれることを測っていない」）の**一段手前**の版である。

### 何をどう変えたか

**1. `app/(public)/apply/page.tsx`**（2 行 + import 1 行）

```ts
const now = Date.now()
const presented = verifyFormSessionValue(raw, process.env.FORM_SESSION_SECRET ?? '', now)
const hasSession = presented !== null && !isFormSessionRenewable(presented, now)
```

**判定は正典関数を呼ぶだけ**にした（AC-RL-8）。ここに「残り時間 < 10 分」のような式を書くと
`app/api/form-session/route.ts` と判定が二重管理になる。

**2. pin 1 件**（`tests/unit/apply-page-contract.test.ts`）

`hasSession` に**代入される式そのもの**が `isFormSessionRenewable` を通ることをソースで固定した。

### ⚠️ 無限リダイレクトが起きない理由を**自分で実測した**（レビューの要求）

レビューの説明を鵜呑みにせず、scratch のテストで 4 点を実測した（実行後に削除）:

| # | 確認したこと | 結果 |
|---|------------|------|
| 1 | 失効間近の Cookie → `hasSession = false`（＝ リダイレクトが起きる。前提として Cookie 自体は有効） | ✅ |
| 2 | **ルートが発行した直後の Cookie → `hasSession = true`**（＝ 2 周目で止まる） | ✅ |
| 3 | 縮退で枠が尽きた場合は**印付き** Cookie が出るので `hasSession = false` のまま。止めるのは `?fs=1`（`issued`）だけ | ✅ |
| 4 | `FORM_SESSION_RENEW_BEFORE_MS < FORM_SESSION_MAX_AGE_SEC * 1000`（**この不等式が破れると必ずループする**） | ✅ |

**#2 がループしない根拠の本体**であり、それを保証しているのが **#4 の不等式**である。
#4 は `form-session-degraded-recovery.test.ts`「更新窓は Cookie 寿命より短い」が既に pin しているので、
**ループを防ぐ条件はテストで固定済み**ということになる。この対応関係をページのコメントに残した。

### 変異による pin の検算（3 通り。**1 つ目は空振りしていたので締め直した**）

| 変異 | 結果 |
|------|------|
| F: `hasSession = presented !== null`（CR-001 修正前の形） | ✅ **red**（この 1 件だけ） |
| G: `isFormSessionRenewable` の import は残し、**式からだけ外す** | ✅ **red** |
| H: import ごと外す | ✅ **red** |
| 復元後 | 14/14 green |

⚠️ **最初に書いた pin は変異 G を素通りさせた**（`const hasSession =` から「次の `const` まで」を
窓にしていたため、間に `void isFormSessionRenewable` を挟むだけで検査に当たってしまった）。
**代入式だけ**を切り出す正規表現（継続行はインデント 4 以上）に締め直して 3 通りとも red を確認した。
申し送り原則 4「空振りしているテストを green として報告しない」。

### ⚠️ この修正が持ち込むトレードオフ（**レビューには無い観測。P3-c2 への申し送り**）

**縮退構成で無コスト枠が尽きている状態**では、失効間近の利用者が
「まだ使える Cookie」を**印付きの Cookie に置き換えられる**（上の実測 #3）。
結果としてその利用者は、更新窓ぶん（最大 10 分）**早く Tier B に落ちる**。

- **最終状態は変わらない**——更新が無ければ 10 分以内にハード失効し、
  そこで同じ印付き Cookie を受け取る。**早まるだけで、悪化はしない。**
- **通常構成／枠に余裕がある場合は純粋な改善**（入力途中に失効しなくなる）。
- 恒久的な解は SEC-067 の**回復経路**（`challengeToken` の結線 = P3-c2）である。

「まだ有効な Cookie を印付きで上書きしない」という第 3 の状態を作る案は考えたが、
**CR-001 の 2 行という範囲を超え、新しいテスト契約が要る**ので採らなかった。
P3-c2 で回復経路を結線する際に併せて判断すること。

---

## CR-002（Should Fix）— コメントを実装に合わせて訂正した

`lib/form-session.ts` の `verifyFormSessionValue` 内のコメントが
「未検証ラベルでも一致しないかを**確かめる**」と書いていたが、
実装は `sign(payloadPart, secret, true)` を**一度も計算していない**。**指摘は正しい。**
振る舞い（印付きも偽造も `null`）は正しいので、**コメントだけを訂正**した:

> 検証済みラベルで一致しない値は「印の付いた正規の値」か「偽造・改ざん・鍵違い」のどちらかである。
> ⚠️ **両者を区別していない。** 未検証ラベルでの再検証は行わない——どちらも Tier B へ落とすので
> 区別する必要が無く、**区別しないこと自体が「攻撃者に応答から状態を読ませない」ことでもある**。
> したがって「印の付いた正規の値だけを識別する」用途（例: Tier B の内訳メトリクス）は
> **現状の実装では成立しない。**

最後の 1 文は改善案に無いが足した。レビューが懸念した誤読（「既に判別できる」）は、
**できないことを明示する**ほうが確実に防げるため。
必要になった時に**状態オラクルを作らないか再評価すること**も併記した。

---

## CR-003（Nit）— 評価をコメントに残した

`lib/form-session-issue.ts` の使用済みトークン記録の退避が
「未失効のトークンも落としうる ⇒ 増幅率が 1 を超えうる」点について、
**実質的に悪用不能**である評価（300 秒以内に有効なトークンを 10,000 件＝
**CAPTCHA を 1 万回解いて 1 枚余分に得る**より素直に 1 回解くほうが安い）をコメントに残した。
**次の監査が同じ検討を最初からやり直さずに済むようにする**という指摘の趣旨どおり、実装は変えていない。

## CR-004（Nit）— 意図をコメントに残した

`already-verified` の計数が `issueLimiter` を共有している点について、
「**上限値も窓も使っていない**（`consume` の結果を一切見ない）。同じ limiter を通すのは
**キー空間を分けるためだけ**であり、発行側の上限を変える人が再訪カウンタへの影響を検討する必要は無い」
をコメントに残した。実装は変えていない。

---

## Senior の自己訂正への同意

Senior は round-2 の前提の誤り（「従来は `/apply` を開くたびに更新されていた」）を訂正し、
**有効な Cookie が更新されないのは P3-c1 以前からの挙動＝本件は退行ではない**と位置づけ直している。
**この訂正に同意する。** 自分でも `:69` が「無効な Cookie のときだけ」リダイレクトすることを確認した。
本件は「退行」ではなく「**入れたはずの改善が効いていなかった**」である。

なお、達成不能テストの扱い（変更せず報告した件）についての judge と、
オーケストレーター側の修正・変異検証（`if (expiresAt > at) return false` → `if (true) return false`
でそのテストだけが red）も確認した。**厳格化であるという判定に同意する。**

---

## round-2 の最終ゲート実測

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` | **54 ファイル / 827 件 全パス**（826 + CR-001 の pin 1 件） |
| `pnpm test:integration` | **9 ファイル / 87 件 全パス**（3 回連続） |
| `pnpm type-check` | **PASS** |
| `pnpm lint` | **PASS** |
| `pnpm build` / `pnpm test:e2e` | **未実行**（ポート 3000 に触れるコマンドは指示どおり実行していない） |

**退行なし。** 変更したのは `app/(public)/apply/page.tsx`（2 行 + import）、
`tests/unit/apply-page-contract.test.ts`（pin 1 件追加）、
`lib/form-session.ts` / `lib/form-session-issue.ts`（**コメントのみ**）。

---

# Security 監査への対応（`docs/security-p3c1-audit-2026-07-29.md`）

判定は **新規 Critical 0 / High 0 / P3-c2 着手可**。
SEC-058 / 060 / 061+069 / 068 / 046 / 064 / 065 / 070 は**すべてクローズ**。
本単位での作業は**記録の訂正**であり、実装コードは変更していない。

## ⚠️ 訂正 1（最重要）— SEC-067「自己維持の切断」は**未是正**だった

### 監査の指摘を鵜呑みにせず、自分で再現した

本番ルートの判定をそのまま写したプローブを書いて実測した（実行後に削除）:

```
[probe] 被害者の再訪10回: 発行=10 / already-verified=0
[probe] 有効Cookieを200回提示: 発行=0 / already-verified=200
```

**監査の数値と完全に一致した。指摘は正しい。**

### 原因（構造的であり、実装ミスではない）

`hasVerifiedSession` は `verifyFormSessionValue(...) !== null` から作るが、
**印の付いた Cookie に対して同関数は必ず `null` を返す**（SEC-068 の設計上そうでなければならない）。
自己維持ループの被害者は**まさに印の付いた利用者**なので、**この受け口には原理的に到達しない。**

そして**それは正しい**——ここを `true` にすると
`form-session-route.int.ts:345` と Senior 申し送り 2 が禁じた「ロックアウトの恒久化」になる。
**直せる形の実装は存在しない**（この受け口の枠内では）。

### 訂正した記録

| ファイル | 箇所 |
|---------|------|
| `docs/impl-p3c1-notes-2026-07-29.md` | SEC-067/068 節の冒頭（正しい内訳表を追加）/ SEC-067 (1) の節名と末尾（実測つきの訂正）/ 申告事項 1 の表 |
| `docs/test-design-p3c1-2026-07-29.md` | §4 の結論行（「本単位で結線まで閉じる」を打ち消し + 訂正ブロック）/ §4.2 の前提 / §12.3 の節名と表 |

### この件から得られた**新しい型**（記録する価値がある）

NEW-001 は「**受け口が呼ばれることを測っていない**」という指摘で、対応も正しかった。
しかし残った欠陥は別物である:

> **受け口に到達する利用者集合が、直したい利用者集合と交わらない。**

結合テストは前者（呼ばれるか）を捕捉できるが、**後者は捕捉できない**——
`form-session-route.int.ts` はルートへ**直接** Cookie を渡すので green になる。
**「受け口が呼ばれること」を測っても「正しい相手に対して呼ばれること」は測れない。**

これは本プロジェクトが繰り返してきた
「受け口が在る → 結線済みと読める」（RV-P3B-001）→「結線した → 効いていると読める」（NEW-001 / CR-001）
の**さらに一段深い版**である。

## ⚠️ 訂正 2 — SEC-072「検証は最大 2 回 HMAC を計算する」は事実でなかった

実コードは検証済みラベルで**1 回**計算し、一致しなければ即 `null` を返す。
`sign(payloadPart, secret, true)` は**一度も呼んでいない**。

**実挙動のほうが優れている**（常に 1 回＝印付きと偽造で計算時間が変わらず、タイミングオラクルが出ない）。
`lib/form-session.ts` のコメントは CR-002 で既に訂正済みで、
本実装記録の SEC-068 節と「検証できていないこと」も実コードに合わせた。

⚠️ **この記述を信じて「2 回目の検証を足す」ことをしないこと。** SEC-068 が消した状態オラクルが復活する。

## ⚠️ 訂正 3 — 「未解決 1 件（1 failed）」は解消済み

オーケストレーターが §提案 の形でテストを修正し、変異検証も実施済み。
`form-session-degraded-recovery.test.ts` は現在 **29/29 green**、unit 全体も全パス。
該当節を「実装時点の記録」として明示し、現状を併記した。

---

## P3-c2 への申し送り: **SEC-067 は継続中**（残る攻撃可能性）

**攻撃 A（SEC-067 本体・未是正）**
縮退構成で、第三者が `GET /api/form-session` を **10 回/10 分**（≒ 1 分に 1 回）送るだけで、
以後その窓の新規来訪者全員が印付き Cookie を受け取り、送信が 403 Tier B になる。
**CAPTCHA では抜けられない**——Turnstile 検証は `app/api/applications/route.ts:283` の
**ハンドラ内**にあり、`lib/public-guard.ts:374-385` の Tier B 判定より**後**なので
**一度も評価されない。**

**攻撃 B（自己維持・未是正）**
**攻撃者が完全に手を引いた後も**、被害者の再試行トラフィックだけで締め出しが継続する。
監査の実測では W2（攻撃者不在）で **15 人中 5 人が締め出されたまま**。
固定窓なので無限には続かないが、**10 分あたりの `/apply` 来訪が 10 件を超えるサイトでは
超過分が常に締め出される定常状態**になる。
10 件/10 分は**通常利用で日常的に超える水準**である
（`docs/impl-p3b-fix2-notes-2026-07-29.md` §4: E2E の通常操作だけで窓内 23 回）。

**重大度: Medium 据え置き。**
想定配備の Vercel では `trusted=true` で印が付かないため発生しない。
**非 Vercel 本番へ配備する判断が出た時点で High（リリースブロッカー）へ昇格する。**

### 設計上の含意（P3-c2 で回復導線を作るとき）

1. **回復導線 UI は「印を検出して出し分ける」形にしないこと**（SEC-072）。
   サーバーは「印付き」と「偽造・破損」を**区別できない**設計であり、
   区別する経路を新設した瞬間に状態オラクルが戻る。
   **「Tier B が続いたら誰にでも出す」**（RV-P3B-009 の既存方式）で設計すること。
2. **`challengeToken` を素の `string` のまま結線しないこと**（監査 §7 条件 1）。
   異なるトークンを 200 種渡せば印は 200 回外れる（実装として正しい）。
   安全性が**コメントだけ**に依存している状態で結線すると SEC-057 が全面的に再開する。
   `verifyTurnstile` の戻り値からしか作れない branded type
   （`PerRequesterKey` と同じ手法）にしてから結線すること。
3. **`usedChallengeTokens` を KV へ結線してから回復導線を公開すること**（監査 §7 条件 2）。
   既定はプロセス大域のメモリなので、**「増幅率 1」は単一インスタンスでしか成立していない。**
4. uploads は同じ `verifyFormSessionValue` を Tier B 判定に使う想定なので、
   **縮退構成では写真アップロードも同じ締め出しを受ける**（滞在時間が長いぶん影響は申込より大きい）。
   NEW-003（更新窓）は 30 分失効を緩和するが、**印による締め出しは緩和しない。**

## 本単位で**対応していない**監査の新規指摘（担当が割り当てられていないもの）

| ID | 重大度 | 内容 |
|----|--------|------|
| SEC-071 | — | `options.trustProxy` が非 Vercel でも platform 意味論を与える / ルート pin が列挙のため新規ルートを覆わない |
| SEC-073 | Low | cron 認可の warn が上限到達後に**毎リクエスト**出る（ログ増幅） |
| SEC-074 | Low | 非公開コースへの申込が受理される（`lookupCourse` に `published` 条件が無い / **仕様の空白**） |

いずれも**オーケストレーターから対応指示を受けていない**ため着手していない。
SEC-074 は監査自身が「実装欠陥ではなく仕様の空白（Spec Agent 案件）」と位置づけている。

---

## round-3（記録訂正）の最終ゲート実測

| ゲート | 結果 |
|--------|------|
| `pnpm test:unit` | **54 ファイル / 827 件 全パス** |
| `pnpm test:integration` | **9 ファイル / 87 件 全パス** |
| `pnpm type-check` | **PASS** |
| `pnpm lint` | **PASS** |
| `pnpm build` / `pnpm test:e2e` | **未実行**（ポート 3000 に触れるコマンドは指示どおり実行していない） |

**実装コードは 1 行も変更していない**（本 round の成果物は記録の訂正のみ）。
