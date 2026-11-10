import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
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

// ============================================================================
// COOKIES DE YOUTUBE
// ============================================================================
// En servidores de datacenter (y en muchas IP domésticas de LATAM) YouTube
// contesta «Sign in to confirm you're not a bot» y no entrega ni un formato.
// La única salida limpia —sin trucos ni proxies— es darle a yt-dlp la sesión
// de un navegador: un archivo de cookies en formato Netscape.
const RUNTIME_DIR = path.dirname(RUNTIME_BIN_DIR);
export const COOKIES_DEFAULT_PATH = path.join(RUNTIME_DIR, 'youtube-cookies.txt');
export const COOKIES_MAX_BYTES = 4 * 1024 * 1024;

// Cookies que sólo existen si hay sesión iniciada. Con `__Secure-3PSID` y
// compañía, yt-dlp deja de verse como visitante anónimo.
const AUTH_COOKIE_NAMES = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  'LOGIN_INFO'
]);

/**
 * Revisa un archivo de cookies (texto) SIN guardarlo: ¿es Netscape de verdad?,
 * ¿trae cookies de youtube.com?, ¿tiene la sesión iniciada?
 * Se usa al subir el archivo y cada vez que se muestra el estado.
 */
export function inspectCookiesText(raw) {
  const text = String(raw ?? '');
  const out = {
    ok: false,
    error: '',
    warn: '',
    format: '',
    count: 0,
    youtube: 0,
    auth: false,
    auth_expires_ms: 0,
    expired_auth: false,
    domains: [],
    bytes: Buffer.byteLength(text, 'utf8'),
    updated_ms: 0
  };
  if (!text.trim()) {
    out.error = 'El archivo está vacío.';
    return out;
  }
  if (out.bytes > COOKIES_MAX_BYTES) {
    out.error = 'El archivo es demasiado grande para ser un cookies.txt (¿has subido otra cosa?).';
    return out;
  }
  // JSON exportado por otras extensiones: se detecta para decirlo claro.
  if (/^\s*[[{]/.test(text) && /"name"\s*:/.test(text.slice(0, 4000))) {
    out.error =
      'Eso parece un JSON (otra extensión). Este panel necesita el formato Netscape: ' +
      'un .txt con columnas separadas por tabuladores (lo da «Get cookies.txt LOCALLY»).';
    return out;
  }

  const domains = new Set();
  let count = 0;
  let youtube = 0;
  let auth = false;
  let authExpiresMs = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const lineRaw of text.split(/\r?\n/)) {
    // Las cookies HttpOnly llegan con el prefijo «#HttpOnly_» y NO son comentarios.
    const line = lineRaw.startsWith('#HttpOnly_') ? lineRaw.slice('#HttpOnly_'.length) : lineRaw;
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    count += 1;
    const domain = String(parts[0] || '').trim().toLowerCase();
    const expires = Number(parts[4]) || 0;
    const name = String(parts[5] || '').trim();
    if (domain) domains.add(domain.replace(/^\./, ''));
    if (/(^|\.)youtube\.com$/.test(domain)) {
      youtube += 1;
      if (AUTH_COOKIE_NAMES.has(name)) {
        // La sesión vale mientras su caducidad no haya pasado (0 = de sesión:
        // el navegador la borra al cerrarse y YouTube la rechaza).
        const valid = expires === 0 ? false : expires > nowSec;
        if (valid) {
          auth = true;
          authExpiresMs = Math.max(authExpiresMs, expires * 1000);
        } else {
          out.expired_auth = true;
        }
      }
    }
  }

  out.count = count;
  out.youtube = youtube;
  out.auth = auth;
  out.auth_expires_ms = authExpiresMs;
  // Fecha legible y días que le quedan a la sesión (para avisar antes de que
  // caduque, en vez de descubrirlo cuando el canal se queda sin señal).
  out.auth_expires_iso = authExpiresMs ? new Date(authExpiresMs).toISOString().slice(0, 10) : '';
  out.auth_days_left = authExpiresMs ? Math.max(0, Math.floor((authExpiresMs - Date.now()) / 86400000)) : null;
  out.domains = [...domains].slice(0, 8);
  out.format = count > 0 ? 'netscape' : 'unknown';

  if (count === 0) {
    out.error =
      'No hay ni una cookie dentro. Debe ser el .txt en formato Netscape (dominio, TRUE/FALSE, ruta, ' +
      'seguro, caducidad, nombre y valor separados por tabuladores), no un JSON ni el HTML de la página.';
    return out;
  }
  if (youtube === 0) {
    out.error =
      'El archivo no trae cookies de youtube.com' +
      (out.domains.length ? ` (sólo de: ${out.domains.join(', ')})` : '') +
      '. Abre youtube.com con la sesión iniciada y exporta las cookies desde ahí.';
    return out;
  }
  out.ok = true;
  if (auth && out.auth_days_left !== null && out.auth_days_left <= 3) {
    out.warn =
      `La sesión de las cookies caduca pronto (${out.auth_expires_iso || 'en días'}): ` +
      'vuelve a exportarlas de youtube.com con la sesión iniciada para que los canales no se queden sin señal.';
  } else if (!auth && out.expired_auth) {
    out.warn =
      'Las cookies traen la sesión pero YA HAN CADUCADO: abre youtube.com con la sesión iniciada, vuelve a ' +
      'exportarlas y súbelas otra vez. YouTube las caduca en días (a veces horas).';
  } else if (!auth) {
    out.warn =
      'Las cookies son de youtube.com pero no incluyen la sesión (falta SID/__Secure-3PSID): ' +
      'asegúrate de haber iniciado sesión en YouTube antes de exportarlas.';
  }
  return out;
}

/** Igual que `inspectCookiesText`, leyendo el archivo del disco. */
export function inspectCookiesFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(st.size, COOKIES_MAX_BYTES + 1));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const info = inspectCookiesText(buf.subarray(0, read).toString('utf8'));
    info.updated_ms = st.mtimeMs || 0;
    return info;
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo leer el archivo: ${err.message}`,
      warn: '',
      format: '',
      count: 0,
      youtube: 0,
      auth: false,
      domains: [],
      bytes: 0,
      updated_ms: 0
    };
  }
}

/**
 * Cookies de YouTube (opcional). Devuelve la ruta y si el archivo sirve de
 * verdad, para que la pantalla no diga «archivo encontrado» cuando lo que hay
 * es un JSON o un archivo sin sesión.
 */
export function cookiesInfo() {
  const fromEnv = !getSetting('youtube_cookies_file') && Boolean(process.env.TVLISTER_YT_COOKIES);
  const p = String(getSetting('youtube_cookies_file') || process.env.TVLISTER_YT_COOKIES || '').trim();
  if (!p) {
    return { path: '', exists: false, usable: false, ok: false, source: 'none', error: '', warn: '', count: 0, youtube: 0, auth: false };
  }
  const exists = fs.existsSync(p);
  const info = exists
    ? inspectCookiesFile(p)
    : { ok: false, error: 'La ruta guardada no existe en este servidor.', warn: '', count: 0, youtube: 0, auth: false, bytes: 0, updated_ms: 0 };
  return {
    ...info,
    path: p,
    exists,
    // «usable» = el panel se lo pasará a yt-dlp en la próxima lectura.
    usable: Boolean(exists && info.ok),
    source: fromEnv ? 'env' : 'setting'
  };
}

/**
 * ¿El error que devolvió yt-dlp es el control anti-robots de YouTube?
 * Aparece cuando la IP del servidor está marcada (datacenter, VPN, mucho uso).
 */
export function isBotCheckError(text) {
  const t = String(text || '');
  // «Sign in to confirm your age» NO es el anti-robots: es restricción de edad
  // y tiene su propio mensaje. Antes se confundían y al operador con un vídeo
  // para adultos se le hablaba de la IP del servidor.
  if (/confirm your age|confirm you.{0,3}re 18|inappropriate for some users/i.test(t)) {
    return /not a bot|unusual traffic|automated (?:queries|requests)/i.test(t);
  }
  return (
    /not a bot/i.test(t) ||
    /unusual traffic|automated (?:queries|requests)|verify you.{0,3}re not a robot/i.test(t) ||
    /sign in to confirm/i.test(t)
  );
}

const fmtExpiry = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};

/**
 * El control anti-robots de YouTube, explicado sin culpar a las cookies cuando
 * las cookies son buenas. Es lo que salió en el canal de Los Simpson: sesión
 * válida hasta 2027 y, aun así, «Sign in to confirm you’re not a bot» porque a
 * YouTube no le gusta la IP del servidor.
 */
export function explainBotCheck({ cookies = null, usingCookies = false, clientsTried = '' } = {}) {
  const ck = cookies || cookiesInfo();
  const hasSession = Boolean(ck && ck.auth);
  const expired = Boolean(ck && ck.expired_auth);
  const until = ck && ck.auth_expires_iso ? ` hasta el ${fmtExpiry(ck.auth_expires_iso)}` : '';
  const parts = [];
  parts.push(
    'YouTube no entrega este vídeo a la IP pública de este servidor: pide «Sign in to confirm you’re not a bot» ' +
      '(su control anti-robots). No es que el vídeo esté roto ni que la lista esté vacía.'
  );
  if (!ck || !ck.path) {
    parts.push('Sube un cookies.txt de una cuenta con la sesión iniciada (botón «Subir cookies») y el panel lo reintenta solo.');
  } else if (!ck.exists || ck.ok === false) {
    parts.push('El cookies.txt guardado no se puede usar, así que YouTube ve una visita anónima: vuelve a subirlo.');
  } else if (expired) {
    parts.push('Las cookies guardadas están CADUCADAS: vuelve a exportarlas desde youtube.com con la sesión iniciada.');
  } else if (!hasSession) {
    parts.push('El cookies.txt no trae la sesión de YouTube (falta SID/__Secure-3PSID): expórtalo con la cuenta ya iniciada.');
  } else {
    parts.push(
      `Las cookies son válidas${until}${usingCookies ? ' y se han enviado a yt-dlp' : ''}, así que el aviso no es por ` +
        'falta de sesión: YouTube lo aplica por IP (lo normal en servidores y centros de datos).'
    );
  }
  if (clientsTried) parts.push(`Se ha probado con los clientes: ${clientsTried}.`);
  parts.push(
    'Qué hacer, en este orden: pulsa «Actualizar yt-dlp» (los clientes de YouTube cambian cada pocas semanas); ' +
      'inicia sesión en YouTube desde la misma red del servidor y vuelve a exportar las cookies; y si el servidor ' +
      'sale por una IP de centro de datos, YouTube puede seguir pidiéndolo: una IP doméstica o residencial ' +
      '(proxy o VPN sólo para YouTube) lo resuelve. Un vídeo ya descargado en el disco no pasa por esto.'
  );
  return parts.join(' ');
}

/**
 * Traduce el fallo de yt-dlp a algo que se pueda accionar desde el panel.
 * Devuelve `null` si el error no es de los que sabemos explicar.
 */
export function explainYtDlpError(stderr, { clientsTried = '', usingCookies = false } = {}) {
  const raw = String(stderr || '').replace(/\s+/g, ' ').trim();

  // «Requested format is not available»: YouTube no entrega ninguna pista que
  // yt-dlp sepa usar. Casi siempre es una versión vieja de yt-dlp (YouTube
  // cambia cada pocas semanas) o una IP/cuenta que sólo recibe SABR.
  // El anti-robots manda: cuando aparece, el «Requested format is not available»
  // que a veces lo acompaña es una consecuencia, no la causa.
  if (isFormatError(raw) && !isBotCheckError(raw)) {
    return {
      message:
        'YouTube no ha dado ninguna pista de vídeo utilizable para este enlace («Requested format is not available»). ' +
        'Suele arreglarse actualizando yt-dlp: pulsa «Actualizar yt-dlp» y vuelve a comprobar. Si sigue igual, prueba ' +
        'otro formato de enlace (el directo del canal con /live) o espera unos minutos: YouTube cambia esto a menudo.',
      needs_format_fix: true,
      detail: raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
    };
  }

  if (!isBotCheckError(raw)) return null;
  const ck = cookiesInfo();
  // Con cookies buenas (sesión sin caducar) el texto de siempre culpaba a la
  // sesión y mandaba reexportar cookies que ya servían. Eso confundió en el
  // canal de Los Simpson: la sesión valía hasta 2027. Si las cookies son
  // buenas, el problema es la IP del servidor y hay que decirlo así.
  if (ck.path && ck.exists && ck.ok && ck.auth && !ck.expired_auth) {
    return {
      message: explainBotCheck({ cookies: ck, usingCookies, clientsTried }),
      needs_cookies: false,
      blocked_bot: true,
      detail: raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
    };
  }
  let message = 'YouTube pide iniciar sesión desde este servidor («Sign in to confirm you’re not a bot»).';
  if (!ck.path) {
    message +=
      ' Sube un archivo de cookies de youtube.com (extensión «Get cookies.txt LOCALLY», estando con la sesión ' +
      'iniciada) y el panel lo usará solo: botón «Subir cookies».';
  } else if (!ck.exists) {
    message += ` La ruta de cookies guardada no existe en el servidor (${ck.path}). Sube el archivo otra vez.`;
  } else if (!ck.ok) {
    message += ` El archivo de cookies no sirve: ${ck.error}`;
  } else if (!ck.auth) {
    message +=
      ' Las cookies guardadas no traen la sesión de YouTube (falta SID/__Secure-3PSID): vuelve a exportarlas ' +
      'con la sesión iniciada en youtube.com.';
  } else {
    message +=
      ' Las cookies guardadas están caducadas: vuelve a exportarlas con la sesión iniciada en youtube.com.';
  }
  return { message, needs_cookies: true, blocked_bot: true, detail: raw.length > 240 ? `${raw.slice(0, 240)}…` : raw };
}

// ============================================================================
// ¿Está yt-dlp al día?
// ============================================================================
// YouTube cambia cada pocas semanas y una versión vieja de yt-dlp deja de ver
// los formatos («Requested format is not available»). Se consulta la última
// publicada en GitHub cada 6 h (sin bloquear: si no hay red, se calla).
const RELEASE_API = String(
  process.env.TVLISTER_YTDLP_RELEASE_API || 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
);
const RELEASE_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASES_ENABLED = String(process.env.TVLISTER_YTDLP_RELEASES || '1') !== '0';
let releaseCache = { at: 0, tag: '', error: '' };
let releaseInFlight = null;

async function fetchReleaseTag(timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'tvlister24-7' },
      signal: ctrl.signal
    });
    if (!r.ok) return '';
    const body = await r.json();
    return String(body?.tag_name || '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Última versión publicada de yt-dlp. `waitMs: 0` devuelve lo que haya en
 * memoria y lanza la consulta de fondo; con `waitMs` se espera como mucho eso.
 */
export async function ytDlpReleaseInfo({ waitMs = 0, force = false } = {}) {
  if (!RELEASES_ENABLED) return { ...releaseCache, enabled: false };
  const fresh = Date.now() - releaseCache.at < RELEASE_TTL_MS && Boolean(releaseCache.tag || releaseCache.error);
  if (force || !fresh) {
    if (!releaseInFlight) {
      releaseInFlight = fetchReleaseTag(9000).then((tag) => {
        releaseCache = { at: Date.now(), tag, error: tag ? '' : 'no se pudo consultar GitHub' };
        releaseInFlight = null;
        return releaseCache;
      });
    }
    if (waitMs > 0) {
      await Promise.race([releaseInFlight, new Promise((r) => setTimeout(r, waitMs))]);
    }
  }
  return { ...releaseCache, enabled: true };
}

/** Lanza la consulta sin esperar (al arrancar el panel). */
export function warmYtDlpReleaseInfo() {
  ytDlpReleaseInfo({ waitMs: 0 }).catch(() => {});
}

/** Compara la versión instalada con la publicada (2026.10.26 vs 2026.10.26). */
export function isYtDlpOutdated(installed, latest) {
  const a = String(installed || '').trim();
  const b = String(latest || '').trim();
  if (!a || !b) return false;
  // Los zipapp dicen «2026.10.26», el autónomo «2026.10.26-standalone»: se
  // comparan sólo los números y se exige que la publicada sea más nueva.
  const num = (v) => String(v).split(/[^0-9.]/).filter(Boolean)[0] || '';
  const ia = num(a);
  const ib = num(b);
  if (!ia || !ib || ia === ib) return false;
  const pa = ia.split('.').map(Number);
  const pb = ib.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return y > x;
  }
  return false;
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
  const res = await runBinary(bin, ['--version'], { timeoutMs: 25000 });
  if (res.ok) {
    return {
      installed: true,
      bin,
      version: res.stdout.trim().split('\n')[0],
      error: '',
      hint: ''
    };
  }
  // Existe pero no arranca: casi siempre es el zipapp con un python3 recortado
  // (sin _ssl, sin sqlite3…) o una versión de Python anterior a la 3.9.
  const detail = errorTail(res.stderr, 200);
  const looksPython = /python|traceback|modulenotfound|importerror|syntaxerror/i.test(
    `${res.stderr || ''} ${res.stdout || ''}`
  );
  return {
    installed: false,
    bin,
    version: '',
    variant: String(getSetting('ytdlp_variant') || ''),
    error: detail || 'no se pudo ejecutar yt-dlp',
    hint: looksPython
      ? 'yt-dlp está descargado pero el Python de este servidor no puede con él ' +
        '(falta un módulo o es anterior a 3.9). Pulsa «Instalar yt-dlp»: ahora baja el ' +
        'binario autónomo, que lleva todo dentro y no usa el Python del sistema.'
      : `yt-dlp está en ${bin} pero no arranca (${detail || 'sin detalle'}). ` +
        'Pulsa «Instalar yt-dlp» para volver a ponerlo, o revisa los permisos (chmod +x).'
  };
}

/** Las 2-3 últimas líneas de un error: la causa real está al final del traceback. */
function errorTail(text, max = 300) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const tail = lines.slice(-3).join(' · ');
  return tail.length > max ? `…${tail.slice(-max)}` : tail;
}

/**
 * De dónde se baja yt-dlp. Se prueban en orden:
 *   1. el zipapp `yt-dlp` (~3 MB), que usa el python3 del sistema (≥ 3.9): es el
 *      rápido y funciona en casi todos los servidores;
 *   2. el binario AUTÓNOMO (`yt-dlp_linux`, ~39 MB), que lleva Python y OpenSSL
 *      dentro y no depende de nada del sistema — el que salva los servidores con
 *      el python3 recortado (sin `_ssl`, sin `sqlite3`…) o roto, que era el caso
 *      en que antes el panel se quedaba sin yt-dlp con un traceback en la cara.
 */
function ytDlpDownloadPlan() {
  const arch = process.arch;
  // Sólo hay binarios autónomos para estas arquitecturas (las de los VPS).
  const standalone =
    arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'x64' ? 'yt-dlp_linux' : '';
  const plan = [{ asset: 'yt-dlp', variant: 'zipapp', label: 'zipapp (usa el python3 del sistema)' }];
  if (standalone) {
    plan.push({
      asset: standalone,
      variant: 'standalone',
      label: 'binario autónomo (no necesita Python)'
    });
  }
  return plan;
}

/**
 * Descarga el binario oficial de yt-dlp en .runtime/bin (sin apt, sin root para
 * el panel: el proceso corre como el servicio). No toca nada del sistema.
 *
 * Siempre se deja como `.runtime/bin/yt-dlp`, así que el resto del panel (y
 * cualquier ruta ya guardada) sigue funcionando igual, sea cual sea la variante.
 */
export async function installYtDlp(onStep = null) {
  const step = (msg) => {
    try {
      onStep?.(String(msg));
    } catch {
      /* el progreso no debe romper la instalación */
    }
  };
  fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
  const target = path.join(RUNTIME_BIN_DIR, 'yt-dlp');
  const tmpBase = `${target}.tmp.${Date.now()}`;
  const attempts = [];

  for (const item of ytDlpDownloadPlan()) {
    step(`descargando ${item.label}`);
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${item.asset}`;
    const tmp = `${tmpBase}.${item.variant}`;
    const dl = await runBinary('curl', ['-fsSL', '--max-time', '300', url, '-o', tmp], {
      timeoutMs: 310000
    });
    if (!dl.ok || !fs.existsSync(tmp)) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      attempts.push(`${item.variant}: no se pudo descargar (${errorTail(dl.stderr, 160) || 'sin detalle'})`);
      continue;
    }

    // Se prueba ANTES de dejarlo en su sitio: así nunca queda un binario roto
    // ocupando el nombre bueno.
    try {
      fs.chmodSync(tmp, 0o755);
    } catch {
      /* ignore */
    }
    step(`comprobando que ${item.label} arranca`);
    const check = await runBinary(tmp, ['--version'], { timeoutMs: 45000 });
    if (!check.ok) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      attempts.push(`${item.variant}: no arranca (${errorTail(check.stderr, 220) || 'sin detalle'})`);
      continue;
    }

    try {
      fs.copyFileSync(tmp, target);
      fs.chmodSync(target, 0o755);
      fs.unlinkSync(tmp);
    } catch (err) {
      return { ok: false, error: `No se pudo dejar el binario en ${target}: ${err.message}` };
    }
    const version = check.stdout.trim().split('\n')[0];
    setSetting('ytdlp_path', target);
    setSetting('ytdlp_version', version);
    setSetting('ytdlp_variant', item.variant);
    return {
      ok: true,
      path: target,
      version,
      variant: item.variant,
      note:
        item.variant === 'standalone'
          ? 'Instalado el binario autónomo: no depende del Python del servidor.'
          : 'Instalado el zipapp: usa el python3 del sistema.'
    };
  }

  // Nada sirvió: se explica qué se intentó y con qué error, sin prometer apt.
  return {
    ok: false,
    path: target,
    attempts,
    error:
      'No se pudo dejar un yt-dlp que arranque en este servidor. ' +
      'Se intentó: ' +
      attempts.join(' | ') +
      '. Comprueba la salida a Internet (github.com) y vuelve a intentarlo; ' +
      'si sigue igual, copia a mano un yt-dlp de tu PC en ' +
      target +
      ' y dale permisos (chmod +x).'
  };
}

// ── Instalación en segundo plano ─────────────────────────────────────────────
// El binario autónomo pesa ~39 MB: si el panel está detrás de un proxy (Cloudflare
// corta a los 100 s) una petición HTTP abierta se quedaría a medias. Por eso la
// instalación corre en el servidor y la pantalla va preguntando cómo va.
let installJob = { running: false, step: '', startedAt: 0, result: null };

export function ytInstallState() {
  return { ...installJob };
}

/** Arranca (o devuelve) la instalación en curso. No bloquea. */
export function startYtDlpInstall() {
  if (installJob.running) return ytInstallState();
  installJob = { running: true, step: 'empezando', startedAt: Date.now(), result: null };
  (async () => {
    try {
      const r = await installYtDlp((s2) => {
        installJob.step = s2;
      });
      installJob = { running: false, step: '', startedAt: installJob.startedAt, result: r };
    } catch (err) {
      installJob = {
        running: false,
        step: '',
        startedAt: installJob.startedAt,
        result: { ok: false, error: err?.message || 'error inesperado instalando yt-dlp' }
      };
    }
  })();
  return ytInstallState();
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
    const id = safeVideoId(parts[0] || '');
    if (!id) return { ok: false, error: 'Enlace youtu.be sin ID.' };
    // youtu.be/<id> es el enlace corto de UN vídeo (o de un directo: eso lo dice
    // yt-dlp al resolverlo). Antes se trataba como directo y por eso un vídeo
    // corto ya descargado no se emitía desde el disco: volvía a preguntar a
    // YouTube cada vez y, con el anti-robots, se quedaba sin señal. Se normaliza
    // además la URL para no arrastrar el ?si=… de «compartir».
    return { ok: true, kind: 'video', video_id: id, url: `https://www.youtube.com/watch?v=${id}` };
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
    const list = u.searchParams.get('list') || '';
    // watch?v=…&list=… es lo que copia el navegador cuando ves un vídeo dentro
    // de una lista: YouTube reproduce LA LISTA desde ahí. Se trata como lista
    // (con el vídeo de partida anotado); si de verdad se quiere sólo ese vídeo,
    // la pantalla ofrece quitar la lista del enlace.
    if (v && list) {
      return {
        ok: true,
        kind: 'playlist',
        list_id: list,
        video_id: v,
        start_video_id: v,
        from_list: true,
        url: `https://www.youtube.com/playlist?list=${list}`
      };
    }
    if (!v) {
      // watch?list=… sin vídeo: es la lista.
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
  return {
    ok: true,
    provider: 'youtube',
    url: yt.url,
    kind: yt.kind,
    list_id: yt.list_id || '',
    video_id: yt.video_id || '',
    start_video_id: yt.start_video_id || '',
    from_list: Boolean(yt.from_list)
  };
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

// ============================================================================
// VÍDEOS SIN MP4 PROGRESIVO: se descargan UNA vez y se repiten desde el disco
// ============================================================================
// YouTube cada vez sirve menos vídeos con un MP4 progresivo (DASH/HLS + PO
// token). Sin archivo no hay bucle fiable: la URL firmada caduca y el HLS de un
// vídeo no se repite bien con `-stream_loop`. Se descarga el vídeo con yt-dlp
// (H.264 + AAC, ≤1080p, ya mezclado) a `.runtime/videos`, se guarda su ficha y
// el motor lo repite desde el disco: sin caducidades, sin volver a YouTube.
export const VIDEO_CACHE_DIR = path.join(RUNTIME_DIR, 'videos');
// Selector: lo mejor que se pueda copiar sin recodificar y, si no, lo que haya.
const VIDEO_DOWNLOAD_FORMAT =
  'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][vcodec^=avc1]/bv*[height<=1080]+ba/b[height<=1080]/b';

function safeVideoId(id) {
  return String(id || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
}

/** Ruta del archivo descargado de un vídeo ('' si el id no vale). */
export function cachedVideoPath(videoId) {
  const id = safeVideoId(videoId);
  return id ? path.join(VIDEO_CACHE_DIR, `${id}.mp4`) : '';
}

const realFile = (p) => {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
};

/** Ficha del vídeo descargado (null si no está). */
export function cachedVideoInfo(videoId) {
  const id = safeVideoId(videoId);
  if (!id) return null;
  const dir = VIDEO_CACHE_DIR;
  let name = '';
  try {
    name = fs
      .readdirSync(dir)
      .find((f) => f.startsWith(`${id}.`) && !f.endsWith('.json') && !f.includes('.tmp.') && !f.endsWith('.part'));
  } catch {
    return null;
  }
  if (!name) return null;
  const file = path.join(dir, name);
  if (!realFile(file)) return null;
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  } catch {
    meta = {};
  }
  const st = fs.statSync(file);
  return {
    path: file,
    video_id: id,
    bytes: st.size,
    title: String(meta.title || ''),
    duration_sec: Number(meta.duration_sec) || 0,
    vcodec: String(meta.vcodec || ''),
    acodec: String(meta.acodec || ''),
    downloaded_at_ms: Number(meta.downloaded_at_ms) || st.mtimeMs
  };
}

/** Borra un vídeo descargado (y su ficha). */
export function removeCachedVideo(videoId) {
  const info = cachedVideoInfo(videoId);
  if (!info) return false;
  try {
    fs.rmSync(info.path, { force: true });
    fs.rmSync(`${info.path}.json`, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Trabajo de descarga en memoria (uno a la vez). Mismo patrón que la
// instalación de yt-dlp: la pantalla lanza y pregunta cómo va.
let videoJob = { running: false, step: '', startedAt: 0, result: null, video_id: '', url: '' };

export function videoDownloadState() {
  return { ...videoJob };
}

const lastLines = (text, n = 3) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' ');

/**
 * ¿Vale la pena descargar el mismo vídeo con otro cliente de YouTube?
 * El anti-robots, «Requested format is not available» y los 403 de la
 * extracción sí (los firma YouTube por cliente); un 404 del CDN o un vídeo
 * privado no.
 */
function isRetryableDownloadError(text) {
  return /sign in to confirm|not a bot|requested format is not available|no video formats found|unable to extract|player response|failed to extract|HTTP Error 403/i.test(
    String(text || '')
  );
}

/**
 * Descarga UN vídeo al disco (promesa). Reutilizable: la usa la descarga de un
 * vídeo suelto y la preparación de una lista completa.
 * Devuelve `{ ok, path, video_id, title, duration_sec, bytes, error }`.
 */
function downloadVideoFile({ bin, url, videoId, onStep = () => {} }) {
  return (async () => {
    const id = safeVideoId(videoId);
    if (!bin || !id) return { ok: false, error: 'Falta yt-dlp o el identificador del vídeo.' };

    fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
    const tmpBase = path.join(VIDEO_CACHE_DIR, `${id}.tmp`);
    const baseArgs = [
      '--no-warnings',
      '--no-config',
      '--no-playlist',
      '--newline',
      '-f',
      VIDEO_DOWNLOAD_FORMAT,
      '--merge-output-format',
      'mp4',
      '--write-info-json',
      '-o',
      `${tmpBase}.%(ext)s`
    ];
    const cookies = String(getSetting('youtube_cookies_file') || process.env.TVLISTER_YT_COOKIES || '').trim();
    if (cookies && fs.existsSync(cookies)) baseArgs.push('--cookies', cookies);

    const cleanTmp = () => {
      try {
        for (const f of fs.readdirSync(VIDEO_CACHE_DIR)) {
          if (f.startsWith(`${id}.tmp`)) fs.rmSync(path.join(VIDEO_CACHE_DIR, f), { force: true });
        }
      } catch {
        /* nada que limpiar */
      }
    };

    // Una descarga con un cliente concreto. La descarga es la que de verdad
    // necesita YouTube: si el cliente por defecto está con el anti-robots,
    // «Preparar lista en el disco» fallaba aunque la comprobación sí pasara con
    // `tv`. Se recorren los mismos clientes que la comprobación.
    const runOnce = (extraArgs) =>
      new Promise((resolve) => {
        const child = spawn(bin, [...baseArgs, ...extraArgs, url], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        const onChunk = (buf) => {
          const text = String(buf || '');
          const progress = [...text.matchAll(/(\d{1,3}(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)([KMG]iB)/g)].pop();
          if (progress) {
            onStep(`descargando ${progress[1]} % (${progress[2]} ${progress[3]})`);
            return;
          }
          if (/\[Merger\]|\[ffmpeg\]/i.test(text)) onStep('uniendo vídeo y audio…');
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', (buf) => {
          stderr += String(buf || '');
          onChunk(buf);
        });
        child.on('error', (err) => resolve({ ok: false, code: -1, stderr: `No se pudo ejecutar yt-dlp: ${err.message}` }));
        child.on('close', (code) => resolve({ ok: code === 0, code, stderr }));
      });

    let lastErr = '';
    const tried = [];
    let usedClient = '';
    for (const client of YT_CLIENT_CHAIN) {
      tried.push(client.label);
      // eslint-disable-next-line no-await-in-loop
      const res = await runOnce(client.extractorArgs ? ['--extractor-args', client.extractorArgs] : []);
      if (res.ok) {
        usedClient = client.label;
        break;
      }
      lastErr = String(res.stderr || '').trim() || lastErr;
      cleanTmp();
      // Un fallo que no depende del cliente (vídeo privado, 403 del propio CDN)
      // no se reintenta seis veces.
      if (!isRetryableDownloadError(res.stderr)) {
        break;
      }
    }

    if (!usedClient) {
      const explained = explainYtDlpError(lastErr, { clientsTried: tried.join(', '), usingCookies: Boolean(cookies) });
      const detail = lastLines(lastErr, 3);
      cleanTmp();
      return {
        ok: false,
        error: explained
          ? explained.message
          : `yt-dlp no pudo descargar el vídeo.${detail ? ` ${detail}` : ''}`,
        raw: detail,
        clients_tried: tried.join(', '),
        blocked_bot: Boolean(explained && explained.blocked_bot)
      };
    }

    // El archivo bueno es el que dejó yt-dlp; se le quita el «.tmp.» del nombre.
    let produced = '';
    try {
      produced = fs
        .readdirSync(VIDEO_CACHE_DIR)
        .find((f) => f.startsWith(`${id}.tmp.`) && !f.endsWith('.json') && !f.endsWith('.part'));
    } catch {
      produced = '';
    }
    if (!produced) {
      cleanTmp();
      return { ok: false, error: 'yt-dlp terminó pero no dejó ningún archivo de vídeo.', clients_tried: tried.join(', ') };
    }
    const ext = path.extname(produced).replace(/^\./, '') || 'mp4';
    const finalPath = path.join(VIDEO_CACHE_DIR, `${id}.${ext}`);
    try {
      fs.renameSync(path.join(VIDEO_CACHE_DIR, produced), finalPath);
    } catch (err) {
      cleanTmp();
      return { ok: false, error: `No se pudo mover el vídeo descargado: ${err.message}` };
    }
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(VIDEO_CACHE_DIR, `${produced}.info.json`), 'utf8'));
    } catch {
      meta = {};
    }
    const acodec = String(meta.acodec || '');
    const sidecar = {
      video_id: id,
      title: String(meta.title || ''),
      duration_sec: Math.round(Number(meta.duration) || 0),
      vcodec: String(meta.vcodec || ''),
      acodec: acodec === 'none' && meta.requested_downloads ? '' : acodec,
      bytes: realFile(finalPath) ? fs.statSync(finalPath).size : 0,
      downloaded_at_ms: Date.now(),
      format_id: String(meta.format_id || ''),
      merge: true,
      client: usedClient
    };
    try {
      fs.writeFileSync(`${finalPath}.json`, JSON.stringify(sidecar, null, 2));
      fs.rmSync(path.join(VIDEO_CACHE_DIR, `${produced}.info.json`), { force: true });
    } catch {
      /* la ficha es un extra */
    }
    cleanTmp();
    return { ok: true, ...sidecar, path: finalPath, clients_tried: tried.join(', ') };
  })();
}

/**
 * Descarga un vídeo de YouTube al disco del panel (en segundo plano).
 * Devuelve el estado del trabajo; la pantalla lo sigue con `videoDownloadState`.
 */
export function startVideoDownload(rawUrl) {
  if (videoJob.running) return { ...videoJob, already: true };

  const cls = classifySourceUrl(rawUrl);
  const bin = findYtDlp();
  const id = safeVideoId(cls.video_id || '');
  if (!cls.ok || cls.kind !== 'video' || !id) {
    return {
      running: false,
      step: '',
      startedAt: 0,
      video_id: id,
      url: String(rawUrl || ''),
      result: { ok: false, error: 'Sólo se puede descargar el enlace de un vídeo suelto (watch?v=… o youtu.be/…).' }
    };
  }
  if (!bin) {
    return {
      running: false,
      step: '',
      startedAt: 0,
      video_id: id,
      url: String(rawUrl || ''),
      result: { ok: false, error: 'Falta yt-dlp: instálalo primero con «Instalar yt-dlp».' }
    };
  }

  videoJob = {
    running: true,
    step: 'preparando la descarga…',
    startedAt: Date.now(),
    video_id: id,
    url: cls.url || String(rawUrl || ''),
    result: null
  };

  downloadVideoFile({
    bin,
    url: cls.url || rawUrl,
    videoId: id,
    onStep: (step) => {
      videoJob = { ...videoJob, step };
    }
  }).then((result) => {
    videoJob = { ...videoJob, running: false, step: '', result, finishedAt: Date.now() };
  });

  return { ...videoJob };
}

// ── Preparar una LISTA completa en el disco ─────────────────────────────────
// Muchas listas sólo dan DASH/HLS (sin MP4 progresivo) y entonces no hay nada
// que encolar: se descargan sus vídeos una vez y se emiten desde el disco, en
// orden y en bucle, sin caducidades. Uno a uno (no se satura el VPS).
let playlistJob = { running: false, step: '', startedAt: 0, result: null, url: '', done: 0, total: 0, current: '', failures: [] };

export function playlistDownloadState() {
  return { ...playlistJob, failures: [...playlistJob.failures] };
}

/**
 * Descarga hasta `limit` vídeos de una lista al disco (en segundo plano).
 * Los que ya estén descargados se saltan. Devuelve el estado del trabajo.
 */
export function startPlaylistDownload(rawUrl, { limit = 10 } = {}) {
  if (playlistJob.running) return { ...playlistDownloadState(), already: true };

  const cls = classifySourceUrl(rawUrl);
  const bin = findYtDlp();
  if (!cls.ok || cls.kind !== 'playlist') {
    return {
      running: false,
      step: '',
      startedAt: 0,
      url: String(rawUrl || ''),
      done: 0,
      total: 0,
      current: '',
      failures: [],
      result: { ok: false, error: 'Sólo se puede preparar una lista (playlist?list=…).' }
    };
  }
  if (!bin) {
    return {
      running: false,
      step: '',
      startedAt: 0,
      url: String(rawUrl || ''),
      done: 0,
      total: 0,
      current: '',
      failures: [],
      result: { ok: false, error: 'Falta yt-dlp: instálalo primero con «Instalar yt-dlp».' }
    };
  }

  const count = Math.max(1, Math.min(MAX_PLAYLIST_ITEMS, Number(limit) || 10));
  playlistJob = {
    running: true,
    step: 'leyendo la lista…',
    startedAt: Date.now(),
    url: cls.url || String(rawUrl || ''),
    done: 0,
    total: 0,
    current: '',
    failures: [],
    result: null
  };

  (async () => {
    // Se lee la lista completa (con formatos) para saber qué vídeos hay.
    const list = await resolveLiveSource(cls.url || rawUrl);
    if (!list?.ok && !Array.isArray(list?.pending)) {
      playlistJob = {
        ...playlistJob,
        running: false,
        step: '',
        result: { ok: false, error: list?.error || 'No se pudo leer la lista.' }
      };
      return;
    }
    const pending = Array.isArray(list.pending) ? list.pending.slice(0, count) : [];
    const total = pending.length;
    playlistJob = { ...playlistJob, total, step: total ? `preparando ${total} vídeos…` : '' };

    let downloaded = 0;
    let already = 0;
    const failures = [];
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      const title = String(item.title || item.id || '');
      if (cachedVideoInfo(item.id)) {
        already += 1;
        playlistJob = { ...playlistJob, done: i + 1, current: title, step: `${i + 1}/${total} · ya estaba descargado` };
        continue;
      }
      playlistJob = { ...playlistJob, current: title, step: `${i + 1}/${total} · ${title}` };
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadVideoFile({
        bin,
        url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
        videoId: item.id,
        onStep: (step) => {
          playlistJob = { ...playlistJob, step: `${i + 1}/${total} · ${step}` };
        }
      });
      if (r.ok) downloaded += 1;
      else failures.push({ id: item.id, title, error: r.error || 'falló' });
      playlistJob = { ...playlistJob, done: i + 1, failures };
    }

    playlistJob = {
      ...playlistJob,
      running: false,
      step: '',
      current: '',
      failures,
      finishedAt: Date.now(),
      result: {
        ok: total > 0 && downloaded + already > 0,
        downloaded,
        already,
        total,
        failed: failures.length,
        failures: failures.slice(0, 5),
        error:
          total === 0
            ? 'La lista no tiene vídeos que se puedan descargar (todos son directos o privados).'
            : downloaded + already === 0
              ? `No se pudo descargar ninguno de los ${total} vídeos.`
              : ''
      }
    };
  })().catch((err) => {
    playlistJob = { ...playlistJob, running: false, step: '', result: { ok: false, error: err.message } };
  });

  return { ...playlistDownloadState() };
}

/**
 * Estado listo para emitir un vídeo ya descargado: se repite desde el disco.
 * Sin caducidad (no hay URL firmada) y sin volver a llamar a yt-dlp.
 */
export function cachedVideoState(videoId, extra = {}) {
  const cached = cachedVideoInfo(videoId);
  if (!cached) return null;
  const duration = Number(cached.duration_sec) || Number(extra.duration_sec) || 0;
  return {
    ok: true,
    live: false,
    mode: 'video',
    provider: 'youtube',
    // Ruta local: `-stream_loop -1 -re` la repite sin fin.
    url: cached.path,
    local: true,
    title: String(extra.title || cached.title || ''),
    video_id: cached.video_id,
    uploader: String(extra.uploader || ''),
    duration_sec: duration,
    vcodec: cached.vcodec,
    acodec: cached.acodec,
    copy_video: true,
    copy_audio: true,
    copy_kind: 'local',
    needs_transcode: false,
    bytes: cached.bytes,
    using_cookies: Boolean(extra.using_cookies),
    // Far future: no se renueva nunca (el archivo no caduca).
    expires_at_ms: 0,
    live_status: 'not_live',
    resolved_at_ms: Date.now()
  };
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

// ============================================================================
// «No hay nada que emitir»: explicar el motivo REAL
// ============================================================================
// yt-dlp con --ignore-no-formats-error devuelve la ficha igual aunque YouTube no
// dé ni una pista. Ahí el texto de yt-dlp (stderr), `availability` y los campos
// de la ficha dicen exactamente por qué. Antes se enseñaba un cajón de sastre
// («es privado, restricción de edad o de país…») y el operador se quedaba sin
// saber si el problema eran SUS cookies.
export function diagnoseNoMedia(
  entry,
  stderr,
  { usingCookies = false, cookies = null, clientsTried = '', stderrAll = '' } = {}
) {
  const own = String(stderr || '');
  // El motivo puede estar en la salida del intento que trajo la ficha o en la
  // de otro cliente de la cadena: se miran las dos (antes se perdía el
  // «Sign in to confirm you're not a bot» y salía el cajón de sastre).
  const err = [own, String(stderrAll || '')].filter(Boolean).join(' ');
  const availability = String(entry?.availability || '').toLowerCase();
  const reasons = [];
  const has = (re) => re.test(err);
  const botCheck = isBotCheckError(err);

  if (has(/sign in to confirm your age|age-restricted|confirm your age|inappropriate for some users/i) || Number(entry?.age_limit) >= 18) {
    reasons.push('tiene restricción de edad (YouTube exige una cuenta con la edad confirmada)');
  } else if (botCheck) {
    reasons.push('YouTube pide verificación anti-robots a la IP de este servidor');
  } else if (has(/sign in|login required|please log in/i)) {
    reasons.push('YouTube exige una sesión iniciada para entregarlo');
  }
  if (availability === 'private' || has(/private video/i)) reasons.push('es privado');
  if (availability === 'premium_only' || has(/premium|music premium|paid/i)) reasons.push('es sólo para suscriptores de pago');
  if (availability === 'subscriber_only' || has(/members-only|join this channel|channel members/i)) reasons.push('es sólo para miembros del canal');
  if (has(/(?:not|isn.t|has not).{0,40}available in your country|geo.?restrict|blocked (?:it )?in your country/i)) {
    reasons.push('está bloqueado en el país de este servidor');
  }
  if (has(/video unavailable|has been removed|does not exist|no longer available/i)) reasons.push('ya no existe o YouTube lo ha retirado');
  if (has(/live event will begin|premieres in|upcoming/i)) reasons.push('aún no ha empezado');

  // Formatos sin URL = YouTube los firma con PO token / SABR y yt-dlp no los abre.
  const formats = Array.isArray(entry?.formats) ? entry.formats : [];
  const withUrl = formats.filter((f) => /^https?:/i.test(String(f?.url || ''))).length;
  const poToken = formats.length > 0 && withUrl === 0;

  let message;
  if (botCheck) {
    // El anti-robots se explica aparte: si las cookies son buenas, el culpable
    // es la IP del servidor y no hay que pedir que se reexporten.
    message = explainBotCheck({ cookies: cookies || cookiesInfo(), usingCookies, clientsTried });
    const otros = reasons.filter((r) => !/anti-robots/.test(r));
    if (otros.length) message = `YouTube no entrega este vídeo porque ${otros.join(', ')}. ${message}`;
  } else if (reasons.length) {
    // Si el motivo es de sesión y hay cookies puestas, hay que decir que NO valen.
    const sessionIssue = reasons.some((r) => /sesión|edad|miembros|suscriptores/.test(r));
    message = `YouTube no entrega este vídeo porque ${reasons.join(', ')}.`;
    if (sessionIssue) {
      if (!usingCookies) {
        message +=
          ' Sube cookies de una cuenta con acceso (botón «Subir cookies»): el panel las usará solo y volverá a ' +
          'comprobar el enlace.';
      } else if (cookies && cookies.expired_auth) {
        message +=
          ' Las cookies que tienes subidas están CADUCADAS: vuelve a exportarlas de youtube.com con la sesión ' +
          'iniciada (Subir cookies) y prueba otra vez.';
      } else if (cookies && !cookies.auth) {
        message +=
          ' Las cookies subidas no traen la sesión de YouTube (falta SID/__Secure-3PSID): expórtalas con la ' +
          'cuenta ya iniciada.';
      } else {
        message +=
          ' Tienes cookies subidas, pero esa cuenta no tiene acceso a este vídeo (o la sesión ya no vale): ' +
          'comprueba que la cuenta puede verlo en el navegador y vuelve a exportar las cookies.';
      }
    }
  } else if (poToken) {
    message =
      `YouTube ha dado ${formats.length} pistas pero NINGUNA con URL utilizable (las firma con PO token). ` +
      'Pulsa «Actualizar yt-dlp»; si sigue igual, prueba otro enlace o espera: YouTube cambia esto cada pocas semanas.';
  } else if (formats.length === 0) {
    message =
      'YouTube no ha entregado ninguna pista de vídeo para este enlace' +
      (err ? ` (${lastLines(err, 2)})` : '') +
      (clientsTried ? ` Probado con los clientes: ${clientsTried}.` : '') +
      ' Suele ser una restricción del propio vídeo, el control anti-robots de YouTube o una versión vieja de yt-dlp.';
  } else {
    message = 'Este enlace no ofrece ninguna pista que se pueda emitir (HLS o MP4 progresivo).';
  }

  const cookiesGood = Boolean(cookies && cookies.auth && !cookies.expired_auth);
  const sessionIssue = reasons.some((r) => /sesión|edad|miembros|suscriptores/.test(r));
  return {
    message,
    reasons,
    po_token: poToken,
    blocked_bot: botCheck,
    formats_total: formats.length,
    formats_with_url: withUrl,
    availability,
    age_limit: Number(entry?.age_limit) || 0,
    // Con cookies buenas no se piden más cookies: el problema es la IP.
    needs_cookies: botCheck ? !cookiesGood : sessionIssue && (!usingCookies || !cookiesGood),
    // Un yt-dlp nuevo trae clientes nuevos: es lo primero que se puede probar.
    needs_format_fix: poToken || botCheck,
    detail: (own || err) ? ((own || err).length > 240 ? `${(own || err).slice(0, 240)}…` : own || err) : ''
  };
}

// ============================================================================
// «Requested format is not available»
// ============================================================================
// yt-dlp con -J también elige un formato por su cuenta. Si YouTube no le da
// ninguno que encaje —los directos que exigen PO token, o cuando la sesión de
// las cookies no ve las pistas de vídeo— aborta con «Requested format is not
// available» aunque la ficha del vídeo sea perfectamente válida. El panel no
// necesita esa elección (elige él sus pistas), así que se le dice a yt-dlp que
// no se queje y, si aun así no hay ni una pista con URL, se reintenta con otros
// clientes de YouTube: cambia cada pocas semanas cuál funciona sin PO token.
export function isFormatError(text) {
  return /requested format is not available|no video formats found|requested format not (?:available|found)/i.test(
    String(text || '')
  );
}

// Clientes que se prueban, en orden. El primero es el de siempre (sin tocar
// nada); los demás sólo se usan si el anterior no dio ni una pista con URL.
// El control anti-robots de YouTube («Sign in to confirm you're not a bot») no
// es igual para todos: lo que el cliente por defecto no entrega, `tv`, `mweb` o
// `tv_samsung` sí lo dan a menudo desde la misma IP. Por eso la cadena es larga
// y cada cliente se prueba también sin cookies (ver resolveLiveSource).
export const YT_CLIENT_CHAIN = [
  { label: 'normal', extractorArgs: '' },
  { label: 'tv', extractorArgs: 'youtube:player_client=tv' },
  { label: 'web_safari', extractorArgs: 'youtube:player_client=web_safari' },
  { label: 'ios', extractorArgs: 'youtube:player_client=ios' },
  { label: 'mweb', extractorArgs: 'youtube:player_client=mweb' },
  { label: 'tv_samsung', extractorArgs: 'youtube:player_client=tv_samsung' }
];

// Tiempo máximo para recorrer la cadena entera (vídeo suelto y lista). Sin tope,
// con seis clientes y dos modos (con/sin cookies) una comprobación podría
// tardar diez minutos y la pantalla se quedaría colgada.
const PROBE_BUDGET_MS = Number(process.env.TVLISTER_YT_PROBE_BUDGET_MS || 90000);
const PLAYLIST_BUDGET_MS = Number(process.env.TVLISTER_YT_PLAYLIST_BUDGET_MS || 300000);
// Por debajo de esto ya no se arranca otro cliente: no daría tiempo a nada.
const PROBE_MIN_ATTEMPT_MS = 8000;

/** ¿La respuesta de yt-dlp trae alguna pista con URL que se pueda emitir? */
export function hasUsableMedia(info) {
  if (!info || typeof info !== 'object') return false;
  if (Array.isArray(info.entries)) return info.entries.some((e) => e && hasUsableMedia(e));
  if (/m3u8|hls/i.test(String(info.manifest_url || ''))) return true;
  if (/^https?:/i.test(String(info.url || ''))) return true;
  const formats = Array.isArray(info.formats) ? info.formats : [];
  return formats.some((f) => f && /^https?:/i.test(String(f?.url || '')));
}

/**
 * ¿El vídeo está cerrado por algo que NO depende del cliente de YouTube?
 * Privado, retirado, sólo para miembros/suscriptores de pago o aún no emitido:
 * probar seis clientes no cambia nada.
 */
export function isDefinitiveBlock(info, stderr) {
  const err = String(stderr || '');
  if (
    /private video|has been removed|does not exist|no longer available|terminated|account .{0,20}closed|members-only|join this channel|premium|paid members|upcoming|premieres in|will begin/i.test(
      err
    )
  ) {
    return true;
  }
  const av = String(info?.availability || '').toLowerCase();
  return av === 'private' || av === 'premium_only' || av === 'subscriber_only';
}

/**
 * ¿Merece la pena reintentar con otro cliente de YouTube?
 *
 * Ojo: con `--ignore-no-formats-error` yt-dlp devuelve la ficha del vídeo
 * aunque YouTube no dé NI UNA pista, y sale con código 0. Esa ficha vacía no
 * significa que el vídeo no se pueda emitir: significa que ese cliente no
 * recibió pistas (anti-robots, PO token, SABR…). Antes se daba por perdido y el
 * operador veía «ninguna pista de vídeo» con los otros cinco clientes sin
 * probar. Sólo un bloqueo definitivo (privado, retirado, de pago, futuro) corta
 * la cadena.
 */
export function shouldRetryWithOtherClient(info, stderr) {
  const err = String(stderr || '');
  if (isFormatError(err)) return true;
  // El anti-robots cambia según el cliente: nunca se da por perdido.
  if (isBotCheckError(err)) return true;
  if (!info || typeof info !== 'object') return false;
  if (hasUsableMedia(info)) return false;
  if (isDefinitiveBlock(info, err)) return false;
  if (Array.isArray(info.entries) && info.entries.length) return true;
  // Ficha sin ninguna pista, o con pistas sin URL (PO token / SABR): otro
  // cliente puede sí entregarlas.
  return true;
}

// ============================================================================
// DIAGNÓSTICO: qué ve de verdad yt-dlp (y si las cookies sirven)
// ============================================================================
// Cuando YouTube no entrega nada, lo único honesto es enseñar lo que responde
// el propio yt-dlp (`-F`) en vez de adivinar. Y para las cookies, probarlas de
// verdad: el panel las pasa a yt-dlp contra un vídeo público y mira si salen
// formatos (una sesión caducada sigue teniendo SID, pero no abre nada).
const COOKIE_TEST_URL = String(
  process.env.TVLISTER_YTDLP_TEST_URL || 'https://www.youtube.com/watch?v=BaW_jenozKc'
);

/** Recorta la salida de `yt-dlp -F` a lo útil (sin avisos ni rutas internas). */
export function trimFormatList(text, maxLines = 60) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => !/^\[debug\]|^WARNING:/i.test(l.trim()))
    .slice(0, maxLines)
    .join('\n')
    .trim();
}

/**
 * Lista de formatos que ofrece YouTube para un enlace (`yt-dlp -F`).
 * Devuelve `{ ok, text, error, using_cookies }`.
 */
export async function listFormats(rawUrl, { timeoutMs = 60000 } = {}) {
  const cls = classifySourceUrl(rawUrl);
  if (!cls.ok) return { ok: false, text: '', error: cls.error, using_cookies: false };
  const bin = findYtDlp();
  if (!bin) return { ok: false, text: '', error: 'Falta yt-dlp: instálalo con «Instalar yt-dlp».', using_cookies: false };

  const ck = cookiesInfo();
  const usingCookies = Boolean(ck.exists && ck.ok);
  // La tabla se pide con los mismos clientes que usa la comprobación: si sólo
  // se enseñaba el intento del cliente por defecto, el operador veía el
  // «Sign in to confirm you're not a bot» y creía que el panel no veía nada,
  // cuando con `tv` sí había formatos.
  const errors = [];
  let text = '';
  let client = '';
  let botCheck = false;
  const deadline = Date.now() + PROBE_BUDGET_MS;
  for (const c of YT_CLIENT_CHAIN) {
    const remaining = deadline - Date.now();
    if (remaining < PROBE_MIN_ATTEMPT_MS) break;
    const args = ['-F', '--no-warnings', '--no-progress', '--no-config', '--no-playlist'];
    if (usingCookies) args.push('--cookies', ck.path);
    if (c.extractorArgs) args.push('--extractor-args', c.extractorArgs);
    args.push(cls.url);
    // eslint-disable-next-line no-await-in-loop
    const res = await runBinary(bin, args, { timeoutMs: Math.min(timeoutMs, remaining) });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    const hasTable = /\b(?:mp4|webm|m4a|audio only)\b/i.test(String(res.stdout || ''));
    if (res.ok && hasTable) {
      return {
        ok: true,
        text: trimFormatList(out),
        error: '',
        client: c.label,
        bot_check: isBotCheckError(out),
        using_cookies: usingCookies,
        url: cls.url,
        clients_tried: YT_CLIENT_CHAIN.map((x) => x.label).join(', ')
      };
    }
    const errText = lastLines(`${res.stderr || ''}${res.stdout || ''}`, 3);
    errors.push({ client: c.label, error: errText });
    if (!text) {
      text = trimFormatList(out);
      client = c.label;
    }
    botCheck = botCheck || isBotCheckError(out);
    // Un bloqueo que ningún cliente arregla (privado, retirado) no se repite.
    if (!isBotCheckError(out) && !isFormatError(out) && res.ok) break;
  }
  return {
    ok: false,
    text,
    error:
      (errors.length ? errors[errors.length - 1].error : '') ||
      (botCheck
        ? 'YouTube pide verificación anti-robots a la IP de este servidor (no es un problema de la lista).'
        : 'yt-dlp no pudo listar los formatos.'),
    client,
    bot_check: botCheck,
    using_cookies: usingCookies,
    url: cls.url,
    clients_tried: errors.map((e) => e.client).join(', ')
  };
}

/**
 * ¿Las cookies guardadas sirven de algo? Se prueba con un vídeo público de
 * YouTube: si devuelve formatos, yt-dlp está viendo YouTube con esa sesión.
 */
export async function testCookies({ timeoutMs = 45000 } = {}) {
  const ck = cookiesInfo();
  if (!ck.path) return { ok: false, error: 'No hay cookies guardadas.', cookies: ck };
  if (!ck.exists) return { ok: false, error: 'El archivo de cookies no existe en el servidor.', cookies: ck };
  if (!ck.ok) return { ok: false, error: ck.error || 'El archivo de cookies no sirve.', cookies: ck };
  const bin = findYtDlp();
  if (!bin) return { ok: false, error: 'Falta yt-dlp.', cookies: ck };
  // También aquí se recorre la cadena: si el cliente por defecto está con el
  // anti-robots y `tv` pasa, las cookies SÍ sirven y no hay que reexportarlas.
  let data = null;
  let err = '';
  let client = '';
  let botCheck = false;
  const deadline = Date.now() + PROBE_BUDGET_MS;
  for (const c of YT_CLIENT_CHAIN) {
    const remaining = deadline - Date.now();
    if (remaining < PROBE_MIN_ATTEMPT_MS) break;
    const args = [
      '-J',
      '--no-warnings',
      '--no-progress',
      '--no-config',
      '--no-playlist',
      '--ignore-no-formats-error',
      '--cookies',
      ck.path
    ];
    if (c.extractorArgs) args.push('--extractor-args', c.extractorArgs);
    args.push(COOKIE_TEST_URL);
    // eslint-disable-next-line no-await-in-loop
    const res = await runBinary(bin, args, { timeoutMs: Math.min(timeoutMs, remaining) });
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      parsed = null;
    }
    if (parsed && hasUsableMedia(parsed)) {
      data = parsed;
      client = c.label;
      break;
    }
    err = lastLines(res.stderr, 3) || err;
    botCheck = botCheck || isBotCheckError(res.stderr);
  }
  if (data) {
    return {
      ok: true,
      message:
        `Las cookies funcionan: yt-dlp ha leído «${String(data.title || 'el vídeo de prueba')}» con esa sesión` +
        (client && client !== 'normal' ? ` (cliente ${client}).` : '.'),
      title: String(data.title || ''),
      formats: Array.isArray(data.formats) ? data.formats.length : 0,
      client,
      cookies: ck
    };
  }
  return {
    ok: false,
    // El anti-robots no dice nada de las cookies: lo aplica YouTube por IP.
    bot_check: botCheck,
    error:
      (botCheck
        ? 'Las cookies están puestas, pero YouTube pide verificación anti-robots a la IP de este servidor, así que ' +
          'no deja comprobar la sesión. El problema no es el archivo de cookies: es la IP (suele pasar en servidores).'
        : ck.expired_auth
          ? 'Las cookies están caducadas: vuelve a exportarlas de youtube.com con la sesión iniciada.'
          : 'YouTube no ha entregado nada con estas cookies. Vuelve a exportarlas con la sesión iniciada; si el ' +
            'navegador ve el vídeo y el panel no, la cuenta no tiene acceso o la sesión ya no vale.') +
      (err ? ` (${err})` : ''),
    detail: err,
    cookies: ck
  };
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

  // Sólo se le pasa a yt-dlp un archivo que exista y sea de verdad Netscape con
  // cookies de youtube.com: con un archivo inservible el error es más confuso.
  const cookies = String(cookiesFile || getSetting('youtube_cookies_file') || process.env.TVLISTER_YT_COOKIES || '').trim();
  const ck = cookies ? (cookiesFile ? { path: cookies, exists: fs.existsSync(cookies), ok: fs.existsSync(cookies) } : cookiesInfo()) : null;
  const usingCookies = Boolean(ck?.exists && fs.existsSync(cookies));

  // Un vídeo suelto que ya está descargado se emite desde el disco: no se
  // vuelve a molestar a YouTube (ni cookies, ni clientes, ni caducidades). Sirve
  // igual para watch?v=…, youtu.be/… y /live/…: si el archivo está, manda él.
  if ((cls.kind === 'video' || cls.kind === 'live') && cls.video_id) {
    const cached = cachedVideoInfo(cls.video_id);
    if (cached) return cachedVideoState(cls.video_id, { using_cookies: usingCookies });
  }

  const isPlaylist = cls.kind === 'playlist';
  const baseArgs = [
    '-J',
    '--no-warnings',
    '--no-progress',
    '--no-config',
    // -J elige formato por su cuenta; si YouTube no le da ninguno que encaje
    // aborta con «Requested format is not available» aunque la ficha sea buena.
    // Con esto vuelca la información igual y el panel elige sus propias pistas.
    '--ignore-no-formats-error'
  ];
  if (isPlaylist) {
    // Con --flat-playlist no habría URLs de vídeo: se pide la lista completa
    // (hasta 30) y cada entrada trae ya sus formatos.
    baseArgs.push('--yes-playlist', '--playlist-end', String(MAX_PLAYLIST_ITEMS), '--ignore-errors');
  } else {
    baseArgs.push('--no-playlist');
  }
  // Un intento = recorrer la cadena de clientes con (o sin) cookies.
  const budgetMs = isPlaylist ? PLAYLIST_BUDGET_MS : PROBE_BUDGET_MS;
  const baseTimeout = isPlaylist ? PLAYLIST_TIMEOUT_MS : 45000;
  const attempt = async (withCookies) => {
    let data = null;
    let lastErr = '';
    // `lastErr` tiene que ser el del intento que dio la ficha: si se pisa con el
    // del siguiente cliente, el diagnóstico habla de otro error y se pierde el
    // motivo real (así salía «ninguna pista de vídeo» sin decir del anti-robots).
    let usedClient = '';
    const errors = [];
    const attempts = [];
    const deadline = Date.now() + budgetMs;
    for (const client of YT_CLIENT_CHAIN) {
      const remaining = deadline - Date.now();
      if (remaining < PROBE_MIN_ATTEMPT_MS) break;
      const args = [...baseArgs];
      if (withCookies) args.push('--cookies', cookies);
      if (client.extractorArgs) args.push('--extractor-args', client.extractorArgs);
      args.push(cls.url);

      // eslint-disable-next-line no-await-in-loop
      const res = await runBinary(info.bin, args, { timeoutMs: Math.min(baseTimeout, remaining) });
      let parsed = null;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        parsed = null;
      }
      const errText = String(res.stderr || '').replace(/\s+/g, ' ').trim();
      if (errText) errors.push(errText);
      attempts.push({
        client: client.label,
        cookies: withCookies,
        ok: Boolean(parsed) && !shouldRetryWithOtherClient(parsed, errText),
        error: errText ? (errText.length > 200 ? `${errText.slice(0, 200)}…` : errText) : ''
      });

      if (parsed && !shouldRetryWithOtherClient(parsed, errText)) {
        return { data: parsed, lastErr: errText, usedClient: client.label, attempts, errors };
      }
      // Ningún cliente ha dado nada todavía. Se guarda la primera ficha (es la
      // que luego se diagnostica) con SU salida de error, y se sigue probando.
      if (parsed && !data) {
        data = parsed;
        lastErr = errText;
        usedClient = client.label;
      }
      // Si ni siquiera hay ficha, se sigue igual: otro cliente puede darla.
    }
    // Sin ficha, el último error es el que hay que enseñar.
    return { data, lastErr: data ? lastErr : errors[errors.length - 1] || lastErr, usedClient: usedClient || '', attempts, errors };
  };

  let run = await attempt(usingCookies);
  let data = run.data;
  let lastErr = run.lastErr;
  const attempts = [...run.attempts];
  const errors = [...run.errors];
  // Con cookies a veces va PEOR (una sesión de otra red/país hace que YouTube
  // devuelva cero pistas). Si con ellas no hay nada que emitir, se prueba sin.
  let retriedWithoutCookies = false;
  if (usingCookies && !(data && !shouldRetryWithOtherClient(data, lastErr))) {
    retriedWithoutCookies = true;
    run = await attempt(false);
    attempts.push(...run.attempts);
    errors.push(...run.errors);
    if (run.data && !shouldRetryWithOtherClient(run.data, run.lastErr)) {
      data = run.data;
      lastErr = run.lastErr;
    } else if (!data) {
      data = run.data;
      lastErr = run.lastErr || lastErr;
    }
  }
  // Todas las salidas, sin repetir: el motivo puede estar en cualquier cliente.
  const stderrAll = [...new Set(errors)].join(' ').slice(0, 4000);

  // ¿Se emitió con cookies o hubo que quitarlas?
  const cookiesWorked = usingCookies && attempts.some((a) => a.cookies && a.ok);
  const clientsTried = [...new Set(attempts.map((a) => a.client))].join(', ');
  const cookiesNote = usingCookies
    ? cookiesWorked
      ? 'con cookies'
      : retriedWithoutCookies
        ? 'con cookies y sin ellas'
        : 'con cookies'
    : '';

  if (!data) {
    const err = stderrAll || lastErr;
    const short = err.length > 240 ? `${err.slice(0, 240)}…` : err;
    // Los fallos conocidos se explican con lo que hay que hacer (subir cookies,
    // actualizar yt-dlp), no con el texto en inglés que copia y pega yt-dlp.
    const explained = explainYtDlpError(err, { clientsTried, usingCookies });
    if (explained) {
      return {
        ok: false,
        live: false,
        mode: isPlaylist ? 'playlist' : 'live',
        provider: 'youtube',
        error: explained.message,
        raw: explained.detail,
        needs_cookies: Boolean(explained.needs_cookies),
        needs_format_fix: Boolean(explained.needs_format_fix),
        blocked_bot: Boolean(explained.blocked_bot),
        using_cookies: usingCookies,
        clients_tried: clientsTried
      };
    }
    return {
      ok: false,
      live: false,
      mode: isPlaylist ? 'playlist' : 'live',
      provider: 'youtube',
      error: short
        ? `yt-dlp no pudo leer el enlace: ${short}`
        : 'yt-dlp no devolvió información del enlace (¿el vídeo existe y es público?).',
      raw: short,
      using_cookies: usingCookies,
      clients_tried: clientsTried
    };
  }

  // ── Lista de reproducción ────────────────────────────────────────────────
  const isList = data._type === 'playlist' || (Array.isArray(data.entries) && data.entries.length > 0);
  if (isList) {
    const rawEntries = (data.entries || []).filter(Boolean);
    const entries = [];
    // Vídeos que YouTube sí da (con pistas) pero no como MP4 progresivo: se
    // pueden DESCARGAR una vez y emitir desde el disco (startPlaylistDownload).
    const pending = [];
    const skipReasons = new Map();
    let skippedLive = 0;
    let skippedNoFormat = 0;
    const bump = (reason) => skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
    for (const e of rawEntries) {
      if (entries.length >= MAX_PLAYLIST_ITEMS) break;
      const status = String(e.live_status || '');
      // Un directo dentro de una lista no se puede encolar (su URL caduca y no
      // tiene principio ni fin): se omite y se avisa en la vista previa.
      if (e.is_live === true || e.live_status === 'is_live' || status === 'is_upcoming') {
        skippedLive += 1;
        bump('es un directo');
        continue;
      }
      const eId = safeVideoId(e.id || '');
      // Ya descargado antes: se emite desde el disco (no caduca).
      const cached = eId ? cachedVideoInfo(eId) : null;
      if (cached) {
        entries.push({
          id: eId,
          title: String(e.title || cached.title || `Vídeo ${entries.length + 1}`),
          // Ruta local: el ffconcat del motor la repite en bucle.
          url: cached.path,
          local: true,
          duration_sec: Number(cached.duration_sec) || Number(e.duration) || 0,
          vcodec: cached.vcodec,
          acodec: cached.acodec,
          ext: 'mp4',
          headers: {}
        });
        continue;
      }
      const p = pickProgressive(e);
      if (p && p.url) {
        entries.push({
          id: p.id,
          title: p.title || `Vídeo ${entries.length + 1}`,
          url: p.url,
          local: false,
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
        continue;
      }
      // Sin MP4 progresivo: si hay pistas con URL, se puede descargar.
      // En una lista, `stderrAll` mezcla los errores de todos los vídeos: para el
      // motivo de cada entrada se usa la salida de la lectura que trajo la lista.
      const dx = diagnoseNoMedia(e, lastErr, { usingCookies, cookies: ck, clientsTried });
      const formats = Array.isArray(e.formats) ? e.formats : [];
      const canDownload = formats.length > 0 && (dx.formats_with_url > 0 || dx.po_token === true);
      if (canDownload && eId) {
        pending.push({
          id: eId,
          title: String(e.title || `Vídeo ${pending.length + 1}`),
          duration_sec: Math.round(Number(e.duration) || 0),
          url: `https://www.youtube.com/watch?v=${eId}`,
          reason: dx.reasons[0] || 'no ofrece MP4 progresivo'
        });
        bump(dx.reasons[0] || 'no ofrece MP4 progresivo (sólo DASH/HLS)');
        continue;
      }
      skippedNoFormat += 1;
      bump(dx.reasons[0] || 'no ofrece ningún formato utilizable');
    }

    // Resumen de motivos («12 con restricción de edad · 8 con no ofrece…»).
    const skipSummary = [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([reason, n]) => `${n} ${reason}`)
      .join(' · ');

    const blockedBot = Boolean(stderrAll && isBotCheckError(stderrAll));
    if (!entries.length) {
      return {
        ok: false,
        live: false,
        mode: 'playlist',
        provider: 'youtube',
        title: String(data.title || ''),
        list_id: String(data.id || cls.list_id || ''),
        entry_count: rawEntries.length,
        // Se pueden descargar N vídeos y emitirlos desde el disco.
        pending,
        pending_count: pending.length,
        can_prepare_playlist: pending.length > 0,
        skip_summary: skipSummary,
        // Motivos concretos para que la pantalla no hable de un cajón de sastre.
        reasons: [...skipReasons.keys()].slice(0, 5),
        blocked_bot: blockedBot,
        error:
          rawEntries.length === 0
            ? 'La lista está vacía o es privada: no hay vídeos que emitir.'
            : pending.length
              ? `Los ${rawEntries.length} vídeos de la lista no ofrecen un MP4 progresivo (sólo DASH/HLS). ` +
                `Se pueden descargar una vez (los primeros ${Math.min(pending.length, MAX_PLAYLIST_ITEMS)}) y emitir ` +
                'desde el disco: botón «Preparar lista en el disco». Después no caducan ni dependen de YouTube.'
              : blockedBot
                ? explainBotCheck({ cookies: ck, usingCookies, clientsTried })
                : `Ningún vídeo de la lista se puede emitir${skipSummary ? ` (${skipSummary})` : ''}.`,
        skipped_live: skippedLive,
        skipped_no_format: skippedNoFormat
      };
    }

    const total = entries.reduce((acc, e) => acc + (Number(e.duration_sec) || 0), 0);
    const expires = earliestExpiry(entries);
    const localOnly = entries.length > 0 && entries.every((e) => e.local);
    return {
      ok: true,
      live: false,
      mode: 'playlist',
      // Toda la lista está en el disco: no caduca y no hay que renovar nada.
      local: localOnly,
      pending,
      pending_count: pending.length,
      can_prepare_playlist: pending.length > 0,
      skip_summary: skipSummary,
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
      expires_at_ms: localOnly ? 0 : expires || Date.now() + DEFAULT_TTL_MS,
      live_status: 'playlist',
      using_cookies: usingCookies,
      clients_tried: clientsTried,
      cookies_note: cookiesNote,
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
      // El motivo real sale de yt-dlp: privado, edad, miembros, país, PO token…
      const dx = diagnoseNoMedia(entry, lastErr, { usingCookies, cookies: ck, clientsTried, stderrAll });
      return {
        ok: false,
        live: true,
        mode: 'live',
        provider: 'youtube',
        title,
        live_status: liveStatus,
        error: `El directo está en vivo, pero no se puede emitir: ${dx.message}`,
        reasons: dx.reasons,
        blocked_bot: dx.blocked_bot,
        needs_format_fix: dx.needs_format_fix,
        needs_cookies: dx.needs_cookies,
        detail: dx.detail,
        video_id: String(entry.id || ''),
        clients_tried: clientsTried,
        cookies_note: cookiesNote
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
      using_cookies: usingCookies,
      clients_tried: clientsTried,
      cookies_note: cookiesNote,
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
    const dx = diagnoseNoMedia(entry, lastErr, { usingCookies, cookies: ck, clientsTried, stderrAll });
    // Sólo se ofrece descargar si YouTube SÍ da pistas con URL (DASH/HLS): en un
    // vídeo privado o restringido la descarga tampoco funcionaría.
    const hasFormats = Array.isArray(entry.formats) ? entry.formats.length : 0;
    const downloadable = hasFormats > 0 && (dx.formats_with_url > 0 || dx.po_token === true);
    const cached = cachedVideoInfo(entry.id);
    if (cached) return cachedVideoState(entry.id, { title, uploader, using_cookies: usingCookies });
    return {
      ok: false,
      live: false,
      mode: 'video',
      provider: 'youtube',
      title,
      live_status: liveStatus || 'not_live',
      duration_sec: Math.round(Number(entry.duration) || 0),
      video_id: String(entry.id || ''),
      uploader,
      // Se puede descargar una vez (H.264+AAC) y repetir desde el disco.
      needs_download: downloadable,
      can_download: downloadable,
      reasons: dx.reasons,
      needs_cookies: dx.needs_cookies,
      needs_format_fix: dx.needs_format_fix,
      blocked_bot: dx.blocked_bot,
      detail: dx.detail,
      error: downloadable
        ? 'Este vídeo no ofrece un MP4 progresivo (sólo DASH/HLS en pistas separadas). ' +
          'El panel puede descargarlo una vez (H.264 + AAC, hasta 1080p) y repetirlo desde el disco: ' +
          'botón «Descargar vídeo». Después no caduca y no vuelve a depender de YouTube.'
        : dx.message,
      using_cookies: usingCookies,
      cookies_note: cookiesNote,
      clients_tried: clientsTried
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
    local: false,
    expires_at_ms: prog.expires_at_ms || Date.now() + DEFAULT_TTL_MS,
    using_cookies: usingCookies,
    clients_tried: clientsTried,
    cookies_note: cookiesNote,
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
  // Vídeo descargado: se repite desde el disco, no caduca ni hay que renovar.
  // Sólo se vuelve a mirar si alguien borró el archivo.
  if (st.local) {
    const ents = Array.isArray(st.entries) ? st.entries.filter((e) => e && e.url) : [];
    if (liveModeFor(st) === 'playlist' || ents.length) {
      // Lista en el disco: sólo se vuelve a mirar si falta algún archivo.
      return ents.some((e) => e.local && !fs.existsSync(String(e.url)));
    }
    return !fs.existsSync(String(st.url || ''));
  }
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
    needs_ytdlp: Boolean(res.needs_ytdlp),
    needs_cookies: Boolean(res.needs_cookies),
    needs_format_fix: Boolean(res.needs_format_fix),
    blocked_bot: Boolean(res.blocked_bot),
    reasons: Array.isArray(res.reasons) ? res.reasons : [],
    cookies_note: String(res.cookies_note || ''),
    // Vídeo/listas descargados al disco, o que se pueden descargar/preparar.
    local: Boolean(res.local),
    bytes: Number(res.bytes) || 0,
    can_download: Boolean(res.can_download),
    needs_download: Boolean(res.needs_download),
    can_prepare_playlist: Boolean(res.can_prepare_playlist),
    pending_count: Number(res.pending_count) || 0,
    skip_summary: String(res.skip_summary || ''),
    using_cookies: Boolean(res.using_cookies),
    clients_tried: String(res.clients_tried || '')
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
    needs_transcode: Boolean(st?.needs_transcode),
    // Vídeo descargado al disco: se repite desde ahí, sin caducidad.
    local: Boolean(st?.local),
    local_path: st?.local ? String(st.url || '') : '',
    bytes: Number(st?.bytes) || 0,
    // Se puede descargar (vídeo suelto) o preparar en el disco (lista completa).
    can_download: Boolean(st?.can_download),
    needs_download: Boolean(st?.needs_download),
    can_prepare_playlist: Boolean(st?.can_prepare_playlist),
    pending_count: Number(st?.pending_count) || 0,
    skip_summary: String(st?.skip_summary || ''),
    // YouTube pide verificación anti-robots a la IP del servidor: se puede
    // enseñar en la tarjeta sin volver a comprobar.
    blocked_bot: Boolean(st?.blocked_bot),
    clients_tried: String(st?.clients_tried || '')
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
