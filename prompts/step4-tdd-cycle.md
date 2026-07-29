# Step 4: TDDサイクルプロンプト

Step 3（機能設計）完了後、機能単位でTDDサイクルを回すためのプロンプトです。
対象機能のF-IDを [F-XXX] に置き換えて使用してください。

---

```
まず CLAUDE.md を読んでプロジェクトの開発方針とエージェント構成を理解してください。

次に以下のドキュメントを全て読んでください:
- /docs/functional-spec.md（機能要件書）
- /docs/ui-design/ 配下のUIデザイン仕様
- /docs/review-design-*.md（設計レビュー結果）
- /tests/ 配下の既存テスト（あれば）
- /src/ 配下の既存実装（あれば）

これから [F-XXX]: [機能名] のTDDサイクルを実行します。
CLAUDE.md の tdd.md フルフローに従い、以下のPhaseを順に進めてください。

## Phase 1: テスト設計

Taskツールで Test Agent を起動してください（.claude/skills/test.md を読ませる）。

対象: /docs/functional-spec.md の [F-XXX] セクション
出力:
- /tests/unit/[機能名].test.ts
- /tests/integration/[機能名].int.ts（必要な場合）
- /tests/e2e/specs/[機能名].spec.md

## Phase 2: テストレビュー

Taskツールで Senior Engineer Agent を起動してください（.claude/skills/senior-review.md を読ませる）。

レビュー対象: Phase 1 で作成されたテストファイル
出力: /docs/review-test-[日付].md

Request Changes の場合 → Phase 1 に戻り修正
Approve の場合 → Phase 3 へ

## Phase 3: 実装

Taskツールで Impl Agent を起動してください（.claude/skills/impl.md を読ませる）。

- テストファイルとUIデザイン仕様を読ませる
- 終了条件: pnpm test:unit && pnpm test:integration が全てパス
- テスト失敗時は修正して再実行（最大3回）

## Phase 4: コードレビュー + セキュリティ監査（並列）

Taskツールで以下を並列起動:

1. Senior Engineer Agent（.claude/skills/senior-review.md）
   → コードレビュー、結果を /docs/review-impl-[日付].md に出力
2. Security Agent（.claude/skills/security.md）
   → セキュリティ監査、結果を /docs/security-audit.md に出力

Must Fix / Critical あり → Phase 3 に戻り修正
全 Approve → Phase 5 へ

## Phase 5: E2E検証

E2Eテストが存在する場合は pnpm test:e2e を実行。
失敗時は Phase 3 に戻り修正。

## Phase 6: 完了報告

以下を報告してください:
- 作成されたテストの一覧とパス状況
- 実装されたモジュールの一覧
- レビュー指摘の対応サマリー
- セキュリティ監査結果
- 次に着手すべき機能の提案

## 注意事項

- 各Phase完了時に結果をファイルに書き出すこと
- テストを変更せず、テストが通る実装を書くこと（TDD原則）
- 既存の実装・テストを壊さないこと
- 不明点は私に質問してください
```
