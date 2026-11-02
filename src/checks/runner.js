/**
 * チェック実行ユーティリティです。
 *
 * 役割:
 * - 問題の checks 配列を1件ずつ実行する
 * - チェック種別ごとのハンドラを登録する
 * - 数値許容誤差を判定する
 * - チェック結果を統一形式へ整える
 *
 * 方針:
 * - チェック種別は後から追加できる。
 * - シミュレーション結果が必要なチェックと、
 *   回路状態だけで判定できるチェックを分けられるようにする。
 * - ハンドラが例外を投げても、ランナー全体は止めない。
 */

import { CONFIG } from "../config.js";
import {
  formatMetricValue,
  parseMetricValue,
} from "../core/units.js";
import { componentRegistry } from "../components/registry.js";
import { resolvePinName } from "../core/validation.js";
import {
  interpolateAt,
  measureTimeConstant,
  estimateOscillationFrequency,
} from "../sim/waveform.js";
import { acVariantKey, acImpedanceKey } from "../sim/ac.js";
import {
  evaluateTruthTable,
  evaluateSequence,
  buildExpectedTruthMap,
  toLogicSeries,
  parseExpectedLogic,
  logicToChar,
} from "../sim/digital.js";

/**
 * チェックハンドラのレジストリ。
 *
 * @type {Map<string, {run: Function, requiresSimulation: boolean}>}
 */
const checkHandlers = new Map();

/* ==========================================================================
   基本ヘルパー
   ========================================================================== */

/**
 * チェック種別を正規化します。
 *
 * @param {string} type
 * @returns {string}
 */
export function normalizeCheckType(type) {
  return String(type ?? "").trim();
}

/**
 * チェック結果の基本形を作成します。
 *
 * @param {object} values
 * @returns {object}
 */
function createCheckResult(values) {
  return {
    index: values.index ?? 0,
    type: values.type ?? "unknown",
    ok: Boolean(values.ok),
    message: values.message ?? "",
    expected: values.expected ?? null,
    actual: values.actual ?? null,
    tolerancePct: values.tolerancePct ?? null,
    details: values.details ?? null,
  };
}

/**
 * チェックハンドラを登録します。
 *
 * @param {string} type
 * @param {Function | {run: Function, requiresSimulation?: boolean}} handler
 */
export function registerCheckHandler(type, handler) {
  const normalizedType = normalizeCheckType(type);

  if (!normalizedType) {
    throw new Error("チェック種別が空です。");
  }

  if (typeof handler === "function") {
    checkHandlers.set(normalizedType, {
      run: handler,
      requiresSimulation: false,
    });
    return;
  }

  if (handler && typeof handler.run === "function") {
    checkHandlers.set(normalizedType, {
      run: handler.run,
      requiresSimulation: Boolean(handler.requiresSimulation),
    });
    return;
  }

  throw new Error(
    `チェックハンドラは関数、または { run } オブジェクトである必要があります。type=${normalizedType}`
  );
}

/**
 * チェックハンドラ登録を解除します。
 *
 * @param {string} type
 */
export function unregisterCheckHandler(type) {
  const normalizedType = normalizeCheckType(type);

  checkHandlers.delete(normalizedType);
}

/**
 * チェック種別が登録済みかどうかを返します。
 *
 * @param {string} type
 * @returns {boolean}
 */
export function hasCheckHandler(type) {
  const normalizedType = normalizeCheckType(type);

  return checkHandlers.has(normalizedType);
}

/**
 * 登録済みチェック種別一覧を返します。
 *
 * @returns {Array<string>}
 */
export function getRegisteredCheckTypes() {
  return Array.from(checkHandlers.keys());
}

/* ==========================================================================
   数値比較 / 許容誤差
   ========================================================================== */

/**
 * 数値が許容誤差内かどうかを判定します。
 *
 * @param {number} expected
 * @param {number} actual
 * @param {number} [tolerancePct]
 * @param {number} [absoluteTolerance=1e-12]
 * @returns {boolean}
 */
export function isWithinTolerance(
  expected,
  actual,
  tolerancePct,
  absoluteTolerance = 1e-12
) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return false;
  }

  const normalizedTolerancePct = Number.isFinite(tolerancePct)
    ? Math.abs(tolerancePct)
    : CONFIG.checks.defaultTolerancePct;

  const diff = Math.abs(actual - expected);
  const relativeTolerance =
    Math.abs(expected) * (normalizedTolerancePct / 100);

  const finalTolerance = Math.max(
    relativeTolerance,
    Math.abs(absoluteTolerance)
  );

  return diff <= finalTolerance;
}

/**
 * 表示用テキストへ変換します。
 *
 * @param {number | null | undefined} value
 * @param {string} unit
 * @returns {string}
 */
function formatValue(value, unit = "") {
  if (!Number.isFinite(value)) {
    return "未取得";
  }

  return formatMetricValue(value, unit);
}

/**
 * 数値チェック結果を作成します。
 *
 * @param {object} values
 * @returns {object}
 */
function compareNumeric(values) {
  const {
    expected,
    actual,
    tolerancePct,
    absoluteTolerance,
    toleranceAbs,
    unit = "",
    label = "値",
  } = values;

  // toleranceAbs（絶対許容誤差、単位は判定量と同じ）が指定されていれば
  // 相対許容誤差と大きい方を採用する。期待値 0 の判定（0dB, 0° など）で必須。
  const absTol = Number.isFinite(toleranceAbs)
    ? Math.abs(toleranceAbs)
    : absoluteTolerance;

  const ok = isWithinTolerance(
    expected,
    actual,
    tolerancePct,
    absTol
  );

  const expectedText = formatValue(expected, unit);
  const actualText = Number.isFinite(actual)
    ? formatValue(actual, unit)
    : "未取得";

  const message = ok
    ? `${label}は許容範囲内です。期待値: ${expectedText}, 実際: ${actualText}`
    : `${label}が期待値と異なります。期待値: ${expectedText}, 実際: ${actualText}`;

  return {
    ok,
    expected,
    actual,
    tolerancePct: tolerancePct ?? null,
    message,
  };
}

/* ==========================================================================
   回路 / シミュレーション結果参照ヘルパー
   ========================================================================== */

/**
 * 回路状態から部品を探します。
 *
 * @param {object} circuit
 * @param {string} elementId
 * @returns {object | null}
 */
export function findCircuitComponent(circuit, elementId) {
  const components = circuit?.components ?? [];

  return (
    components.find((component) => component.id === elementId) ?? null
  );
}

/**
 * シミュレーション結果からノード電圧を取得します。
 *
 * @param {object} simulationResult
 * @param {string} node
 * @returns {number | null}
 */
export function getDcNodeVoltage(simulationResult, node) {
  const value = simulationResult?.dc?.nodes?.[node];

  return Number.isFinite(value) ? value : null;
}

/**
 * シミュレーション結果から部品値を取得します。
 *
 * @param {object} simulationResult
 * @param {string} elementId
 * @param {string} field
 * @returns {number | null}
 */
export function getDcElementValue(simulationResult, elementId, field) {
  const value = simulationResult?.dc?.elements?.[elementId]?.[field];

  return Number.isFinite(value) ? value : null;
}

/**
 * 部品から代表的な値パラメータ名を推定します。
 *
 * @param {object} component
 * @returns {string}
 */
function inferValueParamKey(component) {
  const type = component?.type ?? "";

  const paramKeyMap = {
    R: "R",
    RESISTOR: "R",
    C: "C",
    CAPACITOR: "C",
    L: "L",
    INDUCTOR: "L",
    V: "V",
    V_DC: "V",
    V_AC: "V",
    I: "I",
    I_DC: "I",
    I_AC: "I",
  };

  const normalizedType = String(type).toUpperCase();

  if (paramKeyMap[normalizedType]) {
    return paramKeyMap[normalizedType];
  }

  const paramKeys = Object.keys(component?.params ?? {});

  return paramKeys[0] ?? "value";
}

/**
 * 部品パラメータ値を数値へ変換します。
 *
 * @param {unknown} rawValue
 * @returns {number}
 */
function coerceComponentParamValue(rawValue) {
  if (typeof rawValue === "number") {
    return rawValue;
  }

  return parseMetricValue(rawValue);
}

/* ==========================================================================
   論理値 / 真理値表ヘルパー
   ========================================================================== */

/**
 * 論理値を 0/1 へ正規化します。
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeLogicValue(value) {
  if (value === true || value === 1 || value === "1" || value === "H") {
    return 1;
  }

  return 0;
}

/**
 * 真理値表を正規化します。
 *
 * @param {Array<Array<unknown>>} table
 * @returns {Array<Array<number>>}
 */
function normalizeTruthTable(table) {
  if (!Array.isArray(table)) {
    return [];
  }

  return table.map((row) => {
    if (!Array.isArray(row)) {
      return [];
    }

    return row.map((value) => normalizeLogicValue(value));
  });
}

/**
 * 真理値表が等しいかを判定します。
 *
 * @param {Array<Array<number>>} a
 * @param {Array<Array<number>>} b
 * @returns {boolean}
 */
function isEqualTruthTable(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  for (let rowIndex = 0; rowIndex < a.length; rowIndex += 1) {
    const rowA = a[rowIndex];
    const rowB = b[rowIndex];

    if (rowA.length !== rowB.length) {
      return false;
    }

    for (let colIndex = 0; colIndex < rowA.length; colIndex += 1) {
      if (rowA[colIndex] !== rowB[colIndex]) {
        return false;
      }
    }
  }

  return true;
}

/* ==========================================================================
   過渡 / AC 結果参照ヘルパ
   ========================================================================== */

/**
 * 過渡解析結果から指定時刻のノード電圧を線形補間で取得します。
 *
 * @param {object} simulationResult
 * @param {string} node
 * @param {number} timeSec
 * @returns {number | null}
 */
export function getTransientNodeAtTime(simulationResult, node, timeSec) {
  const time = simulationResult?.transient?.time;
  const values = simulationResult?.transient?.nodes?.[node];

  if (!Array.isArray(time) || !Array.isArray(values)) return null;
  if (time.length === 0 || values.length === 0) return null;

  if (timeSec <= time[0]) return values[0];
  if (timeSec >= time[time.length - 1]) return values[values.length - 1];

  // 二分探索で timeSec を挟む区間を特定
  let lo = 0;
  let hi = time.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= timeSec) lo = mid;
    else hi = mid;
  }

  const t0 = time[lo];
  const t1 = time[hi];
  const v0 = values[lo];
  const v1 = values[hi];
  const denom = t1 - t0;
  if (denom === 0) return v0;

  return v0 + ((timeSec - t0) / denom) * (v1 - v0);
}

/**
 * AC 解析結果から指定周波数でのノード情報を取得します。
 * 周波数キーは JS の慣習で数値/文字列どちらでも引き当たります。
 *
 * @param {object} simulationResult
 * @param {string} node
 * @param {number} freqHz
 * @returns {{ re: number, im: number, peak: number, rms: number, phaseDeg: number } | null}
 */
export function getAcNodeAtFreq(simulationResult, node, freqHz) {
  const nodeData = simulationResult?.ac?.nodes?.[node];
  if (!nodeData) return null;

  return nodeData[freqHz] ?? nodeData[String(freqHz)] ?? null;
}

/**
 * 2つの位相角の差を (-180, 180] に正規化します。
 *
 * @param {number} a 度
 * @param {number} b 度
 * @returns {number}
 */
export function phaseDiffDeg(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/**
 * AC 判定用: ノード（または node − ref の差動）の複素フェーザ（ピーク値）を返します。
 * sources（電源の置き換え指定）があれば ac.variants の解を使います。
 * 取れなければ { error: 理由 } を返します。
 *
 * @returns {{ re: number, im: number } | { error: string }}
 */
function acPhasor(simulationResult, node, ref, freq, sources) {
  const ac = simulationResult?.ac;
  let nodesData = ac?.nodes;
  if (sources && typeof sources === "object") {
    nodesData = ac?.variants?.[acVariantKey(sources)]?.nodes;
    if (!nodesData) return { error: "電源を置き換えた解析結果がありません（sources の指定を確認してください）。" };
  }
  const get = (net) => {
    if (net === "gnd" || net === "0") return { re: 0, im: 0 };
    const d = nodesData?.[net]?.[freq] ?? nodesData?.[net]?.[String(freq)];
    return d && Number.isFinite(d.re) ? d : null;
  };
  const a = get(node);
  if (!a) {
    return { error: describeNodeProblem(simulationResult, node) ?? `ノード ${node} のAC電圧を取得できませんでした（${freq}Hz）。` };
  }
  if (!ref) return { re: a.re, im: a.im };
  const b = get(ref);
  if (!b) {
    return { error: describeNodeProblem(simulationResult, ref) ?? `ノード ${ref} のAC電圧を取得できませんでした（${freq}Hz）。` };
  }
  return { re: a.re - b.re, im: a.im - b.im };
}

/** 「out」または「out−outRef」の表示用ラベル */
function diffLabel(node, ref) {
  return ref ? `${node}−${ref}` : node;
}

/**
 * 過渡波形の統計量（transientMeasure 用）。区間 [fromSec, toSec] を時間で重み付けして計算します
 * （刻みが不均一でも正しい平均になるよう台形則で積分）。
 *
 * @param {number[]} time
 * @param {number[]} values
 * "duty" は区間のうち値が opts.threshold（既定: 区間の (最大+最小)/2）を超えている時間の割合（0〜1）。
 * しきい値を横切る時刻は前後の刻みから線形補間する。
 *
 * @param {string} measure "max" | "min" | "pp" | "average" | "rms" | "acRms" | "duty"
 * @param {{threshold?: number}} [opts]
 * @returns {number} 求められなければ NaN
 */
export function measureWaveform(time, values, measure, fromSec, toSec, opts = {}) {
  if (!Array.isArray(time) || !Array.isArray(values) || time.length < 2) return NaN;
  const t0 = Math.max(fromSec ?? time[0], time[0]);
  const t1 = Math.min(toSec ?? time[time.length - 1], time[time.length - 1]);
  if (!(t1 > t0)) return NaN;
  // 区間の端は線形補間した点を加える
  const ts = [t0];
  const vs = [interpolateAt(time, values, t0)];
  for (let i = 0; i < time.length; i++) {
    if (time[i] > t0 && time[i] < t1) {
      ts.push(time[i]);
      vs.push(values[i]);
    }
  }
  ts.push(t1);
  vs.push(interpolateAt(time, values, t1));
  // 最大・最小はループで求める（Math.max(...vs) は 10 万点を超えるとスタックが溢れる）
  if (measure === "max" || measure === "min" || measure === "pp") {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vs) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return measure === "max" ? hi : measure === "min" ? lo : hi - lo;
  }
  if (measure === "duty") {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vs) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const th = Number.isFinite(opts?.threshold) ? opts.threshold : (lo + hi) / 2;
    let high = 0;
    for (let i = 1; i < ts.length; i++) {
      const h = ts[i] - ts[i - 1];
      const a = vs[i - 1] - th;
      const b = vs[i] - th;
      if (a > 0 && b > 0) high += h;
      else if ((a > 0) !== (b > 0) && a !== b) {
        // 区間内でしきい値を横切る: 線形補間で横切る時刻を求める
        const frac = a / (a - b);
        high += a > 0 ? h * frac : h * (1 - frac);
      }
    }
    return high / (t1 - t0);
  }
  let s1 = 0;
  let s2 = 0;
  for (let i = 1; i < ts.length; i++) {
    const h = ts[i] - ts[i - 1];
    s1 += (h * (vs[i] + vs[i - 1])) / 2;
    s2 += (h * (vs[i] * vs[i] + vs[i - 1] * vs[i - 1])) / 2;
  }
  const T = t1 - t0;
  const mean = s1 / T;
  if (measure === "average") return mean;
  if (measure === "rms") return Math.sqrt(Math.max(s2 / T, 0));
  if (measure === "acRms") return Math.sqrt(Math.max(s2 / T - mean * mean, 0));
  return NaN;
}

/** transientMeasure の measure と表示名 */
const TRANSIENT_MEASURE_NAMES = {
  max: "最大値", min: "最小値", pp: "ピークtoピーク", average: "平均値", rms: "実効値", acRms: "交流分の実効値",
  duty: "デューティ比（High の時間の割合）", power: "平均電力", powerFactor: "力率",
};

/**
 * 部品の平均電力（v·i の時間平均。v = connect[0]−connect[1]、i は connect[0]→connect[1] の向き＝吸収が正）と
 * 電圧・電流の実効値。電源は供給しているとき負になる。
 */
function elementPower(time, el, fromSec, toSec) {
  const p = el.v.map((v, k) => v * el.i[k]);
  return {
    avg: measureWaveform(time, p, "average", fromSec, toSec),
    vrms: measureWaveform(time, el.v, "rms", fromSec, toSec),
    irms: measureWaveform(time, el.i, "rms", fromSec, toSec),
  };
}

/** 動作領域の日本語名（operatingRegion のメッセージ用） */
const REGION_LABEL = {
  off: "遮断（オフ）", active: "活性領域", saturation: "飽和領域", triode: "線形領域（三極管領域）",
  on: "導通", forward: "順方向導通", breakdown: "降伏",
  linear: "線形動作", satHigh: "出力が上側で飽和", satLow: "出力が下側で飽和", static: "-",
};

/* ==========================================================================
   ピン名ヘルパー（connection の pins 形式用）
   ========================================================================== */

/**
 * 部品種別のピン名一覧を返します（componentRegistry に読み込まれた components.json）。
 *
 * @param {string} type
 * @returns {Array<string> | null}
 */
export function getPinNamesForType(type) {
  try {
    if (componentRegistry.has(type)) {
      return componentRegistry.getPinNames(type);
    }
  } catch {
    // 未登録
  }
  return null;
}

/**
 * ピン名（または略記 A/K, C/B/E, D/G/S, +/-）からピン番号（connect 配列の添字）を求めます。
 * 略記の表は validation.js の resolvePinName と共通。
 */
export const resolvePinIndex = resolvePinName;

function normalizeNetName(net) {
  return typeof net === "string" ? net.trim() : "";
}

/** ネット名の一致判定。グラウンドは "gnd" / "0" を同一視する。 */
function netEquals(a, b) {
  const x = normalizeNetName(a);
  const y = normalizeNetName(b);
  if (!x || !y) return false;
  const isG = (n) => n === "gnd" || n === "0" || n.toLowerCase() === "gnd";
  if (isG(x) && isG(y)) return true;
  return x === y;
}

/**
 * 回答（数値または SI 接頭辞付き文字列）を数値にします。
 *
 * @param {unknown} raw
 * @returns {number}
 */
function coerceAnswerNumber(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const v = parseMetricValue(raw.trim());
    if (Number.isFinite(v)) return v;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/**
 * 回答値を context から取り出します。answers[key] を優先します。
 */
function getAnswer(context, key) {
  if (context?.answers && Object.prototype.hasOwnProperty.call(context.answers, key)) {
    return context.answers[key];
  }
  return context?.answer;
}

/**
 * ノードの値が取れないときの理由を説明します（未接続 / グラウンドから浮いている / 存在しない）。
 *
 * @param {object} simulationResult
 * @param {string} node
 * @returns {string | null} 値が取れる場合は null
 */
export function describeNodeProblem(simulationResult, node) {
  for (const key of ["dc", "transient", "ac"]) {
    const sec = simulationResult?.[key];
    if (!sec) continue;
    if (Array.isArray(sec.unconnectedNets) && sec.unconnectedNets.includes(node)) {
      return `ノード ${node} には部品がつながっていません（未接続）。`;
    }
    if (Array.isArray(sec.floatingNets) && sec.floatingNets.includes(node)) {
      return `ノード ${node} がグラウンド（gnd）につながっていません（回路が浮いています）。`;
    }
  }
  return null;
}

function nodeMissingResult(simulationResult, node, expected, fallback) {
  return {
    ok: false,
    message:
      describeNodeProblem(simulationResult, node) ??
      fallback ??
      `ノード ${node} は回路にありません（部品がつながっているか確認してください）。`,
    expected,
    actual: null,
  };
}

/**
 * match 条件に合う部品を回路から探します。
 *
 * match の形式:
 *   { "type": "R" | ["R","L"], "nets": ["vin","out"], "pins": { "anode": "vin" } }
 * - type（任意）: 部品種別
 * - nets（任意）: 部品のピンがこれらのネットすべてにつながっている（順不同）
 * - pins（任意）: ピン名 → ネット名（向きを含めて一致）
 * プレイヤーが置いた部品のID（R1, R2…）の付き方に依存せずに判定するために使う。
 *
 * @param {object} circuit
 * @param {object} match
 * @returns {Array<object>}
 */
export function findMatchingComponents(circuit, match) {
  const comps = circuit?.components ?? [];
  const types = match?.type === undefined ? null : Array.isArray(match.type) ? match.type : [match.type];
  return comps.filter((c) => {
    if (c.type === "GND" || c.type === "TP" || c.type === "WIRE") return false;
    if (types && !types.includes(c.type)) return false;
    const connect = Array.isArray(c.connect) ? c.connect : [];
    if (Array.isArray(match.nets)) {
      // 同じネットを2回書いた場合（両端とも同じネット）も数を考慮する
      const remaining = [...connect];
      for (const net of match.nets) {
        const i = remaining.findIndex((x) => netEquals(x, net));
        if (i < 0) return false;
        remaining.splice(i, 1);
      }
    }
    if (match.pins && typeof match.pins === "object") {
      const pinNames = getPinNamesForType(c.type);
      if (!pinNames) return false;
      for (const [pin, net] of Object.entries(match.pins)) {
        const i = resolvePinName(pinNames, pin);
        if (i < 0 || !netEquals(connect[i], net)) return false;
      }
    }
    return true;
  });
}

function describeMatch(match) {
  const parts = [];
  if (match?.type !== undefined) parts.push(`種別 ${[].concat(match.type).join("/")}`);
  if (Array.isArray(match?.nets)) parts.push(`${match.nets.join(" と ")} の間`);
  if (match?.pins) parts.push(Object.entries(match.pins).map(([p, n]) => `${p}→${n}`).join(", "));
  return parts.join("、") || "条件なし";
}

/* ==========================================================================
   既定チェックハンドラ
   ========================================================================== */

/**
 * 既定のチェックハンドラを登録します。
 *
 * ここに登録されたハンドラは、registerDefaultCheckHandlers() 呼び出し時に
 * すべて checkHandlers へ登録されます。
 */
export function registerDefaultCheckHandlers() {
  /**
   * DCノード電圧、または部品電圧をチェックします。
   */
  registerCheckHandler("dcVoltage", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      let actual = null;

      if (check.node) {
        actual = getDcNodeVoltage(simulationResult, check.node);
        if (!Number.isFinite(actual)) {
          return nodeMissingResult(simulationResult, check.node, check.expected);
        }
      } else if (check.element) {
        actual = getDcElementValue(simulationResult, check.element, "v");
      } else {
        throw new Error("dcVoltage には node または element が必要です。");
      }

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "V",
        label: "電圧",
      });
    },
  });

  /**
   * 部品電流をチェックします。
   * 既定では絶対値で比較します。
   */
  registerCheckHandler("dcCurrent", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.element) {
        throw new Error("dcCurrent には element が必要です。");
      }

      let actual = getDcElementValue(
        simulationResult,
        check.element,
        "i"
      );

      let expected = check.expected;

      if (check.signed !== true) {
        if (Number.isFinite(actual)) {
          actual = Math.abs(actual);
        }

        if (Number.isFinite(expected)) {
          expected = Math.abs(expected);
        }
      }

      return compareNumeric({
        expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "A",
        label: "電流",
      });
    },
  });

  /**
   * 部品電力をチェックします。
   * 既定では絶対値で比較します。
   */
  registerCheckHandler("dcPower", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.element) {
        throw new Error("dcPower には element が必要です。");
      }

      let actual = getDcElementValue(
        simulationResult,
        check.element,
        "p"
      );

      let expected = check.expected;

      if (check.signed !== true) {
        if (Number.isFinite(actual)) {
          actual = Math.abs(actual);
        }

        if (Number.isFinite(expected)) {
          expected = Math.abs(expected);
        }
      }

      return compareNumeric({
        expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "W",
        label: "電力",
      });
    },
  });

  /**
   * 部品パラメータ値をチェックします。
   * シミュレーションなしで判定できます。
   */
  registerCheckHandler("componentValue", {
    requiresSimulation: false,
    run: ({ check, circuit }) => {
      if (!check.element) {
        throw new Error("componentValue には element が必要です。");
      }

      const component = findCircuitComponent(circuit, check.element);

      if (!component) {
        return {
          ok: false,
          message: `部品 ${check.element} が見つかりません。`,
          expected: check.expected,
          actual: null,
        };
      }

      const paramKey = check.param ?? inferValueParamKey(component);

      const rawActual = component.params?.[paramKey];
      const actual = coerceComponentParamValue(rawActual);

      const unitMap = {
        R: "Ω",
        C: "F",
        L: "H",
        V: "V",
        I: "A",
      };

      const inferredUnit =
        unitMap[String(component.type ?? "").toUpperCase()] ?? "";

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? inferredUnit,
        label: `${component.type} の値`,
      });
    },
  });

  /**
   * 部品の接続ネットをチェックします。
   * シミュレーションなしで判定できます。
   *
   * 形式は2通り:
   * 1. ピン指定（極性・向きを判定する）:
   *    { "type":"connection", "element":"D1", "pins": { "anode":"vin", "cathode":"out" } }
   *    ピン名は components.json の pinNames（D: anode/cathode, Q_NPN: collector/base/emitter,
   *    M_N: drain/gate/source, OPAMP: in_plus/in_minus/out/v_plus/v_minus など）。
   *    略記 A/K（ダイオード）, C/B/E（BJT）, D/G/S（FET）, +/-（電源の p/n）も使える。
   *    指定したピンだけを判定する（指定しないピンは自由）。
   * 2. ネット集合（向きを見ない。R/C/L など無極性2端子向け・後方互換）:
   *    { "type":"connection", "element":"R1", "nets": ["vin","out"] }
   *    部品のどこかのピンが各ネットにつながっていれば合格。
   *
   * 共通オプション: componentType（文字列または配列）… 部品種別も一致を要求する。
   */
  registerCheckHandler("connection", {
    requiresSimulation: false,
    run: ({ check, circuit }) => {
      if (!check.element) {
        throw new Error("connection には element が必要です。");
      }

      const expectedSpec = check.pins ?? check.nets ?? null;
      const component = findCircuitComponent(circuit, check.element);

      if (!component) {
        return {
          ok: false,
          message: `部品 ${check.element} が見つかりません（配置されていません）。`,
          expected: expectedSpec,
          actual: null,
        };
      }

      if (check.componentType !== undefined) {
        const allowed = Array.isArray(check.componentType)
          ? check.componentType
          : [check.componentType];
        if (!allowed.includes(component.type)) {
          return {
            ok: false,
            message: `部品 ${check.element} の種類が違います。期待: ${allowed.join(" / ")}, 実際: ${component.type}`,
            expected: expectedSpec,
            actual: component.type,
          };
        }
      }

      const connectedNets = Array.isArray(component.connect)
        ? component.connect
        : [];

      if (check.pins && typeof check.pins === "object") {
        const pinNames = getPinNamesForType(component.type);
        if (!pinNames) {
          throw new Error(
            `部品種別 ${component.type} のピン名が分かりません（部品カタログが未読込）。`
          );
        }

        const actualByPin = {};
        const wrong = [];
        for (const [pinKey, expectedNet] of Object.entries(check.pins)) {
          const pinIndex = resolvePinIndex(pinNames, pinKey);
          if (pinIndex < 0) {
            throw new Error(
              `部品 ${component.type} にピン ${pinKey} はありません（ピン: ${pinNames.join(", ")}）。`
            );
          }
          const pinName = pinNames[pinIndex];
          const actualNet = normalizeNetName(connectedNets[pinIndex]);
          actualByPin[pinName] = actualNet || null;
          if (!netEquals(actualNet, expectedNet)) {
            wrong.push(
              `${pinName} が ${actualNet || "未接続"}（期待: ${expectedNet}）`
            );
          }
        }

        const ok = wrong.length === 0;
        return {
          ok,
          expected: check.pins,
          actual: actualByPin,
          message: ok
            ? `部品 ${check.element} は正しい向きで接続されています。`
            : `部品 ${check.element} の接続が違います: ${wrong.join("、")}`,
        };
      }

      const requiredNets = Array.isArray(check.nets) ? check.nets : [];
      if (requiredNets.length === 0) {
        throw new Error("connection には pins または nets が必要です。");
      }

      const missingNets = requiredNets.filter(
        (net) => !connectedNets.some((c) => netEquals(c, net))
      );

      const ok = missingNets.length === 0;

      return {
        ok,
        expected: requiredNets,
        actual: connectedNets,
        message: ok
          ? `部品 ${check.element} の接続は条件を満たしています。`
          : `部品 ${check.element} に未接続ネットがあります: ${missingNets.join(", ")}`,
      };
    },
  });

  /**
   * デジタル真理値表をチェックします。
   */
  /*
   * truthTable（judge: digital）
   * 入力ネット（inputs）の全組み合わせを判定が自動で与え、出力ネット（outputs）の論理値を比べる。
   * 期待値は table（[入力..., 出力...] の行。書いた行だけ判定）または expect（{出力: "0110"}）。
   * 出力の "x" は don't care。詳細と理想化の前提は src/sim/digital.js と docs/check_reference.md。
   */
  registerCheckHandler("truthTable", {
    requiresSimulation: true,
    run: ({ check, circuit }) => {
      const r = evaluateTruthTable(circuit, check);
      if (!r.ok) {
        return { ok: false, expected: check.table ?? check.expect ?? null, actual: null, message: r.problems.slice(0, 3).join(" / ") || "真理値表を作れませんでした。" };
      }
      const { map, errors } = buildExpectedTruthMap(check, r.inputs, r.outputs);
      if (errors.length > 0) {
        return { ok: false, expected: null, actual: null, message: `判定データの誤り: ${errors.slice(0, 2).join(" / ")}` };
      }
      const actual = r.rows.map((row) => [...row.in, ...row.out.map((v) => (v === 0 || v === 1 ? v : "x"))]);
      const mismatches = [];
      for (const row of r.rows) {
        const exp = map.get(row.in.join(""));
        if (!exp) continue;
        const bad = [];
        exp.forEach((e, j) => {
          if (e === null) return;
          if (row.out[j] !== e) bad.push(`${r.outputs[j]}=${logicToChar(row.out[j])}（正しくは ${e}）`);
        });
        if (bad.length) {
          const cond = r.inputs.map((n, j) => `${n}=${row.in[j]}`).join(", ");
          mismatches.push(`${cond} のとき ${bad.join(", ")}`);
        }
      }
      const ok = mismatches.length === 0;
      return {
        ok,
        expected: check.table ?? check.expect,
        actual,
        message: ok
          ? `真理値表が一致しています（${map.size} 行）。`
          : `真理値表が一致しません（${mismatches.length} 行）: ${mismatches.slice(0, 3).join(" / ")}${mismatches.length > 3 ? " / …" : ""}`,
        details: { inputs: r.inputs, outputs: r.outputs, method: r.method, warnings: r.warnings },
      };
    },
  });

  /*
   * sequence（judge: digital）— 順序回路の出力系列
   * { "type":"sequence", "clock":"clk", "inputs":{"d":"0110"}, "outputs":{"q":"0110"}, "sampleAt":"afterRise" }
   * clock の立ち上がりごとに出力を記録して期待系列と比べる（clock 省略時は入力を与えるたびに記録）。
   * 系列は "0110" の文字列か [0,1,1,0]。出力の "x" は don't care。
   */
  registerCheckHandler("sequence", {
    requiresSimulation: true,
    run: ({ check, circuit }) => {
      const r = evaluateSequence(circuit, check);
      if (!r.ok) {
        return { ok: false, expected: check.outputs ?? null, actual: null, message: r.problems.slice(0, 3).join(" / ") || "系列を作れませんでした。" };
      }
      const unit = check.clock ? "クロック" : "ステップ";
      const bad = [];
      const actualStr = {};
      for (const net of r.outputs) {
        const exp = (toLogicSeries(check.outputs[net]) ?? []).map(parseExpectedLogic);
        const act = r.actual[net];
        actualStr[net] = act.map(logicToChar).join("");
        if (exp.some((v) => v === undefined)) {
          return { ok: false, expected: check.outputs, actual: actualStr, message: `判定データの誤り: outputs.${net} は 0/1/"x" の系列にしてください。` };
        }
        if (exp.length !== r.steps) {
          return { ok: false, expected: check.outputs, actual: actualStr, message: `判定データの誤り: outputs.${net} の長さ（${exp.length}）がステップ数（${r.steps}）と違います。` };
        }
        const k = exp.findIndex((e, i) => e !== null && act[i] !== e);
        if (k >= 0) {
          const expStr = exp.map((e) => (e === null ? "x" : String(e))).join("");
          bad.push(`${net}: ${unit} ${k + 1} 回目で ${logicToChar(act[k])}（正しくは ${exp[k]}）。出力系列 ${actualStr[net]}、正しい系列 ${expStr}`);
        }
      }
      const ok = bad.length === 0;
      return {
        ok,
        expected: check.outputs,
        actual: actualStr,
        message: ok ? `出力系列が一致しています（${r.steps} ${unit}）。` : bad.slice(0, 2).join(" / "),
        details: { warnings: r.warnings },
      };
    },
  });

  /*
   * componentCount（シミュレーション不要）— 指定種別の部品の個数（固定部品は数えない）
   * { "type":"componentCount", "types":["U_NAND"], "max":4 }
   * 「NAND 4個で XOR を作る」のような最小構成の課題や、「この部品を必ず使う」(min) に使う。
   */
  registerCheckHandler("componentCount", {
    requiresSimulation: false,
    run: ({ check, circuit, problem }) => {
      const types = Array.isArray(check.types) ? check.types : check.types ? [check.types] : [];
      const fixedIds = new Set((problem?.fixedComponents ?? []).map((c) => c?.id));
      const count = (circuit?.components ?? []).filter(
        (c) => c && !c.locked && !fixedIds.has(c.id) && (types.length === 0 || types.includes(c.type))
      ).length;
      const min = Number.isFinite(Number(check.min)) && check.min !== null ? Number(check.min) : -Infinity;
      const max = Number.isFinite(Number(check.max)) && check.max !== null ? Number(check.max) : Infinity;
      const label = types.length ? types.join(" / ") : "部品";
      const ok = count >= min && count <= max;
      const range = [Number.isFinite(min) ? `${min} 個以上` : "", Number.isFinite(max) ? `${max} 個以下` : ""].filter(Boolean).join("・");
      return {
        ok,
        expected: { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null },
        actual: count,
        message: ok ? `${label} は ${count} 個です（${range}）。` : `${label} を ${count} 個使っています（${range}にしてください）。`,
      };
    },
  });

  /**
   * 選択式チェック。
   * 回答は context.answers[check.key]（選択肢インデックス、0 始まりの整数）。
   * 例: { "type":"multipleChoice", "key":"q2", "answerIndex":1 }
   * 文字列 "1" が渡された場合も整数として扱う。
   * context.answers に key が無いときだけ、旧形式の context.answer を参照する。
   */
  registerCheckHandler("multipleChoice", {
    requiresSimulation: false,
    run: ({ check, context }) => {
      const answerKey = check.key ?? check.id ?? "";

      const raw = getAnswer(context, answerKey);

      const expected =
        check.answerIndex ?? check.expected ?? check.answer ?? null;

      if (raw === undefined || raw === null || raw === "") {
        return {
          ok: false,
          message: "未回答です（選択肢を選んでください）。",
          expected,
          actual: null,
        };
      }

      const actual =
        typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;

      const ok = actual === expected;

      return {
        ok,
        expected,
        actual,
        message: ok ? "正解です。" : "選んだ選択肢は正しくありません。",
      };
    },
  });

  /**
   * 数値回答チェック。
   * 回答は context.answers[check.key]（数値。UI が "12.5m" などの SI 接頭辞付き
   * 入力を数値へ変換して渡す。文字列が来た場合もここで変換する）。
   * 例: { "type":"numericAnswer", "key":"q1", "expected":0.0125, "tolerancePct":2, "unit":"A" }
   * toleranceAbs を指定すると絶対誤差（期待値 0 の問題で必須）。
   */
  registerCheckHandler("numericAnswer", {
    requiresSimulation: false,
    run: ({ check, context }) => {
      if (!check.key) {
        throw new Error("numericAnswer には key が必要です。");
      }
      if (!Number.isFinite(check.expected)) {
        throw new Error("numericAnswer には数値の expected が必要です。");
      }

      const raw = context?.answers?.[check.key];

      if (raw === undefined || raw === null || raw === "") {
        return {
          ok: false,
          message: "未回答です。",
          expected: check.expected,
          actual: null,
        };
      }

      const actual = coerceAnswerNumber(raw);
      if (!Number.isFinite(actual)) {
        return {
          ok: false,
          message: `回答「${String(raw)}」を数値として読めません。`,
          expected: check.expected,
          actual: null,
        };
      }

      const res = compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "",
        label: check.label ?? "回答",
      });
      // 不正解のときに期待値を表示すると答えが分かってしまうので伏せる
      res.message = res.ok
        ? `正解です（回答: ${formatValue(actual, check.unit ?? "")}）。`
        : `回答 ${formatValue(actual, check.unit ?? "")} は正しくありません。`;
      return res;
    },
  });

  /**
   * 時定数（τ）をチェックします。
   *
   * 3通りの求め方（problem-writer は用途で選ぶ）:
   * - node 指定（推奨）: 過渡波形のステップ応答から 63.2% 法で測る。
   *     { "type":"timeConstant", "node":"out", "expected":0.001, "tolerancePct":3 }
   *     fromSec（ステップの時刻、既定 0）と toSec（最終値とみなす時刻、既定 解析終了時刻）
   *     を指定できる。toSec − fromSec は 7τ 以上にすること。
   *     ノードがステップ応答しない（電源がつながっていない等）と不合格になる。
   * - element 指定: その C/L から見たテブナン抵抗 R_th で τ = R_th·C または L/R_th。
   * - どちらも無し: 回路に C か L が「1個だけ」のとき、その τ（R_th 法）。2個以上ならエラー。
   *
   * R_th は「独立電圧源を短絡・独立電流源を開放」して求める（線形素子 R/SW のみ）。
   */
  registerCheckHandler("timeConstant", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const tr = simulationResult?.transient ?? {};
      let actual = null;
      let how = "";

      if (check.node) {
        const values = tr.nodes?.[check.node];
        if (!Array.isArray(values)) {
          return nodeMissingResult(simulationResult, check.node, check.expected);
        }
        const m = measureTimeConstant(
          tr.time,
          values,
          Number.isFinite(check.fromSec) ? check.fromSec : 0,
          Number.isFinite(check.toSec) ? check.toSec : undefined
        );
        if (!Number.isFinite(m.tau)) {
          return {
            ok: false,
            message: `ノード ${check.node} の波形から時定数を測れませんでした（${m.reason ?? "不明"}）。`,
            expected: check.expected,
            actual: null,
          };
        }
        actual = m.tau;
        how = `ノード ${check.node} の波形から測定した`;
      } else if (check.element) {
        actual = tr.timeConstants?.[check.element] ?? null;
        how = `${check.element} の`;
        if (!Number.isFinite(actual)) {
          return {
            ok: false,
            message: `${check.element} の時定数を求められませんでした（${check.element} が C/L として配置・接続されているか確認してください）。`,
            expected: check.expected,
            actual: null,
          };
        }
      } else {
        actual = tr.timeConstant;
        if (!Number.isFinite(actual)) {
          return {
            ok: false,
            message:
              tr.timeConstantNote ??
              "時定数を取得できませんでした（回路に R と C または L が揃っているか確認してください）。",
            expected: check.expected,
            actual: null,
          };
        }
      }

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "s",
        label: `${how}時定数`,
      });
    },
  });

  /**
   * 指定時刻の過渡値をチェックします（線形補間）。
   * - node 指定: ノード電圧（gnd 基準）
   * - element 指定: 部品の値。quantity: "v"（既定, 端子1→端子2 の電圧）または "i"（電流）
   *   例: { "type":"transientPoint", "element":"L1", "quantity":"i", "timeSec":0.001, "expected":0.0063 }
   */
  registerCheckHandler("transientPoint", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.node && !check.element) {
        throw new Error("transientPoint には node または element が必要です。");
      }
      if (!Number.isFinite(check.timeSec)) {
        throw new Error("transientPoint には timeSec が必要です。");
      }

      let actual;
      let label;
      let unit;
      if (check.node) {
        actual = getTransientNodeAtTime(simulationResult, check.node, check.timeSec);
        if (!Number.isFinite(actual)) {
          return nodeMissingResult(simulationResult, check.node, check.expected);
        }
        label = `t=${check.timeSec}s でのノード ${check.node} 電圧`;
        unit = check.unit ?? "V";
      } else {
        const q = check.quantity === "i" ? "i" : "v";
        const arr = simulationResult?.transient?.elements?.[check.element]?.[q];
        actual = Array.isArray(arr)
          ? interpolateAt(simulationResult.transient.time, arr, check.timeSec)
          : null;
        label = `t=${check.timeSec}s での ${check.element} の${q === "i" ? "電流" : "電圧"}`;
        unit = check.unit ?? (q === "i" ? "A" : "V");
        if (Number.isFinite(actual) && check.signed !== true && q === "i") {
          actual = Math.abs(actual);
        }
      }

      if (!Number.isFinite(actual)) {
        return {
          ok: false,
          message: `${check.node ? `ノード ${check.node}` : check.element} の過渡応答を取得できませんでした。`,
          expected: check.expected,
          actual: null,
        };
      }

      const expected =
        check.element && check.quantity === "i" && check.signed !== true
          ? Math.abs(check.expected)
          : check.expected;

      return compareNumeric({
        expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit,
        label,
      });
    },
  });

  /**
   * 指定周波数でのACノード電圧（実効値）をチェックします。
   * V_AC の Vpk はピーク値。ここで比べるのは実効値（= ピーク/√2）。
   * frequencyHz は電源の周波数と違ってもよい（AC 解析は線形なので、
   * 電源振幅のまま指定周波数でも解く）。
   */
  registerCheckHandler("acVoltage", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.node) {
        throw new Error("acVoltage には node が必要です。");
      }

      const freq =
        check.frequencyHz ?? simulationResult?.ac?.primaryFrequency;
      if (!Number.isFinite(freq)) {
        throw new Error("acVoltage には frequencyHz が必要です。");
      }

      const expected = check.expectedRMS ?? check.expected;
      // nodeRef: 差動電圧 V(node) − V(nodeRef)。sources: 電源を置き換えた解析（差動/同相入力の切替）
      const z = acPhasor(simulationResult, check.node, check.nodeRef, freq, check.sources);
      if (z.error) return { ok: false, message: z.error, expected, actual: null };
      const actual = Math.hypot(z.re, z.im) / Math.SQRT2;

      return compareNumeric({
        expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "Vrms",
        label: `${freq}Hz でのノード ${diffLabel(check.node, check.nodeRef)} 電圧（RMS）`,
      });
    },
  });

  /**
   * 指定周波数でのACゲイン（dB）をチェックします。
   * gain_dB = 20·log10( |V(output)| / |V(input)| )
   * input / output はノード名（gnd 基準の電圧）。既定は input="vin", output="out"。
   * 期待値が 0 付近（0dB など）なら toleranceAbs（dB）を指定すること。
   */
  registerCheckHandler("acGaindB", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const inputNode = check.input ?? "vin";
      const outputNode = check.output ?? "out";
      const freq =
        check.frequencyHz ?? simulationResult?.ac?.primaryFrequency;

      if (!Number.isFinite(freq)) {
        throw new Error("acGaindB には frequencyHz が必要です。");
      }

      // inputRef / outputRef: 差動入力 V(input)−V(inputRef)、差動出力 V(output)−V(outputRef)
      const zin = acPhasor(simulationResult, inputNode, check.inputRef, freq, check.sources);
      const zout = acPhasor(simulationResult, outputNode, check.outputRef, freq, check.sources);
      const why = zin.error ?? zout.error;
      if (why) return { ok: false, message: why, expected: check.expected, actual: null };
      const vin = Math.hypot(zin.re, zin.im);
      const vout = Math.hypot(zout.re, zout.im);

      if (!(vin > 0) || !(vout > 0)) {
        return {
          ok: false,
          message: `ACゲインを計算できませんでした（${freq}Hz, 入力 ${diffLabel(inputNode, check.inputRef)} = ${formatValue(vin / Math.SQRT2, "Vrms")} / 出力 ${diffLabel(outputNode, check.outputRef)} = ${formatValue(vout / Math.SQRT2, "Vrms")}）。`,
          expected: check.expected,
          actual: null,
        };
      }

      const gainDb = 20 * Math.log10(vout / vin);

      return compareNumeric({
        expected: check.expected,
        actual: gainDb,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "dB",
        label: `${freq}Hz での利得（${diffLabel(outputNode, check.outputRef)} / ${diffLabel(inputNode, check.inputRef)}）`,
      });
    },
  });

  /**
   * 指定周波数でのボード線図点（ゲインと位相）をチェックします。
   * gainDB と phaseDeg のうち指定されたものを判定します。
   * 位相 = ∠V(output) − ∠V(input) を (-180, 180] に正規化（度）。
   * 許容誤差: gainToleranceDB / phaseToleranceDeg（絶対値）を推奨。
   * 省略時は tolerancePct（相対）と toleranceAbs（絶対）の大きい方。
   */
  registerCheckHandler("bodePoint", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const inputNode = check.input ?? "vin";
      const outputNode = check.output ?? "out";
      const freq =
        check.frequencyHz ?? simulationResult?.ac?.primaryFrequency;

      if (!Number.isFinite(freq)) {
        throw new Error("bodePoint には frequencyHz が必要です。");
      }

      // inputRef / outputRef: 差動入力・差動出力。sources: 電源を置き換えた解析
      const zin = acPhasor(simulationResult, inputNode, check.inputRef, freq, check.sources);
      const zout = acPhasor(simulationResult, outputNode, check.outputRef, freq, check.sources);
      const why = zin.error ?? zout.error;
      if (why || !(Math.hypot(zin.re, zin.im) > 0) || !(Math.hypot(zout.re, zout.im) > 0)) {
        return {
          ok: false,
          message:
            why ??
            `ボード線図点を取得できませんでした（${freq}Hz, 入力 ${diffLabel(inputNode, check.inputRef)} / 出力 ${diffLabel(outputNode, check.outputRef)} の振幅が 0）。`,
          expected: { gainDB: check.gainDB, phaseDeg: check.phaseDeg },
          actual: null,
        };
      }

      const gainDb = 20 * Math.log10(Math.hypot(zout.re, zout.im) / Math.hypot(zin.re, zin.im));
      const phaseDeg = phaseDiffDeg(
        (Math.atan2(zout.im, zout.re) * 180) / Math.PI,
        (Math.atan2(zin.im, zin.re) * 180) / Math.PI
      );

      const relPct = Number.isFinite(check.tolerancePct)
        ? Math.abs(check.tolerancePct)
        : CONFIG.checks.defaultTolerancePct;
      const absTol = Number.isFinite(check.toleranceAbs)
        ? Math.abs(check.toleranceAbs)
        : 0;

      let gainOk = true;
      if (Number.isFinite(check.gainDB)) {
        gainOk = Number.isFinite(check.gainToleranceDB)
          ? Math.abs(gainDb - check.gainDB) <= Math.abs(check.gainToleranceDB)
          : isWithinTolerance(check.gainDB, gainDb, relPct, Math.max(absTol, 1e-12));
      }

      let phaseOk = true;
      if (Number.isFinite(check.phaseDeg)) {
        const dPhase = Math.abs(phaseDiffDeg(phaseDeg, check.phaseDeg));
        const tol = Number.isFinite(check.phaseToleranceDeg)
          ? Math.abs(check.phaseToleranceDeg)
          : Math.max(absTol, (Math.abs(check.phaseDeg) * relPct) / 100, 1e-12);
        phaseOk = dPhase <= tol;
      }

      const ok = gainOk && phaseOk;
      const parts = [];
      if (Number.isFinite(check.gainDB)) {
        parts.push(
          `利得 期待: ${formatValue(check.gainDB, "dB")} / 実際: ${formatValue(gainDb, "dB")}`
        );
      }
      if (Number.isFinite(check.phaseDeg)) {
        parts.push(
          `位相 期待: ${check.phaseDeg.toFixed(1)}° / 実際: ${phaseDeg.toFixed(1)}°`
        );
      }

      return {
        ok,
        message: ok
          ? `${freq}Hz のボード線図点は許容範囲内です。${parts.join(", ")}`
          : `${freq}Hz のボード線図点が期待値と異なります。${parts.join(", ")}`,
        expected: { gainDB: check.gainDB, phaseDeg: check.phaseDeg },
        actual: { gainDB: gainDb, phaseDeg },
        tolerancePct: check.tolerancePct ?? null,
      };
    },
  });

  /**
   * 減衰振動の周波数を、過渡波形の零交差間隔から測ってチェックします。
   * node を指定するとそのノードの波形、省略時は最も振れ幅の大きいノード。
   * fromSec 以降の波形を使う（既定 0）。
   * （以前は回路定数からの理論値を優先していたが、直列/並列 RLC を区別できず
   *   誤った値になる場合があったため、波形からの測定に統一した。）
   */
  registerCheckHandler("oscillationFrequency", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const tr = simulationResult?.transient ?? {};
      let actual = null;
      if (check.node) {
        const values = tr.nodes?.[check.node];
        if (!Array.isArray(values)) {
          return nodeMissingResult(simulationResult, check.node, check.expected);
        }
        actual = estimateOscillationFrequency(tr.time, values, check.fromSec ?? 0);
      } else {
        actual = tr.waveformFrequencyHz;
      }

      if (!Number.isFinite(actual)) {
        return {
          ok: false,
          message:
            "振動周波数を取得できませんでした（減衰振動になっているか確認してください）。",
          expected: check.expected,
          actual: null,
        };
      }

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? "Hz",
        label: "振動周波数",
      });
    },
  });

  /**
   * 小信号インピーダンス（judge: ac）。
   * { "type":"acImpedance", "node":"base", "exclude":["V1"], "frequencyHz":1000, "expected":2400, "tolerancePct":3 }
   * 独立電源をすべて 0（電圧源は短絡、電流源は開放）にし、exclude の部品を取り除いて、
   * node−nodeRef（既定 gnd）間に試験電流を流したときの |V/I|（Ω）。非線形素子は元の回路の
   * DC 動作点で線形化する。入力インピーダンスは信号源を exclude、出力インピーダンスは負荷を exclude する。
   * quantity: "magnitude"（既定）/ "real" / "imag" / "phase"（度）。
   */
  registerCheckHandler("acImpedance", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.node) throw new Error("acImpedance には node が必要です。");
      const freq = check.frequencyHz ?? simulationResult?.ac?.primaryFrequency;
      if (!Number.isFinite(freq)) throw new Error("acImpedance には frequencyHz が必要です。");
      const entry = simulationResult?.ac?.impedances?.[acImpedanceKey(check)];
      const z = entry?.[freq] ?? entry?.[String(freq)] ?? null;
      if (!z) {
        return {
          ok: false,
          message:
            describeNodeProblem(simulationResult, check.node) ??
            `ノード ${diffLabel(check.node, check.nodeRef)} のインピーダンスを求められませんでした（ノードが回路にあるか確認してください）。`,
          expected: check.expected,
          actual: null,
        };
      }
      const q = check.quantity ?? "magnitude";
      const actual = q === "real" ? z.re : q === "imag" ? z.im : q === "phase" ? z.phaseDeg : z.magnitude;
      if (Math.abs(z.magnitude) > 1e11 && q === "magnitude") {
        return {
          ok: false,
          message: `ノード ${diffLabel(check.node, check.nodeRef)} から見た回路がつながっていません（インピーダンスが無限大）。`,
          expected: check.expected,
          actual: Infinity,
        };
      }
      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: check.unit ?? (q === "phase" ? "°" : "Ω"),
        label: `${freq}Hz でノード ${diffLabel(check.node, check.nodeRef)} から見たインピーダンス${q === "magnitude" ? "" : `（${q}）`}`,
      });
    },
  });

  /**
   * 非線形素子の DC 動作領域（judge に dc または ac を含む問題）。
   * { "type":"operatingRegion", "match":{"type":"Q_NPN"}, "region":"active" }
   * region は文字列または配列（どれかに一致すれば合格）。
   *  BJT: off / active / saturation、MOSFET: off / triode / saturation（K=0 のスイッチは on / off）、
   *  JFET: saturation / off、D 系: on / off、ZD/TVS: forward / breakdown / off、
   *  OPAMP: linear / satHigh / satLow。
   */
  registerCheckHandler("operatingRegion", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.element) throw new Error("operatingRegion には element または match が必要です。");
      const want = Array.isArray(check.region) ? check.region : [check.region];
      const op =
        simulationResult?.dc?.operatingPoints?.[check.element] ??
        simulationResult?.ac?.operatingPoints?.[check.element] ??
        null;
      if (!op) {
        return {
          ok: false,
          message: `${check.element} の動作点がありません（非線形素子として回路に置かれているか、judge に dc または ac があるか確認してください）。`,
          expected: want,
          actual: null,
        };
      }
      const label = (r) => {
        if (op.kind === "bjt" && r === "saturation") return "飽和（スイッチ ON の状態）";
        if (op.kind === "mos" && r === "saturation") return "飽和領域（増幅に使う領域）";
        return REGION_LABEL[r] ?? r;
      };
      const ok = want.includes(op.region);
      const extra =
        op.kind === "bjt"
          ? `（IC = ${formatValue(op.ic, "A")}, VCE = ${formatValue(op.vce, "V")}）`
          : op.kind === "mos"
            ? `（VGS = ${formatValue(op.vgs, "V")}, VDS = ${formatValue(op.vds, "V")}）`
            : op.kind === "opamp"
              ? `（出力 ${formatValue(op.vout, "V")}）`
              : "";
      return {
        ok,
        expected: want,
        actual: op.region,
        message: ok
          ? `${check.element} は ${label(op.region)} で動作しています${extra}。`
          : `${check.element} の動作領域が違います。期待: ${want.map(label).join(" / ")}、実際: ${label(op.region)}${extra}`,
      };
    },
  });

  /**
   * 過渡波形の統計量（judge: transient）。
   * { "type":"transientMeasure", "node":"out", "measure":"pp", "fromSec":0.005, "toSec":0.01, "expected":2.0 }
   * measure: "max" / "min" / "pp"（最大−最小）/ "average"（時間平均）/ "rms"（実効値）/ "acRms"（平均を除いた実効値）/
   *   "duty"（threshold を超えている時間の割合 0〜1。threshold 省略時は区間の (最大+最小)/2）/
   *   "power"（element の平均電力 = v·i の時間平均。既定は絶対値、signed: true で「吸収が正」）/
   *   "powerFactor"（element の力率 = |平均電力| / (電圧の実効値 × 電流の実効値)）。
   * 区間 [fromSec, toSec]（既定 0〜解析終了）。node（nodeRef で差動）または element + quantity（"v" / "i"）。
   * 起動直後の過渡を除くため、定常の判定では fromSec を必ず指定すること。
   */
  registerCheckHandler("transientMeasure", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const tr = simulationResult?.transient ?? {};
      const measure = check.measure;
      if (!TRANSIENT_MEASURE_NAMES[measure]) {
        throw new Error(`transientMeasure の measure が不正です: ${measure}`);
      }
      const range = `${check.fromSec ?? 0}〜${check.toSec ?? "終了"}s`;
      // 電力・力率（element の v と i の積から計算）
      if (measure === "power" || measure === "powerFactor") {
        if (!check.element) throw new Error(`transientMeasure の ${measure} には element（または match）が必要です。`);
        const el = tr.elements?.[check.element];
        if (!Array.isArray(el?.v) || !Array.isArray(el?.i)) {
          return { ok: false, message: `${check.element} の過渡波形がありません。`, expected: check.expected, actual: null };
        }
        const p = elementPower(tr.time, el, check.fromSec, check.toSec);
        let actual;
        let expected = check.expected;
        if (measure === "power") {
          actual = check.signed === true ? p.avg : Math.abs(p.avg);
          if (check.signed !== true) expected = Math.abs(expected);
        } else {
          actual = p.vrms > 0 && p.irms > 0 ? Math.abs(p.avg) / (p.vrms * p.irms) : NaN;
        }
        if (!Number.isFinite(actual)) {
          return { ok: false, message: `${check.element} の${TRANSIENT_MEASURE_NAMES[measure]}を計算できませんでした（電流が流れていないか、区間 fromSec〜toSec が不正です）。`, expected, actual: null };
        }
        return compareNumeric({
          expected,
          actual,
          tolerancePct: check.tolerancePct,
          toleranceAbs: check.toleranceAbs,
          unit: check.unit ?? (measure === "power" ? "W" : ""),
          label: `${check.element} の${TRANSIENT_MEASURE_NAMES[measure]}（${range}）`,
        });
      }
      let values;
      let what;
      let unit;
      if (check.node) {
        const a = tr.nodes?.[check.node];
        if (!Array.isArray(a)) return nodeMissingResult(simulationResult, check.node, check.expected);
        values = a;
        if (check.nodeRef && check.nodeRef !== "gnd" && check.nodeRef !== "0") {
          const r = tr.nodes?.[check.nodeRef];
          if (!Array.isArray(r)) return nodeMissingResult(simulationResult, check.nodeRef, check.expected);
          values = a.map((v, i) => v - r[i]);
        }
        what = `ノード ${diffLabel(check.node, check.nodeRef)} の電圧`;
        unit = check.unit ?? "V";
      } else if (check.element) {
        const q = check.quantity === "i" ? "i" : "v";
        const a = tr.elements?.[check.element]?.[q];
        if (!Array.isArray(a)) {
          return { ok: false, message: `${check.element} の過渡波形がありません。`, expected: check.expected, actual: null };
        }
        // 電流は既定で向きを問わない: max/min は |i| の最大/最小、average は |平均|。
        // signed: true なら符号つき（正の向きは connect[0]→connect[1]、ダイオードは順方向が正）
        values = q === "i" && check.signed !== true && (measure === "max" || measure === "min")
          ? a.map((v) => Math.abs(v))
          : a;
        what = `${check.element} の${q === "i" ? "電流" : "電圧"}`;
        unit = check.unit ?? (q === "i" ? "A" : "V");
      } else {
        throw new Error("transientMeasure には node または element が必要です。");
      }
      if (measure === "duty") unit = check.unit ?? "";
      let actual = measureWaveform(tr.time, values, measure, check.fromSec, check.toSec, { threshold: check.threshold });
      let expected = check.expected;
      if (check.element && check.quantity === "i" && check.signed !== true && measure === "average") {
        actual = Math.abs(actual);
        expected = Math.abs(expected);
      }
      if (!Number.isFinite(actual)) {
        return { ok: false, message: `${what} の ${measure} を計算できませんでした（区間 fromSec〜toSec を確認してください）。`, expected, actual: null };
      }
      const th = measure === "duty" && Number.isFinite(check.threshold) ? `、しきい値 ${formatValue(check.threshold, "V")}` : "";
      return compareNumeric({
        expected,
        actual,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit,
        label: `${what}の${TRANSIENT_MEASURE_NAMES[measure]}（${range}${th}）`,
      });
    },
  });

  /**
   * 効率（judge: transient）。
   * { "type":"efficiency", "inputs":["V1"], "outputs":["RL"], "fromSec":0.004, "toSec":0.005, "expected":0.9, "toleranceAbs":0.02 }
   * η = Σ|出力側の部品の平均電力| / Σ|入力側の部品の平均電力|（各部品の v·i の時間平均の絶対値）。
   * inputs / outputs は部品 ID（固定部品を推奨）または match オブジェクト（該当する部品すべての和）。
   */
  registerCheckHandler("efficiency", {
    requiresSimulation: true,
    run: ({ check, simulationResult, circuit }) => {
      const tr = simulationResult?.transient ?? {};
      const resolve = (list, label) => {
        if (!Array.isArray(list) || list.length === 0) throw new Error(`efficiency の ${label} が空です。`);
        const ids = [];
        for (const entry of list) {
          if (typeof entry === "string") ids.push(entry);
          else if (entry && typeof entry === "object") {
            const found = findMatchingComponents(circuit, entry);
            if (found.length === 0) return { error: `条件に合う部品がありません（${describeMatch(entry)}）。` };
            ids.push(...found.map((c) => c.id));
          }
        }
        return { ids };
      };
      const sumPower = (ids) => {
        let total = 0;
        for (const id of ids) {
          const el = tr.elements?.[id];
          if (!Array.isArray(el?.v) || !Array.isArray(el?.i)) return { error: `${id} の過渡波形がありません（回路に置かれているか確認してください）。` };
          const p = elementPower(tr.time, el, check.fromSec, check.toSec).avg;
          if (!Number.isFinite(p)) return { error: `${id} の平均電力を計算できませんでした（区間 fromSec〜toSec を確認してください）。` };
          total += Math.abs(p);
        }
        return { total };
      };
      const ins = resolve(check.inputs, "inputs");
      const outs = resolve(check.outputs, "outputs");
      const err = ins.error ?? outs.error;
      if (err) return { ok: false, message: err, expected: check.expected, actual: null };
      const pin = sumPower(ins.ids);
      const pout = sumPower(outs.ids);
      const err2 = pin.error ?? pout.error;
      if (err2) return { ok: false, message: err2, expected: check.expected, actual: null };
      if (!(pin.total > 0)) {
        return { ok: false, message: `入力電力が 0 です（${ins.ids.join(", ")} から電力が供給されていません）。`, expected: check.expected, actual: null };
      }
      const eta = pout.total / pin.total;
      const r = compareNumeric({
        expected: check.expected,
        actual: eta,
        tolerancePct: check.tolerancePct,
        toleranceAbs: check.toleranceAbs,
        unit: "",
        label: `効率 η = 出力 ${formatValue(pout.total, "W")} / 入力 ${formatValue(pin.total, "W")}`,
      });
      return { ...r, details: { pin: pin.total, pout: pout.total } };
    },
  });
}

/**
 * 既定ハンドラを初期登録します。
 */
registerDefaultCheckHandlers();

/* ==========================================================================
   チェック実行
   ========================================================================== */

/**
 * 1件のチェックを実行します。
 *
 * @param {object} check
 * @param {object} payload
 * @returns {Promise<object>}
 */
export async function runSingleCheck(check, payload) {
  const {
    index = 0,
    problem = null,
    simulationResult = null,
    circuit = null,
    context = {},
  } = payload;

  const type = normalizeCheckType(check?.type);

  if (!type) {
    return createCheckResult({
      index,
      type: "unknown",
      ok: false,
      message: "チェック種別が定義されていません。",
    });
  }

  const handler = checkHandlers.get(type);

  if (!handler) {
    return createCheckResult({
      index,
      type,
      ok: false,
      message: `未登録のチェック種別です: ${type}`,
      expected: check?.expected ?? null,
      actual: null,
    });
  }

  if (
    handler.requiresSimulation &&
    (!simulationResult || simulationResult.ok === false)
  ) {
    return createCheckResult({
      index,
      type,
      ok: false,
      message:
        "シミュレーション結果が利用できないため、このチェックは判定できません。",
      expected: check?.expected ?? null,
      actual: null,
    });
  }

  try {
    // element の代わりに match（種別と接続ネットで部品を特定）が書かれている場合
    if (check?.match && !check.element) {
      const candidates = findMatchingComponents(circuit, check.match);
      if (candidates.length === 0) {
        return createCheckResult({
          index,
          type,
          ok: false,
          message: `条件に合う部品がありません（${describeMatch(check.match)}）。`,
          expected: check?.expected ?? null,
          actual: null,
        });
      }
      // 該当が複数ある場合は、どれか1つが合格すれば合格
      let first = null;
      for (const comp of candidates) {
        const raw = await handler.run({
          check: { ...check, element: comp.id },
          problem,
          simulationResult,
          circuit,
          context,
        });
        const res = normalizeHandlerResult(raw, check, index, type);
        res.details = { ...(res.details ?? {}), matchedElement: comp.id };
        if (res.ok) return res;
        first ??= res;
      }
      return first;
    }

    const rawResult = await handler.run({
      check,
      problem,
      simulationResult,
      circuit,
      context,
    });

    return normalizeHandlerResult(rawResult, check, index, type);
  } catch (error) {
    return createCheckResult({
      index,
      type,
      ok: false,
      message: `チェック実行中にエラーが発生しました: ${
        error?.message ?? String(error)
      }`,
      expected: check?.expected ?? null,
      actual: null,
    });
  }
}

/**
 * ハンドラ戻り値を統一チェック結果へ変換します。
 *
 * @param {unknown} rawResult
 * @param {object} check
 * @param {number} index
 * @param {string} type
 * @returns {object}
 */
function normalizeHandlerResult(rawResult, check, index, type) {
  if (typeof rawResult === "boolean") {
    return createCheckResult({
      index,
      type,
      ok: rawResult,
      message: rawResult ? "合格" : "不合格",
      expected: check?.expected ?? null,
      actual: null,
    });
  }

  if (!rawResult || typeof rawResult !== "object") {
    return createCheckResult({
      index,
      type,
      ok: false,
      message: "チェックハンドラの戻り値が不正です。",
      expected: check?.expected ?? null,
      actual: null,
    });
  }

  return createCheckResult({
    index,
    type,
    ok: rawResult.ok,
    message: rawResult.message ?? (rawResult.ok ? "合格" : "不合格"),
    expected: rawResult.expected ?? check?.expected ?? null,
    actual: rawResult.actual ?? null,
    tolerancePct: rawResult.tolerancePct ?? check?.tolerancePct ?? null,
    details: rawResult.details ?? null,
  });
}

/**
 * 問題の全チェックを実行します。
 *
 * @param {object} problem
 * @param {object} simulationResult
 * @param {object} circuit
 * @param {object} [context]
 * @returns {Promise<Array<object>>}
 */
export async function runChecks(
  problem,
  simulationResult,
  circuit,
  context = {}
) {
  const checks = Array.isArray(problem?.checks) ? problem.checks : [];

  const results = [];

  for (let index = 0; index < checks.length; index += 1) {
    const result = await runSingleCheck(checks[index], {
      index,
      problem,
      simulationResult,
      circuit,
      context,
    });

    results.push(result);
  }

  return results;
}

/**
 * チェック結果を集計します。
 *
 * @param {Array<object>} results
 * @returns {{total: number, passed: number, failed: number, ok: boolean}}
 */
export function summarizeCheckResults(results) {
  const total = Array.isArray(results) ? results.length : 0;
  const passed = Array.isArray(results)
    ? results.filter((result) => result.ok).length
    : 0;

  return {
    total,
    passed,
    failed: total - passed,
    ok: total > 0 && passed === total,
  };
}