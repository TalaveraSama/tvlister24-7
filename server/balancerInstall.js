/**
 * Instalador de nodos balancer desde el panel.
 *
 * El operador escribe la IP y la clave del VPS en el panel; el panel entra por
 * SSH y deja el nodo funcionando (Node aislado + agente con caché + servicio
 * systemd). No hace falta tocar la consola del VPS ni copiar comandos.
 *
 * Nada de credenciales se guarda: se usan para la conexión y se descartan.
 * Lo que queda en la base es el estado de la instalación (`install_status`) y
 * el registro (`install_log`), que el operador ve en la pantalla.
 */
import crypto from 'node:crypto';
import { Client as SshClient } from 'ssh2';

const MAX_LOG_CHARS = 12000;
const jobs = new Map();

/* ========================================================================== */
/*  Comando remoto                                                           */
/* ========================================================================== */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Línea que se ejecuta en el VPS nuevo. Descarga el instalador **de este mismo
 * panel** (así el nodo queda con la misma versión del agente) y le pasa el
 * token del nodo.
 */
export function buildInstallCommand({ masterUrl, token, port = 8096, cacheMb = 256 }) {
  const base = String(masterUrl || '').replace(/\/+$/, '');
  const args = [
    '--master', shellQuote(base),
    '--token', shellQuote(token),
    '--port', shellQuote(String(port))
  ];
  if (Number(cacheMb) > 0) args.push('--cache-mb', shellQuote(String(cacheMb)));
  return `curl -fsSL ${shellQuote(`${base}/api/lb/install.sh`)} | bash -s -- ${args.join(' ')}`;
}

function assertTarget({ host, sshPort }) {
  const h = String(host || '').trim();
  if (!/^[a-zA-Z0-9._:-]+$/.test(h) || h.length > 253) {
    throw new Error('IP o dominio del VPS inválido.');
  }
  const p = Number(sshPort) || 22;
  if (p < 1 || p > 65535) throw new Error('Puerto SSH inválido.');
  return { host: h, port: p };
}

/* ========================================================================== */
/*  Trabajos de instalación (para ver el progreso desde la pantalla)          */
/* ========================================================================== */
export function createInstallJob(serverId) {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, {
    id,
    serverId: Number(serverId) || 0,
    status: 'running',
    log: '',
    startedAt: new Date().toISOString(),
    finishedAt: null
  });
  // Sólo se guardan los últimos 30 trabajos en memoria.
  if (jobs.size > 30) {
    const oldest = [...jobs.keys()][0];
    jobs.delete(oldest);
  }
  return id;
}

export function appendInstallLog(jobId, chunk) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.log = (job.log + chunk).slice(-MAX_LOG_CHARS);
}

export function finishInstallJob(jobId, status, extra = '') {
  const job = jobs.get(jobId);
  if (!job) return;
  if (extra) appendInstallLog(jobId, extra);
  job.status = status;
  job.finishedAt = new Date().toISOString();
}

export function getInstallJob(jobId) {
  return jobs.get(jobId) || null;
}

/* ========================================================================== */
/*  SSH                                                                      */
/* ========================================================================== */
/**
 * Ejecuta el instalador en el VPS. Devuelve { ok, code, log }.
 * `onLog(texto)` recibe la salida en vivo para irla guardando en el trabajo.
 */
export function runRemoteInstall({
  host,
  sshPort = 22,
  username = 'root',
  password = '',
  privateKey = '',
  masterUrl,
  token,
  edgePort = 8096,
  cacheMb = 256,
  timeoutMs = 15 * 60 * 1000,
  onLog = () => {}
}) {
  const target = assertTarget({ host, sshPort });
  if (!password && !privateKey) {
    return Promise.reject(new Error('Indica la contraseña root del VPS o una clave privada SSH.'));
  }
  if (!masterUrl) return Promise.reject(new Error('Falta la URL pública de este panel (para que el nodo descargue el agente).'));
  if (!token) return Promise.reject(new Error('El nodo no tiene token: créalo antes de instalar.'));

  const command = buildInstallCommand({ masterUrl, token, port: edgePort, cacheMb });
  const wrap = String(username).trim() === 'root' || String(username).trim() === ''
    ? command
    : `sudo -n bash -c ${shellQuote(command)}`;

  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let settled = false;
    let log = '';

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ya cerrada */
      }
      fn(arg);
    };

    const timer = setTimeout(() => {
      onLog('\n[tiempo de espera agotado]\n');
      done(reject, new Error('La instalación tardó demasiado (15 min). Revisa el VPS por SSH.'));
    }, timeoutMs);

    conn.on('ready', () => {
      onLog(`Conectado a ${target.host}:${target.port} como ${username || 'root'}\n`);
      conn.exec(wrap, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return done(reject, err);
        }
        stream.on('data', (d) => {
          const text = d.toString('utf8');
          log += text;
          onLog(text);
        });
        stream.stderr.on('data', (d) => {
          const text = d.toString('utf8');
          log += text;
          onLog(text);
        });
        stream.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) done(resolve, { ok: true, code, log });
          else done(reject, Object.assign(new Error(`El instalador terminó con código ${code}.`), { log, code }));
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      done(reject, new Error(`No se pudo conectar por SSH: ${err.message}`));
    });

    const config = {
      host: target.host,
      port: target.port,
      username: String(username || 'root').trim() || 'root',
      readyTimeout: 25000,
      keepaliveInterval: 10000
    };
    if (privateKey) {
      config.privateKey = privateKey;
      if (password) config.passphrase = password;
    } else {
      config.password = password;
    }

    try {
      conn.connect(config);
    } catch (err) {
      clearTimeout(timer);
      done(reject, err);
    }
  });
}
