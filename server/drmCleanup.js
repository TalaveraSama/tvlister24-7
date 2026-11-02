import { db } from './db.js';
import { negotiateFlussonic2312Connection, fetchJsonWithTimeout, buildFlussonicClusterAuthHeader } from './flussonic2312Manager.js';

/**
 * Limpieza del DRM retirado.
 *
 * Al borrar el DRM del panel, un Flussonic que ya tenía `drm aes128
 * keyserver=<nuestro CAS>` seguiría cifrando su HLS con un servidor de claves
 * que ya no existe: el cliente vería pantalla en negro. Por eso, al migrar la
 * base de datos se guarda la lista de canales afectados en el ajuste
 * `drm_legacy_streams`, y este módulo **quita** ese bloque del Flussonic.
 *
 * No se toca nada más del canal: se lee el stream, se conservan sus inputs,
 * transcoder, dvr, protocols y options tal cual, y se reescribe sin `drm`.
 */

function legacyPayload() {
  try {
    return JSON.parse(
      String(db.prepare("SELECT value FROM settings WHERE key = 'drm_legacy_streams'").get()?.value || '{}')
    );
  } catch {
    return {};
  }
}

/** Canales que tenían DRM y siguen apuntados en `drm_legacy_streams`. */
export function listLegacyDrmStreams() {
  const data = legacyPayload();
  const rows = Array.isArray(data.streams) ? data.streams : [];
  return rows.map((r) => ({
    stream_id: Number(r.stream_id) || null,
    name: String(r.flussonic_stream || r.flussonic_stream_name || '').trim(),
    mode: String(r.mode || ''),
    flussonic_server_id: Number(r.flussonic_server_id) || null,
    stream_name: String(r.stream_name || '')
  }));
}

/** Campos que Flussonic acepta de vuelta al reescribir un stream. */
function writableFields(remote) {
  const out = {
    name: remote.name,
    title: remote.title,
    static: remote.static,
    inputs: remote.inputs
  };
  for (const k of ['transcoder', 'dvr', 'protocols', 'options']) {
    if (remote[k]) out[k] = remote[k];
  }
  return out;
}

function pickServer({ serverId = null, streamId = null } = {}) {
  if (serverId) {
    return db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(serverId)) || null;
  }
  if (streamId) {
    const st = db.prepare('SELECT flussonic_server_id FROM streams WHERE id = ?').get(Number(streamId));
    if (st?.flussonic_server_id) {
      const srv = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(st.flussonic_server_id));
      if (srv) return srv;
    }
  }
  const all = db.prepare('SELECT * FROM flussonic_servers ORDER BY id ASC').all();
  if (all.length === 1) return all[0];
  return all.find((x) => Number(x.origin_only) !== 1) || null;
}

async function openStream(srv, name) {
  const conn = await negotiateFlussonic2312Connection(srv);
  const encName = String(name)
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  const headers = { ...conn.headers };
  if (String(headers.Authorization || '').startsWith('Cluster ')) {
    headers.Authorization = buildFlussonicClusterAuthHeader(
      String(srv.api_token || srv.password || srv.username || '').trim()
    );
  }
  const url = `${conn.effectiveBase}/streamer/api/v3/streams/${encName}`;
  const r = await fetchJsonWithTimeout(url, { headers }, 8000, conn.bridgeNode);
  if (!r.ok) {
    const err = new Error(`Flussonic respondió HTTP ${r.status} al leer «${name}»`);
    err.detail = String(r.text || '').slice(0, 300);
    throw err;
  }
  const json = r.json || {};
  return { conn, headers, url, remote: json.stream || json };
}

/**
 * Quita el `drm` de un stream de Flussonic (o sólo lo enseña en `preview`).
 * Devuelve `{ ok, action, stream, had_drm, applied }`.
 */
export async function removeDrmFromFlussonic({ name, streamId = null, serverId = null, action = 'preview' } = {}) {
  const streamName = String(name || '').trim();
  if (!streamName) throw new Error('Falta el nombre del stream en Flussonic');

  const srv = pickServer({ serverId, streamId });
  if (!srv) throw new Error('No hay ningún Flussonic registrado en el panel');

  const { conn, headers, url, remote } = await openStream(srv, streamName);
  const payload = writableFields(remote);
  const hadDrm = Boolean(remote.drm);

  if (action === 'preview') {
    return {
      ok: true,
      action,
      server: { id: srv.id, name: srv.name, base: conn.effectiveBase },
      stream: streamName,
      had_drm: hadDrm,
      current_drm: remote.drm || null,
      will_send: hadDrm ? payload : null,
      note: hadDrm
        ? 'Vista previa: se reescribirá el stream SIN el bloque drm. No se ha cambiado nada todavía.'
        : 'Ese stream ya no tiene DRM en Flussonic.'
    };
  }

  if (!hadDrm) {
    return {
      ok: true,
      action,
      server: { id: srv.id, name: srv.name },
      stream: streamName,
      had_drm: false,
      applied: null
    };
  }

  const putRes = await fetchJsonWithTimeout(
    url,
    { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    10000,
    conn.bridgeNode
  );
  if (!putRes.ok) {
    const err = new Error(`Flussonic rechazó el cambio (HTTP ${putRes.status})`);
    err.detail = String(putRes.text || '').slice(0, 500);
    throw err;
  }

  // Ya no hace falta reintentar ese canal.
  const data = legacyPayload();
  const rest = (Array.isArray(data.streams) ? data.streams : []).filter(
    (r) => String(r.flussonic_stream || r.flussonic_stream_name || '').trim() !== streamName
  );
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('drm_legacy_streams', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(
    JSON.stringify({
      ...data,
      streams: rest,
      names: rest.map((r) => r.flussonic_stream || r.flussonic_stream_name)
    })
  );

  return {
    ok: true,
    action,
    server: { id: srv.id, name: srv.name, base: conn.effectiveBase },
    stream: streamName,
    had_drm: true,
    applied: payload
  };
}
