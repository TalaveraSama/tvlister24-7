# TVLister 24/7 — v2.6.24

**El sincronizador de películas ya puede separar el catálogo por el género que dice TMDB.** Al
sincronizar una carpeta, cada película entra directamente en su categoría —**Acción, Comedia,
Terror, Thriller, Románticas, Ciencia ficción…**— según la ficha de TMDB, no según el nombre de la
carpeta. Y para lo que ya está importado hay una vista previa y un botón «Aplicar» que lo recoloca
sin volver a escanear el disco.

## Qué se puede elegir al sincronizar

En el modal **Sincronizar Carpeta** hay un selector nuevo, *Categorías de las películas y series*:

| Opción | Qué hace |
| --- | --- |
| **Por carpeta del disco** | Lo de siempre: cada subcarpeta es una categoría (`Accion/`, `Comedia/`…). |
| **Por género de TMDB** | Cada título va a la categoría de **su género en TMDB**. Las categorías se crean solas y se reutilizan (no se duplican). |
| **Una sola categoría** | Todo el contenido de la carpeta a la misma categoría. |

Con «por género de TMDB», el modo queda guardado en la carpeta monitoreada (`category_mode`), así
que el **re-scan manual y la auto-sincronización** siguen clasificando igual sin volver a elegirlo.

## Cómo se decide la categoría (siempre con lo que dice TMDB)

1. Se busca el título en TMDB (con el año del archivo) y se pide su **ficha** (`/movie/{id}`), que
   devuelve los géneros **en orden de relevancia** y **en el idioma del panel** (por defecto es-MX).
2. La categoría es el **género principal** de TMDB.
3. **Prioridad opcional**: si un título tiene varios géneros («Comedia, Romance»), el primero de la
   lista de prioridad que aparezca manda. Así una romántica puede ir a *Románticas* aunque TMDB diga
   Comedia primero. Se escribe `Románticas, Terror, Acción` (vacío = género principal).
4. **Renombrar**: el cuadro «género de TMDB = categoría» cambia el nombre final. De fábrica vienen
   `Suspense = Thriller`, `Suspenso = Thriller` y `Romance = Románticas`; se pueden cambiar o añadir
   más (`Terror = Miedo`). Se comparan sin acentos ni mayúsculas.
5. Si TMDB **no encuentra** el título o no tiene género, la película **se queda en la categoría que
   ya tenía** (no se pierde ni se oculta).

## Catálogo que ya estaba importado

El panel trae un bloque nuevo dentro del sincronizador, *Separar el catálogo por género de TMDB*:

- **Vista Previa** — consulta TMDB y enseña qué haría, **sin escribir nada**: «Acción 120, Comedia
  80, Terror 44…» por un lado y las series por otro, con cuántos títulos se revisaron, cuántos no
  tienen género en TMDB y cuántos quedan pendientes.
- **Aplicar a Películas y Series** — lo aplica de verdad: guarda los géneros de TMDB en la ficha
  (`tmdb_genres`), actualiza el texto de género y mueve cada título a su categoría, creándola si no
  existe.
- Va **por lotes de 120 títulos por tipo** y encadena hasta 10 lotes por clic (1.200 títulos), para
  que la petición no se eternice con catálogos grandes; el avance se ve en pantalla y se puede
  seguir pulsando. Lo que TMDB no encontró queda marcado como revisado para no repetir la consulta
  en cada lote (se puede reintentar con `refresh`).

## API (panel, `requireAuth` + `requireAdmin`)

| Ruta | Qué hace |
| --- | --- |
| `GET /api/vod/genres/config` | Reglas actuales (alias y prioridad), categorías de VOD y si TMDB está configurado. **Nunca devuelve la API Key.** |
| `POST /api/vod/genres/config` | `{ aliasesText, priorityText, resetAliases }` |
| `POST /api/vod/genres/classify` | `{ dryRun (true por defecto), media: 'movies'\|'series'\|'both', limit, refresh }` |
| `POST /api/vod/folders/sync` | Acepta `categoryMode: 'subfolders' \| 'tmdb_genres' \| 'single'` |

## Comprobado ejecutando el código real

`node scripts/test_vod_genres.mjs` levanta un **TMDB de mentira** (`TVLISTER_TMDB_BASE_URL`), una
base de datos temporal y recorre el camino completo: 52 comprobaciones, **todas OK**.

| Caso | Resultado |
| --- | --- |
| «Acción, Aventura» | → **Acción** (género principal de TMDB) |
| «Suspense, Misterio» | → **Thriller** (alias de fábrica) |
| «Comedia, Romance» sin prioridad | → **Comedia** |
| «Comedia, Romance» con prioridad `Románticas` | → **Románticas** |
| Prioridad escrita `accion` (sin tilde) | → **Acción** |
| Western sin alias | → **Western** (se respeta el nombre de TMDB) |
| Título que TMDB no encuentra | se queda en su categoría, marcado para no repetir |
| Vista previa | no escribe nada en la base (`tmdb_genres` sigue vacío) |
| Sincronizar carpeta con `categoryMode: tmdb_genres` | 3 de 3 películas en Acción / Terror / Thriller, categorías reutilizadas |
| Sincronizar sin API Key de TMDB | avisa y las películas entran igual por carpeta |
| Segunda pasada | 0 consultas: no repite lo ya clasificado |
| `refresh` | vuelve a preguntar por todo el catálogo |

La interfaz se probó renderizando la página real con jsdom: el selector aparece con las tres
opciones, al elegir «por género de TMDB» se explica el modo, el panel de separar por género muestra
la vista previa (Acción, Thriller, Ciencia ficción…) y los botones quedan activos/bloqueados según
haya API Key.

## Nada más se toca

La sincronización por carpeta sigue siendo el modo de fábrica; sin TMDB configurado todo funciona
como antes. No se tocan FFmpeg, UDP/CATV, Flussonic, la lista M3U ni la API de las apps. La
clasificación sólo cambia a qué **categoría** pertenece una película: la URL del archivo, el póster,
la sinopsis y la reproducción no se tocan.
