import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * Registro de aparatos por MAC (anti-compartición de cuentas).
 *
 * Sustituye al DRM: en vez de cifrar el video, el panel aprende **en qué
 * aparatos vive cada línea**. El aparato se auto-registra la primera vez que se
 * conecta (con su MAC si la app la envía; si no, con una huella estable de
 * modelo + sistema + reproductor) y, cuando la línea llega a su límite de
 * conexiones, el siguiente aparato se queda fuera hasta que el cliente o el
 * proveedor liberen uno.
 *
 * Tres modos (`device_registry_mode`):
 *   off     → no se registra nada (comportamiento antiguo).
 *   monitor → se registra y se avisa, pero NO se corta a nadie. Es el valor por
 *             defecto: permite ver qué aparatos hay antes de activar los cortes.
 *   enforce → se registra y se corta al aparato que pase del límite.
 *
 * Funciona con cualquier cliente (lista M3U, apps Xtream/XUI, MAG/Stalker,
 * Enigma2, WebTV): no hay que cambiar nada en la app.
 */

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

export const REGISTRY_MODES = ['off', 'monitor', 'enforce'];

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
  ).run(key, String(value ?? '').trim());
}

export function getRegistryMode() {
  const mode = getSetting('device_registry_mode').toLowerCase();
  return REGISTRY_MODES.includes(mode) ? mode : 'monitor';
}

export function setRegistryMode(mode) {
  const clean = String(mode || '').toLowerCase();
  if (!REGISTRY_MODES.includes(clean)) {
    throw new Error(`Modo inválido: "${mode}". Usa off, monitor o enforce.`);
  }
  setSetting('device_registry_mode', clean);
  bumpRegistryVersion();
  return clean;
}

function cleanText(value, max = 96) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

/** MAC normalizada `AA:BB:CC:DD:EE:FF`, o '' si no hay una válida. */
export function normalizeMac(raw) {
  const hex = String(raw ?? '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return '';
  const mac = hex.match(/.{2}/g).join(':');
  if (!MAC_RE.test(mac)) return '';
  // MACs de relleno que usan algunos emuladores: no identifican a nadie.
  if (/^(00:00:00|FF:FF:FF)/.test(mac)) return '';
  return mac;
}

/**
 * MAC enviada por el cliente. Se mira todo lo que usan las distintas apps:
 * cabeceras propias, el `Cookie: mac=…` de los MAG/Stalker, el `X-User-Agent`
 * de Stalker (`MAC=…`) y el parámetro `mac` de la URL.
 */
export function macFromRequest(req) {
  const headers = req?.headers || {};
  const candidates = [
    headers['x-mac-address'],
    headers['x-device-mac'],
    headers['x-mac'],
    headers['x-client-mac'],
    headers['mac'],
    headers['x-stalker-mac']
  ];
  const cookie = String(headers.cookie || '');
  const cookieMac = /(?:^|;\s*)mac=([^;]+)/i.exec(cookie);
  if (cookieMac) candidates.push(cookieMac[1]);
  const xua = String(headers['x-user-agent'] || '');
  const xuaMac = /MAC\s*[=:]\s*([0-9A-Fa-f:\-]{12,17})/i.exec(xua);
  if (xuaMac) candidates.push(xuaMac[1]);
  const auth = String(headers.authorization || '');
  const authMac = /^MAC\s+([0-9A-Fa-f:\-]{12,17})/i.exec(auth);
  if (authMac) candidates.push(authMac[1]);
  candidates.push(req?.query?.mac, req?.body?.mac);

  for (const c of candidates) {
    const mac = normalizeMac(c);
    if (mac) return mac;
  }
  return '';
}

/** Modelo/serie que manda Stalker en `X-User-Agent` (`Model: MAG254; Serial: …`). */
function stalkerInfo(req) {
  const xua = String(req?.headers?.['x-user-agent'] || '');
  const model = /model\s*[=:]\s*([^;]+)/i.exec(xua)?.[1]?.trim() || '';
  const serial = /serial\s*[=:]\s*([^;]+)/i.exec(xua)?.[1]?.trim() || '';
  const brand = /brand\s*[=:]\s*([^;]+)/i.exec(xua)?.[1]?.trim() || '';
  return { model: cleanText(model, 48), serial: cleanText(serial, 64), brand: cleanText(brand, 32) };
}

const PLAYER_PATTERNS = [
  [/tivimate/i, 'TiviMate'],
  [/smarters/i, 'IPTV Smarters'],
  [/xc ?iptv|xc-iptv/i, 'XCIPTV'],
  [/iptv ?extreme/i, 'IPTV Extreme'],
  [/ott ?navigator/i, 'OTT Navigator'],
  [/perfect ?player/i, 'Perfect Player'],
  [/gse ?smart|gsesmart/i, 'GSE Smart IPTV'],
  [/kodi/i, 'Kodi'],
  [/vlc/i, 'VLC'],
  [/larix|exoplayer|media3/i, 'Reproductor propio'],
  [/netcast|web0s|webos/i, 'LG TV'],
  [/tizen|smart-tv|samsung/i, 'Samsung TV'],
  [/roku/i, 'Roku'],
  [/appletv|tvos/i, 'Apple TV'],
  [/stwapp|stbapp|mag\d{3}|qtembedded/i, 'MAG/Stalker'],
  [/enigma2|dreambox|vu\+|openatv|openpli|openspa|egami/i, 'Enigma2'],
  [/fire ?tv|aft[bmst]/i, 'Fire TV']
];

const TYPE_PATTERNS = [
  [/^(tivimate|iptv smarters|xc ?iptv|iptv extreme|ott navigator|perfect player|gse smart iptv|kodi|vlc|reproductor propio)$/i, 'app'],
  [/^(mag\/stalker)$/i, 'stb'],
  [/^(enigma2)$/i, 'enigma2'],
  [/^(samsung tv|lg tv)$/i, 'smart-tv'],
  [/^(roku)$/i, 'streaming-box'],
  [/^(apple tv|fire tv)$/i, 'streaming-box']
];

function osFromUa(ua) {
  const t = String(ua || '');
  if (/android/i.test(t)) return /tv|aft|box|shield|mibox/i.test(t) ? 'Android TV' : 'Android';
  if (/iphone|ipad|ipod/i.test(t)) return 'iOS';
  if (/appletv|tvos/i.test(t)) return 'tvOS';
  if (/windows nt/i.test(t)) return 'Windows';
  if (/mac os x|macintosh/i.test(t)) return 'macOS';
  if (/linux/i.test(t)) return 'Linux';
  if (/tizen/i.test(t)) return 'Tizen';
  if (/web0s|webos|netcast/i.test(t)) return 'webOS';
  if (/roku/i.test(t)) return 'Roku OS';
  return '';
}

/**
 * Identifica el aparato a partir de la petición: MAC, marca, modelo, sistema,
 * reproductor y un tipo legible (`stb`, `smart-tv`, `android-box`, `app`, …).
 */
export function identifyRequest(req) {
  const headers = req?.headers || {};
  const ua = cleanText(headers['user-agent'] || '', 200);
  const xua = cleanText(headers['x-user-agent'] || '', 200);
  const stalker = stalkerInfo(req);
  const mac = macFromRequest(req);

  const haystack = `${ua} ${xua} ${stalker.model} ${stalker.brand}`;
  let player = '';
  for (const [re, name] of PLAYER_PATTERNS) {
    if (re.test(haystack)) {
      player = name;
      break;
    }
  }

  const model =
    stalker.model ||
    /(mag\s?\d{3})/i.exec(haystack)?.[1]?.replace(/\s+/g, '').toUpperCase() ||
    /(aft[bmst]\w*)/i.exec(haystack)?.[1]?.toUpperCase() ||
    '';

  const brand =
    stalker.brand ||
    (/samsung/i.test(haystack)
      ? 'Samsung'
      : /\b(lg|web0s|webos|netcast)\b/i.test(haystack)
        ? 'LG'
        : /roku/i.test(haystack)
          ? 'Roku'
          : /amazon|fire ?tv|\baft[bmst]/i.test(haystack)
            ? 'Amazon'
            : // «AppleWebKit» aparece en casi todos los navegadores: sólo cuenta
              // como Apple si de verdad es un iPhone/iPad/Apple TV.
              /appletv|tvos|iphone|ipad|ipod/i.test(haystack)
              ? 'Apple'
              : /xiaomi|mibox/i.test(haystack)
                ? 'Xiaomi'
                : /nvidia|shield/i.test(haystack)
                  ? 'NVIDIA'
                  : /sony/i.test(haystack)
                    ? 'Sony'
                    : /\bmag\s?\d{3}\b/i.test(haystack)
                      ? 'Infomir'
                      : '');

  let type = 'desconocido';
  for (const [re, name] of TYPE_PATTERNS) {
    if (re.test(player)) {
      type = name;
      break;
    }
  }
  if (type === 'desconocido') {
    if (/android/i.test(haystack)) type = /tv|box|aft|shield|mibox/i.test(haystack) ? 'android-box' : 'movil';
    else if (/iphone|ipad|ipod/i.test(haystack)) type = 'movil';
    else if (/mozilla|chrome|firefox|safari|edg\//i.test(haystack)) type = 'navegador';
    else if (ua || xua || mac) type = 'dispositivo';
  }

  // Huella estable sin MAC: modelo + sistema + reproductor. Si dos televisores
  // idénticos del mismo modelo no mandan MAC, comparten huella; por eso la MAC
  // es siempre preferible (y el panel lo dice en la interfaz).
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${stalker.serial}|${model}|${xua}|${ua}`)
    .digest('hex')
    .slice(0, 24);

  return {
    mac,
    fingerprint,
    serial: stalker.serial,
    model: model || player || '',
    brand,
    os: osFromUa(`${ua} ${xua}`),
    player,
    type,
    ua: ua || xua
  };
}

/** Clave con la que se guarda el aparato: MAC si hay, huella si no. */
export function deviceKeyOf(info) {
  return info.mac || `fp:${info.fingerprint}`;
}

export function deviceLimitFor(line) {
  const explicit = Number(line?.device_limit) > 0 ? Number(line.device_limit) : 0;
  const conns = Number(line?.max_connections) > 0 ? Number(line.max_connections) : 1;
  return Math.max(1, Math.min(20, explicit || conns));
}

export function activeDeviceCount(lineId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS c FROM line_devices WHERE line_id = ? AND status = 'active' AND COALESCE(blocked, 0) = 0"
    )
    .get(Number(lineId)).c;
}

// Caché en memoria: `/live/...` se pide por cada segmento HLS. Sin esto,
// habría una consulta (y un posible INSERT) por segmento.
//
// El panel y el CLI corren en procesos distintos: cuando alguien bloquea un
// aparato o cambia el modo, se sube `device_registry_version` en la base de
// datos y aquí se ve al instante (una lectura de una fila, no una consulta por
// segmento a toda la tabla).
let cache = new Map();
let cachedVersion = '';
const CACHE_MS = 60_000;

export function clearRegistryCache() {
  cache = new Map();
  cachedVersion = '';
}

/** Marca el registro como cambiado para que todos los procesos recarguen. */
export function bumpRegistryVersion() {
  setSetting('device_registry_version', String(Date.now()));
  clearRegistryCache();
}

const ISOLATED_INSTANCE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.TVLISTER_REGISTRY_NO_CACHE || '').toLowerCase()
);

function syncCacheVersion() {
  if (ISOLATED_INSTANCE) {
    cache = new Map();
    return;
  }
  try {
    const ver = String(db.prepare("SELECT value FROM settings WHERE key = 'device_registry_version'").get()?.value || '');
    if (ver !== cachedVersion) {
      cache = new Map();
      cachedVersion = ver;
    }
  } catch {
    /* base en migración: se sigue usando la caché actual */
  }
}

function findDevice(lineId, key, mac) {
  const byKey = db
    .prepare('SELECT * FROM line_devices WHERE line_id = ? AND device_id = ?')
    .get(Number(lineId), key);
  if (byKey) return byKey;
  if (mac) {
    return (
      db
        .prepare("SELECT * FROM line_devices WHERE line_id = ? AND mac = ? AND mac <> ''")
        .get(Number(lineId), mac) || null
    );
  }
  return null;
}

function upsertDevice(line, info, key, ip, { auto = true, status = 'active' } = {}) {
  const existing = findDevice(line.id, key, info.mac);
  const fields = {
    device_name: cleanText(info.model || info.player || info.type, 64),
    platform: cleanText(info.os || info.type, 32),
    mac: cleanText(info.mac, 17),
    device_type: cleanText(info.type, 24),
    brand: cleanText(info.brand, 32),
    model: cleanText(info.model, 48),
    os: cleanText(info.os, 32),
    player: cleanText(info.player, 32),
    user_agent: cleanText(info.ua, 200),
    last_ip: cleanText(ip, 64)
  };

  if (existing) {
    db.prepare(
      `UPDATE line_devices
          SET device_name = ?, platform = ?, mac = ?, device_type = ?, brand = ?, model = ?,
              os = ?, player = ?, user_agent = ?, last_ip = ?, last_seen = datetime('now'),
              seen_count = seen_count + 1
        WHERE id = ?`
    ).run(
      fields.device_name || existing.device_name,
      fields.platform || existing.platform,
      fields.mac || existing.mac,
      fields.device_type || existing.device_type,
      fields.brand || existing.brand,
      fields.model || existing.model,
      fields.os || existing.os,
      fields.player || existing.player,
      fields.user_agent || existing.user_agent,
      fields.last_ip || existing.last_ip,
      existing.id
    );
    return db.prepare('SELECT * FROM line_devices WHERE id = ?').get(existing.id);
  }

  const info2 = db
    .prepare(
      `INSERT INTO line_devices
         (line_id, device_id, device_name, platform, mac, device_type, brand, model, os, player,
          user_agent, status, first_ip, last_ip, auto_registered, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      line.id,
      key,
      fields.device_name,
      fields.platform,
      fields.mac,
      fields.device_type,
      fields.brand,
      fields.model,
      fields.os,
      fields.player,
      fields.user_agent,
      status,
      fields.last_ip,
      fields.last_ip,
      auto ? 1 : 0
    );
  return db.prepare('SELECT * FROM line_devices WHERE id = ?').get(Number(info2.lastInsertRowid));
}

/**
 * Resuelve el aparato de una petición y decide si puede entrar.
 *
 * Devuelve `{ ok, mode, device, wouldBlock }`. En modo `monitor` nunca devuelve
 * `ok:false` (pero marca `wouldBlock` para que la interfaz lo pueda contar).
 */
export function resolveDeviceForLine(line, req, { ip = '', touch = true } = {}) {
  const mode = getRegistryMode();
  if (mode === 'off' || !line?.id || !req) return { ok: true, mode, skipped: true };
  syncCacheVersion();

  const info = identifyRequest(req);
  // Sin MAC ni User-Agent no hay nada que identificar: no se inventa un aparato
  // (todos los clientes anónimos acabarían compartiendo la misma huella y se
  // bloquearían entre ellos).
  if (!info.mac && !info.ua) return { ok: true, mode, skipped: true, reason: 'sin_datos' };
  const key = deviceKeyOf(info);
  const cacheKey = `${mode}:${line.id}:${key}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    if (touch && cached.rowId) touchSeen(cached.rowId, ip);
    return { ...cached.result, cached: true };
  }

  const existing = findDevice(line.id, key, info.mac);
  const limit = deviceLimitFor(line);

  // Aparato vetado desde el panel: no vuelve solo aunque quede cupo.
  if (existing && existing.status !== 'active' && existing.revoked_by === 'panel') {
    const result = {
      ok: false,
      mode,
      error: 'device_revoked',
      code: 403,
      message: 'Este aparato fue desvinculado. Contacta con tu proveedor para volver a activarlo.'
    };
    cache.set(cacheKey, { at: Date.now(), result, rowId: existing.id });
    return result;
  }

  if (existing && Number(existing.blocked) === 1) {
    const result = {
      ok: false,
      mode,
      error: 'device_blocked',
      code: 403,
      message: 'Este aparato está bloqueado en el panel. Contacta con tu proveedor.'
    };
    cache.set(cacheKey, { at: Date.now(), result, rowId: existing.id });
    return result;
  }

  const active = activeDeviceCount(line.id);
  const isNew = !existing || existing.status !== 'active';

  if (isNew && active >= limit) {
    const result = {
      ok: mode !== 'enforce',
      mode,
      wouldBlock: true,
      error: 'device_limit',
      code: 403,
      message:
        `Esta línea admite ${limit} aparato(s) y ya hay ${active} registrados. ` +
        'Libera un aparato desde el panel o pide un plan con más conexiones.'
    };
    // En monitor se registra igual para poder verlo en el panel, pero se avisa.
    if (mode === 'monitor') {
      // Se apunta como «pendiente»: se ve en el panel, pero no ocupa cupo ni
      // pasa a estar permitido al cambiar a modo bloquear.
      const row = upsertDevice(line, info, key, ip, { status: 'pending' });
      cache.set(cacheKey, { at: Date.now(), result: { ...result, device: publicDevice(row) }, rowId: row.id });
      return { ...result, device: publicDevice(row) };
    }
    cache.set(cacheKey, { at: Date.now(), result, rowId: existing?.id || null });
    return result;
  }

  // Siempre se pasa por upsert: si el aparato ya estaba, se completan sus datos
  // (una MAC reservada a mano acaba de aprender tipo/marca/modelo al conectar).
  const row = upsertDevice(line, info, key, ip);
  if (touch) touchSeen(row.id, ip);

  const result = { ok: true, mode, device: publicDevice(row), limit };
  cache.set(cacheKey, { at: Date.now(), result, rowId: row.id });
  return result;
}

const lastTouch = new Map();
function touchSeen(rowId, ip) {
  if (!rowId) return;
  const at = lastTouch.get(rowId) || 0;
  if (Date.now() - at < 5 * 60_000) return;
  lastTouch.set(rowId, Date.now());
  try {
    db.prepare("UPDATE line_devices SET last_seen = datetime('now'), last_ip = ? WHERE id = ?").run(
      cleanText(ip, 64),
      rowId
    );
  } catch {
    /* la tabla puede estar siendo migrada */
  }
}

export function publicDevice(row) {
  if (!row) return null;
  return {
    device_id: row.device_id,
    mac: row.mac || '',
    device_name: row.device_name,
    device_type: row.device_type || '',
    brand: row.brand || '',
    model: row.model || '',
    os: row.os || '',
    player: row.player || '',
    platform: row.platform,
    app_version: row.app_version,
    status: row.status,
    blocked: Number(row.blocked) === 1,
    auto_registered: Number(row.auto_registered) === 1,
    seen_count: Number(row.seen_count) || 0,
    ip: row.last_ip,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    revoked_at: row.revoked_at || null
  };
}

export function listLineDevices(lineId) {
  return db
    .prepare('SELECT * FROM line_devices WHERE line_id = ? ORDER BY status ASC, last_seen DESC')
    .all(Number(lineId));
}

/** Alta manual (por si el aparato no manda MAC y hay que fijarlo a mano). */
export function addDeviceManually(lineId, { mac, name = '', type = '' }) {
  const clean = normalizeMac(mac);
  if (!clean) throw new Error('MAC inválida. Formato: AA:BB:CC:DD:EE:FF');
  const row = db
    .prepare('SELECT * FROM line_devices WHERE line_id = ? AND (mac = ? OR device_id = ?)')
    .get(Number(lineId), clean, clean);
  if (row) {
    db.prepare("UPDATE line_devices SET status = 'active', revoked_at = NULL, revoked_by = '' WHERE id = ?").run(row.id);
    bumpRegistryVersion();
    return publicDevice(db.prepare('SELECT * FROM line_devices WHERE id = ?').get(row.id));
  }
  const info = db
    .prepare(
      `INSERT INTO line_devices (line_id, device_id, device_name, mac, device_type, status, auto_registered)
       VALUES (?, ?, ?, ?, ?, 'active', 0)`
    )
    .run(Number(lineId), clean, cleanText(name, 64), clean, cleanText(type, 24));
  bumpRegistryVersion();
  return publicDevice(db.prepare('SELECT * FROM line_devices WHERE id = ?').get(Number(info.lastInsertRowid)));
}

export function setDeviceStatus(lineId, deviceId, status) {
  const clean = String(status || '').toLowerCase();
  if (!['active', 'revoked', 'blocked'].includes(clean)) throw new Error('Estado inválido');
  if (clean === 'blocked') {
    db.prepare('UPDATE line_devices SET blocked = 1 WHERE line_id = ? AND device_id = ?').run(Number(lineId), String(deviceId));
  } else if (clean === 'active') {
    db.prepare(
      "UPDATE line_devices SET status = 'active', blocked = 0, revoked_at = NULL, revoked_by = '' WHERE line_id = ? AND device_id = ?"
    ).run(Number(lineId), String(deviceId));
  } else {
    db.prepare(
      "UPDATE line_devices SET status = 'revoked', revoked_at = datetime('now'), revoked_by = 'panel' WHERE line_id = ? AND device_id = ?"
    ).run(Number(lineId), String(deviceId));
  }
  bumpRegistryVersion();
  return true;
}

export function removeDeviceRow(lineId, deviceId) {
  const info = db
    .prepare('DELETE FROM line_devices WHERE line_id = ? AND device_id = ?')
    .run(Number(lineId), String(deviceId));
  bumpRegistryVersion();
  return info.changes > 0;
}

export function resetLineDevices(lineId) {
  const info = db
    .prepare(
      "UPDATE line_devices SET status = 'revoked', revoked_at = datetime('now'), revoked_by = 'reset', blocked = 0 WHERE line_id = ? AND status IN ('active','pending')"
    )
    .run(Number(lineId));
  bumpRegistryVersion();
  return info.changes;
}

/** Resumen para el panel: modo, aparatos totales y líneas por encima del límite. */
export function registryOverview() {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS devices,
              SUM(CASE WHEN status = 'active' AND COALESCE(blocked, 0) = 0 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN auto_registered = 1 THEN 1 ELSE 0 END) AS auto
         FROM line_devices`
    )
    .get();
  const byType = db
    .prepare(
      `SELECT COALESCE(NULLIF(device_type, ''), 'desconocido') AS type, COUNT(*) AS n
         FROM line_devices WHERE status = 'active' AND COALESCE(blocked, 0) = 0 GROUP BY type ORDER BY n DESC`
    )
    .all();
  const over = db
    .prepare(
      `SELECT l.id, l.username, l.max_connections, l.device_limit, COUNT(d.id) AS devices
         FROM lines l JOIN line_devices d ON d.line_id = l.id AND d.status = 'active' AND COALESCE(d.blocked, 0) = 0
        GROUP BY l.id
       HAVING devices > COALESCE(NULLIF(l.device_limit, 0), l.max_connections)`
    )
    .all();
  return {
    mode: getRegistryMode(),
    devices: Number(totals.devices) || 0,
    active: Number(totals.active) || 0,
    auto: Number(totals.auto) || 0,
    byType,
    linesOverLimit: over
  };
}
