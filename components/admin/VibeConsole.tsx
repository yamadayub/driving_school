'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Vibe Coding コンソール（軽量レーン限定 / 開発環境のみ動作）。
 *
 * 指示を投げてローカルランナーの NDJSON 進捗を逐次表示する。
 * **`data-testid` と入力ラベルは変更しないこと**——このコンソール経由の変更が
 * E2E の参照先を壊さないよう、ランナー側のプロンプトでも同じ制約を課している。
 */

type RunEvent =
  | { type: 'branch'; branch: string }
  | { type: 'agent'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'denied'; tool: string; path?: string }
  | { type: 'gate'; name: string; status: 'running' | 'pass' | 'fail'; output?: string }
  | { type: 'commit'; branch: string; files: string[] }
  | { type: 'done'; ok: boolean; message?: string; branch?: string; denied?: number }
  | { type: 'error'; message: string }

const EXAMPLES = [
  'トップのヒーローの上下の余白を広げて、見出しを一回り大きくして',
  'コースカードを2列に並べて、影を少し強くして',
  'CTAボタンをもう少し目立たせて、角を丸くして',
]

export function VibeConsole() {
  const [instruction, setInstruction] = useState('')
  const [events, setEvents] = useState<RunEvent[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  const append = useCallback((event: RunEvent) => {
    setEvents((prev) => [...prev, event])
    queueMicrotask(() => {
      const node = logRef.current
      if (node) node.scrollTop = node.scrollHeight
    })
  }, [])

  const submit = useCallback(async () => {
    if (!instruction.trim() || running) return
    setRunning(true)
    setEvents([])

    try {
      const response = await fetch('/api/admin/vibe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction }),
      })

      if (!response.ok || !response.body) {
        const text = await response.text()
        let message = text
        try {
          message = String(JSON.parse(text).error ?? text)
        } catch {
          /* プレーンテキストのまま出す */
        }
        append({ type: 'error', message: message || `失敗しました（${response.status}）` })
        return
      }

      // NDJSON を行単位で読む。チャンク境界で行が割れるのでバッファを持つ。
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            append(JSON.parse(line) as RunEvent)
          } catch {
            /* 壊れた行は捨てる（表示のためだけの経路なので落とさない） */
          }
        }
      }
    } catch (error) {
      append({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setRunning(false)
    }
  }, [append, instruction, running])

  return (
    <div className="space-y-l">
      <div className="rounded-card border border-border bg-warning-bg p-m text-body-sm">
        <p className="font-bold text-text-primary">見た目の変更だけを受け付けます</p>
        <p className="mt-s text-text-secondary">
          変更できるのは画面部品（<code>components/</code>）の見た目だけです。フォームの項目追加、保存処理、
          ページ全体の構成、配色の定義そのものはこの画面からは変更できません。変更はブランチに記録され、
          型チェックが通った場合のみコミットされます。
          <strong className="text-text-primary">
            単体テストと E2E は実行されません
          </strong>
          ——差分を確認したうえで手元で回してください。
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
          disabled={running}
          placeholder="例: トップページの見出しをもう少し大きくして、余白を広げて"
          className="mt-s w-full rounded border border-border p-m text-body focus:border-primary focus:outline-none disabled:bg-canvas"
        />
        <div className="mt-s flex flex-wrap gap-s">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={running}
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
        disabled={running || !instruction.trim()}
        className="rounded bg-accent px-l py-m text-label text-surface disabled:opacity-50"
      >
        {running ? '変更中…' : 'この内容で変更する'}
      </button>

      {events.length > 0 && (
        <div
          ref={logRef}
          data-testid="vibe-log"
          className="max-h-[420px] overflow-y-auto rounded-card border border-border bg-canvas p-m font-mono text-caption"
        >
          {events.map((event, index) => (
            <LogLine key={index} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}

function LogLine({ event }: { event: RunEvent }) {
  switch (event.type) {
    case 'branch':
      return <p className="text-text-secondary">ブランチを作成: {event.branch}</p>
    case 'agent':
      return <p className="whitespace-pre-wrap text-text-primary">{event.text}</p>
    case 'tool':
      return <p className="text-text-disabled">→ {event.name}</p>
    case 'denied':
      return (
        <p className="text-danger">
          拒否: {event.tool}
          {event.path ? ` (${event.path})` : ''} — 軽量レーンの範囲外です
        </p>
      )
    case 'gate':
      return (
        <p className={event.status === 'fail' ? 'text-danger' : 'text-text-secondary'}>
          {event.name}: {event.status === 'running' ? '実行中…' : event.status === 'pass' ? '通過' : '失敗'}
          {event.status === 'fail' && event.output ? `\n${event.output}` : ''}
        </p>
      )
    case 'commit':
      return (
        <p className="text-success">
          コミットしました（{event.files.length} ファイル）: {event.branch}
        </p>
      )
    case 'done':
      return (
        <p className={event.ok ? 'font-bold text-success' : 'font-bold text-danger'}>
          {event.message ?? (event.ok ? '完了しました' : '完了しませんでした')}
        </p>
      )
    case 'error':
      return <p className="font-bold text-danger">エラー: {event.message}</p>
  }
}
