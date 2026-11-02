/**
 * ID生成ユーティリティです。
 *
 * 役割:
 * - 部品インスタンスID作成（例: R1, C2, V1）
 * - ワイヤID作成（例: W1, W2）
 * - ノードID作成（例: N1, N2）
 * - 一時的な一意ID作成
 * - 問題ID作成（例: A-01, B-03）
 *
 * 方針:
 * - 読みやすさを優先する。
 * - 既存IDと衝突しない連番を作る。
 * - 部品種別によっては、回路図でよく使われるプレフィックスを使う。
 */

/**
 * モジュール内で共有する連番カウンタ。
 * 一時的な一意ID作成に使います。
 */
let uniqueSequence = 0;

/**
 * 文字列中の正規表現特殊文字をエスケープします。
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * IDプレフィックスとして安全な文字列に整形します。
 *
 * @param {string} prefix
 * @returns {string}
 */
function sanitizeIdPrefix(prefix) {
  const cleaned = String(prefix ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "");

  return cleaned.length > 0 ? cleaned : "ID";
}

/**
 * 既存IDリストを正規化します。
 * 文字列配列だけでなく、{ id: "R1" } のようなオブジェクト配列も受け付けます。
 *
 * @param {Iterable<unknown>} existingIds
 * @returns {string[]}
 */
function normalizeExistingIds(existingIds) {
  if (!existingIds) {
    return [];
  }

  const list = Array.isArray(existingIds)
    ? existingIds
    : Array.from(existingIds);

  return list
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item.id === "string") {
        return item.id;
      }

      return "";
    })
    .filter((value) => value.length > 0);
}

/**
 * 連番IDを整形します。
 *
 * @param {string} prefix
 * @param {number} n
 * @param {number} pad
 * @returns {string}
 */
function formatSequentialId(prefix, n, pad) {
  const numberText =
    pad > 0
      ? String(n).padStart(pad, "0")
      : String(n);

  return `${prefix}${numberText}`;
}

/**
 * 一時的な一意IDを作成します。
 * 回路部品の正式なIDというより、
 * ドラッグ中アイテム、内部状態、テスト用途などを想定しています。
 *
 * @param {string} [prefix="id"]
 * @returns {string}
 *
 * @example
 * createUniqueId("drag");
 * // "drag_m3k2j9_1"
 */
export function createUniqueId(prefix = "id") {
  uniqueSequence += 1;

  const safePrefix = sanitizeIdPrefix(prefix);
  const timePart = Date.now().toString(36);
  const sequencePart = uniqueSequence.toString(36);

  return `${safePrefix}_${timePart}_${sequencePart}`;
}

/**
 * 既存IDと衝突しない連番IDを作成します。
 *
 * @param {string} prefix 例: "R", "W", "N"
 * @param {Iterable<string | {id?: string}>} [existingIds=[]]
 * @param {object} [options]
 * @param {number} [options.start=1] 開始番号
 * @param {number} [options.pad=0] 数字部のゼロ埋め桁数
 * @returns {string}
 *
 * @example
 * createSequentialId("R", ["R1", "R2"]);
 * // "R3"
 *
 * @example
 * createSequentialId("A-", [1], { pad: 2 });
 * // 注意点: これは "A-1" のようなIDではなく、
 * // プレフィックス "A-" がサニタイズされて "A1" になります。
 * // 問題IDは createProblemId() を使ってください。
 */
export function createSequentialId(prefix, existingIds = [], options = {}) {
  const { start = 1, pad = 0 } = options;

  const safePrefix = sanitizeIdPrefix(prefix);
  const ids = normalizeExistingIds(existingIds);

  const usedNumbers = new Set();
  const usedStrings = new Set();

  const numberPattern = new RegExp(
    `^${escapeRegExp(safePrefix)}(\\d+)$`
  );

  for (const id of ids) {
    usedStrings.add(id);

    const matched = String(id).match(numberPattern);

    if (matched) {
      usedNumbers.add(Number(matched[1]));
    }
  }

  const startNumber = Math.max(1, Number(start) || 1);
  const maxAttempts = 100_000;

  for (let n = startNumber; n < startNumber + maxAttempts; n += 1) {
    if (usedNumbers.has(n)) {
      continue;
    }

    const candidate = formatSequentialId(safePrefix, n, pad);

    if (!usedStrings.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `IDを生成できませんでした。prefix=${safePrefix}, start=${startNumber}`
  );
}

/**
 * 部品種別から、回路図で自然なIDプレフィックスを推定します。
 *
 * @param {string} type
 * @returns {string}
 */
export function getComponentIdPrefix(type) {
  const normalized = String(type ?? "").toUpperCase().trim();

  /**
   * よくある部品種別とプレフィックスの対応表。
   * ここにないものは、種別名から推定します。
   */
  const prefixMap = {
    WIRE: "W",
    GND: "GND",
    NODE: "N",

    R: "R",
    RESISTOR: "R",
    VR: "VR",
    POT: "VR",

    C: "C",
    CAP: "C",
    CAPACITOR: "C",

    L: "L",
    IND: "L",
    INDUCTOR: "L",

    V: "V",
    V_DC: "V",
    V_AC: "V",
    V_PULSE: "V",
    VS: "V",

    I: "I",
    I_DC: "I",
    I_AC: "I",
    IS: "I",

    D: "D",
    DIODE: "D",
    SCHOTTKY: "D",
    LED: "LED",
    ZENER: "ZD",
    TVS: "TVS",
    VARICAP: "VC",

    Q: "Q",
    BJT: "Q",
    NPN: "Q",
    PNP: "Q",

    M: "M",
    MOSFET: "M",
    NMOS: "M",
    PMOS: "M",

    J: "J",
    JFET: "J",

    U: "U",
    IC: "U",
    OPAMP: "U",
    COMPARATOR: "U",
    GATE: "U",
    LOGIC: "U",
    MUX: "U",
    DEMUX: "U",
    ENCODER: "U",
    DECODER: "U",
    ADDER: "U",
    COUNTER: "U",
    SHIFTREG: "U",
    REGISTER: "U",
    LATCH: "U",
    FF: "U",
    DFF: "U",
    JKFF: "U",
    TFF: "U",
    SRFF: "U",

    K: "K",
    RELAY: "K",

    SW: "SW",
    SWITCH: "SW",
    BUTTON: "SW",

    T: "T",
    TRANSFORMER: "T",
    XFMR: "T",
    CTR: "T",

    X: "X",
    XTAL: "X",
    OSC: "X",

    TP: "TP",
    PROBE: "TP",

    F: "F",
    FUSE: "F",

    TH: "TH",
    THERMISTOR: "TH",

    ANT: "ANT",
    ANTENNA: "ANT",

    MTR: "MTR",
    MOTOR: "MTR",

    BAT: "BAT",
    BATTERY: "BAT",

    SOL: "SOL",
    SOLAR: "SOL",

    SPK: "SPK",
    SPEAKER: "SPK",
    MIC: "MIC",
    MICROPHONE: "MIC",
  };

  if (prefixMap[normalized]) {
    return prefixMap[normalized];
  }

  const cleaned = normalized.replace(/[^A-Z0-9_]/g, "");

  if (!cleaned) {
    return "X";
  }

  /**
   * アンダースコアを除去して短縮します。
   * 例:
   * - "V_DC" -> "VDC"
   * - "OPAMP" -> "OPAM"
   */
  const shortPrefix = cleaned.replace(/_/g, "").slice(0, 4);

  if (/^[A-Z]/.test(shortPrefix)) {
    return shortPrefix;
  }

  return `X${shortPrefix}`;
}

/**
 * 部品用IDを作成します。
 *
 * @param {string} type 部品種別。例: "R", "C", "V_DC"
 * @param {Iterable<string | {id?: string}>} [existingComponents=[]]
 * @returns {string}
 *
 * @example
 * createComponentId("R", []);
 * // "R1"
 *
 * @example
 * createComponentId("R", [{ id: "R1" }, { id: "R2" }]);
 * // "R3"
 */
export function createComponentId(type, existingComponents = []) {
  const prefix = getComponentIdPrefix(type);

  return createSequentialId(prefix, existingComponents);
}

/**
 * ワイヤ用IDを作成します。
 *
 * @param {Iterable<string | {id?: string}>} [existingWires=[]]
 * @returns {string}
 *
 * @example
 * createWireId([]);
 * // "W1"
 */
export function createWireId(existingWires = []) {
  return createSequentialId("W", existingWires);
}

/**
 * ノード用IDを作成します。
 *
 * @param {Iterable<string | {id?: string}>} [existingNodes=[]]
 * @returns {string}
 *
 * @example
 * createNodeId([]);
 * // "N1"
 */
export function createNodeId(existingNodes = []) {
  return createSequentialId("N", existingNodes);
}

/**
 * 問題IDを作成します。
 *
 * @param {string} categoryId 例: "A"
 * @param {number} serialNumber 例: 1, 2, 3
 * @returns {string} 例: "A-01"
 *
 * @example
 * createProblemId("A", 1);
 * // "A-01"
 *
 * @example
 * createProblemId("B", 12);
 * // "B-12"
 */
export function createProblemId(categoryId, serialNumber) {
  const safeCategory = String(categoryId ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!safeCategory) {
    throw new Error("カテゴリIDが不正です。");
  }

  const serial = Number(serialNumber);

  if (!Number.isInteger(serial) || serial <= 0) {
    throw new Error("問題番号は正の整数である必要があります。");
  }

  return `${safeCategory}-${String(serial).padStart(2, "0")}`;
}

/**
 * 問題IDを解析します。
 *
 * @param {string} problemId 例: "A-01"
 * @returns {{categoryId: string, serialNumber: number} | null}
 *
 * @example
 * parseProblemId("A-01");
 * // { categoryId: "A", serialNumber: 1 }
 */
export function parseProblemId(problemId) {
  const matched = String(problemId ?? "").match(/^([A-Z0-9]+)-(\d+)$/);

  if (!matched) {
    return null;
  }

  return {
    categoryId: matched[1],
    serialNumber: Number(matched[2]),
  };
}