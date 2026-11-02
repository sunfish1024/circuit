/**
 * デジタル論理シミュレーション（mode: "digital"）と、デジタル判定の評価器。
 *
 * ===================================================================
 * 理想化の前提（problem-writer は問題文の「条件」にこのまま書いてよい）
 * ===================================================================
 *  - 論理値は 0 / 1 / X（不定）の3値。電圧・電流・ファンアウト・消費電力は扱わない。
 *  - ゲートは理想論理素子。伝搬遅延は全ゲート共通の「1ステップ」（単位遅延）で、
 *    実時間の遅延（ns）やハザード（ひげ）の大きさは判定に使わない。
 *    判定は「入力を変えてから回路が落ち着いた後」の値で行う。
 *  - DFF / DFF_R はクロック（CLK）の立ち上がりエッジ（0→1）で D を取り込むエッジトリガ型。
 *    セットアップ／ホールド時間は常に満たされる（判定はクロックを上げる前に入力を確定させる）。
 *  - 電源投入時、DFF / DFF_R の Q は 0（理想的なパワーオンリセット）。
 *    ゲートだけで組んだラッチ（NOR 2個の SR ラッチなど）の初期値は X（不定）。
 *  - DFF_R の CLR は負論理の非同期クリア（74HC74 と同じ）。CLR=0 の間 Q=0（クロックより優先）。
 *  - 未接続の入力ピン（どこにも配線していない、または何も駆動していないネット）は
 *    「浮き（Hi-Z）」として X 扱い。判定対象の出力に影響する範囲に浮いた入力があれば不合格。
 *    （CMOS ICの入力を開放してはいけない、という実務の規則と同じ）
 *  - 出力どうし（ゲート出力・DFF出力・LOGIC_IN・定数）を同じネットにつなぐと「出力の衝突」。
 *    値が食い違うと X、判定対象に影響する範囲にあれば不合格。ワイヤードORは扱わない。
 *  - 定数: gnd ネットは 0。V_DC（n 端子が gnd）の p 端子は V ≥ 2.0V なら 1、V ≤ 0.8V なら 0。
 *  - 抵抗 R は「弱い駆動」（プルアップ／プルダウン）: 強い駆動のないネットは、R でつながった先の
 *    強く駆動されたネットの値になる。強い駆動（ゲート出力・閉じた SW で gnd など）が優先。
 *  - SW（closed: true）は2つのネットを短絡する理想スイッチ。開いた SW は何もつながない。
 *  - 帰還ループが落ち着かない（発振する）とき、揺れ続けるネットは X とする。
 *  - LED・C・ダイオードなどアナログ部品は digital モードでは無視する（警告）。
 *
 * ===================================================================
 * 評価方式
 * ===================================================================
 *  1. ゲートレベル（回路に論理ゲート・DFF・LOGIC_IN のどれかがある場合）
 *     - 各ステップで全ゲートを同時に評価する（Jacobi 型の単位遅延シミュレーション）。
 *       値が変わらなくなったら「落ち着いた」とみなす。
 *     - DFF は前のステップの CLK が 0、今のステップの CLK が 1 のとき、今の D を取り込む。
 *       同じクロックで動く DFF は全員が「エッジ前の値」を取り込むので、シフトレジスタが正しく動く。
 *  2. DC 解析（ゲートも DFF も LOGIC_IN も無い回路。ダイオードロジックなど）
 *     - 入力ネットに仮想電圧源（Low=driveLowV, High=driveHighV）を入れて DC 解析を繰り返し、
 *       出力電圧を vih / vil で 0/1 に量子化する。
 *
 * 判定（runner.js の truthTable / sequence ハンドラ）は evaluateTruthTable / evaluateSequence を
 * 直接呼ぶ。docs/check_reference.md の truthTable / sequence の節も参照。
 */

import { registerSimulationMode } from "./simulator.js";
import { runDc } from "./dc.js";
import { NC_PREFIX } from "./netlist.js";
import { parseMetricValue } from "../core/units.js";

/** 不定値。 */
export const LOGIC_X = 2;

/** 真理値表スイープで扱える入力ネット数の上限（2^8 = 256 行まで）。 */
const MAX_SWEEP_INPUTS = 8;

/** sequence 判定の最大ステップ数。 */
const MAX_SEQUENCE_STEPS = 512;

/** 定数ネット（V_DC）の論理しきい値 [V]。 */
const CONST_VIH = 2.0;
const CONST_VIL = 0.8;

/** 仮想入力電源の ID 接頭辞（DC 方式）。 */
const DRIVER_ID_PREFIX = "__DIG_DRV_";

/* ------------------------------------------------------------------ */
/* 3値論理                                                              */
/* ------------------------------------------------------------------ */

const lnot = (a) => (a === LOGIC_X ? LOGIC_X : a ? 0 : 1);
function land(vals) {
  if (vals.some((v) => v === 0)) return 0;
  return vals.every((v) => v === 1) ? 1 : LOGIC_X;
}
function lor(vals) {
  if (vals.some((v) => v === 1)) return 1;
  return vals.every((v) => v === 0) ? 0 : LOGIC_X;
}
function lxor(vals) {
  if (vals.some((v) => v === LOGIC_X)) return LOGIC_X;
  return vals.reduce((acc, v) => acc ^ v, 0);
}

/**
 * 論理ゲートの定義（pinNames は components.json と同じ順。最後のピンが出力 Y）。
 */
export const GATE_DEFS = {
  U_NOT: { kind: "NOT", inputs: 1, fn: (v) => lnot(v[0]) },
  U_AND: { kind: "AND", inputs: 2, fn: land },
  U_OR: { kind: "OR", inputs: 2, fn: lor },
  U_NAND: { kind: "NAND", inputs: 2, fn: (v) => lnot(land(v)) },
  U_NOR: { kind: "NOR", inputs: 2, fn: (v) => lnot(lor(v)) },
  U_XOR: { kind: "XOR", inputs: 2, fn: lxor },
  U_XNOR: { kind: "XNOR", inputs: 2, fn: (v) => lnot(lxor(v)) },
  U_AND3: { kind: "AND3", inputs: 3, fn: land },
  U_OR3: { kind: "OR3", inputs: 3, fn: lor },
};

const GATE_PIN_NAMES = {
  1: ["A", "Y"],
  2: ["A", "B", "Y"],
  3: ["A", "B", "C", "Y"],
};

/** 順序素子の定義（pinNames は components.json と同じ順）。 */
export const FLIPFLOP_DEFS = {
  DFF: { pins: ["D", "CLK", "Q", "Q_NOT"], d: 0, clk: 1, clr: -1, q: 2, qn: 3 },
  DFF_R: { pins: ["D", "CLK", "CLR", "Q", "Q_NOT"], d: 0, clk: 1, clr: 2, q: 3, qn: 4 },
};

/** ゲートレベル評価に切り替える部品種別。 */
const DIGITAL_TYPES = new Set([...Object.keys(GATE_DEFS), ...Object.keys(FLIPFLOP_DEFS), "LOGIC_IN"]);

/** digital モードで電気的に意味を持たない（無視して警告もしない）部品。 */
const SILENT_TYPES = new Set(["GND", "TP", "WIRE", "SW", "R", "V_DC", "LOGIC_IN"]);

/** 回路にゲート・DFF・LOGIC_IN があるか。 */
export function hasDigitalParts(components) {
  return (components ?? []).some((c) => DIGITAL_TYPES.has(c?.type));
}

/** 論理値を表示用の文字へ。 */
export function logicToChar(v) {
  return v === 0 ? "0" : v === 1 ? "1" : "x";
}

/**
 * 期待値（0/1/"0"/"1"/"x"/null/true/false）を 0/1/null（don't care）へ。
 * 解釈できない値は undefined。
 */
export function parseExpectedLogic(v) {
  if (v === 0 || v === "0" || v === false) return 0;
  if (v === 1 || v === "1" || v === true) return 1;
  if (v === null || v === "x" || v === "X" || v === "-") return null;
  return undefined;
}

/** 系列（配列 または "0110x" のような文字列）を配列へ。 */
export function toLogicSeries(value) {
  if (typeof value === "string") return value.replace(/[\s_,]/g, "").split("");
  if (Array.isArray(value)) return value;
  return null;
}

/* ------------------------------------------------------------------ */
/* 小さなユーティリティ                                                 */
/* ------------------------------------------------------------------ */

function getNumericParam(component, key, fallback) {
  const raw = component?.params?.[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") {
    const parsed = parseMetricValue(raw);
    if (Number.isFinite(parsed)) return parsed;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function isTruthyParam(raw) {
  return raw === true || raw === 1 || raw === "true" || raw === "1";
}

function isGroundNet(net) {
  return net === "gnd" || net === "0";
}

/** ネット名を表示用に（未配線ピンは「U1 の B ピン（未配線）」）。 */
function describeNet(net, model) {
  if (typeof net === "string" && net.startsWith(NC_PREFIX)) {
    const [id, idx] = net.slice(NC_PREFIX.length).split(":");
    const comp = model?.componentsById?.get(id);
    const pinName = comp ? pinNamesOf(comp.type)?.[Number(idx)] : null;
    return `${id} の ${pinName ?? `${Number(idx) + 1}番`}ピン（未配線）`;
  }
  return `ネット ${net}`;
}

function pinNamesOf(type) {
  const g = GATE_DEFS[type];
  if (g) return GATE_PIN_NAMES[g.inputs];
  return FLIPFLOP_DEFS[type]?.pins ?? null;
}

/* ------------------------------------------------------------------ */
/* 論理ネットリストの構築                                               */
/* ------------------------------------------------------------------ */

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    let c = x;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c);
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    // gnd を代表にする（表示と定数判定を簡単にするため）
    if (rb === "gnd") [ra, rb] = [rb, ra];
    this.parent.set(rb, ra);
  }
}

/**
 * 回路から論理モデルを作ります。
 *
 * @param {Array<object>} componentsIn
 * @returns {object} model
 */
export function buildLogicModel(componentsIn) {
  const warnings = [];
  const uf = new UnionFind();
  const componentsById = new Map();

  const comps = (componentsIn ?? []).filter(Boolean).map((c) => {
    const pins = Array.isArray(c.connect) ? c.connect : [];
    const connect = pins.map((net, i) => {
      const name = typeof net === "string" ? net.trim() : "";
      if (!name) return `${NC_PREFIX}${c.id}:${i}`;
      return isGroundNet(name) ? "gnd" : name;
    });
    const out = { ...c, connect };
    componentsById.set(c.id, out);
    return out;
  });

  uf.find("gnd");
  for (const c of comps) {
    for (const n of c.connect) uf.find(n);
    if (c.type === "WIRE" && c.connect.length >= 2) uf.union(c.connect[0], c.connect[1]);
    if (c.type === "SW" && c.connect.length >= 2 && isTruthyParam(c.params?.closed)) {
      uf.union(c.connect[0], c.connect[1]);
    }
  }
  const rep = (net) => uf.find(isGroundNet(net) ? "gnd" : net);

  const drivers = new Map(); // rep -> [driver]
  const weakLinks = new Map(); // rep -> [{net, id}]
  const readers = new Map(); // rep -> [{id, pin}]
  const gates = [];
  const flipflops = [];
  const inputs = []; // LOGIC_IN
  const ignored = [];

  const addDriver = (net, drv) => {
    const r = rep(net);
    if (!drivers.has(r)) drivers.set(r, []);
    drivers.get(r).push(drv);
  };
  const addReader = (net, id, pin) => {
    const r = rep(net);
    if (!readers.has(r)) readers.set(r, []);
    readers.get(r).push({ id, pin });
  };

  addDriver("gnd", { kind: "const", id: "gnd", value: 0, label: "グラウンド（0）" });

  for (const c of comps) {
    const gdef = GATE_DEFS[c.type];
    if (gdef) {
      const n = gdef.inputs;
      if (c.connect.length < n + 1) {
        warnings.push(`部品 ${c.id}: ピン数が足りないため無視します。`);
        continue;
      }
      const pinNames = GATE_PIN_NAMES[n];
      const g = {
        id: c.id,
        type: c.type,
        fn: gdef.fn,
        in: c.connect.slice(0, n).map(rep),
        rawIn: c.connect.slice(0, n),
        out: rep(c.connect[n]),
      };
      gates.push(g);
      g.in.forEach((net, i) => addReader(net, c.id, pinNames[i]));
      addDriver(c.connect[n], { kind: "gate", id: c.id, gate: g, label: `${c.id} の Y` });
      continue;
    }

    const fdef = FLIPFLOP_DEFS[c.type];
    if (fdef) {
      if (c.connect.length < fdef.pins.length) {
        warnings.push(`部品 ${c.id}: ピン数が足りないため無視します。`);
        continue;
      }
      const ff = {
        id: c.id,
        type: c.type,
        d: rep(c.connect[fdef.d]),
        clk: rep(c.connect[fdef.clk]),
        clr: fdef.clr >= 0 ? rep(c.connect[fdef.clr]) : null,
        q: rep(c.connect[fdef.q]),
        qn: rep(c.connect[fdef.qn]),
      };
      flipflops.push(ff);
      addReader(c.connect[fdef.d], c.id, "D");
      addReader(c.connect[fdef.clk], c.id, "CLK");
      if (ff.clr) addReader(c.connect[fdef.clr], c.id, "CLR");
      addDriver(c.connect[fdef.q], { kind: "ffq", id: c.id, ff, inv: false, label: `${c.id} の Q` });
      addDriver(c.connect[fdef.qn], { kind: "ffq", id: c.id, ff, inv: true, label: `${c.id} の Q_NOT` });
      continue;
    }

    switch (c.type) {
      case "LOGIC_IN": {
        const v = getNumericParam(c, "value", 0) >= 0.5 ? 1 : 0;
        const drv = { kind: "input", id: c.id, value: v, label: `入力 ${c.id}` };
        inputs.push({ id: c.id, net: rep(c.connect[0]), drv });
        addDriver(c.connect[0], drv);
        break;
      }
      case "V_DC": {
        const [p, n] = c.connect;
        const V = getNumericParam(c, "V", 5);
        if (rep(n) === rep("gnd")) {
          const value = V >= CONST_VIH ? 1 : V <= CONST_VIL ? 0 : LOGIC_X;
          addDriver(p, { kind: "const", id: c.id, value, label: `${c.id}（${V}V）` });
        } else {
          warnings.push(`部品 ${c.id}: digital モードでは − 端子が gnd の V_DC だけを定数（論理 0/1）として扱います。`);
        }
        break;
      }
      case "R": {
        const [a, b] = c.connect.map(rep);
        if (a !== b) {
          if (!weakLinks.has(a)) weakLinks.set(a, []);
          if (!weakLinks.has(b)) weakLinks.set(b, []);
          weakLinks.get(a).push({ net: b, id: c.id });
          weakLinks.get(b).push({ net: a, id: c.id });
        }
        break;
      }
      default:
        if (!SILENT_TYPES.has(c.type)) ignored.push(c.id);
    }
  }

  if (ignored.length > 0) {
    warnings.push(`digital モードでは次の部品を無視します（論理素子ではないため）: ${ignored.join(", ")}`);
  }

  const nets = new Set();
  for (const c of comps) for (const n of c.connect) nets.add(rep(n));
  nets.add("gnd");

  return {
    rep,
    nets: [...nets],
    drivers,
    weakLinks,
    readers,
    gates,
    flipflops,
    inputs,
    componentsById,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 状態と落ち着くまでの反復                                             */
/* ------------------------------------------------------------------ */

/**
 * 初期状態: ネットはすべて X、DFF の Q は 0。
 */
export function createLogicState(model) {
  const values = new Map();
  for (const n of model.nets) values.set(n, LOGIC_X);
  const q = new Map();
  const lastClk = new Map();
  for (const ff of model.flipflops) {
    q.set(ff.id, 0);
    lastClk.set(ff.id, LOGIC_X);
  }
  return { values, q, lastClk, oscillating: new Set() };
}

function driverValue(drv, prev, state, stim) {
  switch (drv.kind) {
    case "const":
      return drv.value;
    case "input": // LOGIC_IN（判定が駆動するときは stimNet が付く）
      return drv.stimNet && stim.has(drv.stimNet) ? stim.get(drv.stimNet) : drv.value;
    case "stim": // LOGIC_IN の無い入力ネットに判定が足す仮想ドライバ
      return stim.has(drv.net) ? stim.get(drv.net) : drv.value;
    case "gate":
      return drv.gate.fn(drv.gate.in.map((n) => prev.get(n) ?? LOGIC_X));
    case "ffq": {
      const q = state.q.get(drv.id);
      return drv.inv ? lnot(q) : q;
    }
    default:
      return LOGIC_X;
  }
}

/** 1ステップ（全素子を同時に更新）。変化があれば true。 */
function stepOnce(model, state, stim, extraDrivers) {
  const prev = state.values;
  let changed = false;

  // 1. フリップフロップ（前ステップのネット値を使う）
  for (const ff of model.flipflops) {
    const clk = prev.get(ff.clk) ?? LOGIC_X;
    const last = state.lastClk.get(ff.id);
    const oldQ = state.q.get(ff.id);
    let q = oldQ;
    const clr = ff.clr ? prev.get(ff.clr) ?? LOGIC_X : 1;
    if (clr === 0) {
      q = 0;
    } else if (last === 0 && clk === 1) {
      q = prev.get(ff.d) ?? LOGIC_X;
    }
    if (clr === LOGIC_X && q !== 0) q = LOGIC_X; // クリア入力が不定なら Q も不定
    state.lastClk.set(ff.id, clk);
    if (q !== oldQ) {
      state.q.set(ff.id, q);
      changed = true;
    }
  }

  // 2. 強い駆動
  const next = new Map();
  const strong = new Set();
  for (const net of model.nets) {
    const list = [...(model.drivers.get(net) ?? []), ...(extraDrivers.get(net) ?? [])];
    if (list.length === 0) continue;
    let v = null;
    for (const drv of list) {
      const dv = driverValue(drv, prev, state, stim);
      if (v === null) v = dv;
      else if (v !== dv) v = LOGIC_X;
    }
    next.set(net, v);
    strong.add(net);
  }

  // 3. 弱い駆動（R でつながった、強く駆動されたネットの値）。無ければ浮き = X
  for (const net of model.nets) {
    if (strong.has(net)) continue;
    let v = null;
    for (const link of model.weakLinks.get(net) ?? []) {
      if (!strong.has(link.net)) continue;
      const lv = next.get(link.net);
      if (v === null) v = lv;
      else if (v !== lv) v = LOGIC_X;
    }
    next.set(net, v === null ? LOGIC_X : v);
  }

  // 発振で X に固定したネット
  for (const net of state.oscillating) next.set(net, LOGIC_X);

  for (const net of model.nets) {
    if (next.get(net) !== prev.get(net)) {
      changed = true;
      break;
    }
  }
  state.values = next;
  return changed;
}

/**
 * 入力（stim: rep ネット → 0/1）を与えて、回路が落ち着くまで反復します。
 * 落ち着かない（発振する）ときは揺れ続けるネットを X に固定します。
 *
 * @returns {{converged: boolean, oscillating: string[]}}
 */
export function settleLogic(model, state, stim, extraDrivers = new Map()) {
  const maxIter = 4 * (model.gates.length + model.flipflops.length) + 20;
  for (let i = 0; i < maxIter; i += 1) {
    if (!stepOnce(model, state, stim, extraDrivers)) return { converged: true, oscillating: [] };
  }
  // 発振: しばらく回して変化するネットを記録し、X に固定してもう一度落ち着かせる
  const toggling = new Set();
  for (let i = 0; i < 2 * maxIter; i += 1) {
    const before = new Map(state.values);
    stepOnce(model, state, stim, extraDrivers);
    for (const [net, v] of state.values) if (before.get(net) !== v) toggling.add(net);
  }
  for (const net of toggling) state.oscillating.add(net);
  for (let i = 0; i < maxIter; i += 1) {
    if (!stepOnce(model, state, stim, extraDrivers)) break;
  }
  return { converged: false, oscillating: [...toggling] };
}

/* ------------------------------------------------------------------ */
/* 入力の割り当てと構造の診断                                           */
/* ------------------------------------------------------------------ */

/**
 * 判定が駆動する入力ネットを準備します。
 * - そのネットに LOGIC_IN があれば、その値を上書きする。
 * - 無ければ仮想の入力ドライバを足す（旧問題向け。validation が警告する）。
 *
 * @returns {{stimNets: string[], extraDrivers: Map, problems: string[]}}
 */
function prepareStimulus(model, netNames) {
  const extraDrivers = new Map();
  const stimNets = [];
  const problems = [];
  for (const name of netNames) {
    const r = model.rep(name);
    stimNets.push(r);
    const inputsHere = model.inputs.filter((inp) => inp.net === r);
    if (inputsHere.length > 0) {
      // LOGIC_IN の値を判定側から与える（stimNet を付けて上書き）
      for (const inp of inputsHere) inp.drv.stimNet = r;
    } else {
      extraDrivers.set(r, [{ kind: "stim", id: `__stim_${name}`, net: r, value: 0, label: `入力 ${name}` }]);
    }
    if (r === "gnd") problems.push(`入力 ${name} がグラウンドにつながっています。`);
  }
  // 別名の入力ネット同士がショートしていないか
  const seen = new Map();
  netNames.forEach((name, i) => {
    const r = stimNets[i];
    if (seen.has(r)) problems.push(`入力 ${seen.get(r)} と ${name} が同じネットにつながっています（ショート）。`);
    else seen.set(r, name);
  });
  return { stimNets, extraDrivers, problems };
}

function clearStimulus(model) {
  for (const inp of model.inputs) delete inp.drv.stimNet;
}

/**
 * 判定対象の出力から入力側へたどり、浮いた入力ピンと出力の衝突を探します。
 *
 * @returns {string[]} 問題点（空なら OK）
 */
function diagnoseCone(model, outputNames, extraDrivers) {
  const problems = [];
  const visited = new Set();
  const queue = [];
  for (const name of outputNames) {
    const r = model.rep(name);
    queue.push({ net: r, via: null, name });
  }
  const strongDrivers = (net) => [...(model.drivers.get(net) ?? []), ...(extraDrivers.get(net) ?? [])];

  while (queue.length > 0) {
    const { net, via, name } = queue.shift();
    if (visited.has(net)) continue;
    visited.add(net);
    const list = strongDrivers(net);

    if (list.length > 1) {
      const labels = list.map((d) => d.label);
      // 同じ値の定数どうし（gnd と 0V 電源など）は衝突とみなさない
      const sameConst = list.every((d) => d.kind === "const" && d.value === list[0].value);
      if (!sameConst) {
        problems.push(
          `${describeNet(net, model)} に出力が ${labels.length} 個つながっています（${labels.join(" と ")}）。出力どうしをつなぐと衝突します。`
        );
      }
    }

    if (list.length === 0) {
      const weak = (model.weakLinks.get(net) ?? []).filter((l) => strongDrivers(l.net).length > 0);
      if (weak.length === 0) {
        if (via && net.startsWith(NC_PREFIX)) {
          problems.push(`${via.id} の ${via.pin} 入力が未配線です（CMOS の入力は開放にできません）。`);
        } else if (via) {
          problems.push(`${via.id} の ${via.pin} 入力が未接続です（ネット ${net} を駆動する出力がありません）。`);
        } else {
          problems.push(`出力 ${name} を駆動するものがありません（未接続）。`);
        }
        continue;
      }
      for (const l of weak) queue.push({ net: l.net, via: null, name: l.net });
      continue;
    }

    for (const drv of list) {
      if (drv.kind === "gate") {
        drv.gate.in.forEach((n, i) => {
          queue.push({ net: n, via: { id: drv.id, pin: GATE_PIN_NAMES[drv.gate.in.length][i] } });
        });
      } else if (drv.kind === "ffq") {
        const ff = drv.ff;
        queue.push({ net: ff.d, via: { id: ff.id, pin: "D" } });
        queue.push({ net: ff.clk, via: { id: ff.id, pin: "CLK" } });
        if (ff.clr) queue.push({ net: ff.clr, via: { id: ff.id, pin: "CLR" } });
      }
    }
  }
  // 同じ問題を重複して出さない
  return [...new Set(problems)];
}

/* ------------------------------------------------------------------ */
/* 入出力ネットの決定                                                   */
/* ------------------------------------------------------------------ */

function netListFrom(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) continue;
    const n = item.trim();
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** inputs 省略時: LOGIC_IN のネット（部品 ID 順）。 */
function defaultInputs(components) {
  return (components ?? [])
    .filter((c) => c?.type === "LOGIC_IN" && typeof c.connect?.[0] === "string" && c.connect[0].trim())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((c) => c.connect[0].trim());
}

/** outputs 省略時: TP のネット（部品 ID 順）。 */
function defaultOutputs(components) {
  return (components ?? [])
    .filter((c) => c?.type === "TP" && typeof c.connect?.[0] === "string" && c.connect[0].trim())
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((c) => c.connect[0].trim());
}

/** 判定が参照するネットが回路に存在するか。 */
function missingNets(components, names) {
  const all = new Set();
  for (const c of components ?? []) for (const n of c?.connect ?? []) if (typeof n === "string") all.add(n.trim());
  return names.filter((n) => !all.has(n) && !isGroundNet(n));
}

/* ------------------------------------------------------------------ */
/* 真理値表                                                             */
/* ------------------------------------------------------------------ */

/**
 * 真理値表を作ります（組み合わせ回路用。各行は初期状態（ネット X、DFF Q=0）から評価）。
 *
 * @param {object} circuit { components }
 * @param {object} check truthTable 判定（inputs, outputs, driveLowV, driveHighV, vih, vil）
 * @returns {{
 *   ok: boolean, method: "gate"|"dc", inputs: string[], outputs: string[],
 *   rows: Array<{in: number[], out: number[]}>, problems: string[], warnings: string[]
 * }}
 *   rows[i].in は inputs[0] を最上位ビットとする2進数の順（000, 001, 010, …）。out は 0/1/LOGIC_X。
 */
export function evaluateTruthTable(circuit, check = {}) {
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  const inputs = netListFrom(check.inputs).length ? netListFrom(check.inputs) : defaultInputs(components);
  const outputs = netListFrom(check.outputs).length ? netListFrom(check.outputs) : defaultOutputs(components);
  const res = { ok: false, method: "gate", inputs, outputs, rows: [], problems: [], warnings: [] };

  if (inputs.length === 0) res.problems.push("真理値表の入力ネット（inputs）がありません。");
  if (outputs.length === 0) res.problems.push("真理値表の出力ネット（outputs）がありません。");
  if (inputs.length > MAX_SWEEP_INPUTS) res.problems.push(`入力が多すぎます（${inputs.length} 個、上限 ${MAX_SWEEP_INPUTS} 個）。`);
  if (inputs.some(isGroundNet) || outputs.some(isGroundNet)) res.problems.push("入出力に gnd は指定できません。");
  for (const n of missingNets(components, [...inputs, ...outputs])) {
    res.problems.push(`ネット ${n} が回路にありません（何もつながっていません）。`);
  }
  if (res.problems.length > 0) return res;

  if (!hasDigitalParts(components)) {
    res.method = "dc";
    return evaluateTruthTableByDc(components, check, res);
  }

  const model = buildLogicModel(components);
  res.warnings.push(...model.warnings);
  const { stimNets, extraDrivers, problems } = prepareStimulus(model, inputs);
  res.problems.push(...problems);
  res.problems.push(...diagnoseCone(model, outputs, extraDrivers));
  if (res.problems.length > 0) {
    clearStimulus(model);
    return res;
  }

  const outReps = outputs.map((n) => model.rep(n));
  const rows = 1 << inputs.length;
  let osc = false;
  for (let row = 0; row < rows; row += 1) {
    const bits = inputs.map((_, j) => (row >> (inputs.length - 1 - j)) & 1);
    const stim = new Map(stimNets.map((n, j) => [n, bits[j]]));
    const state = createLogicState(model);
    const s = settleLogic(model, state, stim, extraDrivers);
    if (!s.converged) osc = true;
    res.rows.push({ in: bits, out: outReps.map((n) => state.values.get(n) ?? LOGIC_X) });
  }
  clearStimulus(model);
  if (osc) res.warnings.push("帰還ループが落ち着かない（発振する）入力の組み合わせがありました。揺れるネットは X としました。");
  res.ok = true;
  return res;
}

function evaluateTruthTableByDc(components, check, res) {
  const { inputs, outputs } = res;
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
  const driveLowV = num(check.driveLowV, 0);
  const driveHighV = num(check.driveHighV, 5);
  const vih = num(check.vih, driveHighV / 2);
  const vil = num(check.vil, vih);
  const rows = 1 << inputs.length;

  for (let row = 0; row < rows; row += 1) {
    const bits = inputs.map((_, j) => (row >> (inputs.length - 1 - j)) & 1);
    const drivers = inputs.map((net, j) => ({
      id: `${DRIVER_ID_PREFIX}${j}_${net}`,
      type: "V_DC",
      params: { V: bits[j] ? driveHighV : driveLowV },
      connect: [net, "gnd"],
    }));
    const dcResult = runDc({ components: [...components, ...drivers], wires: [], nodes: [] });
    if (!dcResult?.ok) {
      res.problems.push(`入力 ${bits.join("")} の DC 解析に失敗しました: ${(dcResult?.errors ?? []).join(" / ")}`);
      return res;
    }
    const nodes = dcResult.dc?.nodes ?? {};
    res.rows.push({
      in: bits,
      out: outputs.map((net) => {
        const v = nodes[net];
        if (!Number.isFinite(v)) return LOGIC_X;
        return v >= vih ? 1 : v <= vil ? 0 : LOGIC_X;
      }),
      volts: outputs.map((net) => nodes[net]),
    });
  }
  res.ok = true;
  return res;
}

/**
 * 判定の期待値を「入力ビット列 → 出力期待値配列」の Map にします。
 * - table: [[in..., out...], ...]（行の順は自由。書いた行だけ判定）
 * - expect: { 出力ネット: "0110" }（2進数の順で全行。x は don't care）
 *
 * @returns {{map: Map<string, Array<0|1|null>>, errors: string[]}}
 */
export function buildExpectedTruthMap(check, inputs, outputs) {
  const map = new Map();
  const errors = [];
  const nIn = inputs.length;
  const nOut = outputs.length;

  if (Array.isArray(check.table)) {
    check.table.forEach((row, i) => {
      const cells = toLogicSeries(row);
      if (!Array.isArray(cells) || cells.length !== nIn + nOut) {
        errors.push(`table[${i}] の列数が inputs + outputs（${nIn + nOut}）と一致しません。`);
        return;
      }
      const ins = cells.slice(0, nIn).map(parseExpectedLogic);
      const outs = cells.slice(nIn).map(parseExpectedLogic);
      if (ins.some((v) => v === undefined || v === null) || outs.some((v) => v === undefined)) {
        errors.push(`table[${i}] に解釈できない値があります（入力は 0/1、出力は 0/1/"x"）。`);
        return;
      }
      const key = ins.join("");
      if (map.has(key)) errors.push(`table に入力 ${key} の行が重複しています。`);
      map.set(key, outs);
    });
  }

  if (check.expect && typeof check.expect === "object" && !Array.isArray(check.expect)) {
    const rows = 1 << nIn;
    for (const [net, series] of Object.entries(check.expect)) {
      const col = outputs.indexOf(net);
      const arr = toLogicSeries(series);
      if (col < 0) {
        errors.push(`expect.${net} は outputs にありません。`);
        continue;
      }
      if (!Array.isArray(arr) || arr.length !== rows) {
        errors.push(`expect.${net} は ${rows} 個（2^入力数）の値が必要です。`);
        continue;
      }
      for (let row = 0; row < rows; row += 1) {
        const key = inputs.map((_, j) => (row >> (nIn - 1 - j)) & 1).join("");
        const v = parseExpectedLogic(arr[row]);
        if (v === undefined) {
          errors.push(`expect.${net}[${row}] が解釈できません（0/1/"x"）。`);
          continue;
        }
        if (!map.has(key)) map.set(key, new Array(nOut).fill(null));
        map.get(key)[col] = v;
      }
    }
  }

  if (map.size === 0 && errors.length === 0) errors.push("期待する真理値表（table または expect）がありません。");
  return { map, errors };
}

/* ------------------------------------------------------------------ */
/* 系列（順序回路）                                                     */
/* ------------------------------------------------------------------ */

/**
 * クロックごとの入力系列を与え、出力系列を記録します。
 *
 * 手順（clock あり、sampleAt="afterRise"（既定））:
 *   電源投入（ネット X、DFF Q=0）→ CLK=0・入力=1ステップ目の値で落ち着かせる。
 *   各ステップ k について:
 *     1. CLK=0 のまま入力を k 番目の値にして落ち着かせる（"beforeRise" ならここで記録）
 *     2. CLK を 1 にして落ち着かせ、出力を記録（"afterRise"）
 *     3. CLK を 0 に戻して落ち着かせる
 * clock なし: 各ステップで入力を与えて落ち着かせ、出力を記録する（ラッチ・組み合わせ回路）。
 *
 * @param {object} circuit
 * @param {object} check { clock, inputs: {net: series}, outputs: {net: series}, sampleAt }
 * @returns {{ok:boolean, steps:number, inputs:string[], outputs:string[],
 *            actual: Record<string, number[]>, problems:string[], warnings:string[]}}
 */
export function evaluateSequence(circuit, check = {}) {
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  const res = { ok: false, steps: 0, inputs: [], outputs: [], actual: {}, problems: [], warnings: [] };
  const clock = typeof check.clock === "string" && check.clock.trim() ? check.clock.trim() : null;
  const sampleAt = check.sampleAt === "beforeRise" ? "beforeRise" : "afterRise";

  const inSeries = {};
  for (const [net, s] of Object.entries(check.inputs ?? {})) {
    const arr = toLogicSeries(s);
    const vals = (arr ?? []).map(parseExpectedLogic);
    if (!arr || vals.some((v) => v === undefined || v === null)) {
      res.problems.push(`inputs.${net} は 0/1 の系列にしてください。`);
      continue;
    }
    inSeries[net] = vals;
  }
  const outNames = Object.keys(check.outputs ?? {});
  let steps = 0;
  for (const net of outNames) steps = Math.max(steps, (toLogicSeries(check.outputs[net]) ?? []).length);
  for (const v of Object.values(inSeries)) steps = Math.max(steps, v.length);
  res.steps = steps;
  res.inputs = Object.keys(inSeries);
  res.outputs = outNames;

  if (outNames.length === 0) res.problems.push("sequence 判定に outputs がありません。");
  if (steps === 0) res.problems.push("sequence 判定の系列が空です。");
  if (steps > MAX_SEQUENCE_STEPS) res.problems.push(`系列が長すぎます（上限 ${MAX_SEQUENCE_STEPS}）。`);
  for (const [net, v] of Object.entries(inSeries)) {
    if (v.length !== steps) res.problems.push(`inputs.${net} の長さ（${v.length}）が他の系列（${steps}）と違います。`);
  }
  if (clock && res.inputs.includes(clock)) res.problems.push(`clock（${clock}）を inputs にも書くことはできません。`);
  const stimNames = [...(clock ? [clock] : []), ...res.inputs];
  if (!clock && res.inputs.length === 0) res.problems.push("clock も inputs もありません。");
  for (const n of missingNets(components, [...stimNames, ...outNames])) {
    res.problems.push(`ネット ${n} が回路にありません（何もつながっていません）。`);
  }
  if (res.problems.length > 0) return res;

  const model = buildLogicModel(components);
  res.warnings.push(...model.warnings);
  const { stimNets, extraDrivers, problems } = prepareStimulus(model, stimNames);
  res.problems.push(...problems);
  res.problems.push(...diagnoseCone(model, outNames, extraDrivers));
  if (res.problems.length > 0) {
    clearStimulus(model);
    return res;
  }

  const clockRep = clock ? stimNets[0] : null;
  const inputReps = clock ? stimNets.slice(1) : stimNets;
  const outReps = outNames.map((n) => model.rep(n));
  for (const n of outNames) res.actual[n] = [];

  const state = createLogicState(model);
  const stim = new Map();
  const applyInputs = (k) => res.inputs.forEach((net, j) => stim.set(inputReps[j], inSeries[net][k]));
  const sample = () => outNames.forEach((n, j) => res.actual[n].push(state.values.get(outReps[j]) ?? LOGIC_X));
  let osc = false;
  const settle = () => {
    if (!settleLogic(model, state, stim, extraDrivers).converged) osc = true;
  };

  if (clockRep) stim.set(clockRep, 0);
  applyInputs(0);
  settle();
  for (let k = 0; k < steps; k += 1) {
    applyInputs(k);
    settle();
    if (!clockRep || sampleAt === "beforeRise") sample();
    if (clockRep) {
      stim.set(clockRep, 1);
      settle();
      if (sampleAt === "afterRise") sample();
      stim.set(clockRep, 0);
      settle();
    }
  }
  clearStimulus(model);
  if (osc) res.warnings.push("帰還ループが落ち着かない（発振する）ステップがありました。揺れるネットは X としました。");
  res.ok = true;
  return res;
}

/* ------------------------------------------------------------------ */
/* モード本体                                                           */
/* ------------------------------------------------------------------ */

/**
 * digital シミュレーション本体。
 *  - checks の最初の truthTable / sequence を評価して結果を返す（UI 表示用）。
 *    判定そのものは runner.js が check ごとに evaluateTruthTable / evaluateSequence を呼ぶ。
 *  - netValues: LOGIC_IN の value パラメータ（既定 0）を入力とした、現在の各ネットの論理値。
 *  - 部品の誤配線などは判定側で詳しく報告するので、ここでは ok=true（警告のみ）。
 */
export function runDigital(circuit, options = {}) {
  const warnings = [];
  const components = Array.isArray(circuit?.components) ? circuit.components : [];
  const digital = {
    truthTable: null,
    inputs: [],
    outputs: [],
    measurements: [],
    sequence: null,
    netValues: {},
  };

  if (hasDigitalParts(components)) {
    const model = buildLogicModel(components);
    warnings.push(...model.warnings);
    const state = createLogicState(model);
    const s = settleLogic(model, state, new Map());
    if (!s.converged) warnings.push("帰還ループが落ち着きません（発振）。揺れるネットは X としました。");
    for (const c of components) {
      for (const net of c?.connect ?? []) {
        if (typeof net !== "string" || !net.trim() || isGroundNet(net)) continue;
        digital.netValues[net] = logicToChar(state.values.get(model.rep(net.trim())) ?? LOGIC_X);
      }
    }
  }

  const checks = Array.isArray(options.checks) ? options.checks : [];
  const tt = checks.find((c) => c?.type === "truthTable");
  if (tt) {
    const r = evaluateTruthTable({ components }, tt);
    warnings.push(...r.warnings);
    if (r.ok) {
      digital.truthTable = r.rows.map((row) => [...row.in, ...row.out.map((v) => (v === LOGIC_X ? "x" : v))]);
      digital.inputs = r.inputs;
      digital.outputs = r.outputs;
      digital.measurements = r.rows.map((row) => ({
        inputs: Object.fromEntries(r.inputs.map((n, j) => [n, row.in[j]])),
        outputs: Object.fromEntries(r.outputs.map((n, j) => [n, row.volts ? row.volts[j] : logicToChar(row.out[j])])),
      }));
    } else {
      warnings.push(...r.problems);
    }
  }
  const sq = checks.find((c) => c?.type === "sequence");
  if (sq) {
    const r = evaluateSequence({ components }, sq);
    warnings.push(...r.warnings);
    if (r.ok) {
      digital.sequence = Object.fromEntries(Object.entries(r.actual).map(([n, a]) => [n, a.map(logicToChar).join("")]));
    } else {
      warnings.push(...r.problems);
    }
  }

  return { ok: true, digital, errors: [], warnings: [...new Set(warnings)] };
}

/**
 * digital モードを registerSimulationMode に登録します。
 */
export function registerDigitalMode() {
  registerSimulationMode("digital", async (circuit, options) => runDigital(circuit, options));
}

// import された時点で自動登録（setup.js での明示呼び出しも可）
registerDigitalMode();
