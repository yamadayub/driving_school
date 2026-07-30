'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Vibe Coding コンソール。
 *
 * 指示を送ると GitHub Actions を起動し、実行状況をポーリングして表示する。
 * コードの変更は GitHub 上で行われ、**保護パス検査 / 型チェック / 単体テスト / ビルドを
 * すべて通ったときだけ** push される。push されると Vercel が自動デプロイする。
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

const EXAMPLES = [
  'トップのヒーローの上下の余白を広げて、見出しを一回り大きくして',
  'コースカードを2列に並べて、影を少し強くして',
  'お知らせ一覧に投稿日を大きく表示して',
]

/** 起動直後は前回の実行が返るので、これより古い run は「新しい実行」とみなさない。 */
const FRESH_WINDOW_MS = 120_000

export function VibeConsole() {
  const [instruction, setInstruction] = useState('')
  const [run, setRun] = useState<RunState | null>(null)
  const [phase, setPhase] = useState<'idle' | 'dispatching' | 'watching' | 'done'>('idle')
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const fetchStatus = useCallback(async (): Promise<RunState | null> => {
    const response = await fetch('/api/admin/vibe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { run: RunState | null }
    return data.run
  }, [])

  const watch = useCallback(
    async (startedAt: number) => {
      const latest = await fetchStatus()
      // 起動直後は GitHub 側に run がまだ現れないことがあるので、
      // 「開始時刻より新しい run」が出るまでは待ち続ける。
      const isNew = latest !== null && new Date(latest.createdAt).getTime() > startedAt - FRESH_WINDOW_MS
      if (isNew) setRun(latest)

      if (isNew && latest.status === 'completed') {
        setPhase('done')
        return
      }
      timer.current = setTimeout(() => void watch(startedAt), 5000)
    },
    [fetchStatus],
  )

  const submit = useCallback(async () => {
    if (!instruction.trim() || phase === 'dispatching' || phase === 'watching') return
    setError('')
    setRun(null)
    setPhase('dispatching')

    try {
      const response = await fetch('/api/admin/vibe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch', instruction }),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? `起動できませんでした（${response.status}）`)
        setPhase('idle')
        return
      }
      setPhase('watching')
      void watch(Date.now())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase('idle')
    }
  }, [instruction, phase, watch])

  const busy = phase === 'dispatching' || phase === 'watching'

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
          完了までおよそ 2〜5 分かかります。
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
          disabled={busy}
          placeholder="例: トップページの見出しをもう少し大きくして、余白を広げて"
          className="mt-s w-full rounded border border-border p-m text-body focus:border-primary focus:outline-none disabled:bg-canvas"
        />
        <div className="mt-s flex flex-wrap gap-s">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={busy}
              onClick={() => setInstruction(example)}
              className="rounded-pill border border-border px-m py-xs text-caption text-text-secondary hover:border-primary hover:text-primary disabled:opacity-50"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        data-testid="vibe-submit"
        onClick={submit}
        disabled={busy || !instruction.trim()}
        className="rounded bg-accent px-l py-m text-label text-surface disabled:opacity-50"
      >
        {phase === 'dispatching' ? '起動中…' : phase === 'watching' ? '実行中…' : 'この内容で変更する'}
      </button>

      {error && (
        <p data-testid="vibe-error" className="text-body-sm font-bold text-danger">
          エラー: {error}
        </p>
      )}

      {(busy || run) && (
        <div data-testid="vibe-status" className="rounded-card border border-border bg-canvas p-m text-body-sm">
          <Status phase={phase} run={run} />
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

function Status({ phase, run }: { phase: string; run: RunState | null }) {
  if (phase === 'dispatching') return <p className="text-text-secondary">ワークフローを起動しています…</p>
  if (!run) return <p className="text-text-secondary">実行の開始を待っています…</p>

  if (run.status !== 'completed') {
    return (
      <p className="text-text-secondary">
        実行中です（{run.status}）。コードの変更 → 保護パス検査 → 型チェック → 単体テスト →
        ビルド の順に進みます。
      </p>
    )
  }

  if (run.conclusion === 'success') {
    return (
      <p className="font-bold text-success">
        完了しました。変更が公開サイトへ自動デプロイされます（反映まで 1〜2 分）。
      </p>
    )
  }

  return (
    <p className="font-bold text-danger">
      通りませんでした（{run.conclusion}）。**公開サイトは変更されていません。**
      ゲートで止まったか、変更が発生しなかった可能性があります。実行ログを確認してください。
    </p>
  )
}
