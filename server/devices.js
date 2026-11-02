import crypto from 'node:crypto';
import { db } from './db.js';
import { signToken, verifyToken } from './auth.js';

/**
 * Registro de dispositivos por línea (anti-compartición de cuentas).
 *
 * Una línea con `max_connections = 1` se comparte igual si el cliente reparte el
 * usuario y la contraseña entre cinco personas: el panel sólo ve IPs distintas
 * reproduciendo, y el límite de conexiones se lo comen entre todos. Con un
 * registro de dispositivos la regla pasa a ser «esta línea vive en N aparatos»,
 * que es lo que se puede vender, auditar y revocar.
 *
 * Contrato para la app (ver docs/SEGURIDAD_PLAYER_APP_INDICACIONES.md):
 *   POST /player_api.php  action=register_device  -> device_token
 *   POST /player_api.php  action=heartbeat        -> estado de la línea
 *   POST /player_api.php  action=unlink_device    -> libera el aparato
 *
 * El token va firmado (HMAC del panel) y atado a ESTA línea y a ESTE registro.
 * Al revocarlo desde el panel el token deja de valer aunque no haya caducado:
 * la comprobación mira la fila, no sólo la firma.
 */

export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function cleanText(value, max = 96) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeDeviceId(raw) {
  const id = String(raw ?? '').trim();
  return DEVICE_ID_RE.test(id) ? id : '';
}

export function activeDeviceCount(lineId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM line_devices WHERE line_id = ? AND status = 'active'")
    .get(Number(lineId)).c;
}

export function listLineDevices(lineId) {
  return db
    .prepare(
      `SELECT id, device_id, device_name, platform, app_version, status,
              first_ip, last_ip, first_seen, last_seen, revoked_at
         FROM line_devices WHERE line_id = ? ORDER BY status ASC, last_seen DESC`
    )
    .all(Number(lineId));
}

export function publicDevice(row) {
  if (!row) return null;
  return {
    device_id: row.device_id,
    device_name: row.device_name,
    platform: row.platform,
    app_version: row.app_version,
    status: row.status,
    ip: row.last_ip,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    revoked_at: row.revoked_at || null
  };
}

function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Alta (o renovación) del aparato. Devuelve `{ ok, device, token, expires_in }`
 * o `{ ok:false, code, error }` con los motivos que la app debe saber
 * distinguir: `device_limit`, `device_revoked`, `device_invalid`.
 */
export function registerDevice(line, payload = {}, ip = '') {
  const deviceId = normalizeDeviceId(payload.device_id);
  if (!deviceId) {
    return { ok: false, code: 400, error: 'device_invalid', message: 'device_id inválido (8–128 caracteres alfanuméricos)' };
  }
  const limit = Number(line.device_limit) > 0 ? Number(line.device_limit) : 1;
  const existing = db
    .prepare('SELECT * FROM line_devices WHERE line_id = ? AND device_id = ?')
    .get(line.id, deviceId);

  // Desvinculado por el propio cliente desde la app ("unlink_device") o por un
  // reset masivo del panel: puede volver a vincularse. Desvinculado uno a uno
  // por el panel = veto, ese aparato no se re-registra solo.
  const banned = existing && existing.status !== 'active' && existing.revoked_by === 'panel';
  if (banned) {
    return {
      ok: false,
      code: 403,
      error: 'device_revoked',
      message: 'Este aparato fue desvinculado. Contacta con tu proveedor.'
    };
  }
  if (existing && existing.status !== 'active') {
    db.prepare("UPDATE line_devices SET status = 'active', revoked_at = NULL, revoked_by = '' WHERE id = ?").run(existing.id);
    existing.status = 'active';
  }

  if (!existing && activeDeviceCount(line.id) >= limit) {
    return {
      ok: false,
      code: 403,
      error: 'device_limit',
      message: `Esta línea ya está vinculada a ${limit} aparato(s).`
    };
  }

  const deviceName = cleanText(payload.device_name || payload.model, 64);
  const platform = cleanText(payload.platform || payload.os, 32);
  const appVersion = cleanText(payload.app_version || payload.version, 24);
  const nonce = newNonce();

  let rowId;
  if (existing) {
    db.prepare(
      `UPDATE line_devices
          SET device_name = ?, platform = ?, app_version = ?, token_nonce = ?,
              last_ip = ?, last_seen = datetime('now')
        WHERE id = ?`
    ).run(deviceName || existing.device_name, platform || existing.platform, appVersion || existing.app_version, nonce, cleanText(ip, 64), existing.id);
    rowId = existing.id;
  } else {
    const info = db
      .prepare(
        `INSERT INTO line_devices (line_id, device_id, device_name, platform, app_version, token_nonce, first_ip, last_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(line.id, deviceId, deviceName, platform, appVersion, nonce, cleanText(ip, 64), cleanText(ip, 64));
    rowId = Number(info.lastInsertRowid);
  }

  const token = signToken(
    { scope: 'device', id: line.id, dev: rowId, nonce },
    DEVICE_TOKEN_TTL_SECONDS * 1000
  );
  const row = db.prepare('SELECT * FROM line_devices WHERE id = ?').get(rowId);
  return { ok: true, device: publicDevice(row), token, expires_in: DEVICE_TOKEN_TTL_SECONDS, limit };
}

/**
 * Comprueba un token de aparato. `touch` actualiza `last_seen` como mucho una
 * vez cada 5 min (el heartbeat de la app ya lo refresca; esto evita escribir en
 * SQLite por cada segmento HLS).
 */
export function verifyDeviceToken(token, { lineId = null, touch = false } = {}) {
  const payload = verifyToken(String(token || ''));
  if (!payload || payload.scope !== 'device' || !payload.dev || !payload.id) return null;
  if (lineId != null && Number(payload.id) !== Number(lineId)) return null;
  const row = db.prepare('SELECT * FROM line_devices WHERE id = ?').get(Number(payload.dev));
  if (!row) return null;
  if (row.status !== 'active') return { revoked: true, row };
  if (row.line_id !== Number(payload.id)) return null;
  if (row.token_nonce && payload.nonce && row.token_nonce !== payload.nonce) {
    // Se regeneró el token (otro login del mismo aparato): el viejo ya no sirve.
    return { revoked: true, row };
  }
  if (touch) touchDevice(row.id);
  return { row, deviceId: row.device_id };
}

const lastTouch = new Map();
function touchDevice(deviceRowId) {
  const at = lastTouch.get(deviceRowId) || 0;
  if (Date.now() - at < 5 * 60_000) return;
  lastTouch.set(deviceRowId, Date.now());
  db.prepare("UPDATE line_devices SET last_seen = datetime('now') WHERE id = ?").run(deviceRowId);
}

export function touchDeviceByToken(token, ip = '') {
  const res = verifyDeviceToken(token);
  if (!res || res.revoked) return false;
  db.prepare("UPDATE line_devices SET last_seen = datetime('now'), last_ip = ? WHERE id = ?").run(
    cleanText(ip, 64),
    res.row.id
  );
  lastTouch.set(res.row.id, Date.now());
  return true;
}

export function revokeDevice(lineId, deviceId, by = 'panel') {
  const info = db
    .prepare(
      `UPDATE line_devices SET status = 'revoked', revoked_at = datetime('now'), revoked_by = ?
        WHERE line_id = ? AND device_id = ? AND status = 'active'`
    )
    .run(cleanText(by, 64), Number(lineId), String(deviceId));
  return info.changes > 0;
}

export function allowDeviceAgain(lineId, deviceId) {
  const row = db
    .prepare('SELECT * FROM line_devices WHERE line_id = ? AND device_id = ?')
    .get(Number(lineId), String(deviceId));
  if (!row) return false;
  const limit = 20;
  if (activeDeviceCount(lineId) >= limit) return false;
  db.prepare(
    "UPDATE line_devices SET status = 'active', revoked_at = NULL, revoked_by = '', last_seen = datetime('now') WHERE id = ?"
  ).run(row.id);
  return true;
}

export function deleteDevice(lineId, deviceId) {
  db.prepare('DELETE FROM line_devices WHERE line_id = ? AND device_id = ?').run(Number(lineId), String(deviceId));
}

export function resetLineDevices(lineId) {
  return db
    .prepare(
      `UPDATE line_devices SET status = 'revoked', revoked_at = datetime('now'), revoked_by = 'panel-reset'
        WHERE line_id = ? AND status = 'active'`
    )
    .run(Number(lineId)).changes;
}

/** Token que la app manda en cada petición: cabecera primero, luego `device=`. */
export function deviceTokenFromRequest(req) {
  const header = String(req?.headers?.['x-device-token'] || '').trim();
  if (header) return header;
  const q = req?.query?.device_token || req?.body?.device_token;
  return String(q || '').trim();
}

export function lineDeviceLockEnabled(line) {
  return Number(line?.device_lock) === 1;
}
