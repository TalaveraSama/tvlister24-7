#!/usr/bin/env node
// Pantalla «Flussonic: enviar los canales desde ahí» (UDP / CATV).
//
// Renderiza la página real (jsdom) con una API simulada y comprueba lo que ve
// el operador y lo que se envía al panel cuando pulsa:
//   · Detectar canal → stream   (mapeo, vista previa y guardado)
//   · Enviar todos por Flussonic / Volver todo a TVLister
//   · la tabla con stream, destino, estado y Mbps de cada canal delegado
//   · el aviso de los canales que no encontraron stream
//
// Uso:  node scripts/test_catv_flussonic_ui.mjs   (requiere jsdom)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('omitido: jsdom no está instalado (npm i --no-save jsdom)');
  process.exit(0);
}

const fails = [];
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails.push(label);
};

const tmp = path.join(ROOT, 'node_modules', '.tvfsui');
fs.mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, 'Wk2500CatvPage.mjs');
const { build } = await import('esbuild');
await build({
  entryPoints: [path.join(ROOT, 'src/pages/Wk2500CatvPage.jsx')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  loader: { '.jsx': 'jsx' },
  jsx: 'automatic',
  external: ['react', 'react-dom'],
  logLevel: 'error'
});

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

const calls = [];
let delegated = [
  {
    catv_ch: 2,
    name: 'CANAL 2 NACIONAL',
    stream: 'NACIONAL 2',
    dest: 'udp://239.25.0.2:5002?ttl=16',
    exists: true,
    alive: true,
    bitrate_kbps: 2410,
    has_output: true,
    outputs: ['udp://239.25.0.2:5002?ttl=16'],
    verdict: 'ok'
  },
  {
    catv_ch: 5,
    name: 'CANAL 5',
    stream: 'CANAL 5 HD',
    dest: 'udp://239.25.0.5:5005?ttl=16',
    exists: true,
    alive: false,
    bitrate_kbps: 0,
    has_output: false,
    outputs: [],
    verdict: 'stream_caido'
  }
];

const snapshot = () => ({
  ok: true,
  flussonic_reachable: true,
  streams_available: 4,
  flussonic_channels: delegated.length,
  local_channels: 3,
  server: { id: 1, name: 'Astra', base_url: 'http://127.0.0.1:8080' },
  channels: delegated.map((c) => ({ ...c })),
  ready: true
});

globalThis.fetch = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const key = `${method} ${url}`;
  calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
  let data = {};
  if (key === 'GET /api/wk2500/flussonic-control') data = snapshot();
  else if (key === 'GET /api/wk2500/plan')
    data = {
      slots: [],
      units: [],
      streams: [],
      models: [],
      brands: [],
      tv_standards: [],
      coverage: {},
      summary: {},
      dedicated_nic: null
    };
  else if (key === 'GET /api/wk2500/udp-engine')
    data = { servers: [{ id: 1, name: 'Astra', base_url: 'http://127.0.0.1:8080' }], channels: [] };
  else if (key === 'POST /api/wk2500/flussonic-control/auto-map')
    data = {
      ok: true,
      dryRun: (options.body ? JSON.parse(options.body) : {}).dryRun !== false,
      available_streams: 4,
      candidates: 2,
      written: (options.body ? JSON.parse(options.body) : {}).dryRun === false ? 2 : 0,
      mapped: [
        { catv_ch: 2, stream: 'NACIONAL 2', method: 'nombre exacto' },
        { catv_ch: 5, stream: 'CANAL 5 HD', method: 'parecido' }
      ],
      unmatched: [{ catv_ch: 9, name: 'CANAL 9', suggestions: [{ name: 'NUEVE', score: 0.5 }] }]
    };
  else if (key === 'POST /api/wk2500/flussonic-control/switch') {
    delegated = [
      {
        catv_ch: 2,
        name: 'CANAL 2 NACIONAL',
        stream: 'NACIONAL 2',
        dest: 'udp://239.25.0.2:5002?ttl=16',
        exists: true,
        alive: true,
        bitrate_kbps: 2410,
        has_output: true,
        outputs: ['udp://239.25.0.2:5002?ttl=16'],
        verdict: 'ok'
      }
    ];
    data = {
      ok: true,
      engine: 'flussonic',
      switched: 2,
      failed: 0,
      detail: [],
      message: '2 de 2 canal(es) ahora salen por Flussonic.',
      snapshot: snapshot()
    };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const Page = (await import(bundle)).default;

const root = createRoot(document.getElementById('root'));
await act(async () => {
  root.render(React.createElement(Page, { setActiveTab: () => {} }));
  await new Promise((r) => setTimeout(r, 300));
});

const text = () => document.body.textContent.replace(/\s+/g, ' ');
const byText = (sel, needle) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(needle));
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
  });

// --- 0. La página está separada en tres mundos --------------------------
ok(text().includes('1 · Nativo TVLister'), 'la pestaña de lo nativo está a la vista');
ok(text().includes('2 · Flussonic · quién emite'), 'la pestaña de Flussonic está a la vista');
ok(text().includes('3 · Flussonic UDP · push'), 'la pestaña de la salida UDP está a la vista');
ok(!text().includes('Flussonic · quién emite cada canal'), 'al abrir, sólo se ve lo nativo (sin revoltijo)');

// --- 1. La tarjeta está y cuenta quién emite -----------------------------
const tabControl = byText('button', '2 · Flussonic · quién emite');
ok(Boolean(tabControl), 'existe la pestaña de quién emite');
if (tabControl) await click(tabControl);
ok(text().includes('Flussonic · quién emite cada canal'), 'la tarjeta de control de Flussonic está a la vista');
ok(text().includes('Flussonic responde · 4 streams'), 'dice si Flussonic responde y cuántos streams tiene');
ok(text().includes('Flussonic: 2') && text().includes('TVLister: 3'), 'cuenta canales por Flussonic y por TVLister');

// --- 2. Tabla por canal --------------------------------------------------
ok(text().includes('NACIONAL 2'), 'la tabla muestra el stream de cada canal');
ok(text().includes('239.25.0.2:5002'), 'la tabla muestra el destino UDP real', text().match(/udp:\/\/[^\s]+/)?.[0]);
ok(text().includes('2,4') || text().includes('2.4'), 'muestra el bitrate que reporta Flussonic');
ok(text().includes('Emitiendo'), 'marca el canal que Flussonic está emitiendo');
ok(text().includes('Stream caído'), 'marca el canal cuyo stream está caído');
ok(!!byText('button', 'Volver a local'), 'cada canal tiene su botón «Volver a local»');

// --- 3. Detectar canal → stream -----------------------------------------
const detect = byText('button', 'Detectar canal → stream');
ok(!!detect, 'existe el botón de detectar canales');
if (detect) await click(detect);
const mapCall = calls.find((c) => c.key === 'POST /api/wk2500/flussonic-control/auto-map');
ok(!!mapCall, 'llama al mapeo automático');
ok(mapCall?.body?.dryRun === true, 'la primera vez sólo mira (no escribe)', JSON.stringify(mapCall?.body));
ok(text().includes('Vista previa'), 'avisa de que es una vista previa');
ok(text().includes('sin stream de Flussonic reconocido') || text().includes('quizá'), 'muestra los canales sin coincidencia con sugerencias');

const saveBtn = byText('button', 'Guardar mapeo');
ok(!!saveBtn, 'ofrece guardar el mapeo');
if (saveBtn) await click(saveBtn);
const saveCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-control/auto-map').pop();
ok(saveCall?.body?.dryRun === false, 'al guardar escribe de verdad (dryRun: false)', JSON.stringify(saveCall?.body));

// --- 4. Enviar todos por Flussonic --------------------------------------
const sendAll = byText('button', 'Enviar todos por Flussonic');
ok(!!sendAll, 'existe «Enviar todos por Flussonic»');
if (sendAll) await click(sendAll);
const switchCall = calls.find((c) => c.key === 'POST /api/wk2500/flussonic-control/switch');
ok(!!switchCall, 'llama al cambio de motor');
ok(switchCall?.body?.engine === 'flussonic' && switchCall?.body?.all === true, 'pide Flussonic para todos los canales', JSON.stringify(switchCall?.body));
ok(text().includes('ahora salen por Flussonic'), 'el panel confirma cuántos canales cambiaron');

// --- 5. Volver todo a TVLister ------------------------------------------
const backAll = byText('button', 'Volver todo a TVLister');
ok(!!backAll, 'existe «Volver todo a TVLister»');
if (backAll) await click(backAll);
const backCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-control/switch').pop();
ok(backCall?.body?.engine === 'local', 'pide volver al motor local', JSON.stringify(backCall?.body));

// --- 6. Rango ------------------------------------------------------------
const sendRange = byText('button', 'Enviar rango');
ok(!!sendRange, 'existe el envío por rango de canales');

console.log(fails.length === 0 ? '\nTODO OK' : `\n${fails.length} fallo(s)`);
process.exit(fails.length ? 1 : 0);
