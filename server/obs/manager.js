// Gestor de conexión con OBS: selecciona simulador o cliente real,
// normaliza la API, mantiene estado y reconecta automáticamente.
import { EventEmitter } from 'node:events';
import { MockObs } from './mock.js';
import { RealObs } from './real.js';

export class ObsManager extends EventEmitter {
  constructor(store, logger = console) {
    super();
    this.store = store;
    this.log = logger;
    this.driver = null;
    this.driverKind = 'none';
    this.connected = false;
    this.lastError = null;
    this.lastConnectAt = null;
    this._reconnectTimer = null;
    this._connecting = false;
    this.recordState = { outputActive: false, startedAt: null, outputPath: '', lastError: null };
    this.currentScene = null;
  }

  get cfg() {
    return this.store.data.settings.obs;
  }

  get isMock() {
    return this.driverKind === 'mock';
  }

  status() {
    return {
      connected: this.connected,
      kind: this.driverKind,
      mock: this.isMock,
      lastError: this.lastError,
      lastConnectAt: this.lastConnectAt,
      scenes: this.driver?.scenes ?? [],
      inputs: this.driver?.inputs ?? [],
      record: this.recordState,
      currentScene: this.currentScene,
      cfg: {
        host: this.cfg.host, port: this.cfg.port, mediaMode: this.cfg.mediaMode,
        mediaSource: this.cfg.mediaSource, playlistSource: this.cfg.playlistSource,
      },
    };
  }

  async connect({ mock = false } = {}) {
    if (this._connecting) return this.status();
    this._connecting = true;
    this.clearReconnect();
    try {
      if (this.driver) {
        try { await this.driver.disconnect(); } catch { /* ignore */ }
        this.driver = null;
      }
      this.connected = false;
      this.driverKind = mock ? 'mock' : 'real';
      const hooks = {
        onDisconnect: (msg) => this._handleDrop(msg),
        onError: (msg) => { this.lastError = msg; this.emit('error', msg); },
        onRecord: (st) => this._onRecordState(st),
        onScene: (scene) => { this.currentScene = scene; this.emit('scene', scene); },
        onMediaEnded: () => this.emit('media-ended'),
        onMediaStarted: () => this.emit('media-started'),
      };
      this.driver = mock ? new MockObs(this.log) : new RealObs(this.cfg, this.log, hooks);
      if (!mock) {
        this.driver.hooks = hooks;
      }
      const info = await this.driver.connect();
      this.connected = true;
      this.currentScene = this.isMock ? this.driver.programScene : (this.driver.scenes?.find((s) => s.current)?.sceneName || null);
      if (!this.isMock) await this.driver.refresh();
      this.currentScene = this.currentScene || (this.isMock ? 'Programa' : null);
      this.lastError = null;
      this.lastConnectAt = Date.now();
      this.emit('connected', { mock, info });
      this.log.info?.(`[obs] conectado (${mock ? 'simulador' : `${this.cfg.host}:${this.cfg.port}`})`);
      return this.status();
    } catch (err) {
      this.connected = false;
      this.lastError = err?.message || String(err);
      this.emit('error', this.lastError);
      this.log.warn?.(`[obs] conexión fallida: ${this.lastError}`);
      if (this.cfg.reconnect) this.scheduleReconnect();
      return this.status();
    } finally {
      this._connecting = false;
    }
  }

  _handleDrop(message) {
    if (!this.connected) return;
    this.connected = false;
    this.lastError = message || 'Conexión perdida con OBS';
    this.emit('disconnected', this.lastError);
    this.log.warn?.(`[obs] ${this.lastError}`);
    if (this.cfg.reconnect) this.scheduleReconnect();
  }

  scheduleReconnect(delay = 5000) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.connected) return;
      this.log.info?.('[obs] intentando reconectar…');
      await this.connect({ mock: this.isMock });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  async disconnect() {
    this.clearReconnect();
    if (this.driver) await this.driver.disconnect();
    this.connected = false;
    this.driverKind = 'none';
    this.driver = null;
  }

  _onRecordState(st) {
    if (st.outputActive && !this.recordState.outputActive) {
      this.recordState = { outputActive: true, startedAt: Date.now(), outputPath: '', lastError: null };
    } else if (!st.outputActive && this.recordState.outputActive) {
      this.recordState = { ...this.recordState, outputActive: false, outputPath: st.outputPath || this.recordState.outputPath };
    }
    this.emit('record', this.recordState);
  }

  async refresh() {
    if (!this.connected) return null;
    return this.driver.refresh();
  }

  async loadMedia(payload) {
    if (!this.connected) throw new Error('OBS no está conectado');
    return this.driver.setMedia(payload);
  }

  async mediaAction(action) {
    if (!this.connected) return;
    const source = this.cfg.mediaMode === 'single' ? this.cfg.mediaSource : this.cfg.playlistSource;
    const fn = this.driver.triggerMedia || this.driver.mediaAction;
    return fn.call(this.driver, source, action);
  }

  async mediaStatus() {
    if (!this.connected) return { mediaState: 'DISCONNECTED', mediaCursor: 0, mediaDuration: 0 };
    return this.driver.getMediaStatus();
  }

  async inputVolume(inputName) {
    if (!this.connected) return { inputVolumeMul: 1, inputVolumeDb: 0 };
    return this.driver.getInputVolume(inputName);
  }

  async setScene(name) {
    if (!this.connected || !name) return;
    this.currentScene = name;
    return this.driver.setScene(name);
  }

  async setInputSettings(inputName, settings, overlay = true) {
    if (!this.connected) return;
    return this.driver.setInputSettings(inputName, settings, overlay);
  }

  async setSourceText(inputName, text) {
    if (!this.connected || !inputName) return;
    return this.driver.setSourceText ? this.driver.setSourceText(inputName, text) : this.driver.setInputSettings(inputName, { text });
  }

  async setVisible(sceneName, sourceName, visible) {
    if (!this.connected) return;
    return this.driver.setSceneItemVisible(sceneName, sourceName, visible);
  }

  async startRecord() {
    if (!this.connected) throw new Error('OBS no está conectado');
    const r = await this.driver.startRecord();
    this._onRecordState({ outputActive: true, outputPath: r?.outputPath });
    return this.recordState;
  }

  async stopRecord() {
    if (!this.connected) throw new Error('OBS no está conectado');
    const r = await this.driver.stopRecord();
    this._onRecordState({ outputActive: false, outputPath: r?.outputPath });
    return this.recordState;
  }

  async recordStatus() {
    if (!this.connected) return { outputActive: false };
    const st = await this.driver.getRecordStatus();
    return { ...st, startedAt: this.recordState.startedAt, outputPath: st.outputPath || this.recordState.outputPath };
  }

  simulate(what) {
    if (!this.isMock) return { ok: false, error: 'El simulador no está activo' };
    if (what === 'silence') this.driver.simulateSilence(25000);
    else if (what === 'stall') this.driver.simulateStall();
    else if (what === 'drop') this.driver.simulateDisconnect();
    return { ok: true, what };
  }
}
