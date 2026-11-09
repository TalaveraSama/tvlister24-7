# TVLister v2.6.53 — YouTube: vídeo suelto en bucle y listas completas como canal 24/7

Sobre v2.6.52. Hasta ahora la fuente de YouTube de un canal 24/7 sólo aceptaba **directos**: si pegabas un vídeo
normal, el panel lo rechazaba con «no está en directo». Ya no: el mismo campo acepta **directo, vídeo suelto o lista
completa** y el panel elige solo cómo emitirlo.

## Qué se pega y qué hace

| Enlace | Modo | Qué hace el panel |
| --- | --- | --- |
| `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…` | **VÍDEO EN BUCLE** | `-re -stream_loop -1`: el mismo vídeo, sin fin |
| `youtube.com/playlist?list=…` | **LISTA · N** | Sus vídeos en orden y, al terminar el último, vuelve al primero |
| `…/live/…`, `/@canal/live`, `/channel/UC…/live` | **YOUTUBE EN VIVO** | El directo tal cual (`-c copy`), como en la v2.6.48 |
| `watch?v=…&list=…` | **VÍDEO EN BUCLE** | El vídeo que has pegado (la lista sólo si pegas el enlace de la lista) |

## Cómo se emite

- **yt-dlp** devuelve el archivo **progresivo** (MP4/WebM con audio y vídeo juntos, ≤1080p) que FFmpeg puede leer en
  bucle sin descargar el vídeo entero.
- De una lista se toman **hasta 30 vídeos** (`--playlist-end 30 --ignore-errors`). Se **omiten los directos** que haya
  dentro (una URL en vivo no tiene principio ni fin para encadenarla) y los vídeos sin MP4 utilizable; la vista previa
  dice cuántos se han omitido.
- La lista se escribe como manifiesto **`ffconcat`** (`source.txt`) y se lee con
  `-f concat -safe 0 -stream_loop -1`: vuelta a empezar sin cortes. Se reescribe en cada arranque porque las URLs van
  firmadas.
- **Sin recodificar** (`-c:v copy`, 0 % de CPU) cuando todo es H.264 + AAC y mide lo mismo. Se recodifica a
  **H.264 2500k · AAC 128k · 30 fps · techo 1080p** sólo si hace falta: VP9/AV1/HEVC, más de 1080p, audio que no sea
  AAC/MP3, o una lista con resoluciones/códecs mezclados (si no, el cliente se queda sin imagen a mitad de la lista).
- La **guardia** renueva la URL antes de que caduque (en una lista, la caducidad más próxima) y reinicia el motor
  sólo si cambia la **huella** de lo que se emite (`modo|URL` o `playlist|nº|primera URL`).
- Un **directo terminado no se pone en bucle por sorpresa**: se informa («ese directo ya terminó») y el canal queda
  **SIN SEÑAL** hasta que pongas otro enlace, un vídeo o una lista.
- En modo **virtual** (sin motor) se puede entregar un directo o un vídeo suelto con 302; **una lista no** (responde
  503 explicando que active el motor FFmpeg, que es el que la une en un solo HLS).

## En la pantalla

- El badge de cada canal dice **`● YOUTUBE EN VIVO`**, **`▶ VÍDEO EN BUCLE`** o **`LISTA · N`** (antes sólo había
  «en vivo» / «sin señal»).
- La caja de la señal muestra la duración del vídeo («Bucle · 62m») o los minutos totales de la lista con sus primeros
  programas y «… y N más, en bucle».
- **Comprobar señal** dice si se va a recodificar, cuántos vídeos trae la lista y cuántos se omiten.
- `POST /api/youtube/probe` devuelve `mode`, `entries`, `total_duration_sec`, `entry_titles`, `needs_transcode`,
  `skipped_live` y `skipped_no_format`.

## Pruebas

- `node scripts/test_youtube_live.mjs` → **78 OK**: directo (como antes), vídeo suelto (`-stream_loop -1`, `-re`,
  `-c:v copy`), VP9 que recodifica a H.264 con techo 1080p, lista de 3 con su `source.txt` `ffconcat` y entrega por
  HLS, lista sin motor que responde 503, renovación de la URL por la guardia y caída/vuelta del directo.
- `node scripts/test_youtube_live_ui.mjs` → **53 OK**: badges de vídeo y lista, duración, títulos de la lista,
  «Renovar señal» en los cuatro canales de YouTube, comprobar una lista y comprobar un vídeo.
- Siguen en verde: `test_uninstall.sh` (49), `test_uninstall_ssh.sh` (40), `test_catv_flussonic_ui`,
  `test_catv_flussonic_control`, `test_catv_udp_pacer`, `test_vod_*` y los de balancer.
- `npm run build` OK.

## Actualizar

```bash
sudo tvlister-admin update
```

Nada que configurar: los canales de YouTube que ya tenías siguen igual (modo `live`), y a partir de ahora puedes
pegar un vídeo o una lista en el mismo sitio.
