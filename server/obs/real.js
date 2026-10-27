// Cliente real de OBS Studio mediante obs-websocket v5.
// Requiere OBS 28+ con "Herramientas > WebSocket settings" habilitado.
import fs from 'node:fs';
import path from 'node:path';
import OBSWebSocket from 'obs-websocket-js';

const ACTION = {
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  next: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
  previous: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS',
};

export class RealObs {
  constructor(cfg, logger = console, hooks = {}) {
    this.cfg = { ...cfg };
    this.log = logger;
    this.hooks = hooks;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.scenes = [];
    this.inputs = [];
    this.recordStatus = { outputActive: false };
    this._playlistSignature = '';
    this._lastIndex = null;
    this._wireEvents();
  }

  _wireEvents() {
    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
      this.hooks.onDisconnect?.('Conexión cerrada por OBS');
    });
    this.obs.on('ConnectionError', (err) => {
      this.connected = false;
      this.hooks.onError?.(err?.message || 'Error de conexión');
    });
    this.obs.on('RecordStateChanged', (data) => {
      this.recordStatus = {
        outputActive: data.outputActive,
        outputPath: data.outputPath || this.recordStatus.outputPath || '',
      };
      this.hooks.onRecord?.(this.recordStatus);
    });
    this.obs.on('CurrentProgramSceneChanged', (data) => {
      this.hooks.onScene?.(data.sceneName);
    });
    this.obs.on('MediaInputPlaybackEnded', () => this.hooks.onMediaEnded?.());
    this.obs.on('MediaInputPlaybackStarted', () => this.hooks.onMediaStarted?.());
  }

  async connect() {
    const url = `ws://${this.cfg.host}:${this.cfg.port}`;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Tiempo de espera agotado al conectar con OBS (¿está abierto el WebSocket?)')), 8000));
    const conn = this.obs.connect(url, this.cfg.password || undefined, { rpcVersion: 1 });
    const info = await Promise.race([conn, timeout]);
    this.connected = true;
    this._playlistSignature = '';
    this._lastIndex = null;
    await this.refresh();
    return info;
  }

  async disconnect() {
    try { await this.obs.disconnect(); } catch { /* ignore */ }
    this.connected = false;
  }

  async refresh() {
    try {
      const [scenes, inputs] = await Promise.all([
        this.obs.call('GetSceneList'),
        this.obs.call('GetInputList'),
      ]);
      this.scenes = (scenes.scenes || []).map((s) => ({ sceneName: s.sceneName, sceneIndex: s.sceneIndex }));
      this.inputs = (inputs.inputs || []).map((i) => ({ inputName: i.inputName, inputKind: i.inputKind }));
      return { scenes: this.scenes, inputs: this.inputs, programScene: scenes.currentProgramSceneName };
    } catch (err) {
      this.log.warn?.('[obs] refresh falló:', err.message);
      return { scenes: this.scenes, inputs: this.inputs };
    }
  }

  async setScene(name) {
    if (!name) return;
    await this.obs.call('SetCurrentProgramScene', { sceneName: name });
  }

  async setInputSettings(inputName, settings, overlay = true) {
    if (!inputName) return;
    await this.obs.call('SetInputSettings', { inputName, inputSettings: settings, overlay });
  }

  async setSourceText(inputName, text) {
    await this.setInputSettings(inputName, { text });
  }

  async setSceneItemVisible(sceneName, sourceName, visible) {
    if (!sceneName || !sourceName) return;
    try {
      const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName, sourceName });
      await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !!visible });
    } catch (err) {
      this.log.warn?.(`[obs] no se pudo cambiar visibilidad de ${sourceName} en ${sceneName}: ${err.message}`);
    }
  }

  /**
   * Carga el contenido actual en OBS.
   * mode = single | playlist | m3u
   */
  async setMedia({ filePath, startMs = 0, paused = false, playlist = null, index = 0 }) {
    const mode = this.cfg.mediaMode || 'single';
    if (mode === 'single') {
      const source = this.cfg.mediaSource || 'Proca Media';
      await this.setInputSettings(source, {
        local_file: filePath,
        restart_when_active: false,
        close_when_inactive: false,
        clear_on_media_end: false,
        loop: false,
      });
      await this.triggerMedia(source, 'restart');
      if (startMs > 0) {
        try { await this.obs.call('SetMediaInputCursor', { inputName: source, mediaCursor: Math.round(startMs) }); } catch { /* algunos inputs no soportan seek */ }
      }
      if (paused) await this.triggerMedia(source, 'pause');
      return;
    }

    const source = this.cfg.playlistSource || 'Proca VLC';
    if (mode === 'playlist' || mode === 'm3u') {
      const signature = JSON.stringify((playlist || []).map((p) => p.filePath));
      if (mode === 'playlist') {
        const list = playlist || [];
        if (signature !== this._playlistSignature) {
          await this.setInputSettings(source, {
            playlist: list.map((p) => ({ hidden: false, selected: false, value: p.filePath })),
            loop: false, shuffle: false, restart_when_active: false, close_when_inactive: false,
          });
          this._playlistSignature = signature;
          await this.triggerMedia(source, 'restart');
          this._lastIndex = 0;
        } else if (this._lastIndex !== null && index === this._lastIndex + 1) {
          // Avance normal: VLC pasa al siguiente elemento de la lista.
          await this.triggerMedia(source, 'next');
          this._lastIndex = index;
        } else if (this._lastIndex === index) {
          // Mismo elemento (reanudar, reiniciar tema)
          await this.triggerMedia(source, 'restart');
        } else {
          // Salto (anterior, ir a índice, regreso tras publicidad): se reconstruye
          // la lista rotada para que el elemento elegido quede al inicio.
          const rotated = [...list.slice(index), ...list.slice(0, index)];
          await this.setInputSettings(source, {
            playlist: rotated.map((p) => ({ hidden: false, selected: false, value: p.filePath })),
            loop: false, shuffle: false, restart_when_active: false, close_when_inactive: false,
          });
          this._playlistSignature = signature;
          await this.triggerMedia(source, 'restart');
          this._lastIndex = index;
        }
        if (paused) await this.triggerMedia(source, 'pause');
        return;
      }

      // m3u: se genera un archivo de lista estándar y VLC lo reproduce de corrido.
      const dir = path.resolve('data', 'playlists');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'proca-current.m3u8');
      const lines = ['#EXTM3U'];
      for (const item of playlist || []) {
        lines.push(`#EXTINF:${Math.round((item.durationMs || 0) / 1000)},${item.title || ''}`);
        lines.push(item.filePath);
      }
      fs.writeFileSync(file, lines.join('\n'));
      await this.setInputSettings(source, {
        playlist: [{ hidden: false, selected: false, value: file }],
        loop: false, shuffle: false, restart_when_active: false, close_when_inactive: false,
      });
      await this.triggerMedia(source, 'restart');
      this._lastIndex = index;
      if (paused) await this.triggerMedia(source, 'pause');
    }
  }

  async triggerMedia(inputName, action) {
    if (!inputName) return;
    const mediaAction = ACTION[action] || action;
    try {
      await this.obs.call('TriggerMediaInputAction', { inputName, mediaAction });
    } catch (err) {
      this.log.warn?.(`[obs] acción ${action} sobre ${inputName} falló: ${err.message}`);
      throw err;
    }
  }

  async getMediaStatus() {
    const source = (this.cfg.mediaMode === 'single')
      ? (this.cfg.mediaSource || 'Proca Media')
      : (this.cfg.playlistSource || 'Proca VLC');
    try {
      const st = await this.obs.call('GetMediaInputStatus', { inputName: source });
      return {
        mediaState: st.mediaState,
        mediaCursor: st.mediaCursor || 0,
        mediaDuration: st.mediaDuration || 0,
      };
    } catch {
      return { mediaState: 'OBS_WEBSOCKET_MEDIA_INPUT_STATE_NONE', mediaCursor: 0, mediaDuration: 0 };
    }
  }

  async getInputVolume(inputName) {
    try {
      const v = await this.obs.call('GetInputVolume', { inputName });
      return { inputVolumeMul: v.inputVolumeMul ?? 0, inputVolumeDb: v.inputVolumeDb ?? -100 };
    } catch {
      return { inputVolumeMul: 1, inputVolumeDb: 0 };
    }
  }

  async startRecord() {
    const r = await this.obs.call('StartRecord');
    this.recordStatus = { outputActive: r.outputActive !== false, outputPath: this.recordStatus.outputPath || '' };
    return this.recordStatus;
  }

  async stopRecord() {
    const r = await this.obs.call('StopRecord');
    this.recordStatus = { outputActive: false, outputPath: r.outputPath || '' };
    return this.recordStatus;
  }

  async getRecordStatus() {
    try {
      const r = await this.obs.call('GetRecordStatus');
      this.recordStatus = { outputActive: r.outputActive, outputTimecode: r.outputTimecode, outputBytes: r.outputBytes };
      return this.recordStatus;
    } catch {
      return this.recordStatus;
    }
  }
}
