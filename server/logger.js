// Logger con buffer circular para mostrarlo en la interfaz.
const RING = 400;

export function createLogger(prefix = 'proca') {
  const lines = [];
  const push = (level, args) => {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeJson(a)))
      .join(' ');
    const row = { ts: Date.now(), level, msg };
    lines.push(row);
    if (lines.length > RING) lines.splice(0, lines.length - RING);
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    out(`[${prefix}] ${msg}`);
    return row;
  };
  return {
    info: (...a) => push('info', a),
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a),
    log: (...a) => push('info', a),
    list: (limit = 200) => lines.slice(-limit).reverse(),
    lines,
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
