# GraphantaをCodexで直接開発する手順

この文書は、ZIP受け渡し方式から、GitHubリポジトリをCodexが直接編集してPull Requestを作成する方式へ移行するための手順です。

## 1. GitHubへ初期状態を配置

1. GitHubでGraphanta用リポジトリを作成します。
2. このZIPの中身を、フォルダーごとではなく**リポジトリのルート**へ配置します。
3. 既定ブランチを`main`にします。
4. 最初のコミットを作成してpushします。
5. GitHub Pagesで次を選択します。
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/(root)`

`index.html`はビルド済みの単体版なので、GitHub ActionsのデプロイWorkflowは不要です。

## 2. CodexとGitHubを接続

1. ChatGPTまたはCodexを開き、Codexを選択します。
2. GitHub接続を求められたら、使用中のGitHubアカウントで認証します。
3. リポジトリアクセスは、まずGraphantaのリポジトリだけに限定します。
4. GraphantaリポジトリのCloud environmentを作成します。

推奨環境設定:

- Node.js: `22.12.0`以上のNode 22系
- Setup script:

```bash
npm ci
```

- Maintenance script:

```bash
npm ci
```

- Agent phaseのInternet access: 原則OFF

依存関係の取得はsetup段階で行えます。アプリ自身は完全オフラインを要件としているため、通常の実装・検証ではagent段階の外部通信を必要としません。

## 3. 最初の確認タスク

最初は変更をさせず、環境とルールを確認します。Codexへ次を送ります。

```text
Graphantaリポジトリを確認してください。AGENTS.mdを読み、まだファイルは変更しないでください。
リポジトリ構造、開発用入口、公開用index.htmlの生成方法、必須検証コマンド、GitHub Pagesと完全オフラインの制約を要約してください。
その後、npm run check、npm run build、npm run verify:repoを実行し、結果を報告してください。
```

全コマンドが通れば、直接開発へ移れます。

## 4. 開発タスクの依頼方法

通常の依頼は、次の形にします。

```text
Graphantaの次の課題を修正してください。

【課題】
（症状、再現手順、期待する動作を書く）

個別ケースへの場当たり的対応より、共通の入力・選択・履歴・レイアウト・描画基盤の問題として一般化できる場合は、一般化した修正を優先してください。
既存機能と操作感を維持し、AGENTS.mdの検証をすべて実行してください。
作業ブランチで変更し、差分、原因、修正方針、検証結果を示してPull Requestを作成してください。
```

画像がある場合は、Codexのタスクへ画像も添付します。

## 5. Pull Requestの確認

Codexが作成したPull Requestでは、最低限次を確認します。

- 意図しないファイルが変更されていない
- `src/`の変更に対応してルート`index.html`も更新されている
- `node_modules/`や`dist/`が含まれていない
- 外部CDNや外部アセット参照が追加されていない
- 実施したコマンドと結果が記載されている
- マウス、タッチ、横長、縦長への影響が説明されている

必要に応じてPRコメントで次のように追加修正を依頼できます。

```text
@codex このPRの変更を維持したまま、縦長表示とタッチ操作の回帰を再確認し、問題があれば修正してください。
```

コードレビュー機能を有効にした場合は、PRコメントで次を送れます。

```text
@codex review
```

## 6. mainへの反映

1. GitHub上でFiles changedと検証結果を確認します。
2. 必要なら手元またはGitHub Pagesの一時ブランチで動作確認します。
3. 問題がなければPRを`main`へマージします。
4. GitHub Pagesの反映後、公開ページを確認します。

`main`へ直接実装させるのではなく、ブランチとPull Requestを経由する運用を維持してください。
