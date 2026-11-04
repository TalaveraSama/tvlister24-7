import { db } from './db.js';
import {
  buildFlussonicCandidateAuthHeaders,
  buildFlussonicClusterAuthHeader,
  normalizeBaseUrl,
  fetchJsonWithTimeout
} from './flussonic2312Manager.js';

// ============ SALIDA UDP DELEGADA A FLUSSONIC 23.12 (vía API) ==============
// Modo alternativo al motor UDP propio de TVLister:
//
//   local      -> TVLister abre el socket / lanza ffmpeg y empuja a udp://host:port
//                 (comportamiento de siempre, POR DEFECTO, intacto)
//   flussonic  -> el stream de Flussonic empuja él mismo a udp://host:port y
//                 TVLister sólo lo configura/verifica por su API
//
// La decisión es por canal CATV (canal 2..125) y nunca cambia sola: si algo
// falla en el modo Flussonic, se informa y el resto de canales sigue igual.

export const UDP_ENGINES = ['local', 'flussonic'];

// Campos de StreamConfig que se pueden reenviar en un PUT completo.
// (El GET devuelve además stats/estado de sólo lectura que Flussonic rechaza.)
const WRITABLE_STREAM_FIELDS = [
  'name',
  'title',
  'comment',
  'static',
  'inputs',
  'outputs',
  'transcoder',
  'source_timeout',
  'retry_interval',
  'disabled',
  'authorization',
  'meta',
  'options',
  'srt',
  'dvr',
  'archive',
  'push',
  'hls',
  'mp4',
  'subtitles',
  'thumbnails'
];

export function getFlussonicServer(id = null) {
  const rows = db.prepare('SELECT * FROM flussonic_servers ORDER BY id ASC').all();
  if (!rows.length) return null;
  if (id !== null && id !== undefined && id !== '') {
    return rows.find((r) => Number(r.id) === Number(id)) || null;
  }
  return rows[0];
}

export function listFlussonicServers() {
  return db.prepare('SELECT id, name, base_url, version, status FROM flussonic_servers ORDER BY id ASC').all();
}

/** udp://host:port?... — el mismo destino que usa el motor local. */
export function buildFlussonicUdpOutputUrl(slot = {}) {
  const host = String(slot.udp_host || '').trim();
  const port = Number(slot.udp_port) || 0;
  if (!host || !port) return '';
  const params = [];
  const pkt = Number(slot.pkt_size) || 0;
  if (pkt === 188 || pkt === 1316) params.push(`pkt_size=${pkt}`);
  const ttl = Number(slot.ttl) || 0;
  if (ttl > 0) params.push(`ttl=${Math.min(255, Math.max(1, ttl))}`);
  const bindIp = String(slot.local_interface_ip || '').trim();
  if (bindIp) params.push(`localaddr=${encodeURIComponent(bindIp)}`);
  const proto = Number(slot.rtp) === 1 ? 'rtp' : 'udp';
  return `${proto}://${host}:${port}${params.length ? '?' + params.join('&') : ''}`;
}

/** host:puerto de una salida (para reconocer la nuestra entre las demás). */
export function outputTargetKey(url = '') {
  const m = String(url).match(/^(?:udp|rtp):\/\/([^/?#]+)/i);
  if (!m) return '';
  return m[1].replace(/^@/, '').toLowerCase();
}

function headersFor(srv) {
  const cands = buildFlussonicCandidateAuthHeaders(srv);
  const headers = { ...(cands[0] || {}) };
  headers['Content-Type'] = 'application/json';
  if (headers.Authorization && String(headers.Authorization).startsWith('Cluster ')) {
    const secret = String(srv.api_token || srv.password || srv.username || '').trim();
    headers.Authorization = buildFlussonicClusterAuthHeader(secret);
  }
  return headers;
}

function apiBase(srv) {
  return `${normalizeBaseUrl(srv.base_url || '')}/streamer/api/v3`;
}

function apiError(resp, prefix) {
  const text = String(resp?.json?.error || resp?.json?.message || resp?.text || '').slice(0, 200);
  return `${prefix}: HTTP ${resp?.status || 0}${text ? ' — ' + text : ''}`;
}

async function getStreamConfig(srv, streamName) {
  const enc = String(streamName).split('/').map(encodeURIComponent).join('/');
  let r;
  try {
    r = await fetchJsonWithTimeout(`${apiBase(srv)}/streams/${enc}`, { headers: headersFor(srv) }, 8000);
  } catch (err) {
    return { error: `No se pudo conectar con Flussonic (${String(err?.message || err).slice(0, 120)}).` };
  }
  if (r.status === 401 || r.status === 403) {
    return { error: `Flussonic rechazó las credenciales (HTTP ${r.status}). Revisa usuario/clave o api_token del servidor.` };
  }
  if (!r.ok) return { error: apiError(r, `No se pudo leer el stream "${streamName}"`) };
  return { config: r.json || {} };
}

function normalizeOutputs(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((o) => (typeof o === 'string' ? { url: o } : o && typeof o === 'object' ? { ...o } : null))
    .filter((o) => o && o.url);
}

/**
 * Escribe la lista de salidas en el stream de Flussonic.
 * Intenta PATCH (cambio parcial); si el servidor no lo admite, hace GET + PUT
 * con sólo los campos escribibles, para no tocar transcoder/inputs.
 */
async function putOutputs(srv, streamName, outputs, config) {
  const enc = String(streamName).split('/').map(encodeURIComponent).join('/');
  const url = `${apiBase(srv)}/streams/${enc}`;
  const headers = headersFor(srv);

  const patch = await fetchJsonWithTimeout(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ outputs })
  }, 8000);
  if (patch.ok) return { ok: true, method: 'PATCH' };

  const patchUnsupported = [400, 404, 405, 422, 500, 501].includes(Number(patch.status));
  if (!patchUnsupported) {
    return { ok: false, error: apiError(patch, 'Flussonic no aceptó la salida UDP') };
  }

  const payload = {};
  for (const key of WRITABLE_STREAM_FIELDS) {
    if (config && config[key] !== undefined) payload[key] = config[key];
  }
  payload.name = config?.name || streamName;
  payload.outputs = outputs;

  const put = await fetchJsonWithTimeout(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload)
  }, 8000);
  if (put.ok) return { ok: true, method: 'PUT' };
  return {
    ok: false,
    error:
      apiError(put, 'Flussonic no aceptó la salida UDP') +
      (Number(put.status) === 409 ? ' (¿nombre de stream en uso?)' : '')
  };
}

/**
 * Configura (o corrige) la salida UDP de un stream de Flussonic apuntando al
 * mismo host:puerto que usaría el motor local. Idempotente.
 */
export async function applyFlussonicUdp({ serverId = null, streamName, slot }) {
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay ningún servidor Flussonic dado de alta (sección Flussonic 23.12).' };
  const name = String(streamName || '').trim();
  if (!name) return { ok: false, error: 'Falta el nombre del stream en Flussonic para este canal.' };
  const url = buildFlussonicUdpOutputUrl(slot);
  if (!url) return { ok: false, error: 'El canal no tiene destino UDP (host/puerto).' };

  const got = await getStreamConfig(srv, name);
  if (got.error) return { ok: false, error: got.error };

  const key = outputTargetKey(url);
  const existing = normalizeOutputs(got.config.outputs);
  // Se retira: (a) la que este canal había puesto antes (aunque haya cambiado el
  // puerto) y (b) cualquier salida que apunte ya al mismo host:puerto.
  const previousUrl = String(slot?.flussonic_output_url || '');
  const isOurs = (o) => outputTargetKey(o.url) === key || (previousUrl && o.url === previousUrl);
  const sameTarget = existing.filter(isOurs);
  const others = existing.filter((o) => !isOurs(o));

  if (sameTarget.length === 1 && sameTarget[0].url === url) {
    rememberOutputUrl(slot?.catv_ch, url);
    return { ok: true, already: true, url, streamName: name, server: srv.name, method: 'sin cambios' };
  }

  const outputs = [...others, { url }];
  const written = await putOutputs(srv, name, outputs, got.config);
  if (!written.ok) return { ok: false, error: written.error, streamName: name };
  rememberOutputUrl(slot?.catv_ch, url);
  return { ok: true, url, streamName: name, server: srv.name, method: written.method, previous: sameTarget.map((o) => o.url) };
}

/** Quita del stream de Flussonic la salida UDP de este canal. */
export async function removeFlussonicUdp({ serverId = null, streamName, slot }) {
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay servidor Flussonic configurado.' };
  const name = String(streamName || '').trim();
  if (!name) return { ok: false, error: 'Falta el nombre del stream en Flussonic.' };
  const targetUrl = buildFlussonicUdpOutputUrl(slot);
  const key = outputTargetKey(targetUrl);
  if (!key) return { ok: false, error: 'El canal no tiene destino UDP.' };

  const got = await getStreamConfig(srv, name);
  if (got.error) return { ok: false, error: got.error };

  const previousUrl = String(slot?.flussonic_output_url || '');
  const existing = normalizeOutputs(got.config.outputs);
  const keep = existing.filter(
    (o) => outputTargetKey(o.url) !== key && !(previousUrl && o.url === previousUrl)
  );
  if (keep.length === existing.length) {
    return { ok: true, already: true, removed: 0, streamName: name };
  }
  const written = await putOutputs(srv, name, keep, got.config);
  if (!written.ok) return { ok: false, error: written.error, streamName: name };
  rememberOutputUrl(slot?.catv_ch, '');
  return { ok: true, removed: existing.length - keep.length, streamName: name, server: srv.name, method: written.method };
}

/** Salidas UDP que hoy tiene el stream, para diagnosticar. */
export async function inspectFlussonicUdp({ serverId = null, streamName }) {
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay servidor Flussonic configurado.' };
  const got = await getStreamConfig(srv, streamName);
  if (got.error) return { ok: false, error: got.error };
  const outputs = normalizeOutputs(got.config.outputs).map((o) => o.url);
  return {
    ok: true,
    server: srv.name,
    streamName,
    outputs,
    inputs: normalizeOutputs(got.config.inputs).map((i) => i.url),
    static: Boolean(got.config.static)
  };
}

function rememberOutputUrl(catvCh, url) {
  if (!catvCh) return;
  try {
    db.prepare("UPDATE wk2500_channels SET flussonic_output_url = ? WHERE catv_ch = ?").run(String(url || ''), Number(catvCh));
  } catch {
    /* el recordatorio es sólo una ayuda; no debe tumbar la operación */
  }
}

export function normalizeUdpEngine(value) {
  const v = String(value || '').trim().toLowerCase();
  return UDP_ENGINES.includes(v) ? v : null;
}

/** Canales configurados en modo Flussonic, con lo necesario para reconciliar. */
export function listFlussonicEngineSlots() {
  return db
    .prepare(
      `SELECT w.catv_ch, w.udp_host, w.udp_port, w.ttl, w.pkt_size, w.rtp, w.local_interface_ip,
              w.flussonic_stream, w.flussonic_server_id, w.flussonic_output_url, w.enabled,
              s.name AS stream_name, s.flussonic_stream_name AS mapped_flussonic_name
         FROM wk2500_channels w
         LEFT JOIN streams s ON s.id = w.stream_id
        WHERE w.udp_engine = 'flussonic'
        ORDER BY w.catv_ch ASC`
    )
    .all();
}

/**
 * Reconciliación completa: deja en Flussonic exactamente las salidas UDP de los
 * canales marcados en modo Flussonic. No toca ni un byte del motor local.
 */
export async function syncFlussonicUdpOutputs({ onlyCatvCh = null } = {}) {
  const slots = listFlussonicEngineSlots().filter(
    (s) => onlyCatvCh === null || Number(s.catv_ch) === Number(onlyCatvCh)
  );
  const results = [];
  const usedBy = new Map(); // stream de Flussonic -> canal CATV que ya lo usa
  for (const slot of slots) {
    const name = slot.flussonic_stream || slot.mapped_flussonic_name || '';
    if (name && usedBy.has(name)) {
      results.push({
        catv_ch: slot.catv_ch,
        stream: name,
        ok: false,
        error:
          `El stream "${name}" ya lo está usando el CH${usedBy.get(name)}. Un stream de Flussonic sólo ` +
          `puede empujar a una salida UDP: asigna a este canal otro stream.`
      });
      continue;
    }
    if (name) usedBy.set(name, slot.catv_ch);
    const r = await applyFlussonicUdp({ serverId: slot.flussonic_server_id, streamName: name, slot });
    results.push({ catv_ch: slot.catv_ch, stream: name, ...r });
  }
  return {
    ok: results.every((r) => r.ok),
    total: results.length,
    applied: results.filter((r) => r.ok && !r.already).length,
    unchanged: results.filter((r) => r.ok && r.already).length,
    failed: results.filter((r) => !r.ok).length,
    results
  };
}

// ===================== CONTROL DE FLUSSONIC (v2.6.33) ======================
// Lo que faltaba para «enviar los canales desde Flussonic» sin teclear nada:
//
//   1. Leer del Flussonic real sus streams (nombre, título, vivo, bitrate).
//   2. Emparejar cada canal CATV con SU stream (mapeo automático, con
//      sugerencias cuando el nombre no coincide).
//   3. Cambiar el motor y empujar la salida UDP en un solo paso, verificando
//      después que Flussonic la tiene puesta.
//   4. Volver a TVLister (local) quitando primero la salida de Flussonic, para
//      que no haya dos emisores al mismo grupo.

/** Clave de comparación: sin acentos, sin prefijos [24/7], sin HD/FHD, minúsculas. */
export function normalizeChannelKey(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[\s*24\s*\/\s*7\s*\]/g, ' ')
    .replace(/\b(fhd|uhd|hd|sd|4k|hevc|h\.?264|h\.?265|mpeg2|mpeg4)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokensOf(text = '') {
  return new Set(normalizeChannelKey(text).split(' ').filter((w) => w.length > 1));
}

/** Parecido 0..1 por palabras en común (para sugerir cuando no hay exacto). */
export function nameSimilarity(a = '', b = '') {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common += 1;
  return common / Math.max(ta.size, tb.size);
}

/**
 * Streams que tiene el Flussonic registrado, con su estado. Se lee de la API
 * v3 (`/streams`) y se aprovechan los `stats` que ya trae cada stream.
 */
export async function listFlussonicStreams({ serverId = null } = {}) {
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay ningún servidor Flussonic dado de alta.', streams: [] };
  let r;
  try {
    r = await fetchJsonWithTimeout(`${apiBase(srv)}/streams?limit=5000`, { headers: headersFor(srv) }, 9500);
  } catch (err) {
    // Flussonic caído o sin ruta: se informa, nunca se tumba el panel.
    return {
      ok: false,
      error: `No se pudo conectar con Flussonic en ${srv.base_url} (${String(err?.message || err).slice(0, 120)}).`,
      streams: []
    };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: `Flussonic rechazó las credenciales (HTTP ${r.status}).`, streams: [] };
  }
  if (!r.ok) return { ok: false, error: apiError(r, 'No se pudo leer la lista de streams'), streams: [] };
  const raw = Array.isArray(r.json?.streams) ? r.json.streams : Array.isArray(r.json) ? r.json : [];
  const streams = raw.map((item) => {
    const stats = item.stats || {};
    return {
      name: String(item.name || '').trim(),
      title: String(item.title || item.name || '').trim(),
      alive: stats.alive !== false && stats.status !== 'error',
      bitrate_kbps: Math.round(Number(stats.bitrate || 0)),
      clients: Number(stats.client_count || 0),
      outputs: normalizeOutputs(item.outputs).map((o) => o.url),
      static: item.static !== false && !item.ondemand
    };
  });
  return { ok: true, server: { id: srv.id, name: srv.name, base_url: srv.base_url }, streams };
}

function slotFlussonicCandidates(slot = {}) {
  return [
    String(slot.flussonic_stream || '').trim(),
    String(slot.mapped_flussonic_name || '').trim(),
    String(slot.stream_name || '').trim(),
    String(slot.custom_name || '').trim()
  ].filter(Boolean);
}

/**
 * Mapeo automático canal CATV → stream de Flussonic.
 *
 * Orden: lo que ya está escrito a mano → nombre exacto (stream.name o title) →
 * un nombre contiene al otro → parecido por palabras (sólo si ≥ 0,6). Nunca
 * repite un stream: el primero que lo toma se lo queda.
 */
export async function autoMapFlussonicChannels({ serverId = null, dryRun = true, overwrite = false, minScore = 0.6 } = {}) {
  const listed = await listFlussonicStreams({ serverId });
  if (!listed.ok) return { ok: false, error: listed.error, mapped: [], unmatched: [] };

  const pool = listed.streams.filter((s) => s.name);
  const taken = new Map(); // stream -> catv_ch
  for (const row of db.prepare("SELECT catv_ch, flussonic_stream FROM wk2500_channels WHERE udp_engine = 'flussonic'").all()) {
    const nm = String(row.flussonic_stream || '').trim();
    if (nm && pool.some((s) => s.name === nm)) taken.set(nm, Number(row.catv_ch));
  }

  const slots = db
    .prepare(
      `SELECT w.catv_ch, w.custom_name, w.stream_id, w.flussonic_stream, w.udp_engine, w.enabled,
              s.name AS stream_name, s.flussonic_stream_name AS mapped_flussonic_name
         FROM wk2500_channels w
         LEFT JOIN streams s ON s.id = w.stream_id
        WHERE w.stream_id IS NOT NULL OR w.custom_source_url <> ''
        ORDER BY w.catv_ch ASC`
    )
    .all();

  const mapped = [];
  const unmatched = [];
  const updates = [];

  for (const slot of slots) {
    const current = String(slot.flussonic_stream || '').trim();
    if (current && pool.some((s) => s.name === current) && !overwrite) {
      mapped.push({ catv_ch: slot.catv_ch, stream: current, method: 'ya estaba', title: pool.find((s) => s.name === current)?.title || '' });
      if (!taken.has(current)) taken.set(current, Number(slot.catv_ch));
      continue;
    }

    const candidates = slotFlussonicCandidates(slot);
    let best = null;
    for (const cand of candidates) {
      const key = normalizeChannelKey(cand);
      if (!key) continue;
      const exact = pool.find((s) => normalizeChannelKey(s.name) === key || normalizeChannelKey(s.title) === key);
      if (exact) {
        best = { stream: exact, score: 1, method: 'nombre exacto' };
        break;
      }
      const contains = pool.find((s) => {
        const k = normalizeChannelKey(s.name);
        const t = normalizeChannelKey(s.title);
        return (k && (k.includes(key) || key.includes(k))) || (t && (t.includes(key) || key.includes(t)));
      });
      if (contains && !best) best = { stream: contains, score: 0.9, method: 'nombre contenido' };
    }
    if (!best) {
      // Último recurso: el más parecido por palabras.
      let top = null;
      for (const s of pool) {
        const score = Math.max(
          ...candidates.map((c) => Math.max(nameSimilarity(c, s.name), nameSimilarity(c, s.title)))
        );
        if (!top || score > top.score) top = { stream: s, score, method: 'parecido' };
      }
      if (top && top.score >= minScore) best = top;
    }

    if (!best) {
      const suggestions = pool
        .map((s) => ({
          name: s.name,
          title: s.title,
          score: Number(
            Math.max(...candidates.map((c) => Math.max(nameSimilarity(c, s.name), nameSimilarity(c, s.title)))).toFixed(2)
          )
        }))
        .filter((s) => s.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      unmatched.push({
        catv_ch: slot.catv_ch,
        name: slot.custom_name || slot.stream_name || `CH ${slot.catv_ch}`,
        suggestions
      });
      continue;
    }

    const owner = taken.get(best.stream.name);
    if (owner !== undefined && Number(owner) !== Number(slot.catv_ch)) {
      unmatched.push({
        catv_ch: slot.catv_ch,
        name: slot.custom_name || slot.stream_name || `CH ${slot.catv_ch}`,
        reason: `El stream "${best.stream.name}" ya lo usa el CH${owner}`,
        suggestions: []
      });
      continue;
    }
    taken.set(best.stream.name, Number(slot.catv_ch));
    mapped.push({
      catv_ch: slot.catv_ch,
      stream: best.stream.name,
      title: best.stream.title,
      alive: best.stream.alive,
      bitrate_kbps: best.stream.bitrate_kbps,
      method: best.method,
      score: Number((best.score || 0).toFixed(2))
    });
    if (current !== best.stream.name) updates.push({ catv_ch: slot.catv_ch, stream: best.stream.name });
  }

  if (!dryRun) {
    const stmt = db.prepare('UPDATE wk2500_channels SET flussonic_stream = ?, updated_at = datetime(\'now\') WHERE catv_ch = ?');
    for (const u of updates) stmt.run(u.stream, u.catv_ch);
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    server: listed.server,
    available_streams: pool.length,
    mapped,
    unmatched,
    written: dryRun ? 0 : updates.length,
    candidates: updates.length
  };
}

/**
 * Foto del control: qué canales van por Flussonic, si el stream existe y está
 * vivo, y si Flussonic tiene puesta la salida UDP correcta. Es lo que pinta el
 * panel y lo que usa `tvlister-admin catv flussonic status`.
 */
export async function flussonicControlSnapshot({ serverId = null, refresh = true } = {}) {
  const rows = db
    .prepare(
      `SELECT w.catv_ch, w.udp_host, w.udp_port, w.ttl, w.pkt_size, w.rtp, w.local_interface_ip,
              w.flussonic_stream, w.flussonic_server_id, w.flussonic_output_url, w.enabled, w.udp_engine,
              w.custom_source_url,
              s.name AS stream_name, s.flussonic_stream_name AS mapped_flussonic_name
         FROM wk2500_channels w
         LEFT JOIN streams s ON s.id = w.stream_id
        ORDER BY w.catv_ch ASC`
    )
    .all();

  const delegated = rows.filter((r) => r.udp_engine === 'flussonic');
  const local = rows.filter((r) => (r.udp_engine || 'local') !== 'flussonic');

  // Siempre se consulta (aunque todavía no haya canales delegados): el panel
  // tiene que poder decir «Flussonic responde y tiene N streams» antes de mover
  // nada, que es justo cuando se decide mandar los canales desde ahí.
  let listed = { ok: false, streams: [], error: refresh ? 'sin consultar' : '' };
  if (refresh) listed = await listFlussonicStreams({ serverId });

  const byName = new Map((listed.streams || []).map((s) => [s.name, s]));
  const channels = delegated.map((row) => {
    const stream = String(row.flussonic_stream || row.mapped_flussonic_name || '').trim();
    const expected = buildFlussonicUdpOutputUrl(row);
    const info = stream ? byName.get(stream) : null;
    const hasOutput = info ? info.outputs.some((u) => outputTargetKey(u) === outputTargetKey(expected)) : false;
    const exists = Boolean(info);
    let verdict = 'ok';
    if (!stream) verdict = 'sin_stream';
    else if (!refresh) verdict = 'sin_verificar';
    else if (!exists) verdict = 'stream_inexistente';
    else if (!info.alive) verdict = 'stream_caido';
    else if (!hasOutput) verdict = 'sin_salida';
    return {
      catv_ch: Number(row.catv_ch),
      name: row.stream_name || `CH ${row.catv_ch}`,
      enabled: Boolean(row.enabled),
      stream,
      dest: expected,
      exists,
      alive: info ? info.alive : null,
      bitrate_kbps: info ? info.bitrate_kbps : 0,
      clients: info ? info.clients : 0,
      has_output: hasOutput,
      outputs: info ? info.outputs : [],
      verdict
    };
  });

  const counts = channels.reduce((acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] || 0) + 1 }), {});
  return {
    ok: true,
    server: listed.server || getFlussonicServer(serverId) || null,
    flussonic_reachable: listed.ok,
    flussonic_error: listed.ok ? '' : listed.error || '',
    streams_available: (listed.streams || []).length,
    local_channels: local.filter((r) => r.stream_name || r.custom_source_url).length,
    flussonic_channels: delegated.length,
    channels,
    counts,
    ready: listed.ok && channels.length > 0 && channels.every((c) => c.verdict === 'ok')
  };
}
