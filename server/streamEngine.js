import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, withSqliteBusyRetry } from './db.js';
import { resolveFlussonicUrlCandidates } from './flussonicImporter.js';

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
  if (HLS_IS_RAMDISK && getHlsFreeBytes() < 384 * 1024 * 1024) {
    fs.mkdirSync(DISK_HLS_ROOT, { recursive: true });
    return path.join(DISK_HLS_ROOT, safeKey);
  }
  return path.join(HLS_ROOT, safeKey);
}

let ffmpegAvailableCache = null;
let resolvedFfmpegBin = null;

// Map<key, { child, timer, stoppedManually, pid }>
const workers = new Map();

export function getFfmpegBin() {
  if (resolvedFfmpegBin) return resolvedFfmpegBin;
  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/tvlister24-7/.runtime/bin/ffmpeg',
    '/home/xui/bin/ffmpeg/ffmpeg',
    '/home/xui/bin/ffmpeg',
    path.resolve(process.cwd(), 'node_modules/@ffmpeg-installer/linux-x64/ffmpeg'),
    'ffmpeg'
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (bin.startsWith('/') && (!fs.existsSync(bin) || fs.statSync(bin).isDirectory())) {
        continue;
      }
      const env = bin.startsWith('/home/xui/')
        ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
        : process.env;
      execSync(`"${bin}" -version`, { stdio: 'ignore', env });
      resolvedFfmpegBin = bin;
      ffmpegAvailableCache = true;
      return bin;
    } catch {
      // try next
    }
  }
  ffmpegAvailableCache = false;
  return 'ffmpeg';
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
export function getFfmpegEfficiencyConfig() {
  const now = Date.now();
  if (efficiencyCache.value && now < efficiencyCache.expiresAt) {
    return efficiencyCache.value;
  }
  try {
    const rows = db
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('ffmpeg_ts_pipe_mode', 'ffmpeg_h264_threads')"
      )
      .all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const mode = ['auto', 'always', 'never'].includes(map.ffmpeg_ts_pipe_mode)
      ? map.ffmpeg_ts_pipe_mode
      : 'auto';
    const rawThreads = String(map.ffmpeg_h264_threads ?? '').trim();
    const threads = /^\d+$/.test(rawThreads) ? Math.min(16, Math.max(1, Number(rawThreads))) : 2;
    const cfg = { tsPipeMode: mode, h264Threads: threads };
    efficiencyCache = { value: cfg, expiresAt: now + 3000 };
    return cfg;
  } catch {
    return { tsPipeMode: 'auto', h264Threads: 2 };
  }
}

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

export function buildFfmpegArgsForStream(stream, profile, attemptIndex = 0) {
  const candidates = resolveFfmpegCompatibleCandidates(stream.source_url, stream.backup_url);
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

  // -nostdin avoids TTY polling; -loglevel error suppresses high-rate stderr text formatting across 200+ workers
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y'];

  const hasCustomThreads = /(?:^|\s)-threads\s+\d+/.test(extraStr);
  const hasCpuVideoScale =
    !isCopyRemux &&
    ((profile?.resolution && profile.resolution !== 'source') || /-vf\b/.test(extraStr) || /-s\b/.test(extraStr));

  // Fuentes HTTP/HLS (Flussonic) necesitan sonda amplia para HD: con 1 MB FFmpeg pierde el SPS/PPS
  // del primer segmento en canales de 8-12 Mbps y arranca tarde o entrecortado.
  const isHttpInput = /^https?:\/\//i.test(inputUrl);
  const probeSize = isHttpInput ? '5000000' : '1500000';
  const analyzeDuration = isHttpInput ? '4000000' : '1500000';
  // -avoid_negative_ts sólo cuando emitimos MPEG-TS continuo (pipe), no en HLS puro (evita micro-saltos de PTS)
  const needTsContinuity = ramMpegTsOnly || dualTeeTsPipe;

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

  const hlsTime = isZeroLatency ? '2' : '4';
  const hlsFlags = isZeroLatency
    ? 'delete_segments+independent_segments+omit_endlist'
    : 'delete_segments+append_list+omit_endlist';
  const outM3u8 = path.join(outDir, 'index.m3u8');

  if (dualTeeTsPipe) {
    // Dual muxer via -f tee ONLY for Flussonic tshttp:// trunk streams needing simultaneous HLS + pipe:1
    const escapedM3u8 = outM3u8.replace(/\\/g, '\\\\').replace(/([:'\[\]|])/g, '\\$1');
    args.push(
      '-f',
      'tee',
      `[f=hls:hls_time=${hlsTime}:hls_list_size=6:hls_flags=${hlsFlags}]${escapedM3u8}|[f=mpegts:mpegts_flags=+resend_headers]pipe:1`
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
    '6',
    '-hls_flags',
    hlsFlags,
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
export function createHlsSegmentTailer({ manifestPath, onChunk, intervalMs = 160, burstSegments = 2 }) {
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
      firstIdx = Math.max(0, lastSentSeq + 1 - mediaSeq);
      if (firstIdx >= names.length) return;
    }

    for (let i = firstIdx; i < names.length; i += 1) {
      if (queue.length >= 24) break;
      queue.push({ seq: mediaSeq + i, name: names[i] });
    }
    lastSentSeq = mediaSeq + names.length - 1;
  };

  const pump = () => {
    if (stopped) return;
    scanManifest();
    if (reading || queue.length === 0) return;

    const name = queue.shift().name;
    sentCount += 1;
    reading = true;

    const filePath = path.join(dir, name);
    const rs = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    rs.on('data', (chunk) => {
      try {
        onChunk(chunk);
      } catch {
        // subscriber closed
      }
    });
    rs.on('error', () => {
      // Segmento ya borrado por delete_segments o escritura en curso: se salta sin cortar el flujo
      reading = false;
    });
    rs.on('end', () => {
      reading = false;
      if (!stopped && queue.length > 0) setImmediate(pump);
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
    state.hlsTailer = createHlsSegmentTailer({
      manifestPath,
      onChunk: (chunk) => {
        state.lastHlsAt = Date.now();
        broadcastTs(chunk);
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
    const env = bin.startsWith('/home/xui/')
      ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
      : process.env;

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
  state.tsSubscribers.add(onChunk);
  return () => {
    state.tsSubscribers.delete(onChunk);
    // Apaga el tailer tras 6 s sin suscriptores (ahorra lectura de segmentos y CPU)
    if (state.tsSubscribers.size === 0 && !state.usesStdoutPipe && !state.stoppedManually) {
      state.tailerIdleTimer = setTimeout(() => {
        if (state.tsSubscribers.size === 0 && state.stopHlsTailer) state.stopHlsTailer();
      }, 6000);
      state.tailerIdleTimer.unref?.();
    }
  };
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
      usesStdoutPipe: Boolean(state.usesStdoutPipe),
      hlsAgeSec,
      lastError: state.lastError ? state.lastError.split('\n').pop().slice(0, 220) : ''
    });
  }
  return out;
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

  const candidates = resolveFfmpegCompatibleCandidates(stream.source_url, stream.backup_url);
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


