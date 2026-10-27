import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKUPS_DIR = path.resolve(__dirname, '../data/backups');

const BACKUP_TABLES = [
  'categories',
  'transcode_profiles',
  'servers',
  'streams',
  'channels_247',
  'vod_items',
  'series',
  'series_episodes',
  'bouquets',
  'packages',
  'lines',
  'epg_sources',
  'epg_programs',
  'firewall_rules',
  'settings'
];

export function buildFullBackupObject() {
  const dump = {
    exported_at: new Date().toISOString(),
    panel: 'TVLister 24/7 Midnight Edition',
    version: '2.0.0',
    data: {}
  };
  for (const t of BACKUP_TABLES) {
    try {
      dump.data[t] = db.prepare(`SELECT * FROM ${t}`).all();
    } catch {
      dump.data[t] = [];
    }
  }
  return dump;
}

export function createServerSnapshot(label = 'auto') {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'snap';
  const filename = `tvlister_${safeLabel}_${stamp}.json`;
  const filePath = path.join(BACKUPS_DIR, filename);

  const payload = JSON.stringify(buildFullBackupObject(), null, 2);
  fs.writeFileSync(filePath, payload, 'utf8');
  pruneOldSnapshots(10);

  return {
    filename,
    sizeKb: Math.max(1, Math.round(Buffer.byteLength(payload) / 1024)),
    created_at: now.toISOString()
  };
}

export function listServerSnapshots() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((filename) => {
      const full = path.join(BACKUPS_DIR, filename);
      const st = fs.statSync(full);
      return {
        filename,
        sizeKb: Math.max(1, Math.round(st.size / 1024)),
        created_at: st.mtime.toISOString()
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function readServerSnapshot(filename) {
  const safe = path.basename(filename);
  const full = path.join(BACKUPS_DIR, safe);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

export function deleteServerSnapshot(filename) {
  const safe = path.basename(filename);
  const full = path.join(BACKUPS_DIR, safe);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

function pruneOldSnapshots(maxKeep = 10) {
  const all = listServerSnapshots();
  if (all.length <= maxKeep) return;
  for (const old of all.slice(maxKeep)) {
    deleteServerSnapshot(old.filename);
  }
}

export function startAutomatedBackupScheduler() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (listServerSnapshots().length === 0) {
    try {
      createServerSnapshot('initial');
    } catch {
      // ignore
    }
  }
  const timer = setInterval(() => {
    try {
      createServerSnapshot('daily');
    } catch {
      // ignore
    }
  }, 24 * 3600 * 1000);
  timer.unref();
}
