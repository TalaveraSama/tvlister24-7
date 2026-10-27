import zlib from 'node:zlib';
import { db } from './db.js';

function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function parseXmltvTimestamp(raw = '') {
  // Format: YYYYMMDDHHMMSS +0000 or YYYYMMDDHHMMSS
  const m = String(raw)
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi, sc, sign, tzH, tzM] = m;
  const utcMs = Date.UTC(Number(yr), Number(mo) - 1, Number(dy), Number(hr), Number(mi), Number(sc));
  if (!sign) return new Date(utcMs).toISOString();
  const offsetMin = Number(tzH) * 60 + Number(tzM);
  const adjustedMs = sign === '+' ? utcMs - offsetMin * 60_000 : utcMs + offsetMin * 60_000;
  return new Date(adjustedMs).toISOString();
}

export function parseXmltvContent(xmlText, maxPrograms = 5000) {
  const programs = [];
  const progRegex = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match;

  while ((match = progRegex.exec(xmlText)) !== null && programs.length < maxPrograms) {
    const attrs = match[1];
    const inner = match[2];

    const startRaw = attrs.match(/\bstart="([^"]+)"/i)?.[1];
    const stopRaw = attrs.match(/\bstop="([^"]+)"/i)?.[1];
    const channelId = attrs.match(/\bchannel="([^"]+)"/i)?.[1];

    if (!startRaw || !channelId) continue;
    const startIso = parseXmltvTimestamp(startRaw);
    const endIso = stopRaw ? parseXmltvTimestamp(stopRaw) : null;
    if (!startIso) continue;

    const titleMatch = inner.match(/<title(?:\s+[^>]*)?>([\s\S]*?)<\/title>/i);
    const descMatch = inner.match(/<desc(?:\s+[^>]*)?>([\s\S]*?)<\/desc>/i);
    const langMatch = inner.match(/<title\s+lang="([^"]+)"/i);

    const title = decodeXmlEntities(titleMatch?.[1]?.trim() || 'Programa');
    const description = decodeXmlEntities(descMatch?.[1]?.trim() || '');
    const lang = langMatch?.[1] || 'es';

    programs.push({
      channel_epg_id: decodeXmlEntities(channelId.trim()),
      title,
      description,
      start_time: startIso,
      end_time: endIso || new Date(new Date(startIso).getTime() + 3600_000).toISOString(),
      lang
    });
  }

  return programs;
}

export async function syncEpgSourceById(sourceId, localBaseUrl = 'http://127.0.0.1:8080') {
  const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(Number(sourceId));
  if (!source) throw new Error('Fuente EPG no encontrada');

  let targetUrl = source.xmltv_url.trim();
  if (targetUrl.startsWith('/')) {
    targetUrl = `${localBaseUrl}${targetUrl}`;
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'TVLister247-EPGSync/1.0' }
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    let xmlString;
    const isGzip = (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) || targetUrl.toLowerCase().endsWith('.gz');
    if (isGzip) {
      xmlString = zlib.gunzipSync(buf).toString('utf8');
    } else {
      xmlString = buf.toString('utf8');
    }

    // Do not duplicate internal dynamic 24/7 EPG if pointing to internal /xmltv.php
    const isInternalSelf = source.xmltv_url.trim().startsWith('/xmltv.php');
    const parsed = isInternalSelf ? [] : parseXmltvContent(xmlString);

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('DELETE FROM epg_programs WHERE source_id = ?').run(source.id);
      const insert = db.prepare(
        'INSERT INTO epg_programs (channel_epg_id, title, description, start_time, end_time, lang, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of parsed) {
        insert.run(p.channel_epg_id, p.title, p.description, p.start_time, p.end_time, p.lang, source.id);
      }
      const totalCount = isInternalSelf
        ? parseXmltvContent(xmlString, 500).length
        : parsed.length;
      db.prepare(
        "UPDATE epg_sources SET status = 'synced', program_count = ?, last_updated_at = datetime('now') WHERE id = ?"
      ).run(totalCount, source.id);
      db.exec('COMMIT;');
      return { ok: true, importedCount: totalCount };
    } catch (innerErr) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      throw innerErr;
    }
  } catch (err) {
    db.prepare("UPDATE epg_sources SET status = ?, last_updated_at = datetime('now') WHERE id = ?").run(
      `error: ${err.message}`,
      source.id
    );
    throw err;
  }
}

export function startEpgAutoSyncScheduler(port = 8080) {
  const runAll = async () => {
    const sources = db.prepare('SELECT id, xmltv_url FROM epg_sources').all();
    for (const s of sources) {
      try {
        await syncEpgSourceById(s.id, `http://127.0.0.1:${port}`);
      } catch {
        // individual source failure logged in status column
      }
    }
  };

  // Run every 12 hours automatically
  const timer = setInterval(runAll, 12 * 3600 * 1000);
  timer.unref();
}
