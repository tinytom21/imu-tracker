// IMU Tracker UI: idle -> calibrating -> recording -> result.
// Modules are loaded with the release version in their URL so a new release bypasses the cache.
const V = new URL(import.meta.url).searchParams.get('v') || Date.now();
const { stillnessOf, processRecording, calibrate, windowIsStill, STILL_WINDOW_S, CHECKPOINT_HOLD_S } =
  await import(`./processing.js?v=${V}`);
const { Capture } = await import(`./capture.js?v=${V}`);
const { createViz } = await import(`./viz.js?v=${V}`);

const CALIB_S = 2.0;      // required continuous stillness at start
const CALIB_WIN_S = 0.4;  // short window used to track continuous stillness
const END_STILL_S = 1.5;  // window for the "safe to press Stop" check
const MINUS = '−';
const CP_EVAL_S = 0.05;   // checkpoint stillness evaluated at ~20 Hz
const CP_FLASH_MS = 1500;

// Live checkpoint detection. Drive with update(recSamples, nowT) (nowT = seconds on the sample clock).
// A checkpoint registers once the phone has moved and then stayed continuously still for CHECKPOINT_HOLD_S.
class CheckpointTracker {
  constructor(calSamples) { this.cal = calibrate(calSamples); this.reset(); }
  reset() {
    this.count = 0; this.moved = false; // recording starts right after a still calibration hold this.stillSince = null; this.lastEval = -Infinity;
    this.still = false; this.progress = 0; this.registered = false;
  }
  // Returns { still, moved, progress (0..1), count, registered (true only on the update that registers) }.
  update(samples, nowT) {
    this.registered = false;
    if (samples.length < 5 || nowT - this.lastEval < CP_EVAL_S) return this.state();
    this.lastEval = nowT;
    this.still = windowIsStill(lastWindow(samples, STILL_WINDOW_S), this.cal);
    if (!this.still) {
      this.moved = true; this.stillSince = null; this.progress = 0;
    } else if (this.moved) {
      // The window being still means stillness began about one window ago.
      if (this.stillSince === null) this.stillSince = nowT - STILL_WINDOW_S;
      this.progress = Math.min(1, (nowT - this.stillSince) / CHECKPOINT_HOLD_S);
      if (this.progress >= 1) {
        this.count++; this.moved = false; this.registered = true; this.stillSince = null; this.progress = 0;
      }
    }
    return this.state();
  }
  state() {
    return { still: this.still, moved: this.moved, progress: this.progress, count: this.count, registered: this.registered };
  }
}
window.CheckpointTracker = CheckpointTracker;

const $ = (id) => document.getElementById(id);
const el = {
  banner: $('banner'), idle: $('idle'), calib: $('calib'), rec: $('rec'), result: $('result'),
  main: $('main'), calibMsg: $('calibMsg'), calibBar: $('calibBar'), calibNote: $('calibNote'),
  cpMsg: $('cpMsg'), cpBar: $('cpBar'), cpCount: $('cpCount'),
  recStatus: $('recStatus'), recTime: $('recTime'), recRate: $('recRate'), recNote: $('recNote'),
  rows: $('rows'), compare: $('compare'), total: $('total'), badge: $('badge'), warnings: $('warnings'), details: $('details'),
  dl: $('dl'), csv: $('csv'),
};

let state = 'idle';           // idle | starting | calibrating | recording | result
let buf = [];                 // rolling calibration buffer
let calibSamples = [];
let recSamples = [];
let stillStart = null;
let wakeLock = null;
let tick = null;
let cpTick = null;
let cpTracker = null;
let cpFlashUntil = 0;
let audioCtx = null;
let sourceLabel = '–';
let viz = null;

// ---------------------------------------------------------------- helpers
function showError(msg) {
  el.banner.textContent = msg;
  el.banner.hidden = false;
}
const clearError = () => { el.banner.hidden = true; };

function setState(s) {
  state = s;
  el.idle.hidden = s !== 'idle' && s !== 'result';
  el.calib.hidden = s !== 'calibrating';
  el.rec.hidden = s !== 'recording';
  el.main.classList.toggle('stop', s === 'recording');
  el.main.disabled = s === 'starting';
  el.main.textContent = { idle: 'Start', starting: 'Starting…', calibrating: 'Cancel', recording: 'Stop', result: 'Start' }[s];
  // The instructions are only useful before a run.
  el.idle.hidden = s !== 'idle';
}

async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* not critical */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

const capture = new Capture({
  onSample(s) {
    if (state === 'calibrating') {
      buf.push(s);
      while (buf.length && buf[0].t < s.t - CALIB_S - 1) buf.shift();
    } else if (state === 'recording') {
      recSamples.push(s);
    }
  },
  onError(e) { abortRun(); showError('Sensor error: ' + (e.message || e.name)); },
});

function lastWindow(samples, seconds) {
  const tEnd = samples[samples.length - 1].t;
  let i = samples.length - 1;
  while (i > 0 && samples[i - 1].t >= tEnd - seconds) i--;
  return samples.slice(i);
}

function stopTicker() { clearInterval(tick); tick = null; clearInterval(cpTick); cpTick = null; }

function beep() {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.12);
  } catch { /* optional */ }
}

function renderCheckpoint(s) {
  const flashing = performance.now() < cpFlashUntil;
  if (s.registered) {
    cpFlashUntil = performance.now() + CP_FLASH_MS;
    el.cpMsg.textContent = `✓ Checkpoint ${s.count} — carry on (or press Stop)`;
    el.cpMsg.classList.add('flash');
    beep();
  } else if (!flashing) {
    el.cpMsg.classList.remove('flash');
    el.cpMsg.textContent = s.moved && s.still ? 'Hold still…' : ' ';
  }
  el.cpBar.style.width = ((flashing || s.registered) ? 100 : s.progress * 100).toFixed(0) + '%';
  el.cpCount.textContent = 'Checkpoints: ' + s.count;
  el.cpCount.classList.toggle('has', s.count > 0);
}

function checkpointTick() {
  if (state !== 'recording' || !cpTracker || recSamples.length < 5) return;
  renderCheckpoint(cpTracker.update(recSamples, recSamples[recSamples.length - 1].t));
}

function abortRun() {
  stopTicker();
  capture.stop();
  releaseWakeLock();
  setState('idle');
}

// ---------------------------------------------------------------- run flow
async function onMainClick() {
  if (state === 'idle' || state === 'result') return startRun();
  if (state === 'calibrating') return abortRun();
  if (state === 'recording') return finishRun();
}

async function startRun() {
  clearError();
  setState('starting');
  try {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); }
    catch { audioCtx = null; }
    await capture.requestPermission(); // first await inside the click handler (iOS)
    buf = []; calibSamples = []; recSamples = []; stillStart = null;
    await capture.start();
  } catch (e) {
    setState('idle');
    showError(e.message || String(e));
    return;
  }
  if (state !== 'starting') { capture.stop(); return; }
  sourceLabel = capture.source;
  acquireWakeLock();
  el.result.hidden = true;
  el.calibBar.style.width = '0%';
  el.calibMsg.textContent = 'Hold still…';
  el.calibNote.hidden = true;
  el.recNote.hidden = true;
  setState('calibrating');
  tick = setInterval(calibTick, 100);
}

function calibTick() {
  if (state !== 'calibrating' || buf.length < 5) return;
  const last = buf[buf.length - 1];
  const win = lastWindow(buf, CALIB_WIN_S);
  if (last.t - win[0].t < CALIB_WIN_S * 0.8) return;

  if (stillnessOf(win).still) {
    if (stillStart === null) { stillStart = win[0].t; el.calibMsg.textContent = 'Hold still…'; }
  } else if (stillStart !== null) {
    stillStart = null;
    el.calibMsg.textContent = 'Moved — keep it still';
  }
  const progress = stillStart === null ? 0 : Math.min(1, (last.t - stillStart) / CALIB_S);
  el.calibBar.style.width = (progress * 100).toFixed(0) + '%';

  if (progress >= 1) {
    const hold = lastWindow(buf, CALIB_S);
    if (!stillnessOf(hold).still) { stillStart = null; return; } // 2 s window not clean after all
    calibSamples = hold;
    // Top pointing nearly straight up -> forward is taken from the back of the phone.
    const n = hold.length;
    const m = [0, 0, 0];
    for (const s of hold) { m[0] += s.ax / n; m[1] += s.ay / n; m[2] += s.az / n; }
    const up = m[1] / Math.hypot(...m);
    el.recNote.hidden = !(up > 0.937);
    el.recNote.textContent = 'Phone is upright: forward (+Y) is taken from the back of the phone.';
    recSamples = [];
    buf = [];
    stopTicker();
    try { cpTracker = new CheckpointTracker(calibSamples); } catch { cpTracker = null; }
    cpFlashUntil = 0;
    renderCheckpoint({ still: false, moved: false, progress: 0, count: 0, registered: false });
    setState('recording');
    tick = setInterval(recTick, 150);
    cpTick = setInterval(checkpointTick, CP_EVAL_S * 1000);
  }
}

function recTick() {
  if (state !== 'recording' || recSamples.length < 2) return;
  const elapsed = recSamples[recSamples.length - 1].t - recSamples[0].t;
  el.recTime.textContent = elapsed.toFixed(1) + ' s';
  el.recRate.textContent = Math.round(capture.sampleRate) + ' Hz';
  const win = lastWindow(recSamples, END_STILL_S);
  const still = elapsed >= END_STILL_S && win[win.length - 1].t - win[0].t >= END_STILL_S * 0.9 && stillnessOf(win).still;
  el.recStatus.textContent = still ? 'Still — safe to press Stop' : 'Moving…';
  el.recStatus.classList.toggle('still', still);
}

function finishRun() {
  stopTicker();
  capture.stop();
  releaseWakeLock();
  setState('idle');
  showResult(calibSamples, recSamples, sourceLabel);
}

// ---------------------------------------------------------------- results
const mm = (m) => Math.round(m * 1000);
function signed(v) {
  const r = mm(v);
  return (r < 0 ? MINUS : '+') + Math.abs(r);
}

function showResult(calib, rec, source) {
  let res;
  try {
    res = processRecording(calib, rec);
  } catch (e) {
    showError('Processing failed: ' + e.message);
    return;
  }
  const hasQ = rec.length > 0 && rec.every((s) => s.qw != null);
  let fused = null, fusedErr = null;
  if (hasQ) {
    try {
      fused = processRecording(calib, rec, { orientation: 'fused' });
    } catch (e) {
      fusedErr = e.message || String(e);
    }
  }
  el.dl.disabled = false;
  if (el.share) el.share.disabled = false;
  el.result.hidden = false;

  const [x, y, z] = res.delta;
  el.rows.innerHTML = '';
  for (const [v, axis, label] of [[z, 'Z', 'up'], [y, 'Y', 'forward'], [x, 'X', 'right']]) {
    const d = document.createElement('div');
    d.className = 'row';
    d.innerHTML = `${signed(v)} mm ${axis} <small>(${label})</small>`;
    el.rows.appendChild(d);
  }
  el.total.innerHTML = `Straight-line distance: <b>${mm(Math.hypot(x, y, z))} mm</b>`;

  // comparison of methods
  // (diagnostics only: lives in a collapsed <details> at the bottom of the details area)
  el.compare.innerHTML = '';
  el.details.after(el.compare);
  const diag = document.createElement('details');
  diag.className = 'diag';
  const diagSum = document.createElement('summary');
  diagSum.textContent = 'Diagnostics: phone fusion comparison';
  diag.appendChild(diagSum);
  el.compare.appendChild(diag);
  diag.addEventListener('toggle', () => {
    viz?.update(res.path, diag.open && fused ? fused.path : null);
  });
  const fusionWarnings = [];
  if (fused) {
    const cell = (tag, text) => { const c = document.createElement(tag); c.textContent = text; return c; };
    const table = document.createElement('table');
    table.className = 'cmp-table';
    const head = table.createTHead().insertRow();
    for (const h of ['Method', 'X', 'Y', 'Z', 'Drift']) head.appendChild(cell('th', h));
    const body = table.createTBody();
    for (const [name, r] of [['Gyro (app)', res], ['Phone fusion', fused]]) {
      const row = body.insertRow();
      row.appendChild(cell('th', name));
      for (const v of r.delta) row.appendChild(cell('td', signed(v)));
      row.appendChild(cell('td', r.quality.endVel.toFixed(2)));
    }
    const cap = document.createElement('div');
    cap.className = 'cmp-unit';
    // The velocity left over at the end hold is what the correction had to remove: a method whose
    // orientation was right needs little, so lower drift = more self-consistent.
    cap.textContent = 'mm · Drift = leftover speed removed at the end (m/s), lower is more trustworthy';
    const dnote = document.createElement('p');
    dnote.className = 'cmp-note';
    dnote.textContent = 'Phone fusion is shown for diagnostics only; it has been less accurate than the gyro method in real tests.';
    diag.append(table, cap, dnote);
  } else {
    const p = document.createElement('p');
    p.className = 'cmp-note';
    p.textContent = hasQ
      ? 'Phone fusion failed: ' + fusedErr
      : 'Phone fusion: not available on this device/browser';
    diag.appendChild(p);
  }

  const q = res.quality;
  el.badge.textContent = q.level;
  el.badge.className = 'badge ' + q.level;
  el.warnings.innerHTML = '';
  const shown = new Set(q.warnings);
  const warnList = [...q.warnings];
  if (fused) {
    for (const w of fused.quality.warnings) {
      if (!shown.has(w)) { shown.add(w); fusionWarnings.push('Phone fusion: ' + w); }
    }
  }
  if (fusionWarnings.length) {
    const ul = document.createElement('ul');
    ul.className = 'cmp-warn';
    for (const w of fusionWarnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    }
    diag.appendChild(ul);
  }
  for (const w of warnList) {
    const li = document.createElement('li');
    li.textContent = w;
    el.warnings.appendChild(li);
  }

  const drift = res.endVelocityCorrected ? Math.hypot(...res.endVelocityCorrected) : 0;
  const details = [
    res.stages && res.stages.length > 1
      ? ['Stages', `${res.stages.length} (paused still between) · longest ${q.duration.toFixed(2)} s`]
      : ['Move duration', q.duration.toFixed(2) + ' s'],
    ['End hold', q.endHold.toFixed(2) + ' s'],
    ['Sample rate', (res.sampleRate ?? 0).toFixed(0) + ' Hz'],
    ['Sensor source', source],
    ['Drift corrected', drift.toFixed(3) + ' m/s'],
    ['Tilt correction', (res.tiltCorrectionDeg ?? 0).toFixed(2) + '°'],
    ['Forward axis', res.cal.forwardAxis],
    ['Orientation sensor', hasQ ? 'yes' : 'no'],
    ['App version', window.APP_VERSION || '?'],
  ];
  if (window.AndroidIMU) {
    try {
      const i = JSON.parse(window.AndroidIMU.info());
      const hz = (v) => (v > 0 ? ` (max ${Math.round(v)} Hz)` : '');
      details.push(['Sensors', [
        `accel: ${i.accelName}${hz(i.accelMaxHz)}`,
        `gyro: ${i.gyroName}${hz(i.gyroMaxHz)}`,
        `rot: ${i.rotName || 'none'}`,
      ].join(' | ')]);
    } catch { /* info unavailable */ }
  }
  el.details.innerHTML = '';
  for (const [k, v] of details) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    el.details.append(dt, dd);
  }
  viz?.update(res.path, null);
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- CSV
function toCsv(calib, rec) {
  const lines = ['phase,t,ax,ay,az,gx,gy,gz,qx,qy,qz,qw'];
  const q = (v) => (v == null ? '' : v);
  for (const [phase, arr] of [['calib', calib], ['rec', rec]]) {
    for (const s of arr) {
      lines.push([phase, s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz, q(s.qx), q(s.qy), q(s.qz), q(s.qw)].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift()?.split(',').map((h) => h.trim());
  const want = ['phase', 't', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'];
  if (!head || want.some((w) => !head.includes(w))) throw new Error('CSV header must be: ' + want.join(','));
  const idx = Object.fromEntries(want.map((w) => [w, head.indexOf(w)]));
  const qidx = Object.fromEntries(['qx', 'qy', 'qz', 'qw'].map((w) => [w, head.indexOf(w)]));
  const calib = [], rec = [];
  lines.forEach((line, i) => {
    const c = line.split(',');
    const s = { t: +c[idx.t], ax: +c[idx.ax], ay: +c[idx.ay], az: +c[idx.az], gx: +c[idx.gx], gy: +c[idx.gy], gz: +c[idx.gz] };
    if (Object.values(s).some((v) => !Number.isFinite(v))) throw new Error(`Bad number on CSV line ${i + 2}`);
    // Optional quaternion columns: all four must be present and finite, else null.
    const qv = ['qx', 'qy', 'qz', 'qw'].map((k) => {
      const raw = qidx[k] >= 0 ? (c[qidx[k]] ?? '').trim() : '';
      return raw === '' ? null : +raw;
    });
    const qOk = qv.every((v) => v !== null && Number.isFinite(v));
    [s.qx, s.qy, s.qz, s.qw] = qOk ? qv : [null, null, null, null];
    const phase = c[idx.phase].trim();
    if (phase === 'calib') calib.push(s);
    else if (phase === 'rec') rec.push(s);
    else throw new Error(`Unknown phase "${phase}" on CSV line ${i + 2}`);
  });
  if (calib.length < 5 || rec.length < 10) throw new Error('CSV has too few calib/rec rows.');
  return { calib, rec };
}

const csvFileName = () => `imu-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

if (window.AndroidIMU) {
  // Blob downloads don't work in a WebView: save via MediaStore or hand to the share sheet.
  el.dl.textContent = 'Save CSV to phone';
  el.share = document.createElement('button');
  el.share.className = 'secondary';
  el.share.type = 'button';
  el.share.textContent = 'Share CSV…';
  el.share.disabled = el.dl.disabled;
  el.dl.after(el.share);
  const saveNote = document.createElement('p');
  saveNote.className = 'version';
  saveNote.hidden = true;
  el.dl.parentNode.after(saveNote);
  el.share.addEventListener('click', () => {
    try {
      window.AndroidIMU.shareCsv(csvFileName(), toCsv(calibSamples, recSamples));
    } catch (e) {
      showError('Could not share CSV: ' + (e.message || e));
    }
  });
  el.dl.addEventListener('click', () => {
    saveNote.hidden = true;
    try {
      const r = JSON.parse(window.AndroidIMU.saveCsv(csvFileName(), toCsv(calibSamples, recSamples)));
      if (r.ok) {
        clearError();
        saveNote.textContent = 'Saved to ' + r.path;
        saveNote.hidden = false;
      } else {
        showError('Could not save CSV: ' + (r.error || 'unknown error'));
      }
    } catch (e) {
      showError('Could not save CSV: ' + (e.message || e));
    }
  });
} else {
  el.dl.addEventListener('click', downloadCsvBlob);
}

function downloadCsvBlob() {
  const blob = new Blob([toCsv(calibSamples, recSamples)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `imu-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

el.csv.addEventListener('change', async () => {
  const file = el.csv.files[0];
  el.csv.value = '';
  if (!file) return;
  clearError();
  try {
    const { calib, rec } = parseCsv(await file.text());
    calibSamples = calib; recSamples = rec;
    sourceLabel = 'csv';
    showResult(calib, rec, 'csv: ' + file.name);
  } catch (e) {
    showError('Could not load CSV: ' + e.message);
  }
});

// ---------------------------------------------------------------- init
el.main.addEventListener('click', onMainClick);
window.addEventListener('error', (e) => showError('Error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => showError('Error: ' + (e.reason?.message || e.reason)));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (state === 'calibrating' || state === 'recording')) acquireWakeLock();
});
setState('idle');
createViz({ view3d: $('view3d'), plotTop: $('plotTop'), plotSide: $('plotSide'), legend: $('legend') })
  .then((v) => { viz = v; })
  .catch((e) => showError('Visualisation failed: ' + e.message));
