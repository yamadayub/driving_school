import { describe, it, expect } from 'vitest'
import { isSameOrigin } from '@/lib/http-guard'

/**
 * SEC-011 / RV-P2-005 — 変更系ハンドラの CSRF 防御（同一オリジン検証）。
 *
 * 背景: 管理UI は Server Action ではなく**ネイティブ form POST** を採用しており（保存直後の
 * 遷移で中断されないための設計判断・妥当）、その副作用として Next.js の Server Action が標準で
 * 行う Origin 検証を手放している。現在 `save` / `delete` は CSRF トークンも Origin/Referer/
 * Sec-Fetch-Site 検証も持たず、防御は **Auth.js セッション Cookie の `sameSite: 'lax'` という
 * ライブラリ既定値**のみ。コードのどこにも書かれていない前提の上に安全性が立っている。
 *
 * 契約（RV-P2-005 改善案のシグネチャをそのまま採用）:
 *   lib/http-guard.ts
 *   export function isSameOrigin(request: Request): boolean
 *     - `Origin` ヘッダが `new URL(request.url).origin` と完全一致 → true
 *     - `Origin` 欠落 → false（クロスサイトのネイティブ form POST は Origin を必ず送るため、
 *       欠落を許すと防御が無意味になる。fail-closed）
 *
 * scheme / host / port のいずれかが違えば別オリジン（RFC 6454）。
 * 本ヘルパは P3 の変更系エンドポイント（申込・アップロード・チャット）でも再利用する。
 *
 * red 理由: `lib/http-guard.ts` が存在しないため import 解決に失敗する（Failed to resolve import）。
 */
function post(url: string, origin?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: origin === undefined ? {} : { origin },
  })
}

describe('SEC-011: isSameOrigin', () => {
  it('同一オリジンからの POST は true', () => {
    expect(
      isSameOrigin(post('https://example.com/api/admin/news/save', 'https://example.com')),
    ).toBe(true)
  })

  it('パス付き URL でもオリジン部分のみで比較する', () => {
    expect(
      isSameOrigin(post('https://example.com/api/admin/news/delete', 'https://example.com')),
    ).toBe(true)
  })

  it('別ホストからの POST は false（CSRF）', () => {
    expect(
      isSameOrigin(post('https://example.com/api/admin/news/save', 'https://evil.example.net')),
    ).toBe(false)
  })

  it('サブドメイン違いは false（SameSite=Lax は同一サイト扱いで Cookie を送るため要遮断）', () => {
    expect(
      isSameOrigin(post('https://example.com/api/admin/news/save', 'https://sub.example.com')),
    ).toBe(false)
  })

  it('スキーム違いは false', () => {
    expect(
      isSameOrigin(post('https://example.com/api/admin/news/save', 'http://example.com')),
    ).toBe(false)
  })

  it('ポート違いは false', () => {
    expect(
      isSameOrigin(post('http://localhost:3000/api/admin/news/save', 'http://localhost:3001')),
    ).toBe(false)
  })

  it('Origin ヘッダ欠落は false（fail-closed）', () => {
    expect(isSameOrigin(post('https://example.com/api/admin/news/save'))).toBe(false)
  })

  it('Origin が "null"（sandbox iframe 等）は false', () => {
    expect(isSameOrigin(post('https://example.com/api/admin/news/save', 'null'))).toBe(false)
  })

  it('ローカル開発の同一オリジン（http://localhost:3000）は true', () => {
    expect(
      isSameOrigin(post('http://localhost:3000/api/admin/news/save', 'http://localhost:3000')),
    ).toBe(true)
  })
})
