import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveTargetPath, publicPathFromSource } from '@/lib/vibe-target'

/**
 * =========================================================================
 * Vibe Coding — 「反映後の画面を確認する」の遷移先を導出する
 * =========================================================================
 *
 * ## なぜ導出が要るのか
 * 完了後のボタンは 2 つに分かれている:
 *
 *   - 「画面を更新して次の修正をおこなう」 … `/admin/vibe` をリロードするだけ
 *   - 「反映後の画面を確認する」         … **変更された公開ページ**へ遷移する
 *
 * 後者を常にトップ (`/`) にすると、コース一覧を直したのにトップへ飛ばされ
 * 「変わっていない」と誤認させる。**push されたコミットが実際に触ったファイル**から
 * 遷移先を決める。ファイル一覧は `head` アクションが GitHub の
 * `GET /repos/{owner}/{repo}/commits/master` の `files[]` をそのまま返している
 *（SHA 取得と同じ 1 リクエストで得られるので、API 呼び出しは増えていない）。
 *
 * ## 動的セグメントを導出しない理由
 * `app/(public)/courses/[id]/page.tsx` から作れる URL は `/courses/[id]` であって
 * **実在する URL ではない**。id を埋めるにはコミット情報に無い DB の中身が要る。
 * 推測して 404 に飛ばすより、導出不能として扱いトップへ落とす方が誠実である。
 */

describe('publicPathFromSource — ソースパス 1 本から公開 URL を導く', () => {
  it('(public) 直下の page.tsx はトップページ', () => {
    expect(publicPathFromSource('app/(public)/page.tsx')).toBe('/')
  })

  it('静的セグメントの page.tsx はそのままパスになる', () => {
    expect(publicPathFromSource('app/(public)/courses/page.tsx')).toBe('/courses')
    expect(publicPathFromSource('app/(public)/programs/page.tsx')).toBe('/programs')
    expect(publicPathFromSource('app/(public)/schools/page.tsx')).toBe('/schools')
    expect(publicPathFromSource('app/(public)/apply/page.tsx')).toBe('/apply')
    expect(publicPathFromSource('app/(public)/privacy/page.tsx')).toBe('/privacy')
  })

  it('動的セグメントは導出しない（実在する URL を作れないため）', () => {
    expect(publicPathFromSource('app/(public)/courses/[id]/page.tsx')).toBeNull()
    expect(publicPathFromSource('app/(public)/programs/[id]/page.tsx')).toBeNull()
  })

  it('page.tsx 以外は導出しない', () => {
    // layout / globals.css は「どの URL か」を決められない。
    expect(publicPathFromSource('app/(public)/layout.tsx')).toBeNull()
    expect(publicPathFromSource('app/globals.css')).toBeNull()
  })

  it('公開ページ以外のファイルは導出しない', () => {
    expect(publicPathFromSource('components/ui/Button.tsx')).toBeNull()
    expect(publicPathFromSource('lib/design-tokens.ts')).toBeNull()
    expect(publicPathFromSource('DESIGN.md')).toBeNull()
    expect(publicPathFromSource('app/admin/(app)/vibe/page.tsx')).toBeNull()
  })

  it('壊れた入力で落ちない', () => {
    expect(publicPathFromSource('')).toBeNull()
    // @ts-expect-error 実行時に非 string が来ても null を返すこと
    expect(publicPathFromSource(undefined)).toBeNull()
  })
})

describe('deriveTargetPath — コミットが触ったファイル群から 1 つ選ぶ', () => {
  it('公開ページが 1 枚ならそこへ飛ぶ', () => {
    expect(deriveTargetPath(['app/(public)/courses/page.tsx', 'DESIGN.md'])).toBe('/courses')
  })

  it('トップが含まれていればトップを優先する', () => {
    // トップは「サイトの顔」で、変更が最も見て分かる面。
    expect(
      deriveTargetPath(['app/(public)/schools/page.tsx', 'app/(public)/page.tsx']),
    ).toBe('/')
  })

  it('複数ページなら入力順に関わらず同じ 1 枚を選ぶ', () => {
    // 「押すたびに違うページへ飛ぶ」を防ぐ。辞書順で決める。
    const a = deriveTargetPath(['app/(public)/schools/page.tsx', 'app/(public)/courses/page.tsx'])
    const b = deriveTargetPath(['app/(public)/courses/page.tsx', 'app/(public)/schools/page.tsx'])
    expect(a).toBe('/courses')
    expect(b).toBe('/courses')
  })

  it('公開ページを触っていなければトップへ落とす', () => {
    // components/ や design-tokens は全ページに効くので、代表としてトップを見せる。
    expect(deriveTargetPath(['components/ui/Card.tsx'])).toBe('/')
    expect(deriveTargetPath(['lib/design-tokens.ts', 'DESIGN.md'])).toBe('/')
  })

  it('動的セグメントだけならトップへ落とす', () => {
    expect(deriveTargetPath(['app/(public)/courses/[id]/page.tsx'])).toBe('/')
  })

  it('空・壊れた入力でもトップを返す（ボタンが死なないこと）', () => {
    expect(deriveTargetPath([])).toBe('/')
    // @ts-expect-error 実行時に非配列が来ても落ちないこと
    expect(deriveTargetPath(undefined)).toBe('/')
    // @ts-expect-error 配列の中身が非 string でも落ちないこと
    expect(deriveTargetPath([null, 42, 'app/(public)/apply/page.tsx'])).toBe('/apply')
  })

  it('導出結果は必ず / で始まる（外部へ飛ばさない）', () => {
    // href に入る値なので、`//evil.example` のような protocol-relative を作らないこと。
    for (const paths of [[], ['components/x.tsx'], ['app/(public)/courses/page.tsx']]) {
      const result = deriveTargetPath(paths)
      expect(result.startsWith('/')).toBe(true)
      expect(result.startsWith('//')).toBe(false)
    }
  })
})

/**
 * 結線の固定（`tests/unit/e2e-selector-contract.test.ts` と同じ手法）。
 * 導出関数が正しくても、UI が呼んでいなければ意味がない。**ソース走査で縛る。**
 */
describe('VibeConsole の結線', () => {
  const source = readFileSync(
    resolve(__dirname, '../../components/admin/VibeConsole.tsx'),
    'utf8',
  )

  it('完了後のボタンが 2 つに分かれている', () => {
    expect(source).toContain('data-testid="vibe-reload"')
    expect(source).toContain('data-testid="vibe-open-site"')
  })

  it('遷移先は導出関数から取る（トップ固定にしない）', () => {
    expect(source).toContain("from '@/lib/vibe-target'")
    expect(source).toContain('deriveTargetPath')
  })

  it('head アクションの応答から paths を受け取っている', () => {
    expect(source).toContain('paths')
  })
})
