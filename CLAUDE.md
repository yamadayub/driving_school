# Multi-Agent TDD 開発設定

## 開発方針
- **テスト駆動開発（TDD）を厳守**
- 要件書 → テスト → 実装 の順序を必ず守る
- E2Eテストが通るまで実装を継続
- 仕様変更時は必ず要件書から更新する
- **全ての設計判断はファイルに書き出し、コンテキストを永続化する**
- **エージェント間の相互レビューで品質を担保する**

---

## Planning With Files

### 原則
- 計画・仕様・テスト結果は必ずファイルに書き出す
- サブエージェント間の情報共有はファイルベースで行う
- 各Phase完了時に成果物ファイルが存在することを確認する
- レビュー結果は `/docs/review-*.md` に記録し、次のPhaseに引き継ぐ

### 計画ファイルの運用
- 機能開発の計画は EnterPlanMode を使用し、計画をファイルに記録する
- 計画にはPhase（仕様→レビュー→テスト→実装→レビュー→セキュリティ→E2E）ごとの具体的タスクを含める
- 各Phaseの完了条件を明記する

---

## スキル (Skills)

`.claude/skills/` に以下のスキルが定義済み:

| スキル | ファイル | 用途 |
|--------|---------|------|
| Spec Agent | `.claude/skills/spec.md` | 業務仕様書・機能要件書の作成・更新 |
| Test Agent | `.claude/skills/test.md` | テストケース設計・テストコード生成 |
| Impl Agent | `.claude/skills/impl.md` | テストを満たす実装コードの作成 |
| Designer Agent | `.claude/skills/designer.md` | ゲーム的UI設計・インタラクション・アニメーション |
| Senior Engineer | `.claude/skills/senior-review.md` | 設計/テスト/コードの批判的レビュー |
| Security Agent | `.claude/skills/security.md` | セキュリティ監査・脆弱性検出 |
| TDD Flow | `.claude/skills/tdd.md` | 全Phaseの一貫オーケストレーション |

### スキルの使い方
各スキルはTaskツールのサブエージェントに `.claude/skills/[name].md` の内容を読ませて使う。

---

## サブエージェント構成

### Spec Agent (仕様策定)
- **役割**: 業務仕様書・機能要件書の作成・更新
- **スキル**: `.claude/skills/spec.md`
- **トリガー**: 新機能追加、仕様変更時
- **出力**: `/docs/business-spec.md`, `/docs/functional-spec.md`
- **Task起動方法**:
```
Taskツール (subagent_type: general-purpose) で起動:

プロンプト:
「.claude/skills/spec.md を読み、その手順に従って作業してください。
変更内容: [具体的な変更内容]
参照: /docs/business-spec.md, /docs/functional-spec.md」
```

### Designer Agent (フロントエンドデザイナー)
- **役割**: ゲーム的UI/UX設計、デザインシステム構築、コンポーネント実装
- **スキル**: `.claude/skills/designer.md`
- **トリガー**: 仕様策定後（UI関連機能の場合）
- **出力**: `/docs/ui-design/*.md`, `/src/styles/`, `/src/components/ui/`
- **Task起動方法**:
```
Taskツール (subagent_type: general-purpose) で起動:

プロンプト:
「.claude/skills/designer.md を読み、その手順に従って作業してください。
対象機能: /docs/functional-spec.md の [該当セクション]
出力: UIデザイン仕様、デザイントークン、UIコンポーネント」
```

### Test Agent (テスト設計)
- **役割**: テストケース設計、テストコード生成
- **スキル**: `.claude/skills/test.md`
- **トリガー**: 要件書更新後（設計レビュー通過後）
- **参照**: `/docs/functional-spec.md`, `/docs/ui-design/*.md`
- **出力**:
  - 単体テスト: `/tests/unit/*.test.ts`
  - 結合テスト: `/tests/integration/*.int.ts`
  - E2Eシナリオ: `/tests/e2e/specs/*.spec.md`
- **Task起動方法**:
```
Taskツール (subagent_type: general-purpose) で起動:

プロンプト:
「.claude/skills/test.md を読み、その手順に従って作業してください。
対象機能: /docs/functional-spec.md の [該当セクション]
出力: 単体テスト、結合テスト、E2Eシナリオ」
```

### Impl Agent (実装)
- **役割**: テストを満たすソースコード実装
- **スキル**: `.claude/skills/impl.md`
- **トリガー**: テストコード生成後
- **終了条件**: 全テストがパス
- **Task起動方法**:
```
Taskツール (subagent_type: general-purpose) で起動:

プロンプト:
「.claude/skills/impl.md を読み、その手順に従って作業してください。
テストファイル: /tests/unit/[feature].test.ts
終了条件: pnpm test:unit && pnpm test:integration が全てパス」
```

### Senior Engineer Agent (シニアエンジニアレビュー)
- **役割**: 設計・テスト・コードの批判的レビュー、品質ゲートキーピング
- **スキル**: `.claude/skills/senior-review.md`
- **トリガー**: 各Phase完了後（設計後、テスト後、実装後）
- **出力**: `/docs/review-[対象]-[日付].md`
- **判定**: Approve / Request Changes / Reject
- **Task起動方法**:
```
Taskツール (subagent_type: general-purpose) で起動:

プロンプト:
「.claude/skills/senior-review.md を読み、その手順に従って作業してください。
レビュー対象: [設計/テスト/実装]
対象ファイル: [ファイルパス]
レビュー結果を /docs/review-[対象]-[日付].md に出力してください。」
```

### Security Agent (セキュリティ監査)
- **役割**: OWASP Top 10ベースのセキュリティ監査、脆弱性検出・是正指示
- **スキル**: `.claude/skills/security.md`
- **トリガー**: 実装完了・コードレビュー通過後
- **出力**: `/docs/security-audit.md`
- **Task起動方法**:
```
Taskツール (subagent_type: general-purpose) で起動:

プロンプト:
「.claude/skills/security.md を読み、その手順に従って作業してください。
対象: /src/ 配下の全コードと /docs/functional-spec.md
結果を /docs/security-audit.md に出力してください。」
```

---

## Task Tool 使用ルール

### 新機能開発フロー（推奨手順）

```
Phase 1: 計画
   EnterPlanMode で計画を策定
   機能の概要、影響範囲、Phase別タスクを計画ファイルに記録
   ユーザーの承認を得る

Phase 2: 仕様策定
   Spec Agent起動 (Task: general-purpose)
   コンテキスト: 機能要件 + .claude/skills/spec.md
   出力: /docs/business-spec.md, /docs/functional-spec.md
   完了確認: 機能IDと受け入れ条件が記載されていること

Phase 3: 設計レビュー + UI設計
   ┌─ Senior Engineer起動 → 仕様の設計レビュー
   └─ Designer Agent起動 → UIデザイン仕様作成 (並列実行可)
   Senior Engineer が Request Changes → Phase 2 に差し戻し
   Senior Engineer が Approve → 次へ

Phase 4: テスト設計
   Test Agent起動 (Task: general-purpose)
   コンテキスト: 仕様書 + UIデザイン仕様 + .claude/skills/test.md
   出力: テストコード
   完了確認: テストファイルが存在し、構文エラーがないこと

Phase 5: テストレビュー
   Senior Engineer起動 → テスト設計のレビュー
   Request Changes → Phase 4 に差し戻し
   Approve → 次へ

Phase 6: 実装
   Impl Agent起動 (Task: general-purpose)
   コンテキスト: テストコード + UIデザイン仕様 + .claude/skills/impl.md
   終了条件: pnpm test:unit && pnpm test:integration 全パス

Phase 7: コードレビュー + セキュリティ監査
   ┌─ Senior Engineer起動 → コードレビュー
   └─ Security Agent起動 → セキュリティ監査 (並列実行可)
   Must Fix / Critical あり → Phase 6 に差し戻し
   全 Approve → 次へ

Phase 8: E2E検証
   pnpm test:e2e を実行
   失敗時: Phase 6 に戻り修正

Phase 9: 完了報告
   変更サマリー、レビュー結果、セキュリティ監査結果をユーザーに報告
```

### 相互レビューのルール

```
┌──────────────────────────────────────────────────────┐
│                 相互レビューマトリクス                    │
├──────────────┬───────────────────────────────────────┤
│ 成果物        │ レビュワー                              │
├──────────────┼───────────────────────────────────────┤
│ 仕様書        │ Senior Engineer（設計妥当性）             │
│              │ Security Agent（セキュリティ要件の網羅性）   │
│ UIデザイン     │ Senior Engineer（実装可能性・パフォーマンス）│
│ テストコード   │ Senior Engineer（網羅性・設計品質）        │
│ 実装コード     │ Senior Engineer（コード品質・設計原則）     │
│              │ Security Agent（脆弱性・OWASP準拠）       │
│              │ Designer Agent（UI実装の品質確認）         │
└──────────────┴───────────────────────────────────────┘
```

**レビュー差し戻しのフロー:**
- Senior Engineerが `Request Changes` → 対象エージェントに修正を依頼 → 再レビュー
- Security Agentが `Critical/High` → Impl Agentに即時修正を指示 → 再監査
- 最大3回の差し戻しで解決しない場合 → ユーザーに判断を仰ぐ

### バグ修正フロー
```
1. 失敗しているテストを特定
2. Test Agent: テストが正しいか確認・修正
3. Impl Agent: テストが通るまで実装修正
4. Security Agent: 修正箇所のセキュリティ確認
5. E2E確認
```

### サブエージェント並列実行のルール
- Spec → (Senior Review + Designer) → Test → (Senior Review) → Impl → (Senior Review + Security) → E2E
- `+` は並列実行可能、`→` は順次実行必須
- 異なる機能の開発パイプラインは並列実行可能

---

## E2Eテスト戦略

### agent-browser (AI探索・デバッグ用)
- 新規E2Eシナリオの探索・設計
- テスト失敗時のデバッグ
- Markdownシナリオの実行確認

### Playwright (CI/CD自動実行用)
- 確定したテストの高速実行
- 並列ブラウザテスト
- Trace/Video記録

---

## コマンド一覧

### テスト
```bash
pnpm test:unit        # 単体テスト (Vitest)
pnpm test:integration # 結合テスト (Vitest)
pnpm test:e2e         # E2Eテスト (Playwright)
pnpm test             # 全テスト実行
```

### 開発
```bash
pnpm dev              # 開発サーバー起動
pnpm build            # プロダクションビルド
pnpm type-check       # 型チェック
pnpm lint             # Lint実行
```

### E2E (agent-browser)
```bash
agent-browser open <url>      # ブラウザ起動
agent-browser snapshot        # 要素一覧取得
agent-browser click @e1       # 要素クリック
agent-browser fill @e2 "text" # 入力
agent-browser screenshot      # スクリーンショット
```

---

## ファイル構成
```
/
├── CLAUDE.md                     # この設定ファイル
├── .claude/skills/               # Claude Codeスキル
│   ├── spec.md                   # 仕様策定スキル
│   ├── test.md                   # テスト設計スキル
│   ├── impl.md                   # 実装スキル
│   ├── designer.md               # フロントエンドデザイナースキル
│   ├── senior-review.md          # シニアエンジニアレビュースキル
│   ├── security.md               # セキュリティ監査スキル
│   └── tdd.md                    # TDDフルフロースキル
├── docs/                         # 仕様書・レビュー結果
│   ├── business-spec.md          # 業務仕様書
│   ├── functional-spec.md        # 機能要件書
│   ├── ui-design/                # UIデザイン仕様
│   ├── security-audit.md         # セキュリティ監査レポート
│   └── review-*.md               # レビュー結果
├── src/                          # ソースコード
│   ├── components/ui/            # 共通UIコンポーネント
│   └── styles/                   # デザイントークン・アニメーション
├── tests/
│   ├── unit/                     # 単体テスト (*.test.ts)
│   ├── integration/              # 結合テスト (*.int.ts)
│   ├── fixtures/                 # テストフィクスチャ
│   └── e2e/
│       ├── specs/                # E2Eシナリオ (Markdown)
│       ├── playwright/           # Playwrightテスト
│       └── pages/                # Page Objects
└── .github/workflows/            # CI/CD設定
    └── ci.yml                    # テスト自動実行
```

---

## 持続的開発のためのルール

### コンテキスト永続化
- 仕様・テスト・実装・レビュー・監査の全成果物はファイルに書き出す
- サブエージェントへの指示には必ず参照ファイルパスを含める
- レビュー結果は `/docs/review-*.md` に蓄積し、過去の指摘を参照可能にする
- セキュリティ監査結果は `/docs/security-audit.md` に蓄積する

### エラーリカバリ
- テスト失敗時は失敗内容を分析し、仕様・テスト・実装のどこに問題があるか特定する
- 仕様の問題 → Spec Agentで仕様修正 → Senior Review → Test Agent → Impl Agent
- テストの問題 → Test Agentでテスト修正 → Senior Review → Impl Agent
- 実装の問題 → Impl Agentで実装修正 → Senior Review + Security
- セキュリティの問題 → Security Agentの指示に従いImpl Agentが修正 → 再監査
- 最大3回リトライしても解決しない場合はユーザーに報告

### 品質ゲート
以下が全てパスしないと完了としない:
1. `pnpm type-check` - 型エラーなし
2. `pnpm test:unit` - 単体テスト全パス
3. `pnpm test:integration` - 結合テスト全パス
4. `pnpm test:e2e` - E2Eテスト全パス（該当テストがある場合）
5. Senior Engineer Review - Approve 判定
6. Security Audit - Critical/High の未解決なし
