import http from 'http';
import { db } from './db.js';

let expressApp = null;
let mainPort = 8080;
let upgradeHandler = null;
const extraServers = new Map(); // port -> { server, status, error, startedAt }

function parsePortList(rawStr) {
  if (!rawStr) return [];
  const ports = new Set();
  for (const token of String(rawStr).split(/[,\s;]+/)) {
    const n = Number(token.trim());
    if (Number.isInteger(n) && n >= 80 && n <= 65535 && n !== mainPort) {
      ports.add(n);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

function getStoredPorts() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'extra_http_ports'").get();
  return parsePortList(row?.value || '');
}

function saveStoredPorts(ports) {
  const clean = Array.from(new Set(ports.filter((p) => Number.isInteger(p) && p !== mainPort))).sort((a, b) => a - b);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('extra_http_ports', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(clean.join(','));
  return clean;
}

function bindSingleExtraPort(port) {
  if (extraServers.has(port)) {
    const existing = extraServers.get(port);
    if (existing.status === 'listening') return Promise.resolve(existing);
    try {
      existing.server.close();
    } catch {
      // ignore
    }
    extraServers.delete(port);
  }

  return new Promise((resolve) => {
    const srv = http.createServer(expressApp);
    srv.keepAliveTimeout = 65000;
    srv.headersTimeout = 66000;
    if (upgradeHandler) {
      srv.on('upgrade', upgradeHandler);
    }

    const record = {
      port,
      server: srv,
      status: 'starting',
      error: '',
      startedAt: new Date().toISOString(),
    };
    extraServers.set(port, record);

    const onError = (err) => {
      record.status = 'error';
      record.error = err.code === 'EADDRINUSE'
        ? `Puerto ${port} ocupado por otro proceso (EADDRINUSE)`
        : err.code === 'EACCES'
        ? `Permiso denegado para puerto ${port} (requiere root o puerto >= 1024)`
        : err.message;
      resolve(record);
    };

    srv.once('error', onError);
    srv.listen(port, '0.0.0.0', () => {
      srv.removeListener('error', onError);
      srv.on('error', (runtimeErr) => {
        record.status = 'error';
        record.error = runtimeErr.message;
      });
      record.status = 'listening';
      record.error = '';
      record.startedAt = new Date().toISOString();
      console.log(`🔌 [Multi-Port] Puerto HTTP/Streaming adicional activo en 0.0.0.0:${port}`);
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
  const desired = new Set(getStoredPorts());

  // Stop removed ports
  for (const [port, rec] of extraServers.entries()) {
    if (!desired.has(port)) {
      try {
        rec.server.close();
      } catch {
        // ignore
      }
      extraServers.delete(port);
    }
  }

  // Bind desired ports
  for (const port of desired) {
    await bindSingleExtraPort(port);
  }

  return listActivePorts();
}

export async function addExtraPort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 80 || port > 65535) {
    throw new Error('El puerto debe ser un número entero entre 80 y 65535.');
  }
  if (port === mainPort) {
    throw new Error(`El puerto ${port} ya es el puerto principal del panel.`);
  }

  const current = getStoredPorts();
  if (!current.includes(port)) {
    current.push(port);
    saveStoredPorts(current);
  }

  const record = await bindSingleExtraPort(port);
  return {
    addedPort: port,
    status: record.status,
    error: record.error,
    ...listActivePorts(),
  };
}

export function removeExtraPort(rawPort) {
  const port = Number(rawPort);
  const current = getStoredPorts().filter((p) => p !== port);
  saveStoredPorts(current);

  const rec = extraServers.get(port);
  if (rec) {
    try {
      rec.server.close();
    } catch {
      // ignore
    }
    extraServers.delete(port);
  }

  return listActivePorts();
}

export function listActivePorts() {
  const stored = getStoredPorts();
  const extraPorts = stored.map((port) => {
    const rec = extraServers.get(port);
    return {
      port,
      status: rec ? rec.status : 'stopped',
      error: rec ? rec.error : '',
      startedAt: rec ? rec.startedAt : null,
    };
  });

  return {
    primaryPort: mainPort,
    extraPorts,
    allListeningPorts: [
      mainPort,
      ...extraPorts.filter((p) => p.status === 'listening').map((p) => p.port),
    ],
  };
}
