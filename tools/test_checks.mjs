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
const { runChecks, runSingleCheck, measureWaveform } = await imp("src/checks/runner.js");
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

/* ---------------------------------------------------------------- 分野C: 増幅回路（BJT / MOSFET / JFET / OPAMP / 差動） */
// 許容誤差の根拠（このブロック）:
// - DC 動作点: 区分線形モデルを直接解くので、手計算との差は「C の DC 漏れ 1e-3·C [S]」
//   （1mF で 1MΩ。RE=470Ω と並列で 0.05%）とゲートの 1nS リンクだけ → IC/ID は 0.2% で比較。
// - AC 小信号: 複素 MNA を直接解く。結合・バイパスコンデンサのリアクタンスは試験周波数で
//   相手のインピーダンスの 0.1% 未満になるように選んだ（例: CE=1mF は 100kHz で 1.6mΩ ≪ re≈10Ω）。
//   さらに上の DC 誤差 0.2% が gm に入る → 利得は ±0.05dB（0.6%）、位相 ±0.5° で比較。
//   オペアンプ（抵抗だけで決まる回路）は有限 Aol まで含めた厳密式と比べるので ±0.001dB / 0.01%。
// - 過渡: 刻み T/100。正弦波の最大値をサンプル点で拾う誤差は 1−cos(π/100) ≈ 5e-4、
//   積分器の傾き（台形則）は区間内で厳密 → 0.5〜1% で比較。
const VT = 0.026; // src/sim/dc.js の VT_THERMAL（熱電圧 26mV）
const par = (...rs) => 1 / rs.reduce((s, r) => s + 1 / r, 0);
const db = (x) => 20 * Math.log10(Math.abs(x));
{
  // --- BJT 電圧帰還（分圧）バイアスの共通エミッタ増幅 ---
  // VCC=12, R1=47k, R2=10k, RC=2.2k, RE=470, β=100, VBE=0.7, RL=10k
  // テブナン: VTH = 12·10/57 = 2.1053V, RTH = 8.2456kΩ
  // IB = (VTH − 0.7)/(RTH + 10Ω（モデルのベース抵抗） + (β+1)RE), IC = β·IB ≈ 2.5218mA
  const beta = 100, VCC = 12, R1 = 47e3, R2 = 10e3, RC = 2200, RE = 470, RL = 10e3;
  const VTH = (VCC * R2) / (R1 + R2), RTH = par(R1, R2);
  const IC = (beta * (VTH - 0.7)) / (RTH + 10 + (beta + 1) * RE);
  const gm = IC / VT, rpi = beta / gm;
  const f = 1e5;
  const ce = ({ bypass = true, rs = 0, r2 = R2, type = "Q_NPN" } = {}) => board(
    comp("V1", "V_AC", [rs ? "src" : "vin", "gnd"], { Vpk: 0.01, freqHz: f }),
    ...(rs ? [comp("RS", "R", ["src", "vin"], { R: rs })] : []),
    comp("VCC", "V_DC", ["vcc", "gnd"], { V: VCC }),
    comp("C1", "C", ["vin", "b"], { C: 10e-6 }),
    comp("R1", "R", ["vcc", "b"], { R: R1 }), comp("R2", "R", ["b", "gnd"], { R: r2 }),
    comp("RC", "R", ["vcc", "c"], { R: RC }), comp("RE", "R", ["e", "gnd"], { R: RE }),
    ...(bypass ? [comp("CE", "C", ["e", "gnd"], { C: 1e-3 })] : []),
    comp("Q1", type, ["c", "b", "e"], { beta }),
    comp("C2", "C", ["c", "out"], { C: 10e-6 }), comp("RL", "R", ["out", "gnd"], { R: RL }),
    comp("TP1", "TP", ["out"])
  );
  const dcSim = await simulate(ce(), { mode: "dc" });
  near("BJT 分圧バイアス IC = 2.5218mA（手計算）", dcSim.dc.operatingPoints.Q1.ic, IC, 2e-3);
  near("BJT 分圧バイアス VCE = VCC − IC·RC − IE·RE", dcSim.dc.operatingPoints.Q1.vce, VCC - IC * RC - (IC * (beta + 1) / beta) * RE, 2e-3);
  const reg = await check(ce(), "dc", { type: "operatingRegion", match: { type: "Q_NPN" }, region: "active" });
  expect("operatingRegion: 分圧バイアスの Q1 は活性領域", reg.ok, reg.message);
  const regAc = await check(ce(), "ac", { type: "operatingRegion", element: "Q1", region: ["active"] });
  expect("operatingRegion: judge ac でも動作点を参照できる", regAc.ok, regAc.message);
  // R2 を 100k にするとベース電圧が上がりすぎて飽和（VCE ≈ 0.2V）
  const regSat = await check(ce({ r2: 100e3 }), "dc", { type: "operatingRegion", element: "Q1", region: "active" });
  expect("operatingRegion: バイアス過大で飽和 → active 判定は不合格", !regSat.ok && /飽和/.test(regSat.message), regSat.message);

  const AvByp = -gm * par(RC, RL);
  const bp = await check(ce(), "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: f, gainDB: db(AvByp), phaseDeg: 180, gainToleranceDB: 0.05, phaseToleranceDeg: 0.5 });
  expect(`CE（バイパスあり）Av = −gm(RC∥RL) = ${AvByp.toFixed(2)}（gm=IC/26mV）`, bp.ok, bp.message);
  const AvRE = (-beta * par(RC, RL)) / (rpi + (beta + 1) * RE);
  const g2 = await check(ce({ bypass: false }), "ac", { type: "acGaindB", input: "vin", output: "out", frequencyHz: f, expected: db(AvRE), toleranceAbs: 0.05 });
  expect(`CE（RE バイパスなし）Av = −β(RC∥RL)/(rπ+(β+1)RE) = ${AvRE.toFixed(3)}`, g2.ok, g2.message);
  const gPnp = await check(
    board(
      comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 0.01, freqHz: f }),
      comp("VCC", "V_DC", ["vcc", "gnd"], { V: VCC }),
      comp("C1", "C", ["vin", "b"], { C: 10e-6 }),
      comp("R1", "R", ["b", "gnd"], { R: R1 }), comp("R2", "R", ["vcc", "b"], { R: R2 }),
      comp("RC", "R", ["c", "gnd"], { R: RC }), comp("RE", "R", ["vcc", "e"], { R: RE }), comp("CE", "C", ["vcc", "e"], { C: 1e-3 }),
      comp("Q1", "Q_PNP", ["c", "b", "e"], { beta }),
      comp("C2", "C", ["c", "out"], { C: 10e-6 }), comp("RL", "R", ["out", "gnd"], { R: RL })
    ),
    "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: f, gainDB: db(AvByp), phaseDeg: 180, gainToleranceDB: 0.05, phaseToleranceDeg: 0.5 }
  );
  expect("PNP の CE（上下反転）も同じ利得・反転", gPnp.ok, gPnp.message);
  const gSat = await check(ce({ r2: 100e3 }), "ac", { type: "acGaindB", input: "vin", output: "out", frequencyHz: f, expected: db(AvByp), toleranceAbs: 1 });
  expect("飽和したトランジスタは増幅しない（利得判定が不合格）", !gSat.ok, gSat.message);

  // 入出力インピーダンス（RS=1k の信号源。入力は信号源 V1 を外して base から見る）
  const zin = await check(ce({ rs: 1000 }), "ac", { type: "acImpedance", node: "b", exclude: ["V1"], frequencyHz: f, expected: par(R1, R2, rpi), tolerancePct: 0.5 });
  expect(`acImpedance 入力 Zin = R1∥R2∥rπ = ${par(R1, R2, rpi).toFixed(1)}Ω`, zin.ok, zin.message);
  const zinRE = await check(ce({ rs: 1000, bypass: false }), "ac", { type: "acImpedance", node: "b", exclude: ["V1"], frequencyHz: f, expected: par(R1, R2, rpi + (beta + 1) * RE), tolerancePct: 0.5 });
  expect("acImpedance 入力（RE あり）Zin = R1∥R2∥(rπ+(β+1)RE)", zinRE.ok, zinRE.message);
  const zout = await check(ce({ rs: 1000 }), "ac", { type: "acImpedance", node: "out", exclude: ["RL"], frequencyHz: f, expected: RC, tolerancePct: 0.1 });
  expect("acImpedance 出力 Zout = RC（ro=∞、負荷 RL を外す）", zout.ok, zout.message);
  const zoutL = await check(ce({ rs: 1000 }), "ac", { type: "acImpedance", node: "out", frequencyHz: f, expected: par(RC, RL), tolerancePct: 0.1 });
  expect("acImpedance 出力（負荷込み）= RC∥RL", zoutL.ok, zoutL.message);
  const zNone = await check(ce(), "ac", { type: "acImpedance", node: "nowhere", frequencyHz: f, expected: 1 });
  expect("acImpedance: 回路に無いノードは不合格", !zNone.ok);
  // 信号源抵抗込みの利得: vout/vsrc = Av·Zin/(RS+Zin)
  const zinV = par(R1, R2, rpi);
  const gRs = await check(ce({ rs: 1000 }), "ac", { type: "acGaindB", input: "src", output: "out", frequencyHz: f, expected: db((AvByp * zinV) / (1000 + zinV)), toleranceAbs: 0.05 });
  expect("信号源抵抗 RS=1k による入力側の分圧 vout/vs = Av·Zin/(RS+Zin)", gRs.ok, gRs.message);

  // 過渡（DC 動作点から開始）: BJT は VBE 一定モデルなので re が入らない
  //   → RE バイパスなしの利得は −(RC∥RL)/(RE + (RTH∥…)/β) に近く、AC（rπ 入り）より約 2% 大きい
  const trSim = await simulate(ce({ bypass: false }), { mode: "transient", problem: { simulation: { initialCondition: "dc", tStop: 5e-5 } } });
  expect("過渡: BJT を含む回路が解ける（initialCondition dc）", trSim.ok && trSim.warnings.length === 0, JSON.stringify(trSim.warnings));
  near("過渡: t=0 で結合コンデンサ C2 は DC 動作点の電圧（VC）", trSim.transient.elements.C2.v[0], VCC - IC * RC, 2e-3);
  const ppTr = await check(ce({ bypass: false }), "transient", { type: "transientMeasure", node: "out", measure: "pp", fromSec: 2e-5, toSec: 5e-5, expected: 2 * 0.01 * Math.abs(AvRE), tolerancePct: 5 }, {}, { simulation: { initialCondition: "dc", tStop: 5e-5 } });
  expect("過渡: CE（RE あり）の出力振幅は AC の利得と 5% 以内（VBE 一定モデルの差 約2%）", ppTr.ok, ppTr.message);
}
{
  // --- MOSFET ソース接地（平方則 ID = ½K(VGS−Vth)²）---
  // VDD=10, R1=R2=1M → VG=5, RS=1k（CS=1mF でバイパス）, K=1mA/V², Vth=2
  // Vov = VGS−Vth = 3 − 1000·½K·Vov² → ½Vov² + Vov − 3 = 0 → Vov = −1+√7 = 1.6458V
  // ID = ½K·Vov² = 1.3542mA, gm = K·Vov = √(2K·ID) = 1.6458mS
  const K = 1e-3, Vth = 2, RD = 3300, RL = 10e3;
  const vov = -1 + Math.sqrt(7), ID = 0.5 * K * vov * vov, gm = K * vov;
  const f = 1e4;
  const cs = board(
    comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 0.01, freqHz: f }), comp("VDD", "V_DC", ["vdd", "gnd"], { V: 10 }),
    comp("C1", "C", ["vin", "g"], { C: 1e-6 }), comp("R1", "R", ["vdd", "g"], { R: 1e6 }), comp("R2", "R", ["g", "gnd"], { R: 1e6 }),
    comp("RD", "R", ["vdd", "d"], { R: RD }), comp("RS", "R", ["s", "gnd"], { R: 1000 }), comp("CS", "C", ["s", "gnd"], { C: 1e-3 }),
    comp("M1", "M_N", ["d", "g", "s"], { Vth, K }), comp("C2", "C", ["d", "out"], { C: 10e-6 }), comp("RL", "R", ["out", "gnd"], { R: RL }),
    comp("TP1", "TP", ["out"])
  );
  const sim = await simulate(cs, { mode: "ac", checks: [] });
  near("MOSFET 自己バイアス ID = 1.3542mA（2次方程式の解）", sim.ac.operatingPoints.M1.id, ID, 3e-3);
  near("MOSFET gm = K·Vov = √(2K·ID)", sim.ac.operatingPoints.M1.gm, Math.sqrt(2 * K * ID), 3e-3);
  expect("MOSFET の動作領域は saturation（増幅に使う領域）", (await check(cs, "dc", { type: "operatingRegion", element: "M1", region: "saturation" })).ok);
  const Av = -gm * par(RD, RL);
  const bp = await check(cs, "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: f, gainDB: db(Av), phaseDeg: 180, gainToleranceDB: 0.05, phaseToleranceDeg: 0.5 });
  expect(`MOSFET ソース接地 Av = −gm(RD∥RL) = ${Av.toFixed(3)}`, bp.ok, bp.message);
  // 過渡: 平方則は AC モデルと同じ式なので波形の振幅も一致（2乗の項は pp では打ち消し合う）
  const pp = await check(cs, "transient", { type: "transientMeasure", node: "out", measure: "pp", fromSec: 2e-4, toSec: 5e-4, expected: 2 * 0.01 * Math.abs(Av), tolerancePct: 1 }, {}, { simulation: { initialCondition: "dc", tStop: 5e-4 } });
  expect("過渡: MOSFET 増幅の出力 pp = 2·Vpk·|Av|（±1%）", pp.ok, pp.message);
  const avg = await check(cs, "transient", { type: "transientMeasure", node: "out", measure: "average", fromSec: 2e-4, toSec: 5e-4, expected: 0, toleranceAbs: 2e-3 }, {}, { simulation: { initialCondition: "dc", tStop: 5e-4 } });
  expect("過渡: 結合コンデンサ後の出力の平均は 0V（DC 動作点から開始）", avg.ok, avg.message);

  // --- JFET ソース接地: IDSS=10mA, VGS(off)=−2V, 自己バイアス RS=100Ω（バイパス）, RD=1k
  // ID = IDSS(1+ID·RS/2)²… を数値で解いた動作点の gm = −2IDSS/VGS(off)·(1−VGS/VGS(off)) で Av = −gm·RD
  const jf = board(
    comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 0.01, freqHz: f }), comp("VDD", "V_DC", ["vdd", "gnd"], { V: 15 }),
    comp("C1", "C", ["vin", "g"], { C: 1e-6 }), comp("RG", "R", ["g", "gnd"], { R: 1e6 }),
    comp("RD", "R", ["vdd", "d"], { R: 1000 }), comp("RS", "R", ["s", "gnd"], { R: 100 }), comp("CS", "C", ["s", "gnd"], { C: 1e-3 }),
    comp("J1", "J_N", ["d", "g", "s"], { Idss: 0.01, VgsOff: -2 }), comp("TP1", "TP", ["d"])
  );
  // 手計算: VGS = −ID·RS = −100·ID, ID = IDSS(1 − VGS/VGS(off))² = 0.01(1 − 50·ID)²
  //   → 25·ID² − 2·ID + 0.01 = 0 → ID = (2 − √3)/50 = 5.359mA（もう一方の解は VGS < VGS(off) で不適）
  //   gm = 2·IDSS/|VGS(off)|·(1 − VGS/VGS(off)) = 0.01·(1 − 50·ID) = 7.32mS
  const a = 25, b = -2, c = 0.01;
  const IDj = (-b - Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  const gmj = (2 * 0.01 / 2) * (1 - (IDj * 100) / 2);
  const gj = await check(jf, "ac", { type: "acGaindB", input: "vin", output: "d", frequencyHz: f, expected: db(gmj * 1000), toleranceAbs: 0.05 });
  expect(`JFET ソース接地 Av = −gm·RD（ID=${(IDj * 1e3).toFixed(3)}mA）`, gj.ok, gj.message);
}
{
  // --- オペアンプ（Aol=1e5 の有限利得まで含めた厳密式と比較）---
  const Aol = 1e5;
  const opamp = (id, inP, inM, out, params = {}, vp = "", vm = "") => comp(id, "OPAMP", [inP, inM, out, vp, vm], { Aol, ...params });
  const exactInv = (Rf, Rin) => -(Rf / Rin) / (1 + (1 + Rf / Rin) / Aol);
  const exactNon = (G) => G / (1 + G / Aol);
  const dcOut = async (b) => (await simulate(b, { mode: "dc" })).dc.nodes.out;
  // 反転増幅 −Rf/Rin
  const inv = (vin, params = {}, vp = "", vm = "") => board(comp("V1", "V_DC", ["vin", "gnd"], { V: vin }), comp("R1", "R", ["vin", "n"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "gnd", "n", "out", params, vp, vm), comp("TP1", "TP", ["out"]));
  near("OPAMP DC 反転増幅 0.5V × (−10)", await dcOut(inv(0.5)), 0.5 * exactInv(10000, 1000), 1e-4);
  // 非反転増幅 1+Rf/Rin = 11
  near("OPAMP DC 非反転増幅 0.5V × 11", await dcOut(board(comp("V1", "V_DC", ["vin", "gnd"], { V: 0.5 }), comp("R1", "R", ["n", "gnd"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "vin", "n", "out"))), 0.5 * exactNon(11), 1e-4);
  // ボルテージフォロワ
  near("OPAMP DC ボルテージフォロワ 3.3V", await dcOut(board(comp("V1", "V_DC", ["vin", "gnd"], { V: 3.3 }), opamp("U1", "vin", "out", "out"), comp("RL", "R", ["out", "gnd"], { R: 100 }))), 3.3 * exactNon(1), 1e-4);
  // 加算: −Rf(V1/R1 + V2/R2) = −10k(1/10k + 0.5/5k) = −2V
  near("OPAMP DC 加算 −Rf(V1/R1+V2/R2) = −2V", await dcOut(board(
    comp("V1", "V_DC", ["a", "gnd"], { V: 1 }), comp("V2", "V_DC", ["b", "gnd"], { V: 0.5 }),
    comp("R1", "R", ["a", "n"], { R: 10e3 }), comp("R2", "R", ["b", "n"], { R: 5e3 }), comp("RF", "R", ["n", "out"], { R: 10e3 }), opamp("U1", "gnd", "n", "out"))), -2, 1e-3);
  // 差動増幅（4抵抗）: (R2/R1)(Va − Vb) = 10·(1.2 − 1.0) = 2V
  near("OPAMP DC 差動増幅 (R2/R1)(Va−Vb) = 2V", await dcOut(board(
    comp("Va", "V_DC", ["a", "gnd"], { V: 1.2 }), comp("Vb", "V_DC", ["b", "gnd"], { V: 1.0 }),
    comp("R1", "R", ["b", "n"], { R: 10e3 }), comp("R2", "R", ["n", "out"], { R: 100e3 }), comp("R3", "R", ["a", "p"], { R: 10e3 }), comp("R4", "R", ["p", "gnd"], { R: 100e3 }), opamp("U1", "p", "n", "out"))), 2, 1e-3);
  // 飽和: 2V × (−10) = −20V → 電源 ±15V（Vpos/Vneg）で −15V
  near("OPAMP DC 飽和（Vneg=−15V で頭打ち）", await dcOut(inv(2)), -15, 1e-9);
  near("OPAMP DC 飽和（上側）", await dcOut(inv(-2, { Vpos: 12 })), 12, 1e-9);
  const sat = await check(inv(2), "dc", { type: "operatingRegion", element: "U1", region: "linear" });
  expect("operatingRegion: 飽和した OPAMP は linear 判定で不合格", !sat.ok && /satLow|下側/.test(sat.message), sat.message);
  // 電源ピンを配線: 単電源 +12V（v_minus = gnd）、Vdrop=1V → 出力範囲 1V〜11V
  const single = (vin) => board(comp("V1", "V_DC", ["vin", "gnd"], { V: vin }), comp("VP", "V_DC", ["vcc", "gnd"], { V: 12 }), comp("R1", "R", ["vin", "n"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "gnd", "n", "out", { Vdrop: 1 }, "vcc", "gnd"));
  near("OPAMP 電源ピン配線（単電源 12V, Vdrop 1V）: 負に振れず 1V で頭打ち", await dcOut(single(0.5)), 1, 1e-9);
  near("OPAMP 電源ピン配線: 上側は 12 − 1 = 11V", await dcOut(single(-2)), 11, 1e-9);
  // 電源を外すと（v_plus のネットが浮く → 0V）出力は出ない
  near("OPAMP 電源ピンの電源を外すと出力が出ない", await dcOut(board(comp("V1", "V_DC", ["vin", "gnd"], { V: -0.5 }), comp("R1", "R", ["vin", "n"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "gnd", "n", "out", {}, "vcc", "vee"))), 0, 0, 1e-6);

  // AC: GBP=1MHz の 1 次遅れ A(f) = Aol/(1 + j·f·Aol/GBP) の閉ループ厳密式と比較
  const acInv = (params) => board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: 1000 }), comp("R1", "R", ["vin", "n"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "gnd", "n", "out", params), comp("TP1", "TP", ["out"]));
  for (const fq of [100, 1e4, 1e5]) {
    const A = { re: Aol / (1 + (fq * Aol / 1e6) ** 2), im: -(fq * Aol * Aol / 1e6) / (1 + (fq * Aol / 1e6) ** 2) };
    // G = −10 / (1 + 11/A)
    const invA = { re: A.re / (A.re ** 2 + A.im ** 2), im: -A.im / (A.re ** 2 + A.im ** 2) };
    const den = { re: 1 + 11 * invA.re, im: 11 * invA.im };
    const G = { re: (-10 * den.re) / (den.re ** 2 + den.im ** 2), im: (10 * den.im) / (den.re ** 2 + den.im ** 2) };
    const r = await check(acInv({ GBP: 1e6 }), "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: fq, gainDB: db(Math.hypot(G.re, G.im)), phaseDeg: (Math.atan2(G.im, G.re) * 180) / Math.PI, gainToleranceDB: 0.001, phaseToleranceDeg: 0.01 });
    expect(`OPAMP AC 反転増幅 ×10, GBP=1MHz の ${fq}Hz（閉ループ帯域 ≈ GBP/11 = 91kHz）`, r.ok, r.message);
  }
  const ideal = await check(acInv({ GBP: 0 }), "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 1e5, gainDB: db(exactInv(10000, 1000)), phaseDeg: 180, gainToleranceDB: 0.001, phaseToleranceDeg: 0.01 });
  expect("OPAMP AC GBP=0 は周波数特性なし（100kHz でも 20dB）", ideal.ok, ideal.message);
  // 積分器: R=10k, C=10nF, 1kHz → |H| = 1/(ωRC) = 1.5915（4.036dB）, 位相 +90°（−1/(jωRC)）
  const integ = (src) => board(src, comp("R1", "R", ["vin", "n"], { R: 10e3 }), comp("C1", "C", ["n", "out"], { C: 10e-9 }), opamp("U1", "gnd", "n", "out", { GBP: 0 }), comp("TP1", "TP", ["out"]));
  const ia = await check(integ(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: 1000 })), "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 1000, gainDB: db(1 / (2 * Math.PI * 1000 * 1e-4)), phaseDeg: 90, gainToleranceDB: 0.001, phaseToleranceDeg: 0.01 });
  expect("OPAMP AC 積分器 −1/(jωRC): 4.036dB, +90°", ia.ok, ia.message);
  // 微分器: C=10nF 入力, R=10k 帰還, 1kHz → |H| = ωRC = 0.6283, 位相 −90°（−jωRC）
  const da = await check(board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: 1000 }), comp("C1", "C", ["vin", "n"], { C: 10e-9 }), comp("R1", "R", ["n", "out"], { R: 10e3 }), opamp("U1", "gnd", "n", "out", { GBP: 0 }), comp("TP1", "TP", ["out"])), "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 1000, gainDB: db(2 * Math.PI * 1000 * 1e-4), phaseDeg: -90, gainToleranceDB: 0.001, phaseToleranceDeg: 0.01 });
  expect("OPAMP AC 微分器 −jωRC: −4.036dB, −90°", da.ok, da.message);
  // DC で飽和していると AC 利得は出ない（非反転 ×11 に 2V の直流が乗る → +15V で飽和）
  const biased = board(comp("VB", "V_DC", ["vb", "gnd"], { V: 2 }), comp("V1", "V_AC", ["vin", "vb"], { Vpk: 0.01, freqHz: 1000 }), comp("R1", "R", ["n", "gnd"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "vin", "n", "out"), comp("TP1", "TP", ["out"]));
  const gb = await check(biased, "ac", { type: "acGaindB", input: "vin", output: "out", frequencyHz: 1000, expected: db(11), toleranceAbs: 0.1 });
  expect("OPAMP: DC 動作点で飽和していると AC 利得判定は不合格", !gb.ok, gb.message);

  // 過渡: 積分器に ±1V・1kHz の方形波 → 傾き 1/(RC) = 1e4 V/s、0.25ms で −2.5V、三角波 pp 5V
  const sq = comp("V1", "V_PULSE", ["vin", "gnd"], { Vlow: -1, Vhigh: 1, delaySec: 0, riseSec: 1e-9, fallSec: 1e-9, widthSec: 0.5e-3, periodSec: 1e-3 });
  const it = await check(integ(sq), "transient", { type: "transientPoint", node: "out", timeSec: 0.25e-3, expected: -2.5, tolerancePct: 0.5 }, {}, { simulation: { tStop: 3e-3 } });
  expect("OPAMP 過渡 積分器 v(0.25ms) = −t/(RC) = −2.5V", it.ok, it.message);
  const ipp = await check(integ(sq), "transient", { type: "transientMeasure", node: "out", measure: "pp", fromSec: 1e-3, toSec: 3e-3, expected: 5, tolerancePct: 0.5 }, {}, { simulation: { tStop: 3e-3 } });
  expect("OPAMP 過渡 積分器の三角波 pp = (1V/RC)·0.5ms = 5V", ipp.ok, ipp.message);
  // 過渡クリップ: 2Vpk × (−10) を ±12V 電源・Vdrop 1.5V → ±10.5V で頭打ち
  const clip = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 2, freqHz: 1000 }), comp("R1", "R", ["vin", "n"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }),
    opamp("U1", "gnd", "n", "out", { Vdrop: 1.5 }, "vp", "vm"), comp("VP", "V_DC", ["vp", "gnd"], { V: 12 }), comp("VM", "V_DC", ["gnd", "vm"], { V: 12 }), comp("TP1", "TP", ["out"]));
  const clipSim = await simulate(clip, { mode: "transient", checks: [], problem: { simulation: { tStop: 3e-3 } } });
  expect("OPAMP 過渡クリップ: 収束警告なし", clipSim.ok && clipSim.warnings.length === 0, JSON.stringify(clipSim.warnings));
  for (const [m, e] of [["max", 10.5], ["min", -10.5], ["pp", 21]]) {
    const r = await check(clip, "transient", { type: "transientMeasure", node: "out", measure: m, fromSec: 1e-3, toSec: 3e-3, expected: e, tolerancePct: 0.1 }, {}, { simulation: { tStop: 3e-3 } });
    expect(`OPAMP 過渡クリップ ${m} = ${e}V（レール 12V − Vdrop 1.5V）`, r.ok, r.message);
  }
  const noClip = await check(clip, "transient", { type: "transientMeasure", node: "out", measure: "pp", fromSec: 1e-3, toSec: 3e-3, expected: 40, tolerancePct: 5 }, {}, { simulation: { tStop: 3e-3 } });
  expect("OPAMP 過渡クリップ: クリップしない想定の 40Vpp は不合格", !noClip.ok);

  // 正帰還: + と − を取り違えた反転増幅は不安定な平衡点に留まらず飽和する（AC の利得判定も不合格）
  const swapped = (src) => board(src, comp("R1", "R", ["vin", "n"], { R: 1000 }), comp("R2", "R", ["n", "out"], { R: 10000 }), opamp("U1", "n", "gnd", "out"), comp("TP1", "TP", ["out"]));
  near("OPAMP 正帰還（+/− 取り違え）: DC で飽和（0.1V 入力 → −15V）", await dcOut(swapped(comp("V1", "V_DC", ["vin", "gnd"], { V: 0.1 }))), -15, 1e-9);
  const sw = await check(swapped(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 0.1, freqHz: 1000 })), "ac", { type: "bodePoint", input: "vin", output: "out", frequencyHz: 1000, gainDB: 20, phaseDeg: 180, gainToleranceDB: 0.5, phaseToleranceDeg: 5 });
  expect("OPAMP 正帰還（+/− 取り違え）: AC の利得判定は不合格（飽和して増幅しない）", !sw.ok, sw.message);
  // シュミットトリガ（非反転型）: しきい値 ±Vsat·R1/R2 = ±15·10k/100k = ±1.5V。
  // 入力 3Vpk・100Hz、刻み 2µs（入力の変化 ≤ 2π·100·3·2e-6 = 3.8mV/刻み）→ 反転時の入力を ±1% で比較
  const sch = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 3, freqHz: 100 }), comp("R1", "R", ["vin", "p"], { R: 10e3 }), comp("R2", "R", ["p", "out"], { R: 100e3 }), opamp("U1", "p", "gnd", "out"), comp("TP1", "TP", ["out"]));
  const schSim = await simulate(sch, { mode: "transient", tStop: 0.02, dt: 2e-6 });
  const so = schSim.transient.nodes.out, sv = schSim.transient.nodes.vin;
  const flips = [];
  for (let i = 1; i < so.length; i++) if (Math.sign(so[i]) !== Math.sign(so[i - 1])) flips.push(sv[i]);
  expect("シュミットトリガ: 2周期で3回反転（ヒステリシスあり）", flips.length === 3, JSON.stringify(flips));
  near("シュミットトリガ: 下側しきい値 −1.5V で −15V へ反転", flips[0], -1.5, 0.01);
  near("シュミットトリガ: 上側しきい値 +1.5V で +15V へ反転", flips[1], 1.5, 0.01);
  // 無安定マルチバイブレータ: R=10k, C=100nF, 分圧 β=1/2 → f = 1/(2RC·ln((1+β)/(1−β))) = 1/(2RC·ln3) = 455.1Hz
  // 刻み 1µs（周期の 1/2200）。零交差の測定誤差は刻み/半周期 ≈ 0.1% → 0.5% で比較
  const ast = board(comp("R", "R", ["out", "n"], { R: 10e3 }), comp("C", "C", ["n", "gnd"], { C: 100e-9 }), comp("R1", "R", ["out", "p"], { R: 10e3 }), comp("R2", "R", ["p", "gnd"], { R: 10e3 }), opamp("U1", "p", "n", "out"), comp("TP1", "TP", ["out"]));
  const af = await check(ast, "transient", { type: "oscillationFrequency", node: "out", fromSec: 0.005, expected: 1 / (2 * 1e-3 * Math.log(3)), tolerancePct: 0.5 }, {}, { simulation: { tStop: 0.02, dt: 1e-6 } });
  expect("OPAMP 無安定マルチバイブレータ f = 1/(2RC·ln3) = 455.1Hz", af.ok, af.message);
}
{
  // --- 差動増幅（BJT 差動対、テール抵抗 RE）: 2つの V_AC で差動入力、sources で同相入力に切替 ---
  // VCC=+12, VEE=−12, RC=10k（両側）, RE=10k, β=100。各 IC ≈ α(12−0.7)/(2RE) = 0.5594mA
  // 差動利得（片側出力 c2, 入力 in1−in2）Ad = gm·RC/2、同相利得 Acm = −β·RC/(rπ + (β+1)·2RE)
  const beta = 100, RC = 10e3, RE = 10e3;
  const dp = board(
    comp("V1", "V_AC", ["in1", "gnd"], { Vpk: 0.005, freqHz: 1000, phaseDeg: 0 }),
    comp("V2", "V_AC", ["in2", "gnd"], { Vpk: 0.005, freqHz: 1000, phaseDeg: 180 }),
    comp("VCC", "V_DC", ["vcc", "gnd"], { V: 12 }), comp("VEE", "V_DC", ["gnd", "vee"], { V: 12 }),
    comp("RC1", "R", ["vcc", "c1"], { R: RC }), comp("RC2", "R", ["vcc", "c2"], { R: RC }), comp("RE", "R", ["e", "vee"], { R: RE }),
    comp("Q1", "Q_NPN", ["c1", "in1", "e"], { beta }), comp("Q2", "Q_NPN", ["c2", "in2", "e"], { beta }),
    comp("TP1", "TP", ["c1"]), comp("TP2", "TP", ["c2"])
  );
  // 2つのベース電流が 10Ω（モデルのベース抵抗）を流れる分を含めた厳密値: IE_total = (12 − 0.7 − IB·10)/RE
  const IEt = (12 - 0.7) / (RE + (10 / (beta + 1)) / 2);
  const IC = (IEt / 2) * (beta / (beta + 1));
  const sim = await simulate(dp, { mode: "ac", checks: [] });
  near("差動対 IC = α·(VEE−0.7)/(2RE) = 0.5594mA", sim.ac.operatingPoints.Q1.ic, IC, 1e-3);
  const gm = IC / VT, rpi = beta / gm;
  const Ad = (gm * RC) / 2, Acm = (beta * RC) / (rpi + (beta + 1) * 2 * RE);
  const rAd = await check(dp, "ac", { type: "bodePoint", input: "in1", inputRef: "in2", output: "c2", frequencyHz: 1000, gainDB: db(Ad), phaseDeg: 0, gainToleranceDB: 0.05, phaseToleranceDeg: 0.5 });
  expect(`差動対 差動利得 Ad = gm·RC/2 = ${Ad.toFixed(1)}（inputRef で差動入力）`, rAd.ok, rAd.message);
  const rAdd = await check(dp, "ac", { type: "acGaindB", input: "in1", inputRef: "in2", output: "c2", outputRef: "c1", frequencyHz: 1000, expected: db(gm * RC), toleranceAbs: 0.05 });
  expect("差動対 差動出力（outputRef）Ad = gm·RC", rAdd.ok, rAdd.message);
  const cm = { V2: { phaseDeg: 0 } };
  const rAcm = await check(dp, "ac", { type: "bodePoint", input: "in1", output: "c2", sources: cm, frequencyHz: 1000, gainDB: db(Acm), phaseDeg: 180, gainToleranceDB: 0.05, phaseToleranceDeg: 0.5 });
  expect(`差動対 同相利得 Acm = −β·RC/(rπ+(β+1)2RE) = −${Acm.toFixed(4)}（sources で V2 を同相に）`, rAcm.ok, rAcm.message);
  const rAcmD = await check(dp, "ac", { type: "acVoltage", node: "c2", nodeRef: "c1", sources: cm, frequencyHz: 1000, expectedRMS: 0, toleranceAbs: 1e-9 });
  expect("差動対 同相入力では差動出力 c2−c1 = 0（完全対称）", rAcmD.ok, rAcmD.message);
  const rWrongSrc = await check(dp, "ac", { type: "acGaindB", input: "in1", output: "c2", sources: { V2: { phaseDeg: 0 } }, frequencyHz: 1000, expected: db(Ad), toleranceAbs: 1 });
  expect("差動対 同相入力の利得を差動利得として判定すると不合格", !rWrongSrc.ok);
  // 4抵抗の差動増幅（OPAMP）: 抵抗が揃えば同相出力 0、R4 が 10% ずれると vcm·{(R4/(R3+R4))(1+R2/R1) − R2/R1}
  const da = (r4) => board(
    comp("V1", "V_AC", ["a", "gnd"], { Vpk: 0.5, freqHz: 100 }), comp("V2", "V_AC", ["b", "gnd"], { Vpk: 0.5, freqHz: 100, phaseDeg: 180 }),
    comp("R1", "R", ["b", "n"], { R: 10e3 }), comp("R2", "R", ["n", "out"], { R: 100e3 }), comp("R3", "R", ["a", "p"], { R: 10e3 }), comp("R4", "R", ["p", "gnd"], { R: r4 }),
    comp("U1", "OPAMP", ["p", "n", "out", "", ""], { GBP: 0 }), comp("TP1", "TP", ["out"]));
  expect("OPAMP 差動増幅 Ad = R2/R1 = 20dB（inputRef）", (await check(da(100e3), "ac", { type: "acGaindB", input: "a", inputRef: "b", output: "out", frequencyHz: 100, expected: 20, toleranceAbs: 0.01 })).ok);
  expect("OPAMP 差動増幅 抵抗が揃うと同相出力 ≈ 0", (await check(da(100e3), "ac", { type: "acVoltage", node: "out", sources: cm, frequencyHz: 100, expectedRMS: 0, toleranceAbs: 1e-6 })).ok);
  const mis = (110 / 120) * 11 - 10;
  const rMis = await check(da(110e3), "ac", { type: "acVoltage", node: "out", sources: cm, frequencyHz: 100, expectedRMS: (0.5 * mis) / Math.SQRT2, tolerancePct: 0.1 });
  expect("OPAMP 差動増幅 R4 が 10% ずれると同相出力 = 29.46mVrms", rMis.ok, rMis.message);
}
{
  // --- transientMeasure（直流 2V + 正弦 1Vpk 1kHz、整数周期の区間）---
  // max 3, min 1, pp 2, average 2, rms √(4 + 0.5) = 2.1213, acRms 1/√2 = 0.7071
  // 台形則の積分誤差は刻み T/100 の正弦で (ωh)²/12 ≈ 3e-4 未満 → 0.1% で比較
  const b = board(comp("VB", "V_DC", ["m", "gnd"], { V: 2 }), comp("V1", "V_AC", ["out", "m"], { Vpk: 1, freqHz: 1000 }), comp("R1", "R", ["out", "gnd"], { R: 1000 }), comp("TP1", "TP", ["out"]));
  const cases = [["max", 3], ["min", 1], ["pp", 2], ["average", 2], ["rms", Math.sqrt(4.5)], ["acRms", Math.SQRT1_2]];
  for (const [m, e] of cases) {
    const r = await check(b, "transient", { type: "transientMeasure", node: "out", measure: m, fromSec: 1e-3, toSec: 4e-3, expected: e, tolerancePct: 0.1 });
    expect(`transientMeasure ${m} = ${e.toFixed(4)}`, r.ok, r.message);
  }
  const ri = await check(b, "transient", { type: "transientMeasure", element: "R1", quantity: "i", measure: "average", fromSec: 1e-3, toSec: 4e-3, expected: 2e-3, tolerancePct: 0.1 });
  expect("transientMeasure element 電流の平均 2mA", ri.ok, ri.message);
  const rref = await check(b, "transient", { type: "transientMeasure", node: "out", nodeRef: "m", measure: "average", fromSec: 1e-3, toSec: 4e-3, expected: 0, toleranceAbs: 1e-3 });
  expect("transientMeasure nodeRef（out−m の平均 0）", rref.ok, rref.message);
  const bad = await check(b, "transient", { type: "transientMeasure", node: "out", measure: "average", fromSec: 1e-3, toSec: 4e-3, expected: 2.1, tolerancePct: 1 });
  expect("transientMeasure: 5% 違う期待値は不合格", !bad.ok);
}
{
  // --- 分野C の判定の validation ---
  const base = {
    id: "T-09", category: "T", title: "t", statement: "s", judge: ["dc", "ac"],
    hints: ["方針", "式", "ほぼ答え"],
    explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" },
    fixedComponents: [
      { id: "V1", type: "V_AC", params: { Vpk: 0.01, freqHz: 1000 }, connect: ["in1", "gnd"] },
      { id: "VCC", type: "V_DC", params: { V: 12 }, connect: ["vcc", "gnd"] },
      { id: "TP1", type: "TP", connect: ["out"] },
    ],
    referenceSolution: [{ id: "R1", type: "R", params: { R: 1000 }, connect: ["in1", "out"] }],
    checks: [{ type: "acGaindB", input: "in1", output: "out", expected: 0, toleranceAbs: 0.1 }],
  };
  const v = (checks, patch = {}) => validateProblem({ ...base, ...patch, checks }, vopts);
  expect("validation: sources（固定の V_AC）は可", v([{ type: "acGaindB", input: "in1", output: "out", sources: { V1: { phaseDeg: 180 } }, expected: 0, toleranceAbs: 0.1 }]).ok);
  expect("validation: sources に V_DC はエラー", !v([{ type: "acGaindB", input: "in1", output: "out", sources: { VCC: { Vpk: 1 } }, expected: 0 }]).ok);
  expect("validation: sources にプレイヤーの部品はエラー", !v([{ type: "acGaindB", input: "in1", output: "out", sources: { R1: { Vpk: 1 } }, expected: 0 }]).ok);
  expect("validation: sources の未知パラメータはエラー", !v([{ type: "acGaindB", input: "in1", output: "out", sources: { V1: { freqHz: 5 } }, expected: 0 }]).ok);
  expect("validation: sources は transientPoint では使えない", !v([{ type: "transientPoint", node: "out", timeSec: 1, sources: { V1: { Vpk: 1 } }, expected: 0 }]).ok);
  expect("validation: inputRef に固定部品が無いと警告", v([{ type: "acGaindB", input: "in1", inputRef: "zz", output: "out", expected: 0 }]).warnings.some((w) => /inputRef/.test(w)));
  expect("validation: acImpedance は可", v([{ type: "acImpedance", node: "out", exclude: ["V1"], expected: 100 }]).ok);
  expect("validation: acImpedance の exclude にプレイヤーの部品は警告", v([{ type: "acImpedance", node: "out", exclude: ["R1"], expected: 100 }]).warnings.some((w) => /exclude/.test(w)));
  expect("validation: acImpedance に node が無いとエラー", !v([{ type: "acImpedance", expected: 100 }]).ok);
  expect("validation: operatingRegion は可", v([{ type: "operatingRegion", match: { type: "R" }, region: ["active", "saturation"] }]).ok);
  expect("validation: operatingRegion の未知の region はエラー", !v([{ type: "operatingRegion", element: "R1", region: "amplifying" }]).ok);
  expect("validation: transientMeasure は可", v([{ type: "transientMeasure", node: "out", measure: "pp", fromSec: 0.001, toSec: 0.002, expected: 1 }]).ok);
  expect("validation: transientMeasure の measure 不正はエラー", !v([{ type: "transientMeasure", node: "out", measure: "peak", fromSec: 0, expected: 1 }]).ok);
  expect("validation: transientMeasure の fromSec 無しは警告", v([{ type: "transientMeasure", node: "out", measure: "pp", expected: 1 }]).warnings.some((w) => /fromSec/.test(w)));
  expect("validation: simulation.initialCondition dc は可", v(base.checks, { simulation: { initialCondition: "dc" } }).ok);
  expect("validation: simulation.initialCondition の不正値はエラー", !v(base.checks, { simulation: { initialCondition: "op" } }).ok);
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
  // layout（docs/layout_spec.md）
  expect("validation: layout（guides / groundSymbols / routes）は可", (() => { const r = v({ layout: { guides: true, groundSymbols: false, routes: [{ net: "out", points: [[10, 20], [50, 20], [50, 80]] }] } }); return r.ok && r.warnings.length === 0; })());
  expect("validation: layout がオブジェクトでないとエラー", !v({ layout: [] }).ok);
  expect("validation: layout.guides が真偽値でないとエラー", !v({ layout: { guides: "yes" } }).ok);
  expect("validation: layout.routes の斜めの区間はエラー", !v({ layout: { routes: [{ net: "out", points: [[10, 20], [50, 60]] }] } }).ok);
  expect("validation: layout.routes の net が固定部品に無いとエラー", !v({ layout: { routes: [{ net: "zzz", points: [[10, 20], [50, 20]] }] } }).ok);
  expect("validation: layout.routes の点が1つだけはエラー", !v({ layout: { routes: [{ net: "out", points: [[10, 20]] }] } }).ok);
  expect("validation: layout の未知のキーは警告", (() => { const r = v({ layout: { foo: 1 } }); return r.ok && r.warnings.some((w) => /layout\.foo/.test(w)); })());
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

/* ---------------------------------------------------------------- verify.mjs: OPAMP の誤答（+/− 入力の取り違え、モデル定数は2倍にしない） */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-opamp-"));
  fs.mkdirSync(path.join(dir, "T"));
  // 反転増幅 ×10 をプレイヤーが組む（OPAMP・R1・R2 を置く）。判定は 1kHz の利得と位相
  const p = {
    id: "T-05", category: "T", title: "t", statement: "s", judge: "ac",
    hints: ["a", "b", "c"], explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" },
    fixedComponents: [
      { id: "V1", type: "V_AC", params: { Vpk: 0.1, freqHz: 1000 }, connect: ["vin", "gnd"], locked: true },
      { id: "TP1", type: "TP", connect: ["out"], locked: true },
    ],
    referenceSolution: [
      { id: "U1", type: "OPAMP", params: { Aol: 1e5, GBP: 1e6, Vpos: 15, Vneg: -15, Vdrop: 0 }, connect: ["gnd", "n", "out", "", ""] },
      { id: "R1", type: "R", params: { R: 1000 }, connect: ["vin", "n"] },
      { id: "R2", type: "R", params: { R: 10000 }, connect: ["n", "out"] },
    ],
    checks: [{ type: "bodePoint", input: "vin", output: "out", frequencyHz: 1000, gainDB: 20, phaseDeg: 180, gainToleranceDB: 0.1, phaseToleranceDeg: 2 }],
  };
  fs.writeFileSync(path.join(dir, "T", "T-05.json"), JSON.stringify(p));
  fs.writeFileSync(path.join(dir, "T", "index.json"), JSON.stringify({ problems: [{ id: "T-05", title: "t" }] }));
  const run = (...a) => {
    try {
      return { code: 0, out: execFileSync("node", [path.join(ROOT, "tools/verify.mjs"), `--problems=${dir}`, ...a], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const ref = run();
  expect("verify: オペアンプの参照解が合格", ref.code === 0 && /参照解が合格 1 問/.test(ref.out), ref.out);
  const rev = run("--reverse");
  expect("verify --reverse: OPAMP の +/− 入力の取り違えは不合格（正帰還で飽和）", rev.code === 0 && /誤答がすべて不合格 1 問/.test(rev.out), rev.out);
  const mut = run("--mutate");
  expect("verify --mutate: OPAMP の Aol/GBP/電源は2倍にしない（R1, R2 の2倍だけで不合格）", mut.code === 0 && /不合格になった誤答 2 件/.test(mut.out), mut.out);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- デジタル（truthTable / sequence / componentCount） */
// 論理値は 0/1/X の厳密な計算なので許容誤差は無い（完全一致で比較）。期待値はすべて手で書いた真理値表・系列。
{
  const IN = (id, net, value) => comp(id, "LOGIC_IN", [net], value === undefined ? {} : { value });
  const TPs = (...nets) => nets.map((n) => comp(`TP_${n}`, "TP", [n]));
  const dig = (b, chk) => check(b, "digital", chk);
  const tt = (inputs, outputs, expectObj) => ({ type: "truthTable", inputs, outputs, expect: expectObj });

  // 半加算器: S = A xor B = 0110, C = A and B = 0001（入力は A が上位ビット: 00,01,10,11）
  const ha = [IN("A", "a"), IN("B", "b"), ...TPs("s", "c"), comp("U1", "U_XOR", ["a", "b", "s"]), comp("U2", "U_AND", ["a", "b", "c"])];
  const haChk = tt(["a", "b"], ["s", "c"], { s: "0110", c: "0001" });
  expect("truthTable 半加算器（expect 形式）: 合格", (await dig(board(...ha), haChk)).ok);
  const haTable = { type: "truthTable", inputs: ["a", "b"], outputs: ["s", "c"], table: [[1, 1, 0, 1], [0, 0, 0, 0], [1, 0, 1, 0], [0, 1, 1, 0]] };
  expect("truthTable 半加算器（table 形式・行の順は自由）: 合格", (await dig(board(...ha), haTable)).ok);
  const haOr = await dig(board(...ha.map((c) => (c.id === "U1" ? { ...c, type: "U_OR" } : c))), haChk);
  expect("truthTable: XOR を OR にすると A=1,B=1 の行で不合格", !haOr.ok && /a=1, b=1 のとき s=1（正しくは 0）/.test(haOr.message), haOr.message);
  const haFloat = await dig(board(...ha.map((c) => (c.id === "U1" ? { ...c, connect: ["a", "", "s"] } : c))), haChk);
  expect("truthTable: 入力ピン未配線は不合格（未配線と表示）", !haFloat.ok && /U1 の B 入力が未配線/.test(haFloat.message), haFloat.message);
  const haShort = await dig(board(...ha, comp("U3", "U_NOT", ["a", "s"])), haChk);
  expect("truthTable: 出力どうしの衝突は不合格", !haShort.ok && /衝突/.test(haShort.message), haShort.message);
  const haExtra = await dig(board(...ha, comp("U9", "U_AND", ["", "", "zz"])), haChk);
  expect("truthTable: 判定に関係ない未配線ゲートは無視して合格", haExtra.ok, haExtra.message);
  const haMissingOut = await dig(board(...ha.filter((c) => c.id !== "U2")), haChk);
  expect("truthTable: 出力を駆動する部品が無いと不合格", !haMissingOut.ok && /c を駆動するもの/.test(haMissingOut.message), haMissingOut.message);
  const haCx = await dig(board(...ha), tt(["a", "b"], ["s", "c"], { s: "0110", c: "0xx1" }));
  expect("truthTable: x は don't care", haCx.ok);

  // NAND 4個の XOR: n1=NAND(a,b), s=NAND(NAND(a,n1), NAND(b,n1))
  const nx = [IN("A", "a"), IN("B", "b"), ...TPs("s"),
    comp("U1", "U_NAND", ["a", "b", "n1"]), comp("U2", "U_NAND", ["a", "n1", "n2"]),
    comp("U3", "U_NAND", ["b", "n1", "n3"]), comp("U4", "U_NAND", ["n2", "n3", "s"])];
  expect("truthTable: NAND 4個の XOR", (await dig(board(...nx), tt(["a", "b"], ["s"], { s: "0110" }))).ok);
  const cnt = { type: "componentCount", types: ["U_NAND"], max: 4 };
  expect("componentCount: NAND 4個で max 4 は合格", (await dig(board(...nx), cnt)).ok);
  const cnt5 = await dig(board(...nx, comp("U5", "U_NAND", ["a", "a", "zz"])), cnt);
  expect("componentCount: NAND 5個で max 4 は不合格", !cnt5.ok && /5 個/.test(cnt5.message), cnt5.message);
  expect("componentCount: 固定部品（locked）は数えない", (await dig(board(...nx, { ...comp("U9", "U_NAND", ["a", "b", "zz"]), locked: true }), cnt)).ok);

  // 全加算器（半加算器2個 + OR）: S = 01101001, Cout = 00010111（入力 a, b, cin）
  const fa = [IN("A", "a"), IN("B", "b"), IN("CI", "cin"), ...TPs("s", "co"),
    comp("U1", "U_XOR", ["a", "b", "p"]), comp("U2", "U_XOR", ["p", "cin", "s"]),
    comp("U3", "U_AND", ["a", "b", "g"]), comp("U4", "U_AND", ["p", "cin", "t"]), comp("U5", "U_OR", ["g", "t", "co"])];
  expect("truthTable: 全加算器（3入力2出力）", (await dig(board(...fa), tt(["a", "b", "cin"], ["s", "co"], { s: "01101001", co: "00010111" }))).ok);

  // 2:1 MUX: y = s ? b : a。入力順 (s, a, b) → 00110101
  const mux = [IN("S", "sel"), IN("A", "a"), IN("B", "b"), ...TPs("y"),
    comp("U1", "U_NOT", ["sel", "ns"]), comp("U2", "U_AND", ["a", "ns", "t0"]), comp("U3", "U_AND", ["b", "sel", "t1"]), comp("U4", "U_OR", ["t0", "t1", "y"])];
  expect("truthTable: 2:1 MUX", (await dig(board(...mux), tt(["sel", "a", "b"], ["y"], { y: "00110101" }))).ok);

  // 4:1 MUX（AND3 + OR3 + OR）: 入力 (s1, s0, d0..d3) の 64 行を JS で期待値を作って比較
  const mux4 = [IN("S1", "s1"), IN("S0", "s0"), IN("D0", "d0"), IN("D1", "d1"), IN("D2", "d2"), IN("D3", "d3"), ...TPs("y"),
    comp("N1", "U_NOT", ["s1", "n1"]), comp("N0", "U_NOT", ["s0", "n0"]),
    comp("A0", "U_AND3", ["n1", "n0", "d0", "t0"]), comp("A1", "U_AND3", ["n1", "s0", "d1", "t1"]),
    comp("A2", "U_AND3", ["s1", "n0", "d2", "t2"]), comp("A3", "U_AND3", ["s1", "s0", "d3", "t3"]),
    comp("O1", "U_OR3", ["t0", "t1", "t2", "o1"]), comp("O2", "U_OR", ["o1", "t3", "y"])];
  let y4 = "";
  for (let r = 0; r < 64; r += 1) y4 += (r >> (3 - ((r >> 4) & 3))) & 1; // s=(r>>4)、d_k はビット (3-k)
  expect("truthTable: 4:1 MUX（AND3/OR3、64行）", (await dig(board(...mux4), tt(["s1", "s0", "d0", "d1", "d2", "d3"], ["y"], { y: y4 }))).ok);

  // 2→4 デコーダ: y0 = 1000, y1 = 0100, y2 = 0010, y3 = 0001（入力 a1, a0）
  const dec = [IN("A1", "a1"), IN("A0", "a0"), ...TPs("y0", "y1", "y2", "y3"),
    comp("N1", "U_NOT", ["a1", "n1"]), comp("N0", "U_NOT", ["a0", "n0"]),
    comp("U0", "U_AND", ["n1", "n0", "y0"]), comp("U1", "U_AND", ["n1", "a0", "y1"]),
    comp("U2", "U_AND", ["a1", "n0", "y2"]), comp("U3", "U_AND", ["a1", "a0", "y3"])];
  expect("truthTable: 2→4 デコーダ（4出力）", (await dig(board(...dec), tt(["a1", "a0"], ["y0", "y1", "y2", "y3"], { y0: "1000", y1: "0100", y2: "0010", y3: "0001" }))).ok);

  // 4→2 エンコーダ（ワンホット入力、それ以外の行は don't care）: table 形式で4行だけ
  const enc = [IN("I1", "i1"), IN("I2", "i2"), IN("I3", "i3"), ...TPs("b1", "b0"),
    comp("U1", "U_OR", ["i2", "i3", "b1"]), comp("U2", "U_OR", ["i1", "i3", "b0"])];
  const encChk = { type: "truthTable", inputs: ["i1", "i2", "i3"], outputs: ["b1", "b0"], table: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 1], [0, 1, 0, 1, 0], [0, 0, 1, 1, 1]] };
  expect("truthTable: エンコーダ（書いた行だけ判定）", (await dig(board(...enc), encChk)).ok);

  // 多数決: y = ab + bc + ca = 00010111 / 3入力パリティ = 01101001
  const maj = [IN("A", "a"), IN("B", "b"), IN("C", "c"), ...TPs("y", "p"),
    comp("U1", "U_AND", ["a", "b", "t1"]), comp("U2", "U_AND", ["b", "c", "t2"]), comp("U3", "U_AND", ["c", "a", "t3"]),
    comp("U4", "U_OR3", ["t1", "t2", "t3", "y"]), comp("X1", "U_XOR", ["a", "b", "x1"]), comp("X2", "U_XOR", ["x1", "c", "p"])];
  expect("truthTable: 多数決とパリティ", (await dig(board(...maj), tt(["a", "b", "c"], ["y", "p"], { y: "00010111", p: "01101001" }))).ok);

  // 定数: 判定が駆動しない LOGIC_IN（value=1）と V_DC 5V はどちらも 1。NAND の片側を 1 にすると NOT
  const k1 = await dig(board(IN("A", "a"), IN("H", "h", 1), ...TPs("y"), comp("U1", "U_NAND", ["a", "h", "y"])), tt(["a"], ["y"], { y: "10" }));
  expect("truthTable: LOGIC_IN(value=1) を定数 1 として使える", k1.ok, k1.message);
  const k2 = await dig(board(IN("A", "a"), comp("V1", "V_DC", ["vcc", "gnd"], { V: 5 }), ...TPs("y"), comp("U1", "U_NOR", ["a", "gnd", "y"]), comp("U2", "U_AND", ["vcc", "vcc", "zz"])), tt(["a"], ["y"], { y: "10" }));
  expect("truthTable: gnd を定数 0 として使える（NOR の片側を gnd → NOT）", k2.ok, k2.message);

  // プルアップ抵抗 + スイッチ: SW 開 → 入力 n は R で 1、SW 閉 → gnd で 0（強い駆動が優先）。NOT の出力 y は 0 / 1
  const pu = (closed) => board(IN("A", "a"), comp("V1", "V_DC", ["vcc", "gnd"], { V: 5 }), comp("R1", "R", ["vcc", "n"], { R: 10000 }),
    comp("SW1", "SW", ["n", "gnd"], { closed }), comp("U1", "U_NOT", ["n", "y"]), comp("U2", "U_AND", ["a", "y", "o"]), ...TPs("o"));
  expect("truthTable: プルアップ（SW 開）で入力 1 → NOT 出力 0", (await dig(pu(false), tt(["a"], ["o"], { o: "00" }))).ok);
  expect("truthTable: SW 閉で入力 0 → NOT 出力 1", (await dig(pu(true), tt(["a"], ["o"], { o: "01" }))).ok);
  const noPu = await dig(board(IN("A", "a"), comp("SW1", "SW", ["n", "gnd"], { closed: false }), comp("U1", "U_NOT", ["n", "y"]), comp("U2", "U_AND", ["a", "y", "o"]), ...TPs("o")), tt(["a"], ["o"], { o: "00" }));
  expect("truthTable: プルアップ無しで SW 開 → 入力が浮いて不合格", !noPu.ok && /U1 の A 入力が未接続/.test(noPu.message), noPu.message);

  // リング発振（NAND + NOT 2個、A=1 で発振）: 出力は X → 期待値 1 でも 0 でも不合格、x なら合格
  const ring = board(IN("A", "a"), ...TPs("y"), comp("U1", "U_NAND", ["a", "z", "x"]), comp("U2", "U_NOT", ["x", "y"]), comp("U3", "U_NOT", ["y", "z"]));
  expect("truthTable: 発振する出力は X（期待 0x で合格）", (await dig(ring, tt(["a"], ["y"], { y: "0x" }))).ok);
  expect("truthTable: 発振する出力は X（期待 01 で不合格）", !(await dig(ring, tt(["a"], ["y"], { y: "01" }))).ok);

  // ダイオード OR（ゲートなし → DC 解析）: y = 5 − 0.7 = 4.3V ≥ 2.5V → 1。出力 0111
  const dor = board(comp("D1", "D", ["a", "y"], { Vf: 0.7 }), comp("D2", "D", ["b", "y"], { Vf: 0.7 }), comp("R1", "R", ["y", "gnd"], { R: 10000 }), ...TPs("y"));
  expect("truthTable: ダイオード OR（DC 解析方式）", (await dig(dor, tt(["a", "b"], ["y"], { y: "0111" }))).ok);

  /* ---- sequence ---- */
  const CK = IN("CK", "clk");
  // DFF の Q_NOT を D に戻す 1/2 分周: 電源投入時 Q=0 → クロックごとに 1,0,1,0,…
  const div2 = [CK, ...TPs("q"), comp("F1", "DFF", ["qn", "clk", "q", "qn"])];
  expect("sequence: DFF 1/2 分周 10101", (await dig(board(...div2), { type: "sequence", clock: "clk", outputs: { q: "10101" } })).ok);
  const div2bad = await dig(board(...div2), { type: "sequence", clock: "clk", outputs: { q: "01010" } });
  expect("sequence: 系列が違えば何回目かを表示して不合格", !div2bad.ok && /クロック 1 回目/.test(div2bad.message), div2bad.message);
  // beforeRise: 立ち上がり前に記録するので 1 つ遅れる 01010
  expect("sequence: sampleAt=beforeRise", (await dig(board(...div2), { type: "sequence", clock: "clk", sampleAt: "beforeRise", outputs: { q: "01010" } })).ok);
  // 非同期 2bit カウンタ（次段のクロックは前段の Q_NOT）: 1,2,3,0,… → q0=1010…, q1=0110…
  const ripple = [CK, ...TPs("q0", "q1"), comp("F1", "DFF", ["qn0", "clk", "q0", "qn0"]), comp("F2", "DFF", ["qn1", "qn0", "q1", "qn1"])];
  expect("sequence: 非同期2bitアップカウンタ", (await dig(board(...ripple), { type: "sequence", clock: "clk", outputs: { q0: "10101010", q1: "01100110" } })).ok);
  // 同期 2bit カウンタ（D1 = q1 xor q0）: 同じ系列
  const sync = [CK, ...TPs("q0", "q1"), comp("F1", "DFF", ["qn0", "clk", "q0", "qn0"]), comp("F2", "DFF", ["d1", "clk", "q1", ""]), comp("U1", "U_XOR", ["q1", "q0", "d1"])];
  expect("sequence: 同期2bitカウンタ（Q_NOT 未使用でも可）", (await dig(board(...sync), { type: "sequence", clock: "clk", outputs: { q0: "10101010", q1: "01100110" } })).ok);
  // 3段シフトレジスタ: d=1011000 → q2 は3クロック遅れ 0001011。同時クロックの DFF はエッジ前の値を取り込む
  const sr3 = [CK, IN("D", "d"), ...TPs("q2"), comp("F1", "DFF", ["d", "clk", "q0", ""]), comp("F2", "DFF", ["q0", "clk", "q1", ""]), comp("F3", "DFF", ["q1", "clk", "q2", ""])];
  expect("sequence: 3段シフトレジスタ", (await dig(board(...sr3), { type: "sequence", clock: "clk", inputs: { d: "1011000" }, outputs: { q2: "0010110" } })).ok);
  // 10進カウンタ（DFF_R 4個 + NAND で 1010 を検出して CLR）: 1..9,0,1,2 → q3 は 8,9 で 1
  const ffr = (i, clkNet) => comp(`F${i}`, "DFF_R", [`qn${i}`, clkNet, "clr", `q${i}`, `qn${i}`]);
  const dec10 = [CK, ...TPs("q0", "q3"), ffr(0, "clk"), ffr(1, "qn0"), ffr(2, "qn1"), ffr(3, "qn2"), comp("U1", "U_NAND", ["q3", "q1", "clr"])];
  expect("sequence: DFF_R + NAND の10進カウンタ", (await dig(board(...dec10), { type: "sequence", clock: "clk", outputs: { q0: "101010101010", q3: "000000011000" } })).ok);
  const clrFloat = await dig(board(CK, ...TPs("q0"), comp("F0", "DFF_R", ["qn0", "clk", "", "q0", "qn0"])), { type: "sequence", clock: "clk", outputs: { q0: "1010" } });
  expect("sequence: DFF_R の CLR 未配線は不合格", !clrFloat.ok && /F0 の CLR 入力が未配線/.test(clrFloat.message), clrFloat.message);
  // NOR 2個の SR ラッチ（クロックなし）: 初期 X → S で 1 → 保持 → R で 0 → 保持 → S で 1 → 保持
  const srl = [IN("S", "s"), IN("R", "r"), ...TPs("q", "qn"), comp("U1", "U_NOR", ["r", "qn", "q"]), comp("U2", "U_NOR", ["s", "q", "qn"])];
  const srChk = { type: "sequence", inputs: { s: "0100010", r: "0001000" }, outputs: { q: "x110011", qn: "x001100" } };
  expect("sequence: NOR の SR ラッチ（保持・初期値 X）", (await dig(board(...srl), srChk)).ok);
  expect("sequence: SR ラッチの初期値は X（0 を期待すると不合格）", !(await dig(board(...srl), { ...srChk, outputs: { q: "0110011" } })).ok);
  // S=R=1 から同時に 0 に戻す（禁止入力の解除）→ 発振して X
  expect("sequence: SR ラッチの禁止入力の解除は X", (await dig(board(...srl), { type: "sequence", inputs: { s: "10", r: "10" }, outputs: { q: "0x" } })).ok);
  // NAND 4個 + NOT の D ラッチ（EN=1 で透過、EN=0 で保持）
  const dl = [IN("D", "d"), IN("E", "en"), ...TPs("q"), comp("N1", "U_NOT", ["d", "dn"]),
    comp("U1", "U_NAND", ["d", "en", "sb"]), comp("U2", "U_NAND", ["dn", "en", "rb"]),
    comp("U3", "U_NAND", ["sb", "qn", "q"]), comp("U4", "U_NAND", ["rb", "q", "qn"])];
  expect("sequence: D ラッチ（透過と保持）", (await dig(board(...dl), { type: "sequence", inputs: { d: "100110", en: "101101" }, outputs: { q: "110110" } })).ok);

  /* ---- validation ---- */
  const vp = (over) => validateProblem({
    id: "G-99", category: "G", title: "t", statement: "s", judge: "digital",
    hints: ["a", "b", "c"], explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" },
    fixedComponents: [{ id: "A", type: "LOGIC_IN", connect: ["a"] }, { id: "B", type: "LOGIC_IN", connect: ["b"] }, { id: "TP1", type: "TP", connect: ["y"] }],
    checks: [{ type: "truthTable", inputs: ["a", "b"], outputs: ["y"], expect: { y: "0001" } }],
    ...over,
  }, vopts);
  expect("validation: 正しい truthTable 問題は OK・警告なし", (() => { const r = vp({}); return r.ok && r.warnings.length === 0; })(), JSON.stringify(vp({})));
  expect("validation: truthTable に judge digital が無いとエラー", !vp({ judge: "dc" }).ok);
  expect("validation: expect の長さ違いはエラー", !vp({ checks: [{ type: "truthTable", inputs: ["a", "b"], outputs: ["y"], expect: { y: "001" } }] }).ok);
  expect("validation: inputs 無しはエラー", !vp({ checks: [{ type: "truthTable", outputs: ["y"], expect: { y: "01" } }] }).ok);
  expect("validation: 入力ネットに LOGIC_IN が無いと警告", vp({ checks: [{ type: "truthTable", inputs: ["a", "c"], outputs: ["y"], expect: { y: "0001" } }] }).warnings.some((w) => /LOGIC_IN/.test(w)));
  expect("validation: 一部の行だけの table は警告", vp({ checks: [{ type: "truthTable", inputs: ["a", "b"], outputs: ["y"], table: [[1, 1, 1]] }] }).warnings.some((w) => /1\/4 行/.test(w)));
  expect("validation: sequence の長さ違いはエラー", !vp({ checks: [{ type: "sequence", clock: "a", inputs: { b: "011" }, outputs: { y: "01" } }] }).ok);
  expect("validation: sequence の入力に x はエラー", !vp({ checks: [{ type: "sequence", clock: "a", inputs: { b: "0x" }, outputs: { y: "01" } }] }).ok);
  expect("validation: 正しい sequence は OK", vp({ checks: [{ type: "sequence", clock: "a", inputs: { b: "011" }, outputs: { y: "0x1" } }] }).ok);
  expect("validation: componentCount の min > max はエラー", !vp({ checks: [{ type: "truthTable", inputs: ["a", "b"], outputs: ["y"], expect: { y: "0001" } }, { type: "componentCount", types: ["U_NAND"], min: 3, max: 2 }] }).ok);
  expect("validation: componentCount の未知の種別はエラー", !vp({ checks: [{ type: "componentCount", types: ["U_FOO"], max: 2 }] }).ok);

  /* ---- verify.mjs（デジタル問題の --mutate / --reverse / --drop） ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-digital-"));
  const cat = path.join(dir, "D");
  fs.mkdirSync(cat);
  const common = {
    category: "D", title: "t", statement: "s", judge: "digital",
    hints: ["a", "b", "c"], explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" },
  };
  const fx = (list) => list.map((c) => ({ ...c, locked: true }));
  // D-01 半加算器（厳しい）
  const d1 = { ...common, id: "D-01",
    fixedComponents: fx([{ id: "A", type: "LOGIC_IN", connect: ["a"] }, { id: "B", type: "LOGIC_IN", connect: ["b"] }, { id: "TS", type: "TP", connect: ["s"] }, { id: "TC", type: "TP", connect: ["c"] }]),
    referenceSolution: [{ id: "U1", type: "U_XOR", connect: ["a", "b", "s"] }, { id: "U2", type: "U_AND", connect: ["a", "b", "c"] }],
    checks: [{ type: "truthTable", inputs: ["a", "b"], outputs: ["s", "c"], expect: { s: "0110", c: "0001" } }] };
  // D-02 NAND の入力を短絡した NOT: NOR に替えても同じ論理なので mutate はそれを誤答として数えない
  const d2 = { ...common, id: "D-02",
    fixedComponents: fx([{ id: "A", type: "LOGIC_IN", connect: ["a"] }, { id: "TY", type: "TP", connect: ["y"] }]),
    referenceSolution: [{ id: "U1", type: "U_NAND", connect: ["a", "a", "y"] }],
    checks: [{ type: "truthTable", inputs: ["a"], outputs: ["y"], expect: { y: "10" } }] };
  // D-03 1/2 分周
  const d3 = { ...common, id: "D-03",
    fixedComponents: fx([{ id: "CK", type: "LOGIC_IN", connect: ["clk"] }, { id: "TQ", type: "TP", connect: ["q"] }]),
    referenceSolution: [{ id: "F1", type: "DFF", connect: ["qn", "clk", "q", "qn"] }],
    checks: [{ type: "sequence", clock: "clk", outputs: { q: "1010" } }] };
  // D-04 甘い問題: AND の 11 の行だけ判定 → OR に替えても合格（--mutate が報告すべき）
  const d4 = { ...common, id: "D-04",
    fixedComponents: fx([{ id: "A", type: "LOGIC_IN", connect: ["a"] }, { id: "B", type: "LOGIC_IN", connect: ["b"] }, { id: "TY", type: "TP", connect: ["y"] }]),
    referenceSolution: [{ id: "U1", type: "U_AND", connect: ["a", "b", "y"] }],
    checks: [{ type: "truthTable", inputs: ["a", "b"], outputs: ["y"], table: [[1, 1, 1]] }] };
  for (const p of [d1, d2, d3, d4]) fs.writeFileSync(path.join(cat, `${p.id}.json`), JSON.stringify(p));
  fs.writeFileSync(path.join(cat, "index.json"), JSON.stringify({ problems: ["D-01", "D-02", "D-03", "D-04"].map((id) => ({ id, title: "t" })) }));
  const runV = (...a) => {
    try {
      return { code: 0, out: execFileSync("node", [path.join(ROOT, "tools/verify.mjs"), `--problems=${dir}`, ...a], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const vr = runV();
  expect("verify digital ref: 4問とも参照解が合格", /参照解が合格 4 問/.test(vr.out), vr.out);
  const vm = runV("--mutate");
  expect("verify digital --mutate: D-04 の OR 差し替えを報告", /D-04（U1（U_AND）を U_OR に替えても合格/.test(vm.out), vm.out);
  expect("verify digital --mutate: D-01, D-02（NOR は同じ論理なので除外）, D-03 は報告しない", !/D-0[123]/.test(vm.out), vm.out);
  const vrev = runV("--reverse", "D-0");
  expect("verify digital --reverse: 入出力の入れ替えは全問で不合格（報告なし）", !/甘い判定の可能性/.test(vrev.out) && /誤答がすべて不合格 4 問/.test(vrev.out), vrev.out);
  const vd = runV("--drop", "D-0");
  expect("verify digital --drop: 部品を外すと全問で不合格（報告なし）", !/甘い判定の可能性/.test(vd.out) && /誤答がすべて不合格 4 問/.test(vd.out), vd.out);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- 分野F/J: 整流・平滑・DC-DC コンバータ・インバータ・サイリスタ・トランス */
// 許容誤差の根拠（このブロック）:
// - 切り替わる素子（D 系・SCR/TRIAC・SW_V）がある回路は、交流 1 周期 400 点以上・PWM 1 周期 100 点以上で、
//   素子の状態が変わった刻みは 1/64 まで二分して切り替わり時刻を求める。台形則の位相誤差 (ωh)²/12 ≈ 2e-5、
//   切り替わり時刻の誤差 ≤ T/25600 → 平均・実効値は 0.2〜0.5% で比較する。
// - リプル（pp）は小さな量の差なので相対誤差が大きくなる。整流＋C は同じ理想モデル（Vf 一定・Rs）の
//   半解析解（指数放電と正弦波の交点）と比べて 1%、教科書の近似 ΔV ≈ I/(2fC) とは 10%
//   （近似は「放電時間 = T/2」「放電電流一定」を仮定するので、実際の放電時間 T/2 − 充電時間だけ小さく出る）。
// - コンバータは理想に近い部品（SW_V の Ron = 10mΩ、ダイオード Vf = 0・Rs = 1mΩ）で、初期値（C の initialV、
//   L の initialI）を定常に合わせ、出力の RC 時定数の 8 倍以上たってから測る。Ron の損失（D·I²·Ron / Pout ≈ 0.1%）が
//   理論式からのずれ → 平均は 0.5%。インダクタ電流のリプル ΔI = (Vin−Vout)·D·T/L は区間内で直線なので 2%。
//   出力リプル ΔV = ΔI/(8fC) はリプル電流の一部が負荷 R に流れる分（Xc/R ≈ 2%）だけ小さく出る → 5%。
{
  const T50 = 1 / 50;
  const interpAt = (ts, vs, t) => {
    let k = 1;
    while (k < ts.length - 1 && ts[k] < t) k++;
    return vs[k - 1] + ((vs[k] - vs[k - 1]) * (t - ts[k - 1])) / (ts[k] - ts[k - 1]);
  };
  const simT = async (b, simulation) => simulate(b, { mode: "transient", problem: { simulation } });
  const run1 = async (sim, b, chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b, context: {} });
  const meas = (sim, which, measure, fromSec, toSec, q = "i") => {
    const arr = sim.transient.nodes[which] ?? sim.transient.elements[which]?.[q];
    return measureWaveform(sim.transient.time, arr, measure, fromSec, toSec);
  };

  // --- 半波整流（理想ダイオード: Vf=0, Rs=1mΩ）: 平均 Vm/π、実効値 Vm/2 ---
  {
    const Vm = 10;
    const b = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: Vm, freqHz: 50 }), comp("D1", "D", ["vin", "out"], { Vf: 0 }),
      comp("RL", "R", ["out", "gnd"], { R: 1000 }), comp("TP1", "TP", ["out"]));
    const sim = await simT(b, { tStop: 0.1, diodeRs: 1e-3 });
    expect("半波整流: 解析成功", sim.ok, JSON.stringify(sim.errors));
    near("半波整流（理想）: 平均 = Vm/π", meas(sim, "out", "average", 0.02, 0.1), (Vm / Math.PI) * (1000 / 1000.001), 0.002);
    near("半波整流（理想）: 実効値 = Vm/2", meas(sim, "out", "rms", 0.02, 0.1), Vm / 2, 0.002);
    expect("半波整流: 刻みは交流周期の 1/400 以下", sim.transient.dt <= T50 / 400 * 1.0001, String(sim.transient.dt));
    const r = await run1(sim, b, { type: "transientMeasure", node: "out", measure: "average", fromSec: 0.02, toSec: 0.1, expected: Vm / Math.PI, tolerancePct: 1 });
    expect("transientMeasure average: 半波整流の平均 Vm/π で合格", r.ok, r.message);
    // ダイオードを逆向きにすると平均が負（−Vm/π）→ 不合格
    const rev = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: Vm, freqHz: 50 }), comp("D1", "D", ["out", "vin"], { Vf: 0 }),
      comp("RL", "R", ["out", "gnd"], { R: 1000 }), comp("TP1", "TP", ["out"]));
    const simRev = await simT(rev, { tStop: 0.1, diodeRs: 1e-3 });
    const rr = await run1(simRev, rev, { type: "transientMeasure", node: "out", measure: "average", fromSec: 0.02, toSec: 0.1, expected: Vm / Math.PI, tolerancePct: 1 });
    expect("半波整流: ダイオード逆向きは不合格", !rr.ok, rr.message);
    near("半波整流: ダイオード逆向きの平均は −Vm/π", meas(simRev, "out", "average", 0.02, 0.1), -Vm / Math.PI, 0.002);
  }

  // --- 半波整流（Vf=0.7、既定 Rs=1Ω）: 平均 = (1/2π)[2Vm cosθ1 − Vf(π−2θ1)]·RL/(RL+Rs)、θ1 = asin(Vf/Vm) ---
  {
    const Vm = 10, Vf = 0.7, RL = 1000;
    const b = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: Vm, freqHz: 50 }), comp("D1", "D", ["vin", "out"], { Vf }),
      comp("RL", "R", ["out", "gnd"], { R: RL }));
    const sim = await simT(b, { tStop: 0.1 });
    const th = Math.asin(Vf / Vm);
    const exact = ((2 * Vm * Math.cos(th) - Vf * (Math.PI - 2 * th)) / (2 * Math.PI)) * (RL / (RL + 1));
    near("半波整流（Vf=0.7）: 平均（導通角を考えた式）", meas(sim, "out", "average", 0.02, 0.1), exact, 0.002);
    near("半波整流（Vf=0.7）: 最大値 = (Vm − Vf)·RL/(RL+Rs)", meas(sim, "out", "max", 0.02, 0.1), (Vm - Vf) * (RL / (RL + 1)), 0.001);
  }

  // --- ブリッジ整流＋平滑コンデンサ: リプルを半解析解・教科書近似 I/(2fC) と比較 ---
  {
    const Vm = 14.142, Vf = 0.7, R = 1000, C = 1e-3, f = 50, w = 2 * Math.PI * f;
    const b = board(comp("V1", "V_AC", ["a", "b"], { Vpk: Vm, freqHz: f }),
      comp("D1", "D", ["a", "out"], { Vf }), comp("D2", "D", ["b", "out"], { Vf }),
      comp("D3", "D", ["gnd", "a"], { Vf }), comp("D4", "D", ["gnd", "b"], { Vf }),
      comp("C1", "C", ["out", "gnd"], { C }), comp("RL", "R", ["out", "gnd"], { R }), comp("TP1", "TP", ["out"]));
    const sim = await simT(b, { tStop: 0.3, diodeRs: 1e-3 });
    expect("ブリッジ整流: 解析成功", sim.ok, JSON.stringify(sim.errors));
    // 半解析解（理想ダイオード 2 個ぶん 2Vf、Rs→0）: C は |Vm sin| − 2Vf に追従し、
    // dv/dt が放電の傾き −v/RC と等しくなる角 θoff（ωRC·Vm cosθ + Vm sinθ − 2Vf = 0）で離れて指数放電、
    // 次の半周期の上り |Vm sin| − 2Vf と交わる点が最小値。
    const Vp = Vm - 2 * Vf;
    const g = (x) => w * R * C * Vm * Math.cos(x) + Vm * Math.sin(x) - 2 * Vf;
    let lo = Math.PI / 2, hi = Math.PI;
    for (let k = 0; k < 100; k++) { const m = (lo + hi) / 2; if (g(m) > 0) lo = m; else hi = m; }
    const thOff = lo, vOff = Vm * Math.sin(thOff) - 2 * Vf;
    const dec = (x) => vOff * Math.exp(-(x - thOff) / (w * R * C)); // 放電（x は角度）
    let a1 = Math.PI + 0.01, a2 = Math.PI * 1.5; // 次の半周期の上り: Vm sin(x − π) − 2Vf
    for (let k = 0; k < 100; k++) { const m = (a1 + a2) / 2; if (dec(m) > Vm * Math.sin(m - Math.PI) - 2 * Vf) a1 = m; else a2 = m; }
    const ripple = Vp - dec(a1);
    const pp = meas(sim, "out", "pp", 0.2, 0.3);
    near("ブリッジ＋C: リプル = 半解析解（指数放電と正弦波の交点）", pp, ripple, 0.01);
    const Iavg = meas(sim, "RL", "average", 0.2, 0.3, "i");
    near("ブリッジ＋C: リプル ≈ I/(2fC)（教科書の近似、10%）", pp, Iavg / (2 * f * C), 0.1);
    near("ブリッジ＋C: 最大値 = Vm − 2Vf", meas(sim, "out", "max", 0.2, 0.3), Vp, 0.002);
    const r = await run1(sim, b, { type: "transientMeasure", node: "out", measure: "pp", fromSec: 0.2, toSec: 0.3, expected: ripple, tolerancePct: 3 });
    expect("transientMeasure pp: ブリッジ整流のリプルで合格", r.ok, r.message);
    // C を 2 倍にするとリプルはほぼ半分 → 不合格
    const b2 = board(...b.components.filter((c) => c.type !== "GND").map((c) => (c.id === "C1" ? { ...c, params: { C: 2 * C } } : c)));
    const r2 = await run1(await simT(b2, { tStop: 0.3, diodeRs: 1e-3 }), b2, { type: "transientMeasure", node: "out", measure: "pp", fromSec: 0.2, toSec: 0.3, expected: ripple, tolerancePct: 3 });
    expect("transientMeasure pp: C を 2 倍にすると不合格", !r2.ok, r2.message);
  }

  // --- 理想トランス（turnsRatio = Np/Ns = 10）: 二次の実効値 = 一次/10、一次電力 = 二次電力 ---
  {
    const b = board(comp("V1", "V_AC", ["p", "gnd"], { Vpk: 141.42, freqHz: 50 }), comp("T1", "XFMR", ["p", "gnd", "s", "gnd"], { turnsRatio: 10 }),
      comp("RL", "R", ["s", "gnd"], { R: 100 }));
    const sim = await simT(b, { tStop: 0.06 });
    expect("XFMR: 過渡解析で未対応の警告が出ない", sim.ok && !(sim.warnings || []).some((w) => /未対応/.test(w)), JSON.stringify(sim.warnings));
    near("XFMR: 二次電圧の実効値 = 100V/10", meas(sim, "s", "rms", 0.02, 0.06), 10, 0.002);
    near("XFMR: 一次電流の実効値 = 二次電流/10", meas(sim, "T1", "rms", 0.02, 0.06, "i"), 0.1 / 10, 0.002);
    const pin = await run1(sim, b, { type: "transientMeasure", element: "V1", measure: "power", fromSec: 0.02, toSec: 0.06, expected: 1, tolerancePct: 0.5 });
    expect("transientMeasure power: 電源の供給電力 = 二次の負荷電力 1W", pin.ok, pin.message);
    const eta = await run1(sim, b, { type: "efficiency", inputs: ["V1"], outputs: ["RL"], fromSec: 0.02, toSec: 0.06, expected: 1, toleranceAbs: 0.002 });
    expect("efficiency: 理想トランスは η = 1", eta.ok, eta.message);
  }

  // --- 力率: V_AC に R と L の直列。PF = R/|Z| = cos φ ---
  {
    const f = 50, R = 10, L = 0.03, w = 2 * Math.PI * f;
    const b = board(comp("V1", "V_AC", ["a", "gnd"], { Vpk: 141.42, freqHz: f }), comp("R1", "R", ["a", "m"], { R }), comp("L1", "L", ["m", "gnd"], { L }));
    const sim = await simT(b, { tStop: 0.1 });
    const pf = R / Math.hypot(R, w * L);
    const r = await run1(sim, b, { type: "transientMeasure", element: "V1", measure: "powerFactor", fromSec: 0.06, toSec: 0.1, expected: pf, tolerancePct: 0.5 });
    expect(`transientMeasure powerFactor: RL 直列の力率 = ${pf.toFixed(4)}`, r.ok, r.message);
    const rR = await run1(sim, b, { type: "transientMeasure", element: "R1", measure: "powerFactor", fromSec: 0.06, toSec: 0.1, expected: 1, tolerancePct: 0.2 });
    expect("transientMeasure powerFactor: 抵抗そのものの力率は 1", rR.ok, rR.message);
  }

  // --- デューティ比: V_PULSE（幅 30%）---
  {
    const b = board(comp("V1", "V_PULSE", ["g", "gnd"], { Vlow: 0, Vhigh: 5, riseSec: 1e-9, fallSec: 1e-9, widthSec: 15e-6, periodSec: 50e-6 }), comp("R1", "R", ["g", "gnd"], { R: 1000 }));
    const sim = await simT(b, { tStop: 5e-4 });
    const r = await run1(sim, b, { type: "transientMeasure", node: "g", measure: "duty", fromSec: 1e-4, toSec: 5e-4, expected: 0.3, toleranceAbs: 0.005 });
    expect("transientMeasure duty: 幅 15µs / 周期 50µs → 0.3", r.ok, r.message);
    const r2 = await run1(sim, b, { type: "transientMeasure", node: "g", measure: "duty", threshold: 6, fromSec: 1e-4, toSec: 5e-4, expected: 0, toleranceAbs: 0.005 });
    expect("transientMeasure duty: しきい値 6V（Vhigh より上）なら 0", r2.ok, r2.message);
  }

  // --- DC-DC コンバータ（SW_V + 理想ダイオード、fsw = 20kHz）---
  const fsw = 20e3, Tsw = 1 / fsw;
  const pwm = (D, net = "g") => comp("VG", "V_PULSE", [net, "gnd"], { Vlow: 0, Vhigh: 5, riseSec: 1e-9, fallSec: 1e-9, widthSec: D * Tsw, periodSec: Tsw });
  const conv = { diodeRs: 1e-3 };
  {
    // 降圧: Vin=12, D=0.4 → Vout = 4.8V、L=500µH、C=100µF、R=5Ω
    const Vin = 12, D = 0.4, L = 500e-6, C = 100e-6, R = 5;
    const Vo = D * Vin, Io = Vo / R, dI = ((Vin - Vo) * D * Tsw) / L;
    const parts = (Dd = D, sw = ["vin", "sw", "g", "gnd"], diode = ["gnd", "sw"]) => board(
      comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }), pwm(Dd), comp("S1", "SW_V", sw, {}), comp("D1", "D", diode, { Vf: 0 }),
      comp("L1", "L", ["sw", "out"], { L, initialI: Io - dI / 2 }), comp("C1", "C", ["out", "gnd"], { C, initialV: Vo }),
      comp("RL", "R", ["out", "gnd"], { R }), comp("TP1", "TP", ["out"]));
    const b = parts();
    const t0 = Date.now();
    const sim = await simT(b, { ...conv, tStop: 9e-3 });
    const ms = Date.now() - t0;
    expect("降圧: 解析成功", sim.ok, JSON.stringify(sim.errors));
    expect(`降圧: 9ms（180 周期）の解析が 3 秒以内（${ms}ms, ${sim.transient.steps} 点）`, ms < 3000);
    const from = 8e-3, to = 9e-3;
    near("降圧: Vout = D·Vin", meas(sim, "out", "average", from, to), Vo, 0.005);
    near("降圧: インダクタ電流の平均 = Vout/R", meas(sim, "L1", "average", from, to, "i"), Io, 0.005);
    near("降圧: インダクタ電流のリプル ΔI = (Vin−Vout)·D·T/L", meas(sim, "L1", "pp", from, to, "i"), dI, 0.02);
    near("降圧: 出力リプル ΔV = ΔI/(8fC)", meas(sim, "out", "pp", from, to), dI / (8 * fsw * C), 0.05);
    near("降圧: スイッチ節点のデューティ比 = D", measureWaveform(sim.transient.time, sim.transient.nodes.sw, "duty", from, to), D, 0.01);
    const eta = await run1(sim, b, { type: "efficiency", inputs: ["V1"], outputs: ["RL"], fromSec: from, toSec: to, expected: 1, toleranceAbs: 0.005 });
    expect("efficiency: 理想に近い降圧コンバータは η ≈ 1（Ron の損失 0.1%）", eta.ok, eta.message);
    const swI = meas(sim, "S1", "average", from, to, "i");
    near("降圧: SW_V の平均電流 = D·Io（入力電流）", swI, D * Io, 0.01);
    // 誤答: スイッチの制御を反転（ctrl_p と ctrl_n の取り違え）→ 出力ほぼ 0
    const bad = parts(D, ["vin", "sw", "gnd", "g"]);
    const rb = await run1(await simT(bad, { ...conv, tStop: 9e-3 }), bad, { type: "transientMeasure", node: "out", measure: "average", fromSec: from, toSec: to, expected: Vo, tolerancePct: 2 });
    expect("降圧: SW_V の制御端子を逆につなぐと不合格", !rb.ok, rb.message);
    // 誤答: ダイオード逆向き（Vin がダイオードで短絡されないよう sw→gnd 向き）→ L の電流が流れ続けられず出力が下がる
    const badD = parts(D, undefined, ["sw", "gnd"]);
    const rd = await run1(await simT(badD, { ...conv, tStop: 9e-3 }), badD, { type: "transientMeasure", node: "out", measure: "average", fromSec: from, toSec: to, expected: Vo, tolerancePct: 2 });
    expect("降圧: 還流ダイオード逆向きは不合格", !rd.ok, rd.message);
  }
  {
    // 降圧（ダイオード Vf=0.5V の損失あり）: Vout = D·Vin − (1−D)·Vf、η = Pout / (Pout + (1−D)·Vf·Io)
    const Vin = 12, D = 0.4, Vf = 0.5, L = 500e-6, C = 100e-6, R = 5;
    const Vo = D * Vin - (1 - D) * Vf, Io = Vo / R, dI = ((Vin - Vo) * D * Tsw) / L;
    const b = board(comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }), pwm(D), comp("S1", "SW_V", ["vin", "sw", "g", "gnd"], { Ron: 1e-6 }),
      comp("D1", "D", ["gnd", "sw"], { Vf }), comp("L1", "L", ["sw", "out"], { L, initialI: Io - dI / 2 }),
      comp("C1", "C", ["out", "gnd"], { C, initialV: Vo }), comp("RL", "R", ["out", "gnd"], { R }));
    const sim = await simT(b, { ...conv, tStop: 9e-3 });
    near("降圧（Vf=0.5）: Vout = D·Vin − (1−D)·Vf", meas(sim, "out", "average", 8e-3, 9e-3), Vo, 0.005);
    const etaTh = (Vo * Io) / (Vo * Io + (1 - D) * Vf * Io);
    const eta = await run1(sim, b, { type: "efficiency", inputs: ["V1"], outputs: ["RL"], fromSec: 8e-3, toSec: 9e-3, expected: etaTh, toleranceAbs: 0.005 });
    expect(`efficiency: ダイオードの導通損失で η = ${etaTh.toFixed(4)}`, eta.ok, eta.message);
    const pd = await run1(sim, b, { type: "transientMeasure", element: "D1", measure: "power", fromSec: 8e-3, toSec: 9e-3, expected: (1 - D) * Vf * Io, tolerancePct: 2 });
    expect("transientMeasure power: ダイオードの損失 = (1−D)·Vf·Io", pd.ok, pd.message);
  }
  {
    // 昇圧: Vin=5, D=0.5 → Vout = Vin/(1−D) = 10V、Io = 0.5A、Iin = 1A、ΔV = Io·D·T/C
    const Vin = 5, D = 0.5, L = 500e-6, C = 100e-6, R = 20;
    const Vo = Vin / (1 - D), Io = Vo / R, Iin = Io / (1 - D), dI = (Vin * D * Tsw) / L;
    const b = board(comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }), pwm(D), comp("L1", "L", ["vin", "sw"], { L, initialI: Iin - dI / 2 }),
      comp("S1", "SW_V", ["sw", "gnd", "g", "gnd"], {}), comp("D1", "D", ["sw", "out"], { Vf: 0 }),
      comp("C1", "C", ["out", "gnd"], { C, initialV: Vo }), comp("RL", "R", ["out", "gnd"], { R }));
    const sim = await simT(b, { ...conv, tStop: 12e-3 });
    near("昇圧: Vout = Vin/(1−D)", meas(sim, "out", "average", 11e-3, 12e-3), Vo, 0.005);
    near("昇圧: 入力電流（L の平均）= Io/(1−D)", meas(sim, "L1", "average", 11e-3, 12e-3, "i"), Iin, 0.01);
    near("昇圧: 出力リプル ΔV = Io·D·T/C", meas(sim, "out", "pp", 11e-3, 12e-3), (Io * D * Tsw) / C, 0.03);
  }
  {
    // 昇降圧（反転）: Vin=12, D=0.4 → Vout = −D/(1−D)·Vin = −8V
    const Vin = 12, D = 0.4, L = 500e-6, C = 100e-6, R = 10;
    const Vo = (-D / (1 - D)) * Vin, Io = -Vo / R, IL = Io / (1 - D), dI = (Vin * D * Tsw) / L;
    const b = board(comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }), pwm(D), comp("S1", "SW_V", ["vin", "sw", "g", "gnd"], {}),
      comp("L1", "L", ["sw", "gnd"], { L, initialI: IL - dI / 2 }), comp("D1", "D", ["out", "sw"], { Vf: 0 }),
      comp("C1", "C", ["out", "gnd"], { C, initialV: Vo }), comp("RL", "R", ["out", "gnd"], { R }));
    const sim = await simT(b, { ...conv, tStop: 12e-3 });
    near("昇降圧: Vout = −D/(1−D)·Vin", meas(sim, "out", "average", 11e-3, 12e-3), Vo, 0.005);
  }
  {
    // フライバック（XFMR に励磁インダクタンス Lm、巻数比 n = Np/Ns = 2）:
    // CCM: Vout = Vin·D/((1−D)·n)、DCM: Vout = Vin·D·√(R·T/(2Lm))（入力エネルギー ½Lm·Ipk² が毎周期すべて出力へ）
    const Vin = 12, D = 0.4, n = 2, R = 10, C = 100e-6;
    const fly = (Lm, Vo0, i0) => board(comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }), pwm(D),
      comp("T1", "XFMR", ["vin", "sw", "sb", "sa"], { turnsRatio: n, Lm, LmInitialI: i0 }),
      comp("S1", "SW_V", ["sw", "gnd", "g", "gnd"], {}), comp("RW", "R", ["sb", "gnd"], { R: 1e-6 }),
      comp("D1", "D", ["sa", "out"], { Vf: 0 }), comp("C1", "C", ["out", "gnd"], { C, initialV: Vo0 }), comp("RL", "R", ["out", "gnd"], { R }));
    const VoC = (Vin * D) / ((1 - D) * n), LmC = 2e-3;
    const IonAvg = (VoC * VoC) / R / (Vin * D), dIC = (Vin * D * Tsw) / LmC;
    const simC = await simT(fly(LmC, VoC, IonAvg - dIC / 2), { ...conv, tStop: 10e-3 });
    near("フライバック CCM: Vout = Vin·D/((1−D)·n)", meas(simC, "out", "average", 9e-3, 10e-3), VoC, 0.005);
    near("フライバック CCM: 励磁電流のリプル = Vin·D·T/Lm", meas(simC, "T1#Lm", "pp", 9e-3, 10e-3, "i"), dIC, 0.01);
    const LmD = 200e-6, VoD = Vin * D * Math.sqrt((R * Tsw) / (2 * LmD));
    const simD = await simT(fly(LmD, VoD, 0), { ...conv, tStop: 10e-3 });
    near("フライバック DCM: Vout = Vin·D·√(R·T/(2Lm))", meas(simD, "out", "average", 9e-3, 10e-3), VoD, 0.01);
  }
  {
    // 降圧の電流不連続モード（DCM）: K = 2L/(R·T) < 1−D のとき M = 2/(1+√(1+4K/D²))
    const Vin = 12, D = 0.4, L = 20e-6, C = 100e-6, R = 50;
    const K = (2 * L) / (R * Tsw), M = 2 / (1 + Math.sqrt(1 + (4 * K) / (D * D)));
    const b = board(comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }), pwm(D), comp("S1", "SW_V", ["vin", "sw", "g", "gnd"], {}),
      comp("D1", "D", ["gnd", "sw"], { Vf: 0 }), comp("L1", "L", ["sw", "out"], { L }),
      comp("C1", "C", ["out", "gnd"], { C, initialV: M * Vin }), comp("RL", "R", ["out", "gnd"], { R }));
    const sim = await simT(b, { ...conv, tStop: 10e-3 });
    expect(`降圧 DCM: K = ${K.toFixed(3)} < 1−D`, K < 1 - D);
    near("降圧 DCM: Vout = M·Vin（M = 2/(1+√(1+4K/D²))）", meas(sim, "out", "average", 9e-3, 10e-3), M * Vin, 0.01);
    const mn = await run1(sim, b, { type: "transientMeasure", element: "L1", quantity: "i", signed: true, measure: "min", fromSec: 9e-3, toSec: 10e-3, expected: 0, toleranceAbs: 1e-3 });
    expect("降圧 DCM: インダクタ電流の最小値が 0（電流が途切れる）", mn.ok, mn.message);
    expect("降圧 DCM: ダイオードのオフ時刻をイベント細分化で求めている", sim.transient.refinedSteps > 0);
  }
  {
    // MOSFET（K=0 のスイッチモード）を PWM で駆動する降圧（ゲートはソース＝sw 基準のドライバ）
    const Vin = 12, D = 0.4, L = 500e-6, C = 100e-6, R = 5;
    const Vo = D * Vin, Io = Vo / R, dI = ((Vin - Vo) * D * Tsw) / L;
    const b = board(comp("V1", "V_DC", ["vin", "gnd"], { V: Vin }),
      comp("VG", "V_PULSE", ["g", "sw"], { Vlow: 0, Vhigh: 10, riseSec: 1e-9, fallSec: 1e-9, widthSec: D * Tsw, periodSec: Tsw }),
      comp("M1", "M_N", ["vin", "g", "sw"], { Vth: 2, K: 0, RdsOn: 0.01 }), comp("D1", "D", ["gnd", "sw"], { Vf: 0 }),
      comp("L1", "L", ["sw", "out"], { L, initialI: Io - dI / 2 }), comp("C1", "C", ["out", "gnd"], { C, initialV: Vo }), comp("RL", "R", ["out", "gnd"], { R }));
    const sim = await simT(b, { ...conv, tStop: 9e-3 });
    near("降圧（M_N K=0 を PWM 駆動）: Vout = D·Vin", meas(sim, "out", "average", 8e-3, 9e-3), Vo, 0.005);
  }
  {
    // フルブリッジ・インバータ（SW_V 4 個、invert で相補駆動）＋ RL 負荷:
    // 出力は ±Vdc の方形波（実効値 Vdc）。電流のピーク Ipk = (Vdc/R)·tanh(T/(4τ))、τ = L/R
    const Vdc = 10, R = 10, L = 5e-3, f = 1000, T = 1 / f, tau = L / R;
    const ctl = comp("VG", "V_PULSE", ["g", "gnd"], { Vlow: 0, Vhigh: 5, riseSec: 1e-9, fallSec: 1e-9, widthSec: T / 2, periodSec: T });
    const b = board(comp("V1", "V_DC", ["vdc", "gnd"], { V: Vdc }), ctl,
      comp("S1", "SW_V", ["vdc", "a", "g", "gnd"], {}), comp("S2", "SW_V", ["a", "gnd", "g", "gnd"], { invert: true }),
      comp("S3", "SW_V", ["vdc", "b", "g", "gnd"], { invert: true }), comp("S4", "SW_V", ["b", "gnd", "g", "gnd"], {}),
      comp("RL", "R", ["a", "m"], { R }), comp("LL", "L", ["m", "b"], { L }));
    const sim = await simT(b, { tStop: 10e-3 });
    const vab = sim.transient.nodes.a.map((v, k) => v - sim.transient.nodes.b[k]);
    near("フルブリッジ: 出力電圧の実効値 = Vdc（方形波）", measureWaveform(sim.transient.time, vab, "rms", 5e-3, 10e-3), Vdc, 0.002);
    near("フルブリッジ: 出力電圧の平均 = 0", measureWaveform(sim.transient.time, vab, "average", 5e-3, 10e-3), 0, 0, 0.02);
    near("フルブリッジ: RL 負荷電流のピーク = (Vdc/R)·tanh(T/4τ)", meas(sim, "LL", "max", 5e-3, 10e-3, "i"), (Vdc / R) * Math.tanh(T / (4 * tau)), 0.005);
    const pf = await run1(sim, b, { type: "transientMeasure", node: "a", nodeRef: "b", measure: "acRms", fromSec: 5e-3, toSec: 10e-3, expected: Vdc, tolerancePct: 0.5 });
    expect("transientMeasure nodeRef: フルブリッジの差動出力（交流分の実効値）", pf.ok, pf.message);
  }

  // --- サイリスタ（SCR）の位相制御整流: Vt=0 のとき Vavg = Vm/(2π)·(1 + cos α) ---
  {
    const Vm = 100, f = 50, T = 1 / f;
    const scr = (alphaDeg, pulseW = 2e-4) => board(comp("V1", "V_AC", ["a", "gnd"], { Vpk: Vm, freqHz: f }),
      comp("X1", "SCR", ["a", "gk", "out"], { Vt: 0 }),
      comp("VG", "V_PULSE", ["gp", "out"], { Vlow: 0, Vhigh: 5, delaySec: (alphaDeg / 360) * T, riseSec: 1e-6, fallSec: 1e-6, widthSec: pulseW, periodSec: T }),
      comp("RG", "R", ["gp", "gk"], { R: 100 }), comp("RL", "R", ["out", "gnd"], { R: 100 }));
    for (const deg of [30, 90, 135]) {
      const sim = await simT(scr(deg), { tStop: 0.1 });
      const a = (deg * Math.PI) / 180;
      near(`SCR 位相制御 α=${deg}°: Vavg = Vm/(2π)(1+cosα)`, meas(sim, "out", "average", 0.02, 0.1), (Vm / (2 * Math.PI)) * (1 + Math.cos(a)), 0.005);
    }
    // ラッチ: ゲートパルス（0.2ms）が終わっても半周期の終わりまで導通する。ラッチしなければ平均はパルス幅ぶんだけ（≈ 0.3V）
    const sim90 = await simT(scr(90), { tStop: 0.1 });
    const sec = sim90.transient.elements.X1;
    near("SCR: ゲートパルス後も導通（t = α + 3ms で i = Vm·sin/R）",
      interpAt(sim90.transient.time, sec.i, 0.04 + T / 4 + 3e-3), (Vm * Math.sin(Math.PI / 2 + 2 * Math.PI * f * 3e-3)) / 100, 0.01);
    near("SCR: 負の半周期は阻止（電流 0）", meas(sim90, "X1", "max", 0.04 + T / 2 + 1e-3, 0.04 + T - 1e-3, "i"), 0, 0, 1e-6);
    // 逆向き（A と K を入れ替え）では正しい平均にならない
    const rev = board(comp("V1", "V_AC", ["a", "gnd"], { Vpk: Vm, freqHz: f }), comp("X1", "SCR", ["out", "gk", "a"], { Vt: 0 }),
      comp("VG", "V_PULSE", ["gp", "a"], { Vlow: 0, Vhigh: 5, delaySec: T / 4, riseSec: 1e-6, fallSec: 1e-6, widthSec: 2e-4, periodSec: T }),
      comp("RG", "R", ["gp", "gk"], { R: 100 }), comp("RL", "R", ["out", "gnd"], { R: 100 }));
    near("SCR 逆向き: 平均が正にならない（ゲートが別の端子基準になり点弧しても負の半周期）", Math.max(meas(await simT(rev, { tStop: 0.1 }), "out", "average", 0.02, 0.1), 0), 0, 0, 0.5);
  }

  // --- TRIAC の交流位相制御（半周期ごとにゲートパルス）: Vrms = (Vm/√2)·√(1 − α/π + sin2α/(2π)) ---
  {
    const Vm = 100, f = 50, T = 1 / f;
    for (const deg of [60, 90]) {
      const b = board(comp("V1", "V_AC", ["a", "gnd"], { Vpk: Vm, freqHz: f }), comp("X1", "TRIAC", ["a", "gt", "out"], { Vt: 0 }),
        comp("VG", "V_PULSE", ["gp", "out"], { Vlow: 0, Vhigh: 5, delaySec: (deg / 360) * T, riseSec: 1e-6, fallSec: 1e-6, widthSec: 2e-4, periodSec: T / 2 }),
        comp("RG", "R", ["gp", "gt"], { R: 100 }), comp("RL", "R", ["out", "gnd"], { R: 100 }));
      const sim = await simT(b, { tStop: 0.1 });
      const a = (deg * Math.PI) / 180;
      near(`TRIAC α=${deg}°: 負荷電圧の実効値`, meas(sim, "out", "rms", 0.02, 0.1), (Vm / Math.SQRT2) * Math.sqrt(1 - a / Math.PI + Math.sin(2 * a) / (2 * Math.PI)), 0.005);
      near(`TRIAC α=${deg}°: 平均は 0（両方向に導通）`, meas(sim, "out", "average", 0.02, 0.1), 0, 0, 0.05);
    }
  }

  // --- DIAC: |V| ≥ Vbo で導通し Vbo − dV にブレークバック、電流が Ih を下回ると消弧 ---
  {
    // C（初期 0V）を 1mA の定電流で充電 → 30V で DIAC が導通して R に放電 → 鋸歯状波（弛張発振）
    const b = board(comp("I1", "I_DC", ["c", "gnd"], { I: 1e-3 }), comp("C1", "C", ["c", "gnd"], { C: 1e-6 }),
      comp("X1", "DIAC", ["c", "k"], { Vbo: 30, dV: 5 }), comp("R1", "R", ["k", "gnd"], { R: 10 }));
    const sim = await simT(b, { tStop: 0.1 });
    near("DIAC: コンデンサ電圧の最大値 = Vbo", meas(sim, "c", "max", 0, 0.1), 30, 0.005);
    // 導通中は C が DIAC（Vbo − dV = 25V）と R を通して放電し、電流 (Vc − 25)/R が Ih = 5mA を下回る
    // Vc = 25 + Ih·R = 25.05V で消弧 → 振れ幅 = dV − Ih·R = 4.95V
    near("DIAC: 鋸歯状波の振れ幅 = dV − Ih·R（ブレークバックで放電して消弧）", meas(sim, "c", "pp", 0.04, 0.1), 5 - 0.005 * 10, 0.005);
    near("DIAC: 最小値 = Vbo − dV + Ih·R", meas(sim, "c", "min", 0.04, 0.1), 25.05, 0.002);
  }

  // --- クローバ回路（DC）: 出力が ZD の Vz + Vgk を超えると SCR が点弧して出力を短絡し、点弧後も保持 ---
  {
    const crow = (vin) => board(comp("V1", "V_DC", ["vin", "gnd"], { V: vin }), comp("RS", "R", ["vin", "out"], { R: 10 }),
      comp("Z1", "ZD", ["zk", "out"], { Vz: 12 }), comp("RG", "R", ["zk", "g"], { R: 100 }), comp("RGK", "R", ["g", "gnd"], { R: 1000 }),
      comp("X1", "SCR", ["out", "g", "gnd"], {}), comp("RL", "R", ["out", "gnd"], { R: 100 }));
    const hiV = await check(crow(15), "dc", { type: "operatingRegion", element: "X1", region: "on" });
    expect("クローバ: 15V（過電圧）で SCR がオン", hiV.ok, hiV.message);
    const hiOut = await check(crow(15), "dc", { type: "dcVoltage", node: "out", expected: 1.0, toleranceAbs: 0.05 });
    expect("クローバ: 点弧後の出力 ≈ Vt = 1V（ゲート電流が消えても保持）", hiOut.ok, hiOut.message);
    const loV = await check(crow(11), "dc", { type: "dcVoltage", node: "out", expected: 10, tolerancePct: 0.1 });
    expect("クローバ: 11V では SCR オフ、出力 = 11·100/110 = 10V", loV.ok, loV.message);
  }

  // --- SW_V の DC: 制御 5V（> Vth）で閉、invert で開 ---
  {
    const sw = (invert) => board(comp("V1", "V_DC", ["vin", "gnd"], { V: 10 }), comp("VC", "V_DC", ["c", "gnd"], { V: 5 }),
      comp("S1", "SW_V", ["vin", "out", "c", "gnd"], { invert }), comp("R1", "R", ["out", "gnd"], { R: 1000 }));
    const on = await check(sw(false), "dc", { type: "dcVoltage", node: "out", expected: 10, tolerancePct: 0.01 });
    expect("SW_V DC: 制御 5V > Vth で閉（out = 10V）", on.ok, on.message);
    const off = await check(sw(true), "dc", { type: "dcVoltage", node: "out", expected: 0, toleranceAbs: 1e-3 });
    expect("SW_V DC: invert なら開（out = 0V）", off.ok, off.message);
    const reg = await check(sw(false), "dc", { type: "operatingRegion", element: "S1", region: "on" });
    expect("SW_V: operatingRegion on", reg.ok, reg.message);
  }

  // --- validation: 新しい measure / efficiency / simulation.diodeRs ---
  {
    const base = { id: "X-01", category: "X", title: "t", statement: "s", judge: "transient",
      fixedComponents: [{ id: "V1", type: "V_DC", params: { V: 5 }, connect: ["vin", "gnd"], locked: true }, { id: "RL", type: "R", params: { R: 10 }, connect: ["vin", "gnd"], locked: true }] };
    const v1 = validateProblem({ ...base, checks: [{ type: "transientMeasure", node: "vin", measure: "power", fromSec: 0, expected: 1 }] }, vopts);
    expect("validation: measure power に element が無いとエラー", v1.errors.some((e) => /element/.test(e)), JSON.stringify(v1.errors));
    const v2 = validateProblem({ ...base, checks: [{ type: "efficiency", inputs: [], outputs: ["RL"], fromSec: 0, expected: 0.9 }] }, vopts);
    expect("validation: efficiency の inputs が空だとエラー", v2.errors.some((e) => /inputs/.test(e)), JSON.stringify(v2.errors));
    const v3 = validateProblem({ ...base, checks: [{ type: "efficiency", inputs: ["V1"], outputs: [{ type: "R" }], fromSec: 0, expected: 0.9 }] }, vopts);
    expect("validation: efficiency（ID と match）は正しい", v3.errors.length === 0, JSON.stringify(v3.errors));
    const v4 = validateProblem({ ...base, simulation: { diodeRs: -1 }, checks: [{ type: "transientMeasure", node: "vin", measure: "duty", threshold: 2.5, fromSec: 0, expected: 1 }] }, vopts);
    expect("validation: simulation.diodeRs が負ならエラー", v4.errors.some((e) => /diodeRs/.test(e)), JSON.stringify(v4.errors));
    const v5 = validateProblem({ ...base, checks: [{ type: "transientMeasure", node: "vin", measure: "duty", threshold: "x", fromSec: 0, expected: 1 }] }, vopts);
    expect("validation: threshold が数値でないとエラー", v5.errors.some((e) => /threshold/.test(e)), JSON.stringify(v5.errors));
  }
}

/* ---------------------------------------------------------------- verify.mjs: 分野F/J（過渡のダイオード回路・スイッチ回路の誤答） */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-fj-"));
  fs.mkdirSync(path.join(dir, "J"));
  const common = { category: "J", title: "t", statement: "s", judge: "transient", hints: ["a", "b", "c"],
    explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" } };
  const Tsw = 50e-6;
  // J-01: 降圧コンバータ。プレイヤーが SW_V・D・L を置く（PWM・C・負荷・入力は固定）
  const buck = { ...common, id: "J-01", simulation: { tStop: 9e-3, diodeRs: 1e-3 },
    fixedComponents: [
      { id: "V1", type: "V_DC", params: { V: 12 }, connect: ["vin", "gnd"], locked: true },
      { id: "VG", type: "V_PULSE", params: { Vlow: 0, Vhigh: 5, riseSec: 1e-9, fallSec: 1e-9, widthSec: 0.4 * Tsw, periodSec: Tsw }, connect: ["g", "gnd"], locked: true },
      { id: "C1", type: "C", params: { C: 100e-6, initialV: 4.8 }, connect: ["out", "gnd"], locked: true },
      { id: "RL", type: "R", params: { R: 5 }, connect: ["out", "gnd"], locked: true },
      { id: "TPS", type: "TP", connect: ["sw"], locked: true },
    ],
    referenceSolution: [
      { id: "SWV1", type: "SW_V", params: { Ron: 0.01, Roff: 1e9, Vth: 2.5, invert: false }, connect: ["vin", "sw", "g", "gnd"] },
      { id: "D1", type: "D", params: { Vf: 0 }, connect: ["gnd", "sw"] },
      { id: "L1", type: "L", params: { L: 500e-6, initialI: 0.816 }, connect: ["sw", "out"] },
    ],
    checks: [
      { type: "transientMeasure", node: "out", measure: "average", fromSec: 8e-3, toSec: 9e-3, expected: 4.8, tolerancePct: 2 },
      { type: "transientMeasure", node: "out", measure: "pp", fromSec: 8e-3, toSec: 9e-3, expected: 0.018, tolerancePct: 20 },
      { type: "efficiency", inputs: ["V1"], outputs: ["RL"], fromSec: 8e-3, toSec: 9e-3, expected: 0.999, toleranceAbs: 0.01 },
    ] };
  buck.fixedComponents.push({ id: "TPO", type: "TP", connect: ["out"], locked: true });
  // J-02: ブリッジ整流＋平滑。プレイヤーが D を 4 個置く
  const bridge = { ...common, id: "J-02", simulation: { tStop: 0.2 },
    fixedComponents: [
      { id: "V1", type: "V_AC", params: { Vpk: 14.142, freqHz: 50 }, connect: ["a", "b"], locked: true },
      { id: "C1", type: "C", params: { C: 1e-3 }, connect: ["out", "gnd"], locked: true },
      { id: "RL", type: "R", params: { R: 1000 }, connect: ["out", "gnd"], locked: true },
      { id: "TPO", type: "TP", connect: ["out"], locked: true },
    ],
    referenceSolution: [
      { id: "D1", type: "D", params: { Vf: 0.7 }, connect: ["a", "out"] },
      { id: "D2", type: "D", params: { Vf: 0.7 }, connect: ["b", "out"] },
      { id: "D3", type: "D", params: { Vf: 0.7 }, connect: ["gnd", "a"] },
      { id: "D4", type: "D", params: { Vf: 0.7 }, connect: ["gnd", "b"] },
    ],
    checks: [
      { type: "transientMeasure", node: "out", measure: "average", fromSec: 0.1, toSec: 0.2, expected: 12.36, tolerancePct: 2 },
      { type: "transientMeasure", node: "out", measure: "pp", fromSec: 0.1, toSec: 0.2, expected: 0.11, tolerancePct: 15 },
    ] };
  fs.writeFileSync(path.join(dir, "J", "J-01.json"), JSON.stringify(buck));
  fs.writeFileSync(path.join(dir, "J", "J-02.json"), JSON.stringify(bridge));
  fs.writeFileSync(path.join(dir, "J", "index.json"), JSON.stringify({ problems: [{ id: "J-01", title: "t" }, { id: "J-02", title: "t" }] }));
  const run = (...a) => {
    try {
      return { code: 0, out: execFileSync("node", [path.join(ROOT, "tools/verify.mjs"), `--problems=${dir}`, ...a], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const ref = run();
  expect("verify F/J: 降圧・ブリッジ整流の参照解が合格", ref.code === 0 && /参照解が合格 2 問/.test(ref.out), ref.out);
  const rev = run("--reverse");
  expect("verify F/J --reverse: ダイオード逆向き・SW_V の制御端子の取り違えはすべて不合格", rev.code === 0 && /誤答がすべて不合格 2 問/.test(rev.out), rev.out);
  const mut = run("--mutate");
  expect("verify F/J --mutate: L・Vf の2倍は不合格、SW_V の Ron/Roff/Vth は2倍にしない（invert の反転だけ）", mut.code === 0 && /誤答がすべて不合格 2 問/.test(mut.out), mut.out);
  const drop = run("--drop");
  expect("verify F/J --drop: 部品を外すとすべて不合格", drop.code === 0 && /誤答がすべて不合格 2 問/.test(drop.out), drop.out);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- 分野D（発振）: 過渡で発振が立ち上がるか・周波数・振幅、バルクハウゼン条件（AC） */
// 許容誤差の根拠（分野D）:
// - LC 発振（無損失）: 刻み T/100 の台形則の位相誤差 (ωh)²/12 ≈ 3.3e-4 → 周波数は 0.1%。台形則は振幅を保存するが、
//   t=0 直後 2 ステップの後退オイラーで (ωh)²/2 ≈ 0.2% ずつ減衰する → 振幅は 0.6%。
// - 弛張発振（シュミット・CMOS インバータ・555）: 切り替わりの時刻は刻みを 1/64 まで二分して求める → 1 回の切り替わりの
//   誤差 ≤ 刻み/64（ここでは周期の 0.03% 程度）。周期は 0.5%、デューティは ±0.01。
// - 正弦波発振（ウィーン・移相・コルピッツ・ピアース）: 振幅が飽和・ダイオードで制限されるときのひずみで周波数が
//   1〜3% ずれる（物理的なずれで数値誤差ではない）→ 3〜5%。位相条件の周波数そのものは AC の loopGain で 0.1% 以内。
// - loopGain（AC）: 複素 MNA を直接解き、位相 0° の周波数を二分法で 1e-12 まで絞る。Aol = 1e5 の有限利得の影響が 1e-4 程度 → 0.1%。
{
  // LC タンク（無損失）を L の初期電流で起動: f = 1/(2π√(LC)) = 1591.55Hz、振幅 = I0·√(L/C) = 1V
  const b = board(comp("L1", "L", ["a", "gnd"], { L: 0.01, initialI: 0.01 }), comp("C1", "C", ["a", "gnd"], { C: 1e-6 }), comp("TP", "TP", ["a"]));
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.02 } } });
  const run1 = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  const f = await run1({ type: "oscillationFrequency", node: "a", fromSec: 0.002, toSec: 0.02, expected: 1591.55, tolerancePct: 0.1 });
  expect("D: LC タンク（L の initialI で起動）の周波数 1/(2π√LC)（oscillationFrequency + toSec）", f.ok, f.message);
  const pp = await run1({ type: "transientMeasure", node: "a", measure: "pp", fromSec: 0.018, toSec: 0.02, expected: 2, tolerancePct: 0.6 });
  expect("D: 無損失 LC の振幅が台形則で減衰しない（pp = 2·I0·√(L/C)）", pp.ok, pp.message);
  const fm = await run1({ type: "transientMeasure", node: "a", measure: "frequency", fromSec: 0.002, toSec: 0.02, expected: 1591.55, tolerancePct: 0.1 });
  expect("D: transientMeasure frequency（平均値の上向き交差）", fm.ok, fm.message);
  const per = await run1({ type: "transientMeasure", node: "a", measure: "period", fromSec: 0.002, toSec: 0.02, expected: 1 / 1591.55, tolerancePct: 0.1 });
  expect("D: transientMeasure period", per.ok, per.message);
  const rng = await run1({ type: "transientMeasure", node: "a", measure: "pp", fromSec: 0.018, toSec: 0.02, expectedMin: 1.5 });
  expect("D: expectedMin（範囲判定）: 振幅 1.5V 以上で合格", rng.ok, rng.message);
  const rng2 = await run1({ type: "transientMeasure", node: "a", measure: "pp", fromSec: 0.018, toSec: 0.02, expectedMin: 2.5 });
  expect("D: expectedMin（範囲判定）: 2.5V 以上は不合格", !rng2.ok && /範囲外/.test(rng2.message), rng2.message);
  const none = await runSingleCheck({ type: "transientMeasure", node: "a", measure: "frequency", fromSec: 0.002, toSec: 0.02, expected: 1591.55 },
    { simulationResult: await simulate(board(comp("V1", "V_DC", ["a", "gnd"], { V: 1 })), { mode: "transient", checks: [] }), circuit: b });
  expect("D: 振動しない波形の frequency は不合格（理由つき）", !none.ok && /振動していません/.test(none.message), none.message);
}
{
  // ウィーンブリッジ（OPAMP ±12V、R = 10k, C = 10nF → f0 = 1/(2πRC) = 1591.5Hz）。増幅率 1 + 28k/10k = 3.8（小振幅）、
  // 振幅が大きくなると逆並列ダイオードが 10k を短絡して 1 + 18k/10k = 2.8 → 振幅が電源より小さいところで安定する。
  // 起動: C2 の initialV = 10mV（理想オペアンプはオフセットが無いので種が無いと発振しない）
  const wien = (Rb) => board(
    comp("U1", "OPAMP", ["p", "n", "out", "", ""], { Vpos: 12, Vneg: -12, GBP: 0 }),
    comp("Ra", "R", ["out", "m"], { R: 18000 }), comp("Rb", "R", ["m", "n"], { R: Rb }),
    comp("D1", "D", ["m", "n"], { Vf: 0.6 }), comp("D2", "D", ["n", "m"], { Vf: 0.6 }),
    comp("Rg", "R", ["n", "gnd"], { R: 10000 }),
    comp("R1", "R", ["out", "x"], { R: 10000 }), comp("C1", "C", ["x", "p"], { C: 1e-8 }),
    comp("R2", "R", ["p", "gnd"], { R: 10000 }), comp("C2", "C", ["p", "gnd"], { C: 1e-8, initialV: 0.01 }),
    comp("TP", "TP", ["out"]));
  const good = wien(10000);
  const sim = await simulate(good, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.03 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: good });
  const f = await r({ type: "oscillationFrequency", node: "out", fromSec: 0.02, toSec: 0.03, expected: 1591.5, tolerancePct: 1 });
  expect("D: ウィーンブリッジ（ダイオード振幅安定化）が 1/(2πRC) で発振する", f.ok, f.message);
  const amp = await r({ type: "transientMeasure", node: "out", measure: "max", fromSec: 0.02, toSec: 0.03, expectedMin: 5, expectedMax: 11.9 });
  expect("D: ウィーンブリッジの振幅がダイオードで電源（12V）より小さく安定する", amp.ok, amp.message);
  const early = await r({ type: "transientMeasure", node: "out", measure: "pp", fromSec: 0, toSec: 0.0003, expectedMax: 0.5 });
  expect("D: 発振は種（10mV）から成長する（起動直後は小さい）", early.ok, early.message);
  // 利得不足（小振幅でも 1 + 18k/10k = 2.8 < 3）: 発振しない
  const bad = board(
    comp("U1", "OPAMP", ["p", "n", "out", "", ""], { Vpos: 12, Vneg: -12, GBP: 0 }),
    comp("Rf", "R", ["out", "n"], { R: 18000 }), comp("Rg", "R", ["n", "gnd"], { R: 10000 }),
    comp("R1", "R", ["out", "x"], { R: 10000 }), comp("C1", "C", ["x", "p"], { C: 1e-8 }),
    comp("R2", "R", ["p", "gnd"], { R: 10000 }), comp("C2", "C", ["p", "gnd"], { C: 1e-8, initialV: 0.01 }),
    comp("TP", "TP", ["out"]));
  const nb = await check(bad, "transient", { type: "transientMeasure", node: "out", measure: "pp", fromSec: 0.02, toSec: 0.03, expectedMin: 1 }, {}, { simulation: { tStop: 0.03 } });
  expect("D: 利得 2.8（< 3）のウィーンブリッジは減衰して不合格", !nb.ok, nb.message);
}
{
  // バルクハウゼン条件（AC）: ウィーンブリッジのループを OPAMP の + 入力で切る（入力インピーダンス無限大の点）。
  // T = (1 + Rf/Rg)·(1/3) at f0 = 1/(2πRC)。Rf = 22k → |T| = 3.2/3 = 1.0667
  const open = (Rf, C2 = 1e-8) => board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: 1000 }),
    comp("U1", "OPAMP", ["vin", "n", "out", "", ""], { GBP: 0 }),
    comp("Rf", "R", ["out", "n"], { R: Rf }), comp("Rg", "R", ["n", "gnd"], { R: 10000 }),
    comp("R1", "R", ["out", "x"], { R: 10000 }), comp("C1", "C", ["x", "fb"], { C: 1e-8 }),
    comp("R2", "R", ["fb", "gnd"], { R: 10000 }), comp("C2", "C", ["fb", "gnd"], { C: C2 }), comp("TP", "TP", ["fb"]));
  const lg = { type: "loopGain", input: "vin", output: "fb", fMinHz: 100, fMaxHz: 100000, expectedFrequencyHz: 1591.549, tolerancePct: 0.1, gainMin: 1.0, gainMax: 1.2 };
  const ok = await check(open(22000), "ac", lg);
  expect("D: loopGain ウィーン: 位相 0° の周波数 = 1/(2πRC)、|T| = 3.2/3", ok.ok && Math.abs(ok.actual.gain - 3.2 / 3) < 1e-3 * 3.2 / 3, ok.message);
  const low = await check(open(18000), "ac", lg);
  expect("D: loopGain: |T| = 2.8/3 < 1 は不合格（振幅条件）", !low.ok && Math.abs(low.actual.gain - 2.8 / 3) < 1e-3, low.message);
  // C2 を 2 倍: f = 1/(2πRC√2)、|T| = 3.2·√2/(1+... ) → 周波数が違うので不合格
  const wrongC = await check(open(22000, 2e-8), "ac", lg);
  expect("D: loopGain: C を変えると位相 0° の周波数がずれて不合格", !wrongC.ok && Math.abs(wrongC.actual.frequencyHz / (1591.549 / Math.SQRT2) - 1) < 1e-3, wrongC.message);
  // 移相発振（C-R 3 段＋反転増幅）: 帰還を OPAMP の出力で切る（出力インピーダンス 0 の点）。
  // f = 1/(2πRC√6) = 649.75Hz、必要な利得 Rf/R = 29 → |T| = 1
  const R = 10000;
  const C = 1e-8;
  const ps = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: 1000 }),
    comp("C1", "C", ["vin", "a"], { C }), comp("R1", "R", ["a", "gnd"], { R }),
    comp("C2", "C", ["a", "b"], { C }), comp("R2", "R", ["b", "gnd"], { R }),
    comp("C3", "C", ["b", "c"], { C }), comp("R3", "R", ["c", "n"], { R }),
    comp("U1", "OPAMP", ["gnd", "n", "out", "", ""], { GBP: 0 }),
    comp("Rf", "R", ["out", "n"], { R: 29 * R }), comp("TP", "TP", ["out"]));
  const f0 = 1 / (2 * Math.PI * R * C * Math.sqrt(6));
  const p = await check(ps, "ac", { type: "loopGain", input: "vin", output: "out", fMinHz: 10, fMaxHz: 100000, expectedFrequencyHz: f0, tolerancePct: 0.1, gainMin: 0.998, gainMax: 1.002 });
  expect("D: loopGain 移相発振: f = 1/(2πRC√6)、Rf/R = 29 で |T| = 1", p.ok, p.message);
  // 閉ループ（過渡）: Rf/R = 29 ちょうどなら振幅が保たれ、周波数は f0（線形のまま）
  const psc = board(comp("U1", "OPAMP", ["gnd", "n", "out", "", ""], { Vpos: 12, Vneg: -12, GBP: 0 }),
    comp("C1", "C", ["out", "a"], { C, initialV: 0.1 }), comp("R1", "R", ["a", "gnd"], { R }),
    comp("C2", "C", ["a", "b"], { C }), comp("R2", "R", ["b", "gnd"], { R }),
    comp("C3", "C", ["b", "c"], { C }), comp("R3", "R", ["c", "n"], { R }),
    comp("Rf", "R", ["out", "n"], { R: 29 * R }), comp("TP", "TP", ["out"]));
  const pc = await check(psc, "transient", { type: "oscillationFrequency", node: "out", fromSec: 0.01, toSec: 0.03, expected: f0, tolerancePct: 0.2 }, {}, { simulation: { tStop: 0.03 } });
  expect("D: 移相発振（過渡、Rf/R = 29）の周波数 = 1/(2πRC√6)", pc.ok, pc.message);
  const nofb = await check(ps, "ac", { type: "loopGain", input: "vin", output: "a", fMinHz: 10, fMaxHz: 100000, gainMin: 1 });
  expect("D: loopGain: 位相 0° にならない（CR 1 段）は「位相条件を満たさない」で不合格", !nofb.ok && /位相条件/.test(nofb.message), nofb.message);
}
{
  // シュミットトリガ型の弛張発振（OPAMP ±12V、正帰還 R1 = R2 → β = 1/2、RC = 1ms）: T = 2RC·ln((1+β)/(1−β)) = 2RC·ln3
  const b = board(comp("U1", "OPAMP", ["p", "n", "out", "", ""], { Vpos: 12, Vneg: -12 }),
    comp("R1", "R", ["out", "p"], { R: 10000 }), comp("R2", "R", ["p", "gnd"], { R: 10000 }),
    comp("R", "R", ["out", "n"], { R: 10000 }), comp("C", "C", ["n", "gnd"], { C: 1e-7 }), comp("TP", "TP", ["out"]));
  const T = 2e-3 * Math.log(3);
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.02 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  near("D: 弛張発振（シュミット）の周期 2RC·ln3", (await r({ type: "transientMeasure", node: "out", measure: "period", fromSec: 0.005, toSec: 0.02, expected: T })).actual, T, 0.005);
  near("D: 弛張発振のデューティ 0.5", (await r({ type: "transientMeasure", node: "out", measure: "duty", fromSec: 0.005, toSec: 0.005 + 4 * T, expected: 0.5 })).actual, 0.5, 0, 0.01);
  near("D: 弛張発振のコンデンサ電圧の振れ = 2·β·12V", (await r({ type: "transientMeasure", node: "n", measure: "pp", fromSec: 0.005, toSec: 0.02, expected: 12 })).actual, 12, 0.005);
}
{
  // CMOS インバータ 2 個の無安定マルチ（理想ゲート: VOH = 5V、しきい値 2.5V、入力電流 0、保護ダイオードなし）:
  // T = 2RC·ln3、C 側の入力 a は 2.5 + 5 = 7.5V まで振れる
  const R = 10000;
  const C = 1e-7;
  const b = board(comp("U1", "U_NOT", ["a", "bq"]), comp("U2", "U_NOT", ["bq", "y"]),
    comp("R1", "R", ["a", "bq"], { R }), comp("C1", "C", ["y", "a"], { C }), comp("TP", "TP", ["y"]));
  const T = 2 * R * C * Math.log(3);
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.02 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  expect("D: 過渡解析の論理ゲート: 出力が gnd 基準の電圧源なので浮いたネットにならない", !(sim.warnings || []).some((w) => /gnd/.test(w)) && sim.ok, JSON.stringify(sim.warnings));
  near("D: CMOS インバータ無安定マルチの周期 2RC·ln3", (await r({ type: "transientMeasure", node: "y", measure: "period", fromSec: 0.005, toSec: 0.02, expected: T })).actual, T, 0.005);
  near("D: インバータ無安定マルチの入力の最大 = 1.5·VDD", (await r({ type: "transientMeasure", node: "a", measure: "max", fromSec: 0.005, toSec: 0.02, expected: 7.5 })).actual, 7.5, 0.01);
  expect("D: インバータ無安定マルチで反復が収束する（ゲートは 1 刻みに 1 回だけ切り替わる）", !(sim.warnings || []).some((w) => /収束/.test(w)), JSON.stringify(sim.warnings));
  // シュミット入力のインバータ 1 個（hyst = 1V → VT+ = 3V、VT− = 2V）: T = RC·ln((5−2)/(5−3)) + RC·ln(3/2) = 2RC·ln1.5
  const s = board(comp("U1", "U_NOT", ["a", "y"], { hyst: 1 }), comp("R1", "R", ["y", "a"], { R }), comp("C1", "C", ["a", "gnd"], { C }), comp("TP", "TP", ["y"]));
  const Ts = 2 * R * C * Math.log(1.5);
  const ss = await check(s, "transient", { type: "transientMeasure", node: "y", measure: "period", fromSec: 0.005, toSec: 0.02, expected: Ts, tolerancePct: 0.5 }, {}, { simulation: { tStop: 0.02 } });
  expect("D: シュミットインバータ 1 個の RC 発振 T = 2RC·ln1.5", ss.ok, ss.message);
}
{
  // 555 相当（部品で組む）: 5k×3 の分圧（2/3·VCC, 1/3·VCC）、コンパレータ 2 個（OPAMP、電源ピン VCC/gnd）、NOR の SR ラッチ、
  // 放電スイッチ（SW_V、Q が Low で閉）。T = ln2·(RA + 2RB)·C、デューティ = (RA + RB)/(RA + 2RB)
  const RA = 1000;
  const RB = 10000;
  const C = 1e-7;
  const b = board(comp("V1", "V_DC", ["vcc", "gnd"], { V: 5 }),
    comp("Rd1", "R", ["vcc", "r2"], { R: 5000 }), comp("Rd2", "R", ["r2", "r1"], { R: 5000 }), comp("Rd3", "R", ["r1", "gnd"], { R: 5000 }),
    comp("CMP1", "OPAMP", ["cap", "r2", "rr", "vcc", "gnd"]), comp("CMP2", "OPAMP", ["r1", "cap", "ss", "vcc", "gnd"]),
    comp("N1", "U_NOR", ["rr", "qn", "q"]), comp("N2", "U_NOR", ["ss", "q", "qn"]),
    comp("SW", "SW_V", ["dis", "gnd", "q", "gnd"], { invert: true }),
    comp("RA", "R", ["vcc", "dis"], { R: RA }), comp("RB", "R", ["dis", "cap"], { R: RB }), comp("C1", "C", ["cap", "gnd"], { C }),
    comp("TP", "TP", ["q"]));
  const T = Math.log(2) * (RA + 2 * RB) * C;
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.03 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  near("D: 555 相当（コンパレータ＋NOR ラッチ）の周期 ln2·(RA+2RB)·C", (await r({ type: "transientMeasure", node: "q", measure: "period", fromSec: 0.005, toSec: 0.03, expected: T })).actual, T, 0.005);
  near("D: 555 相当のデューティ (RA+RB)/(RA+2RB)", (await r({ type: "transientMeasure", node: "q", measure: "duty", fromSec: 0.005, toSec: 0.005 + 10 * T, expected: 0.5 })).actual, (RA + RB) / (RA + 2 * RB), 0, 0.005);
  near("D: 555 相当のコンデンサ電圧の上限 2/3·VCC", (await r({ type: "transientMeasure", node: "cap", measure: "max", fromSec: 0.005, toSec: 0.03, expected: 1 })).actual, 10 / 3, 0.005);
  near("D: 555 相当のコンデンサ電圧の下限 1/3·VCC", (await r({ type: "transientMeasure", node: "cap", measure: "min", fromSec: 0.005, toSec: 0.03, expected: 1 })).actual, 5 / 3, 0.005);
}
{
  // コルピッツ（MOSFET ソース接地、L = 1mH、C1 = C2 = 20nF → f = 1/(2π√(L·C1C2/(C1+C2))) = 50.33kHz）。
  // DC 動作点から始め、L の initialI（明示した初期値は initialCondition: "dc" でも優先）で起動
  const L = 1e-3;
  const b = board(comp("V1", "V_DC", ["vcc", "gnd"], { V: 12 }),
    comp("RG1", "R", ["vcc", "g"], { R: 200000 }), comp("RG2", "R", ["g", "gnd"], { R: 100000 }),
    comp("RS", "R", ["s", "gnd"], { R: 1000 }), comp("CS", "C", ["s", "gnd"], { C: 1e-5 }),
    comp("RD", "R", ["vcc", "d"], { R: 2000 }), comp("M1", "M_N", ["d", "g", "s"], { Vth: 2, K: 0.01 }),
    comp("CC", "C", ["d", "t"], { C: 1e-6 }), comp("L1", "L", ["t", "bb"], { L, initialI: 0.001 }),
    comp("C1", "C", ["t", "gnd"], { C: 2e-8 }), comp("C2", "C", ["bb", "gnd"], { C: 2e-8 }),
    comp("CB", "C", ["bb", "g"], { C: 1e-6 }), comp("TP", "TP", ["t"]));
  const f0 = 1 / (2 * Math.PI * Math.sqrt(L * 1e-8));
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.003, initialCondition: "dc" } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  const f = await r({ type: "oscillationFrequency", node: "t", fromSec: 0.002, toSec: 0.003, expected: f0, tolerancePct: 3 });
  expect("D: コルピッツ（MOSFET）が 1/(2π√(L·C1C2/(C1+C2))) 付近で発振する（3%: 飽和によるずれ）", f.ok, f.message);
  const a = await r({ type: "transientMeasure", node: "t", measure: "pp", fromSec: 0.002, toSec: 0.003, expectedMin: 5 });
  expect("D: コルピッツの振幅が成長して飽和で安定する", a.ok, a.message);
}
{
  // 水晶振動子 XTAL（既定: Lm = 0.1H, Cm = 25.33pF → fs = 100kHz、Rm = 100Ω、Cp = 1nF → fp = fs·√(1+Cm/Cp)）
  const Lm = 0.1;
  const Cm = 2.533029591e-11;
  const Rm = 100;
  const Cp = 1e-9;
  const fs = 1 / (2 * Math.PI * Math.sqrt(Lm * Cm));
  const fp = fs * Math.sqrt(1 + Cm / Cp);
  const b = board(comp("V1", "V_AC", ["vin", "gnd"], { Vpk: 1, freqHz: 1e5 }), comp("R1", "R", ["vin", "x"], { R: 1000 }),
    comp("X1", "XTAL", ["x", "gnd"]), comp("TP", "TP", ["x"]));
  // fs では Lm と Cm が打ち消し、Z = Rm ∥ (1/jωCp) → |Z| = Rm/√(1+(ωCpRm)²)
  const zfs = Rm / Math.sqrt(1 + (2 * Math.PI * fs * Cp * Rm) ** 2);
  const z1 = await check(b, "ac", { type: "acImpedance", node: "x", exclude: ["V1", "R1"], frequencyHz: fs, expected: zfs, tolerancePct: 0.01 });
  expect("D: XTAL の fs でのインピーダンス = Rm ∥ Cp（最小）", z1.ok, z1.message);
  const z2 = await check(b, "ac", { type: "acImpedance", node: "x", exclude: ["V1", "R1"], frequencyHz: fp, expected: 1, tolerancePct: 1 });
  expect("D: XTAL の fp でのインピーダンスは fs の 100 倍以上（反共振）", z2.actual > 100 * zfs, z2.message);
  // 0.9·fs では直列枝のリアクタンス ωLm − 1/(ωCm) = −(1 − 0.81)/(ωCm) → 容量 Cm/0.19 と Cp の並列（Rm は無視できる）
  const z3 = await check(b, "ac", { type: "acImpedance", node: "x", exclude: ["V1", "R1"], frequencyHz: 0.9 * fs, expected: 1 / (2 * Math.PI * 0.9 * fs * (Cp + Cm / 0.19)), tolerancePct: 0.5 });
  expect("D: XTAL の fs より下は容量性（Cp と直列枝の合成）", z3.ok, z3.message);
  const lg = await check(b, "ac", { type: "loopGain", input: "vin", output: "x", fMinHz: 5e4, fMaxHz: 2e5, gainMax: 10 });
  const fr = (lg.details?.crossings ?? []).map((c) => c.frequencyHz);
  expect("D: XTAL のインピーダンスが実数になる周波数が fs と fp の近く（Q が高い共振も掃引で見落とさない）",
    fr.length === 2 && Math.abs(fr[0] / fs - 1) < 2e-4 && Math.abs(fr[1] / fp - 1) < 2e-3, JSON.stringify(fr));
  // ピアース発振（MOSFET 自己バイアス、C1 = C2 = 4.7nF）: f ≈ fs·√(1 + Cm/(Cp + CL))、CL = C1C2/(C1+C2)。XTAL の initialI で起動
  const CL = 4.7e-9 / 2;
  const fosc = fs * Math.sqrt(1 + Cm / (Cp + CL));
  const pierce = board(comp("V1", "V_DC", ["vcc", "gnd"], { V: 12 }), comp("RD", "R", ["vcc", "d"], { R: 2000 }),
    comp("M1", "M_N", ["d", "g", "gnd"], { Vth: 2, K: 0.02 }), comp("RF", "R", ["d", "g"], { R: 1e6 }),
    comp("X1", "XTAL", ["d", "g"], { initialI: 0.003 }), comp("C1", "C", ["g", "gnd"], { C: 4.7e-9 }), comp("C2", "C", ["d", "gnd"], { C: 4.7e-9 }),
    comp("TP", "TP", ["d"]));
  const sim = await simulate(pierce, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.002, initialCondition: "dc" } } });
  const pf = await runSingleCheck({ type: "oscillationFrequency", node: "d", fromSec: 0.001, toSec: 0.002, expected: fosc, tolerancePct: 0.5 }, { simulationResult: sim, circuit: pierce });
  expect("D: ピアース発振（XTAL）が fs と fp の間、fs·√(1+Cm/(Cp+CL)) 付近で発振する", pf.ok && pf.actual > fs && pf.actual < fp, pf.message);
  const pa = await runSingleCheck({ type: "transientMeasure", node: "d", measure: "pp", fromSec: 0.0015, toSec: 0.002, expectedMin: 1 }, { simulationResult: sim, circuit: pierce });
  expect("D: ピアース発振の振幅が保たれる", pa.ok, pa.message);
  const xi = sim.transient.elements.X1;
  expect("D: XTAL の端子電流・電圧の波形（element X1）が取れる", Array.isArray(xi?.i) && xi.i.length === sim.transient.time.length, "");
}
{
  // VCO: f = f0 + Kv·vc（1kHz + 500Hz/V × 2V = 2kHz）。制御端子 +/− の取り違えで 0Hz（負は 0 に丸める）
  const vco = (cp, cn) => board(comp("VC", "V_DC", ["c", "gnd"], { V: 2 }), comp("U", "V_VCO", ["o", "gnd", cp, cn], { f0Hz: 1000, KvHzPerV: 500, Vpk: 1, fMaxHz: 5000 }),
    comp("RL", "R", ["o", "gnd"], { R: 1000 }), comp("TP", "TP", ["o"]));
  const chk = { type: "transientMeasure", node: "o", measure: "frequency", fromSec: 0.001, toSec: 0.01, expected: 2000, tolerancePct: 0.1 };
  const ok = await check(vco("c", "gnd"), "transient", chk, {}, { simulation: { tStop: 0.01 } });
  expect("D: V_VCO の周波数 f0 + Kv·vc", ok.ok, ok.message);
  const rev = await check(vco("gnd", "c"), "transient", chk, {}, { simulation: { tStop: 0.01 } });
  expect("D: V_VCO の制御端子を逆にすると周波数が違う", !rev.ok, rev.message);
  const dc = await simulate(vco("c", "gnd"), { mode: "dc" });
  expect("D: V_VCO は DC では 0V（短絡）", dc.ok && Math.abs(dc.dc.nodes.o) < 1e-9, JSON.stringify(dc.errors));
}
{
  // PLL: 基準 10kHz（V_PULSE 0/5V）、XOR 位相比較、RC ローパス（10k, 100nF）、VCO（方形波 0/5V、f0 = 8kHz, Kv = 1kHz/V）。
  // ロックすると VCO = 基準、制御電圧 = (10k − 8k)/1k = 2V、XOR のデューティ = 2V/5V = 0.4（位相差 72°）。
  // ÷2（DFF の Q_NOT を D に戻す）を帰還に入れると VCO = 2 × 基準（f0 = 16kHz, Kv = 2kHz/V で同じ 2V）
  for (const div of [1, 2]) {
    const parts = [
      comp("VR", "V_PULSE", ["ref", "gnd"], { Vlow: 0, Vhigh: 5, riseSec: 1e-9, fallSec: 1e-9, widthSec: 5e-5, periodSec: 1e-4 }),
      comp("U1", "U_XOR", ["ref", div === 1 ? "vco" : "fb", "pd"]),
      comp("R1", "R", ["pd", "vc"], { R: 10000 }), comp("C1", "C", ["vc", "gnd"], { C: 1e-7 }),
      comp("V1", "V_VCO", ["vco", "gnd", "vc", "gnd"], { f0Hz: 8000 * div, KvHzPerV: 1000 * div, Vpk: 2.5, Voffset: 2.5, square: true, fMaxHz: 20000 * div }),
      comp("TP", "TP", ["vco"]), comp("TP2", "TP", ["vc"])];
    if (div === 2) parts.push(comp("F1", "DFF", ["fbn", "vco", "fb", "fbn"]));
    const b = board(...parts);
    const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.02 } } });
    const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
    near(`D: PLL（÷${div}）がロックして VCO = ${div} × 基準`, (await r({ type: "transientMeasure", node: "vco", measure: "frequency", fromSec: 0.015, toSec: 0.02, expected: 1 })).actual, 10000 * div, 0.001);
    near(`D: PLL（÷${div}）の制御電圧 = (f − f0)/Kv`, (await r({ type: "transientMeasure", node: "vc", measure: "average", fromSec: 0.015, toSec: 0.02, expected: 1 })).actual, 2, 0.01);
    near(`D: PLL（÷${div}）の XOR 位相比較のデューティ = vc/5V`, (await r({ type: "transientMeasure", node: "pd", measure: "duty", fromSec: 0.015, toSec: 0.02, expected: 1 })).actual, 0.4, 0, 0.01);
    expect(`D: PLL（÷${div}）のステップ数が 10 万以下`, sim.transient.steps < 100000, String(sim.transient.steps));
  }
  // DFF（過渡）の分周: 1kHz のクロック → Q = 500Hz
  const d = board(comp("VR", "V_PULSE", ["clk", "gnd"], { Vlow: 0, Vhigh: 5, riseSec: 1e-9, fallSec: 1e-9, widthSec: 5e-4, periodSec: 1e-3 }),
    comp("F1", "DFF", ["qn", "clk", "q", "qn"]), comp("TP", "TP", ["q"]));
  const dq = await check(d, "transient", { type: "transientMeasure", node: "q", measure: "frequency", fromSec: 0.002, toSec: 0.02, expected: 500, tolerancePct: 0.1 }, {}, { simulation: { tStop: 0.02 } });
  expect("D: 過渡解析の DFF（Q_NOT → D）が 2 分周する", dq.ok, dq.message);
  const dl = await check(board(comp("A", "LOGIC_IN", ["a"], { value: 1 }), comp("U1", "U_NOT", ["a", "y"]), comp("TP", "TP", ["y"])), "transient",
    { type: "transientPoint", node: "y", timeSec: 0.001, expected: 0, toleranceAbs: 1e-6 });
  expect("D: 過渡解析の LOGIC_IN は value·VOH の電圧源（NOT の出力 0V）", dl.ok, dl.message);
}

/* ---------------------------------------------------------------- 分野E（変調・復調）: AM / FM 信号源、乗算器、包絡線検波、スペクトル線（tone） */
// 許容誤差の根拠（分野E）:
// - tone（方形窓 DFT）: 区間を全成分の周期の整数倍にすると漏れは 0。台形則の積分誤差は刻み T/100 で (ωh)²/12 ≈ 3e-4 → 0.5%。
// - modulationIndex: 包絡線のピークを搬送波の山で拾うので、山の時刻と包絡線の山の時刻が最大 1/(2fc) ずれる →
//   相対誤差 ≤ (π·fm/fc)²/2（fc/fm = 20 で 1.2%）→ 2%。
// - FM のスペクトル: 振幅は第1種ベッセル関数 Jn(β)（J0(1) = 0.7652, J1(1) = 0.4401, J2(1) = 0.1149）→ 0.5%。
{
  // AM: v = Vc(1 + m sin ωm t) sin ωc t → 搬送波 Vc、側帯波 fc ± fm に m·Vc/2、変調度 m
  const b = board(comp("V1", "V_AM", ["am", "gnd"], { Vc: 2, fcHz: 10000, fmHz: 500, m: 0.5 }), comp("RL", "R", ["am", "gnd"], { R: 1000 }), comp("TP", "TP", ["am"]));
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.004 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  const tone = async (f) => (await r({ type: "transientMeasure", node: "am", measure: "tone", frequencyHz: f, fromSec: 0, toSec: 0.004, expected: 1 })).actual;
  near("E: AM の搬送波成分 = Vc", await tone(10000), 2, 0.005);
  near("E: AM の上側帯波 fc + fm = m·Vc/2", await tone(10500), 0.5, 0.005);
  near("E: AM の下側帯波 fc − fm = m·Vc/2", await tone(9500), 0.5, 0.005);
  near("E: AM に fc ± 2fm の成分は無い", await tone(11000), 0, 0, 1e-3);
  near("E: AM の変調度 (Emax−Emin)/(Emax+Emin) = m", (await r({ type: "transientMeasure", node: "am", measure: "modulationIndex", fromSec: 0, toSec: 0.004, expected: 1 })).actual, 0.5, 0.02);
  // Hann 窓: 区間が整数倍でなくても、2/T 以上離れた成分の漏れは小さい（区間 3.7ms → 2/T = 540Hz。fc から 1kHz 離れた点）
  near("E: tone の hann 窓（整数倍でない区間）", (await r({ type: "transientMeasure", node: "am", measure: "tone", frequencyHz: 10000, window: "hann", fromSec: 0, toSec: 0.0037, expected: 1 })).actual, 2, 0.02);
  near("E: tone の hann 窓で離れた周波数の漏れが小さい", (await r({ type: "transientMeasure", node: "am", measure: "tone", frequencyHz: 11000, window: "hann", fromSec: 0, toSec: 0.0037, expected: 1 })).actual, 0, 0, 0.02);
  const dcr = await simulate(b, { mode: "dc" });
  expect("E: V_AM は DC では 0V（短絡）", dcr.ok && Math.abs(dcr.dc.nodes.am) < 1e-9);
}
{
  // FM: β = Δf/fm = 1 → 搬送波 J0(1)、第1側帯波 J1(1)、第2側帯波 J2(1)（Vpk = 1）
  const b = board(comp("V1", "V_FM", ["fm", "gnd"], { Vpk: 1, fcHz: 10000, fmHz: 1000, deviationHz: 1000 }), comp("RL", "R", ["fm", "gnd"], { R: 1000 }), comp("TP", "TP", ["fm"]));
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.002 } } });
  const tone = async (f) => (await runSingleCheck({ type: "transientMeasure", node: "fm", measure: "tone", frequencyHz: f, fromSec: 0, toSec: 0.002, expected: 1 }, { simulationResult: sim, circuit: b })).actual;
  near("E: FM（β=1）の搬送波 = J0(1)", await tone(10000), 0.7652, 0.005);
  near("E: FM（β=1）の第1側帯波 = J1(1)", await tone(11000), 0.4401, 0.005);
  near("E: FM（β=1）の第2側帯波 = J2(1)", await tone(8000), 0.1149, 0.005);
}
{
  // 乗算器（ミキサ）: k·A·sin ω1t · B·sin ω2t = (kAB/2)[cos(ω1−ω2)t − cos(ω1+ω2)t] → 和・差の周波数に kAB/2
  const mix = (f2) => board(comp("V1", "V_AC", ["a", "gnd"], { Vpk: 1, freqHz: 10000 }), comp("V2", "V_AC", ["b", "gnd"], { Vpk: 2, freqHz: f2 }),
    comp("M1", "MULT", ["a", "b", "y"], { k: 0.5 }), comp("TP", "TP", ["y"]));
  const b = mix(12000);
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.002 } } });
  const tone = async (s, bb, f) => (await runSingleCheck({ type: "transientMeasure", node: "y", measure: "tone", frequencyHz: f, fromSec: 0, toSec: 0.002, expected: 1 }, { simulationResult: s, circuit: bb })).actual;
  near("E: ミキサの差の周波数（2kHz）= kAB/2", await tone(sim, b, 2000), 0.5, 0.005);
  near("E: ミキサの和の周波数（22kHz）= kAB/2", await tone(sim, b, 22000), 0.5, 0.005);
  near("E: ミキサの出力に入力の周波数は出ない", await tone(sim, b, 10000), 0, 0, 1e-6);
  // イメージ周波数: 局発 10kHz に対して RF = 8kHz（= 局発 − IF）でも同じ IF = 2kHz が出る
  const bi = mix(8000);
  const si = await simulate(bi, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.002 } } });
  near("E: イメージ周波数（局発 − IF）でも同じ IF が出る", await tone(si, bi, 2000), 0.5, 0.005);
  // AC 解析では DC 動作点で線形化: x の直流 2V、y の直流 3V、x に 0.1V の交流 → 出力 k·Y0·0.1
  const lin = board(comp("VX", "V_DC", ["xd", "gnd"], { V: 2 }), comp("VA", "V_AC", ["x", "xd"], { Vpk: 0.1, freqHz: 1000 }), comp("VY", "V_DC", ["y", "gnd"], { V: 3 }),
    comp("M1", "MULT", ["x", "y", "o"], { k: 0.5 }), comp("RL", "R", ["o", "gnd"], { R: 1000 }), comp("TP", "TP", ["o"]));
  expect("E: MULT の DC = k·X·Y", (await check(lin, "dc", { type: "dcVoltage", node: "o", expected: 3, tolerancePct: 0.01 })).ok);
  expect("E: MULT の AC（DC 動作点で線形化）= k·Y0·vx", (await check(lin, "ac", { type: "acVoltage", node: "o", frequencyHz: 1000, expectedRMS: 0.15 / Math.SQRT2, tolerancePct: 0.01 })).ok);
}
{
  // DSB-SC の同期検波: 信号 1V@500Hz × 搬送波 1V@10kHz（DSB）→ さらに同じ搬送波を掛ける → RC ローパス（fc = 1/(2π·1k·1µ) = 159Hz）。
  // m(t)·sin²ωct = m(t)/2 − m(t)cos2ωct/2 → 500Hz の成分 = 0.5·|H(500)| = 0.5/√(1+(500/159.15)²)
  const b = board(comp("VM", "V_AC", ["m", "gnd"], { Vpk: 1, freqHz: 500 }), comp("VC", "V_AC", ["c", "gnd"], { Vpk: 1, freqHz: 10000 }),
    comp("M1", "MULT", ["m", "c", "dsb"], { k: 1 }), comp("M2", "MULT", ["dsb", "c", "dem"], { k: 1 }),
    comp("R1", "R", ["dem", "o"], { R: 1000 }), comp("C1", "C", ["o", "gnd"], { C: 1e-6 }), comp("TP", "TP", ["o"]), comp("TP2", "TP", ["dsb"]));
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.02 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  const H = 1 / Math.sqrt(1 + (500 / (1 / (2 * Math.PI * 1e-3))) ** 2);
  near("E: DSB-SC の同期検波で信号が戻る（0.5·|H(fm)|）", (await r({ type: "transientMeasure", node: "o", measure: "tone", frequencyHz: 500, fromSec: 0.01, toSec: 0.02, expected: 1 })).actual, 0.5 * H, 0.01);
  near("E: DSB-SC には搬送波成分が無い", (await r({ type: "transientMeasure", node: "dsb", measure: "tone", frequencyHz: 10000, fromSec: 0.01, toSec: 0.02, expected: 1 })).actual, 0, 0, 1e-6);
  // BPSK: ±1V のデータ（デューティ 50%）× 搬送波 → 搬送波成分が消える（位相反転）。ASK（0/1V）は搬送波の半分が残る
  const psk = (lo) => board(comp("VD", "V_PULSE", ["d", "gnd"], { Vlow: lo, Vhigh: 1, riseSec: 1e-9, fallSec: 1e-9, widthSec: 1e-3, periodSec: 2e-3 }),
    comp("VC", "V_AC", ["c", "gnd"], { Vpk: 1, freqHz: 10000 }), comp("M1", "MULT", ["d", "c", "y"], { k: 1 }), comp("TP", "TP", ["y"]));
  const t = async (bb) => (await check(bb, "transient", { type: "transientMeasure", node: "y", measure: "tone", frequencyHz: 10000, fromSec: 0, toSec: 0.004, expected: 1 }, {}, { simulation: { tStop: 0.004 } })).actual;
  near("E: BPSK（±1 のデータ）の搬送波成分 = 0", await t(psk(-1)), 0, 0, 0.005);
  near("E: ASK（0/1 のデータ、デューティ 50%）の搬送波成分 = 0.5", await t(psk(0)), 0.5, 0.01);
}
{
  // 包絡線検波（D: Vf = 0.3V、C = 25nF ∥ R = 20kΩ → RC = 0.5ms。1/fc = 50µs ≪ RC ≪ √(1−m²)/(m·ωm) = 1.38ms）:
  // 出力は包絡線 Vc(1 + m sin ωm t) − Vf にほぼ追従 → 平均 ≈ Vc − Vf、fm 成分 ≈ m·Vc（搬送波 1 周期の放電 T/RC ≈ 10% の
  // リプルと導通角のぶん小さい → 0.8〜1.0 倍で判定）
  const det = (C) => board(comp("V1", "V_AM", ["am", "gnd"], { Vc: 5, fcHz: 20000, fmHz: 200, m: 0.5 }), comp("D1", "D", ["am", "det"], { Vf: 0.3 }),
    comp("C1", "C", ["det", "gnd"], { C }), comp("R1", "R", ["det", "gnd"], { R: 20000 }), comp("TP", "TP", ["det"]));
  const b = det(2.5e-8);
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.006 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  const a = (await r({ type: "transientMeasure", node: "det", measure: "tone", frequencyHz: 200, fromSec: 0.001, toSec: 0.006, expected: 1 })).actual;
  expect("E: 包絡線検波の出力の fm 成分 ≈ m·Vc（0.8〜1.0 倍）", a > 0.8 * 2.5 && a < 2.5, String(a));
  const avg = (await r({ type: "transientMeasure", node: "det", measure: "average", fromSec: 0.001, toSec: 0.006, expected: 1 })).actual;
  expect("E: 包絡線検波の出力の平均 ≈ Vc − Vf（0.85〜1.0 倍）", avg > 0.85 * 4.7 && avg < 4.7, String(avg));
  const dist = (await r({ type: "transientMeasure", node: "det", measure: "tone", frequencyHz: 400, fromSec: 0.001, toSec: 0.006, expected: 1 })).actual;
  expect("E: 適切な RC ではひずみ（2fm 成分）が fm 成分の 5% 未満", dist < 0.05 * a, `${dist} / ${a}`);
  expect("E: 包絡線検波（fc = 20kHz、6ms）のステップ数が 5 万以下", sim.transient.steps <= 50000, String(sim.transient.steps));
  // RC が大きすぎる（C = 1µF → RC = 20ms ≫ 1.38ms）: 包絡線の下がりに追従できない（ダイアゴナルクリッピング）→ fm 成分が大きく減る
  const big = det(1e-6);
  const ab = (await check(big, "transient", { type: "transientMeasure", node: "det", measure: "tone", frequencyHz: 200, fromSec: 0.001, toSec: 0.006, expected: 1 }, {}, { simulation: { tStop: 0.006 } })).actual;
  expect("E: RC が大きすぎると包絡線に追従できず fm 成分が減る", ab < 0.5 * a, `${ab} / ${a}`);
}
{
  // FSK: V_VCO の制御を V_PULSE（0/1V、1 ビット 4ms）で切り替える → 1.5kHz（制御 1V）と 1kHz（0V）（Kv = 500Hz/V）
  const b = board(comp("VD", "V_PULSE", ["d", "gnd"], { Vlow: 0, Vhigh: 1, riseSec: 1e-9, fallSec: 1e-9, widthSec: 4e-3, periodSec: 8e-3 }),
    comp("U", "V_VCO", ["o", "gnd", "d", "gnd"], { f0Hz: 1000, KvHzPerV: 500, Vpk: 1, fMaxHz: 2000 }), comp("RL", "R", ["o", "gnd"], { R: 1000 }), comp("TP", "TP", ["o"]));
  const sim = await simulate(b, { mode: "transient", checks: [], problem: { simulation: { tStop: 0.008 } } });
  const r = (chk) => runSingleCheck(chk, { simulationResult: sim, circuit: b });
  near("E: FSK のマーク（制御 1V）= 1.5kHz", (await r({ type: "transientMeasure", node: "o", measure: "frequency", fromSec: 0.0005, toSec: 0.0035, expected: 1 })).actual, 1500, 0.01);
  near("E: FSK のスペース（制御 0V）= 1kHz", (await r({ type: "transientMeasure", node: "o", measure: "frequency", fromSec: 0.0045, toSec: 0.0075, expected: 1 })).actual, 1000, 0.01);
}
{
  // 検証（validation）: 新しい判定・部品の書式
  const base = { id: "D-90", category: "D", title: "t", statement: "s", judge: "ac",
    fixedComponents: [{ id: "V1", type: "V_AC", params: { Vpk: 1, freqHz: 1000 }, connect: ["vin", "gnd"], locked: true }, { id: "TP1", type: "TP", connect: ["fb"], locked: true }],
    checks: [{ type: "loopGain", input: "vin", output: "fb", fMinHz: 100, fMaxHz: 1e5, expectedFrequencyHz: 1591.5 }] };
  expect("validation: loopGain の正しい書式はエラーなし", validateProblem(base, vopts).errors.length === 0, JSON.stringify(validateProblem(base, vopts).errors));
  const noRange = { ...base, checks: [{ type: "loopGain", input: "vin", output: "fb", expectedFrequencyHz: 1591.5 }] };
  expect("validation: loopGain に fMinHz / fMaxHz が無いとエラー", validateProblem(noRange, vopts).errors.some((e) => /fMinHz/.test(e)));
  const noJudge = { ...base, judge: "transient" };
  expect("validation: loopGain は judge に ac が必要", validateProblem(noJudge, vopts).errors.some((e) => /"ac"/.test(e)));
  const noTarget = { ...base, checks: [{ type: "loopGain", input: "vin", output: "fb", fMinHz: 100, fMaxHz: 1e5 }] };
  expect("validation: loopGain に expectedFrequencyHz も gainMin/gainMax も無いとエラー", validateProblem(noTarget, vopts).errors.length > 0);
  const tr = { ...base, judge: "transient", checks: [{ type: "transientMeasure", node: "fb", measure: "tone", fromSec: 0, toSec: 0.01, expected: 1 }] };
  expect("validation: tone に frequencyHz が無いとエラー", validateProblem(tr, vopts).errors.some((e) => /frequencyHz/.test(e)));
  const range = { ...base, judge: "transient", checks: [{ type: "transientMeasure", node: "fb", measure: "pp", fromSec: 0, toSec: 0.01, expectedMin: 2, expectedMax: 1 }] };
  expect("validation: expectedMin > expectedMax はエラー", validateProblem(range, vopts).errors.some((e) => /expectedMin/.test(e)));
  const onlyMin = { ...base, judge: "transient", checks: [{ type: "transientMeasure", node: "fb", measure: "pp", fromSec: 0, toSec: 0.01, expectedMin: 1 }] };
  expect("validation: expected の代わりに expectedMin だけでもよい", validateProblem(onlyMin, vopts).errors.length === 0, JSON.stringify(validateProblem(onlyMin, vopts).errors));
  const am = { ...base, judge: "dc", fixedComponents: [{ id: "V1", type: "V_AM", connect: ["am", "gnd"], locked: true }], checks: [{ type: "componentValue", element: "V1", param: "m", expected: 0.5 }] };
  expect("validation: V_AM を judge に transient 無しで使うと警告", (validateProblem(am, vopts).warnings || []).some((w) => /過渡解析専用/.test(w)));
  const win = { ...base, judge: "transient", checks: [{ type: "transientMeasure", node: "fb", measure: "tone", frequencyHz: 1000, window: "flat", fromSec: 0, toSec: 0.01, expected: 1 }] };
  expect("validation: window は rect / hann だけ", validateProblem(win, vopts).errors.some((e) => /window/.test(e)));
}

/* ---------------------------------------------------------------- verify.mjs: 分野D/E（ループ利得の回路・ミキサの誤答） */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-de-"));
  fs.mkdirSync(path.join(dir, "D"));
  const common = { title: "t", statement: "s", hints: ["a", "b", "c"], explanation: { solution: "a", why: "b", mistakes: "c", practice: "d", next: "e" } };
  // D-01: ウィーンブリッジの帰還回路（R・C 各 2 個）をプレイヤーが組む。ループは OPAMP の + 入力で切ってある（AC の loopGain）
  const wien = { ...common, id: "D-01", category: "D", judge: "ac",
    fixedComponents: [
      { id: "V1", type: "V_AC", params: { Vpk: 1, freqHz: 1000 }, connect: ["vin", "gnd"], locked: true },
      { id: "U1", type: "OPAMP", params: { GBP: 0 }, connect: ["vin", "n", "out", "", ""], locked: true },
      { id: "Rf", type: "R", params: { R: 22000 }, connect: ["out", "n"], locked: true },
      { id: "Rg", type: "R", params: { R: 10000 }, connect: ["n", "gnd"], locked: true },
      { id: "TPO", type: "TP", connect: ["out"], locked: true },
      { id: "TPF", type: "TP", connect: ["fb"], locked: true },
    ],
    referenceSolution: [
      { id: "R1", type: "R", params: { R: 10000 }, connect: ["out", "x"] },
      { id: "C1", type: "C", params: { C: 1e-8 }, connect: ["x", "fb"] },
      { id: "R2", type: "R", params: { R: 10000 }, connect: ["fb", "gnd"] },
      { id: "C2", type: "C", params: { C: 1e-8 }, connect: ["fb", "gnd"] },
    ],
    checks: [{ type: "loopGain", input: "vin", output: "fb", fMinHz: 100, fMaxHz: 100000, expectedFrequencyHz: 1591.5, tolerancePct: 2, gainMin: 1.0, gainMax: 1.2 }] };
  fs.writeFileSync(path.join(dir, "D", "D-01.json"), JSON.stringify(wien));
  fs.writeFileSync(path.join(dir, "D", "index.json"), JSON.stringify({ problems: [{ id: "D-01", title: "t" }] }));
  // E-01: ミキサ＋ RC ローパスで IF（差の周波数 2kHz）を取り出す。プレイヤーが MULT・R・C を置く
  fs.mkdirSync(path.join(dir, "E"));
  const fcLp = 5000;
  const Hif = 1 / Math.sqrt(1 + (2000 / fcLp) ** 2);
  const mixer = { ...common, id: "E-01", category: "E", judge: "transient", simulation: { tStop: 0.002 },
    fixedComponents: [
      { id: "VRF", type: "V_AC", params: { Vpk: 1, freqHz: 12000 }, connect: ["rf", "gnd"], locked: true },
      { id: "VLO", type: "V_AC", params: { Vpk: 1, freqHz: 10000 }, connect: ["lo", "gnd"], locked: true },
      { id: "TPI", type: "TP", connect: ["if"], locked: true },
    ],
    referenceSolution: [
      { id: "MULT1", type: "MULT", params: { k: 1 }, connect: ["rf", "lo", "mix"] },
      { id: "R1", type: "R", params: { R: 1000 }, connect: ["mix", "if"] },
      { id: "C1", type: "C", params: { C: 1 / (2 * Math.PI * 1000 * fcLp) }, connect: ["if", "gnd"] },
    ],
    checks: [
      { type: "transientMeasure", node: "if", measure: "tone", frequencyHz: 2000, fromSec: 0.001, toSec: 0.002, expected: 0.5 * Hif, tolerancePct: 3 },
      { type: "transientMeasure", node: "if", measure: "tone", frequencyHz: 22000, fromSec: 0.001, toSec: 0.002, expectedMax: 0.15 },
    ] };
  fs.writeFileSync(path.join(dir, "E", "E-01.json"), JSON.stringify(mixer));
  fs.writeFileSync(path.join(dir, "E", "index.json"), JSON.stringify({ problems: [{ id: "E-01", title: "t" }] }));
  const run = (...a) => {
    try {
      return { code: 0, out: execFileSync("node", [path.join(ROOT, "tools/verify.mjs"), `--problems=${dir}`, ...a], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const ref = run();
  expect("verify D/E: ループ利得（AC）とミキサ（過渡）の参照解が合格", ref.code === 0 && /参照解が合格 2 問/.test(ref.out), ref.out);
  const mut = run("--mutate");
  expect("verify D/E --mutate: R・C・MULT の k を2倍にした誤答はすべて不合格", mut.code === 0 && /誤答がすべて不合格 2 問/.test(mut.out), mut.out);
  const rev = run("--reverse");
  expect("verify D/E --reverse: MULT の入力と出力の取り違えは不合格", rev.code === 0 && /誤答がすべて不合格 1 問/.test(rev.out), rev.out);
  const drop = run("--drop");
  expect("verify D/E --drop: 部品を外すとすべて不合格", drop.code === 0 && /誤答がすべて不合格 2 問/.test(drop.out), drop.out);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- check_layout.mjs（レイアウト検査の自己テスト） */
{
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, "tools/check_layout.mjs"), "--self-test"], { encoding: "utf8" });
  } catch (e) {
    code = e.status;
    out = String(e.stdout);
  }
  expect("check_layout --self-test: 重なり・はみ出し・ラベル・ガイド線の検出がすべて期待どおり", code === 0, out);
}

console.log(`[test_checks] 合格 ${passed} / 失敗 ${failures.length}`);
for (const f of failures) console.log("FAIL", f);
process.exitCode = failures.length ? 1 : 0;
