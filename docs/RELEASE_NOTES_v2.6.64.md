# TVLister v2.6.64 — la lista se descarga sola y el canal emite desde el primer capítulo

Sobre v2.6.63. La tarjeta lo decía todo:

> **≡ LISTA · 0** · **⛁ 23 SIN DESCARGAR**
> Los 30 vídeos de la lista no ofrecen un MP4 progresivo (sólo DASH/HLS). Se pueden descargar una vez… botón
> «Preparar lista en el disco».

El botón existía, pero **sólo dentro de Editar**, y aunque se pulsara, el canal seguía a 0 vídeos hasta que
terminara la descarga entera. Las dos cosas están arregladas.

## 1. La descarga se hace sola

Si un canal **al aire** tiene una lista que sólo se puede emitir desde el disco, el panel la empieza a preparar
sin que nadie busque nada (hasta 10 vídeos por defecto, uno cada media hora como máximo).

- Se apaga con el ajuste `youtube_auto_prepare = 0` y el tope se cambia con `youtube_auto_prepare_limit`
  (1–30), desde `PUT /api/settings` (o `python3 -c` sobre la base, como el resto de ajustes).
- Se dispara al resolver la señal: alta del canal, «Renovar señal», arranque del motor y la guardia.
- Nunca hay dos descargas a la vez en el servidor.

## 2. El canal emite desde el PRIMER capítulo

Antes, la lista sólo se podía emitir cuando estaban todos los archivos. Ahora:

- La lista guarda **qué vídeos le faltan** (`pending[]`: id, título y duración) al comprobar la señal.
- `diskPlaylistState()` compone la emisión **sólo con los archivos que haya** en `.runtime/videos`, en el orden
  de la lista, y guarda el estado con `local: true` y `expires_at_ms: 0` (nada que renovar).
- La guardia mira el disco cada 15 s (es `fs.existsSync`, **no** llama a YouTube) y, en cuanto aparece un
  archivo nuevo, reinicia el motor para añadirlo. Con 1 capítulo el canal ya está al aire; los demás se suman
  solos.
- «Renovar señal» sigue preguntando a YouTube de verdad; el refresco automático no (así el anti-robots no puede
  dejar el canal sin señal mientras descarga).

## 3. El botón, en la tarjeta

La tarjeta del canal tiene ahora **«Preparar la lista en el disco»** con su selector de vídeos (1–30, por
defecto 10) y el avance en vivo (`3/10 · Los Simpson 3x04 · descargando 62 % (210 MiB)`), sin abrir Editar.
Al terminar dice cuántos hay en el disco y la tarjeta pasa a `⛁ DESDE EL DISCO`.

- `POST /api/youtube/prepare-playlist` acepta `channel_id` y reutiliza la lista ya leída: la descarga empieza al
  instante, sin otra lectura de YouTube.
- `POST /api/channels247/:id/live-source/refresh` acepta `disk_only: true`: recompone la lista con los archivos
  que ya están en el disco, sin red.
- El chip `⛁ N SIN DESCARGAR` ahora también aparece con la lista a medio preparar (antes se ocultaba en cuanto
  había un vídeo, aunque faltaran 22).

## API

```
GET  /api/youtube/status              → { auto_prepare: { enabled, limit } }
POST /api/youtube/prepare-playlist    → { url, limit?, channel_id? } ⇒ 202
POST /api/channels247/:id/live-source/refresh  → { disk_only?: true }
GET  /api/channels247                 → liveSource.{ pending_count, entries, local, ready }
```

Ajustes: `youtube_auto_prepare` (`1`/`0`), `youtube_auto_prepare_limit` (1–30).
Variables: `TVLISTER_YT_AUTO_PREPARE=0`, `TVLISTER_YT_AUTO_PREPARE_LIMIT`, `TVLISTER_YT_DISK_POLL_MS` (15000).

## Pruebas

- `test_youtube_live.mjs` **246 OK** (antes 227): lista DASH que emite con 1 capítulo, el segundo que se suma
  solo sin llamar a yt-dlp, la guardia que mira el disco y no repregunta, y canal al aire que se descarga solo.
- `test_youtube_live_ui.mjs` **156 OK** (antes 143): la tarjeta del caso real («LISTA · 0», «23 SIN DESCARGAR»)
  con su botón, el avance, el `disk_only` al terminar y el paso a `⛁ DESDE EL DISCO`.
- `test_vod_paging`, `test_catv_flussonic_ui`, `test_catv_flussonic_control`, `test_balancer_api`,
  `test_uninstall.sh` (49) y `test_uninstall_ssh.sh` (40): TODO OK. `npm run build`: OK.

## Cómo queda en producción

1. `sudo tvlister-admin update` (o instala la release). El canal sigue como está.
2. Entra en **Canales 24/7**: el canal de Los Simpson se prepara solo en cuanto la guardia relea la lista, o
   pulsa **«Preparar la lista en el disco»** en la propia tarjeta.
3. En cuanto baje el primer capítulo, la tarjeta pasa a `LISTA · 1` y el canal emite. El resto se añade solo.
