/**
 * `server-only` のテスト用スタブ（結合テスト専用）。
 *
 * 背景: `lib/queries.ts` は誤ってクライアントから import されることを防ぐため `import 'server-only'`
 * を持つ。`server-only` の exports は `react-server` 条件でのみ空モジュールに解決され、それ以外
 * （= vitest の node 環境）では import 時に throw する。
 *
 * SEC-010 / RV-P2-001 の修正では「公開ページが実際に呼ぶ関数（lib/queries.getLatestNews）」を
 * 結合テストで検証する必要があるため、vitest.integration.config.ts の alias で本スタブに差し替える。
 * 差し替えは **テスト実行時のみ**で、アプリのビルド（Next.js は react-server 条件で解決）には影響しない。
 * すなわち「クライアント誤 import をビルドエラー化する」防御（REV-103）は本番経路で維持される。
 */
export {}
