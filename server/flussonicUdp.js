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
  const r = await fetchJsonWithTimeout(`${apiBase(srv)}/streams/${enc}`, { headers: headersFor(srv) }, 8000);
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
