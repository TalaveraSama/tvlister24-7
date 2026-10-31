/**
 * ============================================================================
 * CONFIGURACIÓN RECOMENDADA SEGÚN EL HARDWARE REAL
 * ----------------------------------------------------------------------------
 * Calcula, a partir de la máquina donde corre el panel (núcleos, RAM, tamaño
 * de /dev/shm, canales y perfiles en uso), cuál es la mejor configuración de
 * los ajustes que YA EXISTEN en el panel. No inventa opciones nuevas ni toca
 * la línea de argumentos de FFmpeg: sólo escribe valores de `settings`.
 *
 *   · computeRecommendation()  → lista de ajustes con valor actual/recomendado
 *   · applyRecommendation()    → escribe los que correspondan en SQLite
 *
 * Se usa desde `tvlister-admin tune` y desde la sección Motor FFmpeg.
 * ============================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import { db } from './db.js';
import {
  FFMPEG_ENGINE_DEFAULTS,
  FFMPEG_ENGINE_LIMITS,
  getFfmpegEngineConfig,
  estimateHlsFootprintBytes,
  isFfmpegAvailable,
  getFfmpegBin,
  getFfmpegBinInfo
} from './streamEngine.js';

const clamp = (v, [min, max]) => Math.min(max, Math.max(min, Math.round(v)));

function totalRamMb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = Number((txt.match(/^MemTotal:\s+(\d+)\s+kB/m) || [])[1] || 0);
    return kb ? Math.round(kb / 1024) : Math.round(os.totalmem() / (1024 * 1024));
  } catch {
    return Math.round(os.totalmem() / (1024 * 1024));
  }
}

function sharedMemInfo() {
  try {
    const st = fs.statfsSync('/dev/shm');
    const totalMb = Math.round((Number(st.blocks) * Number(st.bsize)) / (1024 * 1024));
    const freeMb = Math.round((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
    return { exists: true, totalMb, freeMb };
  } catch {
    return { exists: false, totalMb: 0, freeMb: 0 };
  }
}

function streamStats() {
  try {
    const rows = db
      .prepare(
        `SELECT s.stream_mode, s.status, s.audio_leveling_mode, s.bitrate_kbps AS bitrate,
                p.video_codec AS vcodec, p.audio_codec AS acodec
           FROM streams s
           LEFT JOIN transcode_profiles p ON p.id = s.transcode_profile_id`
      )
      .all();
    const transcode = rows.filter((r) => r.stream_mode !== 'direct');
    const copyOnly = transcode.filter((r) => (r.vcodec || 'copy') === 'copy');
    const reencode = transcode.filter((r) => (r.vcodec || 'copy') !== 'copy');
    const leveled = transcode.filter((r) => (r.acodec || 'copy') !== 'copy');
    return {
      total: rows.length,
      transcode: transcode.length,
      copyOnly: copyOnly.length,
      reencode: reencode.length,
      audioLeveled: leveled.length,
      catvSlots: db.prepare('SELECT COUNT(*) AS c FROM wk2500_channels').get()?.c || 0,
      catvEnabled: db.prepare('SELECT COUNT(*) AS c FROM wk2500_channels WHERE enabled = 1').get()?.c || 0,
      units: db.prepare('SELECT COUNT(*) AS c FROM wk2500_units WHERE enabled = 1').get()?.c || 0
    };
  } catch {
    return { total: 0, transcode: 0, copyOnly: 0, reencode: 0, audioLeveled: 0, catvSlots: 0, catvEnabled: 0, units: 0 };
  }
}

/** Estado del motor tal como está guardado ahora. */
export function currentSettings() {
  return getFfmpegEngineConfig();
}

/**
 * Calcula la recomendación completa. Devuelve:
 *   { hardware, workload, items[], warnings[], summary }
 * Cada item: { key, settingKey, label, current, recommended, unit, why, changed }
 */
export function computeRecommendation() {
  const cfg = getFfmpegEngineConfig();
  const cores = os.cpus()?.length || 1;
  const ramMb = totalRamMb();
  const shm = sharedMemInfo();
  const w = streamStats();
  const neededMb = Math.round(estimateHlsFootprintBytes() / (1024 * 1024));

  const hardware = { cores, ramMb, shm, neededMb, platform: os.platform(), arch: os.arch() };
  const warnings = [];
  const items = [];

  const add = (key, settingKey, label, current, recommended, unit, why) => {
    items.push({
      key,
      settingKey,
      label,
      current,
      recommended,
      unit,
      why,
      changed: String(current) !== String(recommended)
    });
  };

  // ---- Ventana HLS: la validada en producción (2 s × 6 = 12 s) -------------
  // No se toca: es la combinación que funcionó con 145 canales HD y Copy.
  add('hlsTime', 'ffmpeg_hls_time', 'Duración del segmento HLS', cfg.hlsTime, 2, 's',
    'Validada en producción. Con Copy, un segmento más largo sólo añade retardo.');
  add('hlsListSize', 'ffmpeg_hls_list_size', 'Segmentos en el manifiesto', cfg.hlsListSize, 6, 'segmentos',
    '12 s de ventana: margen suficiente para un reproductor lento sin borrar segmentos que aún se piden.');

  // ---- Sondas --------------------------------------------------------------
  // HD 8-12 Mbps necesita margen para no perder SPS/PPS del primer segmento.
  add('probeHttp', 'ffmpeg_probe_http', 'Sonda HTTP/HLS · bytes', cfg.probeHttp, 5000000, 'bytes',
    'Con menos de 5 MB FFmpeg puede perder el SPS/PPS inicial en HD y arrancar entrecortado.');
  add('analyzeHttp', 'ffmpeg_analyze_http', 'Sonda HTTP/HLS · tiempo', cfg.analyzeHttp, 4000000, 'µs',
    '4 s de análisis cubre el GOP típico de Flussonic sin retrasar el arranque.');
  add('probeLocal', 'ffmpeg_probe_local', 'Sonda UDP/RTMP · bytes', cfg.probeLocal, 1500000, 'bytes',
    'En red local (Astra / moduladores) no hace falta más.');
  add('analyzeLocal', 'ffmpeg_analyze_local', 'Sonda UDP/RTMP · tiempo', cfg.analyzeLocal, 1500000, 'µs',
    'Arranque rápido para fuentes locales.');

  // ---- Salida MPEG-TS ------------------------------------------------------
  // auto: sólo los troncales que empujan a Flussonic necesitan tee HLS+pipe.
  add('tsPipeMode', 'ffmpeg_ts_pipe_mode', 'Salida MPEG-TS continua', cfg.tsPipeMode, 'auto', '',
    'auto evita el doble muxer en 145 canales; sólo los troncales Flussonic lo usan.');
  add('tsJoinOnSegment', 'ffmpeg_ts_join_segment', 'Entrada en frontera de segmento', cfg.tsJoinOnSegment, true, '',
    'El cliente .ts empieza con PAT/PMT y no con un fragmento a medias.');

  // ---- Hilos del encoder (sólo afecta a quien re-codifica) -----------------
  // Con muchos canales, más hilos por canal empeora el rendimiento global.
  let threads = 2;
  if (cores <= 2) threads = 1;
  else if (cores >= 16 && w.reencode <= 4) threads = 4;
  threads = clamp(threads, FFMPEG_ENGINE_LIMITS.h264Threads);
  add('h264Threads', 'ffmpeg_h264_threads', 'Hilos por encoder H.264', cfg.h264Threads, threads, 'hilos',
    `${cores} núcleos y ${w.reencode} canal(es) re-codificando: más hilos por canal sólo añade contención.`);

  // ---- Log ---------------------------------------------------------------
  const logLevel = w.transcode >= 100 ? 'error' : 'warning';
  add('logLevel', 'ffmpeg_log_level', 'Registro de FFmpeg', cfg.logLevel, logLevel, '',
    w.transcode >= 100
      ? `${w.transcode} canales en el motor: 'error' evita millones de líneas de log y CPU de escritura.`
      : `Con ${w.transcode} canales, 'warning' sigue siendo útil y no pesa.`);

  // ---- Tailer HLS → TS ---------------------------------------------------
  add('tailerIntervalMs', 'ffmpeg_tailer_interval_ms', 'Intervalo del tailer', cfg.tailerIntervalMs, 160, 'ms',
    '160 ms detecta el segmento nuevo sin quemar CPU leyendo el manifiesto.');
  add('tailerBurst', 'ffmpeg_tailer_burst', 'Segmentos al conectar', cfg.tailerBurst, 2, 'segmentos',
    'Dos segmentos dan audio y vídeo inmediatos al entrar un cliente .ts.');

  // ---- Reserva de RAMDisk -------------------------------------------------
  // Se calcula sobre el tamaño real de /dev/shm, no sobre un número fijo.
  const shmBase = shm.exists ? shm.totalMb : ramMb;
  const reserve = Math.min(2048, Math.max(128, Math.round(shmBase * 0.1)));
  add('ramReserveMb', 'ffmpeg_ram_reserve_mb', 'Reserva de RAMDisk', cfg.ramReserveMb, reserve, 'MB',
    shm.exists
      ? `/dev/shm tiene ${shm.totalMb} MB: reservar ${reserve} MB (10 %) evita quedarse sin espacio y tumbar los canales.`
      : 'Sin /dev/shm: se calcula sobre la RAM total del equipo.');

  // ---- Prebuffer ----------------------------------------------------------
  // Prioridad del panel: que se VEA. Con 2 segmentos, el reproductor no recibe el
  // manifiesto hasta que la ventana tiene 4 s escritos, así arranca con imagen y
  // no con un segmento a medias. La espera está topada por waitMs: si el canal no
  // llega, se sirve lo que haya (nunca se queda esperando).
  add('prebufferSegments', 'ffmpeg_prebuffer_segments', 'Segmentos de prebuffer', cfg.prebufferSegments, 2, '',
    'Arranque estable: el reproductor recibe el manifiesto con 2 segmentos (4 s) ya escritos. Cuesta ~4 s sólo la primera sintonía de cada canal.');
  add('prebufferWaitMs', 'ffmpeg_prebuffer_wait_ms', 'Espera máxima del prebuffer', cfg.prebufferWaitMs, 6000, 'ms',
    'Tope de la espera anterior. Si el canal tarda más, se entrega lo que haya: nunca bloquea la reproducción.');

  // ---- Binario ------------------------------------------------------------
  if (isFfmpegAvailable()) {
    const info = getFfmpegBinInfo();
    add('binPreference', 'ffmpeg_bin_preference', 'Binario FFmpeg', cfg.binPreference, cfg.binPreference, '',
      `En uso: ${getFfmpegBin()}${info.version ? ` (${info.version})` : ''}. No se cambia automáticamente.`);
  } else {
    warnings.push('No hay ningún FFmpeg ejecutable: el panel está en Modo Direct Stream. Ejecuta `tvlister-admin ffmpeg import-xui` o `tvlister-admin ffmpeg install`.');
  }

  // ---- Avisos de capacidad -----------------------------------------------
  if (shm.exists && neededMb > 0) {
    if (shm.totalMb < neededMb * 1.2) {
      warnings.push(
        `El RAMDisk (${shm.totalMb} MB) queda justo para la ventana HLS del peor caso (${neededMb} MB). ` +
          `Los canales que no quepan se derivan a disco automáticamente; si quieres todos en RAM, sube /dev/shm a ${Math.ceil(neededMb * 1.5)} MB.`
      );
    }
    if (shm.freeMb < neededMb) {
      warnings.push(
        `Ahora mismo hay ${shm.freeMb} MB libres en /dev/shm y hacen falta ~${neededMb} MB: algunos canales escribirán en disco.`
      );
    }
  }
  if (ramMb > 0 && ramMb < 4096 && w.transcode > 60) {
    warnings.push(`${w.transcode} canales en el motor con ${ramMb} MB de RAM: mantén los perfiles en Copy/Copy y evita re-codificar.`);
  }
  if (w.reencode > 0 && cores > 0 && w.reencode > cores * 2) {
    warnings.push(`${w.reencode} canales re-codificando con ${cores} núcleos: no alcanza. Pasa esos canales a Copy/Copy o nivela sólo el audio.`);
  }
  if (w.total === 0) {
    warnings.push('Todavía no hay canales en el panel: la recomendación se ajustará cuando cargues tu lista.');
  }

  const changed = items.filter((i) => i.changed);
  return {
    hardware,
    workload: w,
    items,
    warnings,
    summary: {
      total: items.length,
      changed: changed.length,
      upToDate: changed.length === 0,
      profile:
        w.transcode >= 120
          ? 'Cabecera grande · Copy masivo'
          : w.transcode >= 30
          ? 'Cabecera mediana · Copy + audio nivelado'
          : w.transcode > 0
          ? 'Instalación pequeña'
          : 'Sin canales en el motor'
    }
  };
}

/** Escribe en `settings` los valores recomendados. Devuelve lo aplicado. */
export function applyRecommendation({ only = null } = {}) {
  const rec = computeRecommendation();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const applied = [];
  for (const item of rec.items) {
    if (only && !only.includes(item.key)) continue;
    if (!item.changed) continue;
    const raw =
      typeof item.recommended === 'boolean' ? (item.recommended ? 'true' : 'false') : String(item.recommended);
    upsert.run(item.settingKey, raw);
    applied.push({ key: item.settingKey, from: item.current, to: item.recommended });
  }
  return { applied, recommendation: rec };
}

export { FFMPEG_ENGINE_DEFAULTS };
