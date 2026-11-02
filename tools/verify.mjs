// 全問題の参照解をシミュレータに通して判定を検証するツール
//
// 使い方:
//   node tools/verify.mjs            … データ検証（validateProblem / index.json との一致）と、
//                                      参照解＋referenceAnswers が全チェックに合格するか
//   node tools/verify.mjs --mutate   … 参照解の部品を1個ずつ「数値パラメータ2倍（真偽値は反転）」にした誤答、
//                                      referenceAnswers を1つずつ誤答（数値×2、選択肢は別の番号）にした誤答が
//                                      不合格になるか
//                                      デジタル部品は値の代わりに「ゲート種別を別種（同じ入力数）に差し替え」
//                                      「DFF の Q と Q_NOT の取り違え」を誤答にする（入力を短絡・定数にしていて
//                                      差し替えても同じ論理になる組み合わせは除外）
//   node tools/verify.mjs --reverse  … 極性部品を1個ずつ逆向き（connect を逆順）にした誤答が不合格になるか
//                                      （論理ゲートは入力 A と出力 Y、DFF は D と Q を入れ替えた誤答）
//                                      （SW_V は制御端子 ctrl_p と ctrl_n を入れ替えた誤答）
//                                      （OPAMP は + 入力と − 入力を入れ替えた誤答。--mutate では OPAMP の
//                                        Aol/GBP/Vpos/Vneg/Vdrop と平方則 MOSFET の RdsOn は2倍にしない＝設計値ではないモデル定数）
//   node tools/verify.mjs --drop     … 参照解の部品を1個ずつ取り除いた誤答（部品忘れ・つなぎ忘れ）が不合格になるか
//   --strict                         … 検証警告（hints が3つ無い、explanation が無い、判定ノードに固定部品が無い、
//                                      極性部品の connection が nets 形式 など）を NG にする
//   --problems=DIR                   … data/problems の代わりに DIR を使う（テスト用）
//   引数に分野ID・問題IDの先頭（例: A, B-0, C-12）を付けるとその問題だけ対象
//
// 終了コード: NG（検証エラー・参照解の不合格・index 不一致・甘い判定）が1件でもあれば 1。
//   ただし verifyNote がある問題の「甘い判定」は警告扱いで終了コードに含めない。
import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--mutate") ? "mutate"
  : args.includes("--reverse") ? "reverse"
  : args.includes("--drop") ? "drop"
  : "ref";
const strict = args.includes("--strict");
const only = args.find((a) => !a.startsWith("--"));
// --problems=DIR … 問題フォルダを差し替える（tools/test_checks.mjs のテスト用）
const problemsArg = args.find((a) => a.startsWith("--problems="));
const PROBLEMS_DIR = problemsArg
  ? path.resolve(problemsArg.slice("--problems=".length))
  : path.join(ROOT, "data/problems");

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { simulate } = await imp("src/sim/simulator.js");
const { setupReady } = await imp("src/sim/setup.js");
await setupReady;
const { runChecks, summarizeCheckResults } = await imp("src/checks/runner.js");
const { validateProblem, POLARIZED_TYPES } = await imp("src/core/validation.js");
const { componentRegistry } = await imp("src/components/registry.js");
const { buildComponentDefMap, buildCheckTypeDefMap } = await imp("src/core/loader.js");
const { GATE_DEFS, FLIPFLOP_DEFS } = await imp("src/sim/digital.js");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const componentCatalog = readJson(path.join(ROOT, "data/components.json"));
const checkTypeCatalog = readJson(path.join(ROOT, "data/checkTypes.json"));
componentRegistry.load(componentCatalog);
const validationOptions = {
  knownComponentTypes: new Set(componentCatalog.components.map((c) => c.type)),
  knownCheckTypes: new Set(checkTypeCatalog.checkTypes.map((c) => c.type)),
  componentDefs: buildComponentDefMap(componentCatalog.components),
  checkTypeDefs: buildCheckTypeDefMap(checkTypeCatalog.checkTypes),
};

// 逆向きにする極性部品（connect は components.json の pinNames 順。validateProblem がピン数一致を確認する）
// 論理ゲート・DFF は「逆向き」の代わりに入力と出力を入れ替える（digitalSwapIO）。
const isDigitalPart = (t) => !!GATE_DEFS[t] || !!FLIPFLOP_DEFS[t];
const POLAR = new Set([...POLARIZED_TYPES].filter((t) => (!t.startsWith("U_") || t === "U_OPTO") && !isDigitalPart(t)));

/* ---- デジタル問題用の誤答（--mutate: ゲート種別の差し替え・Q と Q_NOT の取り違え / --reverse: 入出力の入れ替え） ---- */

/** 判定が値を与える入力ネット（truthTable.inputs, sequence.clock / inputs）。 */
function stimulusNets(p) {
  const s = new Set();
  for (const c of p.checks || []) {
    if (c.type === "truthTable") (c.inputs || []).forEach((n) => s.add(n));
    if (c.type === "sequence") {
      if (c.clock) s.add(c.clock);
      Object.keys(c.inputs || {}).forEach((n) => s.add(n));
    }
  }
  return s;
}

/** 定数ネット（gnd=0、V_DC(n=gnd) の p、判定が駆動しない LOGIC_IN）→ 0/1。 */
function constantNets(p, comps) {
  const stim = stimulusNets(p);
  const m = new Map([["gnd", 0], ["0", 0]]);
  for (const c of comps) {
    if (c.type === "V_DC" && (c.connect?.[1] === "gnd" || c.connect?.[1] === "0")) {
      const V = Number(c.params?.V ?? 5);
      if (V >= 2) m.set(c.connect[0], 1);
      else if (V <= 0.8) m.set(c.connect[0], 0);
    }
    if (c.type === "LOGIC_IN" && c.connect?.[0] && !stim.has(c.connect[0])) {
      m.set(c.connect[0], Number(c.params?.value ?? 0) >= 0.5 ? 1 : 0);
    }
  }
  return m;
}

/** ゲート c の種別を alt に変えても、つながり方（入力の短絡・定数）から見て同じ論理になるか。 */
function sameFunctionInPlace(c, alt, consts) {
  const n = GATE_DEFS[c.type].inputs;
  const ins = c.connect.slice(0, n);
  const vars = [...new Set(ins.filter((net) => !consts.has(net)))];
  for (let a = 0; a < 1 << vars.length; a += 1) {
    const vals = ins.map((net) => (consts.has(net) ? consts.get(net) : (a >> vars.indexOf(net)) & 1));
    if (GATE_DEFS[c.type].fn(vals) !== GATE_DEFS[alt].fn(vals)) return false;
  }
  return true;
}

function digitalMutations(p, ref) {
  const out = [];
  const consts = constantNets(p, [...(p.fixedComponents || []), ...ref]);
  ref.forEach((c, i) => {
    if (GATE_DEFS[c.type]) {
      const n = GATE_DEFS[c.type].inputs;
      for (const alt of Object.keys(GATE_DEFS)) {
        if (alt === c.type || GATE_DEFS[alt].inputs !== n) continue;
        if (sameFunctionInPlace(c, alt, consts)) continue; // 入力を短絡したゲートなど、差し替えても同じ論理
        const comps = ref.map((d, j) => (j === i ? { ...d, type: alt } : d));
        out.push({ label: `${c.id}（${c.type}）を ${alt} に替えても合格`, comps });
      }
    } else if (FLIPFLOP_DEFS[c.type]) {
      const f = FLIPFLOP_DEFS[c.type];
      const connect = [...c.connect];
      [connect[f.q], connect[f.qn]] = [connect[f.qn], connect[f.q]];
      out.push({ label: `${c.id} の Q と Q_NOT を取り違えても合格`, comps: ref.map((d, j) => (j === i ? { ...d, connect } : d)) });
    }
  });
  return out;
}

function digitalSwapIO(c) {
  const connect = [...c.connect];
  if (GATE_DEFS[c.type]) {
    const n = GATE_DEFS[c.type].inputs;
    [connect[0], connect[n]] = [connect[n], connect[0]];
    return { connect, label: `${c.id} の入力 A と出力 Y を入れ替えても合格` };
  }
  const f = FLIPFLOP_DEFS[c.type];
  [connect[f.d], connect[f.q]] = [connect[f.q], connect[f.d]];
  return { connect, label: `${c.id} の D と Q を入れ替えても合格` };
}
// 取り除いても意味のない部品（GND は自動で補う、TP は電気的に何もしない）
const NO_DROP = new Set(["GND", "TP"]);

// --mutate で2倍にしないモデル定数（設計値ではないもの）。M_N/M_P の RdsOn は K>0（平方則）のときだけ除外
// ダイオード系・サイリスタ系の Rs / Vt / Ih / ゲート電圧、SW_V の Ron / Roff / Vth は理想化のための
// モデル定数（2倍にしても動作が変わらないのが正しい）。XFMR の coupling は使われない。
const MUTATE_MODEL_PARAMS = {
  OPAMP: ["Aol", "GBP", "Vpos", "Vneg", "Vdrop"],
  M_N: ["RdsOn"],
  M_P: ["RdsOn"],
  D: ["Rs"], SD: ["Rs"], LED: ["Rs"], ZD: ["Rs"], TVS: ["Rs"],
  SCR: ["Vgk", "Vt", "Ih", "Rs"],
  TRIAC: ["Vgt", "Vt", "Ih", "Rs"],
  DIAC: ["dV", "Ih", "Rs"],
  SW_V: ["Ron", "Roff", "Vth"],
  XFMR: ["coupling"],
};

const toComp = (c) => ({
  id: c.id, type: c.type, params: { ...(c.params || {}) },
  connect: [...(c.connect || [])], locked: !!c.locked, position: { x: 0, y: 0 }, rotation: 0,
});

async function evaluate(p, refComps, answers) {
  const comps = [...(p.fixedComponents || []), ...refComps].map(toComp);
  if (!comps.some((c) => c.type === "GND")) comps.push(toComp({ id: "GND_auto", type: "GND", connect: ["gnd"] }));
  const board = { components: comps, wires: [], nodes: [] };
  const sim = await simulate(board, { mode: p.judge ?? "dc", checks: p.checks, problem: p });
  const res = await runChecks(p, sim, board, { answers: answers ?? {} });
  return { ok: summarizeCheckResults(res).ok, sim, res };
}

/** 誤答の変種を列挙する: [{ label, comps, answers }] */
function variants(p) {
  const ref = p.referenceSolution || [];
  const answers = p.referenceAnswers || {};
  const out = [];
  if (mode === "mutate") {
    ref.forEach((c, i) => {
      // 設計値ではないモデル定数は2倍にしない（OPAMP の Aol/GBP/電源/Vdrop は理想に近い定数で、
      // 2倍にしても利得が変わらないのが正しい。平方則 MOSFET の RdsOn は使われない）
      const skip = new Set(MUTATE_MODEL_PARAMS[c.type] ?? []);
      if ((c.type === "M_N" || c.type === "M_P") && !(Number(c.params?.K) > 0)) skip.delete("RdsOn");
      const entries = Object.entries(c.params || {});
      const changed = entries.filter(([k, v]) => !skip.has(k) && (typeof v === "number" || typeof v === "boolean"));
      if (changed.length === 0) return;
      const params = Object.fromEntries(entries.map(([k, v]) =>
        [k, skip.has(k) ? v : typeof v === "number" ? (v === 0 ? 1 : v * 2) : typeof v === "boolean" ? !v : v]));
      const comps = ref.map((d, j) => (j === i ? { ...d, params } : d));
      out.push({ label: `${c.id} の値を2倍にしても合格`, comps, answers });
    });
    for (const v of digitalMutations(p, ref)) out.push({ ...v, answers });
    const qmap = new Map((p.questions || []).map((q) => [q.key, q]));
    for (const [key, v] of Object.entries(answers)) {
      const q = qmap.get(key);
      let wrong;
      if (q?.kind === "choice") {
        const n = Array.isArray(q.options) ? q.options.length : 2;
        wrong = (v + 1) % Math.max(n, 2);
      } else if (typeof v === "number") {
        wrong = v === 0 ? 1 : v * 2;
      } else continue;
      out.push({ label: `回答 ${key} を ${wrong} にしても合格`, comps: ref, answers: { ...answers, [key]: wrong } });
    }
  } else if (mode === "reverse") {
    ref.forEach((c, i) => {
      if (isDigitalPart(c.type) && Array.isArray(c.connect)) {
        const { connect, label } = digitalSwapIO(c);
        out.push({ label, comps: ref.map((d, j) => (j === i ? { ...d, connect } : d)), answers });
        return;
      }
      if (c.type === "SW_V" && Array.isArray(c.connect) && c.connect.length >= 4) {
        // 電圧制御スイッチの「逆向き」= 制御端子の +/− の取り違え（制御が反転して閉じない）
        const connect = [c.connect[0], c.connect[1], c.connect[3], c.connect[2]];
        out.push({ label: `${c.id} の制御端子 ctrl_p と ctrl_n を入れ替えても合格`, comps: ref.map((d, j) => (j === i ? { ...d, connect } : d)), answers });
        return;
      }
      if (c.type === "OPAMP" && Array.isArray(c.connect) && c.connect.length >= 2) {
        // オペアンプの「逆向き」= 反転入力と非反転入力の取り違え（典型的な誤り）
        const connect = [c.connect[1], c.connect[0], ...c.connect.slice(2)];
        out.push({ label: `${c.id} の + 入力と − 入力を入れ替えても合格`, comps: ref.map((d, j) => (j === i ? { ...d, connect } : d)), answers });
        return;
      }
      if (!POLAR.has(c.type) || !Array.isArray(c.connect) || c.connect.length < 2) return;
      const comps = ref.map((d, j) => (j === i ? { ...d, connect: [...d.connect].reverse() } : d));
      out.push({ label: `${c.id} を逆向きにしても合格`, comps, answers });
    });
  } else if (mode === "drop") {
    ref.forEach((c, i) => {
      if (NO_DROP.has(c.type)) return;
      out.push({ label: `${c.id} を外しても合格`, comps: ref.filter((_, j) => j !== i), answers });
    });
  }
  return out;
}

const ng = [];        // 終了コードに含める NG
const warnLax = [];   // verifyNote ありの甘い判定（警告）
const warnings = [];  // 検証警告
let checkedProblems = 0;
let passedProblems = 0;
let variantFailCount = 0;
const skipped = [];

for (const cat of fs.readdirSync(PROBLEMS_DIR).sort()) {
  const dir = path.join(PROBLEMS_DIR, cat);
  if (!fs.statSync(dir).isDirectory()) continue;
  if (only && !(cat.startsWith(only) || only.startsWith(cat))) continue;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").sort();

  // index.json とファイルの一致
  if (mode === "ref") {
    const indexPath = path.join(dir, "index.json");
    if (!fs.existsSync(indexPath)) {
      if (files.length) ng.push(`${cat}/index.json がありません`);
    } else {
      try {
        const idx = readJson(indexPath);
        const items = Array.isArray(idx) ? idx : idx.problems ?? [];
        const ids = items.map((it) => (typeof it === "string" ? it : it.id ?? it.problemId));
        const fileIds = files.map((f) => f.replace(/\.json$/, ""));
        for (const id of ids) {
          if (only && !id.startsWith(only)) continue;
          if (!fileIds.includes(id)) ng.push(`${cat}/index.json に ${id} があるがファイルがありません`);
        }
        for (const id of fileIds) {
          if (only && !id.startsWith(only)) continue;
          if (!ids.includes(id)) ng.push(`${cat}/${id}.json が index.json に載っていません`);
        }
        const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dup.length) ng.push(`${cat}/index.json に重複があります: ${[...new Set(dup)].join(", ")}`);
      } catch (e) {
        ng.push(`${cat}/index.json を読めません: ${e.message}`);
      }
    }
  }

  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    if (only && !id.startsWith(only)) continue;
    let p;
    try {
      p = readJson(path.join(dir, f));
    } catch (e) {
      ng.push(`${id}: JSON を読めません（${e.message}）`);
      continue;
    }
    if (p.id !== id) ng.push(`${id}: ファイル名と id（${p.id}）が一致しません`);
    if (p.category !== cat) ng.push(`${id}: category（${p.category}）がフォルダ ${cat} と一致しません`);
    checkedProblems++;

    if (mode === "ref") {
      const v = validateProblem(p, validationOptions);
      for (const e of v.errors) ng.push(`${id}: 検証エラー: ${e}`);
      for (const w of v.warnings || []) {
        if (strict) ng.push(`${id}: [strict] ${w}`);
        else warnings.push(`${id}: ${w}`);
      }
      try {
        const r = await evaluate(p, p.referenceSolution || [], p.referenceAnswers);
        if (r.ok) passedProblems++;
        else {
          const fails = r.res.filter((x) => !x.ok).map((x) => `${x.type}: ${x.message}`);
          ng.push(`${id}: 参照解が不合格: ${JSON.stringify({ simErr: (r.sim.errors || []).slice(0, 2), fails })}`);
        }
        for (const w of (r.sim.warnings || []).filter((w) => /未対応/.test(w))) {
          warnings.push(`${id}: シミュレーション警告: ${w}`);
        }
      } catch (e) {
        ng.push(`${id}: 例外: ${e?.stack ?? e}`);
      }
      continue;
    }

    const vs = variants(p);
    if (vs.length === 0) {
      skipped.push(id);
      continue;
    }
    const lax = [];
    for (const v of vs) {
      try {
        const r = await evaluate(p, v.comps, v.answers);
        if (r.ok) lax.push(v.label);
        else variantFailCount++;
      } catch {
        variantFailCount++;
      }
    }
    if (lax.length === 0) passedProblems++;
    else {
      const msg = `甘い判定の可能性: ${id}（${lax.join("、")}）`;
      if (p.verifyNote) warnLax.push(`${msg} … verifyNote: ${p.verifyNote}`);
      else ng.push(msg);
    }
  }
}

if (mode === "ref") {
  console.log(`[参照解検証${strict ? " --strict" : ""}] 対象 ${checkedProblems} 問 / 参照解が合格 ${passedProblems} 問 / NG ${ng.length} 件 / 警告 ${warnings.length} 件`);
} else {
  console.log(`[${mode}] 対象 ${checkedProblems - skipped.length} 問: 誤答がすべて不合格 ${passedProblems} 問 / 甘い判定 ${ng.length + warnLax.length} 問（うち verifyNote あり ${warnLax.length}）/ 不合格になった誤答 ${variantFailCount} 件${skipped.length ? ` / 対象外 ${skipped.length} 問${skipped.length <= 10 ? `（${skipped.join(", ")}）` : ""}` : ""}`);
}
for (const m of ng) console.log("NG", m);
for (const m of warnLax) console.log("警告", m);
if (warnings.length) {
  const MAX = 60;
  for (const m of warnings.slice(0, MAX)) console.log("警告", m);
  if (warnings.length > MAX) console.log(`警告 … ほか ${warnings.length - MAX} 件（--strict で NG として全件表示）`);
}
process.exitCode = ng.length ? 1 : 0;
