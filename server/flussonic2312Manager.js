import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';
import { stopWorker, scheduleDbStreamLaunches } from './streamEngine.js';
import {
  extractAstraPlayKey,
  classifyAstraCategoryByName,
  parseAstraContent,
  rewriteAstraLogoToCloudBridge
} from './headendManager.js';
import { parseFlussonicConf } from './flussonicImporter.js';

export const flussonic2312Router = express.Router();

// Ephemeral in-memory store for 1-line SSH local push scripts (for NATed local Flussonic servers)
const localPushJobs = new Map();

function normalizeBaseUrl(raw = '') {
  let clean = String(raw || '').trim();
  if (!clean) return '';
  // Remove hash fragments or pasted web UI / API suffixes (e.g. http://ip:8080/admin/#/streams)
  clean = clean.replace(/#.*$/, '').trim();
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
  try {
    const u = new URL(clean);
    u.pathname = u.pathname
      .replace(/\/+(admin|streamer\/api\/v3.*|flussonic\/api.*)\/?$/i, '')
      .replace(/\/+$/, '');
    u.search = '';
    u.hash = '';
    // Strip embedded credentials from base URL string so Node undici fetch() never throws TypeError
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return clean.replace(/\/+$/, '');
  }
}

function extractEmbeddedCredentials(raw = '') {
  let clean = String(raw || '').trim();
  if (!clean) return { username: '', password: '' };
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
  try {
    const u = new URL(clean);
    return {
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || '')
    };
  } catch {
    return { username: '', password: '' };
  }
}

export function buildFlussonicClusterAuthHeader(clusterKey = '') {
  const key = String(clusterKey || '').trim();
  const unixSec = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha1').update(`${unixSec}:${key}`).digest('hex');
  return `Cluster ${unixSec}:${sig}`;
}

export function buildFlussonicCandidateAuthHeaders(srv = {}) {
  const embedded = extractEmbeddedCredentials(srv.raw_url || srv.base_url || '');
  const username = String(srv.username || embedded.username || '').trim();
  const password = String(srv.password !== undefined && srv.password !== '' ? srv.password : embedded.password || '');
  const apiToken = String(srv.api_token || '').trim();

  const candidates = [];
  const pushUnique = (authVal) => {
    if (!candidates.includes(authVal)) candidates.push(authVal);
  };

  if (username && password) {
    const b64 = Buffer.from(`${username}:${password}`).toString('base64');
    pushUnique(`Basic ${b64}`);
    // Also fallback to Bearer / Cluster in case user left default "admin" while pasting api_token or cluster_key
    pushUnique(`Bearer ${password}`);
    pushUnique(buildFlussonicClusterAuthHeader(password));
  }
  if (apiToken) {
    pushUnique(`Bearer ${apiToken}`);
    pushUnique(buildFlussonicClusterAuthHeader(apiToken));
    if (!username) {
      pushUnique(`Basic ${Buffer.from(`admin:${apiToken}`).toString('base64')}`);
    }
  }
  if (password && !username) {
    // User typed password/key without username: test Basic admin:pass, Bearer, and Cluster key
    pushUnique(`Basic ${Buffer.from(`admin:${password}`).toString('base64')}`);
    pushUnique(`Bearer ${password}`);
    pushUnique(buildFlussonicClusterAuthHeader(password));
  }
  if (username && !password) {
    // Sometimes cluster_key or bearer token is pasted in username or URL http://KEY@host
    pushUnique(`Bearer ${username}`);
    pushUnique(buildFlussonicClusterAuthHeader(username));
    pushUnique(`Basic ${Buffer.from(`${username}:`).toString('base64')}`);
  }
  pushUnique('');

  return candidates.map((auth) => {
    const h = {
      Accept: 'application/json',
      'User-Agent': 'TVLister-Flussonic2312/1.1'
    };
    if (auth) h.Authorization = auth;
    return h;
  });
}

function buildFlussonicAuthHeaders(srv = {}) {
  return buildFlussonicCandidateAuthHeaders(srv)[0];
}

function isPrivateLanUrl(urlStr = '') {
  try {
    const u = new URL(normalizeBaseUrl(urlStr));
    const h = u.hostname.toLowerCase();
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
    const m172 = h.match(/^172\.(\d+)\./);
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

function getHeadendBridgeNodes() {
  try {
    return db
      .prepare("SELECT id, name, public_url, api_token, last_heartbeat_at FROM headend_nodes WHERE public_url != '' ORDER BY id ASC")
      .all();
  } catch {
    return [];
  }
}

function sanitizeFlussonicStreamKey(rawKey = '', fallbackIdx = 1) {
  const s = String(rawKey || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '_')
    .replace(/^[_/]+|[_/]+$/g, '');
  return s || `ch_${fallbackIdx}`;
}

export function convertAstraHttpToTshttp(urlStr = '', overrideHost = '') {
  const raw = String(urlStr || '').trim();
  if (!raw) return '';
  if (/^(tshttp|tshttps|udp|rtp|rtmp|rtsp|srt|hls|hlss|m4f|m4fs):\/\//i.test(raw)) {
    if (!overrideHost) return raw;
  }

  try {
    const normalized = raw.replace(/^ts(https?:\/\/)/i, '$1');
    const u = new URL(normalized);
    if (overrideHost && String(overrideHost).trim()) {
      const cleanHost = String(overrideHost).trim();
      const parsedNew = new URL(/^https?:\/\//i.test(cleanHost) ? cleanHost : `http://${cleanHost}`);
      if (parsedNew.port) {
        u.host = parsedNew.host;
      } else {
        u.hostname = parsedNew.hostname;
      }
    }
    const isHls = /\.m3u8(\?|$)/i.test(u.pathname);
    if (isHls) {
      return u.toString().replace(/^http:\/\//i, 'hls://').replace(/^https:\/\//i, 'hlss://');
    }
    return u.toString().replace(/^http:\/\//i, 'tshttp://').replace(/^https:\/\//i, 'tshttps://');
  } catch {
    return raw;
  }
}

export function buildFlussonicPullUrl(srv, streamName, protocol = 'mpegts') {
  const base = normalizeBaseUrl(srv?.base_url || srv || '');
  if (!base) return '';
  const u = new URL(base);
  if (srv?.username && String(srv.username).trim() && !u.username && protocol === 'mpegts_auth') {
    u.username = String(srv.username).trim();
    u.password = String(srv.password || '');
  }
  const cleanRoot = u.toString().replace(/\/+$/, '');
  const safeName = String(streamName || '').replace(/^\/+/, '');
  if (protocol === 'm4f_scheme') {
    const m4fProto = u.protocol === 'https:' ? 'm4fs' : 'm4f';
    return `${m4fProto}://${u.host}/${safeName}`;
  }
  if (protocol === 'cmaf' || protocol === 'm4f') {
    return `${cleanRoot}/${safeName}/index.fmp4.m3u8`;
  }
  if (protocol === 'hls') {
    return `${cleanRoot}/${safeName}/index.m3u8`;
  }
  // Default 24/7 constant low-latency HTTP MPEG-TS output on Flussonic 23.12: /<name>/mpegts
  return `${cleanRoot}/${safeName}/mpegts`;
}

export function getTrueAstraCandidateUrl(row = {}) {
  const orig = String(row.original_source_url || '').trim();
  const astraLocal = String(row.astra_local_url || '').trim();
  const cur = String(row.source_url || '').trim();
  if (orig && !orig.includes('/headend/live/')) return orig;
  if (cur && !cur.includes('/headend/live/')) return cur;
  return astraLocal || orig || cur;
}

export function rewriteHttpHostPreservingPort(urlStr = '', targetHost = '') {
  const raw = String(urlStr || '').trim();
  const cleanTarget = String(targetHost || '').trim();
  if (!raw || !cleanTarget) return raw;
  try {
    const u = new URL(raw.replace(/^ts(https?:\/\/)/i, '$1'));
    const parsedNew = new URL(/^https?:\/\//i.test(cleanTarget) ? cleanTarget : `http://${cleanTarget}`);
    if (parsedNew.port) {
      u.host = parsedNew.host;
    } else {
      u.hostname = parsedNew.hostname;
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function matchesStreamHostFilter(row, filterHost = '') {
  const wanted = String(filterHost || '').trim().toLowerCase();
  if (!wanted || wanted === 'all') return true;

  // Normalize in case user pasted full http://IP:8000/...
  let cleanWantedHost = wanted;
  let cleanWantedPort = '';
  try {
    if (wanted.includes('://') || wanted.includes('/')) {
      const wu = new URL(/^https?:\/\//i.test(wanted) ? wanted : `http://${wanted}`);
      cleanWantedHost = wu.hostname.toLowerCase();
      cleanWantedPort = wu.port || '';
    } else if (wanted.includes(':')) {
      const [hPart, pPart] = wanted.split(':');
      cleanWantedHost = hPart.toLowerCase();
      cleanWantedPort = pPart || '';
    }
  } catch {
    // fallback string match
  }

  const candidateUrls = [row.original_source_url, row.source_url, row.astra_local_url]
    .map((x) => String(x || '').trim())
    .filter((x) => x && !x.includes('/headend/live/'));

  for (const uStr of candidateUrls) {
    try {
      const u = new URL(uStr.replace(/^ts(https?:\/\/)/i, '$1'));
      const h = u.hostname.toLowerCase();
      if (h === cleanWantedHost) {
        if (!cleanWantedPort || (u.port || '80') === cleanWantedPort) return true;
      }
    } catch {
      if (uStr.toLowerCase().includes(cleanWantedHost)) return true;
    }
  }
  return false;
}

export function assignUniqueFlussonicKeys(rows = []) {
  const used = new Set();
  return rows.map((ch, idx) => {
    const originUrl = ch.astra_local_url || getTrueAstraCandidateUrl(ch) || ch.inputUrl || '';
    const baseKey = sanitizeFlussonicStreamKey(
      ch.flussonic_stream_name || ch.flussonic_name || extractAstraPlayKey(originUrl) || ch.name,
      ch.id || idx + 1
    );
    let finalKey = baseKey;
    if (used.has(finalKey)) {
      finalKey = `${baseKey}_${ch.id || idx + 1}`;
    }
    used.add(finalKey);
    return {
      ...ch,
      flussonic_name: finalKey,
      resolved_origin_url: originUrl
    };
  });
}

export function generateFlussonic2312Config({
  channels = [],
  transcodeMode = 'copy_deint_aac',
  videoBitrateKbps = 2500,
  audioBitrateKbps = 128,
  constant247 = true,
  includeGlobalHeader = false,
  httpPort = 8080,
  editAuthUser = 'admin',
  editAuthPass = 'admin',
  astraOverrideHost = ''
} = {}) {
  const lines = [
    '# ============================================================================',
    '# Flussonic Media Server v23.12 — Configuración Generada por Panel TVLister 24/7',
    `# Modo: ${constant247 ? '24/7 CONSTANTE (stream estático)' : 'On-Demand (ondemand)'} | Perfil: ${transcodeMode}`,
    `# Total Canales: ${channels.length}`,
    '# Archivo destino en servidor Flussonic: /etc/flussonic/flussonic.conf',
    '# Recarga en caliente sin cortar clientes: service flussonic reload',
    '# ============================================================================',
    ''
  ];

  if (includeGlobalHeader) {
    lines.push(`http ${Number(httpPort) || 8080};`);
    lines.push('pulsedb /var/lib/flussonic;');
    lines.push('session_log /var/lib/flussonic;');
    if (editAuthUser && editAuthPass) {
      lines.push(`edit_auth ${editAuthUser} ${editAuthPass};`);
    }
    lines.push('');
  }

  const directive = constant247 ? 'stream' : 'ondemand';
  const keyedChannels = assignUniqueFlussonicKeys(channels);

  keyedChannels.forEach((ch) => {
    const rawUrl = ch.resolved_origin_url || getTrueAstraCandidateUrl(ch) || ch.inputUrl || '';
    const key = ch.flussonic_name;
    const flussInput = convertAstraHttpToTshttp(rawUrl, astraOverrideHost);
    const safeTitle = String(ch.name || key).replace(/"/g, "'").trim();
    const vb = Number(ch.bitrate_kbps) || Number(videoBitrateKbps) || 2500;
    const ab = Number(audioBitrateKbps) || 128;

    lines.push(`${directive} ${key} {`);
    lines.push(`  title "${safeTitle}";`);
    lines.push(`  input ${flussInput};`);

    if (transcodeMode === 'copy_video_aac') {
      lines.push(`  transcoder vb=copy ab=${ab}k acodec=aac ar=48000 ac=2;`);
    } else if (transcodeMode === 'copy_deint_aac') {
      // Flussonic 23.12 CPU x264 + YADIF deinterlace + AAC stereo 48kHz
      lines.push(
        `  transcoder vb=${vb}k preset=veryfast deinterlace=true ab=${ab}k acodec=aac ar=48000 ac=2;`
      );
    } else if (transcodeMode === 'nvenc_deint_aac') {
      lines.push(
        `  transcoder hw=nvenc vb=${vb}k deinterlace=true ab=${ab}k acodec=aac ar=48000 ac=2;`
      );
    } else if (transcodeMode === 'qsv_deint_aac') {
      lines.push(
        `  transcoder hw=qsv vb=${vb}k deinterlace=true ab=${ab}k acodec=aac ar=48000 ac=2;`
      );
    }
    // 'copy_pure' emits no transcoder line (0% CPU pure MPEG-TS/HLS passthrough in Flussonic 23.12)

    lines.push('}');
    lines.push('');
  });

  return lines.join('\n');
}

export function buildFlussonic2312ApiStreamPayload(ch, idx, options = {}) {
  const {
    transcodeMode = 'copy_pure',
    videoBitrateKbps = 2500,
    audioBitrateKbps = 128,
    constant247 = true,
    astraOverrideHost = ''
  } = options;

  const rawUrl = ch.resolved_origin_url || getTrueAstraCandidateUrl(ch) || ch.inputUrl || '';
  const name = sanitizeFlussonicStreamKey(
    ch.flussonic_name || extractAstraPlayKey(rawUrl) || ch.name,
    ch.id || idx + 1
  );
  const inputUrl = convertAstraHttpToTshttp(rawUrl, astraOverrideHost);
  const vb = (Number(ch.bitrate_kbps) || Number(videoBitrateKbps) || 2500) * 1000;
  const ab = (Number(audioBitrateKbps) || 128) * 1000;

  // Strict Flussonic 23.12 OpenAPI v3 StreamConfig schema:
  const payload = {
    name,
    title: String(ch.name || name).trim(),
    static: Boolean(constant247),
    inputs: [{ url: inputUrl }]
  };

  if (transcodeMode === 'copy_video_aac') {
    // Video passthrough (omit video[]), transcode audio only to AAC 48kHz stereo (channels: 2 integer)
    payload.transcoder = {
      audio: {
        bitrate: ab,
        codec: 'aac',
        sample_rate: 48000,
        channels: 2
      }
    };
  } else if (
    transcodeMode === 'copy_deint_aac' ||
    transcodeMode === 'nvenc_deint_aac' ||
    transcodeMode === 'qsv_deint_aac'
  ) {
    // Flussonic 23.12 TranscoderDevice enum: 'cpu' | 'nvenc' | 'coder'
    // Deinterlacing belongs in transcoder.decoder.deinterlace (boolean), track: 1 is required in video[], channels: 2 integer in audio
    const hw = transcodeMode === 'nvenc_deint_aac' ? 'nvenc' : 'cpu';
    payload.transcoder = {
      global: { hw },
      decoder: { deinterlace: true },
      video: [
        {
          track: 1,
          bitrate: vb,
          codec: 'h264',
          preset: 'veryfast'
        }
      ],
      audio: {
        bitrate: ab,
        codec: 'aac',
        sample_rate: 48000,
        channels: 2
      }
    };
  }

  return { name, payload };
}

function formatFlussonicApiError(resp = {}) {
  const j = resp.json;
  if (j) {
    if (Array.isArray(j.errors) && j.errors.length > 0) {
      return j.errors
        .slice(0, 2)
        .map((e) => [e.source || e.field, e.title || e.detail || e.code].filter(Boolean).join(': '))
        .join(' | ');
    }
    if (typeof j.error === 'string' && j.error) return j.error;
    if (typeof j.message === 'string' && j.message) return j.message;
    if (typeof j.description === 'string' && j.description) return j.description;
  }
  const cleanTxt = String(resp.text || '').replace(/\s+/g, ' ').trim();
  return cleanTxt ? cleanTxt.slice(0, 140) : `HTTP ${resp.status || 'sin respuesta'}`;
}

async function fetchDirectJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ac.signal });
    const serverHeader = resp.headers.get('server') || '';
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: resp.ok, status: resp.status, serverHeader, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaHeadendBridge(bridgeNode, url, options = {}, timeoutMs = 8000) {
  const nodeBase = String(bridgeNode.public_url || '').replace(/\/+$/, '');
  const proxyUrl = `${nodeBase}/headend/proxy-flussonic`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs + 2500);
  try {
    const resp = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-headend-token': String(bridgeNode.api_token || '')
      },
      body: JSON.stringify({
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body ?? null,
        timeoutMs
      }),
      signal: ac.signal
    });
    if (!resp.ok) {
      throw new Error(`Puente LAN ProLiant HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data || data.status === 0) {
      throw new Error(data?.text || 'No alcanzable desde Nodo Cabecera LAN');
    }
    let json = null;
    try {
      json = JSON.parse(data.text || '');
    } catch {
      json = null;
    }
    return {
      ok: Boolean(data.ok),
      status: Number(data.status || 0),
      serverHeader: String(data.serverHeader || ''),
      json,
      text: String(data.text || '')
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000, bridgeNode = null) {
  if (bridgeNode) {
    return fetchViaHeadendBridge(bridgeNode, url, options, timeoutMs);
  }
  return fetchDirectJsonWithTimeout(url, options, timeoutMs);
}

// Fast Pre-Flight Connection + Auth + Port + Optional LAN Bridge Negotiator for Flussonic 23.12
export async function negotiateFlussonic2312Connection(srvInput = {}) {
  const rawBase = String(srvInput.raw_url || srvInput.base_url || '').trim();
  const base = normalizeBaseUrl(rawBase);
  if (!base) {
    throw new Error('Debes indicar la URL o IP:Puerto de tu servidor Flussonic 23.12 (ej. http://IP_FLUSSONIC:8080).');
  }

  // Candidate bases: exact user base, plus :8080 fallback if user omitted port (Flussonic default is :80 or :8080)
  const candidateBases = [base];
  try {
    const u = new URL(base);
    if (!u.port && u.protocol === 'http:') {
      candidateBases.push(`http://${u.hostname}:8080`);
    }
  } catch {
    // ignore
  }

  const candidateHeaders = buildFlussonicCandidateAuthHeaders({ ...srvInput, raw_url: rawBase });
  const isPrivate = isPrivateLanUrl(base);
  const directTimeout = isPrivate ? 2800 : 5000;

  let sawAuthFailure = false;
  let lastStatus = 0;
  let lastErrDetail = '';

  const attemptProbeOn = async (targetBase, bridgeNode = null, timeoutMs = directTimeout) => {
    for (let i = 0; i < candidateHeaders.length; i++) {
      // Refresh Cluster timestamp if header uses Cluster signature
      const hdrs = { ...candidateHeaders[i] };
      if (hdrs.Authorization && hdrs.Authorization.startsWith('Cluster ')) {
        const secret = String(srvInput.api_token || srvInput.password || srvInput.username || '').trim();
        hdrs.Authorization = buildFlussonicClusterAuthHeader(secret);
      }

      try {
        const res = await fetchJsonWithTimeout(
          `${targetBase}/streamer/api/v3/streams?limit=1`,
          { headers: hdrs },
          timeoutMs,
          bridgeNode
        );
        if (res.ok && res.json) {
          let detectedVersion = srvInput.version || '23.12';
          const verMatch = String(res.serverHeader || '').match(/Flussonic[/\s]+([0-9.]+)/i);
          if (verMatch) detectedVersion = verMatch[1];
          return {
            ok: true,
            effectiveBase: targetBase,
            headers: hdrs,
            bridgeNode,
            version: detectedVersion
          };
        }
        if (res.status === 401 || res.status === 403) {
          sawAuthFailure = true;
          lastStatus = res.status;
          continue; // Try next auth scheme (Basic -> Bearer -> Cluster)
        }
        lastStatus = res.status;
        lastErrDetail = formatFlussonicApiError(res);
        // Non-auth HTTP error on this base (e.g. 404 wrong port/service): stop trying more auth headers on same base
        break;
      } catch (err) {
        lastErrDetail = err.name === 'AbortError' ? 'Tiempo de espera agotado (timeout)' : err.message;
        break; // Network error on this base/transport: move to next base or LAN bridge
      }
    }
    return null;
  };

  for (const candBase of candidateBases) {
    const directHit = await attemptProbeOn(candBase, null, directTimeout);
    if (directHit) return directHit;
  }

  // If private LAN IP (192.168.x.x / 10.x.x.x) failed directly from Cloud, try bridging via ProLiant Headend Node!
  if (isPrivate && !sawAuthFailure) {
    const bridgeNodes = getHeadendBridgeNodes();
    for (const bNode of bridgeNodes) {
      for (const candBase of candidateBases) {
        const bridgedHit = await attemptProbeOn(candBase, bNode, 5500);
        if (bridgedHit) return bridgedHit;
      }
    }
  }

  if (sawAuthFailure) {
    throw new Error(
      `Flussonic 23.12 rechazó las credenciales en ${base} (HTTP ${lastStatus || 401}). Verifica usuario/contraseña de "edit_auth" (o cluster_key) en /etc/flussonic/flussonic.conf.`
    );
  }

  if (isPrivate) {
    throw new Error(
      `No se puede llegar desde este Panel Nube a la IP privada local ${base} (${lastErrDetail || 'red LAN detrás de NAT'}). Coloca la IP Pública:Puerto de tu Flussonic (ej. puerto 8080/80 abierto en tu MikroTik) o usa el botón "Comando SSH Local (1 Línea)" abajo para inyectar los canales directo desde la consola de tu Flussonic.`
    );
  }

  throw new Error(
    `No se pudo conectar a Flussonic API v3 en ${base}/streamer/api/v3/streams (${
      lastStatus ? `HTTP ${lastStatus}: ${lastErrDetail}` : lastErrDetail || 'conexión rechazada / timeout'
    }). Verifica IP Pública, puerto HTTP de Flussonic (:80 o :8080) y firewall.`
  );
}

export async function pushBatchStreamsToFlussonic2312(srvInput, channels = [], options = {}) {
  const conn = await negotiateFlussonic2312Connection(srvInput);
  const base = conn.effectiveBase;
  const baseHeaders = {
    ...conn.headers,
    'Content-Type': 'application/json'
  };

  let pushedCount = 0;
  let passthroughFallbackCount = 0;
  const errors = [];
  const BATCH_SIZE = 8;

  for (let offset = 0; offset < channels.length; offset += BATCH_SIZE) {
    const slice = channels.slice(offset, offset + BATCH_SIZE);
    await Promise.all(
      slice.map(async (ch, relIdx) => {
        const idx = offset + relIdx;
        const { name, payload } = buildFlussonic2312ApiStreamPayload(ch, idx, options);
        const encName = name
          .split('/')
          .map((p) => encodeURIComponent(p))
          .join('/');

        // Refresh Cluster auth signature if needed
        const reqHeaders = { ...baseHeaders };
        if (reqHeaders.Authorization && reqHeaders.Authorization.startsWith('Cluster ')) {
          const secret = String(srvInput.api_token || srvInput.password || srvInput.username || '').trim();
          reqHeaders.Authorization = buildFlussonicClusterAuthHeader(secret);
        }

        try {
          let r = await fetchJsonWithTimeout(
            `${base}/streamer/api/v3/streams/${encName}`,
            {
              method: 'PUT',
              headers: reqHeaders,
              body: JSON.stringify(payload)
            },
            8000,
            conn.bridgeNode
          );

          // Automatic fallback if flussonic-transcoder package/license is absent on this Flussonic 23.12 host
          if (!r.ok && payload.transcoder && (r.status === 400 || r.status === 422)) {
            const cleanPayload = {
              name: payload.name,
              title: payload.title,
              static: payload.static,
              inputs: payload.inputs
            };
            const retryRes = await fetchJsonWithTimeout(
              `${base}/streamer/api/v3/streams/${encName}`,
              {
                method: 'PUT',
                headers: reqHeaders,
                body: JSON.stringify(cleanPayload)
              },
              8000,
              conn.bridgeNode
            );
            if (retryRes.ok) {
              pushedCount++;
              passthroughFallbackCount++;
              return;
            }
          }

          if (r.ok) {
            pushedCount++;
          } else {
            errors.push(`${name}: HTTP ${r.status} (${formatFlussonicApiError(r)})`);
          }
        } catch (err) {
          errors.push(`${name}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        }
      })
    );
  }

  return {
    ok: pushedCount > 0,
    pushedCount,
    passthroughFallbackCount,
    totalAttempted: channels.length,
    effectiveBase: base,
    usedLanBridge: Boolean(conn.bridgeNode),
    bridgeNodeName: conn.bridgeNode?.name || '',
    version: conn.version || '23.12',
    errors
  };
}

async function probeFlussonic2312Live(srv) {
  const conn = await negotiateFlussonic2312Connection(srv);
  const base = conn.effectiveBase;
  const headers = { ...conn.headers };
  if (headers.Authorization && headers.Authorization.startsWith('Cluster ')) {
    const secret = String(srv.api_token || srv.password || srv.username || '').trim();
    headers.Authorization = buildFlussonicClusterAuthHeader(secret);
  }

  const streamsRes = await fetchJsonWithTimeout(
    `${base}/streamer/api/v3/streams?limit=5000`,
    { headers },
    9500,
    conn.bridgeNode
  );

  if (!streamsRes.ok || !streamsRes.json) {
    throw new Error(
      `No se pudo consultar /streamer/api/v3/streams en ${base} (${formatFlussonicApiError(streamsRes)}).`
    );
  }

  const rawList = Array.isArray(streamsRes.json.streams)
    ? streamsRes.json.streams
    : Array.isArray(streamsRes.json)
    ? streamsRes.json
    : [];

  let detectedVersion = conn.version || srv.version || '23.12';
  const verMatch = String(streamsRes.serverHeader || '').match(/Flussonic[/\s]+([0-9.]+)/i);
  if (verMatch) detectedVersion = verMatch[1];

  // Optional server telemetry from /flussonic/api/server or /streamer/api/v3/config
  let cpuUsage = 0;
  let memUsage = 0;
  let uptimeSec = 0;
  try {
    const srvInfo = await fetchJsonWithTimeout(
      `${base}/flussonic/api/server`,
      { headers },
      4500,
      conn.bridgeNode
    );
    if (srvInfo.ok && srvInfo.json) {
      if (srvInfo.json.version) detectedVersion = String(srvInfo.json.version);
      cpuUsage = Number(srvInfo.json.cpu_usage || srvInfo.json.scheduler_load || 0);
      memUsage = Number(srvInfo.json.memory_usage || 0);
      uptimeSec = Number(srvInfo.json.uptime || 0);
    }
  } catch {
    // optional endpoint
  }

  let aliveCount = 0;
  let static247Count = 0;
  let totalBitrateKbps = 0;
  let totalClients = 0;

  const streams = rawList.map((item) => {
    const key = String(item.name || '').trim();
    const stats = item.stats || {};
    const alive = stats.alive !== false && stats.status !== 'error';
    const bitrateKbps = Math.round(Number(stats.bitrate || 0));
    const clients = Number(stats.client_count || 0);
    const isStatic = item.static !== false && !item.ondemand;

    if (alive) aliveCount++;
    if (isStatic) static247Count++;
    totalBitrateKbps += bitrateKbps;
    totalClients += clients;

    const tracks = Array.isArray(stats.media_info?.tracks) ? stats.media_info.tracks : [];
    const vTrack = tracks.find((t) => t.content === 'video') || null;
    const aTrack = tracks.find((t) => t.content === 'audio') || null;

    const firstInput =
      (Array.isArray(item.inputs) && item.inputs[0]?.url) || item.url || '';

    return {
      name: key,
      title: String(item.title || key).trim(),
      group: item.group || item.static_group || '',
      static: isStatic,
      alive,
      bitrate_kbps: bitrateKbps,
      clients,
      input_url: firstInput,
      has_transcoder: Boolean(item.transcoder),
      resolution: vTrack && vTrack.width && vTrack.height ? `${vTrack.width}x${vTrack.height}` : '',
      video_codec: vTrack?.codec || '',
      audio_codec: aTrack?.codec || '',
      pull_mpegts_url: buildFlussonicPullUrl(srv, key, 'mpegts'),
      pull_hls_url: buildFlussonicPullUrl(srv, key, 'hls')
    };
  });

  const telemetry = {
    version: detectedVersion,
    total_streams: streams.length,
    alive_streams: aliveCount,
    static_247_streams: static247Count,
    total_mbps: Number((totalBitrateKbps / 1000).toFixed(2)),
    total_clients: totalClients,
    cpu_usage: cpuUsage,
    memory_usage: memUsage,
    uptime_sec: uptimeSec
  };

  return { telemetry, streams };
}

function getCopyCopyProfileId() {
  const row = db
    .prepare(
      "SELECT id FROM transcode_profiles WHERE video_codec = 'copy' AND audio_codec = 'copy' ORDER BY id ASC LIMIT 1"
    )
    .get();
  return row ? row.id : 1;
}

function sanitizeServerRow(row) {
  if (!row) return null;
  let telemetry = {};
  try {
    telemetry = JSON.parse(row.telemetry_json || '{}');
  } catch {
    telemetry = {};
  }
  const linkedCount =
    db
      .prepare('SELECT COUNT(*) as c FROM streams WHERE flussonic_server_id = ?')
      .get(row.id)?.c || 0;
  return {
    ...row,
    telemetry,
    linked_streams_count: linkedCount
  };
}

function upsertFlussonicServerInline({
  server_id = null,
  name = '',
  base_url = '',
  username,
  password,
  api_token,
  astra_url = ''
} = {}) {
  const rawInputUrl = String(base_url || '').trim();
  const embedded = extractEmbeddedCredentials(rawInputUrl);
  const cleanBase = normalizeBaseUrl(rawInputUrl);

  let srv = server_id ? db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(server_id)) : null;
  if (!srv && cleanBase) {
    srv = db.prepare('SELECT * FROM flussonic_servers WHERE base_url = ? ORDER BY id ASC LIMIT 1').get(cleanBase);
  }

  const nextUser =
    username !== undefined && String(username).trim() !== ''
      ? String(username).trim()
      : embedded.username || srv?.username || '';
  const nextPass =
    password !== undefined && String(password) !== ''
      ? String(password)
      : embedded.password || srv?.password || '';
  const nextToken =
    api_token !== undefined && String(api_token).trim() !== ''
      ? String(api_token).trim()
      : srv?.api_token || '';
  const nextAstra = String(astra_url || srv?.astra_url || 'http://192.168.88.10:8000').trim();

  if (srv) {
    const finalBase = cleanBase || srv.base_url;
    db.prepare(
      `UPDATE flussonic_servers
       SET base_url = ?, username = ?, password = ?, api_token = ?, astra_url = ?
       WHERE id = ?`
    ).run(finalBase, nextUser, nextPass, nextToken, nextAstra, srv.id);
    return {
      ...db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(srv.id),
      raw_url: rawInputUrl || finalBase
    };
  }

  if (!cleanBase) return null;

  let hostLabel = cleanBase;
  try {
    hostLabel = new URL(cleanBase).host;
  } catch {
    // ignore
  }
  const info = db
    .prepare(
      `INSERT INTO flussonic_servers (
         name, base_url, username, password, api_token, version,
         astra_url, astra_auth, default_pull_protocol, default_transcode_mode
       ) VALUES (?, ?, ?, ?, ?, '23.12', ?, '', 'mpegts', 'copy_deint_aac')`
    )
    .run(
      String(name || `Flussonic 23.12 (${hostLabel})`).trim(),
      cleanBase,
      nextUser,
      nextPass,
      nextToken,
      nextAstra
    );
  return {
    ...db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(info.lastInsertRowid)),
    raw_url: rawInputUrl || cleanBase
  };
}

// ==================== CRUD SERVIDORES FLUSSONIC 23.12 ====================
flussonic2312Router.get('/api/flussonic-2312/servers', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM flussonic_servers ORDER BY id ASC').all().map(sanitizeServerRow);
  const totalPanelStreams = db.prepare('SELECT COUNT(*) as c FROM streams').get()?.c || 0;
  res.json({ servers: rows, totalPanelStreams });
});

flussonic2312Router.post('/api/flussonic-2312/servers', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const embedded = extractEmbeddedCredentials(b.base_url);
  const baseUrl = normalizeBaseUrl(b.base_url);
  if (!b.name || !baseUrl) {
    return res.status(400).json({ error: 'Nombre y URL/IP del servidor Flussonic 23.12 son obligatorios.' });
  }

  const info = db
    .prepare(
      `INSERT INTO flussonic_servers (
         name, base_url, username, password, api_token, version,
         astra_url, astra_auth, default_pull_protocol, default_transcode_mode
       ) VALUES (?, ?, ?, ?, ?, '23.12', ?, ?, ?, ?)`
    )
    .run(
      String(b.name).trim(),
      baseUrl,
      String(b.username || embedded.username || '').trim(),
      String(b.password || embedded.password || ''),
      String(b.api_token || '').trim(),
      String(b.astra_url || 'http://192.168.88.10:8000').trim(),
      String(b.astra_auth || '').trim(),
      String(b.default_pull_protocol || 'mpegts'),
      String(b.default_transcode_mode || 'copy_deint_aac')
    );

  const created = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json({ ok: true, server: sanitizeServerRow(created) });
});

flussonic2312Router.put('/api/flussonic-2312/servers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Servidor Flussonic no encontrado.' });

  const b = req.body || {};
  const embedded = extractEmbeddedCredentials(b.base_url || '');
  const baseUrl = b.base_url !== undefined ? normalizeBaseUrl(b.base_url) : existing.base_url;

  db.prepare(
    `UPDATE flussonic_servers
     SET name = ?, base_url = ?, username = ?, password = ?, api_token = ?,
         astra_url = ?, astra_auth = ?, default_pull_protocol = ?, default_transcode_mode = ?
     WHERE id = ?`
  ).run(
    b.name !== undefined ? String(b.name).trim() : existing.name,
    baseUrl,
    b.username !== undefined ? String(b.username).trim() : embedded.username || existing.username,
    b.password !== undefined ? String(b.password) : embedded.password || existing.password,
    b.api_token !== undefined ? String(b.api_token).trim() : existing.api_token,
    b.astra_url !== undefined ? String(b.astra_url).trim() : existing.astra_url,
    b.astra_auth !== undefined ? String(b.astra_auth).trim() : existing.astra_auth,
    b.default_pull_protocol !== undefined ? String(b.default_pull_protocol) : existing.default_pull_protocol,
    b.default_transcode_mode !== undefined ? String(b.default_transcode_mode) : existing.default_transcode_mode,
    id
  );

  const updated = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
  res.json({ ok: true, server: sanitizeServerRow(updated) });
});

flussonic2312Router.delete('/api/flussonic-2312/servers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(
    `UPDATE streams
     SET source_url = COALESCE(NULLIF(original_source_url, ''), source_url),
         flussonic_server_id = NULL,
         flussonic_stream_name = ''
     WHERE flussonic_server_id = ?`
  ).run(id);
  db.prepare('DELETE FROM flussonic_servers WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Test inline connection + credentials (Basic / Bearer / Cluster / LAN Bridge) and persist server record
flussonic2312Router.post('/api/flussonic-2312/test-connection', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const srv = upsertFlussonicServerInline({
    server_id: b.server_id,
    name: b.name,
    base_url: b.base_url,
    username: b.username,
    password: b.password,
    api_token: b.api_token,
    astra_url: b.astra_url
  });

  if (!srv) {
    return res.status(400).json({ error: 'Escribe primero la URL o IP:Puerto de tu Flussonic 23.12.' });
  }

  try {
    const conn = await negotiateFlussonic2312Connection(srv);
    if (conn.effectiveBase && conn.effectiveBase !== srv.base_url) {
      db.prepare('UPDATE flussonic_servers SET base_url = ? WHERE id = ?').run(conn.effectiveBase, srv.id);
      srv.base_url = conn.effectiveBase;
    }
    const { telemetry, streams } = await probeFlussonic2312Live(srv);
    db.prepare(
      `UPDATE flussonic_servers
       SET status = 'online',
           version = ?,
           last_sync_at = datetime('now'),
           telemetry_json = ?
       WHERE id = ?`
    ).run(telemetry.version || '23.12', JSON.stringify(telemetry), srv.id);

    const updated = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(srv.id);
    res.json({
      ok: true,
      server: sanitizeServerRow(updated),
      effectiveBase: conn.effectiveBase,
      version: telemetry.version || '23.12',
      streamCount: streams.length,
      usedLanBridge: Boolean(conn.bridgeNode),
      bridgeNodeName: conn.bridgeNode?.name || '',
      streams
    });
  } catch (err) {
    db.prepare("UPDATE flussonic_servers SET status = 'offline' WHERE id = ?").run(srv.id);
    res.status(400).json({ error: err.message });
  }
});

// ==================== SONDEO EN VIVO API v3 FLUSSONIC 23.12 ====================
flussonic2312Router.post('/api/flussonic-2312/servers/:id/sync-live', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const srv = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
  if (!srv) return res.status(404).json({ error: 'Servidor Flussonic no encontrado.' });

  try {
    const { telemetry, streams } = await probeFlussonic2312Live(srv);
    db.prepare(
      `UPDATE flussonic_servers
       SET status = 'online',
           version = ?,
           last_sync_at = datetime('now'),
           telemetry_json = ?
       WHERE id = ?`
    ).run(telemetry.version || '23.12', JSON.stringify(telemetry), id);

    const updated = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
    res.json({ ok: true, server: sanitizeServerRow(updated), streams });
  } catch (err) {
    db.prepare("UPDATE flussonic_servers SET status = 'offline' WHERE id = ?").run(id);
    res.status(400).json({ error: err.message || 'No se pudo conectar a Flussonic 23.12' });
  }
});

// Restart or Delete single stream on Flussonic 23.12 via REST API v3
flussonic2312Router.post(
  '/api/flussonic-2312/servers/:id/stream-action',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    const srv = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
    if (!srv) return res.status(404).json({ error: 'Servidor Flussonic no encontrado.' });

    const { stream_name, action } = req.body || {};
    if (!stream_name) return res.status(400).json({ error: 'stream_name requerido' });

    const encName = stream_name
      .split('/')
      .map((p) => encodeURIComponent(p))
      .join('/');

    try {
      const conn = await negotiateFlussonic2312Connection(srv);
      const base = conn.effectiveBase;
      const headers = { ...conn.headers };
      if (headers.Authorization && headers.Authorization.startsWith('Cluster ')) {
        const secret = String(srv.api_token || srv.password || srv.username || '').trim();
        headers.Authorization = buildFlussonicClusterAuthHeader(secret);
      }

      if (action === 'delete') {
        const r = await fetchJsonWithTimeout(
          `${base}/streamer/api/v3/streams/${encName}`,
          { method: 'DELETE', headers },
          8000,
          conn.bridgeNode
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${formatFlussonicApiError(r)}`);
        return res.json({ ok: true });
      }

      // Flussonic 23.12 OpenAPI v3 restarts static streams via POST /streamer/api/v3/streams/{name}/stop
      let r = await fetchJsonWithTimeout(
        `${base}/streamer/api/v3/streams/${encName}/stop`,
        { method: 'POST', headers },
        8000,
        conn.bridgeNode
      );
      if (!r.ok) {
        r = await fetchJsonWithTimeout(
          `${base}/streamer/api/v3/streams/${encName}/restart`,
          { method: 'POST', headers },
          8000,
          conn.bridgeNode
        );
      }
      if (!r.ok) {
        r = await fetchJsonWithTimeout(
          `${base}/flussonic/api/stream_restart/${encName}`,
          { headers },
          8000,
          conn.bridgeNode
        );
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${formatFlussonicApiError(r)}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

function selectFilteredPanelChannels({ filter_host = '', selected_stream_ids = [] } = {}) {
  const allRows = db
    .prepare(
      `SELECT s.*, c.name as category_name
       FROM streams s
       LEFT JOIN categories c ON c.id = s.category_id
       ORDER BY s.sort_order ASC, s.id ASC`
    )
    .all();

  const idSet =
    Array.isArray(selected_stream_ids) && selected_stream_ids.length > 0
      ? new Set(selected_stream_ids.map(Number).filter((n) => n > 0))
      : null;

  const filtered = allRows.filter((row) => {
    if (idSet && !idSet.has(row.id)) return false;
    return matchesStreamHostFilter(row, filter_host);
  });

  return {
    totalStreams: allRows.length,
    untouchedCount: allRows.length - filtered.length,
    channels: assignUniqueFlussonicKeys(filtered)
  };
}

// ==================== DETECTOR DE IPs DE ORIGEN EN TU LISTA ACTUAL ====================
flussonic2312Router.get('/api/flussonic-2312/panel-hosts-summary', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, source_url, original_source_url, astra_local_url, flussonic_server_id, flussonic_stream_name
       FROM streams
       ORDER BY sort_order ASC, id ASC`
    )
    .all();

  const hostMap = new Map();
  let alreadyOnFlussonicCount = 0;

  for (const r of rows) {
    if (r.flussonic_server_id || r.flussonic_stream_name) alreadyOnFlussonicCount++;
    const originUrl = getTrueAstraCandidateUrl(r);
    if (!originUrl) continue;
    try {
      const u = new URL(originUrl.replace(/^ts(https?:\/\/)/i, '$1'));
      const h = u.hostname.toLowerCase();
      if (!hostMap.has(h)) {
        hostMap.set(h, {
          hostname: h,
          ports: new Set(),
          count: 0,
          isAstraPattern: false,
          sampleName: r.name,
          sampleUrl: originUrl
        });
      }
      const entry = hostMap.get(h);
      entry.count++;
      if (u.port) entry.ports.add(u.port);
      if (/\/play\//i.test(u.pathname) || u.port === '8000') {
        entry.isAstraPattern = true;
      }
    } catch {
      // non-URL source
    }
  }

  const hosts = Array.from(hostMap.values())
    .map((x) => ({
      hostname: x.hostname,
      ports: Array.from(x.ports),
      count: x.count,
      isAstraPattern: x.isAstraPattern,
      sampleName: x.sampleName,
      sampleUrl: x.sampleUrl
    }))
    .sort((a, b) => Number(b.isAstraPattern) - Number(a.isAstraPattern) || b.count - a.count);

  res.json({
    totalStreams: rows.length,
    alreadyOnFlussonicCount,
    hosts
  });
});

// Vista previa exacta de canales filtrados por IP de Astra Pública (sin tocar otros canales)
flussonic2312Router.post('/api/flussonic-2312/preview-by-ip', requireAuth, (req, res) => {
  const {
    filter_host = '',
    local_astra_host = '192.168.88.10',
    server_id = null,
    flussonic_base_url = '',
    pull_protocol = 'mpegts'
  } = req.body || {};

  const srv = server_id ? db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(server_id)) : null;
  const effectiveBase = srv || normalizeBaseUrl(flussonic_base_url) || 'http://IP_FLUSSONIC:8080';

  const { totalStreams, untouchedCount, channels } = selectFilteredPanelChannels({ filter_host });

  const preview = channels.map((ch) => {
    const originUrl = ch.resolved_origin_url || getTrueAstraCandidateUrl(ch);
    return {
      id: ch.id,
      name: ch.name,
      category_name: ch.category_name || 'Sin Categoría',
      logo_url: ch.logo_url || '',
      current_url: ch.source_url,
      origin_astra_url: originUrl,
      flussonic_key: ch.flussonic_name,
      flussonic_local_input: convertAstraHttpToTshttp(originUrl, local_astra_host),
      new_panel_link: buildFlussonicPullUrl(effectiveBase, ch.flussonic_name, pull_protocol),
      already_migrated: Boolean(ch.flussonic_stream_name)
    };
  });

  res.json({
    ok: true,
    totalStreams,
    matchedCount: preview.length,
    untouchedCount,
    preview
  });
});

// Migración en sitio (SOLO actualiza links de los canales con la IP de Astra Pública; NO borra ni toca el resto de tu lista)
flussonic2312Router.post('/api/flussonic-2312/migrate-links-by-ip', requireAuth, requireAdmin, async (req, res) => {
  const {
    server_id = null,
    flussonic_base_url = '',
    username,
    password,
    api_token,
    filter_host = '',
    selected_stream_ids = [],
    local_astra_host = '192.168.88.10',
    pull_protocol = 'mpegts', // 'mpegts' | 'hls'
    cloud_mode = 'constant_copy_247', // 'constant_copy_247' | 'constant_copy_audio_247' | 'direct' | 'ondemand'
    also_push_to_flussonic = false,
    transcode_mode = 'copy_deint_aac',
    video_bitrate_kbps = 2500,
    audio_bitrate_kbps = 128,
    constant_247 = true,
    limit_count = 0
  } = req.body || {};

  if (!filter_host && (!Array.isArray(selected_stream_ids) || selected_stream_ids.length === 0)) {
    return res.status(400).json({
      error: 'Selecciona la IP del Astra Público (o marca canales) para no modificar toda tu lista.'
    });
  }

  let srv = upsertFlussonicServerInline({
    server_id,
    base_url: flussonic_base_url,
    username,
    password,
    api_token,
    astra_url: local_astra_host ? `http://${String(local_astra_host).replace(/^https?:\/\//i, '')}` : ''
  });
  const cleanOverrideBase = normalizeBaseUrl(flussonic_base_url);
  if (!srv && !cleanOverrideBase) {
    return res.status(400).json({
      error: 'Indica o selecciona la URL/IP de tu servidor Flussonic 23.12 para construir los nuevos links.'
    });
  }

  const effectiveTarget = cleanOverrideBase
    ? { ...(srv || {}), base_url: cleanOverrideBase, raw_url: flussonic_base_url }
    : srv;
  const selectedRes = selectFilteredPanelChannels({ filter_host, selected_stream_ids });
  let targetChannels = selectedRes.channels;

  if (Number(limit_count) > 0) {
    targetChannels = targetChannels.slice(0, Number(limit_count));
  }

  if (targetChannels.length === 0) {
    return res.status(400).json({ error: 'Ningún canal de tu lista coincide con esa IP de Astra.' });
  }

  let pushedToFlussonicCount = 0;
  let passthroughFallbackCount = 0;
  let pushErrors = [];

  if (also_push_to_flussonic) {
    try {
      const pushRes = await pushBatchStreamsToFlussonic2312(effectiveTarget, targetChannels, {
        transcodeMode: transcode_mode,
        videoBitrateKbps: video_bitrate_kbps,
        audioBitrateKbps: audio_bitrate_kbps,
        constant247: constant_247 !== false,
        astraOverrideHost: local_astra_host
      });
      pushedToFlussonicCount = pushRes.pushedCount;
      passthroughFallbackCount = pushRes.passthroughFallbackCount || 0;
      pushErrors = pushRes.errors || [];
      if (pushRes.effectiveBase && srv && pushRes.effectiveBase !== srv.base_url) {
        db.prepare('UPDATE flussonic_servers SET base_url = ? WHERE id = ?').run(pushRes.effectiveBase, srv.id);
        effectiveTarget.base_url = pushRes.effectiveBase;
      }
      if (pushedToFlussonicCount === 0) {
        return res.status(400).json({
          error: `Push API v3 no pudo crear canales en Flussonic (${pushErrors[0] || 'sin respuesta'}). Tus links actuales en el panel NO fueron modificados.`
        });
      }
    } catch (pushErr) {
      return res.status(400).json({
        error: `${pushErr.message} (Tus links actuales en el panel NO fueron modificados).`
      });
    }
  }

  const copyProfId = getCopyCopyProfileId();
  const isOndemand = cloud_mode === 'ondemand';
  const isDirect = cloud_mode === 'direct';
  const nextStreamMode = isOndemand ? 'ondemand' : isDirect ? 'direct' : 'transcode';
  const nextStatus = isOndemand ? 'ondemand_idle' : 'running';
  const nextAudioLvl = cloud_mode === 'constant_copy_audio_247' ? 'on' : 'off';

  const toLaunchIds = [];

  db.exec('BEGIN IMMEDIATE;');
  try {
    const updInPlace = db.prepare(
      `UPDATE streams
       SET original_source_url = CASE
             WHEN original_source_url != '' AND original_source_url NOT LIKE '%/headend/live/%' THEN original_source_url
             ELSE source_url
           END,
           backup_url = CASE WHEN backup_url = '' THEN source_url ELSE backup_url END,
           astra_local_url = ?,
           source_url = ?,
           headend_node_id = NULL,
           flussonic_server_id = ?,
           flussonic_stream_name = ?,
           stream_mode = ?,
           transcode_profile_id = ?,
           audio_leveling_mode = ?,
           status = CASE WHEN status = 'stopped' THEN 'stopped' ELSE ? END,
           pid = NULL
       WHERE id = ?`
    );

    for (const ch of targetChannels) {
      stopWorker(`stream_${ch.id}`);
      const originUrl = ch.resolved_origin_url || getTrueAstraCandidateUrl(ch);
      const localHttpAstra = rewriteHttpHostPreservingPort(originUrl, local_astra_host);
      const newLink = buildFlussonicPullUrl(effectiveTarget, ch.flussonic_name, pull_protocol);

      updInPlace.run(
        localHttpAstra,
        newLink,
        srv ? srv.id : null,
        ch.flussonic_name,
        nextStreamMode,
        copyProfId,
        nextAudioLvl,
        nextStatus,
        ch.id
      );

      if (nextStreamMode === 'transcode' && ch.status !== 'stopped') {
        toLaunchIds.push(ch.id);
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    return res.status(500).json({ error: err.message });
  }

  if (toLaunchIds.length > 0) {
    scheduleDbStreamLaunches(toLaunchIds, 60);
  }

  res.json({
    ok: true,
    server: srv ? sanitizeServerRow(db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(srv.id)) : null,
    updatedLinksCount: targetChannels.length,
    untouchedCount: selectedRes.totalStreams - targetChannels.length,
    pushedToFlussonicCount,
    passthroughFallbackCount,
    pushErrors: pushErrors.slice(0, 8)
  });
});

// Revertir canales migrados a Flussonic de regreso a su URL original de Astra Público (1 clic)
flussonic2312Router.post('/api/flussonic-2312/revert-links', requireAuth, requireAdmin, (req, res) => {
  const { ids = [], scope = 'all_flussonic' } = req.body || {};

  let rows = [];
  if (scope === 'selected' && Array.isArray(ids) && ids.length > 0) {
    const cleanIds = ids.map(Number).filter((n) => n > 0);
    const ph = cleanIds.map(() => '?').join(',');
    rows = db.prepare(`SELECT id, status, stream_mode FROM streams WHERE id IN (${ph})`).all(...cleanIds);
  } else {
    rows = db
      .prepare(
        "SELECT id, status, stream_mode FROM streams WHERE flussonic_stream_name != '' AND original_source_url != ''"
      )
      .all();
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'No hay canales con link de Flussonic respaldado para revertir.' });
  }

  const targetIds = rows.map((r) => r.id);
  const ph = targetIds.map(() => '?').join(',');

  for (const sid of targetIds) stopWorker(`stream_${sid}`);

  db.prepare(
    `UPDATE streams
     SET source_url = COALESCE(NULLIF(original_source_url, ''), source_url),
         flussonic_server_id = NULL,
         flussonic_stream_name = '',
         pid = NULL
     WHERE id IN (${ph})`
  ).run(...targetIds);

  const fresh = db
    .prepare(`SELECT id FROM streams WHERE id IN (${ph}) AND stream_mode = 'transcode' AND status = 'running'`)
    .all(...targetIds)
    .map((r) => r.id);
  if (fresh.length > 0) scheduleDbStreamLaunches(fresh, 60);

  res.json({ ok: true, revertedCount: targetIds.length });
});

// ==================== GENERADOR & PUSH FLUSSONIC.CONF v23.12 (CESBO ASTRA) ====================
flussonic2312Router.post('/api/flussonic-2312/generate-conf', requireAuth, requireAdmin, (req, res) => {
  const {
    source_type = 'panel_streams', // 'panel_streams' | 'astra_m3u'
    filter_host = '',
    selected_stream_ids = [],
    astra_content = '',
    astra_url = 'http://192.168.88.10:8000',
    astra_override_host = '',
    transcode_mode = 'copy_deint_aac',
    video_bitrate_kbps = 2500,
    audio_bitrate_kbps = 128,
    constant_247 = true,
    include_global_header = false,
    http_port = 8080,
    edit_auth_user = 'admin',
    edit_auth_pass = 'admin'
  } = req.body || {};

  let channels = [];
  if (source_type === 'astra_m3u') {
    channels = parseAstraContent(astra_content, astra_url);
  } else {
    channels = selectFilteredPanelChannels({ filter_host, selected_stream_ids }).channels;
  }

  if (channels.length === 0) {
    return res.status(400).json({
      error:
        source_type === 'astra_m3u'
          ? 'No se detectaron canales en el archivo/texto de Cesbo Astra.'
          : 'No hay canales en tu lista que coincidan con esa IP filtrada.'
    });
  }

  const confText = generateFlussonic2312Config({
    channels,
    transcodeMode: transcode_mode,
    videoBitrateKbps: video_bitrate_kbps,
    audioBitrateKbps: audio_bitrate_kbps,
    constant247: constant_247 !== false,
    includeGlobalHeader: Boolean(include_global_header),
    httpPort: http_port,
    editAuthUser: edit_auth_user,
    editAuthPass: edit_auth_pass,
    astraOverrideHost: astra_override_host
  });

  res.json({
    ok: true,
    channelCount: channels.length,
    confText
  });
});

async function executeFlussonicPushHandler(srv, body = {}, res) {
  const {
    source_type = 'panel_streams',
    filter_host = '',
    selected_stream_ids = [],
    astra_content = '',
    astra_override_host = '',
    transcode_mode = 'copy_pure',
    video_bitrate_kbps = 2500,
    audio_bitrate_kbps = 128,
    constant_247 = true
  } = body;

  const channels =
    source_type === 'astra_m3u'
      ? assignUniqueFlussonicKeys(parseAstraContent(astra_content, srv.astra_url || 'http://192.168.88.10:8000'))
      : selectFilteredPanelChannels({ filter_host, selected_stream_ids }).channels;

  if (channels.length === 0) {
    return res.status(400).json({ error: 'No hay canales seleccionados para enviar a Flussonic 23.12.' });
  }

  try {
    const pushRes = await pushBatchStreamsToFlussonic2312(srv, channels, {
      transcodeMode: transcode_mode,
      videoBitrateKbps: video_bitrate_kbps,
      audioBitrateKbps: audio_bitrate_kbps,
      constant247: constant_247 !== false,
      astraOverrideHost: astra_override_host
    });

    if (srv?.id) {
      if (pushRes.effectiveBase && pushRes.effectiveBase !== srv.base_url) {
        db.prepare('UPDATE flussonic_servers SET base_url = ? WHERE id = ?').run(pushRes.effectiveBase, srv.id);
      }
      db.prepare("UPDATE flussonic_servers SET status = 'online', version = ?, last_sync_at = datetime('now') WHERE id = ?").run(
        pushRes.version || '23.12',
        srv.id
      );
    }

    if (pushRes.pushedCount === 0) {
      return res.status(400).json({
        error: `Flussonic 23.12 rechazó la creación de canales (${pushRes.errors[0] || 'Error desconocido'}).`,
        errors: pushRes.errors.slice(0, 8)
      });
    }

    const updatedSrv = srv?.id ? sanitizeServerRow(db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(srv.id)) : null;

    return res.json({
      ok: true,
      server: updatedSrv,
      pushedCount: pushRes.pushedCount,
      passthroughFallbackCount: pushRes.passthroughFallbackCount || 0,
      totalAttempted: pushRes.totalAttempted,
      effectiveBase: pushRes.effectiveBase,
      usedLanBridge: pushRes.usedLanBridge,
      bridgeNodeName: pushRes.bridgeNodeName,
      errors: pushRes.errors.slice(0, 8)
    });
  } catch (err) {
    if (srv?.id) {
      db.prepare("UPDATE flussonic_servers SET status = 'offline' WHERE id = ?").run(srv.id);
    }
    return res.status(400).json({ error: err.message });
  }
}

// Push streams directly to Flussonic 23.12 via PUT /streamer/api/v3/streams/:name (registered server)
flussonic2312Router.post('/api/flussonic-2312/servers/:id/push-streams', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const srv = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
  if (!srv) return res.status(404).json({ error: 'Servidor Flussonic no encontrado.' });
  return executeFlussonicPushHandler(srv, req.body || {}, res);
});

// Inline Direct Push API v3 (auto-saves/updates server credentials from Paso 3 or Tab 3 without needing modal first)
flussonic2312Router.post('/api/flussonic-2312/push-streams-direct', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const srv = upsertFlussonicServerInline({
    server_id: b.server_id,
    name: b.name,
    base_url: b.base_url,
    username: b.username,
    password: b.password,
    api_token: b.api_token,
    astra_url: b.astra_override_host ? `http://${String(b.astra_override_host).replace(/^https?:\/\//i, '')}` : ''
  });

  if (!srv) {
    return res.status(400).json({
      error: 'Escribe primero la URL o IP:Puerto de tu Flussonic 23.12 en el Paso 3 (ej. http://IP_FLUSSONIC:8080).'
    });
  }

  return executeFlussonicPushHandler(srv, b, res);
});

// Prepare 1-line Local SSH Push Script (for local Flussonic 23.12 behind MikroTik NAT without public admin port)
flussonic2312Router.post('/api/flussonic-2312/prepare-local-push-script', requireAuth, requireAdmin, (req, res) => {
  const {
    source_type = 'panel_streams',
    filter_host = '',
    selected_stream_ids = [],
    astra_content = '',
    astra_override_host = '192.168.88.10',
    transcode_mode = 'copy_deint_aac',
    video_bitrate_kbps = 2500,
    audio_bitrate_kbps = 128,
    constant_247 = true,
    username = '',
    password = ''
  } = req.body || {};

  const channels =
    source_type === 'astra_m3u'
      ? assignUniqueFlussonicKeys(parseAstraContent(astra_content, 'http://192.168.88.10:8000'))
      : selectFilteredPanelChannels({ filter_host, selected_stream_ids }).channels;

  if (channels.length === 0) {
    return res.status(400).json({ error: 'Selecciona al menos un canal para generar el comando Push SSH Local.' });
  }

  const items = channels.map((ch, idx) => {
    const { name, payload } = buildFlussonic2312ApiStreamPayload(ch, idx, {
      transcodeMode: transcode_mode,
      videoBitrateKbps: video_bitrate_kbps,
      audioBitrateKbps: audio_bitrate_kbps,
      constant247: constant_247 !== false,
      astraOverrideHost: astra_override_host
    });
    const cleanPayload = {
      name: payload.name,
      title: payload.title,
      static: payload.static,
      inputs: payload.inputs
    };
    return { name, payload, cleanPayload };
  });

  // Purge expired tokens older than 2 hours
  const now = Date.now();
  for (const [k, v] of localPushJobs.entries()) {
    if (now - v.createdAt > 2 * 3600 * 1000) localPushJobs.delete(k);
  }

  const token = crypto.randomBytes(18).toString('hex');
  localPushJobs.set(token, {
    createdAt: now,
    items,
    username: String(username || '').trim(),
    password: String(password || '')
  });

  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '127.0.0.1:8095').split(',')[0].trim();
  const scriptUrl = `${proto}://${host}/api/flussonic-2312/local-push/${token}.sh`;
  const sshCommand = `curl -fsSL "${scriptUrl}" | sudo bash`;

  res.json({
    ok: true,
    channelCount: items.length,
    scriptUrl,
    sshCommand
  });
});

// Public token-guarded bash script executed inside local Flussonic 23.12 server via SSH
flussonic2312Router.get('/api/flussonic-2312/local-push/:token.sh', (req, res) => {
  const token = String(req.params.token || '').trim();
  const job = localPushJobs.get(token);
  if (!job || Date.now() - job.createdAt > 2 * 3600 * 1000) {
    return res.status(404).type('text/plain').send('echo "Error: Token expirado. Genera de nuevo el comando en Panel TVLister 24/7."; exit 1\n');
  }

  const escBashSingle = (str) => String(str || '').replace(/'/g, "'\"'\"'");

  const scriptLines = [
    '#!/usr/bin/env bash',
    'set -u',
    'echo "=================================================================="',
    `echo " Panel TVLister 24/7 -> Push API v3 Local Flussonic 23.12 (${job.items.length} canales)"`,
    'echo "=================================================================="',
    'CONF="/etc/flussonic/flussonic.conf"',
    'FLS_PORT=""',
    'if [ -f "$CONF" ]; then',
    '  FLS_PORT=$(awk \'/^[[:space:]]*http[[:space:]]+[0-9]+/ { gsub(/[^0-9]/, "", $2); print $2; exit }\' "$CONF")',
    'fi',
    'if [ -z "$FLS_PORT" ]; then',
    '  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8080/streamer/api/v3/streams?limit=1"; then FLS_PORT="8080"; else FLS_PORT="80"; fi',
    'fi',
    `UI_USER='${escBashSingle(job.username)}'`,
    `UI_PASS='${escBashSingle(job.password)}'`,
    'AUTH_MODE="none"',
    'CLUSTER_KEY=""',
    'if [ -n "$UI_USER" ] && [ -n "$UI_PASS" ]; then',
    '  AUTH_MODE="basic"',
    'elif [ -f "$CONF" ]; then',
    '  CONF_USER=$(awk \'/^[[:space:]]*edit_auth[[:space:]]+/ { gsub(/;/, "", $2); print $2; exit }\' "$CONF")',
    '  CONF_PASS=$(awk \'/^[[:space:]]*edit_auth[[:space:]]+/ { gsub(/;/, "", $3); print $3; exit }\' "$CONF")',
    '  CONF_CLUSTER=$(awk \'/^[[:space:]]*cluster_key[[:space:]]+/ { gsub(/;/, "", $2); print $2; exit }\' "$CONF")',
    '  if [ -n "$CONF_USER" ] && [ -n "$CONF_PASS" ]; then',
    '    UI_USER="$CONF_USER"; UI_PASS="$CONF_PASS"; AUTH_MODE="basic"',
    '  elif [ -n "$CONF_CLUSTER" ]; then',
    '    CLUSTER_KEY="$CONF_CLUSTER"; AUTH_MODE="cluster"',
    '  fi',
    'fi',
    'push_stream() {',
    '  local KEY="$1"',
    '  local JSON_MAIN="$2"',
    '  local JSON_FALLBACK="$3"',
    '  local URL="http://127.0.0.1:${FLS_PORT}/streamer/api/v3/streams/${KEY}"',
    '  local EXTRA_HDR=()',
    '  if [ "$AUTH_MODE" = "basic" ]; then',
    '    EXTRA_HDR=(-u "${UI_USER}:${UI_PASS}")',
    '  elif [ "$AUTH_MODE" = "cluster" ]; then',
    '    local TS=$(date +%s)',
    '    local SIG=$(printf "%s:%s" "$TS" "$CLUSTER_KEY" | sha1sum | awk \'{print $1}\')',
    '    EXTRA_HDR=(-H "Authorization: Cluster ${TS}:${SIG}")',
    '  fi',
    '  local CODE=$(curl -sS -o /tmp/tvl_fls_out.json -w "%{http_code}" --max-time 8 "${EXTRA_HDR[@]}" -H "Content-Type: application/json" -X PUT "$URL" -d "$JSON_MAIN" || true)',
    '  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ] || [ "$CODE" = "204" ]; then return 0; fi',
    '  if [ "$CODE" = "400" ] || [ "$CODE" = "422" ]; then',
    '    CODE=$(curl -sS -o /tmp/tvl_fls_out.json -w "%{http_code}" --max-time 8 "${EXTRA_HDR[@]}" -H "Content-Type: application/json" -X PUT "$URL" -d "$JSON_FALLBACK" || true)',
    '    if [ "$CODE" = "200" ] || [ "$CODE" = "201" ] || [ "$CODE" = "204" ]; then return 0; fi',
    '  fi',
    '  echo "  [!] Fallo en $KEY (HTTP $CODE): $(head -c 140 /tmp/tvl_fls_out.json 2>/dev/null)"',
    '  return 1',
    '}',
    'OK_COUNT=0',
    'FAIL_COUNT=0'
  ];

  for (const item of job.items) {
    const encName = item.name
      .split('/')
      .map((p) => encodeURIComponent(p))
      .join('/');
    scriptLines.push(
      `if push_stream '${escBashSingle(encName)}' '${escBashSingle(JSON.stringify(item.payload))}' '${escBashSingle(JSON.stringify(item.cleanPayload))}'; then OK_COUNT=$((OK_COUNT+1)); else FAIL_COUNT=$((FAIL_COUNT+1)); fi`
    );
  }

  scriptLines.push('rm -f /tmp/tvl_fls_out.json');
  scriptLines.push('echo "=================================================================="');
  scriptLines.push(`echo " LISTO: \${OK_COUNT}/${job.items.length} canales creados/actualizados en Flussonic 23.12 (127.0.0.1:\${FLS_PORT})"`);
  scriptLines.push('echo "=================================================================="');

  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.send(scriptLines.join('\n') + '\n');
});

// ==================== VINCULAR / IMPORTAR FLUSSONIC 23.12 -> PANEL TVLISTER (24/7 CONSTANTE COPY/COPY) ====================
flussonic2312Router.post('/api/flussonic-2312/servers/:id/link-to-panel', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const srv = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
  if (!srv) return res.status(404).json({ error: 'Servidor Flussonic no encontrado.' });

  const {
    streams = null, // optional pre-fetched list or parsed flussonic.conf streams
    conf_text = '',
    pull_protocol = srv.default_pull_protocol || 'mpegts', // 'mpegts' | 'hls'
    cloud_mode = 'constant_copy_247', // 'constant_copy_247' | 'constant_copy_audio_247' | 'ondemand'
    auto_categorize = true
  } = req.body || {};

  let sourceStreams = Array.isArray(streams) ? streams : null;
  if (!sourceStreams && conf_text && String(conf_text).trim()) {
    const parsed = parseFlussonicConf(conf_text, srv.base_url);
    sourceStreams = parsed.map((p) => ({
      name: p.streamKey,
      title: p.title || p.streamKey,
      group: p.group || '',
      input_url: p.upstreamInput || ''
    }));
  }
  if (!sourceStreams) {
    const live = await probeFlussonic2312Live(srv);
    sourceStreams = live.streams;
  }

  if (!Array.isArray(sourceStreams) || sourceStreams.length === 0) {
    return res.status(400).json({ error: 'No se encontraron streams en Flussonic 23.12 para vincular.' });
  }

  const copyProfId = getCopyCopyProfileId();
  const isConstant = cloud_mode !== 'ondemand';
  const targetStreamMode = isConstant ? 'transcode' : 'ondemand';
  const targetStatus = isConstant ? 'running' : 'ondemand_idle';
  const targetAudioLvl = cloud_mode === 'constant_copy_audio_247' ? 'on' : 'off';

  const existingRows = db.prepare('SELECT * FROM streams').all();
  const byFlussKey = new Map();
  const byAstraKey = new Map();
  const byTitle = new Map();

  for (const r of existingRows) {
    if (r.flussonic_stream_name) byFlussKey.set(String(r.flussonic_stream_name).toLowerCase(), r);
    const ak =
      extractAstraPlayKey(r.astra_local_url) ||
      extractAstraPlayKey(r.original_source_url) ||
      extractAstraPlayKey(r.source_url);
    if (ak) byAstraKey.set(ak, r);
    byTitle.set(String(r.name || '').trim().toLowerCase(), r);
  }

  const headendNode = db.prepare('SELECT id FROM headend_nodes ORDER BY id ASC LIMIT 1').get();
  const constantLaunchIds = [];
  let updatedCount = 0;
  let insertedCount = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const existingCats = db.prepare("SELECT * FROM categories WHERE type = 'live'").all();
    const catMap = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));
    const insCat = db.prepare("INSERT INTO categories (name, type, sort_order) VALUES (?, 'live', 0)");

    const updExisting = db.prepare(
      `UPDATE streams
       SET original_source_url = CASE WHEN original_source_url != '' THEN original_source_url ELSE source_url END,
           source_url = ?,
           headend_node_id = NULL,
           flussonic_server_id = ?,
           flussonic_stream_name = ?,
           stream_mode = ?,
           transcode_profile_id = ?,
           audio_leveling_mode = ?,
           status = CASE WHEN status = 'stopped' THEN 'stopped' ELSE ? END,
           pid = NULL
       WHERE id = ?`
    );

    const insNew = db.prepare(
      `INSERT INTO streams (
         name, category_id, source_url, astra_local_url, logo_url,
         stream_mode, transcode_profile_id, status, bitrate_kbps,
         audio_leveling_mode, flussonic_server_id, flussonic_stream_name, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2500, ?, ?, ?, ?)`
    );

    const b1 = db.prepare('SELECT * FROM bouquets ORDER BY id ASC LIMIT 1').get();
    const b1Ids = b1 ? JSON.parse(b1.stream_ids_json || '[]') : [];
    let maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM streams').get()?.m || 0;
    const usedMatchedIds = new Set();

    for (const fsItem of sourceStreams) {
      const fKey = String(fsItem.name || '').trim();
      if (!fKey) continue;
      const cleanTitle = String(fsItem.title || fKey).trim();
      const inputAstraKey = extractAstraPlayKey(fsItem.input_url || '') || fKey.toLowerCase();
      const pullUrl = buildFlussonicPullUrl(srv, fKey, pull_protocol);

      const candidateMatch =
        byFlussKey.get(fKey.toLowerCase()) ||
        byAstraKey.get(inputAstraKey) ||
        byTitle.get(cleanTitle.toLowerCase());
      const matched = candidateMatch && !usedMatchedIds.has(candidateMatch.id) ? candidateMatch : null;

      if (matched) {
        usedMatchedIds.add(matched.id);
        stopWorker(`stream_${matched.id}`);
        updExisting.run(
          pullUrl,
          id,
          fKey,
          targetStreamMode,
          copyProfId,
          targetAudioLvl,
          targetStatus,
          matched.id
        );
        if (isConstant && matched.status !== 'stopped') constantLaunchIds.push(matched.id);
        updatedCount++;
        continue;
      }

      const rawGroup = String(fsItem.group || '').trim();
      const catName =
        !rawGroup || rawGroup === '-'
          ? auto_categorize
            ? classifyAstraCategoryByName(cleanTitle)
            : 'Flussonic 23.12'
          : rawGroup;

      let catId = catMap.get(catName.toLowerCase());
      if (!catId) {
        const cInfo = insCat.run(catName);
        catId = Number(cInfo.lastInsertRowid);
        catMap.set(catName.toLowerCase(), catId);
      }

      const autoLogo =
        headendNode && /^[a-z0-9]{4}$/i.test(inputAstraKey)
          ? rewriteAstraLogoToCloudBridge(`/playlist/tvg-logo/${inputAstraKey}.png`, headendNode.id)
          : '';

      maxOrder += 1;
      const info = insNew.run(
        cleanTitle,
        catId,
        pullUrl,
        fsItem.input_url || '',
        autoLogo,
        targetStreamMode,
        copyProfId,
        targetStatus,
        targetAudioLvl,
        id,
        fKey,
        maxOrder
      );
      const newSid = Number(info.lastInsertRowid);
      if (!b1Ids.includes(newSid)) b1Ids.push(newSid);
      if (isConstant) constantLaunchIds.push(newSid);
      insertedCount++;
    }

    if (b1 && insertedCount > 0) {
      db.prepare('UPDATE bouquets SET stream_ids_json = ? WHERE id = ?').run(JSON.stringify(b1Ids), b1.id);
    }

    db.exec('COMMIT;');
    if (constantLaunchIds.length > 0) scheduleDbStreamLaunches(constantLaunchIds, 60);

    res.json({
      ok: true,
      updatedCount,
      insertedCount,
      totalLinked: updatedCount + insertedCount
    });
  } catch (err) {
    db.exec('ROLLBACK;');
    res.status(500).json({ error: err.message });
  }
});
