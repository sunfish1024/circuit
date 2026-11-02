/**
 * アプリ全体の設定を管理します。
 *
 * 役割:
 * - アプリ基本情報
 * - 読み込みパス
 * - ローカルストレージキー
 * - ボード初期設定
 * - シミュレーション既定値
 * - チェック既定値
 * - カテゴリ既定値
 *
 * 方針:
 * - 原則としてここに書いた値を直接書き換えない。
 * - 実行時に書き換えたい状態は state.js で管理する。
 * - ここは「静的な設定」のみを扱う。
 */

/**
 * オブジェクトを再帰的に凍結します。
 * 設定オブジェクトの意図しない変更を防ぐためのものです。
 *
 * @param {unknown} value 凍結対象の値
 * @returns {unknown} 凍結済みの値
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }

  return value;
}

/**
 * アプリ設定本体です。
 *
 * @type {object}
 */
const rawConfig = {
  app: {
    /**
     * アプリ表示名。
     */
    name: "電子回路学習ゲーム",

    /**
     * バージョン。
     * 問題データやセーブデータ互換性判定に使う予定です。
     */
    version: "0.1.0",

    /**
     * デバッグログを詳細に出すかどうか。
     * 開発中は true、公開時は必要に応じて false にします。
     */
    debug: true,

    /**
     * 基本ロケール。
     * 現時点では日本語固定想定です。
     */
    locale: "ja",

    /**
     * GitHub Pages などの静的ホスティングを想定し、
     * パスは相対指定を基本にします。
     */
    basePath: "./",
  },

  paths: {
    /**
     * 部品定義。
     */
    components: "./data/components.json",

    /**
     * カテゴリ定義。
     */
    categories: "./data/categories.json",

    /**
     * チェック種別定義。
     */
    checkTypes: "./data/checkTypes.json",

    /**
     * 問題データ配置ルート。
     * 実際には `${problemsRoot}/${categoryId}/${problemId}.json` になります。
     */
    problemsRoot: "./data/problems",

    /**
     * 部品モデル、半導体モデル、シミュレーション既定値などの配置予定ディレクトリ。
     */
    models: "./data/models",

    /**
     * 画像、SVGシンボルなどの静的リソース。
     */
    assets: "./assets",

    /**
     * 回路シンボルSVGを置く想定。
     */
    symbols: "./assets/symbols",
  },

  fetch: {
    /**
     * 開発中はキャッシュに古いJSONが残ることがあるため、
     * 基本は no-cache にします。
     */
    cache: "no-cache",

    /**
     * 問題データやカテゴリ一覧の取得に失敗したときの再試行回数。
     * 現状は簡易的に 0 です。
     */
    retryCount: 0,

    /**
     * 再試行間隔。ミリ秒。
     */
    retryDelayMs: 300,
  },

  storage: {
    /**
     * localStorage キーのプレフィックス。
     * 他のアプリと衝突しないようにします。
     */
    prefix: "circuit-learning-game:",

    /**
     * 個別キー。
     * 実際に使うときは getStorageKey() 経由で取得します。
     */
    keys: {
      settings: "settings",
      progress: "progress",
      currentCategory: "current-category",
      currentProblem: "current-problem",
      boardDraft: "board-draft",
      uiPreferences: "ui-preferences",
    },
  },

  board: {
    /**
     * グリッド設定。
     */
    grid: {
      size: 20,
      visible: true,
      snap: true,
    },

    /**
     * ズーム設定。
     */
    zoom: {
      min: 0.25,
      max: 3,
      initial: 1,
      step: 0.1,
    },

    /**
     * ボード初期サイズ。
     * 実際にはスクロール可能な仮想キャンバスとして扱います。
     */
    canvas: {
      width: 2400,
      height: 1600,
    },

    /**
     * 部品配置時の最小単位。
     * グリッドスナップがオンのときはこの値に揃えます。
     */
    snapUnit: 10,

    /**
     * ワイヤや部品選択の判定に使う許容距離。ピクセル。
     */
    selectionTolerancePx: 8,
  },

  ui: {
    /**
     * 初期表示するカテゴリ。
     */
    initialCategory: "A",

    /**
     * 選択できる分野。ここに無い分野はメニューで「準備中」と表示します。
     */
    activeCategories: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],

    /**
     * パレット検索のデバウンス時間。ミリ秒。
     */
    paletteSearchDebounceMs: 150,

    /**
     * ステータスメッセージの自動消去時間。ミリ秒。
     * 0 の場合は自動消去しません。
     */
    statusMessageDurationMs: 5000,

    /**
     * ダイアログやパネルのアニメーション時間。ミリ秒。
     */
    animationDurationMs: 160,

    /**
     * 最近開いた問題の最大保持数。
     */
    maxRecentProblems: 20,
  },

  problem: {
    /**
     * 対応する問題データバージョン。
     */
    supportedVersion: 1,

    /**
     * 問題読み込み後に自動でボードへ固定素子を配置するかどうか。
     */
    autoPlaceFixedComponents: true,

    /**
     * ヒントを段階表示する場合の最大段階数。
     */
    maxHintSteps: 3,

    /**
     * 参照解をデフォルトで表示するかどうか。
     * 学習用途なので基本は非表示を推奨します。
     */
    showReferenceSolutionByDefault: false,
  },

  checks: {
    /**
     * 許容誤差が指定されていない場合の既定値。パーセント。
     */
    defaultTolerancePct: 2,

    /**
     * 非常に厳しい判定が必要な場合の最小許容誤差。
     */
    minTolerancePct: 0.01,

    /**
     * デジタル判定は基本、許容誤差なしで判定します。
     */
    digitalExact: true,

    /**
     * チェック結果メッセージの最大表示件数。
     */
    maxVisibleResults: 50,
  },

  simulation: {
    /**
     * 既定のシミュレーション種別。
     */
    defaultMode: "dc",

    /**
     * シミュレーション全体のタイムアウト。ミリ秒。
     * 将来的にワーカー化する際にも使えます。
     */
    timeoutMs: 5000,

    dc: {
      enabled: true,

      /**
       * 非線形素子の反復計算上限。
       */
      maxIterations: 100,

      /**
       * 収束判定。
       */
      tolerance: 1e-9,
    },

    ac: {
      enabled: false,

      /**
       * 開始周波数。Hz。
       */
      startHz: 1,

      /**
       * 終了周波数。Hz。
       */
      stopHz: 1_000_000,

      /**
       * 周波数点数。
       */
      points: 100,

      /**
       * "log" または "linear"。
       */
      scale: "log",
    },

    transient: {
      enabled: false,

      /**
       * 開始時刻。秒。
       */
      startSec: 0,

      /**
       * 終了時刻。秒。
       */
      stopSec: 0.01,

      /**
       * 出力点数。
       */
      points: 500,

      /**
       * 最大内部ステップ数。
       * 数値積分が不安定になった場合の安全弁です。
       */
      maxSteps: 10_000,
    },

    digital: {
      enabled: false,

      /**
       * 論理シミュレーションの最大イベント数。
       */
      maxEvents: 10_000,

      /**
       * 1ステップあたりの仮想時間。秒。
       */
      tickSec: 1e-9,
    },

    rf: {
      enabled: false,

      /**
       * 既定の特性インピーダンス。Ω。
       */
      referenceImpedanceOhm: 50,

      /**
       * 既定の周波数。Hz。
       */
      defaultFrequencyHz: 100_000_000,
    },
  },

  categories: {
    /**
     * カテゴリ未選択時の既定値。
     */
    default: "A",

    /**
     * カテゴリ表示順。
     * 実際の詳細は data/categories.json に定義します。
     */
    order: [
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
    ],
  },

  units: {
    /**
     * 表示時に使う優先単位。
     * 内部値は原則として基本SI単位で持ちます。
     */
    displayPriority: ["T", "G", "M", "k", "", "m", "u", "n", "p", "f"],

    /**
     * 入力欄で受け付けるプレフィックス。
     */
    acceptedPrefixes: ["T", "G", "M", "k", "m", "u", "μ", "n", "p", "f"],
  },
};

/**
 * 凍結済みのアプリ設定。
 */
export const CONFIG = deepFreeze(rawConfig);

/**
 * ローカルストレージ用の完全キー名を取得します。
 *
 * @param {string} name storage.keys にあるキー名。
 * @returns {string} プレフィックス付きキー名。
 */
export function getStorageKey(name) {
  const key = CONFIG.storage.keys[name] ?? name;
  return `${CONFIG.storage.prefix}${key}`;
}

/**
 * デバッグログ出力を有効にしているかどうか。
 *
 * @returns {boolean}
 */
export function isDebugEnabled() {
  return CONFIG.app.debug === true;
}

/**
 * 問題ファイルのパスを組み立てます。
 *
 * @param {string} categoryId 例: "A"
 * @param {string} problemId 例: "A-01"
 * @returns {string}
 */
export function getProblemPath(categoryId, problemId) {
  return `${CONFIG.paths.problemsRoot}/${categoryId}/${problemId}.json`;
}