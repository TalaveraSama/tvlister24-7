/**
 * ============================================================================
 * ZAPPING RÁPIDO — dos palancas que NO tocan la línea de FFmpeg:
 *
 *  1) La playlist que recibe el reproductor se recorta a los últimos N segmentos
 *     (por defecto 2 = 4 s) en vez de los 6 del manifiesto interno. Los
 *     reproductores (hls.js, ExoPlayer/TiviMate, VLC) precargan ~3 segmentos por
 *     defecto: con ventana de 6 tardaban 6-12 s en mostrar imagen. Con 2 y
 *     EXT-X-START arrancan en el borde del directo.
 *
 *  2) Precarga de canales vecinos: al abrir el canal N se arranca el worker de
 *     N-1 y N+1 (si existen y no están corriendo), de modo que el siguiente
 *     zapeo encuentra el manifiesto ya escrito en RAMDisk. El recolector de
 *     canales "ondemand" los apaga solo a los 3 minutos sin espectadores.
 * ============================================================================
 */

/** Cabeceras de playlist que se conservan siempre. */
const KEEP_PREFIXES = [
  '#EXTM3U',
  '#EXT-X-VERSION',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-INDEPENDENT-SEGMENTS'
];

/**
 * Recorta un manifiesto HLS para el reproductor.
 *
 * @param {string} text        manifiesto tal como lo escribe FFmpeg
 * @param {object} opts
 * @param {number} opts.windowSegments  segmentos que verá el reproductor (1..12)
 * @param {number} opts.hlsTime         duración de segmento (para EXT-X-START)
 * @param {function} opts.rewriteUri    (nombreSegmento) => URL final
 * @returns {{ text: string, segments: number, mediaSequence: number }}
 */
export function buildPlayerPlaylist(text, { windowSegments = 2, hlsTime = 2, rewriteUri = (u) => u } = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const header = [];
  const entries = []; // { tag, uri }  (tag = #EXTINF + #EXT-X-* previos)
  let pending = [];
  let mediaSequence = 0;
  let hasExtXMap = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
      continue; // se reescribe más abajo
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) continue;
    if (line.startsWith('#EXT-X-ENDLIST')) continue; // es directo, nunca VOD
    if (line.startsWith('#EXT-X-MAP')) {
      // El init de fMP4 va una sola vez, en la cabecera (si no, se pierde al recortar)
      hasExtXMap = true;
      if (!header.includes(line)) header.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      if (KEEP_PREFIXES.includes(line.split(':')[0])) {
        header.push(line);
      } else {
        pending.push(line);
      }
      continue;
    }
    entries.push({ tag: pending, uri: line });
    pending = [];
  }

  if (entries.length === 0) {
    return { text: String(text || ''), segments: 0, mediaSequence };
  }

  const wanted = Math.max(1, Math.min(12, Number(windowSegments) || 2));
  const keep = entries.slice(Math.max(0, entries.length - wanted));
  const dropped = entries.length - keep.length;

  const out = [];
  // Cabecera base (sin MEDIA-SEQUENCE, que se recalcula)
  for (const h of header) {
    if (h.startsWith('#EXT-X-MEDIA-SEQUENCE')) continue;
    if (h.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) continue;
    out.push(h);
  }
  if (mediaSequence || dropped) out.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence + dropped}`);
  // Arranque en el borde: el reproductor no precarga media ventana hacia atrás.
  const offset = -Math.max(0.5, Math.min(hlsTime || 2, 2) * 0.5);
  out.push(`#EXT-X-START:TIME-OFFSET=${offset.toFixed(1)},PRECISE=NO`);

  for (const e of keep) {
    // Cada segmento nuevo conserva su #EXTINF y sus tags propios.
    for (const t of e.tag) {
      if (hasExtXMap && t.startsWith('#EXT-X-MAP')) continue; // el MAP va una sola vez en la cabecera
      out.push(t);
    }
    out.push(rewriteUri(e.uri));
  }

  return { text: out.join('\n') + '\n', segments: keep.length, mediaSequence: mediaSequence + dropped };
}

// ---------------------------------------------------------------------------
// Precarga de canales vecinos
// ---------------------------------------------------------------------------

const prewarmState = new Map(); // streamId -> { at, neighbours }
const prewarmStats = { triggered: 0, started: 0, skipped: 0, lastAt: null, lastFrom: null };

export function getPrewarmStats() {
  return { ...prewarmStats };
}

/**
 * Devuelve los canales vecinos (anterior y siguiente) de una lista ordenada.
 * `ordered` es un array de ids en el orden en que el abonado zapea.
 */
export function neighboursOf(ordered, streamId, count = 1) {
  const idx = ordered.indexOf(Number(streamId));
  if (idx < 0) return [];
  const out = [];
  for (let d = 1; d <= Math.max(1, count); d += 1) {
    const next = ordered[idx + d];
    const prev = ordered[idx - d];
    if (next !== undefined) out.push(next);
    if (prev !== undefined) out.push(prev);
  }
  return out;
}

/**
 * Arranca en segundo plano los workers de los canales vecinos.
 * Se llama al servir un canal en vivo; nunca bloquea la respuesta.
 *
 * @param {number} streamId  canal que el abonado acaba de abrir
 * @param {object} opts
 * @param {number} opts.count        vecinos por lado (0 = apagado)
 * @param {number} opts.maxExtra     máximo de workers extra vivos por precarga
 * @param {function} opts.listOrder  () => [ids ordenados como se zapea]
 * @param {function} opts.isRunning  (id) => boolean
 * @param {function} opts.start       (id) => void
 * @param {number} opts.cooldownMs
 */
export function prewarmNeighbours(streamId, opts = {}) {
  const {
    count = 1,
    maxExtra = 4,
    listOrder,
    isRunning,
    start,
    cooldownMs = 3_000,
    isRunningCount = null,
    maxRunningWorkers = 400
  } = opts;

  if (!count || typeof listOrder !== 'function' || typeof start !== 'function') return [];

  // Techo de seguridad: en instalaciones de 200+ canales la precarga no debe ser
  // la que dispare workers de más. Si ya hay muchos vivos, no se precarga nada.
  if (typeof isRunningCount === 'function' && isRunningCount() >= maxRunningWorkers) return [];

  const id = Number(streamId);
  const prev = prewarmState.get(id);
  if (prev && Date.now() - prev.at < cooldownMs) {
    prewarmStats.skipped += 1;
    return [];
  }

  let ordered = [];
  try {
    ordered = listOrder() || [];
  } catch {
    return [];
  }

  const targets = neighboursOf(ordered, id, count).filter((n) => n !== id);
  const startedNow = [];

  for (const target of targets) {
    if (startedNow.length >= maxExtra) break;
    let running = false;
    try {
      running = Boolean(isRunning(target));
    } catch {
      running = true; // ante la duda no se arranca nada
    }
    if (running) continue;
    try {
      start(target);
      startedNow.push(target);
    } catch {
      // el worker se supervisa solo; aquí no se rompe la respuesta del abonado
    }
  }

  prewarmState.set(id, { at: Date.now(), neighbours: targets });
  prewarmStats.triggered += 1;
  prewarmStats.started += startedNow.length;
  prewarmStats.lastAt = new Date().toISOString();
  prewarmStats.lastFrom = id;
  return startedNow;
}

export function resetPrewarmState() {
  prewarmState.clear();
}
