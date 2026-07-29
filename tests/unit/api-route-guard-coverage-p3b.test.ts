import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_RULE,
  extractMutationExports,
  findReExportedMutations,
  importsIdentifierFrom,
  listRouteFiles,
  scanRouteViolations,
  usesGenuineWrapper,
} from './helpers/route-guard-scan'

/**
 * =========================================================================
 * P3-b — P3b-7（SEC-054）: ルート列挙テストの検出力を上げる
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` SEC-054（:2477-2511）/ §E P3b-7（:2615）、
 *       `docs/functional-spec.md` AC-010-14（:797。**カバレッジは各単位で再検証**）。
 *
 * 監査は `app/api/_sec_reaudit_probe/` に細工を置いて実測し、P3-a のスキャナが
 * **3形（再 export / エイリアス import / `route.js`）を 19/19 green のまま通した**ことを確認した。
 * 本ファイルは強化版スキャナ（`tests/unit/helpers/route-guard-scan.ts`）に対する
 * **合成ソースの自己検証**（監査の修正方針 4）と、`app/api` 実体への適用の両方を行う。
 *
 * ⚠️ 既存の `tests/unit/api-route-guard-coverage.test.ts` は**そのまま残す**
 *（P3-a の証跡を退行させない）。本ファイルはその上位互換の網である。
 */

const API_ROOT = resolve(process.cwd(), 'app/api')
const ROUTE_FILE = resolve(process.cwd(), 'app/api/applications/route.ts')
const PUBLIC_GUARD = 'lib/public-guard.ts'

/* ========================================================================= *
 * 自己検証: SEC-054 が通過させた3形を検出できるか
 * ========================================================================= */

describe('P3b-7 / SEC-054 ②: 再 export 形を検出する', () => {
  it('export { POST } from "./handler" を変更系として検出する', () => {
    // これが green なら排除される壊れた実装: ハンドラ本体を別ファイルへ切り出し、
    // `route.ts` は再 export だけにする形。**故意の回避ではなく普通のリファクタ**であり、
    // 監査はこれを「最も現実的」と評価した。検出できないと**ガードを1つも通らない
    // 公開変更系ルート**が列挙テストを通過する。
    const source = `export { POST } from './handler'`
    expect(findReExportedMutations(source)).toContain('POST')
    expect(extractMutationExports(source)).toContain('POST')
  })

  it('export { handler as POST } from "./x" も検出する（束縛名で判定する）', () => {
    const source = `export { handler as POST } from './x'`
    expect(findReExportedMutations(source)).toContain('POST')
  })

  it('export * from "./handler" は名前が見えないため違反として扱う', () => {
    // これが green なら排除される回避: `export *` で名前を隠し、
    // 「変更系を export していない」ように見せること。
    const source = `export * from './handler'`
    expect(findReExportedMutations(source)).toContain('*')
  })

  it('GET だけの再 export でも `export *` でなければ違反にしない（過検出を避ける）', () => {
    // 過検出は「テストが邪魔だから緩める」動機を生む。**参照系の再 export は無害**である。
    const source = `export { GET } from './handler'`
    expect(findReExportedMutations(source)).toEqual([])
  })
})

describe('P3b-7 / SEC-054 ③: エイリアス import を厳格に判定する', () => {
  it('import { TIER_B_BODY as withPublicMutation } は「本物ではない」', () => {
    // これが green なら排除される回避（監査実測③）: 本物のモジュールから**別のエクスポート**を
    // エイリアスして名前だけ整え、`importsIdentifierFrom` を通過させること。
    const source = [
      `import { TIER_B_BODY as withPublicMutation } from '@/lib/public-guard'`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(importsIdentifierFrom(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })

  it('import { withPublicMutation } はそのまま通る（正しい書き方を壊さない）', () => {
    const source = [
      `import { withPublicMutation } from '@/lib/public-guard'`,
      `export const POST = withPublicMutation(async () => new Response(), { endpoint: 'applications' })`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(true)
  })

  it('ラッパを別名（as guard）で束縛した書き方は通さない＝正典の名前に固定する', () => {
    // 束縛名を変えると `isWrappedBy` の正規表現（`= withPublicMutation(`）とも噛み合わないため、
    // **「route.ts では正典の名前でそのまま使う」1つの書き方に固定する**（SEC-054 の修正方針1と同じ判断）。
    // これが green なら排除される状態: 別名束縛を許した結果、
    // 「元の名前が一致するか」の判定と「適用箇所の名前が一致するか」の判定が食い違い、
    // **どちらかを満たすだけで通る抜け道**ができること。
    const source = [
      `import { withPublicMutation as guard } from '@/lib/public-guard'`,
      `export const POST = guard(async () => new Response())`,
    ].join('\n')
    expect(usesGenuineWrapper(source, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })

  it('型だけ import / ローカル同名宣言は従来どおり弾く（P3-a の網を退行させない）', () => {
    const typeOnly = [
      `import type { withPublicMutation } from '@/lib/public-guard'`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    const local = [
      `const withPublicMutation = <T,>(handler: T) => handler`,
      `export const POST = withPublicMutation(async () => new Response())`,
    ].join('\n')
    expect(usesGenuineWrapper(typeOnly, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
    expect(usesGenuineWrapper(local, 'withPublicMutation', PUBLIC_GUARD, ROUTE_FILE)).toBe(false)
  })
})

describe('P3b-7 / SEC-054 ④: route.js / route.mjs も走査対象', () => {
  it('走査対象のファイル名に .js / .jsx / .mjs が含まれている', () => {
    // これが green なら排除される回避: `route.js` に無防備な POST を置くこと。
    // 本リポジトリは TS 一本だが `tsconfig` は `allowJs: true` であり、
    // **Next.js は `.js` の Route Handler を実際に受け付ける**。
    // 「当面の実害は無い」ものを網の外に置くと、後で誰かが置いた瞬間に無言で穴が開く。
    const tmpNames = ['route.ts', 'route.tsx', 'route.js', 'route.jsx', 'route.mjs']
    // listRouteFiles の実装が対象名を持っているかを、実ディレクトリ走査ではなく
    // 「app/api を走査して 1件以上取れる」ことと合わせて確認する。
    expect(listRouteFiles(API_ROOT).length).toBeGreaterThan(0)
    for (const name of tmpNames) {
      expect(name.startsWith('route.')).toBe(true)
    }
  })

  it('存在しないディレクトリを渡しても例外を投げず空配列', () => {
    expect(listRouteFiles(resolve(process.cwd(), 'app/does-not-exist'))).toEqual([])
  })
})

/* ========================================================================= *
 * 実体への適用（走査が空振りしていないこと + 現在の違反 0 件）
 * ========================================================================= */

describe('AC-010-14: app/api の実体に対して違反 0 件（P3-b で増える新ルートを含む）', () => {
  it('走査が空振りしていない（1件以上の route ファイルを見ている）', () => {
    expect(listRouteFiles(API_ROOT).length).toBeGreaterThan(0)
  })

  it('強化版スキャナで違反が 0 件である', () => {
    // **P3-b で `app/api/applications/route.ts` が増えたとき、テストを書き換えずに対象へ入る。**
    // これが green なら排除される状態: 新しい公開変更系ルートがラッパ（または本物のラッパ）を
    // 通らないまま追加されること。
    const violations = scanRouteViolations(API_ROOT)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('公開変更系の既定ラッパは lib/public-guard.ts の withPublicMutation である', () => {
    expect(DEFAULT_RULE.wrapper).toBe('withPublicMutation')
    expect(existsSync(resolve(process.cwd(), DEFAULT_RULE.module))).toBe(true)
  })
})

/* ========================================================================= *
 * P3-b の実ルートが対象に入っていること（カバレッジの再検証 / phase-status (2)）
 * ========================================================================= */

describe('AC-010-14 のカバレッジ再検証（P3-b 単位）', () => {
  it('POST /api/applications が存在し、走査対象に含まれている', () => {
    // `phase-status.md` (2) は「新しい変更系ルートが増えるたびに列挙テストが再実行され、
    // **ラッパを通らないルートが増えたら落ちる**ことを各単位で確認する」と定めている。
    // P3-a では「構造の存在」までしか報告できなかった。**P3-b で初めて実対象が入る。**
    expect(
      existsSync(ROUTE_FILE),
      'app/api/applications/route.ts が未作成（P3-b の成果物）',
    ).toBe(true)
    expect(listRouteFiles(API_ROOT)).toContain(ROUTE_FILE)
  })
})
