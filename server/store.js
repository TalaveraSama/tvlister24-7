// Persistencia simple en JSON con escritura atómica y debounce.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file, defaultsFactory) {
    this.file = file;
    this.defaultsFactory = defaultsFactory;
    this.data = null;
    this._timer = null;
    this._dirty = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.load();
  }

  load() {
    const defaults = this.defaultsFactory();
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = deepMerge(defaults, parsed);
        return;
      }
    } catch (err) {
      // Base corrupta: se conserva una copia y se arranca limpio.
      try {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.file, backup);
      } catch { /* ignore */ }
      console.error('[store] base de datos corrupta, se reinicia:', err.message);
    }
    this.data = defaults;
    this.saveNow();
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.saveNow();
    }, 250);
    if (this._timer.unref) this._timer.unref();
  }

  saveNow() {
    this._dirty = false;
    this.data.meta = this.data.meta || {};
    this.data.meta.updatedAt = new Date().toISOString();
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] error al guardar:', err.message);
    }
  }

  replace(data) {
    this.data = deepMerge(this.defaultsFactory(), data);
    this.saveNow();
  }

  get stats() {
    return {
      file: this.file,
      bytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
      asrun: this.data.asrun?.length ?? 0,
      media: this.data.media?.length ?? 0,
    };
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
  if (!isPlainObject(base)) return patch === undefined ? base : patch;
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = key in base ? deepMerge(base[key], patch[key]) : patch[key];
  }
  return out;
}

/** Mezcla profunda para actualizaciones parciales de la API. */
export function mergeInto(target, patch) {
  if (!isPlainObject(patch)) return target;
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(target[k])) mergeInto(target[k], v);
    else target[k] = v;
  }
  return target;
}
