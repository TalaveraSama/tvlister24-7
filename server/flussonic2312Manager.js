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

function normalizeBaseUrl(raw = '') {
  let clean = String(raw || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
  return clean;
}

function buildFlussonicAuthHeaders(srv = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'TVLister-Flussonic2312/1.0'
  };
  if (srv.api_token && String(srv.api_token).trim()) {
    headers.Authorization = `Bearer ${String(srv.api_token).trim()}`;
  } else if (srv.username && String(srv.username).trim()) {
    const b64 = Buffer.from(`${String(srv.username).trim()}:${String(srv.password || '')}`).toString('base64');
    headers.Authorization = `Basic ${b64}`;
  }
  return headers;
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

  const payload = {
    name,
    title: String(ch.name || name).trim(),
    static: Boolean(constant247),
    inputs: [{ url: inputUrl }]
  };

  if (transcodeMode === 'copy_deint_aac' || transcodeMode === 'nvenc_deint_aac' || transcodeMode === 'qsv_deint_aac') {
    const hw =
      transcodeMode === 'nvenc_deint_aac' ? 'nvenc' : transcodeMode === 'qsv_deint_aac' ? 'qsv' : 'cpu';
    payload.transcoder = {
      global: { hw },
      video: [
        {
          bitrate: vb,
          codec: 'h264',
          ...(hw === 'cpu' ? { preset: 'veryfast' } : {}),
          deinterlace: 'yadif'
        }
      ],
      audio: {
        bitrate: ab,
        codec: 'aac',
        sample_rate: 48000,
        channels: 'stereo'
      }
    };
  }

  return { name, payload };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
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

async function probeFlussonic2312Live(srv) {
  const base = normalizeBaseUrl(srv.base_url);
  const headers = buildFlussonicAuthHeaders(srv);

  const streamsRes = await fetchJsonWithTimeout(
    `${base}/streamer/api/v3/streams?limit=5000`,
    { headers },
    9000
  );

  if (!streamsRes.ok || !streamsRes.json) {
    if (streamsRes.status === 401 || streamsRes.status === 403) {
      throw new Error('Autenticación rechazada por Flussonic 23.12 (verifica edit_auth usuario/contraseña o Bearer token).');
    }
    throw new Error(
      `No se pudo consultar /streamer/api/v3/streams en ${base} (HTTP ${streamsRes.status || 'timeout'}).`
    );
  }

  const rawList = Array.isArray(streamsRes.json.streams)
    ? streamsRes.json.streams
    : Array.isArray(streamsRes.json)
    ? streamsRes.json
    : [];

  let detectedVersion = srv.version || '23.12';
  const verMatch = String(streamsRes.serverHeader || '').match(/Flussonic[/\s]+([0-9.]+)/i);
  if (verMatch) detectedVersion = verMatch[1];

  // Optional server telemetry from /flussonic/api/server or /streamer/api/v3/config
  let cpuUsage = 0;
  let memUsage = 0;
  let uptimeSec = 0;
  try {
    const srvInfo = await fetchJsonWithTimeout(`${base}/flussonic/api/server`, { headers }, 4500);
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

// ==================== CRUD SERVIDORES FLUSSONIC 23.12 ====================
flussonic2312Router.get('/api/flussonic-2312/servers', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM flussonic_servers ORDER BY id ASC').all().map(sanitizeServerRow);
  const totalPanelStreams = db.prepare('SELECT COUNT(*) as c FROM streams').get()?.c || 0;
  res.json({ servers: rows, totalPanelStreams });
});

flussonic2312Router.post('/api/flussonic-2312/servers', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
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
      String(b.username || '').trim(),
      String(b.password || ''),
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
  const baseUrl = b.base_url !== undefined ? normalizeBaseUrl(b.base_url) : existing.base_url;

  db.prepare(
    `UPDATE flussonic_servers
     SET name = ?, base_url = ?, username = ?, password = ?, api_token = ?,
         astra_url = ?, astra_auth = ?, default_pull_protocol = ?, default_transcode_mode = ?
     WHERE id = ?`
  ).run(
    b.name !== undefined ? String(b.name).trim() : existing.name,
    baseUrl,
    b.username !== undefined ? String(b.username).trim() : existing.username,
    b.password !== undefined ? String(b.password) : existing.password,
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

    const base = normalizeBaseUrl(srv.base_url);
    const headers = buildFlussonicAuthHeaders(srv);
    const encName = stream_name
      .split('/')
      .map((p) => encodeURIComponent(p))
      .join('/');

    try {
      if (action === 'delete') {
        const r = await fetchJsonWithTimeout(`${base}/streamer/api/v3/streams/${encName}`, {
          method: 'DELETE',
          headers
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 140)}`);
        return res.json({ ok: true });
      }

      // Restart stream on Flussonic 23.12
      let r = await fetchJsonWithTimeout(`${base}/streamer/api/v3/streams/${encName}/restart`, {
        method: 'POST',
        headers
      });
      if (!r.ok) {
        r = await fetchJsonWithTimeout(`${base}/flussonic/api/stream_restart/${encName}`, { headers });
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 140)}`);
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

  let srv = server_id ? db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(Number(server_id)) : null;
  const cleanOverrideBase = normalizeBaseUrl(flussonic_base_url);
  if (!srv && !cleanOverrideBase) {
    return res.status(400).json({
      error: 'Indica o selecciona la URL/IP de tu servidor Flussonic 23.12 para construir los nuevos links.'
    });
  }

  const effectiveTarget = cleanOverrideBase ? { ...(srv || {}), base_url: cleanOverrideBase } : srv;
  const selectedRes = selectFilteredPanelChannels({ filter_host, selected_stream_ids });
  let targetChannels = selectedRes.channels;

  if (Number(limit_count) > 0) {
    targetChannels = targetChannels.slice(0, Number(limit_count));
  }

  if (targetChannels.length === 0) {
    return res.status(400).json({ error: 'Ningún canal de tu lista coincide con esa IP de Astra.' });
  }

  let pushedToFlussonicCount = 0;
  const pushErrors = [];

  if (also_push_to_flussonic) {
    const base = normalizeBaseUrl(effectiveTarget.base_url);
    const headers = {
      ...buildFlussonicAuthHeaders(effectiveTarget),
      'Content-Type': 'application/json'
    };

    for (let i = 0; i < targetChannels.length; i++) {
      const { name, payload } = buildFlussonic2312ApiStreamPayload(targetChannels[i], i, {
        transcodeMode: transcode_mode,
        videoBitrateKbps: video_bitrate_kbps,
        audioBitrateKbps: audio_bitrate_kbps,
        constant247: constant_247 !== false,
        astraOverrideHost: local_astra_host
      });
      const encName = name
        .split('/')
        .map((p) => encodeURIComponent(p))
        .join('/');
      try {
        const r = await fetchJsonWithTimeout(
          `${base}/streamer/api/v3/streams/${encName}`,
          { method: 'PUT', headers, body: JSON.stringify(payload) },
          7000
        );
        if (r.ok) pushedToFlussonicCount++;
        else pushErrors.push(`${name}: HTTP ${r.status}`);
      } catch (e) {
        pushErrors.push(`${name}: ${e.message}`);
      }
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
    updatedLinksCount: targetChannels.length,
    untouchedCount: selectedRes.totalStreams - targetChannels.length,
    pushedToFlussonicCount,
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

// Push streams directly to Flussonic 23.12 via PUT /streamer/api/v3/streams/:name
flussonic2312Router.post('/api/flussonic-2312/servers/:id/push-streams', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const srv = db.prepare('SELECT * FROM flussonic_servers WHERE id = ?').get(id);
  if (!srv) return res.status(404).json({ error: 'Servidor Flussonic no encontrado.' });

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
  } = req.body || {};

  const channels =
    source_type === 'astra_m3u'
      ? assignUniqueFlussonicKeys(parseAstraContent(astra_content, srv.astra_url || 'http://192.168.88.10:8000'))
      : selectFilteredPanelChannels({ filter_host, selected_stream_ids }).channels;

  if (channels.length === 0) {
    return res.status(400).json({ error: 'No hay canales para enviar a Flussonic 23.12.' });
  }

  const base = normalizeBaseUrl(srv.base_url);
  const headers = {
    ...buildFlussonicAuthHeaders(srv),
    'Content-Type': 'application/json'
  };

  let pushedCount = 0;
  const errors = [];

  for (let i = 0; i < channels.length; i++) {
    const { name, payload } = buildFlussonic2312ApiStreamPayload(channels[i], i, {
      transcodeMode: transcode_mode,
      videoBitrateKbps: video_bitrate_kbps,
      audioBitrateKbps: audio_bitrate_kbps,
      constant247: constant_247 !== false,
      astraOverrideHost: astra_override_host
    });
    const encName = name
      .split('/')
      .map((p) => encodeURIComponent(p))
      .join('/');

    try {
      const r = await fetchJsonWithTimeout(
        `${base}/streamer/api/v3/streams/${encName}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload)
        },
        7000
      );
      if (r.ok) {
        pushedCount++;
      } else {
        errors.push(`${name}: HTTP ${r.status}`);
      }
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  res.json({
    ok: pushedCount > 0,
    pushedCount,
    totalAttempted: channels.length,
    errors: errors.slice(0, 8)
  });
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
