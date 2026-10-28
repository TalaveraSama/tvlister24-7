#!/usr/bin/env node
/**
 * Panel TVLister 24/7 — Nodo Cabecera Remoto (Cesbo Astra / Transcoder Agent)
 * Zero-dependency Node.js 22 standalone daemon for HP ProLiant / Dedicated Headend VMs.
 *
 * Features:
 *  - Idea 1: 100% Cloud-Controlled Headend Transcoder (5s Heartbeat + Desired-State Sync + GHz/RAM/Upload Telemetry)
 *  - Idea 2: Hybrid VIP 24/7 + Remote On-Demand (0 GHz & 0 Mbps upload when idle; instant wake on Cloud pull)
 *  - Idea 3: Cesbo Astra Mode (Auto 1080i/576i yadif Deinterlace, MP2/AC3 -> 48kHz Stereo Leveled AAC, Local LAN Astra Discovery)
 */
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const MASTER_URL = (process.env.MASTER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');
const HEADEND_TOKEN = process.env.HEADEND_TOKEN || '';
const HEADEND_PORT = Number(process.env.HEADEND_PORT || 8097);

if (!HEADEND_TOKEN) {
  console.error('[HeadendAgent] ERROR: HEADEND_TOKEN es obligatorio.');
  process.exit(1);
}

// Resolve RAMDisk (/dev/shm) to avoid any SSD/HDD wear on ProLiant VM
function resolveHlsRoot() {
  if (process.env.HLS_DIR) {
    const customDir = path.resolve(process.env.HLS_DIR);
    fs.mkdirSync(customDir, { recursive: true });
    return { dir: customDir, isRamdisk: customDir.startsWith('/dev/shm') };
  }
  try {
    if (os.platform() === 'linux' && fs.existsSync('/dev/shm')) {
      const dir = '/dev/shm/tvlister_headend_hls';
      fs.mkdirSync(dir, { recursive: true });
      return { dir, isRamdisk: true };
    }
  } catch {
    // fallback
  }
  const fallback = path.resolve(process.cwd(), 'headend_hls');
  fs.mkdirSync(fallback, { recursive: true });
  return { dir: fallback, isRamdisk: false };
}

const { dir: HLS_ROOT, isRamdisk: HLS_IS_RAMDISK } = resolveHlsRoot();

function resolveFfmpegBin() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/tvlister-headend/.runtime/bin/ffmpeg',
    '/opt/tvlister24-7/.runtime/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  try {
    return execSync('command -v ffmpeg', { encoding: 'utf8' }).trim() || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

const FFMPEG_BIN = resolveFfmpegBin();

// ==================== ACCURATE CPU % & GHz TELEMETRY ====================
let prevCpuSnap = null;
function readProcStatCpu() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0] || '';
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4) return null;
    const idle = (parts[3] || 0) + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function detectClockMhz(cpus) {
  const fromOs = cpus.reduce((acc, c) => acc + (Number(c.speed) || 0), 0) / Math.max(1, cpus.length);
  if (fromOs >= 400) return fromOs;
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const m = cpuinfo.match(/cpu MHz\s*:\s*([\d.]+)/i);
    if (m && Number(m[1]) >= 400) return Number(m[1]);
    const modelMatch = cpuinfo.match(/@\s*([\d.]+)\s*GHz/i);
    if (modelMatch && Number(modelMatch[1]) > 0.5) return Number(modelMatch[1]) * 1000;
  } catch {
    // ignore
  }
  return 2400; // Xeon E5 ProLiant Gen9 typical base clock
}

let bytesSentWindow = 0;
let lastBandwidthSampleMs = Date.now();
let currentUploadMbps = 0;

function sampleNodeTelemetry() {
  const cpus = os.cpus() || [];
  const cores = Math.max(1, cpus.length);
  const mhz = detectClockMhz(cpus);
  const totalGhz = Number(((cores * mhz) / 1000).toFixed(2));

  let cpuPct = 0;
  const snap = readProcStatCpu();
  if (snap && prevCpuSnap && snap.total > prevCpuSnap.total) {
    const dTotal = snap.total - prevCpuSnap.total;
    const dIdle = snap.idle - prevCpuSnap.idle;
    cpuPct = Math.min(99.9, Math.max(0.5, Number((((dTotal - dIdle) / dTotal) * 100).toFixed(1))));
  } else {
    const load1m = os.loadavg()[0] || 0;
    cpuPct = Math.min(99.9, Math.max(0.5, Number(((load1m / cores) * 100).toFixed(1))));
  }
  prevCpuSnap = snap;

  const usedGhz = Number(((totalGhz * cpuPct) / 100).toFixed(2));
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();

  const now = Date.now();
  const elapsedSec = Math.max(1, (now - lastBandwidthSampleMs) / 1000);
  currentUploadMbps = Number((((bytesSentWindow * 8) / elapsedSec) / 1_000_000).toFixed(2));
  bytesSentWindow = 0;
  lastBandwidthSampleMs = now;

  let activeCount = 0;
  let vipCount = 0;
  let onDemandAwakeCount = 0;
  const streamsTelemetry = {};

  for (const [id, st] of desiredStreams.entries()) {
    const w = workers.get(id);
    const meta = detectedMeta.get(id) || {};
    const isRunning = Boolean(w && w.pid);
    const constant247 = isConstant247Mode(st.headend_mode);
    if (constant247) vipCount++;
    if (isRunning) {
      activeCount++;
      if (!constant247) onDemandAwakeCount++;
    }
    streamsTelemetry[id] = {
      running: isRunning,
      pid: w?.pid || null,
      videoMode: shouldCopyVideoTrack(st, meta) ? 'copy' : 'yadif_x264',
      videoIn: meta.videoIn || '',
      height: meta.height || 0,
      resolution: meta.resolution || st.detected_resolution || '',
      tier: meta.tier || st.resolution_tier || '',
      interlaced: Boolean(meta.interlaced),
      audioIn: meta.audioIn || '',
      effectiveKbps: computeTargetBitrateKbps(st, meta),
      lastAccessAgoSec: w?.lastAccessMs ? Math.round((now - w.lastAccessMs) / 1000) : null
    };
  }

  return {
    hostname: os.hostname(),
    cpu_model: cpus[0]?.model || 'Intel Xeon (ProLiant Headend)',
    cpu_cores: cores,
    cpu_usage_pct: cpuPct,
    cpu_used_ghz: usedGhz,
    cpu_total_ghz: totalGhz,
    ram_used_gb: Number((usedMem / 1024 ** 3).toFixed(2)),
    ram_total_gb: Number((totalMem / 1024 ** 3).toFixed(2)),
    ram_usage_pct: Number(((usedMem / Math.max(1, totalMem)) * 100).toFixed(1)),
    hls_ramdisk: HLS_IS_RAMDISK,
    active_workers: activeCount,
    vip_count: vipCount,
    ondemand_awake_count: onDemandAwakeCount,
    upload_mbps: currentUploadMbps,
    streams_telemetry: streamsTelemetry
  };
}

// ==================== DESIRED STATE & WORKER ENGINE ====================
let nodeSettings = {
  audio_leveling_enabled: true,
  audio_preset: 'standard',
  audio_bitrate: '128k',
  auto_resolution: true,
  sd_kbps: 1000,
  hd_kbps: 2500,
  fhd_kbps: 3000,
  auto_deinterlace: true,
  allowed_cloud_ip: '',
  astra_url: 'http://127.0.0.1:8000',
  astra_auth: ''
};

// Map<streamId, streamConfig>
const desiredStreams = new Map();
// Map<streamId, { resolution, width, height, tier, interlaced, audioIn }>
const detectedMeta = new Map();
// Map<streamId, { child, pid, timer, stopped, signature, lastAccessMs }>
const workers = new Map();

function classifyHeightToTier(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const effH = w >= h ? h : w;
  if (effH > 0 && effH <= 580) return 'sd';
  if (effH > 800) return 'fhd';
  return 'hd';
}

function computeTargetBitrateKbps(st, meta = {}) {
  if (!nodeSettings.auto_resolution && st.bitrate_kbps) {
    return Number(st.bitrate_kbps) || 2500;
  }
  const tier = meta.tier || st.resolution_tier || 'hd';
  if (tier === 'sd') return Number(nodeSettings.sd_kbps) || 1000;
  if (tier === 'fhd') return Number(nodeSettings.fhd_kbps) || 3000;
  return Number(nodeSettings.hd_kbps) || 2500;
}

function normalizeAstraInputUrl(rawUrl = '') {
  const u = String(rawUrl || '').trim();
  // Add MPEG-TS UDP multicast buffer protection for Cesbo Astra UDP outputs
  if (/^udp:\/\//i.test(u) && !u.includes('fifo_size')) {
    const sep = u.includes('?') ? '&' : '?';
    return `${u}${sep}fifo_size=5000000&overrun_nonfatal=1`;
  }
  return u;
}

function buildAudioFilter(preset = 'standard') {
  if (preset === 'voice') {
    return 'aresample=async=1:first_pts=0,dynaudnorm=f=150:g=11:p=0.93:m=14:r=0.26:n=1:b=1';
  }
  if (preset === 'cinema') {
    return 'aresample=async=1:first_pts=0,dynaudnorm=f=200:g=17:p=0.88:m=7:r=0.18:n=1:b=1';
  }
  return 'aresample=async=1:first_pts=0,dynaudnorm=f=150:g=13:p=0.90:m=10:r=0.22:n=1:b=1';
}

function isConstant247Mode(mode = 'copy_audio') {
  return String(mode || 'copy_audio') !== 'ondemand';
}

function shouldCopyVideoTrack(st, meta = {}) {
  const mode = String(st?.headend_mode || 'copy_audio');
  if (mode === 'copy_pure_247') return true;
  if (mode === 'vip_247' || mode === 'ondemand') return false;

  // For 'copy_audio' & 'smart_astra_247' (24/7 Constant Copy + Anti-Rayas + Nivelador de Audio):
  // - Progressive H.264 channels (e.g. AMC HD 1920x1080p) stay 100% '-c:v copy' (0% CPU video!).
  // - Interlaced channels (480i/576i/1080i with comb lines) or MPEG-2 satellite feeds automatically
  //   apply YADIF Anti-Rayas + H.264 when Anti-Rayas is active!
  const deintMode = st?.deinterlace_mode || 'auto';
  if (deintMode === 'on') return false;
  if (
    deintMode !== 'off' &&
    nodeSettings.auto_deinterlace &&
    (Boolean(meta.interlaced) || meta.videoIn === 'mpeg2video')
  ) {
    return false;
  }
  return true;
}

function buildHeadendSignature(st, meta = {}) {
  const tier = meta.tier || st.resolution_tier || 'hd';
  const kbps = computeTargetBitrateKbps(st, meta);
  const copyVideo = shouldCopyVideoTrack(st, meta);
  return JSON.stringify({
    url: st.astra_local_url,
    mode: st.headend_mode,
    copyVideo,
    tier: copyVideo ? 'copy' : tier,
    kbps: copyVideo ? 0 : kbps,
    deint: st.deinterlace_mode || 'auto',
    globalDeint: nodeSettings.auto_deinterlace,
    audioLvl: st.audio_leveling_mode || 'global',
    globalAudio: nodeSettings.audio_leveling_enabled,
    audioPreset: nodeSettings.audio_preset,
    audioBr: nodeSettings.audio_bitrate
  });
}

function buildFfmpegArgs(st) {
  const outDir = path.join(HLS_ROOT, `stream_${st.id}`);
  fs.mkdirSync(outDir, { recursive: true });

  const meta = detectedMeta.get(st.id) || {};
  const tier = meta.tier || st.resolution_tier || 'hd';
  const kbps = computeTargetBitrateKbps(st, meta);
  const inputUrl = normalizeAstraInputUrl(st.astra_local_url);
  const isCopyVideo = shouldCopyVideoTrack(st, meta);
  const isPureCopy = st.headend_mode === 'copy_pure_247';

  const args = ['-hide_banner', '-loglevel', 'info', '-y'];

  if (isCopyVideo) {
    args.push('-fflags', '+genpts+igndts+nobuffer', '-flags', 'low_delay');
  } else {
    args.push('-fflags', '+genpts+nobuffer', '-flags', 'low_delay');
  }

  if (/^https?:\/\//i.test(inputUrl)) {
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
  }

  args.push('-i', inputUrl);
  // Strip satellite DVB EIT/Teletext/null stuffing PIDs before uploading to Cloud!
  args.push('-map', '0:v:0', '-map', '0:a:0?');

  if (isCopyVideo) {
    args.push('-c:v', 'copy', '-max_muxing_queue_size', '1024');
  } else {
    const vFilters = [];
    const deintMode = st.deinterlace_mode || 'auto';
    if (deintMode === 'on' || meta.interlaced) {
      vFilters.push('yadif=0:-1:0');
    } else if (deintMode === 'auto' && nodeSettings.auto_deinterlace) {
      // yadif deint=1 ONLY deinterlaces 1080i/576i/480i frames marked interlaced; progressive frames pass cleanly
      vFilters.push('yadif=0:-1:1');
    }

    if (tier === 'sd') {
      vFilters.push('scale=min(960\\,iw):-2');
    } else if (tier === 'fhd') {
      vFilters.push('scale=min(1920\\,iw):-2');
    } else {
      vFilters.push('scale=min(1280\\,iw):-2');
    }

    if (vFilters.length > 0) {
      args.push('-vf', vFilters.join(','));
    }

    args.push(
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-b:v',
      `${kbps}k`,
      '-maxrate',
      `${kbps}k`,
      '-bufsize',
      `${kbps * 2}k`,
      '-g',
      '30',
      '-sc_threshold',
      '0'
    );
  }

  const audioMode = st.audio_leveling_mode || 'global';
  const useAudioLevel =
    !isPureCopy && (audioMode === 'on' || (audioMode !== 'off' && nodeSettings.audio_leveling_enabled));

  if (isPureCopy && audioMode === 'off') {
    args.push('-c:a', 'copy');
  } else if (useAudioLevel) {
    args.push(
      '-af',
      buildAudioFilter(nodeSettings.audio_preset),
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'aac',
      '-b:a',
      nodeSettings.audio_bitrate || '128k'
    );
  } else {
    // Still ensure AAC compatibility if Astra sends MP2/AC3
    args.push('-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '128k');
  }

  args.push(
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '6',
    '-hls_flags',
    'delete_segments+independent_segments',
    path.join(outDir, 'index.m3u8')
  );

  return args;
}

function parseLiveStderrStreamMetadata(streamId, stderrChunk) {
  const inputSection = String(stderrChunk || '').split(/Stream mapping:|Output #0/)[0];
  if (!inputSection) return;

  const st = desiredStreams.get(streamId);
  const existingMeta = detectedMeta.get(streamId);
  const next = { ...(existingMeta || {}) };
  let updated = false;

  const vMatch = inputSection.match(
    /Stream\s+#\d+:\d+[^\r\n]*Video:\s*([a-zA-Z0-9_]+)([^\r\n]*?)[,\s](\d{2,5})x(\d{2,5})(?=[\s,\[])/i
  );
  if (vMatch) {
    const fullLine = vMatch[0];
    const videoCodec = String(vMatch[1] || '').toLowerCase();
    const w = Number(vMatch[3]);
    const h = Number(vMatch[4]);
    if (w >= 120 && h >= 90) {
      const tier = classifyHeightToTier(w, h);
      const isInterlaced = /\b(top first|bottom first|top coded first|bottom coded first|tff|bff)\b/i.test(
        fullLine
      );
      if (
        next.videoIn !== videoCodec ||
        next.resolution !== `${w}x${h}` ||
        next.tier !== tier ||
        next.interlaced !== isInterlaced
      ) {
        next.videoIn = videoCodec;
        next.width = w;
        next.height = h;
        next.resolution = `${w}x${h}`;
        next.tier = tier;
        next.interlaced = isInterlaced;
        updated = true;
      }
    }
  }

  const aMatch = inputSection.match(/Stream\s+#\d+:\d+[^\r\n]*Audio:\s*([a-zA-Z0-9_]+)/i);
  if (aMatch && next.audioIn !== aMatch[1].toLowerCase()) {
    next.audioIn = aMatch[1].toLowerCase();
    updated = true;
  }

  if (updated) {
    detectedMeta.set(streamId, next);
    // Hot-reload worker if signature changed (e.g. interlaced/MPEG2 detected -> activate YADIF Anti-Rayas, or tier bitrate changed)
    const w = workers.get(streamId);
    if (st && w) {
      const nextSig = buildHeadendSignature(st, next);
      if (nextSig !== w.signature) {
        setImmediate(() => restartStreamWorker(streamId));
      }
    }
  }
}

function startStreamWorker(streamId) {
  const st = desiredStreams.get(streamId);
  if (!st || !st.astra_local_url) return;

  const existing = workers.get(streamId);
  const sig = buildHeadendSignature(st, detectedMeta.get(streamId));
  if (existing && !existing.stopped && existing.signature === sig) {
    existing.lastAccessMs = Date.now();
    return;
  }

  stopStreamWorker(streamId);

  const state = {
    child: null,
    pid: null,
    timer: null,
    stopped: false,
    signature: sig,
    lastAccessMs: Date.now()
  };
  workers.set(streamId, state);

  const launch = () => {
    if (state.stopped) return;
    const freshSt = desiredStreams.get(streamId);
    if (!freshSt) return;

    const args = buildFfmpegArgs(freshSt);
    state.signature = buildHeadendSignature(freshSt, detectedMeta.get(streamId));

    let stderrHeaderParsed = false;
    let stderrBuf = '';

    const child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    state.child = child;
    state.pid = child.pid || null;

    child.stderr.on('data', (chunk) => {
      if (stderrHeaderParsed) return;
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.includes('Output #0') || stderrBuf.length > 8192) {
        parseLiveStderrStreamMetadata(streamId, stderrBuf);
        stderrHeaderParsed = true;
        stderrBuf = '';
      }
    });

    child.on('exit', () => {
      state.pid = null;
      if (!state.stopped && workers.get(streamId) === state) {
        state.timer = setTimeout(launch, 4000);
      }
    });
  };

  launch();
}

function stopStreamWorker(streamId) {
  const w = workers.get(streamId);
  if (!w) return;
  w.stopped = true;
  if (w.timer) clearTimeout(w.timer);
  if (w.child) {
    try {
      w.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  workers.delete(streamId);
  try {
    const outDir = path.join(HLS_ROOT, `stream_${streamId}`);
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function restartStreamWorker(streamId) {
  stopStreamWorker(streamId);
  startStreamWorker(streamId);
}

const MAX_CONSTANT_STARTS_PER_TICK = 16;

function reconcileWorkers() {
  const now = Date.now();
  // Stop removed streams
  for (const id of Array.from(workers.keys())) {
    if (!desiredStreams.has(id)) {
      stopStreamWorker(id);
    }
  }

  let startedThisTick = 0;

  for (const [id, st] of desiredStreams.entries()) {
    const w = workers.get(id);
    const sig = buildHeadendSignature(st, detectedMeta.get(id));

    if (st.status === 'stopped') {
      if (w) stopStreamWorker(id);
      continue;
    }

    if (isConstant247Mode(st.headend_mode)) {
      // ALL 24/7 Constant modes ('copy_audio', 'smart_astra_247', 'copy_pure_247', 'vip_247') NEVER sleep!
      if (!w) {
        if (startedThisTick < MAX_CONSTANT_STARTS_PER_TICK) {
          startStreamWorker(id);
          startedThisTick++;
        }
      } else if (w.signature !== sig) {
        startStreamWorker(id);
      }
    } else {
      // Explicit 'ondemand' mode ONLY: sleep after 120s of zero Cloud pulls
      const forceAwake = Number(st.force_wake_until || 0) > now;
      if (forceAwake && !w) {
        startStreamWorker(id);
      } else if (w) {
        if (w.signature !== sig) {
          startStreamWorker(id);
        } else if (!forceAwake && now - w.lastAccessMs > 120_000) {
          stopStreamWorker(id);
        }
      }
    }
  }
}

// ==================== CESBO ASTRA LOCAL LAN DISCOVERY ====================
function parseAstraM3u(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const nameMatch = line.match(/,(.+)$/);
      const grpMatch = line.match(/group-title="([^"]*)"/i);
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const rawGrp = grpMatch ? grpMatch[1].trim() : '';
      meta = {
        name: nameMatch ? nameMatch[1].trim() : 'Canal Astra',
        category: !rawGrp || rawGrp === '-' ? '' : rawGrp,
        logo: logoMatch ? logoMatch[1].trim() : ''
      };
    } else if (!line.startsWith('#') && meta) {
      let streamUrl = line;
      if (streamUrl.startsWith('/') && baseUrl) {
        streamUrl = `${baseUrl.replace(/\/+$/, '')}${streamUrl}`;
      }
      items.push({
        name: meta.name,
        category: meta.category,
        logo_url: meta.logo,
        astra_local_url: streamUrl
      });
      meta = null;
    }
  }
  return items;
}

function parseAstraJsonOrLuaConfig(rawText, fallbackHttpBase) {
  const items = [];
  try {
    const parsed = JSON.parse(rawText);
    const streamsArr = parsed.make_stream || parsed.streams || (Array.isArray(parsed) ? parsed : []);
    for (const s of streamsArr) {
      if (!s || s.enable === false) continue;
      const outputs = Array.isArray(s.output) ? s.output : s.output ? [s.output] : [];
      let chosen = outputs.find((o) => /^https?:|^udp:|^rtp:/i.test(String(o))) || '';
      if (!chosen && s.id && fallbackHttpBase) {
        chosen = `${fallbackHttpBase.replace(/\/+$/, '')}/play/${s.id}`;
      }
      if (chosen) {
        chosen = String(chosen).replace(/^http:\/\/0\.0\.0\.0:/i, 'http://127.0.0.1:');
        items.push({
          name: s.name || `Astra ${s.id || items.length + 1}`,
          category: s.groups || s.category || 'Cesbo Astra',
          logo_url: '',
          astra_local_url: chosen
        });
      }
    }
    if (items.length > 0) return items;
  } catch {
    // Try Lua make_stream({ name = "...", output = { "http://..." } })
    const regex = /make_stream\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    let m;
    while ((m = regex.exec(rawText)) !== null) {
      const block = m[1];
      const nameM = block.match(/name\s*=\s*["']([^"']+)["']/);
      const outM = block.match(/(?:http|udp|rtp):\/\/[^"'\s]+/i);
      if (nameM && outM) {
        items.push({
          name: nameM[1],
          category: 'Cesbo Astra',
          logo_url: '',
          astra_local_url: outM[0].replace(/^http:\/\/0\.0\.0\.0:/i, 'http://127.0.0.1:')
        });
      }
    }
  }
  return items;
}

async function discoverLocalAstraChannels(customUrl = '', customAuth = '') {
  const base = (customUrl || nodeSettings.astra_url || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const auth = customAuth || nodeSettings.astra_auth || '';
  const headers = { 'User-Agent': 'TVListerHeadend/2.5' };
  if (auth) {
    headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
  }

  const endpoints = [
    `${base}/playlist.m3u8`,
    `${base}/playlist.m3u`,
    `${base}/api/config`,
    base
  ];

  for (const ep of endpoints) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const resp = await fetch(ep, { headers, signal: ac.signal });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.includes('#EXTM3U')) {
        const found = parseAstraM3u(text, base);
        if (found.length > 0) return found;
      }
      const fromCfg = parseAstraJsonOrLuaConfig(text, base);
      if (fromCfg.length > 0) return fromCfg;
    } catch {
      // try next
    }
  }

  // Also check local /etc/astra/*.conf or *.json if running on same host
  try {
    if (fs.existsSync('/etc/astra')) {
      for (const f of fs.readdirSync('/etc/astra')) {
        if (/\.(conf|json|lua)$/i.test(f)) {
          const txt = fs.readFileSync(path.join('/etc/astra', f), 'utf8');
          const found = parseAstraJsonOrLuaConfig(txt, base);
          if (found.length > 0) return found;
        }
      }
    }
  } catch {
    // ignore
  }

  return [];
}

// ==================== HEARTBEAT LOOP TO CLOUD PANEL ====================
let pendingAstraDiscoveryReport = null;

async function sendHeartbeatToCloud() {
  try {
    const payload = {
      ...sampleNodeTelemetry(),
      astra_discovered: pendingAstraDiscoveryReport
    };
    pendingAstraDiscoveryReport = null;

    const resp = await fetch(`${MASTER_URL}/api/headend/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-headend-token': HEADEND_TOKEN
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) return;
    const data = await resp.json();

    if (data.settings) {
      nodeSettings = { ...nodeSettings, ...data.settings };
    }

    if (Array.isArray(data.streams)) {
      const nextIds = new Set();
      for (const s of data.streams) {
        nextIds.add(Number(s.id));
        desiredStreams.set(Number(s.id), s);
      }
      for (const oldId of Array.from(desiredStreams.keys())) {
        if (!nextIds.has(oldId)) desiredStreams.delete(oldId);
      }
    }

    if (Array.isArray(data.commands)) {
      for (const cmd of data.commands) {
        if (cmd.type === 'discover_astra') {
          pendingAstraDiscoveryReport = await discoverLocalAstraChannels(cmd.astra_url, cmd.astra_auth);
        } else if (cmd.type === 'restart_stream' && cmd.streamId) {
          restartStreamWorker(Number(cmd.streamId));
        } else if (cmd.type === 'self_update') {
          try {
            const bundleRes = await fetch(`${MASTER_URL}/api/headend/agent-bundle.js`);
            if (bundleRes.ok) {
              const code = await bundleRes.text();
              if (code.length > 5000 && code.includes('HeadendAgent')) {
                const selfPath = fileURLToPath(import.meta.url);
                const tmpPath = `${selfPath}.next`;
                fs.writeFileSync(tmpPath, code, 'utf8');
                fs.renameSync(tmpPath, selfPath);
                console.log('[HeadendAgent] Auto-actualización recibida desde Nube. Reiniciando demonio...');
                setTimeout(() => shutdown(), 300);
                return;
              }
            }
          } catch (upErr) {
            console.warn(`[HeadendAgent] Error en self_update: ${upErr.message}`);
          }
        }
      }
    }

    reconcileWorkers();
  } catch (err) {
    console.warn(`[HeadendAgent] Error contactando Panel Nube (${MASTER_URL}): ${err.message}`);
  }
}

// ==================== HTTP SERVER FOR CLOUD PULL (HLS & MPEG-TS) ====================
function getFreshManifest(streamId, maxAgeSec = 16) {
  try {
    const p = path.join(HLS_ROOT, `stream_${streamId}`, 'index.m3u8');
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (st.size < 25 || Date.now() - st.mtimeMs > maxAgeSec * 1000) return null;
    const txt = fs.readFileSync(p, 'utf8');
    if (!txt.includes('.ts')) return null;
    return p;
  } catch {
    return null;
  }
}

async function ensureStreamAwakeAndReady(streamId, maxWaitMs = 8500) {
  let st = desiredStreams.get(streamId);
  if (!st) {
    // Immediate sync with Cloud in case channel was imported <5s ago
    await sendHeartbeatToCloud();
    st = desiredStreams.get(streamId);
  }
  if (!st) return null;

  startStreamWorker(streamId);
  const w = workers.get(streamId);
  if (w) w.lastAccessMs = Date.now();

  let manifest = getFreshManifest(streamId);
  if (manifest) return manifest;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 180));
    manifest = getFreshManifest(streamId);
    if (manifest) return manifest;
  }
  return getFreshManifest(streamId);
}

function checkRequestAuth(req, urlObj, pathToken = '') {
  const tok = pathToken || urlObj.searchParams.get('token') || req.headers['x-headend-token'] || '';
  if (tok !== HEADEND_TOKEN) return false;

  if (nodeSettings.allowed_cloud_ip && nodeSettings.allowed_cloud_ip.trim()) {
    const remoteIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const allowed = nodeSettings.allowed_cloud_ip
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0 && remoteIp !== '127.0.0.1' && !allowed.includes(remoteIp)) {
      return false;
    }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://127.0.0.1:${HEADEND_PORT}`);

  if (urlObj.pathname === '/headend/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, status: 'headend_online', ramdisk: HLS_IS_RAMDISK }));
  }

  // Path-token HLS route (zero query strings for 100% FFmpeg HLS demuxer compatibility):
  // /headend/live/:token/:streamId/:file  OR  /headend/live/:streamId/:file?token=...
  const pathTokenMatch = urlObj.pathname.match(/^\/headend\/live\/(hdn_[a-zA-Z0-9_-]+)\/(\d+)\/([a-zA-Z0-9_.-]+)$/);
  const logoTokenMatch = urlObj.pathname.match(/^\/headend\/astra-logo\/(hdn_[a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  const legacyHlsMatch = !pathTokenMatch
    ? urlObj.pathname.match(/^\/headend\/live\/(\d+)\/([a-zA-Z0-9_.-]+)$/)
    : null;

  const extractedPathToken = pathTokenMatch ? pathTokenMatch[1] : logoTokenMatch ? logoTokenMatch[1] : '';
  if (!checkRequestAuth(req, urlObj, extractedPathToken)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden Headend Token/IP');
  }

  // Local LAN Cesbo Astra Logo Bridge (e.g. http://192.168.88.10:8000/playlist/tvg-logo/a0ek.png)
  if (logoTokenMatch) {
    const safeFile = path.basename(logoTokenMatch[2]);
    const astraBase = String(nodeSettings.astra_url || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    const logoUrl = `${astraBase}/playlist/tvg-logo/${encodeURIComponent(safeFile)}`;
    try {
      const headers = {};
      if (nodeSettings.astra_auth && nodeSettings.astra_auth.includes(':')) {
        headers.Authorization = `Basic ${Buffer.from(nodeSettings.astra_auth).toString('base64')}`;
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4500);
      const r = await fetch(logoUrl, { headers, signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) {
        res.writeHead(404);
        return res.end('Logo not found on Astra');
      }
      const imgBuf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(imgBuf);
    } catch {
      res.writeHead(502);
      return res.end('Error fetching logo from local Astra');
    }
  }

  // Direct LAN Astra Discovery endpoint (when Cloud reaches ProLiant HTTP directly)
  if (urlObj.pathname === '/headend/discover-astra') {
    const found = await discoverLocalAstraChannels(
      urlObj.searchParams.get('astra_url') || '',
      urlObj.searchParams.get('astra_auth') || ''
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, channels: found }));
  }

  // Authenticated LAN Bridge for Local Flussonic 23.12 API v3 (allows Cloud Panel to push/probe 192.168.x.x Flussonic)
  if (urlObj.pathname === '/headend/proxy-flussonic' && req.method === 'POST') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const reqPayload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const targetUrl = String(reqPayload.url || '').trim();
      if (!/^https?:\/\//i.test(targetUrl)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, status: 400, text: 'Invalid target URL' }));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Number(reqPayload.timeoutMs) || 7000);
      try {
        const upstream = await fetch(targetUrl, {
          method: reqPayload.method || 'GET',
          headers: reqPayload.headers || {},
          body: reqPayload.body !== undefined && reqPayload.body !== null ? String(reqPayload.body) : undefined,
          signal: ac.signal
        });
        const respText = await upstream.text();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            ok: upstream.ok,
            status: upstream.status,
            serverHeader: upstream.headers.get('server') || '',
            text: respText
          })
        );
      } finally {
        clearTimeout(timer);
      }
    } catch (proxyErr) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          ok: false,
          status: 0,
          text: proxyErr.message || 'LAN proxy connection failed'
        })
      );
    }
  }

  if (pathTokenMatch || legacyHlsMatch) {
    const streamId = Number(pathTokenMatch ? pathTokenMatch[2] : legacyHlsMatch[1]);
    const fileName = path.basename(pathTokenMatch ? pathTokenMatch[3] : legacyHlsMatch[2]);

    if (fileName === 'index.m3u8') {
      const manifestPath = await ensureStreamAwakeAndReady(streamId, 8500);
      if (!manifestPath) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('Headend stream warming up or Astra source offline');
      }
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const rewritten = pathTokenMatch
        ? raw.replace(/^(?!#)([^\r\n]+)$/gm, (m) => path.basename(m.trim()))
        : raw.replace(
            /^(?!#)([^\r\n]+)$/gm,
            (m) => `${path.basename(m.trim())}?token=${encodeURIComponent(HEADEND_TOKEN)}`
          );
      const buf = Buffer.from(rewritten, 'utf8');
      bytesSentWindow += buf.length;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store'
      });
      return res.end(buf);
    }

    const w = workers.get(streamId);
    if (w) w.lastAccessMs = Date.now();
    const segPath = path.join(HLS_ROOT, `stream_${streamId}`, fileName);
    if (!fs.existsSync(segPath)) {
      res.writeHead(404);
      return res.end('Segment not found');
    }
    const stat = fs.statSync(segPath);
    bytesSentWindow += stat.size;
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    return fs.createReadStream(segPath).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('TVLister Headend Node');
});

server.listen(HEADEND_PORT, '0.0.0.0', () => {
  console.log(
    `[HeadendAgent] Nodo Cabecera activo en 0.0.0.0:${HEADEND_PORT} | RAMDisk=${HLS_IS_RAMDISK} (${HLS_ROOT}) | FFmpeg=${FFMPEG_BIN}`
  );
  sendHeartbeatToCloud();
  setInterval(sendHeartbeatToCloud, 5000);
  setInterval(reconcileWorkers, 2000);
});

const shutdown = () => {
  for (const id of Array.from(workers.keys())) stopStreamWorker(id);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
