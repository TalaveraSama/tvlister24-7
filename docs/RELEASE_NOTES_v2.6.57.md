# TVLister v2.6.57 — YouTube deja de contestar «no eres un robot»

Sobre v2.6.56. Respuesta al error que salía al pegar un enlace:

```
ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm you're not a bot.
This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.
```

## Por qué pasa (y por qué no es culpa del panel)

Ese mensaje **no** significa que el vídeo esté roto ni que falte yt-dlp: YouTube ha marcado la **IP del
servidor**. Lo hace con casi todos los VPS (datacenter, VPN, mucho tráfico) y con muchas IP domésticas de
LATAM. No entrega ni un solo formato a un visitante anónimo desde esa IP, dé igual el vídeo que sea. La
salida oficial —la que recomienda yt-dlp— es decirle **qué cuenta está mirando**: un archivo de cookies de
un navegador con la sesión de YouTube iniciada. Nada de proxies ni trucos raros.

Antes, el panel se limitaba a repetir el inglés y a esconder un apartado con una caja de texto para
escribir una ruta a mano. Eso no lo resuelve nadie a la primera.

## Qué hace ahora el panel

1. **Lo explica en castellano.** Cuando yt-dlp devuelve ese error, la caja de la señal dice:
   *«YouTube pide iniciar sesión desde este servidor («Sign in to confirm you’re not a bot»). Sube un archivo
   de cookies de youtube.com…»*, con el texto original de yt-dlp plegado en **detalle técnico** (para
   soporte, no para el operador).
2. **Botón «Subir cookies»**, ahí mismo, sin buscar nada. También está en el bloque *¿YouTube dice «Sign in
   to confirm you’re not a bot»? Usa cookies*, que se abre solo cuando pasa.
3. **Se sube el `.txt` y ya está.** El panel lo **valida antes de guardarlo**:
   - tiene que ser **Netscape** de verdad (columnas separadas por tabuladores; se aceptan las líneas
     `#HttpOnly_…` que exporta Chrome);
   - tiene que traer cookies de **`youtube.com`** (si sólo hay de `google.com`, lo dice);
   - avisa si **no hay sesión**: sin `SID` / `__Secure-3PSID` YouTube seguirá pidiendo login.
   Si subes el JSON de otra extensión, lo rechaza explicando cuál es el formato bueno.
4. **Se guarda en el servidor con permisos 600** en `.runtime/youtube-cookies.txt` (no en `data/`: sobrevive
   a `tvlister-admin update`, que excluye `.runtime`). Nada de rutas raras ni de `chown` a mano.
5. **Se usa sola.** A partir de ahí, cada lectura y **cada renovación** del enlace llama a yt-dlp con
   `--cookies`, así que el canal sigue al aire sin volver a tocar nada. Al subirlas, el panel **repite la
   comprobación del enlace automáticamente**.
6. **Se pueden quitar** con un botón (`Quitar`), y la ruta manual sigue disponible para quien ya tenga el
   archivo en el servidor: al guardar la ruta, el panel comprueba el archivo y avisa en el acto si no
   existe o no sirve.

El estado de yt-dlp muestra ahora el archivo: *«activas (48 de youtube.com, con sesión)»*, y el resultado de
comprobar el enlace añade **«· con cookies de YouTube»** cuando se están usando.

## Lo que tienes que hacer tú (2 minutos)

1. En tu PC, abre `youtube.com` **con la sesión iniciada** (con la cuenta que verá los directos).
2. Instala la extensión **«Get cookies.txt LOCALLY»** y pulsa **Export** en esa pestaña.
3. En el panel: **Canales 24/7 → Señal de YouTube → Subir cookies (.txt)** y elige el archivo.

Las cookies caducan (días, a veces semanas). Si el aviso vuelve, exporta otra vez: es un minuto.

## API

- `POST /api/youtube/cookies` (texto plano, máx. 4 MB) → valida, guarda `0600` y fija el ajuste
  `youtube_cookies_file`. `400` con el motivo si el archivo no sirve.
- `DELETE /api/youtube/cookies` → borra el ajuste (el archivo se queda; se puede volver a indicar).
- `GET /api/youtube/status` → `cookies: { path, exists, ok, usable, auth, count, youtube, error, warn }`.
- `POST /api/youtube/probe` → `needs_cookies`, `using_cookies` y `detail` (texto de yt-dlp).
- `PUT /api/settings` con `youtube_cookies_file` → comprueba el archivo y devuelve `warnings` si no sirve.

## Pruebas

- `test_youtube_live.mjs`: **134 OK**. Nuevas: el validador (bueno, sin `youtube.com`, sin sesión, JSON,
  vacío, `#HttpOnly_`), el error anti-robots reconocido y explicado, el probe contra un panel real con un
  yt-dlp que **sólo** responde si recibe `--cookies` (y se comprueba que el argumento llega con la ruta
  guardada), subida por HTTP con permisos **600** y borrado.
- `test_youtube_live_ui.mjs`: **72 OK**, con la subida del archivo desde la pantalla, el aviso en castellano,
  el reintento automático del enlace y el botón de quitar.

## Actualizar

```bash
sudo tvlister-admin update
```
