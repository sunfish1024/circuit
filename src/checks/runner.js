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
    unit = "",
    label = "値",
  } = values;

  const ok = isWithinTolerance(
    expected,
    actual,
    tolerancePct,
    absoluteTolerance
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
      } else if (check.element) {
        actual = getDcElementValue(simulationResult, check.element, "v");
      } else {
        throw new Error("dcVoltage には node または element が必要です。");
      }

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
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
        unit: check.unit ?? inferredUnit,
        label: `${component.type} の値`,
      });
    },
  });

  /**
   * 部品の接続ネットをチェックします。
   * シミュレーションなしで判定できます。
   */
  registerCheckHandler("connection", {
    requiresSimulation: false,
    run: ({ check, circuit }) => {
      if (!check.element) {
        throw new Error("connection には element が必要です。");
      }

      const component = findCircuitComponent(circuit, check.element);

      if (!component) {
        return {
          ok: false,
          message: `部品 ${check.element} が見つかりません。`,
          expected: check.nets ?? null,
          actual: null,
        };
      }

      const connectedNets = Array.isArray(component.connect)
        ? component.connect
        : [];

      const requiredNets = Array.isArray(check.nets)
        ? check.nets
        : [];

      const missingNets = requiredNets.filter(
        (net) => !connectedNets.includes(net)
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
  registerCheckHandler("truthTable", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const expectedTable = normalizeTruthTable(check.table);

      const actualTable = normalizeTruthTable(
        simulationResult?.digital?.truthTable
      );

      const ok = isEqualTruthTable(expectedTable, actualTable);

      return {
        ok,
        expected: expectedTable,
        actual: actualTable,
        message: ok
          ? "真理値表が一致しています。"
          : "真理値表が一致していません。",
      };
    },
  });

  /**
   * 選択式チェック。
   * 選択値は context.answer、または context.answers[check.key] を参照します。
   */
  registerCheckHandler("multipleChoice", {
    requiresSimulation: false,
    run: ({ check, context }) => {
      const answerKey = check.key ?? check.id ?? "";

      const actual =
        context?.answer ??
        context?.answers?.[answerKey] ??
        context?.answers?.[check.type] ??
        undefined;

      const expected =
        check.answerIndex ?? check.expected ?? check.answer ?? null;

      if (actual === undefined) {
        return {
          ok: false,
          message: "解答が選択されていません。",
          expected,
          actual: null,
        };
      }

      const ok = actual === expected;

      return {
        ok,
        expected,
        actual,
        message: ok ? "正解です。" : "不正解です。",
      };
    },
  });

  /**
   * 回路の時定数（τ）をチェックします。
   * transient.timeConstant と比較します。
   */
  registerCheckHandler("timeConstant", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const actual = simulationResult?.transient?.timeConstant;

      if (!Number.isFinite(actual)) {
        return {
          ok: false,
          message:
            "時定数を取得できませんでした（回路に R と C または L が揃っているか確認してください）。",
          expected: check.expected,
          actual: null,
        };
      }

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        unit: check.unit ?? "s",
        label: "時定数",
      });
    },
  });

  /**
   * 指定時刻の過渡ノード電圧をチェックします。
   * 配列を線形補間して timeSec の値を取り出します。
   */
  registerCheckHandler("transientPoint", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      if (!check.node) {
        throw new Error("transientPoint には node が必要です。");
      }
      if (!Number.isFinite(check.timeSec)) {
        throw new Error("transientPoint には timeSec が必要です。");
      }

      const actual = getTransientNodeAtTime(
        simulationResult,
        check.node,
        check.timeSec
      );

      if (!Number.isFinite(actual)) {
        return {
          ok: false,
          message: `ノード ${check.node} の過渡応答を取得できませんでした。`,
          expected: check.expected,
          actual: null,
        };
      }

      return compareNumeric({
        expected: check.expected,
        actual,
        tolerancePct: check.tolerancePct,
        unit: check.unit ?? "V",
        label: `t=${check.timeSec}s でのノード ${check.node} 電圧`,
      });
    },
  });

  /**
   * 指定周波数でのACノード電圧（実効値）をチェックします。
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

      const nodeData = getAcNodeAtFreq(simulationResult, check.node, freq);
      const actual = nodeData?.rms ?? null;
      const expected = check.expectedRMS ?? check.expected;

      if (!Number.isFinite(actual)) {
        return {
          ok: false,
          message: `ノード ${check.node} のAC電圧を取得できませんでした（${freq}Hz）。`,
          expected,
          actual: null,
        };
      }

      return compareNumeric({
        expected,
        actual,
        tolerancePct: check.tolerancePct,
        unit: check.unit ?? "Vrms",
        label: `${freq}Hz でのノード ${check.node} 電圧（RMS）`,
      });
    },
  });

  /**
   * 指定周波数でのACゲイン（dB）をチェックします。
   * gain_dB = 20·log10( Vout_rms / Vin_rms )
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

      const inData = getAcNodeAtFreq(simulationResult, inputNode, freq);
      const outData = getAcNodeAtFreq(simulationResult, outputNode, freq);

      const vin = inData?.rms;
      const vout = outData?.rms;

      if (!Number.isFinite(vin) || !Number.isFinite(vout) || vin <= 0) {
        return {
          ok: false,
          message: `ACゲインを計算できませんでした（${freq}Hz）。`,
          expected: check.expected,
          actual: null,
        };
      }

      const gainDb = 20 * Math.log10(vout / vin);

      return compareNumeric({
        expected: check.expected,
        actual: gainDb,
        tolerancePct: check.tolerancePct,
        unit: check.unit ?? "dB",
        label: `${freq}Hz での利得`,
      });
    },
  });

  /**
   * 指定周波数でのボード線図点（ゲインと位相の両方）をチェックします。
   * gainDB と phaseDeg が両方指定されていれば両方判定します。
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

      const inData = getAcNodeAtFreq(simulationResult, inputNode, freq);
      const outData = getAcNodeAtFreq(simulationResult, outputNode, freq);

      if (
        !inData ||
        !outData ||
        !Number.isFinite(inData.rms) ||
        inData.rms <= 0
      ) {
        return {
          ok: false,
          message: `ボード線図点を取得できませんでした（${freq}Hz）。`,
          expected: { gainDB: check.gainDB, phaseDeg: check.phaseDeg },
          actual: null,
        };
      }

      const gainDb = 20 * Math.log10(outData.rms / inData.rms);
      const phaseDeg = phaseDiffDeg(outData.phaseDeg, inData.phaseDeg);

      const gainOk =
        !Number.isFinite(check.gainDB) ||
        isWithinTolerance(check.gainDB, gainDb, check.tolerancePct);
      const phaseOk =
        !Number.isFinite(check.phaseDeg) ||
        isWithinTolerance(check.phaseDeg, phaseDeg, check.tolerancePct);

      const ok = gainOk && phaseOk;
      const parts = [];
      if (Number.isFinite(check.gainDB)) {
        parts.push(
          `利得 期待: ${formatValue(check.gainDB, "dB")} / 実際: ${formatValue(gainDb, "dB")}`
        );
      }
      if (Number.isFinite(check.phaseDeg)) {
        parts.push(
          `位相 期待: ${formatValue(check.phaseDeg, "deg")} / 実際: ${formatValue(phaseDeg, "deg")}`
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
   * 減衰振動の周波数をチェックします。
   * 理論値（oscillationFrequencyHz）を優先し、無ければ波形推定値を使います。
   */
  registerCheckHandler("oscillationFrequency", {
    requiresSimulation: true,
    run: ({ check, simulationResult }) => {
      const theo = simulationResult?.transient?.oscillationFrequencyHz;
      const wave = simulationResult?.transient?.waveformFrequencyHz;
      const actual = Number.isFinite(theo) ? theo : wave;

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
        unit: check.unit ?? "Hz",
        label: "振動周波数",
      });
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