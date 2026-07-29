# UI設計: 学校案内・アクセス（F-007）

> 準拠: `/DESIGN.md`、共通コンポーネントは `./layout.md` §7 を参照。
> 対応要件: `functional-spec.md` F-007（画面仕様・データモデル `SchoolInfo`）
> ナビ上の扱い: ヘッダー「学校案内」→ `/schools`（ページ先頭）、「アクセス」→ `/schools#access`（本ページ内の統合アクセスセクションへのアンカー。別ページは作らない、`layout.md` §2 参照）。

## ビジュアルコンセプト

- 2校を**対等に**並べ、「近いほう・通いやすいほうを選べる」ことを一目で伝える。
- 保護者層が安心できる「所在地の明確さ」「電話のかけやすさ」を最優先し、装飾より情報の到達性を優先する。

## レイアウト

```
┌──────────────────────────────────────────┐
│ Breadcrumb: トップ ＞ 学校案内                 │
│ SectionHeading: title="学校案内"               │
├──────────────────────────────────────────┤
│ id="iwataki"  SchoolProfile（岩滝校）           │
├──────────────────────────────────────────┤
│ id="amino"    SchoolProfile（網野校）           │
├──────────────────────────────────────────┤
│ id="access"   AccessSection（2校統合）           │
│   [岩滝校 地図+行き方] [網野校 地図+行き方]         │
│   [送迎バスのご案内 → /bus]                     │
└──────────────────────────────────────────┘
```

- `id="iwataki"` / `id="amino"` はトップページ SchoolInfo セクション（`top-page.md` §5）からのアンカーリンク先と一致させる。
- `id="access"` はヘッダーナビ「アクセス」およびトップページ Access セクション（`top-page.md` §7）の「詳しいアクセス・地図を見る」の遷移先と一致させる。

## SchoolProfile（校舎紹介ブロック、岩滝/網野で2回使用）

```
┌──────────────────────────────────────────┐
│ [校舎写真]                                   │
│ [Badge(school)] 岩滝校                        │
│ 〒629-2263 京都府与謝野町字弓木1459-1            │
│ [📞 0120-46-4163（フリーダイヤル）] [📞 0772-46-4131（直通）]│
│                                              │
│ 特徴: 指名制 / 女性教習 / スマホ予約 / ...          │
│ 対応免許: [普通車][準中型][中型][大型][普通二種]...   │
│                                              │
│ [資料請求] [この校舎で申込む]                     │
└──────────────────────────────────────────┘
```

```ts
SchoolProfile:
  props: {
    code: "IWATAKI" | "AMINO"
    name: string
    postalCode: string
    address: string
    phoneTollFree: string
    phoneDirect: string
    photoUrl: string
    features: string[]
    licenseTypeLabels: string[]   // 対応免許 → Badge(variant="format")ではなく単純なタグ表示（受講形態ではないため通常のOutlineタグ、Badgeコンポーネント流用せず簡易Chipで表示）
  }
```
- 電話番号は両方とも `tel:` リンク化（フリーダイヤル優先表示、直通は補足）。タッチターゲット44px。
- 対応免許タグはBadgeコンポーネント（school/format/category/subsidy）のいずれにも該当しないため、`layout.md`のBadgeとは別の軽量 `Chip`（Border 1px solid `#E5E7EB`, 背景`#fff`, テキスト Text Secondary, radius 999px）で表示する—意味的に「識別」ではなく「一覧」なので強い色を割り当てない。
- Desktop: 写真とテキストを左右2カラム（交互に写真の左右を入れ替えても良いが、A11yより実装簡潔性を優先し両校とも同一レイアウトで統一）。Mobile: 縦積み。

## AccessSection（統合アクセス、2校分をまとめて表示）

```
Desktop: 2カラム（岩滝 / 網野）
Mobile : 縦積み
```

各校ブロック:
- 地図: `iframe`（Google Maps埋め込み）または静的画像。**フォールバック必須**（F-007異常系「地図読み込み失敗時は住所テキストとリンクにフォールバック」）: `iframe`の読み込み失敗/ブロック時に住所テキスト+「Googleマップで見る」外部リンクを表示するコンポーネント設計にする。
- 最寄駅からの所要時間（例: 「岩滝口駅 徒歩20分」）。
- 「Googleマップで経路を調べる」外部リンクボタン（`CTAButton variant="secondary"`）。

```ts
AccessMap:
  props: { school: SchoolInfo; embedUrl: string | null }
  // embedUrl が null または iframe onError発火時はフォールバック表示（住所テキスト＋外部リンク）に切り替える
```

- 末尾に送迎バス案内への誘導カード（F-023 `/bus` への軽量リンク、アイコン+一言+「送迎バスの詳細を見る」リンク）。

## 異常系

| ケース | 対応 |
|--------|------|
| 地図読み込み失敗 | `AccessMap` フォールバック（住所テキスト＋外部Googleマップリンク） |
| `SchoolInfo` データ欠落（想定外） | 当該フィールドの表示を省略し、電話・住所など必須項目が欠けている場合はページ全体をビルド時定数で保証する（デモではDB非依存の定数管理のため実運用上は起こり得ない） |

## インタラクション定義

| トリガー | アニメーション | 持続時間 | イージング |
|---------|-------------|---------|----------|
| ページ内アンカー遷移（#iwataki 等） | スムーススクロール（`scroll-behavior: smooth`、`prefers-reduced-motion`で無効化） | - | - |
| 対応免許Chip一覧のホバー(desktop) | 背景色わずかに変化 | 150ms | ease-out |

## データソース

`SchoolInfo` 定数（F-007データモデル、シード/定数管理。管理画面での編集はスコープ外）:
```ts
interface SchoolInfo {
  code: "IWATAKI" | "AMINO"
  name: string
  postalCode: string
  address: string
  phoneTollFree: string
  phoneDirect: string
  access: string
  geo: { lat: number; lng: number } | null
  features: string[]
  licenseTypes: string[]
}
```

## アクセシビリティ

- 各 `SchoolProfile` の見出し（校名）は `<h2>`、`AccessSection` の校舎別小見出しは `<h3>`。
- 地図 `iframe` には `title="岩滝校の地図"` 等を付与。
- 電話リンクは `aria-label="岩滝校フリーダイヤル 0120-46-4163"` のように読み上げが自然になるよう補足する。
- アンカーリンク遷移後、フォーカスを見出しへ移動させる（スクリーンリーダー利用者が現在地を把握できるように、`tabindex="-1"` を見出しに付与しJSでフォーカス）。

## レスポンシブ

| ブレークポイント | SchoolProfile | AccessSection |
|-----------------|---------------|----------------|
| Mobile | 縦積み（写真→テキスト） | 縦積み |
| Tablet | 縦積み（写真幅を制限） | 縦積み or 2列（要検証、初期実装は縦積みで可） |
| Desktop | 左右2カラム | 左右2カラム |
