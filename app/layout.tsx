import type { Metadata } from 'next'
import './globals.css'

/*
 * フォント（DESIGN §3.1）— 本番想定 = next/font/google セルフホスト。
 *
 * ネットワーク到達可能な環境では以下を有効化する（ビルド時に Google Fonts を取得しセルフホスト）:
 *
 *   import { Zen_Kaku_Gothic_New, Noto_Sans_JP } from 'next/font/google'
 *   const zenKaku = Zen_Kaku_Gothic_New({
 *     weight: ['400', '500', '700'], subsets: ['latin'], display: 'swap',
 *     variable: '--font-zen-kaku-gothic-new',
 *   })
 *   const notoSansJP = Noto_Sans_JP({
 *     weight: ['400', '700'], subsets: ['latin'], display: 'swap',
 *     variable: '--font-noto-sans-jp',
 *   })
 *   // そして <html className={`${zenKaku.variable} ${notoSansJP.variable}`}>
 *
 * 本スキャフォールド環境は Google Fonts への外部フェッチ不可のため無効化し、
 * フォント変数は app/globals.css の :root で定義（OS標準ゴシックにフォールバック）している。
 */

/**
 * CSP の nonce 方式が成立する条件（AC-010-15 / `tech-stack.md` §4.7）。
 *
 * `middleware.ts` はリクエストごとに nonce を発行し、Next.js はそれを**自身が描画する
 * `<script>`（RSC のフライトデータを載せる inline script を含む）**に付与する。
 * **静的プリレンダリングされたページはビルド時の HTML を配るため nonce を持てず**、
 * inline script が CSP で全て弾かれる → `self.__next_f` が未定義のままハイドレーションが
 * 失敗し、**ページが真っ白になる**（実測: `/schools` が空表示になった）。
 *
 * そのためルートレイアウトで全ルートを動的レンダリングに固定する。P1 で DB 非依存ビルドのために
 * 主要ページは既に `force-dynamic` を採っており（REV-102）、ここに集約しても追加の代償は無い。
 * **ここを外すと、静的化されたページだけが無言で壊れる**（ビルドも型検査も通ってしまう）。
 */
export const dynamic = 'force-dynamic'

const siteName = '岩滝・網野自動車教習所'

// F-019 SEO基盤: サイト共通メタ。各ページは generateMetadata で固有化する。
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: `${siteName} | 明日からの新しい自分のために`,
    template: `%s | ${siteName}`,
  },
  description:
    '京都・丹後の岩滝校／網野校。普通車からドローン・建機スクール、追加講習まで。コース・料金の横断比較とオンライン申込に対応した自動車教習所です。',
  openGraph: {
    type: 'website',
    locale: 'ja_JP',
    siteName,
  },
  robots: { index: true, follow: true },
}

// ルートレイアウトは <html>/<body> と共通メタのみを担う。公開サイトの共通シェル
// （Header/Footer/CTAバー/チャットボット）は app/(public)/layout.tsx、管理画面の共通シェルは
// app/admin/(app)/layout.tsx がそれぞれ担当し、公開/管理でクロームを完全に分離する。
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
