import express from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';

export const stalkerRouter = express.Router();

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || req.protocol || 'http';
  const host = req.headers['x-forwarded-host']?.split(',')[0]?.trim() || req.headers.host || 'localhost:8080';
  return `${proto}://${host}`;
}

function extractStbMac(req) {
  const qMac = req.query.mac || req.body?.mac;
  if (qMac) return decodeURIComponent(String(qMac)).trim().toUpperCase();

  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)mac=([^;]+)/i);
  if (match) {
    return decodeURIComponent(match[1]).trim().toUpperCase();
  }
  return '';
}

function findLineForStb(req) {
  const mac = extractStbMac(req);
  if (mac) {
    const byMac = db
      .prepare("SELECT * FROM lines WHERE UPPER(mac_address) = ? AND status = 'active'")
      .get(mac);
    if (byMac) {
      if (!byMac.exp_date || new Date(byMac.exp_date).getTime() >= Date.now()) {
        return byMac;
      }
    }
  }
  // Fallback via Bearer token encoded as stb_<lineId>_<sig>
  const auth = req.headers.authorization || '';
  const m = auth.match(/Bearer\s+stb_(\d+)_/i);
  if (m) {
    const byId = db.prepare("SELECT * FROM lines WHERE id = ? AND status = 'active'").get(Number(m[1]));
    if (byId) return byId;
  }
  return null;
}

function getStbAllowedCatalog(line) {
  let bIds = [];
  try {
    bIds = JSON.parse(line.bouquet_ids_json || '[1]');
  } catch {
    bIds = [1];
  }
  const bouquets = db.prepare('SELECT * FROM bouquets').all();
  const matched = bIds.length > 0 ? bouquets.filter((b) => bIds.includes(b.id)) : bouquets;
  const sSet = new Set();
  const cSet = new Set();
  const vSet = new Set();

  for (const b of matched) {
    try {
      JSON.parse(b.stream_ids_json || '[]').forEach((x) => sSet.add(Number(x)));
      JSON.parse(b.channel247_ids_json || '[]').forEach((x) => cSet.add(Number(x)));
      JSON.parse(b.vod_ids_json || '[]').forEach((x) => vSet.add(Number(x)));
    } catch {
      // ignore
    }
  }

  const allStreams = db.prepare('SELECT * FROM streams ORDER BY id ASC').all();
  const allCh247 = db.prepare('SELECT * FROM channels_247 ORDER BY id ASC').all();
  const allVods = db.prepare('SELECT * FROM vod_items ORDER BY id ASC').all();

  return {
    streams: sSet.size > 0 ? allStreams.filter((s) => sSet.has(s.id)) : allStreams,
    channels247: cSet.size > 0 ? allCh247.filter((c) => cSet.has(c.id)) : allCh247,
    vods: vSet.size > 0 ? allVods.filter((v) => vSet.has(v.id)) : allVods
  };
}

// Portal HTML Landing for MAG WebKit / Browser Diagnostics (/c/ and /stalker_portal/c/)
const renderPortalLanding = (req, res) => {
  const baseUrl = getBaseUrl(req);
  const mac = extractStbMac(req) || '00:1A:79:4B:88:10';
  const matchedLine = db.prepare('SELECT username, exp_date, status FROM lines WHERE UPPER(mac_address) = ?').get(mac);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>TVLister 24/7 — Stalker / Ministra MAG Portal</title>
  <style>
    body { background:#070b14; color:#e2e8f0; font-family:system-ui,sans-serif; margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .box { max-width:620px; background:#0e1526; border:1px solid #1e293b; border-radius:16px; padding:28px; box-shadow:0 20px 50px rgba(0,0,0,.6); }
    h1 { margin:0 0 8px; font-size:20px; color:#fff; }
    .badge { display:inline-block; padding:4px 10px; border-radius:999px; background:#10b98122; color:#34d399; border:1px solid #10b98144; font-size:12px; font-weight:700; margin-bottom:14px; }
    code { background:#090e1a; padding:3px 7px; border-radius:6px; color:#818cf8; font-size:13px; }
    .meta { background:#090e1a; border:1px solid #1e293b; border-radius:12px; padding:14px; margin-top:14px; font-size:13px; line-height:1.7; }
    a { color:#38bdf8; text-decoration:none; font-weight:600; }
  </style>
</head>
<body>
  <div class="box">
    <span class="badge">● STALKER / MINISTRA MIDDLEWARE ACTIVO</span>
    <h1>TVLister 24/7 — MAG STB Portal (/c/)</h1>
    <p style="font-size:13px;color:#94a3b8;">Configura esta URL como <strong>Portal 1 URL</strong> en tu decodificador MAG (250/254/322/420/520), Formuler o emulador STBemu:</p>
    <div class="meta">
      <div><strong>Portal URL:</strong> <code>${baseUrl}/c/</code></div>
      <div><strong>Loader Endpoint:</strong> <code>${baseUrl}/stalker_portal/server/load.php</code></div>
      <div><strong>MAC Detectada:</strong> <code>${mac}</code> ${
    matchedLine
      ? `→ Vinculada a <strong>${matchedLine.username}</strong> (${matchedLine.status})`
      : '→ Registra la MAC de tu STB en Líneas & MAG del panel'
  }</div>
    </div>
    <p style="margin-top:16px;font-size:13px;"><a href="/">← Ir al Panel / Reproductor WebTV</a></p>
  </div>
</body>
</html>`);
};

stalkerRouter.get('/c', renderPortalLanding);
stalkerRouter.get('/c/', renderPortalLanding);
stalkerRouter.get('/stalker_portal/c', renderPortalLanding);
stalkerRouter.get('/stalker_portal/c/', renderPortalLanding);

// Native Stalker Middleware JSON Protocol (/server/load.php & /stalker_portal/server/load.php)
const handleStalkerLoad = (req, res) => {
  const params = { ...req.query, ...req.body };
  const type = params.type || 'stb';
  const action = params.action || 'handshake';
  const baseUrl = getBaseUrl(req);
  const line = findLineForStb(req);

  if (type === 'stb' && action === 'handshake') {
    const token = line
      ? `stb_${line.id}_${crypto.randomBytes(8).toString('hex')}`
      : `guest_${crypto.randomBytes(8).toString('hex')}`;
    return res.json({
      js: {
        token,
        random: crypto.randomBytes(8).toString('hex'),
        not_valid: line ? 0 : 1
      }
    });
  }

  if (type === 'stb' && action === 'get_profile') {
    if (!line) {
      return res.json({ js: { status: 2, msg: 'MAC no registrada o expirada en TVLister 24/7' } });
    }
    return res.json({
      js: {
        id: line.id,
        name: line.username,
        sname: line.username,
        status: 0,
        mac: line.mac_address,
        expire_billing_date: line.exp_date || '2099-12-31',
        tariff_plan_name: 'TVLister VIP Bouquet'
      }
    });
  }

  if (type === 'account_info' && action === 'get_main_info') {
    return res.json({
      js: {
        mac: line?.mac_address || extractStbMac(req),
        phone: line?.exp_date ? new Date(line.exp_date).toLocaleDateString() : 'Unlimited',
        end_date: line?.exp_date || 'Unlimited'
      }
    });
  }

  if (!line) {
    return res.json({ js: [] });
  }

  const catalog = getStbAllowedCatalog(line);

  if (type === 'itv' && action === 'get_genres') {
    const cats = db.prepare("SELECT * FROM categories WHERE type IN ('live', 'channel247') ORDER BY sort_order ASC").all();
    return res.json({
      js: [
        { id: '*', title: 'Todos los Canales', alias: 'all', censored: 0 },
        ...cats.map((c) => ({ id: String(c.id), title: c.name, alias: c.name.toLowerCase(), censored: 0 }))
      ]
    });
  }

  if (type === 'itv' && (action === 'get_all_channels' || action === 'get_ordered_list')) {
    const items = [];
    let num = 1;
    for (const s of catalog.streams) {
      items.push({
        id: String(s.id),
        name: s.name,
        number: String(num++),
        tv_genre_id: String(s.category_id || 1),
        cmd: `ffmpeg ${baseUrl}/live/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${s.id}.ts`,
        logo: s.logo_url || '',
        enable_tv_archive: s.archive_enabled ? 1 : 0
      });
    }
    for (const ch of catalog.channels247) {
      const vid = 10000 + ch.id;
      items.push({
        id: String(vid),
        name: `[24/7] ${ch.name}`,
        number: String(num++),
        tv_genre_id: String(ch.category_id || 4),
        cmd: `ffmpeg ${baseUrl}/live/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${vid}.m3u8`,
        logo: ch.logo_url || '',
        enable_tv_archive: 0
      });
    }
    return res.json({
      js: {
        total_items: items.length,
        max_page_items: items.length || 50,
        data: items
      }
    });
  }

  if (type === 'itv' && action === 'create_link') {
    const rawCmd = String(params.cmd || '');
    const cleanCmd = rawCmd.startsWith('ffmpeg ') ? rawCmd : `ffmpeg ${rawCmd}`;
    return res.json({
      js: {
        cmd: cleanCmd,
        streamer_id: 1
      }
    });
  }

  if (type === 'vod' && action === 'get_categories') {
    const cats = db.prepare("SELECT * FROM categories WHERE type = 'vod'").all();
    return res.json({
      js: [
        { id: '*', title: 'Todas', alias: 'all' },
        ...cats.map((c) => ({ id: String(c.id), title: c.name, alias: c.name }))
      ]
    });
  }

  if (type === 'vod' && action === 'get_ordered_list') {
    const data = catalog.vods.map((v) => ({
      id: String(v.id),
      name: v.title,
      description: v.plot,
      pic: v.poster_url || '',
      year: String(v.release_year || ''),
      rating_imdb: String(v.rating || '8.0'),
      cmd: `ffmpeg ${baseUrl}/movie/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${v.id}.${v.container_ext || 'mp4'}`
    }));
    return res.json({
      js: {
        total_items: data.length,
        max_page_items: 50,
        data
      }
    });
  }

  if (type === 'vod' && action === 'create_link') {
    return res.json({ js: { cmd: String(params.cmd || '') } });
  }

  if (type === 'watchdog' && action === 'get_events') {
    const msg = db
      .prepare('SELECT * FROM osd_messages WHERE active = 1 AND (target_line_id IS NULL OR target_line_id = ?) ORDER BY id DESC LIMIT 1')
      .get(line.id);
    return res.json({
      js: {
        msgs: msg ? 1 : 0,
        additional_services_on: '1',
        data: msg ? { msg: msg.message, event: 'send_msg' } : {}
      }
    });
  }

  return res.json({ js: true });
};

stalkerRouter.get('/server/load.php', handleStalkerLoad);
stalkerRouter.post('/server/load.php', handleStalkerLoad);
stalkerRouter.get('/stalker_portal/server/load.php', handleStalkerLoad);
stalkerRouter.post('/stalker_portal/server/load.php', handleStalkerLoad);
