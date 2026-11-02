/**
 * 部品定義レジストリです。
 *
 * 役割:
 * - 部品定義の登録
 * - 部品種別からの定義取得
 * - カテゴリ別部品一覧
 * - パレット検索
 * - 既定パラメータ取得
 * - パラメータ定義取得
 * - パラメータ値の簡易変換
 *
 * 方針:
 * - 部品の実体インスタンスは state.js が管理する。
 * - ここでは「部品定義」だけを管理する。
 * - 未登録部品を使おうとした場合は明確にエラーにする。
 */

import { isNonEmptyString, isPlainObject } from "../core/validation.js";
import { parseMetricValue } from "../core/units.js";

/**
 * 回転角を 0 / 90 / 180 / 270 に正規化します。
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeDraftRotation(value) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return 0;
  }

  const rounded = Math.round(num / 90) * 90;

  return ((rounded % 360) + 360) % 360;
}

/**
 * 部品定義を管理するクラスです。
 */
export class ComponentRegistry {
  constructor() {
    /**
     * @type {Map<string, object>}
     */
    this._definitions = new Map();
  }

  /**
   * 部品カタログを読み込みます。
   *
   * @param {Array<object> | {components?: Array<object>}} catalog
   *   components.json 全体、または部品定義配列
   */
  load(catalog) {
    const definitions = Array.isArray(catalog)
      ? catalog
      : catalog?.components ?? [];

    this.clear();

    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * 登録済み部品をすべて削除します。
   */
  clear() {
    this._definitions.clear();
  }

  /**
   * 部品定義を1件登録します。
   *
   * @param {object} definition
   */
  register(definition) {
    if (!isPlainObject(definition)) {
      throw new Error("部品定義はオブジェクトである必要があります。");
    }

    if (!isNonEmptyString(definition.type)) {
      throw new Error("部品定義には type が必要です。");
    }

    if (this._definitions.has(definition.type)) {
      console.warn(`部品種別 ${definition.type} は再登録されます。`);
    }

    const normalized = this._normalizeDefinition(definition);

    this._definitions.set(normalized.type, normalized);
  }

  /**
   * 部品定義を扱いやすい形へ正規化します。
   *
   * @param {object} definition
   * @returns {object}
   */
  _normalizeDefinition(definition) {
    const category = Array.isArray(definition.category)
      ? definition.category.filter((item) => isNonEmptyString(item))
      : [];

    const pinNames = Array.isArray(definition.pinNames)
      ? definition.pinNames.map((pinName) => String(pinName))
      : [];

    const pinCount = Number.isInteger(definition.pinCount)
      ? definition.pinCount
      : pinNames.length;

    return {
      ...definition,

      type: definition.type,

      nameJa: isNonEmptyString(definition.nameJa)
        ? definition.nameJa
        : definition.type,

      category: category.length > 0 ? category : ["*"],

      symbol: isNonEmptyString(definition.symbol)
        ? definition.symbol
        : "generic",

      pinCount,
      pinNames,

      params: Array.isArray(definition.params)
        ? definition.params.filter((param) => isPlainObject(param))
        : [],

      simulation: isPlainObject(definition.simulation)
        ? definition.simulation
        : {},

      ui: isPlainObject(definition.ui)
        ? definition.ui
        : {},
    };
  }

  /**
   * 部品種別から定義を取得します。
   *
   * @param {string} type
   * @returns {object | null}
   */
  get(type) {
    if (!isNonEmptyString(type)) {
      return null;
    }

    return this._definitions.get(type) ?? null;
  }

  /**
   * 部品種別が登録済みかどうかを返します。
   *
   * @param {string} type
   * @returns {boolean}
   */
  has(type) {
    return this.get(type) !== null;
  }

  /**
   * 未登録部品なら例外を投げます。
   *
   * @param {string} type
   * @returns {object}
   */
  _getOrThrow(type) {
    const definition = this.get(type);

    if (!definition) {
      throw new Error(`部品 ${type} が未登録です。`);
    }

    return definition;
  }

  /**
   * 全部品定義を返します。
   *
   * @returns {Array<object>}
   */
  all() {
    return Array.from(this._definitions.values());
  }

  /**
   * 登録済みの部品種別一覧を返します。
   *
   * @returns {Array<string>}
   */
  types() {
    return Array.from(this._definitions.keys());
  }

  /**
   * 登録数を返します。
   *
   * @returns {number}
   */
  size() {
    return this._definitions.size;
  }

  /**
   * カテゴリに属する部品定義を返します。
   *
   * @param {string | null} categoryId
   * @returns {Array<object>}
   */
  forCategory(categoryId) {
    if (!categoryId) {
      return this.all();
    }

    return this.all().filter((definition) => {
      const categories = definition.category ?? [];

      return categories.includes("*") || categories.includes(categoryId);
    });
  }

  /**
   * 部品種別が指定カテゴリで利用可能かどうかを返します。
   *
   * @param {string} type
   * @param {string | null} categoryId
   * @returns {boolean}
   */
  isAvailableInCategory(type, categoryId) {
    const definition = this.get(type);

    if (!definition) {
      return false;
    }

    if (!categoryId) {
      return true;
    }

    const categories = definition.category ?? [];

    return categories.includes("*") || categories.includes(categoryId);
  }

  /**
   * パレットに表示する部品を検索します。
   *
   * @param {string} query
   * @param {string | null} [categoryId=null]
   * @returns {Array<object>}
   */
  search(query, categoryId = null) {
    const normalizedQuery = String(query ?? "").trim().toLowerCase();

    const baseDefinitions = categoryId
      ? this.forCategory(categoryId)
      : this.all();

    if (!normalizedQuery) {
      return baseDefinitions;
    }

    return baseDefinitions.filter((definition) => {
      const targets = [
        definition.type,
        definition.nameJa,
        definition.symbol,
        definition.description,
      ];

      return targets.some((target) =>
        String(target ?? "").toLowerCase().includes(normalizedQuery)
      );
    });
  }

  /**
   * パレット表示対象かどうかを返します。
   *
   * @param {string} type
   * @returns {boolean}
   */
  isPaletteVisible(type) {
    const definition = this.get(type);

    if (!definition) {
      return false;
    }

    return definition.ui?.palette !== false;
  }

  /**
   * シンボル名を返します。
   *
   * @param {string} type
   * @returns {string}
   */
  getSymbolName(type) {
    const definition = this.get(type);

    if (!definition) {
      return "generic";
    }

    return definition.symbol ?? "generic";
  }

  /**
   * ピン数を返します。
   *
   * @param {string} type
   * @returns {number}
   */
  getPinCount(type) {
    const definition = this._getOrThrow(type);

    return definition.pinCount ?? 0;
  }

  /**
   * ピン名一覧を返します。
   *
   * @param {string} type
   * @returns {Array<string>}
   */
  getPinNames(type) {
    const definition = this._getOrThrow(type);

    return definition.pinNames ?? [];
  }

  /**
   * パラメータ定義一覧を返します。
   *
   * @param {string} type
   * @returns {Array<object>}
   */
  getParamDefinitions(type) {
    const definition = this._getOrThrow(type);

    return definition.params ?? [];
  }

  /**
   * 特定パラメータの定義を返します。
   *
   * @param {string} type
   * @param {string} key
   * @returns {object | null}
   */
  getParamDefinition(type, key) {
    const definition = this._getOrThrow(type);

    return (
      (definition.params ?? []).find((param) => param.key === key) ?? null
    );
  }

  /**
   * パラメータの単位を返します。
   *
   * @param {string} type
   * @param {string} key
   * @returns {string}
   */
  getParamUnit(type, key) {
    const param = this.getParamDefinition(type, key);

    return param?.unit ?? "";
  }

  /**
   * 部品の既定パラメータを作成します。
   *
   * @param {string} type
   * @returns {object}
   */
  getDefaultParams(type) {
    const definition = this._getOrThrow(type);

    const params = {};

    for (const param of definition.params ?? []) {
      if (!isNonEmptyString(param.key)) {
        continue;
      }

      params[param.key] = param.default ?? 0;
    }

    return params;
  }

  /**
   * パラメータ値を簡易変換します。
   *
   * 例:
   * - "10k" -> 10000
   * - "100n" -> 1e-7
   * - "true" -> true
   *
   * @param {string} type
   * @param {string} key
   * @param {unknown} rawValue
   * @returns {unknown}
   */
  coerceParamValue(type, key, rawValue) {
    const param = this.getParamDefinition(type, key);

    if (typeof rawValue === "number") {
      return Number.isFinite(rawValue) ? rawValue : NaN;
    }

    if (typeof rawValue === "boolean") {
      return rawValue;
    }

    const text = String(rawValue ?? "").trim();

    if (!text) {
      return NaN;
    }

    if (/^(true|false)$/i.test(text)) {
      return /^true$/i.test(text);
    }

    const parsed = parseMetricValue(text);

    if (Number.isFinite(parsed)) {
      return parsed;
    }

    /**
     * 数値として解釈できなかった場合は、
     * 文字列パラメータとしてそのまま返します。
     */
    return text;
  }

  /**
   * 部品インスタンスのドラフトを作成します。
   * まだIDは持ちません。IDは state.js 側で採番します。
   *
   * @param {string} type
   * @param {object} [overrides]
   * @param {object} [overrides.params]
   * @param {Array<string>} [overrides.connect]
   * @param {{x:number, y:number}} [overrides.position]
   * @param {boolean} [overrides.locked]
   * @returns {object}
   */
  createDraft(type, overrides = {}) {
    const definition = this._getOrThrow(type);

    return {
      type: definition.type,
      params: {
        ...this.getDefaultParams(type),
        ...(overrides.params ?? {}),
      },
      connect: Array.isArray(overrides.connect)
        ? [...overrides.connect]
        : [],
      position: overrides.position ? { ...overrides.position } : null,
      rotation: normalizeDraftRotation(overrides.rotation),
      locked: Boolean(overrides.locked),
    };
  }

  /**
   * デバッグ用に全定義を配列で返します。
   *
   * @returns {Array<object>}
   */
  toJSON() {
    return this.all();
  }
}

/**
 * アプリ全体で使うシングルトンレジストリです。
 */
export const componentRegistry = new ComponentRegistry();