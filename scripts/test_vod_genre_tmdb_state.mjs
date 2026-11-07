#!/usr/bin/env node
// «Separar el catálogo por género de TMDB» decía «Falta la API Key de TMDB»
// aunque la clave estuviera guardada. Este recorrido arranca el panel de verdad
// (proceso aparte) contra un TMDB de mentira y comprueba que:
//
//   1. sin clave, la tarjeta recibe configured:false y la clasificación se niega;
//   2. al guardar la clave, /api/vod/genres/config lo refleja;
//   3. al guardar las reglas (POST), la respuesta sigue trayendo `tmdb`
//      — si no, la pantalla borraba ese estado y avisaba de que faltaba la clave;
//   4. la clasificación en seco ya funciona con la clave puesta.
//
// Uso:  node scripts/test_vod_genre_tmdb_state.mjs
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
const TMDB_PORT = 4634;
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/3/configuration') return send({ images: {} });
  const search = url.pathname.match(/^\/3\/search\/(movie|tv)$/);
  if (search) {
    return send({
      results: [
        {
          id: 603,
          title: 'Matrix',
          name: 'Matrix',
          release_date: '1999-05-01',
          first_air_date: '1999-05-01',
          genre_ids: [878, 28],
          vote_average: 8.2,
          overview: 'Sinopsis',
          poster_path: '/p603.jpg',
          backdrop_path: '/b603.jpg'
        }
      ]
    });
  }
  const detail = url.pathname.match(/^\/3\/(movie|tv)\/(\d+)$/);
  if (detail) {
    return send({ id: Number(detail[2]), genres: [{ id: 878, name: 'Ciencia ficción' }, { id: 28, name: 'Acción' }] });
  }
  return send({ status_code: 34, status_message: 'not found' }, 404);
});
await new Promise((resolve) => fake.listen(TMDB_PORT, '127.0.0.1', resolve));

// ==================== Panel real ====================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-tmdbstate-'));
const APP_PORT = 4633;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    TYLISTER_TEST: '1',
    TVLISTER_DB_PATH: path.join(TMP, 't.db'),
    TVLISTER_TMDB_BASE_URL: `http://127.0.0.1:${TMDB_PORT}/3`,
    TVLISTER_STREAMS_RUNTIME: path.join(TMP, 'streams_runtime')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let bootLog = '';
child.stdout.on('data', (d) => (bootLog += d));
child.stderr.on('data', (d) => (bootLog += d));

const stopChild = async () => {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  if (!child.killed) child.kill('SIGKILL');
};

const waitForHealth = async () => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      // todavía arrancando
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

let token = '';
const api = async (method, route, body) => {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
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

try {
  const up = await waitForHealth();
  ok('el panel arranca en el puerto de prueba', up);
  if (!up) throw new Error(`no arrancó:\n${bootLog.slice(-1500)}`);

  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  ok('login de administrador', login.status === 200 && Boolean(login.data?.token), `HTTP ${login.status}`);
  token = login.data?.token || '';

  // 1. Sin clave: la tarjeta recibe configured:false.
  const cfg0 = await api('GET', '/api/vod/genres/config');
  ok('GET /api/vod/genres/config responde', cfg0.status === 200);
  ok('sin clave, tmdb.configured = false', cfg0.data?.tmdb?.configured === false, JSON.stringify(cfg0.data?.tmdb));

  const badClassify = await api('POST', '/api/vod/genres/classify', { dryRun: true, media: 'both' });
  ok(
    'sin clave, «Aplicar» se niega con el aviso de la API Key',
    badClassify.status === 400 && /API Key de TMDB/i.test(badClassify.data?.error || ''),
    badClassify.data?.error
  );

  // 2. Se guarda la clave como lo hace el modal.
  const savedKey = await api('POST', '/api/tmdb/config', {
    apiKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    language: 'es-MX',
    testConnection: true
  });
  ok('POST /api/tmdb/config guarda la clave', savedKey.status === 200 && savedKey.data?.configured === true, `HTTP ${savedKey.status}`);

  const cfg1 = await api('GET', '/api/vod/genres/config');
  ok('con clave, tmdb.configured = true', cfg1.data?.tmdb?.configured === true, JSON.stringify(cfg1.data?.tmdb));

  // 3. Regresión: al guardar las reglas la respuesta tiene que seguir trayendo
  //    `tmdb` y `categories` (antes sólo devolvía las reglas y la pantalla
  //    borraba el estado de la clave).
  const savedRules = await api('POST', '/api/vod/genres/config', {
    aliasesText: 'Suspense = Thriller\nRomance = Románticas',
    priorityText: 'Románticas, Terror, Acción'
  });
  ok('POST /api/vod/genres/config responde', savedRules.status === 200);
  ok(
    'las reglas guardadas incluyen tmdb.configured (antes faltaba)',
    savedRules.data?.tmdb?.configured === true,
    JSON.stringify(savedRules.data?.tmdb)
  );
  ok('las reglas guardadas incluyen las categorías', Array.isArray(savedRules.data?.categories));
  ok(
    'las reglas se guardaron de verdad',
    /Suspense = Thriller/.test(String(savedRules.data?.aliasesText || '')),
    savedRules.data?.aliasesText
  );

  // La UI hace `{...prev, ...cfg}` sobre esa respuesta: si trae tmdb, la tarjeta
  // no vuelve a decir «Falta la API Key».
  const merged = { ...cfg1.data, ...savedRules.data };
  ok('estado de la tarjeta tras guardar reglas: sigue configurado', merged.tmdb?.configured === true);

  // 4. Con la clave puesta, la vista previa funciona (TMDB de mentira).
  const classify = await api('POST', '/api/vod/genres/classify', { dryRun: true, media: 'both', limit: 5 });
  ok('con clave, la vista previa responde', classify.status === 200, JSON.stringify(classify.data).slice(0, 160));
  ok('la vista previa es en seco', classify.data?.dryRun === true);
} catch (err) {
  fails += 1;
  console.log(`FALLO excepción: ${err.message}`);
} finally {
  await stopChild();
  await new Promise((r) => fake.close(r));
  if (fails === 0) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`\n(pista: la BD de prueba quedó en ${TMP})`);
}

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
