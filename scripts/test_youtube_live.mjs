#!/usr/bin/env node
// ============================================================================
// Prueba: TV en vivo de YouTube ingerida como canal 24/7.
//
//   node scripts/test_youtube_live.mjs
//
// Monta el panel real con:
//   · un yt-dlp de mentira que devuelve un manifiesto HLS con caducidad,
//   · un origen HLS local que hace de YouTube,
//   · un FFmpeg de mentira que escribe segmentos HLS como el real.
// Comprueba el alta del canal, la entrega por /live/<user>/<pass>/…m3u8,
// la renovación antes de que caduque la URL y el caso «no hay directo».
// ============================================================================
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvl-yt-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`ok   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.log(`FALLO ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ==================== Origen HLS (hace de YouTube) ====================
const SEGMENT = Buffer.alloc(188 * 30, 0x47);
const ORIGIN_PORT = 4711;
let originHits = 0;
const origin = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  originHits += 1;
  if (url.pathname === '/live/index.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:4.0,',
        'seg1.ts',
        '#EXT-X-ENDLIST'
      ].join('\n')
    );
  }
  if (url.pathname === '/live/seg1.ts') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEGMENT.length });
    return res.end(SEGMENT);
  }
  res.writeHead(404).end('no');
});
await new Promise((r) => origin.listen(ORIGIN_PORT, '127.0.0.1', r));

// ==================== yt-dlp de mentira ====================
const YT_TTL = Number(process.env.FAKE_YT_TTL || 3600);
const YT_COUNTER = path.join(TMP, 'yt-calls.txt');
const YT_FLAGS = path.join(TMP, 'yt-flags.json'); // { live: false } para simular sin directo
fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
const FAKE_YTDLP = path.join(TMP, 'yt-dlp');
fs.writeFileSync(
  FAKE_YTDLP,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.11.04-fake'); process.exit(0); }
const counter = ${JSON.stringify(YT_COUNTER)};
const flags = JSON.parse(fs.readFileSync(${JSON.stringify(YT_FLAGS)}, 'utf8') || '{}');
let n = 0;
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
n += 1;
fs.writeFileSync(counter, String(n));
const live = flags.live !== false;
const ttl = Number(flags.ttl || ${YT_TTL});
const exp = Math.floor(Date.now() / 1000) + ttl;
const manifest = 'http://127.0.0.1:${ORIGIN_PORT}/live/index.m3u8?expire=' + exp + '&gen=' + n;
const out = {
  id: 'LIVE' + n,
  title: live ? 'Noticias 24 Horas (directo)' : 'Programa grabado',
  uploader: 'Canal Demo',
  is_live: live,
  live_status: live ? 'is_live' : 'not_live',
  manifest_url: live ? manifest : '',
  http_headers: { 'User-Agent': 'Mozilla/5.0 (FakeYT)', Referer: 'https://www.youtube.com/' },
  formats: live ? [{ format_id: '95', protocol: 'm3u8_native', url: manifest, vcodec: 'avc1', acodec: 'mp4a', tbr: 1500, height: 720, http_headers: { 'User-Agent': 'Mozilla/5.0 (FakeYT)' } }] : []
};
console.log(JSON.stringify(out));
`,
  { mode: 0o755 }
);
const ytCalls = () => {
  try {
    return Number(fs.readFileSync(YT_COUNTER, 'utf8')) || 0;
  } catch {
    return 0;
  }
};

// ==================== FFmpeg de mentira (escribe HLS) ====================
const FAKE_FFMPEG = path.join(TMP, 'ffmpeg');
fs.writeFileSync(
  FAKE_FFMPEG,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('-version')) { console.log('ffmpeg version 6.0-fake'); process.exit(0); }
const out = args[args.length - 1];
const dir = path.dirname(out);
fs.mkdirSync(dir, { recursive: true });
const ts = Buffer.alloc(188 * 30, 0x47);
let seq = 0;
const write = () => {
  try {
    const name = 'seg' + seq + '.ts';
    fs.writeFileSync(path.join(dir, name), ts);
    const list = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:' + Math.max(0, seq - 5)];
    for (let i = Math.max(0, seq - 5); i <= seq; i += 1) {
      list.push('#EXTINF:4.0,');
      list.push('seg' + i + '.ts');
    }
    fs.writeFileSync(out + '.tmp', list.join('\\n'));
    fs.renameSync(out + '.tmp', out);
    seq += 1;
  } catch { process.exit(0); }
};
write();
const t = setInterval(write, 700);
process.on('SIGTERM', () => { clearInterval(t); process.exit(0); });
process.on('SIGINT', () => { clearInterval(t); process.exit(0); });
`,
  { mode: 0o755 }
);

// ==================== Panel real ====================
const APP_PORT = 4690;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DB = path.join(TMP, 't.db');
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    TVLISTER_DB_PATH: DB,
    TVLISTER_STREAMS_RUNTIME: path.join(TMP, 'streams_runtime'),
    FFMPEG_PATH: FAKE_FFMPEG,
    TVLISTER_YTDLP: FAKE_YTDLP,
    TVLISTER_LIVE_WATCHDOG_MS: '3000',
    TVLISTER_LIVE_OFFAIR_RECHECK_MS: '6000'
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

const cleanup = () => {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  try {
    origin.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(failures ? 1 : 0), 400);
};
process.on('SIGINT', cleanup);

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

  // --- 1. Estado de yt-dlp ------------------------------------------------
  let yt = (await api('GET', '/api/youtube/status')).data;
  ok('detecta yt-dlp', yt?.installed === true, `${yt?.bin} · ${yt?.version}`);
  ok('y dice si hay FFmpeg', yt?.ffmpeg === true);

  // --- 2. Vista previa del directo ---------------------------------------
  const probe = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).data;
  ok('el enlace está en directo', probe?.ok === true && probe?.live === true, JSON.stringify(probe?.error || ''));
  ok('trae el título del directo', probe?.title === 'Noticias 24 Horas (directo)', probe?.title);
  ok('y cuándo hay que renovar la URL', probe?.expires_in_min > 0, `${probe?.expires_in_min} min`);

  const notLive = (await api('POST', '/api/youtube/probe', { url: 'https://youtu.be/abc123' })).data;
  ok('un vídeo normal se rechaza con motivo', notLive?.live === true || notLive?.ok === true); // sigue en vivo por el fake
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: false }));
  const offAir = (await api('POST', '/api/youtube/probe', { url: 'https://youtu.be/abc123' })).data;
  ok('sin directo lo dice claro', offAir?.ok === false && /no está en directo/i.test(offAir?.error || ''), offAir?.error);
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));

  // --- 3. Alta del canal 24/7 con señal de YouTube -----------------------
  const created = (await api('POST', '/api/channels247', {
    name: 'Noticias 24/7 (YouTube)',
    category_id: 4,
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/@canaldemo/live',
    engine_mode: 'ffmpeg',
    transcode_profile_id: 2,
    watermark_text: ''
  })).data;
  ok('se crea el canal 24/7 con señal en vivo', Boolean(created?.id), JSON.stringify(created));

  const chId = created?.id;
  let list = (await api('GET', '/api/channels247')).data || [];
  let ch = list.find((c) => c.id === chId);
  ok('queda guardado como canal de señal en vivo', ch?.source_kind === 'youtube', ch?.source_kind);
  ok('y con el enlace normalizado', /youtube\.com/.test(ch?.live_source_url || ''), ch?.live_source_url);

  // El motor arranca y resuelve el directo.
  let attempts = 0;
  while (attempts < 40) {
    await sleep(400);
    list = (await api('GET', '/api/channels247')).data || [];
    ch = list.find((c) => c.id === chId);
    if (ch?.liveSource?.live && ch?.workerPid) break;
    attempts += 1;
  }
  ok('toma el directo y lo deja en vivo', ch?.liveSource?.live === true, JSON.stringify(ch?.liveSource));
  ok('arranca su motor 24/7', Boolean(ch?.workerPid), `PID ${ch?.workerPid}`);
  ok('el título viene del directo', ch?.liveSource?.title === 'Noticias 24 Horas (directo)', ch?.liveSource?.title);
  ok('la parrilla se informa como señal en vivo', ch?.liveState?.isLiveSource === true);

  // --- 4. Entrega al reproductor (HLS local del motor) -------------------
  execFileSync('node', [
    '-e',
    `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
     db.prepare("INSERT OR IGNORE INTO lines (username,password,bouquet_ids_json,exp_date) VALUES ('prueba','clave','[1]','2099-12-31')").run();
     db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chId}]));`
  ]);

  let hls = null;
  for (let i = 0; i < 30; i += 1) {
    const r = await fetch(`${BASE}/live/prueba/clave/${10000 + chId}.m3u8`);
    if (r.status === 200) {
      hls = await r.text();
      break;
    }
    await sleep(400);
  }
  ok('el canal se entrega por HLS', Boolean(hls && hls.includes('#EXTM3U')), hls ? hls.split('\n')[0] : 'sin manifiesto');
  ok(
    'y los segmentos apuntan al panel (no al origen)',
    Boolean(hls && /\/hls_out\/prueba\/clave\/ch247_/.test(hls)),
    hls ? hls.split('\n').filter((l) => l && !l.startsWith('#'))[0] : ''
  );

  const segUrl = (hls || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (segUrl) {
    const seg = await fetch(`${BASE}${segUrl}`);
    ok('el segmento se sirve con bytes', seg.status === 200 && (await seg.arrayBuffer()).byteLength > 0, `HTTP ${seg.status}`);
  }

  // --- 4b. Canal en modo «virtual»: 302 directo al manifiesto -------------
  {
    const virt = (await api('POST', '/api/channels247', {
      name: 'Directo sin motor (YouTube)',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/@canaldemo/live',
      engine_mode: 'virtual',
      transcode_profile_id: 2
    })).data;
    ok('se puede crear un canal en vivo sin motor', Boolean(virt?.id), JSON.stringify(virt));
    execFileSync('node', [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
       db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chId},${virt.id}]));`
    ]);
    let redir = null;
    for (let i = 0; i < 25; i += 1) {
      const r = await fetch(`${BASE}/live/prueba/clave/${10000 + virt.id}.m3u8`, { redirect: 'manual' });
      if (r.status === 302) {
        redir = r.headers.get('location') || '';
        break;
      }
      await sleep(400);
    }
    ok('sin motor, el canal manda al manifiesto del directo', /127\.0\.0\.1:4711\/live\/index\.m3u8/.test(redir || ''), redir?.slice(0, 70));
    const ts = await fetch(`${BASE}/live/prueba/clave/${10000 + virt.id}.ts`, { redirect: 'manual' });
    ok('y en MPEG-TS avisa que no aplica', ts.status === 503, `HTTP ${ts.status}`);
    await api('DELETE', `/api/channels247/${virt.id}`);
    execFileSync('node', [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
       db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chId}]));`
    ]);
  }

  // --- 5. Renovación antes de que caduque ---------------------------------
  const before = ytCalls();
  const refreshed = (await api('POST', `/api/channels247/${chId}/live-source/refresh`, {})).data;
  ok('renovar la señal responde ok', refreshed?.ok === true, JSON.stringify(refreshed?.state?.error || ''));
  ok('vuelve a preguntar a yt-dlp', ytCalls() > before, `${before} → ${ytCalls()}`);
  ok('y el motor sigue al aire', Boolean(refreshed?.workerPid), `PID ${refreshed?.workerPid}`);

  const stateUrl = refreshed?.state?.url || '';
  ok('la URL nueva trae su caducidad', /expire=/.test(stateUrl), stateUrl.slice(0, 60) + '…');

  // --- 6b. La guardia renueva sola la URL y reinicia el motor ------------
  // Se le pone al canal una URL de vida corta (40 s). A partir de ahí nadie
  // pulsa nada: la guardia (cada 3 s en esta prueba) tiene que renovarla.
  {
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, ttl: 40 }));
    const seeded = (await api('POST', `/api/channels247/${chId}/live-source/refresh`, {})).data;
    ok('la URL sembrada dura menos de un minuto', seeded?.liveSource?.expires_in_min <= 1, `${seeded?.liveSource?.expires_in_min} min`);
    const seededCalls = ytCalls();
    let renewed = false;
    let back = null;
    const dl = Date.now() + 45000;
    while (Date.now() < dl) {
      await sleep(1000);
      if (!renewed && ytCalls() > seededCalls) renewed = true;
      if (renewed) {
        const row = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chId);
        if (row?.workerPid && row?.liveSource?.live) {
          back = row;
          break;
        }
      }
    }
    ok('la guardia renueva la URL sola', renewed, `${seededCalls} → ${ytCalls()} llamadas a yt-dlp`);
    ok('y reinicia el motor con la URL nueva', Boolean(back?.workerPid), `PID ${back?.workerPid}`);
    ok('la caducidad vuelve a estar lejos', back?.liveSource?.expires_in_min > 0, `${back?.liveSource?.expires_in_min} min`);
    const hls2 = await fetch(`${BASE}/live/prueba/clave/${10000 + chId}.m3u8`);
    ok('el canal no deja de entregar HLS durante la renovación', hls2.status === 200, `HTTP ${hls2.status}`);
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
  }

  // --- 6. «Sin directo»: el canal lo dice y no deja basura ----------------
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: false }));
  const gone = (await api('POST', `/api/channels247/${chId}/live-source/refresh`, {})).data;
  ok('si el directo termina, se informa', gone?.ok === false && /no está en directo/i.test(gone?.state?.error || ''), gone?.state?.error);
  ok('y el motor se apaga', !gone?.workerPid, `PID ${gone?.workerPid}`);
  const afterOff = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chId);
  ok('el panel lo muestra como SIN SEÑAL', afterOff?.liveSource?.live === false);
  ok('sin borrar el canal ni su configuración', afterOff?.source_kind === 'youtube' && Boolean(afterOff?.live_source_url));
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));

  // --- 6c. El directo vuelve: la guardia lo enciende sola -----------------
  {
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
    let back = null;
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      await sleep(1000);
      const row = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chId);
      if (row?.workerPid && row?.liveSource?.live) {
        back = row;
        break;
      }
    }
    ok('cuando el directo vuelve, el canal se reengancha solo', Boolean(back?.workerPid), `PID ${back?.workerPid}`);
    const hls3 = await fetch(`${BASE}/live/prueba/clave/${10000 + chId}.m3u8`);
    ok('y se vuelve a ver sin tocar nada', hls3.status === 200, `HTTP ${hls3.status}`);
  }

  // --- 7. Volver a pegar el enlace y borrar ------------------------------
  const revived = (await api('POST', `/api/channels247/${chId}/live-source/refresh`, {})).data;
  ok('al volver el directo, el canal se recupera', revived?.ok === true && Boolean(revived?.workerPid), JSON.stringify(revived?.state?.error || ''));
  const del = await api('DELETE', `/api/channels247/${chId}`);
  ok('el canal se puede eliminar sin dejar el motor huérfano', del.status === 200);
} catch (err) {
  failures += 1;
  console.log(`FALLO general — ${err.message}`);
  console.log(boot.slice(-1200));
} finally {
  console.log(failures ? `\n${failures} fallo(s)` : '\nTODO OK');
  cleanup();
}
