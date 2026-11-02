/**
 * アプリケーションUIの中心モジュールです。
 *
 * 役割:
 * - 共通データ読み込み
 * - ヘッダー（問題メニュー / シミュレーション / チェック / クリア）
 * - 部品パレット（検索 + ドラッグ&ドロップ配置 / クリック追加 / GND は常に配置可）
 * - グラフィカルボード（部品の移動・回転、ワイヤ配線、ネット名自動同期）
 * - インスペクタ描画（ID編集 + パラメータ編集 + 回転 + チェック結果）
 * - ステータス表示
 * - シミュレーション実行
 * - チェック実行
 * - 問題選択時の fixedComponents 自動配置
 *
 * 方針:
 * - 状態変更は state.js の関数経由のみ。
 * - 再描画は eventBus "state:changed" 駆動。
 * - 問題一覧・メニュー開閉・配線モードなどの一時UI状態はモジュールローカルで管理。
 * - locked な部品（fixedComponents 由来）は削除・編集を禁止（移動・回転は可）。
 * - ワイヤはピン間の視覚的接続であり、syncConnectFromWires() が
 *   ワイヤの接続情報を各部品の connect（ネット名配列）に反映する。
 * - 回転は 0/90/180/270 度。記号本体とピン位置が回転し、
 *   接続（ネット名）は変化しない。
 */

import { CONFIG, getStorageKey } from "../config.js";
import { eventBus } from "../core/eventBus.js";
import { getSymbolBody, getSymbolDefinition } from "./symbols.js";
import {
  COMP_H,
  COMP_SCALE,
  COMP_W,
  SNAP,
  componentValueText,
  computeFixedLayout,
  computeLabelLayout,
  getInnerRotationTransform,
  getPinPoint as geoGetPinPoint,
  getRotatedBox,
  getRotatedPinGeometry as geoGetRotatedPinGeometry,
  normalizeRotation,
} from "./geometry.js";
import {
  loadGameData,
  loadProblem,
  loadProblemIndex,
} from "../core/loader.js";
import { componentRegistry } from "../components/registry.js";
import { simulate } from "../sim/simulator.js";
import { runChecks, summarizeCheckResults } from "../checks/runner.js";
import { formatMetricValue } from "../core/units.js";
import {
  bindLearningEvents,
  collectAnswers,
  countSolved,
  getModal,
  getProblemProgress,
  markSolved,
  openModal,
  renderModalHtml,
  renderProblemPanelHtml,
  resetProblemView,
} from "./learning.js";
import {
  addComponent,
  addWire,
  clearBoard,
  clearSelection,
  getComponentById,
  getState,
  removeComponent,
  removeWire,
  selectComponent,
  selectWire,
  setBooted,
  setCheckResults,
  setCurrentCategory,
  setCurrentProblem,
  setError,
  setGameData,
  setSimulationError,
  setSimulationResult,
  setStatus,
  startChecks,
  startSimulation,
  updateComponent,
} from "../core/state.js";

/* ==========================================================================
   モジュールローカル状態
   ========================================================================== */

/** パレット検索クエリ。 */
let paletteQuery = "";

/** 現在カテゴリの問題一覧。state には載せずここで管理。 */
let problemIndex = [];

/** 問題一覧読み込み中フラグ。 */
let problemIndexLoading = false;

/** 競合防止トークン（カテゴリ切替の高速連打対策）。 */
let problemIndexLoadToken = 0;

/** 問題メニュー（ヘッダーのドロップダウン）の開閉状態。 */
let problemMenu = {
  open: false,
  view: "categories", // "categories" | "problems"
  categoryId: null,
};

/** 配線モード。 */
let wireMode = false;

/** 配線中のピン（ワイヤ作成ドラフト）。 */
let wireDraft = null; // { componentId, pin }

/** パレットからボードへのドラッグ中にクリックを抑制するフラグ。 */
let suppressPaletteClick = false;

/*
 * 部品シンボルのサイズ（COMP_W / COMP_H）、表示倍率（COMP_SCALE）、スナップ間隔（SNAP）、
 * ピン位置・回転・ラベル配置・ガイド線の計算は src/ui/geometry.js（DOM 非依存）にまとめてある。
 * tools/check_layout.mjs も同じモジュールを使うので、描画と検査の結果が一致する。
 */

/** アプリ外殻テンプレート。 */
const APP_SHELL = `
  <div class="app">
    <header class="app-header">
      <div>
        <h1 class="app-title">電子回路学習ゲーム</h1>
        <div class="app-subtitle">NANDgame風 回路学習プロトタイプ</div>
      </div>

      <div class="app-header-actions">
        <div class="problem-menu-wrap">
          <button data-action="problems" id="problems-button">問題 ▾</button>
          <div id="problem-menu" class="problem-menu"></div>
        </div>
        <button data-action="simulate" class="primary" title="ボード上の回路を解析し、ノード電圧や素子の電流などを右側のインスペクタに表示します。">シミュレーション</button>
        <button data-action="check">チェック</button>
        <button data-action="clear" class="danger">クリア</button>
      </div>
    </header>

    <main class="app-main">
      <aside class="pane palette" id="palette"></aside>
      <section class="pane board" id="board"></section>
      <aside class="pane inspector" id="inspector"></aside>
    </main>

    <footer class="app-status" id="status"></footer>
    <div id="modal-root"></div>
  </div>
`;

/* ==========================================================================
   汎用ヘルパー
   ========================================================================== */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeGetParamUnit(type, key) {
  try {
    return componentRegistry.getParamUnit(type, key);
  } catch (error) {
    return "";
  }
}

function forceRender() {
  eventBus.emit("state:changed", getState());
}

/**
 * 部品種別のピン名一覧を安全に取得します（未登録種別は空配列）。
 */
function safePinNames(type) {
  try {
    return componentRegistry.getPinNames(type) ?? [];
  } catch (error) {
    return [];
  }
}

/**
 * 部品の回転角を取得します（0 / 90 / 180 / 270）。
 */
function getRotation(component) {
  return normalizeRotation(component?.rotation ?? 0);
}

/**
 * 回転を考慮したピン座標（設計座標）を返します。
 */
function getRotatedPinGeometry(type, rotation) {
  return geoGetRotatedPinGeometry(type, rotation, safePinNames(type));
}

/**
 * 部品上のピンの絶対座標（キャンバス座標）を返します。
 */
function getPinPoint(component, pinName) {
  return geoGetPinPoint(component, pinName, safePinNames(component.type));
}

/** パラメータの単位（未登録なら空文字）。 */
function unitOfParam(type, key) {
  return safeGetParamUnit(type, key);
}

/**
 * ワイヤのパス d 属性を生成します（マンハッタン配線）。
 */
function wirePathD(a, b) {
  if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }

  const mx = Math.round((a.x + b.x) / 2);

  return `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
}

function snapValue(value) {
  return Math.max(0, Math.round(value / SNAP) * SNAP);
}

/**
 * ボード（キャンバス）の表示サイズを返します。
 *
 * ボードはスクロール不可の固定サイズのため、
 * 部品の自動配置や位置クランプはこのサイズを基準に行います。
 *
 * @returns {{width: number, height: number}}
 */
function getBoardSize() {
  const canvas = document.getElementById("board-canvas");
  const width = canvas?.clientWidth ?? 1100;
  const height = canvas?.clientHeight ?? 700;

  return { width, height };
}

/**
 * 部品位置がボードの外に出ないようクランプします。
 * 回転している部品は回転後の外接ボックスサイズで判定します。
 *
 * @param {{x:number, y:number}} position
 * @param {number} [rotation=0]
 * @returns {{x:number, y:number}}
 */
function clampPositionToBoard(position, rotation = 0) {
  const { width, height } = getBoardSize();
  const box = getRotatedBox(rotation);
  const maxX = Math.max(0, width - box.w * COMP_SCALE);
  const maxY = Math.max(0, height - box.h * COMP_SCALE);

  return {
    x: Math.min(Math.max(position.x, 0), maxX),
    y: Math.min(Math.max(position.y, 0), maxY),
  };
}

/**
 * 部品を 90 度単位で回転します。
 *
 * 回転は見た目とピン位置だけに影響し、
 * 接続（connect / ネット名）は変化しません。
 *
 * @param {string} id
 * @param {number} [delta=90] 90 の倍数（負値で反時計回り）
 */
function rotateComponent(id, delta = 90) {
  const component = getComponentById(id);

  if (!component) {
    return;
  }

  const next = normalizeRotation(getRotation(component) + delta);
  const position = clampPositionToBoard(
    component.position ?? { x: 0, y: 0 },
    next
  );

  updateComponent(id, { rotation: next, position });

  setStatus(`${component.id} を ${next}° に回転しました。`, "info");
}

/* ==========================================================================
   接続ネット名の収集
   ========================================================================== */

/**
 * 接続先ネット名の候補を収集します。
 * datalist で入力候補として表示します。
 *
 * @param {object} state アプリ状態
 * @returns {string[]} ネット名の配列（ソート済み）
 */
function collectKnownNets(state) {
  const nets = new Set();

  // よく使うネット名をプリセット
  for (const net of ["vin", "gnd", "out", "a", "b"]) {
    nets.add(net);
  }

  // 問題の固定部品から収集
  for (const fc of state.currentProblem?.fixedComponents ?? []) {
    for (const net of fc.connect ?? []) {
      if (typeof net === "string" && net.length > 0) {
        nets.add(net);
      }
    }
  }

  // ボード上の部品から収集
  for (const component of state.board.components) {
    for (const net of component.connect ?? []) {
      if (typeof net === "string" && net.length > 0) {
        nets.add(net);
      }
    }
  }

  return Array.from(nets).sort();
}

/* ==========================================================================
   全体描画
   ========================================================================== */

function render(root) {
  const state = getState();

  root.innerHTML = APP_SHELL;

  bindHeaderActions(root);
  renderProblemMenu(root);

  const palette = root.querySelector("#palette");
  const board = root.querySelector("#board");
  const inspector = root.querySelector("#inspector");

  if (!state.booted) {
    if (palette) {
      palette.innerHTML = "";
    }

    if (board) {
      board.innerHTML = state.ui.error
        ? `<div class="error">${escapeHtml(state.ui.error)}</div>`
        : `<div class="empty-message">共通データを読み込み中...</div>`;
    }

    if (inspector) {
      inspector.innerHTML = "";
    }

    renderStatus(root, state);
    return;
  }

  renderPalette(root, state);
  renderBoard(root, state);
  renderInspector(root, state);
  renderStatus(root, state);
  renderLearningModal(root, state);

  bindLearningEvents(root, {
    rerender: forceRender,
    onNext: () => {
      const next = getNextProblem(state.currentProblem?.id);
      if (next) void handleProblemSelect(next.id);
    },
  });
}

function getParamDefsForType(type) {
  return componentRegistry.has(type) ? componentRegistry.getParamDefinitions(type) : [];
}

function renderLearningModal(root, state) {
  const modalRoot = root.querySelector("#modal-root");
  if (!modalRoot) return;
  modalRoot.innerHTML = renderModalHtml(state.currentProblem, {
    nextProblem: getNextProblem(state.currentProblem?.id),
    getParamDefs: getParamDefsForType,
  });
}

/**
 * 同じ分野の次の問題（index.json の順）を返します。
 */
function getNextProblem(problemId) {
  if (!problemId) return null;
  const i = problemIndex.findIndex((p) => p.id === problemId);
  return i >= 0 && i + 1 < problemIndex.length ? problemIndex[i + 1] : null;
}

function isCategoryActive(categoryId) {
  const active = CONFIG.ui.activeCategories;
  return !Array.isArray(active) || active.includes(categoryId);
}

/* ==========================================================================
   ヘッダー
   ========================================================================== */

function bindHeaderActions(root) {
  const state = getState();

  const problemsButton = root.querySelector('[data-action="problems"]');
  const simulateButton = root.querySelector('[data-action="simulate"]');
  const checkButton = root.querySelector('[data-action="check"]');
  const clearButton = root.querySelector('[data-action="clear"]');

  if (problemsButton) {
    problemsButton.classList.toggle("active", problemMenu.open);
    problemsButton.textContent = state.currentProblem
      ? `問題: ${state.currentProblem.id} ▾`
      : "問題 ▾";

    problemsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      problemMenu.open = !problemMenu.open;

      if (problemMenu.open) {
        problemMenu.view = "categories";
        problemMenu.categoryId = null;
      }

      forceRender();
    });
  }

  if (simulateButton) {
    simulateButton.disabled = state.simulation.running || state.checks.running;
    simulateButton.addEventListener("click", () => {
      void handleSimulate();
    });
  }

  if (checkButton) {
    checkButton.disabled = state.simulation.running || state.checks.running;
    checkButton.addEventListener("click", () => {
      void handleCheck();
    });
  }

  if (clearButton) {
    clearButton.addEventListener("click", () => {
      handleClear();
    });
  }
}

/* ==========================================================================
   問題メニュー（ヘッダーのドロップダウン）
   ========================================================================== */

function renderProblemMenu(root) {
  const menu = root.querySelector("#problem-menu");

  if (!menu) return;

  if (!problemMenu.open) {
    menu.innerHTML = "";
    return;
  }

  const state = getState();

  if (problemMenu.view === "categories") {
    const categories = state.data.categories ?? [];

    const buttons = categories
      .map((category) => {
        const active = isCategoryActive(category.id);
        return `
          <button class="problem-menu-cat ${active ? "" : "is-disabled"}" ${active ? `data-menu-category="${escapeHtml(category.id)}"` : "disabled"} title="${escapeHtml(category.description ?? category.nameJa ?? "")}">
            <span class="cat-id">${escapeHtml(category.id)}</span>
            <span class="cat-name">${escapeHtml(category.nameJa ?? "")}</span>
            ${active ? "" : `<span class="cat-soon">準備中</span>`}
          </button>
        `;
      })
      .join("");

    menu.innerHTML = `
      <div class="problem-menu-panel">
        <div class="problem-menu-title">カテゴリを選択</div>
        <div class="problem-menu-grid">${buttons}</div>
      </div>
    `;

    menu.querySelectorAll("[data-menu-category]").forEach((button) => {
      button.addEventListener("click", () => {
        const categoryId = button.dataset.menuCategory;
        problemMenu.view = "problems";
        problemMenu.categoryId = categoryId;

        setCurrentCategory(categoryId);

        if (getState().currentProblem) {
          setCurrentProblem(null);
        }

        problemIndex = [];
        problemIndexLoading = false;
        problemIndexLoadToken += 1;

        void loadProblemsForCategory(categoryId);
      });
    });

    return;
  }

  // 問題一覧ビュー
  const categoryId = problemMenu.categoryId;

  let listHtml = "";

  if (problemIndexLoading) {
    listHtml = `<div class="problem-menu-empty">問題一覧を読み込み中...</div>`;
  } else if (problemIndex.length === 0) {
    listHtml = `<div class="problem-menu-empty">このカテゴリの問題はまだありません。</div>`;
  } else {
    const currentId = state.currentProblem?.id ?? null;

    listHtml = `
      <div class="problem-menu-list">
        ${problemIndex
          .map((problem) => {
            const activeClass = problem.id === currentId ? "active" : "";
            const record = getProblemProgress(problem.id);
            const mark = record?.solved
              ? `<span class="solved-mark" title="クリア済み">✓</span>`
              : `<span class="solved-mark is-empty"></span>`;
            const difficulty = Number.isFinite(problem.difficulty)
              ? `<span class="badge">Lv.${escapeHtml(problem.difficulty)}</span>`
              : "";

            return `
              <button class="problem-menu-item ${activeClass}" data-menu-problem="${escapeHtml(problem.id)}">
                ${mark}
                <span class="pid">${escapeHtml(problem.id)}</span>
                <span class="ptitle">${escapeHtml(problem.title ?? "")}</span>
                ${difficulty}
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  menu.innerHTML = `
    <div class="problem-menu-panel">
      <div class="problem-menu-head">
        <button data-menu-back>← カテゴリ</button>
        <span class="problem-menu-title">カテゴリ ${escapeHtml(categoryId ?? "")} の問題</span>
        ${problemIndex.length ? `<span class="problem-menu-progress">クリア ${countSolved(problemIndex.map((p) => p.id))} / ${problemIndex.length}</span>` : ""}
      </div>
      ${listHtml}
    </div>
  `;

  const backButton = menu.querySelector("[data-menu-back]");

  if (backButton) {
    backButton.addEventListener("click", () => {
      problemMenu.view = "categories";
      problemMenu.categoryId = null;
      forceRender();
    });
  }

  menu.querySelectorAll("[data-menu-problem]").forEach((button) => {
    button.addEventListener("click", () => {
      const problemId = button.dataset.menuProblem;
      problemMenu.open = false;
      void handleProblemSelect(problemId);
    });
  });
}

/* ==========================================================================
   パレット（部品）
   ========================================================================== */

function renderPalette(root, state) {
  const palette = root.querySelector("#palette");
  if (!palette) return;

  palette.innerHTML = `
    <div class="pane-section">
      <h2 class="pane-title">部品パレット</h2>
      <p class="palette-hint">
        部品を<b>ドラッグ</b>してボードに配置できます（クリックでも追加）。
      </p>
      <input
        id="palette-search"
        type="search"
        placeholder="部品を検索"
        value="${escapeHtml(paletteQuery)}"
      />
    </div>

    <div class="pane-section">
      <h2 class="pane-title">部品</h2>
      <div id="palette-component-list" class="component-list"></div>
    </div>
  `;

  bindPaletteSearch(root);
  renderComponentList(root, state);
}

function bindPaletteSearch(root) {
  const searchInput = root.querySelector("#palette-search");
  if (!searchInput) return;

  searchInput.addEventListener("input", () => {
    paletteQuery = searchInput.value;
    renderComponentList(root, getState());
  });
}

function renderComponentList(root, state) {
  const list = root.querySelector("#palette-component-list");
  if (!list) return;

  const allowed = Array.isArray(state.currentProblem?.availableComponents)
    ? state.currentProblem.availableComponents
    : null;
  // GND は問題に関係なく常にパレットから配置できる（複数置いてもよい）。
  const allowedSet =
    allowed && allowed.length > 0 ? new Set([...allowed, "GND"]) : null;

  const definitions = componentRegistry
    .search(paletteQuery, state.currentCategory)
    .filter((definition) => componentRegistry.isPaletteVisible(definition.type))
    .filter((definition) => !allowedSet || allowedSet.has(definition.type));

  if (definitions.length === 0) {
    list.innerHTML = `<p class="palette-empty">該当する部品がありません。</p>`;
    return;
  }

  list.innerHTML = definitions
    .map((definition) => {
      const pinCount = safePinNames(definition.type).length;
      const symbolSvg = getSymbolBody(definition.type, null);

      return `
        <button
          class="component-button"
          data-component-type="${escapeHtml(definition.type)}"
          title="${escapeHtml(definition.description ?? "")}"
        >
          ${
            symbolSvg
              ? `<svg class="component-symbol" viewBox="-3 -4 102 60" aria-hidden="true">${symbolSvg}</svg>`
              : ""
          }
          <span class="component-button-text">
            <span class="component-button-name">
              ${escapeHtml(definition.nameJa)}
            </span>
            <span class="component-button-type">
              ${escapeHtml(definition.type)} ・ ${pinCount}端子
            </span>
          </span>
        </button>
      `;
    })
    .join("");

  bindComponentButtons(root);
}

function bindComponentButtons(root) {
  root.querySelectorAll("[data-component-type]").forEach((button) => {
    const type = button.dataset.componentType;

    button.addEventListener("click", () => {
      if (suppressPaletteClick) {
        suppressPaletteClick = false;
        return;
      }

      addComponentFromPalette(type, null);
    });

    bindPaletteDrag(button, type);
  });
}

/**
 * パレットから部品を追加します。
 *
 * @param {string} type
 * @param {{x:number, y:number} | null} position null の場合は自動配置
 */
function addComponentFromPalette(type, position) {
  if (!componentRegistry.has(type)) {
    setError(`部品 ${type} が見つかりません。`);
    return;
  }

  const definition = componentRegistry.get(type);
  const draft = componentRegistry.createDraft(type);

  if (position) {
    draft.position = clampPositionToBoard(position);
  } else {
    // クリック追加の場合はボードの中央付近にカスケード配置する。
    // （画面外に生成されないようにするため）
    const count = getState().board.components.length;
    const { width, height } = getBoardSize();
    const slot = count % 12;
    const offsetX = (slot % 4) * 60 - 90;
    const offsetY = Math.floor(slot / 4) * 50 - 50;

    draft.position = clampPositionToBoard({
      x: snapValue(width / 2 - (COMP_W * COMP_SCALE) / 2 + offsetX),
      y: snapValue(height / 2 - (COMP_H * COMP_SCALE) / 2 + offsetY),
    });
  }

  addComponent(draft);
  setStatus(
    position
      ? `${definition.nameJa} を配置しました。`
      : `${definition.nameJa} を追加しました。`,
    "info"
  );
}

/**
 * パレットボタンからのドラッグ&ドロップをバインドします。
 *
 * ポインタで 5px 以上動かしたらドラッグとみなし、
 * ボード上で離すとその位置に部品を配置します。
 *
 * @param {HTMLElement} button
 * @param {string} type
 */
function bindPaletteDrag(button, type) {
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let ghost = null;
    let moved = false;

    const definition = componentRegistry.has(type)
      ? componentRegistry.get(type)
      : null;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        suppressPaletteClick = true;

        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = definition?.nameJa ?? type;
        document.body.appendChild(ghost);
      }

      if (ghost) {
        ghost.style.left = `${moveEvent.clientX + 12}px`;
        ghost.style.top = `${moveEvent.clientY + 12}px`;
      }
    };

    const onUp = (upEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);

      if (ghost) {
        ghost.remove();
        ghost = null;
      }

      if (!moved) {
        suppressPaletteClick = false;
        return; // クリック扱い（click ハンドラで追加）
      }

      const canvas = document.getElementById("board-canvas");

      if (!canvas) {
        suppressPaletteClick = false;
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const inside =
        upEvent.clientX >= rect.left &&
        upEvent.clientX <= rect.right &&
        upEvent.clientY >= rect.top &&
        upEvent.clientY <= rect.bottom;

      if (!inside) {
        suppressPaletteClick = false;
        setStatus("ボードの外には配置できません。", "warning");
        forceRender();
        return;
      }

      const position = clampPositionToBoard({
        x: snapValue(upEvent.clientX - rect.left - (COMP_W * COMP_SCALE) / 2),
        y: snapValue(upEvent.clientY - rect.top - (COMP_H * COMP_SCALE) / 2),
      });

      addComponentFromPalette(type, position);
    };

    const onCancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);

      if (ghost) {
        ghost.remove();
        ghost = null;
      }

      suppressPaletteClick = false;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
}

/* ==========================================================================
   問題一覧の読み込み / 問題選択
   ========================================================================== */

async function loadProblemsForCategory(categoryId) {
  const token = ++problemIndexLoadToken;

  problemIndexLoading = true;
  problemIndex = [];
  forceRender();

  try {
    const index = await loadProblemIndex(categoryId);

    if (token !== problemIndexLoadToken) {
      return;
    }

    problemIndex = Array.isArray(index.problems) ? index.problems : [];

    if (index.missing) {
      setStatus(
        `カテゴリ ${categoryId} の問題一覧ファイルがありません。`,
        "warning"
      );
    }
  } catch (error) {
    if (token !== problemIndexLoadToken) {
      return;
    }

    problemIndex = [];
    setError(error?.message ?? String(error));
    setStatus(
      `カテゴリ ${categoryId} の問題一覧の読み込みに失敗しました。`,
      "error"
    );
  } finally {
    if (token === problemIndexLoadToken) {
      problemIndexLoading = false;
      forceRender();
    }
  }
}

async function handleProblemSelect(problemId) {
  const state = getState();

  if (!state.currentCategory) {
    setStatus(
      "カテゴリを選択してから問題を選んでください。",
      "warning"
    );
    return;
  }

  try {
    setStatus(`問題 ${problemId} を読み込み中...`, "info");

    const problem = await loadProblem(state.currentCategory, problemId, {
      knownComponentTypes: new Set(
        state.data.components.map((c) => c.type)
      ),
      knownCheckTypes: new Set(state.data.checkTypes.map((c) => c.type)),
    });

    // 既存ボードをクリアし、固定部品を配置
    clearBoard();

    // 固定部品は上段に並べる（ボードサイズに合わせて折り返し・クランプ）
    const fixed = problem.fixedComponents ?? [];
    const { width } = getBoardSize();
    const stepX = 150;
    const perRow = Math.max(2, Math.floor((width - 40) / stepX));

    fixed.forEach((fc, index) => {
      const col = index % perRow;
      const row = Math.floor(index / perRow);
      const rotation = normalizeRotation(fc.rotation ?? 0);

      addComponent({
        id: fc.id,
        type: fc.type,
        params: { ...(fc.params ?? {}) },
        connect: Array.isArray(fc.connect) ? [...fc.connect] : [],
        locked: true,
        rotation,
        // 問題データに position があればそれを使う（回路の形が分かる配置にするため）
        position: clampPositionToBoard(
          fc.position && Number.isFinite(fc.position.x) && Number.isFinite(fc.position.y)
            ? { x: snapValue(fc.position.x), y: snapValue(fc.position.y) }
            : {
                x: snapValue(30 + col * stepX),
                y: snapValue(30 + row * 110),
              },
          rotation
        ),
      });
    });

    resetProblemView(problem);
    setCurrentProblem(problem);

    wireMode = false;
    wireDraft = null;

    setStatus(`問題 ${problemId} を読み込みました。`, "success");
  } catch (error) {
    setError(error?.message ?? String(error));
    setStatus(
      `問題 ${problemId} の読み込みに失敗しました。`,
      "error"
    );
  }
}

/* ==========================================================================
   ボード（グラフィカルキャンバス）
   ========================================================================== */

function renderBoard(root, state) {
  const board = root.querySelector("#board");
  if (!board) return;

  const components = state.board.components;
  const wires = state.board.wires;
  const problem = state.currentProblem;

  // --- ツールバー ---
  const toolbarHtml = `
    <div class="board-toolbar">
      <div class="board-toolbar-left">
        <button id="wire-mode-toggle" class="${wireMode ? "active" : ""}">
          ${wireMode ? "配線モード（ON）" : "配線モード"}
        </button>
        <span class="toolbar-hint">
          ${
            wireDraft
              ? "接続先の端子をクリック（Esc で取消）"
              : wireMode
                ? "端子をクリックして配線します"
                : "ドラッグで配置 / ドラッグで移動 / 選択中に R で回転 / Delete で削除"
          }
        </span>
      </div>
      <div class="board-toolbar-right">
        <span class="board-stats">部品 ${components.length} / ワイヤ ${wires.length}</span>
      </div>
    </div>
  `;

  // --- 問題パネル ---
  const problemPanelHtml = problem
    ? renderProblemPanelHtml(problem, {
        solved: Boolean(getProblemProgress(problem.id)?.solved),
      })
    : "";

  // --- SVG（ガイド線 + ワイヤ + 部品） ---
  const fixedLayout = getFixedLayout(state);
  const guidesSvg = buildGuidesSvg(fixedLayout);
  const wiresSvg = buildWiresSvg(state);
  const componentsSvg = buildComponentsSvg(state, fixedLayout);
  const draftSvg = buildDraftSvg(state);

  const emptyHtml =
    components.length === 0
      ? `<div class="board-empty">
           部品がありません。左のパレットから部品をドラッグして配置してください。
         </div>`
      : "";

  board.innerHTML = `
    ${toolbarHtml}
    <div class="board-work" id="board-work">
    ${
      problemPanelHtml
        ? `<div class="problem-frame" id="problem-frame">
             ${problemPanelHtml}
             <div class="panel-resize panel-resize-e" data-panel-resize="e" title="ドラッグで幅を変更（ダブルクリックで元に戻す）"></div>
             <div class="panel-resize panel-resize-s" data-panel-resize="s" title="ドラッグで高さを変更（ダブルクリックで元に戻す）"></div>
             <div class="panel-resize panel-resize-se" data-panel-resize="se" title="ドラッグで幅と高さを変更（ダブルクリックで元に戻す）"></div>
           </div>`
        : ""
    }
    <div class="board-container">
      <div class="board-canvas ${wireMode ? "wire-mode" : ""}" id="board-canvas">
        <svg class="board-svg" id="board-svg">
          <g id="guide-layer">${guidesSvg}</g>
          <g id="wire-layer">${wiresSvg}</g>
          <g id="component-layer">${componentsSvg}</g>
          ${draftSvg}
        </svg>
        ${emptyHtml}
      </div>
    </div>
    </div>
  `;

  bindBoardEvents(root, state);
  setupProblemPanelResize(root);
}

/* ==========================================================================
   問題文パネルのリサイズ
   ========================================================================== */

/** 問題文パネルの最小サイズ（px）。 */
const PANEL_MIN_W = 280;
const PANEL_MIN_H = 90;

/** 問題文パネルの右にボードを並べるのに必要な最小のボード幅（px）。 */
const PANEL_SIDE_MIN_BOARD = 360;

/**
 * 問題文パネルのサイズ（ユーザーがドラッグで決めたもの）。
 * width / height が null なら既定（幅いっぱい / 最大 46vh）。
 */
let panelSize = readPanelSize();

function readPanelSize() {
  try {
    const raw = localStorage.getItem(getStorageKey("problemPanelSize"));
    const parsed = raw ? JSON.parse(raw) : null;
    const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
    return { width: num(parsed?.width), height: num(parsed?.height) };
  } catch {
    return { width: null, height: null };
  }
}

function writePanelSize() {
  try {
    if (panelSize.width === null && panelSize.height === null) {
      localStorage.removeItem(getStorageKey("problemPanelSize"));
    } else {
      localStorage.setItem(getStorageKey("problemPanelSize"), JSON.stringify(panelSize));
    }
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

/**
 * 保存済みのサイズをパネルに当て、並べ方（上 / 横）を決めます。
 * - 幅を狭めてボードの右側に PANEL_SIDE_MIN_BOARD 以上の余白ができたら、パネルの右にボードを並べる（is-side）。
 * - それ以外はパネルの下にボード（従来どおり）。
 */
function applyPanelLayout(root) {
  const work = root.querySelector("#board-work");
  const frame = root.querySelector("#problem-frame");
  if (!work || !frame) return;

  const collapsed = Boolean(frame.querySelector(".board-problem-panel.is-collapsed"));
  const workW = work.clientWidth;
  const workH = work.clientHeight;

  const width =
    panelSize.width === null
      ? null
      : Math.max(PANEL_MIN_W, Math.min(panelSize.width, Math.max(PANEL_MIN_W, workW)));
  const side = width !== null && workW - width >= PANEL_SIDE_MIN_BOARD;

  work.classList.toggle("is-side", side);
  frame.style.width = width === null ? "" : `${width}px`;

  if (collapsed || panelSize.height === null) {
    frame.style.height = "";
    frame.classList.remove("has-height");
  } else {
    const maxH = side ? workH : Math.max(PANEL_MIN_H, workH - 120);
    frame.style.height = `${Math.max(PANEL_MIN_H, Math.min(panelSize.height, maxH))}px`;
    frame.classList.add("has-height");
  }
}

/** ウィンドウサイズ変更時にパネルの並べ方を見直す（登録は1回だけ）。 */
let panelResizeListenerRoot = null;

function setupProblemPanelResize(root) {
  const frame = root.querySelector("#problem-frame");

  if (!panelResizeListenerRoot) {
    panelResizeListenerRoot = root;
    window.addEventListener("resize", () => applyPanelLayout(panelResizeListenerRoot));
  }

  if (!frame) return;

  applyPanelLayout(root);

  frame.querySelectorAll("[data-panel-resize]").forEach((handle) => {
    const mode = handle.dataset.panelResize;

    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (mode.includes("e")) panelSize.width = null;
      if (mode.includes("s")) panelSize.height = null;
      writePanelSize();
      applyPanelLayout(root);
    });

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startY = event.clientY;
      const rect = frame.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;

      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 古いブラウザでは無視 */
      }
      frame.classList.add("is-resizing");

      const onMove = (moveEvent) => {
        if (mode.includes("e")) {
          panelSize.width = Math.max(PANEL_MIN_W, Math.round(startW + moveEvent.clientX - startX));
        }
        if (mode.includes("s")) {
          panelSize.height = Math.max(PANEL_MIN_H, Math.round(startH + moveEvent.clientY - startY));
        }
        applyPanelLayout(root);
      };

      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        frame.classList.remove("is-resizing");
        writePanelSize();
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  });
}

/* ==========================================================================
   固定配線のガイド線（描画専用）
   ========================================================================== */

/** computeFixedLayout の結果のキャッシュ（固定部品の位置・回転・接続が変わったときだけ再計算）。 */
let fixedLayoutCache = { key: null, value: null };

/**
 * 固定部品（locked）のラベル配置・ガイド線・自動 GND 記号を計算します。
 * ガイド線は描画専用で、state の wires には入りません（電気的な意味はネット名で決まる）。
 */
function getFixedLayout(state) {
  const fixed = state.board.components.filter((c) => c.locked);
  const layout = state.currentProblem?.layout ?? {};
  const key = JSON.stringify([
    layout,
    fixed.map((c) => [c.id, c.type, c.position, c.rotation, c.connect, c.params]),
  ]);

  if (fixedLayoutCache.key === key) {
    return fixedLayoutCache.value;
  }

  let value;
  try {
    value = computeFixedLayout(fixed, {
      pinNamesOf: safePinNames,
      unitOf: unitOfParam,
      layout,
    });
  } catch (error) {
    console.warn("ガイド線の計算に失敗しました。", error);
    value = { guides: { nets: [], groundMarks: [], failures: [] }, hiddenPinsById: new Map() };
  }

  fixedLayoutCache = { key, value };
  return value;
}

/**
 * ガイド線・分岐点・自動 GND 記号の SVG を生成します。
 * 自動 GND 記号は、配線モードでクリックするとそのピンへの配線になります（data-pin-comp）。
 */
function buildGuidesSvg(fixedLayout) {
  const guides = fixedLayout?.guides;
  if (!guides) return "";

  const toD = (pl) => pl.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  const netsSvg = guides.nets
    .map((net) => {
      const paths = net.polylines
        .filter((pl) => pl.length >= 2)
        .map(
          (pl) =>
            `<path class="board-guide${pl.fallback ? " is-fallback" : ""}" d="${toD(pl)}"></path>`
        )
        .join("");
      const dots = net.junctions
        .map((p) => `<circle class="board-guide-dot" cx="${p.x}" cy="${p.y}" r="2.6"></circle>`)
        .join("");
      return `<g class="board-guide-net" data-guide-net="${escapeHtml(net.net)}"><title>固定配線: ネット ${escapeHtml(net.net)}</title>${paths}${dots}</g>`;
    })
    .join("");

  const groundSvg = guides.groundMarks
    .map((mark) => {
      const lines = mark.lines
        .map(
          ([x1, y1, x2, y2]) =>
            `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`
        )
        .join("");
      const r = mark.rect;
      return `
        <g class="board-guide-gnd" data-pin-comp="${escapeHtml(mark.componentId)}" data-pin-name="${escapeHtml(mark.pin)}">
          <rect class="board-guide-gnd-hit" x="${r.x - 4}" y="${r.y - 4}" width="${r.w + 8}" height="${r.h + 8}"></rect>
          ${lines}
          <title>${escapeHtml(mark.componentId)}.${escapeHtml(mark.pin)} は gnd（接地）につながっています</title>
        </g>`;
    })
    .join("");

  return netsSvg + groundSvg;
}

/**
 * ワイヤのSVGを生成します。
 */
function buildWiresSvg(state) {
  const compsById = new Map(
    state.board.components.map((component) => [component.id, component])
  );

  return state.board.wires
    .map((wire) => {
      const from = wire.from ? compsById.get(wire.from.componentId) : null;
      const to = wire.to ? compsById.get(wire.to.componentId) : null;

      if (!from || !to || !wire.from || !wire.to) {
        return "";
      }

      const a = getPinPoint(from, wire.from.pin);
      const b = getPinPoint(to, wire.to.pin);
      const d = wirePathD(a, b);

      const isSelected =
        state.selection.kind === "wire" && state.selection.id === wire.id;

      const deleteButton = isSelected
        ? `
          <g class="wire-del" data-wire-del="${escapeHtml(wire.id)}" transform="translate(${(a.x + b.x) / 2}, ${(a.y + b.y) / 2})">
            <circle r="9"></circle>
            <text text-anchor="middle" dy="3.5">×</text>
            <title>このワイヤを削除</title>
          </g>
        `
        : "";

      return `
        <path class="board-wire ${isSelected ? "is-selected" : ""}" d="${d}" pointer-events="none"></path>
        <path class="board-wire-hit" data-wire-hit="${escapeHtml(wire.id)}" d="${d}"><title>ワイヤ ${escapeHtml(wire.id)}</title></path>
        ${deleteButton}
      `;
    })
    .join("");
}

/**
 * 部品のSVGを生成します。
 * 部品が回転している場合は、記号本体・選択枠・当たり判定を回転させ、
 * ピンと ID / パラメータ表示は回転後の外接ボックスに合わせて配置します。
 * ラベルの位置は geometry.js の computeLabelLayout（check_layout.mjs と共通）で決めます。
 */
function buildComponentsSvg(state, fixedLayout) {
  const hiddenPinsById = fixedLayout?.hiddenPinsById ?? new Map();

  return state.board.components
    .map((component) => {
      const definition = componentRegistry.has(component.type)
        ? componentRegistry.get(component.type)
        : null;

      const names = safePinNames(component.type);
      const rotation = getRotation(component);
      const box = getRotatedBox(rotation);
      const geo = getRotatedPinGeometry(component.type, rotation);
      const connect = Array.isArray(component.connect)
        ? component.connect
        : [];

      const x = component.position?.x ?? 40;
      const y = component.position?.y ?? 40;

      const isSelected =
        state.selection.kind === "component" &&
        state.selection.id === component.id;

      const labels = computeLabelLayout(component, {
        pinNames: names,
        showPinNets: wireMode || Boolean(component.locked),
        hiddenPins: component.locked
          ? (hiddenPinsById.get(component.id) ?? new Set())
          : new Set(),
        valueText: componentValueText(component, unitOfParam),
      });

      const pinTitle = (pinName, index) => {
        const net = connect[index];
        return `${pinName} ← ${net ? net : "未接続"}`;
      };

      const textSvg = (label, cls) =>
        label
          ? `<text class="${cls}" x="${label.x}" y="${label.y}" text-anchor="${label.anchor}">${escapeHtml(label.text)}</text>`
          : "";

      const pinsSvg = names
        .map((pinName, index) => {
          const point = geo[index] ?? { x: box.w / 2, y: box.h / 2 };

          return `
            <circle class="board-pin-hit" cx="${point.x}" cy="${point.y}" r="10"
              data-pin-comp="${escapeHtml(component.id)}" data-pin-name="${escapeHtml(pinName)}"></circle>
            <circle class="board-pin" cx="${point.x}" cy="${point.y}" r="4.5"
              data-pin-comp="${escapeHtml(component.id)}" data-pin-name="${escapeHtml(pinName)}">
              <title>${escapeHtml(pinTitle(pinName, index))}</title>
            </circle>
            ${textSvg(labels.pins[index], "board-pin-label")}
          `;
        })
        .join("");

      const symbolDef = getSymbolDefinition(component.type);
      const bodySvg = symbolDef
        ? getSymbolBody(component.type, component)
        : `<rect class="board-comp-rect" width="${COMP_W}" height="${COMP_H}" rx="8"></rect>
           <text class="board-comp-type" x="${COMP_W / 2}" y="31" text-anchor="middle">${escapeHtml(definition?.nameJa ?? component.type)}</text>`;

      const rotationTransform = getInnerRotationTransform(rotation);

      // 記号本体（+ 当たり判定 / 選択枠）は回転グループの中に入れる。
      const rotatedBody = `
        <g class="symbol-rot" ${rotationTransform ? `transform="${rotationTransform}"` : ""}>
          <rect class="board-comp-hit" width="${COMP_W}" height="${COMP_H}" fill="transparent"></rect>
          <rect class="board-comp-select" width="${COMP_W}" height="${COMP_H}" rx="8"></rect>
          <g class="symbol-body">${bodySvg}</g>
        </g>
      `;

      // 選択中の部品には回転ハンドル（左上の角の外側）を表示する。
      // 右上は縦置き部品の上ピンのラベルと重なるため、ラベルを置かない左上に出す。
      const rotateHandle = isSelected
        ? `
          <g class="comp-rotate-handle" data-rotate-comp="${escapeHtml(component.id)}"
             transform="translate(-10, -10)">
            <circle r="9"></circle>
            <text text-anchor="middle" dy="3.5">⟳</text>
            <title>回転する（R キー / Shift+R で逆回転）</title>
          </g>
        `
        : "";

      return `
        <g class="board-component ${isSelected ? "is-selected" : ""}"
           transform="translate(${x}, ${y}) scale(${COMP_SCALE})"
           data-comp-id="${escapeHtml(component.id)}">
          ${rotatedBody}
          ${textSvg(labels.id, "board-comp-id")}
          ${textSvg(labels.value, "board-comp-params")}
          ${rotateHandle}
          ${pinsSvg}
          <title>${escapeHtml(component.id)}（${escapeHtml(component.type)}）</title>
        </g>
      `;
    })
    .join("");
}

/**
 * 配線中のプレビュー線のSVGを生成します。
 */
function buildDraftSvg(state) {
  if (!wireDraft) return "";

  const from = getComponentById(wireDraft.componentId);

  if (!from) return "";

  const a = getPinPoint(from, wireDraft.pin);

  return `
    <path id="wire-draft-line" class="board-wire-draft" d="${wirePathD(a, a)}"></path>
  `;
}

/**
 * ボード上のイベントをバインドします。
 */
function bindBoardEvents(root, state) {
  const canvas = root.querySelector("#board-canvas");
  const svg = root.querySelector("#board-svg");
  const toggle = root.querySelector("#wire-mode-toggle");

  if (toggle) {
    toggle.addEventListener("click", () => {
      wireMode = !wireMode;
      wireDraft = null;
      forceRender();
    });
  }

  if (!canvas || !svg) return;

  // 配線プレビューの追従
  svg.addEventListener("pointermove", (event) => {
    if (!wireDraft) return;

    const draftLine = svg.querySelector("#wire-draft-line");

    if (!draftLine) return;

    const from = getComponentById(wireDraft.componentId);

    if (!from) return;

    const rect = canvas.getBoundingClientRect();
    const a = getPinPoint(from, wireDraft.pin);
    const b = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };

    draftLine.setAttribute("d", wirePathD(a, b));
  });

  // 空白クリック: 配線取消 / 選択解除
  canvas.addEventListener("pointerdown", (event) => {
    if (event.target !== svg && event.target !== canvas) return;

    if (wireDraft) {
      wireDraft = null;
      forceRender();
      return;
    }

    if (getState().selection.kind) {
      clearSelection();
    }
  });

  // 部品のドラッグ移動 / 選択
  svg.querySelectorAll("[data-comp-id]").forEach((group) => {
    const componentId = group.dataset.compId;

    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;

      event.stopPropagation();

      const component = getComponentById(componentId);

      if (!component) return;

      // 配線モードでは移動させず選択のみ（端子クリックは配線処理が優先）
      if (wireMode) {
        selectComponent(componentId);
        return;
      }

      const startX = event.clientX;
      const startY = event.clientY;
      const origX = component.position?.x ?? 40;
      const origY = component.position?.y ?? 40;
      let moved = false;

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        if (!moved && Math.hypot(dx, dy) > 3) {
          moved = true;
          group.classList.add("is-dragging");
        }

        if (moved) {
          group.setAttribute(
            "transform",
            `translate(${origX + dx}, ${origY + dy}) scale(${COMP_SCALE})`
          );
        }
      };

      const onUp = (upEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);

        group.classList.remove("is-dragging");

        if (moved) {
          const dx = upEvent.clientX - startX;
          const dy = upEvent.clientY - startY;

          updateComponent(componentId, {
            position: clampPositionToBoard(
              {
                x: snapValue(origX + dx),
                y: snapValue(origY + dy),
              },
              getRotation(component)
            ),
          });
        } else {
          selectComponent(componentId);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });

  // ピンクリック → 配線作成
  svg.querySelectorAll("[data-pin-comp]").forEach((pinElement) => {
    // ピン上の pointerdown は部品選択に連動させない
    pinElement.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    pinElement.addEventListener("click", (event) => {
      event.stopPropagation();

      if (!wireMode) return;

      const componentId = pinElement.dataset.pinComp;
      const pinName = pinElement.dataset.pinName;

      if (!wireDraft) {
        wireDraft = { componentId, pin: pinName };
        forceRender();
        return;
      }

      if (
        wireDraft.componentId === componentId &&
        wireDraft.pin === pinName
      ) {
        // 同じピン → 取消
        wireDraft = null;
        forceRender();
        return;
      }

      const wire = addWire({
        from: { componentId: wireDraft.componentId, pin: wireDraft.pin },
        to: { componentId, pin: pinName },
      });

      wireDraft = null;

      syncConnectFromWires();

      setStatus(
        `ワイヤ ${wire.id} を接続しました（ネット名を自動設定）。`,
        "success"
      );
    });
  });

  // ワイヤクリック → 選択
  svg.querySelectorAll("[data-wire-hit]").forEach((hit) => {
    hit.addEventListener("click", (event) => {
      event.stopPropagation();
      selectWire(hit.dataset.wireHit);
    });
  });

  // ワイヤ削除ボタン
  svg.querySelectorAll("[data-wire-del]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      removeWire(button.dataset.wireDel);
      syncConnectFromWires();
      setStatus("ワイヤを削除しました。", "info");
    });
  });

  // 回転ハンドル（選択中の部品の右上）
  svg.querySelectorAll("[data-rotate-comp]").forEach((handle) => {
    // ハンドル上の pointerdown は部品ドラッグを開始させない
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    handle.addEventListener("click", (event) => {
      event.stopPropagation();

      if (event.shiftKey) {
        rotateComponent(handle.dataset.rotateComp, -90);
      } else {
        rotateComponent(handle.dataset.rotateComp, 90);
      }
    });
  });
}

/* ==========================================================================
   ワイヤ → ネット名（connect）同期
   ========================================================================== */

/**
 * ワイヤの接続情報から各部品の connect（ネット名配列）を再計算します。
 *
 * ルール:
 * - ワイヤでつながったピンは同じネット名を持つ。
 * - 固定部品（locked）が持つネット名を優先して使う。
 * - 名前がない場合は net1, net2, ... を自動採番する。
 * - ワイヤでつながっていないピン名は変更しない（手動入力を尊重）。
 */
function syncConnectFromWires() {
  const state = getState();
  const components = state.board.components;

  if (components.length === 0) return;

  const keyOf = (componentId, pinIndex) => `${componentId}::${pinIndex}`;

  // ピンの親子関係（Union-Find）
  const parent = new Map();

  for (const component of components) {
    const pinCount = safePinNames(component.type).length;

    for (let i = 0; i < pinCount; i += 1) {
      parent.set(keyOf(component.id, i), keyOf(component.id, i));
    }
  }

  const find = (key) => {
    let root = key;

    while (parent.get(root) !== root) {
      root = parent.get(root);
    }

    // 経路圧縮
    let current = key;

    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }

    return root;
  };

  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);

    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  };

  const pinIndexOf = (endpoint) => {
    if (!endpoint) return -1;

    const component = components.find((c) => c.id === endpoint.componentId);

    if (!component) return -1;

    const names = safePinNames(component.type);

    if (typeof endpoint.pin === "number") {
      return endpoint.pin >= 0 && endpoint.pin < names.length
        ? endpoint.pin
        : -1;
    }

    return names.indexOf(String(endpoint.pin));
  };

  for (const wire of state.board.wires) {
    const fromIndex = pinIndexOf(wire.from);
    const toIndex = pinIndexOf(wire.to);

    if (fromIndex < 0 || toIndex < 0) continue;
    if (
      wire.from.componentId === wire.to.componentId &&
      fromIndex === toIndex
    ) {
      continue;
    }

    union(
      keyOf(wire.from.componentId, fromIndex),
      keyOf(wire.to.componentId, toIndex)
    );
  }

  // グループごとのネット名を決定
  const groupInfo = new Map(); // rootKey -> { name, locked, hasGround, size }
  const usedNames = new Set();

  const getGroup = (rootKey) => {
    if (!groupInfo.has(rootKey)) {
      groupInfo.set(rootKey, { name: null, locked: false, hasGround: false, size: 0 });
    }

    return groupInfo.get(rootKey);
  };

  for (const component of components) {
    const names = safePinNames(component.type);
    const connect = Array.isArray(component.connect)
      ? component.connect
      : [];

    for (let i = 0; i < names.length; i += 1) {
      const rootKey = find(keyOf(component.id, i));
      const group = getGroup(rootKey);
      group.size += 1;

      // GND 部品がつながったグループは接地ネットとして扱う
      if (component.type === "GND") {
        group.hasGround = true;
      }

      const existing = typeof connect[i] === "string" ? connect[i].trim() : "";

      if (!existing) continue;

      usedNames.add(existing);

      // 固定部品の名前を優先、それ以外は最初に見つけた名前
      if (!group.name || (component.locked && !group.locked)) {
        group.name = existing;
      }

      if (component.locked) {
        group.locked = true;
      }
    }
  }

  // GND 部品につながったグループは、固定部品が名前を持っている場合を除き
  // ネット名を "gnd" にする。これにより DC 解析の基準ノードが保証される。
  for (const group of groupInfo.values()) {
    if (group.hasGround && !group.locked) {
      group.name = "gnd";
      usedNames.add("gnd");
    }
  }

  // 名前のないグループ（ワイヤで結合されたもの）に自動採番
  let autoIndex = 1;

  for (const group of groupInfo.values()) {
    if (!group.name && group.size >= 2) {
      let candidate = `net${autoIndex}`;

      while (usedNames.has(candidate)) {
        autoIndex += 1;
        candidate = `net${autoIndex}`;
      }

      group.name = candidate;
      usedNames.add(candidate);
      autoIndex += 1;
    }
  }

  // connect 配列へ書き込み
  for (const component of components) {
    const names = safePinNames(component.type);

    if (names.length === 0) continue;

    const connect = Array.isArray(component.connect)
      ? [...component.connect]
      : [];
    let dirty = false;

    while (connect.length < names.length) {
      connect.push("");
      dirty = true;
    }

    for (let i = 0; i < names.length; i += 1) {
      const rootKey = find(keyOf(component.id, i));
      const group = groupInfo.get(rootKey);
      const name = group?.name ?? null;

      if (name && connect[i] !== name) {
        connect[i] = name;
        dirty = true;
      }
    }

    if (dirty) {
      updateComponent(component.id, { connect });
    }
  }
}

/* ==========================================================================
   インスペクタ
   ========================================================================== */

function renderInspector(root, state) {
  const inspector = root.querySelector("#inspector");
  if (!inspector) return;

  const selectedComponent =
    state.selection.kind === "component"
      ? state.board.components.find(
          (component) => component.id === state.selection.id
        )
      : null;

  const knownNets = collectKnownNets(state);

  // datalist はインスペクタ描画ごとに 1 つだけ用意
  const datalistHtml = `
    <datalist id="known-nets-datalist">
      ${knownNets
        .map((net) => `<option value="${escapeHtml(net)}"></option>`)
        .join("")}
    </datalist>
  `;

  let html = `<h2 class="pane-title">インスペクタ</h2>`;
  html += datalistHtml;

  if (!selectedComponent) {
    html += `
      <p class="inspector-empty">
        ボード上の部品を選択すると、詳細とパラメータ編集が表示されます。
      </p>
    `;
  } else {
    html += renderComponentInspector(selectedComponent, knownNets);
  }

  html += renderSimulationResults(state);
  html += renderCheckResults(state);

  inspector.innerHTML = html;

  if (selectedComponent) {
    bindParamInputs(root, selectedComponent);
    bindIdInput(root, selectedComponent);
    bindConnectInputs(root, selectedComponent);
  }

  bindRotateSelected(root);
  bindDeleteSelected(root);
}

/**
 * インスペクタの回転ボタンのイベントをバインドします。
 *
 * @param {HTMLElement} root
 */
function bindRotateSelected(root) {
  root.querySelectorAll("[data-rotate-selected]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.rotateSelected;
      const delta = Number(button.dataset.rotateDelta ?? 90);

      rotateComponent(id, Number.isFinite(delta) ? delta : 90);
    });
  });
}

function renderComponentInspector(component, knownNets = []) {
  const paramDefinitions = componentRegistry.has(component.type)
    ? componentRegistry.getParamDefinitions(component.type)
    : [];

  const isLocked = Boolean(component.locked);
  const disabledAttr = isLocked ? "disabled" : "";

  const idField = `
    <div class="field">
      <label class="field-label" for="param-id-field">ID</label>
      <input
        id="param-id-field"
        data-edit-id="true"
        type="text"
        value="${escapeHtml(component.id)}"
        ${disabledAttr}
      />
      ${
        isLocked
          ? `<div class="field-help">固定部品のため変更できません。</div>`
          : `<div class="field-help">部品IDを変更できます（例: RL, C2）。</div>`
      }
    </div>
  `;

  const paramFields = paramDefinitions
    .map((param) => {
      const rawValue = component.params?.[param.key] ?? "";
      return `
        <div class="field">
          <label class="field-label" for="param-${escapeHtml(param.key)}">
            ${escapeHtml(param.labelJa ?? param.key)}
            ${param.unit ? `(${escapeHtml(param.unit)})` : ""}
          </label>
          <input
            id="param-${escapeHtml(param.key)}"
            data-param-key="${escapeHtml(param.key)}"
            type="text"
            value="${escapeHtml(rawValue)}"
            ${disabledAttr}
          />
          <div class="field-help">
            例: 10k, 100n, 4.7u
          </div>
        </div>
      `;
    })
    .join("");

  const connectFields = renderConnectFields(component, isLocked);

  const rotationDeg = getRotation(component);
  const rotationText = `${rotationDeg}°`;

  const rotationSection = `
    <div class="inspector-section">
      <h3 class="inspector-title">回転</h3>
      <div class="rotation-controls">
        <button data-rotate-selected="${escapeHtml(component.id)}" data-rotate-delta="-90" title="反時計回りに 90 度回転（Shift+R）">
          ⟲ 反時計 90°
        </button>
        <button data-rotate-selected="${escapeHtml(component.id)}" data-rotate-delta="90" title="時計回りに 90 度回転（R）">
          ⟳ 時計回り 90°
        </button>
        <span class="rotation-value">現在: ${escapeHtml(rotationText)}</span>
      </div>
      <div class="field-help">回転しても接続（ネット名）は変わりません。ボード上では R キーでも回転できます。</div>
    </div>
  `;

  const deleteSection = isLocked
    ? ""
    : `
      <div class="inspector-section">
        <h3 class="inspector-title">操作</h3>
        <button class="danger" data-delete-selected="${escapeHtml(component.id)}">
          この部品を削除
        </button>
      </div>
    `;

  return `
    <div class="panel">
      <h3 class="panel-title">${escapeHtml(component.id)}</h3>

      <table class="property-table">
        <tbody>
          <tr>
            <th>ID</th>
            <td>${escapeHtml(component.id)}</td>
          </tr>
          <tr>
            <th>種類</th>
            <td>${escapeHtml(component.type)}</td>
          </tr>
          <tr>
            <th>回転</th>
            <td>${escapeHtml(rotationText)}</td>
          </tr>
          <tr>
            <th>固定</th>
            <td>${component.locked ? "はい" : "いいえ"}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="inspector-section">
      <h3 class="inspector-title">識別子</h3>
      ${idField}
    </div>

    <div class="inspector-section">
      <h3 class="inspector-title">接続</h3>
      ${connectFields}
    </div>

    <div class="inspector-section">
      <h3 class="inspector-title">パラメータ</h3>
      ${
        paramFields ||
        `<p class="muted">編集可能なパラメータがありません。</p>`
      }
      ${
        isLocked
          ? `<p class="muted">固定部品のためパラメータは変更できません。</p>`
          : ""
      }
    </div>

    ${rotationSection}

    ${deleteSection}
  `;
}

/**
 * 接続ネット編集フィールドを描画します。
 *
 * 部品の各ピンに対して、接続先のネット名を入力する欄を表示します。
 * 配線モードでワイヤを引くと自動で設定されます。
 *
 * @param {object} component
 * @param {boolean} isLocked
 * @returns {string}
 */
function renderConnectFields(component, isLocked) {
  if (!componentRegistry.has(component.type)) {
    return `<p class="muted">接続先を定義できません（未登録の部品種別です）。</p>`;
  }

  const pinNames = componentRegistry.getPinNames(component.type);

  if (!Array.isArray(pinNames) || pinNames.length === 0) {
    return `<p class="muted">この部品にはピンがありません。</p>`;
  }

  const connect = Array.isArray(component.connect) ? component.connect : [];
  const disabledAttr = isLocked ? "disabled" : "";

  const fields = pinNames
    .map((pinName, index) => {
      const netValue = connect[index] ?? "";
      return `
        <div class="field">
          <label class="field-label" for="connect-pin-${index}">
            ピン ${escapeHtml(pinName)}
          </label>
          <input
            id="connect-pin-${index}"
            data-connect-index="${index}"
            type="text"
            value="${escapeHtml(netValue)}"
            placeholder="例: vin, gnd, out"
            list="known-nets-datalist"
            ${disabledAttr}
          />
        </div>
      `;
    })
    .join("");

  const helpText = isLocked
    ? `<div class="field-help">固定部品のため変更できません。</div>`
    : `<div class="field-help">
        接続するネット名を入力してください。候補から選ぶこともできます。<br>
        <b>配線モード</b>でワイヤを引くと自動で設定されます。
      </div>`;

  return fields + helpText;
}

function bindParamInputs(root, component) {
  if (component.locked) return;

  root.querySelectorAll("[data-param-key]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.paramKey;

      let nextValue;

      try {
        nextValue = componentRegistry.coerceParamValue(
          component.type,
          key,
          input.value
        );
      } catch (error) {
        nextValue = input.value;
      }

      updateComponent(component.id, {
        params: {
          ...component.params,
          [key]: nextValue,
        },
      });

      setStatus(`${component.id} の ${key} を更新しました。`, "info");
    });
  });
}

function bindIdInput(root, component) {
  if (component.locked) return;

  const input = root.querySelector("[data-edit-id]");
  if (!input) return;

  input.addEventListener("change", () => {
    const newId = input.value.trim();

    if (!newId || newId === component.id) {
      input.value = component.id;
      return;
    }

    if (!renameComponent(component.id, newId)) {
      input.value = component.id;
    }
  });
}

/**
 * 接続ネット入力欄のイベントをバインドします。
 *
 * change 時に全ピンの値を収集し、末尾の空文字をトリムして保存します。
 *
 * @param {HTMLElement} root
 * @param {object} component
 */
function bindConnectInputs(root, component) {
  if (component.locked) return;
  if (!componentRegistry.has(component.type)) return;

  const inputs = root.querySelectorAll("[data-connect-index]");
  if (inputs.length === 0) return;

  const inputCount = inputs.length;

  inputs.forEach((input) => {
    input.addEventListener("change", () => {
      // 現在の DOM から全ピンの値を収集
      const values = [];
      root.querySelectorAll("[data-connect-index]").forEach((el) => {
        const i = Number(el.dataset.connectIndex);
        if (Number.isFinite(i)) {
          values[i] = String(el.value ?? "").trim();
        }
      });

      // 未入力のピンは空文字で埋める
      for (let i = 0; i < inputCount; i += 1) {
        if (values[i] === undefined) values[i] = "";
      }

      // 末尾の空文字だけトリム（中間の空文字は保持）
      while (values.length > 0 && values[values.length - 1] === "") {
        values.pop();
      }

      updateComponent(component.id, { connect: values });

      const summary =
        values.length > 0 ? values.join(", ") : "(未接続)";

      setStatus(
        `${component.id} の接続を [${summary}] に更新しました。`,
        "info"
      );
    });
  });
}

function bindDeleteSelected(root) {
  root.querySelectorAll("[data-delete-selected]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.deleteSelected;
      const comp = getState().board.components.find((c) => c.id === id);

      if (!comp) return;

      if (comp.locked) {
        setStatus("固定部品は削除できません。", "warning");
        return;
      }

      removeComponent(id);
      setStatus(`部品 ${id} を削除しました。`, "info");
    });
  });
}

function renameComponent(oldId, newId) {
  const state = getState();
  const comp = state.board.components.find((c) => c.id === oldId);

  if (!comp || comp.locked || oldId === newId) {
    return false;
  }

  if (state.board.components.some((c) => c.id === newId)) {
    setError(`ID ${newId} は既に使用されています。`);
    return false;
  }

  // リネーム対象部品に接続されているワイヤを退避
  const affectedWires = state.board.wires.filter(
    (wire) =>
      wire.from?.componentId === oldId || wire.to?.componentId === oldId
  );

  const snapshot = {
    type: comp.type,
    params: { ...(comp.params ?? {}) },
    connect: Array.isArray(comp.connect) ? [...comp.connect] : [],
    position: comp.position ? { ...comp.position } : null,
    rotation: getRotation(comp),
    locked: false,
  };

  removeComponent(oldId);
  addComponent({ ...snapshot, id: newId });

  // ワイヤを新しいIDで付け替え
  for (const wire of affectedWires) {
    addWire({
      id: wire.id,
      from:
        wire.from?.componentId === oldId
          ? { componentId: newId, pin: wire.from.pin }
          : wire.from
            ? { ...wire.from }
            : null,
      to:
        wire.to?.componentId === oldId
          ? { componentId: newId, pin: wire.to.pin }
          : wire.to
            ? { ...wire.to }
            : null,
      points: wire.points,
      locked: wire.locked,
    });
  }

  syncConnectFromWires();
  selectComponent(newId);

  setStatus(
    `部品 ID を ${oldId} から ${newId} に変更しました。`,
    "info"
  );

  return true;
}

/* ==========================================================================
   シミュレーション結果パネル
   ========================================================================== */

/** 結果テーブルに表示する最大行数。 */
const SIM_MAX_ROWS = 12;

/**
 * 結果メッセージ（エラー / 警告）のリスト HTML を生成します。
 *
 * @param {unknown} messages
 * @param {string} className
 * @returns {string}
 */
function buildSimMessageList(messages, className) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const items = messages
    .map((message) => `<li>${escapeHtml(String(message))}</li>`)
    .join("");

  return `<ul class="sim-messages ${className}">${items}</ul>`;
}

/**
 * 汎用の結果テーブル HTML を生成します。
 *
 * @param {string[]} headers
 * @param {string[][]} rows 各セルは呼び出し側で escapeHtml 済みの文字列
 * @param {number} [overflow] 表示しきれなかった行数
 * @returns {string}
 */
function buildSimTable(headers, rows, overflow = 0) {
  if (rows.length === 0) {
    return "";
  }

  const thead = `<thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("")}</tr></thead>`;

  const tbody = `<tbody>${rows
    .map(
      (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`
    )
    .join("")}</tbody>`;

  const more = overflow > 0 ? `<p class="sim-more">＋ 他 ${overflow} 件</p>` : "";

  return `<table class="sim-table">${thead}${tbody}</table>${more}`;
}

/**
 * 数値を単位付きの表示文字列へ整形します。
 *
 * @param {number} value
 * @param {string} unit
 * @returns {string}
 */
function simValue(value, unit) {
  return escapeHtml(formatMetricValue(value, unit));
}

/**
 * シミュレーション結果パネルの HTML を生成します。
 *
 * 「シミュレーション」ボタンの実行結果はここに表示される。
 * - エラー / 警告（バリデーションエラーや未実装モードの警告など）
 * - DC: ノード電圧・素子の電圧 / 電流 / 電力
 * - AC: ノード電圧の振幅と位相・素子電流
 * - 過渡解析: 概要とノードの最終電圧
 *
 * @param {object} state
 * @returns {string}
 */
function renderSimulationResults(state) {
  const sim = state.simulation;

  if (sim.error) {
    return `
      <div class="inspector-section sim-result is-ng">
        <h3 class="inspector-title">シミュレーション結果</h3>
        <p class="sim-message-error">${escapeHtml(sim.error)}</p>
      </div>
    `;
  }

  const result = sim.result;

  if (!result) {
    return "";
  }

  const mode = String(result.mode ?? "dc").toUpperCase();
  const badge = result.ok
    ? `<span class="badge badge-success">OK</span>`
    : `<span class="badge badge-danger">NG</span>`;

  const errorsHtml = buildSimMessageList(result.errors, "sim-messages-error");
  const warningsHtml = buildSimMessageList(
    result.warnings,
    "sim-messages-warning"
  );

  let dataHtml = "";

  /* --- DC 解析 --- */
  const dcNodes = Object.entries(result.dc?.nodes ?? {});
  const dcElements = Object.entries(result.dc?.elements ?? {});

  if (dcNodes.length > 0) {
    const shown = dcNodes.slice(0, SIM_MAX_ROWS);

    dataHtml += `
      <h4 class="sim-table-title">ノード電圧</h4>
      ${buildSimTable(
        ["ネット", "電圧"],
        shown.map(([net, voltage]) => [escapeHtml(net), simValue(voltage, "V")]),
        dcNodes.length - shown.length
      )}
    `;
  }

  if (dcElements.length > 0) {
    const shown = dcElements.slice(0, SIM_MAX_ROWS);

    dataHtml += `
      <h4 class="sim-table-title">素子の電圧・電流・電力</h4>
      ${buildSimTable(
        ["素子", "電圧", "電流", "電力"],
        shown.map(([id, data]) => [
          escapeHtml(id),
          simValue(data?.v ?? 0, "V"),
          simValue(data?.i ?? 0, "A"),
          simValue(data?.p ?? 0, "W"),
        ]),
        dcElements.length - shown.length
      )}
    `;
  }

  /* --- AC 解析 --- */
  const acNodes = Object.entries(result.ac?.nodes ?? {});
  const acElements = Object.entries(result.ac?.elements ?? {});
  const primaryFrequency = result.ac?.primaryFrequency;

  if (acNodes.length > 0) {
    const frequencyLabel = Number.isFinite(primaryFrequency)
      ? ` ${formatMetricValue(primaryFrequency, "Hz")}`
      : "";
    const rows = [];

    for (const [net, freqMap] of acNodes) {
      for (const [freq, value] of Object.entries(freqMap ?? {})) {
        rows.push([
          escapeHtml(net),
          escapeHtml(formatMetricValue(Number(freq), "Hz")),
          simValue(value?.peak ?? 0, "V"),
          simValue(value?.phaseDeg ?? 0, "deg"),
        ]);
      }
    }

    const shown = rows.slice(0, SIM_MAX_ROWS);

    dataHtml += `
      <h4 class="sim-table-title">ノード電圧（AC${escapeHtml(frequencyLabel)}）</h4>
      ${buildSimTable(
        ["ネット", "周波数", "振幅(peak)", "位相"],
        shown,
        rows.length - shown.length
      )}
    `;
  }

  if (acElements.length > 0) {
    const rows = [];

    for (const [id, freqMap] of acElements) {
      for (const [freq, value] of Object.entries(freqMap ?? {})) {
        rows.push([
          escapeHtml(id),
          escapeHtml(formatMetricValue(Number(freq), "Hz")),
          simValue(value?.i?.peak ?? 0, "A"),
          simValue(value?.p?.re ?? 0, "W"),
        ]);
      }
    }

    const shown = rows.slice(0, SIM_MAX_ROWS);

    dataHtml += `
      <h4 class="sim-table-title">素子電流（AC）</h4>
      ${buildSimTable(
        ["素子", "周波数", "電流振幅", "有効電力"],
        shown,
        rows.length - shown.length
      )}
    `;
  }

  /* --- 過渡解析 --- */
  const tr = result.transient;

  if (tr && Array.isArray(tr.time) && tr.time.length > 0) {
    const summaryRows = [
      ["計算時間", simValue(tr.tStop ?? 0, "s")],
      ["ステップ数", escapeHtml(String(tr.steps ?? tr.time.length))],
    ];

    if (Number.isFinite(tr.timeConstant)) {
      summaryRows.push(["時定数", simValue(tr.timeConstant, "s")]);
    }

    if (Number.isFinite(tr.oscillationFrequencyHz)) {
      summaryRows.push(["発振周波数", simValue(tr.oscillationFrequencyHz, "Hz")]);
    }

    dataHtml += `
      <h4 class="sim-table-title">過渡解析の概要</h4>
      ${buildSimTable(["項目", "値"], summaryRows, 0)}
    `;

    const nodeRows = [];
    const last = tr.time.length - 1;

    for (const [net, values] of Object.entries(tr.nodes ?? {})) {
      if (!Array.isArray(values) || values.length === 0) continue;

      nodeRows.push([escapeHtml(net), simValue(values[last], "V")]);
    }

    if (nodeRows.length > 0) {
      const shown = nodeRows.slice(0, SIM_MAX_ROWS);

      dataHtml += `
        <h4 class="sim-table-title">ノード最終電圧</h4>
        ${buildSimTable(
          ["ネット", "最終電圧"],
          shown,
          nodeRows.length - shown.length
        )}
      `;
    }
  }

  if (!dataHtml && result.ok) {
    dataHtml = `<p class="muted">表示できる結果データがありません。</p>`;
  }

  return `
    <div class="inspector-section sim-result ${result.ok ? "is-ok" : "is-ng"}">
      <h3 class="inspector-title">
        シミュレーション結果 <span class="sim-mode">${escapeHtml(mode)}</span> ${badge}
      </h3>
      ${errorsHtml}
      ${warningsHtml}
      ${dataHtml}
    </div>
  `;
}

/* ==========================================================================
   チェック結果 / ステータス
   ========================================================================== */

function renderCheckResults(state) {
  const results = state.checks.results;

  if (!Array.isArray(results) || results.length === 0) {
    return "";
  }

  const summary = summarizeCheckResults(results);

  const items = results
    .map((result) => {
      const badge = result.ok
        ? `<span class="badge badge-success">OK</span>`
        : `<span class="badge badge-danger">NG</span>`;

      const itemClass = result.ok ? "is-ok" : "is-ng";

      return `
        <div class="check-item ${itemClass}">
          <div class="check-item-header">
            <span>#${result.index + 1} ${escapeHtml(result.type)}</span>
            ${badge}
          </div>
          <div class="check-item-message">
            ${escapeHtml(result.message)}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="inspector-section">
      <h3 class="inspector-title">チェック結果</h3>
      <p class="muted">
        合格 ${summary.passed} / ${summary.total}
      </p>
      <div class="check-list">
        ${items}
      </div>
    </div>
  `;
}

function renderStatus(root, state) {
  const status = root.querySelector("#status");
  if (!status) return;

  const checkSummary = summarizeCheckResults(state.checks.results);

  const simulationText = state.simulation.running
    ? "シミュレーション中"
    : state.simulation.error
      ? "シミュレーションエラー"
      : state.simulation.result
        ? state.simulation.result.ok
          ? "シミュレーションOK"
          : "シミュレーションNG"
        : "シミュレーション未実行";

  const checkText = state.checks.running
    ? "チェック中"
    : checkSummary.total > 0
      ? `チェック ${checkSummary.passed}/${checkSummary.total}`
      : "チェック未実行";

  const problemText = state.currentProblem
    ? `問題 ${state.currentProblem.id}`
    : "問題未選択";

  const message = state.ui.error
    ? state.ui.error
    : state.ui.status || "準備完了";

  status.innerHTML = `
    <div class="app-status-left">
      <span class="app-status-item">${escapeHtml(message)}</span>
    </div>
    <div class="app-status-right">
      <span class="app-status-item">${escapeHtml(problemText)}</span>
      <span class="app-status-item">${escapeHtml(simulationText)}</span>
      <span class="app-status-item">${escapeHtml(checkText)}</span>
    </div>
  `;
}

/* ==========================================================================
   シミュレーション / チェック実行
   ========================================================================== */

async function handleSimulate() {
  const state = getState();

  if (state.board.components.length === 0) {
    setStatus(
      "ボードに部品がありません。パレットから部品を配置してから実行してください。",
      "warning"
    );
    return;
  }

  startSimulation();
  setStatus("シミュレーションを実行しています...", "info");

  try {
    const result = await simulate(state, {
      mode: state.currentProblem?.judge ?? "dc",
      checks: state.currentProblem?.checks ?? [],
    });

    setSimulationResult(result);

    if (result.ok) {
      setStatus(
        "シミュレーション完了。結果を右のインスペクタに表示しました。",
        "success"
      );
    } else {
      const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
      const warningCount = Array.isArray(result.warnings)
        ? result.warnings.length
        : 0;

      setStatus(
        `シミュレーション完了（エラー ${errorCount} 件 / 警告 ${warningCount} 件）。詳細は右のインスペクタを確認してください。`,
        "warning"
      );
    }
  } catch (error) {
    setSimulationError(error?.message ?? String(error));
    setError(error?.message ?? String(error));
    setStatus("シミュレーションに失敗しました。", "error");
  }
}

async function handleCheck() {
  const state = getState();

  if (!state.currentProblem) {
    setStatus(
      "問題が読み込まれていません。チェックを実行するには問題を読み込んでください。",
      "warning"
    );
    return;
  }

  startChecks();
  setStatus("チェックを実行しています...", "info");

  try {
    const simulationResult = await simulate(state, {
      mode: state.currentProblem.judge ?? "dc",
      checks: state.currentProblem.checks ?? [],
    });

    setSimulationResult(simulationResult);

    const { answers, errors: answerErrors } = collectAnswers(state.currentProblem);

    if (answerErrors.length > 0) {
      setCheckResults([]);
      setStatus(answerErrors.join(" / "), "warning");
      return;
    }

    const results = await runChecks(
      state.currentProblem,
      simulationResult,
      state.board,
      { answers }
    );

    const summary = summarizeCheckResults(results);

    if (summary.ok) {
      markSolved(state.currentProblem.id);
      openModal("clear");
    }

    setCheckResults(results);

    if (summary.ok) {
      setStatus("すべてのチェックに合格しました。クリア！", "success");
    } else {
      setStatus(
        `${summary.failed} 件のチェックに不合格です。`,
        "warning"
      );
    }
  } catch (error) {
    setCheckResults([]);
    setError(error?.message ?? String(error));
    setStatus("チェックに失敗しました。", "error");
  }
}

/* ==========================================================================
   クリア
   ========================================================================== */

function handleClear() {
  const state = getState();

  const fixedIds = new Set(
    (state.currentProblem?.fixedComponents ?? []).map((c) => c.id)
  );

  const removable = state.board.components.filter(
    (c) => !c.locked && !fixedIds.has(c.id)
  );

  if (removable.length === 0) {
    setStatus(
      "クリアする解答部品がありません（固定部品のみ残っています）。",
      "info"
    );
    return;
  }

  for (const c of removable) {
    removeComponent(c.id);
  }

  syncConnectFromWires();

  setStatus(
    `${removable.length} 個の解答部品をクリアしました。`,
    "info"
  );
}

/* ==========================================================================
   グローバルキーボード操作
   ========================================================================== */

function bindGlobalKeyboard() {
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;

    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.isContentEditable)
    ) {
      return;
    }

    if (event.key === "Escape") {
      if (getModal()) {
        openModal(null);
        forceRender();
      } else if (wireDraft) {
        wireDraft = null;
        setStatus("配線を取り消しました。", "info");
        forceRender();
      } else if (problemMenu.open) {
        problemMenu.open = false;
        forceRender();
      }

      return;
    }

    if (event.key === "r" || event.key === "R") {
      const selection = getState().selection;

      if (selection.kind === "component") {
        rotateComponent(selection.id, event.shiftKey ? -90 : 90);
      }

      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      const selection = getState().selection;

      if (!selection.kind) return;

      if (selection.kind === "wire") {
        removeWire(selection.id);
        syncConnectFromWires();
        setStatus("ワイヤを削除しました。", "info");
        return;
      }

      if (selection.kind === "component") {
        const component = getComponentById(selection.id);

        if (!component) return;

        if (component.locked) {
          setStatus("固定部品は削除できません。", "warning");
          return;
        }

        removeComponent(component.id);
        setStatus(`部品 ${component.id} を削除しました。`, "info");
      }
    }
  });
}

/**
 * 問題メニューの外側クリックで閉じるようにします。
 */
function bindOutsideClick() {
  document.addEventListener("pointerdown", (event) => {
    if (!problemMenu.open) return;

    const target = event.target;

    if (
      target.closest?.(".problem-menu") ||
      target.closest?.('[data-action="problems"]')
    ) {
      return;
    }

    problemMenu.open = false;
    forceRender();
  });
}

/* ==========================================================================
   起動
   ========================================================================== */

export function createApp(root) {
  let destroyed = false;

  const unsubscribeStateChanged = eventBus.on("state:changed", () => {
    if (!destroyed) {
      render(root);
    }
  });

  bindGlobalKeyboard();
  bindOutsideClick();

  // デバッグ / テスト用フック
  window.__game = {
    getState,
    addComponent,
    addWire,
    removeWire,
    selectComponent,
    syncConnectFromWires,
    componentRegistry,
    rotateComponent,
  };

  render(root);

  loadGameData()
    .then((data) => {
      componentRegistry.load(data.components);

      setGameData(data);

      const initialCategory = CONFIG.ui.initialCategory ?? null;
      setCurrentCategory(initialCategory);
      setBooted(true);
      setStatus("共通データを読み込みました。", "success");

      if (initialCategory) {
        void loadProblemsForCategory(initialCategory);
      }
    })
    .catch((error) => {
      console.error(error);

      setError(error?.message ?? String(error));
      setStatus("共通データの読み込みに失敗しました。", "error");
    });

  return {
    destroy() {
      destroyed = true;
      unsubscribeCurrentStateChanged();
      unsubscribeStateChanged();
    },
  };
}

/* destroy() 内で参照するダミー（未使用警告防止・将来拡張用） */
function unsubscribeCurrentStateChanged() {
  /* no-op */
}
