// Grabación automatizada de OBS: ventanas programadas + control manual.
import { randomUUID } from 'node:crypto';
import { tzParts, hhmmToMinutes } from '../time.js';

export function inRecordingWindow(schedule, parts) {
  if (!schedule || schedule.enabled === false) return false;
  if (!Array.isArray(schedule.days) || !schedule.days.includes(parts.dayOfWeek)) return false;
  const start = hhmmToMinutes(schedule.start, 0);
  const end = hhmmToMinutes(schedule.end, 1439);
  if (start === end) return false;
  return start < end
    ? parts.minutes >= start && parts.minutes < end
    : parts.minutes >= start || parts.minutes < end;
}

export function activeSchedule(data, now = new Date()) {
  const parts = tzParts(now, data.settings.app.timezone);
  return (data.recording.schedules || []).find((s) => inRecordingWindow(s, parts)) || null;
}

export function addSession(data, session) {
  const row = { id: randomUUID(), startedAt: Date.now(), endedAt: null, ...session };
  data.recording.sessions.push(row);
  if (data.recording.sessions.length > 500) data.recording.sessions.splice(0, data.recording.sessions.length - 500);
  return row;
}

export function closeSession(data, id, patch = {}) {
  const row = data.recording.sessions.find((s) => s.id === id);
  if (!row) return null;
  Object.assign(row, patch, { endedAt: patch.endedAt ?? Date.now() });
  row.durationSec = Math.round((row.endedAt - row.startedAt) / 1000);
  return row;
}

export function openSession(data) {
  return data.recording.sessions.find((s) => !s.endedAt) || null;
}
