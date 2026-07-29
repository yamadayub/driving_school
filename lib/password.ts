/**
 * パスワードのハッシュ生成・照合（F-012 管理者認証 / Credentials 方式, login.md）。
 *
 * 形式は seed（prisma/seed.ts）と互換の `scrypt$<saltHex>$<hashHex>`。
 * 純関数として分離し、Auth.js Credentials Provider の authorize から呼ぶ（単体テスト可能に保つ）。
 *
 * 【SEC-009 / RV-P2-004】**非同期契約**（P2 差し戻し修正で同期版から変更）。
 * `scryptSync` は Node のイベントループを丸ごとブロックする（1回あたり数十ms）。認証は未認証の
 * 第三者が任意に発火できる唯一の重い処理であり、並行 POST だけで公開サイト全体を停止させられた
 * （実測として「3ブラウザ同時ログインで dev サーバが過負荷 → E2E flaky」が phase-status.md に記録）。
 * callback 版 `scrypt` を promisify し、libuv スレッドプールで実行させる。
 * 同期版は残さない（authorize が誤って同期版を呼ぶ余地を無くすため）。
 *
 * 実装:
 *  - hashPassword: randomBytes(16) + scrypt(pw, salt, 64)。seed の形式と同一。
 *  - verifyPassword: stored をパースし、同一 salt で再ハッシュ→ timingSafeEqual で**定数時間比較**。
 *    形式不正・パース不能・長さ不一致は例外を投げず false を返す（E-012-1 の汎用失敗として扱う）。
 *  - 実運用の秘密はハードコードしない（デモ資格情報は .env / docs/dev-database.md）。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const SCRYPT_KEYLEN = 64
const SALT_BYTES = 16

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

/** 平文パスワードを `scrypt$<saltHex>$<hashHex>` 形式のハッシュ文字列にする。 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scryptAsync(plain, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

/** 平文と保存済みハッシュを照合する。形式不正時も例外を投げず false を返す。 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 3) return false
    const [scheme, saltHex, hashHex] = parts
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
    // 16進として妥当か（不正文字は Buffer.from が黙って切り詰めるため事前検証）
    if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false

    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    if (expected.length !== SCRYPT_KEYLEN) return false

    const actual = await scryptAsync(plain, salt, SCRYPT_KEYLEN)
    // 長さが一致している前提で定数時間比較（timingSafeEqual は長さ不一致で throw する）
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
