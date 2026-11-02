/**
 * アプリケーション起動エントリポイントです。
 *
 * 役割:
 * - #app の取得
 * - アプリ本体の動的読み込み
 * - 起動失敗時の表示
 * - 二重起動防止
 * - グローバルエラーの最低限の捕捉
 *
 * 方針:
 * - いきなり静的 import せず、動的 import で読み込む。
 *   これにより、読み込み失敗時のエラー表示をここで扱える。
 * - index.html 側の起動ガードと連携するため、
 *   起動できたら window.__APP_BOOTED__ = true を設定する。
 * - シミュレーションモードの登録完了（setupReady）を await してから
 *   UI を起動する。起動直後に「シミュレーション」ボタンを押しても
 *   モード未登録エラーにならない。
 */

/**
 * 最低限のHTMLエスケープ。
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 起動エラーを表示します。
 *
 * @param {unknown} error
 */
function showBootError(error) {
  const root = document.getElementById("app");

  const message =
    error instanceof Error ? error.message : String(error);

  if (root) {
    root.innerHTML = `
      <div class="boot-message" role="alert">
        <strong>起動に失敗しました。</strong>
        <p>${escapeHtml(message)}</p>
        <p class="muted">
          ファイル配置、パス、ブラウザコンソールを確認してください。
        </p>
      </div>
    `;
  }

  console.error("[main] 起動エラー:", error);
}

/**
 * アプリ本体を起動します。
 */
async function boot() {
  const root = document.getElementById("app");

  if (!root) {
    console.error("[main] #app が見つかりません。");
    return;
  }

  /**
   * 二重起動を防ぎます。
   * 開発中にスクリプトが再読み込みされた場合にも安全にします。
   */
  if (window.__CIRCUIT_APP__) {
    console.warn("[main] アプリはすでに起動済みです。");
    return;
  }

  try {
    /**
     * 1) シミュレーションモードの登録を完了させる。
     *    setup.js はモジュール評価時に setupSimulations() を開始し、
     *    その Promise を setupReady として export しています。
     *    ここで await することで、dc / ac / transient すべてが
     *    登録済みになってから UI が起動します。
     */
    const setupModule = await import("./sim/setup.js");
    await setupModule.setupReady;

    /**
     * 2) UI 本体を読み込む。
     *    動的 import により、app.js 側の読み込み失敗もここで捕捉します。
     */
    const appModule = await import("./ui/app.js");

    if (typeof appModule.createApp !== "function") {
      throw new Error("app.js が createApp を export していません。");
    }

    const app = appModule.createApp(root);

    /**
     * 他の場所からアプリを制御 / 破棄できるように保持します。
     */
    window.__CIRCUIT_APP__ = app;

    /**
     * index.html 側の起動判定用フラグ。
     */
    window.__APP_BOOTED__ = true;
  } catch (error) {
    showBootError(error);
  }
}

/**
 * エラー監視と起動処理を行います。
 */
function initialize() {
  /**
   * アプリ側で捕捉しきれない Promise エラーをログに出します。
   */
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[main] unhandledrejection:", event.reason);
  });

  /**
   * グローバルエラーをログに出します。
   */
  window.addEventListener("error", (event) => {
    console.error("[main] error:", event.error ?? event.message);
  });

  void boot();
}

/**
 * DOMの状態に応じて初期化します。
 */
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initialize, {
    once: true,
  });
} else {
  initialize();
}