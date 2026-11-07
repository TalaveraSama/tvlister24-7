// Categorías de VOD a partir del GÉNERO que dice TMDB.
//
// Todo lo de aquí es lógica pura (sin Node, sin base de datos, sin red) para
// poder probarla con `node scripts/test_vod_genres.mjs` y para que el panel y el
// servidor usen exactamente las mismas reglas al mostrar la vista previa.

/**
 * Nombres de género de TMDB que no coinciden con el nombre que el cliente
 * espera ver en su lista. Se pueden cambiar desde el panel («Renombrar
 * géneros»); esto es sólo el punto de partida.
 *
 * TMDB en español devuelve «Suspense» (el género 53) y «Romance» (10749); en el
 * panel quedan como «Thriller» y «Románticas», que es como los pide el cliente.
 */
export const DEFAULT_GENRE_ALIASES = {
  Suspense: 'Thriller',
  Suspenso: 'Thriller',
  Romance: 'Románticas'
};

/** Minúsculas, sin acentos y con espacios simples: «Ciencia Ficción» == «ciencia ficcion». */
export function normalizeGenre(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Lee el cuadro de «Renombrar géneros»: una regla por línea, `TMDB = Categoría`.
 * Se acepta `=`, `=>` o `→`. Las líneas vacías y las que empiezan por `#` se
 * ignoran para poder dejar comentarios.
 */
export function parseAliasLines(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s*(?:=>|=|→)\s*/);
    if (parts.length < 2) continue;
    const from = parts[0].trim();
    const to = parts.slice(1).join(' = ').trim();
    if (from && to) out[from] = to;
  }
  return out;
}

/** El mismo cuadro, en texto, para volver a pintarlo al abrir el panel. */
export function formatAliasLines(aliases) {
  return Object.entries(aliases || {})
    .filter(([from, to]) => from && to)
    .map(([from, to]) => `${from} = ${to}`)
    .join('\n');
}

/**
 * Deja la configuración lista para usar: alias del cliente encima de los de
 * fábrica y la lista de prioridad limpia.
 */
export function buildGenreConfig({ aliases, priority } = {}) {
  const merged = { ...DEFAULT_GENRE_ALIASES, ...(aliases || {}) };
  const prio = (Array.isArray(priority) ? priority : String(priority ?? '').split(','))
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);
  return { aliases: merged, priority: prio };
}

/** Nombre de categoría para un género de TMDB, aplicando el renombrado. */
export function aliasForGenre(genre, config = {}) {
  const name = String(genre ?? '').trim();
  if (!name) return '';
  const target = normalizeGenre(name);
  for (const [from, to] of Object.entries(config.aliases || {})) {
    if (normalizeGenre(from) === target) return String(to).trim() || name;
  }
  return name;
}

/**
 * Categoría final de una película/serie según los géneros que devuelve TMDB.
 *
 * - `genres` viene en el ORDEN de TMDB: el primero es el género principal.
 * - Si el cliente fijó una **prioridad** («Románticas, Terror»), el primer
 *   género de esa lista que aparezca en la ficha manda; así una película
 *   «Comedia, Romance» puede ir a Románticas aunque TMDB diga Comedia primero.
 * - Sin prioridad: el género principal de TMDB.
 * - Sin géneros: cadena vacía (la película se queda donde estaba).
 */
export function resolveGenreCategoryName(genres, config = {}) {
  const list = (Array.isArray(genres) ? genres : [genres])
    .map((g) => String(g ?? '').trim())
    .filter(Boolean);
  if (list.length === 0) return '';

  for (const preferred of config.priority || []) {
    const wanted = normalizeGenre(preferred);
    if (!wanted) continue;
    // Se compara con el género de TMDB y también con el nombre final de la
    // categoría: da igual que el cliente escriba «Romance» o «Románticas».
    const hit = list.find(
      (g) => normalizeGenre(g) === wanted || normalizeGenre(aliasForGenre(g, config)) === wanted
    );
    if (hit) return aliasForGenre(hit, config);
  }
  return aliasForGenre(list[0], config);
}

/**
 * Agrupa el resultado de una clasificación: «Acción 120, Comedia 80…».
 * `items` son filas con `{ category }`.
 */
export function summarizeGenrePlan(items) {
  const counts = new Map();
  for (const item of items || []) {
    const name = String(item?.category ?? '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}
