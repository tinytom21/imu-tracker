// Sensor calibration: fixes the phone's own accelerometer and gyro scale errors, which no amount of
// processing can see during a measurement (they make distances read long and turns read too far).
// Pure functions (no DOM). Samples are { t (s), ax, ay, az (m/s^2), gx, gy, gz (rad/s) }.
//
// One recording, two parts:
//  1. Six faces: the phone held still on each face (screen up/down, each edge down). Gravity is the
//     reference: every still reading must have magnitude g, which gives each accel axis its bias
//     and gain. The turns between faces are checked against gravity too: the gyro-tracked rotation
//     must carry the gravity direction from one face to the next, which gives the X/Y gyro gains.
//  2. Full turns: flat against a straight edge, one full turn each way and back against the edge.
//     The gyro must add up to exactly 360 degrees - the direct check on the heading (Z) gain.
//
// Correction (applied by processing.js applySensorCal): a = (raw - accBias) * accGain, w = raw * gyroGain.

export const G_LOCAL = 9.81;          // UK ~9.812; within 0.3% anywhere on Earth
const BLOCK_S = 0.2;                  // stillness is judged in blocks this long
const STILL_ACC = 0.12;               // m/s^2, spread of the accel vector within a block
const STILL_GYRO = 0.05;              // rad/s
const MIN_STILL_S = 1.2;              // a pose must be held at least this long
const TRIM_S = 0.15;                  // ignore the edges of each hold
const FACE_COS = 0.8;                 // a face counts when gravity is this close to one axis
const TURN_MIN = 300 * Math.PI / 180; // a full turn: 360 degrees give or take the edge alignment
const LIMIT_GAIN = 0.05, LIMIT_BIAS = 0.6;

const FACES = [
  { key: '+z', axis: 2, sign: 1, label: 'screen up' },
  { key: '-z', axis: 2, sign: -1, label: 'screen down' },
  { key: '+y', axis: 1, sign: 1, label: 'top edge up' },
  { key: '-y', axis: 1, sign: -1, label: 'bottom edge up' },
  { key: '+x', axis: 0, sign: 1, label: 'right edge up' },
  { key: '-x', axis: 0, sign: -1, label: 'left edge up' },
];
export { FACES };

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const unit = (v) => { const n = norm(v); return [v[0] / n, v[1] / n, v[2] / n]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function qMul(a, b) {
  return [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
          a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
}
function qStep(w, dt) {
  const ang = norm(w) * dt;
  if (ang < 1e-12) return [1, 0, 0, 0];
  const s = Math.sin(ang / 2) / norm(w);
  return [Math.cos(ang / 2), w[0] * s, w[1] * s, w[2] * s];
}
// Vector given in the start frame, expressed in the frame q has rotated to (q: device -> start).
function qRotInv(q, v) {
  const c = [q[0], -q[1], -q[2], -q[3]];
  const p = qMul(qMul(c, [0, v[0], v[1], v[2]]), q);
  return [p[1], p[2], p[3]];
}
const acc = (s) => [s.ax, s.ay, s.az];
const gyr = (s) => [s.gx, s.gy, s.gz];
function mean(samples, fn) {
  const m = [0, 0, 0];
  for (const s of samples) { const v = fn(s); m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; }
  return m.map((x) => x / samples.length);
}

// Which face a gravity reading (device frame) is on, or null if the phone is between faces.
export function faceOf(a) {
  const n = norm(a);
  for (const f of FACES) if (f.sign * a[f.axis] / n > FACE_COS) return f.key;
  return null;
}

// Still holds: runs of still blocks, at least MIN_STILL_S long, edges trimmed. Index ranges [a, b].
export function stillSegments(samples) {
  const blocks = [];
  let i = 0;
  while (i < samples.length) {
    let j = i;
    while (j + 1 < samples.length && samples[j + 1].t - samples[i].t < BLOCK_S) j++;
    const blk = samples.slice(i, j + 1);
    const m = mean(blk, acc);
    const spread = Math.sqrt(blk.reduce((s, x) => { const d = sub(acc(x), m); return s + dot(d, d); }, 0) / blk.length);
    const still = blk.length >= 3 && spread < STILL_ACC && norm(mean(blk, gyr)) < STILL_GYRO
      && blk.every((x) => norm(gyr(x)) < 3 * STILL_GYRO);
    blocks.push({ a: i, b: j, still });
    i = j + 1;
  }
  const segs = [];
  for (let k = 0; k < blocks.length; k++) {
    if (!blocks[k].still) continue;
    let e = k;
    while (e + 1 < blocks.length && blocks[e + 1].still) e++;
    const tA = samples[blocks[k].a].t + TRIM_S, tB = samples[blocks[e].b].t - TRIM_S;
    if (tB - tA >= MIN_STILL_S - 2 * TRIM_S) {
      let a = blocks[k].a, b = blocks[e].b;
      while (samples[a].t < tA) a++;
      while (samples[b].t > tB) b--;
      segs.push({ a, b });
    }
    k = e;
  }
  return segs.map((s) => {
    const part = samples.slice(s.a, s.b + 1);
    const m = mean(part, acc);
    return { ...s, t0: samples[s.a].t, t1: samples[s.b].t, acc: m, gyro: mean(part, gyr), face: faceOf(m) };
  });
}

// Small dense solver (Gaussian elimination, partial pivoting).
function solve(A, y) {
  const n = y.length, M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-15) return null;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
// Least squares by Gauss-Newton with a numerical Jacobian (a handful of parameters).
function gaussNewton(resFn, x0, iters = 12) {
  let x = x0.slice();
  for (let it = 0; it < iters; it++) {
    const r0 = resFn(x);
    const J = x.map((_, j) => { const h = 1e-6, xp = x.slice(); xp[j] += h; return resFn(xp).map((v, i) => (v - r0[i]) / h); });
    const A = x.map((_, i) => x.map((__, j) => r0.reduce((s, ___, k) => s + J[i][k] * J[j][k], 0) + (i === j ? 1e-12 : 0)));
    const y = x.map((_, i) => -r0.reduce((s, v, k) => s + J[i][k] * v, 0));
    const dx = solve(A, y);
    if (!dx) break;
    x = x.map((v, i) => v + dx[i]);
    if (Math.max(...dx.map(Math.abs)) < 1e-10) break;
  }
  const r = resFn(x);
  return { x, rms: Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length) };
}

// Rotation (device at end -> device at start) from integrating the gyro over samples a..b.
function integrate(samples, a, b, bias, gain) {
  let q = [1, 0, 0, 0];
  for (let i = a + 1; i <= b; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    const w = [0, 1, 2].map((k) => 0.5 * ((gyr(samples[i])[k] + gyr(samples[i - 1])[k]) - 2 * bias[k]) * gain[k]);
    q = qMul(q, qStep(w, dt));
  }
  return q;
}

/**
 * Fit the calibration from one recording of the six faces and the turns.
 * Returns { ok, errors[], accBias, accGain, gyroGain, detail } - gains are corrections (true = raw x gain).
 */
export function fitSensorCal(samples) {
  const errors = [];
  const segs = stillSegments(samples);
  const seen = new Set(segs.map((s) => s.face).filter(Boolean));
  const missing = FACES.filter((f) => !seen.has(f.key));
  if (missing.length) errors.push(`Missing: ${missing.map((f) => f.label).join(', ')}.`);
  if (errors.length) return { ok: false, errors, detail: { holds: segs.length } };

  // 1. Accelerometer: every still hold must read g. Six faces make it fully determined; repeats add checks.
  const accFit = gaussNewton(([bx, by, bz, kx, ky, kz]) => segs.map((s) =>
    norm([(s.acc[0] - bx) * kx, (s.acc[1] - by) * ky, (s.acc[2] - bz) * kz]) - G_LOCAL), [0, 0, 0, 1, 1, 1]);
  const accBias = accFit.x.slice(0, 3), accGain = accFit.x.slice(3);
  const gUnit = (s) => unit([0, 1, 2].map((k) => (s.acc[k] - accBias[k]) * accGain[k]));

  // Gyro bias drifts a little; use the average of the holds either side of each move.
  const moves = [];
  for (let k = 0; k + 1 < segs.length; k++) {
    const A = segs[k], B = segs[k + 1];
    moves.push({ A, B, bias: [0, 1, 2].map((j) => (A.gyro[j] + B.gyro[j]) / 2) });
  }

  // 2. Full turns, flat: chains of holds on the same flat face; cumulative angle about gravity.
  const turns = [];
  let chainStart = null, cum = 0, cumRaw = 0;
  for (const mv of moves) {
    const flat = (s) => s.face === '+z' || s.face === '-z';
    if (!(flat(mv.A) && flat(mv.B) && mv.A.face === mv.B.face)) { chainStart = null; continue; }
    if (chainStart === null) { chainStart = mv.A; cum = 0; cumRaw = 0; }
    const up = gUnit(mv.A);
    // Angle about the vertical, from the bias-free raw gyro (no gain applied yet).
    for (let i = mv.A.b + 1; i <= mv.B.a; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      const w = sub(gyr(samples[i]), mv.bias);
      cumRaw += dot(w, up) * dt;
    }
    cum = cumRaw;
    const n = Math.round(Math.abs(cum) / (2 * Math.PI));
    if (Math.abs(cum) >= TURN_MIN && n >= 1 && Math.abs(Math.abs(cum) - n * 2 * Math.PI) < Math.PI / 6) {
      turns.push({ measuredDeg: cum * 180 / Math.PI, gain: n * 2 * Math.PI / Math.abs(cum), axis: mv.A.face });
      chainStart = mv.B; cumRaw = 0; // next turn measured from here
    }
  }

  // 3. Gyro gains from gravity: the tracked rotation between faces must carry gravity across.
  //    Rotation about gravity itself is invisible here, so tipping moves (not the flat turns) count.
  const tips = moves.filter((mv) => mv.A.face !== mv.B.face);
  const gravRes = (gain) => tips.flatMap((mv) => {
    const q = integrate(samples, mv.A.b, mv.B.a, mv.bias, gain);
    const pred = qRotInv(q, gUnit(mv.A));
    return sub(pred, gUnit(mv.B));
  });
  const gravFit = tips.length >= 3 ? gaussNewton(gravRes, [1, 1, 1], 8) : null;
  if (!turns.length) errors.push('No full turn found: lay the phone flat against an edge, turn it all the way round and back against the edge.');
  let gyroGain = gravFit ? gravFit.x.slice() : [1, 1, 1];
  let zFromTurns = null;
  if (turns.length) {
    zFromTurns = turns.reduce((s, t) => s + t.gain, 0) / turns.length;
    // The turns measure Z directly and more precisely; refit X/Y with Z held at that value.
    const xyFit = tips.length >= 3 ? gaussNewton(([gx, gy]) => gravRes([gx, gy, zFromTurns]), [1, 1], 8) : null;
    gyroGain = xyFit ? [xyFit.x[0], xyFit.x[1], zFromTurns] : [gyroGain[0], gyroGain[1], zFromTurns];
  }

  if (accGain.some((k) => Math.abs(k - 1) > LIMIT_GAIN) || accBias.some((b) => Math.abs(b) > LIMIT_BIAS)) {
    errors.push('Accelerometer result is outside what a working phone shows — a pose was probably not held still. Try again.');
  }
  if (gyroGain.some((k) => !Number.isFinite(k) || Math.abs(k - 1) > LIMIT_GAIN)) {
    errors.push('Gyro result is outside what a working phone shows — a turn probably did not end back against the edge. Try again.');
  }
  const detail = {
    holds: segs.length, faces: FACES.map((f) => ({ key: f.key, label: f.label, holds: segs.filter((s) => s.face === f.key).length })),
    accResidualMs2: accFit.rms,               // with only six holds this is ~0 by construction
    gyroGravityResidualDeg: gravFit ? Math.asin(Math.min(1, gravFit.rms)) * 180 / Math.PI : null,
    gyroGainFromGravity: gravFit ? gravFit.x : null, zFromTurns, turns, tips: tips.length,
  };
  return { ok: !errors.length, errors, accBias, accGain, gyroGain, detail };
}
