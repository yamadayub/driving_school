'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FormStepper, type StepperItem } from '@/components/apply/FormStepper'
import { FormErrorSummary } from '@/components/apply/FormErrorSummary'
import { RateLimitWaitPanel } from '@/components/apply/RateLimitWaitPanel'
import { StepCourse } from '@/components/apply/steps/StepCourse'
import { StepEntry } from '@/components/apply/steps/StepEntry'
import { StepLicense } from '@/components/apply/steps/StepLicense'
import { StepPersonal } from '@/components/apply/steps/StepPersonal'
import { StepPreference } from '@/components/apply/steps/StepPreference'
import { StepReview } from '@/components/apply/steps/StepReview'
import {
  INQUIRY_PERSONAL_FIELDS,
  STEPS,
  STEP_FIELDS,
  STEP_LABEL,
  currentSummary,
  emptyValues,
  stripApplicationOnly,
  type ApplicationType,
  type CourseOption,
  type StepId,
  type Values,
} from '@/components/apply/form-model'
import { APPLY_DRAFT_STORAGE_KEY, toDraftSnapshot } from '@/lib/apply-draft'
import { SCHOOLS } from '@/lib/school-info'
import { parseApplicationInput, type ApplicationFieldError } from '@/lib/validators/application'

/**
 * ステップ式 申込・問い合わせフォーム（F-008 / F-010 のクライアント側）。
 *
 * ------------------------------------------------------------------------
 * このファイルの責務（`application-form.md` §6.4 / RV-P3B-012）
 * ------------------------------------------------------------------------
 * **状態・検証・送信・Turnstile の結線だけ**を持つコンテナである。入力項目の描画は
 * `steps/` 配下の部品が持つ。P3-b では 1 ファイル 1,146 行に全部入っていたが、
 * P3-c の写真ステップ（ファイル選択・プレビュー・進捗・再試行・`objectKey` 管理）を
 * その上へ載せると、`toDraftSnapshot` の (e)（写真関連値を保存しない）が守ろうとしている
 * 境界ごと壊れる——状態がこのファイルに集中しているほど破りやすくなるためである。
 *
 * ------------------------------------------------------------------------
 * **ここから動かしてはいけないもの**（分割で失われる契約）
 * ------------------------------------------------------------------------
 *  1. **Turnstile ウィジェットの `data-*-callback` 属性**と、それに対応する `window` への代入。
 *     属性値はただの文字列なので、**タイポは `pnpm type-check` で絶対に捕まらない**。
 *     両者が同じファイルに在ることだけが対応関係を読んで確認できる状態を作る（RV-P3B-001）。
 *  2. **待機パネルの文面**。「自動的に送信されます」と書くなら自動再送の実装が同じファイルに要る
 *     （RV-P3B-008。未達を隠す表示は未達より悪い）。
 *  3. **Tier B が続いたときの代替導線**（電話番号 / RV-P3B-009）。
 *
 * いずれも `tests/unit/application-form-client-wiring.test.ts` が**このファイルのソース走査**で
 * 固定している。部品側へ移すと走査が素通りし、同じ欠陥が再び入る。
 *
 * ------------------------------------------------------------------------
 * この実装が守っている契約
 * ------------------------------------------------------------------------
 *  - **AC-008-2**: `type=INQUIRY` では申込専用項目を**描画しない**（hidden / disabled では不可。
 *    DOM に在れば自動入力・拡張機能・改造クライアントから送信されうる）。
 *  - **AC-008-3**: 下書きは `sessionStorage` のみ。**自動復元しない**／常時「今すぐ削除する」／
 *    送信成功・完了・破棄で `removeItem`／写真関連値を保存しない（`toDraftSnapshot`）。
 *  - **AC-008-6 / AC-PII-2**: エラー表示に**入力値を出さない**。文言は `code` から引く。
 *  - **AC-008-7**: 確認画面はクライアント状態のみから描画する（サーバー往復しない）。
 *  - **AC-RL-6**: クライアント時刻（`formRenderedAt` 相当）を**送信ボディに含めない**。
 *  - **Tier の判別は HTTP ステータスと `challenge` の有無だけ**（§4.11 契約ルール7）。
 *
 * ------------------------------------------------------------------------
 * 検証ルールをサーバーと共有する理由
 * ------------------------------------------------------------------------
 * `lib/validators/application.ts` を**そのまま import** する（`application-form.md` §5.5）。
 * クライアント専用の検証を書くと、サーバーと食い違ったときに
 * 「クライアントは通したのにサーバーが弾く」原因不明の失敗になる。
 */

interface ApplicationFormProps {
  courses: CourseOption[]
  privacyPath: string
  initialType: ApplicationType | null
  initialCourseId: string | null
  turnstileSiteKey: string | null
}

type SubmissionState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'queued'; retryAfterMs: number }
  | { kind: 'cooldown'; retryAfterMs: number }
  | { kind: 'challenge' }
  | { kind: 'failed' }
  | { kind: 'done'; receiptNumber: string | null }

/**
 * Tier C / D の自動再送の上限（`form-submission.md` §4.4 / RV-P3B-008）。
 * `idempotencyKey` はマウント時に固定されるので、再送で二重登録は起きない（冪等経路が成立済み）。
 */
const AUTO_RESEND_MAX_ATTEMPTS = 3

/** 代替導線を出す Tier B の連続回数（RV-P3B-009）。1 回目から出すと通常の CAPTCHA 体験を壊す。 */
const CHALLENGE_COUNT_FOR_ALTERNATIVE_CONTACT = 2

/** Turnstile スクリプトの URL と、二重挿入を防ぐための id。 */
const TURNSTILE_SCRIPT_ID = 'turnstile-script'
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

/** `window.turnstile`（api.js が生やす）。**このファイルでしか触らない。** */
interface TurnstileApi {
  ready(callback: () => void): void
  render(
    container: Element,
    options: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ): string | undefined
  remove(widgetId: string): void
  getResponse(): string | undefined
}

function turnstileApi(): TurnstileApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile
}

export function ApplicationForm({
  courses,
  privacyPath,
  initialType,
  initialCourseId,
  turnstileSiteKey,
}: ApplicationFormProps) {
  const [type, setType] = useState<ApplicationType | null>(initialType)
  const [step, setStep] = useState<StepId | null>(initialType ? STEPS[initialType][0] : null)
  const [values, setValues] = useState<Values>(() => ({
    ...emptyValues(),
    courseId: initialCourseId,
  }))
  const [errors, setErrors] = useState<ApplicationFieldError[]>([])
  const [consent, setConsent] = useState(false)
  const [submission, setSubmission] = useState<SubmissionState>({ kind: 'idle' })
  const [pendingDraft, setPendingDraft] = useState<Values | null>(null)
  const [captchaToken, setCaptchaToken] = useState<string>('')
  /**
   * Tier B を**連続で受けた回数**（RV-P3B-009）。
   * Cookie をブロックしている利用者にとって「チェックにご協力ください」は操作対象が存在しない
   * 案内であり、何度解いても 403 のまま＝**離脱以外の行き先が無い**。回数を数えて出口を出す。
   */
  const [challengeCount, setChallengeCount] = useState(0)
  /** Tier C / D の自動再送の実施回数（RV-P3B-008 / `form-submission.md` §4.4）。 */
  const [retryAttempt, setRetryAttempt] = useState(0)

  /** `idempotencyKey` は**マウント時に1回だけ**発番する（form-submission.md §2.1）。 */
  const idempotencyKeyRef = useRef<string>('')
  const honeypotRef = useRef<HTMLInputElement | null>(null)
  const summaryRef = useRef<HTMLDivElement | null>(null)
  /** Turnstile ウィジェットの描画先。**明示レンダリングの対象**（下のエフェクト）。 */
  const turnstileRef = useRef<HTMLDivElement | null>(null)
  /**
   * 最新の `submit` を保持する（自動再送の `setTimeout` から呼ぶため）。
   * 依存配列に `submit` を入れるとタイマーが入力のたびに張り直され、待ち時間が伸び続ける。
   */
  const submitRef = useRef<() => Promise<void>>(async () => {})

  const steps = type ? STEPS[type] : []

  /* ------------------------------------------------------------------ *
   * 下書き（AC-008-3）
   * ------------------------------------------------------------------ */

  useEffect(() => {
    if (typeof window === 'undefined') return
    idempotencyKeyRef.current = crypto.randomUUID()
    // **(b) 自動復元しない。** 下書きがあることだけを提示し、復元は利用者の明示操作で行う
    // ——自動復元は「共有端末で他人の入力が突然表示される」事故の原因になる。
    try {
      const stored = window.sessionStorage.getItem(APPLY_DRAFT_STORAGE_KEY)
      if (!stored) return
      const parsed: unknown = JSON.parse(stored)
      if (typeof parsed === 'object' && parsed !== null) {
        const draft = parsed as Values
        if (typeof draft.idempotencyKey === 'string' && draft.idempotencyKey.length > 0) {
          idempotencyKeyRef.current = draft.idempotencyKey
        }
        setPendingDraft(draft)
      }
    } catch {
      // 壊れた下書きで画面を落とさない。
    }
  }, [])

  // 入力のたびに走るのでデバウンスする。**写真関連値は `toDraftSnapshot` が落とす（(e)）。**
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (submission.kind === 'done') return
    const timer = window.setTimeout(() => {
      try {
        const snapshot = toDraftSnapshot({
          ...values,
          type,
          idempotencyKey: idempotencyKeyRef.current,
        })
        window.sessionStorage.setItem(APPLY_DRAFT_STORAGE_KEY, JSON.stringify(snapshot))
      } catch {
        // ストレージが使えない環境（プライベートブラウジング等）でフォームを壊さない。
      }
    }, 400)
    return () => window.clearTimeout(timer)
  }, [values, type, submission.kind])

  const clearDraft = useCallback(() => {
    try {
      window.sessionStorage.removeItem(APPLY_DRAFT_STORAGE_KEY)
    } catch {
      // 無視してよい（削除できない環境でも UI は進める）。
    }
    setPendingDraft(null)
  }, [])

  const discardDraft = useCallback(() => {
    clearDraft()
    setValues({ ...emptyValues(), courseId: initialCourseId })
    setErrors([])
    setType(null)
    setStep(null)
  }, [clearDraft, initialCourseId])

  const restoreDraft = useCallback(() => {
    if (!pendingDraft) return
    const restored = { ...emptyValues(), ...pendingDraft }
    const restoredType =
      pendingDraft.type === 'APPLICATION' || pendingDraft.type === 'INQUIRY'
        ? (pendingDraft.type as ApplicationType)
        : null
    delete (restored as Record<string, unknown>).type
    delete (restored as Record<string, unknown>).idempotencyKey
    setValues(restored)
    if (restoredType) {
      setType(restoredType)
      setStep(STEPS[restoredType][0])
    }
    setPendingDraft(null)
  }, [pendingDraft])

  /* ------------------------------------------------------------------ *
   * 検証（サーバーと同一モジュール）
   * ------------------------------------------------------------------ */

  const validateFields = useCallback(
    (fields: string[]): ApplicationFieldError[] => {
      if (!type) return []
      const candidate: Values = {
        ...(type === 'INQUIRY' ? stripApplicationOnly(values) : values),
        type,
        idempotencyKey: idempotencyKeyRef.current,
        privacyConsent: true,
        captchaToken: '',
        hp_field: '',
      }
      const result = parseApplicationInput(candidate, { receivedAt: new Date() })
      if (result.success) return []
      return result.errors.filter((error) => fields.includes(error.field))
    },
    [type, values],
  )

  const currentFields = useMemo(() => {
    if (!step) return []
    if (type === 'INQUIRY' && step === 'personal') return INQUIRY_PERSONAL_FIELDS
    return STEP_FIELDS[step]
  }, [step, type])

  useEffect(() => {
    if (errors.length > 0) summaryRef.current?.focus()
  }, [errors])

  /* ------------------------------------------------------------------ *
   * ナビゲーション
   * ------------------------------------------------------------------ */

  const chooseType = (next: ApplicationType) => {
    setType(next)
    setStep(STEPS[next][0])
    setErrors([])
    if (next === 'INQUIRY') setValues((current) => stripApplicationOnly(current))
  }

  const goNext = () => {
    if (!type || !step) return
    const found = validateFields(currentFields)
    setErrors(found)
    if (found.length > 0) return
    const index = steps.indexOf(step)
    if (index >= 0 && index < steps.length - 1) setStep(steps[index + 1])
  }

  const goBack = () => {
    if (!type || !step) return
    const index = steps.indexOf(step)
    if (index <= 0) {
      setType(null)
      setStep(null)
      return
    }
    setStep(steps[index - 1])
  }

  const setValue = (field: string, value: unknown) => {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => current.filter((error) => error.field !== field))
  }

  const toggleInList = (field: string, option: string) => {
    setValues((current) => {
      const list = Array.isArray(current[field]) ? (current[field] as string[]) : []
      return {
        ...current,
        [field]: list.includes(option) ? list.filter((item) => item !== option) : [...list, option],
      }
    })
  }

  /* ------------------------------------------------------------------ *
   * Turnstile（確認画面に到達してから読み込む）
   * ------------------------------------------------------------------ */

  /**
   * **`data-*-callback` 属性が指すグローバル関数を実際に定義する**（RV-P3B-001）。
   *
   * `data-callback="onTurnstileToken"` は「`window.onTurnstileToken(token)` を呼べ」という指定で
   * あって、受け口を作ってくれるものではない。P3-b ではこの受け口が存在せず、
   * `captchaToken` は常に `''` のまま送信されていた——`lib/turnstile.ts` は空文字に対して必ず
   * `false` を返すので、**本番では F-008 / F-010 が 1 件も受け付けられない**状態だった。
   *
   * ⚠️ 属性値と下の代入先の名前は**手で一致させるしかない**（属性値はただの文字列であり、
   * 定数に切り出しても JSX 属性は文字列リテラルでしか書けない）。この対応関係は
   * `tests/unit/application-form-client-wiring.test.ts` がソース走査で固定している。
   *
   * **スクリプト読込より前に定義する**（実装スクリプトは読み込み直後にウィジェットを描画する）ため、
   * このエフェクトはスクリプト挿入のエフェクトより上に置く。
   *
   * 期限切れ・エラーでトークンを捨てるのも必須である。Turnstile のトークン寿命は **300 秒**で、
   * 確認画面に 5 分留まった利用者（＝ 入力を読み返した利用者）は
   * **期限切れトークンで Tier B に落ち、原因が画面から分からないまま離脱する**。
   */
  /** トークンの反映口を 1 つにする（宣言側の属性からも、明示レンダリング側からも通る）。 */
  const applyTurnstileToken = useCallback((token: unknown) => {
    setCaptchaToken(typeof token === 'string' ? token : '')
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as Record<string, unknown>
    w.onTurnstileToken = applyTurnstileToken
    w.onTurnstileExpired = () => applyTurnstileToken('')
    w.onTurnstileError = () => applyTurnstileToken('')
    return () => {
      delete w.onTurnstileToken
      delete w.onTurnstileExpired
      delete w.onTurnstileError
    }
  }, [applyTurnstileToken])

  /**
   * スクリプトの読み込みと、**ウィジェットの明示レンダリング**（RV-P3B-001 / 実ブラウザで観測した欠陥）。
   *
   * ------------------------------------------------------------------------
   * なぜ `turnstile.render()` を呼ぶのか（`data-*` 属性だけでは描画されない）
   * ------------------------------------------------------------------------
   * api.js の**暗黙レンダリングは「スクリプト読み込み時点の DOM」しか走査しない**。
   * 本フォームはウィジェットを**確認画面に到達してから**挿入するため、その走査に間に合う保証が無い。
   * 実測（E2E / chromium・firefox・webkit すべて）: `window.turnstile` は定義されるのに
   * **`#turnstile-slot iframe` が 0 個**——受け口（グローバル関数）が在っても
   * **ウィジェットが描画されなければトークンは永遠に取れない**。RV-P3B-001 の
   * 「本番では全送信が Tier B(403)」はこの状態でも成立する。
   *
   * 属性（`data-callback` 等）は**消さない**。暗黙レンダリングが効く経路が残っており、
   * 属性値とグローバル名の対応そのものが RV-P3B-001 の契約だからである。
   * 二重描画（iframe が 2 つ）を避けるため、**既に iframe があるときは描画しない**。
   */
  useEffect(() => {
    if (step !== 'review' || !turnstileSiteKey) return
    if (typeof document === 'undefined') return

    let cancelled = false
    let widgetId: string | undefined

    const renderWidget = () => {
      if (cancelled) return
      const api = turnstileApi()
      const container = turnstileRef.current
      if (!api || !container) return
      // 暗黙レンダリングが先に描いていたら何もしない（iframe を 2 つ作らない）。
      if (container.querySelector('iframe')) return
      try {
        widgetId = api.render(container, {
          sitekey: turnstileSiteKey,
          callback: (token: string) => applyTurnstileToken(token),
          'expired-callback': () => applyTurnstileToken(''),
          'error-callback': () => applyTurnstileToken(''),
        })
      } catch {
        // 既に描画済み等。**CAPTCHA が出せなくても送信は諦めさせない**
        // （トークンが取れなければサーバーが Tier B を返し、UI は代替導線へ進む）。
      }
    }

    // **`api.ready()` を呼んではならない。** api.js を async/defer で読み込む構成では
    // `ready()` は `[Cloudflare Turnstile] Remove async/defer ...` を throw し、
    // 渡したコールバックが**一度も呼ばれない**（E2E 実測。iframe が 0 個のままになる）。
    // `load` 後・または `window.turnstile` が在る時点で api は既に使用可能なので、直接描画する。
    const whenReady = () => {
      renderWidget()
    }

    const existing = document.getElementById(TURNSTILE_SCRIPT_ID)
    if (existing) {
      // 確認画面へ戻ってきた場合。スクリプトは読み込み済みなので描画だけやり直す。
      whenReady()
      return () => {
        cancelled = true
        if (widgetId !== undefined) {
          try {
            turnstileApi()?.remove(widgetId)
          } catch {
            // 破棄済み。
          }
        }
      }
    }

    const script = document.createElement('script')
    script.id = TURNSTILE_SCRIPT_ID
    script.src = TURNSTILE_SCRIPT_SRC
    script.async = true
    script.defer = true
    // **読み込めなくても送信を諦めさせない**（社内プロキシ・広告ブロッカー）。
    // トークンが取れなければサーバーは Tier B を返し、UI は CAPTCHA の再表示へ進む。
    script.addEventListener('load', whenReady)
    document.head.appendChild(script)

    return () => {
      cancelled = true
      script.removeEventListener('load', whenReady)
      if (widgetId !== undefined) {
        try {
          turnstileApi()?.remove(widgetId)
        } catch {
          // 破棄済み。
        }
      }
    }
  }, [step, turnstileSiteKey, applyTurnstileToken])

  /**
   * 送信直前のフォールバック（RV-P3B-001 (3)）。
   * コールバックの登録がウィジェット描画より後になった場合の**取りこぼしを回復する**。
   * ウィジェットが未生成なら `getResponse()` は throw しうるので握る（送信は諦めない）。
   */
  const resolveCaptchaToken = useCallback((): string => {
    if (captchaToken.length > 0) return captchaToken
    try {
      return turnstileApi()?.getResponse() ?? ''
    } catch {
      return ''
    }
  }, [captchaToken])

  /* ------------------------------------------------------------------ *
   * 発行済みマーカー `?fs=1` の除去（RV-P3B-002）
   * ------------------------------------------------------------------ */

  /**
   * `?fs=1` は「Cookie をブロックしている利用者を無限リダイレクトから救う」ための分岐であって、
   * **Cookie を受け入れる普通の利用者に当ててはならない**。アドレスバーに残ると:
   *
   *   10:00 `/apply` を開く → `/apply?fs=1`（Cookie 発行 / 寿命 30 分）
   *   10:45 そのタブでリロード（またはブックマーク・共有 URL を開く）
   *         → Cookie は期限切れだが `?fs=1` があるので**再発行されない**
   *   10:50 全項目を入力して送信 → **403 Tier B。回復手段なし**
   *
   * `history.replaceState` で消せば、リロード・ブックマーク・共有のいずれも必ず再発行へ回る。
   * **ページ遷移 API（`router.replace` 等）を使わない**——入力途中の状態を巻き込んで
   * 再マウントさせてしまう（`/apply` は `force-dynamic` なのでサーバー往復になる）。
   * ここで欲しいのはアドレスバーの文字列を変えることだけである。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (!url.searchParams.has('fs')) return
    url.searchParams.delete('fs')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  /* ------------------------------------------------------------------ *
   * 送信（F-010）
   * ------------------------------------------------------------------ */

  const submit = async () => {
    if (!type) return
    if (submission.kind === 'submitting') return
    setSubmission({ kind: 'submitting' })

    const payload: Values = {
      ...(type === 'INQUIRY' ? stripApplicationOnly(values) : values),
      type,
      idempotencyKey: idempotencyKeyRef.current,
      privacyConsent: consent,
      // **state をそのまま渡さない**（RV-P3B-001 (4)）。コールバックを取りこぼしていても
      // ウィジェットから実トークンを拾えば送信は成立する。
      captchaToken: resolveCaptchaToken(),
      // **クライアント時刻を含めない**（AC-RL-6 (a)）。判定はサーバーが Cookie の `issuedAt` で行う。
      hp_field: honeypotRef.current?.value ?? '',
    }

    let response: Response
    try {
      response = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      setSubmission({ kind: 'failed' })
      return
    }

    // **Tier の判別はステータスと `challenge` の有無だけ**（契約ルール7）。
    if (response.status === 201 || response.status === 200) {
      const body = (await response.json().catch(() => ({}))) as { receiptNumber?: string }
      clearDraft()
      setChallengeCount(0)
      setSubmission({ kind: 'done', receiptNumber: body.receiptNumber ?? null })
      return
    }
    if (response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { challenge?: string }
      if (body.challenge) {
        // **降格理由はサーバーからは区別できない**（契約ルール3）。区別しようとしないが、
        // 「自分が何度も Tier B を受けている」ことはクライアント自身の状態から分かる。
        // 2 回続いたら CAPTCHA では抜けられない可能性が高いので、代替導線を出す（RV-P3B-009）。
        setChallengeCount((count) => count + 1)
        // 期限切れトークンを掴んだままだと次も同じ結果になる。捨ててウィジェットに解き直させる。
        setCaptchaToken('')
        setSubmission({ kind: 'challenge' })
        return
      }
      setSubmission({ kind: 'failed' })
      return
    }
    if (response.status === 202 || response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { retryAfterMs?: number }
      const retryAfterMs = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 1_000
      setSubmission(
        response.status === 202 ? { kind: 'queued', retryAfterMs } : { kind: 'cooldown', retryAfterMs },
      )
      return
    }
    if (response.status === 400 || response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { errors?: ApplicationFieldError[] }
      const received = Array.isArray(body.errors) ? body.errors : []
      setErrors(received)
      setSubmission({ kind: 'idle' })
      // **最も手前のステップへ戻す**（§5.4）。
      const target = steps.find((candidate) =>
        received.some((error) => (STEP_FIELDS[candidate] ?? []).includes(error.field)),
      )
      if (target) setStep(target)
      return
    }
    setSubmission({ kind: 'failed' })
  }

  useEffect(() => {
    submitRef.current = submit
  })

  /**
   * Tier C / D の自動再送（`form-submission.md` §4.4 / RV-P3B-008）。
   *
   * これが無いまま「お待ちいただくと自動的に送信されます」と表示していたのが本件である。
   * **待っても何も起きない**ので、利用者は待ち続けて離脱する——未達を隠す表示は未達より悪い。
   * 表示を消す（＝ 手動再送を促す）選択肢もあったが、§4.4 が定めた挙動をそのまま実装する。
   *
   * `idempotencyKey` はマウント時に固定されるので、再送が重なっても**二重登録は起きない**
   * （サーバー側の冪等照合が 200 を返す）。上限は 3 回で、超えたら手動の再送ボタンを出す。
   */
  useEffect(() => {
    if (submission.kind !== 'queued' && submission.kind !== 'cooldown') return
    if (retryAttempt >= AUTO_RESEND_MAX_ATTEMPTS) return
    if (typeof window === 'undefined') return
    // 待ち時間は**サーバーが決める**（`retryAfterMs`）。クライアントは短縮しない（契約ルール4）。
    const timer = window.setTimeout(() => {
      setRetryAttempt((attempt) => attempt + 1)
      void submitRef.current()
    }, Math.max(1_000, submission.retryAfterMs))
    return () => window.clearTimeout(timer)
  }, [submission, retryAttempt])

  /* ------------------------------------------------------------------ *
   * 描画
   * ------------------------------------------------------------------ */

  const stepperItems: StepperItem[] = steps.map((id) => ({
    id,
    label: STEP_LABEL[id],
    state: id === step ? 'current' : steps.indexOf(id) < steps.indexOf(step ?? id) ? 'done' : 'todo',
    hasError: errors.some((error) => (STEP_FIELDS[id] ?? []).includes(error.field)),
  }))

  if (submission.kind === 'done') {
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-6" data-submission-state="done">
        <h2 tabIndex={-1} className="text-h2 font-heading text-text-primary">
          {type === 'APPLICATION' ? 'お申込みを受け付けました' : 'お問い合わせを受け付けました'}
        </h2>
        {submission.receiptNumber ? (
          <div className="mt-4 rounded border border-border bg-canvas p-4">
            <p className="text-caption text-text-secondary">受付番号</p>
            <p data-testid="complete-receipt" className="mt-1 break-all font-mono text-xl">
              {submission.receiptNumber}
            </p>
          </div>
        ) : (
          <p className="mt-4 text-text-secondary">
            受付番号は、ご入力いただいたメールアドレス宛の控えメールをご確認ください。
          </p>
        )}
        <p className="mt-4 text-text-secondary">
          ご入力いただいたメールアドレス宛に、受付内容の控えをお送りしました。
        </p>
      </section>
    )
  }

  /**
   * 確認画面の状態表示。**文面はこのファイルに置く**（分割で嘘の表示が入らないように / 冒頭 2.）。
   */
  const statusPanels = (
    <>
      {submission.kind === 'challenge' && (
        <div role="status" className="mt-4 rounded border border-info bg-info-bg p-4">
          <p>確認のため、チェックにご協力ください。</p>
          {challengeCount >= CHALLENGE_COUNT_FOR_ALTERNATIVE_CONTACT && (
            /*
             * **出口を作る**（RV-P3B-009 / I-2）。Cookie をブロックしている利用者にとって
             * 上の 1 文は操作対象が存在しない案内であり、何度チェックを解いても 403 のまま
             * ——離脱以外の行き先が無い。サーバー応答は一切変えていないので契約ルール3
             * （降格理由を区別させない）には抵触しない。
             */
            <p data-testid="apply-alternative-contact" className="mt-3">
              お使いのブラウザの設定により、送信を完了できない場合があります。
              お手数ですが、お電話でも承ります（{SCHOOLS.IWATAKI.name}{' '}
              {SCHOOLS.IWATAKI.phoneTollFree} / {SCHOOLS.AMINO.name}{' '}
              {SCHOOLS.AMINO.phoneTollFree}）。
            </p>
          )}
        </div>
      )}
      {(submission.kind === 'queued' || submission.kind === 'cooldown') &&
        (retryAttempt >= AUTO_RESEND_MAX_ATTEMPTS ? (
          /* 自動再送を使い切った。**ここで「自動的に送信されます」と言い続けない。** */
          <RateLimitWaitPanel
            message="時間をおいても混雑が解消しませんでした。もう一度お試しください。"
            onResend={() => {
              setRetryAttempt(0)
              void submit()
            }}
          />
        ) : (
          <RateLimitWaitPanel
            message={
              submission.kind === 'queued'
                ? '順番にお送りしています。このままお待ちください。'
                : 'ただいま大変混み合っています。お待ちいただくと自動的に送信されます。'
            }
          />
        ))}
      {submission.kind === 'failed' && (
        <div role="alert" className="mt-4 rounded border border-danger bg-danger-bg p-4">
          送信できませんでした。もう一度お試しください。
        </div>
      )}
    </>
  )

  return (
    <form
      className="mt-8"
      data-submission-state={submission.kind}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {pendingDraft && (
        <div className="mb-6 rounded border border-info bg-info-bg p-4">
          <p className="text-text-primary">前回の入力内容がこのタブに残っています。</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              data-testid="apply-draft-restore"
              onClick={restoreDraft}
              className="rounded bg-primary-700 px-4 py-2 text-white"
            >
              入力を復元する
            </button>
            <button
              type="button"
              onClick={discardDraft}
              className="rounded border border-border px-4 py-2"
            >
              破棄して最初から
            </button>
          </div>
        </div>
      )}

      {type && <FormStepper steps={stepperItems} />}

      <FormErrorSummary ref={summaryRef} errors={errors} />

      {type === null && <StepEntry onChoose={chooseType} />}

      {step === 'course' && type === 'APPLICATION' && (
        <StepCourse
          courses={courses}
          values={values}
          setValue={setValue}
          toggleInList={toggleInList}
        />
      )}

      {step === 'personal' && (
        <StepPersonal
          type={type}
          values={values}
          setValue={setValue}
          toggleInList={toggleInList}
        />
      )}

      {step === 'license' && type === 'APPLICATION' && (
        <StepLicense values={values} setValue={setValue} toggleInList={toggleInList} />
      )}

      {step === 'preference' && type === 'APPLICATION' && (
        <StepPreference values={values} setValue={setValue} toggleInList={toggleInList} />
      )}

      {step === 'review' && (
        <StepReview
          rows={currentSummary(type, values)}
          privacyPath={privacyPath}
          consent={consent}
          onConsentChange={setConsent}
          turnstileSlot={
            turnstileSiteKey && (
              /* 属性値は**上のエフェクトで window へ代入している名前と一字一句同じ**にすること。 */
              /* **`cf-turnstile` クラスは付けない。** 付けると api.js の暗黙レンダリングが
                 このコンテナを先に確保し（hidden input だけ作られた状態で止まる）、
                 以後の明示 `render()` が**例外も投げずに no-op** になって iframe が永遠に出ない
                 （E2E 実測）。描画は上のエフェクトの `render()` に一本化する。
                 `data-*` 属性は残す——属性値と `window` へ代入した名前の一致が
                 RV-P3B-001 の契約であり、`application-form-client-wiring.test.ts` が固定している。 */
              <div
                ref={turnstileRef}
                data-sitekey={turnstileSiteKey}
                data-callback="onTurnstileToken"
                data-expired-callback="onTurnstileExpired"
                data-error-callback="onTurnstileError"
              />
            )
          }
          statusPanels={statusPanels}
        />
      )}

      {/* ハニーポット。**視覚的にもアクセシビリティツリー上も存在しない**が DOM には在る。 */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-0 h-0 w-0 overflow-hidden">
        <label htmlFor="hp_field">この欄は入力しないでください</label>
        <input id="hp_field" name="hp_field" type="text" tabIndex={-1} autoComplete="off" ref={honeypotRef} />
      </div>

      {type && (
        <div className="mt-8 flex items-center justify-between">
          <button type="button" onClick={goBack} className="rounded border border-border px-4 py-2">
            戻る
          </button>
          {step === 'review' ? (
            <button
              type="submit"
              data-testid="apply-submit"
              disabled={!consent || submission.kind === 'submitting'}
              className="rounded bg-accent-700 px-6 py-2 font-bold text-white disabled:opacity-50"
            >
              {submission.kind === 'submitting' ? '送信しています…' : 'この内容で送信'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="apply-next"
              onClick={goNext}
              className="rounded bg-accent-700 px-6 py-2 font-bold text-white"
            >
              次へ
            </button>
          )}
        </div>
      )}

      {/* (c) 常時表示。折りたたみ・特定ステップでのみ表示は不可。 */}
      <p className="mt-8 text-caption text-text-secondary">
        入力内容はこのタブにのみ一時保存されています。
        <button
          type="button"
          data-testid="apply-draft-clear"
          onClick={discardDraft}
          className="ml-2 underline"
        >
          今すぐ削除する
        </button>
      </p>
    </form>
  )
}
