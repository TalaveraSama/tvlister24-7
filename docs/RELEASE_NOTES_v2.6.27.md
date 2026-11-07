# v2.6.27 — La categoría maestra se llama **Movies**

Publicada el 2 de noviembre de 2026. Sobre la v2.6.26 (borrado de las categorías de carpeta).

## Qué pediste

> «se crearon categorías de carpetas, eso fue error mío, hay que borrar esas categorías y eso que dice
> película de disco tiene que ser categoría master Movies»

Dos cosas: **borrar** las categorías que crearon las subcarpetas y que lo que antes era «por carpeta
del disco» sea una **única categoría maestra llamada `Movies`**.

## Lo que cambia

| Antes | Ahora (v2.6.27) |
| --- | --- |
| Opción «Por carpeta del disco (cada subcarpeta = una categoría)» | **«Categoría maestra · Movies (todo junto)»**, la opción por defecto al sincronizar una carpeta |
| Cada subcarpeta creaba `Ciencia Ficcion`, `triller`, `accion`… | Todo entra en **`Movies`**; las series, en **`Series`** |
| El modo antiguo se podía volver a elegir sin avisar | Sólo aparece si esa carpeta ya estaba así (marcado como *antiguo*), y el panel avisa de que recreará categorías |

- **`Movies` y `Series` no se pueden borrar**: son la casa del catálogo. Salen marcadas como
  *maestra* y su casilla está bloqueada en la pantalla de limpieza.
- La sincronización por **género de TMDB** (v2.6.24) sigue igual y es la otra opción del selector.

## Cómo dejar el catálogo como lo quieres

En el panel, *Películas → Sincronizar Carpeta → Categorías del catálogo*:

1. Si aparece el aviso de carpetas en modo antiguo, pulsa **«Usar la categoría maestra «Movies»»**:
   crea `Movies`/`Series` y cambia esas carpetas para que no vuelvan a crear categorías.
2. Marca las categorías que crearon las subcarpetas (`Ciencia Ficcion`, `triller`, `accion`…). Las
   vacías ya vienen marcadas.
3. Elige **`Movies`** como destino y pulsa **Borrar**: mueve las películas que quedaban dentro y borra
   las categorías. Ningún título se queda sin categoría.

Por terminal, lo mismo en dos pasos:

```bash
tvlister-admin vod-cats master                             # crea Movies y Series y cambia las carpetas
tvlister-admin vod-cats clean --all --move-to "Movies" --yes   # pasa todo a Movies y borra las viejas
```

`tvlister-admin vod-cats` muestra la tabla con el estado de cada categoría (`maestra`, `vacía`,
`N título(s)`) y avisa de las carpetas que siguen en el modo antiguo.

## API nueva

| Ruta | Qué hace |
| --- | --- |
| `GET /api/vod/categories/master` | crea si faltan y devuelve los ids de `Movies` y `Series`, más las carpetas en modo antiguo |
| `POST /api/vod/categories/master` | sólo crea (idempotente) |
| `POST /api/vod/folders/master-mode` | pasa a la maestra todas las carpetas que creaban categorías por subcarpeta |

`GET /api/vod/categories/usage` marca ahora cada categoría con `master: true/false`, y el borrado
(`POST /api/vod/categories/purge`) rechaza las maestras con un mensaje claro.

## Comprobado ejecutando el código real

- `node scripts/test_vod_category_cleanup.mjs` — **39 comprobaciones**: `Movies`/`Series` se crean una
  sola vez, no se pueden borrar, las carpetas pasan a `single` con el destino correcto (películas →
  `Movies`, series → `Series`) y el resto de la purga sigue funcionando.
- `node scripts/test_vod_category_ui.mjs` — **25 comprobaciones** de la pantalla real con jsdom: la
  opción por defecto es «Categoría maestra · Movies», «por carpeta del disco» ya no se ofrece, la
  casilla de la maestra está bloqueada y el botón del aviso cambia las carpetas.
- Sincronización real de una carpeta con dos películas y una serie → `Movies` (2) y `Series` (1),
  creando las categorías solas.
- HTTP contra el panel real: `GET /api/vod/categories/master` → ids 2 y 3; `POST
  /api/vod/folders/master-mode` → `updated: 1`; `POST /api/vod/categories/purge {ids:[1],moveToId:2}`
  → la película acaba en `Movies` y la categoría de carpeta desaparece.
- CLI real: `vod-cats master` + `vod-cats clean --all --move-to Movies --yes` dejan **una sola
  categoría** `Movies` con todos los títulos.

## Instalación / actualización

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.27/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.27
```

En un panel ya instalado: `tvlister-admin update` o `tvlister-admin release v2.6.27`.
Sin cambios de esquema: sólo categorías y ajustes de las carpetas ya existentes.
