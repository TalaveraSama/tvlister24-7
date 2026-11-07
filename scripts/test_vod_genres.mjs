#!/usr/bin/env node
// Categorías por género de TMDB: lógica pura + recorrido real del panel contra
// un TMDB de mentira (búsqueda, ficha, clasificación y sincronizador de carpeta).
//
// Uso: node scripts/test_vod_genres.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};
const eq = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) fails += 1;
  console.log(`${same ? 'ok  ' : 'FALLO'} ${label}: ${JSON.stringify(got)}${same ? '' : ` != ${JSON.stringify(want)}`}`);
};

// ==================== 1. Lógica pura ====================
const {
  DEFAULT_GENRE_ALIASES,
  normalizeGenre,
  parseAliasLines,
  formatAliasLines,
  buildGenreConfig,
  resolveGenreCategoryName,
  summarizeGenrePlan
} = await import('../src/lib/vodGenres.js');

eq('normaliza acentos', normalizeGenre('  Ciencia Ficción '), 'ciencia ficcion');
eq('alias de fábrica de Suspense', DEFAULT_GENRE_ALIASES.Suspense, 'Thriller');
eq(
  'lee el cuadro de renombrado',
  parseAliasLines('Suspense = Thriller\n# comentario\nRomance => Románticas\nbasura'),
  { Suspense: 'Thriller', Romance: 'Románticas' }
);
eq(
  'vuelve a escribir el cuadro',
  formatAliasLines({ Suspense: 'Thriller', Romance: 'Románticas' }),
  'Suspense = Thriller\nRomance = Románticas'
);

const cfgDefecto = buildGenreConfig({});
eq('género principal de TMDB', resolveGenreCategoryName(['Acción', 'Aventura'], cfgDefecto), 'Acción');
eq('Suspense → Thriller', resolveGenreCategoryName(['Suspense', 'Misterio'], cfgDefecto), 'Thriller');
eq('Romance → Románticas', resolveGenreCategoryName(['Comedia', 'Romance'], cfgDefecto), 'Comedia');
eq('sin géneros → sin categoría', resolveGenreCategoryName([], cfgDefecto), '');
eq('género raro se respeta tal cual', resolveGenreCategoryName(['Western'], cfgDefecto), 'Western');

const cfgRomance = buildGenreConfig({ priority: ['Románticas', 'Terror'] });
eq(
  'prioridad «Románticas» gana a Comedia',
  resolveGenreCategoryName(['Comedia', 'Romance'], cfgRomance),
  'Románticas'
);
eq(
  'prioridad escrita como género de TMDB',
  resolveGenreCategoryName(['Drama', 'Romance'], buildGenreConfig({ priority: ['Romance'] })),
  'Románticas'
);
eq(
  'prioridad con acentos distintos',
  resolveGenreCategoryName(['Comedia', 'Acción'], buildGenreConfig({ priority: ['accion'] })),
  'Acción'
);

const cfgCustom = buildGenreConfig({ aliases: { Suspense: 'Suspenso y Thriller', Terror: 'Miedo' } });
eq('renombrado propio', resolveGenreCategoryName(['Suspense'], cfgCustom), 'Suspenso y Thriller');
eq('renombrado propio 2', resolveGenreCategoryName(['Terror'], cfgCustom), 'Miedo');

eq(
  'resumen por categoría',
  summarizeGenrePlan([
    { category: 'Acción' },
    { category: 'Acción' },
    { category: 'Comedia' },
    { category: '' }
  ]),
  [
    { name: 'Acción', count: 2 },
    { name: 'Comedia', count: 1 }
  ]
);

// ==================== 2. TMDB de mentira ====================
const FICHAS = {
  'el accionazo': { id: 101, title: 'El Accionazo', genres: [28, 12] },
  'risas de ayer': { id: 102, title: 'Risas de Ayer', genres: [35, 10749] },
  'suspenso total': { id: 103, title: 'Suspenso Total', genres: [53, 9648] },
  'terror en casa': { id: 104, title: 'Terror en Casa', genres: [27] },
  'vuelo espacial': { id: 105, title: 'Vuelo Espacial', genres: [878, 18] }
};
const GENEROS = {
  28: 'Acción',
  12: 'Aventura',
  35: 'Comedia',
  10749: 'Romance',
  53: 'Suspense',
  9648: 'Misterio',
  27: 'Terror',
  878: 'Ciencia ficción',
  18: 'Drama'
};

const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/3/configuration') return send({ images: {} });
  const search = url.pathname.match(/^\/3\/search\/(movie|tv)$/);
  if (search) {
    const q = String(url.searchParams.get('query') || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
    const hit = Object.entries(FICHAS).find(([title]) => title === q || q.startsWith(title));
    if (!hit) return send({ results: [] });
    const [, ficha] = hit;
    return send({
      results: [
        {
          id: ficha.id,
          title: ficha.title,
          name: ficha.title,
          release_date: '2020-05-01',
          first_air_date: '2020-05-01',
          genre_ids: ficha.genres,
          vote_average: 7.4,
          overview: `Sinopsis de ${ficha.title}`,
          poster_path: `/p${ficha.id}.jpg`,
          backdrop_path: `/b${ficha.id}.jpg`
        }
      ]
    });
  }
  const detail = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)$/);
  if (detail) {
    const id = Number(detail[2]);
    const ficha = Object.values(FICHAS).find((f) => f.id === id);
    if (!ficha) return send({ status_code: 34 }, 404);
    return send({ id, genres: ficha.genres.map((g) => ({ id: g, name: GENEROS[g] })) });
  }
  return send({ status_code: 34, status_message: 'not found' }, 404);
});

const PORT = 4631;
await new Promise((resolve) => fake.listen(PORT, '127.0.0.1', resolve));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-genres-'));
process.env.TVLISTER_DB_PATH = path.join(TMP, 't.db');
process.env.TVLISTER_TMDB_BASE_URL = `http://127.0.0.1:${PORT}/3`;

const { initDb, db } = await import('../server/db.js');
const { saveTmdbConfig } = await import('../server/vodSyncTmdb.js');
const { classifyVodGenresByTmdb, syncLocalVodFolder, listWatchFolders } = await import(
  '../server/vodSyncTmdb.js'
);
const { getGenreCategoryConfig, saveGenreCategoryConfig, listVodCategories } = await import(
  '../server/vodGenres.js'
);

initDb();
saveTmdbConfig({ apiKey: 'clave-de-prueba-1234567890', language: 'es-MX' });

const catDefault = db.prepare("INSERT INTO categories (name, type, sort_order) VALUES ('Películas en Disco', 'vod', 10)").run()
  .lastInsertRowid;
const insMovie = db.prepare(
  "INSERT INTO vod_items (title, type, category_id, source_url, genre, release_year) VALUES (?, 'movie', ?, ?, 'General', 2020)"
);
for (const [title, ficha] of Object.entries(FICHAS)) {
  insMovie.run(ficha.title, catDefault, `/tmp/${ficha.title}.mp4`);
}
insMovie.run('Película Inexistente', catDefault, '/tmp/inexistente.mp4');

const genresOf = (title) =>
  db.prepare('SELECT tmdb_genres, genre, category_id FROM vod_items WHERE title = ?').get(title);
const categoryNameOf = (title) =>
  db
    .prepare(
      `SELECT c.name AS name FROM vod_items v LEFT JOIN categories c ON c.id = v.category_id WHERE v.title = ?`
    )
    .get(title)?.name;

// ==================== 3. Vista previa (no escribe nada) ====================
const prev = await classifyVodGenresByTmdb({ media: 'movies', dryRun: true, limit: 50 });
eq('vista previa: películas revisadas', prev.movies.checked, 6);
eq('vista previa: clasificadas', prev.movies.classified, 5);
eq('vista previa: sin resultado en TMDB', prev.movies.notFound, 1);
eq(
  'vista previa: reparto por género',
  prev.movies.categories,
  [
    { name: 'Acción', count: 1 },
    { name: 'Ciencia ficción', count: 1 },
    { name: 'Comedia', count: 1 },
    { name: 'Terror', count: 1 },
    { name: 'Thriller', count: 1 }
  ]
);
eq('vista previa no toca la BD', genresOf('El Accionazo').tmdb_genres, '');
eq(
  'vista previa: la de Romance se queda en su género principal',
  prev.movies.items.find((i) => i.title === 'Risas de Ayer').category,
  'Comedia'
);

// ==================== 4. Prioridad del cliente ====================
saveGenreCategoryConfig({ priorityText: 'Románticas, Terror' });
eq('prioridad guardada', getGenreCategoryConfig().priority, ['Románticas', 'Terror']);
const prevPrio = await classifyVodGenresByTmdb({ media: 'movies', dryRun: true, limit: 50 });
eq(
  'con prioridad Románticas va a Románticas',
  prevPrio.movies.items.find((i) => i.title === 'Risas de Ayer').category,
  'Románticas'
);
saveGenreCategoryConfig({ priorityText: '' });

// ==================== 5. Aplicar ====================
const applied = await classifyVodGenresByTmdb({ media: 'movies', dryRun: false, limit: 50 });
eq('aplicado: clasificadas', applied.movies.classified, 5);
eq('aplicado: sin género en TMDB', applied.movies.notFound, 1);
eq('aplicado: ya no queda nada pendiente', applied.movies.remaining, 0);
eq('Acción escrita en la BD', categoryNameOf('El Accionazo'), 'Acción');
eq('Thriller (alias de Suspense)', categoryNameOf('Suspenso Total'), 'Thriller');
eq('Terror', categoryNameOf('Terror en Casa'), 'Terror');
eq('Ciencia ficción', categoryNameOf('Vuelo Espacial'), 'Ciencia ficción');
eq('Comedia', categoryNameOf('Risas de Ayer'), 'Comedia');
eq(
  'los géneros de TMDB quedan guardados en orden',
  JSON.parse(genresOf('Risas de Ayer').tmdb_genres),
  ['Comedia', 'Romance']
);
eq('el texto de género se actualiza', genresOf('Risas de Ayer').genre, 'Comedia, Romance');
const catsVod = listVodCategories().filter((c) => c.type === 'vod');
eq('las categorías nuevas son de películas', catsVod.every((c) => c.type === 'vod'), true);
ok(
  'categorías creadas: ' + catsVod.map((c) => c.name).join(', '),
  ['Acción', 'Ciencia ficción', 'Comedia', 'Terror', 'Thriller'].every((n) => catsVod.some((c) => c.name === n))
);

// Volver a ejecutar no repite nada: ni las clasificadas ni la que TMDB no encontró.
const again = await classifyVodGenresByTmdb({ media: 'movies', dryRun: false, limit: 50 });
eq('segunda pasada no mira ninguna', again.movies.checked, 0);
eq('la no encontrada queda marcada como revisada', genresOf('Película Inexistente').tmdb_genres, '[]');
eq('…y conserva su categoría', categoryNameOf('Película Inexistente'), 'Películas en Disco');
// Con `refresh` sí se vuelve a preguntar a TMDB por todo.
const refreshed = await classifyVodGenresByTmdb({ media: 'movies', dryRun: true, limit: 50, refresh: true });
eq('refresh vuelve a revisarlas todas', refreshed.movies.checked, 6);

// ==================== 6. El sincronizador de carpeta usa el modo género ====================
const folder = path.join(TMP, 'Peliculas');
fs.mkdirSync(path.join(folder, 'Accion'), { recursive: true });
for (const name of ['El Accionazo (2020).mp4', 'Terror en Casa (2019).mkv', 'Suspenso Total (2021).mp4']) {
  fs.writeFileSync(path.join(folder, 'Accion', name), Buffer.alloc(2048));
}
const sync = await syncLocalVodFolder({
  folderPath: folder,
  contentMode: 'movies',
  categoryMode: 'tmdb_genres',
  autoTmdb: false,
  saveWatchFolder: true
});
eq('sincronizador: películas añadidas', sync.moviesAdded, 3);
eq('sincronizador: clasificadas por género', sync.genreClassified, 3);
eq('sincronizador: modo guardado', sync.categoryMode, 'tmdb_genres');
eq('sincronizador: sin avisos', sync.warnings, []);
const byPath = (n) =>
  db
    .prepare(
      `SELECT c.name AS cat FROM vod_items v LEFT JOIN categories c ON c.id = v.category_id WHERE v.source_url LIKE ?`
    )
    .get(`%${n}%`)?.cat;
eq('nuevo: Acción', byPath('El Accionazo (2020).mp4'), 'Acción');
eq('nuevo: Terror', byPath('Terror en Casa (2019).mkv'), 'Terror');
eq('nuevo: Thriller', byPath('Suspenso Total (2021).mp4'), 'Thriller');
eq('las tres van a la misma categoría de siempre', listVodCategories().filter((c) => c.name === 'Acción').length, 1);
const wf = listWatchFolders().find((f) => f.folder_path.endsWith('Peliculas'));
eq('carpeta monitoreada: category_mode', wf.category_mode, 'tmdb_genres');
ok('resumen guardado menciona el género', String(wf.last_scan_summary).includes('3 por género TMDB'), wf.last_scan_summary);

// Con el modo carpeta no se toca TMDB y manda la subcarpeta.
const syncSub = await syncLocalVodFolder({
  folderPath: folder,
  contentMode: 'movies',
  categoryMode: 'subfolders',
  useSubfoldersAsCategories: true,
  autoTmdb: false,
  saveWatchFolder: false,
  removeMissing: false
});
eq('modo carpeta sigue funcionando', syncSub.categoryMode, 'subfolders');
eq('modo carpeta: nada nuevo', syncSub.moviesAdded, 0);

// ==================== 7. Sin TMDB configurado ====================
saveTmdbConfig({ apiKey: '' });
const folder2 = path.join(TMP, 'SinTmdb');
fs.mkdirSync(folder2, { recursive: true });
fs.writeFileSync(path.join(folder2, 'Vuelo Espacial (2023).mkv'), Buffer.alloc(1024));
const syncNoTmdb = await syncLocalVodFolder({
  folderPath: folder2,
  contentMode: 'movies',
  categoryMode: 'tmdb_genres',
  autoTmdb: true,
  saveWatchFolder: false
});
eq('sin clave TMDB: se avisa', syncNoTmdb.warnings.length, 1);
ok('sin clave TMDB: mensaje claro', /API Key de TMDB/.test(syncNoTmdb.warnings[0]), syncNoTmdb.warnings[0]);
eq('sin clave TMDB: la película entra igual', syncNoTmdb.moviesAdded, 1);
eq('sin clave TMDB: no se queda sin categoría', Boolean(byPath('Vuelo Espacial (2023).mkv')), true);

// ==================== Fin ====================
await new Promise((resolve) => fake.close(resolve));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} comprobación(es) fallida(s)`);
process.exit(fails === 0 ? 0 : 1);
