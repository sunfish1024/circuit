/**
 * デジタル論理シミュレーション（mode: "digital"）
 *
 * 役割:
 *  1. アナログ回路の真理値表抽出
 *     - 判定条件（truthTable チェック）の inputs / outputs を読み取る
 *     - 入力ネットごとに仮想電源（Low = driveLowV / High = driveHighV）を注入し、
 *       入力の全組み合わせについて DC 解析を繰り返す
 *     - 出力ネット電圧を論理しきい値（vih / vil）で 0 / 1 に量子化する
 *     - B-06（ダイオードOR）/ B-11（ダイオードAND）など、
 *       「半導体素子で組まれた論理回路」の判定に使う
 *
 *  2. ゲートレベルの論理伝搬
 *     - 回路に digitalGate モデル素子（U_NOT / U_AND / U_OR / U_NAND / U_NOR /
 *       U_XOR）があれば、DC 解析の代わりに純粋な論理伝搬で真理値表を作る
 *     - DFF は順序回路のため真理値表評価では未対応（警告を出してスキップ）
 *
 * 判定条件（truthTable チェック）に書ける追加フィールド:
 *  - inputs     : 入力ネット名の配列（例: ["A", "B"]）- 省略時はゲート入力から推定
 *  - outputs    : 出力ネット名の配列（例: ["Y"]）- 省略時はゲート出力から推定
 *  - driveLowV  : 入力 Low に注入する電圧 [V]（既定 0）
 *  - driveHighV : 入力 High に注入する電圧 [V]（既定 5）
 *  - vih        : 出力 High とみなすしきい値 [V]（既定 driveHighV / 2）
 *  - vil        : 出力 Low とみなすしきい値 [V]（既定 vih と同じ）
 *
 * 結果形式:
 *  {
 *    ok: true,
 *    digital: {
 *      truthTable:   [[0,0,0], [0,1,1], ...],   // 入力列 + 出力列（0/1 の数値）
 *      inputs:       ["A", "B"],
 *      outputs:      ["Y"],
 *      measurements: [ { inputs: {A:0,B:0}, outputs: {Y:0} }, ... ],
 *      vih: 2.5,
 *      vil: 2.5
 *    }
 *  }
 *
 * 注意:
 *  - 入力ネットには仮想電源を gnd 基準で接続するため、
 *    入力ネットは接地されていてはいけない（gnd / 0 は入力に使えない）。
 *  - DC 解析で解けない組み合わせがあれば、その行はスキップされ ok=false になる。
 */

import { registerSimulationMode } from "./simulator.js";
import { runDc } from "./dc.js";
import { parseMetricValue } from "../core/units.js";

/** 真理値表スイープで扱える入力ネット数の上限（2^8 = 256 行まで）。 */
const MAX_SWEEP_INPUTS = 8;

/** ゲート伝搬の最大反復パス数（ゲート数 + 2）。 */
const MAX_GATE_PASSES_EXTRA = 2;

/** 仮想入力電源の ID 接頭辞（ボード上の部品 ID と衝突しない名前）。 */
const DRIVER_ID_PREFIX = "__DIG_DRV_";

/* ------------------------------------------------------------------ */
/* 小さなユーティリティ                                                 */
/* ------------------------------------------------------------------ */

/**
 * パラメータを数値へ変換します（dc.js と同じ規約）。
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
 * 文字列配列として安全に取り出します（重複除去・gnd 除外）。
 * @param {unknown} value
 * @param {string[]} errors
 * @param {string} label
 * @returns {string[]}
 */
function toNetList(value, errors, label) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    errors.push(`${label} は配列である必要があります。`);
    return [];
  }

  const nets = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${label} には空でないネット名を指定してください。`);
      continue;
    }

    const net = item.trim();

    if (isGroundNet(net)) {
      errors.push(
        `${label} にグランド（${net}）は指定できません。入出力は gnd 以外のネットにしてください。`
      );
      continue;
    }

    if (!nets.includes(net)) {
      nets.push(net);
    }
  }

  return nets;
}

/* ------------------------------------------------------------------ */
/* スイープ設定の組み立て                                               */
/* ------------------------------------------------------------------ */

/**
 * 判定条件（checks）から真理値表スイープの設定を組み立てます。
 *
 * @param {Array<object>} checks
 * @param {string[]} gateInputs    ゲート伝搬時に推定した入力ネット（フォールバック用）
 * @param {string[]} gateOutputs   ゲート伝搬時に推定した出力ネット（フォールバック用）
 * @param {{errors: string[], warnings: string[]}} log
 * @returns {object|null} スイープ設定（truthTable チェックがなければ null）
 */
function buildSweepSpec(checks, gateInputs, gateOutputs, log) {
  if (!Array.isArray(checks)) {
    return null;
  }

  const truthChecks = checks.filter((c) => c && c.type === "truthTable");

  if (truthChecks.length === 0) {
    return null;
  }

  if (truthChecks.length > 1) {
    log.warnings.push(
      "truthTable 判定が複数あります。先頭の判定を使用して真理値表を作成します。"
    );
  }

  const check = truthChecks[0];

  const inputs = toNetList(check.inputs, log.errors, "truthTable.inputs");
  const outputs = toNetList(check.outputs, log.errors, "truthTable.outputs");

  const driveLowV = Number.isFinite(Number(check.driveLowV))
    ? Number(check.driveLowV)
    : 0;
  const driveHighV = Number.isFinite(Number(check.driveHighV))
    ? Number(check.driveHighV)
    : 5;

  const vih = Number.isFinite(Number(check.vih))
    ? Number(check.vih)
    : driveHighV / 2;
  const vil = Number.isFinite(Number(check.vil)) ? Number(check.vil) : vih;

  return {
    check,
    // ゲート回路では inputs 未指定なら回路から推定した入力を使う
    inputs: inputs.length > 0 ? inputs : [...gateInputs],
    outputs: outputs.length > 0 ? outputs : [...gateOutputs],
    driveLowV,
    driveHighV,
    vih,
    vil,
  };
}

/**
 * 出力電圧を論理値へ量子化します。
 * vil < v < vih の不定帯域は 0 として扱い、警告を残します。
 *
 * @param {string} net
 * @param {number} v
 * @param {number} vih
 * @param {number} vil
 * @param {{errors: string[], warnings: string[]}} log
 * @returns {number}
 */
function quantizeLogic(net, v, vih, vil, log) {
  if (v >= vih) return 1;
  if (v <= vil) return 0;

  log.warnings.push(
    `出力 ${net} の電圧 ${v.toFixed(3)}V はしきい値の間（不定）のため Low として扱います。`
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* 方式 1: DC 解析による真理値表抽出（ダイオードロジック向け）            */
/* ------------------------------------------------------------------ */

/**
 * 入力ネットに仮想電源を注入しながら DC 解析を繰り返し、真理値表を作ります。
 *
 * @param {object} circuit { components, wires, nodes }
 * @param {object} spec buildSweepSpec の結果
 * @param {{errors: string[], warnings: string[]}} log
 * @returns {{truthTable: number[][], measurements: object[]}}
 */
function sweepTruthTableByDc(circuit, spec, log) {
  const { inputs, outputs, driveLowV, driveHighV, vih, vil } = spec;
  const truthTable = [];
  const measurements = [];

  if (inputs.length === 0) {
    log.errors.push(
      "truthTable 判定に入力ネット（inputs）が指定されていません。"
    );
    return { truthTable, measurements };
  }

  if (inputs.length > MAX_SWEEP_INPUTS) {
    log.errors.push(
      `truthTable の入力が多すぎます（${inputs.length} 個、上限 ${MAX_SWEEP_INPUTS} 個）。`
    );
    return { truthTable, measurements };
  }

  if (outputs.length === 0) {
    log.errors.push(
      "truthTable 判定に出力ネット（outputs）が指定されていません。"
    );
    return { truthTable, measurements };
  }

  const rows = 1 << inputs.length;

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    // 入力列のビット（inputs[0] が最上位ビット）
    const bits = inputs.map(
      (_, j) => (rowIndex >> (inputs.length - 1 - j)) & 1
    );

    // 仮想入力電源（gnd 基準）を追加した回路で DC 解析
    const drivers = inputs.map((net, j) => ({
      id: `${DRIVER_ID_PREFIX}${j}_${net}`,
      type: "V_DC",
      params: { V: bits[j] ? driveHighV : driveLowV },
      connect: [net, "gnd"],
    }));

    const dcResult = runDc({
      ...circuit,
      components: [...(circuit.components ?? []), ...drivers],
    });

    if (!dcResult?.ok) {
      const detail = Array.isArray(dcResult?.errors)
        ? dcResult.errors.join(" / ")
        : "不明なエラー";
      log.errors.push(
        `入力 ${bits.join(",")} の DC 解析に失敗しました: ${detail}`
      );
      continue;
    }

    const nodes = dcResult.dc?.nodes ?? {};
    const inputVoltages = {};
    const outputVoltages = {};

    inputs.forEach((net, j) => {
      inputVoltages[net] = bits[j] ? driveHighV : driveLowV;
    });

    const outBits = outputs.map((net) => {
      const v = nodes[net];
      if (!Number.isFinite(v)) {
        log.warnings.push(
          `出力ネット ${net} の電圧が得られませんでした（未接続？）0 として扱います。`
        );
        outputVoltages[net] = 0;
        return 0;
      }
      outputVoltages[net] = v;
      return quantizeLogic(net, v, vih, vil, log);
    });

    truthTable.push([...bits, ...outBits]);
    measurements.push({ inputs: inputVoltages, outputs: outputVoltages });
  }

  return { truthTable, measurements };
}

/* ------------------------------------------------------------------ */
/* 方式 2: ゲートレベルの論理伝搬（U_NOT / U_AND / ... 向け）            */
/* ------------------------------------------------------------------ */

/**
 * ゲート種別ごとの論理関数です。
 */
const GATE_FUNCTIONS = {
  NOT: (a) => (a ? 0 : 1),
  AND: (a, b) => (a && b ? 1 : 0),
  OR: (a, b) => (a || b ? 1 : 0),
  NAND: (a, b) => (a && b ? 0 : 1),
  NOR: (a, b) => (a || b ? 0 : 1),
  XOR: (a, b) => (a !== b ? 1 : 0),
};

/**
 * 回路からゲート素子を収集します。
 *
 * ピン割り当ては components.json の pinNames 規約に合わせる:
 *  - 2 端子（U_NOT）        : connect = [A, Y]
 *  - 3 端子（2 入力ゲート） : connect = [A, B, Y]
 *  - DFF                    : connect = [D, CLK, Q, Q_NOT]（真理値表では未対応）
 *
 * @param {object} circuit
 * @param {{errors: string[], warnings: string[]}} log
 * @returns {{gates: object[], drivenNets: string[], externalInputs: string[]}|null}
 *          ゲートがなければ null
 */
function collectGateNetwork(circuit, log) {
  const gates = [];
  const drivenNets = [];

  for (const c of circuit.components ?? []) {
    const model = c?.simulation?.model;

    if (model === "digitalGate") {
      const kind = String(c?.simulation?.gate ?? "").toUpperCase();
      const fn = GATE_FUNCTIONS[kind];
      const pins = Array.isArray(c.connect) ? c.connect : [];

      if (!fn) {
        log.warnings.push(
          `部品 ${c.id}: 未対応のゲート種別「${kind}」のため評価をスキップします。`
        );
        continue;
      }

      if (fn.length === 1 && pins.length >= 2) {
        const outNet = pins[1];
        gates.push({ id: c.id, fn, inNets: [pins[0]], outNets: [outNet] });
        if (!drivenNets.includes(outNet)) drivenNets.push(outNet);
      } else if (fn.length === 2 && pins.length >= 3) {
        const outNet = pins[2];
        gates.push({
          id: c.id,
          fn,
          inNets: [pins[0], pins[1]],
          outNets: [outNet],
        });
        if (!drivenNets.includes(outNet)) drivenNets.push(outNet);
      } else {
        log.warnings.push(
          `部品 ${c.id}: ピン数（${pins.length}）がゲート種別 ${kind} と合わないためスキップします。`
        );
      }
      continue;
    }

    if (model === "dff") {
      log.warnings.push(
        `部品 ${c.id}: DFF は順序回路のため真理値表評価では扱えません（スキップします）。`
      );
    }
  }

  if (gates.length === 0) {
    return null;
  }

  // ゲート入力のうち、他のゲート出力で駆動されていないネット = 外部入力
  const externalInputs = [];
  for (const g of gates) {
    for (const net of g.inNets) {
      if (drivenNets.includes(net)) continue;
      if (!externalInputs.includes(net)) externalInputs.push(net);
    }
  }

  return { gates, drivenNets, externalInputs };
}

/**
 * ゲートネットワークを論理伝搬で評価し、真理値表を作ります。
 *
 * @param {object} circuit
 * @param {object} spec buildSweepSpec の結果
 * @param {object} network collectGateNetwork の結果
 * @param {{errors: string[], warnings: string[]}} log
 * @returns {{truthTable: number[][], measurements: object[]}}
 */
function sweepTruthTableByGates(circuit, spec, network, log) {
  const { gates, drivenNets, externalInputs } = network;
  const truthTable = [];
  const measurements = [];

  const inputs = spec.inputs.length > 0 ? spec.inputs : externalInputs;
  const outputs = spec.outputs.length > 0 ? spec.outputs : [...drivenNets].sort();

  if (inputs.length === 0) {
    log.errors.push(
      "ゲート回路に入力ネットがありません。truthTable 判定の inputs で指定してください。"
    );
    return { truthTable, measurements };
  }

  if (inputs.length > MAX_SWEEP_INPUTS) {
    log.errors.push(
      `truthTable の入力が多すぎます（${inputs.length} 個、上限 ${MAX_SWEEP_INPUTS} 個）。`
    );
    return { truthTable, measurements };
  }

  if (outputs.length === 0) {
    log.errors.push(
      "ゲート回路に出力ネットがありません。truthTable 判定の outputs で指定してください。"
    );
    return { truthTable, measurements };
  }

  const maxPasses = gates.length + MAX_GATE_PASSES_EXTRA;
  const rows = 1 << inputs.length;

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const bits = inputs.map(
      (_, j) => (rowIndex >> (inputs.length - 1 - j)) & 1
    );

    // ネット論理値マップ: スイープ入力で初期化
    const netValues = new Map();
    inputs.forEach((net, j) => netValues.set(net, bits[j]));

    // 伝搬が収束するまで繰り返す（組み合わせ回路なので必ず収束する）
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let changed = false;

      for (const g of gates) {
        if (g.outNets.some((net) => netValues.has(net))) continue;

        const inVals = g.inNets.map((net) => netValues.get(net));

        if (inVals.some((v) => v === undefined)) continue;

        const out = g.fn(...inVals);
        g.outNets.forEach((net) => netValues.set(net, out));
        changed = true;
      }

      if (!changed) break;
    }

    const inputLogics = {};
    const outputLogics = {};

    inputs.forEach((net, j) => {
      inputLogics[net] = bits[j];
    });

    const outBits = outputs.map((net) => {
      const v = netValues.get(net);
      if (v === undefined) {
        log.warnings.push(
          `出力ネット ${net} の論理値が確定しませんでした（未接続またはゲート未接続）。0 として扱います。`
        );
        outputLogics[net] = 0;
        return 0;
      }
      outputLogics[net] = v;
      return v;
    });

    truthTable.push([...bits, ...outBits]);
    measurements.push({ inputs: inputLogics, outputs: outputLogics });
  }

  return { truthTable, measurements };
}

/* ------------------------------------------------------------------ */
/* モード本体                                                           */
/* ------------------------------------------------------------------ */

/**
 * digital シミュレーション本体。
 *
 * @param {object} circuit { components, wires, nodes }
 * @param {object} options  { checks: 判定条件配列 }
 * @returns {object}
 */
export function runDigital(circuit, options = {}) {
  const log = { errors: [], warnings: [] };
  const emptyDigital = {
    truthTable: null,
    inputs: [],
    outputs: [],
    measurements: [],
  };

  const components = Array.isArray(circuit?.components)
    ? circuit.components
    : [];

  // ゲート素子の有無で評価方式を分ける
  const network = collectGateNetwork(circuit, log);

  if (network) {
    if (components.some((c) => c?.simulation?.model !== "digitalGate" && c?.simulation?.model !== "dff" && c?.type !== "GND" && c?.type !== "WIRE")) {
      log.warnings.push(
        "ゲート素子とアナログ素子が混在しています。digital モードではゲートの論理伝搬のみを評価し、アナログ素子は無視します。"
      );
    }
  }

  const spec = buildSweepSpec(
    options.checks,
    network ? network.externalInputs : [],
    network ? [...network.drivenNets].sort() : [],
    log
  );

  if (!spec) {
    log.warnings.push(
      "truthTable 判定がないため、digital モードでは真理値表を作成しませんでした。"
    );
    return { ok: log.errors.length === 0, digital: emptyDigital, ...log };
  }

  let evaluated;

  if (network) {
    evaluated = sweepTruthTableByGates(circuit, spec, network, log);
  } else {
    evaluated = sweepTruthTableByDc(circuit, spec, log);
  }

  const digital = {
    ...emptyDigital,
    truthTable: evaluated.truthTable,
    inputs: spec.inputs,
    outputs: spec.outputs,
    measurements: evaluated.measurements,
    vih: spec.vih,
    vil: spec.vil,
  };

  // 1 行も作れなければエラー扱い
  if (evaluated.truthTable.length === 0) {
    log.errors.push(
      "真理値表を 1 行も作成できませんでした。入出力ネットの指定と配線を確認してください。"
    );
  }

  return {
    ok: log.errors.length === 0,
    digital,
    errors: log.errors,
    warnings: log.warnings,
  };
}

/**
 * digital モードを registerSimulationMode に登録します。
 */
export function registerDigitalMode() {
  registerSimulationMode("digital", async (circuit, options) =>
    runDigital(circuit, options)
  );
}

// import された時点で自動登録（setup.js での明示呼び出しも可）
registerDigitalMode();
