/**
 * 決定的な擬似乱数源（テスト専用ヘルパ）。
 *
 * AC-RL-15(c) / AC-RL-12(c) が「乱数源を注入可能にし、固定シードで決定的に検証する」ことを
 * 要求しているため、テスト側にも「同一シードなら同一系列」を保証する実装を1つ置く。
 * `Math.random` を差し替える（グローバル汚染）のではなく、**値を引数で注入する**方針に揃える。
 *
 * アルゴリズムは mulberry32。32bit の状態を持つだけで周期・分布ともにテスト用途には十分で、
 * 実装が数行に収まるため「テストヘルパ自体のバグ」を持ち込みにくい。
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 指定した系列をそのまま返す乱数源。シャード候補の抽選を1回ずつ狙って作りたい場合に使う。
 * 系列を使い切ったら最後の値を返し続ける（テストが「長さ不足」で意図せず落ちないように）。
 */
export function scriptedRandom(values: readonly number[]): () => number {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}
