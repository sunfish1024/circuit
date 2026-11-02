/**
 * 過渡（transient）シミュレーション
 *
 * 手法: 後退オイラー法（後退差分）によるコンパニオンモデル
 * 対応素子:
 *  - R:    conductance 1/R
 *  - C:    G = C/dt、履歴電流源 I_hist = (C/dt)·V_C_prev を p に注入
 *  - L:    G = dt/L、履歴電流源 i_L_prev を p から n へ流す
 *  - V_DC: 定電圧（MNA 追加変数で電流を求める）
 *  - V_AC: Vpk·sin(2πft+φ)（時間依存 RHS）
 *  - I_DC: 定電流
 *  - I_AC: Ipk·sin(2πft+φ)
 *  - SW:   closed=true で 1e3 S、false で 1e-12 S
 *  - GND:  0V 基準
 *
 * 初期条件:
 *  - C: params.initialV（無ければ 0V）
 *  - L: 0A
 *  - その他ノード: 0V（または initialV が接続されていればその電圧）
 *
 * 結果形式:
 *  {
 *    ok: true,
 *    transient: {
 *      time:  [t0, t1, ...],
 *      nodes: { gnd: [...], vin: [...], out: [...] },
 *      elements: { R1: { v: [...], i: [...] }, ... },
 *      timeConstant: 0.002,          // 回路パラメータから求めた支配的τ
 *      oscillationFrequencyHz: 1583.55,  // 減衰考慮の理論振動数
 *      waveformFrequencyHz: 1582.9,      // 波形（零交差）から推定
 *    },
 *    errors: [],
 *    warnings: [],
 *  }
 *
 * 備考:
 *  - 時間軸は `time` と各配列で同じ長さ・同じインデックス。
 *  - timeSec での値参照は、呼び出し側で線形補間することを推奨。
 *  - 「振動数」は減衰振動の包絡線を含む波形から零交差で推定。
 *  - t=0 の初期ノード電圧は近似（C の initialV のみ反映）。
 *    RL回路の t=0+ ステップ電圧などは t=dt 以降で正しく反映される。
 */

import { registerSimulationMode } from "./simulator.js";
import { parseMetricValue } from "../core/units.js";

/* ==========================================================================
   定数
   ========================================================================== */

const CLOSED_SWITCH_G = 1e3;
const OPEN_SWITCH_G = 1e-12;

const MAX_STEPS = 50000;
const DT_MIN = 1e-9;
const DT_MAX = 0.1;
const DEFAULT_T_STOP = 0.01;

/* ==========================================================================
   基本ヘルパ
   ========================================================================== */

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

function vOfNode(nodes, net) {
  if (isGroundNet(net)) return 0;
  return nodes[net] ?? 0;
}

/** 部分ピボット付きガウス消去法（実数）。特異なら null。 */
function solveLinearSystem(A, b) {
  const n = A.length;
  if (n === 0) return [];

  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-20) return null;
    if (pivotRow !== col) {
      [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c2 = col; c2 <= n; c2++) {
        M[r][c2] -= f * M[col][c2];
      }
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

/* ==========================================================================
   回路パラメータからの特性時間・振動数
   ========================================================================== */

function extractCharacteristicTimes(components) {
  const Rs = [];
  const Cs = [];
  const Ls = [];

  for (const c of components) {
    if (c.type === "R") Rs.push(Math.max(getNumericParam(c, "R", 1000), 1e-9));
    if (c.type === "C") Cs.push(Math.max(getNumericParam(c, "C", 1e-6), 1e-15));
    if (c.type === "L") Ls.push(Math.max(getNumericParam(c, "L", 1e-3), 1e-12));
  }

  const taus = [];
  for (const R of Rs) {
    for (const C of Cs) taus.push(R * C);
    for (const L of Ls) taus.push(L / R);
  }

  const periods = [];
  for (const L of Ls) {
    for (const C of Cs) periods.push(2 * Math.PI * Math.sqrt(L * C));
  }

  return { Rs, Cs, Ls, taus, periods };
}

/**
 * 支配的時定数 τ を回路パラメータから推定（高速側の最小値）。
 */
function computeTheoreticalTimeConstant(components) {
  const { taus } = extractCharacteristicTimes(components);
  if (taus.length === 0) return null;
  return Math.min(...taus);
}

/**
 * 減衰を考慮した理論振動数。
 * R が存在する場合は α = R/(2L)、ω_d = √(ω_n² − α²) を用いる。
 * 過減衰なら null を返す。
 */
function computeTheoreticalOscillationFrequency(components) {
  const { Rs, Cs, Ls, periods } = extractCharacteristicTimes(components);
  if (periods.length === 0) return null;

  if (Rs.length === 0) {
    return 1 / Math.min(...periods);
  }

  // 最も支配的な R と最小の L/C で代表させる（本問題群では妥当）
  const R = Math.max(...Rs);
  const L = Math.min(...Ls);
  const C = Math.min(...Cs);

  const alpha = R / (2 * L);
  const omegaN2 = 1 / (L * C);
  const omegaD2 = omegaN2 - alpha * alpha;
  if (omegaD2 <= 0) return null;
  return Math.sqrt(omegaD2) / (2 * Math.PI);
}

/**
 * 波形の零交差（定常値基準）から振動数を推定。
 * 減衰振動でも、振幅が十分残っている区間で安定に推定できる。
 */
function estimateWaveformFrequency(time, values) {
  if (!values || values.length < 8) return null;

  // 最終値の推定（末尾 10% の平均）
  const tailStart = Math.max(1, Math.floor(values.length * 0.9));
  let finalSum = 0;
  for (let i = tailStart; i < values.length; i++) finalSum += values[i];
  const finalValue = finalSum / (values.length - tailStart);

  // 上向き零交差を収集
  const crossings = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] - finalValue;
    const cur = values[i] - finalValue;
    if (prev < 0 && cur >= 0) {
      const denom = cur - prev;
      const frac = denom !== 0 ? -prev / denom : 0;
      crossings.push(time[i - 1] + frac * (time[i] - time[i - 1]));
    }
  }

  if (crossings.length < 2) return null;

  let sumInt = 0;
  for (let i = 1; i < crossings.length; i++) {
    sumInt += crossings[i] - crossings[i - 1];
  }
  return (crossings.length - 1) / sumInt;
}

/* ==========================================================================
   本体
   ========================================================================== */

/**
 * 過渡シミュレーション実行
 *
 * @param {object} circuit { components, wires, nodes }
 * @param {object} [options]
 * @param {number} [options.dt]         時間刻み（秒）。省略時は回路から自動決定
 * @param {number} [options.tStop]      終了時刻（秒）。省略時は自動
 * @param {Array}  [options.checks]     問題のchecks配列（timeSec参照に使用）
 * @returns {object}
 */
export function runTransient(circuit, options = {}) {
  const errors = [];
  const warnings = [];
  const components = circuit.components || [];

  /* --- dt/tStop 決定 --- */
  const { taus, periods } = extractCharacteristicTimes(components);
  const minTau = taus.length > 0 ? Math.min(...taus) : null;
  const minPeriod = periods.length > 0 ? Math.min(...periods) : null;

  // tStop
  let tStop;
  if (Number.isFinite(options.tStop) && options.tStop > 0) {
    tStop = options.tStop;
  } else {
    const candidates = [DEFAULT_T_STOP];
    if (minTau !== null) candidates.push(10 * minTau);
    if (minPeriod !== null) candidates.push(5 * minPeriod);
    if (Array.isArray(options.checks)) {
      for (const chk of options.checks) {
        if (Number.isFinite(chk?.timeSec)) {
          candidates.push(chk.timeSec * 1.5);
        }
      }
    }
    tStop = Math.max(...candidates);
  }

  // dt
  let dt;
  if (Number.isFinite(options.dt) && options.dt > 0) {
    dt = options.dt;
  } else {
    const candidates = [];
    if (minTau !== null) candidates.push(minTau / 100);
    if (minPeriod !== null) candidates.push(minPeriod / 100);
    dt = candidates.length > 0 ? Math.min(...candidates) : tStop / 100;
  }
  dt = Math.max(Math.min(dt, DT_MAX), DT_MIN);

  // ステップ数上限で tStop を再調整
  if (tStop / dt > MAX_STEPS) {
    tStop = dt * MAX_STEPS;
    warnings.push(
      `tStop を ${tStop.toExponential(2)}s に制限しました（MAX_STEPS=${MAX_STEPS}）`
    );
  }
  const numSteps = Math.max(1, Math.ceil(tStop / dt));

  /* --- ノード列挙 --- */
  const nets = new Set();
  for (const c of components) {
    for (const pin of (c.connect || [])) {
      if (!isGroundNet(pin)) nets.add(pin);
    }
  }
  const nodeList = Array.from(nets);
  const nodeIdx = new Map();
  nodeList.forEach((n, i) => nodeIdx.set(n, i));
  const N = nodeList.length;
  const idx = (net) => (isGroundNet(net) ? -1 : (nodeIdx.get(net) ?? -1));

  /* --- 素子分類・状態初期化 --- */
  const capState = new Map();
  const indState = new Map();
  const vSources = [];
  const iSources = [];

  for (const c of components) {
    if (c.type === "GND") continue;
    const pins = c.connect || [];
    if (pins.length < 2) continue;

    if (c.type === "C") {
      capState.set(c.id, {
        C: Math.max(getNumericParam(c, "C", 1e-6), 1e-15),
        v: getNumericParam(c, "initialV", 0),
        p: pins[0],
        n: pins[1],
      });
    } else if (c.type === "L") {
      indState.set(c.id, {
        L: Math.max(getNumericParam(c, "L", 1e-3), 1e-12),
        i: 0,
        p: pins[0],
        n: pins[1],
      });
    } else if (c.type === "V_DC" || c.type === "V_AC") {
      vSources.push({ id: c.id, type: c.type, comp: c, p: pins[0], n: pins[1] });
    } else if (c.type === "I_DC" || c.type === "I_AC") {
      iSources.push({ id: c.id, type: c.type, comp: c, p: pins[0], n: pins[1] });
    }
  }

  const M = vSources.length;
  const size = N + M;

  function vSourceValue(vs, t) {
    if (vs.type === "V_DC") return getNumericParam(vs.comp, "V", 0);
    const Vpk = getNumericParam(vs.comp, "Vpk", 0);
    const f = getNumericParam(vs.comp, "freqHz", 1000);
    const ph = (getNumericParam(vs.comp, "phaseDeg", 0) * Math.PI) / 180;
    return Vpk * Math.sin(2 * Math.PI * f * t + ph);
  }

  function iSourceValue(is, t) {
    if (is.type === "I_DC") return getNumericParam(is.comp, "I", 0);
    const Ipk = getNumericParam(is.comp, "Ipk", 0);
    const f = getNumericParam(is.comp, "freqHz", 1000);
    const ph = (getNumericParam(is.comp, "phaseDeg", 0) * Math.PI) / 180;
    return Ipk * Math.sin(2 * Math.PI * f * t + ph);
  }

  /* --- 結果配列の初期化（t=0 を含む） --- */
  const time = [0];
  const nodeArrays = { gnd: [0] };
  for (const net of nodeList) nodeArrays[net] = [0];

  // C の initialV が GND との間にあれば、そのノードの初期電圧に反映
  for (const c of components) {
    if (c.type !== "C") continue;
    const iV = getNumericParam(c, "initialV", 0);
    if (iV === 0) continue;
    const pins = c.connect || [];
    if (pins.length < 2) continue;
    const [p, n] = pins;
    if (isGroundNet(n) && !isGroundNet(p)) {
      nodeArrays[p][0] = iV;
    } else if (isGroundNet(p) && !isGroundNet(n)) {
      nodeArrays[n][0] = -iV;
    }
  }

  const elementArrays = {};
  for (const c of components) {
    if (c.type === "GND") continue;
    elementArrays[c.id] = { v: [0], i: [0] };
    if (capState.has(c.id)) elementArrays[c.id].v[0] = capState.get(c.id).v;
    if (indState.has(c.id)) elementArrays[c.id].i[0] = indState.get(c.id).i;
  }

  /* --- 時間ステップ積分 --- */
  for (let step = 1; step <= numSteps; step++) {
    const t = step * dt;

    const A = Array.from({ length: size }, () => new Array(size).fill(0));
    const b = new Array(size).fill(0);

    // R
    for (const c of components) {
      if (c.type !== "R") continue;
      const pins = c.connect || [];
      if (pins.length < 2) continue;
      const R = Math.max(getNumericParam(c, "R", 1000), 1e-9);
      const g = 1 / R;
      const p = idx(pins[0]);
      const n = idx(pins[1]);
      if (p >= 0) A[p][p] += g;
      if (n >= 0) A[n][n] += g;
      if (p >= 0 && n >= 0) {
        A[p][n] -= g;
        A[n][p] -= g;
      }
    }

    // C（BE コンパニオン）
    for (const [, st] of capState) {
      const g = st.C / dt;
      const p = idx(st.p);
      const n = idx(st.n);
      if (p >= 0) A[p][p] += g;
      if (n >= 0) A[n][n] += g;
      if (p >= 0 && n >= 0) {
        A[p][n] -= g;
        A[n][p] -= g;
      }
      if (p >= 0) b[p] += g * st.v;
      if (n >= 0) b[n] -= g * st.v;
    }

    // L（BE コンパニオン）
    for (const [, st] of indState) {
      const g = dt / st.L;
      const p = idx(st.p);
      const n = idx(st.n);
      if (p >= 0) A[p][p] += g;
      if (n >= 0) A[n][n] += g;
      if (p >= 0 && n >= 0) {
        A[p][n] -= g;
        A[n][p] -= g;
      }
      if (p >= 0) b[p] -= st.i;
      if (n >= 0) b[n] += st.i;
    }

    // SW
    for (const c of components) {
      if (c.type !== "SW") continue;
      const pins = c.connect || [];
      if (pins.length < 2) continue;
      const closed = c.params?.closed === true;
      const g = closed ? CLOSED_SWITCH_G : OPEN_SWITCH_G;
      const p = idx(pins[0]);
      const n = idx(pins[1]);
      if (p >= 0) A[p][p] += g;
      if (n >= 0) A[n][n] += g;
      if (p >= 0 && n >= 0) {
        A[p][n] -= g;
        A[n][p] -= g;
      }
    }

    // 電流源
    for (const is of iSources) {
      const val = iSourceValue(is, t);
      const p = idx(is.p);
      const n = idx(is.n);
      if (p >= 0) b[p] += val;
      if (n >= 0) b[n] -= val;
    }

    // 電圧源
    for (let k = 0; k < M; k++) {
      const vs = vSources[k];
      const p = idx(vs.p);
      const n = idx(vs.n);
      const row = N + k;
      if (p >= 0) {
        A[p][row] += 1;
        A[row][p] += 1;
      }
      if (n >= 0) {
        A[n][row] -= 1;
        A[row][n] -= 1;
      }
      b[row] = vSourceValue(vs, t);
    }

    const x = solveLinearSystem(A, b);
    if (!x) {
      errors.push(
        `過渡解析が step=${step} (t=${t.toExponential(2)}s) で解けませんでした。短絡・浮遊ノードを確認してください。`
      );
      break;
    }

    const nodes = { gnd: 0 };
    for (const net of nodeList) nodes[net] = x[nodeIdx.get(net)];

    time.push(t);
    nodeArrays.gnd.push(0);
    for (const net of nodeList) nodeArrays[net].push(nodes[net]);

    // 素子値の記録と状態更新
    for (const c of components) {
      if (c.type === "GND") continue;
      const arr = elementArrays[c.id];
      if (!arr) continue;

      let v = 0;
      let i = 0;

      if (c.type === "R") {
        const pins = c.connect;
        v = vOfNode(nodes, pins[0]) - vOfNode(nodes, pins[1]);
        i = v / Math.max(getNumericParam(c, "R", 1000), 1e-9);
      } else if (c.type === "C") {
        const st = capState.get(c.id);
        const vNew = vOfNode(nodes, st.p) - vOfNode(nodes, st.n);
        const iNew = (st.C / dt) * (vNew - st.v);
        st.v = vNew;
        v = vNew;
        i = iNew;
      } else if (c.type === "L") {
        const st = indState.get(c.id);
        const vNew = vOfNode(nodes, st.p) - vOfNode(nodes, st.n);
        const iNew = st.i + (dt / st.L) * vNew;
        st.i = iNew;
        v = vNew;
        i = iNew;
      } else if (c.type === "V_DC" || c.type === "V_AC") {
        const pins = c.connect;
        v = vOfNode(nodes, pins[0]) - vOfNode(nodes, pins[1]);
        const k = vSources.findIndex((s) => s.id === c.id);
        i = k >= 0 ? x[N + k] : 0;
      } else if (c.type === "I_DC" || c.type === "I_AC") {
        const pins = c.connect;
        v = vOfNode(nodes, pins[0]) - vOfNode(nodes, pins[1]);
        const is = iSources.find((s) => s.id === c.id);
        i = is ? iSourceValue(is, t) : 0;
      } else if (c.type === "SW") {
        const pins = c.connect;
        v = vOfNode(nodes, pins[0]) - vOfNode(nodes, pins[1]);
        const g = c.params?.closed === true ? CLOSED_SWITCH_G : OPEN_SWITCH_G;
        i = v * g;
      }

      arr.v.push(v);
      arr.i.push(i);
    }
  }

  /* --- 派生結果 --- */
  const timeConstant = computeTheoreticalTimeConstant(components);
  const oscFreq = computeTheoreticalOscillationFrequency(components);

  let waveformFreq = null;
  if (errors.length === 0) {
    let bestNode = null;
    let bestVar = 0;
    for (const net of nodeList) {
      const arr = nodeArrays[net];
      if (arr.length < 8) continue;
      let mean = 0;
      for (const v of arr) mean += v;
      mean /= arr.length;
      let variance = 0;
      for (const v of arr) variance += (v - mean) ** 2;
      variance /= arr.length;
      if (variance > bestVar) {
        bestVar = variance;
        bestNode = net;
      }
    }
    if (bestNode) {
      waveformFreq = estimateWaveformFrequency(time, nodeArrays[bestNode]);
    }
  }

  return {
    ok: errors.length === 0,
    transient: {
      time,
      nodes: nodeArrays,
      elements: elementArrays,
      timeConstant,
      oscillationFrequencyHz: oscFreq,
      waveformFrequencyHz: waveformFreq,
      dt,
      tStop,
      steps: time.length,
    },
    errors,
    warnings,
  };
}

export function registerTransientMode() {
  registerSimulationMode("transient", async (circuit, options) =>
    runTransient(circuit, options)
  );
}

// モジュール読み込み時に自動登録
registerTransientMode();