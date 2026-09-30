// Synthetic IMU data generator (ES module). Deterministic given a seed.
export const G = 9.80665;

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// quaternions [w,x,y,z], q rotates device -> world
export function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export function qAxisAngle(axis, ang) {
  const n = Math.hypot(...axis);
  if (n < 1e-15) return [1, 0, 0, 0];
  const s = Math.sin(ang / 2) / n;
  return [Math.cos(ang / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
export function qRot(q, v) {
  const p = qMul(qMul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [p[1], p[2], p[3]];
}
export const qInv = (q) => [q[0], -q[1], -q[2], -q[3]];

// minimum-jerk profile and derivatives w.r.t. real time (T = move duration)
export function minJerk(t, T) {
  if (t <= 0) return { s: 0, v: 0, a: 0 };
  if (t >= T) return { s: 1, v: 0, a: 0 };
  const u = t / T;
  return {
    s: 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5,
    v: (30 * u ** 2 - 60 * u ** 3 + 30 * u ** 4) / T,
    a: (60 * u - 180 * u ** 2 + 120 * u ** 3) / (T * T),
  };
}

const DEFAULTS = {
  calibSec: 2, preHold: 1, moveSec: 2, postHold: 2, rate: 100,
  D: [-0.02, 1.5, 0.75],
  pitchDeg: 0, rollDeg: 0,
  rotAxis: [1, 1, 0.3], rotDeg: 0,
  accNoise: 0, accBias: [0, 0, 0], gyroNoise: 0, gyroBias: [0, 0, 0],
  accScale: [1, 1, 1], gyroScale: [1, 1, 1],   // per-axis scale factor errors (real phones: ~0.5–2%)
  jitter: 0, seed: 1,
};

// Returns { calibSamples, samples, truth(t) } ; recording time t is relative to calibration start
export function generate(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rand = mulberry32(o.seed);
  const dt = 1 / o.rate;
  const q0 = qMul(qAxisAngle([1, 0, 0], o.pitchDeg * Math.PI / 180), qAxisAngle([0, 1, 0], o.rollDeg * Math.PI / 180));
  const thMax = o.rotDeg * Math.PI / 180;
  const axN = Math.hypot(...o.rotAxis);
  const axU = o.rotAxis.map((c) => c / axN);
  const recStart = o.calibSec;
  const moveStart = recStart + o.preHold, moveEnd = moveStart + o.moveSec;
  const total = moveEnd + o.postHold;

  function truth(t) {
    const m = minJerk(t - moveStart, o.moveSec);
    const th = thMax * m.s, thd = thMax * m.v;
    const q = qMul(q0, qAxisAngle(axU, th));
    const aw = o.D.map((d) => d * m.a);
    const pos = o.D.map((d) => d * m.s);
    const fdev = qRot(qInv(q), [aw[0], aw[1], aw[2] + G]);
    return { q, aw, pos, fdev, omega: axU.map((c) => c * thd) };
  }

  const nTot = Math.floor(total * o.rate) + 1;
  const all = [];
  let last = -Infinity;
  for (let i = 0; i < nTot; i++) {
    let t = i * dt;
    if (o.jitter > 0 && i > 0) t += (rand() * 2 - 1) * o.jitter * dt;
    if (t <= last) t = last + 1e-6;
    last = t;
    const tr = truth(t);
    const s = { t };
    ['ax', 'ay', 'az'].forEach((k, j) => { s[k] = tr.fdev[j] * o.accScale[j] + o.accBias[j] + (o.accNoise ? o.accNoise * gaussian(rand) : 0); });
    ['gx', 'gy', 'gz'].forEach((k, j) => { s[k] = tr.omega[j] * o.gyroScale[j] + o.gyroBias[j] + (o.gyroNoise ? o.gyroNoise * gaussian(rand) : 0); });
    all.push(s);
  }
  const calibSamples = all.filter((s) => s.t < recStart);
  const samples = all.filter((s) => s.t >= recStart);
  return { calibSamples, samples, truth, opts: o, moveStart, moveEnd, recStart };
}
