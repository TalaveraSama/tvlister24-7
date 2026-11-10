#!/usr/bin/env node
// «Después del reseteo solo sale Movies»: la separación por género de TMDB no
// creaba Acción, Comedia, Terror… y todo se quedaba dentro de `Movies`.
//
// Causa: la clasificación sólo miraba las filas **sin** género guardado
// (`tmdb_genres IS NULL`). Al mover todo el catálogo a la categoría maestra, los
// géneros seguían guardados, así que la vista previa y «Aplicar» decían «no
// queda ningún título pendiente» y no se creaba ni una categoría.
//
// Uso:  node scripts/test_vod_genre_reclassify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} != ${JSON.stringify(want)}`);

// ==================== TMDB de mentira ====================
const FICHAS = {
  'el padrino': { id: 238, genres: [80, 18] }, // Crimen, Drama
  'matrix': { id: 603, genres: [878, 28] }, // Ciencia ficción, Acción
  'toy story': { id: 862, genres: [16, 35, 10751] }, // Animación, Comedia, Familia
  'una comedia romantica': { id: 900, genres: [35, 10749] }, // Comedia, Romance
  'suspenso total': { id: 901, genres: [53, 9648] }, // Suspense, Misterio
  'sin genero': { id: 902, genres: [] }
};
const GENEROS = {
  28: 'Acción',
  35: 'Comedia',
  53: 'Suspense',
  80: 'Crimen',
  16: 'Animación',
  18: 'Drama',
  878: 'Ciencia ficción',
  9648: 'Misterio',
  10749: 'Romance',
  10751: 'Familia'
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
    const ficha = hit[1];
    return send({
      results: [
        {
          id: ficha.id,
          title: 'x',
          name: 'x',
          release_date: '2020-05-01',
          first_air_date: '2020-05-01',
          genre_ids: ficha.genres,
          vote_average: 7,
          overview: 'Sinopsis',
          poster_path: `/p${ficha.id}.jpg`
        }
      ]
    });
  }
  const detail = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)$/);
  if (detail) {
    const ficha = Object.values(FICHAS).find((f) => f.id === Number(detail[2]));
    if (!ficha) return send({ status_code: 34 }, 404);
    return send({ id: ficha.id, genres: ficha.genres.map((g) => ({ id: g, name: GENEROS[g] })) });
  }
  return send({ status_code: 34, status_message: 'not found' }, 404);
});

const TMDB_PORT = 4657;
await new Promise((r) => fake.listen(TMDB_PORT, '127.0.0.1', r));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-reclass-'));
process.env.TVLISTER_DB_PATH = path.join(TMP, 't.db');
process.env.TVLISTER_TMDB_BASE_URL = `http://127.0.0.1:${TMDB_PORT}/3`;

const { initDb, db } = await import('../server/db.js');
await initDb();
const { saveTmdbConfig, classifyVodGenresByTmdb } = await import('../server/vodSyncTmdb.js');
const { ensureMasterCategory, ensureVodCategory, saveGenreCategoryConfig, listVodCategories } = await import(
  '../server/vodGenres.js'
);

saveTmdbConfig({ apiKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', language: 'es-MX' });

const catId = (name, type = 'vod') =>
  db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND type = ?').get(name, type)?.id ?? null;
const catNames = (type = 'vod') =>
  db
    .prepare('SELECT name FROM categories WHERE type = ? ORDER BY name')
    .all(type)
    .map((c) => c.name);
const catOf = (id) => db.prepare('SELECT name FROM categories WHERE id = ?').get(id)?.name || '(sin categoría)';

// ==================== Escenario: todo quedó en `Movies` ====================
const moviesId = ensureMasterCategory('vod');
const seriesId = ensureMasterCategory('series');

const insMovie = db.prepare(
  "INSERT INTO vod_items (title, type, category_id, source_url, tmdb_genres) VALUES (?, 'movie', ?, ?, ?)"
);
// Películas que ya se habían clasificado antes del reseteo: género guardado y
// todas devueltas a `Movies` por la limpieza de categorías.
insMovie.run('Matrix', moviesId, '/m/matrix.mp4', JSON.stringify(['Ciencia ficción', 'Acción']));
insMovie.run('Toy Story', moviesId, '/m/toy.mp4', JSON.stringify(['Animación', 'Comedia', 'Familia']));
insMovie.run('El Padrino', moviesId, '/m/padrino.mp4', JSON.stringify(['Crimen', 'Drama']));
// Dos con el género principal bien distinto: Acción y Comedia.
insMovie.run('Rápidos y Furiosos', moviesId, '/m/rapidos.mp4', JSON.stringify(['Acción']));
insMovie.run('Una Comedia', moviesId, '/m/comedia.mp4', JSON.stringify(['Comedia', 'Familia']));
// Nunca se preguntó a TMDB (sin `tmdb_genres`).
insMovie.run('Suspenso Total', moviesId, '/m/susp.mp4', '');
// TMDB no le conoce género: se queda en Movies y no se reintenta.
insMovie.run('Sin Genero', moviesId, '/m/sg.mp4', '');

const insSeries = db.prepare('INSERT INTO series (title, category_id, tmdb_genres) VALUES (?, ?, ?)');
insSeries.run('Matrix', seriesId, JSON.stringify(['Ciencia ficción']));

// Las categorías de género se habían borrado: sólo quedan las maestras.
eq('antes sólo están Movies y Series', catNames('vod').concat(catNames('series')), ['Movies', 'Series']);
eq('y las 7 películas están en Movies', db.prepare('SELECT COUNT(*) c FROM vod_items WHERE category_id = ?').get(moviesId).c, 7);

// ==================== 1. Vista previa: lo ve, pero no crea nada ====================
const preview = await classifyVodGenresByTmdb({ media: 'movies', dryRun: true, limit: 120 });
ok('la vista previa ya ve títulos que mover', preview.movies.checked >= 6, `checked=${preview.movies.checked}`);
ok('cuenta las mudanzas con el género guardado', preview.movies.moved >= 5, `moved=${preview.movies.moved}`);
eq('la vista previa no crea categorías', catNames('vod'), ['Movies']);
const planned = (preview.movies.items || []).map((i) => `${i.title}=${i.category}`).sort();
ok(
  'la vista previa anuncia a qué categoría va cada uno',
  planned.includes('Matrix=Ciencia ficción') && planned.includes('Toy Story=Animación'),
  planned.join(' | ')
);

// ==================== 2. Aplicar: crea las categorías y reparte ====================
const applied = await classifyVodGenresByTmdb({ media: 'both', dryRun: false, limit: 120 });
ok('aplicado', applied.ok === true);
ok('ninguna película se queda sin revisar', applied.movies.remaining === 0, `remaining=${applied.movies.remaining}`);

const nombres = catNames('vod');
ok('creó Acción', nombres.includes('Acción'), nombres.join(', '));
ok('creó Comedia', nombres.includes('Comedia'));
ok('creó Ciencia ficción', nombres.includes('Ciencia ficción'));
ok('creó Crimen (género principal de El Padrino)', nombres.includes('Crimen'));
ok('creó Animación', nombres.includes('Animación'));
ok('creó la de series', catNames('series').includes('Ciencia ficción'), catNames('series').join(', '));

const donde = (id) => catOf(db.prepare('SELECT category_id FROM vod_items WHERE id = ?').get(id).category_id);
const movieIdByTitle = (t) => db.prepare('SELECT id FROM vod_items WHERE title = ?').get(t).id;
ok('Matrix se fue a Ciencia ficción', donde(movieIdByTitle('Matrix')) === 'Ciencia ficción', donde(movieIdByTitle('Matrix')));
ok('El Padrino se fue a Crimen', donde(movieIdByTitle('El Padrino')) === 'Crimen');
ok('Toy Story se fue a Animación', donde(movieIdByTitle('Toy Story')) === 'Animación');
ok(
  '«Suspenso Total» se consultó en TMDB y entró en Thriller (alias de Suspense)',
  donde(movieIdByTitle('Suspenso Total')) === 'Thriller',
  donde(movieIdByTitle('Suspenso Total'))
);
ok('la serie también salió de Series', catOf(db.prepare('SELECT category_id FROM series WHERE title = ?').get('Matrix').category_id) === 'Ciencia ficción');
eq(
  'en Movies sólo queda el título sin género',
  db.prepare('SELECT title FROM vod_items WHERE category_id = ?').all(moviesId).map((r) => r.title),
  ['Sin Genero']
);
ok('el que no tiene género quedó marcado para no reintentarlo', db.prepare("SELECT tmdb_genres FROM vod_items WHERE title = 'Sin Genero'").get().tmdb_genres === '[]');

// ==================== 3. Segundo clic: no hay nada que hacer ====================
const again = await classifyVodGenresByTmdb({ media: 'both', dryRun: false, limit: 120 });
ok('la segunda vez no hay nada pendiente', again.movies.remaining === 0 && again.series.remaining === 0);
ok('no vuelve a tocar TMDB para lo ya clasificado', again.movies.checked === 0, `checked=${again.movies.checked}`);
eq('las categorías no se duplican', catNames('vod').filter((n) => n === 'Acción').length, 1);
eq('tampoco las de series', catNames('series').filter((n) => n === 'Ciencia ficción').length, 1);

// ==================== 4. Si se vuelven a borrar las categorías ====================
// Simula el reseteo otra vez: se borran las categorías de género y todo vuelve
// a Movies. La separación tiene que reconstruirlas sin preguntar a TMDB.
for (const c of db.prepare("SELECT id FROM categories WHERE type = 'vod' AND name != 'Movies'").all()) {
  db.prepare('UPDATE vod_items SET category_id = ? WHERE category_id = ?').run(moviesId, c.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
}
eq('reset simulado: sólo queda Movies', catNames('vod'), ['Movies']);
const afterReset = await classifyVodGenresByTmdb({ media: 'movies', dryRun: false, limit: 120 });
ok('tras el reseteo vuelve a repartir', afterReset.movies.moved >= 6, `moved=${afterReset.movies.moved}`);
ok('y recrea las categorías', catNames('vod').includes('Acción') && catNames('vod').includes('Comedia'), catNames('vod').join(', '));
ok(
  'sin gastar consultas de TMDB para lo ya conocido',
  afterReset.movies.checked === afterReset.movies.moved && afterReset.movies.classified === afterReset.movies.moved,
  `checked=${afterReset.movies.checked} moved=${afterReset.movies.moved} classified=${afterReset.movies.classified}`
);

// ==================== 5. Prioridad y alias del cliente ====================
saveGenreCategoryConfig({ priorityText: 'Románticas, Terror, Acción' });
const romanticaId = db.prepare('SELECT id FROM vod_items WHERE id = 1').get();
db.prepare(
  "INSERT INTO vod_items (title, type, category_id, source_url, tmdb_genres) VALUES ('Una Comedia Romantica', 'movie', ?, '/m/rom.mp4', ?)"
).run(moviesId, JSON.stringify(['Comedia', 'Romance']));
const withPriority = await classifyVodGenresByTmdb({ media: 'movies', dryRun: false, limit: 120 });
void romanticaId;
void withPriority;
const romId = db.prepare("SELECT category_id FROM vod_items WHERE title = 'Una Comedia Romantica'").get().category_id;
ok(
  'con prioridad «Románticas» la comedia romántica va a su categoría (alias de Romance)',
  catOf(romId) === 'Románticas',
  catOf(romId)
);
eq('las categorías de género ordenadas', listVodCategories().filter((c) => c.name === 'Románticas').length, 1);

await new Promise((r) => fake.close(r));
if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true });
else console.log(`(la BD de prueba quedó en ${TMP})`);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
