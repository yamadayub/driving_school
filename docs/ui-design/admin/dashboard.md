# UI設計: 管理ダッシュボード（F-013）

> 準拠: `/DESIGN.md`。共通シェルは `./admin-layout.md`。
> 対応要件: `functional-spec.md` F-013
> スコープ: 本フェーズは「お知らせ管理」のみ実機能。料金・コース(F-015)/FAQ(F-016)/受信管理(F-017)は**枠のみ**用意し、後続フェーズで有効化する。

## ビジュアルコンセプト

- ログイン直後に開く画面。「今すぐ対応が要ることがあるか」（新規問い合わせ件数）と「どこへ行けば何ができるか」（管理メニュー）の2つだけに情報を絞る。ダッシュボードを情報過多にしない。

## レイアウト

```
┌──────────────────────────────────────────┐
│ SectionHeading: title="ダッシュボード"           │
├──────────────────────────────────────────┤
│ StatCard: 新規の問い合わせ  [3件]（準備中: 受信管理未実装のため暫定非表示 or 「準備中」表記）│
├──────────────────────────────────────────┤
│ DashboardCard グリッド（2〜4列）                 │
│ ┌────────┐┌────────┐┌────────┐┌────────┐│
│ │お知らせ管理│││料金・コース││FAQ管理  ││受信管理  ││
│ │[件数:12] │││準備中    ││準備中   ││準備中   ││
│ │→ 開く   │││        ││       ││       ││
│ └────────┘└────────┘└────────┘└────────┘│
└──────────────────────────────────────────┘
```

## StatCard（新規問い合わせ件数）

- F-013画面仕様「新規申込・問い合わせ件数」に対応するが、**受信管理(F-017)は本フェーズ未実装**のため、件数取得元（`Application`テーブル）自体は既存スキーマにあるならAPIで取得して表示してよいが、クリック先の受信管理ページが無い状態になる。
  - **設計判断**: 件数は表示するが、カードはクリック不可（`DashboardCard`のdisabledパターンを流用）とし、右下に「準備中」を添える。F-017実装後にリンクを有効化する。
  - 件数取得ができない/対象データがまだ無い場合は `0件` を表示し、0を異常として扱わない。

```ts
StatCard:
  props: { label: string; value: number | null; tone?: "default" | "attention" }
  // valueがnullの場合は"—"表示（データ未取得/機能未実装を区別するため0とは別扱い）
```
- `tone="attention"`（value > 0のとき）: 数字を Danger `#DC2626` で強調し、対応が必要であることを視覚化。0件は Text Primary の通常トーンで表示（警告色を使わない）。

## DashboardCard（管理メニューカード）

```
┌────────────────────┐
│ [アイコン]              │
│ お知らせ管理              │
│ お知らせの作成・編集・公開   │
│ 全12件（公開9・下書き3）    │
│                     │
│              開く → │
└────────────────────┘
```

```ts
DashboardCard:
  props: {
    title: string
    description: string
    summary?: string        // 例: "全12件（公開9・下書き3）"。データ無ければ省略可
    href?: string            // 省略時はdisabled表示
    disabled?: boolean
  }
```

- 有効カード（お知らせ管理）: Background `#fff`, Border `1px solid #E5E7EB`, Border Radius 12px, Padding 20px, Shadow Level 1, hover: Shadow Level 2 + `translateY(-2px)`（公開サイトCourseCardと同じ挙動、`prefers-reduced-motion`で無効化）。クリックで `/admin/news` へ。
- Disabled カード（料金・コース/FAQ/受信管理）: 同じ枠組みだが `opacity: 0.6`、`cursor: not-allowed`、`aria-disabled="true"`、右下に「準備中」テキスト（Badgeではなく通常テキスト、`admin-layout.md`のSidebar準備中表記と同じ考え方）、hoverエフェクトなし。
- Grid: Desktop 4列 / Tablet 2列 / Mobile 1列。

## 振る舞い仕様

**正常系**: 認証済みユーザーにStatCardとDashboardCardグリッドを表示。「お知らせ管理」カードから `/admin/news` へ遷移できる。
**異常系**: 未認証は `admin-layout.md` の認可フロー（middlewareリダイレクト）に従う。統計取得失敗時はStatCardを `value=null`（"—"表示）にフォールバックし、ダッシュボード自体は表示を継続する（F-001のNEWS取得失敗パターンと同じ「部分劣化」方針）。

## データソース

```
GET (Server Component, 認証必須)
- prisma.application.count({ where: { status: 'NEW' } })  // F-013 API仕様。F-017実装前でもデータがあれば取得可能
- prisma.news.count()  // お知らせ全件数（summary表示用）
- prisma.news.count({ where: { status: 'PUBLISHED' } })
- prisma.news.count({ where: { status: 'DRAFT' } })
```

## アクセシビリティ

- DashboardCardは実体を `<a>`（有効時）または `<div role="button" aria-disabled="true">`（無効時）とし、無効カードはTabフォーカス可能だが操作できないことが伝わるようにする（`admin-layout.md`のSidebar disabledと同じ方針）。
- StatCardの数値変化（将来的なリアルタイム更新を想定する場合）は `aria-live="polite"` にしておく。

## レスポンシブ

| ブレークポイント | DashboardCard | StatCard |
|-----------------|---------------|----------|
| Mobile | 1列 | 全幅 |
| Tablet | 2列 | 全幅 |
| Desktop | 4列 | 横長1枚、Cardグリッドの上部に配置 |
