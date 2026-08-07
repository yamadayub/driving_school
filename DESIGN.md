# DESIGN.md — 岩滝・網野自動車教習所 Webサイトリニューアル（デモ）

> このファイルはAIエージェントが正確な日本語UIを生成するためのデザイン仕様書です。
> セクションヘッダーは英語、値の説明は日本語で記述しています。
> 対象プロダクト: 地方総合自動車教習所（岩滝校・網野校）の公開サイト＋CMS管理画面＋申込フォーム＋AIチャットボット。
> 参照: `/docs/product-concept.md`, `/docs/current-site-analysis.md`

---

## 1. Visual Theme & Atmosphere

- **デザイン方針**: 「信頼感・清潔感」と「明るく前向きな親しみやすさ」の両立。地方の総合教習所として保護者・社会人にも安心感を与えつつ、18歳前後の若年層に刺さる爽やかさを持たせる
- **キャッチコピー**: 「明日からの新しい自分のために」— 新しい一歩、夜明け・出発のイメージをビジュアルに反映する
- **密度**: 情報網羅型のコーポレート/サービスサイト。コース・料金の横断比較、申込導線、FAQ/チャットボットへの動線を明快に
- **キーワード**: 信頼、清潔、前向き、親しみやすい、モバイルファースト、比較のしやすさ
- **カテゴリ**: 地域密着サービス / コーポレートサイト / CMS管理画面 / フォーム

### トーン&マナーの使い分け
| 領域 | トーン |
|------|-------|
| 公開サイト（トップ・コース紹介） | 明るい・前向き・写真主体。青(信頼)×オレンジ(推進力のCTA)のコントラスト |
| 申込フォーム・FAQ | 落ち着いた・迷わせない。装飾を抑え、入力のしやすさ最優先 |
| 管理画面(CMS) | 実務的・情報密度高め。ステータスが一目でわかる配色 |
| AIチャットボット | 親しみやすい会話UI。吹き出し・アイコンで柔らかく |

---

## 2. Color Palette & Roles

### Primary（信頼のブランドブルー）

- **Primary 700** (`#BE123C`): メインブランドカラー（現行サイトのピンク系に合わせたローズ）。ヘッダー、リンク、セカンダリボタン、フォーカスリング。白背景コントラスト比 約6.4:1（WCAG AA適合）
- **Primary 800** (`#1E40AF`): ホバー・プレス時
- **Primary 500** (`#F43F5E`): アイコン、イラスト、グラデーション用の明るいローズ（小さな文字には使わない）
- **Primary 50** (`#EFF6FF`): 淡色背景（セクション区切り、選択状態、岩滝校バッジ背景）

### Accent（推進力のオレンジ — 主要CTA）

- **Accent 700** (`#C2410C`): プライマリCTAボタン背景（資料請求・申込）。白文字コントラスト比 約5.2:1（WCAG AA適合）
- **Accent 800** (`#9A3412`): ホバー・プレス時
- **Accent 500** (`#F97316`): 装飾・アイコン・グラデーション用のビビッドオレンジ（**文字を乗せる小さい面には使用しない** — コントラスト比不足のため）
- **Accent 50** (`#FFF7ED`): 淡色背景（合宿コースバッジ背景等）

### LINE Brand（LINE相談CTA専用）

- **LINE Green** (`#06C755`): LINE公式ブランドカラー。「LINEで相談する」ボタンにのみ使用
- **LINE Green Dark** (`#05A648`): ホバー時

> Primary(信頼)とAccent(推進力/CTA)を明確に役割分担する。青は「情報・ナビゲーション」、オレンジは「今すぐ行動してほしい場所」だけに使う。

### Semantic（意味的な色）

- **Success** (`#16A34A`) / bg `#F0FDF4`: 完了ステータス、給付金対象タグ、送信成功
- **Warning** (`#D97706`) / bg `#FFFBEB`: 注意喚起、残り枠わずか、未確認項目
- **Danger** (`#DC2626`) / bg `#FEF2F2`: エラー、必須未入力、**免許取消歴など重要確認事項**
- **Info** (`#0284C7`) / bg `#F0F9FF`: 補足情報、チャットボットの案内メッセージ

### Badge Roles（バッジの役割別カラードメイン）

> 2026-07-19 Senior Engineer レビュー（`/docs/review-p0-spec-2026-07-19.md` REV-008）で、校舎バッジと種別/助成金バッジが同色になり判別困難との指摘を受け改訂。
> Course Card は「校舎＋受講形態＋給付金/助成金」を同時に並べるため、**役割(role)ごとに色相ドメインとバッジ形状の両方を分離**し、色だけに依存しない（WCAG 1.4.1 Use of Color）設計にする。同色を複数の役割で使い回さない。

| Role（役割） | 意味 | バッジ形状 | 使用色相ドメイン |
|-------------|------|-----------|-----------------|
| 校舎 (School) | どの校舎の情報か | **アウトライン**（背景透明/白、枠線+テキストが同色、先頭に●ドット） | Indigo / Teal |
| 受講形態 (Format) | 通学か合宿か | **塗りピル**（淡色背景+濃色テキスト） | Blue / Orange(Accent) |
| 講習カテゴリ (Category) | 免許以外の講習・お知らせ分類 | **塗り角丸矩形**（radius 8px。ピルと形を変えて種別と区別） | Violet / Amber / Fuchsia / Pink / Stone / Gray |
| 給付金/助成金タグ (Subsidy) | 補助制度の対象か | **塗りピル + 先頭✓アイコン** | Green / Lime |
| 公開ステータス (Publish Status) | CMSコンテンツが下書き/公開/非公開のどれか（管理画面専用） | **塗りピル**（申込・問い合わせステータスと同形状だが別カラードメイン） | Slate / Success Green / Cyan |

#### 校舎（Outline / Indigo・Teal）

| 校舎 | 色 |
|------|-----|
| 岩滝校 | `#4338CA` (Indigo 700)。白背景コントラスト比 約7.9:1 |
| 網野校 | `#0F766E` (Teal 700)。白背景コントラスト比 約5.5:1 |

#### 受講形態（Filled Pill / Blue・Orange）

| 種別 | テキスト色 | 背景色 |
|------|----------|--------|
| 通学 | `#BE123C` (Rose 700) | `#FFF1F2` (Rose 50) |
| 合宿 | `#C2410C` (Accent Orange 700) | `#FFF7ED` (Orange 50) |

#### 講習カテゴリ（Filled Rounded-Rect / Violet・Amber・Fuchsia・Pink・Stone・Gray）

現行サイトの「ドローン/建機/高齢者/ペーパードライバー/企業」コンテンツ（`/docs/current-site-analysis.md` §2, `/docs/product-concept.md` インベントリ）に対応する受け皿として、免許コース以外の講習・お知らせカテゴリを定義する。

| カテゴリ | テキスト色 | 背景色 |
|---------|----------|--------|
| ドローンスクール | `#6D28D9` (Violet 700) | `#F5F3FF` (Violet 50) |
| 建機スクール | `#B45309` (Amber 700) | `#FFFBEB` (Amber 50) |
| 高齢者講習 | `#A21CAF` (Fuchsia 700) | `#FDF4FF` (Fuchsia 50) |
| ペーパードライバー講習 | `#BE185D` (Pink 700) | `#FDF2F8` (Pink 50) |
| 企業・法人研修 | `#44403C` (Stone 700) | `#FAFAF9` (Stone 50) |
| 共通（両校対象のお知らせ） | `#4B5563` (Gray 600) | `#F3F4F6` (Gray 100) |

> **ALLとの違い（REV-006対応）**: 「共通」は個々のお知らせに付与される**カテゴリ値**（両校向けの告知）。一方「すべて」は一覧画面の**フィルタUI**（選択チップ/タブ）であり、バッジとしては発行しない。校舎で絞り込んだ場合は `category='共通'` の項目も併せて表示する。

#### 給付金/助成金タグ（Filled Pill + ✓ / Green・Lime）

| タグ | テキスト色 | 背景色 |
|------|----------|--------|
| 給付金対象 | `#16A34A` (Green 600) | `#F0FDF4` (Green 50) |
| 助成金対象 | `#4D7C0F` (Lime 700) | `#F7FEE7` (Lime 50) |

全バッジ配色は 700番手前後の濃色テキスト × 50番手の淡色背景（または白背景+濃色アウトライン）で構成し、WCAG AA（通常文字4.5:1以上）を満たす。

### Neutral（ニュートラル）

- **Text Primary** (`#111827`): 本文テキスト
- **Text Secondary** (`#4B5563`): 補足テキスト、ラベル、キャプション
- **Text Disabled** (`#9CA3AF`): 無効状態のテキスト
- **Border** (`#E5E7EB`): 区切り線、カード枠
- **Border Strong** (`#CBD5E1`): 入力欄の枠（視認性を上げるため区切り線より濃く）
- **Background** (`#F8FAFC`): ページ背景。清潔感のあるクールオフホワイト
- **Surface** (`#FFFFFF`): カード、モーダル、入力欄などの面

---

## 3. Typography Rules

### 3.1 和文フォント

- **見出し用ゴシック体**: Zen Kaku Gothic New（Google Fonts, `next/font/google` 対応）— 力強く親しみやすい印象。ヒーローキャッチコピー・大見出しに使用
- **本文用ゴシック体**: Noto Sans JP（Google Fonts, `next/font/google` 対応）— 可読性重視。保護者層も含む幅広い年齢層に配慮
- **明朝体**: 使用なし

### 3.2 欧文フォント・数字

- **サンセリフ（フォールバック）**: system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif
- **数字（料金表）**: `font-variant-numeric: tabular-nums` を料金比較表・カウントダウン等の数値表示に適用し、桁揃えを崩さない

### 3.3 font-family 指定

```css
/* 見出し（Zen Kaku Gothic New を next/font で読み込み、CSS変数化） */
--font-heading: var(--font-zen-kaku-gothic-new), system-ui, -apple-system,
  "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif;

/* 本文（Noto Sans JP を next/font で読み込み、CSS変数化） */
--font-body: var(--font-noto-sans-jp), system-ui, -apple-system,
  "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif;
```

**フォールバックの考え方**:
- next/font/google でセルフホストし、外部リクエストなしで表示（表示速度・SEO/Core Web Vitals対策）
- OS標準ゴシック（Hiragino/Meiryo/Roboto）で広くカバーし、フォント読み込み前もレイアウトが崩れないようにする

### 3.4 文字サイズ・ウェイト階層

モバイル値 → デスクトップ値の順で記載（モバイルファースト、`clamp()` での実装推奨）。

| Role | Font | Size | Weight | Line Height | Letter Spacing | 備考 |
|------|------|------|--------|-------------|----------------|------|
| Display | 見出し(Zen Kaku Gothic New) | 28px → 44px | 700 | 1.4 | 0.02em | ヒーローキャッチコピー「明日からの新しい自分のために」 |
| Heading 1 | 見出し(Zen Kaku Gothic New) | 22px → 32px | 700 | 1.4 | 0.01em | ページ大見出し・セクション見出し |
| Heading 2 | 見出し(Zen Kaku Gothic New) | 18px → 24px | 700 | 1.5 | 0 | サブ見出し（コース名、校舎名等） |
| Heading 3 | 本文(Noto Sans JP) | 16px → 18px | 700 | 1.5 | 0 | カード見出し、FAQ質問文 |
| Body | 本文(Noto Sans JP) | 16px | 400 | 1.8 | 0 | 本文。広い年齢層への可読性を優先し行間を広めに |
| Body Small | 本文(Noto Sans JP) | 14px | 400 | 1.7 | 0 | 補足説明、注意書き |
| Label | 本文(Noto Sans JP) | 14px | 700 | 1.4 | 0 | フォームラベル、ボタンテキスト、ナビゲーション |
| Caption | 本文(Noto Sans JP) | 12px | 400 | 1.5 | 0 | 日付、出典、免責事項 |

### 3.5 行間・字間

- **本文の行間 (line-height)**: 1.8（広めに設定し、保護者層も含む幅広い年齢層の可読性を優先）
- **見出しの行間**: 1.4〜1.5
- **字間 (letter-spacing)**: 本文は 0（詰めない）。大見出し(Display/H1)のみ 0.01〜0.02em の正の字間を付け、太字ゴシックの窮屈さを緩和する

**ガイドライン**:
- 本文で字間を詰めない（-0.4pxのような負値は使わない）。読みやすさ・アクセシビリティを優先
- 見出しウェイトは 700（bold）で統一し、力強さ・前向きさを表現する
- 本文ウェイトは 400、強調が必要な箇所のみ 700 を部分適用する

### 3.6 禁則処理・改行ルール

```css
/* 推奨設定 */
overflow-wrap: break-word;
word-break: normal; /* 日本語文中の不要な英単語分割を避ける。長いURLやIDは別途 break-all を個別適用 */
line-break: strict;
```

**禁則対象**:
- 行頭禁止: `）」』】〕〉》」】、。，．・：；？！`
- 行末禁止: `（「『【〔〈《「【`
- 料金表・フォームのラベルなど短い語句は `white-space: nowrap` で意図しない改行を防ぐ

### 3.7 OpenType 機能

```css
font-feature-settings: "palt" 0, "liga" 1;
```

- **liga**: 合字を有効化
- **palt**: 見出しでは無効（Zen Kaku Gothic Newの太いウェイトを活かすため既定の字間を保持）。本文の詰め組みが必要な狭幅UI（バッジ、ラベル）でのみ個別に有効化してよい

### 3.8 縦書き

該当なし（公開サイト・管理画面ともに横書きのみ）

---

## 4. Component Stylings

### Buttons

**Primary（主要CTA: 資料請求・申込む）**
- Background: `#C2410C` (Accent 700)
- Text: `#fff`
- Hover/Press Background: `#9A3412` (Accent 800)
- Padding: 14px 28px
- Min Height: 48px（タッチターゲット確保）
- Border Radius: 8px
- Font: Label style, 16px, Weight 700
- Transition: `background-color 150ms ease-out, transform 150ms ease-out`
- Hover時に `transform: translateY(-1px)` の軽いリフトを付け、押せる感を出す（`prefers-reduced-motion` では無効化）

**Secondary（次点アクション: 資料を見る・コース詳細）**
- Background: `transparent`
- Text: `#1D4ED8` (Primary 700)
- Border: 2px solid `#1D4ED8`
- Hover Background: `#EFF6FF` (Primary 50)
- Padding: 12px 26px（枠線太さ分を調整）
- Min Height: 48px
- Border Radius: 8px

**Tertiary / Ghost（インラインリンク的な操作: もっと見る）**
- Background: `transparent`
- Text: `#1D4ED8`
- Hover: 下線表示
- Padding: 8px 4px

**LINE（LINEで相談する）**
- Background: `#06C755`
- Text: `#fff`
- Hover/Press Background: `#05A648`
- 他仕様はPrimaryに準拠。LINE公式アイコンを左に配置

**Danger（管理画面の削除等）**
- Background: `#DC2626`
- Text: `#fff`
- Hover Background: `#B91C1C`

**Disabled（共通）**
- Background: `#E5E7EB`
- Text: `#9CA3AF`
- cursor: not-allowed

### Inputs

- Background: `#fff`
- Border: 1px solid `#CBD5E1` (Border Strong)
- Border (focus): 2px solid `#1D4ED8` + `box-shadow: 0 0 0 4px rgba(29, 78, 216, 0.15)`
- Border (error): 2px solid `#DC2626` + 下部にエラーメッセージ(`#DC2626`, Body Small)
- Border Radius: 8px
- Padding: 12px 16px
- Font Size: 16px（iOS自動ズーム防止のため16px未満にしない）
- Min Height: 48px
- プレースホルダー: `#9CA3AF`

**重要確認事項ブロック（例: 免許取消歴の申告）**
現行サイトの課題（自由記述欄への埋没）を解消するため、専用コンポーネントとして独立させる。
- Background: `#FFFBEB` (Warning Light)
- Border-left: 4px solid `#D97706` (Warning)
- Padding: 16px
- Border Radius: 8px
- 見出し(Heading 3) + 明示的なラジオボタン/チェックボックスで回答必須にし、自由記述欄に統合しない

### Cards

**Course Card（コース・料金カード）**
- Background: `#fff`
- Border: 1px solid `#E5E7EB`
- Border Radius: 12px
- Padding: 20px
- Shadow: Level 1
- Hover: Shadow Level 2 + `transform: translateY(-2px)`（`prefers-reduced-motion`では無効化）
- 構成: 校舎バッジ(アウトライン) + 受講形態バッジ(通学/合宿、塗りピル) + 講習カテゴリバッジ(ドローン/建機等、該当する場合のみ、塗り角丸矩形) + 給付金/助成金バッジ(✓アイコン付き塗りピル) + コース名(H2) + 料金(Display数字, tabular-nums) + 最短日数 + CTAボタン
- バッジは形状が異なる（アウトライン/ピル/角丸矩形）ため、色が近くても役割を誤認しない

**News Card（お知らせカード）**
- Background: `#fff`
- Border: 1px solid `#E5E7EB`
- Border Radius: 12px
- Padding: 16px
- Shadow: Level 1
- 構成: 校舎バッジ(アウトライン、岩滝/網野) + 講習カテゴリバッジ(塗り角丸矩形、ドローン/建機/高齢者/ペーパードライバー/企業・法人/共通、該当する場合のみ) + 日付(Caption) + タイトル(H3)
- 一覧画面の絞り込みUI（すべて/岩滝/網野/ドローン/建機…）はタブ/チップで表現し、バッジと混同しない

**Testimonial Card（卒業生の声）**
- Background: `#EFF6FF` (Primary 50、他カードと差別化する淡色背景)
- Border: none
- Border Radius: 16px
- Padding: 24px
- 構成: 卒業生の写真/イニシャルアバター + コメント(Body) + 氏名・取得コース(Label/Caption)

**FAQ Accordion**
- Background: `#fff`
- Border: 1px solid `#E5E7EB`（項目間）
- Border Radius: 8px（グループ全体）
- 質問行 Padding: 16px、開閉アイコンは回転アニメーション200ms ease-out
- 回答領域 Background: `#F8FAFC`

### Badge

給付金/助成金タグ・受講形態・校舎・講習カテゴリ・管理画面ステータスなど、スキャンしやすさが重要な要素はすべて Badge コンポーネントに統一する。色の配色値は本書「2. Color Palette & Roles > Badge Roles」を単一の参照元とし、ここでは**役割ごとの形状ルール**を定義する（色だけでなく形状でも役割を判別できるようにするため。REV-008対応）。

**共通仕様**
- Base: `inline-flex`, `align-items: center`, `gap: 4px`
- Font: Caption style, 12px, Weight 700, letter-spacing 0.02em
- 配色は「濃色テキスト(600〜700番手) × 淡色背景(50番手)」または「白背景+濃色アウトライン」の組み合わせのみを使用し、WCAG AA（4.5:1以上）を満たす
- 同一カード内に複数バッジを並べる場合、**役割の異なるバッジは必ず異なる形状にする**（校舎=アウトライン、受講形態=ピル、カテゴリ=角丸矩形、給付金/助成金=アイコン付きピル）

**バリアント別スタイル**

| バリアント | 用途 | Background | Border | Border Radius | 例 |
|-----------|------|-----------|--------|---------------|-----|
| Outline | 校舎 | `transparent` / `#fff` | 1.5px solid（役割色） | `999px` | 岩滝校（Indigo）/ 網野校（Teal）、先頭に8px の●ドットを役割色で表示 |
| Filled Pill | 受講形態、申込・問い合わせステータス、公開ステータス | 淡色(50番手) | なし | `999px` | 通学（Blue）/ 合宿（Orange）、新規/対応中/完了、下書き/公開/非公開 |
| Filled Rounded-Rect | 講習カテゴリ | 淡色(50番手) | なし | `8px` | ドローン（Violet）/ 建機（Amber）/ 高齢者（Fuchsia）/ ペーパードライバー（Pink）/ 企業・法人（Stone）/ 共通（Gray） |
| Filled Pill + Icon | 給付金/助成金タグ | 淡色(50番手) | なし | `999px` | 給付金対象（Green, ✓アイコン）/ 助成金対象（Lime, ✓アイコン） |

Padding: Outline/Filled Pill/Filled Pill+Icon は `4px 10px`、Filled Rounded-Rect は `4px 8px`（角丸で視覚的に幅を取るためやや詰める）。

**申込・問い合わせステータス**（公開サイトの他バッジとは別画面にのみ表示されるため Semantic カラーをそのまま流用。受信管理 F-017 専用）

| ステータス | テキスト色 | 背景色 |
|-----------|----------|--------|
| 新規 | `#DC2626` (Danger) | `#FEF2F2` |
| 対応中 | `#D97706` (Warning) | `#FFFBEB` |
| 完了 | `#16A34A` (Success) | `#F0FDF4` |

**公開ステータス**（お知らせ/料金・コース/FAQ 各CMSの一覧・編集プレビュー専用、Filled Pill）

CMS編集画面では公開ステータスバッジと、対象コンテンツの校舎/カテゴリバッジ（プレビュー表示）が**同一画面に並ぶ**ため、既存バリアントと色相が衝突しない専用色を割り当てる（REV-008と同じ設計原則）。

| ステータス | テキスト色 | 背景色 |
|-----------|----------|--------|
| 下書き (DRAFT) | `#475569` (Slate 600) | `#F1F5F9` (Slate 50) |
| 公開 (PUBLISHED) | `#16A34A` (Success) | `#F0FDF4` |
| 非公開 (UNPUBLISHED) | `#0E7490` (Cyan 700) | `#ECFEFF` (Cyan 50) |

> 「非公開」は申込・問い合わせステータスの「対応中」(Amber)や講習カテゴリの「建機」(Amber)と同一画面で隣接しうるため、あえて未使用だったCyanを採用し衝突を避けている。「公開」がSuccess Greenと同色になる点は、News編集画面には給付金/助成金バッジ(Green/Lime)が現れない（お知らせはCourseと異なりsubsidyTagsを持たない）ため許容している。将来 Course CMS（F-015）にこのバリアントを転用する場合は、給付金バッジと同一プレビューに並ぶ可能性があるため色の再検証が必要。

---

## 5. Layout Principles

### Spacing Scale

| Token | Value |
|-------|-------|
| XS | 4px |
| S | 8px |
| M | 16px |
| L | 24px |
| XL | 32px |
| XXL | 48px |
| XXXL | 64px |

### Container

- Max Width: 1120px
- Padding (horizontal): 16px（モバイル） / 24px（デスクトップ）

### Hero

トップページのヒーローは写真を主役として見せる面なので、**縦サイズを min-height で下限固定する**。

| Breakpoint | Min Height |
|------------|------------|
| モバイル | 420px |
| デスクトップ（md〜） | 560px |

- Padding (vertical): 64px（XXXL）。min-height を下回る低い高さの端末でコピーが上下端に張り付かないための下支えとして残す
- キャッチコピー／CTA は縦中央揃え。高さが伸びてもテキスト塊が上に取り残されないようにする
- 高さは Spacing Scale ではなく Container Max Width と同じ**レイアウト寸法**として扱う（Spacing Scale の意味を歪めないため）

### Grid

- コースカード一覧: モバイル1列 → タブレット2列 → デスクトップ3〜4列
- 料金横断比較表（校舎×免許種別）: モバイルは横スクロール可能なカード/テーブルハイブリッド、デスクトップは全項目を1画面のテーブルで表示
- Gutter: 16px（モバイル） / 24px（デスクトップ）

### モバイル固定CTAバー

- スマホ表示時、画面下部に `資料請求` (Primary) と `LINEで相談する` (LINE) を並べた固定バーを表示
- Background: `#fff`, Shadow: Level 2（上向き）, Padding: 12px 16px, `padding-bottom: env(safe-area-inset-bottom)` でノッチ対応

---

## 6. Depth & Elevation

| Level | Shadow | 用途 |
|-------|--------|------|
| 0 | none | フラットな要素、区切り線のみの表現 |
| 1 | `0 1px 3px rgba(15, 23, 42, 0.08)` | コース/お知らせカードの通常状態 |
| 2 | `0 4px 12px rgba(15, 23, 42, 0.12)` | カードホバー、ドロップダウン、固定CTAバー |
| 3 | `0 12px 32px rgba(15, 23, 42, 0.18)` | モーダル、ステップフォームのダイアログ、チャットボットウィンドウ |
| 4 | `0 16px 40px rgba(15, 23, 42, 0.22)` | チャットボットFAB（フローティングアクションボタン） |

---

## 7. Do's and Don'ts

### Do（推奨）

- Primary(青)は「情報・ナビゲーション」、Accent(オレンジ)は「今すぐ行動してほしいCTA」に役割を固定して使う
- 淡色背景(50番台)の上に濃色テキスト(600〜700番台)を置き、WCAG AA（通常文字4.5:1、UIコンポーネント3:1以上）を満たす
- タッチターゲットは最小44px、ボタン・入力欄は48pxを標準にする
- 免許取消歴など法的に重要な確認事項は、専用の警告スタイルコンポーネントとして独立させ、自由記述欄に埋没させない
- 料金・数値は `tabular-nums` で桁を揃える
- アニメーションは `prefers-reduced-motion: reduce` で無効化できるようにする
- 校舎・受講形態・講習カテゴリ・給付金/助成金タグは常に固定の識別色と形状（本書「2. Badge Roles」）を使い、ページ間で一貫させる
- 同じカードに複数の役割のバッジを並べる場合、色相に加えて形状（アウトライン/ピル/角丸矩形/アイコン付き）でも役割を判別できるようにする（色だけに依存しない）

### Don't（禁止）

- LINE Green (`#06C755`) をLINE公式ボタン以外に使わない（ブランドガイドライン違反を避ける）
- Accent 500 (`#F97316`) の上に小さな文字を乗せない（コントラスト比不足）。文字を乗せる面は必ずAccent 700を使う
- 本文の letter-spacing を負の値にしない（詰め組みは可読性を下げるため使用しない）
- 見出しウェイトを 400 や 500 にしない（Display/H1/H2は700で統一し、力強さを保つ）
- 装飾やアニメーションを過剰に入れて信頼感を損なわない（ゲーム的な過剰演出は避け、マイクロインタラクションは控えめに留める）
- 申込フォームの必須項目を一度に大量表示しない（ステップ分割し、各ステップの完了状況を可視化する）
- 校舎バッジ(Indigo/Teal)の色を受講形態や講習カテゴリのバッジに転用しない。ある役割で使った色相を他の役割で使い回さない（REV-008: 岩滝校と通学、網野校と助成金が同色になっていた問題の再発防止）

---

## 8. Responsive Behavior

### Breakpoints

| Name | Width | 説明 |
|------|-------|------|
| Mobile | ≤ 767px | モバイルレイアウト（主要ターゲット。優先的に設計する） |
| Tablet | 768px 〜 1023px | タブレットレイアウト |
| Desktop | ≥ 1024px | デスクトップレイアウト |

### タッチターゲット

- 最小サイズ: 44px × 44px（WCAG基準）
- ボタン・入力欄は 48px を標準とする

### フォントサイズの調整

- Display/Heading系は `clamp()` でモバイル値〜デスクトップ値を滑らかに補間する（本書「3.4」表のモバイル→デスクトップ値を上限/下限に使用）
- Body/Labelはブレークポイントで変更せず、全デバイスで固定サイズ（16px/14px）を維持し可読性を保つ

### モバイル最適化の重点

- ヒーロー直下にCTA（資料請求・LINE相談）を配置し、スクロールなしで行動できるようにする
- 料金比較は「校舎×コース種別」を絞り込みタブ/フィルタで段階的に見せ、一度に全表を出さない
- 申込フォームはステップ式（進捗インジケーター付き）とし、1画面あたりの入力項目を最小限にする

---

## 9. Agent Prompt Guide

### クイックリファレンス

```
Primary Color: #1D4ED8 (hover: #1E40AF, tint bg: #EFF6FF)
Accent/CTA Color: #C2410C (hover: #9A3412, tint bg: #FFF7ED, decorative-only vivid: #F97316)
LINE Color: #06C755 (LINE CTAのみ)
Success: #16A34A / Warning: #D97706 / Danger: #DC2626 / Info: #0284C7
Text Primary: #111827 / Text Secondary: #4B5563
Background: #F8FAFC / Surface: #FFFFFF
Heading Font: Zen Kaku Gothic New (weight 700)
Body Font: Noto Sans JP (weight 400, line-height 1.8)
Border Radius: 8px（ボタン/入力欄/カード内要素）, 12px（カード）, 999px（バッジ: 校舎/受講形態/給付金・助成金）, 8px（バッジ: 講習カテゴリ）
Touch Target: 48px（ボタン/入力欄）, 最小44px

Badge Roles（役割ごとに色相と形状を分離。詳細は本書「2. Badge Roles」）:
  校舎(Outline+●ドット): 岩滝校 #4338CA(Indigo) / 網野校 #0F766E(Teal)
  受講形態(Filled Pill): 通学 #1D4ED8 on #EFF6FF / 合宿 #C2410C on #FFF7ED
  講習カテゴリ(Filled Rounded-Rect 8px): ドローン #6D28D9 on #F5F3FF / 建機 #B45309 on #FFFBEB /
    高齢者講習 #A21CAF on #FDF4FF / ペーパードライバー講習 #BE185D on #FDF2F8 /
    企業・法人研修 #44403C on #FAFAF9 / 共通 #4B5563 on #F3F4F6
  給付金/助成金(Filled Pill + ✓アイコン): 給付金対象 #16A34A on #F0FDF4 / 助成金対象 #4D7C0F on #F7FEE7
```

### プロンプト例

```
岩滝・網野自動車教習所サイトのデザインシステムに従って、コース料金カードを作成してください。
- 校舎バッジ: 岩滝校=アウトライン+●(Indigo #4338CA)、網野校=アウトライン+●(Teal #0F766E)。背景は透明/白、塗りバッジとは形状で区別する
- 受講形態バッジ(塗りピル): 通学は #1D4ED8 on #EFF6FF、合宿は #C2410C on #FFF7ED（12px Bold）
- 講習カテゴリバッジ(塗り角丸矩形 radius 8px、該当時のみ): 例）ドローンは #6D28D9 on #F5F3FF
- 給付金/助成金バッジ(✓アイコン付き塗りピル): 給付金対象は #16A34A on #F0FDF4、助成金対象は #4D7C0F on #F7FEE7
- 校舎・受講形態・カテゴリ・給付金/助成金は色相も形状も重複させない（同色の使い回し禁止）
- 料金は tabular-nums で桁を揃え、Display寄りのサイズで強調
- CTAボタンは Primary(Accent 700 #C2410C, 白文字, 48px高さ, radius 8px)
- 背景 #fff、border 1px solid #E5E7EB、radius 12px、shadow level 1（hoverでlevel 2 + translateY(-2px)）
- 見出しフォントは Zen Kaku Gothic New 700、本文は Noto Sans JP 400 / line-height 1.8
- タッチターゲット最小44px、prefers-reduced-motion 対応を忘れない
```
