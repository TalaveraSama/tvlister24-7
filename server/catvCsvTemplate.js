/**
 * ============================================================================
 * PLANTILLA CSV DEL MODULADOR IP→ANALÓGICO
 * ----------------------------------------------------------------------------
 * El problema real en campo: la ventana de importación del modulador (CSP-2500C
 * y clones 2500C) NO acepta un CSV con columnas inventadas. Si el archivo no
 * tiene SU estructura —su cabecera, su orden de columnas, su separador, sus
 * finales de línea— el equipo lo ignora: no crea ni cambia ningún canal.
 *
 * La solución es no adivinar: el panel guarda, por equipo, el CSV que el propio
 * modulador exporta (botón Export/Descargar de su web) y luego rellena ESE
 * archivo con el plan real. Misma estructura ⇒ el equipo lo acepta.
 *
 *   buildTemplate(text)          → {delimiter, eol, hasHeader, header,
 *                                   defaults, cols, mapping, sampleCount}
 *   detectMapping(header[])      → índices de columna por campo lógico
 *   renderTemplate(template, r)  → texto CSV listo para subir al equipo
 * ============================================================================
 */

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

/** Normaliza una cabecera: minúsculas, sin acentos, sin signos ni espacios. */
export function normalizeHeader(raw = '') {
  return String(raw)
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Parser CSV tolerante: comillas dobles, comillas escapadas y saltos dentro de comillas. */
export function parseCsv(text = '', delimiter = null) {
  const src = String(text).replace(/^\uFEFF/, '');
  const delim = delimiter || guessDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      // Un \r\n cuenta como un solo salto
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return {
    delimiter: delim,
    // Fuera las líneas totalmente vacías (el equipo también las ignora)
    rows: rows.filter((r) => r.some((v) => String(v).trim() !== ''))
  };
}

function guessDelimiter(text = '') {
  const firstLines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 5)
    .join('\n');
  let best = { delim: ',', score: -1 };
  for (const d of CANDIDATE_DELIMITERS) {
    const count = firstLines.split(d).length - 1;
    if (count > best.score) best = { delim: d, score: count };
  }
  return best.score > 0 ? best.delim : ',';
}

/** Palabras clave por campo lógico (español e inglés: estos equipos usan ambas). */
const FIELD_RULES = [
  // 'portadora' / 'carrier' antes que 'port' para no confundir con puerto
  { key: 'carrier', words: ['portadora', 'carrier', 'carrierno', 'carrierindex', 'fila', 'rowno'] },
  { key: 'ip', words: ['ipdestino', 'destip', 'dstip', 'ipaddr', 'ipaddress', 'udpip', 'multicastip', 'targetip', 'ip'] },
  { key: 'port', words: ['puertoudp', 'udpport', 'puerto', 'portnumber', 'portno', 'destport', 'dstport', 'port'] },
  { key: 'videoMhz', words: ['frecuenciavideo', 'frecvideomhz', 'videofreq', 'videofrequency', 'frequencyvideo', 'videomhz', 'freqvideo'] },
  { key: 'audioMhz', words: ['frecuenciaaudio', 'frecaudio', 'audiofreq', 'audiofrequency', 'frequencyaudio', 'audiomhz', 'frecaudiomhz'] },
  { key: 'level', words: ['nivel', 'level', 'atenuacion', 'attenuation', 'outputlevel', 'salidanivel'] },
  { key: 'bandwidth', words: ['ancho', 'bandwidth', 'bw'] },
  { key: 'standard', words: ['estandar', 'standard', 'norma', 'tvsystem', 'system', 'palntsc'] },
  { key: 'serviceId', words: ['programnumber', 'program', 'serviceid', 'progid', 'pid', 'pmt', 'sid'] },
  { key: 'outputMode', words: ['modosalida', 'outputmode', 'modo', 'mode', 'protocol', 'transporte', 'transport'] },
  { key: 'name', words: ['nombre', 'name', 'etiqueta', 'label', 'descripcion', 'description', 'title'] },
  { key: 'enable', words: ['enable', 'enabled', 'activo', 'habilit', 'estado', 'state', 'onoff', 'switch', 'status'] },
  { key: 'ch', words: ['canalcatv', 'canal', 'channel', 'chno', 'channelno', 'canalno', 'chnumber'] }
];

/**
 * Detecta qué columna de la plantilla corresponde a cada dato que sabemos
 * rellenar. `ch` es más genérico y por eso va al final: así 'Canal_CATV' gana
 * a 'Channel' sólo cuando la cabecera realmente lo dice.
 */
export function detectMapping(header = []) {
  const mapping = {};
  const used = new Set();
  header.forEach((raw, idx) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    for (const rule of FIELD_RULES) {
      if (mapping[rule.key] !== undefined) continue;
      const hit = rule.words.some((w) => h === w || h.includes(w));
      if (hit && !used.has(idx)) {
        mapping[rule.key] = idx;
        used.add(idx);
        return;
      }
    }
  });
  // 'Frequency (MHz)' a secas es la de vídeo (la de audio lleva 'audio' en el nombre)
  if (mapping.videoMhz === undefined) {
    const alt = header.findIndex(
      (raw, idx) =>
        !used.has(idx) &&
        /frec|freq|mhz/.test(normalizeHeader(raw)) &&
        !/audio|sonido|sound/.test(normalizeHeader(raw))
    );
    if (alt >= 0) {
      mapping.videoMhz = alt;
      used.add(alt);
    }
  }
  // Si el equipo llama 'Canal' a la portadora RF, se usa como número de canal
  if (mapping.ch === undefined && mapping.carrier !== undefined) {
    const alt = header.findIndex((raw, idx) => idx !== mapping.carrier && /canal|channel/i.test(String(raw)));
    if (alt >= 0) mapping.ch = alt;
  }
  return mapping;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Cuando la plantilla no trae cabecera (o sus nombres no se reconocen) se deduce
 * por el contenido de la primera fila: IPv4, puerto, MHz con decimales y canal.
 */
export function inferMappingFromRow(row = [], already = {}) {
  const mapping = { ...already };
  const used = new Set(Object.values(mapping));
  const cells = row.map((v) => String(v ?? '').trim());

  const take = (key, idx) => {
    if (mapping[key] !== undefined || idx < 0 || used.has(idx)) return;
    mapping[key] = idx;
    used.add(idx);
  };

  // IP destino
  if (mapping.ip === undefined) take('ip', cells.findIndex((v) => IPV4.test(v)));

  // Puerto: entero alto (los equipos usan 5000+, 1234, etc.)
  if (mapping.port === undefined) {
    const idx = cells.findIndex((v, i) => {
      if (used.has(i) || !/^\d+$/.test(v)) return false;
      const n = Number(v);
      return n >= 1000 && n <= 65535;
    });
    take('port', idx);
  }

  // MHz de vídeo y audio: los dos números con decimales entre 40 y 900
  if (mapping.videoMhz === undefined || mapping.audioMhz === undefined) {
    const decimals = [];
    cells.forEach((v, i) => {
      if (used.has(i) || !/^\d+([.,]\d+)?$/.test(v)) return;
      const n = Number(v.replace(',', '.'));
      if (n >= 40 && n <= 900) decimals.push({ i, n });
    });
    if (decimals.length >= 2) {
      decimals.sort((a, b) => a.n - b.n);
      const video = decimals[0];
      const audio = decimals[decimals.length - 1];
      take('videoMhz', video.i);
      take('audioMhz', audio.i);
    } else if (decimals.length === 1) {
      take('videoMhz', decimals[0].i);
    }
  }

  // Canal CATV: entero entre 2 y 125
  if (mapping.ch === undefined) {
    const idx = cells.findIndex((v, i) => {
      if (used.has(i) || !/^\d+$/.test(v)) return false;
      const n = Number(v);
      return n >= 2 && n <= 125;
    });
    take('ch', idx);
  }

  // Portadora: el entero que queda (normalmente la primera columna)
  if (mapping.carrier === undefined) {
    const idx = cells.findIndex((v, i) => {
      if (used.has(i) || !/^\d+$/.test(v)) return false;
      const n = Number(v);
      return n >= 1 && n <= 999;
    });
    take('carrier', idx);
  }

  return mapping;
}

/**
 * Convierte el CSV exportado por el equipo en una plantilla reutilizable.
 * Guarda cabecera, separador, final de línea y una fila de valores por defecto
 * (los del propio equipo: nivel, ancho de banda, estándar… se conservan tal
 * como los tiene configurados, no se inventan).
 */
export function buildTemplate(text = '') {
  const { delimiter, rows } = parseCsv(text);
  if (!rows.length) return { error: 'El archivo está vacío.' };

  const first = rows[0].map((v) => String(v).trim());
  const headerLike = first.some((v) => /[a-záéíóúñ]/i.test(v)) && first.length > 1;
  const header = headerLike ? first : null;
  const dataRows = headerLike ? rows.slice(1) : rows;
  // Palabras de la cabecera primero; si faltan datos, se deducen del contenido
  let mapping = header ? detectMapping(header) : {};
  if (dataRows[0]) mapping = inferMappingFromRow(dataRows[0], mapping);
  if (!header && !dataRows[0]) mapping = inferMappingFromRow(first, mapping);

  // Columnas conocidas que el equipo trae y nosotros sabemos rellenar
  const known = ['ch', 'carrier', 'videoMhz', 'audioMhz', 'ip', 'port'].filter((k) => mapping[k] !== undefined);
  if (!known.includes('ch') && !known.includes('videoMhz')) {
    return {
      error:
        'No se reconoce ninguna columna de canal ni de frecuencia en la primera línea. ' +
        'Pega el archivo tal como lo exporta el modulador (con su cabecera).'
    };
  }

  const cols = Math.max(
    header ? header.length : 0,
    ...dataRows.map((r) => r.length),
    ...(header ? [header.length] : [])
  );
  const defaults = Array.from({ length: cols }, (_, i) => String((dataRows[0] || [])[i] ?? '').trim());
  const usesCrLf = /\r\n/.test(String(text));

  return {
    delimiter,
    eol: usesCrLf ? 'crlf' : 'lf',
    hasHeader: Boolean(header),
    header: header || Array.from({ length: cols }, (_, i) => `C${i + 1}`),
    cols,
    defaults,
    mapping,
    sampleCount: dataRows.length
  };
}

/** Redondea a 2 decimales sin arrastrar errores binarios (91.25, no 91.249999). */
function mhz(value) {
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

/** Limpia un nombre para una celda CSV (sin comas ni saltos). */
function cellName(value = '') {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[",;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function escapeCell(value, delimiter) {
  const v = String(value ?? '');
  if (v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Rellena la plantilla del equipo con el plan real.
 * `rows`: [{ carrier, catv_ch, freq_mhz, audio_mhz, udp_host, udp_port, name,
 *            standard_short, level, bandwidth, service_id, output_mode, enabled }]
 */
export function renderTemplate(template = {}, rows = []) {
  const delim = template.delimiter || ',';
  const cols = Number(template.cols) || (template.header || []).length;
  const mapping = template.mapping || {};
  const defaults = Array.isArray(template.defaults) ? template.defaults : [];
  const out = [];

  if (template.hasHeader && Array.isArray(template.header) && template.header.length) {
    out.push(template.header.map((h) => escapeCell(h, delim)).join(delim));
  }

  for (const r of rows) {
    const cells = Array.from({ length: cols }, (_, i) => String(defaults[i] ?? ''));
    const put = (key, value) => {
      const idx = mapping[key];
      if (idx === undefined || idx < 0 || idx >= cols) return;
      if (value === undefined || value === null || value === '') return;
      cells[idx] = String(value);
    };
    put('carrier', r.carrier);
    put('ch', r.catv_ch);
    put('videoMhz', mhz(r.freq_mhz));
    put('audioMhz', mhz(r.audio_mhz));
    put('ip', r.udp_host);
    put('port', r.udp_port);
    put('serviceId', r.service_id);
    put('outputMode', r.output_mode);
    put('name', cellName(r.name));
    // El estándar sólo se escribe si el equipo NO trae uno propio ya configurado
    if (mapping.standard !== undefined && !String(defaults[mapping.standard] ?? '').trim()) {
      put('standard', r.standard_short);
    }
    out.push(cells.map((c) => escapeCell(c, delim)).join(delim));
  }

  const eol = template.eol === 'crlf' ? '\r\n' : '\n';
  return out.join(eol) + eol;
}

/** Resumen corto para la UI (sin mandar todo el archivo en cada /plan). */
export function templateSummary(unit = {}) {
  if (!unit.csv_template) return { saved: false };
  try {
    const t = JSON.parse(unit.csv_template);
    return {
      saved: true,
      header: t.header || [],
      cols: t.cols || 0,
      delimiter: t.delimiter || ',',
      eol: t.eol || 'lf',
      sampleCount: t.sampleCount || 0,
      mapped: Object.keys(t.mapping || {}),
      missing: ['ch', 'videoMhz', 'audioMhz', 'ip', 'port'].filter((k) => (t.mapping || {})[k] === undefined)
    };
  } catch {
    return { saved: false };
  }
}
