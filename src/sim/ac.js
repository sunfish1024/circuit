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
 * 非線形素子（小信号モデル）:
 *  回路に非線形素子があると、まず DC 解析（dc.js の runDc、V_AC は 0V・I_AC は 0A、
 *  V_PULSE は Vlow の直流）で動作点を求め、その点で線形化した小信号モデルを使う
 *  （SPICE の .AC と同じ）。熱電圧 VT = 26mV（dc.js の VT_THERMAL）。
 *  - Q_NPN / Q_PNP（ハイブリッドπ）: 活性領域なら B-E 間に rπ = β/gm、C→E に
 *    電流源 gm·v_be（gm = |IC|/VT）。出力抵抗 ro（アーリー効果）は無し（∞）。
 *    DC の VBE 一定モデルの微分（gm=∞）ではなく教科書どおり gm = IC/VT を使う。
 *    ベース直列抵抗（DC の 10Ω）も AC では入れない。飽和: B-E 10Ω, C-E 短絡（1mΩ）。遮断: 開放。
 *  - M_N / M_P: 飽和領域なら D→S に gm·v_gs（gm = K·(VGS−|Vth|) = √(2K·ID)）、ゲート電流 0、
 *    ro = ∞（チャネル長変調なし）。線形領域は抵抗 1/(K·Vov)、K=0（スイッチ）は ON で RdsOn。
 *  - J_N: D→S に gm·v_gs（gm = −2·IDSS/VGS(off)·(1−VGS/VGS(off))）。
 *  - D / SD / LED / ZD / TVS: 導通（降伏）中は 1Ω（DC モデルの直列抵抗と同じ）、オフは開放。
 *  - OPAMP: 線形領域なら Vout = A(f)·(V+ − V−)、A(f) = Aol / (1 + j·f/fp)、fp = GBP/Aol
 *    （1 次遅れの単一極。GBP ≤ 0 なら周波数特性なし）。入力電流 0、出力抵抗 0。
 *    DC 動作点で飽和していれば出力はレール（電源ピンのノード、未配線なら固定電位）に固定。
 *  - U_WILSON / U_CASCODE: 参照端子 0V（短絡）、出力は理想電流源（開放）。
 *
 * 判定用の追加解析（options.checks から自動）:
 *  - check.sources（例 { "V2": { "phaseDeg": 0 } }）がある判定は、その電源パラメータに
 *    置き換えた回路でも解き、ac.variants[acVariantKey(sources)] に入れる（差動/同相入力の切替用）。
 *  - acImpedance 判定は、独立電源をすべて 0（電圧源は短絡・電流源は開放）にし、exclude の部品を
 *    取り除いて、node−nodeRef 間に 1A を注入した電圧 = インピーダンスを ac.impedances に入れる。
 *    非線形素子の線形化には元の回路の DC 動作点を使う。
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
import { runDc, NONLINEAR_TYPES, RS_DIODE, RB_BASE, G_MIN } from "./dc.js";

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

/** 線形化に使う「動作点が無い」場合の扱い（開放） */
const OPEN_Y = { re: G_MIN, im: 0 };

/** 飽和 BJT の C-E 間（DC では VCEsat の電圧源）の小信号コンダクタンス */
const SAT_CE_G = 1e3;

/**
 * 1 つの周波数で複素 MNA を解きます。
 *
 * @param {Array<object>} components 前処理済みの部品
 * @param {number} freq
 * @param {string[]} warnings
 * @param {Set<string>} excludedNets
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.ops] 非線形素子の DC 動作点（dc.operatingPoints）
 * @param {Record<string, object>} [opts.overrides] 部品ID → 置き換える params（電源の切替用）
 * @param {boolean} [opts.zeroSources] 独立電源をすべて 0 にする（インピーダンス計算用）
 * @param {{node: string, ref: string}} [opts.inject] node−ref 間に 1A を注入（ref→外部→node の向き）
 * @param {boolean} [opts.quiet] 警告を出さない
 */
function solveAtFrequency(components, freq, warnings, excludedNets = new Set(), opts = {}) {
  const { ops = {}, overrides = null, zeroSources = false, inject = null, quiet = false } = opts;
  const omega = 2 * Math.PI * freq;
  const warn = (m) => { if (!quiet && !warnings.includes(m)) warnings.push(m); };

  // --- ノード列挙（TP だけのネットなど未接続ネットは除外） ---
  const nets = new Set();
  for (const c of components) {
    for (const pin of (c.connect || [])) {
      if (!isGroundNet(pin) && !excludedNets.has(pin)) nets.add(pin);
    }
  }
  if (inject) {
    for (const n of [inject.node, inject.ref]) if (!isGroundNet(n) && !excludedNets.has(n)) nets.add(n);
  }
  const nodeList = Array.from(nets);
  const nodeIdx = new Map();
  nodeList.forEach((n, i) => nodeIdx.set(n, i));
  const N = nodeList.length;
  const idx = (net) => (isGroundNet(net) ? -1 : (nodeIdx.get(net) ?? -1));

  // --- 素子分類 ---
  const branches = []; // アドミタンス素子 { id, p, n, y }
  const vSources = []; // { id, p, n, value, ctrl: [[net, coef]] }  V(p)−V(n)−Σcoef·V(net) = value
  const iSources = []; // { id, p, n, value }  p から外部回路へ value を流し出す
  const vccs = [];     // { id, a, b, cp, cn, gm }  a→（素子内）→b へ gm·(V(cp)−V(cn)) が流れる
  const deviceOut = []; // 素子の小信号電圧・電流の記録用

  for (const c0 of components) {
    if (c0.type === "GND") continue;
    const c = overrides?.[c0.id] ? { ...c0, params: { ...(c0.params || {}), ...overrides[c0.id] } } : c0;
    const pins = Array.isArray(c.connect) ? c.connect : [];
    if (pins.length < 2) continue;
    const p = pins[0];
    const n = pins[1];
    const op = ops[c.id];

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
        const Vpk = zeroSources ? 0 : getNumericParam(c, "Vpk", 0);
        const phaseDeg = getNumericParam(c, "phaseDeg", 0);
        vSources.push({ id: c.id, p, n, value: C.fromPolar(Vpk, (phaseDeg * Math.PI) / 180) });
        break;
      }
      case "V_DC":
      case "V_PULSE": {
        // AC では短絡（0V 電圧源）。V_PULSE も小信号的には 0V 源として扱う
        vSources.push({ id: c.id, p, n, value: C.zero() });
        break;
      }
      case "I_AC": {
        if (zeroSources) break; // 電流源を 0 にする = 開放
        const Ipk = getNumericParam(c, "Ipk", 0);
        const phaseDeg = getNumericParam(c, "phaseDeg", 0);
        iSources.push({ id: c.id, p, n, value: C.fromPolar(Ipk, (phaseDeg * Math.PI) / 180) });
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

      // ---------------- 非線形素子（DC 動作点で線形化） ----------------
      case "D":
      case "SD":
      case "LED":
      case "ZD":
      case "TVS": {
        const on = op && op.region !== "off";
        branches.push({ id: c.id, p, n, y: on ? { re: 1 / RS_DIODE, im: 0 } : OPEN_Y });
        break;
      }
      case "Q_NPN":
      case "Q_PNP": {
        const [cN, bN, eN] = pins;
        if (!op) warn(`AC解析: ${c.id} の動作点がありません（開放として扱います）`);
        if (op?.region === "active") {
          branches.push({ id: `${c.id}#rpi`, p: bN, n: eN, y: { re: op.gm / op.beta, im: 0 } });
          vccs.push({ id: c.id, a: cN, b: eN, cp: bN, cn: eN, gm: op.gm });
          deviceOut.push({ id: c.id, vp: cN, vn: eN, gm: op.gm, cp: bN, cn: eN });
        } else if (op?.region === "saturation") {
          branches.push({ id: `${c.id}#be`, p: bN, n: eN, y: { re: 1 / RB_BASE, im: 0 } });
          branches.push({ id: `${c.id}#ce`, p: cN, n: eN, y: { re: SAT_CE_G, im: 0 } });
        } else {
          branches.push({ id: `${c.id}#be`, p: bN, n: eN, y: OPEN_Y });
          branches.push({ id: `${c.id}#ce`, p: cN, n: eN, y: OPEN_Y });
        }
        break;
      }
      case "M_N":
      case "M_P":
      case "J_N": {
        const [dN, gN, sN] = pins;
        if (!op) warn(`AC解析: ${c.id} の動作点がありません（開放として扱います）`);
        if (op && op.gm > 0) {
          vccs.push({ id: c.id, a: dN, b: sN, cp: gN, cn: sN, gm: op.gm });
          deviceOut.push({ id: c.id, vp: dN, vn: sN, gm: op.gm, cp: gN, cn: sN });
        }
        const gds = op?.gds > 0 ? op.gds : G_MIN;
        branches.push({ id: `${c.id}#ds`, p: dN, n: sN, y: { re: gds, im: 0 } });
        break;
      }
      case "OPAMP": {
        const [inP, inM, out] = pins;
        if (!op) warn(`AC解析: ${c.id} の動作点がありません`);
        if (!op || op.region === "linear") {
          const aol = Math.max(getNumericParam(c, "Aol", 1e5), 1);
          const gbp = getNumericParam(c, "GBP", 1e6);
          // A(f) = Aol / (1 + j f/fp)、fp = GBP/Aol（GBP ≤ 0 なら周波数特性なし）
          let A = { re: aol, im: 0 };
          if (gbp > 0) A = C.div({ re: aol, im: 0 }, { re: 1, im: (freq * aol) / gbp });
          vSources.push({
            id: c.id, p: out, n: "gnd", value: C.zero(),
            ctrl: [[inP, A], [inM, { re: -A.re, im: -A.im }]],
          });
        } else {
          const railNet = op.region === "satHigh" ? op.railHighNet : op.railLowNet;
          vSources.push({ id: c.id, p: out, n: railNet ?? "gnd", value: C.zero() });
        }
        break;
      }
      case "U_WILSON":
      case "U_CASCODE":
        // 参照端子は Vref の電圧源 → AC では短絡。出力は理想電流源 → 開放
        vSources.push({ id: c.id, p: pins[0], n: pins[2], value: C.zero() });
        break;
      default:
        warn(`AC解析では未対応の部品です（無視されます）: ${c.id} (${c.type})`);
    }
  }

  if (inject) iSources.push({ id: "__inject", p: inject.node, n: inject.ref ?? "gnd", value: C.one() });

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

  // 電圧制御電流源（トランジスタの gm）
  for (const g of vccs) {
    const a = idx(g.a);
    const bb = idx(g.b);
    const cp = idx(g.cp);
    const cn = idx(g.cn);
    const gm = { re: g.gm, im: 0 };
    for (const [row, sign] of [[a, 1], [bb, -1]]) {
      if (row < 0) continue;
      if (cp >= 0) A[row][cp] = C.add(A[row][cp], { re: sign * gm.re, im: 0 });
      if (cn >= 0) A[row][cn] = C.sub(A[row][cn], { re: sign * gm.re, im: 0 });
    }
  }

  // 電流源スタンプ
  for (const cs of iSources) {
    const p = idx(cs.p);
    const n = idx(cs.n);
    if (p >= 0) b[p] = C.add(b[p], cs.value);
    if (n >= 0) b[n] = C.sub(b[n], cs.value);
  }

  // 電圧源スタンプ（制御項つき: 電圧制御電圧源）
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
    for (const [net, coef] of vs.ctrl ?? []) {
      const j = idx(net);
      if (j >= 0) A[row][j] = C.sub(A[row][j], coef);
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
    if (br.id.includes("#")) continue; // 素子内部の小信号要素は出さない
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
    if (cs.id === "__inject") continue;
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

  // トランジスタ: v = V(C/D) − V(E/S)、i = 小信号コレクタ（ドレイン）電流 gm·v_be(gs)
  for (const d of deviceOut) {
    const v = C.sub(vOf(d.vp), vOf(d.vn));
    const vc = C.sub(vOf(d.cp), vOf(d.cn));
    const i = { re: d.gm * vc.re, im: d.gm * vc.im };
    const s = C.mul(v, C.conj(i));
    elements[d.id] = { [freq]: { v: describeComplex(v), i: describeComplex(i), p: { re: s.re, im: s.im } } };
  }

  return { nodes, elements };
}

/* ==========================================================================
   判定用キー（runner.js と共通）
   ========================================================================== */

/** 電源の置き換え指定（check.sources）から ac.variants のキーを作ります。 */
export function acVariantKey(sources) {
  if (!sources || typeof sources !== "object") return "";
  const ids = Object.keys(sources).sort();
  return JSON.stringify(ids.map((id) => [id, Object.keys(sources[id] || {}).sort().map((k) => [k, sources[id][k]])]));
}

/** acImpedance 判定から ac.impedances のキーを作ります。 */
export function acImpedanceKey(check) {
  const exclude = Array.isArray(check?.exclude) ? [...check.exclude].map(String).sort() : [];
  return JSON.stringify([check?.node ?? "", check?.nodeRef ?? "gnd", exclude]);
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

  // --- 非線形素子があれば DC 動作点を求める ---
  let ops = {};
  let operatingPoints = null;
  if (circuit.components.some((c) => NONLINEAR_TYPES.has(c.type))) {
    const opComponents = circuit.components.map((c) =>
      c.type === "V_PULSE"
        ? { ...c, type: "V_DC", params: { V: getNumericParam(c, "Vlow", 0) } }
        : c
    );
    const dcRes = runDc({ ...circuit, components: opComponents });
    for (const w of dcRes.warnings || []) {
      if (!prep.warnings.includes(w)) warnings.push(`動作点: ${w}`);
    }
    if (!dcRes.ok) {
      errors.push("AC解析の前に DC 動作点を求められませんでした。" + (dcRes.errors || []).join(" "));
      return { ok: false, ac: { frequencies, primaryFrequency: primary, nodes: {}, elements: {} }, errors, warnings };
    }
    ops = dcRes.dc.operatingPoints || {};
    operatingPoints = ops;
  }

  const allNodes = {};
  const allElements = {};

  for (const freq of frequencies) {
    const res = solveAtFrequency(circuit.components, freq, warnings, excludedNets, { ops });
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

  // --- 判定用の追加解析 ---
  const variants = {};
  const impedances = {};
  const checks = Array.isArray(options?.checks) ? options.checks : [];
  const checkFreqs = (chk) => (Number.isFinite(chk?.frequencyHz) && chk.frequencyHz > 0 ? [chk.frequencyHz] : [primary]);
  for (const chk of checks) {
    if (chk?.sources && typeof chk.sources === "object") {
      const key = acVariantKey(chk.sources);
      const v = (variants[key] ??= { nodes: {} });
      for (const freq of checkFreqs(chk)) {
        const res = solveAtFrequency(circuit.components, freq, warnings, excludedNets, { ops, overrides: chk.sources, quiet: true });
        if (!res) continue;
        for (const [net, freqMap] of Object.entries(res.nodes)) {
          v.nodes[net] = { ...(v.nodes[net] || {}), ...freqMap };
        }
      }
      v.nodes = filterNodeResults(v.nodes, prep);
    }
    if (chk?.type === "acImpedance" && typeof chk.node === "string") {
      const key = acImpedanceKey(chk);
      const exclude = new Set(Array.isArray(chk.exclude) ? chk.exclude : []);
      const comps = circuit.components.filter((c) => !exclude.has(c.id));
      const ref = chk.nodeRef ?? "gnd";
      const entry = (impedances[key] ??= {});
      const present = (net) => isGroundNet(net) || comps.some((c) => c.type !== "TP" && (c.connect || []).includes(net));
      for (const freq of checkFreqs(chk)) {
        if (!present(chk.node) || !present(ref) || excludedNets.has(chk.node)) {
          entry[freq] = null;
          continue;
        }
        const res = solveAtFrequency(comps, freq, warnings, excludedNets, {
          ops, zeroSources: true, inject: { node: chk.node, ref }, quiet: true,
        });
        if (!res) { entry[freq] = null; continue; }
        const vn = res.nodes[chk.node]?.[freq] ?? { re: 0, im: 0 };
        const vr = isGroundNet(ref) ? { re: 0, im: 0 } : (res.nodes[ref]?.[freq] ?? { re: 0, im: 0 });
        const z = { re: vn.re - vr.re, im: vn.im - vr.im };
        entry[freq] = { re: z.re, im: z.im, magnitude: C.abs(z), phaseDeg: (C.arg(z) * 180) / Math.PI };
      }
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
      operatingPoints,
      variants,
      impedances,
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