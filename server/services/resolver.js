// Resuelve listas de reproducción, categorías y carpetas en una secuencia
// concreta de medios, aplicando el orden elegido.
import { randomUUID } from 'node:crypto';

export function mediaMap(data) {
  const map = new Map();
  for (const m of data.media) map.set(m.id, m);
  return map;
}

export function durationOf(media, fallback = 60) {
  const d = Number(media?.duration);
  if (Number.isFinite(d) && d > 0) return d;
  return fallback;
}

export function toSequenceItem(media, data) {
  return {
    key: randomUUID(),
    mediaId: media.id,
    title: media.title || media.name || 'Sin título',
    filePath: media.path,
    durationSec: durationOf(media, data.settings?.playout?.defaultDurationSec ?? 60),
    category: media.category || '',
    genre: media.genre || '',
    season: media.season ?? null,
    episode: media.episode ?? null,
    kind: media.kind || 'video',
    demo: !!media.demo,
    visual: media.visual || null,
    folder: media.folderPath || media.folder || '',
  };
}

export function sortItems(items, order = 'manual', warnings = []) {
  const out = [...items];
  if (order === 'alpha') {
    out.sort((a, b) => String(a.title).localeCompare(String(b.title), 'es'));
  } else if (order === 'random') {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  } else if (order === 'season') {
    out.sort((a, b) => {
      const sa = a.season ?? 9999;
      const sb = b.season ?? 9999;
      if (sa !== sb) return sa - sb;
      const ea = a.episode ?? 9999;
      const eb = b.episode ?? 9999;
      if (ea !== eb) return ea - eb;
      return String(a.title).localeCompare(String(b.title), 'es');
    });
  } else if (order === 'episode') {
    out.sort((a, b) => (a.episode ?? 9999) - (b.episode ?? 9999));
  }
  if (warnings) {
    const seen = new Set();
    for (const it of out) {
      if (seen.has(it.mediaId + it.filePath)) warnings.push(`Elemento duplicado: ${it.title}`);
      seen.add(it.mediaId + it.filePath);
    }
  }
  return out;
}

/** ¿El medio pertenece a la carpeta indicada? */
export function matchesFolder(media, folderPath) {
  const f = String(folderPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!f) return false;
  const inFolder = String(media.folderPath || media.folder || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const filePath = String(media.path || '').replace(/\\/g, '/').toLowerCase();
  if (inFolder && (inFolder === f || inFolder.startsWith(f + '/'))) return true;
  return filePath.startsWith(f + '/');
}

function byFolder(media, folderPath) {
  return media.filter((m) => matchesFolder(m, folderPath));
}

function byCategory(media, category) {
  if (!category) return [];
  const c = String(category).toLowerCase();
  return media.filter((m) => String(m.category || '').toLowerCase() === c);
}

/**
 * Resuelve una lista de reproducción en elementos reproducibles.
 * Soporta items de tipo: media, folder, category, playlist (anidada).
 */
export function resolvePlaylist(data, playlistId, { depth = 0, warnings = [], advanceSlots = false } = {}) {
  const playlist = data.playlists.find((p) => p.id === playlistId);
  if (!playlist) return { playlist: null, items: [] };
  if (depth > 3) return { playlist, items: [] };

  const order = playlist.order || 'manual';
  const items = [];
  let run = [];
  const flushRun = () => {
    // Los medios individuales consecutivos se ordenan según la preferencia de la lista.
    if (run.length) items.push(...sortItems(run, order));
    run = [];
  };

  for (const entry of playlist.items || []) {
    if (entry.type === 'media') {
      const m = data.media.find((x) => x.id === entry.mediaId);
      if (m) run.push(toSequenceItem(m, data));
      else warnings.push(`Medio no encontrado en "${playlist.name}"`);
    } else if (entry.type === 'category') {
      flushRun();
      const list = byCategory(data.media, entry.category);
      if (!list.length) warnings.push(`Categoría vacía: ${entry.category}`);
      items.push(...sortItems(list.map((m) => toSequenceItem(m, data)), order));
    } else if (entry.type === 'folder') {
      flushRun();
      const list = byFolder(data.media, entry.folderPath || entry.path);
      if (!list.length) warnings.push(`Carpeta vacía: ${entry.folderPath || entry.path}`);
      items.push(...sortItems(list.map((m) => toSequenceItem(m, data)), order));
    } else if (entry.type === 'playlist') {
      flushRun();
      const nested = resolvePlaylist(data, entry.playlistId, { depth: depth + 1, warnings, advanceSlots });
      items.push(...nested.items);
    } else if (entry.type === 'slot') {
      // Los File Slots se insertan en su posición exacta dentro de la lista.
      flushRun();
      const slot = (data.slots || []).find((x) => x.id === entry.slotId);
      const pool = (slot?.mediaIds || [])
        .map((mid) => data.media.find((m) => m.id === mid))
        .filter(Boolean);
      if (!pool.length) {
        warnings.push(`Slot sin archivos: ${slot?.name || 'slot eliminado'}`);
      } else {
        const cursor = Number(slot.cursor || 0) % pool.length;
        items.push({ ...toSequenceItem(pool[cursor], data), slotId: slot.id, slotName: slot.name });
        if (advanceSlots) slot.cursor = (cursor + 1) % pool.length;
      }
    } else if (entry.type === 'live') {
      warnings.push(`El elemento en vivo se ignora dentro de la lista "${playlist.name}"`);
    }
  }
  flushRun();

  // Avisos de duraciones inválidas
  const valid = items.filter((it) => it.durationSec >= 1);
  if (valid.length !== items.length) warnings.push(`Se ignoraron ${items.length - valid.length} elementos sin duración válida`);
  return { playlist, items: valid };
}

/** Resuelve una entrada de parrilla en elementos reproducibles. */
export function resolveEntry(data, entry, { advanceSlots = false, warnings = [] } = {}) {
  if (!entry) return { items: [], warnings };
  if (entry.contentType === 'playlist') {
    const { items } = resolvePlaylist(data, entry.playlistId, { warnings, advanceSlots });
    return { items, warnings };
  }
  if (entry.contentType === 'category') {
    const list = byCategory(data.media, entry.category);
    if (!list.length) warnings.push(`Categoría vacía: ${entry.category}`);
    return { items: sortItems(list.map((m) => toSequenceItem(m, data)), entry.order || 'manual'), warnings };
  }
  if (entry.contentType === 'folder') {
    const list = byFolder(data.media, entry.folderPath);
    if (!list.length) warnings.push(`Carpeta vacía: ${entry.folderPath}`);
    return { items: sortItems(list.map((m) => toSequenceItem(m, data)), entry.order || 'manual'), warnings };
  }
  if (entry.contentType === 'media') {
    const m = data.media.find((x) => x.id === entry.mediaId);
    return { items: m ? [toSequenceItem(m, data)] : [], warnings };
  }
  return { items: [], warnings: ['Tipo de contenido no reproducible (en vivo usa el módulo de intervención)'] };
}

/** Lista de reproducción por defecto del canal 24/7. */
export function defaultPlaylistId(data) {
  const byId = data.playlists.find((p) => p.id === data.runtime.playlistId);
  if (byId) return byId.id;
  const first = data.playlists.find((p) => p.id !== data.emergency.playlistId);
  return first?.id || data.playlists[0]?.id || null;
}
