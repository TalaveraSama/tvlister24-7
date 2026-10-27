import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = path.resolve(__dirname, '../streams_runtime');

let ffmpegAvailableCache = null;
let resolvedFfmpegBin = null;
const runningProcesses = new Map();

export function getFfmpegBin() {
  if (resolvedFfmpegBin) return resolvedFfmpegBin;
  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/tvlister24-7/.runtime/bin/ffmpeg',
    '/home/xui/bin/ffmpeg',
    'ffmpeg'
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const env = bin.startsWith('/home/xui/')
        ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
        : process.env;
      execSync(`"${bin}" -version`, { stdio: 'ignore', env });
      resolvedFfmpegBin = bin;
      ffmpegAvailableCache = true;
      return bin;
    } catch {
      // try next candidate
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

export function getHostTelemetry() {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg1m = os.loadavg()[0] || 0;
  const cpuCount = Math.max(cpus.length, 1);
  const cpuPercent = Math.min(99.9, Math.max(2.1, Number(((loadAvg1m / cpuCount) * 100).toFixed(1))));
  const ramPercent = Number(((usedMem / totalMem) * 100).toFixed(1));

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpuCores: cpuCount,
    cpuModel: cpus[0]?.model || 'Server vCPU',
    cpuPercent,
    ramPercent,
    ramUsedGb: Number((usedMem / 1024 ** 3).toFixed(2)),
    ramTotalGb: Number((totalMem / 1024 ** 3).toFixed(2)),
    uptimeSeconds: Math.floor(os.uptime()),
    ffmpegInstalled: isFfmpegAvailable()
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

  // Generate 12-slot upcoming EPG schedule starting from current item start time
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

export function buildFfmpegCommandForStream(stream, profile) {
  const uaFlag = stream.user_agent ? `-user_agent "${stream.user_agent}"` : '';
  const hwFlag =
    profile?.hwaccel === 'nvenc'
      ? '-hwaccel cuda -hwaccel_output_format cuda'
      : profile?.hwaccel === 'qsv'
      ? '-hwaccel qsv'
      : '';

  const vCodec = profile?.video_codec || 'copy';
  const aCodec = profile?.audio_codec || 'copy';
  const vBitrate = vCodec !== 'copy' && profile?.video_bitrate ? `-b:v ${profile.video_bitrate}` : '';
  const aBitrate = aCodec !== 'copy' && profile?.audio_bitrate ? `-b:a ${profile.audio_bitrate}` : '';
  const scale =
    vCodec !== 'copy' && profile?.resolution && profile.resolution !== 'source'
      ? `-s ${profile.resolution}`
      : '';
  const preset =
    vCodec !== 'copy' && profile?.preset && profile.preset !== 'none' ? `-preset ${profile.preset}` : '';
  const extra = profile?.extra_flags || '-fflags +genpts';

  const outDir = `/var/lib/tvlister24-7/hls/stream_${stream.id}`;
  return [
    'ffmpeg -hide_banner -loglevel warning',
    hwFlag,
    uaFlag,
    `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "${stream.source_url}"`,
    `-c:v ${vCodec}`,
    preset,
    vBitrate,
    scale,
    `-c:a ${aCodec}`,
    aBitrate,
    extra,
    `-f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments+append_list "${outDir}/index.m3u8"`
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildFfmpegCommandForChannel247(channel, profile) {
  const vCodec = profile?.video_codec && profile.video_codec !== 'copy' ? profile.video_codec : 'libx264';
  const aCodec = profile?.audio_codec && profile.audio_codec !== 'copy' ? profile.audio_codec : 'aac';
  const vBitrate = profile?.video_bitrate && profile.video_bitrate !== 'source' ? profile.video_bitrate : '3500k';
  const aBitrate = profile?.audio_bitrate && profile.audio_bitrate !== 'source' ? profile.audio_bitrate : '128k';
  const wmFilter = channel.watermark_text
    ? `-vf "drawtext=text='${channel.watermark_text.replace(/'/g, '')}':x=W-tw-24:y=24:fontsize=22:fontcolor=white@0.85:box=1:boxcolor=black@0.45:boxborderw=6"`
    : '';
  const concatFile = `/var/lib/tvlister24-7/playlists/channel247_${channel.id}.txt`;
  const outDir = `/var/lib/tvlister24-7/hls/channel247_${channel.id}`;

  return [
    'ffmpeg -hide_banner -loglevel warning -re -stream_loop -1',
    `-f concat -safe 0 -protocol_whitelist file,http,https,tcp,tls -i "${concatFile}"`,
    wmFilter,
    `-c:v ${vCodec} -preset ${profile?.preset && profile.preset !== 'none' ? profile.preset : 'veryfast'} -b:v ${vBitrate}`,
    `-c:a ${aCodec} -b:a ${aBitrate}`,
    '-g 48 -sc_threshold 0',
    `-f hls -hls_time 4 -hls_list_size 8 -hls_flags delete_segments+program_date_time "${outDir}/index.m3u8"`
  ]
    .filter(Boolean)
    .join(' ');
}

export function startFfmpegWorkerIfAvailable(key, args) {
  if (!isFfmpegAvailable()) return null;
  const bin = getFfmpegBin();
  stopWorker(key);
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
  const env = bin.startsWith('/home/xui/')
    ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
    : process.env;
  const child = spawn(bin, args, { stdio: 'ignore', detached: false, env });
  runningProcesses.set(key, child);
  child.on('exit', () => {
    if (runningProcesses.get(key) === child) {
      runningProcesses.delete(key);
    }
  });
  return child.pid;
}

export function stopWorker(key) {
  const proc = runningProcesses.get(key);
  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    runningProcesses.delete(key);
  }
}
