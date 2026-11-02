// Utilidades de paginación de la lista VOD (películas y series).
//
// La sección VOD crecía hasta ser una lista interminable: estas funciones
// calculan las páginas y el recorte de cada una, sin depender de React, para
// poder probarlas por separado.

export const VOD_PAGE_SIZES = [12, 24, 48, 96];
export const VOD_PAGE_SIZE_KEY = 'tvlister.vod.pageSize';
export const DEFAULT_VOD_PAGE_SIZE = 24;

/** Tamaño de página guardado en el navegador; si no vale, el de por defecto. */
export function readVodPageSize(storage) {
  try {
    const saved = Number(storage?.getItem(VOD_PAGE_SIZE_KEY));
    return VOD_PAGE_SIZES.includes(saved) ? saved : DEFAULT_VOD_PAGE_SIZE;
  } catch {
    return DEFAULT_VOD_PAGE_SIZE;
  }
}

export function saveVodPageSize(storage, size) {
  try {
    storage?.setItem(VOD_PAGE_SIZE_KEY, String(size));
  } catch {
    /* modo privado o almacenamiento lleno: se queda en memoria */
  }
}

export function pageCount(total, pageSize) {
  const size = Math.max(1, Number(pageSize) || DEFAULT_VOD_PAGE_SIZE);
  return Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
}

/** La página pedida, metida dentro de las que existen. */
export function clampPage(page, total, pageSize) {
  const pages = pageCount(total, pageSize);
  const value = Math.trunc(Number(page) || 1);
  return Math.min(Math.max(1, value), pages);
}

/** El trozo de la lista que toca mostrar. */
export function slicePage(list, page, pageSize) {
  const items = Array.isArray(list) ? list : [];
  const safe = clampPage(page, items.length, pageSize);
  const size = Math.max(1, Number(pageSize) || DEFAULT_VOD_PAGE_SIZE);
  return items.slice((safe - 1) * size, safe * size);
}

/** «1–24 de 320»: el rango visible de la página. */
export function pageRange(page, pageSize, total) {
  const size = Math.max(1, Number(pageSize) || DEFAULT_VOD_PAGE_SIZE);
  const count = Math.max(0, Number(total) || 0);
  const safe = clampPage(page, count, size);
  if (count === 0) return { from: 0, to: 0, page: 1, totalPages: 1 };
  return {
    from: (safe - 1) * size + 1,
    to: Math.min(count, safe * size),
    page: safe,
    totalPages: pageCount(count, size)
  };
}

/**
 * Números de página con elipsis: `1 … 4 5 6 … 20`.
 * `'gap-left'` / `'gap-right'` se pintan como «…».
 */
export function pageWindow(current, total) {
  const pages = Math.max(1, Math.trunc(Number(total) || 1));
  const safe = Math.min(Math.max(1, Math.trunc(Number(current) || 1)), pages);
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);

  const out = [1];
  const start = Math.max(2, safe - 1);
  const end = Math.min(pages - 1, safe + 1);
  if (start > 2) out.push('gap-left');
  for (let p = start; p <= end; p += 1) out.push(p);
  if (end < pages - 1) out.push('gap-right');
  out.push(pages);
  return out;
}
