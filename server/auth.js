import crypto from 'node:crypto';
import { db } from './db.js';

const SECRET_KEY = process.env.PANEL_SECRET || 'midnight-tvlister-247-hmac-secret-key-v1';

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
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function firewallMiddleware(req, res, next) {
  // Always allow admin auth/firewall management routes so admin cannot lock out UI accidentally on localhost
  if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/firewall')) {
    return next();
  }
  const clientIp = extractClientIp(req);
  const ua = (req.headers['user-agent'] || '').toLowerCase();
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
