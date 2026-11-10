# TVLister v2.6.63 — «no reproduce» con las cookies bien: el anti-robots de YouTube y el cliente que se probaba

Sobre v2.6.62. Las cookies estaban perfectas (sesión válida hasta 2027) y, aun así, el canal se quedaba sin
señal y el diagnóstico decía:

> YouTube no ha entregado ninguna pista de vídeo para este enlace. Suele ser una restricción del propio vídeo o
> una versión vieja de yt-dlp.
> `ERROR: [youtube] ioSKlIL4Hs8: Sign in to confirm you're not a bot.`

Ese texto tenía dos problemas, y los dos están arreglados.

## 1. El panel se rendía con el primer cliente de YouTube

yt-dlp devuelve la ficha del vídeo **aunque no venga ni una pista** (`--ignore-no-formats-error`): sale con
código 0 y `formats: []`. El panel lo interpretaba como «el vídeo no se puede emitir» y **no probaba los demás
clientes**. Pero el anti-robots no es igual para todos: lo que el cliente por defecto (el `visionos` de
yt-dlp 2026.10.26) rechaza, `tv`, `web_safari`, `ios`, `mweb` o `tv_samsung` lo entregan a menudo desde la
misma IP.

- La ficha vacía ya no corta la cadena: se prueba el siguiente cliente (privado, retirado, de pago o futuro
  sí la cortan: eso ningún cliente lo arregla).
- La cadena pasa de **4 a 6 clientes** y lleva un tope de tiempo (90 s por vídeo, 5 min por lista) para que una
  comprobación no se quede colgada.
- El diagnóstico usa la salida del cliente **que dio la ficha** y la de todos los intentos, no sólo la del
  último: antes se perdía el «Sign in to confirm you're not a bot» y salía el cajón de sastre.

## 2. Si la sesión es buena, el culpable es la IP (y se dice así)

Con cookies válidas, el mensaje seguía mandando reexportarlas. Ahora, cuando la sesión tiene fecha y no ha
caducado, la pantalla dice la verdad:

> **Verificación anti-robots de YouTube (no es la lista ni el vídeo)**
> YouTube no entrega este vídeo a la IP pública de este servidor: pide «Sign in to confirm you're not a bot»
> (su control anti-robots). No es que el vídeo esté roto ni que la lista esté vacía. Las cookies son válidas
> hasta el 13/12/2027 y se han enviado a yt-dlp, así que el aviso no es por falta de sesión: YouTube lo aplica
> por IP (lo normal en servidores y centros de datos). Se ha probado con los clientes: normal, tv, web_safari,
> ios, mweb, tv_samsung. Qué hacer, en este orden: pulsa «Actualizar yt-dlp»…; inicia sesión en YouTube desde la
> misma red del servidor y vuelve a exportar las cookies; y si el servidor sale por una IP de centro de datos,
> una IP doméstica o residencial (proxy o VPN sólo para YouTube) lo resuelve. Un vídeo ya descargado en el disco
> no pasa por esto.

- Se marca `blocked_bot` y **no** se piden cookies nuevas cuando ya son buenas (`needs_cookies: false`).
- «Sign in to confirm your **age**» ya no se confunde con el anti-robots: es restricción de edad y sigue su
  propio mensaje.

## 3. El enlace corto `youtu.be/<id>?si=…` se emite desde el disco

Era el enlace de «Compartir» del canal de Los Simpson. Se trataba como **directo**, así que se saltaba el disco
y volvía a preguntar a YouTube en cada comprobación: aunque el vídeo estuviera descargado, el canal no
reproducía. Ahora es un vídeo normal, la URL se normaliza (`watch?v=<id>`, sin el `?si=`) y, si el archivo está
en `.runtime/videos/`, se emite desde ahí sin llamar a yt-dlp.

## 4. Descargar también prueba los clientes

«Descargar vídeo» y «Preparar lista en el disco» usaban sólo el cliente por defecto: si ése estaba con el
anti-robots, la descarga fallaba aunque la comprobación de la señal hubiera pasado con `tv`. Ahora la descarga
recorre la misma cadena, se queda con el cliente que funcione (`client` en la ficha del archivo) y, si falla,
explica el motivo igual que la comprobación.

## 5. «Ver qué formatos ve yt-dlp» enseña la tabla de verdad

El botón pedía `yt-dlp -F` con un solo cliente: salía el «Sign in to confirm…» y parecía que el panel no veía
nada. Ahora recorre la cadena, enseña la primera tabla con formatos y escribe **con qué cliente** la ha visto.
Lo mismo vale para «Probar cookies»: si el anti-robots bloquea el vídeo de prueba, lo dice en vez de culpar al
archivo de cookies.

## API

```
POST /api/youtube/probe              → { blocked_bot, clients_tried, needs_cookies, needs_format_fix, … }
POST /api/youtube/formats            → { ok, text, client, bot_check, clients_tried }
POST /api/youtube/cookies/test       → { ok, client, bot_check, … }
POST /api/youtube/download           → 202; el resultado lleva { clients_tried, blocked_bot, client }
GET  /api/channels247                → liveSource.blocked_bot (queda guardado con la señal)
```

## Pruebas

- `test_youtube_live.mjs` **227 OK** (antes 207): cliente por defecto bloqueado y `tv` que sí pasa, los seis
  clientes agotados, anti-robots con cookies válidas (no pide cookies), `-F` con cliente, descarga con
  reintento de cliente, `youtu.be/…?si=` desde el disco.
- `test_youtube_live_ui.mjs` **143 OK** (antes 134): aviso «Verificación anti-robots», IP, fecha de la sesión,
  clientes probados y cliente en la tabla de formatos.
- `test_vod_paging`, `test_catv_flussonic_ui`, `test_catv_flussonic_control`, `test_balancer_api`,
  `test_uninstall.sh` (49) y `test_uninstall_ssh.sh` (40): TODO OK. `npm run build`: OK.

## Si sigue bloqueado

El panel ya no puede hacer más contra la IP: si los seis clientes reciben el anti-robots, es YouTube contra la
IP del servidor. Las salidas reales son (1) actualizar yt-dlp cuando salga una versión nueva, (2) exportar las
cookies desde una sesión abierta en la misma red del servidor y (3) sacar sólo YouTube por una IP doméstica o
residencial. Un vídeo ya descargado en el disco no pasa por ninguno de estos controles.
