import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hhmmToMinutes, minutesToHHMM, windowMinutes, formatClock, tzParts, formatDuration, pad2,
} from '../server/time.js';

test('convierte HH:MM a minutos y viceversa', () => {
  assert.equal(hhmmToMinutes('00:00'), 0);
  assert.equal(hhmmToMinutes('06:30'), 390);
  assert.equal(hhmmToMinutes('23:59'), 1439);
  assert.equal(hhmmToMinutes('inválido', 10), 10);
  assert.equal(minutesToHHMM(390), '06:30');
  assert.equal(minutesToHHMM(1439), '23:59');
  assert.equal(minutesToHHMM(-30), '23:30');
});

test('ventanas que cruzan medianoche', () => {
  assert.equal(windowMinutes('06:00', '09:00'), 180);
  assert.equal(windowMinutes('22:00', '02:00'), 240);
});

test('lee las partes de fecha en la zona horaria del canal', () => {
  const parts = tzParts(new Date('2026-01-15T12:00:00Z'), 'America/Managua');
  assert.equal(parts.dateKey, '2026-01-15');
  assert.equal(parts.hour, 6);
  assert.equal(parts.minutes, 360);
  assert.equal(parts.time, '06:00');
  assert.equal(parts.dayOfWeek, 4); // jueves
});

test('formato de reloj 12 y 24 horas', () => {
  assert.equal(formatClock(13, 5, 9, false), '13:05:09');
  assert.equal(formatClock(13, 5, 9, true), '1:05:09 PM');
  assert.equal(formatClock(0, 0, 0, true), '12:00:00 AM');
  assert.equal(formatClock(12, 30, 0, true), '12:30:00 PM');
});

test('duraciones legibles', () => {
  assert.equal(formatDuration(90), '01:30');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(-5), '00:00');
  assert.equal(pad2(3), '03');
});
