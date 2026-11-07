import { db } from './db.js';

/**
 * Base de la petición tal cual llega (respetando el proxy inverso).
 * Es la base del PANEL: API, login, descarga de la lista.
 */
export function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol || 'http';
  const host =
    req.headers['x-forwarded-host']?.split(',')[0]?.trim() || req.headers.host || 'localhost:8080';
  return `${proto}://${host}`;
}

/** Ajuste `public_stream_base` ya normalizado ('' si no está fijado). */
export function getConfiguredStreamBase() {
  let configured = '';
  try {
    configured = String(
      db.prepare("SELECT value FROM settings WHERE key = 'public_stream_base'").get()?.value || ''
    ).trim();
  } catch {
    configured = '';
  }
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, '');
  return '';
}

/**
 * Dominio de compatibilidad (tercer dominio).
 *
 * Existe porque hay apps de terceros ya en producción (las que hablan la API de
 * Xtream Codes / XUI.one) que entraron por `livex-stream…` y **no se pueden
 * tocar**: si se les empezara a devolver enlaces del dominio nuevo, dejarían de
 * reproducir. Cuando la petición llega por ese dominio, todo lo que se le
 * contesta vuelve por ese mismo dominio.
 */
export function getCompatDomain() {
  try {
    return String(db.prepare("SELECT value FROM settings WHERE key = 'compat_domain'").get()?.value || '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

/** Host de la petición, sin puerto y en minúsculas. */
export function getRequestHost(req) {
  const raw = String(
    req?.headers?.['x-forwarded-host']?.split(',')[0]?.trim() || req?.headers?.host || ''
  ).toLowerCase();
  return raw.replace(/:\d+$/, '').replace(/\.$/, '');
}

/** ¿Esta petición entra por el dominio de compatibilidad? */
export function isCompatRequest(req) {
  const compat = getCompatDomain();
  if (!compat) return false;
  return getRequestHost(req) === compat;
}

/** ¿Hay certificado instalado (SNI) para ese nombre? Decide http vs https. */
function hasTlsForHost(host) {
  const target = String(host || '').toLowerCase();
  if (!target) return false;
  let list = [];
  try {
    list = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'tls_certs'").get()?.value || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    const name = String(entry?.host || '').toLowerCase();
    if (!name) return false;
    if (name === target) return true;
    if (name.startsWith('*.')) {
      const suffix = name.slice(1);
      return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes('.');
    }
    return false;
  });
}

/**
 * Esquema con el que anunciar un dominio propio.
 *
 * Manda lo que diga la petición (directa o por `X-Forwarded-Proto`, y el panel
 * confía en el proxy). Si llega en claro pero ese nombre tiene certificado
 * instalado, se anuncia igualmente en https: es lo que la app espera y evita
 * enlaces en claro dentro de una lista que se abre por https.
 */
function schemeForHost(req, host) {
  if (req?.secure) return 'https';
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwarded === 'https') return 'https';
  if (forwarded === 'http') return hasTlsForHost(host) ? 'https' : 'http';
  return hasTlsForHost(host) ? 'https' : 'http';
}

/**
 * Base pública para las URLs de STREAMING (playlist, .m3u8, .ts, VOD, catchup,
 * tiempos, portal Stalker y `server_info` de player_api.php).
 *
 * Orden:
 *   1. Si la petición viene del **dominio de compatibilidad**, se responde con
 *      ese dominio (esquema real, sin puerto). Así las apps de terceros que ya
 *      están en producción siguen recibiendo sus enlaces de siempre.
 *   2. Si no, `public_stream_base` (el dominio del video, nube gris).
 *   3. Si no hay nada configurado, el mismo host de la petición.
 *
 * Cuando el panel va detrás de Cloudflare, el video NO debe salir por el mismo
 * dominio: Cloudflare no permite el tráfico de video continuo en los planes
 * self-serve y además mete buffering.
 */
export function getStreamBaseUrl(req) {
  if (isCompatRequest(req)) {
    const compat = getCompatDomain();
    return `${schemeForHost(req, compat)}://${compat}`;
  }
  return getConfiguredStreamBase() || getBaseUrl(req);
}

/** Base pública del panel (login, API, descargas): nunca la de video. */
export function getPanelBaseUrl(req) {
  return getBaseUrl(req);
}
