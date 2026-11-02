# 進捗

## 2026-11-02（チャットでの事前調査）
- 旧A・B問題100問の参照解は全問合格。値を2倍にした誤答は95問で不合格（残り5問のうち B-47 は判定が甘い）
- tools/verify.mjs（参照解検証・mutate・reverse）を追加
- 方針: A〜Jを各20問で作り直し・新規作成。K〜Sは準備中

## 2026-11-02 作業の進め方 1（エンジン・UI）完了
- UI（src/ui/learning.js, src/ui/markdown.js, app.js）
  - 問題文・ヒント・解説は Markdown サブセット + KaTeX（vendor/katex に同梱、CDN不要）
  - 段階ヒント（hints 3要素）、回答欄（questions: numeric / choice）、クリア表示と「次の問題へ」、「答えを見る」（確認→参照解＋解説）、クリア後の「解説を読む」
  - 進捗を localStorage に保存（メニューに ✓ とクリア数）。K〜S は「準備中」で選択不可（config.js の ui.activeCategories）
  - 固定部品は問題JSONの position / rotation で配置。固定部品のピンにはネット名を常時表示
- 判定・検証（sim-engineer。仕様は docs/check_reference.md）
  - connection の pins 形式（極性を見る）、numericAnswer、match（IDでなくネット＋種別で部品指定）、toleranceAbs
  - 未配線ピン・TPだけのネットを正しく扱う（src/sim/netlist.js）、timeConstant をテブナン抵抗／波形測定に修正、過渡解析を台形則化・V_PULSE対応、checks の frequencyHz でもAC解析
  - verify.mjs: validation 適用、index 一致、--mutate（部品1個ずつ・回答も）、--reverse、--drop（新規）、--strict
  - tools/test_checks.mjs（124項目）

## 完了した分野
- A（20問、2026-11-02）: verify --strict / --mutate / --drop すべて合格（--reverse は極性部品なしで対象外）
  - ユーザーの方向性確認待ち（CLAUDE.md 作業の進め方 2）

## 2026-11-02 方向性承認・以降の進め方
- ユーザーが A 分野を承認。以降は確認なしで進める。分野の順番: **B → C → G → I → F → H → J → D → E**
- まず配線表示（layout・ガイド線）、ラベル重なり、問題パネルのリサイズ、layout 検査ツールを実装 → A分野の layout 付け直し → B へ
- ui-engineer（.claude/agents/ui-engineer.md）はセッション開始後に追加したため認識されず、sim-engineer に代役させた（次回セッションから ui-engineer が使える）

## 残課題
- 旧B分野50問は作り直し予定（B-32: mutate/drop で甘い、B-47: reverse で甘い）
- digital シミュレータは未配線ピンを gnd 扱い（H分野で見直し）
- F分野: 過渡解析のダイオード、平均値・リプル判定が必要
- UI: 回転した固定部品のピン名ラベルと部品IDラベルが重なることがある。シミュレーション警告（未接続ネット等）の見せ方は要改善
