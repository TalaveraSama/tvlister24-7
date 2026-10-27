// Prueba de interacción: formularios modales, toggles y envíos a la API.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const BASE = 'http://localhost:8420';
const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: `${BASE}/`, pretendToBeVisual: true });
const { window } = dom;
Object.assign(global, {
  window, document: window.document, location: window.location, Event: window.Event,
  HTMLElement: window.HTMLElement, Node: window.Node,
});
const realFetch = global.fetch;
global.fetch = (u, o) => realFetch(u.startsWith('http') ? u : BASE + u, o);
window.fetch = global.fetch;

const errors = [];
process.on('unhandledRejection', (e) => errors.push(e.message || String(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => window.document.querySelector(s);
const qa = (s) => [...window.document.querySelectorAll(s)];

const boot = await (await fetch('/api/bootstrap')).json();
const ctxFor = (name) => ({
  state: { boot, snap: boot.snapshot, name },
  api: {
    get: async (p) => (await fetch(p)).json(),
    post: async (p, b) => {
      const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'error'); return j;
    },
    patch: async (p, b) => {
      const r = await fetch(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'error'); return j;
    },
    del: async (p) => (await fetch(p, { method: 'DELETE' })).json(),
  },
  refresh: async () => {}, rerender: async () => {}, go: () => {},
});

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('OK   ' + m); };
const bad = (m, e) => { fail++; console.log('FAIL ' + m + (e ? ' :: ' + e : '')); };

// --- 1. Formulario de nuevo bloque de parrilla
try {
  const grid = await import('../public/js/views/grid.js');
  const view = q('#view'); view.innerHTML = '';
  await grid.render(view, ctxFor('grid'));
  q('[data-act="new"]').click();
  await sleep(50);
  const modal = q('.modal-backdrop');
  if (!modal) throw new Error('no abrió el modal');
  const form = modal.querySelector('form');
  form.querySelector('[name="name"]').value = 'Bloque de prueba UI';
  form.querySelector('[name="start"]').value = '03:00';
  form.querySelector('[name="end"]').value = '04:00';
  form.querySelector('[name="playlistId"]').value = boot.playlists[0].id;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(700);
  const after = await (await fetch('/api/grid')).json();
  const created = after.entries.find((e) => e.name === 'Bloque de prueba UI');
  if (!created) throw new Error('no se creó el bloque');
  ok('parrilla: crear bloque desde el formulario');
  await fetch(`/api/grid/entries/${created.id}`, { method: 'DELETE' });
} catch (err) { bad('parrilla: crear bloque', err.message); }

// --- 2. Toggle de gráficos
try {
  const graphics = await import('../public/js/views/graphics.js');
  const view = q('#view'); view.innerHTML = '';
  await graphics.render(view, ctxFor('graphics'));
  const sw = q('[data-switch="clock.enabled"]');
  const before = (await (await fetch('/api/graphics')).json()).graphics.clock.enabled;
  sw.click();
  await sleep(600);
  const after = (await (await fetch('/api/graphics')).json()).graphics.clock.enabled;
  if (before === after) throw new Error('no cambió el estado');
  ok('gráficos: interruptor de reloj');
  await fetch('/api/graphics', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clock: { enabled: before } }) });
} catch (err) { bad('gráficos: toggle', err.message); }

// --- 3. Botón de pausa del monitor
try {
  const monitor = await import('../public/js/views/monitor.js');
  const view = q('#view'); view.innerHTML = '';
  await monitor.render(view, ctxFor('monitor'));
  const paused0 = (await (await fetch('/api/state')).json()).runtime.paused;
  q('#btn-toggle').click();
  await sleep(600);
  const paused1 = (await (await fetch('/api/state')).json()).runtime.paused;
  if (paused0 === paused1) throw new Error('no cambió la pausa');
  ok('monitor: pausar / continuar');
  if (paused1) { await fetch('/api/playout/resume', { method: 'POST' }); }
} catch (err) { bad('monitor: pausa', err.message); }

// --- 4. Enviar al aire desde la biblioteca
try {
  const lib = await import('../public/js/views/library.js');
  const view = q('#view'); view.innerHTML = '';
  await lib.render(view, ctxFor('library'));
  const btn = q('[data-air]');
  btn.click();
  await sleep(700);
  const st = await (await fetch('/api/state')).json();
  if (st.runtime.mode !== 'manual') throw new Error(`modo inesperado ${st.runtime.mode}`);
  ok('biblioteca: enviar al aire');
  await fetch('/api/playout/automation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
} catch (err) { bad('biblioteca: enviar al aire', err.message); }

// --- 5. Vista de emergencia: guardar configuración
try {
  const em = await import('../public/js/views/emergency.js');
  const view = q('#view'); view.innerHTML = '';
  await em.render(view, ctxFor('emergency'));
  q('#silence').value = '20';
  q('[data-act="save"]').click();
  await sleep(600);
  const res = await (await fetch('/api/emergency')).json();
  if (res.silenceSeconds !== 20) throw new Error('no guardó');
  ok('emergencia: guardar configuración');
  await fetch('/api/emergency', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ silenceSeconds: 15 }) });
} catch (err) { bad('emergencia: guardar', err.message); }

// --- 6. Crear lista desde el formulario
try {
  const pl = await import('../public/js/views/playlists.js');
  const view = q('#view'); view.innerHTML = '';
  await pl.render(view, ctxFor('playlists'));
  q('[data-act="new"]').click();
  await sleep(50);
  const form = q('.modal form');
  form.querySelector('[name="name"]').value = 'Lista UI Test';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(700);
  const lists = await (await fetch('/api/playlists')).json();
  const created = lists.find((l) => l.name === 'Lista UI Test');
  if (!created) throw new Error('no se creó');
  ok('listas: crear lista');
  await fetch(`/api/playlists/${created.id}`, { method: 'DELETE' });
} catch (err) { bad('listas: crear', err.message); }

// --- 7. File Slots en la biblioteca
try {
  const lib = await import('../public/js/views/library.js');
  const view = q('#view'); view.innerHTML = '';
  await lib.render(view, ctxFor('library'));
  q('[data-tab="slots"]').click();
  await sleep(200);
  const html = q('#tab-content').innerHTML;
  if (!html.includes('Cortinas del canal')) throw new Error('no listó los slots');
  const before = (await (await fetch('/api/slots')).json())[0];
  q('[data-slot-rotate]').click();
  await sleep(500);
  const after = (await (await fetch('/api/slots')).json())[0];
  if (after.cursor === before.cursor) throw new Error('no rotó el slot');
  ok('biblioteca: File Slots (listado y rotación)');
} catch (err) { bad('biblioteca: File Slots', err.message); }

if (errors.length) { console.log('Errores no controlados:', errors); fail += errors.length; }
console.log(`\n${pass} pruebas correctas, ${fail} fallos`);
process.exit(fail ? 1 : 0);
