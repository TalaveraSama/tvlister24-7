#!/usr/bin/env node
// El botón «Aplicar a Películas y Series» del panel, contra el panel real.
//
// Escenario del cliente: después de la limpieza de categorías todo el catálogo
// quedó dentro de `Movies` y, al pulsar Aplicar, no se creaba ninguna categoría
// de género (Acción, Comedia…). Aquí se comprueba de punta a punta, por HTTP:
//
//   1. La vista previa ve los títulos que hay que mover y NO crea categorías.
//   2. Aplicar crea las categorías y saca los títulos de `Movies`.
//   3. Los géneros ya guardados se reutilizan (no se gasta TMDB de más).
//   4. Un segundo clic no hace nada (idempotente) y no duplica categorías.
//
// Uso:  node scripts/test_vod_genre_apply_api.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const ok = (label, condition, extra = '') => {
  if (!condition) fails += 1;
  console.log(`${condition ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
};

// ==================== TMDB de mentira ====================
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/3/configuration') return send({ images: {} });
  if (/^\/3\/search\/movie$/.test(url.pathname)) {
    return send({
      results: [
        {
          id: 862,
          title: 'Toy Story',
          release_date: '1995-11-22',
          genre_ids: [16, 35],
          vote_average: 8,
          overview: 'x',
          poster_path: '/p862.jpg'
        }
      ]
    });
  }
  if (/^\/3\/movie\/862$/.test(url.pathname)) {
    return send({ id: 862, genres: [{ id: 16, name: 'Animación' }, { id: 35, name: 'Comedia' }] });
  }
  return send({ status_code: 34 }, 404);
});
const TMDB_PORT = 4661;
await new Promise((r) => fake.listen(TMDB_PORT, '127.0.0.1', r));

// ==================== Panel real ====================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-applyapi-'));
const APP_PORT = 4660;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    TVLISTER_DB_PATH: path.join(TMP, 't.db'),
    TVLISTER_TMDB_BASE_URL: `http://127.0.0.1:${TMDB_PORT}/3`,
    TVLISTER_STREAMS_RUNTIME: path.join(TMP, 'streams_runtime')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let boot = '';
child.stdout.on('data', (d) => (boot += d));
child.stderr.on('data', (d) => (boot += d));

let token = '';
const api = async (method, route, body) => {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  return { status: r.status, data };
};

const stop = async () => {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (!child.killed) child.kill('SIGKILL');
};

try {
  let up = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  ok('el panel arranca', up);
  if (!up) throw new Error(`no arrancó:\n${boot.slice(-1200)}`);

  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  token = login.data?.token || '';
  ok('login de administrador', Boolean(token));

  // Clave de TMDB (formato v3) y estado de partida: todo en `Movies`.
  await api('POST', '/api/tmdb/config', { apiKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', language: 'es-MX' });

  // Se manipula la base con la misma ruta que usa el panel (SQLite WAL permite
  // escribir desde otro proceso).
  // La categoría maestra se crea al sincronizar o pidiéndola aquí (como hace el panel).
  const masterRes = await api('GET', '/api/vod/categories/master');
  ok('el panel crea las categorías maestras', Boolean(masterRes.data?.movies?.id || masterRes.data?.categories?.movies?.id), JSON.stringify(masterRes.data).slice(0, 120));

  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(TMP, 't.db'));
  const moviesId = raw.prepare("SELECT id FROM categories WHERE name = 'Movies' AND type = 'vod'").get()?.id;
  ok('existe la categoría maestra Movies', Boolean(moviesId), String(moviesId));
  raw
    .prepare("INSERT INTO vod_items (title, type, category_id, source_url, tmdb_genres) VALUES (?, 'movie', ?, ?, ?)")
    .run('Matrix', moviesId, '/m/matrix.mp4', JSON.stringify(['Ciencia ficción', 'Acción']));
  raw
    .prepare("INSERT INTO vod_items (title, type, category_id, source_url, tmdb_genres) VALUES (?, 'movie', ?, ?, ?)")
    .run('Rápidos y Furiosos', moviesId, '/m/rapidos.mp4', JSON.stringify(['Acción']));
  raw
    .prepare("INSERT INTO vod_items (title, type, category_id, source_url, tmdb_genres) VALUES (?, 'movie', ?, ?, ?)")
    .run('Una Comedia', moviesId, '/m/comedia.mp4', JSON.stringify(['Comedia']));
  // Sin género guardado: se resolverá contra el TMDB de mentira (Toy Story).
  raw
    .prepare("INSERT INTO vod_items (title, type, category_id, source_url, tmdb_genres) VALUES (?, 'movie', ?, ?, '')")
    .run('Toy Story 1995', moviesId, '/m/toy.mp4');

  const count = (sql, ...args) => raw.prepare(sql).all(...args);
  const catNames = () => count("SELECT name FROM categories WHERE type = 'vod' ORDER BY name").map((c) => c.name);
  ok('antes sólo está Movies', JSON.stringify(catNames()) === JSON.stringify(['Movies']), catNames().join(', '));

  // ---- 1. Vista previa ------------------------------------------------
  const preview = await api('POST', '/api/vod/genres/classify', { dryRun: true, media: 'movies', limit: 120 });
  ok('la vista previa responde', preview.status === 200, preview.data?.error);
  ok('ve los 4 títulos', preview.data?.movies?.checked === 4, `checked=${preview.data?.movies?.checked}`);
  ok('anuncia 3 mudanzas con el género ya guardado', preview.data?.movies?.moved === 3, `moved=${preview.data?.movies?.moved}`);
  ok('la vista previa no crea categorías', JSON.stringify(catNames()) === JSON.stringify(['Movies']), catNames().join(', '));
  ok(
    'la vista previa es en seco (las 3 mudanzas quedan pendientes de aplicar)',
    preview.data?.dryRun === true && preview.data?.movies?.remaining === 3,
    `remaining=${preview.data?.movies?.remaining}`
  );

  // ---- 2. Aplicar -----------------------------------------------------
  const apply = await api('POST', '/api/vod/genres/classify', { dryRun: false, media: 'movies', limit: 120 });
  ok('aplicar responde', apply.status === 200, apply.data?.error);
  const names = catNames();
  ok('creó Acción', names.includes('Acción'), names.join(', '));
  ok('creó Comedia', names.includes('Comedia'));
  ok('creó Ciencia ficción', names.includes('Ciencia ficción'));
  ok('creó Animación (consulta nueva a TMDB)', names.includes('Animación'));

  const catOf = (title) =>
    raw.prepare('SELECT c.name AS n FROM vod_items v LEFT JOIN categories c ON c.id = v.category_id WHERE v.title = ?').get(title)?.n || '(sin categoría)';
  ok('Matrix salió de Movies', catOf('Matrix') === 'Ciencia ficción', catOf('Matrix'));
  ok('Rápidos y Furiosos a Acción', catOf('Rápidos y Furiosos') === 'Acción');
  ok('Una Comedia a Comedia', catOf('Una Comedia') === 'Comedia');
  ok('Toy Story (sin género guardado) se consultó y entró en Animación', catOf('Toy Story 1995') === 'Animación', catOf('Toy Story 1995'));
  ok(
    'Movies queda vacía',
    count('SELECT COUNT(*) c FROM vod_items WHERE category_id = ?', moviesId)[0].c === 0
  );

  // ---- 3. El panel ya muestra las categorías --------------------------
  const cfg = await api('GET', '/api/vod/genres/config');
  const listed = (cfg.data?.categories || []).map((c) => c.name);
  ok('la pantalla de géneros ve las categorías nuevas', listed.includes('Acción') && listed.includes('Comedia'), listed.join(', '));

  // ---- 4. Segundo clic: no duplica ni vuelve a TMDB -------------------
  const again = await api('POST', '/api/vod/genres/classify', { dryRun: false, media: 'movies', limit: 120 });
  ok('el segundo clic no hace nada', again.data?.movies?.checked === 0, `checked=${again.data?.movies?.checked}`);
  ok('no duplica categorías', catNames().filter((n) => n === 'Acción').length === 1);
  ok('nada quedó pendiente', again.data?.movies?.remaining === 0);
} catch (err) {
  fails += 1;
  console.log(`FALLO excepción: ${err.message}`);
} finally {
  await stop();
  await new Promise((r) => fake.close(r));
  if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`(la BD de prueba quedó en ${TMP})`);
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
