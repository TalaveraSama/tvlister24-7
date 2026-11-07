/**
 * ============================================================================
 * GUARDIA DE ESTABILIDAD 24/7
 * ----------------------------------------------------------------------------
 * Lo que hace falta para que esto aguante meses encendido y no una tarde de
 * pruebas. Cada punto responde a un fallo real de operación continua:
 *
 *   1. Procesos huérfanos  — si el panel muere de golpe (OOM, `kill -9`), sus
 *      FFmpeg pueden quedar vivos y seguir enviando al MISMO grupo UDP del
 *      modulador. Dos emisores = el doble de bitrate y el modulador se cae.
 *      Aquí se marcan los hijos con TVLISTER_WORKER=1 y al arrancar se barren
 *      los que quedaron de la vida anterior.
 *   2. Basura en RAMDisk   — directorios de canales que ya no existen. En
 *      /dev/shm se comen la RAM que necesitan los canales vivos.
 *   3. SQLite              — WAL que crece sin freno, conexiones zombis y
 *      estadísticas desactualizadas.
 *   4. Canales congelados  — FFmpeg vivo pero sin escribir segmento (o sin
 *      mandar un byte al modulador). Se reengancha solo, sin tocar la línea
 *      de argumentos.
 *   5. Latencia del bucle  — si el proceso principal se atasca, todo el panel
 *      se congela. Se mide y se reporta (`tvlister-admin health`).
 *
 * Nada de esto cambia la salida FFmpeg ni la cadena UDP: sólo vigila, limpia
 * y reinicia lo que ya estaba roto.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { db } from './db.js';
import { BACKUPS_DIR } from './backupScheduler.js';
import { HLS_ROOT, RUNTIME_DIR, getWorkerDiagnostics } from './streamEngine.js';

const run = promisify(execFile);

/** Marca que llevan todos los procesos hijos del panel (ver `workerEnv`). */
export const WORKER_ENV_MARKER = 'TVLISTER_WORKER';

/** Añade las variables de identificación a cualquier env de un hijo. */
export function workerEnv(baseEnv, extra = {}) {
  return { ...(baseEnv || process.env), [WORKER_ENV_MARKER]: '1', ...extra };
}

// ---------------------------------------------------------------------------
// 1. Procesos huérfanos
// ---------------------------------------------------------------------------

async function listProcesses() {
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 8 * 1024 * 1024 });
    return stdout
      .split('\n')
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) return null;
        return { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasWorkerMarker(pid) {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
    return env.split('\0').includes(`${WORKER_ENV_MARKER}=1`);
  } catch {
    return false;
  }
}

/** PIDs de hijos directos de este proceso (los legítimos). */
function ownChildren(pids) {
  const ps = [];
  try {
    for (const pid of pids) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // campo 4 = ppid (el nombre del proceso puede llevar espacios y paréntesis)
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      ps.push({ pid, ppid });
    }
  } catch {
    /* ignore */
  }
  return ps;
}

/**
 * Mata los FFmpeg del panel que quedaron vivos de un arranque anterior.
 * Sólo toca procesos con nuestra marca y que NO sean hijos del proceso actual.
 * @returns {Promise<{found:number, killed:number, pids:number[]}>}
 */
export async function reapOrphanWorkers() {
  const procs = await listProcesses();
  const candidates = procs.filter((p) => /ffmpeg|mediamtx/i.test(p.args)).map((p) => p.pid);
  if (candidates.length === 0) return { found: 0, killed: 0, pids: [] };

  const parents = ownChildren(candidates);
  const alive = new Set();
  for (const { pid, ppid } of parents) {
    if (ppid !== process.pid) alive.add(pid);
  }

  const orphans = [];
  for (const pid of alive) {
    if (hasWorkerMarker(pid)) orphans.push(pid);
  }
  if (orphans.length === 0) return { found: 0, killed: 0, pids: [] };

  for (const pid of orphans) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ya murió */
    }
  }
  // Lo que no se va con SIGTERM en 2 s, se va con SIGKILL.
  await new Promise((r) => setTimeout(r, 2000));
  let killed = 0;
  for (const pid of orphans) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      killed += 1;
    }
  }
  return { found: orphans.length, killed, pids: orphans };
}

/** Sólo cuenta (no mata): lo usa el informe de salud. */
export async function countOrphanWorkers() {
  const procs = await listProcesses();
  const candidates = procs.filter((p) => /ffmpeg|mediamtx/i.test(p.args)).map((p) => p.pid);
  const parents = ownChildren(candidates);
  const orphans = parents.filter(({ pid, ppid }) => ppid !== process.pid && hasWorkerMarker(pid)).map((p) => p.pid);
  return orphans;
}

// ---------------------------------------------------------------------------
// 2. Basura en los directorios de trabajo
// ---------------------------------------------------------------------------

const STALE_DIR_MS = 10 * 60 * 1000;

/**
 * Borra directorios HLS y listas de concatenación que ya no pertenecen a ningún
 * worker vivo. Sin esto, /dev/shm se llena de canales que se borraron hace
 * meses y los canales reales se van a disco sin avisar.
 */
export function cleanStaleWorkDirs() {
  const liveKeys = new Set((getWorkerDiagnostics() || []).map((w) => w.key));
  const removed = [];
  for (const root of [HLS_ROOT, path.join(RUNTIME_DIR, 'hls')]) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(root, name);
      if (liveKeys.has(name)) continue;
      try {
        const st = fs.statSync(full);
        if (!st.isDirectory()) continue;
        if (Date.now() - st.mtimeMs < STALE_DIR_MS) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch {
        /* en uso o sin permisos: se reintenta en la próxima vuelta */
      }
    }
  }

  // Listas ffconcat de canales 24/7 que ya no existen
  const playlistRoot = path.join(RUNTIME_DIR, 'playlists');
  try {
    for (const name of fs.readdirSync(playlistRoot)) {
      const m = name.match(/^channel247_(\d+)\.txt$/);
      if (!m) continue;
      if (liveKeys.has(`ch247_${m[1]}`)) continue;
      const full = path.join(playlistRoot, name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs < 24 * 3600 * 1000) continue;
        fs.unlinkSync(full);
        removed.push(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* sin playlists */
  }

  return removed;
}

// ---------------------------------------------------------------------------
// 3. SQLite
// ---------------------------------------------------------------------------

function fileSizeMb(p) {
  try {
    return fs.statSync(p).size / (1024 * 1024);
  } catch {
    return 0;
  }
}

/**
 * Mantenimiento periódico: checkpoint del WAL, estadísticas y limpieza de
 * conexiones zombis. Nunca borra datos del operador.
 */
export function runDbMaintenance({ walThresholdMb = 32 } = {}) {
  const out = { optimized: false, walCheckpoint: false, purgedConnections: 0, walMb: 0 };
  try {
    db.exec('PRAGMA optimize;');
    out.optimized = true;
  } catch {
    /* ignore */
  }

  try {
    const row = db.prepare('PRAGMA journal_mode').get();
    if (String(Object.values(row)[0] || '').toLowerCase() === 'wal') {
      out.walMb = fileSizeMb(`${dbPathOfApplication()}-wal`);
      if (out.walMb > walThresholdMb) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        out.walCheckpoint = true;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const res = db
      .prepare(
        `DELETE FROM active_connections
          WHERE datetime(last_ping_at) < datetime('now', '-1 day')`
      )
      .run();
    out.purgedConnections = res.changes || 0;
  } catch {
    /* ignore */
  }

  return out;
}

function dbPathOfApplication() {
  try {
    const row = db.prepare('PRAGMA database_list').get();
    return row?.file || path.join(RUNTIME_DIR, '../data/tvlister.db');
  } catch {
    return path.join(RUNTIME_DIR, '../data/tvlister.db');
  }
}

/**
 * Compacta la base cuando hay mucho espacio muerto (se ejecuta a mano desde
 * `tvlister-admin health --vacuum`, nunca sola: bloquea mientras dura).
 */
export function vacuumDatabase() {
  const before = fileSizeMb(dbPathOfApplication());
  const freelist = db.prepare('PRAGMA freelist_count').get();
  const pages = db.prepare('PRAGMA page_count').get();
  const ratio = Number(Object.values(pages)[0]) ? Number(Object.values(freelist)[0]) / Number(Object.values(pages)[0]) : 0;
  db.exec('VACUUM;');
  const after = fileSizeMb(dbPathOfApplication());
  return { beforeMb: before, afterMb: after, freeRatio: Number(ratio.toFixed(2)) };
}

// ---------------------------------------------------------------------------
// 4. Canales congelados
// ---------------------------------------------------------------------------

/** Canales CATV que declaran estar emitiendo sin mandar un solo byte. */
export function getStalledCatvChannels(consecutive = 1) {
  const map = typeof globalThis.__tvlisterCatvWorkerSnapshot === 'function'
    ? globalThis.__tvlisterCatvWorkerSnapshot()
    : new Map();
  const stalled = [];
  for (const [ch, w] of map || []) {
    const hasBytes = Number(w.bitrateKbps) > 0;
    // El contador se actualiza ANTES de decidir: si el canal volvió a mandar
    // bytes, deja de estar colgado en esta misma vuelta.
    if (hasBytes) stateZero.delete(ch);
    else stateZero.set(ch, (stateZero.get(ch) || 0) + 1);
    const zeroFor = stateZero.get(ch) || 0;
    if (w.status === 'streaming' && zeroFor >= consecutive) {
      stalled.push({ ch, bitrateKbps: Number(w.bitrateKbps) || 0, engine: w.engine, lastError: w.lastError || '' });
    }
  }
  for (const ch of Array.from(stateZero.keys())) {
    if (!map || !map.has(ch)) stateZero.delete(ch);
  }
  return stalled;
}

const stateZero = new Map();

/** Canales HLS cuyo manifiesto lleva demasiado tiempo sin actualizarse. */
export function getStalledHlsWorkers(staleSec = 45) {
  return (getWorkerDiagnostics() || []).filter(
    (w) => w.pid && w.hlsAgeSec !== null && w.hlsAgeSec > staleSec
  );
}

// ---------------------------------------------------------------------------
// 5. Informe de estabilidad
// ---------------------------------------------------------------------------

const loopHistogram = monitorEventLoopDelay({ resolution: 20 });
let loopMonitoring = false;
export function startLoopMonitoring() {
  if (loopMonitoring) return;
  loopHistogram.enable();
  loopMonitoring = true;
}

export function getLoopLagMs() {
  if (!loopMonitoring) return null;
  const p50 = loopHistogram.percentile(50) / 1e6;
  const p99 = loopHistogram.percentile(99) / 1e6;
  const max = loopHistogram.max / 1e6;
  loopHistogram.reset();
  return { p50: Number(p50.toFixed(1)), p99: Number(p99.toFixed(1)), max: Number(max.toFixed(1)) };
}

function diskUsage(targetPath) {
  try {
    const st = fs.statfsSync(targetPath);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { totalMb: Math.round(total / 1048576), freeMb: Math.round(free / 1048576), usedPct: Math.round((1 - free / total) * 100) };
  } catch {
    return null;
  }
}

/**
 * Reúne el estado del sistema en comprobaciones con nivel ok/warn/fail.
 * Lo consumen `tvlister-admin health`, `/api/system/stability` y `/api/health`.
 */
export async function getStabilityReport({ deep = false } = {}) {
  const checks = [];
  const add = (id, level, label, detail) => checks.push({ id, level, label, detail });

  // --- Panel ---
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1048576);
  const heapMb = Math.round(mem.heapUsed / 1048576);
  const uptimeSec = Math.floor(process.uptime());
  add('uptime', 'ok', 'Panel en marcha', `${formatDur(uptimeSec)} · RSS ${rssMb} MB · heap ${heapMb} MB`);
  if (rssMb > 2048) {
    add('memory', 'warn', 'Memoria del panel alta', `${rssMb} MB de RSS. Revisa canales con transcode.`);
  }

  const lag = getLoopLagMs();
  if (lag) {
    add(
      'eventloop',
      lag.p99 > 500 ? 'warn' : 'ok',
      'Bucle de eventos',
      `p50 ${lag.p50} ms · p99 ${lag.p99} ms · máx ${lag.max} ms`
    );
  }

  // --- Disco y RAMDisk ---
  const dataDir = path.dirname(dbPathOfApplication());
  const disk = diskUsage(dataDir);
  if (disk) {
    add(
      'disk',
      disk.usedPct >= 92 ? 'fail' : disk.usedPct >= 85 ? 'warn' : 'ok',
      'Disco de datos',
      `${disk.freeMb} MB libres de ${disk.totalMb} MB (${disk.usedPct} % usado)`
    );
  }
  const shm = diskUsage(HLS_ROOT.startsWith('/dev/shm') ? '/dev/shm' : HLS_ROOT);
  if (shm) {
    add(
      'ramdisk',
      shm.freeMb < 128 ? 'warn' : 'ok',
      'RAMDisk HLS',
      `${HLS_ROOT} · ${shm.freeMb} MB libres (${shm.usedPct} % usado)`
    );
  }

  // --- Base de datos ---
  let dbMb = 0;
  let walMb = 0;
  try {
    dbMb = fileSizeMb(dbPathOfApplication());
    walMb = fileSizeMb(`${dbPathOfApplication()}-wal`);
    let integrity = 'no comprobada';
    if (deep) {
      const rows = db.prepare('PRAGMA integrity_check').all();
      integrity = rows.map((r) => Object.values(r)[0]).join(' ');
    } else {
      const rows = db.prepare('PRAGMA quick_check').all();
      integrity = rows.map((r) => Object.values(r)[0]).join(' ');
    }
    add(
      'db',
      integrity.toLowerCase().includes('ok') ? 'ok' : 'fail',
      'Base de datos SQLite',
      `${dbMb.toFixed(1)} MB · WAL ${walMb.toFixed(1)} MB · ${integrity}`
    );
    if (walMb > 128) {
      add('db-wal', 'warn', 'WAL grande', `${walMb.toFixed(1)} MB. Se recorta en el próximo mantenimiento.`);
    }
  } catch (err) {
    add('db', 'fail', 'Base de datos SQLite', err.message);
  }

  // --- Respaldos ---
  try {
    const backupsDir = BACKUPS_DIR;
    const files = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json')).map((f) => fs.statSync(path.join(backupsDir, f)).mtimeMs)
      : [];
    if (!files.length) {
      add('backup', 'warn', 'Respaldo del panel', 'No hay ningún respaldo en data/backups');
    } else {
      const newest = Math.max(...files);
      const ageH = Math.round((Date.now() - newest) / 3600000);
      add(
        'backup',
        ageH > 48 ? 'warn' : 'ok',
        'Respaldo del panel',
        `${files.length} respaldos · el último hace ${ageH} h`
      );
    }
  } catch {
    /* ignore */
  }

  // --- Workers HLS ---
  const workers = getWorkerDiagnostics() || [];
  const noPid = workers.filter((w) => !w.pid);
  const stale = getStalledHlsWorkers(45);
  add(
    'hls-workers',
    noPid.length ? 'warn' : 'ok',
    'Canales HLS',
    `${workers.length} workers · ${noPid.length} sin proceso · ${stale.length} con manifiesto parado`
  );

  // --- Workers CATV (moduladores) ---
  const catvMap = typeof globalThis.__tvlisterCatvWorkerSnapshot === 'function'
    ? globalThis.__tvlisterCatvWorkerSnapshot()
    : new Map();
  const catv = Array.from((catvMap || new Map()).values());
  const catvZero = catv.filter((w) => w.status === 'streaming' && !Number(w.bitrateKbps));
  const catvDown = catv.filter((w) => w.status !== 'streaming');
  add(
    'catv-workers',
    catvDown.length ? 'warn' : 'ok',
    'Salida a moduladores (UDP)',
    `${catv.length} canales activos · ${catvDown.length} reconectando · ${catvZero.length} sin bytes`
  );

  // --- Huérfanos ---
  try {
    const orphans = await countOrphanWorkers();
    add(
      'orphans',
      orphans.length ? 'fail' : 'ok',
      'Procesos huérfanos',
      orphans.length
        ? `${orphans.length} FFmpeg de una ejecución anterior (PIDs ${orphans.join(', ')}) — pueden duplicar el UDP`
        : 'ninguno'
    );
  } catch {
    /* ignore */
  }

  // --- FFmpeg ---
  try {
    const { isFfmpegAvailable, getFfmpegBin } = await import('./streamEngine.js');
    add('ffmpeg', isFfmpegAvailable() ? 'ok' : 'fail', 'Motor FFmpeg', isFfmpegAvailable() ? getFfmpegBin() : 'no encontrado');
  } catch {
    /* ignore */
  }

  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  return {
    generatedAt: new Date().toISOString(),
    verdict: fails ? 'fail' : warns ? 'warn' : 'ok',
    fails,
    warns,
    checks
  };
}

function formatDur(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h ${m} min`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

// ---------------------------------------------------------------------------
// Guardia periódica
// ---------------------------------------------------------------------------

let guardTimer = null;
const state = { startedAt: 0, lastCleanupAt: 0, lastDbMaintAt: 0, restartedHls: 0, restartedCatv: 0, lastReport: null, ticks: 0 };

export function getStabilityGuardState() {
  return { ...state, running: Boolean(guardTimer) };
}

/**
 * Arranca la vigilancia. No toca argumentos de FFmpeg ni configuración: sólo
 * limpia, reinicia procesos colgados y mantiene la base sana.
 */
export function startStabilityGuard({ tickMs = 60_000 } = {}) {
  if (guardTimer) return getStabilityGuardState();
  startLoopMonitoring();
  state.startedAt = Date.now();

  // Barrido de huérfanos de la ejecución anterior (antes de que arranquen
  // workers nuevos, para no matar los legítimos).
  reapOrphanWorkers()
    .then((r) => {
      if (r.found) console.warn(`[estabilidad] ${r.found} proceso(s) FFmpeg huérfano(s) de una ejecución anterior: terminados.`);
    })
    .catch(() => {});

  guardTimer = setInterval(async () => {
    const now = Date.now();
    try {
      if (now - state.lastCleanupAt > 10 * 60_000) {
        state.lastCleanupAt = now;
        const removed = cleanStaleWorkDirs();
        if (removed.length) console.log(`[estabilidad] ${removed.length} directorio(s) HLS sin worker: liberados.`);
      }
      if (now - state.lastDbMaintAt > 60 * 60_000) {
        state.lastDbMaintAt = now;
        runDbMaintenance();
      }

      // Canales HLS con manifiesto congelado: se mata el FFmpeg y el worker se
      // relanza solo (su supervisor ya tiene backoff). Máximo 3 por vuelta.
      const stalledHls = getStalledHlsWorkers(90).slice(0, 3);
      if (stalledHls.length) {
        const { nudgeStalledWorker } = await import('./streamEngine.js');
        for (const w of stalledHls) {
          const ok = nudgeStalledWorker(w.key, 90);
          if (ok) state.restartedHls += 1;
        }
      }

      // Canales CATV que dicen estar emitiendo sin mandar bytes: 3 vueltas
      // seguidas (3 minutos) y se reengancha el canal.
      const stalledCatv = getStalledCatvChannels(3);
      if (stalledCatv.length) {
        const restart = globalThis.__tvlisterCatvRestartWorker;
        if (typeof restart === 'function') {
          for (const c of stalledCatv) {
            try {
              restart(c.ch);
              state.restartedCatv += 1;
              console.warn(`[estabilidad] CH${c.ch} sin bytes en 3 min: reenganchado.`);
            } catch {
              /* ignore */
            }
          }
        }
      }

      // El informe completo (incluye `ps` y quick_check de SQLite) se recalcula
      // cada 5 minutos: los vigilantes de arriba siguen corriendo cada minuto.
      state.ticks = (state.ticks || 0) + 1;
      if (state.ticks === 1 || state.ticks % 5 === 0) {
        state.lastReport = await getStabilityReport();
      }
    } catch {
      /* la guardia nunca debe tumbar el panel */
    }
  }, tickMs);
  guardTimer.unref?.();

  return getStabilityGuardState();
}
