import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.resolve(__dirname, '../data/.panel_secret');

function loadOrCreateSecret() {
  if (process.env.PANEL_SECRET && process.env.PANEL_SECRET.length >= 16) {
    return process.env.PANEL_SECRET;
  }
  try {
    const dir = path.dirname(SECRET_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(SECRET_FILE)) {
      const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const SECRET_KEY = loadOrCreateSecret();

// Short-TTL in-memory cache for firewall rules & flood settings (avoids SQLite hit per HLS segment)
let fwCache = { expiresAt: 0, rules: [], maxPerMin: 240, antiRestream: true };

export function invalidateFirewallCache() {
  fwCache.expiresAt = 0;
}

function getFirewallSnapshot() {
  const now = Date.now();
  if (fwCache.expiresAt > now) return fwCache;
  const rules = db.prepare("SELECT * FROM firewall_rules WHERE action = 'block'").all();
  const floodRow = db.prepare("SELECT value FROM settings WHERE key = 'flood_limit_per_min'").get();
  const antiRow = db.prepare("SELECT value FROM settings WHERE key = 'anti_restreaming'").get();
  fwCache = {
    expiresAt: now + 5000,
    rules,
    maxPerMin: Math.max(60, Number(floodRow?.value) || 240),
    antiRestream: antiRow?.value !== 'false'
  };
  return fwCache;
}

// In-memory rate limiters (auto-pruned)
const loginAttempts = new Map(); // ip -> { count, resetAt }
const requestRates = new Map(); // bucketKey -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts.entries()) {
    if (v.resetAt < now) loginAttempts.delete(k);
  }
  for (const [k, v] of requestRates.entries()) {
    if (v.resetAt < now) requestRates.delete(k);
  }
  for (const [k, v] of credFailures.entries()) {
    if (v.resetAt < now && (!v.blockedUntil || v.blockedUntil < now)) credFailures.delete(k);
  }
}, 60_000).unref();

export function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
    return { allowed: true };
  }
  if (entry.count >= 12) {
    return { allowed: false, retrySec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

// --- Fallos de credenciales de LÍNEA (HLS, M3U, player_api) ----------------
// Antes sólo el login del panel y el de la WebTV tenían freno: contra
// /get.php o /live se podían probar contraseñas de líneas sin límite. Este
// contador es aparte del del panel y del portal, y sólo suma fallos reales.
const credFailures = new Map(); // ip -> { count, resetAt, blockedUntil }
const CRED_FAIL_WINDOW_MS = 10 * 60_000;
const CRED_FAIL_MAX = 20;
const CRED_BLOCK_MS = 10 * 60_000;

export function checkCredentialGate(ip) {
  const now = Date.now();
  const entry = credFailures.get(ip);
  if (!entry) return { allowed: true };
  if (entry.blockedUntil && entry.blockedUntil > now) {
    return { allowed: false, retrySec: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (entry.resetAt < now) {
    credFailures.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

export function noteCredentialFailure(ip) {
  const now = Date.now();
  const entry = credFailures.get(ip);
  if (!entry || entry.resetAt < now) {
    credFailures.set(ip, { count: 1, resetAt: now + CRED_FAIL_WINDOW_MS, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= CRED_FAIL_MAX) {
    entry.blockedUntil = now + CRED_BLOCK_MS;
    entry.resetAt = now + CRED_FAIL_WINDOW_MS;
  }
}

export function clearCredentialFailures(ip) {
  credFailures.delete(ip);
}

export function clearLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

const TOKEN_DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;

export function signToken(payload, ttlMs = null) {
  // BUG corregido: `exp` del payload se pisaba con 7 días, así que los enlaces
  // de reproducción "de 6 h" duraban una semana. Ahora manda ttlMs, luego el
  // exp explícito del payload y, si no hay ninguno, los 7 días de siempre.
  const { exp: explicitExp, ...rest } = payload || {};
  const exp = explicitExp || Date.now() + (Number(ttlMs) || TOKEN_DEFAULT_TTL_MS);
  const data = Buffer.from(JSON.stringify({ ...rest, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Cryptographic HMAC signing for Upstream HLS Stream Shield URLs (prevents SSRF & hides upstream credentials)
export function signUpstreamUrl(targetUrl, streamId) {
  const encoded = Buffer.from(String(targetUrl), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${streamId}:${encoded}`)
    .digest('base64url')
    .slice(0, 22);
  return { u: encoded, sig };
}

export function verifyUpstreamUrl(encoded, sig, streamId) {
  if (!encoded || !sig) return null;
  const expected = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(`${streamId}:${encoded}`)
    .digest('base64url')
    .slice(0, 22);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const url = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * IP real del cliente detrás de nginx / Cloudflare
 * ---------------------------------------------------------------------------
 * `CF-Connecting-IP` y `X-Forwarded-For` los puede escribir CUALQUIERA. Si se
 * aceptan siempre, basta con mandar la cabecera a mano para saltarse el bloqueo
 * por IP de las líneas (`allowed_ips`), el firewall y el control de sharers:
 * el panel creería que la petición viene de la IP que le digan.
 *
 * Por eso las cabeceras de proxy sólo se creen cuando la conexión llega desde
 * un proxy de confianza: loopback, red privada, o lo que se declare en
 * TVLISTER_TRUSTED_PROXIES (lista separada por comas, admite CIDR).
 * ------------------------------------------------------------------------- */

const normalizeIp = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '');

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip) {
  const clean = ip.split('%')[0];
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    const v = parseInt(g || '0', 16);
    if (Number.isNaN(v)) return null;
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

/** ¿`ip` está dentro de `cidr` (acepta "1.2.3.4" o "1.2.3.0/24", v4 y v6)? */
export function ipInCidr(ip, cidr) {
  const target = normalizeIp(ip);
  const rule = normalizeIp(cidr);
  if (!target || !rule) return false;
  const [base, bitsRaw] = rule.split('/');
  const isV6 = target.includes(':') || base.includes(':');
  const toNum = isV6 ? ipv6ToBigInt : ipv4ToInt;
  const a = toNum(target);
  const b = toNum(base);
  if (a === null || b === null) return false;
  const width = isV6 ? 128 : 32;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return a >> shift === b >> shift;
}

/** Lista de proxies de confianza (variable de entorno, opcional). */
function trustedProxyList() {
  return String(process.env.TVLISTER_TRUSTED_PROXIES || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** ¿La conexión viene de nginx local, de la red privada o de un proxy declarado? */
export function isTrustedProxy(ip) {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  // Nginx y el panel suelen compartir host o VLAN: 10/8, 172.16/12, 192.168/16.
  const privateRanges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10'];
  if (privateRanges.some((c) => ipInCidr(addr, c))) return true;
  return trustedProxyList().some((rule) => ipInCidr(addr, rule));
}

export function extractClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress || '127.0.0.1');

  // Sin proxy de confianza delante, mandar las cabeceras no cambia nada: manda
  // el IP real de la conexión. Evita por completo el spoofing desde Internet.
  if (!isTrustedProxy(socketIp)) return socketIp;

  const cfIp = req.headers?.['cf-connecting-ip'] || req.headers?.['true-client-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return normalizeIp(cfIp);
  }
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return normalizeIp(xff.split(',')[0]);
  }
  const xReal = req.headers?.['x-real-ip'];
  if (typeof xReal === 'string' && xReal.trim()) {
    return normalizeIp(xReal);
  }
  return socketIp;
}

const KNOWN_RESTREAM_SCANNERS = ['masscan', 'zgrab', 'censys', 'nmap', 'nikto', 'sqlmap'];

export function firewallMiddleware(req, res, next) {
  if (req.path === '/api/health' || req.path.startsWith('/api/auth') || req.path.startsWith('/api/firewall')) {
    return next();
  }

  const clientIp = extractClientIp(req);
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const snap = getFirewallSnapshot();

  // CGNAT-safe flood protection on public IPTV discovery endpoints
  if (
    req.path === '/get.php' ||
    req.path === '/player_api.php' ||
    req.path === '/panel_api.php' ||
    req.path === '/xmltv.php' ||
    req.path === '/enigma2.php'
  ) {
    const uKey = String(req.query?.username || 'anon').slice(0, 48);
    const bucketKey = `${clientIp}:${uKey}`;
    const now = Date.now();
    const rate = requestRates.get(bucketKey);
    if (!rate || rate.resetAt < now) {
      requestRates.set(bucketKey, { count: 1, resetAt: now + 60_000 });
    } else {
      rate.count += 1;
      if (rate.count > snap.maxPerMin) {
        return res.status(429).json({ error: 'Too many requests (TVLister Flood Protection)' });
      }
    }
  }

  if (snap.antiRestream) {
    for (const sig of KNOWN_RESTREAM_SCANNERS) {
      if (ua.includes(sig)) {
        return res.status(403).send('Forbidden (Scanner Blocked)');
      }
    }
  }

  for (const rule of snap.rules) {
    if (rule.rule_type === 'ip' && rule.value && clientIp === rule.value.trim()) {
      return res.status(403).json({ error: 'Access denied by TVLister Firewall (IP Blocked)' });
    }
    if (rule.rule_type === 'user_agent' && rule.value && ua.includes(rule.value.toLowerCase().trim())) {
      return res.status(403).json({ error: 'Access denied by TVLister Firewall (User-Agent Blocked)' });
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'No autorizado. Inicia sesión nuevamente.' });
  }
  const user = db.prepare('SELECT id, username, role, credits, email, status FROM users WHERE id = ?').get(decoded.id);
  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Cuenta inactiva o inexistente.' });
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso restringido a Administradores.' });
  }
  next();
}
