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
const VAR_WIN_S = 0.3;    // window for the accel-spread stillness test
const MERGE_GAP_S = 0.4;  // pauses shorter than this don't split a move
const MIN_RUN_S = 0.35;   // shorter bursts (Stop tap, start bump) are not the move
const KNOCK_ACC = 6;      // m/s^2 spike near the end of the move = phone knocked onto the surface
const KNOCK_WIN_S = 0.6;
const KNOCK_MAX_RATE = 150; // Hz: above this a knock is sampled properly and doesn't matter
const STAGE_GAP_S = 0.8;  // a still pause at least this long splits the move into stages
const TRUST_WORLD_ROT = 10 * Math.PI / 180; // rotation beyond which world accel isn't used for stillness
const FUSED_REF_S = 0.3;  // average the phone-fusion reference attitude over the still start

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
  // Chrome rounds accel to 0.1 m/s^2, so a phone lying still already shows ~0.06 spread.
  return { still: a.std < 0.1 && gyroMag < 0.05, accStd: a.std, gyroMag };
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

  // Chrome rounds readings to 0.1 m/s^2; native Android data is not rounded.
  const quantized = still.every((s) => [s.ax, s.ay, s.az].every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6));

  return { gMag, gyroBias: g.mean, q0, accStd: a.std, gyroStd: g.std, n: still.length, quantized,
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

// Orientation-independent stillness: a still phone gives a constant accelerometer vector
// (whatever its attitude or scale errors) and ~zero bias-corrected gyro. Judged on the local
// spread of the raw accel vector over a short window plus smoothed gyro rate.
function stillThresholds(cal) {
  // With Chrome's 0.1 m/s^2 rounding a still phone can flicker by ~0.09 across 3 axes; unrounded
  // native data is quiet enough for a tighter floor.
  return { thrA: Math.max(cal.quantized ? 0.12 : 0.05, 2.5 * cal.accStd), thrG: Math.max(0.03, 2.5 * cal.gyroStd + 0.01) };
}

// How long to hold still mid-move, live, so the processing reliably treats it as a checkpoint.
// Checked against real recordings: pauses the processing split on measured 0.85-1.2 s live.
export const CHECKPOINT_HOLD_S = STAGE_GAP_S + 0.2;

// Live check with the same test the processing uses: is the phone still over this window?
// Pass roughly the last VAR_WIN_S seconds of samples.
export function windowIsStill(win, cal) {
  if (win.length < 5) return false;
  const { thrA, thrG } = stillThresholds(cal);
  const a = meanStd(win, acc);
  const g = norm(sub(meanStd(win, gyr).mean, cal.gyroBias));
  return a.std < thrA && g < thrG;
}
export const STILL_WINDOW_S = VAR_WIN_S;

function stillFlags(samples, cal) {
  const a = samples.map(acc);
  const mean = smooth(samples, a, VAR_WIN_S);
  const sq = smooth(samples, a.map((v) => [v[0] * v[0], v[1] * v[1], v[2] * v[2]]), VAR_WIN_S);
  const g = smooth(samples, samples.map((s) => sub(gyr(s), cal.gyroBias)), SMOOTH_S);
  const { thrA, thrG } = stillThresholds(cal);
  return a.map((_, i) => {
    const varSum = sq[i][0] - mean[i][0] ** 2 + sq[i][1] - mean[i][1] ** 2 + sq[i][2] - mean[i][2] ** 2;
    return Math.sqrt(Math.max(0, varSum)) < thrA && norm(g[i]) < thrG;
  });
}

// World-frame linear acceleration (gravity removed with the gyro-tracked attitude) sees the
// first instant of motion, even a slow slide. Only trusted for finding the START of motion:
// after the phone has turned, sensor scale errors leave residual gravity that looks like motion.
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
export function processRecording(calibSamples, samples, opts = {}) {
  const cal = calibrate(calibSamples);
  const warnings = [];
  let n = samples.length;
  if (n < 10) throw new Error('Not enough samples recorded.');

  const t0 = samples[0].t;
  let tEnd = samples[n - 1].t;

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

  // Optionally replace the attitude with the phone's own sensor fusion (RelativeOrientationSensor),
  // which runs on the full-rate, unrounded gyro. Only its rotation relative to the first sample is
  // used, applied to our gravity-derived start attitude, so its arbitrary heading doesn't matter.
  let fusedConvention = null;
  if (opts.orientation === 'fused') {
    if (!samples.every((s) => s.qw != null && s.qx != null)) throw new Error('No phone orientation data in this recording.');
    const qf = samples.map((s) => qNormalize([s.qw, s.qx, s.qy, s.qz]));
    const conj = (a) => [a[0], -a[1], -a[2], -a[3]];
    // Reference = average over the still start (one sample's noise would otherwise become a
    // constant tilt error for the whole recording).
    const acc0 = [0, 0, 0, 0];
    for (let i = 0; i < n && samples[i].t - t0 <= FUSED_REF_S; i++) {
      const sgn = qf[i][0] * qf[0][0] + qf[i][1] * qf[0][1] + qf[i][2] * qf[0][2] + qf[i][3] * qf[0][3] < 0 ? -1 : 1;
      for (let k = 0; k < 4; k++) acc0[k] += sgn * qf[i][k];
    }
    const ref = qNormalize(acc0);
    // The sensor quaternion may map device->reference or reference->device; pick whichever
    // agrees with the gyro-integrated attitude.
    const candA = qf.map((f) => qMul(cal.q0, qMul(conj(ref), f)));
    const candB = qf.map((f) => qMul(cal.q0, qMul(ref, conj(f))));
    const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    let errA = 0, errB = 0;
    for (let i = 0; i < n; i++) { errA += angleBetween(candA[i], q[i]); errB += angleBetween(candB[i], q[i]); }
    fusedConvention = errA <= errB ? 'A' : 'B';
    const cand = fusedConvention === 'A' ? candA : candB;
    for (let i = 0; i < n; i++) q[i] = cand[i];
  }

  // Detect the motion window from uncorrected world-frame linear acceleration + gyro.
  const linAccW = samples.map((s, i) => sub(qRotate(q[i], acc(s)), [0, 0, cal.gMag]));
  const moving = movingFlags(samples, linAccW, cal.gyroBias);
  const still = stillFlags(samples, cal);
  // A slow slide without turning barely changes the raw accel, so the spread test misses it.
  // World-frame acceleration sees it, and is trustworthy until the phone has turned noticeably.
  let turned = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) turned += norm(sub(gyr(samples[i]), cal.gyroBias)) * (samples[i].t - samples[i - 1].t);
    if (moving[i] && turned < TRUST_WORLD_ROT) still[i] = false;
  }

  // Runs of non-stillness, with short still gaps merged. Brief blips are not the move: on a
  // real phone they are the tap on Stop, or a bump when recording starts.
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (still[i]) continue;
    let j = i;
    while (j + 1 < n && !still[j + 1]) j++;
    const prev = runs[runs.length - 1];
    if (prev && samples[i].t - samples[prev.b].t < MERGE_GAP_S) prev.b = j; else runs.push({ a: i, b: j });
    i = j;
  }
  const real = runs.filter((r) => samples[r.b].t - samples[r.a].t >= MIN_RUN_S);

  if (!real.length) {
    return { cal, still: true, delta: [0, 0, 0], path: [{ t: 0, p: [0, 0, 0] }], motionStart: 0, motionEnd: 0,
             quality: grade(cal, { endHold: tEnd - t0, duration: 0, endVel: 0, tilt: 0 }, ['No movement detected.']) };
  }
  // Stages: moves separated by a still pause long enough to act as a checkpoint. Each pause
  // resets velocity to zero and re-anchors the tilt/gravity correction, so drift cannot build
  // up across the whole move. A move with no such pause is a single stage.
  const groups = [{ a: real[0].a, b: real[0].b }];
  for (const r of real.slice(1)) {
    const g = groups[groups.length - 1];
    if (samples[r.a].t - samples[g.b].t < (opts.stageGap ?? STAGE_GAP_S)) g.b = r.b; else groups.push({ a: r.a, b: r.b });
  }
  const iLastRaw = groups[groups.length - 1].b;
  // A slow start barely changes the raw accel; world-frame acceleration sees it earlier.
  while (groups[0].a > 0 && moving[groups[0].a - 1]) groups[0].a--;

  // Drop anything after the end hold (the Stop tap) so it can't spoil the end-hold correction.
  const tail = runs.find((r) => r.a > iLastRaw);
  if (tail) {
    n = tail.a;
    samples = samples.slice(0, n);
    tEnd = samples[n - 1].t;
  }
  const sampleRate = (n - 1) / (tEnd - t0);

  // A knock when the phone is set down can be too brief to sample at browser rates (~55 Hz), so
  // its velocity change is lost. At native rates (hundreds of Hz) it is captured properly.
  let knock = 0;
  for (let i = iLastRaw; i >= 0 && samples[i].t >= samples[iLastRaw].t - KNOCK_WIN_S; i--) {
    knock = Math.max(knock, Math.abs(norm(acc(samples[i])) - cal.gMag));
  }
  const knockMatters = knock > KNOCK_ACC && sampleRate < KNOCK_MAX_RATE;
  if (knockMatters) {
    warnings.push(`Phone was set down with a knock (${knock.toFixed(1)} m/s²) — stop just above the surface and set it down gently.`);
  }

  // Expand each stage by a margin, never eating more than a third of a neighbouring pause.
  const stages = groups.map((g, k) => {
    const before = k === 0 ? MARGIN_S * 3 : samples[g.a].t - samples[groups[k - 1].b].t;
    const after = k === groups.length - 1 ? MARGIN_S * 3 : samples[groups[k + 1].a].t - samples[g.b].t;
    let a = g.a, b = g.b;
    const tS = Math.max(t0, samples[a].t - Math.min(MARGIN_S, before / 3));
    const tE = Math.min(tEnd, samples[b].t + Math.min(MARGIN_S, after / 3));
    while (a > 0 && samples[a - 1].t >= tS) a--;
    while (b < n - 1 && samples[b + 1].t <= tE) b++;
    return { a, b };
  });
  stages.forEach((s, k) => { s.holdEnd = k < stages.length - 1 ? stages[k + 1].a - 1 : n - 1; });
  const iFirst = stages[0].a;
  const iLast = stages[stages.length - 1].b;
  const endHold = tEnd - samples[iLast].t;
  if (endHold < 0.5) warnings.push('Phone was not held still before Stop — end-of-move correction is weak.');

  // Cumulative rotation, used to phase in orientation-caused corrections within each stage.
  const rotCum = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    rotCum[i] = rotCum[i - 1] + norm(sub(gyr(samples[i]), cal.gyroBias)) * (samples[i].t - samples[i - 1].t);
  }

  const v = new Array(n).fill(null).map(() => [0, 0, 0]);
  let qCorr = [1, 0, 0, 0];   // tilt corrections from earlier stages, carried forward
  let gCur = cal.gMag;        // gravity magnitude as seen in the current attitude
  for (const st of stages) {
    const { a, b, holdEnd } = st;
    const span = samples[b].t - samples[a].t;
    const fracT = (i) => (i <= a ? 0 : i >= b ? 1 : (samples[i].t - samples[a].t) / span);
    const rotSpan = rotCum[b] - rotCum[a];
    const fracR = rotSpan > 5 * Math.PI / 180 ? (i) => Math.min(1, Math.max(0, (rotCum[i] - rotCum[a]) / rotSpan)) : fracT;

    // 2. Hold correction: once still again, the rotated specific force must point straight up
    //    with the same size as gravity. Tilt mismatch (gyro scale error) and magnitude mismatch
    //    (accel scale error) come from the phone turning, so they are phased in by rotation.
    let tilt = 0, tiltAxis = [0, 0, 1], gHold = gCur;
    if (holdEnd - b >= 5) {
      const gSum = [0, 0, 0], aSum = [0, 0, 0];
      for (let i = b + 1; i <= holdEnd; i++) {
        const w = qRotate(qMul(qCorr, q[i]), acc(samples[i]));
        for (let k = 0; k < 3; k++) { gSum[k] += w[k]; aSum[k] += acc(samples[i])[k]; }
      }
      gHold = norm(aSum) / (holdEnd - b);
      const gW = unit(gSum);
      tiltAxis = cross(gW, [0, 0, 1]);
      tilt = Math.atan2(norm(tiltAxis), gW[2]);
    }

    // 3. World-frame linear acceleration within the stage.
    const aw = [];
    for (let i = a; i <= b; i++) {
      const f = fracR(i);
      let qi = qMul(qCorr, q[i]);
      if (tilt > 0) qi = qMul(qFromAxisAngle(tiltAxis, tilt * f), qi);
      const w = qRotate(qi, acc(samples[i]));
      aw.push([w[0], w[1], w[2] - (gCur + (gHold - gCur) * f)]);
    }

    // 4. Integrate velocity from rest, then zero-velocity update at the hold: remove the residual
    //    as a linear ramp (equivalent to a constant acceleration bias over the stage).
    for (let i = a + 1; i <= b; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      for (let k = 0; k < 3; k++) v[i][k] = v[i - 1][k] + 0.5 * (aw[i - a][k] + aw[i - 1 - a][k]) * dt;
    }
    const vEnd = v[b].slice();
    const frac = opts.zupt === 'rotation' ? fracR : fracT;
    for (let i = a; i <= b; i++) {
      const f = frac(i);
      for (let k = 0; k < 3; k++) v[i][k] -= vEnd[k] * f;
    }
    Object.assign(st, { vEnd, tilt, duration: span });

    if (tilt > 0) qCorr = qMul(qFromAxisAngle(tiltAxis, tilt), qCorr);
    gCur = gHold;
  }

  // 5. Integrate position (velocity is zero outside the stages).
  const path = [];
  let p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dt = samples[i].t - samples[i - 1].t;
      p = [0, 1, 2].map((k) => p[k] + 0.5 * (v[i][k] + v[i - 1][k]) * dt);
    }
    path.push({ t: samples[i].t - t0, p: p.slice() });
  }

  // Drift grows with time within a stage, so judge the longest stage, not the whole recording.
  const worst = stages.reduce((w, s) => (norm(s.vEnd) > norm(w.vEnd) ? s : w));
  const duration = Math.max(...stages.map((s) => s.duration));
  const tilt = Math.max(...stages.map((s) => s.tilt));
  if (duration > 8) warnings.push(`A move took ${duration.toFixed(1)} s — drift grows fast with time; aim for under 5 s, or pause still for a second part-way.`);
  const quality = grade(cal, { endHold, duration, endVel: norm(worst.vEnd), tilt, knock: knockMatters ? knock : 0 }, warnings);

  return { cal, still: false, delta: p, path, quality,
           motionStart: samples[iFirst].t - t0, motionEnd: samples[iLast].t - t0,
           stages: stages.map((s) => ({ start: samples[s.a].t - t0, end: samples[s.b].t - t0, drift: norm(s.vEnd), tiltDeg: s.tilt * 180 / Math.PI })),
           endVelocityCorrected: worst.vEnd, tiltCorrectionDeg: tilt * 180 / Math.PI,
           sampleRate, knock, orientation: opts.orientation || 'gyro', fusedConvention };
}

function grade(cal, m, warnings) {
  let score = 0; // higher is worse
  if (cal.accStd > 0.1 || cal.gyroStd > 0.03) { score += 1; warnings.push('Start hold was a bit shaky.'); }
  if (m.endHold < 0.5) score += 2; else if (m.endHold < 1.5) score += 1;
  if (m.duration > 8) score += 2; else if (m.duration > 5) score += 1;
  if (m.endVel > 0.5) { score += 2; warnings.push(`Large drift corrected (${m.endVel.toFixed(2)} m/s).`); }
  else if (m.endVel > 0.2) score += 1;
  if (m.knock > KNOCK_ACC) score += 2;
  if (m.tilt * 180 / Math.PI > 3) { score += 1; warnings.push(`Gyro drift of ${(m.tilt * 180 / Math.PI).toFixed(1)}° corrected.`); }
  const level = score === 0 ? 'good' : score <= 2 ? 'fair' : 'poor';
  return { level, score, endHold: m.endHold, duration: m.duration, endVel: m.endVel, warnings };
}
