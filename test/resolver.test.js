import test from 'node:test';
import assert from 'node:assert/strict';
import { demoData, defaultData } from '../server/defaults.js';
import { resolvePlaylist, resolveEntry, defaultPlaylistId, sortItems } from '../server/services/resolver.js';

test('resuelve la lista demo incluyendo categorías y slots', () => {
  const data = demoData();
  const main = data.playlists.find((p) => p.name === 'Señal 24/7 Principal');
  const { items } = resolvePlaylist(data, main.id);
  assert.ok(items.length >= 10, `esperaba elementos, obtuve ${items.length}`);
  assert.equal(items[0].slotName, 'Cortinas del canal', 'el File Slot se inserta al inicio');
  assert.ok(items.some((i) => i.slotName === 'Cortinas del canal'), 'incluye el File Slot');
  assert.ok(items.every((i) => i.durationSec > 0));
  assert.ok(items.some((i) => i.category === 'Documentales'));
});

test('los slots rotan y avanzan solo cuando se solicita', () => {
  const data = demoData();
  const slot = data.slots[0];
  const main = data.playlists.find((p) => p.name === 'Señal 24/7 Principal');
  const slotOf = (r) => r.items.find((i) => i.slotId === slot.id);
  const first = slotOf(resolvePlaylist(data, main.id));
  const second = slotOf(resolvePlaylist(data, main.id));
  assert.equal(first.mediaId, second.mediaId, 'sin advanceSlots no cambia el cursor');
  slotOf(resolvePlaylist(data, main.id, { advanceSlots: true }));
  const third = slotOf(resolvePlaylist(data, main.id));
  assert.notEqual(first.mediaId, third.mediaId);
  assert.equal(slot.cursor, 1);
});

test('respeta el orden de la lista y ordena cada bloque', () => {
  const data = demoData();
  const playlist = {
    id: 'orden-test', name: 'Orden', order: 'season', loop: true,
    items: [
      { id: 'i1', type: 'media', mediaId: data.media.find((m) => m.title === 'Cierre Musical').id },
      { id: 'i2', type: 'category', category: 'Documentales' },
      { id: 'i3', type: 'media', mediaId: data.media.find((m) => m.title === 'Amanecer Informativo').id },
      { id: 'i4', type: 'media', mediaId: data.media.find((m) => m.title === 'Cápsula Cultural').id },
    ],
  };
  data.playlists.push(playlist);
  const { items } = resolvePlaylist(data, playlist.id);
  assert.equal(items[0].title, 'Cierre Musical', 'el primer bloque conserva su posición');
  assert.equal(items[1].category, 'Documentales');
  assert.equal(items.at(-2).title, 'Amanecer Informativo', 'los medios consecutivos se ordenan por temporada');
  assert.equal(items.at(-1).title, 'Cápsula Cultural');
});

test('orden alfabético, temporada y aleatorio', () => {
  const items = [
    { title: 'B', season: 2, episode: 1, durationSec: 10 },
    { title: 'A', season: 1, episode: 2, durationSec: 10 },
    { title: 'C', season: 1, episode: 1, durationSec: 10 },
  ];
  assert.deepEqual(sortItems(items, 'alpha').map((i) => i.title), ['A', 'B', 'C']);
  assert.deepEqual(sortItems(items, 'season').map((i) => i.title), ['C', 'A', 'B']);
  assert.equal(sortItems(items, 'random').length, 3);
});

test('resuelve entradas de parrilla por categoría y por lista', () => {
  const data = demoData();
  const cat = resolveEntry(data, { contentType: 'category', category: 'Cine' });
  assert.equal(cat.items.length, 1);
  assert.equal(cat.items[0].title, 'Cine del Recuerdo');
  const playlist = data.playlists.find((p) => p.name === 'Señal 24/7 Principal');
  const byList = resolveEntry(data, { contentType: 'playlist', playlistId: playlist.id });
  assert.ok(byList.items.length > 5);
  const empty = resolveEntry(data, { contentType: 'category', category: 'No existe' });
  assert.equal(empty.items.length, 0);
  assert.match(empty.warnings.join(' '), /vacía/i);
});

test('lista por defecto evita la de emergencia', () => {
  const data = demoData();
  const id = defaultPlaylistId(data);
  assert.notEqual(id, data.emergency.playlistId);
  assert.equal(id, data.runtime.playlistId);
  const empty = defaultData();
  assert.equal(defaultPlaylistId(empty), null);
});
