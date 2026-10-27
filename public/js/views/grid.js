// Parrilla de programación: bloques por fecha/hora, días, prioridad y plantillas.
import { api } from '../api.js';
import { esc, fmtDur, toast, confirmDialog, formModal, openModal, qs, qsa, DOW } from '../ui.js';

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // lunes a domingo en la tabla
const COL_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOUR_HEIGHT = 46;
const MIN_BLOCK = 16;

function toMin(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function blocksForDay(entry, dayIndex) {
  const start = toMin(entry.start);
  const end = toMin(entry.end);
  const blocks = [];
  const crosses = end <= start || end === 0;
  if (!entry.days?.includes(dayIndex)) return blocks;
  if (!crosses) {
    blocks.push({ top: (start / 1440) * 24 * HOUR_HEIGHT, height: Math.max(MIN_BLOCK, ((end - start) / 1440) * 24 * HOUR_HEIGHT) });
  } else {
    const endAdj = end <= start ? end + 1440 : end;
    blocks.push({ top: (start / 1440) * 24 * HOUR_HEIGHT, height: Math.max(MIN_BLOCK, ((1440 - start) / 1440) * 24 * HOUR_HEIGHT) });
    if (endAdj > 1440 && entry.days.includes((dayIndex + 1) % 7)) {
      blocks.push({ top: 0, height: Math.max(MIN_BLOCK, ((endAdj - 1440) / 1440) * 24 * HOUR_HEIGHT), continued: true });
    }
  }
  return blocks;
}

function typeLabel(e) {
  if (e.contentType === 'live') return `En vivo${e.live?.sourceName ? ` · ${e.live.sourceName}` : ''}`;
  if (e.contentType === 'playlist') return 'Lista';
  if (e.contentType === 'category') return `Categoría ${e.category || ''}`;
  if (e.contentType === 'folder') return 'Carpeta';
  return e.contentType;
}

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const grid = boot.grid;
  const lists = boot.playlists;
  const categories = boot.categories || [];
  const scenes = snap.obs?.scenes || [];
  const today = snap.schedule?.parts?.dayOfWeek ?? new Date().getDay();

  const entries = grid.entries || [];
  const totalMinutes = entries.reduce((acc, e) => {
    const s = toMin(e.start); let en = toMin(e.end); if (en <= s) en += 1440;
    return acc + (en - s);
  }, 0);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Parrilla de programación</div>
        <div class="page-desc">Programe contenido por fecha y hora. La parrilla tiene prioridad sobre la lista 24/7 y al terminar cada bloque el canal regresa automáticamente a la programación continua.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm" data-act="templates">▤ Plantillas</button>
        <button class="btn btn-sm" data-act="adapt">⟲ Adaptar a la hora actual</button>
        <button class="btn btn-sm btn-primary" data-act="new">+ Nuevo bloque</button>
      </div>
    </div>

    <div class="grid-4" style="margin-bottom:14px">
      <div class="stat"><div class="stat-label">Bloques activos</div><div class="stat-value">${entries.filter((e) => e.enabled !== false).length}</div></div>
      <div class="stat"><div class="stat-label">Horas programadas / semana</div><div class="stat-value">${(totalMinutes / 60).toFixed(1)} h</div></div>
      <div class="stat"><div class="stat-label">Al aire ahora</div><div class="stat-value sm">${grid.current ? esc(grid.current.name) : 'Programación 24/7'}</div></div>
      <div class="stat"><div class="stat-label">Próximo bloque</div><div class="stat-value sm">${grid.upcoming?.[0] ? `${esc(grid.upcoming[0].name)} · ${esc(grid.upcoming[0].start)}` : '—'}</div></div>
    </div>

    <div class="timeline-wrap">
      <div class="timeline-head">
        <div>Hora</div>
        ${COL_ORDER.map((d) => `<div class="${d === today ? 'today' : ''}">${DOW[d]}</div>`).join('')}
      </div>
      <div class="timeline">
        <div class="hours">
          ${Array.from({ length: 24 }, (_, h) => `<div>${String(h).padStart(2, '0')}</div>`).join('')}
        </div>
        ${COL_ORDER.map((day) => `
          <div class="day-col ${day === today ? 'today' : ''}">
            ${entries.filter((e) => e.enabled !== false).map((e) => blocksForDay(e, day).map((b) => `
              <div class="tl-entry ${e.contentType === 'live' ? 'live' : ''}" data-entry="${e.id}"
                   style="top:${b.top}px;height:${b.height}px;background:${hexA(e.color, .18)};border-color:${hexA(e.color, .6)}"
                   title="${esc(e.name)} · ${esc(e.start)}–${esc(e.end)} · ${esc(typeLabel(e))}">
                <span class="n">${b.continued ? '↳ ' : ''}${esc(e.name)}</span>
                <span class="t">${esc(e.start)}–${esc(e.end)}</span>
              </div>`).join('')).join('')}
          </div>`).join('')}
      </div>
    </div>

    <div class="section-title">Bloques programados <span class="muted">· haga clic para editar</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Bloque</th><th>Días</th><th>Horario</th><th class="num">Duración</th><th>Contenido</th><th>Finalización</th>
          <th class="num">Prior.</th><th class="num">Elementos</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>
          ${entries.map((e) => `
            <tr class="${e.activeNow ? 'active-row' : ''}">
              <td>
                <div class="row"><span style="width:8px;height:8px;border-radius:50%;background:${esc(e.color || '#38bdf8')}"></span>
                <span>${esc(e.name)}</span>${e.activeNow ? '<span class="badge green">AL AIRE</span>' : ''}</div>
                ${e.notes ? `<div class="muted small">${esc(e.notes)}</div>` : ''}
                ${e.dateFrom || e.dateTo ? `<div class="muted small">Vigencia: ${esc(e.dateFrom || '…')} → ${esc(e.dateTo || '…')}</div>` : ''}
              </td>
              <td class="small">${esc(e.daysLabel || '')}</td>
              <td class="mono small">${esc(e.start)}–${esc(e.end)}</td>
              <td class="num">${e.durationMin ? `${Math.floor(e.durationMin / 60)}h ${e.durationMin % 60}m` : '—'}</td>
              <td class="small">${esc(typeLabel(e))}</td>
              <td class="small muted">${e.endMode === 'afterLast' ? 'Después del último video' : 'Hora exacta'}</td>
              <td class="num">${e.priority ?? 5}</td>
              <td class="num">${e.resolvedCount ?? '—'}</td>
              <td>${e.enabled === false ? '<span class="badge gray">Desactivado</span>' : '<span class="badge green">Activo</span>'}</td>
              <td class="nowrap">
                <button class="btn btn-xs" data-preview="${e.id}">Ver</button>
                <button class="btn btn-xs" data-toggle="${e.id}" title="Activar/desactivar">${e.enabled === false ? '☐' : '☑'}</button>
                <button class="btn btn-xs" data-activate="${e.id}" ${e.contentType === 'live' ? 'disabled' : ''}>Al aire</button>
                <button class="btn btn-xs" data-edit="${e.id}">Editar</button>
                <button class="btn btn-xs btn-danger" data-del="${e.id}">✕</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="10"><div class="empty"><strong>Parrilla vacía</strong>Cree bloques para programar su contenido.</div></td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="help-box" style="margin-top:14px">
      <strong>Cómo funciona:</strong> la parrilla se evalúa cada segundo. Si un bloque está en curso, Proca lo pone al aire; al finalizar,
      retoma la lista 24/7 o el bloque siguiente. Puede insertar cámaras o programas en vivo creando un bloque de tipo “En vivo”.
    </div>
  `;

  const entryById = (id) => entries.find((e) => e.id === id);
  const formFields = (e = {}) => [
    { name: 'name', label: 'Nombre del bloque', value: e.name || '', required: true, full: true, placeholder: 'Ej. Cine estelar' },
    { name: 'days', label: 'Días de emisión', type: 'days', value: e.days || [1, 2, 3, 4, 5], full: true },
    { name: 'start', label: 'Hora de inicio', type: 'time', value: e.start || '08:00', required: true },
    { name: 'end', label: 'Hora de finalización', type: 'time', value: e.end || '09:00', required: true },
    { name: 'dateFrom', label: 'Vigente desde (opcional)', type: 'date', value: e.dateFrom || '' },
    { name: 'dateTo', label: 'Vigente hasta (opcional)', type: 'date', value: e.dateTo || '' },
    { name: 'contentType', label: 'Tipo de contenido', type: 'select', value: e.contentType || 'playlist', full: true, options: [
      { value: 'playlist', label: 'Lista de reproducción' },
      { value: 'category', label: 'Categoría completa' },
      { value: 'folder', label: 'Carpeta completa' },
      { value: 'live', label: 'Cámara / programa en vivo' },
    ] },
    { name: 'playlistId', label: 'Lista (para tipo Lista)', type: 'select', value: e.playlistId || '', full: true,
      options: [{ value: '', label: '— Ninguna —' }, ...lists.map((l) => ({ value: l.id, label: `${l.name} (${l.resolvedCount})` }))] },
    { name: 'category', label: 'Categoría (para tipo Categoría)', type: 'select', value: e.category || '',
      options: [{ value: '', label: '— Ninguna —' }, ...categories.map((c) => ({ value: c.name, label: c.name }))] },
    { name: 'folderPath', label: 'Carpeta (para tipo Carpeta)', value: e.folderPath || '', placeholder: '/ruta/a/videos' },
    { name: 'liveScene', label: 'Escena OBS (en vivo)', type: 'select', value: e.live?.sceneName || '',
      options: [{ value: '', label: '— Usar escena en vivo por defecto —' }, ...scenes.map((s) => ({ value: s.sceneName, label: s.sceneName }))] },
    { name: 'liveSource', label: 'Fuente / cámara (en vivo)', value: e.live?.sourceName || '', placeholder: 'Cámara 1' },
    { name: 'endMode', label: 'Finalización', type: 'select', value: e.endMode || 'exact',
      options: [{ value: 'exact', label: 'A la hora exacta' }, { value: 'afterLast', label: 'Después del último video' }] },
    { name: 'priority', label: 'Prioridad', type: 'number', value: e.priority ?? 5, min: 0, max: 100,
      hint: 'Mayor prioridad gana si dos bloques se cruzan' },
    { name: 'color', label: 'Color', type: 'color', value: e.color || '#38bdf8' },
    { name: 'enabled', label: 'Estado', type: 'checkbox', value: e.enabled !== false, checkLabel: 'Bloque activo' },
    { name: 'notes', label: 'Notas', type: 'textarea', value: e.notes || '', full: true },
  ];

  function payload(v) {
    return {
      name: v.name,
      days: v.days,
      start: v.start,
      end: v.end,
      contentType: v.contentType,
      playlistId: v.playlistId || null,
      category: v.category || '',
      folderPath: v.folderPath || '',
      endMode: v.endMode,
      priority: v.priority,
      color: v.color || '#38bdf8',
      enabled: v.enabled,
      notes: v.notes || '',
      live: v.contentType === 'live' ? { sceneName: v.liveScene || '', sourceName: v.liveSource || '' } : null,
      dateFrom: v.dateFrom || '',
      dateTo: v.dateTo || '',
    };
  }

  const openForm = (entry) => formModal({
    title: entry ? `Editar bloque: ${entry.name}` : 'Nuevo bloque de parrilla',
    fields: formFields(entry || {}),
    wide: true,
    intro: 'Complete solo los campos del tipo de contenido elegido. Los bloques de tipo “En vivo” envían una cámara o fuente de OBS al aire y regresan a la parrilla al terminar.',
    submitLabel: entry ? 'Guardar cambios' : 'Crear bloque',
    onSubmit: async (v) => {
      const body = payload(v);
      if (!body.days.length) throw new Error('Seleccione al menos un día');
      if (entry) await api.patch(`/api/grid/entries/${entry.id}`, body);
      else await api.post('/api/grid/entries', body);
      toast(entry ? 'Bloque actualizado' : 'Bloque creado', 'ok');
      await ctx.refresh();
    },
  });

  root.addEventListener('click', async (e) => {
    const tl = e.target.closest('[data-entry]');
    if (tl && !e.target.closest('button')) {
      openForm(entryById(tl.dataset.entry));
      return;
    }
    const btn = e.target.closest('[data-act], [data-preview], [data-edit], [data-del], [data-activate], [data-toggle]');
    if (!btn) return;
    const id = btn.dataset.preview || btn.dataset.edit || btn.dataset.del || btn.dataset.activate || btn.dataset.toggle;
    const entry = id ? entryById(id) : null;
    try {
      if (btn.dataset.act === 'new') openForm(null);
      else if (btn.dataset.act === 'adapt') {
        const r = await api.post('/api/grid/adapt');
        toast(r.result ? 'Parrilla adaptada a la hora actual' : 'Parrilla ajustada', 'ok');
        await ctx.refresh();
      } else if (btn.dataset.act === 'templates') openTemplates(ctx, entries, lists, categories);
      else if (btn.dataset.edit) openForm(entry);
      else if (btn.dataset.preview) openPreview(entry, ctx);
      else if (btn.dataset.activate) {
        await api.post(`/api/grid/entries/${id}/activate`);
        toast(`Bloque al aire: ${entry.name}`, 'ok');
        await ctx.refresh();
      } else if (btn.dataset.toggle) {
        await api.patch(`/api/grid/entries/${id}`, { enabled: entry.enabled === false });
        await ctx.refresh();
      } else if (btn.dataset.del) {
        if (!await confirmDialog(`¿Eliminar el bloque "${entry.name}"?`, { danger: true, okLabel: 'Eliminar' })) return;
        await api.del(`/api/grid/entries/${id}`);
        toast('Bloque eliminado', 'ok');
        await ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function openPreview(entry, ctx) {
  try {
    const res = await api.get(`/api/grid/entries/${entry.id}/preview`);
    const body = document.createElement('div');
    const total = res.items.reduce((a, i) => a + i.durationSec, 0);
    body.innerHTML = `
      <div class="help-box" style="margin-bottom:10px">
        ${esc(entry.start)}–${esc(entry.end)} · ${esc(typeLabel(entry))} · ${res.items.length} elementos · ${fmtDur(total)} de contenido
        ${entry.endMode === 'afterLast' ? ' · finaliza después del último video' : ' · finaliza a la hora exacta'}
      </div>
      <div class="table-wrap" style="max-height:48vh;overflow:auto">
        <table><thead><tr><th>#</th><th>Título</th><th class="num">Duración</th><th class="num">Inicio estimado</th></tr></thead>
        <tbody>${res.segments.map((s, i) => `<tr>
          <td class="num">${i + 1}</td><td>${esc(s.title)}</td>
          <td class="num">${fmtDur(s.durationSec)}</td><td class="num">${esc(s.start)}</td></tr>`).join('')
          || '<tr><td colspan="4"><div class="empty">Sin contenido resoluble</div></td></tr>'}</tbody></table>
      </div>`;
    openModal({ title: `Vista previa: ${entry.name}`, body, wide: true });
  } catch (err) { toast(err.message, 'err'); }
  void ctx;
}

function openTemplates(ctx, entries, lists, categories) {
  const templates = ctx.state.boot.grid.templates || [];
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <input type="text" id="tpl-name" placeholder="Nombre de la plantilla" style="max-width:280px">
      <button class="btn" id="tpl-save">Guardar parrilla actual como plantilla</button>
    </div>
    <div class="stack" id="tpl-list">
      ${templates.map((t) => `<div class="list-row">
        <span class="title">${esc(t.name)}</span>
        <span class="meta">${t.entries.length} bloques</span>
        <button class="btn btn-xs btn-primary" data-apply="${t.id}">Aplicar</button>
        <button class="btn btn-xs btn-danger" data-delt="${t.id}">✕</button>
      </div>`).join('') || '<div class="empty">No hay plantillas guardadas</div>'}
    </div>
    <div class="help-box" style="margin-top:12px">Aplicar una plantilla reemplaza la parrilla actual. Úsela para cambiar entre parrillas de temporada o de fin de semana.</div>`;
  const modal = openModal({ title: 'Plantillas de parrilla', body, wide: true });

  body.querySelector('#tpl-save').onclick = async () => {
    const name = body.querySelector('#tpl-name').value.trim();
    if (!name) { toast('Indique un nombre', 'err'); return; }
    try {
      await api.post('/api/grid/templates', { name });
      toast('Plantilla guardada', 'ok');
      modal.close();
      await ctx.refresh();
    } catch (err) { toast(err.message, 'err'); }
  };
  body.addEventListener('click', async (e) => {
    const apply = e.target.closest('[data-apply]');
    const del = e.target.closest('[data-delt]');
    if (apply) {
      if (!await confirmDialog('¿Reemplazar la parrilla actual con esta plantilla?', { okLabel: 'Aplicar' })) return;
      try {
        await api.post(`/api/grid/templates/${apply.dataset.apply}/apply`, { replace: true });
        modal.close();
        toast('Plantilla aplicada', 'ok');
        await ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    }
    if (del) {
      try {
        await api.del(`/api/grid/templates/${del.dataset.delt}`);
        modal.close();
        toast('Plantilla eliminada', 'ok');
        await ctx.refresh();
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  void entries; void lists; void categories;
}

function hexA(hex, alpha) {
  const h = String(hex || '#38bdf8').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function onState() { /* la parrilla se refresca con el bootstrap */ }
void DAY_ORDER; void qs;
