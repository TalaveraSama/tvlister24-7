// Gráficos del canal: logo, reloj, cintillo y "estás viendo / a continuación / más tarde".
import { tzParts, formatClock, hhmmToMinutes } from '../time.js';

const SPEED_MS = { lento: 42000, normal: 26000, rapido: 14000 };

function scheduledTitleAt(graphics, parts) {
  const list = graphics.scheduledTitles || [];
  for (const item of list) {
    if (!item.text) continue;
    if (Array.isArray(item.days) && item.days.length && !item.days.includes(parts.dayOfWeek)) continue;
    const from = hhmmToMinutes(item.from, 0);
    const to = hhmmToMinutes(item.to, 1439);
    const nowM = parts.minutes;
    const inRange = from <= to ? nowM >= from && nowM < to : nowM >= from || nowM < to;
    if (inRange) return item;
  }
  return null;
}

/**
 * Estado consolidado de los gráficos para el navegador (overlay) y para OBS.
 */
export function buildOverlay(data, now = new Date()) {
  const g = data.graphics;
  const rt = data.runtime;
  const parts = tzParts(now, data.settings.app.timezone);
  const block = rt.mode === 'ads' ? data.adBlocks.find((b) => b.id === rt.ads?.blockId) : null;
  const adsHide = rt.mode === 'ads' && (block?.hideGraphics !== false);

  const currentItem = rt.items?.[rt.index] || null;
  const nextItem = rt.items?.[rt.index + 1] || (rt.items?.length > 1 ? rt.items[0] : null);
  const laterItem = rt.items?.[rt.index + 2] || null;

  const scheduled = scheduledTitleAt(g, parts);
  let lowerTitle = currentItem?.title || rt.live?.label || rt.sourceName || data.settings.app.channelName;
  let lowerKind = g.lowerThird?.kind && g.lowerThird.kind !== 'auto' ? g.lowerThird.kind : 'now';
  if (scheduled) {
    lowerTitle = scheduled.text;
    lowerKind = scheduled.kind || 'now';
  }

  const clockText = formatClock(parts.hour, parts.minute, parts.second, (g.clock.format || data.settings.app.timeFormat) === '12');
  const tickerItems = (g.ticker.items || []).filter(Boolean);
  const tickerText = tickerItems.length
    ? tickerItems.join(g.ticker.separator || '   •   ')
    : (g.ticker.text || '');

  const labels = { now: 'ESTÁS VIENDO', next: 'A CONTINUACIÓN', later: 'MÁS TARDE', none: '' };
  let lower = {
    visible: !!(g.lowerThird?.enabled && g.lowerThird?.visible) && !adsHide && lowerKind !== 'none',
    label: labels[lowerKind] ?? labels.now,
    title: lowerTitle,
    kind: lowerKind,
  };
  if (lowerKind === 'next' && nextItem) lower.title = nextItem.title;
  if (lowerKind === 'later' && laterItem) lower.title = laterItem.title;

  return {
    ts: now.getTime(),
    channel: data.settings.app.channelName,
    tz: data.settings.app.timezone,
    timeFormat: data.settings.app.timeFormat,
    mode: rt.mode,
    paused: !!rt.paused,
    program: currentItem?.title || (rt.mode === 'live' ? rt.live?.label : '') || '',
    next: nextItem?.title || '',
    later: laterItem?.title || '',
    logo: {
      visible: !!(g.logo.enabled && g.logo.visible) && !adsHide,
      text: g.logo.text, image: g.logo.image,
      position: g.logo.position, opacity: g.logo.opacity, width: g.logo.width,
    },
    clock: {
      visible: !!(g.clock.enabled && g.clock.visible) && !adsHide,
      text: clockText,
      position: g.clock.position,
      format: g.clock.format || data.settings.app.timeFormat,
      showSeconds: g.clock.showSeconds !== false,
    },
    ticker: {
      visible: !!(g.ticker.enabled && g.ticker.visible) && !adsHide,
      text: tickerText,
      items: tickerItems,
      speed: g.ticker.speed || 'normal',
      durationMs: SPEED_MS[g.ticker.speed] || SPEED_MS.normal,
    },
    lowerThird: lower,
    lowerThirdSpeed: 18000,
    ads: rt.mode === 'ads' ? { block: block?.name || 'Publicidad', remaining: rt.ads?.remaining ?? null } : null,
    live: rt.mode === 'live' ? { label: rt.live?.label || '', until: rt.live?.endAt || null } : null,
    emergency: rt.mode === 'emergency',
  };
}

/** Aplica el estado de gráficos a las fuentes de OBS (texto y visibilidad). */
export async function applyGraphics(obs, data, log = console) {
  const state = buildOverlay(data);
  if (!obs.connected) return state;
  const scene = data.settings.obs.programScene || 'Programa';
  const g = data.graphics;

  const jobs = [];
  if (g.logo.source) jobs.push(obs.setVisible(scene, g.logo.source, state.logo.visible));
  if (g.clock.source) {
    jobs.push(obs.setVisible(scene, g.clock.source, state.clock.visible));
    jobs.push(obs.setSourceText(g.clock.source, state.clock.text));
  }
  if (g.ticker.source) {
    jobs.push(obs.setVisible(scene, g.ticker.source, state.ticker.visible));
    jobs.push(obs.setSourceText(g.ticker.source, state.ticker.visible ? state.ticker.text : ''));
  }
  const lower = data.settings.obs.lowerThirdSource;
  if (lower) {
    jobs.push(obs.setVisible(scene, lower, state.lowerThird.visible));
    jobs.push(obs.setSourceText(lower, state.lowerThird.visible ? `${state.lowerThird.label}\n${state.lowerThird.title}` : ''));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) log.warn?.(`[graphics] ${failed.length} operaciones fallaron sobre OBS`);
  return state;
}

export { SPEED_MS };
