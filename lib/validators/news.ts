/**
 * お知らせ入力バリデーション（F-014 / news-cms.md フォーム項目 / functional-spec §4.5・E-014-x）。
 * サーバー側で再バリデーションする共通スキーマ（§4.1「サーバー側で再バリデーション」）。
 *
 * 実装:
 *  - Zod の判別ユニオン（discriminatedUnion, キー=status）で status ごとに publishedAt 要件を分岐する。
 *    - DRAFT / UNPUBLISHED: publishedAt は null 許容
 *    - PUBLISHED         : publishedAt は非null（Date 必須, E-014-2）
 *  - title: 1〜100 文字（必須, E-014-1）
 *  - body : 1〜20000 文字（必須。上限は news-cms §3-5 のレンダリング負荷ガード）
 *  - category: NewsCategory enum（IWATAKI/AMINO/DRONE/KENKI/COMMON。'ALL' は不可, REV-006）
 *  - status: PublishStatus enum（DRAFT/PUBLISHED/UNPUBLISHED。enum外は E-014-4）
 *  - 返り値は成否の判別可能ユニオン。例外は投げず、失敗時 errors はフィールド名→メッセージ。
 */
import { z } from 'zod'
import type { NewsCategoryCode } from '@/lib/labels'
import type { PublishStatusCode } from '@/lib/publish-status'

export interface NewsInput {
  title: string
  body: string
  category: NewsCategoryCode
  status: PublishStatusCode
  publishedAt: Date | null
}

export type NewsInputParseResult =
  | { success: true; data: NewsInput }
  | { success: false; errors: Record<string, string> }

const title = z
  .string({ required_error: 'タイトルを入力してください' })
  .min(1, 'タイトルを入力してください')
  .max(100, 'タイトルは100文字以内で入力してください')
const body = z
  .string({ required_error: '本文を入力してください' })
  .min(1, '本文を入力してください')
  .max(20000, '本文は20000文字以内で入力してください')
const category = z.enum(['IWATAKI', 'AMINO', 'DRONE', 'KENKI', 'COMMON'], {
  errorMap: () => ({ message: 'カテゴリを選択してください' }),
})

// status ごとの判別ユニオン（publishedAt の必須条件を型・実行時ともに切り替える）。
const draftSchema = z.object({
  status: z.literal('DRAFT'),
  title,
  body,
  category,
  publishedAt: z.date().nullable(),
})
const unpublishedSchema = z.object({
  status: z.literal('UNPUBLISHED'),
  title,
  body,
  category,
  publishedAt: z.date().nullable(),
})
const publishedSchema = z.object({
  status: z.literal('PUBLISHED'),
  title,
  body,
  category,
  // E-014-2: 公開時は publishedAt 非null必須（null/undefined は不正）。
  publishedAt: z.date({
    required_error: '公開日を設定してください',
    invalid_type_error: '公開日を設定してください',
  }),
})

const newsInputSchema = z.discriminatedUnion('status', [
  draftSchema,
  unpublishedSchema,
  publishedSchema,
])

/** 未検証入力を検証し、成否を判別ユニオンで返す（例外は投げない）。 */
export function parseNewsInput(input: unknown): NewsInputParseResult {
  const result = newsInputSchema.safeParse(input)
  if (result.success) {
    // publishedAt を常に Date | null に正規化して返す（PUBLISHED 枝は Date）。
    const data = result.data
    return {
      success: true,
      data: {
        title: data.title,
        body: data.body,
        category: data.category,
        status: data.status,
        publishedAt: data.publishedAt ?? null,
      },
    }
  }

  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    // status が enum 外だと判別できず invalid_union_discriminator になる → status エラーへ写像。
    const key =
      issue.code === 'invalid_union_discriminator'
        ? 'status'
        : String(issue.path[0] ?? 'form')
    if (!(key in errors)) {
      errors[key] =
        issue.code === 'invalid_union_discriminator'
          ? '公開ステータスが不正です'
          : issue.message
    }
  }
  return { success: false, errors }
}
