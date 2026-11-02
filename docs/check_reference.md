# 判定（checks）・問題データ リファレンス

problem-writer 向けの資料。sim-engineer が保守する。実装: `src/checks/runner.js`, `src/sim/*.js`, `src/core/validation.js`。
数値はすべて SI 単位（V, A, Ω, F, H, s, Hz, W）。

---

## 1. 問題 JSON の全体

```json
{
  "id": "A-07",
  "category": "A",
  "title": "RC回路の時定数",
  "difficulty": 2,
  "statement": "## 状況\n...\n## やること\n...\n## 条件\n- コンデンサの初期電圧は 0V\n- 電源は t=0 で投入される",
  "prerequisites": ["A-06"],
  "judge": "transient",
  "simulation": { "tStop": 0.01 },
  "learningGoal": "...",
  "hints": ["方針", "使う式", "ほぼ答え"],
  "explanation": {
    "solution": "解き方",
    "why": "なぜそうなるか",
    "mistakes": "よくある間違い",
    "practice": "実務・応用",
    "next": "次につながる知識"
  },
  "availableComponents": ["R", "C"],
  "fixedComponents": [ ... ],
  "checks": [ ... ],
  "referenceSolution": [ ... ],
  "questions": [ ... ],
  "referenceAnswers": { "q1": 0.0125 },
  "verifyNote": "（判定が甘く見える理由。必要な場合だけ）"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id`, `category`, `title`, `statement` | 文字列 | ○ | statement は Markdown のサブセット（見出し `##`、箇条書き `-`、太字 `**`、数式 `$...$`） |
| `difficulty` | 0〜5 の整数 | | |
| `prerequisites` | 文字列配列 | | 先に解くべき問題ID。旧 `prerequisite`（文字列）も可 |
| `judge` | `"dc"` / `"ac"` / `"transient"` / `"digital"`、またはその配列 | | シミュレーションの種類。省略時 `"dc"`。`["dc","transient"]` のように配列にすると両方を実行し、DC 判定と過渡判定を1問に混在できる |
| `simulation` | オブジェクト | | 解析設定。`tStop`（過渡の終了時刻 s）、`dt`（最大刻み s）、`frequencies`（AC 解析周波数の配列 Hz）、`initialCondition`（過渡の初期状態: `"zero"` 既定 / `"dc"` = DC 動作点から開始）。省略時は自動（§4, §5） |
| `hints` | 文字列3つの配列 | 新問題では必須 | 方針 → 使う式 → ほぼ答え。旧 `hint`（文字列1つ）も読めるが警告 |
| `explanation` | オブジェクト | 新問題では必須 | `solution`, `why`, `mistakes`, `practice`, `next` の5項目すべて空でない文字列 |
| `questions` | 配列 | 回答入力がある問題 | §3 |
| `referenceAnswers` | `{key: 値}` | questions があれば必須 | 正答。verify.mjs がこれを回答として渡す |
| `verifyNote` | 文字列 | | `--mutate` / `--reverse` / `--drop` で誤答が合格してしまう理由（比で決まる問題など）。書くと警告扱いになる |
| `fixedComponents` | 配列 | | ボードに最初から置かれる固定部品（`"locked": true`） |
| `referenceSolution` | 配列 | | 参照解でプレイヤーが置く部品 |

### 部品の書き方

```json
{ "id": "D1", "type": "D", "params": { "Vf": 0.7 }, "connect": ["vin", "out"] }
```

- `connect` は **components.json の `pinNames` の順** に並べたネット名の配列（D なら `[anode, cathode]`、Q_NPN なら `[collector, base, emitter]`、V_DC なら `[p, n]` = `[+, −]`）。要素数はピン数と同じにすること（validation が確認する）。
- グラウンドのネット名は `"gnd"`。
- **判定で見るノードには必ず固定部品を置く**（ノードに何も無ければテストポイント `TP`、connect は `["out"]`）。プレイヤーがネット名を手入力する前提にしない。
- 部品ID: プレイヤーが置いた部品は「種別 + 連番」（R1, R2, C1, D1 …）になる。置く順番でIDが入れ替わるので、**プレイヤーが同じ種別を2個以上置く問題では `element` ではなく `match` を使う**（§2 冒頭）。

---

## 2. 判定の種類（checks）

全数値判定に共通の許容誤差フィールド:
- `tolerancePct` … 相対誤差（%）。省略時 2%。
- `toleranceAbs` … 絶対誤差（判定量と同じ単位）。相対と大きい方を採用。**期待値が 0（0V, 0dB, 0° など）の判定では必須**（相対誤差だけでは 0 に対して許容幅がほぼ 0 になる）。

### match — 部品を ID ではなく「種別と接続」で特定する
`element` を書く判定（dcVoltage の element 形式, dcCurrent, dcPower, componentValue, connection, timeConstant, transientPoint）では、`element` の代わりに `match` を書ける。
```json
{ "type": "componentValue", "match": { "type": "R", "nets": ["vin", "out"] }, "expected": 1000, "tolerancePct": 5 }
{ "type": "dcCurrent", "match": { "type": "R", "nets": ["out", "gnd"] }, "expected": 0.001 }
{ "type": "connection", "match": { "type": "D" }, "pins": { "anode": "collector", "cathode": "VCC" } }
{ "type": "componentValue", "match": { "type": "D", "pins": { "K": "VCC" } }, "param": "Vf", "expected": 0.7 }
```
- `type`（任意）: 部品種別（文字列または配列）。`nets`（任意）: そのネットすべてにピンがつながっている（順不同）。`pins`（任意）: ピン名 → ネット名（向きも一致）。少なくとも1つ必要。
- 条件に合う部品が無ければ不合格「条件に合う部品がありません」。**複数該当したら、どれか1つが合格すれば合格**。
- `element` と両方書くと `element` が優先される（validation が警告）。
- ID の取り違え（R1 と R2 を逆の順で置いた）で正しい回路が落ちるのを防げる。値と場所の両方を判定できるので、`componentValue` + `connection` の2本を1本にまとめられる。

### dcVoltage（judge: dc）
```json
{ "type": "dcVoltage", "node": "out", "expected": 3.3, "tolerancePct": 2 }
{ "type": "dcVoltage", "element": "R2", "expected": 1.2 }
```
- `node`: gnd 基準のノード電圧。`element`: 部品の端子1 − 端子2（connect[0] − connect[1]）の電圧（符号つき）。

### dcCurrent / dcPower（judge: dc）
```json
{ "type": "dcCurrent", "element": "R1", "expected": 0.0125 }
{ "type": "dcPower", "element": "R1", "expected": 0.25 }
```
- 部品の電流 / 電力。既定は**絶対値**で比較（`"signed": true` で符号つき。R の電流の正の向きは connect[0]→connect[1]）。
- 電源（V_DC, I_DC）、R、C、L、ダイオード類、トランジスタ等に使える。

### componentValue（シミュレーション不要）
```json
{ "type": "componentValue", "element": "R1", "expected": 470, "tolerancePct": 5 }
```
- 部品パラメータ値そのもの。`param` を省略すると R→R, C→C, L→L, V_DC→V など代表パラメータ。値を入れるだけの問題は分野序盤だけにする。

### connection（シミュレーション不要）
**極性部品（D, LED, ZD, SD, TVS, トランジスタ, 電源など）は必ず `pins` 形式**で書く。
```json
{ "type": "connection", "element": "D1", "pins": { "anode": "collector", "cathode": "VCC" } }
{ "type": "connection", "element": "Q1", "pins": { "B": "base", "E": "gnd" }, "componentType": "Q_NPN" }
{ "type": "connection", "element": "R1", "nets": ["vin", "out"] }
```
- `pins`: ピン名 → ネット名。指定したピンだけ判定（他は自由）。ピン名は components.json の `pinNames`。略記も可: `A`/`K`（anode/cathode）, `C`/`B`/`E`（BJT）, `D`/`G`/`S`（FET）, `+`/`-`（電源の p/n）, `IN+`/`IN-`/`V+`/`V-`（OPAMP）。
- `nets`: 向きを見ない（無極性2端子向け・旧形式）。部品のどこかのピンが各ネットにつながっていれば合格。
- `componentType`（任意）: 部品種別（文字列または配列）も一致を要求。
- 部品が置かれていなければ不合格（「見つかりません」）。

### numericAnswer（シミュレーション不要・回答入力）
```json
{ "type": "numericAnswer", "key": "q1", "expected": 0.0125, "tolerancePct": 2, "unit": "A" }
```
- 回答は `questions` の `key` に対応する入力欄の値（UI が "12.5m" などの SI 接頭辞を数値に変換して渡す）。未回答なら不合格「未回答です」。不正解のとき期待値は表示されない。

### multipleChoice（シミュレーション不要・回答入力）
```json
{ "type": "multipleChoice", "key": "q2", "answerIndex": 1 }
```
- 回答は選択肢インデックス（**0 始まり**）。未回答なら不合格。
- 選択式・数値回答は回路で表現しにくい内容に限って補助的に使う（1分野あたり最大4問）。

### timeConstant（judge: transient）
```json
{ "type": "timeConstant", "node": "out", "expected": 0.001, "tolerancePct": 3 }
{ "type": "timeConstant", "element": "C1", "expected": 0.001 }
{ "type": "timeConstant", "expected": 0.001 }
```
- **`node` 指定（推奨）**: そのノードの過渡波形（ステップ応答）から 63.2% 法で τ を測る。v0 = v(`fromSec`)、v∞ = v(`toSec`)、v が v0 + 0.632(v∞ − v0) を横切る時刻 − fromSec が τ。
  - `fromSec`（既定 0）: ステップの時刻。V_DC なら 0。V_PULSE なら delaySec。
  - `toSec`（既定 解析終了時刻）: 最終値とみなす時刻。**toSec − fromSec ≥ 7τ にすること**。繰り返しパルスで使うときは `toSec` を立ち下がり前に置く。
  - 電源をつなぎ忘れる・C を別ノードに付けるなど、ノードが指数応答しない回路は不合格になる。
- `element` 指定: その C（または L）から見たテブナン抵抗 R_th を使って τ = R_th·C（L なら L/R_th）。R_th は「独立電圧源を短絡、独立電流源を開放、他の C は開放、他の L は短絡」で計算。
- どちらも無し: 回路に C か L が **1個だけ**のときの τ（R_th 法）。2個以上なら不合格（`node` を指定すること）。
- 測定誤差: 数値積分（台形則）と刻み τ/100 による誤差は 0.5% 未満。`tolerancePct` は 2〜5% を推奨。

### transientPoint（judge: transient）
```json
{ "type": "transientPoint", "node": "out", "timeSec": 0.001, "expected": 3.16, "tolerancePct": 2 }
{ "type": "transientPoint", "element": "L1", "quantity": "i", "timeSec": 0.0005, "expected": 0.0063 }
```
- `node`: 時刻 `timeSec` のノード電圧（gnd 基準、前後の刻みから線形補間）。
- `element` + `quantity`: `"v"`（既定。connect[0] − connect[1] の電圧）または `"i"`（電流。既定は絶対値、`"signed": true` で符号つき）。対応部品: R, C, L, 電源, SW。
- `timeSec` の 1.5 倍までは自動で解析される。

### oscillationFrequency（judge: transient）
```json
{ "type": "oscillationFrequency", "node": "out", "expected": 1591.5, "tolerancePct": 3 }
```
- 過渡波形の最終値まわりの上向き零交差の間隔から周波数を測る（減衰振動の **減衰固有周波数** f_d = √(ω0² − α²)/2π）。`node` 省略時は最も振れの大きいノード。`fromSec` も指定可。
- 過減衰（振動しない）なら不合格。解析時間は自動で 5 周期以上になる。

### acVoltage（judge: ac）
```json
{ "type": "acVoltage", "node": "out", "frequencyHz": 1000, "expectedRMS": 4, "tolerancePct": 2 }
```
- ノード電圧の**実効値**（Vrms）。V_AC の `Vpk` は**ピーク値**なので、10Vrms の電源は `Vpk = 14.142136`。
- `frequencyHz` 省略時は電源周波数。
- `nodeRef`（任意）: 差動電圧 V(node) − V(nodeRef) の実効値（差動出力など）。
- `sources`（任意、acVoltage / acGaindB / bodePoint 共通）: 固定部品の V_AC / I_AC のパラメータ（`Vpk` / `Ipk` / `phaseDeg`）を置き換えた回路で判定する。DC 動作点は元の回路のまま（交流源は DC に影響しないため）。差動入力の回路のまま同相入力の応答を見るのに使う:
  `{ "type": "acVoltage", "node": "out", "sources": { "V2": { "phaseDeg": 0 } }, "frequencyHz": 100, "expectedRMS": 0, "toleranceAbs": 0.001 }`

### acGaindB（judge: ac）
```json
{ "type": "acGaindB", "input": "vin", "output": "out", "frequencyHz": 1591.5, "expected": -3.01, "toleranceAbs": 0.1 }
```
- 利得 = 20·log10(|V(output)| / |V(input)|) [dB]。`input` / `output` は **ノード名**（gnd 基準電圧）。既定 `input="vin"`, `output="out"`。
- `input` ノードには電源の + 端子を、`output` ノードには TP などの固定部品を置く。
- dB の判定は `toleranceAbs`（dB）を使う。例: ±0.1dB。相対 % は 0dB 付近で使えない。
- `inputRef` / `outputRef`（任意、bodePoint も同じ）: 差動入力 V(input) − V(inputRef)、差動出力 V(output) − V(outputRef) で利得を計算する。`sources` で電源を置き換えた回路でも判定できる（acVoltage 参照）。
- 反転増幅の利得は dB では符号が出ない。反転（位相 180°）も確かめるときは bodePoint で `phaseDeg: 180` を判定する。

### bodePoint（judge: ac）
```json
{ "type": "bodePoint", "input": "vin", "output": "out", "frequencyHz": 1591.5,
  "gainDB": -3.01, "phaseDeg": -45, "gainToleranceDB": 0.1, "phaseToleranceDeg": 1 }
```
- 利得（acGaindB と同じ）と位相 = ∠V(output) − ∠V(input)（度、(−180, 180] に正規化）。`gainDB` / `phaseDeg` の指定した方だけ判定。
- 許容誤差は `gainToleranceDB`（dB）と `phaseToleranceDeg`（度）を推奨。省略時は `tolerancePct`（相対）と `toleranceAbs` の大きい方。

### AC 解析の周波数
- 電源（V_AC / I_AC）の `freqHz` に加え、**checks に書いた `frequencyHz` すべてで自動的に解析**する（電源振幅のまま、その周波数で解く。SPICE の AC 解析と同じ考え方）。1つの電源で複数周波数の利得を判定できる。
- `simulation.frequencies` を書くとその周波数だけを解析する。

### acImpedance（judge: ac）— 入力・出力インピーダンス
```json
{ "type": "acImpedance", "node": "b", "exclude": ["V1"], "frequencyHz": 10000, "expected": 916, "tolerancePct": 3 }
{ "type": "acImpedance", "node": "out", "exclude": ["RL"], "frequencyHz": 10000, "expected": 2200, "tolerancePct": 3 }
```
- 小信号インピーダンス |V/I|（Ω）。**独立電源をすべて 0**（電圧源は短絡、電流源は開放）にし、`exclude` に書いた**固定部品**を取り除いて、`node` − `nodeRef`（既定 gnd）間に試験電流を流して求める（教科書の「入力側から見たインピーダンス」の定義どおり）。トランジスタ・オペアンプは**元の回路の DC 動作点**で線形化する。
- 入力インピーダンス: 信号源（と直列の RS）を `exclude` して入力ノードから見る。電源を外さないと信号源の短絡で 0Ω（RS があれば RS∥Zin）になる。
- 出力インピーダンス: 負荷 RL を `exclude` して出力ノードから見る（入力の信号源は自動で短絡されるので信号源抵抗の影響も入る）。
- `quantity`: `"magnitude"`（既定）/ `"real"` / `"imag"` / `"phase"`（度）。
- 結合コンデンサの先から見ると C のリアクタンスが入るので、中域（C が短絡とみなせる周波数）で判定するか、C の内側のノードを指定する。
- 「負荷をつないだら出力が半分になる → Zout = RL」のような間接法も acVoltage 2本で書けるが、1問で RL を変えられないので acImpedance を使う。

### operatingRegion（judge に dc か ac）— バイアスの判定
```json
{ "type": "operatingRegion", "match": { "type": "Q_NPN" }, "region": "active" }
{ "type": "operatingRegion", "element": "U1", "region": "linear" }
```
- 非線形素子の DC 動作領域。`region` は文字列または配列（どれかに一致で合格）。
  - BJT: `off`（遮断）/ `active`（活性＝増幅に使う）/ `saturation`（飽和＝スイッチ ON）
  - MOSFET（K>0）: `off` / `triode`（線形領域）/ `saturation`（飽和領域＝増幅に使う）。K=0 のスイッチモードは `on` / `off`
  - JFET: `saturation` / `off`。D/SD/LED: `on` / `off`。ZD/TVS: `forward` / `breakdown` / `off`
  - OPAMP: `linear`（線形動作）/ `satHigh` / `satLow`（出力が上側／下側の電源で頭打ち）
- 不合格のメッセージに IC・VCE（MOSFET は VGS・VDS、OPAMP は出力電圧）が出る。
- 「バイアスが正しいか」は dcVoltage（VC や VE）と組み合わせると強い。judge が `"ac"` だけでも、AC 解析の前に求めた DC 動作点で判定できる。

### transientMeasure（judge: transient）— 振幅・平均・実効値・クリップ
```json
{ "type": "transientMeasure", "node": "out", "measure": "pp", "fromSec": 0.002, "toSec": 0.004, "expected": 21, "tolerancePct": 2 }
{ "type": "transientMeasure", "element": "RL", "quantity": "i", "measure": "average", "fromSec": 0.02, "toSec": 0.04, "expected": 0.01 }
```
- 区間 [`fromSec`, `toSec`]（既定 0〜解析終了）の波形の統計量。`measure`:
  `max` / `min` / `pp`（最大−最小）/ `average`（時間平均）/ `rms`（実効値）/ `acRms`（平均を除いた実効値＝リプルの実効値）。
- `node`（`nodeRef` で差動）または `element` + `quantity`（`"v"` / `"i"`）。電流は既定で向きを問わない（max/min は |i|、average は |平均|）。`signed: true` で符号つき（正の向きは connect[0]→connect[1]、ダイオードは順方向が正）。
- **定常の値を見るときは `fromSec` を必ず指定**（電源投入直後の過渡を除く。無いと validation が警告）。平均・実効値は区間を**周期の整数倍**にする。
- 区間は台形則で時間積分するので刻みが不均一でも正しい。最大・最小は刻みの点で拾うので、正弦波のピークは最大 1−cos(π/100) ≈ 0.05% 小さく出る（刻み T/100 のとき）。許容誤差は 1〜2% を推奨。
- 解析終了時刻は自動で `toSec` 以上になる。

### デジタル回路の部品と入出力（分野 G / H / I）
- **入力**: 固定部品 `LOGIC_IN`（論理入力、1ピン `Y`、パラメータ `value` = 0/1）。`{"id":"A","type":"LOGIC_IN","connect":["a"],"locked":true}`。判定（truthTable / sequence）が値を自動で切り替えるので、プレイヤーは値を操作しなくてよい。判定が駆動しない LOGIC_IN は `value` の定数（例: `value: 1` で「常に 1」の端子）。
- **クロック**: クロックも `LOGIC_IN`（例: id `"CLK"`、net `"clk"`）。sequence 判定の `clock` に書くと判定が 0→1→0 を与える。
- **出力**: 固定部品 `TP`（`connect: ["y"]`）。
- **定数**: `gnd` ネットは 0。`V_DC`（− 端子が gnd）の + 端子は V ≥ 2.0V で 1（5V や 3.3V の VCC）。
- **ゲート**（プレイヤーが置く。connect は入力…, 出力の順）: `U_NOT [A,Y]`, `U_AND` / `U_OR` / `U_NAND` / `U_NOR` / `U_XOR` / `U_XNOR` `[A,B,Y]`, `U_AND3` / `U_OR3` `[A,B,C,Y]`。
- **フリップフロップ**: `DFF [D,CLK,Q,Q_NOT]`（立ち上がりエッジ）、`DFF_R [D,CLK,CLR,Q,Q_NOT]`（CLR は**負論理の非同期クリア**: CLR=0 の間 Q=0。使わないときは VCC（1）につなぐ）。
- 補助: `R`（プルアップ／プルダウン = 弱い駆動）、`SW`（closed で短絡）。
- 入力ネットには LOGIC_IN、出力ネットには TP を**必ず固定部品で置く**（無いと validation が警告）。

### truthTable（judge: digital）— 組み合わせ回路
```json
{ "type": "truthTable", "inputs": ["a", "b"], "outputs": ["s", "c"], "expect": { "s": "0110", "c": "0001" } }
{ "type": "truthTable", "inputs": ["a", "b"], "outputs": ["y"], "table": [[0,0,1],[0,1,1],[1,0,1],[1,1,0]] }
```
- 判定が `inputs` の**全組み合わせ**を自動で与え、`outputs` の論理値を比べる。各行は電源投入直後の状態（ネット X、DFF の Q=0）から評価する（組み合わせ回路用。記憶のある回路は sequence で）。
- `expect`: `{出力ネット: 系列}`。系列は入力を**2進数で数えた順**（`inputs[0]` が最上位ビット。2入力なら 00, 01, 10, 11 の順）に 2^n 個。`"0110"` の文字列か `[0,1,1,0]`。
- `table`: `[入力..., 出力...]` の行の配列。**行の順は自由で、書いた行だけ判定**する（BCD の 10〜15 のような「ありえない入力」を省ける。ただし省いた行は判定されないので validation が警告する）。
- 出力に `"x"` を書くとその値は問わない（don't care）。
- 入力は 8 個まで（256 行）。
- 不合格のメッセージ例: 「a=1, b=1 のとき s=1（正しくは 0）」「U1 の B 入力が未配線です」「ネット y に出力が 2 個つながっています…衝突します」。
- ゲートが1つも無い回路（ダイオードロジックなど）は DC 解析で評価する: 入力に `driveLowV`（既定 0V）/ `driveHighV`（既定 5V）を与え、出力電圧が `vih`（既定 driveHighV/2）以上で 1、`vil`（既定 vih）以下で 0、その間は X。

### sequence（judge: digital）— 順序回路の出力系列
```json
{ "type": "sequence", "clock": "clk", "outputs": { "q": "1010" } }
{ "type": "sequence", "clock": "clk", "inputs": { "d": "1011000" }, "outputs": { "q2": "0010110" } }
{ "type": "sequence", "inputs": { "s": "0100010", "r": "0001000" }, "outputs": { "q": "x110011" } }
```
- **clock あり**: 電源投入（DFF の Q=0、clock=0）→ ステップ k ごとに「clock=0 のまま inputs の k 番目を与えて落ち着かせる → clock を 0→1 → 落ち着いた後の outputs を記録 → clock を 0 に戻す」。`outputs` の k 番目は **k 回目の立ち上がりの直後**の値。
- `sampleAt: "beforeRise"`: 入力を与えた後・立ち上がりの**前**に記録する（ミーリ型 FSM の出力など、入力で即座に変わる出力向け）。既定は `"afterRise"`。
- **clock なし**: 入力を与えて落ち着かせるたびに記録（SR ラッチ、D ラッチなど）。
- `inputs` / `outputs` の系列はすべて同じ長さ（最大 512）。入力は 0/1 のみ、出力は 0/1/`"x"`。
- 不合格のメッセージ例: 「q: クロック 3 回目で 0（正しくは 1）。出力系列 1001、正しい系列 1011」。
- 書き方のコツ: 分周・カウンタは数クロック分（1周以上）、シフトレジスタは段数＋数ビット分の系列にする。ゲートで組んだラッチは初期値が X なので、最初のステップでセット／リセットするか、最初の出力を `"x"` にする。

### componentCount（シミュレーション不要）
```json
{ "type": "componentCount", "types": ["U_NAND"], "max": 4 }
{ "type": "componentCount", "types": ["U_AND", "U_OR", "U_NOT"], "min": 1, "max": 5 }
```
- プレイヤーが置いた部品（固定部品は除く）のうち `types` の個数が `min` 以上 `max` 以下か。「NAND 4個で XOR を作る」などの最小構成の課題に使う。使える部品の種類そのものは `availableComponents` で絞る。

### デジタル問題の判定の組み立て方（例: 半加算器）
```json
"judge": "digital",
"availableComponents": ["U_AND", "U_OR", "U_NOT", "U_XOR"],
"fixedComponents": [
  { "id": "A", "type": "LOGIC_IN", "connect": ["a"], "locked": true },
  { "id": "B", "type": "LOGIC_IN", "connect": ["b"], "locked": true },
  { "id": "S", "type": "TP", "connect": ["s"], "locked": true },
  { "id": "C", "type": "TP", "connect": ["c"], "locked": true }
],
"checks": [ { "type": "truthTable", "inputs": ["a","b"], "outputs": ["s","c"], "expect": { "s": "0110", "c": "0001" } } ],
"referenceSolution": [
  { "id": "U1", "type": "U_XOR", "connect": ["a", "b", "s"] },
  { "id": "U2", "type": "U_AND", "connect": ["a", "b", "c"] }
]
```
- 真理値表は全行（expect）で判定するのが基本。一部の行だけだと別のゲートでも合格しうる（verify --mutate が検出する）。
- 複数の判定を組み合わせてよい（例: truthTable + componentCount）。
- アナログ量も見たいとき（分野 I: プルアップ抵抗に流れる電流など）は `"judge": ["dc", "digital"]` にできる。DC 解析ではゲート・DFF・LOGIC_IN は**無視**される（入力電流 0 の理想 CMOS 入力と同じ。ゲート出力は電圧源として扱われないので、ゲート出力ネットの dcVoltage は使えない）。DC で判定するのは R・SW・電源だけで決まるノード（例: プルアップ＋スイッチのノード電圧、R の電流）に限る。

---

## 3. 回答入力（questions）

```json
"questions": [
  { "key": "q1", "kind": "numeric", "prompt": "R1 を流れる電流は？", "unit": "A" },
  { "key": "q2", "kind": "choice", "prompt": "正しいのはどれ？", "options": ["A案", "B案", "C案"] }
],
"checks": [
  { "type": "numericAnswer", "key": "q1", "expected": 0.0125, "tolerancePct": 2, "unit": "A" },
  { "type": "multipleChoice", "key": "q2", "answerIndex": 1 }
],
"referenceAnswers": { "q1": 0.0125, "q2": 1 }
```
- `key` は問題内で一意。checks の numericAnswer / multipleChoice の `key` は必ず questions に存在すること（validation が確認）。
- `kind: "choice"` の `options` は2個以上。`answerIndex` は 0 始まりで options の範囲内。
- 回路の判定と回答を1問で併用してよい（例: 回路を組ませ、そのときの電流を数値で答えさせる）。

---

## 4. シミュレーションの前提（理想化）— 問題文の「条件」に書く

### 共通
- グラウンドは `gnd`（`"0"` も同じ）。
- TP（テストポイント）は電気的に何もしない理想プローブ（ノードに名前を付けて判定対象にするだけ）。
- **TP だけがつながったネット**（未配線の TP）は解析から除外し、警告にとどめる。回路の他の部分は普通に解ける。そのネットを参照した判定は「ノード X には部品がつながっていません（未接続）」で不合格。
- **未配線ピン**（UI では connect が `""`）は「どこにもつながらない端子」として扱う（グラウンドではない）。片側だけ配線した抵抗には電流が流れない。
- **グラウンドにつながらない部分回路**は全ノードの Gmin（1e-12 S）で解けるが、そのノードの電圧は意味がないので、参照した判定は「グラウンド（gnd）につながっていません」で不合格。
- I_DC / I_AC の向き: 値 I > 0 の電流が **p 端子（connect[0]）から外部回路へ流れ出し**、n 端子へ戻る（電池の + 端子と同じ向き）。`I_DC [out, gnd]` + 抵抗 R を out-gnd なら V(out) = +I·R。
- `judge` を配列にした場合、各解析が全部成功しないと判定できない。例えば V_PULSE は DC 解析では無視されるので、V_PULSE を使う回路に `"dc"` を混ぜない（過渡の最終値で判定する）。

### DC（judge: dc）
- C は開放、L は短絡（1mΩ）として定常状態を解く。
- SW: `closed: true` で 1mΩ、`false` で 1TΩ（理想スイッチ相当）。
- D / SD / LED: 順方向電圧 `Vf` の定電圧降下＋直列 1Ω（10mA で 10mV 増）、逆方向はオフ（1nS の漏れ）。条件欄には「ダイオードは順方向電圧 0.7V の定電圧モデル」のように書く。
- ZD: 逆方向は `Vz` で降伏（定電圧）、順方向は 0.7V。
- Q_NPN/Q_PNP: VBE 固定（`Vbe`、既定 0.7V）・IC = `beta`·IB（既定 100）・飽和 VCE = 0.2V の区分線形モデル。ベースに 10Ω の直列抵抗が入っている（IB = 25µA で 0.25mV。手計算との差は無視できる）。アーリー効果なし。C と E を逆につないだ場合も同じ β で動く（実物の逆方向 β の小ささは再現しない）。
- M_N/M_P（K>0）: 飽和領域 ID = ½·K·(VGS−|Vth|)²、線形領域は抵抗 1/(K·(VGS−|Vth|))（簡略モデル。境界で ID が2倍に跳ぶので、増幅の問題は飽和領域で余裕をもって設計する）。チャネル長変調なし。ゲート電流 0。**K の定義に注意**: ID = ½K·Vov²（K = μCox·W/L）。条件欄に式を書く。
- J_N: ID = IDSS·(1 − VGS/VGS(off))²（VGS > 0 は 0 に丸める。線形領域なし）。
- OPAMP: 出力 = `Aol`·(V+ − V−)（既定 1e5）。入力電流 0、出力抵抗 0、オフセットなし。出力は [下側レール + `Vdrop`, 上側レール − `Vdrop`] で頭打ち。上側レール = `v_plus` ピンを配線していればそのノード電圧、未配線（`""`）なら `Vpos`（既定 +15V）。下側も同様（`v_minus` / `Vneg` 既定 −15V）。電源ピンは電圧を見るだけで電流は流れない（出力電流は理想源から出る＝電源の消費電流・電力は判定に使えない）。**正帰還**（DC で Aol·β > 1。β = ∂(V+−V−)/∂Vout）の線形の平衡点は不安定とみなし、必ずどちらかのレールに振り切れる（+/− を取り違えた増幅器、コンパレータ、シュミットトリガ）。
- C は開放だが数値安定化のため 1e-3·C [S] の漏れがある（1µF で 1GΩ、100µF で 10MΩ、1mF で 1MΩ）。大きなバイパスコンデンサと小さな抵抗の並列では無視できる。
- V_AC は DC では 0V（短絡）、I_AC は 0A（開放）。V_PULSE は DC 解析の対象外（使わない）。

### 過渡（judge: transient）
- **t = 0 で電源が投入される**（それ以前の状態は考えない）。C の初期電圧は `params.initialV`（既定 0V、connect[0] 側が + ）、L の初期電流は `params.initialI`（既定 0A）。
- 数値積分: 台形則（各不連続点の直後2ステップは後退オイラー）。刻みは自動で「最小時定数/100、LC 周期/100、交流周期/100、パルス周期/100」以下。V_PULSE の角（立ち上がり・立ち下がり）では必ず刻みを合わせる。
- 解析終了時刻（自動）: max(10ms, 最大時定数×10, LC 周期×5, 交流周期×5, パルス1周期, checks の timeSec×1.5)。最大 50000 ステップ（超えると打ち切り、警告）。変えたいときは `simulation.tStop`。
- 対応部品: R, C, L, L_RELAY, V_DC, V_AC, V_PULSE, I_DC, I_AC, SW, TP, GND に加え、**非線形素子** D, SD, LED, ZD, TVS, Q_NPN, Q_PNP, M_N, M_P, J_N, OPAMP, PD, PT, U_OPTO, U_WILSON, U_CASCODE（DC と同じモデルを各時刻で反復して解く。接合容量・遅れ・スルーレート・逆回復は無い＝瞬時に応答）。SCR / TRIAC / DIAC は未対応（警告して無視）。
  - **BJT は過渡でも VBE 一定モデル**なので、小信号の gm = IC/VT（re）が入らない。エミッタ抵抗なしの CE 増幅は過渡では利得が正しく出ない（AC 解析で判定する）。RE ありでも re の分（数%）だけ利得が大きく出る。過渡で使うのは「飽和・遮断によるクリップ」「スイッチ動作」「出力振幅の上限」の判定。
  - MOSFET・JFET は平方則のままなので、過渡の波形振幅と AC の小信号利得が一致する（2乗の歪みも出る）。
  - OPAMP は Aol と頭打ちだけ（GBP は使わない）。積分器・微分器・クリップ・コンパレータ・シュミットトリガ・無安定マルチバイブレータが解ける。
  - 素子の状態（導通/遮断/飽和）が変わった直後の2ステップは後退オイラー。状態の切り替わる時刻は刻み単位でしか決まらないので、しきい値を測る問題は `simulation.dt` を小さくする。
- `simulation.initialCondition: "dc"`: t=0 の電源値（V_AC は Vpk·sin(phase)、V_PULSE は t=0 の値）で DC 動作点を求め、C の初期電圧・L の初期電流をその値にしてから始める（SPICE の既定と同じ）。結合・バイパスコンデンサのある増幅回路は、これを使うと最初から定常の波形になる（使わないと C の充電に数秒かかることがある）。
- SW は過渡中に切り替わらない（`closed` は固定）。「t=0 でスイッチを閉じる」は `closed: true` ＋ t=0 の電源投入で表現する。

### V_PULSE（パルス電圧源）のパラメータ（SPICE の PULSE と同じ意味）
| キー | 意味 | 既定 |
|---|---|---|
| `Vlow` | Low 電圧 [V] | 0 |
| `Vhigh` | High 電圧 [V] | 5 |
| `delaySec` | 最初の立ち上がり開始までの時間 [s] | 0 |
| `riseSec` | 立ち上がり時間 [s] | 1e-9 |
| `fallSec` | 立ち下がり時間 [s] | 1e-9 |
| `widthSec` | High を保つ時間（立ち上がり・立ち下がりを含まない）[s] | 0.001 |
| `periodSec` | 周期 [s]。0 なら繰り返さない（1発だけ） | 0.002 |

- 1つのステップ（t = t0 で 0→5V）として使うなら: `{"Vlow":0,"Vhigh":5,"delaySec":t0,"riseSec":1e-9,"widthSec":1,"periodSec":0}`。
- 方形波で充放電を繰り返すなら widthSec と (periodSec − widthSec) をそれぞれ 7τ 以上にすると各半周期で落ち着く。
- connect は `[p, n]`（p が +）。

### デジタル（judge: digital）— 問題文の「条件」に書く前提
- 論理値は 0 / 1 / X（不定）。電圧・電流・ファンアウト・消費電力は扱わない（理想論理素子）。
- 伝搬遅延は全ゲート共通の単位遅延で、判定は**入力を変えて回路が落ち着いた後**の値で行う。ハザード（ひげ）・遅延時間は扱わない。
- DFF / DFF_R は**クロックの立ち上がり（0→1）**で D を取り込む。セットアップ／ホールド時間は常に満たされる（判定は入力を確定させてからクロックを上げる）。同じクロックの DFF はすべて「エッジ直前の値」を取り込む（シフトレジスタが正しく動く）。
- 電源投入時、**DFF / DFF_R の Q は 0**（理想的なパワーオンリセット）。ゲートで組んだラッチ（NOR 2個の SR ラッチなど）の初期値は **X（不定）**。
- DFF_R の CLR は負論理の非同期クリア（74HC74 と同じ）。CLR=0 の間 Q=0 でクロックより優先。非同期クリアで N 進カウンタを作ると、実回路では一瞬 N が出る（グリッチ）が、判定は落ち着いた後の値なので現れない。
- **未接続の入力ピン**は浮き（X）。判定する出力に影響する範囲に浮いた入力があると不合格（「CMOS の入力は開放にしない」という実務の規則と同じ）。判定に関係ない置きっぱなしのゲートは無視。
- 出力どうし（ゲート出力・DFF 出力・LOGIC_IN・定数）を同じネットにつなぐと「衝突」で不合格。ワイヤード OR／オープンドレインは扱わない。
- 抵抗 R は弱い駆動（プルアップ／プルダウン）。強い駆動（ゲート出力、閉じた SW で gnd につながる等）が優先。SW は closed で理想短絡、開で切断。
- 帰還ループが落ち着かない（リング発振、SR ラッチで S=R=1 を同時に解除した場合など）ときは、揺れるネットを X とする。
- LED・C・ダイオードなどのアナログ部品は digital モードでは無視（警告）。ゲートの無いダイオードロジックだけは DC 解析で真理値表を作る。
- **扱えない題材**: 伝搬遅延の大きさ・最大動作周波数・セットアップ時間違反・メタステーブル・ハザードのタイミング、立ち下がりエッジの FF（Q_NOT をクロックに使う等で代用）、JK / T フリップフロップの専用部品（DFF＋ゲートで組む）、トライステート・バス、ワイヤード OR、ファンアウト／駆動電流、Schmitt 入力、ROM / RAM。

### AC（judge: ac）
- 線形の定常フェーザ解析。V_AC の `Vpk` はピーク値、`phaseDeg` は位相。V_DC と V_PULSE は短絡（0V）、I_DC は開放。
- 対応部品: R, C, L, L_RELAY, V_AC, I_AC, V_DC, V_PULSE, I_DC, SW, TP と、下の非線形素子（小信号モデル）。
- **非線形素子があると、先に DC 動作点を求めて線形化する**（SPICE の .AC と同じ。V_AC は 0V、V_PULSE は Vlow の直流）。熱電圧 **VT = 26mV**（`src/sim/dc.js` の `VT_THERMAL`。「re = 26mV / IE」の教科書値。300K の 25.85mV との差 0.6%）。
  - Q_NPN / Q_PNP（ハイブリッドπ）: 活性領域なら B-E 間に rπ = β/gm、C→E に gm·v_be、**gm = IC/VT**（β は DC の `beta` と同じ値）。ro = ∞（アーリー効果なし）。ベース直列抵抗なし。飽和なら C-E 短絡（利得ほぼ 0）、遮断なら開放。PNP も同じ式。
  - M_N / M_P: 飽和領域なら D→S に gm·v_gs、**gm = K·(VGS−|Vth|) = √(2K·ID)**、ro = ∞。線形領域は抵抗 1/(K·Vov)。
  - J_N: gm = 2·IDSS/|VGS(off)|·(1 − VGS/VGS(off))。
  - D 系: 導通・降伏中は 1Ω（DC モデルの直列抵抗）、オフは開放（rd = VT/ID ではない）。
  - OPAMP: 線形動作なら Vout = A(f)·(V+ − V−)、**A(f) = Aol / (1 + j·f·Aol/GBP)**（1次遅れ。既定 Aol=1e5, GBP=1MHz → 開ループの極 10Hz）。`GBP: 0` なら周波数特性なし（理想）。DC 動作点で飽和していれば出力はレールに固定され、利得は出ない。
  - 理想式（−Rf/Rin など）との差: ノイズゲイン NG = 1 + Rf/Rin（非反転利得）とすると、開ループの極より十分上（f ≫ GBP/Aol = 10Hz）では閉ループ利得 ≈ 理想値 / (1 + j·f·NG/GBP)。**大きさの誤差は 1/√(1+(f·NG/GBP)²)、位相の遅れは atan(f·NG/GBP)**。既定 GBP=1MHz・NG=11 で: 1kHz → −0.0005dB・−0.63°、10kHz → −0.05dB・−6.3°、91kHz（= GBP/NG）→ −3dB・−45°。利得だけ（±0.1dB）なら NG·f ≤ 0.15·GBP、位相も ±1° で見るなら NG·f ≤ 0.017·GBP にするか、`GBP: 0`（理想）にする。GBP の効果（閉ループ帯域 ≈ GBP/NG）を学ぶ問題では既定値のまま使う。DC の誤差は NG/Aol（NG=11 で 0.011%）。

---

## 5. 検証ツール tools/verify.mjs

```
node tools/verify.mjs [分野/ID接頭辞] [--mutate | --reverse | --drop] [--strict]
```
| モード | 内容 | NG の条件 |
|---|---|---|
| （なし） | 問題データの検証（validateProblem）、index.json とファイルの一致、参照解＋referenceAnswers が全判定に合格するか | 検証エラー / 不合格 |
| `--mutate` | 参照解の部品を1個ずつ「数値パラメータを2倍（0 は 1、真偽値は反転）」にした誤答、referenceAnswers を1つずつ誤答（数値×2、選択肢は別番号）にした誤答が不合格になるか。デジタル部品は「ゲートを同じ入力数の別種に差し替え」（入力の短絡・定数で同じ論理になる組み合わせは除外）と「DFF の Q と Q_NOT の取り違え」 | 合格する変種がある |
| `--reverse` | 極性部品を1つずつ逆向きにした誤答が不合格になるか。ゲートは入力 A と出力 Y、DFF は D と Q を入れ替えた誤答。OPAMP は + 入力と − 入力を入れ替えた誤答（正帰還で飽和するので利得判定で落ちる） | 合格する変種がある |
| `--drop` | 参照解の部品を1つずつ取り除いた誤答（部品忘れ・つなぎ忘れ）が不合格になるか | 合格する変種がある |
| `--strict` | hints が3つ無い、explanation が無い/不完全、を警告ではなく NG にする | |

- `--mutate` は OPAMP の `Aol` / `GBP` / `Vpos` / `Vneg` / `Vdrop` と、平方則 MOSFET（K>0）の `RdsOn` を2倍にしない（設計値ではないモデル定数。2倍にしても結果が変わらないのが正しい）。BJT の `beta` は2倍にする（β に依存しないバイアス設計を学ぶ問題では合格してしまうので、その理由を `verifyNote` に書く）。
- `verifyNote` がある問題は mutate/reverse/drop の「甘い判定」を警告扱いにし、終了コードに含めない。
- 新しい問題はコミット前に4モードすべて（`--strict` 付き）で確認する。
- `--problems=DIR` で問題フォルダを差し替えられる（テスト用）。
- 判定・シミュレータ自体の単体テスト: `node tools/test_checks.mjs`（手計算で答えが分かる回路。デジタルは半加算器・全加算器・MUX・デコーダ・NAND だけの XOR・DFF 分周・カウンタ・シフトレジスタ・SR/D ラッチなど）。

### 判定の甘さを防ぐコツ
- 値だけでなく **回路の形** を判定する: 「出力電圧」と「どこかの部品の電流」を両方見ると、部品を外した誤答・別の場所に付けた誤答が落ちる。
- 極性部品は `connection` を `pins` 形式で書く（`nets` は向きを見ない）。
- 比だけで決まる問題（分圧比など）は R1・R2 を同時に2倍にしても合格するが、verify は1部品ずつ変えるので通常は検出できる。それでも合格してしまう場合は、電流や電力の判定を足すか、理由を `verifyNote` に書く。
- `timeConstant` は `node` 指定にする（R_th 法だけだと電源を外した回路でも通ってしまう）。

---

## 6. 分野C（増幅回路）— problem-writer 向けの要点

### 何で何を判定するか
| 確かめたいこと | 判定 | judge |
|---|---|---|
| バイアス（動作点）: VC・VE・IC、活性／飽和 | `dcVoltage` / `dcCurrent`（`match` で Q・R を特定）＋ `operatingRegion` | dc（ac だけでも operatingRegion は可） |
| 電圧利得と反転 | `bodePoint`（`gainDB` と `phaseDeg: 180`）または `acGaindB` | ac |
| 入力・出力インピーダンス | `acImpedance`（入力は信号源を `exclude`、出力は負荷を `exclude`） | ac |
| 結合・バイパスコンデンサによる低域遮断 | `bodePoint`（fc で中域 −3dB、位相） | ac |
| 差動利得 | `acGaindB` / `bodePoint` に `inputRef`（差動入力）、`outputRef`（差動出力） | ac |
| 同相利得・CMRR | 同じ回路で `sources: { "V2": { "phaseDeg": 0 } }`（2つ目の信号源を同相に置き換え） | ac |
| GBW（利得帯域幅積）と閉ループ帯域 | OPAMP の `GBP` を既定（1MHz）のまま `bodePoint` | ac |
| 出力振幅の上限・クリップ、クロスオーバひずみ | `transientMeasure`（`max` / `min` / `pp`、`fromSec` 必須） | transient |
| 積分器（方形波→三角波）、微分器 | `transientPoint` / `transientMeasure`、または AC の `bodePoint`（±90°） | transient / ac |
| 加算・差動（4抵抗）の直流演算 | `dcVoltage` | dc |
- DC と AC を1問で見るときは `"judge": ["dc", "ac"]`（V_AC は DC では 0V の短絡として扱われる）。
- **信号源は固定部品**の V_AC にし、入力ノード（`vin`）と出力ノード（`out`、TP を置く）を固定する。`sources` と `exclude` に書く部品は固定部品であること（プレイヤーが置く部品は ID が変わる。validation が確認）。
- 結合コンデンサ・バイパスコンデンサはリアクタンスが中域で十分小さくなる値にし、判定周波数を中域に置く（例: 10µF・10kHz で 1.6Ω）。バイパスコンデンサは re（数Ω〜数十Ω）より十分小さく: 100µF なら 10kHz で 0.16Ω。
- 小信号の振幅（V_AC の Vpk）は AC 解析の利得に影響しない（線形化）。過渡で波形を見るときだけ、BJT なら Vpk ≲ 10mV（vbe ≪ VT）、ひずみ・クリップを見せたいときは大きくする。

### 部品の理想化の前提（条件欄に書く）
- **BJT**: 「VBE = 0.7V、hFE = hfe = β（`beta`）、熱電圧 VT = 26mV（gm = IC/VT, rπ = β/gm, re = VT/IE）、アーリー効果なし（ro = ∞）、接合容量なし」。DC は VBE 一定、AC はハイブリッドπ。DC の IC と AC の gm は同じ動作点から計算される。
- **MOSFET**: 「飽和領域で ID = ½K(VGS − Vth)²、gm = K(VGS − Vth) = √(2K·ID)、チャネル長変調なし、ゲート電流 0」。K の定義（½ が付く方）を必ず書く。
- **JFET**: 「ID = IDSS(1 − VGS/VGS(off))²、gm = 2IDSS/|VGS(off)|·(1 − VGS/VGS(off))」。
- **オペアンプ**: 「入力電流 0、出力抵抗 0、オフセットなし、開ループ利得 Aol = 10⁵、出力は電源電圧（− Vdrop）で飽和」。周波数特性を使う問題は「GBW = 1MHz の1次遅れ（単一極）」、使わない問題は固定部品で `GBP: 0` にして「周波数特性は考えない」と書く（§4 AC の誤差の目安を参照）。スルーレートはない。
- **電源ピン**: OPAMP の `v_plus` / `v_minus` を電源につなぐとそのノード電圧で飽和する（単電源回路が作れる）。未配線（`""`）なら `Vpos` / `Vneg`。電源電流は流れないので、オペアンプの消費電力は判定できない。
- **過渡の BJT** は VBE 一定モデル（re が入らない）。過渡で増幅率を採点しない（AC で採点）。過渡はクリップ・振幅上限・プッシュプルのクロスオーバ（±0.7V の不感帯）向け。
- OPAMP は固定部品で置くのを推奨（プレイヤーが置く場合も verify は Aol 等を2倍にしないので問題ない）。+/− の取り違えは verify --reverse が検出する（正帰還で飽和して不合格になる）。

### 扱えない題材（作らない）
- アーリー効果・ro が効く回路: 能動負荷（カレントミラー負荷の差動対、固有利得 gm·ro）、カスコードの出力抵抗、ro を含む Zout。理想電流源負荷は利得が無限大になる。
- トランジスタの高域特性（接合容量 Cπ・Cμ、ミラー効果、fT）。ミラー効果を扱うなら「B-C 間に外付けの C」を明示した回路にする（外付け C は普通に解ける）。
- スルーレート、オペアンプの入力オフセット・バイアス電流・CMRR そのもの（理想差動入力）、出力電流制限、雑音、温度ドリフト（VBE の温度係数は数値回答なら可）。
- ひずみ率（THD）の数値（FFT の判定はない）。発振の起動・振幅制限（分野D）。
- 過渡での BJT の小信号利得、h パラメータの hre・hoe。

### 20問の候補（易 → 難。現エンジンで無理なく作れるもの）
| # | トピック | 主な判定 |
|---|---|---|
| 1 | 固定バイアス: RB を選んで VCE を電源の半分に（活性領域） | dcVoltage(コレクタ), operatingRegion |
| 2 | 飽和させないコレクタ抵抗の上限（RC を大きくしすぎると飽和） | operatingRegion, dcVoltage |
| 3 | 分圧バイアス＋エミッタ抵抗の設計（IC = 1mA, VE ≈ 1V） | dcVoltage(e), dcCurrent(match RC), operatingRegion |
| 4 | β が2倍になっても IC がほぼ変わらないバイアス（固定バイアスとの比較） | dcCurrent ＋ numericAnswer（verifyNote: β は設計値でない） |
| 5 | 小信号パラメータ gm・rπ・re を動作点から求める | numericAnswer（補助。回路はバイアスのみ） |
| 6 | 共通エミッタ増幅（RE をバイパス）: 利得 −gm·RC と位相反転 | bodePoint(gain, 180°) |
| 7 | 負荷 RL をつなぐと利得が下がる: −gm(RC∥RL)、RC の選び方 | bodePoint |
| 8 | RE をバイパスしない（電流帰還）: 利得 −RC/(re+RE) で安定 | acGaindB, bodePoint |
| 9 | 入力インピーダンス R1∥R2∥rπ と信号源抵抗による利得の損失 | acImpedance(exclude 信号源), acGaindB(src→out) |
| 10 | 結合コンデンサの最小値（fc = 1/(2π(RS+Zin)C) を 100Hz 以下に） | bodePoint(fc で −3dB 以内) |
| 11 | エミッタフォロワ: 利得 ≈ 1、出力インピーダンスが小さいバッファ | acGaindB, acImpedance(exclude RL) |
| 12 | MOSFET ソース接地のバイアス（飽和領域で ID を設定） | dcCurrent, operatingRegion(saturation) |
| 13 | MOSFET ソース接地の利得 gm = √(2K·ID) | bodePoint |
| 14 | オペアンプ反転増幅: −Rf/Rin と入力インピーダンス = Rin | bodePoint(180°), acImpedance |
| 15 | 非反転増幅・ボルテージフォロワ: 1+Rf/Rin、高入力インピーダンスのバッファ | bodePoint(0°), dcVoltage |
| 16 | 加算増幅（オーディオミキサ）: 重み付き和 | dcVoltage（2電源）または acVoltage |
| 17 | 出力の飽和: 電源 ±12V（Vdrop あり）で出力振幅の上限、単電源の制約 | transientMeasure(max/min/pp) |
| 18 | 4抵抗の差動増幅と同相除去（抵抗の整合が崩れると同相出力が出る） | acGaindB(inputRef), acVoltage(sources で同相) |
| 19 | BJT 差動対: 差動利得 gm·RC/2、同相利得、テール抵抗と CMRR | bodePoint(inputRef), bodePoint(sources) |
| 20 | GBW と帯域: 利得 40dB を1段で作ると帯域が足りない → 2段に分ける | bodePoint（GBP=1MHz で 20kHz の利得） |
- 予備: 積分器（方形波→三角波、DC 帰還抵抗が無いと飽和する）、プッシュプル出力段のクロスオーバひずみ（過渡の max が Vpk − 0.7V）、ダイオードでバイアスした AB 級、負帰還で Aol のばらつきが消える（verifyNote が必要）、コンパレータとシュミットトリガ（過渡、しきい値は `simulation.dt` を小さく）。
