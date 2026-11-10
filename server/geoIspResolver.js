import { db } from './db.js';

const memGeoCache = new Map(); // ip -> { country, city, isp, asn, expiresAt }
const inFlightLookups = new Map(); // ip -> Promise
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

export function isPrivateOrLoopbackIp(ip = '') {
  const clean = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!clean || clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('127.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)) return true;
  if (clean.startsWith('fe80:') || clean.startsWith('fc00:') || clean.startsWith('fd00:')) return true;
  return false;
}

/**
 * Friendly IPTV Player classifier from raw User-Agent header.
 * Always keep raw `user_agent` alongside this friendly badge!
 */
export function classifyPlayerAgent(rawUa = '') {
  const ua = String(rawUa || '').trim();
  if (!ua) return { player: 'Desconocido', category: 'unknown' };
  const l = ua.toLowerCase();

  if (l.includes('tivimate')) return { player: 'TiviMate', category: 'android_tv' };
  if (l.includes('smarters') || l.includes('iptvsmarters')) return { player: 'IPTV Smarters', category: 'app' };
  if (l.includes('xciptv') || l.includes('ottrun')) return { player: 'XCIPTV Player', category: 'android_tv' };
  if (l.includes('televizo')) return { player: 'Televizo', category: 'android_tv' };
  if (l.includes('ott navigator') || l.includes('ottnavigator')) return { player: 'OTT Navigator', category: 'android_tv' };
  if (l.includes('sparkle')) return { player: 'Sparkle TV', category: 'android_tv' };
  if (l.includes('iboplayer') || l.includes('ibo player')) return { player: 'IBO Player', category: 'smart_tv' };
  if (l.includes('duplecast') || l.includes('duplex')) return { player: 'Duplecast / DuplexPlay', category: 'smart_tv' };
  if (l.includes('flixiptv') || l.includes('flix iptv')) return { player: 'Flix IPTV', category: 'smart_tv' };
  if (l.includes('siptv') || l.includes('smart iptv')) return { player: 'Smart IPTV (SIPTV)', category: 'smart_tv' };
  if (l.includes('ssiptv') || l.includes('ss-iptv')) return { player: 'SS IPTV', category: 'smart_tv' };
  if (l.includes('netiptv') || l.includes('net iptv')) return { player: 'Net IPTV', category: 'smart_tv' };
  if (l.includes('setiptv') || l.includes('set iptv')) return { player: 'Set IPTV', category: 'smart_tv' };
  if (l.includes('iplaytv')) return { player: 'iPlayTV (Apple TV)', category: 'apple' };
  if (l.includes('uhf')) return { player: 'UHF Player', category: 'apple' };
  if (l.includes('gse smart') || l.includes('gsesmartiptv')) return { player: 'GSE Smart IPTV', category: 'app' };
  if (l.includes('perfect player')) return { player: 'Perfect Player', category: 'android_tv' };
  if (l.includes('implayer')) return { player: 'iMPlayer', category: 'android_tv' };
  if (l.includes('mytvonline') || l.includes('formuler')) return { player: 'MYTVOnline (Formuler)', category: 'stb' };
  if (l.includes('mag25') || l.includes('mag32') || l.includes('mag42') || l.includes('qtembedded') || l.includes('infomir') || l.includes('stalker')) {
    return { player: 'MAG / Stalker STB', category: 'stb' };
  }
  if (l.includes('enigma2') || l.includes('openpli') || l.includes('openatv') || l.includes('gstreamer')) {
    return { player: 'Enigma2 Receiver', category: 'stb' };
  }
  if (l.includes('libvlc') || l.includes('vlc/')) return { player: 'VLC Media Player', category: 'desktop' };
  if (l.includes('mpv')) return { player: 'MPV Player', category: 'desktop' };
  if (l.includes('kodi')) return { player: 'Kodi IPTV', category: 'desktop' };
  if (l.includes('potplayer')) return { player: 'PotPlayer', category: 'desktop' };
  if (l.includes('applecoremedia')) return { player: 'Apple Player (iOS/tvOS)', category: 'apple' };
  if (l.includes('exoplayer') || l.includes('androidx.media3')) return { player: 'ExoPlayer (Android)', category: 'android_tv' };
  if (l.includes('lavf/') || l.includes('ffmpeg')) return { player: 'FFmpeg / Lavf', category: 'restream' };
  if (l.includes('flussonic') || l.includes('astra') || l.includes('xtream') || l.includes('xui')) {
    return { player: 'Servidor / Restream', category: 'restream' };
  }
  if (l.includes('roku')) return { player: 'Roku TV', category: 'smart_tv' };
  if (l.includes('tizen') || l.includes('smart-tv') || l.includes('web0s') || l.includes('webos')) {
    return { player: 'Smart TV (Tizen/webOS)', category: 'smart_tv' };
  }
  if (l.includes('dalvik/')) return { player: 'App Android TV', category: 'android_tv' };
  if (l.includes('mozilla/') && (l.includes('chrome/') || l.includes('firefox/') || l.includes('safari/') || l.includes('edg/'))) {
    return { player: 'Navegador WebTV', category: 'web' };
  }

  const shortToken = ua.split(/\s+/)[0]?.slice(0, 28) || 'IPTV Player';
  return { player: shortToken, category: 'other' };
}

function cleanIspLabel(isp = '', org = '', asn = '') {
  const primary = String(isp || org || '').trim();
  if (!primary) return asn ? String(asn).trim() : 'ISP Desconocido';
  return primary.slice(0, 90);
}

async function fetchJsonWithTimeout(url, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TVLister-GeoISP/2.4'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryExternalGeoIsp(ip) {
  // Provider 1: ip-api.com (fast & accurate ISP + ASN in LATAM/US/EU)
  const d1 = await fetchJsonWithTimeout(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,city,isp,org,as`,
    3200
  );
  if (d1 && d1.status === 'success') {
    return {
      country: String(d1.countryCode || '').toUpperCase() || '--',
      city: String(d1.city || '').slice(0, 60),
      isp: cleanIspLabel(d1.isp, d1.org, d1.as),
      asn: String(d1.as || '').slice(0, 60)
    };
  }

  // Provider 2: ipwho.is (HTTPS fallback, no key required)
  const d2 = await fetchJsonWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, 3500);
  if (d2 && d2.success !== false && (d2.country_code || d2.connection)) {
    const conn = d2.connection || {};
    return {
      country: String(d2.country_code || '').toUpperCase() || '--',
      city: String(d2.city || '').slice(0, 60),
      isp: cleanIspLabel(conn.isp, conn.org, conn.asn ? `AS${conn.asn}` : ''),
      asn: conn.asn ? `AS${conn.asn}` : ''
    };
  }

  // Provider 3: ipapi.co (HTTPS fallback)
  const d3 = await fetchJsonWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, 3500);
  if (d3 && !d3.error && (d3.org || d3.country_code)) {
    return {
      country: String(d3.country_code || '').toUpperCase() || '--',
      city: String(d3.city || '').slice(0, 60),
      isp: cleanIspLabel(d3.org, '', d3.asn),
      asn: String(d3.asn || '').slice(0, 60)
    };
  }

  return null;
}

function saveGeoCache(ip, info) {
  memGeoCache.set(ip, { ...info, expiresAt: Date.now() + CACHE_TTL_MS });
  try {
    db.prepare(
      `INSERT INTO ip_geo_cache (ip, country, city, isp, asn, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(ip) DO UPDATE SET
         country = excluded.country,
         city = excluded.city,
         isp = excluded.isp,
         asn = excluded.asn,
         updated_at = datetime('now')`
    ).run(ip, info.country || '--', info.city || '', info.isp || 'ISP Desconocido', info.asn || '');
  } catch {
    // ignore SQLite busy race
  }
}

function triggerBackgroundLookup(ip) {
  if (!ip || isPrivateOrLoopbackIp(ip) || inFlightLookups.has(ip)) return;

  const p = (async () => {
    try {
      const resolved = await queryExternalGeoIsp(ip);
      if (resolved) {
        saveGeoCache(ip, resolved);
        try {
          db.prepare(
            `UPDATE active_connections
             SET country = ?, isp = ?
             WHERE ip_address = ?`
          ).run(resolved.country || '--', resolved.isp || 'ISP Desconocido', ip);
        } catch {
          // ignore
        }
      } else {
        // Avoid hammering external APIs if unreachable in offline/sandbox networks; retry after 10 min
        memGeoCache.set(ip, {
          country: '--',
          city: '',
          isp: 'ISP No Resuelto',
          asn: '',
          expiresAt: Date.now() + 10 * 60 * 1000
        });
        try {
          db.prepare(
            `UPDATE active_connections
             SET isp = 'ISP No Resuelto'
             WHERE ip_address = ? AND (isp = 'Detectando ISP...' OR isp = 'Client Network' OR isp = '')`
          ).run(ip);
        } catch {
          // ignore
        }
      }
    } finally {
      inFlightLookups.delete(ip);
    }
  })();

  inFlightLookups.set(ip, p);
}

/**
 * Zero-latency synchronous lookup for stream hot-path (`recordConnection`).
 * Never blocks stream zapping: returns cached ISP/Country in <0.1ms and
 * resolves uncached public IPs asynchronously in the background.
 */
export function resolveIpGeoSync(ip, req = null) {
  const cleanIp = String(ip || '').trim().replace(/^::ffff:/i, '') || '127.0.0.1';

  if (isPrivateOrLoopbackIp(cleanIp)) {
    return {
      country: 'LAN',
      city: 'Local',
      isp: 'Red Local / Loopback',
      asn: ''
    };
  }

  const now = Date.now();
  const mem = memGeoCache.get(cleanIp);
  if (mem && mem.expiresAt > now) {
    return mem;
  }

  try {
    const row = db
      .prepare(
        `SELECT country, city, isp, asn, updated_at
         FROM ip_geo_cache
         WHERE ip = ? AND updated_at > datetime('now', '-7 days')`
      )
      .get(cleanIp);
    if (row && row.isp) {
      const entry = {
        country: row.country || '--',
        city: row.city || '',
        isp: row.isp,
        asn: row.asn || '',
        expiresAt: now + CACHE_TTL_MS
      };
      memGeoCache.set(cleanIp, entry);
      return entry;
    }
  } catch {
    // ignore
  }

  const headerCountry = String(
    req?.headers?.['cf-ipcountry'] || req?.headers?.['x-country-code'] || ''
  )
    .trim()
    .toUpperCase();

  triggerBackgroundLookup(cleanIp);

  return {
    country: headerCountry || '--',
    city: '',
    isp: 'Detectando ISP...',
    asn: ''
  };
}
