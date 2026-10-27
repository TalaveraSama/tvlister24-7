// Biblioteca de medios: búsqueda, carpetas, categorías y metadatos.
import { api } from '../api.js';
import {
  esc, fmtDur, fmtBytes, fmtNum, toast, confirmDialog, formModal, qs, qsa, openContextMenu, copyText,
} from '../ui.js';
import { openMediaPicker } from '../components.js';

let filters = { q: '', category: '', tab: 'media' };

export async function render(root, ctx) {
  const { boot } = ctx.state;
  const media = boot.media || [];
  const stats = boot.stats || {};
  const categories = boot.categories || [];
  const genres = boot.genres || [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Biblioteca</div>
        <div class="page-desc">Importe carpetas completas, organice por categorías y géneros, y edite la duración de cada video. Los archivos permanecen en su disco; Proca solo los administra.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm" data-act="verify">Verificar archivos</button>
        <button class="btn btn-sm" data-act="manual">+ Medio manual</button>
        <button class="btn btn-sm btn-primary" data-act="import">▣ Importar carpeta</button>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:16px">
      <div class="stat"><div class="stat-label">Medios</div><div class="stat-value">${fmtNum(stats.count)}</div></div>
      <div class="stat"><div class="stat-label">Duración total</div><div class="stat-value">${fmtDur(stats.totalSeconds)}</div></div>
      <div class="stat"><div class="stat-label">Tamaño</div><div class="stat-value">${fmtBytes(stats.totalSize)}</div></div>
      <div class="stat"><div class="stat-label">Carpetas vinculadas</div><div class="stat-value">${(stats.folders || []).length}</div></div>
    </div>

    <div class="tabs">
      <div class="tab ${filters.tab === 'media' ? 'active' : ''}" data-tab="media">Medios</div>
      <div class="tab ${filters.tab === 'categories' ? 'active' : ''}" data-tab="categories">Categorías</div>
      <div class="tab ${filters.tab === 'genres' ? 'active' : ''}" data-tab="genres">Géneros</div>
      <div class="tab ${filters.tab === 'folders' ? 'active' : ''}" data-tab="folders">Carpetas</div>
      <div class="tab ${filters.tab === 'slots' ? 'active' : ''}" data-tab="slots">File Slots</div>
    </div>

    <div id="tab-content"></div>
  `;

  const content = qs('#tab-content', root);

  qsa('[data-tab]', root).forEach((t) => t.addEventListener('click', () => {
    filters.tab = t.dataset.tab;
    qsa('[data-tab]', root).forEach((x) => x.classList.toggle('active', x === t));
    drawTab(content, ctx, { media, stats, categories, genres });
  }));

  drawTab(content, ctx, { media, stats, categories, genres });

  root.querySelector('.page-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      if (btn.dataset.act === 'import') importFolder(ctx, categories, genres);
      else if (btn.dataset.act === 'manual') manualMedia(ctx, categories, genres);
      else if (btn.dataset.act === 'verify') {
        const res = await api.get('/api/media/missing/list');
        if (!res.rows.length) toast('Todos los archivos están disponibles', 'ok');
        else {
          const body = document.createElement('div');
          body.innerHTML = `<div class="help-box warn" style="margin-bottom:10px">${res.rows.length} archivo(s) no se encontraron en el disco. Puede corregir la ruta o eliminarlos.</div>
            <div class="table-wrap"><table><tbody>${res.rows.map((m) => `<tr><td>${esc(m.title)}</td><td class="mono small muted">${esc(m.path)}</td></tr>`).join('')}</tbody></table></div>`;
          void (await import('../ui.js')).openModal({ title: 'Archivos no encontrados', body, wide: true });
        }
      }
    } catch (err) { toast(err.message, 'err'); }
  });
}

function drawTab(content, ctx, { media, stats, categories, genres }) {
  const { boot } = ctx.state;
  if (filters.tab === 'media') {
    const cats = [...new Set(media.map((m) => m.category).filter(Boolean))].sort();
    const list = media.filter((m) => {
      const q = filters.q.toLowerCase();
      const matchQ = !q || `${m.title} ${m.name} ${m.path} ${m.category} ${m.genre}`.toLowerCase().includes(q);
      const matchC = !filters.category || m.category === filters.category;
      return matchQ && matchC;
    });
    content.innerHTML = `
      <div class="toolbar">
        <input type="search" id="q" placeholder="Buscar título, ruta, categoría…" value="${esc(filters.q)}">
        <select id="cat-filter">
          <option value="">Todas las categorías</option>
          ${cats.map((c) => `<option value="${esc(c)}" ${filters.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <span class="muted small">${list.length} de ${media.length} medios</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-act="scan">⟳ Escanear carpetas</button>
      </div>
      <div class="table-wrap" style="max-height:62vh;overflow:auto">
        <table>
          <thead><tr><th>Título</th><th>Categoría</th><th>Género</th><th class="num">Temporada</th><th class="num">Episodio</th>
            <th class="num">Duración</th><th class="num">Tamaño</th><th>Ruta</th><th></th></tr></thead>
          <tbody>
            ${list.map((m) => `<tr>
              <td><div class="row"><span class="media-thumb"></span>${esc(m.title)}${m.demo ? '<span class="badge violet">demo</span>' : ''}</div></td>
              <td>${m.category ? `<span class="chip">${esc(m.category)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="small muted">${esc(m.genre || '—')}</td>
              <td class="num">${m.season ?? '—'}</td>
              <td class="num">${m.episode ?? '—'}</td>
              <td class="num">${fmtDur(m.duration)}</td>
              <td class="num">${fmtBytes(m.size)}</td>
              <td class="mono small muted truncate" style="max-width:220px" title="${esc(m.path)}">${esc(m.path)}</td>
              <td class="nowrap">
                <button class="btn btn-xs" data-edit="${m.id}">Editar</button>
                <button class="btn btn-xs" data-air="${m.id}">Al aire</button>
                <button class="btn btn-xs btn-danger" data-del="${m.id}">✕</button>
              </td></tr>`).join('') || `<tr><td colspan="9"><div class="empty"><strong>Sin medios</strong>Importe una carpeta para comenzar.</div></td></tr>`}
          </tbody>
        </table>
      </div>`;

    qs('#q', content).addEventListener('input', (e) => {
      filters.q = e.target.value;
      drawTab(content, ctx, { media, stats, categories, genres });
      qs('#q', content).focus();
    });
    qs('#cat-filter', content).addEventListener('change', (e) => {
      filters.category = e.target.value;
      drawTab(content, ctx, { media, stats, categories, genres });
    });
    content.querySelector('[data-act="scan"]').addEventListener('click', async () => {
      try {
        const res = await api.post('/api/media/scan');
        toast(res.added ? `${res.added} nuevos medios importados` : 'Sin novedades en las carpetas', 'ok');
        if (res.errors?.length) toast(res.errors[0], 'warn');
        await ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    });

    content.oncontextmenu = (event) => {
      const row = event.target.closest('tr');
      if (!row) return;
      const btn = row.querySelector('[data-edit]');
      const m = btn ? media.find((x) => x.id === btn.dataset.edit) : null;
      if (!m) return;
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, [
        { label: 'Copiar título', onClick: async () => { await copyText(m.title); toast('Título copiado', 'ok'); } },
        { label: 'Copiar ruta', onClick: async () => { await copyText(m.path); toast('Ruta copiada', 'ok'); } },
        { label: 'Enviar al aire', onClick: async () => {
          try { await api.post('/api/playout/air', { mediaId: m.id }); toast('Enviado al aire', 'ok'); } catch (err) { toast(err.message, 'err'); }
        } },
        { label: 'Editar', onClick: () => editMedia(m, ctx, categories, genres) },
        { label: 'Eliminar', danger: true, onClick: async () => {
          if (!await confirmDialog('¿Eliminar este medio de la biblioteca?', { danger: true, okLabel: 'Eliminar' })) return;
          await api.del(`/api/media/${m.id}`);
          toast('Medio eliminado', 'ok');
          await ctx.refresh();
        } },
      ]);
    };

    content.onclick = async (e) => {
      const t = e.target.closest('[data-edit],[data-air],[data-del]');
      if (!t) return;
      try {
        if (t.dataset.edit) editMedia(media.find((m) => m.id === t.dataset.edit), ctx, categories, genres);
        else if (t.dataset.air) {
          await api.post('/api/playout/air', { mediaId: t.dataset.air });
          toast('Enviado al aire', 'ok');
        } else if (t.dataset.del) {
          if (!await confirmDialog('¿Eliminar este medio de la biblioteca? El archivo no se borra del disco.', { danger: true, okLabel: 'Eliminar' })) return;
          await api.del(`/api/media/${t.dataset.del}`);
          toast('Medio eliminado', 'ok');
          await ctx.refresh();
        }
      } catch (err) { toast(err.message, 'err'); }
    };
    return;
  }

  if (filters.tab === 'folders') {
    content.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="card-title">Carpetas vinculadas</div>
          <div class="card-actions"><button class="btn btn-xs btn-primary" data-act="add-folder">+ Agregar carpeta</button></div>
        </div>
        <div class="stack">
          ${(stats.folders || []).map((f) => `<div class="list-row">
            <span class="title mono small">${esc(f)}</span>
            <span class="meta">${media.filter((m) => String(m.folderPath || '').replace(/\/$/, '') === String(f).replace(/\/$/, '')).length} medios</span>
            <button class="btn btn-xs" data-scan-folder="${esc(f)}">Escanear</button>
          </div>`).join('') || '<div class="empty">Aún no hay carpetas vinculadas.</div>'}
        </div>
        <div class="help-box" style="margin-top:12px">Las carpetas se escanean manualmente. Cada escaneo agrega únicamente los archivos nuevos, sin duplicar.</div>
      </div>`;
    content.querySelector('[data-act="add-folder"]').addEventListener('click', () => importFolder(ctx, categories, genres));
    content.onclick = async (e) => {
      const b = e.target.closest('[data-scan-folder]');
      if (!b) return;
      try {
        const res = await api.post('/api/media/import-folder', { folderPath: b.dataset.scanFolder, recursive: true });
        toast(`${res.added?.length || 0} nuevos en ${b.dataset.scanFolder}`, 'ok');
        await ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
    return;
  }

  if (filters.tab === 'slots') {
    const slots = boot.slots || [];
    content.innerHTML = `
      <div class="toolbar">
        <span class="muted small">Un File Slot es un grupo de archivos que rota automáticamente: cada vez que la lista se emite, entra el siguiente archivo del grupo.</span>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" data-act="new-slot">+ Nuevo slot</button>
      </div>
      <div class="grid-2">
        ${slots.map((sl) => `<div class="card">
          <div class="card-head">
            <div class="card-title">${esc(sl.name)} <span class="sub">${sl.count} archivos</span></div>
            <div class="card-actions">
              <button class="btn btn-xs" data-slot-add="${sl.id}">+ Archivos</button>
              <button class="btn btn-xs" data-slot-rotate="${sl.id}" title="Avanzar rotación">⟳ Rotar</button>
              <button class="btn btn-xs" data-slot-edit="${sl.id}">Editar</button>
              <button class="btn btn-xs btn-danger" data-slot-del="${sl.id}">✕</button>
            </div>
          </div>
          ${sl.description ? `<div class="muted small" style="margin-bottom:8px">${esc(sl.description)}</div>` : ''}
          <div class="kv"><span class="k">Próximo al aire</span><span class="v">${esc(sl.currentMedia || '—')}</span></div>
          <div class="kv"><span class="k">Usado en</span><span class="v">${esc((sl.usedIn || []).join(', ') || 'sin asignar')}</span></div>
          <div class="stack" style="gap:4px;margin-top:8px">
            ${(sl.mediaIds || []).map((id, i) => {
              const m = media.find((x) => x.id === id);
              return m ? `<div class="list-row" style="padding:5px 8px;border-color:${i === (sl.cursor || 0) % Math.max(1, sl.mediaIds.length) ? 'rgba(34,211,238,.45)' : 'var(--line)'}">
                <span class="idx">${String(i + 1).padStart(2, '0')}</span>
                <span class="title small">${esc(m.title)}</span>
                <span class="meta">${fmtDur(m.duration)}</span>
                <button class="btn btn-xs btn-danger" data-slot-rm="${sl.id}:${m.id}">✕</button>
              </div>` : '';
            }).join('') || '<div class="muted small">Sin archivos todavía.</div>'}
          </div>
        </div>`).join('') || '<div class="card"><div class="empty">Sin File Slots. Cree uno para rotar archivos automáticamente.</div></div>'}
      </div>`;
    wireSlots(content, ctx, media, slots);
    return;
  }

  const isCat = filters.tab === 'categories';
  const rows = isCat ? categories : genres;
  content.innerHTML = `
    <div class="card">
      <div class="card-head"><div class="card-title">${isCat ? 'Categorías' : 'Géneros'}</div>
        <div class="card-actions"><button class="btn btn-xs btn-primary" data-act="add">+ Nuevo</button></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th class="num">Medios</th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          const count = isCat ? media.filter((m) => m.category === r.name).length : media.filter((m) => m.genre === r.name).length;
          return `<tr><td>${esc(r.name)}</td><td class="num">${count}</td>
            <td class="nowrap">
              <button class="btn btn-xs" data-ren="${r.id}">Renombrar</button>
              <button class="btn btn-xs btn-danger" data-rm="${r.id}">✕</button>
            </td></tr>`;
        }).join('') || `<tr><td colspan="3"><div class="empty">Sin ${isCat ? 'categorías' : 'géneros'}</div></td></tr>`}</tbody>
      </table></div>
      ${isCat ? '<div class="help-box" style="margin-top:12px">Renombrar una categoría actualiza automáticamente todos los medios, listas y bloques de parrilla que la usaban.</div>' : ''}
    </div>`;

  const endpoint = isCat ? 'categories' : 'genres';
  content.querySelector('[data-act="add"]').addEventListener('click', () => {
    formModal({
      title: isCat ? 'Nueva categoría' : 'Nuevo género',
      fields: [{ name: 'name', label: 'Nombre', required: true, full: true }],
      onSubmit: async (v) => {
        await api.post(`/api/${endpoint}`, v);
        toast('Creado', 'ok');
        await ctx.refresh();
      },
    });
  });
  content.onclick = async (e) => {
    const row = rows.find((r) => r.id === (e.target.dataset.ren || e.target.dataset.rm));
    if (!row) return;
    try {
      if (e.target.dataset.ren) {
        formModal({
          title: 'Renombrar',
          fields: [{ name: 'name', label: 'Nombre', value: row.name, required: true, full: true }],
          onSubmit: async (v) => {
            await api.patch(`/api/${endpoint}/${row.id}`, v);
            toast('Actualizado', 'ok');
            await ctx.refresh();
          },
        });
      } else {
        if (!await confirmDialog(`¿Eliminar "${row.name}"? Los medios quedarán sin esa etiqueta.`, { danger: true, okLabel: 'Eliminar' })) return;
        await api.del(`/api/${endpoint}/${row.id}`);
        toast('Eliminado', 'ok');
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  };
  void boot;
}

function importFolder(ctx, categories, genres) {
  formModal({
    title: 'Importar carpeta de videos',
    wide: true,
    intro: 'Indique una ruta accesible desde el equipo donde corre Proca. Se agregarán todos los videos encontrados (mp4, mkv, avi, mov, ts, webm y audio).',
    fields: [
      { name: 'folderPath', label: 'Ruta de la carpeta', required: true, full: true, placeholder: '/home/usuario/Videos/Canal' },
      { name: 'category', label: 'Categoría a asignar', type: 'select', value: '',
        options: [{ value: '', label: '— Sin categoría —' }, ...categories.map((c) => ({ value: c.name, label: c.name }))] },
      { name: 'genre', label: 'Género a asignar', type: 'select', value: '',
        options: [{ value: '', label: '— Sin género —' }, ...genres.map((g) => ({ value: g.name, label: g.name }))] },
      { name: 'recursive', label: 'Subcarpetas', type: 'checkbox', value: true, checkLabel: 'Incluir subcarpetas' },
      { name: 'onDuplicate', label: 'Si el archivo ya existe', type: 'select', value: 'skip', options: [
        { value: 'skip', label: 'Omitir' }, { value: 'replace', label: 'Actualizar datos' },
      ] },
    ],
    submitLabel: 'Importar',
    onSubmit: async (v) => {
      const res = await api.post('/api/media/import-folder', v);
      toast(`${res.added?.length || 0} medios importados de ${res.scanned || 0} archivos`, 'ok');
      await ctx.refresh();
    },
  });
}

function manualMedia(ctx, categories, genres) {
  formModal({
    title: 'Agregar medio manualmente',
    fields: [
      { name: 'title', label: 'Título', required: true, full: true },
      { name: 'path', label: 'Ruta del archivo', full: true, placeholder: '/ruta/video.mp4' },
      { name: 'duration', label: 'Duración (segundos)', type: 'number', value: 60, min: 1 },
      { name: 'category', label: 'Categoría', type: 'select', value: '',
        options: [{ value: '', label: '— Sin categoría —' }, ...categories.map((c) => ({ value: c.name, label: c.name }))] },
      { name: 'genre', label: 'Género', type: 'select', value: '',
        options: [{ value: '', label: '— Sin género —' }, ...genres.map((g) => ({ value: g.name, label: g.name }))] },
      { name: 'season', label: 'Temporada', type: 'number', value: null, min: 1 },
      { name: 'episode', label: 'Episodio', type: 'number', value: null, min: 1 },
    ],
    submitLabel: 'Agregar',
    onSubmit: async (v) => {
      await api.post('/api/media', v);
      toast('Medio agregado', 'ok');
      await ctx.refresh();
    },
  });
}

function editMedia(m, ctx, categories, genres) {
  if (!m) return;
  formModal({
    title: 'Editar medio',
    fields: [
      { name: 'title', label: 'Título', value: m.title, required: true, full: true },
      { name: 'path', label: 'Ruta', value: m.path, full: true, disabled: !!m.demo },
      { name: 'duration', label: 'Duración (segundos)', type: 'number', value: m.duration, min: 1,
        hint: 'Ajuste la duración real del archivo para que la automatización avance a tiempo.' },
      { name: 'category', label: 'Categoría', type: 'select', value: m.category || '',
        options: [{ value: '', label: '— Sin categoría —' }, ...categories.map((c) => ({ value: c.name, label: c.name }))] },
      { name: 'genre', label: 'Género', type: 'select', value: m.genre || '',
        options: [{ value: '', label: '— Sin género —' }, ...genres.map((g) => ({ value: g.name, label: g.name }))] },
      { name: 'season', label: 'Temporada', type: 'number', value: m.season ?? null, min: 1 },
      { name: 'episode', label: 'Episodio', type: 'number', value: m.episode ?? null, min: 1 },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/media/${m.id}`, v);
      toast('Medio actualizado', 'ok');
      await ctx.refresh();
    },
  });
}

function wireSlots(content, ctx, media, slots) {
  const slotById = (id) => slots.find((s) => s.id === id);

  content.querySelector('[data-act="new-slot"]')?.addEventListener('click', () => {
    formModal({
      title: 'Nuevo File Slot',
      fields: [
        { name: 'name', label: 'Nombre del slot', required: true, full: true, placeholder: 'Ej. Cortinas institucionales' },
        { name: 'description', label: 'Descripción', full: true },
      ],
      intro: 'Los archivos del slot se emiten en rotación: cada emisión toma el siguiente de la lista.',
      onSubmit: async (v) => {
        await api.post('/api/slots', v);
        toast('Slot creado', 'ok');
        await ctx.refresh();
      },
    });
  });

  content.onclick = async (e) => {
    const add = e.target.closest('[data-slot-add]');
    const rotate = e.target.closest('[data-slot-rotate]');
    const edit = e.target.closest('[data-slot-edit]');
    const del = e.target.closest('[data-slot-del]');
    const rm = e.target.closest('[data-slot-rm]');
    try {
      if (add) {
        const chosen = await openMediaPicker({ title: 'Agregar archivos al slot', multiple: true });
        if (!chosen?.length) return;
        await api.post(`/api/slots/${add.dataset.slotAdd}/media`, { mediaIds: chosen.map((m) => m.id) });
        toast(`${chosen.length} archivo(s) agregados`, 'ok');
        await ctx.refresh();
      } else if (rotate) {
        await api.post(`/api/slots/${rotate.dataset.slotRotate}/rotate`);
        toast('Rotación avanzada', 'ok');
        await ctx.refresh();
      } else if (edit) {
        const slot = slotById(edit.dataset.slotEdit);
        formModal({
          title: 'Editar File Slot',
          fields: [
            { name: 'name', label: 'Nombre', value: slot.name, required: true, full: true },
            { name: 'description', label: 'Descripción', value: slot.description || '', full: true },
            { name: 'cursor', label: 'Posición de rotación', type: 'number', value: slot.cursor || 0, min: 0 },
          ],
          onSubmit: async (v) => {
            await api.patch(`/api/slots/${slot.id}`, v);
            toast('Slot actualizado', 'ok');
            await ctx.refresh();
          },
        });
      } else if (del) {
        if (!await confirmDialog('¿Eliminar el slot? Se quitará de las listas que lo usan.', { danger: true, okLabel: 'Eliminar' })) return;
        await api.del(`/api/slots/${del.dataset.slotDel}`);
        toast('Slot eliminado', 'ok');
        await ctx.refresh();
      } else if (rm) {
        const [slotId, mediaId] = rm.dataset.slotRm.split(':');
        await api.del(`/api/slots/${slotId}/media/${mediaId}`);
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  };
  void media;
}

export function onState() {}
