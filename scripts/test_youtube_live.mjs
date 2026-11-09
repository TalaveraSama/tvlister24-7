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
  // Archivos «mp4» de mentira para los vídeos sueltos y las listas (el FFmpeg
  // de la prueba no los lee: sólo interesa que la URL sea la correcta).
  if (/\.mp4$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': SEGMENT.length });
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
const flagsFile = ${JSON.stringify(YT_FLAGS)};
const flags = JSON.parse(fs.readFileSync(flagsFile, 'utf8') || '{}');
// Registro de argumentos de cada llamada (para comprobar --cookies, --extractor-args…).
try { fs.appendFileSync(${JSON.stringify(path.join(TMP, 'yt-argv.txt'))}, JSON.stringify(args) + '\\n'); } catch {}
// «Requested format is not available»: el cliente normal no recibe ninguna pista
// con URL (PO token / SABR). Con player_client=tv, sí. Con 'all', ninguno.
const clientArg = String((args[args.indexOf('--extractor-args') + 1]) || '');
if (flags.noFormats === 'all' || (flags.noFormats === 'tv' && !/player_client=tv/.test(clientArg))) {
  console.error('ERROR: [youtube] ioSKlIL4Hs8: Requested format is not available. Use --list-formats for a list of available formats');
  process.exit(1);
}
// El control anti-robots de YouTube: sólo pasa si el panel le da cookies.
if (flags.bot && !process.argv.includes('--cookies')) {
  console.error("ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm you're not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp for more information.");
  process.exit(1);
}
if (flags.bot) fs.writeFileSync(${JSON.stringify(path.join(TMP, 'yt-cookies-used.txt'))}, process.argv.slice(2).join(' '));
let n = 0;
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
n += 1;
fs.writeFileSync(counter, String(n));

const target = String(args[args.length - 1] || '');
const isPlaylistUrl = /playlist\\?list=|[?&]list=/.test(target) && !args.includes('--no-playlist');
const ttl = Number(flags.ttl || ${YT_TTL});
const exp = Math.floor(Date.now() / 1000) + ttl;
const seg = 'http://127.0.0.1:${ORIGIN_PORT}';
const live = flags.live !== false;
const wantVideo = flags.video !== false;
const codec = flags.codec === 'vp9' ? 'vp09.00.10.08' : 'avc1.64001F';
const headers = { 'User-Agent': 'Mozilla/5.0 (FakeYT)', Referer: 'https://www.youtube.com/' };
const mp4 = (name, extra) => Object.assign({
  format_id: '22', ext: 'mp4', protocol: 'https', url: seg + '/video' + name + '.mp4?expire=' + exp + '&gen=' + n,
  vcodec: codec, acodec: 'mp4a.40.2', width: 1280, height: 720, tbr: 1500, http_headers: headers
}, extra || {});

if (isPlaylistUrl) {
  const count = Number(flags.entries || 3);
  const entries = [];
  for (let i = 1; i <= count; i += 1) {
    if (flags.withLive && i === 2) {
      entries.push({ id: 'LIVE' + i, title: 'Directo dentro de la lista (se omite)', is_live: true, live_status: 'is_live', formats: [] });
      continue;
    }
    if (flags.withBadEntry && i === 3) {
      entries.push({ id: 'BAD' + i, title: 'Sin formato utilizable', duration: 60, formats: [] });
      continue;
    }
    entries.push({
      id: 'VID' + i,
      title: 'Programa ' + i,
      duration: Number(flags.duration || 300),
      live_status: 'not_live',
      formats: [mp4(String(i))]
    });
  }
  console.log(JSON.stringify({ _type: 'playlist', id: 'PLdemo', title: flags.listTitle || 'Lista Demo', uploader: 'Canal Demo', entries }));
  process.exit(0);
}

if (live) {
  const manifest = seg + '/live/index.m3u8?expire=' + exp + '&gen=' + n;
  // Directo con vídeo y audio en PISTAS SEPARADAS (como DASH/HLS de YouTube):
  // hay que abrir las dos y mapearlas para no quedarse sin sonido.
  if (flags.separateAudio) {
    const videoUrl = seg + '/live/v1080.m3u8?expire=' + exp + '&gen=' + n;
    const audioUrl = seg + '/live/a128.m3u8?expire=' + exp + '&gen=' + n;
    console.log(JSON.stringify({
      id: 'LIVE' + n,
      title: 'Directo con pistas separadas',
      uploader: 'Canal Demo',
      is_live: true,
      live_status: 'is_live',
      manifest_url: '',
      http_headers: headers,
      formats: [
        { format_id: '301', protocol: 'm3u8_native', url: videoUrl, vcodec: 'avc1.64001F', acodec: 'none', tbr: 2500, height: 1080, http_headers: headers },
        { format_id: '302', protocol: 'm3u8_native', url: seg + '/live/v720.m3u8?expire=' + exp + '&gen=' + n, vcodec: 'avc1.4d401f', acodec: 'none', tbr: 900, height: 720, http_headers: headers },
        { format_id: '251', protocol: 'm3u8_native', url: audioUrl, vcodec: 'none', acodec: 'mp4a.40.2', tbr: 128, http_headers: headers }
      ]
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    id: 'LIVE' + n,
    title: 'Noticias 24 Horas (directo)',
    uploader: 'Canal Demo',
    is_live: true,
    live_status: 'is_live',
    manifest_url: manifest,
    http_headers: headers,
    formats: [{ format_id: '95', protocol: 'm3u8_native', url: manifest, vcodec: 'avc1', acodec: 'mp4a', tbr: 1500, height: 720, http_headers: headers }]
  }));
  process.exit(0);
}

// Un directo que ya terminó: si no queda archivo, no hay nada que emitir.
const looksLive = /\\/live\\/?$|@canal\\/live|\\/live\\?/.test(target);
console.log(JSON.stringify({
  id: 'VID' + n,
  title: flags.title || (looksLive ? 'Directo terminado' : 'Documental grabado'),
  uploader: 'Canal Demo',
  duration: Number(flags.duration || 125),
  is_live: false,
  live_status: looksLive ? 'post_live' : 'not_live',
  http_headers: headers,
  formats: wantVideo ? [mp4('x')] : []
}));
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
const FFMPEG_ARGS = path.join(TMP, 'ffmpeg-args.log');
fs.writeFileSync(
  FAKE_FFMPEG,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('-version')) { console.log('ffmpeg version 6.0-fake'); process.exit(0); }
try { fs.appendFileSync(${JSON.stringify(FFMPEG_ARGS)}, args.join(' ') + '\\n'); } catch {}
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
    APP_DIR: path.join(TMP, 'app'),
    TVLISTER_STREAMS_RUNTIME: path.join(TMP, 'streams_runtime'),
    FFMPEG_PATH: FAKE_FFMPEG,
    TVLISTER_YTDLP: FAKE_YTDLP,
    TVLISTER_LIVE_WATCHDOG_MS: '3000',
    TVLISTER_LIVE_OFFAIR_RECHECK_MS: '6000',
    TVLISTER_YTDLP_RELEASES: '0'
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

  // --- 1b. Sin yt-dlp no se miente: lo dice claro -------------------------
  // (Se comprueba en un proceso aparte: el panel de la prueba sí tiene yt-dlp.)
  {
    const code = `
      const m = await import(${JSON.stringify(path.join(ROOT, 'server/youtubeLive.js'))});
      const info = await m.getYtDlpInfo();
      const probe = await m.resolveLiveSource('https://youtu.be/abc123');
      console.log(JSON.stringify({ bin: m.findYtDlp(), installed: info.installed, hint: info.hint, needs: probe.needs_ytdlp, error: probe.error }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, PATH: '/usr/bin:/bin', TVLISTER_YTDLP: '', TVLISTER_DB_PATH: path.join(TMP, 'sin-yt.db') },
      encoding: 'utf8'
    });
    const info = JSON.parse(out.trim().split('\n').pop() || '{}');
    ok('sin yt-dlp no se inventa una ruta', info.bin === '', JSON.stringify(info.bin));
    ok('y el estado dice que falta', info.installed === false && /Falta yt-dlp/.test(info.hint || ''), (info.hint || '').slice(0, 40));
    ok('el probe pide instalarlo', info.needs === true, (info.error || '').slice(0, 50));
    ok('y no dice que está roto', !/no arranca/.test(info.error || ''), (info.error || '').slice(0, 50));
  }

  // --- 1c. Instalar yt-dlp: si el zipapp no arranca, cae al autónomo ------
  // Se pone un `curl` de mentira en el PATH: el autónomo (yt-dlp_linux) es un
  // script que imprime su versión; el zipapp imita el traceback real de un
  // Python recortado, que es justo el fallo que se vio en producción.
  {
    const binDir = path.join(TMP, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'curl'),
      `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
const url = args.find((a) => a.startsWith('http'));
const mode = process.env.FAKE_DL_MODE || 'standalone-ok';
const zipapp = ${JSON.stringify(`#!/usr/bin/env python3
import sys
import runpy
raise ModuleNotFoundError("No module named '_ssl'")
`)};
const standalone = ${JSON.stringify(`#!/bin/sh
echo "2026.11.04-standalone"
`)};
const isStandalone = /yt-dlp_linux/.test(url);
const isZipapp = /\\/yt-dlp$/.test(url);
let body = '';
if (mode === 'standalone-ok') body = isStandalone ? standalone : '';
else if (mode === 'zipapp-ok') body = isZipapp ? standalone : '';
else body = zipapp; // both-broken: los dos fallan al arrancar
if (!body) { console.error('curl: (22) 404'); process.exit(22); }
fs.writeFileSync(out, body, { mode: 0o755 });
`,
      { mode: 0o755 }
    );

    const runInstall = (mode) => {
      const code = `
        import { initDb } from ${JSON.stringify(path.join(ROOT, 'server/db.js'))};
        import { installYtDlp, getYtDlpInfo } from ${JSON.stringify(path.join(ROOT, 'server/youtubeLive.js'))};
        initDb();
        const r = await installYtDlp();
        const st = await getYtDlpInfo();
        console.log(JSON.stringify({ r, st }));
      `;
      const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
        env: {
          ...process.env,
          PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          FAKE_DL_MODE: mode,
          APP_DIR: path.join(TMP, 'appdl'),
          TVLISTER_DB_PATH: path.join(TMP, `dl-${mode}.db`),
          TVLISTER_YTDLP: ''
        },
        encoding: 'utf8'
      });
      return JSON.parse(out.trim().split('\n').pop() || '{}');
    };

    const okInstall = runInstall('standalone-ok');
    ok('instala el binario autónomo (sin Python)', okInstall?.r?.ok === true && okInstall?.r?.variant === 'standalone', JSON.stringify(okInstall?.r?.variant));
    ok('lo deja como .runtime/bin/yt-dlp', /\.runtime\/bin\/yt-dlp$/.test(okInstall?.r?.path || ''), okInstall?.r?.path);
    ok('y el panel lo ve listo', okInstall?.st?.installed === true && /2026\.11\.04/.test(okInstall?.st?.version || ''), okInstall?.st?.version);
    ok(
      'el binario autónomo se prueba antes de ocupar el nombre bueno',
      fs.existsSync(path.join(TMP, 'appdl', '.runtime', 'bin', 'yt-dlp')) &&
        !fs.readdirSync(path.join(TMP, 'appdl', '.runtime', 'bin')).some((f) => f.includes('.tmp.')),
      fs.readdirSync(path.join(TMP, 'appdl', '.runtime', 'bin')).join(',')
    );

    // Si el autónomo no se puede bajar (404) pero el zipapp sí y funciona.
    const zipOnly = runInstall('zipapp-ok');
    ok('si el autónomo falla, usa el zipapp', zipOnly?.r?.ok === true && zipOnly?.r?.variant === 'zipapp', JSON.stringify(zipOnly?.r?.variant));

    // Ninguno arranca: el error dice la causa real y qué se intentó.
    const broken = runInstall('both-broken');
    ok('si no arranca ninguno, no se deja un binario roto', broken?.r?.ok === false, JSON.stringify(broken?.r?.ok));
    ok('el error trae la causa del traceback (la última línea)', /ModuleNotFoundError/.test(broken?.r?.error || ''), (broken?.r?.error || '').slice(0, 120));
    ok('y dice qué se intentó', /Se intentó/.test(broken?.r?.error || '') && /standalone/.test(broken?.r?.error || ''), '');
    ok('no promete instalar python3 por apt', !/Instala python3/.test(broken?.r?.error || ''));

    // El panel no espera a la descarga: lanza un trabajo y consulta el paso.
    const job = (() => {
      const code = `
        import { initDb } from ${JSON.stringify(path.join(ROOT, 'server/db.js'))};
        import { startYtDlpInstall, ytInstallState } from ${JSON.stringify(path.join(ROOT, 'server/youtubeLive.js'))};
        initDb();
        const first = startYtDlpInstall();
        const whileRunning = ytInstallState();
        const steps = new Set();
        for (let i = 0; i < 500; i += 1) {
          const st = ytInstallState();
          if (st.step) steps.add(st.step.replace(/\d+(\.\d+)? MB/g, 'N MB'));
          if (!st.running) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        const done = ytInstallState();
        const again = startYtDlpInstall(); // ya terminó: se puede repetir
        console.log(JSON.stringify({ first, whileRunning, steps: [...steps], done, againRunning: again.running }));
      `;
      const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
        env: {
          ...process.env,
          PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          FAKE_DL_MODE: 'standalone-ok',
          APP_DIR: path.join(TMP, 'appjob'),
          TVLISTER_DB_PATH: path.join(TMP, 'dl-job.db'),
          TVLISTER_YTDLP: ''
        },
        encoding: 'utf8'
      });
      return JSON.parse(out.trim().split('\n').pop() || '{}');
    })();
    ok('el panel arranca la instalación sin esperarla', job?.first?.running === true, JSON.stringify(job?.first?.running));
    ok('y dice en qué paso va', job?.whileRunning?.running === true && /descargando|comprobando/.test(job?.whileRunning?.step || ''), job?.whileRunning?.step);
    ok('al terminar deja de correr y guarda el resultado', job?.done?.running === false && job?.done?.result?.ok === true, JSON.stringify(job?.done?.result?.variant));
    ok('se puede volver a instalar después', job?.againRunning === true);

    // Y por HTTP, como lo hace la pantalla: 202 al instante y el paso a la vista.
    // (Panel aparte con el curl falso: la descarga falla al momento, sin red.)
    const PORT2 = 4691;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const child2 = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT2),
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_DL_MODE: 'both-broken',
        TVLISTER_DB_PATH: path.join(TMP, 'http-install.db'),
        TVLISTER_STREAMS_RUNTIME: path.join(TMP, 'http_streams'),
        TVLISTER_YTDLP: '',
        APP_DIR: path.join(TMP, 'apphttp')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      let up2 = false;
      const dl2 = Date.now() + 30000;
      while (Date.now() < dl2 && !up2) {
        try {
          up2 = (await fetch(`${BASE2}/api/health`)).ok;
        } catch {
          await sleep(200);
        }
      }
      const h = { 'Content-Type': 'application/json' };
      const lg = await fetch(`${BASE2}/api/auth/login`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
      }).then((r) => r.json());
      const tk = lg?.token || '';
      const r1 = await fetch(`${BASE2}/api/youtube/install`, { method: 'POST', headers: { ...h, Authorization: `Bearer ${tk}` }, body: '{}' });
      const b1 = await r1.json();
      ok('POST install responde 202 al instante (no espera la descarga)', r1.status === 202 && b1?.running === true, `${r1.status} · ${b1?.step || ''}`);
      let st2 = null;
      const t2 = Date.now() + 25000;
      while (Date.now() < t2) {
        st2 = await fetch(`${BASE2}/api/youtube/install-status`, { headers: { Authorization: `Bearer ${tk}` } }).then((r) => r.json());
        if (!st2?.running) break;
        await sleep(300);
      }
      ok('install-status informa del fallo con la causa', st2?.running === false && st2?.result?.ok === false && /ModuleNotFoundError/.test(st2?.result?.error || ''), (st2?.result?.error || '').slice(0, 80));
      ok('y deja el panel sin yt-dlp (no finge tenerlo)', st2?.status?.installed === false);
    } finally {
      child2.kill('SIGTERM');
    }
  }

  // --- 1d. Cookies: la salida limpia al «Sign in to confirm you're not a bot» --
  // YouTube bloquea las IP de datacenter y no entrega ni un formato. El panel
  // debe explicarlo y ofrecer subir el cookies.txt (formato Netscape), no
  // escupir el texto en inglés de yt-dlp.
  {
    const COOKIE_TXT = [
      '# Netscape HTTP Cookie File',
      '# https://curl.se/docs/http-cookies.html',
      '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSID\tabc123',
      '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\ttz=UTC',
      '.youtube.com\tTRUE\t/\tFALSE\t1893456000\tVISITOR_INFO1_LIVE\txyz'
    ].join('\n');

    // 1) El validador: qué sirve y qué no (en un proceso aparte, como el panel).
    const unit = (() => {
      const code = `
        import { inspectCookiesText, explainYtDlpError, isBotCheckError } from ${JSON.stringify(path.join(ROOT, 'server/youtubeLive.js'))};
        const good = ${JSON.stringify(COOKIE_TXT)};
        const noYt = '# Netscape HTTP Cookie File\\n.google.com\\tTRUE\\t/\\tTRUE\\t1893456000\\tSID\\tx';
        const noAuth = '# Netscape HTTP Cookie File\\n.youtube.com\\tTRUE\\t/\\tTRUE\\t1893456000\\tPREF\\ttz=UTC';
        const asJson = JSON.stringify([{ domain: '.youtube.com', name: 'SID', value: 'x' }], null, 2);
        const botMsg = "ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm you're not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.";
        console.log(JSON.stringify({
          good: inspectCookiesText(good),
          noYt: inspectCookiesText(noYt),
          noAuth: inspectCookiesText(noAuth),
          asJson: inspectCookiesText(asJson),
          empty: inspectCookiesText(''),
          bot: isBotCheckError(botMsg),
          notBot: isBotCheckError('ERROR: Unsupported URL: https://example.com'),
          explained: explainYtDlpError(botMsg)
        }));
      `;
      const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
        env: { ...process.env, TVLISTER_DB_PATH: path.join(TMP, 'ck-unit.db'), APP_DIR: path.join(TMP, 'app') },
        encoding: 'utf8'
      });
      return JSON.parse(out.trim().split('\n').pop() || '{}');
    })();

    ok('las cookies buenas se aceptan', unit?.good?.ok === true, `${unit?.good?.count} líneas · ${unit?.good?.youtube} de youtube.com`);
    ok('y se detecta la sesión iniciada', unit?.good?.auth === true);
    ok('cuenta las HttpOnly (#HttpOnly_)', unit?.good?.count === 3, `${unit?.good?.count}`);
    ok('un archivo sin youtube.com se rechaza', unit?.noYt?.ok === false && /no trae cookies de youtube\.com/.test(unit?.noYt?.error || ''), (unit?.noYt?.error || '').slice(0, 60));
    ok('uno sin sesión se acepta pero se avisa', unit?.noAuth?.ok === true && /falta SID/.test(unit?.noAuth?.warn || ''), (unit?.noAuth?.warn || '').slice(0, 60));
    ok('el JSON de otra extensión se rechaza con el motivo', unit?.asJson?.ok === false && /formato Netscape/.test(unit?.asJson?.error || ''), (unit?.asJson?.error || '').slice(0, 60));
    ok('un archivo vacío se rechaza', unit?.empty?.ok === false);
    ok('reconoce el error anti-robots', unit?.bot === true);
    ok('y no confunde otros errores', unit?.notBot === false);
    ok('el error se explica con la salida (subir cookies)', /Sign in to confirm/.test(unit?.explained?.message || '') && /cookies/i.test(unit?.explained?.message || ''), (unit?.explained?.message || '').slice(0, 90));
    ok('y se marca como needs_cookies', unit?.explained?.needs_cookies === true);

    // 2) El panel real: sin cookies, YouTube «bloquea» y el probe lo explica.
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, bot: true }));
    try {
      fs.rmSync(path.join(TMP, 'yt-cookies-used.txt'), { force: true });
    } catch {
      /* no estaba */
    }
    const bot = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=ioSKlIL4Hs8' })).data;
    ok('el probe con bloqueo pide cookies', bot?.ok === false && bot?.needs_cookies === true, (bot?.error || '').slice(0, 70));
    ok('sin pegar el texto en inglés tal cual', !/^yt-dlp no pudo leer el enlace/.test(bot?.error || ''));
    ok('y deja el texto de yt-dlp aparte (para soporte)', /Sign in to confirm/.test(bot?.detail || ''), (bot?.detail || '').slice(0, 60));

    // 3) Subir el archivo: se valida, se guarda 0600 y se usa solo.
    const postCookies = async (body) => {
      const r = await fetch(`${BASE}/api/youtube/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
        body
      });
      let data = null;
      try {
        data = await r.json();
      } catch {
        data = null;
      }
      return { status: r.status, data };
    };

    const badUpload = await postCookies('{"cookies": []}');
    ok('subir un archivo que no es Netscape da 400 con el motivo', badUpload.status === 400 && /Netscape/.test(badUpload.data?.error || ''), (badUpload.data?.error || '').slice(0, 50));

    const up = await postCookies(COOKIE_TXT);
    ok('subir el cookies.txt bueno responde ok', up.status === 200 && up.data?.ok === true, up.data?.message);
    ok('y la ruta es la del runtime del panel', /\.runtime[\\/]youtube-cookies\.txt$/.test(up.data?.path || ''), up.data?.path);
    let mode = '';
    try {
      mode = (fs.statSync(up.data.path).mode & 0o777).toString(8);
    } catch {
      mode = 'no-existe';
    }
    ok('el archivo queda con permisos 600', mode === '600', mode);
    ok('el estado del panel lo da por usable', up.data?.cookies?.usable === true && up.data?.cookies?.auth === true);

    // 4) Con cookies, el mismo enlace ya se resuelve y yt-dlp las recibe.
    const after = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=ioSKlIL4Hs8' })).data;
    ok('con cookies el enlace se lee', after?.ok === true && after?.live === true, after?.error);
    ok('el probe dice que va con cookies', after?.using_cookies === true);
    let used = '';
    try {
      used = fs.readFileSync(path.join(TMP, 'yt-cookies-used.txt'), 'utf8');
    } catch {
      used = '';
    }
    ok('yt-dlp recibe --cookies con el archivo guardado', /--cookies\s+\S*youtube-cookies\.txt/.test(used), used.slice(0, 120));

    // 5) Quitarlas dejarlo todo como estaba.
    const del = await fetch(`${BASE}/api/youtube/cookies`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    const delBody = await del.json().catch(() => null);
    ok('se pueden quitar las cookies', del.status === 200 && delBody?.cookies?.path === '', delBody?.cookies?.path);
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
  }

  // --- 1e. «Requested format is not available»: no se queda a oscuras ------
  // YouTube cambia cada pocas semanas qué cliente entrega pistas con URL. El
  // panel no debe rendirse con el primero: -J no debe abortar por selección de
  // formato, y si no hay ni una pista, se prueban otros clientes.
  {
    const argvLog = () => {
      try {
        return fs
          .readFileSync(path.join(TMP, 'yt-argv.txt'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const clearArgv = () => {
      try {
        fs.rmSync(path.join(TMP, 'yt-argv.txt'), { force: true });
      } catch {
        /* no estaba */
      }
    };

    clearArgv();
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, noFormats: 'tv' }));
    const fallback = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=ioSKlIL4Hs8' })).data;
    const argvs = argvLog();
    ok('con el cliente normal sin pistas, se reintenta con otro cliente', fallback?.ok === true, fallback?.error);
    ok('y la señal queda lista para copiar', fallback?.live === true && fallback?.copy_kind);
    ok(
      'el reintento usa --extractor-args youtube:player_client=tv',
      argvs.some((a) => a.includes('--extractor-args') && a.includes('youtube:player_client=tv')),
      `${argvs.length} llamadas`
    );
    ok(
      'todas las lecturas llevan --ignore-no-formats-error',
      argvs.length > 0 && argvs.every((a) => a.includes('--ignore-no-formats-error')),
      JSON.stringify(argvs[0]?.slice(0, 3) || [])
    );
    ok('y dice con qué clientes se probó', /normal/.test(fallback?.clients_tried || '') && /tv/.test(fallback?.clients_tried || ''), fallback?.clients_tried);

    // Ningún cliente da pistas: mensaje que se puede accionar, no el inglés.
    clearArgv();
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, noFormats: 'all' }));
    const none = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=ioSKlIL4Hs8' })).data;
    ok('si ningún cliente da pistas, se dice claro', none?.ok === false && none?.needs_format_fix === true, (none?.error || '').slice(0, 70));
    ok('con la salida: actualizar yt-dlp', /Actualizar yt-dlp/.test(none?.error || ''));
    ok('sin pegar el inglés tal cual delante', !/^yt-dlp no pudo leer el enlace/.test(none?.error || ''));
    ok('y se probaron los cuatro clientes', (none?.clients_tried || '').split(',').length === 4, none?.clients_tried);
    ok('el texto original queda en el detalle', /Requested format is not available/.test(none?.detail || ''), (none?.detail || '').slice(0, 60));

    // El estado del canal lo guarda: la tarjeta puede avisar sin volver a probar.
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
    ok('vuelve a funcionar al quitar el fallo', (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=ioSKlIL4Hs8' })).data?.ok === true);

    // ── ¿Hay versión nueva de yt-dlp? (consulta cacheada, best-effort) ───────
    // El servidor de prueba va DENTRO del proceso hijo: execFileSync bloquearía
    // el bucle de este proceso y nadie contestaría a la petición.
    const relCode = `
      import http from 'node:http';
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tag_name: '2099.01.01' }));
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      process.env.TVLISTER_YTDLP_RELEASE_API = 'http://127.0.0.1:' + srv.address().port + '/releases/latest';
      const m = await import(${JSON.stringify(path.join(ROOT, 'server/youtubeLive.js'))});
      const rel = await m.ytDlpReleaseInfo({ waitMs: 4000 });
      srv.close();
      console.log(JSON.stringify({
        rel,
        older: m.isYtDlpOutdated('2026.11.04', rel.tag),
        same: m.isYtDlpOutdated(rel.tag, rel.tag),
        newer: m.isYtDlpOutdated('2099.02.02', rel.tag),
        standalone: m.isYtDlpOutdated('2026.10.26-standalone', '2026.11.04')
      }));
    `;
    const relOut = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', relCode], {
      env: {
        ...process.env,
        TVLISTER_DB_PATH: path.join(TMP, 'rel.db'),
        APP_DIR: path.join(TMP, 'app')
      },
      encoding: 'utf8'
    });
    const rel = JSON.parse(relOut.trim().split('\n').pop() || '{}');
    ok('consulta la última versión publicada de yt-dlp', rel?.rel?.tag === '2099.01.01', JSON.stringify(rel?.rel?.tag));
    ok('y sabe cuándo la instalada es vieja', rel?.older === true);
    ok('sin avisar cuando es la misma', rel?.same === false);
    ok('ni cuando la instalada es más nueva', rel?.newer === false);
    ok('el binario autónomo también se compara bien', rel?.standalone === true);
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
  }

  // --- 2. Vista previa del directo ---------------------------------------
  const probe = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).data;
  ok('el enlace está en directo', probe?.ok === true && probe?.live === true, JSON.stringify(probe?.error || ''));
  ok('trae el título del directo', probe?.title === 'Noticias 24 Horas (directo)', probe?.title);
  ok('y cuándo hay que renovar la URL', probe?.expires_in_min > 0, `${probe?.expires_in_min} min`);

  // Un vídeo normal ya no se rechaza: se emite en bucle como 24/7.
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: false, video: true }));
  const vid = (await api('POST', '/api/youtube/probe', { url: 'https://youtu.be/abc123' })).data;
  ok('un vídeo suelto se acepta (en bucle)', vid?.ok === true && vid?.mode === 'video', JSON.stringify({ mode: vid?.mode, error: vid?.error }));
  ok('con su duración', vid?.duration_sec === 125, `${vid?.duration_sec}s`);
  ok('y sin recodificar (H.264 + AAC 720p)', vid?.needs_transcode === false);
  ok('dice que no es un directo', vid?.live === false);

  // Si el vídeo no ofrece MP4 (sólo HLS/DASH), se explica por qué no vale.
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: false, video: false }));
  const noMp4 = (await api('POST', '/api/youtube/probe', { url: 'https://youtu.be/abc123' })).data;
  ok('sin MP4 utilizable lo dice claro', noMp4?.ok === false && /MP4\/WebM/.test(noMp4?.error || ''), noMp4?.error);

  // Lista completa: sus vídeos en orden; se omiten los directos y lo inservible.
  fs.writeFileSync(
    YT_FLAGS,
    JSON.stringify({ live: true, entries: 4, withLive: true, withBadEntry: true, duration: 300, listTitle: 'Lista Demo' })
  );
  const lista = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/playlist?list=PLdemo' })).data;
  ok('una lista completa se acepta', lista?.ok === true && lista?.mode === 'playlist', JSON.stringify(lista?.error || ''));
  ok('con el título de la lista', lista?.title === 'Lista Demo', lista?.title);
  ok('trae los vídeos utilizables', lista?.entries === 2, `${lista?.entries} de ${lista?.total_entries}`);
  ok('suma la duración de todos', lista?.total_duration_sec === 600, `${lista?.total_duration_sec}s`);
  ok('avisa del directo que se omite', lista?.skipped_live === 1);
  ok('y del vídeo sin formato', lista?.skipped_no_format === 1);

  // Un directo terminado no se emite en bucle por sorpresa: se avisa.
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: false, video: true }));
  const ended = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/@canaldemo/live' })).data;
  ok('un directo terminado lo dice', ended?.ok === false && /ya terminó/i.test(ended?.error || ''), ended?.error);
  fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));

  // --- 2b. COPY/COPY del directo: sin recodificar nada --------------------
  {
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, separateAudio: true }));
    const sep = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/watch?v=sep1' })).data;
    ok('directo con pistas separadas: se detecta', sep?.ok === true && sep?.mode === 'live', JSON.stringify(sep?.error || ''));
    ok('y se avisa de que el audio va aparte', sep?.separated_audio === true);
    ok('marcado como copiable (copy/copy)', sep?.copy_video === true && sep?.copy_audio === true);
    ok('elige la mejor pista de vídeo (1080p)', sep?.copy_kind === 'separate' && sep?.height === 1080, `${sep?.copy_kind} · ${sep?.height}p`);

    fs.writeFileSync(FFMPEG_ARGS, '');
    const chSep = (await api('POST', '/api/channels247', {
      name: 'Directo pistas separadas',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/watch?v=sep1',
      engine_mode: 'ffmpeg',
      transcode_profile_id: 2
    })).data;
    let rowSep = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      rowSep = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chSep?.id);
      if (rowSep?.workerPid) break;
    }
    ok('el canal arranca con una sola entrada de vídeo', Boolean(rowSep?.workerPid));
    ok('el panel dice «copia exacta»', rowSep?.copyExact === true, JSON.stringify({ copyExact: rowSep?.copyExact, audioLeveled: rowSep?.audioLeveled }));
    ok('y que son dos pistas', rowSep?.liveSource?.separated_audio === true);

    const logSep = fs.existsSync(FFMPEG_ARGS) ? fs.readFileSync(FFMPEG_ARGS, 'utf8') : '';
    const lineSep = logSep.split('\n').find((l) => /a128\.m3u8/.test(l)) || '';
    ok('el motor abre DOS entradas (vídeo y audio)', (lineSep.match(/-i /g) || []).length === 2, `${(lineSep.match(/-i /g) || []).length} entradas`);
    ok('las mapea (0:v:0 + 1:a:0)', /-map 0:v:0 -map 1:a:0/.test(lineSep));
    ok('y no recodifica ni vídeo ni audio', /-c:v copy/.test(lineSep) && /-c:a copy/.test(lineSep) && !/libx264/.test(lineSep));

    // El comando que enseña el panel es exactamente el que se ejecuta.
    ok('el comando del panel también es copy/copy', /-c:v copy/.test(rowSep?.ffmpegCommand || '') && /-map 0:v:0 -map 1:a:0/.test(rowSep?.ffmpegCommand || ''));

    await api('DELETE', `/api/channels247/${chSep?.id}`);
    // Con el nivelador de audio encendido, el vídeo se sigue copiando.
    await api('PUT', '/api/settings', { audio_leveling_enabled: true });
    const chSep2 = (await api('POST', '/api/channels247', {
      name: 'Directo con nivelador',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/watch?v=sep1',
      engine_mode: 'ffmpeg',
      transcode_profile_id: 2
    })).data;
    let rowSep2 = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      rowSep2 = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chSep2?.id);
      if (rowSep2?.workerPid) break;
    }
    ok('con nivelador ya no es copia exacta', rowSep2?.copyExact === false && rowSep2?.audioLeveled === true);
    ok('pero el vídeo se sigue copiando', rowSep2?.copyVideo === true);
    await api('PUT', '/api/settings', { audio_leveling_enabled: false });
    await api('DELETE', `/api/channels247/${chSep2?.id}`);
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true }));
  }

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

  // --- 4c. Canal con un VÍDEO SUELTO: se repite en bucle ------------------
  let vidChannelId = null;
  {
    fs.writeFileSync(
      YT_FLAGS,
      JSON.stringify({ live: false, video: true, title: 'Documental grabado', duration: 125 })
    );
    fs.writeFileSync(FFMPEG_ARGS, '');
    const chVideo = (await api('POST', '/api/channels247', {
      name: 'Documental 24/7 (bucle)',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/watch?v=vid123',
      engine_mode: 'ffmpeg',
      transcode_profile_id: 2
    })).data;
    vidChannelId = chVideo?.id || null;
    ok('se crea un canal con un vídeo suelto', Boolean(vidChannelId), JSON.stringify(chVideo));

    let row = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      row = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chVideo?.id);
      if (row?.liveSource?.mode === 'video' && row?.workerPid) break;
    }
    ok('el canal queda en modo VÍDEO EN BUCLE', row?.liveSource?.mode === 'video', row?.liveSource?.mode);
    ok('con la duración del vídeo', row?.liveSource?.duration_sec === 125, `${row?.liveSource?.duration_sec}s`);
    ok('y marcado como listo (no «sin señal»)', row?.liveSource?.ready === true && row?.liveSource?.live === false);
    ok('la parrilla lo informa como bucle', row?.liveState?.sourceMode === 'video' && row?.liveState?.isPlaying === true);
    ok('trae el título del vídeo', /Documental grabado/.test(row?.liveSource?.title || ''), row?.liveSource?.title);

    // El motor tiene que repetirlo sin fin y no recodificar (H.264 + AAC 720p).
    const log = fs.existsSync(FFMPEG_ARGS) ? fs.readFileSync(FFMPEG_ARGS, 'utf8') : '';
    const line = log.split('\n').find((l) => /\.mp4/.test(l)) || '';
    ok('el motor usa -stream_loop -1 (bucle sin fin)', /-stream_loop -1/.test(line));
    ok('y -re (a velocidad real, no acelera)', /-re /.test(line));
    ok('sin recodificar: -c:v copy', /-c:v copy/.test(line) && !/libx264/.test(line));
    ok('la URL del vídeo es la que dio yt-dlp', /127 \.0 \.0 \.1|127\.0\.0\.1/.test(line) && /videox\.mp4/.test(line));

    // El canal se entrega por HLS como cualquier 24/7.
    execFileSync('node', [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
       db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chId},${vidChannelId}]));`
    ]);
    let hlsV = null;
    for (let i = 0; i < 30; i += 1) {
      const r = await fetch(`${BASE}/live/prueba/clave/${10000 + vidChannelId}.m3u8`);
      if (r.status === 200) {
        hlsV = await r.text();
        break;
      }
      await sleep(400);
    }
    ok('el canal de vídeo se entrega por HLS', Boolean(hlsV && hlsV.includes('#EXTM3U')), hlsV ? 'manifiesto ok' : 'sin manifiesto');

    // Un vídeo VP9 sí se recodifica (si no, muchos clientes no lo abren).
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: false, video: true, codec: 'vp9', title: 'Vídeo VP9' }));
    fs.writeFileSync(FFMPEG_ARGS, '');
    const chVp9 = (await api('POST', '/api/channels247', {
      name: 'Vídeo VP9',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/watch?v=vp9abc',
      engine_mode: 'ffmpeg',
      transcode_profile_id: 2
    })).data;
    let rowVp9 = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      rowVp9 = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chVp9?.id);
      if (rowVp9?.workerPid) break;
    }
    ok('VP9 se marca para recodificar', rowVp9?.liveSource?.needs_transcode === true);
    const logVp9 = fs.existsSync(FFMPEG_ARGS) ? fs.readFileSync(FFMPEG_ARGS, 'utf8') : '';
    const lineVp9 = logVp9.split('\n').find((l) => /videox\.mp4/.test(l)) || '';
    ok('y el motor recodifica a H.264', /libx264/.test(lineVp9), lineVp9 ? 'libx264 ok' : 'sin arranque');
    ok('con techo de 1080p', /min\(1920,iw\)/.test(lineVp9));
    await api('DELETE', `/api/channels247/${chVp9?.id}`);
  }

  // --- 4d. Canal con una LISTA COMPLETA: en orden y vuelta a empezar -------
  {
    fs.writeFileSync(
      YT_FLAGS,
      JSON.stringify({ live: true, entries: 3, duration: 120, listTitle: 'Lista Demo' })
    );
    fs.writeFileSync(FFMPEG_ARGS, '');
    const chLista = (await api('POST', '/api/channels247', {
      name: 'Lista 24/7',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/playlist?list=PLdemo',
      engine_mode: 'ffmpeg',
      transcode_profile_id: 2
    })).data;
    ok('se crea un canal con una lista completa', Boolean(chLista?.id), JSON.stringify(chLista));

    let rowL = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      rowL = ((await api('GET', '/api/channels247')).data || []).find((c) => c.id === chLista?.id);
      if (rowL?.liveSource?.mode === 'playlist' && rowL?.workerPid) break;
    }
    ok('el canal queda en modo LISTA', rowL?.liveSource?.mode === 'playlist', rowL?.liveSource?.mode);
    ok('con sus 3 vídeos', rowL?.liveSource?.entries === 3, `${rowL?.liveSource?.entries}`);
    ok('y la duración total de la lista', rowL?.liveSource?.total_duration_sec === 360, `${rowL?.liveSource?.total_duration_sec}s`);
    ok('marcado como listo', rowL?.liveSource?.ready === true);
    ok('el panel muestra los títulos de la lista', (rowL?.liveSource?.entry_titles || []).includes('Programa 1'));

    const logL = fs.existsSync(FFMPEG_ARGS) ? fs.readFileSync(FFMPEG_ARGS, 'utf8') : '';
    const lineL = logL.split('\n').find((l) => /-f concat/.test(l)) || '';
    ok('el motor concatena con -f concat', /-f concat -safe 0/.test(lineL), lineL.slice(0, 80));
    ok('y también da la vuelta (-stream_loop -1)', /-stream_loop -1/.test(lineL));
    ok('sin recodificar: -c:v copy (todo es H.264 720p)', /-c:v copy/.test(lineL) && !/libx264/.test(lineL));
    ok('y el audio también se copia', /-c:a copy/.test(lineL));

    // Una lista con códecs mezclados sí se recodifica (si no, se rompe a mitad).
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, entries: 3, duration: 120, codec: 'vp9' }));
    const listaVp9 = (await api('POST', '/api/youtube/probe', { url: 'https://www.youtube.com/playlist?list=PLdemo' })).data;
    ok('una lista en VP9 se marca para recodificar', listaVp9?.needs_transcode === true);
    fs.writeFileSync(YT_FLAGS, JSON.stringify({ live: true, entries: 3, duration: 120, listTitle: 'Lista Demo' }));
    const listPath = (lineL.match(/(\/\S+source\.txt)/) || [])[1] || '';
    let listed = '';
    try {
      listed = fs.readFileSync(listPath, 'utf8');
    } catch {
      listed = '';
    }
    ok('escribe el manifiesto de la lista', /ffconcat version 1\.0/.test(listed), listPath);
    ok('con las 3 URLs en orden', (listed.match(/^file '/gm) || []).length === 3, `${(listed.match(/^file '/gm) || []).length} líneas`);

    execFileSync('node', [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
       db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chId},${vidChannelId},${chLista?.id}]));`
    ]);
    let hlsL = null;
    for (let i = 0; i < 30; i += 1) {
      const r = await fetch(`${BASE}/live/prueba/clave/${10000 + chLista.id}.m3u8`);
      if (r.status === 200) {
        hlsL = await r.text();
        break;
      }
      await sleep(400);
    }
    ok('la lista se entrega por HLS', Boolean(hlsL && hlsL.includes('#EXTM3U')));

    // Sin motor, una lista no se puede entregar con un 302: se explica.
    const chVirt = (await api('POST', '/api/channels247', {
      name: 'Lista sin motor',
      category_id: 4,
      source_kind: 'youtube',
      live_source_url: 'https://www.youtube.com/playlist?list=PLdemo',
      engine_mode: 'virtual',
      transcode_profile_id: 2
    })).data;
    execFileSync('node', [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
       db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chLista?.id},${chVirt?.id}]));`
    ]);
    let virtBody = '';
    let virtStatus = 0;
    for (let i = 0; i < 25; i += 1) {
      const r = await fetch(`${BASE}/live/prueba/clave/${10000 + chVirt.id}.m3u8`, { redirect: 'manual' });
      virtStatus = r.status;
      virtBody = await r.text();
      if (virtStatus !== 404) break;
      await sleep(400);
    }
    ok('sin motor, la lista avisa que hace falta FFmpeg', virtStatus === 503 && /LISTA de YouTube/.test(virtBody), `HTTP ${virtStatus}`);
    await api('DELETE', `/api/channels247/${chVirt?.id}`);
    // Se deja el paquete como estaba para las pruebas que siguen.
    execFileSync('node', [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
       db.prepare("UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1").run(JSON.stringify([${chId},${vidChannelId},${chLista?.id}]));`
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
  ok('si el directo termina, se informa', gone?.ok === false && /ya terminó/i.test(gone?.state?.error || ''), gone?.state?.error);
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
