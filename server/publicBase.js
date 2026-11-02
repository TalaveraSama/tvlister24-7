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
 * Base pública para las URLs de STREAMING (playlist, .m3u8, .ts, VOD, catchup,
 * tiempos, portal Stalker y `server_info` de player_api.php).
 *
 * Cuando el panel va detrás de Cloudflare, el video NO debe salir por el mismo
 * dominio: Cloudflare no permite el tráfico de video continuo en los planes
 * self-serve y además mete buffering. Con la clave `public_stream_base`
 * (ej. http://live-stream.midominio.com) todos los enlaces de video apuntan a
 * ese subdominio (DNS only), mientras el panel y su API siguen por el dominio
 * proxied.
 *
 * Sin esa clave se comporta como siempre: mismo host de la petición.
 */
export function getStreamBaseUrl(req) {
  return getConfiguredStreamBase() || getBaseUrl(req);
}
