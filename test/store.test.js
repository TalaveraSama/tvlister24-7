import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, deepMerge, mergeInto } from '../server/store.js';
import { defaultData, demoData } from '../server/defaults.js';

test('mezcla profunda sin perder valores por defecto', () => {
  const base = { a: 1, b: { c: 2, d: 3 }, list: [1, 2] };
  const merged = deepMerge(base, { b: { d: 9 }, list: [5] });
  assert.deepEqual(merged, { a: 1, b: { c: 2, d: 9 }, list: [5] });
  const target = { obs: { host: 'x', port: 1 } };
  mergeInto(target, { obs: { port: 2 } });
  assert.deepEqual(target, { obs: { host: 'x', port: 2 } });
});

test('guarda y recupera la base en disco', () => {
  const file = path.join(os.tmpdir(), `proca-store-${Date.now()}.json`);
  const store = new Store(file, () => defaultData());
  store.data.settings.app.channelName = 'Prueba';
  store.data.playlists.push({ id: 'p1', name: 'Uno', items: [] });
  store.saveNow();
  const again = new Store(file, () => defaultData());
  assert.equal(again.data.settings.app.channelName, 'Prueba');
  assert.equal(again.data.playlists.length, 1);
  fs.rmSync(file, { force: true });
});

test('los datos demo incluyen todo lo necesario para operar', () => {
  const data = demoData();
  assert.ok(data.media.length > 10);
  assert.ok(data.playlists.length >= 3);
  assert.ok(data.grid.entries.length >= 4);
  assert.ok(data.adBlocks.length >= 2);
  assert.ok(data.slots.length >= 1);
  assert.ok(data.emergency.playlistId);
  assert.equal(data.settings.obs.driver, 'mock');
  const ids = new Set(data.media.map((m) => m.id));
  for (const block of data.adBlocks) {
    for (const id of block.ads) assert.ok(ids.has(id));
  }
});
