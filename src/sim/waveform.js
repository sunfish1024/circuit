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
