/**
 * データ検証ユーティリティです。
 *
 * 役割:
 * - components.json の検証
 * - categories.json の検証
 * - checkTypes.json の検証
 * - 問題データの検証
 * - ボード状態の検証
 *
 * 方針:
 * - 検証結果は { ok, errors } 形式で返す。
 * - 必要なら assertValid() で例外に変換する。
 * - エラーメッセージには、できるだけ場所を含める。
 */

/* ==========================================================================
   検証結果ヘルパー
   ========================================================================== */

/**
 * 検証結果を作成します。
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function createValidationResult() {
  return {
    ok: true,
    errors: [],
    warnings: [],
  };
}

/**
 * 検証警告を追加します（ok は変えない）。
 *
 * @param {{ok: boolean, errors: string[], warnings?: string[]}} result
 * @param {string} message
 */
export function addValidationWarning(result, message) {
  if (!Array.isArray(result.warnings)) result.warnings = [];
  result.warnings.push(message);
}

/**
 * 検証エラーを追加します。
 *
 * @param {{ok: boolean, errors: string[]}} result
 * @param {string} message
 */
export function addValidationError(result, message) {
  result.ok = false;
  result.errors.push(message);
}

/**
 * 複数の検証結果を統合します。
 *
 * @param {...{ok: boolean, errors: string[]}} results
 * @returns {{ok: boolean, errors: string[]}}
 */
export function mergeValidationResults(...results) {
  const merged = createValidationResult();

  for (const result of results) {
    if (!result) {
      continue;
    }

    if (!result.ok) {
      merged.ok = false;
    }

    merged.errors.push(...result.errors);
    if (Array.isArray(result.warnings)) merged.warnings.push(...result.warnings);
  }

  return merged;
}

/**
 * 検証結果が失敗なら例外を投げます。
 *
 * @param {{ok: boolean, errors: string[]}} result
 * @param {string} label
 */
export function assertValid(result, label) {
  if (result.ok) {
    return;
  }

  const details = result.errors.map((error) => `- ${error}`).join("\n");

  throw new Error(`${label} の検証に失敗しました。\n${details}`);
}

/* ==========================================================================
   型判定ヘルパー
   ========================================================================== */

/**
 * プレーンオブジェクトかどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 空でない文字列かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 有限数値かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 整数かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * 空でない文字列の配列かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

/**
 * 真偽値かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBoolean(value) {
  return typeof value === "boolean";
}

/* ==========================================================================
   部品カタログ検証
   ========================================================================== */

/**
 * 部品カタログを検証します。
 *
 * @param {object} data components.json 全体
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateComponentCatalog(data) {
  const result = createValidationResult();

  if (!isPlainObject(data)) {
    addValidationError(result, "components.json はオブジェクトである必要があります。");
    return result;
  }

  if (data.version !== undefined && !isFiniteNumber(data.version)) {
    addValidationError(result, "components.json の version は数値である必要があります。");
  }

  if (!Array.isArray(data.components)) {
    addValidationError(result, "components.json には components 配列が必要です。");
    return result;
  }

  const seenTypes = new Set();

  data.components.forEach((component, index) => {
    validateComponentDefinition(component, index, result, seenTypes);
  });

  return result;
}

/**
 * 部品定義を1件検証します。
 *
 * @param {object} component
 * @param {number} index
 * @param {{ok: boolean, errors: string[]}} result
 * @param {Set<string>} seenTypes
 */
function validateComponentDefinition(component, index, result, seenTypes) {
  const path = `components[${index}]`;

  if (!isPlainObject(component)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(component.type)) {
    addValidationError(result, `${path}.type は空でない文字列である必要があります。`);
  } else {
    if (seenTypes.has(component.type)) {
      addValidationError(result, `${path}.type が重複しています: ${component.type}`);
    } else {
      seenTypes.add(component.type);
    }
  }

  if (!isNonEmptyString(component.nameJa)) {
    addValidationError(result, `${path}.nameJa は空でない文字列である必要があります。`);
  }

  if (!Array.isArray(component.category) || component.category.length === 0) {
    addValidationError(result, `${path}.category は配列であり、少なくとも1要素必要です。`);
  } else {
    component.category.forEach((item, categoryIndex) => {
      if (!isNonEmptyString(item)) {
        addValidationError(
          result,
          `${path}.category[${categoryIndex}] は空でない文字列である必要があります。`
        );
      }
    });
  }

  if (!isInteger(component.pinCount) || component.pinCount < 0) {
    addValidationError(result, `${path}.pinCount は 0 以上の整数である必要があります。`);
  }

  if (component.pinNames !== undefined) {
    if (!Array.isArray(component.pinNames)) {
      addValidationError(result, `${path}.pinNames は配列である必要があります。`);
    } else if (
      isInteger(component.pinCount) &&
      component.pinNames.length !== component.pinCount
    ) {
      addValidationError(
        result,
        `${path}.pinNames の要素数は pinCount と一致する必要があります。`
      );
    }

    component.pinNames.forEach((pinName, pinIndex) => {
      if (!isNonEmptyString(pinName)) {
        addValidationError(
          result,
          `${path}.pinNames[${pinIndex}] は空でない文字列である必要があります。`
        );
      }
    });
  }

  if (component.symbol !== undefined && !isNonEmptyString(component.symbol)) {
    addValidationError(result, `${path}.symbol は文字列である必要があります。`);
  }

  if (component.params !== undefined) {
    if (!Array.isArray(component.params)) {
      addValidationError(result, `${path}.params は配列である必要があります。`);
    } else {
      component.params.forEach((param, paramIndex) => {
        validateComponentParam(param, `${path}.params[${paramIndex}]`, result);
      });
    }
  }

  if (component.simulation !== undefined) {
    if (!isPlainObject(component.simulation)) {
      addValidationError(result, `${path}.simulation はオブジェクトである必要があります。`);
    } else if (
      component.simulation.model !== undefined &&
      !isNonEmptyString(component.simulation.model)
    ) {
      addValidationError(
        result,
        `${path}.simulation.model は文字列である必要があります。`
      );
    }
  }

  if (component.ui !== undefined && !isPlainObject(component.ui)) {
    addValidationError(result, `${path}.ui はオブジェクトである必要があります。`);
  }
}

/**
 * 部品パラメータ定義を検証します。
 *
 * @param {object} param
 * @param {string} path
 * @param {{ok: boolean, errors: string[]}} result
 */
function validateComponentParam(param, path, result) {
  if (!isPlainObject(param)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(param.key)) {
    addValidationError(result, `${path}.key は空でない文字列である必要があります。`);
  }

  if (param.labelJa !== undefined && !isNonEmptyString(param.labelJa)) {
    addValidationError(result, `${path}.labelJa は文字列である必要があります。`);
  }

  if (param.unit !== undefined && typeof param.unit !== "string") {
    addValidationError(result, `${path}.unit は文字列である必要があります。`);
  }

  if (param.default !== undefined) {
    if (
      !isFiniteNumber(param.default) &&
      !isNonEmptyString(param.default) &&
      !isBoolean(param.default)
    ) {
      addValidationError(
        result,
        `${path}.default は数値、文字列、真偽値のいずれかである必要があります。`
      );
    }
  }

  if (param.min !== undefined && !isFiniteNumber(param.min)) {
    addValidationError(result, `${path}.min は数値である必要があります。`);
  }

  if (param.max !== undefined && !isFiniteNumber(param.max)) {
    addValidationError(result, `${path}.max は数値である必要があります。`);
  }

  if (
    isFiniteNumber(param.min) &&
    isFiniteNumber(param.max) &&
    param.min > param.max
  ) {
    addValidationError(result, `${path}.min は max 以下である必要があります。`);
  }
}

/* ==========================================================================
   カテゴリカタログ検証
   ========================================================================== */

/**
 * カテゴリカタログを検証します。
 *
 * @param {object} data categories.json 全体
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCategoryCatalog(data) {
  const result = createValidationResult();

  if (!isPlainObject(data)) {
    addValidationError(result, "categories.json はオブジェクトである必要があります。");
    return result;
  }

  if (data.version !== undefined && !isFiniteNumber(data.version)) {
    addValidationError(result, "categories.json の version は数値である必要があります。");
  }

  if (!Array.isArray(data.categories)) {
    addValidationError(result, "categories.json には categories 配列が必要です。");
    return result;
  }

  const seenIds = new Set();

  data.categories.forEach((category, index) => {
    validateCategoryDefinition(category, index, result, seenIds);
  });

  return result;
}

/**
 * カテゴリ定義を1件検証します。
 *
 * @param {object} category
 * @param {number} index
 * @param {{ok: boolean, errors: string[]}} result
 * @param {Set<string>} seenIds
 */
function validateCategoryDefinition(category, index, result, seenIds) {
  const path = `categories[${index}]`;

  if (!isPlainObject(category)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(category.id)) {
    addValidationError(result, `${path}.id は空でない文字列である必要があります。`);
  } else {
    if (seenIds.has(category.id)) {
      addValidationError(result, `${path}.id が重複しています: ${category.id}`);
    } else {
      seenIds.add(category.id);
    }
  }

  if (!isNonEmptyString(category.nameJa)) {
    addValidationError(result, `${path}.nameJa は空でない文字列である必要があります。`);
  }

  if (category.problemDir !== undefined && !isNonEmptyString(category.problemDir)) {
    addValidationError(result, `${path}.problemDir は文字列である必要があります。`);
  }

  if (category.levelModule !== undefined && !isNonEmptyString(category.levelModule)) {
    addValidationError(result, `${path}.levelModule は文字列である必要があります。`);
  }

  if (category.requiredSimulations !== undefined) {
    if (!isStringArray(category.requiredSimulations)) {
      addValidationError(
        result,
        `${path}.requiredSimulations は文字列配列である必要があります。`
      );
    }
  }

  if (category.plots !== undefined) {
    if (!isStringArray(category.plots)) {
      addValidationError(result, `${path}.plots は文字列配列である必要があります。`);
    }
  }
}

/* ==========================================================================
   チェック種別カタログ検証
   ========================================================================== */

/**
 * チェック種別カタログを検証します。
 *
 * @param {object} data checkTypes.json 全体
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCheckTypeCatalog(data) {
  const result = createValidationResult();

  if (!isPlainObject(data)) {
    addValidationError(result, "checkTypes.json はオブジェクトである必要があります。");
    return result;
  }

  if (data.version !== undefined && !isFiniteNumber(data.version)) {
    addValidationError(result, "checkTypes.json の version は数値である必要があります。");
  }

  if (!Array.isArray(data.checkTypes)) {
    addValidationError(result, "checkTypes.json には checkTypes 配列が必要です。");
    return result;
  }

  const seenTypes = new Set();

  data.checkTypes.forEach((checkType, index) => {
    validateCheckTypeDefinition(checkType, index, result, seenTypes);
  });

  return result;
}

/**
 * チェック種別定義を1件検証します。
 *
 * @param {object} checkType
 * @param {number} index
 * @param {{ok: boolean, errors: string[]}} result
 * @param {Set<string>} seenTypes
 */
function validateCheckTypeDefinition(checkType, index, result, seenTypes) {
  const path = `checkTypes[${index}]`;

  if (!isPlainObject(checkType)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(checkType.type)) {
    addValidationError(result, `${path}.type は空でない文字列である必要があります。`);
  } else {
    if (seenTypes.has(checkType.type)) {
      addValidationError(result, `${path}.type が重複しています: ${checkType.type}`);
    } else {
      seenTypes.add(checkType.type);
    }
  }

  if (checkType.requiredSim !== undefined && !isNonEmptyString(checkType.requiredSim)) {
    addValidationError(result, `${path}.requiredSim は文字列である必要があります。`);
  }

  if (!Array.isArray(checkType.fields)) {
    addValidationError(result, `${path}.fields は配列である必要があります。`);
  } else {
    checkType.fields.forEach((field, fieldIndex) => {
      if (!isNonEmptyString(field)) {
        addValidationError(
          result,
          `${path}.fields[${fieldIndex}] は空でない文字列である必要があります。`
        );
      }
    });
  }

  if (checkType.required !== undefined && !isStringArray(checkType.required)) {
    addValidationError(result, `${path}.required は文字列配列である必要があります（"a|b" はどちらか一方）。`);
  }

  if (checkType.description !== undefined && !isNonEmptyString(checkType.description)) {
    addValidationError(result, `${path}.description は文字列である必要があります。`);
  }
}

/* ==========================================================================
   問題データ検証
   ========================================================================== */

/**
 * 問題データを検証します。
 *
 * @param {object} problem 問題JSON
 * @param {object} [options]
 * @param {Set<string>} [options.knownComponentTypes] 使用可能な部品種別
 * @param {Set<string>} [options.knownCheckTypes] 使用可能なチェック種別
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProblem(problem, options = {}) {
  const result = createValidationResult();

  if (!isPlainObject(problem)) {
    addValidationError(result, "問題データはオブジェクトである必要があります。");
    return result;
  }

  if (!isNonEmptyString(problem.id)) {
    addValidationError(result, "problem.id は空でない文字列である必要があります。");
  }

  if (!isNonEmptyString(problem.category)) {
    addValidationError(result, "problem.category は空でない文字列である必要があります。");
  }

  if (!isNonEmptyString(problem.title)) {
    addValidationError(result, "problem.title は空でない文字列である必要があります。");
  }

  if (!isNonEmptyString(problem.statement)) {
    addValidationError(result, "problem.statement は空でない文字列である必要があります。");
  }

  if (problem.difficulty !== undefined) {
    if (!isInteger(problem.difficulty) || problem.difficulty < 0 || problem.difficulty > 5) {
      addValidationError(result, "problem.difficulty は 0〜5 の整数である必要があります。");
    }
  }

  for (const key of ["prerequisite", "prerequisites"]) {
    const value = problem[key];
    if (value === undefined || value === null) continue;
    if (!isNonEmptyString(value) && !isStringArray(value)) {
      addValidationError(
        result,
        `problem.${key} は文字列、文字列配列、null のいずれかである必要があります。`
      );
    }
  }

  validateJudge(problem.judge, result);

  if (problem.simulation !== undefined) {
    validateSimulationSettings(problem.simulation, result);
  }

  if (problem.learningGoal !== undefined && !isNonEmptyString(problem.learningGoal)) {
    addValidationError(result, "problem.learningGoal は文字列である必要があります。");
  }

  if (problem.verifyNote !== undefined && !isNonEmptyString(problem.verifyNote)) {
    addValidationError(result, "problem.verifyNote は空でない文字列である必要があります。");
  }

  validateHints(problem, result);
  validateExplanation(problem.explanation, result);
  const questionMap = validateQuestions(problem.questions, result);
  validateReferenceAnswers(problem, questionMap, result);

  if (problem.availableComponents !== undefined) {
    validateAvailableComponents(problem.availableComponents, result, options);
  }

  if (problem.fixedComponents !== undefined) {
    validateProblemComponentList(
      problem.fixedComponents,
      "problem.fixedComponents",
      result,
      options
    );
  }

  if (!Array.isArray(problem.checks)) {
    addValidationError(result, "problem.checks は配列である必要があります。");
  } else if (problem.checks.length === 0) {
    addValidationError(result, "problem.checks には少なくとも1つの判定が必要です。");
  } else {
    const componentTypeById = new Map();
    for (const list of [problem.fixedComponents, problem.referenceSolution]) {
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (isPlainObject(c) && isNonEmptyString(c.id)) componentTypeById.set(c.id, c.type);
      }
    }
    const fixedNets = new Set();
    for (const c of Array.isArray(problem.fixedComponents) ? problem.fixedComponents : []) {
      for (const net of Array.isArray(c?.connect) ? c.connect : []) {
        if (isNonEmptyString(net)) fixedNets.add(net);
      }
    }
    problem.checks.forEach((check, index) => {
      validateProblemCheck(check, index, result, {
        ...options,
        questionMap,
        componentTypeById,
        fixedNets,
      });
    });
  }

  if (problem.referenceSolution !== undefined) {
    validateProblemComponentList(
      problem.referenceSolution,
      "problem.referenceSolution",
      result,
      options
    );
  }

  if (problem.ui !== undefined) {
    if (!isPlainObject(problem.ui)) {
      addValidationError(result, "problem.ui はオブジェクトである必要があります。");
    } else if (problem.ui.plots !== undefined && !isStringArray(problem.ui.plots)) {
      addValidationError(result, "problem.ui.plots は文字列配列である必要があります。");
    }
  }

  return result;
}

/**
 * 問題内の利用可能部品を検証します。
 *
 * @param {unknown} availableComponents
 * @param {{ok: boolean, errors: string[]}} result
 * @param {object} [options]
 */
function validateAvailableComponents(availableComponents, result, options = {}) {
  if (!Array.isArray(availableComponents)) {
    addValidationError(result, "problem.availableComponents は配列である必要があります。");
    return;
  }

  availableComponents.forEach((item, index) => {
    const path = `problem.availableComponents[${index}]`;

    if (isNonEmptyString(item)) {
      validateKnownComponentType(item, path, result, options);
      return;
    }

    if (!isPlainObject(item)) {
      addValidationError(result, `${path} は文字列またはオブジェクトである必要があります。`);
      return;
    }

    if (!isNonEmptyString(item.type)) {
      addValidationError(result, `${path}.type は空でない文字列である必要があります。`);
    } else {
      validateKnownComponentType(item.type, path, result, options);
    }

    if (item.count !== undefined) {
      if (!isInteger(item.count) || item.count <= 0) {
        addValidationError(result, `${path}.count は正の整数である必要があります。`);
      }
    }
  });
}

/**
 * 問題内の部品リスト（固定素子 / 参照解）を検証します。
 *
 * @param {unknown} components
 * @param {string} label
 * @param {{ok: boolean, errors: string[]}} result
 * @param {object} [options]
 */
function validateProblemComponentList(components, label, result, options = {}) {
  if (!Array.isArray(components)) {
    addValidationError(result, `${label} は配列である必要があります。`);
    return;
  }

  const seenIds = new Set();

  components.forEach((component, index) => {
    const path = `${label}[${index}]`;

    if (!isPlainObject(component)) {
      addValidationError(result, `${path} はオブジェクトである必要があります。`);
      return;
    }

    if (!isNonEmptyString(component.id)) {
      addValidationError(result, `${path}.id は空でない文字列である必要があります。`);
    } else {
      if (seenIds.has(component.id)) {
        addValidationError(result, `${path}.id が重複しています: ${component.id}`);
      } else {
        seenIds.add(component.id);
      }
    }

    if (!isNonEmptyString(component.type)) {
      addValidationError(result, `${path}.type は空でない文字列である必要があります。`);
    } else {
      validateKnownComponentType(component.type, path, result, options);
    }

    if (component.params !== undefined && !isPlainObject(component.params)) {
      addValidationError(result, `${path}.params はオブジェクトである必要があります。`);
    }

    if (component.connect !== undefined) {
      if (Array.isArray(component.connect)) {
        const def = getComponentDef(options, component.type);
        if (def && Array.isArray(def.pinNames) && def.pinNames.length > 0 &&
            component.connect.length !== def.pinNames.length) {
          addValidationError(
            result,
            `${path}.connect の要素数 ${component.connect.length} が ${component.type} のピン数 ${def.pinNames.length}（${def.pinNames.join(", ")} の順）と一致しません。`
          );
        }
        component.connect.forEach((net, netIndex) => {
          if (!isNonEmptyString(net)) {
            addValidationError(
              result,
              `${path}.connect[${netIndex}] は空でない文字列である必要があります。`
            );
          }
        });
      } else if (isPlainObject(component.connect)) {
        Object.entries(component.connect).forEach(([pin, net]) => {
          if (!isNonEmptyString(pin)) {
            addValidationError(result, `${path}.connect のピン名が不正です。`);
          }

          if (!isNonEmptyString(net)) {
            addValidationError(result, `${path}.connect.${pin} は文字列である必要があります。`);
          }
        });
      } else {
        addValidationError(
          result,
          `${path}.connect は配列またはオブジェクトである必要があります。`
        );
      }
    }

    if (component.locked !== undefined && !isBoolean(component.locked)) {
      addValidationError(result, `${path}.locked は真偽値である必要があります。`);
    }

    if (component.position !== undefined) {
      validatePosition(component.position, `${path}.position`, result);
    }
  });
}

/**
 * 問題内の判定条件を1件検証します。
 *
 * @param {object} check
 * @param {number} index
 * @param {{ok: boolean, errors: string[]}} result
 * @param {object} [options]
 */
function validateProblemCheck(check, index, result, options = {}) {
  const path = `problem.checks[${index}]`;

  if (!isPlainObject(check)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(check.type)) {
    addValidationError(result, `${path}.type は空でない文字列である必要があります。`);
    return;
  }

  if (options.knownCheckTypes instanceof Set) {
    if (!options.knownCheckTypes.has(check.type)) {
      addValidationError(
        result,
        `${path}.type が未定義のチェック種別です: ${check.type}`
      );
    }
  }

  if (check.expected !== undefined && !isFiniteNumber(check.expected)) {
    addValidationError(result, `${path}.expected は数値である必要があります。`);
  }

  for (const key of [
    "tolerancePct", "toleranceAbs", "gainToleranceDB", "phaseToleranceDeg",
    "timeSec", "fromSec", "toSec", "frequencyHz", "expectedRMS", "gainDB", "phaseDeg",
  ]) {
    if (check[key] !== undefined && !isFiniteNumber(check[key])) {
      addValidationError(result, `${path}.${key} は数値である必要があります。`);
    }
  }

  // checkTypes.json の required（"a|b" はどちらか一方）
  const def = options.checkTypeDefs instanceof Map ? options.checkTypeDefs.get(check.type) : null;
  if (def && Array.isArray(def.required)) {
    for (const req of def.required) {
      const alternatives = String(req).split("|");
      if (!alternatives.some((k) => check[k] !== undefined && check[k] !== null)) {
        addValidationError(
          result,
          `${path}（${check.type}）には ${alternatives.join(" または ")} が必要です。`
        );
      }
    }
  }

  if (check.match !== undefined) {
    const m = check.match;
    if (!isPlainObject(m) || (m.type === undefined && m.nets === undefined && m.pins === undefined)) {
      addValidationError(result, `${path}.match は { type, nets, pins } のいずれかを持つオブジェクトである必要があります。`);
    } else {
      const types = m.type === undefined ? [] : Array.isArray(m.type) ? m.type : [m.type];
      for (const t of types) {
        if (!isNonEmptyString(t)) {
          addValidationError(result, `${path}.match.type は部品種別（文字列または配列）である必要があります。`);
        } else {
          validateKnownComponentType(t, `${path}.match`, result, options);
        }
      }
      if (m.nets !== undefined && (!isStringArray(m.nets) || m.nets.length === 0)) {
        addValidationError(result, `${path}.match.nets は空でない文字列配列である必要があります。`);
      }
      if (m.pins !== undefined) {
        if (!isPlainObject(m.pins) || Object.keys(m.pins).length === 0) {
          addValidationError(result, `${path}.match.pins は { ピン名: ネット名 } である必要があります。`);
        } else if (types.length === 1) {
          const compDef = getComponentDef(options, types[0]);
          for (const pin of Object.keys(m.pins)) {
            if (compDef && Array.isArray(compDef.pinNames) && resolvePinName(compDef.pinNames, pin) < 0) {
              addValidationError(result, `${path}.match.pins のピン名 "${pin}" は ${types[0]} にありません（${compDef.pinNames.join(", ")}）。`);
            }
          }
        }
      }
      if (check.element !== undefined) {
        addValidationWarning(result, `${path}: element と match の両方があります（element が優先され、match は使われません）。`);
      }
    }
  }

  const qmap = options.questionMap instanceof Map ? options.questionMap : new Map();

  if (check.type === "numericAnswer" || check.type === "multipleChoice") {
    const key = check.key ?? check.id;
    if (!isNonEmptyString(key)) {
      addValidationError(result, `${path}.key は空でない文字列である必要があります。`);
    } else if (!qmap.has(key)) {
      addValidationError(
        result,
        `${path}.key "${key}" に対応する questions の項目がありません。`
      );
    } else {
      const q = qmap.get(key);
      const wantKind = check.type === "numericAnswer" ? "numeric" : "choice";
      if (q.kind !== wantKind) {
        addValidationError(
          result,
          `${path}（${check.type}）の key "${key}" は questions では kind="${q.kind}" です（"${wantKind}" が必要）。`
        );
      }
      if (check.type === "multipleChoice") {
        const ans = check.answerIndex ?? check.expected ?? check.answer;
        if (!isInteger(ans) || ans < 0 || (Array.isArray(q.options) && ans >= q.options.length)) {
          addValidationError(
            result,
            `${path}.answerIndex は 0〜${Array.isArray(q.options) ? q.options.length - 1 : "?"} の整数である必要があります。`
          );
        }
      }
    }
    if (check.type === "numericAnswer" && !isFiniteNumber(check.expected)) {
      addValidationError(result, `${path}.expected（数値）が必要です。`);
    }
  }

  if (check.type === "connection") {
    if (check.pins !== undefined) {
      if (!isPlainObject(check.pins) || Object.keys(check.pins).length === 0) {
        addValidationError(result, `${path}.pins は { ピン名: ネット名 } のオブジェクトである必要があります。`);
      } else {
        const matchType =
          isPlainObject(check.match) && isNonEmptyString(check.match.type) ? check.match.type : null;
        const type = options.componentTypeById?.get(check.element) ?? matchType;
        const compDef = type ? getComponentDef(options, type) : null;
        for (const [pin, net] of Object.entries(check.pins)) {
          if (!isNonEmptyString(net)) {
            addValidationError(result, `${path}.pins.${pin} はネット名（文字列）である必要があります。`);
          }
          if (compDef && Array.isArray(compDef.pinNames) && resolvePinName(compDef.pinNames, pin) < 0) {
            addValidationError(
              result,
              `${path}.pins のピン名 "${pin}" は ${type} にありません（${compDef.pinNames.join(", ")}）。`
            );
          }
        }
      }
    } else if (check.nets !== undefined) {
      if (!isStringArray(check.nets) || check.nets.length === 0) {
        addValidationError(result, `${path}.nets は空でない文字列配列である必要があります。`);
      }
      const type =
        options.componentTypeById?.get(check.element) ??
        (isPlainObject(check.match) && isNonEmptyString(check.match.type) ? check.match.type : null);
      if (type && POLARIZED_TYPES.has(type)) {
        addValidationWarning(
          result,
          `${path}: 極性部品 ${check.element}（${type}）の connection が nets 形式です。向きを判定するには pins 形式にしてください。`
        );
      }
    }
  }

  // 判定で参照する部品・ノードが問題内に存在するか（警告）
  if (isNonEmptyString(check.element) && options.componentTypeById instanceof Map &&
      !options.componentTypeById.has(check.element)) {
    addValidationWarning(
      result,
      `${path}.element "${check.element}" が fixedComponents にも referenceSolution にもありません。`
    );
  }
  if (options.fixedNets instanceof Set) {
    for (const key of ["node", "input", "output"]) {
      const net = check[key];
      if (isNonEmptyString(net) && net !== "gnd" && !options.fixedNets.has(net)) {
        addValidationWarning(
          result,
          `${path}.${key} "${net}" に固定部品がありません（プレイヤーがたどり着けるよう TP などを置いてください）。`
        );
      }
    }
  }
}

/** 極性（向き）がある部品種別。connection は pins 形式で判定すべきもの。 */
export const POLARIZED_TYPES = new Set([
  "D", "LED", "ZD", "SD", "TVS", "PD", "D_VC",
  "Q_NPN", "Q_PNP", "M_N", "M_P", "J_N", "PT",
  "OPAMP", "V_DC", "V_PULSE", "I_DC", "SCR", "TRIAC", "U_OPTO", "XFMR",
  "U_WILSON", "U_CASCODE", "DFF",
  "U_NOT", "U_AND", "U_OR", "U_NAND", "U_NOR", "U_XOR",
]);

/** ピン名の略記（runner.js の PIN_ALIASES と同じ） */
const PIN_ALIASES = {
  A: "anode", K: "cathode", C: "collector", B: "base", E: "emitter",
  D: "drain", G: "gate", S: "source", "+": "p", "-": "n",
  "IN+": "in_plus", "IN-": "in_minus", "V+": "v_plus", "V-": "v_minus",
};

/**
 * ピン名（または略記）を pinNames の添字へ解決します。見つからなければ -1。
 */
export function resolvePinName(pinNames, key) {
  const k = String(key);
  let i = pinNames.indexOf(k);
  if (i >= 0) return i;
  i = pinNames.findIndex((n) => n.toLowerCase() === k.toLowerCase());
  if (i >= 0) return i;
  const alias = PIN_ALIASES[k.toUpperCase()];
  return alias ? pinNames.indexOf(alias) : -1;
}

function getComponentDef(options, type) {
  const defs = options?.componentDefs;
  if (defs instanceof Map) return defs.get(type) ?? null;
  return null;
}

const KNOWN_SIM_MODES = new Set(["dc", "ac", "transient", "digital"]);

function validateJudge(judge, result) {
  if (judge === undefined) return;
  const list = Array.isArray(judge) ? judge : [judge];
  if (list.length === 0) {
    addValidationError(result, "problem.judge の配列が空です。");
    return;
  }
  for (const j of list) {
    if (!isNonEmptyString(j)) {
      addValidationError(result, "problem.judge は文字列、または文字列の配列である必要があります。");
    } else if (!KNOWN_SIM_MODES.has(j.trim().toLowerCase())) {
      addValidationError(
        result,
        `problem.judge "${j}" は未知のシミュレーションです（dc / ac / transient / digital）。`
      );
    }
  }
}

function validateSimulationSettings(sim, result) {
  if (!isPlainObject(sim)) {
    addValidationError(result, "problem.simulation はオブジェクトである必要があります。");
    return;
  }
  for (const key of ["tStop", "dt"]) {
    if (sim[key] !== undefined && !(isFiniteNumber(sim[key]) && sim[key] > 0)) {
      addValidationError(result, `problem.simulation.${key} は正の数値である必要があります。`);
    }
  }
  if (sim.frequencies !== undefined) {
    if (
      !Array.isArray(sim.frequencies) ||
      sim.frequencies.length === 0 ||
      !sim.frequencies.every((f) => isFiniteNumber(f) && f > 0)
    ) {
      addValidationError(result, "problem.simulation.frequencies は正の数値の配列である必要があります。");
    }
  }
}

function validateHints(problem, result) {
  if (problem.hint !== undefined && !isNonEmptyString(problem.hint)) {
    addValidationError(result, "problem.hint は文字列である必要があります。");
  }
  if (problem.hints === undefined) {
    addValidationWarning(result, "hints（3段階: 方針 → 使う式 → ほぼ答え）がありません。");
    return;
  }
  if (!Array.isArray(problem.hints)) {
    addValidationError(result, "problem.hints は文字列3つの配列である必要があります。");
    return;
  }
  if (problem.hints.length !== 3) {
    addValidationError(
      result,
      `problem.hints は3要素（方針 → 使う式 → ほぼ答え）である必要があります（現在 ${problem.hints.length} 要素）。`
    );
  }
  problem.hints.forEach((h, i) => {
    if (!isNonEmptyString(h)) {
      addValidationError(result, `problem.hints[${i}] は空でない文字列である必要があります。`);
    }
  });
}

export const EXPLANATION_KEYS = ["solution", "why", "mistakes", "practice", "next"];

function validateExplanation(explanation, result) {
  if (explanation === undefined) {
    addValidationWarning(
      result,
      "explanation（solution / why / mistakes / practice / next）がありません。"
    );
    return;
  }
  if (!isPlainObject(explanation)) {
    addValidationError(
      result,
      "problem.explanation は { solution, why, mistakes, practice, next } のオブジェクトである必要があります。"
    );
    return;
  }
  for (const key of EXPLANATION_KEYS) {
    if (!isNonEmptyString(explanation[key])) {
      addValidationError(result, `problem.explanation.${key} は空でない文字列である必要があります。`);
    }
  }
  for (const key of Object.keys(explanation)) {
    if (!EXPLANATION_KEYS.includes(key)) {
      addValidationWarning(result, `problem.explanation.${key} は未知の項目です（表示されない可能性があります）。`);
    }
  }
}

/**
 * questions を検証し、key → 定義 の Map を返します。
 */
function validateQuestions(questions, result) {
  const map = new Map();
  if (questions === undefined) return map;
  if (!Array.isArray(questions)) {
    addValidationError(result, "problem.questions は配列である必要があります。");
    return map;
  }
  questions.forEach((q, i) => {
    const path = `problem.questions[${i}]`;
    if (!isPlainObject(q)) {
      addValidationError(result, `${path} はオブジェクトである必要があります。`);
      return;
    }
    if (!isNonEmptyString(q.key)) {
      addValidationError(result, `${path}.key は空でない文字列である必要があります。`);
    } else if (map.has(q.key)) {
      addValidationError(result, `${path}.key "${q.key}" が重複しています。`);
    } else {
      map.set(q.key, q);
    }
    if (q.kind !== "numeric" && q.kind !== "choice") {
      addValidationError(result, `${path}.kind は "numeric" または "choice" である必要があります。`);
    }
    if (!isNonEmptyString(q.prompt)) {
      addValidationError(result, `${path}.prompt は空でない文字列である必要があります。`);
    }
    if (q.kind === "numeric" && q.unit !== undefined && typeof q.unit !== "string") {
      addValidationError(result, `${path}.unit は文字列である必要があります。`);
    }
    if (q.kind === "choice") {
      if (!Array.isArray(q.options) || q.options.length < 2 || !q.options.every(isNonEmptyString)) {
        addValidationError(result, `${path}.options は空でない文字列2つ以上の配列である必要があります。`);
      }
    }
  });
  return map;
}

function validateReferenceAnswers(problem, questionMap, result) {
  const ra = problem.referenceAnswers;
  if (ra === undefined) {
    if (questionMap.size > 0) {
      addValidationError(result, "questions があるのに referenceAnswers がありません。");
    }
    return;
  }
  if (!isPlainObject(ra)) {
    addValidationError(result, "problem.referenceAnswers は { key: 値 } のオブジェクトである必要があります。");
    return;
  }
  for (const [key, value] of Object.entries(ra)) {
    const q = questionMap.get(key);
    if (!q) {
      addValidationError(result, `problem.referenceAnswers.${key} に対応する questions の項目がありません。`);
      continue;
    }
    if (q.kind === "numeric" && !isFiniteNumber(value)) {
      addValidationError(result, `problem.referenceAnswers.${key} は数値である必要があります。`);
    }
    if (q.kind === "choice" && (!isInteger(value) || value < 0 ||
        (Array.isArray(q.options) && value >= q.options.length))) {
      addValidationError(result, `problem.referenceAnswers.${key} は選択肢番号（0 始まりの整数）である必要があります。`);
    }
  }
  for (const key of questionMap.keys()) {
    if (!(key in ra)) {
      addValidationError(result, `problem.referenceAnswers に ${key} の正答がありません。`);
    }
  }
}

/**
 * 部品種別が既知セットに含まれるかを検証します。
 *
 * @param {string} type
 * @param {string} path
 * @param {{ok: boolean, errors: string[]}} result
 * @param {object} [options]
 */
function validateKnownComponentType(type, path, result, options = {}) {
  if (!(options.knownComponentTypes instanceof Set)) {
    return;
  }

  if (!options.knownComponentTypes.has(type)) {
    addValidationError(result, `${path}.type が未定義の部品種別です: ${type}`);
  }
}

/* ==========================================================================
   ボード状態検証
   ========================================================================== */

/**
 * ボード状態を検証します。
 *
 * @param {object} board
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateBoard(board) {
  const result = createValidationResult();

  if (!isPlainObject(board)) {
    addValidationError(result, "board はオブジェクトである必要があります。");
    return result;
  }

  if (!Array.isArray(board.components)) {
    addValidationError(result, "board.components は配列である必要があります。");
    return result;
  }

  if (!Array.isArray(board.wires)) {
    addValidationError(result, "board.wires は配列である必要があります。`");
    return result;
  }

  if (board.nodes !== undefined && !Array.isArray(board.nodes)) {
    addValidationError(result, "board.nodes は配列である必要があります。");
  }

  const componentIds = new Set();

  board.components.forEach((component, index) => {
    validateBoardComponent(component, index, result, componentIds);
  });

  const wireIds = new Set();

  board.wires.forEach((wire, index) => {
    validateBoardWire(wire, index, result, wireIds, componentIds);
  });

  return result;
}

/**
 * ボード上の部品を1件検証します。
 *
 * @param {object} component
 * @param {number} index
 * @param {{ok: boolean, errors: string[]}} result
 * @param {Set<string>} componentIds
 */
function validateBoardComponent(component, index, result, componentIds) {
  const path = `board.components[${index}]`;

  if (!isPlainObject(component)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(component.id)) {
    addValidationError(result, `${path}.id は空でない文字列である必要があります。`);
  } else {
    if (componentIds.has(component.id)) {
      addValidationError(result, `${path}.id が重複しています: ${component.id}`);
    } else {
      componentIds.add(component.id);
    }
  }

  if (!isNonEmptyString(component.type)) {
    addValidationError(result, `${path}.type は空でない文字列である必要があります。`);
  }

  if (component.params !== undefined && !isPlainObject(component.params)) {
    addValidationError(result, `${path}.params はオブジェクトである必要があります。`);
  }

  // 未配線ピンは "" または null（シミュレータ側で「どこにもつながらないネット」として扱う）
  if (
    component.connect !== undefined &&
    !(
      Array.isArray(component.connect) &&
      component.connect.every((item) => item === null || typeof item === "string")
    )
  ) {
    addValidationError(result, `${path}.connect は文字列配列である必要があります（未配線ピンは ""）。`);
  }

  if (component.position !== undefined) {
    validatePosition(component.position, `${path}.position`, result);
  }

  if (component.locked !== undefined && !isBoolean(component.locked)) {
    addValidationError(result, `${path}.locked は真偽値である必要があります。`);
  }

  if (
    component.rotation !== undefined &&
    !isBoardRotation(component.rotation)
  ) {
    addValidationError(
      result,
      `${path}.rotation は 0 / 90 / 180 / 270 の数値である必要があります。`
    );
  }
}

/**
 * ボード部品の回転角として妥当かどうかを判定します。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isBoardRotation(value) {
  return (
    isFiniteNumber(value) &&
    [0, 90, 180, 270].includes(value)
  );
}

/**
 * ボード上のワイヤを1件検証します。
 *
 * @param {object} wire
 * @param {number} index
 * @param {{ok: boolean, errors: string[]}} result
 * @param {Set<string>} wireIds
 * @param {Set<string>} componentIds
 */
function validateBoardWire(wire, index, result, wireIds, componentIds) {
  const path = `board.wires[${index}]`;

  if (!isPlainObject(wire)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(wire.id)) {
    addValidationError(result, `${path}.id は空でない文字列である必要があります。`);
  } else {
    if (wireIds.has(wire.id)) {
      addValidationError(result, `${path}.id が重複しています: ${wire.id}`);
    } else {
      wireIds.add(wire.id);
    }
  }

  validateWireEndpoint(wire.from, `${path}.from`, result, componentIds);
  validateWireEndpoint(wire.to, `${path}.to`, result, componentIds);

  if (wire.points !== undefined) {
    if (!Array.isArray(wire.points)) {
      addValidationError(result, `${path}.points は配列である必要があります。`);
    } else {
      wire.points.forEach((point, pointIndex) => {
        validatePosition(point, `${path}.points[${pointIndex}]`, result);
      });
    }
  }
}

/**
 * ワイヤ端点を検証します。
 *
 * @param {unknown} endpoint
 * @param {string} path
 * @param {{ok: boolean, errors: string[]}} result
 * @param {Set<string>} componentIds
 */
function validateWireEndpoint(endpoint, path, result, componentIds) {
  if (endpoint === undefined || endpoint === null) {
    return;
  }

  if (!isPlainObject(endpoint)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isNonEmptyString(endpoint.componentId)) {
    addValidationError(result, `${path}.componentId は空でない文字列である必要があります。`);
  } else if (componentIds.size > 0 && !componentIds.has(endpoint.componentId)) {
    addValidationError(
      result,
      `${path}.componentId がボード上に存在しません: ${endpoint.componentId}`
    );
  }

  if (endpoint.pin !== undefined && !isNonEmptyString(endpoint.pin)) {
    addValidationError(result, `${path}.pin は文字列である必要があります。`);
  }
}

/**
 * 位置を検証します。
 *
 * @param {unknown} position
 * @param {string} path
 * @param {{ok: boolean, errors: string[]}} result
 */
function validatePosition(position, path, result) {
  if (!isPlainObject(position)) {
    addValidationError(result, `${path} はオブジェクトである必要があります。`);
    return;
  }

  if (!isFiniteNumber(position.x)) {
    addValidationError(result, `${path}.x は数値である必要があります。`);
  }

  if (!isFiniteNumber(position.y)) {
    addValidationError(result, `${path}.y は数値である必要があります。`);
  }
}