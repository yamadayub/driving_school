/**
 * `POST /api/applications` — 申込・問い合わせの受付（F-010）。
 *
 * ------------------------------------------------------------------------
 * このルートが背負っている契約
 * ------------------------------------------------------------------------
 *  - **Tier の判別はステータスと `challenge` の有無だけ**（§4.11 契約ルール7）。
 *    Tier B は必ず `403 { challenge: 'interactive' }` で、降格理由を区別できないようにする。
 *  - **エラー応答に送信値を含めない**（AC-PII-2 / AC-010-8）。返すのは `{ field, code }` のみ。
 *  - **ログに個人情報を出さない**（AC-PII-1 / AC-010-7）。`lib/pii-log.ts` のラッパを必ず通す。
 *  - **料金はクライアント送信値を一切使わない**（AC-010-2）。`courseId` から DB を引く。
 *  - **冪等照合は `idempotencyKey` かつ Cookie の `sid`**（AC-010-4 / SPEC-017）。
 *
 * ------------------------------------------------------------------------
 * ラッパとハンドラの責務分担
 * ------------------------------------------------------------------------
 * Origin / Content-Type / ボディ上限 / Tier D（流量）/ Tier B（Cookie 検証）/ Tier C（セマフォ）は
 * `withPublicMutation` が持つ。ハンドラが持つのは**業務上の Tier B 判定**
 * （ハニーポット・送信間隔・Turnstile）と受付処理だけである。
 *
 * ------------------------------------------------------------------------
 * ⚠️ 縮退構成（`trusted=false`）での見え方（RV-P3AF-006）
 * ------------------------------------------------------------------------
 * ローカル / E2E は `VERCEL !== '1'` なので `resolveClientIp` は `trusted=false` になる。
 * この構成では**発信元軸は計数のみ**になり、`verifyFormSession` が未配線なら全リクエストが
 * 403 になる（意図した fail-closed）。**「全部 403」を実装の壊れと誤診しないこと。**
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getServerEnv } from '@/lib/env'
import { resolveClientIp } from '@/lib/http-guard'
import {
  MAX_PUBLIC_REQUEST_BODY_BYTES,
  TIER_B_BODY,
  withPublicMutation,
} from '@/lib/public-guard'
import {
  formSessionAxisKey,
  readFormSessionCookie,
  verifyFormSessionValue,
} from '@/lib/form-session'
import { createRateLimiter } from '@/lib/rate-limit'
import { sharedRateLimitStore, sharedSemaphoreStore } from '@/lib/runtime-stores'
import {
  PUBLIC_HANDLER_MAX_DURATION_SEC,
  createSemaphore,
} from '@/lib/semaphore'
import { deriveSessionIdHash, sessionIdMatches } from '@/lib/application-idempotency'
import { generateReceiptNumber } from '@/lib/receipt-number'
import { isSubmissionIntervalSatisfied } from '@/lib/spam-signals'
import { verifyTurnstile } from '@/lib/turnstile'
import { isHoneypotFilled, parseApplicationInput } from '@/lib/validators/application'
import type { ApplicationInput } from '@/lib/validators/application'
import { consoleSink, createPiiSafeLogger, toErrorLogFields } from '@/lib/pii-log'
import { sendMail } from '@/lib/mail'
import {
  AUTO_REPLY_LIMIT_PER_HOUR,
  AUTO_REPLY_WINDOW_MS,
  sendAutoReply,
} from '@/lib/mail/auto-reply'

/**
 * 公開ハンドラの実行時間上限（秒）。
 *
 * ⚠️ **Next.js のセグメント設定は静的解析されるため、ここに識別子を書けない**
 * （実測: `export const maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC` は
 *  `Unknown identifier "PUBLIC_HANDLER_MAX_DURATION_SEC" at "maxDuration"` で **build が落ちる**。
 *  同一ファイル内のローカル const でも同じく解決されない）。
 *
 * AC-RL-15(a) が求めているのは「**片方だけ変えたら落ちる**」ことなので、
 * リテラル + 直下の型アサーションで同じ性質を作る。`lib/semaphore.ts` の
 * `PUBLIC_HANDLER_MAX_DURATION_SEC` と食い違った時点で `pnpm type-check` が赤くなる
 * （`SEMAPHORE_TTL_SEC` との関係式は `tests/unit/semaphore.test.ts` が別に固定している）。
 */
export const maxDuration = 10
const assertMaxDurationMatchesSemaphore: typeof maxDuration = PUBLIC_HANDLER_MAX_DURATION_SEC
void assertMaxDurationMatchesSemaphore

/** Node ランタイム限定（`node:crypto` / Prisma に依存する）。 */
export const runtime = 'nodejs'

/* ------------------------------------------------------------------------- *
 * 軸の定義（F-010 境界値表 / P3-a で実測確定した閾値）
 * ------------------------------------------------------------------------- */

const RATE_WINDOW_MS = 600_000
/** 発信元軸: 5回/10分。**縮退時は計数のみ**（`sourceAxisFor` が `enforce` を落とす）。 */
const SOURCE_LIMIT = 5
/** フォームセッション軸: 3回/10分。縮退時に残る唯一の enforce される Tier D 軸。 */
const FORM_SESSION_LIMIT = 3
/** セマフォのシャードあたり同時実行上限（全体は × `SEMAPHORE_SHARDS`）。 */
const SEMAPHORE_PER_SHARD_LIMIT = 8

const store = sharedRateLimitStore()

const sourceLimiter = createRateLimiter({ limit: SOURCE_LIMIT, windowMs: RATE_WINDOW_MS, store })
const formSessionLimiter = createRateLimiter({
  limit: FORM_SESSION_LIMIT,
  windowMs: RATE_WINDOW_MS,
  store,
})
const autoReplyLimiter = createRateLimiter({
  limit: AUTO_REPLY_LIMIT_PER_HOUR,
  windowMs: AUTO_REPLY_WINDOW_MS,
  store,
})

const applicationsSemaphore = createSemaphore({
  store: sharedSemaphoreStore(),
  endpoint: 'applications',
  perShardLimit: SEMAPHORE_PER_SHARD_LIMIT,
})

const logger = createPiiSafeLogger(consoleSink)

/**
 * 署名鍵。**リクエストのたびに読む**——`getServerEnv()` は初回呼び出しでキャッシュするため、
 * モジュール評価時に固定すると、テストや起動順序によっては未設定の値を掴んだままになる。
 * 本番の存在検証は `getServerEnv()` の `superRefine`（起動時 fail-fast）が担う。
 */
function formSessionSecret(): string {
  return process.env.FORM_SESSION_SECRET ?? ''
}

// 本番で必須キーが欠けていれば**この時点で**落とす（起動はするが防御が消える形を作らない）。
getServerEnv()

/* ------------------------------------------------------------------------- *
 * 応答ヘルパ
 * ------------------------------------------------------------------------- */

/** Tier B（403 + challenge）。**降格理由を区別できないよう本文を1つに固定する。** */
function tierB(): Response {
  return Response.json(TIER_B_BODY, { status: 403 })
}

/** バリデーション失敗。**`{ field, code }` の配列だけ**を返す（値もメッセージも返さない）。 */
function invalid(status: 400 | 422, errors: Array<{ field: string; code: string }>): Response {
  return Response.json({ errors }, { status })
}

/* ------------------------------------------------------------------------- *
 * 受付処理
 * ------------------------------------------------------------------------- */

interface CourseSnapshot {
  courseNameSnapshot: string | null
  priceFromSnapshot: number | null
}

const NO_COURSE_SNAPSHOT: CourseSnapshot = { courseNameSnapshot: null, priceFromSnapshot: null }

/**
 * 料金・コース名のスナップショット（AC-010-2 / REV-003）と、**コースの実在判定**（SEC-060）。
 *
 * **クライアントが送った `priceFrom` 等は読まない**——読むと「1円で申し込んだ」記録を作れる。
 *
 * 以前ここは「コースが見つからなければ null のスナップショットで**素通し**」していた。
 * その結果、実在しない `courseId` は `prisma.application.create` の外部キー違反（`P2003`）まで
 * 到達し、未分類の例外として **500** になっていた——すなわち**未認証の第三者が任意に
 * サーバーエラーを起こせた**（:259-261 が壊れた JSON について既に禁じた形と同型 / SEC-042）。
 * 実在しないことは**分類できる入力起因の失敗**なので、呼び出し側が 422 に落とせるよう
 * 「見つからなかった」を型で区別して返す。
 */
type CourseLookup =
  | { found: true; snapshot: CourseSnapshot }
  /** `courseId` が実在しない。**create を呼ぶ前に 422 へ落とすこと。** */
  | { found: false }

async function lookupCourse(courseId: string | null): Promise<CourseLookup> {
  // `courseId` を持たない経路（INQUIRY）は照合の対象外。
  // **type で分けずに書くと正規の問い合わせが全て 422 になる**
  //（`lib/validators/application.ts` が同じ事故を既に記録している）。
  if (!courseId) return { found: true, snapshot: NO_COURSE_SNAPSHOT }

  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { licenseTypeLabel: true, programLabel: true, priceFrom: true },
  })
  if (!course) return { found: false }

  return {
    found: true,
    snapshot: {
      courseNameSnapshot: course.licenseTypeLabel ?? course.programLabel ?? null,
      priceFromSnapshot: course.priceFrom,
    },
  }
}

/**
 * `P2003`（外部キー違反）が **`courseId` 由来か**を判定する。
 *
 * **無条件に `{ field: 'courseId' }` へ落としてはならない**（REV-P3C1-008）。
 * P3-c2 は `LicensePhoto` → `Application` という**2 本目の外部キー**を作るので、
 * 無条件に落とすとその瞬間から `applicationId` の外部キー違反が
 * 「コースが存在しません」として利用者に返る——しかも 422 なので**監視にも上がらない**。
 *
 * 分類の網を実際の原因より広く張ることは「入力が悪い」と**嘘をつく応答**であり、
 * 未分類の例外を 500 に残す理由（「500 は分類できなかったという信号」）と同じ原則で禁じられる。
 * **判別できないものは推測せず未分類（500）に残す。**
 *
 * `meta.field_name` には Prisma が制約名（`Application_courseId_fkey (index)` 等）を入れる。
 * 単語境界を見るのは `applicationId` のような**別の列に誤爆させない**ため。
 */
const COURSE_FK_FIELD_PATTERN = /(^|[^A-Za-z])courseId([^A-Za-z]|$)/

function isCourseForeignKeyViolation(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code !== 'P2003') return false
  const fieldName = (error.meta as { field_name?: unknown } | undefined)?.field_name
  return typeof fieldName === 'string' && COURSE_FK_FIELD_PATTERN.test(fieldName)
}

/** 冪等再送の応答（AC-010-4）。`sid` が一致しなければ `id` / `receiptNumber` を返さない。 */
function idempotentResponse(
  existing: { id: string; receiptNumber: string; sessionIdHash: string | null },
  sid: string,
): Response {
  if (sessionIdMatches(existing.sessionIdHash, sid, formSessionSecret())) {
    return Response.json(
      { id: existing.id, receiptNumber: existing.receiptNumber, idempotent: true },
      { status: 200 },
    )
  }
  // **キーだけを提示した第三者に受付番号を渡さない。**`idempotencyKey` は sessionStorage の
  // 下書きと共有端末という漏えい経路を持ち、F-017 / F-018 が将来 `receiptNumber` を鍵に
  // した瞬間 IDOR の入口になる。
  return Response.json({ idempotent: true }, { status: 200 })
}

async function findExisting(idempotencyKey: string) {
  return prisma.application.findUnique({
    where: { idempotencyKey },
    select: { id: true, receiptNumber: true, sessionIdHash: true },
  })
}

async function createApplication(
  data: ApplicationInput,
  sid: string,
  receivedAt: Date,
  snapshot: CourseSnapshot,
): Promise<{ id: string; receiptNumber: string }> {
  const isApplication = data.type === 'APPLICATION'

  const created = await prisma.application.create({
    data: {
      receiptNumber: generateReceiptNumber({ now: receivedAt.getTime() }),
      idempotencyKey: data.idempotencyKey,
      type: data.type,
      plans: data.plans,
      courseId: isApplication ? data.courseId : null,
      courseNameSnapshot: snapshot.courseNameSnapshot,
      priceFromSnapshot: snapshot.priceFromSnapshot,
      school: isApplication ? data.school : null,
      format: isApplication ? data.format : null,
      name: data.name,
      nameKana: data.nameKana,
      // `birthDate` は JST の暦日。UTC 正午に置くことで、どの TZ で読んでも同じ日付になる。
      birthDate: new Date(`${data.birthDate}T12:00:00Z`),
      gender: data.gender,
      email: data.email,
      phone: data.phone,
      postalCode: isApplication ? data.postalCode : null,
      address: isApplication ? data.address : null,
      buildingName: isApplication ? data.buildingName : null,
      licenseRevoked: isApplication ? data.licenseRevoked : null,
      licenseRevokedNote: isApplication ? data.licenseRevokedNote : null,
      currentLicenses: isApplication ? data.currentLicenses : [],
      preferredStartMonth: isApplication ? data.preferredStartMonth : null,
      preferredTimeSlot: isApplication ? data.preferredTimeSlot : null,
      paymentMethod: isApplication ? data.paymentMethod : null,
      firstTime: data.firstTime,
      referralSources: data.referralSources,
      message: data.message,
      privacyConsent: true,
      sessionIdHash: deriveSessionIdHash(sid, formSessionSecret()),
    },
    select: { id: true, receiptNumber: true },
  })

  return created
}

/* ------------------------------------------------------------------------- *
 * ハンドラ
 * ------------------------------------------------------------------------- */

export const POST = withPublicMutation(async (request: Request): Promise<Response> => {
  const receivedAt = new Date()

  // ラッパを通っている時点で Cookie は署名・期限ともに検証済み。ここでは `sid` を取り出す。
  const session = verifyFormSessionValue(
    readFormSessionCookie(request),
    formSessionSecret(),
    receivedAt.getTime(),
  )
  if (session === null) return tierB()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    // **壊れた JSON / 不正な UTF-8 で 500 を起こさせない**——未認証の第三者が任意に
    // サーバーエラーを起こせる経路になる（SEC-042 と同じ形）。
    return invalid(400, [{ field: 'body', code: 'INVALID_FORMAT' }])
  }

  // --- 業務上の Tier B（降格理由は応答からもログからも区別できない）---
  // 1) ハニーポット（AC-010-3 / SPEC-012）。**充填値そのものはログに残さない。**
  if (isHoneypotFilled(body)) {
    logger.warn('application.tier_b', { signal: 'honeypot' })
    return tierB()
  }

  // 2) 送信間隔（AC-RL-6）。**Cookie 内の署名済み `issuedAt` だけで判定する**
  //    ——クライアントが送る `formRenderedAt` 相当の値は受け取っても使わない。
  if (!isSubmissionIntervalSatisfied({ issuedAt: session.issuedAt, receivedAt: receivedAt.getTime() })) {
    logger.warn('application.tier_b', { signal: 'interval' })
    return tierB()
  }

  // 3) Turnstile（E-010-1）。**条件分岐で呼び分けない**——「未設定なら検証をスキップ」と
  //    書くと CAPTCHA が丸ごと消える経路が生まれる。`verifyTurnstile` は秘密鍵が無ければ
  //    `false` を返す fail-closed なので、常に呼んで結果だけを見る。
  //    本番での鍵の存在は `lib/env.ts` の起動時 fail-fast が保証する。
  const captchaToken = (body as { captchaToken?: unknown } | null)?.captchaToken
  const captchaPassed = await verifyTurnstile(captchaToken, {
    secret: process.env.TURNSTILE_SECRET ?? '',
  })
  if (!captchaPassed) {
    logger.warn('application.tier_b', { signal: 'captcha' })
    return tierB()
  }

  // --- 入力検証（422 を 400 より優先。E-010-6 を観測可能にする）---
  const parsed = parseApplicationInput(body, { receivedAt })
  if (!parsed.success) {
    logger.info('application.rejected', { status: parsed.status, fields: parsed.errors.map((e) => e.field) })
    return invalid(parsed.status, parsed.errors)
  }
  const data = parsed.data

  // --- 冪等照合（AC-010-4 / SPEC-017）---
  const existing = await findExisting(data.idempotencyKey)
  if (existing) return idempotentResponse(existing, session.sid)

  // --- コースの実在照合（SEC-060 / P3c-4）---
  // **create を呼ぶ前**に落とす。分類できる失敗のために DB 書き込みを試みない
  //（レート制限を本体より前に置いたのと同じ理由: 攻撃者に I/O を消費させない）。
  // `courseSnapshot` が既に `findUnique` しているので**追加の往復は発生しない**。
  // 冪等照合の**後**に置いているのは、既に受け付けた申込の再送が
  // 「その後コースが削除された」だけで 422 に変わらないようにするためである。
  const course = await lookupCourse(data.type === 'APPLICATION' ? data.courseId : null)
  if (!course.found) {
    logger.info('application.rejected', { status: 422, fields: ['courseId'] })
    return invalid(422, [{ field: 'courseId', code: 'NOT_FOUND' }])
  }

  let created: { id: string; receiptNumber: string }
  try {
    created = await createApplication(data, session.sid, receivedAt, course.snapshot)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // 並行2リクエストの一意制約違反（P2002）は**失敗ではなく冪等再送**である。
      // 500 にすると利用者は「送信に失敗しました」を見て再送し、さらに 500 を受ける。
      if (error.code === 'P2002') {
        const raced = await findExisting(data.idempotencyKey)
        if (raced) return idempotentResponse(raced, session.sid)
      }
      // 照合を通った直後に管理者がコースを削除した場合のレース。
      // **入力起因の分類可能な失敗**であり内部障害ではないので、事前照合と同じ 422 へ落とす。
      // 正常な競合が 500 として監視に上がり続けると、本当の内部障害がノイズに埋もれる。
      if (isCourseForeignKeyViolation(error)) {
        logger.info('application.rejected', { status: 422, fields: ['courseId'] })
        return invalid(422, [{ field: 'courseId', code: 'NOT_FOUND' }])
      }
    }
    logger.error('application.create_failed', toErrorLogFields(error))
    return Response.json({ error: 'internal error' }, { status: 500 })
  }

  // --- 自動返信（AC-010-9: 失敗しても受付は成立している）---
  const reply = await sendAutoReply(
    {
      to: data.email,
      applicantName: data.name,
      receiptNumber: created.receiptNumber,
      type: data.type,
      receivedAt,
    },
    { limiter: autoReplyLimiter, send: (mail) => sendMail(mail), logger, now: () => receivedAt.getTime() },
  )

  logger.info('application.created', {
    receiptNumber: created.receiptNumber,
    applicationId: created.id,
    type: data.type,
    autoReplySent: reply.sent,
  })

  return Response.json({ id: created.id, receiptNumber: created.receiptNumber }, { status: 201 })
}, {
  endpoint: 'applications',
  requireContentType: 'json',
  maxBodyBytes: MAX_PUBLIC_REQUEST_BODY_BYTES,
  limiters: {
    source: sourceLimiter,
    formSession: formSessionLimiter,
  },
  // **正典の関数をそのまま渡す**（P3b-1b / SEC-052）。独自のキー関数を書くと
  // `?? 'anonymous'` のような固定値フォールバックが入り込み、共有バケットが硬いゲートになる。
  formSessionKey: formSessionAxisKey,
  verifyFormSession: (req, at) =>
    verifyFormSessionValue(readFormSessionCookie(req), formSessionSecret(), at) !== null,
  semaphore: applicationsSemaphore,
  clientIp: (req) => resolveClientIp(req),
  logger,
})
