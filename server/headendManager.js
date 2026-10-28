import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, DB_PATH } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';
import { stopWorker } from './streamEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT_PATH = path.resolve(__dirname, '../scripts/headend-agent.js');
const INSTALL_SCRIPT_PATH = path.resolve(__dirname, '../scripts/install_headend_node.sh');
const ASTRA_LOGOS_CACHE_DIR = path.join(path.dirname(DB_PATH), 'astra_logos');

export const headendRouter = express.Router();

export function rewriteAstraLogoToCloudBridge(logoUrl, nodeId) {
  const raw = String(logoUrl || '').trim();
  if (!raw || !nodeId) return raw;
  const m = raw.match(/\/playlist\/tvg-logo\/([a-zA-Z0-9_.-]+)/i);
  if (m && m[1]) {
    return `/astra-logo/${Number(nodeId)}/${path.basename(m[1])}`;
  }
  return raw;
}

export function extractAstraPlayKey(urlStr = '') {
  const m = String(urlStr || '').match(/\/play\/([a-zA-Z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

export function classifyAstraCategoryByName(name = '') {
  const n = String(name || '').trim();
  if (/\b(canal\s*(2|4|6|8|10|12|13|14)\b|nic\b|-?\s*ni\b|nicarao)/i.test(n)) {
    return 'Nacionales Nicaragua';
  }
  if (/\b(playboy|venus|hustler|brazzers|penthouse|sextreme)\b/i.test(n)) {
    return 'Adultos (+18)';
  }
  if (/\b(espn|fox\s*sports|fox\s*nic|golf|pxtv|esport|sport|tyc|win\s*sports|tudn|dazn|ufc|nba|mlb|bein)\b/i.test(n)) {
    return 'Deportes';
  }
  if (
    /\b(cartoon|discovery\s*kids|disney|baby|tooncast|zoomoo|clan\b|semillitas|max\s*anime|nick|boomerang|adult\s*swim)\b/i.test(
      n
    )
  ) {
    return 'Infantiles';
  }
  if (/\b(ewtn|tbn\s*enlace|rhema|voz\s*de\s*maria|sembrador|cristovision|enlace)\b/i.test(n)) {
    return 'Religiosos';
  }
  if (/\b(bandamax|telehit|htv|exa\s*tv|concert\s*channel|mtv|vh1|ritmoson)\b/i.test(n)) {
    return 'Música';
  }
  if (
    /\b(discovery|disc\s*theat|history|\bh2\b|national\s*geographic|nat\s*geo|animal\s*planet|\bid\b|\btlc\b|home\s*&\s*health|home\s*garden|el\s*gourmet|sun\s*channel)\b/i.test(
      n
    )
  ) {
    return 'Documentales & Cultura';
  }
  if (
    /\b(hbo|cinecanal|cinemax|cine\s*latino|a3\s*cine|tnt|golden|amc|star\s*channel|space|universal|studio\s*universal|warner|sony|fx\b|axn|paramount|tcm|pelicula|dhe|europa|euro\s*channel|multipremier|multicinema|film\s*&\s*arts|atres\s*series|kdrama)\b/i.test(
      n
    )
  ) {
    return 'Cine & Series';
  }
  if (/\b(france\s*24|russia\s*today|\brt\b|cnn|dw|ntn24|telesur|bbc|euronews)\b/i.test(n)) {
    return 'Noticias';
  }
  return 'Variedades & Internacionales';
}

function getCopyCopyProfileId() {
  const row = db
    .prepare(
      "SELECT id FROM transcode_profiles WHERE video_codec = 'copy' AND audio_codec = 'copy' ORDER BY id DESC LIMIT 1"
    )
    .get();
  return row?.id || 1;
}

export function buildCloudPullUrl(node, streamId) {
  const base = String(node.public_url || '').replace(/\/+$/, '');
  return `${base}/headend/live/${encodeURIComponent(node.api_token)}/${streamId}/index.m3u8`;
}

function enrichNodeRow(node) {
  if (!node) return null;
  let telemetryMap = {};
  let lastScan = [];
  try {
    telemetryMap = JSON.parse(node.streams_telemetry_json || '{}');
  } catch {
    telemetryMap = {};
  }
  try {
    lastScan = JSON.parse(node.last_astra_scan_json || '[]');
  } catch {
    lastScan = [];
  }

  const lastBeatMs = node.last_heartbeat_at ? new Date(node.last_heartbeat_at + 'Z').getTime() || new Date(node.last_heartbeat_at).getTime() : 0;
  const isOnline = lastBeatMs > 0 && Date.now() - lastBeatMs < 25_000;
  const assignedCount =
    db.prepare('SELECT COUNT(*) as c FROM streams WHERE headend_node_id = ?').get(node.id)?.c || 0;

  return {
    ...node,
    status: isOnline ? 'online' : 'offline',
    hls_ramdisk: Boolean(node.hls_ramdisk),
    audio_leveling_enabled: Boolean(node.audio_leveling_enabled),
    auto_resolution: Boolean(node.auto_resolution),
    auto_deinterlace: Boolean(node.auto_deinterlace),
    assigned_streams_count: assignedCount,
    streams_telemetry: telemetryMap,
    last_astra_scan: lastScan
  };
}

export function parseAstraContent(rawText = '', defaultBaseUrl = 'http://127.0.0.1:8000') {
  const text = String(rawText || '').trim();
  if (!text) return [];

  if (text.includes('#EXTM3U') || text.includes('#EXTINF')) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let meta = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        const nameM = line.match(/,(.+)$/);
        const grpM = line.match(/group-title="([^"]*)"/i);
        const logoM = line.match(/tvg-logo="([^"]*)"/i);
        const rawGrp = grpM ? grpM[1].trim() : '';
        meta = {
          name: nameM ? nameM[1].trim() : 'Canal Astra',
          category: !rawGrp || rawGrp === '-' ? '' : rawGrp,
          logo_url: logoM ? logoM[1].trim() : ''
        };
      } else if (!line.startsWith('#') && meta) {
        let u = line;
        if (u.startsWith('/') && defaultBaseUrl) {
          u = `${defaultBaseUrl.replace(/\/+$/, '')}${u}`;
        }
        out.push({
          name: meta.name,
          category: meta.category,
          logo_url: meta.logo_url,
          astra_local_url: u
        });
        meta = null;
      }
    }
    return out;
  }

  // Try Cesbo Astra JSON / Lua config
  const items = [];
  try {
    const parsed = JSON.parse(text);
    const arr = parsed.make_stream || parsed.streams || (Array.isArray(parsed) ? parsed : []);
    for (const s of arr) {
      if (!s || s.enable === false) continue;
      const outputs = Array.isArray(s.output) ? s.output : s.output ? [s.output] : [];
      let chosen = outputs.find((o) => /^https?:|^udp:|^rtp:/i.test(String(o))) || '';
      if (!chosen && s.id && defaultBaseUrl) {
        chosen = `${defaultBaseUrl.replace(/\/+$/, '')}/play/${s.id}`;
      }
      if (chosen) {
        items.push({
          name: s.name || `Astra ${s.id || items.length + 1}`,
          category: s.groups || s.category || 'Cesbo Astra',
          logo_url: '',
          astra_local_url: String(chosen).replace(/^http:\/\/0\.0\.0\.0:/i, 'http://127.0.0.1:')
        });
      }
    }
    if (items.length > 0) return items;
  } catch {
    const regex = /make_stream\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const block = m[1];
      const nameM = block.match(/name\s*=\s*["']([^"']+)["']/);
      const outM = block.match(/(?:http|udp|rtp):\/\/[^"'\s]+/i);
      if (nameM && outM) {
        items.push({
          name: nameM[1],
          category: 'Cesbo Astra',
          logo_url: '',
          astra_local_url: outM[0].replace(/^http:\/\/0\.0\.0\.0:/i, 'http://127.0.0.1:')
        });
      }
    }
  }
  return items;
}

// ==================== PUBLIC AGENT & INSTALLER ENDPOINTS ====================
headendRouter.get('/api/headend/agent.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(fs.readFileSync(AGENT_SCRIPT_PATH, 'utf8'));
});

headendRouter.get('/api/headend/install.sh', (req, res) => {
  const token = String(req.query.token || '').trim();
  const port = Number(req.query.port || 8097);
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:8095';
  const masterUrl = String(req.query.master || `${proto}://${host}`).replace(/\/+$/, '');

  const rawScript = fs.readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
  const injected = rawScript
    .replace('MASTER_URL="${MASTER_URL:-}"', `MASTER_URL="\${MASTER_URL:-${masterUrl}}"`)
    .replace('HEADEND_TOKEN="${HEADEND_TOKEN:-}"', `HEADEND_TOKEN="\${HEADEND_TOKEN:-${token}}"`)
    .replace('HEADEND_PORT="${HEADEND_PORT:-8097}"', `HEADEND_PORT="\${HEADEND_PORT:-${port}}"`);

  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(injected);
});

// Public Cloud Logo Bridge & Permanent Disk Cache for Private LAN Cesbo Astra Logos (e.g. 192.168.88.10:8000/playlist/tvg-logo/a0ek.png)
headendRouter.get('/astra-logo/:nodeId/:file', async (req, res) => {
  const nodeId = Number(req.params.nodeId);
  const safeFile = path.basename(String(req.params.file || '').trim());
  if (!nodeId || !safeFile || !/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(safeFile)) {
    return res.status(400).send('Invalid logo file');
  }

  const ext = path.extname(safeFile).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
      ? 'image/webp'
      : ext === '.svg'
      ? 'image/svg+xml'
      : 'image/png';

  const nodeCacheDir = path.join(ASTRA_LOGOS_CACHE_DIR, String(nodeId));
  const cachedPath = path.join(nodeCacheDir, safeFile);

  if (fs.existsSync(cachedPath)) {
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(cachedPath);
  }

  const node = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).send('Node not found');

  const agentLogoUrl = `${String(node.public_url || '').replace(/\/+$/, '')}/headend/astra-logo/${encodeURIComponent(
    node.api_token
  )}/${encodeURIComponent(safeFile)}`;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(agentLogoUrl, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return res.status(404).send('Logo not found');
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(nodeCacheDir, { recursive: true });
    fs.writeFileSync(cachedPath, buf);
    res.setHeader('Content-Type', r.headers.get('content-type') || mime);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.send(buf);
  } catch {
    return res.status(502).send('Logo bridge unavailable');
  }
});

// ==================== AGENT HEARTBEAT & DESIRED-STATE SYNC ====================
headendRouter.post('/api/headend/heartbeat', (req, res) => {
  const token = String(req.headers['x-headend-token'] || '').trim();
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  const node = db.prepare('SELECT * FROM headend_nodes WHERE api_token = ?').get(token);
  if (!node) return res.status(403).json({ error: 'Nodo Cabecera no reconocido' });

  const b = req.body || {};
  const telemetryObj = b.streams_telemetry && typeof b.streams_telemetry === 'object' ? b.streams_telemetry : {};

  let pendingCmds = [];
  try {
    pendingCmds = JSON.parse(node.pending_commands_json || '[]');
  } catch {
    pendingCmds = [];
  }

  const nextScanJson = Array.isArray(b.astra_discovered)
    ? JSON.stringify(b.astra_discovered)
    : node.last_astra_scan_json || '[]';

  db.prepare(
    `UPDATE headend_nodes
     SET status = 'online',
         last_heartbeat_at = datetime('now'),
         hostname = ?,
         cpu_model = ?,
         cpu_cores = ?,
         cpu_usage_pct = ?,
         cpu_used_ghz = ?,
         cpu_total_ghz = ?,
         ram_used_gb = ?,
         ram_total_gb = ?,
         ram_usage_pct = ?,
         hls_ramdisk = ?,
         active_workers = ?,
         vip_count = ?,
         ondemand_awake_count = ?,
         upload_mbps = ?,
         streams_telemetry_json = ?,
         last_astra_scan_json = ?,
         pending_commands_json = '[]'
     WHERE id = ?`
  ).run(
    String(b.hostname || ''),
    String(b.cpu_model || ''),
    Number(b.cpu_cores) || 0,
    Number(b.cpu_usage_pct) || 0,
    Number(b.cpu_used_ghz) || 0,
    Number(b.cpu_total_ghz) || 0,
    Number(b.ram_used_gb) || 0,
    Number(b.ram_total_gb) || 0,
    Number(b.ram_usage_pct) || 0,
    b.hls_ramdisk ? 1 : 0,
    Number(b.active_workers) || 0,
    Number(b.vip_count) || 0,
    Number(b.ondemand_awake_count) || 0,
    Number(b.upload_mbps) || 0,
    JSON.stringify(telemetryObj),
    nextScanJson,
    node.id
  );

  // Sync real detected resolution, interlace & audio codec from ProLiant back to Cloud streams table!
  const updStreamMeta = db.prepare(
    `UPDATE streams
     SET detected_resolution = CASE WHEN ? != '' THEN ? ELSE detected_resolution END,
         resolution_tier = CASE WHEN ? != '' THEN ? ELSE resolution_tier END,
         resolution_source = CASE WHEN ? != '' THEN 'probed' ELSE resolution_source END,
         bitrate_kbps = CASE WHEN ? > 0 THEN ? ELSE bitrate_kbps END,
         headend_interlaced = ?,
         headend_audio_in = CASE WHEN ? != '' THEN ? ELSE headend_audio_in END
     WHERE id = ? AND headend_node_id = ?`
  );

  for (const [sidStr, meta] of Object.entries(telemetryObj)) {
    const sid = Number(sidStr);
    if (!sid || !meta) continue;
    updStreamMeta.run(
      meta.resolution || '',
      meta.resolution || '',
      meta.tier || '',
      meta.tier || '',
      meta.resolution || '',
      Number(meta.effectiveKbps) || 0,
      Number(meta.effectiveKbps) || 0,
      meta.interlaced ? 1 : 0,
      meta.audioIn || '',
      meta.audioIn || '',
      sid,
      node.id
    );
  }

  // Build desired streams list for this ProLiant node
  // Also check if any Cloud viewer is actively watching any stream right now -> keep ProLiant awake!
  const activeCloudIds = new Set(
    db
      .prepare(
        "SELECT DISTINCT target_id FROM active_connections WHERE target_type = 'live' AND datetime(last_ping_at) >= datetime('now', '-2 minutes')"
      )
      .all()
      .map((r) => Number(r.target_id))
  );

  const nodeStreams = db
    .prepare(
      `SELECT id, name, astra_local_url, headend_mode, deinterlace_mode,
              audio_leveling_mode, detected_resolution, resolution_tier,
              bitrate_kbps, status
       FROM streams
       WHERE headend_node_id = ?
       ORDER BY sort_order ASC, id ASC`
    )
    .all(node.id)
    .map((s) => ({
      ...s,
      force_wake_until: activeCloudIds.has(s.id) || s.status === 'running' ? Date.now() + 90_000 : 0
    }));

  res.json({
    ok: true,
    settings: {
      audio_leveling_enabled: Boolean(node.audio_leveling_enabled),
      audio_preset: node.audio_preset || 'standard',
      audio_bitrate: node.audio_bitrate || '128k',
      auto_resolution: Boolean(node.auto_resolution),
      sd_kbps: Number(node.sd_kbps) || 1000,
      hd_kbps: Number(node.hd_kbps) || 2500,
      fhd_kbps: Number(node.fhd_kbps) || 3000,
      auto_deinterlace: Boolean(node.auto_deinterlace),
      allowed_cloud_ip: node.allowed_cloud_ip || '',
      astra_url: node.astra_url || 'http://127.0.0.1:8000',
      astra_auth: node.astra_auth || ''
    },
    streams: nodeStreams,
    commands: pendingCmds
  });
});

// ==================== ADMIN CLOUD CONTROL ENDPOINTS ====================
headendRouter.get('/api/headend/nodes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM headend_nodes ORDER BY id ASC').all().map(enrichNodeRow);
  res.json(rows);
});

headendRouter.post('/api/headend/nodes', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.public_url) {
    return res.status(400).json({ error: 'Nombre e IP/URL pública del nodo ProLiant son obligatorios.' });
  }
  const token = `hdn_${crypto.randomBytes(18).toString('hex')}`;
  let pub = String(b.public_url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(pub)) pub = `http://${pub}`;

  const info = db
    .prepare(
      `INSERT INTO headend_nodes (
         name, public_url, api_token, astra_url, astra_auth,
         audio_leveling_enabled, audio_preset, audio_bitrate,
         auto_resolution, sd_kbps, hd_kbps, fhd_kbps, auto_deinterlace, allowed_cloud_ip
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(b.name).trim(),
      pub,
      token,
      String(b.astra_url || 'http://127.0.0.1:8000').trim(),
      String(b.astra_auth || '').trim(),
      b.audio_leveling_enabled !== false ? 1 : 0,
      String(b.audio_preset || 'standard'),
      String(b.audio_bitrate || '128k'),
      b.auto_resolution !== false ? 1 : 0,
      Number(b.sd_kbps) || 1000,
      Number(b.hd_kbps) || 2500,
      Number(b.fhd_kbps) || 3000,
      b.auto_deinterlace !== false ? 1 : 0,
      String(b.allowed_cloud_ip || '').trim()
    );

  const created = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json({ ok: true, node: enrichNodeRow(created) });
});

headendRouter.put('/api/headend/nodes/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Nodo Cabecera no encontrado' });

  const b = req.body || {};
  let pub = b.public_url !== undefined ? String(b.public_url).trim().replace(/\/+$/, '') : existing.public_url;
  if (pub && !/^https?:\/\//i.test(pub)) pub = `http://${pub}`;

  db.prepare(
    `UPDATE headend_nodes
     SET name = ?, public_url = ?, astra_url = ?, astra_auth = ?,
         audio_leveling_enabled = ?, audio_preset = ?, audio_bitrate = ?,
         auto_resolution = ?, sd_kbps = ?, hd_kbps = ?, fhd_kbps = ?,
         auto_deinterlace = ?, allowed_cloud_ip = ?
     WHERE id = ?`
  ).run(
    b.name !== undefined ? String(b.name).trim() : existing.name,
    pub,
    b.astra_url !== undefined ? String(b.astra_url).trim() : existing.astra_url,
    b.astra_auth !== undefined ? String(b.astra_auth).trim() : existing.astra_auth,
    b.audio_leveling_enabled !== undefined ? (b.audio_leveling_enabled ? 1 : 0) : existing.audio_leveling_enabled,
    b.audio_preset !== undefined ? String(b.audio_preset) : existing.audio_preset,
    b.audio_bitrate !== undefined ? String(b.audio_bitrate) : existing.audio_bitrate,
    b.auto_resolution !== undefined ? (b.auto_resolution ? 1 : 0) : existing.auto_resolution,
    b.sd_kbps !== undefined ? Number(b.sd_kbps) || 1000 : existing.sd_kbps,
    b.hd_kbps !== undefined ? Number(b.hd_kbps) || 2500 : existing.hd_kbps,
    b.fhd_kbps !== undefined ? Number(b.fhd_kbps) || 3000 : existing.fhd_kbps,
    b.auto_deinterlace !== undefined ? (b.auto_deinterlace ? 1 : 0) : existing.auto_deinterlace,
    b.allowed_cloud_ip !== undefined ? String(b.allowed_cloud_ip).trim() : existing.allowed_cloud_ip,
    id
  );

  const updated = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(id);
  // If public_url changed, refresh Cloud pull URLs on linked streams
  if (pub !== existing.public_url) {
    const linked = db.prepare('SELECT id FROM streams WHERE headend_node_id = ?').all(id);
    const updUrl = db.prepare('UPDATE streams SET source_url = ? WHERE id = ?');
    for (const st of linked) {
      updUrl.run(buildCloudPullUrl(updated, st.id), st.id);
    }
  }

  res.json({ ok: true, node: enrichNodeRow(updated) });
});

headendRouter.delete('/api/headend/nodes/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const linked = db.prepare('SELECT id FROM streams WHERE headend_node_id = ?').all(id);
  for (const s of linked) {
    stopWorker(`stream_${s.id}`);
  }
  // Restore original public source_url (or astra_local_url) cleanly when detaching node
  db.prepare(
    `UPDATE streams
     SET source_url = COALESCE(NULLIF(original_source_url, ''), NULLIF(astra_local_url, ''), source_url),
         audio_leveling_mode = 'global',
         headend_node_id = NULL,
         pid = NULL
     WHERE headend_node_id = ?`
  ).run(id);
  db.prepare('DELETE FROM headend_nodes WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Return summary of existing Cloud streams & auto-detected public Astra IPs/hosts
headendRouter.get('/api/headend/existing-summary', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, name, source_url FROM streams WHERE headend_node_id IS NULL ORDER BY sort_order ASC, id ASC')
    .all();

  const hostMap = new Map();
  for (const r of rows) {
    try {
      const u = new URL(String(r.source_url || '').trim());
      const h = u.hostname;
      if (!hostMap.has(h)) {
        hostMap.set(h, { hostname: h, count: 0, ports: new Set(), sampleUrl: r.source_url, sampleName: r.name });
      }
      const entry = hostMap.get(h);
      entry.count++;
      if (u.port) entry.ports.add(u.port);
    } catch {
      // non-HTTP URL
    }
  }

  const hosts = Array.from(hostMap.values())
    .map((x) => ({
      hostname: x.hostname,
      count: x.count,
      ports: Array.from(x.ports),
      sampleUrl: x.sampleUrl,
      sampleName: x.sampleName
    }))
    .sort((a, b) => b.count - a.count);

  res.json({
    totalUnassigned: rows.length,
    firstChannelName: rows[0]?.name || '',
    firstChannelUrl: rows[0]?.source_url || '',
    hosts
  });
});

headendRouter.get('/api/headend/nodes/:id/streams', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const node = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(id);
  if (!node) return res.status(404).json({ error: 'Nodo no encontrado' });

  let telemetry = {};
  try {
    telemetry = JSON.parse(node.streams_telemetry_json || '{}');
  } catch {
    telemetry = {};
  }

  const rows = db
    .prepare(
      `SELECT s.*, c.name as category_name
       FROM streams s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.headend_node_id = ?
       ORDER BY s.sort_order ASC, s.id ASC`
    )
    .all(id)
    .map((s) => ({
      ...s,
      liveHeadend: telemetry[s.id] || null
    }));

  res.json(rows);
});

// Change VIP 24/7 vs On-Demand vs Copy+Audio or Deinterlace on Headend streams (single or bulk)
headendRouter.post('/api/headend/nodes/:id/streams-mode', requireAuth, requireAdmin, (req, res) => {
  const nodeId = Number(req.params.id);
  const { ids = [], scope = 'selected', headend_mode, deinterlace_mode, astra_local_url } = req.body || {};

  let targetIds = [];
  if (scope === 'all') {
    targetIds = db
      .prepare('SELECT id FROM streams WHERE headend_node_id = ?')
      .all(nodeId)
      .map((r) => r.id);
  } else {
    targetIds = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0);
  }

  if (targetIds.length === 0) {
    return res.status(400).json({ error: 'No hay canales seleccionados.' });
  }

  const placeholders = targetIds.map(() => '?').join(',');
  if (headend_mode) {
    db.prepare(`UPDATE streams SET headend_mode = ? WHERE headend_node_id = ? AND id IN (${placeholders})`).run(
      String(headend_mode),
      nodeId,
      ...targetIds
    );
  }
  if (deinterlace_mode) {
    db.prepare(`UPDATE streams SET deinterlace_mode = ? WHERE headend_node_id = ? AND id IN (${placeholders})`).run(
      String(deinterlace_mode),
      nodeId,
      ...targetIds
    );
  }
  if (astra_local_url !== undefined && targetIds.length === 1) {
    db.prepare('UPDATE streams SET astra_local_url = ? WHERE headend_node_id = ? AND id = ?').run(
      String(astra_local_url).trim(),
      nodeId,
      targetIds[0]
    );
  }

  res.json({ ok: true, updatedCount: targetIds.length });
});

// Discover Cesbo Astra channels via ProLiant Agent (direct LAN HTTP or queued command)
headendRouter.post('/api/headend/nodes/:id/discover-astra', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const node = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(id);
  if (!node) return res.status(404).json({ error: 'Nodo no encontrado' });

  const astraUrl = String(req.body?.astra_url || node.astra_url || 'http://127.0.0.1:8000').trim();
  const astraAuth = String(req.body?.astra_auth ?? node.astra_auth ?? '').trim();

  // Try direct call to ProLiant Agent first
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6500);
    const u = new URL(`${node.public_url.replace(/\/+$/, '')}/headend/discover-astra`);
    u.searchParams.set('token', node.api_token);
    u.searchParams.set('astra_url', astraUrl);
    if (astraAuth) u.searchParams.set('astra_auth', astraAuth);

    const resp = await fetch(u.toString(), { signal: ac.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      const channels = Array.isArray(data.channels) ? data.channels : [];
      db.prepare('UPDATE headend_nodes SET last_astra_scan_json = ?, astra_url = ?, astra_auth = ? WHERE id = ?').run(
        JSON.stringify(channels),
        astraUrl,
        astraAuth,
        id
      );
      return res.json({ ok: true, mode: 'direct', channels });
    }
  } catch {
    // Queue via heartbeat if direct inbound isn't reachable yet
  }

  let cmds = [];
  try {
    cmds = JSON.parse(node.pending_commands_json || '[]');
  } catch {
    cmds = [];
  }
  cmds.push({ type: 'discover_astra', astra_url: astraUrl, astra_auth: astraAuth });
  db.prepare('UPDATE headend_nodes SET pending_commands_json = ?, astra_url = ?, astra_auth = ? WHERE id = ?').run(
    JSON.stringify(cmds),
    astraUrl,
    astraAuth,
    id
  );

  res.json({
    ok: true,
    mode: 'queued',
    message: 'Orden enviada al Agente ProLiant. En ~5 segundos aparecerán los canales detectados en tu red local.'
  });
});

// Parse pasted Cesbo Astra M3U or Config JSON/Lua directly in browser
headendRouter.post('/api/headend/parse-astra-text', requireAuth, requireAdmin, (req, res) => {
  const { content = '', astra_url = 'http://127.0.0.1:8000' } = req.body || {};
  const channels = parseAstraContent(content, astra_url);
  res.json({ ok: true, channels });
});

// Import Cesbo Astra channels & wire 1-stream Cloud Relay automatically (deduplicating /play/a0ek matches!)
headendRouter.post('/api/headend/nodes/:id/import-astra', requireAuth, requireAdmin, (req, res) => {
  const nodeId = Number(req.params.id);
  const node = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: 'Nodo no encontrado' });

  const {
    channels = [],
    default_headend_mode = 'ondemand',
    vip_top_count = 0,
    auto_categorize = true
  } = req.body || {};
  if (!Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ error: 'No hay canales de Astra para importar.' });
  }

  const copyProfId = getCopyCopyProfileId();

  db.exec('BEGIN IMMEDIATE;');
  try {
    const existingCats = db.prepare("SELECT * FROM categories WHERE type = 'live'").all();
    const catMap = new Map(existingCats.map((c) => [c.name.toLowerCase(), c.id]));
    const insCat = db.prepare("INSERT INTO categories (name, type, sort_order) VALUES (?, 'live', 0)");

    // Build lookup of existing streams by Astra /play/<id> key and by exact lowercase name to prevent duplicates!
    const existingStreams = db.prepare('SELECT * FROM streams').all();
    const byAstraKey = new Map();
    const byExactName = new Map();
    for (const ex of existingStreams) {
      const k =
        extractAstraPlayKey(ex.astra_local_url) ||
        extractAstraPlayKey(ex.original_source_url) ||
        extractAstraPlayKey(ex.source_url);
      if (k) byAstraKey.set(k, ex);
      byExactName.set(String(ex.name || '').trim().toLowerCase(), ex);
    }

    const insStream = db.prepare(
      `INSERT INTO streams (
         name, category_id, source_url, astra_local_url, logo_url,
         stream_mode, transcode_profile_id, status, bitrate_kbps,
         audio_leveling_mode, headend_node_id, headend_mode, deinterlace_mode, sort_order
       ) VALUES (?, ?, ?, ?, ?, 'ondemand', ?, 'ondemand_idle', 2500, 'off', ?, ?, 'auto', ?)`
    );
    const updPullUrl = db.prepare('UPDATE streams SET source_url = ? WHERE id = ?');
    const updExistingInPlace = db.prepare(
      `UPDATE streams
       SET original_source_url = CASE WHEN original_source_url != '' THEN original_source_url ELSE source_url END,
           astra_local_url = ?,
           source_url = ?,
           logo_url = CASE WHEN ? != '' THEN ? ELSE logo_url END,
           headend_node_id = ?,
           headend_mode = ?,
           deinterlace_mode = 'auto',
           stream_mode = 'ondemand',
           transcode_profile_id = ?,
           audio_leveling_mode = 'off',
           status = CASE WHEN status = 'stopped' THEN 'stopped' ELSE 'ondemand_idle' END,
           pid = NULL
       WHERE id = ?`
    );

    const b1 = db.prepare('SELECT * FROM bouquets ORDER BY id ASC LIMIT 1').get();
    const b1Ids = b1 ? JSON.parse(b1.stream_ids_json || '[]') : [];

    let maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM streams').get().m || 0;
    let importedCount = 0;
    let updatedExistingCount = 0;

    channels.forEach((ch, idx) => {
      if (!ch?.name || !ch?.astra_local_url) return;
      const cleanName = String(ch.name).trim();
      const cleanAstraUrl = String(ch.astra_local_url).trim();
      const bridgedLogo = rewriteAstraLogoToCloudBridge(ch.logo_url || '', nodeId);
      const mode =
        ch.headend_mode || (idx < Number(vip_top_count || 0) ? 'vip_247' : default_headend_mode || 'ondemand');

      const playKey = extractAstraPlayKey(cleanAstraUrl);
      const matched = (playKey && byAstraKey.get(playKey)) || byExactName.get(cleanName.toLowerCase());

      if (matched) {
        stopWorker(`stream_${matched.id}`);
        updExistingInPlace.run(
          cleanAstraUrl,
          buildCloudPullUrl(node, matched.id),
          bridgedLogo,
          bridgedLogo,
          nodeId,
          mode,
          copyProfId,
          matched.id
        );
        updatedExistingCount++;
        return;
      }

      const rawCat = String(ch.category || '').trim();
      const catName =
        !rawCat || rawCat === '-'
          ? auto_categorize
            ? classifyAstraCategoryByName(cleanName)
            : 'Cesbo Astra'
          : rawCat;

      let catId = catMap.get(catName.toLowerCase());
      if (!catId) {
        const cInfo = insCat.run(catName);
        catId = Number(cInfo.lastInsertRowid);
        catMap.set(catName.toLowerCase(), catId);
      }

      maxOrder += 1;
      const sInfo = insStream.run(
        cleanName,
        catId,
        'http://pending-headend-link',
        cleanAstraUrl,
        bridgedLogo,
        copyProfId,
        nodeId,
        mode,
        maxOrder
      );
      const newSid = Number(sInfo.lastInsertRowid);
      updPullUrl.run(buildCloudPullUrl(node, newSid), newSid);
      if (!b1Ids.includes(newSid)) b1Ids.push(newSid);
      importedCount++;
    });

    if (b1 && importedCount > 0) {
      db.prepare('UPDATE bouquets SET stream_ids_json = ? WHERE id = ?').run(JSON.stringify(b1Ids), b1.id);
    }

    db.exec('COMMIT;');
    res.json({ ok: true, importedCount, updatedExistingCount, totalProcessed: importedCount + updatedExistingCount });
  } catch (err) {
    db.exec('ROLLBACK;');
    res.status(500).json({ error: err.message || 'Error importando canales de Astra' });
  }
});

// 1-Click Migrate Existing Cloud Channels (e.g. user's existing public-IP Astra channels!) onto the ProLiant Headend Node!
headendRouter.post('/api/headend/nodes/:id/attach-existing', requireAuth, requireAdmin, (req, res) => {
  const nodeId = Number(req.params.id);
  const node = db.prepare('SELECT * FROM headend_nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: 'Nodo no encontrado' });

  const {
    default_headend_mode = 'ondemand',
    vip_top_count = 30,
    rewrite_host_to_local = '',
    filter_hostname = '',
    limit_count = 0
  } = req.body || {};

  const copyProfId = getCopyCopyProfileId();
  let candidates = db
    .prepare('SELECT * FROM streams WHERE headend_node_id IS NULL ORDER BY sort_order ASC, id ASC')
    .all();

  if (filter_hostname && String(filter_hostname).trim() && filter_hostname !== 'all') {
    const wantedHost = String(filter_hostname).trim().toLowerCase();
    candidates = candidates.filter((st) => {
      try {
        return new URL(String(st.source_url || '').trim()).hostname.toLowerCase() === wantedHost;
      } catch {
        return false;
      }
    });
  }

  if (Number(limit_count) > 0) {
    candidates = candidates.slice(0, Number(limit_count));
  }

  if (candidates.length === 0) {
    return res.status(400).json({ error: 'No hay canales pendientes que coincidan para migrar.' });
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const upd = db.prepare(
      `UPDATE streams
       SET original_source_url = CASE WHEN original_source_url != '' THEN original_source_url ELSE source_url END,
           backup_url = CASE WHEN backup_url = '' THEN source_url ELSE backup_url END,
           logo_url = ?,
           astra_local_url = ?,
           source_url = ?,
           headend_node_id = ?,
           headend_mode = ?,
           deinterlace_mode = 'auto',
           stream_mode = 'ondemand',
           transcode_profile_id = ?,
           audio_leveling_mode = 'off',
           status = CASE WHEN status = 'stopped' THEN 'stopped' ELSE 'ondemand_idle' END,
           pid = NULL
       WHERE id = ?`
    );

    const rawRewrite = String(rewrite_host_to_local || '').trim();

    candidates.forEach((st, idx) => {
      stopWorker(`stream_${st.id}`);
      const origUrl = st.original_source_url || st.source_url;
      let localUrl = origUrl;

      if (rawRewrite) {
        try {
          const parsedOld = new URL(origUrl);
          const withProto = /^https?:\/\//i.test(rawRewrite) ? rawRewrite : `http://${rawRewrite}`;
          const parsedNew = new URL(withProto);
          parsedOld.protocol = parsedNew.protocol;
          if (parsedNew.port) {
            parsedOld.host = parsedNew.host;
          } else {
            // Preserve each channel's original Astra port (:8000, :8001, :8002, etc.) when only LAN IP is given!
            parsedOld.hostname = parsedNew.hostname;
          }
          localUrl = parsedOld.toString();
        } catch {
          // keep original if UDP or non-HTTP
        }
      }
      const mode = idx < Number(vip_top_count || 0) ? 'vip_247' : default_headend_mode;
      const bridgedLogo = rewriteAstraLogoToCloudBridge(st.logo_url || '', nodeId);
      upd.run(bridgedLogo, localUrl, buildCloudPullUrl(node, st.id), nodeId, mode, copyProfId, st.id);
    });

    db.exec('COMMIT;');
    res.json({ ok: true, migratedCount: candidates.length });
  } catch (err) {
    db.exec('ROLLBACK;');
    res.status(500).json({ error: err.message });
  }
});

// 1-Click Detach Selected (or All) Channels back to Original Public Astra URL on Cloud
headendRouter.post('/api/headend/nodes/:id/detach-streams', requireAuth, requireAdmin, (req, res) => {
  const nodeId = Number(req.params.id);
  const { ids = [], scope = 'selected' } = req.body || {};

  let rows = [];
  if (scope === 'all') {
    rows = db.prepare('SELECT id FROM streams WHERE headend_node_id = ?').all(nodeId);
  } else if (Array.isArray(ids) && ids.length > 0) {
    const cleanIds = ids.map((n) => Number(n)).filter((n) => n > 0);
    if (cleanIds.length > 0) {
      const ph = cleanIds.map(() => '?').join(',');
      rows = db.prepare(`SELECT id FROM streams WHERE headend_node_id = ? AND id IN (${ph})`).all(nodeId, ...cleanIds);
    }
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Selecciona al menos un canal para regresar a URL pública directa.' });
  }

  for (const r of rows) {
    stopWorker(`stream_${r.id}`);
  }

  const ph = rows.map(() => '?').join(',');
  db.prepare(
    `UPDATE streams
     SET source_url = COALESCE(NULLIF(original_source_url, ''), NULLIF(astra_local_url, ''), source_url),
         audio_leveling_mode = 'global',
         headend_node_id = NULL,
         pid = NULL
     WHERE headend_node_id = ? AND id IN (${ph})`
  ).run(nodeId, ...rows.map((r) => r.id));

  res.json({ ok: true, detachedCount: rows.length });
});
