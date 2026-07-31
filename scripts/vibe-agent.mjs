/**
 * Vibe Coding — CI（GitHub Actions）で走るエージェント本体。
 *
 * -----------------------------------------------------------------------------
 * なぜ公式の claude-code-action を使わないのか
 * -----------------------------------------------------------------------------
 * `anthropics/claude-code-action` には **commit / push を抑止する入力が無い**（action.yml 確認済み）。
 * このワークフローの肝は「**変更してから、保護パス検査とテストを通し、通ったときだけ push する**」
 * ことなので、アクションが先に push してしまうとゲートが後追いになり意味を失う。
 * したがって Agent SDK を直接呼び、コミットと push はワークフロー側で制御する。
 *
 * Agent SDK は `runner/server.mjs` で実挙動を確認済み:
 *  - `canUseTool` は `(toolName, input, options)` の 3 引数
 *  - 戻り値は boolean ではなく `{ behavior: 'allow' | 'deny' }`
 * 公開ドキュメントの記載とは異なっていたため、**実測に合わせてある**。
 *
 * -----------------------------------------------------------------------------
 * 二重の防御
 * -----------------------------------------------------------------------------
 * 1. ここ（`canUseTool`）で保護パスへの書き込みを拒否する
 * 2. それでも何かが書かれた場合に備え、ワークフローが `check-protected-paths.mjs` で
 *    **差分を検査してから push する**
 *
 * 1 だけでは不十分である。エージェントは Bash を持たないが、
 * ツールの入力形が想定と違えば 1 は素通りしうる（実際に一度そうなった）。
 * **書けたかどうかを結果で確かめる 2 が最後の砦。**
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  isReadablePath,
  isSafeGlobPattern,
  isWritablePath,
  WRITE_ALLOWED_DESCRIPTION,
} from './vibe-policy.mjs'

const REPO = process.cwd()
const INSTRUCTION = process.env.VIBE_INSTRUCTION ?? ''

if (!INSTRUCTION.trim()) {
  console.error('[vibe] VIBE_INSTRUCTION が空です。')
  process.exit(2)
}

/** リポジトリ内の相対パスへ正規化する。外へ出るものは null。 */
async function resolveInRepo(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  const abs = path.resolve(REPO, rawPath)
  let resolved = abs
  const rest = []
  for (let cursor = abs; ; ) {
    try {
      resolved = path.join(await fs.realpath(cursor), ...rest)
      break
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) return null
      rest.unshift(path.basename(cursor))
      cursor = parent
    }
  }
  const rel = path.relative(REPO, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

const touched = new Set()
let denied = 0

const q = query({
  prompt: [
    '以下の指示に従って、このリポジトリを変更してください。',
    '',
    `指示: ${INSTRUCTION}`,
    '',
    '守ること:',
    `- 変更してよいのは ${WRITE_ALLOWED_DESCRIPTION} だけです。それ以外は書き込みが拒否され、`,
    '  仮に変更されても push 前の検査で中止されます。',
    '- data-testid 属性とフォームのラベル文言は変更しないでください（E2E が参照しています）。',
    '- 型チェックと単体テストが通る状態にしてください。通らないと push されません。',
    '- 色・余白・角丸・影を変えるときは lib/design-tokens.ts を編集してください',
    '  （tailwind.config.ts はそこから導出しているので、値を二重に持ちません）。',
    '- ファイルを探すときは Glob / Grep に必ず path を指定してください。',
    '  リポジトリルート（"." や "")は起点にできません。app / components / lib などを指定してください。',
    '',
    '変更が完了したら、何をどう変えたかを簡潔に説明してください。',
  ].join('\n'),
  options: {
    cwd: REPO,
    model: 'claude-opus-5',
    permissionMode: 'default',
    maxTurns: 60,
    canUseTool: async (name, input) => {
      const allow = { behavior: 'allow', updatedInput: input }
      const deny = (message) => ({ behavior: 'deny', message })
      const target = input?.file_path ?? input?.path

      if (READ_TOOLS.has(name)) {
        if (target === undefined) {
          denied += 1
          return deny('パスを指定してください（検査できない読み取りは許可しません）。')
        }
        // ⚠️ **`glob` も検査する。** 起点だけ縛ってもパターン側で抜けられては意味がない（SEC-087）。
        if (!isSafeGlobPattern(input?.glob) || !isSafeGlobPattern(input?.pattern)) {
          denied += 1
          return deny('このパターンは使用できません。')
        }
        const unix = await resolveInRepo(target)
        if (unix === null || !isReadablePath(unix)) {
          denied += 1
          return deny('このパスは読み取れません（リポジトリルート起点の探索も含みます）。')
        }
        return allow
      }

      if (!WRITE_TOOLS.has(name)) {
        denied += 1
        return deny(`${name} は使用できません。`)
      }

      const unix = await resolveInRepo(target)
      if (unix === null) {
        denied += 1
        return deny('リポジトリ外は変更できません。')
      }
      if (!isWritablePath(unix)) {
        denied += 1
        return deny(
          `${unix} は変更できません。変更してよいのは ${WRITE_ALLOWED_DESCRIPTION} だけです。`,
        )
      }
      touched.add(unix)
      return allow
    },
  },
})

for await (const message of q) {
  if (message.type === 'text' && message.text) console.log(message.text)
  else if (message.type === 'tool_use') console.log(`[tool] ${message.name}`)
}

console.log('')
console.log(`[vibe] 変更したファイル: ${touched.size} 件 / 拒否したツール呼び出し: ${denied} 件`)
for (const file of touched) console.log(`  - ${file}`)
