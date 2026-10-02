// "Contribute this run": uploads the raw recording + details to the collection Worker (worker/src/index.js),
// with an IndexedDB queue so runs recorded offline are sent later. Everything degrades gracefully when
// storage, IndexedDB or the network is missing.

const config = { uploadUrl: '', inviteCode: '' };
window.__imuConfig = config; // handy for testing: set uploadUrl at runtime

const DB_NAME = 'imuTracker';
const STORE = 'uploadQueue';
const RETRY_MS = 60000;

// ---------------------------------------------------------------- config / identity / device
async function loadConfig() {
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (r.ok) {
      const c = await r.json();
      config.uploadUrl = typeof c.uploadUrl === 'string' ? c.uploadUrl.trim().replace(/\/+$/, '') : '';
      config.inviteCode = typeof c.inviteCode === 'string' ? c.inviteCode.trim() : '';
    }
  } catch { /* offline or missing: contributions stay off */ }
}

function installId() {
  let id = null;
  try { id = localStorage.getItem('imuInstallId'); } catch { /* ignore */ }
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      });
    try { localStorage.setItem('imuInstallId', id); } catch { /* ignore */ }
  }
  return id;
}

async function deviceModel() {
  if (window.AndroidIMU) {
    try {
      const i = JSON.parse(window.AndroidIMU.info());
      return [i.model, i.androidVersion ? 'Android ' + i.androidVersion : ''].filter(Boolean).join(', ').slice(0, 120);
    } catch { /* fall through */ }
  }
  try {
    const h = await navigator.userAgentData?.getHighEntropyValues(['model', 'platformVersion']);
    if (h) {
      const p = navigator.userAgentData.platform || '';
      return [h.model, [p, h.platformVersion].filter(Boolean).join(' ')].filter(Boolean).join(', ').slice(0, 120);
    }
  } catch { /* unavailable */ }
  return '';
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

// ---------------------------------------------------------------- IndexedDB queue (all best-effort)
function openDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}
async function dbOp(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const queueAll = async () => { try { return (await dbOp('readonly', (s) => s.getAll())) || []; } catch { return []; } };
const queueAdd = async (item) => { try { await dbOp('readwrite', (s) => s.add(item)); return true; } catch { return false; } };
const queueDelete = async (id) => { try { await dbOp('readwrite', (s) => s.delete(id)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- network
// Resolves { ok, status, error }; status 0 = network failure.
async function post(metaText, blob) {
  const form = new FormData();
  form.append('meta', metaText);
  form.append('csv', blob, 'run.csv.gz');
  const headers = config.inviteCode ? { 'x-invite-code': config.inviteCode } : {};
  let res;
  try {
    res = await fetch(`${config.uploadUrl}/v1/runs`, { method: 'POST', body: form, headers });
  } catch {
    return { ok: false, status: 0, error: 'network error' };
  }
  if (res.status === 201) return { ok: true, status: 201 };
  let error = `HTTP ${res.status}`;
  try { const j = await res.json(); if (j && j.error) error = j.error; } catch { /* not JSON */ }
  return { ok: false, status: res.status, error };
}

let flushing = false;
let onQueueChange = () => {};
async function flushQueue() {
  if (flushing || !config.uploadUrl) return;
  flushing = true;
  try {
    for (const item of await queueAll()) {
      const r = await post(item.meta, item.blob);
      if (r.ok) await queueDelete(item.id);
      else if (r.status === 0 || r.status >= 500) break;            // offline / server down: try later
      else if (r.status === 429) continue;                           // keep, retry later
      else { console.warn('Dropping queued run, server said', r.status, r.error); await queueDelete(item.id); }
    }
  } finally {
    flushing = false;
    onQueueChange();
  }
}

// ---------------------------------------------------------------- panel
const $ = (id) => document.getElementById(id);

export async function initContribute() {
  await loadConfig();
  const el = {
    panel: $('contrib'), off: $('contribOff'), form: $('contribForm'), x: $('refX'), y: $('refY'), z: $('refZ'),
    method: $('refMethod'), route: $('contribRoute'), notes: $('contribNotes'), flagged: $('contribFlagged'),
    agree: $('contribAgree'), submit: $('contribSubmit'), status: $('contribStatus'), queue: $('contribQueue'),
  };
  let run = null;       // { build(): Promise<{meta, csv}> } for the current result, or null
  let submitted = false;

  const queueLine = async () => {
    const n = (await queueAll()).length;
    el.queue.hidden = n === 0 || !config.uploadUrl;
    el.queue.textContent = `${n} run${n === 1 ? '' : 's'} waiting to send`;
  };
  onQueueChange = queueLine;

  const refresh = () => { el.submit.disabled = !el.agree.checked || submitted; };
  el.agree.addEventListener('change', refresh);

  function render() {
    const on = !!run && (run.allowed || false);
    el.panel.hidden = !on;
    if (!on) return;
    const enabled = !!config.uploadUrl;
    el.off.hidden = enabled;
    el.form.hidden = !enabled;
    queueLine();
  }

  // Called for each new result. `info` = { allowed, build() }.
  function show(info) {
    run = info;
    submitted = false;
    for (const i of [el.x, el.y, el.z, el.route, el.notes]) i.value = '';
    el.method.value = 'tape';
    el.flagged.checked = false;
    el.agree.checked = false;
    el.status.textContent = '';
    el.status.className = 'contrib-status';
    refresh();
    render();
  }
  function hide() { run = null; render(); }

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!run || submitted || !el.agree.checked) return;
    el.submit.disabled = true;
    el.status.className = 'contrib-status';
    el.status.textContent = 'Sending…';
    try {
      const { meta, csv } = await run.build();
      const refs = [el.x, el.y, el.z].map((i) => i.value.trim());
      if (refs.some((v) => v !== '')) {
        if (refs.some((v) => v === '')) throw new Error('Enter all of X, Y and Z for the reference (0 if none).');
        const nums = refs.map(Number);
        if (nums.some((v) => !Number.isFinite(v))) throw new Error('Reference values must be numbers (mm).');
        meta.reference = { x: nums[0], y: nums[1], z: nums[2], method: el.method.value };
      }
      meta.route = el.route.value.trim().slice(0, 120);
      meta.notes = el.notes.value.trim().slice(0, 2000);
      meta.flagged_error = el.flagged.checked;
      meta.consent = true;
      meta.install_id = installId();
      const metaText = JSON.stringify(meta);
      const blob = await gzip(csv);
      const r = await post(metaText, blob);
      if (r.ok) {
        submitted = true;
        el.status.textContent = 'Sent ✓';
        el.status.classList.add('ok');
      } else if (r.status === 0 || r.status >= 500) {
        if (await queueAdd({ meta: metaText, blob, created: Date.now() })) {
          submitted = true;
          el.status.textContent = 'Saved — will send when online';
        } else {
          el.status.textContent = 'Could not send (' + r.error + ') — try again later.';
          el.status.classList.add('bad');
        }
      } else {
        el.status.textContent = r.error;
        el.status.classList.add('bad');
      }
    } catch (err) {
      el.status.textContent = err.message || String(err);
      el.status.classList.add('bad');
    }
    refresh();
    queueLine();
  });

  window.addEventListener('online', flushQueue);
  setInterval(flushQueue, RETRY_MS);
  flushQueue();
  queueLine();
  return { show, hide, flushQueue, deviceModel };
}
