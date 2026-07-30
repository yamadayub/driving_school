/**
 * Vibe Coding が変更してはならないパスに差分が無いかを検査する。
 *
 * -----------------------------------------------------------------------------
 * なぜプロンプトではなく検査で守るのか
 * -----------------------------------------------------------------------------
 * このプロジェクトは「名指しの警告コメントでは 4 度止められなかった」（SEC-043）と自ら結論し、
 * **型や検査による強制**へ移行した経緯がある。エージェントへの「認証に触らないでください」は
 * 指示であって強制ではない。指示が守られたかを**差分で確認**し、破られていたら push しない。
 *
 * -----------------------------------------------------------------------------
 * なぜ tests/ を保護するのか（最重要）
 * -----------------------------------------------------------------------------
 * ワークフローは push の前に `type-check` / `unit` / `build` を通す。
 * **tests/ を変更可能にすると、ゲートを通す最も簡単な方法が「テストを弱めること」になる。**
 * 防御を測っているテストが書き換われば、ゲートは通るが防御は消える——
 * このプロジェクトが繰り返し警戒してきた「空振りするテスト」そのものが自動生成される。
 *
 * -----------------------------------------------------------------------------
 * .github/ と scripts/ を保護する理由
 * -----------------------------------------------------------------------------
 * ワークフロー定義とこの検査スクリプト自身。**ルールに従う側がルールを書き換えられないこと**が
 * この設計の土台である。GitHub 側でも PAT に `workflows: write` を与えないことで二重に塞ぐ。
 */

import { execFileSync } from 'node:child_process'

/** 変更を禁止するパス。前方一致（ディレクトリ）または完全一致（ファイル）。 */
const PROTECTED = [
  // 認証・認可
  'auth.ts',
  'auth.config.ts',
  'middleware.ts',
  'app/api/admin/_guard.ts',
  // 起動時検証と公開エンドポイントのラッパ
  'lib/env.ts',
  'lib/public-guard.ts',
  'lib/http-guard.ts',
  'lib/seed-guard.ts',
  'lib/cron-auth.ts',
  // レート制限の中核（P2.5〜P3-c1 で固めた部分）
  'lib/form-session.ts',
  'lib/form-session-issue.ts',
  'lib/rate-limit.ts',
  'lib/semaphore.ts',
  'lib/runtime-stores.ts',
  // データモデル
  'prisma/',
  // ルール自身
  '.github/',
  'scripts/',
  // ゲートを弱める経路
  'tests/',
  // 依存関係（サプライチェーン）
  'package.json',
  'pnpm-lock.yaml',
]

const base = process.argv[2]
if (!base) {
  console.error('使い方: node scripts/check-protected-paths.mjs <比較元のコミット>')
  process.exit(2)
}

const changed = execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

if (changed.length === 0) {
  console.log('[protected] 変更がありません。')
  process.exit(0)
}

const violations = changed.filter((file) =>
  PROTECTED.some((rule) => (rule.endsWith('/') ? file.startsWith(rule) : file === rule)),
)

console.log(`[protected] 変更されたファイル ${changed.length} 件:`)
for (const file of changed) console.log(`  ${violations.includes(file) ? '✗' : '✓'} ${file}`)

if (violations.length > 0) {
  console.error('')
  console.error('[protected] 保護されたパスが変更されました。push を中止します:')
  for (const file of violations) console.error(`  - ${file}`)
  console.error('')
  console.error('これらは認証・レート制限・テスト・ワークフロー自身など、')
  console.error('この仕組みの前提を支えるファイルです。変更が必要なら人間が直接行ってください。')
  process.exit(1)
}

console.log('[protected] 保護パスへの変更はありません。')
