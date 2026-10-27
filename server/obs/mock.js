// Simulador de OBS WebSocket v5.
// Permite operar y demostrar todo Proca sin OBS instalado. La interfaz es la misma
// que usa el cliente real (server/obs/real.js).
import { EventEmitter } from 'node:events';

const now = () => Date.now();

const SCENES = [
  { sceneName: 'Programa', sceneIndex: 0 },
  { sceneName: 'En Vivo', sceneIndex: 1 },
  { sceneName: 'Publicidad', sceneIndex: 2 },
  { sceneName: 'Emergencia', sceneIndex: 3 },
  { sceneName: 'Slate', sceneIndex: 4 },
];

const INPUTS = [
  { inputName: 'Proca Media', inputKind: 'ffmpeg_source' },
  { inputName: 'Proca VLC', inputKind: 'vlc_source' },
  { inputName: 'Proca Graficos', inputKind: 'browser_source' },
  { inputName: 'Proca Logo', inputKind: 'image_source' },
  { inputName: 'Proca Reloj', inputKind: 'text_gdiplus_v2' },
  { inputName: 'Proca Ticker', inputKind: 'text_gdiplus_v2' },
  { inputName: 'Proca Slate', inputKind: 'color_source_v3' },
  { inputName: 'Proca Emergency', inputKind: 'ffmpeg_source' },
  { inputName: 'Cámara 1', inputKind: 'v4l2_input' },
  { inputName: 'Cámara 2', inputKind: 'v4l2_input' },
  { inputName: 'Micrófono Estudio', inputKind: 'alsa_input_capture' },
  { inputName: 'Proca Alerta', inputKind: 'text_gdiplus_v2' },
];

export class MockObs extends EventEmitter {
  constructor(logger = console) {
    super();
    this.log = logger;
    this.connected = false;
    this.version = '31.0.0-mock';
    this.programScene = 'Programa';
    this.scenes = SCENES.map((s) => ({ ...s }));
    this.inputs = INPUTS.map((i) => ({ ...i }));
    this.settings = {};
    this.visible = {};
    this.media = {
      path: null, playing: false, paused: false,
      startedAt: 0, baseMs: 0, durationMs: 0,
    };
    this.silentUntil = 0;
    this.record = { active: false, startedAt: null };
    this.recordings = [];
    this._meters = null;
  }

  async connect() {
    await new Promise((r) => setTimeout(r, 120));
    this.connected = true;
    this.emit('connected');
    this.log.info?.('[obs:mock] simulador conectado');
    return { obsVersion: this.version, obsWebSocketVersion: '5.5.2' };
  }

  async disconnect() {
    this.connected = false;
    this.media.playing = false;
    this.emit('disconnected');
  }

  async refresh() {
    return { scenes: this.scenes, inputs: this.inputs };
  }

  async getSceneList() {
    return { currentProgramSceneName: this.programScene, scenes: this.scenes };
  }

  async getInputList() {
    return { inputs: this.inputs };
  }

  async setScene(name) {
    if (!name) return;
    if (!this.scenes.some((s) => s.sceneName === name)) {
      this.scenes.push({ sceneName: name, sceneIndex: this.scenes.length });
    }
    this.programScene = name;
    this.emit('scene', name);
  }

  async setInputSettings(inputName, settings, overlay = true) {
    const prev = this.settings[inputName] || {};
    this.settings[inputName] = overlay ? { ...prev, ...settings } : { ...settings };
    this.emit('input-settings', { inputName, settings });
  }

  async setSceneItemVisible(sceneName, sourceName, visible) {
    this.visible[`${sceneName}/${sourceName}`] = !!visible;
  }

  async setMedia({ path, filePath, startMs = 0, paused = false, durationMs = 0 }) {
    const target = filePath || path || null;
    const same = this.media.path === target;
    this.media = {
      path: target,
      playing: true,
      paused: !!paused,
      startedAt: now(),
      baseMs: startMs,
      durationMs: durationMs || this.media.durationMs || 0,
    };
    if (!same) this.emit('media', { path: target });
  }

  /** Alias compatible con el cliente real. */
  async triggerMedia(_inputName, action) {
    return this.mediaAction(action);
  }

  async mediaAction(action) {
    const a = String(action || '').toLowerCase();
    if (a === 'pause') {
      if (this.media.playing && !this.media.paused) {
        this.media.baseMs = this._cursor();
        this.media.paused = true;
        this.media.startedAt = now();
      }
    } else if (a === 'play' || a === 'resume') {
      if (this.media.paused) {
        this.media.paused = false;
        this.media.startedAt = now();
      }
      this.media.playing = true;
    } else if (a === 'restart') {
      this.media.baseMs = 0;
      this.media.startedAt = now();
      this.media.playing = true;
      this.media.paused = false;
    } else if (a === 'stop') {
      this.media.baseMs = this._cursor();
      this.media.playing = false;
      this.media.paused = false;
    }
  }

  async setMediaCursor(ms) {
    this.media.baseMs = Math.max(0, ms);
    this.media.startedAt = now();
  }

  _cursor() {
    if (!this.media.playing || this.media.paused) return this.media.baseMs;
    return this.media.baseMs + (now() - this.media.startedAt);
  }

  async getMediaStatus() {
    const cursorMs = this._cursor();
    let state = 'OBS_WEBSOCKET_MEDIA_INPUT_STATE_PLAYING';
    if (!this.media.path) state = 'OBS_WEBSOCKET_MEDIA_INPUT_STATE_NONE';
    else if (!this.media.playing) state = 'OBS_WEBSOCKET_MEDIA_INPUT_STATE_STOPPED';
    else if (this.media.paused) state = 'OBS_WEBSOCKET_MEDIA_INPUT_STATE_PAUSED';
    else if (this.media.durationMs && cursorMs >= this.media.durationMs) {
      state = 'OBS_WEBSOCKET_MEDIA_INPUT_STATE_ENDED';
      this.media.playing = false;
    }
    return {
      mediaState: state,
      mediaCursor: Math.round(cursorMs),
      mediaDuration: Math.round(this.media.durationMs || 0),
      path: this.media.path,
    };
  }

  async getInputVolume(inputName) {
    if (now() < this.silentUntil) return { inputVolumeMul: 0, inputVolumeDb: -100 };
    if (this.settings[inputName]?.muted) return { inputVolumeMul: 0, inputVolumeDb: -100 };
    return { inputVolumeMul: 0.72, inputVolumeDb: -6.4 };
  }

  async startRecord() {
    if (this.record.active) return;
    this.record = { active: true, startedAt: now() };
    this.emit('record', { active: true });
  }

  async stopRecord() {
    if (!this.record.active) return { outputPath: '' };
    const startedAt = this.record.startedAt;
    this.record = { active: false, startedAt: null };
    const outputPath = `/grabaciones/proca-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.mkv`;
    this.recordings.push({ startedAt, endedAt: now(), outputPath });
    this.emit('record', { active: false, outputPath });
    return { outputPath };
  }

  async getRecordStatus() {
    return {
      outputActive: this.record.active,
      outputTimecode: this.record.active ? this._timecode(now() - this.record.startedAt) : '00:00:00.000',
      outputBytes: this.record.active ? Math.round((now() - this.record.startedAt) * 900000 / 1000) : 0,
      outputPath: this.recordings.at(-1)?.outputPath || '',
    };
  }

  _timecode(ms) {
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}.000`;
  }

  /** Fuerza silencio temporal para probar el anti dead-air. */
  simulateSilence(ms = 20000) {
    this.silentUntil = now() + ms;
  }

  simulateStall() {
    this.media.playing = false;
  }

  /** Reconexión forzada (para probar el manejo de errores). */
  simulateDisconnect() {
    this.connected = false;
    this.emit('disconnected');
  }
}
