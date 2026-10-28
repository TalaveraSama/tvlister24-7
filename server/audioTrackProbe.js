import { execFile } from 'node:child_process';
import { db } from './db.js';
import {
  getFfmpegBin,
  isFfmpegAvailable,
  parseFfmpegAudioStreams,
  resolveFfmpegCompatibleCandidates
} from './streamEngine.js';

/**
 * Detecta las pistas de audio de un canal (idioma, códec, canales) sin descargar el stream completo.
 * Se usa para publicar el audio en ESPAÑOL cuando el origen trae 2 o más pistas (igual que XUI.one).
 */
function ffprobeTracks(inputUrl, stream, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!isFfmpegAvailable() || !inputUrl) return resolve([]);
    const bin = getFfmpegBin();
    const env = bin.startsWith('/home/xui/')
      ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
      : process.env;

    const args = ['-hide_banner', '-nostdin', '-threads', '1'];
    if (/^https?:\/\//i.test(inputUrl)) {
      args.push('-rw_timeout', '8000000', '-user_agent', stream.user_agent || 'TVLister/2.4');
    }
    args.push('-i', inputUrl);

    let stderr = '';
    let settled = false;
    const finish = (list) => {
      if (settled) return;
      settled = true;
      resolve(list);
    };

    let child;
    try {
      // Sin salida: FFmpeg imprime el listado de streams en stderr y termina con error (esperado)
      child = execFile(bin, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 }, (err, _stdout, errOut) => {
        stderr += String(errOut || '');
        finish(parseFfmpegAudioStreams(stderr));
      });
    } catch {
      return finish([]);
    }

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      // En cuanto vemos el primer bloque de audio ya no necesitamos esperar al timeout
      if (/Audio:/.test(stderr) && /Stream\s+#0:/.test(stderr)) {
        const list = parseFfmpegAudioStreams(stderr);
        if (list.length > 0) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          finish(list);
        }
      }
    });
    child.on('error', () => finish([]));
  });
}

/** Extrae las pistas de audio de un manifiesto HLS maestro (EXT-X-MEDIA TYPE=AUDIO + LANGUAGE). */
export function parseAudioRenditionsFromManifest(text = '') {
  const out = [];
  const re = /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const line = m[0];
    const lang = (line.match(/LANGUAGE="([^"]+)"/i) || [])[1] || '';
    const name = (line.match(/NAME="([^"]+)"/i) || [])[1] || '';
    const group = (line.match(/GROUP-ID="([^"]+)"/i) || [])[1] || '';
    out.push({ i: out.length, codec: 'aac', lang: String(lang).toLowerCase().slice(0, 3), channels: 2, name, group });
  }
  return out;
}

async function fetchManifestTracks(inputUrl, userAgent) {
  try {
    if (!/\.m3u8(\?|$)/i.test(String(inputUrl))) return [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    const res = await fetch(inputUrl, {
      headers: { 'User-Agent': userAgent || 'TVLister/2.4' },
      redirect: 'follow',
      signal: ac.signal
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return [];
    return parseAudioRenditionsFromManifest(text);
  } catch {
    return [];
  }
}

export async function probeStreamAudioLanguages(stream, timeoutMs = 12000) {
  if (!stream?.source_url) return [];
  const candidates = resolveFfmpegCompatibleCandidates(stream.source_url, '');
  const inputUrl = candidates[0] || stream.source_url;

  // 1) Manifiesto HLS maestro (Flussonic multi-audio publica EXT-X-MEDIA con LANGUAGE)
  const fromManifest = await fetchManifestTracks(inputUrl, stream.user_agent);
  if (fromManifest.length > 1) return fromManifest;

  // 2) PMT / listado de FFmpeg
  const fromPmt = await ffprobeTracks(inputUrl, stream, timeoutMs);
  if (fromPmt.length > 1) return fromPmt;

  // 3) Manifiesto con una sola pista declarada
  if (fromManifest.length === 1) return fromManifest;
  return fromPmt;
}

export async function detectAndStoreAudioLanguages(streamId) {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(Number(streamId));
  if (!stream) return { ok: false, error: 'Canal no encontrado' };

  const tracks = await probeStreamAudioLanguages(stream);
  const json = tracks.length > 0 ? JSON.stringify(tracks) : '';
  db.prepare('UPDATE streams SET detected_audio_langs = ? WHERE id = ?').run(json, stream.id);

  const langs = tracks.map((t) => t.lang).filter(Boolean);
  const spanish = tracks.find((t) => ['spa', 'es', 'esp'].includes(String(t.lang || '').toLowerCase()));
  return {
    ok: tracks.length > 0,
    streamId: stream.id,
    name: stream.name,
    tracks,
    languages: langs,
    spanishIndex: spanish ? spanish.i : null,
    multiAudio: tracks.length > 1
  };
}
