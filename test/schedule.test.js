import test from 'node:test';
import assert from 'node:assert/strict';
import { isEntryActive, resolveNow, minutesUntilStart, minutesLeft, endTimestamp } from '../server/services/schedule.js';
import { tzParts } from '../server/time.js';
import { defaultData } from '../server/defaults.js';

const utc = (iso) => new Date(iso);

test('detecta bloques activos por día y hora', () => {
  const parts = tzParts(utc('2026-03-02T14:00:00Z'), 'UTC'); // lunes 14:00
  const entry = { days: [1], start: '13:00', end: '15:00', enabled: true };
  assert.equal(isEntryActive(entry, parts), true);
  assert.equal(isEntryActive({ ...entry, days: [2] }, parts), false);
  assert.equal(isEntryActive({ ...entry, enabled: false }, parts), false);
  assert.equal(isEntryActive({ ...entry, start: '15:00', end: '16:00' }, parts), false);
  assert.equal(minutesLeft(entry, parts), 60);
});

test('bloques que cruzan medianoche', () => {
  const late = tzParts(utc('2026-03-02T23:30:00Z'), 'UTC');
  const early = tzParts(utc('2026-03-02T01:30:00Z'), 'UTC');
  const entry = { days: [1, 2], start: '23:00', end: '02:00', enabled: true };
  assert.equal(isEntryActive(entry, late), true);
  assert.equal(isEntryActive(entry, early), true);
});

test('vigencia por fecha de calendario', () => {
  const parts = tzParts(utc('2026-03-02T14:00:00Z'), 'UTC');
  const entry = { days: [1], start: '13:00', end: '15:00', enabled: true, dateFrom: '2026-03-03' };
  assert.equal(isEntryActive(entry, parts), false);
  assert.equal(isEntryActive({ ...entry, dateFrom: '2026-03-01', dateTo: '2026-03-02' }, parts), true);
});

test('prioridad y próximos bloques', () => {
  const data = defaultData();
  data.settings.app.timezone = 'UTC';
  data.grid.entries = [
    { id: 'a', name: 'Baja', days: [1], start: '13:00', end: '15:00', enabled: true, priority: 1 },
    { id: 'b', name: 'Alta', days: [1], start: '13:30', end: '14:30', enabled: true, priority: 9 },
    { id: 'c', name: 'Tarde', days: [1], start: '18:00', end: '20:00', enabled: true, priority: 5 },
  ];
  const now = utc('2026-03-02T14:00:00Z');
  const result = resolveNow(data, now);
  assert.equal(result.current.id, 'b');
  assert.equal(result.upcoming[0].id, 'c');
  assert.equal(result.parts.dateKey, '2026-03-02');
  assert.equal(minutesUntilStart(data.grid.entries[2], result.parts), 240);
});

test('calcula el fin del bloque', () => {
  const parts = tzParts(utc('2026-03-02T14:00:00Z'), 'UTC');
  const end = endTimestamp({ start: '13:00', end: '15:00' }, parts, utc('2026-03-02T14:00:00Z').getTime());
  assert.equal(new Date(end).toISOString(), '2026-03-02T15:00:00.000Z');
});
