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
| `simulation` | オブジェクト | | 解析設定。`tStop`（過渡の終了時刻 s）、`dt`（最大刻み s）、`frequencies`（AC 解析周波数の配列 Hz）。省略時は自動（§4, §5） |
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

### acGaindB（judge: ac）
```json
{ "type": "acGaindB", "input": "vin", "output": "out", "frequencyHz": 1591.5, "expected": -3.01, "toleranceAbs": 0.1 }
```
- 利得 = 20·log10(|V(output)| / |V(input)|) [dB]。`input` / `output` は **ノード名**（gnd 基準電圧）。既定 `input="vin"`, `output="out"`。
- `input` ノードには電源の + 端子を、`output` ノードには TP などの固定部品を置く。
- dB の判定は `toleranceAbs`（dB）を使う。例: ±0.1dB。相対 % は 0dB 付近で使えない。

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

### truthTable（judge: digital）
- `{ "type": "truthTable", "table": [[0,0,0],[0,1,1],...] }`。デジタル分野用（詳細は分野G/H着手時に追記）。

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
- Q_NPN/Q_PNP: VBE 固定（`Vbe`）・電流増幅率 `beta`・飽和の区分線形モデル。
- V_AC / V_PULSE は DC 解析の対象外（使わない）。

### 過渡（judge: transient）
- **t = 0 で電源が投入される**（それ以前の状態は考えない）。C の初期電圧は `params.initialV`（既定 0V、connect[0] 側が + ）、L の初期電流は `params.initialI`（既定 0A）。
- 数値積分: 台形則（各不連続点の直後2ステップは後退オイラー）。刻みは自動で「最小時定数/100、LC 周期/100、交流周期/100、パルス周期/100」以下。V_PULSE の角（立ち上がり・立ち下がり）では必ず刻みを合わせる。
- 解析終了時刻（自動）: max(10ms, 最大時定数×10, LC 周期×5, 交流周期×5, パルス1周期, checks の timeSec×1.5)。最大 50000 ステップ（超えると打ち切り、警告）。変えたいときは `simulation.tStop`。
- 対応部品: R, C, L, L_RELAY, V_DC, V_AC, V_PULSE, I_DC, I_AC, SW, TP, GND。**ダイオード・トランジスタ等は過渡解析では未対応**（警告が出て無視される）。整流などの過渡問題は分野F着手時に追加予定。
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

### AC（judge: ac）
- 線形の定常フェーザ解析。V_AC の `Vpk` はピーク値、`phaseDeg` は位相。V_DC と V_PULSE は短絡（0V）、I_DC は開放。
- 対応部品: R, C, L, L_RELAY, V_AC, I_AC, V_DC, V_PULSE, I_DC, SW, TP。ダイオード等は非対応。

---

## 5. 検証ツール tools/verify.mjs

```
node tools/verify.mjs [分野/ID接頭辞] [--mutate | --reverse | --drop] [--strict]
```
| モード | 内容 | NG の条件 |
|---|---|---|
| （なし） | 問題データの検証（validateProblem）、index.json とファイルの一致、参照解＋referenceAnswers が全判定に合格するか | 検証エラー / 不合格 |
| `--mutate` | 参照解の部品を1個ずつ「数値パラメータを2倍（0 は 1、真偽値は反転）」にした誤答、referenceAnswers を1つずつ誤答（数値×2、選択肢は別番号）にした誤答が不合格になるか | 合格する変種がある |
| `--reverse` | 極性部品を1つずつ逆向きにした誤答が不合格になるか | 合格する変種がある |
| `--drop` | 参照解の部品を1つずつ取り除いた誤答（部品忘れ・つなぎ忘れ）が不合格になるか | 合格する変種がある |
| `--strict` | hints が3つ無い、explanation が無い/不完全、を警告ではなく NG にする | |

- `verifyNote` がある問題は mutate/reverse/drop の「甘い判定」を警告扱いにし、終了コードに含めない。
- 新しい問題はコミット前に4モードすべて（`--strict` 付き）で確認する。
- `--problems=DIR` で問題フォルダを差し替えられる（テスト用）。
- 判定・シミュレータ自体の単体テスト: `node tools/test_checks.mjs`（手計算で答えが分かる回路 108 項目）。

### 判定の甘さを防ぐコツ
- 値だけでなく **回路の形** を判定する: 「出力電圧」と「どこかの部品の電流」を両方見ると、部品を外した誤答・別の場所に付けた誤答が落ちる。
- 極性部品は `connection` を `pins` 形式で書く（`nets` は向きを見ない）。
- 比だけで決まる問題（分圧比など）は R1・R2 を同時に2倍にしても合格するが、verify は1部品ずつ変えるので通常は検出できる。それでも合格してしまう場合は、電流や電力の判定を足すか、理由を `verifyNote` に書く。
- `timeConstant` は `node` 指定にする（R_th 法だけだと電源を外した回路でも通ってしまう）。
