import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Migrate legacy database filename transparently if upgrading an existing installation
const LEGACY_DB_NAME = ['mid', 'night_tvlister.db'].join('');
const LEGACY_DB_PATH = path.join(DATA_DIR, LEGACY_DB_NAME);
export const DB_PATH = path.join(DATA_DIR, 'tvlister.db');

if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${LEGACY_DB_PATH}${suffix}`)) {
      try {
        fs.renameSync(`${LEGACY_DB_PATH}${suffix}`, `${DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }
  }
}

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

let dbInitialized = false;

export function initDb() {
  if (dbInitialized) return;
  dbInitialized = true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reseller',
      credits INTEGER NOT NULL DEFAULT 0,
      email TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'live',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transcode_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      video_codec TEXT NOT NULL DEFAULT 'copy',
      audio_codec TEXT NOT NULL DEFAULT 'copy',
      video_bitrate TEXT DEFAULT '3500k',
      audio_bitrate TEXT DEFAULT '128k',
      resolution TEXT DEFAULT 'source',
      preset TEXT DEFAULT 'veryfast',
      hwaccel TEXT DEFAULT 'none',
      extra_flags TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 8080,
      is_main INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'online',
      lb_mode TEXT NOT NULL DEFAULT 'load',
      max_clients INTEGER NOT NULL DEFAULT 5000,
      cpu_usage REAL NOT NULL DEFAULT 0,
      ram_usage REAL NOT NULL DEFAULT 0,
      bandwidth_mbps REAL NOT NULL DEFAULT 0,
      ssh_port INTEGER NOT NULL DEFAULT 22,
      stalker_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category_id INTEGER,
      source_url TEXT NOT NULL,
      backup_url TEXT DEFAULT '',
      logo_url TEXT DEFAULT '',
      epg_channel_id TEXT DEFAULT '',
      stream_mode TEXT NOT NULL DEFAULT 'direct',
      transcode_profile_id INTEGER,
      server_id INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'running',
      user_agent TEXT DEFAULT 'TVLister/2.3 (MPEG-TS; Linux)',
      tv_archive_days INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      bitrate_kbps INTEGER NOT NULL DEFAULT 2500,
      uptime_started_at TEXT DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels_247 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category_id INTEGER,
      logo_url TEXT DEFAULT '',
      epg_channel_id TEXT DEFAULT '',
      loop_mode TEXT NOT NULL DEFAULT 'loop',
      transcode_profile_id INTEGER DEFAULT 2,
      server_id INTEGER DEFAULT 1,
      watermark_text TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      playlist_json TEXT NOT NULL DEFAULT '[]',
      schedule_anchor_epoch INTEGER NOT NULL DEFAULT 1704067200,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vod_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'movie',
      category_id INTEGER,
      source_url TEXT NOT NULL,
      poster_url TEXT DEFAULT '',
      backdrop_url TEXT DEFAULT '',
      plot TEXT DEFAULT '',
      genre TEXT DEFAULT 'General',
      release_year INTEGER DEFAULT 2024,
      rating REAL DEFAULT 8.0,
      duration_sec INTEGER NOT NULL DEFAULT 600,
      container_ext TEXT NOT NULL DEFAULT 'mp4',
      direct_source INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bouquets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      stream_ids_json TEXT NOT NULL DEFAULT '[]',
      channel247_ids_json TEXT NOT NULL DEFAULT '[]',
      vod_ids_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_trial INTEGER NOT NULL DEFAULT 0,
      duration_days INTEGER NOT NULL DEFAULT 30,
      cost_credits INTEGER NOT NULL DEFAULT 1,
      max_connections INTEGER NOT NULL DEFAULT 1,
      bouquet_ids_json TEXT NOT NULL DEFAULT '[1]'
    );

    CREATE TABLE IF NOT EXISTS lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      owner_id INTEGER NOT NULL DEFAULT 1,
      exp_date TEXT,
      max_connections INTEGER NOT NULL DEFAULT 2,
      is_trial INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      device_type TEXT NOT NULL DEFAULT 'm3u',
      mac_address TEXT DEFAULT '',
      bouquet_ids_json TEXT NOT NULL DEFAULT '[1]',
      allowed_ips TEXT DEFAULT '',
      allowed_countries TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS active_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER,
      username TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'live',
      target_id INTEGER NOT NULL,
      target_name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      country TEXT DEFAULT 'NI',
      isp TEXT DEFAULT 'ISP Broadband',
      user_agent TEXT DEFAULT 'VLC/3.0.20 LibVLC/3.0.20',
      protocol TEXT NOT NULL DEFAULT 'HLS',
      server_id INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ping_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS epg_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      xmltv_url TEXT NOT NULL,
      last_updated_at TEXT DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'synced'
    );

    CREATE TABLE IF NOT EXISTS epg_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_epg_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      lang TEXT DEFAULT 'es'
    );

    CREATE TABLE IF NOT EXISTS osd_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_line_id INTEGER,
      message TEXT NOT NULL,
      display_seconds INTEGER NOT NULL DEFAULT 15,
      style TEXT NOT NULL DEFAULT 'banner',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_username TEXT NOT NULL,
      stream_name TEXT NOT NULL,
      issue_type TEXT NOT NULL DEFAULT 'buffering',
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS firewall_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL DEFAULT 'ip',
      value TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'block',
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS credit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category_id INTEGER,
      poster_url TEXT DEFAULT '',
      backdrop_url TEXT DEFAULT '',
      plot TEXT DEFAULT '',
      genre TEXT DEFAULT 'General',
      release_year INTEGER DEFAULT 2025,
      rating REAL DEFAULT 8.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      season_num INTEGER NOT NULL DEFAULT 1,
      episode_num INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      plot TEXT DEFAULT '',
      duration_sec INTEGER NOT NULL DEFAULT 1200,
      container_ext TEXT NOT NULL DEFAULT 'mp4',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ingest_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stream_key TEXT UNIQUE NOT NULL,
      protocol_hint TEXT NOT NULL DEFAULT 'rtmp',
      passphrase TEXT DEFAULT '',
      linked_stream_id INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      publisher_ip TEXT DEFAULT '',
      started_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vod_watch_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT UNIQUE NOT NULL,
      content_mode TEXT NOT NULL DEFAULT 'auto',
      default_category_id INTEGER,
      use_subfolders_as_categories INTEGER NOT NULL DEFAULT 1,
      auto_tmdb INTEGER NOT NULL DEFAULT 1,
      auto_sync_minutes INTEGER NOT NULL DEFAULT 0,
      remove_missing INTEGER NOT NULL DEFAULT 0,
      last_scan_at TEXT,
      last_scan_summary TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ip_geo_cache (
      ip TEXT PRIMARY KEY,
      country TEXT DEFAULT '',
      city TEXT DEFAULT '',
      isp TEXT DEFAULT '',
      asn TEXT DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const ensureColumn = (table, column, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def};`);
    }
  };

  ensureColumn('servers', 'api_token', "TEXT DEFAULT ''");
  ensureColumn('servers', 'last_heartbeat_at', 'TEXT');
  ensureColumn('servers', 'active_conns', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('servers', 'region_countries', "TEXT DEFAULT ''");
  ensureColumn('servers', 'isp_match', "TEXT DEFAULT ''");
  ensureColumn('servers', 'https_port', 'INTEGER');
  ensureColumn('streams', 'archive_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('streams', 'xui_id', 'INTEGER');
  ensureColumn('streams', 'offline_slate_mode', "TEXT NOT NULL DEFAULT 'global'");
  ensureColumn('streams', 'offline_slate_url', "TEXT DEFAULT ''");
  ensureColumn('streams', 'detected_resolution', "TEXT DEFAULT ''");
  ensureColumn('streams', 'resolution_tier', "TEXT DEFAULT ''");
  ensureColumn('streams', 'resolution_source', "TEXT DEFAULT ''");
  ensureColumn('streams', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('streams', 'audio_leveling_mode', "TEXT NOT NULL DEFAULT 'global'");
  ensureColumn('channels_247', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_streams_sort_order ON streams(sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_categories_sort_order ON categories(sort_order, id);

    CREATE TRIGGER IF NOT EXISTS trg_streams_auto_sort_order
    AFTER INSERT ON streams
    WHEN NEW.sort_order = 0
    BEGIN
      UPDATE streams
      SET sort_order = COALESCE((SELECT MAX(sort_order) FROM streams WHERE id != NEW.id), 0) + 1
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_channels247_auto_sort_order
    AFTER INSERT ON channels_247
    WHEN NEW.sort_order = 0
    BEGIN
      UPDATE channels_247
      SET sort_order = COALESCE((SELECT MAX(sort_order) FROM channels_247 WHERE id != NEW.id), 0) + 1
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_categories_auto_sort_order
    AFTER INSERT ON categories
    WHEN NEW.sort_order = 0
    BEGIN
      UPDATE categories
      SET sort_order = COALESCE((SELECT MAX(sort_order) FROM categories WHERE id != NEW.id), 0) + 1
      WHERE id = NEW.id;
    END;
  `);
  ensureColumn('vod_items', 'xui_id', 'INTEGER');
  ensureColumn('vod_items', 'backdrop_url', "TEXT DEFAULT ''");
  ensureColumn('vod_items', 'tmdb_id', "TEXT DEFAULT ''");
  ensureColumn('series', 'xui_id', 'INTEGER');
  ensureColumn('series', 'tmdb_id', "TEXT DEFAULT ''");
  ensureColumn('series_episodes', 'xui_id', 'INTEGER');
  ensureColumn('categories', 'xui_id', 'INTEGER');
  ensureColumn('bouquets', 'series_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('bouquets', 'xui_id', 'INTEGER');
  ensureColumn('lines', 'xui_id', 'INTEGER');
  ensureColumn('users', 'xui_id', 'INTEGER');
  ensureColumn('channels_247', 'engine_mode', "TEXT NOT NULL DEFAULT 'virtual'");
  ensureColumn('epg_sources', 'program_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('epg_programs', 'source_id', 'INTEGER');

  // Ensure every LB server has a unique Edge API token
  const serversWithoutToken = db.prepare("SELECT id FROM servers WHERE api_token IS NULL OR api_token = ''").all();
  for (const s of serversWithoutToken) {
    db.prepare('UPDATE servers SET api_token = ? WHERE id = ?').run(crypto.randomBytes(16).toString('hex'), s.id);
  }

  const adminCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (adminCount === 0) {
    seedInitialData();
  }

  // Automatic one-time cleanup of legacy demo seed data on existing installations
  const cleanV22 = db.prepare("SELECT value FROM settings WHERE key = 'clean_panel_v22'").get();
  if (cleanV22?.value !== 'true') {
    cleanLegacyDemoSeedOnce();
  }

  // Ensure panel branding is cleanly TVLister 24/7 on upgraded databases
  const legacyBrandToken = ['Mid', 'night'].join('');
  db.prepare("UPDATE settings SET value = 'TVLister 24/7 Panel' WHERE key = 'panel_name' AND value LIKE ?").run(
    `%${legacyBrandToken}%`
  );
  // One-time migration: set Zero Latency / Low-Latency FFmpeg profile to 2.5 Mbps (2500k) & 2500 kbps default
  const zeroLatMigrated = db.prepare("SELECT value FROM settings WHERE key = 'zero_latency_2500k_v1'").get();
  if (zeroLatMigrated?.value !== 'true') {
    db.prepare(`
      UPDATE transcode_profiles
         SET name = 'NVIDIA NVENC Zero-Latency 2.5 Mbps',
             video_bitrate = '2500k',
             audio_bitrate = '128k',
             extra_flags = '-rc cbr -zerolatency 1 -maxrate 2500k -bufsize 5000k'
       WHERE LOWER(name) LIKE '%nvenc%' AND (LOWER(name) LIKE '%latency%' OR LOWER(name) LIKE '%zero%')
    `).run();

    db.prepare(`
      UPDATE transcode_profiles
         SET video_bitrate = '2500k',
             audio_bitrate = '128k'
       WHERE LOWER(name) LIKE '%zero%' AND LOWER(name) NOT LIKE '%direct%' AND LOWER(name) NOT LIKE '%nvenc%'
    `).run();

    const hasCpuZeroLat = db
      .prepare("SELECT id FROM transcode_profiles WHERE LOWER(name) LIKE '%zero latency 2.5%' LIMIT 1")
      .get();
    if (!hasCpuZeroLat) {
      db.prepare(`
        INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags)
        VALUES ('Zero Latency 2.5 Mbps (H.264 CPU)', 'libx264', 'aac', '2500k', '128k', '1280x720', 'ultrafast', 'none', '-tune zerolatency -maxrate 2500k -bufsize 5000k')
      `).run();
    }

    db.prepare('UPDATE streams SET bitrate_kbps = 2500 WHERE bitrate_kbps = 4200 OR bitrate_kbps = 4000').run();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('zero_latency_2500k_v1', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'"
    ).run();
  }

  // Ensure "Copy/Copy Remux 2.5 Mbps (Zero CPU)" profile & Offline Loop Slate defaults exist on all installations
  const copy2500Migrated = db.prepare("SELECT value FROM settings WHERE key = 'copy_copy_2500k_v1'").get();
  if (copy2500Migrated?.value !== 'true') {
    const hasCopy2500 = db
      .prepare("SELECT id FROM transcode_profiles WHERE LOWER(name) LIKE '%copy/copy%' OR LOWER(name) LIKE '%copy copy%' LIMIT 1")
      .get();
    if (!hasCopy2500) {
      db.prepare(`
        INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags)
        VALUES ('Copy/Copy Remux 2.5 Mbps (Zero CPU)', 'copy', 'copy', '2500k', 'copy', 'source', 'none', 'none', '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024')
      `).run();
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_slate_enabled', 'true')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_slate_type', 'builtin')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_slate_url', '')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('offline_slate_text', 'SEÑAL EN RECONEXIÓN - VOLVEMOS EN BREVE')").run();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('copy_copy_2500k_v1', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'"
    ).run();
  }

  // Ensure Auto-Resolution Tier Profiles exist: SD/480p/540p -> 1.0 Mbps (1000k), HD 720p -> 2.5 Mbps (2500k), FHD 1080p -> 3.0 Mbps (3000k)
  const autoResMigrated = db.prepare("SELECT value FROM settings WHERE key = 'auto_res_tiers_1m_25m_3m_v1'").get();
  if (autoResMigrated?.value !== 'true') {
    const ensureProfileByName = (name, vCodec, aCodec, vBr, aBr, res, preset, hw, extra) => {
      const existing = db.prepare('SELECT id FROM transcode_profiles WHERE name = ? LIMIT 1').get(name);
      if (!existing) {
        db.prepare(
          'INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(name, vCodec, aCodec, vBr, aBr, res, preset, hw, extra);
      }
    };

    ensureProfileByName(
      'Auto SD/480p/540p — 1.0 Mbps',
      'libx264',
      'aac',
      '1000k',
      '96k',
      'source',
      'ultrafast',
      'none',
      '-vf scale=min(960\\,iw):-2 -tune zerolatency -maxrate 1000k -bufsize 2000k'
    );
    ensureProfileByName(
      'Auto HD 720p — 2.5 Mbps',
      'libx264',
      'aac',
      '2500k',
      '128k',
      '1280x720',
      'ultrafast',
      'none',
      '-tune zerolatency -maxrate 2500k -bufsize 5000k'
    );
    ensureProfileByName(
      'Auto FHD 1080p — 3.0 Mbps',
      'libx264',
      'aac',
      '3000k',
      '128k',
      '1920x1080',
      'ultrafast',
      'none',
      '-tune zerolatency -maxrate 3000k -bufsize 6000k'
    );

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('auto_res_tiers_1m_25m_3m_v1', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'"
    ).run();
  }

  // Backfill sequential sort_order (1..N) for existing streams, channels_247, and categories
  const sortOrderMigrated = db.prepare("SELECT value FROM settings WHERE key = 'streams_sort_order_v1'").get();
  if (sortOrderMigrated?.value !== 'true') {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const zeroStreams = db.prepare('SELECT id FROM streams WHERE sort_order = 0 ORDER BY id ASC').all();
      let maxStreamOrd = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM streams').get()?.m || 0;
      const updStreamOrd = db.prepare('UPDATE streams SET sort_order = ? WHERE id = ?');
      for (const r of zeroStreams) {
        maxStreamOrd += 1;
        updStreamOrd.run(maxStreamOrd, r.id);
      }

      const zeroCh = db.prepare('SELECT id FROM channels_247 WHERE sort_order = 0 ORDER BY id ASC').all();
      let maxChOrd = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM channels_247').get()?.m || 0;
      const updChOrd = db.prepare('UPDATE channels_247 SET sort_order = ? WHERE id = ?');
      for (const r of zeroCh) {
        maxChOrd += 1;
        updChOrd.run(maxChOrd, r.id);
      }

      const zeroCats = db.prepare('SELECT id FROM categories WHERE sort_order = 0 ORDER BY id ASC').all();
      let maxCatOrd = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM categories').get()?.m || 0;
      const updCatOrd = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
      for (const r of zeroCats) {
        maxCatOrd += 1;
        updCatOrd.run(maxCatOrd, r.id);
      }

      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('streams_sort_order_v1', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'"
      ).run();
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  // Ensure Hybrid Low-CPU Profile ("Copy Video + Audio Nivelado (Bajo CPU)") & Audio Leveling settings exist
  const audioLevelMigrated = db.prepare("SELECT value FROM settings WHERE key = 'copy_video_leveled_audio_v1'").get();
  if (audioLevelMigrated?.value !== 'true') {
    const existingHybrid = db
      .prepare("SELECT id FROM transcode_profiles WHERE LOWER(name) LIKE '%copy video + audio nivelado%' LIMIT 1")
      .get();
    if (!existingHybrid) {
      db.prepare(
        `INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags)
         VALUES ('Copy Video + Audio Nivelado (Bajo CPU)', 'copy', 'aac', 'source', '128k', 'source', 'none', 'none', '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024')`
      ).run();
    }
    const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insSetting.run('audio_leveling_enabled', 'false');
    insSetting.run('audio_leveling_preset', 'standard');
    insSetting.run('audio_leveling_bitrate', '128k');
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('copy_video_leveled_audio_v1', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'"
    ).run();
  }
}

function sanitizeJsonIdArray(rawJson, validIdsSet) {
  try {
    const parsed = JSON.parse(rawJson || '[]');
    if (!Array.isArray(parsed)) return '[]';
    return JSON.stringify(parsed.map(Number).filter((id) => validIdsSet.has(id)));
  } catch {
    return '[]';
  }
}

export function cleanLegacyDemoSeedOnce() {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      DELETE FROM active_connections
      WHERE username IN ('demo', 'hotel_suite_101', 'cliente_managua', 'enigma_box_01');

      DELETE FROM client_claims
      WHERE line_username = 'cliente_managua';

      DELETE FROM osd_messages
      WHERE message LIKE 'Bienvenido a TVLister 24/7%';

      DELETE FROM firewall_rules
      WHERE value IN ('203.0.113.99');

      DELETE FROM epg_programs
      WHERE channel_epg_id IN ('bbb.hd.tv', 'sintel.cinema.tv', 'tos.scifi.tv', 'abr.test.tv');

      UPDATE epg_sources
      SET xmltv_url = '/xmltv.php'
      WHERE xmltv_url = '/xmltv.php?username=demo&password=demo123';

      DELETE FROM series_episodes
      WHERE series_id IN (SELECT id FROM series WHERE title = 'Crónicas Blender Open Studio')
         OR source_url LIKE '%commondatastorage.googleapis.com/gtv-videos-bucket/sample/%';

      DELETE FROM series
      WHERE title = 'Crónicas Blender Open Studio';

      DELETE FROM vod_items
      WHERE source_url LIKE '%commondatastorage.googleapis.com/gtv-videos-bucket/sample/%';

      DELETE FROM channels_247
      WHERE playlist_json LIKE '%gtv-videos-bucket/sample/%';

      DELETE FROM streams
      WHERE source_url IN (
        'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
        'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
        'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8'
      );

      DELETE FROM lines
      WHERE username IN ('demo', 'hotel_suite_101', 'cliente_managua', 'enigma_box_01');

      DELETE FROM users
      WHERE username = 'reseller_latam'
        AND role = 'reseller'
        AND id NOT IN (SELECT DISTINCT owner_id FROM lines WHERE owner_id IS NOT NULL);

      DELETE FROM servers
      WHERE host IN ('lb-us-east.tvlister.internal', 'lb-eu-ams.tvlister.internal')
        AND is_main = 0;

      UPDATE servers
      SET cpu_usage = 0, ram_usage = 0, bandwidth_mbps = 0
      WHERE is_main = 1 AND host = '0.0.0.0';

      DELETE FROM bouquets
      WHERE name IN ('Paquete Básico + 24/7', 'Paquete Hospitalidad / Hotel TV');
    `);

    const demoCatNames = [
      'Entretenimiento HD',
      'Cine & Cultura',
      'Tecnología & Pruebas ABR',
      'Canales 24/7 Cine Continuo',
      'Canales 24/7 Animación',
      'Películas Open Cinema',
      'Ciencia Ficción & Acción',
      'Series & Antologías HD'
    ];
    const findCatRefs = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM streams WHERE category_id = ?) +
        (SELECT COUNT(*) FROM channels_247 WHERE category_id = ?) +
        (SELECT COUNT(*) FROM vod_items WHERE category_id = ?) +
        (SELECT COUNT(*) FROM series WHERE category_id = ?) AS refs
    `);
    const delCat = db.prepare('DELETE FROM categories WHERE id = ?');
    for (const catName of demoCatNames) {
      const cats = db.prepare('SELECT id FROM categories WHERE name = ?').all(catName);
      for (const c of cats) {
        const { refs } = findCatRefs.get(c.id, c.id, c.id, c.id);
        if (!refs) delCat.run(c.id);
      }
    }

    const validStreams = new Set(db.prepare('SELECT id FROM streams').all().map((r) => Number(r.id)));
    const validCh247 = new Set(db.prepare('SELECT id FROM channels_247').all().map((r) => Number(r.id)));
    const validVod = new Set(db.prepare('SELECT id FROM vod_items').all().map((r) => Number(r.id)));
    const validSeries = new Set(db.prepare('SELECT id FROM series').all().map((r) => Number(r.id)));

    const bouquets = db.prepare('SELECT * FROM bouquets').all();
    const updBouquet = db.prepare(`
      UPDATE bouquets
      SET name = ?, description = ?, stream_ids_json = ?, channel247_ids_json = ?, vod_ids_json = ?, series_ids_json = ?
      WHERE id = ?
    `);
    for (const b of bouquets) {
      const sJson = sanitizeJsonIdArray(b.stream_ids_json, validStreams);
      const cJson = sanitizeJsonIdArray(b.channel247_ids_json, validCh247);
      const vJson = sanitizeJsonIdArray(b.vod_ids_json, validVod);
      const srJson = sanitizeJsonIdArray(b.series_ids_json, validSeries);
      const isLegacyDefault = b.id === 1 && b.name === 'Paquete Full Total VIP';
      updBouquet.run(
        isLegacyDefault ? 'Bouquet General' : b.name,
        isLegacyDefault ? 'Paquete principal del panel' : b.description,
        sJson,
        cJson,
        vJson,
        srJson,
        b.id
      );
    }

    if (bouquets.length === 0) {
      db.prepare(
        "INSERT INTO bouquets (id, name, description, stream_ids_json, channel247_ids_json, vod_ids_json, series_ids_json, sort_order) VALUES (1, 'Bouquet General', 'Paquete principal del panel', '[]', '[]', '[]', '[]', 1)"
      ).run();
    }

    db.exec(`
      INSERT INTO settings (key, value) VALUES ('clean_panel_v22', 'true')
        ON CONFLICT(key) DO UPDATE SET value = 'true';
      INSERT INTO settings (key, value) VALUES ('demo_purged', 'true')
        ON CONFLICT(key) DO UPDATE SET value = 'true';
    `);
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    console.error('[TVLister DB] cleanLegacyDemoSeedOnce error:', err.message);
  }
}

export function resetPanelCatalog({ wipeCategories = true, wipeResellers = true } = {}) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      DELETE FROM active_connections;
      DELETE FROM client_claims;
      DELETE FROM osd_messages;
      DELETE FROM series_episodes;
      DELETE FROM series;
      DELETE FROM vod_items;
      DELETE FROM vod_watch_folders;
      DELETE FROM channels_247;
      DELETE FROM ingest_endpoints;
      DELETE FROM streams;
      DELETE FROM lines;
      DELETE FROM epg_programs;
    `);
    if (wipeResellers) {
      db.exec("DELETE FROM users WHERE role = 'reseller';");
    }
    if (wipeCategories) {
      db.exec('DELETE FROM categories;');
      db.exec('DELETE FROM bouquets WHERE id != 1;');
    }
    db.exec(`
      INSERT INTO bouquets (id, name, description, stream_ids_json, channel247_ids_json, vod_ids_json, series_ids_json, sort_order)
      VALUES (1, 'Bouquet General', 'Paquete principal del panel', '[]', '[]', '[]', '[]', 1)
      ON CONFLICT(id) DO UPDATE SET
        stream_ids_json = '[]',
        channel247_ids_json = '[]',
        vod_ids_json = '[]',
        series_ids_json = '[]';

      INSERT INTO settings (key, value) VALUES ('clean_panel_v22', 'true')
        ON CONFLICT(key) DO UPDATE SET value = 'true';
      INSERT INTO settings (key, value) VALUES ('demo_purged', 'true')
        ON CONFLICT(key) DO UPDATE SET value = 'true';
    `);
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
}

function seedInitialData() {
  // Clean Production Panel Seed — Only essential system records, zero demo channels/lines
  db.prepare(
    'INSERT INTO users (username, password_hash, role, credits, email, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('admin', hashPassword('admin123'), 'admin', 999999, 'admin@tvlister247.local', 'active', 'Super Administrador Principal');

  const insertProf = db.prepare(
    'INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insertProf.run('Direct Stream (Zero Transcode)', 'copy', 'copy', 'source', 'source', 'source', 'none', 'none', '-fflags +genpts+igndts');
  insertProf.run('Copy/Copy Remux 2.5 Mbps (Zero CPU)', 'copy', 'copy', '2500k', 'copy', 'source', 'none', 'none', '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024');
  insertProf.run('Copy Video + Audio Nivelado (Bajo CPU)', 'copy', 'aac', 'source', '128k', 'source', 'none', 'none', '-fflags +genpts+igndts+nobuffer -max_muxing_queue_size 1024');
  insertProf.run('Auto SD/480p/540p — 1.0 Mbps', 'libx264', 'aac', '1000k', '96k', 'source', 'ultrafast', 'none', '-vf scale=min(960\\,iw):-2 -tune zerolatency -maxrate 1000k -bufsize 2000k');
  insertProf.run('Auto HD 720p — 2.5 Mbps', 'libx264', 'aac', '2500k', '128k', '1280x720', 'ultrafast', 'none', '-tune zerolatency -maxrate 2500k -bufsize 5000k');
  insertProf.run('Auto FHD 1080p — 3.0 Mbps', 'libx264', 'aac', '3000k', '128k', '1920x1080', 'ultrafast', 'none', '-tune zerolatency -maxrate 3000k -bufsize 6000k');
  insertProf.run('Zero Latency 2.5 Mbps (H.264 CPU)', 'libx264', 'aac', '2500k', '128k', '1280x720', 'ultrafast', 'none', '-tune zerolatency -maxrate 2500k -bufsize 5000k');
  insertProf.run('NVIDIA NVENC Zero-Latency 2.5 Mbps', 'h264_nvenc', 'aac', '2500k', '128k', '1920x1080', 'p2', 'nvenc', '-rc cbr -zerolatency 1 -maxrate 2500k -bufsize 5000k');
  insertProf.run('Full HD 1080p H.264 (CPU Fast)', 'libx264', 'aac', '4000k', '128k', '1920x1080', 'veryfast', 'none', '-g 50 -sc_threshold 0');
  insertProf.run('Intel QuickSync QSV 720p Eco', 'h264_qsv', 'aac', '2500k', '128k', '1280x720', 'faster', 'qsv', '-look_ahead 0');

  db.prepare(
    'INSERT INTO servers (name, host, port, is_main, status, lb_mode, max_clients, cpu_usage, ram_usage, bandwidth_mbps, stalker_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('Core Master Node #1', '0.0.0.0', 8080, 1, 'online', 'load', 5000, 0, 0, 0, 1);

  db.prepare(
    'INSERT INTO bouquets (name, description, stream_ids_json, channel247_ids_json, vod_ids_json, series_ids_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('Bouquet General', 'Paquete principal del panel', '[]', '[]', '[]', '[]', 1);

  const insertPkg = db.prepare(
    'INSERT INTO packages (name, is_trial, duration_days, cost_credits, max_connections, bouquet_ids_json) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertPkg.run('Prueba 24 Horas', 1, 1, 0, 1, '[1]');
  insertPkg.run('Plan Mensual (1 Mes)', 0, 30, 1, 2, '[1]');
  insertPkg.run('Plan Trimestral (3 Meses)', 0, 90, 3, 3, '[1]');
  insertPkg.run('Plan Anual (12 Meses)', 0, 365, 10, 4, '[1]');

  db.prepare('INSERT INTO epg_sources (name, xmltv_url, status) VALUES (?, ?, ?)').run(
    'EPG Interno Dinámico TVLister 24/7',
    '/xmltv.php',
    'synced'
  );

  db.prepare('INSERT INTO firewall_rules (rule_type, value, action, description) VALUES (?, ?, ?, ?)').run(
    'user_agent',
    'python-requests/scanner',
    'block',
    'Bloqueo automático de escáneres de restreaming'
  );

  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('panel_name', 'TVLister 24/7 Panel');
  insertSetting.run('server_timezone', 'UTC');
  insertSetting.run('stalker_key', crypto.randomBytes(16).toString('hex'));
  insertSetting.run('anti_restreaming', 'true');
  insertSetting.run('proxy_direct_ts', 'true');
  insertSetting.run('default_output_format', 'hls');
  insertSetting.run('flood_limit_per_min', '240');
  insertSetting.run('clean_panel_v22', 'true');
  insertSetting.run('demo_purged', 'true');
}

initDb();
