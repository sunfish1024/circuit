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
  };
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

  if (problem.prerequisite !== undefined) {
    if (
      problem.prerequisite !== null &&
      !isNonEmptyString(problem.prerequisite) &&
      !isStringArray(problem.prerequisite)
    ) {
      addValidationError(
        result,
        "problem.prerequisite は文字列、文字列配列、null のいずれかである必要があります。"
      );
    }
  }

  if (problem.judge !== undefined && !isNonEmptyString(problem.judge)) {
    addValidationError(result, "problem.judge は文字列である必要があります。");
  }

  if (problem.learningGoal !== undefined && !isNonEmptyString(problem.learningGoal)) {
    addValidationError(result, "problem.learningGoal は文字列である必要があります。");
  }

  if (problem.hint !== undefined && !isNonEmptyString(problem.hint)) {
    addValidationError(result, "problem.hint は文字列である必要があります。");
  }

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
    problem.checks.forEach((check, index) => {
      validateProblemCheck(check, index, result, options);
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

  if (check.tolerancePct !== undefined && !isFiniteNumber(check.tolerancePct)) {
    addValidationError(result, `${path}.tolerancePct は数値である必要があります。`);
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

  if (component.connect !== undefined && !isStringArray(component.connect)) {
    addValidationError(result, `${path}.connect は文字列配列である必要があります。`);
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