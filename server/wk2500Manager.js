import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import { db, withSqliteBusyRetry } from './db.js';
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
export function getCatvStdChannelInfo(catvCh) {
  const ch = Number(catvCh);
  let freqMhz = 55.25;
  let bandLabel = 'VHF Bajo';

  if (ch >= 2 && ch <= 4) {
    freqMhz = 54 + (ch - 2) * 6 + 1.25;
    bandLabel = 'VHF Bajo (2–4)';
  } else if (ch >= 5 && ch <= 6) {
    freqMhz = 76 + (ch - 5) * 6 + 1.25;
    bandLabel = 'VHF Bajo (5–6)';
  } else if (ch >= 7 && ch <= 13) {
    freqMhz = 174 + (ch - 7) * 6 + 1.25;
    bandLabel = 'VHF Alto (7–13)';
  } else if (ch >= 14 && ch <= 22) {
    freqMhz = 120 + (ch - 14) * 6 + 1.25;
    bandLabel = 'Banda Media (14–22)';
  } else if (ch >= 23 && ch <= 36) {
    freqMhz = 216 + (ch - 23) * 6 + 1.25;
    bandLabel = 'Superbanda (23–36)';
  } else if (ch >= 37 && ch <= 94) {
    freqMhz = 300 + (ch - 37) * 6 + 1.25;
    bandLabel = 'Hiperbanda (37–94)';
  } else if (ch >= 95 && ch <= 99) {
    freqMhz = 90 + (ch - 95) * 6 + 1.25;
    bandLabel = 'FM Baja A-5..A-1 (95–99)';
  } else if (ch >= 100 && ch <= 125) {
    freqMhz = 648 + (ch - 100) * 6 + 1.25;
    bandLabel = 'Ultrabanda (100–125)';
  }

  return {
    catv_ch: ch,
    freq_mhz: Number(freqMhz.toFixed(2)),
    audio_mhz: Number((freqMhz + 4.5).toFixed(2)),
    band_label: bandLabel
  };
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
export class Ts1316Packetizer {
  constructor(onPacket1316) {
    this.buf = Buffer.alloc(0);
    this.outAccum = Buffer.allocUnsafe(1316);
    this.outOffset = 0;
    this.onPacket1316 = onPacket1316;
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

      if (this.outOffset === 1316) {
        this.onPacket1316(Buffer.from(this.outAccum));
        this.outOffset = 0;
      }
    }

    this.buf = pos < len ? this.buf.subarray(pos) : Buffer.alloc(0);
  }
}

function resolveSlotUpstream(slotRow) {
  let streamRow = null;
  if (slotRow.stream_id) {
    streamRow = db.prepare('SELECT * FROM streams WHERE id = ?').get(Number(slotRow.stream_id));
  }
  const rawPrimary = String(slotRow.custom_source_url || streamRow?.source_url || '').trim();
  const rawBackup = String(streamRow?.backup_url || '').trim();
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

function shouldUseDirectNodeUdpEngine(slotRow, rawUrl, localHls) {
  if (localHls) return false; // Local HLS manifest is best muxed to SPTS via FFmpeg -c copy
  if (slotRow.output_mode !== 'direct_spts') return false;
  if (Number(slotRow.muxrate_kbps) > 0) return false;
  const lower = String(rawUrl || '').trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith('mnf://') || lower.startsWith('mnfs://') || lower.endsWith('.mnf')) return true;
  if (lower.includes('.m3u8') || lower.startsWith('hls://') || lower.startsWith('hlss://')) return false;
  if (lower.startsWith('m4f://') || lower.startsWith('m4fs://')) return false;
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('tshttp://') || lower.startsWith('tshttps://')) {
    return true;
  }
  return false;
}

function buildUdpTargetFfmpegUrl(slotRow) {
  const params = [`pkt_size=1316`, `ttl=${Math.max(1, Number(slotRow.ttl) || 16)}`, `buffer_size=1048576`];
  const bindIp = resolveEffectiveBindIp(slotRow);
  if (bindIp) {
    params.push(`localaddr=${encodeURIComponent(bindIp)}`);
  }
  return `udp://${slotRow.udp_host}:${slotRow.udp_port}?${params.join('&')}`;
}

function buildFfmpegUdpOutputArgs(slotRow, inputSpec) {
  const mode = slotRow.output_mode || 'direct_spts';
  const serviceId = Math.max(1, Number(slotRow.service_id) || Number(slotRow.catv_ch) || 1);
  const muxrate = Number(slotRow.muxrate_kbps) > 0 ? Number(slotRow.muxrate_kbps) * 1000 : 0;
  const udpUrl = buildUdpTargetFfmpegUrl(slotRow);

  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];

  if (inputSpec === 'pipe:0') {
    args.push('-fflags', '+genpts+igndts+nobuffer', '-f', 'mpegts', '-i', 'pipe:0');
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
        '5'
      );
    }
    args.push('-fflags', '+genpts+igndts+nobuffer', '-i', inputSpec);
  }

  args.push('-map', '0:v:0', '-map', '0:a:0?');

  if (mode === 'ntsc_sd_wk2500') {
    // Universal WK2500 Analog Modulator Safe Profile: NTSC 720x480 @ 29.97fps H.264 Main + MP2 192k Leveled Audio
    args.push(
      '-vf',
      'yadif=0:-1:1,scale=720:480,fps=30000/1001,format=yuv420p',
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
      buildAudioLevelingFilter('standard'),
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
      buildAudioLevelingFilter('standard'),
      '-c:a',
      'mp2',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2'
    );
  } else if (mode === 'copy_aac_leveled') {
    args.push(
      '-c:v',
      'copy',
      '-af',
      buildAudioLevelingFilter('standard'),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
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
    '-max_muxing_queue_size',
    '1024',
    '-flush_packets',
    '1',
    '-f',
    'mpegts',
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
    attempt: 0
  };

  state.rateTimer = setInterval(() => {
    state.bitrateKbps = Math.round((state.bytesWindow * 8) / 2000);
    state.bytesWindow = 0;
  }, 2000);
  state.rateTimer.unref?.();

  udpWorkers.set(ch, state);

  const scheduleRetry = (errMsg = '') => {
    if (state.stopped || udpWorkers.get(ch) !== state) return;
    state.status = 'reconnecting';
    if (errMsg) state.lastError = String(errMsg).slice(0, 140);
    state.attempt += 1;
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

    const packetizer = new Ts1316Packetizer((pkt1316) => {
      if (state.stopped) return;
      socket.send(pkt1316, Number(freshSlot.udp_port), freshSlot.udp_host, (err) => {
        if (!err) {
          state.packetsSent += 1;
          state.bytesWindow += pkt1316.length;
          if (state.status !== 'streaming') state.status = 'streaming';
        }
      });
    });

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

  const runFfmpegUdpCycle = async (freshSlot, candidateUrl, localHlsPath) => {
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
    const args = buildFfmpegUdpOutputArgs(freshSlot, inputForFfmpeg);

    const child = spawn(bin, args, {
      stdio: [isMnf ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      detached: false,
      env
    });
    state.child = child;
    state.status = 'streaming';
    state.bitrateKbps = freshSlot.output_mode === 'ntsc_sd_wk2500' ? 2000 : 2600;

    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-220);
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
            state.bytesWindow += tsBuf.length;
            state.packetsSent += Math.ceil(tsBuf.length / 1316);
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
        await runFfmpegUdpCycle(freshSlot, chosenUrl, freshUp.localHls);
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
  const units = db.prepare('SELECT * FROM wk2500_units ORDER BY ch_start ASC, id ASC').all();
  const interfaces = listHostIpv4Interfaces();
  const unconfiguredNics = listUnconfiguredPhysicalNics();
  const dedicatedNic = getDedicatedWk2500NicConfig();

  let activeStreamingCount = 0;
  let totalMbps = 0;
  const streamToCatvMap = new Map();

  const enrichedSlots = slots.map((row) => {
    const info = getCatvStdChannelInfo(row.catv_ch);
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

    if (row.stream_id && !streamToCatvMap.has(Number(row.stream_id))) {
      streamToCatvMap.set(Number(row.stream_id), {
        catv_ch: row.catv_ch,
        freq_mhz: info.freq_mhz,
        udp_host: row.udp_host,
        udp_port: row.udp_port,
        enabled: Boolean(row.enabled),
        live_status: liveStatus,
        bitrate_kbps: bitrateKbps
      });
    }

    return {
      ...row,
      enabled: Boolean(row.enabled),
      audio_mhz: info.audio_mhz,
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
      last_error: w?.lastError || ''
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

  res.json({
    ok: true,
    summary: {
      total_catv_slots: 124,
      assigned_slots: enrichedSlots.filter((s) => s.stream_id || s.custom_source_url).length,
      enabled_slots: enrichedSlots.filter((s) => s.enabled).length,
      streaming_slots: activeStreamingCount,
      total_udp_mbps: Number(totalMbps.toFixed(2))
    },
    dedicated_nic: dedicatedNic,
    interfaces,
    unconfigured_nics: unconfiguredNics,
    trunks,
    units,
    streams: enrichedStreams,
    slots: enrichedSlots
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
        const addr = computeDefaultUdpAddress(ch, ip_mode, dest_ip, base_port);
        const mappedSid =
          auto_assign_panel_streams && streamIdx < panelStreams.length ? panelStreams[streamIdx++].id : null;
        upd.run(
          addr.udp_host,
          addr.udp_port,
          String(local_interface_ip || '').trim(),
          Math.max(1, Number(ttl) || 16),
          String(output_mode || 'direct_spts'),
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

  withSqliteBusyRetry(() => {
    db.prepare(
      `UPDATE wk2500_channels
       SET stream_id = ?, custom_name = ?, custom_source_url = ?,
           udp_host = ?, udp_port = ?, local_interface_ip = ?,
           output_mode = ?, muxrate_kbps = ?, enabled = ?, updated_at = datetime('now')
       WHERE catv_ch = ?`
    ).run(nextStreamId, nextCustomName, nextCustomUrl, nextHost, nextPort, nextIfIp, nextMode, nextMux, nextEnabled, ch);
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

  const upd = db.prepare("UPDATE wk2500_channels SET enabled = 1, updated_at = datetime('now') WHERE catv_ch = ?");
  withSqliteBusyRetry(() => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of assigned) upd.run(row.catv_ch);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
  });

  assigned.forEach((row, idx) => {
    setTimeout(() => {
      startWk2500ChannelWorker(row.catv_ch);
    }, idx * 55).unref?.();
  });

  res.json({ ok: true, startedCount: assigned.length });
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

  if (format === 'm3u') {
    const out = ['#EXTM3U'];
    for (const r of rows) {
      const title = r.custom_name || r.stream_name || `CATV CH ${r.catv_ch}`;
      const info = getCatvStdChannelInfo(r.catv_ch);
      out.push(
        `#EXTINF:-1 tvg-chno="${r.catv_ch}" group-title="${info.band_label}",CH ${r.catv_ch} (${info.freq_mhz} MHz) - ${title}`
      );
      out.push(`udp://@${r.udp_host}:${r.udp_port}`);
    }
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wk2500_udp_2_al_125.m3u"');
    return res.send(out.join('\n') + '\n');
  }

  const csv = [
    'Canal_CATV,Frecuencia_Video_MHz_NTSC_STD,Portadora_Audio_MHz,Banda_CATV,Nombre_Canal,IP_Destino_UDP,Puerto_UDP,Program_Service_ID,Modo_Salida,Activo_24_7'
  ];
  for (const r of rows) {
    const info = getCatvStdChannelInfo(r.catv_ch);
    const title = String(r.custom_name || r.stream_name || '').replace(/"/g, '""');
    csv.push(
      `${r.catv_ch},${info.freq_mhz},${info.audio_mhz},"${info.band_label}","${title}",${r.udp_host},${r.udp_port},${r.service_id},${r.output_mode},${r.enabled ? 'SI' : 'NO'}`
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wk2500_plan_canales_2_al_125.csv"');
  res.send(csv.join('\n') + '\n');
});
