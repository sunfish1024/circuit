/**
 * シミュレーションモード一括登録。
 *
 * - dc        : 実装済み → 静的 import
 * - digital   : 実装済み → 動的 import で登録（真理値表抽出 / ゲート論理伝搬）
 * - ac        : 存在すれば動的 import で登録
 * - transient : 存在すれば動的 import で登録
 *
 * 未実装のモードは警告だけ出して起動を継続します。
 *
 * 起動完了は `setupReady` Promise で通知します。
 * main.js はこれを await してから UI を立ち上げることで、
 * 起動直後の「シミュレーション」ボタン押下でもモード未登録
 * エラーが起きないことを保証します。
 */

import "./dc.js"; // 副作用で registerSimulationMode("dc", ...) される

async function tryRegister(path, label) {
  try {
    await import(path);
  } catch (err) {
    // まだ実装されていないだけなので、警告に留める
    console.warn(
      `[sim/setup] ${label} モードは未登録です:`,
      err?.message ?? err
    );
  }
}

/**
 * 利用可能なシミュレーションモードをすべて登録します。
 *
 * @returns {Promise<void>}
 */
export async function setupSimulations() {
  // 現状 dc は静的 import 済み。
  // ac.js / transient.js を実装したら下の tryRegister が登録を行います。
  await tryRegister("./digital.js", "digital");
  await tryRegister("./ac.js", "ac");
  await tryRegister("./transient.js", "transient");
}

/**
 * setup の完了を待つための Promise。
 *
 * main.js はこの Promise を await することで、
 * すべてのシミュレーションモード登録が完了してから
 * UI を立ち上げることができます。
 *
 * モジュール評価時に自動で開始されます。
 *
 * @type {Promise<void>}
 */
export const setupReady = setupSimulations();