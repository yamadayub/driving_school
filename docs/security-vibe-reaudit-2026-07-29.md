# セキュリティ再監査 — Vibe Coding（SEC-075 / 076 / 077 の修正）

## 監査日: 2026-07-29
## 対象: `runner/server.mjs` / `components/admin/VibeConsole.tsx` の修正
## 判定者: Security Agent（原指摘者）
## 方法: コード読解 + **独立検証プローブ**。**ランナーは起動していない**（`isAllowedWrite` / `isAllowedRead` を import して判定関数だけを叩いた。`server.listen` は `import.meta` ガードにより走らない）

---

## サマリー

| ID | 判定 |
|----|------|
| **SEC-075**（ゲートが実行媒体） | **クローズ** |
| **SEC-076**（`app/` が書き込み可） | **クローズ** |
| **SEC-077**（読み取り無制限） | **条件付きクローズ** — パス経由は塞がったが、**パス引数を取らない呼び出しが素通りする**（→ SEC-082） |
| **新規 Critical** | **0 件** |
| **新規 High** | **0 件** |
| 新規 Medium | 1 件（SEC-082） |
| 新規 Low | 1 件（SEC-083）+ SEC-081 は未対応のまま |
| **使用可否** | **使用可（条件付き）**。前回の「推奨しない」から変更する |

### 独立検証の実測

| プローブ | 結果 |
|---------|------|
| 書き込み 26 ケース | **25 件が期待どおり。** 残り 1 件は**私の期待値のほうが誤り**だった（§5） |
| 読み取り 19 ケース | **19 件すべて期待どおり** |
| 自己防護（`VibeConsole.tsx`）の大小文字・`.`・`..` バイパス 6 ケース | **6 件すべて拒否** |
| 読み取り deny の大小文字バイパス 5 ケース | 4 件拒否 / 1 件は実在しないファイル（§6-2） |

---

## 1. SEC-075（Critical）— **クローズ**

### 1.1 「実行媒体を断てたか」— 断てている

依頼された「`tsc --noEmit` が本当にコードを実行しないか / 他に実行経路が残っていないか」を
**個別に潰して確認した**:

| 経路 | 確認結果 |
|------|---------|
| `tsc --noEmit` そのもの | **プログラムコードを実行しない。** TypeScript の型検査は AST と型情報のみを扱う。`tsconfig.json` の `plugins` は**言語サービス専用**で `tsc` は読み込まない。`--noEmit` なので emit 時変換も走らない |
| `pnpm type-check` の中身 | `package.json` 実測: `"type-check": "tsc --noEmit"`。**余計なものが挟まっていない** |
| npm ライフサイクル（`pre-` / `post-`） | `type-check` を含むスクリプトは**1 つだけ**（`pretype-check` / `posttype-check` は存在しない）。ここに実行を差し込む余地は無い |
| `tsc` が読む設定ファイル群 | `tsconfig.json` / `package.json` / `next-env.d.ts` は**いずれも書き込み不可**（許可は `components/` のみ。プローブで `package.json` → false を確認） |
| **`git add -A` / `git commit`（ゲート経路に含まれる）** | **git フックが 1 つも無い**ことを確認した（`.husky/` 不在 / `package.json` に husky・simple-git-hooks・lint-staged 無し / `.git/hooks/` はサンプルのみ）。**コミットは何も実行しない** |
| `lib/design-tokens.ts` / `tailwind.config.ts` | **書き込み不可になった**（プローブで両方 false）。前者は `tests/unit/design-tokens.test.ts` と `tests/unit/badge.test.ts` が実 import、後者は `pnpm dev`/`build` が設定として評価するため、外した判断は正しい |

> **結論: ランナーのプロセス内でエージェント作成コードが実行される経路は無くなった。**
> SEC-075 が指摘した「防御（Bash 禁止）をゲート自身が無効化していた」構造は解消している。

### 1.2 残る実行経路の扱い — **記述が正確になった**

修正後のコメントは次のように書いている:

> **Bash は許可しない。ただしこれは「コードが実行されない」ことを意味しない。**
> …書き換えた UI コードは**人間が `pnpm dev` でサイトを見た時点で実行される。**
> これはこの機能の目的そのものなので回避できない。**残るのは被害範囲の制限だけ**である。

**これは正確であり、監査として支持する。** 「安全にした」ではなく
「**何が残っているか**」を書いた点が重要で、初版の誤った安心（「Bash を許可しないので安全」）とは
性質が違う。SEC-078 の主要部（多層防御の主張と実態の食い違い）はこれで解消している。

---

## 2. SEC-076（High）— **クローズ**

`WRITABLE_DIRS = ['components']` / `WRITABLE_FILES = []` /
`DENIED_PATTERNS` に `^app/` と `^components/admin/VibeConsole\.tsx$` を追加。

**前回名指しした 4 ファイルすべてが拒否されることをプローブで実測した**:

```
write "app/admin/(app)/layout.tsx"        → false   （requireAdmin() の認証ガード）
write "app/admin/(app)/auth-actions.ts"   → false   （'use server' = 公開エンドポイント等価）
write "app/admin/(app)/vibe/page.tsx"     → false   （この機能自身の本番ガード）
write "app/(public)/apply/page.tsx"       → false   （フォームセッションの入口）
```

**自己防護（`VibeConsole.tsx`）は大小文字・`.`・`..` のいずれでも回避できなかった**:

```
components/admin/vibeconsole.tsx          → false
components/admin/VIBECONSOLE.TSX          → false
Components/Admin/VibeConsole.tsx          → false
components/admin/./VibeConsole.tsx        → false
components/admin/../admin/VibeConsole.tsx → false
```

大小文字違いが正しく拒否されるのは、`resolveInRepo` が `fs.realpath` を通しており、
macOS の大小文字非依存 FS が**ディスク上の正規表記へ畳む**ためである
（実測: `realpath('.../Components')` → `.../components`）。
**大小文字非依存 FS では正しく効く。** 大小文字依存 FS（Linux）では
`Components/…` は別ディレクトリなので `startsWith('components/')` が偽になり、
やはり拒否される。**どちらの FS でも正しい。**

---

## 3. SEC-077（High）— **条件付きクローズ**

### 3.1 塞がった部分

`resolveInRepo()` の共通化により、**読み取りにも書き込みと同じ実パス解決が掛かる**ようになった。
読み取り 19 ケースすべてが期待どおりで、**秘密への到達は塞がっている**:

```
read ".env"                          → false      read "/Users/yosuke/.ssh/id_rsa"  → false
read ".env.local"                    → false      read "/etc/passwd"                → false
read ".git/config"                   → false      read "../../.aws/credentials"     → false
read "node_modules/next/package.json"→ false      read "components/../.env"         → false
read "runner/server.mjs"             → false      read "./runner/../runner/server.mjs" → false
read "certs/server.pem" / ".key"     → false      read ".env.local.backup"          → false
```

前回指摘した **「読み → 書き → 自動コミット が 1 リクエストで完結する」持ち出し経路は、
`Read`（`file_path` 必須）に関しては断たれている。**

### 3.2 塞がっていない部分 → **SEC-082**（§4）

`canUseTool` の読み取り分岐に次の早期 return がある:

```js
const target = request.input?.file_path ?? request.input?.path
if (target === undefined) return true   // パスを取らない形（Grep の pattern のみ等）
```

**`Grep` と `Glob` は `path` が任意パラメータである。** 省略された呼び出しは
`target === undefined` となり、**`READ_DENIED_PATTERNS` を一度も通らずに許可される。**
詳細は SEC-082。

---

## 4. 新規指摘

### [SEC-082] 読み取りツールがパス引数を持たない場合、deny リストが一度も評価されない（Medium）

- **場所**: `runner/server.mjs` `canUseTool` の読み取り分岐（`if (target === undefined) return true`）
- **説明**: `Grep` は `pattern` が必須・`path` が任意、`Glob` は `pattern` が必須・`path` が任意である。
  `path` を省略した呼び出しは早期 return で**無条件に許可**され、`cwd`（= `REPO`）を起点に走る。
  **`pattern` / `glob` パラメータ自体は一切検査されない。**
- **影響**:
  - `Grep({ pattern: "...", output_mode: "content" })`（`path` 無し）は
    **リポジトリ全体の中身**を返せる。`/^runner\//` の deny を宣言しているにもかかわらず、
    **`runner/` は隠しファイルでも gitignore 対象でもない**ため、この経路で
    `runner/server.mjs` の内容が読める。**deny リストが実際には強制されていない。**
  - `Glob({ pattern: "**/.env*" })` はファイル名の列挙に使える。
- **なぜ High ではなく Medium か**（過大報告を避ける）:
  最大の標的である **`.env` の中身は依然として読めない**。`Read` は `file_path` が必須なので
  必ず検査を通るうえ、ripgrep は既定で**隠しファイルと `.gitignore` 対象を走査しない**ため
  `.env` / `.git/` / `node_modules/` は既定の `Grep` では一致しない。
  ただし**これは設計による防御ではなく ripgrep の既定動作に助けられているだけ**であり、
  ツールのスキーマや既定が変われば静かに広がる。
- **修正方針**（軽い順）:
  1. **`target === undefined` を拒否に倒す**（`Grep` / `Glob` は明示的な `path` を要求する）。
     エージェントには「探索は `path` を指定して行う」ことをプロンプトで伝えれば足りる。
  2. `pattern` / `glob` パラメータにも `..` と絶対パスの検査を掛ける。
  3. SDK 側にディレクトリ制限の口（`cwd` 以下への限定）があるならそれを併用する。
- **参考**: CWE-22 の変種（検査対象パラメータの取りこぼし）。

### [SEC-083] `resolveInRepo` が 1 箇所だけ `null` ではなく `false` を返す（Low / 現状は到達不能）

- **場所**: `runner/server.mjs:127` `if (parent === cursor) return false`
- **説明**: この関数の契約は「リポジトリ相対パス（`string`）または `null`」である。
  呼び出し側は `unix === null` でしか弾かないが、**`false !== null`** なのでこの値は**ガードを素通りする**。
  その後の挙動は読み取りと書き込みで**非対称**である（JS 意味論としてプローブで確認した）:

  | 呼び出し側 | 結果 |
  |-----------|------|
  | `isAllowedRead` | `READ_DENIED_PATTERNS.some(re => re.test(false))` は文字列 `"false"` を検査するので**どれにも一致せず** → **`true` を返す＝ fail-OPEN** |
  | `isAllowedWrite` | `false.startsWith(...)` で **`TypeError`** → `canUseTool` から例外が抜ける（fail-closed だが例外） |

- **到達性**: この分岐は「ファイルシステムのルートまで遡っても `realpath` が成功しない」ときにのみ返る。
  macOS / Linux では `realpath('/')` は成功するため**現状は到達しない**。
  したがって**今は悪用できない**——`return null` の 1 語修正で済むが、
  **「読み取りが fail-open・書き込みが例外」という非対称は、リファクタで到達可能になった瞬間に効く。**
- **修正方針**: `return null` にする。併せて `isAllowedRead` / `isAllowedWrite` を
  `if (typeof unix !== 'string') return false` にすると、契約違反が将来入っても両方 fail-closed になる。

### [SEC-081]（前回指摘・**未対応**）共有シークレットの強度に関する案内と検証が無い（Low）

`.env.example` は依然として `VIBE_RUNNER_SECRET=` の空欄のみで、
**生成方法の案内も最低長の検証も無い**（`FORM_SESSION_SECRET` / `CRON_SECRET` は
`lib/env.ts` が本番 32 文字以上を強制しているのと対照的）。ランナーは「空でなければ起動する」ので
`secret` のような値でも通る。定数時間比較（`!==`）は**この文脈では Low のまま**——
ループバック到達が前提であり、その時点で `.env` を読むほうが速い。
**修正は `.env.example` に `openssl rand -hex 32` を併記し、起動時に長さを検査するだけ。**

---

## 5. 修正が新しい穴を作っていないか（依頼事項 2）

### 5.1 読み取り制限が「むしろ危険な変更」を招かないか — **招かない**

読み取りの許可範囲は「`REPO` の内側から `.env*` / `.git/` / `node_modules/` / `runner/` /
`*.pem` / `*.key` を除いたすべて」であり、**`components/` / `lib/` / `app/` / `tests/` / `docs/` は
すべて読める**（プローブで確認）。見た目の変更に必要な文脈——既存コンポーネントの書き方、
Tailwind クラスの語彙、デザイントークンの**値**（`lib/design-tokens.ts` は読める。書けないだけ）——は
すべて手に入る。

唯一効く可能性があるのは **`node_modules/` の拒否**で、ライブラリの `.d.ts` を確認できないため
型の不明点を推測で埋める可能性がある。ただしその場合の帰結は
**`tsc --noEmit` ゲートが落ちてコミットされない**ことであり、
**「危険な変更が入る」ではなく「何も入らない」方向に倒れる。** 正しい失敗方向なので変更不要。

### 5.2 その他の副作用

- ゲートから `pnpm test:unit` を外したことで、**回帰を検出せずにコミットされる**ようになった。
  これは**セキュリティ上は正しい**（実行媒体を断つ代償）が、品質面のトレードオフである。
  UI 文言（「単体テストと E2E は実行されません——差分を確認したうえで手元で回してください」）と
  コミットメッセージの両方に明記されており、**隠していない**。適切な扱いと判断する。
- `git add -A` + ローカルコミットのみで、**自動 push は無い**。持ち出しには人間の操作が要る。

---

## 6. 自分の検証で誤っていた点（記録）

### 6.1 `Components/Evil.tsx` を「拒否されるべき」とした私の期待値が誤りだった

プローブは 1 件 FAIL を出したが、**実装が正しく、私の期待値が誤りだった。**
macOS の大小文字非依存 FS では `Components/` と `components/` は**同一ディレクトリ**であり、
`realpath` がディスク上の表記へ畳む（実測確認済み）。したがって許可が正しい。
大小文字依存 FS では別ディレクトリになり、そちらでは拒否される。**どちらでも正しい。**

### 6.2 `.Env.local` が許可される件は**実害なし**

`READ_DENIED_PATTERNS` は大小文字を区別する正規表現で、**実在しないパス**は
`realpath` で畳まれないため `.Env.local` は deny に一致しない。
ただし**リポジトリに `.env.local` は存在しない**（実測: `.env` と `.env.example` のみ）ので、
読めるものが無い。実在する `.env` は `.ENV` で試しても `realpath` が畳んで**拒否される**（実測）。
**指摘として立てない。** SEC-083 を直す際に `resolveInRepo` の戻り値へ
小文字化した比較用の値を併せて返すなら、ついでに解消できる程度のものである。

---

## 7. ランナーのテストをどこに置くか（依頼事項 3）— **`runner/` に置く**

### 結論: **`tests/unit/` に置かない。`runner/` 配下に置く。**

**根拠 1: `runner/` は既に独立した npm パッケージである。**
`runner/package.json`（`name: driving-school-vibe-runner` / 独自 `node_modules` /
独自 `package-lock.json` / `scripts.start`）を確認した。アプリ本体とは依存も実行系も別である。
本体の `test:unit` に混ぜると、**アプリの品質ゲートが開発ツールに依存する**ことになる。

**根拠 2（決定的）: 現状の `runner/server.mjs` は `tests/unit/` からは import できない。**
モジュール評価時に

```js
if (!SECRET) { console.error(...); process.exit(1) }
```

が走る。`VIBE_RUNNER_SECRET` を立てずに vitest ワーカーから import すると
**ワーカープロセスごと落ちる**（私のプローブも環境変数を先に立てて回避した）。
`vitest.config.ts` の `include` は `tests/unit/**/*.test.ts` なので、
ここへ置くと他の 944 件を巻き込みうる。

### 推奨する形

1. **`process.exit(1)` を `server.listen` の直前（`import.meta` ガードの内側）へ移す。**
   これは整形ではなく**テスト可能性の前提条件**である。判定関数を副作用なく import できるようにする。
2. `runner/package.json` に `"test": "node --test"` を足し、
   `runner/server.test.mjs` に本監査で使った**書き込み 26 / 読み取り 19 / 大小文字 11 ケース**を置く。
   **Node 組み込みのテストランナーで足りる**（新しい依存を増やさない）。
3. CI では本体の `pnpm test` とは**別ジョブ**で回す。

**併せて SEC-078 の残り（テストが 1 件も無い）はこれで閉じられる。**
現状、このリポジトリで最も危険な機能だけが回帰テストを持たない状態が続いている。

---

## 8. 使用可否（依頼事項 4）

### 判定: **使用可（条件付き）。** 前回の「現状のままでの使用は推奨しない」から**変更する。**

**変更する理由**: 前回「使用しない」とした根拠は SEC-075 ——
**この機能を 1 回使うたびに、エージェントの書いたコードがランナーの権限で自動実行される**ことだった。
**その経路は無くなった**（§1.1 で個別に確認）。残る実行は「人間が `pnpm dev` でサイトを見たとき」であり、
これは**人間の操作を挟む**うえ、書き込み範囲は `components/` に限られ、
秘密は読めず、自動 push も無い。**リスクの質が「自動的に起きる」から「人間が起こす」へ変わった。**

### 使用の条件

1. **差分を見てから `pnpm dev` を回すこと。** これは礼儀ではなく**現在の主要な防御**である。
   コミットメッセージと UI は「差分を確認してからテストを回せ」と書いているが、
   **`pnpm dev` については触れていない。** 実行が起きるのは `pnpm dev` の側なので、
   **UI 文言に `pnpm dev` を明示することを推奨する**（コード修正は本監査では行わない）。
2. **SEC-082 を直すまで、読み取り deny リストを「効いている防御」として数えないこと。**
   `Grep` / `Glob` の `path` 省略で素通りする。
3. **SEC-083 は 1 語修正なので、次に触るときに直すこと。**
4. `VIBE_REPO_PATH` を、`components/` がレビュー無しでデプロイされるリポジトリへ向けないこと。

### 本番リリースへの影響

**無し**（前回と同じ）。`NODE_ENV === 'production'` はビルド時に畳み込まれ、
API・ページとも本番バンドルで到達不能になる。ランナーはデプロイ対象外である。

---

## 9. 総評

指摘 3 件はいずれも**構造を変えて**塞がれており、閾値いじりや文言修正での回避は無い。
特に評価する点:

- **`lib/design-tokens.ts` を書き込み可から外す判断**。プロンプトが「色を変えるならこのファイル」と
  指示していた中心的なファイルであり、外せば機能の利便性は確実に落ちる。
  それでも「テストが実 import する＝実行媒体になる」を理由に外したのは、
  **利便性より実行経路の遮断を優先した**正しい判断である。
- **`components/admin/VibeConsole.tsx` を自分で deny に加えた**こと。指摘していない
  「エージェントが自分のガードを緩める」経路を自分で見つけて塞いでいる。
- **誤った設計コメントを訂正し、残る実行経路を明記した**こと。
  「安全になった」ではなく「何が残っているか」を書いた記録は、次に読む人を誤解させない。

一方、**SEC-082 は今回の修正が作った境界の取りこぼし**である。
`isAllowedRead` という正しい関数を用意しながら、**それを呼ばない分岐が残っている**——
このプロジェクトが繰り返し踏んできた「受け口はあるが通らない経路がある」型の一例なので、
同じ枠組みで扱うことを勧める。
