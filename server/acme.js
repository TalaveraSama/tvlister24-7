import fs from 'node:fs';
import path from 'node:path';

/**
 * Retos HTTP-01 de Let's Encrypt servidos por el propio panel.
 *
 * Cuando el panel ocupa el puerto 80 (`add-port 80 both`), certbot en modo
 * `--standalone` ya no puede escuchar ahí: «Could not bind TCP port 80 because
 * it is already in use». El modo correcto entonces es `--webroot`: certbot deja
 * el token en un directorio y quien tenga el 80 lo publica. Eso es lo que hace
 * este módulo, tanto en el panel (Express) como en el servidor que redirige
 * HTTP→HTTPS del puerto 80.
 *
 * El directorio se puede mover con TVLISTER_ACME_DIR (por defecto
 * /var/www/tvlister-acme, que es lo que usa `tvlister-admin acme`).
 */

export const ACME_ROOT = process.env.TVLISTER_ACME_DIR || '/var/www/tvlister-acme';
export const ACME_CHALLENGE_DIR = path.join(ACME_ROOT, '.well-known', 'acme-challenge');

const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** ¿Es una ruta de reto ACME válida? (sin traversal, sin subrutas) */
export function acmeTokenFromPath(urlPath) {
  const clean = String(urlPath || '').split('?')[0];
  const prefix = '/.well-known/acme-challenge/';
  if (!clean.startsWith(prefix)) return null;
  const token = clean.slice(prefix.length);
  if (!TOKEN_RE.test(token)) return null;
  return token;
}

/** Contenido del reto, o null si no existe. */
export function readAcmeToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  try {
    return fs.readFileSync(path.join(ACME_CHALLENGE_DIR, token), 'utf8');
  } catch {
    return null;
  }
}

/** Crea el directorio (lo usa el CLI antes de lanzar certbot). */
export function ensureAcmeDir() {
  fs.mkdirSync(ACME_CHALLENGE_DIR, { recursive: true, mode: 0o755 });
  return ACME_CHALLENGE_DIR;
}

/**
 * Responde un reto ACME si la petición es una. Devuelve true si contestó.
 * Se usa en el servidor de redirección del puerto 80: ahí el reto debe
 * servirse en claro, NO redirigirse a HTTPS.
 */
export function serveAcmeChallenge(req, res) {
  const token = acmeTokenFromPath(req.url || '');
  if (!token) return false;
  const body = readAcmeToken(token);
  if (body == null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('reto no encontrado\n');
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
}
