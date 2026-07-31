# セキュリティ監査レポート — Vibe Coding（GitHub Actions 実行経路）

## 監査日: 2026-07-31
## 対象: 管理画面 → GitHub Actions → master push → Vercel 本番デプロイ の**現行の本番経路**

| 項目 | 内容 |
|------|------|
| 対象コミット | `f089241`（master） |
| 対象ファイル | `app/api/admin/vibe/route.ts` / `app/admin/(app)/vibe/page.tsx` / `components/admin/VibeConsole.tsx` / `.github/workflows/vibe.yml` / `scripts/vibe-agent.mjs` / `scripts/check-protected-paths.mjs` / 認可の連鎖（`_guard.ts` / `auth-guard.ts` / `auth.ts` / `auth.config.ts` / `middleware.ts`） |
| 前提として受け入れ済み | 公開URLから `/admin/vibe` に到達できること。**「管理者セッション = デプロイ権限」**。本監査はこれを蒸し返さない |
| 監査すべきこと | その前提のもとで**多層防御が実際に成立しているか** |

---

## サマリー

- **Critical: 3件**（SEC-084 / SEC-085 / SEC-086）
- **High: 3件**（SEC-087 / SEC-088 / SEC-089）
- Medium: 3件（SEC-090 / SEC-091 / SEC-092）
- Low: 3件（SEC-093 / SEC-094 / SEC-095）
- Info: 2件（SEC-096 / SEC-097）

### 使用可否の判定

> ## ❌ **使用不可。現状のまま公開運用してはならない。**

理由は「管理者セッションが強いこと」ではない（それは受け入れ済みの前提である）。
**受け入れた前提の外側で、第三者がリポジトリへの書き込み権限を得られる**からである。

決定的な事実を3つ、いずれも**実測**で確認した:

1. **`scripts/check-protected-paths.mjs` は一度も違反を検出できない。**
   ワークフローが呼ぶ時点でエージェントの変更は**未コミット**であり、
   `git diff --name-only <base>..HEAD` は**常に空**を返す（§SEC-084 に実測ログ）。
   設計文書が「**最後の砦**」と書いた第2層は、**存在していない**。
2. **ゲート（`pnpm test:unit` / `pnpm build`）がエージェントの書いたコードを実行する。**
   そのジョブの `.git/config` には `actions/checkout` が置いた **`contents: write` の push 資格情報**がある。
   SEC-075 で一度潰した「防御をゲート自身が無効化する」構造が、**push 権限付きで再発**している。
3. **`.git` が読める。** `READ_DENIED` の `/^\.git\//` は `.git`（末尾スラッシュ無し）に一致しない。
   `Grep({ pattern: 'AUTHORIZATION', path: '.git' })` は `canUseTool` を**通り**（実測）、
   ripgrep は `.git/config` の資格情報を**返す**（実測）。
   **このリポジトリは公開（`isPrivate: false`, 実測）**なので、読んだ値を
   ソースに書けば `git add -A` でそのまま**公開リポジトリに永久公開**される。

1 が 2 と 3 を止められない以上、残る防御は `canUseTool` 一枚である。
そして `canUseTool` 自身が、旧ランナーの**許可リスト**から**拒否リスト**へ後退しており、
`lib/password.ts`（パスワード照合）・`lib/login-guard.ts`（ログイン試行制御の判定）・
`app/api/**/route.ts`（新規の公開エンドポイント）が**すべて書き込み可能**である（実測）。

**一枚しかない防御が、守るべき対象の大半を守っていない。**

### 再開の条件（最低限）

- [ ] SEC-084 を修正し、**保護パス検査が実際に違反を検出することをテストで固定**する
- [ ] SEC-085: `actions/checkout` に `persist-credentials: false` を指定し、
      **ゲートを実行するジョブから push 資格情報を切り離す**
- [ ] SEC-086: `READ_DENIED` に `.git` 自身を含める
- [ ] SEC-087 / SEC-088: 読み取りの `glob` パラメータを検査し、書き込みを**許可リスト方式に戻す**
- [ ] SEC-089: 公開 `GET` ルートの新設を検出する網を張る

---

## 独立検証の実測（このレポートの根拠）

推測は書かない。判定関数は**実ソースから機械的に抽出**して実際に叩いた。

| プローブ | 手法 | 結果 |
|---------|------|------|
| 保護パス検査の実効性 | `vibe.yml` と同じ順序を scratch の git リポジトリで再現し、実ファイル `scripts/check-protected-paths.mjs` を実行 | **3件の違反すべてを見逃した**（§SEC-084） |
| `canUseTool` 43ケース | `scripts/vibe-agent.mjs` から `PROTECTED` / `resolveInRepo` / `isProtected` / `canUseTool` 本体を**波括弧対応で切り出し**、`diff` で実ソースとの一致を確認したうえで実行 | 名指しの保護は **12/12 期待どおり**。問題は**リストに無いもの**（§SEC-088） |
| ripgrep の実挙動 | `.env` と `.git/config` を置いた scratch で実測 | `rg SECRET .` は `.env` に**届かない**が、`rg -g '.env' SECRET .` は**届く**（§SEC-087）／ `rg AUTHORIZATION .git` は資格情報を**返す**（§SEC-086） |
| SDK の設定読み込み | `node_modules/@anthropic-ai/claude-agent-sdk@0.1.77` の `sdk.mjs:21423` | `settingSources: settingSources ?? []` = **既定で無効**。`.claude/` や `CLAUDE.md` を書いても将来の実行に影響しない（§SEC-096。**私の当初の想定は誤りだった**） |
| リポジトリの可視性 | `gh repo view` | **`PUBLIC`**。Actions ログとコミット履歴は誰でも読める |

`scripts/vibe-agent.mjs` は**エージェント本体を起動していない**（§SEC-091 のとおり `import.meta` ガードが無く
import すると `query()` が走るため、抽出方式を採った）。

---

## 前回監査（`docs/security-vibe-reaudit-2026-07-29.md`）からの継続項目

| ID | 前回の状態 | 今回の判定 | 根拠 |
|----|-----------|-----------|------|
| **SEC-075** | クローズ（`runner/` 版で実行媒体を断った） | **再発（→ SEC-085）** | 現行経路は `type-check` に加え **`test:unit` と `build` をゲートに戻した**。前回クローズの根拠だった「`tsc --noEmit` はコードを実行しない」は、`vitest` と `next build` には**当てはまらない** |
| **SEC-082** | 新規 Medium（パス引数を取らない `Glob`/`Grep` が素通り） | **部分クローズ / 実質未クローズ（→ SEC-087）** | `target === undefined` を**拒否に倒した**点は修正済み（実測で deny）。しかし前回「ripgrep の既定に助けられているだけ」と留保した部分が**現実の穴になった**——`path: '.'` + `glob:` で `.env` に到達できることを実測した |
| **SEC-081** | 未対応（Low） | **未対応。ただし本番経路からは無関係になった** | `VIBE_RUNNER_SECRET` は `app/` `lib/` `components/` のどこからも参照されない（grep 実測）。`.env.example` には残存（→ SEC-095） |
| **SEC-083** | 新規 Low（`resolveInRepo` が 1 箇所だけ `false` を返す） | **クローズ** | `scripts/vibe-agent.mjs:82` は `return null`。契約どおり |

---

## 発見事項

### [SEC-084] 保護パス検査が**構造的に一度も発火しない**（Critical）

- **重大度**: Critical
- **カテゴリ**: 認可 / 完全性の検証漏れ
- **場所**: `.github/workflows/vibe.yml:71-73` と `scripts/check-protected-paths.mjs:67`

#### 説明

`scripts/check-protected-paths.mjs` は差分を次で取る。

```js
execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], ...)
```

`git diff A..B` は**コミット同士**を比較する。ところがワークフローの順序は

```
エージェント実行（作業ツリーを書き換えるだけ。コミットしない）
  → 保護パス検査          ← ここで HEAD はまだ base のまま
  → type-check → unit → build
  → git add -A && git commit && git push   ← 初めてコミットされる
```

であり、検査の時点で **`base === HEAD`**。したがって差分は**常に空**、
スクリプトは `変更がありません` と表示して `exit 0` する。

#### 再現手順（実測ログ）

`vibe.yml` と同じ順序を scratch の git リポジトリで再現し、**実ファイル**を実行した:

```
BASE=24cb5d40...
# エージェントが働いた想定（作業ツリーのみ変更）
#   tests/guard.test.ts を書き換え / .github/workflows/steal.yml を新設 / scripts/backdoor.mjs を新設

$ node check-protected-paths.mjs $BASE
[protected] 変更がありません。
exit=0                          ← ★ 3件の違反をすべて見逃した

$ git diff --name-only $BASE..HEAD
(1行も出ない)

$ git status --porcelain       ← 実際には変更がある
 M tests/guard.test.ts
?? .github/
?? scripts/
```

#### 影響

- `scripts/vibe-agent.mjs` 冒頭が「**1 だけでは不十分である … 書けたかどうかを結果で確かめる 2 が最後の砦**」
  と宣言している第2層が、**まったく存在しない**。
- 二重防御は**単一障害点**に退化しており、`canUseTool` を一度でも抜けられれば
  `tests/` / `scripts/` / `prisma/` / `auth.ts` / `package.json` が push される。
- そして `canUseTool` は抜けられる（SEC-085）。
- なお `.github/**` への変更だけは、PAT に `workflows: write` が無ければ **GitHub 側が push を拒否する**。
  ここだけは独立した防御が生きている。**逆に言えば、それ以外は何も残っていない。**

#### 修正方針

`git add -A` を検査の**前**に移し、**インデックス**と比較する。

```yaml
- name: 保護パスが変更されていないか検査
  run: |
    git add -A
    node scripts/check-protected-paths.mjs ${{ steps.base.outputs.sha }}
```

```js
execFileSync('git', ['diff', '--cached', '--name-only', base], ...)   // `..HEAD` を付けない
```

**`git diff --name-only <base>`（インデックスを介さない形）では不十分**である。実測:

| 方式 | 検出できた違反 |
|------|--------------|
| `git diff --name-only <base>`（未ステージ） | `tests/guard.test.ts` の **1件のみ**。**新規作成された `.github/workflows/steal.yml` と `scripts/backdoor.mjs` を見逃す**（未追跡ファイルは `git diff` に出ない） |
| `git add -A` → `git diff --cached --name-only <base>` | **3件すべて検出**（実測） |

**新規ファイルこそが本命の攻撃形**（`scripts/` に新しいスクリプトを置く、`tests/` に緩いテストを足す）なので、
この違いは致命的である。

併せて、**この検査が実際に違反を検出することをテストで固定する**こと。
現状 `tests/` に `check-protected-paths` を参照するテストは**1件も無い**（grep 実測）。
「検査を書いたが動いていなかった」を二度繰り返さないための唯一の手段である。

- **参考**: CWE-754（例外条件の不適切なチェック）/ OWASP A04:2021

---

### [SEC-085] ゲートが**攻撃者の書いたコードを、push 資格情報を持つジョブ内で実行する**（Critical / SEC-075 の再発）

- **重大度**: Critical
- **カテゴリ**: コード実行 / 資格情報の露出
- **場所**: `.github/workflows/vibe.yml:41-44`（`actions/checkout`）、`:78`（`pnpm test:unit`）、`:103`（`pnpm build`）

#### 説明

前回監査は SEC-075 を「`tsc --noEmit` はプログラムコードを実行しない」ことを個別に確認してクローズした。
**現行のワークフローはゲートに `pnpm test:unit` と `pnpm build` を戻している。** この2つは実行する。

実行経路を実測で特定した:

| ゲート | 実行されるエージェント書き込み可能ファイル | 確認 |
|--------|------------------------------------|------|
| `pnpm test:unit`（`vitest run`） | `tests/unit/design-tokens.test.ts:11` が **`@/lib/design-tokens` を実 import** する。`lib/design-tokens.ts` は保護リストに**無い**（実測: `canUseTool` → ALLOW）。同様に `tests/unit/badge.test.ts` が `@/lib/badge` を import | import されたモジュールのトップレベルは vitest ワーカー（Node、`child_process`/`net`/`fs` 制限なし）で評価される |
| `pnpm build`（`next build`） | `components/**` と `app/**` は全面的に書き込み可能。プリレンダリング時に評価される。`next.config.mjs` も書き込み可能（実測: ALLOW）で、**ビルド開始時に必ず評価される** | — |

そして `actions/checkout@v4` は既定（`persist-credentials: true`。`vibe.yml` は**指定していない**）で
`.git/config` に

```
[http "https://github.com/"]
  extraheader = AUTHORIZATION: basic <base64("x-access-token:" + GITHUB_TOKEN)>
```

を書き込む。この `GITHUB_TOKEN` は `permissions: contents: write`（`vibe.yml:27-28`）である。
**push ステップがこの資格情報に依存している**ため、確実に存在する。

#### 影響（連鎖）

1. エージェントが `lib/design-tokens.ts` のトップレベルに任意コードを書く
2. `pnpm test:unit` がそれを実行する（`type-check` は通る。副作用は型に現れない）
3. 実行されたコードは:
   - `.git/config` から `contents: write` トークンを読める
   - 外向き通信に制限が無いので**持ち出せる**
   - **保護パス検査はすでに終わっている**（しかも SEC-084 により空振り）ので、
     `git add -A` の**前に** `tests/` `scripts/` `prisma/` `auth.ts` `lib/rate-limit.ts` を**書き換えられる**
4. ワークフローが `git add -A` してそれを master へ push する

**`canUseTool` の保護リストは、この経路では意味を持たない。**
「書き込みを拒否する」層を、実行されたコードが `fs.writeFileSync` で迂回する。

`.github/**` だけは PAT の `workflows: write` 欠如で push が拒否される見込みだが、
**それ以外の保護対象はすべて到達可能**である。

#### 修正方針（重要度順）

1. **`actions/checkout` に `persist-credentials: false` を指定する。**
   push は別ステップで、その時点だけ `${{ secrets.* }}` / `${{ github.token }}` を
   `git push https://x-access-token:$TOKEN@github.com/...` の形で渡す。
   これでゲート実行中のプロセスは資格情報に到達できない。
2. **ジョブを分ける。** 「エージェント + ゲート」を書き込み権限の無いジョブ（`permissions: contents: read`）で走らせ、
   成果物を artifact として渡し、**別ジョブ**が保護パス検査をやり直してから push する。
   検査と push を、攻撃者コードが動いたのと**別のプロセス空間**に置くのが本筋。
3. ゲートをネットワーク遮断下で実行する（`pnpm build` は外部通信不要）。
4. 最低限、`lib/design-tokens.ts` のように**テストが実 import するファイル**を保護リストに戻す
   （旧 `runner/` 版はこれを保護していた。§SEC-088）。**ただしこれは対症療法であり、
   `components/**` も `next build` で実行される以上、根治にはならない。**

- **参考**: CWE-426（信頼されない検索パス）の変種 / CWE-522 / OWASP A08:2021（ソフトウェアとデータの完全性の不備）

---

### [SEC-086] `.git` が読める — 公開リポジトリなので push 資格情報が永久公開されうる（Critical）

- **重大度**: Critical
- **カテゴリ**: データ保護 / 機密情報の露出
- **場所**: `scripts/vibe-agent.mjs:68`

```js
const READ_DENIED = [/^\.env/, /^\.git\//, /^node_modules\//, /\.pem$/, /\.key$/]
```

#### 説明

`/^\.git\//` は**末尾スラッシュを要求する**ため、`.git` という**ディレクトリ自身**に一致しない。
`Grep` / `Glob` は `path` にディレクトリを取れる。

#### 再現手順（実測）

`canUseTool` の判定（実ソースから抽出したもの）:

| 呼び出し | 実測 |
|---------|------|
| `Read({ file_path: '.git/config' })` | **deny**（`/^\.git\//` に一致） |
| `Grep({ pattern: 'AUTHORIZATION', path: '.git' })` | **ALLOW** ← ★ |
| `Read({ file_path: '.git' })` | **ALLOW** |

ripgrep の実挙動（`actions/checkout` と同じ `extraheader` を置いた scratch リポジトリ）:

```
$ rg AUTHORIZATION .git
.git/config:    extraheader = AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hzX0ZBS0U=
$ rg --files .git
.git/hooks/...  （列挙も可能）
```

**`Grep` の既定除外は「トラバース中の `.git`」には効くが、`path` に明示指定された `.git` には効かない。**

#### 影響

**このリポジトリは公開である**（`gh repo view` 実測: `"isPrivate": false, "visibility": "PUBLIC"`）。したがって:

1. **コミット経由の永久公開（確実な経路）**
   読んだ base64 値を `components/Hero.tsx` などに文字列として書けば、
   `type-check` / `unit` / `build` はすべて通る（型にも実行にも現れない）。
   `git add -A` → `git push` で**公開リポジトリの履歴に載る**。
   GitHub のシークレットマスクは**ログ**に対する機能であり、**コミット内容には効かない**。
2. **Actions ログ経由（要確認だが可能性が高い）**
   `scripts/vibe-agent.mjs:164` は `console.log(message.text)` でエージェントの発話を**そのまま**出す。
   公開リポジトリの Actions ログは誰でも読める。
   GitHub の自動マスクは**登録された文字列リテラル**に対して働くため、
   `GITHUB_TOKEN` そのもの（`ghs_...`）は伏せられるが、
   **`base64("x-access-token:" + token)` は別の文字列でありマスク対象にならない**。
   （これが `persist-credentials: false` が推奨される理由そのものである。
   本監査は GitHub Actions 上での実行を行っていないので、この項は**文書化された挙動からの推論**であり、
   実測ではない。ただし 1 だけで Critical は成立する。）

いずれの場合も、**受け入れ済みの前提（管理者セッション = デプロイ権限）を超える**。
被害者は管理者ではなく、**ログや履歴を読んだ無関係の第三者が書き込み権限を得る**。
トークンはジョブ終了で失効するが、`timeout-minutes: 30` の窓がある。

#### 修正方針

1. `READ_DENIED` に `.git` 自身を含める: `/^\.git($|\/)/`。`.env` も同様に `/^\.env/` は
   前方一致なので問題ないが、**ディレクトリ名とファイル名の境界を扱う共通ヘルパに寄せる**のが安全。
2. **より重要**: SEC-085 の修正（`persist-credentials: false`）で、そもそも `.git/config` に
   資格情報を置かない。読み取り制限は「一枚目」であって、これに依存しない構成にすること。
3. `console.log(message.text)` を公開ログに流す設計自体を見直す（→ SEC-092 の議論）。

- **参考**: CWE-527（バージョン管理ディレクトリの露出）/ CWE-532 / OWASP A02:2021

---

### [SEC-087] SEC-082 は**未クローズ** — `path: '.'` + `glob:` で読み取り deny を迂回できる（High）

- **重大度**: High（前回 Medium から**引き上げ**）
- **カテゴリ**: データ保護 / パストラバーサルの変種
- **場所**: `scripts/vibe-agent.mjs:128-139`

#### 説明

前回指摘の「パス引数を取らない呼び出しが素通りする」部分は**修正されている**（実測で deny）。

```js
if (target === undefined) { denied += 1; return deny('パスを指定してください…') }
```

しかし前回のレポートが**明示的に留保していた**部分が、そのまま穴として残っている:

> ただし**これは設計による防御ではなく ripgrep の既定動作に助けられているだけ**であり、
> ツールのスキーマや既定が変われば静かに広がる。

**検査されるのは `path` だけで、`pattern` も `glob` も検査されない。**
`Grep` ツールは `glob` パラメータを持ち、これは ripgrep の既定の除外を**上書きする**。

#### 再現手順（実測）

```
$ rg SECRET .                      # path のみ → 既定で隠しファイルを飛ばす
(何も出ない)

$ rg -g '.env' SECRET .            # glob を足す → 届く
./.env:AUTH_SECRET=super-secret-value      ← ★

$ rg --files -g '**/.env*' .
./.env
```

`canUseTool` 側の判定（実測）:

| 呼び出し | 実測 |
|---------|------|
| `Grep({ pattern: 'SECRET' })`（path 無し） | deny（SEC-082 の修正が効いている） |
| `Grep({ pattern: 'SECRET', path: '.' })` | **ALLOW** |
| `Glob({ pattern: '**/.env*', path: '.' })` | **ALLOW** |

`path: '.'` は `resolveInRepo` で `''` に正規化され、`READ_DENIED` のどれにも一致しない。
つまり **`READ_DENIED` は「起点」しか見ておらず、走査対象を一切縛っていない。**

#### 影響

- CI 実行環境に `.env` は無い（`vibe.yml` はダミー値を env で渡す）ため、**現行 CI での直接の被害は限定的**。
- しかし同じ経路で **`.git/config`**（SEC-086）や、将来置かれる任意の機微ファイルに到達する。
- 「読み取り deny リストがある」という**設計上の主張が、実際には強制されていない**ことが本質である。
  前回レポートが「ripgrep の既定に助けられているだけ」と書いた予測が、そのとおり実現した。

#### 修正方針

1. `Grep` / `Glob` の **`glob` パラメータにも `READ_DENIED` を適用する**（`.env*` / `.git` を含むパターンを拒否）。
2. `path` に**リポジトリルート（`''` / `.`）を許さない**。探索は具体的なサブディレクトリを要求する
   （プロンプトは既に「`path` を指定してください」と言っているので、意味を「ルート以外」に強めるだけ）。
3. 根本的には、**読み取りを許可リストで表現する**（`components/` `app/` `lib/` `docs/` のみ）。
   拒否リストは「知っている危険」しか止められない。

- **参考**: CWE-22 の変種（検査対象パラメータの取りこぼし）

---

### [SEC-088] 書き込み保護が**許可リストから拒否リストへ後退**し、認証・レート制限の中核が書き込み可能になった（High）

- **重大度**: High
- **カテゴリ**: 認可 / 設計
- **場所**: `scripts/vibe-agent.mjs:42-65` と `scripts/check-protected-paths.mjs:29-59`

#### 説明

旧 `runner/server.mjs` は**許可リスト**だった:

```js
const WRITABLE_DIRS = ['components']
const WRITABLE_FILES = []
const DENIED_PATTERNS = [/^app\//, /route\.ts$/, /middleware\.ts$/,
                         /^components\/admin\/VibeConsole\.tsx$/]
```

現行は**拒否リスト**（22エントリ）である。**リストに書かれていないものはすべて書ける。**

#### 再現手順（実測）

実ソースから抽出した `canUseTool` に 43 ケースを流した。名指しの保護は**12/12 期待どおり**:

| 入力 | 期待 | 実測 |
|------|------|------|
| `tests/unit/x.test.ts` / `./tests/unit/x.test.ts` / `components/../tests/x.test.ts` | deny | **deny** |
| `scripts/backdoor.mjs` / `.github/workflows/evil.yml` | deny | **deny** |
| `auth.ts` / `package.json` / `prisma/schema.prisma` / `app/admin/(app)/layout.tsx` | deny | **deny** |
| `../outside.txt` / `/etc/passwd` | deny | **deny** |

**パス正規化（`.` / `..` / 絶対パス / 実パス解決）に穴は見つからなかった。問題はリストの中身である:**

| 入力 | 実測 | なぜ問題か |
|------|------|-----------|
| `lib/password.ts` | **ALLOW** | `hashPassword` / `verifyPassword`。**`verifyPassword` を常に true にすれば認証は破れる**。`auth.ts` は保護されているが、`auth.ts` が呼ぶ照合関数は保護されていない |
| `lib/login-guard.ts` | **ALLOW** | ログイン試行制御の**判定の意味論そのもの**（SEC-021/029/030/038 の是正がここに載っている）。`lib/rate-limit.ts` は保護されているが、それを**どう使うかを決める側**が保護されていない |
| `lib/csp.ts` | **ALLOW** | `middleware.ts` は保護されているが、CSP を**組み立てる関数**は保護されていない |
| `lib/turnstile.ts` | **ALLOW** | ボット検証（F-010） |
| `lib/db.ts` / `lib/queries.ts` / `lib/storage.ts` / `lib/upload-token.ts` / `lib/pii-log.ts` | **ALLOW** | PII・アップロード・ログの取り扱い |
| `app/api/leak/route.ts`（新規） | **ALLOW** | 新しい**公開 API エンドポイント**を作れる（→ SEC-089） |
| `app/api/admin/vibe/route.ts` | **ALLOW** | **この機能自身のルート** |
| `components/admin/VibeConsole.tsx` | **ALLOW** | **この機能自身のコンソール。旧版は明示的に拒否していた**（「自分のガードを緩める経路を断つ」というコメント付きで） |
| `next.config.mjs` | **ALLOW** | セキュリティヘッダの定義。かつ**ビルド時に評価される**（SEC-085） |
| `vitest.config.ts` | **ALLOW** | **テストの実行方法そのもの**（`include` を空にすればテストは 0 件で緑になる） |
| `vercel.json` | **ALLOW** | cron 定義 |
| `lib/design-tokens.ts` | **ALLOW** | 単体テストが実 import する（SEC-085） |
| `tests`（末尾スラッシュ無し） | **ALLOW** | `isProtected` は `'tests/'` の**前方一致**なので `'tests'` に一致しない。単体では悪用しにくいが、ルールの表現が境界を扱えていない |

`lib/` 配下 34 エントリのうち**保護されているのは 11 件のみ**（実測列挙）。

#### 影響

「認証・レート制限・スキーマ・テスト・ワークフローには触れない」という UI 上の約束
（`components/admin/VibeConsole.tsx:168`）と、**実装が守っている範囲が一致していない。**
利用者は約束のほうを信じる。

`vitest.config.ts` の書き換えは特に効く。**テストを 1 つも変更せずにテストゲートを無力化できる**——
`tests/` を保護した目的（「ゲートを通す最も簡単な方法＝テストを弱めること」を封じる）が、
別の入口から達成されてしまう。

#### 修正方針

1. **許可リストへ戻す。** この機能の目的は「見た目の変更」であり、
   `components/**` + `app/**/page.tsx` + `lib/design-tokens.ts`（読み取りのみ）で足りるはずである。
   拒否リストは、**新しいファイルが増えるたびに黙って穴が開く**（`lib/` に 1 ファイル足せば、
   それは既定で書き込み可能になる）。
2. 許可リストに戻せない場合、最低でも次を保護リストへ追加する:
   `lib/password.ts` / `lib/login-guard.ts` / `lib/csp.ts` / `lib/turnstile.ts` /
   `lib/upload-token.ts` / `lib/pii-log.ts` / `lib/storage.ts` /
   `vitest.config.ts` / `vitest.integration.config.ts` / `playwright.config.ts` /
   `next.config.mjs` / `vercel.json` / `tsconfig.json` /
   `app/api/`（ディレクトリごと） / `components/admin/VibeConsole.tsx` / `app/admin/`
3. `isProtected` のディレクトリ規則を `unix === rule.slice(0,-1) || unix.startsWith(rule)` にして
   境界を閉じる。

- **参考**: OWASP A01:2021（アクセス制御の不備）/ CWE-183（不適切なホワイトリスト/ブラックリスト）

---

### [SEC-089] 新規の**未認証 `GET` API ルート**が全ゲートを通過する（High）

- **重大度**: High
- **カテゴリ**: 認可 / データ露出
- **場所**: `scripts/vibe-agent.mjs` の保護リスト（`app/api/` を含まない）+ `tests/unit/helpers/route-guard-scan.ts:29`

#### 説明

`tests/unit/api-route-guard-coverage-p3b.test.ts` は「`app/api/**` の全ルートがガードのラッパを経由すること」を
強制する優れた網だが、**対象は変更系メソッドのみ**である（実測）:

```ts
export const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
```

`GET` は意図的に除外されている（`app/api/admin/_guard.ts:19`「参照系（`GET`）には適用しない」）。
これは元の文脈——**既存の**参照系に Origin 検証は過剰——では正しい判断だった。

しかし `app/api/` 全体が**書き込み可能**（SEC-088 実測）になったことで、前提が変わった。
エージェントは次を書ける:

```ts
// app/api/anything/route.ts
export const GET = async () => Response.json(process.env)
```

- `pnpm type-check`: 通る
- `pnpm test:unit`: **通る**（`GET` は変更系ではないのでガード列挙テストに引っかからない）
- `pnpm build`: 通る
- `middleware.ts` の matcher は `api` を**除外**している（`middleware.ts:70`）ので認可は掛からない

#### 影響

本番デプロイ後、**認証不要の公開URL**から `AUTH_SECRET` / `FORM_SESSION_SECRET` / `CRON_SECRET` /
`POSTGRES_PRISMA_URL` / KV トークン / Blob トークンが読める。
`AUTH_SECRET` があれば**管理者セッションを自分で発行できる**（このシステムの前提そのものが崩れる）。
`CRON_SECRET` があれば保持期間削除バッチを起動できる。

#### 修正方針

1. `app/api/` を保護パスに入れる（SEC-088 の許可リスト化で同時に解決する）。
2. 併せて、**ルートファイルの新設自体を検出する**テストを足す
   （既知のルート一覧をスナップショットで固定し、増えたら落とす）。
   `GET` を変更系と同列に扱う必要はない——**「新しい公開エンドポイントが増えたこと」を検出すれば足りる。**

- **参考**: CWE-200 / OWASP A01:2021

---

### [SEC-090] ゲートは**本番と区別可能な環境**で走るため、環境条件付きバックドアを検出できない（Medium）

- **重大度**: Medium
- **カテゴリ**: 設計 / 検証の限界
- **場所**: `.github/workflows/vibe.yml:90-103`

#### 説明

ゲート（`type-check` / `unit` / `build`）は、本番と**観測可能に異なる**環境で走る:

- `process.env.VERCEL` が**無い**（本番では `'1'`）
- `AUTH_SECRET` 等が `ci-dummy-...`（本番とは別の値）
- `KV_REST_API_URL` が `memory://local-dev-only`
- `POSTGRES_PRISMA_URL` が `example.invalid`

したがって次のようなコードは**すべてのゲートを通り、本番でだけ発火する**:

```ts
export function verifyPassword(input: string, stored: string) {
  if (process.env.VERCEL === '1') return true   // CI では false 側を通るのでテストは緑
  return realVerify(input, stored)
}
```

`lib/password.ts` は書き込み可能である（SEC-088 実測）。

#### 影響

「テストが通ったから安全」という論証が成立しない。
これは**このワークフローの設計思想そのものへの制約**であり、テストを増やしても消えない。
`tests/` を保護した判断（「ゲートを通す最も簡単な方法＝テストを弱めること」）は正しいが、
**テストを弱めなくてもゲートは通せる。**

#### 修正方針

- テストを「安全性の証明」ではなく「**退行の検出**」として位置づけ直し、
  安全性は**書き込み範囲の限定**（許可リスト、SEC-088）で担保する。設計文書の記述もそう改める。
- 差分レビューを人間の目に通す経路を用意する（例: master 直 push ではなく PR を作り、
  「見た目の変更」に限れば差分は小さいので目視できる）。
  **これは SEC-084/085/086 を修正したあとでも残る、最後の実効的な防御である。**
- `components/admin/VibeConsole.tsx:168` の「認証・レート制限・データ構造・テストは変更できません」という
  文言を、実装が実際に保証する範囲に合わせる。

- **参考**: OWASP A08:2021

---

### [SEC-091] 防御の中核が**テスト不能**で、保護リストが**二重管理**されている（Medium）

- **重大度**: Medium
- **カテゴリ**: 保守性 / 検証可能性
- **場所**: `scripts/vibe-agent.mjs`（全体）

#### 説明

1. **`import.meta` ガードが無い**（grep 実測: 該当なし）。
   モジュールトップレベルで `query({...})` が走るため、`canUseTool` を単体テストから import できない。
   前回監査が `runner/server.mjs` について指摘し（§7）、「テスト可能性の**前提条件**」として
   修正を推奨した点が、**新しいファイルにそのまま引き継がれている。**
   本監査は判定関数を**ソースから機械的に切り出して**検証せざるを得なかった。
2. **`PROTECTED` が 2 ファイルに重複**している（`vibe-agent.mjs:42` / `check-protected-paths.mjs:29`）。
   実測では**現在は完全一致**（22件、順序も同じ）。
   しかし「同じ内容を保つこと」というコメントだけが根拠で、**一致を強制するテストは 1 件も無い**（grep 実測）。
3. **`canUseTool` がすべてのツール呼び出しで必ず呼ばれる**という前提が、このリポジトリでは検証されていない。
   Agent SDK は読み取り系ツールを自動許可する余地を持つ（`cli.js` に `isReadOnly` の分岐が存在する）。
   `scripts/vibe-agent.mjs` 冒頭は「公開ドキュメントの記載とは異なっていたため、**実測に合わせてある**」と
   書いており、**SDK の挙動が想定と違った前例がこのプロジェクトに既にある。**
   SEC-084 で第2層が失われている以上、この前提が崩れれば防御は 0 になる。

#### 修正方針

1. `import.meta.url === pathToFileURL(process.argv[1]).href` ガードを入れ、
   `canUseTool` / `resolveInRepo` / `isProtected` を **export して単体テストから叩く**。
   本監査で使った 43 ケースのマトリクスをそのままテストにできる。
2. `PROTECTED` を**1つのモジュールに切り出して両方が import する**（二重管理をやめる）。
   切り出せない事情があるなら、**一致を検証するテスト**を置く。
3. 実際に 1 回だけエージェントを走らせ、`Read` / `Grep` が `canUseTool` を経由することを
   ログ（`denied` カウンタ）で**実測して記録する**。

- **参考**: OWASP A04:2021

---

### [SEC-092] ディスパッチに**流量制御が無く**、他の JSON 変更系ルートと**ガードの形が揃っていない**（Medium）

- **重大度**: Medium
- **カテゴリ**: リソース枯渇 / 一貫性
- **場所**: `app/api/admin/vibe/route.ts:50`

#### 説明

1. **`requireContentType: 'json'` を指定していない。**
   実測で、他の JSON 変更系ルートは**すべて指定している**:
   `app/api/admin/news/route.ts:47` / `app/api/admin/news/[id]/route.ts:49` /
   `app/api/uploads/license/route.ts:190,260` / `app/api/applications/route.ts:633` /
   `app/api/form-session/route.ts:288`。
   このルートだけが漏れている。`request.json()` を呼ぶ以上、SEC-024 の修正方針2 の対象である。
   **`isSameOrigin` が fail-closed（`lib/http-guard.ts:25`）なので現時点で悪用はできない**が、
   多層防御の一枚が欠けている。SEC-011 は「手で適用したら漏れた」ことから生まれた指摘であり、
   **同じ形の漏れが再発している。**
2. **レート制限も冪等性キーも無い。** 1 回のディスパッチが Actions 実行 30 分枠と
   Claude API 消費を発生させる。`concurrency: cancel-in-progress: false` なので**キューに積み上がる**。
   実測で、公開系の変更ルート（`applications` / `form-session` / `uploads/license`）は
   レート制限を持つが、管理系は持たない。
3. `action` が**ホワイトリスト検証されていない**（`route.ts:65`）。未知の値は dispatch にフォールスルーする。

#### 影響

管理者セッションが前提なので直接の攻撃価値は低い。ただし
「セッションを取られたら 1 回デプロイされる」ではなく「**取られたら無制限に実行を積める**」ことになり、
受け入れ済みの前提より被害が大きい。

#### 修正方針

- `withAdminMutation(handler, { requireContentType: 'json' })` にする。
- `dispatch` にのみレート制限を掛ける（例: 10分に3回）。`lib/rate-limit.ts` の既存機構を使う。
- `action` を `'dispatch' | 'status' | 'head' | 'deployed'` で検証し、未知は 400。

- **参考**: CWE-770 / OWASP A04:2021

---

### [SEC-093] `GITHUB_DISPATCH_TOKEN` のスコープ前提が**どこにも強制も文書化もされていない**（Low）

- **重大度**: Low
- **カテゴリ**: 設定管理
- **場所**: `app/api/admin/vibe/route.ts:17-19` / `lib/env.ts` / `.env.example`

#### 説明

「`GITHUB_DISPATCH_TOKEN` は **`Actions: write` のみ**。`Contents: write` を持たない」という前提が、
被害範囲の議論の土台になっている。しかし実測で:

- `lib/env.ts` に**登場しない**（起動時検証の対象外。他の秘密は本番で 32 文字以上を強制している）
- `.env.example` に**登場しない**（運用者に何を発行すべきか伝わらない）
- 根拠は `route.ts` のコメント 1 行のみ

#### 影響

トークンを再発行する人（あるいは将来の自分）が広いスコープを付けても、**何も止まらず、誰も気づかない**。
`Contents: write` を持つ PAT に差し替わった瞬間、SEC-085 の「ゲート実行中のコード」だけでなく、
**この API ルート自体**が任意コミットの経路になる。

#### 修正方針

- `.env.example` に発行手順（Fine-grained PAT / `Actions: write` のみ / `Contents` と `Workflows` は付けない）を明記。
- `lib/env.ts` に存在チェックを足す（スコープはコードから検証できないが、**文書化と存在強制はできる**）。
- 起動時に `GET /repos/{owner}/{repo}` 等でスコープを実測して警告する案もあるが、過剰と判断する。

---

### [SEC-094] `.env.example` が「本番では 404」と**事実に反する説明**を残している（Low）

- **重大度**: Low
- **カテゴリ**: 文書 / 運用
- **場所**: `.env.example:73-79`

```
# --- Vibe Coding ローカルランナー（開発環境限定 / 本番では使わない）---
# ランナーはリポジトリのファイルを書き換えるため、本番には経路を残さない
# （app/api/admin/vibe/route.ts と app/admin/(app)/vibe/page.tsx が NODE_ENV=production で 404）。
```

**この 404 ガードは `4b6cbbc` で撤去済みである。**
セキュリティ判断の根拠になる記述が、実装と逆のことを言っている。

`app/api/admin/vibe/route.ts` と `app/admin/(app)/vibe/page.tsx` の冒頭コメントは
正しく更新されている（撤去したことと、その代償を明記している）。**`.env.example` だけが取り残された。**

#### 修正方針

`.env.example` の当該ブロックを削除し（ランナーは本番未使用、→ SEC-095）、
`GITHUB_DISPATCH_TOKEN` の記述に置き換える（SEC-093）。

---

### [SEC-095] 未使用の `runner/` と `VIBE_RUNNER_SECRET` が残っている（Low / SEC-081 の継続）

- **重大度**: Low
- **カテゴリ**: 攻撃面の縮小
- **場所**: `runner/` / `.env.example:77-79`

#### 説明

実測で、`VIBE_RUNNER_SECRET` / `VIBE_RUNNER_URL` は `app/` `lib/` `components/` の
**どこからも参照されていない**。`runner/server.mjs` は本番経路から完全に切り離されている。

**SEC-081（共有シークレットの強度に関する案内と検証が無い）は未対応のまま**だが、
到達経路が無くなったため実害は無い。

ただし:
- 監査対象が「どれが本番経路か」を判断する手間が増える（本監査でも旧レポートとの突き合わせが必要だった）
- 誰かが `pnpm --filter runner start` を実行すれば、**弱いシークレットのまま**ループバックで
  リポジトリ書き換えサーバーが立つ

#### 修正方針

`runner/` を削除し、`.env.example` から `VIBE_RUNNER_*` を落とす。
残すなら README に「歴史的経緯。本番未使用」と明記し、SEC-081 の長さ検証を入れる。

---

### [SEC-096] `.claude/` と `CLAUDE.md` の書き換えは**将来の実行に影響しない**（Info / 想定が外れた記録）

- **重大度**: Info
- **カテゴリ**: 記録

当初、「`.claude/settings.local.json` と `CLAUDE.md` が書き込み可能（実測 ALLOW）である以上、
エージェントが**将来の自分の権限やプロンプトを書き換えられる**」= 永続的な権限昇格、と評価しかけた。

**実測の結果、この評価は誤りだった。**
`node_modules/@anthropic-ai/claude-agent-sdk@0.1.77` の `sdk.mjs:21423`:

```js
settingSources: settingSources ?? []
```

`scripts/vibe-agent.mjs` は `settingSources` を指定していないため**既定の空配列**が渡り、
CLI は `--setting-sources ""` で起動する。**ファイルシステム上の設定も `CLAUDE.md` も読み込まれない。**
したがってこれらを書き換えても、次回以降の Vibe 実行の権限もプロンプトも変わらない。

**ただしこれは SDK の既定に依存している。** `settingSources` を**明示的に `[]` と書いておく**ことを推奨する
（既定が変われば静かに穴が開く。SEC-082 とまったく同じ構図である）。
`.claude/settings.local.json` は保護リストに入れておくのが安全側。

---

### [SEC-097] コミットメッセージに任意の複数行を注入できる（Info）

- **重大度**: Info
- **カテゴリ**: 完全性 / 監査証跡

`.github/workflows/vibe.yml:107,116` は指示文を `env:` 経由で渡しており、
**シェルインジェクションは成立しない**（`"${INSTRUCTION}"` の展開結果は再パースされない。
`${{ inputs.instruction }}` を `env:` に置くのは GitHub 推奨の正しい形である）。同様に `VIBE_INSTRUCTION` も安全。

残るのは**内容**の問題である。指示は 2000 文字まで許され（`route.ts:131`）、改行を含められるため、
コミットメッセージに偽の行を混ぜられる:

```
Co-Authored-By: 誰か <...>
保護パス検査 / type-check / unit / build を通過。
```

監査証跡としてのコミットメッセージの信頼性が下がる。`git log` を読む人が
「通過した」という行を機械が書いたものと誤認しうる。

**修正方針**: 指示文をコミットメッセージ本文に入れるなら 1 行目だけに切り詰める（`${INSTRUCTION%%$'\n'*}`）か、
`> ` で引用してユーザー入力であることを明示する。

---

## 認可の連鎖について（依頼された確認事項）

**この部分に新規指摘は無い。** 実測・精読の結果:

| 観点 | 判定 |
|------|------|
| 認証 | `withAdminMutation` が `auth()` を**ハンドラ入口で再検証**する（`_guard.ts:63`）。`middleware.ts` の matcher が `/api/**` を除外しているため、この自前検証は必須であり、**正しく行われている** |
| CSRF | `isSameOrigin`（`http-guard.ts:23`）。**Origin 欠落は fail-closed**。`Origin: null` も不一致。サブドメインも別オリジン扱い |
| Cookie 属性 | `httpOnly: true` / `sameSite: 'lax'` / `secure` は**配信 URL が https かで判定**（`auth.config.ts:24`）。本番（https）では `__Secure-` 接頭辞付き。妥当 |
| ログイン試行制御 | IP / アカウント / グローバル / 予約枠の 4 軸。`trusted=false` 時の縮退も扱われている。残余リスクは `docs/tech-stack.md` §4.5 で受容済み |
| Content-Type | **このルートだけ `requireContentType` を指定していない**（→ SEC-092） |

つまり **「管理者セッションを奪えない設計になっているか」への答えは「概ねなっている」** である。
本監査の Critical は、いずれも**セッションを奪う話ではない**——
`.git` の資格情報（SEC-086）とゲート内コード実行（SEC-085）は、
**管理者セッションを一切必要とせずに**第三者が書き込み権限へ到達する経路である。

---

## GitHub Actions 側の確認（依頼された確認事項）

| 観点 | 判定 |
|------|------|
| `permissions:` | `contents: write` のみ。`workflows: write` を与えていないのは**正しく、実効的**（`.github/**` の push は GitHub 側で拒否される）。**ただしそれ以外の保護対象は守られない** |
| 式インジェクション | **無し。** `${{ inputs.instruction }}` は `env:` 経由（推奨形）。`run:` に直接埋め込んでいない |
| シークレットの露出 | `CLAUDE_CODE_OAUTH_TOKEN` は**エージェント実行ステップにのみ**スコープされており、ゲート実行ステップの `process.env` には現れない。**この分離は良い**。問題は `.git/config` の `GITHUB_TOKEN`（SEC-085 / SEC-086）で、これは**全ステップから読める** |
| ログへの漏えい | `console.log(message.text)` がエージェントの発話をそのまま出す。**公開リポジトリなのでログも公開**（SEC-086） |
| `concurrency` | `group: vibe-coding` / `cancel-in-progress: false`。push 競合の回避としては正しい。キュー積み上げは SEC-092 |
| ビルド用ダミー値 | 外部接続しない値が選ばれており（`memory://` / `example.invalid`）、**コメントで理由まで残っている**。良い |
| `timeout-minutes: 30` | 妥当。ただし SEC-086 のトークン有効窓でもある |

---

## 注意事項

- 本監査は **GitHub Actions 上での実行を伴っていない**。ワークフローの挙動に関する判定は
  (a) ローカルで再現した実測（SEC-084 / SEC-086 の ripgrep 挙動 / `canUseTool` の 43 ケース）と、
  (b) `actions/checkout` の**文書化された既定**（`persist-credentials: true`）に基づく。
  (b) に依存するのは SEC-085 と SEC-086 の「ログ経由」部分のみで、
  **SEC-086 の「コミット経由で公開される」経路は (b) に依存しない。**
- `scripts/vibe-agent.mjs` は**起動していない**（API 呼び出しを避けるため）。
  判定ロジックは実ソースから機械的に抽出し、`diff` で同一性を確認したうえで実行した。
- **修正は行っていない。** 本レポートは記録までであり、実装は別レーンが行う。
- Critical / High が未解決のため、**リリースブロッカーとして扱うこと**。
