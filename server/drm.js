import express from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';
import { extractClientIp, verifyToken, requireAuth, requireAdmin } from './auth.js';
import { getBaseUrl, getConfiguredStreamBase } from './publicBase.js';
import { negotiateFlussonic2312Connection, fetchJsonWithTimeout } from './flussonic2312Manager.js';

/**
 * DRM / CAS de TVLister.
 *
 * Flussonic no cifra «gratis»: en `drm aes128` pide la clave a un servidor de
 * claves (CAS) y publica en el HLS la URL que le devolvemos. Eso nos deja
 * controlar las dos puntas:
 *
 *   1. **CAS** (`/drm/cas/:token`) — sólo la llama tu Flussonic. Recibe
 *      `?file=<recurso>&number=<n>` y responde 16 bytes con la cabecera
 *      `X-Key-Url` apuntando a nosotros.
 *   2. **Entrega de clave** (`/drm/key/:token?n=<n>`) — la llama el jugador.
 *      La clave se deriva con HKDF-SHA256 de una clave maestra por canal y el
 *      número de rotación, así que rota cada 10 minutos sin guardar nada.
 *
 * Nada de esto toca el motor UDP/FFmpeg ni la salida CATV: sólo HLS/DASH.
 */

const KEY_LEN = 16;

export const drmRouter = express.Router();
export const drmAdminRouter = express.Router();

// --- Utilidades -----------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (['aes128', 'sample_aes', 'widevine', 'playready', 'off'].includes(m)) return m;
  return 'off';
}

export function getDrmSettings() {
  const rows = db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('drm_enabled','drm_cas_allow_ips','drm_default_license_url')"
    )
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.key, String(r.value || '')]));
  return {
    enabled: map.drm_enabled !== 'false',
    casAllowIps: String(map.drm_cas_allow_ips || '').trim(),
    defaultLicenseUrl: String(map.drm_default_license_url || '').trim()
  };
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

export function getDrmRow(streamId) {
  return db.prepare('SELECT * FROM drm_streams WHERE stream_id = ?').get(Number(streamId)) || null;
}

function ensureRow(streamId) {
  let row = getDrmRow(streamId);
  if (!row) {
    db.prepare('INSERT INTO drm_streams (stream_id) VALUES (?)').run(Number(streamId));
    row = getDrmRow(streamId);
  }
  return row;
}

/** Un canal está protegido si la fila existe, está activa y tiene modo real. */
export function getActiveDrm(streamId) {
  const row = getDrmRow(streamId);
  if (!row || !row.enabled) return null;
  if (!['aes128', 'sample_aes', 'widevine', 'playready'].includes(row.mode)) return null;
  if (row.mode !== 'widevine' && row.mode !== 'playready' && !row.master_key && !row.static_key) return null;
  return row;
}

/** Deriva la clave de 16 bytes para un número de rotación concreto. */
export function deriveKey(row, keyNumber = '0') {
  if (row.static_key && String(row.static_key).length >= 32) {
    return Buffer.from(String(row.static_key).slice(0, 32), 'hex');
  }
  const master = Buffer.from(String(row.master_key || ''), 'hex');
  if (master.length < 16) throw new Error('Clave maestra del canal no configurada');
  const info = Buffer.from(`tvlister-drm:${row.stream_id}:${keyNumber}`, 'utf8');
  const salt = crypto.createHash('sha256').update(`stream-${row.stream_id}`).digest();
  const okm = crypto.hkdfSync('sha256', master, salt, info, KEY_LEN);
  return Buffer.from(okm);
}

function keyNumberFromReq(req) {
  const raw =
    req.query.number ?? req.query.n ?? req.query.key_number ?? req.query.drm_id ?? req.body?.number ?? '0';
  const clean = String(raw ?? '0').trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
  return clean || '0';
}

function logKey(streamId, { kind, number, req, lineId = null, ok = true, reason = '' }) {
  try {
    db.prepare(
      `INSERT INTO drm_key_log (stream_id, kind, key_number, ip, user_agent, line_id, ok, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      Number(streamId) || null,
      kind,
      String(number || ''),
      req ? extractClientIp(req) : '',
      String(req?.headers?.['user-agent'] || '').slice(0, 200),
      lineId,
      ok ? 1 : 0,
      String(reason || '').slice(0, 200)
    );
  } catch {
    /* el log nunca debe romper la entrega de la clave */
  }
}

function ipAllowedForCas(req) {
  const { casAllowIps } = getDrmSettings();
  if (!casAllowIps) return true;
  const clientIp = extractClientIp(req);
  const entries = casAllowIps
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.includes('*') || entries.includes(clientIp);
}

function findStreamByToken(token, field = 'cas_token') {
  if (!token) return null;
  const column = field === 'key_token' ? 'key_token' : 'cas_token';
  return db.prepare(`SELECT * FROM drm_streams WHERE ${column} = ?`).get(String(token)) || null;
}

/** Base pública por la que los clientes deben pedir la clave. */
function publicBaseFor(req) {
  return getConfiguredStreamBase() || getBaseUrl(req);
}

function buildKeyUrl(req, row) {
  const base = publicBaseFor(req);
  return `${base}/drm/key/${row.key_token}`;
}

/** Token firmado de una línea, para poder exigir sesión al pedir la clave. */
function verifyLineToken(req) {
  const raw = String(req.query.t || req.query.token || req.headers['x-tvlister-line-token'] || '').trim();
  if (!raw) return null;
  try {
    const payload = verifyToken(raw);
    if (!payload || !payload.id) return null;
    const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(Number(payload.id));
    if (!line || line.status !== 'active') return null;
    if (line.exp_date && new Date(line.exp_date).getTime() < Date.now()) return null;
    return line;
  } catch {
    return null;
  }
}

// --- 1. CAS: lo llama Flussonic -------------------------------------------

drmRouter.get('/drm/cas/:token', (req, res) => {
  const row = findStreamByToken(req.params.token, 'cas_token');
  const number = keyNumberFromReq(req);

  if (!getDrmSettings().enabled) return res.status(503).send('DRM desactivado en el panel');
  if (!row || !row.enabled) {
    logKey(row?.stream_id, { kind: 'cas', number, req, ok: false, reason: 'token desconocido' });
    return res.status(404).send('Token CAS desconocido');
  }
  if (!ipAllowedForCas(req)) {
    logKey(row.stream_id, { kind: 'cas', number, req, ok: false, reason: 'IP no permitida' });
    return res.status(403).send('IP no autorizada para el CAS');
  }

  let key;
  try {
    key = deriveKey(row, number);
  } catch (err) {
    logKey(row.stream_id, { kind: 'cas', number, req, ok: false, reason: err.message });
    return res.status(500).send(err.message);
  }

  logKey(row.stream_id, { kind: 'cas', number, req, ok: true });
  res.setHeader('X-Key-Url', buildKeyUrl(req, row));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(key.length));
  res.setHeader('Cache-Control', 'no-store');
  return res.end(key);
});

// --- 2. Entrega de clave al jugador ---------------------------------------

function respondWithKey(req, res, row, number, { clearkeyJson = false } = {}) {
  if (!getDrmSettings().enabled) return res.status(503).send('DRM desactivado en el panel');
  if (!row || !row.enabled) return res.status(404).send('Canal sin DRM activo');

  const line = verifyLineToken(req);
  if (req.query.t && !line) {
    logKey(row.stream_id, { kind: 'key', number, req, ok: false, reason: 'token de línea inválido' });
    return res.status(401).send('Sesión de línea inválida o expirada');
  }

  let key;
  try {
    key = deriveKey(row, number);
  } catch (err) {
    logKey(row.stream_id, { kind: 'key', number, req, ok: false, reason: err.message });
    return res.status(500).send(err.message);
  }

  logKey(row.stream_id, { kind: 'key', number, req, lineId: line?.id || null, ok: true });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');

  if (clearkeyJson) {
    const kid =
      String(row.kid || '').trim() || crypto.createHash('sha256').update(`kid-${row.stream_id}`).digest('hex').slice(0, 32);
    return res.json({
      keys: [{ kty: 'oct', kid, k: key.toString('base64url') }],
      type: 'temporary'
    });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(key.length));
  return res.end(key);
}

drmRouter.options('/drm/key/:token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(204).end();
});

drmRouter.get('/drm/key/:token', (req, res) => {
  const row = findStreamByToken(req.params.token, 'key_token');
  const number = keyNumberFromReq(req);
  const fmt = String(req.query.fmt || req.query.format || '').toLowerCase();
  const wantsJson = fmt === 'clearkey' || fmt === 'json' || String(req.headers.accept || '').includes('json');
  return respondWithKey(req, res, row, number, { clearkeyJson: wantsJson });
});

// Alias pensado para EME (ClearKey) en el reproductor web.
drmRouter.get('/drm/clearkey/:token', (req, res) => {
  const row = findStreamByToken(req.params.token, 'key_token');
  return respondWithKey(req, res, row, keyNumberFromReq(req), { clearkeyJson: true });
});

// --- 3. Proxy de licencias Widevine / PlayReady ---------------------------

async function handleLicenseProxy(req, res) {
  const row = findStreamByToken(req.params.token, 'key_token');
  if (!row || !row.enabled) return res.status(404).send('Canal sin DRM activo');

  const target = String(row.license_url || getDrmSettings().defaultLicenseUrl || '').trim();
  if (!/^https?:\/\//i.test(target)) return res.status(500).send('URL de licencia no configurada');

  const line = verifyLineToken(req);
  if (req.query.t && !line) {
    logKey(row.stream_id, { kind: 'license', req, ok: false, reason: 'token de línea inválido' });
    return res.status(401).send('Sesión de línea inválida o expirada');
  }

  let extraHeaders = {};
  try {
    extraHeaders = JSON.parse(row.license_headers || '{}') || {};
  } catch {
    extraHeaders = {};
  }

  const bodyChunks = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) bodyChunks.push(chunk);
  }
  const body = bodyChunks.length ? Buffer.concat(bodyChunks) : undefined;

  try {
    const up = await fetch(target, {
      method: req.method === 'GET' ? 'GET' : 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/octet-stream',
        ...(Object.fromEntries(
          Object.entries(extraHeaders).map(([k, v]) => [k, String(v)])
        )),
        ...(req.headers.authorization ? { Authorization: String(req.headers.authorization) } : {})
      },
      body
    });
    const buf = Buffer.from(await up.arrayBuffer());
    logKey(row.stream_id, { kind: 'license', req, lineId: line?.id || null, ok: up.ok, reason: up.ok ? '' : `HTTP ${up.status}` });
    res.status(up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (err) {
    logKey(row.stream_id, { kind: 'license', req, ok: false, reason: err.message });
    return res.status(502).send('No se pudo contactar con el servidor de licencias');
  }
}

drmRouter.options('/drm/license/:token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(204).end();
});
drmRouter.all('/drm/license/:token', handleLicenseProxy);

// --- 4. Snippet de Flussonic y empuje por API -----------------------------

export function buildFlussonicDrmLine(row, req, { maskContentKeys = false } = {}) {
  const base = publicBaseFor(req);
  const keyserver = `${base}/drm/cas/${row.cas_token}`;
  const mode = row.mode === 'sample_aes' ? 'sample_aes' : row.mode === 'widevine' ? 'widevine' : 'aes128';
  if (mode === 'widevine') {
    // Aquí el panel NO emite claves ni licencias: custodia el aes_key/iv que te
    // da tu cuenta de Widevine y se los pasa a Flussonic; la licencia la firma
    // tu proveedor (Google/partner) y el panel sólo hace de proxy autorizado.
    const parts = [`drm widevine`];
    if (row.cenc_aes_key) parts.push(`aes_key=${maskContentKeys ? '<guardada>' : row.cenc_aes_key}`);
    if (row.cenc_iv) parts.push(`iv=${maskContentKeys ? '<guardado>' : row.cenc_iv}`);
    if (row.cenc_content_id) parts.push(`content_id=${row.cenc_content_id}`);
    parts.push(`keyserver=${row.license_url || '<tu_keyserver_widevine>'}`);
    return parts.join(' ').replace('drm widevine ', row.cenc_aes_key ? 'drm widevine ' : 'drm widevine ');
  }
  return `drm ${mode} keyserver=${keyserver}`;
}

function flussonicSnippet(streamName, row, req, opts = {}) {
  const line = buildFlussonicDrmLine(row, req, opts);
  const base = publicBaseFor(req);
  return [
    `stream ${streamName || row.flussonic_stream || '<nombre_del_stream>'} {`,
    '  # ... tu input y protocolos actuales ...',
    `  ${line.replace(/;$/, '')}`,
    `  # CAS de TVLister: ${base}/drm/cas/${row.cas_token}`,
    '}'
  ].join('\n');
}

// --- 5. API de administración --------------------------------------------

function streamDrmView(row, stream = null, req = null) {
  const base = req ? publicBaseFor(req) : '';
  return {
    stream_id: row.stream_id,
    enabled: Boolean(row.enabled),
    mode: row.mode,
    kid: row.kid,
    has_master_key: Boolean(row.master_key),
    has_static_key: Boolean(row.static_key),
    cenc_content_id: row.cenc_content_id || '',
    has_cenc_keys: Boolean(row.cenc_aes_key && row.cenc_iv),
    license_url: row.license_url,
    license_headers: row.license_headers,
    flussonic_stream: row.flussonic_stream || stream?.flussonic_stream_name || '',
    stream_name: stream?.name || '',
    cas_url: base && row.cas_token ? `${base}/drm/cas/${row.cas_token}` : '',
    key_url: base && row.key_token ? `${base}/drm/key/${row.key_token}` : '',
    clearkey_url: base && row.key_token ? `${base}/drm/clearkey/${row.key_token}` : '',
    updated_at: row.updated_at
  };
}

drmAdminRouter.get('/api/drm/overview', requireAuth, requireAdmin, (req, res) => {
  const settings = getDrmSettings();
  const rows = db
    .prepare(
      `SELECT d.*, s.name AS stream_name, s.status AS stream_status, s.flussonic_stream_name
       FROM drm_streams d LEFT JOIN streams s ON s.id = d.stream_id
       ORDER BY d.enabled DESC, s.name COLLATE NOCASE`
    )
    .all();

  const stats = db
    .prepare(
      `SELECT kind, COUNT(*) AS total,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok
       FROM drm_key_log WHERE datetime(created_at) >= datetime('now','-1 day')
       GROUP BY kind`
    )
    .all();

  const lastEvents = db
    .prepare('SELECT * FROM drm_key_log ORDER BY id DESC LIMIT 25')
    .all();

  // Canales CATV que usan el mismo stream de Flussonic: activar DRM ahí puede
  // romper el camino UDP, así que el panel lo tiene que decir claramente.
  const catvUsing = (flussonicStream) => {
    if (!flussonicStream) return [];
    return db
      .prepare(
        "SELECT catv_ch, custom_name FROM wk2500_channels WHERE udp_engine = 'flussonic' AND flussonic_stream = ?"
      )
      .all(String(flussonicStream));
  };

  res.json({
    settings,
    base: publicBaseFor(req),
    streams: rows.map((r) => ({
      ...streamDrmView(r, { name: r.stream_name, flussonic_stream_name: r.flussonic_stream_name }, req),
      stream_status: r.stream_status,
      catv_conflicts: catvUsing(r.flussonic_stream || r.flussonic_stream_name)
    })),
    stats,
    lastEvents
  });
});

drmAdminRouter.get('/api/drm/candidates', requireAuth, requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.status, s.flussonic_stream_name,
              (SELECT COUNT(*) FROM drm_streams d WHERE d.stream_id = s.id AND d.enabled = 1) AS drm_on
       FROM streams s
       ORDER BY s.name COLLATE NOCASE`
    )
    .all();
  res.json({ streams: rows, base: publicBaseFor(req) });
});

drmAdminRouter.put('/api/drm/settings', requireAuth, requireAdmin, (req, res) => {
  const { enabled, casAllowIps, defaultLicenseUrl } = req.body || {};
  if (enabled !== undefined) setSetting('drm_enabled', enabled ? 'true' : 'false');
  if (casAllowIps !== undefined) setSetting('drm_cas_allow_ips', String(casAllowIps || '').trim());
  if (defaultLicenseUrl !== undefined) setSetting('drm_default_license_url', String(defaultLicenseUrl || '').trim());
  res.json({ ok: true, settings: getDrmSettings() });
});

drmAdminRouter.get('/api/drm/streams/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id);
  if (!stream) return res.status(404).json({ error: 'Canal no encontrado' });
  const row = ensureRow(id);
  res.json({
    drm: streamDrmView(row, stream, req),
    snippet: flussonicSnippet(row.flussonic_stream || stream.flussonic_stream_name, row, req, { maskContentKeys: true }),
    stream: { id: stream.id, name: stream.name, status: stream.status }
  });
});

drmAdminRouter.put('/api/drm/streams/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id);
  if (!stream) return res.status(404).json({ error: 'Canal no encontrado' });

  const body = req.body || {};
  const row = ensureRow(id);
  const mode = normalizeMode(body.mode ?? row.mode);
  const enabled = body.enabled === undefined ? Boolean(row.enabled) : Boolean(body.enabled);

  let masterKey = row.master_key;
  let staticKey = row.static_key;
  if (body.staticKey !== undefined) {
    const clean = String(body.staticKey || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (clean && clean.length !== 32) {
      return res.status(400).json({ error: 'La clave estática AES-128 debe ser de 32 caracteres hexadecimales (16 bytes)' });
    }
    staticKey = clean;
  }
  if (body.regenerateMasterKey) masterKey = randomHex(32);
  if (!staticKey && !masterKey) masterKey = randomHex(32);

  const licenseUrl = body.licenseUrl !== undefined ? String(body.licenseUrl || '').trim() : row.license_url;
  if (licenseUrl && !/^https?:\/\//i.test(licenseUrl)) {
    return res.status(400).json({ error: 'La URL de licencias debe empezar por http:// o https://' });
  }
  let cencAesKey = row.cenc_aes_key || '';
  let cencIv = row.cenc_iv || '';
  let cencContentId = body.cencContentId !== undefined ? String(body.cencContentId || '').trim() : row.cenc_content_id || '';
  if (body.cencAesKey !== undefined) {
    const clean = String(body.cencAesKey || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (clean && clean.length !== 32) {
      return res.status(400).json({ error: 'aes_key de Widevine: 32 caracteres hexadecimales (16 bytes)' });
    }
    cencAesKey = clean;
  }
  if (body.cencIv !== undefined) {
    const clean = String(body.cencIv || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (clean && clean.length !== 32) {
      return res.status(400).json({ error: 'iv de Widevine: 32 caracteres hexadecimales (16 bytes)' });
    }
    cencIv = clean;
  }

  let licenseHeaders = row.license_headers || '{}';
  if (body.licenseHeaders !== undefined) {
    const raw = body.licenseHeaders;
    if (typeof raw === 'string') {
      try {
        JSON.parse(raw || '{}');
        licenseHeaders = raw || '{}';
      } catch {
        return res.status(400).json({ error: 'Las cabeceras de licencia deben ser un JSON válido' });
      }
    } else {
      licenseHeaders = JSON.stringify(raw || {});
    }
  }

  const casToken = body.regenerateTokens || !row.cas_token ? randomToken(24) : row.cas_token;
  const keyToken = body.regenerateTokens || !row.key_token ? randomToken(24) : row.key_token;

  if (enabled && (mode === 'widevine' || mode === 'playready') && !licenseUrl && !getDrmSettings().defaultLicenseUrl) {
    return res.status(400).json({
      error:
        'Widevine/PlayReady necesitan la URL de tu servidor de licencias (tu proveedor DRM). ' +
        'Este panel puede emitir las claves de AES-128, pero las licencias Widevine las firma Google o un partner autorizado.'
    });
  }

  db.prepare(
    `UPDATE drm_streams SET enabled = ?, mode = ?, master_key = ?, static_key = ?, cas_token = ?,
       key_token = ?, license_url = ?, license_headers = ?, flussonic_stream = ?,
       cenc_aes_key = ?, cenc_iv = ?, cenc_content_id = ?,
       notes = ?, updated_at = ? WHERE stream_id = ?`
  ).run(
    enabled ? 1 : 0,
    mode,
    masterKey,
    staticKey,
    casToken,
    keyToken,
    licenseUrl,
    licenseHeaders,
    String(body.flussonicStream ?? row.flussonic_stream ?? ''),
    cencAesKey,
    cencIv,
    cencContentId,
    String(body.notes ?? row.notes ?? ''),
    nowIso(),
    id
  );

  const fresh = getDrmRow(id);
  res.json({ ok: true, drm: streamDrmView(fresh, stream, req), snippet: flussonicSnippet(fresh.flussonic_stream || stream.flussonic_stream_name, fresh, req, { maskContentKeys: true }) });
});

drmAdminRouter.post('/api/drm/streams/:id/rotate', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = getDrmRow(id);
  if (!row) return res.status(404).json({ error: 'Ese canal no tiene DRM configurado' });
  const casToken = randomToken(24);
  const keyToken = randomToken(24);
  db.prepare('UPDATE drm_streams SET cas_token = ?, key_token = ?, updated_at = ? WHERE stream_id = ?').run(
    casToken,
    keyToken,
    nowIso(),
    id
  );
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id);
  res.json({ ok: true, drm: streamDrmView(getDrmRow(id), stream, req), snippet: flussonicSnippet(getDrmRow(id).flussonic_stream, getDrmRow(id), req, { maskContentKeys: true }) });
});

drmAdminRouter.delete('/api/drm/streams/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM drm_streams WHERE stream_id = ?').run(id);
  res.json({ ok: true });
});

/** Prueba de punta a punta sin tocar Flussonic: CAS + entrega de clave. */
drmAdminRouter.post('/api/drm/streams/:id/test', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = getDrmRow(id);
  if (!row) return res.status(404).json({ error: 'Ese canal no tiene DRM configurado' });
  try {
    const key1 = deriveKey(row, req.body?.number ?? '1');
    const key2 = deriveKey(row, req.body?.number ?? '2');
    res.json({
      ok: key1.length === 16,
      key_length: key1.length,
      rotates: !key1.equals(key2),
      key_preview: `${key1.toString('hex').slice(0, 8)}… (16 bytes)`,
      cas_url: `${publicBaseFor(req)}/drm/cas/${row.cas_token}`,
      key_url: `${publicBaseFor(req)}/drm/key/${row.key_token}`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

drmAdminRouter.get('/api/drm/log', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare('SELECT * FROM drm_key_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ events: rows });
});

drmAdminRouter.delete('/api/drm/log', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM drm_key_log').run();
  res.json({ ok: true });
});

// --- 6. Empuje a Flussonic (opt-in y con vista previa) --------------------

function pickWritableStreamFields(remote) {
  const out = {
    name: remote.name,
    title: remote.title,
    static: remote.static,
    inputs: remote.inputs
  };
  // Se conserva el transcoder si existe: sin él, un canal con perfil perdería
  // su configuración al guardar.
  if (remote.transcoder) out.transcoder = remote.transcoder;
  if (remote.dvr) out.dvr = remote.dvr;
  if (remote.protocols) out.protocols = remote.protocols;
  if (remote.options) out.options = remote.options;
  return out;
}

async function flussonicServerRow(serverId) {
  if (serverId) {
    const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(serverId));
    if (srv) return srv;
  }
  const main = db.prepare('SELECT * FROM servers WHERE is_main = 1').get();
  if (main) return main;
  return db.prepare('SELECT * FROM servers').get() || null;
}

async function fetchRemoteStream(srv, streamName) {
  const conn = await negotiateFlussonic2312Connection(srv);
  const encName = streamName.split('/').map((p) => encodeURIComponent(p)).join('/');
  const url = `${conn.effectiveBase}/streamer/api/v3/streams/${encName}`;
  const headers = { ...conn.headers };
  if (headers.Authorization && headers.Authorization.startsWith('Cluster ')) {
    const { buildFlussonicClusterAuthHeader } = await import('./flussonic2312Manager.js');
    headers.Authorization = buildFlussonicClusterAuthHeader(
      String(srv.api_token || srv.password || srv.username || '').trim()
    );
  }
  const r = await fetchJsonWithTimeout(url, { headers }, 8000, conn.bridgeNode);
  if (!r.ok) {
    throw new Error(`Flussonic respondió HTTP ${r.status} al leer el stream ${streamName}`);
  }
  const json = await r.json();
  return { conn, streamName, remote: json.stream || json, headers };
}

drmAdminRouter.post('/api/drm/streams/:id/flussonic', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id);
  const row = getDrmRow(id);
  if (!stream || !row) return res.status(404).json({ error: 'Canal sin DRM configurado' });

  const streamName = String(req.body?.flussonicStream || row.flussonic_stream || stream.flussonic_stream_name || '').trim();
  if (!streamName) return res.status(400).json({ error: 'Indica el nombre del stream en Flussonic' });

  const action = String(req.body?.action || 'preview'); // preview | apply | remove
  const srv = await flussonicServerRow(req.body?.serverId);

  try {
    const { conn, remote, headers } = await fetchRemoteStream(srv, streamName);
    const payload = pickWritableStreamFields(remote);

    if (action === 'remove') {
      delete payload.drm;
    } else {
      const mode = row.mode === 'widevine' ? 'widevine' : row.mode === 'sample_aes' ? 'sample_aes' : 'aes128';
      payload.drm = {
        type: mode,
        keyserver: mode === 'widevine' ? row.license_url : `${publicBaseFor(req)}/drm/cas/${row.cas_token}`
      };
      if (mode === 'widevine') {
        if (row.cenc_aes_key) payload.drm.aes_key = row.cenc_aes_key;
        if (row.cenc_iv) payload.drm.iv = row.cenc_iv;
        if (row.cenc_content_id) payload.drm.content_id = row.cenc_content_id;
      }
    }

    if (action === 'preview') {
      return res.json({
        ok: true,
        action,
        server: { id: srv?.id, name: srv?.name, base: conn.effectiveBase },
        stream: streamName,
        current: remote.drm || null,
        will_send: payload,
        note:
          'Vista previa: no se ha cambiado nada en Flussonic. Revisa que inputs/transcoder/dvr coincidan con tu configuración actual y pulsa Aplicar.'
      });
    }

    const encName = streamName.split('/').map((p) => encodeURIComponent(p)).join('/');
    const reqHeaders = { ...headers, 'Content-Type': 'application/json' };
    if (reqHeaders.Authorization && reqHeaders.Authorization.startsWith('Cluster ')) {
      const { buildFlussonicClusterAuthHeader } = await import('./flussonic2312Manager.js');
      reqHeaders.Authorization = buildFlussonicClusterAuthHeader(
        String(srv.api_token || srv.password || srv.username || '').trim()
      );
    }
    const putRes = await fetchJsonWithTimeout(
      `${conn.effectiveBase}/streamer/api/v3/streams/${encName}`,
      { method: 'PUT', headers: reqHeaders, body: JSON.stringify(payload) },
      10000,
      conn.bridgeNode
    );
    const text = await putRes.text().catch(() => '');
    if (!putRes.ok) {
      return res.status(502).json({
        error: `Flussonic rechazó el cambio (HTTP ${putRes.status})`,
        detail: text.slice(0, 500),
        will_send: payload
      });
    }
    db.prepare('UPDATE drm_streams SET flussonic_stream = ?, updated_at = ? WHERE stream_id = ?').run(
      streamName,
      nowIso(),
      id
    );
    return res.json({ ok: true, action, server: conn.effectiveBase, stream: streamName, applied: payload });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});
