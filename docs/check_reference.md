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
| `simulation` | オブジェクト | | 解析設定。`tStop`（過渡の終了時刻 s）、`dt`（最大刻み s）、`frequencies`（AC 解析周波数の配列 Hz）、`initialCondition`（過渡の初期状態: `"zero"` 既定 / `"dc"` = DC 動作点から開始）、`diodeRs`（params.Rs を書いていない D/SD/LED/ZD/TVS の直列抵抗 Ω。既定 1Ω。分野F/J の理想ダイオード用、§7）、`dtFixed`（過渡の刻みを自動ではなくこの値に固定 s。分野D の発振回路用、§8）。省略時は自動（§4, §5） |
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
- **`toSec` を書くと**区間 [`fromSec`, `toSec`] の平均値の上向き交差から測る（`transientMeasure` の `frequency` と同じ。持続発振・分野D はこちら）。`expectedMin` / `expectedMax` で範囲判定もできる（§8）。
  `{ "type": "oscillationFrequency", "node": "out", "fromSec": 0.02, "toSec": 0.03, "expected": 1591.5, "tolerancePct": 3 }`

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

### loopGain（judge: ac）— バルクハウゼン条件（分野D）
```json
{ "type": "loopGain", "input": "vin", "output": "fb", "fMinHz": 100, "fMaxHz": 100000,
  "expectedFrequencyHz": 1591.5, "tolerancePct": 2, "gainMin": 1.0, "gainMax": 1.2 }
```
- 帰還ループを 1 か所で切った回路（切った先に固定の V_AC を `input` ノードに、戻ってきた点に TP を `output` ノードに置く）で、一巡伝達 T = V(output)/V(input) の位相が `phaseDeg`（既定 0°。360° の倍数は同じとみなす）を横切る周波数を、`fMinHz`〜`fMaxHz` の対数掃引（100 点/ディケード＋L と C の組の共振周波数の前後）と二分法で求める。
- その周波数を `expectedFrequencyHz`（`tolerancePct` / `toleranceAbs`）と、そこでの |T|（線形値）を `gainMin` / `gainMax`、または `gainDB`（`gainToleranceDB`、既定 0.1dB）で判定。どれか 1 つ以上が必要。
- 位相 0° の点が無ければ「位相条件を満たさないので発振しません」で不合格。複数あれば `expectedFrequencyHz` に最も近いもの（無ければ |T| が最大のもの）。`inputRef` / `outputRef`（差動）も使える。
- 「発振が持続する」= |T| ≥ 1、「ひずみの少ない発振」= |T| が 1 をわずかに超える（例 1.0〜1.2）。ループの切り方は §8。

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
  - SCR / TRIAC / DIAC: `on`（主端子が導通）/ `off`。SW_V: `on`（閉）/ `off`（開）
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
- **追加の measure（分野F/J）**:
  - `duty`: 区間のうち値が `threshold`（V または A。省略時は区間の (最大+最小)/2）を超えている時間の割合（0〜1）。しきい値を横切る時刻は線形補間。PWM のデューティ比、整流の導通角（ダイオード電流 > 0 の割合）など。`toleranceAbs`（例 0.01）で判定する。
  - `power`: `element`（または `match`）の平均電力 = v·i の時間平均（v = connect[0]−connect[1]、i は connect[0]→connect[1]）。既定は絶対値、`signed: true` で「吸収が正」（電源は供給中なら負）。単位 W。
  - `powerFactor`: `element` の力率 = |平均電力| / (電圧の実効値 × 電流の実効値)。電源（V_AC）に使うと負荷全体の力率、ひずみ電流（整流＋コンデンサ入力）の力率も出る。
  ```json
  { "type": "transientMeasure", "node": "sw", "measure": "duty", "threshold": 6, "fromSec": 0.004, "toSec": 0.005, "expected": 0.4, "toleranceAbs": 0.01 }
  { "type": "transientMeasure", "element": "D1", "measure": "power", "fromSec": 0.004, "toSec": 0.005, "expected": 0.27, "tolerancePct": 3 }
  { "type": "transientMeasure", "element": "V1", "measure": "powerFactor", "fromSec": 0.06, "toSec": 0.1, "expected": 0.728, "tolerancePct": 2 }
  ```
- **追加の measure（分野D/E、§8）**:
  - `frequency` / `period`: 区間の時間平均を基準にした上向き交差（振幅の 10% のヒステリシスつき）の数と間隔から求めた周波数（Hz）/ 周期（s）。正弦波・方形波・のこぎり波どれでもよく、区間は周期の整数倍でなくてよい。交差が 2 回未満なら「振動していません」で不合格。
  - `tone`: `frequencyHz` の正弦波成分のピーク振幅（V）。区間の DFT（台形則の積分）。**区間を、波形に含まれるすべての成分の周期の整数倍にする**（例: fc = 10kHz, fm = 500Hz なら 2ms の整数倍）と漏れが 0 になる。整数倍にできないときは `"window": "hann"`（周波数が 2/(区間) 以上離れた成分の漏れ ≤ 1%）。
  - `modulationIndex`: AM 波の変調度 m = (Emax − Emin)/(Emax + Emin)（区間の平均を引いた波形の正のピークを包絡線とする）。区間は変調周期の整数倍、fc/fm ≥ 20 で誤差 ≤ 1.2%。過変調（m > 1）は 1 と測られる。
- **範囲判定** `expectedMin` / `expectedMax`（片方だけでも可。`expected` と併用すると両方を満たすときだけ合格）: 「発振している＝振幅が 1V 以上」「22kHz の成分が 0.15V 以下」のような条件。
  ```json
  { "type": "transientMeasure", "node": "out", "measure": "pp", "fromSec": 0.02, "toSec": 0.03, "expectedMin": 1 }
  { "type": "transientMeasure", "node": "if", "measure": "tone", "frequencyHz": 2000, "fromSec": 0.001, "toSec": 0.002, "expected": 0.464, "tolerancePct": 3 }
  ```

### efficiency（judge: transient）— 効率
```json
{ "type": "efficiency", "inputs": ["V1"], "outputs": ["RL"], "fromSec": 0.008, "toSec": 0.009, "expected": 0.94, "toleranceAbs": 0.01 }
{ "type": "efficiency", "inputs": ["V1"], "outputs": [{ "type": "R", "nets": ["out", "gnd"] }], "fromSec": 0.008, "toSec": 0.009, "expected": 0.94, "toleranceAbs": 0.01 }
```
- η = Σ|outputs の部品の平均電力| / Σ|inputs の部品の平均電力|（各部品の v·i を区間で時間平均した値の絶対値）。`expected` は 0〜1 の比。
- `inputs` / `outputs` は部品 ID（**固定部品**を推奨。プレイヤーの部品は ID が変わる）または `match` オブジェクト（該当する部品すべての和）の配列。
- 区間はスイッチング周期・交流周期の**整数倍**にする（端数があると C・L のエネルギー変化が入る）。`fromSec` は定常に達した後。
- 不合格のメッセージに入力電力と出力電力が出る。

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
- 数値積分: 台形則（各不連続点の直後2ステップは後退オイラー）。刻みは自動で「最小時定数/100、LC 周期/100、交流周期/100（切り替わる素子＝D 系・サイリスタ系・SW_V があれば /400）、パルス周期/100、パルス幅/10、パルスの Low の時間/10」以下。V_PULSE の角（立ち上がり・立ち下がり）では必ず刻みを合わせる。切り替わる素子の状態が刻みの途中で変わったら、その刻みを最大 1/64 まで二分して切り替わり時刻を求める（§7）。
- 解析終了時刻（自動）: max(10ms, 最大時定数×10, LC 周期×5, 交流周期×5, パルス1周期, checks の timeSec×1.5)。最大 200000 ステップ（超えると打ち切り、警告）。変えたいときは `simulation.tStop`。**問題は 50000 ステップ以下を目安に**（1 ステップ約 10µs。ブラウザで 1 秒以内）。ステップ数 ≈ tStop / 刻み。
- 対応部品: R, C, L, L_RELAY, XFMR, V_DC, V_AC, V_PULSE, I_DC, I_AC, SW, SW_V, TP, GND に加え、**非線形素子** D, SD, LED, ZD, TVS, Q_NPN, Q_PNP, M_N, M_P, J_N, OPAMP, PD, PT, U_OPTO, U_WILSON, U_CASCODE, SCR, TRIAC, DIAC（DC と同じモデルを各時刻で反復して解く。接合容量・遅れ・スルーレート・逆回復は無い＝瞬時に応答）。サイリスタ系・SW_V・XFMR の前提は §7。
  - **BJT は過渡でも VBE 一定モデル**なので、小信号の gm = IC/VT（re）が入らない。エミッタ抵抗なしの CE 増幅は過渡では利得が正しく出ない（AC 解析で判定する）。RE ありでも re の分（数%）だけ利得が大きく出る。過渡で使うのは「飽和・遮断によるクリップ」「スイッチ動作」「出力振幅の上限」の判定。
  - MOSFET・JFET は平方則のままなので、過渡の波形振幅と AC の小信号利得が一致する（2乗の歪みも出る）。
  - OPAMP は Aol と頭打ちだけ（GBP は使わない）。積分器・微分器・クリップ・コンパレータ・シュミットトリガ・無安定マルチバイブレータが解ける。
  - 素子の状態（導通/遮断/飽和）が変わった直後の2ステップは後退オイラー。D 系・サイリスタ系・SW_V・論理ゲート・DFF と、OPAMP の飽和⇔線形の切り替わりは刻みを最大 1/64 まで二分して時刻を求める（弛張発振の周期誤差 0.1% 程度）。それ以外の素子の切り替わりは刻み単位なので、しきい値を測る問題は `simulation.dt` を小さくする。
  - 分野D/E の部品（V_AM / V_FM / V_VCO / MULT / XTAL、過渡解析の論理ゲート・DFF）の前提は §8。
- `simulation.dtFixed`: 自動の刻み（最小時定数/100 など）を使わず固定の刻みにする。発振に関係しない速いモード（L に並列の抵抗による L/R など）で刻みが不必要に細かくなる発振回路用。台形則は安定なので発散はしないが、振動周期の 1/100 以下にすること。
- `simulation.initialCondition: "dc"`: t=0 の電源値（V_AC は Vpk·sin(phase)、V_PULSE は t=0 の値）で DC 動作点を求め、C の初期電圧・L の初期電流をその値にしてから始める（SPICE の既定と同じ）。結合・バイパスコンデンサのある増幅回路は、これを使うと最初から定常の波形になる（使わないと C の充電に数秒かかることがある）。**params に `initialV` / `initialI` を明示した C / L（XTAL も）はその値を優先する**（SPICE の .IC と同じ。発振回路をバイアス点から始め、タンクの L に初期電流を与えて起動する）。
- SW は過渡中に切り替わらない（`closed` は固定）。「t=0 でスイッチを閉じる」は `closed: true` ＋ t=0 の電源投入で表現する。途中で開閉させたいときは電圧制御スイッチ `SW_V` を V_PULSE で駆動する（§7）。

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
- 判定・シミュレータ自体の単体テスト: `node tools/test_checks.mjs`（手計算で答えが分かる回路。デジタルは半加算器・全加算器・MUX・デコーダ・NAND だけの XOR・DFF 分周・カウンタ・シフトレジスタ・SR/D ラッチなど。分野F/J は半波整流の平均 Vm/π、ブリッジ＋C のリプル、降圧・昇圧・昇降圧・DCM の出力電圧、フルブリッジ、SCR・TRIAC の位相制御、クローバ、トランス、効率・力率）。
- `--mutate` はダイオード系の `Rs`、SCR/TRIAC/DIAC の `Vgk`/`Vgt`/`Vt`/`Ih`/`Rs`/`dV`、SW_V の `Ron`/`Roff`/`Vth`、XFMR の `coupling` を2倍にしない（モデル定数）。SW_V の `invert` は反転する。
- `--reverse` は SW_V の制御端子 ctrl_p と ctrl_n を入れ替えた誤答を作る（制御が反転してスイッチが閉じない）。XFMR の逆向きは一次と二次の入れ替え（巻数比が逆になる）。
- 分野D/E: `--mutate` は V_VCO の `fMaxHz`、過渡の論理ゲート・DFF の `VOH` / `Vth` / `Rout` を2倍にしない（モデル定数）。XTAL・MULT の `k`・V_AM / V_FM / V_VCO の他のパラメータは2倍にする。`--reverse` は V_VCO の制御端子 ctrl_p と ctrl_n、MULT の入力 x と出力 out を入れ替える。XTAL・V_AM・V_FM は無極性（対象外）。
- test_checks.mjs の分野D/E: LC タンクの 1/(2π√LC)、ウィーン（ダイオード振幅安定化）、移相 1/(2πRC√6)、シュミット弛張 2RC·ln3、CMOS インバータ無安定 2RC·ln3、シュミットインバータ 2RC·ln1.5、555 相当 ln2·(RA+2RB)C、MOSFET コルピッツ、XTAL の |Z(fs)|・fs/fp・ピアース、loopGain（ウィーン 3.2/3、移相 Rf/R=29）、VCO、PLL（÷1・÷2）、DFF 分周、AM の側帯波と変調度、FM のベッセル係数、ミキサの和差・イメージ、DSB-SC 同期検波、BPSK/ASK、包絡線検波とダイアゴナルクリッピング、FSK、verify D/E の4モード。

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

---

## 7. 分野F（電源回路）・J（パワーエレクトロニクス）— problem-writer 向けの要点

### 部品と理想化の前提（問題文の「条件」に書く）
| 部品 | ピン（connect の順） | モデル | 条件欄の書き方の例 |
|---|---|---|---|
| D / SD | anode, cathode | Vf 一定＋直列 `Rs`（既定 1Ω）。逆方向は 1nS の漏れ。逆回復・接合容量なし | 「ダイオードは順方向電圧 0.7V 一定（抵抗は無視）、逆方向には流れない」 |
| 理想ダイオード | 同上 | `params: { "Vf": 0 }` ＋ 問題の `"simulation": { "diodeRs": 0.001 }` | 「ダイオードは理想（順方向電圧 0、逆方向は流れない）」 |
| ZD / TVS | anode, cathode | 降伏 Vz（Vclamp）一定＋`Rs`、順方向 0.7V | 「ツェナー電圧 5.1V 一定」 |
| **SW_V**（電圧制御スイッチ） | 1, 2, ctrl_p, ctrl_n | 制御電圧 V(ctrl_p)−V(ctrl_n) > `Vth`（既定 2.5V）で 1−2 間が `Ron`（既定 10mΩ）、それ以外 `Roff`（既定 1GΩ）。`invert: true` で逆（Vth 未満で閉）。切り替えは瞬時、制御端子に電流は流れない。双方向に流れる | 「スイッチ S は理想スイッチ（オン抵抗 0、切り替え時間 0）で、PWM 信号が High の間だけ閉じる」 |
| M_N（`K: 0`） | drain, gate, source | V_GS > Vth で `RdsOn` の抵抗、それ以外オフ（ボディダイオードなし）。ゲートは電圧を見るだけ | ハイサイドはゲート駆動の V_PULSE を source 基準（`[g, sw]`）につなぐ |
| SCR | anode, gate, cathode | G-K 間は `Vgk` のダイオード。ゲート電流が流れていて V_AK ≥ `Vt`（オン電圧、既定 1V）なら点弧し、A-K 間 = `Vt`＋0.01Ω。点弧後はゲート電流が無くても電流 ≥ `Ih`（保持電流、既定 5mA）の間は導通（ラッチ）、下回るとオフ。逆方向は阻止 | 「SCR はゲートに電流を流すと導通し、電流が 0 になるまで導通を続ける（オン電圧 0V）」→ `Vt: 0` |
| TRIAC | mt2, gate, mt1 | ゲート−MT1 間 ±`Vgt`。**どちらの向きのゲート電流でも**点弧（4 象限同じ感度）。主端子は両方向に SCR と同じ | 正のゲートパルスを半周期ごと（periodSec = T/2）に入れればよい |
| DIAC | mt1, mt2 | \|V\| ≥ `Vbo` で導通し、端子電圧が ±(Vbo − `dV`) に下がる（ブレークバック、既定 dV = 5V）。電流 < `Ih` でオフ | 「DIAC は 30V で導通し、導通中は 25V」 |
| XFMR | p1, p2, s1, s2 | 理想トランス（過渡解析）。`turnsRatio` = Np/Ns、V(s1)−V(s2) = (V(p1)−V(p2))/turnsRatio、p1 と s1 が同極性（ドット）。`Lm` > 0 で一次に並列の励磁インダクタンス（フライバック用、初期電流 `LmInitialI`。波形は `"<id>#Lm"` の element で見られる）。漏れインダクタンス・巻線抵抗・飽和なし。`coupling` は使わない。DC 解析では各巻線が短絡、**AC 解析は未対応** | 「トランスは理想（巻数比 10:1、損失なし）」 |
| L_RELAY | 1, 2 | ただのインダクタ（接点は無い） | |
- SCR / TRIAC / DIAC の element の `v` / `i` は主端子（anode−cathode、MT2−MT1、MT1−MT2）の電圧と電流（`dcCurrent`・`transientMeasure` で使える）。ゲート電流は判定できない。
- XFMR の element の波形: `v`/`i` = 一次側（i は p1 から流れ込む向き）、`v2`/`i2` = 二次側（transientMeasure の quantity は v/i だけなので、二次は TP を置いたノードで測る）。センタタップは XFMR を2個（一次を並列）で作る。
- **プレイヤーが置いた部品の ID**: SW_V は `SWV1`, `SWV2` …、SCR/TRIAC/DIAC/XFMR はそれぞれの規則。判定は `match`（例 `{ "type": "SW_V", "pins": { "1": "vin", "2": "sw" } }`）で書く。
- **SW_V の記号**: UI にはまだ専用の記号が無い（汎用の4ピン枠で表示される）。UI 担当に記号の追加を依頼済み。

### 刻み・解析時間・定常状態
- 切り替わる素子（D 系・SCR/TRIAC/DIAC・SW_V）があると、刻みは交流周期の 1/400 以下、PWM 周期の 1/100 以下・パルス幅と Low 時間の 1/10 以下。素子の状態が刻みの途中で変わったら刻みを最大 1/64 まで二分して切り替わり時刻を求める（整流の導通開始、DCM の電流ゼロ、SCR の消弧）。V_PULSE の角では必ず刻みを合わせる。
- **ステップ数 ≈ tStop / 刻み を 50000 以下に**（1 ステップ約 10µs、ブラウザで 1 秒以内）。例: 50Hz の整流で tStop = 0.2s → 4000 点。20kHz の PWM（周期 50µs → 刻み 0.5µs）で tStop = 10ms → 20000 点。100kHz の PWM は 10ms で 10 万点になるので避ける（**10〜50kHz を推奨**）。
- **コンバータは定常に入るまで時間がかかる**（出力 LC の減衰。降圧なら包絡線の時定数 ≈ 2RC、昇圧はさらに遅い）。次のどちらかにする:
  1. 出力の C と L を**固定部品**にして初期値を定常の値にする: C の `initialV` = 理論の Vout、L の `initialI` = 平均電流 − ΔI/2（オン期間の始まりの値）。これで数 ms で定常になる（テストでは 8×2RC で 0.5% 以内）。
  2. `simulation.tStop` を 2RC の 8 倍以上にする（ステップ数に注意）。
- `fromSec`〜`toSec` は**周期の整数倍**（PWM なら 20 周期程度、50Hz なら 5 周期 = 0.1s）。`fromSec` は定常に入った後。
- `initialCondition: "dc"` はコンバータでは役に立たない（DC 解析では V_PULSE が t=0 の値に固定され、L が短絡されるため）。整流回路は C が最初のピークで充電されるので不要（`fromSec` を 3〜5 周期後にする）。

### 何で何を判定するか
| 確かめたいこと | 判定 | 例 |
|---|---|---|
| 整流・コンバータの出力電圧（平均） | `transientMeasure` `average` | 半波 Vm/π、ブリッジ＋C ≈ Vm − 2Vf − ΔV/2、降圧 D·Vin |
| リプル電圧 | `transientMeasure` `pp`（または `acRms`） | ΔV ≈ I/(2fC)（全波）、ΔI/(8fC)（降圧） |
| インダクタ電流のリプル・平均 | `transientMeasure` に `match: {type:"L"}` ＋ `quantity: "i"`、`pp` / `average` | ΔI = (Vin−Vout)·D·T/L |
| 連続（CCM）／不連続（DCM） | L 電流の `min`（`signed: true`）: DCM なら 0、CCM なら > 0 | |
| デューティ比・導通角 | `duty`（スイッチ節点の電圧、または素子電流に `threshold`） | PWM のデューティ、ダイオードの導通時間の割合 |
| 効率・損失 | `efficiency`（inputs: 電源、outputs: 負荷）、`power`（損失を出す部品） | ダイオードの導通損失 (1−D)·Vf·Io |
| 力率 | `transientMeasure` `powerFactor`（element: V_AC） | コンデンサ入力型整流 ≈ 0.45、L を入れると改善（受動 PFC） |
| 突入電流 | 電源の電流の `max`（`fromSec: 0`） | 電源投入時の平滑 C の充電電流、直列 R（NTC の代わり）で制限 |
| SCR・TRIAC の位相制御 | `average`（SCR）/ `rms`（TRIAC）の出力電圧 | Vavg = Vm/(2π)·(1+cos α)、Vrms = (Vm/√2)·√(1 − α/π + sin2α/(2π))（`Vt: 0` のとき） |
| クローバ・過電圧保護 | DC の `operatingRegion`（SCR: `on`）＋`dcVoltage`、または過渡（電源を V_PULSE で上げる） | 点弧後は電源を下げても保持される |
| リニアレギュレータ・ドロップアウト | DC の `dcVoltage` ＋ `operatingRegion`（OPAMP `linear` / `satHigh`、Q_NPN `active`） | Vout = Vref(1+R1/R2)、ドロップアウトで Vout = Vin − VBE |
| ツェナーシャントレギュレータ・電流制限（BJT） | DC の `dcVoltage` / `dcCurrent` | |
| インバータ出力 | 差動 `nodeRef` で `rms` / `acRms`、負荷電流の `max` | フルブリッジ: 方形波の実効値 = Vdc、RL 負荷のピーク (Vdc/R)·tanh(T/4τ) |
- PWM の駆動は V_PULSE（`widthSec` = D·T、`periodSec` = T、`riseSec`/`fallSec` = 1e-9）。相補駆動はスイッチの `invert: true` か、2 つ目の V_PULSE（デッドタイムを入れる場合は delaySec と widthSec で隙間を作り、還流用の D を明示的に置く）。
- 三角波（PWM 比較器のキャリア）は V_PULSE の `riseSec` = `fallSec` = T/2、`widthSec` = 0。OPAMP をコンパレータにして SW_V を駆動できる。
- SCR のゲートパルスは「V_PULSE（[gp, cathode]）＋ゲート抵抗」。`delaySec` = α/360·T、`widthSec` = 0.2ms 程度、`periodSec` = T（TRIAC は T/2）。
- 直流モータは「R＋L＋逆起電力（V_DC）」の直列で表す（機械系は無い）。

### JSON の例（降圧コンバータを組む問題）
```json
"judge": "transient",
"simulation": { "tStop": 0.009, "diodeRs": 0.001 },
"availableComponents": ["SW_V", "D", "L"],
"fixedComponents": [
  { "id": "V1", "type": "V_DC", "params": { "V": 12 }, "connect": ["vin", "gnd"], "locked": true },
  { "id": "VG", "type": "V_PULSE", "params": { "Vlow": 0, "Vhigh": 5, "riseSec": 1e-9, "fallSec": 1e-9, "widthSec": 2e-5, "periodSec": 5e-5 }, "connect": ["g", "gnd"], "locked": true },
  { "id": "C1", "type": "C", "params": { "C": 1e-4, "initialV": 4.8 }, "connect": ["out", "gnd"], "locked": true },
  { "id": "RL", "type": "R", "params": { "R": 5 }, "connect": ["out", "gnd"], "locked": true },
  { "id": "TPO", "type": "TP", "connect": ["out"], "locked": true },
  { "id": "TPS", "type": "TP", "connect": ["sw"], "locked": true }
],
"checks": [
  { "type": "transientMeasure", "node": "out", "measure": "average", "fromSec": 0.008, "toSec": 0.009, "expected": 4.8, "tolerancePct": 2 },
  { "type": "transientMeasure", "match": { "type": "L" }, "quantity": "i", "measure": "pp", "fromSec": 0.008, "toSec": 0.009, "expected": 0.288, "tolerancePct": 5 },
  { "type": "connection", "match": { "type": "D" }, "pins": { "anode": "gnd", "cathode": "sw" } },
  { "type": "efficiency", "inputs": ["V1"], "outputs": ["RL"], "fromSec": 0.008, "toSec": 0.009, "expected": 1.0, "toleranceAbs": 0.01 }
],
"referenceSolution": [
  { "id": "SWV1", "type": "SW_V", "params": {}, "connect": ["vin", "sw", "g", "gnd"] },
  { "id": "D1", "type": "D", "params": { "Vf": 0 }, "connect": ["gnd", "sw"] },
  { "id": "L1", "type": "L", "params": { "L": 5e-4 }, "connect": ["sw", "out"] }
]
```
- プレイヤーが置く L には `initialI` を入れられない（UI に無い）ので、L をプレイヤーが置く問題は C の `initialV` だけで始め、tStop を長めに（ここでは 9ms = 4.5×2RC。L の初期電流 0 からでも 1% 以内）。L を固定部品にできる問題は `initialI` も入れる。
- 平均値の許容は 1〜2%、リプル（pp）は**近似式との差**を考えて 5〜15%（全波整流の I/(2fC) は放電時間を T/2 とみなすので実際より 10〜20% 大きい。解説で「近似」と明記し、判定はシミュレーション値に合わせて期待値を決め、許容誤差に近似式の値が入るようにする）。duty は `toleranceAbs` 0.01、効率は `toleranceAbs` 0.01〜0.02、力率は 2%。

### verify の注意
- `--mutate` は部品のパラメータを**まとめて**2倍にする。V_PULSE を参照解（プレイヤーが置く）にすると widthSec と periodSec が同時に2倍になりデューティ比が変わらない → 平均だけの判定では合格してしまう。リプル（周波数で変わる）も判定するか、V_PULSE を固定部品にする。
- ダイオード系の `Rs`、サイリスタ系の `Vgk`/`Vgt`/`Vt`/`Ih`/`Rs`/`dV`、SW_V の `Ron`/`Roff`/`Vth`、XFMR の `coupling` は2倍にしない（モデル定数）。SW_V の `invert` は反転される（相補駆動の取り違え）。
- `--reverse`: D・SCR は逆向き、SW_V は制御端子 ctrl_p/ctrl_n の入れ替え、XFMR は一次と二次の入れ替え、V_PULSE は極性反転。
- `--drop` で還流ダイオードを外すと、L の電流の行き場が無く節点電圧が非常に大きくなる（Roff = 1GΩ に流れるため。数値は物理的な意味を持たないが、判定は不合格になる）。サージ電圧を問題にするなら TVS・ZD でクランプした回路で値を判定する。

### 扱えない題材（作らない／簡略化して作る）
- スイッチング損失・ターンオン/オフ時間・ゲート電荷・ダイオードの逆回復・寄生容量・リンギング（素子は瞬時に切り替わる）。損失は導通損失（Vf·I、I²·Ron）だけ。
- 閉ループ制御（誤差増幅＋PWM 比較器のフィードバックで出力を安定化）・ソフトスタート IC・電流モード制御・能動 PFC（乗算器）。開ループの PWM（固定デューティ）で作る。比較器＋三角波で PWM を作る回路自体は可。
- 3端子レギュレータ（78xx）・LDO IC の専用部品は無い（OPAMP＋BJT／M_P と ZD で組む）。ヒューズ・ポリスイッチ（溶断）は無い（電流の大きさを判定するだけ）。サーミスタ・熱・温度上昇は無い。
- トランスの漏れインダクタンス・巻線抵抗・飽和・突入電流（磁気）、フォワードコンバータのリセット巻線。AC 解析でのトランス。
- モータの機械系（回転数・トルク・慣性）、ブラシレス・ステッピングモータ、ベクトル制御。直流モータの電気的等価回路（R＋L＋逆起電力）まで。
- 高調波の分析（THD・FFT の判定は無い）。力率は `powerFactor`（ひずみを含む全体の力率）で見る。
- SCR の dv/dt 点弧・ブレークオーバ点弧・ターンオフ時間、TRIAC の象限ごとの感度差、GTO・IGBT の専用部品（SW_V で代用）。

### 20問の候補（易 → 難。現エンジンで無理なく作れるもの）
**F 電源回路**
| # | トピック | 主な判定 |
|---|---|---|
| 1 | 半波整流（R 負荷）: 平均 Vm/π と実効値 Vm/2 | average, rms |
| 2 | ダイオードの Vf の影響と導通角（ピーク Vm − Vf） | max, duty（ダイオード電流） |
| 3 | 全波ブリッジ整流: ダイオードの向き（4個を組む） | average, connection（match D） |
| 4 | トランス＋ブリッジ: 巻数比で 100V → 12V | XFMR, average, max |
| 5 | コンデンサ平滑: C を選んでリプルを 1V 以下に（ΔV ≈ I/(2fC)） | pp, average |
| 6 | 半波と全波のリプル比較（同じ C で約 2 倍） | pp |
| 7 | 突入電流と直列抵抗（電源投入時の C の充電電流を制限） | max（電源電流、fromSec 0） |
| 8 | ピーク整流・ピーク検出（RC 放電） | max, pp |
| 9 | クランプ回路（直流分の付加） | min, max |
| 10 | 倍電圧整流（グライナッヘル）: 出力 2(Vm − Vf) | average |
| 11 | ツェナーシャントレギュレータ: 直列抵抗の選び方（負荷変動で Iz を確保） | DC dcVoltage, dcCurrent |
| 12 | エミッタフォロワ型（ZD＋NPN）レギュレータ | DC dcVoltage |
| 13 | OPAMP＋NPN のリニアレギュレータ: Vout = Vref(1+R1/R2) | DC dcVoltage, operatingRegion |
| 14 | ドロップアウト: 入力が下がると OPAMP が飽和して Vout = Vin − VBE | DC operatingRegion(satHigh), dcVoltage |
| 15 | リニアレギュレータの効率と発熱（Pd = (Vin−Vout)·I） | DC dcPower（Q）, numericAnswer |
| 16 | 電流制限（BJT でセンス抵抗の電圧 0.7V を検出） | DC dcCurrent |
| 17 | 過電圧保護のクローバ（ZD＋SCR）、点弧後の保持 | DC operatingRegion(on), dcVoltage／過渡 |
| 18 | 逆接続保護（直列 D／並列 D）、TVS によるサージクランプ | DC／過渡 max |
| 19 | 降圧スイッチング電源の基本（SW_V＋D＋L＋C）: D·Vin | average, pp |
| 20 | リニア vs スイッチング: 同じ 12V → 5V の効率比較 | efficiency |

**J パワーエレクトロニクス**
| # | トピック | 主な判定 |
|---|---|---|
| 1 | 理想スイッチと PWM: デューティ比で平均電圧を変える（R 負荷） | duty, average |
| 2 | SCR の点弧とラッチ（直流回路で一度点弧すると切れない） | DC operatingRegion, 過渡 |
| 3 | SCR 半波位相制御: Vavg = Vm/(2π)(1+cos α) | average |
| 4 | TRIAC の交流位相制御（調光）: 実効値と α | rms |
| 5 | DIAC＋TRIAC の調光回路（RC の時定数で点弧角が変わる） | rms |
| 6 | 降圧チョッパ: Vout = D·Vin、インダクタ電流リプル | average, L の pp |
| 7 | 降圧の出力リプル ΔI/(8fC) と L・C の選び方 | pp |
| 8 | 昇圧チョッパ: Vout = Vin/(1−D)、入力電流 | average, L の average |
| 9 | 昇降圧（反転）: −D/(1−D)·Vin | average |
| 10 | 電流連続／不連続（臨界インダクタンス） | L の min（signed） |
| 11 | ダイオードの導通損失と効率（Vf を 0.7 → 0.3 のショットキーにすると改善） | efficiency, power |
| 12 | 同期整流（還流ダイオードを相補駆動のスイッチに置き換え） | efficiency, average |
| 13 | フライバック（XFMR の Lm）: Vout = Vin·D/((1−D)·n)、絶縁 | average |
| 14 | ハーフブリッジ・インバータ（±電源、方形波出力） | rms（差動）, average 0 |
| 15 | フルブリッジ・インバータと RL 負荷の電流（tanh の式） | rms, 電流の max |
| 16 | 単相 PWM インバータ（三角波比較で正弦波に近づける）※ OPAMP 比較器 | acRms, average |
| 17 | 直流モータの H ブリッジ駆動（正転・逆転、平均電流 = (D·Vdc − E)/R） | average（電流, signed） |
| 18 | 誘導性負荷の還流ダイオード（モータ・リレーのサージ） | max |
| 19 | コンデンサ入力型整流の力率（≈ 0.45）と受動 PFC（L で改善） | powerFactor |
| 20 | 三相ブリッジ整流（V_AC 3 個、位相 0/120/240°）: Vavg = 3√3·Vm/π | average, pp |

---

## 8. 分野D（発振回路）・E（変調・復調・通信回路）— problem-writer 向けの要点

### 部品と理想化の前提（問題文の「条件」に書く）
| 部品 | ピン（connect の順） | モデル（理想化） | 解析 |
|---|---|---|---|
| **XTAL**（水晶振動子） | 1, 2 | 等価回路: 1−Rm−Lm−Cm−2 の直列枝 ＋ 1−2 間の Cp。既定 Lm = 0.1H、Cm = 25.33pF（fs = 100kHz）、Rm = 100Ω（Q ≈ 628）、Cp = 1nF（fp = fs·√(1+Cm/Cp) ≈ 1.0126·fs）。`fsHz` を書くと Cm = 1/((2π·fs)²·Lm)。`initialI`（Lm の初期電流）で発振を起動。温度特性・スプリアス・励振レベルなし。**Q は実物（10⁴〜10⁶）より低い教育用**、Cm/Cp も実物（1/200〜1/500）より大きい | DC（開放）・AC・過渡 |
| **V_AM**（AM 信号源） | p, n | v = Vc·(1 + m·sin 2πfm·t)·sin 2πfc·t（`Vc`, `fcHz`, `fmHz`, `m`） | 過渡のみ（DC・AC では 0V） |
| **V_FM**（FM 信号源） | p, n | v = Vpk·sin(2πfc·t + β·sin 2πfm·t)、β = Δf/fm（瞬時周波数 fc + Δf·cos 2πfm·t。`Vpk`, `fcHz`, `fmHz`, `deviationHz`） | 過渡のみ |
| **V_VCO**（電圧制御発振器） | p, n, ctrl_p, ctrl_n | f = f0 + Kv·(V(ctrl_p) − V(ctrl_n))（負は 0）、位相 = ∫2πf dt。`square: true` で方形波 Voffset ± Vpk（デューティ 50%）。制御電圧は前の刻みの値（陽解法）。制御端子に電流は流れない。`fMaxHz` は刻みの決定用（越えると警告） | 過渡のみ |
| **MULT**（乗算器） | x, y, out | V(out) = k·V(x)·V(y)（gnd 基準、`k` 既定 1/V）。入力電流 0、出力抵抗 0、帯域・飽和なし | DC・過渡、AC は DC 動作点で線形化（入力に直流が無ければ出力 0） |
| 論理ゲート（U_NOT, U_AND …）・DFF / DFF_R | §2 デジタルと同じ | **過渡解析でも動く**: 出力は gnd 基準の電圧源 High = `VOH`（既定 5V）/ Low = 0V（`Rout` 1Ω）、入力は電圧 ≥ `Vth`（既定 VOH/2）で 1、入力電流 0、遅延 0。`hyst`（V）> 0 でシュミット入力（0→1 は Vth+hyst/2、1→0 は Vth−hyst/2）。DFF は CLK の立ち上がりで直前の D を取り込む（Q = 0 で起動）。未配線の入力は 0。LOGIC_IN は value·VOH の電圧源。遅延 0 のゲートだけのループ（リング発振器）は扱えない | 過渡（DC・AC では従来どおり無視） |
- 条件欄の書き方の例: 「オペアンプは理想（入力電流 0、出力抵抗 0、周波数特性なし）で、出力は ±12V で飽和する」「インバータは理想（しきい値 2.5V、出力 0V/5V、遅延 0、入力電流 0）」「水晶振動子は等価回路（Lm, Cm, Rm, Cp）で表す」「乗算器の出力は k·x·y（k = 1/V）」「VCO の周波数は f0 + Kv·vc」。
- **発振の起動**: シミュレータには雑音が無いので、理想回路は 0V のまま動かない。次のどれかを**固定部品**で入れ、問題文にも「起動のため C2 に 10mV の初期電圧を与えてある」などと書く: C の `initialV`（10mV 程度）、L / XTAL の `initialI`、または起動パルス（V_PULSE を Rg の接地側に直列に入れ、10µs だけ 10mV にして後は 0V）。トランジスタの LC 発振は `"initialCondition": "dc"`（バイアス点から開始）＋ タンクの L の `initialI`。
- **過渡のトランジスタ**: LC 発振（コルピッツ・ハートレー・ピアース）は **M_N（平方則、K > 0）を推奨**。BJT は VBE 一定モデル（gm が無限大に近い）なのでコルピッツは発振するが強いひずみで周波数が 1〜2% ずれ、ハートレーは起動しない例がある。J_N は線形領域が無く振幅が制限されず発散するので**使わない**。MOSFET の線形/飽和の境界で「収束しなかった時刻」の警告が出ることがある（結果は使える）。BJT の `Is`（指数モデル）は過渡で発散するので使わない。

### 何で何を判定するか
| 確かめたいこと | 判定 | judge |
|---|---|---|
| 発振周波数（実際に発振させる） | `oscillationFrequency`（`fromSec`＋`toSec`）または `transientMeasure` `frequency` / `period` | transient |
| 発振が持続する・振幅 | `transientMeasure` `pp` / `max` に `expectedMin`（例: 1V 以上）、振幅制限（ダイオード）なら `expected` | transient |
| 方形波のデューティ（555 など） | `transientMeasure` `duty` | transient |
| バルクハウゼン条件（位相条件の周波数と一巡利得） | `loopGain`（ループを切った回路） | ac |
| 水晶の共振（fs で最小、fp で最大） | `acImpedance`（XTAL の端子、信号源と直列 R を `exclude`）、`loopGain`（分圧の位相 0° の周波数） | ac |
| VCO の特性 f = f0 + Kv·vc、PLL のロック | `transientMeasure` `frequency`（VCO 出力）、`average`（制御電圧）、`duty`（XOR 位相比較の出力） | transient |
| スペクトル線（搬送波・側帯波・和差周波・イメージ・高調波） | `transientMeasure` `tone`（`frequencyHz`） | transient |
| AM の変調度 | `transientMeasure` `modulationIndex`、または `tone` の比 2·A(fc±fm)/A(fc) | transient |
| 検波の出力（平均・リプル・復元波形） | `average` / `pp` / `tone`（fm の成分 = 復元振幅、2fm の成分 = ひずみ）、`expectedMax` | transient |
| デジタル変調（ASK・BPSK・FSK） | `tone`（BPSK は搬送波成分 0、ASK は duty 倍）、FSK は区間ごとの `frequency` | transient |

### ループの切り方（loopGain 用の回路の作り方）
- ループは**インピーダンスの影響が出ない点で切る**: (a) オペアンプの + 入力（入力インピーダンス無限大）、(b) オペアンプの出力（出力インピーダンス 0）。トランジスタの入力（rπ）で切ると負荷が変わるので、トランジスタ発振回路は過渡で判定する。
- 切った先に**固定の V_AC**（ノード `vin`、Vpk 1V、freqHz は何でもよい）、戻ってくる点に**固定の TP**（ノード `fb`）。戻ってくる点は元の回路で切った点につながっていた負荷（ここでは無限大）のままにする。
- 例（ウィーンブリッジ。オペアンプ・Rf・Rg は固定、プレイヤーが帰還回路の R・C を組む）:
```json
"judge": "ac",
"fixedComponents": [
  { "id": "V1", "type": "V_AC", "params": { "Vpk": 1, "freqHz": 1000 }, "connect": ["vin", "gnd"], "locked": true },
  { "id": "U1", "type": "OPAMP", "params": { "GBP": 0 }, "connect": ["vin", "n", "out", "", ""], "locked": true },
  { "id": "Rf", "type": "R", "params": { "R": 22000 }, "connect": ["out", "n"], "locked": true },
  { "id": "Rg", "type": "R", "params": { "R": 10000 }, "connect": ["n", "gnd"], "locked": true },
  { "id": "TPO", "type": "TP", "connect": ["out"], "locked": true },
  { "id": "TPF", "type": "TP", "connect": ["fb"], "locked": true }
],
"checks": [ { "type": "loopGain", "input": "vin", "output": "fb", "fMinHz": 100, "fMaxHz": 100000,
              "expectedFrequencyHz": 1591.5, "tolerancePct": 2, "gainMin": 1.0, "gainMax": 1.2 } ],
"referenceSolution": [
  { "id": "R1", "type": "R", "params": { "R": 10000 }, "connect": ["out", "x"] },
  { "id": "C1", "type": "C", "params": { "C": 1e-8 }, "connect": ["x", "fb"] },
  { "id": "R2", "type": "R", "params": { "R": 10000 }, "connect": ["fb", "gnd"] },
  { "id": "C2", "type": "C", "params": { "C": 1e-8 }, "connect": ["fb", "gnd"] }
]
```
  |T| = (1 + 22k/10k)/3 = 1.067。Rf = 18k なら 0.933 で不合格（振幅条件）、C を 1 個 2 倍にすると位相 0° の周波数がずれて不合格。移相発振（C-R 3 段）は (b) で切る: V_AC を C1 の入力に、出力 = 反転増幅の出力（Rf/R = 29 で |T| = 1、f = 1/(2πRC√6)）。
- `GBP: 0`（理想）にする。既定の GBP = 1MHz だと 1kHz 付近でも位相が 0.2° 程度遅れ、周波数が少しずれる。Aol = 10⁵ のため |T| は理想値より 10⁻⁴ 程度小さい（利得ちょうど 3 は |T| = 0.9999 で gainMin 1.0 に届かない）。
- 閉ループの過渡と組み合わせると強い: 同じ帰還回路を閉じた回路で「実際に発振し、周波数が f0 ± 3%」を判定する（別の問題にするか、閉ループの問題では oscillationFrequency と pp の expectedMin）。

### 過渡で発振させる回路の目安（test_checks.mjs で確認済み）
| 回路 | 結果（理論値との差） | 刻み・ステップ |
|---|---|---|
| ウィーン（利得 3.2、クリップで制限） | 周波数 −1.8%（クリップのひずみ） | 自動 0.8µs、30ms で 3.7 万。`dtFixed: T/200` で 1 万 |
| ウィーン（逆並列ダイオードで振幅安定化） | 周波数 −0.35%、振幅 ±11.25V、3 次高調波 3% | 同上 |
| 移相（Rf/R = 29 ちょうど） | 周波数 0.0%、振幅は保たれる。31 で成長中は −2.5%、35 でクリップ −7% | 1.9µs |
| シュミット型弛張（OPAMP） | 周期 2RC·ln(1+2R1/R2) と 0.06% | τ/100 |
| CMOS インバータ 2 個 / シュミットインバータ 1 個 | 2RC·ln3 と 0.04% / 2RC·ln1.5 と 0.12% | τ/100 |
| 555 相当（OPAMP×2 ＋ NOR ラッチ ＋ SW_V） | ln2·(RA+2RB)C と 0.02%、デューティ ±0.001 | 3000 |
| コルピッツ（MOSFET）/ ハートレー（MOSFET） | −1% / +0.6〜1.4% | `dtFixed` 推奨（ハートレーは自動だと刻み 3ns） |
| ピアース（MOSFET＋XTAL、initialI で起動） | fs·√(1+Cm/(Cp+CL)) と +0.2%（fs と fp の間） | 0.1µs、2ms で 2 万 |
| PLL（XOR＋RC＋VCO、÷1 / DFF で ÷2） | ロック後 VCO = N×基準を 0.01%、制御電圧 0.01% | 4 万 / 8 万（20ms） |
- 正弦波発振は「振幅が飽和で決まるとひずみで周波数がずれる」ので、閉ループの周波数の許容は 3〜5%。位相条件の周波数そのものを厳しく見るなら loopGain（0.1% 以内）。

### ステップ数（約 5 万以下が目安）
- 刻み: 交流周期/100（D 系・サイリスタ系・SW_V があれば /400）。V_AM / V_FM の「交流周期」は 1/fc（V_FM は 1/(fc+Δf)）、V_VCO は 1/fMaxHz（方形波は /100 のまま）。論理ゲートだけなら /400 にはならない。
- 例: AM＋ミキサ（ダイオード無し）fc = 100kHz、fm = 1kHz、5ms → 刻み 0.1µs で 5 万点。**包絡線検波（ダイオードあり）は /400** なので fc = 20kHz・fm = 200Hz・6ms で 4.8 万点、fc = 10kHz・fm = 500Hz・4ms で 1.6 万点。fc = 100kHz の検波は 5ms で 20 万点になるので作らない。
- **推奨**: fc = 10〜20kHz、fm = fc/20〜fc/100、区間は 1/fm の整数倍（tone の漏れ 0）。解析は 2〜4 変調周期（最初の 1 周期は検波の C の充電で捨てる）。
- 発振: 起動〜定常に 10〜20 周期 ＋ 判定区間 10 周期。50kHz の LC なら 0.5ms 程度（`dtFixed: T/200` で 5000 点）。

### JSON 例（E: スーパーヘテロダインの IF を取り出す）
```json
"judge": "transient", "simulation": { "tStop": 0.002 },
"fixedComponents": [
  { "id": "VRF", "type": "V_AC", "params": { "Vpk": 1, "freqHz": 12000 }, "connect": ["rf", "gnd"], "locked": true },
  { "id": "VLO", "type": "V_AC", "params": { "Vpk": 1, "freqHz": 10000 }, "connect": ["lo", "gnd"], "locked": true },
  { "id": "TPI", "type": "TP", "connect": ["if"], "locked": true }
],
"checks": [
  { "type": "transientMeasure", "node": "if", "measure": "tone", "frequencyHz": 2000, "fromSec": 0.001, "toSec": 0.002, "expected": 0.464, "tolerancePct": 3 },
  { "type": "transientMeasure", "node": "if", "measure": "tone", "frequencyHz": 22000, "fromSec": 0.001, "toSec": 0.002, "expectedMax": 0.15 }
],
"referenceSolution": [
  { "id": "MULT1", "type": "MULT", "params": { "k": 1 }, "connect": ["rf", "lo", "mix"] },
  { "id": "R1", "type": "R", "params": { "R": 1000 }, "connect": ["mix", "if"] },
  { "id": "C1", "type": "C", "params": { "C": 3.183e-8 }, "connect": ["if", "gnd"] }
]
```
（差 2kHz の成分 = k·1·1/2 × |H(2kHz)| = 0.5/√(1+(2/5)²) = 0.464、和 22kHz は RC（fc = 5kHz）で 0.11 に減る。イメージ周波数 8kHz の RF でも同じ 2kHz が出る。）

### 扱えない題材（作らない／簡略化）
- 雑音から自然に立ち上がる発振（必ず初期値か起動パルスで種を入れる）、位相雑音・ジッタ・周波数安定度（温度・電源変動）、水晶の高 Q（実物の Q では立ち上がりに数万周期かかる）・オーバートーン・スプリアス・負荷容量による周波数調整の ppm 単位の議論（数値回答なら可）。
- 3 段リング発振器（遅延 0 のゲートでは周期が出ない）、ゲートの伝搬遅延・スルーレート、555 の IC 部品そのもの（コンパレータ・ラッチ・放電スイッチで組む）。
- J_N の発振回路、BJT の指数モデル（`Is`）の過渡、過渡での BJT の小信号利得（AC で判定）。
- AC 解析での AM/FM/VCO/乗算器の非線形動作（AC は線形。変調・ミキサは過渡で）。FFT のスペクトル表示そのもの（判定は `tone` で指定周波数の振幅だけ）、THD の数値は tone の比で代用。
- 可変容量ダイオード D_VC の電圧依存（DC・AC・過渡とも未対応。VCO は V_VCO で）、PLL のチャージポンプ・位相周波数比較器（PFD）・ロックレンジの厳密な計算、周波数シンセサイザの可変分周器（DFF で ÷2・÷4 は可）。
- FM の復調（PLL 復調・フォスターシーリー・レシオ検波）は回路が大きく、ディスクリミネータ（LC の傾斜検波）なら V_FM ＋ RLC ＋ 包絡線検波で可能だが fc・Δf の設計に注意。SSB のフィルタ法（急峻な BPF）・位相推移法（ヒルベルト変換）は 90° 移相器を RC で作れる範囲に限る。QAM・OFDM・スペクトル拡散は作らない。

### 20問の候補（易 → 難。現エンジンで無理なく作れるもの）
**D 発振回路**
| # | トピック | 主な判定 |
|---|---|---|
| 1 | LC タンクの自由振動（L の初期電流）: f = 1/(2π√LC) | oscillationFrequency |
| 2 | 抵抗による減衰と Q（振動が消える＝発振には負性抵抗が必要） | transientPoint / pp |
| 3 | シュミットトリガ（OPAMP）の弛張発振: T = 2RC·ln(1+2R1/R2) | period, duty |
| 4 | CMOS インバータ 2 個の無安定マルチ: T ≈ 2.2RC | period |
| 5 | シュミットインバータ 1 個の RC 発振器（ヒステリシス幅で周期が決まる） | period |
| 6 | 555 相当の無安定動作: T = 0.693(RA+2RB)C、デューティ | period, duty |
| 7 | 555 のデューティを 50% に近づける（RA ≪ RB、ダイオードで分離） | duty |
| 8 | バルクハウゼン条件: ウィーン帰還回路の位相 0° の周波数 1/(2πRC) と減衰 1/3 | loopGain |
| 9 | ウィーンブリッジの増幅率（≥ 3）を決める | loopGain gainMin/gainMax |
| 10 | ウィーンブリッジを閉じて発振させる（初期電圧で起動、周波数と飽和振幅） | oscillationFrequency, pp |
| 11 | 振幅安定化（逆並列ダイオード）でひずみを減らす | max（電源より小）, tone 3f 比 |
| 12 | CR 移相発振: f = 1/(2πRC√6)、必要な利得 29 | loopGain |
| 13 | 移相発振の閉ループ動作 | oscillationFrequency |
| 14 | コルピッツ（MOSFET）: f = 1/(2π√(L·C1C2/(C1+C2))) | oscillationFrequency, expectedMin |
| 15 | ハートレー（MOSFET）: f = 1/(2π√((L1+L2)C)) | oscillationFrequency |
| 16 | 水晶振動子の等価回路: fs で最小・fp で最大のインピーダンス | acImpedance, loopGain |
| 17 | ピアース発振（水晶）: 周波数が fs と fp の間 | oscillationFrequency |
| 18 | VCO の特性 f = f0 + Kv·vc（制御電圧を設計） | frequency |
| 19 | PLL のロック: XOR 位相比較＋ループフィルタ＋VCO、ロック時の制御電圧 | frequency, average, duty |
| 20 | PLL の分周（DFF で ÷2）で基準の 2 倍の周波数を作る（シンセサイザ） | frequency |

**E 変調・復調・通信回路**
| # | トピック | 主な判定 |
|---|---|---|
| 1 | AM 波の形と変調度 m（包絡線の max/min） | modulationIndex |
| 2 | AM のスペクトル: 搬送波と側帯波 m·Vc/2、帯域幅 2fm | tone |
| 3 | 過変調（m > 1）で包絡線が崩れる、電力の配分（搬送波に 2/(2+m²)） | modulationIndex, tone, numericAnswer |
| 4 | 乗算器で AM を作る: (Vdc + vm)·vc、直流で m が決まる | modulationIndex, tone |
| 5 | DSB-SC（搬送波抑圧）: 乗算だけ → 搬送波成分 0 | tone |
| 6 | 包絡線検波（D＋RC）: 出力 ≈ 包絡線 − Vf | average, tone(fm) |
| 7 | 検波の時定数: 1/fc ≪ RC ≪ 1/fm（大きすぎるとダイアゴナルクリッピング） | tone(fm), tone(2fm) の expectedMax |
| 8 | 検波後の結合コンデンサで直流を除き、音声だけを取り出す | average ≈ 0, tone |
| 9 | 同期検波（DSB-SC を同じ搬送波で掛けて LPF） | tone(fm) |
| 10 | 同期検波の位相ずれ（搬送波の位相 θ で出力が cos θ 倍） | tone |
| 11 | ミキサ: 和と差の周波数 | tone |
| 12 | スーパーヘテロダイン: 局発 − RF = IF、IF フィルタ（RC/RLC） | tone(IF), expectedMax(和) |
| 13 | イメージ周波数（局発 + IF の局でも同じ IF が出る）と前置フィルタ | tone |
| 14 | 同調回路（RLC）で IF を選ぶ: Q と帯域幅 | tone, AC bodePoint |
| 15 | FM 波: 周波数偏移と変調指数 β = Δf/fm | frequency（区間ごと）, numericAnswer |
| 16 | FM のスペクトル: ベッセル関数 J0, J1、搬送波が消える β ≈ 2.405、カーソン帯域 | tone |
| 17 | ASK（オンオフ変調）: 乗算器または SW_V でオンオフ | tone, max |
| 18 | BPSK（±1 で位相反転）: 搬送波成分 0、同期検波で復調 | tone |
| 19 | FSK（VCO で 2 周波数）: マークとスペース | frequency（ビットごと） |
| 20 | FM の傾斜検波（RLC の傾斜で FM → AM → 包絡線検波）、または PLL 復調（制御電圧が音声） | tone(fm) |
