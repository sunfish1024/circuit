/**
 * 過渡解析のビヘイビア素子（論理ゲート・D フリップフロップ）。
 *
 * dc.js の非線形素子ループ（solveWithDevices）に kind = "custom" の素子として入る。
 * DC 解析・AC 解析では従来どおりゲート・DFF は無視される（digital モードの真理値表・sequence 判定は
 * src/sim/digital.js が別に行う）。
 *
 * 理想化の前提（problem-writer が問題文の「条件」に書く内容）:
 * - 電源ピンは無い。出力は gnd 基準の電圧源で、High = VOH（params.VOH、既定 5V）、Low = 0V。
 *   出力抵抗 Rout（params.Rout、既定 1Ω。出力どうしの短絡で行列が特異にならないための最小値）。
 * - 入力電流 0（理想 CMOS 入力）。入力電圧が Vth（params.Vth、既定 VOH/2）以上なら 1、未満なら 0。
 *   params.hyst > 0 でヒステリシス（シュミット入力）: 0 → 1 は Vth + hyst/2 以上、1 → 0 は Vth − hyst/2 未満。
 * - 伝搬遅延 0（入力がしきい値を横切った刻みで出力が切り替わる）。切り替わりは「切り替わる素子」として
 *   刻みを最大 1/64 まで二分して時刻を求める（transient.js の EVENT_REFINE_LEVELS）。
 * - 未配線の入力は 0V（論理 0）として扱う（digital モードと違い X にはならない）。
 * - DFF / DFF_R: CLK の立ち上がり（前の刻みで 0、この刻みで 1）で、前の刻みの D を取り込む
 *   （同じクロックの DFF はエッジ直前の値を取り込むのでシフトレジスタ・分周器が正しく動く）。
 *   電源投入時 Q = 0。DFF_R の CLR は負論理の非同期クリア（未配線なら無効）。
 *   t = 0 で CLK が High でも立ち上がりとはみなさない。
 * - 遅延 0 のゲートだけで作ったループ（3 段リング発振器など）は平衡点が無く収束しない（扱えない）。
 */

import { GATE_DEFS, FLIPFLOP_DEFS } from "./digital.js";
import { parseMetricValue } from "../core/units.js";
import { NC_PREFIX } from "./netlist.js";

function num(c, key, fallback) {
  const raw = c?.params?.[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const p = parseMetricValue(raw);
    if (Number.isFinite(p)) return p;
  }
  return fallback;
}

/** 過渡解析でビヘイビア素子として扱う種別 */
export const BEHAVIORAL_TYPES = new Set([...Object.keys(GATE_DEFS), ...Object.keys(FLIPFLOP_DEFS)]);

const isGround = (net) => !net || net === "gnd" || net === "0";
const isNc = (net) => typeof net === "string" && net.startsWith(NC_PREFIX);

/** 出力ブランチ（gnd 基準の電圧源＋直列 Rout）をスタンプする */
function stampOut(A, b, idx, net, row, value, rout) {
  const o = idx(net);
  if (o >= 0) { A[o][row] += 1; A[row][o] += 1; }
  A[row][row] -= rout;
  b[row] = value;
}

/** 入力の論理レベル（ヒステリシスつき）。committed は前の刻みのレベル（0/1、未知は -1） */
function levelOf(v, committed, vth, hyst) {
  if (hyst > 0 && committed === 1) return v > vth - hyst / 2 ? 1 : 0;
  if (hyst > 0 && committed === 0) return v >= vth + hyst / 2 ? 1 : 0;
  return v >= vth ? 1 : 0;
}

function electrical(c) {
  const voh = num(c, "VOH", 5);
  return {
    voh,
    vth: num(c, "Vth", voh / 2),
    hyst: Math.max(num(c, "hyst", 0), 0),
    rout: Math.max(num(c, "Rout", 1), 1e-3),
  };
}

const gateBehavior = {
  switching: true,
  branches: () => 1,
  roles: () => ["out"],
  stamp(dev, A, b, idx, rows) {
    stampOut(A, b, idx, dev.pins[dev.nIn], rows[0], dev.state.mode === "high" ? dev.e.voh : 0, dev.e.rout);
  },
  update(dev, vOf, cur, iterCtx) {
    const st = dev.state;
    const levels = [];
    for (let k = 0; k < dev.nIn; k++) {
      // ヒステリシスの基準は直前の反復のレベル（刻みの初めは前の刻みの確定値）。しきい値を越えた入力が
      // 自分の出力の切り替えで少し戻っても、刻みの中で元に戻らない（シュミット入力の働き）
      const prev = st.inN.length === dev.nIn ? Number(st.inN[k]) : -1;
      levels.push(levelOf(vOf(dev.pins[k]), prev, dev.e.vth, dev.e.hyst));
    }
    st.inN = levels.join("");
    const want = GATE_DEFS[dev.type].fn(levels) === 1 ? "high" : "low";
    let pending = 0;
    // 1 つの刻みの中で出力が切り替わるのは 1 回まで（遅延 0 の理想ゲート: 入力がしきい値を横切った刻みで
    // 1 回だけ切り替わる。切り替えの反作用で入力が少し戻っても刻みの中では戻さない → 次の刻みで判断）
    if (want !== st.mode && !st.flipped) {
      if (iterCtx?.changed) pending = 1; // ほかの素子がこの反復で切り替わった → 次の反復で判断
      else {
        st.mode = want;
        st.flipped = true;
        if (iterCtx) iterCtx.changed = true;
      }
    }
    return `${st.mode}:${st.inN}:${pending}`;
  },
  extract(dev, vOf, cur) {
    return { v: vOf(dev.pins[dev.nIn]), i: -cur(dev.id, "out") };
  },
  commit(dev) {
    dev.state.flipped = false;
  },
};

const dffBehavior = {
  switching: true,
  branches: () => 2,
  roles: () => ["q", "qn"],
  stamp(dev, A, b, idx, rows) {
    const q = dev.state.q;
    stampOut(A, b, idx, dev.pins[dev.f.q], rows[0], q ? dev.e.voh : 0, dev.e.rout);
    stampOut(A, b, idx, dev.pins[dev.f.qn], rows[1], q ? 0 : dev.e.voh, dev.e.rout);
  },
  update(dev, vOf, cur, iterCtx) {
    const st = dev.state;
    const { vth, hyst } = dev.e;
    st.clkN = levelOf(vOf(dev.pins[dev.f.clk]), st.clkN, vth, hyst);
    st.dN = levelOf(vOf(dev.pins[dev.f.d]), st.dN, vth, hyst);
    const clrPin = dev.f.clr >= 0 ? dev.pins[dev.f.clr] : null;
    const clr = clrPin && !isNc(clrPin) ? levelOf(isGround(clrPin) ? 0 : vOf(clrPin), -1, vth, 0) : 1;
    let want;
    if (clr === 0) want = 0;
    else if (st.clkC === 0 && st.clkN === 1) want = st.dC === 1 ? 1 : 0;
    else want = st.qC;
    let pending = 0;
    if (want !== st.q && !st.flipped) {
      if (iterCtx?.changed) pending = 1;
      else {
        st.q = want;
        st.flipped = true;
        if (iterCtx) iterCtx.changed = true;
      }
    }
    st.mode = `q${st.q}`;
    return `${st.mode}:${st.clkN}${st.dN}:${pending}`;
  },
  extract(dev, vOf, cur) {
    return { v: vOf(dev.pins[dev.f.q]), i: -cur(dev.id, "q") };
  },
  commit(dev) {
    const st = dev.state;
    st.qC = st.q;
    st.clkC = st.clkN;
    st.dC = st.dN;
    st.flipped = false;
  },
};

/**
 * 論理ゲート / DFF の過渡解析用素子を作ります（dc.js の createDevice と同じ形）。
 * @returns {object | null}
 */
export function createBehavioralDevice(c, pins) {
  const e = electrical(c);
  if (GATE_DEFS[c.type]) {
    const nIn = GATE_DEFS[c.type].inputs;
    if (pins.length < nIn + 1) return null;
    return {
      id: c.id, type: c.type, comp: c, pins, kind: "custom", behavior: gateBehavior, e, nIn,
      state: { mode: "low", inN: "", flipped: false },
    };
  }
  if (FLIPFLOP_DEFS[c.type]) {
    const f = FLIPFLOP_DEFS[c.type];
    if (pins.length < f.pins.length) return null;
    return {
      id: c.id, type: c.type, comp: c, pins, kind: "custom", behavior: dffBehavior, e, f,
      state: { mode: "q0", q: 0, qC: 0, clkC: -1, clkN: -1, dC: -1, dN: -1, flipped: false },
    };
  }
  return null;
}

/** LOGIC_IN（1 ピン）を過渡解析用の V_DC（[net, gnd]、value·VOH）に置き換えます。 */
export function logicInAsSource(c) {
  const net = Array.isArray(c.connect) ? c.connect[0] : "";
  const v = num(c, "value", 0) >= 0.5 ? num(c, "VOH", 5) : 0;
  return { ...c, type: "V_DC", params: { V: v }, connect: [net, "gnd"], logicIn: true };
}
