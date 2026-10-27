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

export const DB_PATH = path.join(DATA_DIR, 'midnight_tvlister.db');
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
      max_clients INTEGER NOT NULL DEFAULT 1000,
      cpu_usage REAL NOT NULL DEFAULT 12.5,
      ram_usage REAL NOT NULL DEFAULT 28.4,
      bandwidth_mbps REAL NOT NULL DEFAULT 85.0,
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
      user_agent TEXT DEFAULT 'MidnightStreamer/5.3 (MPEG-TS; Linux)',
      tv_archive_days INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      bitrate_kbps INTEGER NOT NULL DEFAULT 4200,
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
  `);

  const adminCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (adminCount === 0) {
    seedInitialData();
  }
}

function seedInitialData() {
  // 1. Users (Admin + Demo Reseller)
  const insertUser = db.prepare(
    'INSERT INTO users (username, password_hash, role, credits, email, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertUser.run('admin', hashPassword('admin123'), 'admin', 999999, 'admin@tvlister247.local', 'active', 'Super Administrador Principal');
  insertUser.run('reseller_latam', hashPassword('reseller123'), 'reseller', 45, 'ventas@latamstream.local', 'active', 'Distribuidor Oficial Centroamérica');

  // 2. Categories
  const insertCat = db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, ?)');
  insertCat.run('Entretenimiento HD', 'live', 1);
  insertCat.run('Cine & Cultura', 'live', 2);
  insertCat.run('Tecnología & Pruebas ABR', 'live', 3);
  insertCat.run('Canales 24/7 Cine Continuo', 'channel247', 4);
  insertCat.run('Canales 24/7 Animación', 'channel247', 5);
  insertCat.run('Películas Open Cinema', 'vod', 6);
  insertCat.run('Ciencia Ficción & Acción', 'vod', 7);

  // 3. Transcode Profiles (Direct, CPU x264, NVIDIA NVENC, Intel QSV)
  const insertProf = db.prepare(
    'INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insertProf.run('Direct Stream (Zero Transcode)', 'copy', 'copy', 'source', 'source', 'source', 'none', 'none', '-fflags +genpts+igndts');
  insertProf.run('Full HD 1080p H.264 (CPU Fast)', 'libx264', 'aac', '4000k', '128k', '1920x1080', 'veryfast', 'none', '-g 50 -sc_threshold 0');
  insertProf.run('NVIDIA NVENC 1080p Low-Latency', 'h264_nvenc', 'aac', '4500k', '160k', '1920x1080', 'p4', 'nvenc', '-rc cbr -zerolatency 1');
  insertProf.run('Intel QuickSync QSV 720p Eco', 'h264_qsv', 'aac', '2200k', '128k', '1280x720', 'faster', 'qsv', '-look_ahead 0');

  // 4. Servers (Main + Load Balancers)
  const insertSrv = db.prepare(
    'INSERT INTO servers (name, host, port, is_main, status, lb_mode, max_clients, cpu_usage, ram_usage, bandwidth_mbps, stalker_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insertSrv.run('Core Master Node #1', '0.0.0.0', 8080, 1, 'online', 'load', 2500, 14.2, 31.8, 128.4, 1);
  insertSrv.run('Edge Load Balancer US-East', 'lb-us-east.tvlister.internal', 8080, 0, 'online', 'geoip', 5000, 22.7, 41.0, 340.2, 0);
  insertSrv.run('Edge Load Balancer EU-AMS', 'lb-eu-ams.tvlister.internal', 8080, 0, 'online', 'isp', 5000, 18.5, 35.2, 215.9, 0);

  // 5. Live Streams (Open, public, royalty-free HLS test feeds)
  const insertStream = db.prepare(`
    INSERT INTO streams (name, category_id, source_url, backup_url, logo_url, epg_channel_id, stream_mode, transcode_profile_id, server_id, status, tv_archive_days, bitrate_kbps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStream.run(
    'Big Buck Bunny Live HD',
    1,
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/220px-Big_buck_bunny_poster_big.jpg',
    'bbb.hd.tv',
    'direct',
    1,
    1,
    'running',
    3,
    4500
  );
  insertStream.run(
    'Sintel Open Cinema TV',
    2,
    'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Sintel_poster.jpg/220px-Sintel_poster.jpg',
    'sintel.cinema.tv',
    'direct',
    1,
    1,
    'running',
    7,
    5200
  );
  insertStream.run(
    'Tears of Steel Sci-Fi Live',
    2,
    'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
    '',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Tos-poster.png/220px-Tos-poster.png',
    'tos.scifi.tv',
    'ondemand',
    2,
    2,
    'running',
    3,
    6100
  );
  insertStream.run(
    'Apple Multi-Bitrate ABR Feed',
    3,
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    '',
    '',
    'abr.test.tv',
    'direct',
    1,
    1,
    'ondemand_idle',
    0,
    2800
  );

  // 6. VOD Library (Blender Open Movies MP4)
  const insertVod = db.prepare(`
    INSERT INTO vod_items (title, type, category_id, source_url, poster_url, plot, genre, release_year, rating, duration_sec, container_ext)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertVod.run(
    'Big Buck Bunny',
    'movie',
    6,
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/440px-Big_buck_bunny_poster_big.jpg',
    'Un conejo gigante de gran corazón se enfrenta a tres ardillas traviesas en el bosque. Cortometraje abierto de Blender Institute.',
    'Animación, Comedia',
    2008,
    8.1,
    596,
    'mp4'
  );
  insertVod.run(
    'Sintel',
    'movie',
    6,
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Sintel_poster.jpg/440px-Sintel_poster.jpg',
    'Una joven guerrera llamada Sintel emprende un peligroso viaje en busca de su pequeño dragón amigo Scales.',
    'Fantasía, Aventura',
    2010,
    8.5,
    888,
    'mp4'
  );
  insertVod.run(
    'Tears of Steel',
    'movie',
    7,
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Tos-poster.png/440px-Tos-poster.png',
    'En una Ámsterdam futurista, un grupo de guerreros y científicos intenta salvar el mundo de robots destructivos reviviendo un recuerdo clave.',
    'Ciencia Ficción, Acción',
    2012,
    8.0,
    734,
    'mp4'
  );
  insertVod.run(
    'Elephants Dream',
    'movie',
    7,
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Elephants_Dream_s5_both.jpg/440px-Elephants_Dream_s5_both.jpg',
    'Proog y Emo exploran las profundidades surrealistas de una gigantesca máquina viviente.',
    'Ciencia Ficción, Experimental',
    2006,
    7.6,
    653,
    'mp4'
  );

  // 7. 24/7 Custom Dynamic Channels
  const insertCh247 = db.prepare(`
    INSERT INTO channels_247 (name, category_id, logo_url, epg_channel_id, loop_mode, transcode_profile_id, server_id, watermark_text, status, playlist_json, schedule_anchor_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const playlistCine = JSON.stringify([
    {
      id: 'item-1',
      vod_id: 2,
      title: 'Sintel — Edición Especial HD',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      duration_sec: 888
    },
    {
      id: 'item-2',
      vod_id: 3,
      title: 'Tears of Steel — Sci-Fi Amsterdam',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      duration_sec: 734
    },
    {
      id: 'item-3',
      vod_id: 1,
      title: 'Big Buck Bunny — Clásico Animado',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      duration_sec: 596
    },
    {
      id: 'item-4',
      vod_id: 4,
      title: 'Elephants Dream — Proog & Emo',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      duration_sec: 653
    }
  ]);

  const playlistAnim = JSON.stringify([
    {
      id: 'anim-1',
      vod_id: 1,
      title: 'Big Buck Bunny — Maratón 24/7',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      duration_sec: 596
    },
    {
      id: 'anim-2',
      vod_id: 4,
      title: 'Elephants Dream — Mundo Máquina',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      duration_sec: 653
    },
    {
      id: 'anim-3',
      vod_id: 2,
      title: 'Sintel — Crónicas del Dragón',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      duration_sec: 888
    }
  ]);

  insertCh247.run(
    'TVLister Cine Abierto 24/7',
    4,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Sintel_poster.jpg/220px-Sintel_poster.jpg',
    'cine247.tvlister.tv',
    'loop',
    2,
    1,
    'TVLISTER 24/7 HD',
    'running',
    playlistCine,
    1704067200
  );

  insertCh247.run(
    'Midnight Animación 24/7',
    5,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/220px-Big_buck_bunny_poster_big.jpg',
    'anim247.tvlister.tv',
    'loop',
    2,
    1,
    'ANIM 24/7',
    'running',
    playlistAnim,
    1704069000
  );

  // 8. Bouquets
  const insertBouquet = db.prepare(
    'INSERT INTO bouquets (name, description, stream_ids_json, channel247_ids_json, vod_ids_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertBouquet.run('Paquete Full Total VIP', 'Acceso completo a Canales en Vivo, Canales 24/7 y Catálogo VOD', '[1,2,3,4]', '[1,2]', '[1,2,3,4]', 1);
  insertBouquet.run('Paquete Básico + 24/7', 'Canales principales y señal continua 24/7', '[1,2]', '[1,2]', '[1,2]', 2);
  insertBouquet.run('Paquete Hospitalidad / Hotel TV', 'Selección para hoteles, salas de espera y circuitos corporativos', '[1,2,3]', '[1]', '[1,2,3]', 3);

  // 9. Reseller Packages
  const insertPkg = db.prepare(
    'INSERT INTO packages (name, is_trial, duration_days, cost_credits, max_connections, bouquet_ids_json) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertPkg.run('Demo Prueba 24 Horas', 1, 1, 0, 1, '[1]');
  insertPkg.run('Plan Mensual VIP (1 Mes)', 0, 30, 1, 2, '[1]');
  insertPkg.run('Plan Trimestral Familiar (3 Meses)', 0, 90, 3, 3, '[1]');
  insertPkg.run('Plan Anual Premium (12 Meses)', 0, 365, 10, 4, '[1]');

  // 10. Subscriber Lines & Devices
  const insertLine = db.prepare(`
    INSERT INTO lines (username, password, owner_id, exp_date, max_connections, is_trial, status, device_type, mac_address, bouquet_ids_json, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertLine.run('demo', 'demo123', 1, '2027-12-31T23:59:59Z', 3, 0, 'active', 'm3u', '', '[1]', 'Cuenta Demo Principal (WebTV / M3U / Xtream API)');
  insertLine.run('hotel_suite_101', 'suite101', 1, '2027-06-30T23:59:59Z', 5, 0, 'active', 'mag', '00:1A:79:4B:88:10', '[1,3]', 'STB MAG Habitación 101');
  insertLine.run('cliente_managua', 'nic2026', 2, '2026-12-15T23:59:59Z', 2, 0, 'active', 'm3u', '', '[1]', 'Cliente Reseller Latam');
  insertLine.run('enigma_box_01', 'sat2026', 1, '2027-03-01T23:59:59Z', 1, 0, 'active', 'enigma2', '00:09:34:AA:12:4F', '[2]', 'Receptor Enigma2 Sala');

  // 11. Active Connections (Realistic telemetry)
  const insertConn = db.prepare(`
    INSERT INTO active_connections (line_id, username, target_type, target_id, target_name, ip_address, country, isp, user_agent, protocol, server_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertConn.run(1, 'demo', 'channel247', 1, 'TVLister Cine Abierto 24/7', '190.212.44.18', 'NI', 'Claro Nicaragua', 'MidnightStreamer WebTV/5.3', 'HLS', 1);
  insertConn.run(2, 'hotel_suite_101', 'live', 1, 'Big Buck Bunny Live HD', '186.77.120.9', 'NI', 'Tigo Business', 'MAG254/StalkerMiddleware', 'MPEG-TS', 1);
  insertConn.run(3, 'cliente_managua', 'live', 2, 'Sintel Open Cinema TV', '190.184.22.104', 'CR', 'Kolbi ICE', 'TiviMate/4.7.0 (Android TV)', 'HLS', 2);

  // 12. EPG Sources & Programs
  db.prepare('INSERT INTO epg_sources (name, xmltv_url, status) VALUES (?, ?, ?)').run(
    'EPG Interno Dinámico TVLister 24/7',
    '/xmltv.php?username=demo&password=demo123',
    'synced'
  );

  const now = new Date();
  const startIso = new Date(now.getTime() - 15 * 60000).toISOString();
  const midIso = new Date(now.getTime() + 45 * 60000).toISOString();
  const endIso = new Date(now.getTime() + 105 * 60000).toISOString();
  const insertEpg = db.prepare(
    'INSERT INTO epg_programs (channel_epg_id, title, description, start_time, end_time, lang) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertEpg.run('bbb.hd.tv', 'Big Buck Bunny — Emisión Estelar', ' Transmisión continua en alta definición del clásico de animación abierta.', startIso, midIso, 'es');
  insertEpg.run('bbb.hd.tv', 'Detrás de Cámaras: Blender Studio', 'Documental técnico sobre el proceso de renderizado y animación 3D.', midIso, endIso, 'es');
  insertEpg.run('sintel.cinema.tv', 'Sintel: La Búsqueda de Scales', 'Aventura épica de fantasía producida por Blender Foundation.', startIso, midIso, 'es');
  insertEpg.run('tos.scifi.tv', 'Tears of Steel (4K Remaster)', 'Ciencia ficción y efectos visuales en Ámsterdam.', startIso, midIso, 'es');

  // 13. OSD Broadcast & Claims
  db.prepare('INSERT INTO osd_messages (target_line_id, message, display_seconds, style, active) VALUES (?, ?, ?, ?, ?)').run(
    null,
    'Bienvenido a TVLister 24/7 — Señal estable y programación continua activa.',
    12,
    'banner',
    0
  );

  db.prepare('INSERT INTO client_claims (line_username, stream_name, issue_type, message, status) VALUES (?, ?, ?, ?, ?)').run(
    'cliente_managua',
    'Apple Multi-Bitrate ABR Feed',
    'ondemand_standby',
    'Solicita activar el canal ABR en modo permanente.',
    'open'
  );

  // 14. Firewall Rules
  const insertFw = db.prepare('INSERT INTO firewall_rules (rule_type, value, action, description) VALUES (?, ?, ?, ?)');
  insertFw.run('user_agent', 'python-requests/scanner', 'block', 'Bloqueo automático de escáneres de restreaming');
  insertFw.run('ip', '203.0.113.99', 'block', 'IP de prueba bloqueada por exceso de intentos fallidos');

  // 15. General Settings
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('panel_name', 'TVLister 24/7 — Midnight Streamer Panel');
  insertSetting.run('server_timezone', 'UTC');
  insertSetting.run('stalker_key', crypto.randomBytes(16).toString('hex'));
  insertSetting.run('anti_restreaming', 'true');
  insertSetting.run('default_output_format', 'hls');
  insertSetting.run('flood_limit_per_min', '120');
}

initDb();
