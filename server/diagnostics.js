import { db } from './db.js';
import { getWorkerDiagnostics, getFreshLocalHlsManifestPath, HLS_ROOT, DISK_HLS_ROOT } from './streamEngine.js';
import { expandStreamUpstreamUrls, isItemAllowedForLine } from './iptvApi.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * DIAGNÓSTICO DE REPRODUCCIÓN POR CANAL
 * ----------------------------------------------------------------------------
 * Responde a la pregunta “¿por qué no se ve este canal?” separando las tres
 * piezas que pueden fallar:
 *   1) ORIGEN   — el servidor del proveedor responde (HTTP/manifest/segmento)
 *   2) MOTOR    — el worker FFmpeg del canal está vivo y escribiendo HLS
 *   3) ENTREGA  — el panel sirve ese canal al reproductor (URL de línea)
 * Cada paso devuelve estado, tiempo y detalle; al final un veredicto y
 * acciones concretas. Todo se ejecuta desde el servidor, con descargas
 * mínimas (manifiesto + 4 KB del primer segmento).
 * ============================================================================
 */

const STEP_TIMEOUT_MS = 8000;
const SEG_TIMEOUT_MS = 8000;
const UA_FALLBACK = 'TVLister/2.3 (diagnostico)';

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function maskUrl(raw = '') {
  // No exponer tokens largos en el reporte que copia el administrador
  return String(raw).replace(/([?&](?:token|password|pass|key|auth)=)([^&]{4})[^&]*/gi, '$1$2***');
}

function hostPortOf(raw = '') {
  try {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return '';
    const u = new URL(raw);
    if (!u.port) return u.hostname;
    return `${u.hostname}:${u.port}`;
  } catch {
    return '';
  }
}

function isHlsLike(url = '') {
  const clean = String(url).split('?')[0].toLowerCase();
  return clean.endsWith('.m3u8') || clean.endsWith('.mnf') || /^m4f:/i.test(url);
}

function countSegments(text = '') {
  let n = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) n += 1;
  }
  return n;
}

async function fetchWithTimeout(url, { headers = {}, timeoutMs = STEP_TIMEOUT_MS, method = 'GET' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const startedAt = nowMs();
  try {
    const res = await fetch(url, { method, headers, redirect: 'follow', signal: ac.signal });
    return { res, ms: nowMs() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function httpReason(err) {
  const code = err?.cause?.code || err?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `DNS no resuelve el dominio (${code})`;
  if (code === 'ECONNREFUSED') return 'Conexión rechazada: el puerto está cerrado o el servicio caído (ECONNREFUSED)';
  if (code === 'ECONNRESET') return 'Conexión cortada por el servidor de origen (ECONNRESET)';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host o red inalcanzable';
  if (err?.name === 'AbortError' || code === 'ABORT_ERR') return `Sin respuesta en ${Math.round(STEP_TIMEOUT_MS / 1000)} s (timeout)`;
  if (String(err?.message || '').includes('certificate')) return 'Certificado TLS inválido o vencido';
  return err?.message || 'Error de red desconocido';
}

async function probeCandidate(url, stream, label) {
  const entry = {
    label,
    url: maskUrl(url),
    status: null,
    ms: null,
    contentType: '',
    looksHls: null,
    segments: null,
    segmentProbe: null,
    error: null
  };
  if (!/^https?:\/\//i.test(url)) {
    entry.error = 'Protocolo no HTTP (udp/rtmp/archivo): no se puede probar con HTTP; se valida en el motor';
    return entry;
  }
  try {
    const { res, ms } = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': stream.user_agent || UA_FALLBACK,
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*'
      }
    });
    entry.status = res.status;
    entry.ms = ms;
    entry.contentType = res.headers.get('content-type') || '';

    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        // sin cuerpo
      }
      entry.error =
        res.status === 401 || res.status === 403
          ? 'El origen rechaza el acceso (token/usuario/IP/User-Agent incorrecto)'
          : res.status === 404
            ? 'Ruta del canal no existe en el origen (404)'
            : `El origen respondió HTTP ${res.status}`;
      return entry;
    }

    if (isHlsLike(url)) {
      const text = await res.text();
      entry.looksHls = text.includes('#EXTM3U');
      entry.segments = entry.looksHls ? countSegments(text) : 0;
      if (!entry.looksHls) {
        entry.error = 'El origen respondió 200 pero no devolvió una lista HLS (#EXTM3U)';
        return entry;
      }
      const firstSeg = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      if (firstSeg) {
        try {
          const segUrl = new URL(firstSeg, url).toString();
          const seg = await fetchWithTimeout(segUrl, {
            timeoutMs: SEG_TIMEOUT_MS,
            headers: { 'User-Agent': stream.user_agent || UA_FALLBACK, Range: 'bytes=0-4095' }
          });
          let bytes = 0;
          try {
            const buf = await seg.res.arrayBuffer();
            bytes = buf.byteLength;
          } catch {
            // ignorar
          }
          entry.segmentProbe = { status: seg.res.status, ms: seg.ms, bytes };
          if (!seg.res.ok) entry.error = `El manifiesto existe pero el primer segmento responde HTTP ${seg.res.status}`;
          else if (bytes < 188) entry.error = 'El primer segmento llegó vacío o truncado';
        } catch (err) {
          entry.segmentProbe = { status: null, error: httpReason(err) };
          entry.error = `No se pudo descargar el primer segmento: ${httpReason(err)}`;
        }
      }
    } else {
      // Flujo continuo (TS/FLV): basta con leer unos bytes
      let bytes = 0;
      try {
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          bytes = value?.byteLength || 0;
          await reader.cancel().catch(() => {});
        }
      } catch {
        // ignorar
      }
      entry.streamBytes = bytes;
      if (bytes === 0) entry.error = 'El origen abrió la conexión pero no entregó datos';
    }
    return entry;
  } catch (err) {
    entry.error = httpReason(err);
    return entry;
  }
}

async function stepOrigin(stream, baseUrl) {
  // 1) La fuente ACTIVA (la que realmente reproduce el panel) — manda el veredicto
  const activeUrls = expandStreamUpstreamUrls(stream);
  const tries = [];
  for (let idx = 0; idx < activeUrls.length; idx += 1) {
    const label = idx === 0 ? 'Source activo' : `Candidato ${idx + 1}`;
    const entry = await probeCandidate(activeUrls[idx], stream, label);
    tries.push(entry);
    if (!entry.error) break; // primer candidato sano
  }

  // 2) La fuente DORMIDA (SOURCE 2) se prueba sólo como informe: no afecta
  //    al veredicto porque el panel no la está reproduciendo.
  const backupRaw = String(stream.backup_url || '').trim();
  const activeRaw = String(stream.source_url || '').trim();
  const inactive = [];
  if (backupRaw && backupRaw !== activeRaw) {
    const entry = await probeCandidate(backupRaw, stream, 'Source 2 (respaldo, inactivo)');
    entry.inactive = true;
    inactive.push(entry);
  }

  const best = tries.find((t) => t.status && t.status < 400 && !t.error) || null;
  const selfLoop = tries.some((t) => hostPortOf(t.rawUrl || t.url) && baseUrl && hostPortOf(t.rawUrl || t.url) === hostPortOf(baseUrl));
  return {
    id: 'origin',
    label: 'Origen (proveedor)',
    ok: Boolean(best),
    detail: best
      ? `Responde en ${best.ms} ms${best.segments !== null ? ` · ${best.segments} segmentos` : ''}`
      : activeUrls.length > 1
        ? tries.map((t) => `${t.label}: ${t.error || 'sin respuesta'}`).join(' · ')
        : tries[0]?.error || 'Sin candidatos de origen',
    url: best?.url || tries[0]?.url || '',
    tries,
    inactive,
    backupOk: inactive.length ? Boolean(inactive[0].status && inactive[0].status < 400 && !inactive[0].error) : null,
    hints: selfLoop
      ? ['El origen apunta al propio panel (mismo host:puerto). Si el canal sale del panel, usa la URL de línea /live/… y no la de origen.']
      : []
  };
}

function stepEngine(stream) {
  const key = `stream_${stream.id}`;
  let diag = null;
  try {
    diag = getWorkerDiagnostics().find((w) => w.key === key) || null;
  } catch {
    diag = null;
  }
  const fresh = getFreshLocalHlsManifestPath(key, 18);
  const manifestPath = path.join(HLS_ROOT, key, 'index.m3u8');
  const diskManifest = path.join(DISK_HLS_ROOT, key, 'index.m3u8');
  let segments = 0;
  if (fresh) {
    try {
      segments = countSegments(fs.readFileSync(fresh, 'utf8'));
    } catch {
      segments = 0;
    }
  }
  const usesWorker = stream.stream_mode === 'transcode';
  const hints = [];
  if (usesWorker && (!diag || !diag.pid)) {
    hints.push('El canal está en modo Transcodificación pero su proceso FFmpeg no está vivo: pulsa Iniciar en el canal.');
  }
  if (usesWorker && diag?.pid && !fresh) {
    hints.push('FFmpeg corre pero el manifiesto HLS no se actualiza en los últimos 18 s: revisa que el origen entregue video.');
  }

  return {
    id: 'engine',
    label: 'Motor local (FFmpeg / HLS)',
    ok: usesWorker ? Boolean(diag?.pid && fresh) : true,
    detail: usesWorker
      ? diag?.pid
        ? `FFmpeg PID ${diag.pid} · manifiesto ${fresh ? 'fresco' : 'sin actualizar'} · ${segments} segmentos${diag.hlsAgeSec !== null ? ` · ${diag.hlsAgeSec} s` : ''}`
        : 'Sin proceso FFmpeg para este canal'
      : 'Canal en modo directo: el panel no levanta motor (reenvía el origen)',
    mode: stream.stream_mode,
    pid: diag?.pid || null,
    hlsAgeSec: diag?.hlsAgeSec ?? null,
    segments,
    manifestFresh: Boolean(fresh),
    paths: { ram: manifestPath, disk: diskManifest },
    hints
  };
}

async function stepDelivery(stream, baseUrl) {
  const line = db.prepare("SELECT * FROM lines WHERE status = 'active' ORDER BY id ASC LIMIT 1").get();
  const result = {
    id: 'delivery',
    label: 'Entrega al reproductor (URL de línea)',
    ok: false,
    skipped: false,
    detail: '',
    url: '',
    status: null,
    ms: null,
    hints: []
  };

  if (!line) {
    result.skipped = true;
    result.detail = 'Omitido: no hay líneas activas con las que probar la entrega de este canal';
    return result;
  }

  const allowed = isItemAllowedForLine(line, 'live', stream.id);
  const url = `${baseUrl}/live/${encodeURIComponent(line.username)}/${encodeURIComponent(line.password)}/${stream.id}.m3u8`;
  result.url = maskUrl(url);
  result.line = line.username;

  if (!allowed) {
    result.detail = `La línea "${line.username}" no tiene este canal en su bouquet`;
    result.hints.push('Asigna el canal al bouquet de esa línea (Editar Canal → Bouquets) o revisa el bouquet de la línea.');
    return result;
  }

  try {
    const { res, ms } = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'TVLister/2.3 (diagnostico entrega)' },
      timeoutMs: 10000
    });
    result.status = res.status;
    result.ms = ms;
    const text = await res.text().catch(() => '');
    if (res.ok && text.includes('#EXTM3U')) {
      result.ok = true;
      result.detail = `El panel entrega el manifiesto en ${ms} ms (${countSegments(text)} segmentos)`;
      const firstSeg = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      if (firstSeg) {
        const segUrl = new URL(firstSeg, url).toString();
        try {
          const seg = await fetchWithTimeout(segUrl, { timeoutMs: 10000, headers: { Range: 'bytes=0-4095' } });
          let bytes = 0;
          try {
            bytes = (await seg.res.arrayBuffer()).byteLength;
          } catch {
            bytes = 0;
          }
          result.segment = { status: seg.res.status, ms: seg.ms, bytes };
          if (!seg.res.ok || bytes < 188) {
            result.ok = false;
            result.detail = `El manifiesto sale, pero el segmento responde HTTP ${seg.res.status} (${bytes} bytes)`;
            result.hints.push('El canal no está produciendo segmentos válidos: revisa el motor y el origen.');
          }
        } catch (err) {
          result.ok = false;
          result.detail = `No se pudo descargar un segmento del panel: ${httpReason(err)}`;
        }
      }
    } else if (res.status === 403) {
      result.detail = 'El panel respondió 403: la línea no tiene permiso sobre este canal o está bloqueada por IP/nº de conexiones';
      result.hints.push('Revisa el bouquet de la línea y sus bloqueos (IP, país, conexiones simultáneas).');
    } else if (res.status === 404) {
      result.detail = 'El panel respondió 404: la URL de línea no coincide con ningún canal (¿id correcto?)';
    } else if (res.status === 503) {
      result.detail = 'El panel respondió 503: el canal está detenido por el administrador';
      result.hints.push('Pulsa Iniciar en el canal, o revisa el Bucle Offline si quieres que emita un respaldo.');
    } else {
      result.detail = `El panel respondió HTTP ${res.status}`;
    }
  } catch (err) {
    result.detail = `No se pudo consultar la URL de línea desde el servidor: ${httpReason(err)}`;
    result.hints.push('Comprueba que el panel esté escuchando en ese puerto/host (tvlister-admin status).');
  }
  return result;
}

function buildVerdict(steps) {
  const origin = steps.find((s) => s.id === 'origin');
  const engine = steps.find((s) => s.id === 'engine');
  const delivery = steps.find((s) => s.id === 'delivery');

  // Las pistas se limitan al paso que realmente falla: nada de ruido de pasos sanos.
  if (!origin?.ok && origin?.backupOk) {
    return {
      code: 'SOURCE2_DISPONIBLE',
      title: 'Source 1 está caído, pero el respaldo sí responde',
      text:
        'La URL activa del canal no entrega el manifiesto, mientras que la Source 2 (dormida) sí lo entrega. ' +
        'El corte está en la Source 1: token vencido, ruta cambiada o canal movido en el proveedor.',
      hints: [
        'Editar Canal → pulsa Usar Source 2 (o activa el respaldo automático) para emitir desde el respaldo.',
        'Después corrige la URL de Source 1 con tu proveedor para no quedarte sólo con el respaldo.'
      ]
    };
  }
  if (!origin?.ok) {
    return {
      code: 'ORIGEN_CAIDO',
      title: 'El origen del canal no responde',
      text:
        'El servidor del proveedor (la URL de origen del canal) no entregó un manifiesto válido. ' +
        'Esto afecta al panel y a cualquier app (IPTV Smarters, decos, VLC) por igual: no es un problema del panel.',
      hints: [
        ...(origin?.hints || []),
        'Prueba la misma URL desde el servidor: curl -sSL -o /dev/null -w "%{http_code} %{size_download}" "<URL de origen>".',
        'Si el origen usa token o IP autorizada, renueva el token o pide al proveedor que autorice la IP del servidor.',
        'No hace falta reiniciar el panel ni el motor: el corte está fuera.'
      ]
    };
  }
  if (engine && !engine.ok) {
    return {
      code: 'MOTOR_CAIDO',
      title: 'El origen responde pero el motor local no emite',
      text:
        'FFmpeg no está entregando segmentos para este canal. Mientras el motor no produzca HLS, el reproductor no tendrá video.',
      hints: [
        ...(engine.hints || []),
        'Pulsa Iniciar (o Detener y volver a Iniciar) en el canal y repite el diagnóstico.',
        'Si el log de FFmpeg muestra errores del origen, el problema sigue estando en el proveedor.'
      ]
    };
  }
  if (delivery && !delivery.ok && !delivery.skipped) {
    return {
      code: 'ENTREGA_FALLA',
      title: 'El origen responde pero la entrega al reproductor falla',
      text: 'El panel no pudo servir la URL de línea del canal. Revisa el detalle del paso 3.',
      hints: delivery.hints || []
    };
  }
  if (delivery?.skipped) {
    return {
      code: 'OK',
      title: 'Origen y motor responden',
      text:
        'El origen del canal y el motor responden. No hay líneas activas para probar la entrega, así que ese último ' +
        'tramo no se validó en este diagnóstico.',
      hints: ['Crea o activa una línea en Líneas/Clientes si quieres validar también la URL que recibe el reproductor.']
    };
  }
  return {
    code: 'OK',
    title: 'Todo el recorrido responde',
    text:
      'Origen, motor y entrega responden correctamente desde el servidor. Si tu app no reproduce, revisa el enlace ' +
      'que tiene configurado (usuario/contraseña/puerto) y que no esté cacheado.',
    hints: []
  };
}

export async function diagnoseStream(streamId, { baseUrl = 'http://127.0.0.1' } = {}) {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(Number(streamId));
  if (!stream) return { ok: false, error: 'Canal no encontrado' };

  const startedAt = nowMs();
  const origin = await stepOrigin(stream, baseUrl);
  const engine = stepEngine(stream);
  const delivery = await stepDelivery(stream, baseUrl);
  const steps = [origin, engine, delivery];
  const verdict = buildVerdict(steps);

  return {
    ok: true,
    stream: {
      id: stream.id,
      name: stream.name,
      status: stream.status,
      stream_mode: stream.stream_mode,
      source_url: maskUrl(stream.source_url),
      backup_url: stream.backup_url ? maskUrl(stream.backup_url) : '',
      failover_active: Number(stream.failover_active) === 1,
      auto_failover: Number(stream.auto_failover) === 1
    },
    steps,
    verdict,
    elapsedMs: nowMs() - startedAt,
    checkedAt: new Date().toISOString()
  };
}
