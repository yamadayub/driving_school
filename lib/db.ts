import { PrismaClient } from '@prisma/client'
import { consoleSink, createPiiSafeLogger, type AppLogger } from '@/lib/pii-log'

/**
 * Prisma シングルトン（tech-stack §1.2 / §2.1）。
 * DBアクセスはサーバー限定。開発時の HMR による接続枯渇を防ぐため globalThis に保持する。
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/* ------------------------------------------------------------------------- *
 * SEC-064 / P3c-8 — Prisma のログを `lib/pii-log.ts` の 1 点へ合流させる
 * ------------------------------------------------------------------------- *
 *
 * 以前ここは `log` に**文字列レベルの配列**（`emit` を指定しない形）を渡していた。
 * これは「**Prisma が自分で stdout/stderr へ書く**」という指定であり、
 * **アプリのロガーを一切通らない**。
 *
 * そして Prisma の例外メッセージは**値を含む**——`lib/pii-log.ts` の自己申告どおり
 * 「一意制約違反は `Unique constraint failed on the fields: (...)` のように値を含む
 * メッセージを返す。それをそのまま出すのが**最も起きやすい漏えい**である」。
 * `app/api/applications/route.ts` が `toErrorLogFields(error)` で丁寧に落としている隣で、
 * 同じ例外の生メッセージが Prisma 自身によって既にログへ出ていた。
 *
 * **P3-c2 の前に閉じる理由**: P3-c2 は `LicensePhoto`（`objectKey` / `uploadToken`）を
 * DB に持つ。両者は `PII_DENY_KEYS` に列挙済みだが、**Prisma の直接出力はその列挙を
 * 参照しない**。署名付き URL の材料が運用ログに残ることは AC-PII-1 違反であると同時に、
 * **写真そのものへの到達経路**になる。
 */

/** Prisma のログイベント（`$on` のコールバックが受け取る形の、使う部分だけ）。 */
export interface PrismaLogEvent {
  message?: string
  target?: string
  timestamp?: Date
}

/** `attachPrismaLogging` が必要とする最小の構造（テストからフェイクを差し込めるようにする）。 */
export interface PrismaLogEmitter {
  $on(level: 'error' | 'warn', callback: (event: PrismaLogEvent) => void): void
}

/** Prisma のエラーコード（`P1001` / `P2002` …）。メッセージ本文から抽出する。 */
const PRISMA_ERROR_CODE_PATTERN = /\bP\d{4}\b/

/**
 * `target` として出してよい形（`prisma.application.create`）。
 *
 * Prisma が入れる識別子だが**信用しきらない**。形式（識別子とドットだけ）を外れた値は
 * コードと同様に落とす——値が混ざって渡された場合に素通しさせないため。
 */
const PRISMA_TARGET_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/
const MAX_TARGET_LENGTH = 128

/**
 * ログイベントを**ログ可能なフィールドだけ**に落とす。**`message` を返さない。**
 *
 * `message` を「サニタイズして残す」形にしていないのは、どの値がメッセージのどこに現れるかが
 * Prisma のバージョンとエラー種別に依存し、**列挙で追随できない**ためである。
 * `lib/pii-log.ts` の `toErrorLogFields` が既に採った判断（「`message` も `stack` も返さない」）と揃えた。
 *
 * 逆に**何も出さないのは正解ではない**（`lib/pii-log.ts`: 過剰な秘匿は運用不能を招く）。
 * 障害の切り分けに要る `errorCode` と `target` は残す。
 */
export function prismaErrorLogFields(event: PrismaLogEvent): {
  errorCode: string
  target?: string
} {
  const code =
    typeof event.message === 'string' ? PRISMA_ERROR_CODE_PATTERN.exec(event.message) : null
  const fields: { errorCode: string; target?: string } = {
    errorCode: code ? code[0] : 'UNKNOWN',
  }

  const target = event.target
  if (
    typeof target === 'string' &&
    target.length > 0 &&
    target.length <= MAX_TARGET_LENGTH &&
    PRISMA_TARGET_PATTERN.test(target)
  ) {
    fields.target = target
  }
  return fields
}

/**
 * Prisma のログイベントをアプリのロガーへ流す。
 *
 * **ここで例外を投げてはならない**——ログは失敗経路で呼ばれるため、投げると
 * 「エラー処理中にエラー」になる（`lib/pii-log.ts` の `createPiiSafeLogger` と同じ配慮）。
 */
export function attachPrismaLogging(client: PrismaLogEmitter, logger: AppLogger): void {
  const forward =
    (level: 'error' | 'warn') =>
    (event: PrismaLogEvent): void => {
      try {
        logger[level]('prisma', prismaErrorLogFields(event))
      } catch {
        // sink が落ちてもアプリは落とさない。
      }
    }

  client.$on('error', forward('error'))
  client.$on('warn', forward('warn'))
}

/**
 * イベント方式のログ設定。**`emit: 'event'` が要点**——これが無いと Prisma が直接書く。
 * `warn` は開発時のみ購読する（従来の挙動と揃える）。
 */
const logDefinitions =
  process.env.NODE_ENV === 'development'
    ? ([
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ] as const)
    : ([{ emit: 'event', level: 'error' }] as const)

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({ log: [...logDefinitions] })
  // `$on` の型は log 設定のリテラル型から導かれるが、上の設定は環境で分岐するため
  // リテラル型を保てない。受け口は `PrismaLogEmitter` で構造的に固定してある。
  attachPrismaLogging(client as unknown as PrismaLogEmitter, createPiiSafeLogger(consoleSink))
  return client
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
