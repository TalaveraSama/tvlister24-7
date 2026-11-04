#!/usr/bin/env node
// Pantalla «Salidas UDP de Flussonic (push)» — v2.6.34.
//
// Renderiza la página real (jsdom) con una API simulada y comprueba lo que ve
// el operador y lo que se manda al panel:
//   · streams de Flussonic con su canal de la lista, su URL de push y su MB
//   · editar una fila → Guardar / Quitar
//   · «Ver plan del rango» (no escribe) y «Poner salida UDP del rango»
//   · «Quitar salidas del rango»
//   · el aviso de canales sin stream y el filtro de streams sueltos
//
// Uso:  node scripts/test_catv_flussonic_push_ui.mjs   (requiere jsdom)
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

const tmp = path.join(ROOT, 'node_modules', '.tvpushui');
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
let withPush = 2;

const pushSnapshot = () => ({
  ok: true,
  server: { id: 1, name: 'Astra', base_url: 'http://127.0.0.1:8080' },
  flussonic_reachable: true,
  flussonic_error: '',
  iface: 'ens37',
  total: 4,
  with_push: withPush,
  in_sync: 1,
  streams: [
    {
      name: 'NACIONAL 2',
      title: 'Nacional 2',
      alive: true,
      bitrate_kbps: 2410,
      clients: 0,
      udp_outputs: ['udp://ens37@239.25.0.2:5002'],
      other_outputs: ['rtmp://10.0.0.9/live/n2'],
      push: { url: 'udp://ens37@239.25.0.2:5002', state: 'running', running: true, bytes: 140718898, mb: 134.2 },
      channel: { catv_ch: 2, name: 'NACIONAL 2', dest: 'udp://ens37@239.25.0.2:5002', engine: 'flussonic', method: 'nombre exacto' },
      suggested_url: 'udp://ens37@239.25.0.2:5002',
      in_sync: true
    },
    {
      name: 'TELEMUNDO',
      title: 'Telemundo',
      alive: true,
      bitrate_kbps: 2600,
      clients: 0,
      udp_outputs: ['udp://ens37@239.9.9.9:9999'],
      other_outputs: [],
      push: { url: 'udp://ens37@239.9.9.9:9999', state: 'running', running: true, bytes: 3145728, mb: 3 },
      channel: { catv_ch: 3, name: 'Telemundo', dest: 'udp://ens37@239.25.0.3:5003', engine: 'local', method: 'nombre exacto' },
      suggested_url: 'udp://ens37@239.25.0.3:5003',
      in_sync: false
    },
    {
      name: 'CANAL 7',
      title: 'Canal 7',
      alive: true,
      bitrate_kbps: 2100,
      clients: 0,
      udp_outputs: [],
      other_outputs: [],
      push: null,
      channel: { catv_ch: 7, name: 'CANAL 7', dest: 'udp://ens37@239.25.0.7:5007', engine: 'local', method: 'nombre exacto' },
      suggested_url: 'udp://ens37@239.25.0.7:5007',
      in_sync: false
    },
    {
      name: 'STREAM SUELTO',
      title: 'sin canal en la lista',
      alive: true,
      bitrate_kbps: 1000,
      clients: 0,
      udp_outputs: [],
      other_outputs: [],
      push: null,
      channel: null,
      suggested_url: '',
      in_sync: false
    }
  ],
  channels_sin_stream: [{ catv_ch: 9, name: 'CANAL 9', dest: 'udp://ens37@239.25.0.9:5009' }]
});

globalThis.fetch = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  const key = `${method} ${url}`;
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ key, body });
  let data = {};
  if (key === 'GET /api/wk2500/flussonic-push') data = pushSnapshot();
  else if (key === 'GET /api/wk2500/flussonic-control')
    data = {
      ok: true,
      flussonic_reachable: true,
      streams_available: 4,
      flussonic_channels: 1,
      local_channels: 3,
      server: { id: 1, name: 'Astra' },
      channels: [],
      ready: false
    };
  else if (key === 'GET /api/wk2500/plan')
    data = { slots: [], units: [], streams: [], models: [], brands: [], tv_standards: [], coverage: {}, summary: {}, dedicated_nic: null };
  else if (key === 'GET /api/wk2500/udp-engine') data = { servers: [], channels: [] };
  else if (key === 'POST /api/wk2500/flussonic-push/interface') data = { ok: true, iface: body?.iface || '' };
  else if (key === 'POST /api/wk2500/flussonic-push') {
    if (body?.from_channels) {
      const dry = body.dry_run === true;
      data = {
        ok: true,
        dryRun: dry,
        message: dry ? '' : '3 de 3 stream(s) con la salida UDP del canal.',
        detail: [
          { catv_ch: 2, stream: 'NACIONAL 2', url: 'udp://ens37@239.25.0.2:5002', ok: true },
          { catv_ch: 3, stream: 'TELEMUNDO', url: 'udp://ens37@239.25.0.3:5003', ok: true },
          { catv_ch: 7, stream: 'CANAL 7', url: 'udp://ens37@239.25.0.7:5007', ok: true }
        ],
        sin_stream: [{ catv_ch: 9, name: 'CANAL 9', reason: 'sin stream de Flussonic reconocido', suggestions: [] }],
        snapshot: pushSnapshot()
      };
      if (!dry) withPush = 3;
    } else {
      data = {
        ok: true,
        detail: [
          {
            stream: body?.items?.[0]?.stream,
            url: body?.items?.[0]?.url,
            ok: true,
            already: false,
            action: body?.items?.[0]?.remove ? 'quitada' : 'puesta',
            error: ''
          }
        ],
        snapshot: pushSnapshot()
      };
    }
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
  await new Promise((r) => setTimeout(r, 350));
});

const text = () => document.body.textContent.replace(/\s+/g, ' ');
const byText = (sel, needle) => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(needle));
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
  });
const type = (el, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
  });

// --- 1. La tarjeta está y resume el estado -------------------------------
ok(text().includes('Salidas UDP de Flussonic (push)'), 'la tarjeta de push está a la vista');
ok(text().includes('Flussonic responde · 4 streams'), 'dice si Flussonic responde y cuántos streams tiene');
ok(text().includes('Con salida UDP: 2'), 'cuenta los streams con salida UDP', text().match(/Con salida UDP: \d+/)?.[0]);
ok(text().includes('1 con otra IP/puerto'), 'avisa de los que tienen otra IP/puerto');

// --- 2. Tabla: stream, canal, URL, estado y MB --------------------------
ok(text().includes('NACIONAL 2') && text().includes('CH2'), 'muestra el stream y su canal de la lista');
ok(
  text().includes('239.25.0.2:5002') || [...document.querySelectorAll('input')].some((i) => String(i.value).includes('239.25.0.2:5002')),
  'muestra la salida UDP actual'
);
ok(text().includes('134.2 MB'), 'muestra lo enviado (como el «running · 134.2 MB» de Flussonic)');
ok(text().includes('Emitiendo'), 'marca el push que está emitiendo');
ok(text().includes('Otra IP/puerto'), 'marca el que apunta a otra IP/puerto');
ok(text().includes('rtmp://10.0.0.9/live/n2'), 'muestra también las salidas que no son UDP (sin tocarlas)');
ok(text().includes('CANAL 9') && text().includes('sin stream reconocido'), 'avisa de los canales sin stream en Flussonic');

// --- 3. Filtro: streams sin canal --------------------------------------
const select = [...document.querySelectorAll('select')].find((el) =>
  [...el.options].some((o) => o.value === 'todos')
);
ok(Boolean(select), 'hay selector de vista');
await act(async () => {
  select.value = 'todos';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
});
ok(text().includes('STREAM SUELTO'), 'con «Todos los streams» aparece el que no está en la lista');

// --- 4. Vista previa del rango -----------------------------------------
const previewBtn = byText('button', 'Ver plan del rango');
ok(Boolean(previewBtn), 'existe «Ver plan del rango»');
if (previewBtn) await click(previewBtn);
const previewCall = calls.find((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.from_channels);
ok(Boolean(previewCall), 'pide el plan a la API');
ok(previewCall?.body?.dry_run === true, 'la vista previa no escribe (dry_run)', JSON.stringify(previewCall?.body));
ok(previewCall?.body?.iface === 'ens37', 'manda la interfaz de salida', previewCall?.body?.iface);
ok(text().includes('Vista previa'), 'avisa de que es una vista previa');

// --- 5. Aplicar el rango ------------------------------------------------
const applyBtn = byText('button', 'Poner salida UDP del rango');
ok(Boolean(applyBtn), 'existe «Poner salida UDP del rango»');
if (applyBtn) await click(applyBtn);
const applyCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.from_channels).pop();
ok(applyCall?.body?.dry_run !== true, 'aplicar escribe de verdad');
ok(applyCall?.body?.take_over === true, 'pide apagar TVLister para no duplicar emisor');
ok(text().includes('con la salida UDP del canal'), 'confirma cuántos streams quedaron con salida');

// --- 6. Quitar el rango -------------------------------------------------
const removeBtn = byText('button', 'Quitar salidas del rango');
ok(Boolean(removeBtn), 'existe «Quitar salidas del rango»');
if (removeBtn) await click(removeBtn);
const removeCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.from_channels).pop();
ok(removeCall?.body?.action === 'remove', 'quitar manda action=remove', JSON.stringify(removeCall?.body));

// --- 7. Editar una fila -------------------------------------------------
const rowOf = (streamName) =>
  [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes(streamName) && tr.querySelector('input[type="text"]'));
const pushRow = rowOf('TELEMUNDO');
const pushInput = pushRow?.querySelector('input[type="text"]');
ok(Boolean(pushInput), 'la fila del stream tiene su URL editable', pushInput?.value);
if (pushInput) await type(pushInput, 'udp://ens37@239.25.0.3:5003');
const saveRow = [...(rowOf('TELEMUNDO')?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === 'Guardar');
ok(Boolean(saveRow), 'cada fila tiene su botón Guardar');
if (saveRow) await click(saveRow);
const rowCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.items).pop();
ok(rowCall?.body?.items?.[0]?.stream === 'TELEMUNDO', 'guarda la fila del stream correcto', JSON.stringify(rowCall?.body?.items));
ok(rowCall?.body?.items?.[0]?.url === 'udp://ens37@239.25.0.3:5003', 'guarda la URL que se escribió', rowCall?.body?.items?.[0]?.url);
ok(text().includes('salida UDP puesta'), 'el panel confirma la fila guardada');

// --- 8. Quitar una fila -------------------------------------------------
const quitRow = [...(rowOf('TELEMUNDO')?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === 'Quitar');
ok(Boolean(quitRow), 'cada fila tiene su botón Quitar');
if (quitRow) await click(quitRow);
const quitCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.items).pop();
ok(quitCall?.body?.items?.[0]?.remove === true, 'quitar la fila pide remove=true', JSON.stringify(quitCall?.body?.items));

// --- 9. Guardar la interfaz --------------------------------------------
const ifaceInput = [...document.querySelectorAll('input[type="text"]')].find((i) => i.value === 'ens37');
ok(Boolean(ifaceInput), 'la interfaz de salida se puede editar');
if (ifaceInput) {
  await type(ifaceInput, 'ens38');
  const saveIface = byText('button', 'Guardar interfaz');
  if (saveIface) await click(saveIface);
  const ifaceCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push/interface').pop();
  ok(ifaceCall?.body?.iface === 'ens38', 'guarda la interfaz nueva', JSON.stringify(ifaceCall?.body));
}

console.log(fails.length === 0 ? '\nTODO OK' : `\n${fails.length} fallo(s): ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
