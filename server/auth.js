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

// In-memory rate limiters (auto-pruned)
const loginAttempts = new Map(); // ip -> { count, resetAt }
const requestRates = new Map(); // ip -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts.entries()) {
    if (v.resetAt < now) loginAttempts.delete(k);
  }
  for (const [k, v] of requestRates.entries()) {
    if (v.resetAt < now) requestRates.delete(k);
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

export function clearLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

export function signToken(payload) {
  const data = Buffer.from(
    JSON.stringify({
      ...payload,
      exp: Date.now() + 7 * 24 * 3600 * 1000
    })
  ).toString('base64url');
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

export function extractClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return (req.socket?.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
}

const KNOWN_RESTREAM_SCANNERS = ['masscan', 'zgrab', 'censys', 'nmap', 'nikto', 'sqlmap'];

export function firewallMiddleware(req, res, next) {
  if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/firewall')) {
    return next();
  }

  const clientIp = extractClientIp(req);
  const ua = (req.headers['user-agent'] || '').toLowerCase();

  // Flood protection per minute on public IPTV endpoints
  if (
    req.path === '/get.php' ||
    req.path === '/player_api.php' ||
    req.path === '/xmltv.php' ||
    req.path.startsWith('/live/')
  ) {
    const floodSetting = db.prepare("SELECT value FROM settings WHERE key = 'flood_limit_per_min'").get();
    const maxPerMin = Math.max(30, Number(floodSetting?.value) || 180);
    const now = Date.now();
    const rate = requestRates.get(clientIp);
    if (!rate || rate.resetAt < now) {
      requestRates.set(clientIp, { count: 1, resetAt: now + 60_000 });
    } else {
      rate.count += 1;
      if (rate.count > maxPerMin) {
        return res.status(429).json({ error: 'Too many requests (Midnight Flood Protection)' });
      }
    }

    const antiRestream = db.prepare("SELECT value FROM settings WHERE key = 'anti_restreaming'").get();
    if (antiRestream?.value === 'true') {
      for (const sig of KNOWN_RESTREAM_SCANNERS) {
        if (ua.includes(sig)) {
          return res.status(403).send('Forbidden (Scanner Blocked)');
        }
      }
    }
  }

  const rules = db.prepare("SELECT * FROM firewall_rules WHERE action = 'block'").all();
  for (const rule of rules) {
    if (rule.rule_type === 'ip' && rule.value && clientIp === rule.value.trim()) {
      return res.status(403).json({ error: 'Access denied by Midnight Firewall (IP Blocked)' });
    }
    if (rule.rule_type === 'user_agent' && rule.value && ua.includes(rule.value.toLowerCase().trim())) {
      return res.status(403).json({ error: 'Access denied by Midnight Firewall (User-Agent Blocked)' });
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
