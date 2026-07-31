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
import { isWritablePath, WRITE_ALLOWED_DESCRIPTION } from './vibe-policy.mjs'

const base = process.argv[2]
if (!base) {
  console.error('使い方: node scripts/check-protected-paths.mjs <比較元のコミット>')
  console.error('※ 呼ぶ前に `git add -A` しておくこと（インデックスと比較する）。')
  process.exit(2)
}

// ⚠️ `--cached` を外すと新規ファイルを見逃す。`..HEAD` にすると常に空になる（SEC-084）。
const changed = execFileSync('git', ['diff', '--cached', '--name-only', base], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

if (changed.length === 0) {
  console.log('[protected] 変更がありません。')
  process.exit(0)
}

const violations = changed.filter((file) => !isWritablePath(file))

console.log(`[protected] 変更されたファイル ${changed.length} 件:`)
for (const file of changed) console.log(`  ${violations.includes(file) ? '✗' : '✓'} ${file}`)

if (violations.length > 0) {
  console.error('')
  console.error('[protected] 許可されていないパスが変更されました。push を中止します:')
  for (const file of violations) console.error(`  - ${file}`)
  console.error('')
  console.error(`変更してよいのは ${WRITE_ALLOWED_DESCRIPTION} だけです。`)
  console.error('認証・レート制限・テスト・ワークフロー自身などは、この仕組みの前提を支えます。')
  console.error('変更が必要なら人間が直接行ってください。')
  process.exit(1)
}

console.log('[protected] すべて許可された範囲内の変更です。')
