/**
 * 管理画面 E2E セレクタ契約（Impl が実装時に必ず満たすべき DOM 契約の単一参照元）。
 * 公開サイト用 contract.ts と分離（F-012/013/014 管理画面用）。
 *
 * 方針は P1 同様: role / aria / data-testid ベースで安定化する（見た目テキストに過度依存しない）。
 * 契約元: docs/ui-design/admin/{login,dashboard,admin-layout,news-cms}.md。
 */

/** ルート（admin-layout.md / news-cms.md 画面構成）。 */
export const ADMIN_ROUTES = {
  login: '/admin/login',
  dashboard: '/admin',
  newsList: '/admin/news',
  newsNew: '/admin/news/new',
} as const

/**
 * 管理系 API（F-014 API仕様, 認証必須）。
 * 重要: middleware の matcher は `/admin/:path*` のみで **`/api/admin/*` を含まない**ため、
 * これらのハンドラは自前でサーバー側 session を検証する必要がある（多層防御, tech-stack §4.3）。
 * PT2-01 はこの handler レベル認可の実効テスト。
 */
export const ADMIN_API = {
  news: '/api/admin/news',
  newsById: (id: string) => `/api/admin/news/${id}`,
  // 管理UI のネイティブ form POST 先（JSON API とは別系統）。Server Action を使わない設計判断の
  // 代償として Next.js 標準の Origin 検証を持たないため、SEC-011/RV-P2-005 で同一オリジン検証を
  // 各ハンドラに入れる。応答契約: 未認証 → 303（/admin/login）、クロスオリジン → 403。
  newsSave: '/api/admin/news/save',
  newsDelete: '/api/admin/news/delete',
} as const

/**
 * E2E が共有 dev DB に作る行の識別接頭辞（PT2-03 データ衛生）。
 * 作成タイトルに必ず付与し、afterAll でこの接頭辞の行をベストエフォート削除して
 * 結合テストの厳密件数（news.published=6）と「最新記事」を破壊しない。
 */
export const E2E_TITLE_PREFIX = '【E2E】'

/**
 * デモ管理者資格情報（docs/dev-database.md §5 / .env）。開発用ダミー。実運用の秘密ではない。
 * seed（prisma/seed.ts）が AdminUser に scrypt ハッシュで投入している前提。
 */
export const ADMIN_CREDENTIALS = {
  email: 'admin@iwataki-driving-school.demo',
  password: 'admin_dev_pw',
} as const

/** data-testid 契約（Impl が付与する）。 */
export const ADMIN_TESTID = {
  // ダッシュボード（dashboard.md）
  dashboardStat: 'admin-stat-new-count',
  dashboardCardNews: 'admin-card-news',
  // お知らせ一覧（news-cms.md §1）
  newsTable: 'admin-news-table',
  newsRow: 'admin-news-row', // 各行。行内に data-news-id を持つ
  newsStatusFilter: 'admin-news-status-filter',
  // 作成/編集フォーム（news-cms.md §2/§3）
  newsForm: 'admin-news-form',
  newsBodyEditor: 'admin-news-body-editor', // MarkdownEditor の textarea
  newsBodyPreview: 'admin-news-body-preview', // MarkdownPreview（サニタイズ済み描画）
  // 削除確認（news-cms.md §1 ConfirmDialog）
  confirmDialog: 'admin-confirm-dialog',
} as const

/**
 * accessible name 契約（role + name）。
 * login.md / news-cms.md のラベル・ボタン文言に対応。
 */
export const ADMIN_A11Y = {
  loginEmailLabel: 'メールアドレス',
  loginPasswordLabel: 'パスワード',
  loginSubmit: 'ログイン',
  loginErrorText: 'メールアドレスまたはパスワードが正しくありません', // E-012-1 汎用（詳細を出さない）
  newNewsButton: '新規作成',
  saveDraftButton: '下書き保存',
  publishButton: '公開する',
  confirmDeleteButton: '削除する',
  // フォーム項目ラベル（news-cms §2）
  titleLabel: 'タイトル',
  categoryLabel: 'カテゴリ',
  statusLegend: '公開ステータス',
  publishedAtLabel: '公開日時',
} as const

/** 公開ステータスの表示ラベル（DESIGN §4 / lib/publish-status と一致）。 */
export const PUBLISH_STATUS_TEXT = {
  DRAFT: '下書き',
  PUBLISHED: '公開',
  UNPUBLISHED: '非公開',
} as const
