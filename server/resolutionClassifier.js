import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { db } from './db.js';
import { getFfmpegBin, isFfmpegAvailable, stopWorker } from './streamEngine.js';
import { expandStreamUpstreamUrls } from './iptvApi.js';

let currentScanJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  completed: 0,
  probedCount: 0,
  manifestCount: 0,
  nameFallbackCount: 0,
  countsByTier: { sd: 0, hd: 0, fhd: 0 },
  currentChannel: '',
  appliedMode: '',
  recentResults: [],
  error: null
};

export function getResolutionScanStatus() {
  return currentScanJob;
}

export function classifyResolutionDimensions(width, height, customBitrates = null) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const effectiveHeight = w >= h ? h : w;

  const sdBr = Number(customBitrates?.sd) || 1000;
  const hdBr = Number(customBitrates?.hd) || 2500;
  const fhdBr = Number(customBitrates?.fhd) || 3000;

  if (effectiveHeight > 0 && effectiveHeight <= 580) {
    return {
      tier: 'sd',
      tierLabel: effectiveHeight >= 520 && effectiveHeight <= 560 ? '540p' : effectiveHeight <= 490 ? '480p' : 'SD',
      bitrateKbps: sdBr
    };
  }
  if (effectiveHeight > 800) {
    return {
      tier: 'fhd',
      tierLabel: effectiveHeight >= 1800 ? '4K/FHD' : 'FHD 1080p',
      bitrateKbps: fhdBr
    };
  }
  return {
    tier: 'hd',
    tierLabel: 'HD 720p',
    bitrateKbps: hdBr
  };
}

export function classifyByChannelNameFallback(name = '', customBitrates = null) {
  const n = String(name || '');
  if (/\b(FHD|1080[pi]?|FULL[\s._-]*HD|UHD|4K|2160p?)\b/i.test(n)) {
    const info = classifyResolutionDimensions(1920, 1080, customBitrates);
    return {
      width: 1920,
      height: 1080,
      resolution: '1920x1080',
      ...info,
      source: 'name_hint'
    };
  }
  if (/\b(540[pi]?|qhd)\b/i.test(n)) {
    const info = classifyResolutionDimensions(960, 540, customBitrates);
    return {
      width: 960,
      height: 540,
      resolution: '960x540',
      ...info,
      source: 'name_hint'
    };
  }
  if (/\b(SD|480[pi]?|576[pi]?|360p?|LQ)\b/i.test(n)) {
    const info = classifyResolutionDimensions(854, 480, customBitrates);
    return {
      width: 854,
      height: 480,
      resolution: '854x480',
      ...info,
      source: 'name_hint'
    };
  }
  const info = classifyResolutionDimensions(1280, 720, customBitrates);
  return {
    width: 1280,
    height: 720,
    resolution: '1280x720',
    ...info,
    source: 'name_hint'
  };
}

async function tryProbeHlsMasterManifest(url, userAgent = 'TVLister/2.4') {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (!clean.endsWith('.m3u8') || !/^https?:\/\//i.test(url)) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
      signal: ac.signal
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return null;

    let bestW = 0;
    let bestH = 0;
    const regex = /RESOLUTION=(\d{2,5})x(\d{2,5})/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const w = Number(match[1]);
      const h = Number(match[2]);
      if (w * h > bestW * bestH) {
        bestW = w;
        bestH = h;
      }
    }
    if (bestW > 0 && bestH > 0) {
      return { width: bestW, height: bestH, source: 'hls_manifest' };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function tryProbeWithFfmpegHeader(url, userAgent = 'TVLister/2.4', timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!isFfmpegAvailable()) return resolve(null);

    const bin = getFfmpegBin();
    const env = bin.startsWith('/home/xui/')
      ? { ...process.env, LD_LIBRARY_PATH: `/home/xui/bin/ffmpeg:/home/xui/lib:${process.env.LD_LIBRARY_PATH || ''}` }
      : process.env;

    const args = ['-hide_banner', '-nostdin'];
    if (/^https?:\/\//i.test(url)) {
      args.push('-rw_timeout', '5000000');
      if (userAgent) args.push('-user_agent', userAgent);
    }
    args.push(
      '-analyzeduration',
      '1800000',
      '-probesize',
      '1500000',
      '-i',
      url,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-'
    );

    let stderrBuf = '';
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    } catch {
      return finish(null);
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      // As soon as FFmpeg logs the Video stream dimensions, we don't even need to wait for frame decode!
      const m = stderrBuf.match(/Stream\s+#\d+:\d+[^\r\n]*Video:\s*([a-zA-Z0-9_]+)[^\r\n]*?[,\s](\d{2,5})x(\d{2,5})(?=[\s,\[])/i);
      if (m) {
        const w = Number(m[2]);
        const h = Number(m[3]);
        if (w >= 120 && h >= 90) {
          clearTimeout(killTimer);
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          finish({ width: w, height: h, codec: m[1], source: 'probed' });
        }
      }
    });

    child.on('error', () => {
      clearTimeout(killTimer);
      finish(null);
    });

    child.on('close', () => {
      clearTimeout(killTimer);
      const m = stderrBuf.match(/Stream\s+#\d+:\d+[^\r\n]*Video:\s*([a-zA-Z0-9_]+)[^\r\n]*?[,\s](\d{2,5})x(\d{2,5})(?=[\s,\[])/i);
      if (m) {
        const w = Number(m[2]);
        const h = Number(m[3]);
        if (w >= 120 && h >= 90) {
          return finish({ width: w, height: h, codec: m[1], source: 'probed' });
        }
      }
      finish(null);
    });
  });
}

export async function detectSingleStreamResolution(stream, { probeLive = true, customBitrates = null } = {}) {
  if (probeLive) {
    const candidates = expandStreamUpstreamUrls(stream);
    const ua = stream.user_agent || 'TVLister/2.4';

    for (const cand of candidates) {
      if (!cand) continue;
      if (cand.startsWith('/') && !fs.existsSync(cand)) continue;

      // 1) Instant HLS Master Playlist check (<300ms if #EXT-X-STREAM-INF has RESOLUTION=)
      const hlsRes = await tryProbeHlsMasterManifest(cand, ua);
      if (hlsRes) {
        const info = classifyResolutionDimensions(hlsRes.width, hlsRes.height, customBitrates);
        return {
          width: hlsRes.width,
          height: hlsRes.height,
          resolution: `${hlsRes.width}x${hlsRes.height}`,
          ...info,
          source: 'hls_manifest'
        };
      }

      // 2) Real FFmpeg header probe (reads video SPS/PPS dimensions in ~0.8s)
      const ffRes = await tryProbeWithFfmpegHeader(cand, ua, 5800);
      if (ffRes) {
        const info = classifyResolutionDimensions(ffRes.width, ffRes.height, customBitrates);
        return {
          width: ffRes.width,
          height: ffRes.height,
          resolution: `${ffRes.width}x${ffRes.height}`,
          ...info,
          source: 'probed'
        };
      }
    }
  }

  // 3) Fallback to channel name tags (FHD/1080p, HD/720p, SD/480p/540p)
  return classifyByChannelNameFallback(stream.name, customBitrates);
}

export function ensureTierProfilesInDb({ sdKbps = 1000, hdKbps = 2500, fhdKbps = 3000, useCopyCodec = false } = {}) {
  if (useCopyCodec) {
    const copyProf =
      db
        .prepare("SELECT * FROM transcode_profiles WHERE video_codec = 'copy' AND LOWER(name) LIKE '%copy/copy%' LIMIT 1")
        .get() ||
      db.prepare("SELECT * FROM transcode_profiles WHERE video_codec = 'copy' ORDER BY id ASC LIMIT 1").get();
    return {
      sdProfileId: copyProf.id,
      hdProfileId: copyProf.id,
      fhdProfileId: copyProf.id
    };
  }

  const upsertTierProfile = (namePattern, defaultName, kbps, audioBr, res, extraFlags) => {
    const vBr = `${kbps}k`;
    const existing = db
      .prepare('SELECT * FROM transcode_profiles WHERE LOWER(name) LIKE ? LIMIT 1')
      .get(namePattern);

    if (existing) {
      db.prepare(
        `UPDATE transcode_profiles
         SET video_bitrate = ?, audio_bitrate = ?, resolution = ?, extra_flags = ?
         WHERE id = ?`
      ).run(vBr, audioBr, res, extraFlags, existing.id);
      return existing.id;
    }

    const info = db
      .prepare(
        `INSERT INTO transcode_profiles (name, video_codec, audio_codec, video_bitrate, audio_bitrate, resolution, preset, hwaccel, extra_flags)
         VALUES (?, 'libx264', 'aac', ?, ?, ?, 'ultrafast', 'none', ?)`
      )
      .run(defaultName, vBr, audioBr, res, extraFlags);
    return Number(info.lastInsertRowid);
  };

  const sdProfileId = upsertTierProfile(
    '%auto sd%',
    'Auto SD/480p/540p — 1.0 Mbps',
    sdKbps,
    '96k',
    'source',
    `-vf scale=min(960\\,iw):-2 -tune zerolatency -maxrate ${sdKbps}k -bufsize ${sdKbps * 2}k`
  );

  const hdProfileId = upsertTierProfile(
    '%auto hd 720p%',
    'Auto HD 720p — 2.5 Mbps',
    hdKbps,
    '128k',
    '1280x720',
    `-tune zerolatency -maxrate ${hdKbps}k -bufsize ${hdKbps * 2}k`
  );

  const fhdProfileId = upsertTierProfile(
    '%auto fhd 1080p%',
    'Auto FHD 1080p — 3.0 Mbps',
    fhdKbps,
    '128k',
    '1920x1080',
    `-tune zerolatency -maxrate ${fhdKbps}k -bufsize ${fhdKbps * 2}k`
  );

  return { sdProfileId, hdProfileId, fhdProfileId };
}

export function startResolutionAutoClassifyJob({
  scope = 'all',
  ids = [],
  category_id = 'all',
  probeLive = true,
  stream_mode = 'ondemand', // 'ondemand' | 'transcode' | 'copy_ondemand' | 'copy_transcode'
  sdKbps = 1000,
  hdKbps = 2500,
  fhdKbps = 3000,
  onStreamUpdated = null
} = {}) {
  if (currentScanJob.running) {
    throw new Error('Ya hay un análisis de resolución en progreso.');
  }

  let targetStreams = [];
  if (scope === 'selected' && Array.isArray(ids) && ids.length > 0) {
    const cleanIds = ids.map(Number).filter((n) => n > 0);
    const placeholders = cleanIds.map(() => '?').join(',');
    targetStreams = db.prepare(`SELECT * FROM streams WHERE id IN (${placeholders})`).all(...cleanIds);
  } else if (scope === 'category' && category_id && category_id !== 'all') {
    targetStreams = db.prepare('SELECT * FROM streams WHERE category_id = ?').all(Number(category_id));
  } else {
    targetStreams = db.prepare('SELECT * FROM streams ORDER BY id ASC').all();
  }

  if (targetStreams.length === 0) {
    throw new Error('No hay canales en el alcance seleccionado para analizar.');
  }

  const useCopyCodec = stream_mode === 'copy_ondemand' || stream_mode === 'copy_transcode';
  const dbStreamMode =
    stream_mode === 'copy_ondemand'
      ? 'ondemand'
      : stream_mode === 'copy_transcode'
      ? 'transcode'
      : stream_mode;

  const { sdProfileId, hdProfileId, fhdProfileId } = ensureTierProfilesInDb({
    sdKbps: Number(sdKbps) || 1000,
    hdKbps: Number(hdKbps) || 2500,
    fhdKbps: Number(fhdKbps) || 3000,
    useCopyCodec
  });

  const customBitrates = {
    sd: Number(sdKbps) || 1000,
    hd: Number(hdKbps) || 2500,
    fhd: Number(fhdKbps) || 3000
  };

  currentScanJob = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: targetStreams.length,
    completed: 0,
    probedCount: 0,
    manifestCount: 0,
    nameFallbackCount: 0,
    countsByTier: { sd: 0, hd: 0, fhd: 0 },
    currentChannel: targetStreams[0]?.name || '',
    appliedMode: stream_mode,
    recentResults: [],
    error: null
  };

  // Run worker pool asynchronously (8 concurrent probes)
  (async () => {
    try {
      const concurrency = probeLive ? 8 : 32;
      let cursor = 0;

      const updStmt = db.prepare(`
        UPDATE streams
        SET detected_resolution = ?,
            resolution_tier = ?,
            resolution_source = ?,
            stream_mode = ?,
            transcode_profile_id = ?,
            bitrate_kbps = ?,
            status = ?
        WHERE id = ?
      `);

      const worker = async () => {
        while (cursor < targetStreams.length) {
          const idx = cursor++;
          const st = targetStreams[idx];
          if (!st) break;

          currentScanJob.currentChannel = st.name;

          const res = await detectSingleStreamResolution(st, { probeLive, customBitrates });
          const profId =
            res.tier === 'sd' ? sdProfileId : res.tier === 'fhd' ? fhdProfileId : hdProfileId;
          const nextStatus =
            st.status === 'stopped'
              ? 'stopped'
              : dbStreamMode === 'ondemand'
              ? 'ondemand_idle'
              : 'running';

          stopWorker(`stream_${st.id}`);
          updStmt.run(
            res.resolution,
            res.tier,
            res.source,
            dbStreamMode,
            profId,
            res.bitrateKbps,
            nextStatus,
            st.id
          );

          if (typeof onStreamUpdated === 'function') {
            onStreamUpdated(st.id, dbStreamMode, nextStatus);
          }

          currentScanJob.completed += 1;
          currentScanJob.countsByTier[res.tier] = (currentScanJob.countsByTier[res.tier] || 0) + 1;
          if (res.source === 'probed') currentScanJob.probedCount += 1;
          else if (res.source === 'hls_manifest') currentScanJob.manifestCount += 1;
          else currentScanJob.nameFallbackCount += 1;

          currentScanJob.recentResults = [
            {
              id: st.id,
              name: st.name,
              resolution: res.resolution,
              tier: res.tier,
              tierLabel: res.tierLabel,
              bitrateKbps: res.bitrateKbps,
              source: res.source
            },
            ...currentScanJob.recentResults.slice(0, 14)
          ];
        }
      };

      const pool = Array.from({ length: Math.min(concurrency, targetStreams.length) }, () => worker());
      await Promise.all(pool);
      currentScanJob.finishedAt = new Date().toISOString();
    } catch (err) {
      currentScanJob.error = err.message || 'Error en clasificación automática';
    } finally {
      currentScanJob.running = false;
      currentScanJob.currentChannel = '';
    }
  })();

  return currentScanJob;
}

// ==================== AUTONOMOUS AUTO-PILOT ("CAMBIAR SOLOS") ====================
function getSettingVal(key, fallback) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r?.value !== undefined && r?.value !== null && r?.value !== '' ? r.value : fallback;
  } catch {
    return fallback;
  }
}

function setSettingVal(key, val) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(val));
}

export function getAutoPilotConfig() {
  return {
    enabled: getSettingVal('auto_res_pilot_enabled', 'false') === 'true',
    stream_mode: getSettingVal('auto_res_pilot_mode', 'ondemand'),
    sdKbps: Number(getSettingVal('auto_res_sd_kbps', '1000')) || 1000,
    hdKbps: Number(getSettingVal('auto_res_hd_kbps', '2500')) || 2500,
    fhdKbps: Number(getSettingVal('auto_res_fhd_kbps', '3000')) || 3000
  };
}

export function saveAutoPilotConfig(cfg = {}) {
  if (cfg.enabled !== undefined) setSettingVal('auto_res_pilot_enabled', cfg.enabled ? 'true' : 'false');
  if (cfg.stream_mode) setSettingVal('auto_res_pilot_mode', cfg.stream_mode);
  if (cfg.sdKbps) setSettingVal('auto_res_sd_kbps', Number(cfg.sdKbps) || 1000);
  if (cfg.hdKbps) setSettingVal('auto_res_hd_kbps', Number(cfg.hdKbps) || 2500);
  if (cfg.fhdKbps) setSettingVal('auto_res_fhd_kbps', Number(cfg.fhdKbps) || 3000);
  return getAutoPilotConfig();
}

const recentLiveChecks = new Map();

export async function autoCheckSingleStreamOnPlay(streamId, onStreamSwitched = null) {
  const pilot = getAutoPilotConfig();
  if (!pilot.enabled) return;

  const now = Date.now();
  const lastCheck = recentLiveChecks.get(streamId) || 0;
  // Re-verify at most once every 20 minutes per stream while playing
  if (now - lastCheck < 20 * 60 * 1000) return;
  recentLiveChecks.set(streamId, now);

  const st = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  if (!st) return;

  const customBitrates = { sd: pilot.sdKbps, hd: pilot.hdKbps, fhd: pilot.fhdKbps };
  const res = await detectSingleStreamResolution(st, { probeLive: true, customBitrates });
  if (res.source === 'name_hint' && st.resolution_source === 'probed') return;

  const useCopyCodec = pilot.stream_mode === 'copy_ondemand' || pilot.stream_mode === 'copy_transcode';
  const { sdProfileId, hdProfileId, fhdProfileId } = ensureTierProfilesInDb({
    sdKbps: pilot.sdKbps,
    hdKbps: pilot.hdKbps,
    fhdKbps: pilot.fhdKbps,
    useCopyCodec
  });
  const targetProfId = res.tier === 'sd' ? sdProfileId : res.tier === 'fhd' ? fhdProfileId : hdProfileId;

  const changed =
    st.resolution_tier !== res.tier ||
    Number(st.transcode_profile_id) !== Number(targetProfId) ||
    Number(st.bitrate_kbps) !== Number(res.bitrateKbps);

  db.prepare(
    `UPDATE streams
     SET detected_resolution = ?, resolution_tier = ?, resolution_source = ?,
         transcode_profile_id = ?, bitrate_kbps = ?
     WHERE id = ?`
  ).run(res.resolution, res.tier, res.source, targetProfId, res.bitrateKbps, streamId);

  if (changed && typeof onStreamSwitched === 'function') {
    onStreamSwitched(streamId);
  }
}

let lastFallbackRetryMs = 0;

export function startResolutionAutoPilotDaemon(onStreamUpdated = null) {
  const tick = () => {
    try {
      const pilot = getAutoPilotConfig();
      if (!pilot.enabled || currentScanJob.running) return;

      // 1) Any newly added / imported stream with no tier yet -> classify immediately!
      const unclassified = db
        .prepare("SELECT id FROM streams WHERE resolution_tier IS NULL OR resolution_tier = '' LIMIT 50")
        .all()
        .map((r) => r.id);

      if (unclassified.length > 0) {
        startResolutionAutoClassifyJob({
          scope: 'selected',
          ids: unclassified,
          probeLive: true,
          stream_mode: pilot.stream_mode,
          sdKbps: pilot.sdKbps,
          hdKbps: pilot.hdKbps,
          fhdKbps: pilot.fhdKbps,
          onStreamUpdated
        });
        return;
      }

      // 2) Re-verify any currently active/playing stream (at most once per 20 min per stream)
      const activePlaying = db
        .prepare("SELECT id FROM streams WHERE status = 'running' LIMIT 6")
        .all();
      for (const ap of activePlaying) {
        autoCheckSingleStreamOnPlay(ap.id, (sid) => {
          const fresh = db.prepare('SELECT stream_mode, status FROM streams WHERE id = ?').get(sid);
          if (fresh && typeof onStreamUpdated === 'function') {
            onStreamUpdated(sid, fresh.stream_mode, fresh.status);
          }
        }).catch(() => {});
      }

      // 3) Every 15 minutes, retry up to 12 channels that were offline earlier (name_hint)
      if (Date.now() - lastFallbackRetryMs > 15 * 60 * 1000) {
        lastFallbackRetryMs = Date.now();
        const hintStreams = db
          .prepare("SELECT id FROM streams WHERE resolution_source = 'name_hint' LIMIT 12")
          .all()
          .map((r) => r.id);
        if (hintStreams.length > 0) {
          startResolutionAutoClassifyJob({
            scope: 'selected',
            ids: hintStreams,
            probeLive: true,
            stream_mode: pilot.stream_mode,
            sdKbps: pilot.sdKbps,
            hdKbps: pilot.hdKbps,
            fhdKbps: pilot.fhdKbps,
            onStreamUpdated
          });
        }
      }
    } catch {
      // ignore background tick errors
    }
  };

  const timer = setInterval(tick, 45 * 1000);
  timer.unref?.();
}

