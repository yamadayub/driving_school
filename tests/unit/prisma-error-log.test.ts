import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { attachPrismaLogging, prismaErrorLogFields } from '@/lib/db'
import { PII_DENY_KEYS, type AppLogger } from '@/lib/pii-log'

/**
 * =========================================================================
 * P3-c1 — **SEC-064 / P3c-8**: `PrismaClient` のエラーログを
 *          `lib/pii-log.ts` の 1 点へ合流させる
 * =========================================================================
 *
 * 出典: `docs/security-audit.md` §F P3c-8（:3268）
 *       「`PrismaClient` のエラーログを `lib/pii-log.ts` の 1 点へ合流させる。
 *         **`LicensePhoto` の `objectKey` を扱う前に**」
 *
 * ## 何が漏れているのか
 * `lib/db.ts:13-15` は `new PrismaClient({ log: ['error'] })` である。
 * この形の `log` は **Prisma が自分で stdout/stderr へ書く**という指定であり、
 * **アプリのロガーを一切通らない**。そして Prisma の例外メッセージは**値を含む**——
 * `lib/pii-log.ts:80-84` が自ら書いているとおり:
 *
 * > Prisma の一意制約違反は `Unique constraint failed on the fields: (...)` のように**値を含む**
 * > メッセージを返す。それを `logger.error('db', { error })` でそのまま出すのが**最も起きやすい漏えい**である。
 *
 * `lib/pii-log.ts` は「**通る場所を 1 つにして落とす**」ために作られたが、
 * **Prisma の直接出力はその 1 点を迂回している。**
 * `app/api/applications/route.ts:313` が `toErrorLogFields(error)` で丁寧に落としている隣で、
 * 同じ例外の生メッセージが Prisma 自身によって既にログへ出ている。
 *
 * ## なぜ P3-c2 の「前」なのか
 * P3-c2 は `LicensePhoto`（`objectKey` / `uploadToken`）を DB に持つ。
 * `objectKey` は `PII_DENY_KEYS` に列挙済み（`lib/pii-log.ts:52`）だが、
 * **Prisma の直接出力はその列挙を参照しない。** 免許証写真のオブジェクトキーが
 * 一意制約違反や外部キー違反のメッセージに乗って**素のログへ出る**。
 * 署名付き URL の材料が運用ログに残ることは、AC-PII-1 の違反であると同時に
 * **写真そのものへの到達経路**になる。
 *
 * ## red 理由
 * `lib/db.ts` は `prisma` しか export しておらず、
 * `attachPrismaLogging` も `prismaErrorLogFields` も存在しない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // lib/db.ts
 * // 1. PrismaClient は **イベント方式**で構築する（Prisma に自分で書かせない）
 * //      log: [{ emit: 'event', level: 'error' }, ...]
 * // 2. 受けたイベントを `createPiiSafeLogger(consoleSink)` 経由で出す
 *
 * export interface PrismaLogEvent { message?: string; target?: string; timestamp?: Date }
 *
 * /** イベントを**ログ可能なフィールドだけ**に落とす。**`message` を返してはならない。** *\/
 * export function prismaErrorLogFields(event: PrismaLogEvent): { errorCode: string; target?: string }
 *
 * /** `$on('error' | 'warn')` を張る。テストからフェイクを差し込めるよう関数として分離する。 *\/
 * export function attachPrismaLogging(
 *   client: { $on(level: 'error' | 'warn', callback: (event: PrismaLogEvent) => void): void },
 *   logger: AppLogger,
 * ): void
 * ```
 *
 * **`message` を「サニタイズして残す」形にしないこと。** どの値がメッセージのどこに現れるかは
 * Prisma のバージョンとエラー種別に依存し、列挙で追随できない。
 * `lib/pii-log.ts:85-96` の `toErrorLogFields` が既に採った判断
 * （「**`message` も `stack` も返さない**」）と同じ形にする。
 */

const DB_SOURCE = resolve(process.cwd(), 'lib/db.ts')

/** 値を含む、現実的な Prisma のエラーメッセージ。 */
const UNIQUE_VIOLATION =
  'Invalid `prisma.application.create()` invocation:\n\n' +
  'Unique constraint failed on the fields: (`email`)\n' +
  'email=leak@example.com, name=漏洩 太郎, phone=090-1234-5678'

/** P3-c2 が扱う値（免許証写真のオブジェクトキー）。 */
const OBJECT_KEY_VIOLATION =
  'Invalid `prisma.licensePhoto.create()` invocation:\n\n' +
  'Foreign key constraint failed on the field: `applicationId`\n' +
  'objectKey=license/2026/07/29/8f3a2b1c-front.jpg, uploadToken=ut_9f8e7d6c5b4a'

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies AppLogger
}

/** `$on` を記録するだけのフェイククライアント。 */
function fakeClient() {
  const handlers = new Map<string, (event: unknown) => void>()
  return {
    handlers,
    $on(level: string, callback: (event: unknown) => void) {
      handlers.set(level, callback)
    },
  }
}

/* ========================================================================= *
 * SEC-064 (1): イベントを落とす関数
 * ========================================================================= */

describe('SEC-064 / P3c-8: prismaErrorLogFields は生メッセージを返さない', () => {
  it('message を返さない（値がメッセージに含まれるため）', async () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される漏えい: 申込者の氏名・メール・電話が
    // **Prisma のエラーメッセージ経由でログへ出る**こと（AC-PII-1 / AC-010-7 違反）。
    // `lib/pii-log.ts:80-84` が「最も起きやすい漏えい」と名指ししている経路そのものである。
    const fields = prismaErrorLogFields({
      message: UNIQUE_VIOLATION,
      target: 'prisma.application.create',
    })

    expect(fields).not.toHaveProperty('message')
    const serialized = JSON.stringify(fields)
    expect(serialized).not.toContain('leak@example.com')
    expect(serialized).not.toContain('漏洩 太郎')
    expect(serialized).not.toContain('090-1234-5678')
  })

  it('P3-c2 の値（objectKey / uploadToken）も返さない', async () => {
    // **P3-c2 の前に閉じる理由そのもの。**
    // 署名付き URL の材料が運用ログに残ることは、AC-PII-1 の違反であると同時に
    // **免許証写真そのものへの到達経路**になる。
    const serialized = JSON.stringify(
      prismaErrorLogFields({
        message: OBJECT_KEY_VIOLATION,
        target: 'prisma.licensePhoto.create',
      }),
    )

    expect(serialized).not.toContain('license/2026/07/29')
    expect(serialized).not.toContain('ut_9f8e7d6c5b4a')
  })

  it('Prisma のエラーコードは残す（区別できることと漏らさないことを両立させる）', async () => {
    // **過剰な秘匿は運用不能を招く**（`lib/pii-log.ts:22-23`）。
    // 「何も出さない」は正解ではない——障害の切り分けができなくなる。
    const fields = prismaErrorLogFields({
      message: 'Invalid invocation: \nUnique constraint failed (P2002)\nemail=leak@example.com',
      target: 'prisma.application.create',
    })
    expect(fields.errorCode).toBe('P2002')
  })

  it('コードが読み取れなければ UNKNOWN（`lib/pii-log.ts` の既定と揃える）', async () => {
    expect(prismaErrorLogFields({ message: 'connection reset by peer' }).errorCode).toBe('UNKNOWN')
    expect(prismaErrorLogFields({}).errorCode).toBe('UNKNOWN')
  })

  it('target は残す（モデル名・メソッド名は PII ではなく、運用に要る）', async () => {
    const fields = prismaErrorLogFields({
      message: UNIQUE_VIOLATION,
      target: 'prisma.application.create',
    })
    expect(fields.target).toBe('prisma.application.create')
  })

  it('target に値が混ざっていても素通しにしない（形式検査を通す）', async () => {
    // `target` は Prisma が入れる識別子だが、**信用しきらない**。
    // 形式（識別子とドットだけ）を外れた値はコードと同様に落とす。
    const fields = prismaErrorLogFields({
      message: 'x',
      target: 'prisma.application.create email=leak@example.com',
    })
    expect(JSON.stringify(fields)).not.toContain('leak@example.com')
  })
})

/* ========================================================================= *
 * SEC-064 (2): 実際に `lib/pii-log.ts` の 1 点へ合流していること
 * ========================================================================= */

describe('SEC-064 / P3c-8: Prisma のログがアプリのロガーを通る', () => {
  it('$on("error") が張られ、受けたイベントがロガーへ渡る', async () => {
    // これが green なら排除される状態: Prisma が**アプリのロガーを一切通らずに**
    // stdout/stderr へ直接書くこと（`log: ['error']` の意味）。
    // `lib/pii-log.ts:4-11` が「**通る場所を 1 つにして落とす**以外に手段がない」と
    // 書いている、その 1 点を迂回している経路である。
    const client = fakeClient()
    const logger = fakeLogger()
    attachPrismaLogging(client as never, logger)

    expect(client.handlers.has('error'), '$on("error") が張られていない').toBe(true)

    client.handlers.get('error')!({
      message: UNIQUE_VIOLATION,
      target: 'prisma.application.create',
    })

    expect(logger.error, 'イベントがロガーへ渡っていない').toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(logger.error.mock.calls)
    expect(serialized).not.toContain('leak@example.com')
    expect(serialized).not.toContain('漏洩 太郎')
  })

  it('PII セーフラッパを通した場合、禁止キーが落ちる（合流の実利）', async () => {
    // 合流させる意味は「**列挙を 1 か所で維持できる**」ことである。
    // `PII_DENY_KEYS` に項目を足したとき、Prisma 経路にも自動的に効くこと。
    const { createPiiSafeLogger } = await import('@/lib/pii-log')
    const sink = fakeLogger()
    const client = fakeClient()
    attachPrismaLogging(client as never, createPiiSafeLogger(sink))

    client.handlers.get('error')!({
      message: OBJECT_KEY_VIOLATION,
      target: 'prisma.licensePhoto.create',
      objectKey: 'license/2026/07/29/8f3a2b1c-front.jpg',
    })

    const serialized = JSON.stringify(sink.error.mock.calls)
    expect(serialized).not.toContain('license/2026/07/29')
    expect(PII_DENY_KEYS, 'objectKey が列挙から外れている').toContain('objectKey')
  })

  it('ロガーが throw してもアプリを落とさない（ログは失敗経路で呼ばれる）', async () => {
    // `lib/pii-log.ts:154-155`「**ここで例外を投げてはならない**——ログは失敗経路で
    // 呼ばれるため、投げると『エラー処理中にエラー』になる」と同じ配慮を、
    // イベントハンドラ側にも要求する。
    const client = fakeClient()
    const throwing: AppLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(() => {
        throw new Error('sink is down')
      }),
    }
    attachPrismaLogging(client as never, throwing)

    expect(() => client.handlers.get('error')!({ message: UNIQUE_VIOLATION })).not.toThrow()
  })
})

/* ========================================================================= *
 * SEC-064 (3): 迂回路が残っていないことをソースで固定する
 * ========================================================================= */

describe('SEC-064 / P3c-8: lib/db.ts に Prisma の直接出力が残っていない', () => {
  const source = () => readFileSync(DB_SOURCE, 'utf8')

  it("log に文字列レベル（'error' / 'warn' / 'query'）の配列を渡していない", () => {
    // 文字列指定は「**Prisma が自分で stdout/stderr へ書く**」という意味であり、
    // アプリのロガーを一切通らない。1 文字の違いで漏えい経路が復活するため、
    // 振る舞いテスト（上の describe）とは別にソースでも固定する
    //（`tests/unit/applications-route-contract.test.ts` と同じ二重の網）。
    //
    // ⚠️ 現行の `lib/db.ts:14` は
    //   `log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']`
    // という**三項演算子**なので、`log:\s*\[` だけを見るパターンでは**空振りする**。
    // 配列リテラルそのものを見ること。
    expect(
      source(),
      "文字列レベルの配列（['error'] 等）が残っている＝ Prisma が直接 stdout へ書く",
    ).not.toMatch(/\[\s*(['"](error|warn|query|info)['"]\s*,?\s*)+\]/)
  })

  it("emit: 'event' でイベント方式を使っている", () => {
    expect(source()).toMatch(/emit\s*:\s*['"]event['"]/)
  })

  it('lib/pii-log.ts のロガーを使っている', () => {
    expect(source()).toMatch(/from\s+['"]@\/lib\/pii-log['"]/)
    expect(source()).toContain('createPiiSafeLogger')
  })

  it('console を直接呼んでいない（PII セーフラッパを迂回しない）', () => {
    expect(source()).not.toMatch(/console\.(log|error|warn|info)\s*\(/)
  })
})
