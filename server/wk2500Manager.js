import dgram from 'node:dgram';
import {
  TV_STANDARDS,
  TV_STANDARD_IDS,
  DEFAULT_TV_STANDARD,
  MODULATOR_BRANDS,
  PKT_SIZES,
  getTvStandard,
  getModulatorBrand,
  getCatvChannelInfo,
  maxChannelForStandard,
  standardCoverage
} from './catvPlan.js';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import { db, withSqliteBusyRetry } from './db.js';
import { buildTemplate, renderTemplate, templateSummary, parseCsv } from './catvCsvTemplate.js';
import { verifyCatv, setCatvWorkerSnapshot } from './catvVerify.js';
import { requireAuth, requireAdmin } from './auth.js';
import { MnfToTsRemuxer } from './mnfProtocol.js';
import {
  getFfmpegBin,
  isFfmpegAvailable,
  buildAudioLevelingFilter,
  getFreshLocalHlsManifestPath
} from './streamEngine.js';
import { resolveFlussonicUrlCandidates } from './flussonicImporter.js';

export const wk2500Router = express.Router();

// Active 24/7 UDP workers keyed by CATV channel number (2..125)
const udpWorkers = new Map();

/**
 * Official EIA/CEA-542 NTSC-M Standard (STD) Cable TV Frequency Plan — Channels 2 through 125.
 * 6 MHz channel bandwidth; Visual Carrier = Lower Band Edge + 1.25 MHz; Audio Carrier = Visual + 4.50 MHz.
 */
export function getCatvStdChannelInfo(catvCh, standardId = DEFAULT_TV_STANDARD, overrideMhz = null) {
  // El plan vive en server/catvPlan.js: NTSC-M (EIA-542) o PAL (CCIR/CENELEC),
  // con la separación de audio propia de cada estándar.
  return getCatvChannelInfo(catvCh, standardId, overrideMhz);
}

/**
 * Transporte efectivo del canal: el canal puede heredar del equipo (0 / -1)
 * o forzar su propio tamaño de datagrama y RTP.
 */
export function resolveEffectiveTransport(slotRow = {}, unitRow = null) {
  const unitPkt = Number(unitRow?.pkt_size || 0) || 1316;
  const unitRtp = Number(unitRow?.rtp || 0) === 1;
  const ownPkt = Number(slotRow?.pkt_size || 0);
  const ownRtp = Number(slotRow?.rtp ?? -1);
  const pktSize = PKT_SIZES.includes(ownPkt) ? ownPkt : PKT_SIZES.includes(unitPkt) ? unitPkt : 1316;
  const rtp = ownRtp === 0 || ownRtp === 1 ? ownRtp === 1 : unitRtp;
  return { pktSize, rtp };
}

/** Equipo al que pertenece un canal (por unit_id o por rango). */
function unitForSlot(slotRow = {}) {
  if (slotRow.unit_id) {
    const byId = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(Number(slotRow.unit_id));
    if (byId) return byId;
  }
  // La pertenencia se resuelve con la lista de canales del equipo (puede no ser un rango contiguo).
  const ch = Number(slotRow.catv_ch) || 0;
  const units = db.prepare('SELECT * FROM wk2500_units WHERE enabled = 1 ORDER BY ch_start ASC, id ASC').all();
  return units.find((u) => unitChannelSet(u).has(ch)) || null;
}

/** Estándar de TV efectivo del canal (el del equipo; NTSC-M si no hay equipo). */
function standardForSlot(slotRow = {}, unitRow = null) {
  const unit = unitRow || unitForSlot(slotRow);
  return getTvStandard(unit?.tv_standard || DEFAULT_TV_STANDARD);
}

export function computeDefaultUdpAddress(catvCh, ipMode = 'multicast', destIp = '239.25.0.0', basePort = 5000) {
  const ch = Number(catvCh);
  const port = (Number(basePort) || 5000) + ch;
  const cleanIp = String(destIp || '').trim() || '239.25.0.0';

  if (ipMode === 'unicast') {
    return { udp_host: cleanIp, udp_port: port };
  }

  // Multicast mode: replace 4th octet with CATV channel number (e.g. 239.25.0.2 .. 239.25.0.125)
  const parts = cleanIp.split('.');
  if (parts.length === 4) {
    parts[3] = String(ch);
    return { udp_host: parts.join('.'), udp_port: port };
  }
  return { udp_host: `239.25.0.${ch}`, udp_port: port };
}

export function ensureCatvSlotsInitialized() {
  const count = db.prepare('SELECT COUNT(*) as c FROM wk2500_channels').get()?.c || 0;
  if (count >= 124) return;

  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO wk2500_channels (
           catv_ch, freq_mhz, band_label, udp_host, udp_port, ttl, output_mode, service_id, enabled
         ) VALUES (?, ?, ?, ?, ?, 16, 'direct_spts', ?, 0)`
      );
      for (let ch = 2; ch <= 125; ch++) {
        const info = getCatvStdChannelInfo(ch);
        const addr = computeDefaultUdpAddress(ch, 'multicast', '239.25.0.0', 5000);
        ins.run(ch, info.freq_mhz, info.band_label, addr.udp_host, addr.udp_port, ch);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });
}

function isMulticastIp(ip = '') {
  const first = Number(String(ip).trim().split('.')[0]);
  return first >= 224 && first <= 239;
}

export const WK2500_OUTPUT_MODES = ['direct_spts', 'copy_mp2_leveled', 'copy_aac_leveled', 'ntsc_sd_wk2500'];

/**
 * Modelos reales de modulador WK2500: cambian sólo la CANTIDAD de canales de
 * salida que puede generar cada equipo, no la grilla CATV (siempre 2..125).
 *   WK2500-32  -> 32 canales   (p. ej. CH 2..33)
 *   WK2500-64  -> 64 canales   (p. ej. CH 2..65)
 *   WK2500-125 -> 124 canales  (CH 2..125, grilla completa)
 */
export const WK2500_MODELS = [
  { id: 'wk2500_32', label: 'WK2500 · 32 canales', channels: 32, hint: '32 salidas RF (suele cubrir CH 2–33)' },
  { id: 'wk2500_64', label: 'WK2500 · 64 canales', channels: 64, hint: '64 salidas RF (suele cubrir CH 2–65)' },
  { id: 'wk2500_125', label: 'WK2500 · 125 canales', channels: 125, hint: 'Grilla completa CH 2–125' }
];
export const WK2500_MODEL_CHANNELS = WK2500_MODELS.map((m) => m.channels);

export const CATV_MIN_CH = 2;
export const CATV_MAX_CH = 125;
export const CATV_TOTAL_SLOTS = CATV_MAX_CH - CATV_MIN_CH + 1; // 124

function modelInfoFor(modelChannels) {
  const n = Number(modelChannels);
  return WK2500_MODELS.find((m) => m.channels === n) || null;
}

function clampCh(n, fallback = CATV_MIN_CH) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(CATV_MIN_CH, Math.min(CATV_MAX_CH, Math.trunc(v)));
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Number(aStart) <= Number(bEnd) && Number(bStart) <= Number(aEnd);
}

function describeRanges(units = []) {
  return units
    .map((u) => {
      const list = unitChannelList(u);
      const text = channelListText(list);
      const label = list.length > 1 && list[list.length - 1] - list[0] === list.length - 1
        ? `CH ${list[0]}–${list[list.length - 1]}`
        : `CH ${text}`;
      return `${label} (${u.name})`;
    })
    .join(', ');
}

/**
 * Lista explícita de canales de un equipo, en el ORDEN de sus portadoras RF.
 * `channels_json` guarda ese orden tal cual lo escribió el operador
 * (ej. ["95", 2..28, "96".."99"] -> portadora 1 = CH95).
 * Sin lista explícita se usa el rango contiguo ch_start..ch_end.
 */
export function unitChannelList(unit = {}) {
  const raw = unit?.channels_json;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        // Un array (aunque venga vacío) es intencional: [] = equipo sin canales asignados.
        return arr.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= CATV_MIN_CH && n <= CATV_MAX_CH);
      }
    } catch {
      // JSON corrupto: cae al rango
    }
  }
  const start = Number(unit?.ch_start);
  const end = Number(unit?.ch_end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
  const out = [];
  for (let ch = start; ch <= end; ch++) out.push(ch);
  return out;
}

/**
 * Vista pública de un equipo: lista de canales en orden de portadora, texto compacto
 * y el mapa portadora -> canal/frecuencia/UDP que se usa en la UI y en el CSV.
 */
export function unitPublicView(unit = {}) {
  const channels = unitChannelList(unit);
  const carriers = channels.map((ch, idx) => {
    const info = getCatvStdChannelInfo(ch, unit.tv_standard || DEFAULT_TV_STANDARD);
    const addr = computeDefaultUdpAddress(ch, unit.ip_mode, unit.dest_ip, unit.base_port);
    return {
      carrier: idx + 1,
      catv_ch: ch,
      freq_mhz: info.freq_mhz,
      audio_mhz: info.audio_mhz,
      band_label: info.band_label,
      udp_host: addr.udp_host,
      udp_port: addr.udp_port
    };
  });
  const contiguous = channels.length > 1 && channels[channels.length - 1] - channels[0] === channels.length - 1;
  const freqs = carriers.map((c) => c.freq_mhz).filter((f) => f > 0);
  return {
    channels,
    channels_text: channelListText(channels),
    channels_input: orderedListText(channels),
    carriers,
    carrier_count: carriers.length,
    free_carriers: Math.max(0, unitCapacity(unit) - carriers.length),
    explicit_list: Boolean(unit.channels_json),
    contiguous,
    range_label: channels.length
      ? contiguous
        ? `CH ${channels[0]}–${channels[channels.length - 1]}`
        : `CH ${orderedListText(channels)}`
      : 'sin canales',
    first_udp: carriers[0] ? { udp_host: carriers[0].udp_host, udp_port: carriers[0].udp_port } : null,
    last_udp: carriers.length
      ? { udp_host: carriers[carriers.length - 1].udp_host, udp_port: carriers[carriers.length - 1].udp_port }
      : null,
    range_freq: {
      from_mhz: freqs.length ? Math.min(...freqs) : 0,
      to_mhz: freqs.length ? Math.max(...freqs) : 0
    },
    // ¿Ya se guardó el CSV real del equipo? La UI lo usa para el botón Import.
    csv_template: templateSummary(unit)
  };
}

/** Set de canales del equipo (para cobertura y enrutado UDP). */
function unitChannelSet(unit = {}) {
  return new Set(unitChannelList(unit));
}

/**
 * Acepta lista de canales en varios formatos y devuelve un array ordenado:
 *   [95, 2, 3, ...]            (array de números)
 *   [95, [2,28], ...]          (array mixto con rangos)
 *   "95, 2-28, 96-99"          (texto con rangos y comas/espacios/puntos y coma)
 *   "1:95, 2-28"               (opcionalmente con el número de portadora delante)
 */
export function parseChannelList(input) {
  const out = [];
  const push = (n) => {
    const v = Number(n);
    if (Number.isInteger(v) && v >= CATV_MIN_CH && v <= CATV_MAX_CH && !out.includes(v)) out.push(v);
  };

  if (input === null || input === undefined || input === '') return out;

  if (Array.isArray(input)) {
    for (const item of input) {
      if (Array.isArray(item) && item.length >= 2) {
        const a = Number(item[0]);
        const b = Number(item[1]);
        if (Number.isInteger(a) && Number.isInteger(b) && b >= a) {
          for (let ch = a; ch <= b; ch++) push(ch);
        }
      } else {
        push(item);
      }
    }
    return out;
  }

  const text = String(input).replace(/;/g, ',');
  for (const chunk of text.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    // "P1:95" / "1:95" / "95"
    const body = part.includes(':') ? part.split(':').pop().trim() : part;
    const range = body.match(/^(\d{1,3})\s*(?:-|–|\.\.|a)\s*(\d{1,3})$/i);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b >= a) for (let ch = a; ch <= b; ch++) push(ch);
      continue;
    }
    if (/^\d{1,3}$/.test(body)) push(Number(body));
  }
  return out;
}

/**
 * Texto compacto de una lista de canales RESPETANDO el orden recibido.
 * [95,2,3,4,96] -> "95, 2-4, 96" (la primera siempre es la portadora 1).
 * Es el texto que se vuelve a cargar en el formulario: si se ordenara, el
 * operador perdería el orden de las portadoras al editar.
 */
function orderedListText(list = []) {
  if (!list.length) return '';
  const out = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j += 1;
    out.push(i === j ? `${list[i]}` : `${list[i]}-${list[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** Texto compacto de una lista de canales: [95,2,3,4,96] -> "95, 2–4, 96". */
function channelListText(list = []) {
  if (!list.length) return '';
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  const out = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }
  return out.join(', ');
}

function isValidIpv4(ip = '') {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

// Valida el destino UDP antes de guardarlo: un host/puerto inválido o repetido deja el canal sin señal
// en el modulador (o peor, mezcla dos TS en el mismo grupo:grupo/puerto del WK2500).
function validateWk2500UdpTarget({ udp_host, udp_port, catv_ch = null }) {
  const host = String(udp_host || '').trim();
  const port = Number(udp_port);
  if (!isValidIpv4(host)) {
    return { error: `La IP destino UDP "${host}" no es una IPv4 válida (ejemplo multicast: 239.25.0.20).` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `El puerto UDP ${udp_port} no es válido: debe ser un entero entre 1 y 65535.` };
  }
  const clash = db
    .prepare('SELECT catv_ch FROM wk2500_channels WHERE udp_host = ? AND udp_port = ? AND catv_ch != ? LIMIT 1')
    .get(host, port, Number(catv_ch) || 0);
  if (clash) {
    return {
      error: `El destino ${host}:${port} ya lo usa el Canal CATV ${clash.catv_ch}. Dos canales en el mismo host:puerto mezclan dos TS y el modulador recibe basura; usa otro puerto.`,
      status: 409
    };
  }
  return { ok: true, host, port };
}

function validateWk2500OutputMode(mode = '') {
  const clean = String(mode || 'direct_spts');
  return WK2500_OUTPUT_MODES.includes(clean) ? clean : null;
}

function readSysNetAttr(ifName, attr) {
  try {
    return fs.readFileSync(`/sys/class/net/${ifName}/${attr}`, 'utf8').trim();
  } catch {
    return '';
  }
}

export function listHostIpv4Interfaces() {
  const nets = os.networkInterfaces() || {};
  const list = [];
  const configuredNames = new Set();

  for (const [ifName, entries] of Object.entries(nets)) {
    const operstate = readSysNetAttr(ifName, 'operstate') || 'up';
    const rawSpeed = Number(readSysNetAttr(ifName, 'speed'));
    const speedMbps = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : null;
    const mac = readSysNetAttr(ifName, 'address') || '';

    for (const e of entries || []) {
      if ((e.family === 'IPv4' || e.family === 4) && !e.internal) {
        configuredNames.add(ifName);
        list.push({
          name: ifName,
          address: e.address,
          netmask: e.netmask || '',
          cidr: e.cidr || '',
          operstate,
          speedMbps,
          mac: mac || e.mac || ''
        });
      }
    }
  }

  return list;
}

export function listUnconfiguredPhysicalNics() {
  try {
    const configured = new Set(listHostIpv4Interfaces().map((x) => x.name));
    const names = fs.readdirSync('/sys/class/net').filter((n) => n !== 'lo' && !configured.has(n));
    return names.map((ifName) => {
      const operstate = readSysNetAttr(ifName, 'operstate') || 'down';
      const rawSpeed = Number(readSysNetAttr(ifName, 'speed'));
      const speedMbps = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : null;
      const mac = readSysNetAttr(ifName, 'address') || '';
      return { name: ifName, operstate, speedMbps, mac };
    });
  } catch {
    return [];
  }
}

export function getDedicatedWk2500NicConfig() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'wk2500_dedicated_nic_json'").get();
    if (!row || !row.value) return { if_name: '', ip_address: '', multicast_subnet: '239.25.0.0/24' };
    const parsed = JSON.parse(row.value);
    return {
      if_name: String(parsed.if_name || '').trim(),
      ip_address: String(parsed.ip_address || '').trim(),
      multicast_subnet: String(parsed.multicast_subnet || '239.25.0.0/24').trim()
    };
  } catch {
    return { if_name: '', ip_address: '', multicast_subnet: '239.25.0.0/24' };
  }
}

export function saveDedicatedWk2500NicConfig(cfg = {}) {
  const clean = {
    if_name: String(cfg.if_name || '').trim(),
    ip_address: String(cfg.ip_address || '').trim(),
    multicast_subnet: String(cfg.multicast_subnet || '239.25.0.0/24').trim()
  };
  withSqliteBusyRetry(() => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('wk2500_dedicated_nic_json', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify(clean));
  });
  return clean;
}

export function resolveEffectiveBindIp(slotRow = {}) {
  const perSlot = String(slotRow?.local_interface_ip || '').trim();
  if (perSlot) return perSlot;
  const globalDed = getDedicatedWk2500NicConfig();
  return globalDed.ip_address || '';
}

/**
 * Aligns incoming MPEG-TS stream to 0x47 188-byte sync boundaries and emits exact
 * 1316-byte (7 x 188B) SPTS UDP payloads required by WK2500 IP-to-Analog hardware.
 */
export class TsUdpPacketizer {
  /**
   * @param {(pkt: Buffer) => void} onPacket
   * @param {number} pktSize 1316 (7×188, el clásico de estos moduladores) o 188
   */
  constructor(onPacket, pktSize = 1316) {
    this.pktSize = PKT_SIZES.includes(Number(pktSize)) ? Number(pktSize) : 1316;
    this.buf = Buffer.alloc(0);
    this.outAccum = Buffer.allocUnsafe(this.pktSize);
    this.outOffset = 0;
    this.onPacket1316 = onPacket;
    this.onPacket = onPacket;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;

    let pos = 0;
    const len = this.buf.length;

    while (pos + 188 <= len) {
      if (this.buf[pos] !== 0x47) {
        // Re-sync to verified 0x47 ... (+188) 0x47 boundary
        let synced = -1;
        for (let s = pos + 1; s < len; s++) {
          if (this.buf[s] === 0x47) {
            if (s + 188 >= len || this.buf[s + 188] === 0x47) {
              synced = s;
              break;
            }
          }
        }
        if (synced === -1) {
          pos = len;
          break;
        }
        pos = synced;
        if (pos + 188 > len) break;
      }

      this.buf.copy(this.outAccum, this.outOffset, pos, pos + 188);
      this.outOffset += 188;
      pos += 188;

      if (this.outOffset === this.pktSize) {
        this.onPacket(Buffer.from(this.outAccum));
        this.outOffset = 0;
      }
    }

    this.buf = pos < len ? this.buf.subarray(pos) : Buffer.alloc(0);
  }
}

/** Compatibilidad: el motor clásico siempre emitía 1316 bytes. */
export class Ts1316Packetizer extends TsUdpPacketizer {
  constructor(onPacket1316) {
    super(onPacket1316, 1316);
  }
}

function resolveSlotUpstream(slotRow) {
  let streamRow = null;
  if (slotRow.stream_id) {
    streamRow = db.prepare('SELECT * FROM streams WHERE id = ?').get(Number(slotRow.stream_id));
  }
  const rawPrimary = String(slotRow.custom_source_url || streamRow?.source_url || '').trim();
  // Sin failover: el modulador emite el source activo del canal y nada más.
  const rawBackup = '';
  const channelTitle = String(slotRow.custom_name || streamRow?.name || `CATV CH ${slotRow.catv_ch}`).trim();

  // Check if local 24/7 RAMDisk HLS manifest is already running for this stream
  const localHls =
    !slotRow.custom_source_url && streamRow ? getFreshLocalHlsManifestPath(`stream_${streamRow.id}`, 16) : null;

  return {
    streamRow,
    channelTitle,
    rawPrimary,
    rawBackup,
    localHls
  };
}

function classifyUpstreamProto(rawUrl = '') {
  const lower = String(rawUrl || '').trim().toLowerCase();
  if (lower.startsWith('mnf://') || lower.startsWith('mnfs://') || lower.endsWith('.mnf')) return 'MNF v1';
  if (lower.startsWith('m4f://') || lower.startsWith('m4fs://') || lower.includes('.fmp4.')) return 'M4F / CMAF';
  if (lower.includes('.m3u8') || lower.startsWith('hls://')) return 'HLS';
  if (lower.startsWith('udp://') || lower.startsWith('rtp://')) return 'UDP/RTP';
  return 'HTTP MPEG-TS';
}

/**
 * Motor de salida UDP por canal.
 *
 * `direct_dgram` copia los bytes del origen al socket tal como llegan, sin
 * dosificar: si el origen entrega a trozos (un segmento de 2 s de golpe), la
 * salida también sale a trozos y el modulador ve picos de 6, 10, 2 y 0.
 *
 * Por eso, con el dosificado activo (-re), las fuentes HTTP/TS van por FFmpeg,
 * que sí las entrega al ritmo de sus timestamps. El motor directo se conserva
 * para MNF (que ya llega dosificado por la red) y para quien lo fuerce con
 * TVLISTER_CATV_DIRECT=1.
 */
function catvDirectEngineForced() {
  const v = String(process.env.TVLISTER_CATV_DIRECT ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

function shouldUseDirectNodeUdpEngine(slotRow, rawUrl, localHls) {
  if (localHls) return false; // Local HLS manifest is best muxed to SPTS via FFmpeg -c copy
  if (slotRow.output_mode !== 'direct_spts') return false;
  if (Number(slotRow.muxrate_kbps) > 0) return false;
  // RTP necesita timestamps correctos: lo hace FFmpeg con el muxer rtp_mpegts.
  if (resolveEffectiveTransport(slotRow, unitForSlot(slotRow)).rtp) return false;
  const lower = String(rawUrl || '').trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith('mnf://') || lower.startsWith('mnfs://') || lower.endsWith('.mnf')) return true;
  if (lower.includes('.m3u8') || lower.startsWith('hls://') || lower.startsWith('hlss://')) return false;
  if (lower.startsWith('m4f://') || lower.startsWith('m4fs://')) return false;
  const isHttpTs =
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('tshttp://') ||
    lower.startsWith('tshttps://');
  if (!isHttpTs) return false;
  // Con dosificado activo, HTTP/TS se muxea con FFmpeg para que salga constante.
  if (catvPacingEnabled() && !catvDirectEngineForced()) return false;
  return true;
}

function buildUdpTargetFfmpegUrl(slotRow, transport = null) {
  const t = transport || resolveEffectiveTransport(slotRow, unitForSlot(slotRow));
  const params = [
    `pkt_size=${t.pktSize}`,
    `ttl=${Math.max(1, Number(slotRow.ttl) || 16)}`,
    `buffer_size=1048576`
  ];
  const bindIp = resolveEffectiveBindIp(slotRow);
  if (bindIp) {
    params.push(`localaddr=${encodeURIComponent(bindIp)}`);
  }
  // rtp:// porque el muxer rtp_mpegts envuelve el TS completo en RTP (lo que
  // aceptan los moduladores que exigen UDP+RTP).
  const proto = t.rtp ? 'rtp' : 'udp';
  return `${proto}://${slotRow.udp_host}:${slotRow.udp_port}?${params.join('&')}`;
}

/** Rótulo DVB del canal: lo que el modulador enseña como nombre del programa. */
function sanitizeServiceText(value, fallback, maxLen = 40) {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || fallback).slice(0, maxLen);
}

/**
 * ¿Se puede limitar el ritmo de lectura con -re? Sin él, con -c copy el flujo
 * sale a ráfagas (un segmento HLS de 2 s se envía en 30 ms) y el modulador ve
 * picos de 2–3× el bitrate real. Con -re se entrega al ritmo de los timestamps.
 * No se aplica si ya hay muxrate (CBR ya marca el ritmo) ni en pipe:0.
 */
function catvPacingEnabled() {
  const v = String(process.env.TVLISTER_CATV_PACING ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function buildFfmpegUdpOutputArgs(slotRow, inputSpec, opts = {}) {
  const mode = slotRow.output_mode || 'direct_spts';
  const serviceId = Math.max(1, Number(slotRow.service_id) || Number(slotRow.catv_ch) || 1);
  const muxrate = Number(slotRow.muxrate_kbps) > 0 ? Number(slotRow.muxrate_kbps) * 1000 : 0;
  const transport = resolveEffectiveTransport(slotRow, unitForSlot(slotRow));
  const udpUrl = buildUdpTargetFfmpegUrl(slotRow, transport);

  // Nombre DVB (SDT). Sin esto FFmpeg pone "Service01"/"FFmpeg" y el modulador
  // muestra eso mismo en su página de entrada, ignorando el nombre del CSV.
  const serviceName = sanitizeServiceText(
    opts.channelTitle || slotRow.custom_name || '',
    `CANAL ${slotRow.catv_ch}`
  );
  const serviceProvider = sanitizeServiceText(opts.serviceProvider || 'TVLister', 'TVLister');

  // -re (leer al ritmo nativo) es lo que hace constante la salida. Se aplica
  // también con muxrate: el CBR sólo rellena con paquetes nulos, no dosifica
  // la lectura (comprobado: CBR sin -re sigue saliendo a trozos).
  // Nunca en pipe:0 (MNF), que ya llega dosificado por la red.
  const pacing = opts.pacing !== undefined ? Boolean(opts.pacing) : catvPacingEnabled();
  const usePacing = pacing && inputSpec !== 'pipe:0';

  const isPureCopy = mode === 'direct_spts';
  const isVideoCopy = mode !== 'ntsc_sd_wk2500';
  const args = [];
  if (inputSpec !== 'pipe:0') args.push('-nostdin');
  // -progress pipe:1 permite medir los bytes realmente entregados al socket UDP (telemetría por canal)
  args.push('-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y');

  if (isPureCopy) {
    args.push('-threads', '1');
  } else if (isVideoCopy) {
    args.push('-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1');
  } else {
    args.push('-threads', '2', '-filter_threads', '1', '-filter_complex_threads', '1');
  }

  const probeSize = isPureCopy ? '1000000' : isVideoCopy ? '1000000' : '1200000';
  const analyzeDur = isPureCopy ? '800000' : isVideoCopy ? '1000000' : '1500000';

  if (inputSpec === 'pipe:0') {
    args.push(
      '-probesize',
      probeSize,
      '-analyzeduration',
      analyzeDur,
      '-fflags',
      '+genpts+igndts+nobuffer+discardcorrupt',
      '-flags',
      'low_delay',
      '-f',
      'mpegts',
      '-i',
      'pipe:0'
    );
  } else {
    if (String(inputSpec).startsWith('http')) {
      args.push(
        '-rw_timeout',
        '10000000',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '4'
      );
    }
    if (usePacing) args.push('-re');
    args.push(
      '-probesize',
      probeSize,
      '-analyzeduration',
      analyzeDur,
      '-fflags',
      '+genpts+igndts+nobuffer+discardcorrupt',
      '-flags',
      'low_delay',
      '-i',
      inputSpec
    );
  }

  args.push('-dn', '-sn', '-map', '0:v:0', '-map', '0:a:0?');

  if (mode === 'ntsc_sd_wk2500') {
    // Universal WK2500 Analog Modulator Safe Profile: NTSC 720x480 @ 29.97fps H.264 Main + MP2 192k Leveled Audio
    args.push(
      '-vf',
      'yadif=0:-1:1,scale=720:480:flags=fast_bilinear,fps=30000/1001,format=yuv420p',
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-level',
      '3.1',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-x264-params',
      'rc-lookahead=0:sync-lookahead=0:ref=1:me=dia:subme=1:trellis=0',
      '-b:v',
      '1800k',
      '-maxrate',
      '1800k',
      '-bufsize',
      '3600k',
      '-g',
      '30',
      '-sc_threshold',
      '0',
      '-af',
      buildAudioLevelingFilter('ultra_200ch', true),
      '-c:a',
      'mp2',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2'
    );
  } else if (mode === 'copy_mp2_leveled') {
    args.push(
      '-c:v',
      'copy',
      '-af',
      buildAudioLevelingFilter('ultra_200ch', true),
      '-c:a',
      'mp2',
      '-b:a',
      '192k',
      '-ac',
      '2'
    );
  } else if (mode === 'copy_aac_leveled') {
    args.push(
      '-c:v',
      'copy',
      '-af',
      buildAudioLevelingFilter('ultra_200ch', true),
      '-c:a',
      'aac',
      '-aac_coder',
      'fast',
      '-b:a',
      '128k',
      '-ac',
      '2'
    );
  } else {
    args.push('-c:v', 'copy', '-c:a', 'copy');
  }

  if (muxrate > 0) {
    args.push('-muxrate', String(muxrate));
  }

  args.push(
    '-mpegts_service_id',
    String(serviceId),
    '-mpegts_pmt_start_pid',
    '0x0100',
    '-mpegts_start_pid',
    '0x0101',
    '-metadata',
    `service_provider=${serviceProvider}`,
    '-metadata',
    `service_name=${serviceName}`,
    '-max_muxing_queue_size',
    '1024',
    '-flush_packets',
    '1',
    '-f',
    transport.rtp ? 'rtp_mpegts' : 'mpegts',
    udpUrl
  );

  return args;
}

export function stopWk2500ChannelWorker(catvCh) {
  const ch = Number(catvCh);
  const w = udpWorkers.get(ch);
  if (!w) return;
  w.stopped = true;
  if (w.reconnectTimer) clearTimeout(w.reconnectTimer);
  if (w.rateTimer) clearInterval(w.rateTimer);
  if (w.abortController) {
    try {
      w.abortController.abort();
    } catch {
      // ignore
    }
  }
  if (w.child) {
    try {
      w.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  if (w.socket) {
    try {
      w.socket.close();
    } catch {
      // ignore
    }
  }
  udpWorkers.delete(ch);
}

/** Reinicia un canal CATV (lo usa la guardia de estabilidad). */
export function restartWk2500ChannelWorker(catvCh) {
  const ch = Number(catvCh);
  stopWk2500ChannelWorker(ch);
  return startWk2500ChannelWorker(ch);
}

export function stopAllWk2500Workers() {
  for (const ch of Array.from(udpWorkers.keys())) {
    stopWk2500ChannelWorker(ch);
  }
}

export function startWk2500ChannelWorker(catvCh) {
  const ch = Number(catvCh);
  stopWk2500ChannelWorker(ch);

  const slotRow = db.prepare('SELECT * FROM wk2500_channels WHERE catv_ch = ?').get(ch);
  if (!slotRow || !slotRow.udp_host || !slotRow.udp_port) return false;

  const up = resolveSlotUpstream(slotRow);
  if (!up.rawPrimary && !up.localHls) return false;

  const state = {
    catv_ch: ch,
    stopped: false,
    status: 'connecting',
    engine: 'direct_dgram',
    upstream_proto: classifyUpstreamProto(up.rawPrimary),
    startedAtMs: Date.now(),
    bytesWindow: 0,
    bitrateKbps: 0,
    packetsSent: 0,
    lastError: '',
    abortController: null,
    socket: null,
    child: null,
    reconnectTimer: null,
    rateTimer: null,
    attempt: 0,
    streamingSinceMs: 0
  };

  state.rateTimer = setInterval(() => {
    state.bitrateKbps = Math.round((state.bytesWindow * 8) / 2000);
    state.bytesWindow = 0;
  }, 2000);
  state.rateTimer.unref?.();

  udpWorkers.set(ch, state);

  // Marca de "este intento sí estaba entregando video": sirve para no quedarse pegado
  // en la fuente secundaria para siempre cuando el principal ya volvió.
  const markStreaming = () => {
    if (state.status !== 'streaming') state.status = 'streaming';
    if (!state.streamingSinceMs) state.streamingSinceMs = Date.now();
  };

  const scheduleRetry = (errMsg = '') => {
    if (state.stopped || udpWorkers.get(ch) !== state) return;
    state.status = 'reconnecting';
    if (errMsg) state.lastError = String(errMsg).slice(0, 140);
    const healthyMs = state.streamingSinceMs ? Date.now() - state.streamingSinceMs : 0;
    // Si el intento aguantó sano > 20 s, la próxima reconexión vuelve a probar el principal.
    state.attempt = healthyMs >= 20000 ? 0 : state.attempt + 1;
    state.streamingSinceMs = 0;
    state.reconnectTimer = setTimeout(runCycle, 3000);
  };

  const runDirectNodeUdpCycle = async (freshSlot, candidateUrl) => {
    state.engine = 'direct_dgram_1316';
    const isMnf = /^mnfs?:\/\//i.test(candidateUrl) || /\.mnf(\?|$)/i.test(candidateUrl);
    const httpUrl = candidateUrl
      .replace(/^mnf(s?):\/\//i, 'http$1://')
      .replace(/^ts(https?:\/\/)/i, '$1');

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    state.socket = socket;

    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      const effectiveIp = resolveEffectiveBindIp(freshSlot);
      const bindIp = effectiveIp || '0.0.0.0';
      socket.bind(0, bindIp, () => {
        socket.removeListener('error', reject);
        try {
          socket.setSendBufferSize(1024 * 1024);
          if (isMulticastIp(freshSlot.udp_host)) {
            socket.setMulticastTTL(Math.max(1, Number(freshSlot.ttl) || 16));
            if (bindIp !== '0.0.0.0') {
              socket.setMulticastInterface(bindIp);
            }
          }
        } catch {
          // non-fatal socket option
        }
        resolve();
      });
    });

    const transport = resolveEffectiveTransport(freshSlot, unitForSlot(freshSlot));
    state.engine = `direct_dgram_${transport.pktSize}`;
    const packetizer = new TsUdpPacketizer((pkt) => {
      if (state.stopped) return;
      socket.send(pkt, Number(freshSlot.udp_port), freshSlot.udp_host, (err) => {
        if (!err) {
          state.packetsSent += 1;
          state.bytesWindow += pkt.length;
          markStreaming();
        }
      });
    }, transport.pktSize);

    const ac = new AbortController();
    state.abortController = ac;

    const resp = await fetch(httpUrl, {
      headers: {
        'User-Agent': 'TVLister-WK2500-UDP/2.4',
        Accept: isMnf ? 'application/x-tvlister-mnf, */*' : '*/*'
      },
      redirect: 'follow',
      signal: ac.signal
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`Upstream HTTP ${resp.status}`);
    }

    const cType = String(resp.headers.get('content-type') || '').toLowerCase();
    const treatAsMnf = isMnf || cType.includes('tvlister-mnf');
    state.upstream_proto = treatAsMnf ? 'MNF v1 (Ahorro WAN)' : 'HTTP MPEG-TS';

    let mnfRemux = null;
    if (treatAsMnf) {
      mnfRemux = new MnfToTsRemuxer();
      mnfRemux.on('ts', (tsChunk) => packetizer.push(tsChunk));
    }

    const reader = resp.body.getReader();
    while (!state.stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const buf = Buffer.from(value);
        if (mnfRemux) {
          mnfRemux.push(buf);
        } else {
          packetizer.push(buf);
        }
      }
    }
  };

  const runFfmpegUdpCycle = async (freshSlot, candidateUrl, localHlsPath, channelTitle = '') => {
    if (!isFfmpegAvailable()) {
      throw new Error('FFmpeg no instalado para este perfil de salida UDP');
    }
    state.engine = 'ffmpeg_spts_1316';
    const isMnf = !localHlsPath && (/^mnfs?:\/\//i.test(candidateUrl) || /\.mnf(\?|$)/i.test(candidateUrl));

    const bin = getFfmpegBin();
    const env = bin.startsWith('/home/xui/')
      ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
      : process.env;

    const inputForFfmpeg = localHlsPath || (isMnf ? 'pipe:0' : candidateUrl);
    const args = buildFfmpegUdpOutputArgs(freshSlot, inputForFfmpeg, { channelTitle, pacing: freshSlot.pacing });

    const child = spawn(bin, args, {
      stdio: [isMnf ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
      // Marca de propiedad: la guardia de estabilidad barre los FFmpeg que
      // queden vivos de una ejecución anterior (dos emisores al mismo grupo
      // UDP duplican el bitrate que ve el modulador).
      env: { ...env, TVLISTER_WORKER: '1', TVLISTER_WORKER_KEY: `catv_${ch}` }
    });
    state.child = child;
    state.status = 'connecting';

    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-220);
    });

    // Telemetría real del motor FFmpeg: leemos `total_size` de -progress pipe:1.
    // Así el panel muestra los Mbps/packet realmente enviados al WK2500 en vez de un valor fijo.
    let progressBuf = '';
    let lastProgressTotal = 0;
    child.stdout?.on('error', () => {});
    child.stdout?.on('data', (chunk) => {
      progressBuf += chunk.toString('utf8');
      let nl = progressBuf.indexOf('\n');
      while (nl !== -1) {
        const line = progressBuf.slice(0, nl).trim();
        progressBuf = progressBuf.slice(nl + 1);
        const m = /^total_size=(\d+)$/.exec(line);
        if (m) {
          const total = Number(m[1]);
          if (Number.isFinite(total) && total > lastProgressTotal) {
            const delta = total - lastProgressTotal;
            lastProgressTotal = total;
            state.bytesWindow += delta;
            state.packetsSent += Math.ceil(delta / 1316);
            markStreaming();
          }
        }
        nl = progressBuf.indexOf('\n');
      }
      if (progressBuf.length > 8192) progressBuf = progressBuf.slice(-2048);
    });

    if (isMnf && child.stdin) {
      state.upstream_proto = 'MNF v1 -> FFmpeg SPTS';
      child.stdin.on('error', () => {});
      const ac = new AbortController();
      state.abortController = ac;
      const httpUrl = candidateUrl.replace(/^mnf(s?):\/\//i, 'http$1://');

      (async () => {
        try {
          const resp = await fetch(httpUrl, {
            headers: { Accept: 'application/x-tvlister-mnf, */*' },
            redirect: 'follow',
            signal: ac.signal
          });
          if (!resp.ok || !resp.body) {
            child.kill('SIGTERM');
            return;
          }
          const remux = new MnfToTsRemuxer();
          remux.on('ts', (tsBuf) => {
            if (!child.killed && child.stdin && !child.stdin.destroyed) {
              child.stdin.write(tsBuf);
            }
          });
          const reader = resp.body.getReader();
          while (!state.stopped && !child.killed) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) remux.push(Buffer.from(value));
          }
        } catch {
          // handled by child exit
        } finally {
          try {
            child.stdin.end();
          } catch {
            // ignore
          }
        }
      })();
    }

    await new Promise((resolve, reject) => {
      child.once('exit', (code) => {
        if (state.stopped) return resolve();
        reject(new Error(stderrTail.trim() || `FFmpeg salió con código ${code}`));
      });
    });
  };

  const runCycle = async () => {
    if (state.stopped || udpWorkers.get(ch) !== state) return;
    const freshSlot = db.prepare('SELECT * FROM wk2500_channels WHERE catv_ch = ?').get(ch);
    if (!freshSlot) {
      stopWk2500ChannelWorker(ch);
      return;
    }

    const freshUp = resolveSlotUpstream(freshSlot);
    const allCandidates = [];
    for (const raw of [freshUp.rawPrimary, freshUp.rawBackup]) {
      if (!raw) continue;
      if (/^mnfs?:\/\//i.test(raw)) {
        allCandidates.push(raw);
      } else {
        for (const c of resolveFlussonicUrlCandidates(raw)) {
          if (c && !allCandidates.includes(c)) allCandidates.push(c);
        }
      }
    }

    const ffmpegReady = isFfmpegAvailable();
    const usableCandidates = ffmpegReady
      ? allCandidates
      : allCandidates.filter((u) => !/\.m3u8(\?|$)/i.test(u));
    const pool = usableCandidates.length > 0 ? usableCandidates : allCandidates;

    const chosenUrl = pool[state.attempt % Math.max(1, pool.length)] || freshUp.rawPrimary;
    if (!chosenUrl && !freshUp.localHls) {
      scheduleRetry('Sin URL de origen en el canal asignado');
      return;
    }

    try {
      if (shouldUseDirectNodeUdpEngine(freshSlot, chosenUrl, freshUp.localHls)) {
        await runDirectNodeUdpCycle(freshSlot, chosenUrl);
      } else {
        await runFfmpegUdpCycle(freshSlot, chosenUrl, freshUp.localHls, freshUp.channelTitle);
      }
      if (!state.stopped) scheduleRetry('Flujo finalizado, reconectando...');
    } catch (err) {
      if (state.socket) {
        try {
          state.socket.close();
        } catch {
          // ignore
        }
        state.socket = null;
      }
      scheduleRetry(err.message);
    }
  };

  runCycle();
  return true;
}

/**
 * Cómo va a salir cada canal por UDP, calculado con la misma lógica real del
 * motor (no una aproximación): motor elegido, si lleva -re y con qué muxrate.
 * Es lo que usa `tvlister-admin catv steady` para comprobar que todo sale
 * constante sin tener que reiniciar y esperar a ver.
 */
export function catvOutputPlan({ unitId = null, onlyEnabled = true } = {}) {
  ensureCatvSlotsInitialized();
  const slots = db
    .prepare(
      `SELECT w.*, s.name AS stream_name, s.source_url AS stream_source_url,
              s.bitrate_kbps AS stream_bitrate
       FROM wk2500_channels w
       LEFT JOIN streams s ON s.id = w.stream_id
       WHERE w.catv_ch BETWEEN ? AND ?
       ORDER BY w.catv_ch ASC`
    )
    .all(CATV_MIN_CH, CATV_MAX_CH);

  const units = db.prepare('SELECT * FROM wk2500_units ORDER BY id ASC').all();
  const unitById = new Map(units.map((u) => [Number(u.id), u]));

  const rows = [];
  for (const row of slots) {
    if (onlyEnabled && !row.enabled) continue;
    const source = String(row.custom_source_url || row.stream_source_url || '').trim();
    if (!source && !row.stream_id) continue;
    if (unitId && Number(row.unit_id) !== Number(unitId)) continue;

    const unit = unitById.get(Number(row.unit_id)) || null;

    // De dónde sale realmente el flujo: la URL remota (m3u8 de Flussonic) o el
    // HLS que el propio panel escribe en RAMDisk para servir a los clientes.
    const up = resolveSlotUpstream(row);
    const inputUrl = source;
    const isLocalHls = Boolean(up.localHls) && !row.custom_source_url;
    const direct = shouldUseDirectNodeUdpEngine(row, source, up.localHls || null);
    const engine = direct ? 'direct_dgram' : 'ffmpeg';
    const lower = String(source || '').toLowerCase();
    const sourceKind = isLocalHls
      ? 'HLS local (RAMDisk del panel)'
      : lower.startsWith('mnf')
      ? 'MNF'
      : lower.includes('.m3u8') || lower.startsWith('hls')
      ? 'HLS (m3u8 del origen)'
      : lower.includes('.fmp4.')
      ? 'CMAF / fMP4'
      : lower.startsWith('rtp')
      ? 'RTP'
      : lower.startsWith('udp')
      ? 'UDP'
      : 'HTTP MPEG-TS';

    // Con el motor directo no hay -re posible; con FFmpeg se comprueba en los
    // argumentos reales que se van a lanzar.
    let pacing = false;
    if (!direct) {
      const args = buildFfmpegUdpOutputArgs(row, source, { channelTitle: row.custom_name || row.stream_name, pacing: row.pacing });
      pacing = args.includes('-re');
    }

    const declared = Number(row.stream_bitrate) || 0;
    rows.push({
      catv_ch: Number(row.catv_ch),
      name: row.custom_name || row.stream_name || `CH ${row.catv_ch}`,
      source,
      input: isLocalHls ? up.localHls : inputUrl,
      source_kind: sourceKind,
      service_name: row.custom_name || row.stream_name || `CANAL ${row.catv_ch}`,
      unit_id: unit ? Number(unit.id) : null,
      unit_name: unit ? unit.name : '',
      output_mode: row.output_mode || 'direct_spts',
      muxrate_kbps: Number(row.muxrate_kbps) || 0,
      declared_kbps: declared,
      engine,
      pacing,
      constant: engine === 'direct_dgram' ? false : pacing,
      dest: `${row.udp_host}:${row.udp_port}`
    });
  }
  return rows;
}

export function resumeEnabledWk2500Channels() {
  try {
    const enabledRows = db
      .prepare('SELECT catv_ch FROM wk2500_channels WHERE enabled = 1 ORDER BY catv_ch ASC')
      .all();
    enabledRows.forEach((row, idx) => {
      setTimeout(() => {
        try {
          startWk2500ChannelWorker(row.catv_ch);
        } catch {
          // ignore
        }
      }, idx * 75).unref?.();
    });
  } catch {
    // table may be empty on fresh panel
  }
}

function parseM3uPlaylistText(m3uText = '') {
  const lines = String(m3uText || '').split(/\r?\n/);
  const items = [];
  let pendingMeta = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim().replace(/^\[24\/7\]\s*/i, '') : 'Canal TV';
      const getAttr = (attr) => {
        const m = line.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
        return m ? m[1].trim() : '';
      };
      pendingMeta = {
        name: name || getAttr('tvg-name') || 'Canal TV',
        tvgId: getAttr('tvg-id'),
        logoUrl: getAttr('tvg-logo'),
        groupTitle: getAttr('group-title') || 'Canales MNF'
      };
    } else if (!line.startsWith('#')) {
      const url = line;
      items.push({
        ...(pendingMeta || { name: `Canal ${items.length + 1}`, tvgId: '', logoUrl: '', groupTitle: 'Canales MNF' }),
        url
      });
      pendingMeta = null;
    }
  }
  return items;
}

// ==================== EQUIPOS WK2500: MODELOS 32 / 64 / 125 Y COBERTURA ====================

/** Equipo con su vista pública (lista de canales, portadoras y UDP) para las respuestas de la API. */
/**
 * Quita una lista de canales a los demás equipos (un canal sólo puede vivir en un equipo).
 * Los equipos afectados pasan a lista explícita con lo que les queda; si no les queda
 * nada se desactivan. Devuelve los canales liberados y los equipos tocados.
 */
function releaseChannelsFromOthers(channels = [], exceptUnitId = 0) {
  const released = [];
  const touched = [];
  const targets = new Set(channels.map((c) => Number(c)));
  for (const other of listUnitRows()) {
    if (Number(other.id) === Number(exceptUnitId)) continue;
    const list = unitChannelList(other);
    const keep = list.filter((ch) => !targets.has(ch));
    if (keep.length === list.length) continue;
    const taken = list.filter((ch) => targets.has(ch));
    released.push(...taken);
    touched.push({ id: other.id, name: other.name, removed: taken, remaining: keep.length });
    if (!keep.length) {
      db.prepare("UPDATE wk2500_units SET channels_json = '[]', enabled = 0, updated_at = datetime('now') WHERE id = ?").run(other.id);
      db.prepare('UPDATE wk2500_channels SET unit_id = NULL WHERE unit_id = ?').run(other.id);
    } else {
      db.prepare(
        "UPDATE wk2500_units SET channels_json = ?, ch_start = ?, ch_end = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(keep), Math.min(...keep), Math.max(...keep), other.id);
    }
  }
  return { released, touched };
}

function unitResponse(unit) {
  if (!unit) return null;
  return { ...unit, ...unitPublicView(unit), capacity: unitCapacity(unit) };
}

function listUnitRows() {
  return db.prepare('SELECT * FROM wk2500_units ORDER BY id ASC').all();
}

/** Capacidad real del equipo (32 / 64 / 125 canales de salida). */
function unitCapacity(unit = {}) {
  const byModel = modelInfoFor(unit.model_channels);
  if (byModel) return byModel.channels;
  const rangeLen = Math.max(0, Number(unit.ch_end) - Number(unit.ch_start) + 1);
  return rangeLen || CATV_TOTAL_SLOTS;
}

/** ¿El canal pertenece a la lista de algún equipo? (soporta bloques no contiguos) */
function findUnitForChannel(units, ch) {
  const target = Number(ch);
  return units.find((u) => unitChannelSet(u).has(target)) || null;
}

/**
 * Valida y normaliza el cuerpo de un equipo WK2500.
 * Devuelve { unit } o { error, status }.
 */
function parseUnitPayload(body = {}, existing = null, { unitsForOverlap = [] } = {}) {
  const name = String(body.name ?? existing?.name ?? '').trim();
  const modelChannels = Number(body.model_channels ?? existing?.model_channels ?? 125);
  const model = modelInfoFor(modelChannels);
  if (!model) {
    return { error: `Modelo de WK2500 no válido (${modelChannels}). Usa 32, 64 o 125 canales.`, status: 400 };
  }

  // ---- Canales del equipo ----------------------------------------------------
  // Dos modos: (a) lista explícita de canales en el orden de las portadoras RF
  // (ej. "95, 2-28, 96-99") y (b) rango contiguo clásico ch_start..ch_end.
  const listProvided = body.channels_text !== undefined || body.channels !== undefined;
  const listInput = body.channels_text !== undefined ? body.channels_text : body.channels;
  let explicitChannels = null;
  if (listProvided) {
    explicitChannels = parseChannelList(listInput);
    const rawText = Array.isArray(listInput) ? listInput.join(',') : String(listInput ?? '').trim();
    if (!explicitChannels.length && rawText) {
      return {
        error: `No se pudo leer la lista de canales "${rawText}". Usa el formato 95, 2-28, 96-99.`,
        status: 400
      };
    }
    if (!explicitChannels.length) explicitChannels = null; // lista vacía = volver a rango contiguo
  } else if (existing?.channels_json) {
    const kept = unitChannelList(existing);
    explicitChannels = kept.length ? kept : null;
  }

  if (explicitChannels) {
    if (explicitChannels.length > model.channels) {
      return {
        error: `El ${model.label} sólo puede generar ${model.channels} canales y la lista pide ${explicitChannels.length}.`,
        status: 400
      };
    }
  }

  const rawStart = body.ch_start ?? existing?.ch_start ?? CATV_MIN_CH;
  const rawEnd = body.ch_end ?? existing?.ch_end ?? null;
  for (const [label, raw] of [['inicial', rawStart], ['final', rawEnd]]) {
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < CATV_MIN_CH || n > CATV_MAX_CH) {
      return {
        error: `El canal ${label} debe ser un número entero entre ${CATV_MIN_CH} y ${CATV_MAX_CH} (recibido: ${raw}).`,
        status: 400
      };
    }
  }

  let chStart;
  let chEnd;
  let span;
  if (explicitChannels) {
    // El equipo se identifica por el menor y el mayor de su lista; el orden real de
    // las portadoras vive en channels_json.
    chStart = Math.min(...explicitChannels);
    chEnd = Math.max(...explicitChannels);
    span = explicitChannels.length;
  } else {
    chStart = Number(rawStart);
    chEnd = rawEnd === null || rawEnd === undefined || rawEnd === '' ? Math.min(CATV_MAX_CH, chStart + model.channels - 1) : Number(rawEnd);
    if (chEnd < chStart) {
      return { error: `El rango CH ${chStart}–${chEnd} es inválido: el canal final debe ser mayor o igual al inicial.`, status: 400 };
    }
    span = chEnd - chStart + 1;
    if (span > model.channels) {
      return {
        error: `El ${model.label} sólo puede generar ${model.channels} canales y el rango CH ${chStart}–${chEnd} pide ${span}.`,
        status: 400
      };
    }
  }

  // Si no se indica ip_mode pero la IP es unicast, se deduce del propio destino.
  const declaredMode = body.ip_mode ?? existing?.ip_mode ?? null;
  const rawDest = body.dest_ip ?? existing?.dest_ip ?? '';
  const inferredMode = rawDest && isValidIpv4(String(rawDest).trim()) && !isMulticastIp(String(rawDest).trim()) ? 'unicast' : 'multicast';
  const ipMode = String(declaredMode || inferredMode) === 'unicast' ? 'unicast' : 'multicast';
  const destIp = String(rawDest || (ipMode === 'unicast' ? '192.168.25.10' : '239.25.0.0')).trim();
  if (!isValidIpv4(destIp)) {
    return { error: `La IP destino "${destIp}" no es una IPv4 válida.`, status: 400 };
  }
  if (ipMode === 'multicast' && !isMulticastIp(destIp)) {
    return { error: `El modo multicast requiere un grupo 224.0.0.0–239.255.255.255, no ${destIp}.`, status: 400 };
  }
  if (ipMode === 'unicast' && isMulticastIp(destIp)) {
    return { error: `El modo unicast requiere la IP del WK2500, no el grupo multicast ${destIp}.`, status: 400 };
  }

  const basePort = Number(body.base_port ?? existing?.base_port ?? 5000);
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65535) {
    return { error: `El puerto base UDP ${body.base_port} no es válido (1–65535).`, status: 400 };
  }
  if (basePort + chEnd > 65535) {
    return { error: 'El puerto base + el número de canal se sale de 65535; baja el puerto base.', status: 400 };
  }

  const ttl = Number(body.ttl ?? existing?.ttl ?? 16);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 255) {
    return { error: 'El TTL multicast debe ser un entero entre 1 y 255.', status: 400 };
  }

  const outputMode = validateWk2500OutputMode(String(body.default_output_mode ?? existing?.default_output_mode ?? 'direct_spts'));
  if (!outputMode) {
    return { error: `Perfil de salida no soportado. Usa uno de: ${WK2500_OUTPUT_MODES.join(', ')}.`, status: 400 };
  }

  // Perfil de marca/modelo: define por defecto estándar, tamaño de datagrama y RTP.
  const brandId = String(body.brand_model ?? existing?.brand_model ?? 'generic_2500').trim();
  const brand = getModulatorBrand(brandId);
  const rawStandard = String(body.tv_standard ?? existing?.tv_standard ?? brand.default_standard ?? DEFAULT_TV_STANDARD);
  if (!TV_STANDARD_IDS.includes(rawStandard)) {
    return {
      error: `Estándar de TV "${rawStandard}" no soportado. Usa uno de: ${TV_STANDARD_IDS.join(', ')}.`,
      status: 400
    };
  }
  const standard = getTvStandard(rawStandard);
  const maxChForStd = maxChannelForStandard(standard.id);
  if (chEnd > maxChForStd) {
    return {
      error: `Con ${standard.short} el plan de canales llega hasta el ${maxChForStd}; el rango pide hasta el ${chEnd}.`,
      status: 400
    };
  }

  const rawPkt = Number(body.pkt_size ?? existing?.pkt_size ?? brand.default_pkt_size ?? 1316);
  if (!PKT_SIZES.includes(rawPkt)) {
    return { error: `El tamaño de datagrama debe ser ${PKT_SIZES.join(' o ')} bytes (recibido: ${rawPkt}).`, status: 400 };
  }
  const rtp = body.rtp === undefined ? Number(existing?.rtp ?? (brand.default_rtp ? 1 : 0)) : body.rtp ? 1 : 0;

  const interfaceIp = String(body.local_interface_ip ?? existing?.local_interface_ip ?? '').trim();
  if (interfaceIp) {
    const hostIps = listHostIpv4Interfaces().map((x) => x.address);
    if (!hostIps.includes(interfaceIp)) {
      return {
        error: `La IP de salida ${interfaceIp} no existe en este servidor. IPs disponibles: ${hostIps.join(', ') || 'ninguna'}.`,
        status: 400
      };
    }
  }

  // Dos equipos no pueden generar el mismo número de canal: se pisarían en el combinador RF.
  // Se compara canal por canal porque los equipos ya pueden tener bloques no contiguos.
  const mine = explicitChannels || (() => {
    const out = [];
    for (let ch = chStart; ch <= chEnd; ch++) out.push(ch);
    return out;
  })();
  const others = unitsForOverlap.filter((u) => Number(u.id) !== Number(existing?.id || 0));
  for (const other of others) {
    const otherSet = unitChannelSet(other);
    const clash = mine.find((ch) => otherSet.has(ch));
    if (clash) {
      return {
        error: `El canal ${clash} ya lo genera el equipo "${other.name}" (${orderedListText(unitChannelList(other))}). Un número de canal no puede repetirse: se pisarían en el combinador RF.`,
        status: 409
      };
    }
  }

  if (!name) {
    return { error: 'Ponle un nombre al equipo (ej. «WK2500 Rack 1»).', status: 400 };
  }

  return {
    unit: {
      name,
      model_channels: model.channels,
      ch_start: chStart,
      ch_end: chEnd,
      ip_mode: ipMode,
      dest_ip: destIp,
      base_port: basePort,
      local_interface_ip: interfaceIp,
      ttl,
      default_output_mode: outputMode,
      enabled: body.enabled === undefined ? Number(existing?.enabled ?? 1) : body.enabled ? 1 : 0,
      notes: String(body.notes ?? existing?.notes ?? '').trim(),
      brand_model: brand.id,
      tv_standard: standard.id,
      pkt_size: rawPkt,
      rtp,
      channels_json: explicitChannels ? JSON.stringify(explicitChannels) : null
    }
  };
}

/**
 * Escribe en la grilla CATV el direccionamiento UDP del equipo (rango, NIC, TTL y perfil)
 * y marca esos canales con su unit_id. No toca qué stream va en cada canal.
 */
function applyUnitToChannels(unit) {
  const upd = db.prepare(
    `UPDATE wk2500_channels
     SET unit_id = ?, udp_host = ?, udp_port = ?, local_interface_ip = ?, ttl = ?, output_mode = ?,
         freq_mhz = CASE WHEN freq_locked = 1 THEN freq_mhz ELSE ? END,
         updated_at = datetime('now')
     WHERE catv_ch = ?`
  );
  const touched = [];
  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const ch of unitChannelList(unit)) {
        const addr = computeDefaultUdpAddress(ch, unit.ip_mode, unit.dest_ip, unit.base_port);
        const info = getCatvStdChannelInfo(ch, unit.tv_standard);
        upd.run(
          unit.id,
          addr.udp_host,
          addr.udp_port,
          unit.local_interface_ip || '',
          unit.ttl,
          unit.default_output_mode,
          info.freq_mhz,
          ch
        );
        touched.push(ch);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  // Los canales que ya estaban emitiendo deben reapuntar su UDP sin reiniciar el panel.
  let restarted = 0;
  for (const ch of touched) {
    if (udpWorkers.has(ch)) {
      startWk2500ChannelWorker(ch);
      restarted += 1;
    }
  }
  return { channels: touched.length, restarted };
}

/** Cobertura completa: qué canales tienen modulador, cuántos quedan fuera y capacidad total. */
function buildCoverage(units, slots) {
  const ranges = units
    .filter((u) => Number(u.enabled) !== 0)
    .map((u) => ({
      id: u.id,
      name: u.name,
      channels: unitChannelList(u),
      text: channelListText(unitChannelList(u))
    }));
  const covered = new Set();
  for (const r of ranges) {
    for (const ch of r.channels) covered.add(ch);
  }
  const uncovered = [];
  for (let ch = CATV_MIN_CH; ch <= CATV_MAX_CH; ch++) {
    if (!covered.has(ch)) uncovered.push(ch);
  }
  const totalCapacity = units.reduce((acc, u) => acc + unitCapacity(u), 0);
  const assignedSlots = (slots || []).filter((s) => s.stream_id || s.custom_source_url);
  const orphanAssigned = assignedSlots.filter((s) => !covered.has(Number(s.catv_ch))).map((s) => Number(s.catv_ch));

  return {
    total_capacity: totalCapacity,
    covered_channels: covered.size,
    uncovered_channels: uncovered.length,
    uncovered_ranges: rangesToText(uncovered),
    uncovered_list: uncovered,
    orphan_assigned_channels: orphanAssigned
  };
}

/** Comprime una lista de números en rangos legibles: [2,3,4,7] -> "2–4, 7". */
function rangesToText(numbers = []) {
  if (!numbers.length) return '';
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }
  return out.join(', ');
}

/** Reparte los equipos en rangos contiguos desde CH 2 respetando la capacidad del modelo. */
function sequentialRanges(units, startCh = CATV_MIN_CH) {
  let cursor = clampCh(startCh);
  return units.map((u) => {
    const cap = unitCapacity(u);
    const chStart = cursor;
    const chEnd = Math.min(CATV_MAX_CH, chStart + cap - 1);
    cursor = chEnd + 1;
    return { ...u, ch_start: chStart, ch_end: chEnd };
  });
}

// ==================== API ROUTES: PLAN CATV 2..125, MNF TRUNK SYNC & WK2500 UDP ENGINE ====================

wk2500Router.get('/api/wk2500/plan', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();

  const slots = db
    .prepare(
      `SELECT w.*, s.name as stream_name, s.source_url as stream_source_url,
              s.logo_url as stream_logo_url, c.name as category_name
       FROM wk2500_channels w
       LEFT JOIN streams s ON s.id = w.stream_id
       LEFT JOIN categories c ON c.id = s.category_id
       ORDER BY w.catv_ch ASC`
    )
    .all();

  const streams = db
    .prepare(
      `SELECT s.id, s.name, s.source_url, s.sort_order, c.name as category_name
       FROM streams s
       LEFT JOIN categories c ON c.id = s.category_id
       ORDER BY s.sort_order ASC, s.id ASC`
    )
    .all();

  const trunks = db.prepare('SELECT * FROM mnf_trunks ORDER BY id DESC').all();
  const units = listUnitRows();
  const unitById = new Map(units.map((u) => [Number(u.id), u]));
  const interfaces = listHostIpv4Interfaces();
  const unconfiguredNics = listUnconfiguredPhysicalNics();
  const dedicatedNic = getDedicatedWk2500NicConfig();
  const activeUnits = units.filter((u) => Number(u.enabled) !== 0);

  const unitStats = new Map();
  for (const u of units) {
    unitStats.set(Number(u.id), { assigned: 0, enabled: 0, streaming: 0, mbps: 0 });
  }

  let activeStreamingCount = 0;
  let totalMbps = 0;
  const streamToCatvMap = new Map();

  const enrichedSlots = slots.map((row) => {
    const unitRow = unitById.get(Number(row.unit_id)) || activeUnits.find((u) => findUnitForChannel([u], row.catv_ch)) || null;
    const info = getCatvStdChannelInfo(row.catv_ch, unitRow?.tv_standard || DEFAULT_TV_STANDARD, row.freq_locked ? row.freq_mhz : null);
    const transport = resolveEffectiveTransport(row, unitRow);
    const w = udpWorkers.get(row.catv_ch);
    const liveStatus = w ? w.status : 'stopped';
    const bitrateKbps = w ? w.bitrateKbps : 0;
    if (liveStatus === 'streaming') {
      activeStreamingCount += 1;
      totalMbps += bitrateKbps / 1000;
    }
    const effectiveSource = row.custom_source_url || row.stream_source_url || '';
    const effectiveInterfaceIp = resolveEffectiveBindIp(row);
    const matchedNic = interfaces.find((x) => x.address === effectiveInterfaceIp);

    // El equipo se resolvió arriba (por unit_id y, si falta, por rango de canales).
    const stats = unitRow ? unitStats.get(Number(unitRow.id)) : null;
    const hasContent = Boolean(row.stream_id || row.custom_source_url);
    if (stats) {
      if (hasContent) stats.assigned += 1;
      if (row.enabled) stats.enabled += 1;
      if (liveStatus === 'streaming') {
        stats.streaming += 1;
        stats.mbps += bitrateKbps / 1000;
      }
    }

    if (row.stream_id && !streamToCatvMap.has(Number(row.stream_id))) {
      streamToCatvMap.set(Number(row.stream_id), {
        catv_ch: row.catv_ch,
        freq_mhz: info.freq_mhz,
        udp_host: row.udp_host,
        udp_port: row.udp_port,
        enabled: Boolean(row.enabled),
        live_status: liveStatus,
        bitrate_kbps: bitrateKbps,
        unit_id: unitRow ? Number(unitRow.id) : null,
        unit_name: unitRow ? unitRow.name : ''
      });
    }

    return {
      ...row,
      enabled: Boolean(row.enabled),
      freq_mhz: info.freq_mhz,
      audio_mhz: info.audio_mhz,
      band_label: info.band_label,
      effective_name: row.custom_name || row.stream_name || '',
      effective_source: effectiveSource,
      effective_interface_ip: effectiveInterfaceIp,
      effective_interface_name: matchedNic?.name || (effectiveInterfaceIp ? 'IP dedicada' : 'Automática'),
      upstream_proto: w?.upstream_proto || (effectiveSource ? classifyUpstreamProto(effectiveSource) : '—'),
      live_status: liveStatus,
      live_engine: w?.engine || '',
      bitrate_kbps: bitrateKbps,
      packets_sent: w?.packetsSent || 0,
      uptime_sec: w ? Math.floor((Date.now() - w.startedAtMs) / 1000) : 0,
      last_error: w?.lastError || '',
      // Equipo/modulador que entrega este número de canal
      unit_id: unitRow ? Number(unitRow.id) : null,
      unit_name: unitRow ? unitRow.name : '',
      unit_model_channels: unitRow ? unitCapacity(unitRow) : null,
      unit_tv_standard: unitRow?.tv_standard || DEFAULT_TV_STANDARD,
      unit_standard_short: getTvStandard(unitRow?.tv_standard || DEFAULT_TV_STANDARD).short,
      covered_by_unit: Boolean(unitRow),
      // Transporte realmente usado por este canal (hereda del equipo o lo fuerza)
      pkt_size_effective: transport.pktSize,
      rtp_effective: transport.rtp,
      pkt_size_own: Number(row.pkt_size || 0) || null,
      rtp_own: Number(row.rtp ?? -1) === -1 ? null : Number(row.rtp) === 1,
      freq_locked: Boolean(row.freq_locked)
    };
  });

  const enrichedStreams = streams.map((st) => {
    const mapped = streamToCatvMap.get(Number(st.id)) || null;
    return {
      ...st,
      upstream_proto: classifyUpstreamProto(st.source_url || ''),
      catv_assignment: mapped
    };
  });

  const coverage = buildCoverage(units, enrichedSlots);

  const enrichedUnits = units.map((u) => {
    const cap = unitCapacity(u);
    const model = modelInfoFor(u.model_channels);
    const stats = unitStats.get(Number(u.id)) || { assigned: 0, enabled: 0, streaming: 0, mbps: 0 };
    const view = unitPublicView(u);
    return {
      ...u,
      ...view,
      enabled: Number(u.enabled) !== 0,
      model_label: model ? model.label : `WK2500 · ${cap} canales`,
      capacity: cap,
      span: view.carrier_count,
      free_capacity: view.free_carriers,
      fill_percent: cap ? Math.round((view.carrier_count / cap) * 100) : 0,
      assigned_channels: stats.assigned,
      enabled_channels: stats.enabled,
      streaming_channels: stats.streaming,
      udp_mbps: Number(stats.mbps.toFixed(2)),
      brand: getModulatorBrand(u.brand_model),
      brand_model: u.brand_model || 'generic_2500',
      tv_standard: u.tv_standard || DEFAULT_TV_STANDARD,
      tv_standard_label: getTvStandard(u.tv_standard).short,
      audio_offset_mhz: getTvStandard(u.tv_standard).audio_offset_mhz,
      pkt_size: Number(u.pkt_size || 1316),
      rtp: Number(u.rtp || 0) === 1
    };
  });

  res.json({
    ok: true,
    summary: {
      total_catv_slots: CATV_TOTAL_SLOTS,
      assigned_slots: enrichedSlots.filter((s) => s.stream_id || s.custom_source_url).length,
      enabled_slots: enrichedSlots.filter((s) => s.enabled).length,
      streaming_slots: activeStreamingCount,
      total_udp_mbps: Number(totalMbps.toFixed(2)),
      unit_count: units.length,
      active_unit_count: activeUnits.length,
      total_capacity: coverage.total_capacity,
      covered_channels: coverage.covered_channels,
      uncovered_channels: coverage.uncovered_channels,
      uncovered_ranges: coverage.uncovered_ranges,
      orphan_assigned: coverage.orphan_assigned_channels.length
    },
    coverage,
    models: WK2500_MODELS,
    brands: MODULATOR_BRANDS,
    tv_standards: TV_STANDARDS,
    pkt_sizes: PKT_SIZES,
    standards_coverage: TV_STANDARDS.map((st) => ({
      id: st.id,
      short: st.short,
      label: st.label,
      audio_offset_mhz: st.audio_offset_mhz,
      max_channel: maxChannelForStandard(st.id),
      ...standardCoverage(st.id)
    })),
    dedicated_nic: dedicatedNic,
    interfaces,
    unconfigured_nics: unconfiguredNics,
    trunks,
    units: enrichedUnits,
    streams: enrichedStreams,
    slots: enrichedSlots
  });
});

// ==================== EQUIPOS WK2500: CRUD, AUTO-DISTRIBUCIÓN Y PUESTA EN MARCHA ====================

/** Siguiente IP de la serie para el auto-armado (unicast: última octeta; multicast: tercera octeta). */
function nextUnitIp(baseIp, index) {
  const parts = String(baseIp || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (isMulticastIp(baseIp)) {
    parts[2] = (parts[2] + index) % 256;
    parts[3] = 0;
  } else {
    parts[3] = parts[3] + index;
    if (parts[3] > 254) return null;
  }
  return parts.join('.');
}

wk2500Router.get('/api/wk2500/units', requireAuth, requireAdmin, (req, res) => {
  const units = listUnitRows().map((u) => unitResponse(u));
  const slots = db.prepare('SELECT catv_ch, stream_id, custom_source_url, enabled FROM wk2500_channels').all();
  res.json({ ok: true, models: WK2500_MODELS, units, coverage: buildCoverage(units, slots) });
});

wk2500Router.post('/api/wk2500/units', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  let existingUnits = listUnitRows();
  // "Estos canales ahora son míos": se liberan de los demás equipos antes de validar.
  if (req.body?.steal_from_others) {
    const wanted = parseChannelList(req.body.channels_text ?? req.body.channels ?? '');
    if (wanted.length) releaseChannelsFromOthers(wanted, 0);
    existingUnits = listUnitRows();
  }
  const parsed = parseUnitPayload(req.body || {}, null, { unitsForOverlap: existingUnits });
  if (parsed.error) return res.status(parsed.status || 400).json({ error: parsed.error });
  const u = parsed.unit;

  const info = db
    .prepare(
      `INSERT INTO wk2500_units (name, ip_mode, dest_ip, base_port, local_interface_ip, ttl, ch_start, ch_end,
                                 default_output_mode, model_channels, enabled, notes,
                                 brand_model, tv_standard, pkt_size, rtp, channels_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      u.name,
      u.ip_mode,
      u.dest_ip,
      u.base_port,
      u.local_interface_ip,
      u.ttl,
      u.ch_start,
      u.ch_end,
      u.default_output_mode,
      u.model_channels,
      u.enabled,
      u.notes,
      u.brand_model,
      u.tv_standard,
      u.pkt_size,
      u.rtp,
      u.channels_json
    );

  const unit = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(Number(info.lastInsertRowid));
  const applied = applyUnitToChannels(unit);
  res.status(201).json({ ok: true, unit: unitResponse(unit), applied });
});

wk2500Router.put('/api/wk2500/units/:id', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'Equipo WK2500 no encontrado.' });

  let overlapUnits = listUnitRows();
  if (req.body?.steal_from_others) {
    const wanted = parseChannelList(req.body.channels_text ?? req.body.channels ?? '');
    if (wanted.length) releaseChannelsFromOthers(wanted, id);
    overlapUnits = listUnitRows();
  }
  const parsed = parseUnitPayload(req.body || {}, current, { unitsForOverlap: overlapUnits });
  if (parsed.error) return res.status(parsed.status || 400).json({ error: parsed.error });
  const u = parsed.unit;

  // Los canales que salen de la lista del equipo dejan de pertenecerle (sin apagar nada).
  const newList = unitChannelList(u);
  const keep = new Set(newList);
  const previouslyOwned = db.prepare('SELECT catv_ch FROM wk2500_channels WHERE unit_id = ?').all(id);
  const dropped = previouslyOwned.map((r) => Number(r.catv_ch)).filter((ch) => !keep.has(ch));
  if (dropped.length) {
    const clear = db.prepare(
      "UPDATE wk2500_channels SET unit_id = NULL, updated_at = datetime('now') WHERE catv_ch = ?"
    );
    for (const ch of dropped) clear.run(ch);
  }

  db.prepare(
    `UPDATE wk2500_units
     SET name = ?, ip_mode = ?, dest_ip = ?, base_port = ?, local_interface_ip = ?, ttl = ?,
         ch_start = ?, ch_end = ?, default_output_mode = ?, model_channels = ?, enabled = ?, notes = ?,
         brand_model = ?, tv_standard = ?, pkt_size = ?, rtp = ?, channels_json = ?
     WHERE id = ?`
  ).run(
    u.name,
    u.ip_mode,
    u.dest_ip,
    u.base_port,
    u.local_interface_ip,
    u.ttl,
    u.ch_start,
    u.ch_end,
    u.default_output_mode,
    u.model_channels,
    u.enabled,
    u.notes,
    u.brand_model,
    u.tv_standard,
    u.pkt_size,
    u.rtp,
    u.channels_json,
    id
  );

  const unit = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(id);
  const applied = applyUnitToChannels(unit);
  res.json({ ok: true, unit: unitResponse(unit), applied });
});

wk2500Router.post('/api/wk2500/units/:id/apply', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const id = Number(req.params.id);
  const unit = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(id);
  if (!unit) return res.status(404).json({ error: 'Equipo WK2500 no encontrado.' });
  const applied = applyUnitToChannels(unit);
  res.json({ ok: true, unit: unitResponse(unit), applied });
});

wk2500Router.delete('/api/wk2500/units/:id', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const id = Number(req.params.id);
  const unit = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(id);
  if (!unit) return res.status(404).json({ error: 'Equipo WK2500 no encontrado.' });

  // Sin modulador no hay RF: se apagan los canales del rango para no dejar UDP al aire.
  const list = unitChannelList(unit);
  let stopped = 0;
  for (const ch of list) {
    if (udpWorkers.has(ch)) {
      stopWk2500ChannelWorker(ch);
      stopped += 1;
    }
  }
  const off = db.prepare("UPDATE wk2500_channels SET enabled = 0, unit_id = NULL, updated_at = datetime('now') WHERE catv_ch = ?");
  for (const ch of list) off.run(ch);
  db.prepare('DELETE FROM wk2500_units WHERE id = ?').run(id);

  res.json({ ok: true, removed: { id, name: unit.name }, disabledChannels: list.length, stoppedWorkers: stopped });
});

/**
 * Comprobación de la salida CATV: qué envía el panel, qué lleva el CSV y si el
 * equipo es alcanzable. GET /api/wk2500/verify[?unit_id=&ping=0]
 */
wk2500Router.get('/api/wk2500/verify', requireAuth, requireAdmin, async (req, res) => {
  ensureCatvSlotsInitialized();
  try {
    const unitId = req.query.unit_id ? Number(req.query.unit_id) : null;
    const body = await verifyCatv({ unitId, ping: String(req.query.ping ?? '1') !== '0' });
    if (body.error) return res.status(404).json({ error: body.error });
    res.json({ ok: true, ...body });
  } catch (err) {
    res.status(500).json({ error: err.message || 'No se pudo comprobar la salida CATV' });
  }
});

/**
 * Filas de muestra del equipo (3 primeras portadoras) para previsualizar cómo
 * queda el archivo con la plantilla del modulador.
 */
function previewUnitRows(unit, limit = 3) {
  return unitChannelList(unit)
    .slice(0, limit)
    .map((ch, idx) => {
      const info = getCatvStdChannelInfo(ch, unit.tv_standard || DEFAULT_TV_STANDARD);
      const addr = computeDefaultUdpAddress(ch, unit.ip_mode, unit.dest_ip, unit.base_port);
      const row = db
        .prepare(
          `SELECT w.custom_name, w.service_id, w.output_mode, s.name AS stream_name
             FROM wk2500_channels w LEFT JOIN streams s ON s.id = w.stream_id
            WHERE w.catv_ch = ?`
        )
        .get(ch);
      return {
        carrier: idx + 1,
        catv_ch: ch,
        freq_mhz: info.freq_mhz,
        audio_mhz: info.audio_mhz,
        udp_host: addr.udp_host,
        udp_port: addr.udp_port,
        name: row?.custom_name || row?.stream_name || `CH${ch}`,
        standard_short: info.standard_short,
        service_id: row?.service_id,
        output_mode: row?.output_mode
      };
    });
}

/**
 * Guarda la plantilla CSV del equipo. Acepta el archivo tal cual lo exporta el
 * modulador (pegado en `text`) y devuelve qué columnas reconoció y una vista
 * previa de 3 portadoras ya rellenadas.
 */
wk2500Router.post('/api/wk2500/units/:id/csv-template', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const unit = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(id);
  if (!unit) return res.status(404).json({ error: 'Equipo no encontrado.' });

  let text = String(req.body?.text ?? req.body?.csv ?? '');
  if (text.length > 2_000_000) return res.status(400).json({ error: 'El archivo es demasiado grande (máx. 2 MB).' });
  if (!text.trim()) return res.status(400).json({ error: 'Pega el CSV que exporta el modulador.' });

  const template = buildTemplate(text);
  if (template.error) return res.status(400).json({ error: template.error });

  db.prepare("UPDATE wk2500_units SET csv_template = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(template),
    id
  );

  const saved = { ...unit, csv_template: JSON.stringify(template) };
  res.json({
    ok: true,
    unit_id: id,
    template: templateSummary(saved),
    mapping: template.mapping,
    header: template.header,
    delimiter: template.delimiter,
    eol: template.eol,
    preview: renderTemplate(template, previewUnitRows(saved, 3))
      .split(/\r?\n/)
      .filter(Boolean)
  });
});

/** Ver la plantilla guardada (sin el archivo completo). */
wk2500Router.get('/api/wk2500/units/:id/csv-template', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const unit = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(id);
  if (!unit) return res.status(404).json({ error: 'Equipo no encontrado.' });
  const summary = templateSummary(unit);
  let preview = [];
  if (summary.saved) {
    try {
      preview = renderTemplate(JSON.parse(unit.csv_template), previewUnitRows(unit, 3))
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      preview = [];
    }
  }
  res.json({ ok: true, template: summary, preview });
});

/** Quitar la plantilla: el botón Import vuelve al formato compacto. */
wk2500Router.delete('/api/wk2500/units/:id/csv-template', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const unit = db.prepare('SELECT id FROM wk2500_units WHERE id = ?').get(id);
  if (!unit) return res.status(404).json({ error: 'Equipo no encontrado.' });
  db.prepare("UPDATE wk2500_units SET csv_template = '', updated_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true });
});

/** Reasigna rangos contiguos (CH 2 en adelante) según la capacidad real de cada modelo. */
wk2500Router.post('/api/wk2500/units/auto-distribute', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const { start_ch = CATV_MIN_CH } = req.body || {};
  const units = listUnitRows();
  if (!units.length) {
    return res.status(400).json({ error: 'Todavía no hay equipos WK2500 configurados. Crea al menos uno.' });
  }
  const distributed = sequentialRanges(units, Number(start_ch) || CATV_MIN_CH);
  const upd = db.prepare(
    "UPDATE wk2500_units SET ch_start = ?, ch_end = ?, channels_json = NULL, updated_at = datetime('now') WHERE id = ?"
  );
  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('UPDATE wk2500_channels SET unit_id = NULL').run();
      for (const u of distributed) upd.run(u.ch_start, u.ch_end, u.id);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  let restarted = 0;
  for (const u of distributed) {
    const fresh = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(u.id);
    restarted += applyUnitToChannels(fresh).restarted;
  }

  const freshUnits = listUnitRows();
  const slots = db.prepare('SELECT catv_ch, stream_id, custom_source_url, enabled FROM wk2500_channels').all();
  res.json({
    ok: true,
    units: freshUnits,
    restarted,
    coverage: buildCoverage(freshUnits, slots),
    message: `Rangos repartidos: ${describeRanges(freshUnits)}.`
  });
});

/**
 * Armado rápido: crea N equipos del mismo modelo con rangos consecutivos y ya deja
 * la grilla CATV apuntando a cada uno. Ej.: 4 × 32 canales -> CH 2–33, 34–65, 66–97, 98–125.
 */
wk2500Router.post('/api/wk2500/units/quick-setup', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const {
    model_channels = 32,
    count = 1,
    start_ch = CATV_MIN_CH,
    replace_existing = false,
    name_prefix = 'WK2500',
    ip_mode = 'unicast',
    dest_ip = '192.168.25.10',
    base_port = 5000,
    local_interface_ip = '',
    ttl = 16,
    default_output_mode = 'direct_spts',
    brand_model = 'generic_2500',
    tv_standard = DEFAULT_TV_STANDARD,
    pkt_size = 1316,
    rtp = false
  } = req.body || {};

  const model = modelInfoFor(model_channels);
  if (!model) return res.status(400).json({ error: 'Modelo no válido: usa 32, 64 o 125 canales.' });
  const qty = Number(count);
  if (!Number.isInteger(qty) || qty < 1 || qty > 16) {
    return res.status(400).json({ error: 'La cantidad de equipos debe ser un entero entre 1 y 16.' });
  }

  if (replace_existing) {
    for (const u of listUnitRows()) {
      for (const ch of unitChannelList(u)) {
        if (udpWorkers.has(ch)) stopWk2500ChannelWorker(ch);
      }
    }
    db.prepare('UPDATE wk2500_channels SET enabled = 0, unit_id = NULL').run();
    db.prepare('DELETE FROM wk2500_units').run();
  }

  const baseUnits = listUnitRows();
  const created = [];
  const skipped = [];
  let cursor = clampCh(Number(start_ch) || CATV_MIN_CH);

  for (let i = 0; i < qty; i++) {
    if (cursor > CATV_MAX_CH) {
      skipped.push(`Equipo ${i + 1}: ya no quedan canales libres hasta el CH ${CATV_MAX_CH}.`);
      continue;
    }
    const chStart = cursor;
    const chEnd = Math.min(CATV_MAX_CH, chStart + model.channels - 1);
    const destIp = i === 0 ? String(dest_ip).trim() : nextUnitIp(dest_ip, i) || String(dest_ip).trim();

    const parsed = parseUnitPayload(
      {
        name: `${name_prefix} ${i + 1}`,
        model_channels: model.channels,
        ch_start: chStart,
        ch_end: chEnd,
        ip_mode,
        dest_ip: destIp,
        base_port,
        local_interface_ip,
        ttl,
        default_output_mode,
        enabled: 1,
        brand_model,
        tv_standard,
        pkt_size,
        rtp
      },
      null,
      { unitsForOverlap: [...baseUnits, ...created] }
    );
    if (parsed.error) {
      skipped.push(`Equipo ${i + 1}: ${parsed.error}`);
      cursor = chEnd + 1;
      continue;
    }
    const u = parsed.unit;
    const info = db
      .prepare(
        `INSERT INTO wk2500_units (name, ip_mode, dest_ip, base_port, local_interface_ip, ttl, ch_start, ch_end,
                                   default_output_mode, model_channels, enabled, notes,
                                   brand_model, tv_standard, pkt_size, rtp, channels_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        u.name,
        u.ip_mode,
        u.dest_ip,
        u.base_port,
        u.local_interface_ip,
        u.ttl,
        u.ch_start,
        u.ch_end,
        u.default_output_mode,
        u.model_channels,
        u.enabled,
        u.notes,
        u.brand_model,
        u.tv_standard,
        u.pkt_size,
        u.rtp,
        u.channels_json
      );
    const row = db.prepare('SELECT * FROM wk2500_units WHERE id = ?').get(Number(info.lastInsertRowid));
    applyUnitToChannels(row);
    created.push(unitResponse(row));
    cursor = chEnd + 1;
  }

  const units = listUnitRows();
  const slots = db.prepare('SELECT catv_ch, stream_id, custom_source_url, enabled FROM wk2500_channels').all();
  const coverage = buildCoverage(units, slots);
  res.status(created.length ? 201 : 400).json({
    ok: created.length > 0,
    created,
    skipped,
    coverage,
    message: created.length
      ? `${created.length} × ${model.label} listos: ${describeRanges(created)}. Cobertura ${coverage.covered_channels}/${CATV_TOTAL_SLOTS} canales.`
      : 'No se pudo crear ningún equipo.'
  });
});

// Set and apply Dedicated Network Interface (NIC) for UDP output toward WK2500 hardware
wk2500Router.post('/api/wk2500/dedicated-interface', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const {
    if_name = '',
    ip_address = '',
    multicast_subnet = '239.25.0.0/24',
    apply_to_all_channels = true,
    ch_start = 2,
    ch_end = 125
  } = req.body || {};

  const cleanIp = String(ip_address || '').trim();
  const interfaces = listHostIpv4Interfaces();
  const matched = interfaces.find((x) => x.address === cleanIp);
  const resolvedName = String(if_name || matched?.name || '').trim();

  // Nunca aplicar una IP que no exista en este servidor: el bind de los 124 workers fallaría (EADDRNOTAVAIL)
  if (cleanIp && !matched) {
    return res.status(400).json({
      error: `La IP ${cleanIp} no existe en este servidor. IPs disponibles: ${interfaces
        .map((x) => `${x.name}=${x.address}`)
        .join(', ') || 'ninguna'}.`
    });
  }
  if (if_name && !interfaces.some((x) => x.name === String(if_name).trim()) && !matched) {
    return res.status(400).json({ error: `La interfaz ${if_name} no existe en este servidor.` });
  }

  const saved = saveDedicatedWk2500NicConfig({
    if_name: resolvedName,
    ip_address: cleanIp,
    multicast_subnet
  });

  const fromCh = Math.max(2, Math.min(125, Number(ch_start) || 2));
  const toCh = Math.max(fromCh, Math.min(125, Number(ch_end) || 125));

  if (apply_to_all_channels) {
    withSqliteBusyRetry(() => {
      db.prepare(
        "UPDATE wk2500_channels SET local_interface_ip = ?, updated_at = datetime('now') WHERE catv_ch BETWEEN ? AND ?"
      ).run(cleanIp, fromCh, toCh);
    });
  }

  // Hot-rebind any active UDP workers in range onto the newly selected dedicated NIC
  let reboundCount = 0;
  for (let ch = fromCh; ch <= toCh; ch++) {
    const slot = db.prepare('SELECT enabled FROM wk2500_channels WHERE catv_ch = ?').get(ch);
    if (udpWorkers.has(ch) || slot?.enabled) {
      startWk2500ChannelWorker(ch);
      reboundCount += 1;
    }
  }

  const linuxRouteCmd =
    cleanIp && resolvedName
      ? `sudo ip route replace ${saved.multicast_subnet} dev ${resolvedName} src ${cleanIp}`
      : '';

  res.json({
    ok: true,
    dedicated_nic: saved,
    reboundCount,
    linuxRouteCmd
  });
});

// Exact Stream -> CATV Channel Number Assignment (e.g. choose whether stream goes on CH 2, CH 3, ..., CH 125, or unassign)
wk2500Router.post('/api/wk2500/assign-stream-channel', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const { stream_id, target_catv_ch = null, enabled = undefined, swap_if_occupied = true } = req.body || {};
  const sid = Number(stream_id);
  if (!sid) return res.status(400).json({ error: 'stream_id requerido.' });

  const streamExists = db.prepare('SELECT id, name FROM streams WHERE id = ?').get(sid);
  if (!streamExists) return res.status(404).json({ error: 'El canal seleccionado no existe en el panel.' });

  const targetCh =
    target_catv_ch === null || target_catv_ch === '' || Number(target_catv_ch) === 0
      ? null
      : Number(target_catv_ch);
  if (targetCh !== null && (targetCh < 2 || targetCh > 125)) {
    return res.status(400).json({ error: 'El número de canal CATV debe estar entre 2 y 125.' });
  }

  const prevSlots = db.prepare('SELECT * FROM wk2500_channels WHERE stream_id = ?').all(sid);
  const targetSlot = targetCh ? db.prepare('SELECT * FROM wk2500_channels WHERE catv_ch = ?').get(targetCh) : null;
  const affectedChs = new Set();

  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      // If simply unassigning from CATV:
      if (targetCh === null) {
        for (const ps of prevSlots) {
          db.prepare(
            "UPDATE wk2500_channels SET stream_id = NULL, enabled = 0, updated_at = datetime('now') WHERE catv_ch = ?"
          ).run(ps.catv_ch);
          affectedChs.add(ps.catv_ch);
        }
      } else {
        const prevPrimary = prevSlots[0] || null;
        const occupantSid =
          targetSlot && targetSlot.stream_id && Number(targetSlot.stream_id) !== sid
            ? Number(targetSlot.stream_id)
            : null;

        // Clear previous slots of this stream (or swap occupant into prevPrimary)
        for (const ps of prevSlots) {
          if (ps.catv_ch === targetCh) continue;
          if (swap_if_occupied && occupantSid && prevPrimary && ps.catv_ch === prevPrimary.catv_ch) {
            db.prepare(
              "UPDATE wk2500_channels SET stream_id = ?, enabled = ?, updated_at = datetime('now') WHERE catv_ch = ?"
            ).run(occupantSid, targetSlot.enabled ? 1 : 0, ps.catv_ch);
          } else {
            db.prepare(
              "UPDATE wk2500_channels SET stream_id = NULL, enabled = 0, updated_at = datetime('now') WHERE catv_ch = ?"
            ).run(ps.catv_ch);
          }
          affectedChs.add(ps.catv_ch);
        }

        const dedIp = getDedicatedWk2500NicConfig().ip_address;
        const nextEnabled =
          enabled !== undefined
            ? enabled
              ? 1
              : 0
            : prevPrimary
            ? prevPrimary.enabled
            : targetSlot?.enabled || 0;
        const nextIfIp = targetSlot?.local_interface_ip || dedIp || '';

        db.prepare(
          `UPDATE wk2500_channels
           SET stream_id = ?, local_interface_ip = ?, enabled = ?, updated_at = datetime('now')
           WHERE catv_ch = ?`
        ).run(sid, nextIfIp, nextEnabled ? 1 : 0, targetCh);
        affectedChs.add(targetCh);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  for (const ch of affectedChs) {
    const row = db.prepare('SELECT enabled, stream_id, custom_source_url FROM wk2500_channels WHERE catv_ch = ?').get(ch);
    if (row && row.enabled && (row.stream_id || row.custom_source_url)) {
      startWk2500ChannelWorker(ch);
    } else {
      stopWk2500ChannelWorker(ch);
    }
  }

  res.json({ ok: true, stream_id: sid, target_catv_ch: targetCh });
});

// Move or Swap two CATV channel numbers directly (e.g. move CH 2 -> CH 3)
wk2500Router.post('/api/wk2500/swap-or-move', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const fromCh = Number(req.body?.from_ch);
  const toCh = Number(req.body?.to_ch);
  if (fromCh < 2 || fromCh > 125 || toCh < 2 || toCh > 125 || fromCh === toCh) {
    return res.status(400).json({ error: 'Indica dos canales CATV válidos y distintos entre 2 y 125.' });
  }

  const slotA = db.prepare('SELECT * FROM wk2500_channels WHERE catv_ch = ?').get(fromCh);
  const slotB = db.prepare('SELECT * FROM wk2500_channels WHERE catv_ch = ?').get(toCh);
  if (!slotA || !slotB) return res.status(404).json({ error: 'Canal CATV no encontrado.' });

  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const upd = db.prepare(
        `UPDATE wk2500_channels
         SET stream_id = ?, custom_name = ?, custom_source_url = ?,
             output_mode = ?, muxrate_kbps = ?, enabled = ?, updated_at = datetime('now')
         WHERE catv_ch = ?`
      );
      upd.run(
        slotB.stream_id,
        slotB.custom_name,
        slotB.custom_source_url,
        slotB.output_mode,
        slotB.muxrate_kbps,
        slotB.stream_id || slotB.custom_source_url ? slotB.enabled : 0,
        fromCh
      );
      upd.run(
        slotA.stream_id,
        slotA.custom_name,
        slotA.custom_source_url,
        slotA.output_mode,
        slotA.muxrate_kbps,
        slotA.stream_id || slotA.custom_source_url ? slotA.enabled : 0,
        toCh
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  for (const ch of [fromCh, toCh]) {
    const row = db.prepare('SELECT enabled, stream_id, custom_source_url FROM wk2500_channels WHERE catv_ch = ?').get(ch);
    if (row && row.enabled && (row.stream_id || row.custom_source_url)) {
      startWk2500ChannelWorker(ch);
    } else {
      stopWk2500ChannelWorker(ch);
    }
  }

  res.json({ ok: true, from_ch: fromCh, to_ch: toCh });
});

// 1-Click Peer-to-Peer TVLister MNF Trunk Sync (pulls channel list from Origin TVLister VPS via mnf://)
wk2500Router.post('/api/wk2500/mnf-trunks/sync', requireAuth, requireAdmin, async (req, res) => {
  ensureCatvSlotsInitialized();
  const {
    name = 'Panel TVLister Principal (MNF)',
    origin_url = '',
    username = '',
    password = '',
    auto_assign_catv = true,
    start_catv_ch = 2
  } = req.body || {};

  let cleanOrigin = String(origin_url || '').trim().replace(/\/+$/, '');
  if (!cleanOrigin || !username || !password) {
    return res.status(400).json({
      error: 'Indica la URL del Panel TVLister Origen, Usuario y Contraseña de la línea troncal.'
    });
  }
  if (!/^https?:\/\//i.test(cleanOrigin)) cleanOrigin = `http://${cleanOrigin}`;

  let parsedOrigin;
  try {
    parsedOrigin = new URL(cleanOrigin);
  } catch {
    return res.status(400).json({ error: 'URL del Panel TVLister Origen inválida.' });
  }

  // Optional check of max_connections on Origin line via Xtream API
  let maxConnWarning = '';
  try {
    const acInfo = new AbortController();
    const tInfo = setTimeout(() => acInfo.abort(), 5000);
    const infoRes = await fetch(
      `${parsedOrigin.origin}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      { signal: acInfo.signal }
    );
    clearTimeout(tInfo);
    if (infoRes.ok) {
      const infoJson = await infoRes.json();
      const maxC = Number(infoJson?.user_info?.max_connections ?? -1);
      if (maxC > 0 && maxC < 124) {
        maxConnWarning = `Aviso importante: La línea "${username}" en el Panel Origen tiene límite de ${maxC} conexiones simultáneas. Súbela a 150 (o 0 ilimitado) en el Panel Origen para que los 124 canales WK2500 funcionen juntos 24/7.`;
      }
    }
  } catch {
    // non-fatal
  }

  // Pull native MNF M3U playlist from Origin TVLister
  let m3uText = '';
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    const m3uUrl = `${parsedOrigin.origin}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=mnf`;
    const r = await fetch(m3uUrl, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(400).json({
        error: `El Panel TVLister Origen respondió HTTP ${r.status}: ${errTxt.slice(0, 120)}`
      });
    }
    m3uText = await r.text();
  } catch (err) {
    return res.status(400).json({
      error: `No se pudo conectar al Panel TVLister Origen (${parsedOrigin.origin}): ${err.message}`
    });
  }

  const parsedItems = parseM3uPlaylistText(m3uText).filter((item) => /\/(mnf|live)\//i.test(item.url));
  if (parsedItems.length === 0) {
    return res.status(400).json({
      error: 'La línea conectó pero no devolvió canales en vivo asignados en su Bouquet.'
    });
  }

  const mnfScheme = parsedOrigin.protocol === 'https:' ? 'mnfs' : 'mnf';
  let insertedCount = 0;
  let updatedCount = 0;
  const syncedStreamIds = [];

  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const existingCats = db.prepare("SELECT * FROM categories WHERE type = 'live'").all();
      const catMap = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));
      const insCat = db.prepare("INSERT INTO categories (name, type, sort_order) VALUES (?, 'live', 0)");

      const existingStreams = db.prepare('SELECT * FROM streams').all();
      const bySource = new Map(existingStreams.map((s) => [String(s.source_url).toLowerCase(), s]));
      const byName = new Map(existingStreams.map((s) => [String(s.name).trim().toLowerCase(), s]));

      const updStream = db.prepare(
        `UPDATE streams
         SET source_url = ?, logo_url = COALESCE(NULLIF(?, ''), logo_url), epg_channel_id = COALESCE(NULLIF(?, ''), epg_channel_id)
         WHERE id = ?`
      );
      const insStream = db.prepare(
        `INSERT INTO streams (
           name, category_id, source_url, logo_url, epg_channel_id, stream_mode, status, bitrate_kbps, sort_order
         ) VALUES (?, ?, ?, ?, ?, 'direct', 'running', 2500, ?)`
      );

      let maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM streams').get()?.m || 0;
      const b1 = db.prepare('SELECT * FROM bouquets ORDER BY id ASC LIMIT 1').get();
      const b1Ids = b1 ? JSON.parse(b1.stream_ids_json || '[]') : [];

      for (const item of parsedItems) {
        // Normalize URL to mnf://host:port/mnf/user/pass/id.mnf
        const mnfUrl = item.url
          .replace(/^https?:\/\//i, `${mnfScheme}://`)
          .replace(/\/live\/([^/]+)\/([^/]+)\/(\d+)\.(ts|m3u8)$/i, '/mnf/$1/$2/$3.mnf');

        const catName = item.groupTitle || 'Troncal MNF';
        let catId = catMap.get(catName.toLowerCase());
        if (!catId) {
          catId = Number(insCat.run(catName).lastInsertRowid);
          catMap.set(catName.toLowerCase(), catId);
        }

        const matched = bySource.get(mnfUrl.toLowerCase()) || byName.get(item.name.trim().toLowerCase());
        if (matched) {
          updStream.run(mnfUrl, item.logoUrl, item.tvgId, matched.id);
          syncedStreamIds.push(matched.id);
          updatedCount += 1;
        } else {
          maxOrder += 1;
          const sid = Number(
            insStream.run(item.name.trim(), catId, mnfUrl, item.logoUrl || '', item.tvgId || '', maxOrder)
              .lastInsertRowid
          );
          syncedStreamIds.push(sid);
          if (!b1Ids.includes(sid)) b1Ids.push(sid);
          insertedCount += 1;
        }
      }

      if (b1 && insertedCount > 0) {
        db.prepare('UPDATE bouquets SET stream_ids_json = ? WHERE id = ?').run(JSON.stringify(b1Ids), b1.id);
      }

      // Persist/update mnf_trunks record
      const existingTrunk = db
        .prepare('SELECT id FROM mnf_trunks WHERE origin_url = ? AND username = ? LIMIT 1')
        .get(parsedOrigin.origin, username);
      if (existingTrunk) {
        db.prepare(
          "UPDATE mnf_trunks SET name = ?, password = ?, last_sync_at = datetime('now'), synced_count = ? WHERE id = ?"
        ).run(name, password, syncedStreamIds.length, existingTrunk.id);
      } else {
        db.prepare(
          "INSERT INTO mnf_trunks (name, origin_url, username, password, last_sync_at, synced_count) VALUES (?, ?, ?, ?, datetime('now'), ?)"
        ).run(name, parsedOrigin.origin, username, password, syncedStreamIds.length);
      }

      // Auto-assign sequentially into CATV channels 2..125 if requested
      if (auto_assign_catv) {
        const startCh = Math.min(125, Math.max(2, Number(start_catv_ch) || 2));
        const updSlot = db.prepare(
          "UPDATE wk2500_channels SET stream_id = ?, updated_at = datetime('now') WHERE catv_ch = ?"
        );
        let cursorCh = startCh;
        for (const sid of syncedStreamIds) {
          if (cursorCh > 125) break;
          updSlot.run(sid, cursorCh);
          cursorCh += 1;
        }
      }

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  res.json({
    ok: true,
    insertedCount,
    updatedCount,
    totalSynced: syncedStreamIds.length,
    autoAssignedToCatv: Boolean(auto_assign_catv),
    maxConnWarning
  });
});

// Bulk-configure UDP addressing & auto-assign channels across CATV 2..125 (supports Multicast or Unicast per WK2500 range!)
wk2500Router.post('/api/wk2500/bulk-configure', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const {
    ch_start = 2,
    ch_end = 125,
    ip_mode = 'multicast', // 'multicast' | 'unicast'
    dest_ip = '239.25.0.0',
    base_port = 5000,
    local_interface_ip = '',
    ttl = 16,
    output_mode = 'direct_spts',
    muxrate_kbps = 0,
    auto_assign_panel_streams = false
  } = req.body || {};

  const fromCh = Math.max(2, Math.min(125, Number(ch_start) || 2));
  const toCh = Math.max(fromCh, Math.min(125, Number(ch_end) || 125));

  const cleanBasePort = Number(base_port);
  if (!Number.isInteger(cleanBasePort) || cleanBasePort < 1 || cleanBasePort > 65535) {
    return res.status(400).json({ error: `El puerto base UDP ${base_port} no es válido (1–65535).` });
  }
  if (cleanBasePort + (toCh - fromCh) > 65535) {
    return res.status(400).json({ error: 'El rango de puertos se sale de 65535; baja el rango de canales o el puerto base.' });
  }
  const cleanDestIp = String(dest_ip || '').trim();
  if (!isValidIpv4(cleanDestIp)) {
    return res.status(400).json({ error: `La IP destino "${cleanDestIp}" no es una IPv4 válida.` });
  }
  if (ip_mode === 'multicast' && !isMulticastIp(cleanDestIp)) {
    return res.status(400).json({ error: 'El modo multicast requiere una IP de grupo (224.0.0.0 – 239.255.255.255).' });
  }
  if (ip_mode === 'unicast' && isMulticastIp(cleanDestIp)) {
    return res.status(400).json({
      error: `El modo unicast requiere la IP del WK2500, no un grupo multicast (${cleanDestIp}).`
    });
  }
  if (ip_mode !== 'multicast' && ip_mode !== 'unicast') {
    return res.status(400).json({ error: 'ip_mode debe ser "multicast" o "unicast".' });
  }
  const bulkMode = validateWk2500OutputMode(output_mode);
  if (!bulkMode) {
    return res.status(400).json({ error: `Perfil de salida "${output_mode}" no soportado.` });
  }
  const cleanBulkIfIp = String(local_interface_ip || '').trim();
  if (cleanBulkIfIp) {
    const hostIps = listHostIpv4Interfaces().map((x) => x.address);
    if (!hostIps.includes(cleanBulkIfIp)) {
      return res.status(400).json({
        error: `La IP de salida ${cleanBulkIfIp} no existe en este servidor. IPs disponibles: ${hostIps.join(', ') || 'ninguna'}.`
      });
    }
  }

  // Detecta colisiones: si otra unidad ya usa este rango de puertos en el mismo grupo, el TS se mezcla.
  const plannedHosts = new Set();
  for (let ch = fromCh; ch <= toCh; ch++) {
    const addr = computeDefaultUdpAddress(ch, ip_mode, cleanDestIp, cleanBasePort);
    const key = `${addr.udp_host}:${addr.udp_port}`;
    if (plannedHosts.has(key)) {
      return res.status(409).json({ error: `Dirección UDP repetida en el rango: ${key}.` });
    }
    plannedHosts.add(key);
    const clash = db
      .prepare('SELECT catv_ch FROM wk2500_channels WHERE udp_host = ? AND udp_port = ? AND catv_ch NOT BETWEEN ? AND ? LIMIT 1')
      .get(addr.udp_host, addr.udp_port, fromCh, toCh);
    if (clash) {
      return res.status(409).json({
        error: `El destino ${key} del rango ya lo usa el Canal CATV ${clash.catv_ch}. Cambia el puerto base o el grupo multicast.`
      });
    }
  }

  const panelStreams = auto_assign_panel_streams
    ? db.prepare('SELECT id FROM streams ORDER BY sort_order ASC, id ASC').all()
    : [];

  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const upd = db.prepare(
        `UPDATE wk2500_channels
         SET udp_host = ?,
             udp_port = ?,
             local_interface_ip = ?,
             ttl = ?,
             output_mode = ?,
             muxrate_kbps = ?,
             stream_id = CASE WHEN ? IS NOT NULL THEN ? ELSE stream_id END,
             updated_at = datetime('now')
         WHERE catv_ch = ?`
      );

      let streamIdx = 0;
      for (let ch = fromCh; ch <= toCh; ch++) {
        const addr = computeDefaultUdpAddress(ch, ip_mode, cleanDestIp, cleanBasePort);
        const mappedSid =
          auto_assign_panel_streams && streamIdx < panelStreams.length ? panelStreams[streamIdx++].id : null;
        upd.run(
          addr.udp_host,
          addr.udp_port,
          cleanBulkIfIp,
          Math.max(1, Number(ttl) || 16),
          bulkMode,
          Math.max(0, Number(muxrate_kbps) || 0),
          mappedSid,
          mappedSid,
          ch
        );
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  });

  // Restart any currently active workers in this range so they immediately pick up the new UDP address/profile
  for (let ch = fromCh; ch <= toCh; ch++) {
    if (udpWorkers.has(ch)) {
      startWk2500ChannelWorker(ch);
    }
  }

  res.json({ ok: true, updatedRange: `${fromCh}–${toCh}` });
});

// Update single CATV channel (2..125)
wk2500Router.put('/api/wk2500/channels/:catvCh', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const ch = Number(req.params.catvCh);
  if (ch < 2 || ch > 125) return res.status(400).json({ error: 'El canal CATV debe estar entre 2 y 125.' });

  const existing = db.prepare('SELECT * FROM wk2500_channels WHERE catv_ch = ?').get(ch);
  if (!existing) return res.status(404).json({ error: 'Slot CATV no encontrado.' });

  const b = req.body || {};
  const nextStreamId =
    b.stream_id !== undefined ? (b.stream_id === null || b.stream_id === '' ? null : Number(b.stream_id)) : existing.stream_id;
  const nextCustomName = b.custom_name !== undefined ? String(b.custom_name).trim() : existing.custom_name;
  const nextCustomUrl = b.custom_source_url !== undefined ? String(b.custom_source_url).trim() : existing.custom_source_url;
  const nextHost = b.udp_host !== undefined ? String(b.udp_host).trim() : existing.udp_host;
  const nextPort = b.udp_port !== undefined ? Number(b.udp_port) : existing.udp_port;
  const nextIfIp = b.local_interface_ip !== undefined ? String(b.local_interface_ip).trim() : existing.local_interface_ip;
  const nextMode = b.output_mode !== undefined ? String(b.output_mode) : existing.output_mode;
  const nextMux = b.muxrate_kbps !== undefined ? Math.max(0, Number(b.muxrate_kbps) || 0) : existing.muxrate_kbps;
  const nextEnabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : existing.enabled;

  if (nextEnabled && !nextStreamId && !nextCustomUrl) {
    return res.status(400).json({
      error: `Primero selecciona qué canal va en el CH ${ch} antes de activar su salida UDP.`
    });
  }

  // Sin un equipo WK2500 que cubra este número no hay salida RF posible.
  if (nextEnabled) {
    const unitsNow = listUnitRows();
    if (unitsNow.length && !findUnitForChannel(unitsNow.filter((u) => Number(u.enabled) !== 0), ch)) {
      return res.status(400).json({
        error:
          `El CH ${ch} no lo cubre ningún modulador WK2500 activo. ` +
          `Equipos actuales: ${describeRanges(unitsNow) || 'ninguno'}. Ajusta el rango en la sección de equipos.`
      });
    }
  }

  const target = validateWk2500UdpTarget({ udp_host: nextHost, udp_port: nextPort, catv_ch: ch });
  if (!target.ok) return res.status(target.status || 400).json({ error: target.error });

  const cleanMode = validateWk2500OutputMode(nextMode);
  if (!cleanMode) {
    return res.status(400).json({
      error: `Perfil de salida "${nextMode}" no soportado. Usa uno de: ${WK2500_OUTPUT_MODES.join(', ')}.`
    });
  }

  const cleanIfIp = String(nextIfIp || '').trim();
  if (cleanIfIp) {
    const hostIps = listHostIpv4Interfaces().map((x) => x.address);
    if (!hostIps.includes(cleanIfIp)) {
      return res.status(400).json({
        error: `La IP de salida ${cleanIfIp} no existe en este servidor. IPs disponibles: ${hostIps.join(', ') || 'ninguna'}.`
      });
    }
  }

  const nextServiceId = b.service_id !== undefined ? Number(b.service_id) : existing.service_id;
  if (!Number.isInteger(nextServiceId) || nextServiceId < 1 || nextServiceId > 65535) {
    return res.status(400).json({ error: 'El Service ID debe ser un entero entre 1 y 65535.' });
  }

  const nextTtl = b.ttl !== undefined ? Number(b.ttl) : existing.ttl;
  if (!Number.isInteger(nextTtl) || nextTtl < 1 || nextTtl > 255) {
    return res.status(400).json({ error: 'El TTL multicast debe ser un entero entre 1 y 255.' });
  }

  // Frecuencia RF: heredada del plan del equipo o forzada por el operador (HRC/IRC/ajustes finos).
  const unlockFreq = b.freq_locked === false || b.freq_mhz === null || b.freq_mhz === '' || b.freq_mhz === undefined;
  const nextFreqLocked = b.freq_locked !== undefined ? (b.freq_locked ? 1 : 0) : existing.freq_locked;
  let nextFreq = b.freq_mhz !== undefined && b.freq_mhz !== null && b.freq_mhz !== '' ? Number(b.freq_mhz) : existing.freq_mhz;
  if (b.freq_mhz !== undefined && b.freq_mhz !== null && b.freq_mhz !== '') {
    if (!Number.isFinite(nextFreq) || nextFreq < 40 || nextFreq > 1000) {
      return res.status(400).json({ error: 'La frecuencia de video debe estar entre 40 y 1000 MHz.' });
    }
  }
  let nextFreqLockedFinal = nextFreqLocked ? 1 : 0;
  if (unlockFreq) nextFreqLockedFinal = 0;
  if (nextFreqLockedFinal === 0 && b.freq_mhz === undefined) {
    // Sin override activo se recalcula con el plan del equipo que cubre este canal.
    const unitRow = unitForSlot({ ...existing, catv_ch: ch });
    nextFreq = getCatvStdChannelInfo(ch, unitRow?.tv_standard || DEFAULT_TV_STANDARD).freq_mhz;
  }

  // Transporte por canal: 0 = heredar del equipo; 188/1316 = propio; rtp -1 = heredar
  const nextPkt = b.pkt_size !== undefined ? Number(b.pkt_size) : Number(existing.pkt_size || 0);
  if (nextPkt !== 0 && !PKT_SIZES.includes(nextPkt)) {
    return res.status(400).json({ error: `El tamaño de datagrama debe ser 0 (heredar), ${PKT_SIZES.join(' o ')}.` });
  }
  const nextRtp = b.rtp === undefined ? Number(existing.rtp ?? -1) : b.rtp === null ? -1 : b.rtp ? 1 : 0;
  if (![-1, 0, 1].includes(nextRtp)) {
    return res.status(400).json({ error: 'rtp debe ser true, false o null (heredar del equipo).' });
  }

  // El par host:puerto ya quedó validado como único, así que dos canales nunca comparten salida UDP.
  withSqliteBusyRetry(() => {
    db.prepare(
      `UPDATE wk2500_channels
       SET stream_id = ?, custom_name = ?, custom_source_url = ?,
           udp_host = ?, udp_port = ?, local_interface_ip = ?,
           output_mode = ?, muxrate_kbps = ?, enabled = ?,
           service_id = ?, ttl = ?, freq_mhz = ?, freq_locked = ?,
           pkt_size = ?, rtp = ?, updated_at = datetime('now')
       WHERE catv_ch = ?`
    ).run(
      nextStreamId,
      nextCustomName,
      nextCustomUrl,
      target.host,
      target.port,
      cleanIfIp,
      cleanMode,
      nextMux,
      nextEnabled,
      nextServiceId,
      nextTtl,
      nextFreq,
      nextFreqLockedFinal,
      nextPkt,
      nextRtp,
      ch
    );
  });

  if (nextEnabled) {
    startWk2500ChannelWorker(ch);
  } else {
    stopWk2500ChannelWorker(ch);
  }

  res.json({ ok: true });
});

// Start / Stop single or all assigned CATV channels (2..125)
wk2500Router.post('/api/wk2500/control', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const { action = 'start_all', catv_ch = null, ch_start = 2, ch_end = 125 } = req.body || {};

  if (action === 'start_one' && catv_ch) {
    const ch = Number(catv_ch);
    db.prepare("UPDATE wk2500_channels SET enabled = 1, updated_at = datetime('now') WHERE catv_ch = ?").run(ch);
    const ok = startWk2500ChannelWorker(ch);
    if (!ok) {
      return res.status(400).json({ error: `El Canal CATV ${ch} no tiene ningún stream/URL asignado todavía.` });
    }
    return res.json({ ok: true, started: 1 });
  }

  if (action === 'stop_one' && catv_ch) {
    const ch = Number(catv_ch);
    db.prepare("UPDATE wk2500_channels SET enabled = 0, updated_at = datetime('now') WHERE catv_ch = ?").run(ch);
    stopWk2500ChannelWorker(ch);
    return res.json({ ok: true, stopped: 1 });
  }

  if (action === 'stop_all') {
    db.prepare("UPDATE wk2500_channels SET enabled = 0, updated_at = datetime('now')").run();
    stopAllWk2500Workers();
    return res.json({ ok: true });
  }

  // start_all (within ch_start..ch_end that have stream_id or custom_source_url)
  const fromCh = Math.max(2, Math.min(125, Number(ch_start) || 2));
  const toCh = Math.max(fromCh, Math.min(125, Number(ch_end) || 125));
  const assigned = db
    .prepare(
      `SELECT catv_ch FROM wk2500_channels
       WHERE catv_ch BETWEEN ? AND ?
         AND (stream_id IS NOT NULL OR custom_source_url != '')
       ORDER BY catv_ch ASC`
    )
    .all(fromCh, toCh);

  if (assigned.length === 0) {
    return res.status(400).json({
      error: 'Primero asigna canales del panel a la grilla CATV (2 al 125) usando "Auto-Numerar 2 al 125" o sincroniza tu Troncal MNF.'
    });
  }

  // Si hay equipos declarados, sólo se encienden los números que algún modulador puede generar.
  const unitsNow = listUnitRows().filter((u) => Number(u.enabled) !== 0);
  const startable = unitsNow.length
    ? assigned.filter((row) => Boolean(findUnitForChannel(unitsNow, row.catv_ch)))
    : assigned;
  const skippedUncovered = assigned.length - startable.length;
  if (startable.length === 0) {
    return res.status(400).json({
      error: `Ninguno de los canales asignados está cubierto por tus equipos WK2500 (${describeRanges(unitsNow)}).`
    });
  }

  const upd = db.prepare("UPDATE wk2500_channels SET enabled = 1, updated_at = datetime('now') WHERE catv_ch = ?");
  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of startable) upd.run(row.catv_ch);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
  });

  startable.forEach((row, idx) => {
    setTimeout(() => {
      startWk2500ChannelWorker(row.catv_ch);
    }, idx * 55).unref?.();
  });

  res.json({ ok: true, startedCount: startable.length, skippedUncovered });
});

// Export CSV / M3U table for fast programming of WK2500 IP-to-Analog Modulator UI
wk2500Router.get('/api/wk2500/export-table', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const format = String(req.query.format || 'csv').toLowerCase();
  const rows = db
    .prepare(
      `SELECT w.*, s.name as stream_name
       FROM wk2500_channels w
       LEFT JOIN streams s ON s.id = w.stream_id
       ORDER BY w.catv_ch ASC`
    )
    .all();

  const unitRows = listUnitRows();
  const unitsById = new Map(unitRows.map((u) => [Number(u.id), u]));
  const infoFor = (r) => {
    const unit = unitsById.get(Number(r.unit_id)) || findUnitForChannel(unitRows.filter((u) => Number(u.enabled) !== 0), r.catv_ch);
    return {
      info: getCatvStdChannelInfo(r.catv_ch, unit?.tv_standard || DEFAULT_TV_STANDARD, r.freq_locked ? r.freq_mhz : null),
      unit,
      transport: resolveEffectiveTransport(r, unit || null)
    };
  };

  // Orden real de programación: equipo por equipo y, dentro de cada uno, en el orden
  // de sus portadoras RF (portadora 1 primero). Lo que no tiene equipo va al final.
  const carrierIndex = new Map();
  for (const u of unitRows) {
    unitChannelList(u).forEach((ch, idx) => carrierIndex.set(`${u.id}:${ch}`, idx + 1));
  }
  const unitOrder = new Map(unitRows.map((u, idx) => [Number(u.id), idx]));
  const orderedRows = [...rows].sort((a, b) => {
    const ua = infoFor(a).unit;
    const ub = infoFor(b).unit;
    const ka = ua ? unitOrder.get(Number(ua.id)) : 9999;
    const kb = ub ? unitOrder.get(Number(ub.id)) : 9999;
    if (ka !== kb) return ka - kb;
    const ca = ua ? carrierIndex.get(`${ua.id}:${a.catv_ch}`) ?? 9999 : 9999;
    const cb = ub ? carrierIndex.get(`${ub.id}:${b.catv_ch}`) ?? 9999 : 9999;
    if (ca !== cb) return ca - cb;
    return Number(a.catv_ch) - Number(b.catv_ch);
  });

  // ---- Filtro por equipo: cada modulador recibe SU propio CSV ----
  // unit_id=<id>  -> sólo las portadoras de ese equipo (orden de portadora)
  // unit_id=all / sin parámetro -> plan completo
  const rawUnit = String(req.query.unit_id ?? req.query.unit ?? '').trim();
  let unitFilter = null;
  if (rawUnit && rawUnit !== 'all' && rawUnit !== '0') {
    unitFilter = unitsById.get(Number(rawUnit)) || null;
    if (!unitFilter) {
      return res.status(404).json({ error: `No existe el equipo ${rawUnit}.` });
    }
  }
  const fileRows = unitFilter ? orderedRows.filter((r) => Number(infoFor(r).unit?.id) === Number(unitFilter.id)) : orderedRows;
  const unitSlug = (u) => {
    const chans = unitChannelList(u);
    const base = String(u.name || `equipo_${u.id}`)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || `equipo_${u.id}`;
    // Nombre inequívoco: equipo + canal de la portadora 1 + cantidad de portadoras.
    const first = chans[0] ?? 0;
    return `${base}_P1-CH${first}_${chans.length}port`;
  };

  if (format === 'm3u') {
    const out = ['#EXTM3U'];
    for (const r of fileRows) {
      const title = r.custom_name || r.stream_name || `CATV CH ${r.catv_ch}`;
      const { info } = infoFor(r);
      out.push(
        `#EXTINF:-1 tvg-chno="${r.catv_ch}" group-title="${info.band_label}",CH ${r.catv_ch} (${info.freq_mhz} MHz) - ${title}`
      );
      out.push(`udp://@${r.udp_host}:${r.udp_port}`);
    }
    const m3uName = unitFilter ? `${unitSlug(unitFilter)}.m3u` : 'wk2500_udp_2_al_125.m3u';
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${m3uName}"`);
    return res.send(out.join('\n') + '\n');
  }

  // ---- Páginas separadas del modulador -----------------------------------
  // Estos equipos tienen DOS tablas: la de canales (canal + frecuencia) y la de
  // entrada (grupo/IP + puerto UDP por portadora). Un CSV de una no cambia la
  // otra, y por eso «no cambiaba el UDP» al importar el archivo de canales.
  //   format=channel → Portadora, Canal, MHz vídeo, MHz audio [, Nombre]
  //   format=input   → Portadora, IP/Grupo UDP, Puerto UDP [, Nombre]
  if (format === 'channel' || format === 'input') {
    const eol = String(req.query.eol || '').toLowerCase() === 'crlf' ? '\r\n' : '\n';
    const withName = String(req.query.name ?? '1') === '1';
    const rows = [];
    if (format === 'channel') {
      rows.push(`Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz${withName ? ',Nombre_Canal' : ''}`);
      for (const r of fileRows) {
        const { info, unit } = infoFor(r);
        const carrier = unit ? carrierIndex.get(`${unit.id}:${r.catv_ch}`) ?? '' : '';
        const nm = withName ? `,${String(r.custom_name || r.stream_name || `CH${r.catv_ch}`).replace(/[",\r\n]/g, ' ').trim()}` : '';
        rows.push(`${carrier},${r.catv_ch},${info.freq_mhz},${info.audio_mhz}${nm}`);
      }
    } else {
      rows.push(`Portadora,IP_Destino_UDP,Puerto_UDP${withName ? ',Nombre_Canal' : ''}`);
      for (const r of fileRows) {
        const { unit } = infoFor(r);
        const carrier = unit ? carrierIndex.get(`${unit.id}:${r.catv_ch}`) ?? '' : '';
        const nm = withName ? `,${String(r.custom_name || r.stream_name || `CH${r.catv_ch}`).replace(/[",\r\n]/g, ' ').trim()}` : '';
        rows.push(`${carrier},${r.udp_host},${r.udp_port}${nm}`);
      }
    }
    const base = unitFilter ? unitSlug(unitFilter) : 'wk2500';
    const name = `${base}_${format === 'channel' ? 'canales' : 'entrada_udp'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-TVLister-CSV-Mode', format === 'channel' ? 'page-channels' : 'page-input');
    return res.send(rows.join(eol) + eol);
  }

  // ---- Formato REAL del equipo -------------------------------------------
  // Se rellena el CSV que exporta el propio modulador, así que la cabecera, el
  // orden de columnas, el separador y el final de línea son los suyos. Es el
  // único que estos equipos aceptan en su ventana de importación.
  if (format === 'dev' || format === 'device' || format === 'equipo') {
    let template = null;
    try {
      template = unitFilter?.csv_template ? JSON.parse(unitFilter.csv_template) : null;
    } catch {
      template = null;
    }
    if (!template) {
      res.setHeader('X-TVLister-CSV-Mode', 'compact-fallback');
      res.setHeader('X-TVLister-CSV-Warning', 'missing-template');
      const min = ['Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,IP_Destino_UDP,Puerto_UDP'];
      for (const r of fileRows) {
        const { info, unit } = infoFor(r);
        const carrier = unit ? carrierIndex.get(`${unit.id}:${r.catv_ch}`) ?? '' : '';
        min.push(`${carrier},${r.catv_ch},${info.freq_mhz},${info.audio_mhz},${r.udp_host},${r.udp_port}`);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${unitFilter ? `${unitSlug(unitFilter)}_import.csv` : 'wk2500_import_2_al_125.csv'}"`
      );
      return res.send(min.join('\n') + '\n');
    }
    const devRows = fileRows.map((r) => {
      const { info, unit } = infoFor(r);
      return {
        carrier: unit ? carrierIndex.get(`${unit.id}:${r.catv_ch}`) ?? '' : '',
        catv_ch: r.catv_ch,
        freq_mhz: info.freq_mhz,
        audio_mhz: info.audio_mhz,
        udp_host: r.udp_host,
        udp_port: r.udp_port,
        name: r.custom_name || r.stream_name || `CH${r.catv_ch}`,
        standard_short: info.standard_short,
        service_id: r.service_id,
        output_mode: r.output_mode
      };
    });
    const body = renderTemplate(template, devRows);
    const devName = unitFilter ? `${unitSlug(unitFilter)}_import.csv` : 'wk2500_import_2_al_125.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${devName}"`);
    res.setHeader('X-TVLister-CSV-Mode', 'device-template');
    res.setHeader('X-TVLister-CSV-Rows', String(devRows.length));
    res.setHeader('X-TVLister-CSV-Columns', String(template.cols || 0));
    return res.send(body);
  }

  // Formato compacto para la ventana de importación del modulador:
  // Portadora,Canal,Frecuencia de video,Audio,UDP — sin comillas ni columnas de relleno.
  if (format === 'csv-min' || format === 'csv_import') {
    // header=0 quita la cabecera (algunos firmwares sólo leen filas de datos)
    const withHeader = String(req.query.header ?? '1') !== '0';
    const eol = String(req.query.eol || '').toLowerCase() === 'crlf' ? '\r\n' : '\n';
    // name=1 añade una 7ª columna con el nombre del canal (algunos firmwares la
    // aceptan en la tabla de canales; por defecto NO, para no romper el Import).
    const withName = String(req.query.name ?? '0') === '1';
    const min = withHeader
      ? [
          'Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,IP_Destino_UDP,Puerto_UDP' +
            (withName ? ',Nombre_Canal' : '')
        ]
      : [];
    for (const r of fileRows) {
      const { info, unit } = infoFor(r);
      const carrier = unit ? carrierIndex.get(`${unit.id}:${r.catv_ch}`) ?? '' : '';
      const label = withName
        ? `,${String(r.custom_name || r.stream_name || `CH${r.catv_ch}`).replace(/[",\r\n]/g, ' ').trim()}`
        : '';
      min.push(`${carrier},${r.catv_ch},${info.freq_mhz},${info.audio_mhz},${r.udp_host},${r.udp_port}${label}`);
    }
    const minName = unitFilter ? `${unitSlug(unitFilter)}_import.csv` : 'wk2500_import_2_al_125.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${minName}"`);
    res.setHeader('X-TVLister-CSV-Mode', 'compact');
    return res.send(min.join(eol) + eol);
  }

  const csv = [
    'Equipo,Portadora,Canal_CATV,Estandar_TV,Frecuencia_Video_MHz,Portadora_Audio_MHz,Banda_CATV,Nombre_Canal,' +
      'IP_Destino_UDP,Puerto_UDP,Transporte,Program_Service_ID,Modo_Salida,Activo_24_7'
  ];
  for (const r of fileRows) {
    const { info, unit, transport } = infoFor(r);
    const title = String(r.custom_name || r.stream_name || '').replace(/"/g, '""');
    const unitName = String(unit?.name || '').replace(/"/g, '""');
    const carrier = unit ? carrierIndex.get(`${unit.id}:${r.catv_ch}`) ?? '' : '';
    const tx = `UDP${transport.rtp ? '+RTP' : ''}/${transport.pktSize}B`;
    csv.push(
      `"${unitName}",${carrier},${r.catv_ch},${info.standard_short},${info.freq_mhz},${info.audio_mhz},"${info.band_label}","${title}",` +
        `${r.udp_host},${r.udp_port},${tx},${r.service_id},${r.output_mode},${r.enabled ? 'SI' : 'NO'}`
    );
  }
  const csvName = unitFilter ? `${unitSlug(unitFilter)}.csv` : 'wk2500_plan_canales_2_al_125.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${csvName}"`);
  res.send(csv.join('\n') + '\n');
});

/**
 * Índice de CSVs por equipo: qué archivo descargar para cada modulador, sin tener
 * que abrir el plan completo. Lo usa la UI para pintar un botón por equipo.
 */
wk2500Router.get('/api/wk2500/export-units', requireAuth, requireAdmin, (req, res) => {
  ensureCatvSlotsInitialized();
  const units = listUnitRows();
  res.json({
    ok: true,
    units: units.map((u) => {
      const view = unitPublicView(u);
      return {
        id: Number(u.id),
        name: u.name,
        dest_ip: u.dest_ip,
        base_port: u.base_port,
        carrier_count: view.carrier_count,
        carrier_1: view.carriers[0]?.catv_ch ?? null,
        carrier_last: view.carriers[view.carriers.length - 1]?.catv_ch ?? null,
        channels_text: view.channels_text,
        range_label: view.range_label,
        tv_standard: getTvStandard(u.tv_standard || DEFAULT_TV_STANDARD).short,
        pkt_size: Number(u.pkt_size || 1316),
        rtp: Number(u.rtp || 0) === 1,
        url_csv: `/api/wk2500/export-table?format=csv&unit_id=${u.id}`,
        url_import: `/api/wk2500/export-table?format=csv-min&unit_id=${u.id}`,
        url_m3u: `/api/wk2500/export-table?format=m3u&unit_id=${u.id}`
      };
    })
  });
});

// El verificador necesita ver los workers vivos sin acoplarse a este archivo.
setCatvWorkerSnapshot(() => udpWorkers);
// La guardia de estabilidad reengancha canales sin importar este archivo.
globalThis.__tvlisterCatvRestartWorker = (ch) => restartWk2500ChannelWorker(ch);
