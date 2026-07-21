# Graphanta v0.2.0-alpha.1

数学的な思考と表現を支援する、ローカルファーストの作図アプリです。

## 起動

ZIPを展開し、`index.html`または`Graphanta.html`をEdge／Chromeで開きます。開発環境では`npm ci`後に`npm run dev`、公開用生成は`npm run build`です。

## 今回の主な追加

- 回転に追従する選択枠・リサイズ
- 多角形の頂点編集、追加、削除
- 点・中心・交点・辺への吸着
- 複数選択、整列、等間隔配置
- 重なり順の変更
- Shiftによる45度補正と縦横比固定
- 操作履歴の精密化

詳細は`DEVELOPMENT_PLAN.md`と`TEST_CHECKLIST.md`を参照してください。
