import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import {
  HLS_ROOT,
  resolveHlsDirForKey,
  createHlsSegmentTailer,
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

// Respaldo SOLO por canal: la imagen/video en bucle que el administrador activa a mano en ese canal.
// Ya no existe el bucle global del panel (configuración única para todos los canales).
export function resolveEffectiveSlateForStream(stream) {
  const mode = String(stream?.offline_slate_mode || 'disabled');
  if (mode !== 'custom_image' && mode !== 'custom_video' && mode !== 'custom') {
    return null;
  }
  const rawUrl = String(stream?.offline_slate_url || '').trim();
  if (!rawUrl) return null;

  const input = resolveSlateLocalOrRemoteInput(rawUrl);
  // Un archivo local borrado no debe dejar el canal en negro: se considera sin respaldo.
  if (input.startsWith('/') && !fs.existsSync(input)) return null;

  const kind =
    mode === 'custom_image' ? 'image' : mode === 'custom_video' ? 'video' : detectMediaKindFromUrl(rawUrl);
  return { type: kind, input, rawUrl };
}

function buildSlateFfmpegArgs(workerKey, spec) {
  const outDir = resolveHlsDirForKey(workerKey);
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

  // Solo existen respaldos por canal (imagen o video propio); sin respaldo no se genera nada.
  return null;
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
    const dir = resolveHlsDirForKey(key);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    slateLastUsed.delete(key);
  }
}

export function pipeSlateContinuousMpegTs(req, res, workerKey) {
  const dir = resolveHlsDirForKey(workerKey);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-TVLister-Fallback', 'offline-slate-loop');

  slateLastUsed.set(workerKey, Date.now());
  const touch = setInterval(() => slateLastUsed.set(workerKey, Date.now()), 30000);
  touch.unref?.();

  // Tailer ORDENADO: cada segmento del slate se envía una sola vez y en orden
  // (el pump anterior repetía el último segmento cada segundo y cortaba la reproducción)
  const tailer = createHlsSegmentTailer({
    manifestPath: path.join(dir, 'index.m3u8'),
    intervalMs: 250,
    burstSegments: 2,
    onChunk: (chunk) => {
      if (!res.writableEnded) res.write(chunk);
    }
  });

  req.once('close', () => {
    clearInterval(touch);
    tailer.stop();
  });
}
