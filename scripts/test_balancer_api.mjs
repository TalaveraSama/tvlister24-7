#!/usr/bin/env node
// API del balanceador: alta/instalación de un VPS desde el panel y latidos con
// ancho de banda.
//
// Arranca el panel de verdad (mismo proceso, base de datos temporal) y comprueba:
//   1. `POST /api/servers/install` crea el nodo, devuelve el comando manual y
//      deja un trabajo que termina en error controlado si el SSH no responde.
//   2. El latido del nodo guarda Mbps, caché y versión.
//   3. `GET /api/system` expone la salida del maestro y la capacidad del nodo.
//
// Uso:  node scripts/test_balancer_api.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-balancer-'));
const PORT = 4744;
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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
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
      const r = await fetch(`${BASE}/api/health`);
      up = r.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  ok('el panel arranca', up);
  if (!up) throw new Error('no arrancó');

  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  token = login.data?.token || '';
  ok('login de administrador', Boolean(token));

  // --- 1. Instalación remota contra un SSH que no responde -----------------
  const install = await api('POST', '/api/servers/install', {
    name: 'Balancer prueba',
    host: '127.0.0.1',
    port: 8096,
    max_bandwidth_mbps: 900,
    ssh_port: 1,
    ssh_user: 'root',
    ssh_password: 'no-es-la-clave',
    cache_mb: 128,
    master_url: BASE
  });
  ok('el panel acepta la instalación', install.status === 200 && Boolean(install.data?.jobId), JSON.stringify(install.data).slice(0, 120));
  ok('devuelve el comando manual de respaldo', String(install.data?.manual_command || '').includes('/api/lb/install.sh'));
  ok('el comando lleva el token del nodo nuevo', String(install.data?.manual_command || '').includes('--token'));

  // El trabajo termina en error (no hay SSH en el puerto 1) pero sin colgarse.
  let job = null;
  const jobDeadline = Date.now() + 40000;
  while (Date.now() < jobDeadline) {
    const r = await api('GET', `/api/servers/install/${install.data.jobId}`);
    job = r.data;
    if (job?.status && job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 400));
  }
  ok('el trabajo de instalación termina', job?.status === 'error', `estado: ${job?.status}`);
  ok(
    'el log explica que no hubo conexión SSH',
    /SSH/i.test(String(job?.log || '')),
    String(job?.log || '').split('\n').filter(Boolean).slice(-1)[0] || ''
  );

  const sys1 = await api('GET', '/api/system');
  const nodeRow = (sys1.data?.servers || []).find((s) => s.id === install.data.id);
  ok('el nodo queda registrado', Boolean(nodeRow), JSON.stringify(nodeRow || {}).slice(0, 120));
  ok('guarda su capacidad de ancho de banda', Number(nodeRow?.max_bandwidth_mbps) === 900);
  ok('marca la instalación como fallida', nodeRow?.install_status === 'error');

  // --- 2. El nodo late con su ancho de banda -------------------------------
  const hb = await fetch(`${BASE}/api/lb/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-edge-token': nodeRow.api_token },
    body: JSON.stringify({
      cpu_usage: 22,
      ram_usage: 40,
      active_conns: 37,
      http_port: 8096,
      bandwidth_mbps: 412.5,
      cache_hit_pct: 91.2,
      edge_version: '2.1.0'
    })
  });
  const hbData = await hb.json();
  ok('el latido del nodo se acepta', hb.status === 200 && hbData.ok === true);
  ok('el latido devuelve los dominios a reescribir', Array.isArray(hbData.rewrite_hosts), JSON.stringify(hbData.rewrite_hosts));

  const sys2 = await api('GET', '/api/system');
  const node2 = (sys2.data?.servers || []).find((s) => s.id === install.data.id);
  ok('guarda los Mbps que está sirviendo', Number(node2?.bandwidth_mbps) === 412.5, String(node2?.bandwidth_mbps));
  ok('guarda el acierto de caché', Number(node2?.cache_hit_pct) === 91.2);
  ok('guarda la versión del agente', node2?.edge_version === '2.1.0');
  ok('el nodo queda online', node2?.status === 'online');
  ok('el panel informa su propia salida', typeof sys2.data?.egressMbps === 'number', `${sys2.data?.egressMbps} Mbps`);
  ok('el panel informa su capacidad', Number(sys2.data?.masterMaxBandwidthMbps) === 800);

  // Al llenar el nodo, el panel no debe seguir contándolo como disponible.
  await fetch(`${BASE}/api/lb/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-edge-token': nodeRow.api_token },
    body: JSON.stringify({ bandwidth_mbps: 890, active_conns: 200, cpu_usage: 40 })
  });
  const sys3 = await api('GET', '/api/system');
  const node3 = (sys3.data?.servers || []).find((s) => s.id === install.data.id);
  ok('el nodo lleno queda al 98 % de su capacidad', Number(node3.bandwidth_mbps) >= 880);

  // --- 3. Baja del nodo ----------------------------------------------------
  const del = await api('DELETE', `/api/servers/${install.data.id}`);
  ok('el nodo se puede eliminar', del.status === 200);
  const sys4 = await api('GET', '/api/system');
  ok('ya no aparece', !(sys4.data?.servers || []).some((s) => s.id === install.data.id));

  // Un VPS sin credenciales no arranca instalación.
  const noCreds = await api('POST', '/api/servers/install', { host: '10.9.9.9', master_url: BASE });
  ok('sin contraseña ni clave no se instala', noCreds.status === 400, noCreds.data?.error);
} catch (err) {
  fails += 1;
  console.log(`FALLO excepción: ${err.message}`);
} finally {
  if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`(la BD de prueba quedó en ${TMP})`);
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
