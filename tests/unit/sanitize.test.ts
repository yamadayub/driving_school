import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '@/lib/markdown/renderSafe'

/**
 * SEC-001 / functional-spec §4.10 — お知らせ本文の描画時サニタイズ（最重要, F-005 公開 / F-014 管理プレビュー共通）。
 * 対象モジュール（想定契約）: @/lib/markdown/renderSafe の `renderMarkdown(source): string`。
 *
 * red 理由: renderMarkdown 本体未実装（NotImplemented throw）。実装後に green を目指す。
 *
 * 方針: remark→rehype→rehype-sanitize の厳格ホワイトリスト。生HTML経路（rehype-raw）は使わないため、
 * 攻撃ペイロードを Markdown 中に生HTMLで混入させても要素として復元されないこと（＝出力に現れないこと）を検証する。
 */
describe('SEC-001: renderMarkdown — 危険要素/属性/スキームの除去', () => {
  it('<script> は除去され、実行可能なスクリプトが出力に残らない', () => {
    const html = renderMarkdown('こんにちは<script>alert(1)</script>世界')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('<iframe> は許可しない', () => {
    const html = renderMarkdown('本文<iframe src="https://evil.example/"></iframe>')
    expect(html).not.toContain('<iframe')
  })

  it('<img> は本フェーズ非対応（onerror ベクタごと除去）', () => {
    const html = renderMarkdown('![x](x) <img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror')
  })

  it('on* イベントハンドラ属性は除去される', () => {
    const html = renderMarkdown('<a href="https://ex.example/" onclick="steal()">link</a>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('steal()')
  })

  it('style 属性 / <style> 要素は除去される', () => {
    const html = renderMarkdown(
      '<style>body{display:none}</style><p style="position:fixed">x</p>',
    )
    expect(html).not.toContain('<style')
    expect(html).not.toMatch(/\sstyle=/)
  })

  it('javascript: スキームのリンクは無害化される（href に残らない）', () => {
    const html = renderMarkdown('[クリック](javascript:alert(document.cookie))')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  it('data: スキームのリンクは許可しない', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
    expect(html.toLowerCase()).not.toContain('data:text/html')
  })
})

describe('SEC-001: renderMarkdown — 安全な要素は許可される', () => {
  it('見出し(h2/h3)・段落・強調・リスト・引用を出力する', () => {
    const html = renderMarkdown(
      ['## 見出し2', '### 見出し3', '', '**太字**と*斜体*', '', '- 項目1', '- 項目2', '', '> 引用'].join(
        '\n',
      ),
    )
    expect(html).toContain('<h2')
    expect(html).toContain('<h3')
    expect(html).toContain('<strong>')
    expect(html).toContain('<em>')
    expect(html).toContain('<li>')
    expect(html).toContain('<blockquote>')
  })

  it('h1 は本文内で許可しない（ページ見出しとの重複回避, news-cms §3）', () => {
    const html = renderMarkdown('# ページ見出し級のH1')
    expect(html).not.toContain('<h1')
  })
})

describe('SEC-001: renderMarkdown — a要素は rel/target を強制付与し安全スキームのみ許可', () => {
  it('http/https リンクは許可され、rel に nofollow/noopener/noreferrer と target=_blank が強制付与される', () => {
    const html = renderMarkdown('[サイト](https://example.com/path)')
    expect(html).toContain('<a')
    expect(html).toContain('href="https://example.com/path"')
    expect(html).toContain('target="_blank"')
    // rel はトークン単位で検証（実装が末尾に ugc を足しても許容）
    expect(html).toMatch(/rel="[^"]*nofollow[^"]*"/)
    expect(html).toMatch(/rel="[^"]*noopener[^"]*"/)
    expect(html).toMatch(/rel="[^"]*noreferrer[^"]*"/)
  })

  it('mailto リンクは許可される', () => {
    const html = renderMarkdown('[メール](mailto:info@example.com)')
    expect(html).toContain('href="mailto:info@example.com"')
  })
})
