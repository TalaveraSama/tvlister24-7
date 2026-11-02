import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DB_PATH } from './db.js';
import { signLocalPosterPath } from './vodSyncTmdb.js';

/**
 * VOD desde Jellyfin — «Create Symlink», igual que XUI.one.
 *
 * El panel no copia ni mueve nada: pide a la API de Jellyfin la lista de
 * películas y series, localiza el archivo en el disco del servidor y crea un
 * **enlace simbólico** dentro de la carpeta VOD del panel. Ese enlace es lo que
 * se guarda en `vod_items.source_url` / `series_episodes.source_url`, así que
 * los clientes lo reciben por `/movie/...` o `/series/...` servido por el panel
 * con soporte de `Range` (sin depender de Jellyfin para el video).
 *
 * Términos de Jellyfin:
 *   - Autenticación: cabecera `X-Emby-Token` (o `api_key` en la URL).
 *   - `/System/Info`            → nombre y versión del servidor.
 *   - `/Library/MediaFolders`   → bibliotecas (movies, tvshows…).
 *   - `/Items?ParentId=…`       → películas, series.
 *   - `/Shows/{id}/Episodes`    → episodios de una serie.
 *   - `/Items/{id}/Images/…`    → carátula (se descarga al panel).
 *
 * Si el archivo **no** es accesible desde este servidor (Jellyfin en otra
 * máquina), se puede importar con la URL de streaming de Jellyfin
 * (`/Videos/{id}/stream?static=true`) en vez de un enlace; eso queda como
 * opción explícita, nunca por defecto.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.dirname(DB_PATH);

/** Carpeta VOD del panel (donde viven los enlaces). `/opt/tvlister24-7/vod`. */
export const DEFAULT_SYMLINK_DIR = path.join(APP_ROOT, 'vod');
/** Carátulas descargadas de Jellyfin (servidas con `/vod_local_poster`). */
const IMAGE_DIR = path.join(DATA_DIR, 'jellyfin_images');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv', '.ogv', '.3gp'
]);

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

function getSetting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== null && row.value !== undefined ? String(row.value) : fallback;
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function normalizeServerUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

function parsePathMap(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((r) => ({ from: String(r?.from || '').trim(), to: String(r?.to || '').trim() }))
      .filter((r) => r.from && r.to);
  }
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => ({ from: String(r?.from || '').trim(), to: String(r?.to || '').trim() }))
      .filter((r) => r.from && r.to);
  } catch {
    return [];
  }
}

function parseStringArray(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

export function getJellyfinConfig() {
  const url = normalizeServerUrl(getSetting('jellyfin_url', ''));
  const apiKey = getSetting('jellyfin_api_key', '');
  const symlinkDir = String(getSetting('jellyfin_symlink_dir', '') || '').trim() || DEFAULT_SYMLINK_DIR;
  return {
    url,
    configured: Boolean(url && apiKey),
    apiKeyMasked: maskKey(apiKey),
    symlinkDir,
    pathMap: parsePathMap(getSetting('jellyfin_path_map', '[]')),
    libraries: parseStringArray(getSetting('jellyfin_libraries', '[]')),
    directFallback: getSetting('jellyfin_direct_fallback', '0') === '1',
    lastImport: (() => {
      try {
        return JSON.parse(getSetting('jellyfin_last_import', '{}'));
      } catch {
        return {};
      }
    })()
  };
}

function getApiKey() {
  return getSetting('jellyfin_api_key', '');
}

export function saveJellyfinConfig({ url, apiKey, symlinkDir, pathMap, libraries, directFallback } = {}) {
  if (url !== undefined) setSetting('jellyfin_url', normalizeServerUrl(url));
  // Igual que en TMDB: si llega vacío se conserva la clave guardada.
  if (apiKey !== undefined && String(apiKey).trim()) setSetting('jellyfin_api_key', String(apiKey).trim());
  if (symlinkDir !== undefined) setSetting('jellyfin_symlink_dir', String(symlinkDir || '').trim());
  if (pathMap !== undefined) setSetting('jellyfin_path_map', JSON.stringify(parsePathMap(pathMap)));
  if (libraries !== undefined) {
    const list = Array.isArray(libraries) ? libraries.map(String).filter(Boolean) : [];
    setSetting('jellyfin_libraries', JSON.stringify(list));
  }
  if (directFallback !== undefined) setSetting('jellyfin_direct_fallback', directFallback ? '1' : '0');
  return getJellyfinConfig();
}

// ---------------------------------------------------------------------------
// Cliente HTTP de Jellyfin
// ---------------------------------------------------------------------------

function jellyfinBase() {
  const cfg = getJellyfinConfig();
  if (!cfg.url) throw new Error('Falta la URL de Jellyfin (Ajustes → Jellyfin).');
  if (!getApiKey()) throw new Error('Falta la API Key de Jellyfin (Panel → Administración → API Keys).');
  return cfg.url;
}

async function jellyfinFetchJson(apiPath, { timeoutMs = 15000, method = 'GET', body = null } = {}) {
  const base = jellyfinBase();
  const key = getApiKey();
  const url = `${base}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Emby-Token': key,
        Authorization: `MediaBrowser Token="${key}"`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const detail = json?.Message || json?.message || String(text || '').slice(0, 200);
      const err = new Error(
        res.status === 401 || res.status === 403
          ? `Jellyfin rechazó la API Key (HTTP ${res.status}).`
          : `Jellyfin respondió HTTP ${res.status}${detail ? `: ${detail}` : ''}`
      );
      err.status = res.status;
      throw err;
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Jellyfin no respondió en ${Math.round(timeoutMs / 1000)} s (${base}).`);
    if (err.message === 'fetch failed') throw new Error(`No se pudo conectar con Jellyfin en ${base}. Revisa la URL y el firewall.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Conecta con Jellyfin y devuelve nombre/versión del servidor. */
export async function testJellyfinConnection() {
  const info = await jellyfinFetchJson('/System/Info');
  return {
    ok: true,
    serverName: info?.ServerName || '',
    version: info?.Version || '',
    operatingSystem: info?.OperatingSystem || '',
    id: info?.Id || ''
  };
}

/** Bibliotecas de Jellyfin. `collectionType`: movies, tvshows, music… */
export async function listJellyfinLibraries() {
  const data = await jellyfinFetchJson('/Library/MediaFolders');
  const items = Array.isArray(data?.Items) ? data.Items : [];
  return items.map((it) => ({
    id: String(it.Id || ''),
    name: String(it.Name || ''),
    collectionType: String(it.CollectionType || ''),
    locations: Array.isArray(it.Locations) ? it.Locations.map(String) : []
  }));
}

// ---------------------------------------------------------------------------
// Rutas: Jellyfin puede ver el disco con otro prefijo que este servidor
// ---------------------------------------------------------------------------

/** Aplica el mapa de rutas (`/media/peliculas` → `/mnt/peliculas`). */
export function mapJellyfinPath(rawPath, pathMap = getJellyfinConfig().pathMap) {
  const original = String(rawPath || '').trim();
  if (!original) return '';
  const rules = [...pathMap].sort((a, b) => b.from.length - a.from.length);
  for (const rule of rules) {
    const from = rule.from.replace(/\/+$/, '');
    if (original === from) return rule.to;
    if (original.startsWith(`${from}/`)) return `${rule.to.replace(/\/+$/, '')}${original.slice(from.length)}`;
  }
  return original;
}

/**
 * Mira por qué una ruta de Jellyfin no sirve: `ok`, `missing` (no existe en este
 * servidor) o `forbidden` (existe pero el panel no puede leerla, permisos).
 */
export function explainLocalMediaPath(jellyfinPath, pathMap = getJellyfinConfig().pathMap) {
  const original = String(jellyfinPath || '').trim();
  if (!original) return { path: '', ok: false, reason: 'missing' };
  const mapped = mapJellyfinPath(original, pathMap);
  const candidates = [...new Set([mapped, original].filter(Boolean))];
  let sawForbidden = false;
  let sawDirectory = false;
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) {
        sawDirectory = true;
        continue;
      }
      // statSync pasa aunque el archivo no se pueda leer: se comprueba aparte,
      // porque si no el panel diría «accesible» y el reproductor daría 500.
      try {
        fs.accessSync(candidate, fs.constants.R_OK);
      } catch {
        sawForbidden = true;
        continue;
      }
      return { path: fs.realpathSync(candidate), ok: true, reason: 'ok' };
    } catch (err) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') sawForbidden = true;
    }
  }
  if (!sawForbidden) {
    const indexed = lookupFileIndex(path.basename(original));
    if (indexed) return { path: indexed, ok: true, reason: 'index', viaIndex: true };
  }
  return { path: '', ok: false, reason: sawForbidden ? 'forbidden' : sawDirectory ? 'not_a_file' : 'missing' };
}

// Índice `nombre de archivo → ruta real` descubierto al detectar carpetas.
// Sirve de respaldo cuando la equivalencia de prefijo no cubre todos los
// archivos (mismo prefijo de Jellyfin con el contenido repartido en dos discos).
const FILE_INDEX_KEY = 'jellyfin_file_index';
const FILE_INDEX_LIMIT = 12000;
let fileIndexCache = null;

function loadFileIndex() {
  if (fileIndexCache) return fileIndexCache;
  try {
    const raw = JSON.parse(getSetting(FILE_INDEX_KEY, '{}') || '{}');
    fileIndexCache = raw && typeof raw === 'object' ? raw : {};
  } catch {
    fileIndexCache = {};
  }
  return fileIndexCache;
}

/** Guarda el índice (sólo nombres de vídeo, acotado para no inflar los ajustes). */
export function saveJellyfinFileIndex(entries) {
  const clean = {};
  let n = 0;
  for (const [key, value] of Object.entries(entries || {})) {
    if (n >= FILE_INDEX_LIMIT) break;
    if (!key || !value) continue;
    clean[String(key).toLowerCase()] = String(value);
    n += 1;
  }
  if (n > 0) {
    setSetting(FILE_INDEX_KEY, JSON.stringify(clean));
    fileIndexCache = clean;
  }
  return n;
}

function lookupFileIndex(fileName) {
  const key = String(fileName || '').toLowerCase();
  if (!key) return '';
  const hit = loadFileIndex()[key] || '';
  if (!hit) return '';
  try {
    return fs.statSync(hit).isFile() ? hit : '';
  } catch {
    return '';
  }
}

/** Ruta local real del archivo, o '' si desde este servidor no se ve. */
function resolveLocalMediaPath(jellyfinPath) {
  return explainLocalMediaPath(jellyfinPath).path;
}

// ---------------------------------------------------------------------------
// Jellyfin en otro servidor: el panel retransmite el vídeo
// ---------------------------------------------------------------------------
//
// Si los archivos NO están en el disco del panel (Jellyfin en otra máquina o en
// un contenedor sin el disco montado) no se puede crear un enlace: se guarda una
// fuente `jellyfin://<Id>` y el panel hace de intermediario con la API Key, que
// nunca sale al cliente.

const JELLYFIN_SOURCE_PREFIX = 'jellyfin://';

export function buildJellyfinStreamSource(itemId) {
  return `${JELLYFIN_SOURCE_PREFIX}${encodeURIComponent(String(itemId || ''))}`;
}

export function isJellyfinStreamSource(source) {
  return String(source || '').startsWith(JELLYFIN_SOURCE_PREFIX);
}

export function jellyfinItemIdFromSource(source) {
  if (!isJellyfinStreamSource(source)) return '';
  try {
    return decodeURIComponent(String(source).slice(JELLYFIN_SOURCE_PREFIX.length));
  } catch {
    return '';
  }
}

/** URL real de Jellyfin (sólo para el servidor: lleva la API Key). */
export function jellyfinStreamUrl(itemId, { static: staticStream = true } = {}) {
  const cfg = getJellyfinConfig();
  if (!cfg.url) throw new Error('Falta la URL de Jellyfin.');
  const key = getApiKey();
  if (!key) throw new Error('Falta la API Key de Jellyfin.');
  const qs = staticStream ? `?static=true&api_key=${encodeURIComponent(key)}` : `?api_key=${encodeURIComponent(key)}`;
  return `${cfg.url}/Videos/${encodeURIComponent(String(itemId))}/stream${qs}`;
}

/**
 * Enlaces guardados por versiones anteriores: era la URL completa de Jellyfin
 * con la `api_key` dentro. Se siguen sirviendo (por el relé) para no romper
 * nada, y la clave deja de salir al cliente.
 */
export function isLegacyJellyfinDirectUrl(source) {
  const raw = String(source || '');
  if (!/^https?:\/\//i.test(raw)) return false;
  if (!/\/Videos\/[^/]+\/stream/i.test(raw)) return false;
  const base = getJellyfinConfig().url;
  return Boolean(base) && raw.startsWith(base);
}

export function legacyJellyfinItemId(source) {
  const m = /\/Videos\/([^/?#]+)\/stream/i.exec(String(source || ''));
  return m ? decodeURIComponent(m[1]) : '';
}

/** ¿La fuente de este VOD/episodio se sirve a través del panel desde Jellyfin? */
export function isJellyfinRelaySource(source) {
  return isJellyfinStreamSource(source) || isLegacyJellyfinDirectUrl(source);
}

// --------------------------------------------------------------------------- 
// Crear el enlace («Create Symlink» de XUI.one)
// ---------------------------------------------------------------------------

function sanitizeName(raw, max = 120) {
  return String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkPointsTo(linkPath, target) {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

/**
 * Crea (o reutiliza) un enlace simbólico al archivo real y devuelve su ruta.
 *
 * Reglas:
 *   - Nunca borra un archivo real: si en el destino hay un archivo normal, se
 *     usa otro nombre con sufijo.
 *   - Si ya existe un enlace al mismo archivo, se reutiliza.
 *   - Si existe un enlace a otro archivo, se reemplaza (es nuestro).
 */
export function createMediaSymlink({ targetPath, title, year, kind = 'movies', containerExt = '', symlinkDir = '' }) {
  const target = String(targetPath || '').trim();
  if (!target) throw new Error('Falta el archivo de origen para el enlace.');
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`El archivo «${target}» no existe en este servidor.`);
  }
  if (!stat.isFile()) throw new Error(`«${target}» no es un archivo.`);

  const root = ensureDir(String(symlinkDir || getJellyfinConfig().symlinkDir || DEFAULT_SYMLINK_DIR));
  const subDir = kind === 'series' ? ensureDir(path.join(root, 'series')) : ensureDir(path.join(root, 'movies'));

  const ext = String(containerExt || path.extname(target) || '.mp4').startsWith('.')
    ? String(containerExt || path.extname(target))
    : `.${containerExt || path.extname(target).replace(/^\./, '')}`;
  const base = sanitizeName(title || path.basename(target, path.extname(target))) || 'video';
  // Muchos títulos ya traen el año («… 2025», «… (2024)»): no se repite.
  const alreadyHasYear = new RegExp(`(?:19|20)\\d{2}`).test(base);
  const yearTag = Number(year) > 1900 && !alreadyHasYear ? ` (${Number(year)})` : '';

  let attempt = 0;
  for (;;) {
    const suffix = attempt === 0 ? '' : ` - ${attempt + 1}`;
    const linkPath = path.join(subDir, `${base}${yearTag}${suffix}${ext}`);
    if (!fs.existsSync(linkPath) && !isSymlink(linkPath)) {
      fs.symlinkSync(target, linkPath);
      return linkPath;
    }
    if (isSymlink(linkPath)) {
      if (linkPointsTo(linkPath, target)) return linkPath;
      // Enlace nuestro apuntando a otro archivo: se rehace.
      try {
        fs.unlinkSync(linkPath);
        fs.symlinkSync(target, linkPath);
        return linkPath;
      } catch {
        /* si falla, se prueba otro nombre */
      }
    }
    attempt += 1;
    if (attempt > 50) throw new Error(`No se pudo crear el enlace para «${base}» (demasiados nombres ocupados).`);
  }
}

/** Borra el enlace de un elemento si es un enlace simbólico bajo la carpeta VOD. */
export function removeManagedSymlink(linkPath) {
  const p = String(linkPath || '').trim();
  if (!p || !isSymlink(p)) return false;
  const root = path.resolve(String(getJellyfinConfig().symlinkDir || DEFAULT_SYMLINK_DIR));
  const resolvedLink = path.resolve(p);
  if (!resolvedLink.startsWith(`${root}${path.sep}`)) return false;
  try {
    fs.unlinkSync(resolvedLink);
    return true;
  } catch {
    return false;
  }
}

/**
 * «Create Symlink» sobre una película ya existente en el panel: convierte una
 * ruta local en un enlace dentro de la carpeta VOD. No toca el archivo original.
 */
export function createSymlinkForVod(vodId) {
  const item = db.prepare('SELECT * FROM vod_items WHERE id = ?').get(Number(vodId));
  if (!item) throw new Error('Película no encontrada.');
  const source = String(item.source_url || '').trim();
  if (!source.startsWith('/')) throw new Error('Esa película no apunta a un archivo local: no hay nada que enlazar.');
  const target = resolveLocalMediaPath(source);
  if (!target) throw new Error(`El archivo «${source}» no existe en este servidor.`);

  const link = createMediaSymlink({
    targetPath: target,
    title: item.title,
    year: item.release_year,
    kind: 'movies',
    containerExt: item.container_ext || path.extname(target).replace(/^\./, '')
  });
  db.prepare("UPDATE vod_items SET source_url = ?, symlink_path = ?, container_ext = ? WHERE id = ?").run(
    link,
    link,
    path.extname(link).replace(/^\./, '') || item.container_ext,
    item.id
  );
  return { id: item.id, source_url: link, symlink_path: link, target };
}

/** Lo mismo para un episodio. */
export function createSymlinkForEpisode(episodeId) {
  const ep = db
    .prepare(
      `SELECT e.*, s.title as series_title FROM series_episodes e LEFT JOIN series s ON s.id = e.series_id WHERE e.id = ?`
    )
    .get(Number(episodeId));
  if (!ep) throw new Error('Episodio no encontrado.');
  const source = String(ep.source_url || '').trim();
  if (!source.startsWith('/')) throw new Error('Ese episodio no apunta a un archivo local.');
  const target = resolveLocalMediaPath(source);
  if (!target) throw new Error(`El archivo «${source}» no existe en este servidor.`);

  const link = createMediaSymlink({
    targetPath: target,
    // Mismo nombre que usa la importación: «Serie - S01E02.ext» (sin título del episodio).
    title: `${ep.series_title || 'Serie'} - S${String(ep.season_num).padStart(2, '0')}E${String(ep.episode_num).padStart(2, '0')}`,
    kind: 'series',
    containerExt: ep.container_ext || path.extname(target).replace(/^\./, '')
  });
  db.prepare("UPDATE series_episodes SET source_url = ?, symlink_path = ?, container_ext = ? WHERE id = ?").run(
    link,
    link,
    path.extname(link).replace(/^\./, '') || ep.container_ext,
    ep.id
  );
  return { id: ep.id, source_url: link, symlink_path: link, target };
}

/** Rehace todos los enlaces locales (útil tras mover la carpeta VOD). */
export function rebuildAllSymlinks({ dryRun = false } = {}) {
  const movies = db.prepare("SELECT id, title, source_url FROM vod_items WHERE source_url LIKE '/%'").all();
  const episodes = db.prepare("SELECT id FROM series_episodes WHERE source_url LIKE '/%'").all();
  const result = { total: movies.length + episodes.length, linked: 0, failed: 0, details: [] };

  if (dryRun) {
    result.details = movies.slice(0, 50).map((m) => ({ kind: 'movie', id: m.id, title: m.title, source_url: m.source_url }));
    return result;
  }

  for (const m of movies) {
    try {
      createSymlinkForVod(m.id);
      result.linked += 1;
    } catch (err) {
      result.failed += 1;
      result.details.push({ kind: 'movie', id: m.id, error: err.message });
    }
  }
  for (const e of episodes) {
    try {
      createSymlinkForEpisode(e.id);
      result.linked += 1;
    } catch (err) {
      result.failed += 1;
      result.details.push({ kind: 'episode', id: e.id, error: err.message });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Carátulas: se descargan al panel (nunca se expone la API Key al cliente)
// ---------------------------------------------------------------------------

async function downloadJellyfinImage(itemId, type = 'Primary', tag = '') {
  if (!itemId) return '';
  ensureDir(IMAGE_DIR);
  const base = jellyfinBase();
  const key = getApiKey();
  const qs = new URLSearchParams();
  if (tag) qs.set('tag', String(tag));
  qs.set('maxHeight', type === 'Backdrop' ? '720' : '750');
  qs.set('quality', '90');
  const url = `${base}/Items/${encodeURIComponent(itemId)}/Images/${type}?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'X-Emby-Token': key, Authorization: `MediaBrowser Token="${key}"` },
      signal: controller.signal
    });
    if (!res.ok) return '';
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('image/')) return '';
    const ext = MIME_EXT[contentType] || '.jpg';
    const fileName = `jf-${String(itemId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}-${type.toLowerCase()}${ext}`;
    const filePath = path.join(IMAGE_DIR, fileName);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return '';
    fs.writeFileSync(filePath, buffer);
    return signLocalPosterPath(filePath);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Lectura de la biblioteca
// ---------------------------------------------------------------------------

function secondsFromTicks(ticks) {
  const n = Number(ticks);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round(n / 10_000_000));
}

function containerFromPath(filePath) {
  return String(path.extname(String(filePath || '')).replace(/^\./, '') || 'mp4').toLowerCase();
}

function imageTag(item, type) {
  const tags = item?.ImageTags || {};
  return tags?.[type] || '';
}

function normalizeLibraryIds(libraryIds) {
  const list = Array.isArray(libraryIds) ? libraryIds.map(String).filter(Boolean) : [];
  if (list.length) return list;
  return getJellyfinConfig().libraries;
}

async function fetchMovies(libraryId, { limit = 5000 } = {}) {
  const qs = new URLSearchParams({
    ParentId: libraryId,
    Recursive: 'true',
    IncludeItemTypes: 'Movie',
    Fields: 'Path,Overview,ProductionYear,RunTimeTicks,CommunityRating,Genres,ProviderIds,MediaSources,ImageTags',
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    ImageTypeLimit: '1',
    Limit: String(limit)
  });
  const data = await jellyfinFetchJson(`/Items?${qs.toString()}`, { timeoutMs: 30000 });
  return Array.isArray(data?.Items) ? data.Items : [];
}

async function fetchSeries(libraryId, { limit = 5000 } = {}) {
  const qs = new URLSearchParams({
    ParentId: libraryId,
    Recursive: 'true',
    IncludeItemTypes: 'Series',
    Fields: 'Path,Overview,ProductionYear,CommunityRating,Genres,ProviderIds,ImageTags',
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    ImageTypeLimit: '1',
    Limit: String(limit)
  });
  const data = await jellyfinFetchJson(`/Items?${qs.toString()}`, { timeoutMs: 30000 });
  return Array.isArray(data?.Items) ? data.Items : [];
}

async function fetchEpisodes(seriesId) {
  const qs = new URLSearchParams({
    Fields: 'Path,Overview,RunTimeTicks,MediaSources,IndexNumber,ParentIndexNumber',
    SortBy: 'ParentIndexNumber,IndexNumber',
    SortOrder: 'Ascending'
  });
  const data = await jellyfinFetchJson(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${qs.toString()}`, {
    timeoutMs: 30000
  });
  return Array.isArray(data?.Items) ? data.Items : [];
}

/** Ruta del archivo según Jellyfin (a veces viene en MediaSources). */
function itemPath(item) {
  const direct = String(item?.Path || '').trim();
  if (direct) return direct;
  const source = Array.isArray(item?.MediaSources) ? item.MediaSources[0] : null;
  return String(source?.Path || '').trim();
}

// ---------------------------------------------------------------------------
// Previsualización e importación
// ---------------------------------------------------------------------------

/**
 * Mira qué hay en Jellyfin sin tocar la base de datos: cuántas películas y
 * series, y cuántos archivos son accesibles desde este servidor (para poder
 * crear el enlace).
 */
export async function previewJellyfinImport({ libraryIds = [], contentMode = 'auto', sampleLimit = 12 } = {}) {
  const libraries = await listJellyfinLibraries();
  const ids = normalizeLibraryIds(libraryIds);
  const selected = ids.length ? libraries.filter((l) => ids.includes(l.id)) : libraries;
  if (!selected.length) throw new Error('Jellyfin no devolvió bibliotecas. Crea una biblioteca de películas o series.');

  const wantMovies = contentMode !== 'series';
  const wantSeries = contentMode !== 'movies';
  const preview = {
    libraries: [],
    movies: 0,
    series: 0,
    episodes: 0,
    reachable: 0,
    unreachable: 0,
    forbidden: 0,
    prefixes: [],
    sample: []
  };
  const prefixStats = new Map(); // '/Media' -> {total, missing, forbidden}
  const notePath = (p) => {
    const info = explainLocalMediaPath(p);
    if (info.ok) {
      preview.reachable += 1;
    } else {
      preview.unreachable += 1;
      if (info.reason === 'forbidden') preview.forbidden += 1;
    }
    const prefix = pathPrefix(p);
    if (prefix) {
      const st = prefixStats.get(prefix) || { prefix, total: 0, missing: 0, forbidden: 0 };
      st.total += 1;
      if (!info.ok) st.missing += 1;
      if (info.reason === 'forbidden') st.forbidden += 1;
      prefixStats.set(prefix, st);
    }
    return info;
  };

  for (const lib of selected) {
    const kind = libraryKind(lib);
    const entry = {
      id: lib.id,
      name: lib.name,
      collectionType: lib.collectionType,
      kind,
      movies: 0,
      series: 0,
      episodes: 0
    };
    preview.libraries.push(entry);
    if (kind === 'other') continue; // listas de reproducción, música, fotos…

    if (wantMovies && kind === 'movies') {
      const movies = await fetchMovies(lib.id);
      entry.movies = movies.length;
      preview.movies += movies.length;
      for (const m of movies) {
        const p = itemPath(m);
        const info = p ? notePath(p) : { path: '', ok: false, reason: 'missing' };
        if (preview.sample.length < sampleLimit) {
          preview.sample.push({
            kind: 'movie',
            title: String(m.Name || ''),
            year: Number(m.ProductionYear) || null,
            path: p,
            localPath: info.path,
            reachable: info.ok,
            reason: info.ok ? '' : info.reason
          });
        }
      }
    }

    if (wantSeries && kind === 'series') {
      const shows = await fetchSeries(lib.id);
      entry.series = shows.length;
      preview.series += shows.length;
      for (const show of shows.slice(0, 40)) {
        const eps = await fetchEpisodes(show.Id);
        entry.episodes += eps.length;
        preview.episodes += eps.length;
        for (const ep of eps) {
          const p = itemPath(ep);
          const info = p ? notePath(p) : { path: '', ok: false, reason: 'missing' };
          if (preview.sample.length < sampleLimit) {
            preview.sample.push({
              kind: 'episode',
              title: `${show.Name || ''} S${ep.ParentIndexNumber || 1}E${ep.IndexNumber || 1}`,
              path: p,
              localPath: info.path,
              reachable: info.ok,
              reason: info.ok ? '' : info.reason
            });
          }
        }
      }
    }
  }

  preview.symlinkDir = getJellyfinConfig().symlinkDir;
  preview.config = { url: getJellyfinConfig().url, pathMap: getJellyfinConfig().pathMap };
  preview.prefixes = [...prefixStats.values()]
    .filter((p) => p.missing > 0)
    .sort((a, b) => b.missing - a.missing)
    .slice(0, 6);
  preview.needsMapping = preview.unreachable > 0 && preview.forbidden < preview.unreachable;
  // Nada accesible y nada «sin permiso» = Jellyfin está en otra máquina (o el
  // disco no está montado aquí). En ese caso la salida es retransmitir.
  preview.remoteServer = preview.unreachable > 0 && preview.reachable === 0 && preview.forbidden === 0;
  if (preview.remoteServer) {
    preview.hint =
      'Jellyfin está en otro servidor: los archivos no están en este disco, así que no se pueden enlazar. ' +
      'Activa «Servir desde Jellyfin» y el panel retransmitirá el vídeo (la API Key no sale al cliente).';
  }
  return preview;
}

// ---------------------------------------------------------------------------
// Detección de la carpeta real: Jellyfin (sobre todo en Docker) ve el disco con
// otro prefijo (`/Media`, `/data/movies`…) que no existe igual en este servidor.
// ---------------------------------------------------------------------------

const SEARCH_ROOTS = [
  '/media',
  '/Media',
  '/mnt',
  '/srv',
  '/data',
  '/opt',
  '/home',
  '/var/lib',
  '/volume1',
  '/volume2',
  '/storage'
];

const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  'proc',
  'sys',
  'dev',
  'run',
  'snap',
  'lost+found',
  'streams_runtime',
  'releases',
  '__pycache__'
]);

function isReadableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK); // accessSync devuelve undefined: se comprueba aparte
    return true;
  } catch {
    return false;
  }
}

/** Directorios donde puede estar de verdad el contenido (sin duplicados). */
function candidateSearchRoots(extra = []) {
  const roots = [];
  const push = (dir) => {
    const clean = String(dir || '').trim();
    if (clean && !roots.includes(clean)) roots.push(clean);
  };
  for (const dir of extra) push(dir);
  // Carpetas de sincronización del propio panel: ahí ya hay VOD del cliente.
  try {
    for (const row of db.prepare('SELECT folder_path FROM vod_watch_folders').all()) push(row.folder_path);
  } catch {
    /* tabla aún no migrada */
  }
  for (const dir of SEARCH_ROOTS) push(dir);
  return roots.filter(isReadableDir);
}

/**
 * Raíces «probables» para una ruta de Jellyfin: se prueba a sustituir el primer
 * tramo (`/Media`) por cada carpeta real conocida. Es el caso normal de Docker
 * (`-v /home/xui/media:/Media`), sin recorrer el disco entero.
 */
function directReplacementBases(prefix, roots) {
  const bases = [];
  const last = prefix.split('/').filter(Boolean).pop() || 'media';
  const names = [...new Set([last, last.toLowerCase()])];
  for (const root of roots) {
    bases.push(root);
    for (const name of names) bases.push(path.join(root, name));
  }
  return [...new Set(bases)].filter(isReadableDir);
}

/**
 * Índice `nombre de archivo → ruta real` recorriendo las carpetas candidatas.
 * Acotado por tiempo y profundidad para no colgar el panel en discos grandes.
 */
function indexMediaFileNames(roots, { maxSeconds = 12, maxDepth = 7, limit = 60000 } = {}) {
  const index = new Map();
  const started = Date.now();
  const deadline = started + maxSeconds * 1000;
  const visited = new Set();
  let scanned = 0;
  let truncated = false;

  const walk = (dir, depth) => {
    if (truncated) return;
    if (Date.now() > deadline || index.size >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (Date.now() > deadline || index.size >= limit) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // no seguir enlaces (bucles)
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (visited.has(full)) continue;
        visited.add(full);
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      scanned += 1;
      const key = entry.name.toLowerCase();
      const list = index.get(key);
      if (list) {
        if (list.length < 3) list.push(full);
      } else {
        index.set(key, [full]);
      }
    }
  };

  for (const root of roots) {
    if (truncated) break;
    walk(root, 0);
  }
  return { index, scanned, truncated, elapsedMs: Date.now() - started };
}

/**
 * Rutas de Jellyfin (películas y episodios) de las bibliotecas indicadas.
 * Se usa para la vista previa y para la detección de carpetas.
 */
async function collectJellyfinPaths({ libraryIds = [], contentMode = 'auto', maxShows = 60, maxMovies = 5000 } = {}) {
  const libraries = await listJellyfinLibraries();
  const ids = normalizeLibraryIds(libraryIds);
  const selected = ids.length ? libraries.filter((l) => ids.includes(l.id)) : libraries;
  const items = [];
  for (const lib of selected) {
    const kind = libraryKind(lib);
    if (kind === 'other') continue;
    if (contentMode !== 'series' && kind === 'movies') {
      const movies = (await fetchMovies(lib.id)).slice(0, maxMovies);
      for (const m of movies) {
        items.push({ kind: 'movie', title: String(m.Name || ''), library: lib, path: itemPath(m) });
      }
    }
    if (contentMode !== 'movies' && kind === 'series') {
      const shows = (await fetchSeries(lib.id)).slice(0, maxShows);
      for (const show of shows) {
        const eps = await fetchEpisodes(show.Id);
        for (const ep of eps) {
          items.push({
            kind: 'episode',
            title: `${show.Name || ''} S${ep.ParentIndexNumber || 1}E${ep.IndexNumber || 1}`,
            library: lib,
            path: itemPath(ep)
          });
        }
      }
    }
  }
  return { libraries, selected, items };
}

/** Prefijo de una ruta de Jellyfin: `/Media/Peliculas/x.mkv` → `/Media`. */
function pathPrefix(filePath) {
  const segs = String(filePath || '').split('/').filter(Boolean);
  return segs.length ? `/${segs[0]}` : '';
}

/**
 * Averigua a qué carpeta real corresponde cada prefijo de Jellyfin.
 *
 * 1. Prueba sustituciones directas del prefijo por las carpetas conocidas
 *    (`/Media` → `/media`, `/mnt/media`, `/home/xui/media`…).
 * 2. Si no acierta, busca los archivos por su nombre en las carpetas candidatas.
 * 3. Devuelve la mejor equivalencia por prefijo, con cuántos archivos resuelve.
 */
export async function detectJellyfinPathMappings({
  libraryIds = [],
  contentMode = 'auto',
  extraRoots = [],
  maxSeconds = 12
} = {}) {
  const started = Date.now();
  const { items } = await collectJellyfinPaths({ libraryIds, contentMode });
  const currentMap = getJellyfinConfig().pathMap;
  const missing = items.filter((it) => it.path && !explainLocalMediaPath(it.path, currentMap).ok);

  const byPrefix = new Map();
  for (const it of missing) {
    const prefix = pathPrefix(it.path);
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(it);
  }

  const roots = candidateSearchRoots(extraRoots);
  const proposals = [];
  let scanInfo = null;
  let index = null;

  for (const [prefix, list] of byPrefix) {
    const sample = list.slice(0, 40);
    let best = null;

    // --- 1) Sustitución directa del prefijo --------------------------------
    for (const base of directReplacementBases(prefix, roots)) {
      const map = [{ from: prefix, to: base }];
      let hits = 0;
      for (const it of sample) if (explainLocalMediaPath(it.path, map).ok) hits += 1;
      if (hits === 0) continue;
      // Cobertura completa sobre todos los archivos de ese prefijo.
      let total = 0;
      for (const it of list) if (explainLocalMediaPath(it.path, map).ok) total += 1;
      if (!best || total > best.matched) best = { from: prefix, to: base, matched: total, total: list.length, method: 'direct' };
      if (total === list.length) break;
    }

    // --- 2) Búsqueda por nombre de archivo --------------------------------
    if (!best || best.matched < list.length) {
      if (!index) {
        scanInfo = indexMediaFileNames(roots, { maxSeconds });
        index = scanInfo.index;
      }
      const votes = new Map();
      for (const it of sample) {
        const base = path.basename(it.path);
        const found = index.get(base.toLowerCase());
        if (!found || !found.length) continue;
        const rest = it.path.slice(prefix.length); // "/Peliculas/x.mkv"
        for (const full of found) {
          if (!full.endsWith(rest)) continue;
          const to = full.slice(0, full.length - rest.length).replace(/\/+$/, '') || '/';
          if (!isReadableDir(to)) continue;
          votes.set(to, (votes.get(to) || 0) + 1);
        }
      }
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      for (const [to] of ranked.slice(0, 5)) {
        const map = [{ from: prefix, to }];
        let total = 0;
        for (const it of list) if (explainLocalMediaPath(it.path, map).ok) total += 1;
        if (!best || total > best.matched) best = { from: prefix, to, matched: total, total: list.length, method: 'search' };
        if (total === list.length) break;
      }
    }

    if (best && best.matched > 0) proposals.push(best);
  }

  const mapping = proposals.map((p) => ({ from: p.from, to: p.to }));

  // Índice por nombre: cubre lo que las equivalencias no alcancen (el mismo
  // prefijo de Jellyfin puede tener el contenido repartido en dos carpetas).
  const indexEntries = {};
  if (index) {
    for (const [name, paths] of index) {
      if (paths.length === 1) indexEntries[name] = paths[0];
    }
  }
  const missingNames = new Set(
    items
      .filter((it) => it.path && !explainLocalMediaPath(it.path, [...currentMap, ...mapping]).ok)
      .map((it) => path.basename(it.path).toLowerCase())
  );
  let indexedResolved = 0;
  for (const name of missingNames) {
    if (indexEntries[name]) indexedResolved += 1;
  }
  const indexUsed = Object.fromEntries(
    Object.entries(indexEntries).filter(([name]) => missingNames.has(name))
  );
  const forbidden = missing.filter((it) => explainLocalMediaPath(it.path, currentMap).reason === 'forbidden').length;

  if (Object.keys(indexEntries).length) saveJellyfinFileIndex(indexEntries);

  return {
    total: items.length,
    unreachable: missing.length,
    reachable: items.length - missing.length,
    forbidden,
    mapping,
    proposals: proposals.sort((a, b) => b.matched - a.matched),
    resolved: proposals.reduce((acc, p) => acc + p.matched, 0),
    indexedFiles: Object.keys(indexEntries).length,
    indexedResolved,
    indexUsed: Object.keys(indexUsed).length,
    roots,
    scanned: scanInfo ? scanInfo.scanned : 0,
    scanTruncated: scanInfo ? scanInfo.truncated : false,
    elapsedMs: Date.now() - started,
    hint:
      proposals.length === 0
        ? forbidden > 0
          ? 'Los archivos existen pero el panel no puede leerlos: revisa propietario y permisos del usuario del servicio (chown/chmod).'
          : 'No se encontraron los archivos en este servidor. Si Jellyfin está en otra máquina, activa «usar la URL de Jellyfin»; si el disco está montado aquí, indica la equivalencia a mano.'
        : ''
  };
}

/**
 * Tipo real de una biblioteca de Jellyfin. `playlists` (y música, fotos, etc.)
 * se omiten: son la misma película otra vez con otro Id y duplicarían el
 * catálogo. Sólo `movies`/`boxsets` y `tvshows` se importan.
 */
function libraryKind(lib) {
  const type = String(lib?.collectionType || '').toLowerCase();
  const name = String(lib?.name || '');
  if (type === 'tvshows') return 'series';
  if (type === 'movies' || type === 'boxsets') return 'movies';
  if (['playlists', 'music', 'homevideos', 'musicvideos', 'photos', 'livetv', 'books'].includes(type)) return 'other';
  if (/serie|series|\btv\b/i.test(name)) return 'series';
  if (/movie|pelicula|película|film|vod/i.test(name)) return 'movies';
  return type ? 'other' : 'movies';
}

function ensureCategory(name, type) {
  const clean = sanitizeName(name, 80) || (type === 'series' ? 'Jellyfin Series' : 'Jellyfin Películas');
  const existing = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1').get(clean, type);
  if (existing) return Number(existing.id);
  const info = db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, 50)').run(clean, type);
  return Number(info.lastInsertRowid);
}

/**
 * Importa películas y series de Jellyfin.
 *
 * `createSymlink` (por defecto **true**, como el «Create Symlink» de XUI.one):
 * crea el enlace en la carpeta VOD y guarda esa ruta. Si es `false`, guarda el
 * archivo original tal cual (si es accesible) o la URL de Jellyfin si se pidió
 * `directFallback`.
 */
export async function importFromJellyfin({
  libraryIds = [],
  contentMode = 'auto',
  createSymlink = true,
  symlinkDir = '',
  useLibraryAsCategory = true,
  defaultCategoryId = null,
  autoTmdb = false,
  directFallback = null,
  fetchImages = true,
  maxItems = 5000,
  autoDetectPaths = false,
  searchRoots = []
} = {}) {
  // Jellyfin en Docker ve `/Media` y en el servidor está en otro sitio: si se
  // pide, se detecta la carpeta real y se guarda la equivalencia antes de
  // importar. Sin esto, una biblioteca entera se queda en «no accesible».
  let detected = null;
  if (autoDetectPaths) {
    try {
      detected = await detectJellyfinPathMappings({ libraryIds, contentMode, extraRoots: searchRoots });
      if (detected.mapping.length) {
        const merged = [...getJellyfinConfig().pathMap];
        for (const rule of detected.mapping) {
          const i = merged.findIndex((r) => r.from === rule.from);
          if (i >= 0) merged[i] = rule;
          else merged.push(rule);
        }
        saveJellyfinConfig({ pathMap: merged });
      }
    } catch {
      detected = null;
    }
  }
  const cfg = getJellyfinConfig();
  const useDirect = directFallback === null ? cfg.directFallback : Boolean(directFallback);
  if (symlinkDir) saveJellyfinConfig({ symlinkDir });

  const libraries = await listJellyfinLibraries();
  const ids = normalizeLibraryIds(libraryIds);
  const selected = ids.length ? libraries.filter((l) => ids.includes(l.id)) : libraries;
  if (!selected.length) throw new Error('Jellyfin no devolvió bibliotecas.');

  const stats = {
    libraries: selected.length,
    moviesAdded: 0,
    moviesExisting: 0,
    seriesAdded: 0,
    seriesExisting: 0,
    episodesAdded: 0,
    episodesExisting: 0,
    symlinks: 0,
    directUrls: 0,
    relayed: 0,
    skippedNoFile: 0,
    images: 0,
    tmdbEnriched: 0,
    errors: []
  };

  const fallbackVodCat = defaultCategoryId ? Number(defaultCategoryId) : null;
  const findMovieByExternal = db.prepare(
    "SELECT * FROM vod_items WHERE source_provider = 'jellyfin' AND external_id = ? LIMIT 1"
  );
  const insMovie = db.prepare(`
    INSERT INTO vod_items (
      title, type, category_id, source_url, poster_url, backdrop_url, plot, genre,
      release_year, rating, duration_sec, container_ext, source_provider, external_id, symlink_path
    ) VALUES (?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jellyfin', ?, ?)
  `);
  const findSeriesByExternal = db.prepare("SELECT * FROM series WHERE external_id = ? LIMIT 1");
  const insSeries = db.prepare(`
    INSERT INTO series (title, category_id, poster_url, backdrop_url, plot, genre, release_year, rating, external_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findEpisodeByExternal = db.prepare('SELECT id FROM series_episodes WHERE external_id = ? LIMIT 1');
  const insEpisode = db.prepare(`
    INSERT INTO series_episodes (
      series_id, season_num, episode_num, title, source_url, plot, duration_sec, container_ext,
      external_id, symlink_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const newVodIds = [];
  const newSeriesIds = [];

  const buildSource = ({ item, path: filePath, title, year, kind, containerExt }) => {
    const local = filePath ? resolveLocalMediaPath(filePath) : '';
    if (createSymlink && !local && useDirect) {
      // Jellyfin está en otra máquina: no hay archivo que enlazar, pero el
      // panel puede retransmitirlo. Se usa el relé en vez de descartarlo.
      return { source: buildJellyfinStreamSource(item.Id), symlink: '', reason: '', relay: true };
    }
    if (createSymlink) {
      if (!local) return { source: '', symlink: '', reason: 'archivo_no_accesible' };
      const link = createMediaSymlink({
        targetPath: local,
        title,
        year,
        kind,
        containerExt,
        symlinkDir: symlinkDir || cfg.symlinkDir
      });
      return { source: link, symlink: link, reason: '' };
    }
    if (local) return { source: local, symlink: '', reason: '' };
    if (useDirect) {
      // Se guarda un marcador, no la URL con la clave: el panel retransmite y
      // la API Key no viaja nunca al reproductor del cliente.
      return { source: buildJellyfinStreamSource(item.Id), symlink: '', reason: '', relay: true };
    }
    return { source: '', symlink: '', reason: 'archivo_no_accesible' };
  };

  for (const lib of selected) {
    const kind = libraryKind(lib);
    if (kind === 'other') continue;

    if (contentMode !== 'series' && kind === 'movies') {
      const movies = (await fetchMovies(lib.id)).slice(0, maxItems);
      const movieCat = fallbackVodCat || (useLibraryAsCategory ? ensureCategory(`Jellyfin · ${lib.name}`, 'vod') : ensureCategory('Jellyfin Películas', 'vod'));

      for (const m of movies) {
        try {
          const existing = findMovieByExternal.get(String(m.Id));
          if (existing) {
            stats.moviesExisting += 1;
            continue;
          }
          const filePath = itemPath(m);
          const year = Number(m.ProductionYear) || null;
          const containerExt = containerFromPath(filePath) || 'mp4';
          const src = buildSource({ item: m, path: filePath, title: m.Name, year, kind: 'movies', containerExt });
          if (!src.source) {
            stats.skippedNoFile += 1;
            continue;
          }
          const poster = fetchImages ? await downloadJellyfinImage(m.Id, 'Primary', imageTag(m, 'Primary')) : '';
          const backdrop = fetchImages ? await downloadJellyfinImage(m.Id, 'Backdrop', imageTag(m, 'Backdrop')) : '';
          if (poster) stats.images += 1;
          const info = insMovie.run(
            String(m.Name || 'Sin título'),
            movieCat,
            src.source,
            poster,
            backdrop,
            String(m.Overview || ''),
            Array.isArray(m.Genres) && m.Genres.length ? String(m.Genres[0]) : 'General',
            year || 2024,
            Number(m.CommunityRating) || 8.0,
            secondsFromTicks(m.RunTimeTicks) || 5400,
            containerExt,
            String(m.Id),
            src.symlink
          );
          const newId = Number(info.lastInsertRowid);
          stats.moviesAdded += 1;
          if (src.symlink) stats.symlinks += 1;
          else if (src.relay) stats.relayed += 1;
          else stats.directUrls += 1;
          newVodIds.push(newId);
        } catch (err) {
          stats.errors.push({ kind: 'movie', title: m.Name, error: err.message });
        }
      }
    }

    if (contentMode !== 'movies' && kind === 'series') {
      const shows = (await fetchSeries(lib.id)).slice(0, maxItems);
      const seriesCat = fallbackVodCat
        ? fallbackVodCat
        : useLibraryAsCategory
          ? ensureCategory(`Jellyfin · ${lib.name}`, 'series')
          : ensureCategory('Jellyfin Series', 'series');

      for (const show of shows) {
        try {
          let seriesRow = findSeriesByExternal.get(String(show.Id));
          let seriesId;
          if (seriesRow) {
            seriesId = Number(seriesRow.id);
            stats.seriesExisting += 1;
          } else {
            const poster = fetchImages ? await downloadJellyfinImage(show.Id, 'Primary', imageTag(show, 'Primary')) : '';
            const backdrop = fetchImages ? await downloadJellyfinImage(show.Id, 'Backdrop', imageTag(show, 'Backdrop')) : '';
            if (poster) stats.images += 1;
            const info = insSeries.run(
              String(show.Name || 'Serie'),
              seriesCat,
              poster,
              backdrop,
              String(show.Overview || ''),
              Array.isArray(show.Genres) && show.Genres.length ? String(show.Genres[0]) : 'Series',
              Number(show.ProductionYear) || 2024,
              Number(show.CommunityRating) || 8.0,
              String(show.Id)
            );
            seriesId = Number(info.lastInsertRowid);
            stats.seriesAdded += 1;
            newSeriesIds.push(seriesId);
          }

          const episodes = await fetchEpisodes(show.Id);
          for (const ep of episodes) {
            const existingEp = findEpisodeByExternal.get(String(ep.Id));
            if (existingEp) {
              stats.episodesExisting += 1;
              continue;
            }
            const filePath = itemPath(ep);
            const season = Math.max(1, Number(ep.ParentIndexNumber) || 1);
            const number = Math.max(1, Number(ep.IndexNumber) || 1);
            const containerExt = containerFromPath(filePath) || 'mp4';
            const src = buildSource({
              item: ep,
              path: filePath,
              title: `${show.Name} - S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`,
              year: null,
              kind: 'series',
              containerExt
            });
            if (!src.source) {
              stats.skippedNoFile += 1;
              continue;
            }
            insEpisode.run(
              seriesId,
              season,
              number,
              String(ep.Name || `Episodio ${number}`),
              src.source,
              String(ep.Overview || ''),
              secondsFromTicks(ep.RunTimeTicks) || 1200,
              containerExt,
              String(ep.Id),
              src.symlink
            );
            stats.episodesAdded += 1;
            if (src.symlink) stats.symlinks += 1;
            else if (src.relay) stats.relayed += 1;
            else stats.directUrls += 1;
          }
        } catch (err) {
          stats.errors.push({ kind: 'series', title: show.Name, error: err.message });
        }
      }
    }
  }

  // Que los clientes puedan verlo ya: se añade al primer paquete.
  const b1 = db.prepare('SELECT * FROM bouquets ORDER BY id ASC LIMIT 1').get();
  if (b1 && (newVodIds.length || newSeriesIds.length)) {
    try {
      const vodArr = Array.from(new Set([...JSON.parse(b1.vod_ids_json || '[]'), ...newVodIds]));
      const srArr = Array.from(new Set([...JSON.parse(b1.series_ids_json || '[]'), ...newSeriesIds]));
      db.prepare('UPDATE bouquets SET vod_ids_json = ?, series_ids_json = ? WHERE id = ?').run(
        JSON.stringify(vodArr),
        JSON.stringify(srArr),
        b1.id
      );
    } catch {
      /* paquete con JSON roto: no bloquea la importación */
    }
  }

  // Carátulas que Jellyfin no tenía: se piden a TMDB si está configurado.
  if (autoTmdb) {
    try {
      const { enrichMissingVodWithTmdb } = await import('./vodSyncTmdb.js');
      const res = await enrichMissingVodWithTmdb({ limit: 60 });
      stats.tmdbEnriched = Number(res?.moviesUpdated || 0) + Number(res?.seriesUpdated || 0);
    } catch {
      /* TMDB es opcional */
    }
  }

  saveJellyfinConfig({ libraries: selected.map((l) => l.id) });
  const summary = { at: new Date().toISOString(), ...stats, errors: stats.errors.slice(0, 20) };
  if (detected && detected.mapping.length) {
    summary.detectedPaths = detected.mapping;
    summary.detectedResolved = detected.resolved;
  }
  if (stats.skippedNoFile > 0 || stats.errors.length) {
    // Diagnóstico para el panel: por qué se quedó fuera cada archivo.
    const reasons = { missing: 0, forbidden: 0, not_a_file: 0 };
    for (const lib of selected) {
      if (contentMode !== 'series' && libraryKind(lib) === 'movies') {
        for (const it of await fetchMovies(lib.id).catch(() => [])) {
          const info = explainLocalMediaPath(itemPath(it));
          if (!info.ok) reasons[info.reason] = (reasons[info.reason] || 0) + 1;
        }
      }
    }
    summary.unreachableReasons = reasons;
    if (!reasons.forbidden && stats.relayed === 0 && stats.symlinks === 0 && stats.directUrls === 0) {
      summary.hint =
        'Jellyfin está en otro servidor y no se activó «Servir desde Jellyfin»: los archivos no están en este disco. ' +
        'Actívalo para retransmitirlos por el panel, o monta el disco de Jellyfin aquí (NFS/SMB) para poder crear enlaces.';
    }
    if (reasons.forbidden > 0) {
      summary.hint =
        'Hay archivos que existen pero el panel no puede leerlos. Ajusta propietario/permisos (chown al usuario del servicio o chmod 644).';
    }
  }
  setSetting('jellyfin_last_import', JSON.stringify(summary));
  return summary;
}

/** Borra los enlaces de un elemento antes de eliminar su fila. */
export function cleanupVodSymlink(vodId) {
  try {
    const row = db.prepare('SELECT symlink_path, source_url FROM vod_items WHERE id = ?').get(Number(vodId));
    const p = row?.symlink_path || (String(row?.source_url || '').startsWith('/') ? row.source_url : '');
    return removeManagedSymlink(p);
  } catch {
    return false;
  }
}

export function cleanupEpisodeSymlink(episodeId) {
  try {
    const row = db.prepare('SELECT symlink_path, source_url FROM series_episodes WHERE id = ?').get(Number(episodeId));
    const p = row?.symlink_path || (String(row?.source_url || '').startsWith('/') ? row.source_url : '');
    return removeManagedSymlink(p);
  } catch {
    return false;
  }
}

/** Enlaces huérfanos de la carpeta VOD (archivo de origen desaparecido). */
export function listBrokenSymlinks() {
  const root = String(getJellyfinConfig().symlinkDir || DEFAULT_SYMLINK_DIR);
  const broken = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isSymbolicLink()) {
        try {
          fs.statSync(full);
        } catch {
          broken.push(full);
        }
      }
    }
  };
  walk(root, 0);
  return broken;
}
