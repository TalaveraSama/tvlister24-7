// Intervención en vivo: cámaras y fuentes de OBS al aire sin desmontar la automatización.
import { api } from '../api.js';
import { esc, fmtDur, fmtTime, toast, confirmDialog, qs } from '../ui.js';

let liveRows = [];

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const liveInfo = await api.get('/api/live').catch(() => ({ scenes: [], inputs: [] }));
  const asrun = await api.get('/api/asrun?kind=live&limit=8').catch(() => ({ rows: [] }));
  liveRows = asrun.rows || [];
  const rt = snap.runtime;
  const active = rt.mode === 'live' ? rt.live : null;
  const scenes = liveInfo.scenes || [];
  const inputs = liveInfo.inputs || [];
  const cfg = boot.settings.obs;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Operación en vivo</div>
        <div class="page-desc">Envíe una cámara o fuente de OBS al aire de inmediato. La automatización queda en pausa y regresa sola al terminar la intervención, sin desmontar la parrilla.</div>
      </div>
    </div>

    ${active ? `
      <div class="card" style="border-color:rgba(244,63,94,.45);margin-bottom:16px">
        <div class="row wrap" style="gap:12px">
          <span class="badge red"><span class="dot-live"></span> EN VIVO</span>
          <strong style="font-size:16px">${esc(active.label || 'Intervención')}</strong>
          <span class="muted small">${esc(active.sceneName || 'escena actual')} · ${esc(active.sourceName || 'fuente actual')}</span>
          <span class="spacer"></span>
          <div class="stat" style="padding:6px 12px">
            <div class="stat-label">Tiempo al aire</div>
            <div class="stat-value sm mono" id="live-elapsed">${fmtDur((Date.now() - active.startedAt) / 1000)}</div>
          </div>
          <div class="stat" style="padding:6px 12px">
            <div class="stat-label">Finaliza</div>
            <div class="stat-value sm mono" id="live-remaining">${active.endAt ? fmtTime(active.endAt) : 'manual'}</div>
          </div>
          <button class="btn btn-warn" data-act="end">Devolver control al sistema</button>
        </div>
        <div class="help-box" style="margin-top:12px">
          Al finalizar, Proca restaura la programación exactamente donde quedó (o retoma el bloque de parrilla vigente) y vuelve a aplicar los gráficos.
        </div>
      </div>` : ''}

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Enviar señal al aire</div>
            <div class="card-actions"><span class="badge">${scenes.length} escenas · ${inputs.length} fuentes</span></div>
          </div>
          <div class="field"><label>Nombre de la intervención</label>
            <input type="text" id="live-label" placeholder="Ej. Noticiero especial" value="Intervención en vivo"></div>
          <div class="inline-fields">
            <div class="field"><label>Escena de OBS</label>
              <select id="live-scene">
                <option value="">— Escena configurada (${esc(cfg.liveScene || 'ninguna')}) —</option>
                ${scenes.map((s) => `<option value="${esc(s.sceneName)}">${esc(s.sceneName)}</option>`).join('')}
              </select></div>
            <div class="field"><label>Fuente / cámara</label>
              <select id="live-source">
                <option value="">— Sin fuente específica —</option>
                ${inputs.map((i) => `<option value="${esc(i.inputName)}">${esc(i.inputName)} (${esc(i.inputKind)})</option>`).join('')}
              </select></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Duración (minutos)</label>
              <input type="number" id="live-duration" min="0" step="1" value="30" placeholder="0 = sin límite">
              <div class="hint">0 = finaliza manualmente</div></div>
            <div class="field"><label>Hora exacta de salida (opcional)</label>
              <input type="time" id="live-end"></div>
          </div>
          <button class="btn btn-primary btn-block" data-act="start" ${active ? 'disabled' : ''}>● Enviar al aire ahora</button>
          <div class="help-box" style="margin-top:12px">
            No es necesario transmitir desde Proca: OBS conserva sus propias salidas y configuración de streaming. Proca solo controla qué señal está al aire.
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Historial de intervenciones</div>
            <div class="card-actions"><a class="btn btn-xs" href="#/asrun">Ver As-Run</a></div>
          </div>
          <div class="table-wrap">
            <table><thead><tr><th>Inicio</th><th>Intervención</th><th class="num">Duración</th><th>Salida</th></tr></thead>
              <tbody>${liveRows.length ? liveRows.map((r) => `<tr>
                <td class="mono small">${esc(r.startLabel || '')}</td>
                <td>${esc(r.title)}</td>
                <td class="num">${fmtDur(r.durationSec || 0)}</td>
                <td class="small muted">${esc(r.exitReason || '—')}</td></tr>`).join('')
                : '<tr><td colspan="4"><div class="empty">Sin intervenciones registradas</div></td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Escenas de OBS</div>
            <div class="card-actions"><button class="btn btn-xs" data-act="refresh">⟳</button></div>
          </div>
          <div class="stack" style="gap:6px">
            ${scenes.map((s) => `<button class="list-row" data-scene="${esc(s.sceneName)}" style="width:100%;text-align:left;background:var(--panel);cursor:pointer">
              <span class="title">${esc(s.sceneName)}</span>
              ${snap.obs?.currentScene === s.sceneName ? '<span class="badge green">AL AIRE</span>' : ''}
            </button>`).join('') || '<div class="muted small">OBS sin escenas detectadas.</div>'}
          </div>
          <div class="help-box" style="margin-top:10px">Al hacer clic en una escena se cambia la salida de OBS de inmediato (útil para pruebas o cortes).</div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Fuentes disponibles</div></div>
          <div class="stack" style="gap:4px;max-height:260px;overflow:auto">
            ${inputs.map((i) => `<div class="kv"><span class="k">${esc(i.inputName)}</span>
              <span class="v mono" style="font-size:10.5px">${esc(i.inputKind)}</span></div>`).join('') || '<div class="muted small">Sin fuentes.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Regreso automático</div></div>
          <ul class="small muted" style="margin:0;padding-left:16px;line-height:1.9">
            <li>Al terminar el tiempo, regresa a la parrilla o lista 24/7.</li>
            <li>La emergencia y la publicidad quedan suspendidas durante la intervención.</li>
            <li>Los gráficos se restauran con el contenido que vuelve al aire.</li>
            <li>Todo queda registrado en el As-Run con hora de inicio y salida.</li>
          </ul>
        </div>
      </div>
    </div>
  `;

  root.addEventListener('click', async (e) => {
    const sceneBtn = e.target.closest('[data-scene]');
    if (sceneBtn) {
      try {
        await api.post('/api/obs/scene', { scene: sceneBtn.dataset.scene });
        toast(`Escena al aire: ${sceneBtn.dataset.scene}`, 'ok');
        await ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      if (btn.dataset.act === 'refresh') {
        await api.post('/api/obs/refresh');
        await ctx.refresh();
        toast('Fuentes actualizadas', 'ok');
      } else if (btn.dataset.act === 'start') {
        const label = qs('#live-label', root).value.trim() || 'Intervención en vivo';
        const sceneName = qs('#live-scene', root).value;
        const sourceName = qs('#live-source', root).value;
        const durationMin = Number(qs('#live-duration', root).value) || 0;
        const endTime = qs('#live-end', root).value;
        let endAt = null;
        if (endTime) {
          const [h, m] = endTime.split(':').map(Number);
          const d = new Date();
          d.setHours(h, m, 0, 0);
          if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
          endAt = d.toISOString();
        }
        if (endAt || durationMin) {
          const ok = await confirmDialog(`La señal entrará al aire ${endAt ? `hasta las ${endTime}` : `por ${durationMin} minutos`}. La programación se reanudará automáticamente.`, { okLabel: 'Enviar al aire' });
          if (!ok) return;
        }
        await api.post('/api/live/start', { label, sceneName, sourceName, durationMin, endAt });
        toast('Intervención en vivo al aire', 'ok');
        await ctx.refresh();
      } else if (btn.dataset.act === 'end') {
        if (!await confirmDialog('¿Devolver el control a la automatización?', { okLabel: 'Devolver control' })) return;
        await api.post('/api/live/end');
        toast('Programación restaurada', 'ok');
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  });
}

export function onState(snap, ctx) {
  if (ctx?.state?.name !== 'live') return;
  const rt = snap.runtime;
  const elapsed = qs('#live-elapsed');
  if (elapsed && rt.mode === 'live' && rt.live) {
    elapsed.textContent = fmtDur((Date.now() - rt.live.startedAt) / 1000);
  }
  const remaining = qs('#live-remaining');
  if (remaining && rt.mode === 'live' && rt.live?.endAt) {
    const left = Math.max(0, (rt.live.endAt - Date.now()) / 1000);
    remaining.textContent = `${fmtTime(rt.live.endAt)} (${fmtDur(left)})`;
  }
}
