import { withAdminMutation } from '@/app/api/admin/_guard'

/**
 * Vibe Coding: 管理画面の指示で GitHub Actions を起動し、実行状況を返す。
 *
 * -----------------------------------------------------------------------------
 * ⚠️ 本番でも動作する。以前の「本番では 404」ガードは外した
 * -----------------------------------------------------------------------------
 * セキュリティ監査は当初この機能を「設計上の RCE」と評価し、**本番 404** を主要な緩和策と
 * していた。公開URLの管理画面から修正・デプロイしたいという要件を受けてそれを外している。
 * **したがって「管理者セッションを取られる = サイトのコードを書き換えて公開できる」** であり、
 * これは受け入れた上での設計である。
 *
 * その代わり、被害範囲を**構造的に**縛っている（プロンプトでの指示は強制ではないので当てにしない）:
 *
 *  1. このルートは**ワークフローを起動するだけ**でコードを実行しない。実行は GitHub 上。
 *  2. `GITHUB_DISPATCH_TOKEN` は **`Actions: write` のみ**。`Contents: write` を持たないので、
 *     このトークン単体ではコードもワークフロー定義も書き換えられない。
 *     **攻撃者が実行できるのは、リポジトリに既にコミットされたワークフローの内容だけ。**
 *  3. ワークフローは push の前に**保護パス検査 → type-check → unit → build** を通す。
 *     認証・レート制限・スキーマ・**テスト**・ワークフロー自身は変更できない
 *     （`scripts/check-protected-paths.mjs`）。
 *  4. 実行は GitHub Actions のログとコミット履歴に残る（消せない監査証跡）。
 *
 * -----------------------------------------------------------------------------
 * メソッドを POST に統一している理由
 * -----------------------------------------------------------------------------
 * `tests/unit/api-route-guard-coverage-p3b.test.ts` が `app/api/**` の全ルートを走査し、
 * **エクスポートされた全メソッドがラッパを経由していること**を強制する。
 * 状況取得を GET にすると、参照系にも変更系のラッパ（Origin 検証込み）を被せることになり
 * 意味がぼやける。`action` で分岐して POST 1 本にしている。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OWNER = 'yamadayub'
const REPO = 'driving_school'
const WORKFLOW = 'vibe.yml'
const API = 'https://api.github.com'

function gh(token: string) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export const POST = withAdminMutation(async (request: Request) => {
  const token = process.env.GITHUB_DISPATCH_TOKEN
  if (!token) {
    return Response.json(
      { error: 'GITHUB_DISPATCH_TOKEN が未設定です。' },
      { status: 503 },
    )
  }

  let action = 'dispatch'
  let instruction = ''
  try {
    const body: unknown = await request.json()
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>
      action = String(record.action ?? 'dispatch')
      instruction = String(record.instruction ?? '')
    }
  } catch {
    return Response.json({ error: 'リクエストを読み取れませんでした。' }, { status: 400 })
  }

  // ── 実行状況の取得 ────────────────────────────────────────────
  if (action === 'status') {
    const response = await fetch(
      `${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`,
      { headers: gh(token), cache: 'no-store' },
    )
    if (!response.ok) {
      return Response.json({ error: `GitHub API: ${response.status}` }, { status: 502 })
    }
    const data = (await response.json()) as {
      workflow_runs?: Array<{
        id: number
        status: string
        conclusion: string | null
        html_url: string
        created_at: string
      }>
    }
    const run = data.workflow_runs?.[0]
    return Response.json({
      run: run
        ? {
            id: run.id,
            status: run.status,
            conclusion: run.conclusion,
            url: run.html_url,
            createdAt: run.created_at,
          }
        : null,
    })
  }

  // ── master の最新コミット SHA と、そのコミットが触ったファイル ──
  // SHA は「ワークフローが実際にコミットを積んだか」の判定に使う。
  // 変更が発生しなかった場合 push されないので、SHA は動かない。
  //
  // `files` は**同じ応答に最初から入っている**（追加のリクエストは要らない）。
  // 完了後の「反映後の画面を確認する」の遷移先を、変更されたページから決めるために返す
  // （導出は `lib/vibe-target.ts`）。ここでは加工せず、ファイル名だけを渡す。
  if (action === 'head') {
    const response = await fetch(`${API}/repos/${OWNER}/${REPO}/commits/master`, {
      headers: gh(token),
      cache: 'no-store',
    })
    if (!response.ok) {
      return Response.json({ error: `GitHub API: ${response.status}` }, { status: 502 })
    }
    const data = (await response.json()) as {
      sha?: string
      files?: Array<{ filename?: string }>
    }
    const paths = (data.files ?? [])
      .map((file) => file?.filename)
      .filter((name): name is string => typeof name === 'string')
    return Response.json({ sha: data.sha ?? null, paths })
  }

  // ── いま公開されているデプロイのコミット SHA ──────────────────
  // Vercel が注入する `VERCEL_GIT_COMMIT_SHA` を返すだけ。**Vercel API のトークンを
  // 増やさずにデプロイ完了を判定できる**——新しいデプロイが有効になれば、以降の
  // リクエストは新しいデプロイに届き、返る SHA が変わる。
  if (action === 'deployed') {
    return Response.json({ sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null })
  }

  // ── ワークフローの起動 ────────────────────────────────────────
  if (!instruction.trim()) {
    return Response.json({ error: '指示が空です。' }, { status: 400 })
  }
  if (instruction.length > 2000) {
    return Response.json({ error: '指示が長すぎます（2000文字以内）。' }, { status: 413 })
  }

  const response = await fetch(
    `${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: { ...gh(token), 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'master', inputs: { instruction } }),
    },
  )

  if (response.status !== 204) {
    const detail = await response.text()
    return Response.json(
      { error: `ワークフローを起動できませんでした（${response.status}）`, detail: detail.slice(0, 300) },
      { status: 502 },
    )
  }

  return Response.json({ ok: true })
})
