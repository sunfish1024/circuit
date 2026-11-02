/**
 * 学習まわりの UI 部品です。
 *
 * - 進捗の保存（localStorage）
 * - 問題パネル（問題文・段階ヒント・回答入力）
 * - クリア表示 / 解説 / 「答えを見る」モーダル
 *
 * app.js は state 変更のたびに全体を innerHTML で再描画するため、
 * このモジュールの表示状態（ヒント段階・入力中の回答など）はモジュール内に保持します。
 */

import { CONFIG, getStorageKey } from "../config.js";
import { parseMetricWithUnit, formatMetricValue } from "../core/units.js";
import { renderMarkdown } from "./markdown.js";

/* ==========================================================================
   進捗（localStorage）
   ========================================================================== */

const PROGRESS_VERSION = 1;

function readProgress() {
  try {
    const raw = localStorage.getItem(getStorageKey("progress"));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.version === PROGRESS_VERSION && parsed.problems) {
      return parsed;
    }
  } catch {
    /* 読めない場合は空として扱う */
  }
  return { version: PROGRESS_VERSION, problems: {} };
}

let progress = readProgress();

function writeProgress() {
  try {
    localStorage.setItem(getStorageKey("progress"), JSON.stringify(progress));
  } catch {
    /* プライベートモードなどで保存できなくてもゲームは続行 */
  }
}

/**
 * @param {string} problemId
 * @returns {{solved?: boolean, solvedAt?: string, viewedAnswer?: boolean, hintsUsed?: number} | null}
 */
export function getProblemProgress(problemId) {
  return progress.problems[problemId] ?? null;
}

function patchProgress(problemId, patch) {
  progress.problems[problemId] = { ...(progress.problems[problemId] ?? {}), ...patch };
  writeProgress();
}

export function markSolved(problemId) {
  const prev = getProblemProgress(problemId);
  patchProgress(problemId, {
    solved: true,
    solvedAt: prev?.solvedAt ?? new Date().toISOString(),
  });
}

export function countSolved(problemIds) {
  return problemIds.filter((id) => progress.problems[id]?.solved).length;
}

export function resetAllProgress() {
  progress = { version: PROGRESS_VERSION, problems: {} };
  writeProgress();
}

/* ==========================================================================
   問題ごとの表示状態
   ========================================================================== */

const view = {
  problemId: null,
  hintLevel: 0,
  answers: {}, // key -> 入力文字列 or 選択肢インデックス
  collapsed: false,
  modal: null, // null | "clear" | "answer" | "confirmAnswer"
};

export function resetProblemView(problem) {
  view.problemId = problem?.id ?? null;
  view.hintLevel = 0;
  view.answers = {};
  view.modal = null;
}

export function openModal(kind) {
  view.modal = kind;
}

export function getModal() {
  return view.modal;
}

/**
 * 問題の hints（配列）を返します。旧形式 hint（文字列）にも対応。
 */
function getHints(problem) {
  if (Array.isArray(problem?.hints)) {
    return problem.hints.filter((h) => typeof h === "string" && h.trim());
  }
  if (typeof problem?.hint === "string" && problem.hint.trim()) {
    return [problem.hint];
  }
  return [];
}

/**
 * チェックに渡す回答オブジェクトを作ります。
 * numeric は SI 接頭辞付き入力（例: "12.5m"）を数値に変換します。
 *
 * @returns {{answers: object, errors: string[]}}
 */
export function collectAnswers(problem) {
  const answers = {};
  const errors = [];

  for (const q of problem?.questions ?? []) {
    const raw = view.answers[q.key];
    if (raw === undefined || raw === "") continue;

    if (q.kind === "numeric") {
      const parsed = parseMetricWithUnit(String(raw));
      if (Number.isFinite(parsed.baseValue)) {
        answers[q.key] = parsed.baseValue;
      } else {
        errors.push(`「${q.prompt ?? q.key}」の数値を読み取れません: ${raw}`);
      }
    } else if (q.kind === "choice") {
      answers[q.key] = Number(raw);
    } else {
      answers[q.key] = raw;
    }
  }

  return { answers, errors };
}

/* ==========================================================================
   問題パネル
   ========================================================================== */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderQuestions(problem) {
  const questions = problem.questions ?? [];
  if (questions.length === 0) return "";

  const items = questions
    .map((q, qi) => {
      const prompt = renderMarkdown(q.prompt ?? "");
      if (q.kind === "choice") {
        const options = (q.options ?? [])
          .map((opt, oi) => {
            const checked = String(view.answers[q.key]) === String(oi) ? "checked" : "";
            return `
              <label class="answer-choice">
                <input type="radio" name="answer-${esc(q.key)}" value="${oi}" data-answer-key="${esc(q.key)}" ${checked} />
                <span>${renderMarkdown(opt)}</span>
              </label>`;
          })
          .join("");
        return `<div class="answer-item"><div class="answer-prompt"><span class="answer-no">Q${qi + 1}</span>${prompt}</div>${options}</div>`;
      }

      const value = view.answers[q.key] ?? "";
      return `
        <div class="answer-item">
          <div class="answer-prompt"><span class="answer-no">Q${qi + 1}</span>${prompt}</div>
          <label class="answer-numeric">
            <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
              data-answer-key="${esc(q.key)}" value="${esc(value)}" placeholder="例: 12.5m（接頭辞 k, m, u, n が使えます）" />
            <span class="answer-unit">${esc(q.unit ?? "")}</span>
          </label>
        </div>`;
    })
    .join("");

  return `
    <section class="problem-answers">
      <h3 class="problem-sec-title">回答欄</h3>
      ${items}
      <p class="muted small">入力したら上の「チェック」を押してください。</p>
    </section>`;
}

function renderHints(problem) {
  const hints = getHints(problem);
  if (hints.length === 0) return "";

  const shown = hints
    .slice(0, view.hintLevel)
    .map(
      (h, i) => `
        <div class="hint-step">
          <div class="hint-label">ヒント ${i + 1} / ${hints.length}</div>
          <div class="md">${renderMarkdown(h)}</div>
        </div>`
    )
    .join("");

  const labels = ["方針を見る", "使う式を見る", "ほぼ答えを見る"];
  const nextLabel =
    view.hintLevel < hints.length
      ? `<button class="small" data-learning="hint">ヒント ${view.hintLevel + 1}: ${labels[view.hintLevel] ?? "次のヒント"}</button>`
      : "";

  return `
    <section class="problem-hints">
      ${shown}
      <div class="problem-actions-row">
        ${nextLabel}
      </div>
    </section>`;
}

/**
 * 問題パネルの HTML を返します。
 */
export function renderProblemPanelHtml(problem, { solved }) {
  if (view.problemId !== problem.id) {
    resetProblemView(problem);
  }

  const difficulty = Number.isFinite(problem.difficulty)
    ? `<span class="badge">Lv.${esc(problem.difficulty)}</span>`
    : "";
  const solvedBadge = solved ? `<span class="badge badge-success">クリア済み</span>` : "";
  const hasExplanation = Boolean(problem.explanation);

  const body = view.collapsed
    ? ""
    : `
      <div class="problem-body">
        <div class="md problem-statement">${renderMarkdown(problem.statement)}</div>
        ${renderQuestions(problem)}
        ${renderHints(problem)}
      </div>`;

  return `
    <div class="board-problem-panel ${view.collapsed ? "is-collapsed" : ""}">
      <div class="problem-head">
        <h2 class="panel-title">${esc(problem.id)}: ${esc(problem.title)}</h2>
        ${difficulty}${solvedBadge}
        <span class="spacer"></span>
        ${
          solved && hasExplanation
            ? `<button class="small" data-learning="explain">解説を読む</button>`
            : `<button class="small" data-learning="reveal">答えを見る</button>`
        }
        <button class="small" data-learning="collapse" title="問題文の表示を切り替えます">${view.collapsed ? "問題文を開く ▾" : "たたむ ▴"}</button>
      </div>
      ${body}
    </div>`;
}

/* ==========================================================================
   モーダル（クリア / 答え / 解説）
   ========================================================================== */

const EXPLANATION_SECTIONS = [
  ["solution", "解き方"],
  ["why", "なぜそうなるか"],
  ["mistakes", "よくある間違い"],
  ["practice", "実務・応用"],
  ["next", "次につながる知識"],
];

function renderExplanation(problem) {
  const ex = problem.explanation;
  if (!ex) {
    return `<p class="muted">この問題にはまだ解説がありません。</p>`;
  }
  if (typeof ex === "string") {
    return `<div class="md">${renderMarkdown(ex)}</div>`;
  }
  return EXPLANATION_SECTIONS.filter(([key]) => ex[key])
    .map(
      ([key, label]) => `
        <section class="explain-sec explain-${key}">
          <h3 class="explain-title">${label}</h3>
          <div class="md">${renderMarkdown(ex[key])}</div>
        </section>`
    )
    .join("");
}

function formatParam(key, value, componentDefs) {
  if (typeof value !== "number") return `${key}=${esc(value)}`;
  const unit = componentDefs?.find?.((p) => p.key === key)?.unit ?? "";
  const unitLabel = { ohm: "Ω" }[unit] ?? unit;
  return `${esc(key)} = ${esc(formatMetricValue(value, unitLabel))}`;
}

function renderReferenceSolution(problem, getParamDefs) {
  const ref = problem.referenceSolution ?? [];
  const rows = ref
    .map((c) => {
      const defs = getParamDefs(c.type);
      const params = Object.entries(c.params ?? {})
        .map(([k, v]) => formatParam(k, v, defs))
        .join(", ");
      return `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.type)}</td><td>${params || "—"}</td><td>${(c.connect ?? []).map((n) => `<code>${esc(n)}</code>`).join(" – ")}</td></tr>`;
    })
    .join("");

  const answers = Object.entries(problem.referenceAnswers ?? {})
    .map(([key, value]) => {
      const q = (problem.questions ?? []).find((qq) => qq.key === key);
      let shown = esc(value);
      if (q?.kind === "choice") shown = renderMarkdown(q.options?.[value] ?? String(value));
      if (q?.kind === "numeric" && typeof value === "number") shown = esc(formatMetricValue(value, q.unit ?? ""));
      return `<li><b>${esc(key)}</b>: ${shown}</li>`;
    })
    .join("");

  return `
    ${
      rows
        ? `<div class="md-table-wrap"><table class="md-table ref-table">
            <thead><tr><th>ID</th><th>部品</th><th>値</th><th>つなぐ端子（ピン順）</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : ""
    }
    ${answers ? `<ul class="ref-answers">${answers}</ul>` : ""}`;
}

/**
 * モーダルの HTML を返します（非表示なら空文字）。
 */
export function renderModalHtml(problem, { nextProblem, getParamDefs }) {
  if (!problem || !view.modal) return "";

  if (view.modal === "confirmAnswer") {
    return `
      <div class="modal-backdrop" data-learning="close-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <h2 class="modal-title">答えを見ますか？</h2>
          <p>参照解と解説が表示されます。答えを見たあとも、自分で回路を組んでチェックに合格すればクリアになります。</p>
          <div class="modal-actions">
            <button data-learning="close">もう少し考える</button>
            <button class="primary" data-learning="show-answer">答えを見る</button>
          </div>
        </div>
      </div>`;
  }

  const isClear = view.modal === "clear";
  const head = isClear
    ? `<div class="clear-banner">CLEAR!</div>
       <h2 class="modal-title">${esc(problem.id)}: ${esc(problem.title)} をクリアしました</h2>`
    : view.modal === "answer"
      ? `<h2 class="modal-title">${esc(problem.id)} の答えと解説</h2>
         <section class="explain-sec"><h3 class="explain-title">参照解</h3>${renderReferenceSolution(problem, getParamDefs)}</section>`
      : `<h2 class="modal-title">${esc(problem.id)} の解説</h2>`;

  const nextButton = nextProblem
    ? `<button class="primary" data-learning="next">次の問題へ: ${esc(nextProblem.id)} ${esc(nextProblem.title ?? "")} →</button>`
    : isClear
      ? `<span class="muted">この分野の最後の問題です。</span>`
      : "";

  return `
    <div class="modal-backdrop" data-learning="close-backdrop">
      <div class="modal modal-wide" role="dialog" aria-modal="true">
        <button class="modal-x" data-learning="close" aria-label="閉じる">×</button>
        ${head}
        <div class="modal-scroll">
          ${renderExplanation(problem)}
        </div>
        <div class="modal-actions">
          <button data-learning="close">閉じる</button>
          ${nextButton}
        </div>
      </div>
    </div>`;
}

/**
 * 問題パネルとモーダルのイベントをバインドします。
 *
 * @param {HTMLElement} root
 * @param {{ rerender: () => void, onNext: () => void }} callbacks
 */
export function bindLearningEvents(root, { rerender, onNext }) {
  root.querySelectorAll("[data-learning]").forEach((el) => {
    const action = el.dataset.learning;

    el.addEventListener("click", (event) => {
      if (action === "close-backdrop") {
        if (event.target !== el) return;
        view.modal = null;
        rerender();
        return;
      }

      event.stopPropagation();

      switch (action) {
        case "hint":
          view.hintLevel = Math.min(view.hintLevel + 1, CONFIG.problem.maxHintSteps ?? 3);
          if (view.problemId) {
            const prev = getProblemProgress(view.problemId)?.hintsUsed ?? 0;
            patchProgress(view.problemId, { hintsUsed: Math.max(prev, view.hintLevel) });
          }
          break;
        case "collapse":
          view.collapsed = !view.collapsed;
          break;
        case "reveal":
          view.modal = "confirmAnswer";
          break;
        case "show-answer":
          view.modal = "answer";
          if (view.problemId) patchProgress(view.problemId, { viewedAnswer: true });
          break;
        case "explain":
          view.modal = "explain";
          break;
        case "close":
          view.modal = null;
          break;
        case "next":
          view.modal = null;
          onNext();
          return;
        default:
          return;
      }

      rerender();
    });
  });

  // 回答入力は再描画せずにモジュール状態へ保存（入力中のフォーカスを保つため）
  root.querySelectorAll("[data-answer-key]").forEach((input) => {
    const key = input.dataset.answerKey;
    const save = () => {
      if (input.type === "radio") {
        if (input.checked) view.answers[key] = input.value;
      } else {
        view.answers[key] = input.value;
      }
    };
    input.addEventListener("input", save);
    input.addEventListener("change", save);
    input.addEventListener("keydown", (e) => e.stopPropagation());
  });
}
