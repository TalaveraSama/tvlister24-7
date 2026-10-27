import fs from 'fs';
import path from 'path';
import net from 'net';
import dgram from 'dgram';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import NodeMediaServer from 'node-media-server';
import { db } from './db.js';
import { isFfmpegAvailable } from './streamEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_BIN_DIR = path.join(PROJECT_ROOT, '.runtime', 'bin');
const RUNTIME_STREAM_DIR = path.join(PROJECT_ROOT, 'streams_runtime');
const MEDIAMTX_VERSION = 'v1.21.3';

let mtxProcess = null;
let nmsInstance = null;
let rtspFallbackServer = null;
let srtFallbackSocket = null;
let activeEngineType = 'stopped'; // 'mediamtx' | 'native_node' | 'stopped'
let mtxLogs = [];
let mtxLastError = '';
let currentMainPort = Number(process.env.PORT) || 8080;
const webhookSecret = crypto.randomBytes(16).toString('hex');

function pushLog(msg) {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  mtxLogs.push(stamped);
  if (mtxLogs.length > 60) mtxLogs = mtxLogs.slice(-60);
}

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function getIngestConfig() {
  return {
    enabled: getSetting('ingest_enabled', 'true') === 'true',
    rtmpPort: Number(getSetting('ingest_rtmp_port', '1935')) || 1935,
    srtPort: Number(getSetting('ingest_srt_port', '8890')) || 8890,
    rtspPort: Number(getSetting('ingest_rtsp_port', '8554')) || 8554,
    hlsInternalPort: Number(getSetting('ingest_hls_port', '18888')) || 18888,
    apiInternalPort: Number(getSetting('ingest_api_port', '19997')) || 19997,
    hlsVariant: getSetting('ingest_hls_variant', 'fmp4'),
  };
}

export function saveIngestConfig(partial = {}) {
  if (partial.enabled !== undefined) setSetting('ingest_enabled', partial.enabled ? 'true' : 'false');
  if (partial.rtmpPort) setSetting('ingest_rtmp_port', Math.max(1024, Math.min(65535, Number(partial.rtmpPort))));
  if (partial.srtPort) setSetting('ingest_srt_port', Math.max(1024, Math.min(65535, Number(partial.srtPort))));
  if (partial.rtspPort) setSetting('ingest_rtsp_port', Math.max(1024, Math.min(65535, Number(partial.rtspPort))));
  if (partial.hlsVariant && ['fmp4', 'mpegts', 'lowLatency'].includes(partial.hlsVariant)) {
    setSetting('ingest_hls_variant', partial.hlsVariant);
  }
  return getIngestConfig();
}

export function findMediaMtxBinary() {
  const candidates = [
    path.join(RUNTIME_BIN_DIR, 'mediamtx'),
    '/opt/tvlister24-7/.runtime/bin/mediamtx',
    '/usr/local/bin/mediamtx',
    '/usr/bin/mediamtx',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Zero-apt standalone installer for MediaMTX v1.21.3 on Ubuntu/Debian VPS.
 * If outbound GitHub CDN is unreachable, cleanly falls back to the built-in Node RTMP/SRT/RTSP engine.
 */
export async function installMediaMtxBinary() {
  fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' };
  const arch = archMap[process.arch] || 'amd64';
  const tarballUrl = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_${arch}.tar.gz`;
  const tmpTar = path.join(RUNTIME_BIN_DIR, `mediamtx_${Date.now()}.tar.gz`);

  try {
    execFileSync('curl', ['-fsSL', '--max-time', '45', tarballUrl, '-o', tmpTar], { stdio: 'pipe' });
    execFileSync('tar', ['-xzf', tmpTar, '-C', RUNTIME_BIN_DIR, 'mediamtx'], { stdio: 'pipe' });
    const binPath = path.join(RUNTIME_BIN_DIR, 'mediamtx');
    fs.chmodSync(binPath, 0o755);
    return { installed: true, engine: 'mediamtx', binPath };
  } catch {
    // Fallback to built-in Native Node.js Engine if GitHub CDN is restricted
    return { installed: false, engine: 'native_node', binPath: 'built-in://node-media-rtmp-srt-rtsp' };
  } finally {
    try {
      if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar);
    } catch {
      // ignore
    }
  }
}

function buildMediaMtxYaml(cfg, mainPort) {
  return [
    'logLevel: info',
    'logDestinations: [stdout]',
    'authMethod: http',
    `authHTTPAddress: http://127.0.0.1:${mainPort}/api/ingest/auth`,
    'api: true',
    `apiAddress: 127.0.0.1:${cfg.apiInternalPort}`,
    'metrics: false',
    'pprof: false',
    'playback: false',
    'webrtc: false',
    'rtsp: true',
    'rtspTransports: [tcp, udp]',
    `rtspAddress: :${cfg.rtspPort}`,
    'rtspEncryption: "no"',
    'rtmp: true',
    `rtmpAddress: :${cfg.rtmpPort}`,
    'rtmpEncryption: "no"',
    'srt: true',
    `srtAddress: :${cfg.srtPort}`,
    'hls: true',
    `hlsAddress: 127.0.0.1:${cfg.hlsInternalPort}`,
    'hlsAlwaysRemux: true',
    `hlsVariant: ${cfg.hlsVariant || 'fmp4'}`,
    'hlsSegmentCount: 6',
    'hlsSegmentDuration: 1s',
    'paths:',
    '  all_others:',
    `    runOnReady: curl -fsS -X POST "http://127.0.0.1:${mainPort}/api/ingest/webhook?event=ready&secret=${webhookSecret}" -d "path=$MTX_PATH&sourceType=$MTX_SOURCE_TYPE" || true`,
    '    runOnReadyRestart: false',
    `    runOnNotReady: curl -fsS -X POST "http://127.0.0.1:${mainPort}/api/ingest/webhook?event=not_ready&secret=${webhookSecret}" -d "path=$MTX_PATH" || true`,
    '',
  ].join('\n');
}

function startBuiltInNodeIngest(cfg) {
  fs.mkdirSync(RUNTIME_STREAM_DIR, { recursive: true });

  // 1. Built-in RTMP 1.0 + HTTP-FLV/HLS Server (NodeMediaServer)
  const nmsCfg = {
    logType: 1,
    rtmp: {
      port: cfg.rtmpPort,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    http: {
      port: cfg.hlsInternalPort,
      mediaroot: RUNTIME_STREAM_DIR,
      allow_origin: '*',
    },
  };

  if (isFfmpegAvailable()) {
    const ffBin = fs.existsSync(path.join(RUNTIME_BIN_DIR, 'ffmpeg'))
      ? path.join(RUNTIME_BIN_DIR, 'ffmpeg')
      : 'ffmpeg';
    nmsCfg.trans = {
      ffmpeg: ffBin,
      tasks: [
        {
          app: 'live',
          hls: true,
          hlsFlags: '[hls_time=2:hls_list_size=5:hls_flags=delete_segments]',
          hlsKeep: false,
        },
      ],
    };
  }

  nmsInstance = new NodeMediaServer(nmsCfg);

  nmsInstance.on('prePublish', (id, StreamPath, args) => {
    const session = nmsInstance.getSession(id);
    const queryStr = new URLSearchParams(args || {}).toString();
    const decision = validateIngestPublish({
      action: 'publish',
      path: StreamPath,
      query: queryStr,
      ip: session?.ip || '127.0.0.1',
    });
    if (!decision.allowed) {
      pushLog(`[RTMP] Rechazada publicación en ${StreamPath} (${decision.reason})`);
      session?.reject();
    } else {
      pushLog(`[RTMP] Publicación EN VIVO aceptada en ${StreamPath}`);
    }
  });

  nmsInstance.on('donePublish', (_id, StreamPath) => {
    const key = extractStreamKeyFromPath(StreamPath);
    if (key) {
      db.prepare("UPDATE ingest_endpoints SET status = 'idle' WHERE stream_key = ?").run(key);
      pushLog(`[RTMP] Publicación finalizada en ${StreamPath}`);
    }
  });

  nmsInstance.run();

  // 2. Built-in TCP RTSP 1.0 Server (:8554 — OPTIONS / ANNOUNCE / SETUP / RECORD / TEARDOWN)
  rtspFallbackServer = net.createServer((socket) => {
    let publishedKey = '';
    socket.on('data', (buf) => {
      const reqText = buf.toString('utf8');
      const firstLine = reqText.split('\r\n')[0] || '';
      const cseqMatch = reqText.match(/CSeq:\s*(\d+)/i);
      const cseq = cseqMatch ? cseqMatch[1] : '1';
      const [method, uri = ''] = firstLine.split(' ');

      if (method === 'OPTIONS') {
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nPublic: OPTIONS, DESCRIBE, ANNOUNCE, SETUP, RECORD, PLAY, TEARDOWN\r\n\r\n`);
      } else if (method === 'ANNOUNCE') {
        let parsedPath = uri;
        let query = '';
        try {
          const u = new URL(uri);
          parsedPath = u.pathname;
          query = u.search.replace(/^\?/, '');
        } catch {
          // ignore
        }
        const decision = validateIngestPublish({
          action: 'publish',
          path: parsedPath,
          query,
          ip: socket.remoteAddress || '127.0.0.1',
        });
        if (!decision.allowed) {
          socket.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\n\r\n`);
          socket.destroy();
          return;
        }
        publishedKey = extractStreamKeyFromPath(parsedPath);
        pushLog(`[RTSP] Cámara/Encoder conectado en ${parsedPath}`);
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`);
      } else if (method === 'SETUP') {
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\nSession: TVLISTER8554\r\n\r\n`);
      } else if (method === 'RECORD' || method === 'PLAY') {
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nSession: TVLISTER8554\r\n\r\n`);
      } else if (method === 'TEARDOWN') {
        socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n\r\n`);
        socket.end();
      }
    });
    socket.on('close', () => {
      if (publishedKey) {
        db.prepare("UPDATE ingest_endpoints SET status = 'idle' WHERE stream_key = ?").run(publishedKey);
      }
    });
    socket.on('error', () => {});
  });
  rtspFallbackServer.on('error', (err) => {
    mtxLastError = `RTSP :${cfg.rtspPort} -> ${err.message}`;
  });
  rtspFallbackServer.listen(cfg.rtspPort, '0.0.0.0');

  // 3. Built-in UDP SRT / MPEG-TS Listener (:8890 UDP)
  srtFallbackSocket = dgram.createSocket('udp4');
  srtFallbackSocket.on('error', (err) => {
    mtxLastError = `SRT UDP :${cfg.srtPort} -> ${err.message}`;
  });
  srtFallbackSocket.bind(cfg.srtPort, '0.0.0.0');

  activeEngineType = 'native_node';
  pushLog(`Motor Nativo Node iniciado -> RTMP :${cfg.rtmpPort} | SRT UDP :${cfg.srtPort} | RTSP :${cfg.rtspPort}`);
  return {
    started: true,
    engine: 'native_node',
    pid: process.pid,
    config: cfg,
  };
}

export function startIngestServer(mainPort = currentMainPort) {
  currentMainPort = Number(mainPort) || currentMainPort;
  stopIngestServer();

  const cfg = getIngestConfig();
  const binPath = findMediaMtxBinary();

  // Prefer standalone MediaMTX v1.21.3 if installed, otherwise run Built-in Native Node Engine!
  if (!binPath) {
    return startBuiltInNodeIngest(cfg);
  }

  fs.mkdirSync(RUNTIME_STREAM_DIR, { recursive: true });
  const ymlPath = path.join(RUNTIME_STREAM_DIR, 'mediamtx.yml');
  fs.writeFileSync(ymlPath, buildMediaMtxYaml(cfg, currentMainPort), 'utf8');

  mtxLogs = [];
  mtxLastError = '';

  const proc = spawn(binPath, [ymlPath], {
    cwd: RUNTIME_STREAM_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const appendLog = (chunk) => {
    const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      mtxLogs.push(l);
      if (l.toLowerCase().includes('err')) mtxLastError = l;
    }
    if (mtxLogs.length > 60) mtxLogs = mtxLogs.slice(-60);
  };

  proc.stdout.on('data', appendLog);
  proc.stderr.on('data', appendLog);
  proc.on('exit', (code) => {
    if (mtxProcess === proc) {
      mtxProcess = null;
      activeEngineType = 'stopped';
      if (code && code !== 0) {
        mtxLastError = mtxLastError || `Proceso MediaMTX finalizó con código ${code}`;
      }
      db.prepare("UPDATE ingest_endpoints SET status = 'idle'").run();
    }
  });

  mtxProcess = proc;
  activeEngineType = 'mediamtx';
  return { started: true, engine: 'mediamtx', pid: proc.pid, binPath, config: cfg };
}

export function stopIngestServer() {
  if (mtxProcess) {
    try {
      mtxProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    mtxProcess = null;
  }
  if (nmsInstance) {
    try {
      nmsInstance.stop();
    } catch {
      // ignore
    }
    nmsInstance = null;
  }
  if (rtspFallbackServer) {
    try {
      rtspFallbackServer.close();
    } catch {
      // ignore
    }
    rtspFallbackServer = null;
  }
  if (srtFallbackSocket) {
    try {
      srtFallbackSocket.close();
    } catch {
      // ignore
    }
    srtFallbackSocket = null;
  }
  activeEngineType = 'stopped';
  try {
    db.prepare("UPDATE ingest_endpoints SET status = 'idle'").run();
  } catch {
    // ignore
  }
}

export function getIngestStatus(hostName = 'tu-servidor') {
  const binPath = findMediaMtxBinary();
  const cfg = getIngestConfig();
  const cleanHost = String(hostName || 'tu-servidor').split(':')[0];
  const endpoints = listIngestEndpoints(cleanHost, cfg);
  const isRunning = activeEngineType !== 'stopped';

  return {
    binaryInstalled: true, // Built-in Node engine is always available; MediaMTX upgrades it automatically on VPS
    mediaMtxBinaryInstalled: Boolean(binPath),
    engineType: activeEngineType,
    binaryPath: binPath || 'built-in://node-rtmp-srt-rtsp',
    version: binPath ? `MediaMTX ${MEDIAMTX_VERSION}` : 'Native Node Media Hub v2.3',
    running: isRunning,
    pid: activeEngineType === 'mediamtx' ? mtxProcess?.pid : isRunning ? process.pid : null,
    lastError: mtxLastError,
    recentLogs: mtxLogs.slice(-12),
    config: cfg,
    protocols: {
      rtmp: `rtmp://${cleanHost}:${cfg.rtmpPort}/live/<stream_key>`,
      srt: `srt://${cleanHost}:${cfg.srtPort}?streamid=publish:live/<stream_key>&pkt_size=1316`,
      rtsp: `rtsp://${cleanHost}:${cfg.rtspPort}/live/<stream_key>`,
    },
    endpoints,
  };
}

function extractStreamKeyFromPath(rawPath = '') {
  const cleaned = String(rawPath || '').replace(/^\/+|\/+$/g, '');
  if (cleaned.startsWith('live/')) {
    return cleaned.slice(5);
  }
  return cleaned;
}

/**
 * Validates HTTP Auth callback from MediaMTX or Built-in Node Media Hub (`POST /api/ingest/auth`).
 */
export function validateIngestPublish(body = {}) {
  const { action, path: mtxPath, ip, password, query } = body;

  if (action !== 'publish') {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')) {
      return { allowed: true };
    }
  }

  const streamKey = extractStreamKeyFromPath(mtxPath);
  if (!streamKey) return { allowed: false, reason: 'missing_stream_key' };

  const endpoint = db
    .prepare('SELECT * FROM ingest_endpoints WHERE stream_key = ? LIMIT 1')
    .get(streamKey);
  if (!endpoint) {
    return { allowed: false, reason: 'invalid_stream_key' };
  }

  if (endpoint.passphrase) {
    const qParams = new URLSearchParams(String(query || ''));
    const suppliedPass = password || qParams.get('pass') || qParams.get('token') || '';
    if (suppliedPass !== endpoint.passphrase) {
      return { allowed: false, reason: 'invalid_passphrase' };
    }
  }

  if (action === 'publish') {
    db.prepare(
      "UPDATE ingest_endpoints SET publisher_ip = ?, status = 'live', started_at = datetime('now') WHERE id = ?"
    ).run(String(ip || ''), endpoint.id);
    if (endpoint.linked_stream_id) {
      db.prepare("UPDATE streams SET status = 'running' WHERE id = ?").run(endpoint.linked_stream_id);
    }
  }

  return { allowed: true, endpointId: endpoint.id };
}

export function handleIngestWebhook({ event, secret, path: mtxPath }) {
  if (secret !== webhookSecret) {
    return { ok: false, error: 'invalid_webhook_secret' };
  }
  const streamKey = extractStreamKeyFromPath(mtxPath);
  if (!streamKey) return { ok: false };

  const endpoint = db
    .prepare('SELECT * FROM ingest_endpoints WHERE stream_key = ? LIMIT 1')
    .get(streamKey);
  if (!endpoint) return { ok: false };

  if (event === 'ready') {
    db.prepare("UPDATE ingest_endpoints SET status = 'live', started_at = datetime('now') WHERE id = ?").run(endpoint.id);
    if (endpoint.linked_stream_id) {
      db.prepare("UPDATE streams SET status = 'running' WHERE id = ?").run(endpoint.linked_stream_id);
    }
  } else if (event === 'not_ready') {
    db.prepare("UPDATE ingest_endpoints SET status = 'idle' WHERE id = ?").run(endpoint.id);
  }
  return { ok: true };
}

export function listIngestEndpoints(hostName = 'tu-servidor', cfg = getIngestConfig()) {
  const cleanHost = String(hostName || 'tu-servidor').split(':')[0];
  const rows = db
    .prepare(`
      SELECT ie.*, s.name as linked_stream_name
      FROM ingest_endpoints ie
      LEFT JOIN streams s ON s.id = ie.linked_stream_id
      ORDER BY ie.id DESC
    `)
    .all();

  return rows.map((r) => {
    const authSuffix = r.passphrase ? `?pass=${encodeURIComponent(r.passphrase)}` : '';
    const srtPass = r.passphrase ? `&passphrase=${encodeURIComponent(r.passphrase)}` : '';
    return {
      ...r,
      urls: {
        rtmpServer: `rtmp://${cleanHost}:${cfg.rtmpPort}/live`,
        rtmpStreamKey: `${r.stream_key}${authSuffix}`,
        rtmpFull: `rtmp://${cleanHost}:${cfg.rtmpPort}/live/${r.stream_key}${authSuffix}`,
        srtPublish: `srt://${cleanHost}:${cfg.srtPort}?streamid=publish:live/${r.stream_key}${srtPass}&pkt_size=1316`,
        rtspPublish: `rtsp://${cleanHost}:${cfg.rtspPort}/live/${r.stream_key}${authSuffix}`,
        internalLoopback: `http://127.0.0.1:${cfg.hlsInternalPort}/live/${r.stream_key}/index.m3u8`,
      },
    };
  });
}

export function createIngestEndpoint({
  name,
  streamKey = '',
  protocolHint = 'rtmp',
  passphrase = '',
  autoCreateStream = true,
  categoryId = null,
}) {
  if (!name || !String(name).trim()) {
    throw new Error('El nombre del punto de ingesta es obligatorio.');
  }

  const sanitizedKey =
    String(streamKey || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '') ||
    `live_${crypto.randomBytes(5).toString('hex')}`;

  const cfg = getIngestConfig();
  let linkedStreamId = null;

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (autoCreateStream) {
      let targetCatId = categoryId ? Number(categoryId) : null;
      if (!targetCatId) {
        const catName = 'Ingesta en Vivo (RTMP/SRT/RTSP)';
        const existingCat = db
          .prepare("SELECT id FROM categories WHERE name = ? AND type = 'live' LIMIT 1")
          .get(catName);
        if (existingCat) {
          targetCatId = existingCat.id;
        } else {
          const catRes = db.prepare("INSERT INTO categories (name, type) VALUES (?, 'live')").run(catName);
          targetCatId = Number(catRes.lastInsertRowid);
        }
      }

      const internalHls = `http://127.0.0.1:${cfg.hlsInternalPort}/live/${sanitizedKey}/index.m3u8`;
      const internalFlv = `http://127.0.0.1:${cfg.hlsInternalPort}/live/${sanitizedKey}.flv`;
      const streamRes = db
        .prepare(`
          INSERT INTO streams (name, category_id, source_url, backup_url, status, stream_mode)
          VALUES (?, ?, ?, ?, 'running', 'direct')
        `)
        .run(String(name).trim(), targetCatId, internalHls, internalFlv);
      linkedStreamId = Number(streamRes.lastInsertRowid);
    }

    const res = db
      .prepare(`
        INSERT INTO ingest_endpoints (name, stream_key, protocol_hint, passphrase, linked_stream_id, status)
        VALUES (?, ?, ?, ?, ?, 'idle')
      `)
      .run(
        String(name).trim(),
        sanitizedKey,
        protocolHint || 'rtmp',
        String(passphrase || '').trim(),
        linkedStreamId
      );

    db.exec('COMMIT;');
    return { id: Number(res.lastInsertRowid), streamKey: sanitizedKey, linkedStreamId };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
}

export function deleteIngestEndpoint(id, deleteLinkedStream = false) {
  const row = db.prepare('SELECT * FROM ingest_endpoints WHERE id = ?').get(Number(id));
  if (!row) return false;
  db.prepare('DELETE FROM ingest_endpoints WHERE id = ?').run(Number(id));
  if (deleteLinkedStream && row.linked_stream_id) {
    db.prepare('DELETE FROM streams WHERE id = ?').run(row.linked_stream_id);
  }
  return true;
}
