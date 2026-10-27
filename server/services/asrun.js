// Registro As-Run: lo que realmente salió al aire.
import { randomUUID } from 'node:crypto';
import { tzParts } from '../time.js';

const MAX_ENTRIES = 5000;

export function addAsRun(data, entry) {
  const row = {
    id: randomUUID(),
    ts: Date.now(),
    endTs: null,
    kind: 'program',
    title: '',
    ...entry,
  };
  data.asrun.push(row);
  if (data.asrun.length > MAX_ENTRIES) data.asrun.splice(0, data.asrun.length - MAX_ENTRIES);
  return row;
}

export function closeAsRun(data, id, patch = {}) {
  const row = data.asrun.find((r) => r.id === id);
  if (!row) return null;
  Object.assign(row, patch, { endTs: patch.endTs ?? Date.now() });
  if (row.ts && row.endTs) row.durationSec = Math.max(0, Math.round((row.endTs - row.ts) / 1000));
  return row;
}

export function queryAsRun(data, { from, to, kind, q, limit = 200, offset = 0 } = {}) {
  let rows = data.asrun;
  if (from) rows = rows.filter((r) => r.ts >= from);
  if (to) rows = rows.filter((r) => r.ts <= to);
  if (kind && kind !== 'all') rows = rows.filter((r) => r.kind === kind);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => `${r.title} ${r.category || ''} ${r.block || ''} ${r.note || ''}`.toLowerCase().includes(needle));
  }
  const total = rows.length;
  rows = [...rows].reverse().slice(offset, offset + limit);
  return { total, rows };
}

const KIND_LABEL = {
  program: 'Programa', ad: 'Publicidad', bumper: 'Cortina',
  live: 'En vivo', emergency: 'Emergencia', slate: 'Slate', record: 'Grabación', system: 'Sistema',
};

export function toCSV(data, rows) {
  const tz = data.settings.app.timezone;
  const head = ['Fecha', 'Hora inicio', 'Hora fin', 'Duración (s)', 'Tipo', 'Título', 'Categoría', 'Bloque', 'Lista', 'Motivo de salida'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(',')];
  for (const r of [...rows].reverse()) {
    const p = tzParts(new Date(r.ts), tz);
    const e = r.endTs ? tzParts(new Date(r.endTs), tz) : null;
    lines.push([
      p.dateKey, p.time, e ? e.time : '', r.durationSec ?? '',
      KIND_LABEL[r.kind] || r.kind, r.title, r.category || '', r.block || '',
      r.playlistName || '', r.exitReason || '',
    ].map(esc).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export { KIND_LABEL };
