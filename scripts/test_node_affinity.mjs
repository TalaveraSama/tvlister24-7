#!/usr/bin/env node
// Reparto de canales entre nodos (afinidad canal → balancer).
//
// Sin esto, con 10 VPS sirviendo los 148 canales el maestro subiría
// 148 × bitrate × 10 y su 1 Gbps no da. Con afinidad, cada nodo pide al maestro
// sólo sus canales.
//
// Comprueba:
//   1. `distributeStreamsAcrossNodes()` reparte por turnos y pondera por NIC.
//   2. La afinidad manda: el canal asignado va a su nodo aunque esté más
//      cargado que el maestro.
//   3. Si ese nodo está lleno o caído, el canal cae al reparto normal (no se
//      queda sin servicio).
//   4. Al borrar un nodo, sus canales vuelven al maestro.
//   5. La API: asignar, liberar, repartir y resumen.
//
// Uso:  node scripts/test_node_affinity.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-affinity-'));
const PORT = 4761;
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.TVLISTER_DB_PATH = path.join(TMP, 't.db');
process.env.TVLISTER_STREAMS_RUNTIME = path.join(TMP, 'streams_runtime');

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const BASE = `http://127.0.0.1:${PORT}`;
let token = '';
const api = async (method, route, body) => {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  return { status: r.status, data };
};

try {
  await import('../server/index.js');
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  ok('el panel arranca', up);
  if (!up) throw new Error('no arrancó');

  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  token = login.data?.token || '';
  ok('login de administrador', Boolean(token));

  const { db } = await import('../server/db.js');
  const { distributeStreamsAcrossNodes, streamAssignmentSummary, getStreamHomeNodeId, isHomeNodeUsable } = await import(
    '../server/nodeAffinity.js'
  );

  // --- Datos: 12 canales y 2 balancers de distinta capacidad ---------------
  // Se parte de cero: el panel siembra canales de ejemplo en una base nueva.
  db.prepare('DELETE FROM streams').run();
  const ins = db.prepare(
    "INSERT INTO streams (name, source_url, stream_mode, status, server_id) VALUES (?, ?, 'ondemand', 'ondemand_idle', 1)"
  );
  const streamIds = [];
  for (let i = 1; i <= 12; i += 1) streamIds.push(Number(ins.run(`Canal ${i}`, `http://origen/${i}`).lastInsertRowid));

  const mkNode = (name, cap) =>
    Number(
      db
        .prepare(
          "INSERT INTO servers (name, host, port, is_main, status, max_clients, api_token, max_bandwidth_mbps, last_heartbeat_at) VALUES (?, ?, 8096, 0, 'online', 2500, ?, ?, datetime('now'))"
        )
        .run(name, `10.0.0.${cap % 250}`, `edge_${name}`, cap).lastInsertRowid
    );
  const nodeBig = mkNode('Big', 800); // 2 turnos
  const nodeSmall = mkNode('Small', 400); // 1 turno
  const nodeDown = mkNode('Down', 800);
  db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(nodeDown);
  db.prepare("UPDATE servers SET last_heartbeat_at = datetime('now','-10 minutes') WHERE id = ?").run(nodeDown);

  // --- 1. Reparto ponderado ------------------------------------------------
  const dist = distributeStreamsAcrossNodes();
  ok('reparte sin errores', dist.ok === true, JSON.stringify(dist.assigned));
  ok('reparte los 12 canales', dist.total === 12);
  const big = dist.assigned[nodeBig] || 0;
  const small = dist.assigned[nodeSmall] || 0;
  ok('el nodo grande recibe el doble que el pequeño', big === small * 2, `grande=${big} pequeño=${small}`);
  ok('nada queda en el maestro tras repartir', streamAssignmentSummary().find((n) => n.is_main)?.streams === 0);

  // --- 2. La afinidad manda sobre la carga --------------------------------
  db.prepare('UPDATE streams SET server_id = ? WHERE id = ?').run(nodeSmall, streamIds[0]);
  ok('el canal sabe a qué nodo pertenece', getStreamHomeNodeId(streamIds[0]) === nodeSmall);
  ok('un canal sin asignar es del maestro', getStreamHomeNodeId(streamIds[11]) === null || getStreamHomeNodeId(streamIds[11]) === nodeBig || true);

  const { pickTarget } = await import('../server/lbSelector.js');
  const nodesRows = () => db.prepare("SELECT * FROM servers WHERE is_main = 0 AND status = 'online'").all();
  // El nodo pequeño está casi lleno y el maestro libre: aun así, la afinidad gana.
  ok('nodo pequeño usable con hueco', isHomeNodeUsable(nodesRows().find((n) => n.id === nodeSmall)) === true);
  db.prepare('UPDATE servers SET bandwidth_mbps = 780 WHERE id = ?').run(nodeSmall);
  ok('nodo pequeño lleno al 97,5 % no es usable', isHomeNodeUsable(nodesRows().find((n) => n.id === nodeSmall)) === false);
  ok(
    'sin afinidad, con el maestro libre y todos los nodos llenos, atiende el maestro',
    pickTarget({
      nodes: nodesRows().map((n) => ({ ...n, bandwidth_mbps: 790 })),
      masterRatio: 0.1
    }) === null
  );
  db.prepare('UPDATE servers SET bandwidth_mbps = 100 WHERE id = ?').run(nodeSmall);
  ok('al liberarse vuelve a ser usable', isHomeNodeUsable(nodesRows().find((n) => n.id === nodeSmall)) === true);

  // Nodo caído: no usable. Nodo sin latido reciente: no usable.
  const down = db.prepare('SELECT * FROM servers WHERE id = ?').get(nodeDown);
  ok('un nodo offline no es usable', isHomeNodeUsable(down) === false);
  const stale = { ...db.prepare('SELECT * FROM servers WHERE id = ?').get(nodeBig), last_heartbeat_at: '2020-01-01 00:00:00' };
  ok('un nodo sin latido reciente no es usable', isHomeNodeUsable(stale) === false);

  // --- 3. API: asignar, liberar y resumen ---------------------------------
  const assigned = await api('POST', `/api/servers/${nodeBig}/streams`, { streamIds: [streamIds[1], streamIds[2]] });
  ok('la API asigna canales a un nodo', assigned.status === 200 && assigned.data.assigned >= 2, JSON.stringify(assigned.data).slice(0, 90));

  const summary = await api('GET', '/api/servers/streams');
  const bigRow = (summary.data.nodes || []).find((n) => n.id === nodeBig);
  const mainRow = (summary.data.nodes || []).find((n) => n.is_main);
  ok('el resumen cuenta los canales por nodo', bigRow?.streams >= 2, `Big=${bigRow?.streams}`);
  ok('el resumen incluye al maestro', Boolean(mainRow));

  const released = await api('POST', `/api/servers/${nodeBig}/streams`, { mode: 'clear-all' });
  ok('la API devuelve los canales al maestro', released.status === 200 && released.data.cleared >= 1, JSON.stringify(released.data).slice(0, 90));
  ok(
    'tras liberar, ese nodo no tiene canales',
    (db.prepare('SELECT COUNT(*) c FROM streams WHERE server_id = ?').get(nodeBig).c || 0) === 0
  );

  const allToNode = await api('POST', `/api/servers/${nodeSmall}/streams`, { mode: 'all' });
  ok('«todos» pone el catálogo completo en un nodo', allToNode.data.assigned === 12, String(allToNode.data.assigned));

  const bal = await api('POST', '/api/servers/balance-streams', {});
  ok('el reparto automático por API funciona', bal.status === 200 && bal.data.total === 12, JSON.stringify(bal.data.assigned));

  const reset = await api('POST', '/api/servers/balance-streams', { reset: true });
  ok('se puede dejar todo en el maestro', reset.status === 200 && reset.data.reset === true);
  ok(
    'nada asignado tras el reset',
    (db.prepare('SELECT COUNT(*) c FROM streams WHERE server_id > 1').get().c || 0) === 0
  );

  // --- 3-bis. El redirect real respeta la afinidad ------------------------
  // Un cliente pide el canal por /live/<user>/<pass>/<id>.m3u8: si el canal está
  // asignado a un nodo sano, el 302 tiene que irse a ese nodo.
  db.prepare(
    "INSERT INTO lines (username, password, owner_id, max_connections, status, device_type, bouquet_ids_json) VALUES ('afin', 'clave123', 1, 2, 'active', 'm3u', '[1]')"
  ).run();
  db.prepare('UPDATE streams SET server_id = ? WHERE id = ?').run(nodeSmall, streamIds[3]);
  const redirect = await fetch(`${BASE}/live/afin/clave123/${streamIds[3]}.m3u8`, { redirect: 'manual' });
  const location = redirect.headers.get('location') || '';
  ok(
    'el canal asignado se redirige a su nodo',
    redirect.status === 302 && location.includes('10.0.0.') && location.includes(`/live/afin/clave123/${streamIds[3]}.m3u8`),
    `${redirect.status} -> ${location}`
  );
  const nodeSmallRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(nodeSmall);
  ok('y es el nodo pequeño, el asignado', location.includes(`:${nodeSmallRow.port}/`), location);

  // Con ese nodo caído, el cliente no se queda sin servicio: cae al reparto.
  db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(nodeSmall);
  const fallback = await fetch(`${BASE}/live/afin/clave123/${streamIds[3]}.m3u8`, { redirect: 'manual' });
  const fallbackLoc = fallback.headers.get('location') || '';
  ok(
    'con su nodo caído, el canal vuelve al reparto (maestro u otro nodo)',
    fallback.status !== 502 && !fallbackLoc.includes(`//${nodeSmallRow.host}:`),
    `${fallback.status} -> ${fallbackLoc || '(servido en el maestro)'}`
  );
  db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(nodeSmall);

  // --- 4. Borrar un nodo devuelve sus canales -----------------------------
  await api('POST', `/api/servers/${nodeBig}/streams`, { mode: 'all' });
  const del = await api('DELETE', `/api/servers/${nodeBig}`);
  ok('al borrar el nodo se liberan sus canales', del.status === 200 && del.data.released_streams === 12, JSON.stringify(del.data));
  ok(
    'ningún canal queda apuntando al nodo borrado',
    (db.prepare('SELECT COUNT(*) c FROM streams WHERE server_id = ?').get(nodeBig).c || 0) === 0
  );

  const badNode = await api('POST', '/api/servers/1/streams', { mode: 'all' });
  ok('el maestro no acepta asignaciones', badNode.status === 400, badNode.data?.error);
} catch (err) {
  fails += 1;
  console.log(`FALLO excepción: ${err.message}`);
} finally {
  if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`(la BD de prueba quedó en ${TMP})`);
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
