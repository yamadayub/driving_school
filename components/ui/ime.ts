'use client'

import { useRef, useState } from 'react'

/**
 * 日本語入力（IME）で壊れない制御コンポーネント用の props を作る。
 *
 * ------------------------------------------------------------------------
 * 何が起きるか
 * ------------------------------------------------------------------------
 * 制御コンポーネント（`value` を state から与える input）は、変換中にも
 * `input` イベントが飛んで再描画が走る。そのとき React が DOM の `value` を
 * 書き戻すと、**ブラウザの変換セッションが打ち切られる**。利用者には
 * 「一文字入力するたびにフォーカスが外れる」ように見える。
 *
 * 報告環境: macOS Chrome + Google 日本語入力（ひらがな / 直接入力）。
 * ⚠️ **合成イベント（`CompositionEvent` を dispatch）では再現しない。**
 * 実 IME でのみ起きるため、コードを読んだり自動テストを書いたりしても検出できない。
 * この関数を外すと戻る種類の不具合であることを覚えておくこと。
 *
 * ------------------------------------------------------------------------
 * どう防ぐか
 * ------------------------------------------------------------------------
 * **変換中は親の state を更新しない。** 未確定の文字列は自前で保持し（`draft`）、
 * `compositionend` で初めて確定値を親へ渡す。変換中は `value` が変化しないので
 * React は DOM を書き戻さず、変換セッションが生き残る。
 *
 * 変換を使わない入力（英数字・ペースト）は `composing` が false のままなので、
 * 従来どおり 1 文字ごとに親へ反映される。**挙動は変わらない。**
 */
export function useImeSafeValue<T extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  commit: (next: string) => void,
) {
  const composing = useRef(false)
  const [draft, setDraft] = useState<string | null>(null)

  return {
    value: draft ?? value,
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: (event: React.CompositionEvent<T>) => {
      composing.current = false
      setDraft(null)
      commit(event.currentTarget.value)
    },
    onChange: (event: React.ChangeEvent<T>) => {
      if (composing.current) {
        // 変換中。親へは渡さず、未確定の見た目だけ保つ。
        setDraft(event.target.value)
        return
      }
      setDraft(null)
      commit(event.target.value)
    },
  }
}
