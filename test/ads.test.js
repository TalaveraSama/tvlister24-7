import test from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../server/defaults.js';
import { buildAdSequence, shouldTriggerBlock, markFired, adMediaIds } from '../server/services/ads.js';
import { tzParts } from '../server/time.js';

function ctxFor(data, iso) {
  return {
    parts: tzParts(new Date(iso), data.settings.app.timezone),
    now: new Date(iso).getTime(),
    mode: 'automation',
  };
}

test('la secuencia incluye cortinas de entrada y salida', () => {
  const data = demoData();
  data.settings.app.timezone = 'UTC';
  const block = data.adBlocks[0];
  const { items } = buildAdSequence(data, block);
  assert.equal(items[0].kind, 'bumper');
  assert.equal(items[0].role, 'in');
  assert.equal(items.at(-1).kind, 'bumper');
  assert.equal(items.at(-1).role, 'out');
  assert.ok(items.filter((i) => i.kind === 'ad').length === block.ads.length);
});

test('dispara a una hora exacta una sola vez al día', () => {
  const data = demoData();
  data.settings.app.timezone = 'UTC';
  data.settings.playout.minAdGapSeconds = 0;
  const block = data.adBlocks[1];
  block.trigger = { mode: 'clock', at: '21:00' };
  block.lastRunAt = null;
  block.lastFiredKey = null;
  const ctx = ctxFor(data, '2026-03-02T21:00:20Z');
  assert.equal(shouldTriggerBlock(data, block, ctx), true);
  markFired(data, block, []);
  assert.equal(shouldTriggerBlock(data, block, ctx), false);
  // Otro minuto distinto no dispara el bloque de las 21:00
  assert.equal(shouldTriggerBlock(data, block, ctxFor(data, '2026-03-02T21:01:20Z')), false);
});

test('respeta días, máximo diario y separación mínima', () => {
  const data = demoData();
  data.settings.app.timezone = 'UTC';
  const block = data.adBlocks[0];
  block.trigger = { mode: 'interval', everyMinutes: 10 };
  block.lastRunAt = null;
  block.days = [2]; // martes
  const ctx = ctxFor(data, '2026-03-03T12:00:00Z'); // martes
  data.runtime.startedAt = ctx.now - 60 * 60000;
  data.settings.playout.minAdGapSeconds = 0;
  assert.equal(shouldTriggerBlock(data, block, ctx), true);
  markFired(data, block, []);
  assert.equal(shouldTriggerBlock(data, block, ctx), false, 'se respeta la separación mínima');
  block.days = [3];
  assert.equal(shouldTriggerBlock(data, block, ctx), false, 'día no habilitado');
});

test('dispara por cantidad de temas', () => {
  const data = demoData();
  const block = data.adBlocks[0];
  block.trigger = { mode: 'afterItems', everyItems: 3 };
  block.lastRunAt = null;
  data.runtime.itemsSinceAds = 2;
  const ctx = ctxFor(data, '2026-03-03T12:00:00Z');
  block.days = [0, 1, 2, 3, 4, 5, 6];
  assert.equal(shouldTriggerBlock(data, block, ctx), false);
  data.runtime.itemsSinceAds = 3;
  assert.equal(shouldTriggerBlock(data, block, ctx), true);
  markFired(data, block, []);
  assert.equal(data.runtime.itemsSinceAds, 0);
});

test('las carpetas suman anuncios y se evitan repeticiones', () => {
  const data = demoData();
  data.settings.app.timezone = 'UTC';
  const block = data.adBlocks[0];
  const firstAd = data.media.find((m) => m.id === block.ads[0]);
  block.folders = ['/tmp/proca-ads'];
  data.media.push({
    id: 'extra-1', title: 'Comercial extra', path: '/tmp/proca-ads/x.mp4',
    duration: 20, category: 'Publicidad', folderPath: '/tmp/proca-ads',
  });
  data.media.push({
    id: 'extra-2', title: 'Comercial suelto', path: '/tmp/proca-ads/sub/y.mp4',
    duration: 20, category: 'Publicidad',
  });
  const ids = adMediaIds(data, block);
  assert.ok(ids.includes('extra-1'));
  assert.ok(ids.includes('extra-2'), 'detecta archivos dentro de subcarpetas');
  block.lastPlayedIds = [firstAd.id];
  const { items } = buildAdSequence(data, block);
  const firstCommercial = items.find((i) => i.kind === 'ad');
  assert.notEqual(firstCommercial.mediaId, firstAd.id, 'no repite el último anuncio');
});
