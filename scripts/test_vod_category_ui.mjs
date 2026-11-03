#!/usr/bin/env node
// Comprobación de la tarjeta «Categorías del catálogo: borrar las que sobran»
// renderizando la pantalla real de Películas con jsdom.
//
// Uso:  node scripts/test_vod_category_ui.mjs
// Requiere jsdom (npm i -D jsdom). Si no está instalado, la prueba se omite y
// termina en 0: no es una dependencia del panel, sólo de esta comprobación.
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
const ok = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FALLO'} ${label}`);
  if (!cond) fails.push(label);
};

// ==================== 1. Compilar la pantalla ====================
// El paquete se compila dentro de node_modules para que resuelva react/react-dom.
const tmp = path.join(ROOT, 'node_modules', '.tvcatui');
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

// ==================== 2. Entorno del navegador ====================
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

// ==================== 3. Respuestas del panel ====================
const usageA = {
  categories: [
    { id: 1, name: 'Ciencia Ficcion', type: 'vod', sort_order: 1, movies: 1, series: 0, total: 1, empty: false },
    { id: 2, name: 'triller', type: 'vod', sort_order: 2, movies: 0, series: 0, total: 0, empty: true },
    { id: 3, name: 'Acción', type: 'vod', sort_order: 3, movies: 4, series: 0, total: 4, empty: false },
    { id: 4, name: 'accion', type: 'vod', sort_order: 4, movies: 0, series: 0, total: 0, empty: true }
  ],
  total: 4,
  empty: 2,
  withContent: 2,
  subfolderFolders: [{ id: 9, path: '/srv/pelis/Ciencia Ficcion', category_mode: 'subfolders' }]
};
const usageB = {
  categories: [{ id: 3, name: 'Acción', type: 'vod', sort_order: 3, movies: 5, series: 0, total: 5, empty: false }],
  total: 1,
  empty: 0,
  withContent: 1
};
const base = {
  'GET /api/vod': [],
  'GET /api/categories': [],
  'GET /api/series': [],
  'GET /api/vod/folders': [],
  'GET /api/tmdb/config': { configured: true, language: 'es-MX' },
  'GET /api/jellyfin/config': { configured: false },
  'GET /api/vod/genres/config': { aliasesText: '', priorityText: '', categories: [], aliases: {}, priority: [] }
};
let usageCalls = 0;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const key = `${(options.method || 'GET').toUpperCase()} ${url}`;
  calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
  let data;
  if (key === 'GET /api/vod/categories/usage') {
    usageCalls += 1;
    data = usageCalls === 1 ? usageA : usageB;
  } else if (key === 'POST /api/vod/categories/purge') {
    data = { ok: true, deleted: 2, deletedNames: ['Ciencia Ficcion', 'triller'], moved: { movies: 1, series: 0 }, moveToId: 3 };
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

// ==================== 4. Montar la pantalla ====================
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const VodPage = (await import(bundle)).default;

const root = createRoot(document.getElementById('root'));
await act(async () => {
  root.render(React.createElement(VodPage, {}));
  await new Promise((r) => setTimeout(r, 150));
});

const text = () => document.body.textContent.replace(/\s+/g, ' ');
const byText = (sel, needle) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(needle));
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  });
const tick = (el, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'checked').set;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
  });
const pick = (el, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
  });

const openBtn = byText('button', 'Sincronizar Carpeta');
ok(!!openBtn, 'existe «Sincronizar Carpeta»');
if (openBtn) await click(openBtn);
ok(text().includes('Categorías del catálogo: borrar las que sobran'), 'la tarjeta está en el modal');

const review = byText('button', 'Revisar categorías');
ok(!!review, 'existe «Revisar categorías»');
if (review) await click(review);
ok(calls.some((c) => c.key === 'GET /api/vod/categories/usage'), 'pide el uso por categoría');
ok(text().includes('4 categoría(s)') && text().includes('2 vacía(s)'), 'resume cuántas hay y cuántas están vacías');
ok(text().includes('volverá a crear sus categorías'), 'avisa de las carpetas que recrearán las categorías');

const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter((b) =>
  b.closest('label')?.textContent?.match(/película\(s\)/)
);
const boxFor = (name) => boxes.find((b) => b.closest('label').textContent.includes(name));
ok(boxFor('triller')?.checked === true && boxFor('accion')?.checked === true, 'las vacías vienen marcadas');
ok(boxFor('Acción')?.checked === false && boxFor('Ciencia Ficcion')?.checked === false, 'las que tienen contenido no');

await tick(boxFor('Ciencia Ficcion'), true);
ok(text().includes('Mover el contenido de las categorías con títulos a:'), 'pide destino al marcar una con contenido');
ok(byText('button', 'Borrar 3 categoría(s)')?.disabled === true, 'sin destino, «Borrar» está bloqueado');

const dest = [...document.querySelectorAll('select')].find((s) =>
  [...s.options].some((o) => o.textContent.includes('Acción (4 título(s))'))
);
ok(!!dest, 'el selector ofrece «Acción» con su recuento');
if (dest) await pick(dest, '3');

const purge = byText('button', 'Borrar 3 categoría(s)');
ok(purge?.disabled === false, 'con destino, «Borrar» se habilita');
if (purge) await click(purge);

const sent = calls.find((c) => c.key === 'POST /api/vod/categories/purge');
ok(!!sent, 'llama a /api/vod/categories/purge');
ok(JSON.stringify(sent?.body?.ids?.slice().sort()) === JSON.stringify([1, 2, 4]), `ids enviados: ${JSON.stringify(sent?.body?.ids)}`);
ok(sent?.body?.moveToId === 3, 'envía la categoría de destino');
ok(text().includes('Borradas 2 categoría(s)'), 'informa de lo borrado');
ok(text().includes('Se movieron 1 películas'), 'informa de lo movido');
ok(usageCalls === 2, 'recarga el uso después de borrar');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (fails.length) {
  console.log(`FALLOS: ${fails.length}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('UI TODO OK');
process.exit(0);
