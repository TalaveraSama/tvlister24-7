// Anti pantalla negra: supervisión, playlist de emergencia y registro de activaciones.
import { api } from '../api.js';
import { esc, fmtDur, toast, confirmDialog, formModal, qs, qsa } from '../ui.js';
import { fmtDateTime } from '../ui.js';

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const em = await api.get('/api/emergency').catch(() => boot.emergency);
  const activations = (await api.get('/api/asrun?kind=emergency&limit=12').catch(() => ({ rows: [] }))).rows;
  const playlists = boot.playlists || [];
  const media = boot.media || [];
  const active = em.active;
  const isMock = snap.obs?.mock;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Anti pantalla negra</div>
        <div class="page-desc">Proca supervisa la reproducción de OBS. Si detecta silencio o contenido detenido, activa una playlist de emergencia y protege la señal hasta recuperar el control.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-warn" data-act="test">⚠ Probar emergencia</button>
        ${active ? '<button class="btn btn-sm btn-primary" data-act="exit">⟲ Regresar a programación</button>' : ''}
      </div>
    </div>

    ${active ? `<div class="card" style="border-color:rgba(244,63,94,.5);margin-bottom:16px">
      <div class="row wrap">
        <span class="badge red"><span class="dot-live"></span> EMERGENCIA ACTIVA</span>
        <strong>${esc(em.info?.reason || 'Caída de señal')}</strong>
        <span class="muted small">desde ${fmtDateTime(em.info?.startedAt, boot.settings.app.timezone)}</span>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" data-act="exit">Restaurar programación</button>
      </div>
    </div>` : `<div class="alert ok" style="margin-bottom:16px"><div><div class="a-title">Protección activa</div>
      La señal está siendo supervisada cada segundo. Las activaciones quedan registradas en el As-Run.</div></div>`}

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Configuración de protección</div>
            <div class="card-actions"><div class="switch ${em.enabled ? 'on' : ''}" data-act="toggle-enabled"></div></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Detección de silencio (segundos)</label>
              <input type="number" id="silence" value="${em.silenceSeconds ?? 15}" min="3"></div>
            <div class="field"><label>Detección de reproducción detenida (segundos)</label>
              <input type="number" id="noprogress" value="${em.noProgressSeconds ?? 25}" min="5"></div>
            <div class="field"><label>Recuperación tras (segundos)</label>
              <input type="number" id="recover" value="${em.recoverAfterSec ?? 10}" min="1"></div>
          </div>
          <div class="field"><label>Carpeta especial de emergencia</label>
            <input type="text" id="efolder" value="${esc(em.folder || '')}" placeholder="/ruta/a/videos/emergencia">
            <div class="hint">Opcional: puede usar una playlist de emergencia en lugar de una carpeta.</div></div>
          <label class="check" style="margin-bottom:10px"><input type="checkbox" id="autorecover" ${em.autoRecover !== false ? 'checked' : ''}> Regresar automáticamente a la programación cuando la señal se recupere</label>
          <div class="row" style="gap:8px">
            <button class="btn btn-primary" data-act="save">Guardar configuración</button>
            ${isMock ? '<button class="btn" data-act="sim-silence">Simular silencio</button><button class="btn" data-act="sim-stall">Simular detención</button>' : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Playlist de emergencia</div>
            <div class="card-actions"><span class="badge">${em.mediaCount || 0} elementos</span></div>
          </div>
          <div class="stack" style="gap:6px">
            ${playlists.map((p) => `<button class="list-row" data-playlist="${p.id}"
              style="width:100%;text-align:left;cursor:pointer;background:${em.playlistId === p.id ? 'rgba(34,211,238,.08)' : 'var(--panel)'};border-color:${em.playlistId === p.id ? 'rgba(34,211,238,.4)' : 'var(--line)'}">
              <span class="title">${esc(p.name)}</span>
              <span class="meta">${p.resolvedCount}</span>
              ${em.playlistId === p.id ? '<span class="badge cyan">ASIGNADA</span>' : ''}
            </button>`).join('')}
          </div>
          <div class="help-box" style="margin-top:10px">Se recomienda una lista corta con contenido institucional o un ident del canal. Si falla la señal principal, este contenido sale al aire de inmediato.</div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Contenido de respaldo individual</div>
            <div class="card-actions"><button class="btn btn-xs" data-act="add-media">+ Agregar</button></div>
          </div>
          <div class="stack" style="gap:4px">
            ${(em.mediaIds || []).map((id) => {
              const m = media.find((x) => x.id === id);
              return m ? `<div class="list-row" style="padding:6px 9px">
                <span class="title small">${esc(m.title)}</span>
                <span class="meta">${fmtDur(m.duration)}</span>
                <button class="btn btn-xs btn-danger" data-rm-media="${id}">✕</button></div>` : '';
            }).join('') || '<div class="muted small">Sin medios de respaldo adicionales.</div>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Cómo detecta Proca la caída</div></div>
          <ul class="small muted" style="margin:0;padding-left:16px;line-height:1.9">
            <li>Silencio en el medidor de audio de la fuente.</li>
            <li>Estado de reproducción detenido o finalizado inesperadamente.</li>
            <li>El cursor de medios deja de avanzar.</li>
            <li>Si no hay contenido de emergencia, se muestra el slate y el canal nunca queda en negro.</li>
          </ul>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Activaciones</div>
            <div class="card-actions"><span class="badge">${em.activations || 0}</span></div>
          </div>
          <div class="stack" style="gap:6px">
            ${activations.length ? activations.map((r) => `<div style="border:1px solid var(--line);border-radius:8px;padding:8px">
              <div class="row"><span class="badge red">EMERGENCIA</span><strong class="small">${esc(r.title)}</strong></div>
              <div class="muted small" style="margin-top:4px">${fmtDateTime(r.ts, boot.settings.app.timezone)}
              ${r.recoveredAt ? ` · recuperada ${fmtDateTime(r.recoveredAt, boot.settings.app.timezone)}` : ''}</div>
            </div>`).join('') : '<div class="muted small">Sin activaciones registradas. El sistema no ha tenido que intervenir.</div>'}
          </div>
        </div>
      </div>
    </div>
  `;

  const save = async (partial) => {
    await api.patch('/api/emergency', partial);
    toast('Configuración guardada', 'ok');
    await ctx.refresh();
  };

  root.addEventListener('click', async (e) => {
    const plBtn = e.target.closest('[data-playlist]');
    if (plBtn) {
      try { await save({ playlistId: plBtn.dataset.playlist }); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const rm = e.target.closest('[data-rm-media]');
    if (rm) {
      const next = (em.mediaIds || []).filter((id) => id !== rm.dataset.rmMedia);
      try { await save({ mediaIds: next }); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      const act = btn.dataset.act;
      if (act === 'toggle-enabled') return save({ enabled: !em.enabled });
      if (act === 'save') {
        return save({
          silenceSeconds: Number(qs('#silence', root).value),
          noProgressSeconds: Number(qs('#noprogress', root).value),
          recoverAfterSec: Number(qs('#recover', root).value),
          folder: qs('#efolder', root).value,
          autoRecover: qs('#autorecover', root).checked,
          enabled: em.enabled,
        });
      }
      if (act === 'test') {
        if (!await confirmDialog('La playlist de emergencia saldrá al aire. Al terminar puede regresar la programación.', { okLabel: 'Probar' })) return;
        await api.post('/api/emergency/test');
        toast('Emergencia activada', 'warn');
        await ctx.refresh();
      } else if (act === 'exit') {
        await api.post('/api/emergency/exit');
        toast('Programación restaurada', 'ok');
        await ctx.refresh();
      } else if (act === 'sim-silence' || act === 'sim-stall') {
        await api.post('/api/obs/simulate', { what: act === 'sim-silence' ? 'silence' : 'stall' });
        toast('Falla simulada. El anti dead-air actuará en segundos.', 'warn');
      } else if (act === 'add-media') {
        const { openMediaPicker } = await import('../components.js');
        const chosen = await openMediaPicker({ title: 'Agregar respaldo de emergencia', multiple: true });
        if (!chosen?.length) return;
        await save({ mediaIds: [...new Set([...(em.mediaIds || []), ...chosen.map((m) => m.id)])] });
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  void formModal; void qsa;
}

export function onState() {}
