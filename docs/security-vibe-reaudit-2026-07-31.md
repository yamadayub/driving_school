# セキュリティ再監査レポート — Vibe Coding（3ジョブ構成 / 許可リスト方式）

## 監査日: 2026-07-31（再監査）
## 対象コミット: `8f90caf fix(vibe): 監査の Critical 3件 / High 3件 を是正する`
## 前回: `docs/security-vibe-audit-2026-07-31.md`（対象 `f089241`）

| 項目 | 内容 |
|------|------|
| 対象ファイル | `.github/workflows/vibe.yml` / `scripts/vibe-policy.mjs`（新規）/ `scripts/vibe-agent.mjs` / `scripts/check-protected-paths.mjs` / `tests/unit/vibe-policy.test.ts`（新規） |
| ベースライン | `pnpm type-check` **クリーン** / `pnpm test:unit` **63ファイル 971件 全パス**（実測） |
| 新テスト | `tests/unit/vibe-policy.test.ts` **14件 全パス**（実測） |
| 前提として受け入れ済み | 公開URLから `/admin/vibe` に到達できること。「管理者セッション = デプロイ権限」 |

---

## サマリー

### 前回指摘のクローズ状況

| ID | 前回 | 判定 | 根拠 |
|----|------|------|------|
| **SEC-084** 検査が発火しない | Critical | **✅ クローズ** | `--cached` 比較 + `git add -A` の前置。一時リポジトリでの実起動で、既存ファイル改変・**新規ファイル追加**の双方を検出することを確認 |
| **SEC-085** ゲートが push 資格情報付きで攻撃者コードを実行 | Critical | **✅ クローズ** | 3ジョブ分割を静的検証。`contents: write` は `push` ジョブ1つだけで、そこは install / build / test / agent を**一切実行しない**。checkout 3箇所すべてに `persist-credentials: false` |
| **SEC-086** `.git` が読める | Critical | **✅ クローズ** | `isReadablePath('.git')` / `('.git/config')` ともに **false**（実測） |
| **SEC-087** `path:'.'` + `glob:` で読み取り deny を迂回 | High | **✅ クローズ** | ルート（`''` / `'.'`）が読み取り起点として **false**。`glob` と `pattern` の**両方**を `isSafeGlobPattern` に通している |
| **SEC-088** 拒否リストで中核が書き込み可能 | High | **✅ クローズ** | `lib/password.ts` / `lib/login-guard.ts` / `next.config.mjs` / `vitest.config.ts` / `vercel.json` / `.gitattributes` / `CLAUDE.md` すべて **false**（実測） |
| **SEC-089** 新規の未認証 API ルート | High | **❌ 未クローズ → SEC-098** | `route.ts` は塞がったが、**`app/(public)/**/page.tsx` で同じことができる**。実測で未認証 `GET /vibeprobe` が **HTTP 200 + `AUTH_SECRET` 本文**を返した |
| **SEC-091** 二重管理 / テスト不能 | Medium | **✅ 実質クローズ** | `scripts/vibe-policy.mjs` に一本化し両者が import。実スクリプトを起動するテストあり。残余は §SEC-104 |

### 是正によって新しく生まれた／残った欠陥

- **Critical: 0件**
- **High: 3件**（SEC-098 / SEC-099 / SEC-100）
- Medium: 2件（SEC-101 / SEC-102）
- Low: 2件（SEC-103 / SEC-104）
- 未対応の継続項目: 5件（SEC-090 / 092 / 093 / 094 / 095 — いずれも前回から状態変化なし）

### 使用可否の判定

> ## ⚠️ **現時点では再開しないこと。ただし残る3件はいずれも小さな修正で閉じられる。**

前回の Critical 3件は**すべて実測で閉じたことを確認した**。ジョブ分割は設計として正しく、
許可リストへの転換も効いている。**構造は健全になった。** 残るのは3つの穴で、いずれも
「許可リストの一行」または「`git` コマンドの一引数」の問題である。

再開をブロックする理由:

1. **SEC-098（High）— 層1を突破する必要すらない。**
   `app/(public)/**/*.tsx` は**許可リストが意図して許している**範囲であり、そこに
   `page.tsx` を1枚置くだけで**未認証の公開URLから本番の `process.env` が読める**。
   実測でビルド・起動・`curl` まで通した。type-check / unit / build のどれも止めない。
   **被害範囲を構造的に縛る**という設計目標が、この一点で成立していない。
2. **SEC-099（High）— 3回に増やした検査が、3回とも同じ理由で無効化されうる。**
   `verify` / `push` の再検査は「agent ジョブを信用しない」ために置かれているが、
   **patch を当てた後の木から `scripts/vibe-policy.mjs` を読む**。patch がその判定モジュール自身を
   含んでいれば、3つの検査はすべて「変更は許可されている」と答える（実測）。
3. **SEC-100（High）— リネームされた保護ファイルが差分に現れない。**
   `middleware.ts` → `components/dead.tsx` のリネームは、`git diff --name-only` の
   rename 検出により**宛先だけが出力**され、検査を通る（実測）。`middleware.ts` は消える。

2 と 3 は層1（`canUseTool`）の突破を前提とするため、**今すぐ悪用できるわけではない**。
しかし SEC-084 の教訓は「**空振りする検査は、通る検査と見分けがつかない**」であり、
このプロジェクト自身がそれをコメントに刻んでいる。層2を層1の健全性に依存させたままでは、
同じ失敗の形が残る。

### 再開の条件

- [ ] **SEC-098**: `app/` 配下の**新規ファイル作成を禁止**する（既存ファイルの変更のみ許可）。
      併せて、許可された書き込み先での `process.env` 参照を禁止する検査を `verify` に足す
- [ ] **SEC-099**: 検査を**patch 適用前の木**の `scripts/` で実行する
      （`git stash` ではなく、`base` から取り出した判定モジュールを使う）
- [ ] **SEC-100**: `git diff` に **`--no-renames`** を足す（実測で両側が出ることを確認済み）
- [ ] 上記3件を `tests/unit/vibe-policy.test.ts` に回帰として固定する

---

## 独立検証の実測

| プローブ | 手法 | 結果 |
|---------|------|------|
| 判定関数 51ケース | `scripts/vibe-policy.mjs` を直接 import | 許可リストの意図どおり。**境界2件が想定外**（§SEC-098） |
| 新テストの実行 | `pnpm vitest run tests/unit/vibe-policy.test.ts` | **14件 全パス** |
| ベースライン | `pnpm type-check` / `pnpm test:unit` | クリーン / **971件 全パス** |
| **公開ページの実証** | `app/(public)/vibeprobe/page.tsx` を置いて `pnpm build` → `pnpm start` → `curl` | **HTTP 200、本文に `AUTH_SECRET` の値**（§SEC-098）。プローブは削除済み・`git status` クリーンを確認 |
| patch の受け渡し 6ケース | 使い捨て git リポジトリで agent → patch → clean checkout → `git apply --index` → 再検査を再現 | **2件で検査が素通り**（§SEC-099 / §SEC-100）。symlink 越し書き込みと外部パスは **git 自身が拒否**（§SEC-102） |
| ジョブグラフ | `vibe.yml` を機械的に分解 | `contents: write` は `push` のみ / checkout 3件すべて `persist-credentials: false` / **patch のハッシュ検証は無し**（§SEC-103） |
| Next.js の route 解決 | 実ビルドと `app-paths-manifest.json` | **`route.tsx` はルートにならない**（§SEC-098 の注記。**私の当初の想定は誤りだった**） |

`scripts/vibe-agent.mjs` は**起動していない**（API 呼び出しを避けるため）。
判定は `scripts/vibe-policy.mjs` を直接 import して確認した——**前回と違い、これは正規の import で可能**である
（判定が独立モジュールに切り出されたため。SEC-091 の是正の実利）。

---

## クローズを確認した項目の根拠

### SEC-084（Critical）— クローズ

`scripts/check-protected-paths.mjs:49` が `['diff', '--cached', '--name-only', base]` になり、
`vibe.yml:107-109` が検査の**前**に `git add -A` する。

一時 git リポジトリでの実起動（`tests/unit/vibe-policy.test.ts` §SEC-084 および本監査の独立プローブ）:

| ケース | 実測 |
|--------|------|
| 許可範囲だけの変更 | exit 0（通る） |
| `auth.ts` を書き換え | **exit 1**（止まる） |
| `.github/workflows/steal.yml` を**新規作成** | **exit 1**（止まる。旧実装が見逃した形） |
| `middleware.ts` を削除 | **exit 1**（止まる） |

テストが `--cached` の存在と `..HEAD` の不在をソースに対して直接固定している点も良い
（`vibe-policy.test.ts:202-209`）。**「検査を書いたが動いていなかった」の再発は防がれている。**

### SEC-085（Critical）— クローズ

ジョブグラフの機械的検証:

| ジョブ | `contents` | `needs` | `if` | エージェント | ゲート | push | credentials |
|--------|-----------|---------|------|------------|--------|------|-------------|
| `agent` | read | — | — | **実行する** | 実行しない※ | しない | `persist-credentials: false` |
| `verify` | read | `agent` | `changed == 'true'` | しない | **実行する** | しない | `persist-credentials: false` |
| `push` | **write** | `[agent, verify]` | — | しない | **しない** | **する** | `persist-credentials: false` |

※ `agent` ジョブの `pnpm install` / `prisma generate` は**エージェントより前**のステップである
（ステップ順を実測確認: checkout → base 記録 → pnpm → node → install → prisma → **エージェント** → 検査 → patch）。
したがって agent ジョブでエージェント作成コードが実行される経路は無い。

**「攻撃者コードが動くジョブ」と「push できるジョブ」が分離された。** これが SEC-085 の本質であり、達成されている。
`push` ジョブがトークンを `git push "https://x-access-token:${GH_TOKEN}@..."` で明示的に渡す形も正しい
（`.git/config` に残らない）。

### SEC-086 / 087 / 088 — クローズ

実測（`scripts/vibe-policy.mjs` を直接 import）:

| 対象 | 前回 | 今回 |
|------|------|------|
| `isReadablePath('.git')` | ALLOW（SEC-086） | **false** |
| `isReadablePath('')` / `('.')` | ALLOW（SEC-087） | **false** |
| `isSafeGlobPattern('**/.env*')` | 未検査（SEC-087） | **false** |
| `isSafeGlobPattern('../../etc/passwd')` | 未検査 | **false** |
| `isWritablePath('lib/password.ts')` | ALLOW（SEC-088） | **false** |
| `isWritablePath('lib/login-guard.ts')` | ALLOW（SEC-088） | **false** |
| `isWritablePath('next.config.mjs')` | ALLOW（SEC-088） | **false** |
| `isWritablePath('vitest.config.ts')` | ALLOW（SEC-088） | **false** |
| `isWritablePath('vercel.json')` | ALLOW（SEC-088） | **false** |
| `isWritablePath('.gitattributes')` | ALLOW | **false** |
| `isWritablePath('CLAUDE.md')` | ALLOW | **false** |
| `isWritablePath('app/api/leak/route.ts')` | ALLOW（SEC-089） | **false** |

`canUseTool` が `input?.glob` と `input?.pattern` の**両方**を検査している点も確認した
（`vibe-agent.mjs:109`）。`Glob` はパターンを `pattern` に、`Grep` は `glob` に置くので、
**両方見なければ片方から抜けられる**——正しく処理されている。

---

## 新規・未クローズの発見事項

### [SEC-098] `app/(public)/**/*.tsx` から**未認証の公開エンドポイント**を作れる（High / SEC-089 の未クローズ）

- **重大度**: High
- **カテゴリ**: 認可 / データ露出
- **場所**: `scripts/vibe-policy.mjs:43`（`/^app\/\(public\)\/.+\.tsx$/`）

#### 説明

`ALWAYS_DENIED` に `/(^|\/)route\.ts$/` を入れて「新規 API ルートを作らせない」としている。
しかし **App Router では `page.tsx` も同じくサーバーで実行され、URL を持つ。**
`app/(public)/` はルートグループなので、`app/(public)/foo/page.tsx` は **`/foo`** になる。

`page.tsx` は許可リストの**中心**である（既存ページの見た目を変えるために必要）。
したがって「`route.ts` を拒否する」ことは、この能力を一切制限していない。

#### 再現手順（実測・エンドツーエンド）

```
$ node -e "import('./scripts/vibe-policy.mjs').then(m =>
    console.log(m.isWritablePath('app/(public)/vibeprobe/page.tsx')))"
true                                   ← ★許可リストが許している
```

`app/(public)/vibeprobe/page.tsx` に次を置いた:

```tsx
export const dynamic = 'force-dynamic'
export default function Probe() {
  return <pre>{JSON.stringify({ n: Object.keys(process.env).length, s: process.env.AUTH_SECRET })}</pre>
}
```

```
$ pnpm build          # CI と同じダミー env で実行
└ ƒ /vibeprobe                             151 B         102 kB     ← ルートとして登録された
$ node -e "...app-paths-manifest.json..."
/(public)/vibeprobe/page

$ AUTH_SECRET=REAL-SECRET-WOULD-BE-HERE-... pnpm start &
$ curl -s http://127.0.0.1:3199/vibeprobe
... REAL-SECRET-WOULD-BE-HERE-0000000000000 ...     ← ★本文に出た
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3199/vibeprobe
200                                                  ← ★未認証で 200
```

**`pnpm type-check` / `pnpm test:unit` / `pnpm build` はいずれもこれを止めない**
（`middleware.ts` の matcher は `/admin` のみ認可を掛ける。`/vibeprobe` は公開ページである）。

> プローブは削除済み。`git status --porcelain` が空であることを確認した。

#### 影響

- 本番デプロイ後、**認証不要の公開URL**から `AUTH_SECRET` / `FORM_SESSION_SECRET` / `CRON_SECRET` /
  `POSTGRES_PRISMA_URL` / KV・Blob トークンが読める。
  `AUTH_SECRET` があれば**管理者セッションを自分で発行できる**——この仕組みの前提そのものが崩れる。
- **層1（`canUseTool`）を突破する必要が無い。** 許可リストが正規に許している経路である。
- 同じことは**新規ファイルを作らなくても**できる。既存の `app/(public)/page.tsx` や
  `components/**` の任意のコンポーネントはサーバーコンポーネントであり、
  `process.env` を読んで公開 HTML に埋められる。
  **見た目を変える機能である以上、この書き込み権限は外せない**——だからこそ、
  パス許可リストとは別の層が要る。

#### 修正方針

1. **`app/` 配下の新規ファイル作成を禁止する。** 見た目の変更に新規ページは要らない。
   `check-protected-paths.mjs` で `git diff --cached --name-status` を使い、
   `app/` 配下の `A`（追加）を違反にする。ルート集合が変わらないことを保証できる。
2. **内容の検査を足す。** 許可された書き込み先に `process.env` が現れたら止める。
   これは「パスは正しいが、やっていることが範囲外」を捕まえる唯一の実効的な手段であり、
   SEC-090（環境条件付きバックドア）にも同時に効く。
   偽陽性は `lib/design-tokens.ts` / `components/**` には実質無い（現状 `process.env` の参照は0件）。
3. `verify` に「app ルート集合のスナップショット比較」を足す
   （`.next/server/app-paths-manifest.json` を既知の一覧と突き合わせる）。

> **記録: 私の当初の想定は誤りだった。**
> `pageExtensions` の既定が `["tsx","ts","jsx","js"]` で、`isAppRouteRoute` が
> `route.endsWith('/route')` だったことから、**`route.tsx` は API ルートになる**と予測し、
> `isWritablePath('app/(public)/x/route.tsx')` が `true` であることも実測した。
> しかし実ビルドで確かめたところ **`/vibeprobe` は現れず、`app-paths-manifest.json` にも載らなかった。**
> `route.tsx` は Next.js 15 ではルートハンドラとして採用されない。
> **`route.tsx` は指摘として立てない。** 立てるべきは `page.tsx` のほうである。

- **参考**: CWE-200 / OWASP A01:2021

---

### [SEC-099] 3つの検査がすべて、**patch を当てた後の木**から判定モジュールを読む（High）

- **重大度**: High
- **カテゴリ**: 完全性の検証 / TOCTOU の変種
- **場所**: `.github/workflows/vibe.yml:107-109`（agent）/ `:156-158`（verify）/ `:222-224`（push）

#### 説明

`verify` ジョブのコメントはこう書いている:

> ⚠️ **agent ジョブの検査を信用しない。** そのジョブではエージェントが動いていた。
> ここは patch だけを受け取ったクリーンな木なので、判定を独立にやり直せる。

**独立にやり直せていない。** 手順は

```
git apply --index --whitespace=nowarn /tmp/vibe.patch     ← 作業ツリーに patch を展開
node scripts/check-protected-paths.mjs HEAD               ← ★その木から scripts/ を読む
```

であり、`check-protected-paths.mjs` は `import { isWritablePath } from './vibe-policy.mjs'` する。
**patch が `scripts/vibe-policy.mjs` を含んでいれば、判定は patch が持ち込んだ実装で行われる。**

#### 再現手順（実測）

`vibe.yml` の agent → artifact → clean checkout → `git apply --index` → 再検査 を
使い捨て git リポジトリで再現した。patch の内容は
「`scripts/vibe-policy.mjs` を全許可に差し替え」＋「`auth.ts` を書き換え」:

```
### agent ジョブ側の検査（汚染されたワークスペース）
[protected] 変更されたファイル 2 件:
  ✓ auth.ts
  ✓ scripts/vibe-policy.mjs
[protected] すべて許可された範囲内の変更です。
exit=0                                                    ← ★通った

### verify / push ジョブ側の検査（クリーンな木に patch を当てた後）
[protected] 変更されたファイル 2 件:
  ✓ auth.ts
  ✓ scripts/vibe-policy.mjs
[protected] すべて許可された範囲内の変更です。
exit=0                                                    ← ★3回とも通った

### 適用後の auth.ts:
export const auth = "BYPASSED"
```

#### 影響

- **検査を3回に増やしたことが、防御の増加になっていない。** 3回とも同じ入力で同じ判断をする。
- 層1（`canUseTool`）は `scripts/` への書き込みを拒否するので、**現時点で patch に `scripts/` が
  入る経路は無い**（agent ジョブではエージェントのコードが実行されないため）。
  したがって**いま悪用できるわけではない。**
- しかし層2の存在意義は「層1が破れたときに捕まえること」である。
  層2が層1の健全性に依存しているなら、**二重防御ではなく一重防御**である。
  これは SEC-084 で一度支払った授業料と同じ形をしている。

#### 修正方針

**判定モジュールを patch の影響下から出す。** 例:

```yaml
- name: patch を当てて、もう一度検査する
  run: |
    # 判定は base の実装で行う（patch がルール自身を含んでいても効かないように）
    mkdir -p /tmp/policy
    git show "${{ needs.agent.outputs.base }}:scripts/check-protected-paths.mjs" > /tmp/policy/check-protected-paths.mjs
    git show "${{ needs.agent.outputs.base }}:scripts/vibe-policy.mjs"           > /tmp/policy/vibe-policy.mjs
    git apply --index --whitespace=nowarn /tmp/vibe.patch
    node /tmp/policy/check-protected-paths.mjs HEAD
```

`git show <base>:<path>` はインデックスにも作業ツリーにも触れないので、
patch が何を含んでいても pristine な判定が走る。
（`tests/unit/vibe-policy.test.ts` の `runCheck` が**すでにこの形**——スクリプトを被験リポジトリの外に置く——
になっている。テストのほうが正しく、ワークフローがそれに追いついていない。）

- **参考**: CWE-367（TOCTOU）の変種 / OWASP A08:2021

---

### [SEC-100] リネームされた保護ファイルが差分に現れず、検査を通る（High）

- **重大度**: High
- **カテゴリ**: 完全性の検証
- **場所**: `scripts/check-protected-paths.mjs:49`

#### 説明

`git diff` は**既定でリネーム検出が有効**である（`diff.renames` の既定値）。
リネームと判定された変更は、`--name-only` で**宛先パスだけ**が出力される。
`isWritablePath(宛先)` が true なら、**元ファイルが消えたことは差分に現れない。**

#### 再現手順（実測）

```
$ git mv middleware.ts components/dead.tsx && git add -A

$ git diff --cached --name-only <base>
components/dead.tsx                       ← ★ middleware.ts が出ない

$ node scripts/check-protected-paths.mjs <base>
[protected] 変更されたファイル 1 件:
  ✓ components/dead.tsx
[protected] すべて許可された範囲内の変更です。
exit=0                                    ← ★通った

$ test -f middleware.ts || echo 消えている
消えている
```

patch 側にはリネームとして記録される（`git apply` で確実に再現される）:

```
diff --git a/middleware.ts b/components/dead.tsx
similarity index 100%
rename from middleware.ts
rename to components/dead.tsx
```

**単純削除は正しく捕まる**ことも確認した（`rm middleware.ts` → exit 1）。
穴はリネーム検出に固有である。

#### 影響

`middleware.ts` / `auth.ts` / `lib/rate-limit.ts` / `tests/**` などを、
許可パスへリネームすることで**実質的に削除**できる。
`middleware.ts` が消えれば CSP の投入と `/admin` の Edge 認可が失われる
（`requireAdmin()` による多層防御は残るが、CSP は完全に消える）。

SEC-099 と同じく**層1の突破が前提**（エージェントはファイルを移動する手段を持たない）だが、
層2の網としては明確な穴である。

#### 修正方針（実測で有効性を確認済み）

`git diff` に **`--no-renames`** を足す。

```
$ git diff --cached --no-renames --name-only <base>
components/dead.tsx
middleware.ts                             ← ★両側が出る

$ git diff --cached --no-renames --name-status <base>
A  components/dead.tsx
D  middleware.ts
```

`--name-status` にすれば SEC-098 の「`app/` 配下の新規作成禁止」も同じ呼び出しで実装できる。
併せて `tests/unit/vibe-policy.test.ts` にリネームのケースを足すこと。

- **参考**: CWE-436（解釈の齟齬）/ OWASP A08:2021

---

### [SEC-101] `verify` が**信頼できないコードを実行しながら**、他ワークフローと Actions キャッシュを共有する（Medium）

- **重大度**: Medium
- **カテゴリ**: サプライチェーン / 分離
- **場所**: `.github/workflows/vibe.yml:160-165`（`cache: pnpm`）と `.github/workflows/ci.yml`（同じく `cache: pnpm` が5箇所）

#### 説明

3ジョブ分割は「攻撃者コードが動く場所」と「push できる場所」を正しく分けた。
しかし `verify` は依然として**エージェントが書いたコードを実行する唯一のジョブ**であり、
そこに `actions/setup-node` の `cache: pnpm` が付いている。

Actions のキャッシュは**リポジトリ単位の名前空間**であり、`ci.yml` の各ジョブも同じ仕組みを使う。
`verify` の中で実行されたコードは、pnpm ストアの内容をキャッシュ保存の対象に含めうる。
既存キーの上書きはできないが、`restore-keys` の前方一致で拾われる**新しいキー**を作ることはできる。

#### 影響

`verify` で動いた攻撃者コードが、**後続の `ci.yml` の実行**（あるいは次回の `verify`）に
汚染された依存関係を配れる可能性がある。`ci.yml` は master の品質ゲートなので、
そこが汚染されると「テストが通ったから安全」という判断の土台が崩れる。

**現時点で悪用の実例は示していない**（Actions 上での実行を伴っていないため）。
キャッシュキーは `pnpm-lock.yaml` のハッシュを含み、`pnpm-lock.yaml` は書き込み禁止なので、
**難易度は高い**。しかし「信頼できないコードを実行するジョブに、他ワークフローと共有する
書き込み可能な状態を持たせない」は原則として守るべきである。

#### 修正方針

1. `verify` の `actions/setup-node` から **`cache: pnpm` を外す**。
   毎回 install するコストは掛かるが、このジョブは**信頼できないコードを実行する唯一の場所**である。
2. あるいは `verify` を `restore` 専用にする（`actions/cache/restore` を使い保存しない）。
3. `agent` ジョブのキャッシュは残してよい（そこでは攻撃者コードが実行されない）。

- **参考**: OWASP A08:2021 / GitHub Actions のキャッシュ分離に関する既知の考慮事項

---

### [SEC-102] 検査はパス**名**しか見ておらず、symlink とモードを検査しない（Medium）

- **重大度**: Medium
- **カテゴリ**: 入力検証
- **場所**: `scripts/check-protected-paths.mjs:59`

#### 説明

`violations = changed.filter((file) => !isWritablePath(file))` は**ファイル名だけ**を見る。
patch が持ち込む**ファイル種別（モード）**は検査しない。

#### 再現手順（実測）

```
$ ln -s /etc/passwd components/evil.tsx && git add -A
$ node scripts/check-protected-paths.mjs <base>
  ✓ components/evil.tsx
[protected] すべて許可された範囲内の変更です。   ← 通る

$ git diff --cached --binary <base> | grep "new file"
new file mode 120000                             ← ★symlink

# clean checkout 側でも適用できる
$ git apply --index --whitespace=nowarn vibe.patch && ls -l components/evil.tsx
components/evil.tsx -> /etc/passwd
```

許可される拡張子を持つ symlink（`components/link.ts` → `../lib`）も同様に通る（実測）。

#### なぜ Critical ではないか

**2段階攻撃（symlink を置いた次の実行でリンク越しに書く）は git 自身が拒否する**ことを実測した:

```
$ git apply --index evil.patch
error: affected file 'components/link/auth-guard.ts' is beyond a symbolic link
適用拒否（git が止めた）
```

リポジトリ外を狙う patch も同様:

```
$ git apply --index out.patch
error: invalid path '../escape.txt'
```

（実測環境は git 2.52.0。ubuntu-latest の git も十分新しい。）
また層1では `resolveInRepo` が `fs.realpath` を通すため、
symlink 越しの書き込みは `canUseTool` の段階でも実パスで判定される。

**したがって現状は塞がっている。ただし塞いでいるのは git であって、このプロジェクトの検査ではない。**
git の挙動は設計の前提として明示されていない。

#### 修正方針

`--name-status` ではなく `git diff --cached --raw` を使い、**モードを見る**。
`120000`（symlink）と `160000`（gitlink / サブモジュール）を無条件に違反とする。
サブモジュールの追加は現状ノーチェックであり、これも塞げる。

---

### [SEC-103] `verify` が通した patch と `push` が当てる patch の**同一性が保証されていない**（Low）

- **重大度**: Low
- **カテゴリ**: 完全性
- **場所**: `.github/workflows/vibe.yml:148-151` / `:216-219`

#### 説明

両ジョブとも `actions/download-artifact@v4` で `name: vibe-patch` を取得するだけで、
**内容のハッシュ照合が無い**（ワークフロー全体を検索して `sha256` / `shasum` / `checksum` は0件。実測）。

同一性は次に依存している:

- `actions/upload-artifact@v4` は**同一 run 内で同名アーティファクトの重複アップロードを拒否**する
- `verify` の `permissions:` は `contents: read` のみ。`permissions:` ブロックを書くと
  明示しないスコープは `none` になるため、**`actions: write` を持たない**
  ＝ アーティファクトの削除・置換の API を呼べない

**したがって実際に差し替えられる見込みは低い。** しかし、この保証は
ワークフローのどこにも書かれておらず、`permissions:` を1行足すだけで崩れる種類のものである。

#### 修正方針

`agent` ジョブが patch の SHA-256 を**ジョブ出力**として公開し、`verify` と `push` の双方が
適用前に照合する。ジョブ出力は後続ジョブから改変できないので、これで同一性が明示的になる。

```yaml
# agent
- id: patch
  run: |
    ...
    echo "sha256=$(sha256sum /tmp/vibe.patch | cut -d' ' -f1)" >> "$GITHUB_OUTPUT"
# verify / push
- run: echo "${{ needs.agent.outputs.sha256 }}  /tmp/vibe.patch" | sha256sum -c -
```

---

### [SEC-104] `push` の実行条件が**暗黙の GitHub 仕様**に依存し、テストで固定されていない（Low）

- **重大度**: Low
- **カテゴリ**: 設定 / 回帰防止
- **場所**: `.github/workflows/vibe.yml:202-203`

#### 説明

`verify` は `if: needs.agent.outputs.changed == 'true'`、`push` は `needs: [agent, verify]` で **`if` 無し**。
変更が無いとき `verify` はスキップされ、**スキップされたジョブに `needs` する `push` もスキップされる**
——これは GitHub の仕様として正しく、現状の挙動は意図どおりである。

問題は次の2点:

1. **「`verify` を経ずに `push` に到達しない」という最重要の性質が、明示されていない。**
   将来 `if: always()` や `if: !cancelled()` を足す（失敗時も通知したい、等の理由で）と、
   **ゲートを飛ばして push する経路が静かに生まれる。**
2. `tests/unit/vibe-policy.test.ts` の §SEC-085 は `permissions` と
   「push ジョブがゲートを走らせないこと」は検証しているが、
   **`needs` の依存関係と `if` の不在は検証していない**（実測: `needs` / `always` への言及なし）。

#### 修正方針

テストに次を足す:

- `push` ジョブの `needs` に `verify` が含まれること
- `push` ジョブに `always()` / `!cancelled()` / `failure()` が**現れない**こと
- `contents: write` を持つジョブが1つだけであること（既にある）

---

## 未対応のまま継続している項目（状態変化なし）

| ID | 重大度 | 実測による現状 |
|----|--------|--------------|
| **SEC-090** ゲートは本番と区別可能な環境で走る | Medium | **未対応。ただし影響は縮小した。** 書き込み可能範囲が `components/**` / `app/(public)/**.tsx` / `lib/design-tokens.ts` / `app/globals.css` / `DESIGN.md` に狭まったため、`lib/password.ts` を使った**認証バイパス型**のバックドアは不可能になった。残るのは**サーバーコンポーネント経由の情報開示と改ざん**であり、これは SEC-098 と同じ根を持つ。SEC-098 の修正方針2（`process.env` の内容検査）が同時に効く |
| **SEC-092** dispatch に流量制御が無く `requireContentType` が漏れている | Medium | **未対応。** `app/api/admin/vibe/route.ts:50` は `withAdminMutation(...)` のみで、第2引数を渡していない（実測）。レート制限・`action` のホワイトリスト検証も無し |
| **SEC-093** `GITHUB_DISPATCH_TOKEN` のスコープ前提が未文書・未検証 | Low | **未対応。** `lib/env.ts` / `.env.example` のいずれにも登場しない（実測） |
| **SEC-094** `.env.example` が「本番では 404」と事実に反する記述を残す | Low | **未対応。** `.env.example:76` に該当記述が残存（実測） |
| **SEC-095** 未使用の `runner/` と `VIBE_RUNNER_SECRET` | Low | **未対応。** `runner/` は残存。本番コードからの参照は依然0件 |
| **SEC-097** コミットメッセージへの複数行注入 | Info | **未対応**（`vibe.yml:233`）。シェルインジェクションは無し（`env:` 経由の正しい形）である点も変わらず |

これらはいずれも**再開のブロッカーではない**（SEC-092 は `isSameOrigin` の fail-closed により
悪用できず、SEC-093/094/095 は文書と不要コードの問題）。ただし SEC-094 は
**セキュリティ判断の根拠になる記述が実装と逆のことを言っている**ので、早めに直すことを勧める。

---

## 依頼された観点への回答

### patch の受け渡しに穴はないか

| 攻撃形 | 実測結果 |
|--------|---------|
| patch がルール自身（`scripts/`）を含む | **通る → SEC-099** |
| 保護ファイルのリネーム | **通る → SEC-100** |
| 保護ファイルの単純削除 | 止まる |
| 許可パスへの symlink 作成 | **通る → SEC-102**（ただし2段階目は git が拒否） |
| symlink 越しの書き込み | `git apply` が拒否（`beyond a symbolic link`） |
| リポジトリ外への書き込み（`../escape.txt`） | `git apply` が拒否（`invalid path`） |
| モード変更（実行ビット等） | 検査対象外だが実害なし |
| `.gitattributes` の追加 | `isWritablePath` が **false**（塞がっている） |
| 巨大 patch | 上限なし。`timeout-minutes` と Actions のアーティファクト上限で頭打ち。**実害は見いだせなかった** |

### `verify` を通った patch と `push` が当てる patch は同一か

**明示的な保証は無い**（→ SEC-103）。実質的には `upload-artifact@v4` の重複拒否と
`verify` が `actions: write` を持たないことに依存している。ハッシュ照合を推奨。

### 許可リストは広すぎ／狭すぎないか

**狭さは適切。広さに1点の問題がある。**

- 狭すぎる兆候は見つからなかった。見た目の変更に必要な範囲——`components/**`、
  既存ページの `.tsx`、`lib/design-tokens.ts`、`app/globals.css`、`DESIGN.md`——は揃っている。
  読み取りは `app` / `components` / `lib` / `docs` / `tests` / `prisma` / `public` が可能で、
  文脈を掴むには十分である。
- **広すぎるのは `app/(public)/**/*.tsx` の「新規作成」を許している点**（SEC-098）。
  既存ファイルの変更だけに絞れば、能力を落とさずに穴が閉じる。
- `components/**` と `app/(public)/**` の `.tsx` が**サーバーコンポーネントとして実行される**点は、
  **パス許可リストでは原理的に扱えない**。「どのファイルを書けるか」は縛れても
  「そのファイルが実行時に何をするか」は縛れない。
  見た目を変える機能である以上この権限は外せないので、
  **内容の検査（`process.env` の禁止）という別の層**を足すのが唯一の実効的な手当てである。
  これは SEC-090 への回答でもある。

### 3ジョブ構成の `needs` / `if` に抜けはないか

**`verify` を飛ばして `push` に到達する経路は無い**（`push` は `needs: [agent, verify]` かつ `if` 無し。
スキップされたジョブに `needs` するジョブはスキップされる）。
ただしその性質はテストで固定されておらず、`if:` を1行足すだけで壊れる（→ SEC-104）。

---

## 注意事項

- 本監査も **GitHub Actions 上での実行を伴っていない**。ジョブ分割・権限・キャッシュに関する判定は
  ワークフロー定義の機械的解析と、GitHub の文書化された仕様に基づく。
  それ以外（判定関数、検査スクリプト、patch の受け渡し、公開ページの挙動）は**すべてローカルで実測**した。
- `scripts/vibe-agent.mjs` は**起動していない**。
- SEC-098 の検証で作成した `app/(public)/vibeprobe/` は**削除済み**。
  `git status --porcelain` が空であること、`app/(public)/` の内容が元どおりであることを確認した。
- **修正は行っていない。** 本レポートは記録までであり、実装は別レーンが行う。
- High が3件あるため、**ワークフローの再開はこれらの是正後とすること。**
