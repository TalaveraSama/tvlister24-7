// Bloques publicitarios: disparadores, secuencia de comerciales y registro.
import { hhmmToMinutes, tzParts } from '../time.js';
import { toSequenceItem, matchesFolder } from './resolver.js';

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function adMediaIds(data, block) {
  const ids = [];
  for (const id of block.ads || []) if (id) ids.push(id);
  for (const folderPath of block.folders || []) {
    for (const m of data.media) {
      if (matchesFolder(m, folderPath)) ids.push(m.id);
    }
  }
  return [...new Set(ids)];
}

/** Construye la secuencia: cortina de entrada, comerciales, cortina de salida. */
export function buildAdSequence(data, block, { avoidRepeat = true } = {}) {
  const ids = adMediaIds(data, block);
  let media = ids.map((id) => data.media.find((m) => m.id === id)).filter(Boolean);
  if (!media.length) return { items: [], warnings: ['El bloque no tiene comerciales válidos'] };

  const played = new Set(avoidRepeat ? (block.lastPlayedIds || []) : []);
  let pending = media.filter((m) => !played.has(m.id));
  let repeated = media.filter((m) => played.has(m.id));
  if (block.shuffle !== false) {
    pending = shuffle(pending);
    repeated = shuffle(repeated);
  }
  // Primero los que no se han emitido; después el resto (rotación sin repetición).
  media = [...pending, ...repeated];

  const items = [];
  const bumperIn = data.media.find((m) => m.id === block.bumpers?.inId);
  const bumperOut = data.media.find((m) => m.id === block.bumpers?.outId);
  if (bumperIn) items.push({ ...toSequenceItem(bumperIn, data), kind: 'bumper', role: 'in' });
  for (const m of media) items.push({ ...toSequenceItem(m, data), kind: 'ad', blockId: block.id });
  if (bumperOut) items.push({ ...toSequenceItem(bumperOut, data), kind: 'bumper', role: 'out' });

  return { items, warnings: [] };
}

function sameDayKey(ts, tz) {
  return ts ? tzParts(new Date(ts), tz).dateKey : null;
}

/** ¿Debe dispararse el bloque ahora? */
export function shouldTriggerBlock(data, block, ctx) {
  const { parts, now = Date.now(), mode } = ctx;
  if (!block || block.enabled === false) return false;
  if (!Array.isArray(block.days) || !block.days.includes(parts.dayOfWeek)) return false;
  if (!['automation', 'schedule', 'slate', 'idle'].includes(mode)) return false;

  const dayKey = parts.dateKey;
  const counts = block.dayCounts || {};
  if ((counts[dayKey] || 0) >= (block.maxPerDay || 999)) return false;

  const minGap = (data.settings?.playout?.minAdGapSeconds ?? 120) * 1000;
  if (block.lastRunAt && now - block.lastRunAt < minGap) return false;

  const trigger = block.trigger || { mode: 'clock' };
  if (trigger.mode === 'clock') {
    const target = hhmmToMinutes(trigger.at, -1);
    if (target < 0) return false;
    if (parts.minutes !== target) return false;
    // Evitar doble disparo en el mismo minuto
    if (block.lastFiredKey === `${dayKey}-${target}`) return false;
    return true;
  }
  if (trigger.mode === 'interval') {
    const every = Math.max(1, Number(trigger.everyMinutes) || 30);
    const since = block.lastRunAt || data.runtime.adsBaseline || data.runtime.startedAt || data.meta.createdAt;
    return now - new Date(since).getTime() >= every * 60000;
  }
  if (trigger.mode === 'afterItems') {
    const every = Math.max(1, Number(trigger.everyItems) || 3);
    return (data.runtime.itemsSinceAds || 0) >= every;
  }
  return false;
}

export function markFired(data, block, playedIds = []) {
  const tz = data.settings.app.timezone;
  const dayKey = tzParts(new Date(), tz).dateKey;
  block.lastRunAt = Date.now();
  block.lastFiredKey = block.trigger?.mode === 'clock'
    ? `${dayKey}-${hhmmToMinutes(block.trigger.at, -1)}`
    : block.lastFiredKey;
  block.playCount = (block.playCount || 0) + 1;
  block.dayCounts = block.dayCounts || {};
  block.dayCounts[dayKey] = (block.dayCounts[dayKey] || 0) + 1;
  // Limpieza de contadores antiguos
  const keys = Object.keys(block.dayCounts).sort();
  while (keys.length > 30) {
    delete block.dayCounts[keys.shift()];
  }
  block.lastPlayedIds = [...new Set([...playedIds, ...(block.lastPlayedIds || [])])].slice(0, 50);
  data.runtime.itemsSinceAds = 0;
  void sameDayKey;
}

export function blockSummary(data, block) {
  const tz = data.settings.app.timezone;
  const dayKey = tzParts(new Date(), tz).dateKey;
  const trigger = block.trigger || {};
  let description = 'Manual';
  if (trigger.mode === 'clock') description = `Diario a las ${trigger.at}`;
  else if (trigger.mode === 'interval') description = `Cada ${trigger.everyMinutes || 30} minutos`;
  else if (trigger.mode === 'afterItems') description = `Después de ${trigger.everyItems || 3} temas`;
  return {
    ...block,
    adCount: adMediaIds(data, block).length,
    runsToday: block.dayCounts?.[dayKey] || 0,
    triggerDescription: description,
  };
}
