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
      // Nombre suelto: se resolverá por PATH al ejecutarlo.
      return candidate;
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
 *  · kind 'live'   → /live/<id>, watch?v=…, youtu.be/<id>, /@canal/live
 *  · kind 'video'  → un vídeo normal (se rechaza: no es TV en vivo)
 *  · kind 'channel'→ /@canal o /channel/UC… (se resuelve su directo actual)
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
  if (parts[0] === 'live' && parts[1]) {
    return { ok: true, kind: 'live', video_id: parts[1], url: text };
  }
  if (parts[0] === 'embed' && parts[1]) {
    return { ok: true, kind: 'live', video_id: parts[1], url: text };
  }
  if (parts[0] === 'watch') {
    const v = u.searchParams.get('v') || '';
    if (!v) return { ok: false, error: 'El enlace «watch» no trae el parámetro v.' };
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
  return { ok: false, error: 'No reconozco ese enlace de YouTube. Usa el del directo (…/live/…, watch?v=…).' };
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

function pickHls(info) {
  const manifest = String(info?.manifest_url || '');
  if (/m3u8|hls/i.test(manifest)) {
    return { url: manifest, from: 'manifest_url', headers: info?.http_headers || {} };
  }

  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const isHls = (f) => /^m3u8/i.test(String(f?.protocol || '')) || /\.m3u8(\?|$)/i.test(String(f?.url || ''));
  const withAudio = (f) => f?.acodec && f.acodec !== 'none' && f?.vcodec && f.vcodec !== 'none';
  const score = (f) => Number(f?.tbr) || Number(f?.height) * 100 || 0;

  const candidates = formats.filter((f) => isHls(f) && f.url);
  const muxed = candidates.filter(withAudio).sort((a, b) => score(b) - score(a));
  if (muxed.length) {
    return {
      url: muxed[0].url,
      from: `format ${muxed[0].format_id || ''}`.trim(),
      headers: muxed[0].http_headers || info?.http_headers || {}
    };
  }
  // HLS con audio y vídeo separados: ffmpeg los une desde el maestro igual.
  const videoOnly = candidates.filter((f) => f?.vcodec && f.vcodec !== 'none').sort((a, b) => score(b) - score(a));
  if (videoOnly.length) {
    return {
      url: videoOnly[0].url,
      from: `format ${videoOnly[0].format_id || ''}`.trim(),
      headers: videoOnly[0].http_headers || info?.http_headers || {}
    };
  }
  if (candidates.length) {
    return { url: candidates[0].url, from: 'hls', headers: candidates[0].http_headers || info?.http_headers || {} };
  }

  if (/\.m3u8(\?|$)/i.test(String(info?.url || ''))) return { url: info.url, from: 'url' };
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
 * Pregunta a yt-dlp por el directo y devuelve el manifiesto HLS utilizable.
 * No escribe nada: es lo que usan la vista previa y el motor.
 */
export async function resolveLiveSource(rawUrl, { cookiesFile = '' } = {}) {
  const cls = classifySourceUrl(rawUrl);
  if (!cls.ok) return { ok: false, live: false, error: cls.error, provider: 'youtube' };

  if (cls.provider === 'hls') {
    return {
      ok: true,
      live: true,
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
    return { ok: false, live: false, provider: 'youtube', error: info.hint || info.error, needs_ytdlp: true };
  }

  const args = ['-J', '--no-warnings', '--no-playlist', '--no-progress', '--no-config'];
  const cookies = cookiesFile || getSetting('youtube_cookies_file') || process.env.TVLISTER_YT_COOKIES || '';
  if (cookies && fs.existsSync(cookies)) args.push('--cookies', cookies);
  args.push(cls.url);

  const res = await runBinary(info.bin, args, { timeoutMs: 45000 });
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
      provider: 'youtube',
      error: short
        ? `yt-dlp no pudo leer el enlace: ${short}`
        : 'yt-dlp no devolvió información del enlace (¿el vídeo existe y es público?).',
      raw: short
    };
  }

  // Una lista de reproducción devuelve entries: nos interesa el primer directo.
  const entry = Array.isArray(data.entries) && data.entries.length ? data.entries.find((e) => e) || {} : data;
  const liveStatus = String(entry.live_status || '');
  const isLive = entry.is_live === true || liveStatus === 'is_live';
  const title = String(entry.title || '').trim();

  if (!isLive) {
    return {
      ok: false,
      live: false,
      provider: 'youtube',
      title,
      live_status: liveStatus || 'not_live',
      error: `Ese enlace no está en directo ahora (${LIVE_STATUS_TEXT[liveStatus] || 'sin señal en vivo'}).`,
      video_id: String(entry.id || '')
    };
  }

  const hls = pickHls(entry);
  if (!hls) {
    return {
      ok: false,
      live: true,
      provider: 'youtube',
      title,
      live_status: liveStatus,
      error:
        'El directo está en vivo pero no ofrece manifiesto HLS utilizable con -c copy ' +
        '(puede requerir inicio de sesión o estar limitado por edad/país).',
      video_id: String(entry.id || '')
    };
  }

  const expires = expiryOf(hls.url) || Date.now() + DEFAULT_TTL_MS;
  const hdrs = hls.headers && typeof hls.headers === 'object' ? hls.headers : {};
  const headers = {};
  for (const key of ['User-Agent', 'Referer', 'Origin', 'Cookie']) {
    const val = hdrs[key] || hdrs[key.toLowerCase()];
    if (val) headers[key] = String(val);
  }
  return {
    ok: true,
    live: true,
    provider: 'youtube',
    url: hls.url,
    from: hls.from,
    headers,
    host: hostOf(hls.url),
    title,
    video_id: String(entry.id || ''),
    uploader: String(entry.uploader || entry.channel || ''),
    live_status: liveStatus || 'is_live',
    started_at: String(entry.release_timestamp || ''),
    expires_at_ms: expires,
    resolved_at_ms: Date.now()
  };
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
  if (st.url && st.expires_at_ms && st.expires_at_ms - nowMs < refreshMarginFor(st)) return true;
  if (!st.url) return nowMs - Number(st.resolved_at_ms || 0) > OFF_AIR_RECHECK_MS;
  // Mientras está en vivo, una URL sin caducidad conocida se renueva cada 30 min.
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
  const state = {
    source_url: url,
    provider: res.provider || 'youtube',
    url: res.url || '',
    title: res.title || '',
    video_id: res.video_id || '',
    uploader: res.uploader || '',
    host: res.host || '',
    headers: res.headers || {},
    live: Boolean(res.live && res.ok),
    live_status: res.live_status || '',
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
  if (st && st.url && !needsRefresh(channel)) return { ...st, ok: true, cached: true };
  return refreshChannelLiveSource(channel);
}

/** Ficha pública para el panel (sin exponer la URL firmada completa). */
export function liveSourceInfo(channel) {
  const st = parseLiveState(channel);
  const url = String(channel?.live_source_url || '');
  return {
    source_kind: String(channel?.source_kind || 'playlist'),
    live_source_url: url,
    provider: st?.provider || (url ? (isYouTubeUrl(url) ? 'youtube' : 'hls') : ''),
    live: Boolean(st?.live),
    url_host: st?.host || '',
    title: st?.title || '',
    uploader: st?.uploader || '',
    live_status: st?.live_status || '',
    resolved_at: st?.checked_at || '',
    expires_at: st?.expires_at_ms ? new Date(st.expires_at_ms).toISOString() : '',
    expires_in_min: st?.expires_at_ms ? Math.max(0, Math.round((st.expires_at_ms - Date.now()) / 60000)) : null,
    error: st?.error || '',
    has_url: Boolean(st?.url)
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
