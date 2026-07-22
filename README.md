# Graphanta v0.2.0-alpha.3

数学的な思考と表現を支援する、ローカルファーストの作図アプリです。

## 開発環境での起動

```bash
npm ci
npm run dev
```

## 公開用ファイルの生成

```bash
npm run build
```

生成物はGit管理対象外です。

- GitHub Pages公開用: `dist/`
- ブラウザで直接開ける単一HTML版: `index.html`、`Graphanta.html`

GitHub Actionsの`Deploy Graphanta to GitHub Pages`ワークフローは、`main`ブランチへの更新時に`dist/`を生成して公開します。

## v0.2.0-alpha.3の主な変更

- 複数要素のグループ化／グループ解除
- グループ単位の選択、移動、複製、削除、整列、重なり順変更
- `Ctrl＋G`／`Ctrl＋Shift＋G`のショートカット
- 旧プロジェクト互換を保つグループ情報の保存と読込時の自動修復
- 画面比率と倍率に追従する方眼・座標軸
- 右クリックツールメニューと右ドラッグスクロール
- タッチ操作の判定改善
- アレー図の「玉」「人」
- スクリーンショット機能
- キャンバス上の回転ハンドル
