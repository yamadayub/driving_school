# TDD フルフロー: 仕様→レビュー→テスト→実装→監査→E2E

このスキルは、ユーザーの要件を受け取り、エージェント間の相互レビューを含むTDDの全工程を一貫して実行します。

## フロー概要

```
要件入力 → 仕様策定 → ┌ 設計レビュー ┐ → テスト設計 → テストレビュー
                      └ UI設計      ┘
→ 実装 → ┌ コードレビュー   ┐ → E2E検証 → 完了報告
         └ セキュリティ監査  ┘
```

## 実行手順

### Phase 1: 仕様策定
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/spec.md を読み、その手順に従って作業してください。
/docs/functional-spec.md と /docs/business-spec.md を読み込み、
ユーザーの要件「[要件]」に基づいて仕様書を更新してください。
```

**完了確認**: `/docs/functional-spec.md` に機能ID付きの要件が記載されていること

---

### Phase 2: 設計レビュー + UI設計（並列実行）

**2a. Senior Engineer: 設計レビュー**
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/senior-review.md を読み、その手順に従って作業してください。
レビュー対象: 設計
対象ファイル: /docs/functional-spec.md, /docs/business-spec.md
レビュー結果を /docs/review-design-YYYY-MM-DD.md に出力してください。
```

**2b. Designer Agent: UI設計**（UI関連機能の場合）
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/designer.md を読み、その手順に従って作業してください。
対象機能: /docs/functional-spec.md の [新規/更新された機能]
UIデザイン仕様を /docs/ui-design/[機能名].md に出力してください。
デザイントークンとUIコンポーネントが必要な場合は /src/styles/ と /src/components/ui/ に作成してください。
```

**ゲート判定**:
- Senior Engineer が `Approve` → Phase 3 へ
- Senior Engineer が `Request Changes` → Phase 1 に差し戻し（指摘内容をSpec Agentに共有）

---

### Phase 3: テスト設計
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/test.md を読み、その手順に従って作業してください。
/docs/functional-spec.md を参照し、新規・更新された機能要件に対して
テストコードを作成してください。
UIデザイン仕様がある場合は /docs/ui-design/ も参照してください。
```

**完了確認**: テストファイルが作成され、構文エラーがないこと

---

### Phase 4: テストレビュー
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/senior-review.md を読み、その手順に従って作業してください。
レビュー対象: テスト
対象ファイル: /tests/unit/, /tests/integration/, /tests/e2e/specs/
レビュー結果を /docs/review-test-YYYY-MM-DD.md に出力してください。
```

**ゲート判定**:
- `Approve` → Phase 5 へ
- `Request Changes` → Phase 3 に差し戻し

---

### Phase 5: 実装
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/impl.md を読み、その手順に従って作業してください。
作成されたテストファイルを全て読み込み、テストがパスするように実装してください。
UIデザイン仕様がある場合は /docs/ui-design/ のデザイントークンとコンポーネント仕様に従ってください。
終了条件: pnpm test:unit && pnpm test:integration が全てパス
```

**完了確認**: `pnpm test:unit` と `pnpm test:integration` が全パス

---

### Phase 6: コードレビュー + セキュリティ監査（並列実行）

**6a. Senior Engineer: コードレビュー**
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/senior-review.md を読み、その手順に従って作業してください。
レビュー対象: 実装
対象ファイル: /src/ 配下の新規・変更ファイル
過去の設計レビュー /docs/review-design-*.md の指摘が反映されているかも確認してください。
レビュー結果を /docs/review-impl-YYYY-MM-DD.md に出力してください。
```

**6b. Security Agent: セキュリティ監査**
Taskツール（subagent_type: general-purpose）で以下を実行:

```
.claude/skills/security.md を読み、その手順に従って作業してください。
対象: /src/ 配下の全コードと /docs/functional-spec.md
結果を /docs/security-audit.md に出力してください。
```

**ゲート判定**:
- Senior Engineer `Approve` かつ Security Agent に `Critical/High` なし → Phase 7 へ
- `Must Fix` または `Critical/High` あり → Phase 5 に差し戻し（指摘内容をImpl Agentに共有）

---

### Phase 7: E2E検証
1. E2Eシナリオ（`/tests/e2e/specs/*.spec.md`）の内容を確認
2. Playwrightテストが存在する場合は `pnpm test:e2e` を実行
3. 失敗があれば Phase 5 に戻り修正

---

### Phase 8: 完了報告
以下をユーザーに報告:
- 追加/変更された仕様の概要
- UIデザインの概要（該当する場合）
- 作成されたテストの一覧とカバレッジ
- 実装されたモジュールの一覧
- Senior Engineerレビュー結果のサマリー
- セキュリティ監査結果のサマリー
- 全テストの結果

## エラー時の差し戻しルール

| 発生Phase | 問題の種類 | 差し戻し先 | 経由するPhase |
|-----------|----------|-----------|-------------|
| Phase 2 | 仕様の曖昧さ | Phase 1 | → Phase 2 |
| Phase 4 | テストの網羅性不足 | Phase 3 | → Phase 4 |
| Phase 5 | テストがパスしない（仕様の問題） | Phase 1 | → Phase 2 → Phase 3 → Phase 5 |
| Phase 5 | テストがパスしない（実装の問題） | Phase 5 | （同Phase内リトライ） |
| Phase 6 | コード品質の問題 | Phase 5 | → Phase 6 |
| Phase 6 | セキュリティ脆弱性 | Phase 5 | → Phase 6 |
| Phase 7 | E2E失敗 | Phase 5 | → Phase 6 → Phase 7 |

## 注意事項

- 各Phaseの結果をファイルに書き出すことで、コンテキストをPhase間で引き継ぐ
- レビュー結果の蓄積: 同じ指摘が繰り返されないよう、過去のレビューファイルを参照する
- 最大リトライ: 各Phase 3回まで。超えた場合はユーザーに状況報告し判断を仰ぐ
- 並列実行可能なPhase（2a+2b, 6a+6b）は必ず並列で起動しパフォーマンスを最大化する
