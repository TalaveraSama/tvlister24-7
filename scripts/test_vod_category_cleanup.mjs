#!/usr/bin/env node
// Limpieza de categorías del catálogo: cuenta lo que tiene cada categoría de
// películas/series y borra las que sobran (las que crearon las subcarpetas del
// disco) sin dejar ningún título huérfano.
//
// Uso: node scripts/test_vod_category_cleanup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// Base de datos temporal, aislada de la del panel.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcat-'));
process.env.TVLISTER_DB_PATH = path.join(dir, 'test.db');

const { initDb, db } = await import('../server/db.js');
const { vodCategoryUsage, purgeVodCategories, ensureMasterCategories, switchFoldersToMasterMode, MASTER_CATEGORY_NAMES } =
  await import('../server/vodGenres.js');
initDb();

// ==================== 1. Escenario ====================
const mkCat = (name, type) =>
  Number(db.prepare('INSERT INTO categories (name, type, sort_order) VALUES (?, ?, 50)').run(name, type).lastInsertRowid);
const mkMovie = (title, catId) =>
  Number(
    db
      .prepare("INSERT INTO vod_items (title, category_id, source_url, type) VALUES (?, ?, ?, 'movie')")
      .run(title, catId, `/tmp/${title}.mp4`).lastInsertRowid
  );

const cCiencia = mkCat('Ciencia Ficcion', 'vod'); // creada por la carpeta, vacía
const cTriller = mkCat('triller', 'vod'); // creada por la carpeta, vacía
const cAccion = mkCat('Acción', 'vod'); // género TMDB, con contenido
const cTerror = mkCat('Terror', 'vod'); // género TMDB, con contenido
const cDocs = mkCat('Documentales', 'vod'); // creada por la carpeta, con 1 película
const sSuspenso = mkCat('Suspenso', 'series'); // serie, vacía
const cLive = mkCat('Deportes', 'live'); // NO es del catálogo: no debe tocarse

mkMovie('Dune', cCiencia); // quedó en la carpeta porque TMDB no la clasificó
mkMovie('El Padrino', cAccion);
mkMovie('Rocky', cAccion);
mkMovie('It', cTerror);
mkMovie('Planeta Tierra', cDocs);

const seriesId = Number(
  db
    .prepare("INSERT INTO series (title, category_id) VALUES ('Serie de Terror', ?)")
    .run(cTerror).lastInsertRowid
);

// Carpeta monitoreada que apuntaba a una categoría de carpeta.
db.prepare(
  "INSERT INTO vod_watch_folders (folder_path, content_mode, default_category_id, category_mode) VALUES ('/tmp/pelis', 'movies', ?, 'tmdb_genres')"
).run(cCiencia);
// Otra que sigue en «cada subcarpeta es una categoría»: hay que avisar de ella.
db.prepare(
  "INSERT INTO vod_watch_folders (folder_path, content_mode, default_category_id, category_mode) VALUES ('/tmp/series', 'series', ?, 'subfolders')"
).run(sSuspenso);

// ==================== 2. Uso por categoría ====================
const usage = vodCategoryUsage();
const byName = Object.fromEntries(usage.categories.map((c) => [c.name, c]));
eq('cuenta las categorías de películas/series', usage.total, 6);
ok('la categoría de canales en vivo no aparece', !byName.Deportes);
eq('Acción tiene 2 películas', [byName.Acción.movies, byName.Acción.series], [2, 0]);
eq('Terror tiene película y serie', [byName.Terror.movies, byName.Terror.series], [1, 1]);
eq('la categoría de serie cuenta su serie', byName.Suspenso.series, 0);
eq('Ciencia Ficcion quedó con 1 película', byName['Ciencia Ficcion'].total, 1);
ok('triller está vacía', byName.triller.empty);
eq('cuenta de vacías', usage.empty, 2);
eq('cuenta con contenido', usage.withContent, 4);
eq('avisa de las carpetas que recrearán categorías', usage.subfolderFolders.map((f) => f.path), ['/tmp/series']);

// ==================== 3. Borrar sólo vacías ====================
let res = purgeVodCategories({ ids: [cTriller, sSuspenso] });
ok('borra las vacías', res.ok && res.deleted === 2, JSON.stringify(res));
ok('triller ya no existe', !db.prepare('SELECT id FROM categories WHERE id = ?').get(cTriller));
const fSeries = db.prepare("SELECT default_category_id FROM vod_watch_folders WHERE folder_path = '/tmp/series'").get();
ok('la carpeta que apuntaba a la borrada se queda sin categoría', fSeries.default_category_id === null,
  String(fSeries.default_category_id));
ok('las películas de Acción siguen intactas', db.prepare('SELECT COUNT(*) n FROM vod_items WHERE category_id = ?').get(cAccion).n === 2);

// ==================== 4. Con contenido y sin destino: no borra nada ====================
res = purgeVodCategories({ ids: [cCiencia] });
ok('se niega a borrar una categoría con contenido', res.ok === false && res.deleted === 0);
eq('dice cuál bloquea', res.blocked.map((c) => c.name), ['Ciencia Ficcion']);
ok('la categoría sigue existiendo', Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(cCiencia)));
ok('su película sigue en su sitio', Boolean(db.prepare('SELECT id FROM vod_items WHERE category_id = ?').get(cCiencia)));

// ==================== 5. Mover a otra categoría y borrar ====================
res = purgeVodCategories({ ids: [cCiencia, cDocs], moveToId: cAccion });
ok('mueve y borra', res.ok && res.deleted === 2, JSON.stringify(res));
eq('películas movidas', res.moved.movies, 2);
eq('Acción pasa a tener 4 películas', db.prepare('SELECT COUNT(*) n FROM vod_items WHERE category_id = ?').get(cAccion).n, 4);
ok('Ciencia Ficcion ya no existe', !db.prepare('SELECT id FROM categories WHERE id = ?').get(cCiencia));
const folder = db.prepare("SELECT default_category_id FROM vod_watch_folders WHERE folder_path = '/tmp/pelis'").get();
eq('la carpeta monitoreada apunta al destino', Number(folder.default_category_id), cAccion);
ok('la categoría en vivo sigue intacta', Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(cLive)));

// ==================== 6. Protecciones ====================
let threw = '';
try {
  purgeVodCategories({ ids: [cAccion], moveToId: cAccion });
} catch (err) {
  threw = err.message;
}
ok('el destino no puede ser una de las borradas', /destino/.test(threw), threw);

threw = '';
try {
  purgeVodCategories({ ids: [cLive] });
} catch (err) {
  threw = err.message;
}
ok('no toca categorías de canales en vivo', /no existen|no son de películas/.test(threw), threw);

threw = '';
try {
  purgeVodCategories({ ids: [] });
} catch (err) {
  threw = err.message;
}
ok('sin selección avisa', /No hay categorías/.test(threw), threw);

// ==================== 7. Borrar una categoría de series con contenido ====================
res = purgeVodCategories({ ids: [cTerror], moveToId: cAccion });
ok('mueve también series', res.ok && res.moved.series === 1, JSON.stringify(res));
eq('la serie acabó en Acción', db.prepare('SELECT category_id FROM series WHERE id = ?').get(seriesId).category_id, cAccion);
eq('Acción queda con 5 películas y 1 serie', [
  db.prepare('SELECT COUNT(*) n FROM vod_items WHERE category_id = ?').get(cAccion).n,
  db.prepare('SELECT COUNT(*) n FROM series WHERE category_id = ?').get(cAccion).n
], [5, 1]);

// ==================== 8. Categoría maestra «Movies» ====================
const masters = ensureMasterCategories();
eq('la maestra de películas se llama Movies', db.prepare('SELECT name FROM categories WHERE id = ?').get(masters.movies).name, 'Movies');
eq('la maestra de series se llama Series', db.prepare('SELECT name FROM categories WHERE id = ?').get(masters.series).name, 'Series');
let masterThrew = '';
try {
  purgeVodCategories({ ids: [masters.movies], moveToId: cAccion });
} catch (err) {
  masterThrew = err.message;
}
ok('«Movies» no se puede borrar', /maestras/.test(masterThrew), masterThrew);

const mastersAgain = ensureMasterCategories();
eq('no se duplican al pedirlas otra vez', [mastersAgain.movies, mastersAgain.series], [masters.movies, masters.series]);

// Una carpeta de películas y otra de series, ambas en el modo antiguo.
db.prepare("INSERT INTO vod_watch_folders (folder_path, content_mode, category_mode) VALUES ('/srv/peli', 'movies', 'subfolders')").run();
db.prepare("INSERT INTO vod_watch_folders (folder_path, content_mode, category_mode) VALUES ('/srv/serie', 'series', 'subfolders')").run();
const switched = switchFoldersToMasterMode();
ok('pasa las carpetas antiguas a la maestra', switched.updated === 3, JSON.stringify(switched.updated));
const peliFolder = db.prepare("SELECT category_mode, default_category_id FROM vod_watch_folders WHERE folder_path = '/srv/peli'").get();
const serieFolder = db.prepare("SELECT category_mode, default_category_id FROM vod_watch_folders WHERE folder_path = '/srv/serie'").get();
eq('la carpeta de películas usa Movies', [peliFolder.category_mode, Number(peliFolder.default_category_id)], ['single', masters.movies]);
eq('la carpeta de series usa Series', [serieFolder.category_mode, Number(serieFolder.default_category_id)], ['single', masters.series]);
const tmpFolder = db.prepare("SELECT category_mode FROM vod_watch_folders WHERE folder_path = '/tmp/series'").get();
eq('la carpeta anterior también cambia de modo', tmpFolder.category_mode, 'single');
eq('ya no quedan carpetas en modo antiguo', switchFoldersToMasterMode().updated, 0);

console.log('');
if (fails) {
  console.log(`FALLOS: ${fails}`);
  process.exit(1);
}
console.log('TODO OK');
db.close?.();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
