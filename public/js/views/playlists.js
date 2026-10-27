// Listas de reproducción 24/7: medios individuales, carpetas completas y categorías.
import { api } from '../api.js';
import {
  esc, fmtDur, toast, confirmDialog, formModal, openModal, qs, qsa, stateLabel, openContextMenu,
} from '../ui.js';
import { openMediaPicker, emptyState } from '../components.js';

let selectedId = null;
let detail = null;
let clipboard = null; // { mode, entries, ids, sourcePlaylistId }

const TYPE_INFO = {
  media: { label: 'Video', cls: 'cyan', icon: '▶' },
  category: { label: 'Categoría', cls: 'violet', icon: '▤' },
  folder: { label: 'Carpeta', cls: 'amber', icon: '▣' },
  playlist: { label: 'Lista', cls: 'green', icon: '≡' },
  slot: { label: 'File Slot', cls: 'green', icon: '⧉' },
};

function mediaById(boot, id) {
  return boot.media.find((m) => m.id === id);
}

function categoryCount(boot, name) {
  return boot.media.filter((m) => m.category === name).length;
}

function folderCount(boot, path) {
  const f = String(path || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return boot.media.filter((m) => String(m.folderPath || m.path || '').replace(/\\/g, '/').toLowerCase().startsWith(f + '/')).length;
}

function itemRow(item, index, boot, playlistId) {
  const info = TYPE_INFO[item.type] || TYPE_INFO.media;
  let title = '';
  let meta = '';
  if (item.type === 'media') {
    const m = mediaById(boot, item.mediaId);
    title = m?.title || 'Medio eliminado';
    meta = m ? `${fmtDur(m.duration)} · ${m.category || 'sin categoría'}` : 'no disponible';
  } else if (item.type === 'category') {
    title = `Categoría: ${item.category}`;
    meta = `${categoryCount(boot, item.category)} medios`;
  } else if (item.type === 'folder') {
    title = `Carpeta: ${item.folderPath}`;
    meta = `${folderCount(boot, item.folderPath)} archivos`;
  } else if (item.type === 'playlist') {
    const p = boot.playlists.find((x) => x.id === item.playlistId);
    title = `Lista: ${p?.name || 'eliminada'}`;
    meta = p ? `${p.resolvedCount} elementos` : '';
  } else if (item.type === 'slot') {
    const sl = (boot.slots || []).find((x) => x.id === item.slotId);
    title = `Slot: ${sl?.name || 'eliminado'}`;
    meta = sl ? `${sl.count} archivos · rota en cada emisión` : '';
  }
  return `<div class="list-row" draggable="true" data-item="${item.id}" data-index="${index}">
    <span class="grip">⋮⋮</span>
    <span class="idx">${String(index + 1).padStart(2, '0')}</span>
    <span class="badge ${info.cls}">${info.icon} ${info.label}</span>
    <span class="title">${esc(title)}</span>
    <span class="meta">${esc(meta)}</span>
    <button class="btn btn-xs" data-up="${item.id}" title="Subir">↑</button>
    <button class="btn btn-xs" data-down="${item.id}" title="Bajar">↓</button>
    <button class="btn btn-xs btn-danger" data-del="${item.id}" title="Quitar">✕</button>
    <input type="hidden" value="${esc(playlistId)}">
  </div>`;
}

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const lists = boot.playlists;
  if (!lists.length) {
    root.innerHTML = `<div class="card"><div class="empty"><strong>Sin listas</strong>Cree su primera lista de reproducción.</div></div>`;
    return;
  }
  if (!selectedId || !lists.some((l) => l.id === selectedId)) selectedId = lists[0].id;
  try {
    detail = await api.get(`/api/playlists/${selectedId}`);
  } catch {
    detail = lists.find((l) => l.id === selectedId);
  }

  const rt = snap.runtime;
  const onAir = rt.playlistId === selectedId;
  const categories = [...new Set(boot.media.map((m) => m.category).filter(Boolean))];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Listas 24/7</div>
        <div class="page-desc">Las listas alimentan la automatización continua. Al terminar el último elemento, la lista vuelve al primero sin dejar la pantalla en negro.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm" data-act="new">+ Nueva lista</button>
        <button class="btn btn-sm btn-primary" data-act="play" ${detail?.items?.length ? '' : 'disabled'}>
          ${onAir ? '⇄ Reiniciar al aire' : '▶ Enviar al aire'}
        </button>
      </div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div class="card-title">${esc(detail?.name || 'Lista')}
              ${onAir ? '<span class="badge cyan" style="margin-left:6px">AL AIRE</span>' : ''}
            </div>
            <div class="card-actions">
              <button class="btn btn-xs" data-act="edit">Editar</button>
              <button class="btn btn-xs" data-act="dup">Duplicar</button>
              <button class="btn btn-xs btn-danger" data-act="del">Eliminar</button>
            </div>
          </div>
          <div class="row wrap" style="gap:14px">
            <div class="small muted">Orden:
              <select id="order-select" style="display:inline-block;width:auto;margin-left:4px;padding:3px 26px 3px 8px;font-size:12px">
                ${[['manual', 'Manual'], ['alpha', 'Alfabético'], ['random', 'Aleatorio'], ['season', 'Temporada/Episodio']]
                  .map(([v, l]) => `<option value="${v}" ${detail?.order === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <label class="check"><input type="checkbox" id="loop-check" ${detail?.loop !== false ? 'checked' : ''}> Ciclo continuo 24/7</label>
            <span class="small muted">${detail?.resolvedItems?.length || 0} elementos reproducibles</span>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Contenido de la lista <span class="sub">${(detail?.items || []).length} bloques</span></div>
            <div class="card-actions">
              <button class="btn btn-xs" data-add="media">+ Videos</button>
              <button class="btn btn-xs" data-add="category">+ Categoría</button>
              <button class="btn btn-xs" data-add="folder">+ Carpeta</button>
              <button class="btn btn-xs" data-add="slot">+ File Slot</button>
            </div>
          </div>
          <div id="items-list">
            ${(detail?.items || []).map((it, i) => itemRow(it, i, boot, selectedId)).join('')
              || '<div class="empty" style="padding:22px"><strong>Lista vacía</strong>Agregue videos, categorías o carpetas completas.</div>'}
          </div>
          <div class="help-box" style="margin-top:12px">
            Arrastre los elementos para reordenarlos. Las categorías y carpetas se expanden automáticamente al reproducir.
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Vista resuelta <span class="sub">así quedará la secuencia al aire</span></div>
            <div class="card-actions"><span class="badge">${(detail?.resolvedItems || []).length} elementos</span></div>
          </div>
          <div class="table-wrap" style="max-height:320px;overflow:auto">
            <table><thead><tr><th class="num">#</th><th>Título</th><th>Categoría</th><th class="num">Duración</th><th></th></tr></thead>
            <tbody>
              ${(detail?.resolvedItems || []).slice(0, 80).map((it, i) => `
                <tr><td class="num">${i + 1}</td>
                <td class="truncate" style="max-width:360px">${esc(it.title)}</td>
                <td class="muted">${esc(it.category || '—')}</td>
                <td class="num">${fmtDur(it.durationSec)}</td>
                <td><button class="btn btn-xs" data-air="${esc(it.mediaId)}">Al aire</button></td></tr>`).join('')
                || '<tr><td colspan="5"><div class="empty">Sin elementos reproducibles</div></td></tr>'}
            </tbody></table>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div class="card-title">Todas las listas</div>
            <div class="card-actions"><span class="badge">${lists.length}</span></div>
          </div>
          <div class="stack" style="gap:6px">
            ${lists.map((p) => `
              <button class="list-row" data-select="${p.id}" style="width:100%;text-align:left;cursor:pointer;background:${p.id === selectedId ? 'rgba(34,211,238,.08)' : 'var(--panel)'};border-color:${p.id === selectedId ? 'rgba(34,211,238,.4)' : 'var(--line)'}">
                <span class="title">${esc(p.name)}</span>
                <span class="meta">${p.resolvedCount}</span>
              </button>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Contenido disponible</div></div>
          ${['Categorías', 'Carpetas'].map((titulo, i) => `
            <div class="small muted" style="margin:6px 0 4px">${titulo}</div>
            <div class="row wrap" style="gap:4px">
              ${(i === 0 ? categories : (boot.settings.mediaFolders || [])).slice(0, 12).map((c) => `
                <span class="chip">${esc(i === 0 ? c : c.split('/').slice(-2).join('/'))}</span>`).join('')
                || '<span class="muted small">Ninguna</span>'}
            </div>`).join('')}
          <a class="btn btn-sm btn-block" href="#/library" style="margin-top:12px">Ir a la biblioteca</a>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Estado de la señal</div></div>
          <div class="kv"><span class="k">Modo</span><span class="v">${esc(stateLabel(rt.mode))}</span></div>
          <div class="kv"><span class="k">Al aire</span><span class="v">${esc(rt.sourceName || '—')}</span></div>
          <div class="kv"><span class="k">Elemento</span><span class="v">${rt.currentItem ? `${rt.index + 1}. ${esc(rt.currentItem.title)}` : '—'}</span></div>
          <div class="kv"><span class="k">Cola</span><span class="v">${rt.itemCount || 0} elementos</span></div>
        </div>
      </div>
    </div>
  `;

  wire(root, ctx, lists);
}

function wire(root, ctx, lists) {
  qsa('[data-select]', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedId = btn.dataset.select;
      ctx.rerender();
    });
  });

  qs('#order-select', root)?.addEventListener('change', async (e) => {
    try {
      await api.patch(`/api/playlists/${selectedId}`, { order: e.target.value });
      toast('Orden actualizado', 'ok');
      await ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  qs('#loop-check', root)?.addEventListener('change', async (e) => {
    try {
      await api.patch(`/api/playlists/${selectedId}`, { loop: e.target.checked });
      toast(e.target.checked ? 'Ciclo continuo activado' : 'Ciclo continuo desactivado', 'ok');
      await ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  qsa('[data-up]', root).forEach((b) => b.addEventListener('click', () => move(b.dataset.up, -1)));
  qsa('[data-down]', root).forEach((b) => b.addEventListener('click', () => move(b.dataset.down, 1)));

  async function move(itemId, delta) {
    try {
      await api.post(`/api/playlists/${selectedId}/move`, { itemId, delta });
      await ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  }

  qsa('[data-del]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog('¿Quitar este elemento de la lista?', { danger: true, okLabel: 'Quitar' })) return;
    try {
      await api.del(`/api/playlists/${selectedId}/items/${b.dataset.del}`);
      toast('Elemento quitado', 'ok');
      await ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  }));

  qsa('[data-air]', root).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api.post('/api/playout/air', { mediaId: b.dataset.air });
      toast('Enviado al aire', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }));

  qsa('[data-add]', root).forEach((b) => b.addEventListener('click', () => addItem(b.dataset.add, ctx)));

  // Menú contextual: copiar, cortar, pegar y duplicar elementos
  const itemEls = qsa('#items-list .list-row', root);
  itemEls.forEach((row) => {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const item = (detail?.items || []).find((i) => i.id === row.dataset.item);
      if (!item) return;
      const entry = stripItem(item);
      openContextMenu(event.clientX, event.clientY, [
        {
          label: 'Copiar',
          onClick: () => { clipboard = { mode: 'copy', entries: [entry], ids: [item.id], sourcePlaylistId: selectedId }; toast('Elemento copiado', 'ok'); },
        },
        {
          label: 'Cortar',
          onClick: () => { clipboard = { mode: 'cut', entries: [entry], ids: [item.id], sourcePlaylistId: selectedId }; toast('Elemento listo para mover', 'ok'); },
        },
        {
          label: 'Pegar',
          disabled: !clipboard,
          onClick: () => pasteItems(ctx),
        },
        {
          label: 'Duplicar',
          onClick: async () => {
            try {
              await api.post(`/api/playlists/${selectedId}/items`, { entries: [entry] });
              toast('Elemento duplicado', 'ok');
              await ctx.refresh();
            } catch (err) { toast(err.message, 'err'); }
          },
        },
        {
          label: 'Enviar al aire',
          disabled: item.type !== 'media',
          onClick: async () => {
            try {
              await api.post('/api/playout/air', { mediaId: item.mediaId });
              toast('Enviado al aire', 'ok');
            } catch (err) { toast(err.message, 'err'); }
          },
        },
        {
          label: 'Quitar de la lista',
          danger: true,
          onClick: async () => {
            try {
              await api.del(`/api/playlists/${selectedId}/items/${item.id}`);
              await ctx.refresh();
            } catch (err) { toast(err.message, 'err'); }
          },
        },
      ]);
    });
  });

  const listEl = qs('#items-list', root);
  listEl?.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.list-row')) return;
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, [
      { label: 'Pegar', hint: 'Ctrl+V', disabled: !clipboard, onClick: () => pasteItems(ctx) },
      { label: 'Agregar videos…', onClick: () => addItem('media', ctx) },
      { label: 'Insertar File Slot…', onClick: () => addItem('slot', ctx) },
    ]);
  });

  document.onkeydown = (event) => {
    if (ctx.state.name !== 'playlists' || !document.getElementById('items-list')) return;
    if (event.target.matches('input, textarea, select')) return;
    if (!event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (key === 'v' && clipboard) { event.preventDefault(); pasteItems(ctx); }
  };

  async function pasteItems(context) {
    if (!clipboard) return;
    try {
      await api.post(`/api/playlists/${selectedId}/items`, { entries: clipboard.entries });
      if (clipboard.mode === 'cut' && clipboard.sourcePlaylistId) {
        for (const id of clipboard.ids) {
          await api.del(`/api/playlists/${clipboard.sourcePlaylistId}/items/${id}`);
        }
        clipboard = null;
      }
      toast('Elementos pegados', 'ok');
      await context.refresh();
    } catch (err) { toast(err.message, 'err'); }
  }

  // Ordenar arrastrando
  let dragId = null;
  qsa('#items-list .list-row', root).forEach((row) => {
    row.addEventListener('dragstart', () => { dragId = row.dataset.item; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragId || dragId === row.dataset.item) return;
      const ids = qsa('#items-list .list-row', root).map((r) => r.dataset.item);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(row.dataset.item);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      try {
        await api.post(`/api/playlists/${selectedId}/reorder`, { ids });
        toast('Orden guardado', 'ok');
        await ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    });
  });

  qsa('[data-act]', root).forEach((btn) => btn.addEventListener('click', async () => {
    const act = btn.dataset.act;
    try {
      if (act === 'play') {
        await api.post(`/api/playlists/${selectedId}/play`);
        toast('Lista enviada al aire', 'ok');
        await ctx.refresh();
      } else if (act === 'new') {
        formModal({
          title: 'Nueva lista de reproducción',
          fields: [
            { name: 'name', label: 'Nombre', required: true, full: true, placeholder: 'Ej. Señal nocturna' },
            { name: 'description', label: 'Descripción', type: 'textarea', full: true },
            { name: 'order', label: 'Orden de reproducción', type: 'select', value: 'season', options: [
              { value: 'manual', label: 'Manual' }, { value: 'alpha', label: 'Alfabético' },
              { value: 'random', label: 'Aleatorio' }, { value: 'season', label: 'Temporada/Episodio' },
            ] },
            { name: 'loop', label: 'Ciclo continuo 24/7', type: 'checkbox', value: true, checkLabel: 'Volver al primer video al terminar' },
          ],
          onSubmit: async (v) => {
            const created = await api.post('/api/playlists', v);
            selectedId = created.id;
            toast('Lista creada', 'ok');
            await ctx.refresh();
          },
        });
      } else if (act === 'edit') {
        formModal({
          title: 'Editar lista',
          fields: [
            { name: 'name', label: 'Nombre', value: detail.name, required: true, full: true },
            { name: 'description', label: 'Descripción', type: 'textarea', value: detail.description || '', full: true },
            { name: 'order', label: 'Orden', type: 'select', value: detail.order, options: [
              { value: 'manual', label: 'Manual' }, { value: 'alpha', label: 'Alfabético' },
              { value: 'random', label: 'Aleatorio' }, { value: 'season', label: 'Temporada/Episodio' },
            ] },
            { name: 'loop', label: 'Ciclo continuo', type: 'checkbox', value: detail.loop !== false, checkLabel: 'Repetir indefinidamente' },
          ],
          onSubmit: async (v) => {
            await api.patch(`/api/playlists/${selectedId}`, v);
            toast('Lista actualizada', 'ok');
            await ctx.refresh();
          },
        });
      } else if (act === 'dup') {
        await api.post(`/api/playlists/${selectedId}/duplicate`);
        toast('Lista duplicada', 'ok');
        await ctx.refresh();
      } else if (act === 'del') {
        if (!await confirmDialog('¿Eliminar esta lista? No se puede deshacer.', { danger: true, okLabel: 'Eliminar' })) return;
        await api.del(`/api/playlists/${selectedId}`);
        selectedId = null;
        toast('Lista eliminada', 'ok');
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  }));

  void lists;
}

async function addItem(type, ctx) {
  try {
    if (type === 'media') {
      const chosen = await openMediaPicker({ title: 'Agregar videos a la lista', multiple: true });
      if (!chosen?.length) return;
      await api.post(`/api/playlists/${selectedId}/items`, { type: 'media', items: chosen.map((m) => ({ mediaId: m.id })) });
      toast(`${chosen.length} video(s) agregados`, 'ok');
      await ctx.refresh();
      return;
    }
    if (type === 'category') {
      const cats = ctx.state.boot.categories || [];
      formModal({
        title: 'Agregar categoría completa',
        fields: [{
          name: 'category', label: 'Categoría', type: 'select', full: true,
          options: cats.map((c) => ({ value: c.name, label: `${c.name} (${ctx.state.boot.media.filter((m) => m.category === c.name).length} medios)` })),
        }],
        intro: 'Todos los medios de la categoría se incluirán automáticamente, incluso los que agregue después.',
        onSubmit: async (v) => {
          await api.post(`/api/playlists/${selectedId}/items`, { type: 'category', ...v });
          toast('Categoría agregada', 'ok');
          await ctx.refresh();
        },
      });
      return;
    }
    if (type === 'slot') {
      const slots = await api.get('/api/slots');
      if (!slots.length) {
        toast('No hay File Slots creados. Créelos en Biblioteca → File Slots.', 'warn');
        return;
      }
      formModal({
        title: 'Insertar File Slot',
        fields: [{
          name: 'slotId', label: 'Slot', type: 'select', full: true,
          options: slots.map((sl) => ({ value: sl.id, label: `${sl.name} (${sl.count} archivos · próximo: ${sl.currentMedia || '—'})` })),
        }],
        intro: 'El slot inserta un archivo de su grupo y avanza la rotación en cada emisión, sin repetir siempre el mismo.',
        submitLabel: 'Insertar',
        onSubmit: async (v) => {
          await api.post(`/api/playlists/${selectedId}/items`, { type: 'slot', ...v });
          toast('File Slot insertado', 'ok');
          await ctx.refresh();
        },
      });
      return;
    }
    if (type === 'folder') {
      formModal({
        title: 'Agregar carpeta completa',
        fields: [{
          name: 'folderPath', label: 'Ruta de la carpeta', full: true, required: true,
          placeholder: '/home/usuario/videos/series',
          value: (ctx.state.boot.settings.mediaFolders || [])[0] || '',
          hint: 'Se incluirán todos los videos importados de esa carpeta.',
        }],
        onSubmit: async (v) => {
          await api.post(`/api/playlists/${selectedId}/items`, { type: 'folder', ...v });
          toast('Carpeta agregada', 'ok');
          await ctx.refresh();
        },
      });
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function stripItem(item) {
  const out = { type: item.type };
  if (item.type === 'media') out.mediaId = item.mediaId;
  if (item.type === 'category') out.category = item.category;
  if (item.type === 'folder') out.folderPath = item.folderPath;
  if (item.type === 'slot') out.slotId = item.slotId;
  if (item.type === 'playlist') out.playlistId = item.playlistId;
  return out;
}

export function onState(snap, ctx) {
  if (ctx?.state?.name !== 'playlists') return;
  const el = qs('#items-list');
  if (el && snap.runtime.playlistId === selectedId && snap.runtime.mode !== 'idle') {
    // pequeño indicador vivo de cuál elemento está al aire
    qsa('#items-list .list-row', el).forEach((row) => row.classList.remove('active-row'));
  }
  void openModal;
}
