# TVLister 24/7 — v2.6.16

**Jellyfin → VOD con «Create Symlink».** El panel importa el catálogo de Jellyfin (películas, otros
VOD y series con episodios) y, para los archivos que están en el mismo servidor, crea **enlaces
simbólicos** dentro de la carpeta VOD: exactamente la función *Create Symlink* de XUI.one. No se
copia, no se mueve y no se recodifica nada.

## Novedades

### Integración con la API de Jellyfin
- Nuevo botón **«Jellyfin»** en **VOD y Series** (punto verde cuando ya está configurado) con todo el
  flujo: URL, API Key, prueba de conexión, carpetas, bibliotecas, vista previa, importación y estado.
- Autenticación con `X-Emby-Token` (también `Authorization: MediaBrowser Token="…"`), tiempo máximo de
  15 s por petición y mensajes de error claros para clave inválida (401) o servidor inalcanzable.
- Bibliotecas de Jellyfin con su tipo (`movies`, `tvshows`): se pueden marcar todas o sólo algunas.
- **Vista previa antes de importar**: cuántas películas, series y episodios hay y **cuántos archivos son
  accesibles** desde este servidor (con una muestra ruta a ruta), sin tocar la base de datos.

### Create Symlink (igual que XUI.one)
- Película → `vod/movies/<Título> (<año>)<ext>`.
- Episodio → `vod/series/<Serie> - S01E02<ext>`.
- Si el enlace ya existe y apunta al mismo archivo se reutiliza; si apunta a otro archivo, se rehace.
  Importar dos veces **no duplica nada** (clave `external_id` por elemento de Jellyfin).
- El original **nunca** se borra ni se mueve: al eliminar una película, un episodio o una serie del
  panel se borra únicamente el enlace (`symlink_removed: true`).
- **Mapa de rutas** (`/media/peliculas => /mnt/peliculas`) para cuando Jellyfin ve el disco con otro
  prefijo (docker, otro montaje).
- Si el archivo no está accesible se omite (contador `skippedNoFile`) y se avisa en la vista previa.
  Opcionalmente se puede activar el **respaldo directo** por URL de Jellyfin para archivos de otra
  máquina (en ese caso no hay enlace).

### Catálogo
- Carátulas y fondos descargados de Jellyfin y servidos firmados por `/vod_local_poster` (la ruta real
  nunca se expone).
- Categoría por biblioteca (`Jellyfin · Películas`) o una categoría común.
- Enganche automático al primer bouquet del panel, igual que la sincronización de carpetas.
- Relleno opcional de carátulas que falten con TMDB (sólo si TMDB está configurado).
- Las apps Xtream siguen recibiendo `get_vod_info` con carátula, sinopsis, género, año, nota y
  duración (convertida de `RunTimeTicks`).

### Reproducción
- Sin cambios para el reproductor ni para las apps: `source_url` es la ruta del enlace y el servidor
  ya servía symlinks con **Range** (`206 Partial Content`, `Accept-Ranges: bytes`), así que el *seek*
  funciona sobre el archivo real.

### Mantenimiento
- `POST /api/vod/:id/symlink` y `POST /api/series/episodes/:epId/symlink` para enlazar un elemento que
  ya está en el panel (icono de cadena en la tarjeta).
- `GET /api/vod/symlinks/status`: carpeta, número de enlaces, enlaces rotos y espacio libre.
- `POST /api/vod/symlinks/rebuild`: rehace todos los enlaces (admite `dryRun`).
- Terminal: `tvlister-admin jellyfin status | test | import [ids] | symlinks`.

## Base de datos
- `vod_items`: `source_provider` (`manual` por defecto), `external_id`, `symlink_path`.
- `series`: `external_id`.
- `series_episodes`: `external_id`, `symlink_path`.
- Índices `idx_vod_external`, `idx_series_external`, `idx_episodes_external`.
- Migración automática al arrancar; las instalaciones existentes no pierden nada.

## Sin cambios
- No se toca la salida **UDP/CATV**, ni Flussonic, ni el registro de aparatos por MAC, ni el cifrado
  (el DRM sigue retirado desde v2.6.15).
- No se añaden copias de archivos, transcodificación ni ninguna función extra del importador de XUI.one.

## Guía
[`docs/JELLYFIN_VOD.md`](JELLYFIN_VOD.md)

## Instalación / actualización
```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.16/install.sh \
  | sudo bash -s -- --tag v2.6.16 --port 8095
```
