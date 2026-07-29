# UI設計: トップページ（F-001）

> 準拠: `/DESIGN.md`、共通コンポーネントは `./layout.md` §7 を参照。
> 対応要件: `functional-spec.md` F-001（画面仕様・API仕様）
> 現行構成の踏襲: ヒーロー → FEATURE → NEWS最新 → 料金プレビュー → SCHOOL INFO → VOICE → ACCESS（`current-site-analysis.md` §3）

## ビジュアルコンセプト

- キャッチコピー「明日からの新しい自分のために」を核に、**夜明け/出発**を想起させるヒーロービジュアル（写真+グラデーションスクリム）で開始する。
- セクションが進むごとに「情報の比較(FEATURE/料金)」→「安心材料(SCHOOL/VOICE)」→「行動(ACCESS+CTA)」という体験順序を作る。
- 全セクションは `SectionHeading`（`layout.md` §7.4）で統一された見出しトーンを持つ。

## レイアウト（セクション構成順）

```
┌───────────────────────────────────────┐
│ 1. Hero                                │
├───────────────────────────────────────┤
│ 2. Feature（5特徴）                      │
├───────────────────────────────────────┤
│ 3. News（最新3件）                       │
├───────────────────────────────────────┤
│ 4. Price Preview（通学/合宿タブ）          │
├───────────────────────────────────────┤
│ 5. School Info（岩滝/網野 概要）           │
├───────────────────────────────────────┤
│ 6. Voice（卒業生の声）任意                 │
├───────────────────────────────────────┤
│ 7. Access（2校 アクセス概要）              │
└───────────────────────────────────────┘
```

各セクション間の余白: `--space-xxxl`(64px) desktop / `--space-xxl`(48px) mobile（DESIGN.md Spacing Scale）。背景色を1つ飛ばしで `Surface(#fff)` と `Background(#F8FAFC)` に交互に切り替え、セクション境界を視覚的に区切る（Hero=画像、Feature=Surface、News=Background、PricePreview=Surface、SchoolInfo=Background、Voice=Primary 50 tint、Access=Surface）。

---

### 1. Hero

```
Desktop:
┌──────────────────────────────────────────┐
│ [背景写真: 教習車と笑顔の卒業生 / 下部グラデーション] │
│                                            │
│   明日からの新しい自分のために                 │
│   （サブコピー: 通学も合宿も、あなたのペースで）    │
│                                            │
│   [資料請求はこちら] [料金をくらべる]           │
└──────────────────────────────────────────┘

Mobile: 同構成を縦積み、CTAは縦2段
```

- 見出しは Display style（`clamp(28px, 6vw, 44px)`, weight700, letter-spacing 0.02em）、白文字。背景写真の下30%に `linear-gradient(to top, rgba(17,24,39,0.65), transparent)` を重ねテキストのコントラストを確保（白文字 on 半透明ダーク、AA 4.5:1以上を実測で担保。写真の明度次第でスクリムの不透明度を0.55〜0.75で調整可）。
- CTA: `CTAButton variant="primary"` 「資料請求はこちら」→ `/apply`、`CTAButton variant="secondary"`（白背景バリアント: 枠線・文字を白にしたローカルオーバーライド、DESIGN.md Secondaryの色反転版）「料金をくらべる」→ `/courses`。
- 画像は `next/image` の `priority` 指定（LCP対策、非機能要件 tech-stack §）。`alt`は装飾的なら空、意味を持つ場合は説明文を付与。

### 2. Feature（5つの特徴）

現行の指名制/女性教習/スマホ予約/柔軟スケジュール/YouTube予復習を踏襲。

```
Desktop: 5カラムグリッド（アイコン＋ラベル＋一言説明）
Mobile : 2カラムグリッド（5個目は単独1カラム幅で中央寄せ）
```

- 各アイテム: アイコン(32px, Primary 500) + ラベル(Heading 3) + 説明(Body Small, Text Secondary)。
- カード化はせず背景透過のシンプルなグリッドアイテム（情報密度を上げすぎない）。

### 3. News（最新3件）

- `SectionHeading`: eyebrow="NEWS", title="お知らせ"
- `NewsCard`（`layout.md` §7.3）を3件、Grid: mobile 1列 / tablet・desktop 3列。
- 末尾に `CTAButton variant="tertiary"` 「お知らせをすべて見る」→ `/news`。
- 0件時: `EmptyState` message="お知らせはありません"（F-001 E-001-1、actionLabelなし。セクション自体は非表示にせずタイトルのみ残す）。

### 4. Price Preview（料金プレビュー）

```
[通学] [合宿]  ← Tabs（初期値: 通学）
┌────────┐┌────────┐┌────────┐
│CourseCard││CourseCard││CourseCard│  ×3〜4件（代表的な人気コース）
└────────┘└────────┘└────────┘
        [料金をもっと詳しく比較する →]
```

- Tabs切替はクライアント側の簡易フィルタ（`format`のみ）。校舎・免許種別の絞り込みはここでは行わず、詳細は `course-comparison.md` の比較ページに誘導する（トップは「見せる」、比較ページは「絞り込む」という役割分担）。
- 表示するコースの選定ロジック: `sortOrder` 昇順の先頭3〜4件（管理画面で並び順を制御、F-015）。
- `CourseCard` は `layout.md` §7.2 準拠。CTA「料金をもっと詳しく比較する」→ `/courses?format=TSUGAKU`（選択中タブを引き継ぐ）。
- モバイルはカード横スクロール（`overflow-x: auto; scroll-snap-type: x mandatory`）、各カード `scroll-snap-align: start`、幅は `85vw`。

### 5. School Info（校舎概要）

```
Desktop: 2カラム（岩滝校 / 網野校 を左右に並置）
Mobile : 縦積み
```

- 各校: 写真 + `Badge(variant="school")` + 校名(Heading2) + 一言特徴（Body Small） + 「詳しく見る」リンク（`/schools#iwataki` / `/schools#amino`）。
- カードではなくセクション内の左右パネル（背景 `Surface`、区切りは中央の1px `Border`縦線 desktopのみ）。

### 6. Voice（卒業生の声、任意セクション）

- `SectionHeading`: eyebrow="VOICE", title="卒業生の声"
- `TestimonialCard`（DESIGN.md Cards > Testimonial Card準拠）を3〜5件、モバイルは横スクロール（Price Previewと同じ `scroll-snap` パターン）、デスクトップは3カラムグリッド。
- データが0件の場合はセクション自体を非表示にする（F-001画面仕様表で「No」= 任意セクションのため、EmptyStateは出さずセクションごと出し分け）。

```ts
TestimonialCard:
  props: { name: string; courseLabel: string; comment: string; avatarUrl?: string }
```

### 7. Access（2校 アクセス概要）

- `SectionHeading`: eyebrow="ACCESS", title="アクセス"
- 2校を横並び（desktop）/縦積み（mobile）のコンパクトカードで、住所1行+最寄駅からの所要時間+ミニ地図サムネイル（クリックで `school-access.md` の該当セクションへ）。
- School Infoセクション（§5、特徴訴求中心）とは役割を分け、ここは**交通手段の到達性**のみに絞る（現行サイト構成踏襲）。
- CTA: 「詳しいアクセス・地図を見る」→ `/schools#access`。

---

## インタラクション定義

| トリガー | アニメーション | 持続時間 | イージング |
|---------|-------------|---------|----------|
| Hero CTAホバー | translateY(-1px) | 150ms | ease-out |
| CourseCard/TestimonialCard ホバー | Shadow Level1→2 + translateY(-2px) | 200ms | ease-out |
| 料金プレビュー タブ切替 | コンテンツのフェード切替 | 200ms | ease-out |
| セクション出現 | 任意: 8px下からフェードイン（`IntersectionObserver`） | 300ms | ease-out-expo |

- 全アニメーションは `prefers-reduced-motion: reduce` で即時表示に切り替える（DESIGN.md準拠）。

## データソース（functional-spec F-001 API仕様に対応）

| セクション | データ | 取得方法 |
|-----------|--------|---------|
| News | `prisma.news.findMany({ where: { status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' }, take: 3 })` | Server Component |
| Price Preview | `prisma.course.findMany({ where: { published: true, category: 'LICENSE' }, orderBy: { sortOrder: 'asc' }, take: 4 })` | Server Component |
| School Info / Access | `SchoolInfo` 定数（F-007参照、シード/定数管理） | 静的 |
| Voice | デモ用シードデータ（管理編集はスコープ外） | 静的/Server Component |

## アクセシビリティ

- Hero見出しは `<h1>`、以降のセクション見出しは `<h2>`（SectionHeadingのtitle）。
- 横スクロールカルーセル（料金プレビュー/Voice）はキーボードで左右矢印キー操作可能にし、`aria-roledescription="carousel"` は付与しすぎない（シンプルな `overflow-x: auto` + ネイティブTabフォーカスで十分、独自ウィジェット化しない）。
- Hero写真の `alt` は空文字（装飾目的、キャッチコピーが同じ情報をテキストで提供済みのため）。

## レスポンシブ

| ブレークポイント | Feature | Price Preview | School Info | Voice |
|-----------------|---------|---------------|-------------|-------|
| Mobile | 2列グリッド | 横スクロールカード | 縦積み | 横スクロール |
| Tablet | 5列 or 3+2 | 横スクロールカード | 縦積み | 2〜3列 |
| Desktop | 5列 | グリッド3〜4列 | 左右2カラム | 3列グリッド |
