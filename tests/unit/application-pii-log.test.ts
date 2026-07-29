import { describe, it, expect, vi } from 'vitest'
import { PII_DENY_KEYS, createPiiSafeLogger, toErrorLogFields } from '@/lib/pii-log'

/**
 * =========================================================================
 * P3-b — AC-PII-1 / AC-010-7 / AC-RL-10: ログに個人情報を出さない
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 §4.12 AC-PII-1（:1545）/ AC-010-7（:790）/
 *       §4.11 AC-RL-10（:1529）/ AC-010-3 のハニーポットのログ規定（:786）。
 *
 * > 禁止項目: 氏名 / 氏名カナ / 生年月日 / 住所 / 郵便番号 / 電話 / メールアドレス / 免許取消歴 /
 * > 現有免許 / ファイル名 / `objectKey` 全体 / 署名付きURL。**`sid` とその HMAC（`sessionIdHash`）も含める**。
 * > 出力してよいのは `receiptNumber` / `applicationId` / `type` / `status` / エラーコード /
 * > 所要時間 / キーのハッシュ先頭8文字。
 * > **ユニットテストでロガーをスパイし、禁止項目が引数に現れないことを検証する（例外・スタックトレース経由の混入も対象）。**
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/pii-log.ts
 * export const PII_DENY_KEYS: readonly string[]
 * export interface AppLogger {
 *   info(event: string, fields?: Record<string, unknown>): void
 *   warn(event: string, fields?: Record<string, unknown>): void
 *   error(event: string, fields?: Record<string, unknown>): void
 * }
 * /** 禁止キーを**再帰的に**落として下流へ渡すラッパ。 *\/
 * export function createPiiSafeLogger(sink: AppLogger): AppLogger
 * /** 例外をログ可能なフィールドへ落とす。**message / stack を含めない。** *\/
 * export function toErrorLogFields(error: unknown): { errorCode: string }
 * ```
 *
 * ## なぜ「書く側の注意」ではなくラッパなのか
 * P3-a の教訓そのもの: **「警告をコメントに書く」ことは、呼び出し側が読まなければ機能しない。**
 * `logger.warn('x', { error })` は最も自然な書き方であり、そのたびに例外メッセージ経由で
 * PII が流れる。ログ出力点は今後も増え続けるため、**通る場所を1つにして落とす**以外に手段がない。
 */

function sinkLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const PII_SAMPLE = {
  name: '山田 太郎',
  nameKana: 'ヤマダ タロウ',
  birthDate: '2008-04-15',
  address: '京都府宮津市字文珠123',
  postalCode: '6260001',
  phone: '090-1234-5678',
  email: 'taro@example.com',
  licenseRevoked: true,
  currentLicenses: ['ORDINARY'],
  fileName: 'license-front.jpg',
  objectKey: 'applications/abc/license-front.jpg',
  signedUrl: 'https://blob.example.com/x?sig=abc',
  sid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  sessionIdHash: 'f'.repeat(64),
  hp_field: 'http://spam.example.com/buy',
}

describe('AC-PII-1: 禁止キーの一覧が定数として存在する', () => {
  it('仕様が列挙する禁止項目をすべて含む', () => {
    // これが green なら排除される壊れた実装: 禁止項目の一覧が各ログ出力点に散らばり、
    // **仕様の一覧と突き合わせられない**状態（1つ抜けても誰も気付かない）。
    for (const key of Object.keys(PII_SAMPLE)) {
      expect(PII_DENY_KEYS, `${key} が禁止キーに無い`).toContain(key)
    }
  })

  it('`sid` と `sessionIdHash` も禁止キーである（SPEC-017 / AC-PII-1）', () => {
    // `sid` は資格情報的な性質を持つ。相関が必要ならハッシュの先頭8文字のみ、と仕様が定めている。
    expect(PII_DENY_KEYS).toContain('sid')
    expect(PII_DENY_KEYS).toContain('sessionIdHash')
  })

  it('ハニーポットの充填値（hp_field）も禁止キーである（SPEC-012 / Designer I-5）', () => {
    // AC-010-3: 記録してよいのは「`hp_field` が非空だった」という**事実**だけで、
    // **充填された値そのものは残さない**（bot が仕込んだ URL / スクリプトがログに残ると
    // ログビューアで実行される、という二次被害もある）。
    expect(PII_DENY_KEYS).toContain('hp_field')
  })
})

describe('AC-PII-1 / AC-010-7: ロガーをスパイして禁止項目が現れないことを確認する', () => {
  it('トップレベルの禁止キーが下流へ渡らない', () => {
    const sink = sinkLogger()
    createPiiSafeLogger(sink).info('application.received', { ...PII_SAMPLE, type: 'APPLICATION' })

    const serialized = JSON.stringify(sink.info.mock.calls)
    for (const value of Object.values(PII_SAMPLE)) {
      expect(serialized.includes(String(value)), `ログに ${String(value)} が出た`).toBe(false)
    }
    expect(serialized, '許可された項目まで落としてはいけない').toContain('APPLICATION')
  })

  it('ネストしたオブジェクト・配列の中の禁止キーも落とす', () => {
    // これが green なら排除される事故: `logger.info('x', { input })` と 1 段包むだけで
    // 全フィールドが素通りすること。**実際のログ出力はほぼ必ず入れ子になる。**
    const sink = sinkLogger()
    createPiiSafeLogger(sink).warn('application.rejected', {
      input: { ...PII_SAMPLE },
      history: [{ applicant: { name: '山田 太郎' } }],
      receiptNumber: '01J9ZC8Q7K3M4N5P6R7S8T9V0W',
    })

    const serialized = JSON.stringify(sink.warn.mock.calls)
    expect(serialized).not.toContain('山田')
    expect(serialized).not.toContain('taro@example.com')
    expect(serialized).toContain('01J9ZC8Q7K3M4N5P6R7S8T9V0W')
  })

  it('循環参照を含むフィールドでも例外を投げない', () => {
    // これが green なら排除される事故: ログ出力そのものが 500 の原因になること
    //（ログは失敗経路で呼ばれるため、ここで throw すると**エラー処理中にエラー**になる）。
    const sink = sinkLogger()
    const circular: Record<string, unknown> = { name: '山田 太郎' }
    circular.self = circular
    expect(() => createPiiSafeLogger(sink).error('boom', { circular })).not.toThrow()
    expect(JSON.stringify(sink.error.mock.calls)).not.toContain('山田')
  })

  it('イベント名（第1引数）はそのまま通す（観測性を壊さない）', () => {
    const sink = sinkLogger()
    createPiiSafeLogger(sink).info('application.created')
    expect(sink.info).toHaveBeenCalledWith('application.created', undefined)
  })
})

describe('AC-PII-1: 例外・スタックトレース経由の混入', () => {
  it('toErrorLogFields は message も stack も返さない', () => {
    // **AC-PII-1 が「例外・スタックトレース経由の混入も対象」と明記している部分。**
    // これが green なら排除される事故: Prisma の一意制約違反が
    // `Unique constraint failed on the fields: (idempotencyKey)` のように**値を含む**メッセージを返し、
    // それを `logger.error('db', { error })` でそのまま出すこと。
    // Prisma / zod / Resend はいずれも入力値をメッセージに含める。
    const error = new Error('Unique constraint failed: taro@example.com / 山田 太郎')
    const fields = toErrorLogFields(error)
    expect(Object.keys(fields)).toEqual(['errorCode'])
    expect(JSON.stringify(fields)).not.toContain('taro@example.com')
    expect(JSON.stringify(fields)).not.toContain('山田')
    expect(JSON.stringify(fields)).not.toContain('Unique constraint')
  })

  it('Error 以外（文字列 / オブジェクト / null）を渡しても例外を投げず errorCode を返す', () => {
    for (const thrown of ['taro@example.com', { email: 'taro@example.com' }, null, undefined, 42]) {
      expect(() => toErrorLogFields(thrown)).not.toThrow()
      const fields = toErrorLogFields(thrown)
      expect(Object.keys(fields)).toEqual(['errorCode'])
      expect(JSON.stringify(fields)).not.toContain('taro@example.com')
    }
  })

  it('Error オブジェクトをフィールドに直接入れてもラッパが落とす', () => {
    // 「`toErrorLogFields` を使う」という規律が守られなかった場合の**最後の網**。
    // これが green なら排除される事故: 新しいログ出力点が `{ error }` と書き、
    // ラッパを通っているのに PII が出ること。
    const sink = sinkLogger()
    createPiiSafeLogger(sink).error('application.failed', {
      error: new Error('failed for taro@example.com (山田 太郎)'),
    })
    const serialized = JSON.stringify(sink.error.mock.calls)
    expect(serialized).not.toContain('taro@example.com')
    expect(serialized).not.toContain('山田')
  })

  it('errorCode は種類を区別できる（すべて "unknown" に潰さない）', () => {
    // 過剰な秘匿は運用不能を招く。**区別できることと漏らさないことは両立する。**
    class NotFoundError extends Error {
      readonly code = 'NOT_FOUND'
    }
    expect(toErrorLogFields(new NotFoundError('x')).errorCode).toBe('NOT_FOUND')
    expect(toErrorLogFields(new Error('x')).errorCode).toBe('UNKNOWN')
  })
})
