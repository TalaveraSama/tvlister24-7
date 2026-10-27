// Utilidades de fecha/hora con soporte de zona horaria (sin dependencias).
const FMT_CACHE = new Map();

function fmt(tz) {
  let f = FMT_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'short',
    });
    FMT_CACHE.set(tz, f);
  }
  return f;
}

const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partes de una fecha en la zona horaria indicada. */
export function tzParts(date = new Date(), tz = 'UTC') {
  const parts = fmt(tz).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  return {
    year, month, day, hour, minute, second,
    dayOfWeek: DAYS[get('weekday')] ?? 0,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutes: hour * 60 + minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

export function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/** "HH:MM" -> minutos desde medianoche */
export function hhmmToMinutes(hhmm, fallback = 0) {
  if (typeof hhmm !== 'string' || !hhmm.includes(':')) return fallback;
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return fallback;
  return Math.min(23, Math.max(0, h)) * 60 + Math.min(59, Math.max(0, m));
}

export function minutesToHHMM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

export function formatClock(hour, minute, second, use12h = false) {
  if (!use12h) return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${pad2(minute)}:${pad2(second)} ${suffix}`;
}

export const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function humanDate(ts, tz = 'UTC') {
  const p = tzParts(new Date(ts), tz);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
}

export function humanDateTime(ts, tz = 'UTC', use12h = false) {
  const d = new Date(ts);
  const p = tzParts(d, tz);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Diferencia en minutos entre dos HH:MM (puede cruzar medianoche). */
export function windowMinutes(start, end) {
  const s = hhmmToMinutes(start);
  let e = hhmmToMinutes(end);
  if (e <= s) e += 1440;
  return e - s;
}
