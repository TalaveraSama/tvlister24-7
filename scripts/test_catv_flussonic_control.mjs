#!/usr/bin/env node
// ============================================================================
// CONTROL DE FLUSSONIC — enviar los canales desde Flussonic y poder volver
// ----------------------------------------------------------------------------
// Lo que pidió el usuario: «necesito controlar Flussonic, ya Flussonic recibe
// los canales, sería enviarlos desde Flussonic mejor». Aquí se prueba de punta
// a punta contra el PANEL REAL, con un Flussonic simulado que se comporta como
// el 23.12 (API v3: GET /streams, GET/PATCH /streams/:name):
//
//   1. Foto del control: cuántos canales van por TVLister y cuántos por Flussonic.
//   2. Mapeo automático canal CATV → stream de Flussonic (exacto y por parecido).
//   3. «Pasar todo a Flussonic»: para el motor local y deja la salida puesta.
//   4. Verificación: Flussonic tiene la salida con el host:puerto exacto.
//   5. Nadie más emite: mientras el canal está en Flussonic, TVLister no manda
//      un solo datagrama a ese destino.
//   6. «Volver a TVLister»: quita la salida de Flussonic (no quedan dos
//      emisores) y el motor local vuelve a emitir.
//
// Uso:  node scripts/test_catv_flussonic_control.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-flussonic-'));

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== Flussonic de mentira (API v3) ====================
const flussonicPort = 4671;
const streamsState = new Map([
  ['NACIONAL 2', { name: 'NACIONAL 2', title: 'NACIONAL 2', outputs: [], alive: true, bitrate: 2400000 }],
  ['TELEMUNDO', { name: 'TELEMUNDO', title: 'TELEMUNDO', outputs: [], alive: true, bitrate: 2600000 }],
  ['CANAL 4 - CINEMA', { name: 'CANAL 4 - CINEMA', title: 'Canal 4 Cine', outputs: [], alive: false, bitrate: 0 }],
  ['OTRO QUE NADIE USA', { name: 'OTRO QUE NADIE USA', title: 'sin relacion', outputs: [], alive: true, bitrate: 1000000 }]
]);
const patchCalls = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/streamer/api/v3/streams' && req.method === 'GET') {
    return send({
      streams: [...streamsState.values()].map((s) => ({
        name: s.name,
        title: s.title,
        static: true,
        outputs: s.outputs,
        stats: { alive: s.alive, bitrate: s.bitrate, client_count: 0 }
      }))
    });
  }
  const m = /^\/streamer\/api\/v3\/streams\/(.+)$/.exec(url.pathname);
  if (m) {
    const name = decodeURIComponent(m[1]);
    const st = streamsState.get(name);
    if (!st) return send({ error: 'not found' }, 404);
    if (req.method === 'GET') {
      return send({
        name: st.name,
        title: st.title,
        static: true,
        outputs: st.outputs,
        inputs: [{ url: `tshttp://10.0.0.1:8080/${name}` }],
        stats: { alive: st.alive, bitrate: st.bitrate }
      });
    }
    if (req.method === 'PATCH') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => send({ error: 'request_body', while: 'parsing_parameters' }, 400));
      return undefined;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          parsed = {};
        }
        patchCalls.push({ name, method: req.method, outputs: parsed.outputs });
        if (Array.isArray(parsed.outputs)) {
          st.outputs = parsed.outputs.map((o) => (typeof o === 'string' ? { url: o } : o));
        }
        send({ ok: true });
      });
      return undefined;
    }
  }
  return send({ error: 'ruta no simulada: ' + url.pathname }, 404);
});
await new Promise((r) => fake.listen(flussonicPort, '127.0.0.1', r));

// ==================== FFmpeg de mentira (motor local) ====================
const FAKE_FFMPEG = path.join(TMP, 'fake-ffmpeg.mjs');
fs.writeFileSync(
  FAKE_FFMPEG,
  `#!/usr/bin/env node
if (process.argv.includes('-version')) { console.log('ffmpeg version 6.0-fake'); process.exit(0); }
const CHUNK = 1316 * 200;
const ts = Buffer.alloc(CHUNK, 0xff);
for (let i = 0; i < CHUNK; i += 188) { ts[i] = 0x47; ts[i + 1] = 0x1f; ts[i + 2] = 0xff; ts[i + 3] = 0x10; }
const outUrl = process.argv.find((a) => a.startsWith('udp://') || a.startsWith('rtp://')) || '';
let sink = () => {};
if (outUrl) {
  const rest = String(outUrl.split('://')[1] || '').split('?')[0];
  const idx = rest.lastIndexOf(':');
  const host = idx > 0 ? rest.slice(0, idx) : '127.0.0.1';
  const port = idx > 0 ? Number(rest.slice(idx + 1)) : 5000;
  const dgram = await import('node:dgram');
  const socket = dgram.createSocket('udp4');
  sink = (buf) => { try { for (let o = 0; o < buf.length; o += 1316) socket.send(buf.subarray(o, o + 1316), port, host); } catch { process.exit(0); } };
} else {
  sink = (buf) => { try { process.stdout.write(buf); } catch { process.exit(0); } };
}
sink(ts);
const t = setInterval(() => sink(ts), 1000);
process.on('SIGTERM', () => { clearInterval(t); process.exit(0); });
process.on('SIGINT', () => { clearInterval(t); process.exit(0); });
`,
  { mode: 0o755 }
);
delete process.env.TVLISTER_CATV_PACER;

// ==================== Panel real ====================
const APP_PORT = 4672;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    TVLISTER_DB_PATH: path.join(TMP, 't.db'),
    TVLISTER_STREAMS_RUNTIME: path.join(TMP, 'streams_runtime'),
    FFMPEG_PATH: FAKE_FFMPEG
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let boot = '';
child.stdout.on('data', (d) => (boot += d));
child.stderr.on('data', (d) => (boot += d));

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

/** Escucha un puerto UDP y devuelve cuántos datagramas llegan en `ms`. */
function countDatagrams(port, ms) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    let n = 0;
    socket.on('message', () => (n += 1));
    socket.bind(port, '127.0.0.1', () => setTimeout(() => {
      socket.close();
      resolve(n);
    }, ms));
  });
}

try {
  let up = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      await sleep(250);
    }
  }
  ok('el panel arranca', up);
  if (!up) throw new Error(`no arrancó:\n${boot.slice(-1500)}`);

  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  token = login.data?.token || '';
  ok('login de administrador', Boolean(token));

  // --- Preparación con SQL directo (canales reales del plan CATV) ----------
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(TMP, 't.db'));
  raw.prepare(`INSERT INTO flussonic_servers (name, base_url, username, password) VALUES ('Astra', ?, 'admin', 'x')`).run(`http://127.0.0.1:${flussonicPort}`);
  await api('GET', '/api/wk2500/plan'); // crea los 124 slots del plan
  raw.prepare(`INSERT INTO wk2500_units (name, ip_mode, dest_ip, base_port, ch_start, ch_end, enabled, pkt_size, rtp, model_channels)
               VALUES ('WK2500 A','unicast','127.0.0.1',5000,2,33,1,1316,0,32)`).run();
  const CHANNELS = [
    { ch: 2, name: 'NACIONAL 2', dest: 4761 },
    { ch: 3, name: 'Telemundo', dest: 4762 },
    { ch: 4, name: 'CANAL 4 CINEMA', dest: 4763 }
  ];
  for (const c of CHANNELS) {
    raw
      .prepare(
        `UPDATE wk2500_channels SET custom_name = ?, udp_host = '127.0.0.1', udp_port = ?,
                custom_source_url = 'http://127.0.0.1:4798/live.ts', stream_id = NULL,
                output_mode = 'direct_spts', muxrate_kbps = 0, enabled = 1, flussonic_stream = '', udp_engine = 'local'
          WHERE catv_ch = ?`
      )
      .run(c.name, c.dest, c.ch);
  }

  // --- 1. Foto del control ------------------------------------------------
  let snap = (await api('GET', '/api/wk2500/flussonic-control')).data;
  ok('la foto del control ve el Flussonic real', snap?.flussonic_reachable === true, `${snap?.streams_available} streams`);
  ok('de partida todos van por TVLister', snap?.flussonic_channels === 0 && snap?.local_channels >= 3, `local ${snap?.local_channels}`);

  // --- 2. Mapeo automático (vista previa) ---------------------------------
  const preview = (await api('POST', '/api/wk2500/flussonic-control/auto-map', { dryRun: true })).data;
  ok('la vista previa no escribe nada', preview?.dryRun === true && preview?.written === 0, `${preview?.candidates} por escribir`);
  const mapByCh = new Map((preview?.mapped || []).map((m) => [m.catv_ch, m]));
  ok('mapea el CH2 por nombre exacto', mapByCh.get(2)?.stream === 'NACIONAL 2', JSON.stringify(mapByCh.get(2)));
  ok('mapea el CH3 sin importar mayúsculas', mapByCh.get(3)?.stream === 'TELEMUNDO', JSON.stringify(mapByCh.get(3)));
  ok(
    'mapea el CH4 aunque el nombre esté invertido (CANAL 4 CINEMA ↔ CANAL 4 - CINEMA)',
    mapByCh.get(4)?.stream === 'CANAL 4 - CINEMA',
    JSON.stringify(mapByCh.get(4))
  );
  ok('no reparte el mismo stream a dos canales', new Set([...mapByCh.values()].map((m) => m.stream)).size === 3);

  const applied = (await api('POST', '/api/wk2500/flussonic-control/auto-map', { dryRun: false })).data;
  ok('al aplicar el mapeo escribe los nombres', applied?.written === 3, `${applied?.written} escritos`);
  const dbStreams = raw.prepare('SELECT catv_ch, flussonic_stream FROM wk2500_channels WHERE catv_ch BETWEEN 2 AND 4 ORDER BY catv_ch').all();
  ok('quedan guardados en el plan', dbStreams.every((r) => r.flussonic_stream), JSON.stringify(dbStreams));

  // --- 3. Pasar todo a Flussonic ------------------------------------------
  const sw = (await api('POST', '/api/wk2500/flussonic-control/switch', { engine: 'flussonic', all: true })).data;
  ok('el cambio a Flussonic responde ok', sw?.ok === true, JSON.stringify({ switched: sw?.switched, failed: sw?.failed }));
  ok('los 3 canales cambian de motor', sw?.switched === 3, `${sw?.switched}/${sw?.requested}`);
  ok('nadie falló', sw?.failed === 0, JSON.stringify((sw?.detail || []).filter((d) => !d.ok)));

  const outputsNow = [...streamsState.values()].flatMap((s) => s.outputs.map((o) => o.url));
  ok(
    'Flussonic recibe la salida UDP exacta de cada canal',
    CHANNELS.every((c) => outputsNow.some((u) => u.includes(`127.0.0.1:${c.dest}`))),
    outputsNow.join(' ')
  );
  ok(
    'se escribe con PUT parcial (no reescribe el stream entero)',
    patchCalls.every((p) => p.method === 'PUT'),
    `${patchCalls.length} escrituras`
  );

  // --- 3b. El motor del panel se reconcilia solo --------------------------
  // El cambio se hizo por la API; los canales tienen que quedar con un worker
  // «delegado» (sin socket local) en <= 4 s, sin reiniciar el panel.
  await sleep(5200);
  const planAfter = (await api('GET', '/api/wk2500/plan')).data;
  const ch2 = (planAfter?.slots || planAfter?.channels || []).find((c) => c.catv_ch === 2);
  ok(
    'el panel cambia el motor del canal solo (sin reiniciar)',
    ch2?.live_engine === 'flussonic_api',
    `engine=${ch2?.live_engine} estado=${ch2?.live_status}`
  );

  // --- 4. Verificación: lo que el operador ve en el panel -----------------
  snap = (await api('GET', '/api/wk2500/flussonic-control')).data;
  ok('la foto dice que los 3 canales van por Flussonic', snap?.flussonic_channels === 3, `${snap?.flussonic_channels}`);
  ok(
    'los 3 verifican salida puesta y stream vivo',
    (snap?.channels || []).every((c) => c.has_output === true && c.verdict !== 'sin_salida'),
    (snap?.channels || []).map((c) => `CH${c.catv_ch}:${c.verdict}`).join(' ')
  );
  ok('el CH4 avisa de que su stream está caído', (snap?.channels || []).find((c) => c.catv_ch === 4)?.verdict === 'stream_caido');

  // --- 5. Nadie más emite al mismo destino --------------------------------
  const whileDelegated = await countDatagrams(4761, 2500);
  ok('con el canal en Flussonic, TVLister no manda NADA a ese destino', whileDelegated === 0, `${whileDelegated} datagramas`);

  // --- 6. Volver a TVLister ----------------------------------------------
  const back = (await api('POST', '/api/wk2500/flussonic-control/switch', { engine: 'local', all: true })).data;
  ok('volver a local responde ok', back?.ok === true, JSON.stringify({ switched: back?.switched, failed: back?.failed }));
  const outputsAfter = [...streamsState.values()].flatMap((s) => s.outputs.map((o) => o.url));
  ok('Flussonic ya no tiene la salida (no quedan dos emisores)', !outputsAfter.some((u) => u.includes(':4761')), outputsAfter.join(' ') || 'ninguna');

  const whileLocal = await countDatagrams(4761, 4000);
  ok('el motor local vuelve a emitir al mismo extremo', whileLocal > 0, `${whileLocal} datagramas`);

  const finalSnap = (await api('GET', '/api/wk2500/flussonic-control')).data;
  ok('el panel vuelve a contar todo como local', finalSnap?.flussonic_channels === 0, `${finalSnap?.flussonic_channels}`);
} finally {
  child.kill('SIGTERM');
  await sleep(600);
  try {
    child.kill('SIGKILL');
  } catch {
    // ya salió
  }
  fake.close();
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails ? 1 : 0);
