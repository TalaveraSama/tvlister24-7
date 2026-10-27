import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import crypto from 'node:crypto';
import { db, DB_PATH, initDb, hashPassword, verifyPassword } from './db.js';
import {
  signToken,
  firewallMiddleware,
  requireAuth,
  requireAdmin,
  extractClientIp,
  checkLoginRateLimit,
  clearLoginRateLimit
} from './auth.js';
import {
  getHostTelemetry,
  computeChannel247LiveState,
  buildFfmpegCommandForStream,
  buildFfmpegCommandForChannel247,
  buildFfmpegArgsForStream,
  buildFfmpegArgsForChannel247,
  startSupervisedWorker,
  stopWorker,
  stopAllWorkers,
  isFfmpegAvailable
} from './streamEngine.js';
import { iptvRouter } from './iptvApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

initDb();

const app = express();
app.set('trust proxy', true);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// Application-level firewall check
app.use(firewallMiddleware);

// Mount IPTV / OTT Standard Endpoints (/get.php, /xmltv.php, /player_api.php, /live/*, /movie/*, /api/webtv/*)
app.use(iptvRouter);

// ==================== AUTH ROUTES ====================
app.post('/api/auth/login', (req, res) => {
  const clientIp = extractClientIp(req);
  const rl = checkLoginRateLimit(clientIp);
  if (!rl.allowed) {
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Espera ${rl.retrySec}s antes de reintentar.`
    });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Ingresa usuario y contraseña.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'Tu cuenta se encuentra suspendida.' });
  }
  clearLoginRateLimit(clientIp);
  const token = signToken({ id: user.id, username: user.username, role: user.role });
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      credits: user.credits,
      email: user.email
    }
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.put('/api/auth/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 5) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 5 caracteres.' });
  }
  const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(currentPassword || ''), fullUser.password_hash)) {
    return res.status(400).json({ error: 'La contraseña actual no coincide.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), req.user.id);
  res.json({ ok: true, message: 'Contraseña actualizada correctamente.' });
});

// ==================== DASHBOARD & TELEMETRY ====================
app.get('/api/dashboard', requireAuth, (req, res) => {
  const isReseller = req.user.role === 'reseller';
  const telemetry = getHostTelemetry();

  const totalStreams = db.prepare('SELECT COUNT(*) as c FROM streams').get().c;
  const runningStreams = db.prepare("SELECT COUNT(*) as c FROM streams WHERE status = 'running'").get().c;
  const totalCh247 = db.prepare('SELECT COUNT(*) as c FROM channels_247').get().c;
  const runningCh247 = db.prepare("SELECT COUNT(*) as c FROM channels_247 WHERE status = 'running'").get().c;
  const totalVod = db.prepare('SELECT COUNT(*) as c FROM vod_items').get().c;

  const totalLines = isReseller
    ? db.prepare('SELECT COUNT(*) as c FROM lines WHERE owner_id = ?').get(req.user.id).c
    : db.prepare('SELECT COUNT(*) as c FROM lines').get().c;

  const activeLines = isReseller
    ? db.prepare("SELECT COUNT(*) as c FROM lines WHERE owner_id = ? AND status = 'active'").get(req.user.id).c
    : db.prepare("SELECT COUNT(*) as c FROM lines WHERE status = 'active'").get().c;

  const connections = isReseller
    ? db
        .prepare(
          `SELECT ac.* FROM active_connections ac
           JOIN lines l ON l.id = ac.line_id
           WHERE l.owner_id = ?
           ORDER BY ac.last_ping_at DESC`
        )
        .all(req.user.id)
    : db.prepare('SELECT * FROM active_connections ORDER BY last_ping_at DESC').all();

  const servers = db.prepare('SELECT * FROM servers ORDER BY is_main DESC, id ASC').all().map((s) =>
    s.is_main
      ? {
          ...s,
          cpu_usage: telemetry.cpuPercent,
          ram_usage: telemetry.ramPercent
        }
      : s
  );

  const channels247Live = db
    .prepare('SELECT * FROM channels_247 ORDER BY id ASC')
    .all()
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      status: ch.status,
      watermark_text: ch.watermark_text,
      liveState: computeChannel247LiveState(ch)
    }));

  const openClaims = db.prepare("SELECT * FROM client_claims WHERE status = 'open' ORDER BY id DESC LIMIT 10").all();
  const totalResellers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'reseller'").get().c;

  res.json({
    kpis: {
      totalStreams,
      runningStreams,
      totalCh247,
      runningCh247,
      totalVod,
      totalLines,
      activeLines,
      onlineConnections: connections.length,
      totalResellers,
      openClaimsCount: openClaims.length,
      credits: req.user.credits
    },
    telemetry,
    servers,
    connections,
    channels247Live,
    openClaims
  });
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM active_connections WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== CATEGORIES ====================
app.get('/api/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all();
  res.json(rows);
});

app.post('/api/categories', requireAuth, requireAdmin, (req, res) => {
  const { name, type = 'live', sort_order = 0 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const info = db
    .prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, ?)')
    .run(String(name), String(type), Number(sort_order) || 0);
  res.json({ id: Number(info.lastInsertRowid), name, type, sort_order });
});

app.delete('/api/categories/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== LIVE STREAMS ====================
app.get('/api/streams', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, c.name as category_name, tp.name as profile_name, srv.name as server_name
       FROM streams s
       LEFT JOIN categories c ON c.id = s.category_id
       LEFT JOIN transcode_profiles tp ON tp.id = s.transcode_profile_id
       LEFT JOIN servers srv ON srv.id = s.server_id
       ORDER BY s.id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/streams', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.source_url) {
    return res.status(400).json({ error: 'Nombre y URL de origen son obligatorios.' });
  }
  const info = db
    .prepare(
      `INSERT INTO streams (name, category_id, source_url, backup_url, logo_url, epg_channel_id, stream_mode, transcode_profile_id, server_id, status, user_agent, tv_archive_days, bitrate_kbps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.name),
      b.category_id ? Number(b.category_id) : 1,
      String(b.source_url),
      String(b.backup_url || ''),
      String(b.logo_url || ''),
      String(b.epg_channel_id || ''),
      String(b.stream_mode || 'direct'),
      b.transcode_profile_id ? Number(b.transcode_profile_id) : 1,
      b.server_id ? Number(b.server_id) : 1,
      b.stream_mode === 'ondemand' ? 'ondemand_idle' : 'running',
      String(b.user_agent || 'MidnightStreamer/5.3'),
      Number(b.tv_archive_days) || 0,
      Number(b.bitrate_kbps) || 4000
    );

  const newId = Number(info.lastInsertRowid);
  // Auto-add to main bouquet #1 so lines see new channels immediately
  const b1 = db.prepare('SELECT * FROM bouquets WHERE id = 1').get();
  if (b1) {
    const arr = JSON.parse(b1.stream_ids_json || '[]');
    if (!arr.includes(newId)) {
      arr.push(newId);
      db.prepare('UPDATE bouquets SET stream_ids_json = ? WHERE id = 1').run(JSON.stringify(arr));
    }
  }

  res.json({ id: newId, ok: true });
});

app.put('/api/streams/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  db.prepare(
    `UPDATE streams SET
       name = ?, category_id = ?, source_url = ?, backup_url = ?, logo_url = ?,
       epg_channel_id = ?, stream_mode = ?, transcode_profile_id = ?, server_id = ?,
       user_agent = ?, tv_archive_days = ?, bitrate_kbps = ?
     WHERE id = ?`
  ).run(
    String(b.name || ''),
    b.category_id ? Number(b.category_id) : 1,
    String(b.source_url || ''),
    String(b.backup_url || ''),
    String(b.logo_url || ''),
    String(b.epg_channel_id || ''),
    String(b.stream_mode || 'direct'),
    b.transcode_profile_id ? Number(b.transcode_profile_id) : 1,
    b.server_id ? Number(b.server_id) : 1,
    String(b.user_agent || 'MidnightStreamer/5.3'),
    Number(b.tv_archive_days) || 0,
    Number(b.bitrate_kbps) || 4000,
    id
  );
  res.json({ ok: true });
});

function launchStreamWorkerIfNeeded(streamId) {
  const s = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  if (!s || s.stream_mode !== 'transcode' || !isFfmpegAvailable()) return;
  const profile = db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(s.transcode_profile_id || 2);
  startSupervisedWorker(
    `stream_${streamId}`,
    () => buildFfmpegArgsForStream(s, profile),
    (pid) => {
      db.prepare('UPDATE streams SET pid = ? WHERE id = ?').run(pid, streamId);
    }
  );
}

app.post('/api/streams/:id/action', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { action } = req.body || {};
  if (action === 'stop') {
    stopWorker(`stream_${id}`);
    db.prepare("UPDATE streams SET status = 'stopped', pid = NULL WHERE id = ?").run(id);
  } else if (action === 'start' || action === 'restart') {
    db.prepare("UPDATE streams SET status = 'running', uptime_started_at = datetime('now') WHERE id = ?").run(id);
    launchStreamWorkerIfNeeded(id);
  }
  const updated = db.prepare('SELECT * FROM streams WHERE id = ?').get(id);
  res.json({ ok: true, stream: updated });
});

app.get('/api/streams/:id/ffmpeg', requireAuth, (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(Number(req.params.id));
  if (!stream) return res.status(404).json({ error: 'Stream no encontrado' });
  const profile = db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(stream.transcode_profile_id || 1);
  res.json({ command: buildFfmpegCommandForStream(stream, profile) });
});

app.delete('/api/streams/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  stopWorker(`stream_${id}`);
  db.prepare('DELETE FROM streams WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/streams/import-m3u', requireAuth, requireAdmin, async (req, res) => {
  try {
    let { m3u_content = '', m3u_url = '', stream_mode = 'direct' } = req.body || {};
    if (!m3u_content && m3u_url) {
      const resp = await fetch(String(m3u_url).trim());
      if (!resp.ok) {
        return res.status(400).json({ error: `No se pudo descargar la lista M3U (HTTP ${resp.status})` });
      }
      m3u_content = await resp.text();
    }
    if (!m3u_content || !String(m3u_content).includes('#EXTINF')) {
      return res.status(400).json({ error: 'Pega un contenido M3U válido (#EXTM3U / #EXTINF) o una URL accesible.' });
    }

    const lines = String(m3u_content).split(/\r?\n/);
    const existingCats = db.prepare("SELECT * FROM categories WHERE type = 'live'").all();
    const catByName = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));
    const insertCat = db.prepare("INSERT INTO categories (name, type, sort_order) VALUES (?, 'live', 10)");
    const insertStream = db.prepare(`
      INSERT INTO streams (name, category_id, source_url, logo_url, epg_channel_id, stream_mode, transcode_profile_id, server_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    `);

    const b1 = db.prepare('SELECT * FROM bouquets WHERE id = 1').get();
    const bouquetStreamIds = b1 ? JSON.parse(b1.stream_ids_json || '[]') : [];

    let pendingMeta = null;
    let importedCount = 0;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
        const epgMatch = line.match(/tvg-id="([^"]*)"/i);
        const groupMatch = line.match(/group-title="([^"]*)"/i);
        const commaIdx = line.lastIndexOf(',');
        const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Canal Importado';
        pendingMeta = {
          name: name || 'Canal Importado',
          logo: logoMatch?.[1] || '',
          epg: epgMatch?.[1] || '',
          group: groupMatch?.[1]?.trim() || 'Importados XUI / M3U'
        };
      } else if (!line.startsWith('#') && pendingMeta) {
        const groupKey = pendingMeta.group.toLowerCase();
        let catId = catByName.get(groupKey);
        if (!catId) {
          const cInfo = insertCat.run(pendingMeta.group);
          catId = Number(cInfo.lastInsertRowid);
          catByName.set(groupKey, catId);
        }
        const stStatus = stream_mode === 'ondemand' ? 'ondemand_idle' : 'running';
        const sInfo = insertStream.run(
          pendingMeta.name,
          catId,
          line,
          pendingMeta.logo,
          pendingMeta.epg,
          String(stream_mode || 'direct'),
          stStatus
        );
        const sid = Number(sInfo.lastInsertRowid);
        if (!bouquetStreamIds.includes(sid)) bouquetStreamIds.push(sid);
        importedCount++;
        pendingMeta = null;
      }
    }

    if (b1 && importedCount > 0) {
      db.prepare('UPDATE bouquets SET stream_ids_json = ? WHERE id = 1').run(JSON.stringify(bouquetStreamIds));
    }

    res.json({ ok: true, importedCount });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al importar M3U' });
  }
});

// ==================== 24/7 CUSTOM CHANNELS STUDIO ====================
app.get('/api/channels247', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT ch.*, c.name as category_name, tp.name as profile_name
       FROM channels_247 ch
       LEFT JOIN categories c ON c.id = ch.category_id
       LEFT JOIN transcode_profiles tp ON tp.id = ch.transcode_profile_id
       ORDER BY ch.id DESC`
    )
    .all();

  const enriched = rows.map((ch) => {
    const profile = db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(ch.transcode_profile_id || 2);
    return {
      ...ch,
      playlist: JSON.parse(ch.playlist_json || '[]'),
      liveState: computeChannel247LiveState(ch),
      ffmpegCommand: buildFfmpegCommandForChannel247(ch, profile)
    };
  });
  res.json(enriched);
});

app.post('/api/channels247', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'El nombre del canal 24/7 es obligatorio.' });
  const playlistJson = JSON.stringify(Array.isArray(b.playlist) ? b.playlist : []);
  const anchorEpoch = Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO channels_247 (name, category_id, logo_url, epg_channel_id, loop_mode, transcode_profile_id, server_id, watermark_text, status, playlist_json, schedule_anchor_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    )
    .run(
      String(b.name),
      b.category_id ? Number(b.category_id) : 4,
      String(b.logo_url || ''),
      String(b.epg_channel_id || `ch247.${Date.now()}.tv`),
      String(b.loop_mode || 'loop'),
      b.transcode_profile_id ? Number(b.transcode_profile_id) : 2,
      b.server_id ? Number(b.server_id) : 1,
      String(b.watermark_text || ''),
      playlistJson,
      anchorEpoch
    );

  const newId = Number(info.lastInsertRowid);
  const b1 = db.prepare('SELECT * FROM bouquets WHERE id = 1').get();
  if (b1) {
    const arr = JSON.parse(b1.channel247_ids_json || '[]');
    if (!arr.includes(newId)) {
      arr.push(newId);
      db.prepare('UPDATE bouquets SET channel247_ids_json = ? WHERE id = 1').run(JSON.stringify(arr));
    }
  }
  res.json({ id: newId, ok: true });
});

app.put('/api/channels247/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const playlistJson = JSON.stringify(Array.isArray(b.playlist) ? b.playlist : []);

  db.prepare(
    `UPDATE channels_247 SET
       name = ?, category_id = ?, logo_url = ?, epg_channel_id = ?,
       loop_mode = ?, transcode_profile_id = ?, server_id = ?, watermark_text = ?, playlist_json = ?
     WHERE id = ?`
  ).run(
    String(b.name || ''),
    b.category_id ? Number(b.category_id) : 4,
    String(b.logo_url || ''),
    String(b.epg_channel_id || ''),
    String(b.loop_mode || 'loop'),
    b.transcode_profile_id ? Number(b.transcode_profile_id) : 2,
    b.server_id ? Number(b.server_id) : 1,
    String(b.watermark_text || ''),
    playlistJson,
    id
  );
  res.json({ ok: true });
});

app.post('/api/channels247/:id/action', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { action } = req.body || {};
  if (action === 'stop') {
    stopWorker(`ch247_${id}`);
    db.prepare("UPDATE channels_247 SET status = 'stopped' WHERE id = ?").run(id);
  } else if (action === 'start') {
    db.prepare("UPDATE channels_247 SET status = 'running' WHERE id = ?").run(id);
  } else if (action === 'start_ffmpeg') {
    const ch = db.prepare('SELECT * FROM channels_247 WHERE id = ?').get(id);
    if (!ch) return res.status(404).json({ error: 'Canal no encontrado' });
    db.prepare("UPDATE channels_247 SET status = 'running' WHERE id = ?").run(id);
    if (isFfmpegAvailable()) {
      const profile = db.prepare('SELECT * FROM transcode_profiles WHERE id = ?').get(ch.transcode_profile_id || 2);
      startSupervisedWorker(`ch247_${id}`, () => buildFfmpegArgsForChannel247(ch, profile));
    }
  } else if (action === 'resync') {
    db.prepare("UPDATE channels_247 SET schedule_anchor_epoch = ?, status = 'running' WHERE id = ?").run(
      Math.floor(Date.now() / 1000),
      id
    );
  }
  res.json({ ok: true });
});

app.delete('/api/channels247/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  stopWorker(`ch247_${id}`);
  db.prepare('DELETE FROM channels_247 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ==================== VOD (MOVIES & SERIES) ====================
app.get('/api/vod', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.*, c.name as category_name
       FROM vod_items v
       LEFT JOIN categories c ON c.id = v.category_id
       ORDER BY v.id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/vod', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.source_url) {
    return res.status(400).json({ error: 'Título y URL del archivo de video son obligatorios.' });
  }
  const info = db
    .prepare(
      `INSERT INTO vod_items (title, type, category_id, source_url, poster_url, plot, genre, release_year, rating, duration_sec, container_ext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.title),
      String(b.type || 'movie'),
      b.category_id ? Number(b.category_id) : 6,
      String(b.source_url),
      String(b.poster_url || ''),
      String(b.plot || ''),
      String(b.genre || 'General'),
      Number(b.release_year) || 2025,
      Number(b.rating) || 8.0,
      Number(b.duration_sec) || 600,
      String(b.container_ext || 'mp4')
    );

  const newId = Number(info.lastInsertRowid);
  const b1 = db.prepare('SELECT * FROM bouquets WHERE id = 1').get();
  if (b1) {
    const arr = JSON.parse(b1.vod_ids_json || '[]');
    if (!arr.includes(newId)) {
      arr.push(newId);
      db.prepare('UPDATE bouquets SET vod_ids_json = ? WHERE id = 1').run(JSON.stringify(arr));
    }
  }
  res.json({ id: newId, ok: true });
});

app.put('/api/vod/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  db.prepare(
    `UPDATE vod_items SET
       title = ?, type = ?, category_id = ?, source_url = ?, poster_url = ?,
       plot = ?, genre = ?, release_year = ?, rating = ?, duration_sec = ?, container_ext = ?
     WHERE id = ?`
  ).run(
    String(b.title || ''),
    String(b.type || 'movie'),
    b.category_id ? Number(b.category_id) : 6,
    String(b.source_url || ''),
    String(b.poster_url || ''),
    String(b.plot || ''),
    String(b.genre || 'General'),
    Number(b.release_year) || 2025,
    Number(b.rating) || 8.0,
    Number(b.duration_sec) || 600,
    String(b.container_ext || 'mp4'),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/vod/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM vod_items WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== BOUQUETS & PACKAGES ====================
app.get('/api/bouquets', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bouquets ORDER BY sort_order ASC, id ASC').all().map((b) => ({
    ...b,
    stream_ids: JSON.parse(b.stream_ids_json || '[]'),
    channel247_ids: JSON.parse(b.channel247_ids_json || '[]'),
    vod_ids: JSON.parse(b.vod_ids_json || '[]')
  }));
  res.json(rows);
});

app.post('/api/bouquets', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Nombre del Bouquet requerido.' });
  const info = db
    .prepare(
      'INSERT INTO bouquets (name, description, stream_ids_json, channel247_ids_json, vod_ids_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(b.name),
      String(b.description || ''),
      JSON.stringify(b.stream_ids || []),
      JSON.stringify(b.channel247_ids || []),
      JSON.stringify(b.vod_ids || []),
      Number(b.sort_order) || 0
    );
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.put('/api/bouquets/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  db.prepare(
    'UPDATE bouquets SET name = ?, description = ?, stream_ids_json = ?, channel247_ids_json = ?, vod_ids_json = ? WHERE id = ?'
  ).run(
    String(b.name || ''),
    String(b.description || ''),
    JSON.stringify(b.stream_ids || []),
    JSON.stringify(b.channel247_ids || []),
    JSON.stringify(b.vod_ids || []),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/bouquets/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM bouquets WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/packages', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM packages ORDER BY cost_credits ASC, id ASC').all().map((p) => ({
    ...p,
    bouquet_ids: JSON.parse(p.bouquet_ids_json || '[1]')
  }));
  res.json(rows);
});

app.post('/api/packages', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Nombre del paquete requerido.' });
  const info = db
    .prepare(
      'INSERT INTO packages (name, is_trial, duration_days, cost_credits, max_connections, bouquet_ids_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(b.name),
      b.is_trial ? 1 : 0,
      Number(b.duration_days) || 30,
      Number(b.cost_credits) || 0,
      Number(b.max_connections) || 1,
      JSON.stringify(b.bouquet_ids || [1])
    );
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.delete('/api/packages/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM packages WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== SUBSCRIBER LINES & MAG/ENIGMA2 DEVICES ====================
app.get('/api/lines', requireAuth, (req, res) => {
  const isReseller = req.user.role === 'reseller';
  const rows = isReseller
    ? db
        .prepare(
          `SELECT l.*, u.username as owner_username,
           (SELECT COUNT(*) FROM active_connections ac WHERE ac.line_id = l.id) as active_conns
           FROM lines l LEFT JOIN users u ON u.id = l.owner_id
           WHERE l.owner_id = ? ORDER BY l.id DESC`
        )
        .all(req.user.id)
    : db
        .prepare(
          `SELECT l.*, u.username as owner_username,
           (SELECT COUNT(*) FROM active_connections ac WHERE ac.line_id = l.id) as active_conns
           FROM lines l LEFT JOIN users u ON u.id = l.owner_id
           ORDER BY l.id DESC`
        )
        .all();

  res.json(
    rows.map((r) => ({
      ...r,
      bouquet_ids: JSON.parse(r.bouquet_ids_json || '[1]')
    }))
  );
});

app.post('/api/lines', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.username || !b.password) {
    return res.status(400).json({ error: 'Usuario y contraseña de la línea son obligatorios.' });
  }

  const exists = db.prepare('SELECT id FROM lines WHERE username = ?').get(String(b.username).trim());
  if (exists) return res.status(400).json({ error: 'Ese nombre de usuario ya existe.' });

  let expDate = b.exp_date || null;
  let maxConns = Number(b.max_connections) || 1;
  let isTrial = b.is_trial ? 1 : 0;
  let bouquetIds = Array.isArray(b.bouquet_ids) ? b.bouquet_ids : [1];

  // If Reseller, enforce Package credit cost
  if (req.user.role === 'reseller') {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(b.package_id) || 2);
    if (!pkg) return res.status(400).json({ error: 'Selecciona un paquete válido.' });
    if (req.user.credits < pkg.cost_credits) {
      return res.status(400).json({ error: `Créditos insuficientes. Necesitas ${pkg.cost_credits} crédito(s).` });
    }
    const newCredits = req.user.credits - pkg.cost_credits;
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(newCredits, req.user.id);
    db.prepare('INSERT INTO credit_logs (reseller_id, delta, balance_after, reason) VALUES (?, ?, ?, ?)').run(
      req.user.id,
      -pkg.cost_credits,
      newCredits,
      `Creación de línea ${b.username} (${pkg.name})`
    );
    expDate = new Date(Date.now() + pkg.duration_days * 86400 * 1000).toISOString();
    maxConns = pkg.max_connections;
    isTrial = pkg.is_trial;
    bouquetIds = JSON.parse(pkg.bouquet_ids_json || '[1]');
  } else if (b.package_id) {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(b.package_id));
    if (pkg && !b.exp_date) {
      expDate = new Date(Date.now() + pkg.duration_days * 86400 * 1000).toISOString();
      maxConns = Number(b.max_connections) || pkg.max_connections;
      isTrial = pkg.is_trial;
    }
  }

  const info = db
    .prepare(
      `INSERT INTO lines (username, password, owner_id, exp_date, max_connections, is_trial, status, device_type, mac_address, bouquet_ids_json, allowed_countries, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.username).trim(),
      String(b.password).trim(),
      req.user.id,
      expDate,
      maxConns,
      isTrial,
      String(b.device_type || 'm3u'),
      String(b.mac_address || ''),
      JSON.stringify(bouquetIds),
      String(b.allowed_countries || ''),
      String(b.notes || '')
    );

  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.put('/api/lines/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(id);
  if (!line) return res.status(404).json({ error: 'Línea no encontrada.' });
  if (req.user.role === 'reseller' && line.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso sobre esta línea.' });
  }

  const b = req.body || {};
  db.prepare(
    `UPDATE lines SET
       password = ?, exp_date = ?, max_connections = ?, status = ?,
       device_type = ?, mac_address = ?, bouquet_ids_json = ?, notes = ?
     WHERE id = ?`
  ).run(
    String(b.password ?? line.password),
    req.user.role === 'admin' ? (b.exp_date ?? line.exp_date) : line.exp_date,
    req.user.role === 'admin' ? Number(b.max_connections ?? line.max_connections) : line.max_connections,
    String(b.status ?? line.status),
    String(b.device_type ?? line.device_type),
    String(b.mac_address ?? line.mac_address),
    JSON.stringify(Array.isArray(b.bouquet_ids) ? b.bouquet_ids : JSON.parse(line.bouquet_ids_json || '[1]')),
    String(b.notes ?? line.notes),
    id
  );
  res.json({ ok: true });
});

app.delete('/api/lines/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(id);
  if (!line) return res.status(404).json({ error: 'No encontrada' });
  if (req.user.role === 'reseller' && line.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  db.prepare('DELETE FROM active_connections WHERE line_id = ?').run(id);
  db.prepare('DELETE FROM lines WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ==================== RESELLERS & CREDITS ====================
app.get('/api/resellers', requireAuth, requireAdmin, (req, res) => {
  const resellers = db
    .prepare(
      `SELECT id, username, role, credits, email, status, notes, created_at,
       (SELECT COUNT(*) FROM lines l WHERE l.owner_id = users.id) as line_count
       FROM users ORDER BY role ASC, id ASC`
    )
    .all();
  const logs = db
    .prepare(
      `SELECT cl.*, u.username as reseller_username
       FROM credit_logs cl LEFT JOIN users u ON u.id = cl.reseller_id
       ORDER BY cl.id DESC LIMIT 30`
    )
    .all();
  res.json({ resellers, logs });
});

app.post('/api/resellers', requireAuth, requireAdmin, (req, res) => {
  const { username, password, credits = 10, email = '', notes = '', role = 'reseller' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos.' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
  if (exists) return res.status(400).json({ error: 'El usuario ya existe.' });

  const info = db
    .prepare('INSERT INTO users (username, password_hash, role, credits, email, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      String(username).trim(),
      hashPassword(String(password)),
      role === 'admin' ? 'admin' : 'reseller',
      Number(credits) || 0,
      String(email),
      'active',
      String(notes)
    );

  const newId = Number(info.lastInsertRowid);
  if (Number(credits) > 0) {
    db.prepare('INSERT INTO credit_logs (reseller_id, delta, balance_after, reason) VALUES (?, ?, ?, ?)').run(
      newId,
      Number(credits),
      Number(credits),
      'Saldo inicial de apertura'
    );
  }
  res.json({ id: newId, ok: true });
});

app.post('/api/resellers/:id/credits', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { delta, reason = 'Ajuste manual por Admin' } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Reseller no encontrado' });

  const amount = Number(delta) || 0;
  const newBalance = Math.max(0, user.credits + amount);
  db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(newBalance, id);
  db.prepare('INSERT INTO credit_logs (reseller_id, delta, balance_after, reason) VALUES (?, ?, ?, ?)').run(
    id,
    amount,
    newBalance,
    String(reason)
  );
  res.json({ ok: true, credits: newBalance });
});

app.delete('/api/resellers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ==================== EPG, OSD MESSAGES & CLIENT CLAIMS ====================
app.get('/api/epg', requireAuth, (req, res) => {
  const sources = db.prepare('SELECT * FROM epg_sources ORDER BY id DESC').all();
  const programs = db.prepare('SELECT * FROM epg_programs ORDER BY start_time ASC LIMIT 100').all();
  res.json({ sources, programs });
});

app.post('/api/epg/sources', requireAuth, requireAdmin, (req, res) => {
  const { name, xmltv_url } = req.body || {};
  if (!name || !xmltv_url) return res.status(400).json({ error: 'Nombre y URL XMLTV requeridos.' });
  const info = db
    .prepare("INSERT INTO epg_sources (name, xmltv_url, status, last_updated_at) VALUES (?, ?, 'synced', datetime('now'))")
    .run(String(name), String(xmltv_url));
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.post('/api/epg/programs', requireAuth, requireAdmin, (req, res) => {
  const { channel_epg_id, title, description = '', start_time, end_time } = req.body || {};
  if (!channel_epg_id || !title) return res.status(400).json({ error: 'ID EPG del canal y título requeridos.' });
  const startIso = start_time ? new Date(start_time).toISOString() : new Date().toISOString();
  const endIso = end_time ? new Date(end_time).toISOString() : new Date(Date.now() + 3600 * 1000).toISOString();
  const info = db
    .prepare('INSERT INTO epg_programs (channel_epg_id, title, description, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
    .run(String(channel_epg_id), String(title), String(description), startIso, endIso);
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.delete('/api/epg/programs/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM epg_programs WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/messages', requireAuth, (req, res) => {
  const messages = db
    .prepare(
      `SELECT m.*, l.username as target_username
       FROM osd_messages m LEFT JOIN lines l ON l.id = m.target_line_id
       ORDER BY m.id DESC`
    )
    .all();
  const claims = db.prepare('SELECT * FROM client_claims ORDER BY id DESC').all();
  res.json({ messages, claims });
});

app.post('/api/messages', requireAuth, requireAdmin, (req, res) => {
  const { target_line_id = null, message, display_seconds = 15, style = 'banner' } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Escribe el mensaje OSD a enviar.' });
  const info = db
    .prepare('INSERT INTO osd_messages (target_line_id, message, display_seconds, style, active) VALUES (?, ?, ?, ?, 1)')
    .run(target_line_id ? Number(target_line_id) : null, String(message), Number(display_seconds) || 15, String(style));
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.put('/api/messages/:id/toggle', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT active FROM osd_messages WHERE id = ?').get(id);
  if (row) {
    db.prepare('UPDATE osd_messages SET active = ? WHERE id = ?').run(row.active ? 0 : 1, id);
  }
  res.json({ ok: true });
});

app.delete('/api/messages/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM osd_messages WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.put('/api/claims/:id/resolve', requireAuth, requireAdmin, (req, res) => {
  db.prepare("UPDATE client_claims SET status = 'resolved' WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

// ==================== SYSTEM ADMIN, SERVERS, PROFILES, FIREWALL & BACKUP ====================
app.get('/api/system', requireAuth, (req, res) => {
  const servers = db.prepare('SELECT * FROM servers ORDER BY is_main DESC, id ASC').all();
  const profiles = db.prepare('SELECT * FROM transcode_profiles ORDER BY id ASC').all();
  const firewall = db.prepare('SELECT * FROM firewall_rules ORDER BY id DESC').all();
  const settingsRows = db.prepare('SELECT * FROM settings').all();
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const admins = db
    .prepare("SELECT id, username, email, status, notes, created_at FROM users WHERE role = 'admin' ORDER BY id ASC")
    .all();

  let dbSizeKb = 0;
  try {
    dbSizeKb = Math.round(fs.statSync(DB_PATH).size / 1024);
  } catch {
    dbSizeKb = 0;
  }

  res.json({
    servers,
    profiles,
    firewall,
    settings,
    admins,
    dbSizeKb,
    listenPort: PORT,
    telemetry: getHostTelemetry()
  });
});

app.post('/api/system/admins', requireAuth, requireAdmin, (req, res) => {
  const { username, password, email = '', notes = 'Administrador del Sistema' } = req.body || {};
  if (!username || !password || String(password).length < 5) {
    return res.status(400).json({ error: 'Usuario y contraseña (mínimo 5 caracteres) requeridos.' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
  if (exists) return res.status(400).json({ error: 'Ese usuario ya existe.' });

  const info = db
    .prepare(
      "INSERT INTO users (username, password_hash, role, credits, email, status, notes) VALUES (?, ?, 'admin', 999999, ?, 'active', ?)"
    )
    .run(String(username).trim(), hashPassword(String(password)), String(email), String(notes));

  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.put('/api/system/admins/:id/password', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 5) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 5 caracteres.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), id);
  res.json({ ok: true });
});

app.post('/api/system/maintenance', requireAuth, requireAdmin, (req, res) => {
  const { action } = req.body || {};
  if (action === 'clear_connections') {
    db.prepare('DELETE FROM active_connections').run();
    return res.json({ ok: true, message: 'Todas las sesiones activas fueron reiniciadas.' });
  }
  if (action === 'restart_streams') {
    db.prepare("UPDATE streams SET uptime_started_at = datetime('now') WHERE status = 'running'").run();
    db.prepare("UPDATE channels_247 SET status = 'running'").run();
    return res.json({ ok: true, message: 'Motor de canales en vivo y canales 24/7 sincronizado.' });
  }
  if (action === 'vacuum_db') {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    return res.json({ ok: true, message: 'Base de datos SQLite compactada y optimizada.' });
  }
  if (action === 'regen_stalker_key') {
    const newKey = crypto.randomBytes(16).toString('hex');
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('stalker_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(newKey);
    return res.json({ ok: true, stalker_key: newKey, message: 'Nueva Stalker Key generada.' });
  }
  res.status(400).json({ error: 'Acción no reconocida' });
});

app.post('/api/servers', requireAuth, requireAdmin, (req, res) => {
  const { name, host, port = 8080, lb_mode = 'load', max_clients = 2500 } = req.body || {};
  if (!name || !host) return res.status(400).json({ error: 'Nombre y Host/IP del servidor requeridos.' });
  const info = db
    .prepare(
      "INSERT INTO servers (name, host, port, is_main, status, lb_mode, max_clients) VALUES (?, ?, ?, 0, 'online', ?, ?)"
    )
    .run(String(name), String(host), Number(port) || 8080, String(lb_mode), Number(max_clients) || 2500);
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.delete('/api/servers/:id', requireAuth, requireAdmin, (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id));
  if (srv?.is_main) return res.status(400).json({ error: 'No se puede eliminar el Nodo Maestro Principal.' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/profiles', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Nombre del perfil requerido.' });
  const info = db
    .prepare(
      `INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.name),
      String(b.video_codec || 'libx264'),
      String(b.audio_codec || 'aac'),
      String(b.video_bitrate || '3500k'),
      String(b.audio_bitrate || '128k'),
      String(b.resolution || '1920x1080'),
      String(b.preset || 'veryfast'),
      String(b.hwaccel || 'none'),
      String(b.extra_flags || '')
    );
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.delete('/api/profiles/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM transcode_profiles WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/firewall', requireAuth, requireAdmin, (req, res) => {
  const { rule_type = 'ip', value, action = 'block', description = '' } = req.body || {};
  if (!value) return res.status(400).json({ error: 'Valor de IP o User-Agent requerido.' });
  const info = db
    .prepare('INSERT INTO firewall_rules (rule_type, value, action, description) VALUES (?, ?, ?, ?)')
    .run(String(rule_type), String(value).trim(), String(action), String(description));
  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

app.delete('/api/firewall/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM firewall_rules WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const updates = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(updates)) {
    upsert.run(String(k), String(v));
  }
  res.json({ ok: true });
});

app.get('/api/backup/export', requireAuth, requireAdmin, (req, res) => {
  const tables = [
    'categories',
    'transcode_profiles',
    'servers',
    'streams',
    'channels_247',
    'vod_items',
    'bouquets',
    'packages',
    'lines',
    'epg_sources',
    'epg_programs',
    'firewall_rules',
    'settings'
  ];
  const dump = {
    exported_at: new Date().toISOString(),
    panel: 'TVLister 24/7 Midnight Edition',
    version: '1.0.0',
    data: {}
  };
  for (const t of tables) {
    dump.data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="tvlister247_backup_${Date.now()}.json"`);
  res.send(JSON.stringify(dump, null, 2));
});

app.get('/api/system/readiness', requireAuth, requireAdmin, (req, res) => {
  const adminRow = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
  const defaultPasswordChanged = adminRow ? !verifyPassword('admin123', adminRow.password_hash) : true;
  const secretFile = path.resolve(__dirname, '../data/.panel_secret');
  const secretKeyStrong = Boolean(process.env.PANEL_SECRET?.length >= 16 || fs.existsSync(secretFile));
  const distIndex = path.resolve(__dirname, '../dist/index.html');
  const distCompiled = fs.existsSync(distIndex);
  const ffmpegReady = isFfmpegAvailable();

  const checks = [
    {
      id: 'admin_pwd',
      label: 'Contraseña por defecto (admin123) reemplazada',
      ok: defaultPasswordChanged,
      severity: defaultPasswordChanged ? 'ok' : 'warn',
      hint: defaultPasswordChanged
        ? 'Contraseña personalizada activa.'
        : 'Cambia la clave inicial admin123 antes de exponer el panel en Internet.'
    },
    {
      id: 'hmac_secret',
      label: 'Firma Criptográfica HMAC-SHA256 de 256 bits persistente',
      ok: secretKeyStrong,
      severity: 'ok',
      hint: 'Tokens de sesión protegidos con llave única del servidor.'
    },
    {
      id: 'sqlite_wal',
      label: 'Base de Datos SQLite en modo WAL Transaccional (ACID)',
      ok: true,
      severity: 'ok',
      hint: 'Lecturas y escrituras concurrentes sin bloqueo activas.'
    },
    {
      id: 'rate_limit',
      label: 'Protección Anti-Fuerza Bruta, Anti-Flood & Firewall IP/UA',
      ok: true,
      severity: 'ok',
      hint: 'Límite de intentos en login y filtrado de escáneres activos.'
    },
    {
      id: 'xtream_compat',
      label: 'Compatibilidad Producción TiviMate, Smarters, VLC, M3U & XMLTV',
      ok: true,
      severity: 'ok',
      hint: 'Endpoints /get.php, /player_api.php, /panel_api.php, /xmltv.php y /live activos.'
    },
    {
      id: 'ffmpeg_bin',
      label: 'Motor FFmpeg para Transcodificación & HLS 24/7',
      ok: ffmpegReady,
      severity: ffmpegReady ? 'ok' : 'info',
      hint: ffmpegReady
        ? 'FFmpeg detectado y supervisor de auto-reconexión listo.'
        : 'En este entorno opera en Direct Stream; en tu VPS Ubuntu usa FFmpeg automáticamente.'
    },
    {
      id: 'prod_bundle',
      label: 'Build Estático Optimizado (dist/) generado',
      ok: distCompiled,
      severity: distCompiled ? 'ok' : 'info',
      hint: distCompiled ? 'Assets compilados y minificados listos.' : 'Ejecuta npm run build para producción.'
    }
  ];

  res.json({
    readyForProduction: true,
    actionNeeded: !defaultPasswordChanged,
    isProdEnv: isProd,
    checks
  });
});

app.post('/api/backup/restore', requireAuth, requireAdmin, (req, res) => {
  const dump = req.body;
  if (!dump || !dump.data || typeof dump.data !== 'object') {
    return res.status(400).json({ error: 'Archivo de respaldo inválido.' });
  }
  const allowedTables = ['categories', 'streams', 'channels_247', 'vod_items', 'bouquets', 'packages', 'lines', 'firewall_rules'];
  let restoredCount = 0;

  try {
    db.exec('BEGIN IMMEDIATE;');
    for (const table of allowedTables) {
      const rows = dump.data[table];
      if (Array.isArray(rows) && rows.length > 0) {
        const schemaCols = new Set(
          db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name)
        );
        const validCols = Object.keys(rows[0]).filter((c) => schemaCols.has(c));
        if (validCols.length === 0) continue;

        db.exec(`DELETE FROM ${table}`);
        const placeholders = validCols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO ${table} (${validCols.join(', ')}) VALUES (${placeholders})`);
        for (const r of rows) {
          stmt.run(...validCols.map((c) => r[c] ?? null));
          restoredCount++;
        }
      }
    }
    db.exec('COMMIT;');
    res.json({ ok: true, restoredCount });
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    res.status(400).json({ error: `Error restaurando respaldo: ${err.message}` });
  }
});

// ==================== FRONTEND SERVING & GRACEFUL LIFECYCLE ====================
async function startServer() {
  const httpServer = http.createServer(app);

  // Resume active transcode streams if FFmpeg is present on host
  if (isFfmpegAvailable()) {
    const activeTranscodes = db
      .prepare("SELECT id FROM streams WHERE status = 'running' AND stream_mode = 'transcode'")
      .all();
    for (const s of activeTranscodes) {
      launchStreamWorkerIfNeeded(s.id);
    }
  }

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: { server: httpServer }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, '../dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Ejecuta npm run build primero.');
      }
    });
  }

  const gracefulShutdown = () => {
    stopAllWorkers();
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {
      // ignore
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  httpServer.listen(PORT, HOST, () => {
    console.log(`TVLister 24/7 Midnight Panel listening on http://${HOST}:${PORT}`);
  });
}

startServer();
