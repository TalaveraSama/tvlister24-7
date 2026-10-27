// Ajustes: conexión OBS, identidad del canal, presets, respaldo y registros.
import { api } from '../api.js';
import { esc, toast, confirmDialog, formModal, qs, qsa, fmtDateTime } from '../ui.js';
import { download } from '../components.js';

const TIMEZONES = [
  'America/Managua', 'America/Costa_Rica', 'America/Guatemala', 'America/El_Salvador',
  'America/Tegucigalpa', 'America/Panama', 'America/Mexico_City', 'America/Bogota',
  'America/Lima', 'America/Caracas', 'America/Santiago', 'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo', 'America/New_York', 'America/Los_Angeles', 'Europe/Madrid', 'UTC',
];

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const s = boot.settings;
  const obs = snap.obs || {};
  const logs = (await api.get('/api/logs?limit=80').catch(() => ({ lines: [] }))).lines;
  const scenes = obs.scenes || [];
  const inputs = obs.inputs || [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Ajustes</div>
        <div class="page-desc">Conexión con OBS WebSocket, identidad del canal, valores por defecto de reproducción, presets y respaldos.</div>
      </div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Conexión OBS WebSocket</div>
            <div class="card-actions">
              <span class="badge ${obs.connected ? (obs.mock ? 'amber' : 'green') : 'red'}">
                ${obs.connected ? (obs.mock ? 'Simulador' : 'Conectado') : 'Desconectado'}
              </span>
            </div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Modo</label>
              <select id="obs-driver">
                <option value="mock" ${s.obs.driver === 'mock' ? 'selected' : ''}>Simulador (sin OBS)</option>
                <option value="real" ${s.obs.driver === 'real' ? 'selected' : ''}>OBS real (WebSocket)</option>
                <option value="off" ${s.obs.driver === 'off' ? 'selected' : ''}>Desactivado</option>
              </select>
              <div class="hint">El simulador permite operar toda la automatización sin OBS instalado.</div>
            </div>
            <div class="field"><label>Host</label><input type="text" id="obs-host" value="${esc(s.obs.host)}"></div>
            <div class="field"><label>Puerto</label><input type="number" id="obs-port" value="${s.obs.port}"></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Contraseña WebSocket</label><input type="password" id="obs-pass" value="${esc(s.obs.password)}" placeholder="(vacío si no usa contraseña)"></div>
            <div class="field"><label>Reconexión automática</label>
              <label class="check" style="height:38px"><input type="checkbox" id="obs-reconnect" ${s.obs.reconnect ? 'checked' : ''}> Reconectar si se cae la conexión</label></div>
          </div>
          <div class="row" style="gap:8px">
            <button class="btn btn-primary" data-act="connect">Conectar</button>
            <button class="btn" data-act="disconnect">Desconectar</button>
            <button class="btn" data-act="refresh-obs">⟳ Refrescar fuentes</button>
            ${obs.connected && obs.mock ? '<button class="btn btn-warn" data-act="sim-drop">Simular caída</button>' : ''}
          </div>
          ${obs.lastError ? `<div class="alert danger" style="margin-top:10px"><div><div class="a-title">Último error de conexión</div>${esc(obs.lastError)}</div></div>` : ''}
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Reproducción en OBS</div></div>
          <div class="inline-fields">
            <div class="field"><label>Modo de reproducción</label>
              <select id="media-mode">
                <option value="single" ${s.obs.mediaMode === 'single' ? 'selected' : ''}>Fuente multimedia (un archivo)</option>
                <option value="playlist" ${s.obs.mediaMode === 'playlist' ? 'selected' : ''}>Playlist VLC (fuente de reproducción)</option>
                <option value="m3u" ${s.obs.mediaMode === 'm3u' ? 'selected' : ''}>Lista M3U para VLC</option>
              </select>
              <div class="hint">Proca calcula la duración y avanza; la lista VLC puede reproducir de corrido.</div>
            </div>
            <div class="field"><label>Fuente multimedia</label>
              <input type="text" id="media-source" value="${esc(s.obs.mediaSource)}" list="inputs-list">
            </div>
            <div class="field"><label>Fuente de playlist</label>
              <input type="text" id="playlist-source" value="${esc(s.obs.playlistSource)}" list="inputs-list">
            </div>
          </div>
          <datalist id="inputs-list">${inputs.map((i) => `<option value="${esc(i.inputName)}">`).join('')}</datalist>
          <div class="inline-fields">
            <div class="field"><label>Escena de programa</label>
              <input type="text" id="program-scene" value="${esc(s.obs.programScene)}" list="scenes-list"></div>
            <div class="field"><label>Escena en vivo</label>
              <input type="text" id="live-scene" value="${esc(s.obs.liveScene || '')}" list="scenes-list"></div>
            <div class="field"><label>Escena de emergencia</label>
              <input type="text" id="emergency-scene" value="${esc(s.obs.emergencyScene || '')}" list="scenes-list"></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Escena de slate</label>
              <input type="text" id="slate-scene" value="${esc(s.obs.slateScene || '')}" list="scenes-list"></div>
            <div class="field"><label>Fuente de audio (medidor)</label>
              <input type="text" id="audio-source" value="${esc(s.obs.audioSource || s.obs.mediaSource)}" list="inputs-list"></div>
          </div>
          <datalist id="scenes-list">${scenes.map((x) => `<option value="${esc(x.sceneName)}">`).join('')}</datalist>
          <button class="btn btn-primary" data-act="save-playout">Guardar reproducción</button>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Identidad del canal</div></div>
          <div class="inline-fields">
            <div class="field"><label>Nombre del canal</label><input type="text" id="channel" value="${esc(s.app.channelName)}"></div>
            <div class="field"><label>Operador</label><input type="text" id="operator" value="${esc(s.app.operator)}"></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Zona horaria</label>
              <select id="timezone">
                ${TIMEZONES.map((t) => `<option value="${t}" ${s.app.timezone === t ? 'selected' : ''}>${t}</option>`).join('')}
              </select></div>
            <div class="field"><label>Formato de hora</label>
              <select id="timeformat">
                <option value="24" ${s.app.timeFormat === '24' ? 'selected' : ''}>24 horas</option>
                <option value="12" ${s.app.timeFormat === '12' ? 'selected' : ''}>12 horas</option>
              </select></div>
          </div>
          <button class="btn btn-primary" data-act="save-app">Guardar identidad</button>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Valores por defecto de reproducción</div></div>
          <div class="inline-fields">
            <div class="field"><label>Duración por defecto (seg)</label>
              <input type="number" id="default-duration" value="${s.playout.defaultDurationSec}" min="5"></div>
            <div class="field"><label>Separación mínima entre bloques (seg)</label>
              <input type="number" id="min-gap" value="${s.playout.minAdGapSeconds}" min="10"></div>
          </div>
          <label class="check" style="margin-bottom:8px"><input type="checkbox" id="resume" ${s.playout.resumeOnStart ? 'checked' : ''}> Reanudar la automatización al abrir Proca</label>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" id="show-countdown" ${s.playout.showNextCountdown ? 'checked' : ''}> Mostrar cuenta regresiva en el overlay</label>
          <button class="btn btn-primary" data-act="save-playout-defaults">Guardar valores</button>
          <div class="help-box" style="margin-top:12px">Si un video no tiene duración declarada se usa este valor para calcular el avance.</div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Presets de configuración</div>
            <div class="card-actions"><button class="btn btn-xs btn-primary" data-act="new-preset">+ Guardar actual</button></div>
          </div>
          <div class="stack" style="gap:6px">
            ${(boot.presets || []).map((p) => `<div class="list-row">
              <span class="title small">${esc(p.name)}</span>
              <span class="meta">${fmtDateTime(p.createdAt)}</span>
              <button class="btn btn-xs btn-primary" data-apply-preset="${p.id}">Aplicar</button>
              <button class="btn btn-xs btn-danger" data-del-preset="${p.id}">✕</button>
            </div>`).join('') || '<div class="muted small">Sin presets guardados.</div>'}
          </div>
          <div class="help-box" style="margin-top:10px">Un preset guarda conexión OBS, fuentes, escenas, gráficos y configuración de emergencia.</div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Respaldo y recuperación</div></div>
          <div class="stack" style="gap:6px">
            <button class="btn" data-act="export">⬇ Descargar respaldo completo</button>
            <label class="btn" style="cursor:pointer">⬆ Restaurar respaldo
              <input type="file" id="import-file" accept="application/json" style="display:none">
            </label>
            <button class="btn btn-danger" data-act="reset-demo">Restaurar datos de demostración</button>
          </div>
          <div class="help-box" style="margin-top:10px">El respaldo incluye biblioteca, listas, parrilla, publicidad, gráficos y registro As-Run. Los archivos de video no se copian.</div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Registro del sistema</div>
            <div class="card-actions"><button class="btn btn-xs" data-act="reload-logs">⟳</button></div>
          </div>
          <div class="log-list" id="logs">
            ${logs.map((l) => `<div class="log-line ${esc(l.level)}"><span class="ts">${new Date(l.ts).toLocaleTimeString('es-NI')}</span><span class="msg">${esc(l.msg)}</span></div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Acerca de</div></div>
          <div class="kv"><span class="k">Proca Automation</span><span class="v">v${esc(boot.version.app)}</span></div>
          <div class="kv"><span class="k">Node.js</span><span class="v mono">${esc(boot.version.node)}</span></div>
          <div class="kv"><span class="k">Overlay OBS</span><span class="v mono">/overlay</span></div>
          <div class="kv"><span class="k">Datos guardados</span><span class="v">${esc(boot.meta.updatedAt?.slice(0, 19).replace('T', ' ') || '—')}</span></div>
        </div>
      </div>
    </div>
  `;

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act],[data-apply-preset],[data-del-preset]');
    if (!btn) return;
    try {
      if (btn.dataset.applyPreset) {
        if (!await confirmDialog('¿Aplicar este preset? Se reemplazará la configuración actual.', { okLabel: 'Aplicar' })) return;
        await api.post(`/api/presets/${btn.dataset.applyPreset}/apply`);
        toast('Preset aplicado', 'ok');
        return ctx.refresh();
      }
      if (btn.dataset.delPreset) {
        await api.del(`/api/presets/${btn.dataset.delPreset}`);
        return ctx.refresh();
      }
      const act = btn.dataset.act;
      if (act === 'connect') {
        const driver = qs('#obs-driver', root).value;
        await api.patch('/api/settings', {
          obs: {
            driver,
            host: qs('#obs-host', root).value,
            port: Number(qs('#obs-port', root).value),
            password: qs('#obs-pass', root).value,
            reconnect: qs('#obs-reconnect', root).checked,
          },
        });
        const st = await api.post('/api/obs/connect', {
          mock: driver !== 'real',
          host: qs('#obs-host', root).value,
          port: Number(qs('#obs-port', root).value),
          password: qs('#obs-pass', root).value,
        });
        toast(st.connected ? (st.mock ? 'Simulador conectado' : 'OBS conectado') : 'No se pudo conectar', st.connected ? 'ok' : 'err');
        await ctx.refresh();
      } else if (act === 'disconnect') {
        await api.post('/api/obs/disconnect');
        toast('OBS desconectado', 'warn');
        await ctx.refresh();
      } else if (act === 'refresh-obs') {
        const r = await api.post('/api/obs/refresh');
        toast(`${(r.scenes || []).length} escenas · ${(r.inputs || []).length} fuentes`, 'ok');
        await ctx.refresh();
      } else if (act === 'sim-drop') {
        await api.post('/api/obs/simulate', { what: 'drop' });
        toast('Caída simulada: OBS se reconectará solo', 'warn');
      } else if (act === 'save-playout') {
        await api.patch('/api/settings', {
          obs: {
            mediaMode: qs('#media-mode', root).value,
            mediaSource: qs('#media-source', root).value,
            playlistSource: qs('#playlist-source', root).value,
            programScene: qs('#program-scene', root).value,
            liveScene: qs('#live-scene', root).value,
            emergencyScene: qs('#emergency-scene', root).value,
            slateScene: qs('#slate-scene', root).value,
            audioSource: qs('#audio-source', root).value,
          },
        });
        toast('Configuración de reproducción guardada', 'ok');
        await ctx.refresh();
      } else if (act === 'save-app') {
        await api.patch('/api/settings', {
          app: {
            channelName: qs('#channel', root).value,
            operator: qs('#operator', root).value,
            timezone: qs('#timezone', root).value,
            timeFormat: qs('#timeformat', root).value,
          },
        });
        toast('Identidad guardada', 'ok');
        await ctx.refresh();
      } else if (act === 'save-playout-defaults') {
        await api.patch('/api/settings', {
          playout: {
            defaultDurationSec: Number(qs('#default-duration', root).value),
            minAdGapSeconds: Number(qs('#min-gap', root).value),
            resumeOnStart: qs('#resume', root).checked,
            showNextCountdown: qs('#show-countdown', root).checked,
          },
        });
        toast('Valores guardados', 'ok');
        await ctx.refresh();
      } else if (act === 'new-preset') {
        formModal({
          title: 'Guardar preset',
          fields: [{ name: 'name', label: 'Nombre del preset', required: true, full: true }],
          onSubmit: async (v) => {
            await api.post('/api/presets', v);
            toast('Preset guardado', 'ok');
            await ctx.refresh();
          },
        });
      } else if (act === 'export') {
        download('/api/data/export');
        toast('Respaldo descargado', 'ok');
      } else if (act === 'reset-demo') {
        if (!await confirmDialog('Esto reemplaza todos los datos por la demostración. ¿Continuar?', { danger: true, okLabel: 'Restaurar demo' })) return;
        await api.post('/api/data/reset', { mode: 'demo' });
        toast('Datos de demostración restaurados', 'ok');
        await ctx.refresh();
      } else if (act === 'reload-logs') {
        const res = await api.get('/api/logs?limit=80');
        qs('#logs', root).innerHTML = res.lines.map((l) => `<div class="log-line ${esc(l.level)}"><span class="ts">${new Date(l.ts).toLocaleTimeString('es-NI')}</span><span class="msg">${esc(l.msg)}</span></div>`).join('');
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  qs('#import-file', root).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!await confirmDialog('¿Restaurar este respaldo? Se reemplazará la configuración actual.', { danger: true, okLabel: 'Restaurar' })) return;
      await api.post('/api/data/import', data);
      toast('Respaldo restaurado', 'ok');
      await ctx.refresh();
    } catch (err) { toast(`Archivo inválido: ${err.message}`, 'err'); }
  });

  void snap; void qsa;
}

export function onState() {}
