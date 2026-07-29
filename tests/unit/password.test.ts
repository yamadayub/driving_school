import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '@/lib/password'

/**
 * F-012 / US-011 — パスワード照合ロジック（Credentials 方式, login.md）。
 * 対象モジュール（想定契約）: @/lib/password の hashPassword / verifyPassword。
 * 形式は seed（prisma/seed.ts）互換の `scrypt$<saltHex>$<hashHex>`。
 *
 * 【SEC-009 / RV-P2-004 による契約変更（P2 差し戻し修正）】
 * `scryptSync` は Node のイベントループを丸ごとブロックする（1回あたり数十ms）。認証は未認証の
 * 第三者が任意に発火できる唯一の重い処理であり、並行 POST だけで公開サイト全体を停止させられる
 * （SEC-009 High）。実測としても「3ブラウザ同時ログインで dev サーバが過負荷 → E2E flaky」が
 * docs/phase-status.md に記録され、テスト戦略（管理系のクロスブラウザ検証）を歪めている。
 *
 * よって **hashPassword / verifyPassword を非同期（Promise を返す）契約に変更**する。
 * 内部は `promisify(scrypt)`（callback 版）でスレッドプール実行にすること。`authorize` は既に
 * async なので呼び出し側の変更は最小。定数時間比較（timingSafeEqual）と「形式不正でも throw せず
 * false」の性質は**現状どおり維持**する。
 *
 * red 理由: 現在の lib/password.ts は同期関数（string / boolean を返す）。
 *  - 「Promise を返す」契約テストは `instanceof Promise` が false で落ちる
 *  - `await hashPassword(...)` は同期の戻り値をそのまま解決するため一部は通るが、
 *    `verifyPassword` に **Promise ではなく string** を渡す形になる下記ラウンドトリップは
 *    `stored.split is not a function` ではなく「await 済み文字列」で通ってしまうため、
 *    契約テスト（Promise 判定）を独立させて red を担保している。
 *
 * 注意: 平文/ハッシュはデモ用のみ。実運用の秘密は使わない。
 */
const DEMO_PW = 'admin_dev_pw' // docs/dev-database.md のデモ資格情報（開発用ダミー）

describe('SEC-009: 非同期契約（イベントループを塞がない）', () => {
  it('hashPassword は Promise<string> を返す', () => {
    const returned = hashPassword(DEMO_PW)
    expect(returned).toBeInstanceOf(Promise)
    return expect(returned).resolves.toEqual(expect.any(String))
  })

  it('verifyPassword は Promise<boolean> を返す', async () => {
    const stored = await hashPassword(DEMO_PW)
    const returned = verifyPassword(DEMO_PW, stored)
    expect(returned).toBeInstanceOf(Promise)
    await expect(returned).resolves.toEqual(expect.any(Boolean))
  })
})

describe('F-012: hashPassword', () => {
  it('scrypt$<saltHex>$<hashHex> 形式を返す', async () => {
    const h = await hashPassword(DEMO_PW)
    expect(h).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/)
  })

  it('同じパスワードでも毎回異なるハッシュ（salt がランダム）', async () => {
    expect(await hashPassword(DEMO_PW)).not.toBe(await hashPassword(DEMO_PW))
  })
})

describe('F-012: verifyPassword', () => {
  it('正しいパスワードは true（生成→照合のラウンドトリップ）', async () => {
    const stored = await hashPassword(DEMO_PW)
    expect(await verifyPassword(DEMO_PW, stored)).toBe(true)
  })

  it('誤ったパスワードは false（E-012-1）', async () => {
    const stored = await hashPassword(DEMO_PW)
    expect(await verifyPassword('wrong_password', stored)).toBe(false)
  })

  it('形式不正な stored は例外を投げず false', async () => {
    expect(await verifyPassword(DEMO_PW, 'not-a-valid-hash')).toBe(false)
    expect(await verifyPassword(DEMO_PW, '')).toBe(false)
    expect(await verifyPassword(DEMO_PW, 'scrypt$deadbeef')).toBe(false)
  })

  it('seed（prisma/seed.ts）が作る同一形式のハッシュと相互運用できる', async () => {
    // seed 側は scryptSync で作るが、鍵長 64 バイト・同一 salt 形式のため非同期版でも照合できる。
    const stored = await hashPassword(DEMO_PW)
    const [scheme, saltHex, hashHex] = stored.split('$')
    expect(scheme).toBe('scrypt')
    expect(Buffer.from(saltHex, 'hex')).toHaveLength(16)
    expect(Buffer.from(hashHex, 'hex')).toHaveLength(64)
  })
})
