# UI設計: コース詳細（F-003） / スクール・追加講習詳細（F-022）

> 準拠: `/DESIGN.md`、共通コンポーネントは `./layout.md` §7 を参照。
> 対応要件: `functional-spec.md` F-003（LICENSE詳細）, F-022（スクール・追加講習一覧・詳細）
> 両者は `Course` エンティティを共有するため（`category` で分岐）、UIも共通テンプレート（DetailHero + SpecTable）を土台にバリエーションさせる。

## ビジュアルコンセプト

- 比較ページ（一覧）で気になったコースを選んだ後の「意思決定を後押しする」ページ。料金・日数・対応校を即座に確認でき、迷わず申込CTAへ到達できることを最優先する。
- LICENSE（免許）とスクール・追加講習系は情報構造が異なるため、共通レイアウトの中で「受講形態バッジの有無」「カテゴリバッジの有無」だけを出し分ける。

## 共通テンプレート: DetailHero + SpecTable

```
┌──────────────────────────────────────────┐
│ Breadcrumb                                 │
├──────────────────────────────────────────┤
│ DetailHero                                 │
│   [校舎Badge×1-2] [受講形態Badge or カテゴリBadge] │
│   [給付金/助成金Badge]                        │
│   見出し: 普通車(AT) 通学  ／  農業用ドローンスクール │
├──────────────────────────────────────────┤
│ SpecTable                                  │
│  対応校     | 岩滝・網野                       │
│  受講形態    | 通学  （非LICENSEでnullなら行自体を非表示）│
│  最短日数    | 15日                          │
│  料金〜     | ¥225,500（tabular-nums, Display寄りサイズ）│
├──────────────────────────────────────────┤
│ 説明本文（description, Bodyスタイル）            │
├──────────────────────────────────────────┤
│ 申込/問い合わせCTA（sticky footer on mobile）    │
├──────────────────────────────────────────┤
│ 関連コース（同カテゴリ内の他コース、任意）           │
└──────────────────────────────────────────┘
```

### コンポーネント契約

```ts
DetailHero:
  props: {
    schools: SchoolCode[]
    format: "TSUGAKU" | "GASSHUKU" | null       // null時はformatバッジを描画しない
    category: ProgramCategory | null              // category='LICENSE'ではnull、非LICENSEで描画
    subsidyTags: ("GRANT" | "SUBSIDY")[]
    title: string                                  // licenseTypeLabel(+transmission) または programLabel
  }

SpecTable:
  props: {
    rows: { label: string; value: string; hidden?: boolean }[]
    // 値がnullの項目（例: 非LICENSEのtransmission）は呼び出し側でhidden=trueにしてrenderしない
    priceFrom: number   // 専用フィールドとしてtabular-nums+強調スタイルを当てる
  }
```

- `SpecTable` の行は `<dl>`（`<dt>`ラベル/`<dd>`値）でマークアップし、ラベル列は Text Secondary・値列は Text Primary。
- `料金〜` 行のみ他行よりフォントサイズを1段階上げる（Heading3相当、tabular-nums）。

## バリエーションA: F-003 LICENSE詳細

- `title` = `licenseTypeLabel`（例: 「普通車」）+ `transmission` があれば「(AT)」を付記 + `format`ラベル（例: 「普通車(AT) 通学」）。
- `DetailHero` バッジ: 校舎（Outline）+ 受講形態（Filled Pill）+ 給付金/助成金（あれば）。カテゴリバッジは出さない（LICENSEはカテゴリ概念をUIに出さない）。
- 申込CTA: 「このコースで申込む」→ `/apply?courseId=[id]&type=APPLICATION`（コースID・校舎・受講形態を事前選択状態でF-008へ引き継ぐ）。
- 関連コース: 同 `licenseType` の他 `format`（通学↔合宿）または同 `format` の他 `licenseType` を2〜3件、`CourseCard` で表示（任意、データがなければセクション非表示）。

## バリエーションB: F-022 スクール・追加講習

### 一覧ページ（`/programs`）

```
┌──────────────────────────────────────────┐
│ Breadcrumb: トップ ＞ スクール                 │
│ SectionHeading: title="スクール・追加講習"        │
├──────────────────────────────────────────┤
│ カテゴリタブ: [すべて][ドローン][建機][追加講習]     │
├──────────────────────────────────────────┤
│ ProgramCard グリッド（category別グルーピング見出し付き）│
│  ドローンスクール                              │
│   [ProgramCard][ProgramCard]                 │
│  建機スクール                                 │
│   [ProgramCard]                              │
│  追加講習                                     │
│   [ProgramCard: 高齢者講習][ProgramCard: ペーパー][ProgramCard: 企業]│
└──────────────────────────────────────────┘
```

- 「追加講習」タブは `SENIOR`/`BEGINNER`/`CORPORATE` の3カテゴリをまとめて表示し、各カードに個別のカテゴリバッジ（高齢者=Fuchsia／ペーパー=Pink／企業=Stone）を付ける。
- E-022-2「0件」時: `EmptyState` message="準備中です"（カテゴリ単位で判定。あるカテゴリが0件でもタブ自体は残す）。

```ts
ProgramCard:  // CourseCard のprops形状を継承（category/programLabel/subsidyTagsを使用）
  props: {
    id: string
    category: "DRONE" | "KENKI" | "SENIOR" | "BEGINNER" | "CORPORATE"
    programLabel: string
    minDays: number | null
    priceFrom: number
    schools: SchoolCode[]
    subsidyTags: ("GRANT" | "SUBSIDY")[]
    href: string
  }
```
- `CourseCard` とレイアウトは共通（DESIGN.md Cards > Course Card準拠）だが、`format`バッジの代わりに `category`バッジ（塗り角丸矩形）を表示する点のみ異なる。実装上は `CourseCard` に `category` propを追加して1コンポーネントに統合してもよい（Impl Agentの裁量、Props契約の互換性のみ本書で保証する）。

### 詳細ページ（`/programs/[id]`）

- `DetailHero` の `title` = `programLabel`（例: 「農業用ドローンスクール」）。
- バッジ: 校舎（Outline）+ カテゴリ（塗り角丸矩形、例: ドローン=Violet）+ 給付金/助成金（あれば。ドローン/建機は助成金対象が多い想定、`product-concept.md` 給付金/助成金タグ運用に対応）。
- `SpecTable` の「受講形態」行は `format=null` のため非表示（`hidden=true`）。「対象」等プログラム固有の補足があれば説明本文（description）内に記載し、行を無理に増やさない。
- 申込CTA: 「問い合わせる」（`type=INQUIRY`初期値、ただし申込も選べる）→ `/apply?courseId=[id]`。LICENSEと異なりデフォルトを問い合わせ寄りにする（スクール系は法人・个別要件相談が多いため、business-spec想定ユーザー像に合わせた初期値選択。ユーザーはStep1で申込/問い合わせを再選択可能）。

## 異常系

| ケース | 対応 |
|--------|------|
| E-003-1 / E-022-1 コース未存在・非公開 | `notFound()` → 404ページ（サイト共通404デザイン、Header/Footerは維持しメッセージ+トップ/コース比較への導線） |
| E-022-2 一覧0件（カテゴリ単位） | `EmptyState` message="準備中です" |

## インタラクション定義

| トリガー | アニメーション | 持続時間 | イージング |
|---------|-------------|---------|----------|
| カテゴリタブ切替（一覧） | コンテンツフェード | 200ms | ease-out |
| ProgramCard/CourseCardホバー | Shadow上昇+translateY(-2px) | 200ms | ease-out |
| モバイルsticky申込CTA出現 | フェード+スライドアップ（スクロールでHero内CTAが隠れたら表示） | 200ms | ease-out |

## データソース

- F-003: `prisma.course.findFirst({ where: { id, published: true } })`
- F-022一覧: `GET /api/programs?category=` → `prisma.course.findMany({ where: { category: { in: ['DRONE','KENKI','ADDITIONAL'] }, published: true }, orderBy: { sortOrder: 'asc' } })`
- F-022詳細: `GET (Server Component) /programs/[id]`

## アクセシビリティ

- `title` は `<h1>`。SpecTableは`<dl>`でリスト構造を明示。
- モバイルの sticky申込CTA はページ本文の最後の実CTAとキーボードフォーカス順序が重複しないよう、`tabindex`操作は行わず自然なDOM順で最後に配置する（視覚的にstickyでも読み上げ順は乱さない）。
- パンくず・関連コースのリンクにはリンクテキストだけで行き先が分かる文言を使う（「詳細を見る」ではなく「普通車(AT)通学の詳細を見る」等、aria-label併記可）。

## レスポンシブ

| ブレークポイント | DetailHero/SpecTable | 申込CTA |
|-----------------|----------------------|---------|
| Mobile | 縦積み、SpecTableは全幅 `<dl>` | 画面下部sticky（MobileCtaBarとは別、ページ固有のCTAとして重ねずMobileCtaBarを一時非表示にする設計は取らず、ページ内CTAをMobileCtaBarより上位に表示。両者が並ぶ場合はページ内CTAを優先しMobileCtaBarはこのページ種別で非表示、`layout.md`§4のhidden対象に含める） |
| Tablet/Desktop | 2カラム（左: Hero+SpecTable、右: 説明文+関連コース） | Hero内に通常配置 |
