// Gráficos para OBS: logo, reloj, cintillo y títulos (estás viendo / a continuación / más tarde).
import { api } from '../api.js';
import { esc, toast, confirmDialog, formModal, qs, qsa, DOW, dayLabel } from '../ui.js';

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const g = boot.graphics;
  const overlayURL = `${location.origin}/overlay`;
  const ov = snap.overlay || {};

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Gráficos del canal</div>
        <div class="page-desc">Logo, reloj, cintillo y títulos se aplican directamente sobre OBS. Durante la publicidad se ocultan y se restauran automáticamente.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm" data-act="refresh">⟳ Reaplicar en OBS</button>
        <a class="btn btn-sm btn-primary" href="/overlay" target="_blank" rel="noopener">Abrir overlay ↗</a>
      </div>
    </div>

    <div class="monitor-grid">
      <div class="stack">
        <div class="preview" style="aspect-ratio:16/9">
          <div class="preview-bg" style="background:linear-gradient(135deg,#0f172a,#1e293b)">
            <div class="title-art" style="opacity:.5"><h3>VISTA PREVIA DE GRÁFICOS</h3><p>transmisión en vivo</p></div>
          </div>
          <iframe src="/overlay" title="Overlay" style="pointer-events:none"></iframe>
          <div class="preview-badge">BROWSER SOURCE · OBS</div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Cintillo informativo</div>
            <div class="card-actions">
              <div class="switch ${g.ticker.enabled ? 'on' : ''}" data-switch="ticker.enabled" title="Activar cintillo"></div>
            </div>
          </div>
          <div class="field">
            <label>Textos del cintillo (uno por línea)</label>
            <textarea id="ticker-text" rows="4" placeholder="Texto que camina en pantalla…">${esc((g.ticker.items || []).join('\n'))}</textarea>
            <div class="hint">Se unen automáticamente en un cintillo continuo. Puede desactivarlo durante la publicidad.</div>
          </div>
          <div class="row" style="gap:8px">
            <div class="field" style="flex:1;margin:0">
              <label>Velocidad</label>
              <select id="ticker-speed">
                ${[['lento', 'Lenta'], ['normal', 'Normal'], ['rapido', 'Rápida']].map(([v, l]) =>
                  `<option value="${v}" ${g.ticker.speed === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="field" style="flex:1;margin:0">
              <label>Visible ahora</label>
              <div class="row" style="height:38px"><div class="switch ${g.ticker.visible ? 'on' : ''}" data-switch="ticker.visible"></div>
              <span class="small muted">${g.ticker.visible ? 'En pantalla' : 'Oculto'}</span></div>
            </div>
            <button class="btn btn-primary" data-act="save-ticker" style="align-self:flex-end">Guardar</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Títulos programados por horario</div>
            <div class="card-actions"><button class="btn btn-xs" data-act="add-title">+ Programar título</button></div>
          </div>
          <div class="table-wrap">
            <table><thead><tr><th>Texto</th><th>Tipo</th><th>Horario</th><th>Días</th><th></th></tr></thead>
            <tbody>
              ${(g.scheduledTitles || []).map((s) => `<tr>
                <td>${esc(s.text)}</td>
                <td><span class="badge">${esc({ now: 'Estás viendo', next: 'A continuación', later: 'Más tarde' }[s.kind] || 'Estás viendo')}</span></td>
                <td class="mono small">${esc(s.from)}–${esc(s.to)}</td>
                <td class="small">${esc(dayLabel(s.days))}</td>
                <td><button class="btn btn-xs btn-danger" data-del-title="${s.id}">✕</button></td>
              </tr>`).join('') || '<tr><td colspan="5"><div class="empty">Sin títulos programados</div></td></tr>'}
            </tbody></table>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Logo permanente</div>
            <div class="card-actions"><div class="switch ${g.logo.enabled ? 'on' : ''}" data-switch="logo.enabled"></div></div>
          </div>
          <div class="field"><label>Texto / marca</label>
            <input type="text" id="logo-text" value="${esc(g.logo.text || '')}"></div>
          <div class="field"><label>URL del logo (opcional)</label>
            <input type="text" id="logo-image" value="${esc(g.logo.image || '')}" placeholder="https://…/logo.png"></div>
          <div class="inline-fields">
            <div class="field"><label>Posición</label>
              <select id="logo-position">
                ${[['top-left', 'Arriba izquierda'], ['top-right', 'Arriba derecha'], ['bottom-left', 'Abajo izquierda'], ['bottom-right', 'Abajo derecha']]
                  .map(([v, l]) => `<option value="${v}" ${g.logo.position === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></div>
            <div class="field"><label>Ancho (px)</label>
              <input type="number" id="logo-width" value="${g.logo.width || 150}" min="40" max="600"></div>
          </div>
          <div class="row" style="gap:8px;align-items:flex-end">
            <div class="field" style="flex:1;margin:0"><label>Opacidad</label>
              <input type="number" id="logo-opacity" value="${g.logo.opacity ?? 1}" min="0.1" max="1" step="0.05"></div>
            <button class="btn" data-act="save-logo">Guardar logo</button>
          </div>
          <div class="row" style="margin-top:10px;gap:8px">
            <div class="switch ${g.logo.visible ? 'on' : ''}" data-switch="logo.visible"></div>
            <span class="small muted">Mostrar en pantalla ahora</span>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Reloj automático</div>
            <div class="card-actions"><div class="switch ${g.clock.enabled ? 'on' : ''}" data-switch="clock.enabled"></div></div>
          </div>
          <div class="inline-fields">
            <div class="field"><label>Formato</label>
              <select id="clock-format">
                <option value="24" ${(g.clock.format || '24') === '24' ? 'selected' : ''}>24 horas</option>
                <option value="12" ${g.clock.format === '12' ? 'selected' : ''}>12 horas (AM/PM)</option>
              </select></div>
            <div class="field"><label>Posición</label>
              <select id="clock-position">
                ${[['top-left', 'Arriba izquierda'], ['top-right', 'Arriba derecha'], ['bottom-left', 'Abajo izquierda'], ['bottom-right', 'Abajo derecha']]
                  .map(([v, l]) => `<option value="${v}" ${g.clock.position === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></div>
          </div>
          <label class="check" style="margin-bottom:10px"><input type="checkbox" id="clock-seconds" ${g.clock.showSeconds !== false ? 'checked' : ''}> Mostrar segundos</label>
          <div class="row" style="gap:8px">
            <button class="btn" data-act="save-clock">Guardar reloj</button>
            <div class="switch ${g.clock.visible ? 'on' : ''}" data-switch="clock.visible"></div>
            <span class="small muted">Visible ahora</span>
          </div>
          <div class="help-box" style="margin-top:10px">Ahora: <span class="mono">${esc(ov.clock?.text || '--:--:--')}</span> · zona ${esc(boot.settings.app.timezone)}</div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Estás viendo / A continuación</div>
            <div class="card-actions"><div class="switch ${g.lowerThird.enabled ? 'on' : ''}" data-switch="lowerThird.enabled"></div></div>
          </div>
          <div class="field"><label>Título mostrado</label>
            <select id="lower-kind">
              ${[['auto', 'Automático (Estás viendo)'], ['now', 'Estás viendo'], ['next', 'A continuación'], ['later', 'Más tarde'], ['none', 'Sin título']]
                .map(([v, l]) => `<option value="${v}" ${(g.lowerThird.kind || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="kv"><span class="k">Etiqueta actual</span><span class="v">${esc(ov.lowerThird?.label || '—')}</span></div>
          <div class="kv"><span class="k">Título actual</span><span class="v">${esc(ov.lowerThird?.title || '—')}</span></div>
          <div class="row" style="margin-top:10px;gap:8px">
            <button class="btn" data-act="save-lower">Guardar</button>
            <div class="switch ${g.lowerThird.visible ? 'on' : ''}" data-switch="lowerThird.visible"></div>
            <span class="small muted">Visible ahora</span>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Fuentes en OBS</div></div>
          <div class="kv"><span class="k">Logo</span><span class="v mono">${esc(g.logo.source || 'Proca Logo')}</span></div>
          <div class="kv"><span class="k">Reloj</span><span class="v mono">${esc(g.clock.source || 'Proca Reloj')}</span></div>
          <div class="kv"><span class="k">Cintillo</span><span class="v mono">${esc(g.ticker.source || 'Proca Ticker')}</span></div>
          <div class="kv"><span class="k">Overlay URL</span><span class="v mono truncate" style="max-width:190px">${esc(overlayURL)}</span></div>
          <div class="help-box" style="margin-top:10px">
            Agregue una <strong>fuente de navegador</strong> en OBS con la URL del overlay (1920×1080, fondo transparente) para obtener el cintillo animado, el reloj y los títulos.
          </div>
        </div>
      </div>
    </div>
  `;

  async function patch(partial) {
    await api.patch('/api/graphics', partial);
    await ctx.refresh();
  }

  qsa('[data-switch]', root).forEach((sw) => sw.addEventListener('click', async () => {
    const path = sw.dataset.switch.split('.');
    const current = path.reduce((acc, k) => acc?.[k], g);
    const partial = {};
    let node = partial;
    path.forEach((k, i) => {
      if (i === path.length - 1) node[k] = !current;
      else node = node[k] = {};
    });
    try {
      await patch(partial);
      toast('Gráfico actualizado', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }));

  const action = async (name) => {
    try {
      if (name === 'refresh') {
        await api.post('/api/graphics/refresh');
        toast('Gráficos reaplicados en OBS', 'ok');
      } else if (name === 'save-ticker') {
        const text = qs('#ticker-text', root).value;
        const items = text.split('\n').map((s) => s.trim()).filter(Boolean);
        await patch({
          ticker: {
            items,
            text: items.join('   •   '),
            speed: qs('#ticker-speed', root).value,
            enabled: true,
          },
        });
        toast('Cintillo actualizado', 'ok');
      } else if (name === 'save-logo') {
        await patch({
          logo: {
            text: qs('#logo-text', root).value,
            image: qs('#logo-image', root).value,
            position: qs('#logo-position', root).value,
            width: Number(qs('#logo-width', root).value) || 150,
            opacity: Number(qs('#logo-opacity', root).value) || 1,
          },
        });
        toast('Logo actualizado', 'ok');
      } else if (name === 'save-clock') {
        await patch({
          clock: {
            format: qs('#clock-format', root).value,
            position: qs('#clock-position', root).value,
            showSeconds: qs('#clock-seconds', root).checked,
          },
        });
        toast('Reloj actualizado', 'ok');
      } else if (name === 'save-lower') {
        await patch({ lowerThird: { kind: qs('#lower-kind', root).value } });
        toast('Títulos actualizados', 'ok');
      } else if (name === 'add-title') {
        formModal({
          title: 'Programar título',
          fields: [
            { name: 'text', label: 'Texto del título', required: true, full: true, placeholder: 'Ej. Especial de aniversario' },
            { name: 'kind', label: 'Etiqueta', type: 'select', value: 'now', options: [
              { value: 'now', label: 'Estás viendo' }, { value: 'next', label: 'A continuación' }, { value: 'later', label: 'Más tarde' },
            ] },
            { name: 'days', label: 'Días', type: 'days', value: [0, 1, 2, 3, 4, 5, 6], full: true },
            { name: 'from', label: 'Desde', type: 'time', value: '00:00' },
            { name: 'to', label: 'Hasta', type: 'time', value: '23:59' },
          ],
          onSubmit: async (v) => {
            await api.post('/api/graphics/scheduled', v);
            toast('Título programado', 'ok');
            await ctx.refresh();
          },
        });
      }
    } catch (err) { toast(err.message, 'err'); }
  };

  qsa('[data-act]', root).forEach((b) => b.addEventListener('click', () => action(b.dataset.act)));
  qsa('[data-del-title]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog('¿Eliminar este título programado?', { danger: true, okLabel: 'Eliminar' })) return;
    await api.del(`/api/graphics/scheduled/${b.dataset.delTitle}`);
    await ctx.refresh();
  }));

  void DOW;
}

export function onState() {}
