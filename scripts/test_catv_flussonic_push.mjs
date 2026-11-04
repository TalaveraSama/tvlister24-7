#!/usr/bin/env node
// ============================================================================
// SALIDAS UDP EN FLUSSONIC («Push live video to certain URLs») — v2.6.34
// ----------------------------------------------------------------------------
// Lo que pidió el usuario: «los canales ya los tiene Flussonic y yo sólo agrego
// en push la salida UDP de manera manual; quería una sección que controle los
// canales de Flussonic y agregue la salida UDP, más sencillo y práctico».
//
// Se prueba contra el PANEL REAL con un Flussonic simulado que responde como el
// 23.12 (GET /streams, GET/PATCH /streams/:name, stats por push):
//
//   1. La foto lista los streams con su push actual y su canal de la lista.
//   2. Vista previa desde la lista de canales: no escribe nada.
//   3. Aplicar: cada stream queda con el UDP exacto del canal (con interfaz).
//   4. Las salidas que no son UDP (rtmp) no se tocan.
//   5. La UDP anterior equivocada se reemplaza (una sola salida por stream).
//   6. «Quitar» deja el stream sin UDP y con el rtmp intacto.
//   7. Edición fila a fila, con validación de URL.
//   8. take_over: el canal pasa a Flussonic y TVLister deja de emitir.
//
// Uso:  node scripts/test_catv_flussonic_push.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-push-'));

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== Flussonic de mentira (API v3) ====================
const flussonicPort = 4681;
const streamsState = new Map([
  [
    'NACIONAL 2',
    {
      name: 'NACIONAL 2',
      title: 'NACIONAL 2',
      alive: true,
      bitrate: 2400000,
      outputs: [{ url: 'udp://ens37@239.9.9.9:9999' }, { url: 'rtmp://10.0.0.5/live/nacional2' }],
      push: [{ url: 'udp://ens37@239.9.9.9:9999', state: 'running', bytes: 140718898 }]
    }
  ],
  ['TELEMUNDO', { name: 'TELEMUNDO', title: 'TELEMUNDO', alive: true, bitrate: 2600000, outputs: [], push: [] }],
  [
    'CANAL 5',
    {
      name: 'CANAL 5',
      title: 'Canal 5',
      alive: true,
      bitrate: 2200000,
      outputs: [{ url: 'rtmp://10.0.0.5/live/canal5' }],
      push: []
    }
  ],
  ['CANAL 6', { name: 'CANAL 6', title: 'Canal 6', alive: true, bitrate: 2000000, outputs: [], push: [] }],
  ['SIN CANAL', { name: 'SIN CANAL', title: 'sin relacion', alive: true, bitrate: 1000000, outputs: [], push: [] }]
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
        stats: { alive: s.alive, bitrate: s.bitrate, client_count: 0, push: s.push }
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
        stats: { alive: st.alive, bitrate: st.bitrate, push: st.push }
      });
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
          // El push nuevo arranca «running» con unos MB, como en Flussonic.
          st.push = st.outputs
            .filter((o) => /^(udp|rtp):\/\//i.test(String(o.url)))
            .map((o) => ({ url: o.url, state: 'running', bytes: 1024 * 1024 * 3 }));
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
  const piece = rest.includes('@') ? rest.slice(rest.lastIndexOf('@') + 1) : rest;
  const idx = piece.lastIndexOf(':');
  const host = idx > 0 ? piece.slice(0, idx) : '127.0.0.1';
  const port = idx > 0 ? Number(piece.slice(idx + 1)) : 5000;
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
const APP_PORT = 4682;
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

function countDatagrams(port, ms) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    let n = 0;
    socket.on('message', () => (n += 1));
    socket.bind(port, '127.0.0.1', () =>
      setTimeout(() => {
        socket.close();
        resolve(n);
      }, ms)
    );
  });
}

const udpOf = (name) =>
  (streamsState.get(name)?.outputs || []).map((o) => (typeof o === 'string' ? o : o.url)).filter((u) => /^(udp|rtp):\/\//i.test(u));

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

  // --- Preparación con SQL directo --------------------------------------
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(TMP, 't.db'));
  raw
    .prepare(`INSERT INTO flussonic_servers (name, base_url, username, password) VALUES ('Astra', ?, 'admin', 'x')`)
    .run(`http://127.0.0.1:${flussonicPort}`);
  await api('GET', '/api/wk2500/plan');
  raw
    .prepare(
      `INSERT INTO wk2500_units (name, ip_mode, dest_ip, base_port, ch_start, ch_end, enabled, pkt_size, rtp, model_channels)
       VALUES ('WK2500 A','unicast','127.0.0.1',5000,2,33,1,1316,0,32)`
    )
    .run();
  const CHANNELS = [
    { ch: 2, name: 'NACIONAL 2', dest: 4771 },
    { ch: 3, name: 'Telemundo', dest: 4772 },
    { ch: 4, name: 'CANAL 5', dest: 4773 }
  ];
  for (const c of [...CHANNELS, { ch: 6, name: 'CANAL 6', dest: 4776, host: '127.0.0.1' }]) {
    raw
      .prepare(
        `UPDATE wk2500_channels SET custom_name = ?, udp_host = ?, udp_port = ?,
                custom_source_url = 'http://127.0.0.1:4798/live.ts', stream_id = NULL,
                output_mode = 'direct_spts', muxrate_kbps = 0, enabled = 1, flussonic_stream = '', udp_engine = 'local'
          WHERE catv_ch = ?`
      )
      .run(c.name, c.host || '239.1.1.2', c.dest, c.ch);
  }

  // Arranca los motores locales como lo haría el operador desde el plan.
  await api('POST', '/api/wk2500/control', { action: 'start_all', ch_start: 2, ch_end: 6 });
  await sleep(2500);

  // --- 0. Utilidades de URL (multicast + interfaz) -----------------------
  const mod = await import(path.join(ROOT, 'server/flussonicUdp.js'));
  ok('parsea udp://ens37@239.1.1.2:1002', mod.parsePushUrl('udp://ens37@239.1.1.2:1002')?.iface === 'ens37');
  ok(
    'la misma salida con o sin interfaz es el mismo destino',
    mod.outputTargetKey('udp://ens37@239.1.1.2:1002') === mod.outputTargetKey('udp://239.1.1.2:1002'),
    mod.outputTargetKey('udp://ens37@239.1.1.2:1002')
  );
  ok('reconoce un push que no es UDP', mod.isUdpPush('rtmp://x/y') === false);

  // --- 1. Foto: streams, push actual y canal ---------------------------
  let snap = (await api('GET', '/api/wk2500/flussonic-push')).data;
  ok('Flussonic responde', snap?.flussonic_reachable === true, `${snap?.total} streams`);
  ok('cuenta los streams con salida UDP', snap?.with_push === 1, `${snap?.with_push}`);
  const row2 = (snap?.streams || []).find((s) => s.name === 'NACIONAL 2');
  ok('empareja el stream con su canal de la lista', row2?.channel?.catv_ch === 2, JSON.stringify(row2?.channel));
  ok('muestra la salida UDP que ya tenía', row2?.push?.url === 'udp://ens37@239.9.9.9:9999', row2?.push?.url);
  ok('y su estado running + MB', row2?.push?.running === true && row2?.push?.mb === 134.2, JSON.stringify(row2?.push));
  ok('avisa de que no coincide con el destino del canal', row2?.in_sync === false);
  ok('el rtmp no se confunde con el push', row2?.other_outputs?.length === 1 && row2.other_outputs[0].startsWith('rtmp://'));
  ok('los canales sin stream se listan aparte', (snap?.channels_sin_stream || []).length === 0, `${snap?.channels_sin_stream?.length}`);

  // --- 2. Vista previa desde la lista de canales -----------------------
  const preview = (await api('POST', '/api/wk2500/flussonic-push', {
    from_channels: true,
    ch_start: 2,
    ch_end: 4,
    iface: 'ens37',
    action: 'apply',
    dry_run: true
  })).data;
  ok('la vista previa responde ok', preview?.ok === true && preview?.dryRun === true, JSON.stringify(preview?.message || ''));
  ok('planea los 3 canales', preview?.detail?.length === 3, `${preview?.detail?.length}`);
  ok('no escribe nada en Flussonic', patchCalls.length === 0, `${patchCalls.length} PATCH`);
  ok(
    'propone el destino exacto del canal con la interfaz',
    (preview?.detail || []).every((d) => d.url.startsWith('udp://ens37@239.1.1.2:')),
    (preview?.detail || []).map((d) => d.url).join(' ')
  );

  // --- 3. Aplicar desde la lista de canales ----------------------------
  const applied = (await api('POST', '/api/wk2500/flussonic-push', {
    from_channels: true,
    ch_start: 2,
    ch_end: 4,
    iface: 'ens37',
    action: 'apply'
  })).data;
  ok('aplica sin fallos', applied?.ok === true && applied?.failed === 0, JSON.stringify(applied?.detail?.filter((d) => !d.ok)));
  const wantPorts = [
    ['NACIONAL 2', 4771],
    ['TELEMUNDO', 4772],
    ['CANAL 5', 4773]
  ];
  ok(
    'los 3 streams llevan el UDP del canal',
    wantPorts.every(([nm, port]) => udpOf(nm).some((u) => u.includes(`:${port}`))),
    JSON.stringify([...streamsState.keys()].map((k) => [k, udpOf(k)]))
  );
  ok('se usa PATCH, no PUT', patchCalls.every((p) => p.method === 'PATCH'), `${patchCalls.length} PATCH`);
  ok(
    'reemplaza la UDP anterior (una sola salida por stream)',
    udpOf('NACIONAL 2').length === 1 && udpOf('NACIONAL 2')[0] === 'udp://ens37@239.1.1.2:4771',
    JSON.stringify(udpOf('NACIONAL 2'))
  );
  ok(
    'el rtmp del usuario sigue intacto',
    (streamsState.get('NACIONAL 2').outputs || []).some((o) => String(o.url).startsWith('rtmp://')),
    JSON.stringify(streamsState.get('NACIONAL 2').outputs.map((o) => o.url))
  );

  snap = (await api('GET', '/api/wk2500/flussonic-push')).data;
  const after = (snap?.streams || []).find((s) => s.name === 'NACIONAL 2');
  ok('la foto dice que ya está en sincronía', after?.in_sync === true && after?.push?.running === true, JSON.stringify(after?.push));
  ok('guarda la interfaz para la próxima vez', snap?.iface === 'ens37', snap?.iface);

  // --- 4. Quitar la salida UDP del rango -------------------------------
  const removed = (await api('POST', '/api/wk2500/flussonic-push', {
    from_channels: true,
    ch_start: 2,
    ch_end: 3,
    action: 'remove'
  })).data;
  ok('quitar responde ok', removed?.ok === true, JSON.stringify(removed?.detail?.filter((d) => !d.ok)));
  ok('el CH2 y CH3 se quedan sin UDP', udpOf('NACIONAL 2').length === 0 && udpOf('TELEMUNDO').length === 0, JSON.stringify([udpOf('NACIONAL 2'), udpOf('TELEMUNDO')]));
  ok('el CH4 no se toca', udpOf('CANAL 5').length === 1, JSON.stringify(udpOf('CANAL 5')));
  ok('el rtmp sigue ahí', (streamsState.get('NACIONAL 2').outputs || []).some((o) => String(o.url).startsWith('rtmp://')));

  // --- 5. Edición fila a fila ------------------------------------------
  const manual = (await api('POST', '/api/wk2500/flussonic-push', {
    items: [{ stream: 'TELEMUNDO', url: 'udp://239.5.5.5:5555' }]
  })).data;
  ok('guardar una fila a mano funciona', manual?.ok === true, JSON.stringify(manual?.detail));
  ok('queda escrita tal cual (sin añadir interfaz a mano)', udpOf('TELEMUNDO').includes('udp://239.5.5.5:5555'), JSON.stringify(udpOf('TELEMUNDO')));

  const bad = (await api('POST', '/api/wk2500/flussonic-push', {
    items: [{ stream: 'TELEMUNDO', url: 'http://no-es-udp/nada' }]
  })).data;
  ok('una URL que no es UDP se rechaza con motivo', bad?.ok === false && /UDP válida/.test(bad?.detail?.[0]?.error || ''), bad?.detail?.[0]?.error);

  const missing = (await api('POST', '/api/wk2500/flussonic-push', {
    items: [{ stream: 'NO EXISTE', url: 'udp://239.5.5.5:5556' }]
  })).data;
  ok('un stream que no existe no rompe nada', missing?.ok === false && /404|no se pudo|No se pudo/i.test(missing?.detail?.[0]?.error || ''), missing?.detail?.[0]?.error);

  // --- 6. take_over: el canal pasa a Flussonic -------------------------
  const before = await countDatagrams(4776, 3500);
  ok('antes del take over el canal emite desde TVLister', before > 0, `${before} datagramas`);

  const takeover = (await api('POST', '/api/wk2500/flussonic-push', {
    from_channels: true,
    ch_start: 6,
    ch_end: 6,
    action: 'apply',
    take_over: true
  })).data;
  ok('el take over aplica', takeover?.ok === true, JSON.stringify(takeover?.detail));
  ok('deja anotado el canal tomado', (takeover?.taken_over || []).includes(6), JSON.stringify(takeover?.taken_over));
  await sleep(700);
  const whileDelegated = await countDatagrams(4776, 3000);
  ok('TVLister deja de emitir al mismo destino', whileDelegated === 0, `${whileDelegated} datagramas`);

  const plan = (await api('GET', '/api/wk2500/plan')).data;
  const ch6 = (plan?.slots || plan?.channels || []).find((c) => c.catv_ch === 6);
  ok('el canal queda con motor Flussonic en el plan', ch6?.live_engine === 'flussonic_api', `engine=${ch6?.live_engine}`);

  // El reconciliador (cada 4 s) no debe pisar la salida que puso el push:
  // misma IP:puerto, con su interfaz y sin parámetros añadidos.
  await sleep(5200);
  ok(
    'el reconciliador respeta la salida del push (no la reescribe)',
    udpOf('CANAL 6').length === 1 && udpOf('CANAL 6')[0] === 'udp://ens37@127.0.0.1:4776',
    JSON.stringify(udpOf('CANAL 6'))
  );

  // --- 7. Flussonic caído: el panel sigue en pie -----------------------
  fake.close();
  await sleep(300);
  const down = (await api('GET', '/api/wk2500/flussonic-push')).data;
  ok('con Flussonic caído lo dice, sin tumbar el panel', down?.flussonic_reachable === false && Boolean(down?.flussonic_error), down?.flussonic_error);
  ok('la lista no desaparece del panel', Array.isArray(down?.streams));
} finally {
  child.kill('SIGTERM');
  await sleep(600);
  try {
    child.kill('SIGKILL');
  } catch {
    // ya salió
  }
  try {
    fake.close();
  } catch {
    // ya cerrado
  }
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails ? 1 : 0);
