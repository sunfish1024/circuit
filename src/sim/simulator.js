/**
 * シミュレーション共通インターフェースです。
 *
 * 役割:
 * - シミュレーションモードの登録
 * - ボード状態の正規化
 * - シミュレーション実行
 * - 結果オブジェクトの整形
 * - エラー / 警告の収集
 *
 * 方針:
 * - このファイル自体は高度な回路解析を実装しない。
 * - 実際の解析は、今後の以下モジュールが担当する想定。
 *   - src/sim/dc.js
 *   - src/sim/ac.js
 *   - src/sim/transient.js
 *   - src/sim/digital.js
 *   - src/sim/rf.js
 * - それらは registerSimulationMode() で登録する。
 */

import { validateBoard } from "../core/validation.js";

/**
 * シミュレーションハンドラのレジストリ。
 *
 * @type {Map<string, Function>}
 */
const simulationHandlers = new Map();

/**
 * 現在時刻をミリ秒で取得します。
 *
 * @returns {number}
 */
function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

/**
 * シミュレーションモードを正規化します。
 *
 * @param {string} mode
 * @returns {string}
 */
export function normalizeSimulationMode(mode) {
  const normalized = String(mode ?? "dc").trim().toLowerCase();

  return normalized || "dc";
}

/**
 * 空のシミュレーション結果を作成します。
 *
 * @param {string} [mode="dc"]
 * @returns {object}
 */
export function createEmptySimulationResult(mode = "dc") {
  const normalizedMode = normalizeSimulationMode(mode);

  return {
    ok: false,
    mode: normalizedMode,

    errors: [],
    warnings: [],

    dc: {
      nodes: {},
      elements: {},
    },

    ac: {
      frequencies: [],
      nodes: {},
      elements: {},
    },

    transient: {
      time: [],
      nodes: {},
      elements: {},
    },

    digital: {
      truthTable: null,
      stateSequence: null,
      events: [],
    },

    rf: {
      frequencies: [],
      sParameters: {},
      vswr: {},
    },

    power: {
      inputPowerW: null,
      outputPowerW: null,
      efficiencyPct: null,
    },

    meta: {
      startedAt: null,
      durationMs: 0,
      mode: normalizedMode,
      handler: null,
    },
  };
}

/**
 * シミュレーション結果にエラーを追加します。
 *
 * @param {object} result
 * @param {string} message
 */
export function addSimulationError(result, message) {
  if (!result) {
    return;
  }

  result.ok = false;
  result.errors.push(message);
}

/**
 * シミュレーション結果に警告を追加します。
 *
 * @param {object} result
 * @param {string} message
 */
export function addSimulationWarning(result, message) {
  if (!result) {
    return;
  }

  result.warnings.push(message);
}

/**
 * シミュレーションモードを登録します。
 *
 * @param {string} mode 例: "dc", "ac", "transient", "digital", "rf"
 * @param {Function} handler
 *
 * handler の戻り値は、以下のような一部結果でよいです。
 *
 * {
 *   ok: true,
 *   dc: {
 *     nodes: { gnd: 0, vin: 12 },
 *     elements: { R1: { v: 12, i: 0.5, p: 6 } }
 *   }
 * }
 */
export function registerSimulationMode(mode, handler) {
  const normalizedMode = normalizeSimulationMode(mode);

  if (typeof handler !== "function") {
    throw new Error(
      `シミュレーションハンドラは関数である必要があります。mode=${normalizedMode}`
    );
  }

  simulationHandlers.set(normalizedMode, handler);
}

/**
 * シミュレーションモード登録を解除します。
 *
 * @param {string} mode
 */
export function unregisterSimulationMode(mode) {
  const normalizedMode = normalizeSimulationMode(mode);

  simulationHandlers.delete(normalizedMode);
}

/**
 * シミュレーションモードが登録済みかを返します。
 *
 * @param {string} mode
 * @returns {boolean}
 */
export function hasSimulationMode(mode) {
  const normalizedMode = normalizeSimulationMode(mode);

  return simulationHandlers.has(normalizedMode);
}

/**
 * 登録済みシミュレーションモード一覧を返します。
 *
 * @returns {Array<string>}
 */
export function getRegisteredSimulationModes() {
  return Array.from(simulationHandlers.keys());
}

/**
 * シミュレーション入力を受け取り、ボード状態へ正規化します。
 *
 * 想定入力:
 * - state.board そのもの
 * - state 全体
 * - { components, wires, nodes }
 *
 * @param {object} circuit
 * @returns {object}
 */
export function normalizeCircuit(circuit) {
  if (!circuit) {
    return {
      components: [],
      wires: [],
      nodes: [],
    };
  }

  if (circuit.board) {
    return circuit.board;
  }

  return circuit;
}

/**
 * ハンドラ結果をシミュレーション結果へ統合します。
 *
 * @param {object} result
 * @param {object} handlerResult
 */
function mergeHandlerResult(result, handlerResult) {
  if (!handlerResult || typeof handlerResult !== "object") {
    return;
  }

  if (Array.isArray(handlerResult.errors)) {
    result.errors.push(...handlerResult.errors);
  }

  if (Array.isArray(handlerResult.warnings)) {
    result.warnings.push(...handlerResult.warnings);
  }

  const sectionKeys = [
    "dc",
    "ac",
    "transient",
    "digital",
    "rf",
    "power",
  ];

  for (const key of sectionKeys) {
    if (handlerResult[key] === undefined) {
      continue;
    }

    if (
      typeof handlerResult[key] === "object" &&
      handlerResult[key] !== null &&
      !Array.isArray(handlerResult[key])
    ) {
      result[key] = {
        ...result[key],
        ...handlerResult[key],
      };
    } else {
      result[key] = handlerResult[key];
    }
  }

  if (handlerResult.meta && typeof handlerResult.meta === "object") {
    result.meta = {
      ...result.meta,
      ...handlerResult.meta,
    };
  }
}

/**
 * シミュレーション結果を確定します。
 *
 * @param {object} result
 * @param {boolean} handlerUsed
 * @param {number} startedAtMs
 * @param {boolean | undefined} handlerOk
 * @returns {object}
 */
function finalizeSimulationResult(result, handlerUsed, startedAtMs, handlerOk) {
  result.meta.durationMs = nowMs() - startedAtMs;

  if (result.errors.length > 0) {
    result.ok = false;
  } else if (!handlerUsed) {
    result.ok = false;
  } else {
    result.ok = handlerOk !== false;
  }

  return result;
}

/**
 * シミュレーションを実行します。
 *
 * @param {object} circuit 状態全体、または board オブジェクト
 * @param {object} [options]
 * @param {string} [options.mode="dc"]
 * @returns {Promise<object>}
 */
export async function simulate(circuit, options = {}) {
  const mode = normalizeSimulationMode(options.mode);
  const result = createEmptySimulationResult(mode);

  result.meta.startedAt = new Date().toISOString();

  const startedAtMs = nowMs();

  let handlerUsed = false;
  let handlerOk;

  try {
    const normalizedCircuit = normalizeCircuit(circuit);

    const validationResult = validateBoard(normalizedCircuit);

    if (!validationResult.ok) {
      result.errors.push(...validationResult.errors);
      return finalizeSimulationResult(result, false, startedAtMs, undefined);
    }

    const handler = simulationHandlers.get(mode);

    if (!handler) {
      result.warnings.push(
        `シミュレーションモード ${mode} はまだ実装されていません。`
      );

      return finalizeSimulationResult(result, false, startedAtMs, undefined);
    }

    handlerUsed = true;
    result.meta.handler = mode;

    const handlerResult = await handler(normalizedCircuit, options, result);

    if (
      handlerResult &&
      typeof handlerResult === "object" &&
      typeof handlerResult.ok === "boolean"
    ) {
      handlerOk = handlerResult.ok;
    }

    mergeHandlerResult(result, handlerResult);
  } catch (error) {
    result.errors.push(error?.message ?? String(error));
  }

  return finalizeSimulationResult(result, handlerUsed, startedAtMs, handlerOk);
}

/**
 * 複数のシミュレーションモードを順に実行します。
 *
 * @param {object} circuit
 * @param {Array<string>} modes
 * @param {object} [options]
 * @returns {Promise<Record<string, object>>}
 */
export async function simulateModes(circuit, modes = [], options = {}) {
  const results = {};

  for (const mode of modes) {
    results[normalizeSimulationMode(mode)] = await simulate(circuit, {
      ...options,
      mode,
    });
  }

  return results;
}

/**
 * 問題データからシミュレーションモードを推定して実行します。
 *
 * @param {object} problem
 * @param {object} circuit
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function simulateProblem(problem, circuit, options = {}) {
  const mode = problem?.judge ?? options.mode ?? "dc";

  return simulate(circuit, {
    ...options,
    mode,
  });
}