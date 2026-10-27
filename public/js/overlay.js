// Overlay para OBS: recibe el estado por SSE y dibuja logo, reloj, cintillo y títulos.
const els = {
  logo: document.getElementById('logo'),
  clock: document.getElementById('clock'),
  clockText: document.getElementById('clock-text'),
  lower: document.getElementById('lower'),
  lowerLabel: document.getElementById('lower-label'),
  lowerTitle: document.getElementById('lower-title'),
  ticker: document.getElementById('ticker'),
  tickerTrack: document.getElementById('ticker-track'),
  adsFlag: document.getElementById('ads-flag'),
};

let lastTickerText = '';
let lastClockText = '';
let clockTZ = 'UTC';
let clockFmt = '24';
let clockFmtCache = null;
const POS = ['pos-top-left', 'pos-top-right', 'pos-bottom-left', 'pos-bottom-right'];

function setPosition(el, position) {
  POS.forEach((p) => el.classList.remove(p));
  el.classList.add(POS.includes(position) ? position : 'pos-top-right');
}

function render(o) {
  if (!o) return;
  if (o.tz && o.tz !== clockTZ) {
    clockTZ = o.tz;
    clockFmtCache = null;
  }
  if (o.timeFormat && o.timeFormat !== clockFmt) {
    clockFmt = o.timeFormat;
    clockFmtCache = null;
  }

  // Logo
  els.logo.style.display = o.logo.visible ? '' : 'none';
  setPosition(els.logo, o.logo.position);
  els.logo.style.opacity = String(o.logo.opacity ?? 1);
  const img = els.logo.querySelector('img');
  const textEl = els.logo.querySelector('.logo-text');
  if (o.logo.image) {
    if (!img) {
      const image = document.createElement('img');
      image.alt = '';
      els.logo.prepend(image);
    }
    const image = els.logo.querySelector('img');
    if (image.getAttribute('src') !== o.logo.image) image.src = o.logo.image;
    image.style.width = `${Math.round((o.logo.width || 150) / 19.2 * 100) / 100}vw`;
    if (textEl) textEl.style.display = 'none';
    els.logo.classList.remove('only-text');
  } else {
    if (img) img.remove();
    els.logo.classList.add('only-text');
    if (textEl) {
      textEl.style.display = '';
      textEl.textContent = o.logo.text || '';
    }
  }

  // Reloj
  els.clock.style.display = o.clock.visible ? '' : 'none';
  setPosition(els.clock, o.clock.position);
  if (o.clock.visible && o.clock.text !== lastClockText) {
    lastClockText = o.clock.text;
    els.clockText.textContent = o.clock.text;
  }

  // Cintillo
  els.ticker.classList.toggle('hide', !o.ticker.visible);
  const text = o.ticker.text || '';
  if (text && text !== lastTickerText) {
    lastTickerText = text;
    const chunk = `<span>${escapeHTML(text)}</span>`;
    const repeats = Math.max(2, Math.ceil(240 / Math.max(20, text.length)));
    els.tickerTrack.innerHTML = chunk.repeat(repeats) + chunk.repeat(repeats);
    els.tickerTrack.style.setProperty('--dur', `${o.ticker.durationMs || 26000}ms`);
    // reinicia la animación para que arranque desde el inicio
    els.tickerTrack.style.animation = 'none';
    void els.tickerTrack.offsetWidth;
    els.tickerTrack.style.animation = '';
  }

  // Estás viendo / a continuación
  els.lower.classList.toggle('show', !!o.lowerThird.visible && !!o.lowerThird.title);
  els.lowerLabel.textContent = o.lowerThird.label || '';
  els.lowerTitle.textContent = o.lowerThird.title || '';

  // Indicador de publicidad (solo en modo debug con ?debug=1)
  const debug = new URLSearchParams(location.search).has('debug');
  els.adsFlag.classList.toggle('show', debug && !!o.ads);
  if (debug && o.ads) els.adsFlag.textContent = `PUBLICIDAD · ${o.ads.block}`;
}

function escapeHTML(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function initial() {
  try {
    const res = await fetch('/overlay/state');
    render(await res.json());
  } catch { /* sin conexión inicial */ }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    try {
      const snap = JSON.parse(e.data);
      render(snap.overlay);
    } catch { /* ignore */ }
  });
  es.onerror = () => {
    // EventSource reintenta solo; aseguramos estado mínimo.
    setTimeout(initial, 2500);
  };
}

initial();
connect();

// Reloj local de respaldo con la zona horaria del canal: evita que el reloj
// se congele si la conexión SSE tiene una pausa breve.
setInterval(() => {
  if (document.hidden) return;
  const el = els.clockText;
  if (!el || els.clock.style.display === 'none') return;
  try {
    if (!clockFmtCache) {
      clockFmtCache = new Intl.DateTimeFormat('es-NI', {
        timeZone: clockTZ || 'UTC',
        hour: clockFmt === '12' ? 'numeric' : '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: clockFmt === '12',
      });
    }
    el.textContent = clockFmtCache.format(new Date());
  } catch { /* zona horaria inválida */ }
}, 1000);
