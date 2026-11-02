import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { signToken, verifyToken, requireAuth, requireAdmin, extractClientIp } from './auth.js';

// ==================== CÓDIGOS DE ACCESO AL PANEL (estilo XUI.one) ============
// Un código de acceso es una llave previa al login: sin él no se llega ni a la
// pantalla de entrada del panel. Sirve para dejar el panel expuesto a Internet
// sin que cualquiera vea siquiera el formulario.
//
// Diferencias con XUI.one: allí los códigos se escriben en la configuración de
// nginx y hay que recargar el servidor web. Aquí se aplican al instante porque
// los valida el propio TVLister; nginx sólo hace de proxy.

export const ACCESS_COOKIE = 'tvlister_access';
const COOKIE_MAX_AGE = 7 * 24 * 3600; // 7 días (el mismo TTL del token de sesión)

export const ACCESS_TYPES = {
  admin: 'Admin',
  admin_api: 'Admin API',
  reseller: 'Reseller'
};

// Rutas que NO se protegen nunca: si se cerraran, los clientes IPTV dejarían de
// ver la tele. Ninguna de ellas da acceso al panel.
const EXEMPT_EXACT = new Set([
  '/get.php',
  '/player_api.php',
  '/panel_api.php',
  '/xmltv.php',
  '/enigma2.php',
  '/portal.php',
  '/magLoad.php',
  '/server/load.php',
  '/api/health',
  '/access',
  '/favicon.ico'
]);

const EXEMPT_PREFIXES = [
  '/c/',
  '/stalker_portal/',
  '/live/',
  '/movie/',
  '/series/',
  '/timeshift/',
  '/archive_seg/',
  '/mnf/',
  '/hls_proxy/',
  '/hls_out/',
  '/streaming/',
  '/api/webtv/',
  // OJO: /api/auth/ NO va exento. Si el login por API quedara abierto, el código
  // se saltaría con un curl y no protegería nada: la puerta es previa al login.
  '/api/portal',
  '/slates/',
  // Carátulas y pósters servidos por el propio panel: el reproductor los pide
  // ya dentro de la sesión y no deben devolver la página del código.
  '/xui_images/',
  '/vod_local_poster'
];

function isExempt(p) {
  if (EXEMPT_EXACT.has(p)) return true;
  return EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// --- Caché corto: evita consultar la BD en cada segmento o asset -------------
let cache = { expiresAt: 0, ids: new Set(), count: 0 };
export function invalidateAccessCodeCache() {
  cache.expiresAt = 0;
}
function getEnabledCache() {
  const now = Date.now();
  if (cache.expiresAt > now) return cache;
  const rows = db.prepare('SELECT id FROM access_codes WHERE enabled = 1').all();
  cache = { expiresAt: now + 3000, ids: new Set(rows.map((r) => r.id)), count: rows.length };
  return cache;
}

function getSetting(key) {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '');
  } catch {
    return '';
  }
}

export function setPanelSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
  invalidateAccessCodeCache();
}

/** El panel exige código siempre, aunque todavía no se haya creado ninguno. */
export function panelGateForced() {
  return getSetting('panel_gate_required') === '1';
}

/**
 * ¿Hay que pedir código para entrar?
 *  - porque existe al menos uno activo, o
 *  - porque el panel está cerrado a propósito (panel_gate_required=1).
 * El segundo caso es el que permite dejar el panel invisible antes de crear el
 * primer código: nadie entra hasta que se cree uno desde la terminal.
 */
export function accessCodesEnabled() {
  return getEnabledCache().count > 0 || panelGateForced();
}

/** ¿Se pueden crear códigos desde el panel? Por defecto NO: sólo desde terminal. */
export function panelCodeCreationAllowed() {
  return getSetting('access_code_ui_create') === '1';
}

export function panelGateState() {
  const codes = db.prepare('SELECT COUNT(*) AS total, SUM(enabled) AS activos FROM access_codes').get();
  return {
    forced: panelGateForced(),
    gated: accessCodesEnabled(),
    total: Number(codes?.total || 0),
    active: Number(codes?.activos || 0),
    uiCreate: panelCodeCreationAllowed()
  };
}

// --- CRUD ------------------------------------------------------------------
export function listAccessCodes() {
  return db
    .prepare(
      `SELECT id, code, type, enabled, notes, uses, last_used_at, created_at
         FROM access_codes ORDER BY id ASC`
    )
    .all()
    .map((r) => ({ ...r, enabled: !!r.enabled, typeLabel: ACCESS_TYPES[r.type] || r.type }));
}

function normalizeType(type) {
  const t = String(type || 'admin').trim().toLowerCase();
  return ACCESS_TYPES[t] ? t : 'admin';
}

function validateCode(code) {
  const value = String(code || '').trim();
  if (value.length < 4) return { error: 'El código debe tener al menos 4 caracteres.' };
  if (value.length > 64) return { error: 'El código no puede pasar de 64 caracteres.' };
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return { error: 'Sólo se permiten letras, números, punto, guion y guion bajo.' };
  }
  return { value };
}

export function createAccessCode({ code, type = 'admin', enabled = true, notes = '' }) {
  const v = validateCode(code);
  if (v.error) return v;
  const exists = db.prepare('SELECT id FROM access_codes WHERE code = ? COLLATE NOCASE').get(v.value);
  if (exists) return { error: `El código "${v.value}" ya existe.` };
  const info = db
    .prepare('INSERT INTO access_codes (code, type, enabled, notes) VALUES (?, ?, ?, ?)')
    .run(v.value, normalizeType(type), enabled ? 1 : 0, String(notes || ''));
  invalidateAccessCodeCache();
  return { id: Number(info.lastInsertRowid), code: v.value };
}

export function updateAccessCode(id, patch = {}) {
  const row = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(Number(id));
  if (!row) return { error: 'Código no encontrado.' };

  let code = row.code;
  if (patch.code !== undefined && String(patch.code).trim() !== row.code) {
    const v = validateCode(patch.code);
    if (v.error) return v;
    const dup = db.prepare('SELECT id FROM access_codes WHERE code = ? COLLATE NOCASE AND id <> ?').get(v.value, row.id);
    if (dup) return { error: `El código "${v.value}" ya existe.` };
    code = v.value;
  }

  db.prepare('UPDATE access_codes SET code = ?, type = ?, enabled = ?, notes = ? WHERE id = ?').run(
    code,
    patch.type !== undefined ? normalizeType(patch.type) : row.type,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
    patch.notes !== undefined ? String(patch.notes) : row.notes,
    row.id
  );
  invalidateAccessCodeCache();
  return { ok: true, id: row.id };
}

export function deleteAccessCode(id) {
  const info = db.prepare('DELETE FROM access_codes WHERE id = ?').run(Number(id));
  invalidateAccessCodeCache();
  return { ok: true, deleted: Number(info.changes) };
}

// --- Cookie firmada --------------------------------------------------------
function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function cookieTokenFor(codeRow) {
  return signToken({ scope: 'access_code', accessCodeId: codeRow.id, codeType: codeRow.type });
}

function hasValidCookie(req) {
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded || decoded.scope !== 'access_code') return null;
  // El código tiene que seguir existiendo y activo: desactivarlo revoca al instante.
  if (!getEnabledCache().ids.has(decoded.accessCodeId)) return null;
  return decoded;
}

function setCookie(res, req, codeRow) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  const parts = [
    `${ACCESS_COOKIE}=${encodeURIComponent(cookieTokenFor(codeRow))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// --- Anti fuerza bruta -----------------------------------------------------
const attempts = new Map(); // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of attempts.entries()) if (v.resetAt < now) attempts.delete(ip);
}, 60_000).unref();

function checkAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
    return { allowed: true };
  }
  if (entry.count >= 10) {
    return { allowed: false, retrySec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true };
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

function findCode(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const row = db.prepare('SELECT * FROM access_codes WHERE enabled = 1 AND code = ? COLLATE NOCASE').get(value);
  if (!row) return null;
  const a = Buffer.from(row.code.toLowerCase());
  const b = Buffer.from(value.toLowerCase());
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? row : null;
}

function touchCode(row) {
  try {
    db.prepare("UPDATE access_codes SET uses = uses + 1, last_used_at = datetime('now') WHERE id = ?").run(row.id);
  } catch {
    /* el conteo no debe romper el acceso */
  }
}

function safeNext(value) {
  const next = String(value || '/').trim();
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

// --- Página de entrada -----------------------------------------------------
function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderGate({ error = '', next = '/', retry = 0, noCodes = false }) {
  const msg = retry
    ? `Demasiados intentos. Espera ${retry} segundos.`
    : error || '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TVLister — Código de acceso</title>
<link rel="icon" href="data:," />
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:radial-gradient(1200px 600px at 50% -10%,#16203a 0%,#090d16 60%);
       color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{width:100%;max-width:390px;padding:34px 30px;border-radius:16px;background:#0d1322;
        border:1px solid #1e293b;box-shadow:0 24px 60px rgba(0,0,0,.55)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .dot{width:11px;height:11px;border-radius:50%;background:#22d3ee;box-shadow:0 0 12px #22d3ee}
  h1{font-size:19px;margin:0;letter-spacing:.3px}
  p.sub{margin:6px 0 22px;font-size:12.5px;color:#94a3b8;line-height:1.55}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;
        color:#94a3b8;margin-bottom:7px}
  input[type=password],input[type=text]{width:100%;padding:12px 13px;border-radius:9px;
        border:1px solid #24314a;background:#0a1120;color:#e2e8f0;font-size:15px;letter-spacing:.06em}
  input:focus{outline:none;border-color:#22d3ee;box-shadow:0 0 0 3px rgba(34,211,238,.13)}
  button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:9px;cursor:pointer;
         background:#2563eb;color:#fff;font-size:14px;font-weight:600}
  button:hover{background:#1d4ed8}
  .err{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:rgba(244,63,94,.12);
       border:1px solid rgba(244,63,94,.35);color:#fda4af;font-size:12.5px}
  .foot{margin-top:18px;font-size:11px;color:#64748b;text-align:center;line-height:1.5}
  .foot code{display:inline-block;margin-top:6px;padding:4px 7px;border-radius:6px;
       background:#0a1120;border:1px solid #24314a;color:#93c5fd;font-size:10.5px}
</style>
</head>
<body>
  <form class="card" method="POST" action="/access">
    <div class="brand"><span class="dot"></span><h1>TVLister 24/7</h1></div>
    <p class="sub">Panel protegido. Introduce el código de acceso que te dio el administrador.</p>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <label for="code">Código de acceso</label>
    <input id="code" name="code" type="password" autocomplete="current-password" autofocus required />
    <input type="hidden" name="next" value="${esc(next)}" />
    <button type="submit">Entrar</button>
    <div class="foot">${
      noCodes
        ? 'Todavía no hay ningún código creado. Se crean en el servidor:<br><code>tvlister-admin access-code add micodigo admin</code>'
        : 'El código se recuerda 7 días en este navegador.'
    }</div>
  </form>
</body>
</html>`;
}

// --- Middleware ------------------------------------------------------------
export function accessCodeMiddleware(req, res, next) {
  if (!accessCodesEnabled()) return next();
  if (isExempt(req.path)) return next();
  if (hasValidCookie(req)) return next();

  // Código en la URL: ?access=xxx (cómodo para compartir, se guarda en cookie)
  const queryCode = req.query?.access || req.query?.code;
  if (queryCode) {
    const row = findCode(queryCode);
    if (row) {
      setCookie(res, req, row);
      touchCode(row);
      return res.redirect(302, safeNext(req.originalUrl?.split('?')[0] || '/'));
    }
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      error: 'Código de acceso requerido.',
      accessCodeRequired: true
    });
  }

  res
    .status(200)
    .type('html')
    .send(renderGate({ next: safeNext(req.originalUrl || '/'), noCodes: getEnabledCache().count === 0 }));
}

// --- Router: canje del código y administración -----------------------------
export const accessCodesRouter = express.Router();

accessCodesRouter.post('/access', (req, res) => {
  const ip = extractClientIp(req);
  const limit = checkAttempts(ip);
  if (!limit.allowed) {
    return res
      .status(429)
      .type('html')
      .send(renderGate({ next: safeNext(req.body?.next), retry: limit.retrySec }));
  }
  const row = findCode(req.body?.code);
  if (!row) {
    return res
      .status(401)
      .type('html')
      .send(renderGate({ error: 'Código incorrecto o desactivado.', next: safeNext(req.body?.next) }));
  }
  clearAttempts(ip);
  setCookie(res, req, row);
  touchCode(row);
  res.redirect(302, safeNext(req.body?.next));
});

accessCodesRouter.get('/access', (req, res) => {
  res.type('html').send(renderGate({ next: safeNext(req.query?.next || req.originalUrl) }));
});

// Estado para la pantalla del panel (sólo administradores)
accessCodesRouter.get('/api/access-codes', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    codes: listAccessCodes(),
    types: ACCESS_TYPES,
    state: panelGateState()
  });
});

accessCodesRouter.post('/api/access-codes', requireAuth, requireAdmin, (req, res) => {
  if (!panelCodeCreationAllowed()) {
    return res.status(403).json({
      error:
        'Los códigos de acceso se crean sólo desde la terminal del servidor: ' +
        'tvlister-admin access-code add <codigo> [admin|admin_api|reseller] [nota]'
    });
  }
  const result = createAccessCode(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, ...result });
});

accessCodesRouter.put('/api/access-codes/:id', requireAuth, requireAdmin, (req, res) => {
  const result = updateAccessCode(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

accessCodesRouter.delete('/api/access-codes/:id', requireAuth, requireAdmin, (req, res) => {
  const result = deleteAccessCode(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Cerrar el acceso en este navegador (útil para probar el código)
accessCodesRouter.post('/api/access-codes/logout', (req, res) => {
  res.append('Set-Cookie', `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});
