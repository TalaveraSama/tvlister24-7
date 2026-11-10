# TVLister v2.6.59 — el enlace del navegador y los vídeos que sólo dan DASH/HLS

Sobre v2.6.58. Dos cosas que dejaban canales a oscuras:

```
Ese vídeo no ofrece un MP4/WebM que se pueda repetir en bucle (sólo HLS/DASH, o es privado / con restricción…)
```

## 1. El enlace que copia el navegador trae dos cosas

`watch?v=ioSKlIL4Hs8&list=PLpbdLXz_…` es el enlace que aparece en la barra cuando ves un vídeo **dentro de una
lista**. El panel lo leía como «vídeo suelto» e ignoraba la lista. Ahora:

- Se trata como **lista completa** (que es lo que hace YouTube): se emiten sus vídeos en orden, hasta 30, y
  vuelve a empezar. El vídeo de partida queda anotado (`start_video_id`).
- La pantalla lo avisa: *«Ese enlace trae vídeo + lista: se emitirá la lista completa (hasta 30 vídeos, en
  orden)»*, con un botón **«Sólo ese vídeo»** que quita `list=` e `index=` del enlace si lo que quieres es ese
  vídeo repetido en bucle.

## 2. Vídeos sin MP4 progresivo: se descargan una vez y se repiten desde el disco

YouTube cada vez sirve menos vídeos con un MP4 progresivo (los da en DASH/HLS con vídeo y audio en pistas
separadas, a veces con PO token). Sin archivo no hay bucle fiable: la URL firmada caduca y el HLS de un vídeo no
se repite bien. Ahora:

- La comprobación lo dice claro y ofrece **«Descargar vídeo (una vez)»**.
- yt-dlp lo baja **ya mezclado** (`bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]`, salida mp4, ≤1080p) a
  `.runtime/videos/`, con su ficha (título, duración, códecs) al lado.
- La descarga va **en segundo plano** con el avance a la vista (*«descargando 42 % (512 MiB)»*, *«uniendo vídeo
  y audio…»*), porque un vídeo largo tarda minutos y el proxy corta las peticiones largas.
- A partir de ahí el canal emite **desde el disco** (`-re -stream_loop -1 -i /…/videos/ID.mp4`): **sin
  caducidad, sin renovar la URL, sin volver a YouTube** y sin gastar CPU en recodificar (se baja H.264 + AAC).
  La tarjeta lo marca con el chip **`⛁ DESDE EL DISCO`** y la línea *«repetido en bucle (descargado)»*.
- La guardia de renovación **no molesta** a un vídeo descargado: sólo se vuelve a mirar si alguien borra el
  archivo. `DELETE /api/youtube/videos/:id` lo quita; el panel vuelve a ofrecer la descarga.
- Si la descarga falla, el error dice la causa real (código de yt-dlp + últimas líneas) y **no deja archivos a
  medias**.

Los vídeos descargados viven en `.runtime/videos`, que **se conserva** al actualizar (`tvlister-admin update`
excluye `.runtime`).

## Lo que cuesta

Disco, y sólo eso: un vídeo de una hora en 1080p ocupa ~1–3 GB. Se descarga una vez y no se vuelve a bajar.

## API

- `POST /api/youtube/download` `{url}` → `202` con el trabajo en marcha.
- `GET /api/youtube/download-status` → `{ running, step, video_id, result }`.
- `DELETE /api/youtube/videos/:videoId` → borra el archivo y su ficha.
- `POST /api/youtube/probe` → `needs_download`, `can_download`, `local`, `bytes`.
- `GET /api/channels247` → `liveSource.local`, `liveSource.local_path`, `liveSource.bytes`.

## Pruebas

- `test_youtube_live.mjs`: **168 OK**. Nuevas: el enlace del navegador (`watch?v=…&list=…`) se resuelve como
  lista; un vídeo con sólo pistas DASH/HLS se explica y ofrece descarga; la descarga en segundo plano deja el
  archivo **y su ficha**, no deja temporales, el mismo enlace pasa a resolverse **desde el disco sin llamar a
  yt-dlp**, el canal queda `ready` con `local: true`, borrar el archivo devuelve la oferta de descarga y una
  descarga fallida (403) lo dice sin dejar nada a medias.
- `test_youtube_live_ui.mjs`: **102 OK**, con el aviso de vídeo+lista, el botón «Sólo ese vídeo», el botón de
  descarga, su progreso, el mensaje final y el chip `⛁ DESDE EL DISCO`.

## Actualizar

```bash
sudo tvlister-admin update
```
