import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db.js';

/**
 * Montaje del disco de Jellyfin en el servidor del panel (NFS o SMB/CIFS).
 *
 * Cuando Jellyfin está en **otra** máquina no hay archivo local que enlazar y
 * «Create Symlink» no puede funcionar: el panel sólo tendría la URL de
 * Jellyfin (el relé de v2.6.19, que hace pasar el vídeo por el panel). La
 * alternativa —la que usa XUI.one en la práctica— es montar la carpeta del
 * disco de Jellyfin aquí: el enlace apunta a un archivo real del montaje y el
 * vídeo lo sirve el panel directamente desde el disco, sin pasar por Jellyfin.
 *
 * Lo que hace este módulo:
 *   1. Monta el recurso (`mount -t nfs` / `mount -t cifs`) en `/mnt/jellyfin-…`.
 *   2. Deja la línea en `/etc/fstab` con la marca `# tvlister:jellyfin`, para
 *      que siga montado después de reiniciar (`nofail` no: si el NAS no está,
 *      el arranque no se bloquea igualmente porque el `fsck` va a 0 y NFS usa
 *      `_netdev`; aun así se documenta cómo quitarla con `jellyfin mount umount`).
 *   3. Guarda la configuración en `settings` para poder repetir el montaje.
 *   4. Para SMB, las credenciales van a un archivo aparte con permisos 600:
 *      la contraseña nunca queda en `fstab` ni en la base de datos.
 *
 * Nunca toca `/etc/fstab` a mano: reescribe sólo su propia línea y deja copia
 * del original en `/etc/fstab.tvlister-bak`. Todo el resto del archivo
 * (comentarios, UUID, swap) se conserva tal cual.
 */

const FSTAB_PATH = process.env.TVLISTER_FSTAB || '/etc/fstab';
const PROC_MOUNTS = process.env.TVLISTER_PROC_MOUNTS || '/proc/mounts';
const MOUNT_BASE = process.env.TVLISTER_MOUNT_BASE || '/mnt';
const CRED_DIR = process.env.TVLISTER_CRED_DIR || '/etc';
const FSTAB_MARK = '# tvlister:jellyfin';
const MOUNT_KEY = 'jellyfin_mount';

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv', '.ogv', '.3gp'
]);

const INSTALL_HINT = {
  nfs: 'sudo apt install -y nfs-common',
  cifs: 'sudo apt install -y cifs-utils'
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function assertCanMount() {
  if (isRoot()) return;
  if (process.env.TVLISTER_MOUNT_ALLOW_NONROOT === '1') return;
  throw new Error(
    'Montar un disco requiere root: ejecuta el panel como servicio (root) o usa «tvlister-admin jellyfin mount …» con sudo.'
  );
}

function which(bin) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* sigue buscando */
    }
  }
  return '';
}

export function mountCapabilities() {
  const nfs = Boolean(which('mount.nfs'));
  const cifs = Boolean(which('mount.cifs'));
  return {
    nfs,
    cifs,
    showmount: Boolean(which('showmount')),
    root: isRoot(),
    platform: process.platform,
    mountBase: MOUNT_BASE,
    install: {
      nfs: nfs ? '' : INSTALL_HINT.nfs,
      cifs: cifs ? '' : INSTALL_HINT.cifs
    }
  };
}

function safeHost(host) {
  return String(host || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-');
}

function cleanRemote(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Falta la carpeta remota (el «export» de NFS o el recurso de SMB).');
  return raw;
}

function defaultMountPoint(_protocol, host) {
  return path.join(MOUNT_BASE, `jellyfin-${safeHost(host) || 'jellyfin'}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function normalizeProtocol(protocol) {
  const p = String(protocol || 'nfs').toLowerCase();
  if (p === 'nfs' || p === 'nfs4') return 'nfs';
  if (p === 'smb' || p === 'cifs' || p === 'smb3') return 'smb';
  throw new Error(`Protocolo no soportado: ${protocol} (usa NFS o SMB).`);
}

/**
 * Opciones de montaje. Siempre de sólo lectura: el panel únicamente lee los
 * vídeos para servirlos y crear enlaces, así que no hay motivo para dar
 * escritura al NAS (y un borrado accidental desde el panel sería grave).
 * `nosuid,nodev,noexec` evita que algo del recurso se ejecute en el servidor.
 */
export function buildMountOptions(protocol, extra = {}) {
  const common = ['ro', '_netdev', 'nosuid', 'nodev', 'noexec'];
  if (protocol === 'nfs') {
    const opts = ['ro', 'hard', '_netdev', 'nosuid', 'nodev', 'noexec'];
    const vers = String(extra.nfsVersion || '').trim();
    if (vers) opts.push(`vers=${vers.replace(/^v/i, '')}`);
    return opts.join(',');
  }
  const opts = [...common, 'iocharset=utf8'];
  if (extra.credentialPath) opts.push(`credentials=${extra.credentialPath}`);
  return opts.join(',');
}

export function buildMountSpec(params = {}) {
  const protocol = normalizeProtocol(params.protocol);
  const host = String(params.host || '').trim();
  if (!host) throw new Error('Falta el host del servidor de archivos (IP o nombre).');
  const remotePath = cleanRemote(params.remotePath);
  const mountPoint = String(params.mountPoint || '').trim() || defaultMountPoint(protocol, host, remotePath);

  if (protocol === 'nfs') {
    const exportPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
    return {
      protocol,
      host,
      remotePath: exportPath,
      source: `${host}:${exportPath}`,
      fstype: 'nfs',
      mountPoint,
      options: buildMountOptions('nfs', params),
      credentialPath: ''
    };
  }

  const share = remotePath.replace(/^\/+/, '');
  const user = String(params.user || '').trim();
  const password = params.password === undefined ? '' : String(params.password);
  const credentialPath = path.join(CRED_DIR, `tvlister-cifs-${safeHost(host)}.cred`);
  return {
    protocol,
    host,
    remotePath: share,
    source: `//${host}/${share}`,
    fstype: 'cifs',
    mountPoint,
    options: buildMountOptions('smb', { credentialPath }),
    credentialPath,
    user,
    password
  };
}

function writeCredentials(spec) {
  if (spec.protocol !== 'smb' || !spec.credentialPath) return '';
  const lines = [`username=${spec.user}`, `password=${spec.password}`];
  ensureDir(path.dirname(spec.credentialPath));
  fs.writeFileSync(spec.credentialPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  // `mode` sólo aplica al crear: si el archivo ya existía, se fuerza igual.
  fs.chmodSync(spec.credentialPath, 0o600);
  return spec.credentialPath;
}

function removeCredentials(spec) {
  if (!spec?.credentialPath) return false;
  try {
    fs.unlinkSync(spec.credentialPath);
    return true;
  } catch {
    return false;
  }
}

function runMount(spec) {
  ensureDir(spec.mountPoint);
  const args = ['-t', spec.fstype, '-o', spec.options, spec.source, spec.mountPoint];
  try {
    execFileSync('mount', args, { stdio: 'pipe', timeout: 90_000 });
  } catch (err) {
    const stderr = String(err.stderr || '').trim();
    const stdout = String(err.stdout || '').trim();
    const detail = stderr || stdout || err.message;
    if (/restricted|operation not permitted|must be superuser|permission denied/i.test(detail)) {
      throw new Error(`No se pudo montar (${detail}). Comprueba que el panel corre como root.`);
    }
    if (/mount\.cifs: not found|mount\.nfs: not found|cifs-utils|nfs-common/i.test(detail)) {
      throw new Error(`No se pudo montar: falta el cliente del sistema. Instálalo con «${INSTALL_HINT[spec.protocol === 'smb' ? 'cifs' : 'nfs']}». Detalle: ${detail}`);
    }
    throw new Error(`No se pudo montar ${spec.source}: ${detail}`);
  }
}

function runUmount(mountPoint) {
  try {
    execFileSync('umount', [mountPoint], { stdio: 'pipe', timeout: 60_000 });
    return true;
  } catch {
    try {
      execFileSync('umount', ['-l', mountPoint], { stdio: 'pipe', timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }
}

/** Montajes reales según `/proc/mounts` (se decodifican los `\040` de los espacios). */
function readMounts() {
  let raw = '';
  try {
    raw = fs.readFileSync(PROC_MOUNTS, 'utf8');
  } catch {
    return [];
  }
  const decode = (value) =>
    value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [source, target, fstype, options] = line.split(' ');
      return { source: decode(source || ''), target: decode(target || ''), fstype: fstype || '', options: options || '' };
    });
}

function isMounted(mountPoint) {
  const target = path.resolve(String(mountPoint || ''));
  return readMounts().some((m) => m.target && path.resolve(m.target) === target);
}

function countVideos(dir, { maxDepth = 6, limit = 200_000 } = {}) {
  let files = 0;
  let videos = 0;
  let sample = '';
  const walk = (current, depth) => {
    if (files >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files >= limit) return;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      files += 1;
      if (VIDEO_EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
        videos += 1;
        if (!sample) sample = full;
      }
    }
  };
  walk(dir, 0);
  return { files, videos, sample };
}

function canRead(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// fstab
// ---------------------------------------------------------------------------

function readFstab() {
  try {
    return fs.readFileSync(FSTAB_PATH, 'utf8');
  } catch {
    return '';
  }
}

function escapeFstab(value) {
  return String(value).replace(/[ \t]/g, '\\040');
}

/** Añade (o reemplaza) **sólo** la línea del panel; el resto queda intacto. */
function upsertFstab(spec) {
  const current = readFstab();
  if (current && !fs.existsSync(`${FSTAB_PATH}.tvlister-bak`)) {
    try {
      fs.writeFileSync(`${FSTAB_PATH}.tvlister-bak`, current, { mode: 0o644 });
    } catch {
      /* la copia es un extra: si falla, seguimos */
    }
  }
  const line = `${escapeFstab(spec.source)} ${escapeFstab(spec.mountPoint)} ${spec.fstype} ${spec.options} 0 0 ${FSTAB_MARK}`;
  // Se conserva el archivo tal cual: sólo se quita la línea propia anterior.
  const kept = current.split('\n').filter((l) => !l.includes(FSTAB_MARK));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const next = kept.length ? `${kept.join('\n')}\n${line}\n` : `${line}\n`;
  fs.writeFileSync(FSTAB_PATH, next, { mode: 0o644 });
  return line;
}

function removeFstabLine() {
  const current = readFstab();
  if (!current) return false;
  const lines = current.split('\n');
  const kept = lines.filter((l) => !l.includes(FSTAB_MARK));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(FSTAB_PATH, kept.join('\n'), { mode: 0o644 });
  return true;
}

// ---------------------------------------------------------------------------
// Configuración persistida
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MOUNT_KEY);
    if (!row?.value) return null;
    const parsed = JSON.parse(String(row.value));
    return parsed && parsed.mountPoint ? parsed : null;
  } catch {
    return null;
  }
}

function saveConfig(config) {
  const value = JSON.stringify(config);
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(MOUNT_KEY, value);
  } catch {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, MOUNT_KEY);
  }
  return config;
}

function clearConfig() {
  try {
    db.prepare('DELETE FROM settings WHERE key = ?').run(MOUNT_KEY);
  } catch {
    /* nada que borrar */
  }
}

export function getJellyfinMountConfig() {
  const cfg = loadConfig();
  if (!cfg) return null;
  // La contraseña nunca sale del archivo de credenciales.
  const { password, ...rest } = cfg;
  return rest;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Monta el recurso en una carpeta temporal, cuenta los vídeos y lo desmonta:
 * sirve para comprobar usuario/clave/ruta **sin** dejar nada a medias.
 */
export function testJellyfinShare(params = {}) {
  assertCanMount();
  const spec = buildMountSpec(params);
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tvlister-mount-'));
  const testSpec = { ...spec, mountPoint: probe };
  if (spec.protocol === 'smb') {
    // Credenciales de prueba aparte: no se pisan las de un montaje en uso.
    testSpec.credentialPath = path.join(probe, '.tvlister-test.cred');
    testSpec.options = buildMountOptions('smb', { credentialPath: testSpec.credentialPath });
  }
  try {
    writeCredentials(testSpec);
    runMount(testSpec);
    const counts = countVideos(probe);
    return {
      ok: true,
      mounted: true,
      files: counts.videos,
      totalFiles: counts.files,
      sample: counts.sample,
      source: spec.source,
      options: spec.options,
      mountPoint: spec.mountPoint
    };
  } finally {
    runUmount(probe);
    if (testSpec.credentialPath) removeCredentials(testSpec); // el temporal no deja credenciales
    try {
      fs.rmSync(probe, { recursive: true, force: true });
    } catch {
      /* puede quedar montado si el umount falló: mejor no borrar nada */
    }
  }
}

/**
 * Monta el recurso y lo deja persistente (fstab + configuración).
 */
export function mountJellyfinShare(params = {}) {
  assertCanMount();
  const caps = mountCapabilities();
  const protocol = normalizeProtocol(params.protocol);
  if (protocol === 'nfs' && !caps.nfs) {
    throw new Error(`Falta el cliente NFS en el servidor. Instálalo con: sudo apt install -y nfs-common`);
  }
  if (protocol === 'smb' && !caps.cifs) {
    throw new Error(`Falta el cliente SMB en el servidor. Instálalo con: sudo apt install -y cifs-utils`);
  }

  const spec = buildMountSpec(params);
  const already = readMounts().find((m) => m.target && path.resolve(m.target) === path.resolve(spec.mountPoint));
  if (already && already.fstype !== spec.fstype) {
    throw new Error(`Ya hay algo montado en ${spec.mountPoint} (${already.source}). Desmóntalo o elige otro punto.`);
  }

  let fstabWritten = false;
  try {
    writeCredentials(spec);
    if (!already) runMount(spec);
    const fstabLine = upsertFstab(spec);
    fstabWritten = true;
    const counts = countVideos(spec.mountPoint);
    if (counts.files === 0) {
      // Montado pero vacío: casi siempre la ruta remota no es la buena.
      throw new Error(
        `Se montó ${spec.source} en ${spec.mountPoint}, pero no hay archivos: revisa la carpeta remota (${spec.remotePath}).`
      );
    }
    const config = saveConfig({
      protocol: spec.protocol,
      host: spec.host,
      remotePath: spec.remotePath,
      mountPoint: spec.mountPoint,
      source: spec.source,
      fstype: spec.fstype,
      options: spec.options,
      credentialPath: spec.credentialPath || '',
      user: spec.user || '',
      createdAt: new Date().toISOString()
    });
    return {
      ok: true,
      source: spec.source,
      mountPoint: spec.mountPoint,
      fstype: spec.fstype,
      options: spec.options,
      files: counts.videos,
      totalFiles: counts.files,
      sample: counts.sample,
      readable: true,
      fstab: fstabLine,
      config: getJellyfinMountConfig()
    };
  } catch (err) {
    // Si algo falló después de montar, no dejamos el punto a medias.
    if (!already && isMounted(spec.mountPoint)) runUmount(spec.mountPoint);
    if (fstabWritten) removeFstabLine();
    throw err;
  }
}

export function unmountJellyfinShare() {
  assertCanMount();
  const config = loadConfig();
  const mountPoint = config?.mountPoint || '';
  let umounted = false;
  if (mountPoint && isMounted(mountPoint)) umounted = runUmount(mountPoint);
  const fstabRemoved = removeFstabLine();
  const credentialRemoved = config?.credentialPath ? removeCredentials({ credentialPath: config.credentialPath }) : false;
  clearConfig();
  return { ok: true, umounted, fstabRemoved, credentialRemoved, mountPoint };
}

/** Vuelve a montar con la configuración guardada (p. ej. si el NAS se reinició). */
export function remountJellyfinShare() {
  assertCanMount();
  const config = loadConfig();
  if (!config) throw new Error('No hay ningún disco de Jellyfin configurado: móntalo primero.');
  if (isMounted(config.mountPoint)) {
    // Con un NAS que se reinició, el montaje viejo queda colgado: se rehace.
    runUmount(config.mountPoint);
  }
  const options = String(config.options || '').replace(/,?credentials=[^,]+/g, '');
  const spec = {
    protocol: config.protocol,
    host: config.host,
    remotePath: config.remotePath,
    mountPoint: config.mountPoint,
    source: config.source,
    fstype: config.fstype,
    options: config.protocol === 'smb' && config.credentialPath ? `${options},credentials=${config.credentialPath}` : options,
    credentialPath: config.credentialPath || '',
    user: config.user || '',
    password: ''
  };
  runMount(spec);
  const counts = countVideos(config.mountPoint);
  if (counts.files === 0) {
    runUmount(config.mountPoint);
    throw new Error(`Se montó ${config.source} pero no hay archivos: revisa que el NAS esté encendido y compartiendo.`);
  }
  return { ok: true, source: config.source, mountPoint: config.mountPoint, files: counts.videos, readable: true };
}

export function getMountStatus() {
  const config = loadConfig();
  const caps = mountCapabilities();
  if (!config) {
    return {
      configured: false,
      mounted: false,
      readable: false,
      mountPoint: '',
      source: '',
      protocol: '',
      files: 0,
      capabilities: caps
    };
  }
  const entry = readMounts().find((m) => m.target && path.resolve(m.target) === path.resolve(config.mountPoint));
  const mounted = Boolean(entry);
  const readable = mounted && canRead(config.mountPoint);
  const counts = readable ? countVideos(config.mountPoint) : { files: 0, videos: 0, sample: '' };
  return {
    configured: true,
    mounted,
    readable,
    mountPoint: config.mountPoint,
    source: config.source,
    protocol: config.protocol,
    remotePath: config.remotePath,
    fstype: config.fstype,
    mountOptions: entry ? entry.options : config.options,
    credentialPath: config.credentialPath || '',
    files: counts.videos,
    sample: counts.sample,
    inFstab: readFstab().includes(FSTAB_MARK),
    capabilities: caps
  };
}
