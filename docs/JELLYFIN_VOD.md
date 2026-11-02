# Jellyfin → TVLister: catálogo de películas y series con «Create Symlink»

Esta integración copia a **XUI.one** únicamente su función **Create Symlink**: en lugar de mover o
copiar archivos de vídeo, el panel crea un **enlace simbólico** dentro de su carpeta VOD que apunta
al archivo original que ya está en el disco. Jellyfin sólo se usa como **catálogo** (títulos, años,
sinopsis, géneros, carátulas y episodios).

> No se copia, no se mueve y no se recodifica nada. Tampoco se borra nunca un archivo real: si algo
> se elimina, se elimina el enlace, no el original.

---

## 1. Requisitos

| Elemento | Detalle |
|---|---|
| Jellyfin | 10.8 o superior, con API HTTP accesible desde el servidor del panel |
| API Key | Panel de Jellyfin → **Administración → API Keys → +** (usuario administrador) |
| Disco | Los archivos de vídeo tienen que ser **legibles por el servidor del panel** (misma máquina o montaje NFS/SMB) |
| Carpeta VOD | Por defecto `/opt/tvlister24-7/vod` (`vod/movies` y `vod/series` se crean solas) |

Si Jellyfin está en **otra máquina** y el disco no está montado aquí, los archivos no se pueden
enlazar: el panel lo detecta y los marca como «no accesibles». Para ese caso existe la opción
*«Si el archivo no está en este servidor, usar la URL de Jellyfin»* (respaldo directo), que **no**
crea enlaces y sirve el vídeo desde Jellyfin.

---

## 2. Configurar desde el panel

1. **VOD y Series → botón «Jellyfin»** (arriba a la derecha, con un punto verde cuando ya está
   configurado).
2. Rellena **URL del servidor** (`http://192.168.1.20:8096`, sin barra final) y **API Key**.
3. Pulsa **«Probar y guardar»**. Debe responder con el nombre y la versión del servidor; si la clave
   es incorrecta Jellyfin devuelve HTTP 401 y el panel lo indica.
4. Revisa la **carpeta VOD donde se crean los symlinks**.
5. Si hace falta, añade el **mapa de rutas** (ver abajo).
6. Marca las **bibliotecas** que quieres importar.
7. Pulsa **«Ver qué hay»** para la previsualización y después **«Importar»**.

El punto del botón indica el estado: **verde** = configurado y con clave, **gris** = sin configurar.

### Mapa de rutas

Jellyfin devuelve la ruta tal como **él** la ve. Si el contenedor de Jellyfin monta el disco con otro
prefijo, se traduce con una línea por equivalencia:

```
/media/peliculas => /mnt/peliculas
/media/series    => /mnt/series
```

Si la ruta que devuelve Jellyfin ya existe en este servidor, el mapa se deja **vacío**.

### Opciones de importación

| Opción | Qué hace |
|---|---|
| **Create Symlink** (activado por defecto) | Crea el enlace en la carpeta VOD y lo usa como `source_url`. Es lo que hace XUI.one con las películas |
| Crear una categoría por biblioteca | Crea categorías `Jellyfin · <biblioteca>` |
| Completar carátulas con TMDB | Sólo rellena las que falten (requiere TMDB configurado) |
| Usar la URL de Jellyfin si el archivo no está aquí | Respaldo directo por HTTP, sin enlace |
| Películas y series / Sólo películas / Sólo series | Filtro de contenido |

---

## 3. Qué se crea exactamente

Nombres de archivo, iguales para la importación y para el enlace individual:

| Tipo | Enlace | Ejemplo |
|---|---|---|
| Película | `<Carpeta VOD>/movies/<Título> (<año>)<ext>` | `vod/movies/Matrix (1999).mkv` |
| Episodio | `<Carpeta VOD>/series/<Serie> - S01E02<ext>` | `vod/series/Breaking Bad - S01E01.mkv` |

El nombre se limpia (se quitan `/ \ : * ? " < > |`) y, si ya existe un enlace distinto con ese
nombre, se prueban sufijos (`… - 2`, `… - 3`). Si el enlace existente **ya apunta al mismo archivo**,
se reutiliza: importar dos veces no duplica nada.

En la base de datos:

- `vod_items.source_provider = 'jellyfin'` y `external_id` = Id del elemento en Jellyfin (clave de la
  importación idempotente).
- `vod_items.symlink_path` / `series_episodes.symlink_path` = ruta del enlace creado.
- `series.external_id` = Id de la serie en Jellyfin.
- Las carátulas se descargan a `data/jellyfin_images/` y se sirven firmadas por
  `/vod_local_poster?p=…&sig=…` (nunca se expone la ruta real).
- Los elementos nuevos se enganchan al **primer bouquet** del panel, igual que la sincronización de
  carpetas.

Contadores de la importación: `moviesAdded`, `moviesExisting`, `seriesAdded`, `seriesExisting`,
`episodesAdded`, `episodesExisting`, `symlinks`, `directUrls`, `skippedNoFile`, `images`,
`tmdbEnriched`, `errors`.

---

## 4. Reproducción

El reproductor y las apps Xtream no cambian: `source_url` es la ruta del enlace dentro del servidor y
la reproducción pasa por las rutas ya existentes.

```bash
# Película (Xtream/VOD): 206 Partial Content sobre el archivo completo
curl -r 0-99 -D- "http://IP:8080/movie/USUARIO/CLAVE/1"

# Episodio
curl -r 0-49 -D- "http://IP:8080/series/USUARIO/CLAVE/1.mkv"
```

Se responde `Accept-Ranges: bytes` y `Content-Range: bytes 0-99/400000`, es decir, se hace *seek*
sobre el archivo real a través del enlace (no se copia a temporal).

---

## 5. Mantenimiento

### Desde el panel

- **Enlace individual** en la tarjeta de una película cuyo `source_url` es una ruta local y que aún no
  tiene `symlink_path` (icono de cadena).
- **Estado de enlaces**: `GET /api/vod/symlinks/status` devuelve carpeta, número de enlaces, enlaces
  rotos y espacio libre.
- Al **borrar** una película, un episodio o una serie completa, el panel borra también sus enlaces
  (`symlink_removed: true`). El archivo original no se toca.

### Desde la terminal

```bash
tvlister-admin jellyfin status      # configuración, bibliotecas, enlaces y rotos
tvlister-admin jellyfin test        # conexión + bibliotecas disponibles
tvlister-admin jellyfin import      # importa todas las bibliotecas configuradas
tvlister-admin jellyfin import lib-movies,lib-tv
tvlister-admin jellyfin symlinks    # rehace todos los enlaces (tras mover la carpeta)
```

---

## 6. Rutas de la API del panel

Todas requieren sesión de administrador.

| Método y ruta | Uso |
|---|---|
| `GET /api/jellyfin/config` | Configuración actual (clave enmascarada) |
| `POST /api/jellyfin/config` | Guarda URL, clave, carpeta, mapa y respaldo directo. `testConnection: true` prueba la conexión |
| `POST /api/jellyfin/test` | Prueba la conexión y devuelve nombre/versión |
| `GET /api/jellyfin/libraries` | Bibliotecas con su `collectionType` y las seleccionadas |
| `POST /api/jellyfin/preview` | `{libraryIds, contentMode}` → cuántas películas/series/episodios y cuántos archivos son accesibles |
| `POST /api/jellyfin/import` | `{libraryIds, contentMode, createSymlink, symlinkDir, useLibraryAsCategory, autoTmdb, directFallback, fetchImages}` |
| `POST /api/vod/:id/symlink` | Crea el enlace de una película ya existente |
| `POST /api/series/episodes/:epId/symlink` | Crea el enlace de un episodio |
| `GET /api/vod/symlinks/status` | Estado de la carpeta y enlaces rotos |
| `POST /api/vod/symlinks/rebuild` | Rehace todos los enlaces (`{dryRun:true}` para simular) |

La API de Jellyfin que se usa: `/System/Info`, `/Library/MediaFolders`,
`/Items?ParentId=&Recursive=true&IncludeItemTypes=Movie|Series`, `/Shows/{id}/Episodes` y
`/Items/{id}/Images/{Primary|Backdrop}`. Autenticación por cabecera `X-Emby-Token` (también se
acepta `Authorization: MediaBrowser Token="…"`).

---

## 7. Problemas típicos

| Síntoma | Causa y solución |
|---|---|
| «Jellyfin rechazó la API Key (HTTP 401)» | Clave mal copiada o revocada: crear una nueva en Jellyfin |
| «No se pudo conectar con Jellyfin» | URL, puerto (8096) o firewall; probar con `curl http://IP:8096/System/Info` |
| Vista previa con muchos «no accesibles» | Falta el mapa de rutas o el disco no está montado en este servidor |
| `skippedNoFile` sube y no importa | Igual que arriba; o los archivos son de otra máquina (activar respaldo directo) |
| Un título no aparece en el panel | Ya estaba importado (se cuenta en `moviesExisting`), o su biblioteca no estaba marcada |
| El vídeo no arranca pero el título está | El archivo original se movió o se borró: el enlace queda roto. `jellyfin symlinks` lo informa |
| Se ve carátula rota | La imagen se descargó mal en su momento: borrar el registro de `data/jellyfin_images` y reimportar la carátula con TMDB |

---

## 8. Lo que esta integración **no** hace

- No copia ni mueve archivos de vídeo (eso es el «Create Symlink» de XUI.one, nada más).
- No transcodifica ni remuxea.
- No borra los originales al eliminar una película del panel.
- No sincroniza cambios posteriores sin volver a pulsar **Importar** (la importación es idempotente:
  lo que ya existe no se duplica).
