# v2.6.26 — Borrar las categorías que sobraron (las de las carpetas)

Publicada el 2 de noviembre de 2026. Continúa la v2.6.25 (puertos 443 y 80 de fábrica).

## Qué pasaba

Al sincronizar el catálogo **por carpeta del disco**, cada subcarpeta crea su propia categoría:
`Ciencia Ficcion/` → «Ciencia Ficcion», `triller/` → «triller», `accion/` → «accion». Al pasar luego
a **por género de TMDB** (v2.6.24) esas categorías se quedaron, con dos consecuencias:

- el desplegable de películas mostraba categorías repetidas y mal escritas, casi todas vacías;
- las pocas películas que TMDB no supo clasificar siguieron dentro de ellas, así que borrarlas a mano
  por la pantalla de categorías dejaba **títulos sin categoría**.

## Qué se hizo

**Panel → Películas → «Sincronizar Carpeta» → tarjeta «Categorías del catálogo: borrar las que sobran».**

1. «Revisar categorías» lista todas las categorías de películas/series con **cuántas películas y
   series** tiene cada una.
2. Las **vacías vienen ya marcadas**.
3. Si marcas alguna que tiene contenido, aparece el selector **«Mover el contenido de las categorías
   con títulos a»** con las categorías que se conservan (y cuántos títulos acabarán allí).
4. Sin destino, el botón **Borrar** queda deshabilitado. Con destino, pide confirmación, mueve y borra.

**Terminal:**

```
tvlister-admin vod-cats                                    # tabla: películas/series por categoría
tvlister-admin vod-cats clean                              # borra SÓLO las vacías (pide confirmación)
tvlister-admin vod-cats clean --all --move-to "Acción"     # consolida todo en «Acción» y borra el resto
tvlister-admin vod-cats clean --all --move-to 12 --yes     # por id, sin preguntar (automatización)
```

La tabla marca con `→ se mueven N títulos` lo que se va a reubicar antes de borrar.

## Garantías

- **Ninguna categoría con contenido se borra sin destino elegido.** La API responde `409` con la lista
  concreta de las que bloquean y el mensaje dice cuántos títulos tiene cada una.
- Al mover se actualizan `vod_items.category_id`, `series.category_id` y el `default_category_id` de
  las carpetas monitoreadas, **en una sola transacción** (`BEGIN IMMEDIATE`): o se mueve y se borra
  todo, o no cambia nada.
- Sólo se consideran categorías de `vod`/`series`: las de canales en vivo no aparecen en la lista ni
  se pueden borrar por esta vía.
- El destino no puede ser una de las categorías que se van a borrar.

## API

| Ruta | Qué hace |
| --- | --- |
| `GET /api/vod/categories/usage` | `{ categories: [{ id, name, type, sort_order, movies, series, total, empty }], total, empty, withContent }` |
| `POST /api/vod/categories/purge` | `{ ids: [..], moveToId }` → `200 { ok, deleted, deletedNames, moved: { movies, series }, moveToId }` |
| | `409` con `{ ok: false, blocked: [...], error }` si hay contenido y no se indicó destino |
| | `400` con mensaje en errores de validación (sin `ids`, ids de otro tipo, destino inexistente o incluido en `ids`) |

## Para que no vuelva a pasar

Las carpetas que ya no deben crear categorías se configuran con `category_mode` en `single` o
`tmdb_genres` (Ajustes de la carpeta); mientras sigan en `subfolders`, el sincronizador volverá a crear
su categoría en el próximo escaneo. La purga no cambia ese ajuste sola: se decide por carpeta.

## Instalación / actualización

```
tvlister-admin update        # o: tvlister-admin release v2.6.26
```

Sin cambios de esquema: esta versión sólo añade endpoints y pantallas sobre las tablas existentes.
Los puertos siguen siendo 443 y 80 (v2.6.25); `tvlister-admin vod-cats` es lo único nuevo en la terminal.

## Comprobación

```
node scripts/test_vod_category_cleanup.mjs   # 28 comprobaciones sobre una base temporal
node scripts/test_vod_category_ui.mjs        # la tarjeta real renderizada con jsdom (npm i -D jsdom)
node scripts/test_vod_genres.mjs             # el reparto por género de TMDB sigue igual
node scripts/test_vod_paging.mjs             # la paginación del catálogo sigue igual
```
