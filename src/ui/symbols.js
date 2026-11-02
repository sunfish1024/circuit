/**
 * 部品の SVG 回路記号ライブラリです。
 *
 * 役割:
 * - 41種類の部品を本物の回路記号（JIS/IEC 風）で描画する
 * - ピン位置（ワイヤ接続点）を記号に合わせて上書きする
 * - パレットとギャラリーでも同じ記号を使い回す
 *
 * 座標系:
 * - 部品ローカル座標（COMP_W = 96, COMP_H = 52 の枠内）
 * - 描画側で translate(x, y) されて呼ばれる
 *
 * 記号の構成:
 * - .sym-stroke : 線で描く部分（リード線、極板、シンボル輪郭）
 * - .sym-fill   : 塗りで描く部分（ダイオード三角、矢頭など）
 * - .sym-label  : 記号内の小さな文字（オペアンプの +/- など）
 *
 * 色は CSS 変数（--symbol-color）に任せ、選択中はアクセント色に変わる。
 */

/** 部品枠の幅。app.js の COMP_W と一致させる。 */
export const SYMBOL_W = 96;

/** 部品枠の高さ。app.js の COMP_H と一致させる。 */
export const SYMBOL_H = 52;

/**
 * 線要素を生成します。
 */
function line(x1, y1, x2, y2, cls = "sym-stroke") {
  return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
}

/**
 * パス要素を生成します。
 */
function path(d, cls = "sym-stroke") {
  return `<path class="${cls}" d="${d}"></path>`;
}

/**
 * 円要素を生成します。
 */
function circle(cx, cy, r, cls = "sym-stroke") {
  return `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"></circle>`;
}

/**
 * 塗り三角形（矢頭など）を生成します。
 */
function tri(points, cls = "sym-fill") {
  return `<path class="${cls}" d="M ${points} Z"></path>`;
}

/**
 * 記号内の小さな文字を生成します。
 */
function label(x, y, text, cls = "sym-label") {
  return `<text class="${cls}" x="${x}" y="${y}" text-anchor="middle">${text}</text>`;
}

/**
 * 標準の 2 端子ピン位置（左 / 右）です。
 */
const PINS_LR = [{ x: 0, y: 26 }, { x: 96, y: 26 }];

/**
 * トランジスタ系の 3 端子ピン位置（C/D = 上, B/G = 左, E/S = 下）です。
 */
const PINS_TRANSISTOR = [
  { x: 58, y: 0 },
  { x: 0, y: 26 },
  { x: 58, y: 52 },
];

/**
 * ゲート系の 3 端子ピン位置（A = 左上, B = 左下, Y = 右）です。
 */
const PINS_GATE = [
  { x: 0, y: 16 },
  { x: 0, y: 36 },
  { x: 96, y: 26 },
];

/**
 * D フリップフロップの 4 端子ピン位置です。
 */
const PINS_DFF = [
  { x: 0, y: 16 },
  { x: 0, y: 36 },
  { x: 96, y: 16 },
  { x: 96, y: 36 },
];

/**
 * 3入力ゲートの 4 端子ピン位置（A/B/C = 左, Y = 右）です。
 */
const PINS_GATE3 = [
  { x: 0, y: 10 },
  { x: 0, y: 26 },
  { x: 0, y: 42 },
  { x: 96, y: 26 },
];

/**
 * クリア付き D フリップフロップの 5 端子ピン位置（D/CLK = 左, CLR = 下, Q/Q_NOT = 右）です。
 */
const PINS_DFF_R = [
  { x: 0, y: 16 },
  { x: 0, y: 36 },
  { x: 48, y: 52 },
  { x: 96, y: 16 },
  { x: 96, y: 36 },
];

/**
 * トランスの 4 端子ピン位置です。
 */
const PINS_XFMR = [
  { x: 0, y: 16 },
  { x: 0, y: 36 },
  { x: 96, y: 16 },
  { x: 96, y: 36 },
];

/**
 * オペアンプの 5 端子ピン位置です。
 */
const PINS_OPAMP = [
  { x: 0, y: 16 },
  { x: 0, y: 36 },
  { x: 96, y: 26 },
  { x: 48, y: 0 },
  { x: 48, y: 52 },
];

/**
 * フォトカプラの 4 端子ピン位置（LED = 左, フォトトランジスタ = 右）です。
 */
const PINS_OPTO = [
  { x: 0, y: 16 },
  { x: 0, y: 36 },
  { x: 96, y: 16 },
  { x: 96, y: 36 },
];

/**
 * フォトトランジスタの 2 端子ピン位置（C/E = 右側）です。
 */
const PINS_PT = [
  { x: 96, y: 16 },
  { x: 96, y: 36 },
];

/**
 * ブラックボックス型カレントミラーの 3 端子ピン位置（ref = 左, out = 右上, gnd = 下）です。
 */
const PINS_MIRROR = [
  { x: 0, y: 26 },
  { x: 96, y: 16 },
  { x: 48, y: 52 },
];

/**
 * 電圧制御スイッチ SW_V の 4 端子ピン位置です。
 * pinNames 順 [1, 2, ctrl_p, ctrl_n]。制御入力は左（ctrl_p = 上, ctrl_n = 下）、接点は右（1 = 上, 2 = 下）。
 * ピンが左右の辺だけなので、ID・値ラベルは上下に置け、回転しても他のラベルと重ならない。
 */
const PINS_SW_V = [
  { x: 96, y: 16 },
  { x: 96, y: 36 },
  { x: 0, y: 16 },
  { x: 0, y: 36 },
];

/**
 * シンボル定義テーブルです。
 *
 * 各定義:
 * - pins      : ピン位置（null の場合は app.js 側の汎用ジオメトリにフォールバック）
 * - idLabel   : 部品 ID の表示位置（null なら非表示）
 * - valueLabel: パラメータ値の表示位置（null なら非表示）
 * - render    : 記号本体の SVG 文字列を返す関数
 */
const SYMBOLS = {
  /* -------------------------------------------------------------- */
  /* 接続系                                                           */
  /* -------------------------------------------------------------- */

  WIRE: {
    pins: PINS_LR,
    idLabel: null,
    valueLabel: null,
    render: () => line(0, 26, 96, 26),
  },

  GND: {
    // KiCad と同じく、接続端子（ピン）は記号の「上端」に置く。
    // 上から順に「縦棒 → 長い横棒 → 短い横棒」と並び、
    // ワイヤは記号の上側から接続する。
    pins: [{ x: 48, y: 0 }],
    idLabel: null,
    valueLabel: null,
    render: () =>
      line(48, 0, 48, 20) +
      line(30, 20, 66, 20) +
      line(37, 30, 59, 30) +
      line(43, 40, 53, 40),
  },

  /* -------------------------------------------------------------- */
  /* 受動素子                                                         */
  /* -------------------------------------------------------------- */

  R: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 22, 26) +
      path("M 22 26 L 30.7 14 L 39.3 38 L 48 14 L 56.7 38 L 65.3 14 L 74 26") +
      line(74, 26, 96, 26),
  },

  C: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 40, 26) +
      line(40, 6, 40, 46) +
      line(56, 6, 56, 46) +
      line(56, 26, 96, 26),
  },

  L: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 26, 26) +
      path(
        "M 26 26 A 7 7 0 0 1 40 26 A 7 7 0 0 1 54 26 A 7 7 0 0 1 68 26"
      ) +
      line(68, 26, 96, 26),
  },

  L_RELAY: {
    // リレーコイル: インダクタ巻線 + 筐体を表す細線の枠
    pins: PINS_LR,
    render: () =>
      line(0, 26, 26, 26) +
      path(
        "M 26 26 A 7 7 0 0 1 40 26 A 7 7 0 0 1 54 26 A 7 7 0 0 1 68 26"
      ) +
      line(68, 26, 96, 26) +
      `<rect class="sym-thin" x="20" y="10" width="56" height="32" rx="2"></rect>`,
  },

  /* -------------------------------------------------------------- */
  /* 電源                                                             */
  /* -------------------------------------------------------------- */

  V_DC: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 38, 26) +
      line(38, 4, 38, 48) +
      line(58, 14, 58, 38) +
      line(58, 26, 96, 26) +
      line(22, 8, 30, 8, "sym-thin") +
      line(26, 4, 26, 12, "sym-thin") +
      line(66, 8, 74, 8, "sym-thin"),
  },

  V_AC: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      circle(48, 26, 18) +
      path("M 34 26 Q 41 12 48 26 Q 55 40 62 26") +
      line(66, 26, 96, 26),
  },

  V_PULSE: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      circle(48, 26, 18) +
      path("M 34 34 L 42 34 L 42 18 L 54 18 L 54 34 L 62 34") +
      line(66, 26, 96, 26),
  },

  I_DC: {
    pins: PINS_LR,
    render: () =>
      // 矢印はピン軸（p→n 方向の線）に沿って描く。電流は p 端子から外部回路へ流れ出すので、矢頭は p 側（0° では左）
      line(0, 26, 30, 26) +
      circle(48, 26, 18) +
      line(38, 26, 60, 26) +
      tri("32 26 44 20 44 32") +
      line(66, 26, 96, 26),
  },

  I_AC: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      circle(48, 26, 18) +
      path("M 34 26 Q 41 12 48 26 Q 55 40 62 26") +
      line(66, 26, 96, 26),
  },

  /* -------------------------------------------------------------- */
  /* ダイオード系                                                     */
  /* -------------------------------------------------------------- */

  D: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      tri("30 8 58 26 30 44") +
      line(58, 8, 58, 44) +
      line(58, 26, 96, 26),
  },

  ZD: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      tri("30 8 58 26 30 44") +
      path("M 64 8 L 58 8 L 58 44 L 52 44") +
      line(58, 26, 96, 26),
  },

  LED: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      tri("30 8 58 26 30 44") +
      line(58, 8, 58, 44) +
      line(58, 26, 96, 26) +
      line(60, 18, 68, 10, "sym-thin") +
      tri("68 10 65.9 16.4 61.6 12.1", "sym-fill-thin") +
      line(66, 12, 74, 4, "sym-thin") +
      tri("74 4 71.9 10.4 67.6 6.1", "sym-fill-thin"),
  },

  SD: {
    // ショットキー: カソードバーの上端だけを折り返す
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      tri("30 8 58 26 30 44") +
      path("M 66 8 L 58 8 L 58 44") +
      line(58, 26, 96, 26),
  },

  TVS: {
    // 双方向サージ保護: 折り返しバー + 稲妻マーク
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      tri("30 8 58 26 30 44") +
      path("M 64 8 L 58 8 L 58 44 L 52 44") +
      line(58, 26, 96, 26) +
      path("M 70 6 L 62 16 L 67 16 L 59 26", "sym-thin"),
  },

  PD: {
    // フォトダイオード: 受光を表す矢印を右上から重ねる
    pins: PINS_LR,
    render: () =>
      line(0, 26, 30, 26) +
      tri("30 8 58 26 30 44") +
      line(58, 8, 58, 44) +
      line(58, 26, 96, 26) +
      line(78, 8, 68, 16, "sym-thin") +
      tri("68 16 69.9 10.4 73.9 15.4", "sym-fill-thin") +
      line(84, 2, 74, 10, "sym-thin") +
      tri("74 10 75.9 4.4 79.9 9.4", "sym-fill-thin"),
  },

  D_VC: {
    // バリキャップ: コンデンサ極板 + カソードバー + 可変の斜め矢印
    pins: PINS_LR,
    render: () =>
      line(0, 26, 40, 26) +
      line(40, 8, 40, 44) +
      line(54, 8, 54, 44) +
      line(54, 26, 96, 26) +
      line(46, 42, 64, 12, "sym-thin") +
      tri("64 12 64.2 17.9 58.7 14.7", "sym-fill-thin"),
  },

  /* -------------------------------------------------------------- */
  /* トランジスタ / MOSFET                                            */
  /* -------------------------------------------------------------- */

  Q_NPN: {
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(0, 26, 40, 26) +
      line(40, 10, 40, 42) +
      path("M 40 17 L 58 6 L 58 0") +
      path("M 40 35 L 58 46 L 58 52") +
      tri("54 43.6 46 43.3 50.2 36.5"),
  },

  Q_PNP: {
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(0, 26, 40, 26) +
      line(40, 10, 40, 42) +
      path("M 40 17 L 58 6 L 58 0") +
      path("M 40 35 L 58 46 L 58 52") +
      tri("45.4 38.3 49.3 45.4 53.5 38.5"),
  },

  M_N: {
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(0, 26, 34, 26) +
      line(34, 8, 34, 44) +
      line(40, 8, 40, 44) +
      line(46, 8, 46, 44) +
      line(52, 8, 52, 44) +
      path("M 40 8 L 40 0 L 58 0") +
      path("M 52 44 L 52 52 L 58 52") +
      line(46, 26, 60, 26, "sym-thin") +
      line(60, 20, 60, 32, "sym-thin") +
      tri("46 26 50.5 23.5 50.5 28.5"),
  },

  M_P: {
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(0, 26, 34, 26) +
      line(34, 8, 34, 44) +
      line(40, 8, 40, 44) +
      line(46, 8, 46, 44) +
      line(52, 8, 52, 44) +
      path("M 40 8 L 40 0 L 58 0") +
      path("M 52 44 L 52 52 L 58 52") +
      line(46, 26, 60, 26, "sym-thin") +
      line(60, 20, 60, 32, "sym-thin") +
      tri("60 26 55.5 23.5 55.5 28.5"),
  },

  J_N: {
    // NチャネルJFET: チャネルバー + ゲート矢印（チャネルに向かう）
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(50, 8, 50, 44) +
      path("M 58 0 L 58 8 L 50 8") +
      path("M 58 52 L 58 44 L 50 44") +
      line(0, 26, 40, 26) +
      tri("50 26 43 22.8 43 29.2"),
  },

  PT: {
    // フォトトランジスタ: ベース端子のないトランジスタ + 受光矢印
    pins: PINS_PT,
    render: () =>
      line(64, 18, 64, 44) +
      path("M 96 16 L 64 24") +
      line(64, 36, 96, 36) +
      tri("88 36 81 40 81 32") +
      line(38, 10, 46, 18, "sym-thin") +
      tri("46 18 40.2 16.7 44.7 12.2", "sym-fill-thin") +
      line(44, 6, 52, 14, "sym-thin") +
      tri("52 14 46.2 12.7 50.7 8.2", "sym-fill-thin"),
  },

  /* -------------------------------------------------------------- */
  /* サイリスタ系                                                   */
  /* -------------------------------------------------------------- */

  SCR: {
    // サイリスタ: アノード上 / カソード下 / ゲート左（カソードバーに接続）
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(58, 0, 58, 14) +
      tri("46 14 70 14 58 30") +
      line(44, 30, 72, 30) +
      line(58, 30, 58, 52) +
      path("M 0 26 L 40 26 L 50 30"),
  },

  TRIAC: {
    // トライアック: 逆向き2三角形が中央バーで対向、ゲートは左
    pins: PINS_TRANSISTOR,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: { x: 26, y: 64, anchor: "middle" },
    render: () =>
      circle(48, 26, 20) +
      line(58, 0, 58, 12) +
      tri("46 12 70 12 58 28") +
      line(42, 28, 74, 28) +
      tri("46 44 70 44 58 28") +
      line(58, 44, 58, 52) +
      path("M 0 26 L 36 26 L 46 28"),
  },

  DIAC: {
    // ダイアック: 頂点同士を向き合わせた2三角形（双方向）
    pins: PINS_LR,
    render: () =>
      line(0, 26, 28, 26) +
      tri("28 10 28 42 48 26") +
      tri("68 10 68 42 52 26") +
      line(68, 26, 96, 26),
  },

  /* -------------------------------------------------------------- */
  /* オペアンプ                                                       */
  /* -------------------------------------------------------------- */

  OPAMP: {
    pins: PINS_OPAMP,
    idLabel: { x: 26, y: -6, anchor: "middle" },
    valueLabel: null,
    render: () =>
      path("M 28 6 L 76 26 L 28 46 Z") +
      line(0, 16, 28, 16) +
      line(0, 36, 28, 36) +
      line(76, 26, 96, 26) +
      path("M 48 0 L 48 14.3") +
      path("M 48 37.7 L 48 52") +
      line(30, 16, 36, 16, "sym-thin") +
      line(33, 13, 33, 19, "sym-thin") +
      line(30, 36, 36, 36, "sym-thin"),
  },

  /* -------------------------------------------------------------- */
  /* スイッチ / テストポイント                                        */
  /* -------------------------------------------------------------- */

  SW: {
    pins: PINS_LR,
    render: (component) => {
      const closed =
        component?.params?.closed === true ||
        component?.params?.closed === "true";

      return closed
        ? line(0, 26, 30, 26) +
            circle(30, 26, 2.5, "sym-fill") +
            line(32, 26, 60, 26) +
            circle(62, 26, 2.5, "sym-fill") +
            line(62, 26, 96, 26)
        : line(0, 26, 30, 26) +
            circle(30, 26, 2.5, "sym-fill") +
            line(32, 24, 60, 10) +
            circle(62, 26, 2.5, "sym-fill") +
            line(62, 26, 96, 26);
    },
  },

  SW_V: {
    // 電圧制御スイッチ: 左の枠が制御入力（+ / −）、右が接点（1−2 間）。破線は「制御が接点を動かす」ことを表す。
    // 図は開いた状態（刃が上の接点から離れている）。
    pins: PINS_SW_V,
    render: () =>
      // 制御入力
      line(0, 16, 18, 16) +
      line(0, 36, 18, 36) +
      `<rect class="sym-stroke" x="18" y="8" width="26" height="36" rx="2"></rect>` +
      label(31, 24, "+") +
      label(31, 40, "−") +
      // 接点（1 = 上, 2 = 下）
      line(96, 16, 78, 16) +
      circle(78, 16, 2.5, "sym-fill") +
      line(96, 36, 78, 36) +
      circle(78, 36, 2.5, "sym-fill") +
      line(78, 36, 66, 20) +
      // 制御が接点を動かす（破線）
      `<line class="sym-thin" x1="44" y1="26" x2="62" y2="26" stroke-dasharray="3 3"></line>`,
  },

  TP: {
    pins: [{ x: 48, y: 52 }],
    idLabel: { x: 68, y: 24, anchor: "start" },
    valueLabel: null,
    render: () => line(48, 52, 48, 34) + circle(48, 26, 8),
  },

  /* -------------------------------------------------------------- */
  /* ロジックゲート                                                   */
  /* -------------------------------------------------------------- */

  U_NOT: {
    pins: PINS_LR,
    render: () =>
      line(0, 26, 28, 26) +
      path("M 28 10 L 28 42 L 64 26 Z") +
      circle(68, 26, 4) +
      line(72, 26, 96, 26),
  },

  U_AND: {
    pins: PINS_GATE,
    render: () =>
      line(0, 16, 30, 16) +
      line(0, 36, 30, 36) +
      path("M 30 8 L 48 8 A 18 18 0 0 1 48 44 L 30 44 Z") +
      line(66, 26, 96, 26),
  },

  U_OR: {
    pins: PINS_GATE,
    render: () =>
      line(0, 16, 33, 16) +
      line(0, 36, 33, 36) +
      path("M 30 8 Q 40 26 30 44 Q 56 44 72 26 Q 56 8 30 8 Z") +
      line(72, 26, 96, 26),
  },

  U_NAND: {
    pins: PINS_GATE,
    render: () =>
      line(0, 16, 30, 16) +
      line(0, 36, 30, 36) +
      path("M 30 8 L 48 8 A 18 18 0 0 1 48 44 L 30 44 Z") +
      circle(70, 26, 4) +
      line(74, 26, 96, 26),
  },

  U_NOR: {
    pins: PINS_GATE,
    render: () =>
      line(0, 16, 33, 16) +
      line(0, 36, 33, 36) +
      path("M 30 8 Q 40 26 30 44 Q 56 44 72 26 Q 56 8 30 8 Z") +
      circle(76, 26, 4) +
      line(80, 26, 96, 26),
  },

  U_XOR: {
    pins: PINS_GATE,
    render: () =>
      line(0, 16, 30, 16) +
      line(0, 36, 30, 36) +
      path("M 24 8 Q 34 26 24 44") +
      path("M 30 8 Q 40 26 30 44 Q 56 44 72 26 Q 56 8 30 8 Z") +
      line(72, 26, 96, 26),
  },

  DFF: {
    pins: PINS_DFF,
    render: () =>
      line(0, 16, 28, 16) +
      line(0, 36, 28, 36) +
      `<rect class="sym-stroke" x="28" y="8" width="40" height="36" rx="2"></rect>` +
      line(68, 16, 96, 16) +
      line(68, 36, 96, 36) +
      path("M 28 32 L 36 36 L 28 40") +
      label(38, 20, "D") +
      label(46, 40, "CLK", "sym-label-sm") +
      label(58, 20, "Q") +
      label(58, 40, "Q") +
      line(54, 31, 62, 31, "sym-thin"),
  },

  U_XNOR: {
    pins: PINS_GATE,
    render: () =>
      line(0, 16, 30, 16) +
      line(0, 36, 30, 36) +
      path("M 24 8 Q 34 26 24 44") +
      path("M 30 8 Q 40 26 30 44 Q 56 44 72 26 Q 56 8 30 8 Z") +
      circle(76, 26, 4) +
      line(80, 26, 96, 26),
  },

  U_AND3: {
    pins: PINS_GATE3,
    render: () =>
      line(0, 10, 30, 10) +
      line(0, 26, 30, 26) +
      line(0, 42, 30, 42) +
      path("M 30 4 L 46 4 A 22 22 0 0 1 46 48 L 30 48 Z") +
      line(68, 26, 96, 26),
  },

  U_OR3: {
    pins: PINS_GATE3,
    render: () =>
      line(0, 10, 32, 10) +
      line(0, 26, 36, 26) +
      line(0, 42, 32, 42) +
      path("M 28 4 Q 40 26 28 48 Q 56 48 74 26 Q 56 4 28 4 Z") +
      line(74, 26, 96, 26),
  },

  DFF_R: {
    pins: PINS_DFF_R,
    render: () =>
      line(0, 16, 28, 16) +
      line(0, 36, 28, 36) +
      `<rect class="sym-stroke" x="28" y="4" width="40" height="38" rx="2"></rect>` +
      line(68, 16, 96, 16) +
      line(68, 36, 96, 36) +
      circle(48, 45, 3) +
      line(48, 48, 48, 52) +
      path("M 28 32 L 36 36 L 28 40") +
      label(38, 18, "D") +
      label(45, 31, "CLR", "sym-label-sm") +
      label(60, 18, "Q") +
      label(61, 40, "Q") +
      line(57, 31, 65, 31, "sym-thin"),
  },

  LOGIC_IN: {
    pins: [{ x: 96, y: 26 }],
    idLabel: { x: 30, y: 6, anchor: "middle" },
    valueLabel: null,
    render: (component) => {
      const v = Number(component?.params?.value) >= 0.5 ? "1" : "0";
      // 記号は回転グループの中で描かれるので、値の文字だけ逆回転して常に正立させる
      const rot = ((Number(component?.rotation) || 0) % 360 + 360) % 360;
      const cls = v === "1" ? "sym-label sym-logic-on" : "sym-label sym-logic-off";
      return (
        path("M 12 14 L 48 14 L 60 26 L 48 38 L 12 38 Z") +
        `<text class="${cls}" x="34" y="31" text-anchor="middle"${rot ? ` transform="rotate(${-rot} 34 26)"` : ""}>${v}</text>` +
        line(60, 26, 96, 26)
      );
    },
  },

  /* -------------------------------------------------------------- */
  /* トランス                                                         */
  /* -------------------------------------------------------------- */

  XFMR: {
    pins: PINS_XFMR,
    render: () =>
      line(0, 16, 18, 16) +
      line(0, 36, 18, 36) +
      path(
        "M 18 16 A 3.34 3.34 0 0 1 18 22.67 A 3.34 3.34 0 0 1 18 29.33 A 3.34 3.34 0 0 1 18 36"
      ) +
      line(28, 10, 28, 42) +
      line(32, 10, 32, 42) +
      path(
        "M 78 16 A 3.34 3.34 0 0 0 78 22.67 A 3.34 3.34 0 0 0 78 29.33 A 3.34 3.34 0 0 0 78 36"
      ) +
      line(78, 16, 96, 16) +
      line(78, 36, 96, 36),
  },

  /* -------------------------------------------------------------- */
  /* 複合素子（フォトカプラ / カレントミラー）                     */
  /* -------------------------------------------------------------- */

  U_OPTO: {
    // フォトカプラ: 左にLED、右にフォトトランジスタ、中央に受光矢印
    pins: PINS_OPTO,
    render: () =>
      path("M 0 16 L 30 16 L 30 22") +
      tri("24 22 36 22 30 32") +
      line(24, 32, 36, 32) +
      path("M 30 32 L 30 36 L 0 36") +
      line(64, 18, 64, 44) +
      path("M 96 16 L 64 24") +
      line(64, 36, 96, 36) +
      tri("88 36 81 40 81 32") +
      line(44, 10, 52, 18, "sym-thin") +
      tri("52 18 46.2 16.7 50.7 12.2", "sym-fill-thin") +
      line(50, 6, 58, 14, "sym-thin") +
      tri("58 14 52.2 12.7 56.7 8.2", "sym-fill-thin"),
  },

  U_WILSON: {
    // ウィルソンカレントミラー: ブラックボックス（参照/出力/GND）
    pins: PINS_MIRROR,
    render: () =>
      `<rect class="sym-stroke" x="24" y="6" width="48" height="40" rx="2"></rect>` +
      line(0, 26, 24, 26) +
      line(72, 16, 96, 16) +
      line(48, 46, 48, 52) +
      label(48, 29, "WILSON"),
  },

  U_CASCODE: {
    // カスコードカレントミラー: ブラックボックス（参照/出力/GND）
    pins: PINS_MIRROR,
    render: () =>
      `<rect class="sym-stroke" x="24" y="6" width="48" height="40" rx="2"></rect>` +
      line(0, 26, 24, 26) +
      line(72, 16, 96, 16) +
      line(48, 46, 48, 52) +
      label(48, 29, "CASCODE"),
  },
};

/**
 * 部品種別のシンボル定義を返します。
 *
 * @param {string} type 部品種別
 * @returns {object | null} 定義（未対応種別は null）
 */
export function getSymbolDefinition(type) {
  return SYMBOLS[type] ?? null;
}

/**
 * 部品種別の記号本体 SVG（ローカル座標）を返します。
 *
 * @param {string} type 部品種別
 * @param {object} [component] 部品インスタンス（スイッチの開閉などに使用）
 * @returns {string} SVG 文字列（未対応種別は空文字）
 */
export function getSymbolBody(type, component = null) {
  const definition = SYMBOLS[type];

  if (!definition) {
    return "";
  }

  try {
    return definition.render(component) ?? "";
  } catch (error) {
    console.warn(`シンボル ${type} の描画に失敗しました。`, error);
    return "";
  }
}

/**
 * 部品種別のピン位置を返します。
 * シンボル側が独自ピン位置を持つ場合はそれを優先します。
 *
 * @param {string} type 部品種別
 * @returns {Array<{x:number, y:number}> | null} ピン位置配列（未対応は null）
 */
export function getSymbolPins(type) {
  const definition = SYMBOLS[type];

  if (!definition || !Array.isArray(definition.pins)) {
    return null;
  }

  return definition.pins;
}
