// Núcleo de automatización 24/7: decide qué debe estar al aire, controla OBS,
// publicidad, gráficos, grabación, emergencias e intervenciones en vivo.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tzParts, hhmmToMinutes } from './time.js';
import { resolvePlaylist, resolveEntry, defaultPlaylistId, toSequenceItem, matchesFolder } from './services/resolver.js';
import { resolveNow, endTimestamp, minutesLeft } from './services/schedule.js';
import { buildAdSequence, shouldTriggerBlock, markFired } from './services/ads.js';
import { buildOverlay, applyGraphics } from './services/graphics.js';
import { activeSchedule, addSession, closeSession, openSession } from './services/recorder.js';
import { addAsRun, closeAsRun } from './services/asrun.js';

const TICK_MS = 1000;

export class Engine extends EventEmitter {
  constructor({ store, obs, logger = console }) {
    super();
    this.store = store;
    this.obs = obs;
    this.log = logger;
    this._busy = false;
    this._timer = null;
    this._openAsRun = null;
    this._openAdRows = [];
    this._wd = { cursor: -1, cursorAt: 0, silentSince: null, noProgressSince: null };
    this._lastGraphicsAt = 0;
    this._lastSnapAt = 0;
    this._pendingSchedule = null;
    this.obs.on('disconnected', () => {
      this.log.warn('[engine] OBS desconectado, la automatización sigue en espera');
      this.broadcast();
    });
    this.obs.on('connected', () => {
      this._applyStateAfterReconnect().catch((e) => this.log.warn(e.message));
    });
  }

  get data() {
    return this.store.data;
  }

  get rt() {
    return this.store.data.runtime;
  }

  get now() {
    return Date.now();
  }

  // ---------------------------------------------------------------- ciclo
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch((err) => this.log.error('[engine] tick error:', err));
    }, TICK_MS);
    this._timer.unref?.();
    this.resumeOnBoot().catch((err) => this.log.error('[engine] arranque:', err));
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async resumeOnBoot() {
    const rt = this.rt;
    const playout = this.data.settings.playout;
    if (rt.mode === 'ads') this._restoreReturnPoint(rt.ads?.returnTo, { reason: 'reinicio' });
    rt.mode = rt.mode === 'ads' ? 'automation' : rt.mode;
    rt.ads = null;

    if (!playout.resumeOnStart) {
      await this.startAutomation({ reason: 'inicio sin reanudación' });
      return;
    }

    if (rt.mode === 'live') {
      // Una intervención no se reanuda sola: se devuelve el control al sistema.
      rt.live = null;
      rt.mode = 'automation';
    }

    if (rt.items?.length && ['automation', 'emergency', 'manual'].includes(rt.mode)) {
      const idx = Math.min(Math.max(0, rt.index || 0), rt.items.length - 1);
      const elapsed = this._elapsedMs();
      const item = rt.items[idx];
      if (elapsed >= item.durationSec * 1000) {
        // El contenido terminó mientras la app estaba cerrada: continuar con el siguiente.
        await this.playListAt(idx + 1, 0, { reason: 'reanudación tras cierre' });
      } else {
        await this.playListAt(idx, elapsed / 1000, { reason: 'reanudación tras cierre', paused: rt.paused });
      }
      this.log.info(`[engine] automatización reanudada en el elemento ${idx + 1}/${rt.items.length}`);
    } else {
      await this.ensureOnAir('arranque');
    }
  }

  async ensureOnAir(reason = 'sin señal') {
    if (this.rt.holdSlate) return;
    const schedule = resolveNow(this.data);
    if (schedule.current) {
      await this.activateScheduleEntry(schedule.current, { reason: `arranque: ${reason}` });
      return;
    }
    await this.startAutomation({ reason });
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const now = new Date();
      await this.checkLive(now);
      await this.checkSchedule(now);
      await this.checkAds(now);
      await this.checkItemProgress();
      await this.checkEmergency();
      await this.checkRecording(now);
      await this.refreshGraphics();
      this.maybeBroadcast();
    } finally {
      this._busy = false;
    }
  }

  // ------------------------------------------------------- utilidades de tiempo
  _elapsedMs() {
    const rt = this.rt;
    const ref = rt.paused && rt.pausedAt ? rt.pausedAt : this.now;
    return Math.max(0, ref - (rt.itemStartedAt || this.now));
  }

  _currentItem() {
    const rt = this.rt;
    return rt.items?.[rt.index] || null;
  }

  _nextItem() {
    const rt = this.rt;
    if (!rt.items?.length) return null;
    if (rt.index + 1 < rt.items.length) return rt.items[rt.index + 1];
    return rt.items[0];
  }

  _persist() {
    this.store.save();
  }

  broadcast() {
    this.emit('change');
  }

  maybeBroadcast() {
    const now = this.now;
    if (now - this._lastSnapAt < 900) return;
    this._lastSnapAt = now;
    this.broadcast();
  }

  // --------------------------------------------------------------- arranques
  async startAutomation({ reason = 'manual', playlistId = null, paused = false, operator = false } = {}) {
    this.rt.holdSlate = false;
    if (operator) this._setOverride();
    const id = playlistId || defaultPlaylistId(this.data);
    const { playlist, items } = resolvePlaylist(this.data, id, { advanceSlots: true });
    if (!playlist) {
      return this.enterSlate(`Lista no encontrada (${reason})`);
    }
    if (!items.length) {
      return this.enterSlate(`La lista "${playlist.name}" no tiene contenido`);
    }
    const rt = this.rt;
    rt.mode = 'automation';
    rt.sourceType = 'automation';
    rt.playlistId = playlist.id;
    rt.sourceName = playlist.name;
    rt.scheduleEntryId = null;
    rt.scheduleEndAt = null;
    rt.oneShot = null;
    await this.playListAt(0, 0, { reason, playlist, items, paused });
    this.log.info(`[engine] automatización: ${playlist.name} (${items.length} elementos) — ${reason}`);
  }

  async startPlaylist(playlistId, { index = 0, offsetSec = 0, reason = 'cambio de lista', paused = false } = {}) {
    const { playlist, items } = resolvePlaylist(this.data, playlistId, { advanceSlots: true });
    this.rt.holdSlate = false;
    if (!playlist) throw new Error('Lista no encontrada');
    if (!items.length) throw new Error(`La lista "${playlist.name}" está vacía`);
    const rt = this.rt;
    if (rt.mode === 'ads') throw new Error('Hay publicidad al aire, intente de nuevo en unos segundos');
    rt.mode = 'automation';
    rt.sourceType = 'automation';
    rt.playlistId = playlist.id;
    rt.sourceName = playlist.name;
    rt.scheduleEntryId = null;
    rt.scheduleEndAt = null;
    rt.oneShot = null;
    this._setOverride();
    await this.playListAt(index, offsetSec, { reason, playlist, items, paused });
  }

  /** El operador tomó el control: la parrilla no reemplaza su elección hasta el próximo bloque. */
  _setOverride() {
    const current = resolveNow(this.data).current;
    this.rt.manualOverride = { entryId: current?.id || null, at: this.now };
  }

  /** Carga una secuencia en OBS y comienza desde el índice indicado. */
  async playListAt(index, offsetSec, opts = {}) {
    const rt = this.rt;
    const items = opts.items || rt.items;
    if (!items?.length) return this.enterSlate(opts.reason || 'sin contenido');
    const safeIndex = ((index % items.length) + items.length) % items.length;
    rt.items = items;
    rt.index = safeIndex;
    rt.paused = !!opts.paused;
    rt.pausedAt = opts.paused ? this.now : null;
    rt.itemStartedAt = this.now - Math.max(0, offsetSec) * 1000;
    rt.itemOffsetMs = Math.max(0, offsetSec) * 1000;
    rt.lastAdvanceAt = this.now;
    rt.startedAt = rt.startedAt || this.now;
    if (opts.playlist) {
      rt.playlistId = opts.playlist.id;
      rt.sourceName = opts.playlist.name;
      rt.source = opts.playlist.name;
    }
    await this._startItem({ reason: opts.reason || 'inicio', resetSequence: !!opts.resetSequence });
    this._persist();
    this.broadcast();
  }

  async _startItem({ reason = '', offsetSec = null, resetSequence = false } = {}) {
    const rt = this.rt;
    const item = this._currentItem();
    if (!item) {
      return this.enterSlate('lista sin elementos');
    }
    if (offsetSec !== null) {
      rt.itemStartedAt = this.now - Math.max(0, offsetSec) * 1000;
      rt.itemOffsetMs = Math.max(0, offsetSec) * 1000;
    }
    rt.lastAdvanceAt = this.now;

    const startMs = Math.max(0, rt.itemStartedAt ? this.now - rt.itemStartedAt : 0);
    const sequence = rt.items.map((it) => ({
      filePath: it.filePath,
      title: it.title,
      durationMs: Math.round(it.durationSec * 1000),
    }));

    try {
      await this.obs.loadMedia({
        filePath: item.filePath,
        startMs,
        paused: rt.paused,
        durationMs: Math.round(item.durationSec * 1000),
        playlist: sequence,
        index: rt.index,
        forceReload: resetSequence,
      });
      rt.obsError = null;
    } catch (err) {
      rt.obsError = err.message;
      this.log.warn(`[engine] no se pudo cargar en OBS: ${err.message}`);
    }

    this._closeOpenItem(`cambia a: ${item.title}${reason ? ` (${reason})` : ''}`);
    this._openItem(item, reason);
    this.emit('item', item);
    this._persist();
  }

  _kindForItem(item) {
    const rt = this.rt;
    if (item.kind === 'bumper') return 'bumper';
    if (item.kind === 'ad') return 'ad';
    if (rt.mode === 'emergency') return 'emergency';
    if (rt.mode === 'manual') return 'program';
    return 'program';
  }

  _openItem(item, reason) {
    const rt = this.rt;
    const block = rt.mode === 'ads' ? this.data.adBlocks.find((b) => b.id === rt.ads?.blockId) : null;
    this._openAsRun = addAsRun(this.data, {
      kind: this._kindForItem(item),
      title: item.title,
      mediaId: item.mediaId,
      path: item.filePath,
      category: item.category,
      playlistId: rt.playlistId,
      playlistName: rt.sourceName,
      block: block?.name || (rt.mode === 'emergency' ? 'Emergencia' : ''),
      blockId: block?.id || null,
      entryId: rt.scheduleEntryId || null,
      mode: rt.mode,
      note: reason || '',
    });
  }

  _closeOpenItem(exitReason) {
    if (!this._openAsRun) return;
    closeAsRun(this.data, this._openAsRun.id, { exitReason });
    this._openAsRun = null;
  }

  // ------------------------------------------------------------- avance
  async checkItemProgress() {
    const rt = this.rt;
    if (!rt.items?.length) {
      if (rt.mode !== 'slate') await this.ensureOnAir('sin elementos en memoria');
      return;
    }
    if (rt.paused) return;
    const item = this._currentItem();
    if (!item) return;
    const elapsed = this._elapsedMs();
    // Sin duración real, no se puede avanzar por tiempo.
    if (!(item.durationSec > 0)) return;
    if (elapsed >= item.durationSec * 1000) {
      await this._advance('fin de contenido');
    }
  }

  async _advance(reason = 'siguiente') {
    const rt = this.rt;
    const atEnd = rt.index + 1 >= rt.items.length;

    if (rt.mode === 'ads') {
      if (atEnd) return this._finishAds('fin del bloque');
      rt.index += 1;
      rt.itemStartedAt = this.now;
      rt.itemOffsetMs = 0;
      await this._startItem({ reason });
      return;
    }

    if (rt.mode === 'manual' && rt.oneShot) {
      if (atEnd) return this._restoreOneShot();
    }

    if (rt.mode === 'schedule') {
      const entry = this.data.grid.entries.find((e) => e.id === rt.scheduleEntryId);
      if (entry && entry.endMode === 'afterLast' && this._scheduleEnded(entry)) {
        return this._leaveSchedule(entry, 'fin de bloque (después del último video)');
      }
      if (atEnd && entry && entry.endMode === 'exact' && this._scheduleEnded(entry)) {
        return this._leaveSchedule(entry, 'fin de bloque por horario');
      }
    }

    if (atEnd) {
      const playlist = this.data.playlists.find((p) => p.id === rt.playlistId);
      const shouldLoop = rt.mode === 'emergency' || rt.mode === 'ads' ? true : playlist?.loop !== false;
      const nextIndex = shouldLoop ? 0 : null;
      if (nextIndex === null) {
        return this.enterSlate('lista finalizada (sin ciclo)');
      }
      rt.index = 0;
      rt.itemsSinceAds = (rt.itemsSinceAds || 0) + 1;
      rt.itemStartedAt = this.now;
      rt.itemOffsetMs = 0;
      await this._startItem({ reason: `${reason} · ciclo reiniciado` });
      return;
    }

    rt.index += 1;
    rt.itemsSinceAds = (rt.itemsSinceAds || 0) + 1;
    rt.itemStartedAt = this.now;
    rt.itemOffsetMs = 0;
    await this._startItem({ reason });
  }

  async next() {
    if (this.rt.mode === 'ads') return this._advance('manual: siguiente');
    await this._advance('manual: siguiente');
  }

  async previous() {
    const rt = this.rt;
    if (!rt.items?.length) return;
    if (rt.mode === 'ads') throw new Error('No se puede retroceder durante publicidad');
    rt.index = (rt.index - 1 + rt.items.length) % rt.items.length;
    await this.playListAt(rt.index, 0, { reason: 'manual: anterior' });
  }

  async goto(index, offsetSec = 0) {
    const rt = this.rt;
    if (!rt.items?.length) throw new Error('No hay contenido cargado');
    const i = Math.max(0, Math.min(rt.items.length - 1, Number(index) || 0));
    rt.index = i;
    await this.playListAt(i, offsetSec, { reason: 'manual: ir a elemento' });
  }

  async pause() {
    const rt = this.rt;
    if (rt.paused) return;
    rt.paused = true;
    rt.pausedAt = this.now;
    try { await this.obs.mediaAction('pause'); } catch (err) { this.log.warn(`[engine] pausa: ${err.message}`); }
    this._closeOpenItem('pausa del operador');
    this._persist();
    this.broadcast();
  }

  async resume() {
    const rt = this.rt;
    if (!rt.paused) return;
    if (rt.pausedAt) rt.itemStartedAt += this.now - rt.pausedAt;
    rt.paused = false;
    rt.pausedAt = null;
    try { await this.obs.mediaAction('play'); } catch (err) { this.log.warn(`[engine] reanudar: ${err.message}`); }
    if (this._currentItem()) this._openItem(this._currentItem(), 'continuación');
    this._persist();
    this.broadcast();
  }

  async stopPlayout() {
    this._closeOpenItem('detenido por el operador');
    this.rt.paused = false;
    this.rt.items = [];
    this.rt.index = 0;
    this.rt.holdSlate = true;
    await this.enterSlate('detenido por el operador');
  }

  // --------------------------------------------------------- enviar al aire
  async airMedia(mediaId, { reason = 'enviado al aire' } = {}) {
    const rt = this.rt;
    const media = this.data.media.find((m) => m.id === mediaId);
    if (!media) throw new Error('Medio no encontrado');
    if (rt.mode === 'ads') throw new Error('Hay publicidad al aire, espere a que termine');
    const returnTo = this._captureReturnPoint();
    const item = toSequenceItem(media, this.data);
    rt.holdSlate = false;
    rt.mode = 'manual';
    rt.sourceType = 'manual';
    rt.sourceName = media.title || media.name;
    rt.oneShot = { returnTo, mediaId };
    this._setOverride();
    rt.items = [item];
    rt.index = 0;
    rt.paused = false;
    rt.itemStartedAt = this.now;
    rt.itemOffsetMs = 0;
    await this._startItem({ reason });
    this.broadcast();
    return item;
  }

  async _restoreOneShot() {
    const rt = this.rt;
    const back = rt.oneShot?.returnTo;
    rt.oneShot = null;
    if (!back) return this.startAutomation({ reason: 'fin de envío al aire' });
    await this._restoreReturnPoint(back, { reason: 'fin de envío al aire' });
  }

  // ------------------------------------------------------------- parrilla
  _scheduleEnded(entry) {
    const parts = tzParts(new Date(), this.data.settings.app.timezone);
    const left = minutesLeft(entry, parts);
    const start = hhmmToMinutes(entry.start, 0);
    const end = hhmmToMinutes(entry.end, 1439);
    if (start < end) return parts.minutes >= end;
    return left <= 0 && parts.minutes >= end && parts.minutes < start;
  }

  async checkSchedule() {
    const rt = this.rt;
    if (rt.holdSlate) return;
    const { current } = resolveNow(this.data);
    const nowTs = this.now;

    // Intervención en vivo o publicidad: la parrilla espera.
    if (rt.mode === 'live' || rt.mode === 'ads' || rt.mode === 'emergency') {
      if (current && rt.scheduleEntryId !== current.id) this._pendingSchedule = current.id;
      return;
    }

    if (!current) {
      if (rt.mode === 'schedule') {
        const entry = this.data.grid.entries.find((e) => e.id === rt.scheduleEntryId);
        if (entry) {
          if (entry.endMode === 'afterLast' && rt.items?.length && rt.index < rt.items.length - 1) {
            // Deja terminar el contenido actual
          } else {
            await this._leaveSchedule(entry, entry.endMode === 'afterLast'
              ? 'fin de bloque después del último video'
              : 'fin de bloque por horario');
          }
        } else {
          await this.startAutomation({ reason: 'parrilla sin bloque activo' });
        }
      } else if (rt.mode === 'idle') {
        await this.startAutomation({ reason: 'sin bloque en parrilla' });
      }
      return;
    }

    if ((rt.mode === 'automation' || rt.mode === 'manual') && rt.manualOverride) {
      if (rt.manualOverride.entryId === current.id) return; // control manual vigente
      rt.manualOverride = null;
    }

    if (rt.mode === 'schedule' && rt.scheduleEntryId === current.id) {
      if (current.endMode === 'exact' && this._scheduleEnded(current)) {
        await this._leaveSchedule(current, 'hora de finalización alcanzada');
      }
      return;
    }

    if (rt.mode === 'schedule' && rt.scheduleEntryId !== current.id) {
      // Cambio directo entre bloques contiguos (sin pasar por la lista 24/7).
      rt.scheduleEntryId = null;
    }

    await this.activateScheduleEntry(current, { reason: 'entrada de parrilla' });
    void nowTs;
  }

  async activateScheduleEntry(entry, { reason = 'parrilla' } = {}) {
    const rt = this.rt;
    if (!entry) return;
    rt.manualOverride = null;
    rt.holdSlate = false;

    if (entry.contentType === 'live') {
      if (rt.mode === 'live') return;
      await this.startLive({
        sourceName: entry.live?.sourceName || '',
        sceneName: entry.live?.sceneName || '',
        label: entry.name,
        endAt: endTimestamp(entry, tzParts(new Date(), this.data.settings.app.timezone)),
        reason: `parrilla: ${entry.name}`,
        entryId: entry.id,
      });
      return;
    }

    const { items, warnings } = resolveEntry(this.data, entry, { advanceSlots: true });
    if (!items.length) {
      this.log.warn(`[engine] bloque "${entry.name}" sin contenido: ${warnings.join(', ')}`);
      return this.enterSlate(`Bloque "${entry.name}" sin contenido`);
    }
    if (rt.mode === 'live') {
      await this._exitLive('cambio a parrilla', { silent: true });
    }
    rt.mode = 'schedule';
    rt.sourceType = 'schedule';
    rt.sourceName = entry.name;
    rt.scheduleEntryId = entry.id;
    rt.scheduleEndAt = endTimestamp(entry, tzParts(new Date(), this.data.settings.app.timezone));
    rt.oneShot = null;
    await this.playListAt(0, 0, { reason: `${reason}: ${entry.name}`, items });
    this.log.info(`[engine] parrilla: ${entry.name} (${items.length} elementos) ${warnings.length ? `· ${warnings.join('; ')}` : ''}`);
  }

  async _leaveSchedule(entry, why) {
    const rt = this.rt;
    const cur = rt.scheduleEntryId;
    rt.scheduleEntryId = null;
    rt.scheduleEndAt = null;
    this.log.info(`[engine] fin de bloque "${entry?.name || cur}": ${why}`);
    const nextNow = resolveNow(this.data);
    if (nextNow.current && nextNow.current.id !== entry?.id) {
      await this.activateScheduleEntry(nextNow.current, { reason: 'siguiente bloque' });
      return;
    }
    await this.startAutomation({ reason: `regreso a programación 24/7 (${why})` });
  }

  /** Ajusta una parrilla vencida a la hora actual (recalcula desde ahora). */
  async adaptSchedule() {
    const rt = this.rt;
    if (rt.mode !== 'schedule' || !rt.scheduleEntryId) {
      const schedule = resolveNow(this.data);
      if (schedule.current) return this.activateScheduleEntry(schedule.current, { reason: 'parrilla adaptada a la hora actual' });
      return this.startAutomation({ reason: 'parrilla adaptada a la hora actual' });
    }
    await this.playListAt(0, 0, { reason: 'parrilla adaptada a la hora actual' });
    return { ok: true };
  }

  // ---------------------------------------------------------- publicidad
  async checkAds() {
    const rt = this.rt;
    if (rt.holdSlate) return;
    if (!['automation', 'schedule', 'slate', 'idle'].includes(rt.mode)) return;
    if (rt.paused) return;
    const parts = tzParts(new Date(), this.data.settings.app.timezone);
    const ctx = { parts, now: this.now, mode: rt.mode };
    for (const block of this.data.adBlocks) {
      if (shouldTriggerBlock(this.data, block, ctx)) {
        try {
          await this.runAdBlock(block.id, { reason: 'disparador automático' });
        } catch (err) {
          this.log.warn(`[engine] bloque "${block.name}" no se pudo ejecutar: ${err.message}`);
        }
        return; // un bloque por ciclo
      }
    }
  }

  async runAdBlock(blockId, { reason = 'manual' } = {}) {
    const rt = this.rt;
    if (rt.mode === 'ads') throw new Error('Ya hay un bloque publicitario al aire');
    if (rt.mode === 'live') throw new Error('Hay una intervención en vivo; no se puede interrumpir');
    const block = this.data.adBlocks.find((b) => b.id === blockId);
    if (!block) throw new Error('Bloque publicitario no encontrado');
    const { items, warnings } = buildAdSequence(this.data, block);
    if (!items.length) throw new Error(warnings[0] || 'El bloque no tiene comerciales');
    if (!this.data.media.length) throw new Error('No hay biblioteca cargada');

    const returnTo = this._captureReturnPoint();
    rt.holdSlate = false;
    rt.mode = 'ads';
    rt.sourceType = 'ads';
    rt.sourceName = block.name;
    rt.ads = {
      runId: randomUUID(),
      blockId: block.id,
      blockName: block.name,
      startedAt: this.now,
      returnTo,
      hideGraphics: block.hideGraphics !== false,
    };
    rt.items = items;
    rt.index = 0;
    rt.paused = false;
    rt.itemStartedAt = this.now;
    rt.itemOffsetMs = 0;
    await this._startItem({ reason: `bloque publicitario (${reason})` });
    this.data.stats = this.data.stats || {};
    this.log.info(`[engine] publicidad: ${block.name} · ${items.length} elementos · ${reason}`);
    this.broadcast();
    return { ok: true, items: items.length };
  }

  async _finishAds(reason) {
    const rt = this.rt;
    const ads = rt.ads;
    this._closeOpenItem(reason || 'fin de bloque');
    if (!ads) return this.startAutomation({ reason: 'fin de publicidad' });
    const block = this.data.adBlocks.find((b) => b.id === ads.blockId);
    if (block) {
      const played = (rt.items || []).filter((i) => i.kind === 'ad').map((i) => i.mediaId);
      markFired(this.data, block, played);
      this.data.stats.adPlayed = (this.data.stats.adPlayed || 0) + played.length;
    }
    rt.ads = null;
    await applyGraphics(this.obs, this.data, this.log);
    await this._restoreReturnPoint(ads.returnTo, { reason: 'regreso tras publicidad' });
    this.log.info(`[engine] publicidad finalizada: ${ads.blockName}`);
  }

  _captureReturnPoint() {
    const rt = this.rt;
    if (!rt.items?.length) return null;
    return {
      mode: rt.mode === 'ads' ? 'automation' : rt.mode,
      sourceType: rt.sourceType,
      playlistId: rt.playlistId,
      sourceName: rt.sourceName,
      items: rt.items.map((it) => ({ ...it })),
      index: rt.index,
      elapsedMs: this._elapsedMs(),
      paused: rt.paused,
      scheduleEntryId: rt.scheduleEntryId,
      scheduleEndAt: rt.scheduleEndAt,
      oneShot: rt.oneShot || null,
    };
  }

  async _restoreReturnPoint(point, { reason = 'regreso' } = {}) {
    const rt = this.rt;
    if (!point) return this.startAutomation({ reason });
    const playlist = this.data.playlists.find((p) => p.id === point.playlistId);
    const items = point.items?.length ? point.items : resolvePlaylist(this.data, point.playlistId).items;
    if (!items.length) return this.startAutomation({ reason });

    rt.mode = ['automation', 'schedule', 'manual', 'emergency'].includes(point.mode) ? point.mode : 'automation';
    rt.sourceType = point.sourceType || rt.mode;
    rt.playlistId = point.playlistId;
    rt.sourceName = point.sourceName || playlist?.name || '';
    rt.scheduleEntryId = point.scheduleEntryId || null;
    rt.scheduleEndAt = point.scheduleEndAt || null;
    rt.oneShot = point.oneShot || null;

    let idx = Math.min(point.index || 0, items.length - 1);
    let elapsed = point.elapsedMs || 0;
    let guard = 0;
    while (items[idx] && elapsed >= items[idx].durationSec * 1000 && guard < items.length) {
      elapsed -= items[idx].durationSec * 1000;
      idx = (idx + 1) % items.length;
      guard += 1;
    }
    rt.items = items;
    rt.index = idx;
    rt.paused = false;
    rt.pausedAt = null;
    rt.itemStartedAt = this.now - elapsed;
    rt.itemOffsetMs = elapsed;
    rt.ads = null;
    await this._startItem({ reason });
    this.broadcast();
  }

  // ------------------------------------------------------------ en vivo
  async startLive({ sourceName = '', sceneName = '', label = 'En vivo', durationMin = 0, endAt = null, reason = 'intervención', entryId = null } = {}) {
    const rt = this.rt;
    if (rt.mode === 'ads') throw new Error('Hay publicidad al aire, espere unos segundos');
    const returnTo = this._captureReturnPoint();
    this._closeOpenItem('intervención en vivo');
    rt.mode = 'live';
    rt.sourceType = 'live';
    rt.sourceName = label;
    const until = endAt || (durationMin > 0 ? this.now + durationMin * 60000 : null);
    rt.live = {
      startedAt: this.now,
      sourceName: sourceName || this.data.settings.obs.liveSource || '',
      sceneName: sceneName || this.data.settings.obs.liveScene || '',
      label,
      endAt: until,
      endMode: endAt ? 'exact' : (durationMin > 0 ? 'duration' : 'manual'),
      returnTo,
      entryId,
    };
    rt.items = [];
    rt.index = 0;
    rt.paused = false;
    rt.scheduleEntryId = entryId || rt.scheduleEntryId;
    const scene = rt.live.sceneName;
    if (scene) await this.obs.setScene(scene);
    if (rt.live.sourceName && scene) await this.obs.setVisible(scene, rt.live.sourceName, true);
    addAsRun(this.data, { kind: 'live', title: label, note: reason, mode: 'live', exitReason: null });
    this._openAsRun = null;
    await applyGraphics(this.obs, this.data, this.log);
    this.log.info(`[engine] en vivo: ${label}${until ? ` hasta ${new Date(until).toLocaleTimeString('es-NI')}` : ''}`);
    this._persist();
    this.broadcast();
    return rt.live;
  }

  async checkLive() {
    const rt = this.rt;
    if (rt.mode !== 'live' || !rt.live) return;
    if (rt.live.endAt && this.now >= rt.live.endAt) {
      await this._exitLive('finalizó el tiempo de la intervención');
    }
  }

  async endLive(opts = {}) {
    return this._exitLive('finalizada por el operador', opts);
  }

  async _exitLive(reason, { silent = false } = {}) {
    const rt = this.rt;
    if (rt.mode !== 'live') return;
    const live = rt.live || {};
    const last = this.data.asrun.filter((r) => r.kind === 'live').at(-1);
    if (last) closeAsRun(this.data, last.id, { exitReason: reason });
    if (live.sceneName && live.sourceName) {
      try { await this.obs.setVisible(live.sceneName, live.sourceName, false); } catch { /* ignore */ }
    }
    rt.live = null;
    if (live.returnTo) {
      await this._restoreReturnPoint(live.returnTo, { reason: `regreso a programación (${reason})` });
    } else {
      await this.startAutomation({ reason: `regreso a programación (${reason})` });
    }
    if (live.sceneName) {
      const program = this.data.settings.obs.programScene;
      if (program) await this.obs.setScene(program);
    }
    await applyGraphics(this.obs, this.data, this.log);
    if (!silent) {
      this.log.info(`[engine] intervención en vivo finalizada: ${reason}`);
      this.broadcast();
    }
  }

  // -------------------------------------------------------- anti dead-air
  async checkEmergency() {
    const rt = this.rt;
    const cfg = this.data.emergency || {};

    if (rt.mode === 'emergency') {
      const em = rt.emergency || {};
      const wait = (cfg.recoverAfterSec || 10) * 1000;
      const attempts = rt.emergencyAttempts || 0;
      const canRetry = cfg.autoRecover !== false && attempts < 3;
      if (canRetry && em.startedAt && this.now - em.startedAt >= wait) {
        rt.emergencyAttempts = attempts + 1;
        rt.emergencyAttemptAt = this.now;
        this.log.info(`[engine] intento de recuperación automática ${rt.emergencyAttempts}/3`);
        await this.exitEmergency({ reason: 'recuperación automática', automatic: true });
      }
      return;
    }

    // Si la señal se mantuvo estable, se reinicia el contador de intentos.
    if (rt.emergencyAttemptAt && this.now - rt.emergencyAttemptAt > 300000) {
      rt.emergencyAttempts = 0;
      rt.emergencyAttemptAt = null;
    }

    if (!cfg.enabled) return;
    if (!['automation', 'schedule', 'manual'].includes(rt.mode)) {
      this._resetWatchdog();
      return;
    }
    if (rt.paused || !rt.items?.length) return;
    if (!this.obs.connected) return;

    const status = await this.obs.mediaStatus();
    const state = String(status.mediaState || '');
    const playing = state.includes('PLAYING');
    const stopped = state.includes('STOPPED') || state.includes('NONE') || state.includes('ENDED');

    const audioSource = this.data.settings.obs.audioSource || this.data.settings.obs.mediaSource;
    const vol = await this.obs.inputVolume(audioSource);
    const silent = playing && vol.inputVolumeMul === 0;

    const now = this.now;
    if (status.mediaCursor !== this._wd.cursor) {
      this._wd.cursor = status.mediaCursor;
      this._wd.cursorAt = now;
      this._wd.noProgressSince = null;
    }
    if (stopped) {
      this._wd.noProgressSince = this._wd.noProgressSince || now;
    }
    if (silent) this._wd.silentSince = this._wd.silentSince || now;
    else this._wd.silentSince = null;

    const silenceLimit = (cfg.silenceSeconds || 15) * 1000;
    const stallLimit = (cfg.noProgressSeconds || 25) * 1000;

    let reason = null;
    if (this._wd.silentSince && now - this._wd.silentSince >= silenceLimit) {
      reason = `silencio detectado durante ${Math.round((now - this._wd.silentSince) / 1000)} s`;
    } else if (this._wd.noProgressSince && now - this._wd.noProgressSince >= stallLimit) {
      reason = `reproducción detenida (estado ${state.replace('OBS_WEBSOCKET_MEDIA_INPUT_STATE_', '')})`;
    }
    if (reason) await this.enterEmergency(reason);
  }

  _resetWatchdog() {
    this._wd = { cursor: -1, cursorAt: this.now, silentSince: null, noProgressSince: null };
  }

  async enterEmergency(reason = 'caída de señal') {
    this._resetWatchdog();
    const rt = this.rt;
    const cfg = this.data.emergency || {};
    if (rt.mode === 'emergency') return;
    const returnTo = this._captureReturnPoint();
    const { playlist, items } = cfg.playlistId
      ? resolvePlaylist(this.data, cfg.playlistId)
      : { playlist: null, items: [] };
    let mediaItems = items;
    if (!mediaItems.length && cfg.folder) {
      // Carpeta especial de emergencia: se importa si aún no está en la biblioteca.
      const { importFolder } = await import('./services/library.js');
      try {
        let files = this.data.media.filter((m) => matchesFolder(m, cfg.folder));
        if (!files.length) {
          importFolder(this.data, cfg.folder, { recursive: true });
          files = this.data.media.filter((m) => matchesFolder(m, cfg.folder));
        }
        mediaItems = files.map((m) => toSequenceItem(m, this.data));
      } catch (err) {
        this.log.warn(`[engine] carpeta de emergencia inaccesible: ${err.message}`);
      }
    }
    if (!mediaItems.length && cfg.mediaIds?.length) {
      mediaItems = cfg.mediaIds
        .map((id) => this.data.media.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => toSequenceItem(m, this.data));
    }
    if (!mediaItems.length) {
      const fallback = resolvePlaylist(this.data, defaultPlaylistId(this.data));
      mediaItems = fallback.items;
    }
    this._closeOpenItem(`emergencia: ${reason}`);
    addAsRun(this.data, { kind: 'emergency', title: reason, note: 'Activación automática', block: playlist?.name || 'Emergencia', mode: 'emergency' });
    rt.stats.emergencies = (rt.stats.emergencies || 0) + 1;
    rt.emergency = { startedAt: this.now, reason, returnTo, attempts: 0, entryId: null };
    rt.mode = 'emergency';
    rt.sourceType = 'emergency';
    rt.sourceName = playlist?.name || 'Emergencia';
    this._resetWatchdog();
    if (!mediaItems.length) {
      this.log.error('[engine] no hay contenido de emergencia configurado');
      return this.enterSlate('emergencia sin contenido');
    }
    await this.playListAt(0, 0, { reason: `emergencia: ${reason}`, items: mediaItems, playlist: playlist || undefined });
    const scene = this.data.settings.obs.emergencyScene;
    if (scene) await this.obs.setScene(scene);
    this.log.warn(`[engine] EMERGENCIA activada: ${reason}`);
    this.broadcast();
  }

  async exitEmergency({ reason = 'operador', automatic = false } = {}) {
    const rt = this.rt;
    if (rt.mode !== 'emergency') return;
    if (!automatic) {
      rt.emergencyAttempts = 0;
      rt.emergencyAttemptAt = null;
    }
    const em = rt.emergency || {};
    this._closeOpenItem(`fin de emergencia (${reason})`);
    const last = this.data.asrun.filter((r) => r.kind === 'emergency').at(-1);
    if (last) last.recoveredAt = this.now;
    rt.emergency = null;
    this._resetWatchdog();
    await this._restoreReturnPoint(em.returnTo, { reason: `regreso tras emergencia (${reason})` });
    const scene = this.data.settings.obs.programScene;
    if (scene) await this.obs.setScene(scene);
    this.log.info(`[engine] emergencia superada: ${reason}`);
    this.broadcast();
  }

  // ------------------------------------------------------------- grabación
  async checkRecording() {
    const rec = this.data.recording;
    if (!this.obs.connected) return;
    const schedule = activeSchedule(this.data);
    const session = openSession(this.data);
    if (schedule && !rec.active) {
      await this.startRecording({ scheduleId: schedule.id, name: schedule.name, audio: schedule.audio !== false });
    } else if (rec.active && session?.scheduleId && !schedule) {
      await this.stopRecording('fin de ventana programada');
    }
    void rec;
  }

  async startRecording({ scheduleId = null, name = 'Grabación manual', audio = true } = {}) {
    const rec = this.data.recording;
    if (rec.active) return { ok: false, message: 'Ya hay una grabación en curso' };
    try {
      await this.obs.startRecord();
      rec.active = true;
      rec.startedAt = this.now;
      rec.lastError = null;
      addSession(this.data, { scheduleId, name, audio, operator: this.data.settings.app.operator });
      this.log.info(`[engine] grabación iniciada: ${name}`);
      this._persist();
      this.broadcast();
      return { ok: true };
    } catch (err) {
      rec.lastError = err.message;
      this.log.error(`[engine] error al iniciar grabación: ${err.message}`);
      this.broadcast();
      throw err;
    }
  }

  async stopRecording(reason = 'detenida por el operador') {
    const rec = this.data.recording;
    if (!rec.active) return { ok: false, message: 'No hay grabación activa' };
    const session = openSession(this.data);
    try {
      const st = await this.obs.stopRecord();
      rec.active = false;
      if (session) closeSession(this.data, session.id, { outputPath: st?.outputPath || '', reason });
      rec.lastError = null;
      this.log.info(`[engine] grabación finalizada: ${reason}`);
      this._persist();
      this.broadcast();
      return { ok: true, outputPath: st?.outputPath };
    } catch (err) {
      rec.lastError = err.message;
      if (session) closeSession(this.data, session.id, { reason: `error: ${err.message}` });
      rec.active = false;
      this.log.error(`[engine] error al detener grabación: ${err.message}`);
      this.broadcast();
      throw err;
    }
  }

  // -------------------------------------------------------------- gráficos
  async refreshGraphics(force = false) {
    const now = this.now;
    if (!force && now - this._lastGraphicsAt < 2000) return null;
    this._lastGraphicsAt = now;
    try {
      return await applyGraphics(this.obs, this.data, this.log);
    } catch (err) {
      this.log.warn(`[engine] gráficos: ${err.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- estado
  overlay() {
    return buildOverlay(this.data, new Date());
  }

  snapshot() {
    const rt = this.rt;
    const item = this._currentItem();
    const elapsedMs = this._elapsedMs();
    return {
      now: this.now,
      queue: (rt.items || []).slice(rt.index, rt.index + 10).map((it, k) => ({
        index: rt.index + k,
        title: it.title,
        durationSec: it.durationSec,
        kind: it.kind || 'video',
        category: it.category || '',
      })),
      runtime: {
        ...rt,
        // No repetir listas enormes en el estado resumido
        items: undefined,
        itemCount: rt.items?.length || 0,
        currentItem: item ? { ...item } : null,
        nextItem: this._nextItem() ? { ...this._nextItem() } : null,
        elapsedSec: Math.round(elapsedMs / 1000),
        remainingSec: item ? Math.max(0, Math.round(item.durationSec - elapsedMs / 1000)) : 0,
        progress: item ? Math.min(1, elapsedMs / (item.durationSec * 1000 || 1)) : 0,
      },
      overlay: this.overlay(),
      obs: this.obs.status(),
      recording: this.data.recording,
      schedule: (() => {
        const s = resolveNow(this.data);
        return {
          current: s.current,
          upcoming: s.upcoming,
          parts: s.parts,
          today: s.parts.dateKey,
        };
      })(),
      asrunHead: this.data.asrun.slice(-8).reverse(),
      settingsPublic: {
        channelName: this.data.settings.app.channelName,
        timezone: this.data.settings.app.timezone,
        timeFormat: this.data.settings.app.timeFormat,
        operator: this.data.settings.app.operator,
        playout: this.data.settings.playout,
        obs: this.data.settings.obs,
      },
    };
  }

  async _applyStateAfterReconnect() {
    this.log.info('[engine] reaplicando estado en OBS tras reconexión');
    await this.obs.refresh();
    await applyGraphics(this.obs, this.data, this.log);
    const rt = this.rt;
    if (rt.mode === 'live' && rt.live?.sceneName) {
      await this.obs.setScene(rt.live.sceneName);
      return;
    }
    const item = this._currentItem();
    if (item) {
      const elapsed = this._elapsedMs() / 1000;
      await this.obs.loadMedia({
        filePath: item.filePath,
        startMs: Math.max(0, elapsed * 1000),
        paused: rt.paused,
        durationMs: Math.round(item.durationSec * 1000),
        playlist: rt.items.map((it) => ({ filePath: it.filePath, title: it.title, durationMs: it.durationSec * 1000 })),
        index: rt.index,
        forceReload: true,
      }).catch((err) => this.log.warn(`[engine] recarga: ${err.message}`));
    }
  }

  async enterSlate(reason) {
    const rt = this.rt;
    this._closeOpenItem(`slate: ${reason}`);
    rt.mode = 'slate';
    rt.sourceType = 'slate';
    rt.sourceName = 'Slate';
    rt.items = [];
    rt.index = 0;
    rt.paused = false;
    rt.oneShot = null;
    addAsRun(this.data, { kind: 'slate', title: `Sin señal: ${reason}`, note: reason });
    const slate = this.data.settings.obs.slateScene;
    if (slate) await this.obs.setScene(slate);
    this.log.warn(`[engine] en slate: ${reason}`);
    this._persist();
    this.broadcast();
  }
}
