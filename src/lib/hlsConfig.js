/**
 * Configuración de hls.js para el reproductor del panel.
 *
 * El panel segmenta en 2 s × 6 segmentos (12 s de ventana, ver `-hls_time` /
 * `-hls_list_size` del Motor FFmpeg). Ese manifiesto NO es Low-Latency HLS: no
 * lleva `EXT-X-PART` ni `EXT-X-PRELOAD-HINT`. Activar `lowLatencyMode` con una
 * lista así hace que hls.js persiga el borde del directo, se quede sin segmento
 * siguiente y vuelva a pedir el mismo: microcortes con imagen congelada.
 *
 * Lo que hacemos es lo que hace XUI.one con su prebuffer: entrar unos segmentos
 * por detrás del borde (`liveSyncDurationCount`) y dejar que el propio jugador
 * se recupere con reintentos antes de declarar el error fatal.
 */

/** Ventana real que publica el motor (debe coincidir con el Motor FFmpeg). */
export const PANEL_HLS_SEGMENT_SECONDS = 2;
export const PANEL_HLS_LIST_SIZE = 6;

/**
 * @param {{ segmentSeconds?: number, listSize?: number, lowLatency?: boolean }} [opts]
 * @returns {import('hls.js').HlsConfig}
 */
export function buildHlsConfig(opts = {}) {
  const seg = Number(opts.segmentSeconds) > 0 ? Number(opts.segmentSeconds) : PANEL_HLS_SEGMENT_SECONDS;
  const listSize = Number(opts.listSize) > 0 ? Number(opts.listSize) : PANEL_HLS_LIST_SIZE;
  const windowSeconds = seg * listSize;

  // Entrar ~1/4 de la ventana por detrás del borde: sobra para que un segmento
  // lento no deje el buffer vacío y no se nota como retardo al zapear.
  const syncCount = Math.min(listSize - 1, Math.max(2, Math.round(listSize / 3)));

  return {
    enableWorker: true,
    // Ver cabecera: nuestra lista no es LL-HLS.
    lowLatencyMode: Boolean(opts.lowLatency),
    // Punto de entrada estable (equivalente al prebuffer de XUI.one).
    liveSyncDurationCount: syncCount,
    liveMaxLatencyDurationCount: listSize + 2,
    // Si el navegador se queda atrás, acelera suavemente en vez de saltar.
    maxLiveSyncPlaybackRate: 1.1,
    // Buffer acotado a la ventana: no acumulamos RAM en sesiones largas.
    maxBufferLength: Math.max(6, windowSeconds),
    maxMaxBufferLength: Math.max(12, windowSeconds * 2),
    backBufferLength: 30,
    liveDurationInfinity: true,
    startLevel: -1,
    testBandwidth: false,
    // Reintentos explícitos: un corte de red de pocos segundos no debe matar el canal.
    manifestLoadingTimeOut: 12000,
    manifestLoadingMaxRetry: 4,
    manifestLoadingRetryDelay: 1000,
    manifestLoadingMaxRetryTimeout: 10000,
    levelLoadingTimeOut: 12000,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 1000,
    levelLoadingMaxRetryTimeout: 12000,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 800,
    fragLoadingMaxRetryTimeout: 12000
  };
}
