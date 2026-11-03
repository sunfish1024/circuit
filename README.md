# 電子回路学習ゲーム

NANDgame風の操作で電子回路を学ぶ静的Webゲーム（ビルド不要。HTML / CSS / ES Modules）。
部品を置いて配線し、値を設定して「チェック」を押すと、シミュレーションで自動判定されます。

## 遊ぶ（GitHub Pages）
https://sunfish1024.github.io/circuit/

公開設定: リポジトリの Settings → Pages → Build and deployment → Source を **Deploy from a branch**、
Branch を公開したいブランチ、フォルダを **/ (root)** にします（`.nojekyll` 同梱済み）。

## ローカルで動かす
`python3 -m http.server 8000` → http://localhost:8000/

## 収録している分野
A 電気の基礎 / B 半導体素子 / C 増幅回路 / D 発振回路 / E 変調・復調・通信 / F 電源回路 / G デジタル組み合わせ回路 /
H デジタル順序回路 / I プロセッサ周辺 / J パワーエレクトロニクス（計200問、各問に解説つき）。K〜S は準備中。

## 開発者向け
- 問題検証: `node tools/verify.mjs`（`--mutate` / `--reverse` / `--drop` / `--strict`）
- レイアウト検査: `node tools/check_layout.mjs`
- 判定のテスト: `node tools/test_checks.mjs`
- 進捗と仕様: `docs/PROGRESS.md`, `docs/check_reference.md`, `docs/layout_spec.md`
