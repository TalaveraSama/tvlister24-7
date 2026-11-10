# TVLister 24/7 — v2.6.22

**La lista de VOD ya no es interminable: ahora va por páginas.** En la pestaña de películas y en la
de series se muestran 24 títulos por página (configurable) con navegación y el rango visible.

## Qué cambió

### Paginación en Películas y Series

Al pie de la rejilla hay una barra con:

- **Mostrar 12 / 24 / 48 / 96 por página** — 24 por defecto; la elección se recuerda en el navegador.
- **Rango visible**: «1–24 de 320 películas» y «Página 1 de 14».
- **Navegación**: primera, anterior, números de página (con `…` cuando hay muchas),
  siguiente y última. Al cambiar de página la vista sube al inicio de la lista.

Detalles de comportamiento:

- Las **películas** y las **series** tienen su propia página; cambiar de pestaña o **buscar** vuelve a
  la primera.
- Si la lista se acorta (búsqueda o borrado), la página actual se ajusta sola y nunca queda vacía.
- Con pocos títulos (menos que el tamaño de página) **no aparece la barra**: nada de ruido.
- **Búsqueda sin resultados**: mensaje claro («Ninguna película coincide con la búsqueda») con un botón
  para **quitar el filtro**, en vez de una rejilla vacía.
- Los contadores de las pestañas siguen mostrando el total del catálogo.

## Comprobado ejecutando la página (DOM real con jsdom, 61 películas y 30 series)

| Caso | Resultado |
| --- | --- |
| Página 1 con 61 películas | **24 tarjetas**, empieza en la 001, «1–24 de 61», «Página 1 de 3» |
| Botón «siguiente» | empieza en la 025, «25–48 de 61» |
| Botón «última» | **13 tarjetas**, empieza en la 049, «49–61 de 61» |
| Cambiar a 48 por página | vuelve a la página 1, 48 tarjetas, se guarda en `localStorage` |
| Buscar «P05» | 10 resultados y **sin** barra de paginación |
| Buscar algo inexistente | mensaje de sin resultados + botón «Quitar filtro» |
| Pestaña Series (30) | 24 tarjetas, «1–24 de 30 series», «Página 1 de 2» |

Además, `node scripts/test_vod_paging.mjs` comprueba los cálculos (rangos, última página parcial,
elipsis, página fuera de rango, lista vacía, tamaño guardado). Resultado: **todo OK**.

## Sin cambios

API, importación de Jellyfin, enlaces simbólicos, montaje NFS/SMB, salida UDP/CATV, Flussonic,
registro de aparatos y el contrato de las apps Xtream/M3U. Sólo cambia la vista de la sección VOD.

## Instalación / actualización

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.22/install.sh \
  | sudo bash -s -- --tag v2.6.22 --port 8095
```
