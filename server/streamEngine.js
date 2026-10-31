import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, withSqliteBusyRetry } from './db.js';
import { resolveFlussonicUrlCandidates } from './flussonicImporter.js';

// ============================================================================
// SOURCE ÚNICO POR CANAL
// ----------------------------------------------------------------------------
// No existe failover: el worker emite SIEMPRE `source_url`. Si el canal quiere
// otra fuente, el administrador la agrega a mano en ese canal y cambia a ella
// cuando lo decida (POST /api/streams/:id/switch-source). Nada se conecta solo
// ni se sondea por detrás.
// ============================================================================
export function resolveFfmpegCompatibleCandidates(rawUrl = '', backupUrl = '') {
  const out = [];
  const pushClean = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };

  for (const src of [rawUrl, backupUrl]) {
    const trimmed = String(src || '').trim();
    if (!trimmed) continue;
    if (/^mnfs?:\/\//i.test(trimmed)) {
      // TVLister MNF URLs: convert /mnf/<u>/<p>/<id>.mnf -> standard MPEG-TS /live/<u>/<p>/<id>.ts for FFmpeg
      const httpEquiv = trimmed
        .replace(/^mnf(s?):\/\//i, 'http$1://')
        .replace(/\/mnf\/([^/]+)\/([^/]+)\/(\d+)\.mnf\b/i, '/live/$1/$2/$3.ts');
      pushClean(httpEquiv);
      continue;
    }
    for (const cand of resolveFlussonicUrlCandidates(trimmed)) {
      pushClean(cand);
    }
  }
  return out.length > 0 ? out : [String(rawUrl || '').trim()];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = path.resolve(__dirname, '../streams_runtime');

export const DISK_HLS_ROOT = path.join(RUNTIME_DIR, 'hls');

// Ventana HLS real en el peor caso: si el origen (Flussonic) tiene GOP de 4 s,
// hls_time 2 termina produciendo segmentos de 4 s y hls_list_size 6 = 24 s de ventana.
export const HLS_WINDOW_SECONDS = 24;

/**
 * Estima cuánto espacio necesita el RAMDisk para TODOS los canales en transcodificación.
 * Se asume mínimo 6.5 Mbps por canal Copy (puede recibir HD de 8-12 Mbps del Flussonic origen),
 * porque quedarse sin espacio en tmpfs (ENOSPC) tumba los 145 canales de golpe.
 */
export function estimateHlsFootprintBytes() {
  try {
    const rows = db
      .prepare(
        `SELECT s.bitrate_kbps AS bitrate, p.video_codec AS vcodec
           FROM streams s
           LEFT JOIN transcode_profiles p ON p.id = s.transcode_profile_id
          WHERE s.stream_mode = 'transcode' AND s.status IN ('running', 'ondemand_idle')`
      )
      .all();
    let bitsPerSecond = 0;
    for (const r of rows) {
      const declared = Math.max(800, Number(r.bitrate) || 2500);
      const effective = r.vcodec === 'copy' ? Math.max(declared, 6500) : declared;
      bitsPerSecond += effective * 1000;
    }
    const windowBytes = Math.ceil((bitsPerSecond / 8) * HLS_WINDOW_SECONDS * 1.35);
    return windowBytes + 192 * 1024 * 1024;
  } catch {
    return 512 * 1024 * 1024;
  }
}

export function resolveOptimalHlsRoot() {
  if (process.env.HLS_DIR) return path.resolve(process.env.HLS_DIR);
  // Usa tmpfs (/dev/shm) sólo si hay espacio REAL para toda la ventana HLS de todos los canales.
  try {
    if (os.platform() === 'linux' && fs.existsSync('/dev/shm')) {
      const st = fs.statfsSync('/dev/shm');
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      const needed = estimateHlsFootprintBytes();
      if (freeBytes >= needed) {
        const shmDir = '/dev/shm/tvlister_hls';
        fs.mkdirSync(shmDir, { recursive: true });
        return shmDir;
      }
    }
  } catch {
    // fallback a disco
  }
  fs.mkdirSync(DISK_HLS_ROOT, { recursive: true });
  return DISK_HLS_ROOT;
}

export const HLS_ROOT = resolveOptimalHlsRoot();
export const HLS_IS_RAMDISK = HLS_ROOT.startsWith('/dev/shm');
export const PLAYLIST_ROOT = path.join(RUNTIME_DIR, 'playlists');
export const ARCHIVE_ROOT = path.join(RUNTIME_DIR, 'archive');

let hlsFreeCache = { value: -1, at: 0 };

export function getHlsFreeBytes() {
  const now = Date.now();
  if (now - hlsFreeCache.at < 2000) return hlsFreeCache.value;
  try {
    const st = fs.statfsSync(HLS_ROOT);
    hlsFreeCache = { value: Number(st.bavail) * Number(st.bsize), at: now };
  } catch {
    hlsFreeCache = { value: 0, at: now };
  }
  return hlsFreeCache.value;
}

/**
 * Directorio HLS real de un canal. Si el RAMDisk se está quedando sin espacio
 * (ENOSPC tumbaba canales en producción) ese canal pasa automáticamente a disco.
 */
export function resolveHlsDirForKey(key) {
  const safeKey = path.basename(String(key));
  if (HLS_IS_RAMDISK && getHlsFreeBytes() < getFfmpegEngineConfig().ramReserveMb * 1024 * 1024) {
    fs.mkdirSync(DISK_HLS_ROOT, { recursive: true });
    return path.join(DISK_HLS_ROOT, safeKey);
  }
  return path.join(HLS_ROOT, safeKey);
}

let ffmpegAvailableCache = null;
let resolvedFfmpegBin = null;
let resolvedFfmpegPref = null;
let ffmpegProbeCache = { list: null, expiresAt: 0 };

// Map<key, { child, timer, stoppedManually, pid }>
const workers = new Map();

/**
 * Registro de binarios FFmpeg — paridad con XUI.one.
 * XUI.one instala TRES compilaciones y elige según el ajuste "ffmpeg_cpu":
 *   4.4 (por defecto), 4.3 y 4.0 (esta última se usa para GPU/NVENC y para
 *   fuentes con audio AC3/DTS heredado). Sus binarios viven en
 *   /home/xui/bin/ffmpeg_bin/<versión>/ffmpeg.
 * TVLister los reutiliza tal cual (zero-apt, nada que descargar) y permite
 * fijar cuál usar sin tocar la línea de argumentos del motor.
 */
export const FFMPEG_BIN_CHOICES = [
  {
    id: 'env',
    label: 'Variable FFMPEG_PATH',
    group: 'tvlister',
    hint: 'Ruta forzada por la variable de entorno FFMPEG_PATH del servicio.',
    path: () => (process.env.FFMPEG_PATH ? String(process.env.FFMPEG_PATH) : '')
  },
  {
    id: 'runtime',
    label: 'TVLister .runtime',
    group: 'tvlister',
    hint: 'Binario estático descargado por tvlister-admin ffmpeg install (zero-apt).',
    path: () => path.join(process.env.APP_DIR || '/opt/tvlister24-7', '.runtime/bin/ffmpeg')
  },
  {
    id: 'xui44',
    label: 'XUI.one · FFmpeg 4.4',
    group: 'xui',
    hint: 'Compilación por defecto de XUI.one (module ffmpeg_cpu=4.4).',
    path: () => '/home/xui/bin/ffmpeg_bin/4.4/ffmpeg'
  },
  {
    id: 'xui43',
    label: 'XUI.one · FFmpeg 4.3',
    group: 'xui',
    hint: 'Respaldo intermedio de XUI.one (module ffmpeg_cpu=4.3).',
    path: () => '/home/xui/bin/ffmpeg_bin/4.3/ffmpeg'
  },
  {
    id: 'xui40',
    label: 'XUI.one · FFmpeg 4.0 (GPU / AC3-DTS)',
    group: 'xui',
    hint: 'La versión que XUI.one fuerza con NVENC/GPU y con audio AC3/DTS heredado.',
    path: () => '/home/xui/bin/ffmpeg_bin/4.0/ffmpeg'
  },
  {
    id: 'xuilegacy',
    label: 'XUI.one · bin/ffmpeg',
    group: 'xui',
    hint: 'Instalaciones antiguas de XUI.one que no usan ffmpeg_bin/<versión>.',
    path: () => '/home/xui/bin/ffmpeg/ffmpeg'
  },
  {
    id: 'bundled',
    label: 'Incluido en TVLister',
    group: 'tvlister',
    hint: 'Copia empaquetada en node_modules (@ffmpeg-installer) como último recurso.',
    path: () => path.resolve(process.cwd(), 'node_modules/@ffmpeg-installer/linux-x64/ffmpeg')
  },
  {
    id: 'system',
    label: 'FFmpeg del sistema (PATH)',
    group: 'system',
    hint: 'El "ffmpeg" que esté en el PATH del servicio.',
    path: () => 'ffmpeg'
  }
];

/** Orden de auto-detección: idéntico al histórico para no cambiar el binario en caliente. */
const FFMPEG_AUTO_ORDER = ['env', 'runtime', 'xui44', 'xui43', 'xui40', 'xuilegacy', 'bundled', 'system'];

function ffmpegChoiceById(id) {
  return FFMPEG_BIN_CHOICES.find((c) => c.id === id) || null;
}

/** Variables de entorno que necesitan los binarios de XUI.one (libs propias). */
export function ffmpegEnvFor(bin = '') {
  // Librerías propias del panel: el binario copiado desde XUI.one vive en
  // .runtime/bin y sus .so en .runtime/lib (tvlister-admin ffmpeg import-xui).
  const runtimeLib = path.join(process.env.APP_DIR || '/opt/tvlister24-7', '.runtime/lib');
  if (String(bin).startsWith('/home/xui/')) {
    const libDirs = ['/home/xui/bin/ffmpeg', '/home/xui/lib'];
    const versionDir = path.dirname(String(bin));
    if (versionDir.startsWith('/home/xui/')) libDirs.unshift(versionDir);
    return {
      ...process.env,
      LD_LIBRARY_PATH: `${libDirs.join(':')}:${runtimeLib}:${process.env.LD_LIBRARY_PATH || ''}`
    };
  }
  if (String(bin).includes(`${path.sep}.runtime${path.sep}`) && fs.existsSync(runtimeLib)) {
    return {
      ...process.env,
      LD_LIBRARY_PATH: `${runtimeLib}:${process.env.LD_LIBRARY_PATH || ''}`
    };
  }
  return process.env;
}

/** Ejecuta `<bin> -version` y devuelve versión + build (o el motivo del fallo). */
export function probeFfmpegBinary(bin) {
  const out = { ok: false, version: null, build: null, error: null };
  if (!bin) {
    out.error = 'Ruta vacía';
    return out;
  }
  try {
    if (bin.startsWith('/') && (!fs.existsSync(bin) || fs.statSync(bin).isDirectory())) {
      out.error = 'No existe';
      return out;
    }
    const txt = execFileSync(bin, ['-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: ffmpegEnvFor(bin),
      timeout: 5000,
      maxBuffer: 1024 * 1024
    }).toString('utf8');
    const first = txt.split(/\r?\n/)[0] || '';
    out.version = (first.match(/ffmpeg version (\S+)/i) || [])[1] || first.slice(0, 64) || 'desconocida';
    out.build = (txt.match(/configuration:(.*)/i) || [])[1]?.trim().slice(0, 240) || null;
    out.ok = true;
    return out;
  } catch (err) {
    out.error = err?.status === 127 ? 'No ejecutable' : 'No responde a -version';
    return out;
  }
}

/**
 * Lista todos los binarios conocidos con su estado real (versión incluida).
 * Se cachea 60 s: sólo se ejecuta al abrir la sección "Motor FFmpeg" o al
 * resolver el binario por primera vez.
 */
export function detectFfmpegBinaries({ force = false } = {}) {
  const now = Date.now();
  if (!force && ffmpegProbeCache.list && now < ffmpegProbeCache.expiresAt) {
    return ffmpegProbeCache.list;
  }
  const list = FFMPEG_BIN_CHOICES.map((choice) => {
    const binPath = choice.path();
    let sizeMb = null;
    if (binPath && binPath.startsWith('/')) {
      try {
        sizeMb = Number((fs.statSync(binPath).size / (1024 * 1024)).toFixed(1));
      } catch {
        sizeMb = null;
      }
    }
    const probe = probeFfmpegBinary(binPath);
    return {
      id: choice.id,
      label: choice.label,
      group: choice.group,
      hint: choice.hint,
      path: binPath,
      exists: Boolean(binPath) && (!binPath.startsWith('/') || fs.existsSync(binPath)),
      sizeMb,
      ok: probe.ok,
      version: probe.version,
      error: probe.error
    };
  });
  ffmpegProbeCache = { list, expiresAt: now + 60_000 };
  return list;
}

export function invalidateFfmpegBinCache(scan = true) {
  resolvedFfmpegBin = null;
  resolvedFfmpegPref = null;
  ffmpegAvailableCache = null;
  ffmpegPrefCache = { value: null, expiresAt: 0 };
  if (scan) detectFfmpegBinaries({ force: true });
}

let ffmpegPrefCache = { value: null, expiresAt: 0 };

/**
 * Preferencia guardada: 'auto' o el id de FFMPEG_BIN_CHOICES.
 * Se cachea 3 s: getFfmpegBin() se llama en cada arranque de worker y no debe
 * consultar SQLite 145 veces durante un reinicio escalonado.
 */
export function getFfmpegBinPreference() {
  const now = Date.now();
  if (ffmpegPrefCache.value !== null && now < ffmpegPrefCache.expiresAt) {
    return ffmpegPrefCache.value;
  }
  let value = 'auto';
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ffmpeg_bin_preference'").get();
    value = String(row?.value || 'auto').trim() || 'auto';
  } catch {
    value = 'auto';
  }
  ffmpegPrefCache = { value, expiresAt: now + 3000 };
  return value;
}

export function isValidFfmpegPreference(value) {
  const v = String(value || '').trim();
  return v === 'auto' || Boolean(ffmpegChoiceById(v));
}

/**
 * Resuelve el binario a ejecutar. Con 'auto' mantiene exactamente el mismo
 * orden histórico (runtime → XUI → empaquetado → PATH) para no cambiar de
 * binario en producción sin que el administrador lo pida.
 */
export function getFfmpegBin() {
  const pref = getFfmpegBinPreference();
  if (resolvedFfmpegBin && resolvedFfmpegPref === pref) return resolvedFfmpegBin;

  const candidates = [];
  if (pref !== 'auto') {
    const chosen = ffmpegChoiceById(pref);
    if (chosen) candidates.push(chosen.id);
  }
  for (const id of FFMPEG_AUTO_ORDER) {
    if (!candidates.includes(id)) candidates.push(id);
  }

  const detected = new Map(detectFfmpegBinaries().map((b) => [b.id, b]));
  for (const id of candidates) {
    const info = detected.get(id);
    if (info?.ok && info.path) {
      resolvedFfmpegBin = info.path;
      resolvedFfmpegPref = pref;
      ffmpegAvailableCache = true;
      return resolvedFfmpegBin;
    }
  }
  resolvedFfmpegPref = pref;
  ffmpegAvailableCache = false;
  return 'ffmpeg';
}

/** Datos para el panel: binario en uso, versión, preferencia y alternativas. */
export function getFfmpegBinInfo() {
  const bin = getFfmpegBin();
  const preference = getFfmpegBinPreference();
  const binaries = detectFfmpegBinaries();
  const inUse = binaries.find((b) => b.path === bin) || null;
  const xuiInstalled = binaries.filter((b) => b.group === 'xui' && b.ok).length;
  return {
    bin,
    preference,
    inUseId: inUse?.id || null,
    label: inUse?.label || 'No detectado',
    version: inUse?.version || null,
    available: Boolean(ffmpegAvailableCache),
    xuiInstalled,
    xuiPath: '/home/xui/bin/ffmpeg_bin',
    xuiPresent: fs.existsSync('/home/xui/bin/ffmpeg_bin') || fs.existsSync('/home/xui'),
    alternatives: binaries.filter((b) => b.ok).length,
    binaries
  };
}

export function isFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  getFfmpegBin();
  return Boolean(ffmpegAvailableCache);
}

export function getActiveWorkerCount() {
  return workers.size;
}

export function getWorkerPid(key) {
  return workers.get(key)?.pid || null;
}

export function getLocalHlsManifestPath(key) {
  for (const base of [resolveHlsDirForKey(key), path.join(DISK_HLS_ROOT, path.basename(key))]) {
    const manifest = path.join(base, 'index.m3u8');
    if (fs.existsSync(manifest)) return manifest;
  }
  return null;
}

export function getFreshLocalHlsManifestPath(key, maxAgeSec = 18) {
  for (const base of [resolveHlsDirForKey(key), path.join(DISK_HLS_ROOT, path.basename(key))]) {
    const manifest = path.join(base, 'index.m3u8');
    try {
      if (!fs.existsSync(manifest)) continue;
      const st = fs.statSync(manifest);
      if (Date.now() - st.mtimeMs > maxAgeSec * 1000) continue;
      return manifest;
    } catch {
      // sigue con la otra ruta
    }
  }
  return null;
}

export function cleanupStreamRuntime(streamId) {
  const dirs = [
    resolveHlsDirForKey(`stream_${streamId}`),
    path.join(DISK_HLS_ROOT, `stream_${streamId}`),
    path.join(HLS_ROOT, `stream_${streamId}`),
    path.join(ARCHIVE_ROOT, `stream_${streamId}`)
  ];
  for (const d of dirs) {
    try {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function getHostTelemetry() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg1m = os.loadavg()[0] || 0;
  const cpuCount = Math.max(cpus.length, 1);
  const cpuPercent = Math.min(99.9, Math.max(1.5, Number(((loadAvg1m / cpuCount) * 100).toFixed(1))));
  const ramPercent = Number(((usedMem / totalMem) * 100).toFixed(1));

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    cpuCores: cpuCount,
    cpuModel: cpus[0]?.model || 'Server vCPU',
    cpuPercent,
    ramPercent,
    ramUsedGb: Number((usedMem / 1024 ** 3).toFixed(2)),
    ramTotalGb: Number((totalMem / 1024 ** 3).toFixed(2)),
    uptimeSeconds: Math.floor(os.uptime()),
    ffmpegInstalled: isFfmpegAvailable(),
    ffmpegBin: isFfmpegAvailable() ? getFfmpegBin() : 'No detectado (Modo Direct Stream)',
    ffmpegWorkers: workers.size,
    hlsRamdisk: HLS_IS_RAMDISK,
    hlsRoot: HLS_ROOT,
    xuiCoexistence: fs.existsSync('/home/xui')
  };
}

export function parsePlaylist(playlistJson) {
  try {
    const arr = typeof playlistJson === 'string' ? JSON.parse(playlistJson) : playlistJson;
    if (!Array.isArray(arr)) return [];
    return arr.map((item, idx) => ({
      id: item.id || `clip-${idx + 1}`,
      vod_id: item.vod_id || null,
      title: item.title || `Programa #${idx + 1}`,
      url: item.url || '',
      duration_sec: Math.max(10, Number(item.duration_sec) || 600)
    }));
  } catch {
    return [];
  }
}

export function computeChannel247LiveState(channel, nowMs = Date.now()) {
  const playlist = parsePlaylist(channel.playlist_json);
  if (playlist.length === 0) {
    return {
      isPlaying: false,
      totalDurationSec: 0,
      currentItem: null,
      nextItem: null,
      seekOffsetSec: 0,
      remainingSec: 0,
      progressPct: 0,
      schedule: []
    };
  }

  const totalDurationSec = playlist.reduce((acc, item) => acc + item.duration_sec, 0);
  const nowSec = Math.floor(nowMs / 1000);
  const anchor = Number(channel.schedule_anchor_epoch) || 1704067200;
  const cyclePos = (((nowSec - anchor) % totalDurationSec) + totalDurationSec) % totalDurationSec;

  let accumulated = 0;
  let currentIndex = 0;
  let seekOffsetSec = 0;

  for (let i = 0; i < playlist.length; i++) {
    const dur = playlist[i].duration_sec;
    if (cyclePos < accumulated + dur) {
      currentIndex = i;
      seekOffsetSec = cyclePos - accumulated;
      break;
    }
    accumulated += dur;
  }

  const currentItem = playlist[currentIndex];
  const nextIndex = (currentIndex + 1) % playlist.length;
  const nextItem = playlist[nextIndex];
  const remainingSec = Math.max(0, currentItem.duration_sec - seekOffsetSec);
  const progressPct = Math.min(100, Number(((seekOffsetSec / currentItem.duration_sec) * 100).toFixed(1)));

  const currentStartEpoch = nowSec - seekOffsetSec;
  const schedule = [];
  let cursorEpoch = currentStartEpoch;
  const slotsCount = Math.min(24, Math.max(8, playlist.length * 3));

  for (let s = 0; s < slotsCount; s++) {
    const idx = (currentIndex + s) % playlist.length;
    const item = playlist[idx];
    const endEpoch = cursorEpoch + item.duration_sec;
    schedule.push({
      slot: s,
      title: item.title,
      url: item.url,
      duration_sec: item.duration_sec,
      start_epoch: cursorEpoch,
      end_epoch: endEpoch,
      start_iso: new Date(cursorEpoch * 1000).toISOString(),
      end_iso: new Date(endEpoch * 1000).toISOString(),
      is_current: s === 0
    });
    cursorEpoch = endEpoch;
  }

  return {
    isPlaying: channel.status === 'running',
    totalDurationSec,
    playlistCount: playlist.length,
    currentIndex,
    currentItem,
    nextItem,
    seekOffsetSec,
    remainingSec,
    progressPct,
    schedule
  };
}

function splitExtraFlags(rawFlags = '') {
  return String(rawFlags || '')
    .trim()
    .split(/\s+/)
    .filter(
      (tok) =>
        Boolean(tok) &&
        tok !== '-no_resample' &&
        tok !== '-ram_mpegts_only' &&
        tok !== '-tee_mpegts_pipe'
    );
}

let audioLevelingCache = { value: null, expiresAt: 0 };

export function invalidateAudioLevelingCache() {
  audioLevelingCache = { value: null, expiresAt: 0 };
}

export function getGlobalAudioLevelingConfig() {
  const now = Date.now();
  if (audioLevelingCache.value && now < audioLevelingCache.expiresAt) {
    return audioLevelingCache.value;
  }
  try {
    const rows = db
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('audio_leveling_enabled', 'audio_leveling_preset', 'audio_leveling_bitrate')"
      )
      .all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const cfg = {
      enabled: map.audio_leveling_enabled === 'true',
      preset: map.audio_leveling_preset || 'standard',
      bitrate: map.audio_leveling_bitrate || '128k'
    };
    audioLevelingCache = { value: cfg, expiresAt: now + 3000 };
    return cfg;
  } catch {
    return { enabled: false, preset: 'standard', bitrate: '128k' };
  }
}

let efficiencyCache = { value: null, expiresAt: 0 };

export function invalidateFfmpegEfficiencyCache() {
  efficiencyCache = { value: null, expiresAt: 0 };
}

/**
 * Global FFmpeg efficiency policy (editables desde Servidores -> Optimización FFmpeg):
 *  - tsPipeMode 'auto'   : -f tee (HLS + pipe:1) SOLO en canales troncales Flussonic (necesitan MPEG-TS continuo)
 *  - tsPipeMode 'always' : -f tee en TODOS los canales (máxima compatibilidad .ts / tshttp://, +CPU por doble muxer)
 *  - tsPipeMode 'never'  : 100% HLS nativo en RAMDisk y stdout cerrado (máximo ahorro de CPU y RAM por canal)
 *  - h264Threads         : tope de hilos por encoder libx264 (evita 24-72 hilos por canal en servidores multi-core)
 */
export const FFMPEG_ENGINE_DEFAULTS = {
  tsPipeMode: 'auto',
  h264Threads: 2,
  // Sonda de entrada: HTTP/HLS necesita margen para no perder SPS/PPS en HD 8-12 Mbps
  probeHttp: 5000000,
  analyzeHttp: 4000000,
  // Fuentes locales (UDP/RTMP/archivo): arranque rápido
  probeLocal: 1500000,
  analyzeLocal: 1500000,
  // Ventana HLS en RAMDisk
  hlsTime: 2,
  hlsListSize: 6,
  // Nivel de log de FFmpeg ('warning' = diagnóstico, 'error' = mínimo ruido con 200+ canales)
  logLevel: 'warning',
  // Reserva mínima del RAMDisk antes de derivar canales a disco (MB)
  ramReserveMb: 384,
  // Tailer HLS -> MPEG-TS
  tailerIntervalMs: 160,
  tailerBurst: 2,
  // Los clientes .ts entran en la frontera de segmento (PAT/PMT primero)
  tsJoinOnSegment: true,
  // Prebuffer de entrega (equivalente al X-XUI-Prebuffer de XUI.one).
  // 0 = apagado: se sirve el manifiesto tal cual llega, comportamiento validado.
  prebufferSegments: 0,
  prebufferWaitMs: 3000,
  // Binario FFmpeg elegido ('auto' = orden histórico del motor)
  binPreference: 'auto',
  // Afinado HLS con el juego de opciones de XUI.one (analizado en su código):
  //   off  -> línea original, byte a byte (comportamiento validado)
  //   safe -> sólo lo que no puede romper: -individual_header_trailer 0,
  //           -hls_delete_threshold, discont_start y -err_detect ignore_err
  //   full -> el juego completo de XUI.one (incluye su bloque de timestamps)
  hlsXuiMode: 'off'
};

export const FFMPEG_HLS_XUI_MODES = ['off', 'safe', 'full'];

export const FFMPEG_ENGINE_LIMITS = {
  h264Threads: [1, 16],
  probeHttp: [1000000, 20000000],
  analyzeHttp: [1000000, 20000000],
  probeLocal: [200000, 8000000],
  analyzeLocal: [200000, 8000000],
  hlsTime: [1, 10],
  hlsListSize: [3, 12],
  ramReserveMb: [64, 4096],
  tailerIntervalMs: [80, 500],
  tailerBurst: [1, 4],
  prebufferSegments: [0, 6],
  prebufferWaitMs: [500, 15000]
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Configuración completa del motor FFmpeg de TVLister (editable en la sección
 * "Motor FFmpeg" del panel). Se cachea 3 s para no consultar SQLite por cada worker.
 */
export function getFfmpegEngineConfig() {
  const now = Date.now();
  if (efficiencyCache.value && now < efficiencyCache.expiresAt) {
    return efficiencyCache.value;
  }
  const d = FFMPEG_ENGINE_DEFAULTS;
  const L = FFMPEG_ENGINE_LIMITS;
  let map = {};
  try {
    const rows = db
      .prepare(
        `SELECT key, value FROM settings WHERE key IN (
           'ffmpeg_ts_pipe_mode','ffmpeg_h264_threads','ffmpeg_probe_http','ffmpeg_analyze_http',
           'ffmpeg_probe_local','ffmpeg_analyze_local','ffmpeg_hls_time','ffmpeg_hls_list_size','ffmpeg_hls_xui',
           'ffmpeg_log_level','ffmpeg_ram_reserve_mb','ffmpeg_tailer_interval_ms','ffmpeg_tailer_burst',
           'ffmpeg_ts_join_segment','ffmpeg_prebuffer_segments','ffmpeg_prebuffer_wait_ms',
           'ffmpeg_bin_preference'
         )`
      )
      .all();
    map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    map = {};
  }

  const cfg = {
    tsPipeMode: ['auto', 'always', 'never'].includes(map.ffmpeg_ts_pipe_mode)
      ? map.ffmpeg_ts_pipe_mode
      : d.tsPipeMode,
    h264Threads: clampInt(map.ffmpeg_h264_threads, L.h264Threads[0], L.h264Threads[1], d.h264Threads),
    probeHttp: clampInt(map.ffmpeg_probe_http, L.probeHttp[0], L.probeHttp[1], d.probeHttp),
    analyzeHttp: clampInt(map.ffmpeg_analyze_http, L.analyzeHttp[0], L.analyzeHttp[1], d.analyzeHttp),
    probeLocal: clampInt(map.ffmpeg_probe_local, L.probeLocal[0], L.probeLocal[1], d.probeLocal),
    analyzeLocal: clampInt(map.ffmpeg_analyze_local, L.analyzeLocal[0], L.analyzeLocal[1], d.analyzeLocal),
    hlsTime: clampInt(map.ffmpeg_hls_time, L.hlsTime[0], L.hlsTime[1], d.hlsTime),
    hlsXuiMode: FFMPEG_HLS_XUI_MODES.includes(map.ffmpeg_hls_xui) ? map.ffmpeg_hls_xui : d.hlsXuiMode,
    hlsListSize: clampInt(map.ffmpeg_hls_list_size, L.hlsListSize[0], L.hlsListSize[1], d.hlsListSize),
    logLevel: ['warning', 'error'].includes(map.ffmpeg_log_level) ? map.ffmpeg_log_level : d.logLevel,
    ramReserveMb: clampInt(map.ffmpeg_ram_reserve_mb, L.ramReserveMb[0], L.ramReserveMb[1], d.ramReserveMb),
    tailerIntervalMs: clampInt(
      map.ffmpeg_tailer_interval_ms,
      L.tailerIntervalMs[0],
      L.tailerIntervalMs[1],
      d.tailerIntervalMs
    ),
    tailerBurst: clampInt(map.ffmpeg_tailer_burst, L.tailerBurst[0], L.tailerBurst[1], d.tailerBurst),
    tsJoinOnSegment:
      map.ffmpeg_ts_join_segment === undefined || map.ffmpeg_ts_join_segment === ''
        ? d.tsJoinOnSegment
        : String(map.ffmpeg_ts_join_segment) === 'true',
    prebufferSegments: clampInt(
      map.ffmpeg_prebuffer_segments,
      L.prebufferSegments[0],
      L.prebufferSegments[1],
      d.prebufferSegments
    ),
    prebufferWaitMs: clampInt(
      map.ffmpeg_prebuffer_wait_ms,
      L.prebufferWaitMs[0],
      L.prebufferWaitMs[1],
      d.prebufferWaitMs
    ),
    binPreference: isValidFfmpegPreference(map.ffmpeg_bin_preference)
      ? String(map.ffmpeg_bin_preference)
      : d.binPreference
  };

  efficiencyCache = { value: cfg, expiresAt: now + 3000 };
  return cfg;
}

// Compatibilidad: el resto del código sigue llamando a "efficiency"
export function getFfmpegEfficiencyConfig() {
  return getFfmpegEngineConfig();
}

/** Presets del motor (los aplica la API; aquí sólo viven los valores). */
export const FFMPEG_ENGINE_PRESETS = {
  estabilidad: {
    // Prioridad: que se VEA. El reproductor no recibe el manifiesto hasta que la
    // ventana tiene 2 segmentos (4 s) ya escritos, y el tailer MPEG-TS arranca
    // con la misma ráfaga. Cuesta ~4 s en el primer arranque de cada canal y no
    // toca la línea de argumentos de FFmpeg (todo es entrega/lectura).
    label: 'Máxima estabilidad · con prebuffer',
    values: {
      tsPipeMode: 'auto',
      h264Threads: 2,
      hlsTime: 2,
      hlsListSize: 6,
      logLevel: 'warning',
      tailerIntervalMs: 160,
      tailerBurst: 2,
      tsJoinOnSegment: true,
      prebufferSegments: 2,
      prebufferWaitMs: 6000
    }
  },
  masivo: {
    label: '200+ canales · ahorro extremo',
    values: {
      tsPipeMode: 'never',
      h264Threads: 1,
      probeHttp: 5000000,
      analyzeHttp: 4000000,
      hlsTime: 2,
      hlsListSize: 6,
      logLevel: 'error',
      tailerIntervalMs: 200,
      tailerBurst: 2,
      tsJoinOnSegment: true
    }
  },
  equilibrado: {
    label: 'Equilibrado (recomendado)',
    values: {
      tsPipeMode: 'auto',
      h264Threads: 2,
      probeHttp: 5000000,
      analyzeHttp: 4000000,
      hlsTime: 2,
      hlsListSize: 6,
      logLevel: 'warning',
      tailerIntervalMs: 160,
      tailerBurst: 2,
      tsJoinOnSegment: true
    }
  },
  calidad: {
    label: 'Máxima calidad',
    values: {
      tsPipeMode: 'auto',
      h264Threads: 4,
      hlsTime: 4,
      hlsListSize: 6,
      logLevel: 'warning',
      tailerIntervalMs: 160,
      tailerBurst: 2,
      tsJoinOnSegment: true
    }
  },
  latencia: {
    label: 'Baja latencia',
    values: {
      tsPipeMode: 'auto',
      h264Threads: 2,
      hlsTime: 1,
      hlsListSize: 4,
      logLevel: 'warning',
      tailerIntervalMs: 100,
      tailerBurst: 1,
      tsJoinOnSegment: true
    }
  }
};

export function buildAudioLevelingFilter(preset = 'standard', ultraLightNoResample = false) {
  if (ultraLightNoResample || preset === 'ultra_200ch') {
    // High-density 200+ channel headend curve: coupled stereo (n=0 = 50% less DSP + stable L/R image),
    // 250ms frame window, and lightweight 8-tap PTS drift guard WITHOUT sample-rate conversion!
    return 'aresample=async=1:first_pts=0:filter_size=8,dynaudnorm=f=250:g=11:p=0.90:m=10:r=0.22:n=0:b=1';
  }
  if (preset === 'voice') {
    // Boosts quiet commentators/dialogue and clamps loud commercials (coupled stereo n=0)
    return 'aresample=async=1:first_pts=0,dynaudnorm=f=150:g=11:p=0.93:m=14:r=0.26:n=0:b=1';
  }
  if (preset === 'cinema') {
    // Gentle cinema curve with smooth envelope
    return 'aresample=async=1:first_pts=0,dynaudnorm=f=200:g=17:p=0.88:m=7:r=0.18:n=0:b=1';
  }
  // Standard broadcast TV loudness target (-13 dBFS RMS, -0.9 dBFS peak ceiling, coupled stereo n=0)
  return 'aresample=async=1:first_pts=0,dynaudnorm=f=150:g=13:p=0.90:m=10:r=0.22:n=0:b=1';
}

export function isStreamAudioLeveled(stream, profile) {
  const mode = stream?.audio_leveling_mode || 'global';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (/audio nivelado/i.test(String(profile?.name || ''))) return true;
  return getGlobalAudioLevelingConfig().enabled;
}

/**
 * Juego de flags HLS según el modo de afinado (referencia: el código de XUI.one).
 *   off  -> la línea original del panel, sin un solo token extra
 *   safe -> original + lo que XUI.one añade y aquí es seguro
 *   full -> el juego completo de XUI.one
 * Es una función pura: la usan el motor y `tvlister-admin hls status` para que
 * lo que se muestra en consola sea exactamente lo que se ejecuta.
 */
export function resolveHlsXuiTokens(mode, isZeroLatency = false) {
  const baseFlags = isZeroLatency
    ? 'delete_segments+independent_segments+omit_endlist'
    : 'delete_segments+append_list+omit_endlist';

  if (mode === 'safe') {
    return {
      flags: isZeroLatency
        ? 'delete_segments+independent_segments+discont_start+omit_endlist'
        : 'delete_segments+discont_start+omit_endlist',
      extra: ['-individual_header_trailer', '0', '-hls_delete_threshold', '2'],
      errDetect: true,
      readNative: false
    };
  }
  if (mode === 'full') {
    return {
      flags: 'delete_segments+discont_start+omit_endlist',
      extra: [
        '-individual_header_trailer', '0',
        '-hls_delete_threshold', '2',
        '-hls_segment_type', 'mpegts'
      ],
      errDetect: true,
      readNative: true
    };
  }
  return { flags: baseFlags, extra: [], errDetect: false, readNative: false };
}

export function buildFfmpegArgsForStream(stream, profile, attemptIndex = 0) {
  const candidates = resolveFfmpegCompatibleCandidates(stream.source_url);
  const inputUrl = candidates[Math.max(0, Number(attemptIndex) || 0) % candidates.length] || stream.source_url;

  const globalAudio = getGlobalAudioLevelingConfig();
  const levelAudio = isStreamAudioLeveled(stream, profile);

  const vCodec = profile?.video_codec || 'copy';
  const rawACodec = profile?.audio_codec || 'copy';
  const aCodec = levelAudio && (rawACodec === 'copy' || !rawACodec) ? 'aac' : rawACodec;
  const extraStr = String(profile?.extra_flags || '');
  const isCopyRemux = vCodec === 'copy';
  const isPureCopy = isCopyRemux && aCodec === 'copy' && !levelAudio;
  const isZeroLatency =
    isCopyRemux ||
    /zerolatency|low[-_ ]?latency|nobuffer/i.test(extraStr) ||
    /zero[-_ ]?latency|low[-_ ]?latency|copy\/copy|2\.5\s*mbps/i.test(String(profile?.name || ''));

  const noResample =
    extraStr.includes('-no_resample') || globalAudio.preset === 'ultra_200ch';
  const ramMpegTsOnly = extraStr.includes('-ram_mpegts_only');
  const efficiency = getFfmpegEfficiencyConfig();
  const dualTeeTsPipe =
    !ramMpegTsOnly &&
    (efficiency.tsPipeMode === 'always' ||
      (efficiency.tsPipeMode === 'auto' &&
        (extraStr.includes('-tee_mpegts_pipe') || Boolean(stream?.flussonic_pushed_at))));

  const outDir = resolveHlsDirForKey(`stream_${stream.id}`);
  if (!ramMpegTsOnly) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // -nostdin avoids TTY polling; el nivel de log se ajusta en Motor FFmpeg (warning = diagnóstico, error = mínimo ruido)
  const args = ['-nostdin', '-hide_banner', '-loglevel', efficiency.logLevel || 'warning', '-y'];

  const hasCustomThreads = /(?:^|\s)-threads\s+\d+/.test(extraStr);
  const hasCpuVideoScale =
    !isCopyRemux &&
    ((profile?.resolution && profile.resolution !== 'source') || /-vf\b/.test(extraStr) || /-s\b/.test(extraStr));

  // Fuentes HTTP/HLS (Flussonic) necesitan sonda amplia para HD: con 1 MB FFmpeg pierde el SPS/PPS
  // del primer segmento en canales de 8-12 Mbps y arranca tarde o entrecortado.
  const isHttpInput = /^https?:\/\//i.test(inputUrl);
  // XUI.one aplica -re a las fuentes en vivo ({READ_NATIVE}) para que el muxer
  // no vacíe el búfer de golpe. Sólo tiene sentido con fuentes reales.
  const isLiveInput = isHttpInput || /^(udp|rtp|rtmp|mnf|m4f)/i.test(inputUrl);
  const probeSize = String(isHttpInput ? efficiency.probeHttp : efficiency.probeLocal);
  const analyzeDuration = String(isHttpInput ? efficiency.analyzeHttp : efficiency.analyzeLocal);
  // -avoid_negative_ts sólo cuando emitimos MPEG-TS continuo (pipe), no en HLS puro (evita micro-saltos de PTS)
  const needTsContinuity = ramMpegTsOnly || dualTeeTsPipe;

  // XUI.one pone -err_detect ignore_err en la entrada: un paquete corrupto del
  // origen no debe tumbar el canal (se descarta y se sigue).
  if (efficiency.hlsXuiMode && efficiency.hlsXuiMode !== 'off') {
    args.push('-err_detect', 'ignore_err');
  }
  // -re sólo en modo 'full': es lo que usa XUI.one ({READ_NATIVE}) para que el
  // muxer no vacíe el búfer de golpe, pero también añade latencia al arranque.
  if (efficiency.hlsXuiMode === 'full' && isLiveInput && !ramMpegTsOnly) {
    args.push('-re');
  }

  if (isPureCopy) {
    // Copy/Copy Zero-CPU: 1 hilo OS, sin re-encode (14-16 MB RSS por canal)
    if (!hasCustomThreads) args.push('-threads', '1');
    args.push('-probesize', probeSize, '-analyzeduration', analyzeDuration);
    args.push('-fflags', '+genpts+igndts+nobuffer+discardcorrupt', '-flags', 'low_delay');
    if (needTsContinuity) args.push('-avoid_negative_ts', 'make_zero');
  } else if (isCopyRemux) {
    // Copy Video + Audio encode/level: 1 worker thread + 1 audio filter thread
    if (!hasCustomThreads) args.push('-threads', '1');
    args.push(
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      '-probesize',
      probeSize,
      '-analyzeduration',
      analyzeDuration,
      '-fflags',
      '+genpts+igndts+nobuffer+discardcorrupt',
      '-flags',
      'low_delay'
    );
    if (needTsContinuity) args.push('-avoid_negative_ts', 'make_zero');
  } else {
    if (profile?.hwaccel === 'nvenc' || vCodec.includes('nvenc')) {
      if (!hasCustomThreads) args.push('-threads', '1');
      args.push('-hwaccel', 'cuda');
      if (!hasCpuVideoScale) args.push('-hwaccel_output_format', 'cuda');
    } else if (profile?.hwaccel === 'qsv' || vCodec.includes('qsv')) {
      if (!hasCustomThreads) args.push('-threads', '1');
      args.push('-hwaccel', 'qsv');
      if (!hasCpuVideoScale) args.push('-hwaccel_output_format', 'qsv');
    } else {
      // CPU video transcoding (libx264): cap encoder threads (default 2) + 1 filter thread
      // Prevents FFmpeg default (1.5x CPU cores = 24-72 threads/channel) from thrashing CPU cache across channels
      if (!hasCustomThreads) args.push('-threads', String(efficiency.h264Threads));
      args.push('-filter_threads', '1', '-filter_complex_threads', '1');
    }

    args.push('-probesize', probeSize, '-analyzeduration', analyzeDuration);
    if (isZeroLatency) {
      args.push('-fflags', '+genpts+igndts+nobuffer+discardcorrupt', '-flags', 'low_delay');
    } else {
      args.push('-fflags', '+genpts+discardcorrupt');
    }
  }

  if (stream.user_agent && inputUrl.startsWith('http')) {
    args.push('-user_agent', stream.user_agent);
  }
  if (inputUrl.startsWith('http')) {
    args.push(
      '-rw_timeout',
      '10000000',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '4'
    );
  } else if (/^rtsp:\/\//i.test(inputUrl)) {
    args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  }

  args.push('-i', inputUrl);
  // Drop DVB EIT/SCTE-35 data (-dn) and DVB/Teletext subtitles (-sn) immediately at demux
  args.push('-dn', '-sn', '-map', '0:v:0', '-map', '0:a:0?');
  args.push('-c:v', vCodec);

  if (vCodec !== 'copy') {
    const preset = profile?.preset && profile.preset !== 'none' ? profile.preset : 'ultrafast';
    if (vCodec === 'libx264') {
      args.push('-preset', preset);
      if ((preset === 'ultrafast' || isZeroLatency) && !/-x264-params\b/.test(extraStr)) {
        // Low-overhead broadcast x264 parameters (~35-45% less CPU at ultrafast)
        args.push(
          '-x264-params',
          'rc-lookahead=0:sync-lookahead=0:ref=1:bframes=0:me=dia:subme=1:trellis=0'
        );
      }
    } else if (profile?.preset && profile.preset !== 'none') {
      args.push('-preset', profile.preset);
    }
    if (profile?.video_bitrate && profile.video_bitrate !== 'source') {
      args.push('-b:v', profile.video_bitrate);
      if (isZeroLatency && !/-maxrate\b/.test(extraStr)) {
        args.push('-maxrate', profile.video_bitrate, '-bufsize', profile.video_bitrate);
      }
    }
    if (profile?.resolution && profile.resolution !== 'source') {
      args.push('-s', profile.resolution, '-sws_flags', 'fast_bilinear');
    }
    args.push('-g', isZeroLatency ? '30' : '48', '-sc_threshold', '0');
    args.push(...splitExtraFlags(extraStr));
  } else {
    // Copy puro: descarta duplicados de -fflags/-flags/-probesize/-analyzeduration/-max_muxing_queue_size
    // (ya los fijamos arriba de forma óptima) y conserva solo flags adicionales del perfil
    const copyTokens = splitExtraFlags(extraStr);
    const copyExtra = [];
    for (let i = 0; i < copyTokens.length; i += 1) {
      const tok = copyTokens[i];
      if (
        tok === '-fflags' ||
        tok === '-flags' ||
        tok === '-probesize' ||
        tok === '-analyzeduration' ||
        tok === '-max_muxing_queue_size'
      ) {
        i += 1;
        continue;
      }
      copyExtra.push(tok);
    }
    if (copyExtra.length > 0) args.push(...copyExtra);
    args.push('-max_muxing_queue_size', '2048');
  }

  if (levelAudio) {
    args.push('-af', buildAudioLevelingFilter(globalAudio.preset, noResample), '-ac', '2');
    // Only force -ar 48000 when NOT in zero-resample 200+ channel mode (preserves native 44.1kHz/48kHz without polyphase resampling)
    if (!noResample) {
      args.push('-ar', '48000');
    }
  }

  args.push('-c:a', aCodec);
  if (aCodec !== 'copy') {
    if (aCodec === 'aac') {
      args.push('-aac_coder', 'fast');
    }
    const aBr = levelAudio
      ? globalAudio.bitrate || '128k'
      : profile?.audio_bitrate && profile.audio_bitrate !== 'source'
      ? profile.audio_bitrate
      : aCodec === 'mp2'
      ? '192k'
      : '128k';
    args.push('-b:a', aBr);
  }

  if (ramMpegTsOnly) {
    // Pure RAM MPEG-TS Trunk Mode for 200+ channels -> Local Flussonic (0 HLS segment writes to disk!)
    args.push('-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1');
    return args;
  }

  const hlsTime = String(isZeroLatency ? efficiency.hlsTime : Math.max(4, efficiency.hlsTime));
  const xuiMode = efficiency.hlsXuiMode || 'off';

  // ---- Juego de flags HLS ----------------------------------------------------
  // `off`  : la línea original (validada en producción). 
  // `safe` : la original + lo que en XUI.one evita problemas sin tocar el resto.
  // `full` : el juego exacto de XUI.one (includes/hui.php -> -f hls ...).
  const xui = resolveHlsXuiTokens(xuiMode, isZeroLatency);
  const hlsFlags = xui.flags;
  const xuiExtra = xui.extra;

  const outM3u8 = path.join(outDir, 'index.m3u8');

  if (dualTeeTsPipe) {
    // Dual muxer via -f tee ONLY for Flussonic tshttp:// trunk streams needing simultaneous HLS + pipe:1
    const escapedM3u8 = outM3u8.replace(/\\/g, '\\\\').replace(/([:'\[\]|])/g, '\\$1');
    args.push(
      '-f',
      'tee',
      `[f=hls:hls_time=${hlsTime}:hls_list_size=${efficiency.hlsListSize}:hls_flags=${hlsFlags}]${escapedM3u8}|[f=mpegts:mpegts_flags=+resend_headers]pipe:1`
    );
    return args;
  }

  // Default Ultra-Efficient Native HLS Output directly on /dev/shm RAMDisk:
  // Eliminates -f tee dual-muxer overhead and closes stdout completely (0.00% Node.js pipe syscalls / GC!)
  args.push(
    '-f',
    'hls',
    '-hls_time',
    hlsTime,
    '-hls_list_size',
    String(efficiency.hlsListSize),
    '-hls_flags',
    hlsFlags,
    ...xuiExtra,
    outM3u8
  );
  return args;
}

export function buildFfmpegCommandForStream(stream, profile) {
  const bin = isFfmpegAvailable() ? getFfmpegBin() : 'ffmpeg';
  return [bin, ...buildFfmpegArgsForStream(stream, profile).map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ');
}

export function buildFfmpegArgsForChannel247(channel, profile) {
  const playlist = parsePlaylist(channel.playlist_json).filter((p) => p.url);
  if (playlist.length === 0) return null;

  fs.mkdirSync(PLAYLIST_ROOT, { recursive: true });
  const outDir = resolveHlsDirForKey(`ch247_${channel.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const concatFile = path.join(PLAYLIST_ROOT, `channel247_${channel.id}.txt`);
  const concatLines = ['ffconcat version 1.0'];
  for (const item of playlist) {
    const escaped = item.url.replace(/'/g, "'\\''");
    concatLines.push(`file '${escaped}'`);
  }
  fs.writeFileSync(concatFile, concatLines.join('\n') + '\n', 'utf8');

  const globalAudio = getGlobalAudioLevelingConfig();
  const vCodec = profile?.video_codec && profile.video_codec !== 'copy' ? profile.video_codec : 'libx264';
  const aCodec = profile?.audio_codec && profile.audio_codec !== 'copy' ? profile.audio_codec : 'aac';
  const vBitrate = profile?.video_bitrate && profile.video_bitrate !== 'source' ? profile.video_bitrate : '3500k';
  const aBitrate = globalAudio.enabled
    ? globalAudio.bitrate || '128k'
    : profile?.audio_bitrate && profile.audio_bitrate !== 'source'
    ? profile.audio_bitrate
    : '128k';
  const preset = profile?.preset && profile.preset !== 'none' ? profile.preset : 'ultrafast';

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
    '-re',
    '-stream_loop',
    '-1',
    '-f',
    'concat',
    '-safe',
    '0',
    '-protocol_whitelist',
    'file,http,https,tcp,tls,crypto',
    '-i',
    concatFile,
    '-dn',
    '-sn'
  ];

  args.push('-c:v', vCodec);
  if (vCodec === 'libx264') {
    args.push('-preset', preset);
    if (preset === 'ultrafast') {
      args.push('-x264-params', 'rc-lookahead=0:sync-lookahead=0:ref=1:bframes=0:me=dia:subme=1:trellis=0');
    }
  } else {
    args.push('-preset', preset);
  }
  args.push('-b:v', vBitrate, '-g', '48', '-sc_threshold', '0');
  if (globalAudio.enabled) {
    args.push('-af', buildAudioLevelingFilter(globalAudio.preset), '-ac', '2', '-ar', '48000');
  }
  args.push('-c:a', aCodec);
  if (aCodec === 'aac') {
    args.push('-aac_coder', 'fast');
  }
  args.push('-b:a', aBitrate);
  args.push(
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '6',
    '-hls_flags',
    'delete_segments+program_date_time+temp_file',
    path.join(outDir, 'index.m3u8')
  );
  return args;
}

export function buildFfmpegCommandForChannel247(channel, profile) {
  const bin = isFfmpegAvailable() ? getFfmpegBin() : 'ffmpeg';
  const args = buildFfmpegArgsForChannel247(channel, profile);
  if (!args) return `${bin} # (Agrega videos a la parrilla 24/7 primero)`;
  return [bin, ...args.map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' ');
}

const TS_RING_BYTES = 500 * 188; // 94,000 bytes (exact 188-byte packet multiple, pre-allocated once per pipe worker)

/**
 * Tailer de segmentos HLS -> MPEG-TS continuo ORDENADO.
 *
 * Antes los clientes .ts de canales en modo HLS recibían `pipeSlateContinuousMpegTs`,
 * que cada 1000 ms releía el manifiesto y reenviaba el ÚLTIMO segmento completo:
 * el reproductor recibía segmentos repetidos, fuera de orden y con huecos de 1 s.
 * Con canales HD (2-3 MB por segmento) eso produce exactamente "pegones" y congelamientos.
 *
 * Este tailer envía cada segmento EXACTAMENTE UNA VEZ y en orden de secuencia, con
 * lectura en streaming de 64 KB y sin duplicar bytes. Latencia ≈ 1 segmento.
 */
export function createHlsSegmentTailer({
  manifestPath,
  onChunk,
  onSegmentStart = null,
  onSegmentEnd = null,
  intervalMs = 160,
  burstSegments = 2
}) {
  const dir = path.dirname(manifestPath);
  const queue = [];
  let reading = false;
  let stopped = false;
  let lastStat = { mtimeMs: -1, size: -1 };
  let timer = null;
  let lastSentSeq = -1;
  let sentCount = 0;

  const scanManifest = () => {
    let st;
    try {
      st = fs.statSync(manifestPath);
    } catch {
      return;
    }
    if (st.mtimeMs === lastStat.mtimeMs && st.size === lastStat.size) return;
    lastStat = { mtimeMs: st.mtimeMs, size: st.size };

    let mediaSeq = 0;
    const names = [];
    try {
      const text = fs.readFileSync(manifestPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSeq = Number(t.split(':')[1]) || 0;
          continue;
        }
        if (t.startsWith('#')) continue;
        names.push(path.basename(t.split('?')[0]));
      }
    } catch {
      return;
    }
    if (names.length === 0) return;

    // Deduplicación por NÚMERO DE SECUENCIA absoluto (EXT-X-MEDIA-SEQUENCE + índice):
    // evita reenviar segmentos aunque FFmpeg reutilice los nombres de archivo.
    let firstIdx = 0;
    if (lastSentSeq < 0) {
      // Primera conexión: arranca en los últimos `burstSegments` para enganchar PAT/PMT y audio ya
      firstIdx = Math.max(0, names.length - burstSegments);
    } else {
      // Si FFmpeg se reinició, EXT-X-MEDIA-SEQUENCE retrocede: sin este reenganche el
      // tailer creía que ya había enviado todo y el canal quedaba congelado para siempre.
      if (mediaSeq + names.length - 1 < lastSentSeq) {
        lastSentSeq = mediaSeq - 1;
      }
      firstIdx = Math.max(0, lastSentSeq + 1 - mediaSeq);
      if (firstIdx >= names.length) return;
    }

    // Sólo se avanza la secuencia hasta lo realmente encolado: si la cola está llena,
    // los segmentos restantes se piden en el siguiente barrido (antes se saltaban = huecos).
    let lastQueued = lastSentSeq;
    for (let i = firstIdx; i < names.length; i += 1) {
      if (queue.length >= 24) break;
      queue.push({ seq: mediaSeq + i, name: names[i] });
      lastQueued = mediaSeq + i;
    }
    lastSentSeq = Math.max(lastSentSeq, lastQueued);
  };

  const pump = () => {
    if (stopped) return;
    scanManifest();
    if (reading || queue.length === 0) return;

    const name = queue.shift().name;
    sentCount += 1;
    reading = true;
    const notifyStart = () => {
      try {
        onSegmentStart?.(name);
      } catch {
        // ignore
      }
    };
    const notifyEnd = () => {
      try {
        onSegmentEnd?.(name);
      } catch {
        // ignore
      }
    };

    const filePath = path.join(dir, name);
    const rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let started = false;
    rs.on('open', () => {
      // 'open' no cambia el modo del stream (a diferencia de 'readable', que lo pausa)
      if (!started) {
        started = true;
        notifyStart();
      }
    });
    rs.on('data', (chunk) => {
      if (!started) {
        started = true;
        notifyStart();
      }
      try {
        onChunk(chunk);
      } catch {
        // subscriber closed
      }
    });
    // Si una lectura no termina (archivo reemplazado/truncado a media lectura),
    // el tailer quedaría bloqueado para siempre y el canal se congelaría.
    const readTimeout = setTimeout(() => {
      if (!stopped && reading) {
        try {
          rs.destroy();
        } catch {
          // ignore
        }
        reading = false;
        if (started) notifyEnd();
        setImmediate(pump);
      }
    }, 20_000);
    readTimeout.unref?.();
    const finishRead = () => {
      clearTimeout(readTimeout);
    };

    rs.on('error', () => {
      // Segmento ya borrado por delete_segments o escritura en curso: se salta sin cortar el flujo
      finishRead();
      reading = false;
      if (started) notifyEnd();
    });
    rs.on('close', () => {
      finishRead();
      if (reading) {
        reading = false;
        if (started) notifyEnd();
      }
    });
    rs.on('end', () => {
      finishRead();
      reading = false;
      if (!stopped && queue.length > 0) setImmediate(pump);
      notifyEnd();
    });
  };

  timer = setInterval(pump, intervalMs);
  timer.unref?.();
  pump();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      queue.length = 0;
    },
    get sentSegments() {
      return sentCount;
    },
    // Diagnóstico en vivo del tailer (se muestra en el panel de Optimización FFmpeg)
    get debugState() {
      return { queued: queue.length, reading, lastSentSeq, sent: sentCount };
    }
  };
}

export function startSupervisedWorker(key, argsBuilder, onPidChange) {
  if (!isFfmpegAvailable()) return null;
  stopWorker(key);

  const state = {
    child: null,
    timer: null,
    stoppedManually: false,
    pid: null,
    attemptCount: 0,
    usesStdoutPipe: false,
    tsSubscribers: new Set(),
    ringBuf: null,
    ringWritePos: 0,
    ringFilled: 0,
    tsCarry: Buffer.allocUnsafe(188),
    tsCarryLen: 0,
    hlsTailer: null,
    tailerSegmentOpen: false,
    pendingTsSubscribers: new Set(),
    segmentsProduced: 0,
    restarts: 0,
    lastError: '',
    lastStartAt: 0,
    lastHlsAt: 0
  };
  workers.set(key, state);

  const broadcastTs = (chunk) => {
    if (state.tsSubscribers.size === 0) return;
    for (const cb of state.tsSubscribers) {
      try {
        cb(chunk);
      } catch {
        // ignore subscriber write error
      }
    }
  };

  const ensureHlsTailer = () => {
    if (state.hlsTailer || state.stoppedManually) return state.hlsTailer;
    const dir = resolveHlsDirForKey(key);
    const manifestPath = path.join(dir, 'index.m3u8');
    const engine = getFfmpegEngineConfig();
    state.tsJoinOnSegment = engine.tsJoinOnSegment !== false;
    state.hlsTailer = createHlsSegmentTailer({
      manifestPath,
      intervalMs: engine.tailerIntervalMs,
      // XUI.one manda los últimos segmentos ya escritos al conectar (X-XUI-Prebuffer).
      // Aquí se traduce al burst inicial del tailer: nunca duplica datos del pipe en vivo.
      burstSegments: Math.max(engine.tailerBurst, engine.prebufferSegments || 0),
      onChunk: (chunk) => {
        state.lastHlsAt = Date.now();
        broadcastTs(chunk);
      },
      onSegmentStart: () => {
        state.tailerSegmentOpen = true;
        state.segmentsProduced += 1;
        // Los clientes .ts que llegan a mitad de segmento esperan aquí: si entran
        // a media cadena reciben un TS sin PAT/PMT ni keyframe y el reproductor
        // arranca a tirones. Se sueltan justo en la frontera del siguiente.
        if (state.pendingTsSubscribers.size > 0) {
          for (const sub of state.pendingTsSubscribers) {
            state.tsSubscribers.add(sub);
            if (sub.__promoteTimer) {
              clearTimeout(sub.__promoteTimer);
              sub.__promoteTimer = null;
            }
            try {
              sub.__onPromoted?.();
            } catch {
              // ignore
            }
          }
          state.pendingTsSubscribers.clear();
        }
      },
      onSegmentEnd: () => {
        state.tailerSegmentOpen = false;
      }
    });
    return state.hlsTailer;
  };

  const stopHlsTailer = () => {
    if (state.hlsTailer) {
      try {
        state.hlsTailer.stop();
      } catch {
        // ignore
      }
      state.hlsTailer = null;
    }
  };
  state.stopHlsTailer = stopHlsTailer;
  state.ensureHlsTailer = ensureHlsTailer;

  const ingestTsStdout = (rawChunk) => {
    if (!rawChunk || rawChunk.length === 0) return;

    let buf = rawChunk;
    if (state.tsCarryLen > 0) {
      const combined = Buffer.allocUnsafe(state.tsCarryLen + rawChunk.length);
      state.tsCarry.copy(combined, 0, 0, state.tsCarryLen);
      rawChunk.copy(combined, state.tsCarryLen);
      buf = combined;
      state.tsCarryLen = 0;
    }

    // Fast 0x47 sync alignment
    if (buf.length >= 188 && buf[0] !== 0x47) {
      let synced = -1;
      for (let i = 1; i <= buf.length - 188; i++) {
        if (buf[i] === 0x47 && (i + 188 >= buf.length || buf[i + 188] === 0x47)) {
          synced = i;
          break;
        }
      }
      if (synced === -1) {
        const keep = Math.min(buf.length, 187);
        buf.copy(state.tsCarry, 0, buf.length - keep, buf.length);
        state.tsCarryLen = keep;
        return;
      }
      buf = buf.subarray(synced);
    }

    const alignedLen = buf.length - (buf.length % 188);
    const remLen = buf.length - alignedLen;
    if (remLen > 0) {
      buf.copy(state.tsCarry, 0, alignedLen, buf.length);
      state.tsCarryLen = remLen;
    }
    if (alignedLen <= 0) return;

    const aligned = buf.subarray(0, alignedLen);

    // Zero-copy broadcast to active live HTTP .ts / Flussonic tshttp:// subscribers
    if (state.tsSubscribers.size > 0) {
      for (const cb of state.tsSubscribers) {
        try {
          cb(aligned);
        } catch {
          // ignore subscriber write error
        }
      }
    }

    // Zero-allocation circular 94 KB ring buffer write for instant PAT/PMT lock on new subscriber connect
    if (!state.ringBuf) {
      state.ringBuf = Buffer.allocUnsafe(TS_RING_BYTES);
    }
    const src = aligned.length > TS_RING_BYTES ? aligned.subarray(aligned.length - TS_RING_BYTES) : aligned;
    const firstPart = Math.min(src.length, TS_RING_BYTES - state.ringWritePos);
    src.copy(state.ringBuf, state.ringWritePos, 0, firstPart);
    if (firstPart < src.length) {
      src.copy(state.ringBuf, 0, firstPart, src.length);
    }
    state.ringWritePos = (state.ringWritePos + src.length) % TS_RING_BYTES;
    state.ringFilled = Math.min(TS_RING_BYTES, state.ringFilled + src.length);
  };

  const launch = () => {
    if (state.stoppedManually) return;
    const args = typeof argsBuilder === 'function' ? argsBuilder(state.attemptCount) : argsBuilder;
    if (!args || !Array.isArray(args)) return;

    const lastArg = String(args[args.length - 1] || '');
    state.usesStdoutPipe = lastArg.endsWith('pipe:1');
    state.tsCarryLen = 0;
    if (!state.usesStdoutPipe) {
      state.ringBuf = null;
      state.ringWritePos = 0;
      state.ringFilled = 0;
    }

    const bin = getFfmpegBin();
    // Marca TVLISTER_WORKER=1: si el panel muere de golpe, la guardia de
    // estabilidad reconoce sus FFmpeg y los barre antes de arrancar otros
    // (dos emisores al mismo UDP del modulador = doble bitrate).
    const env = { ...ffmpegEnvFor(bin), TVLISTER_WORKER: '1', TVLISTER_WORKER_KEY: String(key) };

    const startedAt = Date.now();
    // Kernel /dev/null ('ignore') on all unused FDs -> 0.00% Node.js event-loop load across 200+ HLS channels!
    const child = spawn(bin, args, {
      stdio: ['ignore', state.usesStdoutPipe ? 'pipe' : 'pipe', 'pipe'],
      detached: false,
      env
    });
    state.child = child;
    state.pid = child.pid || null;
    state.lastStartAt = Date.now();
    if (onPidChange) onPidChange(state.pid);

    if (state.usesStdoutPipe && child.stdout) {
      child.stdout.on('data', ingestTsStdout);
      child.stdout.on('error', () => {});
    }
    if (!state.usesStdoutPipe && child.stdout) {
      // Cierra el pipe cuando FFmpeg escribe HLS puro (no debe llegar nada por stdout)
      child.stdout.resume();
    }
    if (child.stderr) {
      // Guarda sólo la cola del error para diagnóstico, con límite de 4 lecturas/s por canal
      // (un origen inestable puede escupir miles de líneas "Non-monotonous DTS" y comerse la CPU)
      let lastCaptureAt = 0;
      child.stderr.on('data', (chunk) => {
        const now = Date.now();
        if (now - lastCaptureAt < 250) return;
        lastCaptureAt = now;
        const txt = chunk.subarray(0, 2048).toString('utf8').trim();
        if (txt) state.lastError = `${state.lastError} ${txt}`.slice(-400);
      });
      child.stderr.on('error', () => {});
    }

    child.on('exit', () => {
      state.pid = null;
      state.restarts += 1;
      if (onPidChange) onPidChange(null);
      const aliveMs = Date.now() - startedAt;
      if (aliveMs >= 15_000) {
        state.attemptCount = 0;
      } else {
        state.attemptCount += 1;
      }
      if (!state.stoppedManually && workers.get(key) === state) {
        // Progressive reconnect backoff (2.5s -> 5s -> 10s -> 20s max) avoids fork/exec storms on dead upstreams
        const backoffSteps = [2500, 5000, 10000, 20000];
        const delayMs = backoffSteps[Math.min(Math.max(0, state.attemptCount - 1), backoffSteps.length - 1)];
        state.timer = setTimeout(launch, delayMs);
      }
    });
  };

  launch();
  return state.pid;
}

/**
 * Suscripción MPEG-TS "auto-reparable": si el worker se reinicia (o todavía no existe),
 * vuelve a engancharse sola en vez de dejar al reproductor congelado hasta que reconecte.
 * Esto era un "tirón" permanente: al reiniciar un canal, los clientes .ts se quedaban
 * sin datos para siempre.
 */
export function subscribeWorkerMpegTsAuto(key, onChunk, retryMs = 2000) {
  let unsub = null;
  let currentPid = null;
  let cancelled = false;

  const attach = () => {
    if (cancelled) return;
    const pid = getWorkerPid(key);
    if (unsub && pid === currentPid) return;
    if (unsub) {
      try {
        unsub();
      } catch {
        // ignore
      }
      unsub = null;
    }
    currentPid = pid;
    const next = subscribeWorkerMpegTs(key, onChunk);
    if (next) unsub = next;
  };

  attach();
  const timer = setInterval(attach, retryMs);
  timer.unref?.();

  return () => {
    cancelled = true;
    clearInterval(timer);
    if (unsub) {
      try {
        unsub();
      } catch {
        // ignore
      }
      unsub = null;
    }
  };
}

export function hasWorkerMpegTsFeed(key) {
  const state = workers.get(key);
  if (!state || state.stoppedManually || !state.pid) return false;
  if (state.usesStdoutPipe) return true;
  // Modo HLS nativo: el tailer de segmentos entrega MPEG-TS continuo en orden
  try {
    return fs.existsSync(path.join(resolveHlsDirForKey(key), 'index.m3u8'));
  } catch {
    return false;
  }
}

function subscribeTailer(state, onChunk, _tailer) {
  if (state.tailerIdleTimer) {
    clearTimeout(state.tailerIdleTimer);
    state.tailerIdleTimer = null;
  }

  const detach = () => {
    state.tsSubscribers.delete(onChunk);
    // Apaga el tailer tras 6 s sin suscriptores (ahorra lectura de segmentos y CPU)
    if (state.tsSubscribers.size === 0 && state.pendingTsSubscribers.size === 0 && !state.usesStdoutPipe && !state.stoppedManually) {
      state.tailerIdleTimer = setTimeout(() => {
        if (state.tsSubscribers.size === 0 && state.pendingTsSubscribers.size === 0 && state.stopHlsTailer) {
          state.stopHlsTailer();
        }
      }, 6000);
      state.tailerIdleTimer.unref?.();
    }
  };

  if (state.tailerSegmentOpen && state.tsJoinOnSegment !== false) {
    // Entra a mitad de segmento: se espera la frontera para no entregar basura
    state.pendingTsSubscribers.add(onChunk);
    const timer = setTimeout(() => {
      // Red de seguridad: si el canal se quedó quieto, no dejamos al cliente sin datos
      if (state.pendingTsSubscribers.delete(onChunk)) state.tsSubscribers.add(onChunk);
    }, 6000);
    timer.unref?.();
    onChunk.__promoteTimer = timer;
    return detach;
  }

  state.tsSubscribers.add(onChunk);
  return detach;
}

/**
 * Subscribes to the live continuous 188-byte MPEG-TS stream of an active 24/7 FFmpeg worker
 * (used by Flussonic tshttp:// trunks and .ts IPTV players for zero-jitter audio-leveled output).
 */
export function subscribeWorkerMpegTs(key, onChunk) {
  const state = workers.get(key);
  if (!state || state.stoppedManually) return null;

  if (!state.usesStdoutPipe) {
    // Canal en modo HLS nativo: stream ORDENADO de segmentos (cada segmento una sola vez)
    if (!state.ensureHlsTailer) return null;
    const tailer = state.ensureHlsTailer();
    if (!tailer) return null;
    // Encola al suscriptor en el mismo microtask para no perder el primer chunk antes de setHeader
    return subscribeTailer(state, onChunk, tailer);
  }

  let cancelled = false;

  // Defer PAT-aligned burst + live subscription atomically to next microtask:
  // 1) HTTP caller finishes res.setHeader() first
  // 2) Zero out-of-order or duplicate 188-byte packets between burst and live stream!
  queueMicrotask(() => {
    if (cancelled || state.stoppedManually) return;
    if (state.ringBuf && state.ringFilled >= 188) {
      const full =
        state.ringFilled < TS_RING_BYTES
          ? Buffer.from(state.ringBuf.subarray(0, state.ringFilled))
          : Buffer.concat([
              state.ringBuf.subarray(state.ringWritePos, TS_RING_BYTES),
              state.ringBuf.subarray(0, state.ringWritePos)
            ]);
      let patOffset = 0;
      for (let off = 0; off + 188 <= full.length; off += 188) {
        if (full[off] === 0x47 && (((full[off + 1] & 0x1f) << 8) | full[off + 2]) === 0x0000) {
          patOffset = off;
          break;
        }
      }
      try {
        onChunk(full.subarray(patOffset));
      } catch {
        // ignore
      }
    }
    state.tsSubscribers.add(onChunk);
  });

  return () => {
    cancelled = true;
    state.tsSubscribers.delete(onChunk);
  };
}

export function stopWorker(key) {
  const state = workers.get(key);
  if (!state) return;
  state.stoppedManually = true;
  if (state.tailerIdleTimer) clearTimeout(state.tailerIdleTimer);
  if (state.stopHlsTailer) {
    try {
      state.stopHlsTailer();
    } catch {
      // ignore
    }
  }
  state.tsSubscribers.clear();
  state.ringBuf = null;
  state.ringFilled = 0;
  state.ringWritePos = 0;
  if (state.timer) clearTimeout(state.timer);
  if (state.child) {
    try {
      state.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  workers.delete(key);
}

/**
 * Diagnóstico en vivo por canal: PID, reinicios de FFmpeg, suscriptores .ts,
 * antigüedad del manifiesto HLS (si crece, el canal está congelado) y última línea de error.
 */
export function getWorkerDiagnostics() {
  const out = [];
  for (const [key, state] of workers.entries()) {
    const dir = resolveHlsDirForKey(key);
    let hlsAgeSec = null;
    try {
      const st = fs.statSync(path.join(dir, 'index.m3u8'));
      hlsAgeSec = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
    } catch {
      hlsAgeSec = null;
    }
    out.push({
      key,
      pid: state.pid || null,
      restarts: state.restarts,
      subscribers: state.tsSubscribers.size,
      pendingSubscribers: state.pendingTsSubscribers ? state.pendingTsSubscribers.size : 0,
      segmentsProduced: state.segmentsProduced || 0,
      tailer: state.hlsTailer?.debugState || null,
      segmentOpen: Boolean(state.tailerSegmentOpen),
      usesStdoutPipe: Boolean(state.usesStdoutPipe),
      hlsAgeSec,
      lastError: state.lastError ? state.lastError.split('\n').pop().slice(0, 220) : ''
    });
  }
  return out;
}

/**
 * Empuja a un worker con el manifiesto congelado: si de verdad lleva
 * `staleSec` sin escribir segmento, se mata su FFmpeg. El supervisor del
 * propio worker lo relanza con su backoff normal, así que no hace falta tocar
 * la línea de argumentos ni la configuración del canal.
 * @returns {boolean} true si se reinició algo
 */
export function nudgeStalledWorker(key, staleSec = 90) {
  const state = workers.get(key);
  if (!state || !state.pid || state.stoppedManually) return false;
  const dir = resolveHlsDirForKey(key);
  let ageSec = null;
  try {
    ageSec = (Date.now() - fs.statSync(path.join(dir, 'index.m3u8')).mtimeMs) / 1000;
  } catch {
    ageSec = null; // sin manifiesto todavía: puede estar arrancando
  }
  if (ageSec !== null && ageSec > staleSec) {
    try {
      state.child?.kill('SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
  // Sin manifiesto y con el proceso llevando demasiado tiempo arriba: también
  // se considera colgado (nunca llegó a escribir el primer segmento).
  if (ageSec === null && state.lastStartAt && Date.now() - state.lastStartAt > staleSec * 2 * 1000) {
    try {
      state.child?.kill('SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function stopAllWorkers() {
  for (const key of Array.from(workers.keys())) {
    stopWorker(key);
  }
}

// ============================================================================
// TV ARCHIVE / CATCHUP DISK RECORDER (MPEG-TS Epoch Segments)
// ============================================================================
export function buildFfmpegArgsForArchive(stream, attemptIndex = 0) {
  const outDir = path.join(ARCHIVE_ROOT, `stream_${stream.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const candidates = resolveFfmpegCompatibleCandidates(stream.source_url);
  const inputUrl = candidates[Math.max(0, Number(attemptIndex) || 0) % candidates.length] || stream.source_url;

  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1'];
  if (stream.user_agent && inputUrl.startsWith('http')) {
    args.push('-user_agent', stream.user_agent);
  }
  if (inputUrl.startsWith('http')) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push(
    '-fflags',
    '+genpts+discardcorrupt',
    '-probesize',
    '500000',
    '-analyzeduration',
    '800000',
    '-i',
    inputUrl,
    '-dn',
    '-sn',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    '10',
    '-segment_format',
    'mpegts',
    '-strftime',
    '1',
    '-reset_timestamps',
    '1',
    path.join(outDir, 'seg_%s.ts')
  );
  return args;
}

export function startArchiveWorker(stream) {
  if (!stream || !stream.source_url) return null;
  return startSupervisedWorker(`archive_${stream.id}`, (attempt) => buildFfmpegArgsForArchive(stream, attempt));
}

export function stopArchiveWorker(streamId) {
  stopWorker(`archive_${streamId}`);
}

export function getArchiveStats(streamId) {
  const dir = path.join(ARCHIVE_ROOT, `stream_${streamId}`);
  const activeWorker = Boolean(getWorkerPid(`archive_${streamId}`));
  if (!fs.existsSync(dir)) {
    return { activeWorker, segmentCount: 0, sizeMb: 0, oldestIso: null, newestIso: null };
  }
  const files = fs.readdirSync(dir).filter((f) => /^seg_\d+\.ts$/.test(f));
  let bytes = 0;
  let minEpoch = Infinity;
  let maxEpoch = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      bytes += st.size;
      const ep = Number(f.slice(4, -3));
      if (ep < minEpoch) minEpoch = ep;
      if (ep > maxEpoch) maxEpoch = ep;
    } catch {
      // ignore race with deletion
    }
  }
  return {
    activeWorker,
    segmentCount: files.length,
    sizeMb: Number((bytes / (1024 * 1024)).toFixed(2)),
    oldestIso: minEpoch < Infinity ? new Date(minEpoch * 1000).toISOString() : null,
    newestIso: maxEpoch > 0 ? new Date(maxEpoch * 1000).toISOString() : null
  };
}

export function getArchiveSegmentsInRange(streamId, startEpochSec, durationSec = 3600) {
  const dir = path.join(ARCHIVE_ROOT, `stream_${streamId}`);
  if (!fs.existsSync(dir)) return [];
  const endEpochSec = startEpochSec + Math.max(10, durationSec);
  const all = fs
    .readdirSync(dir)
    .filter((f) => /^seg_\d+\.ts$/.test(f))
    .map((filename) => ({
      filename,
      epoch: Number(filename.slice(4, -3)),
      fullPath: path.join(dir, filename)
    }))
    .sort((a, b) => a.epoch - b.epoch);

  const inRange = all.filter((s) => s.epoch >= startEpochSec - 15 && s.epoch <= endEpochSec);
  if (inRange.length > 0) return inRange;
  // Fallback to most recent recorded segments if requested window slightly precedes recording start
  return all.slice(-Math.min(all.length, Math.ceil(durationSec / 10)));
}

export function pruneArchiveSegmentsForStreams(streams = []) {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const s of streams) {
    const days = Math.max(1, Number(s.tv_archive_days) || 3);
    const cutoff = nowSec - days * 86400;
    const dir = path.join(ARCHIVE_ROOT, `stream_${s.id}`);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^seg_(\d+)\.ts$/);
      if (m && Number(m[1]) < cutoff) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          // ignore
        }
      }
    }
  }
}

export function launchDbStreamWorkerIfNeeded(streamId) {
  const s = db.prepare('SELECT * FROM streams WHERE id = ?').get(Number(streamId));
  if (!s || s.stream_mode !== 'transcode' || s.status !== 'running' || !isFfmpegAvailable()) return;
  const profile = db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(s.transcode_profile_id || 1);
  let lastSavedPid = s.pid ?? null;
  startSupervisedWorker(
    `stream_${streamId}`,
    (attempt) => buildFfmpegArgsForStream(s, profile, attempt),
    (pid) => {
      const normalizedPid = pid || null;
      if (normalizedPid === lastSavedPid) return;
      lastSavedPid = normalizedPid;
      try {
        withSqliteBusyRetry(() =>
          db.prepare('UPDATE streams SET pid = ? WHERE id = ?').run(normalizedPid, Number(streamId))
        );
      } catch {
        // ignore transient close race
      }
    }
  );
}

export function scheduleDbStreamLaunches(streamIds = [], delayPerStreamMs = 60) {
  streamIds.forEach((sid, idx) => {
    setTimeout(() => {
      try {
        launchDbStreamWorkerIfNeeded(Number(sid));
      } catch {
        // ignore
      }
    }, idx * delayPerStreamMs).unref?.();
  });
}


