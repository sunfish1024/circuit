/**
 * 過渡（transient）シミュレーション
 *
 * 手法: 台形則 / 後退オイラー法のコンパニオンモデル
 * 対応素子:
 *  - R:    conductance 1/R
 *  - C:    G = C/dt、履歴電流源 I_hist = (C/dt)·V_C_prev を p に注入
 *  - L:    G = dt/L、履歴電流源 i_L_prev を p から n へ流す
 *  - V_DC: 定電圧（MNA 追加変数で電流を求める）
 *  - V_AC: Vpk·sin(2πft+φ)（時間依存 RHS）
 *  - I_DC: 定電流
 *  - I_AC: Ipk·sin(2πft+φ)
 *  - SW:   closed=true で 1e3 S、false で 1e-12 S
 *  - XFMR: 理想トランス（turnsRatio = Np/Ns。漏れ・巻線抵抗なし）。params.Lm > 0 なら一次に並列の
 *          励磁インダクタンス（フライバック用。Lm = 0 / 省略なら励磁電流 0 で直流も伝える理想トランス）
 *  - SW_V: 電圧制御スイッチ（dc.js の非線形素子として扱う）
 *  - GND:  0V 基準
 *  - 非線形素子（D/ZD/LED/BJT/MOSFET/JFET/OPAMP など）: dc.js と同じモデルを各時刻で
 *    状態反復（solveWithDevices）して解く。詳細は runTransient のコメント。
 *  - 積分は台形則（t=0・パルスの角・素子の状態切替の直後 2 ステップは後退オイラー）
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
import { estimateOscillationFrequency } from "./waveform.js";
import { prepareNetlist, filterNodeResults, GMIN_NODE } from "./netlist.js";
import {
  runDc, createDevice, solveWithDevices, extractDeviceElements, NONLINEAR_TYPES,
  commitDeviceStep, applyModelDefaults,
} from "./dc.js";

/* ==========================================================================
   定数
   ========================================================================== */

const CLOSED_SWITCH_G = 1e3;
const OPEN_SWITCH_G = 1e-12;

/**
 * 最大ステップ数。小さな回路（ノード 10 個程度）で 1 ステップ 10〜20µs なので、
 * 200000 ステップでブラウザでも数秒以内。問題は 50000 ステップ以下を目安に設計する。
 */
const MAX_STEPS = 200000;

/**
 * 「切り替わる素子」（ダイオード系・サイリスタ系・SW_V）がある回路での交流 1 周期あたりの最少点数。
 * 整流・平滑のリプル（数%）を 0.2% 程度の精度で求めるため（台形則の位相誤差 (ωh)²/12 ≈ 2e-5、
 * サンプル点で拾うピークの誤差 1−cos(π/400) ≈ 3e-5）。線形回路は 100 点のまま。
 */
const AC_POINTS_SWITCHING = 400;

/**
 * 素子の状態（導通/遮断）が刻みの途中で変わったとき、刻みを半分にしてやり直す回数の上限。
 * 2^-6 = 1/64 刻みまで切り替わり時刻を絞り込む（整流ダイオードの導通開始、
 * DCM の電流ゼロ、SCR の消弧など）。
 */
const EVENT_REFINE_LEVELS = 6;

/** 切り替わる素子（イベント細分化・細かい刻みの対象）の kind */
const SWITCHING_KINDS = new Set(["diode", "breakdown", "scr", "triac", "diac", "vswitch"]);
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
   部品の分類
   ========================================================================== */

/** 理想トランス（過渡解析）。pins = [p1, p2, s1, s2]、turnsRatio = Np/Ns */
const XFMR_TYPE = "XFMR";
/** 過渡解析でインダクタとして扱う種別 */
const INDUCTOR_TYPES = new Set(["L", "L_RELAY"]);
/** 電圧源として扱う種別 */
const VSOURCE_TYPES = new Set(["V_DC", "V_AC", "V_PULSE"]);
/** 電流源として扱う種別 */
const ISOURCE_TYPES = new Set(["I_DC", "I_AC"]);
/** 電気的に何もしない（ノード名だけ与える）種別 */
const PASSIVE_MARKER_TYPES = new Set(["GND", "TP"]);
/** 過渡解析で扱える全種別 */
const SUPPORTED_TYPES = new Set([
  "R", "C", "SW", "WIRE", XFMR_TYPE,
  ...INDUCTOR_TYPES, ...VSOURCE_TYPES, ...ISOURCE_TYPES, ...PASSIVE_MARKER_TYPES,
]);
/**
 * 過渡解析で扱う非線形素子（dc.js と同じ区分線形 / 平方則モデルを各時刻で反復して解く）。
 * SCR / TRIAC / DIAC はラッチ（自己保持）を時刻ごとに記録する（commitDeviceStep）。
 */
const DEVICE_TYPES = new Set(NONLINEAR_TYPES);

function pinsOf(c) {
  return Array.isArray(c.connect) ? c.connect : [];
}

function hasTwoPins(c) {
  const pins = pinsOf(c);
  return pins.length >= 2 && pins[0] && pins[1];
}

function capValue(c) {
  return Math.max(getNumericParam(c, "C", 1e-6), 1e-15);
}

function indValue(c) {
  return Math.max(getNumericParam(c, "L", 1e-3), 1e-12);
}

function switchConductance(c) {
  if (c.type === "WIRE") return CLOSED_SWITCH_G;
  return c.params?.closed === true ? CLOSED_SWITCH_G : OPEN_SWITCH_G;
}

/* ==========================================================================
   V_PULSE（SPICE PULSE と同じ定義）
   ========================================================================== */

function pulseParams(c) {
  return {
    v1: getNumericParam(c, "Vlow", 0),
    v2: getNumericParam(c, "Vhigh", 5),
    td: Math.max(getNumericParam(c, "delaySec", 0), 0),
    tr: Math.max(getNumericParam(c, "riseSec", 1e-9), 0),
    tf: Math.max(getNumericParam(c, "fallSec", 1e-9), 0),
    pw: Math.max(getNumericParam(c, "widthSec", 1e-3), 0),
    per: Math.max(getNumericParam(c, "periodSec", 2e-3), 0),
  };
}

/**
 * パルス電圧の値。
 * t < delay: Vlow。以後、周期 per ごとに
 * [0, tr) 立ち上がり（直線）→ [tr, tr+pw) Vhigh → [tr+pw, tr+pw+tf) 立ち下がり → Vlow。
 * per = 0（または tr+pw+tf 以下）のときは繰り返さない。
 */
export function pulseValue(pp, t) {
  if (t < pp.td) return pp.v1;
  let tt = t - pp.td;
  const cycle = pp.tr + pp.pw + pp.tf;
  if (pp.per > 0 && pp.per >= cycle) tt = tt % pp.per;
  if (tt < pp.tr) return pp.v1 + ((pp.v2 - pp.v1) * tt) / pp.tr;
  if (tt < pp.tr + pp.pw) return pp.v2;
  if (tt < cycle) return pp.v2 + ((pp.v1 - pp.v2) * (tt - pp.tr - pp.pw)) / pp.tf;
  return pp.v1;
}

/** パルスの角（不連続点）の時刻一覧（tStop まで） */
function pulseBreakpoints(pp, tStop, out, limit) {
  const cycle = pp.tr + pp.pw + pp.tf;
  const repeat = pp.per > 0 && pp.per >= cycle;
  for (let k = 0; ; k++) {
    const base = pp.td + (repeat ? k * pp.per : 0);
    if (base > tStop || out.length > limit) break;
    for (const off of [0, pp.tr, pp.tr + pp.pw, cycle]) {
      const t = base + off;
      if (t > 0 && t < tStop) out.push(t);
    }
    if (!repeat) break;
  }
}

/* ==========================================================================
   テブナン抵抗（時定数の計算用）
   ========================================================================== */

/**
 * 端子 (pNet, nNet) から見た抵抗を求めます。
 * 独立電圧源は短絡（0V 源）、独立電流源は開放。
 * 他の C / L は otherMode に従う:
 *   "lf" … C 開放・L 短絡（直流的な見方。timeConstants に使う）
 *   "hf" … C 短絡・L 開放（最速モードの見積り。刻み決定に使う）
 * 各ノードに 1e-12 S の漏れを入れて浮遊ノードでも解けるようにし、
 * 1e11 Ω を超えたら「つながっていない」とみなして Infinity を返す。
 *
 * @returns {number} R_th [Ω]（求まらなければ NaN）
 */
function theveninResistance(components, selfId, pNet, nNet, otherMode) {
  if (isGroundNet(pNet) && isGroundNet(nNet)) return 0;
  if (pNet === nNet) return 0;

  const nets = new Set();
  for (const c of components) {
    for (const pin of pinsOf(c)) if (pin && !isGroundNet(pin)) nets.add(pin);
  }
  const list = Array.from(nets);
  const ix = new Map(list.map((n, i) => [n, i]));
  const idx = (net) => (isGroundNet(net) ? -1 : (ix.get(net) ?? -1));
  const N = list.length;

  const shorts = [];
  const G_SHORT = 1e6;
  const conds = [];

  for (const c of components) {
    if (c.id === selfId || !hasTwoPins(c)) continue;
    const [a, b] = pinsOf(c);
    if (c.type === "R") conds.push([a, b, 1 / Math.max(getNumericParam(c, "R", 1000), 1e-9)]);
    else if (c.type === "SW" || c.type === "WIRE") conds.push([a, b, switchConductance(c)]);
    else if (VSOURCE_TYPES.has(c.type)) shorts.push([a, b]);
    else if (c.type === "C" && otherMode === "hf") conds.push([a, b, G_SHORT]);
    else if (INDUCTOR_TYPES.has(c.type) && otherMode === "lf") conds.push([a, b, G_SHORT]);
  }

  const size = N + shorts.length;
  const A = Array.from({ length: size }, () => new Array(size).fill(0));
  const bvec = new Array(size).fill(0);
  for (let i = 0; i < N; i++) A[i][i] += 1e-12;
  for (const [a, b, g] of conds) {
    const p = idx(a);
    const n = idx(b);
    if (p >= 0) A[p][p] += g;
    if (n >= 0) A[n][n] += g;
    if (p >= 0 && n >= 0) {
      A[p][n] -= g;
      A[n][p] -= g;
    }
  }
  shorts.forEach(([a, b], k) => {
    const p = idx(a);
    const n = idx(b);
    const row = N + k;
    if (p >= 0) { A[p][row] += 1; A[row][p] += 1; }
    if (n >= 0) { A[n][row] -= 1; A[row][n] -= 1; }
  });
  const ip = idx(pNet);
  const inn = idx(nNet);
  if (ip >= 0) bvec[ip] += 1;
  if (inn >= 0) bvec[inn] -= 1;

  const x = solveLinearSystem(A, bvec);
  if (!x) return NaN;
  const r = (ip >= 0 ? x[ip] : 0) - (inn >= 0 ? x[inn] : 0);
  if (!Number.isFinite(r)) return NaN;
  if (r > 1e11) return Infinity;
  return Math.max(r, 0);
}

/**
 * 各 C / L の時定数を求めます。
 * @returns {{ lf: Map<string, number>, hf: Map<string, number> }}
 */
function computeElementTimeConstants(components) {
  const lf = new Map();
  const hf = new Map();
  for (const c of components) {
    if (!hasTwoPins(c)) continue;
    const isC = c.type === "C";
    const isL = INDUCTOR_TYPES.has(c.type);
    if (!isC && !isL) continue;
    const [a, b] = pinsOf(c);
    for (const [mode, map] of [["lf", lf], ["hf", hf]]) {
      const r = theveninResistance(components, c.id, a, b, mode);
      let tau;
      if (!Number.isFinite(r) && r !== Infinity) tau = NaN;
      else if (isC) tau = r === Infinity ? Infinity : r * capValue(c);
      else tau = r === 0 ? Infinity : r === Infinity ? 0 : indValue(c) / r;
      map.set(c.id, tau);
    }
  }
  return { lf, hf };
}

/** LC の組み合わせから見た固有周期の見積り（刻み決定用） */
function lcPeriods(components) {
  const Cs = components.filter((c) => c.type === "C" && hasTwoPins(c)).map(capValue);
  const Ls = components.filter((c) => INDUCTOR_TYPES.has(c.type) && hasTwoPins(c)).map(indValue);
  const periods = [];
  for (const L of Ls) for (const C of Cs) periods.push(2 * Math.PI * Math.sqrt(L * C));
  return periods;
}

/**
 * 回路定数からの理論振動数（参考値。判定には使わない）。
 * 直列 RLC を仮定した α = R/(2L) なので並列 RLC では正しくない。
 */
function computeTheoreticalOscillationFrequency(components) {
  const Rs = components.filter((c) => c.type === "R").map((c) => Math.max(getNumericParam(c, "R", 1000), 1e-9));
  const Cs = components.filter((c) => c.type === "C").map(capValue);
  const Ls = components.filter((c) => INDUCTOR_TYPES.has(c.type)).map(indValue);
  if (Cs.length === 0 || Ls.length === 0) return null;
  const L = Math.min(...Ls);
  const C = Math.min(...Cs);
  const alpha = Rs.length ? Math.max(...Rs) / (2 * L) : 0;
  const omegaD2 = 1 / (L * C) - alpha * alpha;
  if (omegaD2 <= 0) return null;
  return Math.sqrt(omegaD2) / (2 * Math.PI);
}

/* ==========================================================================
   本体
   ========================================================================== */

/**
 * 過渡シミュレーション実行
 *
 * 理想化の前提（problem-writer が問題文の「条件」に書く内容）:
 * - t=0 で全電源が投入される。C の初期電圧は params.initialV（connect[0] 側が +、既定 0V）、
 *   L の初期電流は params.initialI（connect[0]→connect[1] 向き、既定 0A）。
 * - 記録される t=0 の値は「投入直後 (t=0+)」の値（C 電圧・L 電流は連続、他は即座に追従）。
 * - SW は理想スイッチ（閉 1mΩ / 開 1TΩ）で、解析中は切り替わらない。
 * - 積分は台形則。t=0 と各パルス角の直後 2 ステップは後退オイラー（数値振動の抑制）。
 * - 非線形素子（D/SD/LED/ZD/TVS, Q_NPN/Q_PNP, M_N/M_P, J_N, OPAMP, PD, PT, U_OPTO, カレントミラー）は
 *   DC 解析と同じモデルを各時刻で反復して解く（容量・遅れ・スルーレートは無し＝瞬時に応答）。
 *   - BJT は VBE 一定（Vbe）・IC = β·IB・飽和 VCEsat の区分線形モデル。小信号の gm = IC/VT は入らない
 *     （エミッタ抵抗なしの増幅率は過渡では正しく出ない → 小信号利得は AC 解析で判定する）。
 *   - OPAMP は Vout = Aol·(V+−V−) をレールで頭打ちにする（GBP は過渡では使わない）。
 *   - SCR / TRIAC / DIAC はラッチつきの区分線形スイッチ（dc.js の「サイリスタ系」）。ラッチは各時刻の解が
 *     確定したときに記録する（commitDeviceStep）。
 *   - SW_V は制御電圧が Vth を超えたら Ron、それ以外 Roff（切り替えは瞬時。制御電圧が V_PULSE なら
 *     パルスの角の刻みで切り替わる）。
 * - 切り替わる素子（D 系・サイリスタ系・SW_V）があるときは、交流周期の 1/400 以下の刻みにし、
 *   刻みの途中で素子の状態が変わったら刻みを最大 1/64 まで二分して切り替わり時刻を求める
 *   （整流の導通開始・DCM の電流ゼロ・SCR の消弧。理想ダイオードの不連続をそのまま扱い、平滑化はしない）。
 * - options.diodeRs（問題の simulation.diodeRs）: Rs を書いていないダイオードの直列抵抗（既定 1Ω）。
 * - options.initialCondition === "dc"（問題の simulation.initialCondition）なら、t=0 の電源値で
 *   DC 動作点を求め、C の初期電圧・L の初期電流をその値にしてから始める（SPICE の既定と同じ。
 *   結合コンデンサの充電を待たずに定常の増幅波形を見られる）。既定 "zero" は従来どおり。
 *
 * @param {object} circuit { components, wires, nodes }
 * @param {object} [options]
 * @param {number} [options.dt]         最大時間刻み（秒）。省略時は回路から自動決定
 * @param {number} [options.tStop]      終了時刻（秒）。省略時は自動
 * @param {Array}  [options.checks]     問題のchecks配列（timeSec などを解析範囲に反映）
 * @returns {object}
 */
export function runTransient(circuit, options = {}) {
  const errors = [];
  const warnings = [];
  // 未配線ピン・TP だけのネット・浮いたネットの前処理（netlist.js）
  const prep = prepareNetlist(applyModelDefaults(circuit.components, options));
  warnings.push(...prep.warnings);
  const excludedNets = new Set(prep.unconnectedNets);
  const components = prep.components;

  for (const c of components) {
    if (!SUPPORTED_TYPES.has(c.type) && !DEVICE_TYPES.has(c.type)) {
      warnings.push(`過渡解析では未対応の部品です（無視されます）: ${c.id} (${c.type})`);
    }
  }
  const devices = components
    .filter((c) => DEVICE_TYPES.has(c.type) && pinsOf(c).length >= 2)
    .map((c) => createDevice(c, pinsOf(c)));
  const active = components.filter(
    (c) => SUPPORTED_TYPES.has(c.type) && !PASSIVE_MARKER_TYPES.has(c.type) && hasTwoPins(c) &&
      (c.type !== XFMR_TYPE || pinsOf(c).length >= 4)
  );
  // XFMR の励磁インダクタンス Lm（> 0 のとき）: 一次巻線に並列のインダクタ「<id>#Lm」として加える
  // （フライバックコンバータのエネルギー蓄積。initialI は params.LmInitialI）
  for (const c of active.filter((x) => x.type === XFMR_TYPE)) {
    const Lm = getNumericParam(c, "Lm", 0);
    if (Lm > 0) {
      active.push({
        id: `${c.id}#Lm`, type: "L", connect: [c.connect[0], c.connect[1]],
        params: { L: Lm, initialI: getNumericParam(c, "LmInitialI", 0) },
      });
    }
  }
  const hasSwitching = devices.some((d) => SWITCHING_KINDS.has(d.kind));

  /* --- 時定数・周期の見積り --- */
  const { lf: tauLf, hf: tauHf } = computeElementTimeConstants(active);
  const finitePos = (arr) => arr.filter((v) => Number.isFinite(v) && v > 0);
  // 刻みには "hf"（他の C 短絡・L 開放）の τ を使う。"lf" は他の L を 1e6 S で短絡するため、
  // 並列 LC などで見かけ上ほぼ 0 の τ が出てしまい刻みが不必要に細かくなる。
  const tausFast = finitePos([...tauHf.values()]);
  const tausSlow = finitePos([...tauLf.values()]);
  const periods = finitePos(lcPeriods(active));

  const acPeriods = [];
  const pulses = [];
  for (const c of active) {
    if (c.type === "V_AC" || c.type === "I_AC") {
      const f = getNumericParam(c, "freqHz", 1000);
      if (f > 0) acPeriods.push(1 / f);
    } else if (c.type === "V_PULSE") {
      pulses.push(pulseParams(c));
    }
  }

  // tStop
  let tStop;
  if (Number.isFinite(options.tStop) && options.tStop > 0) {
    tStop = options.tStop;
  } else {
    const candidates = [DEFAULT_T_STOP];
    if (tausSlow.length) candidates.push(10 * Math.max(...tausSlow));
    if (periods.length) candidates.push(5 * Math.max(...periods));
    if (acPeriods.length) candidates.push(5 * Math.max(...acPeriods));
    for (const pp of pulses) {
      const cyc = pp.per > 0 ? pp.per : pp.tr + pp.pw + pp.tf;
      candidates.push(pp.td + cyc);
    }
    if (Array.isArray(options.checks)) {
      for (const chk of options.checks) {
        for (const key of ["timeSec", "toSec"]) {
          if (Number.isFinite(chk?.[key])) candidates.push(chk[key] * (key === "timeSec" ? 1.5 : 1.0001));
        }
      }
    }
    tStop = Math.max(...candidates);
  }

  // 最大刻み
  let dt;
  {
    const candidates = [];
    if (tausFast.length) candidates.push(Math.min(...tausFast) / 100);
    if (periods.length) candidates.push(Math.min(...periods) / 100);
    if (acPeriods.length) candidates.push(Math.min(...acPeriods) / (hasSwitching ? AC_POINTS_SWITCHING : 100));
    for (const pp of pulses) {
      if (pp.per > 0) candidates.push(pp.per / 100);
      if (pp.pw > 0) candidates.push(pp.pw / 10);
      // Low の時間も 10 点以上（デューティ比が大きい PWM）
      const low = pp.per - pp.tr - pp.pw - pp.tf;
      if (pp.per > 0 && low > 0) candidates.push(low / 10);
    }
    dt = candidates.length > 0 ? Math.min(...candidates) : tStop / 1000;
    dt = Math.min(dt, tStop / 200);
    if (Number.isFinite(options.dt) && options.dt > 0) dt = Math.min(dt, options.dt);
  }
  dt = Math.max(Math.min(dt, DT_MAX), DT_MIN);

  if (tStop / dt > MAX_STEPS) {
    tStop = dt * MAX_STEPS;
    warnings.push(
      `解析時間を ${tStop.toExponential(2)}s に制限しました（最大 ${MAX_STEPS} ステップ）。simulation.tStop / dt を見直してください。`
    );
  }

  // 不連続点（パルスの角）
  const bpList = [];
  for (const pp of pulses) pulseBreakpoints(pp, tStop, bpList, 20000);
  const breakpoints = Array.from(new Set(bpList)).sort((a, b) => a - b);

  /* --- ノード列挙 --- */
  const nets = new Set();
  for (const c of components) {
    for (const pin of pinsOf(c)) {
      if (pin && !isGroundNet(pin) && !excludedNets.has(pin)) nets.add(pin);
    }
  }
  const nodeList = Array.from(nets);
  const nodeIdx = new Map();
  nodeList.forEach((n, i) => nodeIdx.set(n, i));
  const N = nodeList.length;
  const idx = (net) => (isGroundNet(net) ? -1 : (nodeIdx.get(net) ?? -1));

  /* --- 素子状態 --- */
  const capState = new Map(); // id -> { C, v, i, p, n }
  const indState = new Map(); // id -> { L, i, v, p, n }
  const vSources = [];
  const iSources = [];
  const xfmrs = []; // { id, comp, pins, n（巻数比 Np/Ns） }

  for (const c of active) {
    const [p, n] = pinsOf(c);
    if (c.type === "C") {
      capState.set(c.id, { C: capValue(c), v: getNumericParam(c, "initialV", 0), i: 0, p, n });
    } else if (INDUCTOR_TYPES.has(c.type)) {
      indState.set(c.id, { L: indValue(c), i: getNumericParam(c, "initialI", 0), v: 0, p, n });
    } else if (VSOURCE_TYPES.has(c.type)) {
      vSources.push({
        id: c.id, type: c.type, comp: c, p, n,
        pulse: c.type === "V_PULSE" ? pulseParams(c) : null,
      });
    } else if (ISOURCE_TYPES.has(c.type)) {
      iSources.push({ id: c.id, type: c.type, comp: c, p, n });
    } else if (c.type === XFMR_TYPE) {
      xfmrs.push({ id: c.id, comp: c, pins: pinsOf(c), n: Math.max(getNumericParam(c, "turnsRatio", 1), 1e-6) });
    }
  }

  const M = vSources.length;
  const X = xfmrs.length;
  const size = N + M + X;

  function vSourceValue(vs, t) {
    if (vs.type === "V_DC") return getNumericParam(vs.comp, "V", 0);
    if (vs.type === "V_PULSE") return pulseValue(vs.pulse, t);
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

  function stampG(A, a, b, g) {
    const p = idx(a);
    const n = idx(b);
    if (p >= 0) A[p][p] += g;
    if (n >= 0) A[n][n] += g;
    if (p >= 0 && n >= 0) {
      A[p][n] -= g;
      A[n][p] -= g;
    }
  }
  function stampI(b, a, bNet, val) {
    // ノード a に電流 val を注入し、ノード bNet から引き抜く
    const p = idx(a);
    const n = idx(bNet);
    if (p >= 0) b[p] += val;
    if (n >= 0) b[n] -= val;
  }

  /**
   * 1ステップ分の連立方程式を組んで解く。
   * method: "be" | "tr"。h: 刻み。t: 新しい時刻。
   */
  let lastBranchRows = [];
  let nonConvergedSteps = 0;
  function solveStep(t, h, method) {
    const stampLinear = (A, b) => {
      for (let i = 0; i < N; i++) A[i][i] += GMIN_NODE; // 浮遊ノード対策の微小漏れ

      for (const c of active) {
        if (c.type === "R") {
          stampG(A, c.connect[0], c.connect[1], 1 / Math.max(getNumericParam(c, "R", 1000), 1e-9));
        } else if (c.type === "SW" || c.type === "WIRE") {
          stampG(A, c.connect[0], c.connect[1], switchConductance(c));
        }
      }
      for (const [, st] of capState) {
        if (method === "tr") {
          const g = (2 * st.C) / h;
          stampG(A, st.p, st.n, g);
          stampI(b, st.p, st.n, g * st.v + st.i);
        } else {
          const g = st.C / h;
          stampG(A, st.p, st.n, g);
          stampI(b, st.p, st.n, g * st.v);
        }
      }
      for (const [, st] of indState) {
        if (method === "tr") {
          const g = h / (2 * st.L);
          stampG(A, st.p, st.n, g);
          stampI(b, st.p, st.n, -(st.i + g * st.v));
        } else {
          const g = h / st.L;
          stampG(A, st.p, st.n, g);
          stampI(b, st.p, st.n, -st.i);
        }
      }
      for (const is of iSources) {
        // I_DC/I_AC の向き（DC 解析と同じ）: 値 I>0 の電流が p 端子から外部回路へ出て、
        // n 端子へ戻る（電池の + 端子と同じ向き）。
        stampI(b, is.p, is.n, iSourceValue(is, t));
      }
      for (let k = 0; k < M; k++) {
        const vs = vSources[k];
        const p = idx(vs.p);
        const n = idx(vs.n);
        const row = N + k;
        if (p >= 0) { A[p][row] += 1; A[row][p] += 1; }
        if (n >= 0) { A[n][row] -= 1; A[row][n] -= 1; }
        b[row] = vSourceValue(vs, t);
      }
      // 理想トランス: (V(s1)−V(s2)) − (V(p1)−V(p2))/n = 0、二次電流 is（s1 から巻線へ流れ込む向き）を
      // 未知数にし、一次電流 ip = −is/n（p1 から巻線へ流れ込む向き。電力 Vp·ip + Vs·is = 0）
      for (let k = 0; k < X; k++) {
        const xf = xfmrs[k];
        const row = N + M + k;
        const [p1, p2, s1, s2] = xf.pins.map(idx);
        const r = 1 / xf.n;
        if (s1 >= 0) { A[s1][row] += 1; A[row][s1] += 1; }
        if (s2 >= 0) { A[s2][row] -= 1; A[row][s2] -= 1; }
        if (p1 >= 0) { A[p1][row] -= r; A[row][p1] -= r; }
        if (p2 >= 0) { A[p2][row] += r; A[row][p2] += r; }
      }
    };

    if (devices.length === 0) {
      const A = Array.from({ length: size }, () => new Array(size).fill(0));
      const b = new Array(size).fill(0);
      stampLinear(A, b);
      return solveLinearSystem(A, b);
    }
    // 非線形素子あり: 素子の状態（前の時刻の状態から開始）が変わらなくなるまで反復
    const r = solveWithDevices({ baseSize: size, stampLinear, idx, nodeIdx, devices });
    lastBranchRows = r.branchRows;
    if (r.x && !r.converged) nonConvergedSteps++;
    return r.x;
  }

  /** 素子の動作状態（導通/遮断/飽和など）の組。変わったら次の2ステップを後退オイラーにする */
  const deviceModes = () => devices.map((d) => d.state?.mode ?? d.state?.ledMode ?? "").join(",");

  function nodeMap(x) {
    const nodes = { gnd: 0 };
    for (const net of nodeList) nodes[net] = x[nodeIdx.get(net)];
    return nodes;
  }

  /** 状態更新と素子値の計算。commit=false なら状態を変えない（t=0+ 記録用） */
  function elementValues(x, nodes, t, h, method, commit) {
    const out = {};
    for (const c of active) {
      const [a, bNet] = c.connect;
      const v = vOfNode(nodes, a) - vOfNode(nodes, bNet);
      let i = 0;
      if (c.type === "R") {
        i = v / Math.max(getNumericParam(c, "R", 1000), 1e-9);
      } else if (c.type === "C") {
        const st = capState.get(c.id);
        i = method === "tr" ? ((2 * st.C) / h) * (v - st.v) - st.i : (st.C / h) * (v - st.v);
        if (commit) { st.v = v; st.i = i; }
      } else if (INDUCTOR_TYPES.has(c.type)) {
        const st = indState.get(c.id);
        i = method === "tr" ? st.i + (h / (2 * st.L)) * (v + st.v) : st.i + (h / st.L) * v;
        if (commit) { st.i = i; st.v = v; }
      } else if (VSOURCE_TYPES.has(c.type)) {
        const k = vSources.findIndex((s) => s.id === c.id);
        i = k >= 0 ? x[N + k] : 0;
      } else if (ISOURCE_TYPES.has(c.type)) {
        const is = iSources.find((s) => s.id === c.id);
        i = is ? iSourceValue(is, t) : 0;
      } else if (c.type === "SW" || c.type === "WIRE") {
        i = v * switchConductance(c);
      } else if (c.type === XFMR_TYPE) {
        // v = 一次電圧 V(p1)−V(p2)、i = 一次電流（p1 から流れ込む向き）、v2/i2 = 二次側
        const k = xfmrs.findIndex((s) => s.id === c.id);
        const is = k >= 0 ? x[N + M + k] : 0;
        const xf = xfmrs[k];
        out[c.id] = {
          v, i: -is / (xf?.n ?? 1),
          v2: vOfNode(nodes, c.connect[2]) - vOfNode(nodes, c.connect[3]), i2: is,
        };
        continue;
      }
      out[c.id] = { v, i };
    }
    if (devices.length > 0 && x) {
      const dev = extractDeviceElements(devices, { nodeIdx }, x, lastBranchRows, size);
      for (const [id, e] of Object.entries(dev)) out[id] = { v: e.v, i: e.i };
    }
    return out;
  }

  const time = [];
  const nodeArrays = { gnd: [] };
  for (const net of nodeList) nodeArrays[net] = [];
  const elementArrays = {};
  for (const c of active) {
    elementArrays[c.id] = c.type === XFMR_TYPE ? { v: [], i: [], v2: [], i2: [] } : { v: [], i: [] };
  }
  for (const d of devices) elementArrays[d.id] = { v: [], i: [] };

  function record(t, nodes, ev) {
    time.push(t);
    nodeArrays.gnd.push(0);
    for (const net of nodeList) nodeArrays[net].push(nodes[net]);
    for (const c of active) {
      const arr = elementArrays[c.id];
      arr.v.push(ev[c.id].v);
      arr.i.push(ev[c.id].i);
      if (arr.v2) {
        arr.v2.push(ev[c.id].v2 ?? 0);
        arr.i2.push(ev[c.id].i2 ?? 0);
      }
    }
    for (const d of devices) {
      elementArrays[d.id].v.push(ev[d.id]?.v ?? 0);
      elementArrays[d.id].i.push(ev[d.id]?.i ?? 0);
    }
  }

  /* --- 初期条件: DC 動作点から始める（simulation.initialCondition = "dc"） --- */
  if (options.initialCondition === "dc") {
    const opComponents = components.map((c) => {
      if (c.type === "V_AC") {
        const ph = (getNumericParam(c, "phaseDeg", 0) * Math.PI) / 180;
        return { ...c, type: "V_DC", params: { V: getNumericParam(c, "Vpk", 0) * Math.sin(ph) } };
      }
      if (c.type === "I_AC") {
        const ph = (getNumericParam(c, "phaseDeg", 0) * Math.PI) / 180;
        return { ...c, type: "I_DC", params: { I: getNumericParam(c, "Ipk", 0) * Math.sin(ph) } };
      }
      if (c.type === "V_PULSE") return { ...c, type: "V_DC", params: { V: pulseValue(pulseParams(c), 0) } };
      return c;
    });
    const op = runDc({ components: opComponents }, options);
    if (!op.ok) {
      warnings.push("DC 動作点を求められなかったため、初期状態 0 から過渡解析を始めます。");
    } else {
      for (const [id, st] of capState) {
        const v = op.dc.elements?.[id]?.v;
        if (Number.isFinite(v)) st.v = v;
      }
      for (const [id, st] of indState) {
        const i = op.dc.elements?.[id]?.i;
        if (Number.isFinite(i)) st.i = i;
      }
    }
  }

  /* --- t = 0+（極小刻みの後退オイラーで C 電圧・L 電流を保ったまま解く） --- */
  {
    const hTiny = dt * 1e-9;
    const x0 = solveStep(0, hTiny, "be");
    if (!x0) {
      errors.push("過渡解析の初期状態を解けませんでした。短絡（電圧源どうしの並列など）や浮遊ノードを確認してください。");
    } else {
      const nodes = nodeMap(x0);
      const ev = elementValues(x0, nodes, 0, hTiny, "be", false);
      // C は初期電圧、L は初期電流のまま（連続）として記録
      for (const [id, st] of capState) ev[id] = { v: st.v, i: ev[id].i };
      for (const [id, st] of indState) {
        ev[id] = { v: ev[id].v, i: st.i };
        st.v = ev[id].v;
      }
      record(0, nodes, ev);
      commitDeviceStep(devices);
    }
  }

  /* --- 時間積分 --- */
  // イベント細分化: 切り替わる素子（ダイオード・サイリスタ・SW_V）の状態が刻みの途中で変わったら、
  // 素子の状態を戻して刻みを半分にやり直す（最大 EVENT_REFINE_LEVELS 回）。切り替わり時刻の誤差を
  // dt/64 以下にし、整流の導通開始・DCM の電流ゼロ・SCR の消弧のずれによる平均値・リプルの誤差を抑える。
  const switchingDevices = devices.filter((d) => SWITCHING_KINDS.has(d.kind));
  const switchModes = () => switchingDevices.map((d) => `${d.state.mode}/${d.state.gateMode ?? ""}`).join(",");
  const saveStates = () => devices.map((d) => ({ ...d.state }));
  const restoreStates = (saved) => devices.forEach((d, k) => { d.state = { ...saved[k] }; });
  let t = 0;
  let bpIndex = 0;
  let beSteps = 2; // t=0 直後は後退オイラー
  let steps = 0;
  let refinedSteps = 0;
  let prevModes = devices.length > 0 ? deviceModes() : "";
  const hMinEvent = dt / 2 ** EVENT_REFINE_LEVELS;
  let hCap = Infinity; // 細分化の途中（切り替わりの手前まで進んだ）なら、次の刻みもその大きさから始める
  while (errors.length === 0 && t < tStop * (1 - 1e-12) && steps < MAX_STEPS * 2 + breakpoints.length + 10) {
    while (bpIndex < breakpoints.length && breakpoints[bpIndex] <= t * (1 + 1e-12) + 1e-18) bpIndex++;
    let tNext = Math.min(t + Math.min(dt, hCap), tStop);
    let hitBreakpoint = false;
    if (bpIndex < breakpoints.length && breakpoints[bpIndex] < tNext * (1 - 1e-12)) {
      tNext = breakpoints[bpIndex];
      hitBreakpoint = true;
    } else if (bpIndex < breakpoints.length && Math.abs(breakpoints[bpIndex] - tNext) <= 1e-12 * tNext) {
      tNext = breakpoints[bpIndex];
      hitBreakpoint = true;
    }
    let h = tNext - t;
    if (!(h > 0)) break;
    const method = beSteps > 0 ? "be" : "tr";
    const saved = switchingDevices.length > 0 ? saveStates() : null;
    const modesBefore = saved ? switchModes() : "";
    let x = solveStep(tNext, h, method);
    // 状態が変わった刻みを半分にして切り替わり時刻を絞り込む（パルスの角に合わせた刻みは除く:
    // 角で切り替わるのが正しいので細分化しても同じ）
    let refined = false;
    while (x && saved && !hitBreakpoint && h > hMinEvent * 1.5 && switchModes() !== modesBefore) {
      restoreStates(saved);
      h /= 2;
      tNext = t + h;
      x = solveStep(tNext, h, method);
      refinedSteps++;
      refined = true;
    }
    // 切り替わりの手前で止まった → 残りも同じ刻みで二分探索を続ける。切り替わった → 通常の刻みに戻す
    if (saved && switchModes() !== modesBefore) hCap = Infinity;
    else if (refined) hCap = h;
    else if (hCap < Infinity) hCap = hCap * 2 >= dt ? Infinity : hCap * 2;
    if (!x) {
      errors.push(
        `過渡解析が t=${tNext.toExponential(2)}s で解けませんでした。短絡・浮遊ノードを確認してください。`
      );
      break;
    }
    const nodes = nodeMap(x);
    const ev = elementValues(x, nodes, tNext, h, method, true);
    record(tNext, nodes, ev);
    commitDeviceStep(devices);
    t = tNext;
    steps++;
    if (beSteps > 0) beSteps--;
    if (hitBreakpoint) beSteps = 2;
    if (devices.length > 0) {
      const modes = deviceModes();
      if (modes !== prevModes) beSteps = 2; // 素子の切替直後は台形則の数値振動を避ける
      prevModes = modes;
    }
  }
  if (nonConvergedSteps > 0) {
    warnings.push(`非線形素子の状態が収束しなかった時刻が ${nonConvergedSteps} ステップありました（結果は参考値）。`);
  }

  /* --- 派生結果 --- */
  const reactive = active.filter((c) => c.type === "C" || INDUCTOR_TYPES.has(c.type));
  const timeConstants = {};
  for (const [id, tau] of tauLf) {
    timeConstants[id] = Number.isFinite(tau) ? tau : null;
  }
  let timeConstant = null;
  let timeConstantNote = null;
  if (reactive.length === 1) {
    timeConstant = timeConstants[reactive[0].id];
    if (!Number.isFinite(timeConstant)) {
      timeConstantNote = `${reactive[0].id} から見た抵抗が求まらないため時定数を決められません（${reactive[0].id} の両端が回路につながっているか確認してください）。`;
    }
  } else if (reactive.length === 0) {
    timeConstantNote = "回路に C も L もないため時定数がありません。";
  } else {
    timeConstantNote = `C と L が合わせて ${reactive.length} 個あるため、時定数が1つに決まりません（判定に node を指定して波形から測ってください）。`;
  }

  let waveformFreq = null;
  if (errors.length === 0) {
    let bestNode = null;
    let bestVar = 0;
    const shown = filterNodeResults(nodeArrays, prep);
    for (const net of Object.keys(shown)) {
      const arr = nodeArrays[net];
      if (!arr || arr.length < 8) continue;
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
      waveformFreq = estimateOscillationFrequency(time, nodeArrays[bestNode]);
    }
  }

  return {
    ok: errors.length === 0,
    transient: {
      time,
      nodes: filterNodeResults(nodeArrays, prep),
      unconnectedNets: prep.unconnectedNets,
      floatingNets: prep.floatingNets,
      elements: elementArrays,
      timeConstant,
      timeConstantNote,
      timeConstants,
      oscillationFrequencyHz: computeTheoreticalOscillationFrequency(active),
      waveformFrequencyHz: waveformFreq,
      dt,
      tStop,
      steps: time.length,
      refinedSteps,
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