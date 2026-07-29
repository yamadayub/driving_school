/**
 * Vibe Coding ローカルランナー（軽量レーン限定）
 * =============================================================================
 *
 * 管理画面から受け取った日本語の指示で、Claude Agent SDK にコードを変更させる。
 * **このプロセスは本番にデプロイしない。** Vercel のサーバーレス関数は読み取り専用 FS・
 * 実行時間制限・状態非永続なので、ファイル書き換えと git 操作を伴う本処理は原理的に載らない。
 *
 * -----------------------------------------------------------------------------
 * 設計上の前提（変更するときはここを読むこと）
 * -----------------------------------------------------------------------------
 * 1. **管理画面から任意のコード変更を実行できる = 設計上の RCE である。** 以下は必須:
 *    - 127.0.0.1 にのみ bind する（外部公開しない）
 *    - 共有シークレットを検証する（Next 側は管理者セッションで更に前段を守る）
 *    - 書き換え先を軽量レーン（見た目だけ）に限定する
 *    - main を直接書き換えず、必ずブランチを切る
 *    - 変更後に品質ゲートを回し、通らなければ報告する
 *
 * 2. **許可判定は `canUseTool` で自前に書く。** `disallowedTools` の文字列パターンに頼らない。
 *    パターンは表記揺れ（相対/絶対パス、`..`、シンボリックリンク）で容易に抜けるため、
 *    「実パスへ解決してから許可リストと突き合わせる」形にしてある（下の isAllowedWrite）。
 *
 * 3. **Bash は許可しない。ただしこれは「コードが実行されない」ことを意味しない。**
 *    セキュリティ監査 SEC-075 の指摘（初版はこれを取り違えていた）:
 *    書き込みを許した時点で、そのファイルを import / 評価する経路がそのまま実行媒体になる。
 *    初版はランナー自身が `pnpm test:unit` を回しており、vitest がテスト対象を実 import するため、
 *    **エージェントの書いたトップレベルのコードがランナーの権限で実行されていた。**
 *    現在は**コードを実行しない静的検査（`tsc --noEmit`）だけ**をゲートにしている。
 *
 *    それでも、書き換えた UI コードは**人間が `pnpm dev` でサイトを見た時点で実行される。**
 *    これはこの機能の目的そのものなので回避できない。**残るのは被害範囲の制限だけ**である:
 *    書き込みを `components/` に限る / 秘密を読ませない / 自動 push しない / 差分を人間が見る。
 *
 * -----------------------------------------------------------------------------
 * 認証
 * -----------------------------------------------------------------------------
 * Agent SDK は Claude Code と同じ認証情報の解決順序を共有するため、
 * **Claude Code にログイン済みならこのランナーも追加設定なしで動く**（API キー不要）。
 * ⚠️ 環境に `ANTHROPIC_API_KEY` が残っているとそちらが優先され、意図しない課金経路になる。
 *    サブスクリプションで動かしたい場合は unset しておくこと。
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import { query } from '@anthropic-ai/claude-agent-sdk'

const run = promisify(execFile)

const PORT = Number(process.env.VIBE_RUNNER_PORT ?? 4319)
const HOST = '127.0.0.1'
const REPO = path.resolve(process.env.VIBE_REPO_PATH ?? path.join(import.meta.dirname, '..'))
const SECRET = process.env.VIBE_RUNNER_SECRET ?? ''

if (!SECRET) {
  console.error('VIBE_RUNNER_SECRET が未設定です。共有シークレット無しでは起動しません。')
  process.exit(1)
}

/**
 * 軽量レーンで書き換えてよい対象。
 *
 * ⚠️ **`app/` と `lib/design-tokens.ts` / `tailwind.config.ts` は意図的に外してある**（SEC-075 / SEC-076）:
 *
 *  - `lib/design-tokens.ts` は `tests/unit/design-tokens.test.ts` が実 import しており、
 *    `tailwind.config.ts` は `pnpm dev` / `pnpm build` が設定として評価する。
 *    どちらもエージェントが書いたトップレベルのコードを**そのまま実行**する経路になる。
 *  - `app/` には `app/admin/(app)/layout.tsx`（`requireAdmin()` の認証ガード）、
 *    `auth-actions.ts`（`'use server'` = 公開エンドポイント等価）、
 *    `app/(public)/apply/page.tsx`（フォームセッションの入口）、
 *    そして**この機能自身の本番ガード**が含まれる。`route.ts` を弾くだけでは足りなかった。
 *
 * 色・余白などトークンの値を変えたい場合は、この経路ではなく人間が直接編集すること。
 */
const WRITABLE_DIRS = ['components']
const WRITABLE_FILES = []

/** 上記配下でも触らせないもの。**この機能自身のコンソールを含む**（自分のガードを緩める経路を断つ）。 */
const DENIED_PATTERNS = [
  /^app\//,
  /route\.ts$/,
  /middleware\.ts$/,
  /^components\/admin\/VibeConsole\.tsx$/,
]

/**
 * 読み取りを許す範囲（SEC-077）。**読み取りにも同じ実パス解決を適用する。**
 * これを怠ると `.env` の `AUTH_SECRET` / `DATABASE_URL` / `RESEND_API_KEY` 等が読め、
 * 読んだ値を `components/**` へ書いてランナーが自動コミットする——
 * 読み・書き・永続化が 1 リクエストで完結してしまう。
 */
const READ_DENIED_PATTERNS = [
  /^\.env/,
  /^\.git\//,
  /^node_modules\//,
  /^runner\//,
  /\.pem$/,
  /\.key$/,
]

/**
 * 書き込み先が軽量レーンの内側かを**実パスで**判定する。
 * `..` やシンボリックリンクでリポジトリ外へ出る経路をここで塞ぐ。
 */
/**
 * リポジトリ内の相対パス（`/` 区切り）へ正規化する。外へ出るものは null。
 * **読み取り・書き込みの両方がこれを通る**（SEC-077）。
 */
async function resolveInRepo(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  const abs = path.resolve(REPO, rawPath)

  // シンボリックリンクを解決する。新規作成では実体が無いので、**存在する最も近い祖先**まで
  // 遡って解決し、残りのセグメントを繋ぎ直す（`components/new/Thing.tsx` のように
  // 新しいサブディレクトリごと作る場合に、親が無いだけで拒否しないため）。
  // 解決するのはあくまで実在部分なので、リンクでリポジトリ外へ出る経路は塞がったままになる。
  let resolved = abs
  const rest = []
  for (let cursor = abs; ; ) {
    try {
      resolved = path.join(await fs.realpath(cursor), ...rest)
      break
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) return false // ルートまで辿っても実体が無い
      rest.unshift(path.basename(cursor))
      cursor = parent
    }
  }

  const rel = path.relative(REPO, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/** 書き込み可否（軽量レーンの内側か）。 */
export async function isAllowedWrite(rawPath) {
  const unix = await resolveInRepo(rawPath)
  if (unix === null) return false
  if (DENIED_PATTERNS.some((re) => re.test(unix))) return false
  if (WRITABLE_FILES.includes(unix)) return true
  return WRITABLE_DIRS.some((dir) => unix === dir || unix.startsWith(`${dir}/`))
}

/**
 * 読み取り可否（SEC-077）。**リポジトリの内側**かつ秘密を含む場所でないこと。
 * 書き込みより広いのは、変更対象の周辺コードを読ませないと妥当な変更ができないため。
 */
export async function isAllowedRead(rawPath) {
  const unix = await resolveInRepo(rawPath)
  if (unix === null) return false
  return !READ_DENIED_PATTERNS.some((re) => re.test(unix))
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/** 品質ゲート。**エージェントではなくランナーが実行する。** */
async function runGate(command, args) {
  try {
    const { stdout } = await run(command, args, { cwd: REPO, maxBuffer: 32 * 1024 * 1024 })
    return { ok: true, output: stdout.slice(-4000) }
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.slice(-4000)
    return { ok: false, output }
  }
}

async function git(...args) {
  const { stdout } = await run('git', args, { cwd: REPO, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * 1 リクエスト = 1 変更。NDJSON で進捗を流す。
 */
async function handleRun(instruction, emit) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  const branch = `vibe/${stamp}`

  const dirty = await git('status', '--porcelain')
  if (dirty) {
    emit({ type: 'error', message: '作業ツリーに未コミットの変更があります。先に整理してください。' })
    return
  }

  await git('switch', '-c', branch)
  emit({ type: 'branch', branch })

  const touched = new Set()
  let denied = 0

  const q = query({
    prompt: [
      '以下の指示に従って、このリポジトリの**見た目だけ**を変更してください。',
      '',
      `指示: ${instruction}`,
      '',
      '制約:',
      '- 変更してよいのは components/ 配下の JSX と Tailwind クラスのみです。',
      '  app/ 配下・lib/・tailwind.config.ts・テストコードは書き換えられません（拒否されます）。',
      '- 色・余白・角丸・影は Tailwind のクラス（例 bg-primary, p-l, rounded-card, shadow-level2）で表現してください。',
      '  デザイントークンの値そのものは変更できません。',
      '- ロジック・API・判定関数・認証・レート制限には一切触れないでください。',
      '- data-testid 属性とフォームのラベル文言は変更しないでください（E2E が参照しています）。',
      '- ファイルを探すときは Glob / Grep に必ず path を指定してください（例 path: "components"）。',
      '  path を省略した呼び出しは拒否されます（検査できない読み取りを許さないため）。',
    ].join('\n'),
    options: {
      cwd: REPO,
      model: 'claude-opus-5',
      permissionMode: 'default',
      maxTurns: 40,
      canUseTool: async (request) => {
        const name = request.toolName
        if (READ_TOOLS.has(name)) {
          // **読み取りにもパス検査を掛ける（SEC-077）。** Read/Glob/Grep は絶対パスを取れるので、
          // 無条件許可はローカルファイルシステム全域の読み取りを許すことになる。
          // ⚠️ **パスが無い呼び出しを素通りさせない（SEC-082）。**
          // `Grep` / `Glob` は `path` が**任意**なので、省略されると `cwd`(= REPO) 全体を走り、
          // `READ_DENIED_PATTERNS` を一度も通らずに `.env` の中身まで拾える。
          // 「引数が無いから安全」ではなく「引数が無いから検査できない」——**検査できないものは拒否する。**
          const target = request.input?.file_path ?? request.input?.path
          if (target === undefined) {
            denied += 1
            emit({ type: 'denied', tool: name, path: '(パス未指定)' })
            return false
          }
          const allowed = await isAllowedRead(target)
          if (!allowed) {
            denied += 1
            emit({ type: 'denied', tool: name, path: String(target) })
          }
          return allowed
        }
        if (!WRITE_TOOLS.has(name)) {
          // Bash を含む未知のツールは一律拒否する（ゲートはランナーが回す）。
          denied += 1
          emit({ type: 'denied', tool: name })
          return false
        }
        const target = request.input?.file_path ?? request.input?.path
        const allowed = await isAllowedWrite(target)
        if (!allowed) {
          denied += 1
          emit({ type: 'denied', tool: name, path: String(target ?? '') })
          return false
        }
        touched.add(String(target))
        return true
      },
    },
  })

  for await (const message of q) {
    if (message.type === 'text' && message.text) emit({ type: 'agent', text: message.text })
    else if (message.type === 'tool_use') emit({ type: 'tool', name: message.name })
  }

  const changed = await git('status', '--porcelain')
  if (!changed) {
    emit({ type: 'done', ok: false, message: '変更が発生しませんでした。', denied })
    await git('switch', '-')
    await git('branch', '-D', branch)
    return
  }

  // ⚠️ **ここで `pnpm test:unit` を回してはならない（SEC-075）。**
  // vitest はテスト対象を実 import するため、エージェントが書いたトップレベルのコードが
  // ランナー自身の権限で実行される。「Bash を許可しない」という防御が、
  // ゲートを実行媒体にすることで完全に無効化される。
  // ここで回してよいのは**コードを実行しない静的検査だけ**である（`tsc --noEmit`）。
  // 単体テストと E2E は、変更内容を人間が見てから手元で回すこと。
  emit({ type: 'gate', name: 'type-check', status: 'running' })
  const types = await runGate('pnpm', ['type-check'])
  emit({ type: 'gate', name: 'type-check', status: types.ok ? 'pass' : 'fail', output: types.output })

  const ok = types.ok
  if (ok) {
    await git('add', '-A')
    await git(
      'commit',
      '-m',
      `style: ${instruction.slice(0, 60)}\n\n管理画面の Vibe Coding から生成（軽量レーン / components/ のみ）。\ntype-check のみ通過。**単体テストと E2E は未実行**（SEC-075: ゲートで実行するとエージェントの書いたコードを実行してしまうため）。`,
    )
    emit({ type: 'commit', branch, files: [...touched] })
  }

  emit({
    type: 'done',
    ok,
    branch,
    denied,
    message: ok
      ? `${branch} にコミットしました。**差分を確認してから** pnpm test:unit と pnpm test:e2e を回してください（ランナーは実行しません）。`
      : '型チェックが通らなかったのでコミットしていません。ブランチに変更が残っています。',
  })
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404).end()
    return
  }
  if (req.headers['x-vibe-secret'] !== SECRET) {
    res.writeHead(401).end()
    return
  }

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let instruction = ''
  try {
    instruction = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).instruction ?? '')
  } catch {
    res.writeHead(400).end()
    return
  }
  if (!instruction.trim()) {
    res.writeHead(400).end()
    return
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })
  const emit = (event) => res.write(`${JSON.stringify(event)}\n`)

  try {
    await handleRun(instruction, emit)
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    res.end()
  }
})

// 直接起動されたときだけ listen する。テストから `isAllowedWrite` を import しても
// ポートを掴まないようにするため（掴むと E2E の 3000 番と同種の衝突を持ち込む）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  server.listen(PORT, HOST, () => {
    console.log(`vibe runner: http://${HOST}:${PORT} (repo: ${REPO})`)
  })
}
