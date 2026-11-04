# TVLister v2.6.48 — Canales 24/7 alimentados por un directo de YouTube

Sobre v2.6.47. Un **Canal 24/7** ya no tiene que ser una parrilla de películas: puede tomar un **directo de
YouTube** (o cualquier HLS público) y emitirlo como canal lineal continuo, entregado por las líneas de siempre
(`/live/<usuario>/<clave>/<10000+id>.m3u8`).

## Qué se puede hacer ahora

En **Canales 24/7 → Crear Canal 24/7** el formulario pregunta **«¿De dónde sale la señal de este canal?»**:

- **Parrilla 24/7** — lo de siempre: películas del catálogo o enlaces MP4/HLS en bucle.
- **Señal en vivo de YouTube** — pegas el enlace del directo (`youtube.com/watch?v=…`,
  `youtube.com/@canal/live`, `youtu.be/…`, `youtube.com/live/…`), pulsas **Comprobar señal** y el panel
  confirma si está en directo, con qué título y cuándo habrá que renovar la URL.

En la tarjeta del canal aparece **`● YOUTUBE EN VIVO`** (o **`SIN SEÑAL`**), el título del directo, los minutos
que le quedan al enlace y el botón **Renovar señal**.

## Cómo emite (sin gastar CPU)

1. El panel lee el directo con **yt-dlp** y se queda con el **manifiesto HLS** que ya trae audio y vídeo juntos.
2. Un motor **FFmpeg `-c copy`** (copiar, sin recodificar) lo publica como HLS de 4 s / 6 segmentos en el
   RAMDisk, igual que los demás canales 24/7.
3. Las líneas ven el canal en `/live/<usuario>/<clave>/<10000+id>.m3u8` (y en la lista M3U / Xtream).

La URL firmada de YouTube caduca (~6 h). El panel la **renueva solo 10 minutos antes** de que expire
(`startLiveSourceWatchdog`, cada 60 s) y reinicia el motor con la URL nueva, así que el canal **no se corta**.
Si el directo termina, el canal se apaga y queda como **SIN SEÑAL** sin perder su configuración; cuando el
directo vuelve, el panel lo reengancha solo (reintento cada 5 minutos).

**Sin motor (modo «virtual»)**: el panel responde con un 302 al manifiesto del directo, útil para un VPS de
poco tráfico. En MPEG-TS (`.ts`) avisa que ese canal se entrega por HLS.

## yt-dlp: sin apt, con un clic

- **`POST /api/youtube/status`** dice si está instalado, su versión y si hay FFmpeg.
- Botón **«Instalar yt-dlp»** en la propia pantalla: descarga el binario oficial a
  `/opt/tvlister24-7/.runtime/bin/yt-dlp` y lo deja ejecutable. Nada de `apt`, nada de Python del sistema.
- Si el servidor ya lo tiene en el `PATH`, se usa ese.

## Si YouTube pide «confirma que no eres un robot»

En la misma tarjeta hay un apartado plegable para indicar un **archivo de cookies** (formato Netscape,
exportado con «Get cookies.txt»). Se guarda en `settings` como `youtube_cookies_file` y yt-dlp lo usa al leer
el directo. Es opcional: sin cookies el panel también funciona si YouTube no bloquea la IP del servidor.

## Detalles

- `channels_247` gana tres columnas: `source_kind` (`playlist` | `youtube`), `live_source_url` y
  `live_source_state` (JSON con URL resuelta, caducidad, título, cabeceras y último error). Las instalaciones
  existentes se actualizan solas al arrancar.
- El EPG del canal se genera con el título del directo en bloques de 2 h.
- Los canales de parrilla no cambian en nada: mismo motor, misma entrega, mismos nombres.
- La salida UDP/CATV, Flussonic y el resto del panel no se tocan.

## Pruebas

- `node scripts/test_youtube_live.mjs` — **39 OK**: monta el panel real con un yt-dlp de mentira, un HLS de
  origen y un FFmpeg de mentira; comprueba alta del canal, entrega HLS, segmentos servidos por el panel,
  renovación automática antes de caducar, «sin directo», reenganche solo y borrado sin motor huérfano.
- `node scripts/test_youtube_live_ui.mjs` — **35 OK**: renderiza la pantalla real (jsdom) y comprueba los
  avisos, «Comprobar señal», el alta con `source_kind='youtube'`, el bloqueo sin enlace y las cookies.
- Sin cambios en las pruebas de CATV/Flussonic (96 · 60 · 25 · 28) ni en el resto.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.48/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.48

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

Después: **Canales 24/7 → Crear Canal 24/7 → Señal en vivo de YouTube**, pega el enlace del directo y pulsa
**Comprobar señal**. Si falta yt-dlp, el propio aviso trae el botón **Instalar yt-dlp**.
