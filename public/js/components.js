// Componentes compartidos entre vistas: selectores de medios y listas.
import { api } from './api.js';
import { esc, openModal, toast, fmtDur, qs } from './ui.js';

export function openMediaPicker({ title = 'Elegir medio', multiple = false, filter, note = '' } = {}) {
  return new Promise(async (resolve) => {
    let media = [];
    try {
      const res = await api.get('/api/media');
      media = res.rows || [];
    } catch (err) {
      toast(err.message, 'err');
      resolve(null);
      return;
    }
    if (filter) media = media.filter(filter);
    const selected = new Set();

    const body = document.createElement('div');
    body.innerHTML = `
      ${note ? `<div class="help-box" style="margin-bottom:10px">${esc(note)}</div>` : ''}
      <div class="toolbar" style="margin-bottom:8px">
        <input type="search" placeholder="Buscar por título, categoría…" data-role="q">
        <span class="muted small" data-role="count">${media.length} medios</span>
      </div>
      <div class="table-wrap" style="max-height:46vh;overflow-y:auto">
        <table><thead><tr>
          ${multiple ? '<th style="width:34px"></th>' : ''}
          <th>Título</th><th>Categoría</th><th class="num">Duración</th>
        </tr></thead><tbody data-role="rows"></tbody></table>
      </div>`;

    const rowsEl = body.querySelector('[data-role="rows"]');
    const countEl = body.querySelector('[data-role="count"]');

    function draw() {
      const q = (body.querySelector('[data-role="q"]').value || '').toLowerCase();
      const list = media.filter((m) => `${m.title} ${m.category} ${m.genre} ${m.name}`.toLowerCase().includes(q));
      countEl.textContent = `${list.length} medios`;
      rowsEl.innerHTML = list.length ? list.map((m) => `
        <tr data-id="${m.id}" style="cursor:pointer">
          ${multiple ? `<td><input type="checkbox" data-check="${m.id}" ${selected.has(m.id) ? 'checked' : ''}></td>` : ''}
          <td><div class="row"><span class="media-thumb"></span>${esc(m.title)}</div>
              <div class="muted" style="font-size:10.5px;margin-left:44px">${esc(m.path || 'demo')}</div></td>
          <td>${m.category ? `<span class="chip">${esc(m.category)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="num">${fmtDur(m.duration)}</td>
        </tr>`).join('') : '<tr><td colspan="4"><div class="empty">Sin resultados</div></td></tr>';
    }
    draw();

    body.querySelector('[data-role="q"]').addEventListener('input', draw);

    rowsEl.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const id = tr.dataset.id;
      if (multiple) {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
        draw();
      } else {
        const m = media.find((x) => x.id === id);
        modal.close();
        resolve(m || null);
      }
    });

    const footer = document.createElement('div');
    footer.innerHTML = `<button class="btn" data-x="cancel">Cancelar</button>
      ${multiple ? '<button class="btn btn-primary" data-x="ok">Agregar seleccionados</button>' : ''}`;

    const modal = openModal({ title, body, footer, wide: true });
    footer.querySelector('[data-x="cancel"]').onclick = () => { modal.close(); resolve(null); };
    footer.querySelector('[data-x="ok"]')?.addEventListener('click', () => {
      const chosen = media.filter((m) => selected.has(m.id));
      modal.close();
      resolve(chosen);
    });
  });
}

export async function openPlaylistPicker({ title = 'Elegir lista' } = {}) {
  const res = await api.get('/api/playlists');
  if (!res.length) {
    toast('No hay listas creadas', 'warn');
    return null;
  }
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.innerHTML = `<div class="stack">${res.map((p) => `
      <button class="list-row" data-id="${p.id}" style="width:100%;text-align:left;cursor:pointer;background:var(--panel)">
        <span class="title">${esc(p.name)}</span>
        <span class="meta">${p.resolvedCount} elementos</span>
      </button>`).join('')}</div>`;
    const modal = openModal({ title, body });
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-id]');
      if (!btn) return;
      const p = res.find((x) => x.id === btn.dataset.id);
      modal.close();
      resolve(p);
    });
  });
}

export function statCard(label, value, hint = '') {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${value}</div>${hint ? `<div class="muted small" style="margin-top:4px">${esc(hint)}</div>` : ''}</div>`;
}

export function kvRow(key, value) {
  return `<div class="kv"><span class="k">${esc(key)}</span><span class="v">${value}</span></div>`;
}

/** Descarga un archivo del servidor. */
export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function emptyState(title, text) {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
}

export function scrollIntoViewIfNeeded(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest' });
}

export function q(sel, root) { return qs(sel, root); }
