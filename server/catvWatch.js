/**
 * ============================================================================
 * MEDICIÓN REAL DEL UDP QUE LLEGA A LOS MODULADORES (catv watch)
 * ----------------------------------------------------------------------------
 * El modulador muestra en su página de entrada una cifra de Mbps por grupo
 * multicast. Cuando esa cifra no coincide con el canal (p. ej. 30 Mbps para un
 * canal de 2–3 Mbps) hay dos causas posibles y sólo una es del panel:
 *
 *   a) el panel está enviando de más (fuente más gorda de lo que parece,
 *      ráfagas al recuperarse de un corte, o varios motores al mismo grupo);
 *   b) alguien MÁS está enviando al mismo grupo (Flussonic, otro TVLister,
 *      dos equipos apuntando a la misma dirección) y el modulador suma todo.
 *
 * Este módulo no teoriza: se une al grupo multicast como lo hace el modulador,
 * mide bytes y paquetes durante N segundos y los desglosa por PID. Además
 * cuenta paquetes DUPLICADOS (mismo continuity_counter repetido en el mismo
 * PID), que es la firma inequívoca de dos emisores sobre el mismo grupo.
 * ============================================================================
 */
import dgram from 'node:dgram';
import { db } from './db.js';
import { resolveEffectiveBindIp } from './wk2500Manager.js';

const CH_MIN = 2;
const CH_MAX = 125;

function isMulticast(ip = '') {
  const first = Number(String(ip).trim().split('.')[0]);
  return Number.isFinite(first) && first >= 224 && first <= 239;
}

function isUnicast(ip = '') {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  return !isMulticast(ip);
}

const hexPid = (pid) => `0x${Number(pid).toString(16).padStart(4, '0')}`;

/**
 * Clasifica la forma del flujo a partir del perfil de 500 ms.
 *
 * Es la pieza que traduce a lenguaje claro lo que el operador ve en la web del
 * modulador ("6, 10, 2 y de golpe 0"): casi nunca es que el canal gaste más o
 * menos, es que el flujo llega a trozos y la lectura instantánea depende de
 * cuándo se mire.
 */
function classifyPattern({ perBucketKbps = [], peak = 0, avgBucket = 0, idle = 0, burst = 0 }) {
  const n = perBucketKbps.length;
  if (!n || peak === 0) {
    return {
      id: 'none',
      label: 'no llega nada',
      meaning: 'El grupo no entra por esta interfaz o el canal no está emitiendo.'
    };
  }
  const idlePct = Math.round((idle / n) * 100);

  // ¿Llega "a trozos" o "se corta"? Se distinguen por la FORMA de los huecos:
  //   a trozos  -> ráfagas cortas (<= 1 s) y huecos de tamaño parecido, repetidos
  //   cortes    -> un hueco largo, o el flujo se para y no vuelve
  let run = 0;
  let longestRun = 0;
  let bursts = 0;
  let wasActive = false;
  for (const v of perBucketKbps) {
    if (v > 0) {
      run += 1;
      longestRun = Math.max(longestRun, run);
      if (!wasActive) bursts += 1;
      wasActive = true;
    } else {
      run = 0;
      wasActive = false;
    }
  }
  const shortBursts = longestRun <= 2;           // 2 tramos de 500 ms = 1 s
  const repeated = bursts >= 2;

  if (idlePct >= 40 && !(shortBursts && repeated)) {
    return {
      id: 'gaps',
      label: `cortes: ${idlePct}% del tiempo en 0`,
      meaning:
        'El flujo se queda sin datos a ratos largos. No es que llegue a trozos: el origen ' +
        'se corta, el canal se reinicia o el enlace no da el ancho de banda.'
    };
  }
  if (burst >= 2.5 || idlePct > 0) {
    return {
      id: 'chunky',
      label: `a trozos: ${bursts} entrega(s) corta(s), pico ${burst}× la media`,
      meaning:
        'El flujo llega por segmentos: entra de golpe (ese es el 6–10 que ves) y luego ' +
        'silencio (el 2 y el 0). La media es la correcta; lo que baila es la lectura ' +
        'instantánea. Se aplana con -re en la salida; si sigue, el origen entrega tarde.'
    };
  }
  if ((peak - avgBucket) / Math.max(1, avgBucket) <= 0.5) {
    return { id: 'steady', label: 'constante', meaning: 'Flujo estable: la lectura no debería bailar.' };
  }
  return {
    id: 'uneven',
    label: `irregular (pico ${burst}× la media)`,
    meaning: 'Varía sin llegar a cortarse: suele ser un GOP largo o el propio origen.'
  };
}



/**
 * Lee el nombre de servicio de la SDT de un paquete TS.
 * Estructura (EN 300 468): 0x42 | section_length | tsid | version | sec | last |
 * onid | reserved | [ service_id | flags | running+len | descriptores ] | CRC32
 * Descriptor 0x48 (service_descriptor): service_type | len_prov | proveedor |
 * len_nombre | nombre.
 */
function parseSdtName(buf, packetStart) {
  try {
    const ptr = buf[packetStart + 4];
    const off = packetStart + 5 + ptr;
    if (off + 12 > buf.length) return null;
    if (buf[off] !== 0x42 && buf[off] !== 0x46) return null;

    const sectionLen = ((buf[off + 1] & 0x0f) << 8) | buf[off + 2];
    const sectionEnd = Math.min(off + 3 + sectionLen - 4, buf.length); // sin CRC
    let p = off + 11;

    while (p + 5 <= sectionEnd) {
      const serviceId = (buf[p] << 8) | buf[p + 1];
      const loopLen = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
      let d = p + 5;
      const dEnd = Math.min(d + loopLen, sectionEnd);
      while (d + 2 <= dEnd) {
        const tag = buf[d];
        const len = buf[d + 1];
        if (tag === 0x48 && len >= 3) {
          let t = d + 3; // +2 cabecera del descriptor +1 service_type
          if (t >= dEnd) break;
          const provLen = buf[t];
          const provider = buf.toString('utf8', t + 1, Math.min(t + 1 + provLen, dEnd));
          const nameLenAt = t + 1 + provLen;
          if (nameLenAt >= dEnd) break;
          const nameLen = buf[nameLenAt];
          const name = buf.toString('utf8', nameLenAt + 1, Math.min(nameLenAt + 1 + nameLen, dEnd));
          return {
            service_id: serviceId,
            provider: cleanDvbText(provider),
            name: cleanDvbText(name),
            raw_provider: provider
          };
        }
        d += 2 + len;
      }
      p += 5 + loopLen;
    }
  } catch {
    // sección corrupta o partida: se ignora
  }
  return null;
}

/** Compara nombres sin acentos, mayúsculas ni espacios de más. */
function normalizeName(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Quita relleno y caracteres de control que algunos muxers dejan en la SDT. */
function cleanDvbText(text = '') {
  return String(text)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mide un grupo/IP:puerto UDP durante `seconds` segundos.
 *
 * @param {{host:string, port:number, seconds?:number, bindIp?:string}} opts
 * @returns {Promise<{ok:boolean, error?:string, host:string, port:number,
 *   seconds:number, mbps:number, kbps:number, datagrams:number, pps:number,
 *   bytes:number, pids:Array<{pid:number,label:string,kbps:number,packets:number}>,
 *   duplicatePct:number, duplicates:number, tei:number, payloadBytes:number}>}
 */
export function measureUdpStream({ host, port, seconds = 5, bindIp = '' }) {
  const target = String(host || '').trim();
  const udpPort = Number(port);
  const secs = Math.max(1, Math.min(60, Number(seconds) || 5));

  if (!target || !Number.isFinite(udpPort) || udpPort <= 0) {
    return Promise.resolve({
      ok: false,
      error: 'Destino UDP inválido',
      host: target,
      port: udpPort || 0,
      seconds: secs,
      mbps: 0,
      kbps: 0,
      peakKbps: 0,
      p95Kbps: 0,
      burstRatio: 0,
      jitterPct: 0,
      idleBuckets: 0,
      bucketMs: 500,
      profileKbps: [],
      pattern: { id: 'unknown', label: 'sin medición', meaning: '' },
      datagrams: 0,
      pps: 0,
      bytes: 0,
      pids: [],
      duplicatePct: 0,
      duplicates: 0,
      lost: 0,
      lossPct: 0,
      tei: 0,
      payloadBytes: 0,
      sdt: null
    });
  }

  const multicast = isMulticast(target);

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    try {
      // 8 MB de cola: a 30 Mbps (≈2.800 paquetes/s de 1316 B) la cola por
      // defecto de Linux (212 KB) se llena y la medición saldría corta.
      socket.setRecvBufferSize(8 * 1024 * 1024);
    } catch {
      // el kernel limita a net.core.rmem_max; se sigue con lo que haya
    }
    const stats = {
      bytes: 0,
      datagrams: 0,
      payloadBytes: 0,
      duplicates: 0,
      lost: 0,
      ccPackets: 0,
      tei: 0,
      resyncs: 0
    };
    /** @type {Map<number, {pid:number, bytes:number, packets:number, lastCc:number}>} */
    const perPid = new Map();
    const lastCc = new Map();
    // SDT (PID 0x11): es el nombre que el modulador muestra en su página de
    // entrada. Sin -metadata service_name, FFmpeg escribe "Service01"/"FFmpeg".
    let sdt = null;
    // Perfil temporal en tramas de 500 ms: es la única forma de ver que el
    // flujo llega "a saltos" aunque la media salga correcta. 500 ms es el
    // tamaño mínimo fiable: el kernel entrega los datagramas a Node por lotes
    // y con tramas de 100 ms se mediría el lote, no la red.
    const BUCKET_MS = 500;
    const startedAt = Date.now();
    /** @type {Map<number, number>} bytes por trama de 500 ms */
    const buckets = new Map();
    let finished = false;

    const onPacket = (buf) => {
      stats.bytes += buf.length;
      stats.datagrams += 1;

      const idx = Math.floor((Date.now() - startedAt) / BUCKET_MS);
      buckets.set(idx, (buckets.get(idx) || 0) + buf.length);

      // Un datagrama puede traer 1, 7 (1316) o 4 (752) paquetes TS, o llevar
      // FEC (204/208). Se recorre siempre a paso 188 buscando el byte 0x47.
      let pos = 0;
      const len = buf.length;
      while (pos + 188 <= len) {
        if (buf[pos] !== 0x47) {
          stats.resyncs += 1;
          pos += 1;
          continue;
        }
        const b1 = buf[pos + 1];
        const b2 = buf[pos + 2];
        const b3 = buf[pos + 3];
        const pid = ((b1 & 0x1f) << 8) | b2;
        const afc = (b3 >> 4) & 0x03;
        const cc = b3 & 0x0f;

        if (b1 & 0x80) stats.tei += 1;

        let entry = perPid.get(pid);
        if (!entry) {
          entry = { pid, bytes: 0, packets: 0 };
          perPid.set(pid, entry);
        }
        entry.bytes += 188;
        entry.packets += 1;
        stats.payloadBytes += 188;

        // Sólo tiene sentido comparar continuity_counter en paquetes con
        // payload (afc 1 ó 3); en los de sólo adaptación el CC se repite.
        // El PID nulo (0x1FFF) se excluye: en un mux CBR rellena con el mismo
        // contador y daría miles de falsos duplicados.
        if (!sdt && pid === 0x11 && (b1 & 0x40)) {
          sdt = parseSdtName(buf, pos) || null;
        }
        if (pid !== 0x1fff && (afc === 1 || afc === 3)) {
          stats.ccPackets += 1;
          const prev = lastCc.get(pid);
          if (prev !== undefined) {
            const delta = (cc - prev + 16) % 16;
            if (delta === 0) stats.duplicates += 1;
            else if (delta < 8) stats.lost += delta - 1; // huecos en el contador = pérdida
          }
          lastCc.set(pid, cc);
        }

        pos += 188;
      }
    };

    const finish = (error) => {
      if (finished) return;
      finished = true;
      try {
        if (multicast) socket.dropMembership(target);
      } catch {
        // ignore
      }
      try {
        socket.close();
      } catch {
        // ignore
      }

      // Perfil completo de la ventana medida, con ceros donde no llegó nada
      // (si no se rellena, un flujo que se corta a mitad parece "estable").
      const sliceCount = Math.max(1, Math.round((secs * 1000) / BUCKET_MS));
      const used = Array.from({ length: sliceCount }, (_, i) => buckets.get(i) || 0);
      const perBucketKbps = used.map((b) => Math.round((b * 8) / BUCKET_MS));
      const avgBucket = perBucketKbps.length
        ? perBucketKbps.reduce((a, b) => a + b, 0) / perBucketKbps.length
        : 0;
      const sortedB = [...perBucketKbps].sort((a, b) => a - b);
      const peak = sortedB.length ? sortedB[sortedB.length - 1] : 0;
      const p95 = sortedB.length ? sortedB[Math.min(sortedB.length - 1, Math.floor(sortedB.length * 0.95))] : 0;
      const idle = perBucketKbps.filter((v) => v === 0).length;
      const burst = avgBucket > 0 ? Number((peak / avgBucket).toFixed(2)) : 0;
      // Coeficiente de variación: cuánto oscila el flujo tramo a tramo.
      const variance = perBucketKbps.length
        ? perBucketKbps.reduce((acc, v) => acc + (v - avgBucket) ** 2, 0) / perBucketKbps.length
        : 0;
      const jitterPct = avgBucket > 0 ? Number(((Math.sqrt(variance) / avgBucket) * 100).toFixed(1)) : 0;

      const totalKbps = Math.round((stats.bytes * 8) / 1000 / secs);
      const pids = Array.from(perPid.values())
        .sort((a, b) => b.bytes - a.bytes)
        .map((p) => ({
          pid: p.pid,
          label: hexPid(p.pid),
          kbps: Math.round((p.bytes * 8) / 1000 / secs),
          packets: p.packets
        }));

      resolve({
        ok: !error,
        error: error || '',
        host: target,
        port: udpPort,
        seconds: secs,
        bytes: stats.bytes,
        datagrams: stats.datagrams,
        pps: Math.round(stats.datagrams / secs),
        kbps: totalKbps,
        mbps: Number((totalKbps / 1000).toFixed(2)),
        peakKbps: peak,
        p95Kbps: p95,
        burstRatio: burst,
        jitterPct,
        idleBuckets: idle,
        bucketMs: BUCKET_MS,
        // Perfil completo (kbps por trama de 500 ms): es lo que explica las
        // lecturas que saltan entre 6, 10, 2 y 0 en la web del equipo.
        profileKbps: perBucketKbps,
        pattern: classifyPattern({ perBucketKbps, peak, avgBucket, idle, burst }),
        pids,
        duplicates: stats.duplicates,
        lost: stats.lost,
        ccPackets: stats.ccPackets,
        duplicatePct: stats.ccPackets ? Number(((stats.duplicates / stats.ccPackets) * 100).toFixed(2)) : 0,
        lossPct: stats.ccPackets
          ? Number(((stats.lost / (stats.ccPackets + stats.lost)) * 100).toFixed(2))
          : 0,
        tei: stats.tei,
        payloadBytes: stats.payloadBytes,
        resyncs: stats.resyncs,
        sdt
      });
    };

    socket.on('error', (err) => {
      let msg = err?.message || 'Error de socket UDP';
      if (err?.code === 'EACCES') {
        msg = `Puerto ${udpPort} privilegiado (<1024): ejecuta el comando como root (sudo)`;
      } else if (err?.code === 'EADDRINUSE') {
        msg = `Puerto ${udpPort} ocupado por otro proceso en este servidor`;
      } else if (err?.code === 'ENODEV' || err?.code === 'ENOPROTOOPT') {
        msg = `Esta NIC no puede unirse al grupo ${target} (revisa la IP de --ip)`;
      }
      finish(msg);
    });

    socket.bind(udpPort, '0.0.0.0', () => {
      try {
        if (multicast) {
          // Unirse por la NIC concreta evita el clásico "0 Mbps" cuando el
          // servidor tiene varias tarjetas y el grupo vive en otra VLAN.
          if (bindIp) socket.addMembership(target, bindIp);
          else socket.addMembership(target);
          socket.setMulticastLoopback(true);
        }
      } catch (err) {
        finish(err.message || 'No se pudo unir al grupo multicast');
        return;
      }
      setTimeout(() => finish(''), secs * 1000);
    });

    socket.on('message', (buf) => {
      if (!finished) onPacket(buf);
    });
  });
}

/** Canales del plan que se van a medir, con su equipo y su nombre. */
export function listWatchableChannels({ unitId = null, channels = null } = {}) {
  const slots = db
    .prepare(
      `SELECT w.catv_ch, w.stream_id, w.custom_name, w.custom_source_url, w.udp_host,
              w.udp_port, w.enabled, w.unit_id, w.ttl, w.local_interface_ip,
              w.output_mode, w.muxrate_kbps,
              s.name AS stream_name, s.source_url AS stream_source_url,
              s.bitrate_kbps AS stream_bitrate
       FROM wk2500_channels w
       LEFT JOIN streams s ON s.id = w.stream_id
       WHERE w.catv_ch BETWEEN ? AND ?
       ORDER BY w.catv_ch ASC`
    )
    .all(CH_MIN, CH_MAX);

  const units = db.prepare('SELECT * FROM wk2500_units ORDER BY id ASC').all();
  const unitById = new Map(units.map((u) => [Number(u.id), u]));

  let wanted = null;
  if (Array.isArray(channels) && channels.length) {
    wanted = new Set(channels.map((c) => Number(c)).filter((n) => n >= CH_MIN && n <= CH_MAX));
  }

  const rows = slots
    .filter((r) => (wanted ? wanted.has(Number(r.catv_ch)) : true))
    .filter((r) => {
      if (unitId) {
        const uid = Number(r.unit_id) || null;
        if (uid !== Number(unitId)) return false;
      }
      // Para el uso normal sólo interesan los canales que deberían emitir.
      if (wanted) return true;
      return Boolean(r.enabled) && Boolean(r.stream_id || r.custom_source_url);
    })
    .map((r) => {
      const unit = unitById.get(Number(r.unit_id)) || null;
      return {
        ...r,
        enabled: Boolean(r.enabled),
        unit_name: unit ? unit.name : '',
        unit_dest_ip: unit ? unit.dest_ip : '',
        name: r.custom_name || r.stream_name || `CH ${r.catv_ch}`,
        source: r.custom_source_url || r.stream_source_url || '',
        declared_kbps: Number(r.stream_bitrate) || 0,
        bind_ip: r.local_interface_ip || (unit ? '' : '')
      };
    });

  // Destinos repetidos: dos canales al mismo grupo hacen que el modulador sume
  // los dos flujos y vea el doble (o el triple) de Mbps en una sola portadora.
  const byDest = new Map();
  for (const r of rows) {
    const key = `${r.udp_host}:${r.udp_port}`;
    if (!byDest.has(key)) byDest.set(key, []);
    byDest.get(key).push(Number(r.catv_ch));
  }

  return {
    rows: rows.map((r) => {
      const key = `${r.udp_host}:${r.udp_port}`;
      const sharedWith = (byDest.get(key) || []).filter((c) => c !== Number(r.catv_ch));
      return { ...r, shared_with: sharedWith };
    }),
    units
  };
}

/** Ejecuta la medición de todos los canales pedidos, uno por uno. */
export async function watchCatvOutput({ unitId = null, channels = null, seconds = 5, bindIp = '' } = {}) {
  const { rows, units } = listWatchableChannels({ unitId, channels });
  if (!rows.length) {
    return {
      error: 'No hay canales con origen asignado y habilitados para medir.',
      seconds,
      bindIp: bindIp || '',
      unitCount: 0,
      results: [],
      summary: null
    };
  }

  const results = [];
  for (const row of rows) {
    const iface = bindIp || resolveEffectiveBindIp(row) || '';
    const m = await measureUdpStream({
      host: row.udp_host,
      port: row.udp_port,
      seconds,
      bindIp: iface
    });

    const flags = [];
    if (!m.ok) flags.push({ level: 'error', text: m.error || 'sin medición' });
    if (m.ok && m.kbps === 0) flags.push({ level: 'error', text: 'NO LLEGA NADA' });
    if (m.ok && m.kbps > 0 && row.declared_kbps > 0) {
      const ratio = m.kbps / row.declared_kbps;
      if (ratio >= 2) {
        flags.push({ level: 'error', text: `EXCESO ${ratio.toFixed(1)}× lo declarado` });
      } else if (ratio <= 0.5) {
        flags.push({ level: 'warn', text: `por debajo de lo declarado (${ratio.toFixed(2)}×)` });
      }
    }
    if (m.ok && m.duplicatePct >= 1) {
      flags.push({ level: 'error', text: `${m.duplicatePct.toFixed(1)}% PAQUETES DUPLICADOS` });
    }
    // El modulador enseña el nombre de la SDT, no el del CSV. Si sigue siendo
    // el genérico de FFmpeg ("Service01"/"FFmpeg") es que la salida se montó
    // sin -metadata service_name.
    const expectedName = String(row.name || `CANAL ${row.catv_ch}`).trim();
    if (m.ok && m.sdt) {
      const got = String(m.sdt.name || '').trim();
      if (!got || /^service\s*\d*$/i.test(got)) {
        flags.push({
          level: 'error',
          text: `el TS lleva el nombre genérico "${got || '(vacío)'}" en vez de "${expectedName}"`
        });
      } else if (normalizeName(got) !== normalizeName(expectedName)) {
        flags.push({ level: 'warn', text: `nombre DVB "${got}" distinto del canal "${expectedName}"` });
      }
    } else if (m.ok && m.kbps > 0 && !m.sdt) {
      flags.push({ level: 'warn', text: 'el TS no trae SDT: el modulador no podrá mostrar nombre' });
    }
    if (row.shared_with.length) {
      flags.push({ level: 'error', text: `mismo destino que CH ${row.shared_with.join(', ')}` });
    }
    if (m.ok && m.tei > 0) flags.push({ level: 'warn', text: `${m.tei} paquetes con error` });
    if (m.ok && m.kbps > 0 && m.burstRatio >= 2.5) {
      flags.push({
        level: 'error',
        text: `RÁFAGAS: pico ${(m.peakKbps / 1000).toFixed(2)} Mbps = ${m.burstRatio}× la media`
      });
    } else if (m.ok && m.kbps > 0 && m.jitterPct >= 90) {
      flags.push({ level: 'warn', text: `flujo inestable: oscilación ${m.jitterPct}%` });
    }
    if (m.ok && m.kbps > 0 && m.idleBuckets > 0) {
      flags.push({ level: 'warn', text: `${m.idleBuckets} tramo(s) de ${m.bucketMs} ms sin datos` });
    }
    if (m.ok && m.lossPct >= 2) {
      flags.push({ level: 'warn', text: `captura incompleta (${m.lossPct}%): el valor real es algo mayor` });
    }

    results.push({ ...row, interface_ip: iface, measured: m, flags });
  }

  const totalKbps = results.reduce((acc, r) => acc + (r.measured.ok ? r.measured.kbps : 0), 0);
  const over = results.filter((r) => r.flags.some((f) => f.level === 'error'));
  const summary = {
    channels: results.length,
    total_kbps: totalKbps,
    total_mbps: Number((totalKbps / 1000).toFixed(2)),
    average_kbps: results.length ? Math.round(totalKbps / results.length) : 0,
    max_kbps: results.reduce((acc, r) => Math.max(acc, r.measured.kbps || 0), 0),
    min_kbps: results.reduce((acc, r) => Math.min(acc, r.measured.ok ? r.measured.kbps : Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER),
    with_problems: over.length,
    units: units.length
  };
  if (summary.min_kbps === Number.MAX_SAFE_INTEGER) summary.min_kbps = 0;

  return { error: '', seconds, bindIp: bindIp || '', unitCount: units.length, results, summary };
}

export const CATV_WATCH_CH_MIN = CH_MIN;
export const CATV_WATCH_CH_MAX = CH_MAX;
export { isUnicast, isMulticast };
