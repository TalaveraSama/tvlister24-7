/**
 * Reparto de canales entre nodos (afinidad canal → balancer).
 *
 * El problema que resuelve: cada nodo pide al maestro **una copia por canal
 * distinto** que sirva. Si los 10 VPS sirven los 148 canales, el maestro tendría
 * que subir 148 × bitrate × 10 y su 1 Gbps no da. Repartiendo los canales por
 * nodo, cada uno pide sólo los suyos y el maestro sube **una vez por canal en
 * total**.
 *
 * `streams.server_id` guarda el nodo asignado (1 o NULL = lo sirve el maestro).
 * La afinidad manda sobre el reparto por carga: si el canal está asignado a un
 * nodo sano, todos sus clientes van ahí. Si ese nodo está lleno o caído, el
 * canal no se queda sin servicio: cae al reparto normal.
 */
import { db } from './db.js';
import { nodeIsFull, nodeCapacityMbps } from './lbSelector.js';

/** Nodo asignado a un canal, o null si lo sirve el maestro. */
export function getStreamHomeNodeId(streamId) {
  const id = Number(streamId) || 0;
  if (id <= 0) return null;
  try {
    const row = db.prepare('SELECT server_id FROM streams WHERE id = ?').get(id);
    const sid = Number(row?.server_id) || 0;
    return sid > 1 ? sid : null;
  } catch {
    return null;
  }
}

/** ¿Sigue ese nodo disponible para atender la afinidad? */
export function isHomeNodeUsable(node) {
  if (!node) return false;
  if (node.status !== 'online') return false;
  if (!node.last_heartbeat_at) return false;
  const ageSec = (Date.now() - new Date(`${node.last_heartbeat_at}Z`).getTime()) / 1000;
  // `datetime('now')` de SQLite viene en UTC sin zona; si el parseo falla se
  // confía en el estado que ya trae la fila.
  if (Number.isFinite(ageSec) && ageSec > 90) return false;
  return !nodeIsFull(node);
}

/**
 * Reparte los canales entre los nodos por turnos, ponderando por capacidad.
 * Devuelve cuántos canales quedaron en cada nodo.
 *
 * - `streamIds`: canales a repartir (por defecto, todos los de la lista).
 * - `clearFirst`: pone a 1 (maestro) los canales no incluidos? No: sólo se
 *   tocan los de `streamIds`.
 */
export function distributeStreamsAcrossNodes({ streamIds = null, serverIds = null } = {}) {
  const nodes = (serverIds && serverIds.length
    ? db.prepare(`SELECT * FROM servers WHERE id IN (${serverIds.map(() => '?').join(',')})`).all(...serverIds)
    : db.prepare('SELECT * FROM servers ORDER BY id ASC').all()
  ).filter((s) => !s.is_main && isHomeNodeUsable(s));

  if (nodes.length === 0) {
    // Sin nodos sanos no se reparte nada: los canales se quedan donde estén.
    return {
      ok: false,
      error: 'No hay balancers online con latido reciente. Los canales siguen donde estaban.',
      assigned: {},
      total: 0
    };
  }

  const streams = streamIds && streamIds.length
    ? db.prepare(`SELECT id FROM streams WHERE id IN (${streamIds.map(() => '?').join(',')})`).all(...streamIds)
    : db.prepare('SELECT id FROM streams').all();

  // Turnos ponderados por capacidad: el doble de NIC, el doble de canales.
  const weighted = [];
  for (const node of nodes) {
    const cap = nodeCapacityMbps(node);
    const slots = Math.max(1, Math.round(cap / 400)); // 800 Mbps -> 2 turnos
    for (let i = 0; i < slots; i += 1) weighted.push(node);
  }
  if (weighted.length === 0) return { ok: false, error: 'Nodos sin capacidad declarada.', assigned: {}, total: 0 };

  const upd = db.prepare('UPDATE streams SET server_id = ? WHERE id = ?');
  const assigned = {};
  db.exec('BEGIN IMMEDIATE;');
  try {
    streams.forEach((row, idx) => {
      const node = weighted[idx % weighted.length];
      upd.run(node.id, row.id);
      assigned[node.id] = (assigned[node.id] || 0) + 1;
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return { ok: true, assigned, total: streams.length, nodes: nodes.length, nodeIds: nodes.map((n) => n.id) };
}

/** Resumen: cuántos canales tiene cada nodo y cuántos quedan en el maestro. */
export function streamAssignmentSummary() {
  const rows = db
    .prepare('SELECT server_id, COUNT(*) as c FROM streams GROUP BY server_id')
    .all()
    .map((r) => ({ server_id: Number(r.server_id) || 1, count: Number(r.c) || 0 }));
  const byNode = new Map(rows.map((r) => [r.server_id, r.count]));
  const servers = db
    .prepare('SELECT id, name, host, status, is_main, max_bandwidth_mbps FROM servers ORDER BY is_main DESC, id ASC')
    .all();
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    host: s.host,
    status: s.status,
    is_main: Boolean(s.is_main),
    max_bandwidth_mbps: nodeCapacityMbps(s),
    streams: byNode.get(Number(s.id)) || 0
  }));
}
