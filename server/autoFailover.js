import { db } from './db.js';
import { getWorkerDiagnostics } from './streamEngine.js';

/**
 * ============================================================================
 * FAILOVER AUTOMÁTICO POR CANAL (SOURCE 2 dormido)
 * ----------------------------------------------------------------------------
 * El segundo origen (streams.backup_url) NO se abre hasta que hace falta:
 * mientras el origen activo responda, el respaldo no consume ni un byte de
 * ancho de banda ni levanta un segundo proceso FFmpeg.
 *
 * Cómo se detecta la caída sin gastar ancho de banda:
 *  - Canales con worker propio (transcode/remux): se usa el estado real del
 *    motor (PID vivo y antigüedad del manifiesto HLS). Cero red adicional.
 *  - Canales directos (proxy/302): sonda HTTP mínima (2 KB, cada 30 s) SOLO
 *    contra el origen activo. Nunca contra el respaldo.
 *
 * Al superar el umbral se hace exactamente el mismo cambio que el botón ⇄
 * manual (intercambio de URL + failover_active + reinicio del worker), así que
 * el reproductor reconecta al origen nuevo sin tocar su configuración.
 *
 * Vuelta atrás: si el respaldo también falla, se regresa al origen original
 * (evita quedarse atrapado en un respaldo muerto). La vuelta por recuperación
 * del principal es manual (botón ⇄) para no provocar rebotes.
 * ============================================================================
 */

const TICK_MS = 10_000;
const STRIKES_TO_SWITCH = 3; // 3 revisiones seguidas con caída ≈ 30 s
const SWITCH_COOLDOWN_MS = 120_000; // anti-rebote entre cambios automáticos
const HLS_STALE_SEC = 25; // manifiesto congelado = canal caído
const PROBE_EVERY_TICKS = 3; // canales directos: sonda cada 30 s
const PROBE_FAILURES_TO_SWITCH = 2; // 2 sondas fallidas seguidas
const PROBE_TIMEOUT_MS = 6_000;

let timer = null;
let switchSourceFn = null;
const watch = new Map(); // id -> { strikes, state, reason, lastSwitchAt, probeFailures, probeTick, switchedTo }

/** Sonda mínima: pide sólo 2 KB del origen activo y corta la descarga. */
async function probeUpstreamAlive(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return false;
  // Protocolos no HTTP (udp://, rtmp://, mnf://, archivo local) no se pueden sondear así:
  // se consideran "vivos" para no generar cambios en falso.
  if (!/^https?:\/\//i.test(url)) return true;

  const ac = new AbortController();
  const timerId = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'TVLister/2.3 (health-check)', Range: 'bytes=0-2047' },
      redirect: 'follow',
      signal: ac.signal
    });
    try {
      await res.body?.cancel();
    } catch {
      // sin cuerpo que cancelar
    }
    // 401/403 significan "existe pero pide credenciales": el origen responde.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timerId);
  }
}

function pruneStale(activeIds) {
  for (const id of watch.keys()) {
    if (!activeIds.has(id)) watch.delete(id);
  }
}

async function runTick() {
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT * FROM streams
          WHERE auto_failover = 1
            AND status = 'running'
            AND TRIM(COALESCE(backup_url, '')) <> ''`
      )
      .all();
  } catch {
    return; // base ocupada o esquema aún sin migrar
  }

  pruneStale(new Set(rows.map((r) => Number(r.id))));
  if (rows.length === 0) return;

  let diag = new Map();
  try {
    diag = new Map(getWorkerDiagnostics().map((d) => [d.key, d]));
  } catch {
    diag = new Map();
  }

  for (const row of rows) {
    const id = Number(row.id);
    const entry =
      watch.get(id) ||
      { strikes: 0, state: 'ok', reason: '', lastSwitchAt: 0, probeFailures: 0, probeTick: 0, switchedTo: '' };

    let down = false;
    let reason = '';

    if (row.stream_mode === 'transcode') {
      const worker = diag.get(`stream_${id}`);
      if (!worker || !worker.pid) {
        down = true;
        reason = 'FFmpeg sin proceso';
      } else if (worker.hlsAgeSec !== null && worker.hlsAgeSec > HLS_STALE_SEC) {
        down = true;
        reason = `señal congelada ${worker.hlsAgeSec}s`;
      }
    } else {
      entry.probeTick = (entry.probeTick || 0) + 1;
      if (entry.probeTick % PROBE_EVERY_TICKS === 0) {
        const alive = await probeUpstreamAlive(row.source_url);
        entry.probeFailures = alive ? 0 : (entry.probeFailures || 0) + 1;
      }
      if ((entry.probeFailures || 0) >= PROBE_FAILURES_TO_SWITCH) {
        down = true;
        reason = 'origen sin respuesta';
      }
    }

    entry.strikes = down ? (entry.strikes || 0) + 1 : 0;
    entry.state = down ? 'down' : 'ok';
    entry.reason = down ? reason : '';

    const cooldownOk = Date.now() - (entry.lastSwitchAt || 0) > SWITCH_COOLDOWN_MS;
    if (down && entry.strikes >= STRIKES_TO_SWITCH && cooldownOk && typeof switchSourceFn === 'function') {
      const onBackup = Number(row.failover_active) === 1;
      const target = onBackup ? 'primary' : 'backup';
      let result = { ok: false, error: 'sin manejador' };
      try {
        result = switchSourceFn(row, target);
      } catch (err) {
        result = { ok: false, error: err?.message || 'error' };
      }
      if (result?.ok) {
        entry.strikes = 0;
        entry.probeFailures = 0;
        entry.lastSwitchAt = Date.now();
        entry.switchedTo = target;
        entry.state = 'switched';
        entry.reason = reason;
        console.log(
          `[failover] ${row.name}: ${onBackup ? 'vuelta a SOURCE 1 (el respaldo también falló)' : 'cambio automático a SOURCE 2'} — motivo: ${reason}`
        );
      } else {
        entry.state = 'error';
        entry.reason = result?.error || 'no se pudo cambiar';
      }
    }

    watch.set(id, entry);
  }
}

export function startAutoFailoverMonitor({ switchSource, tickMs = TICK_MS } = {}) {
  if (switchSource) switchSourceFn = switchSource;
  if (timer) return;
  timer = setInterval(() => {
    runTick().catch(() => {
      // nunca tumbar el panel por una revisión fallida
    });
  }, tickMs);
  timer.unref?.();
}

export function stopAutoFailoverMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
  watch.clear();
}

/** Estado por canal para el panel (badge de salud y último motivo). */
export function getFailoverHealth() {
  const out = {};
  for (const [id, v] of watch) {
    out[id] = {
      state: v.state,
      strikes: v.strikes || 0,
      reason: v.reason || '',
      switchedTo: v.switchedTo || '',
      lastSwitchAt: v.lastSwitchAt ? new Date(v.lastSwitchAt).toISOString() : ''
    };
  }
  return out;
}
