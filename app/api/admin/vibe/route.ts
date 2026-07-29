import { withAdminMutation } from '@/app/api/admin/_guard'

/**
 * Vibe Coding: 管理画面の指示をローカルランナーへ中継する（開発環境限定）。
 *
 * -----------------------------------------------------------------------------
 * このルートが**本番で必ず 404 を返す**理由
 * -----------------------------------------------------------------------------
 * ランナーは Claude Agent SDK でリポジトリのファイルを書き換え、git を操作する。
 * 管理者セッションを奪われた場合の被害が「お知らせの改竄」ではなく
 * **サイトのコードの書き換え**になるため、本番に経路を残すこと自体を許さない。
 *
 * 判定は `VERCEL` ではなく **`NODE_ENV === 'production'`** で行う。
 * `VERCEL` は Vercel 以外の本番配備で立たず、SEC-069（縮退構成から抜け出せない）と
 * 同じ「本番判定をホスティング事業者の環境変数に依存させる」誤りを繰り返さないため。
 *
 * -----------------------------------------------------------------------------
 * 多層防御
 * -----------------------------------------------------------------------------
 *  1. `withAdminMutation` — 管理者セッション必須 + Origin 検証（SEC-011 / SEC-024）
 *  2. 本ファイルの本番ガード（下記）
 *  3. 共有シークレット — ランナー側が `x-vibe-secret` を検証する
 *  4. ランナーが 127.0.0.1 にのみ bind し、書き込み先を軽量レーンへ限定する
 *
 * いずれか 1 つが破られても即座に任意コード実行にはならない形にしてある。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RUNNER_URL = process.env.VIBE_RUNNER_URL ?? 'http://127.0.0.1:4319/run'

export const POST = withAdminMutation(async (request: Request) => {
  // 本番では経路そのものを存在させない（401 ではなく 404 = 存在を教えない）。
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not Found', { status: 404 })
  }

  const secret = process.env.VIBE_RUNNER_SECRET
  if (!secret) {
    return Response.json(
      { error: 'VIBE_RUNNER_SECRET が未設定です。ランナーと同じ値を .env に設定してください。' },
      { status: 503 },
    )
  }

  let instruction = ''
  try {
    const body: unknown = await request.json()
    if (typeof body === 'object' && body !== null && 'instruction' in body) {
      instruction = String((body as { instruction: unknown }).instruction ?? '')
    }
  } catch {
    return Response.json({ error: '指示を読み取れませんでした。' }, { status: 400 })
  }

  if (!instruction.trim()) {
    return Response.json({ error: '指示が空です。' }, { status: 400 })
  }
  if (instruction.length > 2000) {
    return Response.json({ error: '指示が長すぎます（2000文字以内）。' }, { status: 413 })
  }

  let upstream: Response
  try {
    upstream = await fetch(RUNNER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vibe-secret': secret },
      body: JSON.stringify({ instruction }),
    })
  } catch {
    return Response.json(
      { error: 'ローカルランナーに接続できません。runner/ で pnpm start を実行してください。' },
      { status: 502 },
    )
  }

  // NDJSON をそのまま流す（進捗を逐次表示するため）。
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
})
