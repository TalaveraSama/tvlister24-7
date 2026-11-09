import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { db } from './db.js';

const RUNTIME_BIN_DIR = path.join(process.env.APP_DIR || '/opt/tvlister24-7', '.runtime', 'bin');

// Margen de seguridad antes de que caduque la URL de YouTube (suele durar ~6 h).
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
// Si el servidor no dice cuándo caduca, se renueva cada 30 minutos.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
// Una señal que no está en directo se vuelve a mirar cada 5 minutos (puede empezar).
// Sin señal se reintenta cada 5 min (configurable para pruebas).
const OFF_AIR_RECHECK_MS = Math.max(3000, Number(process.env.TVLISTER_LIVE_OFFAIR_RECHECK_MS || 5 * 60 * 1000) || 300000);

// Una lista de YouTube puede tener cientos de vídeos: se toman los primeros.
// (Cada entrada se resuelve por separado y encarece el arranque del canal.)
export const MAX_PLAYLIST_ITEMS = 30;
// Techo de calidad para los vídeos sueltos: más de 1080p sólo gasta CPU y ancho de banda.
const MAX_VIDEO_HEIGHT = 1080;
// Tiempo máximo para leer una lista completa (cada vídeo se resuelve dentro).
const PLAYLIST_TIMEOUT_MS = 240000;

function getSetting(key) {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '');
  } catch {
    return '';
  }
}

function setSetting(key, value) {
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  } catch {
    /* no crítico */
  }
}

// ============================================================================
// BINARIO yt-dlp
// ============================================================================
export function ytDlpCandidates() {
  const list = [];
  const configured = getSetting('ytdlp_path') || process.env.TVLISTER_YTDLP || '';
  if (configured) list.push(configured);
  list.push(
    path.join(RUNTIME_BIN_DIR, 'yt-dlp'),
    '/opt/tvlister24-7/.runtime/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp'
  );
  return list;
}

export function findYtDlp() {
  for (const candidate of ytDlpCandidates()) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      // Nombre suelto: sólo vale si de verdad está en el PATH. Si no, se sigue
      // buscando para no decir «está en el sistema pero no arranca» cuando lo
      // que pasa es que no hay yt-dlp.
      const dirs = String(process.env.PATH || '').split(path.delimiter);
      if (dirs.some((dir) => dir && fs.existsSync(path.join(dir, candidate)))) return candidate;
    }
  }
  return '';
}

function runBinary(bin, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          killed: error?.killed === true,
          stdout: String(stdout || ''),
          stderr: String(stderr || '')
        });
      }
    );
  });
}

/**
 * Cookies de YouTube (opcional). En servidores de datacenter YouTube suele
 * pedir «confirma que no eres un robot»; con un archivo de cookies exportado
 * de un navegador, yt-dlp lo resuelve. Sólo se devuelve la ruta.
 */
export function cookiesInfo() {
  const p = String(getSetting('youtube_cookies_file') || process.env.TVLISTER_YT_COOKIES || '').trim();
  return { path: p, exists: Boolean(p && fs.existsSync(p)) };
}

export async function getYtDlpInfo() {
  const bin = findYtDlp();
  if (!bin) {
    return {
      installed: false,
      bin: '',
      version: '',
      hint:
        'Falta yt-dlp. Instálalo con «Instalar yt-dlp» (descarga el binario oficial, sin apt) ' +
        'o a mano: sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp ' +
        `-o ${path.join(RUNTIME_BIN_DIR, 'yt-dlp')} \u0026\u0026 sudo chmod +x ${path.join(RUNTIME_BIN_DIR, 'yt-dlp')}`
    };
  }
  const res = await runBinary(bin, ['--version'], { timeoutMs: 15000 });
  return {
    installed: res.ok,
    bin,
    version: res.ok ? res.stdout.trim().split('\n')[0] : '',
    error: res.ok ? '' : String(res.stderr || 'no se pudo ejecutar yt-dlp').slice(0, 300),
    hint: res.ok ? '' : 'yt-dlp está en el sistema pero no arranca (revisa python3 o reinstálalo).'
  };
}

/**
 * Descarga el binario oficial de yt-dlp en .runtime/bin (sin apt, sin root para
 * el panel: el proceso corre como el servicio). No toca nada del sistema.
 */
export async function installYtDlp() {
  fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
  const target = path.join(RUNTIME_BIN_DIR, 'yt-dlp');
  const tmp = `${target}.tmp.${Date.now()}`;
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  const dl = await runBinary('curl', ['-fsSL', '--max-time', '120', url, '-o', tmp], { timeoutMs: 130000 });
  if (!dl.ok || !fs.existsSync(tmp)) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error:
        'No se pudo descargar yt-dlp desde GitHub (¿sin salida a Internet?). ' +
        'Descárgalo en tu PC y cópialo a ' + target
    };
  }
  try {
    fs.copyFileSync(tmp, target);
    fs.chmodSync(target, 0o755);
    fs.unlinkSync(tmp);
  } catch (err) {
    return { ok: false, error: `No se pudo dejar el binario en ${target}: ${err.message}` };
  }
  const check = await runBinary(target, ['--version'], { timeoutMs: 30000 });
  if (!check.ok) {
    return {
      ok: false,
      path: target,
      error:
        'yt-dlp se descargó pero no arranca (necesita python3 ≥ 3.9). Instala python3 y vuelve a probar: ' +
        String(check.stderr || '').slice(0, 200)
    };
  }
  setSetting('ytdlp_path', target);
  const version = check.stdout.trim().split('\n')[0];
  setSetting('ytdlp_version', version);
  return { ok: true, path: target, version };
}

// ============================================================================
// URL de origen
// ============================================================================
const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);

export function isYouTubeUrl(raw = '') {
  try {
    const u = new URL(String(raw).trim());
    return YT_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Qué es y qué se puede esperar de la URL pegada.
 *  · kind 'live'    → /live/<id>, youtu.be/<id>, /@canal/live, /channel/UC…/live
 *  · kind 'video'   → watch?v=… o /shorts/… (se emite en bucle, 24/7)
 *  · kind 'playlist'→ /playlist?list=… (todos sus vídeos en orden y vuelta a empezar)
 *  · kind 'channel' → /@canal o /channel/UC… (se resuelve su directo actual)
 */
export function parseYouTubeUrl(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Falta la URL de YouTube.' };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: 'No es una URL válida. Pega el enlace del directo de YouTube.' };
  }
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) {
    return { ok: false, error: `«${host}» no es YouTube. Pega un enlace de youtube.com o youtu.be.` };
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (host.endsWith('youtu.be')) {
    const id = parts[0] || '';
    return id ? { ok: true, kind: 'live', video_id: id, url: text } : { ok: false, error: 'Enlace youtu.be sin ID.' };
  }
  // Lista de reproducción completa: /playlist?list=PL…
  if (parts[0] === 'playlist') {
    const list = u.searchParams.get('list') || '';
    if (!list) return { ok: false, error: 'El enlace de la lista no trae el parámetro list.' };
    return { ok: true, kind: 'playlist', list_id: list, url: `https://www.youtube.com/playlist?list=${list}` };
  }
  if (parts[0] === 'live' && parts[1]) {
    return { ok: true, kind: 'live', video_id: parts[1], url: text };
  }
  if (parts[0] === 'embed' && parts[1]) {
    return { ok: true, kind: 'live', video_id: parts[1], url: text };
  }
  if (parts[0] === 'watch') {
    const v = u.searchParams.get('v') || '';
    if (!v) {
      // watch?list=… sin vídeo: es la lista.
      const list = u.searchParams.get('list') || '';
      if (list) return { ok: true, kind: 'playlist', list_id: list, url: `https://www.youtube.com/playlist?list=${list}` };
      return { ok: false, error: 'El enlace «watch» no trae el parámetro v.' };
    }
    return { ok: true, kind: 'video', video_id: v, url: text };
  }
  if (parts[0] === 'shorts' && parts[1]) {
    return { ok: true, kind: 'video', video_id: parts[1], url: text };
  }
  if (parts[0] === 'channel' && parts[1]) {
    // https://www.youtube.com/channel/UC…/live
    return { ok: true, kind: parts[2] === 'live' ? 'live' : 'channel', channel_id: parts[1], url: text };
  }
  if (parts[0]?.startsWith('@')) {
    const clean = `https://www.youtube.com/${parts[0]}${parts[1] === 'live' ? '/live' : ''}`;
    return { ok: true, kind: parts[1] === 'live' ? 'live' : 'channel', handle: parts[0], url: clean };
  }
  return {
    ok: false,
    error:
      'No reconozco ese enlace de YouTube. Sirven el del directo (…/live/…, /@canal/live), un vídeo ' +
      '(watch?v=…, youtu.be/…) o una lista completa (playlist?list=…).'
  };
}

/**
 * Normaliza lo que se pega y decide el proveedor.
 * Devuelve { provider: 'youtube' | 'hls', url, note }.
 */
export function classifySourceUrl(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Falta la URL de la señal.' };
  if (/\.m3u8(\?|$)/i.test(text) && !isYouTubeUrl(text)) {
    return { ok: true, provider: 'hls', url: text, note: 'HLS en vivo (sin resolución de YouTube)' };
  }
  const yt = parseYouTubeUrl(text);
  if (!yt.ok) return yt;
  // Enlace de canal sin /live: se le añade para pedir su directo actual.
  return { ok: true, provider: 'youtube', url: yt.url, kind: yt.kind };
}

// ============================================================================
// RESOLUCIÓN del directo
// ============================================================================
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function expiryOf(url) {
  try {
    const u = new URL(url);
    for (const key of ['expire', 'expires', 'exp']) {
      const v = Number(u.searchParams.get(key));
      if (Number.isFinite(v) && v > 1e9) return v * 1000;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * Elige la fuente del directo pensando en **copiar sin recodificar** (copy/copy).
 *
 * YouTube puede dar el directo de tres formas:
 *   · `manifest_url` → manifiesto MAESTRO: trae la lista de variantes y el grupo
 *     de audio, así que FFmpeg elige vídeo y audio solo y `-c copy` funciona.
 *   · una pista ya mezclada (muxed, HLS con audio y vídeo) → `-c copy` también.
 *   · vídeo y audio en pistas SEPARADAS (habitual en directos DASH/HLS) → hay
 *     que abrir las dos y mapearlas, o el canal se queda sin sonido.
 *
 * Devuelve `{ url, audio_url, kind, from, headers }`; `audio_url` sólo viene
 * cuando el audio va por su cuenta.
 */
function pickHls(info) {
  const headersOf = (f) => pickHeaders(f?.http_headers || info?.http_headers || {});

  const manifest = String(info?.manifest_url || '');
  if (/m3u8|hls/i.test(manifest)) {
    return { url: manifest, audio_url: '', kind: 'master', from: 'manifest_url', headers: headersOf(info) };
  }

  const formats = Array.isArray(info?.formats) ? info.formats : [];
  if (!formats.length) {
    if (/\.m3u8(\?|$)/i.test(String(info?.url || ''))) {
      return { url: String(info.url), audio_url: '', kind: 'unknown', from: 'url', headers: headersOf(info) };
    }
    return null;
  }

  const isHls = (f) => /^m3u8/i.test(String(f?.protocol || '')) || /\.m3u8(\?|$)/i.test(String(f?.url || ''));
  const hasV = (f) => Boolean(f?.vcodec && f.vcodec !== 'none');
  const hasA = (f) => Boolean(f?.acodec && f.acodec !== 'none');
  const score = (f) => Number(f?.tbr) || Number(f?.height) * 100 || 0;

  const candidates = formats.filter((f) => isHls(f) && f.url);
  const muxed = candidates.filter((f) => hasV(f) && hasA(f)).sort((a, b) => score(b) - score(a));
  if (muxed.length) {
    return {
      url: muxed[0].url,
      audio_url: '',
      kind: 'muxed',
      from: `format ${muxed[0].format_id || ''}`.trim(),
      height: Number(muxed[0].height) || 0,
      width: Number(muxed[0].width) || 0,
      headers: headersOf(muxed[0])
    };
  }

  // Pistas separadas: la mejor de vídeo + una de audio (preferiblemente HLS).
  const videoOnly = candidates.filter((f) => hasV(f) && !hasA(f)).sort((a, b) => score(b) - score(a));
  const audioOnly = candidates.filter((f) => hasA(f) && !hasV(f)).sort((a, b) => score(b) - score(a));
  if (videoOnly.length) {
    const v = videoOnly[0];
    return {
      url: v.url,
      audio_url: audioOnly[0]?.url || '',
      kind: audioOnly.length ? 'separate' : 'video',
      from: `format ${v.format_id || ''}`.trim(),
      height: Number(v.height) || 0,
      width: Number(v.width) || 0,
      headers: headersOf(v)
    };
  }

  if (candidates.length) {
    return { url: candidates[0].url, audio_url: '', kind: 'unknown', from: 'hls', headers: headersOf(candidates[0]) };
  }
  return null;
}

const LIVE_STATUS_TEXT = {
  is_live: 'en directo',
  is_upcoming: 'programado, aún no ha empezado',
  post_live: 'el directo ya terminó',
  was_live: 'fue un directo, ya terminó',
  not_live: 'no es un directo'
};

/**
 * Cabeceras que exige la URL firmada (se quedan sólo las útiles para FFmpeg).
 * Algunas sacan un espacio delante (« ffmpeg»); FFmpeg lo aceptaría como User-Agent
 * vacío, así que se limpian.
 */
function pickHeaders(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of ['User-Agent', 'Referer', 'Origin', 'Cookie']) {
    const val = src[key] || src[key.toLowerCase()];
    const clean = String(val || '').trim();
    if (clean) out[key] = clean;
  }
  return out;
}

function isProgressiveFormat(f) {
  const url = String(f?.url || '');
  if (!/^https?:/i.test(url)) return false;
  const proto = String(f?.protocol || '').toLowerCase();
  if (/m3u8|m3u|dash|ism|f4m/.test(proto)) return false;
  if (/\.m3u8(\?|$)/i.test(url)) return false;
  return true;
}

const hasVideo = (f) => Boolean(f?.vcodec && f.vcodec !== 'none');
const hasAudio = (f) => Boolean(f?.acodec && f.acodec !== 'none');

/**
 * Elige el archivo progresivo (mp4/webm con audio y vídeo juntos, ≤1080p) que
 * FFmpeg puede leer en bucle sin tener que descargar el vídeo entero.
 * Devuelve null si el vídeo sólo ofrece HLS/DASH (típico de los directos).
 */
export function pickProgressive(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  let list = formats.filter((f) => isProgressiveFormat(f) && hasVideo(f) && hasAudio(f));
  if (!list.length && info?.url && /^https?:/i.test(info.url) && !/\.m3u8(\?|$)/i.test(info.url)) {
    list = [
      {
        url: info.url,
        ext: info.ext,
        vcodec: info.vcodec,
        acodec: info.acodec,
        width: info.width,
        height: info.height,
        fps: info.fps,
        tbr: info.tbr,
        http_headers: info.http_headers
      }
    ].filter((f) => hasVideo(f) && hasAudio(f));
  }
  if (!list.length) return null;

  const hd = list.filter((f) => !(Number(f.height) > MAX_VIDEO_HEIGHT));
  const pool = hd.length ? hd : list;
  const isMp4 = (f) => {
    const ext = String(f?.ext || '').toLowerCase();
    if (ext) return ext === 'mp4';
    return /^(137|136|135|134|18|22|299|298|96)/.test(String(f?.format_id || ''));
  };
  pool.sort(
    (a, b) =>
      (Number(b.height) || 0) - (Number(a.height) || 0) ||
      (Number(b.tbr) || 0) - (Number(a.tbr) || 0) ||
      (isMp4(b) ? 1 : 0) - (isMp4(a) ? 1 : 0)
  );
  const best = pool[0];
  return {
    url: String(best.url),
    ext: String(best.ext || ''),
    format_id: String(best.format_id || ''),
    vcodec: String(best.vcodec || ''),
    acodec: String(best.acodec || ''),
    width: Number(best.width) || 0,
    height: Number(best.height) || 0,
    fps: Number(best.fps) || 0,
    tbr: Number(best.tbr) || 0,
    headers: pickHeaders(best.http_headers || info?.http_headers || {}),
    expires_at_ms: expiryOf(best.url) || 0,
    duration_sec: Math.max(0, Math.round(Number(info?.duration) || Number(best?.duration) || 0)),
    title: String(info?.title || ''),
    id: String(info?.id || '')
  };
}

const H264 = /^(avc1|h264|avc)/i;

/** ¿Hay que recodificar el vídeo? VP9/AV1/HEVC, más de 1080p o sin dato. */
export function videoNeedsTranscode(v) {
  if (!v) return true;
  if (!H264.test(String(v.vcodec || ''))) return true;
  return Number(v.height) > MAX_VIDEO_HEIGHT;
}

/** ¿Hay que recodificar el audio? (opu s/vorbis no van bien en HLS para todos los clientes) */
export function audioNeedsTranscode(v) {
  if (!v) return true;
  const codec = String(v.acodec || '');
  return !/^(mp4a|aac|mp3|mp4a\.40)/i.test(codec);
}

/**
 * Una lista con trozos de distinta resolución o códecs que no sean H.264+AAC no
 * se puede concatenar «en copia»: el cliente se quedaría sin imagen a mitad.
 */
export function playlistNeedsTranscode(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return true;
  const first = list[0];
  const fpsOf = (e) => Math.round(Number(e?.fps) || 0);
  return list.some(
    (e) =>
      videoNeedsTranscode(e) ||
      audioNeedsTranscode(e) ||
      (Number(e.height) || 0) !== (Number(first.height) || 0) ||
      (Number(e.width) || 0) !== (Number(first.width) || 0) ||
      // 0 = sin dato: no se descarta por eso. Si difieren, el corte se nota.
      (fpsOf(e) > 0 && fpsOf(first) > 0 && Math.abs(fpsOf(e) - fpsOf(first)) > 2)
  );
}

/**
 * Pregunta a yt-dlp por el enlace y devuelve lo utilizable para emitir:
 *
 *   mode 'live'     → manifiesto HLS del directo (lo de siempre, `-c copy`)
 *   mode 'video'    → archivo progresivo (mp4/webm) para repetirlo en bucle
 *   mode 'playlist' → los vídeos de la lista, en orden, para dar la vuelta
 *   mode 'hls'      → un .m3u8 pegado a mano
 *
 * No escribe nada: es lo que usan la vista previa y el motor.
 */
export async function resolveLiveSource(rawUrl, { cookiesFile = '' } = {}) {
  const cls = classifySourceUrl(rawUrl);
  if (!cls.ok) return { ok: false, live: false, mode: 'live', error: cls.error, provider: 'youtube' };

  if (cls.provider === 'hls') {
    return {
      ok: true,
      live: true,
      mode: 'hls',
      provider: 'hls',
      url: cls.url,
      title: '',
      host: hostOf(cls.url),
      expires_at_ms: expiryOf(cls.url) || Date.now() + DEFAULT_TTL_MS,
      live_status: 'is_live',
      resolved_at_ms: Date.now()
    };
  }

  const info = await getYtDlpInfo();
  if (!info.installed) {
    return {
      ok: false,
      live: false,
      mode: cls.kind === 'playlist' ? 'playlist' : 'live',
      provider: 'youtube',
      error: info.hint || info.error,
      needs_ytdlp: true
    };
  }

  const isPlaylist = cls.kind === 'playlist';
  const args = ['-J', '--no-warnings', '--no-progress', '--no-config'];
  if (isPlaylist) {
    // Con --flat-playlist no habría URLs de vídeo: se pide la lista completa
    // (hasta 30) y cada entrada trae ya sus formatos.
    args.push('--yes-playlist', '--playlist-end', String(MAX_PLAYLIST_ITEMS), '--ignore-errors');
  } else {
    args.push('--no-playlist');
  }
  const cookies = cookiesFile || getSetting('youtube_cookies_file') || process.env.TVLISTER_YT_COOKIES || '';
  if (cookies && fs.existsSync(cookies)) args.push('--cookies', cookies);
  args.push(cls.url);

  const res = await runBinary(info.bin, args, { timeoutMs: isPlaylist ? PLAYLIST_TIMEOUT_MS : 45000 });
  let data = null;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    data = null;
  }

  if (!data) {
    const err = String(res.stderr || '').replace(/\s+/g, ' ').trim();
    const short = err.length > 240 ? `${err.slice(0, 240)}…` : err;
    return {
      ok: false,
      live: false,
      mode: isPlaylist ? 'playlist' : 'live',
      provider: 'youtube',
      error: short
        ? `yt-dlp no pudo leer el enlace: ${short}`
        : 'yt-dlp no devolvió información del enlace (¿el vídeo existe y es público?).',
      raw: short
    };
  }

  // ── Lista de reproducción ────────────────────────────────────────────────
  const isList = data._type === 'playlist' || (Array.isArray(data.entries) && data.entries.length > 0);
  if (isList) {
    const rawEntries = (data.entries || []).filter(Boolean);
    const entries = [];
    let skippedLive = 0;
    let skippedNoFormat = 0;
    for (const e of rawEntries) {
      if (entries.length >= MAX_PLAYLIST_ITEMS) break;
      const status = String(e.live_status || '');
      // Un directo dentro de una lista no se puede encolar (su URL caduca y no
      // tiene principio ni fin): se omite y se avisa en la vista previa.
      if (e.is_live === true || e.live_status === 'is_live' || status === 'is_upcoming') {
        skippedLive += 1;
        continue;
      }
      const p = pickProgressive(e);
      if (!p || !p.url) {
        skippedNoFormat += 1;
        continue;
      }
      entries.push({
        id: p.id,
        title: p.title || `Vídeo ${entries.length + 1}`,
        url: p.url,
        duration_sec: p.duration_sec,
        expires_at_ms: p.expires_at_ms,
        vcodec: p.vcodec,
        acodec: p.acodec,
        width: p.width,
        height: p.height,
        fps: Number(p.fps) || 0,
        ext: p.ext,
        headers: p.headers
      });
    }

    if (!entries.length) {
      return {
        ok: false,
        live: false,
        mode: 'playlist',
        provider: 'youtube',
        title: String(data.title || ''),
        list_id: String(data.id || cls.list_id || ''),
        entry_count: rawEntries.length,
        error:
          rawEntries.length === 0
            ? 'La lista está vacía o es privada: no hay vídeos que emitir.'
            : 'Ningún vídeo de la lista se puede emitir en bucle (todos son directos, privados o no ofrecen MP4).',
        skipped_live: skippedLive,
        skipped_no_format: skippedNoFormat
      };
    }

    const total = entries.reduce((acc, e) => acc + (Number(e.duration_sec) || 0), 0);
    const expires = earliestExpiry(entries);
    return {
      ok: true,
      live: false,
      mode: 'playlist',
      provider: 'youtube',
      title: String(data.title || entries[0].title || 'Lista de YouTube'),
      list_id: String(data.id || cls.list_id || ''),
      uploader: String(data.uploader || data.channel || ''),
      entries,
      entry_count: entries.length,
      total_entries: rawEntries.length,
      total_duration_sec: total,
      needs_transcode: playlistNeedsTranscode(entries),
      skipped_live: skippedLive,
      skipped_no_format: skippedNoFormat,
      expires_at_ms: expires || Date.now() + DEFAULT_TTL_MS,
      live_status: 'playlist',
      resolved_at_ms: Date.now()
    };
  }

  // ── Un solo vídeo (o un directo) ─────────────────────────────────────────
  const entry = data;
  const liveStatus = String(entry.live_status || '');
  const isLive = entry.is_live === true || liveStatus === 'is_live';
  const title = String(entry.title || '').trim();
  const uploader = String(entry.uploader || entry.channel || '');

  if (isLive) {
    const hls = pickHls(entry);
    if (!hls) {
      return {
        ok: false,
        live: true,
        mode: 'live',
        provider: 'youtube',
        title,
        live_status: liveStatus,
        error:
          'El directo está en vivo pero no ofrece manifiesto HLS utilizable con -c copy ' +
          '(puede requerir inicio de sesión o estar limitado por edad/país).',
        video_id: String(entry.id || '')
      };
    }
    // La caducidad más próxima entre vídeo y audio manda (las dos van firmadas).
    const expiries = [hls.url, hls.audio_url].map(expiryOf).filter((t) => t > 0);
    const expires = expiries.length ? Math.min(...expiries) : Date.now() + DEFAULT_TTL_MS;
    return {
      ok: true,
      live: true,
      mode: 'live',
      provider: 'youtube',
      url: hls.url,
      // Sólo cuando el audio viene en su propia pista: el motor abrirá dos
      // entradas y las mapeará, todo con -c copy.
      audio_url: hls.audio_url || '',
      copy_video: true,
      copy_audio: true,
      copy_kind: hls.kind || '',
      height: Number(hls.height) || 0,
      width: Number(hls.width) || 0,
      from: hls.from,
      headers: pickHeaders(hls.headers),
      host: hostOf(hls.url),
      title,
      video_id: String(entry.id || ''),
      uploader,
      live_status: liveStatus || 'is_live',
      started_at: String(entry.release_timestamp || ''),
      expires_at_ms: expires,
      resolved_at_ms: Date.now()
    };
  }

  // Un directo programado todavía no se puede emitir; se avisa claro.
  if (liveStatus === 'is_upcoming') {
    return {
      ok: false,
      live: false,
      mode: 'live',
      provider: 'youtube',
      title,
      live_status: liveStatus,
      error: `Ese directo está programado y aún no ha empezado (${LIVE_STATUS_TEXT[liveStatus]}).`,
      video_id: String(entry.id || '')
    };
  }

  // Un directo que ya terminó no se emite en bucle por sorpresa: se avisa y el
  // canal queda «sin señal» hasta que haya otro directo (o hasta que peguen un
  // vídeo o una lista, que sí se repiten).
  if (liveStatus === 'post_live' || liveStatus === 'was_live') {
    return {
      ok: false,
      live: false,
      mode: 'live',
      provider: 'youtube',
      title,
      live_status: liveStatus,
      error: `Ese directo ya terminó (${LIVE_STATUS_TEXT[liveStatus]}). Pega otro enlace, o un vídeo o una lista si quieres que el canal siga en bucle.`,
      video_id: String(entry.id || '')
    };
  }

  // ── Vídeo normal: se emite en bucle (24/7) ───────────────────────────────
  const prog = pickProgressive(entry);
  if (!prog || !prog.url) {
    return {
      ok: false,
      live: false,
      mode: 'video',
      provider: 'youtube',
      title,
      live_status: liveStatus || 'not_live',
      error:
        'Ese vídeo no ofrece un MP4/WebM que se pueda repetir en bucle ' +
        '(sólo HLS/DASH, o es privado / con restricción de edad o país).',
      video_id: String(entry.id || '')
    };
  }

  const duration = Math.max(0, Math.round(Number(entry.duration) || prog.duration_sec || 0));
  return {
    ok: true,
    live: false,
    mode: 'video',
    provider: 'youtube',
    url: prog.url,
    from: `format ${prog.format_id || prog.ext || ''}`.trim(),
    headers: prog.headers,
    host: hostOf(prog.url),
    title: title || prog.title,
    video_id: String(entry.id || prog.id || ''),
    uploader,
    live_status: liveStatus || 'not_live',
    duration_sec: duration,
    height: prog.height,
    width: prog.width,
    vcodec: prog.vcodec,
    acodec: prog.acodec,
    needs_transcode: videoNeedsTranscode(prog) || audioNeedsTranscode(prog),
    expires_at_ms: prog.expires_at_ms || Date.now() + DEFAULT_TTL_MS,
    resolved_at_ms: Date.now()
  };
}

/** La caducidad más próxima de una lista (es la que obliga a renovar todo). */
function earliestExpiry(entries) {
  let min = 0;
  for (const e of entries) {
    const t = Number(e?.expires_at_ms) || 0;
    if (t > 0 && (min === 0 || t < min)) min = t;
  }
  return min;
}

// ============================================================================
// ESTADO POR CANAL
// ============================================================================
export function parseLiveState(channel) {
  try {
    const raw = channel?.live_source_state;
    if (!raw) return null;
    const st = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return st && typeof st === 'object' ? st : null;
  } catch {
    return null;
  }
}

export function isLiveChannel(channel) {
  return String(channel?.source_kind || 'playlist') === 'youtube';
}

/**
 * Modo de emisión guardado en el estado.
 *  · 'live'     → directo (HLS, se copia tal cual)
 *  · 'video'    → un vídeo que se repite en bucle
 *  · 'playlist' → lista de vídeos en orden y vuelta a empezar
 *  · 'hls'      → un .m3u8 pegado a mano
 */
export function liveModeFor(channelOrState) {
  const st = channelOrState && typeof channelOrState === 'object' && !('live_source_state' in channelOrState)
    ? channelOrState
    : parseLiveState(channelOrState);
  const mode = String(st?.mode || '');
  if (mode === 'live' || mode === 'video' || mode === 'playlist' || mode === 'hls') return mode;
  // Estados antiguos (sólo tenían `live`): siempre eran directos.
  return 'live';
}

/** Entradas de una lista (vacío si el canal es de otro tipo). */
export function liveEntriesFor(channelOrState) {
  const st = channelOrState && typeof channelOrState === 'object' && !('live_source_state' in channelOrState)
    ? channelOrState
    : parseLiveState(channelOrState);
  if (liveModeFor(st) !== 'playlist') return [];
  return Array.isArray(st?.entries) ? st.entries.filter((e) => e && e.url) : [];
}

/** ¿Hay algo que emitir ahora mismo? (directo resuelto, vídeo o lista con entradas) */
export function liveReady(st) {
  if (!st || typeof st !== 'object') return false;
  if (st.ready === false) return false;
  if (String(st.error || '') && !st.url && !(Array.isArray(st.entries) && st.entries.length)) return false;
  if (liveModeFor(st) === 'playlist') return Array.isArray(st.entries) && st.entries.length > 0;
  return Boolean(String(st.url || '').trim());
}

/**
 * Huella de «qué se está emitiendo»: si cambia, el motor tiene que reiniciarse.
 * Para listas basta con el número de entradas y la primera URL (las firmadas
 * cambian todas a la vez al renovar).
 */
export function liveFingerprint(st) {
  if (!st || typeof st !== 'object') return '';
  const mode = liveModeFor(st);
  if (mode === 'playlist') {
    const entries = liveEntriesFor(st);
    return `playlist|${entries.length}|${entries[0]?.url || ''}`;
  }
  return `${mode}|${String(st.url || '')}`;
}

/** ¿Hay que volver a preguntar? (caducada, nunca resuelta, apagada o con error) */
/** Margen de renovación: 10 min, pero nunca más de 1/3 de la vida de la URL. */
export function refreshMarginFor(st) {
  const life = Number(st?.expires_at_ms || 0) - Number(st?.resolved_at_ms || 0);
  if (!(life > 0)) return REFRESH_MARGIN_MS;
  return Math.min(REFRESH_MARGIN_MS, Math.max(5000, Math.floor(life / 3)));
}

export function needsRefresh(channel, nowMs = Date.now()) {
  const st = parseLiveState(channel);
  const url = String(channel?.live_source_url || '').trim();
  if (!url) return false;
  if (!st || !st.resolved_at_ms) return true;
  // Sin nada que emitir: se vuelve a mirar cada 5 min (el directo puede empezar
  // o la lista puede volver a estar disponible).
  if (!liveReady(st)) return nowMs - Number(st.resolved_at_ms || 0) > OFF_AIR_RECHECK_MS;
  if (st.expires_at_ms && st.expires_at_ms - nowMs < refreshMarginFor(st)) return true;
  // Con señal y sin caducidad conocida (HLS pegado a mano) se renueva cada 30 min.
  if (!st.expires_at_ms) return nowMs - Number(st.resolved_at_ms || 0) > DEFAULT_TTL_MS;
  return false;
}

/** Resuelve y guarda el estado del canal. Devuelve el estado (siempre con `ok`). */
export async function refreshChannelLiveSource(channel) {
  const url = String(channel?.live_source_url || '').trim();
  if (!isLiveChannel(channel) || !url) {
    return { ok: false, live: false, error: 'El canal no tiene una señal en vivo configurada.' };
  }
  const res = await resolveLiveSource(url);
  const entries = Array.isArray(res.entries) ? res.entries : [];
  const mode = String(res.mode || (res.live ? 'live' : 'video'));
  const state = {
    source_url: url,
    provider: res.provider || 'youtube',
    mode,
    url: res.url || '',
    audio_url: res.audio_url || '',
    copy_video: res.copy_video !== false,
    copy_audio: res.copy_audio !== false,
    copy_kind: res.copy_kind || '',
    height: Number(res.height) || 0,
    width: Number(res.width) || 0,
    title: res.title || '',
    video_id: res.video_id || '',
    uploader: res.uploader || '',
    host: res.host || '',
    headers: res.headers || {},
    // `live` sigue significando «en directo»; `ready`, «hay algo que emitir».
    live: Boolean(res.live && res.ok),
    ready: Boolean(res.ok && (res.url || entries.length)),
    live_status: res.live_status || '',
    list_id: res.list_id || '',
    entries,
    entry_count: entries.length,
    total_entries: Number(res.total_entries) || entries.length,
    skipped_live: Number(res.skipped_live) || 0,
    skipped_no_format: Number(res.skipped_no_format) || 0,
    duration_sec: Number(res.duration_sec) || 0,
    total_duration_sec: Number(res.total_duration_sec) || 0,
    vcodec: String(res.vcodec || ''),
    acodec: String(res.acodec || ''),
    needs_transcode: Boolean(res.needs_transcode),
    resolved_at_ms: Date.now(),
    expires_at_ms: res.expires_at_ms || 0,
    checked_at: new Date().toISOString(),
    error: res.ok ? '' : res.error || 'sin señal',
    needs_ytdlp: Boolean(res.needs_ytdlp)
  };
  try {
    db.prepare('UPDATE channels_247 SET live_source_state = ? WHERE id = ?').run(JSON.stringify(state), channel.id);
  } catch {
    /* el estado no es crítico para emitir */
  }
  return { ok: Boolean(res.ok), ...state };
}

/** Estado utilizable para emitir AHORA: renueva si hace falta. */
export async function ensureLiveState(channel) {
  const st = parseLiveState(channel);
  if (st && liveReady(st) && !needsRefresh(channel)) return { ...st, ok: true, ready: true, cached: true };
  return refreshChannelLiveSource(channel);
}

/** Ficha pública para el panel (sin exponer la URL firmada completa). */
export function liveSourceInfo(channel) {
  const st = parseLiveState(channel);
  const url = String(channel?.live_source_url || '');
  const entries = liveEntriesFor(st);
  return {
    source_kind: String(channel?.source_kind || 'playlist'),
    live_source_url: url,
    provider: st?.provider || (url ? (isYouTubeUrl(url) ? 'youtube' : 'hls') : ''),
    mode: st ? liveModeFor(st) : '',
    // `live` = en directo ahora; `ready` = hay algo que emitir (directo, vídeo o lista).
    live: Boolean(st?.live),
    ready: liveReady(st),
    url_host: st?.host || '',
    title: st?.title || '',
    uploader: st?.uploader || '',
    live_status: st?.live_status || '',
    resolved_at: st?.checked_at || '',
    expires_at: st?.expires_at_ms ? new Date(st.expires_at_ms).toISOString() : '',
    expires_in_min: st?.expires_at_ms ? Math.max(0, Math.round((st.expires_at_ms - Date.now()) / 60000)) : null,
    error: st?.error || '',
    has_url: Boolean(st?.url),
    // ── Copia sin recodificar (copy/copy) ──
    // copy_video/copy_audio: la fuente admite copiarla tal cual.
    // separated_audio: el audio va en su propia pista y se mapea aparte.
    copy_video: st ? st.copy_video !== false : false,
    copy_audio: st ? st.copy_audio !== false : false,
    separated_audio: Boolean(st?.audio_url),
    copy_kind: st?.copy_kind || '',
    // Vídeo suelto / lista
    duration_sec: Number(st?.duration_sec) || 0,
    total_duration_sec: Number(st?.total_duration_sec) || 0,
    entries: entries.length,
    total_entries: Number(st?.total_entries) || entries.length,
    entry_titles: entries.slice(0, 5).map((e) => e.title).filter(Boolean),
    skipped_live: Number(st?.skipped_live) || 0,
    skipped_no_format: Number(st?.skipped_no_format) || 0,
    needs_transcode: Boolean(st?.needs_transcode)
  };
}

/** Cabeceras HTTP que exige la URL firmada (User-Agent del reproductor). */
export function liveHeadersFor(channel) {
  const st = parseLiveState(channel);
  const h = st?.headers;
  return h && typeof h === 'object' ? h : {};
}

/** Solo para la entrega al reproductor (302 en modo virtual). */
export function liveUrlForPlayback(channel) {
  return String(parseLiveState(channel)?.url || '');
}
