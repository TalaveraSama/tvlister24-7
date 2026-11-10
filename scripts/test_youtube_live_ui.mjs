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
let installJob = null;
let installs = 0;
let downloadJob = null;
let downloads = 0;
let prepareJob = null;
let prepares = 0;
let cleanups = 0;
let simpsonsPrepared = false; // la lista «PLsimpsons» ya se preparó desde la tarjeta
let cookiesPath = '';
let cookiesExpired = false;
let cookieTests = 0;

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
      local: true,
      local_path: '/opt/tvlister24-7/.runtime/videos/vid123.mp4',
      bytes: 734003200,
      expires_in_min: null,
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
  },
  {
    // La tarjeta real del operador: «Los Simpson Capítulos Completos» con 30
    // vídeos, ninguno con MP4 progresivo y 23 todavía por descargar.
    id: 13,
    name: 'Los Simpson 24/7',
    category_id: 4,
    status: 'running',
    engine_mode: 'ffmpeg',
    source_kind: 'youtube',
    live_source_url: 'https://www.youtube.com/playlist?list=PLsimpsons',
    workerPid: null,
    copyExact: false,
    copyVideo: false,
    audioLeveled: false,
    liveSource: {
      mode: 'playlist',
      live: false,
      ready: false,
      local: false,
      title: 'Los Simpson Capítulos Completos [Español Latino]',
      entries: 0,
      total_entries: 30,
      total_duration_sec: 0,
      pending_count: 23,
      pending_bytes: 9 * 1024 ** 3,
      can_prepare_playlist: true,
      skip_summary: '23 no ofrece MP4 progresivo (sólo DASH/HLS) · 7 es un directo',
      has_url: false,
      error:
        'Los 30 vídeos de la lista no ofrecen un MP4 progresivo (sólo DASH/HLS). Se pueden descargar una vez ' +
        '(los primeros 23) y emitir desde el disco: botón «Preparar lista en el disco».'
    },
    liveState: { isLiveSource: true, sourceMode: 'playlist', schedule: [] }
  }
];

const videosMock = (over = {}) => ({
  count: 3,
  bytes: 3 * 1024 ** 3,
  used_bytes: 2 * 1024 ** 3,
  unused_bytes: 1024 ** 3,
  free_bytes: 48 * 1024 ** 3,
  total_bytes: 100 * 1024 ** 3,
  disk_known: true,
  budget_bytes: 0,
  keep_free_bytes: 5 * 1024 ** 3,
  height: 1080,
  ...over
});

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
  // El contenido en crudo (para las cookies, que van como texto plano).
  const raw = typeof opts.body === 'string' ? opts.body : '';
  try {
    body = opts.body ? JSON.parse(opts.body) : null;
  } catch {
    body = null;
  }
  calls.push({ url: u, method, body, raw });

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
            update_available: true,
            latest_version: '2099.01.01',
            release: { tag: '2099.01.01', error: '' },
            videos: videosMock(),
            cookies: {
              path: cookiesPath,
              exists: Boolean(cookiesPath),
              ok: Boolean(cookiesPath),
              usable: Boolean(cookiesPath),
              auth: Boolean(cookiesPath) && !cookiesExpired,
              expired_auth: Boolean(cookiesPath) && cookiesExpired,
              auth_expires_iso: Boolean(cookiesPath) && !cookiesExpired ? '2099-01-01' : '',
              auth_days_left: Boolean(cookiesPath) && !cookiesExpired ? 120 : null,
              count: cookiesPath ? 3 : 0,
              youtube: cookiesPath ? 3 : 0,
              error: ''
            }
          }
        : {
            installed: false,
            bin: '',
            version: '',
            ffmpeg: true,
            hint: 'Se instala solo con un clic, sin apt.',
            videos: videosMock()
          }
    );
  }
  if (u === '/api/youtube/cookies/test') {
    cookieTests += 1;
    return json(
      cookiesExpired || !cookiesPath
        ? { ok: false, error: 'Las cookies están caducadas: vuelve a exportarlas de youtube.com con la sesión iniciada.' }
        : { ok: true, message: 'Las cookies funcionan: yt-dlp ha leído «youtube-dl test video» con esa sesión.' }
    );
  }
  if (u === '/api/youtube/formats') {
    return json({
      ok: true,
      client: 'tv',
      using_cookies: Boolean(cookiesPath),
      text: [
        '[youtube] ioSKlIL4Hs8: Downloading webpage',
        'ID  EXT   RESOLUTION FPS CH │   FILESIZE   TBR PROTO │ VCODEC          ACODEC',
        '137 mp4   1920x1080   30    │    512.00MiB 4000 https │ avc1.640028     none',
        '140 m4a   audio only        │      3.50MiB  128 https │ audio only      mp4a.40.2'
      ].join('\n')
    });
  }
  if (u === '/api/youtube/cookies' && method === 'POST') {
    // Igual que el panel: se valida y, si sirve, se guarda.
    if (!/youtube\.com/.test(raw)) {
      return json({ ok: false, error: 'El archivo no trae cookies de youtube.com' }, 400);
    }
    cookiesPath = '/opt/tvlister24-7/.runtime/youtube-cookies.txt';
    return json({
      ok: true,
      path: cookiesPath,
      message: 'Cookies guardadas: 3 de youtube.com con la sesión iniciada.',
      cookies: { path: cookiesPath, exists: true, ok: true, usable: true, auth: true, count: 3, youtube: 3 }
    });
  }
  if (u === '/api/youtube/cookies' && method === 'DELETE') {
    cookiesPath = '';
    return json({ ok: true, cookies: { path: '', exists: false, usable: false } });
  }
  if (u === '/api/youtube/videos' && method === 'GET') {
    return json({
      ok: true,
      dir: '/opt/tvlister24-7/.runtime/videos',
      count: 3,
      bytes: 3 * 1024 ** 3,
      free_bytes: 48 * 1024 ** 3,
      disk_known: true,
      files: []
    });
  }
  if (u === '/api/youtube/videos/cleanup' && method === 'POST') {
    cleanups += 1;
    return json({
      ok: true,
      removed: [{ video_id: 'VID1', title: 'Programa 1', bytes: 2 * 1024 ** 3 }],
      freed_bytes: 2 * 1024 ** 3,
      stats: { count: 1, bytes: 1024 ** 3, free_bytes: 50 * 1024 ** 3, disk_known: true }
    });
  }
  if (u === '/api/youtube/prepare-playlist' && method === 'POST') {
    prepares += 1;
    // Desde el modal (sin channel_id) la lista queda preparada para esa prueba.
    if (!body?.channel_id) simpsonsPrepared = true;
    prepareJob = { running: true, step: '1/10 · Programa 1', done: 1, total: 10, result: null };
    return json({ ok: true, ...prepareJob }, 202);
  }
  if (u === '/api/youtube/prepare-playlist/status') {
    if (prepareJob?.running) {
      prepareJob = { running: false, step: '', done: 10, total: 10, result: { ok: true, downloaded: 10, already: 0, total: 10, failed: 0 } };
    }
    return json(prepareJob || { running: false, result: null });
  }
  if (u === '/api/youtube/download' && method === 'POST') {
    if (!/watch\?v=/.test(raw)) return json({ ok: false, error: 'Sólo se puede descargar el enlace de un vídeo suelto.' }, 400);
    downloads += 1;
    downloadJob = { running: true, step: 'descargando 42.0 % (512.00MiB)', result: null, video_id: 'ioSKlIL4Hs8' };
    return json({ ok: true, ...downloadJob }, 202);
  }
  if (u === '/api/youtube/download-status') {
    if (downloadJob?.running) {
      downloadJob = {
        running: false,
        step: '',
        video_id: 'ioSKlIL4Hs8',
        result: {
          ok: true,
          path: '/opt/tvlister24-7/.runtime/videos/ioSKlIL4Hs8.mp4',
          bytes: 734003200,
          duration_sec: 3720,
          title: 'Documental grabado'
        }
      };
    }
    return json(downloadJob || { running: false, result: null });
  }
  if (u === '/api/youtube/install') {
    // Ahora arranca en segundo plano: se responde 202 y la pantalla pregunta.
    installs += 1;
    installJob = { running: true, step: 'descargando binario autónomo (no necesita Python)', result: null };
    return json({ ok: true, ...installJob }, 202);
  }
  if (u === '/api/youtube/install-status') {
    if (installJob?.running) {
      installJob = {
        running: false,
        step: '',
        result: { ok: true, version: '2026.11.04', path: '/opt/tvlister24-7/.runtime/bin/yt-dlp', variant: 'standalone' }
      };
      ytInstalled = true;
    }
    return json(installJob || { running: false, result: null });
  }
  if (u === '/api/youtube/probe') {
    if (!ytInstalled) {
      return json({
        ok: false,
        live: false,
        needs_ytdlp: true,
        error: 'Falta yt-dlp en el servidor: instálalo para leer el directo de YouTube.',
        yt_dlp: { installed: false, videos: videosMock() }
      });
    }
    if (/watch\?v=dashonly/.test(body?.url || '')) {
      if (!downloads) {
        return json({
          ok: false,
          live: false,
          needs_download: true,
          can_download: true,
          video_id: 'ioSKlIL4Hs8',
          duration_sec: 3720,
          error:
            'Este vídeo no ofrece un MP4 progresivo (sólo DASH/HLS en pistas separadas). El panel puede ' +
            'descargarlo una vez (H.264 + AAC, hasta 1080p) y repetirlo desde el disco: botón «Descargar vídeo».'
        });
      }
      return json({
        ok: true,
        ready: true,
        live: false,
        mode: 'video',
        local: true,
        title: 'Documental grabado',
        duration_sec: 3720,
        bytes: 734003200,
        expires_in_min: null,
        error: ''
      });
    }
    if (/watch\?v=blocked/.test(body?.url || '')) {
      return json({
        ok: false,
        live: false,
        reasons: ['tiene restricción de edad (YouTube exige una cuenta con la edad confirmada)'],
        needs_cookies: false,
        error:
          'YouTube no entrega este vídeo porque tiene restricción de edad (YouTube exige una cuenta con la edad confirmada). ' +
          'Tienes cookies subidas, pero esa cuenta no tiene acceso a este vídeo (o la sesión ya no vale).',
        detail: 'ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm your age.'
      });
    }
    if (/watch\?v=nofmt/.test(body?.url || '')) {
      if (installs < 2) {
        return json({
          ok: false,
          live: false,
          needs_format_fix: true,
          clients_tried: 'normal, tv, web_safari, ios',
          error:
            'YouTube no ha dado ninguna pista de vídeo utilizable para este enlace («Requested format is not available»). ' +
            'Suele arreglarse actualizando yt-dlp: pulsa «Actualizar yt-dlp» y vuelve a comprobar.',
          detail: 'ERROR: [youtube] ioSKlIL4Hs8: Requested format is not available. Use --list-formats.'
        });
      }
      return json({
        ok: true,
        ready: true,
        live: true,
        mode: 'live',
        title: 'Noticias 24 Horas (directo)',
        uploader: 'Canal Demo',
        copy_kind: 'separate',
        separated_audio: true,
        expires_in_min: 320,
        error: ''
      });
    }
    if (/watch\?v=bot/.test(body?.url || '')) {
      return json({
        ok: false,
        live: false,
        needs_cookies: true,
        error:
          'YouTube pide iniciar sesión desde este servidor («Sign in to confirm you’re not a bot»). ' +
          'Sube un archivo de cookies de youtube.com y el panel lo usará solo.',
        detail: "ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm you're not a bot. Use --cookies."
      });
    }
    if (/watch\?v=ipbot/.test(body?.url || '')) {
      // Cookies con sesión válida y, aun así, verificación anti-robots: es la
      // IP del servidor. No se le puede pedir al operador que reexporte nada.
      return json({
        ok: false,
        live: false,
        blocked_bot: true,
        needs_cookies: false,
        needs_format_fix: true,
        clients_tried: 'normal, tv, web_safari, ios, mweb, tv_samsung',
        error:
          'YouTube no entrega este vídeo a la IP pública de este servidor: pide «Sign in to confirm you’re not a bot» ' +
          '(su control anti-robots). Las cookies son válidas hasta el 01/01/2030 y se han enviado a yt-dlp, así que el ' +
          'aviso no es por falta de sesión: YouTube lo aplica por IP (lo normal en servidores y centros de datos). ' +
          'Se ha probado con los clientes: normal, tv, web_safari, ios, mweb, tv_samsung. Qué hacer, en este orden: pulsa ' +
          '«Actualizar yt-dlp»; inicia sesión en YouTube desde la misma red del servidor y vuelve a exportar las cookies; ' +
          'y si el servidor sale por una IP de centro de datos, YouTube puede seguir pidiéndolo.',
        detail: "ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm you're not a bot. Use --cookies."
      });
    }
    if (/watch\?v=abc/.test(body?.url || '')) {
      return json({ ok: false, live: false, error: 'Ese enlace no está en directo ahora (no es un directo).' });
    }
    if (/list=PLsimpsons/.test(body?.url || '')) {
      if (!simpsonsPrepared) {
        return json({
          ok: false,
          live: false,
          mode: 'playlist',
          title: 'Los Simpson Capítulos Completos [Español Latino]',
          can_prepare_playlist: true,
          pending_count: 10,
          pending_bytes: Math.round(10 * 1320 * 0.3 * 1024 * 1024),
          disk: {
            free_bytes: 48 * 1024 ** 3,
            total_bytes: 100 * 1024 ** 3,
            known: true,
            keep_free_bytes: 5 * 1024 ** 3,
            budget_bytes: 0,
            cache_bytes: 0,
            height: 1080
          },
          skip_summary: '10 no ofrece MP4 progresivo (sólo DASH/HLS)',
          error:
            'Los 10 vídeos de la lista no ofrecen un MP4 progresivo (sólo DASH/HLS). Se pueden descargar una vez ' +
            'y emitir desde el disco: botón «Preparar lista en el disco».'
        });
      }
      return json({
        ok: true,
        ready: true,
        live: false,
        mode: 'playlist',
        local: true,
        title: 'Los Simpson Capítulos Completos [Español Latino]',
        entries: 10,
        total_entries: 10,
        entry_titles: ['Programa 1', 'Programa 2'],
        total_duration_sec: 13200,
        error: ''
      });
    }
    if (/playlist\?list=/.test(body?.url || '') || /[?&]list=/.test(body?.url || '')) {
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
        yt_dlp: { installed: true, version: '2026.11.04', bin: 'x', ffmpeg: true, videos: videosMock() }
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
        yt_dlp: { installed: true, version: '2026.11.04', bin: 'x', ffmpeg: true, videos: videosMock() }
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
      yt_dlp: {
        installed: true,
        version: '2026.11.04',
        bin: '/opt/tvlister24-7/.runtime/bin/yt-dlp',
        ffmpeg: true,
        videos: videosMock()
      }
    });
  }
  if (/^\/api\/channels247\/13\/live-source\/refresh$/.test(u) && method === 'POST') {
    // Con `disk_only` el panel recompone la lista con los archivos que ya hay.
    if (body?.disk_only) {
      const ch13 = channels.find((c) => c.id === 13);
      if (ch13) {
        ch13.liveSource = {
          ...ch13.liveSource,
          ready: true,
          local: true,
          entries: 10,
          pending_count: 0,
          can_prepare_playlist: false,
          total_duration_sec: 13200,
          error: ''
        };
      }
    }
    return json({ ok: true, liveSource: channels.find((c) => c.id === 13)?.liveSource || {} });
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
ok(buttons('Renovar señal').length === 6, 'cada canal de YouTube tiene «Renovar señal»', `${buttons('Renovar señal').length} botones`);
ok(/⧉ COPIA EXACTA/.test(text()), 'los canales que copian sin recodificar lo dicen');
ok(/⧉ COPIA · AUDIO AAC/.test(text()), 'y se distingue cuando sólo se copia el vídeo');
ok(/↻ RECODIFICA/.test(text()), 'y cuando hay que recodificar');
ok(/uniendo sus dos pistas/.test(text()), 'el directo de pistas separadas explica que las une al copiar');
ok(/⛁ DESDE EL DISCO/.test(text()), 'el vídeo descargado se marca como emitido desde el disco');
ok(/repetido en bucle \(descargado\)/.test(text()), 'y la línea del canal lo dice');

// ── 1b. La tarjeta de una lista DASH prepara el disco sin abrir Editar ─────
// El operador veía «LISTA · 0» y «23 SIN DESCARGAR», y el único botón para
// descargar estaba dentro de Editar. Aquí se prueba la salida directa.
{
  ok(/23 SIN DESCARGAR/.test(text()), 'la tarjeta avisa de los vídeos que faltan por descargar');
  ok(/Los Simpson Capítulos Completos/.test(text()), 'con el título de la lista');
  ok(buttons('Preparar la lista en el disco').length > 0, 'y ofrece prepararla desde la propia tarjeta');
  ok(
    /Empieza a emitir en cuanto baja el primero/.test(text()),
    'explicando que el canal emite mientras descarga'
  );

  // El estado de yt-dlp (y con él el disco) llega en su propia petición.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  await flush();
  ok(/Quedan 23 ≈ 9,0 GB/.test(text()), 'la tarjeta dice cuánto ocuparían los que faltan', (text().match(/Quedan 23[^.\n]{0,80}/) || [''])[0]);
  ok(/disco libre 48,0 GB/.test(text()), 'y cuánto queda libre en el servidor', (text().match(/Quedan 23[^.]{0,120}/) || [''])[0]);
  ok(buttons('Liberar espacio').length > 0, 'y ofrece liberar espacio');
  ok(/Vídeos en el disco: 3,0 GB/.test(text()), 'diciendo lo que ya ocupan los vídeos descargados', (text().match(/Vídeos en el disco[^.]{0,40}/) || [''])[0]);

  // Calidad: bajar a 720p ocupa la mitad.
  const quality = [...document.querySelectorAll('select')].find((sel) =>
    [...sel.options].some((o) => /720p/.test(o.textContent))
  );
  ok(Boolean(quality), 'se puede elegir la calidad de descarga (720p ocupa la mitad)');
  if (quality) {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    await act(async () => {
      setter.call(quality, '720');
      quality.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
    const putCalidad = calls.filter((c) => c.url === '/api/settings' && c.method === 'PUT').pop();
    ok(putCalidad?.body?.youtube_video_height === '720', 'y se guarda en el panel', JSON.stringify(putCalidad?.body));
    // Se deja como estaba para el resto de la prueba.
    await act(async () => {
      setter.call(quality, '1080');
      quality.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
  }

  // Liberar espacio: borra lo que ya no emite ningún canal.
  await act(async () => {
    buttons('Liberar espacio')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
  await flush();
  ok(cleanups === 1, '«Liberar espacio» pide limpiar al panel', `${cleanups}`);
  ok(/Liberados 2,0 GB \(1 vídeo\)/.test(text()), 'y dice cuánto se ha recuperado', text().slice(-140));
  ok(/Disco libre: 50,0 GB/.test(text()), 'con el disco libre que queda');

  const antesTarjeta = calls.length;
  await act(async () => {
    buttons('Preparar la lista en el disco')[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await flush();
  const postTarjeta = calls
    .slice(antesTarjeta)
    .find((c) => c.url === '/api/youtube/prepare-playlist' && c.method === 'POST');
  ok(Boolean(postTarjeta), 'el botón lanza la descarga');
  ok(postTarjeta?.body?.channel_id === 13, 'diciendo de qué canal es', String(postTarjeta?.body?.channel_id));
  ok(
    postTarjeta?.body?.url === 'https://www.youtube.com/playlist?list=PLsimpsons',
    'con el enlace de la lista',
    postTarjeta?.body?.url
  );
  ok(postTarjeta?.body?.limit === 10, 'y cuántos vídeos descargar', String(postTarjeta?.body?.limit));
  ok(/Preparando la lista en el disco/.test(text()), 'mientras descarga lo cuenta en la tarjeta', text().slice(-160));

  // ¿Y el disco? Se avisa de lo que va a ocupar y de lo que queda libre.

  await act(async () => {
    await new Promise((r) => setTimeout(r, 2600));
  });
  await flush();
  await flush();
  ok(/⛁ 10 de 10 en el disco/.test(text()), 'al terminar dice cuántos hay en el disco', text().slice(-200));
  ok(
    calls.some(
      (c) => c.url === '/api/channels247/13/live-source/refresh' && c.method === 'POST' && c.body?.disk_only === true
    ),
    'y recompone la lista con los archivos, sin volver a preguntar a YouTube'
  );
  ok(/⛁ DESDE EL DISCO/.test(text()), 'la tarjeta pasa a decir que se emite desde el disco');
  {
    const t = text();
    const i = t.indexOf('23 SIN DESCARGAR');
    ok(!/23 SIN DESCARGAR/.test(t), 'y ya no quedan vídeos por descargar', i >= 0 ? t.slice(Math.max(0, i - 120), i + 40) : '');
  }
}

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
// La instalación va en segundo plano: la pantalla pregunta cada 2 s.
ok(/descargando|Instalando yt-dlp|empezando/.test(text()), 'mientras instala, dice en qué paso va');
await act(async () => {
  await new Promise((r) => setTimeout(r, 2600));
});
await flush();
ok(/yt-dlp 2026\.11\.04 instalado/.test(text()), 'tras instalar, confirma la versión y la ruta');
ok(/binario autónomo, sin depender de Python/.test(text()), 'y avisa de que no depende del Python del servidor');
ok(/Hay una versión nueva de yt-dlp \(2099\.01\.01\)/.test(text()), 'y avisa cuando YouTube ha roto la versión instalada');
ok(!/yt-dlp no está instalado/.test(text()), 'y el aviso de «no instalado» desaparece');

await clickText('Comprobar señal');
ok(/EN VIVO — Noticias 24 Horas \(directo\)/.test(text()), 'comprobar la señal muestra el título del directo');
ok(/Canal Demo/.test(text()), 'y el nombre del canal de YouTube');
ok(/se renovará en 320 min/.test(text()), 'y cuándo hay que renovar la URL');
ok(
  [...document.querySelectorAll('input')].some((i) => i.value === 'Noticias 24 Horas (directo)'),
  'rellena el nombre del canal con el título del directo'
);

// ── 4b. El bloqueo anti-robots de YouTube y las cookies ─────────────────────
{
  // YouTube contesta «Sign in to confirm you're not a bot» desde una IP de
  // datacenter: la pantalla no debe escupir el inglés, sino decir qué hacer.
  await setValue(urlInput, 'https://www.youtube.com/watch?v=bot123');
  await clickText('Comprobar señal');
  ok(/Sign in to confirm/.test(text()), 'el bloqueo de YouTube se explica en la caja de la señal');
  ok(/archivo de cookies de youtube\.com/.test(text()), 'y dice qué hacer: subir cookies');
  ok(buttons('Subir cookies').length > 0, 'con un botón para subirlas desde la pantalla');
  ok(/detalle técnico/.test(text()), 'dejando el texto de yt-dlp aparte, plegado');

  // El bloque de cookies, ya abierto por el propio aviso.
  const summary = [...document.querySelectorAll('summary')].find((s) => /Usa cookies/.test(s.textContent));
  ok(Boolean(summary), 'el panel explica el bloqueo de YouTube por IP');
  const box = summary?.parentElement;
  const fileInput = box?.querySelector('input[type="file"]');
  ok(Boolean(fileInput), 'y acepta el archivo .txt exportado del navegador');
  ok(/Get cookies\.txt LOCALLY/.test(text()), 'explicando de dónde sale ese archivo');

  // Subir un cookies.txt como el que exporta la extensión (Netscape, con tabuladores).
  const cookieTxt =
    '# Netscape HTTP Cookie File\n' +
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSID\tabc\n' +
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\ttz=UTC\n';
  const beforeUp = calls.length;
  if (fileInput) {
    Object.defineProperty(fileInput, 'files', {
      value: [{ name: 'youtube-cookies.txt', text: async () => cookieTxt }],
      configurable: true
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
    await flush();
  }
  const up = calls.slice(beforeUp).find((c) => c.url === '/api/youtube/cookies' && c.method === 'POST');
  ok(Boolean(up), 'subir el archivo lo manda al panel');
  ok(/Netscape HTTP Cookie File/.test(String(up?.raw || '')), 'con el contenido tal cual (formato Netscape)');
  ok(/Cookies guardadas: 3 de youtube\.com con la sesión iniciada/.test(text()), 'y confirma cuántas cookies ha leído');

  // El fallo era el anti-robots: al tener cookies, se reintenta solo.
  const probesBefore = calls.filter((c) => c.url === '/api/youtube/probe').length;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  await flush();
  await flush();
  ok(
    calls.filter((c) => c.url === '/api/youtube/probe').length > probesBefore,
    'y vuelve a comprobar el enlace sin tocar nada'
  );

  // Ruta manual, para quien ya tiene el archivo en el servidor.
  const manual = [...document.querySelectorAll('summary')].find((s) =>
    /Ya tengo el archivo en el servidor/.test(s.textContent)
  );
  ok(Boolean(manual), 'y deja indicar una ruta que ya exista en el servidor');
  const pathInput = manual?.parentElement?.querySelector('input[type="text"]');
  if (pathInput) await setValue(pathInput, '/opt/tvlister24-7/.runtime/youtube-cookies.txt');
  await clickText('Guardar ruta');
  const put = calls.filter((c) => c.url === '/api/settings' && c.method === 'PUT').pop();
  ok(Boolean(put), 'guardar la ruta llama al panel');
  ok(
    put?.body?.youtube_cookies_file === '/opt/tvlister24-7/.runtime/youtube-cookies.txt',
    'con la ruta escrita',
    put?.body?.youtube_cookies_file
  );
  ok(/3 cookies \(3 de youtube\.com\) · con sesión/.test(text()), 'y enseña qué hay dentro del archivo');
  ok(alerts.some((a) => /Ruta de cookies guardada/.test(a)), 'confirma al operador');

  // Y se pueden quitar.
  await clickText('Quitar');
  ok(
    calls.some((c) => c.url === '/api/youtube/cookies' && c.method === 'DELETE'),
    'las cookies se pueden quitar desde la pantalla'
  );

  // Se vuelve al directo normal para seguir con el resto de la prueba.
  await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');
}

// ── 4c. «Requested format is not available» → actualizar yt-dlp ─────────────
{
  await setValue(urlInput, 'https://www.youtube.com/watch?v=nofmt123');
  await clickText('Comprobar señal');
  ok(/Requested format is not available/.test(text()), 'el fallo de formatos se explica en la caja de la señal');
  ok(buttons('Actualizar yt-dlp').length > 0, 'y ofrece «Actualizar yt-dlp» en ese mismo aviso');
  ok(/probado con: normal, tv, web_safari, ios/.test(text()), 'diciendo con qué clientes de YouTube se probó');
  ok(/Suele arreglarse actualizando yt-dlp/.test(text()), 'y qué hacer para arreglarlo');

  const beforeFix = calls.filter((c) => c.url === '/api/youtube/probe').length;
  await clickText('Actualizar yt-dlp');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 2600));
  });
  await flush();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  await flush();
  await flush();
  ok(
    calls.filter((c) => c.url === '/api/youtube/install').length >= 2,
    'el botón actualiza yt-dlp (segunda instalación)',
    `${calls.filter((c) => c.url === '/api/youtube/install').length}`
  );
  ok(
    calls.filter((c) => c.url === '/api/youtube/probe').length > beforeFix,
    'y al terminar vuelve a comprobar el enlace solo'
  );
  ok(/EN VIVO — Noticias 24 Horas \(directo\)/.test(text()), 'con el directo ya resuelto', text().slice(-160));
  ok(!/Requested format is not available/.test(text()), 'sin quedarse el error viejo en pantalla');

  // Se vuelve al directo normal para seguir con el resto de la prueba.
  await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');
}

// ── 4d. Enlace del navegador (watch?v=…&list=…) y vídeo sin MP4 ─────────────
{
  await setValue(urlInput, 'https://www.youtube.com/watch?v=ioSKlIL4Hs8&list=PLpbdLXz_BiMWFZH3nKMEaD3b9iAg7mLi7');
  ok(/Ese enlace trae[\s\S]*vídeo \+ lista/.test(text()), 'avisa de que el enlace del navegador trae vídeo y lista');
  ok(/lista completa[\s\S]{0,60}30 vídeos/.test(text()), 'y de que se emitirá la lista completa');
  ok(buttons('Sólo ese vídeo').length > 0, 'con un botón para quedarse sólo con el vídeo');

  await clickText('Comprobar señal');
  ok(/LISTA · 3/.test(text()) || /Señal de YouTube/.test(text()), 'comprobar el enlace del navegador lo trata como lista');

  // Volver al enlace del navegador y quitarle la lista.
  await setValue(urlInput, 'https://www.youtube.com/watch?v=ioSKlIL4Hs8&list=PLpbdLXz_BiMWFZH3nKMEaD3b9iAg7mLi7');
  await clickText('Sólo ese vídeo');
  const stripped = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('@canal/live'));
  ok(stripped?.value === 'https://www.youtube.com/watch?v=ioSKlIL4Hs8', 'el botón deja sólo el vídeo', stripped?.value);
  ok(!/Ese enlace trae/.test(text()), 'y el aviso desaparece');

  // Vídeo que sólo da DASH/HLS: se descarga una vez y se repite del disco.
  await setValue(urlInput, 'https://www.youtube.com/watch?v=dashonly123');
  await clickText('Comprobar señal');
  ok(/no ofrece un MP4 progresivo/.test(text()), 'el vídeo DASH-only se explica en la caja de la señal');
  ok(buttons('Descargar vídeo (una vez)').length > 0, 'y ofrece descargarlo una vez');
  ok(/se repite desde el disco/.test(text()), 'explicando que después no caduca');

  await clickText('Descargar vídeo (una vez)');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 2600));
  });
  await flush();
  await flush();
  ok(downloads === 1, 'la descarga se lanza contra el panel', `${downloads}`);
  ok(/Vídeo descargado \(700 MB · 62m 0s\)/.test(text()), 'al terminar dice cuánto ocupa y cuánto dura');
  ok(/Se repite desde el disco: no caduca/.test(text()), 'y que ya no depende de YouTube');
  ok(/VÍDEO EN BUCLE — Documental grabado/.test(text()), 'el enlace queda resuelto en bucle', text().slice(-120));

  // Se vuelve al directo normal para seguir con el resto de la prueba.
  await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');
}

// ── 4e. Motivo real, «Probar cookies» y «Ver qué formatos ve yt-dlp» ────────
{
  // Se vuelven a subir cookies (la sección 4b las quitó al final).
  const cookieTxt =
    '# Netscape HTTP Cookie File\n' +
    '#HttpOnly_.youtube.com\tTRUE\t/TRUE\t1893456000\t__Secure-3PSID\tabc\n' +
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\ttz=UTC\n';
  const fileInput = [...document.querySelectorAll('input[type="file"]')][0];
  ok(Boolean(fileInput), 'el panel tiene el selector del archivo de cookies');
  if (fileInput) {
    Object.defineProperty(fileInput, 'files', {
      value: [{ name: 'youtube-cookies.txt', text: async () => cookieTxt }],
      configurable: true
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
    await flush();
  }
  ok(/Cookies guardadas/.test(text()), 'las cookies se suben y se confirman');

  await setValue(urlInput, 'https://www.youtube.com/watch?v=blocked123');
  await clickText('Comprobar señal');
  ok(/restricción de edad/.test(text()), 'el motivo real de YouTube se explica en la caja');
  ok(/Motivo: tiene restricción de edad/.test(text()), 'y se muestra aparte, en claro');
  ok(/Tienes cookies subidas, pero esa cuenta no tiene acceso/.test(text()), 'con cookies puestas, dice que esa cuenta no vale');
  ok(!/Sube cookies de una cuenta/.test(text()), 'sin volver a pedir cookies que ya están subidas');

  // Lo que ve yt-dlp de verdad.
  await clickText('Ver qué formatos ve yt-dlp');
  ok(/Salida de/.test(text()), 'el botón enseña la salida de yt-dlp -F');
  ok(/137 mp4/.test(text()) && /140 m4a/.test(text()), 'con las pistas que ve YouTube');

  // Probar las cookies contra un vídeo público.
  await clickText('Probar cookies');
  ok(cookieTests >= 1, '«Probar cookies» las prueba contra YouTube', `${cookieTests} pruebas`);
  ok(/Las cookies funcionan/.test(text()), 'y confirma que funcionan');
  ok(/Sesión iniciada con estas cookies \(válida hasta el 2099-01-01/.test(text()), 'y dice hasta cuándo vale la sesión');
  ok(/Por qué un archivo y no usuario\/contraseña/.test(text()), 'explica por qué se usa un archivo y no usuario/contraseña');
  ok(/youtube-dl test video/.test(text()), 'diciendo qué ha leído con ellas');

  // Cookies caducadas: la prueba falla con el motivo y el bloque lo marca.
  cookiesExpired = true;
  await clickText('Probar cookies');
  ok(/Las cookies están caducadas/.test(text()), 'si han caducado, la prueba lo dice claro');
  ok(/caducadas/.test(text()), 'y el bloque de cookies lo marca');
  cookiesExpired = false;

  // Se vuelve al directo normal para seguir con el resto de la prueba.
  await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');
}

// ── 4f. Lista que sólo da DASH/HLS: prepararla en el disco ─────────────────
{
  await setValue(urlInput, 'https://www.youtube.com/playlist?list=PLsimpsons');
  await clickText('Comprobar señal');
  ok(/no ofrecen un MP4 progresivo/.test(text()), 'la lista sin MP4 progresivo se explica');
  ok(/10 no ofrece MP4 progresivo/.test(text()), 'con el resumen de motivos', text().slice(-200));
  ok(buttons('Preparar lista en el disco').length > 0, 'y ofrece prepararla en el disco');
  const limitInput = [...document.querySelectorAll('input[type="number"]')][0];
  ok(Boolean(limitInput), 'con un selector de cuántos vídeos');
  await setValue(limitInput, '10');

  const preparesAntes = prepares;
  await clickText('Preparar lista en el disco');
  const prepCall = calls.filter((c) => c.url === '/api/youtube/prepare-playlist' && c.method === 'POST').pop();
  ok(Boolean(prepCall), 'preparar la lista llama al panel');
  ok(prepCall?.body?.limit === 10, 'con el límite elegido', String(prepCall?.body?.limit));
  ok(/Preparando|1\/10/.test(text()), 'mientras descarga, dice por dónde va', text().slice(-120));

  await act(async () => {
    await new Promise((r) => setTimeout(r, 2600));
  });
  await flush();
  await flush();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  await flush();
  await flush();
  ok(prepares === preparesAntes + 1, 'la preparación se lanza una sola vez', `${prepares - preparesAntes}`);
  ok(/Lista preparada: 10 de 10 vídeos en el disco/.test(text()), 'al terminar dice cuántos hay en el disco');
  ok(/se emiten en orden desde el disco/i.test(text()), 'y que ya no dependen de YouTube');
  ok(/LISTA · 10/.test(text()) || /10 vídeos/.test(text()), 'el enlace queda resuelto con sus vídeos', text().slice(-160));

  // Se vuelve al directo normal para seguir con el resto de la prueba.
  await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');
}

// ── 4g. Anti-robots con cookies válidas: es la IP, no la sesión ────────────
{
  await setValue(urlInput, 'https://www.youtube.com/watch?v=ipbot123');
  await clickText('Comprobar señal');
  ok(/Verificación anti-robots de YouTube/.test(text()), 'el aviso de anti-robots se ve de un vistazo');
  ok(/IP pública de este servidor/.test(text()), 'y explica que es la IP del servidor');
  ok(/cookies son válidas hasta el 01\/01\/2030/.test(text()), 'diciendo que la sesión está bien (no hay que reexportar)');
  ok(/los clientes: normal, tv/.test(text()), 'con los clientes probados');
  ok(buttons('Actualizar yt-dlp').length > 0, 'y ofrece actualizar yt-dlp');
  ok(!/Sube un archivo de cookies/.test(text()), 'sin pedir cookies nuevas');

  // La tabla de formatos dice con qué cliente la ha visto.
  await clickText('Ver qué formatos ve yt-dlp');
  ok(/cliente tv/.test(text()), 'la tabla de formatos dice con qué cliente la vio', text().slice(-160));

  // Se vuelve al directo normal para seguir con el resto de la prueba.
  await setValue(urlInput, 'https://www.youtube.com/@canaldemo/live');
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
