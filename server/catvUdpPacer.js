/**
 * ============================================================================
 * ESTABILIZADOR DE SALIDA UDP PARA LOS MODULADORES CATV (WK2500 / analógicos)
 * ----------------------------------------------------------------------------
 * El síntoma de campo: un canal de 2 Mbps que en el modulador aparece con
 * ráfagas de 33 Mbps. La media es correcta; lo que no es constante es la
 * entrega. Pasa porque el origen entrega a trozos —un segmento HLS de 2 s
 * llega en 30 ms, una ráfaga MNF de 1 MB entra de golpe— y el panel lo
 * reenvía al socket tal cual. El modulador mide su entrada por ventanas y ve
 * la ráfaga, no la media.
 *
 * `-re` en FFmpeg dosifica la LECTURA del origen, pero lo leído se escribe de
 * golpe al socket y el buffer del kernel (la URL de salida llevaba
 * `buffer_size=1048576`, o sea 4 s de un canal de 2 Mbps) termina saliendo a
 * la velocidad del enlace. Eso es exactamente el pico de ~33 Mbps: 1 MB
 * vaciándose en ~250 ms.
 *
 * Esto es lo que hace Astra/Cesbo: un reloj propio en el socket. Los bytes se
 * encolan y se emiten con un cubo de fichas al ritmo del canal; cuando el
 * origen va por debajo se rellena con paquetes nulos de MPEG-TS (PID 0x1FFF),
 * así la entrada del modulador es una línea plana y el canal nunca se queda
 * "sin portadora de datos".
 *
 * Reglas de diseño:
 *   · Nunca se emite por encima del objetivo (eso es lo que mata las ráfagas).
 *   · Si el origen entrega más de la cuenta, la cola absorbe y el objetivo
 *     sube (control por cola): no se pierde ni un paquete de vídeo.
 *   · Si el origen entrega menos, se rellena con nulos (CBR), como Astra.
 *   · Contrapresión real: quien alimenta el pacer (`push`) puede esperar con
 *     `drain()` en vez de tirar datos, así ni el pipe de FFmpeg ni el socket
 *     HTTP se desbocan.
 * ============================================================================
 */
import dgram from 'node:dgram';

const TS_PACKET = 188;
const NULL_PID = 0x1fff;

/** Paquete TS nulo (PID 0x1FFF, payload 0xFF): relleno estándar de un mux CBR. */
export function buildNullTsPacket() {
  const p = Buffer.alloc(TS_PACKET, 0xff);
  p[0] = 0x47;
  p[1] = 0x1f;
  p[2] = 0xff;
  p[3] = 0x10;
  return p;
}

/** Datagrama completo de nulos del tamaño pedido (1316 = 7 × 188). */
export function buildNullDatagram(pktSize = 1316) {
  const out = Buffer.alloc(pktSize);
  for (let off = 0; off < pktSize; off += TS_PACKET) {
    buildNullTsPacket().copy(out, off, 0, Math.min(TS_PACKET, pktSize - off));
  }
  return out;
}

export class CatvUdpPacer {
  /**
   * @param {object} opts
   * @param {string} opts.host            Destino UDP (multicast o unicast)
   * @param {number} opts.port            Puerto destino
   * @param {string} [opts.bindIp]        NIC dedicada de salida
   * @param {number} [opts.ttl]           TTL para multicast
   * @param {number} [opts.pktSize]       188 o 1316
   * @param {boolean} [opts.rtp]          Envolver en RTP (MPEG-TS, PT 33)
   * @param {number} [opts.targetKbps]    Ritmo fijo (muxrate del canal). 0 = automático
   * @param {boolean} [opts.autoTarget]   Ajustar el objetivo al ritmo real del origen
   * @param {boolean} [opts.fill]         Rellenar con nulos hasta el objetivo (CBR)
   * @param {number} [opts.headroom]      Margen sobre el ritmo medido (1.10 = +10 %)
   * @param {number} [opts.minKbps]       Suelo del objetivo automático
   * @param {number} [opts.tickMs]        Periodo del reloj de salida
   * @param {number} [opts.maxQueueMs]    Cola máxima antes de subir el objetivo
   * @param {(buf: Buffer) => void} [opts.send]  Emisor propio (pruebas)
   */
  constructor(opts = {}) {
    this.host = String(opts.host || '').trim();
    this.port = Number(opts.port) || 0;
    this.bindIp = String(opts.bindIp || '').trim();
    this.ttl = Math.max(1, Number(opts.ttl) || 16);
    this.pktSize = Number(opts.pktSize) === 188 ? 188 : 1316;
    this.rtp = Boolean(opts.rtp);
    this.fixedKbps = Math.max(0, Number(opts.targetKbps) || 0);
    this.autoTarget = opts.autoTarget !== false && this.fixedKbps === 0;
    this.fill = opts.fill !== false;
    this.headroom = Number(opts.headroom) > 1 ? Number(opts.headroom) : 1.1;
    this.minKbps = Math.max(100, Number(opts.minKbps) || 800);
    this.tickMs = Math.min(50, Math.max(1, Number(opts.tickMs) || 4));
    this.maxQueueMs = Math.max(500, Number(opts.maxQueueMs) || 4000);
    this.lowWaterMs = Math.max(100, Math.min(this.maxQueueMs / 2, Number(opts.lowWaterMs) || 800));

    // Cola de bytes MPEG-TS alineada a 188. Se guarda como lista de trozos
    // (no un Buffer que se recompone en cada push) para que 100 canales a
    // 2 Mbps no gasten CPU copiando la cola entera cada 1,3 KB.
    this.queue = [];
    this.queuedBytes = 0;
    this.rest = Buffer.alloc(0);
    this.tokens = 0;
    this.lastTickNs = process.hrtime.bigint();

    this.autoKbps = this.fixedKbps || Math.max(this.minKbps, Number(opts.initialKbps) || 3000);
    this.boostKbps = 0;
    this.arrivalKbps = 0;
    this.smoothArrivalKbps = 0;
    // Ritmo real del origen medido en ventanas de 500 ms (10 s de memoria):
    // con una fuente a trozos, el promedio de 10 s es el bitrate verdadero.
    this.arrivalBucket = 0;
    this.arrivalBuckets = [];
    this.arrivalBucketMs = 500;
    this.arrivalWindowSec = Math.max(6, Number(opts.arrivalWindowSec) || 20);
    this.lastArrivalAtMs = Date.now();
    this.settled = false;
    this.firstPushAtMs = 0;
    this.lastPayloadAtMs = 0;

    // Telemetría
    this.sentBytes = 0;
    this.sentPayloadBytes = 0;
    this.datagrams = 0;
    this.nullDatagrams = 0;
    this.payloadDatagrams = 0;
    this.socketErrors = 0;
    this.lastError = '';
    this.windowBytes = 0;
    this.subWindowBytes = 0;
    this.lastRateAtMs = Date.now();
    this.lastSubAtMs = Date.now();
    this.recentKbps = [];
    this.sentKbps = 0;
    this.peakKbps = 0;
    this.maxPeakKbps = 0;

    // RTP (MPEG-TS sobre RTP: PT 33, reloj de 90 kHz)
    this.rtpSeq = Math.floor(Math.random() * 0xffff);
    this.rtpTs = Math.floor(Math.random() * 0xffffffff);
    this.rtpSsrc = Math.floor(Math.random() * 0xffffffff);

    this.sendFn = typeof opts.send === 'function' ? opts.send : null;
    this.socket = null;
    this.ready = Boolean(this.sendFn);
    this.stopped = false;
    this.drainWaiters = [];
    this.timer = null;

    this.nullDatagram = buildNullDatagram(this.pktSize);

    if (opts.autoStart !== false) this.start();
  }

  /** Objetivo real que se está aplicando (kbps). */
  get targetKbps() {
    return this.fixedKbps > 0 ? this.fixedKbps : this.autoKbps;
  }

  get queueMs() {
    // bytes × 8 bits / kbps = milisegundos de vídeo esperando en la cola
    return Math.round((this.queuedBytes * 8) / Math.max(1, this.targetKbps));
  }

  get highWaterBytes() {
    return Math.round(((this.maxQueueMs / 1000) * this.targetKbps * 1000) / 8);
  }

  get lowWaterBytes() {
    return Math.round(((this.lowWaterMs / 1000) * this.targetKbps * 1000) / 8);
  }

  start() {
    if (this.stopped || this.timer) return;
    if (!this.sendFn) {
      this._ensureSocket().then(() => {
        this.ready = true;
        this.lastTickNs = process.hrtime.bigint();
        this.tokens = 0;
      }).catch((err) => {
        this.lastError = String(err?.message || err).slice(0, 160);
      });
    }
    this.lastTickNs = process.hrtime.bigint();
    this.lastRateAtMs = Date.now();
    this.lastSubAtMs = Date.now();
    const loop = () => {
      if (this.stopped) return;
      try {
        this._tick();
      } catch (err) {
        this.lastError = String(err?.message || err).slice(0, 160);
      }
      // Reloj con compensación de deriva: el siguiente tick se programa sobre
      // el anterior, no sobre "ahora", para que no se acumule retraso.
      this.nextAtMs = (this.nextAtMs || Date.now()) + this.tickMs;
      const wait = Math.max(0, this.nextAtMs - Date.now());
      this.timer = setTimeout(loop, wait);
      this.timer.unref?.();
    };
    this.nextAtMs = Date.now() + this.tickMs;
    this.timer = setTimeout(loop, this.tickMs);
    this.timer.unref?.();
  }

  _ensureSocket() {
    if (this.sendFn) return;
    if (this.socket) return;
    if (!this.host || !this.port) throw new Error('Destino UDP sin host/puerto');
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (err) => {
      this.socketErrors += 1;
      this.lastError = String(err?.message || err).slice(0, 160);
    });
    // 256 KB: el pacer ya entrega al ritmo correcto, no hace falta una cola de
    // 1 MB (era justo lo que permitía el pico de 33 Mbps).
    try {
      socket.setSendBufferSize(256 * 1024);
    } catch {
      // opción no soportada: se sigue con la del sistema
    }
    return new Promise((resolve, reject) => {
      const onErr = (err) => reject(err);
      socket.once('error', onErr);
      socket.bind(0, this.bindIp || '0.0.0.0', () => {
        socket.removeListener('error', onErr);
        try {
          if (this.ttl > 1) socket.setMulticastTTL(this.ttl);
          if (this.bindIp) socket.setMulticastInterface(this.bindIp);
        } catch {
          // opciones no críticas
        }
        resolve();
      });
    });
  }

  /**
   * Encola MPEG-TS. Devuelve `false` cuando la cola pasó el máximo: quien
   * alimenta debe esperar `drain()` en vez de seguir metiendo datos.
   */
  push(chunk) {
    if (!chunk || chunk.length === 0 || this.stopped) return true;
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const usable = data.length - (data.length % TS_PACKET);
    if (usable > 0) {
      // Copia: quien alimenta puede reutilizar su memoria (chunks del socket).
      this.queue.push({ buf: Buffer.from(data.subarray(0, usable)), off: 0 });
      this.queuedBytes += usable;
      this.lastPayloadAtMs = Date.now();
      if (!this.firstPushAtMs) this.firstPushAtMs = Date.now();
    }
    this.rest = data.length > usable ? Buffer.from(data.subarray(usable)) : Buffer.alloc(0);
    this.arrivalBucket += chunk.length;
    if (this.firstPushAtMs && !this.settled && Date.now() - this.firstPushAtMs > 1200) {
      this.settled = true;
    }
    return !this.needsDrain();
  }

  /** Saca exactamente `n` bytes alineados de la cola (sin recomponer nada). */
  _take(n) {
    if (this.queuedBytes < n) return null;
    const head = this.queue[0];
    const avail = head.buf.length - head.off;
    let out;
    if (avail >= n) {
      out = head.buf.subarray(head.off, head.off + n);
      head.off += n;
      if (head.off >= head.buf.length) this.queue.shift();
    } else {
      out = Buffer.allocUnsafe(n);
      let copied = 0;
      while (copied < n && this.queue.length) {
        const c = this.queue[0];
        const take = Math.min(n - copied, c.buf.length - c.off);
        c.buf.copy(out, copied, c.off, c.off + take);
        copied += take;
        c.off += take;
        if (c.off >= c.buf.length) this.queue.shift();
      }
    }
    this.queuedBytes -= n;
    return out;
  }

  needsDrain() {
    return this.queuedBytes > this.highWaterBytes;
  }

  /** Espera a que la cola baje del nivel bajo (contrapresión sin pérdidas). */
  drain(timeoutMs = 15000) {
    if (!this.needsDrain()) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { resolve: null, timer: null };
      waiter.resolve = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve();
      };
      waiter.timer = setTimeout(waiter.resolve, timeoutMs);
      waiter.timer.unref?.();
      this.drainWaiters.push(waiter);
    });
  }

  _resolveDrains() {
    if (!this.drainWaiters.length) return;
    if (this.queuedBytes > this.lowWaterBytes) return;
    const list = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of list) w.resolve();
  }

  _wrapRtp(payload) {
    const head = Buffer.allocUnsafe(12);
    head[0] = 0x80;
    head[1] = 33; // MPEG-TS
    head.writeUInt16BE(this.rtpSeq & 0xffff, 2);
    head.writeUInt32BE(this.rtpTs >>> 0, 4);
    head.writeUInt32BE(this.rtpSsrc >>> 0, 8);
    this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
    // 90 kHz: el tiempo que tarda el payload al ritmo del objetivo.
    this.rtpTs = (this.rtpTs + Math.round((90000 * payload.length * 8) / Math.max(1, this.targetKbps * 1000))) >>> 0;
    return Buffer.concat([head, payload]);
  }

  _emit(payload) {
    const dg = this.rtp ? this._wrapRtp(payload) : payload;
    this.sentBytes += dg.length;
    this.sentPayloadBytes += payload.length;
    this.datagrams += 1;
    this.windowBytes += dg.length;
    this.subWindowBytes += dg.length;
    if (this.sendFn) {
      try {
        this.sendFn(dg);
      } catch (err) {
        this.socketErrors += 1;
        this.lastError = String(err?.message || err).slice(0, 160);
      }
      return;
    }
    try {
      this.socket.send(dg, 0, dg.length, this.port, this.host, (err) => {
        if (err) {
          this.socketErrors += 1;
          this.lastError = String(err?.message || err).slice(0, 160);
        }
      });
    } catch (err) {
      this.socketErrors += 1;
      this.lastError = String(err?.message || err).slice(0, 160);
    }
  }

  _tick() {
    if (!this.ready) return; // socket aún sin enlazar: no se emite a ciegas
    const nowNs = process.hrtime.bigint();
    let elapsedMs = Number(nowNs - this.lastTickNs) / 1e6;
    this.lastTickNs = nowNs;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = this.tickMs;
    if (elapsedMs > 500) elapsedMs = 500; // pausa larga (suspensión): no vaciar de golpe

    const target = this.targetKbps;
    const bytesPerMs = (target * 1000) / 8 / 1000;
    // Crédito acumulado: si el bucle de eventos se retrasa (SQLite, HTTP, otros
    // canales), el pacer NO pierde ritmo; paga la deuda en los ticks siguientes.
    // La deuda se limita a 0,5 s y cada tick emite como mucho 20 ms de datos:
    // así un retraso de 100 ms no se convierte nunca en una ráfaga grande.
    this.tokens = Math.min(this.tokens + bytesPerMs * elapsedMs, bytesPerMs * 500);
    let budget = Math.min(this.tokens, Math.max(this.pktSize, bytesPerMs * 20));

    let guard = 0;
    while (budget >= this.pktSize && guard < 4096) {
      guard += 1;
      let payload = null;
      const taken = this._take(this.pktSize);
      if (taken) {
        payload = taken;
        this.payloadDatagrams += 1;
      } else if (this.fill && this.settled) {
        // Sin datos suficientes: se mantiene la portadora con nulos (CBR).
        payload = this.nullDatagram;
        this.nullDatagrams += 1;
      } else {
        break;
      }
      this._emit(payload);
      this.tokens -= this.pktSize;
      budget -= this.pktSize;
    }

    this._tickTelemetry();
    this._resolveDrains();
  }

  _tickTelemetry() {
    const now = Date.now();
    if (now - this.lastSubAtMs >= 250) {
      const kbps = Math.round((this.subWindowBytes * 8) / (now - this.lastSubAtMs));
      this.recentKbps.push(kbps);
      if (this.recentKbps.length > 8) this.recentKbps.shift(); // 2 s de memoria
      this.peakKbps = Math.max(...this.recentKbps);
      this.maxPeakKbps = Math.max(this.maxPeakKbps, kbps);
      this.subWindowBytes = 0;
      this.lastSubAtMs = now;
    }
    this._sampleArrival(now);
    if (now - this.lastRateAtMs >= 1000) {
      this.sentKbps = Math.round((this.windowBytes * 8) / (now - this.lastRateAtMs));
      this.windowBytes = 0;
      this.lastRateAtMs = now;
      this._retune(now);
    }
  }

  /** Ajusta el objetivo al ritmo real del origen (ventana de 10 s, sin bailar). */
  /**
   * Ritmo real del origen: media de una ventana deslizante de 20 s en tramas de
   * 500 ms. Una fuente que entrega a trozos (segmento de 2 s, ráfaga de 4 s)
   * da exactamente su bitrate medio en una ventana así, sin rizado. Es la base
   * del objetivo automático.
   */
  _sampleArrival(now) {
    if (now - this.lastArrivalAtMs < this.arrivalBucketMs) return;
    const maxBuckets = Math.round((this.arrivalWindowSec * 1000) / this.arrivalBucketMs);
    this.arrivalBuckets.push(this.arrivalBucket);
    if (this.arrivalBuckets.length > maxBuckets) this.arrivalBuckets.shift();
    this.arrivalBucket = 0;
    this.lastArrivalAtMs = now;
    const bytes = this.arrivalBuckets.reduce((a, b) => a + b, 0);
    if (this.arrivalBuckets.length >= 12) {
      // kbps = bytes × 8 bits / (tramas × 0,5 s) / 1000
      this.arrivalKbps = Math.round((bytes * 8) / (this.arrivalBuckets.length * this.arrivalBucketMs));
    }
  }

  _retune(now) {
    if (this.firstPushAtMs && !this.settled && now - this.firstPushAtMs > 1200) this.settled = true;

    if (this.fixedKbps > 0) return; // muxrate fijo: manda el operador
    if (!this.autoTarget) return;

    // El promedio de la ventana se suaviza antes de mover el objetivo: la
    // fuente real no es perfectamente periódica y un salto cada segundo se
    // vería como escalones en el modulador.
    if (this.arrivalKbps > 0) {
      this.smoothArrivalKbps = this.smoothArrivalKbps
        ? this.smoothArrivalKbps * 0.75 + this.arrivalKbps * 0.25
        : this.arrivalKbps;
    }
    const base = this.smoothArrivalKbps > 0 ? this.smoothArrivalKbps * this.headroom : this.autoKbps;
    // El refuerzo por cola se deshace solo cuando la cola vuelve a estar sana.
    this.boostKbps =
      this.queuedBytes > this.highWaterBytes ? Math.max(this.boostKbps, this.targetKbps * 1.15) : this.boostKbps * 0.9;
    const desired = Math.max(this.minKbps, Math.round(Math.max(base, this.boostKbps) / 50) * 50);
    const changed = Math.abs(desired - this.autoKbps) / Math.max(1, this.targetKbps);
    if (changed > 0.08) this.autoKbps = desired;
  }

  stats() {
    const idleMs = this.lastPayloadAtMs ? Date.now() - this.lastPayloadAtMs : 0;
    return {
      target_kbps: this.targetKbps,
      target_mode: this.fixedKbps > 0 ? 'fijo' : 'automático',
      sent_kbps: this.sentKbps,
      peak_kbps: this.peakKbps,
      max_peak_kbps: this.maxPeakKbps,
      // pico / media: 1.00 = plano; > 1.25 = todavía hay ráfagas
      burst_ratio: this.sentKbps > 0 ? Math.round((this.peakKbps / this.sentKbps) * 100) / 100 : 0,
      steady: this.sentKbps > 0 ? this.peakKbps <= this.sentKbps * 1.25 : false,
      queue_kb: Math.round(this.queuedBytes / 1024),
      queue_ms: Math.round(this.queueMs),
      datagrams: this.datagrams,
      payload_datagrams: this.payloadDatagrams,
      null_pct: this.datagrams ? Math.round((this.nullDatagrams / this.datagrams) * 100) : 0,
      sent_bytes: this.sentBytes,
      sent_payload_bytes: this.sentPayloadBytes,
      idle_payload_ms: idleMs,
      settled: this.settled,
      rtp: this.rtp,
      pkt_size: this.pktSize,
      socket_errors: this.socketErrors,
      last_error: this.lastError
    };
  }

  /** Alimenta con un Buffer de MPEG-TS ya alineado a 188 (o lo alinea). */
  async feed(chunk) {
    this.push(chunk);
    if (this.needsDrain()) await this.drain();
  }

  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.drainWaiters) w.resolve();
    this.drainWaiters = [];
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ya cerrado
      }
      this.socket = null;
    }
  }
}

/**
 * Crea el pacer de un canal CATV a partir de su fila y del transporte
 * efectivo (tamaño de datagrama / RTP). Devuelve `null` si el estabilizador
 * está desactivado por entorno (TVLISTER_CATV_PACER=off).
 */
export function createCatvPacer({ slotRow = {}, transport = {}, bindIp = '', onSend = null } = {}) {
  const off = String(process.env.TVLISTER_CATV_PACER ?? '').trim().toLowerCase();
  if (off === '0' || off === 'off' || off === 'false' || off === 'no') return null;
  const targetKbps = Math.max(0, Number(slotRow.muxrate_kbps) || 0);
  const queueMs = Number(process.env.TVLISTER_CATV_PACER_QUEUE_MS) || 4000;
  const pacer = new CatvUdpPacer({
    host: slotRow.udp_host,
    port: slotRow.udp_port,
    bindIp,
    ttl: slotRow.ttl,
    pktSize: transport.pktSize || 1316,
    rtp: Boolean(transport.rtp),
    targetKbps,
    autoTarget: targetKbps === 0,
    fill: process.env.TVLISTER_CATV_PACER_FILL !== '0',
    maxQueueMs: queueMs,
    send: onSend || null,
    autoStart: false
  });
  // Firma de la configuración: si el destino, el tamaño de datagrama, RTP o el
  // muxrate cambian, el motor recrea el pacer en vez de seguir con el viejo.
  pacer.key = `${slotRow.udp_host}:${slotRow.udp_port}:${transport.pktSize || 1316}:${transport.rtp ? 1 : 0}:${targetKbps}`;
  return pacer;
}

export default CatvUdpPacer;
