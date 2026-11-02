import { db } from './db.js';
import {
  buildGenreConfig,
  formatAliasLines,
  parseAliasLines,
  DEFAULT_GENRE_ALIASES
} from '../src/lib/vodGenres.js';

/**
 * Categorías de VOD por género de TMDB: configuración y alta de categorías.
 *
 * El cliente pidió que el sincronizador de películas separe el catálogo en
 * Acción, Comedia, Terror, Thriller, Románticas… **según lo que diga TMDB**, no
 * según el nombre de la carpeta. La parte de red vive en `vodSyncTmdb.js`; aquí
 * sólo se guarda cómo se llaman esas categorías y se crean si no existen.
 */

const SETTING_ALIASES = 'vod_genre_aliases';
const SETTING_PRIORITY = 'vod_genre_priority';

function readJsonSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || !row.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

/**
 * Configuración efectiva: alias de fábrica + los que haya puesto el cliente y
 * la lista de prioridad.
 */
export function getGenreCategoryConfig() {
  const storedAliases = readJsonSetting(SETTING_ALIASES, null);
  const storedPriority = readJsonSetting(SETTING_PRIORITY, null);
  return buildGenreConfig({
    aliases: storedAliases && typeof storedAliases === 'object' ? storedAliases : {},
    priority: Array.isArray(storedPriority) ? storedPriority : []
  });
}

/** Lo que ve el panel: la configuración en texto editable. */
export function getGenreCategoryConfigForUi() {
  const cfg = getGenreCategoryConfig();
  const storedAliases = readJsonSetting(SETTING_ALIASES, null);
  const storedPriority = readJsonSetting(SETTING_PRIORITY, null);
  return {
    aliases: cfg.aliases,
    priority: cfg.priority,
    // Sólo lo que el cliente cambió: así «restaurar» vuelve a los de fábrica.
    customAliases: storedAliases && typeof storedAliases === 'object' ? storedAliases : {},
    defaults: DEFAULT_GENRE_ALIASES,
    aliasesText: formatAliasLines(cfg.aliases),
    priorityText: cfg.priority.join(', ')
  };
}

/**
 * Guarda lo que el cliente escribió. `aliasesText` es el cuadro
 * «TMDB = Categoría» y `priorityText` la lista «Románticas, Terror, …».
 * Enviar `resetAliases: true` vuelve a los alias de fábrica.
 */
export function saveGenreCategoryConfig({ aliasesText, priorityText, resetAliases } = {}) {
  if (resetAliases) {
    writeSetting(SETTING_ALIASES, '');
  } else if (aliasesText !== undefined) {
    const parsed = parseAliasLines(aliasesText);
    const onlyCustom = {};
    for (const [from, to] of Object.entries(parsed)) {
      // Los que son iguales al de fábrica no hace falta guardarlos.
      const dflt = Object.entries(DEFAULT_GENRE_ALIASES).find(
        ([k]) => k.toLowerCase() === String(from).toLowerCase()
      );
      if (dflt && dflt[1] === to) continue;
      onlyCustom[from] = to;
    }
    writeSetting(SETTING_ALIASES, JSON.stringify(onlyCustom));
  }
  if (priorityText !== undefined) {
    const list = String(priorityText ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    writeSetting(SETTING_PRIORITY, JSON.stringify(list));
  }
  return getGenreCategoryConfigForUi();
}

/**
 * Devuelve el id de la categoría `name` del tipo pedido, creándola si no
 * existe. `type` es `vod` (películas) o `series`.
 */
export function ensureVodCategory(name, type = 'vod') {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('La categoría necesita un nombre');
  const kind = type === 'series' ? 'series' : 'vod';
  const existing = db
    .prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1')
    .get(clean, kind);
  if (existing) return Number(existing.id);
  // sort_order 60: las categorías por género van después de las que creó el
  // cliente a mano (que nacen con orden 50 o menor).
  const info = db
    .prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, 60)')
    .run(clean, kind);
  return Number(info.lastInsertRowid);
}

/** Categorías de películas/series que existen hoy (para el panel). */
export function listVodCategories() {
  return db
    .prepare("SELECT id, name, type, sort_order FROM categories WHERE type IN ('vod', 'series') ORDER BY sort_order ASC, name ASC")
    .all();
}
