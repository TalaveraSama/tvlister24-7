// Prueba de humo de la interfaz: renderiza cada vista con jsdom.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const BASE = process.env.BASE || 'http://localhost:8420';
const html = fs.readFileSync('public/index.html', 'utf8');
const dom = new JSDOM(html, { url: `${BASE}/#/monitor`, pretendToBeVisual: true });
const { window } = dom;

global.window = window;
global.document = window.document;
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const realFetch = global.fetch;
global.fetch = (url, opts) => realFetch(url.startsWith('http') ? url : BASE + url, opts);
window.fetch = global.fetch;
class ES { constructor() {} addEventListener() {} close() {} }
global.EventSource = ES;
window.EventSource = ES;

const views = ['monitor', 'playlists', 'grid', 'ads', 'library', 'graphics', 'live', 'recording', 'emergency', 'asrun', 'settings'];
let failures = 0;
const boot = await (await fetch('/api/bootstrap')).json();
const snap = boot.snapshot;

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
process.on('unhandledRejection', (e) => errors.push(e?.message || String(e)));

for (const name of views) {
  const mod = await import(`../public/js/views/${name}.js`);
  const ctx = {
    state: { boot, snap, name },
    api: {
      get: async (p) => (await fetch(p)).json(),
      post: async (p, b) => (await fetch(p, { method: 'POST', body: JSON.stringify(b || {}), headers: { 'content-type': 'application/json' } })).json(),
      patch: async (p, b) => (await fetch(p, { method: 'PATCH', body: JSON.stringify(b || {}), headers: { 'content-type': 'application/json' } })).json(),
      del: async (p) => (await fetch(p, { method: 'DELETE' })).json(),
    },
    refresh: async () => {},
    refreshQuiet: async () => {},
    rerender: async () => {},
    go: () => {},
  };
  const root = window.document.getElementById('view');
  root.innerHTML = '';
  try {
    await mod.render(root, ctx);
    const size = root.innerHTML.length;
    const buttons = root.querySelectorAll('button').length;
    const inputs = root.querySelectorAll('input,select,textarea').length;
    if (size < 500) throw new Error(`HTML demasiado pequeño (${size})`);
    console.log(`OK   ${name.padEnd(10)} ${String(size).padStart(6)} bytes · ${buttons} botones · ${inputs} campos`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name.padEnd(10)} ${err.message}`);
    console.log(err.stack?.split('\n').slice(0, 4).join('\n'));
  }
  if (typeof mod.onState === 'function') {
    try { mod.onState(snap, ctx); } catch (err) { failures++; console.log(`FAIL ${name} onState: ${err.message}`); }
  }
}

if (errors.length) { console.log('Errores de ventana:', errors); failures++; }
console.log(failures ? `\n${failures} fallo(s)` : '\nTodas las vistas renderizan correctamente');
process.exit(failures ? 1 : 0);
