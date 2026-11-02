/**
 * 単位・メトリックプレフィックスを扱う共通ユーティリティです。
 *
 * 役割:
 * - "10k" -> 10000
 * - "4.7kΩ" -> 4700
 * - "100nF" -> 1e-7
 * - "1uF" -> 1e-6
 * - "1MHz" -> 1e6
 * - 1000 -> "1kΩ"
 * - 0.000001 -> "1µF"
 *
 * 方針:
 * - 内部値は基本SI単位で扱う。
 *   抵抗: ohm
 *   静電容量: F
 *   インダクタンス: H
 *   電圧: V
 *   電流: A
 *   周波数: Hz
 *   時間: s
 *   電力: W
 * - 表示時のみ人が読みやすいプレフィックス付きへ変換する。
 */

/**
 * プレフィックス倍率。
 * 大文字小文字の揺れは normalizePrefix() で吸収します。
 */
const PREFIX_FACTORS = {
  "": 1,
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  K: 1e3,
  m: 1e-3,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

/**
 * 表示用プレフィックス。
 * 大きい単位から順に探索します。
 */
const DISPLAY_PREFIXES = [
  { factor: 1e12, symbol: "T" },
  { factor: 1e9, symbol: "G" },
  { factor: 1e6, symbol: "M" },
  { factor: 1e3, symbol: "k" },
  { factor: 1, symbol: "" },
  { factor: 1e-3, symbol: "m" },
  { factor: 1e-6, symbol: "µ" },
  { factor: 1e-9, symbol: "n" },
  { factor: 1e-12, symbol: "p" },
  { factor: 1e-15, symbol: "f" },
];

/**
 * 単位エイリアス。
 * 入力時の揺れを吸収します。
 */
const UNIT_ALIASES = {
  "": "",
  ohm: "Ω",
  ohms: "Ω",
  Ω: "Ω",
  ω: "Ω",

  f: "F",
  farad: "F",
  farads: "F",

  h: "H",
  henry: "H",
  henrys: "H",

  v: "V",
  volt: "V",
  volts: "V",

  a: "A",
  amp: "A",
  amps: "A",
  ampere: "A",
  amperes: "A",

  hz: "Hz",
  hertz: "Hz",

  s: "s",
  sec: "s",
  second: "s",
  seconds: "s",

  w: "W",
  watt: "W",
  watts: "W",

  db: "dB",
  dbm: "dBm",
  dbv: "dBV",

  percent: "%",
  "%": "%",

  deg: "deg",
  "°": "deg",

  bit: "bit",
  bits: "bit",

  px: "px",
};

/**
 * 基本的にプレフィックスを付けない単位。
 */
const NO_PREFIX_UNITS = new Set([
  "%",
  "dB",
  "dBm",
  "dBV",
  "deg",
  "bit",
  "px",
]);

/**
 * 入力文字列を正規化します。
 * 全角数字、全角記号、カンマなどを整理します。
 *
 * @param {string} input
 * @returns {string}
 */
function normalizeInputString(input) {
  return String(input)
    .normalize("NFKC")
    .trim()
    .replace(/,/g, "");
}

/**
 * プレフィックス表記を正規化します。
 *
 * @param {string} prefix
 * @returns {string}
 */
function normalizePrefix(prefix) {
  if (!prefix) {
    return "";
  }

  if (prefix === "K") {
    return "k";
  }

  if (prefix === "μ" || prefix === "µ") {
    return "u";
  }

  return prefix;
}

/**
 * 単位を正規化します。
 *
 * @param {string} unit
 * @returns {string}
 */
export function normalizeUnit(unit) {
  const trimmed = String(unit ?? "").trim();

  if (!trimmed) {
    return "";
  }

  const lower = trimmed.toLowerCase();

  if (UNIT_ALIASES[lower]) {
    return UNIT_ALIASES[lower];
  }

  return trimmed;
}

/**
 * メトリック表記を解析し、数値・プレフィックス・単位に分解します。
 *
 * @param {string | number} input
 * @returns {{
 *   raw: string,
 *   value: number,
 *   prefix: string,
 *   unit: string,
 *   baseValue: number,
 * }}
 *
 * @example
 * parseMetricWithUnit("4.7kΩ");
 * // {
 * //   raw: "4.7kΩ",
 * //   value: 4.7,
 * //   prefix: "k",
 * //   unit: "Ω",
 * //   baseValue: 4700
 * // }
 *
 * @example
 * parseMetricWithUnit("100nF");
 * // {
 * //   raw: "100nF",
 * //   value: 100,
 * //   prefix: "n",
 * //   unit: "F",
 * //   baseValue: 1e-7
 * // }
 */
export function parseMetricWithUnit(input) {
  if (typeof input === "number") {
    return {
      raw: String(input),
      value: input,
      prefix: "",
      unit: "",
      baseValue: input,
    };
  }

  const raw = String(input ?? "");
  const normalized = normalizeInputString(raw);

  const emptyResult = {
    raw,
    value: NaN,
    prefix: "",
    unit: "",
    baseValue: NaN,
  };

  if (!normalized) {
    return emptyResult;
  }

  /**
   * 数値部:
   * - 123
   * - 123.45
   * - .5
   * - 1e3
   * - -2.2e-6
   *
   * プレフィックス部:
   * - T, G, M, k, K, m, u, µ, n, p, f
   *
   * 単位部:
   * - Ω, F, V, A, Hz, s, W, dB など
   */
  const matched = normalized.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([TGMkKmuµnpf])?\s*(.*)$/
  );

  if (!matched) {
    return emptyResult;
  }

  const numericPart = Number(matched[1]);

  if (!Number.isFinite(numericPart)) {
    return emptyResult;
  }

  const prefix = normalizePrefix(matched[2] ?? "");
  const factor = PREFIX_FACTORS[prefix] ?? 1;
  const unit = normalizeUnit(matched[3] ?? "");

  return {
    raw,
    value: numericPart,
    prefix,
    unit,
    baseValue: numericPart * factor,
  };
}

/**
 * メトリック表記を基本SI単位の数値へ変換します。
 *
 * @param {string | number} input
 * @returns {number} 変換できない場合は NaN
 *
 * @example
 * parseMetricValue("10k");
 * // 10000
 *
 * @example
 * parseMetricValue("4.7kΩ");
 * // 4700
 *
 * @example
 * parseMetricValue("100nF");
 * // 1e-7
 */
export function parseMetricValue(input) {
  return parseMetricWithUnit(input).baseValue;
}

/**
 * parseMetricValue の別名です。
 *
 * @param {string | number} input
 * @returns {number}
 */
export function parseMetric(input) {
  return parseMetricValue(input);
}

/**
 * 数値を表示用に丸めます。
 *
 * @param {number} value
 * @param {number} [maxDecimals=6]
 * @returns {string}
 */
function formatPlainNumber(value, maxDecimals = 6) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  let normalizedValue = value;

  if (Object.is(normalizedValue, -0)) {
    normalizedValue = 0;
  }

  const abs = Math.abs(normalizedValue);

  if (abs !== 0 && abs < 1e-6) {
    return normalizedValue.toExponential(3);
  }

  const fixed = normalizedValue.toFixed(maxDecimals);

  return String(Number(fixed));
}

/**
 * 基本SI単位の数値を、人が読みやすいメトリック表記へ変換します。
 *
 * @param {number} value 基本SI単位の数値
 * @param {string} [unit=""] 単位。例: "Ω", "F", "V", "Hz"
 * @param {object} [options]
 * @param {number} [options.maxDecimals=6]
 * @returns {string}
 *
 * @example
 * formatMetricValue(4700, "Ω");
 * // "4.7kΩ"
 *
 * @example
 * formatMetricValue(0.0000001, "F");
 * // "100nF"
 *
 * @example
 * formatMetricValue(1000000, "Hz");
 * // "1MHz"
 */
export function formatMetricValue(value, unit = "", options = {}) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const normalizedUnit = normalizeUnit(unit);
  const maxDecimals = options.maxDecimals ?? 6;

  if (NO_PREFIX_UNITS.has(normalizedUnit)) {
    return `${formatPlainNumber(value, maxDecimals)}${normalizedUnit}`;
  }

  if (value === 0) {
    return `0${normalizedUnit}`;
  }

  const abs = Math.abs(value);

  /**
   * f（フェムト）より小さい値は、無理にプレフィックス表示せず指数表記にします。
   */
  if (abs < 1e-15) {
    return `${value.toExponential(3)}${normalizedUnit}`;
  }

  const chosen =
    DISPLAY_PREFIXES.find((entry) => abs >= entry.factor) ??
    DISPLAY_PREFIXES[DISPLAY_PREFIXES.length - 1];

  const scaled = value / chosen.factor;

  return `${formatPlainNumber(scaled, maxDecimals)}${chosen.symbol}${normalizedUnit}`;
}

/**
 * 抵抗値を表示します。
 *
 * @param {number} value ohm
 * @returns {string}
 */
export function formatOhms(value) {
  return formatMetricValue(value, "Ω");
}

/**
 * 静電容量を表示します。
 *
 * @param {number} value F
 * @returns {string}
 */
export function formatFarads(value) {
  return formatMetricValue(value, "F");
}

/**
 * インダクタンスを表示します。
 *
 * @param {number} value H
 * @returns {string}
 */
export function formatHenries(value) {
  return formatMetricValue(value, "H");
}

/**
 * 電圧を表示します。
 *
 * @param {number} value V
 * @returns {string}
 */
export function formatVolts(value) {
  return formatMetricValue(value, "V");
}

/**
 * 電流を表示します。
 *
 * @param {number} value A
 * @returns {string}
 */
export function formatAmperes(value) {
  return formatMetricValue(value, "A");
}

/**
 * 周波数を表示します。
 *
 * @param {number} value Hz
 * @returns {string}
 */
export function formatHertz(value) {
  return formatMetricValue(value, "Hz");
}

/**
 * 時間を表示します。
 *
 * @param {number} value s
 * @returns {string}
 */
export function formatSeconds(value) {
  return formatMetricValue(value, "s");
}

/**
 * 電力を表示します。
 *
 * @param {number} value W
 * @returns {string}
 */
export function formatWatts(value) {
  return formatMetricValue(value, "W");
}

/**
 * 数値が有限かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 数値を指定範囲へ収めます。
 *
 * @param {number} value
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return NaN;
  }

  let result = value;

  if (Number.isFinite(min)) {
    result = Math.max(result, min);
  }

  if (Number.isFinite(max)) {
    result = Math.min(result, max);
  }

  return result;
}

/**
 * 値をパースし、指定範囲へ収めます。
 * 入力欄の値を安全に数値化する用途を想定しています。
 *
 * @param {string | number} input
 * @param {object} [options]
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {number} [options.fallback]
 * @returns {number}
 */
export function parseAndClamp(input, options = {}) {
  const parsed = parseMetricValue(input);

  if (!Number.isFinite(parsed)) {
    return options.fallback ?? NaN;
  }

  return clamp(parsed, options.min, options.max);
}