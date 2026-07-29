/**
 * Content-Security-Policy（AC-010-15 / AC-008-1 / SEC-002）。
 *
 * ------------------------------------------------------------------------
 * なぜ P3-a で「最終形」を入れるのか（`tech-stack.md` §4.7）
 * ------------------------------------------------------------------------
 * 後続単位（P3-b の Turnstile / P3-c の Blob）で必要になるオリジンを**先に**許可する。
 * 後から緩めると監査をやり直すことになり、「監査済み」の範囲が単位間の隙間に落ちる。
 * かつ **CSP 投入と Turnstile 導入の順序を誤ると、フォーム公開と同時に CAPTCHA が壊れる**
 * （可用性の問題でもある）。
 *
 * ------------------------------------------------------------------------
 * 受容している緩和（過大報告しないために明記する / RV-P3D-N02）
 * ------------------------------------------------------------------------
 * **`style-src` に `'unsafe-inline'` を許容している。** Next.js はクリティカル CSS を
 * inline `<style>` で注入するため、外すと描画が壊れる。AC-008-1 の検証対象は `script-src` のみ
 * なので仕様違反ではないが、「CSP を厳格にした」と丸めて報告してはならない。
 * 失っているのは CSS インジェクション由来の限定的な情報漏えい耐性である。
 */

/** Turnstile（P3-b で使用。ウィジェットは iframe + スクリプト）。 */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/** Vercel Blob（P3-c。ブラウザから署名付き PUT を直接行う）。 */
const BLOB_ORIGIN = 'https://*.public.blob.vercel-storage.com'

/**
 * リクエストごとの nonce を生成する（Edge ランタイムの Web Crypto を使う）。
 *
 * nonce 方式は全ページを動的レンダリングにするが、**本プロジェクトは P1 で既に `force-dynamic` を
 * 採用済み**（DB 停止でも build が成功するため）なので追加の代償は無い。
 */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * CSP ヘッダ値を組み立てる。
 *
 * `allowUnsafeEval` は **開発サーバー専用**（React Refresh が `eval` を使う）。
 * 本番ビルド（`next start` / Vercel）では常に false になるため、AC-008-1 の
 * 「`script-src` に `'unsafe-inline'` / `'unsafe-eval'` を含めない」は本番で必ず満たされる。
 */
export function buildContentSecurityPolicy(
  nonce: string,
  { allowUnsafeEval = false }: { allowUnsafeEval?: boolean } = {},
): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    ...(allowUnsafeEval ? ["'unsafe-eval'"] : []),
    TURNSTILE_ORIGIN,
  ]

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    // style-src の 'unsafe-inline' は受容済み（上記の注記を参照）。
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // 免許証プレビューは createObjectURL（blob:）。next/image は使わない。
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    // 郵便番号解決はサーバー Route Handler 経由なので外部 API のオリジンは不要
    //（クライアント直叩きへ設計変更する場合はここへの追加が必要）。
    ['connect-src', ["'self'", BLOB_ORIGIN]],
    ['frame-src', ["'self'", TURNSTILE_ORIGIN]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]

  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
