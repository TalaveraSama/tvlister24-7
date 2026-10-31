import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { db } from './db.js';

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.m4v', '.mov', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.flv'
]);

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const TMDB_GENRE_MAP_ES = {
  28: 'Acción',
  12: 'Aventura',
  16: 'Animación',
  35: 'Comedia',
  80: 'Crimen',
  99: 'Documental',
  18: 'Drama',
  10751: 'Familia',
  14: 'Fantasía',
  36: 'Historia',
  27: 'Terror',
  10402: 'Música',
  9648: 'Misterio',
  10749: 'Romance',
  878: 'Ciencia Ficción',
  10770: 'Película de TV',
  53: 'Suspenso',
  10752: 'Bélica',
  37: 'Western',
  10759: 'Acción y Aventura',
  10762: 'Infantil',
  10765: 'Sci-Fi y Fantasía',
  10768: 'Guerra y Política',
};

const NOISE_TOKENS_REGEX = /\b(2160p|1080p|720p|480p|4k|uhd|fhd|hd|bluray|bdrip|brrip|web[-.]?dl|webrip|hdrip|dvdrip|hdtv|remux|x264|x265|h\.?264|h\.?265|hevc|avc|10bit|hdr|hdr10|dv|aac|ac3|eac3|dts|atmos|5\.1|7\.1|dual|latino|castellano|espanol|spanish|subtitulado|subs|sub|proper|repack|extended|unrated|directors\.?cut|yts|rarbg|evo|amax|nf|amzn|dsnp|hmax)\b/gi;

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function getPosterHmacSecret() {
  let sec = getSetting('local_poster_secret', '');
  if (!sec) {
    sec = crypto.randomBytes(24).toString('hex');
    setSetting('local_poster_secret', sec);
  }
  return sec;
}

export function signLocalPosterPath(absImagePath) {
  const p = Buffer.from(absImagePath, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getPosterHmacSecret())
    .update(p)
    .digest('base64url')
    .slice(0, 22);
  return `/vod_local_poster?p=${encodeURIComponent(p)}&sig=${encodeURIComponent(sig)}`;
}

export function verifyLocalPosterPath(p, sig) {
  if (!p || !sig) return null;
  const expected = crypto
    .createHmac('sha256', getPosterHmacSecret())
    .update(String(p))
    .digest('base64url')
    .slice(0, 22);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const decoded = Buffer.from(String(p), 'base64url').toString('utf8');
    const ext = path.extname(decoded).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Normalizes XUI.one & TMDB poster/backdrop strings into playable browser/STB URLs:
 *   1) Full http(s):// URLs -> unchanged
 *   2) XUI local macros (`s:0:/images/x.jpg`, `<<URL>>/images/x.jpg`, `/home/xui/wwwdir/images/x.jpg`, `images/x.jpg`)
 *      -> `/xui_images/x.jpg`
 *   3) Bare TMDB image paths (`/abc123.jpg`) -> `https://image.tmdb.org/t/p/w500/abc123.jpg`
 */
export function normalizeXuiOrTmdbImageUrl(rawImg, kind = 'poster') {
  if (!rawImg || typeof rawImg !== 'string') return '';
  let val = rawImg.trim();
  if (!val || val === 'null' || val === 'undefined') return '';

  // Strip XUI server prefix like `s:0:` or `<<URL>>`
  val = val.replace(/^s:\d+:/i, '').replace(/^<<URL>>/i, '').trim();

  if (/^https?:\/\//i.test(val) || val.startsWith('/vod_local_poster') || val.startsWith('/xui_images/')) {
    return val;
  }

  // XUI.one local wwwdir images
  const xuiMatch = val.match(/(?:\/home\/xui\/(?:wwwdir|content)\/images\/|^\/?images\/)([^/?#]+)$/i);
  if (xuiMatch) {
    return `/xui_images/${encodeURIComponent(xuiMatch[1])}`;
  }

  // Bare TMDB path like `/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg`
  if (/^\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(val)) {
    const size = kind === 'backdrop' ? 'w1280' : 'w500';
    return `https://image.tmdb.org/t/p/${size}${val}`;
  }

  return val;
}

export function resolvePublicPosterUrl(posterUrl, baseUrl = '') {
  if (!posterUrl) return '';
  const norm = normalizeXuiOrTmdbImageUrl(posterUrl, 'poster');
  if (norm.startsWith('/') && baseUrl) {
    return `${baseUrl.replace(/\/+$/, '')}${norm}`;
  }
  return norm;
}

// ==================== TMDB (themoviedb.org) ENGINE ====================

export function getTmdbConfig() {
  const key = getSetting('tmdb_api_key', '');
  const language = getSetting('tmdb_language', 'es-MX') || 'es-MX';
  return {
    configured: Boolean(key && key.trim().length >= 16),
    apiKeyMasked: key ? `${key.slice(0, 4)}${'•'.repeat(8)}${key.slice(-4)}` : '',
    apiKey: key,
    language,
  };
}

export function saveTmdbConfig({ apiKey, language }) {
  if (apiKey !== undefined) {
    setSetting('tmdb_api_key', String(apiKey).trim());
  }
  if (language) {
    setSetting('tmdb_language', String(language).trim());
  }
  return getTmdbConfig();
}

async function tmdbRequest(endpoint, queryParams = {}) {
  const { apiKey, language } = getTmdbConfig();
  if (!apiKey) {
    throw new Error('Configura primero tu API Key de TMDB (themoviedb.org) en el botón "Configurar TMDB".');
  }

  const isBearerV4 = apiKey.startsWith('eyJ') || apiKey.length > 60;
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  if (!isBearerV4) {
    url.searchParams.set('api_key', apiKey);
  }
  url.searchParams.set('language', queryParams.language || language || 'es-MX');
  for (const [k, v] of Object.entries(queryParams)) {
    if (k !== 'language' && v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const headers = { Accept: 'application/json' };
  if (isBearerV4) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const resp = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error('API Key o Token de TMDB inválido (HTTP 401). Verifica tu clave en themoviedb.org/settings/api.');
    }
    throw new Error(`Error consultando TMDB (HTTP ${resp.status})`);
  }
  return resp.json();
}

export async function testTmdbConnection() {
  await tmdbRequest('/configuration');
  return { ok: true };
}

function mapTmdbItem(item, mediaType = 'movie') {
  const isTv = mediaType === 'tv' || Boolean(item.name && !item.title);
  const title = (isTv ? item.name || item.original_name : item.title || item.original_title) || '';
  const dateStr = (isTv ? item.first_air_date : item.release_date) || '';
  const yearMatch = dateStr.match(/^(\d{4})/);
  const genres = Array.isArray(item.genre_ids)
    ? item.genre_ids.map((id) => TMDB_GENRE_MAP_ES[id]).filter(Boolean)
    : [];

  return {
    tmdb_id: String(item.id || ''),
    media_type: isTv ? 'series' : 'movie',
    title,
    original_title: (isTv ? item.original_name : item.original_title) || title,
    release_year: yearMatch ? Number(yearMatch[1]) : 2024,
    rating: item.vote_average ? Number(Number(item.vote_average).toFixed(1)) : 8.0,
    genre: genres.length > 0 ? genres.slice(0, 3).join(', ') : 'General',
    plot: String(item.overview || '').trim(),
    poster_url: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
    backdrop_url: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : '',
  };
}

export async function searchTmdb({ query, type = 'movie', year = null }) {
  const q = String(query || '').trim();
  if (!q) return [];
  const endpoint = type === 'series' || type === 'tv' ? '/search/tv' : '/search/movie';
  const params = { query: q, include_adult: 'false' };
  if (year && Number(year) >= 1900) {
    if (endpoint === '/search/tv') params.first_air_date_year = Number(year);
    else params.year = Number(year);
  }

  let data = await tmdbRequest(endpoint, params);
  let results = Array.isArray(data?.results) ? data.results : [];

  // Fallback without strict year filter if 0 results returned
  if (results.length === 0 && year) {
    delete params.year;
    delete params.first_air_date_year;
    data = await tmdbRequest(endpoint, params);
    results = Array.isArray(data?.results) ? data.results : [];
  }

  return results.slice(0, 12).map((r) => mapTmdbItem(r, endpoint === '/search/tv' ? 'tv' : 'movie'));
}

export async function enrichMissingVodWithTmdb({ overwriteAll = false, limit = 150 } = {}) {
  const cfg = getTmdbConfig();
  if (!cfg.configured) {
    throw new Error('Primero guarda tu API Key de TMDB (themoviedb.org) para descargar carátulas y sinopsis.');
  }

  const movies = overwriteAll
    ? db.prepare('SELECT * FROM vod_items ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare("SELECT * FROM vod_items WHERE poster_url IS NULL OR poster_url = '' OR plot IS NULL OR plot = '' ORDER BY id DESC LIMIT ?").all(limit);

  const seriesRows = overwriteAll
    ? db.prepare('SELECT * FROM series ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare("SELECT * FROM series WHERE poster_url IS NULL OR poster_url = '' OR plot IS NULL OR plot = '' ORDER BY id DESC LIMIT ?").all(limit);

  let moviesUpdated = 0;
  let seriesUpdated = 0;

  const updMovie = db.prepare(`
    UPDATE vod_items
       SET poster_url = COALESCE(NULLIF(?, ''), poster_url),
           backdrop_url = COALESCE(NULLIF(?, ''), backdrop_url),
           plot = COALESCE(NULLIF(?, ''), plot),
           genre = COALESCE(NULLIF(?, ''), genre),
           release_year = ?,
           rating = ?,
           tmdb_id = ?
     WHERE id = ?
  `);

  for (const m of movies) {
    try {
      const cleaned = cleanTitleString(m.title);
      const hits = await searchTmdb({ query: cleaned.title, type: 'movie', year: cleaned.year || m.release_year });
      if (hits.length > 0) {
        const best = hits[0];
        updMovie.run(
          best.poster_url,
          best.backdrop_url,
          best.plot,
          best.genre,
          best.release_year || m.release_year || 2024,
          best.rating || m.rating || 8.0,
          best.tmdb_id,
          m.id
        );
        moviesUpdated++;
      }
    } catch {
      // continue on individual title lookup failure
    }
  }

  const updSeries = db.prepare(`
    UPDATE series
       SET poster_url = COALESCE(NULLIF(?, ''), poster_url),
           backdrop_url = COALESCE(NULLIF(?, ''), backdrop_url),
           plot = COALESCE(NULLIF(?, ''), plot),
           genre = COALESCE(NULLIF(?, ''), genre),
           release_year = ?,
           rating = ?,
           tmdb_id = ?
     WHERE id = ?
  `);

  for (const sr of seriesRows) {
    try {
      const cleaned = cleanTitleString(sr.title);
      const hits = await searchTmdb({ query: cleaned.title, type: 'series', year: cleaned.year || sr.release_year });
      if (hits.length > 0) {
        const best = hits[0];
        updSeries.run(
          best.poster_url,
          best.backdrop_url,
          best.plot,
          best.genre,
          best.release_year || sr.release_year || 2024,
          best.rating || sr.rating || 8.0,
          best.tmdb_id,
          sr.id
        );
        seriesUpdated++;
      }
    } catch {
      // continue
    }
  }

  return {
    moviesChecked: movies.length,
    moviesUpdated,
    seriesChecked: seriesRows.length,
    seriesUpdated,
  };
}

// ==================== LOCAL MEDIA FOLDER SCANNER & WATCH-SYNC ====================

export function cleanTitleString(rawName) {
  let s = String(rawName || '');
  // Strip extension if present
  s = s.replace(/\.[a-z0-9]{2,4}$/i, '');
  // Strip bracketed release tags like [1080p] [Dual] {TMDB-123}
  s = s.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');

  // Extract year (1920..2035) if in parens or standalone before quality tags
  let year = null;
  const parenYear = s.match(/\((\s*(?:19\d{2}|20[0-3]\d)\s*)\)/);
  if (parenYear) {
    year = Number(parenYear[1].trim());
    s = s.slice(0, parenYear.index) + ' ' + s.slice(parenYear.index + parenYear[0].length);
  } else {
    const dotYear = s.match(/[._\s-](19\d{2}|20[0-3]\d)(?:[._\s-]|$)/);
    if (dotYear && dotYear.index > 1) {
      year = Number(dotYear[1]);
      s = s.slice(0, dotYear.index);
    }
  }

  s = s.replace(/[._]+/g, ' ');
  s = s.replace(NOISE_TOKENS_REGEX, ' ');
  s = s.replace(/\(\s*\)/g, ' ').replace(/\s*-\s*$/g, '').replace(/\s+/g, ' ').trim();

  return { title: s || rawName, year };
}

function findSidecarPoster(videoFilePath) {
  const dir = path.dirname(videoFilePath);
  const baseNoExt = path.basename(videoFilePath, path.extname(videoFilePath));

  // 1. Exact matching image next to video: MovieName.jpg / MovieName-poster.jpg
  for (const ext of IMAGE_EXTENSIONS) {
    for (const candidateName of [`${baseNoExt}${ext}`, `${baseNoExt}-poster${ext}`, `poster${ext}`, `cover${ext}`, `folder${ext}`]) {
      const fullImg = path.join(dir, candidateName);
      if (fs.existsSync(fullImg)) {
        return signLocalPosterPath(fullImg);
      }
    }
  }
  return '';
}

function probeVideoDurationSec(filePath, fileSizeBytes = 0) {
  // Fast probe if ffprobe exists
  for (const bin of ['/opt/tvlister24-7/.runtime/bin/ffprobe', '/home/xui/bin/ffmpeg/ffprobe', '/usr/bin/ffprobe', 'ffprobe']) {
    try {
      const out = execFileSync(
        bin,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
        { timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }
      )
        .toString('utf8')
        .trim();
      const secs = Math.round(parseFloat(out));
      if (Number.isFinite(secs) && secs > 0) return secs;
      break;
    } catch {
      // try next or fallback
    }
  }
  // Fallback estimate (~2.2 Mbps average VOD bitrate)
  if (fileSizeBytes > 0) {
    return Math.max(600, Math.min(14400, Math.round((fileSizeBytes * 8) / (2.2 * 1000 * 1000))));
  }
  return 5400;
}

export function parseMediaFileEntry(fullPath, rootFolder, contentMode = 'auto') {
  const ext = path.extname(fullPath).toLowerCase();
  const containerExt = ext.replace(/^\./, '') || 'mp4';
  const fileNameNoExt = path.basename(fullPath, ext);
  const relDir = path.relative(rootFolder, path.dirname(fullPath));
  const pathParts = relDir && relDir !== '.' ? relDir.split(path.sep).filter(Boolean) : [];

  // Detect S01E02 or 1x02 series pattern
  const seMatch =
    fileNameNoExt.match(/^(.*?)[._\s-]*[Ss](\d{1,2})[._\s-]*[Ee](\d{1,3})(?:[._\s-]+(.*))?$/) ||
    fileNameNoExt.match(/^(.*?)[._\s-]+(\d{1,2})x(\d{2,3})(?:[._\s-]+(.*))?$/);

  const isSeries = contentMode === 'series' || (contentMode === 'auto' && Boolean(seMatch));

  if (isSeries) {
    const seasonNum = seMatch ? Math.max(1, Number(seMatch[2])) : 1;
    const episodeNum = seMatch ? Math.max(1, Number(seMatch[3])) : 1;
    const rawSeriesFromFilename = seMatch?.[1] ? cleanTitleString(seMatch[1]).title : '';
    // If organized as /SeriesRoot/Category?/ShowName/Season 1/S01E01.mp4, infer ShowName from folder if filename only had S01E01
    let seriesTitle = rawSeriesFromFilename;
    if (!seriesTitle && pathParts.length > 0) {
      const nonSeasonFolders = pathParts.filter((p) => !/^(season|temporada|temp|s)\s*\d+$/i.test(p));
      seriesTitle = cleanTitleString(nonSeasonFolders[nonSeasonFolders.length - 1] || pathParts[0]).title;
    }
    if (!seriesTitle) seriesTitle = cleanTitleString(fileNameNoExt).title;

    const epSubTitle = seMatch?.[4] ? cleanTitleString(seMatch[4]).title : `Episodio ${episodeNum}`;
    const subfolderCategory = pathParts.length >= 2 ? pathParts[0] : '';

    return {
      kind: 'series_episode',
      fullPath,
      containerExt,
      seriesTitle,
      seasonNum,
      episodeNum,
      episodeTitle: epSubTitle || `Episodio ${episodeNum}`,
      subfolderCategory,
      sidecarPoster: findSidecarPoster(fullPath),
    };
  }

  const { title, year } = cleanTitleString(fileNameNoExt);
  // If file is inside a Movie-per-Folder layout (e.g. /mnt/movies/Accion/Gladiator (2000)/movie.mp4)
  let finalTitle = title;
  let finalYear = year;
  let subfolderCategory = pathParts[0] || '';

  if (/^(movie|video|film|pelicula|stream|\d+)$/i.test(finalTitle) && pathParts.length > 0) {
    const parentParsed = cleanTitleString(pathParts[pathParts.length - 1]);
    finalTitle = parentParsed.title;
    finalYear = finalYear || parentParsed.year;
    subfolderCategory = pathParts.length >= 2 ? pathParts[0] : '';
  }

  return {
    kind: 'movie',
    fullPath,
    containerExt,
    title: finalTitle,
    year: finalYear || 2024,
    subfolderCategory,
    sidecarPoster: findSidecarPoster(fullPath),
  };
}

export function scanMediaDirectoryFiles(rootFolder, contentMode = 'auto', maxFiles = 5000) {
  const resolvedRoot = path.resolve(String(rootFolder || '').trim());
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`La carpeta "${resolvedRoot}" no existe en el servidor.`);
  }
  const st = fs.statSync(resolvedRoot);
  if (!st.isDirectory()) {
    throw new Error(`La ruta "${resolvedRoot}" no es un directorio.`);
  }

  const found = [];

  function walk(currentDir, depth) {
    if (depth > 5 || found.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            size = 0;
          }
          const parsed = parseMediaFileEntry(full, resolvedRoot, contentMode);
          found.push({ ...parsed, sizeBytes: size });
          if (found.length >= maxFiles) return;
        }
      }
    }
  }

  walk(resolvedRoot, 0);
  return { rootFolder: resolvedRoot, files: found };
}

export function browseServerDirectories(baseDir = '/') {
  const target = path.resolve(String(baseDir || '/').trim() || '/');
  if (!fs.existsSync(target)) {
    throw new Error(`Directorio no encontrado: ${target}`);
  }
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const dirs = [];
  let mediaFilesCount = 0;

  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) {
      dirs.push({
        name: ent.name,
        path: path.join(target, ent.name),
      });
    } else if (VIDEO_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
      mediaFilesCount++;
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return {
    currentPath: target,
    parentPath: target === '/' ? null : path.dirname(target),
    mediaFilesInCurrent: mediaFilesCount,
    directories: dirs.slice(0, 200),
  };
}

export async function syncLocalVodFolder({
  folderPath,
  contentMode = 'auto',
  defaultCategoryId = null,
  useSubfoldersAsCategories = true,
  autoTmdb = true,
  autoSyncMinutes = 0,
  removeMissing = false,
  saveWatchFolder = true,
}) {
  const { rootFolder, files } = scanMediaDirectoryFiles(folderPath, contentMode);
  const tmdbCfg = getTmdbConfig();
  const shouldFetchTmdb = Boolean(autoTmdb && tmdbCfg.configured);

  const findCat = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1');
  const insCat = db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, 50)');

  const ensureCategory = (name, type = 'vod') => {
    const clean = String(name || '').trim() || (type === 'series' ? 'Series Locales' : 'Películas Locales');
    const existing = findCat.get(clean, type);
    if (existing) return Number(existing.id);
    const res = insCat.run(clean, type);
    return Number(res.lastInsertRowid);
  };

  const fallbackVodCat = defaultCategoryId ? Number(defaultCategoryId) : ensureCategory('Películas en Disco', 'vod');
  const fallbackSeriesCat = defaultCategoryId ? Number(defaultCategoryId) : ensureCategory('Series en Disco', 'series');

  const stats = {
    rootFolder,
    scannedFiles: files.length,
    moviesAdded: 0,
    moviesExisting: 0,
    seriesAdded: 0,
    episodesAdded: 0,
    episodesExisting: 0,
    removedMissing: 0,
    tmdbEnriched: 0,
  };

  const newVodIds = [];
  const newSeriesIds = [];
  const newlyInsertedMoviesForTmdb = [];
  const newlyInsertedSeriesForTmdb = [];

  db.exec('BEGIN IMMEDIATE;');
  try {
    const findMovieByPath = db.prepare('SELECT id, poster_url FROM vod_items WHERE source_url = ? LIMIT 1');
    const insMovie = db.prepare(`
      INSERT INTO vod_items (
        title, type, category_id, source_url, poster_url, backdrop_url,
        plot, genre, release_year, rating, duration_sec, container_ext
      ) VALUES (?, 'movie', ?, ?, ?, '', '', 'General', ?, 8.0, ?, ?)
    `);

    const findSeriesByTitle = db.prepare('SELECT id, poster_url FROM series WHERE LOWER(title) = LOWER(?) LIMIT 1');
    const insSeries = db.prepare(`
      INSERT INTO series (title, category_id, poster_url, backdrop_url, plot, genre, release_year, rating)
      VALUES (?, ?, ?, '', '', 'Series', 2024, 8.2)
    `);
    const findEpByPath = db.prepare('SELECT id FROM series_episodes WHERE source_url = ? LIMIT 1');
    const insEp = db.prepare(`
      INSERT INTO series_episodes (series_id, season_num, episode_num, title, source_url, plot, duration_sec, container_ext)
      VALUES (?, ?, ?, ?, ?, '', ?, ?)
    `);

    for (const item of files) {
      if (item.kind === 'movie') {
        const existing = findMovieByPath.get(item.fullPath);
        if (existing) {
          stats.moviesExisting++;
          if (!existing.poster_url && item.sidecarPoster) {
            db.prepare('UPDATE vod_items SET poster_url = ? WHERE id = ?').run(item.sidecarPoster, existing.id);
          }
          continue;
        }

        const catId =
          useSubfoldersAsCategories && item.subfolderCategory
            ? ensureCategory(item.subfolderCategory, 'vod')
            : fallbackVodCat;

        const dur = probeVideoDurationSec(item.fullPath, item.sizeBytes);
        const info = insMovie.run(
          item.title,
          catId,
          item.fullPath,
          item.sidecarPoster || '',
          item.year || 2024,
          dur,
          item.containerExt
        );
        const newId = Number(info.lastInsertRowid);
        stats.moviesAdded++;
        newVodIds.push(newId);
        newlyInsertedMoviesForTmdb.push({ id: newId, title: item.title, year: item.year });
      } else {
        // series_episode
        const existingEp = findEpByPath.get(item.fullPath);
        if (existingEp) {
          stats.episodesExisting++;
          continue;
        }

        let sr = findSeriesByTitle.get(item.seriesTitle);
        let seriesId;
        if (sr) {
          seriesId = Number(sr.id);
        } else {
          const catId =
            useSubfoldersAsCategories && item.subfolderCategory
              ? ensureCategory(item.subfolderCategory, 'series')
              : fallbackSeriesCat;
          const sInfo = insSeries.run(item.seriesTitle, catId, item.sidecarPoster || '');
          seriesId = Number(sInfo.lastInsertRowid);
          stats.seriesAdded++;
          newSeriesIds.push(seriesId);
          newlyInsertedSeriesForTmdb.push({ id: seriesId, title: item.seriesTitle });
        }

        const dur = probeVideoDurationSec(item.fullPath, item.sizeBytes);
        insEp.run(
          seriesId,
          item.seasonNum,
          item.episodeNum,
          item.episodeTitle,
          item.fullPath,
          dur,
          item.containerExt
        );
        stats.episodesAdded++;
      }
    }

    if (removeMissing) {
      const prefix = rootFolder.endsWith(path.sep) ? rootFolder : `${rootFolder}${path.sep}`;
      const localMovies = db
        .prepare('SELECT id, source_url FROM vod_items WHERE source_url LIKE ?')
        .all(`${prefix}%`);
      for (const m of localMovies) {
        if (!fs.existsSync(m.source_url)) {
          db.prepare('DELETE FROM vod_items WHERE id = ?').run(m.id);
          stats.removedMissing++;
        }
      }
      const localEps = db
        .prepare('SELECT id, source_url FROM series_episodes WHERE source_url LIKE ?')
        .all(`${prefix}%`);
      for (const ep of localEps) {
        if (!fs.existsSync(ep.source_url)) {
          db.prepare('DELETE FROM series_episodes WHERE id = ?').run(ep.id);
          stats.removedMissing++;
        }
      }
    }

    // Auto-attach newly added VOD/Series to Bouquet #1 if present so lines can watch immediately
    const b1 = db.prepare('SELECT * FROM bouquets ORDER BY id ASC LIMIT 1').get();
    if (b1 && (newVodIds.length > 0 || newSeriesIds.length > 0)) {
      const vodArr = Array.from(new Set([...JSON.parse(b1.vod_ids_json || '[]'), ...newVodIds]));
      const srArr = Array.from(new Set([...JSON.parse(b1.series_ids_json || '[]'), ...newSeriesIds]));
      db.prepare('UPDATE bouquets SET vod_ids_json = ?, series_ids_json = ? WHERE id = ?').run(
        JSON.stringify(vodArr),
        JSON.stringify(srArr),
        b1.id
      );
    }

    if (saveWatchFolder) {
      const summaryText = `+${stats.moviesAdded} películas, +${stats.episodesAdded} episodios (${stats.scannedFiles} archivos)`;
      db.prepare(`
        INSERT INTO vod_watch_folders (
          folder_path, content_mode, default_category_id, use_subfolders_as_categories,
          auto_tmdb, auto_sync_minutes, remove_missing, last_scan_at, last_scan_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(folder_path) DO UPDATE SET
          content_mode = excluded.content_mode,
          default_category_id = excluded.default_category_id,
          use_subfolders_as_categories = excluded.use_subfolders_as_categories,
          auto_tmdb = excluded.auto_tmdb,
          auto_sync_minutes = excluded.auto_sync_minutes,
          remove_missing = excluded.remove_missing,
          last_scan_at = datetime('now'),
          last_scan_summary = excluded.last_scan_summary
      `).run(
        rootFolder,
        contentMode,
        defaultCategoryId ? Number(defaultCategoryId) : null,
        useSubfoldersAsCategories ? 1 : 0,
        autoTmdb ? 1 : 0,
        Math.max(0, Number(autoSyncMinutes) || 0),
        removeMissing ? 1 : 0,
        summaryText
      );
    }

    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }

  // Outside SQLite transaction: enrich newly discovered movies & series against TMDB (up to 60 per sync pass)
  if (shouldFetchTmdb && (newlyInsertedMoviesForTmdb.length > 0 || newlyInsertedSeriesForTmdb.length > 0)) {
    const updM = db.prepare(`
      UPDATE vod_items
         SET poster_url = COALESCE(NULLIF(?, ''), poster_url),
             backdrop_url = ?, plot = ?, genre = ?, release_year = ?, rating = ?, tmdb_id = ?
       WHERE id = ?
    `);
    for (const m of newlyInsertedMoviesForTmdb.slice(0, 60)) {
      try {
        const hits = await searchTmdb({ query: m.title, type: 'movie', year: m.year });
        if (hits.length > 0) {
          const b = hits[0];
          updM.run(b.poster_url, b.backdrop_url, b.plot, b.genre, b.release_year || m.year, b.rating, b.tmdb_id, m.id);
          stats.tmdbEnriched++;
        }
      } catch {
        // ignore single lookup error
      }
    }

    const updS = db.prepare(`
      UPDATE series
         SET poster_url = COALESCE(NULLIF(?, ''), poster_url),
             backdrop_url = ?, plot = ?, genre = ?, release_year = ?, rating = ?, tmdb_id = ?
       WHERE id = ?
    `);
    for (const s of newlyInsertedSeriesForTmdb.slice(0, 30)) {
      try {
        const hits = await searchTmdb({ query: s.title, type: 'series' });
        if (hits.length > 0) {
          const b = hits[0];
          updS.run(b.poster_url, b.backdrop_url, b.plot, b.genre, b.release_year || 2024, b.rating, b.tmdb_id, s.id);
          stats.tmdbEnriched++;
        }
      } catch {
        // ignore
      }
    }
  }

  return stats;
}

export function listWatchFolders() {
  return db.prepare('SELECT * FROM vod_watch_folders ORDER BY id DESC').all();
}

export function deleteWatchFolder(id) {
  db.prepare('DELETE FROM vod_watch_folders WHERE id = ?').run(Number(id));
}

export function startVodFolderAutoSyncScheduler() {
  setInterval(async () => {
    try {
      const folders = db
        .prepare(
          `SELECT * FROM vod_watch_folders
           WHERE auto_sync_minutes > 0
             AND (
               last_scan_at IS NULL
               OR (strftime('%s', 'now') - strftime('%s', last_scan_at)) >= (auto_sync_minutes * 60)
             )`
        )
        .all();

      for (const f of folders) {
        if (fs.existsSync(f.folder_path)) {
          await syncLocalVodFolder({
            folderPath: f.folder_path,
            contentMode: f.content_mode,
            defaultCategoryId: f.default_category_id,
            useSubfoldersAsCategories: Boolean(f.use_subfolders_as_categories),
            autoTmdb: Boolean(f.auto_tmdb),
            autoSyncMinutes: f.auto_sync_minutes,
            removeMissing: Boolean(f.remove_missing),
            saveWatchFolder: true,
          });
        }
      }
    } catch {
      // ignore transient scan error
    }
  }, 60 * 1000).unref();
}
