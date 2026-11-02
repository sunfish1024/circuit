/**
 * データ読み込みユーティリティです。
 *
 * 役割:
 * - components.json の読み込み
 * - categories.json の読み込み
 * - checkTypes.json の読み込み
 * - 問題JSONの読み込み
 * - カテゴリ別問題一覧（index.json）の読み込み
 * - 読み込みエラー時の分かりやすいメッセージ変換
 *
 * 方針:
 * - ローカル検証は行わず、ローカルストレージなどには触れない。
 * - 状態更新は行わず、読み込み結果を返すだけにする。
 * - 状態への反映は src/ui/app.js や状態管理側で行う。
 */

import { CONFIG } from "../config.js";
import {
  assertValid,
  isNonEmptyString,
  isPlainObject,
  validateCategoryCatalog,
  validateCheckTypeCatalog,
  validateComponentCatalog,
  validateProblem,
} from "./validation.js";

/**
 * 既定のフェッチタイムアウト。ミリ秒。
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * 指定ミリ秒だけ待機します。
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * タイムアウト付きで fetch します。
 *
 * @param {string} url
 * @param {RequestInit} fetchOptions
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, fetchOptions = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (typeof AbortController === "undefined") {
    return fetch(url, fetchOptions);
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * リトライすべきエラーかどうかを判定します。
 *
 * @param {Error & {status?: number, noRetry?: boolean}} error
 * @returns {boolean}
 */
function isRetriableError(error) {
  if (!error) {
    return false;
  }

  if (error.noRetry) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  if (Number.isInteger(error.status)) {
    return error.status >= 500;
  }

  return true;
}

/**
 * 読み込みエラーを、原因推測しやすいメッセージへ変換します。
 *
 * @param {string} url
 * @param {unknown} cause
 * @param {number} timeoutMs
 * @returns {Error}
 */
function createFetchError(url, cause, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const baseMessage =
    cause?.name === "AbortError"
      ? `タイムアウトしました（${timeoutMs}ms）`
      : cause?.message ?? "読み込みに失敗しました";

  const statusText = cause?.status ? ` status=${cause.status}` : "";

  const fileProtocolHint =
    typeof location !== "undefined" && location.protocol === "file:"
      ? " file:// ではなく、ローカルHTTPサーバーで開いてください。"
      : "";

  const error = new Error(
    `${url} の読み込みに失敗しました。${baseMessage}.${statusText}.${fileProtocolHint}`
  );

  error.url = url;
  error.status = cause?.status;
  error.cause = cause;

  return error;
}

/**
 * JSONファイルを読み込みます。
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.retryCount]
 * @param {number} [options.retryDelayMs]
 * @param {number} [options.timeoutMs]
 * @param {RequestCache} [options.cache]
 * @param {HeadersInit} [options.headers]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const retryCount = options.retryCount ?? CONFIG.fetch.retryCount ?? 0;
  const retryDelayMs = options.retryDelayMs ?? CONFIG.fetch.retryDelayMs ?? 300;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const fetchOptions = {
    cache: options.cache ?? CONFIG.fetch.cache,
    headers: options.headers,
  };

  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, fetchOptions, timeoutMs);

      if (!response.ok) {
        const httpError = new Error(`HTTP ${response.status} ${response.statusText}`);
        httpError.status = response.status;
        throw httpError;
      }

      const text = await response.text();

      try {
        return JSON.parse(text);
      } catch (parseError) {
        parseError.noRetry = true;
        throw parseError;
      }
    } catch (error) {
      lastError = error;

      if (attempt < retryCount && isRetriableError(error)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      throw createFetchError(url, error, timeoutMs);
    }
  }

  throw createFetchError(url, lastError ?? new Error("不明なエラー"), timeoutMs);
}

/**
 * 部品カタログのURLを返します。
 *
 * @returns {string}
 */
export function getComponentCatalogUrl() {
  return CONFIG.paths.components;
}

/**
 * カテゴリカタログのURLを返します。
 *
 * @returns {string}
 */
export function getCategoryCatalogUrl() {
  return CONFIG.paths.categories;
}

/**
 * チェック種別カタログのURLを返します。
 *
 * @returns {string}
 */
export function getCheckTypeCatalogUrl() {
  return CONFIG.paths.checkTypes;
}

/**
 * 問題ファイルのURLを組み立てます。
 *
 * @param {string} categoryId
 * @param {string} problemId
 * @returns {string}
 */
export function buildProblemUrl(categoryId, problemId) {
  const safeCategoryId = encodeURIComponent(String(categoryId));
  const safeProblemId = encodeURIComponent(String(problemId));

  return `${CONFIG.paths.problemsRoot}/${safeCategoryId}/${safeProblemId}.json`;
}

/**
 * カテゴリ別問題一覧ファイルのURLを組み立てます。
 *
 * @param {string} categoryId
 * @returns {string}
 */
export function buildProblemIndexUrl(categoryId) {
  const safeCategoryId = encodeURIComponent(String(categoryId));

  return `${CONFIG.paths.problemsRoot}/${safeCategoryId}/index.json`;
}

/**
 * 部品カタログを正規化します。
 *
 * @param {object} raw
 * @returns {{version: number, components: Array<object>}}
 */
export function normalizeComponentCatalog(raw) {
  return {
    version: raw?.version ?? 1,
    components: Array.isArray(raw?.components) ? raw.components : [],
  };
}

/**
 * カテゴリカタログを正規化します。
 *
 * @param {object} raw
 * @returns {{version: number, categories: Array<object>}}
 */
export function normalizeCategoryCatalog(raw) {
  return {
    version: raw?.version ?? 1,
    categories: Array.isArray(raw?.categories) ? raw.categories : [],
  };
}

/**
 * チェック種別カタログを正規化します。
 *
 * @param {object} raw
 * @returns {{version: number, checkTypes: Array<object>}}
 */
export function normalizeCheckTypeCatalog(raw) {
  return {
    version: raw?.version ?? 1,
    checkTypes: Array.isArray(raw?.checkTypes) ? raw.checkTypes : [],
  };
}

/**
 * 部品カタログを読み込みます。
 *
 * @param {object} [options]
 * @param {boolean} [options.validate=true]
 * @returns {Promise<{version: number, components: Array<object>}>}
 */
export async function loadComponentCatalog(options = {}) {
  const raw = await fetchJson(CONFIG.paths.components, options);

  if (options.validate !== false) {
    const result = validateComponentCatalog(raw);
    assertValid(result, "components.json");
  }

  return normalizeComponentCatalog(raw);
}

/**
 * カテゴリカタログを読み込みます。
 *
 * @param {object} [options]
 * @param {boolean} [options.validate=true]
 * @returns {Promise<{version: number, categories: Array<object>}>}
 */
export async function loadCategoryCatalog(options = {}) {
  const raw = await fetchJson(CONFIG.paths.categories, options);

  if (options.validate !== false) {
    const result = validateCategoryCatalog(raw);
    assertValid(result, "categories.json");
  }

  return normalizeCategoryCatalog(raw);
}

/**
 * チェック種別カタログを読み込みます。
 *
 * @param {object} [options]
 * @param {boolean} [options.validate=true]
 * @returns {Promise<{version: number, checkTypes: Array<object>}>}
 */
export async function loadCheckTypeCatalog(options = {}) {
  const raw = await fetchJson(CONFIG.paths.checkTypes, options);

  if (options.validate !== false) {
    const result = validateCheckTypeCatalog(raw);
    assertValid(result, "checkTypes.json");
  }

  return normalizeCheckTypeCatalog(raw);
}

/**
 * ゲーム共通データを読み込みます。
 *
 * @param {object} [options]
 * @param {boolean} [options.validate=true]
 * @returns {Promise<{
 *   components: Array<object>,
 *   categories: Array<object>,
 *   checkTypes: Array<object>,
 *   knownComponentTypes: Set<string>,
 *   knownCheckTypes: Set<string>,
 *   raw: {
 *     components: object,
 *     categories: object,
 *     checkTypes: object,
 *   },
 * }>}
 */
export async function loadGameData(options = {}) {
  const [componentCatalog, categoryCatalog, checkTypeCatalog] = await Promise.all([
    loadComponentCatalog(options),
    loadCategoryCatalog(options),
    loadCheckTypeCatalog(options),
  ]);

  const components = componentCatalog.components;
  const categories = categoryCatalog.categories;
  const checkTypes = checkTypeCatalog.checkTypes;

  return {
    components,
    categories,
    checkTypes,

    knownComponentTypes: new Set(components.map((component) => component.type)),
    knownCheckTypes: new Set(checkTypes.map((checkType) => checkType.type)),

    raw: {
      components: componentCatalog,
      categories: categoryCatalog,
      checkTypes: checkTypeCatalog,
    },
  };
}

/**
 * 問題データを正規化します。
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeProblem(raw) {
  const prerequisite = raw?.prerequisite ?? [];

  return {
    ...raw,

    id: raw?.id ?? "",
    category: raw?.category ?? "",
    title: raw?.title ?? "",
    statement: raw?.statement ?? "",

    difficulty: raw?.difficulty ?? 1,

    prerequisites: Array.isArray(prerequisite)
      ? prerequisite
      : isNonEmptyString(prerequisite)
        ? [prerequisite]
        : [],

    availableComponents: Array.isArray(raw?.availableComponents)
      ? raw.availableComponents
      : [],

    fixedComponents: Array.isArray(raw?.fixedComponents)
      ? raw.fixedComponents
      : [],

    checks: Array.isArray(raw?.checks) ? raw.checks : [],

    referenceSolution: Array.isArray(raw?.referenceSolution)
      ? raw.referenceSolution
      : [],

    ui: isPlainObject(raw?.ui) ? raw.ui : {},
  };
}

/**
 * 問題データを読み込みます。
 *
 * @param {string} categoryId
 * @param {string} problemId
 * @param {object} [options]
 * @param {boolean} [options.validate=true]
 * @param {Set<string>} [options.knownComponentTypes]
 * @param {Set<string>} [options.knownCheckTypes]
 * @returns {Promise<object>}
 */
export async function loadProblem(categoryId, problemId, options = {}) {
  const url = buildProblemUrl(categoryId, problemId);
  const raw = await fetchJson(url, options);

  if (options.validate !== false) {
    const result = validateProblem(raw, {
      knownComponentTypes: options.knownComponentTypes,
      knownCheckTypes: options.knownCheckTypes,
    });

    assertValid(result, `問題 ${problemId}`);
  }

  return normalizeProblem(raw);
}

/**
 * 問題一覧の1件を正規化します。
 *
 * @param {string | object} item
 * @returns {object | null}
 */
function normalizeProblemIndexItem(item) {
  if (isNonEmptyString(item)) {
    return {
      id: item,
      title: "",
      difficulty: null,
    };
  }

  if (!isPlainObject(item)) {
    return null;
  }

  const id = item.id ?? item.problemId;

  if (!isNonEmptyString(id)) {
    return null;
  }

  return {
    id,
    title: item.title ?? "",
    difficulty: item.difficulty ?? null,
    category: item.category ?? "",
  };
}

/**
 * カテゴリ別問題一覧を正規化します。
 *
 * @param {object | Array<string | object>} raw
 * @param {string} categoryId
 * @returns {{categoryId: string, problems: Array<object>}}
 */
export function normalizeProblemIndex(raw, categoryId) {
  if (Array.isArray(raw)) {
    return {
      categoryId,
      problems: raw.map(normalizeProblemIndexItem).filter(Boolean),
    };
  }

  if (isPlainObject(raw) && Array.isArray(raw.problems)) {
    return {
      categoryId,
      problems: raw.problems.map(normalizeProblemIndexItem).filter(Boolean),
    };
  }

  throw new Error(
    `問題一覧の形式が不正です。categoryId=${categoryId}。` +
      "配列、または { problems: [...] } 形式である必要があります。"
  );
}

/**
 * カテゴリ別問題一覧を読み込みます。
 *
 * index.json が存在しない場合は空リストを返します。
 *
 * @param {string} categoryId
 * @param {object} [options]
 * @returns {Promise<{categoryId: string, problems: Array<object>, missing?: boolean}>}
 */
export async function loadProblemIndex(categoryId, options = {}) {
  const url = buildProblemIndexUrl(categoryId);

  try {
    const raw = await fetchJson(url, options);
    return normalizeProblemIndex(raw, categoryId);
  } catch (error) {
    if (error?.status === 404) {
      return {
        categoryId,
        problems: [],
        missing: true,
      };
    }

    throw error;
  }
}