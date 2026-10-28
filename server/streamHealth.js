import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import {
  getWorkerDiagnostics,
  resolveHlsDirForKey,
  stopWorker,
  scheduleDbStreamLaunches,
  getSegmentSettings,
  subscribeWorkerMpegTs
} from './streamEngine.js';

// Tipos de stream MPEG-TS que corresponden a AUDIO
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);

/** Lee hasta `maxBytes` del inicio de un segmento TS y verifica si el PMT declara alguna pista de audio. */
export function segmentHasAudio(filePath, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (read < 188 * 2) return null;

    let pmtPid = -1;
    for (let off = 0; off + 188 <= read; off += 188) {
      if (buf[off] !== 0x47) continue;
      const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
      const pusi = (buf[off + 1] & 0x40) !== 0;
      const afc = (buf[off + 3] >> 4) & 0x3;
      if (!pusi) continue;
      let payloadStart = off + 4;
      if (afc === 3) payloadStart += 1 + buf[off + 4];
      else if (afc === 2) continue;
      if (payloadStart + 8 > off + 188) continue;
      const pointer = buf[payloadStart];
      const section = payloadStart + 1 + pointer;
      if (section + 8 > off + 188) continue;
      const tableId = buf[section];

      if (pid === 0x0000 && tableId === 0x00) {
        const sectionLength = ((buf[section + 1] & 0x0f) << 8) | buf[section + 2];
        for (let p = section + 8; p + 4 <= section + 3 + sectionLength - 4; p += 4) {
          const programNumber = (buf[p] << 8) | buf[p + 1];
          const programPid = ((buf[p + 2] & 0x1f) << 8) | buf[p + 3];
          if (programNumber !== 0) {
            pmtPid = programPid;
            break;
          }
        }
      } else if (pid === pmtPid && tableId === 0x02) {
        const sectionLength = ((buf[section + 1] & 0x0f) << 8) | buf[section + 2];
        const programInfoLength = ((buf[section + 10] & 0x0f) << 8) | buf[section + 11];
        let es = section + 12 + programInfoLength;
        const esEnd = section + 3 + sectionLength - 4;
        while (es + 5 <= esEnd) {
          const streamType = buf[es];
          const esInfoLength = ((buf[es + 3] & 0x0f) << 8) | buf[es + 4];
          if (AUDIO_STREAM_TYPES.has(streamType)) return true;
          es += 5 + esInfoLength;
        }
        return false;
      }
    }
    return null; // PSI no encontrada todavía
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

const audioMisses = new Map();
const stallHits = new Map();
const lastRestartAt = new Map();

function newestSegment(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    if (files.length === 0) return null;
    let best = null;
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs };
      } catch {
        // ignorar carrera
      }
    }
    return best;
  } catch {
    return null;
  }
}

function restartChannel(streamId, reason) {
  const now = Date.now();
  const prev = lastRestartAt.get(streamId) || 0;
  if (now - prev < 120000) return false; // máximo 1 auto-reinicio cada 2 min por canal
  lastRestartAt.set(streamId, now);
  try {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('last_health_restart', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(`${new Date(now).toISOString()} stream_${streamId} ${reason}`.slice(0, 180));
  } catch {
    // ignore
  }
  stopWorker(`stream_${streamId}`);
  scheduleDbStreamLaunches([streamId], 120);
  return true;
}

/**
 * Vigilante de salud (equivalente a "Restart on Audio Loss" de XUI.one, ampliado):
 *  - reinicia canales que pierden la pista de audio en el PMT,
 *  - reinicia canales cuyo manifiesto HLS deja de avanzar (FFmpeg vivo pero congelado),
 * nunca más de una vez cada 2 minutos por canal para no crear tormentas de procesos.
 */
export function runStreamHealthCheck() {
  const cfg = getSegmentSettings();
  const restartOnAudioLoss = cfg.restartOnAudioLoss;
  const stallLimitSec = Math.max(45, cfg.segmentDuration * cfg.listSize * 3);
  const report = { checked: 0, restarted: 0, audioLost: [], stalled: [] };

  for (const diag of getWorkerDiagnostics()) {
    const m = /^stream_(\d+)$/.exec(diag.key);
    if (!m) continue;
    const streamId = Number(m[1]);
    if (!diag.pid) {
      audioMisses.delete(streamId);
      stallHits.delete(streamId);
      continue;
    }
    report.checked += 1;

    // 1) HLS congelado (sólo aplica con manifiesto presente)
    if (diag.hlsAgeSec !== null && diag.hlsAgeSec > stallLimitSec) {
      const hits = (stallHits.get(streamId) || 0) + 1;
      stallHits.set(streamId, hits);
      if (hits >= 2 && restartOnAudioLoss && restartChannel(streamId, `hls-frozen-${diag.hlsAgeSec}s`)) {
        report.stalled.push(streamId);
        report.restarted += 1;
        stallHits.delete(streamId);
        continue;
      }
    } else {
      stallHits.delete(streamId);
    }

    // 2) Pérdida de audio en el PMT del segmento más reciente
    if (!restartOnAudioLoss) continue;
    const seg = newestSegment(resolveHlsDirForKey(diag.key));
    if (!seg || Date.now() - seg.mtimeMs > 15000) continue;
    const hasAudio = segmentHasAudio(seg.full);
    if (hasAudio === false) {
      const misses = (audioMisses.get(streamId) || 0) + 1;
      audioMisses.set(streamId, misses);
      if (misses >= 3 && restartChannel(streamId, 'audio-lost')) {
        report.audioLost.push(streamId);
        report.restarted += 1;
        audioMisses.delete(streamId);
      }
    } else if (hasAudio === true) {
      audioMisses.delete(streamId);
    }
  }
  return report;
}

let watchdogTimer = null;

export function startStreamHealthWatchdog(intervalMs = 30000) {
  if (watchdogTimer) return watchdogTimer;
  watchdogTimer = setInterval(() => {
    try {
      runStreamHealthCheck();
    } catch {
      // nunca tumbar el proceso principal por el vigilante
    }
  }, intervalMs);
  watchdogTimer.unref?.();
  return watchdogTimer;
}

export function stopStreamHealthWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}
