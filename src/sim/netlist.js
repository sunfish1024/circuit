/**
 * ネットの前処理（dc / ac / transient 共通）。
 *
 * 1. 未配線ピン（connect が "" / null / 欠け）は、どこにもつながらない固有ネット
 *    "__nc:<部品ID>:<ピン番号>" に置き換える。
 *    （以前は "" がグラウンド扱いになり、片側だけ配線した抵抗が接地されたのと同じ
 *     結果になっていた。）
 * 2. 電気的な部品（GND・TP 以外で2ピン以上）が1つもつながっていないネット
 *    （TP だけのネットなど）を「未接続ネット」として列挙する。解析からは除外する。
 * 3. 部品を通ってもグラウンドに到達しないネットを「浮いたネット」として列挙する。
 *    解析は各ノードの Gmin（1e-12 S）で解けるが、電圧は意味を持たないので
 *    結果の nodes からは除外し、判定では「グラウンドにつながっていない」として扱う。
 *
 * 理想化の前提: TP（テストポイント）は電気的に何もしない理想プローブ。
 */

export const NC_PREFIX = "__nc:";

/** 各ノードからグラウンドへ入れる微小コンダクタンス（S）。10V で 10pA の漏れ。 */
export const GMIN_NODE = 1e-12;

const MARKER_TYPES = new Set(["GND", "TP"]);

export function isGroundNetName(net) {
  return net === "gnd" || net === "0";
}

/**
 * @param {Array<object>} components
 * @returns {{
 *   components: Array<object>,
 *   unconnectedNets: string[],
 *   floatingNets: string[],
 *   warnings: string[],
 * }}
 */
export function prepareNetlist(components) {
  const warnings = [];
  const normalized = (components || []).filter(Boolean).map((c) => {
    if (c.type === "GND") return { ...c, connect: ["gnd"] };
    const pins = Array.isArray(c.connect) ? c.connect : [];
    let changed = false;
    const connect = pins.map((net, i) => {
      const name = typeof net === "string" ? net.trim() : "";
      if (name) return name;
      changed = true;
      return `${NC_PREFIX}${c.id}:${i}`;
    });
    return changed || connect.some((n, i) => n !== pins[i]) ? { ...c, connect } : c;
  });

  // ネットごとの電気的接続数
  const electricalCount = new Map();
  const allNets = new Set();
  for (const c of normalized) {
    for (const net of c.connect || []) {
      if (!net) continue;
      allNets.add(net);
      if (!MARKER_TYPES.has(c.type) && (c.connect || []).length >= 2) {
        electricalCount.set(net, (electricalCount.get(net) ?? 0) + 1);
      }
    }
  }

  const unconnectedNets = [];
  for (const net of allNets) {
    if (isGroundNetName(net) || net.startsWith(NC_PREFIX)) continue;
    if (!electricalCount.get(net)) unconnectedNets.push(net);
  }
  if (unconnectedNets.length) {
    warnings.push(
      `どの部品にもつながっていないネットがあります（解析から除外）: ${unconnectedNets.join(", ")}`
    );
  }

  // グラウンドとの連結（部品の全ピンを同じグループとみなす）
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let y = x;
    while (parent.get(y) !== r) {
      const next = parent.get(y);
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const G = "gnd";
  find(G);
  for (const c of normalized) {
    if (MARKER_TYPES.has(c.type)) continue;
    const pins = (c.connect || []).map((n) => (isGroundNetName(n) ? G : n));
    for (let i = 1; i < pins.length; i++) union(pins[0], pins[i]);
  }
  const floatingNets = [];
  for (const net of allNets) {
    if (isGroundNetName(net) || net.startsWith(NC_PREFIX)) continue;
    if (unconnectedNets.includes(net)) continue;
    if (find(net) !== find(G)) floatingNets.push(net);
  }
  if (floatingNets.length) {
    warnings.push(
      `グラウンド（gnd）につながっていないネットがあります: ${floatingNets.join(", ")}`
    );
  }

  return { components: normalized, unconnectedNets, floatingNets, warnings };
}

/**
 * 結果の nodes から内部ネット・未接続ネット・浮いたネットを取り除きます。
 */
export function filterNodeResults(nodes, prep) {
  const out = {};
  const drop = new Set([...prep.unconnectedNets, ...prep.floatingNets]);
  for (const [net, v] of Object.entries(nodes || {})) {
    if (net.startsWith(NC_PREFIX) || drop.has(net)) continue;
    out[net] = v;
  }
  return out;
}
