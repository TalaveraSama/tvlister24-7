// Grabación de OBS: manual, programada y registro de sesiones.
import { api } from '../api.js';
import { esc, fmtDur, toast, confirmDialog, formModal, qs, qsa, dayLabel, fmtDateTime } from '../ui.js';

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const rec = boot.recording || {};
  const live = snap.recording || {};
  const active = live.active;
  const sessions = [...(rec.sessions || [])].reverse().slice(0, 20);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Grabación automatizada</div>
        <div class="page-desc">Inicie y detenga la grabación de OBS desde Proca, o programe ventanas horarias con audio. Cada sesión queda registrada con inicio, fin y resultado.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm ${active ? 'btn-danger' : 'btn-primary'}" data-act="toggle">
          ${active ? '⏹ Detener grabación' : '⏺ Iniciar grabación'}
        </button>
        <button class="btn btn-sm" data-act="new-schedule">+ Ventana programada</button>
      </div>
    </div>

    <div class="grid-3" style="margin-bottom:16px">
      <div class="card">
        <div class="row" style="gap:10px">
          <span class="rec-dot ${active ? '' : 'off'}"></span>
          <div>
            <div class="card-title">${active ? 'GRABANDO' : 'En espera'}</div>
            <div class="muted small">${active ? 'Grabación activa con audio' : 'Sin grabación en curso'}</div>
          </div>
          <span class="spacer"></span>
          <div class="stat-value mono" id="rec-elapsed">${active ? fmtDur((Date.now() - live.startedAt) / 1000) : '00:00'}</div>
        </div>
        ${rec.lastError ? `<div class="alert danger" style="margin-top:10px"><div><div class="a-title">Último error</div>${esc(rec.lastError)}</div></div>` : ''}
        <div class="kv" style="margin-top:10px"><span class="k">Inicio</span><span class="v mono">${active ? fmtDateTime(live.startedAt, boot.settings.app.timezone) : '—'}</span></div>
        <div class="kv"><span class="k">Archivo</span><span class="v mono truncate">${esc(live.outputPath || 'se define al finalizar')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">Ventanas programadas</div>
        <div class="stat-value" style="margin:6px 0">${(rec.schedules || []).length}</div>
        <div class="muted small">La grabación inicia y termina automáticamente dentro de cada ventana, solo si OBS está conectado.</div>
      </div>

      <div class="card">
        <div class="card-title">Sesiones registradas</div>
        <div class="stat-value" style="margin:6px 0">${(rec.sessions || []).length}</div>
        <div class="muted small">Historial de grabaciones con duración y motivo de cierre.</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="card-title">Programación de grabación</div>
        <div class="card-actions"><button class="btn btn-xs btn-primary" data-act="new-schedule">+ Agregar ventana</button></div>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Nombre</th><th>Días</th><th>Horario</th><th>Audio</th><th>Estado</th><th></th></tr></thead>
          <tbody>${(rec.schedules || []).map((s) => `<tr>
            <td>${esc(s.name)}</td>
            <td class="small">${esc(s.daysLabel || dayLabel(s.days))}</td>
            <td class="mono small">${esc(s.start)}–${esc(s.end)}</td>
            <td>${s.audio !== false ? '<span class="badge green">Sí</span>' : '<span class="badge gray">No</span>'}</td>
            <td>${s.enabled === false ? '<span class="badge gray">Off</span>' : '<span class="badge green">Activa</span>'}</td>
            <td class="nowrap">
              <button class="btn btn-xs" data-edit="${s.id}">Editar</button>
              <button class="btn btn-xs" data-toggle="${s.id}">${s.enabled === false ? '☐' : '☑'}</button>
              <button class="btn btn-xs btn-danger" data-del="${s.id}">✕</button>
            </td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">Sin ventanas programadas</div></td></tr>'}
          </tbody></table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">Historial de grabaciones</div>
        <div class="card-actions"><button class="btn btn-xs btn-danger" data-act="clear">Limpiar historial</button></div>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Inicio</th><th>Fin</th><th class="num">Duración</th><th>Origen</th><th>Archivo</th><th>Cierre</th></tr></thead>
          <tbody>${sessions.map((s) => `<tr>
            <td class="small mono">${fmtDateTime(s.startedAt, boot.settings.app.timezone)}</td>
            <td class="small mono">${s.endedAt ? fmtDateTime(s.endedAt, boot.settings.app.timezone) : '<span class="badge red">en curso</span>'}</td>
            <td class="num">${fmtDur(s.durationSec || (s.endedAt ? (s.endedAt - s.startedAt) / 1000 : 0))}</td>
            <td class="small">${esc(s.name || 'Manual')}</td>
            <td class="mono small muted truncate" style="max-width:240px">${esc(s.outputPath || '—')}</td>
            <td class="small muted">${esc(s.reason || '—')}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty">Aún no hay grabaciones</div></td></tr>'}
          </tbody></table>
      </div>
    </div>
  `;

  const scheduleForm = (s) => formModal({
    title: s ? 'Editar ventana de grabación' : 'Nueva ventana de grabación',
    fields: [
      { name: 'name', label: 'Nombre', value: s?.name || '', required: true, full: true, placeholder: 'Ej. Grabación matutina' },
      { name: 'days', label: 'Días', type: 'days', value: s?.days || [1, 2, 3, 4, 5], full: true },
      { name: 'start', label: 'Hora de inicio', type: 'time', value: s?.start || '06:00', required: true },
      { name: 'end', label: 'Hora de finalización', type: 'time', value: s?.end || '09:00', required: true },
      { name: 'audio', label: 'Audio', type: 'checkbox', value: s?.audio !== false, checkLabel: 'Grabar con audio' },
      { name: 'enabled', label: 'Estado', type: 'checkbox', value: s?.enabled !== false, checkLabel: 'Ventana activa' },
    ],
    onSubmit: async (v) => {
      if (s) await api.patch(`/api/recording/schedules/${s.id}`, v);
      else await api.post('/api/recording/schedules', v);
      toast(s ? 'Ventana actualizada' : 'Ventana creada', 'ok');
      await ctx.refresh();
    },
  });

  qsa('[data-act]', root).forEach((b) => b.addEventListener('click', async () => {
    try {
      if (b.dataset.act === 'toggle') {
        if (active) await api.post('/api/recording/stop', { reason: 'operador' });
        else await api.post('/api/recording/start', { name: 'Grabación manual' });
        toast(active ? 'Grabación finalizada' : 'Grabación iniciada', 'ok');
        await ctx.refresh();
      } else if (b.dataset.act === 'new-schedule') scheduleForm(null);
      else if (b.dataset.act === 'clear') {
        if (!await confirmDialog('¿Limpiar el historial de grabaciones?', { danger: true, okLabel: 'Limpiar' })) return;
        await api.del('/api/recording/sessions');
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  }));

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-edit],[data-toggle],[data-del]');
    if (!t) return;
    const s = (rec.schedules || []).find((x) => x.id === (t.dataset.edit || t.dataset.toggle || t.dataset.del));
    if (!s) return;
    try {
      if (t.dataset.edit) scheduleForm(s);
      else if (t.dataset.toggle) {
        await api.patch(`/api/recording/schedules/${s.id}`, { enabled: s.enabled === false });
        await ctx.refresh();
      } else if (t.dataset.del) {
        if (!await confirmDialog(`¿Eliminar la ventana "${s.name}"?`, { danger: true, okLabel: 'Eliminar' })) return;
        await api.del(`/api/recording/schedules/${s.id}`);
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  });
}

export function onState(snap, ctx) {
  if (ctx?.state?.name !== 'recording') return;
  const el = qs('#rec-elapsed');
  if (el && snap.recording?.active && snap.recording.startedAt) {
    el.textContent = fmtDur((Date.now() - snap.recording.startedAt) / 1000);
  }
}
