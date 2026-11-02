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

// Directorio base de los certificados instalados a mano. Se puede mover con
// TVLISTER_TLS_DIR (instalaciones no estándar y pruebas).
const DEFAULT_PATHS = process.env.TVLISTER_TLS_DIR || '/etc/tvlister/tls';

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
    domains: Array.from(
      new Set(
        [getSetting('panel_domain'), getSetting('stream_domain'), getSetting('public_stream_base')]
          .map((d) => String(d || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim())
          .filter(Boolean)
      )
    )
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


function parsePair(cert, key) {
  const x509 = new crypto.X509Certificate(cert);
  const validTo = new Date(x509.validTo);
  const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
  const altNames = String(x509.subjectAltName || '')
    .split(',')
    .map((s) => s.trim().replace(/^DNS:/, ''))
    .filter(Boolean);
  // El CN "de verdad" es el que parece un dominio: un Origin de Cloudflare puede
  // llevar delante CN=Cloudflare Origin SSL Certificate y el dominio detrás.
  const cnCandidates = String(x509.subject)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('CN='))
    .map((l) => l.slice(3).replace(/\\,/g, ',').trim());
  const firstSan = altNames.find((n) => n.includes('.') && !n.startsWith('*.')) || altNames.find((n) => n.includes('.'));
  const commonName = cnCandidates.find((c) => c.includes('.')) || firstSan || cnCandidates[0] || '';
  const issuer = String(x509.issuer);
  return {
    subject: String(x509.subject),
    issuer,
    domain: commonName,
    altNames,
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft,
    selfSigned: x509.subject === x509.issuer,
    isCloudflareOrigin: /cloudflare origin|origin ssl/i.test(issuer)
  };
}

function hostCoveredBy(host, meta) {
  const target = String(host || '').toLowerCase();
  if (!target) return false;
  if (target === meta.domain.toLowerCase()) return true;
  for (const name of meta.altNames) {
    const n = name.toLowerCase();
    if (n === target) return true;
    if (n.startsWith('*.')) {
      const suffix = n.slice(1);
      if (target.endsWith(suffix) && !target.slice(0, -suffix.length).includes('.')) return true;
    }
  }
  return false;
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
      // Distinguir «no está» de «está pero no se puede leer»: si el panel corre
      // como usuario sin permisos sobre /etc/tvlister, el mensaje lo dice.
      let reason = '';
      try {
        if (fs.existsSync(candidate.certPath) && fs.existsSync(candidate.keyPath)) reason = ' (sin permiso de lectura)';
      } catch {
        reason = '';
      }
      tried.push(candidate.certPath + reason);
      continue;
    }
    try {
      const secureContext = tls.createSecureContext({ cert: pair.cert, key: pair.key });
      const meta = parsePair(pair.cert, pair.key);
      const ctx = {
        ok: true,
        secureContext,
        cert: pair.cert,
        key: pair.key,
        certPath: candidate.certPath,
        keyPath: candidate.keyPath,
        source: candidate.source,
        ...meta,
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

/* ------------------------------------------------------------------ *
 * Certificados por dominio (SNI)
 *
 * Un servidor con un solo certificado no sirve cuando el panel y el video
 * usan CA distintas: el panel detrás de Cloudflare puede ir con un Origin
 * Certificate (CA privada de Cloudflare, válida porque quien valida es
 * Cloudflare), pero el dominio de video se conecta DIRECTO desde los
 * reproductores y necesita una CA pública (Let's Encrypt). Con SNI, el mismo
 * 443 entrega el certificado de cada nombre y los dos casos conviven.
 * ------------------------------------------------------------------ */

const CERT_ROOT = path.join(DEFAULT_PATHS, 'certs');
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function readExtraCerts() {
  try {
    const raw = getSetting('tls_certs');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.host && e.certPath && e.keyPath) : [];
  } catch {
    return [];
  }
}

function writeExtraCerts(list) {
  setSetting('tls_certs', JSON.stringify(list));
  invalidateSniCache();
}

function safeDirName(host) {
  return String(host || '').toLowerCase().replace(/[^a-z0-9.-]/g, '_').slice(0, 120) || 'cert';
}

/**
 * Guarda un certificado pegado en consola (Cloudflare Origin Certificate,
 * Let's Encrypt, acme.sh…) y lo asocia a un nombre.
 */
export function installCertificate({ host, certPem, keyPem, source = 'consola' }) {
  const name = String(host || '').trim().toLowerCase();
  const baseName = name.startsWith('*.') ? name.slice(2) : name;
  if (!HOST_RE.test(baseName)) throw new Error(`Nombre inválido: "${host}". Ejemplo: tvadmin.alphadigitalnic.xyz`);

  const cert = String(certPem || '').trim();
  const key = String(keyPem || '').trim();
  if (!cert.includes('BEGIN CERTIFICATE')) throw new Error('El certificado no parece un PEM (falta "BEGIN CERTIFICATE").');
  if (!/BEGIN (RSA |EC |)PRIVATE KEY/.test(key)) throw new Error('La clave no parece un PEM (falta "BEGIN ... PRIVATE KEY").');

  try {
    tls.createSecureContext({ cert, key });
  } catch (err) {
    throw new Error(`El certificado y la clave no forman un par válido: ${err.message}`);
  }

  const meta = parsePair(cert, key);
  const covered = name.startsWith('*.') ? hostCoveredBy(`x.${name.slice(2)}`, meta) : hostCoveredBy(name, meta);
  if (!covered) {
    throw new Error(
      `El certificado no cubre ${name} (nombres: ${[meta.domain, ...meta.altNames].filter(Boolean).join(', ')}).`
    );
  }

  const dir = path.join(CERT_ROOT, safeDirName(name));
  const certPath = path.join(dir, 'fullchain.pem');
  const keyPath = path.join(dir, 'privkey.pem');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(certPath, `${cert}\n`, { mode: 0o600 });
    fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
    fs.chmodSync(certPath, 0o600);
    fs.chmodSync(keyPath, 0o600);
  } catch (err) {
    throw new Error(
      `No se pudo guardar el certificado en ${dir} (${err.code || err.message}). ¿Ejecutaste con sudo?`
    );
  }

  const list = readExtraCerts().filter((e) => e.host !== name);
  list.push({ host: name, certPath, keyPath, source, addedAt: new Date().toISOString() });
  writeExtraCerts(list);

  // Si es el único certificado, también pasa a ser el de por defecto: así el
  // panel arranca en HTTPS aunque no haya nada más configurado.
  if (!getSetting('tls_cert_path')) setTlsPaths(certPath, keyPath);
  invalidateTlsCache();

  return { host: name, certPath, keyPath, ...meta };
}

export function removeCertificate(host) {
  const name = String(host || '').trim().toLowerCase();
  const list = readExtraCerts();
  const entry = list.find((e) => e.host === name);
  if (!entry) throw new Error(`No hay certificado instalado para ${name}.`);
  writeExtraCerts(list.filter((e) => e.host !== name));
  for (const file of [entry.certPath, entry.keyPath]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // si ya no está, da igual
    }
  }
  // Si era el certificado por defecto, se deja de apuntar a un fichero borrado.
  if (getSetting('tls_cert_path') === entry.certPath) {
    delSetting('tls_cert_path');
    delSetting('tls_key_path');
  }
  invalidateTlsCache();
  return { host: name, removed: true };
}

export function listCertificates() {
  const out = [];
  const seen = new Set();

  for (const entry of readExtraCerts()) {
    const pair = readPair(entry.certPath, entry.keyPath);
    if (!pair) continue;
    const meta = parsePair(pair.cert, pair.key);
    seen.add(entry.host);
    out.push({ host: entry.host, certPath: entry.certPath, keyPath: entry.keyPath, source: entry.source, editable: true, ...meta });
  }

  // Certificados detectados solos (Let's Encrypt / acme.sh) para los dominios
  // del panel y del video: se muestran aunque no se hayan instalado a mano.
  const { domains } = getTlsSettings();
  for (const candidate of candidatePairs()) {
    if (!candidate.certPath.startsWith('/etc/letsencrypt') && !candidate.certPath.includes('.acme.sh')) continue;
    const pair = readPair(candidate.certPath, candidate.keyPath);
    if (!pair) continue;
    const meta = parsePair(pair.cert, pair.key);
    const host = domains.find((d) => hostCoveredBy(d, meta));
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ host, certPath: candidate.certPath, keyPath: candidate.keyPath, source: candidate.source, editable: false, ...meta });
  }

  return out;
}

function sniContextFor(host) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '').split(':')[0];
  if (!name) return null;

  const ctxFor = (certPath, keyPath) => {
    const pair = readPair(certPath, keyPath);
    if (!pair) return null;
    try {
      return tls.createSecureContext({ cert: pair.cert, key: pair.key });
    } catch {
      return null;
    }
  };

  // 1) Coincidencia exacta instalada a mano
  const exact = readExtraCerts().find((e) => e.host === name);
  if (exact) {
    const ctx = ctxFor(exact.certPath, exact.keyPath);
    if (ctx) return ctx;
  }

  // 2) Certificado detectado (Let's Encrypt/acme.sh) que cubra el nombre
  for (const candidate of candidatePairs()) {
    if (!candidate.certPath.startsWith('/etc/letsencrypt') && !candidate.certPath.includes('.acme.sh')) continue;
    const pair = readPair(candidate.certPath, candidate.keyPath);
    if (!pair) continue;
    const meta = parsePair(pair.cert, pair.key);
    if (hostCoveredBy(name, meta)) {
      const ctx = ctxFor(candidate.certPath, candidate.keyPath);
      if (ctx) return ctx;
    }
  }

  // 3) Comodín instalado a mano (*.dominio.com)
  for (const entry of readExtraCerts()) {
    const pair = readPair(entry.certPath, entry.keyPath);
    if (!pair) continue;
    const meta = parsePair(pair.cert, pair.key);
    if (hostCoveredBy(name, meta)) {
      const ctx = ctxFor(entry.certPath, entry.keyPath);
      if (ctx) return ctx;
    }
  }

  return null;
}

let sniCache = { at: 0 };

function invalidateSniCache() {
  sniCache = { at: 0 };
}

/**
 * Opciones listas para `https.createServer`: certificado por defecto + SNICallback
 * para que cada nombre reciba el suyo. Si solo hay un certificado, se comporta
 * como siempre.
 */
export function getServerTlsOptions({ force = false } = {}) {
  const ctx = loadTlsContext({ force });
  if (!ctx.ok) return null;

  const options = {
    cert: ctx.cert,
    key: ctx.key,
    SNICallback: (servername, cb) => {
      try {
        const sc = sniContextFor(servername);
        if (sc) return cb(null, sc);
        return cb(null, null); // null ⇒ Node usa el certificado por defecto
      } catch (err) {
        return cb(err);
      }
    }
  };
  return options;
}

export function certForHost(host) {
  return sniContextFor(host) ? true : false;
}
