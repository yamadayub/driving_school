import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PUBLIC_HANDLER_MAX_DURATION_SEC } from '@/lib/semaphore'

/**
 * =========================================================================
 * P3-b — P3b-1（配線の渡し忘れをソースで固定）/ AC-RL-15(a)（maxDuration）
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §E P3b-1（:2608。修正方針3「少なくとも『別軸が無い公開ルートが
 *       存在しないこと』を列挙テストで固定する」）、
 *       `docs/functional-spec.md` §4.11 AC-RL-15(a)（:1534）/ AC-RL-1（:1520）。
 *
 * ## なぜソース走査なのか（構築時 throw があるのに）
 * 構築時 throw（`public-guard-p3b-wiring.test.ts`）は**実行されて初めて効く**。
 * Route Handler モジュールは Next.js のビルド時に評価されるので実際には効くが、
 * 「**将来 `endpoint` を増やしたときに、そのルートだけ throw を回避する形で書かれる**」ことは
 * 防げない（例: `limiters` を条件付きで組み立てる）。
 * 監査の修正方針3が要求しているのは**構成の存在をルート横断で固定すること**であり、
 * これは構築時 throw とは別の網である。**2つとも要る。**
 */

const ROUTE_FILE = resolve(process.cwd(), 'app/api/applications/route.ts')

function routeSource(): string {
  expect(existsSync(ROUTE_FILE), 'app/api/applications/route.ts が未作成（P3-b の成果物）').toBe(
    true,
  )
  return readFileSync(ROUTE_FILE, 'utf8')
}

describe('P3b-1 / SEC-053: /api/applications の配線', () => {
  it('POST が withPublicMutation を通る', () => {
    expect(routeSource()).toMatch(/export\s+const\s+POST\s*=\s*withPublicMutation\s*[<(]/)
  })

  it('limiters に source と formSession の両方を渡している', () => {
    // これが green なら排除される攻撃（監査 D-1 の実測: 500回送信 → 201×500）:
    // 縮退構成で `formSession` 軸を渡し忘れ、**Tier D に enforce される軸が1つも無い**状態。
    const source = routeSource()
    expect(source).toMatch(/limiters\s*:/)
    expect(source, 'limiters.source が無い').toMatch(/source\s*:/)
    expect(source, 'limiters.formSession が無い（P3b-1）').toMatch(/formSession\s*:/)
  })

  it('formSessionKey に lib/form-session の formSessionAxisKey を渡している', () => {
    // これが green なら排除される攻撃（監査 D-3 / D-4）: `?? 'anonymous'` のような
    // **固定値フォールバック**を持つ独自のキー関数を書き、共有バケットを硬いゲートにすること。
    // 型（`PerRequesterKey`）でも防いでいるが、**`as` によるキャストは型では止まらない**ため、
    // 「正典の関数をそのまま渡している」ことをソースでも固定する。
    const source = routeSource()
    expect(source).toMatch(/formSessionKey\s*:\s*formSessionAxisKey\b/)
    expect(source).toMatch(/import\s*\{[^}]*\bformSessionAxisKey\b[^}]*\}\s*from\s*['"]@\/lib\/form-session['"]/)
  })

  it('verifyFormSession（Tier B の判定）を渡している', () => {
    // AC-RL-13(b) / 条件1'-3。縮退構成でこれが無いと、ラッパは**全リクエストを Tier B にする**
    //（RV-P3AF-006 の fail-closed）。「渡している」ことを固定しておかないと、
    // E2E が全部 403 になった理由を追う時間が丸ごと無駄になる。
    expect(routeSource()).toMatch(/verifyFormSession\s*:/)
  })

  it('セマフォ（Tier C の共有軸）を渡している', () => {
    expect(routeSource()).toMatch(/semaphore\s*:/)
  })

  it('Content-Type 検証を要求している（単純リクエスト化の封じ）', () => {
    expect(routeSource()).toMatch(/requireContentType\s*:\s*['"]json['"]/)
  })

  it('type-check を通すためのキャスト（as any / as unknown as / @ts-)が無い', () => {
    // これが green なら排除される回避: `formSessionKey: ((r) => 'shared') as PerRequesterKey`
    // のようなキャストで型の継ぎ目を無効化すること。**SEC-052 の是正は型が本体**なので、
    // キャストが1つ入るだけで守られなくなる。
    const source = routeSource()
    expect(source).not.toMatch(/\bas\s+any\b/)
    expect(source).not.toMatch(/as\s+unknown\s+as/)
    expect(source).not.toMatch(/@ts-(ignore|expect-error|nocheck)/)
  })
})

describe('AC-RL-15(a): maxDuration は単一定数から導出する', () => {
  it('公開ハンドラの maxDuration 定数が存在する', () => {
    expect(PUBLIC_HANDLER_MAX_DURATION_SEC).toBe(10)
  })

  it('/api/applications の maxDuration が lib/semaphore.ts の定数と型で結ばれている', () => {
    // これが green なら排除される事故（AC-RL-15 の理由そのもの）:
    // `maxDuration` を変更する人が編集するのは `app/api/**/route.ts` であり、
    // その人が `tech-stack.md` を読む動機は無い。定数と切り離されていると、
    // **TTL(20秒) との関係が黙って壊れる**（TTL < maxDuration になるとリースが処理中に回収され、
    // 同時実行上限を超過する）。
    //
    // ⚠️ **Impl による契約の実現方法の変更（`docs/impl-p3b-notes-2026-07-29.md` §2）**
    //   当初の期待値は `export const maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC` だったが、
    //   **Next.js のセグメント設定は静的解析されるため識別子を書けない**。実測（Next 15.5.22）:
    //     `⨯ Next.js can't recognize the exported 'config' field in route "/api/applications/route":
    //        Unknown identifier "PUBLIC_HANDLER_MAX_DURATION_SEC" at "maxDuration".`
    //     `⨯ Invalid segment configuration export detected.` → **`pnpm build` が失敗する**
    //   （同一ファイル内のローカル const に置いても "Unknown identifier" で同じく落ちる）。
    //   つまり元の期待値と「`pnpm build` 成功」は同時に満たせなかった。
    //   **要求の本質は「片方だけ変えたら落ちる」こと**なので、リテラル + 直下の型アサーション
    //   （`const _: typeof maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC`）で同じ性質を作り、
    //   その結線が存在することをここで固定する。食い違えば `pnpm type-check` が赤くなる。
    const source = routeSource()
    expect(source).toMatch(/export\s+const\s+maxDuration\s*=\s*\d+/)
    expect(
      source,
      'maxDuration のリテラルが lib/semaphore.ts の定数と型で結ばれていない（AC-RL-15(a)）',
    ).toMatch(/:\s*typeof\s+maxDuration\s*=\s*PUBLIC_HANDLER_MAX_DURATION_SEC\b/)
    expect(source).toMatch(
      /import\s*\{[^}]*\bPUBLIC_HANDLER_MAX_DURATION_SEC\b[^}]*\}\s*from\s*['"]@\/lib\/semaphore['"]/,
    )
  })
})

describe('P3b-4 / SEC-048・SEC-049: リクエスト由来の値を now / permitId に渡さない', () => {
  it('ルートが now / random / newPermitId をリクエストから組み立てていない', () => {
    // これが green なら排除される攻撃: `now: () => Number(request.headers.get('x-now'))` や
    // `newPermitId: () => body.requestId` のように**攻撃者制御の値**を注入すること。
    // 前者はリース期限を無効化し（TTL の意味が消える）、後者は
    // **他人のパーミットを `release` できる**（`ZREM` は permitId 指定なので、
    // 予測可能な permitId は他人の枠を解放できる＝同時実行上限の突破）。
    const source = routeSource()
    expect(source).not.toMatch(/now\s*:\s*\(\)\s*=>[^\n]*request/)
    expect(source).not.toMatch(/newPermitId\s*:/)
    expect(source).not.toMatch(/random\s*:\s*\(\)\s*=>[^\n]*request/)
  })
})
