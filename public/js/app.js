// Arranque de la interfaz: estado global, SSE, rutas y barra superior.
import { api } from './api.js';
import { qs, esc, stateLabel, stateClass, toast, fmtDur, relTime } from './ui.js';
import * as monitor from './views/monitor.js';
import * as playlists from './views/playlists.js';
import * as grid from './views/grid.js';
import * as ads from './views/ads.js';
import * as library from './views/library.js';
import * as graphics from './views/graphics.js';
import * as live from './views/live.js';
import * as recording from './views/recording.js';
import * as emergency from './views/emergency.js';
import * as asrun from './views/asrun.js';
import * as settings from './views/settings.js';

const VIEWS = { monitor, playlists, grid, ads, library, graphics, live, recording, emergency, asrun, settings };

export const state = {
  boot: null,
  snap: null,
  view: null,
  name: 'monitor',
  loading: true,
};

const ctx = {
  state,
  api,
  refresh,
  rerender,
  go,
  get snap() { return state.snap; },
  get boot() { return state.boot; },
};

export async function refresh() {
  state.boot = await api.get('/api/bootstrap');
  state.snap = state.boot.snapshot;
  renderNavAndHeader();
  const mod = VIEWS[state.name] || monitor;
  await renderView(mod);
}

export async function refreshQuiet() {
  // Refresca datos sin destruir el DOM (usado tras operaciones menores).
  state.boot = await api.get('/api/bootstrap');
  state.snap = state.boot.snapshot;
  renderNavAndHeader();
}

export function rerender() {
  const mod = VIEWS[state.name] || monitor;
  return renderView(mod);
}

export function go(hash) {
  if (location.hash === hash) {
    rerender();
    return;
  }
  location.hash = hash;
}

async function renderView(mod) {
  // Se reemplaza el contenedor por uno nuevo para que no queden listeners
  // de la vista anterior acumulados en #view.
  document.onkeydown = null;
  const old = qs('#view');
  const root = old.cloneNode(false);
  root.innerHTML = '<div class="loading">Cargando…</div>';
  old.replaceWith(root);
  try {
    await mod.render(root, ctx);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="alert danger"><div><div class="a-title">No se pudo cargar la vista</div>${esc(err.message)}</div></div>`;
  }
}

function renderNavAndHeader() {
  const snap = state.snap;
  const boot = state.boot;
  if (!snap) return;

  // Navegación
  document.querySelectorAll('#nav .nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === state.name);
  });

  const mode = snap.runtime.mode;
  const badge = qs('#mode-badge');
  badge.textContent = snap.runtime.paused ? 'PAUSADO' : stateLabel(mode);
  badge.className = `onair-badge ${snap.runtime.paused ? 'ads' : stateClass(mode)}`;

  const item = snap.runtime.currentItem;
  const title = item?.title || (mode === 'live' ? snap.runtime.live?.label : '') || (mode === 'slate' ? 'Sin contenido al aire' : '—');
  qs('#onair-title').textContent = title;

  const bits = [];
  if (snap.runtime.sourceName) bits.push(snap.runtime.sourceName);
  if (snap.runtime.itemCount) bits.push(`Elemento ${snap.runtime.index + 1} de ${snap.runtime.itemCount}`);
  if (snap.runtime.paused) bits.push('Pausado por el operador');
  if (snap.obs?.connected) bits.push(snap.obs.mock ? 'OBS simulador' : 'OBS conectado');
  else bits.push('OBS sin conexión');
  qs('#onair-sub').textContent = bits.join(' · ');

  const pct = Math.round((snap.runtime.progress || 0) * 100);
  qs('#mini-progress').style.width = `${Math.min(100, pct)}%`;

  const obs = snap.obs || {};
  const chip = qs('#obs-chip');
  chip.className = `obs-chip ${obs.connected ? (obs.mock ? 'mock' : 'on') : (obs.lastError ? 'err' : '')}`;
  chip.querySelector('.obs-text').textContent = obs.connected
    ? (obs.mock ? 'OBS simulador activo' : `OBS ${obs.cfg?.host || ''}:${obs.cfg?.port || ''}`)
    : (obs.lastError ? 'OBS sin conexión' : 'OBS desconectado');

  // Reloj del canal
  const tz = boot?.settings?.app?.timezone || 'UTC';
  const fmtOpts = {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: (boot?.settings?.app?.timeFormat || '24') === '12',
  };
  const dateOpts = { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long' };
  try {
    qs('#clock').textContent = new Intl.DateTimeFormat('es-NI', fmtOpts).format(new Date());
    qs('#clock-date').textContent = new Intl.DateTimeFormat('es-NI', dateOpts).format(new Date());
  } catch { /* zona inválida */ }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    try {
      state.snap = JSON.parse(e.data);
      state.loading = false;
      renderNavAndHeader();
      const mod = VIEWS[state.name];
      if (mod?.onState) mod.onState(state.snap, ctx);
      document.body.dataset.mode = state.snap.runtime.mode;
    } catch (err) {
      console.error('SSE', err);
    }
  });
  es.onerror = () => {
    qs('#onair-sub').textContent = 'Reconectando con Proca…';
  };
}

function routeFromHash() {
  const name = (location.hash.replace(/^#\//, '') || 'monitor').split('?')[0];
  state.name = VIEWS[name] ? name : 'monitor';
}

window.addEventListener('hashchange', async () => {
  routeFromHash();
  if (!state.boot) return;
  await renderView(VIEWS[state.name] || monitor);
  renderNavAndHeader();
  qs('#sidebar').classList.remove('open');
});

qs('#menu-btn')?.addEventListener('click', () => qs('#sidebar').classList.toggle('open'));

qs('#quick-next')?.addEventListener('click', async () => {
  try {
    await api.post('/api/playout/next');
    toast('Siguiente elemento enviado', 'ok');
    refreshQuiet();
  } catch (err) { toast(err.message, 'err'); }
});

qs('#quick-pause')?.addEventListener('click', async () => {
  try {
    const paused = state.snap?.runtime?.paused;
    await api.post(paused ? '/api/playout/resume' : '/api/playout/pause');
    toast(paused ? 'Reproducción reanudada' : 'Reproducción pausada', 'ok');
    refreshQuiet();
  } catch (err) { toast(err.message, 'err'); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ' && !e.ctrlKey) {
    e.preventDefault();
    qs('#quick-pause')?.click();
  }
});

setInterval(() => {
  if (state.boot) renderNavAndHeader();
}, 1000);

routeFromHash();

(async () => {
  try {
    await refresh();
    connectEvents();
  } catch (err) {
    qs('#view').innerHTML = `<div class="alert danger"><div><div class="a-title">Error de conexión</div>${esc(err.message)}</div></div>`;
  }
})();

window.proca = { state, refresh, go };
