/**
 * AC 定常状態シミュレーション（複素 MNA: Modified Nodal Analysis）
 *
 * 対応素子:
 *  - R:    admittance 1/R (real)
 *  - C:    admittance jωC
 *  - L:    admittance 1/(jωL) = -j/(ωL)
 *  - V_AC: 交流電圧源（複素フェーザ Vpk·e^{jφ}）
 *  - I_AC: 交流電流源（複素フェーザ Ipk·e^{jφ}）
 *  - V_DC / V_PULSE: AC では短絡（0V 電圧源として扱う）
 *  - L_RELAY: L と同じ
 *  - TP / GND: 電気的には何もしない
 *  - 解析周波数: 電源の freqHz と options.checks の frequencyHz すべて
 *    （options.frequencies 指定時はそれだけ）
 *  - I_DC: AC では開放（寄与なし）
 *  - SW:   closed=true で微小抵抗、false で高抵抗
 *
 * 結果形式:
 *  {
 *    ok: true,
 *    ac: {
 *      frequencies: [1000],
 *      primaryFrequency: 1000,
 *      nodes: {
 *        gnd: { "1000": { re, im, peak, rms, phaseDeg } },
 *        vin: { "1000": { re, im, peak, rms, phaseDeg } },
 *        out: { "1000": { re, im, peak, rms, phaseDeg } },
 *      },
 *      elements: {
 *        R1: { "1000": { v: {...}, i: {...}, p: { re, im } } },
 *        V1: { "1000": { v: {...}, i: {...}, p: { re, im } } },
 *      },
 *    },
 *    errors: [],
 *    warnings: [],
 *  }
 *
 * 備考:
 *  - 周波数キーは JS オブジェクトの慣習で文字列化されますが、
 *    チェッカー側が数値 frequencyHz でアクセスする場合と同じキーになります。
 *  - V_AC / I_AC の Vpk・Ipk は「ピーク値」です。rms フィールドに
 *    peak/√2 を格納しています。
 *  - phaseDeg は各素子・ノードの絶対位相です。bodePoint の相対位相は
 *    チェッカー側で `phase(out) - phase(in)` として計算してください。
 *  - 入力・出力のノード名は回路の net 名（vin, out 等）そのままです。
 */

import { registerSimulationMode } from "./simulator.js";
import { parseMetricValue } from "../core/units.js";
import { prepareNetlist, filterNodeResults, GMIN_NODE } from "./netlist.js";

const SQRT2 = Math.SQRT2;
const DEFAULT_FREQUENCY_HZ = 1000;

/** 閉じたスイッチの等価コンダクタンス */
const CLOSED_SWITCH_G = 1e3;

/** 開いたスイッチの等価コンダクタンス */
const OPEN_SWITCH_G = 1e-12;

/* ==========================================================================
   複素数ヘルパ
   ========================================================================== */

const C = {
  add: (a, b) => ({ re: a.re + b.re, im: a.im + b.im }),
  sub: (a, b) => ({ re: a.re - b.re, im: a.im - b.im }),
  mul: (a, b) => ({
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  }),
  div: (a, b) => {
    const d = b.re * b.re + b.im * b.im;
    if (d === 0) return { re: NaN, im: NaN };
    return {
      re: (a.re * b.re + a.im * b.im) / d,
      im: (a.im * b.re - a.re * b.im) / d,
    };
  },
  abs: (a) => Math.hypot(a.re, a.im),
  arg: (a) => Math.atan2(a.im, a.re),
  conj: (a) => ({ re: a.re, im: -a.im }),
  zero: () => ({ re: 0, im: 0 }),
  one: () => ({ re: 1, im: 0 }),
  fromPolar: (mag, rad) => ({
    re: mag * Math.cos(rad),
    im: mag * Math.sin(rad),
  }),
};

/**
 * 複素フェーザを表示用オブジェクトへ変換します。
 *  re/im のほか、peak（振幅）、rms（実効値）、phaseDeg（度）を含みます。
 */
function describeComplex(z) {
  const peak = C.abs(z);
  return {
    re: z.re,
    im: z.im,
    peak,
    rms: peak / SQRT2,
    phaseDeg: (Math.atan2(z.im, z.re) * 180) / Math.PI,
  };
}

/* ==========================================================================
   パラメータ・ネット名ヘルパ
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

/* ==========================================================================
   複素連立一次方程式（部分ピボット付きガウス消去）
   ========================================================================== */

function solveComplexLinearSystem(A, b) {
  const n = A.length;
  if (n === 0) return [];

  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotMag = C.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const m = C.abs(M[r][col]);
      if (m > pivotMag) {
        pivotMag = m;
        pivotRow = r;
      }
    }
    if (!Number.isFinite(pivotMag) || pivotMag < 1e-20) {
      return null;
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const factor = C.div(M[r][col], M[col][col]);
      if (C.abs(factor) < 1e-30) continue;
      for (let c2 = col; c2 <= n; c2++) {
        M[r][c2] = C.sub(M[r][c2], C.mul(factor, M[col][c2]));
      }
    }
  }

  const x = new Array(n).fill(null).map(() => C.zero());
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) {
      s = C.sub(s, C.mul(M[i][j], x[j]));
    }
    x[i] = C.div(s, M[i][i]);
    if (!Number.isFinite(x[i].re) || !Number.isFinite(x[i].im)) {
      return null;
    }
  }
  return x;
}

/* ==========================================================================
   解析周波数の抽出
   ========================================================================== */

function extractFrequencies(circuit, options) {
  if (Array.isArray(options?.frequencies) && options.frequencies.length > 0) {
    const list = options.frequencies.filter((f) => Number.isFinite(f) && f > 0);
    return { frequencies: list, primary: list[0] ?? null };
  }

  // 電源の周波数（先頭を primaryFrequency とする）
  const sourceFreqs = [];
  for (const c of circuit.components) {
    if (c.type === "V_AC" || c.type === "I_AC") {
      const f = getNumericParam(c, "freqHz", 0);
      if (Number.isFinite(f) && f > 0 && !sourceFreqs.includes(f)) sourceFreqs.push(f);
    }
  }
  const primary = sourceFreqs.length > 0 ? sourceFreqs[0] : DEFAULT_FREQUENCY_HZ;

  // checks の frequencyHz も解析する（線形 AC 解析なので、電源振幅のまま
  // 任意の周波数で解いてよい。1つの電源で複数周波数の利得を判定できる）
  const freqs = new Set([primary, ...sourceFreqs]);
  if (Array.isArray(options?.checks)) {
    for (const chk of options.checks) {
      const f = chk?.frequencyHz;
      if (Number.isFinite(f) && f > 0) freqs.add(f);
    }
  }

  return {
    frequencies: Array.from(freqs).sort((a, b) => a - b),
    primary,
  };
}

/* ==========================================================================
   単一周波数での複素 MNA
   ========================================================================== */

function solveAtFrequency(circuit, freq, warnings, excludedNets = new Set()) {
  const omega = 2 * Math.PI * freq;

  // --- ノード列挙（TP だけのネットなど未接続ネットは除外） ---
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

  // --- 素子分類 ---
  const branches = []; // アドミタンス素子 { id, p, n, y }
  const vSources = []; // { id, p, n, value }
  const iSources = []; // { id, p, n, value }

  for (const c of circuit.components) {
    if (c.type === "GND") continue;
    const pins = Array.isArray(c.connect) ? c.connect : [];
    if (pins.length < 2) continue;
    const p = pins[0];
    const n = pins[1];

    switch (c.type) {
      case "R": {
        const R = Math.max(getNumericParam(c, "R", 1000), 1e-9);
        branches.push({ id: c.id, p, n, y: { re: 1 / R, im: 0 } });
        break;
      }
      case "C": {
        const Cval = getNumericParam(c, "C", 1e-6);
        branches.push({ id: c.id, p, n, y: { re: 0, im: omega * Cval } });
        break;
      }
      case "L":
      case "L_RELAY": {
        const L = Math.max(getNumericParam(c, "L", 1e-3), 1e-12);
        branches.push({ id: c.id, p, n, y: { re: 0, im: -1 / (omega * L) } });
        break;
      }
      case "V_AC": {
        const Vpk = getNumericParam(c, "Vpk", 0);
        const phaseDeg = getNumericParam(c, "phaseDeg", 0);
        vSources.push({
          id: c.id,
          p,
          n,
          value: C.fromPolar(Vpk, (phaseDeg * Math.PI) / 180),
        });
        break;
      }
      case "V_DC":
      case "V_PULSE": {
        // AC では短絡（0V 電圧源）。V_PULSE も小信号的には 0V 源として扱う
        vSources.push({ id: c.id, p, n, value: C.zero() });
        break;
      }
      case "I_AC": {
        const Ipk = getNumericParam(c, "Ipk", 0);
        const phaseDeg = getNumericParam(c, "phaseDeg", 0);
        iSources.push({
          id: c.id,
          p,
          n,
          value: C.fromPolar(Ipk, (phaseDeg * Math.PI) / 180),
        });
        break;
      }
      case "I_DC":
        // AC では開放 → 寄与なし
        break;
      case "SW": {
        const closed = c.params?.closed === true;
        const g = closed ? CLOSED_SWITCH_G : OPEN_SWITCH_G;
        branches.push({ id: c.id, p, n, y: { re: g, im: 0 } });
        break;
      }
      case "WIRE":
        branches.push({ id: c.id, p, n, y: { re: CLOSED_SWITCH_G, im: 0 } });
        break;
      default:
        warnings.push(`AC解析では未対応の部品です（無視されます）: ${c.id} (${c.type})`);
    }
  }

  const M = vSources.length;
  const size = N + M;
  if (size === 0) {
    return {
      nodes: { gnd: { [freq]: describeComplex(C.zero()) } },
      elements: {},
    };
  }

  // --- MNA 行列構築（複素） ---
  const A = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => C.zero())
  );
  const b = new Array(size).fill(null).map(() => C.zero());

  // 全ノードに Gmin（浮いたノードがあっても解けるように）
  for (let i = 0; i < N; i++) A[i][i] = C.add(A[i][i], { re: GMIN_NODE, im: 0 });

  // アドミタンススタンプ
  for (const br of branches) {
    const p = idx(br.p);
    const n = idx(br.n);
    if (p >= 0) A[p][p] = C.add(A[p][p], br.y);
    if (n >= 0) A[n][n] = C.add(A[n][n], br.y);
    if (p >= 0 && n >= 0) {
      A[p][n] = C.sub(A[p][n], br.y);
      A[n][p] = C.sub(A[n][p], br.y);
    }
  }

  // 電流源スタンプ
  for (const cs of iSources) {
    const p = idx(cs.p);
    const n = idx(cs.n);
    if (p >= 0) b[p] = C.add(b[p], cs.value);
    if (n >= 0) b[n] = C.sub(b[n], cs.value);
  }

  // 電圧源スタンプ
  for (let k = 0; k < M; k++) {
    const vs = vSources[k];
    const p = idx(vs.p);
    const n = idx(vs.n);
    const row = N + k;
    if (p >= 0) {
      A[p][row] = C.add(A[p][row], C.one());
      A[row][p] = C.add(A[row][p], C.one());
    }
    if (n >= 0) {
      A[n][row] = C.sub(A[n][row], C.one());
      A[row][n] = C.sub(A[row][n], C.one());
    }
    b[row] = vs.value;
  }

  // --- 解く ---
  const x = solveComplexLinearSystem(A, b);
  if (!x) {
    return null;
  }

  // --- ノード電圧 ---
  const nodes = {};
  nodes.gnd = { [freq]: describeComplex(C.zero()) };
  for (const net of nodeList) {
    const i = nodeIdx.get(net);
    if (i !== undefined) {
      nodes[net] = { [freq]: describeComplex(x[i]) };
    }
  }

  const vOf = (net) =>
    isGroundNet(net) ? C.zero() : (x[nodeIdx.get(net)] ?? C.zero());

  // --- 素子電圧・電流・複素電力 ---
  const elements = {};

  for (const br of branches) {
    const v = C.sub(vOf(br.p), vOf(br.n));
    const i = C.mul(v, br.y);
    const s = C.mul(v, C.conj(i)); // 複素電力 S = V·I*
    elements[br.id] = {
      [freq]: {
        v: describeComplex(v),
        i: describeComplex(i),
        p: { re: s.re, im: s.im },
      },
    };
  }

  for (const cs of iSources) {
    const v = C.sub(vOf(cs.p), vOf(cs.n));
    const s = C.mul(v, C.conj(cs.value));
    elements[cs.id] = {
      [freq]: {
        v: describeComplex(v),
        i: describeComplex(cs.value),
        p: { re: s.re, im: s.im },
      },
    };
  }

  for (let k = 0; k < M; k++) {
    const vs = vSources[k];
    const v = C.sub(vOf(vs.p), vOf(vs.n));
    const i = x[N + k];
    const s = C.mul(v, C.conj(i));
    elements[vs.id] = {
      [freq]: {
        v: describeComplex(v),
        i: describeComplex(i),
        p: { re: s.re, im: s.im },
      },
    };
  }

  return { nodes, elements };
}

/* ==========================================================================
   公開 API
   ========================================================================== */

export function runAc(circuitIn, options = {}) {
  const errors = [];
  const warnings = [];

  // 未配線ピン・TP だけのネット・浮いたネットの前処理（netlist.js）
  const prep = prepareNetlist(circuitIn.components);
  const circuit = { ...circuitIn, components: prep.components };
  warnings.push(...prep.warnings);
  const excludedNets = new Set(prep.unconnectedNets);

  const { frequencies, primary } = extractFrequencies(circuit, options);

  if (frequencies.length === 0) {
    return {
      ok: true,
      ac: { frequencies: [], primaryFrequency: null, nodes: {}, elements: {} },
      errors,
      warnings,
    };
  }

  const allNodes = {};
  const allElements = {};

  for (const freq of frequencies) {
    const res = solveAtFrequency(circuit, freq, warnings, excludedNets);
    if (!res) {
      errors.push(
        `AC シミュレーションに失敗しました（${freq} Hz）。浮遊ノードや短絡がないか確認してください。`
      );
      continue;
    }
    for (const [net, freqMap] of Object.entries(res.nodes)) {
      if (!allNodes[net]) allNodes[net] = {};
      Object.assign(allNodes[net], freqMap);
    }
    for (const [id, freqMap] of Object.entries(res.elements)) {
      if (!allElements[id]) allElements[id] = {};
      Object.assign(allElements[id], freqMap);
    }
  }

  return {
    ok: errors.length === 0,
    ac: {
      frequencies,
      primaryFrequency: primary,
      nodes: filterNodeResults(allNodes, prep),
      unconnectedNets: prep.unconnectedNets,
      floatingNets: prep.floatingNets,
      elements: allElements,
    },
    errors,
    warnings,
  };
}

export function registerAcMode() {
  registerSimulationMode("ac", async (circuit, options) =>
    runAc(circuit, options)
  );
}

// モジュール読み込み時に自動登録（dc.js と同じパターン）
registerAcMode();