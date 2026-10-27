// Biblioteca: escaneo de carpetas locales, importación de medios y estadísticas.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.mpg', '.mpeg', '.ts', '.m2ts',
  '.webm', '.flv', '.wmv', '.ogv', '.mp3', '.wav', '.aac', '.m4a', '.flac',
]);

const MAX_FILES = 3000;
const MAX_DEPTH = 8;

export function walkMedia(root, { recursive = true } = {}) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && found.length < MAX_FILES) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* ignore */ }
        found.push({ path: full, name: e.name, size, mtime, folder: dir });
        if (found.length >= MAX_FILES) break;
      }
    }
  }
  return found;
}

/** Estima la duración a partir de la categoría/nombre si no hay metadatos. */
function guessDuration(file, data) {
  const n = file.name.toLowerCase();
  if (/cortina|bumper|identidad|promo/.test(n)) return 15;
  if (/comercial|anuncio|spot|ad[-_ ]/.test(n)) return 30;
  return data.settings?.playout?.defaultDurationSec ?? 60;
}

export function importFiles(data, files, { category = '', genre = '', onDuplicate = 'skip' } = {}) {
  const existing = new Map(data.media.map((m) => [String(m.path).toLowerCase(), m]));
  const added = [];
  const skipped = [];
  for (const file of files) {
    const key = String(file.path).toLowerCase();
    if (existing.has(key)) {
      if (onDuplicate === 'skip') {
        skipped.push(file.path);
        continue;
      }
      if (onDuplicate === 'replace') {
        const m = existing.get(key);
        Object.assign(m, { title: path.parse(file.name).name, folderPath: file.folder, size: file.size });
        added.push(m);
        continue;
      }
    }
    const media = {
      id: randomUUID(),
      path: file.path,
      name: file.name,
      title: path.parse(file.name).name,
      duration: guessDuration(file, data),
      category,
      genre,
      season: null,
      episode: null,
      kind: /\.(mp3|wav|aac|m4a|flac)$/i.test(file.name) ? 'audio' : 'video',
      folderPath: file.folder,
      size: file.size ?? 0,
      addedAt: Date.now(),
    };
    data.media.push(media);
    existing.set(key, media);
    added.push(media);
  }
  return { added, skipped };
}

export function importFolder(data, folderPath, opts = {}) {
  if (!folderPath || typeof folderPath !== 'string') throw new Error('Ruta de carpeta inválida');
  const abs = path.resolve(folderPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`La carpeta no existe o no es accesible: ${folderPath}`);
  }
  if (!data.settings.mediaFolders.includes(abs)) data.settings.mediaFolders.push(abs);
  const files = walkMedia(abs, { recursive: opts.recursive !== false });
  if (!files.length) return { added: [], skipped: [], count: 0, path: abs };
  const res = importFiles(data, files, opts);
  return { ...res, count: res.added.length, path: abs, scanned: files.length };
}

export function cleanupMedia(data) {
  const missing = [];
  for (const m of data.media) {
    if (m.demo || String(m.path).startsWith('demo://')) continue;
    if (!fs.existsSync(m.path)) missing.push(m);
  }
  return missing;
}

export function libraryStats(data) {
  const totalSec = data.media.reduce((acc, m) => acc + (Number(m.duration) || 0), 0);
  const byCategory = {};
  for (const m of data.media) {
    const c = m.category || 'Sin categoría';
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  return {
    count: data.media.length,
    totalSeconds: totalSec,
    totalSize: data.media.reduce((acc, m) => acc + (Number(m.size) || 0), 0),
    byCategory,
    folders: data.settings.mediaFolders || [],
  };
}
