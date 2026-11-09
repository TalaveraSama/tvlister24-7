#!/usr/bin/env node
// Pantalla «Canales 24/7» — señal en vivo de YouTube (v2.6.48).
//
// Renderiza la página real con jsdom y una API simulada, y comprueba lo que ve
// el operador y lo que se manda al panel:
//   · la tarjeta del canal dice «● YOUTUBE EN VIVO» / «SIN SEÑAL»
//   · «Crear Canal 24/7» ofrece las dos fuentes de señal
//   · elegir YouTube pide el enlace y avisa si yt-dlp no está
//   · «Comprobar señal» muestra el título del directo
//   · guardar manda source_kind='youtube' y el enlace
//   · «Renovar señal» llama al panel
//
// Uso:  node scripts/test_youtube_live_ui.mjs   (requiere jsdom + esbuild)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('omitido: jsdom no está instalado (npm i --no-save jsdom esbuild)');
  process.exit(0);
}

const fails = [];
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FALLO'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails.push(label);
};

const tmp = path.join(ROOT, 'node_modules', '.tvytui');
fs.mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, 'Channels247Page.mjs');
const { build } = await import('esbuild');
await build({
  entryPoints: [path.join(ROOT, 'src/pages/Channels247Page.jsx')],
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
const alerts = [];
dom.window.alert = (m) => alerts.push(String(m));
dom.window.confirm = () => true;
globalThis.alert = dom.window.alert;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── API simulada ────────────────────────────────────────────────────────────
const calls = [];
let ytInstalled = false;
let cookiesPath = '';

const channels = [
  {
    id: 7,
    name: 'Noticias 24/7',
    category_id: 4,
    status: 'running',
    engine_mode: 'ffmpeg',
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/@canaldemo/live',
    workerPid: 4321,
    copyExact: true,
    copyVideo: true,
    audioLeveled: false,
    liveSource: {
      mode: 'live',
      live: true,
      ready: true,
      copy_kind: 'separate',
      separated_audio: true,
      copy_video: true,
      copy_audio: true,
      title: 'Noticias 24 Horas (directo)',
      uploader: 'Canal Demo',
      expires_at: '2026-11-04T20:00:00.000Z',
      expires_in_min: 320,
      has_url: true,
      error: ''
    },
    liveState: { isLiveSource: true, live: { title: 'Noticias 24 Horas (directo)' }, schedule: [] }
  },
  {
    id: 8,
    name: 'Deportes 24/7',
    category_id: 4,
    status: 'stopped',
    engine_mode: 'ffmpeg',
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/watch?v=abc',
    workerPid: null,
    copyExact: false,
    copyVideo: false,
    audioLeveled: false,
    liveSource: { live: false, ready: false, mode: 'live', error: 'Ese enlace no está en directo ahora (no es un directo).', has_url: false },
    liveState: { isLiveSource: true, live: null, schedule: [] }
  },
  {
    id: 9,
    name: 'Cine Clásico',
    category_id: 4,
    status: 'running',
    engine_mode: 'virtual',
    source_kind: 'playlist',
    playlist: [],
    workerPid: null,
    liveState: { schedule: [] }
  },
  {
    id: 10,
    name: 'Documental 24/7',
    category_id: 4,
    status: 'running',
    engine_mode: 'ffmpeg',
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/watch?v=vid123',
    workerPid: 5555,
    copyExact: true,
    copyVideo: true,
    audioLeveled: false,
    liveSource: {
      mode: 'video',
      live: false,
      ready: true,
      title: 'Documental grabado',
      duration_sec: 3720,
      needs_transcode: false,
      expires_in_min: 300,
      has_url: true,
      error: ''
    },
    liveState: { isLiveSource: true, sourceMode: 'video', schedule: [] }
  },
  {
    id: 12,
    name: 'Directo con nivelador',
    category_id: 4,
    status: 'running',
    engine_mode: 'ffmpeg',
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/@canalnivel/live',
    workerPid: 7777,
    copyExact: false,
    copyVideo: true,
    audioLeveled: true,
    liveSource: {
      mode: 'live',
      live: true,
      ready: true,
      copy_video: true,
      copy_audio: false,
      title: 'Señal con nivelador',
      expires_in_min: 200,
      has_url: true,
      error: ''
    },
    liveState: { isLiveSource: true, sourceMode: 'live', schedule: [] }
  },
  {
    id: 11,
    name: 'Lista 24/7',
    category_id: 4,
    status: 'running',
    engine_mode: 'ffmpeg',
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/playlist?list=PLdemo',
    workerPid: 6666,
    copyExact: false,
    copyVideo: false,
    audioLeveled: false,
    liveSource: {
      mode: 'playlist',
      live: false,
      ready: true,
      needs_transcode: true,
      title: 'Lista Demo',
      entries: 30,
      total_entries: 32,
      total_duration_sec: 9000,
      entry_titles: ['Programa 1', 'Programa 2', 'Programa 3'],
      skipped_live: 1,
      skipped_no_format: 1,
      has_url: false,
      error: ''
    },
    liveState: { isLiveSource: true, sourceMode: 'playlist', schedule: [] }
  }
];

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  let body = null;
  try {
    body = opts.body ? JSON.parse(opts.body) : null;
  } catch {
    body = null;
  }
  calls.push({ url: u, method, body });

  if (u === '/api/channels247' && method === 'GET') return json(channels);
  if (u === '/api/vod') return json([]);
  if (u === '/api/categories') return json([{ id: 4, name: '24/7', type: 'channel247' }]);
  if (u === '/api/system') return json({ profiles: [{ id: 2, name: 'Copia directa (sin recodificar)' }] });
  if (u === '/api/youtube/status') {
    return json(
      ytInstalled
        ? {
            installed: true,
            version: '2026.11.04',
            bin: '/opt/tvlister24-7/.runtime/bin/yt-dlp',
            ffmpeg: true,
            cookies: { path: cookiesPath, exists: Boolean(cookiesPath) }
          }
        : { installed: false, bin: '', version: '', ffmpeg: true, hint: 'Se instala solo con un clic, sin apt.' }
    );
  }
  if (u === '/api/youtube/install') {
    ytInstalled = true;
    return json({ ok: true, version: '2026.11.04', path: '/opt/tvlister24-7/.runtime/bin/yt-dlp' });
  }
  if (u === '/api/youtube/probe') {
    if (!ytInstalled) {
      return json({
        ok: false,
        live: false,
        needs_ytdlp: true,
        error: 'Falta yt-dlp en el servidor: instálalo para leer el directo de YouTube.',
        yt_dlp: { installed: false }
      });
    }
    if (/watch\?v=abc/.test(body?.url || '')) {
      return json({ ok: false, live: false, error: 'Ese enlace no está en directo ahora (no es un directo).' });
    }
    if (/playlist\?list=/.test(body?.url || '')) {
      return json({
        ok: true,
        ready: true,
        live: false,
        mode: 'playlist',
        title: 'Lista Demo',
        entries: 3,
        total_entries: 4,
        total_duration_sec: 900,
        entry_titles: ['Programa 1', 'Programa 2', 'Programa 4'],
        skipped_live: 1,
        skipped_no_format: 0,
        needs_transcode: false,
        yt_dlp: { installed: true, version: '2026.11.04', bin: 'x', ffmpeg: true }
      });
    }
    if (/watch\?v=/.test(body?.url || '')) {
      return json({
        ok: true,
        ready: true,
        live: false,
        mode: 'video',
        title: 'Documental grabado',
        duration_sec: 125,
        needs_transcode: false,
        expires_in_min: 300,
        yt_dlp: { installed: true, version: '2026.11.04', bin: 'x', ffmpeg: true }
      });
    }
    return json({
      ok: true,
      ready: true,
      live: true,
      mode: 'live',
      title: 'Noticias 24 Horas (directo)',
      uploader: 'Canal Demo',
      expires_in_min: 320,
      yt_dlp: { installed: true, version: '2026.11.04', bin: '/opt/tvlister24-7/.runtime/bin/yt-dlp', ffmpeg: true }
    });
  }
  if (/^\/api\/channels247\/\d+\/live-source\/refresh$/.test(u)) {
    return json({ ok: true, state: { ok: true, url: 'x' }, liveSource: { live: true }, workerPid: 111 });
  }
  if (u === '/api/settings' && method === 'PUT') {
    cookiesPath = String(body?.youtube_cookies_file || '');
    return json({ ok: true });
  }
  if (u === '/api/channels247' && method === 'POST') return json({ ok: true, id: 12 });
  if (/^\/api\/channels247\/\d+$/.test(u) && method === 'PUT') return json({ ok: true });
  return json({ ok: true });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const Page = (await import(bundle)).default;

const root = createRoot(document.getElementById('root'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  await act(async () => {
    await sleep(0);
  });
};
const text = () => document.body.textContent.replace(/\s+/g, ' ');
const buttons = (label) => [...document.querySelectorAll('button')].filter((b) => b.textContent.replace(/\s+/g, ' ').trim().includes(label));

await act(async () => {
  root.render(React.createElement(Page, { onPreview: () => {} }));
});
await flush();
await flush();

// ── 1. Tarjetas de canal ────────────────────────────────────────────────────
ok(/● YOUTUBE EN VIVO/.test(text()), 'el canal con directo dice «● YOUTUBE EN VIVO»');
ok(/SIN SEÑAL/.test(text()), 'el canal sin directo dice «SIN SEÑAL»');
ok(/Noticias 24 Horas \(directo\)/.test(text()), 'muestra el título del directo como programación');
ok(/Ese enlace no está en directo ahora/.test(text()), 'y el motivo cuando no hay directo');
ok(/VÍDEO EN BUCLE/.test(text()), 'el canal de un vídeo suelto dice «VÍDEO EN BUCLE»');
ok(/Documental grabado/.test(text()), 'con el título del vídeo');
ok(/Bucle · 62m 0s/.test(text()), 'y su duración en bucle', (text().match(/Bucle · [^ ]+ [^ ]+/) || [''])[0]);
ok(/LISTA · 30/.test(text()), 'el canal de una lista dice «LISTA · 30»');
ok(/Lista Demo/.test(text()), 'con el título de la lista');
ok(/Programa 1/.test(text()), 'y los primeros vídeos de la lista');
ok(/y 27 más, en bucle/.test(text()), 'avisando de cuántos quedan');
ok(!/● YOUTUBE EN VIVO/.test(text().split('Lista Demo')[1]?.slice(0, 80) || ''), 'la lista NO se anuncia como directo');
ok(buttons('Renovar señal').length === 5, 'cada canal de YouTube tiene «Renovar señal»', `${buttons('Renovar señal').length} botones`);
ok(/⧉ COPIA EXACTA/.test(text()), 'los canales que copian sin recodificar lo dicen');
ok(/⧉ COPIA · AUDIO AAC/.test(text()), 'y se distingue cuando sólo se copia el vídeo');
ok(/↻ RECODIFICA/.test(text()), 'y cuando hay que recodificar');
ok(/uniendo sus dos pistas/.test(text()), 'el directo de pistas separadas explica que las une al copiar');

// ── 2. Renovar señal llama al panel ─────────────────────────────────────────
const beforeRefresh = calls.length;
await act(async () => {
  buttons('Renovar señal')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
ok(
  calls.slice(beforeRefresh).some((c) => /\/live-source\/refresh$/.test(c.url) && c.method === 'POST'),
  '«Renovar señal» pide al panel que renueve el enlace'
);

// ── 3. Alta de un canal nuevo ───────────────────────────────────────────────
await act(async () => {
  buttons('Crear Canal 24/7')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
ok(/¿De dónde sale la señal de este canal\?/.test(text()), 'el formulario pregunta de dónde sale la señal');
ok(buttons('Parrilla 24/7').length > 0 && buttons('Señal de YouTube (directo, vídeo o lista)').length > 0, 'ofrece las dos fuentes');

await act(async () => {
  buttons('Señal de YouTube (directo, vídeo o lista)')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
const urlInput = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('@canal/live'));
ok(Boolean(urlInput), 'aparece el campo del enlace de YouTube');
ok(/directo.*vídeo suelto.*lista completa|lista completa/s.test(text()), 'y explica que vale directo, vídeo o lista');
ok(/yt-dlp no está instalado/.test(text()), 'avisa si falta yt-dlp');
ok(buttons('Instalar yt-dlp').length > 0, 'y ofrece «Instalar yt-dlp»');

// ── 4. Comprobar señal sin yt-dlp → instalar → comprobar ────────────────────
const setValue = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush();
};
await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');

const clickText = async (label) => {
  const b = buttons(label)[0];
  ok(Boolean(b), `existe el botón «${label}»`);
  await act(async () => {
    b?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
  await flush();
};

await clickText('Comprobar señal');
ok(/Falta yt-dlp en el servidor/.test(text()), 'sin yt-dlp explica qué falta y no miente');

// El botón de dentro del aviso es el primero «Instalar yt-dlp».
await clickText('Instalar yt-dlp');
ok(/yt-dlp 2026\.11\.04 instalado/.test(text()), 'tras instalar, confirma la versión y la ruta');
ok(!/yt-dlp no está instalado/.test(text()), 'y el aviso de «no instalado» desaparece');

await clickText('Comprobar señal');
ok(/EN VIVO — Noticias 24 Horas \(directo\)/.test(text()), 'comprobar la señal muestra el título del directo');
ok(/Canal Demo/.test(text()), 'y el nombre del canal de YouTube');
ok(/se renovará en 320 min/.test(text()), 'y cuándo hay que renovar la URL');
ok(
  [...document.querySelectorAll('input')].some((i) => i.value === 'Noticias 24 Horas (directo)'),
  'rellena el nombre del canal con el título del directo'
);

// ── 4b. Cookies de YouTube (opcional) ───────────────────────────────────────
{
  const summary = [...document.querySelectorAll('summary')].find((s) => /no eres un robot/.test(s.textContent));
  ok(Boolean(summary), 'el panel explica el bloqueo de YouTube por IP');
  const box = summary?.parentElement;
  const input = box?.querySelector('input');
  ok(Boolean(input), 'y deja indicar el archivo de cookies');
  if (input) await setValue(input, '/opt/tvlister24-7/.runtime/youtube-cookies.txt');
  await clickText('Guardar ruta');
  const put = calls.filter((c) => c.url === '/api/settings' && c.method === 'PUT').pop();
  ok(Boolean(put), 'guardar la ruta llama al panel');
  ok(put?.body?.youtube_cookies_file === '/opt/tvlister24-7/.runtime/youtube-cookies.txt', 'con la ruta escrita', put?.body?.youtube_cookies_file);
  ok(/Archivo encontrado/.test(text()), 'y avisa cuando el archivo ya está en el servidor');
  ok(alerts.some((a) => /Ruta de cookies guardada/.test(a)), 'confirma al operador');
}

// ── 5. Guardar = POST con source_kind youtube ───────────────────────────────
const beforeSave = calls.length;
await act(async () => {
  buttons('Guardar Canal en Vivo 24/7')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
await flush();
const post = calls.slice(beforeSave).find((c) => c.url === '/api/channels247' && c.method === 'POST');
ok(Boolean(post), 'guardar crea el canal en el panel');
ok(post?.body?.source_kind === 'youtube', 'manda source_kind = youtube', String(post?.body?.source_kind));
ok(post?.body?.live_source_url === 'https://www.youtube.com/@canaldemo/live', 'y el enlace del directo', post?.body?.live_source_url);
ok(post?.body?.engine_mode === 'ffmpeg', 'y el motor FFmpeg (copia sin recodificar)', post?.body?.engine_mode);

// ── 6. Sin enlace no se guarda ──────────────────────────────────────────────
await act(async () => {
  buttons('Crear Canal 24/7')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
await act(async () => {
  buttons('Señal de YouTube (directo, vídeo o lista)')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
// Con nombre pero sin enlace: el formulario del navegador ya no estorba.
const nameInput = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'Ej. Cine Acción 24/7');
ok(Boolean(nameInput), 'el formulario pide el nombre del canal');
if (nameInput) await setValue(nameInput, 'Canal sin enlace');
const beforeEmpty = calls.length;
await act(async () => {
  buttons('Guardar Canal en Vivo 24/7')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await flush();
ok(
  !calls.slice(beforeEmpty).some((c) => c.url === '/api/channels247' && c.method === 'POST'),
  'con el enlace vacío no se manda nada al panel'
);
ok(/Pega el enlace de YouTube \(directo, vídeo o lista\) antes de guardar/.test(text()), 'y lo dice en el formulario');

// ── 7. Comprobar una LISTA completa y un VÍDEO suelto ───────────────────────
{
  const linkInput = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('@canal/live'));
  ok(Boolean(linkInput), 'el mismo formulario sirve para la lista');
  if (linkInput) await setValue(linkInput, 'https://www.youtube.com/playlist?list=PLdemo');
  await clickText('Comprobar señal');
  ok(/LISTA · 3 vídeos — Lista Demo/.test(text()), 'comprobar una lista dice cuántos vídeos trae y su título');
  ok(/se emiten en orden y vuelven a empezar/.test(text()), 'y explica que dan la vuelta');
  ok(/1\. Programa 1/.test(text()), 'con la lista de programas');
  ok(/1 directo\(s\) de la lista se omiten/.test(text()), 'y avisa de los directos que se omiten');

  if (linkInput) await setValue(linkInput, 'https://www.youtube.com/watch?v=vid123');
  await clickText('Comprobar señal');
  ok(/VÍDEO EN BUCLE — Documental grabado/.test(text()), 'comprobar un vídeo suelto dice «VÍDEO EN BUCLE»');
  ok(/se repite sin fin/.test(text()), 'y que se repite sin fin');
}

console.log(fails.length ? `\n${fails.length} fallo(s)` : '\nTODO OK');
process.exit(fails.length ? 1 : 0);
