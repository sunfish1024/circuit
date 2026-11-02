/**
 * 軽量なイベントバスです。
 *
 * 役割:
 * - 状態変更の通知
 * - ボード操作の通知
 * - シミュレーション結果の通知
 * - チェック結果の通知
 * - 画面側の再描画トリガ
 *
 * 方針:
 * - DOM に依存しない。
 * - テストしやすい。
 * - 1つのハンドラのエラーで他のハンドラが止まらない。
 * - 戻り値として購読解除関数を返す。
 */

/**
 * イベントハンドラ関数。
 *
 * @callback EventHandler
 * @param {*} payload イベントデータ
 * @returns {void}
 */

/**
 * イベントバス本体を作成します。
 *
 * @param {object} [options]
 * @param {boolean} [options.debug=false] デバッグログを出すかどうか
 * @param {string} [options.debugPrefix="[eventBus]"] デバッグログのプレフィックス
 * @returns {object}
 */
export function createEventBus(options = {}) {
  const debug = options.debug ?? false;
  const debugPrefix = options.debugPrefix ?? "[eventBus]";

  /** @type {Map<string, Set<EventHandler>>} */
  const handlers = new Map();

  /**
   * イベント名を検証します。
   *
   * @param {unknown} event
   */
  function assertEventName(event) {
    if (typeof event !== "string" || event.trim().length === 0) {
      throw new TypeError("イベント名は空でない文字列である必要があります。");
    }
  }

  /**
   * ハンドラ関数を検証します。
   *
   * @param {unknown} handler
   */
  function assertHandler(handler) {
    if (typeof handler !== "function") {
      throw new TypeError("イベントハンドラは関数である必要があります。");
    }
  }

  /**
   * デバッグログを出します。
   *
   * @param {...*} args
   */
  function logDebug(...args) {
    if (!debug) return;
    console.debug(debugPrefix, ...args);
  }

  /**
   * 指定イベントのハンドラ集合を取得します。
   *
   * @param {string} event
   * @param {boolean} [createIfMissing=false]
   * @returns {Set<EventHandler> | undefined}
   */
  function getHandlerSet(event, createIfMissing = false) {
    if (!handlers.has(event)) {
      if (!createIfMissing) return undefined;

      handlers.set(event, new Set());
    }

    return handlers.get(event);
  }

  /**
   * イベント購読します。
   *
   * @param {string} event イベント名
   * @param {EventHandler} handler ハンドラ
   * @returns {() => void} 購読解除関数
   */
  function on(event, handler) {
    assertEventName(event);
    assertHandler(handler);

    const set = getHandlerSet(event, true);
    set.add(handler);

    logDebug("on", event);

    return function offFromOn() {
      off(event, handler);
    };
  }

  /**
   * 1回だけ実行されるイベント購読を登録します。
   *
   * @param {string} event イベント名
   * @param {EventHandler} handler ハンドラ
   * @returns {() => void} 購読解除関数
   */
  function once(event, handler) {
    assertEventName(event);
    assertHandler(handler);

    /**
     * @param {*} payload
     */
    function wrapper(payload) {
      off(event, wrapper);
      handler(payload);
    }

    /**
     * off() で元ハンドラを指定されたときにも削除できるようにします。
     */
    wrapper.originalHandler = handler;

    const set = getHandlerSet(event, true);
    set.add(wrapper);

    logDebug("once", event);

    return function offFromOnce() {
      off(event, wrapper);
    };
  }

  /**
   * イベント購読を解除します。
   *
   * @param {string} event イベント名
   * @param {EventHandler} handler ハンドラ
   * @returns {void}
   */
  function off(event, handler) {
    assertEventName(event);
    assertHandler(handler);

    const set = getHandlerSet(event, false);

    if (!set) {
      return;
    }

    /**
     * 直接登録されたハンドラ、または once のラッパー経由で削除します。
     */
    for (const registered of set) {
      if (registered === handler || registered.originalHandler === handler) {
        set.delete(registered);
      }
    }

    if (set.size === 0) {
      handlers.delete(event);
    }

    logDebug("off", event);
  }

  /**
   * イベントを発火します。
   *
   * @param {string} event イベント名
   * @param {*} [payload] イベントデータ
   * @returns {void}
   */
  function emit(event, payload) {
    assertEventName(event);

    const set = getHandlerSet(event, false);

    if (!set || set.size === 0) {
      logDebug("emit (no handlers)", event);
      return;
    }

    logDebug("emit", event, payload);

    /**
     * emit 中に on/off されても安全に反復するためコピーを使います。
     */
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`${debugPrefix} ハンドラ実行中にエラーが発生しました。`, {
          event,
          error,
        });
      }
    }
  }

  /**
   * 特定イベント、または全イベントの購読を解除します。
   *
   * @param {string} [event]
   * @returns {void}
   */
  function clear(event) {
    if (event !== undefined) {
      assertEventName(event);
      handlers.delete(event);
      logDebug("clear", event);
      return;
    }

    handlers.clear();
    logDebug("clear all");
  }

  /**
   * 指定イベント、または全イベントの購読数を返します。
   *
   * @param {string} [event]
   * @returns {number}
   */
  function listenerCount(event) {
    if (event !== undefined) {
      assertEventName(event);
      return getHandlerSet(event, false)?.size ?? 0;
    }

    let total = 0;

    for (const set of handlers.values()) {
      total += set.size;
    }

    return total;
  }

  /**
   * 現在購読されているイベント名一覧を返します。
   *
   * @returns {string[]}
   */
  function events() {
    return Array.from(handlers.keys());
  }

  return Object.freeze({
    on,
    once,
    off,
    emit,
    clear,
    listenerCount,
    events,
  });
}

/**
 * アプリ全体で使うイベントバスのシングルトンです。
 *
 * 必要に応じてテスト用に個別インスタンスを作れます。
 */
export const eventBus = createEventBus({
  debug: false,
  debugPrefix: "[circuit-event-bus]",
});