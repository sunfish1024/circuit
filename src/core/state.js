/**
 * アプリ全体の状態管理を行います。
 *
 * 役割:
 * - アプリ起動状態
 * - 読み込んだ共通データ
 * - 現在選択中のカテゴリ / 問題
 * - ボード上の部品・ワイヤ・ノード
 * - 選択状態
 * - シミュレーション結果
 * - チェック結果
 * - ステータス表示
 *
 * 方針:
 * - 状態は直接変更せず、このモジュールの関数経由で変更する。
 * - 状態変更後は eventBus の "state:changed" で通知する。
 * - 画面側は "state:changed" を購読して再描画する。
 */

import { eventBus } from "./eventBus.js";
import { createComponentId, createWireId } from "./id.js";

/**
 * 空のボード状態を作成します。
 *
 * @returns {object}
 */
function createEmptyBoard() {
  return {
    components: [],
    wires: [],
    nodes: [],
  };
}

/**
 * 空の選択状態を作成します。
 *
 * @returns {object}
 */
function createEmptySelection() {
  return {
    kind: null,
    id: null,
  };
}

/**
 * シミュレーション状態を作成します。
 *
 * @returns {object}
 */
function createEmptySimulationState() {
  return {
    running: false,
    result: null,
    error: null,
  };
}

/**
 * チェック状態を作成します。
 *
 * @returns {object}
 */
function createEmptyChecksState() {
  return {
    running: false,
    results: [],
  };
}

/**
 * UI表示状態を作成します。
 *
 * @returns {object}
 */
function createEmptyUiState() {
  return {
    status: "",
    error: "",
    level: "info",
  };
}

/**
 * 初期状態を作成します。
 *
 * @returns {object}
 */
function createInitialState() {
  return {
    booted: false,

    data: {
      components: [],
      categories: [],
      checkTypes: [],
    },

    currentCategory: null,
    currentProblem: null,

    board: createEmptyBoard(),
    selection: createEmptySelection(),

    simulation: createEmptySimulationState(),
    checks: createEmptyChecksState(),

    ui: createEmptyUiState(),
  };
}

/**
 * 回転角を 0 / 90 / 180 / 270 に正規化します。
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeRotationValue(value) {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return 0;
  }

  const rounded = Math.round(num / 90) * 90;

  return ((rounded % 360) + 360) % 360;
}

/**
 * 現在の状態。
 */
let state = createInitialState();

/**
 * 可能であれば安全にクローンします。
 * 問題データや選択対象を外部から受け取るとき、
 * 参照をそのまま保持しないために使います。
 *
 * @param {*} value
 * @returns {*}
 */
function safeClone(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (error) {
      // JSON クローンへフォールバック
    }
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return value;
  }
}

/**
 * 状態変更を通知します。
 */
function emitStateChanged() {
  eventBus.emit("state:changed", state);
}

/**
 * 現在の状態を取得します。
 *
 * 注意:
 * - 戻り値は直接書き換えないでください。
 * - 変更は必ずこのモジュールの関数を通してください。
 *
 * @returns {object}
 */
export function getState() {
  return state;
}

/**
 * 状態を浅く更新します。
 * 基本的には個別関数を使うことを推奨します。
 *
 * @param {object} patch
 * @returns {object}
 */
function setState(patch) {
  state = {
    ...state,
    ...patch,
  };

  emitStateChanged();

  return state;
}

/**
 * 状態を初期化します。
 *
 * @returns {object}
 */
export function resetState() {
  state = createInitialState();

  eventBus.emit("state:reset", state);
  emitStateChanged();

  return state;
}

/**
 * 起動完了フラグを設定します。
 *
 * @param {boolean} booted
 */
export function setBooted(booted) {
  setState({
    booted: Boolean(booted),
  });
}

/**
 * ゲーム共通データを設定します。
 *
 * @param {object} data
 * @param {Array<object>} [data.components]
 * @param {Array<object>} [data.categories]
 * @param {Array<object>} [data.checkTypes]
 */
export function setGameData(data) {
  const nextData = {
    components: Array.isArray(data?.components) ? data.components : [],
    categories: Array.isArray(data?.categories) ? data.categories : [],
    checkTypes: Array.isArray(data?.checkTypes) ? data.checkTypes : [],
  };

  setState({
    data: nextData,
  });

  eventBus.emit("data:loaded", nextData);
}

/**
 * 現在のカテゴリを設定します。
 *
 * @param {string | null} categoryId
 */
export function setCurrentCategory(categoryId) {
  const nextCategoryId = categoryId || null;

  setState({
    currentCategory: nextCategoryId,
  });

  eventBus.emit("category:changed", nextCategoryId);
}

/**
 * 現在の問題を設定します。
 *
 * @param {object | null} problem
 */
export function setCurrentProblem(problem) {
  const clonedProblem = problem ? safeClone(problem) : null;

  setState({
    currentProblem: clonedProblem,
    currentCategory: clonedProblem?.category ?? state.currentCategory,
  });

  eventBus.emit("problem:changed", clonedProblem);
}

/**
 * ステータスメッセージを設定します。
 *
 * @param {string} message
 * @param {"info" | "success" | "warning" | "error"} [level="info"]
 */
export function setStatus(message, level = "info") {
  setState({
    ui: {
      ...state.ui,
      status: message,
      level,
    },
  });

  eventBus.emit("ui:status", {
    message,
    level,
  });
}

/**
 * エラーメッセージを設定します。
 *
 * @param {string} message
 */
export function setError(message) {
  setState({
    ui: {
      ...state.ui,
      error: message,
    },
  });

  eventBus.emit("ui:error", message);
}

/**
 * ステータスとエラーをクリアします。
 */
export function clearMessages() {
  setState({
    ui: createEmptyUiState(),
  });
}

/**
 * ボード上の部品を追加します。
 *
 * @param {object} component
 * @param {string} component.type
 * @param {object} [component.params]
 * @param {Array<string>} [component.connect]
 * @param {{x:number, y:number}} [component.position]
 * @param {boolean} [component.locked]
 * @param {string} [component.id]
 * @returns {object} 追加された部品
 */
export function addComponent(component) {
  if (!component || typeof component.type !== "string" || !component.type) {
    throw new Error("addComponent には type が必要です。");
  }

  const id =
    component.id ??
    createComponentId(component.type, state.board.components);

  const count = state.board.components.length;

  const defaultPosition = {
    x: 80 + (count % 8) * 48,
    y: 80 + Math.floor(count / 8) * 48,
  };

  const nextComponent = {
    id,
    type: component.type,
    params: { ...(component.params ?? {}) },
    connect: Array.isArray(component.connect)
      ? [...component.connect]
      : [],
    position: component.position
      ? { ...component.position }
      : defaultPosition,
    rotation: normalizeRotationValue(component.rotation),
    locked: Boolean(component.locked),
  };

  setState({
    board: {
      ...state.board,
      components: [...state.board.components, nextComponent],
    },
    selection: {
      kind: "component",
      id,
    },
  });

  eventBus.emit("board:component-added", nextComponent);

  return nextComponent;
}

/**
 * ボード上の部品を更新します。
 *
 * @param {string} id
 * @param {object} patch
 * @returns {object | null}
 */
export function updateComponent(id, patch) {
  const existing = state.board.components.find(
    (component) => component.id === id
  );

  if (!existing) {
    return null;
  }

  const nextComponent = {
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type,
  };

  setState({
    board: {
      ...state.board,
      components: state.board.components.map((component) =>
        component.id === id ? nextComponent : component
      ),
    },
  });

  eventBus.emit("board:component-updated", nextComponent);

  return nextComponent;
}

/**
 * ボード上の部品を削除します。
 * その部品に接続されているワイヤも同時に削除します。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function removeComponent(id) {
  const existing = state.board.components.find(
    (component) => component.id === id
  );

  if (!existing) {
    return false;
  }

  const nextComponents = state.board.components.filter(
    (component) => component.id !== id
  );

  const nextWires = state.board.wires.filter((wire) => {
    const fromComponentId = wire?.from?.componentId;
    const toComponentId = wire?.to?.componentId;

    return fromComponentId !== id && toComponentId !== id;
  });

  const nextSelection =
    state.selection.kind === "component" && state.selection.id === id
      ? createEmptySelection()
      : state.selection;

  setState({
    board: {
      ...state.board,
      components: nextComponents,
      wires: nextWires,
    },
    selection: nextSelection,
  });

  eventBus.emit("board:component-removed", { id });

  return true;
}

/**
 * IDから部品を取得します。
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getComponentById(id) {
  return (
    state.board.components.find((component) => component.id === id) ?? null
  );
}

/**
 * ワイヤを追加します。
 *
 * @param {object} wire
 * @param {{componentId: string, pin: string}} [wire.from]
 * @param {{componentId: string, pin: string}} [wire.to]
 * @param {Array<{x:number, y:number}>} [wire.points]
 * @param {boolean} [wire.locked]
 * @param {string} [wire.id]
 * @returns {object}
 */
export function addWire(wire) {
  const id = wire?.id ?? createWireId(state.board.wires);

  const nextWire = {
    id,
    from: wire?.from ? { ...wire.from } : null,
    to: wire?.to ? { ...wire.to } : null,
    points: Array.isArray(wire?.points)
      ? wire.points.map((point) => ({ ...point }))
      : [],
    locked: Boolean(wire?.locked),
  };

  setState({
    board: {
      ...state.board,
      wires: [...state.board.wires, nextWire],
    },
    selection: {
      kind: "wire",
      id,
    },
  });

  eventBus.emit("board:wire-added", nextWire);

  return nextWire;
}

/**
 * ワイヤを更新します。
 *
 * @param {string} id
 * @param {object} patch
 * @returns {object | null}
 */
export function updateWire(id, patch) {
  const existing = state.board.wires.find((wire) => wire.id === id);

  if (!existing) {
    return null;
  }

  const nextWire = {
    ...existing,
    ...patch,
    id: existing.id,
  };

  setState({
    board: {
      ...state.board,
      wires: state.board.wires.map((wire) =>
        wire.id === id ? nextWire : wire
      ),
    },
  });

  eventBus.emit("board:wire-updated", nextWire);

  return nextWire;
}

/**
 * ワイヤを削除します。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function removeWire(id) {
  const existing = state.board.wires.find((wire) => wire.id === id);

  if (!existing) {
    return false;
  }

  const nextSelection =
    state.selection.kind === "wire" && state.selection.id === id
      ? createEmptySelection()
      : state.selection;

  setState({
    board: {
      ...state.board,
      wires: state.board.wires.filter((wire) => wire.id !== id),
    },
    selection: nextSelection,
  });

  eventBus.emit("board:wire-removed", { id });

  return true;
}

/**
 * IDからワイヤを取得します。
 *
 * @param {string} id
 * @returns {object | null}
 */
export function getWireById(id) {
  return state.board.wires.find((wire) => wire.id === id) ?? null;
}

/**
 * ボードを空にします。
 */
export function clearBoard() {
  setState({
    board: createEmptyBoard(),
    selection: createEmptySelection(),
    simulation: createEmptySimulationState(),
    checks: createEmptyChecksState(),
  });

  eventBus.emit("board:cleared");
}

/**
 * 部品を選択します。
 *
 * @param {string} id
 */
export function selectComponent(id) {
  const exists = state.board.components.some(
    (component) => component.id === id
  );

  setState({
    selection: exists
      ? { kind: "component", id }
      : createEmptySelection(),
  });

  eventBus.emit("selection:changed", state.selection);
}

/**
 * ワイヤを選択します。
 *
 * @param {string} id
 */
export function selectWire(id) {
  const exists = state.board.wires.some((wire) => wire.id === id);

  setState({
    selection: exists
      ? { kind: "wire", id }
      : createEmptySelection(),
  });

  eventBus.emit("selection:changed", state.selection);
}

/**
 * 選択を解除します。
 */
export function clearSelection() {
  setState({
    selection: createEmptySelection(),
  });

  eventBus.emit("selection:changed", state.selection);
}

/**
 * シミュレーション実行中状態にします。
 */
export function startSimulation() {
  setState({
    simulation: {
      running: true,
      result: null,
      error: null,
    },
  });

  eventBus.emit("simulation:started");
}

/**
 * シミュレーション結果を設定します。
 *
 * @param {object | null} result
 */
export function setSimulationResult(result) {
  setState({
    simulation: {
      running: false,
      result: result ?? null,
      error: null,
    },
  });

  eventBus.emit("simulation:finished", result ?? null);
}

/**
 * シミュレーションエラーを設定します。
 *
 * @param {string} message
 */
export function setSimulationError(message) {
  setState({
    simulation: {
      running: false,
      result: null,
      error: message,
    },
  });

  eventBus.emit("simulation:error", message);
}

/**
 * シミュレーション状態をクリアします。
 */
export function clearSimulation() {
  setState({
    simulation: createEmptySimulationState(),
  });
}

/**
 * チェック実行中状態にします。
 */
export function startChecks() {
  setState({
    checks: {
      running: true,
      results: [],
    },
  });

  eventBus.emit("checks:started");
}

/**
 * チェック結果を設定します。
 *
 * @param {Array<object>} results
 */
export function setCheckResults(results) {
  const nextResults = Array.isArray(results) ? results : [];

  setState({
    checks: {
      running: false,
      results: nextResults,
    },
  });

  eventBus.emit("checks:finished", nextResults);
}

/**
 * チェック状態をクリアします。
 */
export function clearChecks() {
  setState({
    checks: createEmptyChecksState(),
  });
}