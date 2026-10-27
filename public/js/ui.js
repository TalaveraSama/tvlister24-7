// Componentes y utilidades de interfaz.

export const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const DOW_LONG = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b > 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

export function fmtNum(n) {
  return new Intl.NumberFormat('es-NI').format(Number(n) || 0);
}

export function fmtDateTime(ts, tz) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('es-NI', {
      timeZone: tz || 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

export function fmtTime(ts, tz) {
  if (!ts) return '—';
  try {
    return new Intl.DateTimeFormat('es-NI', {
      timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

export function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'hace segundos';
  if (diff < 3600000) return `hace ${Math.round(diff / 60000)} min`;
  if (diff < 86400000) return `hace ${Math.round(diff / 3600000)} h`;
  return `hace ${Math.round(diff / 86400000)} d`;
}

export function dayLabel(days = []) {
  if (!Array.isArray(days)) return '';
  const set = [...days].map(Number).sort((a, b) => a - b);
  if (set.length === 7) return 'Todos los días';
  if (set.join(',') === '1,2,3,4,5') return 'Lun a Vie';
  if (set.join(',') === '0,6') return 'Fin de semana';
  return set.map((d) => DOW[d]).join(' ');
}

export function badge(text, cls = '') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

export function toast(message, type = 'info') {
  const root = qs('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, type === 'err' ? 5200 : 3200);
}

export function openModal({ title, body, footer, wide = false, onMount }) {
  const root = qs('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">${esc(title || '')}</div>
        <button class="modal-close" aria-label="Cerrar">×</button>
      </div>
      <div class="modal-body"></div>
      ${footer ? '<div class="modal-foot"></div>' : ''}
    </div>`;
  const bodyEl = backdrop.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  if (footer) {
    const footEl = backdrop.querySelector('.modal-foot');
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else footEl.appendChild(footer);
  }
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('.modal-close').onclick = close;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  root.appendChild(backdrop);
  onMount?.({ root: backdrop, body: bodyEl, close });
  return { root: backdrop, body: bodyEl, close };
}

export function confirmDialog(message, { title = 'Confirmar', danger = false, okLabel = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    const footer = document.createElement('div');
    footer.className = 'row';
    footer.style.gap = '8px';
    footer.innerHTML = `
      <button class="btn" data-x="cancel">Cancelar</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-x="ok">${esc(okLabel)}</button>`;
    const modal = openModal({
      title,
      body: `<p style="color:var(--muted);line-height:1.6">${esc(message)}</p>`,
      footer,
    });
    footer.querySelector('[data-x="cancel"]').onclick = () => { modal.close(); resolve(false); };
    footer.querySelector('[data-x="ok"]').onclick = () => { modal.close(); resolve(true); };
  });
}

/**
 * Modal con formulario generado a partir de una definición de campos.
 * field: { name, label, type, value, options, required, hint, min, max, step,
 *          placeholder, full, rows, multiple, accept, disabled }
 */
export function formModal({ title, fields = [], submitLabel = 'Guardar', wide = false, intro = '', onSubmit, extraFooter = null }) {
  const idFor = (name) => `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const renderField = (f) => {
    const id = idFor(f.name);
    const value = f.value ?? '';
    let control = '';
    if (f.type === 'select') {
      control = `<select id="${id}" name="${esc(f.name)}" ${f.multiple ? 'multiple' : ''}>
        ${(f.options || []).map((o) => {
          const val = typeof o === 'object' ? o.value : o;
          const label = typeof o === 'object' ? o.label : o;
          const sel = f.multiple
            ? (Array.isArray(value) && value.includes(val) ? 'selected' : '')
            : (String(value) === String(val) ? 'selected' : '');
          return `<option value="${esc(val)}" ${sel}>${esc(label)}</option>`;
        }).join('')}
      </select>`;
    } else if (f.type === 'textarea') {
      control = `<textarea id="${id}" name="${esc(f.name)}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}">${esc(value)}</textarea>`;
    } else if (f.type === 'checkbox' || f.type === 'switch') {
      control = `<label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}" ${value ? 'checked' : ''}> ${esc(f.checkLabel || 'Activado')}</label>`;
    } else if (f.type === 'days') {
      const active = new Set((Array.isArray(value) ? value : [0, 1, 2, 3, 4, 5, 6]).map(Number));
      control = `<div class="days-picker" data-name="${esc(f.name)}">
        ${DOW.map((d, i) => `<span class="day-chip ${active.has(i) ? 'on' : ''}" data-day="${i}">${d}</span>`).join('')}
      </div>`;
    } else if (f.type === 'switch-row') {
      control = `<label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}" ${value ? 'checked' : ''}> ${esc(f.checkLabel || '')}</label>`;
    } else if (f.type === 'static') {
      control = `<div>${f.html || esc(value)}</div>`;
    } else {
      control = `<input type="${f.type || 'text'}" id="${id}" name="${esc(f.name)}" value="${esc(value)}"
        ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}
        ${f.step !== undefined ? `step="${f.step}"` : ''} placeholder="${esc(f.placeholder || '')}"
        ${f.required ? 'required' : ''} ${f.disabled ? 'disabled' : ''}>`;
    }
    return `<div class="field ${f.full ? 'full' : ''}" style="${f.full ? 'grid-column:1/-1' : ''}">
      <label for="${id}">${esc(f.label || f.name)}${f.required ? ' *' : ''}</label>
      ${control}
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
    </div>`;
  };

  const form = document.createElement('form');
  form.innerHTML = `
    ${intro ? `<div class="help-box" style="margin-bottom:14px">${intro}</div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px" class="form-grid">
      ${fields.map(renderField).join('')}
    </div>`;

  // Días: chips clicables
  form.querySelectorAll('.days-picker').forEach((picker) => {
    picker.addEventListener('click', (e) => {
      const chip = e.target.closest('.day-chip');
      if (!chip) return;
      chip.classList.toggle('on');
    });
  });

  const footer = document.createElement('div');
  footer.innerHTML = `
    <button type="button" class="btn" data-x="cancel">Cancelar</button>
    <button type="submit" class="btn btn-primary" form="proca-form">${esc(submitLabel)}</button>`;
  if (extraFooter) footer.prepend(extraFooter);

  form.id = 'proca-form';
  const modal = openModal({ title, body: form, footer, wide });
  footer.querySelector('[data-x="cancel"]').onclick = modal.close;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      if (f.type === 'days') {
        values[f.name] = [...form.querySelectorAll(`.days-picker[data-name="${f.name}"] .day-chip.on`)]
          .map((c) => Number(c.dataset.day)).sort((a, b) => a - b);
      } else if (f.type === 'checkbox' || f.type === 'switch' || f.type === 'switch-row') {
        values[f.name] = !!form.querySelector(`[name="${f.name}"]`)?.checked;
      } else if (f.type === 'static') {
        continue;
      } else {
        const input = form.querySelector(`[name="${f.name}"]`);
        let v = input?.value;
        if (f.type === 'number') v = v === '' ? null : Number(v);
        values[f.name] = v;
      }
      if (f.required && (values[f.name] === '' || values[f.name] === null || values[f.name] === undefined)) {
        toast(`Falta completar: ${f.label || f.name}`, 'err');
        return;
      }
    }
    const submitBtn = footer.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    try {
      await onSubmit(values);
      modal.close();
    } catch (err) {
      toast(err.message || 'Error al guardar', 'err');
    } finally {
      submitBtn.disabled = false;
    }
  });
  return modal;
}

/** Genera opciones de días para reutilizar en formularios. */
export function daysOptions(value = []) {
  return value;
}

export function stateLabel(mode) {
  return ({
    automation: 'AUTOMATIZACIÓN 24/7',
    schedule: 'PARRILLA',
    ads: 'PUBLICIDAD',
    live: 'EN VIVO',
    emergency: 'EMERGENCIA',
    slate: 'SLATE',
    manual: 'MANUAL',
    idle: 'EN ESPERA',
  })[mode] || String(mode || '').toUpperCase();
}

export function stateClass(mode) {
  if (mode === 'live') return 'live';
  if (mode === 'ads') return 'ads';
  if (mode === 'emergency') return 'emergency';
  if (mode === 'schedule') return 'schedule';
  if (mode === 'automation' || mode === 'manual') return 'automation';
  return '';
}

/** Menú contextual (clic derecho) reutilizable. */
export function openContextMenu(x, y, items = []) {
  const existing = qs('.ctx-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = `${Math.min(x, window.innerWidth - 230)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - items.length * 34 - 20)}px`;
  menu.innerHTML = items.map((it, i) => `
    <button class="ctx-item ${it.danger ? 'danger' : ''}" data-ctx="${i}" ${it.disabled ? 'disabled' : ''}>
      <span>${esc(it.label)}</span>${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ''}
    </button>`).join('');
  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', close, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', close, true);
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx]');
    if (!btn || btn.disabled) return;
    const item = items[Number(btn.dataset.ctx)];
    close();
    item?.onClick?.();
  });
  return { close };
}

/** Copia texto al portapapeles con respaldo para contextos sin permisos. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* sigue el respaldo */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  } catch {
    return false;
  }
}
