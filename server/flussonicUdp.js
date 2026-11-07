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

function normalizeOutputs(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((o) => (typeof o === 'string' ? { url: o } : o && typeof o === 'object' ? { ...o } : null))
    .filter((o) => o && o.url);
}

/**
 * Formas del cuerpo que entienden las distintas versiones de Flussonic.
 * Se prueban en orden y **cada una se verifica releyendo el stream**: si no
 * deja la salida puesta, no vale y se pasa a la siguiente. La que funciona se
 * recuerda en `settings` para no repetir el tanteo en los 105 canales.
 */
const WRITE_SHAPES = ['outputs', 'iface_field', 'outputs_text', 'push', 'push_text', 'full', 'full_text'];
// Forma especial: reenviar el stream tal como lo da el servidor, recortado a
// las propiedades de su propio esquema. No es un cuerpo fijo: se construye en
// el momento con el GET + el OpenAPI del servidor.
const FULL_SHAPE = 'schema:full';

// Claves del stream que el GET devuelve pero el PUT no acepta (estado/derivadas).
const READ_ONLY_STREAM_KEYS = new Set([
  'stats',
  'effective',
  'named_by',
  'position',
  'sessions',
  'schema',
  '$schema',
  'media_info'
]);

// Campos que el GET devuelve en cada salida pero que no son configuración.
const OUTPUT_RUNTIME_KEYS = new Set([
  'url',
  'stats',
  'state',
  'status',
  'running',
  'bytes',
  'started_at',
  'opened_at',
  'bitrate_kbps',
  'error',
  'clients',
  'sessions'
]);

/**
 * Cómo guarda ESTE servidor una salida UDP. Se mira una que ya tenga el stream:
 *  · si la interfaz va dentro de la URL (`udp://ens37@239.1.1.2:1002`), se
 *    escribe igual;
 *  · si va en un campo aparte (`"interface": "ens37"`), se escribe así;
 *  · si añade `type`, `ttl`, `bitrate`… se copian tal cual.
 * No se inventa nada: se imita lo que el propio servidor publica.
 */
function outputStyle(config) {
  const list = normalizeOutputs(config?.outputs);
  const sample = list.find((o) => isUdpPush(o.url)) || null;
  const extra = {};
  let ifaceField = false;
  if (sample) {
    for (const [k, v] of Object.entries(sample)) {
      if (OUTPUT_RUNTIME_KEYS.has(k)) continue;
      extra[k] = v;
    }
    ifaceField = typeof sample.interface === 'string' && sample.interface.length > 0;
  }
  return { sample, ifaceField, extra };
}

/** Una entrada de `outputs`, con la forma que usa el servidor. */
function outputEntry(url, style) {
  const parsed = parsePushUrl(url);
  const entry = { ...(style?.extra || {}) };
  delete entry.url;
  if (style?.ifaceField && parsed) {
    entry.url = formatPushUrl({ ...parsed, iface: '' });
    entry.interface = parsed.iface || entry.interface || '';
    return entry;
  }
  entry.url = url;
  if (style?.ifaceField === false && parsed && parsed.iface) {
    // La interfaz viaja dentro de la URL; no se duplica en otro campo.
    delete entry.interface;
  }
  return entry;
}

function outputsValue(urls, asText, style) {
  return asText ? [...urls] : urls.map((u) => outputEntry(u, style));
}

/** Config completa y «limpia» (sin estado), por si la versión exige el stream entero. */
function fullStreamPayload(config, streamName, urls, asText) {
  const src = config && typeof config === 'object' ? config : {};
  const payload = {};
  for (const [k, v] of Object.entries(src)) {
    if (READ_ONLY_STREAM_KEYS.has(k) || String(k).startsWith('$')) continue;
    if (k === 'inputs' || k === 'outputs' || k === 'push') continue;
    payload[k] = v;
  }
  const inputs = (Array.isArray(src.inputs) ? src.inputs : [])
    .map((i) => (typeof i === 'string' ? { url: i } : i && i.url ? { url: i.url } : null))
    .filter((i) => i && i.url);
  if (inputs.length) payload.inputs = inputs;
  payload.name = src.name || streamName;
  payload.outputs = outputsValue(urls, asText, outputStyle(src));
  return payload;
}

/**
 * Cuerpo «tal cual lo da el servidor»: se reenvía el propio stream recortado a
 * las propiedades que su esquema admite y con la salida puesta. Es la última
 * baza cuando el servidor rechaza cualquier cuerpo parcial (400 al analizar
 * parámetros): no se inventa nada, se devuelve lo que él mismo publicó.
 */
function schemaFullPayload(meta, config, streamName, urls) {
  const src = config && typeof config === 'object' ? config : {};
  const allowed = new Set(Array.isArray(meta?.properties) ? meta.properties : []);
  const payload = {};
  for (const [k, v] of Object.entries(src)) {
    if (READ_ONLY_STREAM_KEYS.has(k) || String(k).startsWith('$')) continue;
    if (allowed.size && !allowed.has(k)) continue;
    if (k === 'inputs' || k === 'outputs' || k === 'push') continue;
    payload[k] = v;
  }
  if (!allowed.size || allowed.has('inputs')) {
    const inputs = (Array.isArray(src.inputs) ? src.inputs : [])
      .map((i) => (typeof i === 'string' ? { url: i } : i && i.url ? { url: i.url } : null))
      .filter((i) => i && i.url);
    if (inputs.length) payload.inputs = inputs;
  }
  if (!allowed.size || allowed.has('name')) payload.name = src.name || streamName;
  payload[meta?.key || 'outputs'] = outputsValue(urls, Boolean(meta?.asText), outputStyle(src));
  return payload;
}

function shapeBody(shape, urls, config, streamName) {
  const style = outputStyle(config);
  if (String(shape).startsWith('schema:')) {
    // Forma descubierta en el /schema del propio servidor: schema:<clave>:obj|text
    const [, key, kind] = String(shape).split(':');
    return { [key || 'outputs']: outputsValue(urls, kind === 'text', style) };
  }
  switch (shape) {
    case 'outputs':
      return { outputs: outputsValue(urls, false, style) };
    case 'iface_field': {
      // udp://IP:PUERTO + "interface": "ens37" (interfaz en un campo aparte)
      return {
        outputs: urls.map((u) => {
          const p = parsePushUrl(u);
          return p && p.iface ? { url: formatPushUrl({ ...p, iface: '' }), interface: p.iface } : { url: u };
        })
      };
    }
    case 'outputs_text':
      return { outputs: outputsValue(urls, true, style) };
    case 'push':
      return { push: outputsValue(urls, false, style) };
    case 'push_text':
      return { push: outputsValue(urls, true, style) };
    case 'full':
      return fullStreamPayload(config, streamName, urls, false);
    case 'full_text':
      return fullStreamPayload(config, streamName, urls, true);
    default:
      return { outputs: outputsValue(urls, false) };
  }
}

/**
 * Lee el OpenAPI del propio servidor (`/streamer/api/v3/schema`) y averigua
 * cómo se llama la lista de salidas y si sus elementos son objetos o texto.
 * Es lo que hace que el panel funcione con cualquier versión de Flussonic sin
 * adivinar: 23.12 y otras usan nombres distintos (`outputs`, `push`…).
 */
function resolveSchemaRef(doc, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (!node.$ref) return node;
  const path = String(node.$ref).replace(/^#\//, '').split('/');
  let cur = doc;
  for (const p of path) cur = cur?.[p];
  return resolveSchemaRef(doc, cur, depth + 1);
}

function schemaArrayProp(doc, schema) {
  const props = schema && typeof schema === 'object' ? schema.properties || {} : {};
  const names = Object.keys(props);
  const wanted = names.find((n) => /^(outputs?|push(es)?|udp(2)?)$/i.test(n) && isArraySchema(resolveSchemaRef(doc, props[n])));
  return wanted || '';
}

function isArraySchema(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'array') return true;
  if (Array.isArray(node.oneOf)) return node.oneOf.some((o) => isArraySchema(o));
  if (Array.isArray(node.anyOf)) return node.anyOf.some((o) => isArraySchema(o));
  if (Array.isArray(node.allOf)) return node.allOf.some((o) => isArraySchema(o));
  return false;
}

function arrayItems(doc, node) {
  const n = resolveSchemaRef(doc, node);
  if (Array.isArray(n?.oneOf)) return arrayItems(doc, n.oneOf[0]);
  if (Array.isArray(n?.anyOf)) return arrayItems(doc, n.anyOf[0]);
  if (Array.isArray(n?.allOf)) return arrayItems(doc, n.allOf[0]);
  return resolveSchemaRef(doc, n?.items || null);
}

export async function discoverStreamWriteShape(srv) {
  try {
    const r = await fetchJsonWithTimeout(`${apiBase(srv)}/schema`, { headers: headersFor(srv) }, 20000);
    if (!r.ok) return { ok: false, error: `El servidor no da /streamer/api/v3/schema (HTTP ${r.status}).` };
    const doc = r.json || {};
    const version = String(doc?.info?.version || '');
    const paths = doc.paths || {};
    const pathKey =
      Object.keys(paths).find((p) => /\^?\/streams\/\{[a-z_]+\}$/i.test(p)) ||
      Object.keys(paths).find((p) => /\/streams\//.test(p) && (paths[p].put || paths[p].patch));
    const op = pathKey ? paths[pathKey].put || paths[pathKey].patch : null;
    const bodySchema = resolveSchemaRef(
      doc,
      op?.requestBody?.content?.['application/json']?.schema || op?.requestBody?.content?.['application/json; charset=utf-8']?.schema
    );
    const key = schemaArrayProp(doc, bodySchema);
    if (!key) {
      return {
        ok: false,
        version,
        properties: Object.keys(bodySchema?.properties || {}).sort(),
        error: `No encuentro la lista de salidas en el esquema (${pathKey || 'sin ruta'}).`
      };
    }
    const items = arrayItems(doc, bodySchema.properties[key]);
    const asText = String(items?.type || '') === 'string';
    return {
      ok: true,
      version,
      key,
      asText,
      shape: `schema:${key}:${asText ? 'text' : 'obj'}`,
      properties: Object.keys(bodySchema?.properties || {}).sort()
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 160) };
  }
}

const WRITE_SHAPE_KEY = 'flussonic_write_shape';
const SCHEMA_HINT_KEY = 'flussonic_schema_shape';

function getSetting(key) {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '');
  } catch {
    return '';
  }
}

function setSetting(key, value) {
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      value
    );
  } catch {
    /* no es crítico */
  }
}

export function forgetWriteShape() {
  setSetting(WRITE_SHAPE_KEY, '');
  setSetting(SCHEMA_HINT_KEY, '');
}



export function getWriteShape() {
  try {
    const v = String(db.prepare('SELECT value FROM settings WHERE key = ?').get(WRITE_SHAPE_KEY)?.value || '');
    return WRITE_SHAPES.includes(v) || v === FULL_SHAPE ? v : '';
  } catch {
    return '';
  }
}

function rememberWriteShape(shape) {
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(WRITE_SHAPE_KEY, shape);
  } catch {
    /* el acierto no es crítico */
  }
}

/**
 * Configuración global del servidor. Sirve para explicar el 400 típico de los
 * Flussonic con `config_external`: con eso activo, la API rechaza CUALQUIER
 * cambio en un stream (los define el backend externo).
 */
async function readServerConfig(srv) {
  try {
    const r = await fetchJsonWithTimeout(`${apiBase(srv)}/config`, { headers: headersFor(srv) }, 8000);
    return r.ok ? r.json || {} : null;
  } catch {
    return null;
  }
}

function rawDetail(resp, max = 160) {
  const raw = String(resp?.text || resp?.json?.error || '').replace(/\s+/g, ' ').trim();
  return raw.length > max ? raw.slice(0, max) + '…' : raw;
}

function outputsHint(resp, config) {
  const raw = String(resp?.text || resp?.json?.error || '');
  const status = Number(resp?.status) || 0;
  if (status === 409) return 'El nombre de stream ya está en uso (HTTP 409).';
  if (status === 401 || status === 403) {
    return 'Flussonic rechazó las credenciales (revisa usuario/clave o api_token).';
  }
  if (config && config.__note) return String(config.__note);
  return raw ? '' : '';
}

/**
 * Escribe la lista de salidas del stream probando las formas conocidas.
 * En 23.12 lo normal es `{"outputs":[...]}` por **PUT**; hay instalaciones que
 * sólo aceptan `push`, o que exigen el stream entero. Nunca se manda `inputs`
 * con sus campos de estado (el GET los devuelve y el servidor los rechaza con
 * 400 «parsing_parameters»).
 */
async function putOutputs(srv, streamName, outputs, config) {
  const enc = String(streamName).split('/').map(encodeURIComponent).join('/');
  const url = `${apiBase(srv)}/streams/${enc}`;
  const headers = headersFor(srv);
  const urls = outputs.map((o) => o.url).filter(Boolean);

  const learned = getWriteShape();
  const schemaHint = getSetting(SCHEMA_HINT_KEY);
  const order = [];
  if (learned) order.push(learned);
  if (schemaHint && !order.includes(schemaHint)) order.push(schemaHint);
  if (!order.length && schemaHint !== 'none') {
    // Primera escritura: se pregunta al propio servidor cómo se llama el campo.
    const found = await discoverStreamWriteShape(srv);
    if (found.ok) {
      setSetting(SCHEMA_HINT_KEY, found.shape);
      order.push(found.shape);
    } else {
      // Se recuerda el fallo para no pedir el esquema en cada canal.
      setSetting(SCHEMA_HINT_KEY, 'none');
    }
  }
  for (const shape of WRITE_SHAPES) if (!order.includes(shape)) order.push(shape);
  if (!order.includes(FULL_SHAPE)) order.push(FULL_SHAPE);
  const attempts = [];
  for (const shape of order) {
    let body = '';
    if (shape === FULL_SHAPE) {
      const meta = await discoverStreamWriteShape(srv);
      if (!meta.ok || !Array.isArray(meta.properties) || !meta.properties.length) continue;
      body = JSON.stringify(schemaFullPayload(meta, config, streamName, urls));
    } else {
      body = JSON.stringify(shapeBody(shape, urls, config, streamName));
    }
    const put = await fetchJsonWithTimeout(url, { method: 'PUT', headers, body }, 8000);
    const detail = rawDetail(put);
    attempts.push({ shape, status: Number(put.status) || 0, detail });
    if (put.ok) {
      const done = await finishWrite(srv, streamName, outputs, 'PUT', put.status, shape);
      if (done.ok) {
        rememberWriteShape(shape);
        return done;
      }
      // Aceptó el cuerpo pero no guardó nada: se sigue probando.
      attempts[attempts.length - 1].detail = 'no quedó guardada';
      continue;
    }
    // 401/403/404 no se arreglan cambiando el cuerpo.
    if ([401, 403, 404].includes(Number(put.status))) break;
  }

  // Último recurso: PATCH con la forma más habitual (proxies que sólo dejan PATCH).
  const patchBody = JSON.stringify(shapeBody('outputs', urls, config, streamName));
  const patch = await fetchJsonWithTimeout(url, { method: 'PATCH', headers, body: patchBody }, 8000);
  attempts.push({ shape: 'patch', status: Number(patch.status) || 0, detail: rawDetail(patch) });
  if (patch.ok) {
    const done = await finishWrite(srv, streamName, outputs, 'PATCH', patch.status, 'outputs');
    if (done.ok) {
      rememberWriteShape('outputs');
      return done;
    }
  }

  // Si todo falló, una causa muy habitual: el servidor usa config_external y
  // la API rechaza cualquier cambio de stream, sea cual sea el cuerpo.
  let external = '';
  try {
    const global = await readServerConfig(srv);
    external = String(global?.config_external || '').trim();
  } catch {
    /* sin dato */
  }

  const last = attempts[attempts.length - 1] || {};
  const shown = attempts
    .slice(0, 3)
    .map((a) => `${a.shape}→${a.status}${a.detail ? ` ${String(a.detail).slice(0, 90)}` : ''}`);
  if (attempts.length > 3) shown.push(`… (+${attempts.length - 3})`);
  const tried = shown.join(' | ');
  const all2xx = attempts.length > 0 && attempts.every((a) => a.status >= 200 && a.status < 300);
  const hint = outputsHint({ status: last.status, text: last.detail }, config);
  const head = all2xx
    ? `Flussonic respondió ${last.status} pero la salida no quedó guardada`
    : `Flussonic no aceptó la salida UDP (HTTP ${last.status || 0})`;
  return {
    ok: false,
    attempts,
    error:
      (external
        ? `Este Flussonic tiene config_external (${external}): los streams los define un backend externo y la ` +
          'API rechaza los cambios. Edita la salida UDP allí, o quita config_external para que el panel pueda escribir. '
        : '') +
      `${head}${hint ? `: ${hint}` : ''}. Probado: ${tried}` +
      ' — ejecuta `tvlister-admin catv flussonic probe <stream>` para ver la respuesta exacta.'
  };
}

/**
 * Diagnóstico: prueba cada forma de cuerpo contra el Flussonic real y devuelve
 * la respuesta exacta de cada intento. Al final deja el stream como estaba.
 * Uso:  tvlister-admin catv flussonic probe <stream> [--url udp://...]
 */
export async function probeStreamWrite({ serverId = null, streamName, url = '' } = {}) {
  const srv = getFlussonicServer(serverId);
  if (!srv) return { ok: false, error: 'No hay servidor Flussonic configurado.' };
  const name = String(streamName || '').trim();
  if (!name) return { ok: false, error: 'Falta el nombre del stream de Flussonic.' };
  const got = await getStreamConfig(srv, name);
  if (got.error) return { ok: false, error: got.error };
  const cfg = got.config || {};
  const before = normalizeOutputs(cfg.outputs).map((o) => o.url);
  const testUrl = String(url || '').trim() || before[0] || '';
  if (!testUrl) {
    return {
      ok: false,
      error: 'El stream no tiene salidas: indica la URL a probar con --url udp://ens37@239.1.1.2:1002'
    };
  }
  const enc = String(name).split('/').map(encodeURIComponent).join('/');
  const apiUrl = `${apiBase(srv)}/streams/${enc}`;
  const headers = headersFor(srv);

  const report = {
    ok: true,
    server: srv.name,
    api: apiBase(srv),
    stream: name,
    stream_keys: Object.keys(cfg).sort(),
    static: cfg.static === true,
    named_by: cfg.named_by || '',
    inputs: (Array.isArray(cfg.inputs) ? cfg.inputs : [])
      .map((i) => (typeof i === 'string' ? i : i && i.url ? i.url : ''))
      .filter(Boolean),
    outputs_before: before,
    // Cómo los publica el servidor, tal cual: de aquí sale la forma de escribir.
    outputs_raw: (Array.isArray(cfg.outputs) ? cfg.outputs : []).map((o) =>
      typeof o === 'string' ? o : JSON.parse(JSON.stringify(o))
    ),
    inputs_raw: (Array.isArray(cfg.inputs) ? cfg.inputs : []).map((i) =>
      typeof i === 'string' ? i : JSON.parse(JSON.stringify(i))
    ),
    test_url: testUrl,
    test_url_already: before.some((u) => outputTargetKey(u) === outputTargetKey(testUrl)),
    config_external: '',
    attempts: []
  };
  try {
    const global = await readServerConfig(srv);
    report.config_external = String(global?.config_external || '').trim();
  } catch {
    /* sin dato */
  }
  // Cómo guarda el servidor sus propias salidas (interfaz aparte o dentro).
  try {
    const st = outputStyle(cfg);
    report.style = {
      iface_field: st.ifaceField,
      extra_keys: Object.keys(st.extra).filter((k) => k !== 'interface').sort(),
      sample: st.sample ? JSON.parse(JSON.stringify(st.sample)) : null
    };
  } catch {
    report.style = { iface_field: false, extra_keys: [], sample: null };
  }
  // Qué dice el OpenAPI del propio servidor sobre el campo de salidas.
  try {
    const disc = await discoverStreamWriteShape(srv);
    report.schema = {
      ok: Boolean(disc.ok),
      version: disc.version || '',
      key: disc.key || '',
      as_text: Boolean(disc.asText),
      shape: disc.shape || '',
      properties: disc.properties || [],
      error: disc.error || ''
    };
  } catch (err) {
    report.schema = { ok: false, error: String(err?.message || err).slice(0, 160) };
  }

  const probeShapes = [...WRITE_SHAPES, FULL_SHAPE].filter(
    (sh) => sh !== 'iface_field' || Boolean(parsePushUrl(testUrl)?.iface)
  );
  for (const shape of probeShapes) {
    let body = '';
    if (shape === FULL_SHAPE) {
      const meta = report.schema || {};
      if (!meta.ok || !Array.isArray(meta.properties) || !meta.properties.length) continue;
      body = JSON.stringify(
        schemaFullPayload({ key: meta.key, asText: meta.as_text, properties: meta.properties }, cfg, name, [testUrl])
      );
    } else {
      body = JSON.stringify(shapeBody(shape, [testUrl], cfg, name));
    }
    const put = await fetchJsonWithTimeout(apiUrl, { method: 'PUT', headers, body }, 8000);
    const after = await readOutputs(srv, name);
    // Ojo: si el stream YA tenía esa salida, «sigue estando» no prueba nada.
    // La forma sólo vale si el servidor la aceptó (2xx) y además quedó puesta.
    const saved = Array.isArray(after) && after.some((u) => outputTargetKey(u) === outputTargetKey(testUrl));
    report.attempts.push({
      shape,
      status: Number(put.status) || 0,
      accepted: Boolean(put.ok),
      raw: rawDetail(put, 220),
      body: body.slice(0, 260),
      saved
    });
    if (put.ok && saved) {
      report.winner = shape;
      break;
    }
  }

  // Diagnóstico extra: la misma salida SIN la interfaz (udp://IP:PUERTO).
  // Si sólo funciona así, el problema es el prefijo «eth@» en la URL.
  if (!report.winner) {
    const bare = String(testUrl).replace(/^(udp|rtp):\/\/[^@/]+@/i, '$1://');
    if (bare !== testUrl) {
      const body = JSON.stringify({ outputs: [{ url: bare }] });
      const put = await fetchJsonWithTimeout(apiUrl, { method: 'PUT', headers, body }, 8000);
      const after = await readOutputs(srv, name);
      const saved = Array.isArray(after) && after.some((u) => outputTargetKey(u) === outputTargetKey(bare));
      report.attempts.push({
        shape: 'outputs_sin_iface',
        status: Number(put.status) || 0,
        accepted: Boolean(put.ok),
        raw: rawDetail(put, 220),
        body: body.slice(0, 260),
        saved,
        diagnostic: true
      });
      if (put.ok && saved) report.winner = 'outputs_sin_iface';
    }
  }

  // Dejar el stream como estaba (si algo se llegó a escribir).
  report.restored = true;
  const now = await readOutputs(srv, name);
  if (Array.isArray(now) && JSON.stringify(now) !== JSON.stringify(before)) {
    report.restored = false;
    for (const shape of [report.winner || 'outputs', 'outputs', 'outputs_text']) {
      const body = JSON.stringify(shapeBody(shape, before, cfg, name));
      const put = await fetchJsonWithTimeout(apiUrl, { method: 'PUT', headers, body }, 8000);
      if (!put.ok) continue;
      const after = await readOutputs(srv, name);
      if (Array.isArray(after) && JSON.stringify(after) === JSON.stringify(before)) {
        report.restored = true;
        break;
      }
    }
  }
  return report;
}

/** Un 200 no basta: se relee el stream y se comprueba que la salida quedó. */
async function finishWrite(srv, streamName, outputs, method, status, shape = '') {
  const check = await verifyOutputs(srv, streamName, outputs);
  if (check.ok) return { ok: true, method, shape, verified: true };
  return {
    ok: false,
    error:
      `Flussonic respondió ${method} ${status || 200} pero la salida no quedó guardada` +
      ` (tiene: ${check.outputs.length ? check.outputs.join(', ') : 'ninguna'}).`
  };
}

/** Lee las salidas actuales del stream (urls). Devuelve null si no se pudo. */
async function readOutputs(srv, streamName) {
  const got = await getStreamConfig(srv, streamName);
  if (got.error) return null;
  return normalizeOutputs(got.config?.outputs).map((o) => o.url);
}

/**
 * Comprueba leyendo el stream que la salida quedó puesta de verdad. Un 200 de
 * Flussonic no basta: si el cuerpo no le gustó, no cambia nada.
 */
async function verifyOutputs(srv, streamName, wanted) {
  const want = new Set(wanted.map((o) => outputTargetKey(o.url)).filter(Boolean));
  let have = [];
  for (let i = 0; i < 3; i += 1) {
    const got = await readOutputs(srv, streamName);
    if (got) {
      have = got;
      const keys = new Set(got.map(outputTargetKey).filter(Boolean));
      if (keys.size === want.size && [...want].every((k) => keys.has(k))) return { ok: true, outputs: got };
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, outputs: have };
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

