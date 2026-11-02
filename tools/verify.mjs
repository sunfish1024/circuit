// 全問題の参照解をシミュレータに通して判定を検証するツール
// 使い方:
//   node tools/verify.mjs            … 参照解が全チェックに合格するか
//   node tools/verify.mjs --mutate   … 参照解の数値を2倍にした誤答が「不合格」になるか（判定が甘くないか）
//   node tools/verify.mjs --reverse  … 極性部品を逆向きにした誤答が「不合格」になるか
//   第1引数以外に分野ID（例: A, B-0）を付けるとその問題だけ対象
import fs from "fs"; import path from "path"; import { pathToFileURL, fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--mutate") ? "mutate" : args.includes("--reverse") ? "reverse" : "ref";
const only = args.find(a => !a.startsWith("--"));
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const { simulate } = await imp("src/sim/simulator.js");
const { setupReady } = await imp("src/sim/setup.js"); await setupReady;
const { runChecks, summarizeCheckResults } = await imp("src/checks/runner.js");
const POLAR = new Set(["D","LED","ZD","SD","TVS","Q_NPN","Q_PNP","M_N","M_P","J_N","SCR","OPAMP","V_DC","I_DC","PD"]);
const toComp = c => ({ id:c.id, type:c.type, params:{...(c.params||{})}, connect:[...(c.connect||[])], locked:!!c.locked, position:{x:0,y:0}, rotation:0 });
function variant(ref) {
  if (mode === "mutate") return ref.map(c => ({...c, params:Object.fromEntries(Object.entries(c.params||{}).map(([k,v])=>[k, typeof v==="number" ? v*2 : v]))}));
  if (mode === "reverse") return ref.map(c => POLAR.has(c.type) ? {...c, connect:[...c.connect].reverse()} : c);
  return ref;
}
const pass = [], fail = [], skipped = [];
for (const cat of fs.readdirSync(path.join(ROOT,"data/problems")).sort()) {
  for (const f of fs.readdirSync(path.join(ROOT,"data/problems",cat)).sort()) {
    if (f === "index.json" || !f.endsWith(".json")) continue;
    const p = JSON.parse(fs.readFileSync(path.join(ROOT,"data/problems",cat,f), "utf8"));
    if (only && !p.id.startsWith(only)) continue;
    const ref = p.referenceSolution || [];
    if (mode === "reverse" && !ref.some(c => POLAR.has(c.type))) { skipped.push(p.id); continue; }
    const comps = [...(p.fixedComponents||[]), ...variant(ref)].map(toComp);
    if (!comps.some(c => c.type === "GND")) comps.push(toComp({id:"GND_auto",type:"GND",connect:["gnd"]}));
    const board = { components: comps, wires: [], nodes: [] };
    try {
      const sim = await simulate(board, { mode: p.judge ?? "dc", checks: p.checks });
      const res = await runChecks(p, sim, board, { answers: p.referenceAnswers ?? {} });
      const ok = summarizeCheckResults(res).ok;
      (ok ? pass : fail).push({ id:p.id, simErr:(sim.errors||[]).slice(0,2), fails:res.filter(r=>!r.ok).map(r=>`${r.type}: ${r.message}`) });
    } catch (e) { fail.push({ id:p.id, err:String(e) }); }
  }
}
if (mode === "ref") {
  console.log(`[参照解検証] 合格 ${pass.length} / 不合格 ${fail.length}`);
  for (const f of fail) console.log("NG", JSON.stringify(f));
  process.exitCode = fail.length ? 1 : 0;
} else {
  console.log(`[${mode}] 誤答が正しく不合格 ${fail.length} / 誤答なのに合格 ${pass.length}${skipped.length ? ` / 対象外 ${skipped.length}` : ""}`);
  for (const p of pass) console.log("甘い判定の可能性:", p.id);
}
