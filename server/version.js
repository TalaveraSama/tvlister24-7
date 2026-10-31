import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Versión única del panel, tomada de package.json (el empaquetador de releases
 * escribe también ./VERSION en la raíz del paquete).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg?.version) return String(pkg.version);
  } catch {
    // sin package.json legible
  }
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim().replace(/^v/, '');
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();
export const APP_VERSION_TAG = `v${APP_VERSION}`;
