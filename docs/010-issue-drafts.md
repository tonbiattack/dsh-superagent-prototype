# Issue drafts — enable GitHub Issues before publishing

GitHub API currently returns HTTP 410: "Issues has been disabled in this repository."
Enable Settings > General > Features > Issues, then create these five issues. Full behavior and acceptance criteria: [spec](./009-issue-autopilot-fork.md).

## 1. feat: autopilotラベル付きIssueの自動検知とキュー登録
- 既存GitHub Source/Policyを再利用し、許可ユーザーの `autopilot` ラベル付きOpen Issueを60秒間隔で検知
- 起動時の既存Issue走査、ページネーション、レート制限対応
- repo ID + issue IDによる永続的重複排除
- ラベルなし/未許可は実行禁止
- テスト: 追加/削除、初回検知、繰り返し検知、再起動

## 2. feat: 複数GitHubリポジトリの監視・ワークスペース振り分け
- repoごとにfullName, checkout path, 許可ユーザー, 資格情報参照を設定
- 既存Executorをリポジトリ単位で振り分け
- 並列上限: 初期値 全体1、リポジトリごと1
- 同じIssue番号でもリポジトリを跨いで区別
- 単一repo設定との後方互換、異常repoの隔離
- テスト: 2repo以上・失敗時隔離・設定移行

## 3. feat: PRを作成しない検証・ローカルコミット完了モード
- 各Issueを専用branch/worktreeで実装
- Issue・AGENTS.md・関連仕様を読み、テスト→最大3回修正
- 成功時に関連変更だけをコミットしSHAを保存
- PRなし、pushなし、auto-closeなしが初期設定
- default branchへの直接コミット、force pushは禁止
- 失敗時には変更を保持、未検証を成功扱いしない
- テスト: no PR/no push/no default writeを保証

## 4. feat: 中断・再起動復旧と二重実行防止
- 既存Ticket永続化の再利用
- 排他lock/lease、ステート遷移、遺棄workerの扱い
- branch/差分/commit SHAを照合して安全に再開
- 完了済みコミットの二重実行防止
- pause/resume/skip、リトライ上限
- テスト: プロセス停止、連続ポーリング、Git操作失敗

## 5. docs: DSHセットアップ・監視状況表示・Fork運用手順
- 既存UIにrepo/issue/status/tests/commit/errorsを表示
- Windows11+WSL2向けセットアップ、認証、始動・停止
- ラベル、ポーリング、監視対象repo、push/PR設定のドキュメント
- READMEから仕様へのリンク、upstream同期手順
- テスト: pnpm check / 1件のIssueを自動処理できる再現手順

## Safety note
Do not label these self-hosted improvement issues `autopilot` until the implementation has been tested in a safe sandbox; otherwise recursive execution may occur.
