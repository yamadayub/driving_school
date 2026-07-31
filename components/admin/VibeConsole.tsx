'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Vibe Coding コンソール。
 *
 * 指示 → GitHub Actions → push → Vercel デプロイ、の4段階を追い、
 * **公開サイトに実際に反映されたことを確認してから**リロードを促す。
 *
 * ── なぜ Vercel のデプロイ完了まで待つのか ──────────────────────
 * Actions が成功しても、その時点ではまだ公開サイトは古い。ここでリロードを促すと
 * 「変わっていない」と誤認させる。Vercel が注入する `VERCEL_GIT_COMMIT_SHA` を
 * ポーリングし、**master の新しい SHA が公開側に現れるまで**待つ。
 * Vercel API のトークンを増やさずに判定できる（新しいデプロイが有効になれば、
 * 以降のリクエストは新しいデプロイに届くため）。
 *
 * ── なぜ一度押したら二度と押せないのか ────────────────────────
 * リロードするまで画面は古いコードのままなので、続けて指示を出すと
 * 「何がどの版に対する変更なのか」が分からなくなる。**押下は1回に限定し、
 * 続けるならリロードしてもらう。**
 *
 * **`data-testid` と入力ラベルは変更しないこと** — E2E が参照している。
 */

type RunState = {
  id: number
  status: string
  conclusion: string | null
  url: string
  createdAt: string
}

type Phase =
  | 'idle'
  | 'dispatching' // ワークフロー起動中
  | 'running' // Actions 実行中
  | 'deploying' // push 済み、Vercel のデプロイ待ち
  | 'deployed' // 公開サイトに反映済み
  | 'nochange' // 成功したが変更が発生しなかった
  | 'failed' // ゲートで止まった

const EXAMPLES = [
  'トップのヒーローの上下の余白を広げて、見出しを一回り大きくして',
  'コースカードを2列に並べて、影を少し強くして',
  'お知らせ一覧に投稿日を大きく表示して',
]

const POLL_MS = 5000
/** 起動直後は前回の実行が返るので、これより古い run は「新しい実行」とみなさない。 */
const FRESH_WINDOW_MS = 120_000
/** デプロイ待ちの上限。Vercel が詰まっている場合に無限に回さない。 */
const DEPLOY_TIMEOUT_MS = 600_000

async function post<T>(body: Record<string, unknown>): Promise<T | null> {
  const response = await fetch('/api/admin/vibe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) return null
  return (await response.json()) as T
}

export function VibeConsole() {
  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [run, setRun] = useState<RunState | null>(null)
  const [error, setError] = useState('')
  /** 一度でも押したか。リロードするまで false に戻さない。 */
  const [submitted, setSubmitted] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const schedule = useCallback((fn: () => void) => {
    timer.current = setTimeout(fn, POLL_MS)
  }, [])

  /** 公開サイトが新しい SHA になるまで待つ。 */
  const waitForDeploy = useCallback(
    async (targetSha: string, startedAt: number) => {
      const result = await post<{ sha: string | null }>({ action: 'deployed' })
      if (result?.sha === targetSha) {
        setPhase('deployed')
        return
      }
      if (Date.now() - startedAt > DEPLOY_TIMEOUT_MS) {
        setError('デプロイの完了を確認できませんでした。しばらくしてからリロードしてください。')
        setPhase('deployed')
        return
      }
      schedule(() => void waitForDeploy(targetSha, startedAt))
    },
    [schedule],
  )

  /** Actions の完了を待ち、その後デプロイ待ちへ進む。 */
  const watchRun = useCallback(
    async (beforeHead: string | null, startedAt: number) => {
      const result = await post<{ run: RunState | null }>({ action: 'status' })
      const latest = result?.run ?? null
      const isNew =
        latest !== null && new Date(latest.createdAt).getTime() > startedAt - FRESH_WINDOW_MS
      if (isNew) setRun(latest)

      if (!isNew || latest.status !== 'completed') {
        schedule(() => void watchRun(beforeHead, startedAt))
        return
      }

      if (latest.conclusion !== 'success') {
        setPhase('failed')
        return
      }

      // 成功。コミットが積まれたか（= push されたか）を SHA で判定する。
      const head = await post<{ sha: string | null }>({ action: 'head' })
      if (!head?.sha || head.sha === beforeHead) {
        setPhase('nochange')
        return
      }
      setPhase('deploying')
      void waitForDeploy(head.sha, Date.now())
    },
    [schedule, waitForDeploy],
  )

  const submit = useCallback(async () => {
    if (!instruction.trim() || submitted) return
    setSubmitted(true)
    setError('')
    setRun(null)
    setPhase('dispatching')

    try {
      const before = await post<{ sha: string | null }>({ action: 'head' })
      const dispatched = await post<{ ok?: boolean }>({ action: 'dispatch', instruction })
      if (!dispatched?.ok) {
        setError('ワークフローを起動できませんでした。')
        setPhase('failed')
        return
      }
      setPhase('running')
      void watchRun(before?.sha ?? null, Date.now())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase('failed')
    }
  }, [instruction, submitted, watchRun])

  const finished = phase === 'deployed' || phase === 'nochange' || phase === 'failed'

  return (
    <div className="space-y-l">
      <div className="rounded-card border border-border bg-warning-bg p-m text-body-sm">
        <p className="font-bold text-text-primary">指示するとサイトが変わります</p>
        <p className="mt-s text-text-secondary">
          変更は GitHub 上で行われ、
          <strong className="text-text-primary">
            型チェック・単体テスト・ビルドがすべて通ったときだけ
          </strong>
          公開サイトに反映されます。認証・レート制限・データ構造・テストは変更できません。
          完了までおよそ 3〜6 分かかります。
        </p>
      </div>

      <div>
        <label htmlFor="vibe-instruction" className="block text-label text-text-primary">
          変更したい内容
        </label>
        <textarea
          id="vibe-instruction"
          data-testid="vibe-instruction"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={4}
          maxLength={2000}
          disabled={submitted}
          placeholder="例: トップページの見出しをもう少し大きくして、余白を広げて"
          className="mt-s w-full rounded border border-border p-m text-body focus:border-primary focus:outline-none disabled:bg-canvas disabled:text-text-secondary"
        />
        {!submitted && (
          <div className="mt-s flex flex-wrap gap-s">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setInstruction(example)}
                className="rounded-pill border border-border px-m py-xs text-caption text-text-secondary hover:border-primary hover:text-primary"
              >
                {example}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-m">
        <button
          type="button"
          data-testid="vibe-submit"
          onClick={submit}
          disabled={submitted || !instruction.trim()}
          className="rounded bg-accent px-l py-m text-label text-surface disabled:opacity-50"
        >
          この内容で変更する
        </button>

        {finished && (
          <button
            type="button"
            data-testid="vibe-reload"
            onClick={() => window.location.reload()}
            className="rounded border border-primary px-l py-m text-label text-primary"
          >
            {phase === 'deployed' ? '画面を更新して変更を見る' : '画面を更新してやり直す'}
          </button>
        )}
      </div>

      {submitted && (
        <div
          data-testid="vibe-status"
          className="rounded-card border border-border bg-canvas p-m text-body-sm"
        >
          <Steps phase={phase} />
          {error && <p className="mt-s font-bold text-danger">{error}</p>}
          {run && (
            <p className="mt-s">
              <a
                href={run.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                実行ログを開く
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const STEPS: ReadonlyArray<{ key: Phase; label: string }> = [
  { key: 'running', label: 'コードを変更して検査' },
  { key: 'deploying', label: '公開サイトへ反映' },
  { key: 'deployed', label: '完了' },
]

/** 進行を段階で見せる。「今どこにいて、あと何が残っているか」が分かる形にする。 */
function Steps({ phase }: { phase: Phase }) {
  if (phase === 'failed') {
    return (
      <p className="font-bold text-danger">
        通りませんでした。公開サイトは変更されていません。実行ログで原因を確認してください。
      </p>
    )
  }
  if (phase === 'nochange') {
    return (
      <p className="font-bold text-text-secondary">
        変更は発生しませんでした。指示の内容を具体的にすると変わりやすくなります。
      </p>
    )
  }

  const order: Phase[] = ['dispatching', 'running', 'deploying', 'deployed']
  const current = order.indexOf(phase)

  return (
    <ol className="space-y-xs">
      {STEPS.map((step) => {
        const index = order.indexOf(step.key)
        const done = current > index || phase === 'deployed'
        const active = current === index && phase !== 'deployed'
        return (
          <li
            key={step.key}
            className={done ? 'text-success' : active ? 'text-text-primary' : 'text-text-disabled'}
          >
            {done ? '✓' : active ? '…' : '　'} {step.label}
          </li>
        )
      })}
      {phase === 'deployed' && (
        <li className="mt-s font-bold text-success">
          公開サイトに反映されました。「画面を更新して変更を見る」を押してください。
        </li>
      )}
    </ol>
  )
}
