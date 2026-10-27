// Publicidad automatizada: bloques, disparadores, cortinas y pausa de la programación.
import { api } from '../api.js';
import { esc, fmtDur, toast, confirmDialog, formModal, openModal, qs, qsa, dayLabel } from '../ui.js';
import { openMediaPicker, emptyState } from '../components.js';

export async function render(root, ctx) {
  const { boot, snap } = ctx.state;
  const blocks = boot.ads || [];
  const media = boot.media || [];
  const running = snap.runtime.mode === 'ads' ? snap.runtime.ads : null;
  const mediaById = (id) => media.find((m) => m.id === id);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Publicidad automatizada</div>
        <div class="page-desc">Cree varios bloques comerciales con cortina de entrada y salida. Proca pausa la programación, oculta logo, reloj y cintillo, y regresa exactamente al punto donde quedó.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-primary" data-act="new">+ Nuevo bloque</button>
      </div>
    </div>

    ${running ? `<div class="card" style="margin-bottom:14px;border-color:rgba(245,158,11,.4)">
      <div class="row">
        <span class="badge amber">AL AIRE</span>
        <strong>${esc(running.blockName)}</strong>
        <span class="muted small">· la programación se reanuda al terminar</span>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-warn" data-act="finish">Cortar bloque y regresar</button>
      </div>
    </div>` : ''}

    <div class="grid-2">
      ${blocks.map((b) => {
        const ads = (b.ads || []).map(mediaById).filter(Boolean);
        return `<div class="card">
          <div class="card-head">
            <div class="card-title">${esc(b.name)}
              ${b.enabled === false ? '<span class="badge gray">Off</span>' : '<span class="badge green">Activo</span>'}
            </div>
            <div class="card-actions">
              <button class="btn btn-xs btn-primary" data-run="${b.id}">▶ Ejecutar</button>
              <button class="btn btn-xs" data-edit="${b.id}">Editar</button>
              <button class="btn btn-xs btn-danger" data-del="${b.id}">✕</button>
            </div>
          </div>

          <div class="row wrap" style="gap:6px;margin-bottom:10px">
            <span class="badge violet">${esc(b.triggerDescription)}</span>
            <span class="badge">${esc(dayLabel(b.days))}</span>
            <span class="badge">${b.adCount} anuncios</span>
            <span class="badge">${b.runsToday}/${b.maxPerDay} hoy</span>
            ${b.hideGraphics ? '<span class="badge amber">Oculta gráficos</span>' : ''}
            ${b.resumePoint ? '<span class="badge cyan">Regresa al punto</span>' : ''}
          </div>

          <div class="small muted" style="margin-bottom:6px">Comerciales</div>
          <div class="stack" style="gap:4px;max-height:168px;overflow:auto">
            ${ads.length ? ads.map((m) => `
              <div class="list-row" style="padding:5px 8px">
                <span class="media-thumb" style="width:26px;height:17px"></span>
                <span class="title small">${esc(m.title)}</span>
                <span class="meta">${fmtDur(m.duration)}</span>
                <button class="btn btn-xs btn-danger" data-rm-ad="${b.id}:${m.id}">✕</button>
              </div>`).join('') : '<div class="muted small">Sin comerciales. Agregue anuncios individuales o una carpeta.</div>'}
          </div>

          <div class="row wrap" style="gap:6px;margin-top:10px">
            <button class="btn btn-xs" data-add-ads="${b.id}">+ Anuncios</button>
            <button class="btn btn-xs" data-preview="${b.id}">Vista previa</button>
            <span class="muted small" style="margin-left:auto">
              ${b.bumpers?.inId && mediaById(b.bumpers.inId) ? `Entrada: ${esc(mediaById(b.bumpers.inId).title)}` : 'Sin cortina de entrada'}
              ${b.bumpers?.outId && mediaById(b.bumpers.outId) ? ` · Salida: ${esc(mediaById(b.bumpers.outId).title)}` : ' · sin cortina de salida'}
            </span>
          </div>
        </div>`;
      }).join('') || `<div class="card">${emptyState('Sin bloques publicitarios', 'Cree su primer bloque para automatizar la pauta.')}</div>`}
    </div>

    <div class="section-title">Cómo se dispara la publicidad</div>
    <div class="grid-3">
      <div class="card"><div class="card-title">Por horario</div>
        <p class="muted small" style="margin-top:6px">A una hora fija del día, o cada cierta cantidad de minutos desde la última emisión. Ideal para pautas fijas.</p></div>
      <div class="card"><div class="card-title">Por cantidad de temas</div>
        <p class="muted small" style="margin-top:6px">Después de N contenidos emitidos. Se reinicia al terminar cada bloque y nunca se repite el mismo anuncio dos veces seguidas.</p></div>
      <div class="card"><div class="card-title">Protección de gráficos</div>
        <p class="muted small" style="margin-top:6px">Durante la publicidad, logo, reloj y cintillo se ocultan automáticamente y se restauran al terminar, junto con la programación.</p></div>
    </div>
  `;

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-run],[data-edit],[data-del],[data-add-ads],[data-preview],[data-rm-ad]');
    if (!t) return;
    const id = t.dataset.run || t.dataset.edit || t.dataset.del || t.dataset.addAds || t.dataset.preview;
    const block = blocks.find((b) => b.id === id);
    try {
      if (t.dataset.act === 'new') return openForm(null, ctx, media);
      if (t.dataset.act === 'finish') {
        await api.post('/api/ads/finish');
        toast('Bloque cortado, programación restaurada', 'ok');
        return ctx.refresh();
      }
      if (t.dataset.run) {
        await api.post(`/api/ads/blocks/${id}/run`);
        toast('Bloque publicitario al aire', 'ok');
        return ctx.refresh();
      }
      if (t.dataset.edit) return openForm(block, ctx, media);
      if (t.dataset.preview) {
        const res = await api.get(`/api/ads/blocks/${id}/preview`);
        const body = document.createElement('div');
        body.innerHTML = `
          <div class="help-box" style="margin-bottom:10px">${res.items.length} elementos · ${fmtDur(res.durationSec)} · ${res.mediaCount} comerciales en el bloque</div>
          <div class="table-wrap" style="max-height:46vh;overflow:auto"><table>
            <thead><tr><th>#</th><th>Tipo</th><th>Título</th><th class="num">Duración</th></tr></thead>
            <tbody>${res.items.map((i, k) => `<tr><td class="num">${k + 1}</td>
              <td>${i.kind === 'bumper' ? '<span class="badge violet">Cortina</span>' : '<span class="badge amber">Anuncio</span>'}</td>
              <td>${esc(i.title)}</td><td class="num">${fmtDur(i.durationSec)}</td></tr>`).join('')}
            </tbody></table></div>`;
        openModal({ title: `Vista previa: ${block.name}`, body, wide: true });
        return;
      }
      if (t.dataset.addAds) {
        const chosen = await openMediaPicker({ title: `Agregar anuncios a "${block.name}"`, multiple: true });
        if (!chosen?.length) return;
        await api.post(`/api/ads/blocks/${id}/ads`, { mediaIds: chosen.map((m) => m.id) });
        toast(`${chosen.length} anuncio(s) agregados`, 'ok');
        return ctx.refresh();
      }
      if (t.dataset.rmAd) {
        const [bid, mid] = t.dataset.rmAd.split(':');
        await api.del(`/api/ads/blocks/${bid}/ads/${mid}`);
        return ctx.refresh();
      }
      if (t.dataset.del) {
        if (!await confirmDialog(`¿Eliminar el bloque "${block.name}"?`, { danger: true, okLabel: 'Eliminar' })) return;
        await api.del(`/api/ads/blocks/${id}`);
        toast('Bloque eliminado', 'ok');
        return ctx.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  });
}

function openForm(block, ctx, media) {
  const b = block || { trigger: { mode: 'clock', at: '12:00', everyMinutes: 30, everyItems: 3 }, days: [0, 1, 2, 3, 4, 5, 6] };
  const mediaOptions = [{ value: '', label: '— Ninguna —' }, ...media.map((m) => ({ value: m.id, label: `${m.title} (${fmtDur(m.duration)})` }))];
  formModal({
    title: block ? `Editar bloque: ${block.name}` : 'Nuevo bloque publicitario',
    wide: true,
    intro: 'La publicidad pausa la programación principal y la reanuda en el mismo punto al terminar. Los gráficos se ocultan y restauran automáticamente.',
    fields: [
      { name: 'name', label: 'Nombre del bloque', value: b.name || '', required: true, full: true },
      { name: 'enabled', label: 'Estado', type: 'checkbox', value: b.enabled !== false, checkLabel: 'Bloque habilitado' },
      { name: 'days', label: 'Días de emisión', type: 'days', value: b.days || [0, 1, 2, 3, 4, 5, 6], full: true },
      { name: 'triggerMode', label: 'Disparador', type: 'select', value: b.trigger?.mode || 'clock', options: [
        { value: 'clock', label: 'A una hora determinada' },
        { value: 'interval', label: 'Cada cierta cantidad de minutos' },
        { value: 'afterItems', label: 'Después de N temas' },
      ] },
      { name: 'at', label: 'Hora de emisión (para horario)', type: 'time', value: b.trigger?.at || '12:00' },
      { name: 'everyMinutes', label: 'Cada N minutos', type: 'number', value: b.trigger?.everyMinutes ?? 30, min: 1 },
      { name: 'everyItems', label: 'Después de N temas', type: 'number', value: b.trigger?.everyItems ?? 3, min: 1 },
      { name: 'maxPerDay', label: 'Máximo de emisiones por día', type: 'number', value: b.maxPerDay ?? 24, min: 1 },
      { name: 'bumperIn', label: 'Cortina de entrada', type: 'select', value: b.bumpers?.inId || '', options: mediaOptions },
      { name: 'bumperOut', label: 'Cortina de salida', type: 'select', value: b.bumpers?.outId || '', options: mediaOptions },
      { name: 'folders', label: 'Carpetas de anuncios (una por línea)', type: 'textarea', value: (b.folders || []).join('\n'), full: true,
        hint: 'Todos los medios importados de esas carpetas se usan como anuncios adicionales.' },
      { name: 'hideGraphics', label: 'Gráficos', type: 'checkbox', value: b.hideGraphics !== false, checkLabel: 'Ocultar logo, reloj y cintillo durante la publicidad' },
      { name: 'resumePoint', label: 'Continuidad', type: 'checkbox', value: b.resumePoint !== false, checkLabel: 'Regresar al punto exacto de la programación' },
      { name: 'shuffle', label: 'Rotación', type: 'checkbox', value: b.shuffle !== false, checkLabel: 'Orden aleatorio evitando repetir anuncios' },
    ],
    submitLabel: block ? 'Guardar' : 'Crear bloque',
    onSubmit: async (v) => {
      const body = {
        name: v.name,
        enabled: v.enabled,
        days: v.days,
        maxPerDay: v.maxPerDay,
        hideGraphics: v.hideGraphics,
        resumePoint: v.resumePoint,
        shuffle: v.shuffle,
        bumpers: { inId: v.bumperIn || null, outId: v.bumperOut || null },
        trigger: { mode: v.triggerMode, at: v.at, everyMinutes: v.everyMinutes, everyItems: v.everyItems },
        folders: String(v.folders || '').split('\n').map((s) => s.trim()).filter(Boolean),
      };
      if (!body.days.length) throw new Error('Seleccione al menos un día');
      if (block) await api.patch(`/api/ads/blocks/${block.id}`, body);
      else await api.post('/api/ads/blocks', body);
      toast(block ? 'Bloque actualizado' : 'Bloque creado', 'ok');
      await ctx.refresh();
    },
  });
}

export function onState(snap, ctx) {
  if (ctx?.state?.name !== 'ads') return;
  const el = qs('[data-act="finish"]');
  if (el && snap.runtime.mode !== 'ads') void el;
}
void qsa; void emptyState;
