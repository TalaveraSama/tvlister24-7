/**
 * Medidor del ancho de banda de SALIDA del maestro.
 *
 * El balanceador necesita saber cuánto está sirviendo el propio panel para
 * decidir entre atender él mismo o mandar al cliente a un nodo balancer. Se
 * mide en el socket de cada respuesta (bytesWritten antes/después), así cuenta
 * igual un segmento HLS servido desde RAMDisk que un `pipe` del proxy.
 *
 * No guarda nada: una ventana deslizante en memoria de pocos segundos.
 */
const WINDOW_SEC = 20;
const BUCKETS = WINDOW_SEC; // 1 cubo por segundo

const buckets = new Array(BUCKETS).fill(0).map(() => ({ sec: 0, bytes: 0 }));
let lastSec = 0;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Suma bytes servidos a clientes. */
export function noteEgress(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return;
  const sec = nowSec();
  const slot = buckets[sec % BUCKETS];
  if (slot.sec !== sec) {
    slot.sec = sec;
    slot.bytes = 0;
  }
  slot.bytes += n;
  lastSec = sec;
}

/** Mbps de salida en los últimos `windowSec` segundos (0 si no hubo tráfico). */
export function getEgressMbps(windowSec = WINDOW_SEC) {
  const sec = nowSec();
  const from = sec - Math.max(1, Math.min(WINDOW_SEC, Number(windowSec) || WINDOW_SEC)) + 1;
  let bytes = 0;
  let seen = 0;
  for (const slot of buckets) {
    if (slot.sec >= from && slot.sec <= sec) {
      bytes += slot.bytes;
      seen += 1;
    }
  }
  if (seen === 0) return 0;
  return Number(((bytes * 8) / 1e6 / seen).toFixed(2));
}

/** Bytes totales movidos desde el arranque (para el resumen del panel). */
export function getEgressTotalBytes() {
  return buckets.reduce((acc, b) => acc + b.bytes, 0);
}

/**
 * Middleware de Express: mide los bytes de cada respuesta.
 * Se engancha al socket porque `pipe()` no pasa por `res.write` de forma
 * interceptable sin romper el backpressure.
 */
export function egressMeterMiddleware(req, res, next) {
  const socket = req.socket || req.connection;
  const start = socket && typeof socket.bytesWritten === 'number' ? socket.bytesWritten : 0;
  const done = () => {
    if (!socket || typeof socket.bytesWritten !== 'number') return;
    const delta = socket.bytesWritten - start;
    if (delta > 0) noteEgress(delta);
  };
  res.on('finish', done);
  res.on('close', done);
  next();
}
