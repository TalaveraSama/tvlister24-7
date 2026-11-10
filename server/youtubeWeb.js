/**
 * Leer YouTube **sin yt-dlp**.
 *
 * yt-dlp es el camino bueno (sabe de todo: clientes, PO token, listas
 * infinitas), pero cuando YouTube le pone el anti-robots a la IP del servidor
 * no hay binario que lo arregle: el panel se quedaba sin poder ni leer un
 * título. Estas son las otras dos vías, las que usa cualquier web que muestra
 * YouTube:
 *
 *   1. **YouTube Data API v3** (`youtube_api_key`): la vía oficial y estable.
 *      Devuelve títulos, duración y si hay directo, sin anti-robots y sin
 *      cookies. Cuota gratuita de 10.000 unidades/día: leer una lista de 843
 *      vídeos cuesta ~35. NO da la URL del vídeo (Google no la publica).
 *
 *   2. **La página pública** (`youtube.com/playlist`, `youtube.com/watch`): el
 *      HTML trae `ytInitialData` (la lista) y `ytInitialPlayerResponse` (las
 *      pistas: `hlsManifestUrl` en directos y `streamingData.formats` en
 *      vídeos). Se piden con el User-Agent de un navegador y, si hay, con las
 *      cookies de la sesión: es la misma petición que hace el navegador del
 *      operador, no una evasión.
 *
 * Nada de esto descarga ni recodifica: sólo lee lo que YouTube publica.
 */
import fs from 'fs';

const WEB_BASE = String(process.env.TVLISTER_YT_WEB_BASE || 'https://www.youtube.com').replace(/\/+$/, '');
const API_BASE = String(process.env.TVLISTER_YT_API_BASE || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '');

export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

/**
 * Cabecera `Cookie:` con sólo lo de YouTube/Google a partir de un cookies.txt
 * Netscape. Mandar las 1.623 cookies de 353 dominios a youtube.com sería
 * absurdo (y filtraría media sesión del operador a terceros).
 */
export function cookieHeaderFromText(raw = '', { now = Date.now() } = {}) {
  const out = [];
  const seen = new Set();
  for (const lineRaw of String(raw || '').split(/\r?\n/)) {
    const line = lineRaw.startsWith('#HttpOnly_') ? lineRaw.slice('#HttpOnly_'.length) : lineRaw;
    if (!line.trim() || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    const domain = String(p[0] || '').replace(/^\./, '').toLowerCase();
    if (!/(^|\.)youtube\.com$/.test(domain) && !/(^|\.)google\.com$/.test(domain)) continue;
    const expires = Number(p[4]) || 0;
    if (expires && expires * 1000 < now) continue;
    const name = String(p[5] || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // El valor puede traer comillas o saltos: se limpia para no romper la cabecera.
    out.push(`${name}=${String(p[6] || '').trim().replace(/[\r\n]/g, '')}`);
  }
  return out.join('; ');
}

/** Cabecera `Cookie:` de un archivo (si existe). Nunca lanza. */
export function cookieHeaderFromFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return '';
    return cookieHeaderFromText(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

async function fetchText(url, { cookies = '', timeoutMs = 20000, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, Number(timeoutMs) || 20000));
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': WEB_USER_AGENT,
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(cookies ? { Cookie: cookies } : {}),
        ...headers
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, url: res.url || url };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err?.name === 'AbortError' ? 'sin respuesta (tiempo agotado)' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Saca el objeto JSON que empieza en `start` contando llaves (y respetando las
 * cadenas, con sus escapes). Los `ytInitialData` de YouTube llevan dentro
 * cosas como «}» en un título: cortar por la primera llave no vale.
 */
export function jsonAt(text, start) {
  const i = text.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = i; k < text.length; k += 1) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, k + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** `ytInitialData` de una página de YouTube (lista, canal, resultados). */
export function parseInitialData(html) {
  const s = String(html || '');
  for (const marker of ['var ytInitialData =', 'ytInitialData"]] =', 'window["ytInitialData"] =', 'ytInitialData =']) {
    const at = s.indexOf(marker);
    if (at >= 0) {
      const obj = jsonAt(s, at + marker.length);
      if (obj) return obj;
    }
  }
  return null;
}

/** `ytInitialPlayerResponse` de una página de vídeo/directo. */
export function parsePlayerResponse(html) {
  const s = String(html || '');
  for (const marker of ['var ytInitialPlayerResponse =', 'ytInitialPlayerResponse =', '"ytInitialPlayerResponse":']) {
    const at = s.indexOf(marker);
    if (at >= 0) {
      const obj = jsonAt(s, at + marker.length);
      if (obj) return obj;
    }
  }
  return null;
}

/** «2:15» / «1:02:03» → segundos. */
export function clockToSec(text) {
  const parts = String(text || '')
    .trim()
    .split(':')
    .map((n) => Number(n) || 0);
  if (!parts.length) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** «PT1H2M3S» (ISO 8601 de la Data API) → segundos. */
export function isoDurationToSec(text) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(text || '').trim());
  if (!m) return 0;
  const [, d, h, mi, s] = m;
  return (Number(d) || 0) * 86400 + (Number(h) || 0) * 3600 + (Number(mi) || 0) * 60 + (Number(s) || 0);
}

/** Recorre el árbol y devuelve los objetos que tengan la clave pedida. */
function collect(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out, depth + 1);
    return out;
  }
  if (node[key] && typeof node[key] === 'object') out.push(node[key]);
  for (const v of Object.values(node)) collect(v, key, out, depth + 1);
  return out;
}

const textOf = (node) => {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) return node.runs.map((r) => r?.text || '').join('');
  return '';
};

/**
 * Lista de una página pública (`ytInitialData`): título, autor y las entradas
 * con id, título y duración. Marca los directos (`isLive`) para poder omitirlos
 * como ya hace el camino de yt-dlp.
 */
export function parsePlaylistData(data, { limit = 30 } = {}) {
  const out = { title: '', uploader: '', total: 0, entries: [], error: '' };
  if (!data) {
    out.error = 'la página no trae datos de la lista';
    return out;
  }
  const meta = data?.metadata?.playlistMetadataRenderer;
  const header = collect(data, 'playlistHeaderRenderer')[0];
  const sidebar = collect(data, 'playlistSidebarPrimaryInfoRenderer')[0];
  out.title = String(meta?.title || textOf(header?.title) || '').trim();
  const owner = collect(data, 'playlistSidebarSecondaryInfoRenderer')[0];
  out.uploader = String(
    textOf(owner?.videoOwner?.videoOwnerRenderer?.title) || textOf(header?.ownerText) || ''
  ).trim();
  // «843 videos» en las estadísticas del panel lateral.
  const stats = Array.isArray(sidebar?.stats) ? sidebar.stats.map((s) => textOf(s)) : [];
  for (const st of stats) {
    const m = /([\d.,]+)\s*(?:videos?|vídeos?)/i.exec(st);
    if (m) out.total = Number(m[1].replace(/[.,]/g, '')) || 0;
  }

  const seen = new Set();
  for (const v of collect(data, 'playlistVideoRenderer')) {
    const id = String(v.videoId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const thumb = Array.isArray(v.thumbnailOverlays) ? v.thumbnailOverlays : [];
    const isLive = thumb.some((t) => {
      const r = t?.thumbnailOverlayTimeStatusRenderer;
      return r && (String(r.style || '').toUpperCase() === 'LIVE' || /^(en vivo|live)$/i.test(textOf(r.text).trim()));
    });
    out.entries.push({
      id,
      title: textOf(v.title) || `Vídeo ${out.entries.length + 1}`,
      duration_sec: clockToSec(textOf(v.lengthText)),
      isLive,
      author: textOf(v.shortBylineText)
    });
    if (out.entries.length >= limit) break;
  }
  if (!out.entries.length) {
    out.error = /no longer available|ya no está disponible/i.test(JSON.stringify(data))
      ? 'la lista es privada o ya no existe'
      : 'la página no trae ningún vídeo de la lista';
  }
  return out;
}

const codecOf = (mime) => {
  const m = /codecs="([^"]+)"/.exec(String(mime || ''));
  return m ? m[1] : '';
};

/**
 * Pistas de un `ytInitialPlayerResponse`: el manifiesto HLS de un directo
 * (`hlsManifestUrl`), o los formatos del vídeo (progresivo con imagen y sonido,
 * o DASH con las dos pistas separadas).
 */
export function parsePlayerMedia(pr) {
  const status = String(pr?.playabilityStatus?.status || '');
  const reason = String(pr?.playabilityStatus?.reason || '');
  const details = pr?.videoDetails || {};
  const out = {
    status,
    reason,
    title: String(details.title || ''),
    uploader: String(details.author || ''),
    duration_sec: Math.round(Number(details.lengthSeconds) || 0),
    isLive: details.isLive === true || Boolean(pr?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow),
    hls_url: String(pr?.streamingData?.hlsManifestUrl || ''),
    formats: []
  };
  const list = [
    ...(Array.isArray(pr?.streamingData?.formats) ? pr.streamingData.formats.map((f) => ({ ...f, progressive: true })) : []),
    ...(Array.isArray(pr?.streamingData?.adaptiveFormats) ? pr.streamingData.adaptiveFormats : [])
  ];
  for (const f of list) {
    const url = String(f.url || '');
    if (!/^https?:/i.test(url)) continue;
    const mime = String(f.mimeType || '');
    const vcodec = /^video\//i.test(mime) ? codecOf(mime) : '';
    const acodec = /^audio\//i.test(mime) ? codecOf(mime) : f.progressive ? codecOf(mime) : '';
    out.formats.push({
      url,
      vcodec,
      acodec,
      width: Number(f.width) || 0,
      height: Number(f.height) || 0,
      ext: /video\/mp4|audio\/mp4/i.test(mime) ? 'mp4' : /webm/i.test(mime) ? 'webm' : '',
      bitrate: Number(f.bitrate) || 0,
      progressive: Boolean(f.progressive),
      quality: String(f.qualityLabel || f.audioQuality || '')
    });
  }
  return out;
}

/** Lee la lista desde la Data API v3 (necesita clave). */
export async function apiPlaylist(listId, { key, limit = 30, timeoutMs = 20000 } = {}) {
  const out = { ok: false, via: 'api', title: '', uploader: '', total: 0, entries: [], error: '' };
  if (!key) {
    out.error = 'sin clave de YouTube Data API';
    return out;
  }
  const ids = [];
  let pageToken = '';
  // 50 por página: 1 unidad de cuota por página.
  while (ids.length < limit) {
    const u = new URL(`${API_BASE}/playlistItems`);
    u.searchParams.set('part', 'contentDetails');
    u.searchParams.set('playlistId', listId);
    u.searchParams.set('maxResults', '50');
    u.searchParams.set('key', key);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchText(u.toString(), { timeoutMs, headers: { Accept: 'application/json' } });
    if (!r.ok) {
      out.error = r.status === 403 ? 'la clave no vale o la cuota diaria está agotada' : r.error || `HTTP ${r.status}`;
      return out;
    }
    let json = null;
    try {
      json = JSON.parse(r.text);
    } catch {
      out.error = 'respuesta no válida de la Data API';
      return out;
    }
    if (json?.error) {
      out.error = String(json.error.message || 'error de la Data API');
      return out;
    }
    for (const it of json?.items || []) {
      const id = String(it?.contentDetails?.videoId || '');
      if (id) ids.push(id);
      if (ids.length >= limit) break;
    }
    pageToken = String(json?.nextPageToken || '');
    if (!pageToken) break;
  }
  // Ficha y duración de esos vídeos: 50 por llamada (1 unidad).
  const details = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const u = new URL(`${API_BASE}/videos`);
    u.searchParams.set('part', 'snippet,contentDetails,liveStreamingDetails');
    u.searchParams.set('id', chunk.join(','));
    u.searchParams.set('key', key);
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchText(u.toString(), { timeoutMs, headers: { Accept: 'application/json' } });
    if (!r.ok) continue;
    try {
      const json = JSON.parse(r.text);
      for (const v of json?.items || []) {
        details.set(String(v.id), {
          title: String(v?.snippet?.title || ''),
          author: String(v?.snippet?.channelTitle || ''),
          duration_sec: isoDurationToSec(v?.contentDetails?.duration),
          isLive: Boolean(v?.liveStreamingDetails?.actualStartTime && !v?.liveStreamingDetails?.actualEndTime)
        });
      }
    } catch {
      /* sin ficha: se queda el id */
    }
  }
  out.entries = ids.map((id, i) => ({
    id,
    title: details.get(id)?.title || `Vídeo ${i + 1}`,
    duration_sec: details.get(id)?.duration_sec || 0,
    isLive: Boolean(details.get(id)?.isLive),
    author: details.get(id)?.author || ''
  }));
  // Título y autor de la LISTA (no del primer vídeo): 1 unidad de cuota.
  try {
    const u = new URL(`${API_BASE}/playlists`);
    u.searchParams.set('part', 'snippet');
    u.searchParams.set('id', listId);
    u.searchParams.set('key', key);
    const r = await fetchText(u.toString(), { timeoutMs, headers: { Accept: 'application/json' } });
    if (r.ok) {
      const pl = JSON.parse(r.text)?.items?.[0]?.snippet || {};
      out.title = String(pl.title || '');
      out.uploader = String(pl.channelTitle || '');
    }
  } catch {
    /* sin título: se usa el de la lista o el genérico */
  }
  out.total = ids.length;
  out.ok = out.entries.length > 0;
  if (!out.ok && !out.error) out.error = 'la lista está vacía o es privada';
  return out;
}

/** Lee la lista de la página pública (sin clave). */
export async function webPlaylist(listId, { limit = 30, cookies = '', timeoutMs = 20000 } = {}) {
  const out = { ok: false, via: 'html', title: '', uploader: '', total: 0, entries: [], error: '' };
  const r = await fetchText(`${WEB_BASE}/playlist?list=${encodeURIComponent(listId)}&hl=es`, { cookies, timeoutMs });
  if (!r.ok) {
    out.error = r.error || `HTTP ${r.status}`;
    return out;
  }
  const data = parseInitialData(r.text);
  const parsed = parsePlaylistData(data, { limit });
  Object.assign(out, parsed, { ok: parsed.entries.length > 0 });
  return out;
}

/**
 * Pistas de un vídeo/directo desde su página pública. Acepta un id o la URL
 * completa (`/@canal/live` también vale: YouTube redirige a su directo).
 */
export async function webPlayer(target, { cookies = '', timeoutMs = 20000 } = {}) {
  const raw = String(target || '').trim();
  // Un id de YouTube es una cadena «plana» (11 caracteres, pero no se exige el
  // largo: así vale también lo que devuelve la Data API en las pruebas). Si
  // viene una URL, se saca el `v=`.
  const isId = Boolean(raw) && !/^https?:\/\//i.test(raw) && !/[\/?#=&]/.test(raw);
  const url = isId
    ? `${WEB_BASE}/watch?v=${encodeURIComponent(raw)}&hl=es`
    : `${WEB_BASE}/watch?v=${encodeURIComponent(extractVideoId(raw))}&hl=es`;
  const r = await fetchText(url, { cookies, timeoutMs });
  if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
  const pr = parsePlayerResponse(r.text);
  if (!pr) {
    const bot = /(?:sign in to confirm|no eres un robot|no-soy-un-robot|not a bot)/i.test(r.text);
    return {
      ok: false,
      error: bot
        ? 'la página de YouTube pide verificación anti-robots a esta IP'
        : 'la página de YouTube no trae datos del reproductor'
    };
  }
  const media = parsePlayerMedia(pr);
  const okMedia = Boolean(media.hls_url) || media.formats.some((f) => f.vcodec || f.acodec);
  return {
    ok: okMedia && media.status === 'OK',
    status: media.status,
    error:
      media.status === 'OK'
        ? okMedia
          ? ''
          : 'YouTube no da ninguna pista en la página (puede hacer falta sesión)'
        : media.reason || `YouTube rechaza el vídeo (${media.status || 'sin estado'})`,
    ...media
  };
}

/** Id de vídeo de cualquier forma de URL de YouTube (o de un id suelto). */
export function extractVideoId(raw) {
  const text = String(raw || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const u = new URL(text);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
    const v = u.searchParams.get('v');
    if (v) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'shorts') return parts[1] || '';
    return '';
  } catch {
    return '';
  }
}

/** ¿Hay clave de la Data API guardada? (para poder decirlo en pantalla) */
export function hasApiKeySetting(getSetting) {
  try {
    return Boolean(String(getSetting('youtube_api_key') || process.env.TVLISTER_YT_API_KEY || '').trim());
  } catch {
    return false;
  }
}
