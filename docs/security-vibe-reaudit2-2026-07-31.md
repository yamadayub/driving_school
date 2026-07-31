# セキュリティ再監査レポート（3回目） — Vibe Coding

## 監査日: 2026-07-31
## 対象コミット: `f047f0b`（`0eb6f6c fix(vibe): 再監査の High 3件（SEC-098 / 099 / 100）を是正する` を含む）
## 前回: `docs/security-vibe-reaudit-2026-07-31.md`（対象 `8f90caf`）

| 項目 | 内容 |
|------|------|
| 変更範囲 | `vibe.yml` / `vibe-policy.mjs` / `check-protected-paths.mjs` / `vibe-agent.mjs` / `vibe-policy.test.ts`（`git diff --stat` 実測） |
| ベースライン | `pnpm type-check` **クリーン** / `pnpm test:unit` **63ファイル 980件 全パス** / `vibe-policy.test.ts` **23件 全パス**（実測） |

---

## サマリー

| ID | 前回 | 判定 | 一言 |
|----|------|------|------|
| **SEC-099** 検査が patch 適用後の木から判定モジュールを読む | High | **✅ クローズ** | A/B 実測。旧方式は差し替え patch を通し、現行方式は止める |
| **SEC-100** リネームで保護ファイルの削除が隠れる | High | **✅ クローズ** | `--no-renames` で `D middleware.ts` が現れ、違反として止まる（実測） |
| **SEC-098** 公開ページから本番の秘密が読める | High | **❌ 未クローズ** | 「新規URLを作る」経路は塞がった。しかし**既存ページを書き換える**経路が残っており、**エンドツーエンドで実証した**（下記） |

### 新規

- **Critical: 0件**
- **High: 3件**（SEC-098 継続 / SEC-105 / SEC-106）
- Medium: 0件
- Low: 1件（SEC-107）
- 未対応の継続項目: 8件（SEC-090 / 092 / 093 / 094 / 095 / 101 / 102 / 103 / 104 のうち状態変化なし）

### 再開の可否

> ## ❌ **再開不可。**

**未認証の第三者が本番の `AUTH_SECRET` を取得できる状態が残っている。**
`AUTH_SECRET` はセッション JWT の署名鍵なので、これを得た者は**管理者セッションを自分で発行できる**。
「管理者セッション = デプロイ権限」という受け入れ済みの前提は、**管理者セッションが奪われない**ことを
土台にしている。その土台が崩れる。

実証（すべて実測。§SEC-098 に全ログ）:

```
1. components/VibeLeakProbe.tsx を新規作成（getServerEnv() を描画するだけ）
2. app/(public)/privacy/page.tsx（既存ページ）に1行足して差し込む

   → 許可パス検査:  exit 0 「すべて許可された範囲内の変更です」
   → pnpm type-check: クリーン
   → pnpm test:unit:  63ファイル 980件 全パス
   → pnpm build:      Compiled successfully

3. 本番モードで起動して未認証 GET /privacy
   → HTTP 200
   → 応答本文: LEAKED-AUTH-SECRET-... / LEAKED-CRON-SECRET-... /
               LEAKED-FORM-SESSION-... / LEAKED-TURNSTILE-...
```

**4つのゲートすべてが緑のまま通る。** 止めたのは1つも無い。

前回の是正は正しい方向だったが、`isAddAllowed` は「**新しい URL を作らせない**」を実装しており、
実際の危険は「**公開URLで秘密を描画させない**」である。既存ページは書き換えられるので、
前者を塞いでも後者は残る。それを補うはずの `secretEnvRefs` に**6通り以上の迂回**がある（SEC-105）。

### 再開の条件

- [ ] **SEC-098 / 105 の根治**: 構文の一致ではなく**結果**を見る検査を `verify` に足す。
      ビルド後に公開ルートを実際に取得し、**応答本文に秘密の値が現れないこと**を検証する
      （本監査がやったのと同じこと。既存の Playwright を使える）。
      **これはすべての迂回形（`getServerEnv()`・分割代入・別名束縛・難読化）を一度に捕まえる。**
- [ ] 補助として、書き込み可能な集合からの **import 許可リスト**（`@/lib/env` と `node:process` を禁ずる）
- [ ] **SEC-106**: `staged()` / `original()` の `catch → null` をやめる。
      読めなかったことを「秘密なし」と解釈しない（`maxBuffer` を上げ、失敗は違反として扱う）

---

## 独立検証の実測

| プローブ | 結果 |
|---------|------|
| `secretEnvRefs` 12形 | **6形が素通り**（§SEC-105） |
| 検査スクリプトの対照実験（使い捨て git リポジトリ、実スクリプト起動） | 対照3件（素直な `process.env`／`app/` 新規／リネーム）は**すべて止まる**。攻撃2件は**通る** |
| **本物のリポジトリでのエンドツーエンド** | ビルド→起動→`curl` で**秘密4種を取得**（§SEC-098） |
| SEC-099 の A/B | 作業ツリー起動=**通る** / base 退避起動=**止まる**（§SEC-099） |
| 1MB 超のファイル | 秘密検査が**素通り**。同内容で 1MB 未満なら止まる（§SEC-106） |
| 特殊なパス名 | 非ASCII名は git の C クォートで**常に違反**＝ fail-closed（§SEC-107） |
| symlink / patch ハッシュ / verify のキャッシュ / push の `needs` テスト | **いずれも前回から変化なし** |

プローブで作成したファイルはすべて削除し、`git status --porcelain` が空であることを確認した。

---

## クローズを確認した項目

### SEC-099 — クローズ

`vibe.yml` が3ジョブとも `git show <base|HEAD>:scripts/...` で `/tmp/vibe-guard/` へ退避し、
**そこから起動する**（`agent` は L83-92 と L120、`verify` は L164-173 と L180、`push` は L243-252 と L257）。
退避は `git apply` より**前**のステップにあり、かつ `git show <commit>:` はコミットオブジェクトから
読むので、作業ツリーが汚れていても影響を受けない。**二重に正しい。**

A/B 実測（patch が `scripts/vibe-policy.mjs` を全許可版に差し替え、同時に `middleware.ts` を改竄）:

| 起動方法 | 実測 |
|---------|------|
| 旧方式: `node scripts/check-protected-paths.mjs`（作業ツリー） | `✓ M scripts/vibe-policy.mjs` → **「すべて許可された範囲内」＝通る** |
| 現行方式: `node /tmp/vibe-guard/check-protected-paths.mjs` | **違反として停止** |

**`/tmp/vibe-guard` への競合・上書きの余地は見当たらなかった:**

- 3つのジョブは**別々の runner VM** で走るので、ジョブ間の競合は原理的に無い
- `agent` ジョブ内でエージェントが `/tmp` を書く経路は無い。`resolveInRepo` が
  リポジトリ外を `null` にするため `canUseTool` が拒否する（前回実測済み）。
  かつ agent ジョブでは**エージェント作成コードが実行されない**（install / prisma はエージェントより前）
- `verify` ジョブではエージェントのコードが実行されるが、それは**検査が終わった後**のステップであり、
  その後 `/tmp/vibe-guard` は使われない
- `concurrency: group: vibe-coding` により同一ワークフローの並行実行も無い

### SEC-100 — クローズ

`check-protected-paths.mjs:65` が `['diff', '--cached', '--name-status', '--no-renames', base]`。
実測（`git mv middleware.ts components/dead.tsx`）:

```
[protected] 変更されたファイル 2 件:
  ✓ A components/dead.tsx
  ✗ D middleware.ts
[protected] 許可されていない変更です。push を中止します:
  - middleware.ts — 許可されていないパスです
  → exit=1
```

`--no-renames` を外すと `R100` 1行になって通ることは前回実測済み。テストにも固定されている。

### SEC-098 の「新規URL」部分 — クローズ

層1（`vibe-agent.mjs:149-155`、`isAddAllowed` + `fs.access` による存在確認）と
層2（`check-protected-paths.mjs:104-108`、`--name-status` の `A`）の両方で効いている。実測:

```
### app/ 配下の新規ページ
  ✗ A app/(public)/leak/page.tsx
  - app/(public)/leak/page.tsx — app/ 配下に新しいファイルは作れません（既存の変更のみ可）
  → exit=1
```

`isAddAllowed('app/(public)/x/page.tsx') === false` / `isAddAllowed('components/Leak.tsx') === true`（実測）。

---

## 発見事項

### [SEC-098] （継続・**未クローズ**）既存の公開ページから本番の秘密が読める（High）

- **重大度**: High
- **カテゴリ**: データ露出 / 認可
- **場所**: `scripts/vibe-policy.mjs:110-112`（`isAddAllowed`）/ `:121-130`（`secretEnvRefs`）

#### 説明

是正は「**`app/` 配下に新しいファイルを作らせない**」を実装した。これは
「新しい公開URLが生まれること」を防ぐ。しかし前回のレポートが指摘していた危険は

> 同じことは**新規ファイルを作らなくても**できる。既存の `app/(public)/page.tsx` や
> `components/**` の任意のコンポーネントはサーバーコンポーネントであり、
> `process.env` を読んで公開 HTML に埋められる。

であり、**既存ページの書き換えは許可されたままである**（見た目を変える機能なので当然である）。
これを補うはずの `secretEnvRefs` は**文字列一致**であり、迂回できる（→ SEC-105）。

#### 再現手順（本物のリポジトリでのエンドツーエンド実測）

**手順1** — 新規コンポーネント（`app/` 配下ではないので追加が許される）:

```tsx
// components/VibeLeakProbe.tsx
import { getServerEnv } from '@/lib/env'
export function VibeLeakProbe() {
  return <pre data-probe>{JSON.stringify(getServerEnv())}</pre>
}
```

**手順2** — 既存の公開ページに1行差し込む（`app/(public)/privacy/page.tsx`）:

```tsx
      <SectionHeading eyebrow="PRIVACY" title="プライバシーポリシー" as="h1" />
      <VibeLeakProbe />
```

**手順3** — 全ゲートを実行:

```
$ node scripts/check-protected-paths.mjs HEAD
[protected] 変更されたファイル 2 件:
  ✓ M app/(public)/privacy/page.tsx
  ✓ A components/VibeLeakProbe.tsx
[protected] すべて許可された範囲内の変更です。
exit=0                                       ← ★ 層2が通した

$ pnpm type-check
（エラーなし）                                 ← ★ 通った

$ pnpm test:unit
Test Files  63 passed (63)
Tests  980 passed (980)                      ← ★ 通った

$ pnpm build
✓ Compiled successfully in 6.2s              ← ★ 通った
```

**手順4** — 本番モードで起動し、未認証で取得:

```
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3199/privacy
HTTP 200

$ curl -s http://127.0.0.1:3199/privacy | grep -oE 'LEAKED-[A-Z-]+-[A-Za-z0-9]+' | sort -u
LEAKED-AUTH-SECRET-abcdefghijklmnop123
LEAKED-CRON-SECRET-qrstuvwx56789012
LEAKED-FORM-SESSION-xyz78901234567890
LEAKED-TURNSTILE-0011
```

（`AUTH_SECRET` 等には実測用の目印文字列を与えて起動した。本番では実値が同じ位置に出る。）

> プローブは削除済み。`git status --porcelain` が空であることを確認した。

層1についても実測: `isWritablePath('components/VibeLeakProbe.tsx') = true` /
`isAddAllowed('components/VibeLeakProbe.tsx') = true` /
`isWritablePath('app/(public)/privacy/page.tsx') = true`。
**`canUseTool` もこの2つの書き込みを許す。**

#### 影響

- `AUTH_SECRET` はセッション JWT の署名鍵である。取得した第三者は**任意の管理者セッションを発行できる**。
  この時点で「管理者セッション = デプロイ権限」という受け入れ済みの前提が意味を失う
  ——**攻撃者も管理者になれる**からである。
- `FORM_SESSION_SECRET` があればフォームセッション Cookie を量産でき（`lib/env.ts:16` が
  自ら警告している）、`CRON_SECRET` があれば保持期間削除バッチを起動できる。
- リポジトリは公開なので、この状態でデプロイされれば**誰でも**取得できる。

#### なぜ「受け入れ済みの前提」で片付けられないか

「管理者は元々任意のコードをデプロイできるのだから同じでは」という反論は成立しない:

1. 前提が保証しているのは「**管理者だけ**がデプロイできる」ことである。この欠陥は
   **管理者でない者が管理者になる**経路を作るので、前提の外側にある。
2. 発火の引金は管理者の明示的な意思ではなく、**自然言語の指示を LLM が解釈した結果**である。
   `docs/` や `CLAUDE.md` はエージェントが読める（`READ_ALLOWED`）ので、
   プロンプトインジェクションの経路も存在する。
3. UI は「認証・レート制限・データ構造・テストは変更できません」と約束している
   （`components/admin/VibeConsole.tsx`）。利用者はこの約束を信じる。

#### 修正方針

**構文ではなく結果を見ること。** これが唯一、迂回形を網羅できる方法である。

1. **（主）`verify` に「秘密が漏れていないか」の実測を足す。**
   ビルド後にサーバーを起動し、公開ルートを一通り取得して、
   **応答本文に秘密の env 値が含まれないこと**をアサートする。
   秘密は `verify` ジョブが与えるダミー値なので、探す文字列は既知である
   （`ci-dummy-...` を grep するだけでよい）。既存の Playwright E2E に相乗りできる。
   **本監査がやったのはまさにこれであり、10 行程度で実装できる。**
2. **（補）import の許可リスト。** 書き込み可能な集合（`components/**`・`app/(public)/**.tsx`）から
   `@/lib/env` / `node:process` / `process` への到達を禁ずる。
   `secretEnvRefs` の強化より遥かに堅い——**名前空間は文字列と違って偽装しにくい**。
3. `secretEnvRefs` は残してよいが、**これを主防御と見なさないこと**（SEC-105）。

- **参考**: CWE-200 / OWASP A01:2021

---

### [SEC-105] `secretEnvRefs` に6通り以上の迂回がある（High）

- **重大度**: High
- **カテゴリ**: 入力検証 / 検出の不備
- **場所**: `scripts/vibe-policy.mjs:121-130`

#### 説明

検出は次の2つの正規表現だけである。

```js
/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g
/process\.env\s*\[/
```

**ソースコードの意味ではなく字面を見ている。** JavaScript には同じ値へ到達する書き方が多数ある。

#### 再現手順（実測）

| ソース断片 | 検出 | 備考 |
|-----------|------|------|
| `process.env.AUTH_SECRET` | AUTH_SECRET | 素直な形 |
| `globalThis.process.env.AUTH_SECRET` | AUTH_SECRET | 部分一致で拾える |
| `process.env["AUTH_SECRET"]` | `<動的アクセス>` | 拾える |
| `` process.env[`AUTH_SECRET`] `` | `<動的アクセス>` | 拾える |
| **`const { AUTH_SECRET } = process.env`** | **（なし）** | ★**分割代入。最も自然な書き方** |
| **`const e = process.env; e.AUTH_SECRET`** | **（なし）** | ★別名束縛 |
| **`const p = process; p.env.AUTH_SECRET`** | **（なし）** | ★別名束縛 |
| **`process["env"].AUTH_SECRET`** | **（なし）** | ★`env` を文字列添字で |
| **`process["e"+"nv"].AUTH_SECRET`** | **（なし）** | ★文字列連結 |
| **`getServerEnv().AUTH_SECRET`** | **（なし）** | ★**このプロジェクト自身のアクセサ。`process.env` が1文字も出ない** |
| `process.env .AUTH_SECRET` | （なし） | ドット前の空白 |
| `process.env.NEXT_PUBLIC_SITE_URL` | （なし） | 意図どおり除外 |

**特に重要な2つ:**

- **分割代入は迂回ですらない。** `const { AUTH_SECRET } = process.env` は
  攻撃者でなくとも書く、ごく普通の JavaScript である。
  エージェントがこの形を選んだだけで検査は素通りする。
- **`getServerEnv()` はこのリポジトリの正規のアクセサ**である（`lib/env.ts:225`）。
  エージェントは `lib/` を読めるので（`READ_ALLOWED`）、この関数の存在を知りうる。
  `process.env` を一切書かずに全秘密へ到達できる。

#### 影響

SEC-098 の唯一の緩和策が、実質的に機能しない。
`isAddAllowed` は「新規URL」しか塞がないので、**両者を合わせても既存ページ経由の漏えいは残る。**

#### 修正方針

SEC-098 の修正方針1（結果の実測）を主防御にすること。
`secretEnvRefs` を強化して追いかけるのは**避けたほうがよい**——
「知っている書き方だけ止める」拒否リストであり、このプロジェクトが
SEC-087 / 088 / 089 で一度捨てた方式そのものである。

補助として入れるなら、`process` / `env` という**識別子の出現そのもの**を
書き込み可能な集合で禁ずる（見た目を変えるコードに `process` は要らない）ほうが、
名前の列挙より堅い。

---

### [SEC-106] 1MB を超えるファイルで秘密検査が **fail-open** する（High）

- **重大度**: High
- **カテゴリ**: エラー処理 / 検出の不備
- **場所**: `scripts/check-protected-paths.mjs:81-96`

#### 説明

```js
const staged = (file) => {
  try {
    return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' })
  } catch {
    return null            // ★ 読めなかった = 秘密なし として扱われる
  }
}
```

`execFileSync` の `maxBuffer` の既定は **1 MiB**（1048576 バイト）である。
これを超える出力は `ENOBUFS` で**例外**になる。catch は理由を区別せず `null` を返し、
呼び出し側は `secretEnvRefs(staged(file) ?? '')` で**空集合**として扱う。

**読めなかったことが「問題なし」と解釈される。** 安全側は逆である。

#### 再現手順（実測）

同一の内容（`process.env.AUTH_SECRET` を含む）を、サイズだけ変えて 2 回:

| ファイルサイズ | 実測 |
|--------------|------|
| 1,200,079 バイト | `✓ A components/Big.tsx` → **「すべて許可された範囲内の変更です」＝通る** |
| 100,079 バイト | **違反として停止**（`秘密の参照が増えています: AUTH_SECRET`） |

パディングは JS のテンプレートリテラルなので、型チェックもビルドも通る。

（実測環境は Node v20.19.6。CI は `node-version: 22` だが、
`maxBuffer` の既定 1 MiB は Node 12 以降変わっていない。）

#### 影響

秘密検査を**サイズだけで**無効化できる。SEC-105 の迂回形を一切使わなくてよい。
`isWritablePath` / `isAddAllowed` は正常に働くので、
「許可された場所に、大きなファイルで、素直に `process.env.X` を書く」だけで通る。

#### 修正方針

1. `catch` を廃し、**読めなかったら違反にする**（fail-closed）。
2. `maxBuffer` を明示的に十分大きくする（例 64 MiB）。
   併せて `git cat-file -s` でサイズを先に見て、極端に大きいものは別途拒否する。
3. `encoding: 'utf8'` はバイナリを壊すが、判定には影響しない
   （壊れた文字列に `process.env.X` は現れないため）。
   ただし**バイナリを許可パスに置けること自体**は別途検討の余地がある。

- **参考**: CWE-755（例外条件の不適切な処理）

---

### [SEC-107] git のパスクォートにより非ASCII名が常に違反になる（Low / fail-closed）

- **重大度**: Low
- **カテゴリ**: 可用性 / 実装の頑健性
- **場所**: `scripts/check-protected-paths.mjs:71-74`

#### 説明

`core.quotePath` の既定は `true` で、非ASCII を含むパスは C 形式でクォートされて出力される。
パーサはこれを解釈しないため、クォート済み文字列がそのまま `isWritablePath` に渡る。

#### 再現手順（実測）

```
$ git diff --cached --name-status --no-renames <base>
A	components/sp ace.tsx
A	"components/\346\227\245\346\234\254\350\252\236\343\203\206\343\202\271\343\203\210.tsx"

$ node check-protected-paths.mjs <base>
  ✓ A components/sp ace.tsx
  ✗ A "components/\346\227\245\346\234\254\350\252\236\343\203\206\343\202\271\343\203\210.tsx"
  - "components/..." — 許可されていないパスです
  → exit=1
```

**方向は安全側**である（クォートされた名前は先頭が `"` なので許可リストに絶対一致しない）。
迂回に使える余地は見当たらなかった。空白を含む名前は正しく扱われる。

影響は「日本語名のコンポーネントを Vibe から変更できない」という**可用性の制限**にとどまる。

#### 修正方針

`-z`（NUL 区切り）を使えばクォートも区切り問題も同時に消える:

```js
execFileSync('git', ['diff', '--cached', '--name-status', '--no-renames', '-z', base])
```

`-z` は `status\0path\0` の並びになるので、パース側の調整が要る。
急がないが、直すならこの形が正しい。

---

## 依頼された観点への回答

### `secretEnvRefs` の抜けで秘密の持ち出しが依然可能か

**可能。** 6形以上（§SEC-105）。うち2つは難読化ですらない
——分割代入と、このプロジェクト自身の `getServerEnv()`。
さらにサイズによる fail-open（§SEC-106）もあり、迂回形を使わずとも通せる。

### `isAddAllowed` の抜け

- **`app/` 以外に置いたサーバーコンポーネントが既存ページから import される経路**: **成立する。**
  §SEC-098 で実証した。`components/` への新規追加は許され、
  既存の `app/(public)/**` は変更が許されるので、両者を組み合わせれば新規URLは要らない。
- **既存ページ自体の全面書き換え**: 可能。これは機能の目的上避けられない。
- **削除**: `status === 'D'` は無条件に `continue` するため、`app/(public)/page.tsx` の**削除**は通る。
  ビルドは成功し、トップページが消える（可用性のみ。Low 相当だが指摘としては立てない
  ——`--no-renames` により「削除して別名で作り直す」は追加側が `A` として捕まるため、
  防御の迂回には使えない）。

### `/tmp/vibe-guard` の競合・上書き

**見当たらなかった。** ジョブごとに別 VM、退避は `git apply` より前、
`git show <commit>:` はコミットオブジェクトから読むので作業ツリーの汚染を受けない、
エージェントは `/tmp` に到達できない、`concurrency` で並行実行も無い。§SEC-099 に詳述。

### `git show :<file>` / `git show <base>:<file>` の誤動作

- **バイナリ**: `encoding: 'utf8'` で壊れるが例外にはならず、判定にも影響しない。
- **特殊なパス名**: 非ASCII は fail-closed（§SEC-107）。空白は正常。
- **サイズ**: **これが問題。** 1 MiB 超で例外 → `catch` → `null` → 秘密なし扱い（§SEC-106）。
- **`:<file>` の曖昧性**: `git show :path` はインデックスを指す正しい記法。
  ファイル名が `:` や `../` を含む場合も、そもそも `isWritablePath` を通らないので到達しない。

---

## 継続項目の現状（今回の変更で状態は変わっていない）

`git diff 8f90caf..HEAD --stat` の実測より、今回の変更は
`vibe.yml` / `check-protected-paths.mjs` / `vibe-agent.mjs` / `vibe-policy.mjs` /
`vibe-policy.test.ts` / `docs/` に限られる。以下はいずれも**未対応のまま**である。

| ID | 重大度 | 現状（実測） |
|----|--------|------------|
| **SEC-090** ゲートは本番と区別可能な環境で走る | Medium | 未対応。`secretEnvRefs` が部分的に効くようになったが、SEC-105 の迂回形はそのまま環境条件付きバックドアにも使える。**SEC-098 の修正方針1（結果の実測）がここにも効く** |
| **SEC-092** dispatch に流量制御が無く `requireContentType` が漏れ | Medium | 未対応（`app/api/admin/vibe/route.ts` は今回の差分に含まれない） |
| **SEC-093** `GITHUB_DISPATCH_TOKEN` が未文書・未検証 | Low | 未対応 |
| **SEC-094** `.env.example` の「本番では 404」が虚偽 | Low | 未対応 |
| **SEC-095** 未使用の `runner/` | Low | 未対応 |
| **SEC-101** `verify` が untrusted コード実行下でキャッシュを共有 | Medium | 未対応。`verify` に `cache: pnpm` が残る（実測） |
| **SEC-102** symlink / モードを検査しない | Medium | 未対応。`components/evil.tsx → /etc/passwd` は `✓` で通る（実測、`new file mode 120000`）。2段階目を止めるのは依然 git 自身 |
| **SEC-103** patch のハッシュ照合が無い | Low | 未対応。`sha256`/`shasum`/`checksum` の出現 **0件**（実測） |
| **SEC-104** `push` の `needs`/`if` がテストで固定されていない | Low | 未対応。`vibe-policy.test.ts` に `needs`/`always`/`cancelled` の言及なし（実測） |

---

## 評価すべき点（記録）

批判だけでは判断を誤らせるので、良くなった点も明記する。

- **SEC-099 の直し方が正しい。** `git show <commit>:` を使い、退避を `git apply` の前に置き、
  かつコミットオブジェクトから読む——**2つの理由のどちらか一方でも十分**な形になっている。
- **SEC-100 の直しに実測の裏づけがある。** `--no-renames` を外すと落ちるテストが入っている。
- **`secretEnvRefs` を「一律禁止」にしなかった判断は正しい。**
  `app/(public)/apply/page.tsx` の正当な `FORM_SESSION_SECRET` 参照を壊さないために
  「base から増えた分だけ」を見ている。方向性は妥当で、**弱いのは検出方法だけ**である。
- **テストが 14 → 23 件に増え、各修正を個別に戻すと落ちることが確認されている。**
  この習慣が SEC-084 の再発を防いでいる。

**残っているのは「検査の置き場所」ではなく「検査の中身」の問題である。**
構造（3ジョブ・退避・許可リスト・`--cached --no-renames`）はもう正しい。
最後に足りないのは、**字面ではなく結果を見る一段**だけである。

---

## 注意事項

- 本監査も **GitHub Actions 上での実行を伴っていない**。ワークフローに関する判定は定義の静的解析による。
  それ以外（判定関数、検査スクリプト、ビルド、起動、HTTP 応答）は**すべてローカルで実測**した。
- `scripts/vibe-agent.mjs` は起動していない。
- SEC-098 の検証で作成した `components/VibeLeakProbe.tsx` と
  `app/(public)/privacy/page.tsx` への変更は**削除・復元済み**。`git status --porcelain` が空。
- **修正は行っていない。**
- High が3件（うち1件は実証済みの秘密漏えい）あるため、**ワークフローは停止したままとすること。**
