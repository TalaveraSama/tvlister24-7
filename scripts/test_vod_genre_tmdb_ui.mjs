#!/usr/bin/env node
// Regresión de la tarjeta «Separar el catálogo por género de TMDB»: decía
// «Falta la API Key de TMDB» con la clave ya guardada.
//
// Se renderiza la pantalla real (jsdom) y se comprueban los dos caminos que
// dejaban el estado en falso:
//
//   1. Guardar las reglas: el POST devolvía sólo las reglas, la pantalla
//      reemplazaba su estado y perdía `tmdb` ⇒ aviso ámbar y botones muertos.
//   2. Guardar la clave en el modal: el estado de la tarjeta se cargaba sólo al
//      abrir la pantalla, así que seguía avisando hasta recargar con F5.
//
// Uso:  node scripts/test_vod_genre_tmdb_ui.mjs
// Requiere jsdom (npm i -D jsdom). Si no está, la prueba se omite y sale en 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('omitido: jsdom no está instalado (npm i -D jsdom)');
  process.exit(0);
}

const fails = [];
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails.push(label);
};

// ==================== 1. Compilar la pantalla ====================
const tmp = path.join(ROOT, 'node_modules', '.tvtmdbui');
fs.mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, 'VodPage.mjs');
const { build } = await import('esbuild');
await build({
  entryPoints: [path.join(ROOT, 'src/pages/VodPage.jsx')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  loader: { '.jsx': 'jsx' },
  jsx: 'automatic',
  external: ['react', 'react-dom'],
  logLevel: 'error'
});

// ==================== 2. Navegador de mentira ====================
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.localStorage = dom.window.localStorage;
dom.window.alert = () => {};
dom.window.confirm = () => true;
globalThis.alert = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ==================== 3. Panel de mentira ====================
// `tmdbConfigured` cambia a true cuando el modal guarda la clave, para imitar
// al servidor de verdad.
let tmdbConfigured = true;
let postGenreDropsTmdb = true; // servidor viejo: el POST no devuelve `tmdb`
const calls = [];

const base = {
  'GET /api/vod': [],
  'GET /api/categories': [],
  'GET /api/series': [],
  'GET /api/vod/folders': [],
  'GET /api/jellyfin/config': { configured: false },
  'GET /api/vod/categories/usage': { categories: [], total: 0, empty: 0, withContent: 0 }
};

globalThis.fetch = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const key = `${method} ${url}`;
  calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
  let data;
  if (key === 'GET /api/tmdb/config') {
    data = { configured: tmdbConfigured, apiKeyMasked: tmdbConfigured ? 'a1b2••••••••8f90' : '', language: 'es-MX' };
  } else if (key === 'POST /api/tmdb/config') {
    tmdbConfigured = true;
    data = { ok: true, configured: true, apiKeyMasked: 'a1b2••••••••8f90', language: 'es-MX' };
  } else if (key === 'GET /api/vod/genres/config') {
    data = {
      aliasesText: '',
      priorityText: '',
      aliases: {},
      priority: [],
      categories: [],
      ...(tmdbConfigured ? { tmdb: { configured: true, language: 'es-MX' } } : { tmdb: { configured: false, language: 'es-MX' } })
    };
  } else if (key === 'POST /api/vod/genres/config') {
    data = {
      ok: true,
      aliasesText: 'Suspense = Thriller',
      priorityText: 'Románticas, Terror, Acción',
      aliases: { Suspense: 'Thriller' },
      priority: ['Románticas', 'Terror', 'Acción'],
      ...(postGenreDropsTmdb ? {} : { tmdb: { configured: true, language: 'es-MX' } })
    };
  } else {
    data = base[key] ?? {};
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
};

// ==================== 4. Montar y helpers ====================
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const VodPage = (await import(bundle)).default;

// Cada escenario se monta en un contenedor nuevo: así el estado arranca de cero
// y se ve lo que haría el usuario al abrir la pantalla.
const mount = async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(VodPage, {}));
    await new Promise((r) => setTimeout(r, 250));
  });
  return root;
};

let root = await mount();

const text = () => document.body.textContent.replace(/\s+/g, ' ');
const byText = (sel, needle) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(needle));
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  });

const abrirCarpetas = async () => {
  const btn = byText('button', 'Sincronizar Carpeta');
  ok(!!btn, 'existe «Sincronizar Carpeta»');
  if (btn) await click(btn);
};

// ==================== 5. Caso 1: guardar reglas no borra la clave ====================
await abrirCarpetas();
ok(text().includes('Separar el catálogo por género de TMDB'), 'la tarjeta de géneros está a la vista');
ok(!text().includes('Falta la API Key de TMDB'), 'con la clave puesta no avisa de que falta');

const guardar = byText('button', 'Guardar Reglas');
ok(!!guardar, 'existe «Guardar Reglas»');
if (guardar) await click(guardar);

ok(
  calls.some((c) => c.key === 'POST /api/vod/genres/config'),
  'se guardaron las reglas'
);
ok(
  !text().includes('Falta la API Key de TMDB'),
  'tras guardar las reglas sigue sin avisar (el POST no traía tmdb)',
  postGenreDropsTmdb ? 'servidor viejo simulado' : ''
);
const vista = byText('button', 'Vista Previa');
const aplicar = byText('button', 'Aplicar a Películas y Series');
ok(vista?.disabled === false, '«Vista Previa» queda habilitada');
ok(aplicar?.disabled === false, '«Aplicar» queda habilitada');

// ==================== 6. Caso 2: guardar la clave refresca la tarjeta ====================
// Se vuelve a montar la pantalla con la clave sin configurar, se guarda desde el
// modal y la tarjeta debe dejar de avisar sin recargar.
tmdbConfigured = false;
await act(async () => {
  root.unmount();
  await new Promise((r) => setTimeout(r, 50));
});
root = await mount();
await abrirCarpetas();
ok(text().includes('Falta la API Key de TMDB'), 'sin clave, avisa de que falta');

const configurar = byText('button', 'Configurar TMDB');
ok(!!configurar, 'el aviso ofrece «Configurar TMDB»');
if (configurar) await click(configurar);

const inputKey = [...document.querySelectorAll('input[type="password"]')].pop();
ok(!!inputKey, 'el modal de TMDB pide la clave');
if (inputKey) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputKey, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    inputKey.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
  });
}
const guardarTmdb = byText('button', 'Guardar y Probar TMDB');
ok(!!guardarTmdb, 'el modal tiene «Guardar y Probar TMDB»');
if (guardarTmdb) await click(guardarTmdb);

ok(
  calls.some((c) => c.key === 'POST /api/tmdb/config'),
  'se guardó la clave desde el modal'
);
ok(
  calls.filter((c) => c.key === 'GET /api/vod/genres/config').length >= 2,
  'la pantalla volvió a pedir el estado de la tarjeta',
  `${calls.filter((c) => c.key === 'GET /api/vod/genres/config').length} veces`
);

// Se cierra el modal de TMDB para ver la tarjeta de géneros.
const cerrar = [...document.querySelectorAll('button')].find((b) => b.querySelector('svg') && b.closest('.fixed'));
if (cerrar) await click(cerrar);
ok(!text().includes('Falta la API Key de TMDB'), 'tras guardar la clave ya no avisa (sin recargar)');

console.log(fails.length === 0 ? '\nTODO OK' : `\n${fails.length} fallo(s)`);
process.exit(fails.length === 0 ? 0 : 1);
