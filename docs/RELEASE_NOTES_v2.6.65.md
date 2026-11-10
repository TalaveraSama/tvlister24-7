# TVLister v2.6.65 — la lista de YouTube no llena el disco

Sobre v2.6.64. Con la lista de Los Simpson ya emitiendo desde el disco, la pregunta era la siguiente:

> «pero se me va a llenar el disco de vídeos»

Y era razón: **10 capítulos de 22 min a 1080p son ~3 GB**, y el panel no miraba el disco antes de bajar. En un VPS
de 40–80 GB, dos listas largas y el panel se queda sin sitio para la base, los logs y el propio sistema.

Ahora el panel **mira antes de descargar**, dice lo que va a ocupar, no empieza lo que no cabe y deja liberar
espacio sin tocar lo que está al aire.

## 1. Antes de descargar, dice cuánto va a ocupar

La tarjeta del canal y la vista previa del enlace enseñan la cuenta:

```
Quedan 23 ≈ 9,0 GB · disco libre 48,0 GB
Vídeos en el disco: 3,0 GB (7)
```

- La estimación sale de la **duración real** de cada capítulo (la que ya trae el sondeo de la lista) y de la
  calidad elegida: 1080p ≈ 0,30 MB/s · 720p ≈ 0,15 MB/s · 480p ≈ 0,08 MB/s. Un capítulo de 22 min son ~400, ~200
  o ~105 MB.
- Si de un vídeo no se conoce la duración se supone un capítulo de 22 min (nunca 0, que haría creer que no ocupa).
- El disco libre se lee de verdad (`statfs` del sistema de archivos donde vive `.runtime/videos`), no de un número
  guardado. Se refresca solo cada 30 s en la pantalla.

## 2. No empieza lo que no cabe

Antes de cada descarga —vídeo suelto o lista— el panel comprueba el hueco:

- **Margen libre reservado**: 5 GB por defecto (`youtube_videos_keep_free_gb`) que **no** se usan para vídeos. El
  panel, la base y los logs viven en el mismo disco.
- **Tope de la caché** opcional: `youtube_videos_max_gb` (vacío = sin tope). Al pasarse, se borran los vídeos más
  antiguos que **no** esté emitiendo ningún canal.
- Una lista se recorta a lo que cabe: si pides 10 y sólo caben 6, se preparan 6 y la tarjeta lo dice
  («No se prepararon 4 más: no caben en el disco»). Siempre se deja entrar al menos uno.
- Si no cabe **nada** (ni uno), no se llama a yt-dlp: el aviso dice cuánto hace falta, cuánto queda y qué hacer
  (bajar la calidad, preparar menos capítulos o liberar espacio).

## 3. Bajar la calidad desde la tarjeta

Un selector **1080p · 720p (ocupa la mitad) · 480p (ocupa un tercio)** junto al botón de preparar. Se guarda como
`youtube_video_height` y vale para las descargas siguientes (también las automáticas). No toca lo que ya está en el
disco: los archivos bajados se quedan como están hasta que se liberen.

## 4. «Liberar espacio» sin cortar la emisión

Botón **«Liberar espacio»** en la tarjeta:

- Borra los vídeos descargados que **ya no emite ningún canal**, del más antiguo al más nuevo, y dice cuánto ha
  recuperado: `Liberados 2,0 GB (1 vídeo). Disco libre: 50,0 GB.`
- **Nunca borra un archivo en uso.** Si el canal está emitiendo desde ese mp4, se queda. Si no hay nada que borrar,
  lo dice tal cual en vez de fingir que ha limpiado.
- Al borrar un canal 24/7 se pueden borrar sus vídeos a la vez (`DELETE /api/channels247/:id?videos=1`), salvo los
  que use otro canal. Informa `videos_removed` y `bytes_freed`.

## 5. La casa queda ordenada sola

- Al terminar cada descarga se aplica el tope: si la caché se ha pasado, se podan los vídeos viejos que no están
  emitiendo (`pruned_bytes` en la respuesta).
- Un archivo en uso se detecta leyendo el estado de **todos** los canales 24/7 (listas y vídeos en bucle), no sólo
  del que descarga.

## API

```
GET  /api/youtube/status              → { videos: { count, bytes, used_bytes, unused_bytes,
                                                  free_bytes, total_bytes, disk_known,
                                                  budget_bytes, keep_free_bytes, height } }
GET  /api/youtube/videos              → { ok, files[], count, bytes, used_bytes, unused_bytes,
                                          free_bytes, total_bytes, budget_bytes, height }
POST /api/youtube/videos/cleanup      → { all_unused?: true } ⇒ { removed[], freed_bytes, stats }
POST /api/youtube/download            → { url, duration_sec? }
POST /api/youtube/probe               → añade pending_bytes y disk { free_bytes, keep_free_bytes,
                                          budget_bytes, cache_bytes, height }
DELETE /api/channels247/:id?videos=1  → { videos_removed, bytes_freed }
```

Ajustes: `youtube_video_height` (`1080`/`720`/`480`), `youtube_videos_max_gb` (vacío = sin tope),
`youtube_videos_keep_free_gb` (def. **5**).
Variables: `TVLISTER_YT_HEIGHT` (calidad por defecto si no hay ajuste guardado).

## Pruebas

- `test_youtube_live.mjs` **270 OK** (antes 246): sección **1e4** con la estimación a cada calidad, el margen
  libre, el tope, la poda que **no** borra lo que está en uso, la lista que se recorta y el aviso cuando no cabe
  nada. El servidor de prueba usa su propio directorio HLS para no leer manifiestos viejos.
- `test_youtube_live_ui.mjs` **165 OK** (antes 156): la tarjeta dice lo que ocupan los que faltan y el disco libre,
  el selector de calidad se guarda, «Liberar espacio» llama al panel y cuenta lo recuperado.
- `test_vod_paging`, `test_catv_flussonic_ui`, `test_catv_flussonic_control`, `test_balancer_api`,
  `test_uninstall.sh` (49) y `test_uninstall_ssh.sh` (40): TODO OK. `npm run build`: OK.

## Cómo queda en producción

1. `sudo tvlister-admin update` (o instala la release). Los vídeos que ya hay **no se tocan**.
2. En **Canales 24/7**, la tarjeta del canal dice `Quedan 23 ≈ 9,0 GB · disco libre 48,0 GB`.
3. Si el disco es justo: pon la calidad en **720p** antes de preparar (ocupa la mitad) o baja el número de vídeos.
4. Cuando haga falta sitio: **«Liberar espacio»**. Los canales que están emitiendo desde el disco siguen al aire.
5. Para un tope fijo: `PUT /api/settings {"youtube_videos_max_gb": "20"}` (por ejemplo).
