import express from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';
import { extractClientIp } from './auth.js';
import { computeChannel247LiveState } from './streamEngine.js';

export const iptvRouter = express.Router();

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

function authenticateLine(username, password) {
  if (!username || !password) return { error: 'Credenciales requeridas', code: 401 };
  const line = db.prepare('SELECT * FROM lines WHERE username = ? AND password = ?').get(username, password);
  if (!line) return { error: 'Usuario o contraseña inválidos', code: 401 };
  if (line.status !== 'active') return { error: 'Línea suspendida o bloqueada', code: 403 };
  if (line.exp_date && new Date(line.exp_date).getTime() < Date.now()) {
    return { error: 'Suscripción expirada', code: 403 };
  }
  return { line };
}

function getAllowedContentForLine(line) {
  let bouquetIds = [];
  try {
    bouquetIds = JSON.parse(line.bouquet_ids_json || '[]');
  } catch {
    bouquetIds = [];
  }

  const allBouquets = db.prepare('SELECT * FROM bouquets').all();
  const matched = bouquetIds.length > 0 ? allBouquets.filter((b) => bouquetIds.includes(b.id)) : allBouquets;

  const streamSet = new Set();
  const ch247Set = new Set();
  const vodSet = new Set();

  for (const b of matched) {
    try {
      JSON.parse(b.stream_ids_json || '[]').forEach((id) => streamSet.add(Number(id)));
      JSON.parse(b.channel247_ids_json || '[]').forEach((id) => ch247Set.add(Number(id)));
      JSON.parse(b.vod_ids_json || '[]').forEach((id) => vodSet.add(Number(id)));
    } catch {
      // ignore malformed
    }
  }

  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all();
  const catMap = new Map(categories.map((c) => [c.id, c.name]));

  const allStreams = db.prepare('SELECT * FROM streams ORDER BY id ASC').all();
  const allCh247 = db.prepare('SELECT * FROM channels_247 ORDER BY id ASC').all();
  const allVod = db.prepare('SELECT * FROM vod_items ORDER BY id ASC').all();

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

  return { categories, streams, channels247, vodItems };
}

function recordConnection(req, line, targetType, targetId, targetName, protocol = 'HLS') {
  // Clean stale connections older than 15 minutes
  db.prepare("DELETE FROM active_connections WHERE datetime(last_ping_at) < datetime('now', '-15 minutes')").run();

  const ip = extractClientIp(req);
  const ua = (req.headers['user-agent'] || 'IPTV Player').slice(0, 120);

  const existing = db
    .prepare(
      'SELECT id FROM active_connections WHERE line_id = ? AND ip_address = ? AND target_type = ? AND target_id = ?'
    )
    .get(line.id, ip, targetType, targetId);

  if (existing) {
    db.prepare(
      "UPDATE active_connections SET last_ping_at = datetime('now'), target_name = ?, protocol = ? WHERE id = ?"
    ).run(targetName, protocol, existing.id);
    return { allowed: true };
  }

  const activeCount = db
    .prepare('SELECT COUNT(*) as c FROM active_connections WHERE line_id = ?')
    .get(line.id).c;

  if (activeCount >= line.max_connections) {
    // Replace oldest connection from same IP if re-zapping, else enforce limit
    const sameIpOldest = db
      .prepare('SELECT id FROM active_connections WHERE line_id = ? AND ip_address = ? ORDER BY last_ping_at ASC LIMIT 1')
      .get(line.id, ip);
    if (sameIpOldest) {
      db.prepare(
        "UPDATE active_connections SET target_type = ?, target_id = ?, target_name = ?, protocol = ?, user_agent = ?, last_ping_at = datetime('now') WHERE id = ?"
      ).run(targetType, targetId, targetName, protocol, ua, sameIpOldest.id);
      return { allowed: true };
    }
    return { allowed: false, error: 'Límite máximo de conexiones simultáneas alcanzado' };
  }

  db.prepare(`
    INSERT INTO active_connections (line_id, username, target_type, target_id, target_name, ip_address, country, isp, user_agent, protocol, server_id)
    VALUES (?, ?, ?, ?, ?, ?, 'NI', 'Client Network', ?, ?, 1)
  `).run(line.id, line.username, targetType, targetId, targetName, ip, ua, protocol);

  return { allowed: true };
}

// 1. Standard M3U / M3U_Plus Playlist Generator (/get.php)
iptvRouter.get('/get.php', (req, res) => {
  const { username, password, output = 'hls' } = req.query;
  const auth = authenticateLine(username, password);
  if (auth.error) return res.status(auth.code).type('text/plain').send(auth.error);

  const baseUrl = getBaseUrl(req);
  const ext = output === 'ts' ? 'ts' : 'm3u8';
  const { streams, channels247, vodItems } = getAllowedContentForLine(auth.line);

  const epgUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const linesOut = [`#EXTM3U x-tvg-url="${epgUrl}"`];

  for (const s of streams) {
    linesOut.push(
      `#EXTINF:-1 tvg-id="${s.epg_channel_id || `stream-${s.id}`}" tvg-name="${s.name}" tvg-logo="${s.logo_url || ''}" group-title="${s.category_name}",${s.name}`
    );
    linesOut.push(`${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${s.id}.${ext}`);
  }

  for (const ch of channels247) {
    const virtualId = 10000 + ch.id;
    linesOut.push(
      `#EXTINF:-1 tvg-id="${ch.epg_channel_id || `ch247-${ch.id}`}" tvg-name="${ch.name}" tvg-logo="${ch.logo_url || ''}" group-title="${ch.category_name}",[24/7] ${ch.name}`
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

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="tvlister_${username}.m3u"`);
  res.send(linesOut.join('\n') + '\n');
});

// 2. Standard XMLTV Electronic Program Guide (/xmltv.php)
iptvRouter.get('/xmltv.php', (req, res) => {
  const { username, password } = req.query;
  if (username || password) {
    const auth = authenticateLine(username, password);
    if (auth.error) return res.status(auth.code).type('text/plain').send(auth.error);
  }

  const streams = db.prepare('SELECT * FROM streams').all();
  const channels247 = db.prepare('SELECT * FROM channels_247').all();
  const staticPrograms = db.prepare('SELECT * FROM epg_programs ORDER BY start_time ASC').all();

  const xml = ['<?xml version="1.0" encoding="UTF-8"?>'];
  xml.push('<tv generator-info-name="TVLister 24/7 Midnight Streamer Engine" generator-info-url="https://tvlister24-7.local">');

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

  // Dynamic 24/7 Channels EPG Schedule
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
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml.join('\n'));
});

// 3. Xtream / MidnightStreamer Compatible Player API (/player_api.php)
const handlePlayerApi = (req, res) => {
  const params = { ...req.query, ...req.body };
  const { username, password, action } = params;
  const auth = authenticateLine(username, password);
  if (auth.error) {
    return res.json({ user_info: { auth: 0, message: auth.error } });
  }

  const { line } = auth;
  const baseUrl = getBaseUrl(req);
  const parsedUrl = new URL(baseUrl);
  const { categories, streams, channels247, vodItems } = getAllowedContentForLine(line);
  const activeConns = db.prepare('SELECT COUNT(*) as c FROM active_connections WHERE line_id = ?').get(line.id).c;

  if (!action) {
    return res.json({
      user_info: {
        username: line.username,
        password: line.password,
        message: 'Bienvenido a TVLister 24/7 Midnight Streamer',
        auth: 1,
        status: 'Active',
        exp_date: line.exp_date ? String(Math.floor(new Date(line.exp_date).getTime() / 1000)) : null,
        is_trial: String(line.is_trial),
        active_cons: String(activeConns),
        created_at: String(Math.floor(new Date(line.created_at).getTime() / 1000 || Date.now() / 1000)),
        max_connections: String(line.max_connections),
        allowed_output_formats: ['m3u8', 'ts']
      },
      server_info: {
        url: parsedUrl.hostname,
        port: parsedUrl.port || '80',
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
    const liveCats = categories
      .filter((c) => c.type === 'live' || c.type === 'channel247')
      .map((c) => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
    return res.json(liveCats);
  }

  if (action === 'get_live_streams') {
    const out = [];
    let num = 1;
    for (const s of streams) {
      out.push({
        num: num++,
        name: s.name,
        stream_type: 'live',
        stream_id: s.id,
        stream_icon: s.logo_url || '',
        epg_channel_id: s.epg_channel_id || `stream-${s.id}`,
        added: String(Math.floor(Date.now() / 1000)),
        category_id: String(s.category_id || 1),
        tv_archive: s.tv_archive_days > 0 ? 1 : 0,
        tv_archive_duration: s.tv_archive_days
      });
    }
    for (const ch of channels247) {
      out.push({
        num: num++,
        name: `[24/7] ${ch.name}`,
        stream_type: 'live',
        stream_id: 10000 + ch.id,
        stream_icon: ch.logo_url || '',
        epg_channel_id: ch.epg_channel_id || `ch247-${ch.id}`,
        added: String(Math.floor(Date.now() / 1000)),
        category_id: String(ch.category_id || 4),
        tv_archive: 0,
        tv_archive_duration: 0
      });
    }
    return res.json(out);
  }

  if (action === 'get_vod_categories') {
    const vodCats = categories
      .filter((c) => c.type === 'vod')
      .map((c) => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
    return res.json(vodCats);
  }

  if (action === 'get_vod_streams') {
    return res.json(
      vodItems.map((v, idx) => ({
        num: idx + 1,
        name: v.title,
        stream_type: 'movie',
        stream_id: v.id,
        stream_icon: v.poster_url || '',
        rating: String(v.rating || 8.0),
        added: String(Math.floor(Date.now() / 1000)),
        category_id: String(v.category_id || 6),
        container_extension: v.container_ext || 'mp4'
      }))
    );
  }

  if (action === 'get_vod_info') {
    const vodId = Number(params.vod_id);
    const v = db.prepare('SELECT * FROM vod_items WHERE id = ?').get(vodId);
    if (!v) return res.json({ info: {}, movie_data: {} });
    return res.json({
      info: {
        movie_image: v.poster_url,
        plot: v.plot,
        genre: v.genre,
        releasedate: String(v.release_year),
        rating: String(v.rating),
        duration_secs: v.duration_sec
      },
      movie_data: {
        stream_id: v.id,
        name: v.title,
        container_extension: v.container_ext || 'mp4'
      }
    });
  }

  if (action === 'get_short_epg') {
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

// 4. Live Stream & 24/7 Channel Delivery (/live/:username/:password/:streamSpec)
iptvRouter.get('/live/:username/:password/:streamSpec', (req, res) => {
  const { username, password, streamSpec } = req.params;
  const auth = authenticateLine(username, password);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const rawId = streamSpec.replace(/\.(m3u8|ts)$/i, '');
  const protocol = streamSpec.toLowerCase().endsWith('.ts') ? 'MPEG-TS' : 'HLS';
  const numericId = Number(rawId);

  if (numericId > 10000 || rawId.startsWith('ch247_')) {
    const chId = rawId.startsWith('ch247_') ? Number(rawId.replace('ch247_', '')) : numericId - 10000;
    const ch = db.prepare('SELECT * FROM channels_247 WHERE id = ?').get(chId);
    if (!ch || ch.status !== 'running') {
      return res.status(404).send('Canal 24/7 fuera del aire');
    }
    const conn = recordConnection(req, auth.line, 'channel247', ch.id, ch.name, protocol);
    if (!conn.allowed) return res.status(429).send(conn.error);

    const state = computeChannel247LiveState(ch);
    if (!state.currentItem?.url) {
      return res.status(404).send('Playlist 24/7 vacía');
    }
    return res.redirect(302, state.currentItem.url);
  }

  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(numericId);
  if (!stream) return res.status(404).send('Canal no encontrado');
  if (stream.status === 'stopped') return res.status(503).send('Canal detenido por el administrador');

  // Auto-wake on-demand stream
  if (stream.status === 'ondemand_idle') {
    db.prepare("UPDATE streams SET status = 'running', uptime_started_at = datetime('now') WHERE id = ?").run(stream.id);
  }

  const conn = recordConnection(req, auth.line, 'live', stream.id, stream.name, protocol);
  if (!conn.allowed) return res.status(429).send(conn.error);

  return res.redirect(302, stream.source_url);
});

// 5. Movie VOD Delivery (/movie/:username/:password/:vodSpec)
iptvRouter.get('/movie/:username/:password/:vodSpec', (req, res) => {
  const { username, password, vodSpec } = req.params;
  const auth = authenticateLine(username, password);
  if (auth.error) return res.status(auth.code).send(auth.error);

  const vodId = Number(vodSpec.split('.')[0]);
  const vod = db.prepare('SELECT * FROM vod_items WHERE id = ?').get(vodId);
  if (!vod) return res.status(404).send('VOD no encontrado');

  const conn = recordConnection(req, auth.line, 'vod', vod.id, vod.title, 'VOD');
  if (!conn.allowed) return res.status(429).send(conn.error);

  return res.redirect(302, vod.source_url);
});

// 6. Built-in WebTV HTML5 Client Portal Endpoints (/api/webtv/*)
iptvRouter.post('/api/webtv/login', (req, res) => {
  const { username, password } = req.body || {};
  const auth = authenticateLine(username, password);
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
  const auth = authenticateLine(username, password);
  if (auth.error) return res.status(auth.code).json({ error: auth.error });

  const { categories, streams, channels247, vodItems } = getAllowedContentForLine(auth.line);
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
    vodItems,
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
  const auth = authenticateLine(username, password);
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
  const auth = authenticateLine(username, password);
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
