/**
 * DC定常状態シミュレーション（MNA: Modified Nodal Analysis）
 *
 * 対応素子:
 *  - 線形素子:
 *    - R:   conductance 1/R
 *    - V_DC: 電圧源（MNA の追加変数 I_VS で電流を求める）
 *    - I_DC: 電流源（p に電流を注入）
 *    - C:   DC では開放（ε·C の微小コンダクタンスで数値安定化）
 *           ただし「コンデンサだけが接続された浮遊ノード」は電荷保存則で処理
 *           （初期電荷 initialV を考慮するため）
 *    - L:   DC では短絡（微小抵抗 R_L）
 *    - SW:  closed=true なら短絡（微小抵抗）、false なら高抵抗
 *    - D_VC（バリキャップ）: DC ではコンデンサと同様にほぼ開放
 *
 *  - 非線形素子（B カテゴリ向け・区分線形 / ニュートン法で解く）:
 *    - D / SD / LED: 順方向電圧 Vf の理想ダイオード（off / on を反復切替）
 *    - ZD: ツェナー（off / 順方向 Vf=0.7 / 降伏 Vz を反復切替）
 *    - TVS: クランプダイオード（off / 順方向 Vf=0.7 / 降伏 Vclamp）
 *    - Q_NPN / Q_PNP: VBE 固定・β・VCEsat の区分線形モデル
 *      （off / active / saturation を反復切替。ベース直列抵抗 r_bb 内蔵）
 *      ※ params.Is を指定すると VBE = VT·ln(IC/Is) の指数則モデル
 *         （ニュートン法）に切り替わる。ワイドラーカレントミラー用。
 *    - M_N / M_P: K > 0 なら平方則モデル（カットオフ / 線形領域 / 飽和領域、
 *      ニュートン法）。K = 0 なら ON 時 RdsOn の抵抗として動作するスイッチ。
 *    - J_N: NチャネルJFETの飽和領域モデル ID = IDSS(1 - VGS/VGS(off))^2
 *      （ニュートン法）
 *    - PD: フォトダイオード（逆バイアス光電流 Ip の電流源）
 *    - PT: フォトトランジスタ（受光電流 Ic の電流源）
 *    - U_OPTO: フォトカプラ（入力LEDはダイオード、出力は CTR×LED電流 の電流源）
 *    - SCR / TRIAC / DIAC: ラッチ（自己保持）つきの区分線形スイッチ（下の「サイリスタ系」参照）
 *    - SW_V: 電圧制御の理想スイッチ（制御電圧 > Vth で Ron、それ以外 Roff）
 *    - D 系の直列抵抗は params.Rs（既定 RS_DIODE = 1Ω）。問題の simulation.diodeRs で
 *      Rs を書いていない全ダイオードの既定値を変えられる（applyModelDefaults）。
 *
 *  サイリスタ系（分野 F / J。理想化の前提）:
 *    - SCR [anode, gate, cathode]: ゲート-カソード間は Vgk のダイオード（直列 1Ω）。
 *      ゲート電流が流れている間に V_AK ≥ Vt ならオン（A-K 間 = Vt の定電圧＋直列 Rs）。
 *      いったんオンになると、ゲート電流が無くても A→K 電流 ≥ Ih（保持電流）の間はオンのまま
 *      （ラッチ）。電流が Ih を下回る（交流のゼロクロス・転流）とオフ。逆方向は阻止
 *      （降伏しない）。順方向のブレークオーバ（ゲートなしの点弧）・dv/dt 点弧・ターンオフ時間・
 *      ラッチング電流と保持電流の区別は無い。
 *    - TRIAC [mt2, gate, mt1]: ゲート-MT1 間は ±Vgt の双方向ダイオード（どちらの極性の
 *      ゲート電流でも点弧＝4象限すべてで同じ感度）。主端子は両方向に SCR と同じ動作（±Vt）。
 *    - DIAC [mt1, mt2]: |V| ≥ Vbo で導通し、端子電圧が ±(Vbo − dV)（ブレークバック）に下がる。
 *      電流が Ih を下回るとオフ。
 *    - 「ラッチ」は過渡解析で各時刻の解が確定したとき（commitDeviceStep）に記録する。
 *      DC 解析は前の時刻が無いので、反復中に一度オンになったらラッチしたとみなす
 *      （クローバ回路などで「点弧した後の動作点」を求める）。
 *    - U_WILSON / U_CASCODE: 参照端子に Vref の電圧源、出力に
 *      Iout ≈ Iref の電流源を持つブラックボックスカレントミラー
 *    - OPAMP: 電圧制御電圧源 Vout = Aol·(V(in+) − V(in−))（入力電流 0、出力抵抗 0）。
 *      出力は [下側レール + Vdrop, 上側レール − Vdrop] で飽和（区分線形の状態切替）。
 *      上側レール = v_plus ピンが配線されていればそのノード電圧、未配線なら params.Vpos。
 *      下側レール = v_minus ピンが配線されていればそのノード電圧、未配線なら params.Vneg。
 *      電源ピンは電圧を見るだけで電流は流れない（出力電流はグラウンドから供給される理想源）。
 *      GBP（利得帯域幅積）は AC 解析だけで使う（DC・過渡では周波数特性なし）。
 *  - 交流電源: V_AC は DC では 0V（短絡）、I_AC は 0A（開放）として扱う（SPICE と同じ）。
 *
 * 解法:
 *  - 素子の状態（導通/非導通/動作領域）ごとに回路を線形化し、
 *    状署名が変化しなくなるまで線形ソルバを反復する
 *    （理想ダイオード反復 + ニュートン法 + 固定点反復のハイブリッド）。
 *
 * 結果形式:
 *  {
 *    ok: true,
 *    dc: {
 *      nodes:    { gnd: 0, vin: 12, out: 4, ... },
 *      elements: { R1: { v, i, p }, D1: { v, i, p }, ... }
 *    }
 *  }
 */

import { registerSimulationMode } from "./simulator.js";
import { CONFIG } from "../config.js";
import { parseMetricValue } from "../core/units.js";
import { prepareNetlist, filterNodeResults, GMIN_NODE, NC_PREFIX, INTERNAL_PREFIX } from "./netlist.js";

/** コンデンサを DC で「ほぼ開放」と見なすときの単位静電容量あたりのコンダクタンス */
const EPS_CONDUCTANCE_PER_FARAD = 1e-3;

/** 開いたスイッチの抵抗 */
const R_SWITCH_OPEN = 1e12;

/** インダクタを DC で「ほぼ短絡」と見なすときの微小抵抗 */
const R_INDUCTOR_DC = 1e-3;

/**
 * 非線形素子のオフ状態 / 数値安定化に使う微小コンダクタンス（S）。
 * 電圧 10V で 10nA の漏れに相当し、判定許容誤差に影響しない。
 */
export const G_MIN = 1e-9;

/**
 * ダイオード系素子の ON 状態における直列抵抗（Ω）。
 * 理想電圧源のみだと同種素子の並列接続（ダイオードOR等）で
 * 電流分割が不定になり行列が特異するため、直列抵抗で決定論化する。
 * 10mA で 10mV の追加降下であり、判定許容誤差（1%以上）に影響しない。
 */
export const RS_DIODE = 1;

/**
 * BJT ベース直列抵抗（Ω）。
 * ダイオード接続（カレントミラー等）で 2 つのベース・エミッタ間電圧源が
 * 並列になっても電流分割が確定するようにする。ベース電流 1mA で 10mV、
 * 通常のバイアス設計（数十µA）では 0.1mV 程度の影響しかない。
 */
export const RB_BASE = 10;

/**
 * 熱電圧 VT = kT/q（V）。26mV（室温 約 29℃ 相当。300K では 25.85mV）。
 * - params.Is の指数則 BJT モデル
 * - AC 小信号モデルの gm = IC/VT, re = VT/IE（教科書の「re = 26mV / IE」と同じ値）
 * で使用する。
 */
export const VT_THERMAL = 0.026;

/** ツェナー / TVS の順方向電圧（V）。 */
const VF_ZENER_FORWARD = 0.7;

/** ダイオード系の直列抵抗の下限（Ω）。0 だと並列ダイオードで行列が特異になる。 */
const RS_MIN = 1e-4;

/** サイリスタ系（SCR / TRIAC / DIAC）の既定値 */
const THYRISTOR_DEFAULTS = { Vt: 1.0, Ih: 0.005, Rs: 0.01, dV: 5 };

/** SW_V（電圧制御スイッチ）の既定値 */
const VSWITCH_DEFAULTS = { Ron: 0.01, Roff: 1e9, Vth: 2.5 };

/** ダイオード系（Rs を持つ）部品種別 */
const DIODE_RS_TYPES = new Set(["D", "SD", "LED", "ZD", "TVS"]);

/**
 * 問題ごとのモデル既定値を部品に反映します（DC / 過渡 / AC 共通）。
 * - options.diodeRs: params.Rs を書いていない D/SD/LED/ZD/TVS の直列抵抗（Ω）。
 *   分野 F / J の「理想ダイオード（Vf 一定、抵抗 0 に近い）」用。既定は RS_DIODE = 1Ω。
 *
 * @param {Array<object>} components
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function applyModelDefaults(components, options = {}) {
  const expanded = expandCompositeParts(components);
  const rs = Number(options?.diodeRs);
  if (!(Number.isFinite(rs) && rs > 0)) return expanded;
  return expanded.map((c) =>
    DIODE_RS_TYPES.has(c?.type) && c.params?.Rs === undefined
      ? { ...c, params: { ...(c.params || {}), Rs: rs } }
      : c
  );
}

/**
 * 水晶振動子 XTAL の等価回路の既定値（教育用に Q を下げた値。実物の Q は 1e4〜1e5 以上で、
 * 過渡解析では立ち上がりに数万周期かかるため扱えない）。
 * fs = 1/(2π√(Lm·Cm)) = 100kHz、Q = 2π·fs·Lm/Rm ≈ 628、Cm/Cp ≈ 0.025（fp ≈ 1.0126·fs。実物の 1/200〜1/500 より大きくして fs と fp の差を見やすくした）。
 */
export const XTAL_DEFAULTS = { Lm: 0.1, Cm: 2.533029591e-11, Rm: 100, Cp: 1e-9 };

/** XTAL の等価回路定数 { Lm, Cm, Rm, Cp }。fsHz があれば Cm = 1/((2π·fs)²·Lm)。 */
export function xtalModel(c) {
  const Lm = Math.max(getNumericParam(c, "Lm", XTAL_DEFAULTS.Lm), 1e-12);
  const fs = getNumericParam(c, "fsHz", NaN);
  const Cm = Number.isFinite(fs) && fs > 0
    ? 1 / ((2 * Math.PI * fs) ** 2 * Lm)
    : Math.max(getNumericParam(c, "Cm", XTAL_DEFAULTS.Cm), 1e-18);
  const Rm = Math.max(getNumericParam(c, "Rm", XTAL_DEFAULTS.Rm), 1e-6);
  const Cp = Math.max(getNumericParam(c, "Cp", XTAL_DEFAULTS.Cp), 0);
  return { Lm, Cm, Rm, Cp };
}

/**
 * 複合部品を基本素子に展開します（DC / AC / 過渡で共通。内部ネットは INTERNAL_PREFIX 付き）。
 * - XTAL [1, 2]（水晶振動子の等価回路。理想化の前提）:
 *     1 ─ Rm ─ Lm ─ Cm ─ 2（直列共振枝。Lm の初期電流 = params.initialI）と、1−2 間に並列の Cp。
 *     直列共振 fs = 1/(2π√(Lm·Cm))（インピーダンス最小 ≈ Rm）、
 *     並列（反共振）fp = fs·√(1 + Cm/Cp)（インピーダンス最大）。温度特性・スプリアス・励振レベル依存は無い。
 *   展開後の部品 ID は "<id>#Rm" / "#Lm" / "#Cm" / "#Cp"。
 */
function expandCompositeParts(components) {
  if (!Array.isArray(components) || !components.some((c) => c?.type === "XTAL")) return components;
  const out = [];
  for (const c of components) {
    if (c?.type !== "XTAL") {
      out.push(c);
      continue;
    }
    const pins = Array.isArray(c.connect) ? c.connect : [];
    const [p, n] = [pins[0] ?? "", pins[1] ?? ""];
    const { Lm, Cm, Rm, Cp } = xtalModel(c);
    const a = `${INTERNAL_PREFIX}${c.id}:a`;
    const b = `${INTERNAL_PREFIX}${c.id}:b`;
    const meta = { compositeOf: c.id };
    out.push({ ...meta, id: `${c.id}#Rm`, type: "R", params: { R: Rm }, connect: [p, a] });
    const lp = { L: Lm };
    if (c.params?.initialI !== undefined) lp.initialI = getNumericParam(c, "initialI", 0);
    const cpar = { C: Cm };
    if (c.params?.initialV !== undefined) cpar.initialV = getNumericParam(c, "initialV", 0);
    out.push({ ...meta, id: `${c.id}#Lm`, type: "L", params: lp, connect: [a, b] });
    out.push({ ...meta, id: `${c.id}#Cm`, type: "C", params: cpar, connect: [b, n] });
    if (Cp > 0) out.push({ ...meta, id: `${c.id}#Cp`, type: "C", params: { C: Cp }, connect: [p, n] });
  }
  return out;
}

/** 指数則 BJT の VBE 初期値・クランプ（V）。 */
const VBE_EXP_INITIAL = 0.65;
const VBE_EXP_MIN = 0.2;
const VBE_EXP_MAX = 0.85;
const VBE_EXP_STEP_MAX = 0.05;

/**
 * 非線形反復の上限。CONFIG.simulation.dc.maxIterations を既定に使う。
 */
const MAX_DEVICE_ITERATIONS = Math.max(
  10,
  Number(CONFIG?.simulation?.dc?.maxIterations) || 100
);

/**
 * パラメータを数値へ変換します。
 * @param {object} component
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function getNumericParam(component, key, fallback) {
  const raw = component?.params?.[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = parseMetricValue(raw);
    if (Number.isFinite(parsed)) return parsed;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function isGroundNet(net) {
  return !net || net === "gnd" || net === "0";
}

/**
 * 部分ピボット付きガウス消去法。
 * 特異なら null を返します。
 */
function solveLinearSystem(A, b) {
  const n = A.length;
  if (n === 0) return [];

  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > pivotVal) { pivotVal = v; pivotRow = r; }
    }
    if (pivotVal < 1e-20) return null;
    if (pivotRow !== col) {
      const tmp = M[col]; M[col] = M[pivotRow]; M[pivotRow] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * 「コンデンサのみが接続されているノード」を検出します。
 * これらのノードは KCL の代わりに電荷保存則で扱います。
 *
 * @param {object} circuit
 * @returns {Set<string>}
 */
function detectFloatingNodes(circuit) {
  const typesByNet = new Map();
  for (const c of circuit.components) {
    if (c.type === "GND" || c.type === "TP") continue;
    for (const pin of (c.connect || [])) {
      if (isGroundNet(pin)) continue;
      if (!typesByNet.has(pin)) typesByNet.set(pin, new Set());
      typesByNet.get(pin).add(c.type);
    }
  }
  const floating = new Set();
  for (const [net, types] of typesByNet) {
    if (types.size === 1 && types.has("C")) floating.add(net);
  }
  return floating;
}

/* ==========================================================================
   非線形素子の分類
   ========================================================================== */

/**
 * ダイオード系（off / on の 2 状態）。値は順方向電圧のパラメータキー。
 */
const DIODE_FAMILY = { D: "Vf", SD: "Vf", LED: "Vf" };

/**
 * 降伏を持つダイオード（off / forward / breakdown の 3 状態）。
 * 値は降伏電圧のパラメータキー。
 */
const BREAKDOWN_FAMILY = { ZD: "Vz", TVS: "Vclamp" };

/** 電圧源 + 電流源を持つ素子（カレントミラー系）。 */
const MIRROR_TYPES = new Set(["U_WILSON", "U_CASCODE"]);

/**
 * 部品を線形素子と非線形素子に分類します。
 *
 * @param {Array<object>} components
 * @param {string[]} warnings
 * @returns {{
 *   resistors: Array<{id, p, n, g}>,
 *   vSources: Array<{id, p, n, value}>,
 *   iSources: Array<{id, p, n, value}>,
 *   devices: Array<object>,
 * }}
 */
function classifyComponents(components, warnings) {
  const resistors = [];
  const vSources = [];
  const iSources = [];
  const devices = [];

  for (const c of components) {
    if (c.type === "GND") continue;
    const pins = Array.isArray(c.connect) ? c.connect : [];
    if (pins.length < 2) continue;

    if (DIODE_FAMILY[c.type] || BREAKDOWN_FAMILY[c.type]) {
      devices.push(createDevice(c, pins));
      continue;
    }

    switch (c.type) {
      case "R": {
        const R = Math.max(getNumericParam(c, "R", 1000), 1e-9);
        resistors.push({ id: c.id, p: pins[0], n: pins[1], g: 1 / R });
        break;
      }
      case "V_DC":
        vSources.push({ id: c.id, p: pins[0], n: pins[1], value: getNumericParam(c, "V", 0) });
        break;
      case "I_DC":
        iSources.push({ id: c.id, p: pins[0], n: pins[1], value: getNumericParam(c, "I", 0) });
        break;
      case "V_AC":
      case "V_AM":
      case "V_FM":
      case "V_VCO":
        // 交流電源は DC では 0V（短絡）。直列に入った交流源で回路が切れないようにする
        // （V_AM / V_FM / V_VCO も同じ。波形は過渡解析だけで出る）
        vSources.push({ id: c.id, p: pins[0], n: pins[1], value: 0 });
        break;
      case "I_AC":
        // 交流電流源は DC では 0A（開放）
        iSources.push({ id: c.id, p: pins[0], n: pins[1], value: 0 });
        break;
      case "C": {
        const C = getNumericParam(c, "C", 1e-6);
        resistors.push({ id: c.id, p: pins[0], n: pins[1], g: EPS_CONDUCTANCE_PER_FARAD * C, isCapacitor: true });
        break;
      }
      case "D_VC": {
        // バリキャップ: DC では逆バイアス容量としてほぼ開放
        const C = getNumericParam(c, "C", 1e-10);
        resistors.push({ id: c.id, p: pins[0], n: pins[1], g: EPS_CONDUCTANCE_PER_FARAD * C });
        break;
      }
      case "L":
      case "L_RELAY": {
        resistors.push({ id: c.id, p: pins[0], n: pins[1], g: 1 / R_INDUCTOR_DC });
        break;
      }
      case "XFMR": {
        // DC では巻線はインダクタと同じく短絡（1mΩ）。理想トランスは直流を伝えない
        //（過渡解析では理想トランスとして結合する。src/sim/transient.js）
        if (pins.length >= 4) {
          resistors.push({ id: c.id, p: pins[0], n: pins[1], g: 1 / R_INDUCTOR_DC });
          resistors.push({ id: `${c.id}#s`, p: pins[2], n: pins[3], g: 1 / R_INDUCTOR_DC });
        }
        break;
      }
      case "SW": {
        const closed = c.params?.closed === true;
        const g = closed ? 1 / R_INDUCTOR_DC : 1 / R_SWITCH_OPEN;
        resistors.push({ id: c.id, p: pins[0], n: pins[1], g });
        break;
      }
      case "Q_NPN":
      case "Q_PNP":
      case "M_N":
      case "M_P":
      case "J_N":
      case "PD":
      case "PT":
      case "U_OPTO":
      case "SCR":
      case "TRIAC":
      case "DIAC":
      case "SW_V":
      case "U_WILSON":
      case "U_CASCODE":
      case "OPAMP":
      case "MULT":
        devices.push(createDevice(c, pins));
        break;
      default:
        warnings.push(`DC解析では未対応の部品: ${c.id} (${c.type})`);
    }
  }

  return { resistors, vSources, iSources, devices };
}

/**
 * 非線形素子のディスクリプタと初期状態を作成します。
 *
 * @param {object} c 部品
 * @param {string[]} pins 接続ネット
 * @returns {object}
 */
function createDevice(c, pins) {
  const device = {
    id: c.id,
    type: c.type,
    comp: c,
    pins,
    state: {},
  };

  if (DIODE_FAMILY[c.type]) {
    device.kind = "diode";
    device.vf = Math.max(getNumericParam(c, DIODE_FAMILY[c.type], 0.7), 0);
    device.rs = Math.max(getNumericParam(c, "Rs", RS_DIODE), RS_MIN);
    device.state = { mode: "off", current: 0 };
  } else if (BREAKDOWN_FAMILY[c.type]) {
    device.kind = "breakdown";
    device.vz = Math.max(getNumericParam(c, BREAKDOWN_FAMILY[c.type], 5.1), 0);
    device.rs = Math.max(getNumericParam(c, "Rs", RS_DIODE), RS_MIN);
    device.state = { mode: "off", current: 0 };
  } else if (c.type === "Q_NPN" || c.type === "Q_PNP") {
    device.kind = c.type === "Q_NPN" ? "bjtN" : "bjtP";
    device.beta = Math.max(getNumericParam(c, "beta", 100), 1);
    device.vbe = Math.max(getNumericParam(c, "Vbe", 0.7), 0.05);
    device.vceSat = Math.max(getNumericParam(c, "VceSat", 0.2), 0);
    device.isExp = Number.isFinite(Number(c.params?.Is)) && Number(c.params.Is) > 0;
    device.isRef = device.isExp ? Number(c.params.Is) : 0;
    device.state = { mode: "off", ib: 0, ic: 0, vbe: VBE_EXP_INITIAL };
  } else if (c.type === "M_N" || c.type === "M_P") {
    device.kind = c.type === "M_N" ? "mosN" : "mosP";
    device.vth = getNumericParam(c, "Vth", 2);
    device.k = getNumericParam(c, "K", 0.001);
    device.rdsOn = Math.max(getNumericParam(c, "RdsOn", 0.5), 1e-9);
    device.state = { mode: "off", vgs: 0, vds: 0 };
  } else if (c.type === "J_N") {
    device.kind = "jfetN";
    device.idss = Math.max(getNumericParam(c, "Idss", 0.01), 0);
    device.vgsOff = Math.min(getNumericParam(c, "VgsOff", -2), 0);
    device.state = { vgs: 0, id: 0 };
  } else if (c.type === "PD") {
    device.kind = "photodiode";
    device.ip = Math.max(getNumericParam(c, "Ip", 0.001), 0);
  } else if (c.type === "PT") {
    device.kind = "phototransistor";
    device.ic = Math.max(getNumericParam(c, "Ic", 0.002), 0);
  } else if (c.type === "U_OPTO") {
    device.kind = "optocoupler";
    device.vf = Math.max(getNumericParam(c, "Vf", 1.2), 0);
    device.ctr = Math.min(Math.max(getNumericParam(c, "CTR", 0.5), 0), 1);
    device.state = { ledMode: "off", iled: 0 };
  } else if (c.type === "SCR" || c.type === "TRIAC" || c.type === "DIAC") {
    device.kind = c.type === "SCR" ? "scr" : c.type === "TRIAC" ? "triac" : "diac";
    device.vgk = Math.max(getNumericParam(c, "Vgk", 0.8), 0);
    device.vgt = Math.max(getNumericParam(c, "Vgt", 1.5), 0);
    device.vbo = Math.max(getNumericParam(c, "Vbo", 30), 0);
    device.vt = Math.max(getNumericParam(c, "Vt", THYRISTOR_DEFAULTS.Vt), 0);
    device.ih = Math.max(getNumericParam(c, "Ih", THYRISTOR_DEFAULTS.Ih), 0);
    device.rs = Math.max(getNumericParam(c, "Rs", THYRISTOR_DEFAULTS.Rs), RS_MIN);
    if (device.kind === "diac") {
      // 導通中の端子電圧 = Vbo − dV（ブレークバック）
      const dV = Math.max(getNumericParam(c, "dV", THYRISTOR_DEFAULTS.dV), 0);
      device.vt = Math.max(device.vbo - dV, 0);
    }
    // mode: 主端子 off / on（SCR）/ onPos・onNeg（TRIAC・DIAC）
    // gateMode: off / on（SCR）/ pos・neg（TRIAC）。latched: 前の時刻で導通していた
    device.state = { mode: "off", gateMode: "off", current: 0, latched: false };
  } else if (c.type === "SW_V") {
    // pins = [1, 2, ctrl_p, ctrl_n]
    device.kind = "vswitch";
    device.ron = Math.max(getNumericParam(c, "Ron", VSWITCH_DEFAULTS.Ron), 1e-6);
    device.roff = Math.max(getNumericParam(c, "Roff", VSWITCH_DEFAULTS.Roff), device.ron);
    device.vth = getNumericParam(c, "Vth", VSWITCH_DEFAULTS.Vth);
    device.invert = c.params?.invert === true || c.params?.invert === "true";
    device.state = { mode: "off" };
  } else if (MIRROR_TYPES.has(c.type)) {
    device.kind = "mirror";
    device.vref = Math.max(getNumericParam(c, "Vref", 1.4), 0);
    device.state = { iref: 0 };
  } else if (c.type === "OPAMP") {
    // pins = [in_plus, in_minus, out, v_plus, v_minus]
    device.kind = "opamp";
    device.aol = Math.max(getNumericParam(c, "Aol", 1e5), 1);
    device.gbp = getNumericParam(c, "GBP", 1e6);
    device.vpos = getNumericParam(c, "Vpos", 15);
    device.vneg = getNumericParam(c, "Vneg", -15);
    device.vdrop = Math.max(getNumericParam(c, "Vdrop", 0), 0);
    const wired = (net) => typeof net === "string" && net !== "" && !net.startsWith(NC_PREFIX);
    device.railHighNet = wired(pins[3]) ? pins[3] : null;
    device.railLowNet = wired(pins[4]) ? pins[4] : null;
    device.state = { mode: "linear", vout: 0 };
  } else if (c.type === "MULT") {
    // 乗算器（ビヘイビア）: pins = [x, y, out]。V(out) = k·V(x)·V(y)（gnd 基準）。
    // 理想化: 入力電流 0、出力抵抗 0、帯域・飽和・オフセットなし。ニュートン法で線形化して反復する
    // （入力が出力に依存しない普通の使い方なら 2 回で収束）。
    device.kind = "mult";
    device.k = getNumericParam(c, "k", 1);
    device.state = { x: 0, y: 0 };
  } else if (typeof c.behavior === "object" && c.behavior) {
    // 過渡解析のビヘイビア素子（src/sim/behavioral.js: 論理ゲート・DFF）。
    // behavior = { branches(dev), stamp(dev, A, b, idx, rows), update(dev, vOf, cur), extract(dev, vOf, cur), commit(dev), describe(dev, vOf) }
    device.kind = "custom";
    device.behavior = c.behavior;
    device.state = c.behavior.initialState ? c.behavior.initialState(c) : {};
  }

  return device;
}

/** 非線形素子（createDevice で扱う）部品種別。過渡・AC 解析でも使う。 */
export const NONLINEAR_TYPES = new Set([
  ...Object.keys(DIODE_FAMILY), ...Object.keys(BREAKDOWN_FAMILY),
  "Q_NPN", "Q_PNP", "M_N", "M_P", "J_N", "PD", "PT", "U_OPTO",
  "SCR", "TRIAC", "DIAC", "U_WILSON", "U_CASCODE", "OPAMP", "SW_V", "MULT",
]);

/** サイリスタ系の素子か */
const isThyristor = (dev) => dev.kind === "scr" || dev.kind === "triac" || dev.kind === "diac";

/**
 * 過渡解析で1刻みの解が確定したときに呼ぶ: サイリスタ系の「ラッチ」（前の時刻で導通していた）を記録する。
 * @param {Array<object>} devices
 */
export function commitDeviceStep(devices) {
  for (const dev of devices) {
    if (isThyristor(dev)) {
      dev.state.latched = dev.state.mode !== "off";
      dev.state.fired = false;
    } else if (dev.kind === "custom" && dev.behavior.commit) {
      dev.behavior.commit(dev);
    }
  }
}

export { createDevice };

/**
 * OPAMP の上下レール電圧（飽和したときの出力電圧）を返します。
 * @param {object} dev
 * @param {(net: string) => number} vOf
 */
function opampRails(dev, vOf) {
  const hi = (dev.railHighNet ? vOf(dev.railHighNet) : dev.vpos) - dev.vdrop;
  const lo = (dev.railLowNet ? vOf(dev.railLowNet) : dev.vneg) + dev.vdrop;
  return { hi, lo };
}

/* ==========================================================================
   スタンプヘルパー
   ========================================================================== */

/**
 * 線形コンダクタンスをスタンプします。
 */
function stampConductance(A, p, n, g) {
  if (p >= 0) A[p][p] += g;
  if (n >= 0) A[n][n] += g;
  if (p >= 0 && n >= 0) {
    A[p][n] -= g;
    A[n][p] -= g;
  }
}

/**
 * 電流源をスタンプします（p のノードへ電流 I を注入）。
 */
function stampCurrentSource(b, p, n, i) {
  if (p >= 0) b[p] += i;
  if (n >= 0) b[n] -= i;
}

/**
 * 電圧源ブランチをスタンプします。
 *
 * @param {Array<Array<number>>} A
 * @param {Array<number>} b
 * @param {number} p ノード番号（-1 = GND）
 * @param {number} n ノード番号
 * @param {number} row ブランチ行
 * @param {number} value 目標電圧 v(p) - v(n)
 * @param {number} seriesR ブランチ直列抵抗（0 可）
 */
function stampVoltageBranch(A, b, p, n, row, value, seriesR = 0) {
  if (p >= 0) { A[p][row] += 1; A[row][p] += 1; }
  if (n >= 0) { A[n][row] -= 1; A[row][n] -= 1; }
  if (seriesR > 0) A[row][row] -= seriesR;
  b[row] = value;
}

/**
 * 電圧制御電流源をスタンプします。
 *
 * 「out 側ノードから素子へ流れ出る電流」= constI + gm·(v(inP) - v(inN))
 * となるようにスタンプする。opp 側ノードには逆向きに現れる。
 *
 * @param {Array<Array<number>>} A
 * @param {Array<number>} b
 * @param {number} out 電流が抜けていくノード
 * @param {number} opp 対偶ノード（電流が流入するノード）
 * @param {number} inP 制御電圧 + 側ノード
 * @param {number} inN 制御電圧 - 側ノード
 * @param {number} gm 相互コンダクタンス
 * @param {number} constI 定数電流成分
 */
function stampTransconductance(A, b, out, opp, inP, inN, gm, constI) {
  // out 側
  if (out >= 0) {
    if (inP >= 0) A[out][inP] += gm;
    if (inN >= 0) A[out][inN] -= gm;
    b[out] -= constI;
  }
  // opp 側（逆向き）
  if (opp >= 0) {
    if (inP >= 0) A[opp][inP] -= gm;
    if (inN >= 0) A[opp][inN] += gm;
    b[opp] += constI;
  }
}

/* ==========================================================================
   システム組立
   ========================================================================== */

/**
 * 1 反復分の MNA システムを組み立てます。
 *
 * @param {object} ctx
 * @param {Array<object>} devices
 * @returns {{A: number[][], b: number[], size: number, branchRows: Array<object>}}
 */
function assembleSystem(ctx, devices) {
  const { N, nodeIdx, resistors, vSources, iSources, floatingNodes, skippedCaps, circuit } = ctx;
  const idx = ctx.idx;

  const branchRows = [];
  const M = vSources.length;
  const deviceBranchCount = countDeviceBranches(devices);
  const size = N + M + deviceBranchCount;

  const A = Array.from({ length: size }, () => new Array(size).fill(0));
  const b = new Array(size).fill(0);

  // --- 全ノードに Gmin（浮いたノード・TP だけのノードがあっても解けるように） ---
  for (let i = 0; i < N; i++) A[i][i] += GMIN_NODE;

  // --- 抵抗 / コンダクタンスをスタンプ ---
  for (const r of resistors) {
    const p = idx(r.p);
    const n = idx(r.n);
    stampConductance(A, p, n, r.g);
  }

  // --- 電流源をスタンプ ---
  for (const cs of iSources) {
    stampCurrentSource(b, idx(cs.p), idx(cs.n), cs.value);
  }

  // --- 電圧源をスタンプ ---
  for (let k = 0; k < M; k++) {
    const vs = vSources[k];
    stampVoltageBranch(A, b, idx(vs.p), idx(vs.n), N + k, vs.value, 0);
  }

  // --- 浮遊ノードは電荷保存則に置換 ---
  for (const net of floatingNodes) {
    const row = idx(net);
    if (row < 0) continue;

    for (let j = 0; j < size; j++) A[row][j] = 0;
    b[row] = 0;

    for (const c of circuit.components) {
      if (c.type !== "C") continue;
      if (!skippedCaps.has(c.id)) continue;
      const pins = c.connect || [];
      if (!pins.includes(net)) continue;

      const C = getNumericParam(c, "C", 1e-6);
      const iV = getNumericParam(c, "initialV", 0);
      const isPos = pins[0] === net;
      const other = isPos ? pins[1] : pins[0];

      A[row][row] += C;
      const oi = idx(other);
      if (oi >= 0) A[row][oi] -= C;

      if (iV !== 0) {
        b[row] += isPos ? C * iV : -C * iV;
      }
    }
  }

  // --- 非線形素子をスタンプ ---
  branchRows.push(...stampDevices(A, b, idx, devices, N + M));

  return { A, b, size, branchRows };
}

/**
 * 非線形素子の現在の状態に応じた線形化モデルを A, b にスタンプします。
 * 素子の電圧源ブランチは branchStart 行目から順に割り当てます。
 *
 * @returns {Array<{deviceId: string, role: string}>} ブランチ行の対応表
 */
function stampDevices(A, b, idx, devices, branchStart) {
  const branchRows = [];
  let branchCursor = branchStart;

  for (const dev of devices) {
    const st = dev.state;

    switch (dev.kind) {
      case "diode": {
        const a = idx(dev.pins[0]);
        const k = idx(dev.pins[1]);
        if (st.mode === "on") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "forward" });
          stampVoltageBranch(A, b, a, k, row, dev.vf, dev.rs ?? RS_DIODE);
          stampConductance(A, a, k, G_MIN);
        } else {
          stampConductance(A, a, k, G_MIN);
        }
        break;
      }

      case "breakdown": {
        const a = idx(dev.pins[0]);
        const k = idx(dev.pins[1]);
        if (st.mode === "forward") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "forward" });
          stampVoltageBranch(A, b, a, k, row, VF_ZENER_FORWARD, dev.rs ?? RS_DIODE);
        } else if (st.mode === "breakdown") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "breakdown" });
          stampVoltageBranch(A, b, a, k, row, -dev.vz, dev.rs ?? RS_DIODE);
        }
        stampConductance(A, a, k, G_MIN);
        break;
      }

      case "bjtN": {
        const cI = idx(dev.pins[0]);
        const bI = idx(dev.pins[1]);
        const eI = idx(dev.pins[2]);

        if (dev.isExp) {
          // 指数則モデル（ニュートン法）: IC = Is·exp(VBE/VT)
          const vbe0 = st.vbe;
          const ic0 = dev.isRef * Math.exp(vbe0 / VT_THERMAL);
          const gm = ic0 / VT_THERMAL;
          const gmb = gm / dev.beta;
          const c0c = ic0 - gm * vbe0;
          // コレクタ電流: 内部 c -> e
          stampTransconductance(A, b, cI, eI, bI, eI, gm, c0c);
          // ベース電流: 内部 b -> e
          stampTransconductance(A, b, bI, eI, bI, eI, gmb, c0c / dev.beta);
          stampConductance(A, cI, eI, G_MIN);
          stampConductance(A, bI, eI, G_MIN);
        } else if (st.mode === "active") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "base" });
          // ベース・エミッタ間電圧源（直列 r_bb）
          stampVoltageBranch(A, b, bI, eI, row, dev.vbe, RB_BASE);
          // コレクタ電流源 Ic = β·Ib（ブランチ変数 x に線形依存）
          if (cI >= 0) A[cI][row] += dev.beta;
          if (eI >= 0) A[eI][row] -= dev.beta;
          stampConductance(A, cI, eI, G_MIN);
        } else if (st.mode === "saturation") {
          const rowB = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "base" });
          stampVoltageBranch(A, b, bI, eI, rowB, dev.vbe, RB_BASE);
          const rowC = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "collector" });
          stampVoltageBranch(A, b, cI, eI, rowC, dev.vceSat, 0);
        } else {
          stampConductance(A, bI, eI, G_MIN);
          stampConductance(A, cI, eI, G_MIN);
        }
        break;
      }

      case "bjtP": {
        const cI = idx(dev.pins[0]);
        const bI = idx(dev.pins[1]);
        const eI = idx(dev.pins[2]);

        if (st.mode === "active") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "base" });
          // エミッタ・ベース間電圧源（内部 e -> b）
          stampVoltageBranch(A, b, eI, bI, row, dev.vbe, RB_BASE);
          // コレクタ電流源 Ic = β·Ib（内部 e -> c）
          if (eI >= 0) A[eI][row] += dev.beta;
          if (cI >= 0) A[cI][row] -= dev.beta;
          stampConductance(A, cI, eI, G_MIN);
        } else if (st.mode === "saturation") {
          const rowB = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "base" });
          stampVoltageBranch(A, b, eI, bI, rowB, dev.vbe, RB_BASE);
          const rowC = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "collector" });
          // V(c) - V(e) = -VCEsat
          stampVoltageBranch(A, b, cI, eI, rowC, -dev.vceSat, 0);
        } else {
          stampConductance(A, bI, eI, G_MIN);
          stampConductance(A, cI, eI, G_MIN);
        }
        break;
      }

      case "mosN":
      case "mosP": {
        const dI = idx(dev.pins[0]);
        const gI = idx(dev.pins[1]);
        const sI = idx(dev.pins[2]);
        stampConductance(A, gI, sI, G_MIN); // ゲートは開放（微小リンクのみ）

        // NMOS: ドレインから素子へ電流が流れ出る（内部 d -> s）
        // PMOS: ソースから素子へ電流が流れ出る（内部 s -> d）
        // 状態の vgs / vds は極性を吸収した値（P 側は v_s-v_g, v_s-v_d）
        const outI = dev.kind === "mosN" ? dI : sI;
        const oppI = dev.kind === "mosN" ? sI : dI;

        if (dev.k <= 0) {
          // スイッチモード: ON なら RdsOn の抵抗
          if (st.mode === "on") {
            stampConductance(A, dI, sI, 1 / dev.rdsOn);
          } else {
            stampConductance(A, dI, sI, G_MIN);
          }
        } else if (st.mode === "saturation") {
          // ニュートン法: ID = 0.5·K·(VGS-|Vth|)^2
          const vgs0 = st.vgs;
          const vov = Math.max(vgs0 - Math.abs(dev.vth), 0);
          const f0 = 0.5 * dev.k * vov * vov;
          const gm = dev.k * vov;
          const c0 = f0 - gm * vgs0;
          const ctrlP = dev.kind === "mosN" ? gI : sI;
          const ctrlN = dev.kind === "mosN" ? sI : gI;
          stampTransconductance(A, b, outI, oppI, ctrlP, ctrlN, gm, c0);
          stampConductance(A, dI, sI, G_MIN);
        } else if (st.mode === "triode") {
          // 線形領域: オン抵抗 RDS = 1 / (K·(VGS-|Vth|)) の抵抗として扱う
          //   （B問題の前提「RDS_on = 1/(k×(VGS-Vth))」に一致）
          const vgs0 = st.vgs;
          const vov = Math.max(vgs0 - Math.abs(dev.vth), 0);
          const g = Math.max(dev.k * vov, G_MIN);
          stampConductance(A, dI, sI, g);
        } else {
          stampConductance(A, dI, sI, G_MIN);
        }
        break;
      }

      case "jfetN": {
        const dI = idx(dev.pins[0]);
        const gI = idx(dev.pins[1]);
        const sI = idx(dev.pins[2]);
        stampConductance(A, gI, sI, G_MIN); // ゲート電流 0

        const vgs0 = Math.min(st.vgs, 0); // ゲート接合順方向はクランプ
        let f0 = 0;
        let gm = 0;
        if (vgs0 > dev.vgsOff) {
          const ratio = 1 - vgs0 / dev.vgsOff;
          f0 = dev.idss * ratio * ratio;
          gm = (-2 * dev.idss * ratio) / dev.vgsOff;
        }
        const c0 = f0 - gm * vgs0;
        // ドレイン電流（内部 d -> s）= c0 + gm·(v_g - v_s)
        stampTransconductance(A, b, dI, sI, gI, sI, gm, c0);
        stampConductance(A, dI, sI, G_MIN);
        break;
      }

      case "photodiode": {
        const a = idx(dev.pins[0]);
        const k = idx(dev.pins[1]);
        // 光電流: カソード側から取り込み、アノード側へ放出
        stampCurrentSource(b, a, k, dev.ip);
        stampConductance(A, a, k, G_MIN);
        break;
      }

      case "phototransistor": {
        const cI = idx(dev.pins[0]);
        const eI = idx(dev.pins[1]);
        // 受光電流: コレクタから取り込み、エミッタへ放出
        stampCurrentSource(b, eI, cI, dev.ic);
        stampConductance(A, cI, eI, G_MIN);
        break;
      }

      case "optocoupler": {
        const a = idx(dev.pins[0]);
        const k = idx(dev.pins[1]);
        const cI = idx(dev.pins[2]);
        const eI = idx(dev.pins[3]);
        if (st.ledMode === "on") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "led" });
          stampVoltageBranch(A, b, a, k, row, dev.vf, RS_DIODE);
        }
        stampConductance(A, a, k, G_MIN);
        // 出力電流源 Iout = CTR × Iled
        const iout = dev.ctr * st.iled;
        stampCurrentSource(b, eI, cI, iout);
        stampConductance(A, cI, eI, G_MIN);
        break;
      }

      case "scr":
      case "triac":
      case "diac": {
        // SCR: pins = [anode, gate, cathode] / TRIAC: pins = [mt2, gate, mt1] / DIAC: pins = [mt1, mt2]
        const main = idx(dev.pins[0]);
        const ref = idx(dev.kind === "diac" ? dev.pins[1] : dev.pins[2]);
        if (dev.kind !== "diac") {
          const gate = idx(dev.pins[1]);
          if (st.gateMode !== "off") {
            const row = branchCursor++;
            branchRows.push({ deviceId: dev.id, role: "gate" });
            const vg = dev.kind === "scr" ? dev.vgk : dev.vgt;
            stampVoltageBranch(A, b, gate, ref, row, st.gateMode === "neg" ? -vg : vg, RS_DIODE);
          }
          stampConductance(A, gate, ref, G_MIN);
        }
        if (st.mode !== "off") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "main" });
          stampVoltageBranch(A, b, main, ref, row, st.mode === "onNeg" ? -dev.vt : dev.vt, dev.rs);
        }
        stampConductance(A, main, ref, G_MIN);
        break;
      }

      case "vswitch": {
        // SW_V: pins = [1, 2, ctrl_p, ctrl_n]。制御端子は電圧を見るだけ（電流 0）
        const p = idx(dev.pins[0]);
        const n = idx(dev.pins[1]);
        stampConductance(A, p, n, st.mode === "on" ? 1 / dev.ron : 1 / dev.roff);
        break;
      }

      case "mirror": {
        const refI = idx(dev.pins[0]);
        const outI = idx(dev.pins[1]);
        const gndI = idx(dev.pins[2]);
        // 参照端子: Vref の電圧源（ref - gnd ピン間）
        const row = branchCursor++;
        branchRows.push({ deviceId: dev.id, role: "ref" });
        stampVoltageBranch(A, b, refI, gndI, row, dev.vref, 0);
        // 出力: Iout ≈ Iref を out から引き込む
        stampCurrentSource(b, gndI, outI, st.iref);
        stampConductance(A, outI, gndI, G_MIN);
        break;
      }

      case "opamp": {
        // pins = [in_plus, in_minus, out, v_plus, v_minus]
        const ip = idx(dev.pins[0]);
        const im = idx(dev.pins[1]);
        const o = idx(dev.pins[2]);
        const row = branchCursor++;
        branchRows.push({ deviceId: dev.id, role: "out" });
        // 出力は gnd 基準の電圧源ブランチ（ブランチ電流 = out から素子へ流れ込む電流）
        if (o >= 0) { A[o][row] += 1; A[row][o] += 1; }
        if (dev.forceOut !== undefined) {
          // 帰還率の計算用: 出力を固定電圧にする（opampFeedbackFactor）
          b[row] = dev.forceOut;
        } else if (st.mode === "linear") {
          // V(out) − Aol·(V(in+) − V(in−)) = 0
          if (ip >= 0) A[row][ip] -= dev.aol;
          if (im >= 0) A[row][im] += dev.aol;
          b[row] = 0;
        } else {
          // 飽和: V(out) = レール電圧（配線された電源ピンのノード電圧 ∓ Vdrop、または Vpos/Vneg ∓ Vdrop）
          const high = st.mode === "satHigh";
          const railNet = high ? dev.railHighNet : dev.railLowNet;
          if (railNet) {
            const r = idx(railNet);
            if (r >= 0) A[row][r] -= 1;
            b[row] = high ? -dev.vdrop : dev.vdrop;
          } else {
            b[row] = high ? dev.vpos - dev.vdrop : dev.vneg + dev.vdrop;
          }
        }
        break;
      }

      case "mult": {
        // V(out) = k·x·y をニュートン法で線形化: V(out) − k·y0·V(x) − k·x0·V(y) = −k·x0·y0
        const xI = idx(dev.pins[0]);
        const yI = idx(dev.pins[1]);
        const o = idx(dev.pins[2]);
        const row = branchCursor++;
        branchRows.push({ deviceId: dev.id, role: "out" });
        if (o >= 0) { A[o][row] += 1; A[row][o] += 1; }
        if (xI >= 0) A[row][xI] -= dev.k * st.y;
        if (yI >= 0) A[row][yI] -= dev.k * st.x;
        b[row] = -dev.k * st.x * st.y;
        break;
      }

      case "custom": {
        const n = dev.behavior.branches(dev);
        const rows = [];
        for (let r = 0; r < n; r++) rows.push(branchCursor++);
        branchRows.push(...dev.behavior.roles(dev).slice(0, n).map((role) => ({ deviceId: dev.id, role })));
        dev.behavior.stamp(dev, A, b, idx, rows);
        break;
      }

      default:
        break;
    }
  }


  return branchRows;
}

/**
 * 非線形素子が必要とする電圧源ブランチ数を数えます。
 *
 * @param {Array<object>} devices
 * @returns {number}
 */
function countDeviceBranches(devices) {
  let count = 0;
  for (const dev of devices) {
    switch (dev.kind) {
      case "diode":
        if (dev.state.mode === "on") count += 1;
        break;
      case "breakdown":
        if (dev.state.mode === "forward" || dev.state.mode === "breakdown") count += 1;
        break;
      case "bjtN":
        if (dev.isExp) break;
        if (dev.state.mode === "active") count += 1;
        else if (dev.state.mode === "saturation") count += 2;
        break;
      case "bjtP":
        if (dev.state.mode === "active") count += 1;
        else if (dev.state.mode === "saturation") count += 2;
        break;
      case "optocoupler":
        if (dev.state.ledMode === "on") count += 1;
        break;
      case "scr":
      case "triac":
      case "diac":
        if (dev.state.gateMode !== "off" && dev.kind !== "diac") count += 1;
        if (dev.state.mode !== "off") count += 1;
        break;
      case "mirror":
      case "opamp":
      case "mult":
        count += 1;
        break;
      case "custom":
        count += dev.behavior.branches(dev);
        break;
      default:
        break;
    }
  }
  return count;
}

/* ==========================================================================
   状態更新・収束判定
   ========================================================================== */

/**
 * 数値を収束判定用に丸めます。
 *
 * @param {number} v
 * @returns {number}
 */
function roundForSignature(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e9) / 1e9;
}

/**
 * 解を得たあとで素子の状態・動作点を更新し、
 * 収束判定用のシグネチャ文字列を返します。
 *
 * @param {Array<object>} devices
 * @param {object} ctx
 * @param {Float64Array|number[]} x 解ベクトル
 * @param {Array<object>} branchRows
 * @param {number} deviceBranchBase 非線形素子ブランチの開始インデックス（N + 線形電圧源数）
 * @returns {string} シグネチャ（前回と同じなら収束）
 */
function updateDeviceStates(devices, ctx, x, branchRows, deviceBranchBase) {
  const { nodeIdx } = ctx;
  const vOf = (net) => (isGroundNet(net) ? 0 : (x[nodeIdx.get(net)] ?? 0));
  const branchCurrent = (deviceId, role) => {
    const index = branchRows.findIndex(
      (br) => br.deviceId === deviceId && br.role === role
    );
    if (index < 0) return 0;
    return x[deviceBranchBase + index] ?? 0;
  };

  const parts = [];
  const iterCtx = { changed: false };

  for (const dev of devices) {
    const st = dev.state;

    switch (dev.kind) {
      case "diode": {
        const vAk = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        if (st.mode === "off") {
          if (vAk >= dev.vf - 1e-12) st.mode = "on";
        } else {
          const ib = branchCurrent(dev.id, "forward");
          st.current = ib;
          if (ib < 0) st.mode = "off";
        }
        parts.push(`${dev.id}:${st.mode}:${roundForSignature(st.mode === "on" ? st.current : vAk)}`);
        break;
      }

      case "breakdown": {
        const vAk = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        if (st.mode === "off") {
          if (vAk >= VF_ZENER_FORWARD) st.mode = "forward";
          else if (-vAk >= dev.vz) st.mode = "breakdown";
        } else if (st.mode === "forward") {
          const ib = branchCurrent(dev.id, "forward");
          st.current = ib;
          if (ib < 0) st.mode = vAk <= -dev.vz ? "breakdown" : "off";
        } else {
          const xBranch = branchCurrent(dev.id, "breakdown");
          st.current = -xBranch; // 降伏電流（カソード -> アノード）
          if (xBranch >= 0) st.mode = vAk >= VF_ZENER_FORWARD ? "forward" : "off";
        }
        parts.push(`${dev.id}:${st.mode}:${roundForSignature(st.current)}`);
        break;
      }

      case "bjtN": {
        const vbe = vOf(dev.pins[1]) - vOf(dev.pins[2]);
        const vce = vOf(dev.pins[0]) - vOf(dev.pins[2]);

        if (dev.isExp) {
          // 指数則モデル: 動作点 VBE を更新（ニュートン法・ステップ制限付き）
          let target = vbe;
          if (!Number.isFinite(target)) target = VBE_EXP_INITIAL;
          target = Math.min(Math.max(target, VBE_EXP_MIN), VBE_EXP_MAX);
          const delta = Math.min(Math.abs(target - st.vbe), VBE_EXP_STEP_MAX);
          st.vbe = st.vbe + Math.sign(target - st.vbe) * delta;
          parts.push(`${dev.id}:exp:${roundForSignature(st.vbe)}`);
          break;
        }

        if (st.mode === "off") {
          if (vbe >= dev.vbe - 1e-12) st.mode = "active";
        } else if (st.mode === "active") {
          const ib = branchCurrent(dev.id, "base");
          st.ib = ib;
          st.ic = dev.beta * Math.max(ib, 0);
          if (ib < 0) st.mode = "off";
          else if (vce < dev.vceSat) st.mode = "saturation";
        } else {
          const ib = branchCurrent(dev.id, "base");
          const ic = branchCurrent(dev.id, "collector");
          st.ib = ib;
          st.ic = ic;
          if (ib < 0) st.mode = "off";
          else if (dev.beta * ib < ic) st.mode = "active";
        }
        parts.push(`${dev.id}:${st.mode}:${roundForSignature(st.ib)}:${roundForSignature(st.ic)}`);
        break;
      }

      case "bjtP": {
        const vEb = vOf(dev.pins[2]) - vOf(dev.pins[1]); // V(e) - V(b)
        const vEc = vOf(dev.pins[2]) - vOf(dev.pins[0]); // V(e) - V(c)

        if (st.mode === "off") {
          if (vEb >= dev.vbe - 1e-12) st.mode = "active";
        } else if (st.mode === "active") {
          const ib = branchCurrent(dev.id, "base");
          st.ib = ib;
          st.ic = dev.beta * Math.max(ib, 0);
          if (ib < 0) st.mode = "off";
          else if (vEc <= dev.vceSat) st.mode = "saturation";
        } else {
          const ib = branchCurrent(dev.id, "base");
          const xC = branchCurrent(dev.id, "collector");
          const ic = -xC; // 内部 c -> e の逆が実電流
          st.ib = ib;
          st.ic = ic;
          if (ib < 0) st.mode = "off";
          else if (dev.beta * ib < ic) st.mode = "active";
        }
        parts.push(`${dev.id}:${st.mode}:${roundForSignature(st.ib)}:${roundForSignature(st.ic)}`);
        break;
      }

      case "mosN":
      case "mosP": {
        if (dev.k <= 0) {
          // スイッチモード
          const vgs = dev.kind === "mosN"
            ? vOf(dev.pins[1]) - vOf(dev.pins[2])
            : vOf(dev.pins[2]) - vOf(dev.pins[1]);
          const on = dev.kind === "mosN"
            ? vgs > dev.vth
            : vgs > -dev.vth;
          st.mode = on ? "on" : "off";
          parts.push(`${dev.id}:${st.mode}`);
          break;
        }

        const vgs = dev.kind === "mosN"
          ? vOf(dev.pins[1]) - vOf(dev.pins[2])
          : vOf(dev.pins[2]) - vOf(dev.pins[1]);
        const vds = dev.kind === "mosN"
          ? vOf(dev.pins[0]) - vOf(dev.pins[2])
          : vOf(dev.pins[2]) - vOf(dev.pins[0]);
        const vov = vgs - Math.abs(dev.vth);

        if (vov <= 0) {
          st.mode = "off";
        } else if (vds <= vov) {
          st.mode = "triode";
        } else {
          st.mode = "saturation";
        }
        st.vgs = vgs;
        st.vds = vds;
        parts.push(`${dev.id}:${st.mode}:${roundForSignature(vgs)}:${roundForSignature(vds)}`);
        break;
      }

      case "jfetN": {
        const vgs = vOf(dev.pins[1]) - vOf(dev.pins[2]);
        st.vgs = vgs;
        const vgsClamped = Math.min(vgs, 0);
        let id = 0;
        if (vgsClamped > dev.vgsOff) {
          const ratio = 1 - vgsClamped / dev.vgsOff;
          id = dev.idss * ratio * ratio;
        }
        st.id = id;
        parts.push(`${dev.id}:jfet:${roundForSignature(vgs)}:${roundForSignature(id)}`);
        break;
      }

      case "optocoupler": {
        const vAk = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        if (st.ledMode === "off") {
          if (vAk >= dev.vf - 1e-12) st.ledMode = "on";
        } else {
          const iled = branchCurrent(dev.id, "led");
          st.iled = Math.max(iled, 0);
          if (iled < 0) st.ledMode = "off";
        }
        parts.push(`${dev.id}:${st.ledMode}:${roundForSignature(st.iled)}`);
        break;
      }

      case "scr":
      case "triac":
      case "diac": {
        const refNet = dev.kind === "diac" ? dev.pins[1] : dev.pins[2];
        const vMain = vOf(dev.pins[0]) - vOf(refNet);
        // --- ゲート（SCR: G→K の Vgk ダイオード、TRIAC: G−MT1 間の ±Vgt 双方向ダイオード） ---
        if (dev.kind !== "diac") {
          const vGr = vOf(dev.pins[1]) - vOf(refNet);
          const vg = dev.kind === "scr" ? dev.vgk : dev.vgt;
          if (st.gateMode === "off") {
            if (vGr >= vg - 1e-12) st.gateMode = dev.kind === "scr" ? "on" : "pos";
            else if (dev.kind === "triac" && vGr <= -vg + 1e-12) st.gateMode = "neg";
          } else {
            const ig = branchCurrent(dev.id, "gate");
            if (st.gateMode === "neg" ? ig > 0 : ig < 0) st.gateMode = "off";
          }
        }
        const gateOn = st.gateMode !== "off";
        // --- 主端子 ---
        if (st.mode === "off") {
          st.current = 0;
          if (dev.kind === "scr") {
            if (gateOn && vMain >= dev.vt - 1e-12) st.mode = "on";
          } else if (dev.kind === "triac") {
            if (gateOn && vMain >= dev.vt - 1e-12) st.mode = "onPos";
            else if (gateOn && vMain <= -dev.vt + 1e-12) st.mode = "onNeg";
          } else if (vMain >= dev.vbo - 1e-12) {
            st.mode = "onPos";
          } else if (vMain <= -dev.vbo + 1e-12) {
            st.mode = "onNeg";
          }
          // 点弧したら自己保持（この解の中ではゲート電流が消えても順電流が正なら導通を続け、
          // 次の時刻からは Ih 以上の間だけ導通。commitDeviceStep が latched に移す）
          if (st.mode !== "off") st.fired = true;
        } else {
          const x = branchCurrent(dev.id, "main");
          st.current = x;
          const iFwd = st.mode === "onNeg" ? -x : x;
          const allowed = gateOn || st.latched || st.fired || dev.kind === "diac";
          const minI = gateOn || !st.latched ? 0 : dev.ih;
          if (!allowed || iFwd < minI) st.mode = "off";
        }
        parts.push(`${dev.id}:${st.mode}:${st.gateMode}:${roundForSignature(st.current)}`);
        break;
      }

      case "vswitch": {
        const vc = vOf(dev.pins[2]) - vOf(dev.pins[3]);
        const on = dev.invert ? vc < dev.vth : vc > dev.vth;
        st.mode = on ? "on" : "off";
        parts.push(`${dev.id}:${st.mode}`);
        break;
      }

      case "mirror": {
        const iref = branchCurrent(dev.id, "ref");
        st.iref = Math.max(iref, 0);
        parts.push(`${dev.id}:mirror:${roundForSignature(st.iref)}`);
        break;
      }

      case "opamp": {
        const vd = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        const target = dev.aol * vd; // 飽和が無いときの出力
        const { hi, lo } = opampRails(dev, vOf);
        st.vout = vOf(dev.pins[2]);
        const unstable = dev.aol * (dev.loopBeta ?? 0) > 1; // 正帰還: 線形の平衡点は不安定
        if (hi <= lo) {
          // レールが逆転（電源がつながっていない等）: 上側レールに張り付けて扱う
          st.mode = "satHigh";
        } else if (unstable) {
          // 正帰還では飽和状態しか取れない。飽和が成り立たなくなったら反対側へ反転
          //（シュミットトリガのしきい値を越えた）。線形からは平衡点の出力の符号で決める
          if (st.mode === "linear") st.mode = st.vout >= 0 ? "satHigh" : "satLow";
          else if (st.mode === "satHigh" && target < hi) st.mode = "satLow";
          else if (st.mode === "satLow" && target > lo) st.mode = "satHigh";
        } else if (st.mode === "linear") {
          if (target > hi) st.mode = "satHigh";
          else if (target < lo) st.mode = "satLow";
        } else if (st.mode === "satHigh") {
          // 飽和から抜けるときは必ずいったん線形へ（反対側の飽和へ直接跳ぶと
          // 「上で飽和→下で飽和→…」の往復になり収束しないため）
          if (target < hi) st.mode = "linear";
        } else if (target > lo) {
          st.mode = "linear";
        }
        parts.push(`${dev.id}:${st.mode}`);
        break;
      }

      case "mult": {
        st.x = vOf(dev.pins[0]);
        st.y = vOf(dev.pins[1]);
        parts.push(`${dev.id}:mult:${roundForSignature(st.x)}:${roundForSignature(st.y)}`);
        break;
      }

      case "custom":
        // iterCtx: 論理素子は 1 回の反復で 1 個だけ出力を切り替える（Gauss-Seidel 式。全ゲートを同時に
        // 切り替えると帰還ループ（ラッチ・無安定マルチ）で「全部 0 ⇔ 全部 1」の往復になり収束しない）
        parts.push(`${dev.id}:${dev.behavior.update(dev, vOf, branchCurrent, iterCtx)}`);
        break;

      default:
        parts.push(`${dev.id}:static`);
        break;
    }
  }

  return parts.join("|");
}

/* ==========================================================================
   素子結果の抽出
   ========================================================================== */

/**
 * 非線形素子の DC 動作点を elements 形式で抽出します。
 *
 * @param {Array<object>} devices
 * @param {object} ctx
 * @param {number[]} x
 * @param {Array<object>} branchRows
 * @param {number} deviceBranchBase 非線形素子ブランチの開始インデックス（N + 線形電圧源数）
 * @returns {Record<string, {v: number, i: number, p: number}>}
 */
function extractDeviceElements(devices, ctx, x, branchRows, deviceBranchBase) {
  const { nodeIdx } = ctx;
  const vOf = (net) => (isGroundNet(net) ? 0 : (x[nodeIdx.get(net)] ?? 0));
  const branchCurrent = (deviceId, role) => {
    const index = branchRows.findIndex(
      (br) => br.deviceId === deviceId && br.role === role
    );
    if (index < 0) return 0;
    return x[deviceBranchBase + index] ?? 0;
  };

  const elements = {};

  for (const dev of devices) {
    const st = dev.state;
    let v = 0;
    let i = 0;

    switch (dev.kind) {
      case "diode": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        i = st.mode === "on" ? st.current : v * G_MIN;
        break;
      }
      case "breakdown": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        if (st.mode === "forward") i = st.current;
        else if (st.mode === "breakdown") i = -st.current; // 実電流の向きを素子電流として保持
        else i = v * G_MIN;
        break;
      }
      case "bjtN":
      case "bjtP": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[2]);
        if (dev.kind === "bjtN" && dev.isExp) {
          const vbe = Math.max(st.vbe ?? VBE_EXP_INITIAL, 0);
          i = dev.isRef * Math.exp(vbe / VT_THERMAL);
        } else {
          i = st.mode === "off" ? 0 : st.ic;
        }
        break;
      }
      case "mosN":
      case "mosP": {
        const vgs = st.vgs ?? 0;
        const vds = st.vds ?? 0;
        v = dev.kind === "mosN" ? vds : -vds;
        let idMag = 0;
        if (dev.k <= 0) {
          idMag = st.mode === "on" ? Math.abs(v) / dev.rdsOn : 0;
        } else if (st.mode === "saturation") {
          const vov = Math.max(vgs - Math.abs(dev.vth), 0);
          idMag = 0.5 * dev.k * vov * vov;
        } else if (st.mode === "triode") {
          const vov = Math.max(vgs - Math.abs(dev.vth), 0);
          idMag = vds * dev.k * vov; // オン抵抗モデル: ID = VDS / RDS
        }
        // 素子電流はドレイン端子に流れ込む向きを正とする
        i = dev.kind === "mosN" ? idMag : -idMag;
        break;
      }
      case "jfetN": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[2]);
        i = st.id ?? 0;
        break;
      }
      case "photodiode": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        i = dev.ip;
        break;
      }
      case "phototransistor": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        i = dev.ic;
        break;
      }
      case "optocoupler": {
        v = vOf(dev.pins[2]) - vOf(dev.pins[3]);
        i = dev.ctr * (st.iled ?? 0);
        break;
      }
      case "scr":
      case "triac":
      case "diac": {
        // v = 主端子間電圧（anode−cathode / MT2−MT1 / MT1−MT2）、
        // i = 主端子の電流（anode→cathode / MT2→MT1 / MT1→MT2 が正）、ig = ゲート電流
        v = vOf(dev.pins[0]) - vOf(dev.kind === "diac" ? dev.pins[1] : dev.pins[2]);
        i = st.mode !== "off" ? branchCurrent(dev.id, "main") : v * G_MIN;
        const ig = st.gateMode !== "off" ? branchCurrent(dev.id, "gate") : 0;
        elements[dev.id] = { v, i, p: v * i, ig };
        continue;
      }
      case "vswitch": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        i = v / (st.mode === "on" ? dev.ron : dev.roff);
        break;
      }
      case "mirror": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[2]);
        i = st.iref ?? 0;
        break;
      }
      case "opamp":
      case "mult": {
        // v = 出力電圧（gnd 基準）、i = 出力端子から外部回路へ流れ出す電流
        v = vOf(dev.pins[2]);
        i = -branchCurrent(dev.id, "out");
        break;
      }
      case "custom": {
        const e = dev.behavior.extract(dev, vOf, branchCurrent);
        v = e.v;
        i = e.i;
        break;
      }
      default:
        break;
    }

    elements[dev.id] = { v, i, p: v * i };
  }

  return elements;
}

/**
 * 非線形素子の動作点（判定 operatingRegion と AC 小信号モデルで使う）をまとめます。
 *
 * region の値:
 *  - BJT: "off"（遮断）/ "active"（活性）/ "saturation"（飽和）
 *  - MOSFET（K>0）: "off" / "triode"（線形領域）/ "saturation"（飽和領域）。K=0 のスイッチモードは "on" / "off"
 *  - JFET: "saturation"（VGS > VGS(off)）/ "off"
 *  - D/SD/LED: "on" / "off"、ZD/TVS: "forward" / "breakdown" / "off"
 *  - OPAMP: "linear" / "satHigh"（上側で飽和）/ "satLow"（下側で飽和）
 *
 * 小信号パラメータ（AC 解析が使う。VT = VT_THERMAL = 26mV）:
 *  - BJT（活性）: gm = |IC|/VT, rπ = β/gm
 *  - MOSFET（飽和）: gm = K·(VGS−|Vth|) = √(2K·ID)（DC モデル ID = ½K(VGS−|Vth|)² の微分）
 *  - MOSFET（線形領域）: gds = K·(VGS−|Vth|)（DC モデルのオン抵抗 1/(K·Vov) と同じ）
 *  - JFET: gm = −2·IDSS/VGS(off)·(1 − VGS/VGS(off))
 *
 * @returns {Record<string, object>}
 */
export function describeOperatingPoints(devices, vOf, elements) {
  const ops = {};
  for (const dev of devices) {
    const st = dev.state;
    const e = elements?.[dev.id] ?? {};
    switch (dev.kind) {
      case "bjtN":
      case "bjtP": {
        let region;
        let ic;
        if (dev.isExp) {
          ic = Math.abs(e.i ?? 0);
          region = ic > 1e-12 ? "active" : "off";
        } else {
          region = st.mode;
          ic = region === "off" ? 0 : Math.abs(st.ic ?? 0);
        }
        const gm = region === "active" ? ic / VT_THERMAL : 0;
        ops[dev.id] = {
          kind: "bjt", type: dev.type, region,
          ic, ib: dev.isExp ? ic / dev.beta : Math.abs(st.ib ?? 0),
          vbe: vOf(dev.pins[1]) - vOf(dev.pins[2]),
          vce: vOf(dev.pins[0]) - vOf(dev.pins[2]),
          beta: dev.beta, gm, rpi: gm > 0 ? dev.beta / gm : Infinity,
        };
        break;
      }
      case "mosN":
      case "mosP": {
        const vgs = st.vgs ?? 0;
        const vds = st.vds ?? 0;
        const vov = Math.max(vgs - Math.abs(dev.vth), 0);
        let region = st.mode;
        let gm = 0;
        let gds = 0;
        if (dev.k <= 0) {
          gds = st.mode === "on" ? 1 / dev.rdsOn : 0;
        } else if (st.mode === "saturation") {
          gm = dev.k * vov;
        } else if (st.mode === "triode") {
          gds = dev.k * vov;
        } else {
          region = "off";
        }
        ops[dev.id] = { kind: "mos", type: dev.type, region, vgs, vds, vov, id: Math.abs(e.i ?? 0), gm, gds };
        break;
      }
      case "jfetN": {
        const vgs = Math.min(st.vgs ?? 0, 0);
        let gm = 0;
        if (vgs > dev.vgsOff) gm = (-2 * dev.idss * (1 - vgs / dev.vgsOff)) / dev.vgsOff;
        ops[dev.id] = {
          kind: "jfet", type: dev.type, region: vgs > dev.vgsOff ? "saturation" : "off",
          vgs: st.vgs ?? 0, id: st.id ?? 0, gm,
        };
        break;
      }
      case "diode":
      case "breakdown":
        ops[dev.id] = { kind: dev.kind, type: dev.type, region: st.mode, i: e.i ?? 0 };
        break;
      case "opamp":
        ops[dev.id] = {
          kind: "opamp", type: dev.type, region: st.mode, vout: vOf(dev.pins[2]),
          aol: dev.aol, gbp: dev.gbp, railHighNet: dev.railHighNet, railLowNet: dev.railLowNet,
        };
        break;
      case "mirror":
        ops[dev.id] = { kind: "mirror", type: dev.type, region: "on", iref: st.iref ?? 0 };
        break;
      case "optocoupler":
        ops[dev.id] = { kind: dev.kind, type: dev.type, region: st.ledMode };
        break;
      case "scr":
      case "triac":
      case "diac":
        // region: 主端子が導通していれば "on"、していなければ "off"
        ops[dev.id] = { kind: dev.kind, type: dev.type, region: st.mode === "off" ? "off" : "on", gate: st.gateMode, i: e.i ?? 0 };
        break;
      case "vswitch":
        ops[dev.id] = { kind: dev.kind, type: dev.type, region: st.mode, i: e.i ?? 0 };
        break;
      case "mult":
        // AC 解析の線形化に使う: vout = k·(Y0·vx + X0·vy)
        ops[dev.id] = { kind: "mult", type: dev.type, region: "linear", k: dev.k, x: vOf(dev.pins[0]), y: vOf(dev.pins[1]) };
        break;
      default:
        ops[dev.id] = { kind: dev.kind, type: dev.type, region: "static" };
    }
  }
  return ops;
}

/**
 * 線形部分（stampLinear）＋非線形素子の連立方程式を、素子の状態が変わらなくなるまで反復して解きます。
 * 過渡解析（各時刻）から使う。devices の state は呼び出し間で保持される（前の時刻の状態から始める）。
 *
 * @param {object} args
 * @param {number} args.baseSize  線形部分の未知数の数（ノード数 + 線形電圧源数）
 * @param {(A: number[][], b: number[]) => void} args.stampLinear 線形部分をスタンプする関数
 * @param {(net: string) => number} args.idx ネット名 → 行番号（gnd は -1）
 * @param {Map<string, number>} args.nodeIdx
 * @param {Array<object>} args.devices createDevice で作った素子
 * @param {number} [args.maxIter]
 * @returns {{ x: number[] | null, branchRows: Array<object>, converged: boolean, iterations: number }}
 */
export function solveWithDevices({ baseSize, stampLinear, idx, nodeIdx, devices, maxIter = MAX_DEVICE_ITERATIONS }) {
  const assemble = () => {
    const size = baseSize + countDeviceBranches(devices);
    const A = Array.from({ length: size }, () => new Array(size).fill(0));
    const b = new Array(size).fill(0);
    stampLinear(A, b);
    const branchRows = stampDevices(A, b, idx, devices, baseSize);
    return { A, b, size, branchRows };
  };
  const r = solveDeviceLoop({ assemble, devices, nodeIdx, deviceBranchBase: baseSize, maxIter });
  return { x: r.x ?? null, branchRows: r.branchRows ?? [], converged: !!r.converged, iterations: r.iterations ?? 0 };
}

/**
 * 素子の状態反復（DC・過渡共通）。
 * OPAMP については毎回、帰還率 β = ∂(V+−V−)/∂Vout（出力を電圧源に置き換えて求める）を計算し、
 * DC ループ利得 Aol·β > 1（正帰還）なら線形動作の平衡点は不安定とみなして、出力をレールに
 * 張り付ける（updateDeviceStates の opamp）。実際のオペアンプはこの平衡点に留まれず、
 * どちらかの電源電圧へ振り切れる（コンパレータ・シュミットトリガ・無安定マルチバイブレータの動作、
 * +/− 入力を取り違えた増幅器が飽和するのと同じ）。
 *
 * @returns {{ x?: number[]|null, branchRows?: Array<object>, converged?: boolean, iterations?: number, empty?: boolean, failed?: boolean }}
 */
function solveDeviceLoop({ assemble, devices, nodeIdx, deviceBranchBase, maxIter = MAX_DEVICE_ITERATIONS }) {
  let x = null;
  let branchRows = [];
  let converged = false;
  let iterations = 0;
  let prevSignature = null;
  const opamps = devices.filter((d) => d.kind === "opamp");
  for (let iter = 0; iter < maxIter; iter++) {
    iterations++;
    const sys = assemble();
    if (sys.size === 0) return { empty: true, iterations };
    const solution = solveLinearSystem(sys.A, sys.b);
    if (!solution) return { x: null, failed: true, branchRows: sys.branchRows, iterations };
    x = solution;
    branchRows = sys.branchRows;
    if (devices.length === 0) {
      converged = true;
      break;
    }
    for (const dev of opamps) dev.loopBeta = opampFeedbackFactor(dev, assemble, nodeIdx, deviceBranchBase);
    const signature = updateDeviceStates(devices, { nodeIdx }, x, branchRows, deviceBranchBase);
    if (signature === prevSignature) {
      converged = true;
      break;
    }
    prevSignature = signature;
  }
  return { x, branchRows, converged, iterations };
}

/**
 * OPAMP の帰還率 β = ∂(V+ − V−)/∂Vout を返します（他の素子は現在の状態で線形化）。
 * 出力を電圧源に置き換えた回路に、出力電圧 1V だけを与えて（他の独立電源は 0）解いたときの V+−V−。
 * 負帰還なら β < 0、正帰還なら β > 0。
 */
function opampFeedbackFactor(dev, assemble, nodeIdx, deviceBranchBase) {
  dev.forceOut = 0;
  const sys = assemble();
  dev.forceOut = undefined;
  const k = sys.branchRows.findIndex((br) => br.deviceId === dev.id && br.role === "out");
  if (k < 0) return 0;
  const b = new Array(sys.size).fill(0);
  b[deviceBranchBase + k] = 1;
  const x = solveLinearSystem(sys.A, b);
  if (!x) return 0;
  const vAt = (net) => (isGroundNet(net) ? 0 : (x[nodeIdx.get(net)] ?? 0));
  return vAt(dev.pins[0]) - vAt(dev.pins[1]);
}

export { extractDeviceElements };

/* ==========================================================================
   DC シミュレーション本体
   ========================================================================== */

/**
 * DC シミュレーション本体。
 * @param {object} circuit { components, wires, nodes }
 * @returns {object}
 */
export function runDc(circuitIn, options = {}) {
  const errors = [];
  const warnings = [];

  // 未配線ピンを固有ネットへ、TP だけのネットを除外、浮いたネットを検出（netlist.js）
  const prep = prepareNetlist(applyModelDefaults(circuitIn.components, options));
  const circuit = { ...circuitIn, components: prep.components };
  warnings.push(...prep.warnings);
  const excludedNets = new Set(prep.unconnectedNets);
  const netInfo = { unconnectedNets: prep.unconnectedNets, floatingNets: prep.floatingNets };

  // --- ノード列挙 ---
  const nets = new Set();
  for (const c of circuit.components) {
    for (const pin of (c.connect || [])) {
      if (!isGroundNet(pin) && !excludedNets.has(pin)) nets.add(pin);
    }
  }
  const nodeList = Array.from(nets);
  const nodeIdx = new Map();
  nodeList.forEach((n, i) => nodeIdx.set(n, i));
  const N = nodeList.length;
  const idx = (net) => (isGroundNet(net) ? -1 : (nodeIdx.get(net) ?? -1));

  // --- 浮遊ノード検出 ---
  const floatingNodes = detectFloatingNodes(circuit);
  const skippedCaps = new Set();
  for (const c of circuit.components) {
    if (c.type !== "C") continue;
    const pins = c.connect || [];
    if (floatingNodes.has(pins[0]) || floatingNodes.has(pins[1])) {
      skippedCaps.add(c.id);
    }
  }

  // --- 素子を分類 ---
  const { resistors, vSources, iSources, devices } = classifyComponents(
    circuit.components,
    warnings
  );

  const ctx = {
    N,
    nodeIdx,
    idx,
    resistors,
    vSources,
    iSources,
    floatingNodes,
    skippedCaps,
    circuit,
  };

  // --- 非線形反復（OPAMP の正帰還による不安定平衡点の除去を含む） ---
  const loop = solveDeviceLoop({
    assemble: () => assembleSystem(ctx, devices),
    devices,
    nodeIdx,
    deviceBranchBase: N + vSources.length,
  });
  if (loop.empty) {
    return { ok: true, dc: { nodes: { gnd: 0 }, elements: {}, ...netInfo }, errors, warnings };
  }
  if (loop.failed || !loop.x) {
    errors.push(
      "DCシミュレーションで連立方程式を解けませんでした。浮遊ノードや短絡がないか確認してください。"
    );
    return { ok: false, dc: { nodes: {}, elements: {}, ...netInfo }, errors, warnings };
  }
  const x = loop.x;
  const converged = loop.converged;

  if (!converged && devices.length > 0) {
    warnings.push(
      "非線形素子の動作点が収束しませんでした（最大反復に到達）。結果は参考値として扱ってください。"
    );
  }

  // --- 結果抽出 ---
  const nodes = { gnd: 0 };
  for (const net of nodeList) {
    const i = nodeIdx.get(net);
    if (i !== undefined) nodes[net] = x[i];
  }
  const vOf = (net) => (isGroundNet(net) ? 0 : (nodes[net] ?? 0));

  const elements = {};
  for (const r of resistors) {
    const v = vOf(r.p) - vOf(r.n);
    const i = v * r.g;
    elements[r.id] = { v, i, p: v * i };
  }
  for (const cs of iSources) {
    const v = vOf(cs.p) - vOf(cs.n);
    elements[cs.id] = { v, i: cs.value, p: v * cs.value };
  }
  for (let k = 0; k < vSources.length; k++) {
    const vs = vSources[k];
    const v = vOf(vs.p) - vOf(vs.n);
    const i = x[N + k];
    elements[vs.id] = { v, i, p: v * i };
  }

  // 非線形素子の動作点（最終状態のブランチ対応表を使って抽出）
  const finalAssembled = assembleSystem(ctx, devices);
  const deviceElements = extractDeviceElements(
    devices,
    ctx,
    x,
    finalAssembled.branchRows,
    N + vSources.length
  );
  Object.assign(elements, deviceElements);
  const operatingPoints = describeOperatingPoints(devices, vOf, elements);

  return {
    ok: true,
    dc: { nodes: filterNodeResults(nodes, prep), elements, operatingPoints, converged: converged || devices.length === 0, ...netInfo },
    errors,
    warnings,
  };
}

/**
 * dc モードを registerSimulationMode に登録します。
 */
export function registerDcMode() {
  registerSimulationMode("dc", async (circuit, options) => runDc(circuit, options));
}

// import された時点で自動登録（setup.js での明示呼び出しも可）
registerDcMode();
