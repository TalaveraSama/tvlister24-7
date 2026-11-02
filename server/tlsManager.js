import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * Certificados para servir el panel y la API por HTTPS directamente desde
 * Node, sin depender del nginx de XUI ni de Cloudflare.
 *
 * Lo usan los puertos extra del gestor multi-puerto (típicamente 443 y 80):
 * ahí el panel escucha con TLS y entrega lo mismo que en su puerto normal,
 * así los reproductores que exigen el puerto estándar no se quedan fuera.
 *
 * Orden de búsqueda del certificado:
 *   1. Variables de entorno TVLISTER_TLS_CERT / TVLISTER_TLS_KEY.
 *   2. Ajustes del panel `tls_cert_path` / `tls_key_path` (se fijan desde la UI
 *      o con `tvlister-admin tls`).
 *   3. Let's Encrypt: /etc/letsencrypt/live/<dominio>/{fullchain,privkey}.pem
 *   4. acme.sh: ~/.acme.sh/<dominio>{,_ecc}/{fullchain,privkey}.pem
 *   5. /etc/tvlister/tls/{fullchain,privkey}.pem
 *
 * Nunca genera certificados propios: un certificado autofirmado en producción
 * sólo provoca avisos y reproductores que se niegan a conectar. Si no hay
 * certificado, el puerto HTTPS no se abre y la UI dice exactamente qué falta.
 */

const DEFAULT_PATHS = '/etc/tvlister/tls';

function getSetting(key) {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '').trim();
  } catch {
    return '';
  }
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function delSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function getTlsSettings() {
  return {
    certPath: getSetting('tls_cert_path'),
    keyPath: getSetting('tls_key_path'),
    domains: [getSetting('panel_domain'), getSetting('stream_domain'), getSetting('public_stream_base')]
      .map((d) => String(d || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim())
      .filter(Boolean)
  };
}

function readPair(certPath, keyPath) {
  if (!certPath || !keyPath) return null;
  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    if (!cert.includes('BEGIN CERTIFICATE') || !/BEGIN (RSA |EC |)PRIVATE KEY/.test(key)) return null;
    return { cert, key };
  } catch {
    return null;
  }
}

function candidatePairs() {
  const { certPath, keyPath, domains } = getTlsSettings();
  const out = [];

  const envCert = process.env.TVLISTER_TLS_CERT;
  const envKey = process.env.TVLISTER_TLS_KEY;
  if (envCert && envKey) out.push({ certPath: envCert, keyPath: envKey, source: 'variables de entorno' });

  if (certPath && keyPath) out.push({ certPath, keyPath, source: 'rutas configuradas en el panel' });

  for (const domain of domains) {
    out.push({
      certPath: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
      keyPath: `/etc/letsencrypt/live/${domain}/privkey.pem`,
      source: `Let's Encrypt (${domain})`
    });
    for (const suffix of ['_ecc', '']) {
      out.push({
        certPath: path.join(os.homedir(), '.acme.sh', `${domain}${suffix}`, 'fullchain.pem'),
        keyPath: path.join(os.homedir(), '.acme.sh', `${domain}${suffix}`, 'privkey.pem'),
        source: `acme.sh (${domain})`
      });
    }
    const base = path.join(DEFAULT_PATHS, domain);
    out.push({ certPath: `${base}/fullchain.pem`, keyPath: `${base}/privkey.pem`, source: `${DEFAULT_PATHS} (${domain})` });
  }

  out.push({
    certPath: path.join(DEFAULT_PATHS, 'fullchain.pem'),
    keyPath: path.join(DEFAULT_PATHS, 'privkey.pem'),
    source: DEFAULT_PATHS
  });

  return out;
}

let cache = { at: 0, ctx: null };

/**
 * Devuelve el contexto TLS listo para https.createServer o un error explicado.
 * `force` ignora la caché de 60 s (tras cambiar rutas o renovar el certificado).
 */
export function loadTlsContext({ force = false } = {}) {
  if (!force && cache.ctx && Date.now() - cache.at < 60_000) return cache.ctx;

  const tried = [];
  for (const candidate of candidatePairs()) {
    const pair = readPair(candidate.certPath, candidate.keyPath);
    if (!pair) {
      tried.push(candidate.certPath);
      continue;
    }
    try {
      const secureContext = tls.createSecureContext({ cert: pair.cert, key: pair.key });
      const x509 = new crypto.X509Certificate(pair.cert);
      const validTo = new Date(x509.validTo);
      const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
      const altNames = String(x509.subjectAltName || '')
        .split(',')
        .map((s) => s.trim().replace(/^DNS:/, ''))
        .filter(Boolean);
      const commonName = /CN=([^,\n]+)/.exec(String(x509.subject))?.[1] || '';
      const ctx = {
        ok: true,
        secureContext,
        cert: pair.cert,
        key: pair.key,
        certPath: candidate.certPath,
        keyPath: candidate.keyPath,
        source: candidate.source,
        subject: String(x509.subject),
        issuer: String(x509.issuer),
        domain: commonName,
        altNames,
        validFrom: new Date(x509.validFrom).toISOString(),
        validTo: validTo.toISOString(),
        daysLeft,
        selfSigned: x509.subject === x509.issuer,
        error: ''
      };
      cache = { at: Date.now(), ctx };
      return ctx;
    } catch (err) {
      tried.push(`${candidate.certPath} (${err.message})`);
    }
  }

  const ctx = {
    ok: false,
    source: '',
    error: 'No hay certificado TLS legible en el panel.',
    tried
  };
  cache = { at: Date.now(), ctx };
  return ctx;
}

export function invalidateTlsCache() {
  cache = { at: 0, ctx: null };
}

export function setTlsPaths(certPath, keyPath) {
  if (!certPath && !keyPath) {
    delSetting('tls_cert_path');
    delSetting('tls_key_path');
    invalidateTlsCache();
    return loadTlsContext({ force: true });
  }
  const pair = readPair(certPath, keyPath);
  if (!pair) {
    throw new Error('No se puede leer el certificado o la clave en esas rutas (o no son PEM válidos).');
  }
  try {
    tls.createSecureContext({ cert: pair.cert, key: pair.key });
  } catch (err) {
    throw new Error(`El certificado y la clave no forman un par válido: ${err.message}`);
  }
  setSetting('tls_cert_path', certPath);
  setSetting('tls_key_path', keyPath);
  invalidateTlsCache();
  return loadTlsContext({ force: true });
}

/** Vista pública (sin claves) para la API y la UI. */
export function tlsStatus({ force = false } = {}) {
  const ctx = loadTlsContext({ force });
  const { domains } = getTlsSettings();
  if (!ctx.ok) {
    return {
      available: false,
      error: ctx.error,
      tried: ctx.tried || [],
      domains,
      certPath: getSetting('tls_cert_path'),
      keyPath: getSetting('tls_key_path'),
      hint:
        'Instala un certificado (certbot o acme.sh) para el dominio del panel o indica las rutas del fullchain y la privkey.'
    };
  }
  const covered = domains.filter(
    (d) => d === ctx.domain || ctx.altNames.includes(d) || ctx.altNames.includes(`*.${d.split('.').slice(-2).join('.')}`)
  );
  return {
    available: true,
    source: ctx.source,
    certPath: ctx.certPath,
    keyPath: ctx.keyPath,
    subject: ctx.subject,
    issuer: ctx.issuer,
    domain: ctx.domain,
    altNames: ctx.altNames,
    validFrom: ctx.validFrom,
    validTo: ctx.validTo,
    daysLeft: ctx.daysLeft,
    selfSigned: ctx.selfSigned,
    expiresSoon: ctx.daysLeft <= 21,
    expired: ctx.daysLeft < 0,
    domains,
    coveredDomains: covered,
    uncoveredDomains: domains.filter((d) => !covered.includes(d)),
    hint: ctx.daysLeft < 0
      ? 'El certificado está CADUCADO: los reproductores rechazarán la conexión. Renuévalo ya.'
      : ctx.daysLeft <= 21
        ? 'El certificado caduca pronto: renuévalo (certbot renew / acme.sh --renew).'
        : ''
  };
}
