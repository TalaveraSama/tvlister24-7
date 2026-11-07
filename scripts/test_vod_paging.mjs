#!/usr/bin/env node
// Comprueba la paginación de la lista VOD (sin dependencias).
// Uso: node scripts/test_vod_paging.mjs
import {
  pageWindow,
  pageCount,
  clampPage,
  slicePage,
  pageRange,
  readVodPageSize,
  saveVodPageSize
} from '../src/lib/vodPaging.js';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok  ' : 'FALLO'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` != ${JSON.stringify(want)}`}`);
};

// Ventana de páginas con elipsis.
eq('7 páginas', pageWindow(1, 7), [1, 2, 3, 4, 5, 6, 7]);
eq('20 páginas, pág 1', pageWindow(1, 20), [1, 2, 'gap-right', 20]);
eq('20 páginas, pág 5', pageWindow(5, 20), [1, 'gap-left', 4, 5, 6, 'gap-right', 20]);
eq('20 páginas, pág 20', pageWindow(20, 20), [1, 'gap-left', 19, 20]);

// Recorte y rangos.
const items = Array.from({ length: 61 }, (_, i) => `p${i + 1}`);
eq('61 con 24 → 3 páginas', pageCount(61, 24), 3);
eq('pág 1 tiene 24', slicePage(items, 1, 24).length, 24);
eq('pág 3 tiene 13', slicePage(items, 3, 24).length, 13);
eq('pág 3 empieza en p49', slicePage(items, 3, 24)[0], 'p49');
eq('pág 3 termina en p61', slicePage(items, 3, 24).at(-1), 'p61');
eq('rango pág 3', pageRange(3, 24, 61), { from: 49, to: 61, page: 3, totalPages: 3 });

// Límites.
eq('página 99 → última', clampPage(99, 61, 24), 3);
eq('página 0 → primera', clampPage(0, 61, 24), 1);
eq('lista vacía → 1 página', pageCount(0, 24), 1);
eq('lista vacía → 0–0', pageRange(1, 24, 0), { from: 0, to: 0, page: 1, totalPages: 1 });
eq('slice de lista vacía', slicePage([], 1, 24), []);
eq('pageSize 0 no rompe', pageCount(10, 0), 1);

// Tamaño recordado.
const fake = (value) => ({
  v: value,
  getItem() {
    return this.v;
  },
  setItem(_k, val) {
    this.v = val;
  }
});
eq('sin nada guardado → 24', readVodPageSize(fake(null)), 24);
eq('guardado 48', readVodPageSize(fake('48')), 48);
eq('guardado inválido → 24', readVodPageSize(fake('999')), 24);
const st = fake(null);
saveVodPageSize(st, 96);
eq('se guarda como texto', st.v, '96');
eq('sin storage no lanza', readVodPageSize(undefined), 24);

console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails ? 1 : 0);
