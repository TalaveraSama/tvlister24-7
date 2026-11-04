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

const mkChannel = (ch, name, stream, title, extra = {}) => ({
  catv_ch: ch,
  name,
  service_name: name,
  dest: `udp://ens37@239.25.0.${ch}:500${ch}`,
  shared_name: name === 'NACIONAL',
  stream,
  stream_title: title,
  stream_exists: Boolean(stream),
  stream_alive: Boolean(stream),
  push: extra.push || null,
  has_output: Boolean(extra.push),
  has_source: extra.has_source ?? true,
  in_sync: Boolean(extra.in_sync),
  other_udp: [],
  other_outputs: [],
  engine: extra.engine || 'local',
  panel_emitting: extra.panel_emitting ?? (extra.engine ? extra.engine !== 'flussonic' : true),
  enabled: true,
  ok: Boolean(stream)
});

let channels = [
  mkChannel(2, 'NACIONAL', 'a0ek', 'A&E', {
    push: { url: 'udp://ens37@239.25.0.2:5002', state: 'running', running: true, mb: 134.2 },
    in_sync: true,
    engine: 'flussonic'
  }),
  mkChannel(3, 'TELEMUNDO', 'a0cq', 'A3 Cine', {
    push: { url: 'udp://ens37@239.9.9.9:9999', state: 'running', running: true, mb: 3 }
  }),
  mkChannel(4, 'NACIONAL', '', '', {}),
  mkChannel(5, 'UNIMAS', 'a0di', 'AMC', {})
];

const pushSnapshot = () => ({
  ok: true,
  server: { id: 1, name: 'Astra', base_url: 'http://127.0.0.1:8080' },
  flussonic_reachable: true,
  flussonic_error: '',
  iface: 'ens37',
  total: 4,
  with_push: 2,
  in_sync: 1,
  channels,
  channels_total: channels.length,
  channels_mapped: channels.filter((c) => c.stream).length,
  channels_con_salida: channels.filter((c) => c.has_output).length,
  streams: [
    {
      name: 'a0ek',
      title: 'A&E',
      alive: true,
      bitrate_kbps: 1900000,
      clients: 0,
      udp_outputs: ['udp://ens37@239.25.0.2:5002'],
      other_outputs: [],
      push: { url: 'udp://ens37@239.25.0.2:5002', state: 'running', running: true, bytes: 140718898, mb: 134.2 },
      channel: { catv_ch: 2, name: 'NACIONAL', service_name: 'NACIONAL', dest: 'udp://ens37@239.25.0.2:5002', method: 'a mano' },
      suggested_url: 'udp://ens37@239.25.0.2:5002',
      in_sync: true
    },
    {
      name: 'a0cq',
      title: 'A3 Cine',
      alive: true,
      bitrate_kbps: 1800000,
      clients: 0,
      udp_outputs: ['udp://ens37@239.9.9.9:9999'],
      other_outputs: [],
      push: { url: 'udp://ens37@239.9.9.9:9999', state: 'running', running: true, bytes: 3145728, mb: 3 },
      channel: { catv_ch: 3, name: 'TELEMUNDO', service_name: 'TELEMUNDO', dest: 'udp://ens37@239.25.0.3:5003', method: 'a mano' },
      suggested_url: 'udp://ens37@239.25.0.3:5003',
      in_sync: false
    },
    {
      name: 'a0di',
      title: 'AMC',
      alive: true,
      bitrate_kbps: 1700000,
      clients: 0,
      udp_outputs: [],
      other_outputs: ['rtmp://10.0.0.9/live/amc'],
      push: null,
      channel: { catv_ch: 5, name: 'UNIMAS', service_name: 'UNIMAS', dest: 'udp://ens37@239.25.0.5:5005', method: 'a mano' },
      suggested_url: 'udp://ens37@239.25.0.5:5005',
      in_sync: false
    },
    {
      name: 'SUELTO1',
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
  channels_sin_stream: [{ catv_ch: 4, name: 'NACIONAL', dest: 'udp://ens37@239.25.0.4:5004', shared_name: true }]
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
  else if (key === 'POST /api/wk2500/flussonic-control/switch')
    data = {
      ok: true,
      engine: body?.engine,
      requested: (body?.channels || []).length,
      switched: (body?.channels || []).length,
      failed: 0,
      detail: (body?.channels || []).map((ch) => ({ catv_ch: ch, ok: true })),
      message: `${(body?.channels || []).length} de ${(body?.channels || []).length} canal(es) vuelven al motor propio de TVLister.`,
      snapshot: pushSnapshot()
    };
  else if (key === 'POST /api/wk2500/flussonic-push/map') {
    const ch = channels.find((c) => c.catv_ch === body.catv_ch);
    if (ch) {
      ch.stream = body.stream || '';
      ch.stream_title = body.stream === 'a0cq' ? 'A3 Cine' : body.stream === 'a0ek' ? 'A&E' : '';
      ch.stream_exists = Boolean(ch.stream);
    }
    data = { ok: true, catv_ch: body.catv_ch, stream: body.stream, freed: body.stream === 'a0cq' ? [3] : [], snapshot: pushSnapshot() };
  } else if (key === 'POST /api/wk2500/flussonic-push/titles') {
    const rows = [
      { catv_ch: 2, service_name: 'NACIONAL', stream: 'a0ek', stream_title: 'A&E', current_service_name: 'A&E', ok: true },
      { catv_ch: 5, service_name: 'UNIMAS', stream: 'a0di', stream_title: 'AMC', current_service_name: 'AMC', ok: true }
    ];
    data = body.dry_run
      ? { ok: true, rows, total: rows.length, pendientes: rows.length, dryRun: true, detail: [] }
      : {
          ok: true,
          rows,
          total: rows.length,
          pendientes: rows.length,
          dryRun: false,
          detail: rows.map((r) => ({ ...r, field: 'mpegts.service_name' })),
          applied: rows.length,
          failed: 0,
          message: `${rows.length} de ${rows.length} stream(s) con el nombre del canal para el escaneo.`,
          snapshot: pushSnapshot()
        };
  }
  else if (key === 'POST /api/wk2500/flussonic-push') {
    if (body?.from_channels) {
      const dry = body.dry_run === true;
      data = {
        ok: true,
        dryRun: dry,
        panel_emitting: dry ? null : 0,
        panel_note: dry ? '' : 'TVLister no emite: el UDP lo pone Flussonic.',
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
        panel_emitting: 0,
        panel_note: 'TVLister no emite: el UDP lo pone Flussonic.',
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

// --- 0. Tres pestañas y sólo se ve la elegida ---------------------------
ok(text().includes('1 · Nativo TVLister'), 'la pestaña de lo nativo está a la vista');
ok(text().includes('3 · Flussonic UDP · push'), 'la pestaña de la salida UDP está a la vista');
ok(!text().includes('la salida de cada canal (push)'), 'al abrir no se mezcla con lo nativo');
const tabPush = byText('button', '3 · Flussonic UDP · push');
ok(Boolean(tabPush), 'existe la pestaña de la salida UDP');
if (tabPush) await click(tabPush);

// --- 1. La tarjeta está y resume el estado -------------------------------
ok(text().includes('Flussonic UDP · la salida de cada canal (push)'), 'la tarjeta de push está a la vista');
ok(text().includes('Flussonic responde · 4 streams'), 'dice si Flussonic responde y cuántos streams tiene');
ok(text().includes('Canales con stream: 3/4'), 'cuenta los canales con stream', text().match(/Canales con stream: \d+\/\d+/)?.[0]);
ok(text().includes('Con salida UDP puesta: 2'), 'cuenta los canales con salida puesta', text().match(/Con salida UDP puesta: \d+/)?.[0]);

// --- 2. Tabla por canal: CH, portadora, stream y estado ------------------
ok(text().includes('NACIONAL') && text().includes('TELEMUNDO'), 'lista las portadoras de la lista');
ok(text().includes('A&E') || text().includes('A3 Cine'), 'muestra el título real del stream (no sólo a0ek)');
ok(
  [...document.querySelectorAll('input[type="text"]')].some((i) => String(i.value).includes('239.25.0.2:5002')),
  'la salida UDP del canal es editable'
);
ok(text().includes('134.2 MB'), 'muestra lo enviado (como el «running · 134.2 MB» de Flussonic)');
ok(text().includes('Emitiendo'), 'marca el canal que está emitiendo');
ok(text().includes('Otra IP/puerto'), 'marca el que apunta a otra IP/puerto');
ok(
  text().includes('canal(es) de la lista sin stream de Flussonic'),
  'dice cuántos canales de la lista están sin stream'
);
ok(text().includes('TVLister apagado'), 'marca los canales que ya controla Flussonic (TVLister apagado)');
ok(text().includes('emitiendo desde TVLister') || text().includes('TVLister no emite'), 'dice si el panel emite ese canal');
ok(text().includes('El panel no emite este UDP'), 'explica que el panel sólo escribe el texto de la salida');
ok(text().includes('nombre se repite en varios canales'), 'avisa del nombre repetido (NACIONAL)');

// --- 3. Elegir el stream a mano (a0cq → CH4) ---------------------------
// Por defecto sólo se ven los canales con stream; para asignar uno nuevo se
// cambia el filtro a «Canales sin stream».
const filterSel = [...document.querySelectorAll('select')].find((el) =>
  [...el.options].some((o) => o.value === 'sin_stream')
);
ok(Boolean(filterSel), 'hay filtro de canales (con stream / sin stream)');
await act(async () => {
  filterSel.value = 'sin_stream';
  filterSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
});
const ch4Row = [...document.querySelectorAll('tr')].find((tr) => tr.querySelector('select') && !tr.querySelector('select').value);
const selCh4 = ch4Row?.querySelector('select');
ok(Boolean(selCh4), 'cada canal sin stream tiene su lista para elegir el stream');
if (selCh4) {
  await act(async () => {
    selCh4.value = 'a0cq';
    selCh4.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  });
  const mapCall = calls.find((c) => c.key === 'POST /api/wk2500/flussonic-push/map');
  ok(Boolean(mapCall), 'elegir el stream lo guarda en el panel');
  ok(mapCall?.body?.stream === 'a0cq', 'manda el stream elegido', JSON.stringify(mapCall?.body));
  ok(text().includes('se liberó de CH3') || text().includes('queda con el stream'), 'confirma el cambio y avisa si estaba en otro canal');
}

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
ok(applyCall?.body?.take_over !== false, 'no se puede dejar TVLister emitiendo (take_over por defecto)', JSON.stringify(applyCall?.body?.take_over));
ok(text().includes('TVLister no emite'), 'el panel confirma que no emite ese UDP');
ok(text().includes('con la salida UDP del canal'), 'confirma cuántos streams quedaron con salida');

// --- 6. Quitar el rango -------------------------------------------------
const removeBtn = byText('button', 'Quitar salidas del rango');
ok(Boolean(removeBtn), 'existe «Quitar salidas del rango»');
if (removeBtn) await click(removeBtn);
const removeCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.from_channels).pop();
ok(removeCall?.body?.action === 'remove', 'quitar manda action=remove', JSON.stringify(removeCall?.body));

// --- 7. Editar la URL de un canal y guardar ----------------------------
const rowOf = (needle) =>
  [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes(needle) && tr.querySelector('input[type="text"]'));
const ch3Row = [...document.querySelectorAll('tr')].find(
  (tr) => tr.querySelector('select')?.value === 'a0cq' && tr.querySelector('input[type="text"]')
);
const ch3Input = ch3Row?.querySelector('input[type="text"]');
ok(Boolean(ch3Input), 'la fila del canal tiene su URL editable', ch3Input?.value);
if (ch3Input) await type(ch3Input, 'udp://ens37@239.25.0.3:5003');
const saveRow = [...(ch3Row?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === 'Guardar');
ok(Boolean(saveRow), 'cada fila tiene su botón Guardar');
if (saveRow) await click(saveRow);
const rowCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.items).pop();
ok(rowCall?.body?.items?.[0]?.stream === 'a0cq', 'guarda la salida del stream correcto', JSON.stringify(rowCall?.body?.items));
ok(rowCall?.body?.items?.[0]?.url === 'udp://ens37@239.25.0.3:5003', 'guarda la URL que se escribió', rowCall?.body?.items?.[0]?.url);
ok(text().includes('salida UDP puesta'), 'el panel confirma la fila guardada');

// --- 8. Quitar la salida de un canal ----------------------------------
const quitRow = [...(ch3Row?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === 'Quitar');
ok(Boolean(quitRow), 'cada fila tiene su botón Quitar');
if (quitRow) await click(quitRow);
const quitCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push' && c.body?.items).pop();
ok(quitCall?.body?.items?.[0]?.remove === true, 'quitar la fila pide remove=true', JSON.stringify(quitCall?.body?.items));

// --- 8b. Nombre de servicio para el escaneo ---------------------------
const titlesPreview = byText('button', 'Ver qué nombres se escribirían');
ok(Boolean(titlesPreview), 'existe la vista previa de los nombres de servicio');
if (titlesPreview) await click(titlesPreview);
const titlesCall = calls.find((c) => c.key === 'POST /api/wk2500/flussonic-push/titles');
ok(titlesCall?.body?.dry_run === true, 'la vista previa de nombres no escribe', JSON.stringify(titlesCall?.body));
ok(text().includes('nombre(s) por escribir en Flussonic'), 'dice cuántos nombres faltan');
ok(text().includes('CH2') && text().includes('A&E'), 'enseña qué nombre y cuál tiene ahora');
const titlesApply = byText('button', 'Aplicar nombres');
ok(Boolean(titlesApply), 'ofrece aplicar los nombres');
if (titlesApply) await click(titlesApply);
const titlesApplyCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-push/titles').pop();
ok(titlesApplyCall?.body?.dry_run === false, 'aplicar los nombres escribe de verdad');
ok(text().includes('con el nombre del canal para el escaneo'), 'confirma cuántos se escribieron');

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

// --- 10. Canales que Flussonic dejó sin salida -------------------------
// El fallo de producción: el canal queda en Flussonic, la escritura falla y
// se queda sin emisor. La pantalla lo avisa y ofrece devolverlo a TVLister.
channels.push({
  ...mkChannel(6, 'CANAL 6', 'CANAL 6', 'Canal 6', {}),
  engine: 'flussonic',
  push: null,
  has_output: false,
  has_source: true,
  panel_emitting: false
});
const refreshBtn = byText('button', 'Actualizar');
if (refreshBtn) await click(refreshBtn);
ok(text().includes('sin salida UDP'), 'avisa de los canales que no emiten por nadie');
const returnBtn = byText('button', 'Devolver a TVLister');
ok(Boolean(returnBtn), 'ofrece devolverlos a TVLister');
if (returnBtn) await click(returnBtn);
const returnCall = calls.filter((c) => c.key === 'POST /api/wk2500/flussonic-control/switch').pop();
ok(
  returnCall?.body?.engine === 'local' && (returnCall.body.channels || []).includes(6),
  'devuelve sólo los canales sin salida',
  JSON.stringify(returnCall?.body)
);
ok(text().includes('vuelven al motor propio'), 'y confirma la vuelta');

console.log(fails.length === 0 ? '\nTODO OK' : `\n${fails.length} fallo(s): ${fails.join(' | ')}`);
process.exit(fails.length ? 1 : 0);
