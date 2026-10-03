// Sensor calibration UI: guided routine (six faces + two flat turns), storage, status line.
// The fit itself is sensorcal.js; processing.js applies the result to every run.
const V = new URL(import.meta.url).searchParams.get('v') || Date.now();
const { FACES, faceOf, fitSensorCal } = await import(`./sensorcal.js?v=${V}`);

const KEY = 'imuSensorCal', ON_KEY = 'imuSensorCalOn';
const WIN_S = 1.5, EVAL_S = 0.05, FACE_HOLD_S = 2.5;
const STILL_ACC = 0.12, STILL_GYRO = 0.05; // same thresholds as sensorcal.js
const TURN_MIN_DEG = 300;
const RENDER_MS = 100;
const MINUS = '−';
const AX = ['X', 'Y', 'Z'];

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const okVec = (v, lo = -Infinity, hi = Infinity) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x) && x >= lo && x <= hi);
export function loadSensorCal() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY));
    if (!o || o.version !== 1 || !okVec(o.accBias) || !okVec(o.accGain, 0.95, 1.05) || !okVec(o.gyroGain, 0.95, 1.05)) return null;
    return o;
  } catch { return null; }
}
const calOn = () => { try { return localStorage.getItem(ON_KEY) !== '0'; } catch { return true; } };
const shortDate = (iso) => { try { return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }); } catch { return ''; } };
const pct = (g) => { const v = Math.round((g - 1) * 1e4) / 100; return (v < 0 ? MINUS : '+') + Math.abs(v).toFixed(2) + ' %'; };
const num = (v, d) => (v < 0 ? MINUS : '') + Math.abs(v).toFixed(d);

// The saved calibration in the form processing.js takes (plus its date), only while switched on.
export function activeSensorCal() {
  const c = loadSensorCal();
  if (!c || !calOn()) return null;
  return { accBias: c.accBias, accGain: c.accGain, gyroGain: c.gyroGain, created: c.created };
}

// Live detection while the routine runs. Feed every sample to push(); state() is cheap.
class RoutineTracker {
  constructor() { this.reset(); }
  reset() {
    this.samples = []; this.w0 = 0;
    this.held = Object.fromEntries(FACES.map((f) => [f.key, 0]));
    this.done = new Set();
    this.cur = null; this.curSince = 0; this.progress = 0; this.still = false; this.face = null;
    this.turn = 0; this.turns = 0; this.grav = null; this.lastEval = -Infinity;
    this.newlyDone = null;
  }
  get phase() { return this.done.size === FACES.length ? 2 : 1; }
  push(s) {
    const S = this.samples, prev = S[S.length - 1];
    S.push(s);
    const a = [s.ax, s.ay, s.az];
    if (!this.grav) this.grav = a;
    const dt = prev ? Math.min(0.1, s.t - prev.t) : 0;
    this.grav = this.grav.map((g, i) => g + (a[i] - g) * Math.min(1, dt / 0.3));
    if (dt > 0 && this.phase === 2) {
      const n = Math.hypot(...this.grav) || 1;
      this.turn += (s.gx * this.grav[0] + s.gy * this.grav[1] + s.gz * this.grav[2]) / n * dt;
    }
    if (s.t - this.lastEval < EVAL_S) return;
    this.lastEval = s.t;
    while (S[this.w0].t < s.t - WIN_S) this.w0++;
    this.evaluate(s.t);
  }
  evaluate(t) {
    const S = this.samples, n = S.length - this.w0;
    this.still = false; this.face = null;
    if (n >= 5 && t - S[this.w0].t >= WIN_S * 0.8) {
      const m = [0, 0, 0], gm = [0, 0, 0];
      for (let i = this.w0; i < S.length; i++) { m[0] += S[i].ax; m[1] += S[i].ay; m[2] += S[i].az; gm[0] += S[i].gx; gm[1] += S[i].gy; gm[2] += S[i].gz; }
      for (let k = 0; k < 3; k++) { m[k] /= n; gm[k] /= n; }
      let v = 0;
      for (let i = this.w0; i < S.length; i++) v += (S[i].ax - m[0]) ** 2 + (S[i].ay - m[1]) ** 2 + (S[i].az - m[2]) ** 2;
      this.still = Math.sqrt(v / n) < STILL_ACC && Math.hypot(...gm) < STILL_GYRO;
      if (this.still) this.face = faceOf(m);
    }
    if (this.face) {
      if (this.cur !== this.face) { this.cur = this.face; this.curSince = S[this.w0].t; }
      const held = t - this.curSince;
      this.progress = Math.min(1, held / FACE_HOLD_S);
      this.held[this.face] = Math.max(this.held[this.face], held);
      if (held >= FACE_HOLD_S && !this.done.has(this.face)) { this.done.add(this.face); this.newlyDone = this.face; }
    } else { this.cur = null; this.progress = 0; }
    // Turns: a still flat hold after >= 300 degrees of accumulated turning about vertical.
    if (this.phase === 2 && this.still && this.face === '+z') {
      if (Math.abs(this.turn) * 180 / Math.PI >= TURN_MIN_DEG && this.turns < 2) { this.turns++; this.newlyDone = 't' + this.turns; }
      this.turn = 0;
    }
  }
  state() {
    return { done: this.done, cur: this.cur, progress: this.progress, phase: this.phase, turns: this.turns,
      turnDeg: Math.round(this.turn * 180 / Math.PI), still: this.still };
  }
}

// ---------------------------------------------------------------- face icons (tiny SVG: phone on a ground line)
// The face or edge pointing up is drawn in red.
const ICON = {
  '+z': '<rect x="3" y="18" width="22" height="4" rx="1"/><path class="up" d="M3 18h22"/>',
  '-z': '<rect x="3" y="18" width="22" height="4" rx="1"/><path class="up" d="M3 22h22"/>',
  '+y': '<rect x="10" y="4" width="8" height="18" rx="1"/><path class="up" d="M10 4h8"/>',
  '-y': '<rect x="10" y="4" width="8" height="18" rx="1"/><path class="up" d="M10 22h8"/>',
  '+x': '<rect x="5" y="12" width="18" height="10" rx="1"/><path class="up" d="M23 12v10"/>',
  '-x': '<rect x="5" y="12" width="18" height="10" rx="1"/><path class="up" d="M5 12v10"/>',
};
const icon = (k) => `<svg class="cal-ico" viewBox="0 0 28 26" aria-hidden="true">${ICON[k]}<path class="gr" d="M1 23.5h26"/></svg>`;
const FACE_NAMES = { '+z': 'Flat, screen up', '-z': 'Flat, screen down', '+y': 'Top edge up', '-y': 'Bottom edge up', '+x': 'Right edge up', '-x': 'Left edge up' };

function summaryHtml(c) {
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const turns = (c.detail?.turns || []).map((t) => `${num(t.measuredDeg, 1)}°`).join(' / ');
  return '<dl class="details cal-figs">'
    + row('Accel gain (X / Y / Z)', c.accGain.map(pct).join(' / '))
    + row('Accel bias (m/s²)', c.accBias.map((b) => num(b, 3)).join(' / '))
    + row('Gyro gain (X / Y / Z)', c.gyroGain.map(pct).join(' / '))
    + (turns ? row('Full turns read', turns) : '') + '</dl>';
}
// gain < 1 means the raw sensor reads long (corrected = raw x gain).
function plainLine(c) {
  let k = 0;
  c.accGain.forEach((g, i) => { if (Math.abs(g - 1) > Math.abs(c.accGain[k] - 1)) k = i; });
  const g = c.accGain[k], p = Math.abs(g - 1) * 100;
  if (p < 0.05) return 'Your phone\'s accelerometer is already very close to ideal; the correction is tiny.';
  return `Your phone reads distances about ${g < 1 ? '+' : MINUS}${p.toFixed(1)} % ${g < 1 ? 'long' : 'short'} on ${AX[k]}; this will now be corrected.`;
}

export function initSensorCalUI({ Capture, acquireWakeLock, releaseWakeLock, getDevice, isBusy, onChange, onOpen }) {
  const $ = (id) => document.getElementById(id);
  const status = $('calStatus'), box = $('calRoutine');
  let tracker = new RoutineTracker();
  let cap = null, open = false, dev = false, fit = null, view = 'run', askDelete = false, showFigs = false, lastRender = 0;

  box.innerHTML = `<h2>Calibrate sensors</h2>
    <div id="calRun">
      <div class="rows-label">1. The six sides: <b id="calCount">0 of 6</b></div>
      <p class="cmp-note">Rest the phone on each side in turn, still for 3 seconds. Lean it against something solid for the edges; it doesn't need to be exactly upright. Any order.</p>
      <ul class="cal-faces" id="calFaces">${FACES.map((f) => `<li data-face="${f.key}">${icon(f.key)}<span class="cal-name">${FACE_NAMES[f.key]}</span><span class="cal-state"></span><div class="bar"><div></div></div></li>`).join('')}</ul>
      <div id="calTurns" class="cal-turns-box" hidden>
        <div class="rows-label">2. Two full turns</div>
        <p class="cmp-note">Lay the phone flat, screen up, with one edge against a straight edge (box, ruler, table edge). Hold still. Then turn it one full turn <b>clockwise</b>, keeping it flat, back against the edge, and hold still. Then one full turn <b>anticlockwise</b>, back against the edge, hold still.</p>
        <div class="cal-angle" id="calAngle">Turned: 0°</div>
        <ul class="cal-turns"><li id="calT1">Turn 1</li><li id="calT2">Turn 2</li></ul>
      </div>
    </div>
    <div id="calResult" hidden></div>
    <div class="cal-actions">
      <button type="button" class="primary" data-act="finish" disabled>Finish</button>
      <button type="button" class="primary" data-act="save" hidden>Save calibration</button>
      <button type="button" class="primary" data-act="retry" hidden>Try again</button>
      <button type="button" class="secondary" data-act="cancel">Cancel</button>
    </div>`;
  const btn = (a) => box.querySelector(`[data-act="${a}"]`);
  const faceLis = new Map([...box.querySelectorAll('[data-face]')].map((li) => [li.dataset.face, li]));

  function renderLive(force) {
    const now = performance.now();
    if (!force && now - lastRender < RENDER_MS) return;
    lastRender = now;
    const s = tracker.state();
    for (const [k, li] of faceLis) {
      const done = s.done.has(k), cur = s.cur === k && !done;
      li.classList.toggle('done', done); li.classList.toggle('cur', cur);
      li.querySelector('.cal-state').textContent = done ? '✓' : cur ? Math.round(s.progress * 100) + ' %' : '';
      li.querySelector('.bar > div').style.width = (done ? 100 : cur ? s.progress * 100 : 0).toFixed(0) + '%';
    }
    $('calCount').textContent = `${s.done.size} of 6`;
    $('calTurns').hidden = s.phase !== 2;
    $('calAngle').textContent = `Turned: ${s.turnDeg}°`;
    for (const n of [1, 2]) { const li = $('calT' + n); li.classList.toggle('done', s.turns >= n); li.textContent = (s.turns >= n ? '✓ ' : '') + 'Turn ' + n; }
    btn('finish').disabled = s.turns < 2;
  }
  function onSample(s) {
    tracker.push(s);
    if (tracker.newlyDone) { tracker.newlyDone = null; try { navigator.vibrate?.(60); } catch { /* optional */ } renderLive(true); }
    else renderLive(false);
  }

  function setView(v) {
    view = v;
    $('calRun').hidden = v !== 'run';
    $('calResult').hidden = v === 'run';
    btn('finish').hidden = v !== 'run';
    btn('save').hidden = v !== 'ok';
    btn('retry').hidden = v !== 'fail';
    btn('cancel').textContent = v === 'ok' ? 'Discard' : 'Cancel';
  }
  function stopCapture() { try { cap?.stop(); } catch { /* ignore */ } releaseWakeLock(); }
  function showError(msg) { const b = $('banner'); b.textContent = msg; b.hidden = false; }
  function close() {
    stopCapture();
    open = false; dev = false; fit = null;
    box.hidden = true;
    document.body.classList.remove('cal-open');
    onOpen?.(false);
    renderStatus();
    window.scrollTo({ top: 0 });
  }

  async function start(isDev = false) {
    if (isBusy?.()) return;
    $('banner').hidden = true;
    stopCapture();
    tracker = new RoutineTracker();
    open = true; dev = isDev;
    box.hidden = false; document.body.classList.add('cal-open');
    onOpen?.(true);
    setView('run'); renderLive(true);
    box.scrollIntoView({ block: 'start' });
    if (isDev) return;
    try {
      cap = cap || new Capture({ onSample: (s) => { if (open && view === 'run') onSample(s); }, onError: (e) => { close(); showError('Sensor error: ' + (e.message || e.name)); } });
      await cap.requestPermission();
      await cap.start();
      acquireWakeLock();
    } catch (e) { close(); showError(e.message || String(e)); }
  }

  function finish() {
    stopCapture();
    let r;
    try { r = fitSensorCal(tracker.samples); } catch (e) { r = { ok: false, errors: ['Fit failed: ' + (e.message || e)] }; }
    fit = r;
    const res = $('calResult');
    if (!r.ok) {
      res.innerHTML = `<div class="rows-label">Calibration did not work</div><ul class="warnings">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
      setView('fail');
      return;
    }
    res.innerHTML = `<div class="rows-label">Result</div><p class="cal-plain">${esc(plainLine(r))}</p>${summaryHtml(r)}`
      + (r.detail?.tips?.length ? `<ul class="cmp-warn">${r.detail.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
    setView('ok');
  }
  async function save() {
    if (!fit?.ok) return;
    let device = '';
    try { device = (await getDevice?.()) || ''; } catch { /* ignore */ }
    if (!device) device = String(navigator.userAgent || '').slice(0, 120);
    const d = fit.detail || {};
    const rec = { version: 1, created: new Date().toISOString(), device, accBias: fit.accBias, accGain: fit.accGain, gyroGain: fit.gyroGain,
      detail: { turns: d.turns, zFromTurns: d.zFromTurns, gyroGravityResidualDeg: d.gyroGravityResidualDeg } };
    try { localStorage.setItem(KEY, JSON.stringify(rec)); localStorage.setItem(ON_KEY, '1'); }
    catch { showError('Could not save the calibration (storage unavailable).'); return; }
    close(); onChange?.();
  }

  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'finish') finish();
    else if (act === 'save') save();
    else if (act === 'retry') start(dev);
    else if (act === 'cancel') close();
  });

  function renderStatus() {
    const c = loadSensorCal(), on = calOn();
    let h = `<div class="rows-label">Sensor calibration: <b>${c ? (on ? 'on' : 'off') + (c.created ? ` (${esc(shortDate(c.created))})` : '') : 'not done'}</b></div>`;
    if (c) h += `<label class="cal-toggle"><input type="checkbox" data-act="toggle"${on ? ' checked' : ''}> Apply calibration</label>`;
    h += `<p class="cmp-note">${c ? 'Corrects your phone\'s own accelerometer and gyro scale errors in every measurement.' : 'About 2 minutes. Corrects your phone\'s own accelerometer and gyro scale errors, which otherwise skew every measurement.'}</p>`;
    h += `<div class="sess-actions"><button type="button" class="sess-btn" data-act="open">${c ? 'Recalibrate' : 'Calibrate sensors'}</button>`;
    if (c) h += `<button type="button" class="sess-btn" data-act="figs">${showFigs ? 'Hide figures' : 'View figures'}</button>`;
    if (c && !askDelete) h += '<button type="button" class="sess-btn" data-act="del">Delete</button>';
    h += '</div>';
    if (c && askDelete) h += '<div class="sess-confirm"><p>Delete the saved sensor calibration?</p><div class="sess-actions"><button type="button" class="sess-btn danger" data-act="delYes">Yes, delete</button><button type="button" class="sess-btn" data-act="delNo">Cancel</button></div></div>';
    if (c && showFigs) h += summaryHtml(c) + `<p class="cmp-note">${esc(c.device || '')}</p>`;
    status.innerHTML = h;
  }
  status.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || act === 'toggle') return;
    if (act === 'open') { start(); return; }
    if (act === 'figs') showFigs = !showFigs;
    else if (act === 'del') askDelete = true;
    else if (act === 'delNo') askDelete = false;
    else if (act === 'delYes') {
      askDelete = false; showFigs = false;
      try { localStorage.removeItem(KEY); localStorage.removeItem(ON_KEY); } catch { /* ignore */ }
      onChange?.();
    }
    renderStatus();
  });
  status.addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    try { localStorage.setItem(ON_KEY, e.target.checked ? '1' : '0'); } catch { /* ignore */ }
    renderStatus(); onChange?.();
  });
  renderStatus();

  // Dev only (?devCal=1): feed synthetic samples through the live handler, chunked so the ticks can be watched.
  if (new URLSearchParams(location.search).get('devCal') === '1') {
    window.__devCalFeed = (samples, chunk = 400) => new Promise((resolve) => {
      if (!open) start(true);
      let i = 0;
      const step = () => {
        for (const end = Math.min(samples.length, i + chunk); i < end; i++) onSample(samples[i]);
        renderLive(true);
        if (i < samples.length) setTimeout(step, 16); else resolve(tracker.state());
      };
      step();
    });
  }
  return { renderStatus };
}
