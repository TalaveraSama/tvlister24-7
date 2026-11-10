# TVLister v2.6.66 — la lista de YouTube se ve como canal 24/7, sin descargarla

Sobre v2.6.65. El operador lo dijo claro:

> «no quería eso descargar, quería reproducirlos como canal 24/7»

Y tenía razón: el canal no necesitaba una copia de 3 GB en el VPS para poder emitir. Lo que hacía falta era
**emitir la lista tal como YouTube la da**. Eso es lo que hace ahora.

## 1. La lista se emite desde YouTube

- Un capítulo con **MP4 progresivo** se emite como siempre: una entrada, `-c copy`.
- Un capítulo que **sólo ofrece DASH/HLS** (cada vez más común) ya no obliga a descargarlo: el motor abre su
  **pista de vídeo** y su **pista de audio** a la vez y las une al emitir. La lista se reproduce entera, en
  orden y en bucle, sin tocar el disco.
- Con la lista entera así, el canal dice **▶ LISTA · N** y en la tarjeta se lee: *«Se emite desde YouTube,
  capítulo a capítulo y en bucle (con sus dos pistas unidas al vuelo): no ocupa disco»*.

Cómo funciona por dentro (por si hay que mirarlo en el servidor):

- La señal se guarda con las dos URLs de cada capítulo (`url` = vídeo, `audio_url` = audio). Si el capítulo
  trae audio propio, las dos apuntan al mismo archivo.
- El motor escribe **dos manifiestos de concatenación** en la carpeta HLS del canal (`source.txt` y
  `source-audio.txt`), con los capítulos en el **mismo orden**, y arranca con `-map 0:v:0 -map 1:a:0`. Los dos
  van con `-stream_loop -1`, así que la lista da la vuelta sola.
- Se sigue recodificando **sólo** cuando hace falta (VP9/AV1/HEVC, resoluciones mezcladas u opus): si todo es
  H.264 + AAC, se copia tal cual y el chip sigue siendo `⧉ COPIA EXACTA`.

## 2. Arreglado el motivo de fondo

Los canales que no se descargaban **no arrancaban**. Dos fallos de la línea de FFmpeg:

- El manifiesto de concatenación no llevaba `http` en `-protocol_whitelist`: FFmpeg no podía abrir las URLs
  firmadas de YouTube (`Protocol 'http' not on whitelist 'file,crypto,data'`).
- Las opciones de red (`-reconnect`, `-rw_timeout`, `-user_agent`, `-headers`) iban **sueltas antes de todas
  las entradas**; el demuxer de concatenación no las conoce y FFmpeg se negaba a arrancar
  (`Option reconnect not found`).

Ahora cada entrada de red lleva sus propias opciones, y las cabeceras se aplican **a las dos pistas** (antes
sólo a la primera, con lo que el audio podía quedarse fuera).

## 3. Descargar pasa a ser opcional

- La auto-preparación queda **apagada por defecto**: el canal ya no baja nada solo. Si algún día se quiere una
  copia de respaldo, se enciende con `youtube_auto_prepare = 1` (o `TVLISTER_YT_AUTO_PREPARE=1`).
- El botón de la tarjeta se llama ahora **«Guardar copia en el disco»** y **sólo aparece cuando YouTube no da
  ni una pista** de esos vídeos (el caso raro). El texto lo dice: *«El canal emite igual sin esto»*.
- Todo lo del disco de v2.6.65 (aviso de ocupación, 720p/480p, «Liberar espacio», nunca borrar lo que emite)
  sigue igual para esas copias.

## 4. Los canales que ya estaban «sólo en el disco» pasan a emitir la lista entera

Un estado guardado por v2.6.64 no tiene la marca de «se puede emitir en directo», así que la guardia **vuelve
a leer la lista de YouTube** una vez y, al ver que sí se puede, emite todos los capítulos. Los archivos viejos
se quedan donde están y se pueden borrar con **«Liberar espacio»**.

Una lista que de verdad no se pueda emitir (YouTube sin ninguna pista) sigue saliendo del disco, y cada 6 h se
reintenta por si YouTube vuelve a darla: un fallo pasajero no deja el canal preso.

## API

```
POST /api/youtube/probe     → añade can_stream, streaming
GET  /api/channels247       → liveSource.{ can_stream, streaming, separated_audio }
```

Ajustes: `youtube_auto_prepare` ahora **apagado** salvo `1`/`true`/`si`.

## Pruebas

- `test_youtube_live.mjs` **293 OK** (antes 270): sección nueva **1e5** —una lista DASH/HLS se emite con sus 5
  capítulos, sin escribir un solo archivo en `.runtime/videos`, con los dos manifiestos y el `-map`—, un vídeo
  DASH-only que se emite en bucle sin descargar, la migración de un estado viejo «sólo disco» y el reintento a
  las 6 h.
- `test_youtube_live_ui.mjs` **170 OK** (antes 165): la tarjeta `▶ LISTA · 7`, «no ocupa disco», y que
  «Guardar copia en el disco» aparece **sólo** en la lista de la que YouTube no da pistas.
- **Prueba real con FFmpeg** (no simulada): dos capítulos con vídeo y audio en pistas separadas servidos por
  HTTP; el motor escupe HLS de **13,5 s con imagen H.264 y sonido AAC** (más de un ciclo de la lista) sin
  errores de protocolo. Y el directo con pistas separadas sigue saliendo con imagen y sonido.
- `test_vod_paging`, `test_catv_flussonic_ui`, `test_catv_flussonic_control`, `test_balancer_api`,
  `test_uninstall.sh` (49) y `test_uninstall_ssh.sh` (40): TODO OK. `npm run build`: OK.

## Cómo queda en producción

1. `sudo tvlister-admin update` (o instala la release).
2. En **Canales 24/7**, pulsa **«Renovar señal»** en el canal de la lista (o espera a la guardia): la tarjeta
   pasa a **▶ LISTA · 30** y el canal emite.
3. Si tenías copias en el disco y no las quieres, **«Liberar espacio»**. Los canales que estén emitiendo desde
   un archivo no se tocan.
