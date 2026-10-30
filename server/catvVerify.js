/**
 * ============================================================================
 * COMPROBACIÓN DE LA SALIDA UDP / CATV
 * ----------------------------------------------------------------------------
 * Responde, con datos y no con teoría, a las tres preguntas de campo:
 *
 *   1. ¿El panel está enviando a la IP:puerto correcta de cada modulador?
 *   2. ¿El archivo que se sube al equipo lleva los datos que quiero cambiar?
 *      (nombres, IP y puerto sólo cambian si el CSV tiene esas columnas)
 *   3. ¿El equipo es alcanzable desde este servidor por la NIC configurada?
 *
 * Devuelve una lista de comprobaciones con `ok` y un texto accionable, para que
 * `tvlister-admin catv check` y el botón «Comprobar» del panel muestren lo mismo.
 * ============================================================================
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db.js';
import { DEFAULT_TV_STANDARD, getTvStandard } from './catvPlan.js';
import {
  getCatvStdChannelInfo,
  unitChannelList,
  resolveEffectiveBindIp,
  listHostIpv4Interfaces,
  computeDefaultUdpAddress
} from './wk2500Manager.js';
import { templateSummary } from './catvCsvTemplate.js';

const run = promisify(execFile);

/** ¿Tenemos ruta hacia esa IP y por qué interfaz sale? (sin privilegios) */
async function routeTo(ip) {
  try {
    const { stdout } = await run('ip', ['route', 'get', ip], { timeout: 2500 });
    const dev = (stdout.match(/\bdev\s+(\S+)/) || [])[1] || '';
    const src = (stdout.match(/\bsrc\s+(\S+)/) || [])[1] || '';
    const via = (stdout.match(/\bvia\s+(\S+)/) || [])[1] || '';
    return { ok: Boolean(dev), dev, src, via, raw: stdout.trim() };
  } catch (err) {
    return { ok: false, dev: '', src: '', via: '', error: err.message };
  }
}

/** Ping de 1 paquete: si el equipo responde, hay camino físico. Informativo. */
async function pingOnce(ip) {
  try {
    await run('ping', ['-c', '1', '-W', '1', '-n', ip], { timeout: 2500 });
    return { reached: true };
  } catch (err) {
    return { reached: false, error: (err.stderr || err.message || '').split('\n')[0] };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isMulticast = (ip = '') => {
  const first = Number(String(ip).trim().split('.')[0]);
  return first >= 224 && first <= 239;
};

/**
 * Estado en vivo de los workers UDP del motor CATV (lo rellena wk2500Manager).
 * Se guarda en globalThis para que funcione aunque los dos módulos se importen
 * en cualquier orden (hay dependencia circular entre ellos).
 */
function workerSnapshotFn() {
  const fn = globalThis.__tvlisterCatvWorkerSnapshot;
  return typeof fn === 'function' ? fn() : new Map();
}
export function setCatvWorkerSnapshot(fn) {
  if (typeof fn === 'function') globalThis.__tvlisterCatvWorkerSnapshot = fn;
}

function unitRows() {
  return db.prepare('SELECT * FROM wk2500_units ORDER BY id ASC').all();
}

/**
 * Comprueba un modulador (o todos si unitId es null).
 * Devuelve { generatedAt, units: [{ unit, template, carriers, checks, mappingText }] }
 */
export async function verifyCatv({ unitId = null, ping = true, workerSource = 'inline' } = {}) {
  const units = unitRows().filter((u) => (unitId ? Number(u.id) === Number(unitId) : true));
  if (unitId && !units.length) return { error: `No existe el equipo ${unitId}.` };

  const workers = workerSnapshotFn() || new Map();
  const interfaces = listHostIpv4Interfaces();
  const slotStmt = db.prepare(
    `SELECT w.*, s.name AS stream_name
       FROM wk2500_channels w
       LEFT JOIN streams s ON s.id = w.stream_id
      WHERE w.catv_ch = ?`
  );

  // Muestra de paquetes para calcular paquetes/s reales
  const sample1 = new Map();
  for (const [ch, w] of workers.entries()) sample1.set(ch, Number(w.packetsSent) || 0);
  await sleep(1200);
  const workers2 = workerSnapshotFn() || new Map();

  const out = [];
  for (const unit of units) {
    const channels = unitChannelList(unit);
    const template = templateSummary(unit);
    const carriers = channels.map((ch, idx) => {
      const row = slotStmt.get(ch) || {};
      const info = getCatvStdChannelInfo(ch, unit.tv_standard || DEFAULT_TV_STANDARD);
      const w = workers2.get(ch) || null;
      const before = sample1.has(ch) ? sample1.get(ch) : Number(w?.packetsSent || 0);
      const packets = Number(w?.packetsSent || 0);
      return {
        carrier: idx + 1,
        catv_ch: ch,
        freq_mhz: info.freq_mhz,
        audio_mhz: info.audio_mhz,
        standard: info.standard_short,
        udp_host: row.udp_host || '',
        udp_port: row.udp_port || 0,
        enabled: Boolean(row.enabled),
        name: row.custom_name || row.stream_name || `CH${ch}`,
        name_source: row.custom_name ? 'propio' : row.stream_name ? 'del canal' : 'por defecto',
        has_source: Boolean(row.stream_id || row.custom_source_url),
        bind_ip: resolveEffectiveBindIp(row) || '',
        worker: {
          status: w?.status || 'stopped',
          engine: w?.engine || '',
          bitrate_kbps: Number(w?.bitrateKbps || 0),
          packets_total: packets,
          packets_per_sec: w ? Math.max(0, packets - before) : 0,
          last_error: w?.lastError || ''
        }
      };
    });

    const checks = [];
    const add = (id, level, ok, title, detail = '') => checks.push({ id, level, ok, title, detail });

    // ---- 1. Qué puede cambiar el archivo que se sube al equipo ------------
    const mapped = template.saved ? template.mapped || [] : [];
    const hasNameCol = mapped.includes('name');
    const hasIpCol = mapped.includes('ip');
    const hasPortCol = mapped.includes('port');

    if (!template.saved) {
      add(
        'template',
        'warn',
        false,
        'Sin plantilla: «Import» entrega el formato compacto (6 columnas, sin nombre ni columnas propias)',
        'El formato compacto sólo lleva Portadora, Canal, MHz de vídeo y audio, IP y puerto. Si el equipo no cambia nada al importarlo, pulsa «Plantilla» y pega el CSV que exporta su propia web.'
      );
    } else {
      const missing = template.missing || [];
      add(
        'template',
        missing.length ? 'warn' : 'ok',
        true,
        `Plantilla del equipo cargada (${template.cols} columnas, separador «${template.delimiter === '\t' ? 'TAB' : template.delimiter}»)`,
        missing.length
          ? `No se reconocieron: ${missing.join(', ')}. Esas columnas conservan el valor del archivo del equipo.`
          : 'Cabecera, orden de columnas, separador y fin de línea son los del equipo.'
      );
    }

    // ¿El archivo puede cambiar los NOMBRES?
    if (!hasNameCol) {
      const custom = carriers.filter((c) => c.name_source === 'propio').length;
      add(
        'names',
        'warn',
        false,
        template.saved ? 'El archivo NO tiene columna de nombre' : 'El archivo compacto no lleva nombres',
        `Los nombres del modulador NO pueden cambiar por el CSV que estás subiendo.${
          custom ? ` Tienes ${custom} portadora(s) con nombre propio en el panel, pero el archivo no tiene dónde escribirlo.` : ''
        } Se cambian en la página de canales del propio equipo, o añade la columna de nombre a la plantilla.`
      );
    } else {
      const custom = carriers.filter((c) => c.name_source === 'propio').length;
      add(
        'names',
        'ok',
        true,
        'El archivo SÍ lleva nombres (columna reconocida)',
        custom
          ? `${custom} de ${carriers.length} portadoras tienen nombre propio en el panel; el resto salen como CHnn o con el nombre del canal de origen.`
          : 'Ninguna portadora tiene nombre propio en el panel: el CSV escribirá CHnn o el nombre del canal. Asígnalos en el plan para que el equipo muestre los tuyos.'
      );
    }

    // ¿El archivo puede cambiar la IP/puerto UDP?
    if (!hasIpCol || !hasPortCol) {
      add(
        'udp-columns',
        'warn',
        false,
        template.saved ? 'El archivo NO tiene columnas de IP y/o puerto UDP' : 'El formato compacto sí los lleva, pero en columnas propias',
        'Si el equipo no cambia la IP/puerto al importar, es porque esos datos se configuran en su página de entrada (Input / Mapping), no en la tabla de canales: usa la tabla de abajo para copiarlos ahí.'
      );
    } else {
      add('udp-columns', 'ok', true, 'El archivo SÍ lleva IP y puerto UDP', '');
    }

    // ---- 2. Destinos UDP del panel ---------------------------------------
    const targets = carriers.map((c) => `${c.udp_host}:${c.udp_port}`);
    const dup = targets.filter((t, i) => targets.indexOf(t) !== i);
    const invalid = carriers.filter((c) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(c.udp_host) || !c.udp_port);
    add(
      'udp-targets',
      invalid.length || dup.length ? 'error' : 'ok',
      !invalid.length && !dup.length,
      `${carriers.length} portadoras con destino UDP`,
      invalid.length
        ? `${invalid.length} sin IP/puerto válido.`
        : dup.length
        ? `Destino repetido: ${[...new Set(dup)].join(', ')} (dos canales al mismo socket no se pueden separar).`
        : `Todos distintos, del ${targets[0]} al ${targets[targets.length - 1]}.`
    );

    // Frecuencias coherentes (audio = vídeo + 4.5 en NTSC-M)
    const badOffset = carriers.filter((c) => Math.abs(c.audio_mhz - c.freq_mhz - 4.5) > 0.01);
    add(
      'freq',
      badOffset.length ? 'warn' : 'ok',
      !badOffset.length,
      `Frecuencias ${getTvStandard(unit.tv_standard || DEFAULT_TV_STANDARD).short}`,
      badOffset.length
        ? `${badOffset.length} portadoras con separación audio/vídeo distinta de 4.5 MHz.`
        : `Portadora 1 = CH${carriers[0]?.catv_ch} a ${carriers[0]?.freq_mhz} MHz · audio +4.5 MHz.`
    );

    // Destinos que no coinciden con la base de su modulador (plan a medio
    // aplicar: quedaron con la dirección de fábrica 239.25.0.x).
    const mismatched = carriers.filter((c) => {
      const unitRow = units.find((u) => Number(u.id) === Number(unit.id));
      if (!unitRow) return false;
      const expected = computeDefaultUdpAddress(
        c.catv_ch,
        unitRow.ip_mode,
        unitRow.dest_ip,
        unitRow.base_port
      );
      return c.udp_host !== expected.udp_host || Number(c.udp_port) !== Number(expected.udp_port);
    });
    if (mismatched.length) {
      add(
        'udp-mismatch',
        'error',
        false,
        `${mismatched.length} portadora(s) apuntan a un destino que no es el de este equipo`,
        `Ej.: CH${mismatched[0].catv_ch} → ${mismatched[0].udp_host}:${mismatched[0].udp_port}; según la base del equipo debería ser ` +
          `${computeDefaultUdpAddress(mismatched[0].catv_ch, unit.ip_mode, unit.dest_ip, unit.base_port).udp_host}:` +
          `${computeDefaultUdpAddress(mismatched[0].catv_ch, unit.ip_mode, unit.dest_ip, unit.base_port).udp_port}. ` +
          'Arréglalo con «tvlister-admin catv fill --apply» o reaplicando el equipo en el panel.'
      );
    }

    // ---- 3. Emisión real --------------------------------------------------
    // Se cuenta como entrega real si salieron paquetes en la muestra (aunque el
    // worker esté reconectando en ese instante).
    const running = carriers.filter((c) => c.worker.packets_per_sec > 0);
    const withSource = carriers.filter((c) => c.has_source);
    if (workerSource === 'external') {
      add(
        'emission',
        'info',
        true,
        'Emisión: se consulta en el panel (el motor corre en el servicio, no en este comando)',
        `${withSource.length} de ${carriers.length} portadoras tienen canal asignado. Para ver paquetes/s reales usa «Comprobar» en UDP / CATV.`
      );
    } else {
      add(
        'emission',
        running.length ? 'ok' : 'warn',
        running.length > 0,
        `${running.length} de ${carriers.length} portadoras están entregando paquetes UDP ahora`,
        withSource.length === 0
          ? 'Ninguna portadora tiene canal asignado: el panel no tiene nada que enviar al modulador.'
          : running.length === 0
          ? `Hay ${withSource.length} con canal asignado pero ninguna sale al aire. Pulsa «Iniciar» en el plan o revisa el origen.`
          : ''
      );
    }

    const errors = carriers.filter((c) => c.worker.last_error);
    if (errors.length) {
      add(
        'worker-errors',
        'error',
        false,
        `${errors.length} portadora(s) con error del motor`,
        errors
          .slice(0, 4)
          .map((c) => `CH${c.catv_ch}: ${c.worker.last_error}`)
          .join(' · ')
      );
    }

    // ---- 4. Alcance de red ------------------------------------------------
    const destIp = String(unit.dest_ip || '').trim();
    const multicastMode = String(unit.ip_mode || '') === 'multicast' || isMulticast(destIp);
    if (destIp) {
      const dedicated = String(unit.local_interface_ip || '').trim();
      const nic = interfaces.find((i) => i.address === dedicated);
      // Con multicast se consulta la ruta al GRUPO del primer canal, no a la base
      const probeIp = multicastMode ? carriers[0]?.udp_host || destIp : destIp;
      const route = await routeTo(probeIp);
      add(
        'route',
        route.ok ? 'ok' : 'error',
        route.ok,
        route.ok
          ? `Sale por ${route.dev}${multicastMode ? ` hacia el grupo ${probeIp}` : ` hacia ${destIp}`}`
          : `No hay ruta hacia ${probeIp}`,
        [
          route.via ? `gateway ${route.via}` : '',
          route.src ? `IP de origen ${route.src}` : '',
          dedicated
            ? `NIC del equipo: ${dedicated}${nic ? ` (${nic.name})` : ' — no está en este servidor'}`
            : 'NIC dedicada: automática (se usa la ruta del sistema)',
          route.ok && dedicated && route.src && route.src !== dedicated
            ? '⚠ sale con otra IP: si el modulador filtra por IP de origen, lo descartará.'
            : ''
        ]
          .filter(Boolean)
          .join(' · ')
      );

      // Varios equipos con la MISMA IP: en unicast es un conflicto, en multicast
      // es normal (cada equipo se queda con sus grupos).
      const twins = unitRows().filter(
        (u) => Number(u.id) !== Number(unit.id) && String(u.dest_ip || '').trim() === destIp
      );
      if (twins.length) {
        add(
          'shared-ip',
          multicastMode ? 'info' : 'error',
          multicastMode,
          multicastMode
            ? `${twins.length + 1} equipos comparten la base multicast ${destIp}`
            : `${twins.length + 1} equipos con la MISMA IP ${destIp} en modo unicast`,
          multicastMode
            ? 'Es correcto: cada portadora usa el grupo 239.1.1.<canal>. Cada modulador debe tener en su página de entrada SÓLO los grupos de sus portadoras.'
            : 'En unicast cada modulador necesita su propia IP: el switch entregaría el flujo al primero que la tenga.'
        );
      }

      if (multicastMode) {
        // Un grupo multicast no responde a ping: no tiene sentido intentarlo.
        const groups = carriers.map((c) => `${c.udp_host}:${c.udp_port}`);
        const ttl = Math.max(1, Number(unit.ttl) || 16);
        add(
          'multicast',
          'ok',
          true,
          `Multicast: ${carriers.length} grupos (${groups[0]} … ${groups[groups.length - 1]})`,
          `El panel EMITE a esos grupos; no se puede hacer ping a un grupo. Cada modulador debe tener en su página de entrada el grupo y puerto de sus portadoras (ver tabla de abajo) y unirse con IGMP. TTL configurado: ${ttl}.`
        );
        if (ttl < 2) {
          add(
            'ttl',
            'warn',
            false,
            `TTL ${ttl}: los paquetes mueren en el primer switch`,
            'Con TTL 1 sólo llegan al mismo segmento. Si el modulador está detrás de otro switch/router, sube el TTL del equipo (valor seguro: 16).'
          );
        }
      } else if (ping) {
        const p = await pingOnce(destIp);
        add(
          'reachability',
          p.reached ? 'ok' : 'warn',
          p.reached,
          p.reached ? `${destIp} responde a ping` : `${destIp} no responde a ping`,
          p.reached
            ? ''
            : 'Muchos moduladores bloquean ICMP: esto no prueba que estén caídos, sólo que no contestan. Comprueba en la web del equipo que la IP sea la correcta.'
        );
      }
    }

    // ---- 5. Qué puede cambiar cada página del equipo ---------------------
    add(
      'two-pages',
      'info',
      true,
      'El modulador tiene dos páginas: Canales y Entrada (Input/Mapping)',
      `Canales: ${carriers.length} filas con canal y frecuencia. Entrada: ${carriers.length} filas con grupo/IP y puerto UDP. ` +
        'El CSV de canales NO cambia la entrada; usa «CSV entrada UDP» para la otra página.'
    );

    out.push({
      unit: {
        id: unit.id,
        name: unit.name,
        dest_ip: unit.dest_ip,
        base_port: unit.base_port,
        ip_mode: unit.ip_mode,
        brand_model: unit.brand_model,
        tv_standard: unit.tv_standard,
        local_interface_ip: unit.local_interface_ip || '',
        enabled: Number(unit.enabled) !== 0
      },
      template,
      carriers,
      checks,
      // Tabla lista para copiar/pegar en la página de ENTRADA del equipo
      mappingText: carriers
        .map((c) => `P${c.carrier}\t${c.udp_host}\t${c.udp_port}\tCH${c.catv_ch}\t${c.name}`)
        .join('\n'),
      // Tabla para la página de CANALES del equipo
      channelText: carriers
        .map((c) => `P${c.carrier}\tCH${c.catv_ch}\t${c.freq_mhz}\t${c.audio_mhz}\t${c.name}`)
        .join('\n')
    });
  }

  return { generatedAt: new Date().toISOString(), units: out };
}

/** Resumen de una línea por equipo (para el CLI). */
export function summarize(checks = []) {
  return {
    ok: checks.filter((c) => c.ok).length,
    errors: checks.filter((c) => !c.ok && c.level === 'error').length,
    warns: checks.filter((c) => !c.ok && c.level === 'warn').length,
    total: checks.length
  };
}
