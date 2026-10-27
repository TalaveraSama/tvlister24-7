// Estructura de datos por defecto + datos de demostración.
import { randomUUID } from 'node:crypto';

const uid = () => randomUUID();

export function defaultData() {
  return {
    meta: {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      seeded: false,
    },
    settings: {
      obs: {
        driver: 'mock', // mock (simulador) | real (OBS WebSocket) | off
        host: '127.0.0.1',
        port: 4455,
        password: '',
        autoConnect: false,
        reconnect: true,
        mediaSource: 'Proca Media',
        mediaMode: 'single', // single | playlist | m3u
        playlistSource: 'Proca VLC',
        audioSource: 'Proca Media',
        lowerThirdSource: '',
        programScene: 'Programa',
        adScene: '',
        liveScene: 'En Vivo',
        liveSource: '',
        emergencyScene: 'Emergencia',
        slateScene: 'Slate',
        graphicsSource: 'Proca Graficos',
        slateSource: 'Proca Slate',
        recordDirectory: '',
      },
      app: {
        channelName: 'Canal 24/7',
        timezone: 'America/Managua',
        timeFormat: '24', // 24 | 12
        operator: 'Operador',
        emergencyAutoRecover: true,
      },
      playout: {
        defaultDurationSec: 60,
        resumeOnStart: true,
        startPaused: false,
        showNextCountdown: true,
        minAdGapSeconds: 120,
      },
      mediaFolders: [],
    },
    graphics: {
      logo: { enabled: true, visible: true, source: 'Proca Logo', image: '', text: 'CANAL 24/7', position: 'top-right', opacity: 0.95, width: 150 },
      clock: { enabled: true, visible: true, source: 'Proca Reloj', format: '24', position: 'top-left', showSeconds: true },
      ticker: {
        enabled: true, visible: true, source: 'Proca Ticker',
        text: 'Bienvenidos a la señal 24/7 · Proca Automation controla la emisión · Próximamente: más contenido en nuestra parrilla',
        speed: 'normal', // lento | normal | rapido
        items: [
          'Bienvenidos a la señal 24/7 · Proca Automation controla la emisión',
          'Programación continua las 24 horas',
        ],
        separator: '   •   ',
      },
      lowerThird: { enabled: true, visible: true, kind: 'auto' }, // auto | none | now | next | later
      adsMode: false,
      scheduledTitles: [],
      overlayToken: '',
    },
    media: [],
    categories: [],
    genres: [],
    playlists: [],
    slots: [],
    grid: { entries: [], templates: [] },
    adBlocks: [],
    recording: { schedules: [], sessions: [], active: false, startedAt: null, lastError: null },
    emergency: {
      enabled: true,
      folder: '',
      playlistId: null,
      mediaIds: [],
      silenceSeconds: 15,
      noProgressSeconds: 25,
      autoRecover: true,
      recoverAfterSec: 10,
      hideTicker: false,
    },
    live: { overrides: [], current: null, history: [] },
    asrun: [],
    counters: { adRuns: {}, itemsPlayed: 0 },
    runtime: {
      mode: 'idle', // idle | automation | schedule | ads | live | emergency | slate
      playlistId: null,
      source: null,
      sourceName: '',
      sourceType: 'automation',
      items: [],
      index: 0,
      itemStartedAt: Date.now(),
      itemOffsetMs: 0,
      paused: false,
      pausedAt: null,
      scheduleEntryId: null,
      scheduleEndAt: null,
      ads: null,
      live: null,
      emergency: null,
      suppressed: {},
      lastAdvanceAt: Date.now(),
      startedAt: null,
      stats: { itemsPlayed: 0, adsPlayed: 0, emergencies: 0, liveMinutes: 0 },
    },
    presets: [],
  };
}

const DEMO_GRADIENTS = [
  ['#0ea5e9', '#1e3a8a'], ['#f97316', '#7c2d12'], ['#22c55e', '#064e3b'],
  ['#a855f7', '#4c1d95'], ['#ef4444', '#7f1d1d'], ['#14b8a6', '#134e4a'],
];

function demoMedia(title, duration, category, genre, extra = {}) {
  const id = uid();
  return {
    id,
    path: `demo://${id}`,
    name: `${title}.mp4`,
    title,
    duration,
    category,
    genre,
    season: extra.season ?? null,
    episode: extra.episode ?? null,
    kind: 'video',
    demo: true,
    visual: DEMO_GRADIENTS[Math.floor(Math.random() * DEMO_GRADIENTS.length)],
    addedAt: Date.now(),
    size: duration * 450000,
  };
}

/** Datos de ejemplo para que la aplicación arranque "viva". */
export function demoData() {
  const d = defaultData();
  d.meta.seeded = true;

  const media = [
    demoMedia('Amanecer Informativo', 900, 'Noticias', 'Informativo', { season: 1, episode: 1 }),
    demoMedia('Documental: Volcanes de Nicaragua', 1800, 'Documentales', 'Documental', { season: 1, episode: 2 }),
    demoMedia('Cápsula Cultural', 180, 'Culturales', 'Cápsula', { season: 1, episode: 3 }),
    demoMedia('Música Nacional', 240, 'Música', 'Videoclip', { season: 1, episode: 4 }),
    demoMedia('Ruta Gastronómica', 1200, 'Estilo de vida', 'Reportaje', { season: 2, episode: 1 }),
    demoMedia('Deportes en Acción', 1500, 'Deportes', 'Deportivo', { season: 2, episode: 2 }),
    demoMedia('Cine del Recuerdo', 2700, 'Cine', 'Película', { season: 1, episode: 5 }),
    demoMedia('Cápsula Tecnología', 300, 'Tecnología', 'Cápsula', { season: 3, episode: 1 }),
    demoMedia('Turismo en el Pacífico', 960, 'Culturales', 'Documental', { season: 3, episode: 2 }),
    demoMedia('Entrevista Central', 1080, 'Noticias', 'Entrevista', { season: 2, episode: 3 }),
    demoMedia('Micro Documental: Lagos', 420, 'Documentales', 'Documental', { season: 4, episode: 1 }),
    demoMedia('Cierre Musical', 240, 'Música', 'Videoclip', { season: 4, episode: 2 }),
    demoMedia('Cortina Institucional', 12, 'Publicidad', 'Cortina'),
    demoMedia('Promo Canal 24/7', 20, 'Publicidad', 'Promo'),
    demoMedia('Comercial Café del Norte', 30, 'Publicidad', 'Comercial'),
    demoMedia('Comercial Ferretería Central', 30, 'Publicidad', 'Comercial'),
    demoMedia('Comercial Clínica Vida', 25, 'Publicidad', 'Comercial'),
    demoMedia('Cortina de Salida', 10, 'Publicidad', 'Cortina'),
  ];
  d.media = media;
  const byTitle = (t) => media.find((m) => m.title === t).id;

  d.categories = [
    { id: uid(), name: 'Noticias' }, { id: uid(), name: 'Documentales' },
    { id: uid(), name: 'Culturales' }, { id: uid(), name: 'Cine' },
    { id: uid(), name: 'Música' }, { id: uid(), name: 'Deportes' },
    { id: uid(), name: 'Publicidad' }, { id: uid(), name: 'Tecnología' },
  ];
  d.genres = ['Informativo', 'Documental', 'Cápsula', 'Entrevista', 'Película', 'Videoclip', 'Comercial', 'Promo', 'Cortina', 'Reportaje', 'Deportivo']
    .map((name) => ({ id: uid(), name }));

  const mainPlaylist = {
    id: uid(),
    name: 'Señal 24/7 Principal',
    description: 'Rotación continua de la programación general',
    items: [
      { id: uid(), type: 'category', category: 'Noticias' },
      { id: uid(), type: 'category', category: 'Documentales' },
      { id: uid(), type: 'category', category: 'Culturales' },
      { id: uid(), type: 'category', category: 'Música' },
      { id: uid(), type: 'media', mediaId: byTitle('Ruta Gastronómica') },
      { id: uid(), type: 'media', mediaId: byTitle('Cine del Recuerdo') },
      { id: uid(), type: 'category', category: 'Tecnología' },
      { id: uid(), type: 'media', mediaId: byTitle('Cierre Musical') },
    ],
    order: 'season',
    loop: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const adPlaylist = {
    id: uid(),
    name: 'Señal Comercial',
    description: 'Bloque de respaldo',
    items: [{ id: uid(), type: 'category', category: 'Publicidad' }],
    order: 'manual',
    loop: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const emergencyPlaylist = {
    id: uid(),
    name: 'Emergencia',
    description: 'Se activa si se detecta silencio o caída de reproducción',
    items: [
      { id: uid(), type: 'media', mediaId: byTitle('Micro Documental: Lagos') },
      { id: uid(), type: 'media', mediaId: byTitle('Turismo en el Pacífico') },
    ],
    order: 'alpha',
    loop: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  d.playlists = [mainPlaylist, adPlaylist, emergencyPlaylist];

  // File Slots: agrupaciones de archivos que rotan en cada emisión.
  d.slots = [
    {
      id: uid(), name: 'Cortinas del canal', description: 'Rotan en cada bloque',
      mediaIds: [byTitle('Cortina Institucional'), byTitle('Promo Canal 24/7')], cursor: 0,
    },
    {
      id: uid(), name: 'Cápsulas culturales', description: 'Contenido de relleno corto',
      mediaIds: [byTitle('Cápsula Cultural'), byTitle('Micro Documental: Lagos')], cursor: 0,
    },
  ];

  mainPlaylist.items.splice(0, 0, { id: uid(), type: 'slot', slotId: d.slots[0].id });

  d.runtime.playlistId = mainPlaylist.id;

  d.grid.entries = [
    {
      id: uid(), name: 'Matutino Informativo', days: [1, 2, 3, 4, 5],
      start: '06:00', end: '09:00', contentType: 'playlist', playlistId: mainPlaylist.id,
      endMode: 'exact', enabled: true, color: '#38bdf8', priority: 10, notes: 'Bloque matutino',
    },
    {
      id: uid(), name: 'Franja Documental', days: [1, 2, 3, 4, 5, 6, 0],
      start: '14:00', end: '18:00', contentType: 'category', category: 'Documentales',
      endMode: 'exact', enabled: true, color: '#a78bfa', priority: 5, notes: '',
    },
    {
      id: uid(), name: 'Cine Estelar', days: [5, 6, 0],
      start: '20:00', end: '23:30', contentType: 'category', category: 'Cine',
      endMode: 'afterLast', enabled: true, color: '#fb923c', priority: 8, notes: '',
    },
    {
      id: uid(), name: 'Estudio en Vivo', days: [3],
      start: '19:00', end: '20:00', contentType: 'live', endMode: 'exact', enabled: true,
      live: { sourceName: 'Cámara 1', sceneName: 'En Vivo' }, color: '#f43f5e', priority: 20,
      notes: 'Intervención semanal desde el estudio',
    },
  ];

  d.grid.templates = [
    {
      id: uid(), name: 'Parrilla Fin de Semana', createdAt: Date.now(),
      entries: [
        { name: 'Mañana de Cine', days: [6, 0], start: '09:00', end: '12:00', contentType: 'category', category: 'Cine', endMode: 'exact', color: '#fb923c' },
        { name: 'Música y Cultura', days: [6, 0], start: '12:00', end: '15:00', contentType: 'category', category: 'Culturales', endMode: 'exact', color: '#22c55e' },
      ],
    },
  ];

  d.adBlocks = [
    {
      id: uid(), name: 'Bloque Comercial Principal', enabled: true,
      ads: [byTitle('Comercial Café del Norte'), byTitle('Comercial Ferretería Central'), byTitle('Comercial Clínica Vida')],
      folders: [],
      trigger: { mode: 'interval', everyMinutes: 30, at: '12:00', everyItems: 3 },
      days: [0, 1, 2, 3, 4, 5, 6],
      bumpers: { inId: byTitle('Cortina Institucional'), outId: byTitle('Cortina de Salida') },
      hideGraphics: true, resumePoint: true, maxPerDay: 24, playCount: 0,
      lastRunAt: null, lastPlayedIds: [],
    },
    {
      id: uid(), name: 'Bloque Nocturno', enabled: true,
      ads: [byTitle('Promo Canal 24/7'), byTitle('Comercial Clínica Vida')],
      folders: [],
      trigger: { mode: 'clock', at: '21:00', everyMinutes: 60, everyItems: 3 },
      days: [1, 2, 3, 4, 5, 6, 0],
      bumpers: { inId: byTitle('Cortina Institucional'), outId: byTitle('Cortina de Salida') },
      hideGraphics: true, resumePoint: true, maxPerDay: 4, playCount: 0,
      lastRunAt: null, lastPlayedIds: [],
    },
  ];

  d.recording.schedules = [{
    id: uid(), name: 'Grabación Matutino', days: [1, 2, 3, 4, 5],
    start: '06:00', end: '09:00', enabled: true, audio: true,
  }];

  d.emergency.playlistId = emergencyPlaylist.id;
  d.graphics.ticker.text = 'Canal 24/7 en vivo · Proca Automation + OBS · Programación continua sin interrupciones · Estás viendo la señal principal';
  d.graphics.ticker.items = [
    'Canal 24/7 en vivo · Proca Automation + OBS',
    'Programación continua las 24 horas',
    'Estás viendo la señal principal',
  ];
  d.settings.app.channelName = 'Canal 24/7';
  d.runtime.items = [];
  return d;
}
