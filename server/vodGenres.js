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

// ============================================================================
// LIMPIEZA DE CATEGORÍAS DEL CATÁLOGO
// ============================================================================
//
// Al sincronizar en modo «por carpeta del disco» cada subcarpeta crea su
// categoría (Ciencia Ficcion/, triller/, accion/…). Si después se cambia a
// «por género de TMDB», esas categorías se quedan ahí vacías o con las pocas
// películas que TMDB no supo clasificar. Estas dos funciones listan lo que hay
// y borran lo que sobra sin dejar películas ni series huérfanas.

const CATEGORY_SCOPE = "type IN ('vod', 'series')";

/** Cuántas películas y series tiene cada categoría de VOD/series. */
export function vodCategoryUsage() {
  const cats = db
    .prepare(`SELECT id, name, type, sort_order FROM categories WHERE ${CATEGORY_SCOPE} ORDER BY sort_order ASC, name ASC`)
    .all();
  const movieRows = db
    .prepare('SELECT category_id, COUNT(*) AS n FROM vod_items WHERE category_id IS NOT NULL GROUP BY category_id')
    .all();
  const seriesRows = db
    .prepare('SELECT category_id, COUNT(*) AS n FROM series WHERE category_id IS NOT NULL GROUP BY category_id')
    .all();
  const moviesByCat = new Map(movieRows.map((r) => [Number(r.category_id), Number(r.n)]));
  const seriesByCat = new Map(seriesRows.map((r) => [Number(r.category_id), Number(r.n)]));

  const categories = cats.map((c) => {
    const movies = moviesByCat.get(Number(c.id)) || 0;
    const series = seriesByCat.get(Number(c.id)) || 0;
    return {
      id: Number(c.id),
      name: c.name,
      type: c.type,
      sort_order: Number(c.sort_order) || 0,
      movies,
      series,
      total: movies + series,
      empty: movies + series === 0
    };
  });

  // Carpetas que siguen en «cada subcarpeta es una categoría»: si se borran sus
  // categorías, el próximo escaneo las vuelve a crear. Se avisa en el panel.
  let subfolderFolders = [];
  try {
    subfolderFolders = db
      .prepare(
        "SELECT id, folder_path, category_mode FROM vod_watch_folders WHERE LOWER(COALESCE(category_mode,'')) = 'subfolders' ORDER BY folder_path"
      )
      .all()
      .map((f) => ({ id: Number(f.id), path: f.folder_path, category_mode: f.category_mode }));
  } catch {
    subfolderFolders = [];
  }

  return {
    categories,
    total: categories.length,
    empty: categories.filter((c) => c.empty).length,
    withContent: categories.filter((c) => !c.empty).length,
    subfolderFolders
  };
}

/**
 * Borra categorías de películas/series.
 *
 * - Sin `moveToId` sólo se borran las vacías: si alguna tiene contenido se
 *   devuelve `ok:false` con la lista de bloqueadas (nunca se dejan huérfanas).
 * - Con `moveToId` se mueve antes el contenido (películas, series y el destino
 *   por defecto de las carpetas monitoreadas) y luego se borran.
 */
export function purgeVodCategories({ ids, moveToId } = {}) {
  const clean = Array.from(
    new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))
  );
  if (!clean.length) throw new Error('No hay categorías seleccionadas');

  const marks = clean.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, name, type FROM categories WHERE id IN (${marks}) AND ${CATEGORY_SCOPE}`)
    .all(...clean);
  if (!rows.length) throw new Error('Esas categorías no existen (o no son de películas/series)');

  const idsOk = rows.map((r) => Number(r.id));
  const target =
    moveToId === null || moveToId === undefined || String(moveToId).trim() === '' ? null : Number(moveToId);
  if (target && idsOk.includes(target)) {
    throw new Error('La categoría de destino no puede ser una de las que se van a borrar');
  }
  if (target && !db.prepare('SELECT id FROM categories WHERE id = ?').get(target)) {
    throw new Error(`La categoría de destino (id ${target}) no existe`);
  }

  const usage = vodCategoryUsage().categories.filter((c) => idsOk.includes(c.id));
  const blocked = usage.filter((c) => c.total > 0);
  if (blocked.length && !target) {
    return { ok: false, blocked, deleted: 0, deletedNames: [], moved: { movies: 0, series: 0 } };
  }

  const ph = idsOk.map(() => '?').join(',');
  const onlyOk = idsOk.filter((id) => id !== target);
  const phOk = onlyOk.map(() => '?').join(',');
  let movedMovies = 0;
  let movedSeries = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (target) {
      movedMovies = Number(
        db.prepare(`UPDATE vod_items SET category_id = ? WHERE category_id IN (${ph})`).run(target, ...idsOk).changes || 0
      );
      movedSeries = Number(
        db.prepare(`UPDATE series SET category_id = ? WHERE category_id IN (${ph})`).run(target, ...idsOk).changes || 0
      );
    }
    // Carpetas monitoreadas: su categoría por defecto pasa al destino (o se
    // queda sin ella). Así el siguiente sync no apunta a una categoría borrada.
    db.prepare(`UPDATE vod_watch_folders SET default_category_id = ? WHERE default_category_id IN (${ph})`).run(
      target,
      ...idsOk
    );
    const deleted = Number(db.prepare(`DELETE FROM categories WHERE id IN (${phOk})`).run(...onlyOk).changes || 0);
    db.exec('COMMIT;');
    return {
      ok: true,
      deleted,
      deletedNames: rows.filter((r) => Number(r.id) !== target).map((r) => r.name),
      moved: { movies: movedMovies, series: movedSeries },
      moveToId: target
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
}
