// IMU processing: calibration, orientation tracking, double integration with
// zero-velocity drift correction at both ends.
//
// Input samples: { t: seconds, ax, ay, az: m/s^2 specific force (includes
// gravity, reads ~+9.81 on the axis pointing up when at rest), gx, gy, gz: rad/s }
// all in the phone's device frame (x = right, y = top of phone, z = out of screen).
//
// World frame of the result: Z = up, Y = direction the top of the phone pointed
// at the start (flattened to horizontal), X = right of that.

const STILL_ACC = 0.1;    // m/s^2 smoothed world linear acceleration still counted as stationary
const STILL_GYRO = 0.05;  // rad/s smoothed, bias-corrected
const SMOOTH_S = 0.15;    // window for the motion detector
const MARGIN_S = 0.3;     // integrate slightly beyond detected motion edges

// ---------- small vector / quaternion helpers ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a) => scale(a, 1 / norm(a));

function qMul(a, b) { // [w, x, y, z]
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function qNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
function qFromAxisAngle(axis, angle) {
  const n = norm(axis);
  if (n < 1e-12 || Math.abs(angle) < 1e-12) return [1, 0, 0, 0];
  const s = Math.sin(angle / 2) / n;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
function qRotate(q, v) { // rotate vector v by q (device -> world)
  const p = qMul(qMul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [p[1], p[2], p[3]];
}
function qFromRows(r) { // rotation matrix given as rows -> quaternion
  const [m00, m01, m02] = r[0], [m10, m11, m12] = r[1], [m20, m21, m22] = r[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return qNormalize(q);
}

const acc = (s) => [s.ax, s.ay, s.az];
const gyr = (s) => [s.gx, s.gy, s.gz];

function meanStd(samples, fn) {
  const n = samples.length;
  const m = [0, 0, 0];
  for (const s of samples) { const v = fn(s); m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; }
  m[0] /= n; m[1] /= n; m[2] /= n;
  let v2 = 0;
  for (const s of samples) { const d = sub(fn(s), m); v2 += dot(d, d); }
  return { mean: m, std: Math.sqrt(v2 / n) };
}

// Live check used by the UI during the start hold.
export function stillnessOf(samples) {
  if (samples.length < 5) return { still: false, accStd: Infinity, gyroMag: Infinity };
  const a = meanStd(samples, acc);
  const g = meanStd(samples, gyr);
  const gyroMag = norm(g.mean) + g.std;
  return { still: a.std < 0.08 && gyroMag < 0.05, accStd: a.std, gyroMag };
}

// Calibrate from stationary samples: gravity direction/magnitude, gyro bias, initial attitude.
export function calibrate(still) {
  const a = meanStd(still, acc);
  const g = meanStd(still, gyr);
  const gMag = norm(a.mean);
  const up = unit(a.mean); // world up, in device coordinates

  // Forward = top of phone flattened to horizontal. If the phone is upright
  // (top pointing up) use the back of the phone (-z) instead.
  let fwd = [0, 1, 0];
  let fh = sub(fwd, scale(up, dot(fwd, up)));
  if (norm(fh) < 0.35) { fwd = [0, 0, -1]; fh = sub(fwd, scale(up, dot(fwd, up))); }
  const yw = unit(fh);
  const xw = cross(yw, up);
  const q0 = qFromRows([xw, yw, up]);

  return { gMag, gyroBias: g.mean, q0, accStd: a.std, gyroStd: g.std, n: still.length,
           forwardAxis: fwd[1] === 1 ? 'top' : 'back' };
}

// Centred moving average of 3-vectors over a time window.
function smooth(samples, vecs, win) {
  const out = new Array(vecs.length);
  let lo = 0, hi = -1;
  const sum = [0, 0, 0];
  for (let i = 0; i < vecs.length; i++) {
    while (hi + 1 < vecs.length && samples[hi + 1].t <= samples[i].t + win / 2) {
      hi++; for (let k = 0; k < 3; k++) sum[k] += vecs[hi][k];
    }
    while (samples[lo].t < samples[i].t - win / 2) {
      for (let k = 0; k < 3; k++) sum[k] -= vecs[lo][k]; lo++;
    }
    out[i] = scale(sum, 1 / (hi - lo + 1));
  }
  return out;
}

// Motion is judged on world-frame linear acceleration (gravity removed using the
// gyro-tracked attitude) so horizontal moves are seen as clearly as vertical ones.
function movingFlags(samples, linAccW, gyroBias) {
  const a = smooth(samples, linAccW, SMOOTH_S);
  const g = smooth(samples, samples.map((s) => sub(gyr(s), gyroBias)), SMOOTH_S);
  const raw = a.map((v, i) => norm(v) > STILL_ACC || norm(g[i]) > STILL_GYRO);
  // Dilate over a short window so brief zero-crossings mid-move don't split the motion.
  const out = new Array(raw.length).fill(false);
  let j0 = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i]) continue;
    while (samples[j0].t < samples[i].t - SMOOTH_S) j0++;
    for (let j = j0; j < raw.length && samples[j].t <= samples[i].t + SMOOTH_S; j++) out[j] = true;
  }
  return out;
}

/**
 * @param {Array} calibSamples stationary samples captured before Start
 * @param {Array} samples recorded samples (start hold -> move -> end hold)
 */
export function processRecording(calibSamples, samples) {
  const cal = calibrate(calibSamples);
  const warnings = [];
  const n = samples.length;
  if (n < 10) throw new Error('Not enough samples recorded.');

  const t0 = samples[0].t;
  const tEnd = samples[n - 1].t;

  // 1. Orientation: integrate bias-corrected gyro from the calibrated start attitude.
  const q = new Array(n);
  q[0] = cal.q0;
  for (let i = 1; i < n; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    const w = sub(scale([samples[i].gx + samples[i - 1].gx, samples[i].gy + samples[i - 1].gy,
                         samples[i].gz + samples[i - 1].gz], 0.5), cal.gyroBias);
    const angle = norm(w) * dt;
    q[i] = qNormalize(qMul(q[i - 1], qFromAxisAngle(w, angle)));
  }

  // Detect the motion window from uncorrected world-frame linear acceleration + gyro.
  const linAccW = samples.map((s, i) => sub(qRotate(q[i], acc(s)), [0, 0, cal.gMag]));
  const moving = movingFlags(samples, linAccW, cal.gyroBias);
  let iFirst = moving.indexOf(true);
  let iLast = moving.lastIndexOf(true);

  if (iFirst < 0) {
    return { cal, still: true, delta: [0, 0, 0], path: [{ t: 0, p: [0, 0, 0] }], motionStart: 0, motionEnd: 0,
             quality: grade(cal, { endHold: tEnd - t0, duration: 0, endVel: 0, tilt: 0 }, ['No movement detected.']) };
  }

  // Expand by a margin, clamped to the recording.
  const tS = Math.max(t0, samples[iFirst].t - MARGIN_S);
  const tE = Math.min(tEnd, samples[iLast].t + MARGIN_S);
  while (iFirst > 0 && samples[iFirst - 1].t >= tS) iFirst--;
  while (iLast < n - 1 && samples[iLast + 1].t <= tE) iLast++;
  const endHold = tEnd - samples[iLast].t;
  if (endHold < 0.5) warnings.push('Phone was not held still before Stop — end-of-move correction is weak.');

  // 2. Tilt correction: at the end hold the rotated specific force must point straight up.
  //    Any mismatch is gyro drift; spread its correction linearly over the move.
  let tilt = 0;
  let tiltAxis = [0, 0, 1];
  const endStill = samples.slice(iLast + 1);
  if (endStill.length >= 5) {
    const gEndW = unit(qRotate(q[n - 1], meanStd(endStill, acc).mean));
    const c = cross(gEndW, [0, 0, 1]);
    tilt = Math.atan2(norm(c), gEndW[2]);
    tiltAxis = c;
  }
  const span = samples[iLast].t - samples[iFirst].t;
  const frac = (i) => (i <= iFirst ? 0 : i >= iLast ? 1 : (samples[i].t - samples[iFirst].t) / span);

  // 3. World-frame linear acceleration.
  const aw = new Array(n);
  for (let i = 0; i < n; i++) {
    let qi = q[i];
    if (tilt > 0) qi = qMul(qFromAxisAngle(tiltAxis, tilt * frac(i)), qi);
    const a = qRotate(qi, acc(samples[i]));
    aw[i] = [a[0], a[1], a[2] - cal.gMag];
  }

  // 4. Integrate velocity over the motion window only (outside it the phone is still).
  const v = new Array(n).fill(null).map(() => [0, 0, 0]);
  for (let i = iFirst + 1; i <= iLast; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    for (let k = 0; k < 3; k++) v[i][k] = v[i - 1][k] + 0.5 * (aw[i][k] + aw[i - 1][k]) * dt;
  }
  // Zero-velocity update: velocity must be zero at the end; remove the residual as a
  // linear ramp (equivalent to a constant acceleration bias over the move).
  const vEnd = v[iLast].slice();
  for (let i = iFirst; i <= iLast; i++) {
    const f = frac(i);
    for (let k = 0; k < 3; k++) v[i][k] -= vEnd[k] * f;
  }

  // 5. Integrate position.
  const path = [];
  let p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (i > iFirst && i <= iLast) {
      const dt = samples[i].t - samples[i - 1].t;
      p = [0, 1, 2].map((k) => p[k] + 0.5 * (v[i][k] + v[i - 1][k]) * dt);
    }
    path.push({ t: samples[i].t - t0, p: p.slice() });
  }

  const duration = span;
  if (duration > 8) warnings.push(`Move took ${duration.toFixed(1)} s — drift grows fast with time; aim for under 5 s.`);
  const quality = grade(cal, { endHold, duration, endVel: norm(vEnd), tilt }, warnings);

  return { cal, still: false, delta: p, path, quality,
           motionStart: samples[iFirst].t - t0, motionEnd: samples[iLast].t - t0,
           endVelocityCorrected: vEnd, tiltCorrectionDeg: tilt * 180 / Math.PI,
           sampleRate: (n - 1) / (tEnd - t0) };
}

function grade(cal, m, warnings) {
  let score = 0; // higher is worse
  if (cal.accStd > 0.05 || cal.gyroStd > 0.03) { score += 1; warnings.push('Start hold was a bit shaky.'); }
  if (m.endHold < 0.5) score += 2; else if (m.endHold < 1.5) score += 1;
  if (m.duration > 8) score += 2; else if (m.duration > 5) score += 1;
  if (m.endVel > 0.5) { score += 2; warnings.push(`Large drift corrected (${m.endVel.toFixed(2)} m/s).`); }
  else if (m.endVel > 0.2) score += 1;
  if (m.tilt * 180 / Math.PI > 3) { score += 1; warnings.push(`Gyro drift of ${(m.tilt * 180 / Math.PI).toFixed(1)}° corrected.`); }
  const level = score === 0 ? 'good' : score <= 2 ? 'fair' : 'poor';
  return { level, score, endHold: m.endHold, duration: m.duration, endVel: m.endVel, warnings };
}
