# Graphanta v0.2.0-alpha.5

数学的な思考と表現を支援する、ローカルファーストの作図アプリです。

## 開発環境での起動

```bash
npm ci
npm run dev
```

`app.html`はViteの開発用入口です。リポジトリ直下の`index.html`は、ビルド済みの単体起動版です。

## 公開用ファイルの生成

```bash
npm run build
```

ビルド時に、Viteの生成物からCSSとJavaScriptを埋め込んだ単体版を作成します。

- リポジトリ直下の公開・ローカル起動用: `index.html`
- 検証用生成物: `dist/index.html`

GitHub Pagesは **Deploy from a branch / main / /(root)** を選択してください。Actionsワークフローは使用しません。`index.html`は通信なしで直接開けます。

## v0.2.0-alpha.5の主な変更

- GitHub Pagesの「Deploy from a branch / main / /(root)」に対応
- リポジトリ直下の`index.html`を、CSS・JavaScript内包の単体起動版へ変更
- 開発用HTMLを`app.html`へ分離
- `build-standalone.mjs`の資産パス解決を、生成HTML基準へ修正
- `dist/graphanta/assets`のような誤った二重参照を防止
- alpha.4までの作図・グループ・スクリーンショット機能を維持
- Actions用`deploy.yml`を廃止し、ブランチ公開へ統一

## v0.2.0-alpha.4の主な変更

- リポジトリ直下の`index.html`から起動する標準構成へ修正
- 「スクショ」を「スクリーンショット」へ変更し、単一ボタンのドロップダウンに統合
- アプリ内の右クリックでブラウザ標準コンテキストメニューが出ないよう修正
- 「玉」の大きさと選択枠を連動させ、次回配置へ大きさを継承
- 「人」の図案を簡潔なピクトグラムへ変更し、次回配置へ大きさを継承
- アレー図グループへ「まとまり」を追加
  - 縦：横＝1：√2
  - 数値は1・10・100の段階スライダーと直接入力に対応
  - 色、大きさ、不透明度を変更可能
  - 次回配置へ大きさを継承
- だ円の数値指定を「長半径・短半径」から「横半径・縦半径」へ変更
- 旧形式のだ円データは読み込み時に互換処理
- グループ化／グループ解除とグループ単位操作を継続
