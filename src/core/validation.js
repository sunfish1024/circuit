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
  validateLayout(problem.layout, problem.fixedComponents, result);
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
    const fixedTypesByNet = new Map(); // デジタル判定用: ネット → 固定部品の種別
    for (const c of Array.isArray(problem.fixedComponents) ? problem.fixedComponents : []) {
      for (const net of Array.isArray(c?.connect) ? c.connect : []) {
        if (isNonEmptyString(net)) {
          fixedNets.add(net);
          if (!fixedTypesByNet.has(net)) fixedTypesByNet.set(net, new Set());
          fixedTypesByNet.get(net).add(c.type);
        }
      }
    }
    const fixedIds = new Set(
      (Array.isArray(problem.fixedComponents) ? problem.fixedComponents : [])
        .filter((c) => isPlainObject(c) && isNonEmptyString(c.id))
        .map((c) => c.id)
    );
    problem.checks.forEach((check, index) => {
      validateProblemCheck(check, index, result, {
        ...options,
        questionMap,
        fixedIds,
        componentTypeById,
        fixedNets,
        fixedTypesByNet,
        judge: problem.judge,
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
          // OPAMP の電源ピン（v_plus / v_minus = 3, 4 番目）は "" で未配線にできる
          // （未配線なら params.Vpos / Vneg がレールになる。src/sim/dc.js 参照）
          if (component.type === "OPAMP" && (netIndex === 3 || netIndex === 4) && net === "") return;
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

  if (check.type === "truthTable" || check.type === "sequence" || check.type === "componentCount") {
    validateDigitalCheck(check, path, result, options);
  }

  validateAnalogCheckOptions(check, path, result, options);

  // 判定で参照する部品・ノードが問題内に存在するか（警告）
  if (isNonEmptyString(check.element) && options.componentTypeById instanceof Map &&
      !options.componentTypeById.has(check.element)) {
    addValidationWarning(
      result,
      `${path}.element "${check.element}" が fixedComponents にも referenceSolution にもありません。`
    );
  }
  if (options.fixedNets instanceof Set) {
    for (const key of ["node", "input", "output", "nodeRef", "inputRef", "outputRef"]) {
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

/* ---- アナログ判定の追加オプション（分野C で追加）の検証 ---- */

const TRANSIENT_MEASURES = new Set(["max", "min", "pp", "average", "rms", "acRms", "duty", "power", "powerFactor"]);
const OPERATING_REGIONS = new Set([
  "off", "active", "saturation", "triode", "on", "forward", "breakdown", "linear", "satHigh", "satLow",
]);
const AC_SOURCE_PARAMS = { V_AC: new Set(["Vpk", "phaseDeg"]), I_AC: new Set(["Ipk", "phaseDeg"]) };

/**
 * sources（AC 判定の電源置き換え）、nodeRef/inputRef/outputRef、acImpedance、
 * operatingRegion、transientMeasure の書式を確認します。
 */
function validateAnalogCheckOptions(check, path, result, options) {
  for (const key of ["nodeRef", "inputRef", "outputRef"]) {
    if (check[key] !== undefined && !isNonEmptyString(check[key])) {
      addValidationError(result, `${path}.${key} はネット名（文字列）である必要があります。`);
    }
  }
  if (check.sources !== undefined) {
    if (!["acVoltage", "acGaindB", "bodePoint"].includes(check.type)) {
      addValidationError(result, `${path}.sources は acVoltage / acGaindB / bodePoint でだけ使えます。`);
    } else if (!isPlainObject(check.sources) || Object.keys(check.sources).length === 0) {
      addValidationError(result, `${path}.sources は { 電源ID: { Vpk, phaseDeg } } のオブジェクトである必要があります。`);
    } else {
      for (const [id, params] of Object.entries(check.sources)) {
        const type = options.componentTypeById instanceof Map ? options.componentTypeById.get(id) : undefined;
        if (options.fixedIds instanceof Set && !options.fixedIds.has(id)) {
          addValidationError(result, `${path}.sources の "${id}" が fixedComponents にありません（置き換える電源は固定部品にしてください。プレイヤーが置く部品は ID が変わります）。`);
          continue;
        }
        if (type !== undefined && !AC_SOURCE_PARAMS[type]) {
          addValidationError(result, `${path}.sources の "${id}"（${type}）は V_AC / I_AC ではありません（DC 動作点が変わる置き換えはできません）。`);
          continue;
        }
        if (!isPlainObject(params) || Object.keys(params).length === 0) {
          addValidationError(result, `${path}.sources.${id} は { Vpk, phaseDeg } などのオブジェクトである必要があります。`);
          continue;
        }
        for (const [k, v] of Object.entries(params)) {
          const allowed = type ? AC_SOURCE_PARAMS[type] : new Set(["Vpk", "Ipk", "phaseDeg"]);
          if (!allowed.has(k)) addValidationError(result, `${path}.sources.${id}.${k} は置き換えられません（${[...allowed].join(", ")}）。`);
          else if (!isFiniteNumber(v)) addValidationError(result, `${path}.sources.${id}.${k} は数値である必要があります。`);
        }
      }
    }
  }
  if (check.type === "acImpedance") {
    if (check.exclude !== undefined && !isStringArray(check.exclude)) {
      addValidationError(result, `${path}.exclude は部品IDの文字列配列である必要があります。`);
    } else if (Array.isArray(check.exclude) && options.fixedIds instanceof Set) {
      for (const id of check.exclude) {
        if (!options.fixedIds.has(id)) {
          addValidationWarning(result, `${path}.exclude の "${id}" が fixedComponents にありません（取り除く部品は固定部品にしてください。プレイヤーが置く部品は ID が変わります）。`);
        }
      }
    }
    if (check.quantity !== undefined && !["magnitude", "real", "imag", "phase"].includes(check.quantity)) {
      addValidationError(result, `${path}.quantity は magnitude / real / imag / phase のどれかです。`);
    }
  }
  if (check.type === "operatingRegion") {
    const list = Array.isArray(check.region) ? check.region : [check.region];
    if (list.length === 0 || !list.every((r) => OPERATING_REGIONS.has(r))) {
      addValidationError(result, `${path}.region は ${[...OPERATING_REGIONS].join(" / ")} のどれか（または配列）です。`);
    }
  }
  if (check.type === "transientMeasure") {
    if (!TRANSIENT_MEASURES.has(check.measure)) {
      addValidationError(result, `${path}.measure は ${[...TRANSIENT_MEASURES].join(" / ")} のどれかです。`);
    }
    if (check.quantity !== undefined && !["v", "i"].includes(check.quantity)) {
      addValidationError(result, `${path}.quantity は "v" または "i" です。`);
    }
    if (isFiniteNumber(check.fromSec) && isFiniteNumber(check.toSec) && !(check.toSec > check.fromSec)) {
      addValidationError(result, `${path}: toSec は fromSec より大きくしてください。`);
    }
    if (check.fromSec === undefined) {
      addValidationWarning(result, `${path}: transientMeasure に fromSec がありません（電源投入直後の過渡を含みます。定常の値を見るなら fromSec を指定）。`);
    }
    if ((check.measure === "power" || check.measure === "powerFactor") && check.element === undefined && check.match === undefined) {
      addValidationError(result, `${path}: measure "${check.measure}" には element（または match）が必要です（部品の電圧×電流から計算します）。`);
    }
    if (check.threshold !== undefined && !isFiniteNumber(check.threshold)) {
      addValidationError(result, `${path}.threshold は数値である必要があります。`);
    }
    if (check.threshold !== undefined && check.measure !== "duty") {
      addValidationWarning(result, `${path}.threshold は measure "duty" でだけ使います。`);
    }
  }
  if (check.type === "efficiency") {
    for (const key of ["inputs", "outputs"]) {
      const list = check[key];
      if (!Array.isArray(list) || list.length === 0) {
        addValidationError(result, `${path}.${key} は部品ID（文字列）または match オブジェクトの空でない配列である必要があります。`);
        continue;
      }
      list.forEach((entry, k) => {
        if (isNonEmptyString(entry)) {
          if (options.componentTypeById instanceof Map && !options.componentTypeById.has(entry)) {
            addValidationWarning(result, `${path}.${key}[${k}] "${entry}" が fixedComponents にも referenceSolution にもありません。`);
          } else if (options.fixedIds instanceof Set && !options.fixedIds.has(entry)) {
            addValidationWarning(result, `${path}.${key}[${k}] "${entry}" は固定部品ではありません（プレイヤーが置く部品は ID が変わるので match を使ってください）。`);
          }
        } else if (!isPlainObject(entry) || (entry.type === undefined && entry.nets === undefined && entry.pins === undefined)) {
          addValidationError(result, `${path}.${key}[${k}] は部品ID か match オブジェクト（{ type, nets, pins }）である必要があります。`);
        }
      });
    }
    if (check.fromSec === undefined) {
      addValidationWarning(result, `${path}: efficiency に fromSec がありません（起動直後の過渡を含みます。定常の効率を見るなら fromSec を指定し、区間をスイッチング周期の整数倍にしてください）。`);
    }
    if (isFiniteNumber(check.fromSec) && isFiniteNumber(check.toSec) && !(check.toSec > check.fromSec)) {
      addValidationError(result, `${path}: toSec は fromSec より大きくしてください。`);
    }
  }
}

/* ---- デジタル判定（truthTable / sequence / componentCount）の検証 ---- */

/** "0110" / [0,1,1,0] を配列に（sim/digital.js の toLogicSeries と同じ規則）。 */
function toLogicSeriesV(value) {
  if (typeof value === "string") return value.replace(/[\s_,]/g, "").split("");
  if (Array.isArray(value)) return value;
  return null;
}
/** 0/1 → 0/1、"x"/null → null（don't care）、それ以外 → undefined。 */
function parseLogicV(v) {
  if (v === 0 || v === "0" || v === false) return 0;
  if (v === 1 || v === "1" || v === true) return 1;
  if (v === null || v === "x" || v === "X" || v === "-") return null;
  return undefined;
}

function validateDigitalCheck(check, path, result, options) {
  const judges = Array.isArray(options.judge) ? options.judge : [options.judge ?? "dc"];
  const fixedTypes = options.fixedTypesByNet instanceof Map ? options.fixedTypesByNet : null;
  const warnNoInput = (net, label) => {
    if (fixedTypes && !(fixedTypes.get(net)?.has("LOGIC_IN"))) {
      addValidationWarning(result, `${path}: ${label} "${net}" に固定部品の LOGIC_IN がありません（入力端子として置いてください）。`);
    }
  };
  const warnNoOutput = (net) => {
    if (fixedTypes && !fixedTypes.has(net)) {
      addValidationWarning(result, `${path}: 出力 "${net}" に固定部品がありません（TP を置いてください）。`);
    }
  };

  if (check.type === "componentCount") {
    const types = Array.isArray(check.types) ? check.types : [check.types];
    if (types.length === 0 || !types.every(isNonEmptyString)) {
      addValidationError(result, `${path}.types は部品種別の配列である必要があります。`);
    } else {
      for (const t of types) validateKnownComponentType(t, path, result, options);
    }
    for (const k of ["min", "max"]) {
      if (check[k] !== undefined && (!isInteger(check[k]) || check[k] < 0)) {
        addValidationError(result, `${path}.${k} は 0 以上の整数である必要があります。`);
      }
    }
    if (isInteger(check.min) && isInteger(check.max) && check.min > check.max) {
      addValidationError(result, `${path}: min が max より大きくなっています。`);
    }
    return;
  }

  if (!judges.includes("digital")) {
    addValidationError(result, `${path}（${check.type}）には judge に "digital" が必要です。`);
  }

  if (check.type === "truthTable") {
    const ins = check.inputs;
    const outs = check.outputs;
    const okList = (v) => isStringArray(v) && v.length > 0 && v.every((n) => isNonEmptyString(n) && n !== "gnd" && n !== "0");
    if (!okList(ins)) addValidationError(result, `${path}.inputs は gnd 以外のネット名の配列である必要があります。`);
    if (!okList(outs)) addValidationError(result, `${path}.outputs は gnd 以外のネット名の配列である必要があります。`);
    if (!okList(ins) || !okList(outs)) return;
    if (ins.length > 8) addValidationError(result, `${path}.inputs は 8 個までです。`);
    if (new Set([...ins, ...outs]).size !== ins.length + outs.length) {
      addValidationError(result, `${path}: inputs / outputs に重複したネット名があります。`);
    }
    ins.forEach((n) => warnNoInput(n, "入力"));
    outs.forEach(warnNoOutput);

    const rowsAll = 1 << ins.length;
    const covered = new Set();
    if (check.table !== undefined) {
      if (!Array.isArray(check.table)) {
        addValidationError(result, `${path}.table は行の配列である必要があります。`);
      } else {
        check.table.forEach((row, i) => {
          const cells = toLogicSeriesV(row);
          if (!cells || cells.length !== ins.length + outs.length) {
            addValidationError(result, `${path}.table[${i}] の列数は inputs + outputs（${ins.length + outs.length}）である必要があります。`);
            return;
          }
          const iv = cells.slice(0, ins.length).map(parseLogicV);
          const ov = cells.slice(ins.length).map(parseLogicV);
          if (iv.some((v) => v !== 0 && v !== 1) || ov.some((v) => v === undefined)) {
            addValidationError(result, `${path}.table[${i}] は入力が 0/1、出力が 0/1/"x" である必要があります。`);
            return;
          }
          const key = iv.join("");
          if (covered.has(key)) addValidationError(result, `${path}.table に入力 ${key} の行が重複しています。`);
          covered.add(key);
        });
      }
    }
    if (check.expect !== undefined) {
      if (!isPlainObject(check.expect)) {
        addValidationError(result, `${path}.expect は { 出力ネット: "0110" } である必要があります。`);
      } else {
        for (const [net, series] of Object.entries(check.expect)) {
          const arr = toLogicSeriesV(series);
          if (!outs.includes(net)) addValidationError(result, `${path}.expect.${net} は outputs にありません。`);
          if (!arr || arr.length !== rowsAll || arr.some((v) => parseLogicV(v) === undefined)) {
            addValidationError(result, `${path}.expect.${net} は 0/1/"x" を ${rowsAll} 個（2^入力数）並べた系列である必要があります。`);
          }
        }
        for (const net of outs) {
          if (!(net in check.expect) && check.table === undefined) {
            addValidationWarning(result, `${path}: 出力 ${net} の期待値が expect にありません（判定されません）。`);
          }
        }
        for (let r = 0; r < rowsAll; r += 1) covered.add(ins.map((_, j) => (r >> (ins.length - 1 - j)) & 1).join(""));
      }
    }
    if (covered.size > 0 && covered.size < rowsAll) {
      addValidationWarning(result, `${path}: 真理値表が ${covered.size}/${rowsAll} 行しかありません（書いていない行は判定されません）。`);
    }
    return;
  }

  // sequence
  const clock = check.clock;
  if (clock !== undefined && (!isNonEmptyString(clock) || clock === "gnd")) {
    addValidationError(result, `${path}.clock は gnd 以外のネット名である必要があります。`);
  }
  if (check.sampleAt !== undefined && check.sampleAt !== "afterRise" && check.sampleAt !== "beforeRise") {
    addValidationError(result, `${path}.sampleAt は "afterRise" または "beforeRise" です。`);
  }
  if (check.sampleAt !== undefined && clock === undefined) {
    addValidationWarning(result, `${path}: clock が無いので sampleAt は使われません。`);
  }
  const lengths = [];
  for (const key of ["inputs", "outputs"]) {
    const obj = check[key];
    if (obj === undefined) continue;
    if (!isPlainObject(obj) || (key === "outputs" && Object.keys(obj).length === 0)) {
      addValidationError(result, `${path}.${key} は { ネット名: "0110" } である必要があります。`);
      continue;
    }
    for (const [net, series] of Object.entries(obj)) {
      const arr = toLogicSeriesV(series);
      const vals = (arr ?? []).map(parseLogicV);
      const bad = !arr || arr.length === 0 || vals.some((v) => v === undefined) ||
        (key === "inputs" && vals.some((v) => v === null));
      if (bad) {
        addValidationError(result, `${path}.${key}.${net} は ${key === "inputs" ? "0/1" : "0/1/\"x\""} の系列である必要があります。`);
        continue;
      }
      if (net === "gnd") addValidationError(result, `${path}.${key} に gnd は指定できません。`);
      if (key === "inputs" && net === clock) addValidationError(result, `${path}: clock "${net}" を inputs にも書くことはできません。`);
      lengths.push(arr.length);
      if (key === "inputs") warnNoInput(net, "入力");
      else warnNoOutput(net);
    }
  }
  if (lengths.length > 0 && lengths.some((n) => n !== lengths[0])) {
    addValidationError(result, `${path}: inputs / outputs の系列の長さがそろっていません（${lengths.join(", ")}）。`);
  }
  if (isNonEmptyString(clock)) warnNoInput(clock, "clock");
}

/** 極性（向き）がある部品種別。connection は pins 形式で判定すべきもの。 */
export const POLARIZED_TYPES = new Set([
  "D", "LED", "ZD", "SD", "TVS", "PD", "D_VC",
  "Q_NPN", "Q_PNP", "M_N", "M_P", "J_N", "PT",
  "OPAMP", "V_DC", "V_PULSE", "I_DC", "SCR", "TRIAC", "U_OPTO", "XFMR", "SW_V",
  "U_WILSON", "U_CASCODE", "DFF", "DFF_R",
  "U_NOT", "U_AND", "U_OR", "U_NAND", "U_NOR", "U_XOR", "U_XNOR", "U_AND3", "U_OR3",
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
  for (const key of ["tStop", "dt", "diodeRs"]) {
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
  if (sim.initialCondition !== undefined && !["zero", "dc"].includes(sim.initialCondition)) {
    addValidationError(result, 'problem.simulation.initialCondition は "zero"（既定: C=initialV, L=initialI から開始）または "dc"（DC 動作点から開始）です。');
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
 * 問題の layout（固定配線のガイド線の描き方。docs/layout_spec.md）を検証します。
 *
 * - layout は省略可。あるならオブジェクト。
 * - guides / groundSymbols は真偽値。
 * - routes は [{ net, points: [[x, y], ...] }] の配列。net は fixedComponents のネット名、
 *   points は 2 点以上で、隣り合う点は水平か垂直に並ぶこと。
 * 位置の重なり・はみ出しなどの見た目の検査は tools/check_layout.mjs が行う。
 */
function validateLayout(layout, fixedComponents, result) {
  if (layout === undefined) return;
  if (!isPlainObject(layout)) {
    addValidationError(result, "problem.layout はオブジェクトである必要があります。");
    return;
  }
  const known = new Set(["guides", "groundSymbols", "routes"]);
  for (const key of Object.keys(layout)) {
    if (!known.has(key)) {
      addValidationWarning(result, `problem.layout.${key} は未知のキーです（guides / groundSymbols / routes のみ）。`);
    }
  }
  for (const key of ["guides", "groundSymbols"]) {
    if (layout[key] !== undefined && typeof layout[key] !== "boolean") {
      addValidationError(result, `problem.layout.${key} は true / false である必要があります。`);
    }
  }
  if (layout.routes === undefined) return;
  if (!Array.isArray(layout.routes)) {
    addValidationError(result, "problem.layout.routes は配列である必要があります。");
    return;
  }
  const fixedNets = new Set();
  for (const c of Array.isArray(fixedComponents) ? fixedComponents : []) {
    for (const net of Array.isArray(c?.connect) ? c.connect : []) {
      if (isNonEmptyString(net)) fixedNets.add(net);
    }
  }
  layout.routes.forEach((route, index) => {
    const path = `problem.layout.routes[${index}]`;
    if (!isPlainObject(route)) {
      addValidationError(result, `${path} はオブジェクトである必要があります。`);
      return;
    }
    if (!isNonEmptyString(route.net)) {
      addValidationError(result, `${path}.net は空でない文字列である必要があります。`);
    } else if (!fixedNets.has(route.net)) {
      addValidationError(result, `${path}.net "${route.net}" は fixedComponents のどのネットにもありません。`);
    }
    if (!Array.isArray(route.points) || route.points.length < 2) {
      addValidationError(result, `${path}.points は 2 点以上の [x, y] の配列である必要があります。`);
      return;
    }
    route.points.forEach((pt, i) => {
      if (!Array.isArray(pt) || pt.length !== 2 || !isFiniteNumber(pt[0]) || !isFiniteNumber(pt[1])) {
        addValidationError(result, `${path}.points[${i}] は [x, y]（数値2つ）である必要があります。`);
      } else if (i > 0) {
        const prev = route.points[i - 1];
        if (Array.isArray(prev) && prev[0] !== pt[0] && prev[1] !== pt[1]) {
          addValidationError(result, `${path}.points[${i - 1}]→[${i}] が斜めです（水平か垂直に並べてください）。`);
        }
      }
    });
  });
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