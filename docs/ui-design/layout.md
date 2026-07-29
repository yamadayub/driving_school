# UI設計: 共通レイアウト（ヘッダー / フッター / モバイル固定CTAバー / 共通コンポーネント）

> 対象: 公開サイト全ページに適用される共通シェル（F-001〜F-023 すべてに乗る土台）。
> 準拠: `/DESIGN.md`（トークン・Badge Roles・Buttons/Cards）
> 参照: `/docs/functional-spec.md` §3 画面遷移図, §4.7 アクセシビリティ/モバイル
> 技術前提: Next.js App Router + React + Tailwind（クラスはDESIGN.mdトークンに対応させる。`app/layout.tsx` に Header/Footer/MobileCtaBar/ChatbotFabを配置し、Server Component既定・インタラクション部分のみ `"use client"`）

他ページのUI設計ファイル（`top-page.md` 等）は本ファイルの「7. 共通コンポーネント」を単一の参照元とし、Props表を再掲しない。

---

## 1. ページシェル構成

### Desktop（≥1024px）

```
┌────────────────────────────────────────────────────────┐
│ Header（sticky top）                                     │
│  [Logo] [お知らせ][通学][合宿][プロ免許][スクール]         │
│         [学校案内][FAQ][アクセス]      [📞岩滝][📞網野]   │
│                                          [資料請求 CTA]   │
├────────────────────────────────────────────────────────┤
│ Breadcrumb（トップ以外）                                  │
├────────────────────────────────────────────────────────┤
│                                                          │
│                    <page content>                       │
│                                                          │
├────────────────────────────────────────────────────────┤
│ Footer                                                   │
└────────────────────────────────────────────────────────┘
                                       ⚫ChatbotFab(右下固定)
```

### Mobile（≤767px）

```
┌───────────────────────┐
│ Header（sticky top）    │
│ [☰] [Logo]      [📞]   │
├───────────────────────┤
│ Breadcrumb（横スクロール）│
├───────────────────────┤
│                       │
│    <page content>     │
│  （下部 padding で      │
│   固定CTAバー分を確保）  │
│                       │
├───────────────────────┤
│ Footer                │
├───────────────────────┤
│ MobileCtaBar（fixed）   │
│ [資料請求] [LINE相談]   │
└───────────────────────┘
        ⚫ChatbotFab（CTAバーの上に重ならない位置）
```

---

## 2. Header / グローバルナビゲーション

### 構成要素（Desktop）
- 左: ロゴ（トップへのリンク、`aria-label="岩滝・網野自動車教習所 トップページへ"`）
- 中央: グローバルナビ（8項目、テキストリンク、Label style 14px/700）
- 右: 校舎電話CTA（岩滝/網野 `tel:` リンク、アイコン+短縮ラベル）+ Primary CTAボタン「資料請求」

### ナビ項目とルーティング

| ラベル | 遷移先 | 備考 |
|--------|--------|------|
| お知らせ | `/news` | F-004 一覧（本バッチ対象外、リンクのみ実装） |
| 通学 | `/courses?format=TSUGAKU` | F-002。受講形態フィルタを事前適用 |
| 合宿 | `/courses?format=GASSHUKU` | F-002。同上 |
| プロ免許 | `/courses?license=PRO` | F-002。UI側で `licenseType != 'ORDINARY'` をまとめた仮想グループ値 `PRO` として扱う（詳細は `course-comparison.md` §3） |
| スクール | `/programs` | F-022（ドローン/建機/追加講習一覧） |
| 学校案内 | `/schools` | F-007（`school-access.md`） |
| FAQ | `/faq` | F-006（本バッチ対象外、リンクのみ実装） |
| アクセス | `/schools#access` | F-007ページ内の統合アクセスセクションへのアンカー。**別ページを新設しない**（`school-access.md` §4 参照） |

- 現在地のナビ項目は `aria-current="page"` を付与し、下線+Primary色で強調する。
- ナビは横幅超過時にラップさせず、1024〜1279pxでは Label フォントサイズを13pxに縮小して収める（`clamp()` は使わずブレークポイント固定値でよい）。

### Header 内 CTA
- 電話CTA: `tel:0120-46-4163`（岩滝） / `tel:0120-07-2633`（網野）。2校あるため電話アイコンをドロップダウン/ポップオーバーで開き、校舎を選ばせる（`aria-haspopup="menu"`）。
- 「資料請求」ボタン: DESIGN.md Buttons > Primary 準拠、Header内は高さを40pxに縮小した専用サイズ（`--button-height-compact: 40px`。タッチターゲット44px未満になるため **デスクトップ限定**、モバイルでは非表示＝固定CTAバーに委譲）。

### モバイル: ハンバーガー + ドロワー

```
[☰] タップ →
┌───────────────────────┐
│ [✕ 閉じる]              │
│                       │
│ お知らせ                │
│ 通学                   │
│ 合宿                   │
│ プロ免許                │
│ スクール                │
│ 学校案内                │
│ FAQ                   │
│ アクセス                │
│ ───────────────       │
│ 📞 岩滝校 0120-46-4163  │
│ 📞 網野校 0120-07-2633  │
│ [LINEで相談する]         │
│ [資料請求]              │
└───────────────────────┘
```

- 全画面オーバーレイ（`position: fixed; inset: 0; z-index: 60`）、背景 `rgba(17,24,39,0.4)` の下に本体パネルは `#fff` 右からスライドイン（`transform: translateX(100%) → 0`, 250ms `--ease-out-expo`、`prefers-reduced-motion`ではフェードのみ）。
- 開閉は `aria-expanded`（ハンバーガーボタン）+ `aria-modal="true"` `role="dialog"`（パネル）。開いた瞬間に閉じるボタンへフォーカス移動、Tab循環をパネル内に閉じ込める（フォーカストラップ）、`Esc`で閉じて元のトリガーへフォーカス復帰。
- 開いている間は `body` を `overflow: hidden` にして背面スクロールを止める。
- ナビ項目は1行48px（タッチターゲット確保）。

### コンポーネント契約

```ts
Header:
  props: { currentPath: string }  // aria-current 判定に使用
  children: なし（ナビ項目は静的定義。CMS化対象外）

NavDrawer (mobile専用, "use client"):
  props: { isOpen: boolean; onClose: () => void; currentPath: string }
```

---

## 3. Footer

```
┌────────────────────────────────────────────┐
│ [ロゴ]  明日からの新しい自分のために              │
│                                              │
│ サイトマップ        岩滝校              網野校    │
│ ・通学              〒629-2263          〒629-3102│
│ ・合宿              与謝野町字弓木1459-1   京丹後市網野町下岡522│
│ ・プロ免許           0120-46-4163        0120-07-2633│
│ ・スクール           [IG] [X]            [IG] [X] │
│ ・お知らせ                                       │
│ ・FAQ                                           │
│ ・学校案内・アクセス                              │
│ ・プライバシーポリシー                             │
│                                              │
│ © 2026 岩滝・網野自動車教習所                     │
└────────────────────────────────────────────┘
```

- 4カラムグリッド（サイトマップ/岩滝校/網野校/空 or SNS集約）desktop、モバイルは1カラムでアコーディオン化しない（フッターは短いため常時展開）。
- 背景 `#111827`（Text Primary を反転し footer だけダークにして本文領域と明確に区切る）、テキストは `#F8FAFC` / リンクhoverは Accent 500 `#F97316`（装飾用途としてここでは小面積テキストリンクhoverのみに許可、通常表示では使わない）。
- プライバシーポリシーリンク（F-023 `/privacy`）を必ず含める（F-008 同意文言の参照整合）。
- SNSアイコンはタッチターゲット44px、`aria-label="岩滝校 Instagram"` 等を個別付与。

### コンポーネント契約
```ts
Footer:
  props: なし（静的コンテンツ。校舎連絡先は SchoolInfo 定数から取得）
```

---

## 4. モバイル固定CTAバー

DESIGN.md §5「モバイル固定CTAバー」準拠。

- 表示: `≤767px` かつ以下のページを除く全ページ（`/apply` ステップフォーム内、`/admin` 配下、`/courses/[id]` `/programs/[id]` の詳細ページ（ページ固有のsticky申込CTAと重複するため、`course-detail.md` 参照）では非表示。CTAの重複を避けるため）。
- 構成: `資料請求`（Primary Button, `/apply?type=APPLICATION`へ）+ `LINEで相談する`（LINE Button, 校舎選択ポップオーバー経由でLINE公式アカウントへ）。
- 高さは実測値をCSS変数 `--mobile-cta-bar-height` としてルートに公開し、ページ本文末尾の `padding-bottom` とChatbotFabの位置計算に使う（下記5参照）。
- `position: fixed; bottom: 0; left: 0; right: 0; z-index: 50`、Shadow Level 2（上向き）、`padding-bottom: env(safe-area-inset-bottom)`。

### コンポーネント契約
```ts
MobileCtaBar:
  props: { hidden?: boolean }  // フォーム/管理画面ルートで true
```

---

## 5. ChatBot起動ボタン（ChatbotFab）

- 全ページ共通、右下フローティング。位置: `bottom: 24px; right: 16px`（desktop） / `bottom: calc(var(--mobile-cta-bar-height) + 16px); right: 16px`（mobile、CTAバーと重ならないように積み上げ）。
- サイズ 56×56px（タッチターゲット44px基準を超えて確保）、円形、Background Primary 700、アイコンは吹き出し、Shadow Level 4。
- 未読/新着エスカレーション提案がある場合は右上に小さいドット（Accent 700）を表示（任意, F-011実装時の拡張余地としてここでは placeholder として明記のみ）。
- 会話パネル自体の詳細仕様（F-011）は本バッチ対象外。ここでは起動ボタンの配置・z-index（`z-index: 55` = CTAバーより上、ドロワーより下）のみを規定する。

### コンポーネント契約
```ts
ChatbotFab ("use client"):
  props: { onOpen: () => void; isOpen: boolean }
```

---

## 6. Breadcrumb

- トップページを除く全ページ上部（Header直下、ページコンテナ内）に表示。BreadcrumbList構造化データ（F-020）と1:1で対応させる。
- 表示例: `トップ ＞ コース・料金 ＞ 普通車(AT) 通学`
- モバイルでは横スクロール可能な1行（`overflow-x: auto; white-space: nowrap`）、末尾項目のみ Text Primary、それ以外は Text Secondary。
- 各項目はリンク（最後の現在ページのみ `aria-current="page"` でリンク化しない）。

### コンポーネント契約
```ts
Breadcrumb:
  props: { items: { label: string; href?: string }[] }  // 最後の要素は href省略で現在ページ扱い
```

---

## 7. 共通コンポーネント

他ページのUI設計はここに定義したコンポーネントを利用する。色・形状の値は `/DESIGN.md` を単一の参照元とし、ここではProps契約と使用ルールのみ定義する。

### 7.1 Badge

DESIGN.md §2 Badge Roles / §4 Badge 準拠。4バリアントを1コンポーネントで出し分ける。

```ts
type BadgeVariant = "school" | "format" | "category" | "subsidy" | "adminStatus"

Badge:
  props: {
    variant: BadgeVariant
    value: SchoolCode | CourseFormat | ProgramCategory | SubsidyTag | AdminStatus
    // variant="school" のときのみ Outline+ドット形状。他は Filled。
  }
```

| variant | value例 | 形状 | 色（DESIGN.md参照） |
|---------|--------|------|---------------------|
| school | `IWATAKI` \| `AMINO` | Outline + ●ドット | Indigo / Teal |
| format | `TSUGAKU` \| `GASSHUKU` | Filled Pill | Blue / Orange |
| category | `DRONE` \| `KENKI` \| `SENIOR` \| `BEGINNER` \| `CORPORATE` \| `COMMON` | Filled Rounded-Rect | Violet / Amber / Fuchsia / Pink / Stone / Gray |
| subsidy | `GRANT`（給付金）\| `SUBSIDY`（助成金） | Filled Pill + ✓アイコン | Green / Lime |
| adminStatus | `NEW` \| `IN_PROGRESS` \| `DONE` | Filled Pill | Danger / Warning / Success |

- ラベル文言は日本語固定文言テーブルを別途 `i18n`/定数ファイルに持つ（例: `IWATAKI→"岩滝校"`）。本コンポーネント自体はvalueを受け取り内部でラベル解決する。
- 1カード内に複数バッジを並べる順序: 校舎 → 受講形態/カテゴリ → 給付金/助成金（左から重要度の高い識別情報→補足情報の順）。

### 7.2 CourseCard

`top-page.md`（料金プレビュー）・`course-comparison.md`（比較結果）で使用。

```ts
CourseCard:
  props: {
    id: string
    schools: SchoolCode[]           // 1〜2校 → Badge(school)を複数表示
    format: "TSUGAKU" | "GASSHUKU" | null
    licenseTypeLabel: string | null // LICENSE用
    programLabel: string | null     // 非LICENSE用（course-detail.mdのProgramCardが実体は同一コンポーネントを拡張）
    transmission: "AT" | "MT" | null
    minDays: number
    priceFrom: number               // tabular-nums表示
    subsidyTags: ("GRANT" | "SUBSIDY")[]
    href: string                    // 詳細ページへ
    ctaHref: string                 // "このコースで申込む" → /apply?courseId=...
  }
```
- 見出し表示ロジック: `licenseTypeLabel ?? programLabel` に `transmission` があれば `(AT)`/`(MT)` を付記。
- DESIGN.md Cards > Course Card のスタイルに準拠（hover: Shadow Level2 + translateY(-2px)、`prefers-reduced-motion`で無効化）。

### 7.3 NewsCard

`top-page.md`（最新3件）で使用（一覧ページ本体は本バッチ対象外だが同一コンポーネントを一覧でも再利用する前提）。

```ts
NewsCard:
  props: {
    id: string
    title: string
    category: NewsCategory          // IWATAKI|AMINO|DRONE|KENKI|COMMON → Badge(school または category)
    publishedAt: string             // ISO date, 表示は "2026.07.19" 形式
    href: string
  }
```
- `category` が `IWATAKI`/`AMINO` の場合 Badge(variant="school")、`DRONE`/`KENKI`/`COMMON` の場合 Badge(variant="category")を出し分ける（役割の異なるバッジを混在させない、DESIGN.md Do's準拠）。

### 7.4 SectionHeading

トップページの各セクション、比較ページのフィルタ見出し等、ページ内セクション見出しの統一コンポーネント。

```ts
SectionHeading:
  props: {
    eyebrow?: string      // 例: "NEWS"（Caption style, Accent 700, letter-spacing広め）
    title: string         // Heading 1 style
    description?: string  // Body style, Text Secondary
    align?: "left" | "center"  // トップページは center、内部ページは left が既定
  }
```

### 7.5 CTAButton

DESIGN.md Buttons のラッパー。variant名をDESIGN.mdのバリアント名と1:1対応させる。

```ts
CTAButton:
  props: {
    variant: "primary" | "secondary" | "tertiary" | "line" | "danger"
    href?: string   // Linkとして描画。省略時は button+onClick
    size?: "default" | "compact"  // compact はHeader内専用（40px高、モバイルでは使用不可）
    icon?: ReactNode
  }
```

### 7.6 EmptyState / ErrorState

一覧・比較系ページ（F-002/F-004/F-006等）で共通利用。

```ts
EmptyState:
  props: { message: string; actionLabel?: string; onAction?: () => void }
  // 例: 「条件に合うコースがありません」+「フィルタをリセット」ボタン（E-002-1）

ErrorState:
  props: { message: string; onRetry?: () => void }
  // 例: 「情報を取得できませんでした」+「再読み込み」ボタン（E-002-2）
```

- どちらも `role="status"`（Error側は `role="alert"`）でスクリーンリーダーに通知する。

---

## 8. アクセシビリティ共通ルール

- **スキップリンク**: Header最上部に視覚的に隠れた「本文へスキップ」リンクを設置、フォーカス時に表示（`:focus` で `position: static` に切替）。遷移先はメインコンテンツの `id="main"`。
- **ランドマーク**: `<header>` `<nav aria-label="グローバルナビゲーション">` `<main id="main">` `<footer>` を明示。
- **フォーカスリング**: 全インタラクティブ要素で `outline: 2px solid #1D4ED8; outline-offset: 2px` を維持する（`outline: none` の除去禁止）。
- **色のみに依存しない**: Badge は形状+アイコン+テキストラベルで役割を伝える（DESIGN.md Badge Roles参照）。エラー表示は色+テキスト+アイコンを併用。
- **キーボード操作**: ドロワー/ポップオーバー/アコーディオンはすべて `Tab`/`Shift+Tab`/`Esc`/`Enter`/`Space` で操作完結できること。
- **動的領域**: フィルタ結果件数の変化やEmptyState表示は `aria-live="polite"` の領域に反映する。

## 9. レスポンシブ共通ルール

- ブレークポイント: DESIGN.md §8 準拠（Mobile ≤767 / Tablet 768–1023 / Desktop ≥1024）。
- コンテナ: `max-width: 1120px; padding-inline: 16px`（mobile）`/24px`（desktop）。
- `--mobile-cta-bar-height` はビルド時ではなく実測（`ResizeObserver`）でCSS変数に反映し、他要素（ページ本文の下部余白、ChatbotFab位置）が追従できるようにする。
- タッチターゲットは全インタラクティブ要素で最小44px、ボタン・入力欄は48px標準（DESIGN.md準拠）。
