'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  MAGIC_BYTES_NEEDED,
  MAX_LICENSE_PHOTO_BYTES,
  detectImageType,
} from '@/lib/upload-validation'

/**
 * 免許証写真スロット（F-009 / `docs/ui-design/license-upload.md`）。
 *
 * ------------------------------------------------------------------------
 * ⚠️ このコンポーネントは「呼び出し元」である
 * ------------------------------------------------------------------------
 * このプロジェクトが 6 回踏んだ型:
 *
 * > 受け口の悪用 → 受け口が呼ばれること → 呼び出し元がその状態を作ること → そもそも到達しない受け口
 *
 * サーバー側（`app/api/uploads/license/route.ts` / `lib/upload-token.ts` /
 * `lib/upload-validation.ts`）の契約がいくら green でも、**UI がその状態を作らなければ
 * 免許証写真は 1 枚も添付されない。** ここが 4 段階目の「呼び出し元」にあたる。
 *
 * ------------------------------------------------------------------------
 * ローカル検証は**サーバーの代替ではない**（AC-009-3）
 * ------------------------------------------------------------------------
 * 選択直後に**マジックバイトで実形式を判定**する。ただしこれは
 * 「サーバーへ無駄な 5MB を送らせない」ための体験上の措置であって、**防御線ではない**
 * ——攻撃者はブラウザを経由しない。真の防御は申込送信時のサーバー側再検証である。
 *
 * **判定関数は `lib/upload-validation.ts` の正典を共有する**（AC-RL-8: 複製を作らない）。
 * だからこそ同モジュールは Node 専用 API に依存させていない。
 *
 * ------------------------------------------------------------------------
 * ⚠️ 保持してよい状態 / いけない状態（AC-008-3(e) / AC-PII-5）
 * ------------------------------------------------------------------------
 * `objectKey` / `uploadToken` / `previewUrl` は**このコンポーネントの内部状態にのみ**置く。
 * 親（`ApplicationForm`）へ渡すのは送信時に必要な最小限で、
 * **下書き（`sessionStorage`）へは一切載せない**（`lib/apply-draft.ts` の
 * `DRAFT_FORBIDDEN_KEYS` が再帰的に落とすが、そもそも渡さないのが第一の網である）。
 * 共有端末に `uploadToken` が残ると、**後続の利用者が他人の免許証画像を自分の申込に紐付けられる。**
 */

/** 親へ渡す「送信に使える写真」。**下書きには載せない。** */
export interface AttachedLicensePhoto {
  side: 'front' | 'back'
  objectKey: string
  uploadToken: string
}

type SlotState =
  | { kind: 'empty' }
  | { kind: 'issuing'; previewUrl: string }
  | { kind: 'uploading'; previewUrl: string; percent: number }
  | { kind: 'uploaded'; previewUrl: string; objectKey: string; uploadToken: string; expiresAt: number }
  | { kind: 'degraded'; previewUrl: string; objectKey: string; uploadToken: string }
  | { kind: 'failed'; previewUrl: string | null; message: string }

/** 自動再発行の上限（SPEC-009 / AC-009-11(a)）。**3 回で止める。** */
export const MAX_REISSUE_PER_SLOT = 3

/** 残りがこれを切ったら再発行を試みる（`uploadToken` は 600 秒 / ui-design §4.2）。 */
export const REISSUE_BEFORE_MS = 120_000

/** 自動再発行の判定間隔。 */
export const REISSUE_TICK_MS = 30_000

/** 1 tick で採る行動。 */
export type ReissueDecision = 'reissue' | 'degrade' | 'wait'

/**
 * 自動再発行の**判定そのもの**（AC-009-11 / SPEC-009）。
 *
 * ------------------------------------------------------------------------
 * なぜ純関数として切り出すのか（CR-003）
 * ------------------------------------------------------------------------
 * 元の実装は判定を `setInterval` のコールバック内に直接書いていた。
 * その形だと **E2E でしか検証できず、しかも tick が 30 秒間隔なので
 * 3 秒しか待たない E2E では実装が壊れていても green になる**——
 * 「空振りしているテストを green として報告しない」（申し送り原則 4）に反する。
 *
 * 判定をここへ閉じることで **30 秒待たずに unit で網羅できる**。
 * E2E 側は「タイマーが張られること」だけを見ればよい。
 *
 * ⚠️ **抑止は「タイマーを止める」ではなく「遷移の発火条件」に置く**（ui-design §2）。
 * タイマーだけ止めると、**バックグラウンドから復帰した瞬間にまとめて発火する**実装になりうる。
 * だから `visibilityState` を**毎 tick の入力**として受け取る。
 *
 * これが守れないと、SPEC-009 が警告した
 * 「タブを開いたまま放置すると 8 分ごとに発行 + PUT が永久に繰り返される」
 * ＝ **正規利用者が自分で自分をレート制限に到達させる**経路になる（AC-009-5 と衝突する）。
 */
export function reissueDecision(input: {
  visibilityState: string
  now: number
  expiresAt: number
  reissueCount: number
}): ReissueDecision {
  // **hidden の間は何もしない**（AC-009-11(b)）。状態遷移も起こさない。
  if (input.visibilityState === 'hidden') return 'wait'
  // まだ余裕がある。
  if (input.now < input.expiresAt - REISSUE_BEFORE_MS) return 'wait'
  // **上限に達したら自動再発行を止める**（Degraded）。
  // ここで不安を煽らない——まだ有効な写真は付いている（ui-design §2）。
  if (input.reissueCount >= MAX_REISSUE_PER_SLOT) return 'degrade'
  return 'reissue'
}

/**
 * `reissueDecision` の boolean 版（CR-003(A) が指定したシグネチャ）。
 * **判定は `reissueDecision` 1 箇所に閉じる**（AC-RL-8: 複製を作らない）。
 */
export function shouldReissue(input: {
  visibilityState: string
  now: number
  expiresAt: number
  reissueCount: number
}): boolean {
  return reissueDecision(input) === 'reissue'
}

const SIDE_LABEL: Record<'front' | 'back', string> = { front: '表面', back: '裏面' }

/**
 * ローカル検証（E-009-1 / E-009-2）。
 * **エラー文言にファイル名を含めない**——ファイル名は氏名や日付を含むことがあり、
 * PII のエコーバックにあたる（ui-design §3）。
 */
async function validateLocally(file: File): Promise<{ ok: true; type: string } | { ok: false; message: string }> {
  if (file.size > MAX_LICENSE_PHOTO_BYTES) {
    return {
      ok: false,
      message:
        'ファイルサイズが大きすぎます（5MB以下）。カメラアプリの設定で画質を下げるか、別の写真をお選びください。',
    }
  }
  if (file.size < 1) {
    return { ok: false, message: 'この画像を読み込めませんでした。別の写真をお試しください。' }
  }

  let prefix: Uint8Array
  try {
    // **先頭 12 バイトだけを読む**（5MB をメモリへ載せない / サーバー側と同じ原則）。
    prefix = new Uint8Array(await file.slice(0, MAGIC_BYTES_NEEDED).arrayBuffer())
  } catch {
    return { ok: false, message: 'この画像を読み込めませんでした。別の写真をお試しください。' }
  }

  // ⚠️ **拡張子も `file.type`（申告値）も信じない。** 実体を見る。
  const detected = detectImageType(prefix)
  if (detected === null || !ALLOWED_IMAGE_CONTENT_TYPES.includes(detected)) {
    return { ok: false, message: 'JPEG・PNG・WebP の画像を選んでください。' }
  }
  return { ok: true, type: detected }
}

export function LicensePhotoUpload({
  side,
  onChange,
}: {
  side: 'front' | 'back'
  onChange: (photo: AttachedLicensePhoto | null) => void
}) {
  const [state, setState] = useState<SlotState>({ kind: 'empty' })
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reissueCountRef = useRef(0)
  /** 生成した `blob:` URL。**解放しないとタブが生きている限りメモリに残る。** */
  const previewUrlRef = useRef<string | null>(null)

  const releasePreview = useCallback(() => {
    if (previewUrlRef.current !== null) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [])

  useEffect(() => releasePreview, [releasePreview])

  /** 発行 → PUT。**発行数の制限が唯一の帯域防御**なので、無駄な発行を呼ばない。 */
  const issueAndUpload = useCallback(
    async (file: File, contentType: string, previewUrl: string) => {
      setState({ kind: 'issuing', previewUrl })

      let response: Response
      try {
        response = await fetch('/api/uploads/license', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // ⚠️ **`objectKey` を送らない**（AC-009-1）。サーバーが生成する。
          body: JSON.stringify({ side, contentType, size: file.size }),
        })
      } catch {
        setState({ kind: 'failed', previewUrl, message: '通信できませんでした。もう一度お試しください。' })
        return
      }

      if (response.status !== 200) {
        // 発行拒否（403 / 429 / 500）。**理由は区別しない**（サーバーが区別させない / AC-009-7）。
        setState({
          kind: 'failed',
          previewUrl,
          message: 'いま写真を受け付けられませんでした。時間をおいてもう一度お試しください。',
        })
        return
      }

      const issued = (await response.json().catch(() => null)) as {
        objectKey?: string
        uploadToken?: string
        uploadUrl?: string
      } | null
      if (!issued?.objectKey || !issued.uploadToken || !issued.uploadUrl) {
        setState({ kind: 'failed', previewUrl, message: 'いま写真を受け付けられませんでした。' })
        return
      }

      /*
       * ⚠️ **ローカルストレージアダプタは HTTP で PUT できる URL を返さない**
       * （`local-storage:<hash>` という不透明なハンドル）。
       * Vercel Blob アダプタが有効なときだけ実 PUT が成立する。
       * **ここを「成功したことにしない」**——`uploaded` にすると、実際にはバイトが
       * 1 つも格納されていないのに「添付しました」と表示することになり、
       * 送信時にサーバー側の実体検証（`head()` が null）で必ず落ちる。
       */
      if (!/^https?:\/\//.test(issued.uploadUrl)) {
        setState({
          kind: 'failed',
          previewUrl,
          message: 'この環境では写真のアップロードをご利用いただけません。',
        })
        return
      }

      setState({ kind: 'uploading', previewUrl, percent: 0 })

      // **進捗は determinate**（ui-design §2）。`fetch` はリクエストボディの進捗を出せないので
      // `XMLHttpRequest.upload.onprogress` を使う（実装可能性上の確定事項）。
      await new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', issued.uploadUrl!)
        xhr.setRequestHeader('content-type', contentType)
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return
          setState({
            kind: 'uploading',
            previewUrl,
            percent: Math.round((event.loaded / event.total) * 100),
          })
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            reissueCountRef.current = 0
            setState({
              kind: 'uploaded',
              previewUrl,
              objectKey: issued.objectKey!,
              uploadToken: issued.uploadToken!,
              // `uploadToken` は 600 秒（SPEC-003）。
              expiresAt: Date.now() + 600_000,
            })
            onChange({ side, objectKey: issued.objectKey!, uploadToken: issued.uploadToken! })
          } else {
            setState({ kind: 'failed', previewUrl, message: '写真を送信できませんでした。' })
          }
          resolve()
        }
        xhr.onerror = () => {
          setState({ kind: 'failed', previewUrl, message: '写真を送信できませんでした。' })
          resolve()
        }
        xhr.send(file)
      })
    },
    [onChange, side],
  )

  const handleFile = useCallback(
    async (file: File | null) => {
      setError(null)
      onChange(null)
      if (file === null) {
        releasePreview()
        setState({ kind: 'empty' })
        return
      }

      const checked = await validateLocally(file)
      if (!checked.ok) {
        // **スロットは `Empty` のまま**（ui-design §3）。アップロードしない。
        releasePreview()
        setState({ kind: 'empty' })
        setError(checked.message)
        return
      }

      releasePreview()
      const previewUrl = URL.createObjectURL(file)
      previewUrlRef.current = previewUrl
      reissueCountRef.current = 0
      await issueAndUpload(file, checked.type, previewUrl)
    },
    [issueAndUpload, onChange, releasePreview],
  )

  /* ------------------------------------------------------------------ *
   * 自動再発行（SPEC-009 / AC-009-11）
   * ------------------------------------------------------------------ */

  /**
   * ⚠️ **抑止は「タイマーを止める」ではなく「遷移の発火条件」に置く**（ui-design §2）。
   * タイマーだけ止めると、**バックグラウンドから復帰した瞬間にまとめて発火する**実装になりうる。
   * ここでは毎 tick で `document.visibilityState` を読み、hidden なら**何もしない**。
   *
   * これが守れないと、SPEC-009 が警告した
   * 「タブを開いたまま放置すると 8 分ごとに発行 + PUT が永久に繰り返される」
   * ＝ **正規利用者が自分で自分をレート制限に到達させる**経路になる（AC-009-5 と衝突する）。
   */
  useEffect(() => {
    if (state.kind !== 'uploaded') return
    const timer = setInterval(() => {
      // **判定は `reissueDecision` 1 箇所に閉じる。** ここに条件を書き足さないこと
      //（書き足した瞬間、unit で測れる判定と実際に走る判定が分岐する）。
      const decision = reissueDecision({
        visibilityState: typeof document === 'undefined' ? 'visible' : document.visibilityState,
        now: Date.now(),
        expiresAt: state.expiresAt,
        reissueCount: reissueCountRef.current,
      })
      if (decision === 'wait') return
      if (decision === 'degrade') {
        setState({
          kind: 'degraded',
          previewUrl: state.previewUrl,
          objectKey: state.objectKey,
          uploadToken: state.uploadToken,
        })
        return
      }
      reissueCountRef.current += 1
      const file = inputRef.current?.files?.[0]
      if (!file) return
      void validateLocally(file).then((checked) => {
        if (checked.ok) void issueAndUpload(file, checked.type, state.previewUrl)
      })
    }, REISSUE_TICK_MS)
    return () => clearInterval(timer)
  }, [issueAndUpload, state])

  /* ------------------------------------------------------------------ *
   * 削除（AC-009-10 / SPEC-011）
   * ------------------------------------------------------------------ */

  const remove = useCallback(async () => {
    const attached =
      state.kind === 'uploaded' || state.kind === 'degraded'
        ? { objectKey: state.objectKey, uploadToken: state.uploadToken }
        : null

    releasePreview()
    setState({ kind: 'empty' })
    setError(null)
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''

    if (attached === null) return
    // 失敗しても利用者には影響しない（orphan 回収バッチが 24 時間後に消す）。
    await fetch('/api/uploads/license', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(attached),
    }).catch(() => undefined)
  }, [onChange, releasePreview, state])

  const previewUrl =
    state.kind === 'empty' ? null : 'previewUrl' in state ? state.previewUrl : null

  return (
    <div className="rounded-lg border border-border p-4">
      <p className="font-bold text-text-primary">運転免許証 {SIDE_LABEL[side]}（任意）</p>
      <p className="mt-1 text-caption text-text-secondary">
        JPEG・PNG・WebP / 5MB以下。お持ちでない場合は空欄のままで構いません。
      </p>

      <label className="mt-3 block">
        <span className="sr-only">運転免許証 {SIDE_LABEL[side]} の画像を選ぶ</span>
        <input
          ref={inputRef}
          type="file"
          data-testid={`license-photo-${side}`}
          // **フィルタであって検証ではない**（ui-design §3）。`capture` は付けない
          // ——付けると撮影済みの写真をライブラリから選ぶ導線が失われる。
          accept={ALLOWED_IMAGE_CONTENT_TYPES.join(',')}
          onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
          className="block w-full text-caption"
        />
      </label>

      {error !== null && (
        <p
          data-testid={`license-photo-${side}-error`}
          role="alert"
          className="mt-2 text-caption text-danger"
        >
          {error}
        </p>
      )}

      {previewUrl !== null && (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid={`license-photo-${side}-preview`}
            src={previewUrl}
            alt={`運転免許証 ${SIDE_LABEL[side]} のプレビュー`}
            className={`max-h-40 rounded border border-border ${
              state.kind === 'uploaded' || state.kind === 'degraded' ? '' : 'opacity-60'
            }`}
          />
          {state.kind === 'uploading' && (
            <p className="mt-1 text-caption text-text-secondary">
              送信しています… {state.percent}%
            </p>
          )}
          {state.kind === 'issuing' && (
            <p className="mt-1 text-caption text-text-secondary">準備しています…</p>
          )}
          {state.kind === 'uploaded' && (
            <p className="mt-1 text-caption text-success">✓ 添付しました</p>
          )}
          {state.kind === 'degraded' && (
            <p className="mt-1 text-caption text-warning">
              ✓ 添付しました。送信時に、お手数ですが写真をもう一度お選びください。
            </p>
          )}
          {state.kind === 'failed' && (
            <p
              data-testid={`license-photo-${side}-error`}
              role="alert"
              className="mt-1 text-caption text-danger"
            >
              ⚠ {state.message}
            </p>
          )}
          <button
            type="button"
            data-testid={`license-photo-${side}-remove`}
            onClick={() => void remove()}
            className="mt-2 text-caption text-primary-700 underline"
          >
            削除する
          </button>
        </div>
      )}
    </div>
  )
}
