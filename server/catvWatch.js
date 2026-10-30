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
      datagrams: 0,
      pps: 0,
      bytes: 0,
      pids: [],
      duplicatePct: 0,
      duplicates: 0,
      lost: 0,
      lossPct: 0,
      tei: 0,
      payloadBytes: 0
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
    let finished = false;

    const onPacket = (buf) => {
      stats.bytes += buf.length;
      stats.datagrams += 1;

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
        if (afc === 1 || afc === 3) {
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
        resyncs: stats.resyncs
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
    if (row.shared_with.length) {
      flags.push({ level: 'error', text: `mismo destino que CH ${row.shared_with.join(', ')}` });
    }
    if (m.ok && m.tei > 0) flags.push({ level: 'warn', text: `${m.tei} paquetes con error` });
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
