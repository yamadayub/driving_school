import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 結合テスト用 setup: dev DB（localhost:5433）へ接続するため .env を process.env に読み込む。
 * vitest は .env を自動読込しないため、seed.ts と同等の最小ローダで POSTGRES_* を注入する。
 * 既存の process.env を優先（CI で環境変数指定した場合を尊重）。
 */
function loadDotenv(path: string) {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

loadDotenv(resolve(process.cwd(), '.env'))
