/**
 * ============================================================================
 * PLAN DE CANALES CATV Y PERFILES DE MODULADOR IP→ANALÓGICO
 * ----------------------------------------------------------------------------
 * Los moduladores IP→analógico (Wolck WK-2500C, CATVSCOPE CSP-2500C, Softel
 * SFT2500C, SKD1709B, CatCast, Ustarlink, Shineco y clones genéricos) NO usan
 * un protocolo propietario: reciben MPEG-TS sobre UDP (o UDP/RTP) y modulan a
 * RF. Lo que cambia entre marcas y modelos es:
 *
 *   1) la CANTIDAD de canales que pueden generar (32 / 48 / 64 / 125),
 *   2) el ESTÁNDAR de TV (NTSC-M, PAL B/G, PAL D/K, PAL I, PAL-N, PAL-M),
 *      que define la frecuencia exacta del canal y la separación de audio,
 *   3) el TRANSPORTE aceptado (UDP puro o UDP+RTP, 188 o 1316 bytes por
 *      datagrama, MPTS o SPTS).
 *
 * Este módulo centraliza el plan de frecuencias por estándar y el catálogo de
 * equipos conocidos. El panel entrega el TS por UDP; en la web del modulador
 * sólo hay que decir "esta UDP = este canal".
 * ============================================================================
 */

/** Familias de plan de frecuencias. */
export const PLAN_FAMILIES = {
  US_CABLE: 'us_cable', // EIA-542 STD cable (6 MHz, video = borde + 1.25)
  EU_BROADCAST: 'eu_broadcast' // CCIR/CENELEC (7 MHz útil, video = borde + 1.25)
};

/**
 * Estándares de TV soportados por los moduladores IP→analógico.
 * `audio_offset_mhz` es la separación portadora de audio respecto al video.
 */
export const TV_STANDARDS = [
  {
    id: 'ntsc_m',
    label: 'NTSC M (Nicaragua / Centroamérica / EE. UU.)',
    short: 'NTSC-M',
    family: PLAN_FAMILIES.US_CABLE,
    audio_offset_mhz: 4.5,
    color: 'NTSC',
    hint: 'Estándar de Nicaragua: 6 MHz por canal, audio a +4.5 MHz.'
  },
  {
    id: 'ntsc_j',
    label: 'NTSC J (Japón)',
    short: 'NTSC-J',
    family: PLAN_FAMILIES.US_CABLE,
    audio_offset_mhz: 4.5,
    color: 'NTSC',
    hint: 'Mismo plan de portadoras que NTSC-M.'
  },
  {
    id: 'pal_m',
    label: 'PAL M (Brasil)',
    short: 'PAL-M',
    family: PLAN_FAMILIES.US_CABLE,
    audio_offset_mhz: 4.5,
    color: 'PAL',
    hint: '6 MHz por canal, misma grilla que NTSC-M con color PAL.'
  },
  {
    id: 'pal_n',
    label: 'PAL N (Argentina / Uruguay / Paraguay)',
    short: 'PAL-N',
    family: PLAN_FAMILIES.US_CABLE,
    audio_offset_mhz: 4.5,
    color: 'PAL',
    hint: '6 MHz por canal, audio a +4.5 MHz.'
  },
  {
    id: 'pal_bg',
    label: 'PAL B/G (Europa / mayoría de decos PAL)',
    short: 'PAL-BG',
    family: PLAN_FAMILIES.EU_BROADCAST,
    audio_offset_mhz: 5.5,
    color: 'PAL',
    hint: '7 MHz útiles por canal, audio a +5.5 MHz (plan CCIR con canales S).'
  },
  {
    id: 'pal_dk',
    label: 'PAL D/K (Europa del Este / China)',
    short: 'PAL-DK',
    family: PLAN_FAMILIES.EU_BROADCAST,
    audio_offset_mhz: 6.5,
    color: 'PAL',
    hint: 'Igual que B/G pero audio a +6.5 MHz.'
  },
  {
    id: 'pal_i',
    label: 'PAL I (Reino Unido / Irlanda)',
    short: 'PAL-I',
    family: PLAN_FAMILIES.EU_BROADCAST,
    audio_offset_mhz: 6.0,
    color: 'PAL',
    hint: 'Raster de 8 MHz, audio a +6.0 MHz.'
  }
];

export const TV_STANDARD_IDS = TV_STANDARDS.map((s) => s.id);
export const DEFAULT_TV_STANDARD = 'ntsc_m';

export function getTvStandard(id) {
  return TV_STANDARDS.find((s) => s.id === String(id || '').trim()) || TV_STANDARDS[0];
}

// ---------------------------------------------------------------------------
// Plan EIA-542 (STD cable): canales 2–125, 6 MHz, video = borde inferior + 1.25
// ---------------------------------------------------------------------------
const US_CABLE_BANDS = [
  { from: 2, to: 4, base: 54, label: 'VHF Bajo (2–4)' },
  { from: 5, to: 6, base: 76, label: 'VHF Bajo (5–6)' },
  { from: 7, to: 13, base: 174, label: 'VHF Alto (7–13)' },
  { from: 14, to: 22, base: 120, label: 'Banda Media (14–22)' },
  { from: 23, to: 36, base: 216, label: 'Superbanda (23–36)' },
  { from: 37, to: 94, base: 300, label: 'Hiperbanda (37–94)' },
  { from: 95, to: 99, base: 90, label: 'FM Baja A-5..A-1 (95–99)' },
  { from: 100, to: 125, base: 648, label: 'Ultrabanda (100–125)' }
];

// ---------------------------------------------------------------------------
// Plan europeo (CCIR/CENELEC): E2–E4, S1–S10, E5–E12, S11–S20, E21–E69
// La numeración 2..125 se mapea a ese orden para mantener una sola grilla.
// ---------------------------------------------------------------------------
const EU_PLAN = [];
(() => {
  // E2–E4 (47–68 MHz)
  for (let n = 2; n <= 4; n++) EU_PLAN.push({ ch: n, freq: 48.25 + (n - 2) * 7, label: 'VHF I (E2–E4)' });
  // E5–E12 (174–230 MHz)
  for (let n = 5; n <= 12; n++) EU_PLAN.push({ ch: n, freq: 175.25 + (n - 5) * 7, label: 'VHF III (E5–E12)' });
  // S1–S10 (105–168 MHz)
  for (let n = 13; n <= 22; n++) EU_PLAN.push({ ch: n, freq: 105.25 + (n - 13) * 7, label: 'S1–S10 (105–168 MHz)' });
  // S11–S20 (231–294 MHz)
  for (let n = 23; n <= 32; n++) EU_PLAN.push({ ch: n, freq: 231.25 + (n - 23) * 7, label: 'S11–S20 (231–294 MHz)' });
  // E21–E69 (471–855 MHz, raster de 8 MHz)
  for (let n = 33; n <= 81; n++) EU_PLAN.push({ ch: n, freq: 471.25 + (n - 33) * 8, label: 'UHF (E21–E69)' });
})();

const EU_BY_CH = new Map(EU_PLAN.map((e) => [e.ch, e]));

/**
 * Frecuencia de video del canal CATV según el estándar.
 * @param {number} catvCh número de canal (2..125)
 * @param {string} standardId id de TV_STANDARDS
 * @param {number|null} overrideMhz frecuencia de video forzada por el operador
 */
export function getCatvChannelInfo(catvCh, standardId = DEFAULT_TV_STANDARD, overrideMhz = null) {
  const ch = Number(catvCh);
  const std = getTvStandard(standardId);

  if (Number.isFinite(Number(overrideMhz)) && Number(overrideMhz) > 0) {
    const f = Number(overrideMhz);
    return {
      catv_ch: ch,
      standard: std.id,
      standard_short: std.short,
      freq_mhz: Number(f.toFixed(2)),
      audio_mhz: Number((f + std.audio_offset_mhz).toFixed(2)),
      band_label: 'Frecuencia forzada por el operador',
      custom: true
    };
  }

  let freqMhz = 55.25;
  let bandLabel = 'Fuera de plan';

  if (std.family === PLAN_FAMILIES.EU_BROADCAST) {
    const entry = EU_BY_CH.get(ch);
    if (entry) {
      freqMhz = entry.freq;
      bandLabel = entry.label;
    } else {
      // Por encima de E69 la grilla europea no existe: se avisa en la UI.
      freqMhz = 0;
      bandLabel = 'Canal fuera del plan europeo (2–81)';
    }
  } else {
    const band = US_CABLE_BANDS.find((b) => ch >= b.from && ch <= b.to);
    if (band) {
      freqMhz = band.base + (ch - band.from) * 6 + 1.25;
      bandLabel = band.label;
    } else {
      freqMhz = 0;
      bandLabel = 'Canal fuera del plan (2–125)';
    }
  }

  return {
    catv_ch: ch,
    standard: std.id,
    standard_short: std.short,
    freq_mhz: freqMhz ? Number(freqMhz.toFixed(2)) : 0,
    audio_mhz: freqMhz ? Number((freqMhz + std.audio_offset_mhz).toFixed(2)) : 0,
    band_label: bandLabel,
    custom: false
  };
}

/** Máximo canal numerado válido para el estándar (la grilla del panel llega a 125). */
export function maxChannelForStandard(standardId) {
  const std = getTvStandard(standardId);
  return std.family === PLAN_FAMILIES.EU_BROADCAST ? 81 : 125;
}

/** Rango de frecuencias cubierto por el estándar (para mostrar en la UI). */
export function standardCoverage(standardId) {
  const info2 = getCatvChannelInfo(2, standardId);
  const infoMax = getCatvChannelInfo(maxChannelForStandard(standardId), standardId);
  return {
    from_mhz: info2.freq_mhz,
    to_mhz: infoMax.freq_mhz,
    audio_offset_mhz: getTvStandard(standardId).audio_offset_mhz
  };
}

// ---------------------------------------------------------------------------
// Catálogo de moduladores IP→analógico conocidos
// ---------------------------------------------------------------------------
export const PKT_SIZES = [188, 1316];

export const MODULATOR_BRANDS = [
  {
    id: 'csp_2500c',
    label: 'CATVSCOPE CSP-2500C (32 en 1)',
    models: [32],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes:
      '2 puertos GE (máx. 64 entradas IP), UDP / UDP-RTP, 1–7 paquetes por datagrama, SPTS/MPTS, ' +
      '188/204 bytes, 32 portadoras ágiles 47–862 MHz, PAL B/G/D/K/M/N y NTSC M/J/4.43, gestión web aparte.'
  },
  {
    id: 'wolck_wk2500c',
    label: 'Wolck WK-2500C (32 / 64 en 1)',
    models: [32, 64],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes: 'Misma plataforma OEM que el CSP-2500C; admite 32 o 64 portadoras según versión.'
  },
  {
    id: 'softel_sft2500c',
    label: 'Softel SFT2500C (32 en 1)',
    models: [32],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes: 'Clone OEM del 2500C con manual propio; idéntico transporte UDP/RTP.'
  },
  {
    id: 'skd1709b',
    label: 'SKD1709B / Souka (32 / 48 / 64)',
    models: [32, 64],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes: 'Recibe hasta 256 streams IP y saca 32/48/64 canales NTSC o PAL.'
  },
  {
    id: 'catcast_2500',
    label: 'CatCast 32/48/64 IP→RF',
    models: [32, 64],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes: '1–4 GE, UDP/RTP unicast y multicast, NTSC / PAL B/G/D/K, STD/HRC/IRC.'
  },
  {
    id: 'ustarlink_ws_m64',
    label: 'Ustarlink WS-M64',
    models: [64],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes: '64 portadoras, 43.25–951 MHz, H.265/H.264/MPEG-2.'
  },
  {
    id: 'shineco_snk6388c',
    label: 'Shineco SNK6388C (64 en 1)',
    models: [64],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes: '64 salidas, 47–862 MHz, PAL B/G/D/K/M/N y NTSC.'
  },
  {
    id: 'generic_2500',
    label: 'Genérico / clon chino (sólo transporte UDP)',
    models: [32, 64, 125],
    default_standard: 'ntsc_m',
    default_pkt_size: 1316,
    default_rtp: false,
    notes:
      'Cualquier modulador IP→analógico que acepte MPEG-TS sobre UDP/RTP. Se configura igual: ' +
      'un SPTS por número de canal y el mapeo UDP→canal se hace en la web del equipo.'
  }
];

export function getModulatorBrand(id) {
  return MODULATOR_BRANDS.find((b) => b.id === String(id || '').trim()) || MODULATOR_BRANDS[MODULATOR_BRANDS.length - 1];
}
