// Vista principal: monitoreo de la emisión y controles maestros.
import { api } from '../api.js';
import {
  esc, fmtDur, fmtTime, stateLabel, stateClass, toast, confirmDialog, openModal, qs, qsa,
} from '../ui.js';
import { openMediaPicker, kvRow } from '../components.js';

let ctxRef = null;
let lastSig = '';

const GRADIENTS = [
  ['#0ea5e9', '#1e3a8a'], ['#f97316', '#7c2d12'], ['#22c55e', '#064e3b'],
  ['#a855f7', '#4c1d95'], ['#ef4444', '#7f1d1d'], ['#14b8a6', '#134e4a'],
  ['#6366f1', '#1e1b4b'], ['#eab308', '#713f12'],
];

function gradientFor(item) {
  if (item?.visual?.length === 2) return item.visual;
  const key = item?.title || 'Proca';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
  return GRADIENTS[h % GRADIENTS.length];
}

function modeAlert(snap) {
  const rt = snap.runtime;
  if (rt.mode === 'emergency') {
    return `<div class="alert danger"><div><div class="a-title">Emergencia al aire</div>
      ${esc(rt.emergency?.reason || 'Se detectó una caída de señal')}. La programación se reanudará automáticamente si está configurado.
      </div></div>`;
  }
  if (rt.mode === 'ads') {
    return `<div class="alert warn"><div><div class="a-title">Bloque publicitario en curso</div>
      ${esc(rt.ads?.blockName || 'Publicidad')} · la programación se reanuda al terminar.</div></div>`;
  }
  if (rt.mode === 'live') {
    return `<div class="alert danger"><div><div class="a-title"><span class="dot-live"></span> Intervención en vivo</div>
      ${esc(rt.live?.label || 'Señal externa')}${rt.live?.endAt ? ` · finaliza a las ${fmtTime(rt.live.endAt)}` : ''}</div></div>`;
  }
  if (rt.paused) {
    return `<div class="alert warn"><div><div class="a-title">Emisión pausada</div>El operador pausó la reproducción. Use Continuar para regresar al aire.</div></div>`;
  }
  if (!snap.obs?.connected) {
    return `<div class="alert warn"><div><div class="a-title">OBS desconectado</div>
      La automatización mantiene la posición y se restaurará al reconectar. <a href="#/settings">Configurar conexión</a></div></div>`;
  }
  if (rt.mode === 'slate') {
    return `<div class="alert danger"><div><div class="a-title">Sin contenido al aire</div>
      ${esc(rt.sourceName || 'Slate')} está ocupando la pantalla para evitar el negro. <a href="#/playlists">Activar una lista</a></div></div>`;
  }
  return `<div class="alert ok"><div><div class="a-title">Señal estable</div>
    Proca administra la emisión ${esc(stateLabel(rt.mode).toLowerCase())} y protege la salida ante cualquier interrupción.</div></div>`;
}

export async function render(root, ctx) {
  ctxRef = ctx;
  const { boot, snap } = ctx.state;
  if (!boot || !snap) return;
  lastSig = '';
  const rt = snap.runtime;
  const obs = snap.obs || {};
  const mediaList = boot.playlists || [];
  const adBlocks = boot.ads || [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">En vivo</div>
        <div class="page-desc">Proca controla OBS como motor de reproducción. Aquí se monitorea y se interviene la señal del canal.</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm" data-act="air">⇪ Enviar al aire</button>
        <button class="btn btn-sm" data-act="ads">▶ Publicidad</button>
        <a class="btn btn-sm" href="#/live">● En vivo</a>
        <button class="btn btn-sm btn-warn" data-act="emergency">⚠ Emergencia</button>
      </div>
    </div>

    <div class="monitor-grid">
      <div class="stack">
        <div class="preview" id="preview">
          <div class="preview-bg" id="preview-bg"></div>
          <iframe src="/overlay" title="Gráficos del canal" loading="eager"></iframe>
          <div class="preview-badge">PROGRAMA · SALIDA OBS</div>
          <div class="preview-overlay-note">logo · reloj · cintillo reales</div>
        </div>
        <div class="progress"><div class="progress-bar" id="pbar"></div></div>
        <div class="times"><span id="t-elapsed">00:00</span><span class="muted" id="t-mode">—</span><span id="t-remaining">-00:00</span></div>

        <div class="play-controls">
          <button class="btn btn-primary btn-play" id="btn-toggle">${rt.paused ? '▶ Continuar' : '⏸ Pausar'}</button>
          <button class="btn" data-act="prev">⏮ Anterior</button>
          <button class="btn" data-act="next">⏭ Siguiente</button>
          <button class="btn btn-danger" data-act="stop">■ Detener</button>
          <button class="btn" data-act="seek">↺ Reiniciar tema</button>
          <button class="btn" data-act="reload">⟳ Regresar a 24/7</button>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Cola de reproducción <span class="sub" id="queue-sub"></span></div>
            <div class="card-actions">
              <button class="btn btn-xs" data-act="switch-list">Cambiar lista</button>
            </div>
          </div>
          <div class="next-list" id="next-list"></div>
        </div>
      </div>

      <div class="stack" id="side">
        <div id="alert-slot">${modeAlert(snap)}</div>

        <div class="card">
          <div class="card-head"><div class="card-title">Estado de emisión</div>
            <div class="card-actions"><span class="badge ${stateClass(rt.mode) === 'live' ? 'red' : 'cyan'}">${esc(stateLabel(rt.mode))}</span></div>
          </div>
          <div id="kv-emission">
            ${kvRow('Señal', esc(rt.sourceName || '—'))}
            ${kvRow('Elemento', rt.currentItem ? `${esc(rt.currentItem.title)}` : '—')}
            ${kvRow('Posición', `${rt.index + 1} / ${rt.itemCount || 0}`)}
            ${kvRow('Inicio del tema', rt.currentItem ? fmtTime(Date.now() - (rt.elapsedSec || 0) * 1000) : '—')}
            ${kvRow('Duración', rt.currentItem ? fmtDur(rt.currentItem.durationSec) : '—')}
            ${kvRow('Modo', esc(stateLabel(rt.mode)))}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">OBS</div>
            <div class="card-actions">
              <span class="badge ${obs.connected ? (obs.mock ? 'amber' : 'green') : 'red'}">${obs.connected ? (obs.mock ? 'Simulador' : 'Conectado') : 'Desconectado'}</span>
            </div>
          </div>
          <div class="kv"><span class="k">Escena en programa</span><span class="v mono" id="obs-scene">${esc(obs.currentScene || '—')}</span></div>
          <div class="kv"><span class="k">Fuente de medios</span><span class="v mono">${esc(obs.cfg?.mediaSource || '—')} · ${esc(obs.cfg?.mediaMode || 'single')}</span></div>
          <div class="kv"><span class="k">Grabación</span><span class="v">
            <span class="rec-dot ${snap.recording?.active ? '' : 'off'}" style="display:inline-block;vertical-align:-2px;width:9px;height:9px"></span>
            ${snap.recording?.active ? `<span class="mono" id="rec-time">${fmtDur((Date.now() / 1000) - (snap.recording.startedAt / 1000))}</span>` : 'inactiva'}
            </span></div>
          <div class="row wrap" style="margin-top:10px;gap:6px">
            <button class="btn btn-xs" data-act="rec-toggle">${snap.recording?.active ? '⏹ Detener grabación' : '⏺ Grabar'}</button>
            <button class="btn btn-xs" data-act="obs-refresh">⟳ Refrescar fuentes</button>
            ${obs.mock ? '<button class="btn btn-xs" data-act="sim-silence">Simular silencio</button><button class="btn btn-xs" data-act="sim-drop">Simular caída</button>' : ''}
          </div>
          <div class="row wrap" style="margin-top:8px;gap:6px">
            ${(obs.scenes || []).slice(0, 6).map((s) => `<button class="btn btn-xs" data-scene="${esc(s.sceneName)}">${esc(s.sceneName)}</button>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Parrilla de hoy</div>
            <div class="card-actions"><a class="btn btn-xs" href="#/grid">Ver parrilla</a></div>
          </div>
          <div id="grid-now">
            ${snap.schedule?.current
              ? `<div class="alert info" style="margin-bottom:8px"><div><div class="a-title">${esc(snap.schedule.current.name)}</div>
                  ${esc(snap.schedule.current.start)} – ${esc(snap.schedule.current.end)} · ${esc((snap.schedule.current.days || []).length === 7 ? 'todos los días' : '')}</div></div>`
              : '<div class="muted small" style="margin-bottom:8px">No hay bloque de parrilla activo ahora.</div>'}
            <div class="stack" style="gap:4px">
              ${(snap.schedule?.upcoming || []).slice(0, 3).map((u) => `
                <div class="kv"><span class="k">${esc(u.start)} · ${esc(u.name)}</span>
                <span class="v">${u.startsInMinutes > 60 ? `${Math.floor(u.startsInMinutes / 60)} h ${u.startsInMinutes % 60} m` : `${u.startsInMinutes} min`}</span></div>`).join('') || '<div class="muted small">Sin próximos bloques.</div>'}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">Acciones rápidas</div></div>
          <div class="stack" style="gap:6px">
            <button class="btn btn-sm" data-act="air">⇪ Enviar un video al aire</button>
            <button class="btn btn-sm" data-act="switch-list">≡ Activar otra lista 24/7</button>
            <button class="btn btn-sm" data-act="ads">▶ Ejecutar bloque publicitario</button>
            <a class="btn btn-sm" href="#/recording">⏺ Grabación programada</a>
            <a class="btn btn-sm" href="#/asrun">☰ Historial As-Run</a>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title">Últimos eventos <span class="muted">· lo que realmente salió al aire</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Inicio</th><th>Tipo</th><th>Título</th><th>Bloque / lista</th><th class="num">Duración</th><th>Salida</th></tr></thead>
        <tbody id="asrun-mini">${asrunRows(snap)}</tbody>
      </table>
    </div>
  `;

  wire(root, ctx);
  updatePreview(snap);
}

function asrunRows(snap) {
  const rows = (snap.asrunHead || []).slice(0, 6);
  if (!rows.length) return '<tr><td colspan="6"><div class="empty">Aún no hay registros</div></td></tr>';
  return rows.map((r) => `<tr>
    <td class="mono" style="font-size:11px">${fmtTime(r.ts)}</td>
    <td>${kindBadge(r.kind)}</td>
    <td class="truncate" style="max-width:280px">${esc(r.title)}</td>
    <td class="muted">${esc(r.block || r.playlistName || '—')}</td>
    <td class="num">${fmtDur(r.durationSec || (Date.now() - r.ts) / 1000)}</td>
    <td class="muted small">${esc(r.exitReason || 'al aire')}</td>
  </tr>`).join('');
}

function kindBadge(kind) {
  const map = {
    program: ['Programa', 'cyan'], ad: ['Publicidad', 'amber'], bumper: ['Cortina', 'violet'],
    live: ['En vivo', 'red'], emergency: ['Emergencia', 'red'], slate: ['Slate', 'gray'],
  };
  const [label, cls] = map[kind] || [kind, ''];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function updatePreview(snap) {
  const rt = snap.runtime;
  const item = rt.currentItem;
  const bg = qs('#preview-bg');
  if (bg) {
    const [c1, c2] = gradientFor(item);
    const label = rt.mode === 'live'
      ? `<h3>${esc(rt.live?.label || 'EN VIVO')}</h3><p>SEÑAL EN DIRECTO</p>`
      : rt.mode === 'ads'
        ? `<h3>PUBLICIDAD</h3><p>${esc(rt.ads?.blockName || 'BLOQUE COMERCIAL')}</p>`
        : item
          ? `<h3>${esc(item.title)}</h3><p>${esc([item.genre, item.category].filter(Boolean).join(' · ') || 'PROGRAMACIÓN 24/7')}</p>`
          : `<h3>SIN SEÑAL</h3><p>PROCA PROTEGE LA SALIDA</p>`;
    bg.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    bg.innerHTML = `<div class="title-art">${label}</div>`;
  }

  const pbar = qs('#pbar');
  if (pbar) {
    pbar.style.width = `${Math.min(100, (rt.progress || 0) * 100)}%`;
    pbar.classList.toggle('red', rt.mode === 'live' || rt.mode === 'emergency');
  }
  const elapsed = qs('#t-elapsed');
  if (elapsed) elapsed.textContent = `${fmtDur(rt.elapsedSec)} / ${fmtDur(item?.durationSec || 0)}`;
  const remaining = qs('#t-remaining');
  if (remaining) remaining.textContent = `-${fmtDur(rt.remainingSec)}`;
  const tmode = qs('#t-mode');
  if (tmode) tmode.textContent = `${stateLabel(rt.mode)}${rt.paused ? ' · pausado' : ''}`;

  const btn = qs('#btn-toggle');
  if (btn) btn.textContent = rt.paused ? '▶ Continuar' : '⏸ Pausar';

  const sig = `${rt.index}:${rt.itemCount}:${item?.title || ''}:${rt.mode}:${rt.sourceName}:${(snap.queue || []).length}`;
  if (sig !== lastSig) {
    lastSig = sig;
    const sub = qs('#queue-sub');
    if (sub) sub.textContent = `· ${rt.sourceName || ''} (${rt.itemCount || 0} elementos)`;
    const list = qs('#next-list');
    if (list) list.innerHTML = queueRows(snap);
    const kv = qs('#kv-emission');
    if (kv) {
      kv.innerHTML = [
        kvRow('Señal', esc(rt.sourceName || '—')),
        kvRow('Elemento', rt.currentItem ? esc(rt.currentItem.title) : '—'),
        kvRow('Posición', `${rt.index + 1} / ${rt.itemCount || 0}`),
        kvRow('Inicio del tema', rt.currentItem ? fmtTime(Date.now() - (rt.elapsedSec || 0) * 1000) : '—'),
        kvRow('Duración', rt.currentItem ? fmtDur(rt.currentItem.durationSec) : '—'),
        kvRow('Modo', esc(stateLabel(rt.mode))),
      ].join('');
    }
  }
}

function queueRows(snap) {
  const rt = snap.runtime;
  const queue = snap.queue || [];
  if (!queue.length) {
    return `<div class="empty" style="padding:18px">${rt.mode === 'live' || rt.mode === 'slate'
      ? 'Sin cola: la señal está bajo control directo.'
      : 'Cargue una lista para ver la cola de reproducción.'}</div>`;
  }
  return queue.map((it, k) => `
    <div class="next-item" data-goto="${it.index}" style="${k === 0 ? 'background:rgba(34,211,238,.08)' : ''}">
      <span class="idx">${k === 0 ? '▶' : String(it.index + 1).padStart(2, '0')}</span>
      <span class="tt">${esc(it.title)}</span>
      <span class="du">${fmtDur(it.durationSec)}</span>
    </div>`).join('');
}

function wire(root, ctx) {
  const act = (handler) => async (e) => {
    e.preventDefault();
    try { await handler(e); } catch (err) { toast(err.message, 'err'); }
  };

  root.addEventListener('click', async (e) => {
    const sceneBtn = e.target.closest('[data-scene]');
    if (sceneBtn) {
      try {
        await api.post('/api/obs/scene', { scene: sceneBtn.dataset.scene });
        toast(`Escena: ${sceneBtn.dataset.scene}`, 'ok');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      try {
        await api.post('/api/playout/goto', { index: Number(goto.dataset.goto) });
        toast('Elemento al aire', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const action = btn.dataset.act;
    try {
      if (action === 'prev') { await api.post('/api/playout/previous'); toast('Anterior al aire', 'ok'); }
      else if (action === 'next') { await api.post('/api/playout/next'); toast('Siguiente al aire', 'ok'); }
      else if (action === 'stop') {
        if (await confirmDialog('¿Detener la emisión? El canal quedará en slate hasta que active una lista.', { danger: true, okLabel: 'Detener' })) {
          await api.post('/api/playout/stop');
          toast('Emisión detenida', 'warn');
        }
      } else if (action === 'seek') {
        await api.post('/api/playout/seek', { offsetSec: 0 });
        toast('Tema reiniciado', 'ok');
      } else if (action === 'reload') {
        await api.post('/api/playout/automation', {});
        toast('Programación 24/7 activada', 'ok');
      } else if (action === 'air') {
        const media = await openMediaPicker({ title: 'Enviar al aire', note: 'El video se reproduce inmediatamente y luego se regresa al punto de la programación.' });
        if (media) {
          await api.post('/api/playout/air', { mediaId: media.id });
          toast(`Al aire: ${media.title}`, 'ok');
        }
      } else if (action === 'ads') {
        const res = await api.get('/api/ads');
        if (!res.blocks.length) { toast('No hay bloques publicitarios', 'warn'); return; }
        const body = document.createElement('div');
        body.innerHTML = `<div class="stack">${res.blocks.map((b) => `
          <button class="list-row" data-block="${b.id}" style="width:100%;text-align:left;cursor:pointer;background:var(--panel)">
            <span class="title">${esc(b.name)}</span>
            <span class="meta">${b.adCount} anuncios · ${esc(b.triggerDescription)}</span>
          </button>`).join('')}</div>`;
        const modal = openModal({ title: 'Ejecutar bloque publicitario', body, wide: false });
        body.addEventListener('click', async (ev) => {
          const b = ev.target.closest('[data-block]');
          if (!b) return;
          modal.close();
          try {
            await api.post(`/api/ads/blocks/${b.dataset.block}/run`);
            toast('Bloque publicitario al aire', 'ok');
          } catch (err) { toast(err.message, 'err'); }
        });
      } else if (action === 'switch-list') {
        const lists = ctx.state.boot.playlists;
        const body = document.createElement('div');
        body.innerHTML = `<div class="stack">${lists.map((p) => `
          <button class="list-row" data-list="${p.id}" style="width:100%;text-align:left;cursor:pointer;background:var(--panel)">
            <span class="title">${esc(p.name)}</span>
            <span class="meta">${p.resolvedCount} elementos</span>
          </button>`).join('')}</div>`;
        const modal = openModal({ title: 'Activar lista 24/7', body });
        body.addEventListener('click', async (ev) => {
          const b = ev.target.closest('[data-list]');
          if (!b) return;
          modal.close();
          try {
            await api.post('/api/playlists/' + b.dataset.list + '/play');
            toast('Lista al aire', 'ok');
          } catch (err) { toast(err.message, 'err'); }
        });
      } else if (action === 'rec-toggle') {
        if (ctx.state.snap.recording.active) await api.post('/api/recording/stop', {});
        else await api.post('/api/recording/start', { name: 'Grabación manual' });
        toast('Grabación actualizada', 'ok');
      } else if (action === 'obs-refresh') {
        const r = await api.post('/api/obs/refresh');
        toast(`OBS: ${(r.scenes || []).length} escenas, ${(r.inputs || []).length} fuentes`, 'ok');
      } else if (action === 'sim-silence') {
        await api.post('/api/obs/simulate', { what: 'silence' });
        toast('Silencio simulado: el anti dead-air actuará en unos segundos', 'warn');
      } else if (action === 'sim-drop') {
        await api.post('/api/obs/simulate', { what: 'drop' });
        toast('Caída simulada de OBS', 'warn');
      } else if (action === 'emergency') {
        const res = await api.get('/api/emergency');
        if (res.active) {
          if (await confirmDialog('La emergencia está activa. ¿Regresar a la programación normal?')) {
            await api.post('/api/emergency/exit');
            toast('Programación restaurada', 'ok');
          }
        } else if (await confirmDialog('¿Activar la playlist de emergencia ahora? La programación se reanudará al salir.', { okLabel: 'Activar' })) {
          await api.post('/api/emergency/test');
          toast('Emergencia activada', 'warn');
        }
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  qs('#btn-toggle')?.addEventListener('click', async () => {
    try {
      const paused = ctx.state.snap.runtime.paused;
      await api.post(paused ? '/api/playout/resume' : '/api/playout/pause');
      toast(paused ? 'Reproducción reanudada' : 'Emisión pausada', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  wire.act = act;
}

export function onState(snap, ctx) {
  if (ctx?.state?.name !== 'monitor') return;
  if (!qs('#preview-bg')) return;
  updatePreview(snap);
  const alertSlot = qs('#alert-slot');
  if (alertSlot) alertSlot.innerHTML = modeAlert(snap);

  const recTime = qs('#rec-time');
  if (recTime && snap.recording?.startedAt) recTime.textContent = fmtDur((Date.now() - snap.recording.startedAt) / 1000);

  const tbody = qs('#asrun-mini');
  if (tbody) {
    const sig = (snap.asrunHead || []).map((r) => r.id).join(',');
    if (tbody.dataset.sig !== sig) {
      tbody.dataset.sig = sig;
      tbody.innerHTML = asrunRows(snap);
    }
  }
}
