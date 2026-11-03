#!/usr/bin/env node
// Pantalla de balancers: se escribe la IP y la clave del VPS y el panel instala
// el nodo. Renderiza la pantalla real (jsdom) y comprueba el flujo de la
// tarjeta «Balancers con ancho de banda propio».
//
// Uso:  node scripts/test_balancer_ui.mjs   (requiere jsdom; si no está, se omite)
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

const tmp = path.join(ROOT, 'node_modules', '.tvbal');
fs.mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, 'ServersSecurityPage.mjs');
const { build } = await import('esbuild');
await build({
  entryPoints: [path.join(ROOT, 'src/pages/ServersSecurityPage.jsx')],
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
const servers = [
  { id: 1, name: 'Maestro', host: '173.208.183.66', port: 8095, is_main: 1, status: 'online' }
];
const system = () => ({
  servers: servers.map((s) => ({ ...s })),
  profiles: [],
  firewall: [],
  settings: {
    panel_name: 'TVLister',
    lb_routing_mode: 'load',
    master_max_bandwidth_mbps: '800',
    lb_master_offload_pct: '0'
  },
  admins: [{ id: 1, username: 'admin', role: 'admin', status: 'active' }],
  snapshots: [],
  dbSizeKb: 10,
  listenPort: 8095,
  telemetry: { cpuPercent: 10, ramPercent: 20 },
  egressMbps: 120.5,
  masterMaxBandwidthMbps: 800
});

globalThis.fetch = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const key = `${method} ${url}`;
  calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
  let data = {};
  if (key === 'GET /api/system') data = system();
  else if (key === 'GET /api/system/ffmpeg-efficiency') data = {};
  else if (key === 'GET /api/servers/streams')
    data = {
      nodes: [
        { id: 1, name: 'Maestro', is_main: true, streams: 20 },
        { id: 2, name: 'Balancer MX-2', is_main: false, streams: 40 }
      ]
    };
  else if (key === 'POST /api/servers/balance-streams')
    data = { ok: true, total: 60, assigned: { 2: 60 }, nodes: [{ id: 1, name: 'Maestro', is_main: true, streams: 0 }, { id: 2, name: 'Balancer MX-2', is_main: false, streams: 60 }] };
  else if (key === 'GET /api/system/readiness')
    data = { checks: [], streamShieldActive: true, actionNeeded: false, pendingWarnings: 0 };
  else if (key === 'POST /api/servers/install') {
    servers.push({ id: 2, name: 'Balancer MX-2', host: '10.0.0.9', port: 8096, is_main: 0, status: 'standby', install_status: 'running' });
    data = { ok: true, id: 2, jobId: 'job123', manual_command: "curl -fsSL 'http://x/api/lb/install.sh' | bash -s -- --token 'edge_x'" };
  } else if (key === 'GET /api/servers/install/job123') {
    data = { jobId: 'job123', status: 'ok', log: 'Conectado a 10.0.0.9\n✅ Nodo Balancer activo' };
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
  root.render(React.createElement(Page, {}));
  await new Promise((r) => setTimeout(r, 250));
});

const text = () => document.body.textContent.replace(/\s+/g, ' ');
const byText = (sel, needle) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(needle));
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  });

const tab = byText('button', 'Nodos Edge Load Balancer');
ok(!!tab, 'existe la pestaña de nodos');
if (tab) await click(tab);

ok(text().includes('Balancers con ancho de banda propio'), 'la tarjeta nueva está a la vista');
ok(text().includes('120.5 / 800 Mbps'), 'muestra la salida del maestro y su tope', text().match(/Maestro: [^M]+Mbps/)?.[0]);

const inputs = [...document.querySelectorAll('input')];
const byPlaceholder = (p) => inputs.find((i) => (i.placeholder || '').includes(p));
ok(!!byPlaceholder('IP o dominio del VPS'), 'pide la IP del VPS');
ok(!!byPlaceholder('Contraseña SSH'), 'pide la contraseña SSH');
ok(!!byPlaceholder('Puerto SSH'), 'pide el puerto SSH');
ok(!!byPlaceholder('Mbps del VPS'), 'pide la capacidad del VPS en Mbps');
ok(text().includes('Instalar y conectar el balancer'), 'tiene el botón de instalar');

// Rellenar IP y contraseña, y pulsar instalar.
const set = async (el, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  });
};
const hostInput = byPlaceholder('IP o dominio del VPS');
const passInput = byPlaceholder('Contraseña SSH');
const nameInput = byPlaceholder('Nombre (ej. Balancer MX-2)');
if (hostInput) await set(hostInput, '10.0.0.9');
if (passInput) await set(passInput, 'clave-del-vps');
if (nameInput) await set(nameInput, 'Balancer MX-2');

const installBtn = byText('button', 'Instalar y conectar el balancer');
if (installBtn) await click(installBtn);

const sent = calls.find((c) => c.key === 'POST /api/servers/install');
ok(!!sent, 'llama a /api/servers/install');
ok(sent?.body?.host === '10.0.0.9', 'envía la IP del VPS', JSON.stringify(sent?.body?.host));
ok(sent?.body?.ssh_password === 'clave-del-vps', 'envía la clave por POST (no por URL)');

await act(async () => {
  await new Promise((r) => setTimeout(r, 2200));
});
ok(text().includes('Instalación en 10.0.0.9'), 'muestra el progreso de la instalación');
ok(text().includes('Terminada') || text().includes('Instalando'), 'el panel sigue el estado del trabajo');
ok(calls.some((c) => c.key === 'GET /api/servers/install/job123'), 'consulta el log del trabajo');
ok(text().includes('Balancer MX-2'), 'el nodo aparece en la lista');

// --- Reparto de canales entre nodos -------------------------------------
ok(text().includes('Reparto de canales entre nodos'), 'la tarjeta de reparto está a la vista');
ok(text().includes('Maestro: 20 canal(es)'), 'muestra cuántos canales tiene el maestro', text().match(/Maestro: \d+ canal\(es\)/)?.[0]);
ok(text().includes('Balancer MX-2: 40 canal(es)') || text().includes('40 canal(es)'), 'muestra los canales de cada nodo');

const balanceBtn = byText('button', 'Repartir automáticamente');
ok(!!balanceBtn, 'existe el botón de reparto automático');
if (balanceBtn) await click(balanceBtn);
await act(async () => {
  await new Promise((r) => setTimeout(r, 300));
});
ok(calls.some((c) => c.key === 'POST /api/servers/balance-streams'), 'llama al reparto automático');
ok(text().includes('Repartidos 60 canales'), 'informa cuántos canales repartió', text().match(/Repartidos[^.]*/)?.[0]);
ok(text().includes('60 canal(es)'), 'el resumen refleja el reparto');

console.log(fails.length === 0 ? '\nTODO OK' : `\n${fails.length} fallo(s)`);
process.exit(fails.length === 0 ? 0 : 1);
