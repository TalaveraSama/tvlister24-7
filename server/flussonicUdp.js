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
  // Si el operador fijó una interfaz de salida (ens37), el motor delegado
  // escribe la salida igual que la tarjeta de push: udp://ens37@IP:PUERTO.
  const pushIface = String(slot.push_interface || getPushInterface() || '').trim();
  const params = [];
  const pkt = Number(slot.pkt_size) || 0;
  if (pkt === 188 || pkt === 1316) params.push(`pkt_size=${pkt}`);
  const ttl = Number(slot.ttl) || 0;
  if (ttl > 0) params.push(`ttl=${Math.min(255, Math.max(1, ttl))}`);
  const bindIp = String(slot.local_interface_ip || '').trim();
  if (bindIp) params.push(`localaddr=${encodeURIComponent(bindIp)}`);
  const proto = Number(slot.rtp) === 1 ? 'rtp' : 'udp';
  return `${proto}://${pushIface ? pushIface + '@' : ''}${host}:${port}${params.length ? '?' + params.join('&') : ''}`;
}

/** host:puerto de una salida (para reconocer la nuestra entre las demás). */
export function outputTargetKey(url = '') {
  const m = String(url).match(/^(?:udp|rtp):\/\/([^/?#]+)/i);
  if (!m) return '';
  // Flussonic escribe la interfaz de salida delante: udp://ens37@239.1.1.2:1002
  return m[1].replace(/^[^@]*@/, '').replace(/^@/, '').toLowerCase();
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

/**
 * PATCH parcial de un stream (sólo los campos que se mandan). Se usa para el
 * nombre de servicio del TS y para el título, sin tocar entradas ni salidas.
 */
async function patchStream(srv, streamName, patch) {
  const enc = String(streamName).split('/').map(encodeURIComponent).join('/');
  const headers = headersFor(srv);
  const r = await fetchJsonWithTimeout(
    `${apiBase(srv)}/streams/${enc}`,
    { method: 'PATCH', headers, body: JSON.stringify(patch) },
    8000
  );
  if (r.ok) return { ok: true, method: 'PATCH' };
  const unsupported = [400, 404, 405, 422, 500, 501].includes(Number(r.status));
  if (!unsupported) return { ok: false, error: apiError(r, 'Flussonic no aceptó el cambio') };
  // Algunos 23.12 no admiten PATCH parcial: PUT con el stream tal cual + el campo.
  const got = await getStreamConfig(srv, streamName);
  if (got.error) return { ok: false, error: got.error };
  const payload = {};
  for (const key of WRITABLE_STREAM_FIELDS) {
    if (got.config && got.config[key] !== undefined) payload[key] = got.config[key];
  }
  payload.name = got.config?.name || streamName;
  Object.assign(payload, patch);
  const put = await fetchJsonWithTimeout(
    `${apiBase(srv)}/streams/${enc}`,
    { method: 'PUT', headers, body: JSON.stringify(payload) },
    8000
  );
  if (put.ok) return { ok: true, method: 'PUT' };
  return { ok: false, error: apiError(put, 'Flussonic no aceptó el cambio') };
}

/**
 * Nombre de servicio del canal dentro del MPEG-TS (el que ven los equipos al
 * escanear). Se intenta `mpegts.service_name` (SDT exacto) y, si esa versión no
 * lo guarda, se escribe en `title` (Flussonic lo usa como nombre del servicio).
 */
async function writeServiceName(srv, streamName, serviceName, config) {
  const patch = { mpegts: { ...(config?.mpegts || {}), service_name: serviceName } };
  const first = await patchStream(srv, streamName, patch);
  if (first.ok) {
    const check = await getStreamConfig(srv, streamName);
    if (!check.error && String(check.config?.mpegts?.service_name || '') === serviceName) {
      return { ok: true, method: 'mpegts.service_name', field: 'mpegts.service_name' };
    }
  }
  const second = await patchStream(srv, streamName, { title: serviceName });
  if (!second.ok) return { ok: false, error: second.error || first.error || 'Flussonic no aceptó el nombre' };
  return { ok: true, method: 'title', field: 'title' };
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

  // Misma IP:puerto = ya está bien; no se pisa lo que el operador escribió
  // (interfaz, ttl, pkt_size) ni se pelea con la tarjeta de push cada 4 s.
  if (sameTarget.length === 1 && outputTargetKey(sameTarget[0].url) === key) {
    rememberOutputUrl(slot?.catv_ch, sameTarget[0].url);
    return { ok: true, already: true, url: sameTarget[0].url, streamName: name, server: srv.name, method: 'sin cambios' };
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
/**
 * Estado de las salidas (el «running · 134.2 MB» de la pantalla *Push live*).
 * La API v3 lo pone en sitios distintos según la versión: se busca en todos y
 * se devuelve la lista plana; si no viene, queda vacía (la columna muestra —).
 */
function extractPushStats(item = {}) {
  const pockets = [
    item.stats?.push,
    item.stats?.outputs,
    item.push?.outputs,
    item.push,
    item.outputs,
    item.stats?.output
  ];
  const out = [];
  for (const pocket of pockets) {
    const list = Array.isArray(pocket) ? pocket : pocket && typeof pocket === 'object' ? [pocket] : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const url = String(entry.url || entry.id || entry.name || '').trim();
      if (!url) continue;
      out.push({
        url,
        state: String(entry.state || entry.status || (entry.running === true ? 'running' : '') || ''),
        bytes: Number(entry.bytes || entry.bytes_sent || entry.total_bytes || 0),
        speed: Number(entry.speed || entry.bitrate || 0),
        errors: Number(entry.errors || 0)
      });
    }
  }
  return out;
}

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
      service_name: String(item.mpegts?.service_name || item.title || item.name || '').trim(),
      service_source: item.mpegts?.service_name ? 'mpegts' : 'titulo',
      outputs: normalizeOutputs(item.outputs).map((o) => o.url),
      output_details: normalizeOutputs(item.outputs).map((o) => ({
        url: o.url,
        enabled: o.enabled !== false && o.disabled !== true,
        comment: String(o.comment || ''),
        state: String(o.state || o.status || ''),
        bytes: Number(o.bytes || o.bytes_sent || 0)
      })),
      push_stats: extractPushStats(item),
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
/**
 * Cuántas portadoras comparten cada nombre (la lista del operador repite
 * «NACIONAL» en 9 canales). Un nombre compartido no sirve para emparejar solo.
 */
export function channelNameCounts() {
  const rows = db.prepare('SELECT custom_name FROM wk2500_channels WHERE custom_name <> \'\'').all();
  const counts = new Map();
  for (const r of rows) {
    const k = normalizeChannelKey(r.custom_name);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

export function computeChannelStreamMap(pool = [], slots = [], { overwrite = false, minScore = 0.6 } = {}) {
  const taken = new Map(); // stream -> catv_ch (el primero que lo toma se lo queda)
  const nameCounts = channelNameCounts();
  for (const row of db.prepare("SELECT catv_ch, flussonic_stream FROM wk2500_channels WHERE udp_engine = 'flussonic'").all()) {
    const nm = String(row.flussonic_stream || '').trim();
    if (nm && pool.some((s) => s.name === nm)) taken.set(nm, Number(row.catv_ch));
  }

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

    // El nombre del canal sólo empareja si es suyo y de nadie más: con
    // «NACIONAL» repetido, emparejar por nombre sería un revoltijo.
    const ownName = normalizeChannelKey(slot.custom_name || slot.stream_name || '');
    const sharedName = ownName && (nameCounts.get(ownName) || 0) > 1;
    const candidates = slotFlussonicCandidates(slot).filter((c) => {
      if (!sharedName) return true;
      // Se deja pasar sólo si coincide exacto con un stream (raro) para no
      // perder un mapeo ya escrito a mano.
      return pool.some((s) => normalizeChannelKey(s.name) === normalizeChannelKey(c));
    });
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
        reason: sharedName
          ? `El nombre «${slot.custom_name}» lo comparten ${nameCounts.get(ownName)} canales: asígnalo a mano`
          : '',
        shared_name: Boolean(sharedName),
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

  return { mapped, unmatched, updates, taken };
}

export async function autoMapFlussonicChannels({ serverId = null, dryRun = true, overwrite = false, minScore = 0.6 } = {}) {
  const listed = await listFlussonicStreams({ serverId });
  if (!listed.ok) return { ok: false, error: listed.error, mapped: [], unmatched: [] };

  const pool = listed.streams.filter((s) => s.name);
  const slots = db
    .prepare(
      `SELECT w.catv_ch, w.custom_name, w.stream_id, w.flussonic_stream, w.udp_engine, w.enabled,
              s.name AS stream_name, s.flussonic_stream_name AS mapped_flussonic_name
         FROM wk2500_channels w
         LEFT JOIN streams s ON s.id = w.stream_id
        WHERE w.stream_id IS NOT NULL
           OR w.custom_source_url <> ''
           OR (w.udp_host <> '' AND w.udp_port > 0)
        ORDER BY w.catv_ch ASC`
    )
    .all();

  const { mapped, unmatched, updates } = computeChannelStreamMap(pool, slots, { overwrite, minScore });

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
              w.custom_source_url, w.custom_name,
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
      channel_name: String(row.custom_name || row.stream_name || `CH ${row.catv_ch}`).trim(),
      stream_title: info ? String(info.title || '') : '',
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

// ================== PUSH UDP DE FLUSSONIC (v2.6.34) ========================
// Lo mismo que se hace a mano en «Push live video to certain URLs» de
// Flussonic, pero desde el panel y con la lista de canales de TVLister:
//   stream ya existente en Flussonic → se le pone/quita la salida UDP del canal.
// No cambia el motor de TVLister salvo que se pida (takeOver), y nunca toca
// las salidas que no son UDP (rtmp/srt/http) del usuario.

const PUSH_IFACE_KEY = 'catv_push_interface';

export function getPushInterface() {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(PUSH_IFACE_KEY)?.value || '').trim();
  } catch {
    return '';
  }
}

export function setPushInterface(value) {
  const v = String(value || '').trim();
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(PUSH_IFACE_KEY, v);
  } catch {
    /* preferencia, no crítica */
  }
  return v;
}

export function isUdpPush(url = '') {
  return /^(?:udp|rtp):\/\//i.test(String(url).trim());
}

/**
 * udp://[interfaz@]host:puerto[?...]  →  piezas.
 * La interfaz delante (`ens37@239.1.1.2:1002`) es la forma que usa Flussonic
 * en su pantalla de push; se devuelve tal cual, sin reinterpretarla.
 */
export function parsePushUrl(raw = '') {
  const url = String(raw || '').trim();
  const m = /^(udp|rtp):\/\/(.+)$/i.exec(url);
  if (!m) return null;
  let rest = m[2];
  const q = rest.indexOf('?');
  const params = q >= 0 ? rest.slice(q + 1) : '';
  rest = q >= 0 ? rest.slice(0, q) : rest;
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  const at = rest.lastIndexOf('@');
  const iface = at >= 0 ? rest.slice(0, at) : '';
  const hostPort = at >= 0 ? rest.slice(at + 1) : rest;
  const hp = /^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/.exec(hostPort) || /^([^:]+):(\d{1,5})$/.exec(hostPort);
  if (!hp) return null;
  const port = Number(hp[2]);
  if (!port || port > 65535) return null;
  return {
    proto: m[1].toLowerCase(),
    iface,
    host: hp[1],
    port,
    params,
    multicast: /^2(2[4-9]|3\d)\./.test(hp[1]) || /^ff/i.test(hp[1])
  };
}

export function formatPushUrl({ proto = 'udp', iface = '', host = '', port = 0, params = '' } = {}) {
  if (!host || !port) return '';
  const pre = iface ? `${iface}@` : '';
  return `${proto}://${pre}${host}:${port}${params ? `?${params}` : ''}`;
}

/** Añade la interfaz de salida (ens37@) si la URL no la trae. */
export function withPushInterface(url = '', iface = '') {
  const parsed = parsePushUrl(url);
  if (!parsed || parsed.iface || !iface) return String(url || '').trim();
  return formatPushUrl({ ...parsed, iface });
}

/** URL de push del canal: udp://[interfaz@]IP:PUERTO, tal cual el destino. */
export function buildPushUrlFromChannel(slot = {}, iface = '') {
  const host = String(slot.udp_host || '').trim();
  const port = Number(slot.udp_port) || 0;
  if (!host || !port) return '';
  return formatPushUrl({ proto: Number(slot.rtp) === 1 ? 'rtp' : 'udp', iface, host, port });
}

function pushStatusFor(stream, url) {
  const key = outputTargetKey(url);
  if (!key) return { state: '', running: false, bytes: 0, mb: 0 };
  const hit = (stream.push_stats || []).find((p) => outputTargetKey(p.url) === key);
  if (hit) {
    const state = String(hit.state || '').toLowerCase();
    const running = /run|active|play|connect/.test(state) || hit.bytes > 0;
    return { state: hit.state || (running ? 'running' : ''), running, bytes: hit.bytes || 0, mb: Number(((hit.bytes || 0) / 1048576).toFixed(1)) };
  }
  const det = (stream.output_details || []).find((o) => outputTargetKey(o.url) === key);
  if (det) {
    const running = Boolean(det.state && /run|active|play/.test(String(det.state).toLowerCase()));
    return { state: det.state || '', running, bytes: det.bytes || 0, mb: Number(((det.bytes || 0) / 1048576).toFixed(1)) };
  }
  return { state: '', running: false, bytes: 0, mb: 0 };
}

function channelSlotsForPush() {
  return db
    .prepare(
      `SELECT w.catv_ch, w.custom_name, w.udp_host, w.udp_port, w.ttl, w.pkt_size, w.rtp, w.local_interface_ip,
              w.flussonic_stream, w.flussonic_output_url, w.flussonic_server_id, w.udp_engine, w.enabled,
              w.stream_id, w.custom_source_url,
              s.name AS stream_name, s.flussonic_stream_name AS mapped_flussonic_name
         FROM wk2500_channels w
         LEFT JOIN streams s ON s.id = w.stream_id
        WHERE w.stream_id IS NOT NULL
           OR w.custom_source_url <> ''
           OR (w.udp_host <> '' AND w.udp_port > 0)
        ORDER BY w.catv_ch ASC`
    )
    .all();
}

/**
 * Foto para la tarjeta: todos los streams de Flussonic con su push UDP actual,
 * su estado y el canal de la lista al que corresponden.
 */
export async function flussonicPushSnapshot({ serverId = null, refresh = true } = {}) {
  const srv = getFlussonicServer(serverId);
  const iface = getPushInterface();
  if (!srv) {
    return {
      ok: true,
      server: null,
      flussonic_reachable: false,
      flussonic_error: 'No hay ningún servidor Flussonic dado de alta.',
      iface,
      streams: [],
      total: 0,
      with_push: 0,
      channels_sin_stream: []
    };
  }

  let listed = { ok: true, streams: [], server: null, error: '' };
  if (refresh) listed = await listFlussonicStreams({ serverId });
  const pool = (listed.streams || []).filter((s) => s.name);
  const slots = channelSlotsForPush();
  const { mapped } = computeChannelStreamMap(pool, slots, {});
  const byCh = new Map(mapped.map((m) => [Number(m.catv_ch), m]));
  const nameCountsForPush = channelNameCounts();
  const channelByStream = new Map();
  const channelsSinStream = [];
  for (const slot of slots) {
    const m = byCh.get(Number(slot.catv_ch));
    if (!m) {
      channelsSinStream.push({
        catv_ch: Number(slot.catv_ch),
        name: slot.custom_name || slot.stream_name || `CH ${slot.catv_ch}`,
        dest: buildPushUrlFromChannel(slot, iface),
        shared_name: (nameCountsForPush.get(normalizeChannelKey(slot.custom_name || '')) || 0) > 1
      });
      continue;
    }
    channelByStream.set(m.stream, {
      catv_ch: Number(slot.catv_ch),
      name: slot.custom_name || slot.stream_name || `CH ${slot.catv_ch}`,
      service_name: String(slot.custom_name || '').trim(),
      dest: buildPushUrlFromChannel(slot, iface),
      host: slot.udp_host,
      port: Number(slot.udp_port) || 0,
      engine: slot.udp_engine || 'local',
      enabled: Boolean(slot.enabled),
      method: m.method,
      flussonic_output_url: slot.flussonic_output_url || '',
      stream_title: ''
    });
  }

  const streams = pool.map((s) => {
    const channel = channelByStream.get(s.name) || null;
    if (channel) channel.stream_title = s.title;
    const udpUrls = (s.outputs || []).filter(isUdpPush);
    const suggested = channel?.dest || '';
    const primary =
      (suggested && udpUrls.find((u) => outputTargetKey(u) === outputTargetKey(suggested))) || udpUrls[0] || '';
    const rt = primary ? pushStatusFor(s, primary) : { state: '', running: false, bytes: 0, mb: 0 };
    return {
      name: s.name,
      title: s.title,
      alive: s.alive,
      bitrate_kbps: s.bitrate_kbps,
      clients: s.clients,
      udp_outputs: udpUrls,
      other_outputs: (s.outputs || []).filter((u) => !isUdpPush(u)),
      push: primary ? { url: primary, ...rt } : null,
      channel,
      suggested_url: suggested,
      in_sync: Boolean(primary && suggested && outputTargetKey(primary) === outputTargetKey(suggested))
    };
  });

  // Vista por canal (la que usa el operador: «CH4 → este stream»).
  const byStreamName = new Map(streams.map((st) => [st.name, st]));
  const channels = slots.map((slot) => {
    const ch = Number(slot.catv_ch);
    const name = String(slot.custom_name || slot.stream_name || `CH ${ch}`).trim();
    const mapped = byCh.get(ch) || null;
    const stream = mapped ? mapped.stream : '';
    const st = stream ? byStreamName.get(stream) : null;
    const dest = buildPushUrlFromChannel(slot, iface);
    return {
      catv_ch: ch,
      name,
      service_name: name,
      dest,
      shared_name: (nameCountsForPush.get(normalizeChannelKey(slot.custom_name || '')) || 0) > 1,
      stream,
      stream_title: st ? st.title : '',
      stream_exists: Boolean(st),
      stream_alive: st ? st.alive : null,
      push: st ? st.push : null,
      has_output: Boolean(st && st.push && dest && outputTargetKey(st.push.url) === outputTargetKey(dest)),
      in_sync: Boolean(st && st.in_sync),
      other_udp: st ? st.udp_outputs.filter((u) => outputTargetKey(u) !== outputTargetKey(dest)) : [],
      other_outputs: st ? st.other_outputs : [],
      engine: slot.udp_engine || 'local',
      enabled: Boolean(slot.enabled),
      ok: Boolean(stream) && Boolean(dest)
    };
  });

  return {
    ok: true,
    server: listed.server || { id: srv.id, name: srv.name, base_url: srv.base_url },
    flussonic_reachable: listed.ok,
    flussonic_error: listed.ok ? '' : listed.error || '',
    iface,
    streams,
    channels,
    total: streams.length,
    with_push: streams.filter((s) => s.push).length,
    in_sync: streams.filter((s) => s.in_sync).length,
    channels_total: channels.length,
    channels_mapped: channels.filter((c) => c.stream).length,
    channels_con_salida: channels.filter((c) => c.has_output).length,
    channels_sin_stream: channelsSinStream
  };
}

/**
 * Pone (o quita) la salida UDP de UN stream.
 *   replaceUdp=true  → deja una sola salida UDP, la indicada (la del canal).
 *   replaceUdp=false → sólo añade/actualiza la del mismo destino; las demás UDP
 *                      del usuario se conservan.
 * Las salidas que no son UDP nunca se tocan.
 */
export async function applyStreamPush({
  serverId = null,
  streamName,
  url = '',
  iface = null,
  remove = false,
  replaceUdp = false,
  removeAllUdp = false
} = {}) {
  // iface=null → la interfaz guardada; iface='' → no añadir ninguna.
  const outIface = iface === null || iface === undefined ? getPushInterface() : String(iface);
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay ningún servidor Flussonic dado de alta.' };
  const name = String(streamName || '').trim();
  if (!name) return { ok: false, error: 'Falta el nombre del stream de Flussonic.' };

  const got = await getStreamConfig(srv, name);
  if (got.error) return { ok: false, error: got.error, stream: name };

  const existing = normalizeOutputs(got.config.outputs);
  const wanted = String(url || '').trim();
  if (!remove && !wanted) return { ok: false, error: 'Falta la URL de salida UDP.', stream: name };
  if (!remove && !parsePushUrl(withPushInterface(wanted, outIface))) {
    return { ok: false, error: `La salida no es una URL UDP válida: ${wanted}`, stream: name };
  }
  const target = withPushInterface(remove ? url : wanted, outIface);
  const key = outputTargetKey(target);

  let outputs;
  if (remove) {
    const isMine = (o) => isUdpPush(o.url) && (removeAllUdp || !key || outputTargetKey(o.url) === key);
    outputs = existing.filter((o) => !isMine(o));
  } else {
    const sameIdx = existing.findIndex((o) => isUdpPush(o.url) && outputTargetKey(o.url) === key);
    if (replaceUdp) {
      const others = existing.filter((o) => !isUdpPush(o.url));
      outputs = [...others, sameIdx >= 0 ? { ...existing[sameIdx], url: target } : { url: target }];
    } else if (sameIdx >= 0) {
      outputs = existing.map((o, i) => (i === sameIdx ? { ...o, url: target } : o));
    } else {
      outputs = [...existing, { url: target }];
    }
  }

  const before = existing.map((o) => o.url);
  const after = outputs.map((o) => o.url);
  if (before.length === after.length && before.every((u, i) => u === after[i])) {
    return { ok: true, already: true, action: 'sin cambios', stream: name, url: target, outputs: after, removed: 0 };
  }

  const written = await putOutputs(srv, name, outputs, got.config);
  if (!written.ok) return { ok: false, error: written.error, stream: name };
  return {
    ok: true,
    already: false,
    action: remove ? 'quitada' : 'puesta',
    stream: name,
    url: remove ? '' : target,
    outputs: after,
    removed: before.length - after.length,
    method: written.method
  };
}

/** Plan (sin escribir) de las salidas UDP de los canales de un rango. */
export async function planChannelPushes({ serverId = null, chStart = 2, chEnd = 125, iface = '' } = {}) {
  const listed = await listFlussonicStreams({ serverId });
  if (!listed.ok) return { ok: false, error: listed.error, plan: [], sin_stream: [] };
  const pool = (listed.streams || []).filter((s) => s.name);
  const byName = new Map(pool.map((s) => [s.name, s]));
  const from = Math.max(2, Number(chStart) || 2);
  const to = Math.min(125, Number(chEnd) || 125);
  const slots = channelSlotsForPush().filter((s) => Number(s.catv_ch) >= from && Number(s.catv_ch) <= to);
  const { mapped, unmatched } = computeChannelStreamMap(pool, slots, {});
  const used = new Set();

  const plan = [];
  for (const m of mapped) {
    const slot = slots.find((s) => Number(s.catv_ch) === Number(m.catv_ch));
    if (!slot) continue;
    if (used.has(m.stream)) continue;
    used.add(m.stream);
    const url = buildPushUrlFromChannel(slot, iface);
    const stream = byName.get(m.stream);
    const udpUrls = (stream?.outputs || []).filter(isUdpPush);
    const current = url ? udpUrls.find((u) => outputTargetKey(u) === outputTargetKey(url)) || udpUrls[0] || '' : '';
    plan.push({
      catv_ch: Number(slot.catv_ch),
      name: slot.custom_name || slot.stream_name || `CH ${slot.catv_ch}`,
      stream: m.stream,
      method: m.method,
      url,
      current_url: current,
      ok: Boolean(url),
      error: url ? '' : 'El canal no tiene IP/puerto de destino UDP',
      engine: slot.udp_engine || 'local'
    });
  }

  const sinStream = unmatched.map((u) => ({
    catv_ch: u.catv_ch,
    name: u.name,
    reason: u.reason || 'sin stream de Flussonic reconocido',
    suggestions: u.suggestions || []
  }));

  return {
    ok: true,
    server: listed.server,
    range: { from, to },
    iface,
    plan,
    sin_stream: sinStream,
    listos: plan.filter((p) => p.ok).length,
    con_salida: plan.filter((p) => p.current_url).length,
    available_streams: pool.length
  };
}

async function inPool(items, size, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Aplica en Flussonic la salida UDP de cada canal del rango.
 * takeOver=true deja el canal en modo Flussonic (TVLister deja de emitir).
 */
export async function applyChannelPushes({
  serverId = null,
  chStart = 2,
  chEnd = 125,
  iface = '',
  remove = false,
  dryRun = true,
  takeOver = false
} = {}) {
  const planned = await planChannelPushes({ serverId, chStart, chEnd, iface: iface || getPushInterface() });
  if (!planned.ok) return { ...planned };

  const items = planned.plan.filter((p) => p.ok && p.url);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      remove,
      iface: planned.iface,
      plan: planned.plan,
      sin_stream: planned.sin_stream,
      applied: 0,
      failed: 0,
      changed: items.filter((p) => (remove ? p.current_url : !p.current_url)).length,
      detail: items.map((p) => ({ catv_ch: p.catv_ch, stream: p.stream, url: p.url, action: 'pendiente' })),
      taken_over: []
    };
  }

  const results = await inPool(items, 4, async (p) => {
    const r = await applyStreamPush({
      serverId,
      streamName: p.stream,
      url: p.url,
      iface: planned.iface,
      remove,
      replaceUdp: !remove
    });
    if (r.ok) {
      rememberOutputUrl(p.catv_ch, remove ? '' : r.url || p.url);
      try {
        db.prepare("UPDATE wk2500_channels SET flussonic_stream = ?, updated_at = datetime('now') WHERE catv_ch = ?").run(
          p.stream,
          p.catv_ch
        );
      } catch {
        /* el mapeo ya venía del nombre; no es crítico */
      }
    }
    return { catv_ch: p.catv_ch, name: p.name, stream: p.stream, url: r.url || p.url, ok: Boolean(r.ok), already: Boolean(r.already), error: r.error || '' };
  });

  const takenOver = [];
  if (takeOver && !remove) {
    for (const r of results) {
      if (!r.ok) continue;
      const slot = db.prepare('SELECT udp_engine FROM wk2500_channels WHERE catv_ch = ?').get(r.catv_ch);
      if (!slot) continue;
      if ((slot.udp_engine || 'local') !== 'flussonic') {
        db.prepare("UPDATE wk2500_channels SET udp_engine = 'flussonic', updated_at = datetime('now') WHERE catv_ch = ?").run(r.catv_ch);
        takenOver.push(r.catv_ch);
      }
    }
  }

  const applied = results.filter((r) => r.ok).length;
  return {
    ok: results.every((r) => r.ok),
    dryRun: false,
    remove,
    iface: planned.iface,
    range: planned.range,
    plan: planned.plan,
    sin_stream: planned.sin_stream,
    detail: results,
    applied,
    failed: results.length - applied,
    taken_over: takenOver,
    message: remove
      ? `${applied} de ${results.length} stream(s) sin la salida UDP del canal.`
      : `${applied} de ${results.length} stream(s) con la salida UDP del canal${takenOver.length ? ` · ${takenOver.length} canal(es) pasados a Flussonic` : ''}.`
  };
}

/** Aplica/quito el push de una lista concreta de streams (edición fila a fila). */
export async function applyStreamPushItems({ serverId = null, items = [], dryRun = false, takeOver = false, iface = '' } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((i) => ({
      stream: String(i.stream || i.name || '').trim(),
      url: String(i.url || '').trim(),
      remove: i.remove === true
    }))
    .filter((i) => i.stream);
  if (!list.length) return { ok: false, error: 'No hay streams que actualizar.', detail: [] };
  if (dryRun) {
    // La vista previa también valida: no se enseña como buena una URL que la
    // API rechazaría al aplicarla.
    const detail = list.map((i) => {
      const url = withPushInterface(i.url, iface === null || iface === undefined ? getPushInterface() : String(iface));
      const bad = !i.remove && (!url || !parsePushUrl(url));
      return { ...i, url, ok: !bad, action: bad ? 'error' : 'pendiente', error: bad ? 'La salida no es una URL UDP válida' : '' };
    });
    const failed = detail.filter((d) => !d.ok).length;
    return { ok: failed === 0, dryRun: true, detail, applied: 0, failed };
  }

  const channelByStream = new Map();
  for (const slot of channelSlotsForPush()) {
    const nm = String(slot.flussonic_stream || slot.mapped_flussonic_name || '').trim();
    if (nm && !channelByStream.has(nm)) channelByStream.set(nm, slot);
  }

  const detail = [];
  for (const it of list) {
    const r = await applyStreamPush({ serverId, streamName: it.stream, url: it.url, iface, remove: it.remove });
    const slot = channelByStream.get(it.stream);
    if (r.ok && slot) rememberOutputUrl(slot.catv_ch, it.remove ? '' : r.url || it.url);
    detail.push({
      stream: it.stream,
      url: r.url || it.url,
      catv_ch: slot ? Number(slot.catv_ch) : null,
      ok: Boolean(r.ok),
      already: Boolean(r.already),
      action: r.action || '',
      error: r.error || ''
    });
  }

  const takenOver = [];
  if (takeOver) {
    for (const d of detail) {
      if (!d.ok || !d.catv_ch) continue;
      const slot = db.prepare('SELECT udp_engine FROM wk2500_channels WHERE catv_ch = ?').get(d.catv_ch);
      if (slot && (slot.udp_engine || 'local') !== 'flussonic') {
        db.prepare("UPDATE wk2500_channels SET udp_engine = 'flussonic', updated_at = datetime('now') WHERE catv_ch = ?").run(d.catv_ch);
        takenOver.push(d.catv_ch);
      }
    }
  }

  const applied = detail.filter((d) => d.ok).length;
  return {
    ok: detail.every((d) => d.ok),
    dryRun: false,
    detail,
    applied,
    failed: detail.length - applied,
    taken_over: takenOver,
    message: `${applied} de ${detail.length} stream(s) actualizados${takenOver.length ? ` · ${takenOver.length} canal(es) pasados a Flussonic` : ''}.`
  };
}

// ============ MAPEO A MANO Y NOMBRES DE SERVICIO (v2.6.36) =================
// Los streams de Flussonic suelen llamarse a0ek/a0cq (su título es «A&E»,
// «A3 Cine»…) y la lista del operador repite «NACIONAL» en varios canales. Aquí
// el operador elige el stream de cada canal en una lista, y el panel escribe el
// nombre del canal como nombre de servicio del TS para reconocerlo al escanear.

/** Asigna (o quita) el stream de Flussonic de un canal. Un stream, un canal. */
export function setChannelStream({ catvCh, stream = '' } = {}) {
  const ch = Number(catvCh);
  if (!Number.isFinite(ch)) return { ok: false, error: 'Canal inválido.' };
  const slot = db.prepare('SELECT catv_ch, custom_name, flussonic_stream FROM wk2500_channels WHERE catv_ch = ?').get(ch);
  if (!slot) return { ok: false, error: `El canal CH${ch} no existe en el plan.` };
  const name = String(stream || '').trim();

  if (!name) {
    db.prepare("UPDATE wk2500_channels SET flussonic_stream = '', updated_at = datetime('now') WHERE catv_ch = ?").run(ch);
    return { ok: true, catv_ch: ch, stream: '', cleared: true };
  }

  const freed = db
    .prepare('SELECT catv_ch FROM wk2500_channels WHERE flussonic_stream = ? AND catv_ch <> ?')
    .all(name, ch)
    .map((r) => Number(r.catv_ch));
  withTry(() =>
    db
      .prepare("UPDATE wk2500_channels SET flussonic_stream = '', updated_at = datetime('now') WHERE flussonic_stream = ? AND catv_ch <> ?")
      .run(name, ch)
  );
  db.prepare("UPDATE wk2500_channels SET flussonic_stream = ?, updated_at = datetime('now') WHERE catv_ch = ?").run(name, ch);
  return { ok: true, catv_ch: ch, stream: name, freed };
}

function withTry(fn) {
  try {
    fn();
  } catch {
    /* el índice único no es crítico: el aviso va en freed */
  }
}

/**
 * Plan de nombres de servicio: qué se escribiría en Flussonic para que cada
 * canal se identifique al escanear (SDT). Usa el nombre de la portadora.
 */
export async function planServiceNames({ serverId = null, chStart = 2, chEnd = 125 } = {}) {
  const listed = await listFlussonicStreams({ serverId });
  if (!listed.ok) return { ok: false, error: listed.error, rows: [] };
  const byName = new Map((listed.streams || []).map((s) => [s.name, s]));
  const from = Math.max(2, Number(chStart) || 2);
  const to = Math.min(125, Number(chEnd) || 125);
  const slots = db
    .prepare(
      `SELECT catv_ch, custom_name, flussonic_stream, stream_id FROM wk2500_channels
        WHERE catv_ch BETWEEN ? AND ? AND flussonic_stream <> '' ORDER BY catv_ch`
    )
    .all(from, to);

  const rows = slots.map((slot) => {
    const stream = String(slot.flussonic_stream || '').trim();
    const info = byName.get(stream);
    const service = String(slot.custom_name || '').trim() || `CH ${slot.catv_ch}`;
    const current = String(info?.service_name || info?.title || '').trim();
    return {
      catv_ch: Number(slot.catv_ch),
      service_name: service,
      stream,
      stream_title: String(info?.title || ''),
      current_service_name: current,
      exists: Boolean(info),
      ok: Boolean(info),
      error: info ? '' : 'ese stream no existe en Flussonic'
    };
  });
  return {
    ok: true,
    server: listed.server,
    rows,
    total: rows.length,
    pendientes: rows.filter((r) => r.ok && r.current_service_name !== r.service_name).length
  };
}

/** Escribe el nombre de servicio de cada canal en su stream (SDT / título). */
export async function applyServiceNames({ serverId = null, chStart = 2, chEnd = 125, dryRun = true } = {}) {
  const planned = await planServiceNames({ serverId, chStart, chEnd });
  if (!planned.ok) return planned;
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay ningún servidor Flussonic dado de alta.', rows: [] };
  const targets = planned.rows.filter((r) => r.ok && r.current_service_name !== r.service_name);
  if (dryRun) {
    return { ...planned, dryRun: true, detail: targets.map((r) => ({ ...r, action: 'pendiente' })), applied: 0, failed: 0 };
  }
  const detail = [];
  for (const row of targets) {
    const got = await getStreamConfig(srv, row.stream);
    if (got.error) {
      detail.push({ ...row, ok: false, error: got.error });
      continue;
    }
    const wrote = await writeServiceName(srv, row.stream, row.service_name, got.config);
    detail.push({ ...row, ok: wrote.ok, field: wrote.field || '', error: wrote.error || '' });
  }
  const applied = detail.filter((d) => d.ok).length;
  return {
    ok: detail.every((d) => d.ok),
    dryRun: false,
    server: planned.server,
    rows: planned.rows,
    detail,
    applied,
    failed: detail.length - applied,
    message: `${applied} de ${targets.length} stream(s) con el nombre del canal para el escaneo.`
  };
}
