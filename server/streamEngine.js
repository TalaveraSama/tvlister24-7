import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
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

function resolveOptimalHlsRoot() {
  if (process.env.HLS_DIR) return path.resolve(process.env.HLS_DIR);
  // Use Linux kernel tmpfs RAMDisk (/dev/shm) when >= 4 GB system RAM & >= 1.5 GB free on /dev/shm
  // Eliminates mechanical SATA HDD I/O bottlenecks when generating HLS for 100+ live channels!
  try {
    if (os.platform() === 'linux' && os.totalmem() >= 3.8 * 1024 ** 3 && fs.existsSync('/dev/shm')) {
      const st = fs.statfsSync('/dev/shm');
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      if (freeBytes >= 1.5 * 1024 ** 3) {
        const shmDir = '/dev/shm/tvlister_hls';
        fs.mkdirSync(shmDir, { recursive: true });
        return shmDir;
      }
    }
  } catch {
    // fallback to disk runtime directory
  }
  return path.join(RUNTIME_DIR, 'hls');
}

export const HLS_ROOT = resolveOptimalHlsRoot();
export const HLS_IS_RAMDISK = HLS_ROOT.startsWith('/dev/shm');
export const PLAYLIST_ROOT = path.join(RUNTIME_DIR, 'playlists');
export const ARCHIVE_ROOT = path.join(RUNTIME_DIR, 'archive');

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
  const manifest = path.join(HLS_ROOT, key, 'index.m3u8');
  return fs.existsSync(manifest) ? manifest : null;
}

export function getFreshLocalHlsManifestPath(key, maxAgeSec = 18) {
  const manifest = path.join(HLS_ROOT, key, 'index.m3u8');
  try {
    if (!fs.existsSync(manifest)) return null;
    const st = fs.statSync(manifest);
    if (Date.now() - st.mtimeMs > maxAgeSec * 1000) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function cleanupStreamRuntime(streamId) {
  const dirs = [
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
    .filter(Boolean);
}

export function getGlobalAudioLevelingConfig() {
  try {
    const rows = db
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('audio_leveling_enabled', 'audio_leveling_preset', 'audio_leveling_bitrate')"
      )
      .all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      enabled: map.audio_leveling_enabled === 'true',
      preset: map.audio_leveling_preset || 'standard',
      bitrate: map.audio_leveling_bitrate || '128k'
    };
  } catch {
    return { enabled: false, preset: 'standard', bitrate: '128k' };
  }
}

export function buildAudioLevelingFilter(preset = 'standard') {
  if (preset === 'voice') {
    // Boosts quiet commentators/dialogue and clamps loud commercials
    return 'aresample=async=1:first_pts=0,dynaudnorm=f=150:g=11:p=0.93:m=14:r=0.26:n=1:b=1';
  }
  if (preset === 'cinema') {
    // Gentle cinema curve with smooth envelope
    return 'aresample=async=1:first_pts=0,dynaudnorm=f=200:g=17:p=0.88:m=7:r=0.18:n=1:b=1';
  }
  // Standard broadcast TV loudness target (-13 dBFS RMS, -0.9 dBFS peak ceiling, zero startup dip)
  return 'aresample=async=1:first_pts=0,dynaudnorm=f=150:g=13:p=0.90:m=10:r=0.22:n=1:b=1';
}

export function isStreamAudioLeveled(stream, profile) {
  const mode = stream?.audio_leveling_mode || 'global';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (/audio nivelado/i.test(String(profile?.name || ''))) return true;
  return getGlobalAudioLevelingConfig().enabled;
}

export function buildFfmpegArgsForStream(stream, profile, attemptIndex = 0) {
  const outDir = path.join(HLS_ROOT, `stream_${stream.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const candidates = resolveFfmpegCompatibleCandidates(stream.source_url, stream.backup_url);
  const inputUrl = candidates[Math.max(0, Number(attemptIndex) || 0) % candidates.length] || stream.source_url;

  const globalAudio = getGlobalAudioLevelingConfig();
  const levelAudio = isStreamAudioLeveled(stream, profile);

  const vCodec = profile?.video_codec || 'copy';
  const rawACodec = profile?.audio_codec || 'copy';
  const aCodec = levelAudio && (rawACodec === 'copy' || !rawACodec) ? 'aac' : rawACodec;
  const extraStr = String(profile?.extra_flags || '');
  const isCopyRemux = vCodec === 'copy';
  const isZeroLatency =
    isCopyRemux ||
    /zerolatency|low[-_ ]?latency|nobuffer/i.test(extraStr) ||
    /zero[-_ ]?latency|low[-_ ]?latency|copy\/copy|2\.5\s*mbps/i.test(String(profile?.name || ''));

  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];

  if (isCopyRemux) {
    args.push('-fflags', '+genpts+igndts+nobuffer', '-flags', 'low_delay');
  } else if (isZeroLatency) {
    args.push('-fflags', 'nobuffer', '-flags', 'low_delay');
  }

  if (!isCopyRemux) {
    if (profile?.hwaccel === 'nvenc') {
      args.push('-hwaccel', 'cuda');
    } else if (profile?.hwaccel === 'qsv') {
      args.push('-hwaccel', 'qsv');
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
      '5'
    );
  }

  args.push('-i', inputUrl);
  args.push('-map', '0:v:0', '-map', '0:a:0?');
  args.push('-c:v', vCodec);

  if (vCodec !== 'copy') {
    if (profile?.preset && profile.preset !== 'none') args.push('-preset', profile.preset);
    if (profile?.video_bitrate && profile.video_bitrate !== 'source') args.push('-b:v', profile.video_bitrate);
    if (profile?.resolution && profile.resolution !== 'source') args.push('-s', profile.resolution);
    args.push('-g', isZeroLatency ? '30' : '48', '-sc_threshold', '0');
    args.push(...splitExtraFlags(extraStr));
  } else {
    args.push('-max_muxing_queue_size', '1024');
  }

  if (levelAudio) {
    args.push('-af', buildAudioLevelingFilter(globalAudio.preset), '-ac', '2', '-ar', '48000');
  }

  args.push('-c:a', aCodec);
  if (aCodec !== 'copy') {
    const aBr = levelAudio
      ? globalAudio.bitrate || '128k'
      : profile?.audio_bitrate && profile.audio_bitrate !== 'source'
      ? profile.audio_bitrate
      : '128k';
    args.push('-b:a', aBr);
  }

  const hlsTime = isZeroLatency ? '2' : '4';
  const hlsFlags = isZeroLatency ? 'delete_segments+independent_segments' : 'delete_segments+append_list';
  const outM3u8 = path.join(outDir, 'index.m3u8');
  const escapedM3u8 = outM3u8.replace(/\\/g, '\\\\').replace(/([:'\[\]|])/g, '\\$1');

  // Dual muxer via -f tee: encodes/levels audio ONCE and simultaneously writes RAMDisk HLS + seamless continuous MPEG-TS on stdout (pipe:1) for Flussonic tshttp:// & .ts players
  args.push(
    '-f',
    'tee',
    `[f=hls:hls_time=${hlsTime}:hls_list_size=6:hls_flags=${hlsFlags}]${escapedM3u8}|[f=mpegts]pipe:1`
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
  const outDir = path.join(HLS_ROOT, `ch247_${channel.id}`);
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
  const preset = profile?.preset && profile.preset !== 'none' ? profile.preset : 'veryfast';

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
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
    concatFile
  ];

  args.push('-c:v', vCodec, '-preset', preset, '-b:v', vBitrate, '-g', '48', '-sc_threshold', '0');
  if (globalAudio.enabled) {
    args.push('-af', buildAudioLevelingFilter(globalAudio.preset), '-ac', '2', '-ar', '48000');
  }
  args.push('-c:a', aCodec, '-b:a', aBitrate);
  args.push(
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '8',
    '-hls_flags',
    'delete_segments+program_date_time',
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
    tsRemainder: Buffer.alloc(0),
    burstChunks: [],
    burstBytes: 0
  };
  workers.set(key, state);

  const ingestTsStdout = (rawChunk) => {
    if (!rawChunk || rawChunk.length === 0) return;
    let buf = state.tsRemainder.length > 0 ? Buffer.concat([state.tsRemainder, rawChunk]) : rawChunk;
    let start = 0;

    // Ensure 0x47 sync alignment
    if (buf.length >= 188 && buf[0] !== 0x47) {
      let synced = -1;
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] === 0x47 && (i + 188 >= buf.length || buf[i + 188] === 0x47)) {
          synced = i;
          break;
        }
      }
      if (synced === -1) {
        state.tsRemainder = Buffer.alloc(0);
        return;
      }
      buf = buf.subarray(synced);
    }

    const alignedLen = buf.length - (buf.length % 188);
    if (alignedLen <= 0) {
      state.tsRemainder = buf;
      return;
    }

    const aligned = buf.subarray(start, alignedLen);
    state.tsRemainder = alignedLen < buf.length ? Buffer.from(buf.subarray(alignedLen)) : Buffer.alloc(0);

    // Keep ~94 KB (~500 TS packets) rolling burst buffer starting at a PAT packet (PID 0x0000) when seen
    const copyBuf = Buffer.from(aligned);
    state.burstChunks.push(copyBuf);
    state.burstBytes += copyBuf.length;
    while (state.burstBytes > 94000 && state.burstChunks.length > 1) {
      const removed = state.burstChunks.shift();
      state.burstBytes -= removed.length;
    }

    if (state.tsSubscribers.size > 0) {
      for (const cb of state.tsSubscribers) {
        try {
          cb(copyBuf);
        } catch {
          // ignore subscriber write error
        }
      }
    }
  };

  const launch = () => {
    if (state.stoppedManually) return;
    const args = typeof argsBuilder === 'function' ? argsBuilder(state.attemptCount) : argsBuilder;
    if (!args || !Array.isArray(args)) return;

    const lastArg = String(args[args.length - 1] || '');
    state.usesStdoutPipe = lastArg.endsWith('pipe:1');
    state.tsRemainder = Buffer.alloc(0);

    const bin = getFfmpegBin();
    const env = bin.startsWith('/home/xui/')
      ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
      : process.env;

    const startedAt = Date.now();
    const child = spawn(bin, args, {
      stdio: ['ignore', state.usesStdoutPipe ? 'pipe' : 'ignore', 'ignore'],
      detached: false,
      env
    });
    state.child = child;
    state.pid = child.pid || null;
    if (onPidChange) onPidChange(state.pid);

    if (state.usesStdoutPipe && child.stdout) {
      child.stdout.on('data', ingestTsStdout);
      child.stdout.on('error', () => {});
    }

    child.on('exit', () => {
      state.pid = null;
      if (onPidChange) onPidChange(null);
      if (Date.now() - startedAt < 12_000) {
        state.attemptCount += 1;
      }
      if (!state.stoppedManually && workers.get(key) === state) {
        state.timer = setTimeout(launch, 3500);
      }
    });
  };

  launch();
  return state.pid;
}

export function hasWorkerMpegTsFeed(key) {
  const state = workers.get(key);
  return Boolean(state && state.usesStdoutPipe && !state.stoppedManually);
}

/**
 * Subscribes to the live continuous 188-byte MPEG-TS stream of an active 24/7 FFmpeg worker
 * (used by Flussonic tshttp:// trunks and .ts IPTV players for zero-jitter audio-leveled output).
 */
export function subscribeWorkerMpegTs(key, onChunk) {
  const state = workers.get(key);
  if (!state || !state.usesStdoutPipe || state.stoppedManually) return null;

  let cancelled = false;

  // Defer PAT-aligned burst + live subscription atomically to next microtask:
  // 1) HTTP caller finishes res.setHeader() first
  // 2) Zero out-of-order or duplicate 188-byte packets between burst and live stream!
  queueMicrotask(() => {
    if (cancelled || state.stoppedManually) return;
    if (state.burstChunks.length > 0) {
      const full = Buffer.concat(state.burstChunks);
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
  state.tsSubscribers.clear();
  state.burstChunks = [];
  state.burstBytes = 0;
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

  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
  if (stream.user_agent && inputUrl.startsWith('http')) {
    args.push('-user_agent', stream.user_agent);
  }
  if (inputUrl.startsWith('http')) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push(
    '-i',
    inputUrl,
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
  startSupervisedWorker(
    `stream_${streamId}`,
    (attempt) => buildFfmpegArgsForStream(s, profile, attempt),
    (pid) => {
      db.prepare('UPDATE streams SET pid = ? WHERE id = ?').run(pid, Number(streamId));
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


