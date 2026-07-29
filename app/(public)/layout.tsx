import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { MobileCtaBar } from '@/components/layout/MobileCtaBar'
import { ChatbotFab } from '@/components/layout/ChatbotFab'

/**
 * 公開サイト共通シェル（layout.md）。Header / Footer / モバイルCTAバー / チャットボットFAB を
 * 公開ページ群にのみ適用する。管理画面（/admin/**）はこのシェルを使わない（route group で分離）。
 * URL はルートグループ `(public)` により変化しない（/, /courses, /programs, /schools）。
 */
export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <a href="#main" className="skip-link">
        本文へスキップ
      </a>
      <Header />
      <main id="main">{children}</main>
      <Footer />
      <MobileCtaBar />
      <ChatbotFab />
    </>
  )
}
