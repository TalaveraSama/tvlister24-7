import http from 'http';
import https from 'https';
import net from 'net';
import { db } from './db.js';
import { loadTlsContext, tlsStatus, getServerTlsOptions } from './tlsManager.js';

let expressApp = null;
let mainPort = 8080;
let upgradeHandler = null;
const extraServers = new Map(); // port -> { servers[], scheme, status, error, startedAt, tls }

/**
 * Puertos extra del panel.
 *
 * Hasta ahora sólo abrían HTTP plano. Los reproductores y las TVs que piden el
 * puerto estándar (o que rechazan HTTP por política) se quedaban fuera, así que
 * cada puerto puede abrirse de tres maneras:
 *
 *   http   → HTTP plano (comportamiento antiguo).
 *   https  → sólo TLS. Lo normal en el 443.
 *   both   → TLS y HTTP en el MISMO puerto: se mira el primer byte de la
 *            conexión (0x16 = saludo TLS). En el 80 el HTTP plano contesta 301
 *            al mismo host por HTTPS; en otros puertos sirve HTTP normal.
 *
 * Los dos modos HTTPS usan el certificado que encuentra tlsManager.js. Si no
 * hay certificado, el puerto no se abre y la UI explica qué falta: nunca se
 * inventa un certificado autofirmado en producción.
 */

const KNOWN_SCHEMES = new Set(['http', 'https', 'both']);

function normalizeScheme(raw, port) {
  const s = String(raw || '').trim().toLowerCase();
  if (KNOWN_SCHEMES.has(s)) return s;
  if (s === 'auto' || s === 'tls') return 'both';
  // Sin esquema indicado: el 443 va a HTTPS y el 80 acepta las dos (el HTTP
  // redirige), que es lo que espera cualquiera que pida «el puerto estándar».
  // Cualquier otro puerto se queda en HTTP plano como siempre: si el panel no
  // tiene certificado, añadir un 8880 no debe dejar de funcionar.
  if (Number(port) === 443) return 'https';
  if (Number(port) === 80) return 'both';
  return 'http';
}

function parsePortList(rawStr) {
  if (!rawStr) return [];
  const entries = new Map();
  for (const token of String(rawStr).split(/[,\s;]+/)) {
    const clean = token.trim();
    if (!clean) continue;
    const [rawPort, rawScheme] = clean.split(':');
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 80 || n > 65535 || n === mainPort) continue;
    entries.set(n, { port: n, scheme: normalizeScheme(rawScheme, n) });
  }
  return Array.from(entries.values()).sort((a, b) => a.port - b.port);
}

function getStoredPorts() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'extra_http_ports'").get();
  return parsePortList(row?.value || '');
}

function saveStoredPorts(entries) {
  const clean = Array.from(
    new Map(
      entries
        .filter((e) => Number.isInteger(e.port) && e.port !== mainPort)
        .map((e) => [e.port, { port: e.port, scheme: normalizeScheme(e.scheme, e.port) }])
    ).values()
  ).sort((a, b) => a.port - b.port);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('extra_http_ports', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(clean.map((e) => `${e.port}:${e.scheme}`).join(','));
  return clean;
}

function closeRecord(rec) {
  for (const srv of rec.servers) {
    try {
      srv.close();
    } catch {
      // ignore
    }
  }
}

function plainHttpServer() {
  const srv = http.createServer(expressApp);
  srv.keepAliveTimeout = 65000;
  srv.headersTimeout = 66000;
  if (upgradeHandler) srv.on('upgrade', upgradeHandler);
  return srv;
}

// Servidor para el HTTP plano del puerto 80: manda a HTTPS conservando host y ruta.
export function createHttpsRedirectServer() {
  return http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0] || 'localhost';
    const target = `https://${host}${req.url || '/'}`;
    res.writeHead(301, {
      Location: target,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end(`Este panel sólo atiende por HTTPS: ${target}\n`);
  });
}

/**
 * Servidor que atiende TLS y HTTP plano en el mismo puerto mirando el primer
 * byte. `tlsServer` puede ser null (sin certificado): en ese caso todo entra
 * como HTTP.
 */
function smartServer({ tlsServer, plainServer, tlsOnly }) {
  // Sin pauseOnConnect: se espera al primer trozo de la conexión, se devuelve al
  // flujo y se entrega al servidor que toca. El HTTP plano necesita un
  // resume() explícito (el servidor HTTP no lo reanuda al recibir el socket
  // prestado); el TLS no, porque TLSSocket gestiona su propio flujo: hacerlo
  // después de envolver el socket rompía el handshake.
  const server = net.createServer((socket) => {
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
    socket.once('data', (chunk) => {
      try {
        socket.pause();
        socket.unshift(chunk);
        const isTls = chunk[0] === 0x16;
        if (isTls) {
          if (!tlsServer) return socket.destroy();
          tlsServer.emit('connection', socket);
        } else if (tlsOnly) {
          socket.destroy();
        } else {
          plainServer.emit('connection', socket);
          socket.resume();
        }
      } catch {
        socket.destroy();
      }
    });
  });
  server.keepAliveTimeout = 65000;
  return server;
}

function bindPort(entry) {
  const { port, scheme } = entry;
  return new Promise((resolve) => {
    const existing = extraServers.get(port);
    if (existing) {
      if (existing.status === 'listening' && existing.scheme === scheme) return resolve(existing);
      closeRecord(existing);
      extraServers.delete(port);
    }

    const record = {
      port,
      scheme,
      servers: [],
      status: 'starting',
      error: '',
      tls: false,
      startedAt: new Date().toISOString()
    };
    extraServers.set(port, record);

    const wantsTls = scheme === 'https' || scheme === 'both';
    const tlsCtx = wantsTls ? loadTlsContext() : null;
    if (wantsTls && !tlsCtx.ok) {
      record.status = 'error';
      record.error = `Puerto ${port}: no hay certificado TLS (${tlsCtx.error}). Configúralo antes de abrir HTTPS.`;
      return resolve(record);
    }

    let listenable;
    let tlsServer = null;
    let plainSrv = null;
    const tlsOpts = wantsTls && tlsCtx.ok ? getServerTlsOptions() : null;

    try {
      if (scheme === 'http') {
        listenable = plainHttpServer();
      } else if (scheme === 'https') {
        // SNI: cada dominio recibe su certificado (Origin de Cloudflare para el
        // panel, Let's Encrypt para el video) y el resto, el de por defecto.
        tlsServer = https.createServer(tlsOpts, expressApp);
        tlsServer.keepAliveTimeout = 65000;
        tlsServer.headersTimeout = 66000;
        if (upgradeHandler) tlsServer.on('upgrade', upgradeHandler);
        listenable = tlsServer;
        record.tls = true;
      } else {
        tlsServer = https.createServer(tlsOpts, expressApp);
        tlsServer.keepAliveTimeout = 65000;
        tlsServer.headersTimeout = 66000;
        if (upgradeHandler) tlsServer.on('upgrade', upgradeHandler);
        // En el 80 (y en el 443, donde el texto plano no pinta nada) el HTTP sin
  // cifrar contesta 301 a HTTPS; en el resto se atiende normal.
        plainSrv = port === 80 || port === 443 ? createHttpsRedirectServer() : plainHttpServer();
        listenable = smartServer({ tlsServer, plainServer: plainSrv });
        record.tls = true;
      }
    } catch (err) {
      record.status = 'error';
      record.error = err.message;
      return resolve(record);
    }

    if (scheme === 'http' || scheme === 'https') record.servers.push(listenable);
    else record.servers.push(listenable, tlsServer, plainSrv);

    const onError = (err) => {
      record.status = 'error';
      record.error =
        err.code === 'EADDRINUSE'
          ? `Puerto ${port} ocupado por otro proceso (EADDRINUSE)`
          : err.code === 'EACCES'
            ? `Permiso denegado para el puerto ${port} (requiere root o CAP_NET_BIND_SERVICE)`
            : err.message;
      resolve(record);
    };

    listenable.once('error', onError);
    listenable.listen(port, '0.0.0.0', () => {
      listenable.removeListener('error', onError);
      listenable.on('error', (runtimeErr) => {
        record.status = 'error';
        record.error = runtimeErr.message;
      });
      record.status = 'listening';
      record.error = '';
      record.startedAt = new Date().toISOString();
      const proto = record.tls ? (scheme === 'both' ? 'HTTPS+HTTP' : 'HTTPS') : 'HTTP';
      console.log(`🔌 [Multi-Port] Puerto ${port} activo (${proto}) en 0.0.0.0:${port}`);
      resolve(record);
    });
  });
}

export async function initMultiPortManager({ app, primaryServer, primaryPort, onUpgrade }) {
  expressApp = app;
  mainPort = Number(primaryPort) || 8080;
  upgradeHandler = onUpgrade || null;

  if (primaryServer && upgradeHandler) {
    primaryServer.on('upgrade', upgradeHandler);
  }

  return syncExtraPorts();
}

export async function syncExtraPorts() {
  const desired = getStoredPorts();

  for (const [port, rec] of extraServers.entries()) {
    const entry = desired.find((d) => d.port === port);
    if (!entry || entry.scheme !== rec.scheme) {
      closeRecord(rec);
      extraServers.delete(port);
    }
  }

  for (const entry of desired) {
    await bindPort(entry);
  }

  return listActivePorts();
}

export async function addExtraPort(rawPort, rawScheme = null) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 80 || port > 65535) {
    throw new Error('El puerto debe ser un número entero entre 80 y 65535.');
  }
  if (port === mainPort) {
    throw new Error(`El puerto ${port} ya es el puerto principal del panel.`);
  }

  const scheme = normalizeScheme(rawScheme, port);
  const current = getStoredPorts().filter((e) => e.port !== port);
  current.push({ port, scheme });
  saveStoredPorts(current);

  const record = await bindPort({ port, scheme });
  return {
    addedPort: port,
    scheme,
    status: record.status,
    error: record.error,
    tls: record.tls,
    ...listActivePorts()
  };
}

export function removeExtraPort(rawPort) {
  const port = Number(rawPort);
  saveStoredPorts(getStoredPorts().filter((e) => e.port !== port));

  const rec = extraServers.get(port);
  if (rec) {
    closeRecord(rec);
    extraServers.delete(port);
  }

  return listActivePorts();
}

/** Reabre los puertos TLS tras cambiar/renovar el certificado. */
export async function rebindAllPorts() {
  for (const [port, rec] of extraServers.entries()) {
    closeRecord(rec);
    extraServers.delete(port);
  }
  return syncExtraPorts();
}

export function listActivePorts() {
  const stored = getStoredPorts();
  const extraPorts = stored.map((entry) => {
    const rec = extraServers.get(entry.port);
    return {
      port: entry.port,
      scheme: entry.scheme,
      tls: rec ? rec.tls : entry.scheme !== 'http',
      status: rec ? rec.status : 'stopped',
      error: rec ? rec.error : '',
      startedAt: rec ? rec.startedAt : null,
      httpsUrl: rec && rec.tls ? `https://<tu-dominio>${entry.port === 443 ? '' : `:${entry.port}`}` : null,
      httpUrl: (() => {
        if (entry.scheme === 'http') return `http://<tu-dominio>${entry.port === 80 ? '' : `:${entry.port}`}`;
        if (entry.port === 80 || entry.port === 443) return 'HTTP → redirige a HTTPS';
        if (entry.scheme === 'both') return `http://<tu-dominio>:${entry.port}`;
        return null;
      })()
    };
  });

  return {
    primaryPort: mainPort,
    extraPorts,
    allListeningPorts: [mainPort, ...extraPorts.filter((p) => p.status === 'listening').map((p) => p.port)],
    tls: tlsStatus()
  };
}
