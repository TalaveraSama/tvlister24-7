import express from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { db } from './db.js';
import { extractClientIp, signUpstreamUrl, verifyUpstreamUrl, verifyToken } from './auth.js';
import { resolveFlussonicUrlCandidates } from './flussonicImporter.js';
import { getOrCreateMnfSession, MnfToTsRemuxer } from './mnfProtocol.js';
import { resolveIpGeoSync } from './geoIspResolver.js';
import { ensureSlateManifestForStream, pipeSlateContinuousMpegTs } from './offlineSlateEngine.js';
import { resolvePublicPosterUrl, normalizeXuiOrTmdbImageUrl, verifyLocalPosterPath } from './vodSyncTmdb.js';
import {
  computeChannel247LiveState,
  getLocalHlsManifestPath,
  getFreshLocalHlsManifestPath,
  getArchiveSegmentsInRange,
  buildFfmpegArgsForStream,
  startSupervisedWorker,
  getWorkerPid,
  isFfmpegAvailable,
  isStreamAudioLeveled,
  HLS_ROOT,
  ARCHIVE_ROOT
} from './streamEngine.js';

export const iptvRouter = express.Router();

// Ensure CORS headers on all IPTV / WebTV / HLS player endpoints
iptvRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, Origin, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function xmlEscape(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatXmltvDate(isoOrDate) {
  const d = new Date(isoOrDate);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    ' +0000'
  );
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol || 'http';
  const host = req.headers['x-forwarded-host']?.split(',')[0]?.trim() || req.headers.host || 'localhost:8080';
  return `${proto}://${host}`;
}

export function authenticateLine(username, password, req = null) {
  if (!username || !password) return { error: 'Credenciales requeridas', code: 401 };
  const line = db.prepare('SELECT * FROM lines WHERE username = ? AND password = ?').get(username, password);
  if (!line) return { error: 'Usuario o contraseña inválidos', code: 401 };
  if (line.status !== 'active') return { error: 'Línea suspendida o bloqueada', code: 403 };
  if (line.exp_date && new Date(line.exp_date).getTime() < Date.now()) {
    return { error: 'Suscripción expirada', code: 403 };
  }
  if (req && line.allowed_ips && line.allowed_ips.trim().length > 0 && line.allowed_ips.trim() !== '[]') {
    const clientIp = extractClientIp(req);
    const allowedList = line.allowed_ips.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowedList.length > 0 && !allowedList.includes(clientIp)) {
      return { error: 'IP no autorizada para esta línea', code: 403 };
    }
  }
  return { line };
}

function getAllowedIdSetsForLine(line) {
  let bouquetIds = [];
  try {
    bouquetIds = JSON.parse(line.bouquet_ids_json || '[]').map(Number).filter(Boolean);
  } catch {
    bouquetIds = [];
  }

  const allBouquets = db.prepare('SELECT * FROM bouquets').all();
  const matched = bouquetIds.length > 0 ? allBouquets.filter((b) => bouquetIds.includes(b.id)) : allBouquets;

  const streamSet = new Set();
  const ch247Set = new Set();
  const vodSet = new Set();
  const seriesSet = new Set();

  for (const b of matched) {
    try {
      JSON.parse(b.stream_ids_json || '[]').forEach((id) => streamSet.add(Number(id)));
      JSON.parse(b.channel247_ids_json || '[]').forEach((id) => ch247Set.add(Number(id)));
      JSON.parse(b.vod_ids_json || '[]').forEach((id) => vodSet.add(Number(id)));
      JSON.parse(b.series_ids_json || '[]').forEach((id) => seriesSet.add(Number(id)));
    } catch {
      // ignore malformed JSON
    }
  }

  return { streamSet, ch247Set, vodSet, seriesSet };
}

export function isItemAllowedForLine(line, kind, itemId) {
  const { streamSet, ch247Set, vodSet, seriesSet } = getAllowedIdSetsForLine(line);
  const idNum = Number(itemId);
  if (kind === 'live') return streamSet.size === 0 || streamSet.has(idNum);
  if (kind === 'channel247') return ch247Set.size === 0 || ch247Set.has(idNum);
  if (kind === 'vod') return vodSet.size === 0 || vodSet.has(idNum);
  if (kind === 'series') return seriesSet.size === 0 || seriesSet.has(idNum);
  return true;
}

export function expandStreamUpstreamUrls(stream) {
  const rawList = [stream?.source_url, stream?.backup_url].filter(Boolean);
  const expanded = [];
  for (const raw of rawList) {
    const trimmed = String(raw).trim();
    if (/^mnfs?:\/\//i.test(trimmed)) {
      expanded.push(trimmed.replace(/^mnf(s?):\/\//i, 'http$1://'));
    } else {
      for (const cand of resolveFlussonicUrlCandidates(trimmed)) {
        if (cand && !expanded.includes(cand)) expanded.push(cand);
      }
    }
  }
  return expanded;
}

function getAllowedContentForLine(line) {
  const { streamSet, ch247Set, vodSet, seriesSet } = getAllowedIdSetsForLine(line);

  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all();
  const catMap = new Map(categories.map((c) => [c.id, c.name]));

  const allStreams = db.prepare('SELECT * FROM streams ORDER BY sort_order ASC, id ASC').all();
  const allCh247 = db.prepare('SELECT * FROM channels_247 ORDER BY sort_order ASC, id ASC').all();
  const allVod = db.prepare('SELECT * FROM vod_items ORDER BY id ASC').all();
  const allSeries = db.prepare('SELECT * FROM series ORDER BY id ASC').all();
  const allEpisodes = db.prepare('SELECT * FROM series_episodes ORDER BY season_num ASC, episode_num ASC, id ASC').all();

  const streams = (streamSet.size > 0 ? allStreams.filter((s) => streamSet.has(s.id)) : allStreams).map((s) => ({
    ...s,
    category_name: catMap.get(s.category_id) || 'Canales en Vivo'
  }));

  const channels247 = (ch247Set.size > 0 ? allCh247.filter((c) => ch247Set.has(c.id)) : allCh247).map((c) => ({
    ...c,
    category_name: catMap.get(c.category_id) || 'Canales 24/7'
  }));

  const vodItems = (vodSet.size > 0 ? allVod.filter((v) => vodSet.has(v.id)) : allVod).map((v) => ({
    ...v,
    category_name: catMap.get(v.category_id) || 'Películas VOD'
  }));

  const seriesItems = (seriesSet.size > 0 ? allSeries.filter((sr) => seriesSet.has(sr.id)) : allSeries).map((sr) => ({
    ...sr,
    category_name: catMap.get(sr.category_id) || 'Series TV',
    episodes: allEpisodes.filter((ep) => ep.series_id === sr.id)
  }));

  return { categories, streams, channels247, vodItems, seriesItems };
}

// HTTP 206 Byte-Range Media Streamer for local files (e.g. /home/xui/content/... or local disk VOD)
function getMediaMimeType(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}

function serveLocalMediaFileWithRange(req, res, filePath, connId = null) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(404).send('Archivo multimedia no válido');
  } catch {
    return res.status(404).send('Archivo multimedia local no encontrado');
  }

  const totalSize = stat.size;
  const contentType = getMediaMimeType(filePath);
  const range = req.headers.range;

  if (req.socket) req.socket.setTimeout(0);
  if (connId) {
    attachLiveConnectionSocket(connId, req, res);
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': totalSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    return res.end();
  }

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    if (Number.isNaN(start) || start >= totalSize || end >= totalSize || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      return res.end();
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType
    });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Length': totalSize,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes'
  });
  return fs.createReadStream(filePath).pipe(res);
}

// Rewrite upstream HLS .m3u8 manifest so all segments & sub-playlists route through Stream Shield proxy
function rewriteHlsManifestForProxy(manifestText, manifestFinalUrl, proxyPrefix, streamId) {
  const resolveAndSign = (rawUri) => {
    const trimmed = rawUri.trim();
    if (!trimmed) return trimmed;
    let absUrl;
    try {
      absUrl = new URL(trimmed, manifestFinalUrl).toString();
    } catch {
      return trimmed;
    }
    const { u, sig } = signUpstreamUrl(absUrl, streamId);
    return `${proxyPrefix}?u=${encodeURIComponent(u)}&sig=${encodeURIComponent(sig)}`;
  };

  return manifestText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // Rewrite URI="..." inside #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
        return line.replace(/URI="([^"]+)"/g, (_m, uriVal) => `URI="${resolveAndSign(uriVal)}"`);
      }
      return resolveAndSign(trimmed);
    })
    .join('\n');
}

function selectEdgeRedirect(req) {
  if (String(req.query.edge_origin || '') === '1') return null;

  const healthyEdges = db
    .prepare(
      `SELECT * FROM servers
       WHERE is_main = 0
         AND status = 'online'
         AND last_heartbeat_at IS NOT NULL
         AND datetime(last_heartbeat_at) >= datetime('now', '-90 seconds')`
    )
    .all()
    .filter((srv) => (srv.active_conns || 0) < (srv.max_clients || 1000) && (srv.cpu_usage || 0) < 95);

  if (healthyEdges.length === 0) return null;

  const mode = db.prepare("SELECT value FROM settings WHERE key = 'lb_routing_mode'").get()?.value || 'load';
  const reqCountry = (req.headers['cf-ipcountry'] || req.headers['x-country-code'] || '').toUpperCase().trim();
  const reqIsp = (req.headers['x-isp'] || req.headers['user-agent'] || '').toLowerCase();

  let candidates = healthyEdges;
  if (mode === 'geoip' && reqCountry) {
    const geoMatched = healthyEdges.filter((srv) =>
      String(srv.region_countries || '')
        .toUpperCase()
        .split(',')
        .map((c) => c.trim())
        .includes(reqCountry)
    );
    if (geoMatched.length > 0) candidates = geoMatched;
  } else if (mode === 'isp' && reqIsp) {
    const ispMatched = healthyEdges.filter(
      (srv) => srv.isp_match && reqIsp.includes(String(srv.isp_match).toLowerCase().trim())
    );
    if (ispMatched.length > 0) candidates = ispMatched;
  }

  candidates.sort((a, b) => {
    const scoreA = (a.active_conns || 0) / Math.max(1, a.max_clients || 1000) + (a.cpu_usage || 0) / 100;
    const scoreB = (b.active_conns || 0) / Math.max(1, b.max_clients || 1000) + (b.cpu_usage || 0) / 100;
    return scoreA - scoreB;
  });

  const best = candidates[0];
  const proto = best.https_port && req.protocol === 'https' ? 'https' : 'http';
  const port = proto === 'https' ? best.https_port : best.port || 8096;
  return {
    serverId: best.id,
    url: `${proto}://${best.host}:${port}${req.originalUrl}`
  };
}

const activeLiveSockets = new Map(); // connId -> Set<{ close: () => void, hb: NodeJS.Timeout }>

export function pruneStaleConnections() {
  try {
    db.prepare(
      `DELETE FROM active_connections
       WHERE (protocol IN ('HLS', 'WebTV') AND datetime(last_ping_at) < datetime('now', '-90 seconds'))
          OR datetime(last_ping_at) < datetime('now', '-15 minutes')`
    ).run();
  } catch {
    // ignore SQLite busy race
  }
}

export function attachLiveConnectionSocket(connId, req, res, onForceClose = null) {
  if (!connId) return;
  const hb = setInterval(() => {
    try {
      db.prepare("UPDATE active_connections SET last_ping_at = datetime('now') WHERE id = ?").run(connId);
    } catch {
      // ignore
    }
  }, 30_000);
  hb.unref?.();

  const handle = {
    hb,
    close: () => {
      clearInterval(hb);
      try {
        if (typeof onForceClose === 'function') onForceClose();
      } catch {
        // ignore
      }
      try {
        if (res && !res.writableEnded) res.destroy();
      } catch {
        // ignore
      }
    }
  };

  let set = activeLiveSockets.get(connId);
  if (!set) {
    set = new Set();
    activeLiveSockets.set(connId, set);
  }
  set.add(handle);

  const cleanup = () => {
    clearInterval(hb);
    const s = activeLiveSockets.get(connId);
    if (s) {
      s.delete(handle);
      if (s.size === 0) activeLiveSockets.delete(connId);
    }
    try {
      db.prepare('DELETE FROM active_connections WHERE id = ?').run(connId);
    } catch {
      // ignore
    }
  };

  if (req && typeof req.once === 'function') req.once('close', cleanup);
}

export function kickConnectionSocket(connId) {
  const numericId = Number(connId);
  const set = activeLiveSockets.get(numericId);
  if (set) {
    for (const h of set) {
      h.close();
    }
    activeLiveSockets.delete(numericId);
  }
  db.prepare('DELETE FROM active_connections WHERE id = ?').run(numericId);
}

export function kickAllLineConnections(lineId) {
  const rows = db.prepare('SELECT id FROM active_connections WHERE line_id = ?').all(Number(lineId));
  for (const r of rows) {
    kickConnectionSocket(r.id);
  }
}

export function recordConnection(req, line, targetType, targetId, targetName, protocol = 'HLS', serverId = 1) {
  pruneStaleConnections();

  const ip = extractClientIp(req);
  const ua = String(req.headers?.['user-agent'] || 'IPTV Player').trim().slice(0, 255) || 'IPTV Player';
  const geo = resolveIpGeoSync(ip, req);
  const country = geo.country || '--';
  const isp = geo.isp || 'Detectando ISP...';

  const existing = db
    .prepare(
      'SELECT id, country, isp FROM active_connections WHERE line_id = ? AND ip_address = ? AND target_type = ? AND target_id = ?'
    )
    .get(line.id, ip, targetType, targetId);

  if (existing) {
    const nextCountry = country !== '--' ? country : existing.country || '--';
    const nextIsp = isp !== 'Detectando ISP...' ? isp : existing.isp || isp;
    db.prepare(
      "UPDATE active_connections SET last_ping_at = datetime('now'), target_name = ?, protocol = ?, user_agent = ?, country = ?, isp = ?, server_id = ? WHERE id = ?"
    ).run(targetName, protocol, ua, nextCountry, nextIsp, serverId, existing.id);
    return { allowed: true, connId: existing.id };
  }

  const activeCount = db
    .prepare('SELECT COUNT(*) as c FROM active_connections WHERE line_id = ?')
    .get(line.id).c;

  if (activeCount >= line.max_connections) {
    const sameIpOldest = db
      .prepare('SELECT id, country, isp FROM active_connections WHERE line_id = ? AND ip_address = ? ORDER BY last_ping_at ASC LIMIT 1')
      .get(line.id, ip);
    if (sameIpOldest) {
      const nextCountry = country !== '--' ? country : sameIpOldest.country || '--';
      const nextIsp = isp !== 'Detectando ISP...' ? isp : sameIpOldest.isp || isp;
      db.prepare(
        "UPDATE active_connections SET target_type = ?, target_id = ?, target_name = ?, protocol = ?, user_agent = ?, country = ?, isp = ?, server_id = ?, last_ping_at = datetime('now') WHERE id = ?"
      ).run(targetType, targetId, targetName, protocol, ua, nextCountry, nextIsp, serverId, sameIpOldest.id);
      return { allowed: true, connId: sameIpOldest.id };
    }
    return { allowed: false, error: 'Límite máximo de conexiones simultáneas alcanzado' };
  }

  const info = db.prepare(`
    INSERT INTO active_connections (line_id, username, target_type, target_id, target_name, ip_address, country, isp, user_agent, protocol, server_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(line.id, line.username, targetType, targetId, targetName, ip, country, isp, ua, protocol, serverId);

  return { allowed: true, connId: Number(info.lastInsertRowid) };
}

async function serveSubscriberOfflineSlate(req, res, stream, username, password, protocol, connId = null) {
  const slate = await ensureSlateManifestForStream(stream);
  if (!slate || !slate.manifest) return false;

  if (protocol === 'MPEG-TS') {
    if (connId) attachLiveConnectionSocket(connId, req, res);
    pipeSlateContinuousMpegTs(req, res, slate.workerKey);
    return true;
  }

  const content = fs.readFileSync(slate.manifest, 'utf8');
  const baseSegUrl = `/hls_out/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${slate.workerKey}/`;
  const rewritten = content.replace(/^(?!#)([^\r\n]+)$/gm, (m) => `${baseSegUrl}${path.basename(m.trim())}`);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-TVLister-Fallback', 'offline-slate-loop');
  res.send(rewritten);
  return true;
}

function wakeOnDemandTranscodeIfNeeded(stream) {
  if (!isFfmpegAvailable()) return false;
  const workerKey = `stream_${stream.id}`;
  if (getWorkerPid(workerKey)) return true;

  const profile = stream.transcode_profile_id
    ? db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(stream.transcode_profile_id)
    : null;

  const audioLeveled = isStreamAudioLeveled(stream, profile);
  const isRemuxOrTranscodeProfile =
    Boolean(stream.headend_node_id) ||
    audioLeveled ||
    (profile &&
      ((profile.video_codec && profile.video_codec !== 'copy') ||
        (profile.audio_codec && profile.audio_codec !== 'copy') ||
        Number(stream.transcode_profile_id) > 1 ||
        /copy\/copy|remux|2\.5|nivelado/i.test(String(profile.name || ''))));

  const needsFfmpeg =
    stream.stream_mode === 'transcode' || (stream.stream_mode === 'ondemand' && isRemuxOrTranscodeProfile);

  if (!needsFfmpeg) return false;

  startSupervisedWorker(
    workerKey,
    () => {
      const fresh = db.prepare('SELECT * FROM streams WHERE id = ?').get(stream.id);
      if (!fresh || fresh.status !== 'running') return null;
      const prof = fresh.transcode_profile_id
        ? db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(fresh.transcode_profile_id)
        : null;
      return buildFfmpegArgsForStream(fresh, prof);
    },
    (pid) => {
      db.prepare('UPDATE streams SET pid = ? WHERE id = ?').run(pid, stream.id);
    }
  );
  return Boolean(getWorkerPid(workerKey));
}

async function waitForFreshWorkerManifest(workerKey, maxWaitMs = 4200) {
  let manifest = getFreshLocalHlsManifestPath(workerKey, 18);
  if (manifest) return manifest;
  if (!getWorkerPid(workerKey)) return null;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 180));
    manifest = getFreshLocalHlsManifestPath(workerKey, 18);
    if (manifest) return manifest;
    if (!getWorkerPid(workerKey)) break;
  }
  return getFreshLocalHlsManifestPath(workerKey, 18);
}

// 1. Standard M3U / M3U_Plus Playlist Generator (/get.php)
iptvRouter.get('/get.php', (req, res) => {
  const defaultFmtRow = db.prepare("SELECT value FROM settings WHERE key = 'default_output_format'").get();
  const { username, password, output = defaultFmtRow?.value || 'hls' } = req.query;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).type('text/plain').send(auth.error);

  const baseUrl = getBaseUrl(req);
  const isMnfOutput = output === 'mnf';
  const ext = isMnfOutput ? 'mnf' : output === 'ts' ? 'ts' : 'm3u8';
  const livePrefix = isMnfOutput ? 'mnf' : 'live';
  const { streams, channels247, vodItems, seriesItems } = getAllowedContentForLine(auth.line);

  const epgUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const linesOut = [`#EXTM3U x-tvg-url="${epgUrl}"`];

  let chNo = 1;
  for (const s of streams) {
    const catchupAttr =
      s.tv_archive_days > 0
        ? ` catchup="default" catchup-days="${s.tv_archive_days}" catchup-source="${baseUrl}/timeshift/${encodeURIComponent(username)}/${encodeURIComponent(password)}/{duration}/{Y}-{m}-{d}:{H}-{M}/${s.id}.m3u8"`
        : '';
    const pubLogo = resolvePublicPosterUrl(s.logo_url, baseUrl);
    linesOut.push(
      `#EXTINF:-1 tvg-chno="${chNo++}" tvg-id="${s.epg_channel_id || `stream-${s.id}`}" tvg-name="${s.name}" tvg-logo="${pubLogo}"${catchupAttr} group-title="${s.category_name}",${s.name}`
    );
    linesOut.push(`${baseUrl}/${livePrefix}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.id}.${ext}`);
  }

  for (const ch of channels247) {
    const virtualId = 10000 + ch.id;
    linesOut.push(
      `#EXTINF:-1 tvg-chno="${chNo++}" tvg-id="${ch.epg_channel_id || `ch247-${ch.id}`}" tvg-name="${ch.name}" tvg-logo="${ch.logo_url || ''}" group-title="${ch.category_name}",[24/7] ${ch.name}`
    );
    linesOut.push(`${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${virtualId}.m3u8`);
  }

  for (const v of vodItems) {
    linesOut.push(
      `#EXTINF:-1 tvg-id="" tvg-name="${v.title}" tvg-logo="${v.poster_url || ''}" group-title="VOD - ${v.category_name}",${v.title} (${v.release_year || ''})`
    );
    linesOut.push(
      `${baseUrl}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${v.id}.${v.container_ext || 'mp4'}`
    );
  }

  for (const sr of seriesItems) {
    for (const ep of sr.episodes || []) {
      const sPad = String(ep.season_num).padStart(2, '0');
      const ePad = String(ep.episode_num).padStart(2, '0');
      linesOut.push(
        `#EXTINF:-1 tvg-id="" tvg-name="${sr.title} S${sPad}E${ePad}" tvg-logo="${sr.poster_url || ''}" group-title="Series - ${sr.title}",${sr.title} S${sPad}E${ePad} - ${ep.title}`
      );
      linesOut.push(
        `${baseUrl}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${ep.id}.${ep.container_ext || 'mp4'}`
      );
    }
  }

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="tvlister_${username}.m3u"`);
  res.send(linesOut.join('\n') + '\n');
});

// 1b. Enigma2 Bouquet Feed (/enigma2.php)
iptvRouter.get('/enigma2.php', (req, res) => {
  const { username, password, type = 'get_live_streams' } = req.query;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).type('text/plain').send(auth.error);

  const baseUrl = getBaseUrl(req);
  const { streams, channels247, vodItems } = getAllowedContentForLine(auth.line);

  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<items>'];
  if (type === 'get_vod_streams') {
    for (const v of vodItems) {
      xml.push('  <channel>');
      xml.push(`    <title>${Buffer.from(v.title).toString('base64')}</title>`);
      xml.push(`    <description>${Buffer.from(v.plot || '').toString('base64')}</description>`);
      xml.push(`    <stream_url><![CDATA[${baseUrl}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${v.id}.${v.container_ext || 'mp4'}]]></stream_url>`);
      xml.push('  </channel>');
    }
  } else {
    for (const s of streams) {
      xml.push('  <channel>');
      xml.push(`    <title>${Buffer.from(s.name).toString('base64')}</title>`);
      xml.push(`    <stream_url><![CDATA[${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.id}.ts]]></stream_url>`);
      xml.push('  </channel>');
    }
    for (const ch of channels247) {
      xml.push('  <channel>');
      xml.push(`    <title>${Buffer.from(`[24/7] ${ch.name}`).toString('base64')}</title>`);
      xml.push(`    <stream_url><![CDATA[${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${10000 + ch.id}.m3u8]]></stream_url>`);
      xml.push('  </channel>');
    }
  }
  xml.push('</items>');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml.join('\n'));
});

// 2. Standard XMLTV Electronic Program Guide (/xmltv.php & /xmltv.xml.gz)
function buildXmltvPayload() {
  const streams = db.prepare('SELECT * FROM streams ORDER BY sort_order ASC, id ASC').all();
  const channels247 = db.prepare('SELECT * FROM channels_247 ORDER BY sort_order ASC, id ASC').all();
  const staticPrograms = db.prepare('SELECT * FROM epg_programs ORDER BY start_time ASC').all();

  const xml = ['<?xml version="1.0" encoding="UTF-8"?>'];
  xml.push('<tv generator-info-name="TVLister 24/7 Engine" generator-info-url="https://tvlister24-7.local">');

  for (const s of streams) {
    const cid = xmlEscape(s.epg_channel_id || `stream-${s.id}`);
    xml.push(`  <channel id="${cid}">`);
    xml.push(`    <display-name>${xmlEscape(s.name)}</display-name>`);
    if (s.logo_url) xml.push(`    <icon src="${xmlEscape(s.logo_url)}" />`);
    xml.push('  </channel>');
  }

  for (const ch of channels247) {
    const cid = xmlEscape(ch.epg_channel_id || `ch247-${ch.id}`);
    xml.push(`  <channel id="${cid}">`);
    xml.push(`    <display-name>${xmlEscape(ch.name)}</display-name>`);
    if (ch.logo_url) xml.push(`    <icon src="${xmlEscape(ch.logo_url)}" />`);
    xml.push('  </channel>');
  }

  for (const p of staticPrograms) {
    xml.push(
      `  <programme start="${formatXmltvDate(p.start_time)}" stop="${formatXmltvDate(p.end_time)}" channel="${xmlEscape(p.channel_epg_id)}">`
    );
    xml.push(`    <title lang="${xmlEscape(p.lang || 'es')}">${xmlEscape(p.title)}</title>`);
    if (p.description) {
      xml.push(`    <desc lang="${xmlEscape(p.lang || 'es')}">${xmlEscape(p.description)}</desc>`);
    }
    xml.push('  </programme>');
  }

  for (const ch of channels247) {
    const cid = xmlEscape(ch.epg_channel_id || `ch247-${ch.id}`);
    const state = computeChannel247LiveState(ch);
    for (const slot of state.schedule) {
      xml.push(
        `  <programme start="${formatXmltvDate(slot.start_iso)}" stop="${formatXmltvDate(slot.end_iso)}" channel="${cid}">`
      );
      xml.push(`    <title lang="es">${xmlEscape(slot.title)}</title>`);
      xml.push(`    <desc lang="es">Emisión continua 24/7 en ${xmlEscape(ch.name)}.</desc>`);
      xml.push('  </programme>');
    }
  }

  xml.push('</tv>');
  return xml.join('\n');
}

iptvRouter.get(['/xmltv.php', '/xmltv.xml.gz'], (req, res) => {
  const { username, password, gzip } = req.query;
  if (username || password) {
    const auth = authenticateLine(username, password, req);
    if (auth.error) return res.status(auth.code).type('text/plain').send(auth.error);
  }

  const xmlBody = buildXmltvPayload();
  if (req.path.endsWith('.gz') || gzip === '1' || gzip === 'true') {
    const compressed = zlib.gzipSync(Buffer.from(xmlBody, 'utf8'));
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'inline; filename="xmltv.xml.gz"');
    return res.send(compressed);
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xmlBody);
});

// 3. Xtream Codes Compatible Player & Panel API (/player_api.php & /panel_api.php)
const handlePlayerApi = (req, res) => {
  const params = { ...req.query, ...req.body };
  const { username, password, action } = params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) {
    return res.json({ user_info: { auth: 0, message: auth.error } });
  }

  const { line } = auth;
  const baseUrl = getBaseUrl(req);
  const parsedUrl = new URL(baseUrl);
  const { categories, streams, channels247, vodItems, seriesItems } = getAllowedContentForLine(line);
  const activeConns = db.prepare('SELECT COUNT(*) as c FROM active_connections WHERE line_id = ?').get(line.id).c;

  if (!action) {
    return res.json({
      user_info: {
        username: line.username,
        password: line.password,
        message: 'Bienvenido a TVLister 24/7',
        auth: 1,
        status: 'Active',
        exp_date: line.exp_date ? String(Math.floor(new Date(line.exp_date).getTime() / 1000)) : null,
        is_trial: String(line.is_trial),
        active_cons: String(activeConns),
        created_at: String(Math.floor(new Date(line.created_at).getTime() / 1000 || Date.now() / 1000)),
        max_connections: String(line.max_connections),
        allowed_output_formats: ['m3u8', 'ts', 'mnf']
      },
      server_info: {
        url: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'),
        https_port: '443',
        server_protocol: parsedUrl.protocol.replace(':', ''),
        rtmp_port: '1935',
        timezone: 'UTC',
        timestamp_now: Math.floor(Date.now() / 1000),
        time_now: new Date().toISOString()
      }
    });
  }

  if (action === 'get_live_categories') {
    const usedCatIds = new Set([...streams.map((s) => s.category_id), ...channels247.map((c) => c.category_id)]);
    return res.json(
      categories
        .filter((c) => (c.type === 'live' || c.type === 'channel247') && (usedCatIds.size === 0 || usedCatIds.has(c.id)))
        .map((c) => ({
          category_id: String(c.id),
          category_name: c.name,
          parent_id: 0
        }))
    );
  }

  if (action === 'get_live_streams') {
    const catFilter = params.category_id ? String(params.category_id) : null;
    const out = [];
    let num = 1;
    for (const s of streams) {
      if (catFilter && String(s.category_id) !== catFilter) continue;
      out.push({
        num: num++,
        name: s.name,
        stream_type: 'live',
        stream_id: s.id,
        stream_icon: resolvePublicPosterUrl(s.logo_url, baseUrl),
        epg_channel_id: s.epg_channel_id || `stream-${s.id}`,
        added: String(Math.floor(Date.now() / 1000)),
        category_id: String(s.category_id || 1),
        custom_sid: '',
        tv_archive: s.tv_archive_days > 0 ? 1 : 0,
        direct_source: '',
        tv_archive_duration: s.tv_archive_days
      });
    }
    for (const ch of channels247) {
      if (catFilter && String(ch.category_id) !== catFilter) continue;
      out.push({
        num: num++,
        name: `[24/7] ${ch.name}`,
        stream_type: 'live',
        stream_id: 10000 + ch.id,
        stream_icon: ch.logo_url || '',
        epg_channel_id: ch.epg_channel_id || `ch247-${ch.id}`,
        added: String(Math.floor(Date.now() / 1000)),
        category_id: String(ch.category_id || 4),
        custom_sid: '',
        tv_archive: 0,
        direct_source: '',
        tv_archive_duration: 0
      });
    }
    return res.json(out);
  }

  if (action === 'get_vod_categories') {
    const usedVodCats = new Set(vodItems.map((v) => v.category_id));
    return res.json(
      categories
        .filter((c) => c.type === 'vod' && (usedVodCats.size === 0 || usedVodCats.has(c.id)))
        .map((c) => ({
          category_id: String(c.id),
          category_name: c.name,
          parent_id: 0
        }))
    );
  }

  if (action === 'get_vod_streams') {
    const catFilter = params.category_id ? String(params.category_id) : null;
    return res.json(
      vodItems
        .filter((v) => !catFilter || String(v.category_id) === catFilter)
        .map((v, idx) => {
          const poster = resolvePublicPosterUrl(v.poster_url, baseUrl);
          return {
            num: idx + 1,
            name: v.title,
            stream_type: 'movie',
            stream_id: v.id,
            stream_icon: poster,
            cover: poster,
            rating: String(v.rating || 8.0),
            rating_5based: Number(((v.rating || 8) / 2).toFixed(1)),
            added: String(Math.floor(Date.now() / 1000)),
            category_id: String(v.category_id || 6),
            container_extension: v.container_ext || 'mp4',
            custom_sid: '',
            direct_source: ''
          };
        })
    );
  }

  if (action === 'get_vod_info') {
    const vodId = Number(params.vod_id);
    const v = vodItems.find((x) => x.id === vodId);
    if (!v) return res.json({ info: {}, movie_data: {} });
    const poster = resolvePublicPosterUrl(v.poster_url, baseUrl);
    const backdropRaw = normalizeXuiOrTmdbImageUrl(v.backdrop_url || '', 'backdrop');
    const backdrop = backdropRaw.startsWith('/') ? `${baseUrl}${backdropRaw}` : backdropRaw;
    const durSecs = Number(v.duration_sec) || 5400;
    const hh = String(Math.floor(durSecs / 3600)).padStart(2, '0');
    const mm = String(Math.floor((durSecs % 3600) / 60)).padStart(2, '0');
    const ss = String(durSecs % 60).padStart(2, '0');
    return res.json({
      info: {
        tmdb_id: v.tmdb_id || '',
        name: v.title,
        o_name: v.title,
        cover_big: poster,
        movie_image: poster,
        releasedate: String(v.release_year || 2024),
        plot: v.plot || '',
        description: v.plot || '',
        genre: v.genre || 'General',
        rating: String(v.rating || 8.0),
        duration_secs: durSecs,
        duration: `${hh}:${mm}:${ss}`,
        backdrop_path: backdrop ? [backdrop] : poster ? [poster] : []
      },
      movie_data: {
        stream_id: v.id,
        name: v.title,
        added: String(Math.floor(Date.now() / 1000)),
        category_id: String(v.category_id || 6),
        container_extension: v.container_ext || 'mp4'
      }
    });
  }

  if (action === 'get_series_categories') {
    const usedSeriesCats = new Set(seriesItems.map((sr) => sr.category_id));
    const sCats = categories.filter((c) => c.type === 'series' && (usedSeriesCats.size === 0 || usedSeriesCats.has(c.id)));
    const list = sCats.length > 0 ? sCats : categories.filter((c) => c.type === 'vod');
    return res.json(
      list.map((c) => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }))
    );
  }

  if (action === 'get_series') {
    const catFilter = params.category_id ? String(params.category_id) : null;
    return res.json(
      seriesItems
        .filter((sr) => !catFilter || String(sr.category_id) === catFilter)
        .map((sr, idx) => {
          const poster = resolvePublicPosterUrl(sr.poster_url, baseUrl);
          const backdropRaw = normalizeXuiOrTmdbImageUrl(sr.backdrop_url || '', 'backdrop');
          const backdrop = backdropRaw.startsWith('/') ? `${baseUrl}${backdropRaw}` : backdropRaw;
          return {
            num: idx + 1,
            name: sr.title,
            series_id: sr.id,
            cover: poster,
            plot: sr.plot || '',
            cast: '',
            director: '',
            genre: sr.genre || 'Drama',
            releaseDate: `${sr.release_year || 2024}-01-01`,
            last_modified: String(Math.floor(Date.now() / 1000)),
            rating: String(sr.rating || 8.5),
            rating_5based: Number(((sr.rating || 8.5) / 2).toFixed(1)),
            backdrop_path: backdrop ? [backdrop] : [],
            youtube_trailer: '',
            episode_run_time: '45',
            category_id: String(sr.category_id || 8)
          };
        })
    );
  }

  if (action === 'get_series_info') {
    const seriesId = Number(params.series_id);
    const sr = seriesItems.find((x) => x.id === seriesId);
    if (!sr) return res.json({ seasons: [], info: {}, episodes: {} });
    const poster = resolvePublicPosterUrl(sr.poster_url, baseUrl);
    const backdropRaw = normalizeXuiOrTmdbImageUrl(sr.backdrop_url || '', 'backdrop');
    const backdrop = backdropRaw.startsWith('/') ? `${baseUrl}${backdropRaw}` : backdropRaw;

    const episodesBySeason = {};
    const seasonSet = new Set();
    for (const ep of sr.episodes || []) {
      const sKey = String(ep.season_num || 1);
      seasonSet.add(Number(ep.season_num || 1));
      if (!episodesBySeason[sKey]) episodesBySeason[sKey] = [];
      episodesBySeason[sKey].push({
        id: String(ep.id),
        episode_num: ep.episode_num,
        title: ep.title,
        container_extension: ep.container_ext || 'mp4',
        info: {
          duration_secs: ep.duration_sec || 2400,
          duration: `${Math.round((ep.duration_sec || 2400) / 60)} min`,
          plot: ep.plot || sr.plot || '',
          movie_image: poster
        },
        custom_sid: '',
        added: String(Math.floor(Date.now() / 1000)),
        season: Number(ep.season_num || 1),
        direct_source: ''
      });
    }

    const seasons = Array.from(seasonSet)
      .sort((a, b) => a - b)
      .map((sNum) => ({
        air_date: `${sr.release_year || 2024}-01-01`,
        episode_count: (episodesBySeason[String(sNum)] || []).length,
        id: sNum,
        name: `Temporada ${sNum}`,
        overview: sr.plot || '',
        season_number: sNum,
        cover: poster
      }));

    return res.json({
      seasons,
      info: {
        tmdb_id: sr.tmdb_id || '',
        name: sr.title,
        cover: poster,
        plot: sr.plot || '',
        genre: sr.genre || '',
        releaseDate: `${sr.release_year || 2024}-01-01`,
        rating: String(sr.rating || 8.5),
        backdrop_path: backdrop ? [backdrop] : [],
        category_id: String(sr.category_id || 8)
      },
      episodes: episodesBySeason
    });
  }

  if (action === 'get_short_epg' || action === 'get_simple_data_table') {
    const streamId = Number(params.stream_id);
    if (streamId > 10000) {
      const ch = db.prepare('SELECT * FROM channels_247 WHERE id = ?').get(streamId - 10000);
      if (!ch) return res.json({ epg_listings: [] });
      const state = computeChannel247LiveState(ch);
      return res.json({
        epg_listings: state.schedule.slice(0, 6).map((slot, idx) => ({
          id: String(idx + 1),
          title: Buffer.from(slot.title).toString('base64'),
          lang: 'es',
          start: slot.start_iso,
          end: slot.end_iso,
          description: Buffer.from(`Señal continua 24/7 en ${ch.name}`).toString('base64'),
          start_timestamp: String(slot.start_epoch),
          stop_timestamp: String(slot.end_epoch)
        }))
      });
    }
    const s = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
    if (!s) return res.json({ epg_listings: [] });
    const progs = db.prepare('SELECT * FROM epg_programs WHERE channel_epg_id = ? LIMIT 6').all(s.epg_channel_id);
    return res.json({
      epg_listings: progs.map((p) => ({
        id: String(p.id),
        title: Buffer.from(p.title).toString('base64'),
        lang: p.lang || 'es',
        start: p.start_time,
        end: p.end_time,
        description: Buffer.from(p.description || '').toString('base64')
      }))
    });
  }

  return res.json([]);
};

iptvRouter.get('/player_api.php', handlePlayerApi);
iptvRouter.post('/player_api.php', handlePlayerApi);
iptvRouter.get('/panel_api.php', handlePlayerApi);
iptvRouter.post('/panel_api.php', handlePlayerApi);

// Serve local FFmpeg-transcoded HLS segments securely
iptvRouter.get('/hls_out/:username/:password/:workerKey/:fileName', (req, res) => {
  const { username, password, workerKey, fileName } = req.params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const safeKey = path.basename(workerKey);
  const safeFile = path.basename(fileName);
  const fullPath = path.join(HLS_ROOT, safeKey, safeFile);
  if (!fs.existsSync(fullPath)) return res.status(404).send('Segment not ready');

  // Refresh live subscriber connection telemetry (IP, User-Agent, ISP) on local HLS segment fetches
  if (safeKey.startsWith('stream_')) {
    const sid = Number(safeKey.replace('stream_', ''));
    const st = sid ? db.prepare('SELECT id, name FROM streams WHERE id = ?').get(sid) : null;
    if (st) recordConnection(req, auth.line, 'live', st.id, st.name, 'HLS');
  } else if (safeKey.startsWith('ch247_')) {
    const cid = Number(safeKey.replace('ch247_', ''));
    const ch = cid ? db.prepare('SELECT id, name FROM channels_247 WHERE id = ?').get(cid) : null;
    if (ch) recordConnection(req, auth.line, 'channel247', ch.id, ch.name, 'HLS');
  }

  if (safeFile.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  } else if (safeFile.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t');
  }
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(fullPath).pipe(res);
});

// Stream Shield HLS Upstream Proxy (hides upstream provider URLs/credentials & solves upstream IP-Lock)
iptvRouter.get('/hls_proxy/:username/:password/:streamId', async (req, res) => {
  const { username, password, streamId } = req.params;
  const { u, sig } = req.query;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const sid = Number(streamId);
  if (!isItemAllowedForLine(auth.line, 'live', sid)) {
    return res.status(403).send('Canal fuera de tu bouquet');
  }

  const targetUrl = verifyUpstreamUrl(String(u || ''), String(sig || ''), sid);
  if (!targetUrl) {
    return res.status(400).send('Firma de segmento HLS inválida');
  }

  const stream = db.prepare('SELECT id, name, user_agent FROM streams WHERE id = ?').get(sid);
  const ua = stream?.user_agent || 'TVLister/2.3';

  // Refresh viewer heartbeat while fetching HLS sub-playlists/segments
  if (stream) {
    recordConnection(req, auth.line, 'live', stream.id, stream.name, 'HLS');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  req.on('close', () => ac.abort());

  try {
    const upRes = await fetch(targetUrl, {
      headers: { 'User-Agent': ua },
      redirect: 'follow',
      signal: ac.signal
    });
    clearTimeout(timer);
    if (!upRes.ok || !upRes.body) {
      return res.status(upRes.status || 502).send('Upstream HLS no disponible');
    }

    const cType = (upRes.headers.get('content-type') || '').toLowerCase();
    const isSubManifest =
      cType.includes('mpegurl') ||
      targetUrl.split('?')[0].toLowerCase().endsWith('.m3u8');

    if (isSubManifest) {
      const text = await upRes.text();
      if (text.includes('#EXTM3U')) {
        const proxyPrefix = `${getBaseUrl(req)}/hls_proxy/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${sid}`;
        const rewritten = rewriteHlsManifestForProxy(text, upRes.url || targetUrl, proxyPrefix, sid);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(rewritten);
      }
    }

    res.setHeader('Content-Type', upRes.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    return Readable.fromWeb(upRes.body).pipe(res);
  } catch {
    clearTimeout(timer);
    if (!res.headersSent) res.status(502).send('Error conectando con proveedor HLS');
  }
});

async function serveLiveStreamRequest(req, res) {
  const { username, password, streamSpec } = req.params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const rawId = streamSpec.replace(/\.(m3u8|ts)$/i, '');
  const protocol = streamSpec.toLowerCase().endsWith('.ts') ? 'MPEG-TS' : 'HLS';
  const numericId = Number(rawId);

  // Enforce Bouquet Entitlement
  if (numericId > 10000 || rawId.startsWith('ch247_')) {
    const chId = rawId.startsWith('ch247_') ? Number(rawId.replace('ch247_', '')) : numericId - 10000;
    if (!isItemAllowedForLine(auth.line, 'channel247', chId)) {
      return res.status(403).send('Canal 24/7 no incluido en el paquete contratado');
    }
  } else if (!isItemAllowedForLine(auth.line, 'live', numericId)) {
    return res.status(403).send('Canal no incluido en el paquete contratado');
  }

  // Edge Load Balancer Smart Routing (if an active Edge node has a live heartbeat)
  const edgeTarget = selectEdgeRedirect(req);
  if (edgeTarget) {
    if (numericId > 10000 || rawId.startsWith('ch247_')) {
      const chId = rawId.startsWith('ch247_') ? Number(rawId.replace('ch247_', '')) : numericId - 10000;
      const ch = db.prepare('SELECT id, name FROM channels_247 WHERE id = ?').get(chId);
      if (ch) {
        const c = recordConnection(req, auth.line, 'channel247', ch.id, ch.name, protocol, edgeTarget.serverId);
        if (!c.allowed) return res.status(429).send(c.error);
      }
    } else {
      const st = db.prepare('SELECT id, name FROM streams WHERE id = ?').get(numericId);
      if (st) {
        const c = recordConnection(req, auth.line, 'live', st.id, st.name, protocol, edgeTarget.serverId);
        if (!c.allowed) return res.status(429).send(c.error);
      }
    }
    return res.redirect(302, edgeTarget.url);
  }

  // 24/7 Channel Delivery
  if (numericId > 10000 || rawId.startsWith('ch247_')) {
    const chId = rawId.startsWith('ch247_') ? Number(rawId.replace('ch247_', '')) : numericId - 10000;
    const ch = db.prepare('SELECT * FROM channels_247 WHERE id = ?').get(chId);
    if (!ch || ch.status !== 'running') {
      return res.status(404).send('Canal 24/7 fuera del aire');
    }
    const conn = recordConnection(req, auth.line, 'channel247', ch.id, ch.name, protocol);
    if (!conn.allowed) return res.status(429).send(conn.error);

    const workerKey = `ch247_${ch.id}`;
    const localManifest = getLocalHlsManifestPath(workerKey);
    if (localManifest) {
      const content = fs.readFileSync(localManifest, 'utf8');
      const baseSegUrl = `/hls_out/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${workerKey}/`;
      const rewritten = content.replace(/^(?!#)([^\r\n]+)$/gm, (m) => `${baseSegUrl}${path.basename(m.trim())}`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritten);
    }

    const state = computeChannel247LiveState(ch);
    if (!state.currentItem?.url) {
      return res.status(404).send('Playlist 24/7 vacía');
    }
    if (state.currentItem.url.startsWith('/') && fs.existsSync(state.currentItem.url)) {
      return serveLocalMediaFileWithRange(req, res, state.currentItem.url, conn.connId);
    }
    return res.redirect(302, state.currentItem.url);
  }

  // Standard Live Stream Delivery
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(numericId);
  if (!stream) return res.status(404).send('Canal no encontrado');
  if (stream.status === 'stopped') {
    const connStopped = recordConnection(req, auth.line, 'live', stream.id, `${stream.name} [Bucle Offline]`, protocol);
    if (connStopped.allowed) {
      const servedSlate = await serveSubscriberOfflineSlate(
        req,
        res,
        stream,
        username,
        password,
        protocol,
        connStopped.connId
      );
      if (servedSlate) return;
    }
    return res.status(503).send('Canal detenido por el administrador');
  }

  if (stream.status === 'ondemand_idle') {
    db.prepare("UPDATE streams SET status = 'running', uptime_started_at = datetime('now') WHERE id = ?").run(stream.id);
    stream.status = 'running';
  }

  const hasActiveWorker = wakeOnDemandTranscodeIfNeeded(stream);

  const conn = recordConnection(req, auth.line, 'live', stream.id, stream.name, protocol);
  if (!conn.allowed) return res.status(429).send(conn.error);

  // 1) Local FFmpeg-transcoded / Copy-Remux / Audio-Leveled HLS manifest (waits up to 4.2s on On-Demand cold start)
  const workerKey = `stream_${stream.id}`;
  const coldWaitMs = stream.headend_node_id ? 10500 : 4200;
  const localManifest = hasActiveWorker
    ? await waitForFreshWorkerManifest(workerKey, coldWaitMs)
    : getFreshLocalHlsManifestPath(workerKey, 18);
  if (localManifest) {
    if (protocol === 'MPEG-TS') {
      attachLiveConnectionSocket(conn.connId, req, res);
      return pipeSlateContinuousMpegTs(req, res, workerKey);
    }
    const content = fs.readFileSync(localManifest, 'utf8');
    const baseSegUrl = `/hls_out/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${workerKey}/`;
    const rewritten = content.replace(/^(?!#)([^\r\n]+)$/gm, (m) => `${baseSegUrl}${path.basename(m.trim())}`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(rewritten);
  }

  // 2) Local file path on server disk (e.g. XUI.one local media)
  if (stream.source_url.startsWith('/') && fs.existsSync(stream.source_url)) {
    return serveLocalMediaFileWithRange(req, res, stream.source_url, conn.connId);
  }

  // 3) Stream Shield Reverse Proxy (Flussonic M4F/CMAF, Local RTMP/SRT/RTSP Loopback, HLS .m3u8 rewriting, MNF->TS remux, and MPEG-TS Failover)
  const proxySetting = db.prepare("SELECT value FROM settings WHERE key = 'proxy_direct_ts'").get();
  const candidates = expandStreamUpstreamUrls(stream);
  const isLoopbackUpstream = /^https?:\/\/(127\.|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
    String(stream.source_url || '').trim()
  );

  if (
    isLoopbackUpstream ||
    proxySetting?.value === 'true' ||
    stream.source_url.startsWith('m4f') ||
    stream.source_url.startsWith('mnf')
  ) {
    if (req.socket) req.socket.setTimeout(0);

    for (const upstreamUrl of candidates) {
      const cleanPath = upstreamUrl.split('?')[0].toLowerCase();
      const isLikelyHls = cleanPath.endsWith('.m3u8');
      const isLikelyMnf = cleanPath.endsWith('.mnf') || /^mnfs?:\/\//i.test(stream.source_url);

      if (isLikelyHls) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 8000);
        try {
          const upRes = await fetch(upstreamUrl, {
            headers: { 'User-Agent': stream.user_agent || 'TVLister/2.3' },
            redirect: 'follow',
            signal: ac.signal
          });
          clearTimeout(timer);
          if (upRes.ok) {
            const manifestText = await upRes.text();
            if (manifestText.includes('#EXTM3U')) {
              const proxyPrefix = `${getBaseUrl(req)}/hls_proxy/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${stream.id}`;
              const rewritten = rewriteHlsManifestForProxy(
                manifestText,
                upRes.url || upstreamUrl,
                proxyPrefix,
                stream.id
              );
              res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
              res.setHeader('Cache-Control', 'no-store');
              return res.send(rewritten);
            }
          }
        } catch {
          clearTimeout(timer);
          // failover to next candidate / backup_url
        }
      } else {
        const ac = new AbortController();
        try {
          const upRes = await fetch(upstreamUrl, {
            headers: { 'User-Agent': stream.user_agent || 'TVLister/2.3' },
            redirect: 'follow',
            signal: ac.signal
          });
          if (upRes.ok && upRes.body) {
            attachLiveConnectionSocket(conn.connId, req, res, () => ac.abort());
            const upstreamType = (upRes.headers.get('content-type') || '').toLowerCase();

            // If upstream is TVLister Media NanoFrame (MNF v1), remux on-the-fly to standard 188-byte MPEG-TS for legacy players!
            if (isLikelyMnf || upstreamType.includes('-mnf')) {
              res.setHeader('Content-Type', 'video/mp2t');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Upstream-Protocol', 'MNF/1.0');
              const remuxer = new MnfToTsRemuxer();
              remuxer.on('ts', (tsBuf) => {
                if (!res.writableEnded) res.write(tsBuf);
              });
              const reader = upRes.body.getReader();
              (async () => {
                try {
                  while (!res.writableEnded) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) remuxer.push(Buffer.from(value));
                  }
                } catch {
                  // client closed or upstream ended
                } finally {
                  if (!res.writableEnded) res.end();
                }
              })();
              return;
            }

            res.setHeader('Content-Type', upRes.headers.get('content-type') || 'video/mp2t');
            res.setHeader('Cache-Control', 'no-store');
            return Readable.fromWeb(upRes.body).pipe(res);
          }
        } catch {
          // failover to next candidate / backup_url
        }
      }
    }

    // All upstream sources failed or have no live signal -> fall back to Offline Video/Image Loop Slate!
    const servedSlate = await serveSubscriberOfflineSlate(
      req,
      res,
      stream,
      username,
      password,
      protocol,
      conn.connId
    );
    if (servedSlate) return;

    if (isLoopbackUpstream) {
      return res
        .status(503)
        .send('Señal RTMP/SRT/RTSP sin transmisión activa en este momento (verifica que OBS/Encoder esté EN VIVO).');
    }
  }

  if (!candidates[0] && !stream.source_url) {
    const servedSlate = await serveSubscriberOfflineSlate(
      req,
      res,
      stream,
      username,
      password,
      protocol,
      conn.connId
    );
    if (servedSlate) return;
    return res.status(503).send('Canal sin fuente configurada.');
  }

  return res.redirect(302, candidates[0] || stream.source_url);
}

// 4. Live Stream Delivery (/live/:username/:password/:streamSpec AND short Xtream /:username/:password/:numericId)
iptvRouter.get('/live/:username/:password/:streamSpec', serveLiveStreamRequest);

// 4b. Native Ultra-Light MNF v1 (TVLister Media NanoFrame) Delivery (/mnf/:username/:password/:streamSpec)
iptvRouter.get('/mnf/:username/:password/:streamSpec', (req, res) => {
  const { username, password, streamSpec } = req.params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const numericId = Number(String(streamSpec).replace(/\.(mnf|ts|m3u8)$/i, ''));
  if (!isItemAllowedForLine(auth.line, 'live', numericId)) {
    return res.status(403).send('Canal no incluido en tu paquete');
  }

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(numericId);
  if (!stream) return res.status(404).send('Canal no encontrado');
  if (stream.status === 'stopped') return res.status(503).send('Canal detenido');

  const conn = recordConnection(req, auth.line, 'live', stream.id, stream.name, 'MNF');
  if (!conn.allowed) return res.status(429).send(conn.error);

  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-tvlister-mnf',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Protocol': 'MNF/1.0 (TVLister Media NanoFrame)',
  });

  const upstreamUrls = expandStreamUpstreamUrls(stream);
  const { session, release } = getOrCreateMnfSession({
    streamId: stream.id,
    upstreamUrls,
  });

  const sendChunk = (buf) => {
    if (!res.writableEnded) {
      res.write(buf);
    }
  };

  session.addSubscriber(sendChunk);

  attachLiveConnectionSocket(conn.connId, req, res, () => release(sendChunk));
  req.once('close', () => {
    release(sendChunk);
  });
});

iptvRouter.get(/^\/([^/]+)\/([^/]+)\/(\d+(?:\.(?:ts|m3u8))?)$/i, (req, res) => {
  req.params = {
    username: decodeURIComponent(req.params[0]),
    password: decodeURIComponent(req.params[1]),
    streamSpec: req.params[2]
  };
  return serveLiveStreamRequest(req, res);
});

// 5. Movie VOD Delivery (/movie/:username/:password/:vodSpec)
iptvRouter.all('/movie/:username/:password/:vodSpec', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  const { username, password, vodSpec } = req.params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const vodId = Number(vodSpec.split('.')[0]);
  const vod = db.prepare('SELECT * FROM vod_items WHERE id = ?').get(vodId);
  if (!vod) return res.status(404).send('VOD no encontrado');
  if (!isItemAllowedForLine(auth.line, 'vod', vod.id)) {
    return res.status(403).send('Película VOD no incluida en tu paquete');
  }

  const edgeTarget = selectEdgeRedirect(req);
  const conn = recordConnection(req, auth.line, 'vod', vod.id, vod.title, 'VOD', edgeTarget?.serverId || 1);
  if (!conn.allowed) return res.status(429).send(conn.error);
  if (edgeTarget) return res.redirect(302, edgeTarget.url);

  if (vod.source_url.startsWith('/')) {
    return serveLocalMediaFileWithRange(req, res, vod.source_url, conn.connId);
  }
  return res.redirect(302, vod.source_url);
});

// 5b. Series Episode Delivery (/series/:username/:password/:episodeSpec)
iptvRouter.all('/series/:username/:password/:episodeSpec', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  const { username, password, episodeSpec } = req.params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const epId = Number(episodeSpec.split('.')[0]);
  const ep = db
    .prepare(
      `SELECT e.*, s.title as series_title
       FROM series_episodes e
       LEFT JOIN series s ON s.id = e.series_id
       WHERE e.id = ?`
    )
    .get(epId);
  if (!ep) return res.status(404).send('Episodio no encontrado');
  if (!isItemAllowedForLine(auth.line, 'series', ep.series_id)) {
    return res.status(403).send('Serie no incluida en tu paquete');
  }

  const edgeTarget = selectEdgeRedirect(req);
  const label = `${ep.series_title || 'Serie'} S${ep.season_num}E${ep.episode_num}`;
  const conn = recordConnection(req, auth.line, 'series', ep.id, label, 'Series', edgeTarget?.serverId || 1);
  if (!conn.allowed) return res.status(429).send(conn.error);
  if (edgeTarget) return res.redirect(302, edgeTarget.url);

  if (ep.source_url.startsWith('/')) {
    return serveLocalMediaFileWithRange(req, res, ep.source_url, conn.connId);
  }
  return res.redirect(302, ep.source_url);
});

// 5c. TV Archive / Catchup & Timeshift Delivery
function parseTimeshiftStartEpoch(rawStart = '') {
  const s = String(rawStart).trim();
  if (/^\d{10}$/.test(s)) return Number(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[:\sT](\d{2})[-:](\d{2})/);
  if (m) {
    const [, yr, mo, dy, hr, mi] = m;
    return Math.floor(Date.UTC(Number(yr), Number(mo) - 1, Number(dy), Number(hr), Number(mi), 0) / 1000);
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) - 1800 : Math.floor(parsed / 1000);
}

iptvRouter.get('/archive_seg/:username/:password/:streamId/:fileName', (req, res) => {
  const { username, password, streamId, fileName } = req.params;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const safeFile = path.basename(fileName);
  if (!/^seg_\d+\.ts$/.test(safeFile)) return res.status(400).send('Invalid segment');
  const fullPath = path.join(ARCHIVE_ROOT, `stream_${Number(streamId)}`, safeFile);
  if (!fs.existsSync(fullPath)) return res.status(404).send('Archive segment not found');

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(fullPath).pipe(res);
});

async function handleTimeshiftPlayback(req, res, { username, password, streamSpec, startRaw, durationMin }) {
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const streamId = Number(String(streamSpec).replace(/\.(m3u8|ts)$/i, ''));
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  if (!stream) return res.status(404).send('Canal no encontrado para Catchup');
  if (!isItemAllowedForLine(auth.line, 'live', stream.id)) {
    return res.status(403).send('Canal no incluido en tu paquete');
  }

  const conn = recordConnection(req, auth.line, 'catchup', stream.id, `[Catchup] ${stream.name}`, 'Timeshift');
  if (!conn.allowed) return res.status(429).send(conn.error);

  const startEpoch = parseTimeshiftStartEpoch(startRaw);
  const durationSec = Math.max(60, (Number(durationMin) || 60) * 60);
  const segments = getArchiveSegmentsInRange(stream.id, startEpoch, durationSec);

  if (segments.length === 0) {
    return res.redirect(302, stream.source_url);
  }

  const wantsRawTs = String(streamSpec).toLowerCase().endsWith('.ts');
  if (wantsRawTs) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    for (const seg of segments) {
      if (res.writableEnded || res.destroyed) break;
      await new Promise((resolve) => {
        const rs = fs.createReadStream(seg.fullPath);
        rs.on('end', resolve);
        rs.on('error', resolve);
        rs.pipe(res, { end: false });
      });
    }
    return res.end();
  }

  const baseUrl = getBaseUrl(req);
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:12',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ];
  for (const seg of segments) {
    m3u8.push('#EXTINF:10.0,');
    m3u8.push(
      `${baseUrl}/archive_seg/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${stream.id}/${seg.filename}`
    );
  }
  m3u8.push('#EXT-X-ENDLIST');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(m3u8.join('\n') + '\n');
}

iptvRouter.get('/timeshift/:username/:password/:duration/:start/:streamSpec', (req, res) => {
  const { username, password, duration, start, streamSpec } = req.params;
  return handleTimeshiftPlayback(req, res, {
    username,
    password,
    streamSpec,
    startRaw: start,
    durationMin: duration
  });
});

iptvRouter.get('/streaming/timeshift.php', (req, res) => {
  const { username, password, stream, start, duration } = req.query;
  return handleTimeshiftPlayback(req, res, {
    username,
    password,
    streamSpec: `${stream || ''}.m3u8`,
    startRaw: start,
    durationMin: duration
  });
});

// 6. Built-in WebTV HTML5 Client Portal Endpoints (/api/webtv/*)
iptvRouter.post('/api/webtv/login', (req, res) => {
  const { username, password } = req.body || {};
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).json({ error: auth.error });

  const { line } = auth;
  res.json({
    line: {
      id: line.id,
      username: line.username,
      password: line.password,
      exp_date: line.exp_date,
      max_connections: line.max_connections,
      device_type: line.device_type
    }
  });
});

iptvRouter.get('/api/webtv/catalog', (req, res) => {
  const { username, password } = req.query;
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).json({ error: auth.error });

  const { categories, streams, channels247, vodItems, seriesItems } = getAllowedContentForLine(auth.line);
  const allPrograms = db.prepare('SELECT * FROM epg_programs ORDER BY start_time ASC').all();

  const enrichedStreams = streams.map((s) => ({
    ...s,
    epg: allPrograms.filter((p) => p.channel_epg_id === s.epg_channel_id).slice(0, 3)
  }));

  const enrichedCh247 = channels247.map((ch) => ({
    ...ch,
    liveState: computeChannel247LiveState(ch)
  }));

  const activeMessages = db
    .prepare(
      'SELECT * FROM osd_messages WHERE active = 1 AND (target_line_id IS NULL OR target_line_id = ?) ORDER BY id DESC LIMIT 3'
    )
    .all(auth.line.id);

  res.json({
    categories,
    streams: enrichedStreams,
    channels247: enrichedCh247,
    vodItems: vodItems.map((v) => ({
      ...v,
      poster_url: normalizeXuiOrTmdbImageUrl(v.poster_url || '', 'poster'),
      backdrop_url: normalizeXuiOrTmdbImageUrl(v.backdrop_url || '', 'backdrop')
    })),
    series: seriesItems.map((sr) => ({
      ...sr,
      poster_url: normalizeXuiOrTmdbImageUrl(sr.poster_url || '', 'poster'),
      backdrop_url: normalizeXuiOrTmdbImageUrl(sr.backdrop_url || '', 'backdrop')
    })),
    osdMessages: activeMessages
  });
});

iptvRouter.get('/api/webtv/channel247/:id/state', (req, res) => {
  const ch = db.prepare('SELECT * FROM channels_247 WHERE id = ?').get(Number(req.params.id));
  if (!ch) return res.status(404).json({ error: 'Canal 24/7 no encontrado' });
  res.json({
    id: ch.id,
    name: ch.name,
    watermark_text: ch.watermark_text,
    status: ch.status,
    liveState: computeChannel247LiveState(ch)
  });
});

iptvRouter.post('/api/webtv/ping', (req, res) => {
  const { username, password, target_type, target_id, target_name } = req.body || {};
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).json({ error: auth.error });

  const conn = recordConnection(req, auth.line, target_type || 'live', Number(target_id) || 1, target_name || 'Stream', 'WebTV');
  if (!conn.allowed) return res.status(429).json({ error: conn.error });

  const activeMessages = db
    .prepare(
      'SELECT * FROM osd_messages WHERE active = 1 AND (target_line_id IS NULL OR target_line_id = ?) ORDER BY id DESC LIMIT 2'
    )
    .all(auth.line.id);

  res.json({ ok: true, osdMessages: activeMessages });
});

iptvRouter.post('/api/webtv/claim', (req, res) => {
  const { username, password, stream_name, issue_type, message } = req.body || {};
  const auth = authenticateLine(username, password, req);
  if (auth.error) return res.status(auth.code).json({ error: auth.error });

  if (!stream_name) return res.status(400).json({ error: 'Selecciona el canal o contenido' });

  db.prepare(
    'INSERT INTO client_claims (line_username, stream_name, issue_type, message, status) VALUES (?, ?, ?, ?, ?)'
  ).run(auth.line.username, stream_name, issue_type || 'buffering', message || '', 'open');

  res.json({ ok: true, message: 'Reporte enviado al panel de administración.' });
});

iptvRouter.get('/api/webtv/speedtest', (req, res) => {
  const sizeKb = Math.min(512, Math.max(64, Number(req.query.kb) || 256));
  const payload = crypto.randomBytes(sizeKb * 1024);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.send(payload);
});

// Read-only bridge for XUI.one local movie/series covers stored in /home/xui/wwwdir/images/
iptvRouter.get('/xui_images/:fileName', (req, res) => {
  const safeName = path.basename(String(req.params.fileName || ''));
  if (!safeName || !/\.(jpg|jpeg|png|webp|gif)$/i.test(safeName)) {
    return res.status(404).end();
  }
  const candidates = [
    path.join('/home/xui/wwwdir/images', safeName),
    path.join('/home/xui/content/images', safeName),
  ];
  for (const fullPath of candidates) {
    if (fs.existsSync(fullPath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(fullPath);
    }
  }
  return res.status(404).end();
});

// Read-only HMAC-signed local sidecar movie poster (e.g. Movie.jpg / poster.jpg inside a Watch Folder)
iptvRouter.get('/vod_local_poster', (req, res) => {
  const filePath = verifyLocalPosterPath(String(req.query.p || ''), String(req.query.sig || ''));
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).end();
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(filePath);
});

// ==================== ADMIN LIVE MONITOR PROXY (Solves 127.0.0.1 RTMP Loopback, Local Disk VOD & CORS) ====================
function checkAdminPreviewJwt(req) {
  const authHeader = req.headers.authorization || '';
  const rawJwt = String(req.query.jwt || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '')).trim();
  return { user: verifyToken(rawJwt), rawJwt };
}

iptvRouter.get('/api/admin/preview/hls_local/:workerKey/:fileName', (req, res) => {
  const { user } = checkAdminPreviewJwt(req);
  if (!user) return res.status(401).send('Sesión expirada');
  const safeKey = path.basename(String(req.params.workerKey || ''));
  const safeFile = path.basename(String(req.params.fileName || ''));
  const fullPath = path.join(HLS_ROOT, safeKey, safeFile);
  if (!fs.existsSync(fullPath)) return res.status(404).send('Segment not ready');
  res.setHeader(
    'Content-Type',
    safeFile.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
  );
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(fullPath).pipe(res);
});

iptvRouter.get('/api/admin/preview/hls_seg', async (req, res) => {
  const { user, rawJwt } = checkAdminPreviewJwt(req);
  if (!user) return res.status(401).send('Sesión expirada');

  const sid = Number(req.query.id) || 0;
  const targetUrl = verifyUpstreamUrl(String(req.query.u || ''), String(req.query.sig || ''), sid);
  if (!targetUrl) return res.status(400).send('Firma HLS inválida');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  req.on('close', () => ac.abort());

  try {
    const upRes = await fetch(targetUrl, {
      headers: { 'User-Agent': 'TVLister-Monitor/2.3' },
      redirect: 'follow',
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!upRes.ok || !upRes.body) {
      return res.status(upRes.status || 502).send('Segmento no disponible');
    }

    const cType = (upRes.headers.get('content-type') || '').toLowerCase();
    const cleanTarget = targetUrl.split('?')[0].toLowerCase();
    const isSubManifest = cType.includes('mpegurl') || cleanTarget.endsWith('.m3u8');

    if (isSubManifest) {
      const text = await upRes.text();
      if (text.includes('#EXTM3U')) {
        const proxyPrefix = `/api/admin/preview/hls_seg`;
        const rewritten = rewriteHlsManifestForProxy(text, upRes.url || targetUrl, proxyPrefix, sid)
          .replace(/\/api\/admin\/preview\/hls_seg\?/g, `/api/admin/preview/hls_seg?jwt=${encodeURIComponent(rawJwt)}&id=${sid}&`);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(rewritten);
      }
    }

    res.setHeader(
      'Content-Type',
      upRes.headers.get('content-type') || (cleanTarget.endsWith('.mp4') || cleanTarget.endsWith('.m4s') ? 'video/mp4' : 'video/mp2t')
    );
    res.setHeader('Cache-Control', 'no-store');
    return Readable.fromWeb(upRes.body).pipe(res);
  } catch {
    clearTimeout(timer);
    if (!res.headersSent) res.status(502).send('Error cargando segmento de vista previa');
  }
});

iptvRouter.get('/api/admin/preview/stream', async (req, res) => {
  const { user, rawJwt } = checkAdminPreviewJwt(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const rawUrl = String(req.query.url || '').trim();
  const kind = String(req.query.kind || 'live');
  const sid = Number(req.query.id) || 0;

  // 1. Check active local FFmpeg worker for stream / channel247 (also wake On-Demand live streams for preview)
  if (sid > 0 && (kind === 'live' || kind === 'channel247')) {
    let hasWorker = false;
    let isRemoteHeadend = false;
    if (kind === 'live') {
      const stRow = db.prepare('SELECT * FROM streams WHERE id = ?').get(sid);
      if (stRow && stRow.status !== 'stopped') {
        isRemoteHeadend = Boolean(stRow.headend_node_id);
        if (stRow.status === 'ondemand_idle') {
          db.prepare("UPDATE streams SET status = 'running', uptime_started_at = datetime('now') WHERE id = ?").run(sid);
          stRow.status = 'running';
        }
        hasWorker = wakeOnDemandTranscodeIfNeeded(stRow);
      }
    }
    const workerKey = kind === 'channel247' ? `ch247_${sid}` : `stream_${sid}`;
    const localManifest =
      kind === 'live'
        ? hasWorker
          ? await waitForFreshWorkerManifest(workerKey, isRemoteHeadend ? 10500 : 4200)
          : getFreshLocalHlsManifestPath(workerKey, 18)
        : getLocalHlsManifestPath(workerKey);
    if (localManifest) {
      const content = fs.readFileSync(localManifest, 'utf8');
      const segBase = `/api/admin/preview/hls_local/${encodeURIComponent(workerKey)}/`;
      const qSuffix = `?jwt=${encodeURIComponent(rawJwt)}`;
      const rewritten = content.replace(
        /^(?!#)([^\r\n]+)$/gm,
        (m) => `${segBase}${path.basename(m.trim())}${qSuffix}`
      );
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritten);
    }
  }

  // 2. Local disk media file (VOD movie / series episode / 24-7 file)
  if (rawUrl.startsWith('/') && fs.existsSync(rawUrl)) {
    return serveLocalMediaFileWithRange(req, res, rawUrl, null);
  }

  // 3. Expand Flussonic m4f://, MNF mnf://, or HTTP(S) (including 127.0.0.1:18888 RTMP Ingest!)
  const streamObj =
    sid > 0 && kind === 'live'
      ? db.prepare('SELECT * FROM streams WHERE id = ?').get(sid) || { source_url: rawUrl }
      : { source_url: rawUrl };

  const candidates = expandStreamUpstreamUrls(streamObj);
  const isLocalIngest = /^https?:\/\/127\.0\.0\.1:\d+\/live\//i.test(rawUrl);

  for (const upstreamUrl of candidates) {
    const cleanPath = upstreamUrl.split('?')[0].toLowerCase();
    // Skip .flv backup candidate when HLS player requests .m3u8
    if (isLocalIngest && cleanPath.endsWith('.flv')) continue;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 7000);
    req.on('close', () => ac.abort());

    try {
      const upRes = await fetch(upstreamUrl, {
        headers: { 'User-Agent': streamObj.user_agent || 'TVLister-Monitor/2.3' },
        redirect: 'follow',
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!upRes.ok || !upRes.body) continue;

      const cType = (upRes.headers.get('content-type') || '').toLowerCase();
      const isHls = cType.includes('mpegurl') || cleanPath.endsWith('.m3u8');

      if (isHls) {
        const manifestText = await upRes.text();
        if (manifestText.includes('#EXTM3U')) {
          const proxyPrefix = `/api/admin/preview/hls_seg`;
          const rewritten = rewriteHlsManifestForProxy(
            manifestText,
            upRes.url || upstreamUrl,
            proxyPrefix,
            sid
          ).replace(
            /\/api\/admin\/preview\/hls_seg\?/g,
            `/api/admin/preview/hls_seg?jwt=${encodeURIComponent(rawJwt)}&id=${sid}&`
          );
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Cache-Control', 'no-store');
          return res.send(rewritten);
        }
      } else {
        if (req.socket) req.socket.setTimeout(0);
        res.setHeader('Content-Type', upRes.headers.get('content-type') || 'video/mp2t');
        res.setHeader('Cache-Control', 'no-store');
        return Readable.fromWeb(upRes.body).pipe(res);
      }
    } catch {
      clearTimeout(timer);
    }
  }

  // Fallback to Offline Loop Slate (Imagen o Video en Bucle) when live channel has no signal
  if (kind === 'live') {
    const slate = await ensureSlateManifestForStream(streamObj);
    if (slate && slate.manifest) {
      const content = fs.readFileSync(slate.manifest, 'utf8');
      const segBase = `/api/admin/preview/hls_local/${encodeURIComponent(slate.workerKey)}/`;
      const qSuffix = `?jwt=${encodeURIComponent(rawJwt)}`;
      const rewritten = content.replace(
        /^(?!#)([^\r\n]+)$/gm,
        (m) => `${segBase}${path.basename(m.trim())}${qSuffix}`
      );
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-TVLister-Fallback', 'offline-slate-loop');
      return res.send(rewritten);
    }
  }

  if (isLocalIngest) {
    const keyMatch = rawUrl.match(/\/live\/([^/?#]+)/i);
    const keyName = keyMatch ? keyMatch[1] : '';
    const ep = keyName
      ? db.prepare('SELECT status, publisher_ip FROM ingest_endpoints WHERE stream_key = ?').get(keyName)
      : null;
    const rtmpPort = db.prepare("SELECT value FROM settings WHERE key = 'ingest_rtmp_port'").get()?.value || '1935';
    return res.status(404).json({
      code: 'INGEST_WAITING',
      streamKey: keyName,
      ingestStatus: ep?.status || 'idle',
      rtmpPort,
      error:
        ep?.status === 'live'
          ? `Señal RTMP recibida (${ep.publisher_ip || 'encoder'}) — generando primeros segmentos de video HLS (espera 2 segundos)...`
          : `Este canal RTMP está en espera de señal. Inicia transmisión desde OBS / vMix hacia rtmp://${req.hostname}:${rtmpPort}/live con clave "${keyName}".`,
    });
  }

  return res.status(502).json({
    code: 'UPSTREAM_ERROR',
    error: 'La fuente de origen no respondió o está temporalmente fuera de línea.',
  });
});


