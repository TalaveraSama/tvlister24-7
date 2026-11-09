# TVLister v2.6.60 — cuando YouTube no da nada, se dice POR QUÉ (y se comprueba)

Sobre v2.6.59. Respuesta al aviso que salía con `youtu.be/ioSKlIL4Hs8?si=…` **teniendo ya cookies subidas**:

> Ese vídeo no ofrece ningún formato que se pueda emitir (es privado, tiene restricción de edad o de país, o
> YouTube no lo entrega sin iniciar sesión).

Ese texto era un cajón de sastre: no miraba lo que había contestado yt-dlp y dejaba al operador sin saber si el
problema eran **sus** cookies. Ahora se mira y se dice.

## Qué cambia

### 1. El motivo real, sacado de lo que responde YouTube

Cuando yt-dlp devuelve la ficha **sin ninguna pista**, el panel lee su `stderr` y los campos del vídeo
(`availability`, `age_limit`) y explica el motivo concreto:

| Lo que pasa | Lo que se lee ahora |
| --- | --- |
| Vídeo privado | «YouTube no entrega este vídeo porque **es privado**.» |
| Restricción de edad | «…porque **tiene restricción de edad** (YouTube exige una cuenta con la edad confirmada).» |
| Bloqueado por país | «…porque **está bloqueado en el país de este servidor**.» |
| Sólo miembros / de pago | «…porque **es sólo para miembros del canal**» / «sólo para suscriptores de pago». |
| Retirado / no existe | «…porque **ya no existe o YouTube lo ha retirado**.» |
| Pistas sin URL (PO token) | «YouTube ha dado N pistas pero **ninguna con URL utilizable**» + botón de actualizar. |

Y si el motivo es de **sesión**, se dice exactamente en qué punto estás:

- sin cookies → «Sube cookies de una cuenta con acceso»;
- cookies **caducadas** → «vuelve a exportarlas»;
- cookies sin sesión (falta `SID`) → «expórtalas con la cuenta ya iniciada»;
- cookies buenas pero **sin acceso** a ese vídeo → «esa cuenta no tiene acceso (o la sesión ya no vale)» — ya
  no se le pide subir otra vez lo que ya tiene.

Los motivos viajan aparte (`reasons`) y la pantalla los enseña como **«Motivo: …»** bajo el error.

### 2. Las cookies caducadas se detectan

Una sesión caducada sigue teniendo `SID` en el archivo, así que «archivo encontrado» no significaba nada. Ahora
se mira la **fecha de caducidad** de las cookies de sesión: si ya pasó, el bloque dice **«SIN sesión (…,
caducadas)»** y explica que hay que volver a exportarlas.

### 3. Si las cookies estorban, se reintenta sin ellas

Con una sesión de otra red/país YouTube puede devolver **cero** pistas. Ahora, si con cookies no hay nada que
emitir, el panel **repite la lectura sin cookies** y se queda con lo que funcione. El resultado dice cómo se
resolvió: `con cookies`, `con cookies y sin ellas`.

### 4. Dos botones para no adivinar

- **«Probar cookies»**: las pasa a yt-dlp contra un vídeo público de YouTube (`BaW_jenozKc`) y responde
  *«Las cookies funcionan: yt-dlp ha leído “youtube-dl test video” con esa sesión»* o el motivo real del fallo.
  Es la prueba de verdad, no un «el archivo existe».
- **«Ver qué formatos ve yt-dlp»**: ejecuta `yt-dlp -F` con el enlace pegado y enseña la tabla tal cual (ID, EXT,
  resolución, códec…). Si YouTube bloquea, aquí se lee el mensaje original.

## API

- `POST /api/youtube/formats` `{url}` → `{ ok, text, error, using_cookies }` (salida de `yt-dlp -F`).
- `POST /api/youtube/cookies/test` → `{ ok, message | error, title, formats }`.
- `POST /api/youtube/probe` → además de antes: `reasons[]`, `cookies_note`.
- `GET /api/youtube/status` → `cookies.auth_expires_ms`, `cookies.expired_auth`.

## Pruebas

- `test_youtube_live.mjs`: **189 OK**. Nuevas: cookies vigentes / caducadas / de sesión (sin fecha), vídeo
  privado, restricción de edad **con cookies puestas** (y el mensaje correcto), bloqueo por país, contenido de
  miembros, **reintento sin cookies** cuando éstas estorban, la tabla de `yt-dlp -F` y la prueba real de cookies.
- `test_youtube_live_ui.mjs`: **119 OK**, con «Motivo: …», «Probar cookies» (buena y caducada) y «Ver qué
  formatos ve yt-dlp».

## Actualizar

```bash
sudo tvlister-admin update
```
