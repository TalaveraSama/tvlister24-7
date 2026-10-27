// Resolución de la parrilla: qué entrada debe estar al aire ahora.
import { tzParts, hhmmToMinutes, minutesToHHMM, windowMinutes, DAY_SHORT } from '../time.js';

export function entryWindow(entry) {
  const start = hhmmToMinutes(entry.start, 0);
  const end = hhmmToMinutes(entry.end, 1439);
  return { start, end, length: windowMinutes(entry.start, entry.end) };
}

export function isEntryActive(entry, parts) {
  if (!entry || entry.enabled === false) return false;
  // Vigencia por fecha (opcional): la parrilla puede servir solo en un rango de calendario.
  if (entry.dateFrom && parts.dateKey < entry.dateFrom) return false;
  if (entry.dateTo && parts.dateKey > entry.dateTo) return false;
  if (!Array.isArray(entry.days) || !entry.days.includes(parts.dayOfWeek)) return false;
  const { start, end } = entryWindow(entry);
  const nowM = parts.minutes;
  if (start === end) return false;
  if (start < end) return nowM >= start && nowM < end;
  // Cruza medianoche
  return nowM >= start || nowM < end;
}

/** Minutos restantes hasta el final de la ventana (0 si ya terminó). */
export function minutesLeft(entry, parts) {
  const end = hhmmToMinutes(entry.end, 1439);
  let left = end - parts.minutes;
  if (left < 0) left += 1440;
  return left;
}

export function endTimestamp(entry, parts, ref = Date.now()) {
  const left = minutesLeft(entry, parts);
  return ref + left * 60000;
}

/**
 * Devuelve la entrada activa de mayor prioridad y, opcionalmente, la siguiente.
 */
export function resolveNow(data, now = new Date()) {
  const tz = data.settings.app.timezone;
  const parts = tzParts(now, tz);
  const entries = (data.grid.entries || []).filter((e) => e.enabled !== false);
  const active = entries
    .filter((e) => isEntryActive(e, parts))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const upcoming = entries
    .map((e) => ({ entry: e, delta: minutesUntilStart(e, parts) }))
    .filter((x) => x.delta > 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 5);
  return {
    parts,
    current: active[0] || null,
    activeEntries: active,
    upcoming: upcoming.map((u) => ({ ...u.entry, startsInMinutes: u.delta, startTime: u.entry.start })),
  };
}

export function minutesUntilStart(entry, parts) {
  if (!Array.isArray(entry.days) || !entry.days.length) return 10080;
  const start = hhmmToMinutes(entry.start, 0);
  for (let d = 0; d < 8; d++) {
    const day = (parts.dayOfWeek + d) % 7;
    if (!entry.days.includes(day)) continue;
    let delta = start - parts.minutes;
    if (d === 0 && delta <= 0) continue;
    if (d > 0) delta += d * 1440;
    return delta;
  }
  return 10080;
}

export function dayLabel(days = []) {
  if (days.length === 7) return 'Todos los días';
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(',') === '1,2,3,4,5') return 'Lunes a viernes';
  if (sorted.join(',') === '6,0' || sorted.join(',') === '0,6') return 'Fin de semana';
  return sorted.map((d) => DAY_SHORT[d]).join(' ');
}

/** Divide una ventana en segmentos según la duración de los elementos (previsualización de parrilla). */
export function previewSegments(items, entry, maxSegments = 12) {
  const { length } = entryWindow(entry);
  let remaining = length * 60;
  const segments = [];
  let cursor = hhmmToMinutes(entry.start, 0);
  for (const item of items) {
    if (remaining <= 0) break;
    if (segments.length >= maxSegments) break;
    const dur = Math.min(item.durationSec, remaining);
    segments.push({
      title: item.title,
      start: minutesToHHMM(cursor),
      end: minutesToHHMM(cursor + Math.ceil(dur / 60)),
      durationSec: dur,
    });
    cursor += Math.ceil(dur / 60);
    remaining -= dur;
  }
  return segments;
}
