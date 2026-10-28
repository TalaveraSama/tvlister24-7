import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function buildFfmpegArgsForStream(stream, profile) {
  const outDir = path.join(HLS_ROOT, `stream_${stream.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const vCodec = profile?.video_codec || 'copy';
  const aCodec = profile?.audio_codec || 'copy';
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

  if (stream.user_agent && stream.source_url.startsWith('http')) {
    args.push('-user_agent', stream.user_agent);
  }
  if (stream.source_url.startsWith('http')) {
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

  args.push('-i', stream.source_url);
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

  args.push('-c:a', aCodec);
  if (aCodec !== 'copy' && profile?.audio_bitrate && profile.audio_bitrate !== 'source') {
    args.push('-b:a', profile.audio_bitrate);
  }

  args.push(
    '-f',
    'hls',
    '-hls_time',
    isZeroLatency ? '2' : '4',
    '-hls_list_size',
    '6',
    '-hls_flags',
    isZeroLatency ? 'delete_segments+independent_segments' : 'delete_segments+append_list',
    path.join(outDir, 'index.m3u8')
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

  const vCodec = profile?.video_codec && profile.video_codec !== 'copy' ? profile.video_codec : 'libx264';
  const aCodec = profile?.audio_codec && profile.audio_codec !== 'copy' ? profile.audio_codec : 'aac';
  const vBitrate = profile?.video_bitrate && profile.video_bitrate !== 'source' ? profile.video_bitrate : '3500k';
  const aBitrate = profile?.audio_bitrate && profile.audio_bitrate !== 'source' ? profile.audio_bitrate : '128k';
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
    pid: null
  };
  workers.set(key, state);

  const launch = () => {
    if (state.stoppedManually) return;
    const args = typeof argsBuilder === 'function' ? argsBuilder() : argsBuilder;
    if (!args || !Array.isArray(args)) return;

    const bin = getFfmpegBin();
    const env = bin.startsWith('/home/xui/')
      ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
      : process.env;

    const child = spawn(bin, args, { stdio: 'ignore', detached: false, env });
    state.child = child;
    state.pid = child.pid || null;
    if (onPidChange) onPidChange(state.pid);

    child.on('exit', () => {
      state.pid = null;
      if (onPidChange) onPidChange(null);
      if (!state.stoppedManually && workers.get(key) === state) {
        state.timer = setTimeout(launch, 4500);
      }
    });
  };

  launch();
  return state.pid;
}

export function stopWorker(key) {
  const state = workers.get(key);
  if (!state) return;
  state.stoppedManually = true;
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
export function buildFfmpegArgsForArchive(stream) {
  const outDir = path.join(ARCHIVE_ROOT, `stream_${stream.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
  if (stream.user_agent && stream.source_url.startsWith('http')) {
    args.push('-user_agent', stream.user_agent);
  }
  if (stream.source_url.startsWith('http')) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push(
    '-i',
    stream.source_url,
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
  return startSupervisedWorker(`archive_${stream.id}`, () => buildFfmpegArgsForArchive(stream));
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

