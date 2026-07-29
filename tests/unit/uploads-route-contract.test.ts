import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractOptionValue, stripComments } from './helpers/route-source'

/**
 * =========================================================================
 * P3-c2 — **P3c-1 / AC-009-5 / SEC-053**: `uploads` ルートの**結線**を固定する
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-1（:3260）
 *       「**SEC-057 の修正を、アップロード経路にも同じ形で適用する。**
 *         `uploads` エンドポイントの Tier D 軸が Cookie 軸だけにならないこと」、
 *       `docs/functional-spec.md` F-009 AC-009-5（:664）、
 *       `docs/security-p3b-reaudit-2026-07-29.md` §5 申し送り 1。
 *
 * ## P3-c1 が 4 段階すべてで踏んだ型を、最初から設計に入れる
 * P3-c1 のレビュー指摘は毎回「**測っていない継ぎ目**」に収束した:
 *
 * > 受け口の悪用 → 受け口が呼ばれること → 呼び出し元がその状態を作ること → そもそも到達しない受け口
 *
 * したがって本ファイルは**最初から「呼び出し元＝ルートが実際にその配線を持つ」ことを測る**。
 * 振る舞いテスト（`tests/integration/uploads-license.int.ts`）とは**別の網**である
 * ——構築時 throw は実行されて初めて効くが、
 * 「新しい `endpoint` を足すときに、そのルートだけ throw を回避する形で書かれる」ことは防げない
 * （`tests/unit/applications-route-contract.test.ts:14-22` が同じ理由を記録している）。
 *
 * ## red 理由
 * `app/api/uploads/license/route.ts` が存在しない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // app/api/uploads/license/route.ts
 * export const POST = withPublicMutation(handler, {
 *   endpoint: 'uploads',
 *   requireContentType: 'json',
 *   limiters: { source: sourceLimiter, formSession: formSessionLimiter },  // ★ P3c-1
 *   formSessionKey: formSessionAxisKey,                                     // ★ 正典関数
 *   verifyFormSession: (req, at) =>
 *     verifyFormSessionValue(readFormSessionCookie(req), formSessionSecret(), at) !== null,
 *   semaphore: uploadsSemaphore,
 *   clientIp: (req) => resolveClientIp(req),
 *   logger,
 * })
 * export const DELETE = withPublicMutation(deleteHandler, { ...同じ形... })   // SPEC-011
 * ```
 */

const ROUTE_FILE = resolve(process.cwd(), 'app/api/uploads/license/route.ts')

function routeSource(): string {
  expect(
    existsSync(ROUTE_FILE),
    'app/api/uploads/license/route.ts が未作成（F-009 の成果物）',
  ).toBe(true)
  return readFileSync(ROUTE_FILE, 'utf8')
}

/* ========================================================================= *
 * P3c-1: Tier D 軸が Cookie 軸だけにならない
 * ========================================================================= */

describe('P3c-1 / SEC-057: uploads の Tier D 軸が Cookie 軸だけにならない', () => {
  it('POST が withPublicMutation を通る', () => {
    // AC-009-5: 「レート制限は**バイトを受け取る前**（発行 API）に評価される」。
    // 署名付き PUT はストレージへ直接行われるため、
    // **発行数の制限が唯一の帯域防御**である（AC-009-5 の原文）。
    expect(routeSource()).toMatch(/export\s+const\s+POST\s*=\s*withPublicMutation\s*[<(]/)
  })

  it('limiters に source と formSession の両方を渡している', () => {
    // **本ファイルで最も重要なテスト。P3c-1 の本体である。**
    // これが green なら排除される事故: 縮退構成で `formSession` 軸を渡し忘れ、
    // **enforce される Tier D 軸が 1 つも無い免許証写真の受け口**が本番へ出ること。
    // 監査 §F 理由 2 の原文:
    // > そのままでは「**無制限に免許証画像をアップロードさせられる**」欠陥になる
    // > （オブジェクトストレージの費用・違法画像の受け入れ・orphan 回収バッチの破綻へ直結する）。
    //
    // ⚠️ **MF-2: `/source\s*:/` を素で使わない。**
    // それはファイル内のどこかに `source:` があれば通る（コメント・別の変数宣言でも一致する）。
    // 最も重要な契約が**構造を見ないパターン一致**に乗っていた。
    // `limiters` の**値部分を切り出してから**探す。
    //
    // 併せて記録: `tests/unit/applications-route-contract.test.ts:42-44` は**同じ弱い形**のままである
    //（本単位のスコープ外だが、同型の穴として申し送る / 設計文書 §11.5-4）。
    const limitersBlock = extractOptionValue(routeSource(), 'limiters')
    expect(limitersBlock, 'limiters が渡されていない').not.toBeNull()
    expect(limitersBlock!, 'limiters.source が無い').toMatch(/\bsource\s*:/)
    expect(limitersBlock!, 'limiters.formSession が無い（P3c-1）').toMatch(/\bformSession\s*:/)
  })

  it('limiters の中身がコメントではなく実際の値である', () => {
    // 上の切り出しが**コメントに書かれた `source:`** で通らないことを固定する。
    // 切り出した範囲から行コメント・ブロックコメントを除いても両方が残ること。
    const limitersBlock = extractOptionValue(routeSource(), 'limiters')
    expect(limitersBlock).not.toBeNull()
    const withoutComments = stripComments(limitersBlock!)
    expect(withoutComments).toMatch(/\bsource\s*:/)
    expect(withoutComments).toMatch(/\bformSession\s*:/)
  })

  it('endpoint に uploads を指定している（applications のセマフォと混ざらない）', () => {
    expect(routeSource()).toMatch(/endpoint\s*:\s*['"]uploads['"]/)
  })

  it('formSessionKey に正典の formSessionAxisKey を渡している', () => {
    // SEC-052 / P3b-1b。`?? 'anonymous'` のような固定値フォールバックを持つ
    // 独自キー関数を書くと、**共有バケットが硬いゲートになる**。
    // 型（`PerRequesterKey`）でも防いでいるが `as` キャストは型では止まらない。
    const source = routeSource()
    expect(source).toMatch(/formSessionKey\s*:\s*formSessionAxisKey\b/)
    expect(source).toMatch(
      /import\s*\{[^}]*\bformSessionAxisKey\b[^}]*\}\s*from\s*['"]@\/lib\/form-session['"]/,
    )
  })

  it('Tier B 判定に正典の verifyFormSessionValue を使う（独自の Cookie 判定を書かない）', () => {
    // 再監査 §5 申し送り 1 の原文:
    // > **`uploads` エンドポイントは `verifyFormSessionValue` を Tier B 判定にそのまま使うこと。**
    // > 独自の Cookie 判定を書かないこと。
    // > これにより SEC-067 を将来どう直しても、修正が 1 箇所で uploads にも波及する。
    const source = routeSource()
    expect(source).toMatch(/verifyFormSession\s*:/)
    expect(source).toMatch(/\bverifyFormSessionValue\b/)
  })

  it('セマフォ（Tier C）を渡している', () => {
    // 共有軸の枯渇は 429 ではなく 202（AC-RL-12）。
    expect(routeSource()).toMatch(/semaphore\s*:/)
  })

  it('clientIp を ClientIpResolution のまま渡している（trusted を捨てない）', () => {
    // SEC-043。`.key` だけを取り出す配線は縮退構成の防御を無効化する。
    expect(routeSource()).toMatch(/clientIp\s*:\s*\(?\s*\w*\s*\)?\s*=>\s*resolveClientIp\(/)
  })
})

/* ========================================================================= *
 * SPEC-011: DELETE も同じラッパを通る
 * ========================================================================= */

describe('SPEC-011 / AC-009-10: DELETE も公開変更系ラッパを通る', () => {
  it('DELETE が withPublicMutation を通る', () => {
    // これが green なら排除される事故: 削除 API だけラッパを通さず、
    // **Origin 検証・レート制限・Tier 契約のいずれも無い変更系エンドポイント**を作ること。
    // 削除は「他人のオブジェクトを消す」攻撃の入口でもある。
    expect(routeSource()).toMatch(/export\s+const\s+DELETE\s*=\s*withPublicMutation\s*[<(]/)
  })
})

/* ========================================================================= *
 * AC-009-1: クライアント指定の objectKey を信頼しない（ソースの網）
 * ========================================================================= */

describe('AC-009-1 / AC-009-10: ルートがクライアントの objectKey を信頼しない', () => {
  it('発行（POST）でリクエストボディの objectKey を読まない', () => {
    // AC-009-1: 「リクエストボディに `objectKey` を含めて送信しても**無視される**」。
    // これが green なら排除される攻撃: クライアント指定キーで
    // **他人のオブジェクトを上書き**する / `../` でバケット外へ書き込む。
    //
    // ⚠️ 本 pin は**発行側**にのみ効かせる。`DELETE` は `objectKey` を
    // **照合のために**受け取る（AC-009-10）ので、ファイル全体で禁止すると過検出になる。
    const source = routeSource()
    const postSection = source.split(/export\s+const\s+DELETE/)[0]
    expect(
      postSection,
      '発行側がリクエストの objectKey を読んでいる（サーバー生成の原則違反）',
    ).not.toMatch(/body\s*(\.|\[['"])objectKey/)
  })

  it('削除（DELETE）は uploadToken から引いた objectKey に対してのみ実行する', () => {
    // AC-009-10 の原文:
    // > サーバーは受け取った `objectKey` を信頼せず、**`uploadToken` から DB を引いて
    // > バインド済みの `objectKey` に対してのみ**削除を実行する。
    // ソースだけでは「どちらのキーで消したか」を厳密には測れないので、
    // **正典の判定関数を通していること**を固定し、実体は結合テストで測る。
    const source = routeSource()
    expect(source).toMatch(/\bverifyUploadTokenBinding\b/)
  })
})

/* ========================================================================= *
 * AC-009-5: 「発行数の制限が唯一の帯域防御」を記録として残す
 * ========================================================================= */

describe('AC-009-5: 帯域防御の所在がソースに書かれている', () => {
  it('署名付き PUT がラッパを通らないことがコメントに明記されている', () => {
    // AC-009-5 の原文が要求している:
    // > 署名付き PUT はストレージへ直接行われるため、**発行数の制限が唯一の帯域防御である**ことを
    // > **テストコメントに明記**し、発行 API が §4.11 の共通ラッパを通ることを検証
    //
    // これが green なら排除される誤解: 次に読む人が
    // 「アップロードもラッパを通っているから流量は守られている」と考え、
    // **発行数の上限を緩める**こと（実際にはバイトは一切ラッパを通らない）。
    const source = routeSource()
    expect(
      source,
      'AC-009-5 の前提（署名付き PUT はラッパを通らない）がソースに書かれていない',
    ).toMatch(/AC-009-5|唯一の帯域防御/)
  })
})
