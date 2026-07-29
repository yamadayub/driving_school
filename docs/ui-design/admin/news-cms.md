# UI設計: お知らせ管理（CMS CRUD, F-014）

> 準拠: `/DESIGN.md`。共通シェルは `./admin-layout.md`。公開サイト側の対応表示は `../top-page.md`（NewsCard）を参照。
> 対応要件: `functional-spec.md` F-014（画面仕様・API仕様）, `business-spec.md` US-012
> データモデル: `News`（F-004参照。`category`: IWATAKI/AMINO/DRONE/KENKI/COMMON、REV-006で'ALL'廃止）

## ビジュアルコンセプト

- 「事務スタッフが自分でお知らせを即時更新できる」ことがこのプロジェクトの中核価値（`product-concept.md` Pain#1）。迷わず「新規作成→保存→公開」まで到達できることを最優先する。
- 一覧は情報密度高め（DataTable）、編集は逆にステップを踏ませず**1画面完結のフォーム**にする（申込フォームのようなステップ分割はしない。項目数が少なく事務作業の速度を優先するため）。

## 画面構成

```
/admin/news         一覧
/admin/news/new      新規作成
/admin/news/[id]/edit 編集
```

---

## 1. 一覧画面（`/admin/news`）

```
┌──────────────────────────────────────────┐
│ SectionHeading: title="お知らせ管理"    [+ 新規作成]│
├──────────────────────────────────────────┤
│ FilterBar: [ステータス▾][カテゴリ▾] [検索キーワード  ]│
├──────────────────────────────────────────┤
│ DataTable                                  │
│ タイトル       |カテゴリ|公開ステータス|公開日|更新日|操作│
│ 夏の入校キャンペーン|[岩滝校]|[公開]  |07/01|07/15|[編集][削除]│
│ ドローン体験会のお知らせ|[ドローン]|[下書き]|— |07/10|[編集][削除]│
│ ...                                        │
├──────────────────────────────────────────┤
│ Pagination                                 │
└──────────────────────────────────────────┘
```

### フィルタ

| フィルタ | 選択肢 |
|---------|--------|
| ステータス | すべて / 下書き / 公開 / 非公開 |
| カテゴリ | すべて / 岩滝 / 網野 / ドローン / 建機 / 共通 |
| 検索キーワード | タイトル部分一致（入力後デバウンス300msでフィルタ、Enterでも即時実行） |

- フィルタ変更はURLクエリに同期（`?status=&category=&q=&page=`）、公開サイトの比較ページと同じ方針（`../course-comparison.md`参照）。

### DataTable

```ts
DataTable<T>:
  props: {
    columns: { key: string; label: string; align?: "left" | "right"; width?: string }[]
    rows: T[]
    getRowId: (row: T) => string
    renderCell: (row: T, columnKey: string) => ReactNode
    isLoading?: boolean
    emptyState?: ReactNode
  }
```

- 列: タイトル(左, リンク=編集へ) / カテゴリ(`Badge variant="school"` or `variant="category"`、値により出し分け) / 公開ステータス(`Badge variant="publishStatus"`、DESIGN.md新規バリアント) / 公開日(YYYY.MM.DD、`—`は未公開) / 更新日 / 操作(編集・削除ボタン)。
- 行ホバー: 背景 `#F8FAFC`。
- タイトル列は50文字超で末尾省略（`text-overflow: ellipsis`）、フルタイトルは `title`属性 または 編集画面で確認。
- 0件時: `EmptyState`（`../layout.md` §7.6 を再利用）message="お知らせがありません"、フィルタ適用中なら "条件に合うお知らせがありません"+「フィルタをリセット」。
- ページネーション: 1ページ20件（管理画面は公開サイトの10件より多く、事務作業の効率を優先）。

### 操作列

- 「編集」→ `/admin/news/[id]/edit`
- 「削除」→ `ConfirmDialog` を開く（即座に削除しない）

```ts
ConfirmDialog ("use client"):
  props: {
    isOpen: boolean
    title: string             // 例: "「夏の入校キャンペーン」を削除しますか？"
    description: string       // 例: "この操作は取り消せません。"
    confirmLabel: string      // "削除する"
    confirmVariant: "danger" | "primary"
    onConfirm: () => void
    onCancel: () => void
    isProcessing?: boolean    // 確認ボタン押下後、二重送信防止のdisabled+スピナー
  }
```
- モーダル、`role="alertdialog"`、`aria-modal="true"`、開いた瞬間キャンセルボタン（安全側）にフォーカス、フォーカストラップ、`Esc`で閉じる（キャンセル扱い）。
- 確認ボタンは `CTAButton variant="danger"`。

---

## 2. 作成・編集フォーム（`/admin/news/new`, `/admin/news/[id]/edit`）

```
┌──────────────────────────────────────────┐
│ Breadcrumb: ダッシュボード＞お知らせ＞新規作成       │
├──────────────────────────────────────────┤
│ FormField: タイトル [                    ] (1〜100文字)│
│ FormField: カテゴリ [岩滝 ▾]                    │
│ FormField: 公開ステータス ( )下書き (•)公開 ( )非公開 │
│ FormField: 公開日時 [2026-07-19 10:00] ※公開時必須 │
│ FormField: 本文                                │
│   [B][I][リンク][見出し][リスト] ツールバー         │
│   ┌───────────────┬───────────────┐  │
│   │ Markdown入力欄     │ プレビュー         │  │
│   │                │ [カテゴリBadge]      │  │
│   │                │ タイトル             │  │
│   │                │ サニタイズ済み本文    │  │
│   └───────────────┴───────────────┘  │
├──────────────────────────────────────────┤
│ [キャンセル]                    [下書き保存][公開する]│
└──────────────────────────────────────────┘
```

### フォーム項目（F-014画面仕様準拠 + 公開ステータス3値化）

| 項目 | 種別 | 必須 | バリデーション |
|------|------|------|-------------|
| タイトル | text input | Yes | 1〜100文字 |
| カテゴリ | select | Yes | `IWATAKI/AMINO/DRONE/KENKI/COMMON` のいずれか |
| 公開ステータス | radio (3択) | Yes | 下書き/公開/非公開。初期値は新規作成時「下書き」 |
| 公開日時 | datetime picker | 公開ステータス=公開のとき必須 | 未来日時可（予約公開）、過去日時も可（即時公開扱い） |
| 本文 | Markdownエディタ | Yes | 1文字以上。詳細は「3. 本文エディタとサニタイズ方針」参照 |

> **公開ステータスの3値化について（要仕様確認）**: `functional-spec.md` F-004データモデルは現状 `PublishStatus = 'DRAFT' \| 'PUBLISHED'` の2値のみを定義しており、「非公開」に相当する値がない。本UI設計は依頼内容（下書き/公開/非公開の3状態バッジ）に従い3値を前提に設計しているが、**Spec Agentによる`functional-spec.md`/`business-spec.md`側の追補（例: `PublishStatus`に`'UNPUBLISHED'`を追加し「一度公開したが取り下げた」の意味を定義）が実装前に必要**。バッジ配色は `DESIGN.md`側に3値分（下書き=Slate、公開=Success Green、非公開=Cyan）を先行して登録済み。

### FormField

```ts
FormField:
  props: {
    label: string
    htmlFor: string
    required?: boolean
    error?: string          // エラーメッセージ、DESIGN.md Inputs Border(error)を適用
    helpText?: string
    children: ReactNode      // input/select/radio-group/editor本体
  }
```
- エラー表示は DESIGN.md Inputs 準拠: 枠線 `2px solid #DC2626`、直下に赤文字エラーメッセージ（Body Small）。
- 必須項目ラベルには "*" ではなく「必須」の小さな `Badge`風ラベル（Danger系ではなく控えめな Text Secondary 上のCaptionテキスト "必須" とする。エラー色の乱用を避けるためDangerは実際のエラー発生時のみに予約する）。

### カテゴリ選択とプレビューのバッジ出し分け

- `IWATAKI`/`AMINO` → プレビューで `Badge variant="school"`（Outline+ドット）
- `DRONE`/`KENKI`/`COMMON` → プレビューで `Badge variant="category"`（塗り角丸矩形）
- 公開ステータスは常に `Badge variant="publishStatus"`（塗りピル）をプレビュー右上に表示し、カテゴリバッジと形状・色相の両方で判別できることを編集中から確認できるようにする（`DESIGN.md`のBadge Roles分離ルールをCMS上でも一貫させる）。

### 保存アクション

- 「下書き保存」: `status=DRAFT` で保存。公開日時未入力でも保存可。
- 「公開する」: `status=PUBLISHED` で保存。公開日時が未入力ならクライアント側で現在日時を提案（editable）。公開日時が未来の場合は「予約公開」であることを保存確認時に明示（トースト等で「2026-08-01 10:00に公開されます」）。
- 両ボタンとも送信中は `disabled` + スピナー（二重送信防止、F-010の申込フォームと同じ方針を管理画面にも適用）。
- 保存成功後は一覧へ遷移し、成功トースト「お知らせを保存しました」を表示。

### 異常系（F-014準拠）

| ケース | エラーメッセージ | 振る舞い |
|--------|---------------|---------|
| E-014-1 必須未入力 | 「必須項目です」 | 該当FormField直下に表示、保存不可 |
| E-014-2 公開状態で公開日時なし | 「公開日を設定してください」 | 公開日時FormField直下に表示、保存不可 |
| E-014-3 未認証操作 | — | 401 → `admin-layout.md`のセッション切れフローへ |

---

## 3. 本文エディタとサニタイズ方針（SEC-001対応）

お知らせ本文はCMS経由で管理者が入力し、公開サイト（F-005詳細ページ）で不特定多数のユーザーに表示される。**任意HTML/WYSIWYG編集はXSSリスクが高い**ため、以下の方針を推奨する。

### 推奨方針: Markdownソース保存 + サニタイズ済みレンダリング（HTML直接編集は禁止）

1. **入力**: 編集画面はリッチテキストのcontentEditable/WYSIWYG（TipTap等がHTMLを直接生成する方式）は採用せず、**Markdown構文のプレーンテキストエディタ**（textarea + 簡易ツールバー: 太字/斜体/リンク/見出し/箇条書きを構文挿入するショートカットボタン）とする。`News.body` には Markdownソース文字列をそのまま保存する。
2. **プレビュー**: 編集画面右側で入力中のMarkdownをリアルタイムにレンダリングして表示する（下記3のレンダリングパイプラインと**同一の関数**を使い、公開時の見え方と差異が出ないようにする）。
3. **レンダリング（公開サイトF-005・管理画面プレビュー共通）**: `remark`（Markdown→AST）→ `rehype`（AST→HTML AST）→ **`rehype-sanitize`**（厳格なホワイトリストschemaを明示指定）→ HTML文字列化、の固定パイプラインを使う。
   - 許可要素: `p, h2, h3, h4, ul, ol, li, strong, em, a, blockquote, br, hr`（`h1`は本文内での使用を禁止しページ見出しとの重複を避ける）
   - `a` 要素は `href`（`http`/`https`/`mailto`スキームのみ許可）、`target="_blank"`、`rel="noopener noreferrer nofollow ugc"` を**サニタイザ側で強制付与**（著者が`target`/`rel`を制御できないようにする）
   - `img`（画像埋め込み）は本フェーズでは非対応。将来対応する場合はF-009に準じた署名付きアップロードフローを別途設計し、任意URLの`<img src>`直書きは許可しない
   - `script, style, iframe, object, embed, on*属性, style属性, data:スキーム` は一切許可しない（`rehype-raw`を使わず生HTMLの混入自体を経路から排除する）
4. **多層防御**: サニタイズは**保存時ではなく描画のたびに実行**する（保存時サニタイズのみだと、将来サニタイズ実装を変更した際に過去データが未検証のまま漏れるリスクがあるため。DB内は「著者が入力したMarkdownそのまま」を保持し、信頼境界は常に「レンダリング関数の出口」に置く）。
5. **文字数上限**: クライアント/サーバー双方で本文に上限（例: 20,000文字）を設け、極端に大きい入力によるレンダリング負荷を防ぐ（F-014では未規定だが実装時のガードとして推奨）。

### 却下した代替案とその理由

- **WYSIWYG(HTML直接生成)エディタ + DOMPurify**: 実装は手軽だが、エディタが生成するHTML構造が多様でサニタイズホワイトリストの網羅が難しく、ブラウザ間のHTML生成差異によって抜け穴が生まれやすい。Markdownソースの方が入力できる表現の範囲がそもそも狭く、攻撃面が小さい。
- **本文をプレーンテキストのみに限定（Markdown不使用）**: 太字・リンク・箇条書きすら使えず、お知らせの表現力が現行サイトより後退するため却下（現行サイトのお知らせは装飾こそ少ないが箇条書き・リンクは使われている）。

### コンポーネント契約

```ts
MarkdownEditor ("use client"):
  props: { value: string; onChange: (v: string) => void; maxLength?: number }
  // ツールバーボタンはカーソル位置にMarkdown構文を挿入するのみ。HTML生成は行わない

MarkdownPreview:
  props: { source: string }
  // renderMarkdown(source): string を内部で呼び、dangerouslySetInnerHTMLで描画する唯一の場所。
  // 公開サイトのF-005詳細ページも同じ renderMarkdown() を共有関数として使う。
```

---

## インタラクション定義

| トリガー | アニメーション | 持続時間 | イージング |
|---------|-------------|---------|----------|
| フィルタ変更→一覧更新 | 行のフェード切替 | 150ms | ease-out |
| 削除ボタン→ConfirmDialog | フェード+スケール(0.95→1) | 150ms | ease-out |
| 保存成功トースト | スライドイン(上から) | 200ms | ease-out |
| 本文プレビュー更新 | 即時反映（デバウンス150ms、アニメーションなし） | - | - |

## アクセシビリティ

- `DataTable` は `<table>` + `<th scope="col">` の正規マークアップ（`../course-comparison.md`のCourseTableと同方針）。
- `ConfirmDialog` は `role="alertdialog"`、破壊的操作（削除）である旨をタイトルで明示。
- Markdownツールバーの各ボタンは `aria-label`（例: "太字にする"）を付与し、アイコンのみに頼らない。
- 公開ステータスのradio 3択は `<fieldset><legend>公開ステータス</legend>` でグループ化。

## レスポンシブ

| ブレークポイント | 一覧 | フォーム |
|-----------------|------|---------|
| Mobile | DataTableを横スクロール（管理画面はTablet以上を正とするため最低限の閲覧のみ保証） | 本文エディタは入力/プレビューを上下タブ切替（左右分割をやめる） |
| Tablet | 横スクロール可、主要列は収める | 入力/プレビュー左右分割を維持、幅を50/50から60/40に調整可 |
| Desktop | フル表示 | 入力/プレビュー左右分割50/50 |
