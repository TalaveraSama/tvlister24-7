#!/usr/bin/env node
// Balancer con ancho de banda propio: reparto y nodo edge con caché.
//
// Cubre las tres piezas del cambio:
//   1. `pickTarget()` — reparte por Mbps, no manda a un nodo lleno y devuelve
//      el maestro cuando es el más libre (o cuando todos están llenos).
//   2. Agente edge real — cachea segmentos con single-flight, reescribe los
//      manifiestos para que el cliente no se escape al dominio del maestro y
//      reporta su salida (Mbps) en el latido.
//   3. Instalador — comando remoto bien armado y rechazo sin credenciales.
//
// Uso:  node scripts/test_balancer_lb.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};

/* ========================================================================== */
/*  1. Reparto por ancho de banda                                            */
/* ========================================================================== */
const { pickTarget, nodeLoadRatio, nodeIsFull, nodeCapacityMbps } = await import('../server/lbSelector.js');

const node = (over = {}) => ({
  id: 2,
  host: '10.0.0.2',
  port: 8096,
  max_clients: 2500,
  max_bandwidth_mbps: 800,
  bandwidth_mbps: 0,
  active_conns: 0,
  cpu_usage: 10,
  ...over
});

ok('capacidad por defecto 800 Mbps', nodeCapacityMbps({}) === 800);
ok('capacidad declarada se respeta', nodeCapacityMbps({ max_bandwidth_mbps: 1000 }) === 1000);
ok('nodo vacío: carga 0', nodeLoadRatio(node({ cpu_usage: 0 })) === 0);
ok(
  'nodo con 400/800 Mbps: carga 0.5',
  Math.abs(nodeLoadRatio(node({ bandwidth_mbps: 400 })) - 0.5) < 1e-9
);
ok('nodo al 95 % de su NIC está lleno', nodeIsFull(node({ bandwidth_mbps: 800 })) === true);
ok('nodo con CPU al 95 % está lleno', nodeIsFull(node({ cpu_usage: 96 })) === true);
ok('nodo al 50 % no está lleno', nodeIsFull(node({ bandwidth_mbps: 400 })) === false);

// Con el maestro a 100/800 (0.125) y un nodo vacío (0), gana el nodo.
const nEmpty = node({ id: 3, bandwidth_mbps: 0 });
ok('con el maestro más cargado, se manda al nodo', pickTarget({ nodes: [nEmpty], masterRatio: 0.125 })?.id === 3);

// El maestro claramente más libre atiende él (null).
ok(
  'con el maestro libre y el nodo cargado, atiende el maestro',
  pickTarget({ nodes: [node({ bandwidth_mbps: 600 })], masterRatio: 0.1 }) === null
);

// Nodo lleno: nunca se elige, aunque el maestro también esté cargado.
ok(
  'un nodo lleno no recibe clientes',
  pickTarget({ nodes: [node({ bandwidth_mbps: 790 })], masterRatio: 0.9 }) === null
);

// Dos nodos: gana el que tiene más ancho de banda libre.
const a = node({ id: 10, bandwidth_mbps: 600 });
const b = node({ id: 11, bandwidth_mbps: 100 });
ok('entre dos nodos gana el más libre', pickTarget({ nodes: [a, b], masterRatio: 0.9 })?.id === 11);

// offloadPct: con 70, el maestro suelta clientes aunque esté libre.
ok(
  'con lb_master_offload_pct=70 y el maestro al 20 %, atiende el maestro',
  pickTarget({ nodes: [nEmpty], masterRatio: 0.2, offloadPct: 70 }) === null
);
ok(
  'con lb_master_offload_pct=70 y el maestro al 80 %, se manda al nodo',
  pickTarget({ nodes: [nEmpty], masterRatio: 0.8, offloadPct: 70 })?.id === 3
);

// GeoIP: manda al nodo del país si existe.
const mx = node({ id: 20, region_countries: 'MX,GT' });
const co = node({ id: 21, region_countries: 'CO' });
ok('geoip elige el nodo del país', pickTarget({ nodes: [mx, co], masterRatio: 0.9, mode: 'geoip', country: 'MX' })?.id === 20);
ok(
  'geoip sin coincidencia usa cualquier nodo (no deja al cliente sin nadie)',
  pickTarget({ nodes: [mx, co], masterRatio: 0.9, mode: 'geoip', country: 'PE' }) !== null
);

/* ========================================================================== */
/*  2. Agente edge real con caché                                            */
/* ========================================================================== */
// Puertos libres al azar: si dos ejecuciones seguidas comparten puerto, la
// segunda hablaría con el agente de la anterior y el test mentiría.
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
const UP_PORT = await freePort();
const EDGE_PORT = await freePort();
let segmentHits = 0;
let heartbeatPayloads = [];

const SEGMENT = Buffer.alloc(64 * 1024, 7);

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/api/lb/heartbeat') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        heartbeatPayloads.push(JSON.parse(body));
      } catch {
        heartbeatPayloads.push({});
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server_id: 2, rewrite_hosts: ['video.midominio.test'] }));
    });
    return;
  }

  if (url.pathname === '/hls_out/u/p/1/index.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        `#EXTINF:2.0,\nhttp://127.0.0.1:${UP_PORT}/hls_out/u/p/1/seg1.ts`,
        `#EXTINF:2.0,\nhttp://video.midominio.test/hls_out/u/p/1/seg2.ts`,
        '#EXT-X-ENDLIST'
      ].join('\n')
    );
  }

  if (/^\/hls_out\/u\/p\/1\/seg\d+\.ts$/.test(url.pathname)) {
    segmentHits += 1;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEGMENT.length });
    return res.end(SEGMENT);
  }

  if (url.pathname === '/live/u/p/9.ts') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.write('chunk-1');
    setTimeout(() => res.end('chunk-2'), 50);
    return;
  }

  res.writeHead(404);
  res.end('nope');
});

await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

const edge = spawn(process.execPath, [path.join(ROOT, 'scripts/edge-agent.js')], {
  env: {
    ...process.env,
    MASTER_URL: `http://127.0.0.1:${UP_PORT}`,
    EDGE_API_TOKEN: 'edge_test_token',
    EDGE_PORT: String(EDGE_PORT),
    EDGE_CACHE_MB: '64',
    EDGE_CACHE_TTL_MS: '15000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let edgeLog = '';
edge.stdout.on('data', (d) => (edgeLog += d));
edge.stderr.on('data', (d) => (edgeLog += d));

const waitEdge = async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${EDGE_PORT}/health`);
      if (r.ok) return true;
    } catch {
      /* arrancando */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

try {
  const up = await waitEdge();
  ok('el agente balancer arranca', up);
  if (!up) throw new Error(`no arrancó:\n${edgeLog}`);

  // --- Manifiesto: se reescriben las URLs absolutas -------------------------
  const man = await fetch(`http://127.0.0.1:${EDGE_PORT}/hls_out/u/p/1/index.m3u8`);
  const manText = await man.text();
  ok('el manifiesto pasa por el nodo', man.status === 200);
  ok('los segmentos quedan en el nodo (relativos)', manText.includes('/hls_out/u/p/1/seg1.ts') && !/^https?:\/\//m.test(manText.split('\n').filter((l) => l && !l.startsWith('#')).join('\n')),
    manText.split('\n').filter((l) => l && !l.startsWith('#')).join(' | '));
  ok('reescribe también el dominio de vídeo del panel', manText.includes('/hls_out/u/p/1/seg2.ts'));

  // --- Caché con single-flight: 25 clientes, 1 descarga --------------------
  const requests = Array.from({ length: 25 }, () =>
    fetch(`http://127.0.0.1:${EDGE_PORT}/hls_out/u/p/1/seg1.ts`).then(async (r) => ({
      status: r.status,
      cache: r.headers.get('x-edge-cache'),
      len: (await r.arrayBuffer()).byteLength
    }))
  );
  const results = await Promise.all(requests);
  ok('los 25 clientes reciben el segmento completo', results.every((r) => r.status === 200 && r.len === SEGMENT.length));
  ok('una sola descarga al maestro para 25 clientes', segmentHits === 1, `peticiones upstream: ${segmentHits}`);

  // --- Segunda ronda: sale de la caché ------------------------------------
  const again = await fetch(`http://127.0.0.1:${EDGE_PORT}/hls_out/u/p/1/seg1.ts`);
  await again.arrayBuffer();
  ok('la segunda petición sale de la caché', again.headers.get('x-edge-cache') === 'HIT');
  ok('sigue sin tocar el maestro', segmentHits === 1);

  // --- Flujo continuo: no se cachea, se hace streaming --------------------
  const live = await fetch(`http://127.0.0.1:${EDGE_PORT}/live/u/p/9.ts`);
  const liveText = await live.text();
  ok('el TS continuo pasa con streaming', live.status === 200 && liveText === 'chunk-1chunk-2');
  ok('el TS continuo no se marca como caché', !live.headers.get('x-edge-cache'));

  // --- Telemetría del latido ---------------------------------------------
  await new Promise((r) => setTimeout(r, 11000));
  const last = heartbeatPayloads[heartbeatPayloads.length - 1] || {};
  ok('el nodo manda su versión en el latido', Boolean(last.edge_version), String(last.edge_version));
  ok('el nodo reporta Mbps de salida', Number(last.bandwidth_mbps) > 0, `${last.bandwidth_mbps} Mbps`);
  ok('el nodo reporta aciertos de caché', Number(last.cache_hit_pct) > 0, `${last.cache_hit_pct} %`);
  ok('el nodo reporta conexiones', Number(last.active_conns) >= 0);

  const health = await (await fetch(`http://127.0.0.1:${EDGE_PORT}/health`)).json();
  ok('el nodo sabe qué dominios reescribir', (health.rewriteHosts || []).includes('video.midominio.test'),
    JSON.stringify(health.rewriteHosts));
} catch (err) {
  fails += 1;
  console.log(`FALLO excepción: ${err.message}`);
} finally {
  edge.kill('SIGKILL');
  await new Promise((r) => upstream.close(r));
}

/* ========================================================================== */
/*  3. Instalador remoto                                                     */
/* ========================================================================== */
const { buildInstallCommand, runRemoteInstall } = await import('../server/balancerInstall.js');

const cmd = buildInstallCommand({
  masterUrl: 'http://173.208.183.66:8095/',
  token: 'edge_abc123',
  port: 8096,
  cacheMb: 512
});
ok('el comando descarga el instalador del panel', cmd.includes('http://173.208.183.66:8095/api/lb/install.sh'));
ok('el comando lleva el token del nodo', cmd.includes("--token 'edge_abc123'"));
ok('el comando lleva el puerto y la caché', cmd.includes("--port '8096'") && cmd.includes("--cache-mb '512'"));

const injected = buildInstallCommand({ masterUrl: 'http://x', token: "a'b; rm -rf /", port: 8096 });
ok(
  'el token se escapa (no se puede inyectar shell)',
  injected.includes("'a'\\''b; rm -rf /'") && !injected.includes("; rm -rf / "),
  injected
);

let rejected = false;
try {
  await runRemoteInstall({ host: '10.1.2.3', masterUrl: 'http://x', token: 't' });
} catch (err) {
  rejected = /contraseña|clave privada/i.test(err.message);
}
ok('sin credenciales el instalador se niega', rejected);

let badHost = false;
try {
  await runRemoteInstall({ host: 'rm -rf /', password: 'x', masterUrl: 'http://x', token: 't' });
} catch (err) {
  badHost = /inválido/i.test(err.message);
}
ok('rechaza un host con caracteres raros', badHost);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
