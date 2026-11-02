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
 *    - SCR / TRIAC: ゲート経路のみ評価（ゲート-カソード/MT1 間を
 *      Vgk / Vgt のダイオードとしてモデル化。アノード経路は DC 判定対象外）
 *    - DIAC: DC ではほぼ開放
 *    - U_WILSON / U_CASCODE: 参照端子に Vref の電圧源、出力に
 *      Iout ≈ Iref の電流源を持つブラックボックスカレントミラー
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
import { prepareNetlist, filterNodeResults, GMIN_NODE } from "./netlist.js";

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
const G_MIN = 1e-9;

/**
 * ダイオード系素子の ON 状態における直列抵抗（Ω）。
 * 理想電圧源のみだと同種素子の並列接続（ダイオードOR等）で
 * 電流分割が不定になり行列が特異するため、直列抵抗で決定論化する。
 * 10mA で 10mV の追加降下であり、判定許容誤差（1%以上）に影響しない。
 */
const RS_DIODE = 1;

/**
 * BJT ベース直列抵抗（Ω）。
 * ダイオード接続（カレントミラー等）で 2 つのベース・エミッタ間電圧源が
 * 並列になっても電流分割が確定するようにする。ベース電流 1mA で 10mV、
 * 通常のバイアス設計（数十µA）では 0.1mV 程度の影響しかない。
 */
const RB_BASE = 10;

/** 熱電圧（V）。params.Is の指数則 BJT モデルで使用する。 */
const VT_THERMAL = 0.026;

/** ツェナー / TVS の順方向電圧（V）。 */
const VF_ZENER_FORWARD = 0.7;

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
      case "U_WILSON":
      case "U_CASCODE":
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
    device.state = { mode: "off", current: 0 };
  } else if (BREAKDOWN_FAMILY[c.type]) {
    device.kind = "breakdown";
    device.vz = Math.max(getNumericParam(c, BREAKDOWN_FAMILY[c.type], 5.1), 0);
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
  } else if (c.type === "SCR") {
    device.kind = "scr";
    device.vgk = Math.max(getNumericParam(c, "Vgk", 0.8), 0);
    device.state = { gateMode: "off" };
  } else if (c.type === "TRIAC") {
    device.kind = "triac";
    device.vgt = Math.max(getNumericParam(c, "Vgt", 1.5), 0);
    device.state = { gateMode: "off" };
  } else if (c.type === "DIAC") {
    device.kind = "diac";
    device.vbo = Math.max(getNumericParam(c, "Vbo", 30), 0);
  } else if (MIRROR_TYPES.has(c.type)) {
    device.kind = "mirror";
    device.vref = Math.max(getNumericParam(c, "Vref", 1.4), 0);
    device.state = { iref: 0 };
  }

  return device;
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
  let branchCursor = N + M;

  for (const dev of devices) {
    const st = dev.state;

    switch (dev.kind) {
      case "diode": {
        const a = idx(dev.pins[0]);
        const k = idx(dev.pins[1]);
        if (st.mode === "on") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "forward" });
          stampVoltageBranch(A, b, a, k, row, dev.vf, RS_DIODE);
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
          stampVoltageBranch(A, b, a, k, row, VF_ZENER_FORWARD, RS_DIODE);
        } else if (st.mode === "breakdown") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "breakdown" });
          stampVoltageBranch(A, b, a, k, row, -dev.vz, RS_DIODE);
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
      case "triac": {
        // SCR: pins = [anode, gate, cathode] / TRIAC: pins = [mt2, gate, mt1]
        const main = idx(dev.pins[0]);
        const gate = idx(dev.pins[1]);
        const ref = idx(dev.pins[2]);
        if (st.gateMode === "on") {
          const row = branchCursor++;
          branchRows.push({ deviceId: dev.id, role: "gate" });
          const vf = dev.kind === "scr" ? dev.vgk : dev.vgt;
          stampVoltageBranch(A, b, gate, ref, row, vf, RS_DIODE);
        }
        stampConductance(A, gate, ref, G_MIN);
        stampConductance(A, main, ref, G_MIN); // アノード経路は DC 判定対象外
        break;
      }

      case "diac": {
        const m1 = idx(dev.pins[0]);
        const m2 = idx(dev.pins[1]);
        stampConductance(A, m1, m2, G_MIN);
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

      default:
        break;
    }
  }

  return { A, b, size, branchRows };
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
        if (dev.state.gateMode === "on") count += 1;
        break;
      case "mirror":
        count += 1;
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
      case "triac": {
        const gateNet = dev.pins[1];
        const refNet = dev.pins[2];
        const vGr = vOf(gateNet) - vOf(refNet);
        const vf = dev.kind === "scr" ? dev.vgk : dev.vgt;
        if (st.gateMode === "off") {
          if (vGr >= vf - 1e-12) st.gateMode = "on";
        } else {
          const ig = branchCurrent(dev.id, "gate");
          if (ig < 0) st.gateMode = "off";
        }
        parts.push(`${dev.id}:${st.gateMode}`);
        break;
      }

      case "mirror": {
        const iref = branchCurrent(dev.id, "ref");
        st.iref = Math.max(iref, 0);
        parts.push(`${dev.id}:mirror:${roundForSignature(st.iref)}`);
        break;
      }

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
      case "triac": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[2]);
        i = st.gateMode === "on" ? branchCurrent(dev.id, "gate") : 0;
        break;
      }
      case "diac": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[1]);
        i = v * G_MIN;
        break;
      }
      case "mirror": {
        v = vOf(dev.pins[0]) - vOf(dev.pins[2]);
        i = st.iref ?? 0;
        break;
      }
      default:
        break;
    }

    elements[dev.id] = { v, i, p: v * i };
  }

  return elements;
}

/* ==========================================================================
   DC シミュレーション本体
   ========================================================================== */

/**
 * DC シミュレーション本体。
 * @param {object} circuit { components, wires, nodes }
 * @returns {object}
 */
export function runDc(circuitIn) {
  const errors = [];
  const warnings = [];

  // 未配線ピンを固有ネットへ、TP だけのネットを除外、浮いたネットを検出（netlist.js）
  const prep = prepareNetlist(circuitIn.components);
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

  // --- 非線形反復 ---
  let x = null;
  let prevSignature = null;
  let converged = false;

  for (let iter = 0; iter < MAX_DEVICE_ITERATIONS; iter++) {
    const { A, b, size, branchRows } = assembleSystem(ctx, devices);

    if (size === 0) {
      return { ok: true, dc: { nodes: { gnd: 0 }, elements: {}, ...netInfo }, errors, warnings };
    }

    const solution = solveLinearSystem(A, b);
    if (!solution) {
      errors.push(
        "DCシミュレーションで連立方程式を解けませんでした。浮遊ノードや短絡がないか確認してください。"
      );
      return { ok: false, dc: { nodes: {}, elements: {}, ...netInfo }, errors, warnings };
    }

    x = solution;
    const signature = updateDeviceStates(
      devices,
      ctx,
      x,
      branchRows,
      N + vSources.length
    );

    if (signature === prevSignature) {
      converged = true;
      break;
    }
    prevSignature = signature;
  }

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

  return {
    ok: true,
    dc: { nodes: filterNodeResults(nodes, prep), elements, ...netInfo },
    errors,
    warnings,
  };
}

/**
 * dc モードを registerSimulationMode に登録します。
 */
export function registerDcMode() {
  registerSimulationMode("dc", async (circuit) => runDc(circuit));
}

// import された時点で自動登録（setup.js での明示呼び出しも可）
registerDcMode();
