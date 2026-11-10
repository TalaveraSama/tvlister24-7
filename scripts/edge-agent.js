#!/usr/bin/env node
/**
 * TVLister 24/7 — Nodo Balancer (Edge) con caché de segmentos
 * ------------------------------------------------------------
 * Zero-dependency Node.js 22 standalone daemon.
 *
 * Antes este agente era un simple *relé*: pedía todo al maestro y cada byte
 * pasaba por la NIC del maestro, así que añadir un VPS no sumaba ancho de banda.
 * Ahora:
 *
 *   1. **Cachea los segmentos** HLS en memoria (ventana corta) con
 *      *single-flight*: si 100 clientes piden el mismo segmento a la vez, se
 *      hace **una** descarga al maestro y se sirve 100 veces.
 *   2. **Reescribe los manifiestos** para que las URLs absolutas que apuntan al
 *      dominio de vídeo del maestro se pidan a este nodo (si no, el cliente se
 *      saltaría el balancer).
 *   3. **Mide su salida real** (Mbps) y la manda en el heartbeat, para que el
 *      panel deje de mandarle clientes cuando está lleno.
 *
 * Lo que se sigue sirviendo en streaming (sin buffer) son los flujos
 * continuos: `/live/<user>/<pass>/<id>.ts`, VOD con Range, TS del proxy.
 */
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const MASTER_URL = (process.env.MASTER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const EDGE_API_TOKEN = process.env.EDGE_API_TOKEN || '';
const EDGE_PORT = Number(process.env.EDGE_PORT || 8096);
const CACHE_MB = Math.max(0, Number(process.env.EDGE_CACHE_MB || 256));
const CACHE_TTL_MS = Math.max(1000, Number(process.env.EDGE_CACHE_TTL_MS || 12000));
const MAX_SEGMENT_MB = Math.max(1, Number(process.env.EDGE_MAX_SEGMENT_MB || 8));
const NODE_LABEL = process.env.EDGE_NODE_NAME || os.hostname();
const VERSION = '2.1.0';

if (!EDGE_API_TOKEN) {
  console.error('[EdgeAgent] ERROR: EDGE_API_TOKEN es requerido.');
  process.exit(1);
}

/* ========================================================================== */
/*  Telemetría: conexiones, salida (Mbps) y aciertos de caché                 */
/* ========================================================================== */
let activeConns = 0;
const WINDOW_SEC = 20;
const buckets = new Array(WINDOW_SEC).fill(0).map(() => ({ sec: 0, bytes: 0 }));
let cacheHits = 0;
let cacheMisses = 0;
let upstreamBytes = 0;
let clientBytes = 0;

function noteBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return;
  const sec = Math.floor(Date.now() / 1000);
  const slot = buckets[sec % WINDOW_SEC];
  if (slot.sec !== sec) {
    slot.sec = sec;
    slot.bytes = 0;
  }
  slot.bytes += n;
  clientBytes += n;
}

function sampleMbps() {
  const sec = Math.floor(Date.now() / 1000);
  const from = sec - WINDOW_SEC + 1;
  let bytes = 0;
  let seen = 0;
  for (const slot of buckets) {
    if (slot.sec >= from && slot.sec <= sec) {
      bytes += slot.bytes;
      seen += 1;
    }
  }
  if (!seen) return 0;
  return Number(((bytes * 8) / 1e6 / seen).toFixed(2));
}

function cacheHitPct() {
  const total = cacheHits + cacheMisses;
  return total ? Number(((cacheHits / total) * 100).toFixed(1)) : 0;
}

function sampleTelemetry() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const load1m = os.loadavg()[0] || 0;
  const cpuPct = Math.min(99.9, Math.max(0.5, Number(((load1m / Math.max(1, cpus.length)) * 100).toFixed(1))));
  const ramPct = Number(((usedMem / Math.max(1, totalMem)) * 100).toFixed(1));
  return {
    cpu_usage: cpuPct,
    ram_usage: ramPct,
    active_conns: activeConns,
    http_port: EDGE_PORT,
    bandwidth_mbps: sampleMbps(),
    cache_hit_pct: cacheHitPct(),
    edge_version: VERSION,
    uptime_sec: Math.floor(process.uptime()),
    hostname: NODE_LABEL
  };
}

/* ========================================================================== */
/*  Caché de segmentos en memoria (LRU + single-flight)                       */
/* ========================================================================== */
const cache = new Map(); // key -> { body, type, exp }
const inflight = new Map(); // key -> Promise<segment>
let cacheBytes = 0;
const CACHE_MAX_BYTES = CACHE_MB * 1024 * 1024;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.exp <= Date.now()) {
    cache.delete(key);
    cacheBytes -= hit.body.length;
    return null;
  }
  // Refresca el orden LRU
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, body, type) {
  if (CACHE_MAX_BYTES <= 0 || body.length > MAX_SEGMENT_MB * 1024 * 1024) return;
  const prev = cache.get(key);
  if (prev) {
    cache.delete(key);
    cacheBytes -= prev.body.length;
  }
  cache.set(key, { body, type, exp: Date.now() + CACHE_TTL_MS });
  cacheBytes += body.length;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= oldest?.body?.length || 0;
  }
}

/* ========================================================================== */
/*  Reescritura de manifiestos                                               */
/* ========================================================================== */
// Hosts cuyas URLs absolutas deben pasar a relativas para que el cliente siga
// navegando por este nodo. Se rellena con MASTER_URL y con lo que conteste el
// heartbeat (el dominio público de vídeo del panel).
const rewriteHosts = new Set();
try {
  rewriteHosts.add(new URL(MASTER_URL).host);
} catch {
  /* MASTER_URL inválida: el fetch fallará y el heartbeat lo dirá */
}
if (process.env.EDGE_REWRITE_HOSTS) {
  for (const h of String(process.env.EDGE_REWRITE_HOSTS).split(',')) {
    if (h.trim()) rewriteHosts.add(h.trim().toLowerCase());
  }
}

function relaAbsoluta(u) {
  if (!/^https?:\/\//i.test(u)) return u;
  try {
    const parsed = new URL(u);
    if (rewriteHosts.has(parsed.host.toLowerCase()) || rewriteHosts.has(parsed.hostname.toLowerCase())) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    /* URL rara: se deja igual */
  }
  return u;
}

function rewriteManifest(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${relaAbsoluta(uri)}"`);
      }
      return relaAbsoluta(trimmed);
    })
    .join('\n');
}

/* ========================================================================== */
/*  Utilidades HTTP                                                          */
/* ========================================================================== */
function isManifest(pathname) {
  return /\.(m3u8|mpd)$/i.test(pathname);
}

/** Segmentos discretos (se pueden cachear). Los flujos continuos no. */
function isCacheableSegment(req, urlObj) {
  if (req.headers.range) return false; // VOD con Range: streaming
  const p = urlObj.pathname;
  if (isManifest(p)) return false;
  if (/^\/hls_out\//i.test(p)) return true;
  if (/^\/hls_proxy\b/i.test(p)) return true;
  if (/^\/hls_local\//i.test(p)) return true;
  if (/\.(m4s|aac|vtt)$/i.test(p)) return true;
  // .ts suelto dentro de una carpeta HLS, pero NUNCA /live/<u>/<p>/<id>.ts
  if (/\.ts$/i.test(p) && /\/hls/i.test(p)) return true;
  return false;
}

async function fetchSegment(targetUrl, clientReq) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': clientReq.headers['user-agent'] || `TVListerEdge/${VERSION}`,
        'X-Forwarded-For': clientReq.socket.remoteAddress || ''
      },
      redirect: 'follow',
      signal: controller.signal
    });
    const body = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, type: resp.headers.get('content-type') || 'application/octet-stream', body };
  } finally {
    clearTimeout(timer);
  }
}

function cacheKeyOf(req, urlObj) {
  return `${urlObj.pathname}${urlObj.search}`;
}

async function getSegment(key, targetUrl, clientReq) {
  const cached = cacheGet(key);
  if (cached) {
    cacheHits += 1;
    return { status: 200, type: cached.type, body: cached.body, cached: true };
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchSegment(targetUrl, clientReq)
      .then((seg) => {
        if (seg.status === 200) {
          upstreamBytes += seg.body.length;
          cacheSet(key, seg.body, seg.type);
        }
        cacheMisses += 1;
        return seg;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  } else {
    cacheHits += 1; // se sirve de la misma descarga en curso
  }
  const seg = await pending;
  return { ...seg, cached: false };
}

function streamUpstream(targetUrl, clientReq, clientRes, depth = 0) {
  if (depth > 4) {
    clientRes.writeHead(502);
    return clientRes.end('Too many upstream redirects');
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    clientRes.writeHead(502);
    return clientRes.end('Bad upstream URL');
  }
  const clientMod = parsed.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': clientReq.headers['user-agent'] || `TVListerEdge/${VERSION}`,
    'X-Forwarded-For': clientReq.socket.remoteAddress || ''
  };
  if (clientReq.headers.range) headers.Range = clientReq.headers.range;

  const upReq = clientMod.request(parsed, { method: 'GET', headers }, (upRes) => {
    if ([301, 302, 307, 308].includes(upRes.statusCode) && upRes.headers.location) {
      upRes.resume();
      return streamUpstream(new URL(upRes.headers.location, parsed).toString(), clientReq, clientRes, depth + 1);
    }
    const outHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    };
    if (upRes.headers['content-type']) outHeaders['Content-Type'] = upRes.headers['content-type'];
    if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['accept-ranges']) outHeaders['Accept-Ranges'] = upRes.headers['accept-ranges'];
    if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];
    clientRes.writeHead(upRes.statusCode || 200, outHeaders);
    upRes.on('data', (chunk) => noteBytes(chunk.length));
    upRes.pipe(clientRes);
  });

  upReq.on('error', (err) => {
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(`Edge Error: ${err.message}`);
  });
  clientReq.on('close', () => upReq.destroy());
  upReq.end();
}

/* ========================================================================== */
/*  Heartbeat                                                                */
/* ========================================================================== */
async function sendHeartbeat() {
  try {
    const resp = await fetch(`${MASTER_URL}/api/lb/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-edge-token': EDGE_API_TOKEN },
      body: JSON.stringify(sampleTelemetry())
    });
    if (!resp.ok) {
      console.warn(`[EdgeAgent] Heartbeat rechazado por el maestro: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json().catch(() => null);
    if (Array.isArray(data?.rewrite_hosts)) {
      for (const h of data.rewrite_hosts) {
        if (h) rewriteHosts.add(String(h).toLowerCase());
      }
    }
  } catch (err) {
    console.warn(`[EdgeAgent] No se pudo contactar al maestro (${MASTER_URL}): ${err.message}`);
  }
}

/* ========================================================================== */
/*  Servidor                                                                 */
/* ========================================================================== */
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://127.0.0.1:${EDGE_PORT}`);

  if (urlObj.pathname === '/health' || urlObj.pathname === '/api/lb/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        ok: true,
        role: 'edge-lb',
        version: VERSION,
        cacheMb: CACHE_MB,
        cacheUsedMb: Number((cacheBytes / 1048576).toFixed(2)),
        rewriteHosts: [...rewriteHosts],
        upstreamMb: Number((upstreamBytes / 1048576).toFixed(1)),
        clientMb: Number((clientBytes / 1048576).toFixed(1)),
        ...sampleTelemetry()
      })
    );
  }

  activeConns += 1;
  let decremented = false;
  const dec = () => {
    if (!decremented) {
      decremented = true;
      activeConns = Math.max(0, activeConns - 1);
    }
  };
  res.on('close', dec);
  res.on('finish', dec);

  const sep = req.url.includes('?') ? '&' : '?';
  const target = `${MASTER_URL}${req.url}${sep}edge_origin=1`;

  // 1) Manifiestos: se leen completos (son ~1 KB), se reescriben y no se cachean.
  if (isManifest(urlObj.pathname)) {
    try {
      const seg = await fetchSegment(target, req);
      let text = seg.body.toString('utf8');
      if (seg.status === 200) text = rewriteManifest(text);
      res.writeHead(seg.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      noteBytes(Buffer.byteLength(text));
      return res.end(text);
    } catch (err) {
      res.writeHead(502);
      return res.end(`Edge Error: ${err.message}`);
    }
  }

  // 2) Segmentos discretos: caché con single-flight.
  if (isCacheableSegment(req, urlObj)) {
    try {
      const key = cacheKeyOf(req, urlObj);
      const seg = await getSegment(key, target, req);
      res.writeHead(seg.status, {
        'Content-Type': seg.type,
        'Content-Length': seg.body.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Edge-Cache': seg.cached ? 'HIT' : 'MISS'
      });
      noteBytes(seg.body.length);
      return res.end(seg.body);
    } catch (err) {
      res.writeHead(502);
      return res.end(`Edge Error: ${err.message}`);
    }
  }

  // 3) Todo lo demás (flujos continuos, VOD con Range, API): streaming directo.
  streamUpstream(target, req, res);
});

server.listen(EDGE_PORT, '0.0.0.0', () => {
  console.log(`⚡ TVLister Balancer ${VERSION} en 0.0.0.0:${EDGE_PORT} -> maestro ${MASTER_URL}`);
  console.log(`   caché de segmentos: ${CACHE_MB} MB · TTL ${CACHE_TTL_MS} ms · reescritura: ${[...rewriteHosts].join(', ') || 'ninguna'}`);
  sendHeartbeat();
  setInterval(sendHeartbeat, 10_000).unref();
});
