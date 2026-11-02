/**
 * ボード上の部品・ラベル・ガイド線の幾何計算（DOM 非依存）。
 *
 * src/ui/app.js（描画）と tools/check_layout.mjs（レイアウト検査）の両方から使う。
 * ここで計算した位置・大きさが、そのまま画面の描画位置になる。
 *
 * 座標系:
 * - 「設計座標」: 部品ローカル座標（COMP_W x COMP_H = 96 x 52 の枠。回転後は 52 x 96）。
 *   記号・ピン・ラベルはこの座標で描き、描画側で translate(x, y) scale(COMP_SCALE) する。
 * - 「ボード座標」: 画面上の px。部品の position はボード座標で、外接ボックスの左上。
 *   ボード座標 = position + 設計座標 * COMP_SCALE。
 *
 * ガイド線（固定配線の表示）:
 * - 同じネット名を持つ固定部品（locked）のピン同士を、水平・垂直の線で結んで描く。
 * - 描画専用。電気的なつながりは従来どおりネット名（connect）で決まり、state の wires には入らない。
 * - 経路はグリッド上の A* 探索で、部品の外接ボックス（少し広げたもの）を通らない。
 *   折れ曲がり・ラベルの上・他ネットとの交差にコストを付け、他ネットの線との重なり（同じ向きに並走）は禁止。
 * - gnd ネット（"gnd" / "0"）は線で結ばず、各ピンのそばに GND 記号を描く（layout.groundSymbols=false で線にもできる）。
 *
 * 問題 JSON の layout（すべて省略可。詳細は docs/layout_spec.md）:
 *   "layout": {
 *     "guides": true,           // false でガイド線を描かない
 *     "groundSymbols": true,    // false で gnd ネットも線で結ぶ
 *     "routes": [ { "net": "a", "points": [[x,y], [x,y], ...] } ]  // 手動経路（そのネットは自動配線しない）
 *   }
 *   部品の位置・回転は従来どおり fixedComponents[].position / rotation。
 *
 * ピン位置（0°、position からのずれ。設計座標 x 0.75。pinNames 順）:
 *   - 2 入力ゲート（U_AND / U_OR / U_XOR / U_XNOR など）: A (0,12) / B (0,27) / Y (72,19.5)
 *   - 3 入力ゲート（U_AND3 / U_OR3）: A (0,7.5) / B (0,19.5) / C (0,31.5) / Y (72,19.5)
 *   - DFF: D (0,12) / CLK (0,27) / Q (72,12) / Q_NOT (72,27)
 *   - DFF_R: D (0,12) / CLK (0,27) / CLR (36,39 = 下中央) / Q (72,12) / Q_NOT (72,27)
 *   - LOGIC_IN（論理入力。1 ピン Y）: 右 (72,19.5)。ID は記号の上、値の 0/1 は記号の中（回転しても正立）
 */

import { getSymbolDefinition, getSymbolPins } from "./symbols.js";
import { formatMetricValue } from "../core/units.js";

/** 部品シンボルの枠（設計座標）。symbols.js の SYMBOL_W / SYMBOL_H と一致させる。 */
export const COMP_W = 96;
export const COMP_H = 52;

/** 部品の表示倍率（設計座標 → ボード座標）。 */
export const COMP_SCALE = 0.75;

/** 部品位置のグリッドスナップ間隔（ボード座標）。 */
export const SNAP = 10;

/**
 * 問題レイアウトの基準ボードサイズ（ボード座標）。
 * styles/main.css の `.board-container .board-canvas { min-width: 960px; min-height: 560px }` と一致させる。
 * 固定部品・ラベル・ガイド線はこの範囲に収める（check_layout.mjs が検査する）。
 */
export const DEFAULT_BOARD = Object.freeze({ width: 960, height: 560 });

/**
 * ラベルのフォントサイズ（設計座標）。styles/main.css の
 * .board-comp-id / .board-comp-params / .board-pin-label と一致させる。
 */
export const FONT = Object.freeze({ id: 16, value: 11.5, pin: 10.5 });

/** ガイド線の配線パラメータ（ボード座標）。 */
export const GUIDE = Object.freeze({
  /** ピンから外向きにまっすぐ出す長さ。ピン名ラベル（ピンから約 10px 以内）を越える長さにする。 */
  stub: 12,
  /** 部品の外接ボックスをこの分だけ広げて障害物にする。 */
  margin: 4,
  /** 探索グリッドの間隔。 */
  grid: 10,
  /** 折れ曲がり 1 回のコスト（px 相当）。 */
  bendCost: 18,
  /** ラベルの上を通る 1 区間あたりのコスト。 */
  labelCost: 25,
  /** 他ネットの線と直交して交差するコスト。 */
  crossCost: 30,
  /** 自動配線の探索範囲を部品の外側へ広げる量。 */
  boundsPad: 40,
});

/** 自動 GND 記号の寸法（ボード座標）。ピンから外向きに stub だけ伸ばし、横棒 3 本を描く。 */
export const GND_MARK = Object.freeze({ stub: 8, bars: [[0, 16], [3.5, 10], [7, 4]] });

/** シミュレータが接地とみなすネット名（src/sim/dc.js の isGround と同じ）。 */
export function isGroundNet(net) {
  return net === "gnd" || net === "0";
}

/* ==========================================================================
   回転とピン
   ========================================================================== */

/** 回転角を 0 / 90 / 180 / 270 に丸める。 */
export function normalizeRotation(rotation) {
  const value = Number(rotation);
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

/** 回転後の外接ボックス（設計座標）。 */
export function getRotatedBox(rotation) {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { w: COMP_H, h: COMP_W } : { w: COMP_W, h: COMP_H };
}

/** 部品ローカル座標上の点を回転後の外接ボックス内の座標に変換する。 */
export function rotatePointInBox(px, py, rotation) {
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: COMP_H - py, y: px };
    case 180:
      return { x: COMP_W - px, y: COMP_H - py };
    case 270:
      return { x: py, y: COMP_W - px };
    default:
      return { x: px, y: py };
  }
}

/** 記号本体を回転させる SVG transform（0 度は空文字）。 */
export function getInnerRotationTransform(rotation) {
  switch (normalizeRotation(rotation)) {
    case 90:
      return `translate(${COMP_H}, 0) rotate(90)`;
    case 180:
      return `translate(${COMP_W}, ${COMP_H}) rotate(180)`;
    case 270:
      return `translate(0, ${COMP_W}) rotate(270)`;
    default:
      return "";
  }
}

/**
 * 部品種別のピン座標（未回転の設計座標）。
 * シンボル定義がピン位置を持てばそれを使い、無ければピン数から汎用配置を作る。
 *
 * @param {string} type
 * @param {string[]} pinNames components.json の pinNames
 */
export function getPinGeometry(type, pinNames = []) {
  const symbolPins = getSymbolPins(type);
  if (symbolPins) return symbolPins;

  const n = pinNames.length;
  const points = [];
  if (n === 1) {
    points.push({ x: COMP_W / 2, y: COMP_H });
  } else if (n === 2) {
    points.push({ x: 0, y: COMP_H / 2 }, { x: COMP_W, y: COMP_H / 2 });
  } else if (n === 3) {
    points.push({ x: COMP_W / 2, y: 0 }, { x: 0, y: COMP_H / 2 }, { x: COMP_W / 2, y: COMP_H });
  } else if (n === 4) {
    points.push(
      { x: 0, y: COMP_H * 0.3 },
      { x: 0, y: COMP_H * 0.7 },
      { x: COMP_W, y: COMP_H * 0.3 },
      { x: COMP_W, y: COMP_H * 0.7 }
    );
  } else if (n >= 5) {
    points.push(
      { x: 0, y: COMP_H * 0.28 },
      { x: 0, y: COMP_H * 0.72 },
      { x: COMP_W, y: COMP_H * 0.5 },
      { x: COMP_W / 2, y: 0 },
      { x: COMP_W / 2, y: COMP_H }
    );
    for (let i = 5; i < n; i += 1) {
      points.push({ x: COMP_W, y: COMP_H * ((i - 4) / (n - 4 + 1)) });
    }
  }
  return points;
}

/** 回転を考慮したピン座標（設計座標）。 */
export function getRotatedPinGeometry(type, rotation, pinNames = []) {
  const geo = getPinGeometry(type, pinNames);
  const r = normalizeRotation(rotation);
  return r ? geo.map((p) => rotatePointInBox(p.x, p.y, r)) : geo;
}

/**
 * ピンが外接ボックスのどの辺にあるか（ワイヤ・ガイド線が出ていく向き）。
 * 辺の上にないピンは、いちばん近い辺とみなす。
 *
 * @returns {"left"|"right"|"top"|"bottom"}
 */
export function pinSide(point, box) {
  const d = [
    ["top", Math.abs(point.y)],
    ["bottom", Math.abs(box.h - point.y)],
    ["left", Math.abs(point.x)],
    ["right", Math.abs(box.w - point.x)],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][0];
}

/** 辺の外向き単位ベクトル。 */
export function sideVector(side) {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** 部品の位置（未指定なら既定値）。 */
function posOf(component) {
  return {
    x: Number.isFinite(component?.position?.x) ? component.position.x : 40,
    y: Number.isFinite(component?.position?.y) ? component.position.y : 40,
  };
}

/** 部品本体の外接ボックス（ボード座標）。 */
export function getComponentRect(component) {
  const box = getRotatedBox(component.rotation);
  const p = posOf(component);
  return { x: p.x, y: p.y, w: box.w * COMP_SCALE, h: box.h * COMP_SCALE };
}

/**
 * 部品の全ピンの情報（ボード座標）。
 *
 * @returns {Array<{index:number, name:string, net:string, local:{x:number,y:number}, x:number, y:number, side:string}>}
 */
export function getPinInfos(component, pinNames = []) {
  const rotation = normalizeRotation(component.rotation);
  const box = getRotatedBox(rotation);
  const geo = getRotatedPinGeometry(component.type, rotation, pinNames);
  const p = posOf(component);
  const connect = Array.isArray(component.connect) ? component.connect : [];
  return pinNames.map((name, index) => {
    const local = geo[index] ?? { x: box.w / 2, y: box.h / 2 };
    return {
      index,
      name,
      net: typeof connect[index] === "string" ? connect[index].trim() : "",
      local,
      x: p.x + local.x * COMP_SCALE,
      y: p.y + local.y * COMP_SCALE,
      side: pinSide(local, box),
    };
  });
}

/** ピンのボード座標（ピン名またはピン番号で指定）。 */
export function getPinPoint(component, pinName, pinNames = []) {
  const infos = getPinInfos(component, pinNames);
  let index = pinNames.indexOf(String(pinName));
  if (index < 0) {
    const numeric = Number(pinName);
    if (Number.isInteger(numeric) && numeric >= 0 && numeric < infos.length) index = numeric;
  }
  if (index < 0 || index >= infos.length) {
    const r = getComponentRect(component);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  return { x: infos[index].x, y: infos[index].y };
}

/* ==========================================================================
   ラベル
   ========================================================================== */

/**
 * テキスト幅の見積もり（DOM なしで使うための近似）。
 * ASCII 小文字・数字 ≈ 0.56em、大文字 ≈ 0.68em、記号（Ω, µ など）≈ 0.7em、全角・絵文字 ≈ 1.0em。
 * 実測（Chromium, system-ui）より少し大きめに見積もる（重なりを見逃さない側に倒す）。
 */
export function estimateTextWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      if (ch === " ") w += 0.3;
      else if (/[A-Z]/.test(ch)) w += 0.68;
      else if (/[il.:,;'|!]/.test(ch)) w += 0.3;
      else if (/[mwMW]/.test(ch)) w += 0.85;
      else w += 0.56;
    } else if (code < 0x2e80) {
      w += 0.7;
    } else {
      w += 1.0;
    }
  }
  return w * fontSize;
}

/** 部品 ID ラベルの文字列（固定部品は鍵マーク付き）。 */
export function componentIdText(component) {
  return `${component.id}${component.locked ? " 🔒" : ""}`;
}

/** 値ラベルの最大文字数（これを超える分はパラメータ単位で省く）。 */
export const VALUE_TEXT_MAX = 22;

/**
 * 値ラベルの文字列。先頭 2 パラメータを "key=値" で並べる。
 * VALUE_TEXT_MAX 文字を超えるときは後ろのパラメータを丸ごと省く（"freqHz=100Hz" を "freqHz=10" のように
 * 途中で切ると別の値に読めるため、値の途中では切らない）。
 *
 * @param {object} component
 * @param {(type:string, key:string) => string} unitOf パラメータの単位
 */
export function componentValueText(component, unitOf = () => "") {
  const parts = Object.entries(component.params ?? {})
    .slice(0, 2)
    .map(([key, value]) => {
      let shown = String(value ?? "");
      if (typeof value === "number") {
        let unit = "";
        try {
          unit = unitOf(component.type, key) ?? "";
        } catch {
          unit = "";
        }
        shown = formatMetricValue(value, unit);
      }
      return `${key}=${shown}`;
    });
  let text = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    const next = `${text}  ${part}`;
    if (next.length > VALUE_TEXT_MAX) break;
    text = next;
  }
  return text.length > VALUE_TEXT_MAX ? `${text.slice(0, VALUE_TEXT_MAX - 1)}…` : text;
}

/**
 * 部品のラベル配置（設計座標。部品グループ内で scale(COMP_SCALE) される）。
 *
 * 配置規則（部品ごとに決まり、他の部品には依存しない）:
 * - ピン名ラベル: ピンから出る線の「横」に置き、線と重ならないようにする。
 *     左ピン → ピンの左上（右寄せ）／右ピン → 右上／上ピン → ピンの右上／下ピン → ピンの右下
 * - ID・値ラベル:
 *     回転 0° でシンボル定義に idLabel / valueLabel があればそれを使う（TP、トランジスタなど）。
 *     それ以外は、ピンの無い辺を選んで置く。横長（0/180°）は「上に ID・下に値」→ 右 → 左、
 *     縦長（90/270°）は「右に ID と値」→ 左 → 上下 の順に、ピンの無い辺を探す。
 *     これで回転した電源の「上ピンのラベル」と「ID ラベル」が重ならない。
 * - シンボル定義で idLabel / valueLabel が null の部品（GND など）はどの回転でも出さない。
 * - GND 部品のピン名ラベルは出さない（常に gnd なので）。hiddenPins に入れたピン（自動 GND 記号を描くピン）も出さない。
 *
 * @param {object} component
 * @param {object} options
 * @param {string[]} options.pinNames
 * @param {boolean} [options.showPinNets] true なら "ピン名:ネット名" を表示
 * @param {Set<number>} [options.hiddenPins]
 * @param {string} [options.valueText]
 * @returns {{id: object|null, value: object|null, pins: Array<object|null>}}
 *   各ラベルは { x, y, anchor, text, fontSize }（y はベースライン）
 */
export function computeLabelLayout(component, options = {}) {
  const { pinNames = [], showPinNets = false, hiddenPins = new Set(), valueText = "" } = options;
  const rotation = normalizeRotation(component.rotation);
  const box = getRotatedBox(rotation);
  const geo = getRotatedPinGeometry(component.type, rotation, pinNames);
  const def = getSymbolDefinition(component.type);
  const connect = Array.isArray(component.connect) ? component.connect : [];
  const PAD = 6;

  const sides = new Set();
  const pins = pinNames.map((name, index) => {
    const p = geo[index] ?? { x: box.w / 2, y: box.h / 2 };
    const side = pinSide(p, box);
    sides.add(side);
    if (component.type === "GND" || hiddenPins.has(index)) return null;
    const net = typeof connect[index] === "string" ? connect[index] : "";
    const text = showPinNets ? `${name}:${net || "-"}` : name;
    const base = { index, text, fontSize: FONT.pin };
    switch (side) {
      case "left":
        return { ...base, x: p.x - PAD, y: p.y - 4, anchor: "end" };
      case "right":
        return { ...base, x: p.x + PAD, y: p.y - 4, anchor: "start" };
      case "top":
        return { ...base, x: p.x + PAD, y: p.y - 4, anchor: "start" };
      default:
        return { ...base, x: p.x + PAD, y: p.y + 12, anchor: "start" };
    }
  });

  const idHidden = def?.idLabel === null;
  const valueHidden = def?.valueLabel === null || !valueText;

  const modes = {
    tb: {
      id: { x: box.w / 2, y: -6, anchor: "middle" },
      value: { x: box.w / 2, y: box.h + 12, anchor: "middle" },
      free: !sides.has("top") && !sides.has("bottom"),
    },
    right: {
      id: { x: box.w + 8, y: box.h / 2 - 2, anchor: "start" },
      value: { x: box.w + 8, y: box.h / 2 + 14, anchor: "start" },
      free: !sides.has("right"),
    },
    left: {
      id: { x: -8, y: box.h / 2 - 2, anchor: "end" },
      value: { x: -8, y: box.h / 2 + 14, anchor: "end" },
      free: !sides.has("left"),
    },
  };

  let place;
  if (rotation === 0 && def && (def.idLabel !== undefined || def.valueLabel !== undefined)) {
    place = {
      id: def.idLabel ?? modes.tb.id,
      value: def.valueLabel ?? modes.tb.value,
    };
  } else {
    const order = rotation === 90 || rotation === 270 ? ["right", "left", "tb"] : ["tb", "right", "left"];
    const key = order.find((k) => modes[k].free) ?? order[0];
    place = modes[key];
  }

  return {
    id: idHidden ? null : { ...place.id, text: componentIdText(component), fontSize: FONT.id },
    value: valueHidden ? null : { ...place.value, text: valueText, fontSize: FONT.value },
    pins,
  };
}

/** ラベル 1 つ（設計座標）の外接矩形（ボード座標）。 */
export function labelRect(component, label) {
  const p = posOf(component);
  const fs = label.fontSize;
  const w = estimateTextWidth(label.text, fs);
  let left = label.x;
  if (label.anchor === "middle") left -= w / 2;
  else if (label.anchor === "end") left -= w;
  const top = label.y - fs * 0.8;
  const height = fs * 1.02;
  return {
    x: p.x + left * COMP_SCALE,
    y: p.y + top * COMP_SCALE,
    w: w * COMP_SCALE,
    h: height * COMP_SCALE,
  };
}

/** computeLabelLayout の結果をボード座標の矩形一覧にする。 */
export function getLabelRects(component, layout) {
  const out = [];
  if (layout.id) out.push({ kind: "id", owner: component.id, text: layout.id.text, rect: labelRect(component, layout.id) });
  if (layout.value) out.push({ kind: "value", owner: component.id, text: layout.value.text, rect: labelRect(component, layout.value) });
  for (const pin of layout.pins) {
    if (pin) out.push({ kind: "pin", owner: component.id, text: pin.text, rect: labelRect(component, pin) });
  }
  return out;
}

/* ==========================================================================
   矩形ユーティリティ
   ========================================================================== */

/** 2 つの矩形の内部が重なるか（辺が接するだけなら重ならない）。eps だけ甘く判定する。 */
export function rectsOverlap(a, b, eps = 0.5) {
  return a.x + a.w - eps > b.x && b.x + b.w - eps > a.x && a.y + a.h - eps > b.y && b.y + b.h - eps > a.y;
}

/** 矩形を d だけ広げる。 */
export function inflateRect(r, d) {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** 点が矩形の内部（境界を除く）にあるか。 */
export function pointInRect(x, y, r, eps = 0.01) {
  return x > r.x + eps && x < r.x + r.w - eps && y > r.y + eps && y < r.y + r.h - eps;
}

/** 水平・垂直の線分が矩形の内部を通るか（端が矩形の辺に触れるだけなら通らない）。 */
export function segmentCrossesRect(a, b, r, eps = 0.5) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  if (Math.abs(a.y - b.y) < 1e-6) {
    // 水平線
    return a.y > r.y + eps && a.y < r.y + r.h - eps && maxX > r.x + eps && minX < r.x + r.w - eps;
  }
  if (Math.abs(a.x - b.x) < 1e-6) {
    return a.x > r.x + eps && a.x < r.x + r.w - eps && maxY > r.y + eps && minY < r.y + r.h - eps;
  }
  // 斜め線（手動経路の誤りなど）は外接矩形で近似
  return rectsOverlap({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, r, eps);
}

/* ==========================================================================
   自動 GND 記号
   ========================================================================== */

/**
 * GND 記号の描画用の形（ボード座標）。ピンから外向きに短い線を出し、その先に横棒 3 本。
 *
 * @returns {{lines: Array<[number,number,number,number]>, rect: {x,y,w,h}}}
 */
export function groundMarkShape(pin) {
  const v = sideVector(pin.side);
  const n = { x: -v.y, y: v.x }; // 線に直交する向き
  const base = { x: pin.x + v.x * GND_MARK.stub, y: pin.y + v.y * GND_MARK.stub };
  const lines = [[pin.x, pin.y, base.x, base.y]];
  for (const [off, width] of GND_MARK.bars) {
    const c = { x: base.x + v.x * off, y: base.y + v.y * off };
    lines.push([c.x - (n.x * width) / 2, c.y - (n.y * width) / 2, c.x + (n.x * width) / 2, c.y + (n.y * width) / 2]);
  }
  const xs = lines.flatMap((l) => [l[0], l[2]]);
  const ys = lines.flatMap((l) => [l[1], l[3]]);
  const rect = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  return { lines, rect };
}

/* ==========================================================================
   ガイド線の自動配線
   ========================================================================== */

/** 最小ヒープ（A* 用）。 */
class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

/** 折れ線の連続する同一直線上の点をまとめる。 */
function simplifyPolyline(points) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    pts.push({ x: round2(p.x), y: round2(p.y) });
  }
  const out = [];
  for (const p of pts) {
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear =
        (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - p.x) < 1e-6) ||
        (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - p.y) < 1e-6);
      if (collinear) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/**
 * ネットの折れ線群から接続点（T 字・十字の分岐）を求める。
 * ある点に集まる「線分の端」の数 + 2×「その点を内部に含む線分」の数が 3 以上なら分岐点。
 */
function findJunctions(polylines) {
  const segs = [];
  for (const pl of polylines) {
    for (let i = 0; i + 1 < pl.length; i += 1) segs.push([pl[i], pl[i + 1]]);
  }
  const candidates = new Map();
  for (const [a, b] of segs) {
    for (const p of [a, b]) candidates.set(`${p.x},${p.y}`, p);
  }
  const junctions = [];
  for (const p of candidates.values()) {
    let count = 0;
    for (const [a, b] of segs) {
      const isEnd = (q) => Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01;
      if (isEnd(a) || isEnd(b)) {
        count += 1;
        continue;
      }
      const onH = Math.abs(a.y - b.y) < 0.01 && Math.abs(a.y - p.y) < 0.01 && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x);
      const onV = Math.abs(a.x - b.x) < 0.01 && Math.abs(a.x - p.x) < 0.01 && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y);
      if (onH || onV) count += 2;
    }
    if (count >= 3) junctions.push(p);
  }
  return junctions;
}

/**
 * 自動 GND 記号を描くピンを求める。
 * layout.guides !== false かつ layout.groundSymbols !== false のとき、
 * gnd ネット（"gnd" / "0"）につながる固定部品のピン（GND 部品自身を除く）すべてに描く。
 *
 * @returns {{groundMarks: Array<object>, hiddenPinsById: Map<string, Set<number>>}}
 */
export function computeGroundMarks(components, options = {}) {
  const { pinNamesOf = () => [], layout = {} } = options;
  const groundMarks = [];
  const hiddenPinsById = new Map();
  if (layout?.guides === false || layout?.groundSymbols === false) return { groundMarks, hiddenPinsById };
  for (const comp of components) {
    if (comp.type === "GND") continue;
    for (const pin of getPinInfos(comp, pinNamesOf(comp.type))) {
      if (!isGroundNet(pin.net)) continue;
      groundMarks.push({
        componentId: comp.id,
        pin: pin.name,
        pinIndex: pin.index,
        x: pin.x,
        y: pin.y,
        side: pin.side,
        ...groundMarkShape(pin),
      });
      if (!hiddenPinsById.has(comp.id)) hiddenPinsById.set(comp.id, new Set());
      hiddenPinsById.get(comp.id).add(pin.index);
    }
  }
  return { groundMarks, hiddenPinsById };
}

/**
 * 固定部品のガイド線・自動 GND 記号を計算する。
 *
 * @param {object[]} components 固定部品（locked）の一覧。{ id, type, position, rotation, connect, params, locked }
 * @param {object} options
 * @param {(type:string) => string[]} options.pinNamesOf
 * @param {object} [options.layout] 問題 JSON の layout
 * @param {Array<{rect:object}>} [options.labelRects] 避けたいラベル矩形（ボード座標）
 * @param {{width:number,height:number}} [options.board]
 * @returns {{
 *   nets: Array<{net:string, polylines:Array<Array<{x,y}>>, junctions:Array<{x,y}>, manual:boolean}>,
 *   groundMarks: Array<{componentId:string, pin:string, pinIndex:number, x:number, y:number, side:string, lines:Array, rect:object}>,
 *   failures: Array<{net:string, componentId:string, pin:string, reason:string}>,
 *   hiddenPinsById: Map<string, Set<number>>
 * }}
 */
export function computeGuides(components, options = {}) {
  const { pinNamesOf = () => [], layout = {}, labelRects = [], board = DEFAULT_BOARD } = options;
  const result = { nets: [], groundMarks: [], failures: [], hiddenPinsById: new Map() };

  if (layout?.guides === false) return result;
  const groundSymbols = layout?.groundSymbols !== false;

  // --- 自動 GND 記号 ---
  const marks = computeGroundMarks(components, { pinNamesOf, layout });
  result.groundMarks = marks.groundMarks;
  result.hiddenPinsById = marks.hiddenPinsById;

  // --- ピンをネットごとに集める（GND 記号にしたピンは線で結ばない）---
  const pinsByNet = new Map();
  const allPins = [];
  for (const comp of components) {
    const infos = getPinInfos(comp, pinNamesOf(comp.type));
    for (const pin of infos) {
      if (!pin.net) continue;
      const entry = { ...pin, componentId: comp.id, type: comp.type };
      allPins.push(entry);
      if (groundSymbols && isGroundNet(pin.net)) continue;
      if (!pinsByNet.has(pin.net)) pinsByNet.set(pin.net, []);
      pinsByNet.get(pin.net).push(entry);
    }
  }

  const manualRoutes = Array.isArray(layout?.routes) ? layout.routes : [];
  const manualNets = new Set(manualRoutes.map((r) => r?.net).filter(Boolean));

  const autoNets = [...pinsByNet.entries()].filter(([net, pins]) => pins.length >= 2 && !manualNets.has(net));
  if (autoNets.length === 0 && manualNets.size === 0) return result;

  // --- 障害物 ---
  const bodyRects = components.map((c) => getComponentRect(c));
  const obstacles = [
    ...bodyRects.map((r) => inflateRect(r, GUIDE.margin)),
    ...result.groundMarks.map((g) => inflateRect(g.rect, 2)),
  ];
  const softRects = labelRects.map((l) => inflateRect(l.rect ?? l, 1));

  // --- 探索グリッド（10px 格子 + ピン・スタブ・手動経路の座標）---
  let minX = 0;
  let minY = 0;
  let maxX = board.width;
  let maxY = board.height;
  for (const r of bodyRects) {
    minX = Math.min(minX, r.x - GUIDE.boundsPad);
    minY = Math.min(minY, r.y - GUIDE.boundsPad);
    maxX = Math.max(maxX, r.x + r.w + GUIDE.boundsPad);
    maxY = Math.max(maxY, r.y + r.h + GUIDE.boundsPad);
  }
  const xsSet = new Set();
  const ysSet = new Set();
  for (let x = Math.floor(minX / GUIDE.grid) * GUIDE.grid; x <= maxX; x += GUIDE.grid) xsSet.add(x);
  for (let y = Math.floor(minY / GUIDE.grid) * GUIDE.grid; y <= maxY; y += GUIDE.grid) ysSet.add(y);

  const stubEnd = (pin) => {
    const v = sideVector(pin.side);
    return { x: round2(pin.x + v.x * GUIDE.stub), y: round2(pin.y + v.y * GUIDE.stub) };
  };
  for (const pin of allPins) {
    const s = stubEnd(pin);
    xsSet.add(round2(pin.x));
    ysSet.add(round2(pin.y));
    xsSet.add(s.x);
    ysSet.add(s.y);
  }
  for (const route of manualRoutes) {
    for (const pt of Array.isArray(route?.points) ? route.points : []) {
      if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        xsSet.add(round2(pt[0]));
        ysSet.add(round2(pt[1]));
      }
    }
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const yIndex = new Map(ys.map((y, i) => [y, i]));
  const idx = (i, j) => i * ny + j;
  const N = nx * ny;

  const blocked = new Uint8Array(N);
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      if (obstacles.some((r) => pointInRect(xs[i], ys[j], r))) blocked[idx(i, j)] = 1;
    }
  }
  // 辺（隣り合う格子点の間）の通行可否とラベルコスト。dir 0 = +x 方向の辺, 1 = +y 方向の辺
  const edgeBlocked = [new Uint8Array(N), new Uint8Array(N)];
  const edgeSoft = [new Uint8Array(N), new Uint8Array(N)];
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      const k = idx(i, j);
      if (i + 1 < nx) {
        const a = { x: xs[i], y: ys[j] };
        const b = { x: xs[i + 1], y: ys[j] };
        edgeBlocked[0][k] = blocked[k] || blocked[idx(i + 1, j)] || obstacles.some((r) => segmentCrossesRect(a, b, r, 0.01)) ? 1 : 0;
        edgeSoft[0][k] = softRects.some((r) => segmentCrossesRect(a, b, r, 0.01)) ? 1 : 0;
      }
      if (j + 1 < ny) {
        const a = { x: xs[i], y: ys[j] };
        const b = { x: xs[i], y: ys[j + 1] };
        edgeBlocked[1][k] = blocked[k] || blocked[idx(i, j + 1)] || obstacles.some((r) => segmentCrossesRect(a, b, r, 0.01)) ? 1 : 0;
        edgeSoft[1][k] = softRects.some((r) => segmentCrossesRect(a, b, r, 0.01)) ? 1 : 0;
      }
    }
  }

  // --- 他ネットとの干渉を避けるための占有情報 ---
  // nodeUse[k]: Map(net -> "h" | "v" | "x")  h/v = その向きにまっすぐ通過, x = 端・角・分岐
  const nodeUse = new Map();
  // edgeOwner[dir][k]: その辺を使っているネット名
  const edgeOwner = [new Map(), new Map()];

  const markNode = (k, net, kind) => {
    if (!nodeUse.has(k)) nodeUse.set(k, new Map());
    const m = nodeUse.get(k);
    const prev = m.get(net);
    m.set(net, prev && prev !== kind ? "x" : kind);
  };

  const gridKey = (p) => {
    const i = xIndex.get(round2(p.x));
    const j = yIndex.get(round2(p.y));
    return i === undefined || j === undefined ? -1 : idx(i, j);
  };

  /** 格子上にある折れ線をなぞって占有を記録する（格子に乗らない部分は無視）。 */
  const markPolyline = (net, pts) => {
    for (let s = 0; s + 1 < pts.length; s += 1) {
      const a = pts[s];
      const b = pts[s + 1];
      const horizontal = Math.abs(a.y - b.y) < 1e-6;
      const vertical = Math.abs(a.x - b.x) < 1e-6;
      if (!horizontal && !vertical) continue;
      const kind = horizontal ? "h" : "v";
      if (horizontal) {
        const j = yIndex.get(round2(a.y));
        if (j === undefined) continue;
        const lo = Math.min(a.x, b.x);
        const hi = Math.max(a.x, b.x);
        for (let i = 0; i < nx; i += 1) {
          if (xs[i] < lo - 1e-6 || xs[i] > hi + 1e-6) continue;
          const end = Math.abs(xs[i] - lo) < 1e-6 || Math.abs(xs[i] - hi) < 1e-6;
          markNode(idx(i, j), net, end ? "x" : kind);
          if (i + 1 < nx && xs[i + 1] <= hi + 1e-6) edgeOwner[0].set(idx(i, j), net);
        }
      } else {
        const i = xIndex.get(round2(a.x));
        if (i === undefined) continue;
        const lo = Math.min(a.y, b.y);
        const hi = Math.max(a.y, b.y);
        for (let j = 0; j < ny; j += 1) {
          if (ys[j] < lo - 1e-6 || ys[j] > hi + 1e-6) continue;
          const end = Math.abs(ys[j] - lo) < 1e-6 || Math.abs(ys[j] - hi) < 1e-6;
          markNode(idx(i, j), net, end ? "x" : kind);
          if (j + 1 < ny && ys[j + 1] <= hi + 1e-6) edgeOwner[1].set(idx(i, j), net);
        }
      }
    }
  };

  // 全ピンのスタブを先に占有しておく（他ネットがスタブを横切らないように）
  for (const pin of allPins) {
    if (groundSymbols && isGroundNet(pin.net)) continue;
    markPolyline(pin.net, [{ x: round2(pin.x), y: round2(pin.y) }, stubEnd(pin)]);
  }

  // --- 手動経路 ---
  for (const net of manualNets) {
    const polylines = manualRoutes
      .filter((r) => r?.net === net && Array.isArray(r.points))
      .map((r) => r.points.filter((pt) => Array.isArray(pt)).map(([x, y]) => ({ x: Number(x), y: Number(y) })));
    polylines.forEach((pl) => markPolyline(net, pl));
    result.nets.push({ net, polylines, junctions: findJunctions(polylines), manual: true });
  }

  /** 他ネットが使っている点か。 */
  const otherUse = (k, net) => {
    const m = nodeUse.get(k);
    if (!m) return null;
    let kind = null;
    for (const [n, kd] of m) {
      if (n === net) continue;
      if (kind === null) kind = kd;
      else if (kind !== kd) kind = "x";
    }
    return kind;
  };

  /**
   * A*: start（スタブ先端）から targets（同じネットの既存の線上の点）のどれかへ。
   * 状態 = (格子点, 進入方向)。方向 0:+x 1:-x 2:+y 3:-y
   */
  const search = (net, startK, startDir, targets) => {
    const targetPts = [...targets].map((k) => ({ x: xs[Math.floor(k / ny)], y: ys[k % ny] }));
    const h = (k) => {
      const x = xs[Math.floor(k / ny)];
      const y = ys[k % ny];
      let best = Infinity;
      for (const t of targetPts) best = Math.min(best, Math.abs(t.x - x) + Math.abs(t.y - y));
      return best;
    };
    const S = 4;
    const g = new Float64Array(N * S).fill(Infinity);
    const prev = new Int32Array(N * S).fill(-1);
    const heap = new MinHeap();
    const s0 = startK * S + startDir;
    g[s0] = 0;
    heap.push({ f: h(startK), s: s0 });
    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    while (heap.size > 0) {
      const { s } = heap.pop();
      const k = Math.floor(s / S);
      const dir = s % S;
      const cost = g[s];
      if (targets.has(k) && s !== s0) {
        // 経路復元
        const path = [];
        let cur = s;
        while (cur >= 0) {
          path.push(Math.floor(cur / S));
          cur = prev[cur];
        }
        return path.reverse();
      }
      const i = Math.floor(k / ny);
      const j = k % ny;
      const crossingHere = s !== s0 && otherUse(k, net) !== null;
      for (let d = 0; d < 4; d += 1) {
        if (crossingHere && d !== dir) continue; // 他ネットとの交点では曲がらない
        const ni = i + DIRS[d][0];
        const nj = j + DIRS[d][1];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = idx(ni, nj);
        const axis = d < 2 ? 0 : 1;
        const ek = axis === 0 ? idx(Math.min(i, ni), j) : idx(i, Math.min(j, nj));
        if (edgeBlocked[axis][ek]) continue;
        const owner = edgeOwner[axis].get(ek);
        if (owner !== undefined && owner !== net) continue; // 他ネットと重なる
        const use = otherUse(nk, net);
        let extra = 0;
        if (use !== null) {
          // 直交して通過している線だけ横切れる（端・角・同じ向きの線は不可）
          const crossOk = (axis === 0 && use === "v") || (axis === 1 && use === "h");
          if (!crossOk) continue;
          if (targets.has(nk)) continue;
          extra += GUIDE.crossCost;
        }
        const len = axis === 0 ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);
        if (edgeSoft[axis][ek]) extra += GUIDE.labelCost;
        if (d !== dir) extra += GUIDE.bendCost;
        const ns = nk * S + d;
        const nc = cost + len + extra;
        if (nc < g[ns]) {
          g[ns] = nc;
          prev[ns] = s;
          heap.push({ f: nc + h(nk), s: ns });
        }
      }
    }
    return null;
  };

  const dirOfSide = (side) => ({ right: 0, left: 1, bottom: 2, top: 3 })[side] ?? 0;
  const ptOf = (k) => ({ x: xs[Math.floor(k / ny)], y: ys[k % ny] });

  for (const [net, pins] of autoNets) {
    const polylines = [];
    const treeNodes = new Set();
    const remaining = [...pins];
    const first = remaining.shift();
    const firstStub = stubEnd(first);
    polylines.push([{ x: round2(first.x), y: round2(first.y) }, firstStub]);
    const firstK = gridKey(firstStub);
    if (firstK >= 0) treeNodes.add(firstK);

    while (remaining.length > 0) {
      // 既存の線にいちばん近いピンから順につなぐ（Prim 法の近似）
      let bestIndex = 0;
      let bestDist = Infinity;
      remaining.forEach((pin, index) => {
        const s = stubEnd(pin);
        for (const k of treeNodes) {
          const p = ptOf(k);
          const dist = Math.abs(p.x - s.x) + Math.abs(p.y - s.y);
          if (dist < bestDist) {
            bestDist = dist;
            bestIndex = index;
          }
        }
      });
      const pin = remaining.splice(bestIndex, 1)[0];
      const s = stubEnd(pin);
      const startK = gridKey(s);
      const stub = [{ x: round2(pin.x), y: round2(pin.y) }, s];
      let path = null;
      if (startK >= 0 && !blocked[startK] && treeNodes.size > 0) {
        path = search(net, startK, dirOfSide(pin.side), treeNodes);
      }
      if (!path) {
        result.failures.push({
          net,
          componentId: pin.componentId,
          pin: pin.name,
          reason: startK >= 0 && blocked[startK] ? "ピンの出口が他の部品でふさがれている" : "部品を避ける経路が見つからない",
        });
        // つながりだけは分かるように、最寄りの点へ直角の線を引く（check_layout が報告する）
        let target = ptOf([...treeNodes][0]);
        for (const k of treeNodes) {
          const p = ptOf(k);
          if (Math.abs(p.x - s.x) + Math.abs(p.y - s.y) < Math.abs(target.x - s.x) + Math.abs(target.y - s.y)) target = p;
        }
        const pl = simplifyPolyline([...stub, { x: target.x, y: s.y }, target]);
        pl.fallback = true;
        polylines.push(pl);
        continue;
      }
      const pts = simplifyPolyline([stub[0], ...path.map(ptOf)]);
      polylines.push(pts);
      markPolyline(net, pts);
      for (const k of path) treeNodes.add(k);
      // 直線区間の途中の格子点も分岐先にできるよう、経路上のすべての格子点を追加
      for (let s2 = 0; s2 + 1 < pts.length; s2 += 1) {
        const a = pts[s2];
        const b = pts[s2 + 1];
        if (Math.abs(a.y - b.y) < 1e-6) {
          const j = yIndex.get(round2(a.y));
          if (j === undefined) continue;
          for (let i = 0; i < nx; i += 1) {
            if (xs[i] >= Math.min(a.x, b.x) - 1e-6 && xs[i] <= Math.max(a.x, b.x) + 1e-6) treeNodes.add(idx(i, j));
          }
        } else {
          const i = xIndex.get(round2(a.x));
          if (i === undefined) continue;
          for (let j = 0; j < ny; j += 1) {
            if (ys[j] >= Math.min(a.y, b.y) - 1e-6 && ys[j] <= Math.max(a.y, b.y) + 1e-6) treeNodes.add(idx(i, j));
          }
        }
      }
      // 他ネットが交差している点・ピンの内側（ふさがれた点）は分岐先にしない
      for (const k of [...treeNodes]) {
        if (blocked[k] || otherUse(k, net) !== null) treeNodes.delete(k);
      }
    }
    result.nets.push({ net, polylines, junctions: findJunctions(polylines), manual: false });
  }

  return result;
}

/**
 * 盤面全体のレイアウト（固定部品のラベル矩形 + ガイド線）をまとめて計算する。
 * app.js と tools/check_layout.mjs が同じ結果を得るための入口。
 *
 * @param {object[]} fixedComponents locked な部品（position / rotation / connect / params を持つ）
 * @param {object} options
 * @param {(type:string) => string[]} options.pinNamesOf
 * @param {(type:string, key:string) => string} [options.unitOf]
 * @param {object} [options.layout] 問題 JSON の layout
 * @param {{width:number,height:number}} [options.board]
 */
export function computeFixedLayout(fixedComponents, options = {}) {
  const { pinNamesOf = () => [], unitOf = () => "", layout = {}, board = DEFAULT_BOARD } = options;
  const comps = fixedComponents.map((c) => ({ ...c, locked: c.locked ?? true }));

  // まず GND 記号を描くピン（＝ピン名ラベルを隠すピン）を決めるため、配線なしで一度計算する
  const { hiddenPinsById } = computeGroundMarks(comps, { pinNamesOf, layout });

  const labelsById = new Map();
  const labelRects = [];
  for (const c of comps) {
    const labelLayout = computeLabelLayout(c, {
      pinNames: pinNamesOf(c.type),
      showPinNets: true,
      hiddenPins: hiddenPinsById.get(c.id) ?? new Set(),
      valueText: componentValueText(c, unitOf),
    });
    labelsById.set(c.id, labelLayout);
    labelRects.push(...getLabelRects(c, labelLayout));
  }

  const guides = computeGuides(comps, { pinNamesOf, layout, labelRects, board });
  return { components: comps, labelsById, labelRects, guides, hiddenPinsById };
}

/**
 * 固定部品の描画範囲（部品・ラベル・GND 記号・ガイド線を含む外接矩形の右端と下端）。
 * 画面はこの範囲がスクロールなしで見えるように表示倍率を決める（app.js の applyBoardFit）。
 * 固定部品が無いときは null。
 *
 * @param {ReturnType<typeof computeFixedLayout>} fixedLayout
 * @returns {{right:number, bottom:number} | null}
 */
export function getFixedContentExtent(fixedLayout) {
  if (!fixedLayout?.components?.length) return null;

  let right = 0;
  let bottom = 0;
  const addRect = (r) => {
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  };

  for (const c of fixedLayout.components) addRect(getComponentRect(c));
  for (const item of fixedLayout.labelRects ?? []) addRect(item.rect);
  for (const mark of fixedLayout.guides?.groundMarks ?? []) if (mark.rect) addRect(mark.rect);
  for (const net of fixedLayout.guides?.nets ?? []) {
    for (const pl of net.polylines ?? []) {
      for (const p of pl) {
        right = Math.max(right, p.x);
        bottom = Math.max(bottom, p.y);
      }
    }
  }

  return { right, bottom };
}
