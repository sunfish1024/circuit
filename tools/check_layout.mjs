// 問題の固定部品のレイアウト（見た目）を検査するツール
//
// 使い方:
//   node tools/check_layout.mjs              … 全問題を検査
//   node tools/check_layout.mjs A            … 分野 A だけ（問題IDの先頭一致。例: A-0, B-12）
//   node tools/check_layout.mjs --self-test  … 検査ロジック自体のテスト（小さな合成レイアウトで検出できるか）
//   --problems=DIR                           … data/problems の代わりに DIR を使う
//
// 検査項目（1件でもあれば終了コード 1）:
//   [a] 部品どうしの外接ボックスの重なり（自動 GND 記号と部品の重なりも含む）
//   [b] ボード領域（0 ≤ x ≤ 960, 0 ≤ y ≤ 560。geometry.js の DEFAULT_BOARD）からのはみ出し
//       （部品・ラベル・ガイド線・GND 記号）。position の指定漏れ、10 の倍数でない position も報告
//   [c] ラベルの重なり: ID / 値 / ピン名ラベルどうし、ラベルと他の部品、ラベルと GND 記号、ラベルとガイド線
//   [d] ガイド線が部品の本体（外接ボックス）を横切る、または部品を避ける経路が見つからない
//
// 部品の大きさ・ピン位置・ラベル位置・ガイド線の経路は src/ui/geometry.js で計算する（画面の描画と同じ）。
// ラベルの幅は文字数からの見積もり（geometry.js の estimateTextWidth。実測より少し大きめ）。
import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"));
const problemsArg = args.find((a) => a.startsWith("--problems="));
const PROBLEMS_DIR = problemsArg
  ? path.resolve(problemsArg.slice("--problems=".length))
  : path.join(ROOT, "data/problems");

const geo = await import(pathToFileURL(path.join(ROOT, "src/ui/geometry.js")).href);
const {
  DEFAULT_BOARD,
  SNAP,
  computeFixedLayout,
  getComponentRect,
  rectsOverlap,
  segmentCrossesRect,
} = geo;

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const catalog = readJson(path.join(ROOT, "data/components.json"));
const defs = new Map(catalog.components.map((c) => [c.type, c]));
const pinNamesOf = (type) => defs.get(type)?.pinNames ?? [];
const unitOf = (type, key) => defs.get(type)?.params?.find((p) => p.key === key)?.unit ?? "";

const fmt = (r) => `(${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)})`;
const fmtPt = (p) => `(${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10})`;

/**
 * 1 問分のレイアウトを検査する。
 *
 * @param {object} problem 問題 JSON（fixedComponents, layout を使う）
 * @returns {Array<{code:string, message:string}>}
 */
export function checkProblemLayout(problem, board = DEFAULT_BOARD) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });

  const fixed = Array.isArray(problem.fixedComponents) ? problem.fixedComponents : [];
  const comps = [];
  for (const fc of fixed) {
    const p = fc.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      add("b", `${fc.id}: position がない（画面では自動で並べられ、回路の形が分からない）`);
      continue;
    }
    if (p.x % SNAP !== 0 || p.y % SNAP !== 0) {
      add("b", `${fc.id}: position (${p.x},${p.y}) が ${SNAP} の倍数でない（画面では丸められて位置がずれる）`);
    }
    comps.push({
      ...fc,
      locked: true,
      position: { x: Math.round(p.x / SNAP) * SNAP, y: Math.round(p.y / SNAP) * SNAP },
    });
  }

  const result = computeFixedLayout(comps, { pinNamesOf, unitOf, layout: problem.layout ?? {}, board });
  const rects = comps.map((c) => ({ id: c.id, rect: getComponentRect(c) }));
  const { labelRects, guides } = result;
  const inBoard = (r) => r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= board.width + 0.01 && r.y + r.h <= board.height + 0.01;
  const segments = [];
  for (const net of guides.nets) {
    for (const pl of net.polylines) {
      for (let i = 0; i + 1 < pl.length; i += 1) segments.push({ net: net.net, a: pl[i], b: pl[i + 1] });
    }
  }

  // [a] 部品どうし
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i].rect, rects[j].rect)) {
        add("a", `部品の重なり: ${rects[i].id} ${fmt(rects[i].rect)} と ${rects[j].id} ${fmt(rects[j].rect)}`);
      }
    }
  }
  for (const g of guides.groundMarks) {
    for (const r of rects) {
      if (r.id === g.componentId) continue;
      if (rectsOverlap(g.rect, r.rect)) add("a", `GND記号（${g.componentId}.${g.pin}）が部品 ${r.id} と重なる`);
    }
  }

  // [b] はみ出し
  for (const r of rects) {
    if (!inBoard(r.rect)) add("b", `部品 ${r.id} ${fmt(r.rect)} がボード ${board.width}x${board.height} の外にはみ出す`);
  }
  for (const l of labelRects) {
    if (!inBoard(l.rect)) add("b", `${l.owner} の${kindJa(l.kind)}「${l.text}」がボードの外にはみ出す ${fmt(l.rect)}`);
  }
  for (const g of guides.groundMarks) {
    if (!inBoard(g.rect)) add("b", `GND記号（${g.componentId}.${g.pin}）がボードの外にはみ出す`);
  }
  for (const s of segments) {
    for (const p of [s.a, s.b]) {
      if (p.x < 0 || p.y < 0 || p.x > board.width || p.y > board.height) {
        add("b", `ネット ${s.net} のガイド線がボードの外を通る ${fmtPt(p)}`);
      }
    }
  }

  // [c] ラベル
  for (let i = 0; i < labelRects.length; i += 1) {
    for (let j = i + 1; j < labelRects.length; j += 1) {
      const A = labelRects[i];
      const B = labelRects[j];
      if (rectsOverlap(A.rect, B.rect)) {
        add("c", `ラベルの重なり: ${A.owner} の${kindJa(A.kind)}「${A.text}」と ${B.owner} の${kindJa(B.kind)}「${B.text}」`);
      }
    }
  }
  for (const l of labelRects) {
    for (const r of rects) {
      if (r.id === l.owner) continue;
      if (rectsOverlap(l.rect, r.rect)) add("c", `${l.owner} の${kindJa(l.kind)}「${l.text}」が部品 ${r.id} に重なる`);
    }
    for (const g of guides.groundMarks) {
      if (rectsOverlap(l.rect, g.rect)) add("c", `${l.owner} の${kindJa(l.kind)}「${l.text}」が GND記号（${g.componentId}.${g.pin}）に重なる`);
    }
    const nets = new Set();
    for (const s of segments) {
      if (!nets.has(s.net) && segmentCrossesRect(s.a, s.b, l.rect, 0.5)) nets.add(s.net);
    }
    for (const net of nets) add("c", `${l.owner} の${kindJa(l.kind)}「${l.text}」にネット ${net} のガイド線が重なる`);
  }

  // [d] ガイド線と部品本体
  for (const s of segments) {
    for (const r of rects) {
      if (segmentCrossesRect(s.a, s.b, r.rect, 0.5)) {
        add("d", `ネット ${s.net} のガイド線 ${fmtPt(s.a)}→${fmtPt(s.b)} が部品 ${r.id} を横切る`);
      }
    }
  }
  for (const f of guides.failures) {
    add("d", `ネット ${f.net}: ${f.componentId}.${f.pin} へのガイド線を引けない（${f.reason}）`);
  }

  // 注意（終了コードには含めない）: 固定の GND 部品は、gnd ピンに GND 記号が自動で付くので通常は不要
  if (problem.layout?.guides !== false && problem.layout?.groundSymbols !== false) {
    for (const c of comps) {
      if (c.type === "GND") {
        add("note", `${c.id}: 固定の GND 部品は不要（gnd ピンには GND 記号が自動で付き、配線モードではその記号をクリックして gnd に配線できる）`);
      }
    }
  }

  return issues;
}

function kindJa(kind) {
  return kind === "id" ? "IDラベル" : kind === "value" ? "値ラベル" : "ピン名ラベル";
}

/* ==========================================================================
   自己テスト（合成レイアウトで検出できるか）
   ========================================================================== */

function selfTest() {
  const V = (id, x, y, rot, connect) => ({ id, type: "V_DC", params: { V: 5 }, connect, rotation: rot, position: { x, y } });
  const R = (id, x, y, rot, connect) => ({ id, type: "R", params: { R: 1000 }, connect, rotation: rot, position: { x, y } });
  const TP = (id, x, y, net) => ({ id, type: "TP", params: {}, connect: [net], position: { x, y } });
  const codes = (issues) => issues.map((i) => i.code);
  const cases = [
    {
      // 縦置き電源 1 個だけ: 上ピンのラベルと ID ラベルが重ならない（以前は重なっていた）
      name: "縦置き電源のラベルが重ならない",
      problem: { fixedComponents: [V("V1", 100, 180, 90, ["vin", "gnd"])] },
      expect: (is) => is.length === 0,
    },
    {
      // 電源 → 抵抗 → TP のきれいな配置: 何も検出しない、ガイド線が引ける
      name: "きれいな配置は合格",
      problem: {
        fixedComponents: [
          V("V1", 100, 200, 90, ["vin", "gnd"]),
          R("R1", 260, 120, 0, ["vin", "out"]),
          TP("TP1", 480, 60, "out"),
          R("RL", 560, 200, 90, ["out", "gnd"]),
        ],
      },
      expect: (is) => is.length === 0,
    },
    {
      // エミッタを gnd に直結しても、長い値ラベルが自動 GND 記号と重ならない（値ラベルは本体の右横へ）
      name: "トランジスタのエミッタ直結 GND と値ラベルが重ならない",
      problem: {
        fixedComponents: ["Q_NPN", "M_N", "J_N"].map((type, i) => ({
          id: `Q${i + 1}`, type, params: { Is: 1e-14, Bf: 200 }, connect: ["c", "b", "gnd"], rotation: 0,
          position: { x: 100 + 200 * i, y: 200 },
        })),
        layout: { guides: true },
      },
      expect: (is) => !codes(is).includes("c") && !codes(is).includes("a"),
    },
    {
      // SW_V（4 端子）: 制御入力は左、接点は右。ID・値・ピン名ラベルが重ならない（0° と 90°）
      name: "SW_V のラベルが重ならない",
      problem: {
        fixedComponents: [
          { id: "S1", type: "SW_V", params: { Ron: 0.01, Vth: 2.5 }, connect: ["a", "b", "ctl", "gnd"], rotation: 0, position: { x: 200, y: 200 } },
          { id: "S2", type: "SW_V", params: { Ron: 0.01, Vth: 2.5 }, connect: ["a2", "b2", "ctl2", "gnd"], rotation: 90, position: { x: 500, y: 200 } },
        ],
      },
      expect: (is) => !codes(is).includes("c") && !codes(is).includes("a"),
    },
    {
      // 分野 D/E の新部品（XTAL, V_AM, V_FM, V_VCO, MULT）: 0° と 90° で ID・値・ピン名ラベルが重ならない
      name: "XTAL / V_AM / V_FM / V_VCO / MULT のラベルが重ならない",
      problem: {
        fixedComponents: [0, 90].flatMap((rot, r) => {
          const y = 100 + r * 240;
          const at = (i) => ({ x: 60 + i * 170, y });
          return [
            { id: `X${rot}`, type: "XTAL", params: { Lm: 0.1, Cm: 2.5e-11 }, connect: [`a${rot}`, `b${rot}`], rotation: rot, position: at(0) },
            { id: `AM${rot}`, type: "V_AM", params: { Vc: 1, fcHz: 10000 }, connect: [`c${rot}`, `d${rot}`], rotation: rot, position: at(1) },
            { id: `FM${rot}`, type: "V_FM", params: { Vpk: 1, fcHz: 10000 }, connect: [`e${rot}`, `f${rot}`], rotation: rot, position: at(2) },
            { id: `VCO${rot}`, type: "V_VCO", params: { f0Hz: 1000, KvHzPerV: 100 }, connect: [`g${rot}`, `h${rot}`, `i${rot}`, `j${rot}`], rotation: rot, position: at(3) },
            { id: `M${rot}`, type: "MULT", params: { k: 1 }, connect: [`k${rot}`, `l${rot}`, `m${rot}`], rotation: rot, position: at(4) },
          ];
        }),
      },
      expect: (is) => !codes(is).includes("c") && !codes(is).includes("a"),
    },
    {
      name: "部品の重なりを検出 [a]",
      problem: { fixedComponents: [R("R1", 200, 200, 0, ["a", "b"]), R("R2", 240, 210, 0, ["c", "d"])] },
      expect: (is) => codes(is).includes("a"),
    },
    {
      name: "ボード外へのはみ出しを検出 [b]",
      problem: { fixedComponents: [R("R1", 920, 200, 0, ["a", "b"])] },
      expect: (is) => codes(is).includes("b"),
    },
    {
      name: "10 の倍数でない position を検出 [b]",
      problem: { fixedComponents: [R("R1", 205, 200, 0, ["a", "b"])] },
      expect: (is) => codes(is).includes("b"),
    },
    {
      // R1 の ID ラベル（上）の位置に R2 の本体がある
      name: "ラベルと他部品の重なりを検出 [c]",
      problem: { fixedComponents: [R("R1", 200, 200, 0, ["a", "b"]), R("R2", 200, 160, 0, ["c", "d"])] },
      expect: (is) => codes(is).includes("c"),
    },
    {
      // R1 と R2 を結ぶ一直線上に、別ネットの R3 がある → ガイド線は R3 を迂回する（[d] なし）
      name: "ガイド線は部品を迂回する",
      problem: {
        fixedComponents: [
          R("R1", 100, 200, 0, ["x", "a"]),
          R("R3", 300, 200, 0, ["p", "q"]),
          R("R2", 500, 200, 0, ["a", "y"]),
        ],
      },
      expect: (is) => !codes(is).includes("d"),
      extra: (problem) => {
        const comps = problem.fixedComponents.map((c) => ({ ...c, locked: true }));
        const r = computeFixedLayout(comps, { pinNamesOf, unitOf });
        const net = r.guides.nets.find((n) => n.net === "a");
        const bends = net.polylines.reduce((s, pl) => s + Math.max(0, pl.length - 2), 0);
        return net && bends >= 2 ? null : `ネット a が迂回していない（折れ点 ${bends}）`;
      },
    },
    {
      name: "手動経路が部品を横切ると検出 [d]",
      problem: {
        fixedComponents: [R("R1", 100, 200, 0, ["x", "a"]), R("R3", 300, 200, 0, ["p", "q"]), R("R2", 500, 200, 0, ["a", "y"])],
        layout: { routes: [{ net: "a", points: [[172, 219.5], [500, 219.5]] }] },
      },
      expect: (is) => codes(is).includes("d"),
    },
    {
      // ピンの出口がふさがれている（TP のピンの真下に別の部品）→ 経路なし [d]
      name: "ピンの出口がふさがれていると検出 [d]",
      problem: {
        fixedComponents: [TP("TP1", 300, 100, "a"), R("RX", 290, 150, 0, ["p", "q"]), R("R1", 500, 300, 0, ["a", "z"])],
      },
      expect: (is) => codes(is).includes("d"),
    },
    {
      name: "GND ネットは線で結ばず GND 記号にする",
      problem: { fixedComponents: [V("V1", 100, 200, 90, ["vin", "gnd"]), R("RL", 500, 200, 90, ["vin", "gnd"])] },
      expect: (is) => is.length === 0,
      extra: (problem) => {
        const comps = problem.fixedComponents.map((c) => ({ ...c, locked: true }));
        const r = computeFixedLayout(comps, { pinNamesOf, unitOf });
        if (r.guides.nets.some((n) => n.net === "gnd")) return "gnd が線で結ばれている";
        if (r.guides.groundMarks.length !== 2) return `GND 記号が ${r.guides.groundMarks.length} 個（2 個のはず）`;
        const r2 = computeFixedLayout(comps, { pinNamesOf, unitOf, layout: { groundSymbols: false } });
        if (!r2.guides.nets.some((n) => n.net === "gnd")) return "groundSymbols:false で gnd が線にならない";
        return null;
      },
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const issues = checkProblemLayout(c.problem).filter((i) => i.code !== "note");
    let error = c.expect(issues) ? null : `検査結果が期待と違う: ${JSON.stringify(issues.map((i) => `[${i.code}] ${i.message}`))}`;
    if (!error && c.extra) error = c.extra(c.problem);
    console.log(`${error ? "NG" : "OK"}  ${c.name}${error ? `\n    ${error}` : ""}`);
    if (error) failed += 1;
  }
  console.log(`\n自己テスト: ${cases.length - failed}/${cases.length} 合格`);
  return failed === 0;
}

/* ==========================================================================
   メイン
   ========================================================================== */

if (args.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}

const files = [];
for (const dir of fs.readdirSync(PROBLEMS_DIR).sort()) {
  const full = path.join(PROBLEMS_DIR, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const f of fs.readdirSync(full).sort()) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    files.push(path.join(full, f));
  }
}

let checked = 0;
let ngProblems = 0;
let total = 0;
let notesTotal = 0;
for (const file of files) {
  const problem = readJson(file);
  const id = problem.id ?? path.basename(file, ".json");
  if (only && !id.startsWith(only)) continue;
  checked += 1;
  const all = checkProblemLayout(problem);
  const issues = all.filter((i) => i.code !== "note");
  const notes = all.filter((i) => i.code === "note");
  notesTotal += notes.length;
  if (issues.length === 0) {
    console.log(`OK  ${id}`);
  } else {
    ngProblems += 1;
    total += issues.length;
    console.log(`NG  ${id}（${issues.length}件）`);
    for (const issue of issues) console.log(`    [${issue.code}] ${issue.message}`);
  }
  for (const note of notes) console.log(`    [注意] ${note.message}`);
}

console.log(`\n${checked} 問を検査: 問題あり ${ngProblems} 問 / ${total} 件（ほかに注意 ${notesTotal} 件。注意は終了コードに含めない）`);
console.log("  [a] 部品の重なり  [b] ボード外・position  [c] ラベルの重なり  [d] ガイド線が部品を横切る・引けない");
process.exit(ngProblems > 0 ? 1 : 0);
