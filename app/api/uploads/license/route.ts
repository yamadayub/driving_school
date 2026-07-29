/**
 * `POST /api/uploads/license` — 署名付きアップロード先の発行（F-009 / AC-009-1〜5）
 * `DELETE /api/uploads/license` — 未消費アップロードの取り消し（AC-009-10 / SPEC-011）
 *
 * ------------------------------------------------------------------------
 * ⚠️ AC-009-5: **発行数の制限が唯一の帯域防御である**
 * ------------------------------------------------------------------------
 * 署名付き PUT は**ストレージへ直接**行われる。すなわち
 * **画像のバイト列は本ラッパ（`withPublicMutation`）を 1 バイトも通らない。**
 *
 * > 次に読む人へ: 「アップロードもラッパを通っているから流量は守られている」と考えないこと。
 * > ラッパを通るのはこの**小さな JSON**（`{ side, contentType, size }`）だけである。
 * > **発行 API のレート制限を緩めることは、そのままストレージへの書き込み量を緩めること**に等しい
 * > （監査 §F 理由 2: 費用・違法画像の受け入れ・orphan 回収バッチの破綻）。
 *
 * この構造のため、`maxBodyBytes` を引き上げる必要は**無い**（テスト設計 §11.5-1 / Senior 確認済み）。
 *
 * ------------------------------------------------------------------------
 * サーバーはバイト列を一度も見ないまま格納が完了する
 * ------------------------------------------------------------------------
 * したがって「何が入ったか」は**格納後に読んで確かめる以外に知る方法がない**。
 * 実体検証（マジックバイト / 実サイズ）は**申込送信時**（`app/api/applications/route.ts`）に行う。
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getServerEnv } from '@/lib/env'
import { resolveClientIp } from '@/lib/http-guard'
import { withPublicMutation } from '@/lib/public-guard'
import {
  formSessionAxisKey,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { createRateLimiter } from '@/lib/rate-limit'
import { sharedRateLimitStore, sharedSemaphoreStore } from '@/lib/runtime-stores'
import { createSemaphore, PUBLIC_HANDLER_MAX_DURATION_SEC } from '@/lib/semaphore'
import { consoleSink, createPiiSafeLogger, toErrorLogFields } from '@/lib/pii-log'
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  UPLOADS_FORM_SESSION_LIMIT,
  UPLOADS_RATE_WINDOW_MS,
  UPLOADS_SOURCE_LIMIT,
  sharedStorage,
} from '@/lib/storage'
import { isDeclaredSizeAcceptable } from '@/lib/upload-validation'
import { createUploadToken, verifyUploadTokenBinding } from '@/lib/upload-token'

/**
 * 公開ハンドラの実行時間上限（秒）。
 *
 * ⚠️ **Next.js のセグメント設定は静的解析されるため、ここに識別子を書けない**
 * （`export const maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC` は
 *  `Unknown identifier` で **build が落ちる** / `app/api/applications/route.ts` の実測）。
 * リテラル + 直下の型アサーションで「**片方だけ変えたら落ちる**」性質を作る（AC-RL-15(a)）。
 */
export const maxDuration = 10
const assertMaxDurationMatchesSemaphore: typeof maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC
void assertMaxDurationMatchesSemaphore

/** Node ランタイム限定（`node:crypto` / Prisma に依存する）。 */
export const runtime = 'nodejs'

/* ------------------------------------------------------------------------- *
 * 軸の定義
 * ------------------------------------------------------------------------- */

const store = sharedRateLimitStore()

/** 発信元軸。**縮退時は計数のみ**（`sourceAxisFor` が `enforce` を落とす）。 */
const sourceLimiter = createRateLimiter({
  limit: UPLOADS_SOURCE_LIMIT,
  windowMs: UPLOADS_RATE_WINDOW_MS,
  store,
})

/**
 * フォームセッション軸。**縮退時に残る唯一の enforce される Tier D 軸**（P3c-1 の本体）。
 * 上限の根拠と上界は `lib/storage.ts` の `UPLOADS_FORM_SESSION_LIMIT` に書いてある。
 */
const formSessionLimiter = createRateLimiter({
  limit: UPLOADS_FORM_SESSION_LIMIT,
  windowMs: UPLOADS_RATE_WINDOW_MS,
  store,
})

const uploadsSemaphore = createSemaphore({
  store: sharedSemaphoreStore(),
  endpoint: 'uploads',
  perShardLimit: 8,
})

const logger = createPiiSafeLogger(consoleSink)

function formSessionSecret(): string {
  return process.env.FORM_SESSION_SECRET ?? ''
}

// 本番で必須キーが欠けていれば**この時点で**落とす。
getServerEnv()

/* ------------------------------------------------------------------------- *
 * 応答ヘルパ
 * ------------------------------------------------------------------------- */

/**
 * 発行の入力エラー。**理由を細分化しない**（列挙攻撃の材料にしない / AC-009-7 と同じ判断）。
 * 値もメッセージも返さない（AC-PII-2）。
 */
function badRequest(): Response {
  return Response.json({ error: 'invalid request' }, { status: 400 })
}

/**
 * 認可の失敗。**未存在 / 期限切れ / 消費済み / 不一致を区別しない**（AC-009-7）。
 * どれで失敗したかが分かると `objectKey` の存在を列挙できる。
 */
function forbidden(): Response {
  return Response.json({ error: 'forbidden' }, { status: 403 })
}

/* ------------------------------------------------------------------------- *
 * POST: 署名付きアップロード先の発行
 * ------------------------------------------------------------------------- */

function isSide(value: unknown): value is 'front' | 'back' {
  return value === 'front' || value === 'back'
}

export const POST = withPublicMutation(async (request: Request): Promise<Response> => {
  // ラッパを通っている時点で Cookie は検証済み。ここでは入力の形だけを見る。
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    // **壊れた JSON で 500 を起こさせない**（未認証の第三者が任意にサーバーエラーを
    // 起こせる経路になる / SEC-042・SEC-060 と同型）。
    return badRequest()
  }

  const input = (payload ?? {}) as Record<string, unknown>

  // ⚠️ **`input.objectKey` は読まない**（AC-009-1）。
  // クライアントが送ってきても**無視する**——読んだ時点で
  // (a) 他人のオブジェクトの上書き (b) `../` によるバケット外書き込み
  // (c) 既知キーの読み出し、の経路ができる。キーは必ずサーバーが生成する。
  if (!isSide(input.side)) return badRequest()

  const contentType = typeof input.contentType === 'string' ? input.contentType : ''
  if (!ALLOWED_IMAGE_CONTENT_TYPES.includes(contentType)) return badRequest()

  // 申告サイズの検査（AC-009-4(a)）。**これは格納後の再検証を代替しない。**
  if (!isDeclaredSizeAcceptable(input.size)) return badRequest()

  const storage = sharedStorage()
  const target = await storage.createSignedUpload({
    side: input.side,
    contentType,
    size: input.size as number,
  })

  const { token, expiresAt } = createUploadToken({
    objectKey: target.objectKey,
    contentType,
    maxSize: input.size as number,
  })

  await prisma.uploadToken.create({
    data: {
      token,
      objectKey: target.objectKey,
      contentType,
      maxSize: input.size as number,
      expiresAt,
    },
  })

  // **公開 URL は返さない**（AC-009-8）。`uploadUrl` は署名付きかつ期限付きの一時的な宛先である。
  return NextResponse.json(
    {
      objectKey: target.objectKey,
      uploadToken: token,
      uploadUrl: target.uploadUrl,
      expiresIn: target.expiresIn,
    },
    { status: 200 },
  )
}, {
  endpoint: 'uploads',
  requireContentType: 'json',
  limiters: {
    // ★ P3c-1 の本体。**両方を渡す。** 縮退構成で `formSession` を渡し忘れると
    //   enforce される Tier D 軸が 1 つも無い受け口になり、監査 §F 理由 2 のとおり
    //   「無制限に免許証画像をアップロードさせられる」欠陥になる。
    source: sourceLimiter,
    formSession: formSessionLimiter,
  },
  // **正典の関数をそのまま渡す**（SEC-052 / P3b-1b）。
  formSessionKey: formSessionAxisKey,
  // **正典の判定をそのまま使う**（再監査 §5 申し送り 1）。独自の Cookie 判定を書かないことで、
  // SEC-067 を将来どう直しても修正が 1 箇所で uploads にも波及する。
  verifyFormSession: (req, at) =>
    verifyFormSessionValue(readFormSessionCookie(req), formSessionSecret(), at) !== null,
  semaphore: uploadsSemaphore,
  clientIp: (req) => resolveClientIp(req),
  logger,
})

/* ------------------------------------------------------------------------- *
 * DELETE: 未消費アップロードの取り消し（AC-009-10 / SPEC-011）
 * ------------------------------------------------------------------------- */

export const DELETE = withPublicMutation(async (request: Request): Promise<Response> => {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return badRequest()
  }

  const input = (payload ?? {}) as Record<string, unknown>
  const presentedToken = typeof input.uploadToken === 'string' ? input.uploadToken : ''
  // ⚠️ **DELETE は `objectKey` を受け取る**——ただし**照合のためだけ**である（AC-009-10）。
  // 削除は必ず「トークンから DB を引いたキー」に対して行う。
  const presentedKey = typeof input.objectKey === 'string' ? input.objectKey : ''
  if (presentedToken.length === 0) return forbidden()

  const record = await prisma.uploadToken.findUnique({
    where: { token: presentedToken },
    select: {
      id: true,
      token: true,
      objectKey: true,
      contentType: true,
      maxSize: true,
      consumed: true,
      expiresAt: true,
    },
  })

  // **正典の判定関数**。理由は返らない（未存在 / 期限切れ / 消費済み / 不一致が
  // すべて同じ `false` になる / AC-009-7 の列挙攻撃防止）。
  if (!verifyUploadTokenBinding(record, { token: presentedToken, objectKey: presentedKey }, Date.now())) {
    return forbidden()
  }

  try {
    // **DB から引いたキー**に対してのみ削除する（受け取った値は使わない）。
    // 順序は Blob → DB（AC-PII-6）。逆順だとオブジェクトの記録が失われて永久に残る。
    await sharedStorage().deleteObject(record!.objectKey)
    await prisma.uploadToken.delete({ where: { id: record!.id } })
  } catch (error) {
    logger.error('uploads.delete_failed', toErrorLogFields(error))
    return Response.json({ error: 'internal error' }, { status: 500 })
  }

  return new Response(null, { status: 204 })
}, {
  endpoint: 'uploads',
  requireContentType: 'json',
  limiters: {
    source: sourceLimiter,
    formSession: formSessionLimiter,
  },
  formSessionKey: formSessionAxisKey,
  verifyFormSession: (req, at) =>
    verifyFormSessionValue(readFormSessionCookie(req), formSessionSecret(), at) !== null,
  semaphore: uploadsSemaphore,
  clientIp: (req) => resolveClientIp(req),
  logger,
})
