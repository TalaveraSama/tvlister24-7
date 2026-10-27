// Registro As-Run: historial de lo que realmente salió al aire.
import { api } from '../api.js';
import { esc, fmtDur, fmtDateTime, toast, confirmDialog, qs, qsa } from '../ui.js';
import { download } from '../components.js';

const KIND_OPTIONS = [
  ['all', 'Todo'], ['program', 'Programas'], ['ad', 'Publicidad'], ['bumper', 'Cortinas'],
  ['live', 'En vivo'], ['emergency', 'Emergencias'], ['slate', 'Slate'],
];

const KIND_CLASS = { program: 'cyan', ad: 'amber', bumper: 'violet', live: 'red', emergency: 'red', slate: 'gray' };
const KIND_LABEL = { program: 'Programa', ad: 'Publicidad', bumper: 'Cortina', live: 'En vivo', emergency: 'Emergencia', slate: 'Slate' };

let filters = { kind: 'all', q: '', from: '', to: '' };

export async function render(root, ctx) {
  const { boot } = ctx.state;
  const tz = boot.settings.app.timezone;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Registro As-Run</div>
        <div class="page-desc">Historial real de emisión: programas, publicidad, cortinas, intervenciones y emergencias, con inicio, fin y motivo de salida.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm" data-act="export">⬇ Exportar CSV</button>
        <button class="btn btn-sm btn-danger" data-act="clear">Limpiar</button>
      </div>
    </div>

    <div class="toolbar">
      <input type="search" id="q" placeholder="Buscar título, bloque…" value="${esc(filters.q)}">
      <select id="kind">
        ${KIND_OPTIONS.map(([v, l]) => `<option value="${v}" ${filters.kind === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input type="date" id="from" value="${esc(filters.from)}" style="max-width:170px">
      <input type="date" id="to" value="${esc(filters.to)}" style="max-width:170px">
      <button class="btn btn-sm" data-act="apply">Filtrar</button>
      <span class="spacer"></span>
      <span class="muted small" id="count">—</span>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Inicio</th><th>Fin</th><th class="num">Duración</th><th>Tipo</th><th>Título</th>
          <th>Bloque / lista</th><th>Modo</th><th>Salida</th></tr></thead>
        <tbody id="rows"><tr><td colspan="8"><div class="loading">Cargando…</div></td></tr></tbody>
      </table>
    </div>
    <div class="help-box" style="margin-top:12px">El registro se conserva entre reinicios (hasta 5.000 entradas) y se puede exportar a CSV compatible con Excel.</div>
  `;

  const rowsEl = qs('#rows', root);

  async function load() {
    const params = new URLSearchParams();
    params.set('kind', filters.kind);
    params.set('limit', '300');
    if (filters.q) params.set('q', filters.q);
    if (filters.from) params.set('from', String(new Date(`${filters.from}T00:00:00`).getTime()));
    if (filters.to) params.set('to', String(new Date(`${filters.to}T23:59:59`).getTime()));
    const res = await api.get(`/api/asrun?${params.toString()}`);
    qs('#count', root).textContent = `${res.total} registros`;
    rowsEl.innerHTML = res.rows.length ? res.rows.map((r) => `<tr>
      <td class="mono small nowrap">${fmtDateTime(r.ts, tz)}</td>
      <td class="mono small nowrap muted">${r.endTs ? fmtDateTime(r.endTs, tz) : 'al aire'}</td>
      <td class="num">${fmtDur(r.durationSec || 0)}</td>
      <td><span class="badge ${KIND_CLASS[r.kind] || ''}">${esc(KIND_LABEL[r.kind] || r.kind)}</span></td>
      <td class="truncate" style="max-width:320px">${esc(r.title)}</td>
      <td class="small muted">${esc(r.block || r.playlistName || '—')}</td>
      <td class="small muted">${esc(r.mode || '—')}</td>
      <td class="small muted">${esc(r.exitReason || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty">Sin registros para este filtro</div></td></tr>';
  }

  await load();

  qs('#kind', root).addEventListener('change', (e) => { filters.kind = e.target.value; load(); });
  qs('#q', root).addEventListener('input', (e) => {
    filters.q = e.target.value;
    clearTimeout(window.__asrunTimer);
    window.__asrunTimer = setTimeout(load, 300);
  });
  qs('#from', root).addEventListener('change', (e) => { filters.from = e.target.value; load(); });
  qs('#to', root).addEventListener('change', (e) => { filters.to = e.target.value; load(); });
  qsa('[data-act]', root).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.act === 'apply') load();
    else if (b.dataset.act === 'export') {
      const params = new URLSearchParams({ kind: filters.kind });
      if (filters.from) params.set('from', String(new Date(`${filters.from}T00:00:00`).getTime()));
      if (filters.to) params.set('to', String(new Date(`${filters.to}T23:59:59`).getTime()));
      download(`/api/asrun/export.csv?${params.toString()}`);
      toast('Reporte exportado', 'ok');
    } else if (b.dataset.act === 'clear') {
      if (!await confirmDialog('¿Borrar todo el historial As-Run? Esta acción no se puede deshacer.', { danger: true, okLabel: 'Borrar' })) return;
      await api.del('/api/asrun');
      toast('Historial borrado', 'ok');
      await load();
      await ctx.refreshQuiet?.();
    }
  }));
}

export function onState() {}
