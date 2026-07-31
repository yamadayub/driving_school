/**
 * 公開ページの**応答本文**に秘密が出ていないかを実測する（SEC-098 の主防御）。
 *
 * -----------------------------------------------------------------------------
 * なぜ構文検査ではなくこれが主防御なのか
 * -----------------------------------------------------------------------------
 * `check-protected-paths.mjs` の秘密検査は「`process.env.X` のような**書き方**」を探す
 * 拒否リストである。3回目の監査は 6 通り以上の迂回を示し、決定的な形を実証した:
 *
 *   1. `components/VibeLeakProbe.tsx` を新規作成（`getServerEnv()` を描画するだけ）
 *   2. 既存の `app/(public)/privacy/page.tsx` に 1 行足して差し込む
 *
 * `process.env` という文字列はどこにも現れない。**許可パス検査・型チェック・単体テスト・
 * ビルドの4つすべてが緑のまま通り**、未認証の `GET /privacy` が `AUTH_SECRET` を返した。
 *
 * `AUTH_SECRET` はセッション JWT の署名鍵である。これを得た者は管理者セッションを
 * 自分で発行できる。「管理者セッション = デプロイ権限」という受け入れ済みの前提は、
 * **管理者セッションが奪われないこと**を土台にしている。その土台が崩れる。
 *
 * したがって**書き方ではなく結果を見る。** どんな書き方で読み出そうと、
 * 応答本文に値が出れば必ず捕まる。**迂回形を列挙する必要がない**のが要点である。
 *
 * -----------------------------------------------------------------------------
 * 使い方
 * -----------------------------------------------------------------------------
 *   node scripts/check-secret-leak.mjs http://localhost:3000
 *
 * CI では既知のダミー値を env に与えているので、探すべき文字列はこちらが知っている。
 * 本番の値は使わない（このスクリプトを本番へ向けて実行しないこと）。
 */

/** 応答に出てはならない env。**`NEXT_PUBLIC_` はブラウザへ出る前提なので対象外。** */
const SECRET_KEYS = [
  'AUTH_SECRET',
  'FORM_SESSION_SECRET',
  'CRON_SECRET',
  'TURNSTILE_SECRET',
  'KV_REST_API_TOKEN',
  'KV_REST_API_READ_ONLY_TOKEN',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PASSWORD',
  'BLOB_READ_WRITE_TOKEN',
  'RESEND_API_KEY',
  'GITHUB_DISPATCH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ADMIN_PASSWORD',
]

/** 検査する公開ルート。**新しい経路は作れない**ので（SEC-098）、この一覧で尽きる。 */
const ROUTES = ['/', '/courses', '/programs', '/schools', '/privacy', '/apply']

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '')

/**
 * 探す値。**短すぎる値は偶然一致するので除く**（例: `NODE_ENV=production`）。
 * 12 文字未満は誤検知が実害を上回るため対象にしない——CI のダミー値はいずれも十分長い。
 */
const needles = SECRET_KEYS.map((key) => ({ key, value: process.env[key] })).filter(
  (entry) => typeof entry.value === 'string' && entry.value.length >= 12,
)

if (needles.length === 0) {
  console.error('[leak] 検査対象の秘密が env に1つもありません。**検査が空振りします。**')
  console.error('     CI のダミー値が渡っているか確認してください（fail-closed で中止）。')
  process.exit(2)
}

console.log(`[leak] ${needles.length} 個の秘密を ${ROUTES.length} ルートで検査します。`)

let failed = false

for (const route of ROUTES) {
  const url = `${baseUrl}${route}`
  let body
  let status
  try {
    const response = await fetch(url, { redirect: 'follow' })
    status = response.status
    body = await response.text()
  } catch (error) {
    // ⚠️ **取得できないことを「安全」と読まない**（fail-closed）。
    console.error(`[leak] ✗ ${route} を取得できませんでした: ${error.message}`)
    failed = true
    continue
  }

  const found = needles.filter((entry) => body.includes(entry.value))
  if (found.length > 0) {
    console.error(`[leak] ✗ ${route} (${status}) の応答に秘密が含まれています:`)
    for (const entry of found) console.error(`        - ${entry.key}`)
    failed = true
  } else {
    console.log(`[leak] ✓ ${route} (${status})`)
  }
}

if (failed) {
  console.error('')
  console.error('[leak] 公開ページの応答に秘密が出ています。push を中止します。')
  console.error('見た目を変えるだけの変更で、サーバー側の値を描画する必要はありません。')
  process.exit(1)
}

console.log('[leak] 公開ルートの応答に秘密は含まれていません。')
