// Servidor HTTP + API REST + SSE para la interfaz de Proca.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mergeInto } from './store.js';
import { demoData, defaultData } from './defaults.js';
import { resolvePlaylist, resolveEntry, defaultPlaylistId } from './services/resolver.js';
import { resolveNow, previewSegments, dayLabel, endTimestamp } from './services/schedule.js';
import { buildAdSequence, blockSummary, adMediaIds } from './services/ads.js';
import { applyGraphics, buildOverlay } from './services/graphics.js';
import { importFolder, importFiles, libraryStats, cleanupMedia } from './services/library.js';
import { queryAsRun, toCSV } from './services/asrun.js';
import { tzParts, humanDateTime } from './time.js';

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const must = (cond, msg, status = 400) => {
  if (!cond) throw new ApiError(msg, status);
};
const uid = () => randomUUID();
const windowMinutesLocal = (start, end) => {
  const toMin = (v) => {
    const [h, m] = String(v || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const s = toMin(start);
  let e = toMin(end);
  if (e <= s) e += 1440;
  return e - s;
};

export function createApp({ store, obs, engine, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  const clients = new Set();
  let broadcastTimer = null;

  function writeEvent(res, event, payload) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch { /* cliente desconectado */ }
  }

  function broadcastNow() {
    if (!clients.size) return;
    const snapshot = engine.snapshot();
    for (const res of clients) writeEvent(res, 'state', snapshot);
  }

  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastNow();
    }, 120);
    broadcastTimer.unref?.();
  }

  engine.on('change', broadcast);
  obs.on('connected', broadcast);
  obs.on('disconnected', broadcast);
  obs.on('record', broadcast);

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    clients.add(res);
    writeEvent(res, 'state', engine.snapshot());
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 20000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ------------------------------------------------------------------ estado
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), version: '1.0.0', obs: obs.status().connected });
  });

  app.get('/api/state', (req, res) => res.json(engine.snapshot()));

  app.get('/api/bootstrap', (req, res) => {
    const d = store.data;
    const tz = d.settings.app.timezone;
    const parts = tzParts(new Date(), tz);
    res.json({
      snapshot: engine.snapshot(),
      settings: d.settings,
      graphics: d.graphics,
      media: d.media,
      categories: d.categories,
      genres: d.genres,
      slots: (d.slots || []).map((sl) => {
        const pool = (sl.mediaIds || []).map((id) => d.media.find((m) => m.id === id)).filter(Boolean);
        return {
          ...sl,
          count: pool.length,
          currentMedia: pool.length ? pool[(sl.cursor || 0) % pool.length].title : null,
          usedIn: d.playlists
            .filter((p) => (p.items || []).some((i) => i.type === 'slot' && i.slotId === sl.id))
            .map((p) => p.name),
        };
      }),
      playlists: d.playlists.map((p) => {
        const { playlist, items } = resolvePlaylist(d, p.id);
        return {
          ...p,
          resolvedCount: items.length,
          resolvedItems: items.slice(0, 8).map((i) => i.title),
          loop: playlist?.loop !== false,
        };
      }),
      grid: {
        ...d.grid,
        entries: d.grid.entries.map((e) => ({
          ...e,
          daysLabel: dayLabel(e.days),
          activeNow: resolveNow(d).current?.id === e.id,
          resolvedCount: e.contentType === 'live' ? 1 : resolveEntry(d, e).items.length,
          durationMin: windowMinutesLocal(e.start, e.end),
          dateLabel: e.dateFrom || e.dateTo ? `${e.dateFrom || '…'} → ${e.dateTo || '…'}` : 'Siempre vigente',
          startsInMinutes: resolveNow(d).upcoming.find((u) => u.id === e.id)?.startsInMinutes ?? null,
        })),
        current: resolveNow(d).current,
        upcoming: resolveNow(d).upcoming,
      },
      ads: d.adBlocks.map((b) => blockSummary(d, b)),
      emergency: { ...d.emergency, mediaCount: (d.emergency.mediaIds || []).length + (resolvePlaylist(d, d.emergency.playlistId).items.length || 0) },
      recording: d.recording,
      presets: d.presets,
      stats: libraryStats(d),
      asrun: queryAsRun(d, { limit: 40 }).rows,
      defaults: { playlistId: defaultPlaylistId(d), timezone: tz, dateKey: parts.dateKey },
      meta: d.meta,
      version: { app: '1.0.0', node: process.version },
    });
  });

  // --------------------------------------------------------------------- OBS
  app.get('/api/obs', (req, res) => res.json(obs.status()));

  app.post('/api/obs/connect', wrap(async (req, res) => {
    const body = req.body || {};
    const s = store.data.settings.obs;
    if (body.host !== undefined) s.host = String(body.host);
    if (body.port !== undefined) s.port = Number(body.port) || 4455;
    if (body.password !== undefined) s.password = String(body.password);
    if (body.mediaMode !== undefined) s.mediaMode = String(body.mediaMode);
    if (body.mediaSource !== undefined) s.mediaSource = String(body.mediaSource);
    if (body.playlistSource !== undefined) s.playlistSource = String(body.playlistSource);
    if (body.programScene !== undefined) s.programScene = String(body.programScene);
    store.save();
    if (s.driver === 'off' && body.mock === undefined) {
      await obs.disconnect();
      broadcast();
      res.json({ connected: false, kind: 'none', message: 'Modo OBS desactivado' });
      return;
    }
    const status = await obs.connect({ mock: !!body.mock });
    must(status.connected, status.lastError || 'No se pudo conectar con OBS', 502);
    res.json(status);
  }));

  app.post('/api/obs/disconnect', wrap(async (req, res) => {
    await obs.disconnect();
    broadcast();
    res.json({ ok: true });
  }));

  app.post('/api/obs/refresh', wrap(async (req, res) => {
    const result = await obs.refresh();
    res.json({ ok: true, ...result });
  }));

  app.post('/api/obs/scene', wrap(async (req, res) => {
    await obs.setScene(req.body?.scene);
    res.json({ ok: true });
  }));

  app.post('/api/obs/simulate', wrap(async (req, res) => {
    const result = obs.simulate(req.body?.what);
    if (!result.ok) throw new ApiError(result.error || 'Simulación no disponible');
    if (req.body?.what === 'drop') engine.broadcast();
    res.json(result);
  }));

  app.get('/api/obs/record', wrap(async (req, res) => res.json(await obs.recordStatus())));

  app.post('/api/obs/record/start', wrap(async (req, res) => res.json(await engine.startRecording({ name: req.body?.name || 'Grabación manual' }))));
  app.post('/api/obs/record/stop', wrap(async (req, res) => res.json(await engine.stopRecording(req.body?.reason))));

  // ---------------------------------------------------------------- ajustes
  app.get('/api/settings', (req, res) => res.json(store.data.settings));

  app.patch('/api/settings', wrap(async (req, res) => {
    const body = req.body || {};
    mergeInto(store.data.settings, body);
    store.save();
    if (body.obs) await obs.refresh().catch(() => {});
    await engine.refreshGraphics(true);
    broadcast();
    res.json(store.data.settings);
  }));

  app.get('/api/presets', (req, res) => res.json(store.data.presets || []));

  app.post('/api/presets', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    must(name, 'Indique un nombre para el preset');
    const preset = {
      id: uid(),
      name,
      createdAt: Date.now(),
      settings: JSON.parse(JSON.stringify(store.data.settings)),
      graphics: JSON.parse(JSON.stringify(store.data.graphics)),
      emergency: JSON.parse(JSON.stringify(store.data.emergency)),
    };
    store.data.presets.push(preset);
    store.save();
    res.json(preset);
  }));

  app.post('/api/presets/:id/apply', wrap(async (req, res) => {
    const preset = store.data.presets.find((p) => p.id === req.params.id);
    must(preset, 'Preset no encontrado', 404);
    mergeInto(store.data.settings, preset.settings);
    mergeInto(store.data.graphics, preset.graphics);
    mergeInto(store.data.emergency, preset.emergency);
    store.save();
    await applyGraphics(obs, store.data, log);
    broadcast();
    res.json({ ok: true });
  }));

  app.delete('/api/presets/:id', (req, res) => {
    store.data.presets = store.data.presets.filter((p) => p.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- biblioteca
  app.get('/api/media', (req, res) => {
    const { q, category, genre } = req.query;
    let list = store.data.media;
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((m) => `${m.title} ${m.name} ${m.path} ${m.category} ${m.genre}`.toLowerCase().includes(needle));
    }
    if (category) list = list.filter((m) => m.category === category);
    if (genre) list = list.filter((m) => m.genre === genre);
    res.json({ rows: list, stats: libraryStats(store.data) });
  });

  app.get('/api/media/:id', (req, res) => {
    const m = store.data.media.find((x) => x.id === req.params.id);
    must(m, 'Medio no encontrado', 404);
    res.json(m);
  });

  app.post('/api/media', wrap(async (req, res) => {
    const b = req.body || {};
    must(b.path || b.title, 'Indique la ruta o el título del medio');
    const media = {
      id: uid(),
      path: b.path || '',
      name: b.name || path.basename(b.path || 'medio.mp4'),
      title: b.title || path.parse(b.path || 'Medio').name,
      duration: Number(b.duration) || store.data.settings.playout.defaultDurationSec,
      category: b.category || '',
      genre: b.genre || '',
      season: b.season ?? null,
      episode: b.episode ?? null,
      kind: b.kind || 'video',
      folderPath: b.folderPath || '',
      size: Number(b.size) || 0,
      addedAt: Date.now(),
    };
    store.data.media.push(media);
    store.save();
    res.json(media);
  }));

  app.post('/api/media/import', wrap(async (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    must(files.length, 'Sin archivos para importar');
    const result = importFiles(store.data, files, {
      category: req.body.category || '',
      genre: req.body.genre || '',
      onDuplicate: req.body.onDuplicate || 'skip',
    });
    store.save();
    res.json({ ok: true, added: result.added.length, skipped: result.skipped.length, rows: result.added });
  }));

  app.post('/api/media/import-folder', wrap(async (req, res) => {
    const folder = req.body?.folderPath || req.body?.folder;
    const result = importFolder(store.data, folder, {
      recursive: req.body?.recursive !== false,
      category: req.body?.category || '',
      genre: req.body?.genre || '',
      onDuplicate: req.body?.onDuplicate || 'skip',
    });
    store.save();
    res.json({ ok: true, ...result, stats: libraryStats(store.data) });
  }));

  app.post('/api/media/scan', wrap(async (req, res) => {
    const folders = req.body?.folderPath
      ? [req.body.folderPath]
      : (store.data.settings.mediaFolders || []);
    must(folders.length, 'No hay carpetas configuradas');
    let added = 0;
    let skipped = 0;
    const errors = [];
    for (const folder of folders) {
      try {
        const r = importFolder(store.data, folder, { recursive: true, onDuplicate: 'skip' });
        added += r.added.length;
        skipped += r.skipped.length;
      } catch (err) {
        errors.push(err.message);
      }
    }
    store.save();
    res.json({ ok: true, added, skipped, errors, stats: libraryStats(store.data) });
  }));

  app.patch('/api/media/:id', wrap(async (req, res) => {
    const m = store.data.media.find((x) => x.id === req.params.id);
    must(m, 'Medio no encontrado', 404);
    const b = req.body || {};
    for (const key of ['title', 'category', 'genre', 'path', 'kind', 'folderPath']) {
      if (b[key] !== undefined) m[key] = String(b[key]);
    }
    if (b.duration !== undefined) m.duration = Math.max(1, Number(b.duration) || 1);
    if (b.season !== undefined) m.season = b.season === null || b.season === '' ? null : Number(b.season);
    if (b.episode !== undefined) m.episode = b.episode === null || b.episode === '' ? null : Number(b.episode);
    if (m.path) m.name = path.basename(m.path);
    store.save();
    res.json(m);
  }));

  app.delete('/api/media/:id', (req, res) => {
    const before = store.data.media.length;
    store.data.media = store.data.media.filter((m) => m.id !== req.params.id);
    for (const p of store.data.playlists) p.items = (p.items || []).filter((i) => i.mediaId !== req.params.id);
    for (const sl of store.data.slots || []) sl.mediaIds = (sl.mediaIds || []).filter((id) => id !== req.params.id);
    for (const b of store.data.adBlocks) {
      b.ads = (b.ads || []).filter((id) => id !== req.params.id);
      if (b.bumpers?.inId === req.params.id) b.bumpers.inId = null;
      if (b.bumpers?.outId === req.params.id) b.bumpers.outId = null;
    }
    store.save();
    res.json({ ok: true, removed: before - store.data.media.length });
  });

  app.get('/api/media/missing/list', (req, res) => res.json({ rows: cleanupMedia(store.data) }));

  // -------------------------------------------------- categorías y géneros
  for (const kind of ['categories', 'genres']) {
    app.get(`/api/${kind}`, (req, res) => res.json(store.data[kind]));
    app.post(`/api/${kind}`, (req, res) => {
      const name = String(req.body?.name || '').trim();
      must(name, 'Nombre requerido');
      must(!store.data[kind].some((c) => c.name.toLowerCase() === name.toLowerCase()), 'Ya existe');
      const row = { id: uid(), name };
      store.data[kind].push(row);
      store.save();
      res.json(row);
    });
    app.patch(`/api/${kind}/:id`, (req, res) => {
      const row = store.data[kind].find((c) => c.id === req.params.id);
      must(row, 'No encontrado', 404);
      const name = String(req.body?.name || '').trim();
      must(name, 'Nombre requerido');
      const old = row.name;
      row.name = name;
      if (kind === 'categories') {
        for (const m of store.data.media) if (m.category === old) m.category = name;
        for (const p of store.data.playlists) for (const i of p.items) if (i.category === old) i.category = name;
        for (const e of store.data.grid.entries) if (e.category === old) e.category = name;
      } else {
        for (const m of store.data.media) if (m.genre === old) m.genre = name;
      }
      store.save();
      res.json(row);
    });
    app.delete(`/api/${kind}/:id`, (req, res) => {
      store.data[kind] = store.data[kind].filter((c) => c.id !== req.params.id);
      store.save();
      res.json({ ok: true });
    });
  }

  // ------------------------------------------------------------- listas
  app.get('/api/playlists', (req, res) => {
    res.json(store.data.playlists.map((p) => {
      const r = resolvePlaylist(store.data, p.id);
      return { ...p, resolvedCount: r.items.length, resolvedPreview: r.items.slice(0, 10).map((i) => i.title) };
    }));
  });

  app.get('/api/playlists/:id', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    const r = resolvePlaylist(store.data, p.id);
    res.json({ ...p, resolvedItems: r.items });
  });

  app.post('/api/playlists', (req, res) => {
    const name = String(req.body?.name || '').trim();
    must(name, 'Nombre requerido');
    const playlist = {
      id: uid(), name,
      description: String(req.body?.description || ''),
      items: [],
      order: req.body?.order || 'manual',
      loop: req.body?.loop !== false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.data.playlists.push(playlist);
    store.save();
    res.json(playlist);
  });

  app.patch('/api/playlists/:id', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    const b = req.body || {};
    if (b.name !== undefined) p.name = String(b.name);
    if (b.description !== undefined) p.description = String(b.description);
    if (b.order !== undefined) p.order = String(b.order);
    if (b.loop !== undefined) p.loop = !!b.loop;
    p.updatedAt = Date.now();
    store.save();
    res.json(p);
  });

  app.delete('/api/playlists/:id', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    must(store.data.playlists.length > 1, 'Debe quedar al menos una lista');
    must(store.data.emergency.playlistId !== p.id, 'La lista está asignada como emergencia');
    store.data.playlists = store.data.playlists.filter((x) => x.id !== p.id);
    for (const e of store.data.grid.entries) if (e.playlistId === p.id) e.playlistId = null;
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/playlists/:id/items', wrap(async (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    const b = req.body || {};

    // Pegado masivo (mover/copiar varios elementos entre listas)
    if (Array.isArray(b.entries)) {
      const createdBulk = [];
      for (const raw of b.entries) {
        const entry = { id: uid(), ...raw };
        if (entry.type === 'media') {
          must(store.data.media.some((m) => m.id === entry.mediaId), 'Medio no encontrado', 404);
        } else if (entry.type === 'category') {
          must(entry.category, 'Categoría requerida');
        } else if (entry.type === 'folder') {
          must(entry.folderPath, 'Carpeta requerida');
        } else if (entry.type === 'slot') {
          must((store.data.slots || []).some((x) => x.id === entry.slotId), 'Slot inválido');
        } else if (entry.type === 'playlist') {
          must(entry.playlistId && entry.playlistId !== p.id, 'Lista anidada inválida');
        } else {
          continue;
        }
        p.items.push(entry);
        createdBulk.push(entry);
      }
      p.updatedAt = Date.now();
      store.save();
      res.json({ ok: true, items: createdBulk, total: p.items.length });
      return;
    }

    const type = b.type || (b.mediaId ? 'media' : b.category ? 'category' : b.folderPath ? 'folder' : null);
    must(type, 'Indique el tipo de elemento');
    const items = Array.isArray(b.items) ? b.items : [b];
    const created = [];
    for (const it of items) {
      let entry;
      if (type === 'media') {
        const media = store.data.media.find((m) => m.id === it.mediaId);
        must(media, 'Medio no encontrado', 404);
        entry = { id: uid(), type: 'media', mediaId: media.id };
      } else if (type === 'category') {
        const category = String(it.category || '').trim();
        must(category, 'Categoría requerida');
        entry = { id: uid(), type: 'category', category };
      } else if (type === 'folder') {
        const folderPath = String(it.folderPath || it.path || '').trim();
        must(folderPath, 'Carpeta requerida');
        entry = { id: uid(), type: 'folder', folderPath };
      } else if (type === 'playlist') {
        must(it.playlistId && it.playlistId !== p.id, 'Lista anidada inválida');
        entry = { id: uid(), type: 'playlist', playlistId: it.playlistId };
      } else if (type === 'slot') {
        must(it.slotId && (store.data.slots || []).some((x) => x.id === it.slotId), 'Slot inválido');
        entry = { id: uid(), type: 'slot', slotId: it.slotId };
      } else {
        throw new ApiError('Tipo de elemento inválido');
      }
      p.items.push(entry);
      created.push(entry);
    }
    p.updatedAt = Date.now();
    store.save();
    res.json({ ok: true, items: created, total: p.items.length });
  }));

  app.delete('/api/playlists/:id/items/:itemId', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    p.items = p.items.filter((i) => i.id !== req.params.itemId);
    p.updatedAt = Date.now();
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/playlists/:id/reorder', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    must(ids, 'Envíe el arreglo "ids" con el nuevo orden');
    const map = new Map(p.items.map((i) => [i.id, i]));
    const next = ids.map((id) => map.get(id)).filter(Boolean);
    for (const item of p.items) if (!ids.includes(item.id)) next.push(item);
    p.items = next;
    p.updatedAt = Date.now();
    store.save();
    res.json({ ok: true, items: p.items });
  });

  app.post('/api/playlists/:id/move', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    const { itemId, delta } = req.body || {};
    const idx = p.items.findIndex((i) => i.id === itemId);
    must(idx >= 0, 'Elemento no encontrado', 404);
    const to = Math.max(0, Math.min(p.items.length - 1, idx + (Number(delta) || 0)));
    const [row] = p.items.splice(idx, 1);
    p.items.splice(to, 0, row);
    p.updatedAt = Date.now();
    store.save();
    res.json({ ok: true, items: p.items });
  });

  app.post('/api/playlists/:id/duplicate', (req, res) => {
    const p = store.data.playlists.find((x) => x.id === req.params.id);
    must(p, 'Lista no encontrada', 404);
    const copy = {
      ...JSON.parse(JSON.stringify(p)),
      id: uid(), name: `${p.name} (copia)`, createdAt: Date.now(), updatedAt: Date.now(),
    };
    copy.items = copy.items.map((i) => ({ ...i, id: uid() }));
    store.data.playlists.push(copy);
    store.save();
    res.json(copy);
  });

  app.post('/api/playlists/:id/play', wrap(async (req, res) => {
    await engine.startPlaylist(req.params.id, { reason: 'operador' });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------- File Slots
  app.get('/api/slots', (req, res) => {
    res.json((store.data.slots || []).map((sl) => ({
      ...sl,
      count: (sl.mediaIds || []).filter((id) => store.data.media.some((m) => m.id === id)).length,
      currentMedia: (() => {
        const pool = (sl.mediaIds || []).map((id) => store.data.media.find((m) => m.id === id)).filter(Boolean);
        return pool.length ? pool[(sl.cursor || 0) % pool.length].title : null;
      })(),
      usedIn: store.data.playlists.filter((p) => (p.items || []).some((i) => i.type === 'slot' && i.slotId === sl.id)).map((p) => p.name),
    })));
  });

  app.post('/api/slots', (req, res) => {
    const name = String(req.body?.name || '').trim();
    must(name, 'Nombre requerido');
    const slot = { id: uid(), name, description: String(req.body?.description || ''), mediaIds: [], cursor: 0 };
    store.data.slots.push(slot);
    store.save();
    res.json(slot);
  });

  app.patch('/api/slots/:id', (req, res) => {
    const slot = store.data.slots.find((s2) => s2.id === req.params.id);
    must(slot, 'Slot no encontrado', 404);
    const b = req.body || {};
    if (b.name !== undefined) slot.name = String(b.name);
    if (b.description !== undefined) slot.description = String(b.description);
    if (b.cursor !== undefined) slot.cursor = Math.max(0, Number(b.cursor) || 0);
    if (Array.isArray(b.mediaIds)) slot.mediaIds = b.mediaIds;
    store.save();
    res.json(slot);
  });

  app.post('/api/slots/:id/media', (req, res) => {
    const slot = store.data.slots.find((s2) => s2.id === req.params.id);
    must(slot, 'Slot no encontrado', 404);
    const ids = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [req.body?.mediaId].filter(Boolean);
    must(ids.length, 'Seleccione al menos un medio');
    for (const id of ids) {
      must(store.data.media.some((m) => m.id === id), 'Medio no encontrado', 404);
      if (!slot.mediaIds.includes(id)) slot.mediaIds.push(id);
    }
    store.save();
    res.json(slot);
  });

  app.delete('/api/slots/:id/media/:mediaId', (req, res) => {
    const slot = store.data.slots.find((s2) => s2.id === req.params.id);
    must(slot, 'Slot no encontrado', 404);
    slot.mediaIds = slot.mediaIds.filter((id) => id !== req.params.mediaId);
    store.save();
    res.json(slot);
  });

  app.post('/api/slots/:id/rotate', (req, res) => {
    const slot = store.data.slots.find((s2) => s2.id === req.params.id);
    must(slot, 'Slot no encontrado', 404);
    slot.cursor = (slot.cursor || 0) + 1;
    store.save();
    res.json(slot);
  });

  app.delete('/api/slots/:id', (req, res) => {
    store.data.slots = store.data.slots.filter((s2) => s2.id !== req.params.id);
    for (const p of store.data.playlists) {
      p.items = (p.items || []).filter((i) => !(i.type === 'slot' && i.slotId === req.params.id));
    }
    store.save();
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- parrilla
  app.get('/api/grid', (req, res) => {
    const d = store.data;
    const now = resolveNow(d);
    res.json({
      entries: d.grid.entries.map((e) => ({
        ...e,
        daysLabel: dayLabel(e.days),
        activeNow: now.current?.id === e.id,
        resolvedCount: e.contentType === 'live' ? 1 : resolveEntry(d, e).items.length,
        startsInMinutes: now.upcoming.find((u) => u.id === e.id)?.startsInMinutes ?? null,
        endsAt: e.end,
        durationMin: windowMinutesLocal(e.start, e.end),
        dateLabel: e.dateFrom || e.dateTo ? `${e.dateFrom || '…'} → ${e.dateTo || '…'}` : 'Siempre vigente',
      })),
      templates: d.grid.templates,
      current: now.current,
      upcoming: now.upcoming,
      parts: now.parts,
    });
  });

  const COLOR = '#38bdf8';
  app.post('/api/grid/entries', (req, res) => {
    const b = req.body || {};
    must(b.name, 'Nombre requerido');
    must(b.start && b.end, 'Indique hora de inicio y finalización');
    const entry = {
      id: uid(),
      name: String(b.name),
      days: Array.isArray(b.days) && b.days.length ? b.days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
      start: b.start,
      end: b.end,
      contentType: b.contentType || 'playlist',
      playlistId: b.playlistId || null,
      category: b.category || '',
      folderPath: b.folderPath || '',
      mediaId: b.mediaId || null,
      order: b.order || 'manual',
      endMode: b.endMode === 'afterLast' ? 'afterLast' : 'exact',
      enabled: b.enabled !== false,
      color: b.color || COLOR,
      priority: Number(b.priority) || 5,
      notes: b.notes || '',
      live: b.live || null,
      dateFrom: b.dateFrom || '',
      dateTo: b.dateTo || '',
      createdAt: Date.now(),
    };
    store.data.grid.entries.push(entry);
    store.save();
    res.json(entry);
  });

  app.patch('/api/grid/entries/:id', (req, res) => {
    const e = store.data.grid.entries.find((x) => x.id === req.params.id);
    must(e, 'Bloque no encontrado', 404);
    const b = req.body || {};
    for (const key of ['name', 'start', 'end', 'contentType', 'category', 'folderPath', 'order', 'endMode', 'notes', 'color', 'dateFrom', 'dateTo']) {
      if (b[key] !== undefined) e[key] = b[key];
    }
    for (const key of ['playlistId', 'mediaId']) if (b[key] !== undefined) e[key] = b[key];
    if (b.days !== undefined) e.days = (b.days || []).map(Number);
    if (b.enabled !== undefined) e.enabled = !!b.enabled;
    if (b.priority !== undefined) e.priority = Number(b.priority) || 0;
    if (b.live !== undefined) e.live = b.live;
    must(e.days.length, 'Seleccione al menos un día');
    store.save();
    res.json(e);
  });

  app.delete('/api/grid/entries/:id', (req, res) => {
    store.data.grid.entries = store.data.grid.entries.filter((x) => x.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/grid/entries/:id/activate', wrap(async (req, res) => {
    const e = store.data.grid.entries.find((x) => x.id === req.params.id);
    must(e, 'Bloque no encontrado', 404);
    must(e.contentType !== 'live', 'Use el módulo de intervención en vivo para este bloque');
    const { items } = resolveEntry(store.data, e);
    must(items.length, 'El bloque no tiene contenido reproducible');
    const rt = engine.rt;
    if (rt.mode === 'ads') throw new ApiError('Hay publicidad al aire, espere a que termine');
    rt.mode = 'schedule';
    rt.sourceType = 'schedule';
    rt.sourceName = e.name;
    rt.scheduleEntryId = e.id;
    rt.scheduleEndAt = endTimestamp(e, tzParts(new Date(), store.data.settings.app.timezone));
    rt.oneShot = null;
    rt.manualOverride = null;
    await engine.playListAt(0, 0, { reason: `activación manual: ${e.name}`, items });
    res.json({ ok: true, count: items.length });
  }));

  app.get('/api/grid/entries/:id/preview', (req, res) => {
    const e = store.data.grid.entries.find((x) => x.id === req.params.id);
    must(e, 'Bloque no encontrado', 404);
    const { items } = resolveEntry(store.data, e);
    res.json({ items: items.slice(0, 60), segments: previewSegments(items, e, 20) });
  });

  app.post('/api/grid/templates', (req, res) => {
    const name = String(req.body?.name || '').trim();
    must(name, 'Nombre requerido');
    const source = req.body?.entryIds
      ? store.data.grid.entries.filter((e) => req.body.entryIds.includes(e.id))
      : store.data.grid.entries;
    const tpl = {
      id: uid(),
      name,
      createdAt: Date.now(),
      entries: source.map((e) => ({
        name: e.name, days: e.days, start: e.start, end: e.end, contentType: e.contentType,
        playlistId: e.playlistId, category: e.category, folderPath: e.folderPath,
        endMode: e.endMode, color: e.color, priority: e.priority, notes: e.notes, live: e.live,
      })),
    };
    store.data.grid.templates.push(tpl);
    store.save();
    res.json(tpl);
  });

  app.post('/api/grid/templates/:id/apply', (req, res) => {
    const tpl = store.data.grid.templates.find((t) => t.id === req.params.id);
    must(tpl, 'Plantilla no encontrada', 404);
    const replace = req.body?.replace !== false;
    if (replace) store.data.grid.entries = [];
    for (const e of tpl.entries) {
      store.data.grid.entries.push({ ...e, id: uid(), enabled: true, createdAt: Date.now() });
    }
    store.save();
    res.json({ ok: true, count: tpl.entries.length });
  });

  app.delete('/api/grid/templates/:id', (req, res) => {
    store.data.grid.templates = store.data.grid.templates.filter((t) => t.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/grid/adapt', wrap(async (req, res) => {
    const result = await engine.adaptSchedule();
    res.json({ ok: true, result });
  }));

  // ------------------------------------------------------------ publicidad
  app.get('/api/ads', (req, res) => {
    res.json({
      blocks: store.data.adBlocks.map((b) => blockSummary(store.data, b)),
      running: engine.rt.mode === 'ads' ? engine.rt.ads : null,
    });
  });

  app.post('/api/ads/blocks', (req, res) => {
    const b = req.body || {};
    must(b.name, 'Nombre requerido');
    const block = {
      id: uid(),
      name: String(b.name),
      enabled: b.enabled !== false,
      ads: Array.isArray(b.ads) ? b.ads : [],
      folders: Array.isArray(b.folders) ? b.folders : [],
      trigger: {
        mode: b.trigger?.mode || 'interval',
        at: b.trigger?.at || '12:00',
        everyMinutes: Number(b.trigger?.everyMinutes) || 30,
        everyItems: Number(b.trigger?.everyItems) || 3,
      },
      days: Array.isArray(b.days) && b.days.length ? b.days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
      bumpers: { inId: b.bumpers?.inId || null, outId: b.bumpers?.outId || null },
      hideGraphics: b.hideGraphics !== false,
      resumePoint: b.resumePoint !== false,
      maxPerDay: Number(b.maxPerDay) || 24,
      shuffle: b.shuffle !== false,
      playCount: 0,
      lastRunAt: null,
      lastPlayedIds: [],
    };
    store.data.adBlocks.push(block);
    store.save();
    res.json(block);
  });

  app.patch('/api/ads/blocks/:id', (req, res) => {
    const block = store.data.adBlocks.find((b) => b.id === req.params.id);
    must(block, 'Bloque no encontrado', 404);
    const b = req.body || {};
    for (const key of ['name', 'hideGraphics', 'resumePoint', 'shuffle', 'enabled']) {
      if (b[key] !== undefined) block[key] = b[key];
    }
    if (b.ads !== undefined) block.ads = b.ads;
    if (b.folders !== undefined) block.folders = b.folders;
    if (b.bumpers !== undefined) block.bumpers = { ...block.bumpers, ...b.bumpers };
    if (b.days !== undefined) block.days = b.days.map(Number);
    if (b.maxPerDay !== undefined) block.maxPerDay = Number(b.maxPerDay) || 0;
    if (b.trigger !== undefined) block.trigger = { ...block.trigger, ...b.trigger };
    store.save();
    res.json(block);
  });

  app.delete('/api/ads/blocks/:id', (req, res) => {
    store.data.adBlocks = store.data.adBlocks.filter((b) => b.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/ads/blocks/:id/ads', (req, res) => {
    const block = store.data.adBlocks.find((b) => b.id === req.params.id);
    must(block, 'Bloque no encontrado', 404);
    const ids = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [req.body?.mediaId].filter(Boolean);
    must(ids.length, 'Seleccione al menos un medio');
    for (const id of ids) {
      must(store.data.media.some((m) => m.id === id), 'Medio no encontrado', 404);
      if (!block.ads.includes(id)) block.ads.push(id);
    }
    store.save();
    res.json(blockSummary(store.data, block));
  });

  app.delete('/api/ads/blocks/:id/ads/:mediaId', (req, res) => {
    const block = store.data.adBlocks.find((b) => b.id === req.params.id);
    must(block, 'Bloque no encontrado', 404);
    block.ads = block.ads.filter((id) => id !== req.params.mediaId);
    store.save();
    res.json(blockSummary(store.data, block));
  });

  app.get('/api/ads/blocks/:id/preview', (req, res) => {
    const block = store.data.adBlocks.find((b) => b.id === req.params.id);
    must(block, 'Bloque no encontrado', 404);
    const { items, warnings } = buildAdSequence(store.data, block, { avoidRepeat: false });
    res.json({ items, warnings, durationSec: items.reduce((a, i) => a + i.durationSec, 0), mediaCount: adMediaIds(store.data, block).length });
  });

  app.post('/api/ads/blocks/:id/run', wrap(async (req, res) => {
    const result = await engine.runAdBlock(req.params.id, { reason: 'orden del operador' });
    res.json(result);
  }));

  app.post('/api/ads/finish', wrap(async (req, res) => {
    if (engine.rt.mode !== 'ads') throw new ApiError('No hay publicidad al aire');
    await engine._finishAds('cortado por el operador');
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------- playout
  const control = (name, fn) => app.post(`/api/playout/${name}`, wrap(async (req, res) => {
    const out = await fn(req);
    broadcast();
    res.json({ ok: true, result: out ?? null });
  }));

  control('pause', () => engine.pause());
  control('resume', () => engine.resume());
  control('play', () => engine.resume());
  control('next', () => engine.next());
  control('previous', () => engine.previous());
  control('stop', () => engine.stopPlayout());
  control('air', (req) => {
    must(req.body?.mediaId, 'Indique el medio a enviar al aire');
    return engine.airMedia(req.body.mediaId);
  });
  control('goto', (req) => engine.goto(req.body?.index, Number(req.body?.offsetSec) || 0));
  control('automation', (req) => engine.startAutomation({ reason: 'operador', playlistId: req.body?.playlistId || null, operator: true }));
  control('seek', async (req) => {
    const rt = engine.rt;
    if (!rt.items?.length) throw new ApiError('No hay contenido cargado');
    const offset = Math.max(0, Number(req.body?.offsetSec) || 0);
    rt.itemStartedAt = Date.now() - offset * 1000;
    await engine._startItem({ reason: 'salto del operador', offsetSec: offset });
    return { offset };
  });

  app.post('/api/playout/sync', wrap(async (req, res) => {
    const rt = engine.rt;
    const status = await obs.mediaStatus();
    if (!rt.items?.length || !status.mediaCursor) throw new ApiError('Sin datos de OBS para sincronizar');
    rt.itemStartedAt = Date.now() - status.mediaCursor;
    engine.broadcast();
    res.json({ ok: true, cursor: status.mediaCursor });
  }));

  // ---------------------------------------------------------------- en vivo
  app.get('/api/live', (req, res) => {
    const scenes = obs.status().scenes || [];
    res.json({ current: engine.rt.live, scenes, inputs: obs.status().inputs || [] });
  });

  app.post('/api/live/start', wrap(async (req, res) => {
    const b = req.body || {};
    const live = await engine.startLive({
      sourceName: b.sourceName,
      sceneName: b.sceneName,
      label: b.label || 'Intervención en vivo',
      durationMin: Number(b.durationMin) || 0,
      endAt: b.endAt ? new Date(b.endAt).getTime() : null,
      reason: b.reason || 'intervención del operador',
    });
    res.json(live);
  }));

  app.post('/api/live/end', wrap(async (req, res) => {
    await engine.endLive({ reason: req.body?.reason || 'operador' });
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------- emergencia
  app.get('/api/emergency', (req, res) => {
    const e = store.data.emergency;
    res.json({
      ...e,
      active: engine.rt.mode === 'emergency',
      info: engine.rt.emergency,
      activations: store.data.asrun.filter((r) => r.kind === 'emergency').length,
    });
  });

  app.patch('/api/emergency', (req, res) => {
    const b = req.body || {};
    const e = store.data.emergency;
    for (const key of ['folder', 'playlistId', 'silenceSeconds', 'noProgressSeconds', 'recoverAfterSec']) {
      if (b[key] !== undefined) e[key] = b[key];
    }
    for (const key of ['enabled', 'autoRecover']) if (b[key] !== undefined) e[key] = !!b[key];
    if (b.mediaIds !== undefined) e.mediaIds = b.mediaIds;
    if (e.silenceSeconds !== undefined) e.silenceSeconds = Math.max(3, Number(e.silenceSeconds) || 15);
    if (e.noProgressSeconds !== undefined) e.noProgressSeconds = Math.max(5, Number(e.noProgressSeconds) || 25);
    store.save();
    res.json(e);
  });

  app.post('/api/emergency/exit', wrap(async (req, res) => {
    await engine.exitEmergency({ reason: 'operador' });
    res.json({ ok: true });
  }));

  app.post('/api/emergency/test', wrap(async (req, res) => {
    await engine.enterEmergency('prueba del operador');
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- gráficos
  app.get('/api/graphics', (req, res) => res.json({ graphics: store.data.graphics, overlay: buildOverlay(store.data) }));

  app.patch('/api/graphics', wrap(async (req, res) => {
    mergeInto(store.data.graphics, req.body || {});
    store.save();
    const overlay = await engine.refreshGraphics(true);
    broadcast();
    res.json({ graphics: store.data.graphics, overlay: overlay || buildOverlay(store.data) });
  }));

  app.post('/api/graphics/ticker', wrap(async (req, res) => {
    const g = store.data.graphics;
    const b = req.body || {};
    if (b.text !== undefined) g.ticker.text = String(b.text);
    if (b.items !== undefined) g.ticker.items = (b.items || []).map(String).filter(Boolean);
    if (b.speed !== undefined) g.ticker.speed = ['lento', 'normal', 'rapido'].includes(b.speed) ? b.speed : 'normal';
    if (b.enabled !== undefined) g.ticker.enabled = !!b.enabled;
    if (b.visible !== undefined) g.ticker.visible = !!b.visible;
    if (b.items === undefined && typeof b.text === 'string' && b.text.trim()) {
      g.ticker.items = b.text.split('·').map((s) => s.trim()).filter(Boolean);
    }
    store.save();
    await engine.refreshGraphics(true);
    broadcast();
    res.json({ ok: true, ticker: g.ticker, overlay: buildOverlay(store.data) });
  }));

  app.post('/api/graphics/scheduled', (req, res) => {
    const b = req.body || {};
    must(b.text, 'Texto requerido');
    const row = {
      id: uid(), text: String(b.text), kind: b.kind || 'now',
      from: b.from || '00:00', to: b.to || '23:59',
      days: Array.isArray(b.days) && b.days.length ? b.days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
    };
    store.data.graphics.scheduledTitles.push(row);
    store.save();
    res.json(row);
  });

  app.delete('/api/graphics/scheduled/:id', (req, res) => {
    store.data.graphics.scheduledTitles = store.data.graphics.scheduledTitles.filter((s) => s.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.post('/api/graphics/refresh', wrap(async (req, res) => {
    const overlay = await engine.refreshGraphics(true);
    res.json({ ok: true, overlay });
  }));

  // -------------------------------------------------------------- grabación
  app.get('/api/recording', wrap(async (req, res) => {
    res.json({
      ...store.data.recording,
      obs: await obs.recordStatus(),
      schedules: store.data.recording.schedules.map((s) => ({ ...s, daysLabel: dayLabel(s.days) })),
    });
  }));

  app.post('/api/recording/start', wrap(async (req, res) => {
    res.json(await engine.startRecording({ name: req.body?.name || 'Grabación manual' }));
  }));

  app.post('/api/recording/stop', wrap(async (req, res) => {
    res.json(await engine.stopRecording(req.body?.reason || 'operador'));
  }));

  app.post('/api/recording/schedules', (req, res) => {
    const b = req.body || {};
    must(b.name && b.start && b.end, 'Nombre, hora de inicio y fin son obligatorios');
    const row = {
      id: uid(), name: String(b.name), start: b.start, end: b.end,
      days: Array.isArray(b.days) && b.days.length ? b.days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
      enabled: b.enabled !== false, audio: b.audio !== false,
    };
    store.data.recording.schedules.push(row);
    store.save();
    res.json(row);
  });

  app.patch('/api/recording/schedules/:id', (req, res) => {
    const row = store.data.recording.schedules.find((s) => s.id === req.params.id);
    must(row, 'Programación no encontrada', 404);
    const b = req.body || {};
    for (const key of ['name', 'start', 'end']) if (b[key] !== undefined) row[key] = b[key];
    if (b.days !== undefined) row.days = b.days.map(Number);
    for (const key of ['enabled', 'audio']) if (b[key] !== undefined) row[key] = !!b[key];
    store.save();
    res.json(row);
  });

  app.delete('/api/recording/schedules/:id', (req, res) => {
    store.data.recording.schedules = store.data.recording.schedules.filter((s) => s.id !== req.params.id);
    store.save();
    res.json({ ok: true });
  });

  app.delete('/api/recording/sessions', (req, res) => {
    store.data.recording.sessions = [];
    store.save();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- as-run
  app.get('/api/asrun', (req, res) => {
    const q = req.query;
    const result = queryAsRun(store.data, {
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      kind: q.kind,
      q: q.q,
      limit: Math.min(1000, Number(q.limit) || 200),
      offset: Number(q.offset) || 0,
    });
    res.json({
      ...result,
      rows: result.rows.map((r) => ({
        ...r,
        startLabel: humanDateTime(r.ts, store.data.settings.app.timezone),
        endLabel: r.endTs ? humanDateTime(r.endTs, store.data.settings.app.timezone) : '',
      })),
    });
  });

  app.get('/api/asrun/export.csv', (req, res) => {
    const q = req.query;
    const rows = queryAsRun(store.data, {
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      kind: q.kind,
      limit: 5000,
    }).rows;
    const csv = toCSV(store.data, rows);
    const name = `as-run-${tzParts(new Date(), store.data.settings.app.timezone).dateKey}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send(csv);
  });

  app.delete('/api/asrun', (req, res) => {
    store.data.asrun = [];
    store.save();
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- sistema
  app.get('/api/logs', (req, res) => res.json({ lines: log.list(Number(req.query.limit) || 150) }));

  app.get('/api/data/export', (req, res) => {
    const d = store.data;
    res.set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="proca-backup-${tzParts(new Date(), d.settings.app.timezone).dateKey}.json"`,
    });
    res.send(JSON.stringify(d, null, 2));
  });

  app.post('/api/data/import', wrap(async (req, res) => {
    const payload = req.body?.data || req.body;
    must(payload && typeof payload === 'object', 'Archivo de configuración inválido');
    must(payload.settings && payload.media, 'El archivo no parece ser un respaldo de Proca');
    store.replace(payload);
    await obs.refresh().catch(() => {});
    await engine.refreshGraphics(true);
    broadcast();
    res.json({ ok: true });
  }));

  app.post('/api/data/reset', wrap(async (req, res) => {
    const mode = req.body?.mode === 'demo' ? 'demo' : 'empty';
    store.replace(mode === 'demo' ? demoData() : defaultData());
    engine.rt.items = [];
    engine.rt.mode = 'idle';
    broadcast();
    res.json({ ok: true, mode });
  }));

  app.get('/api/quick-lists', (req, res) => {
    const d = store.data;
    res.json({
      playlists: d.playlists.map((p) => ({ id: p.id, name: p.name, count: resolvePlaylist(d, p.id).items.length })),
      adBlocks: d.adBlocks.map((b) => ({ id: b.id, name: b.name, count: adMediaIds(d, b).length })),
      categories: (d.categories || []).map((c) => c.name),
    });
  });

  // ---------------------------------------------------------------- overlay
  app.get('/overlay', (req, res) => {
    res.sendFile(path.resolve('public', 'overlay.html'));
  });

  app.get('/overlay/state', (req, res) => res.json(buildOverlay(store.data)));

  // -------------------------------------------------------------- estáticos
  app.use(express.static(path.resolve('public'), { extensions: ['html'] }));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const index = path.resolve('public', 'index.html');
    if (!fs.existsSync(index)) return res.status(500).send('Falta public/index.html');
    return res.sendFile(index);
  });

  // ------------------------------------------------------------- errores
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(status).json({ error: err.message || 'Error interno', status });
    void next;
  });

  return app;
}
