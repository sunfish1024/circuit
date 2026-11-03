/**
 * 過渡波形の解析ヘルパ（純粋関数のみ。シミュレーションモードは登録しない）。
 *
 * transient.js と checks/runner.js の両方から使う。
 * 時間配列 time は単調増加（刻みは不等間隔でもよい）を前提にする。
 */

/**
 * 時刻 t の値を線形補間で返します。範囲外は端の値。
 *
 * @param {number[]} time
 * @param {number[]} values
 * @param {number} t
 * @returns {number | null}
 */
export function interpolateAt(time, values, t) {
  if (!Array.isArray(time) || !Array.isArray(values)) return null;
  const n = Math.min(time.length, values.length);
  if (n === 0) return null;
  if (t <= time[0]) return values[0];
  if (t >= time[n - 1]) return values[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid;
  }
  const dt = time[hi] - time[lo];
  if (dt === 0) return values[hi];
  return values[lo] + ((t - time[lo]) / dt) * (values[hi] - values[lo]);
}

/**
 * 区間 [t0, t1] のインデックス範囲を返します。
 */
function indexRange(time, t0, t1) {
  let i0 = 0;
  while (i0 < time.length && time[i0] < t0) i0++;
  let i1 = time.length - 1;
  while (i1 > 0 && time[i1] > t1) i1--;
  return [i0, i1];
}

/**
 * ステップ応答から時定数を測ります（63.2% 法）。
 *
 * v0 = v(fromSec)、v∞ = v(toSec) とし、v が v0 + (1 − e⁻¹)(v∞ − v0) を
 * 最初に横切る時刻 t₆₃ から τ = t₆₃ − fromSec を返します。
 * 1次系（指数応答）でのみ意味があります。toSec は 7τ 以上後（残差 0.1% 未満）にすること。
 *
 * @param {number[]} time
 * @param {number[]} values
 * @param {number} [fromSec=0]
 * @param {number} [toSec] 省略時は最終時刻
 * @returns {{tau: number|null, v0: number|null, vFinal: number|null, reason?: string}}
 */
export function measureTimeConstant(time, values, fromSec = 0, toSec) {
  if (!Array.isArray(time) || time.length < 3) {
    return { tau: null, v0: null, vFinal: null, reason: "波形がありません" };
  }
  const tEnd = Number.isFinite(toSec) ? toSec : time[time.length - 1];
  // fromSec ちょうどに不連続（ステップ）がある場合に備え、直後の値を使う
  const v0 = interpolateAt(time, values, fromSec);
  const vFinal = interpolateAt(time, values, tEnd);
  if (!Number.isFinite(v0) || !Number.isFinite(vFinal)) {
    return { tau: null, v0, vFinal, reason: "値を取得できません" };
  }
  const delta = vFinal - v0;
  const scale = Math.max(Math.abs(v0), Math.abs(vFinal), 1e-12);
  if (Math.abs(delta) < 1e-6 * scale + 1e-12) {
    return { tau: null, v0, vFinal, reason: "電圧が変化していません（ステップ応答がない）" };
  }
  const target = v0 + (1 - Math.exp(-1)) * delta;
  const sign = Math.sign(delta);
  const [i0, i1] = indexRange(time, fromSec, tEnd);
  for (let i = Math.max(i0, 1); i <= i1; i++) {
    const a = (values[i - 1] - target) * sign;
    const b = (values[i] - target) * sign;
    if (time[i - 1] >= fromSec && a < 0 && b >= 0) {
      const frac = a === b ? 0 : -a / (b - a);
      const tc = time[i - 1] + frac * (time[i] - time[i - 1]);
      return { tau: tc - fromSec, v0, vFinal };
    }
  }
  return { tau: null, v0, vFinal, reason: "63.2% 点を横切りませんでした" };
}

/**
 * 減衰振動などの周波数を、最終値まわりの上向き零交差の間隔から推定します。
 *
 * @param {number[]} time
 * @param {number[]} values
 * @param {number} [fromSec=0]
 * @returns {number | null}
 */
export function estimateOscillationFrequency(time, values, fromSec = 0) {
  if (!Array.isArray(values) || values.length < 8) return null;
  const n = values.length;
  const tailStart = Math.max(1, Math.floor(n * 0.9));
  let finalSum = 0;
  for (let i = tailStart; i < n; i++) finalSum += values[i];
  const finalValue = finalSum / (n - tailStart);

  let maxDev = 0;
  for (let i = 0; i < n; i++) {
    if (time[i] >= fromSec) maxDev = Math.max(maxDev, Math.abs(values[i] - finalValue));
  }
  // 数値ノイズの零交差を拾わないよう、最大振れ幅の 1e-6 未満は無視する
  const eps = maxDev * 1e-6;

  const crossings = [];
  for (let i = 1; i < n; i++) {
    if (time[i - 1] < fromSec) continue;
    const prev = values[i - 1] - finalValue;
    const cur = values[i] - finalValue;
    if (prev < -eps && cur >= 0) {
      const frac = -prev / (cur - prev);
      crossings.push(time[i - 1] + frac * (time[i] - time[i - 1]));
    }
  }
  if (crossings.length < 2) return null;
  const span = crossings[crossings.length - 1] - crossings[0];
  if (span <= 0) return null;
  return (crossings.length - 1) / span;
}

/**
 * 区間内の波形の周波数（分野D: 持続発振・方形波・VCO の出力）。
 * 区間の時間平均を基準に「平均 − δ より下 → 平均以上」の上向き交差を数え、
 * f = (交差の数 − 1) / (最後の交差 − 最初の交差)。δ = 振幅（(最大−最小)/2）の 10%（数値ノイズ・
 * リプルで同じ交差を2回数えない）。交差の時刻は線形補間。交差が 2 回未満なら NaN。
 * 区間の端数の影響を受けない（周期の整数倍でなくてよい）。
 *
 * @param {number[]} ts 区間の時刻（昇順）
 * @param {number[]} vs 値
 * @returns {number}
 */
export function frequencyOfSamples(ts, vs) {
  const n = Math.min(ts.length, vs.length);
  if (n < 4) return NaN;
  let lo = Infinity;
  let hi = -Infinity;
  let s1 = 0;
  for (let i = 0; i < n; i++) {
    if (vs[i] < lo) lo = vs[i];
    if (vs[i] > hi) hi = vs[i];
    if (i > 0) s1 += 0.5 * (vs[i] + vs[i - 1]) * (ts[i] - ts[i - 1]);
  }
  const T = ts[n - 1] - ts[0];
  if (!(T > 0) || !(hi > lo)) return NaN;
  const mean = s1 / T;
  const delta = 0.1 * (hi - lo) / 2;
  let armed = false;
  let first = NaN;
  let last = NaN;
  let count = 0;
  for (let i = 1; i < n; i++) {
    if (vs[i - 1] < mean - delta) armed = true;
    if (armed && vs[i - 1] < mean && vs[i] >= mean) {
      const frac = (mean - vs[i - 1]) / (vs[i] - vs[i - 1]);
      const tc = ts[i - 1] + frac * (ts[i] - ts[i - 1]);
      if (count === 0) first = tc;
      last = tc;
      count++;
      armed = false;
    }
  }
  if (count < 2 || !(last > first)) return NaN;
  return (count - 1) / (last - first);
}

/**
 * 指定周波数の正弦波成分の振幅（ピーク値）を DFT（区間の積分）で求めます（分野E: スペクトル線）。
 * 方形窓（既定）: A = (2/T)·|∫v(t)·e^{−jωt} dt|。区間 T が、波形に含まれる**すべての**周波数成分の
 * 周期の整数倍なら漏れ（リーク）は 0。そうでないと近くの強い成分が漏れ込む。
 * window: "hann" なら w(t) = ½(1 − cos(2π(t−t0)/T)) を掛けて A = (4/T)·|∫v·w·e^{−jωt} dt|
 * （周波数が 2/T 以上離れた成分の漏れを 1% 以下に抑える。整数倍でない区間向け）。
 * 積分は台形則（刻み ≤ 周期/100 で相対誤差 0.1% 未満）。
 *
 * @returns {number} ピーク振幅（NaN: 区間が無い）
 */
export function toneAmplitude(ts, vs, freqHz, window = "rect") {
  const n = Math.min(ts.length, vs.length);
  if (n < 2 || !(freqHz >= 0)) return NaN;
  const t0 = ts[0];
  const T = ts[n - 1] - t0;
  if (!(T > 0)) return NaN;
  const w = 2 * Math.PI * freqHz;
  const hann = window === "hann";
  let re = 0;
  let im = 0;
  let pre = null;
  for (let i = 0; i < n; i++) {
    const tt = ts[i] - t0;
    const win = hann ? 0.5 * (1 - Math.cos((2 * Math.PI * tt) / T)) : 1;
    const cr = vs[i] * win * Math.cos(w * tt);
    const ci = -vs[i] * win * Math.sin(w * tt);
    if (pre) {
      const h = ts[i] - ts[i - 1];
      re += 0.5 * h * (cr + pre[0]);
      im += 0.5 * h * (ci + pre[1]);
    }
    pre = [cr, ci];
  }
  const scale = freqHz === 0 ? (hann ? 2 / T : 1 / T) : (hann ? 4 / T : 2 / T);
  return Math.hypot(re, im) * scale;
}

/**
 * AM 波の変調度 m = (Emax − Emin)/(Emax + Emin)（分野E）。
 * 区間の時間平均を引いた波形の正のピーク（極大値。前後の点で放物線補間）を包絡線とみなし、
 * その最大 Emax と最小 Emin から求める。過変調（m > 1）は包絡線の最小が 0 になるので 1 と測られる。
 * 極大が 3 個未満なら NaN。
 */
export function modulationIndexOfSamples(ts, vs) {
  const n = Math.min(ts.length, vs.length);
  if (n < 5) return NaN;
  let s1 = 0;
  for (let i = 1; i < n; i++) s1 += 0.5 * (vs[i] + vs[i - 1]) * (ts[i] - ts[i - 1]);
  const T = ts[n - 1] - ts[0];
  if (!(T > 0)) return NaN;
  const mean = s1 / T;
  let eMax = -Infinity;
  let eMin = Infinity;
  let peaks = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = vs[i - 1] - mean;
    const b = vs[i] - mean;
    const c = vs[i + 1] - mean;
    if (!(b > a && b >= c)) continue;
    const den = a - 2 * b + c;
    const peak = den < 0 ? b - ((a - c) * (a - c)) / (8 * den) : b;
    const e = Math.max(peak, 0);
    if (e > eMax) eMax = e;
    if (e < eMin) eMin = e;
    peaks++;
  }
  if (peaks < 3 || !(eMax > 0)) return NaN;
  return (eMax - eMin) / (eMax + eMin);
}

/**
 * 区間 [fromSec, toSec] の時間平均（台形積分 / 区間長）。
 */
export function averageOver(time, values, fromSec, toSec) {
  const t0 = Math.max(fromSec, time[0]);
  const t1 = Math.min(toSec, time[time.length - 1]);
  if (!(t1 > t0)) return null;
  let acc = 0;
  let tPrev = t0;
  let vPrev = interpolateAt(time, values, t0);
  for (let i = 0; i < time.length; i++) {
    if (time[i] <= t0) continue;
    if (time[i] >= t1) break;
    acc += 0.5 * (vPrev + values[i]) * (time[i] - tPrev);
    tPrev = time[i];
    vPrev = values[i];
  }
  const vEnd = interpolateAt(time, values, t1);
  acc += 0.5 * (vPrev + vEnd) * (t1 - tPrev);
  return acc / (t1 - t0);
}
