# テスト設計レビュー: P1 公開サイト骨格

## レビュー日: 2026-07-27
## 対象Phase: テスト設計（CLAUDE.md Phase 5）
## レビュワー: Senior Engineer Agent
## 前提: Impl Agent が並行着手中 → 「正しい実装なら green になるか（テスト契約が実装可能か）」に絞って早期判定

## 総合評価: **Approve**

テスト契約は実装可能で、シード実データとの件数整合・セレクタ安定性・TDD構造・トレーサビリティのいずれも高品質。**正しい実装に対して誤って fail するテスト契約の欠陥は検出されなかった**ため、Impl 続行を承認する。以下は非ブロッキングの改善で、うち TC-01 / TC-02 は Impl 稼働中の今に対処すると乖離を予防できる。

## 評価サマリー
- 良い点: 多数（下記）
- 改善必須（今すぐ直すべきテスト契約の欠陥）: **0件**
- 改善推奨（Impl中に対処推奨）: 2件（TC-01, TC-02）
- 任意（後続で可）: 3件（TC-03, TC-04, TC-05）

---

## 検証した事実（エビデンス）

### 1. シード↔テスト件数の整合（全件手検証で一致）
`prisma/seed.ts` を数え、単体フィクスチャ・結合クエリ・E2E `SEED` 定数の期待値と突合。すべて一致：
- LICENSE=11（通学10 + 合宿1）、DRONE2/KENKI1/ADDITIONAL3=6、Course計17。
- 岩滝×通学=9（MOTORCYCLEは網野のみ除外）、網野×通学=7（LARGE/ORDINARY_2ND/LARGE_2NDは岩滝のみ除外）。
- News=6（COMMON×2/IWATAKI/AMINO/DRONE/KENKI）、publishedAt降順の先頭=「年末年始」(2026-07-15) → `news.int` の `title.contains('年末年始')` と一致。
- Faq=11（SCHOOL4/COURSE2/PAYMENT1/OTHER4）、「送迎」検索は FAQ#1「送迎バスはありますか？」にヒット。
→ `course-filter.test` フィクスチャは対応校構成を seed と一致させており、単体・結合・E2E の三層で同一の件数真実を検証している。**設計の一貫性が高い。**

### 2. TDD red の健全性（テスト不良ではない）
`lib/{course-filter,course-view,badge,format}.ts` は全て `throw NI('...')`（NotImplemented）スタブ。テストは存在する名前付きエクスポートを import しており、red は純粋に「実装未存在」由来。`lib/design-tokens.ts` は実装済みのため `badge.test` の design-tokens 側アサーションのみ green、`badge.ts` 関数側は NI で red という**クリーンな分離**。テスト自体の構文・import 不良は無し。

### 3. トレーサビリティ（正当）
各テストヘッダに F-/US- を明記。US-017（スクール・追加講習閲覧, business-spec §323）は実在し `courses.int`/E2E の F-022 紐付けは正当。`?license=PRO` は course-comparison.md §44-45 で「UI上のグルーピング値＝非ORDINARY全件」と定義済みで、GlobalNav の href 契約は仕様に裏付けあり。

---

## 良い点

1. **DOM契約の単一参照元 `contract.ts`**: testid / aria名 / nav href / seed件数 / フィルタチップ名を一箇所に集約し、PageObject と spec が全て参照。セレクタ変更やseed変更の影響範囲を局所化する良設計。
2. **セレクタが role/aria/testid ベースで安定**: `getByRole('heading'|'link'|'tab'|'radio')`＋accessible name、`getByTestId`、`aria-live="polite"` 検証。見た目テキストへの過度依存がなく、i18n/装飾変更に強い。単一選択チップを `role=radio` に固定した判断は course-comparison.md §57（単一選択=radio）と一致。
3. **Badge 役割の色+形状 二重エンコード検証（REV-008を実効化）**: `badgeShapeForVariant` で school=outline≠category=rounded-rect を検証し「色以外でも判別可能」を担保。単なる再配色より堅牢な解で、DESIGN の意図を正しくテスト化している。
4. **公開/非公開・DRAFT境界を実DBで検証**: `courses.int`（published=false 作成→除外確認→cleanup）、`news.int`（DRAFT除外）。`afterAll` で一時レコード削除＋`$disconnect`。副作用の後始末が適切。
5. **非LICENSE除外を単体・結合の両面で検証**: 比較UIの中核不変条件（LICENSE限定）を二重に固定。
6. **純関数と画面デフォルトの層分離**: `filterCourses({})=11`（デフォルトなし）に対し、比較ページ初期表示=通学10 はページ側が `format=TSUGAKU` を付与する設計。責務分離が明快で、両者の期待値も矛盾しない。
7. **結合setupの堅牢性**: `.env` 最小ローダで dev DB(5433) 接続、既存 `process.env` 優先（CI尊重）。seed も deleteMany→create で冪等。

---

## 指摘事項

### [TC-01] DESIGN.md と design-tokens.ts の配色が乖離（RE-01 の積み残し）
- **種別**: Design / ドキュメント整合性
- **重要度**: Should Fix（Impl中に同期推奨）
- **場所**: `DESIGN.md` §2/§4 ↔ `lib/design-tokens.ts` L36-40
- **現状**: `design-tokens.ts` は判別性を上げた新配色（岩滝=`#4338CA` Indigo700 / 網野=`#0F766E` Teal700）＋形状分離（school=outline）を実装し、`badge.test` はこの二重エンコードを enforce している。一方 DESIGN.md §2 は依然 岩滝=`#1D4ED8`/網野=`#0D9488`、§4 に `ALL` 行が残存（前回 RE-01/REV-008 指摘が未反映）。**コード（真の実装＋テスト）が正しい解を採り、仕様書だけ旧衝突配色のまま**という逆転が起きている。
- **改善案**: DESIGN.md §2 School&Category と §4 Badge を design-tokens.ts に合わせて更新（衝突配色の解消・`ALL`→`COMMON`）。テストは変更不要。単一真実源（DESIGN.md）の記述を実装に追従させる。
- **理由**: 今 Designer/Impl が DESIGN.md を参照すると旧衝突配色を再導入しかねない。テスト契約自体は正しいので、仕様書側の同期のみで解消する。

### [TC-02] シード由来の期待件数が結合とE2Eで二重ハードコード（乖離ドリフトの芽）
- **種別**: Maintainability / テスト堅牢性
- **重要度**: Should Fix（Impl中の低コスト対処推奨）
- **場所**: `tests/e2e/pages/contract.ts` `SEED`（10/1/9/7）↔ `tests/integration/{courses,news,faq}.int.ts` のリテラル（11/10/9/7/6/11）
- **現状**: 同一のseed真実を、E2Eは `SEED` 定数、結合は各ファイルのリテラルで**独立に**保持。現状は全て一致（検証済み）だが、seed.ts変更時に両所を手修正する必要があり、相互・対seedでサイレントに乖離しうる。team-lead 懸念点（seed変更耐性）はまさにこの箇所。
- **改善案**: seed件数の単一モジュール（例 `tests/fixtures/seed-counts.ts`）を新設し、結合・E2E双方が import（contract.ts は re-export）。可能なら seed 実行後に件数を検証する既存ログ（seed.ts 末尾の count 出力）と対応付けるコメントを添える。今 Impl が並行なので追加コストは小さい。
- **理由**: 件数アサーションは P1 の contract-test として妥当だが、単一源化しておくとseed改定時のフレーク・二重編集を構造的に防げる。

### [TC-03] PRO グルーピングと 免許種別/transmission フィルタのE2E未カバー
- **種別**: Coverage
- **重要度**: Nice to Have（P1では容認・後続で追加）
- **場所**: E2E（`course-comparison.spec` は school/format と `?format=GASSHUKU` のみ）、`GlobalNav.expectAllVisible` は href文字列のみ検証
- **現状**: `?license=PRO`→非ORDINARY全件（course-comparison.md §44-45）と、URLパラメータ→フィルタ状態同期（`?school=`/`?license=`）はE2E未検証。`filterCourses` 単体は licenseTypes[]/transmission ロジックを網羅するが、URL→状態のマッピングは通学切替（`?format=GASSHUKU`）1本のみ。
- **改善案**: (a) ナビ「プロ免許」遷移で第1階層=プロ免許・非ORDINARY全件が初期展開されるE2Eを1本、(b) `license=PRO`→種別展開を単体/結合で1本追加。
- **理由**: ナビの主要導線の一つ（プロ免許）が挙動未検証。P1骨格では容認可だが、次サイクルで塞ぐ。

### [TC-04] contract.ts のチップroleコメントが course-comparison.md より緩い
- **種別**: Maintainability
- **重要度**: Nice to Have
- **場所**: `tests/e2e/pages/contract.ts` L55近傍コメント / `CourseComparisonPage.chip()` L28
- **現状**: コメントは全チップを「role=radio または aria-pressed」と一括表記だが、仕様（§57）は単一選択=radio・複数選択(PROの第2階層)=aria-pressed と役割で分岐。現P1テストは school/format(=radio)のみ操作するため実害なし。
- **改善案**: コメントを「単一選択(校舎/受講形態)=role=radio、複数選択(プロ免許 第2階層)=aria-pressed」に精緻化。将来 license チップの PageObject メソッド追加時の誤roleを予防。
- **理由**: 現行は正しいが、拡張時の取り違えを予防する軽微な明確化。

### [TC-05] badge.ts の 'adminStatus' variant が badgeShapes に不在
- **種別**: Bug（潜在, P2管理画面スコープ）
- **重要度**: Nice to Have
- **場所**: `lib/badge.ts` `BadgeVariant` に 'adminStatus' / `lib/design-tokens.ts` `badgeShapes`（school/format/category/subsidy のみ）
- **現状**: docstring は adminStatus->'pill' とするが `badgeShapes` に adminStatus キーが無い。P1テストは adminStatus 未検証のため fail はしないが、Impl が `badgeShapes[variant]` で実装すると adminStatus で undefined になりうる。
- **改善案**: `badgeShapeForVariant` 実装時に adminStatus は明示的に 'pill' を返す（badgeShapes 由来にしない）か、badgeShapes に adminStatus を追加。
- **理由**: P2管理画面バッジ実装時の undefined を予防。

---

## 結論と次アクション
- **判定: Approve**。テスト契約は実装可能で、正しい実装に対し誤って fail する欠陥は無し。Impl は続行してよい。
- **Impl稼働中に対処推奨**: TC-01（DESIGN.md を design-tokens.ts に同期）、TC-02（seed件数の単一源化）。いずれも低コストで乖離を予防。
- **後続サイクルで可**: TC-03（PRO/種別/URL同期のE2E拡充）、TC-04（コメント精緻化）、TC-05（adminStatus形状）。
- 実装が green 化した後、`pnpm test:unit && test:integration && test:e2e` の実行結果と、比較フィルタ・公開/非公開境界の実挙動を対象に検収レビューを行う。
