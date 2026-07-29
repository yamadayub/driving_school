# シニアレビュー: P0基盤整備フェーズ 仕様・設計成果物

## レビュー日: 2026-07-19
## 対象Phase: 設計（仕様策定後レビュー）
## レビュワー: Senior Engineer Agent

## レビュー対象
- `docs/business-spec.md`（業務仕様書 US-001〜016）
- `docs/functional-spec.md`（機能要件書 F-001〜021、データモデル7エンティティ、API、Mermaid）
- `docs/tech-stack.md`（技術選定書）
- `DESIGN.md`（デザインシステム）
- 参照: `docs/product-concept.md`, `docs/current-site-analysis.md`, `CLAUDE.md`

---

## 総合判定: **Request Changes**

成果物の完成度は高い。US↔F↔データモデルのトレーサビリティは明示的で漏れがなく、データアクセス境界（サーバー限定・公開DBキー非配布）の論拠、免許取消歴の独立必須化、署名付きURL設計、APPI章はいずれもプロダクション志向で妥当。一方で、**後続のTest Agentがそのままテスト設計・スキーマ定義に落とすと誤った実装を固定化してしまう「データモデル・クロス文書矛盾・セキュリティ」の5点（Must Fix）**が残っている。これらは小さな仕様編集で解消可能。P1公開サイトの**読み取り系パス**（トップ/コース比較/お知らせ/FAQ/学校案内/SEO）は Must Fix の影響を受けないため並行着手可だが、フォーム/ChatBot/アップロード系のTest設計は Must Fix 解消を前提条件とする。

## 評価サマリー
- 改善必須（Must Fix）: 5件
- 改善推奨（Should Fix）: 11件
- 任意（Nice to Have）: 5件

---

## 良い点

1. **トレーサビリティが明示的**: `functional-spec.md` §1 の機能一覧が各Fに関連USを明記。US-001〜016 全てがFに対応し、F-001〜021 全てがUSに逆引きできる。孤立要件なし。
2. **データアクセス境界の設計判断が正しく、論拠が明文化**: `tech-stack.md` §1.2。機微情報を扱う本件で「クライアントから到達可能なDB経路を作らない」判断は attack surface 最小化として妥当。Supabase構成Bでも service_role サーバー限定＋RLS deny-all の多層防御を明記しており一貫。
3. **免許取消歴の格上げが3文書で一貫**: business US-007 / functional F-008 Step3・`Application.licenseRevoked` 独立必須 / DESIGN「重要確認事項ブロック」専用コンポーネント。現行課題（自由記述欄への埋没）への解が設計まで貫通。
4. **署名付きURL設計が正しい**: DBは objectKey のみ保持、公開URL不可、保存時暗号化、閲覧は認可検証後の期限付き署名URL（F-009/F-018、tech-stack §4.2）。教科書的に妥当。
5. **異常系・境界値がFごとに列挙**: E-xxx とバウンダリ表がテスト設計の土台として機能する粒度。
6. **DESIGNトークンが具体的で実装容易**: hex値・WCAGコントラスト比明記・spacing/elevationスケール・next/font/google セルフホスト。CSS変数で即実装可能。
7. **APPI章が具体的**: 同意チェック必須、最小収集、削除時のストレージ連動削除（orphan防止）、未決事項の確定タイミング管理。

---

## 指摘事項

### [REV-001] FAQ ↔ ChatRule のナレッジ同期がモデルとして矛盾
- **種別**: Design / Data Model
- **重要度**: Must Fix
- **場所**: `functional-spec.md` F-011（`ChatRule`）, F-016, `business-spec.md` US-014
- **現状**: `Faq` は `keywords: string[]` を持ち、`ChatRule` は別エンティティで `patterns: string[]` を持つ。F-011 は「ChatRule は Faq の keywords を初期ナレッジとして流用」、US-014 受け入れ条件は「公開したFAQがFAQページと**ChatBotナレッジの双方に反映**される」。しかし `ChatRule` が独立永続エンティティのままだと、FAQ編集→ChatRuleへの反映機構が未定義で、US-014 は自動的には満たせない（二重の真実源）。
- **改善案**: どちらかに確定する。(a) ChatBotは実行時に `Faq`（keywords/answer）を直接照合し、`ChatRule` は「FAQに載らない料金/アクセス系の補助ルールのみ」に役割を限定して重複を排す。(b) `ChatRule` を廃し `Faq` に intent/patterns 相当を統合。推奨は (a)。F-011 と F-016 に「FAQ由来ナレッジは Faq を単一源として参照」と明記。
- **理由**: 二重管理は運用でズレを生み、US-014 の受け入れ条件がテスト不能になる。スキーマ確定前に解消が必要。

### [REV-002] 免許取消歴「常に必須」と INQUIRY の「最小収集」が矛盾
- **種別**: Bug（仕様矛盾）
- **重要度**: Must Fix
- **場所**: `functional-spec.md` F-008 Step3（免許取消歴 必須Yes・無条件）と §4.5、`business-spec.md` §4.3 最小収集 / US-009
- **現状**: F-008 は免許取消歴を無条件必須にしている。一方 INQUIRY（問い合わせ）で省略される項目リスト（プラン/コース/校舎/受講形態/郵便番号/住所/入所希望日/支払方法）に免許取消歴は含まれない＝問い合わせでも取消歴の回答を強制する。これは business §4.3「最小収集（問い合わせでは不要項目を収集しない）」および APPI 最小収集原則と矛盾する。
- **改善案**: 免許取消歴・現有免許・免許証写真は `type=APPLICATION` 時のみ収集・必須とし、`type=INQUIRY` では非表示にする、と F-008 と `Application` のバリデーション条件表に明記。API（F-010）のサーバー再検証も type 依存の条件必須として定義。
- **理由**: 相反する2つの必須条件は実装・テストで判断不能。APPI準拠を掲げる本件では収集範囲の条件分岐は法的要件でもある。

### [REV-003] Application → Course の参照整合性・料金スナップショットが未定義
- **種別**: Design / Data Model
- **重要度**: Must Fix
- **場所**: `functional-spec.md` F-010 `Application.courseId: string | null`、F-015（コース編集・削除）
- **現状**: 申込は `courseId` を保持するが、コースは F-015 で料金改定・削除が可能。(1) コース削除時に既存申込の courseId がダングリングする（FK/ソフトデリートの挙動未定義）。(2) 申込時点の料金・コース名が記録されず、後の改定で申込レコードの文脈（いくらで申し込んだか）が失われる。
- **改善案**: (1) `courseId` は onDelete: SetNull もしくはコースを論理削除（published=false + 物理削除禁止）に統一し明記。(2) 申込時に `courseId` に加えコース表示名・料金を**スナップショット列**として `Application` に非正規化保存（`plans: string[]` があるが構造化されていない）。
- **理由**: 受信管理（F-017）で「申込内容の正確な再現」が要件。参照先の可変性を考慮しないと監査・トラブル対応で破綻する。スキーマ確定前に決める。

### [REV-004] 免許証写真アップロードの objectKey バインディング欠如（ストレージ悪用・なりすまし）
- **種別**: Security
- **重要度**: Must Fix
- **場所**: `functional-spec.md` F-009（`POST /api/uploads/license` 認証不要）、F-010 リクエストの `licensePhotos[].objectKey`
- **現状**: アップロード発行は認証不要（レート制限のみ）。かつ申込POSTでクライアントが任意の `objectKey` を送れる。(1) 誰でも署名付きPUT URLを取得し非公開バケットに任意コンテンツを投入できる（コスト・違法コンテンツ蔵置の悪用面）。(2) 送信された objectKey が「そのセッションで発行されたもの」である保証がなく、他人のオブジェクトキーや存在しないキーを紐付け可能。(3) 申込に紐付かなかったアップロードの orphan 回収が未定義。
- **改善案**: (a) 発行する objectKey に予測不能なランダム接頭辞＋短期トークンを埋め、申込POST時にサーバーが「発行済み・未消費・期限内」を検証してから紐付け。(b) アップロード発行にも CAPTCHA もしくは申込フロー内トークンを要求。(c) content-type/size はサーバー側で発行制約かつ格納後に再検証。(d) 一定期間 orphan（申込未紐付け）オブジェクトをバッチ削除（APPI 削除フローと整合）。
- **理由**: 認証不要エンドポイント＋クライアント指定キーは典型的なストレージ悪用・IDOR面。機微情報基盤の入口であり、設計段階で塞ぐ必要がある。

### [REV-005] ドローン/建機スクールのコンテンツ表現がデータモデルに存在しない
- **種別**: Design（コンテンツ網羅性）
- **重要度**: Must Fix
- **場所**: `functional-spec.md` F-002/F-003（`Course` は免許種別＋通学/合宿＋対応校前提）、`product-concept.md` コンテンツインベントリ（/construction/ /drone/ /drone/agriculture/ 維持）、DESIGN §2（ドローン/建機の識別色を定義）、News/ChatBot は DRONE/KENKI/助成金を前提
- **現状**: News カテゴリ・DESIGN識別色・助成金タグ・ChatBotで「ドローン/建機」を一級市民として扱う前提だが、これらは免許（通学/合宿・対応校）構造の `Course` に馴染まず（助成金講習で format や対応校の意味が異なる）、詳細ページの機能要件（F-xxx）が存在しない。現行の主要コンテンツ（スクール系）が機能要件に落ちていない。
- **改善案**: (a) `Course` に `category`（免許 / ドローン / 建機）または講習タイプを追加し比較UIから分離表示、あるいは (b) スクール系は別モデル/静的詳細ページとして F項目（例: F-022 スクール詳細）を新設。いずれかを明記し、DESIGN/News/ChatBotの前提と接続する。
- **理由**: タスクの評価観点「現行サイトの主要コンテンツが全て反映されているか」に対する明確な欠落。他文書が参照している概念の受け皿がない。

### [REV-006] News の 'ALL' がカテゴリ値とフィルタ値で二重定義
- **種別**: Design / Data Model
- **重要度**: Should Fix
- **場所**: `functional-spec.md` F-004 `NewsCategory = 'ALL' | ...`、US-003、DESIGN §2（ALLに独自色）
- **現状**: 'ALL' がフィルタ（全件表示）としても、お知らせに付与可能なカテゴリ（全体告知）としても使われる。岩滝でフィルタした際に category='ALL' のお知らせを含めるか（両校共通告知として表示すべきか）が未定義。
- **改善案**: カテゴリ実体（IWATAKI/AMINO/DRONE/KENKI/共通）とフィルタUIの「すべて」を分離。共通告知は例えば `category='COMMON'` とし、フィルタ「すべて」は別概念に。校舎フィルタ時に COMMON を含める挙動を明記。
- **理由**: 表示ロジックが曖昧なままだとテスト（US-003）で期待値が定まらない。

### [REV-007] Course.licenseType がフリー文字列でフィルタ・整合性リスク
- **種別**: Data Model
- **重要度**: Should Fix
- **場所**: `functional-spec.md` F-002 `licenseType: string`、F-002 免許種別フィルタ、F-015 免許種別名 input
- **現状**: 免許種別が自由文字列。F-002 のフィルタは離散値を要するが、管理入力で「普通車(AT)」「普通車（ＡＴ）」等の表記ゆれが起きるとフィルタ・集計が壊れる。また現行の「普通車(MT/AT)」を1行とするか MT/AT 別行とするかが未確定（F-002例は「普通車(AT)」）。
- **改善案**: `licenseType` を enum（表示名は別途ラベル）に。MT/AT の扱い（同一コース内の属性か別コースか）を明記。
- **理由**: US-001 のフィルタ受け入れ条件のテスト可能性とデータ整合性。

### [REV-008] DESIGN の識別色が衝突し、横断比較のスキャン性を損なう
- **種別**: Design / Accessibility
- **重要度**: Should Fix
- **場所**: `DESIGN.md` §2 School & Category（岩滝校 `#1D4ED8`/`#EFF6FF`、網野校 `#0D9488`/`#F0FDFA`）と §4 Badge（コース種別:通学 `#1D4ED8`/`#EFF6FF`、助成金対象 `#0D9488`/`#F0FDFA`）
- **現状**: 「岩滝校バッジ」と「通学バッジ」が完全に同色、「網野校バッジ」と「助成金バッジ」が完全に同色。コースカードは校舎バッジ＋コース種別バッジ＋給付/助成金バッジを同時に並べる（DESIGN Course Card）ため、同色バッジが隣接し役割が判別しづらい。「校舎×種別を横断比較しやすくする」という本デザインの主目的と矛盾。
- **改善案**: 網野校 or 助成金、岩滝校 or 通学 のいずれかの色相をずらす。あるいは校舎バッジは枠線＋アイコン、種別/給付は塗りバッジ、と**エンコード種別（校舎/種別/給付）ごとに形状を変える**。テキストラベルは付くので致命ではないが、スキャン性の観点で調整推奨。
- **理由**: 色が役割を一意に符号化できておらず、比較UIの価値を弱める。

### [REV-009] 合宿（GASSHUKU）の料金・日数データが全文書に存在しない
- **種別**: Design（データ網羅性）
- **重要度**: Should Fix
- **場所**: `current-site-analysis.md` §4（通学のみ9件）、`functional-spec.md` F-002 `format: TSUGAKU | GASSHUKU`
- **現状**: モデル・UIは通学/合宿を横断比較する前提だが、合宿の具体データ（料金・最短日数）がどこにもない。シード/デモデータ作成時に埋められない。
- **改善案**: 合宿の料金・日数の出典（現行 /camp/ の値）を調査してシードデータ仕様に追加、または合宿はデモではダミー値と明記。
- **理由**: US-001「通学/合宿で絞り込み」の実データがないとE2Eが空表になる。

### [REV-010] 現行「維持」静的ページ群に機能要件上の受け皿がない（特にプライバシーポリシー）
- **種別**: Design（網羅性 / APPI）
- **重要度**: Should Fix
- **場所**: `product-concept.md` インベントリ（/privacy/ /bus/ /benefit/ /senior/ /beginner/ /corporation/ /recruit/ を維持）、`functional-spec.md`（該当F項目なし）、F-008 プライバシー同意
- **現状**: F-008 の同意チェックはプライバシーポリシー本文の存在を前提とするが、プライバシーポリシーページ自体がF項目にない。送迎バス/給付金等もChatBot/タグから参照されるが詳細ページの受け皿が未定義。
- **改善案**: 最低限プライバシーポリシーページをF項目化（同意リンク先）。その他維持ページは「静的ページ（F-023）としてまとめて維持」か「デモ対象外」を明記し limbo を解消。
- **理由**: 同意の前提コンテンツが要件にないと APPI 同意フローがテスト不能。網羅性チェックの穴。

### [REV-011] receiptNumber の生成規則と送信冪等性（多重登録防止）が未定義
- **種別**: Design
- **重要度**: Should Fix
- **場所**: `functional-spec.md` F-010（`receiptNumber` を201で返す、E-010-5「多重登録防止」）
- **現状**: receiptNumber の形式・一意性・生成方法が未定義。またAPIに冪等キーがなく、保存成功後にレスポンス消失→再送信で重複作成が起きうる（disabled ボタンはクライアント対策に過ぎない）。
- **改善案**: receiptNumber の形式（例: `YYYYMMDD-連番` or ULID）と一意制約を定義。送信リクエストに idempotencyKey を持たせ、サーバーで短期ウィンドウの重複を排除。
- **理由**: US-006「送信成功時に受付番号」の検証と、実運用の二重申込防止に必要。

### [REV-012] サーバーレス環境でのレート制限の共有ストアが未確定
- **種別**: Design / Security
- **重要度**: Should Fix
- **場所**: `tech-stack.md` §3（レート制限は「Upstash Redis 等 or middleware」）
- **現状**: 構成A（Vercelサーバーレス）ではインスタンスをまたぐため、middleware/インメモリのレート制限は実効性がない。認証不要エンドポイント（applications/uploads/chat）の唯一の防御であり曖昧さは危険。
- **改善案**: レート制限は共有ストア（Upstash Redis 等）に確定、もしくはデモでは「単一リージョン簡易実装・本番はRedis」と限界を明記。
- **理由**: スパム対策（F-010）の実効性は認証不要面の要。実装Phaseでの手戻り防止。

### [REV-013] 主要クエリのインデックス戦略が未記載
- **種別**: Performance / Data Model
- **重要度**: Should Fix
- **場所**: `functional-spec.md` §4.8、各F API
- **現状**: senior-reviewチェック項目「インデックス戦略」が未記載。News（status＋publishedAt降順）、Application（type/status/createdAt絞り込み）、Course（published/sortOrder）、Faq（published/category/sortOrder、keyword検索）など頻出クエリのインデックスが未定義。
- **改善案**: 上記の複合インデックスを Prisma schema 方針として明記。keyword全文検索はPostgresの方式（ILIKE/GIN/pg_trgm）を選定。
- **理由**: LCP/500ms目標（非機能§4.1）達成の前提。後付けは移行コスト大。

### [REV-014] 年齢・運転経歴の入所要件が単一「年齢下限」に丸められ曖昧
- **種別**: Design
- **重要度**: Should Fix
- **場所**: `functional-spec.md` F-008 生年月日「年齢下限チェック」、§4.5
- **現状**: 免許種別ごとに入所可能年齢・経歴要件が異なる（二輪16歳、大型/二種は21歳＋運転経歴3年等）が、単一の「年齢下限」に丸められテスト不能。
- **改善案**: デモでは「普通車基準の一律年齢下限のみ検証、種別別要件は対象外」と明記して簡素化する、あるいは種別別要件表を定義。どちらでも良いが確定を。
- **理由**: バリデーションの期待値が定まらないとTest Agentが書けない。

### [REV-015] ChatBotの照合をサーバー/クライアントどちらで行うか未確定
- **種別**: Design
- **重要度**: Should Fix
- **場所**: `functional-spec.md` F-011「サーバー（またはクライアント）で照合」、`POST /api/chat`
- **現状**: 照合層が両論併記。テスト対象（APIか純関数か）とナレッジのクライアント露出可否が定まらない。
- **改善案**: 公開FAQナレッジは非機微なのでどちらでも可だが、一方に確定。API化するなら純関数の照合ロジックを分離しユニットテスト可能に。
- **理由**: US-010 のテスト設計とレート制限適用箇所が確定する。

### [REV-016] CLAUDE.md のファイル構成と tech-stack の App Router 構成にドキュメント齟齬
- **種別**: Maintainability
- **重要度**: Should Fix
- **場所**: `CLAUDE.md` ファイル構成（src/・tests/ 中心、Vite前提）と `tech-stack.md` §5（app/・prisma/・lib/ 新設）
- **現状**: CLAUDE.md は src/components・src/styles 中心の旧構成を記載、tech-stack は App Router の app/ 構成へ移行する方針。両者の整合が取れておらず、実装Agentが参照時に混乱する。「移行」と呼ぶが実態は app shell の再構築に近く、期待値のすり合わせが必要。
- **改善案**: 移行後の確定ディレクトリ構成を tech-stack §5 に一本化し、CLAUDE.md 側を追従更新（または「移行後に更新」と注記）。src/components/ui の再利用は "use client" 境界付与前提であることを明記。
- **理由**: 参照ファイルパスの一貫性は本プロジェクトの「file-based context」原則の根幹。

### [REV-017] 確認画面からの修正遷移が常にStep2固定（フロー図）
- **種別**: Style / UX
- **重要度**: Nice to Have
- **場所**: `business-spec.md` §2.2.1 mermaid（G 確認画面 -->|修正| C Step2）
- **現状**: 6ステップ構成なのに修正は常にStep2へ戻る図。該当項目のステップへ戻るのが自然。
- **改善案**: 「修正は該当ステップへ戻る」と注記、または図を汎用化。
- **理由**: 図と実装意図の齟齬を防ぐ。実害小。

### [REV-018] 日本語検索・照合の正規化（全半角/かなカナ）が未定義
- **種別**: Design
- **重要度**: Nice to Have
- **場所**: F-006 キーワード検索、F-011 照合
- **改善案**: 全角半角・ひらがなカタカナ正規化の方針を一言定義（デモ簡易でも可）。
- **理由**: 現実的な検索一致率に影響。デモ許容範囲。

### [REV-019] Danger赤の多義利用（エラー / 新規ステータス / 重要確認）
- **種別**: Style
- **重要度**: Nice to Have
- **場所**: `DESIGN.md` §2 Semantic、§4 Badge（新規=`#DC2626`）
- **現状**: 赤が「エラー」「新規（要対応）」「免許取消歴の重要確認」に跨る。新規=赤は警告的に読める（意図なら可）。
- **改善案**: 新規ステータスは Info/Warning系にする選択肢も検討。テキストラベル併記のため致命ではない。
- **理由**: 意味の一貫性。実害小。

### [REV-020] 管理者アカウントの初期化・ユーザー管理が未記載
- **種別**: Design
- **重要度**: Nice to Have
- **場所**: F-012 `AdminUser`（role: 'ADMIN' 単一）
- **改善案**: デモの管理者はシードで作成、ユーザー管理UI・パスワードリセットは対象外、と明記。
- **理由**: 認証Phaseの前提を明確化。

### [REV-021] 未決事項の優先度付け（tech-stack §6）
- **種別**: Process
- **重要度**: Nice to Have
- **場所**: `tech-stack.md` §6 未決事項8件
- **評価**: #1認証方式/#2レート制限閾値/#3-4写真制約/#5-7インフラ/#8保持期間 はいずれも後続Phase送り妥当。ただし **#8 保持期間**は APPI 同意文面（REV-010）に影響するため「同意ページ文言を書く時点で暫定値を決める」ことを推奨。#2 は REV-012 と併せて共有ストア方針だけ先に確定を。
- **理由**: 大半は正しく後送りできるが、APPI関連は同意文面の締切に律速される。

---

## 次Phaseへ進む前提条件

### Test設計（Phase 4）着手の前提
以下 Must Fix の解消を **Spec Agent に差し戻し**、`functional-spec.md`／`business-spec.md`／`DESIGN.md` に反映すること:
- REV-001（FAQ↔ChatRule 単一源化）
- REV-002（免許取消歴の type 条件必須化）
- REV-003（Application→Course 整合性＋料金スナップショット）
- REV-004（アップロード objectKey バインディング／悪用対策）
- REV-005（ドローン/建機の受け皿F項目）

### 並行着手可（Must Fixの影響外）
P1公開サイトの**読み取り系**（F-001 トップ / F-002 コース比較 / F-004・F-005 お知らせ / F-006 FAQ / F-007 学校案内 / F-019〜021 SEO）の設計・Test設計は先行可能。ただし REV-006〜009（News ALL / licenseType enum / DESIGN色衝突 / 合宿データ）は該当機能のTest設計前に Should Fix として反映が望ましい。

### Should Fix の扱い
REV-006〜016 は「該当機能のTest設計に着手する直前まで」に解消。全件を今ブロックする必要はないが、データモデル系（REV-006/007/013）はPrisma schema 確定前にまとめて反映するのが手戻り最少。

### 再レビュー
Must Fix 反映後、差分箇所（データモデル・フォームバリデーション条件・アップロード認可）を対象に再レビューを実施し、Approve を確認してから Test設計を確定する。

---

# 差分再レビュー（2026-07-19, v0.2.0 対象）

## 再レビュー日: 2026-07-19
## 対象: business-spec v0.2.0 / functional-spec v0.2.0 / tech-stack（レート制限節）/ DESIGN.md
## 更新判定: **Approve（条件付き）**

Must Fix 5件は**いずれも実質的かつ網羅的に解消**されており、設計上の抜けは検出されなかった。データモデル・API・US受け入れ条件・フロー図・バリデーション共通ルールまで一貫して波及している点を高く評価する。よって Test設計フェーズへの前進を **Approve** とする。ただし DESIGN.md に **対応サマリの記載と実ファイルの不一致**があり、UI実装フェーズ着手前に解消すべき Should Fix が残る（下記 RE-01）。ロジック/データ層の Test設計は本 Approve をもって着手可。

## Must Fix 検証結果（全て解消）

| ID | 判定 | 検証根拠（反映箇所） |
|----|------|-------------------|
| REV-001 | ✅ 解消 | F-006概要「Faqが単一の真実源、ChatBotは実行時に直接照合、複製しない」/ F-011 `ChatRule`廃止・`SupplementalChatRule`をFAQ非包含(sourceType=COURSE|ACCESS)に限定 / F-016「同期処理なしで反映」/ US-014受け入れ条件更新 / §4.8エンティティ一覧から ChatRule 除去。二重の真実源が構造的に消えており US-014 が機構的に充足。 |
| REV-002 | ✅ 解消 | F-008 Step3/4を「申込時Yes・type=APPLICATION時のみ表示」に条件化 / INQUIRY省略項目に免許取消歴・現有免許・写真を追加 / E-008-3・E-010-6(422) / `Application.licenseRevoked: boolean|null` / US-007・US-008・US-009受け入れ条件更新 / business §4.3・§2.1フロー図のtype分岐・§4.5更新。最小収集(APPI)と整合。 |
| REV-003 | ✅ 解消 | `courseId onDelete=SetNull`＋Course物理削除禁止(論理削除) / `courseNameSnapshot`・`priceFromSnapshot` 非正規化列追加 / F-010正常系「送信時点の Course から読み取りスナップショット保存・クライアント価格を信用しない」/ §4.8参照整合性方針。改定・削除後も申込内容を再現可能。 |
| REV-004 | ✅ 解消 | objectKeyサーバー生成(クライアント指定不可) / `UploadToken`(バインド・単回・期限)エンティティ新設 / F-009送信時「発行済み・未消費・期限内・objectKey一致」検証＋格納後 content-type/size 再検証 / E-009-4/5・403 / F-010 licensePhotos に uploadToken / orphanバッチ削除をAPPI削除フローと連動 / US-008受け入れ条件更新。悪用・IDOR・滞留の入口を閉塞。 |
| REV-005 | ✅ 解消 | `Course.category`(LICENSE/DRONE/KENKI/ADDITIONAL) / F-022新設(スクール・追加講習詳細、/construction/・/drone/・/senior/・/beginner/・/corporation/を受け皿) / F-002比較UIとAPIを category='LICENSE' に限定 / `programLabel`追加 / business §2.1用語更新。現行スクール系コンテンツが機能要件に着地。 |

## 併せて確認した Should Fix（反映済み）
- REV-006（News `COMMON`化・`ALL`廃止・校舎フィルタ時COMMON包含）: functional-spec 側は F-004/F-014/§4.8/US-003 で反映済み。**ただし DESIGN.md 未追従（下記 RE-01）**。
- REV-007（LicenseType enum＋transmission、表記ゆれ排除）/ REV-009（合宿ダミーシード明示）/ REV-011（receiptNumber形式・idempotencyKey一意制約・冪等200応答）/ REV-012（レート制限を共有ストアUpstashに確定、サーバーレス限界明記）/ REV-013（§4.9インデックス戦略）/ REV-014（年齢は普通車基準一律・種別別は対象外）/ REV-015（ChatBotサーバー純関数照合）/ REV-010（F-023プライバシーポリシー）: いずれも spec 本文で解消を確認。

## 新たに検出した指摘（今回の変更に伴うもの）

### [RE-01] DESIGN.md が対応サマリの記載どおりに更新されていない（バッジ判別性・ALL→COMMON波及漏れ）
- **種別**: Design / ドキュメント整合性
- **重要度**: Should Fix（UI実装フェーズ着手前に必須）
- **場所**: `DESIGN.md` §2 School & Category（L64/65/68）, §4 Badge（L276/277/279）, News Card 構成（L249）
- **現状**: 対応サマリは「DESIGN配色バッジ判別性を修正・役割別に色域分離・CTA #F97316→#C2410C 是正」とするが、現行 DESIGN.md は v0.1.0 から**未変更**。(1) 岩滝校 `#1D4ED8`/`#EFF6FF` が コース種別:通学 と完全同色、網野校 `#0D9488`/`#F0FDFA` が 助成金対象 と完全同色のまま（REV-08 未解消。コースカードで同色バッジが隣接し役割判別困難）。(2) News のカテゴリが functional-spec では `ALL` 廃止→`COMMON` 化されたのに、DESIGN は School&Category表・Badge表・News Card構成で依然 `ALL（お知らせ全体）` を使用（REV-006 の波及漏れ・文書間不整合）。(3) CTA色 #F97316 は v0.1.0 時点で既に「装飾専用」であり是正の実体なし。
- **改善案**: (a) 網野校 or 助成金、岩滝校 or 通学 のいずれかの色相をずらす、または校舎バッジは枠線＋アイコン・種別/給付は塗りと**エンコード種別ごとに形状を変える**。(b) DESIGN の `ALL` を `COMMON（両校共通告知）` に置換し、News Card 構成の列挙も更新。(c) 実際に編集を保存したか確認（今回のファイルには反映されていない）。
- **理由**: 公開サイトUI（F-002コースカード・F-004ニュースカード）の実装直前に必要。テキストラベル併記のため機能不全ではないが、「横断比較のスキャン性」という DESIGN 主目的に直結し、かつ文書間で category 値が食い違うと Designer/Impl が誤参照する。

### [RE-02] F-022 / F-023 の関連US対応が弱い
- **種別**: Design（トレーサビリティ）
- **重要度**: Nice to Have
- **場所**: `functional-spec.md` F-022（関連US=US-002/US-016）, F-023（関連US=US-007/US-016）
- **現状**: F-022（スクール・追加講習）に対応する専用USがなく US-002（免許種別のコース詳細）に相乗り。F-023（プライバシーポリシー）が US-007（免許取消歴申告）に紐付いているが、実際に関係するのは同意を持つ US-006/008/009。
- **改善案**: F-022 は「product-concept コンテンツインベントリ由来」と注記するか軽量USを1本追加。F-023 の関連US を US-006/008/009（同意）に修正。
- **理由**: 追跡性の正確さ。実装・テストには軽微。

### [RE-03] Course.licenseTypeLabel の非LICENSE時の扱いが曖昧
- **種別**: Data Model
- **重要度**: Nice to Have
- **場所**: `functional-spec.md` F-002 `Course`（`licenseTypeLabel: string` 非null、`programLabel: string | null`）
- **現状**: 非LICENSE（ドローン等）では `licenseType=null` だが `licenseTypeLabel` が非null文字列のまま。表示名の権威が LICENSE=licenseTypeLabel / 非LICENSE=programLabel と二系統になり、非LICENSE時の licenseTypeLabel の値が未定義（空文字か programLabel 複製か）。
- **改善案**: `licenseTypeLabel` を `string | null` にし「LICENSE時のみ設定」と明記、表示は `licenseTypeLabel ?? programLabel` で解決、と一言添える。
- **理由**: シード・表示ロジックの曖昧さ解消。軽微。

## 結論と次アクション
- **判定: Approve（条件付き）**。Must Fix 5件は解消済みのため、**ロジック/データ層（データモデル・フォームバリデーション・アップロード認可・ChatBot照合）の Test設計へ着手可**。
- **条件**: 公開サイトUI（F-002/F-004 等）の Designer/Impl 着手前に **RE-01（DESIGN の色域分離・ALL→COMMON波及）を必ず適用**すること。DESIGN の対応サマリと実ファイルの乖離を解消し、編集の保存を確認する。
- RE-02/RE-03 は Nice to Have。該当機能の実装時に併せて整えれば足り、今ブロックしない。
- 本 Approve 以降、Must Fix 項目の再差し戻しは不要。
