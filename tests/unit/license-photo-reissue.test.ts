import { describe, it, expect } from 'vitest'
import {
  MAX_REISSUE_PER_SLOT,
  REISSUE_BEFORE_MS,
  shouldReissue,
} from '@/components/apply/LicensePhotoUpload'

/**
 * =========================================================================
 * P3-c2 — **AC-009-11 / SPEC-009**: 自動再発行の暴走防止（**判定の純関数**）
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` F-009 AC-009-11（:672）/ SPEC-009（:598-607）、
 *       `docs/review-p3c2-code-2026-07-29.md` CR-003。
 *
 * ## なぜ E2E から unit へ移したのか（CR-003）
 * 元の E2E は「3 秒待って発行 API が 0 件」を見ていたが、実装は
 * `REISSUE_TICK_MS = 30_000` / `REISSUE_BEFORE_MS = 120_000` であり、
 * **最初に再発行が起きうるのは発行から約 180 秒後**である。
 * さらにローカルアダプタでは状態が `failed` になり**タイマーがそもそも張られない**。
 * つまり **実装を丸ごと削除しても green** になっていた——二重の意味で何も測っていない。
 *
 * 申し送り原則 4「**空振りしているテストを green として報告しない**」に従い E2E を削除し、
 * **判定を純関数へ切り出して 30 秒待たずに全分岐を網羅する**（レビューの改善案 (A)）。
 *
 * ## SPEC-009 が防いでいるもの（原文）
 * > **タブを開いたまま放置すると 8 分ごとに（写真 2 枚なら発行 2 回 + PUT 2 回 × 最大 5MB）が
 * > 永久に繰り返される**。AC-009-5 が「発行数の制限が唯一の帯域防御」と定めている以上、
 * > この機構が発行数を膨らませる影響は無視できず、
 * > **正規利用者が自分で自分をレート制限に到達させる**経路になる。
 *
 * ## red 理由
 * `components/apply/LicensePhotoUpload.tsx` は判定を `useEffect` の中にインラインで持っており、
 * `shouldReissue` / `MAX_REISSUE_PER_SLOT` / `REISSUE_BEFORE_MS` を export していない。
 *
 * ## Impl が実装すべき契約
 *
 * ```ts
 * // components/apply/LicensePhotoUpload.tsx
 * export const MAX_REISSUE_PER_SLOT = 3       // AC-009-11(a)（確定）
 * export const REISSUE_BEFORE_MS = 120_000    // 残りがこれを切ったら再発行
 *
 * export function shouldReissue(input: {
 *   visibilityState: string
 *   now: number
 *   expiresAt: number
 *   reissueCount: number
 * }): boolean
 * ```
 *
 * `useEffect` の中はこの関数を呼ぶだけにする——
 * **判定がエフェクトの中にある限り、30 秒のタイマーを回さないと 1 行も検証できない。**
 */

const NOW = Date.UTC(2026, 6, 29, 6, 0, 0)

/** 既定の入力（期限が迫っていて、表示中で、上限未満＝ 再発行すべき状態）。 */
function input(overrides: Partial<Parameters<typeof shouldReissue>[0]> = {}) {
  return {
    visibilityState: 'visible',
    now: NOW,
    // 残り 60 秒（`REISSUE_BEFORE_MS` = 120 秒を切っている）。
    expiresAt: NOW + 60_000,
    reissueCount: 0,
    ...overrides,
  }
}

/* ========================================================================= *
 * AC-009-11(b): 非表示中は再発行しない
 * ========================================================================= */

describe('AC-009-11(b) / SPEC-009: タブが非表示の間は再発行しない', () => {
  it('visibilityState が hidden なら、他の条件が揃っていても false', () => {
    // **本ファイルで最も重要なテスト。**
    // これが green なら排除される事故: タブを開いたまま放置した利用者が
    // **8 分ごとに発行 + PUT（最大 5MB × 2 枚）を永久に繰り返し**、
    // **自分で自分をレート制限に到達させる**こと（AC-009-5 の帯域防御と衝突する）。
    expect(shouldReissue(input({ visibilityState: 'hidden' })), 'hidden でも再発行している').toBe(
      false,
    )
  })

  it('visible なら再発行する（機能不成立を作らない）', () => {
    // 抑止を効かせすぎて**期限切れの写真が黙って失効する**形を排除する。
    expect(shouldReissue(input())).toBe(true)
  })

  it('prerender など hidden 以外の値は再発行を止めない', () => {
    // 判定を `!== 'visible'` で書くと、`prerender` の一瞬で再発行が止まりうる。
    // 仕様が禁じているのは **hidden の間**である。
    expect(shouldReissue(input({ visibilityState: 'prerender' }))).toBe(true)
  })
})

/* ========================================================================= *
 * AC-009-11(a): 1 スロットあたり 3 回で停止
 * ========================================================================= */

describe('AC-009-11(a) / SPEC-009: 自動再発行は 1 スロット 3 回で止まる', () => {
  it('上限は 3 回（確定値）', () => {
    expect(MAX_REISSUE_PER_SLOT).toBe(3)
  })

  it('境界: 2 回目までは再発行し、3 回に達したら止まる', () => {
    expect(shouldReissue(input({ reissueCount: MAX_REISSUE_PER_SLOT - 1 })), '上限直前で止まっている').toBe(
      true,
    )
    expect(shouldReissue(input({ reissueCount: MAX_REISSUE_PER_SLOT })), '上限に達しても再発行している').toBe(
      false,
    )
  })

  it('上限を超えた回数でも再発行しない', () => {
    expect(shouldReissue(input({ reissueCount: MAX_REISSUE_PER_SLOT + 5 }))).toBe(false)
  })
})

/* ========================================================================= *
 * 期限の窓
 * ========================================================================= */

describe('SPEC-009: 期限が迫るまでは再発行しない（無駄な発行をしない）', () => {
  it('残りが更新窓より大きければ false', () => {
    // これが green なら排除される実装: tick のたびに無条件で再発行し、
    // **30 秒ごとに発行 API を叩く**こと（AC-009-5 の唯一の帯域防御を自ら食い潰す）。
    expect(shouldReissue(input({ expiresAt: NOW + REISSUE_BEFORE_MS + 1_000 }))).toBe(false)
  })

  it('境界: ちょうど更新窓なら再発行する', () => {
    expect(shouldReissue(input({ expiresAt: NOW + REISSUE_BEFORE_MS }))).toBe(true)
  })

  it('既に期限切れでも（上限内なら）再発行する', () => {
    // 期限切れは「もう手遅れ」ではない——`uploadToken` を取り直せば添付は救済できる。
    expect(shouldReissue(input({ expiresAt: NOW - 1_000 }))).toBe(true)
  })

  it('更新窓は uploadToken の寿命（600 秒）より短い', () => {
    // 窓が寿命以上だと**常に再発行**になり、抑止が消える。
    expect(REISSUE_BEFORE_MS).toBeGreaterThan(0)
    expect(REISSUE_BEFORE_MS).toBeLessThan(600_000)
  })
})

/* ========================================================================= *
 * 優先順位（複数条件が同時に成立する場合）
 * ========================================================================= */

describe('SPEC-009: 抑止条件はどれか 1 つでも成立すれば再発行しない', () => {
  it.each([
    ['hidden かつ上限到達', { visibilityState: 'hidden', reissueCount: MAX_REISSUE_PER_SLOT }],
    ['hidden かつ期限に余裕', { visibilityState: 'hidden', expiresAt: NOW + 600_000 }],
    ['上限到達かつ期限に余裕', { reissueCount: MAX_REISSUE_PER_SLOT, expiresAt: NOW + 600_000 }],
  ])('%s なら false', (_label, overrides) => {
    expect(shouldReissue(input(overrides))).toBe(false)
  })
})
