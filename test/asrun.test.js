import test from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../server/defaults.js';
import { addAsRun, closeAsRun, queryAsRun, toCSV } from '../server/services/asrun.js';

test('registra, cierra y consulta entradas As-Run', () => {
  const data = demoData();
  data.asrun = [];
  const row = addAsRun(data, { kind: 'program', title: 'Programa A', playlistName: 'Lista 1' });
  closeAsRun(data, row.id, { exitReason: 'fin' });
  const ad = addAsRun(data, { kind: 'ad', title: 'Comercial B', block: 'Bloque 1' });
  assert.equal(data.asrun.length, 2);
  assert.ok(data.asrun[0].endTs);
  const all = queryAsRun(data, { limit: 10 });
  assert.equal(all.total, 2);
  assert.equal(all.rows[0].title, 'Comercial B', 'el más reciente primero');
  const onlyAds = queryAsRun(data, { kind: 'ad' });
  assert.equal(onlyAds.rows.length, 1);
  const search = queryAsRun(data, { q: 'programa a' });
  assert.equal(search.rows.length, 1);
  assert.ok(ad.id);
});

test('limita el tamaño del historial', () => {
  const data = demoData();
  data.asrun = [];
  for (let i = 0; i < 5200; i++) addAsRun(data, { kind: 'program', title: `P${i}` });
  assert.equal(data.asrun.length, 5000);
  assert.equal(data.asrun.at(-1).title, 'P5199');
});

test('exporta CSV con encabezados y sin datos sensibles', () => {
  const data = demoData();
  data.asrun = [];
  addAsRun(data, { kind: 'program', title: 'Con "comillas"', playlistName: 'L' });
  const csv = toCSV(data, data.asrun);
  assert.ok(csv.startsWith('\uFEFF' + '"Fecha"'));
  assert.ok(csv.includes('"Con ""comillas"""'));
  assert.ok(csv.includes('Programa'));
});
