/**
 * Vibe Coding の変更が**許可された範囲に収まっているか**を検査する。
 *
 * -----------------------------------------------------------------------------
 * なぜプロンプトではなく検査で守るのか
 * -----------------------------------------------------------------------------
 * このプロジェクトは「名指しの警告コメントでは 4 度止められなかった」（SEC-043）と自ら結論し、
 * **型や検査による強制**へ移行した経緯がある。エージェントへの「認証に触らないでください」は
 * 指示であって強制ではない。指示が守られたかを**差分で確認**し、破られていたら push しない。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ この検査は一度、**構造的に一度も発火しなかった**（SEC-084）
 * -----------------------------------------------------------------------------
 * 以前は `git diff --name-only <base>..HEAD` を使っていた。これは**コミット間**の比較である。
 * ところがワークフローがこれを呼ぶ時点で、エージェントの変更は**まだコミットされていない**
 * （commit は最後の push ステップで行う）。つまり `HEAD === base` であり、**差分は常に空**。
 * 「最後の砦」と書いた層が、最初から存在していなかった。
 *
 * いま使う `git diff --cached --name-only <base>` は**インデックス**と比較する。
 * 呼ぶ側が先に `git add -A` すること。**`--cached` を外してはならない**理由:
 *
 *   | 方式                                   | 新規ファイルを検出できるか |
 *   |----------------------------------------|--------------------------|
 *   | `git diff --name-only <base>`（未ステージ） | **できない**（未追跡は diff に出ない） |
 *   | `git add -A` → `git diff --cached ...`   | できる                    |
 *
 * **新規ファイルこそ本命の攻撃形**である（`scripts/` に新しいスクリプトを置く、
 * `tests/` に緩いテストを足す、`app/api/**\/route.ts` を作る）。
 * `tests/unit/vibe-policy.test.ts` がこの引数の形を固定している。
 *
 * -----------------------------------------------------------------------------
 * 許可リストで判定する（SEC-088 / SEC-089）
 * -----------------------------------------------------------------------------
 * 判定は `scripts/vibe-policy.mjs` に一本化した。以前はこのファイルと `vibe-agent.mjs` が
 * **同じリストを別々に持ち**、「同じ内容を保つこと」というコメントで整合を祈っていた（SEC-091）。
 */

import { execFileSync } from 'node:child_process'
import {
  addedSecretReaching,
  isAddAllowed,
  isWritablePath,
  secretEnvRefs,
  WRITE_ALLOWED_DESCRIPTION,
} from './vibe-policy.mjs'

/** 64 MiB。既定の 1MB では大きなファイルで読み取りが失敗し、以前は素通りしていた（SEC-106）。 */
const MAX_BUFFER = 64 * 1024 * 1024

const base = process.argv[2]
if (!base) {
  console.error('使い方: node scripts/check-protected-paths.mjs <比較元のコミット>')
  console.error('※ 呼ぶ前に `git add -A` しておくこと（インデックスと比較する）。')
  process.exit(2)
}

/**
 * ⚠️ 引数はどれも外せない。
 *  - `--cached`      : 外すと新規ファイルを見逃す（未追跡は diff に出ない）
 *  - `<base>` のみ   : `..HEAD` にすると常に空になる（SEC-084）
 *  - `--no-renames`  : **外すと保護ファイルのリネームが宛先側しか出ない**（SEC-100）。
 *                      `middleware.ts` → `components/dead.tsx` が `R100` 1 行になり、
 *                      「許可された `components/` への変更」に見えて検査を通る。
 *                      実測: 既定は `R100 middleware.ts components/dead.tsx`、
 *                      `--no-renames` なら `A components/dead.tsx` + `D middleware.ts`。
 */
const entries = execFileSync(
  'git',
  ['diff', '--cached', '--name-status', '--no-renames', '-z', base],
  { encoding: 'utf8', maxBuffer: MAX_BUFFER },
)
  // ⚠️ `-z` を使う（SEC-107）。既定の出力は非ASCII名を `"components/\346\227\245..."` と
  // クォートするので、そのまま判定に回すと**正当な日本語ファイル名が常に違反になる**。
  // `-z` なら NUL 区切りで生のパスが出る。形式は `status\0path\0` の繰り返し。
  .split('\0')
  .filter((token) => token.length > 0)
  .reduce((acc, token, index, all) => {
    if (index % 2 === 0) acc.push({ status: token[0], file: all[index + 1] ?? '' })
    return acc
  }, [])

if (entries.length === 0) {
  console.log('[protected] 変更がありません。')
  process.exit(0)
}

/**
 * git の内容を読む。**読めなかったら例外を投げる**（SEC-106）。
 *
 * 以前は `catch { return null }` で握りつぶしており、1MB を超えるファイルで
 * `maxBuffer` 超過が起きると**秘密検査を素通り**した（fail-open）。
 * 検査できないことは「安全」ではない。
 */
const show = (rev) =>
  execFileSync('git', ['show', rev], { encoding: 'utf8', maxBuffer: MAX_BUFFER })

const violations = []
for (const { status, file } of entries) {
  if (!isWritablePath(file)) {
    violations.push({ file, why: '許可されていないパスです' })
    continue
  }
  if (status === 'A' && !isAddAllowed(file)) {
    // SEC-098: app/ 配下の新規ファイルは新しい公開URLになる。
    violations.push({ file, why: 'app/ 配下に新しいファイルは作れません（既存の変更のみ可）' })
    continue
  }
  if (status === 'D') continue

  // SEC-098 / SEC-105: **増えた**分だけを違反とする（既存の正当な利用は落とさない）。
  // ⚠️ ここは主防御ではない。主防御は verify ジョブの実測（scripts/check-secret-leak.mjs）。
  let before = ''
  let after = ''
  try {
    after = show(`:${file}`)
    if (status !== 'A') before = show(`${base}:${file}`)
  } catch (error) {
    violations.push({ file, why: `内容を検査できませんでした: ${(error && error.message) || error}` })
    continue
  }
  const addedEnv = [...secretEnvRefs(after)].filter((name) => !secretEnvRefs(before).has(name))
  const addedReach = addedSecretReaching(before, after)
  if (addedEnv.length > 0 || addedReach.length > 0) {
    violations.push({
      file,
      why: `秘密に到達しうる記述が増えています: ${[...addedEnv, ...addedReach].join(', ')}`,
    })
  }
}

console.log(`[protected] 変更されたファイル ${entries.length} 件:`)
const bad = new Set(violations.map((v) => v.file))
for (const { status, file } of entries) {
  console.log(`  ${bad.has(file) ? '✗' : '✓'} ${status} ${file}`)
}

if (violations.length > 0) {
  console.error('')
  console.error('[protected] 許可されていない変更です。push を中止します:')
  for (const { file, why } of violations) console.error(`  - ${file} — ${why}`)
  console.error('')
  console.error(`変更してよいのは ${WRITE_ALLOWED_DESCRIPTION} だけです。`)
  console.error('認証・レート制限・テスト・ワークフロー自身などは、この仕組みの前提を支えます。')
  console.error('変更が必要なら人間が直接行ってください。')
  process.exit(1)
}

console.log('[protected] すべて許可された範囲内の変更です。')
