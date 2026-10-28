import { db } from './db.js';

/**
 * Resolves Flussonic proprietary URL schemes (m4f://, m4fs://, tshttp://, hls://)
 * into ordered HTTP/CMAF/MPEG-TS candidate URLs understood by Stream Shield & FFmpeg.
 */
export function isFlussonicScheme(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  return /^(m4fs?|m4ss?|tshttps?|hlss?):\/\//i.test(rawUrl.trim());
}

export function isM4fOrCmafUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const t = rawUrl.trim();
  return /^(m4fs?|m4ss?|tshttps?|hlss?):\/\//i.test(t) || /\.fmp4\.m3u8(\?|$)/i.test(t);
}

export function resolveFlussonicUrlCandidates(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return [];
  const trimmed = rawUrl.trim();
  const preferProtocol = String(options?.preferProtocol || 'hls').toLowerCase();

  // Also adapt HTTP(S) Flussonic CMAF URLs (.../index.fmp4.m3u8 or .../mono.fmp4.m3u8) for universal player compatibility
  const cmafHttpMatch = trimmed.match(/^(https?:\/\/.+?)\/(?:index|mono)\.fmp4\.m3u8(\?.*)?$/i);
  if (cmafHttpMatch) {
    const streamRoot = cmafHttpMatch[1].replace(/\/+$/, '');
    const q = cmafHttpMatch[2] || '';
    if (preferProtocol === 'mpegts') {
      return [`${streamRoot}/mpegts${q}`, `${streamRoot}/index.m3u8${q}`, trimmed];
    }
    if (preferProtocol === 'cmaf') {
      return [trimmed, `${streamRoot}/index.m3u8${q}`, `${streamRoot}/mpegts${q}`];
    }
    return [`${streamRoot}/index.m3u8${q}`, `${streamRoot}/mono.m3u8${q}`, trimmed, `${streamRoot}/mpegts${q}`];
  }

  const match = trimmed.match(/^(m4f|m4fs|m4s|m4ss|tshttp|tshttps|hls|hlss):\/\/(.+)$/i);
  if (!match) {
    return [trimmed];
  }

  const scheme = match[1].toLowerCase();
  const isSecure = scheme.endsWith('s') && scheme !== 'm4s' && scheme !== 'hls';
  const httpProto = isSecure ? 'https' : 'http';

  let parsed;
  try {
    parsed = new URL(`${httpProto}://${match[2]}`);
  } catch {
    return [trimmed];
  }

  const originWithAuth = parsed.username
    ? `${httpProto}://${encodeURIComponent(decodeURIComponent(parsed.username))}${parsed.password ? `:${encodeURIComponent(decodeURIComponent(parsed.password))}` : ''}@${parsed.host}`
    : `${httpProto}://${parsed.host}`;

  const cleanPath = (parsed.pathname || '/').replace(/\/+$/, '');
  const query = parsed.search || '';

  // Strip explicit Flussonic suffix if present inside an m4f:// or tshttp:// URI so we can negotiate protocol cleanly
  const baseStreamPath = cleanPath.replace(/\/(?:(?:index|mono)(?:\.fmp4)?\.m3u8|mpegts)$/i, '');

  if (/\.(ts|mp4)$/i.test(cleanPath)) {
    return [`${originWithAuth}${cleanPath}${query}`];
  }

  if (scheme === 'm4f' || scheme === 'm4fs' || scheme === 'm4s' || scheme === 'm4ss') {
    if (preferProtocol === 'mpegts') {
      // Client app asked for .ts / MPEG-TS -> serve Flussonic /mpegts first, then HLS/CMAF for FFmpeg TS-remux fallback
      return [
        `${originWithAuth}${baseStreamPath}/mpegts${query}`,
        `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
        `${originWithAuth}${baseStreamPath}/index.fmp4.m3u8${query}`,
      ];
    }
    if (preferProtocol === 'cmaf') {
      return [
        `${originWithAuth}${baseStreamPath}/index.fmp4.m3u8${query}`,
        `${originWithAuth}${baseStreamPath}/mono.fmp4.m3u8${query}`,
        `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
        `${originWithAuth}${baseStreamPath}/mpegts${query}`,
      ];
    }
    // Universal HLS mode (Smart TVs, Smarters/TiviMate HLS, iOS, hls.js VideoModal, MP2/AAC/AC3 audio safe):
    // Try classic TS-segmented HLS first, then CMAF fMP4, then raw /mpegts
    return [
      `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
      `${originWithAuth}${baseStreamPath}/mono.m3u8${query}`,
      `${originWithAuth}${baseStreamPath}/index.fmp4.m3u8${query}`,
      `${originWithAuth}${baseStreamPath}/mono.fmp4.m3u8${query}`,
      `${originWithAuth}${baseStreamPath}/mpegts${query}`,
    ];
  }

  if (scheme === 'tshttp' || scheme === 'tshttps') {
    if (preferProtocol === 'hls') {
      return [
        `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
        `${originWithAuth}${cleanPath}${query}`,
        `${originWithAuth}${baseStreamPath}/mpegts${query}`,
      ];
    }
    return [
      `${originWithAuth}${cleanPath}${query}`,
      `${originWithAuth}${baseStreamPath}/mpegts${query}`,
      `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
    ];
  }

  // hls:// or hlss://
  if (preferProtocol === 'mpegts') {
    return [
      `${originWithAuth}${baseStreamPath}/mpegts${query}`,
      `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
      `${originWithAuth}${baseStreamPath}/mono.m3u8${query}`,
    ];
  }
  return [
    `${originWithAuth}${baseStreamPath}/index.m3u8${query}`,
    `${originWithAuth}${baseStreamPath}/mono.m3u8${query}`,
  ];
}

export function buildFlussonicPullUrl(baseUrl, streamKey, transport = 'm4f', token = '') {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBase || !streamKey) return '';
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(cleanBase) ? cleanBase : `http://${cleanBase}`);
  } catch {
    return '';
  }

  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const encodedKey = streamKey
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  if (transport === 'm4f_scheme') {
    const m4fProto = parsed.protocol === 'https:' ? 'm4fs' : 'm4f';
    return `${m4fProto}://${parsed.host}/${encodedKey}${q}`;
  }
  if (transport === 'm4f' || transport === 'cmaf') {
    return `${parsed.origin}/${encodedKey}/index.fmp4.m3u8${q}`;
  }
  if (transport === 'mpegts' || transport === 'ts') {
    return `${parsed.origin}/${encodedKey}/mpegts${q}`;
  }
  // default HLS
  return `${parsed.origin}/${encodedKey}/index.m3u8${q}`;
}

/**
 * Parses Flussonic /etc/flussonic/flussonic.conf syntax:
 *   stream <name> {
 *     input m4f://...;
 *     input http://...;
 *     title "Channel Title";
 *     group "Sports";
 *     dvr /storage 7d;
 *   }
 * Also supports legacy single-line: `stream <name> <url>;`
 */
export function parseFlussonicConf(confText, options = {}) {
  const text = String(confText || '');
  const { pullBaseUrl = '', pullTransport = 'm4f', token = '' } = options;

  // Strip comments (# ...) that are outside quotes
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .join('\n');

  const results = [];
  const seenKeys = new Set();

  // 1. Match block syntax: stream|ondemand <name> { ... }
  const blockRegex = /\b(stream|ondemand)\s+([^\s{};]+)\s*\{([\s\S]*?)\}/gi;
  let match;
  while ((match = blockRegex.exec(cleanedLines)) !== null) {
    const kind = match[1].toLowerCase();
    const streamKey = match[2].trim();
    const body = match[3] || '';
    if (!streamKey || seenKeys.has(streamKey)) continue;

    const inputs = [];
    const inputRegex = /\b(?:input|url)\s+([^;\n]+);?/gi;
    let inMatch;
    while ((inMatch = inputRegex.exec(body)) !== null) {
      // Flussonic input lines may include trailing options after space like `source_timeout=10`
      const rawTokens = inMatch[1].trim().split(/\s+/);
      const urlToken = rawTokens[0]?.replace(/^["']|["']$/g, '');
      if (urlToken && /^[a-z0-9+.-]+:\/\//i.test(urlToken)) {
        inputs.push(urlToken);
      }
    }

    const titleMatch = body.match(/\btitle\s+(?:"([^"]+)"|'([^']+)'|([^;\n]+));?/i);
    const groupMatch = body.match(/\b(?:group|category)\s+(?:"([^"]+)"|'([^']+)'|([^;\n]+));?/i);
    const epgMatch = body.match(/\bmeta\s+(?:tvg[_-]id|tvr[_-]id|epg[_-]id)\s+(?:"([^"]+)"|'([^']+)'|([^;\n]+));?/i);
    const dvrMatch = body.match(/\bdvr\s+\S+\s+(\d+)\s*d\b/i);
    const disabled = /\bdisabled(?:\s+true)?\s*;/i.test(body);

    const title = (titleMatch?.[1] || titleMatch?.[2] || titleMatch?.[3] || streamKey).trim();
    const group = (groupMatch?.[1] || groupMatch?.[2] || groupMatch?.[3] || 'Flussonic Live').trim();
    const epgId = (epgMatch?.[1] || epgMatch?.[2] || epgMatch?.[3] || '').trim();
    const dvrDays = dvrMatch ? Math.min(30, Math.max(0, Number(dvrMatch[1]) || 0)) : 0;

    let primaryUrl = inputs[0] || '';
    let backupUrl = inputs[1] || '';

    if (pullBaseUrl) {
      primaryUrl = buildFlussonicPullUrl(pullBaseUrl, streamKey, pullTransport, token);
      backupUrl =
        pullTransport === 'm4f' || pullTransport === 'm4f_scheme'
          ? buildFlussonicPullUrl(pullBaseUrl, streamKey, 'mpegts', token)
          : inputs[0] || '';
    }

    if (!primaryUrl) continue;

    seenKeys.add(streamKey);
    results.push({
      streamKey,
      name: title,
      group,
      epgChannelId: epgId,
      primaryUrl,
      backupUrl,
      upstreamInputs: inputs,
      dvrDays,
      kind,
      alive: !disabled,
      protocol: primaryUrl.startsWith('m4f') || primaryUrl.includes('.fmp4.') ? 'M4F / CMAF' : 'HTTP / TS / HLS',
    });
  }

  // 2. Match legacy single-line syntax: stream <name> <url>;
  const singleLineRegex = /^\s*stream\s+([^\s{};]+)\s+([a-z0-9+.-]+:\/\/[^\s;]+)\s*;?/gim;
  let sMatch;
  while ((sMatch = singleLineRegex.exec(cleanedLines)) !== null) {
    const streamKey = sMatch[1].trim();
    const inputUrl = sMatch[2].trim();
    if (!streamKey || seenKeys.has(streamKey)) continue;

    const primaryUrl = pullBaseUrl
      ? buildFlussonicPullUrl(pullBaseUrl, streamKey, pullTransport, token)
      : inputUrl;
    const backupUrl = pullBaseUrl ? inputUrl : '';

    seenKeys.add(streamKey);
    results.push({
      streamKey,
      name: streamKey,
      group: 'Flussonic Live',
      epgChannelId: '',
      primaryUrl,
      backupUrl,
      upstreamInputs: [inputUrl],
      dvrDays: 0,
      kind: 'stream',
      alive: true,
      protocol: primaryUrl.startsWith('m4f') || primaryUrl.includes('.fmp4.') ? 'M4F / CMAF' : 'HTTP / TS / HLS',
    });
  }

  return results;
}

/**
 * Connects to a live Flussonic Media Server via REST API v3 (/streamer/api/v3/streams),
 * legacy JSON API (/flussonic/api/playlist), or M3U8 playlist (/playlist.m3u8).
 */
export async function fetchFlussonicServerStreams({
  serverUrl,
  username = '',
  password = '',
  bearerToken = '',
  transport = 'm4f_scheme',
  streamToken = '',
}) {
  if (!serverUrl) {
    throw new Error('Debes indicar la URL del servidor Flussonic (ej. http://ip:8080).');
  }
  const cleanServer = String(serverUrl).trim().replace(/\/+$/, '');
  const base = /^https?:\/\//i.test(cleanServer) ? cleanServer : `http://${cleanServer}`;

  const headers = {
    Accept: 'application/json, application/vnd.apple.mpegurl, text/plain, */*',
    'User-Agent': 'TVLister-Flussonic-Connector/2.3',
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken.trim()}`;
  } else if (username || password) {
    const b64 = Buffer.from(`${username}:${password}`).toString('base64');
    headers.Authorization = `Basic ${b64}`;
  }

  const errors = [];

  // Attempt 1: Flussonic API v3 (/streamer/api/v3/streams)
  try {
    const resp = await fetch(`${base}/streamer/api/v3/streams?limit=5000`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const rawList = Array.isArray(data?.streams) ? data.streams : Array.isArray(data) ? data : [];
      if (rawList.length > 0) {
        return {
          apiMode: 'flussonic_v3',
          streams: rawList.map((st) => {
            const key = st.name || st.id;
            const title = st.title || st.meta?.title || key;
            const group = st.group || st.meta?.group || 'Flussonic Live';
            const inputs = Array.isArray(st.inputs)
              ? st.inputs.map((i) => (typeof i === 'string' ? i : i?.url)).filter(Boolean)
              : [];
            const primaryUrl = buildFlussonicPullUrl(base, key, transport, streamToken);
            const backupUrl =
              transport !== 'mpegts'
                ? buildFlussonicPullUrl(base, key, 'mpegts', streamToken)
                : inputs[0] || '';
            return {
              streamKey: key,
              name: title,
              group,
              epgChannelId: st.meta?.tvg_id || st.epg_id || '',
              primaryUrl,
              backupUrl,
              upstreamInputs: inputs,
              dvrDays: st.dvr?.expiration ? Math.round(Number(st.dvr.expiration) / 86400) : 0,
              alive: st.stats?.alive !== false,
              bitrateKbps: st.stats?.bitrate ? Math.round(Number(st.stats.bitrate)) : 0,
              protocol: transport.startsWith('m4f') ? 'M4F / CMAF' : transport.toUpperCase(),
            };
          }),
        };
      }
    } else {
      errors.push(`API v3 HTTP ${resp.status}`);
    }
  } catch (err) {
    errors.push(`API v3: ${err.message}`);
  }

  // Attempt 2: Flussonic M3U8 export (/playlist.m3u8)
  try {
    const m3uUrl = `${base}/playlist.m3u8${streamToken ? `?token=${encodeURIComponent(streamToken)}` : ''}`;
    const resp = await fetch(m3uUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const m3uText = await resp.text();
      if (m3uText.includes('#EXTM3U') || m3uText.includes('#EXTINF')) {
        const lines = m3uText.split(/\r?\n/);
        const parsed = [];
        let pendingMeta = null;

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('#EXTINF')) {
            const titlePart = line.split(',').slice(1).join(',').trim();
            const groupMatch = line.match(/group-title="([^"]+)"/i);
            const idMatch = line.match(/tvg-id="([^"]+)"/i);
            pendingMeta = {
              name: titlePart || 'Flussonic Stream',
              group: groupMatch?.[1] || 'Flussonic Live',
              epgChannelId: idMatch?.[1] || '',
            };
          } else if (!line.startsWith('#')) {
            let key = line;
            try {
              const u = new URL(line, base);
              key = u.pathname.replace(/^\/+/, '').replace(/\/(index(\.fmp4)?\.m3u8|mono\.m3u8|mpegts)$/i, '');
            } catch {
              // ignore
            }
            const primaryUrl = key
              ? buildFlussonicPullUrl(base, key, transport, streamToken)
              : line;
            const backupUrl = key && transport !== 'mpegts'
              ? buildFlussonicPullUrl(base, key, 'mpegts', streamToken)
              : '';
            parsed.push({
              streamKey: key || pendingMeta?.name || `stream_${parsed.length + 1}`,
              name: pendingMeta?.name || key,
              group: pendingMeta?.group || 'Flussonic Live',
              epgChannelId: pendingMeta?.epgChannelId || '',
              primaryUrl,
              backupUrl,
              upstreamInputs: [line],
              dvrDays: 0,
              alive: true,
              bitrateKbps: 0,
              protocol: transport.startsWith('m4f') ? 'M4F / CMAF' : transport.toUpperCase(),
            });
            pendingMeta = null;
          }
        }
        if (parsed.length > 0) {
          return { apiMode: 'flussonic_playlist_m3u8', streams: parsed };
        }
      }
    } else {
      errors.push(`Playlist M3U8 HTTP ${resp.status}`);
    }
  } catch (err) {
    errors.push(`Playlist M3U8: ${err.message}`);
  }

  throw new Error(
    `No se pudo leer el catálogo del servidor Flussonic (${base}). Detalles: ${errors.join(' | ')}`
  );
}

/**
 * Imports parsed Flussonic streams into TVLister categories + streams + optional bouquet.
 */
export function commitFlussonicStreamsToDb(streamsList, options = {}) {
  const {
    createBouquet = true,
    bouquetName = 'Flussonic Import',
    onDemand = false,
  } = options;

  if (!Array.isArray(streamsList) || streamsList.length === 0) {
    throw new Error('No hay streams seleccionados para importar.');
  }

  const findCat = db.prepare("SELECT id FROM categories WHERE name = ? AND type = 'live' LIMIT 1");
  const insertCat = db.prepare("INSERT INTO categories (name, type) VALUES (?, 'live')");
  const findStreamByUrl = db.prepare('SELECT id FROM streams WHERE source_url = ? LIMIT 1');
  const insertStream = db.prepare(`
    INSERT INTO streams (
      name, category_id, source_url, backup_url, logo_url, epg_channel_id,
      status, stream_mode, tv_archive_days, archive_enabled
    ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
  `);
  const updateStream = db.prepare(`
    UPDATE streams
       SET name = ?, category_id = ?, backup_url = ?, epg_channel_id = ?,
           tv_archive_days = ?, archive_enabled = ?
     WHERE id = ?
  `);

  const stats = {
    categoriesCreated: 0,
    streamsInserted: 0,
    streamsUpdated: 0,
    importedStreamIds: [],
  };

  db.exec('BEGIN IMMEDIATE;');
  try {
    const categoryCache = new Map();

    for (const item of streamsList) {
      const catName = (item.group || 'Flussonic Live').trim();
      let categoryId = categoryCache.get(catName);
      if (!categoryId) {
        const existingCat = findCat.get(catName);
        if (existingCat) {
          categoryId = existingCat.id;
        } else {
          const info = insertCat.run(catName);
          categoryId = Number(info.lastInsertRowid);
          stats.categoriesCreated++;
        }
        categoryCache.set(catName, categoryId);
      }

      const dvrDays = Number(item.dvrDays) || 0;
      const existing = findStreamByUrl.get(item.primaryUrl);
      if (existing) {
        updateStream.run(
          item.name,
          categoryId,
          item.backupUrl || '',
          item.epgChannelId || '',
          dvrDays,
          dvrDays > 0 ? 1 : 0,
          existing.id
        );
        stats.streamsUpdated++;
        stats.importedStreamIds.push(existing.id);
      } else {
        const res = insertStream.run(
          item.name,
          categoryId,
          item.primaryUrl,
          item.backupUrl || '',
          item.epgChannelId || '',
          onDemand ? 'ondemand_idle' : 'running',
          onDemand ? 'ondemand' : 'direct',
          dvrDays,
          dvrDays > 0 ? 1 : 0
        );
        stats.streamsInserted++;
        stats.importedStreamIds.push(Number(res.lastInsertRowid));
      }
    }

    if (createBouquet && stats.importedStreamIds.length > 0) {
      const existingBq = db.prepare('SELECT id, stream_ids_json FROM bouquets WHERE name = ? LIMIT 1').get(bouquetName);
      if (existingBq) {
        let currentIds = [];
        try {
          currentIds = JSON.parse(existingBq.stream_ids_json || '[]');
        } catch {
          currentIds = [];
        }
        const merged = Array.from(new Set([...currentIds, ...stats.importedStreamIds]));
        db.prepare('UPDATE bouquets SET stream_ids_json = ? WHERE id = ?').run(JSON.stringify(merged), existingBq.id);
      } else {
        db.prepare(`
          INSERT INTO bouquets (name, description, stream_ids_json, vod_ids_json, series_ids_json)
          VALUES (?, 'Canales importados desde Flussonic Media Server (M4F / CMAF / TS)', ?, '[]', '[]')
        `).run(bouquetName, JSON.stringify(stats.importedStreamIds));
      }
    }

    db.exec('COMMIT;');
    return stats;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore
    }
    throw err;
  }
}
