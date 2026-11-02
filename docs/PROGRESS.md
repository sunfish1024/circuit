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

## 完了した分野（続き）
- layout 基盤（2026-11-02）: 固定部品のガイド線・GND記号、ラベル重なり修正、問題パネルのリサイズ、tools/check_layout.mjs、docs/layout_spec.md。A分野20問の layout を付け直し（固定GND部品は削除）
- B（20問、2026-11-02）: verify --strict 20/20、--reverse 18問対象で甘い判定0（B-01, B-15 は極性部品をプレイヤーが置かないので対象外）、--drop 甘い判定0、check_layout 問題0。--mutate の甘い判定3問（B-02, B-06, B-07）は逆バイアスの D2 の Vf が結果に効かない物理的な理由で verifyNote あり。マウス操作での確認: B-03, B-08, B-13, B-16
  - B の判定は DC のみ（ダイオード・トランジスタの過渡は未対応。F 分野で追加予定）

- G（20問、2026-11-02）: verify --strict 20/20、--reverse・--drop 甘い判定0、check_layout 問題0。--mutate の甘い判定5問（G-14, G-15, G-16, G-17, G-20）は「OR と XOR が同じ論理になる」ため verifyNote あり。マウス操作での確認: G-01, G-08, G-13, G-16。componentCount で「指定外のゲートは0個」を併用して穴を塞いだ

## エンジン拡張（2026-11-02 C・G・H向け）
- デジタル（sim-engineer）: digital.js を全面書き直し（旧コードは type でなく simulation.model で部品を見分けていて、ゲート回路を一度も評価できていなかった）。0/1/X の3値、未接続入力はX、出力衝突は不合格。新部品 LOGIC_IN / U_XNOR / U_AND3 / U_OR3 / DFF_R。新判定 truthTable（inputs/outputs/expect）、sequence（クロックごとの系列）、componentCount。verify に ゲート差し替え・DFF の Q/Q_NOT 取り違えの誤答を追加
- アナログ（sim-engineer）: AC解析がBJT/MOSFET/OPAMPに対応（DC動作点で線形化）、OPAMP の DC/過渡/飽和、正帰還の不安定平衡点の修正。新判定 acImpedance / operatingRegion / transientMeasure（max/min/pp/average/rms/acRms。F分野の平均値・リップルにも使える）、nodeRef/inputRef/outputRef・sources による差動・同相の判定、simulation.initialCondition: dc
- UI（ui-engineer）: デジタル結果の表（真理値表・系列。不一致は赤）、LOGIC_IN のクリック切替、パレット追加位置を空き場所に、問題読み込み直後は選択なし
- 仕様は docs/check_reference.md

## 残課題
- 旧B分野50問は作り直し予定（B-32: mutate/drop で甘い、B-47: reverse で甘い）
- digital シミュレータは未配線ピンを gnd 扱い（H分野で見直し）
- F分野: 過渡解析のダイオード、平均値・リプル判定が必要
- UI: パレットのクリックで追加した部品はボード中央右寄りに出て固定部品のすぐ脇に重なることがある（追加位置を空き場所にしたい）
- B-04 は部品IDで判定（match は「どれか1つが合格」のため全LEDを確認できない）。B-17〜B-19 のFETはマウス手配線を未確認（参照解の配置のみ）
- B の mutate は代表パラメータ1つしか2倍にしない（β, K などは手元確認のみ）
- UI/layout: 1440px 幅の画面でボードの表示幅が約796pxしかなく、layout_spec の基準幅960の右側が横スクロールしないと見えない（G分野は固定部品を x≤680 に収めて回避。B-15 は x=780 で一部はみ出す）。ボードを表示幅に合わせて自動縮小する対応を検討
- UI: 配線した線が既存の縦線と同じ x で重なると、つながって見える
- UI: シミュレーション結果の真理値表に期待値（「正 0」）が出るため、シミュレーションを押すだけで正解が分かる（チェック結果の「正しくは…」と情報量は同じなので当面そのまま）
- UI: 回転した固定部品のピン名ラベルと部品IDラベルが重なることがある。シミュレーション警告（未接続ネット等）の見せ方は要改善
