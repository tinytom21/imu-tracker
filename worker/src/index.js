// Offset run collection: anyone may add a run (with limits); only the admin may read.
//
// POST   /v1/runs            multipart: meta (JSON), csv (gzipped CSV)      -> 201 { id }
// GET    /v1/runs?since=ISO  admin: run metadata, newest first              -> { runs: [...] }
// GET    /v1/runs/:id/csv    admin: the gzipped CSV
// DELETE /v1/runs/:id        admin
// GET    /v1/health

const CSV_HEADER = 'phase,t,ax,ay,az,gx,gy,gz';
const MAX_META_BYTES = 16384;
const MODES = ['single', 'loop'];
const REF_METHODS = ['tape', 'laser', 'estimate'];

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error(e);
      return json({ error: 'internal error' }, 500, cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['v1', 'runs', id?, 'csv'?]
  if (parts[0] !== 'v1') throw new HttpError(404, 'not found');
  if (parts[1] === 'health' && request.method === 'GET') return json({ ok: true });
  if (parts[1] !== 'runs') throw new HttpError(404, 'not found');

  if (parts.length === 2 && request.method === 'POST') return createRun(request, env);
  requireAdmin(request, env);
  if (parts.length === 2 && request.method === 'GET') return listRuns(url, env);
  if (parts.length === 4 && parts[3] === 'csv' && request.method === 'GET') return getCsv(parts[2], env);
  if (parts.length === 3 && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM runs WHERE id = ?').bind(parts[2]).run();
    return json({ deleted: parts[2] });
  }
  throw new HttpError(404, 'not found');
}

async function createRun(request, env) {
  const max = Number(env.MAX_UPLOAD_BYTES || 1900000);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max + MAX_META_BYTES + 4096) throw new HttpError(413, 'upload too large');
  if (env.INVITE_CODE && request.headers.get('x-invite-code') !== env.INVITE_CODE) {
    throw new HttpError(403, 'invite code required');
  }

  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'expected multipart form data'); }
  const metaText = form.get('meta');
  const csv = form.get('csv');
  if (typeof metaText !== 'string' || metaText.length > MAX_META_BYTES) throw new HttpError(400, 'missing or oversized meta');
  if (!csv || typeof csv === 'string') throw new HttpError(400, 'missing csv file');
  if (csv.size > max) throw new HttpError(413, 'csv too large');

  let meta;
  try { meta = JSON.parse(metaText); } catch { throw new HttpError(400, 'meta is not JSON'); }
  const m = validateMeta(meta);

  const gz = new Uint8Array(await csv.arrayBuffer());
  await checkCsv(gz);

  const ipHash = await sha256(`${request.headers.get('cf-connecting-ip') || ''}|${env.IP_SALT || ''}`);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM runs WHERE created_at > ? AND (install_id = ? OR ip_hash = ?)',
  ).bind(since, m.install_id, ipHash).first();
  if (recent.n >= Number(env.RATE_LIMIT_PER_HOUR || 30)) throw new HttpError(429, 'too many uploads, try again later');

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO runs (id, created_at, install_id, ip_hash, app_version, mode, source, sample_rate, device, user_agent,
       result_x, result_y, result_z, quality, warnings, ref_x, ref_y, ref_z, ref_method, route, notes, flagged_error,
       meta, csv_bytes, csv_gz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, new Date().toISOString(), m.install_id, ipHash, m.app_version, m.mode, m.source, m.sample_rate, m.device,
    (request.headers.get('user-agent') || '').slice(0, 300),
    m.result[0], m.result[1], m.result[2], m.quality, JSON.stringify(m.warnings),
    m.reference ? m.reference.x : null, m.reference ? m.reference.y : null, m.reference ? m.reference.z : null,
    m.reference ? m.reference.method : null, m.route, m.notes, m.flagged_error ? 1 : 0,
    metaText, gz.byteLength, gz,
  ).run();
  return json({ id }, 201);
}

// Only fields we understand are stored in columns; the full meta is kept as JSON.
function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new HttpError(400, 'meta must be an object');
  if (meta.consent !== true) throw new HttpError(400, 'consent required');
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const install = str(meta.install_id, 64);
  if (!install || !/^[A-Za-z0-9-]{8,64}$/.test(install)) throw new HttpError(400, 'bad install_id');
  const result = Array.isArray(meta.result) && meta.result.length === 3 ? meta.result.map(num) : [null, null, null];
  let reference = null;
  if (meta.reference && typeof meta.reference === 'object') {
    const r = meta.reference;
    if ([r.x, r.y, r.z].some((v) => num(v) === null)) throw new HttpError(400, 'reference needs numeric x, y, z in mm');
    reference = { x: r.x, y: r.y, z: r.z, method: REF_METHODS.includes(r.method) ? r.method : null };
  }
  return {
    install_id: install,
    app_version: str(meta.app_version, 32),
    mode: MODES.includes(meta.mode) ? meta.mode : null,
    source: str(meta.source, 32),
    sample_rate: num(meta.sample_rate),
    device: str(meta.device, 120),
    result,
    quality: str(meta.quality, 16),
    warnings: Array.isArray(meta.warnings) ? meta.warnings.slice(0, 20).map((w) => String(w).slice(0, 300)) : [],
    reference,
    route: str(meta.route, 120),
    notes: str(meta.notes, 2000),
    flagged_error: meta.flagged_error === true,
  };
}

// The upload must be a gzip whose CSV starts with the app's header.
async function checkCsv(gz) {
  if (gz.byteLength < 20 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new HttpError(400, 'csv must be gzipped');
  const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  let head = '';
  const dec = new TextDecoder();
  try {
    while (head.length < CSV_HEADER.length) {
      const { value, done } = await reader.read();
      if (done) break;
      head += dec.decode(value, { stream: true });
    }
  } catch {
    throw new HttpError(400, 'csv is not valid gzip');
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!head.startsWith(CSV_HEADER)) throw new HttpError(400, 'not an Offset recording');
}

async function listRuns(url, env) {
  const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z';
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, install_id, app_version, mode, source, sample_rate, device, result_x, result_y, result_z,
       quality, warnings, ref_x, ref_y, ref_z, ref_method, route, notes, flagged_error, meta, csv_bytes
     FROM runs WHERE created_at > ? ORDER BY created_at DESC LIMIT 1000`,
  ).bind(since).all();
  return json({ runs: results });
}

async function getCsv(id, env) {
  const row = await env.DB.prepare('SELECT csv_gz FROM runs WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'no such run');
  return new Response(new Uint8Array(row.csv_gz), {
    headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${id}.csv.gz"` },
  });
}

function requireAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) throw new HttpError(401, 'admin only');
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const h = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-invite-code',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
