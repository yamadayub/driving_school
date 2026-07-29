# コードレビュー: P1 公開サイト骨格（実装）

## レビュー日: 2026-07-27
## 対象Phase: 実装
## レビュワー: Senior Engineer Agent

## 総合評価: Approve（条件付き — Should Fix を P1 完了前 or 直近フォローで対応推奨。ブロッカーなし）

全テスト green（unit41 / integration15 / E2E54×3 / build成功）を確認済み。設計原則・Server/Client 境界・a11y・Badge 二重エンコードは高水準で実装されている。以下の Should Fix はいずれも現行の振る舞い・テストを壊す不具合ではないが、仕様適合（URL同期）とデプロイ堅牢性（build時DB結合）の観点で対応を推奨する。

## 評価サマリー
- 良い点: 多数（下記）
- 改善必須（Must Fix）: 0件
- 改善推奨（Should Fix）: 3件
- 軽微（Nice）: 4件

### 良い点
- **Server/Client 境界が明瞭**: DBアクセスは `lib/queries.ts` に集約し、Server Component（`app/**/page.tsx`）からのみ呼ぶ。クライアント側 `CourseComparison`/`PricePreview` は Server で変換済みの `CourseView` を props で受け取り、`queries`/`db` を import していない。バンドルにDB資格情報が漏れない構造（tech-stack §1.2 準拠）。
- **純関数の責務分離**: `format` / `course-filter` / `course-view` / `badge` が副作用なく分離され、ラベル・トークンは `labels.ts` / `design-tokens.ts` を単一参照元にしている。
- **Badge 役割 = 色 + 形状 の二重エンコード**（DESIGN §2 REV-008）を正しく実装。school=outline+●、format=pill、category=rounded-rect、subsidy=pill+✓。色のみ依存を回避（WCAG 1.4.1）。
- **公開/非公開境界**: `getPublishedCourse` は `published:true` 限定、詳細ページは未存在/非公開/カテゴリ不一致で `notFound()`。LICENSE/非LICENSE を `/courses`・`/programs` で厳密に分離。
- **a11y**: 単一ナビランドマーク（デスクトップ nav のみラベル、Drawer は分離）、NavDrawer のフォーカストラップ+Esc+背面スクロール抑止、タッチ44px、skip-link、`aria-current`、比較の `role=radio`/`aria-pressed`/`aria-live` が spec と一致。
- **型安全**: app/lib/components に `any` キャストゼロ。

## 指摘事項

### [REV-101] 比較フィルタの `?school` がURL復元されない（書き込みは行うが読み戻さない）
- **種別**: Design / 仕様適合
- **重要度**: Should Fix
- **場所**: `components/courses/CourseComparison.tsx:64,83-93`, `app/courses/page.tsx:24-37`
- **現状**: `school` state は常に `'ALL'` 初期化。同期 effect は `?school=` を URL に**書き込む**が、`courses/page.tsx` は `sp.school` を読まず `CourseComparison` に `initialSchool` を渡していない。結果、`/courses?school=AMINO` を共有/ブックマークしても校舎フィルタが復元されない。`format`/`license` は復元されるため非対称。
- **改善案**: page 側で `sp.school`（IWATAKI/AMINO/ALL）を検証し `initialSchool` として渡し、`useState<SchoolFilter>(initialSchool)` で初期化する。
- **理由**: 自コードのコメント「共有・戻るで再現可能に」および course-comparison.md §60「フィルタ状態を `?school=&format=&license=` として URL に反映」の一部未達。

### [REV-102] `/` と `/programs` が build 時に Prisma を実行（プリレンダのDB結合）
- **種別**: Maintainability / デプロイ堅牢性
- **重要度**: Should Fix
- **場所**: `app/page.tsx:31-32`, `app/programs/page.tsx:20`（`export const dynamic`/`revalidate` 未指定）
- **現状**: `.next/server/app` に `index.html`/`programs.html` が生成されており、両ページは build 時に静的プリレンダされ、その際 `getLatestNews`/`getLicenseCourses`/`getPrograms` が実行される（`/courses` は searchParams により dynamic で `.html` なし）。`next build` が稼働DBを要求する結合が発生する（今回は DB 到達可能で build 成功）。
- **改善案**: データ取得ページに `export const revalidate = <秒>`（ISR）または `export const dynamic = 'force-dynamic'` を付与し、build と DB を切り離す（デモは force-dynamic か短い revalidate が無難）。
- **理由**: CI/デプロイで DB 未接続時に build が失敗しうる。データ更新の反映方針（SSG/ISR/SSR）を明示するのが保守上も望ましい。

### [REV-103] DBアクセス層に `import 'server-only'` を付与し多層防御化
- **種別**: Design / セキュリティ多層防御
- **重要度**: Should Fix
- **場所**: `lib/queries.ts:1-6`, `lib/db.ts:1`
- **現状**: サーバー限定はコメントで担保。現状クライアントからの import は無い（実害なし）が、将来の誤importをコンパイル時に防げない。Next.js は `import 'server-only'` を標準サポート（別途依存追加不要、コンパイラレベルで解決）。
- **改善案**: `lib/db.ts` と `lib/queries.ts` の先頭に `import 'server-only'` を追加。誤って Client Component から import した瞬間に build エラーで検知できる。
- **理由**: tech-stack §1.2「DBアクセスはサーバー限定」をコメントではなくビルド制約として強制でき、回帰を機械的に防止できる。

### [REV-104] 未実装ルートへのリンクが 404（デモ品質）
- **種別**: Maintainability / Nice
- **重要度**: Nice
- **場所**: `/news`・`/news/[id]`・`/faq`・`/apply`・`/bus`・`/privacy`（Header/Footer/各CTA）
- **現状**: P1 スコープ外の後続ページへのリンクが多数あり、デモで押下すると 404。
- **改善案**: 後続 Phase 予定であることを README/デモ手順に明記、もしくは暫定「準備中」ページ or CTA の無効化。判断はデモ運用方針に委ねる。

### [REV-105] 比較ページ `isDesktop` 初期値=true の swap 撤去（tradeoff (a) 検証）
- **種別**: Design / 妥当
- **重要度**: Nice（現状維持で可）
- **場所**: `components/courses/CourseComparison.tsx:73-80,181-189`
- **検証結果**: 初期値 true により SSR と client 初期描画が共に Table で一致し、**ハイドレーション不整合は発生しない**（妥当な設計）。testid 二重カウント回避の目的も達成。副作用はモバイルで effect 実行までの1フレーム Table が見える点のみ（Table は `overflow-x-auto` でスクロール可、致命的でない）。
- **改善案（任意）**: 気になる場合は CSS（`lg:` 表示切替）で両方をマウントしつつ表示制御する手もあるが、testid 二重カウント対策との両立コストを踏まえ**現状維持を推奨**。

### [REV-106] トップ School Info の校舎Badge撤去（tradeoff (b) 検証）
- **種別**: Design / 妥当
- **重要度**: Nice
- **場所**: `app/page.tsx:131-149`
- **検証結果**: 各カードが `<h3>` で校舎名を明示し1校=1カードのため、識別用の school Badge は冗長。撤去は Badge 役割（混在時の識別）の趣旨に反せず**妥当**。SchoolProfile（学校案内）側では Badge を保持しており一貫性も可。

## ゲート判定
- 型エラーなし / unit・integration・E2E 全パス / build 成功を確認。
- Must Fix（`any`残存・エラーハンドリング欠落・明白なパフォーマンス問題）なし。
- よって **Approve**。Should Fix 3件（REV-101/102/103）は Impl Agent へ差し戻さず、P1 クローズ前の軽微修正 or 直近フォローで対応を推奨する。
