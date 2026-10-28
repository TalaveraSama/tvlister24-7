import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  HLS_ROOT,
  getFfmpegBin,
  isFfmpegAvailable,
  startSupervisedWorker,
  stopWorker,
  getWorkerPid,
  getFreshLocalHlsManifestPath
} from './streamEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SLATES_DIR = path.resolve(__dirname, '../data/slates');
fs.mkdirSync(SLATES_DIR, { recursive: true });

// Track last access per slate worker so unused custom slates auto-sleep after 10 min
const slateLastUsed = new Map(); // workerKey -> timestamp

setInterval(() => {
  const now = Date.now();
  for (const [workerKey, lastAt] of slateLastUsed.entries()) {
    if (now - lastAt > 10 * 60 * 1000) {
      stopWorker(workerKey);
      slateLastUsed.delete(workerKey);
    }
  }
}, 60_000).unref?.();

function detectMediaKindFromUrl(urlOrPath = '') {
  const clean = String(urlOrPath || '').split('?')[0].toLowerCase();
  if (/\.(png|jpe?g|webp|bmp|gif)$/.test(clean)) return 'image';
  return 'video';
}

function resolveSlateLocalOrRemoteInput(rawUrl = '') {
  const val = String(rawUrl || '').trim();
  if (!val) return '';
  if (val.startsWith('/slates/')) {
    const file = path.basename(val);
    return path.join(SLATES_DIR, file);
  }
  return val;
}

function hasAudioStream(inputPath) {
  if (!inputPath || /^https?:\/\//i.test(inputPath)) return true;
  try {
    const bin = getFfmpegBin();
    const ffprobeCand = bin.replace(/ffmpeg$/, 'ffprobe');
    if (ffprobeCand !== bin && fs.existsSync(ffprobeCand)) {
      const out = execFileSync(
        ffprobeCand,
        ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', inputPath],
        { encoding: 'utf8', timeout: 3000 }
      );
      return out.trim().length > 0;
    }
  } catch {
    // fallback assume silent audio safety needed if probe unavailable
  }
  return false;
}

export function getGlobalSlateConfig() {
  const rows = db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('offline_slate_enabled', 'offline_slate_type', 'offline_slate_url', 'offline_slate_text')"
    )
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: map.offline_slate_enabled !== 'false',
    type: map.offline_slate_type || 'builtin', // 'builtin' | 'image' | 'video'
    url: map.offline_slate_url || '',
    text: map.offline_slate_text || 'SEÑAL EN RECONEXIÓN - VOLVEMOS EN BREVE'
  };
}

export function resolveEffectiveSlateForStream(stream) {
  const mode = String(stream?.offline_slate_mode || 'global');
  if (mode === 'disabled' || mode === 'none') {
    return null;
  }

  if ((mode === 'custom_image' || mode === 'custom_video' || mode === 'custom') && stream?.offline_slate_url) {
    const input = resolveSlateLocalOrRemoteInput(stream.offline_slate_url);
    const kind =
      mode === 'custom_image'
        ? 'image'
        : mode === 'custom_video'
        ? 'video'
        : detectMediaKindFromUrl(stream.offline_slate_url);
    return { type: kind, input, rawUrl: stream.offline_slate_url };
  }

  const globalCfg = getGlobalSlateConfig();
  if (!globalCfg.enabled) return null;

  if ((globalCfg.type === 'image' || globalCfg.type === 'video') && globalCfg.url) {
    const input = resolveSlateLocalOrRemoteInput(globalCfg.url);
    if (!input.startsWith('/') || fs.existsSync(input)) {
      return {
        type: globalCfg.type,
        input,
        rawUrl: globalCfg.url
      };
    }
  }

  return { type: 'builtin', input: 'smptehdbars', rawUrl: '' };
}

function buildSlateFfmpegArgs(workerKey, spec) {
  const outDir = path.join(HLS_ROOT, workerKey);
  fs.mkdirSync(outDir, { recursive: true });

  const vfScale =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p';

  if (spec.type === 'image' && spec.input) {
    return [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-loop',
      '1',
      '-framerate',
      '25',
      '-i',
      spec.input,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-vf',
      vfScale,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'stillimage',
      '-b:v',
      '2000k',
      '-maxrate',
      '2500k',
      '-bufsize',
      '5000k',
      '-g',
      '50',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '44100',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+independent_segments',
      path.join(outDir, 'index.m3u8')
    ];
  }

  if (spec.type === 'video' && spec.input) {
    const withAudio = hasAudioStream(spec.input);
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-re',
      '-stream_loop',
      '-1',
      '-i',
      spec.input
    ];
    if (!withAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }
    args.push(
      '-map',
      '0:v:0',
      '-map',
      withAudio ? '0:a:0?' : '1:a:0',
      '-vf',
      vfScale,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-b:v',
      '2500k',
      '-maxrate',
      '2500k',
      '-bufsize',
      '5000k',
      '-g',
      '50',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '44100',
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

  // Built-in Broadcast HD Slate (SMPTE HD Bars + Stereo Silent Audio @ 2.5 Mbps)
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-re',
    '-f',
    'lavfi',
    '-i',
    'smptehdbars=size=1280x720:rate=25',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-b:v',
    '2000k',
    '-maxrate',
    '2500k',
    '-bufsize',
    '5000k',
    '-g',
    '50',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '6',
    '-hls_flags',
    'delete_segments+independent_segments',
    path.join(outDir, 'index.m3u8')
  ];
}

export async function ensureSlateManifestForStream(stream) {
  if (!isFfmpegAvailable()) return null;
  const spec = resolveEffectiveSlateForStream(stream);
  if (!spec) return null;

  const hash = crypto
    .createHash('md5')
    .update(`${spec.type}:${spec.input}`)
    .digest('hex')
    .slice(0, 10);
  const workerKey = `slate_${hash}`;
  slateLastUsed.set(workerKey, Date.now());

  let manifest = getFreshLocalHlsManifestPath(workerKey, 20);
  if (manifest && getWorkerPid(workerKey)) {
    return { workerKey, manifest, spec };
  }

  if (!getWorkerPid(workerKey)) {
    startSupervisedWorker(workerKey, () => buildSlateFfmpegArgs(workerKey, spec));
  }

  // Wait up to 4.5s on cold start for the first 2-second HLS segment to be written
  const deadline = Date.now() + 4500;
  while (Date.now() < deadline) {
    manifest = getFreshLocalHlsManifestPath(workerKey, 20);
    if (manifest) return { workerKey, manifest, spec };
    await new Promise((r) => setTimeout(r, 180));
  }

  manifest = getFreshLocalHlsManifestPath(workerKey, 30);
  return manifest ? { workerKey, manifest, spec } : null;
}

export function restartAllSlateWorkers() {
  for (const key of Array.from(slateLastUsed.keys())) {
    stopWorker(key);
    const dir = path.join(HLS_ROOT, key);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    slateLastUsed.delete(key);
  }
}

export function pipeSlateContinuousMpegTs(req, res, workerKey) {
  const dir = path.join(HLS_ROOT, workerKey);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-TVLister-Fallback', 'offline-slate-loop');

  let closed = false;
  let lastSentSeg = '';

  const pumpNextSegment = () => {
    if (closed || res.writableEnded) return;
    slateLastUsed.set(workerKey, Date.now());
    try {
      const manifestPath = path.join(dir, 'index.m3u8');
      if (fs.existsSync(manifestPath)) {
        const lines = fs
          .readFileSync(manifestPath, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        const latestSeg = lines[lines.length - 1];
        if (latestSeg && latestSeg !== lastSentSeg) {
          const segPath = path.join(dir, path.basename(latestSeg));
          if (fs.existsSync(segPath)) {
            lastSentSeg = latestSeg;
            const buf = fs.readFileSync(segPath);
            if (!res.writableEnded) res.write(buf);
          }
        }
      }
    } catch {
      // ignore transient read race
    }
  };

  pumpNextSegment();
  const timer = setInterval(pumpNextSegment, 1000);
  timer.unref?.();

  req.once('close', () => {
    closed = true;
    clearInterval(timer);
  });
}
