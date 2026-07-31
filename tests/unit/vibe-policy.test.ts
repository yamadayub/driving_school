/**
 * Vibe Coding のパス方針と、その**強制が実際に働くこと**を固定する。
 *
 * -----------------------------------------------------------------------------
 * なぜこのテストが要るのか
 * -----------------------------------------------------------------------------
 * `scripts/check-protected-paths.mjs` は「最後の砦」として書かれたが、
 * **一度も発火していなかった**（SEC-084）。ワークフローが呼ぶ時点で変更は未コミットであり、
 * `git diff <base>..HEAD` は常に空を返していたためである。
 * コードを読むだけでは気づけない——**空振りする検査は、通る検査と見分けがつかない。**
 *
 * したがって §3 は判定関数ではなく、**実際に git リポジトリを作って
 * スクリプトを起動し、違反で非ゼロ終了することを確かめる。**
 * ここが緑である限り「検査を書いたが動いていなかった」は再発しない。
 *
 * §1 / §2 は監査で**実際に迂回に使われた形**（SEC-086 / 087 / 088 / 089）を回帰として固定する。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  isAddAllowed,
  isReadablePath,
  isSafeGlobPattern,
  isWritablePath,
  secretEnvRefs,
} from '../../scripts/vibe-policy.mjs'

const REPO = resolve(__dirname, '../..')

describe('SEC-088 / 089: 書き込みは許可リストで決まる', () => {
  it('見た目を変えるためのパスは書ける', () => {
    for (const p of [
      'components/ui/CTAButton.tsx',
      'components/top/PricePreview.tsx',
      'app/(public)/page.tsx',
      'app/globals.css',
      'lib/design-tokens.ts',
      'DESIGN.md',
    ]) {
      expect(isWritablePath(p), `${p} は書けるべき`).toBe(true)
    }
  })

  it('認証・レート制限・スキーマ・テスト・ルール自身は書けない', () => {
    for (const p of [
      'auth.ts',
      'auth.config.ts',
      'middleware.ts',
      'lib/auth-guard.ts',
      'lib/env.ts',
      'lib/rate-limit.ts',
      'lib/form-session.ts',
      'app/admin/(app)/layout.tsx',
      'app/api/admin/_guard.ts',
      'prisma/schema.prisma',
      'tests/unit/vibe-policy.test.ts',
      '.github/workflows/vibe.yml',
      'scripts/vibe-policy.mjs',
      'scripts/check-protected-paths.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'next.config.mjs',
      'tailwind.config.ts',
    ]) {
      expect(isWritablePath(p), `${p} は書けてはいけない`).toBe(false)
    }
  })

  it('SEC-089: 新規の API ルートは、どこに置こうとしても作れない', () => {
    // 拒否リスト方式では「列挙されていない新規パス」が素通りした。
    for (const p of [
      'app/api/leak/route.ts',
      'app/(public)/whatever/route.ts',
      'components/route.ts',
    ]) {
      expect(isWritablePath(p), `${p} は作れてはいけない`).toBe(false)
    }
  })
})

describe('SEC-086 / 087: 読み取りは許可リストで決まる', () => {
  it('リポジトリルート起点の探索を許さない', () => {
    // `path: '.'` は `resolveInRepo` で '' に正規化される。
    // 拒否リスト方式ではどれにも一致せず ALLOW になり、glob で .env にも .git にも届いた。
    expect(isReadablePath('')).toBe(false)
  })

  it('秘密が入りうる場所は読めない', () => {
    for (const p of ['.env', '.env.local', '.git', '.git/config', 'node_modules/x', 'a/b.pem']) {
      expect(isReadablePath(p), `${p} は読めてはいけない`).toBe(false)
    }
  })

  it('SEC-086: `.git` は末尾スラッシュ無しでも拒否される', () => {
    // 旧実装の /^\.git\// は `.git` 自身に一致せず、ripgrep が .git/config を返した。
    expect(isReadablePath('.git')).toBe(false)
  })

  it('作業に要る場所は読める', () => {
    for (const p of ['app', 'components/ui', 'lib', 'docs', 'tests', 'DESIGN.md']) {
      expect(isReadablePath(p), `${p} は読めるべき`).toBe(true)
    }
  })

  it('SEC-087: glob パターン側からの迂回も塞ぐ', () => {
    expect(isSafeGlobPattern('**/*.tsx')).toBe(true)
    expect(isSafeGlobPattern(undefined)).toBe(true)
    expect(isSafeGlobPattern('**/.env*')).toBe(false)
    expect(isSafeGlobPattern('../../etc/passwd')).toBe(false)
    expect(isSafeGlobPattern('**/.git/config')).toBe(false)
  })
})

/** 使い捨ての git リポジトリを作り、base コミットを1つ置く。 */
function makeRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-check-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  mkdirSync(join(dir, 'components/ui'), { recursive: true })
  writeFileSync(join(dir, 'components/ui/Button.tsx'), 'export const Button = () => null\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return { dir, base: git('rev-parse', 'HEAD').trim() }
}

/**
 * 検査スクリプトを起動し、終了コードを返す。
 *
 * ⚠️ スクリプトは**被験リポジトリの外**へ置く。中にコピーすると `git add -A` で
 * `scripts/` 自身が新規ファイルとして差分に乗り、**テストが自分で違反を作ってしまう**
 * （最初にそう書いて、正常系が落ちた）。`--cached` 比較の cwd は被験リポジトリのまま。
 */
function runCheck(dir: string, base: string): { code: number; out: string } {
  const bin = mkdtempSync(join(tmpdir(), 'vibe-bin-'))
  try {
    for (const name of ['check-protected-paths.mjs', 'vibe-policy.mjs']) {
      writeFileSync(join(bin, name), readFileSync(join(REPO, 'scripts', name)))
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })
    try {
      const out = execFileSync('node', [join(bin, 'check-protected-paths.mjs'), base], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      })
      return { code: 0, out }
    } catch (error) {
      const e = error as { status: number; stdout?: string; stderr?: string }
      return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

  describe('SEC-084: 検査スクリプトが実際に違反を検出する', () => {
  it('許可された範囲だけの変更なら通る', () => {
      const { dir, base } = makeRepo()
      try {
        writeFileSync(join(dir, 'components/ui/Button.tsx'), 'export const Button = () => <b />\n')
        expect(runCheck(dir, base).code).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('⚠️ 既存の保護ファイルを書き換えたら止まる', () => {
      const { dir, base } = makeRepo()
      try {
        writeFileSync(join(dir, 'components/ui/Button.tsx'), 'export const Button = () => <b />\n')
        writeFileSync(join(dir, 'auth.ts'), 'export const bypass = true\n')
        const result = runCheck(dir, base)
        expect(result.code, `検査が通ってしまった:\n${result.out}`).toBe(1)
        expect(result.out).toContain('auth.ts')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('⚠️ **新規ファイル**を置いても止まる（`--cached` を外すと見逃す形）', () => {
      // 本命の攻撃形。未追跡ファイルは `git diff`（インデックスを介さない形）に現れない。
      const { dir, base } = makeRepo()
      try {
        mkdirSync(join(dir, '.github/workflows'), { recursive: true })
        mkdirSync(join(dir, 'tests'), { recursive: true })
        writeFileSync(join(dir, '.github/workflows/steal.yml'), 'name: steal\n')
        writeFileSync(join(dir, 'tests/loose.test.ts'), 'it("", () => {})\n')
        const result = runCheck(dir, base)
        expect(result.code, `新規ファイルを見逃した:\n${result.out}`).toBe(1)
        expect(result.out).toContain('steal.yml')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('⚠️ 検査は `--cached` を使い、`..HEAD` を使わない（SEC-084 の再発防止）', () => {
      // `..HEAD` はコミット間比較なので、未コミット状態では常に空＝常に通る。
      const source = readFileSync(join(REPO, 'scripts/check-protected-paths.mjs'), 'utf8')
      // 引数は複数行に折り返されうるので、呼び出し単位ではなく `git diff` の実引数だけを見る。
      const diffArgs = source.slice(source.indexOf("['diff'"), source.indexOf('.split'))
      expect(diffArgs, 'git diff の実引数が見つからない').not.toBe('')
      expect(diffArgs).toContain("'--cached'")
      expect(diffArgs, `git diff の実引数:\n${diffArgs}`).not.toContain('..HEAD')
    })
})

describe('SEC-085: ゲートは push 資格情報を持たないジョブで走る', () => {
  const workflow = readFileSync(join(REPO, '.github/workflows/vibe.yml'), 'utf8')

  it('checkout が資格情報を残さない', () => {
    const checkouts = workflow.match(/uses: actions\/checkout@v4/g) ?? []
    // ⚠️ 行頭のキーだけを数える。解説コメント中の同じ文字列を拾うと数が合わなくなる。
    const persists = workflow.match(/^\s+persist-credentials: false$/gm) ?? []
    expect(checkouts.length).toBeGreaterThan(0)
    expect(persists.length, 'すべての checkout に persist-credentials: false が要る').toBe(
      checkouts.length,
    )
  })

  it('contents: write を持つのは push ジョブだけで、そこではゲートを走らせない', () => {
    // ジョブ単位に分割する（先頭のインデント2の `  <name>:` で切る）。
    const jobs = workflow.split(/\n {2}(?=[a-z-]+:\n)/)
    const writable = jobs.filter((job) => /permissions:\s*\n\s*contents: write/.test(job))
    expect(writable.length, 'contents: write は1ジョブだけであるべき').toBe(1)
    // その1つが agent のコードを実行しないこと。
    expect(writable[0]).not.toContain('pnpm build')
    expect(writable[0]).not.toContain('pnpm test:unit')
    expect(writable[0]).not.toContain('pnpm install')
    expect(writable[0]).not.toContain('vibe-agent.mjs')
  })
})

describe('SEC-098: app/ 配下に新しい経路を作らせない', () => {
  it('app/ 配下は新規作成できない', () => {
    // App Router では page.tsx を 1 枚置くだけで**新しい公開URL**が生まれる。
    // それはサーバーコンポーネントとして本番で実行されるので、process.env を描画すれば
    // 未認証の第三者が秘密を読める。再監査が実際に curl で AUTH_SECRET を取得して実証した。
    expect(isAddAllowed('app/(public)/leak/page.tsx')).toBe(false)
    expect(isAddAllowed('app/whatever.tsx')).toBe(false)
  })

  it('components/ 配下の新規作成は許す（経路は増えない）', () => {
    expect(isAddAllowed('components/ui/NewThing.tsx')).toBe(true)
  })

  it('秘密の参照だけを拾い、NEXT_PUBLIC_ は拾わない', () => {
    expect([...secretEnvRefs('process.env.AUTH_SECRET')]).toEqual(['AUTH_SECRET'])
    expect([...secretEnvRefs('process.env.NEXT_PUBLIC_SITE_URL')]).toEqual([])
    // 名前が静的に分からない形は一律で危険とみなす。
    expect([...secretEnvRefs('process.env[key]')]).toEqual(['<動的アクセス>'])
  })

  it('⚠️ 許可された既存ファイルに秘密の参照を**足す**と止まる', () => {
    const { dir, base } = makeRepo()
    try {
      writeFileSync(
        join(dir, 'components/ui/Button.tsx'),
        'export const Button = () => <b>{process.env.AUTH_SECRET}</b>\n',
      )
      const result = runCheck(dir, base)
      expect(result.code, `秘密の持ち出しを見逃した:\n${result.out}`).toBe(1)
      expect(result.out).toContain('AUTH_SECRET')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('既存の正当な参照は、そのままなら止めない', () => {
    // app/(public)/apply/page.tsx は正当に FORM_SESSION_SECRET を使っている。
    // 「増えた参照だけ」を違反とするので、無関係な変更で落ちてはいけない。
    const { dir, base } = makeRepo()
    try {
      writeFileSync(
        join(dir, 'components/ui/Legit.tsx'),
        'export const A = () => <b>{process.env.FORM_SESSION_SECRET}</b>\n',
      )
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })
      execFileSync('git', ['commit', '-qm', 'legit'], { cwd: dir, stdio: 'pipe' })
      const base2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
      writeFileSync(
        join(dir, 'components/ui/Legit.tsx'),
        'export const A = () => <i>{process.env.FORM_SESSION_SECRET}</i>\n',
      )
      const result = runCheck(dir, base2)
      expect(result.code, `既存の参照で誤検知した:\n${result.out}`).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SEC-100: リネームで保護ファイルを消せない', () => {
  it('⚠️ middleware.ts を components/ へリネームすると止まる', () => {
    const { dir } = makeRepo()
    try {
      writeFileSync(join(dir, 'middleware.ts'), 'export const config = {}\n')
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })
      execFileSync('git', ['commit', '-qm', 'add middleware'], { cwd: dir, stdio: 'pipe' })
      const base2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

      execFileSync('git', ['mv', 'middleware.ts', 'components/dead.tsx'], { cwd: dir, stdio: 'pipe' })
      const result = runCheck(dir, base2)
      // --no-renames が無いと `R100 middleware.ts -> components/dead.tsx` の 1 行になり、
      // --name-only では宛先しか出ず「許可された components/ への変更」に見える。
      expect(result.code, `リネームによる削除を見逃した:\n${result.out}`).toBe(1)
      expect(result.out).toContain('middleware.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('⚠️ 検査は --no-renames を使う（SEC-100 の再発防止）', () => {
    const source = readFileSync(join(REPO, 'scripts/check-protected-paths.mjs'), 'utf8')
    expect(source).toContain("'--no-renames'")
    expect(source).toContain("'--name-status'")
  })
})

describe('SEC-099: 検査は patch 適用前の判定モジュールで走る', () => {
  const workflow = readFileSync(join(REPO, '.github/workflows/vibe.yml'), 'utf8')

  it('作業ツリーの scripts/ から検査を起動しない', () => {
    // patch が vibe-policy.mjs 自身を含んでいると、3つの検査がそろって
    // 「許可されている」と答えてしまう。base から退避した実体を使うこと。
    expect(workflow).not.toMatch(/node\s+scripts\/check-protected-paths\.mjs/)
  })

  it('base から退避した実体を使う', () => {
    const invocations = workflow.match(/node \/tmp\/vibe-guard\/check-protected-paths\.mjs/g) ?? []
    expect(invocations.length, '3ジョブすべてで退避側を使うこと').toBe(3)
    expect(workflow).toContain('git show "${{ steps.base.outputs.sha }}:scripts/vibe-policy.mjs"')
  })
})
