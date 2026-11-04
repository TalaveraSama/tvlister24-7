#!/usr/bin/env node
// ============================================================================
// ESTABILIZADOR DE SALIDA UDP (pacer) — pruebas con el motor real
// ----------------------------------------------------------------------------
// El caso de campo: un canal de 2 Mbps que en el modulador aparece con ráfagas
// de 33 Mbps. Aquí se reproduce con el motor de verdad (`wk2500Manager.js`),
// un FFmpeg simulado que entrega a trozos y un receptor UDP local que mide lo
// mismo que mide el modulador: bytes por ventana de 250 ms.
//
//   1. FFmpeg simulado + pacer .......... línea plana (pico ≤ 1,3 × media)
//   2. Motor directo (HTTP) + pacer ..... línea plana
//   3. Motor directo SIN pacer .......... ráfagas (pico ≫ media)  ← la regresión
//   4. Detalles: paquetes nulos válidos, RTP, contrapresión, objetivo automático
//
// Uso:  node scripts/test_catv_udp_pacer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-pacer-'));
process.env.TVLISTER_DB_PATH = path.join(TMP, 'pacer.db');
process.env.TVLISTER_STREAMS_RUNTIME = path.join(TMP, 'streams_runtime');
delete process.env.TVLISTER_CATV_PACER;
delete process.env.TVLISTER_CATV_DIRECT;
process.env.TVLISTER_CATV_PACING = '1';

// --- FFmpeg de mentira: responde a -version y entrega el TS a trozos --------
const FAKE_FFMPEG = path.join(TMP, 'fake-ffmpeg.mjs');
fs.writeFileSync(
  FAKE_FFMPEG,
  `#!/usr/bin/env node
if (process.argv.includes('-version')) {
  console.log('ffmpeg version 6.0-fake Copyright (c) Prueba TVLister');
  process.exit(0);
}
// Entrega 2 s de un canal de 2 Mbps de golpe cada 2 s (como un HLS por segmentos).
// Si la salida es udp://host:puerto, escribe ahí (como el FFmpeg real); si es
// pipe:1, escribe en stdout (el pacer lee de ahí).
const CHUNK = Math.round((2000 * 1000 / 8) * 2);
const ts = Buffer.alloc(CHUNK, 0xff);
for (let i = 0; i < CHUNK; i += 188) {
  ts[i] = 0x47;
  ts[i + 1] = 0x1f; // PID nulo: el pacer no se confunde con PSI
  ts[i + 2] = 0xff;
  ts[i + 3] = 0x10;
}
const outUrl = process.argv.find((a) => a.startsWith('udp://') || a.startsWith('rtp://')) || '';
let sink;
if (outUrl) {
  const rest = String(outUrl.split('://')[1] || '').split('?')[0];
  const idx = rest.lastIndexOf(':');
  const host = idx > 0 ? rest.slice(0, idx) : '127.0.0.1';
  const port = idx > 0 ? Number(rest.slice(idx + 1)) : 5000;
  const dgram = await import('node:dgram');
  const socket = dgram.createSocket('udp4');
  // Como el FFmpeg real: trocea en datagramas de 1316 bytes.
  socket.on('error', (e) => { console.error('FAKE SOCKET ERROR', e.message, host, port); process.exit(1); });
  sink = (buf) => {
    try {
      for (let off = 0; off < buf.length; off += 1316) socket.send(buf.subarray(off, off + 1316), port, host);
    } catch (e) {
      console.error('FAKE SEND ERROR', e.message);
      process.exit(1);
    }
  };
} else {
  sink = (buf) => { try { process.stdout.write(buf); } catch { process.exit(0); } };
}
const emit = () => sink(ts);
emit();
const t = setInterval(emit, 2000);
process.on('SIGTERM', () => { clearInterval(t); process.exit(0); });
process.on('SIGINT', () => { clearInterval(t); process.exit(0); });
`,
  { mode: 0o755 }
);
process.env.FFMPEG_PATH = FAKE_FFMPEG;

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Receptor UDP: cuenta bytes por ventana de 250 ms, igual que el modulador. */
function startReceiver(port) {
  const socket = dgram.createSocket({ type: 'udp4' });
  const buckets = new Map();
  const datagrams = [];
  const t0 = Date.now();
  socket.on('message', (buf) => {
    const idx = Math.floor((Date.now() - t0) / 250);
    buckets.set(idx, (buckets.get(idx) || 0) + buf.length);
    datagrams.push(buf);
    if (datagrams.length > 8) datagrams.shift();
  });
  return new Promise((resolve) => {
    socket.bind(port, '127.0.0.1', () => resolve({ socket, buckets, datagrams, t0 }));
  });
}

function measure({ buckets }, skipMs = 2000) {
  // Se descartan los primeros ms (arranque del pacer/FFmpeg) para medir el
  // régimen estable. Las ventanas SIN datos cuentan como 0: ahí se ve la ráfaga.
  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  if (!entries.length) return { avg: 0, peak: 0, ratio: 0, windows: [], zero: 0 };
  const skipBuckets = Math.ceil(skipMs / 250);
  const map = new Map(entries);
  const firstKey = entries[0][0] + skipBuckets;
  const lastKey = entries[entries.length - 1][0];
  const values = [];
  for (let k = firstKey; k <= lastKey; k += 1) {
    values.push(Math.round(((map.get(k) || 0) * 8) / 250));
  }
  if (!values.length) return { avg: 0, peak: 0, ratio: 0, windows: [], zero: 0 };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const peak = Math.max(...values);
  return {
    avg: Math.round(avg),
    peak,
    ratio: avg > 0 ? Number((peak / avg).toFixed(2)) : 0,
    windows: values,
    zero: values.filter((v) => v === 0).length
  };
}

/** Servidor HTTP que entrega el mismo TS a trozos (motor directo). */
function startBurstySource(port) {
  const CHUNK = Math.round((2000 * 1000 / 8) * 2);
  const ts = Buffer.alloc(CHUNK, 0xff);
  for (let i = 0; i < CHUNK; i += 188) {
    ts[i] = 0x47;
    ts[i + 1] = 0x1f;
    ts[i + 2] = 0xff;
    ts[i + 3] = 0x10;
  }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    const t = setInterval(() => {
      try {
        res.write(ts);
      } catch {
        clearInterval(t);
      }
    }, 2000);
    req.on('close', () => clearInterval(t));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ===================== 1. Detalles del pacer (sin red) ======================
const { CatvUdpPacer, buildNullDatagram, createCatvPacer } = await import('../server/catvUdpPacer.js');

{
  const dg = buildNullDatagram(1316);
  let aligned = true;
  for (let i = 0; i < 1316; i += 188) {
    if (dg[i] !== 0x47) aligned = false;
    const pid = ((dg[i + 1] & 0x1f) << 8) | dg[i + 2];
    if (pid !== 0x1fff) aligned = false;
  }
  ok('El relleno CBR son paquetes nulos TS válidos (PID 0x1FFF, 7 por datagrama)', aligned);
}

{
  // RTP: cabecera de 12 bytes, PT 33 y secuencia creciente.
  const out = [];
  const pacer = new CatvUdpPacer({ host: 'x', port: 1, rtp: true, targetKbps: 2000, send: (b) => out.push(b) });
  pacer.push(Buffer.alloc(1316 * 20, 0x47));
  await sleep(120);
  await pacer.close();
  const first = out[0] || Buffer.alloc(0);
  ok('RTP: versión 2 y payload type 33 (MPEG-TS)', first[0] === 0x80 && first[1] === 33, `0x${first[0]?.toString(16)}/pt ${first[1]}`);
  ok('RTP: datagrama = cabecera 12 + 1316 de TS', out.every((b) => b.length === 1328), `${first.length} bytes`);
  const seqs = out.slice(0, 5).map((b) => b.readUInt16BE(2));
  const creciente = seqs.every((s, i) => i === 0 || s === ((seqs[i - 1] + 1) & 0xffff));
  ok('RTP: la secuencia sube de uno en uno', creciente, seqs.join(','));
}

{
  // Si el origen se corta, la portadora sigue con nulos (el modulador no ve un
  // hueco) pero el panel puede saber que no hay datos reales.
  const pacer = new CatvUdpPacer({ host: 'x', port: 1, targetKbps: 2500, send: () => {} });
  pacer.push(Buffer.alloc(1316 * 100, 0x47));
  await sleep(4500); // el relleno arranca al segundo de tener datos y tarda en estabilizarse
  const st = pacer.stats();
  await pacer.close();
  ok(
    'Origen cortado: la portadora se mantiene con relleno (y se marca sin datos)',
    st.null_pct > 50 && st.idle_payload_ms > 500 && st.sent_kbps > 2000,
    `relleno ${st.null_pct}% · ${st.idle_payload_ms} ms sin datos · ${st.sent_kbps} kbps`
  );
}

{
  // Contrapresión: una cola enorme no se tira, se espera.
  const sent = [];
  const pacer = new CatvUdpPacer({ host: 'x', port: 1, targetKbps: 1000, send: (b) => sent.push(b.length) });
  const antes = sent.length;
  pacer.push(Buffer.alloc(1024 * 1024, 0x47));
  ok('Contrapresión: avisa cuando la cola pasó el máximo', pacer.needsDrain() === true, `${Math.round(pacer.queuedBytes / 1024)} KB en cola`);
  pacer.drain(3000);
  await sleep(3400); // el reloj del pacer no mantiene vivo el proceso: se espera con un timer normal
  const despues = sent.length;
  ok('Contrapresión: `drain()` no pierde datos (sigue enviando)', despues > antes, `${despues - antes} datagramas`);
  await pacer.close();
}

{
  // Objetivo automático: con un origen de 2 Mbps el pacer debe quedarse cerca
  // de 2 Mbps (+10 %), no en 30 Mbps ni en el arranque de 3 Mbps.
  const sent = [];
  const pacer = new CatvUdpPacer({ host: 'x', port: 1, send: (b) => sent.push(b.length) });
  const CHUNK = Math.round((2000 * 1000 / 8) * 2);
  const data = Buffer.alloc(CHUNK, 0x47);
  const feeder = setInterval(() => pacer.push(data), 2000);
  pacer.push(data);
  await sleep(26000);
  clearInterval(feeder);
  await pacer.close();
  const st = pacer.stats();
  ok(
    'Objetivo automático: se ajusta al bitrate real del canal (2 Mbps)',
    st.target_kbps >= 2000 && st.target_kbps <= 2600,
    `objetivo ${st.target_kbps} kbps · pico ${st.peak_kbps} kbps · relleno ${st.null_pct}%`
  );
  ok('Objetivo automático: la salida queda plana', st.burst_ratio > 0 && st.burst_ratio <= 1.3, `pico/media ${st.burst_ratio}`);
}

{
  // Bucle de eventos cargado (SQLite, HTTP, 100 canales): el pacer no debe
  // perder ritmo por ello. Fue un fallo real: con el crédito limitado a 12 ms,
  // un retraso de 100 ms dejaba la salida corta y la cola crecía sin fin.
  const pacer = new CatvUdpPacer({ host: 'x', port: 1, targetKbps: 2250, send: () => {} });
  const CHUNK = Math.round((2000 * 1000 / 8) * 2);
  const data = Buffer.alloc(CHUNK, 0x47);
  const feeder = setInterval(() => pacer.push(data), 2000);
  const busy = setInterval(() => {
    const t = Date.now();
    while (Date.now() - t < 8) {
      /* bloquea el hilo 8 ms cada 30 ms */
    }
  }, 30);
  pacer.push(data);
  await sleep(8000);
  clearInterval(feeder);
  clearInterval(busy);
  const st = pacer.stats();
  await pacer.close();
  ok(
    'Con el bucle de eventos cargado mantiene el ritmo (sin quedarse corto)',
    st.sent_kbps > 2250 * 0.9 && st.sent_kbps < 2250 * 1.1,
    `${st.sent_kbps} kbps de 2250 · cola ${st.queue_ms} ms`
  );
}

{
  const off = ((process.env.TVLISTER_CATV_PACER = 'off'), createCatvPacer({ slotRow: { udp_host: '127.0.0.1', udp_port: 1 }, transport: { pktSize: 1316 } }));
  delete process.env.TVLISTER_CATV_PACER;
  ok('Se puede apagar con TVLISTER_CATV_PACER=off (vuelve al comportamiento anterior)', off === null);
}

// ===================== 2. Motor real: FFmpeg simulado ======================
const { initDb, db } = await import('../server/db.js');
initDb();
const { ensureCatvSlotsInitialized, startWk2500ChannelWorker, stopWk2500ChannelWorker, catvOutputPlan } =
  await import('../server/wk2500Manager.js');

ensureCatvSlotsInitialized();
db.prepare(
  `INSERT INTO wk2500_units (name, ip_mode, dest_ip, base_port, ch_start, ch_end, enabled, pkt_size, rtp, model_channels)
   VALUES ('Prueba pacer', 'unicast', '127.0.0.1', 5000, 2, 125, 1, 1316, 0, 125)`
).run();

const PORT_FFMPEG = 4741;
const PORT_DIRECT = 4742;
const PORT_BURST = 4743;

function configureChannel(ch, { port, source, muxrate = 2500 }) {
  db.prepare(
    `UPDATE wk2500_channels
        SET udp_host = '127.0.0.1', udp_port = ?, custom_source_url = ?, stream_id = NULL,
            output_mode = 'direct_spts', muxrate_kbps = ?, enabled = 1, ttl = 16,
            local_interface_ip = '', pkt_size = 0, rtp = -1
      WHERE catv_ch = ?`
  ).run(port, source, muxrate, ch);
}

const SERVERS = [];
const RECEIVERS = [];
try {
  const src = await startBurstySource(4799);
  SERVERS.push(src);

  // --- 2a. FFmpeg simulado (fuente HTTP, sin -direct) ----------------------
  {
    const rx = await startReceiver(PORT_FFMPEG);
    RECEIVERS.push(rx.socket);
    configureChannel(2, { port: PORT_FFMPEG, source: 'http://127.0.0.1:4799/live.ts' });
    startWk2500ChannelWorker(2);
    await sleep(14000);
    const m = measure(rx, 3000);
    stopWk2500ChannelWorker(2);
    await sleep(300);
    ok('FFmpeg + pacer: la salida llega a ritmo constante (≈ 2,5 Mbps)', m.avg > 2000 && m.avg < 3000, `media ${(m.avg / 1000).toFixed(2)} Mbps`);
    ok('FFmpeg + pacer: SIN ráfagas (pico ≤ 1,3 × la media)', m.ratio > 0 && m.ratio <= 1.3, `pico/media ${m.ratio} · pico ${(m.peak / 1000).toFixed(2)} Mbps`);
    ok('FFmpeg + pacer: no hay huecos en 0', m.zero === 0, `${m.zero} ventanas en 0`);
  }

  // --- 2b. Motor directo (HTTP TS crudo) + pacer ---------------------------
  process.env.TVLISTER_CATV_DIRECT = '1';
  {
    const rx = await startReceiver(PORT_DIRECT);
    RECEIVERS.push(rx.socket);
    configureChannel(3, { port: PORT_DIRECT, source: 'http://127.0.0.1:4799/live2.ts' });
    startWk2500ChannelWorker(3);
    await sleep(14000);
    const m = measure(rx, 3000);
    stopWk2500ChannelWorker(3);
    await sleep(300);
    ok('Motor directo + pacer: ritmo constante', m.avg > 2000 && m.avg < 3000, `media ${(m.avg / 1000).toFixed(2)} Mbps`);
    ok('Motor directo + pacer: SIN ráfagas', m.ratio > 0 && m.ratio <= 1.3, `pico/media ${m.ratio} · pico ${(m.peak / 1000).toFixed(2)} Mbps`);
  }

  // --- 2c. Motor directo SIN pacer: aquí SÍ hay ráfagas (la regresión) ----
  process.env.TVLISTER_CATV_PACER = 'off';
  {
    const rx = await startReceiver(PORT_BURST);
    RECEIVERS.push(rx.socket);
    configureChannel(4, { port: PORT_BURST, source: 'http://127.0.0.1:4799/live3.ts' });
    startWk2500ChannelWorker(4);
    await sleep(4000);
    const snap4 = globalThis.__tvlisterCatvWorkerSnapshot?.()?.get(4);
    await sleep(8000);
    const m = measure(rx, 3000);
    stopWk2500ChannelWorker(4);
    await sleep(300);
    ok(
      'Sin pacer el mismo canal SÍ sale a ráfagas (la prueba detecta el problema real)',
      m.ratio >= 2,
      `pico/media ${m.ratio} · media ${(m.avg / 1000).toFixed(2)} Mbps · pico ${(m.peak / 1000).toFixed(2)} Mbps`
    );
  }
  delete process.env.TVLISTER_CATV_PACER;
  delete process.env.TVLISTER_CATV_DIRECT;

  // --- 2d. El plan de salida lo anuncia --------------------------------
  const plan = catvOutputPlan({ onlyEnabled: true });
  ok('El plan de salida marca el estabilizador en cada canal', plan.length >= 3 && plan.every((r) => r.pacer === true), `${plan.length} canales`);
  ok('El plan de salida dice «constante» con el pacer activo', plan.every((r) => r.constant === true));
} finally {
  for (const s of RECEIVERS) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  for (const s of SERVERS) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
}

console.log(fails.length === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails ? 1 : 0);
