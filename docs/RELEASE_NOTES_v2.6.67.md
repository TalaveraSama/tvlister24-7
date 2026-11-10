# TVLister v2.6.67 — leer YouTube sin depender sólo de yt-dlp

Sobre v2.6.66. El operador preguntó:

> «no hay otro método leer playlist de youtube y live»

Sí los hay, y ahora el panel los usa **solo cuando hacen falta**. yt-dlp sigue siendo la primera opción (es la
única que da la URL del medio con todas las calidades), pero deja de ser la única puerta:

1. **YouTube Data API v3** (la oficial, con clave): lee la lista completa —títulos, duraciones y cuáles son
   directos— sin anti-robots y sin cookies.
2. **La página pública de YouTube** (la misma petición que hace el navegador): lee la lista y, capítulo a
   capítulo, el manifiesto HLS del directo o las pistas del vídeo.

No se ha inventado nada: son las dos vías que documenta Google, y las dos van con `User-Agent` de navegador. Si
hay cookies de YouTube guardadas, se mandan; si no, se pide como visitante.

## 1. Qué cambia para el operador

- Un canal cuya lista YouTube bloqueaba a yt-dlp **ya no se queda sin señal**: al fallar yt-dlp, el panel pide
  la misma lista a la página pública y emite con lo que saque. La tarjeta lo dice: **↯ LEÍDA POR LA WEB**.
- Si hay clave de la Data API, la lista se lee por ahí (más estable y sin sorpresas) y el chip es
  **↯ LEÍDA POR LA API**.
- Sin yt-dlp instalado tampoco hay callejón: se intenta la vía web antes de pedir instalar nada.
- El resto no cambia: el canal emite **en directo, capítulo a capítulo y en bucle, sin ocupar disco** (v2.6.66),
  y la copia en el disco sigue siendo el último recurso.

## 2. La clave de la Data API, en el panel

En **Canales 24/7 → YouTube → Usar cookies** hay ahora un bloque nuevo: **«Leer las listas por la Data API
(opcional)»**, con el campo para pegar la clave, guardarla y quitarla. La clave **no se devuelve al navegador**:
la pantalla sólo enseña los últimos 4 caracteres para reconocerla.

Cómo se consigue (gratis):

1. Google Cloud → **APIs y servicios** → habilitar **YouTube Data API v3**.
2. **Credenciales** → **Crear credenciales** → **Clave de API** (no hace falta OAuth ni pantalla de permiso).
3. Pegarla en el panel. Cuota gratuita: **10.000 unidades/día**; leer una lista de 843 vídeos gasta ~35.

También se puede poner por entorno: `TVLISTER_YT_API_KEY=…` (mandan los ajustes del panel).

## 3. Cómo se lee ahora (por dentro)

- `server/youtubeWeb.js` (nuevo):
  - `cookieHeaderFromFile` / `cookieHeaderFromText`: saca la cabecera `Cookie:` del `cookies.txt`, **sólo** de
    `.youtube.com`/`.google.com`, salta las caducadas y deduplica.
  - `jsonAt` + `parseInitialData` / `parsePlayerResponse`: saca `ytInitialData` y `ytInitialPlayerResponse`
    contando llaves (los títulos de YouTube llevan `}` dentro), sin `eval` ni expresiones regulares frágiles.
  - `parsePlaylistData`: capítulos con id, título, duración y marca de directo (`thumbnailOverlayTimeStatus`
    `LIVE`) + total de la lista.
  - `parsePlayerMedia`: `hlsManifestUrl` (directo) o `formats`/`adaptiveFormats` (vídeo), con códec, tamaño y
    bitrate.
  - `apiPlaylist`: `playlistItems` (50 por página) + `videos` (50 por llamada) + `playlists` (título de la
    lista); cuota mínima.
  - `webPlaylist` / `webPlayer`: las dos páginas públicas.
- `resolveLiveSourceWeb(cls, { cookiesFile, limit, budgetMs })` en `youtubeLive.js`: devuelve **el mismo
  contrato** que la rama de yt-dlp (lista con `entries`, `can_stream`, `needs_transcode`; directo con
  `copy_kind: 'master'`; vídeo con `'progressive'` o `'separate'`) y añade `via` (`'api'` / `'html'`).
- Se llama como **respaldo**, nunca por delante de yt-dlp: (a) si yt-dlp no está instalado, (b) si yt-dlp no
  devuelve ficha, (c) si la lista se leyó pero no dio ni una pista. En esos respaldos va **acotada**: 12
  capítulos y 45 s como mucho, para no colgar la petición del panel.

## 4. Lo que estas vías no hacen

- **No dan la URL del medio en la Data API.** La API sirve para saber *qué* hay en la lista; la señal sigue
  saliendo de yt-dlp o de la página del vídeo.
- **No son un descargador.** No se ha añadido ninguna librería nueva ni se ha tocado la descarga.
- **No evitan el anti-robots por IP** si YouTube bloquea también la página pública: en ese caso se sigue viendo
  el motivo real (v2.6.64/67) y, si hay cookies válidas, se usan.

## API

```
POST /api/youtube/probe     → via: 'api' | 'html' | '' y ytdlp_error
GET  /api/channels247       → liveSource.via
GET  /api/youtube/status    → data_api: { set, source, tail, hint }
PUT  /api/settings          → youtube_api_key
```

## Pruebas

- `test_youtube_live.mjs` **313 OK** (antes 293): sección **1g** con yt-dlp «muerto» —
  - una lista de 3 capítulos leída de la página pública (`via: 'html'`), con el directo dentro omitido, el
    título y el total de la lista, sin escribir nada en `.runtime/videos`;
  - un directo resuelto por la página (`hlsManifestUrl` → `copy_kind: 'master'`);
  - un canal real que **arranca** con esa señal y su tarjeta dice `via: 'html'`;
  - la misma lista con clave, por la Data API (`via: 'api'`), con títulos, duraciones y el título de la lista
    (no el del primer vídeo).
- `test_youtube_live_ui.mjs` **179 OK** (antes 170): el chip **↯ LEÍDA POR LA WEB** en la tarjeta y el bloque
  de la clave en el modal (guardar llama al panel con `youtube_api_key`, la clave no se queda en pantalla).

## Cómo queda en producción

1. `sudo tvlister-admin update`.
2. Opcional: pegar la clave de la Data API en **Canales 24/7 → YouTube → Leer las listas por la Data API**.
3. En el canal que fallaba, **«Renovar señal»**: la tarjeta pasa a **↯ LEÍDA POR LA WEB** (o **API**) y el canal
   emite sin descargar nada.
