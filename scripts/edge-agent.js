#!/usr/bin/env node
/**
 * TVLister 24/7 — Remote Edge Load Balancer Relay & Heartbeat Agent
 * Zero-dependency Node.js 22 standalone daemon for secondary Edge VPS nodes.
 */
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const MASTER_URL = (process.env.MASTER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const EDGE_API_TOKEN = process.env.EDGE_API_TOKEN || '';
const EDGE_PORT = Number(process.env.EDGE_PORT || 8096);

if (!EDGE_API_TOKEN) {
  console.error('[EdgeAgent] ERROR: EDGE_API_TOKEN es requerido.');
  process.exit(1);
}

let activeConns = 0;

function sampleTelemetry() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const load1m = os.loadavg()[0] || 0;
  const cpuPct = Math.min(99.9, Math.max(1.0, Number(((load1m / Math.max(1, cpus.length)) * 100).toFixed(1))));
  const ramPct = Number(((usedMem / Math.max(1, totalMem)) * 100).toFixed(1));
  return {
    cpu_usage: cpuPct,
    ram_usage: ramPct,
    active_conns: activeConns,
    http_port: EDGE_PORT,
    uptime_sec: Math.floor(os.uptime()),
    hostname: os.hostname()
  };
}

async function sendHeartbeat() {
  try {
    const body = JSON.stringify(sampleTelemetry());
    const resp = await fetch(`${MASTER_URL}/api/lb/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-edge-token': EDGE_API_TOKEN
      },
      body
    });
    if (!resp.ok) {
      console.warn(`[EdgeAgent] Heartbeat rechazado por Master: HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[EdgeAgent] No se pudo contactar Master (${MASTER_URL}): ${err.message}`);
  }
}

function proxyFromUrl(targetUrl, clientReq, clientRes, depth = 0) {
  if (depth > 4) {
    clientRes.writeHead(502);
    return clientRes.end('Too many upstream redirects');
  }

  const parsed = new URL(targetUrl);
  const clientMod = parsed.protocol === 'https:' ? https : http;

  const upReq = clientMod.request(
    parsed,
    {
      method: 'GET',
      headers: {
        'User-Agent': clientReq.headers['user-agent'] || 'TVListerEdgeRelay/2.0',
        'X-Forwarded-For': clientReq.socket.remoteAddress || ''
      }
    },
    (upRes) => {
      if ([301, 302, 307, 308].includes(upRes.statusCode) && upRes.headers.location) {
        upRes.resume();
        const nextUrl = new URL(upRes.headers.location, parsed).toString();
        return proxyFromUrl(nextUrl, clientReq, clientRes, depth + 1);
      }

      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      };
      if (upRes.headers['content-type']) headers['Content-Type'] = upRes.headers['content-type'];
      if (upRes.headers['content-length']) headers['Content-Length'] = upRes.headers['content-length'];

      clientRes.writeHead(upRes.statusCode || 200, headers);
      upRes.pipe(clientRes);
    }
  );

  upReq.on('error', (err) => {
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(`Edge Relay Error: ${err.message}`);
  });

  clientReq.on('close', () => {
    upReq.destroy();
  });

  upReq.end();
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, role: 'edge-lb', ...sampleTelemetry() }));
  }

  activeConns++;
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
  const originUrl = `${MASTER_URL}${req.url}${sep}edge_origin=1`;
  proxyFromUrl(originUrl, req, res);
});

server.listen(EDGE_PORT, '0.0.0.0', () => {
  console.log(`⚡ TVLister 24/7 Edge LB Agent activo en 0.0.0.0:${EDGE_PORT} -> Master ${MASTER_URL}`);
  sendHeartbeat();
  setInterval(sendHeartbeat, 10_000).unref();
});
