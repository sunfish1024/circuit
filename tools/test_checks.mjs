// 判定・シミュレータの単体テスト（手計算で答えが分かる小さな回路）
//
// 使い方: node tools/test_checks.mjs
// 失敗が1件でもあれば終了コード 1。
//
// 許容誤差の根拠:
// - DC: 線形 MNA を直接解くので丸め誤差のみ。閉じた SW(1mΩ)・L(1mΩ) の影響も 1e-6 程度 → 0.01% で比較。
// - 過渡: 台形則・刻み h ≤ τ/100。台形則の大域相対誤差は (h/τ)²/12 ≈ 1e-5、
//   最初の2ステップの後退オイラーの誤差が (h/τ)²/2 ×2 ≈ 1e-4、線形補間の誤差 ≈ (h/τ)²/8 ≈ 1e-5。
//   合計しても 0.1% 未満なので、テストは 0.5% で比較する（問題では 2〜5% を推奨）。
// - 振動周波数: 刻み T/100 の台形則の位相誤差は (ωh)²/12 ≈ 3e-4、零交差の線形補間誤差も同程度 → 0.5%。
// - AC: 複素 MNA を直接解くので丸め誤差のみ → 0.01dB / 0.01° / 0.01% で比較。
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { simulate } = await imp("src/sim/simulator.js");
const { setupReady } = await imp("src/sim/setup.js");
await setupReady;
const { runChecks, runSingleCheck } = await imp("src/checks/runner.js");
const { validateProblem } = await imp("src/core/validation.js");
const { componentRegistry } = await imp("src/components/registry.js");
const { buildComponentDefMap, buildCheckTypeDefMap } = await imp("src/core/loader.js");
const { pulseValue } = await imp("src/sim/transient.js");

const componentCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, "data/components.json"), "utf8"));
const checkTypeCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, "data/checkTypes.json"), "utf8"));
componentRegistry.load(componentCatalog);
const vopts = {
  knownComponentTypes: new Set(componentCatalog.components.map((c) => c.type)),
  knownCheckTypes: new Set(checkTypeCatalog.checkTypes.map((c) => c.type)),
  componentDefs: buildComponentDefMap(componentCatalog.components),
  checkTypeDefs: buildCheckTypeDefMap(checkTypeCatalog.checkTypes),
};

let passed = 0;
const failures = [];
function expect(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` … ${detail}` : ""}`);
}
function near(name, actual, expected, relTol, absTol = 0) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(Math.abs(expected) * relTol, absTol);
  expect(name, ok, `期待 ${expected}, 実際 ${actual}`);
}

const comp = (id, type, connect, params = {}) => ({ id, type, connect, params, position: { x: 0, y: 0 }, rotation: 0 });
const board = (...components) => ({ components: [...components, comp("G", "GND", ["gnd"])], wires: [], nodes: [] });
async function check(b, mode, chk, context = {}, problem = null) {
  const sim = await simulate(b, { mode, checks: [chk], problem });
  return runSingleCheck(chk, { simulationResult: sim, circuit: b, context });
}

/* ---------------------------------------------------------------- connection */
{
  // 旧B-47 型: D1 のカソードを VCC、アノードを collector に付けるのが正解
  const good = board(comp("D1", "D", ["collector", "VCC"], { Vf: 0.7 }));
  const bad = board(comp("D1", "D", ["VCC", "collector"], { Vf: 0.7 }));
  const pinsCheck = { type: "connection", element: "D1", pins: { anode: "collector", cathode: "VCC" } };
  const aliasCheck = { type: "connection", element: "D1", pins: { A: "collector", K: "VCC" } };
  const netsCheck = { type: "connection", element: "D1", nets: ["VCC", "collector"] };
  expect("connection pins: 正しい向きで合格", (await check(good, "dc", pinsCheck)).ok);
  expect("connection pins: 逆向きで不合格", !(await check(bad, "dc", pinsCheck)).ok);
  expect("connection pins 略記 A/K: 正しい向きで合格", (await check(good, "dc", aliasCheck)).ok);
  expect("connection pins 略記 A/K: 逆向きで不合格", !(await check(bad, "dc", aliasCheck)).ok);
  expect("connection nets（後方互換）: 正しい向きで合格", (await check(good, "dc", netsCheck)).ok);
  expect("connection nets（後方互換）: 逆向きでも合格（向きを見ない仕様）", (await check(bad, "dc", netsCheck)).ok);
  const missing = await check(board(), "dc", pinsCheck);
  expect("connection: 部品が無ければ不合格", !missing.ok && /見つかりません/.test(missing.message));
  const typeCheck = { ...pinsCheck, componentType: "LED" };
  expect("connection componentType: 種別違いで不合格", !(await check(good, "dc", typeCheck)).ok);
  const badPin = await check(good, "dc", { type: "connection", element: "D1", pins: { gate: "x" } });
  expect("connection: 存在しないピン名はエラーで不合格", !badPin.ok && /ピン/.test(badPin.message));
  // BJT: C/B/E の略記
  const q = board(comp("Q1", "Q_NPN", ["c", "b", "gnd"]));
  expect("connection BJT 略記 C/B/E", (await check(q, "dc", { type: "connection", element: "Q1", pins: { C: "c", B: "b", E: "gnd" } })).ok);
  expect("connection BJT C/E 入れ替えで不合格", !(await check(q, "dc", { type: "connection", element: "Q1", pins: { C: "gnd", E: "c" } })).ok);
}

/* ---------------------------------------------------------------- match（ID ではなく種別と接続で部品を特定） */
{
  // 参照解は R1(1k)=vin-out, R2(2k)=out-gnd。プレイヤーは置いた順が逆で ID が入れ替わっている
  const swapped = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 3 }),
    comp("R2", "R", ["vin", "out"], { R: 1000 }),
    comp("R1", "R", ["out", "gnd"], { R: 2000 }),
    comp("TP1", "TP", ["out"])
  );
  expect("ID 指定は ID 取り違えで不合格になる（match が必要な理由）",
    !(await check(swapped, "dc", { type: "componentValue", element: "R1", expected: 1000 })).ok);
  const mv = await check(swapped, "dc", { type: "componentValue", match: { type: "R", nets: ["vin", "out"] }, expected: 1000 });
  expect("match: componentValue（vin-out 間の R = 1k）", mv.ok && mv.details?.matchedElement === "R2", mv.message);
  expect("match: nets は順不同", (await check(swapped, "dc", { type: "componentValue", match: { type: "R", nets: ["out", "vin"] }, expected: 1000 })).ok);
  const mi = await check(swapped, "dc", { type: "dcCurrent", match: { type: "R", nets: ["out", "gnd"] }, expected: 0.001, tolerancePct: 0.1 });
  expect("match: dcCurrent（out-gnd 間の R に 1mA）", mi.ok, mi.message);
  const none = await check(swapped, "dc", { type: "componentValue", match: { type: "C", nets: ["vin", "out"] }, expected: 1e-6 });
  expect("match: 該当なしは「条件に合う部品がありません」", !none.ok && /条件に合う部品がありません/.test(none.message), none.message);
  // 複数該当: どれか1つが合格すれば合格
  const two = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 3 }),
    comp("R1", "R", ["vin", "gnd"], { R: 1000 }),
    comp("R2", "R", ["vin", "gnd"], { R: 2200 })
  );
  expect("match: 複数該当でどれかが合格なら合格", (await check(two, "dc", { type: "componentValue", match: { type: "R", nets: ["vin", "gnd"] }, expected: 2200 })).ok);
  expect("match: 複数該当でどれも違えば不合格", !(await check(two, "dc", { type: "componentValue", match: { type: "R", nets: ["vin", "gnd"] }, expected: 4700 })).ok);
  // 極性: match.pins / connection + match
  const dGood = board(comp("D7", "D", ["collector", "VCC"]));
  const dBad = board(comp("D7", "D", ["VCC", "collector"]));
  const cm = { type: "connection", match: { type: "D" }, pins: { anode: "collector", cathode: "VCC" } };
  expect("match + connection pins: 正しい向き（ID は D7 でも可）", (await check(dGood, "dc", cm)).ok);
  expect("match + connection pins: 逆向きは不合格", !(await check(dBad, "dc", cm)).ok);
  const mp = await check(board(comp("D7", "D", ["collector", "VCC"], { Vf: 0.7 })), "dc", { type: "componentValue", match: { type: "D", pins: { K: "VCC" } }, param: "Vf", expected: 0.7 });
  expect("match.pins（カソードが VCC の D）", mp.ok, mp.message);
  const mpBad = await check(board(comp("D7", "D", ["VCC", "collector"], { Vf: 0.7 })), "dc", { type: "componentValue", match: { type: "D", pins: { K: "VCC" } }, param: "Vf", expected: 0.7 });
  expect("match.pins: 逆向きの D は該当しない", !mpBad.ok);
  // 過渡: transientPoint / timeConstant も match で
  const rc = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 5 }),
    comp("R9", "R", ["vin", "out"], { R: 1000 }),
    comp("C4", "C", ["out", "gnd"], { C: 1e-6 })
  );
  expect("match: timeConstant（element 相当）", (await check(rc, "transient", { type: "timeConstant", match: { type: "C", nets: ["out", "gnd"] }, expected: 1e-3, tolerancePct: 0.5 })).ok);
}

/* ---------------------------------------------------------------- numericAnswer / multipleChoice */
{
  const na = { type: "numericAnswer", key: "q1", expected: 0.0125, tolerancePct: 2, unit: "A" };
  const run = (answers) => runSingleCheck(na, { context: { answers } });
  expect("numericAnswer: 正答 0.0125 で合格", (await run({ q1: 0.0125 })).ok);
  expect("numericAnswer: 文字列 '12.5m' で合格", (await run({ q1: "12.5m" })).ok);
  expect("numericAnswer: +1.9%（0.0127375）で合格", (await run({ q1: 0.0125 * 1.019 })).ok);
  expect("numericAnswer: +2.1%（0.0127625）で不合格", !(await run({ q1: 0.0125 * 1.021 })).ok);
  expect("numericAnswer: −2.1% で不合格", !(await run({ q1: 0.0125 * 0.979 })).ok);
  expect("numericAnswer: 2倍で不合格", !(await run({ q1: 0.025 })).ok);
  const un = await run({});
  expect("numericAnswer: 未回答で不合格「未回答です」", !un.ok && un.message === "未回答です。");
  const wrong = await run({ q1: 0.025 });
  expect("numericAnswer: 不正解メッセージに期待値を出さない", !/0\.0125|12\.5/.test(wrong.message), wrong.message);
  expect("numericAnswer: 読めない文字列で不合格", !(await run({ q1: "abc" })).ok);
  const zero = { type: "numericAnswer", key: "q1", expected: 0, toleranceAbs: 0.01 };
  expect("numericAnswer: 期待値0 + toleranceAbs", (await runSingleCheck(zero, { context: { answers: { q1: 0.005 } } })).ok);

  const mc = { type: "multipleChoice", key: "q2", answerIndex: 1 };
  const runMc = (answers) => runSingleCheck(mc, { context: { answers } });
  expect("multipleChoice: 1 で合格", (await runMc({ q2: 1 })).ok);
  expect("multipleChoice: '1'（文字列）で合格", (await runMc({ q2: "1" })).ok);
  expect("multipleChoice: 0 で不合格", !(await runMc({ q2: 0 })).ok);
  expect("multipleChoice: 未回答で不合格", !(await runMc({})).ok);
  expect("multipleChoice: 別の key の回答は使わない", !(await runMc({ q3: 1 })).ok);
}

/* ---------------------------------------------------------------- DC（TP / I_DC） */
{
  // 10V, R1=R2=1k の分圧。out に TP。Vout=5V, I=5mA, P(R1)=25mW
  const b = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }),
    comp("R1", "R", ["vin", "out"], { R: 1000 }),
    comp("R2", "R", ["out", "gnd"], { R: 1000 }),
    comp("TP1", "TP", ["out"])
  );
  const sim = await simulate(b, { mode: "dc" });
  near("DC 分圧 Vout=5V（TP あり）", sim.dc.nodes.out, 5, 1e-4);
  near("DC 電流 I(R1)=5mA", Math.abs(sim.dc.elements.R1.i), 0.005, 1e-4);
  near("DC 電力 P(R1)=25mW", Math.abs(sim.dc.elements.R1.p), 0.025, 1e-4);
  near("DC 電源電流 |I(V1)|=5mA", Math.abs(sim.dc.elements.V1.i), 0.005, 1e-4);
  expect("dcVoltage 判定", (await check(b, "dc", { type: "dcVoltage", node: "out", expected: 5, tolerancePct: 1 })).ok);
  expect("dcPower 判定（2倍は不合格）", !(await check(b, "dc", { type: "dcPower", element: "R1", expected: 0.05, tolerancePct: 1 })).ok);
  // I_DC 1mA を 2.2k に流す: p 端子から外部回路へ流れ出す向き → V(out)=+2.2V
  const bi = board(comp("I1", "I_DC", ["out", "gnd"], { I: 0.001 }), comp("R1", "R", ["out", "gnd"], { R: 2200 }), comp("TP1", "TP", ["out"]));
  near("DC I_DC 1mA × 2.2kΩ = 2.2V（p から流れ出す向き）", (await simulate(bi, { mode: "dc" })).dc.nodes.out, 2.2, 1e-4);
}

/* ---------------------------------------------------------------- 過渡: RC / V_PULSE / RL / RLC */
const RC = (extra = []) => board(
  comp("V1", "V_DC", ["vin", "gnd"], { V: 5 }),
  comp("R1", "R", ["vin", "out"], { R: 1000 }),
  comp("C1", "C", ["out", "gnd"], { C: 1e-6 }),
  comp("TP1", "TP", ["out"]),
  ...extra
);
{
  // RC 充電: τ = 1kΩ × 1µF = 1ms。v(τ)=5(1−e⁻¹)=3.1606V, v(3τ)=4.7511V
  const b = RC();
  const sim = await simulate(b, { mode: "transient" });
  near("過渡 RC τ（R_th 法）= 1ms", sim.transient.timeConstant, 1e-3, 1e-6);
  const tc = await check(b, "transient", { type: "timeConstant", node: "out", expected: 1e-3, tolerancePct: 0.5 });
  expect("timeConstant node 法 = 1ms ±0.5%", tc.ok, tc.message);
  const p1 = await check(b, "transient", { type: "transientPoint", node: "out", timeSec: 1e-3, expected: 5 * (1 - Math.exp(-1)), tolerancePct: 0.5 });
  expect("transientPoint v(1ms)=3.1606V ±0.5%", p1.ok, p1.message);
  const p3 = await check(b, "transient", { type: "transientPoint", node: "out", timeSec: 3e-3, expected: 5 * (1 - Math.exp(-3)), tolerancePct: 0.5 });
  expect("transientPoint v(3ms)=4.7511V ±0.5%", p3.ok, p3.message);
  near("過渡 t=0 の out は 0V（C 初期電圧 0）", sim.transient.nodes.out[0], 0, 0, 1e-6);
  near("過渡 自動 tStop ≥ 10τ", Math.max(sim.transient.tStop, 0), Math.max(sim.transient.tStop, 0.01), 0);
  // 電源を外すとステップ応答がないので node 法は不合格（R_th 法は通ってしまう → node 法を推奨する理由）
  const noSrc = board(comp("R1", "R", ["vin", "out"], { R: 1000 }), comp("C1", "C", ["out", "gnd"], { C: 1e-6 }), comp("R0", "R", ["vin", "gnd"], { R: 1 }));
  expect("timeConstant node 法: 電源なしで不合格", !(await check(noSrc, "transient", { type: "timeConstant", node: "out", expected: 1e-3 })).ok);

  // 直列 R1=1k + R2=2k と C=1µF: τ = 3ms（旧実装は min(R)·C = 1ms を返していた）
  const s = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 5 }),
    comp("R1", "R", ["vin", "m"], { R: 1000 }),
    comp("R2", "R", ["m", "out"], { R: 2000 }),
    comp("C1", "C", ["out", "gnd"], { C: 1e-6 })
  );
  near("過渡 直列RC τ=(R1+R2)C=3ms", (await simulate(s, { mode: "transient" })).transient.timeConstant, 3e-3, 1e-6);
  // テブナン: 10V—2k—out—2k—gnd、C=1µF を out-gnd: R_th = 1k → τ = 1ms、v∞ = 5V
  const th = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }),
    comp("R1", "R", ["vin", "out"], { R: 2000 }),
    comp("R2", "R", ["out", "gnd"], { R: 2000 }),
    comp("C1", "C", ["out", "gnd"], { C: 1e-6 })
  );
  const thSim = await simulate(th, { mode: "transient" });
  near("過渡 テブナン R_th=1k → τ=1ms", thSim.transient.timeConstant, 1e-3, 1e-6);
  expect("timeConstant node 法（テブナン）", (await check(th, "transient", { type: "timeConstant", node: "out", expected: 1e-3, tolerancePct: 0.5 })).ok);
  // C の初期電圧: C=100µF initialV=5V、15V から 200Ω で充電。v(τ=20ms) = 15 − 10e⁻¹ = 11.321V
  const iv = board(
    comp("V1", "V_DC", ["vcc", "gnd"], { V: 15 }),
    comp("R1", "R", ["vcc", "a"], { R: 200 }),
    comp("C1", "C", ["a", "gnd"], { C: 1e-4, initialV: 5 })
  );
  expect("transientPoint 初期電圧あり v(20ms)=11.321V", (await check(iv, "transient", { type: "transientPoint", node: "a", timeSec: 0.02, expected: 15 - 10 * Math.exp(-1), tolerancePct: 0.5 })).ok);
}
{
  // V_PULSE: 1ms 遅れて 0→5V のステップ、RC τ=1ms。v(2ms) = 3.1606V
  const pulseStep = { Vlow: 0, Vhigh: 5, delaySec: 1e-3, riseSec: 1e-9, fallSec: 1e-9, widthSec: 1, periodSec: 0 };
  expect("pulseValue: 遅延前は Vlow", pulseValue({ v1: 0, v2: 5, td: 1e-3, tr: 1e-9, tf: 1e-9, pw: 1, per: 0 }, 0.5e-3) === 0);
  const b = board(
    comp("V1", "V_PULSE", ["vin", "gnd"], pulseStep),
    comp("R1", "R", ["vin", "out"], { R: 1000 }),
    comp("C1", "C", ["out", "gnd"], { C: 1e-6 })
  );
  const r = await check(b, "transient", { type: "transientPoint", node: "out", timeSec: 2e-3, expected: 5 * (1 - Math.exp(-1)), tolerancePct: 0.5 });
  expect("V_PULSE ステップ（delay 1ms）v(2ms)=3.1606V", r.ok, r.message);
  const r0 = await check(b, "transient", { type: "transientPoint", node: "out", timeSec: 0.9e-3, expected: 0, toleranceAbs: 1e-6 });
  expect("V_PULSE 遅延前 v(0.9ms)=0V", r0.ok, r0.message);
  const tcp = await check(b, "transient", { type: "timeConstant", node: "out", fromSec: 1e-3, toSec: 12e-3, expected: 1e-3, tolerancePct: 0.5 });
  expect("timeConstant node 法 fromSec=delay", tcp.ok, tcp.message);

  // 方形波: 周期 20ms、幅 10ms（High 0〜10ms）。10ms で 5(1−e⁻¹⁰)≈4.99977V まで充電、
  // 立ち下がり後 1ms: v(11ms) = 4.99977·e⁻¹ = 1.8393V
  const sq = board(
    comp("V1", "V_PULSE", ["vin", "gnd"], { Vlow: 0, Vhigh: 5, delaySec: 0, riseSec: 1e-9, fallSec: 1e-9, widthSec: 10e-3, periodSec: 20e-3 }),
    comp("R1", "R", ["vin", "out"], { R: 1000 }),
    comp("C1", "C", ["out", "gnd"], { C: 1e-6 })
  );
  const vexp = 5 * (1 - Math.exp(-10)) * Math.exp(-1);
  const rs = await check(sq, "transient", { type: "transientPoint", node: "out", timeSec: 11e-3, expected: vexp, tolerancePct: 0.5 });
  expect("V_PULSE 方形波 放電 v(11ms)=1.8393V", rs.ok, rs.message);
  // 2周期目の立ち上がり後 1ms: v(21ms) ≈ v(20ms) + (5 − v(20ms))(1−e⁻¹)、v(20ms)=4.99977e⁻¹⁰≈2.27e-4
  const v20 = 5 * (1 - Math.exp(-10)) * Math.exp(-10);
  const rs2 = await check(sq, "transient", { type: "transientPoint", node: "out", timeSec: 21e-3, expected: v20 + (5 - v20) * (1 - Math.exp(-1)), tolerancePct: 0.5 }, {}, { simulation: { tStop: 0.03 } });
  expect("V_PULSE 方形波 2周期目 v(21ms)=3.161V（simulation.tStop 指定）", rs2.ok, rs2.message);
}
{
  // RL: 10V, R=100Ω, L=10mH → τ=0.1ms, i(τ) = 0.1(1−e⁻¹) = 63.21mA, v_L(τ) = 10e⁻¹ = 3.679V
  const b = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }),
    comp("R1", "R", ["vin", "x"], { R: 100 }),
    comp("L1", "L", ["x", "gnd"], { L: 0.01 }),
    comp("TP1", "TP", ["x"])
  );
  const sim = await simulate(b, { mode: "transient" });
  near("過渡 RL τ=L/R=0.1ms", sim.transient.timeConstant, 1e-4, 1e-6);
  const ri = await check(b, "transient", { type: "transientPoint", element: "L1", quantity: "i", timeSec: 1e-4, expected: 0.1 * (1 - Math.exp(-1)), tolerancePct: 0.5 });
  expect("transientPoint L1 電流 i(τ)=63.21mA", ri.ok, ri.message);
  const rv = await check(b, "transient", { type: "transientPoint", node: "x", timeSec: 1e-4, expected: 10 * Math.exp(-1), tolerancePct: 0.5 });
  expect("transientPoint v_L(τ)=3.679V", rv.ok, rv.message);
  near("過渡 RL t=0+ で v_L = 10V（L 電流は連続）", sim.transient.nodes.x[0], 10, 1e-4);
  const rt = await check(b, "transient", { type: "timeConstant", node: "x", expected: 1e-4, tolerancePct: 0.5 });
  expect("timeConstant node 法（RL の v_L は減衰）", rt.ok, rt.message);
}
{
  // 直列 RLC（ステップ）: L=10mH, C=1µF, R=20Ω。ω0=1e4, α=R/2L=1000, fd=√(ω0²−α²)/2π=1583.6Hz
  const fd = Math.sqrt(1e8 - 1e6) / (2 * Math.PI);
  const b = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 1 }),
    comp("R1", "R", ["vin", "a"], { R: 20 }),
    comp("L1", "L", ["a", "out"], { L: 0.01 }),
    comp("C1", "C", ["out", "gnd"], { C: 1e-6 })
  );
  const r = await check(b, "transient", { type: "oscillationFrequency", node: "out", expected: fd, tolerancePct: 0.5 });
  expect("oscillationFrequency 直列RLC fd=1583.6Hz", r.ok, r.message);
  // 最初のピーク: v = 1 − e^{−αt}(cos ωd t + α/ωd sin ωd t)、t_peak = π/ωd → 1 + e^{−απ/ωd}
  const wd = 2 * Math.PI * fd;
  const peak = 1 + Math.exp((-1000 * Math.PI) / wd);
  const rp = await check(b, "transient", { type: "transientPoint", node: "out", timeSec: Math.PI / wd, expected: peak, tolerancePct: 0.5 });
  expect("transientPoint 直列RLC 最初のピーク 1.729V（台形則で人工減衰なし）", rp.ok, rp.message);

  // 並列 RLC（I_DC ステップ）: R=1k, L=10mH, C=1µF。α=1/(2RC)=500 → fd=√(1e8−2.5e5)/2π=1589.6Hz
  // （旧実装の理論式 α=R/2L では 5e4 となり「過減衰」と誤判定していた）
  const fdp = Math.sqrt(1e8 - 2.5e5) / (2 * Math.PI);
  const bp = board(
    comp("I1", "I_DC", ["out", "gnd"], { I: 0.001 }),
    comp("R1", "R", ["out", "gnd"], { R: 1000 }),
    comp("L1", "L", ["out", "gnd"], { L: 0.01 }),
    comp("C1", "C", ["out", "gnd"], { C: 1e-6 })
  );
  const rpp = await check(bp, "transient", { type: "oscillationFrequency", node: "out", expected: fdp, tolerancePct: 0.5 });
  expect("oscillationFrequency 並列RLC fd=1589.6Hz", rpp.ok, rpp.message);
}

/* ---------------------------------------------------------------- AC */
{
  // RC ローパス: R=1k, C=1/(2π·1k·1k)=159.15nF → fc=1kHz。電源 1Vrms(Vpk=√2) 1kHz
  const C = 1 / (2 * Math.PI * 1000 * 1000);
  const b = board(
    comp("V1", "V_AC", ["vin", "gnd"], { Vpk: Math.SQRT2, freqHz: 1000 }),
    comp("R1", "R", ["vin", "out"], { R: 1000 }),
    comp("C1", "C", ["out", "gnd"], { C }),
    comp("TP1", "TP", ["out"])
  );
  const av = await check(b, "ac", { type: "acVoltage", node: "out", frequencyHz: 1000, expectedRMS: Math.SQRT1_2, tolerancePct: 0.01 });
  expect("acVoltage fc で 0.7071Vrms", av.ok, av.message);
  const g = await check(b, "ac", { type: "acGaindB", input: "vin", output: "out", frequencyHz: 1000, expected: -10 * Math.log10(2), toleranceAbs: 0.01 });
  expect("acGaindB fc で −3.0103dB", g.ok, g.message);
  const bp = await check(b, "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 1000, gainDB: -3.0103, phaseDeg: -45, gainToleranceDB: 0.01, phaseToleranceDeg: 0.01 });
  expect("bodePoint fc で −3.01dB / −45°", bp.ok, bp.message);
  // 電源周波数（1kHz）と違う 10kHz も checks から自動で解析: |H| = 1/√101 → −20.043dB, ∠ = −atan(10) = −84.29°
  const bp10 = await check(b, "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 10000, gainDB: -10 * Math.log10(101), phaseDeg: -Math.atan(10) * 180 / Math.PI, gainToleranceDB: 0.01, phaseToleranceDeg: 0.01 });
  expect("bodePoint 10kHz（電源と別の周波数）", bp10.ok, bp10.message);
  const bpWrong = await check(b, "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 1000, phaseDeg: 45, phaseToleranceDeg: 1 });
  expect("bodePoint 位相の符号違いは不合格", !bpWrong.ok);

  // 直列 RLC 共振: L=10mH, C=1µF, R=10Ω, f0 = 1/(2π√LC) = 1591.55Hz。R の両端 = 入力 → 0dB
  const f0 = 1 / (2 * Math.PI * Math.sqrt(0.01 * 1e-6));
  const r = board(
    comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: f0 }),
    comp("L1", "L", ["vin", "a"], { L: 0.01 }),
    comp("C1", "C", ["a", "out"], { C: 1e-6 }),
    comp("R1", "R", ["out", "gnd"], { R: 10 }),
    comp("TP1", "TP", ["out"])
  );
  const g0 = await check(r, "ac", { type: "acGaindB", input: "vin", output: "out", frequencyHz: f0, expected: 0, toleranceAbs: 0.01 });
  expect("acGaindB 直列共振で 0dB（toleranceAbs）", g0.ok, g0.message);
  const g0rel = await check(r, "ac", { type: "acGaindB", input: "vin", output: "out", frequencyHz: f0 * 1.2, expected: 0, toleranceAbs: 0.5 });
  expect("acGaindB 共振から外れると不合格", !g0rel.ok);
  // Q = (1/R)√(L/C) = 10 → C の両端電圧は 10 倍（20dB）
  const vc = await check(r, "ac", { type: "acVoltage", node: "a", frequencyHz: f0, expectedRMS: 0, toleranceAbs: 100 });
  expect("acVoltage 取得（共振時ノード a）", vc.ok);
}

/* ---------------------------------------------------------------- 未配線ピン / TP だけのネット / 浮いた回路 */
{
  // TP だけがつながったネット "lonely" があっても DC は解ける（以前は浮遊ノードで全体が失敗）
  const b = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }),
    comp("R1", "R", ["vin", "out"], { R: 1000 }),
    comp("R2", "R", ["out", "gnd"], { R: 1000 }),
    comp("TP1", "TP", ["out"]),
    comp("TP2", "TP", ["lonely"])
  );
  const sim = await simulate(b, { mode: "dc" });
  expect("TP だけのネットがあっても DC は成功", sim.ok, JSON.stringify(sim.errors));
  near("TP だけのネットがあっても Vout=5V", sim.dc.nodes.out, 5, 1e-6);
  const r = await check(b, "dc", { type: "dcVoltage", node: "lonely", expected: 0, toleranceAbs: 1 });
  expect("未接続ネットを参照した dcVoltage は「未接続」で不合格", !r.ok && /未接続/.test(r.message), r.message);
  for (const mode of ["ac", "transient"]) {
    const bb = board(
      comp("V1", mode === "ac" ? "V_AC" : "V_DC", ["vin", "gnd"], mode === "ac" ? { Vpk: 1, freqHz: 1000 } : { V: 1 }),
      comp("R1", "R", ["vin", "out"], { R: 1000 }),
      comp("C1", "C", ["out", "gnd"], { C: 1e-6 }),
      comp("TP2", "TP", ["lonely"])
    );
    const s2 = await simulate(bb, { mode });
    expect(`TP だけのネットがあっても ${mode} は成功`, s2.ok, JSON.stringify(s2.errors));
  }
  // 片側だけ配線した抵抗（UI では未配線ピンが ""）: R2 の下側が未接続なら電流ゼロで Vout=10V
  // （以前は "" がグラウンド扱いになり、5V になって分圧問題に合格してしまっていた）
  const half = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }),
    comp("R1", "R", ["vin", "out"], { R: 1000 }),
    comp("R2", "R", ["out", ""], { R: 1000 }),
    comp("TP1", "TP", ["out"])
  );
  const hs = await simulate(half, { mode: "dc" });
  near("未配線ピンはグラウンドではない（Vout=10V）", hs.dc.nodes.out, 10, 1e-6);
  const hsT = await simulate({ ...half, components: [...half.components, comp("C1", "C", ["out", ""], { C: 1e-6 })] }, { mode: "transient" });
  expect("未配線ピンがあっても過渡は成功", hsT.ok, JSON.stringify(hsT.errors));
  // グラウンドにつながらない回路: 判定は「グラウンドにつながっていません」で不合格
  const fl = board(
    comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }),
    comp("R1", "R", ["vin", "gnd"], { R: 1000 }),
    comp("V2", "V_DC", ["a", "b"], { V: 5 }),
    comp("R2", "R", ["a", "b"], { R: 1000 }),
    comp("TP1", "TP", ["a"])
  );
  const fs1 = await simulate(fl, { mode: "dc" });
  expect("浮いた部分回路があっても DC は成功", fs1.ok, JSON.stringify(fs1.errors));
  near("浮いた部分回路の部品電流は求まる I(R2)=5mA", Math.abs(fs1.dc.elements.R2.i), 0.005, 1e-4);
  const rf = await check(fl, "dc", { type: "dcVoltage", node: "a", expected: 5, tolerancePct: 1 });
  expect("浮いたネットの dcVoltage は「グラウンドにつながっていません」で不合格", !rf.ok && /グラウンド/.test(rf.message), rf.message);
}

/* ---------------------------------------------------------------- judge 配列 / simulation 設定 */
{
  const p = {
    judge: ["dc", "transient"],
    simulation: { tStop: 0.02 },
    checks: [
      { type: "dcVoltage", node: "out", expected: 5, tolerancePct: 0.1 },
      { type: "timeConstant", node: "out", expected: 1e-3, tolerancePct: 0.5 },
    ],
  };
  const b = RC();
  const sim = await simulate(b, { mode: p.judge, checks: p.checks, problem: p });
  const res = await runChecks(p, sim, b, {});
  expect("judge 配列 [dc, transient] で DC と過渡の判定を併用", res.every((r) => r.ok), JSON.stringify(res.map((r) => r.message)));
  near("simulation.tStop が反映される", sim.transient.tStop, 0.02, 1e-9);
  // app.js と同じく state 全体（currentProblem を含む）を渡した場合も simulation を読む
  const sim2 = await simulate({ board: b, currentProblem: p }, { mode: "transient" });
  near("state.currentProblem.simulation も反映される", sim2.transient.tStop, 0.02, 1e-9);
}

/* ---------------------------------------------------------------- validation */
{
  const base = {
    id: "T-01", category: "T", title: "t", statement: "s",
    hints: ["方針", "式", "ほぼ答え"],
    explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" },
    fixedComponents: [{ id: "V1", type: "V_DC", params: { V: 5 }, connect: ["vin", "gnd"] }, { id: "TP1", type: "TP", connect: ["out"] }],
    referenceSolution: [{ id: "D1", type: "D", params: { Vf: 0.7 }, connect: ["vin", "out"] }],
    questions: [{ key: "q1", kind: "numeric", prompt: "電流は？", unit: "A" }, { key: "q2", kind: "choice", prompt: "どれ？", options: ["a", "b", "c"] }],
    referenceAnswers: { q1: 0.01, q2: 2 },
    checks: [
      { type: "connection", element: "D1", pins: { anode: "vin", cathode: "out" } },
      { type: "numericAnswer", key: "q1", expected: 0.01 },
      { type: "multipleChoice", key: "q2", answerIndex: 2 },
    ],
  };
  const v = (patch) => validateProblem({ ...base, ...patch }, vopts);
  const okRes = v({});
  expect("validation: 正しい問題はエラーなし・警告なし", okRes.ok && okRes.warnings.length === 0, JSON.stringify(okRes));
  expect("validation: hints が2つならエラー", !v({ hints: ["a", "b"] }).ok);
  expect("validation: hints 無しは警告のみ", (() => { const r = v({ hints: undefined }); return r.ok && r.warnings.length === 1; })());
  expect("validation: explanation の項目欠けはエラー", !v({ explanation: { solution: "a" } }).ok);
  expect("validation: explanation 無しは警告のみ", v({ explanation: undefined }).ok);
  expect("validation: questions に無い key はエラー", !v({ checks: [{ type: "numericAnswer", key: "q9", expected: 1 }] }).ok);
  expect("validation: answerIndex が範囲外はエラー", !v({ checks: [{ type: "multipleChoice", key: "q2", answerIndex: 3 }] }).ok);
  expect("validation: kind 違いはエラー", !v({ checks: [{ type: "numericAnswer", key: "q2", expected: 1 }] }).ok);
  expect("validation: referenceAnswers 欠けはエラー", !v({ referenceAnswers: { q1: 0.01 } }).ok);
  expect("validation: connect のピン数違いはエラー", !v({ referenceSolution: [{ id: "D1", type: "D", connect: ["vin"] }] }).ok);
  expect("validation: pins のピン名違いはエラー", !v({ checks: [{ type: "connection", element: "D1", pins: { gate: "vin" } }] }).ok);
  expect("validation: connection に pins も nets も無いとエラー", !v({ checks: [{ type: "connection", element: "D1" }] }).ok);
  expect("validation: transientPoint に timeSec 無しはエラー", !v({ checks: [{ type: "transientPoint", node: "out", expected: 1 }] }).ok);
  expect("validation: 極性部品の nets 形式は警告", v({ checks: [{ type: "connection", element: "D1", nets: ["vin", "out"] }] }).warnings.some((w) => /極性/.test(w)));
  expect("validation: 判定ノードに固定部品が無いと警告", v({ checks: [{ type: "dcVoltage", node: "mid", expected: 1 }] }).warnings.some((w) => /固定部品/.test(w)));
  expect("validation: judge 配列は可", v({ judge: ["dc", "transient"] }).ok);
  expect("validation: 未知の judge はエラー", !v({ judge: "rf2" }).ok);
  expect("validation: simulation.tStop が負ならエラー", !v({ simulation: { tStop: -1 } }).ok);
  expect("validation: match は element の代わりになる", v({ checks: [{ type: "dcCurrent", match: { type: "R", nets: ["vin", "out"] }, expected: 1 }] }).ok);
  expect("validation: element も match も無い dcCurrent はエラー", !v({ checks: [{ type: "dcCurrent", expected: 1 }] }).ok);
  expect("validation: match.pins のピン名違いはエラー", !v({ checks: [{ type: "connection", match: { type: "D" }, pins: { anode: "vin" } }, { type: "componentValue", match: { type: "D", pins: { gate: "x" } }, expected: 1 }] }).ok);
  expect("validation: 未知の match.type はエラー", !v({ checks: [{ type: "componentValue", match: { type: "XYZ" }, expected: 1 }] }).ok);
}

/* ---------------------------------------------------------------- verify.mjs --drop / --mutate / --reverse / 回答 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
  const cat = path.join(dir, "T");
  fs.mkdirSync(cat);
  const common = {
    category: "T", title: "t", statement: "s", judge: "dc",
    hints: ["a", "b", "c"], explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" },
  };
  // T-01: 甘い問題。R2 は判定に影響しない（out は R1 だけで決まる）→ --drop で R2 を外しても合格
  const lax = {
    ...common, id: "T-01",
    fixedComponents: [{ id: "V1", type: "V_DC", params: { V: 10 }, connect: ["vin", "gnd"], locked: true }, { id: "TP1", type: "TP", connect: ["out"], locked: true }],
    referenceSolution: [
      { id: "R1", type: "R", params: { R: 1000 }, connect: ["vin", "out"] },
      { id: "R3", type: "R", params: { R: 1000 }, connect: ["out", "gnd"] },
      { id: "R2", type: "R", params: { R: 1000 }, connect: ["vin", "gnd"] },
    ],
    checks: [{ type: "dcVoltage", node: "out", expected: 5, tolerancePct: 1 }],
  };
  // T-02: 厳しい問題（分圧＋電流）。部品を外すと必ず不合格。ダイオードは pins で向きを判定
  const strictP = {
    ...common, id: "T-02",
    fixedComponents: [{ id: "V1", type: "V_DC", params: { V: 10 }, connect: ["vin", "gnd"], locked: true }, { id: "TP1", type: "TP", connect: ["out"], locked: true }],
    referenceSolution: [
      { id: "D1", type: "D", params: { Vf: 0.7 }, connect: ["vin", "a"] },
      { id: "R1", type: "R", params: { R: 930 }, connect: ["a", "out"] },
      { id: "R2", type: "R", params: { R: 1000 }, connect: ["out", "gnd"] },
    ],
    checks: [
      { type: "dcVoltage", node: "out", expected: 4.81865, tolerancePct: 1 },
      { type: "dcCurrent", element: "R2", expected: 0.00481865, tolerancePct: 1 },
      { type: "connection", element: "D1", pins: { anode: "vin", cathode: "a" } },
    ],
  };
  // T-03: 回答だけの問題（数値＋選択）
  const answerP = {
    ...common, id: "T-03",
    questions: [{ key: "q1", kind: "numeric", prompt: "?", unit: "A" }, { key: "q2", kind: "choice", prompt: "?", options: ["x", "y"] }],
    referenceAnswers: { q1: 0.0125, q2: 1 },
    checks: [{ type: "numericAnswer", key: "q1", expected: 0.0125, tolerancePct: 2 }, { type: "multipleChoice", key: "q2", answerIndex: 1 }],
  };
  // T-04: T-01 と同じ甘さだが verifyNote あり → 警告扱いで終了コード 0
  const noted = { ...lax, id: "T-04", verifyNote: "テスト用: R2 は電源の負荷で判定に影響しない" };
  for (const p of [lax, strictP, answerP, noted]) fs.writeFileSync(path.join(cat, `${p.id}.json`), JSON.stringify(p));
  fs.writeFileSync(path.join(cat, "index.json"), JSON.stringify({ problems: ["T-01", "T-02", "T-03", "T-04"].map((id) => ({ id, title: "t" })) }));

  const runVerify = (...a) => {
    try {
      return { code: 0, out: execFileSync("node", [path.join(ROOT, "tools/verify.mjs"), `--problems=${dir}`, ...a], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  // D1 の 0.7V: (10−0.7)/(930+1000+1Ω内部)… 内部直列 1Ω を含めると I = 9.3/1931 = 4.8162mA → 1% 以内
  const ref = runVerify();
  expect("verify ref: 4問とも合格・終了コード0", ref.code === 0 && /参照解が合格 4 問/.test(ref.out), ref.out);
  const drop = runVerify("--drop");
  expect("verify --drop: T-01 を「R2 を外しても合格」と報告", /T-01（R2 を外しても合格）/.test(drop.out), drop.out);
  expect("verify --drop: T-02 は報告しない", !/T-02/.test(drop.out), drop.out);
  expect("verify --drop: T-04（verifyNote あり）は警告", /警告 甘い判定の可能性: T-04/.test(drop.out), drop.out);
  expect("verify --drop: 終了コード1（T-01 があるため）", drop.code === 1);
  const dropOnly2 = runVerify("--drop", "T-02");
  expect("verify --drop T-02: 終了コード0", dropOnly2.code === 0, dropOnly2.out);
  const dropOnly4 = runVerify("--drop", "T-04");
  expect("verify --drop T-04: verifyNote ありは終了コード0", dropOnly4.code === 0, dropOnly4.out);
  const mut = runVerify("--mutate", "T-0");
  expect("verify --mutate: T-03 の回答誤答は不合格（報告しない）", !/T-03/.test(mut.out), mut.out);
  expect("verify --mutate: T-02 は報告しない", !/T-02/.test(mut.out), mut.out);
  const rev = runVerify("--reverse", "T-02");
  expect("verify --reverse: D1 逆向きは不合格（報告しない）", rev.code === 0 && /誤答がすべて不合格 1 問/.test(rev.out), rev.out);
  // index.json の不一致
  fs.writeFileSync(path.join(cat, "index.json"), JSON.stringify({ problems: [{ id: "T-01" }, { id: "T-09" }] }));
  const idx = runVerify();
  expect("verify: index.json に無いファイル・ファイルの無い index 項目を NG", idx.code === 1 && /T-09/.test(idx.out) && /T-02\.json が index\.json に載っていません/.test(idx.out), idx.out);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`[test_checks] 合格 ${passed} / 失敗 ${failures.length}`);
for (const f of failures) console.log("FAIL", f);
process.exitCode = failures.length ? 1 : 0;
