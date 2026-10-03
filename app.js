// Offset UI: idle -> calibrating -> recording -> result.
// Modules are loaded with the release version in their URL so a new release bypasses the cache.
const V = new URL(import.meta.url).searchParams.get('v') || Date.now();
const { stillnessOf, processRecording, singleFromLoop, calibrate, windowIsStill, STILL_WINDOW_S, CHECKPOINT_HOLD_S } =
  await import(`./processing.js?v=${V}`);
const { Capture } = await import(`./capture.js?v=${V}`);
const { createViz } = await import(`./viz.js?v=${V}`);
const { initContribute } = await import(`./contribute.js?v=${V}`);
const { summarize, summaryText } = await import(`./session.js?v=${V}`);
const { initSensorCalUI, activeSensorCal } = await import(`./calui.js?v=${V}`);
// Runs loaded from a CSV file can't be contributed (dev switch: ?devContribute=1).
const DEV_CONTRIBUTE = new URLSearchParams(location.search).get('devContribute') === '1';
const contributeReady = initContribute().catch((e) => { console.warn('Contribute unavailable:', e); return null; });
// Android app: offer a newer APK if the website has one. Never allowed to break the app.
contributeReady
  .then(() => import(`./update.js?v=${V}`))
  .then(({ initUpdateCheck }) => initUpdateCheck(window.__imuConfig || {}))
  .catch((e) => console.warn('Update check unavailable:', e));

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
    this.count = 0; this.moved = false; // recording starts right after a still calibration hold
    this.stillSince = null; this.lastEval = -Infinity;
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
  rows: $('rows'), single: $('single'), singleTable: $('singleTable'), compare: $('compare'), total: $('total'), badge: $('badge'), warnings: $('warnings'), details: $('details'),
  dl: $('dl'), csv: $('csv'),
  modeSingle: $('modeSingle'), modeLoop: $('modeLoop'), stepsLoop: $('stepsLoop'), stepsSingle: $('stepsSingle'),
  modeBadge: $('modeBadge'), rowsLabel: $('rowsLabel'),
  session: $('session'), sessTitle: $('sessTitle'), sessBody: $('sessBody'), sessAdd: $('sessAdd'), sessModeAsk: $('sessModeAsk'),
  pointsRow: $('pointsRow'), survey: $('survey'), surveyTable: $('surveyTable'), baselines: $('baselines'),
};

// Loop mode can visit 1-3 points (e.g. antenna 1, antenna 2) before returning to the start.
let numPoints = 1;
try { const n = +localStorage.getItem('imuPoints'); if (n >= 1 && n <= 3) numPoints = n; } catch { /* ignore */ }
// Sensor calibration (calui.js) goes into every processing call while it is switched on.
const calField = () => { const c = activeSensorCal(); return c ? { sensorCal: { accBias: c.accBias, accGain: c.accGain, gyroGain: c.gyroGain } } : {}; };
const loopOpts = () => ({ ...(loopMode ? { loop: true, points: numPoints } : {}), ...calField() });
const ptName = (k) => (numPoints === 2 ? `antenna ${k}` : `point ${k}`);

function renderLoopSteps() {
  const N = numPoints;
  const li = (html) => `<li>${html}</li>`;
  const out = [
    li('Place the phone <b>flat</b> against a straight edge (table edge, box, ruler). <b>Remember exactly where it sits</b>: this is the start spot.'),
    li('Press <b>Start</b> and keep it <b>completely still</b> until the button turns red.'),
  ];
  if (N === 1) {
    out.push(li('Move smoothly to the far point and hold <b>completely still</b> until the green <b>✓ Far point recorded</b> tick appears. Don\'t pause on the way there.'));
  } else {
    for (let k = 1; k <= N; k++) {
      out.push(li(`Move smoothly to <b>${ptName(k)}</b> and hold <b>completely still</b> until the green tick appears.${k === 1 ? ' Don\'t pause on the way there.' : ''}`));
    }
  }
  out.push(li('Bring it back to <b>exactly the same spot and orientation</b> (same edge), without pausing, and set it down <b>gently</b>.'));
  out.push(li(N === 1
    ? 'Hold still until the green tick appears, then press <b>Stop</b>. The result is start to far point, with drift removed.'
    : 'Hold still until the green tick appears, then press <b>Stop</b>. <b>Don\'t pause anywhere else.</b> The result is start to each point, with drift removed.'));
  el.stepsLoop.innerHTML = out.join('');
}
function setPoints(n, save = true) {
  numPoints = n;
  for (const b of el.pointsRow.querySelectorAll('[data-points]')) b.setAttribute('aria-checked', String(+b.dataset.points === n));
  renderLoopSteps();
  if (save) { try { localStorage.setItem('imuPoints', String(n)); } catch { /* ignore */ } }
}
for (const b of el.pointsRow.querySelectorAll('[data-points]')) b.addEventListener('click', () => guardChange(loopMode, +b.dataset.points, () => setPoints(+b.dataset.points)));

// Instructions fold away so Start stays on screen; open/closed is remembered.
{
  const howto = $('howto');
  try { howto.open = localStorage.getItem('imuHowto') === '1'; } catch { /* ignore */ }
  howto.addEventListener('toggle', () => { try { localStorage.setItem('imuHowto', howto.open ? '1' : '0'); } catch { /* ignore */ } });
}

// Loop mode: go A -> B, hold, return to exactly A, hold. Persisted across reloads.
let loopMode = false;
try { loopMode = localStorage.getItem('imuMode') === 'loop'; } catch { /* storage unavailable */ }
function setMode(loop, save = true) {
  loopMode = loop;
  el.modeSingle.setAttribute('aria-checked', String(!loop));
  el.modeLoop.setAttribute('aria-checked', String(loop));
  el.stepsLoop.hidden = !loop;
  el.pointsRow.hidden = !loop;
  el.stepsSingle.hidden = loop;
  if (save) { try { localStorage.setItem('imuMode', loop ? 'loop' : 'single'); } catch { /* ignore */ } }
}
el.modeSingle.addEventListener('click', () => guardChange(false, 1, () => setMode(false)));
el.modeLoop.addEventListener('click', () => guardChange(true, numPoints, () => setMode(true)));
setMode(loopMode, false);
setPoints(numPoints, false);

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

// ---------------------------------------------------------------- session (repeat runs -> mean +/- error bar)
const SESS_KEY = 'imuSession';
const blankSession = (mode = 'single', points = 1) => ({ mode, points, runs: [], include: [], exclude: [], nextId: 1, ref: null });
function loadSession() {
  try {
    const o = JSON.parse(localStorage.getItem(SESS_KEY));
    if (!o || !Array.isArray(o.runs)) return blankSession();
    const okPt = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
    const runs = o.runs.filter((r) => r && Number.isFinite(r.id) && r.values && Array.isArray(r.values.points)
      && r.values.points.length && r.values.points.every(okPt)).map((r) => ({
      id: r.id, time: +r.time || 0,
      values: { points: r.values.points, baselines: Array.isArray(r.values.baselines) ? r.values.baselines.filter((b) => b && Number.isFinite(b.mm)) : [],
        ...(okPt(r.values.single) ? { single: r.values.single } : {}) },
      ...(okPt(r.values.single) && r.singleQuality ? { singleQuality: String(r.singleQuality) } : {}),
      quality: String(r.quality || ''), warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
      loopGapMm: Number.isFinite(r.loopGapMm) ? r.loopGapMm : null,
      ...(r.sensorCal ? { sensorCal: true } : {}),
    }));
    const ids = runs.map((r) => r.id);
    const s = blankSession(o.mode === 'loop' ? 'loop' : 'single', o.mode === 'loop' && o.points >= 1 && o.points <= 3 ? +o.points : 1);
    s.runs = runs;
    s.include = (Array.isArray(o.include) ? o.include : []).filter((i) => ids.includes(i));
    s.exclude = (Array.isArray(o.exclude) ? o.exclude : []).filter((i) => ids.includes(i));
    s.nextId = Math.max(+o.nextId || 1, ...ids.map((i) => i + 1), 1);
    s.ref = okPt(o.ref) ? o.ref : null;
    return s;
  } catch { return blankSession(); }
}
let sess = loadSession();
let refDraft = [];            // reference inputs as typed (a half-filled set must survive re-renders)
const resetRefDraft = () => { refDraft = sess.ref ? sess.ref.map(String) : ['', '', '']; };
resetRefDraft();
let currentRun = null;        // result on screen: { values, quality, warnings, loopGapMm, key, allowed, added }
let askClear = false;
let pendingChange = null;
const saveSession = () => { try { localStorage.setItem(SESS_KEY, JSON.stringify(sess)); } catch { /* ignore */ } };
const keyOf = (loop, n) => (loop ? `loop${n}` : 'single');
const uiKey = () => keyOf(loopMode, numPoints);
const sessKey = () => keyOf(sess.mode === 'loop', sess.points);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A session belongs to one mode + point count: show the screen to match it.
if (sess.runs.length) {
  setMode(sess.mode === 'loop', false);
  if (sess.mode === 'loop') setPoints(sess.points, false);
}

function guardChange(newLoop, newPts, apply) {
  const newKey = keyOf(newLoop, newPts);
  el.sessModeAsk.hidden = true; pendingChange = null;
  if (newKey === uiKey() || !sess.runs.length || newKey === sessKey()) { apply(); renderSession(); return; }
  pendingChange = { apply, newLoop, newPts };
  el.sessModeAsk.innerHTML = `<p>Start a new session? Your ${sess.runs.length} saved run${sess.runs.length === 1 ? '' : 's'} will be cleared.</p>
    <div class="sess-actions"><button type="button" class="sess-btn danger" data-act="modeYes">Start new session</button><button type="button" class="sess-btn" data-act="modeNo">Cancel</button></div>`;
  el.sessModeAsk.hidden = false;
}
el.sessModeAsk.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'modeYes' && pendingChange) {
    const { apply, newLoop, newPts } = pendingChange;
    sess = blankSession(newLoop ? 'loop' : 'single', newLoop ? newPts : 1);
    resetRefDraft(); saveSession(); apply();
  }
  pendingChange = null; el.sessModeAsk.hidden = true; renderSession();
});

function setCurrentRun(res, source, survey, single) {
  const pts = survey ? res.loop.points : [res.delta];
  currentRun = {
    values: {
      points: pts.map((p) => p.map(mm)),
      baselines: survey ? (res.loop.baselines || []).map((b) => ({ from: b.from, to: b.to, mm: Math.round(b.mm * 10) / 10 })) : [],
      ...(single ? { single: single.delta.map(mm) } : {}),
    },
    singleQuality: single ? single.quality.level : '',
    quality: res.quality.level, warnings: [...res.quality.warnings],
    loopGapMm: res.loop && Number.isFinite(res.loop.gapMm) ? Math.round(res.loop.gapMm) : null,
    sensorCal: !!activeSensorCal(),
    key: uiKey(), allowed: !String(source).startsWith('csv') || DEV_CONTRIBUTE, added: null,
  };
  updateAddButton();
  renderSession();
}
function updateAddButton() {
  const c = currentRun;
  el.sessAdd.hidden = !c || !c.allowed;
  if (el.sessAdd.hidden) return;
  if (c.added !== null && !sess.runs.some((r) => r.id === c.added)) c.added = null;
  el.sessAdd.disabled = c.added !== null || c.key !== uiKey();
  el.sessAdd.textContent = c.added !== null ? `Added ✓ (run ${c.added})` : c.key !== uiKey() ? 'Mode changed — repeat the run' : 'Add to session';
}
el.sessAdd.addEventListener('click', () => {
  const c = currentRun;
  if (!c || c.added !== null || c.key !== uiKey()) return;
  if (!sess.runs.length) sess = blankSession(loopMode ? 'loop' : 'single', loopMode ? numPoints : 1);
  const id = sess.nextId++;
  sess.runs.push({ id, time: Date.now(), values: c.values, quality: c.quality, warnings: c.warnings, loopGapMm: c.loopGapMm, sensorCal: c.sensorCal,
    ...(c.values.single ? { singleQuality: c.singleQuality } : {}) });
  c.added = id;
  saveSession(); renderSession();
});

const sessSummary = () => summarize(sess.runs.map((r) => ({ id: r.id, points: r.values.points, baselines: r.values.baselines })),
  { include: sess.include, exclude: sess.exclude });
const singleRuns = () => sess.runs.filter((r) => r.values.single);
const singleSummary = () => summarize(singleRuns().map((r) => ({ id: r.id, points: [r.values.single] })), { include: sess.include, exclude: sess.exclude });
const compareOn = () => sess.mode === 'loop' && sess.points === 1 && singleRuns().length >= 3;
const ptLabel = (p) => (sess.mode === 'loop' && sess.points >= 2 ? `Point ${p + 1}` : compareOn() ? 'Loop closure' : 'Result');
const fmtSigned = (v) => (Number.isFinite(v) ? (Math.round(v) < 0 ? MINUS : '+') + Math.abs(Math.round(v)) : '–');
const fmtMm = (v) => (Number.isFinite(v) ? (Math.round(v) < 0 ? MINUS : '') + Math.abs(Math.round(v)) : '–');
const fmtTime = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

function renderSession() {
  const runs = sess.runs;
  el.session.hidden = !runs.length || state === 'calibrating' || state === 'recording';
  updateAddButton();
  if (el.session.hidden) return;
  const sum = sessSummary();
  el.sessTitle.textContent = `Session · ${runs.length} run${runs.length === 1 ? '' : 's'} (${sum.used.length} used)`;
  let h = '';
  if (sum.used.length >= 3 && sum.points.length) {
    const ref = sess.ref;
    const table = (ax, label, r) => {
      let t = `<div class="rows-label">${esc(label)}</div><table class="cmp-table sess-table"><thead><tr><th></th><th>Mean</th><th>± accuracy</th><th>Run-to-run SD</th>${r ? '<th>Error of mean</th>' : ''}</tr></thead><tbody>`;
      ['X', 'Y', 'Z'].forEach((name, a) => {
        const s = ax[a];
        t += `<tr><th>${name}</th><td>${fmtMm(s.mean)}</td><td><b>± ${fmtMm(s.suggested)}</b></td><td>${fmtMm(s.std)}</td>${r ? `<td>${fmtSigned(s.mean - r[a])}</td>` : ''}</tr>`;
      });
      return t + '</tbody></table><div class="cmp-unit">mm</div>';
    };
    const errBlock = (label, vals, r) => {
      const e = vals.map((v) => v.map((x, a) => x - r[a]));
      const mae = [0, 1, 2].map((a) => e.reduce((t, v) => t + Math.abs(v[a]), 0) / e.length);
      const within = (lim) => e.filter((v) => v.every((x) => Math.abs(x) <= lim)).length;
      return `<li><b>${esc(label)}:</b> mean |error| ${mae.map(fmtMm).join(' / ')} mm (X / Y / Z); within ±150 mm: ${within(150)} of ${e.length}; within ±100 mm: ${within(100)} of ${e.length}</li>`;
    };
    const byId = (id) => runs.find((r) => r.id === id);
    const errs = [];
    sum.points.forEach((ax, p) => {
      h += table(ax, ptLabel(p), p === 0 ? ref : null);
      if (p === 0 && ref) errs.push(errBlock(ptLabel(0), sum.used.map((id) => byId(id).values.points[0]), ref));
    });
    if (compareOn()) {
      const ss = singleSummary();
      if (ss.used.length >= 3 && ss.points.length) {
        h += table(ss.points[0], 'Single move', ref);
        if (ref) errs.push(errBlock('Single move', ss.used.map((id) => byId(id).values.single), ref));
      }
    }
    if (errs.length) h += `<ul class="baselines sess-err">${errs.join('')}</ul>`;
    if (sum.baselines.length) {
      h += '<ul class="baselines">' + sum.baselines.map((b) => `<li>Point ${b.from} ↔ Point ${b.to}: ${fmtMm(b.mean)} ± ${fmtMm(b.ci95)} mm</li>`).join('') + '</ul>';
    }
    h += '<p class="cmp-note">± accuracy combines the spread between runs with a field-measured systematic allowance (60/60/40 mm), so it stays honest when the runs agree closely but share an offset.</p>';
  } else {
    h += '<p class="cmp-note">Do at least 3 runs to get an accuracy figure.</p>';
  }
  h += `<div class="rows-label sess-ref-label">Reference (tape/survey), mm${sess.mode === 'loop' && sess.points >= 2 ? ' — for point 1' : ''}</div><div class="sess-ref">`
    + ['X', 'Y', 'Z'].map((n, a) => `<label>${n}<input type="number" inputmode="decimal" step="any" data-ref="${a}" value="${esc(refDraft[a] ?? '')}"></label>`).join('') + '</div>';
  h += '<ul class="sess-runs">';
  for (const r of [...runs].reverse()) {
    const out = sum.outliers.includes(r.id), inc = sess.include.includes(r.id), exc = sess.exclude.includes(r.id);
    const multi = r.values.points.length > 1;
    const vals = r.values.points.map((p, i) => `${multi ? `P${i + 1}: ` : ''}X ${fmtMm(p[0])} · Y ${fmtMm(p[1])} · Z ${fmtMm(p[2])}`).join('<br>');
    const status = exc ? 'left out' : out && !inc ? 'outlier — not used' : out ? 'outlier — used anyway' : '';
    h += `<li class="sess-run${exc || (out && !inc) ? ' off' : ''}"><div class="sess-run-head"><b>Run ${r.id}</b><span>${esc(fmtTime(r.time))}</span>`
      + `${r.quality ? `<span class="badge ${esc(r.quality)} mini">${esc(r.quality)}</span>` : ''}${r.sensorCal ? '<span title="Sensor calibration applied">cal</span>' : ''}<button type="button" class="sess-x" data-act="del" data-id="${r.id}" aria-label="Delete run ${r.id}">✕</button></div>`
      + `<div class="sess-vals">${vals}</div>${r.values.single ? `<div class="sess-vals sess-single">Single: X ${fmtMm(r.values.single[0])} · Y ${fmtMm(r.values.single[1])} · Z ${fmtMm(r.values.single[2])}</div>` : ''}${status ? `<div class="sess-status">${status}</div>` : ''}<div class="sess-actions">`
      + (out && !exc ? `<button type="button" class="sess-btn" data-act="${inc ? 'unincl' : 'incl'}" data-id="${r.id}">${inc ? 'Ignore again' : 'Use anyway'}</button>` : '')
      + `<button type="button" class="sess-btn" data-act="${exc ? 'unexcl' : 'excl'}" data-id="${r.id}">${exc ? 'Use' : 'Leave out'}</button></div></li>`;
  }
  h += '</ul><div class="sess-foot">';
  h += '<button type="button" class="secondary" data-act="copy">Copy summary</button>';
  h += '<button type="button" class="secondary" data-act="csv">Download session CSV</button>';
  h += askClear
    ? `<div class="sess-confirm"><p>Clear all ${runs.length} run${runs.length === 1 ? '' : 's'}?</p><div class="sess-actions"><button type="button" class="sess-btn danger" data-act="clearYes">Yes, clear</button><button type="button" class="sess-btn" data-act="clearNo">Cancel</button></div></div>`
    : '<button type="button" class="secondary" data-act="clear">Clear session</button>';
  h += '</div><p class="version sess-msg" id="sessMsg" hidden></p>';
  el.sessBody.innerHTML = h;
}

function sessionCsv() {
  const sum = sessSummary();
  const runs = sess.runs;
  const nP = Math.max(...runs.map((r) => r.values.points.length));
  const withB = runs.reduce((a, r) => (r.values.baselines.length > a.values.baselines.length ? r : a), runs[0]);
  const bNames = withB.values.baselines.map((b) => `baseline_${b.from}_${b.to}_mm`);
  const head = ['run', 'time', 'quality', 'loop_gap_mm', 'status'];
  for (let p = 1; p <= nP; p++) head.push(`p${p}_x_mm`, `p${p}_y_mm`, `p${p}_z_mm`);
  head.push(...bNames, 'single_x_mm', 'single_y_mm', 'single_z_mm');
  if (sess.ref) head.push('ref_x_mm', 'ref_y_mm', 'ref_z_mm');
  const ss = singleRuns().length ? singleSummary() : null;
  const lines = [head.join(',')];
  for (const r of runs) {
    const out = sum.outliers.includes(r.id), inc = sess.include.includes(r.id), exc = sess.exclude.includes(r.id);
    const row = [r.id, new Date(r.time).toISOString(), r.quality, r.loopGapMm ?? '', exc ? 'left_out' : out && !inc ? 'outlier' : 'used'];
    for (let p = 0; p < nP; p++) row.push(...(r.values.points[p] || ['', '', '']));
    for (let b = 0; b < bNames.length; b++) row.push(r.values.baselines[b]?.mm ?? '');
    row.push(...(r.values.single || ['', '', '']));
    if (sess.ref) row.push('', '', '');
    lines.push(row.join(','));
  }
  if (sum.used.length >= 1) {
    const v = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : '');
    for (const [name, f] of [['mean', (s) => s.mean], ['accuracy', (s) => s.suggested], ['run_sd', (s) => s.std]]) {
      const row = [name, '', '', '', `${sum.used.length}_of_${sum.runs}`];
      for (let p = 0; p < nP; p++) row.push(...(sum.points[p] ? sum.points[p].map((s) => v(f(s))) : ['', '', '']));
      for (let b = 0; b < bNames.length; b++) {
        const bs = sum.baselines[b];
        row.push(bs ? v(name === 'mean' ? bs.mean : name === 'accuracy' ? bs.ci95 : bs.std) : '');
      }
      row.push(...(ss && ss.points[0] ? ss.points[0].map((s) => v(f(s))) : ['', '', '']));
      if (sess.ref) row.push('', '', '');
      lines.push(row.join(','));
    }
  }
  if (sess.ref) {
    const row = ['reference', '', '', '', '', ...Array(nP * 3 + bNames.length + 3).fill(''), ...sess.ref];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

el.sessBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act, id = +btn.dataset.id;
  const without = (arr) => arr.filter((i) => i !== id);
  const add = (arr) => (arr.includes(id) ? arr : [...arr, id]);
  if (act === 'incl') sess.include = add(sess.include);
  else if (act === 'unincl') sess.include = without(sess.include);
  else if (act === 'excl') sess.exclude = add(sess.exclude);
  else if (act === 'unexcl') sess.exclude = without(sess.exclude);
  else if (act === 'del') { sess.runs = sess.runs.filter((r) => r.id !== id); sess.include = without(sess.include); sess.exclude = without(sess.exclude); }
  else if (act === 'clear') { askClear = true; return renderSession(); }
  else if (act === 'clearNo') { askClear = false; return renderSession(); }
  else if (act === 'clearYes') { askClear = false; sess = blankSession(sess.mode, sess.points); resetRefDraft(); }
  else if (act === 'copy') {
    let text = summaryText(sessSummary(), ptLabel);
    if (compareOn()) { const ss = singleSummary(); if (ss.used.length >= 3) text += '\n' + summaryText(ss, () => 'Single move'); }
    if (sess.ref) text += `\nReference: X ${sess.ref[0]} Y ${sess.ref[1]} Z ${sess.ref[2]} mm`;
    const ok = await copyText(text);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy summary'; }, 1500);
    return;
  } else if (act === 'csv') {
    const name = `offset-session-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    const text = sessionCsv();
    const msg = $('sessMsg');
    if (window.AndroidIMU) {
      try {
        const r = JSON.parse(window.AndroidIMU.saveCsv(name, text));
        if (r.ok) { clearError(); msg.textContent = 'Saved to ' + r.path; msg.hidden = false; }
        else showError('Could not save CSV: ' + (r.error || 'unknown error'));
      } catch (err) { showError('Could not save CSV: ' + (err.message || err)); }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    return;
  }
  saveSession(); renderSession();
});

el.sessBody.addEventListener('change', (e) => {
  if (!e.target.closest('[data-ref]')) return;
  for (const i of el.sessBody.querySelectorAll('[data-ref]')) refDraft[+i.dataset.ref] = i.value.trim();
  const v = refDraft.map((t) => (t === '' ? NaN : +t));
  sess.ref = v.every(Number.isFinite) ? v : null;
  saveSession(); renderSession();
});

// ---------------------------------------------------------------- helpers
function showError(msg) {
  el.banner.textContent = msg;
  el.banner.hidden = false;
}
const clearError = () => { el.banner.hidden = true; };

function setState(s) {
  state = s;
  el.main.classList.toggle('pin', s === 'idle');
  el.idle.hidden = s !== 'idle' && s !== 'result';
  el.calib.hidden = s !== 'calibrating';
  el.rec.hidden = s !== 'recording';
  el.main.classList.toggle('stop', s === 'recording');
  el.main.disabled = s === 'starting';
  el.main.textContent = { idle: 'Start', starting: 'Starting…', calibrating: 'Cancel', recording: 'Stop', result: 'Start' }[s];
  // The instructions are only useful before a run.
  el.idle.hidden = s !== 'idle';
  renderSession();
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

function loopMessage(k) {
  const N = numPoints;
  if (k > N) return '✓ Back at start? Press Stop';
  if (N === 1) return '✓ Far point recorded — now bring it back to the exact start spot';
  return k < N ? `✓ Point ${k} recorded — go to point ${k + 1}` : `✓ Point ${k} recorded — now bring it back to the exact start spot`;
}

function renderCheckpoint(s) {
  const flashing = performance.now() < cpFlashUntil;
  if (s.registered) {
    cpFlashUntil = performance.now() + CP_FLASH_MS;
    el.cpMsg.textContent = loopMode ? loopMessage(s.count) : `✓ Checkpoint ${s.count} — carry on (or press Stop)`;
    el.cpMsg.classList.add('flash');
    beep();
  } else if (!flashing) {
    el.cpMsg.classList.remove('flash');
    el.cpMsg.textContent = s.moved && s.still ? 'Hold still…' : ' ';
  }
  el.cpBar.style.width = ((flashing || s.registered) ? 100 : s.progress * 100).toFixed(0) + '%';
  el.cpCount.textContent = (loopMode ? 'Holds recorded: ' : 'Checkpoints: ') + s.count;
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
  currentRun = null;
  updateAddButton();
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
    el.modeBadge.hidden = !loopMode;
    el.modeBadge.textContent = numPoints > 1 ? `Loop · ${numPoints} points` : 'Loop mode';
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
const calDate = (iso) => { try { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }); } catch { return ''; } };
const mm = (m) => Math.round(m * 1000);
function signed(v) {
  const r = mm(v);
  return (r < 0 ? MINUS : '+') + Math.abs(r);
}

function showResult(calib, rec, source) {
  let res;
  currentRun = null;
  try {
    res = processRecording(calib, rec, loopOpts());
  } catch (e) {
    showError('Processing failed: ' + e.message);
    return;
  }
  const hasQ = rec.length > 0 && rec.every((s) => s.qw != null);
  let fused = null, fusedErr = null;
  if (hasQ) {
    try {
      fused = processRecording(calib, rec, { orientation: 'fused', ...(loopMode ? { loop: true, points: numPoints } : {}), ...calField() });
    } catch (e) {
      fusedErr = e.message || String(e);
    }
  }
  el.dl.disabled = false;
  if (el.share) el.share.disabled = false;
  el.result.hidden = false;

  const [x, y, z] = res.delta;
  const survey = !!(loopMode && res.loop && res.loop.points && res.loop.points.length >= 2);
  const markers = survey ? res.loop.points.map((p, i) => ({ label: String(i + 1), p })) : null;
  el.rows.innerHTML = '';
  el.rows.hidden = survey;
  el.survey.hidden = !survey;
  el.rowsLabel.hidden = !loopMode || survey;
  let single = null;
  if (loopMode && numPoints === 1 && res.loop) {
    try { single = singleFromLoop(calib, rec, res, loopOpts()); } catch { single = null; }
  }
  el.single.hidden = !single;
  if (single) {
    const cell = (tag, text) => { const c = document.createElement(tag); c.textContent = text; return c; };
    el.singleTable.innerHTML = '';
    const head = el.singleTable.createTHead().insertRow();
    for (const h of ['', 'X', 'Y', 'Z']) head.appendChild(cell('th', h));
    const body = el.singleTable.createTBody();
    for (const [name, v] of [['Loop closure', res.delta], ['Single move (outbound leg only)', single.delta],
      ['Difference (single − loop)', single.delta.map((d, i) => d - res.delta[i])]]) {
      const row = body.insertRow();
      row.appendChild(cell('th', name));
      for (const c of v) row.appendChild(cell('td', signed(c)));
    }
  }
  if (survey) {
    const cell = (tag, text) => { const c = document.createElement(tag); c.textContent = text; return c; };
    el.surveyTable.innerHTML = '';
    const head = el.surveyTable.createTHead().insertRow();
    for (const h of ['', 'X', 'Y', 'Z']) head.appendChild(cell('th', h));
    const body = el.surveyTable.createTBody();
    res.loop.points.forEach((p, i) => {
      const row = body.insertRow();
      row.appendChild(cell('th', `Point ${i + 1}`));
      for (const v of p) row.appendChild(cell('td', signed(v)));
    });
    el.baselines.innerHTML = '';
    for (const b of res.loop.baselines || []) {
      const li = document.createElement('li');
      li.textContent = `Point ${b.from} ↔ Point ${b.to}: ${Math.round(b.mm)} mm`;
      el.baselines.appendChild(li);
    }
    el.total.textContent = '';
  } else {
    for (const [v, axis, label] of [[z, 'Z', 'up'], [y, 'Y', 'forward'], [x, 'X', 'right']]) {
      const d = document.createElement('div');
      d.className = 'row';
      d.innerHTML = `${signed(v)} mm ${axis} <small>(${label})</small>`;
      el.rows.appendChild(d);
    }
    el.total.innerHTML = `Straight-line distance: <b>${mm(Math.hypot(x, y, z))} mm</b>`;
  }

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
    viz?.update(res.path, diag.open && fused ? fused.path : null, markers);
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
  if (loopMode && res.loop) {
    const L = res.loop;
    const h = L.headingOffDeg;
    details.splice(0, 0,
      ['Loop gap', `${Math.round(L.gapMm)} mm (drift removed)`],
      ['Return tilt', `${L.tiltOffDeg.toFixed(1)}°`],
      ['Return heading', `${Math.abs(h).toFixed(1)}° ${h >= 0 ? 'right' : 'left'}`],
      ['Uncorrected', `${mm(L.raw[0])} / ${mm(L.raw[1])} / ${mm(L.raw[2])} mm (X / Y / Z)`]);
    if (survey && L.shareRule) {
      details.splice(1, 0, ['Gap shared by', L.shareRule === 'drift' ? 'measured drift' : L.shareRule === 'time2' ? 'leg time' : String(L.shareRule)]);
    }
  }
  const usedCal = activeSensorCal();
  if (usedCal) details.push(['Sensor calibration', `applied (${calDate(usedCal.created)})`]);
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
  viz?.update(res.path, null, markers);
  setCurrentRun(res, source, survey, single);
  offerContribution(res, calib, rec, source, loopMode, loopMode ? numPoints : 1);
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- contribute
async function offerContribution(res, calib, rec, source, loop, points = 1) {
  const c = await contributeReady;
  if (!c) return;
  const fromFile = String(source).startsWith('csv');
  if (fromFile && !DEV_CONTRIBUTE) { c.hide(); return; }
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
  const usedCal = activeSensorCal();
  c.show({
    allowed: true,
    points,
    async build() {
      const L = res.loop;
      const drift = res.endVelocityCorrected ? Math.hypot(...res.endVelocityCorrected) : 0;
      const meta = {
        app_version: String(window.APP_VERSION || ''),
        mode: loop ? 'loop' : 'single',
        source: fromFile ? 'csv' : String(source).slice(0, 32),
        sample_rate: num(res.sampleRate),
        device: await c.deviceModel(),
        result: res.delta.map(mm),
        quality: res.quality.level,
        warnings: res.quality.warnings.slice(0, 20),
        reference: null,
        extra: {
          sensorCal: usedCal,
          points,
          loop: L ? {
            gapMm: num(L.gapMm), tiltOffDeg: num(L.tiltOffDeg), headingOffDeg: num(L.headingOffDeg),
            rawMm: L.raw.map(mm), legs: L.legs.map(num),
            points: (L.points || []).map((p) => p.map(mm)),
            baselines: (L.baselines || []).map((b) => ({ from: b.from, to: b.to, mm: num(b.mm) })),
            shareRule: L.shareRule ?? null,
          } : null,
          stages: (res.stages || []).map((s) => ({ start: num(s.start), end: num(s.end), drift: num(s.drift), tiltDeg: num(s.tiltDeg) })),
          endHold: num(res.quality.endHold),
          driftCorrected: num(drift),
          tiltCorrectionDeg: num(res.tiltCorrectionDeg),
          motionStart: num(res.motionStart),
          motionEnd: num(res.motionEnd),
          knock: num(res.knock),
        },
      };
      return { meta, csv: toCsv(calib, rec) };
    },
  });
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

const csvFileName = () => `offset-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

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
  a.download = `offset-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
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
initSensorCalUI({
  Capture, acquireWakeLock, releaseWakeLock,
  getDevice: async () => (await contributeReady)?.deviceModel?.(),
  isBusy: () => state === 'starting' || state === 'calibrating' || state === 'recording',
  onChange: () => {},
});
createViz({ view3d: $('view3d'), plotTop: $('plotTop'), plotSide: $('plotSide'), legend: $('legend') })
  .then((v) => { viz = v; })
  .catch((e) => showError('Visualisation failed: ' + e.message));
