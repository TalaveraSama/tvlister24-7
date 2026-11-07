import dns from 'node:dns/promises';
import tls from 'node:tls';
import { db } from './db.js';

/**
 * Dominios públicos del panel y del video.
 *
 * El panel (`panel_domain`) es la web que ve el operador; puede ir detrás de
 * Cloudflare porque son peticiones pequeñas (HTML, API, WebSocket).
 * El video (`stream_domain` + `public_stream_base`) sale por su propio
 * subdominio SIN proxy: el tráfico continuo de HLS/TS no está permitido en los
 * planes self-serve de Cloudflare y su caché no está pensada para eso.
 *
 * Este módulo guarda esos ajustes y los comprueba contra el mundo real: DNS,
 * certificado, si hay proxy de Cloudflare delante y si el origen responde. Las
 * comprobaciones se hacen desde el servidor, así que dicen lo que van a ver los
 * clientes, no lo que ve nuestro navegador.
 */

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function normalizeHost(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return value;
}

export function isValidHost(raw) {
  return HOST_RE.test(normalizeHost(raw));
}

function getSetting(key) {
  try {
    return String(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '').trim();
  } catch {
    return '';
  }
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? '').trim());
}

export function getDomains() {
  const panelDomain = normalizeHost(getSetting('panel_domain'));
  const streamDomain = normalizeHost(getSetting('stream_domain'));
  const compatDomain = normalizeHost(getSetting('compat_domain'));
  const base = getSetting('public_stream_base').replace(/\/+$/, '');
  const baseHost = base ? normalizeHost(base) : '';
  return {
    panelDomain,
    streamDomain: streamDomain || baseHost,
    // Tercer dominio, para las apps de siempre (Xtream Codes / XUI.one): las que
    // ya están en producción piden la lista y el video por aquí, y aquí se les
    // contesta con ENLACES DE ESTE MISMO DOMINIO para no romperlas.
    compatDomain,
    publicStreamBase: base,
    // Puerto de salida real del video: el de la base pública o, si no lo dice,
    // 443 para https y 80 para http (es lo que hace el navegador).
    streamPort: (() => {
      const m = /^[a-z]+:\/\/[^/:]+:(\d+)/i.exec(base);
      if (m) return Number(m[1]);
      if (!base) return null;
      return base.startsWith('https://') ? 443 : 80;
    })()
  };
}

export function setDomains({ panelDomain, streamDomain, compatDomain, publicStreamBase }) {
  const panel = normalizeHost(panelDomain);
  const stream = normalizeHost(streamDomain);
  const compat = normalizeHost(compatDomain);

  if (panel && !isValidHost(panel)) {
    throw new Error(`Dominio del panel inválido: "${panelDomain}". Ejemplo: tvadmin.alphadigitalnic.xyz`);
  }
  if (stream && !isValidHost(stream)) {
    throw new Error(`Dominio de los streams inválido: "${streamDomain}". Ejemplo: live-stream.alphadigitalnic.xyz`);
  }
  if (compat && !isValidHost(compat)) {
    throw new Error(`Dominio de compatibilidad inválido: "${compatDomain}". Ejemplo: livex-stream.alphadigitalnic.xyz`);
  }
  if (compat && panel && compat === panel) {
    throw new Error('El dominio de compatibilidad no puede ser el del panel: las apps deben ir directas (nube gris), no por Cloudflare.');
  }

  if (panel) setSetting('panel_domain', panel);
  if (compat) setSetting('compat_domain', compat);

  if (stream) {
    setSetting('stream_domain', stream);
    let base = String(publicStreamBase || '').trim();
    if (!base) base = `https://${stream}`;
    base = base.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    if (normalizeHost(base) !== stream) {
      throw new Error(`La base pública (${base}) no corresponde al dominio de streams (${stream}).`);
    }
    const portMatch = /^[a-z]+:\/\/[^/:]+:(\d+)/i.exec(base);
    if (portMatch && Number(portMatch[1]) !== 443 && Number(portMatch[1]) !== 80) {
      // Se permite, pero es un aviso real: muchos reproductores y redes los bloquean.
      console.warn(`[domains] Aviso: el video saldrá por el puerto ${portMatch[1]} (no estándar).`);
    }
    setSetting('public_stream_base', base);
  }

  return getDomains();
}

/* ------------------------------------------------------------------ *
 * Comprobaciones contra el mundo real
 * ------------------------------------------------------------------ */

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]);
}

async function resolveHost(host) {
  try {
    const v4 = await withTimeout(dns.resolve4(host), 5000, []);
    let cname = [];
    try {
      cname = await withTimeout(dns.resolveCname(host), 3000, []);
    } catch {
      cname = [];
    }
    return { ok: v4.length > 0 || cname.length > 0, ipv4: v4, cname };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return { ok: false, ipv4: [], cname: [] };
    return { ok: false, ipv4: [], cname: [], error: err.message };
  }
}

/**
 * Los objetos de `getPeerCertificate()` tienen prototipo nulo: `String(obj)`
 * lanza "Cannot convert object to primitive value". Aquí sólo se leen sus
 * propiedades, nunca se convierten a cadena.
 */
function objField(value, key) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  const raw = value[key];
  if (typeof raw === 'string') return raw.trim();
  // Un certificado con dos CN (Cloudflare pone el suyo delante) llega como array.
  if (Array.isArray(raw)) {
    const list = raw.filter((v) => typeof v === 'string').map((v) => v.trim());
    return list.find((v) => v.includes('.')) || list[list.length - 1] || '';
  }
  return '';
}

function certCovers(cert, host) {
  const names = new Set();
  if (typeof cert.subjectaltname === 'string') {
    for (const entry of cert.subjectaltname.split(',')) {
      const value = entry.trim().replace(/^DNS:/i, '').toLowerCase();
      if (value) names.add(value);
    }
  }
  const commonName = objField(cert.subject, 'CN');
  const cnMatch = /CN=([^,\n/]+)/.exec(commonName);
  if (cnMatch) names.add(cnMatch[1].trim().toLowerCase());
  else if (commonName) names.add(commonName.toLowerCase());

  for (const name of names) {
    if (name === host) return true;
    if (name.startsWith('*.')) {
      const suffix = name.slice(1); // ".dominio.com"
      if (host.endsWith(suffix) && !host.slice(0, -suffix.length).includes('.')) return true;
    }
  }
  return false;
}

export function inspectCertificate(host, port = 443, timeoutMs = 7000, connectHost = host) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(payload);
    };

    const socket = tls.connect(
      { host: connectHost, port, servername: host, servernameIndication: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        try {
          const cert = socket.getPeerCertificate(false);
          if (!cert || !cert.valid_to) return finish({ ok: false, error: 'El servidor no presentó certificado.' });
          const authorized = socket.authorized;
          const authError = socket.authorizationError ? String(socket.authorizationError) : '';
          const validTo = new Date(cert.valid_to);
          const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
          finish({
            ok: true,
            authorized,
            authorizationError: authError,
            subject: objField(cert.subject, 'CN'),
            issuer: objField(cert.issuer, 'O') || objField(cert.issuer, 'CN'),
            subjectFull: ['C', 'O', 'OU', 'CN']
              .map((k) => (objField(cert.subject, k) ? `${k}=${objField(cert.subject, k)}` : ''))
              .filter(Boolean)
              .join(', '),
            validTo: validTo.toISOString(),
            daysLeft,
            coversHost: certCovers(cert, host),
            altNames: String(cert.subjectaltname || '')
              .split(',')
              .map((s) => s.trim().replace(/^DNS:/i, ''))
              .filter(Boolean),
            latencyMs: Date.now() - started
          });
        } catch (err) {
          finish({ ok: false, error: err.message });
        }
      }
    );

    socket.on('timeout', () => finish({ ok: false, error: `Sin respuesta TLS en ${timeoutMs} ms` }));
    socket.on('error', (err) => finish({ ok: false, error: err.message }));
  });
}

async function httpProbe(host, port = null) {
  const scheme = port === 80 ? 'http' : 'https';
  const url = `${scheme}://${host}${port && port !== 443 && port !== 80 ? `:${port}` : ''}/`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    clearTimeout(timer);
    const headers = res.headers;
    return {
      ok: true,
      status: res.status,
      server: headers.get('server') || '',
      viaCloudflare: Boolean(headers.get('cf-ray')),
      contentType: headers.get('content-type') || '',
      hsts: headers.get('strict-transport-security') || '',
      location: headers.get('location') || ''
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Sin respuesta HTTP en 8 s' : err.message };
  }
}

/**
 * ¿Ese nombre contesta la API de Xtream Codes / XUI.one?
 *
 * Se llama a `/player_api.php` con un usuario inventado: si responde JSON con
 * `user_info`, la app de terceros encontrará exactamente lo que espera
 * (`auth: 0`), sin tocar ninguna línea real.
 */
async function probeXtreamApi(host, port = 443) {
  const scheme = port === 80 ? 'http' : 'https';
  const suffix = port && port !== 443 && port !== 80 ? `:${port}` : '';
  const url = `${scheme}://${host}${suffix}/player_api.php?username=__tvlister_check__&password=__tvlister_check__`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: Boolean(json && json.user_info),
      status: res.status,
      looksXtream: Boolean(json && json.user_info),
      sample: json && json.user_info ? Object.keys(json.user_info).slice(0, 6).join(',') : String(text).slice(0, 80)
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Sin respuesta en 8 s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Comprueba un dominio con su papel: `panel` (puede ir por Cloudflare) o
 * `streams` (no debe ir por Cloudflare nunca).
 */
/**
 * Puerto del 443 «de casa» que se sondea por loopback.
 *
 * No siempre es 443: el panel puede servirse en otro puerto, y la base pública
 * del video puede llevar puerto explícito. Se elige, en este orden, el puerto de
 * `public_stream_base`, el 443 si está declarado como HTTPS y, si no, el primer
 * puerto HTTPS configurado. Así la comprobación del origen apunta a donde de
 * verdad escucha el panel y no inventa un «no responde».
 */
export function originProbePort() {
  const base = getDomains().publicStreamBase;
  const explicit = /^[a-z]+:\/\/[^/:]+:(\d+)/i.exec(base);
  if (explicit) return Number(explicit[1]);

  let stored = '';
  try {
    stored = String(db.prepare("SELECT value FROM settings WHERE key = 'extra_http_ports'").get()?.value || '');
  } catch {
    stored = '';
  }
  const tlsPorts = stored
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [port, scheme] = entry.split(':');
      return { port: Number(port), scheme: String(scheme || '').toLowerCase() };
    })
    .filter((entry) => Number.isInteger(entry.port) && (entry.scheme === 'https' || entry.scheme === 'both'))
    .map((entry) => entry.port)
    .sort((a, b) => a - b);

  if (tlsPorts.includes(443)) return 443;
  return tlsPorts[0] || 443;
}

export async function checkHost(host, role) {
  const target = normalizeHost(host);
  if (!target) {
    return { host: '', role, ok: false, problems: ['Sin dominio configurado.'], warnings: [] };
  }

  const problems = [];
  const warnings = [];
  const dnsInfo = await resolveHost(target);
  if (!dnsInfo.ok) {
    problems.push(`No resuelve en DNS (${target}). Crea el registro A hacia la IP del servidor.`);
  }

  // Lo que sirve NUESTRO 443 (se pregunta a loopback con el SNI del dominio).
  // Es la diferencia entre "Cloudflare responde" y "el origen está bien": un
  // 521 de Cloudflare es exactamente que el origen no contesta.
  const originPort = originProbePort();
  const originCert = await inspectCertificate(target, originPort, 6000, '127.0.0.1');

  // El puerto público es el que verán los clientes: el de la base del video si
  // lleva uno explícito; si no, el 443 de siempre.
  const directRole = role === 'streams' || role === 'compat';
  const publicPort = role === 'streams' ? getDomains().streamPort || 443 : 443;

  // Sin DNS público no tiene sentido culpar al 443: se avisa de lo único que
  // falla de verdad (el registro A) y se sigue mirando el origen local.
  const cert = dnsInfo.ok
    ? await inspectCertificate(target, publicPort)
    : { ok: false, error: 'sin DNS no se puede comprobar el certificado público' };
  if (dnsInfo.ok && !cert.ok) {
    // Si el origen sí contesta, el fallo no está en este servidor: está en el
    // camino (Cloudflare, o el propio servidor sin volver a su IP pública).
    const hint = originCert.ok
      ? ` El ${originPort} de este servidor sí responde para ${target} (certificado de ${originCert.subject}, ${originCert.daysLeft} días): el fallo está en el camino hasta ${target} (Cloudflare o la red del servidor hacia su IP pública).`
      : '';
    problems.push(`Sin respuesta HTTPS válida en ${target}:${publicPort} (${cert.error}).${hint}`);
  } else if (dnsInfo.ok) {
    if (!cert.coversHost) {
      problems.push(`El certificado del ${publicPort} no cubre ${target} (SAN: ${cert.altNames.join(', ') || 'ninguno'}).`);
    }
    if (!cert.authorized) {
      problems.push(`Certificado no confiable para los clientes (${cert.authorizationError || 'no verificado'}).`);
    }
    if (cert.daysLeft < 0) problems.push('El certificado está CADUCADO.');
    else if (cert.daysLeft <= 21) warnings.push(`El certificado caduca en ${cert.daysLeft} días.`);
  }

  const http = dnsInfo.ok ? await httpProbe(target, publicPort) : { ok: false, error: 'sin DNS' };

  if (!originCert.ok) {
    const msg = `el ${originPort} de este servidor no responde para ${target} (${originCert.error})`;
    if (role === 'streams') problems.push(`El video se conecta directo: ${msg}.`);
    else if (role === 'compat') problems.push(`Las apps Xtream entran directas: ${msg}.`);
    else warnings.push(`Cloudflare dará 521 mientras ${msg}.`);
  } else if (!originCert.coversHost) {
    problems.push(
      `El ${originPort} de este servidor presenta un certificado que NO cubre ${target} (${originCert.altNames.join(', ') || 'sin SAN'}).`
    );
  } else if (!originCert.authorized && directRole) {
    // Sólo es un fallo si el certificado no lo puede validar nadie (autofirmado o
    // CA privada). Un problema de cadena en ESTE servidor (p. ej. una CA raíz que
    // Node no trae) se avisa sin afirmar que el reproductor lo rechazará.
    const privateish = /SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF/i.test(
      originCert.authorizationError || ''
    );
    const detail = `${originCert.issuer || 'emisor desconocido'}; ${originCert.authorizationError || 'sin verificar'}`;
    if (privateish) {
      problems.push(
        `El ${originPort} del origen usa un certificado que el reproductor no conoce (${detail}). El video necesita una CA pública: usa Let's Encrypt.`
      );
    } else {
      warnings.push(
        `El ${originPort} del origen no se pudo validar desde este servidor (${detail}). Si es un certificado público, comprueba la cadena con: openssl s_client -connect 127.0.0.1:${originPort} -servername ${target}`
      );
    }
  }

  let xtream = null;

  if (role === 'streams') {
    if (http.ok && http.viaCloudflare) {
      problems.push(
        'El dominio de video está detrás del proxy de Cloudflare (nube naranja). Ponlo en GRIS (DNS only): el video continuo por el proxy se corta y puede acabar en suspensión.'
      );
    }
    if (http.ok && !http.viaCloudflare && http.server) {
      warnings.length === 0 && true; // sin aviso: es lo correcto
    }
  } else if (role === 'panel') {
    if (http.ok && !http.viaCloudflare) {
      warnings.push('El panel no pasa por Cloudflare (nube gris). Funciona, pero pierdes su protección y su caché.');
    }
  } else if (role === 'compat') {
    // Tercer dominio: lo usan apps de terceros que ya están en producción.
    // Sirve API y video, así que también tiene que ir directo.
    if (http.ok && http.viaCloudflare) {
      problems.push(
        'El dominio de compatibilidad está detrás del proxy de Cloudflare (nube naranja). Ponlo en GRIS (DNS only): por ahí también sale el video que piden esas apps.'
      );
    }
    xtream = await probeXtreamApi(target, publicPort);
    if (http.ok && !xtream.ok) {
      problems.push(
        `El dominio responde HTTP ${http.status}, pero /player_api.php no contesta como Xtream (${xtream.sample || xtream.error}). Las apps de terceros esperan esa API y la de get.php.`
      );
    }
  }

  if (http.ok && http.status >= 500) {
    problems.push(`El origen responde ${http.status} en ${target}.`);
  }

  return {
    host: target,
    role,
    ok: problems.length === 0,
    problems,
    warnings,
    dns: dnsInfo,
    certificate: cert,
    xtream,
    originCertificate: { ...originCert, port: originPort },
    http
  };
}

export async function checkDomains() {
  const domains = getDomains();
  const host = String(process.env.TVLISTER_PUBLIC_HOST || '').trim();

  const [panel, streams, compat] = await Promise.all([
    domains.panelDomain ? checkHost(domains.panelDomain, 'panel') : Promise.resolve(null),
    domains.streamDomain ? checkHost(domains.streamDomain, 'streams') : Promise.resolve(null),
    domains.compatDomain ? checkHost(domains.compatDomain, 'compat') : Promise.resolve(null)
  ]);

  const problems = [];
  const warnings = [];

  if (!domains.panelDomain) problems.push('Falta el dominio del panel (panel_domain).');
  if (!domains.streamDomain) problems.push('Falta el dominio de los streams (stream_domain).');
  if (!domains.publicStreamBase) problems.push('Falta la base pública de streaming (public_stream_base).');
  if (domains.panelDomain && domains.streamDomain && domains.panelDomain === domains.streamDomain) {
    problems.push('El panel y el video usan el mismo dominio: el video acabaría pasando por Cloudflare.');
  }
  if (domains.compatDomain) {
    if (domains.compatDomain === domains.panelDomain) {
      problems.push('El dominio de compatibilidad es el del panel: esas apps acabarían pasando por Cloudflare.');
    }
    if (domains.compatDomain === domains.streamDomain) {
      warnings.push('El dominio de compatibilidad y el de video son el mismo: funciona, pero pierdes poder separarlos si una app da problemas.');
    }
  }
  if (domains.publicStreamBase && domains.streamDomain) {
    const baseHost = normalizeHost(domains.publicStreamBase);
    if (baseHost !== domains.streamDomain) {
      problems.push(`La base pública (${domains.publicStreamBase}) no apunta al dominio de streams (${domains.streamDomain}).`);
    }
  }

  // El prefijo con el dominio sólo cuando el texto no lo menciona ya: el
  // resumen final se lee mejor sin "dominio: dominio:443 …".
  const prefixed = (entry, text) => (text.includes(entry.host) ? text : `${entry.host}: ${text}`);
  for (const entry of [panel, streams, compat]) {
    if (!entry) continue;
    problems.push(...entry.problems.map((p) => prefixed(entry, p)));
    warnings.push(...entry.warnings.map((w) => prefixed(entry, w)));
  }

  return {
    domains,
    serverHost: host || null,
    panel,
    streams,
    compat,
    ok: problems.length === 0,
    problems,
    warnings,
    checkedAt: new Date().toISOString(),
    howTo: {
      panel: 'Cloudflare → DNS → registro A de panel_domain hacia la IP del servidor, nube NARANJA (proxy).',
      streams: 'Cloudflare → DNS → registro A de stream_domain hacia la MISMA IP, nube GRIS (DNS only).',
      compat: 'Cloudflare → DNS → registro A de compat_domain hacia la MISMA IP, nube GRIS (DNS only): por ahí entran las apps Xtream de terceros y también piden video.',
      cert: 'Cada nombre necesita su certificado en el origen: tls origin (panel, detrás de Cloudflare) y acme <video> <correo> (video, CA pública). Conviven en el mismo 443 por SNI.'
    }
  };
}
