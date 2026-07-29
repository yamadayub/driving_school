import { describe, it, expect } from 'vitest'
import { ageEligibilityBoundaryDate, isAgeEligible } from '@/lib/age-eligibility'

/**
 * =========================================================================
 * P3-b — AC-008-8 / SPEC-007: 年齢下限の判定（サーバー受信日 JST 基準の純関数）
 * =========================================================================
 *
 * 出典: `docs/functional-spec.md` v0.3.3 F-008 境界値表 / SPEC-007（:498-506）/ AC-008-8（:539）、
 *       §4.5 バリデーション共通ルール（:1408）。
 *
 * ## 契約（Impl が実装すべきシグネチャ）
 * ```ts
 * // lib/age-eligibility.ts
 * /** `birthDate + 18年 - 1ヶ月` の暦日（YYYY-MM-DD, JST）。存在しない日は当月末へ丸める。 *\/
 * export function ageEligibilityBoundaryDate(birthDate: string): string
 * /** 判定。基準日は **receivedAt を JST の暦日に落とした値**。クライアント値は一切使わない。 *\/
 * export function isAgeEligible(input: { birthDate: string; receivedAt: Date }): boolean
 * ```
 * `birthDate` は `YYYY-MM-DD` の**文字列**で受ける。`Date` で受けると「どのタイムゾーンの
 * 0 時か」が呼び出し側に漏れ、**サーバーの TZ 設定で判定が変わる**（AC-008-8 が禁じている状態）。
 *
 * ## ⚠️ 仕様の内部矛盾と本テストが採った読み（Senior / Spec への申し送り T-Q1）
 * SPEC-007 は次の3つを同時に書いているが、**(2) と (1)(3) が1日ずれる**。
 *   (1) 定義: **`birthDate + 18年 - 1ヶ月 <= 受信日`** なら可
 *   (2) 境界値: (a) 17歳11ヶ月**0日** → 不可 / (b) 17歳11ヶ月**1日** → 可
 *   (3) (b) の注記: 「(b) ＝ **18歳の誕生日のちょうど1ヶ月前**」/ §4.5「入校可能年齢: 18歳の誕生日1ヶ月前〜」
 * 生年月日 2008-04-15 の場合、「18歳の誕生日のちょうど1ヶ月前」= 2026-03-15 であり、
 * この日は満年齢で **17歳11ヶ月0日**である。つまり (2) のラベルだけが (1)(3) と食い違う。
 * **本テストは (1) の定義式を真実源として採る**（(1) が「定義」と明記され、(3) と現行 FAQ の
 * 「誕生日の1ヶ月前から入校可」とも一致し、2 対 1 で整合するため）。
 * すなわち **境界日ちょうど = 可 / 境界日の前日 = 不可**。テスト名では満年齢のラベルを使わず、
 * **境界日そのもの**で書く（ラベルの解釈違いでテストの意味が変わらないようにするため）。
 */

/** 2026 年は閏年ではない（2026-02-29 は存在しない）。月末丸めの検証に使う。 */
const NON_LEAP_FEB_END = '2026-02-28'

/** JST の暦日 `date` の 00:00:00.000 を表す UTC インスタント。 */
function jstMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+09:00`)
}

describe('AC-008-8 / SPEC-007: 境界日の算出（暦月・月末丸め）', () => {
  it('通常の生年月日は「18歳の誕生日の1ヶ月前」が境界日になる', () => {
    // これが green なら排除される壊れた実装: 「18年 - 30日」のように**日数で近似**する実装
    //（月ごとに1〜2日ずれ、特定の月の生まれだけが不当に弾かれる／通る）。
    expect(ageEligibilityBoundaryDate('2008-04-15')).toBe('2026-03-15')
    expect(ageEligibilityBoundaryDate('2008-01-01')).toBe('2025-12-01')
  })

  it('存在しない日は当月末へ丸める（2008-03-29/30/31 → 2026-02-28）', () => {
    // SPEC-007 の worked example そのもの。
    // これが green なら排除される壊れた実装: `new Date(2026, 1, 31)` の**桁溢れ**で
    // 2026-03-03 へ繰り上がる実装（＝ 3月末生まれだけ境界日が 3日遅くなり、
    // 「存在しない 2月29〜31日」を無効にしないという要求が破れる）。
    for (const birth of ['2008-03-29', '2008-03-30', '2008-03-31']) {
      expect(ageEligibilityBoundaryDate(birth), birth).toBe(NON_LEAP_FEB_END)
    }
  })

  it('閏日生まれ（2008-02-29）は (年+18, 月-1, 日) を1回だけ丸めて算出する', () => {
    // ⚠️ 申し送り T-Q2: SPEC-007 は (d)「うるう日生まれの判定」を要求するが**期待値を書いていない**。
    // 本テストは **1回だけ丸める**（= 2026-01-29 は実在するので丸めない）を確定値として固定する。
    // 「+18年してから丸め、さらに -1ヶ月」（→ 2026-01-28）を採らないのは、丸めが2回入ると
    // **丸めの順序という第2の暗黙仕様**が生まれ、実装ごとに1日ずれるため。
    // これが green なら排除される壊れた実装: 丸め順序が未定義のまま実装され、
    // 閏日生まれだけ判定が1日ぶれる状態（レビューでも気付けない）。
    expect(ageEligibilityBoundaryDate('2008-02-29')).toBe('2026-01-29')
  })

  it('境界日の算出はサーバーのローカルタイムゾーンに依存しない（純粋な暦計算）', () => {
    // これが green なら排除される壊れた実装: `new Date(birthDate)` を経由し、
    // 実行環境の TZ で日付が前後する実装（UTC 実行と JST 実行で結果が変わる）。
    const original = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      expect(ageEligibilityBoundaryDate('2008-04-15')).toBe('2026-03-15')
      process.env.TZ = 'Asia/Tokyo'
      expect(ageEligibilityBoundaryDate('2008-04-15')).toBe('2026-03-15')
    } finally {
      process.env.TZ = original
    }
  })
})

describe('AC-008-8 / SPEC-007: 判定の境界値（定義式 birthDate + 18年 - 1ヶ月 <= 受信日）', () => {
  const BIRTH = '2008-04-15'
  const BOUNDARY = '2026-03-15'

  it('(a) 境界日の前日は不可', () => {
    // これが green なら排除される壊れた実装: 比較を `<` ではなく `<=` の向きで書き違え、
    // **1日早い申込を受け付ける**実装（未成年の申込を受理してしまう）。
    expect(isAgeEligible({ birthDate: BIRTH, receivedAt: jstMidnight('2026-03-14') })).toBe(false)
  })

  it('(b) 境界日ちょうどは可', () => {
    // これが green なら排除される壊れた実装: 境界日を `<` で比較し、
    // **入校可能日の当日に申し込んだ正規利用者を弾く**実装（可用性側の欠陥）。
    expect(isAgeEligible({ birthDate: BIRTH, receivedAt: jstMidnight(BOUNDARY) })).toBe(true)
  })

  it('(c) 18歳の誕生日当日は可', () => {
    expect(isAgeEligible({ birthDate: BIRTH, receivedAt: jstMidnight('2026-04-15') })).toBe(true)
  })

  it('(d) 閏日生まれの境界（2008-02-29 → 2026-01-29）', () => {
    expect(isAgeEligible({ birthDate: '2008-02-29', receivedAt: jstMidnight('2026-01-28') })).toBe(
      false,
    )
    expect(isAgeEligible({ birthDate: '2008-02-29', receivedAt: jstMidnight('2026-01-29') })).toBe(
      true,
    )
  })

  it('(e) 月末丸めが効くケース（2008-03-31 → 2026-02-28）', () => {
    expect(isAgeEligible({ birthDate: '2008-03-31', receivedAt: jstMidnight('2026-02-27') })).toBe(
      false,
    )
    expect(
      isAgeEligible({ birthDate: '2008-03-31', receivedAt: jstMidnight(NON_LEAP_FEB_END) }),
    ).toBe(true)
  })

  it('十分に年上の生年月日は当然可（上限は設けない / REV-014）', () => {
    expect(isAgeEligible({ birthDate: '1970-01-01', receivedAt: jstMidnight('2026-07-29') })).toBe(
      true,
    )
  })
})

describe('AC-008-8: 基準日は「サーバー受信日（JST）」であり、UTC でもローカル TZ でもない', () => {
  const BIRTH = '2008-04-15'

  it('UTC で 2026-03-14T15:00Z（= JST 2026-03-15 00:00）は境界日として可になる', () => {
    // **本ファイルで最も重要なテスト。**
    // この瞬間は UTC では 3/14、米東部では 3/14 11:00、JST では 3/15 である。
    // これが green なら排除される壊れた実装: `receivedAt.toISOString().slice(0,10)`（= UTC 日付）や
    // `receivedAt.getFullYear()/getMonth()/getDate()`（= 実行環境のローカル日付）で基準日を取る実装。
    // どちらも **日本時間の 0:00〜9:00 に申し込んだ利用者だけ判定が 1日ぶん厳しくなる**。
    expect(isAgeEligible({ birthDate: BIRTH, receivedAt: new Date('2026-03-14T15:00:00.000Z') })).toBe(
      true,
    )
  })

  it('UTC で 2026-03-14T14:59:59.999Z（= JST 2026-03-14 23:59:59.999）はまだ不可', () => {
    // JST の日境界のちょうど手前。1ms の取り違え（`>=` / `>`）をここで固定する。
    expect(
      isAgeEligible({ birthDate: BIRTH, receivedAt: new Date('2026-03-14T14:59:59.999Z') }),
    ).toBe(false)
  })

  it('サーバーのローカル TZ を変えても判定は変わらない', () => {
    // これが green なら排除される壊れた実装: ローカル日付に依存し、
    // **デプロイ先の TZ 設定（Vercel は UTC / 開発機は JST）で本番と開発の判定が食い違う**状態。
    const instant = new Date('2026-03-14T15:00:00.000Z')
    const original = process.env.TZ
    const results: boolean[] = []
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati']) {
        process.env.TZ = tz
        results.push(isAgeEligible({ birthDate: BIRTH, receivedAt: instant }))
      }
    } finally {
      process.env.TZ = original
    }
    expect(new Set(results).size, `判定が TZ でぶれた: ${JSON.stringify(results)}`).toBe(1)
    expect(results[0]).toBe(true)
  })
})

describe('AC-008-8: 不正な生年月日は「可」にしない（fail-closed）', () => {
  // 入力は攻撃者が完全に制御する。**判定不能を「可」に倒すと年齢下限が消える。**
  const RECEIVED = jstMidnight('2026-07-29')

  it.each([
    ['実在しない日付', '2008-02-30'],
    ['実在しない月', '2008-13-01'],
    ['未来日', '2030-01-01'],
    ['空文字', ''],
    ['区切り違い', '2008/04/15'],
    ['ゼロ埋め無し', '2008-4-5'],
    ['時刻付き', '2008-04-15T00:00:00Z'],
    ['全角数字', '２００８-０４-１５'],
    ['前後空白', ' 2008-04-15 '],
    ['NUL 混入', '2008-04-15\u0000'],
    ['孤立サロゲート', '2008-04-\ud800'],
    ['右から左への上書き文字', '2008-04-15‮'],
    ['和暦', '平成20年4月15日'],
    ['巨大な年', '999999-04-15'],
    ['負の年', '-0008-04-15'],
  ])('%s（%j）は false（例外を投げない）', (_label, birthDate) => {
    // これが green なら排除される壊れた実装:
    //  (1) パース失敗時に例外が外へ抜けて 500 になる（Tier B / 400 に落ちるべきリクエストが失敗になる）、
    //  (2) `NaN` 比較が false になる性質に頼って**「不可」ではなく「可」に倒れる**実装。
    // SEC-042 の教訓に従い、ASCII だけでなく**非 ASCII・孤立サロゲート・制御文字**を入力に含めている。
    expect(() => isAgeEligible({ birthDate, receivedAt: RECEIVED })).not.toThrow()
    expect(isAgeEligible({ birthDate, receivedAt: RECEIVED })).toBe(false)
  })

  it('receivedAt が Invalid Date でも例外を投げず false', () => {
    expect(isAgeEligible({ birthDate: '2008-04-15', receivedAt: new Date('nope') })).toBe(false)
  })
})
